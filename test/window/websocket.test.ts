import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { MAX_MESSAGE, acceptWebSocket } from '../../src/window/websocket.ts';
import type { WebSocketConnection } from '../../src/window/websocket.ts';
import { testPlatform } from '../helpers/platform.ts';

const MiB = 1024 * 1024;
const SIZES = [0, 125, 126, 65_535, 65_536, MiB];
/** RFC 6455 section 1.3's example: this key gives this accept value. */
const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const RFC_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

type Message = { text: string } | { binary: Uint8Array };

interface Queue<T> {
  push(value: T): void;
  next(what: string): Promise<T>;
  readonly items: readonly T[];
}

function queue<T>(): Queue<T> {
  const items: T[] = [];
  const waiters: ((value: T) => void)[] = [];
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter === undefined) items.push(value);
      else waiter(value);
    },
    async next(what) {
      if (items.length > 0) return items.shift() as T;
      return await within(what, new Promise<T>((resolve) => waiters.push(resolve)));
    },
    items,
  };
}

/** `promise`, or a failure naming `what` after 10 s (this machine is shared and loaded). */
async function within<T>(what: string, promise: Promise<T>): Promise<T> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(10_000, undefined, { signal: timeout.signal }).then(() =>
        assert.fail(`timed out waiting for ${what}`),
      ),
    ]);
  } finally {
    timeout.abort();
  }
}

async function until(what: string, condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}

/** A server-side connection with listeners registered as soon as acceptWebSocket returned. */
interface Accepted {
  conn: WebSocketConnection;
  messages: Queue<Message>;
  closed: Promise<number>;
  drains: number;
}

interface Served {
  port: number;
  /** One entry per upgrade: what acceptWebSocket returned (null for a refusal). */
  accepted: Queue<Accepted | null>;
  /** The `head` length of each upgrade, in order. */
  heads: number[];
}

/** A server from platform.net.listenHttp on port 0 that hands every upgrade to acceptWebSocket. */
async function serve(
  t: TestContext,
  options: { echo?: boolean; beforeAccept?: (socket: Duplex) => void } = {},
): Promise<Served> {
  const { platform } = testPlatform(t);
  const accepted = queue<Accepted | null>();
  const heads: number[] = [];
  const listener = await platform.net.listenHttp(
    { host: '127.0.0.1', port: 0 },
    {
      request: (_req, res) => {
        res.statusCode = 404;
        res.end();
      },
      upgrade: (req, socket, head) => {
        heads.push(head.length);
        options.beforeAccept?.(socket);
        const conn = acceptWebSocket(req, socket, head);
        accepted.push(conn === null ? null : record(conn, options.echo ?? true));
      },
    },
  );
  t.after(() => listener.close());
  return { port: listener.port, accepted, heads };
}

function record(conn: WebSocketConnection, echo: boolean): Accepted {
  const messages = queue<Message>();
  const accepted: Accepted = {
    conn,
    messages,
    closed: new Promise<number>((resolve) => conn.onClose(resolve)),
    drains: 0,
  };
  conn.onText((text) => {
    messages.push({ text });
    if (echo) conn.sendText(text);
  });
  conn.onBinary((bytes) => {
    messages.push({ binary: bytes });
    if (echo) conn.sendBinary(bytes);
  });
  conn.onDrain(() => {
    accepted.drains++;
  });
  return accepted;
}

async function acceptedOf(served: Served): Promise<Accepted> {
  const accepted = await served.accepted.next('the upgrade');
  assert.ok(accepted !== null, 'the upgrade was refused');
  return accepted;
}

/** A `ws` client (it offers permessage-deflate, which the server must not take). */
async function client(
  t: TestContext,
  port: number,
): Promise<{ ws: WebSocket; messages: Queue<Message> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.terminate());
  const messages = queue<Message>();
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    messages.push(isBinary ? { binary: new Uint8Array(data) } : { text: data.toString('utf8') });
  });
  await within('open', once(ws, 'open'));
  return { ws, messages };
}

