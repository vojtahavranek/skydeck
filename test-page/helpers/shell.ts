// What the page tests of the window's page share (plan tasks 26–29): its address, what the page
// did with its WebSockets (recorded by an init script, kept across reloads), the state it shows,
// and stand-in servers — the page's real files on a port of the test's own, with a WebSocket the
// test scripts (S2 17.4: "a stand-in server").
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import type { Browser, CDPSession, Page } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';

import { httpHandler, loadAssets, securityHeaders } from '../../src/window/assets.ts';
import {
  isNonce,
  keyProofMatches,
  pageProof,
  serverProof,
  wrapSecret,
} from '../../src/window/auth.ts';
import { controlClient } from '../../src/window/client.ts';
import { S1, S2, S3, testPlatform } from '../../test/helpers/platform.ts';
import { startTestServer } from '../../test/helpers/window.ts';
import type {
  ServerSandboxOptions,
  StartedServer,
  StartOptions,
} from '../../test/helpers/window.ts';
import { newPage } from './browser.ts';

/** How long a page test waits for something the page or a real server does (a loaded machine). */
export const PAGE_WAIT_MS = 20_000;

/** The page's address on `port`; with `token`, the launch address of S2 5.1 (`#t=<token>`). */
export function pageUrl(port: number, token?: string): string {
  return `http://127.0.0.1:${port}/${token === undefined ? '' : `#t=${token}`}`;
}

/** One thing the page did, as the recorder saw it. `s` numbers the page's WebSockets. */
export interface Logged {
  e: 'ws' | 'in' | 'out' | 'close' | 'unload' | 'mark';
  s?: number;
  /** `ws`: the page's address when the socket was made. */
  href?: string;
  /** `in`, `out`: the message's type (`binary` for a binary frame). */
  t?: string;
  /** `out` hello: its mode; `in`, `out` attach, snap: the terminal. */
  mode?: string;
  term?: string;
  /** `close`: the close code. */
  code?: number;
  /** `mark`: the test's name for the moment. */
  name?: string;
}

/**
 * An init script (page.addInitScript) that records in sessionStorage, which a reload keeps, every
 * WebSocket the page makes and what goes over it but pings and pongs, and the page's unload.
 */
export const RECORDER = `(() => {
  const KEY = 'skydeck-test-log';
  const log = (entry) => {
    const all = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    all.push(entry);
    sessionStorage.setItem(KEY, JSON.stringify(all));
  };
  const typeOf = (data) => {
    if (typeof data !== 'string') return { t: 'binary' };
    try {
      const m = JSON.parse(data);
      return { t: m.t, ...(m.mode === undefined ? {} : { mode: m.mode }), ...(typeof m.term === 'string' ? { term: m.term } : {}) };
    } catch {
      return { t: 'not JSON' };
    }
  };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      const s = Number(sessionStorage.getItem(KEY + '-n') ?? '0') + 1;
      sessionStorage.setItem(KEY + '-n', String(s));
      log({ e: 'ws', s, href: location.href });
      super(url, protocols);
      this.addEventListener('message', (m) => {
        const what = typeOf(m.data);
        if (what.t !== 'pong') log({ e: 'in', s, ...what });
      });
      this.addEventListener('close', (c) => log({ e: 'close', s, code: c.code }));
      this.recorded = s;
    }
    send(data) {
      const what = typeOf(data);
      if (what.t !== 'ping') log({ e: 'out', s: this.recorded, ...what });
      super.send(data);
    }
  };
  addEventListener('pagehide', () => log({ e: 'unload' }));
})();`;

/**
 * `page.evaluate(fn, arg)`, made again on the next document when it meets a navigation (the page
 * reloading itself: "Execution context was destroyed"), at most 50 times, 100 ms apart. Every
 * helper here that reads the page goes through it, so that a test may poll across a reload.
 */
