// What the page tests of the window's page share (plan tasks 26–29): its address, what the page
// did with its WebSockets (recorded by an init script, kept across reloads), the state it shows,
// and stand-in servers — the page's real files on a port of the test's own, with a WebSocket the
// test scripts (S2 17.4: "a stand-in server").
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import type { Page } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';

import { httpHandler, loadAssets, securityHeaders } from '../../src/window/assets.ts';
import {
  isNonce,
  keyProofMatches,
  pageProof,
  serverProof,
  wrapSecret,
} from '../../src/window/auth.ts';
import { testPlatform } from '../../test/helpers/platform.ts';

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
 * What the recorder logged so far (across reloads). A read that meets a navigation (the page
 * reloading itself) is made again on the next document.
 */
export async function logOf(page: Page): Promise<Logged[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(
        () => JSON.parse(sessionStorage.getItem('skydeck-test-log') ?? '[]') as Logged[],
      );
    } catch (error) {
      if (attempt >= 50 || !/context was destroyed|navigat/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
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
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement) || element.closest('[hidden]') !== null) return '';
    return element.textContent ?? '';
  }, selector);
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
  const { platform } = testPlatform(t);
  const assets = loadAssets(platform.files, platform.appRoot);
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
    pings?: boolean;
    before?: (n: number) => 'close-1013' | 'drop' | 'drop-after-hello' | null;
    serverId?: string;
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
          serverId: options.serverId ?? '0123456789abcdef',
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
      if (message['t'] === 'ping' && options.pings !== false) {
        conn.send({ t: 'pong', n: message['n'], bootId: 'stand-in-boot', serverId: '0' });
      }
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