function closeOf(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return within(
    'the client to close',
    new Promise((resolve) => {
      ws.once('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    }),
  );
}

/** Text whose UTF-8 is exactly `n` bytes, mostly three-byte characters. */
function textOfBytes(n: number): string {
  return '€'.repeat(Math.floor(n / 3)) + 'x'.repeat(n % 3);
}

function bytesOf(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
}

function assertSameBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert.equal(actual.length, expected.length, `${what}: length`);
  assert.ok(Buffer.from(actual).equals(Buffer.from(expected)), `${what}: content`);
}

function assertMessage(actual: Message, expected: Message, what: string): void {
  if ('text' in expected) {
    assert.ok('text' in actual, `${what}: a text message`);
    assert.ok(actual.text === expected.text, `${what}: the same text`);
  } else {
    assert.ok('binary' in actual, `${what}: a binary message`);
    assertSameBytes(actual.binary, expected.binary, what);
  }
}

// ---- a raw client, for what `ws` will not send ----

interface Raw {
  socket: Socket;
  /** The handshake's answer, up to and with the blank line. */
  response: string;
  /** Bytes received after the handshake's answer. */
  received(): Buffer;
  /** How many bytes received() would give, without joining them. */
  receivedLength(): number;
  ended(): boolean;
}

function upgradeRequest(port: number, headers: Record<string, string | undefined> = {}): string {
  const all: Record<string, string | undefined> = {
    Host: `127.0.0.1:${port}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': RFC_KEY,
    'Sec-WebSocket-Version': '13',
    ...headers,
  };
  const lines = Object.entries(all)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}: ${value}\r\n`);
  return `GET /ws HTTP/1.1\r\n${lines.join('')}\r\n`;
}

/** Sends `request` (and `after` in the same write) and waits for the answer's blank line. */
async function raw(
  t: TestContext,
  port: number,
  request: string,
  after: Uint8Array = new Uint8Array(0),
): Promise<Raw> {
  const socket = connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  const chunks: Buffer[] = [];
  let length = 0;
  let joined = Buffer.alloc(0);
  const data = (): Buffer => {
    if (joined.length !== length) joined = Buffer.concat(chunks, length);
    return joined;
  };
  let ended = false;
  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
  });
  socket.on('end', () => {
    ended = true;
  });
  socket.on('error', () => {});
  await within('connect', once(socket, 'connect'));
  socket.write(Buffer.concat([Buffer.from(request, 'latin1'), after]));
  await until('the answer', () => data().includes('\r\n\r\n') || ended);
  const end = data().indexOf('\r\n\r\n') + 4;
  return {
    socket,
    response: data().subarray(0, end).toString('latin1'),
    received: () => data().subarray(end),
    receivedLength: () => length - end,
    ended: () => ended,
  };
}