export async function readPage<A, R>(page: Page, fn: (arg: A) => R, arg: A): Promise<R> {
  // Playwright's PageFunction unboxes its argument's type; these reads pass plain values.
  const evaluate = page.evaluate.bind(page) as unknown as (f: (a: A) => R, a: A) => Promise<R>;
  for (let attempt = 0; ; attempt++) {
    try {
      return await evaluate(fn, arg);
    } catch (error) {
      if (attempt >= 50 || !/context was destroyed|navigat/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** What the recorder logged so far (across reloads). */
export async function logOf(page: Page): Promise<Logged[]> {
  return readPage(
    page,
    () => JSON.parse(sessionStorage.getItem('skydeck-test-log') ?? '[]') as Logged[],
    null,
  );
}

/** Puts a mark into the log, so that a test can look at what came after it. */
export async function mark(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => {
    const all = JSON.parse(sessionStorage.getItem('skydeck-test-log') ?? '[]') as unknown[];
    all.push({ e: 'mark', name });
    sessionStorage.setItem('skydeck-test-log', JSON.stringify(all));
  }, name);
}

/** The log after the mark `name`. */
export function after(log: Logged[], name: string): Logged[] {
  const at = log.findIndex((entry) => entry.e === 'mark' && entry.name === name);
  assert.ok(at !== -1, `the mark ${name}`);
  return log.slice(at + 1);
}

/** The state of the page's connection, as `<html data-connection>` says. */
export type ConnectionState = 'connecting' | 'open' | 'lost' | 'fatal';

/** Waits until the page's connection is in `state`. */
export async function connection(
  page: Page,
  state: ConnectionState,
  timeout = PAGE_WAIT_MS,
): Promise<void> {
  await page.waitForSelector(`html[data-connection="${state}"]`, { state: 'attached', timeout });
}

/** The text of the element `selector`, '' when it is hidden or absent. */
export async function shownText(page: Page, selector: string): Promise<string> {
  return readPage(
    page,
    (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement) || element.closest('[hidden]') !== null) return '';
      return element.textContent ?? '';
    },
    selector,
  );
}

/** Waits until the element `selector` is shown and its text matches `pattern`. */
export async function showsText(
  page: Page,
  selector: string,
  pattern: RegExp,
  timeout = PAGE_WAIT_MS,
): Promise<string> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const text = await shownText(page, selector);
    if (pattern.test(text)) return text;
    if (performance.now() > deadline) {
      assert.fail(`${selector} shows ${JSON.stringify(text)}, not ${String(pattern)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Everything that went wrong in the page: console errors, uncaught errors, failed loads. */
export function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    // A WebSocket the page closes itself, or a navigation away, is no failure of a load.
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
      problems.push(`requestfailed: ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`);
  });
  return problems;
}

/** The base of the page's asset URLs (`/assets/<build>/web/`), read from the page itself. */
export async function assetBase(page: Page): Promise<string> {
  const base = await page.evaluate(() => {
    const script = document.querySelector('script[type="module"]');
    return script instanceof HTMLScriptElement ? script.src.replace(/app\.js$/, '') : '';
  });
  assert.match(base, /\/assets\/[^/]+\/web\/$/, 'the page loads its app.js from its assets');
  return base;
}

/** Stores an HMAC key made from `secret` as the page's key (web/auth.js), as a launch would. */
export async function storeKey(page: Page, secret: Uint8Array): Promise<void> {
  const base = await assetBase(page);
  await page.evaluate(
    async ({ base, bytes }) => {
      const auth = (await import(`${base}auth.js`)) as {
        hmacKey(bytes: Uint8Array): Promise<CryptoKey>;
        storeKey(key: CryptoKey): Promise<void>;
      };
      await auth.storeKey(await auth.hmacKey(Uint8Array.from(bytes)));
    },
    { base, bytes: [...secret] },
  );
}

/** Whether the key the page stored signs as an HMAC-SHA256 key of `secret` does. */
export async function storedKeyIs(
  page: Page,
  signature: (data: string) => string,
): Promise<{
  signs: boolean;
  extractable: boolean | null;
  exported: boolean;
}> {
  const base = await assetBase(page);
  const data = 'a message for the stored key';
  const result = await page.evaluate(
    async ({ base, data }) => {
      const auth = (await import(`${base}auth.js`)) as {
        loadKey(): Promise<CryptoKey | null>;
        encode(bytes: Uint8Array): string;
      };
      const key = await auth.loadKey();
      if (key === null) return null;
      const signed = auth.encode(
        new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))),
      );
      const exported = await crypto.subtle.exportKey('raw', key).then(
        () => true,
        () => false,
      );
      return { signed, extractable: key.extractable, exported };
    },
    { base, data },
  );
  if (result === null) return { signs: false, extractable: null, exported: false };
  return {
    signs: result.signed === signature(data),
    extractable: result.extractable,
    exported: result.exported,
  };
}

// ---------------------------------------------------------------------------------------------
// Stand-in servers

/** One WebSocket the stand-in accepted: what the page sent on it, in order. */
export interface StandinConnection {
  ws: WebSocket;
  /** The stand-in's build: what its page's asset version is. */
  build: string;
  origin: string;
  received: string[];
  closed: Promise<number>;
  /** Sends the challenge with a fresh canonical nonce; returns it. */
  challenge(): string;
  send(message: unknown): void;
}

export interface StandinOptions {
  /** `/` is the real index.html with `inject` put before `</head>`, or `html` instead. */
  index?: { inject: string } | { html: string };
  /** More routes: a path and what it answers. */
  routes?: Record<string, { type: string; body: string }>;
  /** What the stand-in does with each WebSocket (default: nothing, not even a challenge). */
  socket?: (conn: StandinConnection) => void;
  /** The first this many upgrades are answered 503 (as a server that starts or stops). */
  refuse?: number;
  /** A port of the test's choice (default: the system picks). */
  port?: number;
  /** Files of web/ served in place of the checkout's (a name and its text), e.g. a test's view. */
  web?: Record<string, string>;
}

export interface Standin {
  port: number;
  /** The build of the page's files it serves (the page's asset version). */
  build: string;
  url: string;
  connections: StandinConnection[];
  /** Upgrade requests seen, the refused ones included. */
  upgrades(): number;
  close(): Promise<void>;
}

let nonceSeed = 0;

/** A canonical nonce that differs at each call. */
function standinNonce(): string {
  nonceSeed = (nonceSeed + 1) & 0xff;
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, i) => (nonceSeed * 7 + i) & 0xff),
  ).toString('base64url');
}

/**
 * A server on 127.0.0.1 that is not skydeck's: the page's real files (task 14's loadAssets and
 * httpHandler, the same policy headers) with its own `/` and WebSocket. Closed in `t.after`.
 */
export async function standinServer(
  t: TestContext,
  options: StandinOptions = {},
): Promise<Standin> {
  const { platform, sandbox: s } = testPlatform(t);
  let appRoot = platform.appRoot;
  if (options.web !== undefined) {
    // An app root of the sandbox: the checkout's bin, src and vendor, a copy of its web/ with the
    // test's files in it.
    appRoot = join(s.root, 'app');
    mkdirSync(appRoot);
    for (const dir of ['bin', 'src', 'vendor']) {
      symlinkSync(join(platform.appRoot, dir), join(appRoot, dir));
    }
    cpSync(join(platform.appRoot, 'web'), join(appRoot, 'web'), { recursive: true });
    for (const [name, text] of Object.entries(options.web)) {
      writeFileSync(join(appRoot, 'web', name), text);
    }
  }
  const assets = loadAssets(platform.files, appRoot);
  const index = assets.get('/');
  assert.ok(index !== null, 'web/index.html is served');
  const page = Buffer.from(index.body).toString('utf8');
  let bound = 0;
  const files = httpHandler(assets, () => bound);
  const wss = new WebSocketServer({ noServer: true });
  const connections: StandinConnection[] = [];
  let upgrades = 0;
  const listener = await platform.net.listenHttp(
    { host: '127.0.0.1', port: options.port ?? 0 },
    {
      request(req, res) {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const route = options.routes?.[path];
        const html =
          path !== '/' || options.index === undefined
            ? null
            : 'html' in options.index
              ? options.index.html
              : page.replace('</head>', `${options.index.inject}</head>`);
        if (route === undefined && html === null) {
          files(req, res);
          return;
        }
        const body = Buffer.from(route?.body ?? html ?? '');
        res.writeHead(200, {
          ...securityHeaders(bound),
          'Content-Type': route?.type ?? 'text/html; charset=utf-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
        });
        res.end(body);
      },
      upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
        upgrades++;
        if (upgrades <= (options.refuse ?? 0)) {
          socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const received: string[] = [];
          const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
          ws.on('message', (data, isBinary) => {
            received.push(isBinary ? '<binary>' : String(data));
          });
          ws.on('error', () => {});
          const conn: StandinConnection = {
            ws,
            build: assets.build,
            origin: req.headers.origin ?? '',
            received,
            closed,
            challenge() {
              const nonce = standinNonce();
              ws.send(JSON.stringify({ t: 'challenge', protocol: 1, nonce }));
              return nonce;
            },
            send: (message) => ws.send(JSON.stringify(message)),
          };
          connections.push(conn);
          options.socket?.(conn);
        });
      },
    },
  );
  bound = listener.port;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const conn of connections) conn.ws.terminate();
    wss.close();
    await listener.close();
  };
  t.after(close);
  return {
    port: bound,
    build: assets.build,
    url: pageUrl(bound),
    connections,
    upgrades: () => upgrades,
    close,
  };
}

/** A welcome's fields but the proof and the key. */
export function welcomeFields(more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: 'welcome',
    protocol: 1,
    assetVersion: 'stand-in',
    serverId: '0123456789abcdef',
    bootId: 'stand-in-boot',
    version: '0.0.0',
    keepAlive: { mode: 'off', state: 'off', since: null, error: null },
    nowNs: '1794474000000000000',
    ...more,
  };
}

/** A stand-in's socket: a challenge, and a welcome whose proof is not the server's (S2 8.2.2 step 5). */
export function wrongProof(conn: StandinConnection): void {
  conn.challenge();
  conn.ws.once('message', () => {
    conn.send(welcomeFields({ proof: 'A'.repeat(43), key: 'A'.repeat(80) }));
  });
}

/**
 * A stand-in's socket that knows the secret and answers as the server does: the challenge, the
 * proof of mode key — or of mode launch with `token`, the secret wrapped for the page —, then
 * pongs (unless `pings` is false). `before(n)` may end the n-th connection instead: 'close-1013'
 * at its hello, 'drop' right after the challenge, 'drop-after-hello' once the hello came.
 */
export function honest(
  secret: Uint8Array,
  options: {
    /** The welcome's asset version; default the stand-in's own build. */
    assetVersion?: string;
    token?: Uint8Array;
    /** Whether pings are answered (asked at each ping); default yes. */
    pings?: boolean | (() => boolean);
    before?: (n: number) => 'close-1013' | 'drop' | 'drop-after-hello' | null;
    /** Every message after `start` but pings, with the connection's number (1, 2, …). */
    open?: (conn: StandinConnection, message: Record<string, unknown>, n: number) => void;
    /** The welcome's server id, or one per connection (1, 2, …). */
    serverId?: string | ((n: number) => string);
    bootId?: string;
  },
): (conn: StandinConnection) => void {
  let n = 0;
  return (conn) => {
    const which = ++n;
    const sN = conn.challenge();
    const plan = options.before?.(which) ?? null;
    if (plan === 'drop') {
      setTimeout(() => conn.ws.terminate(), 50);
      return;
    }
    let phase: 'hello' | 'start' | 'open' = 'hello';
    conn.ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (phase === 'hello') {
        if (plan === 'close-1013') {
          conn.ws.close(1013);
          return;
        }
        if (plan === 'drop-after-hello') {
          conn.ws.terminate();
          return;
        }
        const cN = message['nonce'];
        const proof = message['proof'];
        const mode = message['mode'];
        const token = options.token;
        if (typeof cN !== 'string' || !isNonce(cN) || typeof proof !== 'string') {
          conn.ws.close(4001);
          return;
        }
        const proven =
          mode === 'key'
            ? keyProofMatches(secret, proof, sN, cN, conn.origin)
            : mode === 'launch' &&
              token !== undefined &&
              pageProof(token, 'launch', sN, cN, conn.origin) === proof;
        if (!proven) {
          conn.ws.close(4003);
          return;
        }
        phase = 'start';
        const fields = {
          assetVersion: options.assetVersion ?? conn.build,
          serverId:
            typeof options.serverId === 'function'
              ? options.serverId(which)
              : (options.serverId ?? '0123456789abcdef'),
          bootId: options.bootId ?? 'stand-in-boot',
        };
        conn.send(
          mode === 'launch' && token !== undefined
            ? welcomeFields({
                ...fields,
                proof: serverProof(token, 'launch', sN, cN, conn.origin),
                key: wrapSecret(secret, token, sN, cN, new Uint8Array(12).fill(3)),
              })
            : welcomeFields({ ...fields, proof: serverProof(secret, 'key', sN, cN, conn.origin) }),
        );
        return;
      }
      if (phase === 'start') {
        phase = 'open';
        return;
      }
      if (message['t'] === 'ping') {
        const answer = typeof options.pings === 'function' ? options.pings() : options.pings;
        if (answer !== false) {
          conn.send({ t: 'pong', n: message['n'], bootId: 'stand-in-boot', serverId: '0' });
        }
        return;
      }
      options.open?.(conn, message, which);
    });
  };
}

/** Another skydeck holding the store's write lock (test/fixtures/hold-write-lock.ts). */
export function holdWriteLock(
  t: TestContext,
  databasePath: string,
): { held: Promise<void>; release(): void } {
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const holder = new Worker(new URL('../../test/fixtures/hold-write-lock.ts', import.meta.url), {
    workerData: { path: databasePath, signal },
  });
  const release = (): void => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  t.after(async () => {
    release();
    await holder.terminate();
  });
  return {
    held: new Promise<void>((resolve) => holder.once('message', () => resolve())),
    release,
  };
}

// ---------------------------------------------------------------------------------------------
// The page as a user drives it (shared by the page tests of tasks 26–29)

const FIXTURES = new URL('../fixtures/', import.meta.url);

/** The text of a file of test-page/fixtures/ (a test view, a pinned module). */
export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/**
 * The page shell's pinned modules: verbatim copies of the four placeholders of web/ at 40f7886
 * and their stylesheets (test-page/fixtures/minimal-*), by the name of the web/ file each stands
 * for. The page shell's own tests (shell.test.ts, auth.test.ts) run on them, so that the real
 * modules of tasks 27–29 change nothing there; a new test file gets the real web/ unless it asks.
 * The stylesheets are pinned too: a real one can change what is visible, and app.js's keyboard
 * rules depend on visibility (ruled by the plan owner).
 */
export const MINIMAL_MODULES = {
  'list.js': fixture('minimal-list.js'),
  'terminal-view.js': fixture('minimal-view.js'),
  'cards.js': fixture('minimal-cards.js'),
  'help.js': fixture('minimal-help.js'),
  'list.css': fixture('minimal-list.css'),
  'terminal-view.css': fixture('minimal-view.css'),
  'cards.css': fixture('minimal-cards.css'),
} as const;

/**
 * Serves `modules` (the name of a file of web/ and its text) to `page` in place of the server's,
 * for every load of the page, its own reloads included, whichever server answers: Playwright's
 * request interception of `/assets/<any build>/web/<name>`, nothing in the product. A later call
 * for the same name wins (Playwright runs the routes last registered first). Routing changes the
 * conditions of the whole page: Playwright intercepts every request of it, and Chromium's HTTP
 * cache is off while any route is on — a test about caching cannot use a pinned page.
 *
 * The pin cannot stop working unseen: once the page has asked for app.js, every name pinned on it
 * (the last pin of a name counting) must have been asked for through the pin by the end of the
 * case; otherwise the case and the names go into `unservedPins()`, which a pinned file asserts
 * empty in its last case — a file of web/ renamed in index.html or app.js would otherwise run
 * the real module without a sign. It sees only pages that ask for `app.js` by the
 * `/assets/<build>/web/` path the pins use: a rename of app.js itself or a change of that path is
 * not seen here, but assetBase asserts both, so the cases that call it (through storeKey,
 * storedKeyIs or buildOf) fail then. (Recorded, not thrown, in the case's `t.after`:
 * node:test runs no hook after one that throws, and the case's servers and sandbox are cleaned up
 * by later hooks.)
 */
export async function pinModules(
  t: TestContext,
  page: Page,
  modules: Readonly<Record<string, string>> = MINIMAL_MODULES,
): Promise<void> {
  let pins = pinsOf.get(page);
  if (pins === undefined) {
    const state = { served: new Map<string, number>(), appLoaded: false };
    pins = state;
    pinsOf.set(page, state);
    page.on('request', (request) => {
      if (/\/assets\/[^/]+\/web\/app\.js$/.test(new URL(request.url()).pathname)) {
        state.appLoaded = true;
      }
    });
    t.after(() => {
      const unused = [...state.served].filter(([, hits]) => hits === 0).map(([name]) => name);
      if (state.appLoaded && unused.length > 0) {
        unserved.push(`${t.name}: ${unused.join(', ')}`);
      }
    });
  }
  const { served } = pins;
  for (const [name, body] of Object.entries(modules)) {
    const contentType = name.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'text/javascript; charset=utf-8';
    served.set(name, 0); // a later pin of the name replaces an earlier one, and its count
    await page.route(`**/assets/*/web/${name}`, (route) => {
      served.set(name, (served.get(name) ?? 0) + 1);
      return route.fulfill({ status: 200, contentType, body });
    });
  }
}

/** Per pinned page: how often each pinned name was served through the pin; whether app.js loaded. */
const pinsOf = new WeakMap<Page, { served: Map<string, number>; appLoaded: boolean }>();
/** The cases whose page loaded app.js and asked for a pinned name not through the pin. */
const unserved: string[] = [];

/** pinModules' record: every case (and its names) whose pin was never used; [] when all held. */
export function unservedPins(): string[] {
  return [...unserved];
}

/** A page of `newPage` (helpers/browser.ts) on the pinned minimal modules (`pinModules`). */
export async function pinnedPage(t: TestContext, chromium: Browser): Promise<Page> {
  const page = await newPage(t, chromium);
  await pinModules(t, page, MINIMAL_MODULES);
  return page;
}

export const RESTARTED = /^skydeck's server restarted; your sessions kept running$/;
export const PLACEHOLDER = /terminal view comes with task 28/;
export const TERM_A = 'aaaaaaaaaaaa';
export const TERM_B = 'bbbbbbbbbbbb';
export const TERM_C = 'cccccccccccc';
export const TERM_D = 'dddddddddddd';

/** The id of the element that has the keyboard, or its tag. */
export async function active(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const element = document.activeElement;
      if (element === null) return 'none';
      const inTerminal = document.getElementById('terminal')?.contains(element) === true;
      return inTerminal ? 'in #terminal' : element.id !== '' ? `#${element.id}` : element.tagName;
    },
    null,
  );
}

/** A `list` of a scripted stand-in: rows of Open with their terminals (S2 8.2.3). */
export function scriptedList(
  rows: { id: string; terminal: string | null; slot: number | null; title?: string }[],
  terminals: { id: string; slot: number | null; sessionId: string | null }[],
  selected: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    t: 'list',
    nowNs: '1794474000000000000',
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    sections: [
      {
        name: 'open',
        folded: false,
        firstNs: null,
        lastNs: null,
        count: rows.length,
        rows: rows.map((row) => ({
          id: row.id,
          shortId: row.id.slice(0, 8),
          title: row.title ?? `session ${row.id.slice(0, 8)}`,
          titleSource: 'summary',
          group: null,
          groupSource: null,
          state: row.terminal === null ? 'not-running' : 'running',
          stateDetail: null,
          sinceNs: '1794474000000000000',
          lastActivityNs: '1794474000000000000',
          dir: '/home/u/project',
          marks: [],
          hasNote: false,
          noteHead: [],
          done: false,
          prs: [],
          chip: null,
          terminal: row.terminal,
          slot: row.slot,
          elsewhere: null,
          starting: false,
          attention: null,
          stack: null,
        })),
      },
    ],
    doneHidden: 0,
    banner: null,
    terminals: terminals.map((term) => ({
      ...term,
      state: 'running',
      notReported: false,
      cols: 80,
      rows: 24,
      ownsSize: true,
    })),
    selected,
    dirs: [],
  };
}

