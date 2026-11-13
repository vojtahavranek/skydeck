import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { duplexPair } from 'node:stream';
import type { Duplex } from 'node:stream';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { CLOSE_WAIT_MS, MAX_MESSAGE, acceptWebSocket } from '../../src/window/websocket.ts';
import type { WebSocketConnection } from '../../src/window/websocket.ts';
import { T0, fakeClock, testPlatform } from '../helpers/platform.ts';
import type { FakeClock } from '../helpers/platform.ts';

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
  /** The fake clock the connections were given. */
  clock: FakeClock;
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
  const { platform, clock } = testPlatform(t);
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
        const conn = acceptWebSocket(req, socket, head, clock);
        accepted.push(conn === null ? null : record(conn, options.echo ?? true));
      },
    },
  );
  t.after(() => listener.close());
  return { port: listener.port, clock, accepted, heads };
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
  /** Keep this end open when the server ends its own (a default client ends at once). */
  allowHalfOpen = false,
): Promise<Raw> {
  const socket = connect({ port, host: '127.0.0.1', allowHalfOpen });
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
  options: {
    fin?: boolean;
    rsv?: number;
    masked?: boolean;
    /** The length announced in the 64-bit form, whatever the payload. */
    length64?: bigint;
    /** The form the payload's length is written in; by default the shortest. */
    form?: 7 | 16 | 64;
  } = {},
): Buffer {
  const { fin = true, rsv = 0, masked = true } = options;
  const first = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  const maskBit = masked ? 0x80 : 0;
  const form = options.form ?? (payload.length < 126 ? 7 : payload.length < 65_536 ? 16 : 64);
  let header: Buffer;
  if (options.length64 !== undefined || form === 64) {
    header = Buffer.alloc(10);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(options.length64 ?? BigInt(payload.length), 2);
  } else if (form === 7) {
    header = Buffer.from([0, maskBit | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
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

/** The headers of the WebSocket endpoint's own answers (ruled, #44). */
function assertFixedHeaders(answer: string): void {
  assert.match(answer, /\r\nX-Content-Type-Options: nosniff\r\n/);
  assert.match(answer, /\r\nX-Frame-Options: DENY\r\n/);
  assert.match(answer, /\r\nReferrer-Policy: no-referrer\r\n/);
  assert.match(
    answer,
    /\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n/,
  );
}

// ---- a direct pair, for reads of an exact size and requests node:http would not pass on ----

interface Direct {
  /** null when acceptWebSocket refused the request. */
  accepted: Accepted | null;
  /** The client's end: what it writes is one read on the server's side. */
  peer: Duplex;
  /** The server's side. */
  socket: Duplex;
  /** Everything the server wrote, the handshake's answer included. */
  output(): Buffer;
}

/** acceptWebSocket on one end of a duplexPair, with a request object built here. */
function direct(
  t: TestContext,
  request: { method?: string; minor?: number; headers?: Record<string, string | undefined> } = {},
): Direct {
  const [socket, peer] = duplexPair();
  t.after(() => {
    socket.destroy();
    peer.destroy();
  });
  const headers = Object.fromEntries(
    Object.entries({
      host: '127.0.0.1:1',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': RFC_KEY,
      'sec-websocket-version': '13',
      ...request.headers,
    }).filter((entry) => entry[1] !== undefined),
  );
  const req = {
    method: request.method ?? 'GET',
    httpVersionMajor: 1,
    httpVersionMinor: request.minor ?? 1,
    headers,
  } as unknown as IncomingMessage;
  const chunks: Buffer[] = [];
  peer.on('data', (chunk: Buffer) => chunks.push(chunk));
  const conn = acceptWebSocket(req, socket, Buffer.alloc(0), fakeClock(T0));
  return {
    accepted: conn === null ? null : record(conn, false),
    peer,
    socket,
    output: () => Buffer.concat(chunks),
  };
}

/** The frames the server wrote after its 101 on a direct pair. */
function framesAfterHandshake(d: Direct): ServerFrame[] {
  const out = d.output();
  return serverFrames(out.subarray(out.indexOf('\r\n\r\n') + 4));
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
    assertFixedHeaders(r.response);
    assert.notEqual(await acceptedOf(served), null);
  });

  const spellings: [string, Record<string, string>][] = [
    [
      'Connection: keep-alive, Upgrade (as Firefox sends it)',
      { connection: 'keep-alive, Upgrade' },
    ],
    ['Upgrade: WebSocket', { upgrade: 'WebSocket' }],
  ];
  for (const [name, headers] of spellings) {
    test(`${name} is an upgrade`, (t) => {
      const d = direct(t, { headers });

      assert.notEqual(d.accepted, null);
    });
  }

  test('an upgrade over HTTP/1.0 → 400, no connection', async (t) => {
    const d = direct(t, { minor: 0 });

    assert.equal(d.accepted, null);
    await until('the answer', () => d.output().includes('\r\n\r\n'));
    assert.match(d.output().toString('latin1'), /^HTTP\/1\.1 400 /);
  });

  test('a 400 destroys the socket even when the client keeps its end open', async (t) => {
    const sockets: Duplex[] = [];
    const served = await serve(t, { beforeAccept: (socket) => sockets.push(socket) });

    const r = await raw(
      t,
      served.port,
      upgradeRequest(served.port, { 'Sec-WebSocket-Version': '8' }),
      new Uint8Array(0),
      true,
    );
    await served.accepted.next('the upgrade');

    assert.match(r.response, /^HTTP\/1\.1 400 /);
    await until('the server to destroy its socket', () => sockets[0]?.destroyed === true);
    assert.equal(r.socket.writableEnded, false, 'the client kept its end open');
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
    assertFixedHeaders(answer);
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

  test('messages after a fragmented one: a second fragmented one, then a whole one', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);

    ws.send(Buffer.from('ab'), { binary: true, fin: false });
    ws.send(Buffer.from('cd'), { binary: true, fin: true });
    ws.send(Buffer.from('ef'), { binary: true, fin: false });
    ws.send(Buffer.from('gh'), { binary: true, fin: true });
    ws.send('ij');

    const next = (): Promise<Message> => accepted.messages.next('a message');
    assertMessage(await next(), { binary: Buffer.from('abcd') }, 'first');
    assertMessage(await next(), { binary: Buffer.from('efgh') }, 'second');
    assertMessage(await next(), { text: 'ij' }, 'third');
  });

  test('fragments that add up to exactly MAX_MESSAGE are one message', async (t) => {
    const served = await serve(t, { echo: false });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const bytes = bytesOf(MAX_MESSAGE);

    ws.send(bytes.subarray(0, MAX_MESSAGE / 2), { binary: true, fin: false });
    ws.send(bytes.subarray(MAX_MESSAGE / 2), { binary: true, fin: true });

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

  test('the client ends its side without a close frame → onClose gets 1006 and the server ends too', async (t) => {
    const served = await serve(t);
    const r = await raw(t, served.port, upgradeRequest(served.port));
    const accepted = await acceptedOf(served);

    r.socket.end();

    assert.equal(await within('onClose', accepted.closed), 1006);
    await until('the server to end its side', () => r.ended());
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
    ['a ping whose length takes the 16-bit form', clientFrame(OP.ping, bytesOf(5), { form: 16 })],
    [
      'a close whose length takes the 64-bit form',
      clientFrame(OP.close, closePayload(1000), { form: 64 }),
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

  const lengths64 = [2n ** 32n, 2n ** 32n + 5n, 2n ** 53n + 1n, 2n ** 63n - 1n];
  for (const length of lengths64) {
    test(`a 64-bit length of ${length} → close 1009`, async (t) => {
      const served = await serve(t);
      const r = await raw(t, served.port, upgradeRequest(served.port));
      const accepted = await acceptedOf(served);

      r.socket.write(clientFrame(OP.binary, bytesOf(5), { length64: length }));

      assert.equal(await serverCloseCode(r), 1009);
      assert.equal(await within('onClose', accepted.closed), 1009);
      assert.equal(accepted.messages.items.length, 0);
    });
  }

  const breaches: [string, Buffer, number][] = [
    ['an unmasked frame', clientFrame(OP.binary, Buffer.from('A'), { masked: false }), 1002],
    ...violations.map(([name, bytes]): [string, Buffer, number] => [name, bytes, 1002]),
    ...lengths64.map((length): [string, Buffer, number] => [
      `a 64-bit length of ${length}`,
      clientFrame(OP.binary, bytesOf(5), { length64: length }),
      1009,
    ]),
  ];
  for (const [name, bytes, code] of breaches) {
    test(`${name}, one byte per read → close ${code}`, async (t) => {
      const d = direct(t);
      const accepted = d.accepted as Accepted;

      for (const byte of bytes) d.peer.write(Uint8Array.of(byte));

      assert.equal(await within('onClose', accepted.closed), code);
      const isClose = (f: ServerFrame): boolean => f.opcode === OP.close;
      await until('the close frame', () => framesAfterHandshake(d).some(isClose));
      const close = framesAfterHandshake(d).find(isClose) as ServerFrame;
      assert.equal(close.payload.readUInt16BE(0), code);
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

  test('CLOSE_WAIT_MS is 5 seconds', () => {
    assert.equal(CLOSE_WAIT_MS, 5_000);
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

describe('WebSocket: reads of any size', () => {
  /** Frames with every length form, a fragmented message with a ping inside it, and a close. */
  const SEQUENCE = Buffer.concat([
    clientFrame(OP.text, Buffer.from('hi')),
    clientFrame(OP.binary, Buffer.from([1, 2, 3]), { form: 16 }),
    clientFrame(OP.text, Buffer.from('ab'), { fin: false, form: 64 }),
    clientFrame(OP.ping, Buffer.from('p')),
    clientFrame(OP.continuation, Buffer.from('c€')),
    clientFrame(OP.close, closePayload(1000)),
  ]);

  interface Outcome {
    messages: Message[];
    replies: { opcode: number; payload: string }[];
    code: number;
  }

  /** Feeds `parts` to a fresh connection, one read each, and returns what it did. */
  async function feed(t: TestContext, parts: Uint8Array[]): Promise<Outcome> {
    const d = direct(t);
    const accepted = d.accepted as Accepted;
    for (const part of parts) d.peer.write(part);
    const code = await within('onClose', accepted.closed);
    return {
      messages: [...accepted.messages.items],
      replies: framesAfterHandshake(d).map((f) => ({
        opcode: f.opcode,
        payload: f.payload.toString('hex'),
      })),
      code,
    };
  }

  test('the sequence in one read', async (t) => {
    const outcome = await feed(t, [SEQUENCE]);

    assert.equal(outcome.messages.length, 3);
    assertMessage(outcome.messages[0] as Message, { text: 'hi' }, 'first');
    assertMessage(outcome.messages[1] as Message, { binary: Buffer.from([1, 2, 3]) }, 'second');
    assertMessage(outcome.messages[2] as Message, { text: 'abc€' }, 'third');
    assert.deepEqual(outcome.replies, [
      { opcode: OP.pong, payload: Buffer.from('p').toString('hex') },
      { opcode: OP.close, payload: closePayload(1000).toString('hex') },
    ]);
    assert.equal(outcome.code, 1000);
  });

  test('the sequence split in two at every byte, and one byte per read, does the same', async (t) => {
    const whole = await feed(t, [SEQUENCE]);
    const splits: Uint8Array[][] = [];
    for (let at = 1; at < SEQUENCE.length; at++) {
      splits.push([SEQUENCE.subarray(0, at), SEQUENCE.subarray(at)]);
    }
    splits.push(Array.from(SEQUENCE, (byte) => Uint8Array.of(byte)));

    for (const parts of splits) {
      const outcome = await feed(t, parts);
      const name = `${parts.length} reads, the first of ${parts[0]?.length}`;
      assert.deepEqual(outcome.replies, whole.replies, name);
      assert.equal(outcome.code, whole.code, name);
      assert.equal(outcome.messages.length, whole.messages.length, name);
      whole.messages.forEach((message, i) => {
        assertMessage(outcome.messages[i] as Message, message, `${name}, message ${i}`);
      });
    }
  });

  test('a frame of 400,000 bytes that arrives one byte per read is read in linear time', async (t) => {
    const d = direct(t);
    const accepted = d.accepted as Accepted;
    const payload = bytesOf(400_000);
    const frame = clientFrame(OP.binary, payload);
    const started = performance.now();

    for (let i = 0; i < frame.length - 1; i++) d.peer.write(frame.subarray(i, i + 1));
    await until('every byte but the last to be read', () => d.peer.writableLength === 0);
    const lastStarted = performance.now();
    d.peer.write(frame.subarray(frame.length - 1));
    const message = await accepted.messages.next('the message');
    const lastMs = performance.now() - lastStarted;
    const allMs = performance.now() - started;

    assertMessage(message, { binary: payload }, 'one byte per read');
    // About 0.3 s here; a reader that copies what it gathered on every read takes over 20 s.
    assert.ok(allMs < 5000, `the whole frame took ${Math.round(allMs)} ms`);
    assert.ok(lastMs < 1000, `the last read took ${Math.round(lastMs)} ms`);
  });

  test('empty continuation frames keep no memory', async (t) => {
    const d = direct(t);
    const accepted = d.accepted as Accepted;
    const empty = clientFrame(OP.continuation, new Uint8Array(0), { fin: false });
    const block = Buffer.concat(Array.from({ length: 10_000 }, () => empty));

    d.peer.write(clientFrame(OP.binary, Buffer.from('a'), { fin: false }));
    await until('the first fragment to be read', () => d.peer.writableLength === 0);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 50; i++) d.peer.write(block); // 500,000 empty fragments
    await until('every fragment to be read', () => d.peer.writableLength === 0);
    const grown = process.memoryUsage().heapUsed - before;
    d.peer.write(clientFrame(OP.continuation, Buffer.from('b')));

    assertMessage(await accepted.messages.next('the message'), { binary: Buffer.from('ab') }, 'ab');
    assert.ok(grown < 16 * MiB, `the heap grew by ${grown} bytes`);
  });
});

describe('WebSocket: a peer that does not finish closing, and destroy() (ruled, #44)', () => {
  /** A served connection whose server-side socket the test can see, and a raw client that keeps
   *  its end open when the server ends its own. */
  async function halfOpen(t: TestContext): Promise<{
    served: Served;
    accepted: Accepted;
    socket: Duplex;
    r: Raw;
  }> {
    const sockets: Duplex[] = [];
    const served = await serve(t, { echo: false, beforeAccept: (s) => sockets.push(s) });
    const r = await raw(t, served.port, upgradeRequest(served.port), new Uint8Array(0), true);
    const accepted = await acceptedOf(served);
    return { served, accepted, socket: sockets[0] as Duplex, r };
  }

  /** The socket is destroyed CLOSE_WAIT_MS after the close began, by the clock, not before. */
  function assertDestroyedAfterWait(clock: FakeClock, socket: Duplex): void {
    clock.advanceMs(CLOSE_WAIT_MS - 1);
    assert.equal(socket.destroyed, false, 'not destroyed before the wait is over');
    clock.advanceMs(1);
    assert.equal(socket.destroyed, true, 'destroyed when the wait is over');
    assert.equal(clock.timers(), 0);
  }

  test('close() to a peer that neither reads nor closes: destroyed CLOSE_WAIT_MS later', async (t) => {
    const { served, accepted, socket, r } = await halfOpen(t);
    r.socket.pause();

    accepted.conn.close(4001);

    assert.equal(await within('onClose', accepted.closed), 4001);
    assertDestroyedAfterWait(served.clock, socket);
  });

  test('a breach, to a peer that keeps its end open: destroyed CLOSE_WAIT_MS later', async (t) => {
    const { served, accepted, socket, r } = await halfOpen(t);

    r.socket.write(clientFrame(OP.binary, Buffer.from('A'), { masked: false }));

    assert.equal(await serverCloseCode(r), 1002);
    assert.equal(await within('onClose', accepted.closed), 1002);
    assertDestroyedAfterWait(served.clock, socket);
  });

  test('the peer sends its close but keeps its end open: destroyed CLOSE_WAIT_MS later', async (t) => {
    const { served, accepted, socket, r } = await halfOpen(t);

    r.socket.write(clientFrame(OP.close, closePayload(4000)));

    assert.equal(await within('onClose', accepted.closed), 4000);
    assert.equal(await serverCloseCode(r), 4000);
    assertDestroyedAfterWait(served.clock, socket);
  });

  test('the peer ends its side but does not read what is queued: destroyed CLOSE_WAIT_MS later', async (t) => {
    const { served, accepted, socket, r } = await halfOpen(t);
    r.socket.pause();
    for (let frames = 0; accepted.conn.buffered <= MiB && frames < 1100; frames++) {
      accepted.conn.sendBinary(bytesOf(60_000));
    }

    r.socket.end();

    assert.equal(await within('onClose', accepted.closed), 1006);
    assertDestroyedAfterWait(served.clock, socket);
  });

  test('a close the peer finishes leaves no timer', async (t) => {
    const sockets: Duplex[] = [];
    const served = await serve(t, { beforeAccept: (s) => sockets.push(s) });
    const { ws } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const closed = closeOf(ws);

    accepted.conn.close(4001);
    await closed;
    await until('the server socket to close', () => (sockets[0] as Duplex).closed);

    assert.equal(served.clock.timers(), 0);
  });

  test('destroy() ends the connection at once: onClose gets 1006, the client sees it go', async (t) => {
    const sockets: Duplex[] = [];
    const served = await serve(t, { beforeAccept: (s) => sockets.push(s) });
    const { ws, messages } = await client(t, served.port);
    const accepted = await acceptedOf(served);
    const codes: number[] = [];
    accepted.conn.onClose((code) => codes.push(code));
    const closed = closeOf(ws);

    accepted.conn.destroy();
    accepted.conn.destroy();
    accepted.conn.sendText('after');

    assert.deepEqual(codes, [1006]);
    assert.equal((sockets[0] as Duplex).destroyed, true);
    assert.equal((await closed).code, 1006);
    assert.equal(messages.items.length, 0);
    assert.equal(served.clock.timers(), 0);
  });

  test('destroy() after close() keeps the code and stops the wait', async (t) => {
    const { served, accepted, socket, r } = await halfOpen(t);
    r.socket.pause();

    accepted.conn.close(4003);
    accepted.conn.destroy();

    assert.equal(await within('onClose', accepted.closed), 4003);
    assert.equal(socket.destroyed, true);
    assert.equal(served.clock.timers(), 0);
  });
});

describe('WebSocket: a peer that resets the connection', () => {
  test('after the 101, while the server sends: onClose gets 1006 and nothing is left uncaught', async (t) => {
    const served = await serve(t, { echo: false });
    const r = await raw(t, served.port, upgradeRequest(served.port));
    const accepted = await acceptedOf(served);
    r.socket.pause();
    for (let frames = 0; accepted.conn.buffered <= MiB && frames < 1100; frames++) {
      accepted.conn.sendBinary(bytesOf(60_000));
    }

    r.socket.resetAndDestroy();

    assert.equal(await within('onClose', accepted.closed), 1006);
    await delay(100); // a write error that nobody listened for would surface now
  });

  test('right after a refused request: nothing is left uncaught', async (t) => {
    const served = await serve(t);
    const request = upgradeRequest(served.port, { 'Sec-WebSocket-Key': undefined });

    for (let i = 0; i < 100; i++) {
      const socket = connect({ port: served.port, host: '127.0.0.1' });
      t.after(() => socket.destroy());
      socket.on('error', () => {});
      await within('connect', once(socket, 'connect'));
      socket.write(request);
      socket.resetAndDestroy();
    }
    await delay(300); // the refusals still under way end now

    assert.ok(served.accepted.items.length > 0, 'some requests reached acceptWebSocket');
    assert.ok(served.accepted.items.every((item) => item === null));
  });
});

describe('WebSocket: a listener that throws (ruled, #44)', () => {
  test('the socket is destroyed before the error goes on, so nothing is read from the middle of a frame', async (t) => {
    const d = direct(t);
    const accepted = d.accepted as Accepted;
    accepted.conn.onText((text) => {
      if (text === 'a') throw new Error('listener failed');
    });
    await tick(); // the socket flows: a write of the peer is now read inside that write
    const twoFrames = Buffer.concat([
      clientFrame(OP.text, Buffer.from('a')),
      clientFrame(OP.text, Buffer.from('b')),
    ]);

    assert.throws(() => d.peer.write(twoFrames), /listener failed/);

    assert.equal(d.socket.destroyed, true);
    assert.equal(await within('onClose', accepted.closed), 1006);
    assert.equal(accepted.messages.items.length, 1, 'the frame after it was not read');
  });

  for (const [name, frame, code] of [
    ['a breach', clientFrame(OP.binary, Buffer.from('A'), { masked: false }), 1002],
    ["the peer's close", clientFrame(OP.close, closePayload(4000)), 4000],
  ] as const) {
    test(`an onClose listener that throws on ${name}: the socket is destroyed, the code kept`, async (t) => {
      const d = direct(t);
      const accepted = d.accepted as Accepted;
      accepted.conn.onClose(() => {
        throw new Error('listener failed');
      });
      await tick();

      assert.throws(() => d.peer.write(frame), /listener failed/);

      assert.equal(d.socket.destroyed, true);
      assert.equal(await within('onClose', accepted.closed), code);
    });
  }

  test('an onText and an onClose listener that both throw: the socket is still destroyed', async (t) => {
    const d = direct(t);
    const accepted = d.accepted as Accepted;
    accepted.conn.onText(() => {
      throw new Error('text listener failed');
    });
    accepted.conn.onClose(() => {
      throw new Error('close listener failed');
    });
    await tick();

    assert.throws(() => d.peer.write(clientFrame(OP.text, Buffer.from('a'))), /listener failed/);

    assert.equal(d.socket.destroyed, true);
    assert.equal(await within('onClose', accepted.closed), 1006);
  });

  test('destroy() with an onClose listener that throws: the socket is destroyed all the same', async (t) => {
    const d = direct(t);
    const accepted = d.accepted as Accepted;
    accepted.conn.onClose(() => {
      throw new Error('close listener failed');
    });

    assert.throws(() => accepted.conn.destroy(), /close listener failed/);

    assert.equal(d.socket.destroyed, true);
    assert.equal(await within('onClose', accepted.closed), 1006);
  });
});