/** A client frame: masked unless asked otherwise. */
function clientFrame(
  opcode: number,
  payload: Uint8Array = new Uint8Array(0),
  options: { fin?: boolean; rsv?: number; masked?: boolean; length64?: bigint } = {},
): Buffer {
  const { fin = true, rsv = 0, masked = true } = options;
  const first = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  const maskBit = masked ? 0x80 : 0;
  let header: Buffer;
  if (options.length64 !== undefined) {
    header = Buffer.alloc(10);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(options.length64, 2);
  } else if (payload.length < 126) {
    header = Buffer.from([0, maskBit | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = first;
  if (!masked) return Buffer.concat([header, payload]);
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const body = Buffer.from(payload.map((byte, i) => byte ^ (mask[i & 3] as number)));
  return Buffer.concat([header, mask, body]);
}

function closePayload(code: number, reason: Uint8Array = new Uint8Array(0)): Buffer {
  const payload = Buffer.alloc(2 + reason.length);
  payload.writeUInt16BE(code, 0);
  payload.set(reason, 2);
  return payload;
}

interface ServerFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** The server's frames in `bytes`; every one must be unmasked with no reserved bit. */
function serverFrames(bytes: Buffer): ServerFrame[] {
  const frames: ServerFrame[] = [];
  let at = 0;
  while (at + 2 <= bytes.length) {
    const b0 = bytes[at] as number;
    const b1 = bytes[at + 1] as number;
    assert.equal(b0 & 0x70, 0, 'no reserved bit');
    assert.equal(b1 & 0x80, 0, 'a server frame is not masked');
    let length = b1 & 0x7f;
    let start = at + 2;
    if (length === 126) {
      length = bytes.readUInt16BE(at + 2);
      start = at + 4;
    } else if (length === 127) {
      length = Number(bytes.readBigUInt64BE(at + 2));
      start = at + 10;
    }
    if (start + length > bytes.length) break;
    frames.push({
      fin: (b0 & 0x80) !== 0,
      opcode: b0 & 0x0f,
      payload: bytes.subarray(start, start + length),
    });
    at = start + length;
  }
  return frames;
}

/** Waits for the server's close frame on a raw client and returns its code. */
async function serverCloseCode(r: Raw): Promise<number> {
  await until('the close frame', () =>
    serverFrames(r.received()).some((f) => f.opcode === OP.close),
  );
  const close = serverFrames(r.received()).find((f) => f.opcode === OP.close) as ServerFrame;
  assert.equal(close.payload.length >= 2, true, 'the close frame carries a code');
  return close.payload.readUInt16BE(0);
}

/** Sends a raw request and returns the whole answer once the server ended it. */
async function rawAnswer(t: TestContext, port: number, request: string): Promise<string> {
  const r = await raw(t, port, request);
  await until('the server to end the connection', () => r.ended());
  return r.response;
}

describe('WebSocket: the opening handshake', () => {
  test('answers 101 with the accept value of RFC 6455, and negotiates no extension or subprotocol', async (t) => {
    const served = await serve(t);

    const r = await raw(
      t,
      served.port,
      upgradeRequest(served.port, {
        'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
        'Sec-WebSocket-Protocol': 'chat',
      }),
    );

    assert.match(r.response, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(r.response, /\r\nUpgrade: websocket\r\n/i);
    assert.match(r.response, /\r\nConnection: Upgrade\r\n/i);
    assert.match(
      r.response,
      new RegExp(`\\r\\nSec-WebSocket-Accept: ${RFC_ACCEPT.replace(/[+/]/g, '\\$&')}\\r\\n`),
    );
    assert.doesNotMatch(
      r.response,
      /Sec-WebSocket-Extensions|Sec-WebSocket-Protocol|Access-Control-/i,
    );
    assert.notEqual(await acceptedOf(served), null);
  });

  test('a ws client that offers permessage-deflate gets no extension', async (t) => {
    const served = await serve(t);

    const { ws } = await client(t, served.port);

    assert.equal(ws.extensions, '');
    assert.equal(ws.protocol, '');
  });

  const refusals: [string, Record<string, string | undefined>][] = [
    ['a missing Sec-WebSocket-Key', { 'Sec-WebSocket-Key': undefined }],
    ['a key of 15 bytes', { 'Sec-WebSocket-Key': Buffer.alloc(15, 1).toString('base64') }],
    ['a key of 17 bytes', { 'Sec-WebSocket-Key': Buffer.alloc(17, 1).toString('base64') }],
    ['a key that is not base64', { 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25j!!==' }],
    ['a missing version', { 'Sec-WebSocket-Version': undefined }],
    ['version 8', { 'Sec-WebSocket-Version': '8' }],
    ['an Upgrade to another protocol', { Upgrade: 'h2c' }],
  ];
  for (const [name, headers] of refusals) {
    test(`${name} → 400, no connection`, async (t) => {
      const served = await serve(t);

      const answer = await rawAnswer(t, served.port, upgradeRequest(served.port, headers));

      assert.match(answer, /^HTTP\/1\.1 400 /);
      assert.equal(await served.accepted.next('the upgrade'), null);
    });
  }

  test('a POST upgrade → 400', async (t) => {
    const served = await serve(t);
    const request = upgradeRequest(served.port).replace(/^GET /, 'POST ');

    const answer = await rawAnswer(t, served.port, request);

    assert.match(answer, /^HTTP\/1\.1 400 /);
    assert.equal(await served.accepted.next('the upgrade'), null);
  });

  test('the 400 carries no CORS header and the fixed headers of S2 8.2.1 that need no port', async (t) => {
    const served = await serve(t);

    const answer = await rawAnswer(
      t,
      served.port,
      upgradeRequest(served.port, { 'Sec-WebSocket-Key': undefined }),
    );

    assert.doesNotMatch(answer, /Access-Control-/i);
    assert.match(answer, /\r\nX-Content-Type-Options: nosniff\r\n/);
    assert.match(answer, /\r\nX-Frame-Options: DENY\r\n/);
    assert.match(answer, /\r\nReferrer-Policy: no-referrer\r\n/);
    assert.match(
      answer,
      /\r\nContent-Security-Policy: default-src 'none';[^\r]*frame-ancestors 'none'\r\n/,
    );
  });

  test('a frame sent together with the request (the upgrade head) is delivered', async (t) => {
    const served = await serve(t, { echo: false });

    await raw(
      t,
      served.port,
      upgradeRequest(served.port),
      clientFrame(OP.text, Buffer.from('early')),
    );
    const accepted = await acceptedOf(served);

    assert.ok((served.heads[0] ?? 0) > 0, 'the frame arrived as the upgrade head');
    assertMessage(await accepted.messages.next('the early message'), { text: 'early' }, 'early');
  });

  test('a socket already destroyed gives a connection that reports 1006', async (t) => {
    const served = await serve(t, {
      beforeAccept: (socket) => {
        socket.destroy();
      },
    });

    await raw(t, served.port, upgradeRequest(served.port)).catch(() => undefined);
    const accepted = await acceptedOf(served);

    assert.equal(await within('onClose', accepted.closed), 1006);
  });
});

describe('WebSocket: messages', () => {
  for (const n of SIZES) {
    test(`a text message of ${n} bytes both ways`, async (t) => {
      const served = await serve(t);
      const { ws, messages } = await client(t, served.port);
      const accepted = await acceptedOf(served);
      const text = textOfBytes(n);

      ws.send(text);

      assertMessage(await accepted.messages.next('the server'), { text }, 'server received');
      assertMessage(await messages.next('the echo'), { text }, 'client received');
    });

    test(`a binary message of ${n} bytes both ways`, async (t) => {
      const served = await serve(t);
      const { ws, messages } = await client(t, served.port);
      const accepted = await acceptedOf(served);
      const bytes = bytesOf(n);

      ws.send(bytes);

      assertMessage(
        await accepted.messages.next('the server'),
        { binary: bytes },
        'server received',
      );
      assertMessage(await messages.next('the echo'), { binary: bytes }, 'client received');
    });
  }

  test('a binary message reaches the listener as a plain Uint8Array', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);

    ws.send(bytesOf(3));
    const message = await accepted.messages.next('the server');

    assert.ok('binary' in message);
    assert.equal(Object.getPrototypeOf(message.binary), Uint8Array.prototype);
  });

  test('a message fragmented into three frames with a ping between them', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const pong = within(
      'the pong',
      new Promise<string>((resolve) => ws.once('pong', (data: Buffer) => resolve(data.toString()))),
    );

    ws.send('frag-', { fin: false });
    ws.ping('between');
    ws.send('men', { fin: false });
    ws.send('t', { fin: true });

    assert.equal(await pong, 'between');
    assertMessage(await accepted.messages.next('the message'), { text: 'frag-ment' }, 'fragments');
    assert.equal(accepted.messages.items.length, 0, 'one message only');
  });

  test('a character split between fragments of a text message', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);

    ws.send(Buffer.from([0x61, 0xe2]), { binary: false, fin: false });
    ws.send(Buffer.from([0x82]), { binary: false, fin: false });
    ws.send(Buffer.from([0xac, 0x62]), { binary: false, fin: true });

    assertMessage(await accepted.messages.next('the message'), { text: 'a€b' }, 'split');
  });

  test('a fragmented binary message', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const bytes = bytesOf(300_000);

    ws.send(bytes.subarray(0, 100_000), { binary: true, fin: false });
    ws.send(bytes.subarray(100_000, 200_000), { binary: true, fin: false });
    ws.send(bytes.subarray(200_000), { binary: true, fin: true });

    assertMessage(await accepted.messages.next('the message'), { binary: bytes }, 'fragments');
  });

  test('a byte order mark at the start of a text message is kept', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);

    ws.send('﻿bom');

    assertMessage(await accepted.messages.next('the message'), { text: '﻿bom' }, 'bom');
  });

  test('ping → pong with the same payload', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    await acceptedOf(served);
    const payload = bytesOf(125);
    const pong = within('the pong', new Promise<Buffer>((resolve) => ws.once('pong', resolve)));

    ws.ping(payload);

    assertSameBytes(await pong, payload, 'pong');
  });

  test('sendBinary copies: changing the array after the call changes nothing sent', async (t) => {
    const served = await serve(t, { echo: false });
    const { messages } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const bytes = bytesOf(1000);
    const expected = bytes.slice();

    accepted.conn.sendBinary(bytes);
    bytes.fill(0);

    assertMessage(await messages.next('the message'), { binary: expected }, 'copied');
  });

  test('sendText never sends invalid UTF-8: a lone surrogate arrives as U+FFFD', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws, messages } = await client(t, served.port);
    const accepted = await acceptedOf(served);

    accepted.conn.sendText('a\uD800b');

    assertMessage(await messages.next('the message'), { text: 'a�b' }, 'replaced');
    assert.equal(ws.readyState, WebSocket.OPEN);
  });
});

