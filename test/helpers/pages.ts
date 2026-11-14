/**
 * The pages of S2 8.2 (task 17) under test: `createPages` behind a real HTTP listener on 127.0.0.1
 * (port 0) of `testPlatform` (fake clock, real sockets), with a fake terminal hub over in-memory
 * terminals and a fake action handler, and `ws` clients that do the handshake of S2 8.2.2.
 */
import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { connect } from 'node:net';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import type { Platform } from '../../src/platform/types.ts';
import type { Store } from '../../src/store/store.ts';
import {
  createTokens,
  ensureSecret,
  isNonce,
  pageProof,
  raiseAlarm,
} from '../../src/window/auth.ts';
import type { Tokens } from '../../src/window/auth.ts';
import type { KeeperExit } from '../../src/window/frames.ts';
import type {
  ActionHandler,
  PageInfo,
  StreamSink,
  TerminalHub,
  TerminalInfo,
} from '../../src/window/hub.ts';
import { createPages } from '../../src/window/pages.ts';
import type { PageState, Pages, PagesDeps } from '../../src/window/pages.ts';
import type {
  ActMessage,
  ListMessage,
  ResultMessage,
  ServerMessage,
  ThemePayload,
  WelcomeMessage,
} from '../../src/window/protocol.ts';
import { testDeck } from './deck.ts';
import { BOOT_A, T0 } from './platform.ts';
import type { FakeClock } from './platform.ts';

// ---------------------------------------------------------------------------------------------
// The fake hub

export type HubCall =
  | { kind: 'attach'; term: string }
  | { kind: 'detach'; term: string }
  | { kind: 'input'; term: string; data: Uint8Array }
  | { kind: 'resize'; term: string; cols: number; rows: number }
  | { kind: 'close'; term: string }
  | { kind: 'setTheme'; theme: ThemePayload };

export interface FakeHub extends TerminalHub {
  /** Every call, in order. */
  calls: HubCall[];
  /** Adds a running terminal (80 × 24, its screen `screen-<id>`), or changes one. */
  add(id: string, info?: Partial<TerminalInfo>): TerminalInfo;
  /** The screen a later `attach` gives in its snapshot. */
  setScreen(id: string, data: string): void;
  /**
   * Snapshots go out on a later turn of the event loop after `attach` (as the registry's do);
   * after holdSnapshots() only when releaseSnapshots() is called, in attach order.
   */
  holdSnapshots(): void;
  releaseSnapshots(): void;
  /** What `input` answers for the terminal from now on (default 'ok'). */
  setInputAnswer(id: string, answer: 'ok' | 'full' | 'ended' | 'unknown'): void;
  /** The sinks attached to a terminal now (detached ones are gone). */
  sinks(id: string): readonly StreamSink[];
  // A record to every attached sink, as the registry forwards one: to a sink whose snapshot has
  // not gone out yet, after it.
  output(id: string, bytes: Uint8Array | string): void;
  size(id: string, cols: number, rows: number): void;
  exit(id: string, exit: KeeperExit, lost: boolean): void;
  notice(id: string, kind: 'gap' | 'newer-keeper' | 'input-full', text: string): void;
}

function terminalInfo(id: string, partial: Partial<TerminalInfo>): TerminalInfo {
  return {
    id,
    slot: null,
    state: 'running',
    expectedSessionId: '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d',
    sessionId: '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d',
    kind: 'resume',
    label: null,
    dir: '/work',
    program: { pid: 4242, procStart: 1 },
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...partial,
  };
}

/** One sink of the fake hub: its records wait until its snapshot went out. */
interface FakeAttached {
  sink: StreamSink;
  snapped: boolean;
  waiting: (() => void)[];
}