/**
 * A stand-in world for the cases about the page's acts and sizes (Z1 of task 26), opened on
 * `page` (pinned or not): S1 running in slot 1 (shown first), S2 not running. A resume of S2 and
 * a new session (S3) each answer ok and list their terminal, at the size the act asked for (its
 * `snap` and its entry of the list); a resume of a session whose terminal ended opens a new
 * terminal (`TERM_D`) in place of the ended one, as the server does. `acts`, `focuses` (each
 * `focus`'s `area`), `attaches` and `resizes` record what the page sent; `terms` is each
 * session's terminal now; `end(id)` lists the terminal of `id` ended.
 */
export async function actsWorld(
  t: TestContext,
  page: Page,
): Promise<{
  acts: Record<string, unknown>[];
  focuses: { cols: number; rows: number }[];
  attaches: Record<string, unknown>[];
  resizes: Record<string, unknown>[];
  terms: Readonly<Record<string, string>>;
  end: (id: string) => void;
}> {
  const secret = new Uint8Array(32).fill(23);
  const terms: Record<string, string> = { [S1]: TERM_A, [S2]: TERM_B, [S3]: TERM_C };
  /** Each terminal's size: the one its act asked for, else 80 × 24. */
  const sizes: Record<string, { cols: number; rows: number }> = {};
  const sizeOf = (term: string): { cols: number; rows: number } =>
    sizes[term] ?? { cols: 80, rows: 24 };
  const attaches: Record<string, unknown>[] = [];
  const resizes: Record<string, unknown>[] = [];
  const listed = [S1, S2];
  const running = new Set<string>([S1]);
  const ended = new Set<string>();
  let sendList: (() => void) | null = null;
  const acts: Record<string, unknown>[] = [];
  const focuses: { cols: number; rows: number }[] = [];
  let shown: string | null = null;
  const listFor = (selected: string | null): Record<string, unknown> => {
    const list = scriptedList(
      listed.map((id) => ({
        id,
        terminal: running.has(id) ? (terms[id] ?? null) : null,
        slot: running.has(id) ? listed.indexOf(id) + 1 : null,
      })),
      [...running].map((id) => ({
        id: terms[id] ?? '',
        slot: listed.indexOf(id) + 1,
        sessionId: id,
      })),
      selected === null || running.has(selected)
        ? null
        : {
            sessionId: selected,
            command: `claude --resume ${selected}`,
            flagsKnown: true,
            unknownFlags: [],
            ended: 'exited',
            expiring: false,
            expired: false,
          },
    );
    for (const term of list['terminals'] as Record<string, unknown>[]) {
      if (ended.has(term['sessionId'] as string)) term['state'] = 'ended';
      Object.assign(term, sizeOf(term['id'] as string));
    }
    return list;
  };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        sendList = () => conn.send(listFor(shown));
        if (message['t'] === 'view') {
          shown = (message['selected'] as string | null) ?? null;
          conn.send(listFor(shown));
        } else if (message['t'] === 'focus') {
          focuses.push(message['area'] as { cols: number; rows: number });
        } else if (message['t'] === 'attach') {
          attaches.push(message);
          const term = message['term'] as string;
          conn.send({ t: 'snap', term, ch: 1, ...sizeOf(term), data: '' });
        } else if (message['t'] === 'resize') {
          resizes.push(message);
        } else if (message['t'] === 'act') {
          acts.push(message);
          const sessionId = message['kind'] === 'new' ? S3 : (message['sessionId'] as string);
          if (!listed.includes(sessionId)) listed.push(sessionId);
          if (ended.delete(sessionId)) terms[sessionId] = TERM_D; // a new terminal, as the server's
          const term = terms[sessionId];
          if (term !== undefined && typeof message['cols'] === 'number') {
            sizes[term] = { cols: message['cols'], rows: message['rows'] as number };
          }
          running.add(sessionId);
          conn.send({
            t: 'result',
            id: message['id'],
            ok: true,
            lines: [],
            error: null,
            sessionId,
          });
          conn.send(listFor(sessionId));
        }
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
  /** Lists the terminal of `id` ended (its ended bar shows while it is selected). */
  const end = (id: string): void => {
    ended.add(id);
    sendList?.();
  };
  return { acts, focuses, attaches, resizes, terms, end };
}