describe('WebSocket: closing', () => {
  test('the client closes with a code → the same code echoed, onClose gets it', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    ws.close(4000, 'bye');

    assert.equal((await closed).code, 4000);
    assert.equal(await within('onClose', accepted.closed), 4000);
  });

  test('the client closes without a code → onClose gets 1005, the client sees no code', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    ws.close();

    assert.equal((await closed).code, 1005);
    assert.equal(await within('onClose', accepted.closed), 1005);
  });

  test('the server closes with a code and a reason → the client gets both, onClose gets the code', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    accepted.conn.close(4003, 'bad proof');

    assert.deepEqual(await closed, { code: 4003, reason: 'bad proof' });
    assert.equal(await within('onClose', accepted.closed), 4003);
  });

  test('onClose fires once, and a listener registered after the close still gets the code', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const codes: number[] = [];
    accepted.conn.onClose((code) => codes.push(code));
    const closed = closeOf(ws);

    accepted.conn.close(4001);
    accepted.conn.close(4002);
    await closed;
    const late = await within(
      'the late listener',
      new Promise<number>((resolve) => accepted.conn.onClose(resolve)),
    );

    assert.deepEqual(codes, [4001]);
    assert.equal(late, 4001);
  });

  test('the client goes away without a close frame → onClose gets 1006', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);

    ws.terminate();

    assert.equal(await within('onClose', accepted.closed), 1006);
  });

  test('sending after the close does nothing and does not throw', async (t) => {
    const served = await serve(t);
    const { ws, messages } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    accepted.conn.close(1000);
    accepted.conn.sendText('late');
    accepted.conn.sendBinary(bytesOf(10));
    await closed;
    accepted.conn.sendText('later');

    assert.equal(messages.items.length, 0);
  });

  test('messages that arrive after the server sent its close are not delivered', async (t) => {
    const served = await serve(t, { echo: false });
    const r = await raw(t, served.port, upgradeRequest(served.port));
    const accepted = await acceptedOf(served);

    accepted.conn.close(1000);
    r.socket.write(clientFrame(OP.text, Buffer.from('too late')));
    r.socket.write(clientFrame(OP.close, closePayload(1000)));

    await until('the server to end the connection', () => r.ended());
    assert.equal(accepted.messages.items.length, 0);
  });

  test('close() refuses a code a server may not send and a reason above 123 bytes', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const { conn, closed } = await acceptedOf(served);
    const clientClosed = closeOf(ws);

    for (const code of [0, 999, 1004, 1005, 1006, 1015, 2999, 5000, 1000.5]) {
      assert.throws(() => conn.close(code), RangeError, String(code));
    }
    assert.throws(() => conn.close(1000, 'é'.repeat(62)), RangeError); // 124 bytes
    conn.close(1000, 'x'.repeat(123));

    assert.equal(await within('onClose', closed), 1000);
    assert.deepEqual(await clientClosed, { code: 1000, reason: 'x'.repeat(123) });
  });
});