export function fakeHub(): FakeHub {
  const calls: HubCall[] = [];
  const terminals = new Map<
    string,
    {
      info: TerminalInfo;
      screen: string;
      attached: FakeAttached[];
      answer: 'ok' | 'full' | 'ended' | 'unknown';
    }
  >();
  const listeners = new Set<() => void>();
  let holding = false;
  const held: (() => void)[] = [];
  const each = (id: string, call: (sink: StreamSink) => void): void => {
    for (const entry of [...(terminals.get(id)?.attached ?? [])]) {
      if (entry.snapped) call(entry.sink);
      else entry.waiting.push(() => call(entry.sink));
    }
  };
  return {
    calls,
    add(id, info = {}) {
      const existing = terminals.get(id);
      const merged = terminalInfo(id, { ...existing?.info, ...info });
      terminals.set(id, {
        info: merged,
        screen: existing?.screen ?? `screen-${id}`,
        attached: existing?.attached ?? [],
        answer: existing?.answer ?? 'ok',
      });
      for (const listener of listeners) listener();
      return merged;
    },
    setScreen(id, data) {
      const terminal = terminals.get(id);
      assert.ok(terminal, id);
      terminal.screen = data;
    },
    holdSnapshots() {
      holding = true;
    },
    releaseSnapshots() {
      holding = false;
      for (const deliver of held.splice(0)) deliver();
    },
    setInputAnswer(id, answer) {
      const terminal = terminals.get(id);
      assert.ok(terminal, id);
      terminal.answer = answer;
    },
    sinks: (id) => (terminals.get(id)?.attached ?? []).map((entry) => entry.sink),
    output: (id, bytes) => {
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      each(id, (sink) => sink.output(data));
    },
    size: (id, cols, rows) => {
      const terminal = terminals.get(id);
      if (terminal !== undefined) terminal.info = { ...terminal.info, cols, rows };
      each(id, (sink) => sink.size(cols, rows));
    },
    exit: (id, exit, lost) => {
      const terminal = terminals.get(id);
      if (terminal !== undefined) {
        terminal.info = { ...terminal.info, state: lost ? 'lost' : 'ended', exit };
      }
      each(id, (sink) => sink.exit(exit, lost));
    },
    notice: (id, kind, text) => each(id, (sink) => sink.notice(kind, text)),
    list: () => [...terminals.values()].map((terminal) => terminal.info),
    attach(termId, sink) {
      calls.push({ kind: 'attach', term: termId });
      const terminal = terminals.get(termId);
      if (terminal === undefined) return null;
      const entry: FakeAttached = { sink, snapped: false, waiting: [] };
      terminal.attached.push(entry);
      // The screen at the attach point, given later (the registry's snapshot is asynchronous);
      // a terminal that had ended by then gives its exit right after it (ruling-hub-attach,
      // amended).
      const { cols, rows, exit, state } = terminal.info;
      const screen = terminal.screen;
      const deliver = (): void => {
        if (!terminal.attached.includes(entry)) return; // detached first: never called
        entry.snapped = true;
        sink.snapshot(cols, rows, screen);
        if (exit !== null) sink.exit(exit, state === 'lost');
        for (const call of entry.waiting.splice(0)) call();
      };
      if (holding) held.push(deliver);
      else setImmediate(deliver);
      return {
        detach: () => {
          calls.push({ kind: 'detach', term: termId });
          const at = terminal.attached.indexOf(entry);
          if (at !== -1) terminal.attached.splice(at, 1);
        },
      };
    },
    input(termId, data) {
      calls.push({ kind: 'input', term: termId, data: Uint8Array.from(data) });
      return terminals.get(termId)?.answer ?? 'unknown';
    },
    resize(termId, cols, rows) {
      calls.push({ kind: 'resize', term: termId, cols, rows });
    },
    close(termId) {
      calls.push({ kind: 'close', term: termId });
      return terminals.has(termId) ? 'ok' : 'unknown';
    },
    setTheme(theme) {
      calls.push({ kind: 'setTheme', theme: { ...theme } });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The fake action handler

export interface FakeActions extends ActionHandler {
  calls: { page: PageInfo; action: ActMessage }[];
}

/** Answers every action with `answer` (default: ok, one line naming the kind). */
export function fakeActions(
  answer?: (page: PageInfo, action: ActMessage) => Promise<ResultMessage>,
): FakeActions {
  const calls: FakeActions['calls'] = [];
  return {
    calls,
    act(page, action) {
      calls.push({ page: { ...page }, action });
      if (answer !== undefined) return answer(page, action);
      return Promise.resolve({
        t: 'result',
        id: action.id,
        ok: true,
        lines: [`did ${action.kind}`],
        error: null,
        sessionId: null,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The pages behind a listener

export interface PagesFixture {
  pages: Pages;
  port: number;
  /** `http://127.0.0.1:<port>`, the Origin a page sends. */
  origin: string;
  clock: FakeClock;
  store: Store;
  tokens: Tokens;
  secret: Uint8Array;
  hub: FakeHub;
  actions: FakeActions;
  /** Every line pages logged. */
  logs: string[];
  /** Every PageState listFor was called with (the object itself). */
  listCalls: PageState[];
  /** Part of every list the default listFor builds: change it to change the lists. */
  listData: { dirs: string[] };
  welcome: Omit<WelcomeMessage, 't' | 'proof' | 'key'>;
  /** How many requests reached the listener's request handler and its upgrade handler. */
  served: { requests: number; upgrades: number };
}

export const SERVER_ID = '00112233445566ff';

export async function startPages(
  t: TestContext,
  options: {
    listFor?: PagesDeps['listFor'];
    actions?: FakeActions;
    /** What `port()` tells pages instead of the bound port (to check the rules of port 80). */
    portSeen?: number;
    /** Replaces the deck's store (e.g. one whose transaction throws). */
    store?: (store: Store) => Store;
    /** Replaces the platform pages is given (the test platform's otherwise). */
    platform?: (platform: Platform) => Platform;
    /** PagesDeps.starting (task 23). */
    starting?: () => boolean;
  } = {},
): Promise<PagesFixture> {
  const d = testDeck(t);
  const { platform, clock } = d;
  const store = options.store === undefined ? d.deck.store : options.store(d.deck.store);
  const tokens = createTokens(clock, platform.randomBytes, () => {
    raiseAlarm(store, clock.nowNs());
  });
  t.after(() => {
    tokens.forgetAll();
  });
  const hub = fakeHub();
  const actions = options.actions ?? fakeActions();
  const logs: string[] = [];
  const listCalls: PageState[] = [];
  const listData = { dirs: ['/work'] };
  const welcome: Omit<WelcomeMessage, 't' | 'proof' | 'key'> = {
    protocol: 1,
    assetVersion: 'build123',
    serverId: SERVER_ID,
    bootId: BOOT_A,
    version: '0.1.0',
    keepAlive: { mode: 'off', state: 'off', since: null, error: null },
    nowNs: String(T0),
  };
  let port = 0;
  const served = { requests: 0, upgrades: 0 };
  const pages = createPages({
    platform: options.platform === undefined ? platform : options.platform(platform),
    port: () => options.portSeen ?? port,
    store,
    tokens,
    hub,
    actions,
    welcome: () => ({ ...welcome }),
    listFor:
      options.listFor ??
      ((page) => {
        listCalls.push(page);
        return defaultList(hub, page, listData.dirs, clock.nowNs());
      }),
    log: (line) => {
      logs.push(line);
    },
    ...(options.starting === undefined ? {} : { starting: options.starting }),
  });
  const listener = await platform.net.listenHttp(
    { host: '127.0.0.1', port: 0 },
    {
      request: (_req, res) => {
        served.requests++;
        res.statusCode = 404;
        res.end();
      },
      upgrade: (req, socket, head) => {
        served.upgrades++;
        pages.upgrade(req, socket, head);
      },
    },
  );
  port = listener.port;
  t.after(() => listener.close());
  const secret = ensureSecret(d.deck.store, platform.randomBytes);
  return {
    pages,
    port,
    origin: `http://127.0.0.1:${port}`,
    clock,
    store,
    tokens,
    secret,
    hub,
    actions,
    logs,
    listCalls,
    listData,
    welcome,
    served,
  };
}

export function defaultList(
  hub: TerminalHub,
  page: PageState,
  dirs: string[],
  nowNs: bigint,
): ListMessage {
  return {
    t: 'list',
    nowNs: String(nowNs),
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    sections: [],
    doneHidden: 0,
    banner: null,
    terminals: hub.list().map((info) => ({
      id: info.id,
      slot: info.slot,
      sessionId: info.sessionId,
      state: info.state,
      notReported: info.notReported,
      cols: info.cols,
      rows: info.rows,
      ownsSize: true, // pages replaces it
    })),
    selected: null,
    dirs: [...dirs, `filter:${page.view.filter}`],
  };
}

// ---------------------------------------------------------------------------------------------
// Clients

export type Received = { text: ServerMessage } | { binary: Uint8Array };

export interface PageClient {
  ws: WebSocket;
  /** The next message, in arrival order, text (parsed) or binary. */
  next(what?: string): Promise<Received>;
  /** The next message, which must be text. */
  nextText(what?: string): Promise<ServerMessage>;
  /** The next message, which must be an output frame: its channel and bytes. */
  nextOutput(what?: string): Promise<{ channel: number; bytes: Uint8Array }>;
  /** Messages that arrived and were not taken by next(). */
  pending(): readonly Received[];
  /** Every message that arrived, taken or not. */
  all: Received[];
  send(message: unknown): void;
  sendRaw(text: string): void;
  /** The close code and reason once the connection closed. */
  closed: Promise<{ code: number; reason: string }>;
  /** Whether it closed already. */
  isClosed(): boolean;
}

/** `promise`, or a failure naming `what` after 10 s (this machine is shared and loaded). */
export async function within<T>(what: string, promise: Promise<T>): Promise<T> {
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

export async function until(what: string, condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}

/** A `ws` client of /ws; `origin` null sends no Origin, `host` replaces the Host header. */
export async function connectPage(
  t: TestContext,
  f: PagesFixture,
  options: { origin?: string | null; host?: string; path?: string } = {},
): Promise<PageClient> {
  const headers: Record<string, string> = {};
  if (options.host !== undefined) headers['Host'] = options.host;
  const origin = options.origin === undefined ? f.origin : options.origin;
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}${options.path ?? '/ws'}`, {
    headers,
    ...(origin === null ? {} : { origin }),
  });
  ws.binaryType = 'nodebuffer';
  t.after(() => {
    ws.terminate();
  });
  const all: Received[] = [];
  const items: Received[] = [];
  const waiters: ((value: Received) => void)[] = [];
  let closedNow = false;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      closedNow = true;
      resolve({ code, reason: reason.toString() });
    });
  });
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    const buffer = data as Buffer;
    const item: Received = isBinary
      ? { binary: new Uint8Array(buffer) }
      : { text: JSON.parse(buffer.toString('utf8')) as ServerMessage };
    all.push(item);
    const waiter = waiters.shift();
    if (waiter === undefined) items.push(item);
    else waiter(item);
  });
  await within(
    'the connection',
    new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`refused with ${res.statusCode}`));
      });
      ws.once('close', () => reject(new Error('closed before open')));
    }),
  );
  const next = async (what = 'a message'): Promise<Received> => {
    const item = items.shift();
    if (item !== undefined) return item;
    return await within(
      what,
      new Promise<Received>((resolve, reject) => {
        waiters.push(resolve);
        void closed.then(({ code }) => reject(new Error(`closed (${code}) waiting for ${what}`)));
      }),
    );
  };
  return {
    ws,
    next,
    async nextText(what = 'a text message') {
      const item = await next(what);
      assert.ok('text' in item, `${what}: got a binary message`);
      return item.text;
    },
    async nextOutput(what = 'an output frame') {
      const item = await next(what);
      assert.ok('binary' in item, `${what}: got ${JSON.stringify(item)}`);
      const view = new DataView(item.binary.buffer, item.binary.byteOffset, item.binary.length);
      assert.equal(view.getUint8(0), 1, 'an output frame starts with byte 1');
      return { channel: view.getUint32(1), bytes: item.binary.subarray(5) };
    },
    pending: () => items,
    all,
    send: (message) => ws.send(JSON.stringify(message)),
    sendRaw: (text) => ws.send(text),
    closed,
    isClosed: () => closedNow,
  };
}

/** The answer to an upgrade that was refused: its status and headers. */
export async function refusedUpgrade(
  t: TestContext,
  f: PagesFixture,
  options: { origin?: string | null; host?: string; path?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const headers: Record<string, string> = {};
  if (options.host !== undefined) headers['Host'] = options.host;
  const origin = options.origin === undefined ? f.origin : options.origin;
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}${options.path ?? '/ws'}`, {
    headers,
    ...(origin === null ? {} : { origin }),
  });
  t.after(() => {
    ws.terminate();
  });
  ws.on('error', () => {});
  return await within(
    'the refusal',
    new Promise((resolve, reject) => {
      ws.once('open', () => reject(new Error('the upgrade was accepted')));
      ws.once('unexpected-response', (req, res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
        res.resume();
        req.destroy();
      });
    }),
  );
}

/** A raw HTTP request on the port; resolves to the whole answer once the server closed. */
export async function rawRequest(t: TestContext, port: number, request: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  t.after(() => {
    socket.destroy();
  });
  let received = '';
  socket.setEncoding('latin1');
  socket.on('data', (chunk: string) => {
    received += chunk;
  });
  socket.on('error', () => {});
  socket.write(request);
  await within('the answer', new Promise((resolve) => socket.once('close', resolve)));
  return received;
}

// ---------------------------------------------------------------------------------------------
// The handshake

/** 32 bytes counting up from `seed`, in base64url: a client nonce. */
export function nonce(seed: number): string {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff)).toString(
    'base64url',
  );
}

let nextSeed = 0x40;

/** A fresh client nonce for each call. */
export function freshNonce(): string {
  nextSeed = (nextSeed + 37) & 0xff;
  return nonce(nextSeed);
}

/** Waits for the challenge; returns its nonce. */
export async function challengeOf(client: PageClient): Promise<string> {
  const challenge = await client.nextText('the challenge');
  assert.equal(challenge.t, 'challenge');
  assert.ok(challenge.t === 'challenge' && isNonce(challenge.nonce), 'a nonce');
  return challenge.t === 'challenge' ? challenge.nonce : '';
}

export interface Opened {
  client: PageClient;
  welcome: WelcomeMessage;
  sN: string;
  cN: string;
}

/** A page that has done the handshake in mode key and sent `start` (focused unless told). */
export async function openPage(
  t: TestContext,
  f: PagesFixture,
  options: { focused?: boolean; windowId?: string; theme?: ThemePayload; view?: boolean } = {},
): Promise<Opened> {
  const client = await connectPage(t, f);
  const sN = await challengeOf(client);
  const cN = freshNonce();
  client.send({
    t: 'hello',
    protocol: 1,
    mode: 'key',
    nonce: cN,
    proof: pageProof(f.secret, 'key', sN, cN, f.origin),
  });
  const welcome = await client.nextText('the welcome');
  assert.equal(welcome.t, 'welcome');
  client.send({
    t: 'start',
    assetVersion: 'build123',
    windowId: options.windowId ?? windowId(),
    focused: options.focused ?? true,
    theme: options.theme ?? { fg: '#ffffff', bg: '#000000' },
  });
  if (options.view === true) {
    client.send({ t: 'view', filter: '', unfolded: [], showDone: false, selected: null });
    const list = await client.nextText('the first list');
    assert.equal(list.t, 'list');
  }
  // A ping round trip: `start` was handled before the test goes on.
  assert.deepEqual(await roundTrip(client), [], 'nothing but the pong after start');
  return { client, welcome: welcome as WelcomeMessage, sN, cN };
}

let windows = 0;

/** A fresh window id (16 lower-case hex). */
export function windowId(): string {
  return (++windows).toString(16).padStart(16, '0');
}

let pings = 1000;

/**
 * A ping and its pong: everything the server sent before the pong is in `pending()` afterwards
 * (the pong itself is taken). Fails on any message that is not the pong only if it is the pong
 * of another number.
 */
export async function roundTrip(client: PageClient): Promise<Received[]> {
  const n = ++pings;
  client.send({ t: 'ping', n });
  const before: Received[] = [];
  for (;;) {
    const item = await client.next(`the pong ${n}`);
    if ('text' in item && item.text.t === 'pong' && item.text.n === n) break;
    before.push(item);
  }
  return before;
}

/** The secret `key` of a welcome in mode launch, opened with the token and both nonces. */
export function openKey(key: string, token: Uint8Array, sN: string, cN: string): Uint8Array {
  const sealed = Buffer.from(key, 'base64url');
  const wrapping = new Uint8Array(
    hkdfSync(
      'sha256',
      token,
      Buffer.from(sN + cN, 'utf8'),
      Buffer.from('skydeck key 1', 'utf8'),
      32,
    ),
  );
  const decipher = createDecipheriv('aes-256-gcm', wrapping, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return new Uint8Array(
    Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]),
  );
}