/** `text` as a regular expression that matches it literally. */
export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Launched extends Omit<StartedServer, 'page'> {
  page: Page;
  problems: string[];
}

/**
 * A page with the recorder (made first, so that it closes first), a real test server, and the
 * page opened with a launch token of that server, as `skydeck window` opens it; connected.
 */
export async function launched(
  t: TestContext,
  chromium: Browser,
  options: ServerSandboxOptions & {
    server?: StartOptions;
    /** Modules served to the page in place of web/'s (pinModules); none by default. */
    modules?: Readonly<Record<string, string>>;
  } = {},
): Promise<Launched> {
  const page = await newPage(t, chromium);
  if (options.modules !== undefined) await pinModules(t, page, options.modules);
  await page.addInitScript(RECORDER);
  const problems = problemsOf(page);
  const started = await startTestServer(t, options);
  const { token } = await controlClient(started.d.platform.net, started.d.files.serverSock).token(
    30,
  );
  await page.goto(pageUrl(started.server.port, token));
  await connection(page, 'open');
  return { ...started, page, problems };
}

/** The page's focus zone, as its key bar says. */
export async function zone(page: Page): Promise<string> {
  return shownText(page, '#focus-zone');
}

/** Puts the page into `wanted` with Ctrl+Shift+L when it is in the other zone. */
export async function toZone(page: Page, wanted: 'list' | 'terminal'): Promise<void> {
  if ((await zone(page)) !== `Focus: ${wanted}`) await page.keyboard.press('Control+Shift+L');
  await showsText(page, '#focus-zone', new RegExp(`^Focus: ${wanted}$`));
}