describe('WebSocket: protocol errors', () => {
  test('invalid UTF-8 in a text message → close 1007, nothing delivered', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    ws.send(Buffer.from([0x61, 0xc3, 0x28]), { binary: false });

    assert.equal((await closed).code, 1007);
    assert.equal(await within('onClose', accepted.closed), 1007);
    assert.equal(accepted.messages.items.length, 0);
  });

  test('a text message cut in the middle of a character at its last fragment → close 1007', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    ws.send(Buffer.from([0x61, 0xe2]), { binary: false, fin: false });
    ws.send(Buffer.from([0x82]), { binary: false, fin: true });

    assert.equal((await closed).code, 1007);
    assert.equal(accepted.messages.items.length, 0);
  });

  test('an unmasked client frame → close 1002, nothing delivered', async (t) => {
    const served = await serve(t);
    const r = await raw(t, served.port, upgradeRequest(served.port));
    const accepted = await acceptedOf(served);

    r.socket.write(clientFrame(OP.binary, Buffer.from('A'), { masked: false }));

    assert.equal(await serverCloseCode(r), 1002);
    assert.equal(await within('onClose', accepted.closed), 1002);
    assert.equal(accepted.messages.items.length, 0);
    await until('the server to end the connection', () => r.ended());
  });

  const violations: [string, Buffer][] = [
    ['a reserved bit', clientFrame(OP.text, Buffer.from('x'), { rsv: 4 })],
    ['an unknown data opcode', clientFrame(3, Buffer.from('x'))],
    ['an unknown control opcode', clientFrame(11)],
    ['a continuation with no message started', clientFrame(OP.continuation, Buffer.from('x'))],
    [
      'a new message inside a fragmented one',
      Buffer.concat([
        clientFrame(OP.text, Buffer.from('a'), { fin: false }),
        clientFrame(OP.text, Buffer.from('b')),
      ]),
    ],
    ['a fragmented ping', clientFrame(OP.ping, Buffer.from('x'), { fin: false })],
    ['a ping of 126 bytes', clientFrame(OP.ping, bytesOf(126))],
    ['a close of one byte', clientFrame(OP.close, Buffer.from([3]))],
    ['a close with code 1005', clientFrame(OP.close, closePayload(1005))],
    ['a close with code 999', clientFrame(OP.close, closePayload(999))],
    ['a close with code 5000', clientFrame(OP.close, closePayload(5000))],
    [
      'a 64-bit length with its top bit set',
      clientFrame(OP.binary, new Uint8Array(0), { length64: 1n << 63n }),
    ],
  ];
  for (const [name, bytes] of violations) {
    test(`${name} → close 1002`, async (t) => {
      const served = await serve(t);
      const r = await raw(t, served.port, upgradeRequest(served.port));
      const accepted = await acceptedOf(served);

      r.socket.write(bytes);

      assert.equal(await serverCloseCode(r), 1002);
      assert.equal(await within('onClose', accepted.closed), 1002);
      assert.equal(accepted.messages.items.length, 0);
    });
  }

  test('a close whose reason is invalid UTF-8 → close 1007', async (t) => {
    const served = await serve(t);
    const r = await raw(t, served.port, upgradeRequest(served.port));
    const accepted = await acceptedOf(served);

    r.socket.write(clientFrame(OP.close, closePayload(1000, Buffer.from([0xc3, 0x28]))));

    assert.equal(await serverCloseCode(r), 1007);
    assert.equal(await within('onClose', accepted.closed), 1007);
  });

  test(`a message of exactly MAX_MESSAGE (${MAX_MESSAGE}) bytes is accepted`, async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);

    ws.send(new Uint8Array(MAX_MESSAGE));

    const message = await accepted.messages.next('the message');
    assert.ok('binary' in message);
    assert.equal(message.binary.length, MiB);
  });

  test('a message over 1 MiB in one frame → close 1009, nothing delivered', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    ws.send(new Uint8Array(MAX_MESSAGE + 1));

    assert.equal((await closed).code, 1009);
    assert.equal(await within('onClose', accepted.closed), 1009);
    assert.equal(accepted.messages.items.length, 0);
  });

  test('a message over 1 MiB as fragments that add up to more → close 1009, nothing delivered', async (t) => {
    const served = await serve(t);
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);
    const part = new Uint8Array(400 * 1024);

    ws.send(part, { binary: true, fin: false });
    ws.send(part, { binary: true, fin: false });
    ws.send(part, { binary: true, fin: true });

    assert.equal((await closed).code, 1009);
    assert.equal(await within('onClose', accepted.closed), 1009);
    assert.equal(accepted.messages.items.length, 0);
  });

  test('MAX_MESSAGE is 1 MiB', () => {
    assert.equal(MAX_MESSAGE, MiB);
  });
});

