/**
 * The server's own WebSocket (RFC 6455) on an upgrade request of node:http (S2 8.2.1): text and
 * binary messages, fragmentation, ping and pong, the closing handshake and its codes. No extension
 * and no subprotocol is ever negotiated. A message over MAX_MESSAGE closes with 1009, invalid
 * UTF-8 in a text message with 1007, any other breach of the protocol (an unmasked client frame
 * among them) with 1002.
 *
 * Once a connection closes, whichever side began it, a peer that has not closed its side
 * CLOSE_WAIT_MS later has its socket destroyed, so that a peer which neither reads nor closes
 * cannot hold a connection for ever (ruled, #44).
 *
 * Not here: the `Host` and `Origin` checks and the handshake of S2 8.2.2, which the caller does
 * (task 17).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { Clock } from '../platform/types.ts';

export interface WebSocketConnection {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Bytes written to the socket and not yet flushed (for S2 8.2.8). */
  readonly buffered: number;
  /** Sends a close frame and ends the socket; the socket is destroyed if the peer has not closed
   *  its side CLOSE_WAIT_MS later. RangeError for a code a server may not send (outside
   *  1000–1014 and 3000–4999, or 1004, 1005, 1006) or a reason above 123 UTF-8 bytes; nothing is
   *  sent then. */
  close(code: number, reason?: string): void;
  /** Destroys the socket at once, with no close frame; onClose gets 1006 unless it had a code. */
  destroy(): void;
  // Each onX adds a listener; earlier ones stay. When a listener that a read calls throws (onText,
  // onBinary, or onClose for a close the read caused), the socket is destroyed (onClose gets 1006
  // unless it had a code) and the error is thrown on. onDrain, and onClose called from close(),
  // destroy() or the socket's end or close, are outside this rule.
  onText(listener: (text: string) => void): void;
  onBinary(listener: (bytes: Uint8Array) => void): void;
  onDrain(listener: () => void): void;
  onClose(listener: (code: number) => void): void;
}

export const MAX_MESSAGE = 1024 * 1024;
/** How long a closing connection waits for the peer to close its side before destroying it. */
export const CLOSE_WAIT_MS = 5_000;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** The base64 of 16 bytes (RFC 6455 4.1). */
const KEY = /^[A-Za-z0-9+/]{22}==$/;
const CONTINUATION = 0x0;
const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;
const MAX_CONTROL = 125;
/** Close frame payload: a 2-byte code and at most this many bytes of reason. */
const MAX_REASON = MAX_CONTROL - 2;
const NO_STATUS = 1005;
const ABNORMAL = 1006;
const PROTOCOL_ERROR = 1002;
const INVALID_DATA = 1007;
const TOO_BIG = 1009;
const LONGEST_HEADER = 14;

/**
 * Headers of S2 8.2.1 that need no port, for the two answers given here. The policy is stricter
 * than the page's (no source at all): neither answer has a body.
 */
const FIXED_HEADERS =
  'X-Content-Type-Options: nosniff\r\n' +
  'X-Frame-Options: DENY\r\n' +
  'Referrer-Policy: no-referrer\r\n' +
  "Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n";

/** Answers 101 and returns the connection, or answers 400 and returns null for a request that is
 *  not a valid version-13 upgrade. The caller has checked Host and Origin before (task 17).
 *  `clock` times CLOSE_WAIT_MS (the platform's clock). */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  clock: Clock,
): WebSocketConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (!isUpgrade(req) || typeof key !== 'string' || !KEY.test(key)) {
    refuse(socket);
    return null;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  return new Connection(socket, head, accept, clock);
}

/** A GET over HTTP/1.1 or later asking for `Upgrade: websocket`, version 13 (RFC 6455 4.2.1). */
function isUpgrade(req: IncomingMessage): boolean {
  const { headers } = req;
  return (
    req.method === 'GET' &&
    (req.httpVersionMajor > 1 || (req.httpVersionMajor === 1 && req.httpVersionMinor >= 1)) &&
    headers.upgrade?.trim().toLowerCase() === 'websocket' &&
    tokens(headers.connection).includes('upgrade') &&
    headers['sec-websocket-version']?.trim() === '13'
  );
}