/**
 * The session id of the selected row of the list. The hook it needs from the list module (task
 * 27): the selected row, and only it, is an element inside `#list` with `data-id="<session id>"`
 * and `data-selected="true"`.
 */
export async function selectedRow(page: Page): Promise<string | null> {
  return readPage(
    page,
    () => document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') ?? null,
    null,
  );
}

/** The terminal of `sessionId` in the server's hub. */
export function termOf(started: { server: StartedServer['server'] }, sessionId: string): string {
  const term = started.server.hub.list().find((info) => info.expectedSessionId === sessionId);
  assert.ok(
    term !== undefined,
    `a terminal for ${sessionId} in ${JSON.stringify(started.server.hub.list(), (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`,
  );
  return term.id;
}

/**
 * Clicks the list's row of `sessionId` ONCE, as a user does, and asserts that it is then the
 * selected row: a render never loses a click on a row (contract 2.9), so no second try is made.
 * The hooks it needs from the list module (task 27): EXACTLY ONE element per session inside
 * `#list` carries `data-id="<session id>"` (the locator is strict); a click on it selects that
 * session, also when a list arrives or the zone changes between the mousedown and the mouseup
 * (contract 2.9: the row's element is kept across renders, or the list selects on pointerdown);
 * the selected row, and only it, carries `data-selected="true"` (as selectedRow).
 */