describe('WebSocket: backpressure', () => {
  test('buffered grows while the client does not read, and onDrain fires once it reads again', async (t) => {
    const served = await serve(t, { echo: false });
    const r = await raw(t, served.port, upgradeRequest(served.port));
    const accepted = await acceptedOf(served);
    const { conn } = accepted;
    const chunk = bytesOf(60_000); // 4-byte frame header
    r.socket.pause();

    let frames = 0;
    while (conn.buffered <= MiB && frames < 1100) {
      conn.sendBinary(chunk);
      frames++;
    }
    assert.ok(conn.buffered > MiB, `buffered ${conn.buffered} after ${frames} frames`);
    await delay(200);
    assert.ok(conn.buffered > MiB, `buffered ${conn.buffered} while the client does not read`);
    assert.equal(accepted.drains, 0, 'no drain while the client does not read');

    r.socket.resume();
    await until('onDrain', () => accepted.drains > 0);

    assert.ok(conn.buffered < 64 * 1024, `buffered ${conn.buffered} at drain`);
    await until('every frame', () => r.receivedLength() === frames * 60_004);
    const all = serverFrames(r.received());
    assert.equal(all.length, frames);
    assertSameBytes((all.at(-1) as ServerFrame).payload, chunk, 'the last frame');
  });

  test('pings while the socket is backed up get one pong, for the latest (RFC 6455 5.5.3)', async (t) => {
    const served = await serve(t, { echo: false });
    const r = await raw(t, served.port, upgradeRequest(served.port));
    const accepted = await acceptedOf(served);
    const { conn } = accepted;
    const chunk = bytesOf(60_000);
    r.socket.pause();
    let frames = 0;
    while (conn.buffered <= MiB && frames < 1100) {
      conn.sendBinary(chunk);
      frames++;
    }
    const queued = conn.buffered;
    const pings = 5000;
    const payload = (i: number): Buffer => Buffer.from(String(i).padStart(125, '.'));

    for (let i = 0; i < pings; i++) r.socket.write(clientFrame(OP.ping, payload(i)));
    r.socket.write(clientFrame(OP.text, Buffer.from('done')));
    await accepted.messages.next('every ping read');

    assert.ok(conn.buffered < queued + 1024, `buffered grew from ${queued} to ${conn.buffered}`);
    r.socket.resume();
    const isPong = (f: ServerFrame): boolean => f.opcode === OP.pong;
    await until('the pong', () => serverFrames(r.received()).some(isPong));
    const pongs = serverFrames(r.received()).filter(isPong);
    assert.equal(pongs.length, 1);
    assertSameBytes((pongs[0] as ServerFrame).payload, payload(pings - 1), 'the latest ping');
  });
});
