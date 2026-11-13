// What the server answers over plain HTTP (S2 8.2.1, 15.1): the page's files, read into memory at
// start and served from there under the build's path, and the refusals. Nothing on the TCP port
// acts on anything; the WebSocket upgrade is handled elsewhere (tasks 10 and 17).
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';

import { SkydeckError } from '../platform/errors.ts';
import type { Files } from '../platform/types.ts';
import { readBuild } from './build.ts';
import { readManifest, verifyVendored } from './vendor.ts';

export interface Assets {
  build: string;
  /** The keeper's code as read at start (S2 16.5). */
  keeperCode: string;
  /**
   * By the path of a request without its query: '/' (index.html with the build put in) or
   * '/assets/<build>/<path in the checkout>'. null when the path is not on the list.
   */
  get(path: string): { body: Uint8Array; type: string } | null;
}

const KEEPER = 'bin/skydeck-keeper';
const INDEX = 'web/index.html';
/** The contract with web/index.html (task 26): every occurrence becomes `/assets/<build>/`. */
const PLACEHOLDER = '/assets/__VERSION__/';
/** Files of web/ not on the versioned list: the type checker's, and index.html, which is served as
 *  '/' with the build put in (as it is on disk it would be a second, broken page). */
const NOT_SERVED = new Set(['web/tsconfig.json', INDEX]);
/** Vendored files the page loads: the bundles and the stylesheet (S2 16.6). */
const LOADED_FROM_VENDOR = /\.(mjs|css)$/;

const HTML = 'text/html; charset=utf-8';
const TYPES: Readonly<Record<string, string>> = {
  '.html': HTML,
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
/** With `nosniff`, a file of another kind is never run or shown as a page. */
const OTHER_TYPE = 'application/octet-stream';

function refuse(reason: string): never {
  throw new SkydeckError(`skydeck cannot serve this checkout: ${reason}`);
}

/** index.html with the build put in: done on the bytes, which keep every other byte as it was. */
function withBuild(index: Uint8Array, build: string): Uint8Array {
  const latin1 = Buffer.from(index).toString('latin1'); // one character per byte, both ways
  return Buffer.from(latin1.replaceAll(PLACEHOLDER, `/assets/${build}/`), 'latin1');
}

/**
 * Reads web/** (but web/tsconfig.json; web/index.html is served as '/' only), the vendored files of
 * the manifest that the page loads (`vendor/xterm/**` .mjs and .css) and bin/skydeck-keeper.
 * Refuses (Error) when verifyVendored
 * reports a problem. A missing or empty web/ is no error (task 23's tests run before task 26
 * creates it): then `GET /` is 404.
 *
 * Every file is read once, by `readBuild`, and the build is the hash of exactly the bytes served
 * (S2 8.2.1). A served vendored file must have the manifest's hash in those bytes too, so that a
 * file changed between that read and verifyVendored's is refused as well. Names starting with '.'
 * and `__pycache__` are neither in the build nor served (A12).
 */
export function loadAssets(files: Files, appRoot: string): Assets {
  const { build, files: read } = readBuild(files, appRoot);
  const problems = verifyVendored(files, appRoot);
  if (problems.length > 0) {
    refuse(problems.join('; '));
  }
  const keeper = read.get(KEEPER);
  if (keeper === undefined) {
    refuse(`${KEEPER} is missing`);
  }
  let keeperCode: string;
  try {
    keeperCode = new TextDecoder('utf-8', { fatal: true }).decode(keeper);
  } catch {
    refuse(`${KEEPER} is not UTF-8`);
  }

  const served = new Map<string, { body: Uint8Array; type: string }>();
  const prefix = `/assets/${build}/`;
  for (const [path, body] of read) {
    if (path.startsWith('web/') && !NOT_SERVED.has(path)) {
      served.set(prefix + path, { body, type: TYPES[extname(path)] ?? OTHER_TYPE });
    }
  }
  for (const entry of readManifest(files, appRoot) ?? refuse('vendor/MANIFEST.json changed')) {
    if (!LOADED_FROM_VENDOR.test(entry.path)) {
      continue;
    }
    const body = read.get(entry.path);
    if (body === undefined || createHash('sha256').update(body).digest('hex') !== entry.sha256) {
      refuse(`${entry.path} changed while skydeck read it`);
    }
    served.set(prefix + entry.path, { body, type: TYPES[extname(entry.path)] ?? OTHER_TYPE });
  }
  const index = read.get(INDEX);
  if (index !== undefined) {
    served.set('/', { body: withBuild(index, build), type: HTML });
  }
  return { build, keeperCode, get: (path) => served.get(path) ?? null };
}

/** The headers every answer carries (the policy with the port, nosniff, DENY, no-referrer). */
export function securityHeaders(port: number): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; manifest-src 'self'; " +
      `connect-src 'self' ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; ` +
      "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

/**
 * S2 8.2.1 and 15.1: the Host header is exactly `127.0.0.1:<port>`; also used for the upgrade
 * (task 17). For port 80 also `127.0.0.1`, as a browser leaves out its default port (ruled).
 */
export function hostOk(host: string | undefined, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }
  return host === `127.0.0.1:${port}` || (port === 80 && host === '127.0.0.1');
}

/**
 * The HTTP request handler of S2 8.2.1 for `port`: Host check, the fixed routes, headers.
 * `port()` is the bound port, read at each request: with port 0 it is known only after
 * listenHttp has resolved (tasks 20, 23 pass a function that returns it then).
 *
 * In this order: a wrong Host → 421; OPTIONS → 403; any other method but GET → 405 with
 * `Allow: GET` (HEAD included: the one listener other pages can reach answers as few requests as
 * it can; ruled); GET of a path on the list → the file, the query ignored and never used (a path
 * under `/assets/` is `max-age=31536000, immutable`, any other, '/' included, `no-store`); any other
 * GET → 404. Refusals are `no-store`. No answer carries a CORS header.
 */
export function httpHandler(
  assets: Assets,
  port: () => number,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const bound = port();
    const answer = (
      status: number,
      type: string,
      body: Uint8Array,
      cache: string,
      extra: Record<string, string> = {},
    ): void => {
      res.writeHead(status, {
        ...securityHeaders(bound),
        'Content-Type': type,
        'Content-Length': String(body.byteLength),
        'Cache-Control': cache,
        ...extra,
      });
      res.end(body);
    };
    const refusal = (status: number, text: string, extra?: Record<string, string>): void => {
      answer(status, 'text/plain; charset=utf-8', Buffer.from(`${text}\n`), 'no-store', extra);
    };

    if (!hostOk(req.headers.host, bound)) {
      refusal(421, 'misdirected request');
      return;
    }
    if (req.method === 'OPTIONS') {
      refusal(403, 'forbidden');
      return;
    }
    if (req.method !== 'GET') {
      refusal(405, 'method not allowed', { Allow: 'GET' });
      return;
    }
    const target = req.url ?? '';
    const query = target.indexOf('?');
    const path = query === -1 ? target : target.slice(0, query);
    const asset = assets.get(path);
    if (asset === null) {
      refusal(404, 'not found');
      return;
    }
    // Immutable only under the versioned path: '/' (and the icon of stage E) keep their address.
    const cache = path.startsWith('/assets/') ? 'max-age=31536000, immutable' : 'no-store';
    answer(200, asset.type, asset.body, cache);
  };
}