export async function clickRow(page: Page, sessionId: string): Promise<void> {
  const row = page.locator(`#list [data-id="${sessionId}"]`);
  await row.waitFor({ timeout: PAGE_WAIT_MS });
  await row.click();
  await page.waitForFunction(
    (id) => document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
    sessionId,
    { timeout: PAGE_WAIT_MS },
  );
}

/** What the key bar's message says ('' when nothing). */
export async function keyMessage(page: Page): Promise<string> {
  return shownText(page, '#key-message');
}

/** The keyboard's BrowserRefresh key, which Playwright's keyboard does not know: through CDP. */
export async function browserRefresh(
  cdp: CDPSession,
  modifiers: 'Shift' | 'Control' | null,
): Promise<void> {
  const bits = modifiers === 'Shift' ? 8 : modifiers === 'Control' ? 2 : 0;
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'BrowserRefresh',
      code: 'BrowserRefresh',
      windowsVirtualKeyCode: 168,
      nativeVirtualKeyCode: 168,
      modifiers: bits,
    });
  }
}

/** Presses `key`: a Playwright key, or BrowserRefresh alone, with Shift or with Control. */
export async function press(page: Page, cdp: CDPSession, key: string): Promise<void> {
  const refresh = /^(?:(Shift|Control)\+)?BrowserRefresh$/.exec(key);
  if (refresh === null) await page.keyboard.press(key);
  else await browserRefresh(cdp, (refresh[1] as 'Shift' | 'Control' | undefined) ?? null);
}

