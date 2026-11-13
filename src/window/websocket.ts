/**
 * The server's own WebSocket (RFC 6455) on an upgrade request of node:http (S2 8.2.1): text and
 * binary messages, fragmentation, ping and pong, the closing handshake and its codes. No extension
 * and no subprotocol is ever negotiated. A message over MAX_MESSAGE closes with 1009, invalid
 * UTF-8 in a text message with 1007, any other breach of the protocol (an unmasked client frame
 * among them) with 1002.
 *
 * Not here: the `Host` and `Origin` checks and the handshake of S2 8.2.2, which the caller does
 * (task 17); timers (no clock is used: a peer that never finishes the closing handshake keeps its
 * socket until it goes away or the listener closes).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface WebSocketConnection {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Bytes written to the socket and not yet flushed (for S2 8.2.8). */
  readonly buffered: number;
  close(code: number, reason?: string): void;
  onText(listener: (text: string) => void): void;
  onBinary(listener: (bytes: Uint8Array) => void): void;
  onDrain(listener: () => void): void;
  onClose(listener: (code: number) => void): void;
}

export const MAX_MESSAGE = 1024 * 1024;

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
 *  not a valid version-13 upgrade. The caller has checked Host and Origin before (task 17). */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): WebSocketConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (!isUpgrade(req) || typeof key !== 'string' || !KEY.test(key)) {
    refuse(socket);
    return null;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  return new Connection(socket, head, accept);
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

/** Received bytes not read yet, kept as the chunks they came in until a whole frame is there. */
class ByteQueue {
  #chunks: Buffer[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  /** A copy of the first `count` bytes (at most `length`), which stay in the queue. */
  peek(count: number): Buffer {
    const out = Buffer.alloc(Math.min(count, this.#length));
    let at = 0;
    for (const chunk of this.#chunks) {
      if (at === out.length) break;
      at += chunk.copy(out, at, 0, Math.min(chunk.length, out.length - at));
    }
    return out;
  }

  /** Removes the first `count` bytes (at most `length`) and returns them in an array of their own. */
  take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let at = 0;
    while (at < count) {
      const chunk = this.#chunks[0] as Buffer;
      const n = Math.min(chunk.length, count - at);
      out.set(chunk.subarray(0, n), at);
      at += n;
      if (n === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(n);
    }
    this.#length -= count;
    return out;
  }

  clear(): void {
    this.#chunks = [];
    this.#length = 0;
  }
}

interface FrameHeader {
  fin: boolean;
  opcode: number;
  /** Header and mask bytes before the payload. */
  size: number;
  length: number;
}

/**
 * The frame header at the start of `bytes`, or null when more bytes are needed. Throws a Breach for
 * a header that breaks the protocol, whatever its payload.
 */
function readHeader(bytes: Buffer): FrameHeader | null {
  if (bytes.length < 2) return null;
  const b0 = bytes[0] as number;
  const b1 = bytes[1] as number;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  if ((b0 & 0x70) !== 0) throw new Breach(PROTOCOL_ERROR); // no extension gives the bits a meaning
  if ((b1 & 0x80) === 0) throw new Breach(PROTOCOL_ERROR); // a client masks every frame
  const control = opcode >= CLOSE;
  if (![CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG].includes(opcode)) {
    throw new Breach(PROTOCOL_ERROR);
  }
  let length = b1 & 0x7f;
  let size = 2;
  if (length === 126) {
    if (bytes.length < 4) return null;
    length = bytes.readUInt16BE(2);
    size = 4;
  } else if (length === 127) {
    if (bytes.length < 10) return null;
    const long = bytes.readBigUInt64BE(2);
    if (long >> 63n !== 0n) throw new Breach(PROTOCOL_ERROR); // RFC 6455 5.2: the top bit is 0
    length = Number(long); // inexact above 2^53, but then far above MAX_MESSAGE all the same
    size = 10;
  }
  if (control && (!fin || length > MAX_CONTROL)) throw new Breach(PROTOCOL_ERROR);
  if (length > MAX_MESSAGE) throw new Breach(TOO_BIG);
  return { fin, opcode, size: size + 4, length };
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
  readonly #input = new ByteQueue();
  /** open: messages flow; closing: a close frame was sent, input is dropped; the code is known. */
  #state: 'open' | 'closing' = 'open';
  #closeCode: number | null = null;
  #fragments: Uint8Array[] | null = null;
  #fragmentOpcode = TEXT;
  #fragmentBytes = 0;
  /** The latest ping's payload while the socket is backed up; its pong goes out at the drain. */
  #pendingPong: Uint8Array | null = null;
  readonly #textListeners: ((text: string) => void)[] = [];
  readonly #binaryListeners: ((bytes: Uint8Array) => void)[] = [];
  readonly #drainListeners: (() => void)[] = [];
  readonly #closeListeners: ((code: number) => void)[] = [];

  constructor(socket: Duplex, head: Buffer, accept: string) {
    this.#socket = socket;
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      this.#gone();
    });
    if (socket.destroyed) {
      this.#gone();
      return;
    }
    socket.on('end', () => {
      // The peer will send nothing more. Its socket is half-open (node:http's allowHalfOpen):
      // ending ours as well lets it close.
      this.#gone();
      socket.end();
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
    this.#state = 'closing';
    this.#input.clear();
    this.#fragments = null;
    if (!this.#socket.destroyed) {
      let payload = new Uint8Array(0);
      if (code !== null) {
        payload = new Uint8Array(2 + reason.length);
        new DataView(payload.buffer).setUint16(0, code);
        payload.set(reason, 2);
      }
      this.#socket.write(encodeFrame(CLOSE, payload));
      this.#socket.end();
    }
    this.#report(code ?? NO_STATUS);
  }

  /** The socket ended or closed without a closing handshake, or after it. */
  #gone(): void {
    this.#state = 'closing';
    this.#input.clear();
    this.#fragments = null;
    this.#report(ABNORMAL);
  }

  #report(code: number): void {
    if (this.#closeCode !== null) return;
    this.#closeCode = code;
    for (const listener of this.#closeListeners.splice(0)) listener(code);
  }

  #receive(chunk: Buffer): void {
    if (this.#state !== 'open') return; // after a close frame, what still comes is dropped
    this.#input.push(chunk);
    try {
      while (this.#state === 'open') {
        const header = readHeader(this.#input.peek(LONGEST_HEADER));
        if (header === null) return;
        this.#checkSequence(header);
        if (this.#input.length < header.size + header.length) return;
        const mask = this.#input.take(header.size).subarray(header.size - 4);
        const payload = this.#input.take(header.length);
        for (let i = 0; i < payload.length; i++) {
          payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
        }
        this.#frame(header, payload);
      }
    } catch (error) {
      if (!(error instanceof Breach)) throw error;
      this.#closeWith(error.code);
    }
  }

  /** Fragmentation rules (RFC 6455 5.4) and the message limit, checked before the payload is read. */
  #checkSequence({ opcode, length }: FrameHeader): void {
    if (opcode >= CLOSE) return;
    if ((opcode === CONTINUATION) !== (this.#fragments !== null)) throw new Breach(PROTOCOL_ERROR);
    const total = (opcode === CONTINUATION ? this.#fragmentBytes : 0) + length;
    if (total > MAX_MESSAGE) throw new Breach(TOO_BIG);
  }

  #frame({ fin, opcode }: FrameHeader, payload: Uint8Array): void {
    switch (opcode) {
      case CLOSE:
        this.#peerClose(payload);
        return;
      case PING:
        // A peer that pings and never reads must not make the queue grow with pongs: while the
        // socket is backed up only the latest ping is answered (RFC 6455 5.5.3 allows that).
        if (this.#socket.writableNeedDrain) this.#pendingPong = payload;
        else this.#socket.write(encodeFrame(PONG, payload));
        return;
      case PONG:
        return;
      case CONTINUATION: {
        const fragments = this.#fragments as Uint8Array[];
        fragments.push(payload);
        this.#fragmentBytes += payload.length;
        if (!fin) return;
        this.#fragments = null;
        this.#deliver(this.#fragmentOpcode, join(fragments, this.#fragmentBytes));
        return;
      }
      default:
        if (fin) {
          this.#deliver(opcode, payload);
          return;
        }
        this.#fragments = [payload];
        this.#fragmentOpcode = opcode;
        this.#fragmentBytes = payload.length;
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

function join(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