function tokens(value: string | undefined): string[] {
  return (value ?? '').split(',').map((token) => token.trim().toLowerCase());
}

function refuse(socket: Duplex): void {
  socket.on('error', () => {});
  socket.end(
    'HTTP/1.1 400 Bad Request\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      FIXED_HEADERS +
      '\r\n',
    () => {
      socket.destroy();
    },
  );
}

/** A code a close frame may carry (RFC 6455 7.4): neither one reserved for reporting nor unassigned. */
function isCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== NO_STATUS && code !== ABNORMAL) ||
      (code >= 3000 && code <= 4999))
  );
}

/** Thrown inside the frame reader to close the connection with `code`. */
class Breach {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

/** The fatal decoder throws for invalid UTF-8; ignoreBOM keeps a leading U+FEFF in the text. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Breach(INVALID_DATA);
  }
}

/**
 * Payload bytes gathered in one buffer that grows by doubling, up to the size it will need: what a
 * peer makes the server keep grows with what it sent, whatever the size of its reads, and an empty
 * fragment costs nothing.
 */
class Bytes {
  #buffer = new Uint8Array(0);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  /**
   * Appends `source[from, to)` unmasked: XOR with `mask`, `at` being the place of `source[from]` in
   * its frame's payload. `limit` is the most this will ever hold (the buffer never grows past it).
   */
  appendUnmasked(
    source: Uint8Array,
    from: number,
    to: number,
    mask: Uint8Array,
    at: number,
    limit: number,
  ): void {
    const start = this.#length;
    const length = start + to - from;
    if (length > this.#buffer.length) {
      const grown = new Uint8Array(Math.max(length, Math.min(2 * this.#buffer.length, limit)));
      grown.set(this.#buffer.subarray(0, start));
      this.#buffer = grown;
    }
    const buffer = this.#buffer;
    for (let i = from; i < to; i++) {
      buffer[start + i - from] = (source[i] as number) ^ (mask[(at + i - from) & 3] as number);
    }
    this.#length = length;
  }

  /** The bytes, in an array of exactly their length and of their own; this is empty after. */
  take(): Uint8Array {
    const { length } = this;
    const bytes = this.#buffer.length === length ? this.#buffer : this.#buffer.slice(0, length);
    this.#buffer = new Uint8Array(0);
    this.#length = 0;
    return bytes;
  }
}

const OPCODES: ReadonlySet<number> = new Set([CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG]);

/** The size of a frame's header, its 4 mask bytes included, as the header's second byte gives it. */
function headerSize(b1: number): number {
  const length = b1 & 0x7f;
  return (length === 127 ? 10 : length === 126 ? 4 : 2) + 4;
}

/** The first two bytes of a frame, which are enough to refuse every breach but its length. */
function checkStart(b0: number, b1: number): void {
  if ((b0 & 0x70) !== 0) throw new Breach(PROTOCOL_ERROR); // no extension gives the bits a meaning
  if ((b1 & 0x80) === 0) throw new Breach(PROTOCOL_ERROR); // a client masks every frame
  const opcode = b0 & 0x0f;
  if (!OPCODES.has(opcode)) throw new Breach(PROTOCOL_ERROR);
  // A control frame is never fragmented and its length takes the 7-bit form (RFC 6455 5.5, 5.2).
  if (opcode >= CLOSE && ((b0 & 0x80) === 0 || (b1 & 0x7f) > MAX_CONTROL)) {
    throw new Breach(PROTOCOL_ERROR);
  }
}

/** The payload length a complete header announces. */
function payloadLength(head: DataView): number {
  const length = head.getUint8(1) & 0x7f;
  if (length < 126) return length;
  if (length === 126) return head.getUint16(2);
  const high = head.getUint32(2);
  if (high >= 0x8000_0000) throw new Breach(PROTOCOL_ERROR); // RFC 6455 5.2: the top bit is 0
  return high * 2 ** 32 + head.getUint32(6); // inexact above 2^53, far above MAX_MESSAGE then
}

/** A frame the server sends: never masked, never fragmented. */
function encodeFrame(opcode: number, payload: Uint8Array | string): Buffer {
  const length = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
  const size = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(size + length);
  frame[0] = 0x80 | opcode;
  if (size === 2) {
    frame[1] = length;
  } else if (size === 4) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  // A string is written as UTF-8; a lone surrogate becomes U+FFFD, so the text is always valid.
  if (typeof payload === 'string') frame.write(payload, size, 'utf8');
  else frame.set(payload, size);
  return frame;
}

class Connection implements WebSocketConnection {
  readonly #socket: Duplex;
  readonly #clock: Clock;
  /** open: messages flow; closing: a close frame was sent, input is dropped; the code is known. */
  #state: 'open' | 'closing' = 'open';
  #closeCode: number | null = null;
  // The frame being read. Its header is copied into #head, then its payload, unmasked, into
  // #message (a data frame) or #control. A read, a header and a fragment allocate nothing beyond
  // the growth of those buffers; only a whole message or control frame gets an array of its own.
  readonly #head = new Uint8Array(LONGEST_HEADER);
  readonly #headView = new DataView(this.#head.buffer);
  #headLength = 0;
  /** Whether #head holds a whole header, so that the bytes that come are its payload. */
  #inPayload = false;
  #fin = false;
  #opcode = 0;
  #length = 0;
  #read = 0;
  readonly #mask = new Uint8Array(4);
  /** TEXT or BINARY from a message's first frame until its last; null between messages. */
  #messageOpcode: number | null = null;
  readonly #message = new Bytes();
  readonly #control = new Bytes();
  /** The latest ping's payload while the socket is backed up; its pong goes out at the drain. */
  #pendingPong: Uint8Array | null = null;
  /** Cancels the destruction CLOSE_WAIT_MS after the close began; null when none waits. */
  #closeTimer: (() => void) | null = null;
  readonly #textListeners: ((text: string) => void)[] = [];
  readonly #binaryListeners: ((bytes: Uint8Array) => void)[] = [];
  readonly #drainListeners: (() => void)[] = [];
  readonly #closeListeners: ((code: number) => void)[] = [];

  constructor(socket: Duplex, head: Buffer, accept: string, clock: Clock) {
    this.#socket = socket;
    this.#clock = clock;
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      this.#stopWaiting();
      this.#gone();
    });
    if (socket.destroyed) {
      this.#gone();
      return;
    }
    socket.on('end', () => {
      // The peer will send nothing more. Its socket is half-open (node:http's allowHalfOpen):
      // ending ours as well lets it close. The socket first: a listener that onClose calls may throw.
      socket.end();
      this.#waitForPeer();
      this.#gone();
    });
    socket.on('drain', () => {
      if (this.#state !== 'open') return;
      if (this.#pendingPong !== null) {
        socket.write(encodeFrame(PONG, this.#pendingPong));
        this.#pendingPong = null;
      }
      for (const listener of this.#drainListeners) listener();
    });
    (socket as Partial<Socket>).setNoDelay?.(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        FIXED_HEADERS +
        '\r\n',
    );
    // Bytes that came with the request are read first; the 'data' listener starts the flow on a
    // later tick, after the caller has registered its listeners.
    if (head.length > 0) socket.unshift(head);
    socket.on('data', (chunk: Buffer) => {
      this.#receive(chunk);
    });
  }

  get buffered(): number {
    return this.#socket.writableLength;
  }

  sendText(text: string): void {
    this.#send(TEXT, text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.#send(BINARY, bytes);
  }

  close(code: number, reason = ''): void {
    if (!isCloseCode(code)) throw new RangeError(`${code} is not a close code a server may send`);
    const reasonBytes = Buffer.from(reason, 'utf8');
    if (reasonBytes.length > MAX_REASON) {
      throw new RangeError(`a close reason has at most ${MAX_REASON} bytes`);
    }
    this.#closeWith(code, reasonBytes);
  }

  destroy(): void {
    // The socket first: a listener that onClose calls may throw.
    this.#stopWaiting();
    this.#socket.destroy();
    this.#gone();
  }

  onText(listener: (text: string) => void): void {
    this.#textListeners.push(listener);
  }

  onBinary(listener: (bytes: Uint8Array) => void): void {
    this.#binaryListeners.push(listener);
  }

  onDrain(listener: () => void): void {
    this.#drainListeners.push(listener);
  }

  onClose(listener: (code: number) => void): void {
    const code = this.#closeCode;
    if (code === null) this.#closeListeners.push(listener);
    else queueMicrotask(() => listener(code));
  }

  #send(opcode: number, payload: Uint8Array | string): void {
    if (this.#state !== 'open' || this.#socket.destroyed) return;
    this.#socket.write(encodeFrame(opcode, payload));
  }

  /** Sends a close frame (`code` null: one without a code), ends the socket, reports the code. */
  #closeWith(code: number | null, reason: Uint8Array = new Uint8Array(0)): void {
    if (this.#state !== 'open') return;
    this.#stopReading();
    if (!this.#socket.destroyed) {
      let payload = new Uint8Array(0);
      if (code !== null) {
        payload = new Uint8Array(2 + reason.length);
        new DataView(payload.buffer).setUint16(0, code);
        payload.set(reason, 2);
      }
      this.#socket.write(encodeFrame(CLOSE, payload));
      this.#socket.end();
      this.#waitForPeer();
    }
    this.#report(code ?? NO_STATUS);
  }

  /** Destroys the socket if the peer has not closed its side CLOSE_WAIT_MS from now. */
  #waitForPeer(): void {
    if (this.#closeTimer !== null || this.#socket.destroyed) return;
    this.#closeTimer = this.#clock.after(CLOSE_WAIT_MS, () => {
      this.#closeTimer = null;
      this.#socket.destroy();
    });
  }

  #stopWaiting(): void {
    this.#closeTimer?.();
    this.#closeTimer = null;
  }

  /** The socket ended or closed without a closing handshake, or after it. */
  #gone(): void {
    this.#stopReading();
    this.#report(ABNORMAL);
  }

  /** From now on what comes is dropped; what was gathered is let go. */
  #stopReading(): void {
    this.#state = 'closing';
    this.#inPayload = false;
    this.#headLength = 0;
    this.#messageOpcode = null;
    this.#message.take();
    this.#control.take();
    this.#pendingPong = null;
  }

  #report(code: number): void {
    if (this.#closeCode !== null) return;
    this.#closeCode = code;
    for (const listener of this.#closeListeners.splice(0)) listener(code);
  }

  #receive(chunk: Buffer): void {
    if (this.#state !== 'open') return; // after a close frame, what still comes is dropped
    try {
      this.#parse(chunk);
    } catch (error) {
      // A listener the read called threw (onText, onBinary, or onClose from a close the read
      // caused): the rest of this read is not parsed, so the connection could only go on from the
      // middle of a frame. It ends here, and the error goes on (ruled, #44).
      this.destroy();
      throw error;
    }
  }

  /** Reads the frames in `chunk`; a breach of the protocol closes with its code. */
  #parse(chunk: Buffer): void {
    try {
      let at = 0;
      while (this.#state === 'open') {
        if (!this.#inPayload) {
          at = this.#readHeader(chunk, at);
          if (!this.#inPayload) return;
        }
        const end = Math.min(chunk.length, at + this.#length - this.#read);
        if (end > at) {
          const control = this.#opcode >= CLOSE;
          const into = control ? this.#control : this.#message;
          // A last frame's message ends with this payload, so its buffer grows to that size only.
          const limit =
            control || this.#fin ? into.length + this.#length - this.#read : MAX_MESSAGE;
          into.appendUnmasked(chunk, at, end, this.#mask, this.#read, limit);
          this.#read += end - at;
          at = end;
        }
        if (this.#read < this.#length) return;
        this.#inPayload = false;
        this.#headLength = 0;
        this.#frame();
      }
    } catch (error) {
      if (!(error instanceof Breach)) throw error;
      this.#closeWith(error.code);
    }
  }

  /**
   * Copies header bytes from `chunk` at `at` until the header is whole (then #inPayload is true)
   * or `chunk` is used up; returns where the bytes not taken start.
   */
  #readHeader(chunk: Buffer, at: number): number {
    const head = this.#head;
    for (;;) {
      const size = this.#headLength < 2 ? 2 : headerSize(head[1] as number);
      if (this.#headLength === size) break;
      if (at === chunk.length) return at;
      const n = Math.min(size - this.#headLength, chunk.length - at);
      for (let i = 0; i < n; i++) head[this.#headLength + i] = chunk[at + i] as number;
      this.#headLength += n;
      at += n;
      if (this.#headLength === 2) checkStart(head[0] as number, head[1] as number);
    }
    this.#fin = ((head[0] as number) & 0x80) !== 0;
    this.#opcode = (head[0] as number) & 0x0f;
    this.#length = payloadLength(this.#headView);
    this.#read = 0;
    for (let i = 0; i < 4; i++) this.#mask[i] = head[this.#headLength - 4 + i] as number;
    this.#checkSequence();
    this.#inPayload = true;
    return at;
  }

  /**
   * Fragmentation rules (RFC 6455 5.4) and the message limit, checked as soon as the header is
   * whole, before any of the payload is kept.
   */
  #checkSequence(): void {
    const opcode = this.#opcode;
    if (opcode >= CLOSE) return;
    if ((opcode === CONTINUATION) !== (this.#messageOpcode !== null)) {
      throw new Breach(PROTOCOL_ERROR);
    }
    if (this.#message.length + this.#length > MAX_MESSAGE) throw new Breach(TOO_BIG);
    if (opcode !== CONTINUATION) this.#messageOpcode = opcode;
  }

  /** The frame whose payload has just been read whole. */
  #frame(): void {
    switch (this.#opcode) {
      case CLOSE:
        this.#peerClose(this.#control.take());
        return;
      case PING: {
        // A peer that pings and never reads must not make the queue grow with pongs: while the
        // socket is backed up only the latest ping is answered (RFC 6455 5.5.3 allows that).
        const payload = this.#control.take();
        if (this.#socket.writableNeedDrain) this.#pendingPong = payload;
        else this.#socket.write(encodeFrame(PONG, payload));
        return;
      }
      case PONG:
        this.#control.take();
        return;
      default: {
        if (!this.#fin) return;
        const opcode = this.#messageOpcode as number;
        this.#messageOpcode = null;
        this.#deliver(opcode, this.#message.take());
      }
    }
  }

  /** The peer's close frame: answered with its code (none when it gave none), RFC 6455 5.5.1. */
  #peerClose(payload: Uint8Array): void {
    if (payload.length === 0) {
      this.#closeWith(null);
      return;
    }
    if (payload.length === 1) throw new Breach(PROTOCOL_ERROR);
    const code = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
    if (!isCloseCode(code)) throw new Breach(PROTOCOL_ERROR);
    decodeUtf8(payload.subarray(2));
    this.#closeWith(code);
  }

  #deliver(opcode: number, payload: Uint8Array): void {
    if (opcode === TEXT) {
      const text = decodeUtf8(payload);
      for (const listener of this.#textListeners) listener(text);
    } else {
      for (const listener of this.#binaryListeners) listener(payload);
    }
  }
}