/**
 * Resumes `sessionId` from the list as a user does: a click selects its row (a session that is
 * not running: the list zone), Enter resumes it, and the pane shows its terminal with the
 * keyboard in it. With any modules that follow contract 2.9; the hooks it needs: clickRow's from
 * the list, and that a click on a row leaves the keyboard on the list itself — `#list` or an
 * element in it that is no button, link (`a[href]`), field, summary or editable text, since
 * app.js applies list keys only then (`listHasKeyboard`); a row that is such a control takes the
 * Enter itself and nothing resumes. From the terminal view (task 28): its `focus()` puts the
 * keyboard on an element inside its root `#terminal`. Everything else it reads is app.js's
 * (`#focus-zone`, `#right-zone[data-pane]`).
 */
export async function resumeFromList(page: Page, sessionId: string): Promise<void> {
  await clickRow(page, sessionId);
  await showsText(page, '#focus-zone', /^Focus: list$/);
  await page.keyboard.press('Enter');
  // Any view (contract 2.9): the session's row stays selected and the right side shows a terminal.
  await page.waitForFunction(
    (id) =>
      document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id &&
      document.querySelector('#right-zone[data-pane="terminal"]') !== null,
    sessionId,
    { timeout: PAGE_WAIT_MS },
  );
  // S2 11.3: the new terminal is selected, with the keyboard in it.
  await page.waitForFunction(
    () => document.getElementById('terminal')?.contains(document.activeElement) === true,
    null,
    { timeout: PAGE_WAIT_MS },
  );
}

/** The build a page was loaded with, from its asset URLs. */
export async function buildOf(page: Page): Promise<string> {
  const match = /\/assets\/([^/]+)\/web\/$/.exec(await assetBase(page));
  assert.ok(match !== null);
  return match[1] as string;
}
