import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Files, Platform } from '../../src/platform/types.ts';
import { httpHandler, hostOk, loadAssets, securityHeaders } from '../../src/window/assets.ts';
import type { Assets } from '../../src/window/assets.ts';
import { computeBuild } from '../../src/window/build.ts';
import { readManifest } from '../../src/window/vendor.ts';
import { testPlatform } from '../helpers/platform.ts';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';
const IMMUTABLE = 'max-age=31536000, immutable';

const INDEX = [
  '<!doctype html>',
  '<!-- the server puts the build where __VERSION__ is -->',
  '<link rel="stylesheet" href="/assets/__VERSION__/vendor/xterm/xterm/css/xterm.css">',
  '<link rel="stylesheet" href="/assets/__VERSION__/web/style.css">',
  '<script type="module" src="/assets/__VERSION__/web/app.js"></script>',
  '',
].join('\n');

/** The vendored files of the fixture: path → content. */
const VENDORED: Record<string, string> = {
  'vendor/xterm/THIRD-PARTY-NOTICES': 'notices\n',
  'vendor/xterm/headless/lib-headless/xterm-headless.mjs': 'export class Terminal {}\n',
  'vendor/xterm/xterm/LICENSE': 'MIT\n',
  'vendor/xterm/xterm/css/xterm.css': '.xterm { cursor: text; }\n',
  'vendor/xterm/xterm/lib/xterm.d.mts': "export * from '@xterm/xterm';\n",
  'vendor/xterm/xterm/lib/xterm.mjs':
    'export class Terminal {}\n//# sourceMappingURL=xterm.mjs.map\n',
  'vendor/xterm/xterm/typings/xterm.d.ts': "declare module '@xterm/xterm' {}\n",
};

/** The files of the fixture outside vendor/: path → content. */
const OTHERS: Record<string, string> = {
  'bin/skydeck': '#!/bin/sh\n',
  'bin/skydeck-keeper': '# the keeper ✓\nprint("keeper")\n',
  'src/window/server.ts': 'export const a = 1;\n',
  'web/index.html': INDEX,
  'web/app.js': "import './sub/mod.js';\n",
  'web/sub/mod.js': 'export {};\n',
  'web/style.css': 'body { margin: 0; }\n',
  'web/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  'web/data.json': '{}\n',
  'web/NOTES': 'no extension\n',
  'web/tsconfig.json': '{}\n',
  'web/.hidden.js': 'export {};\n',
  'vendor/xterm/extra.mjs': 'export {};\n', // not in the manifest
  'docs/design.md': '# design\n',
};

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function put(root: string, path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Writes `vendor/MANIFEST.json` for `paths`, from the files' bytes on disk. */
function writeManifest(root: string, paths: readonly string[]): void {
  const files = [...paths].sort().map((path) => ({
    path,
    package: '@xterm/xterm',
    version: '6.0.0',
    sha256: sha256(readFileSync(join(root, path))),
  }));
  put(root, 'vendor/MANIFEST.json', `${JSON.stringify({ files }, null, 2)}\n`);
}

interface Fixture {
  platform: Platform;
  root: string;
}

/** An app root in the sandbox: a few files under bin/, src/, web/, vendor/ and docs/. */
function fixture(t: TestContext, options: { skip?: readonly string[] } = {}): Fixture {
  const { platform, sandbox } = testPlatform(t);
  const root = join(sandbox.root, 'app');
  const skip = new Set(options.skip ?? []);
  for (const [path, content] of Object.entries({ ...VENDORED, ...OTHERS })) {
    if (!skip.has(path)) {
      put(root, path, content);
    }
  }
  writeManifest(root, Object.keys(VENDORED));
  return { platform, root };
}

/** An app root whose vendor/ is a copy of the checkout's. */
function withRealVendor(t: TestContext): Fixture {
  const { platform, sandbox } = testPlatform(t);
  const root = join(sandbox.root, 'app');
  cpSync(join(checkout, 'vendor'), join(root, 'vendor'), { recursive: true });
  put(root, 'bin/skydeck-keeper', 'print("keeper")\n');
  put(root, 'web/index.html', INDEX);
  return { platform, root };
}

const text = (body: Uint8Array | undefined): string => Buffer.from(body ?? []).toString('utf8');

// ---------------------------------------------------------------------------------------------
// loadAssets

describe('loadAssets', () => {
  test('the build is computeBuild of the app root; the keeper code is bin/skydeck-keeper', (t) => {
    const { platform, root } = fixture(t);

    const assets = loadAssets(platform.files, root);

    assert.equal(assets.build, computeBuild(platform.files, root));
    assert.equal(assets.keeperCode, OTHERS['bin/skydeck-keeper']);
  });

  test("'/' is index.html with every /assets/__VERSION__/ replaced by the build", (t) => {
    const { platform, root } = fixture(t);

    const assets = loadAssets(platform.files, root);
    const index = assets.get('/');

    assert.ok(index);
    assert.equal(index.type, HTML);
    assert.equal(
      text(index.body),
      INDEX.replaceAll('/assets/__VERSION__/', `/assets/${assets.build}/`),
    );
    assert.equal(text(index.body).match(new RegExp(`/assets/${assets.build}/`, 'g'))?.length, 3);
    assert.match(text(index.body), /where __VERSION__ is/); // only the asset path is replaced
  });

  test('the files of web/ by their versioned path, with their bytes and type', (t) => {
    const { platform, root } = fixture(t);

    const assets = loadAssets(platform.files, root);
    const at = (path: string) => assets.get(`/assets/${assets.build}/${path}`);

    for (const [path, type] of [
      ['web/app.js', JS],
      ['web/sub/mod.js', JS],
      ['web/style.css', CSS],
      ['web/icon.svg', 'image/svg+xml'],
      ['web/data.json', 'application/json'],
      ['web/NOTES', 'application/octet-stream'],
    ] as const) {
      const asset = at(path);
      assert.ok(asset, path);
      assert.equal(text(asset.body), OTHERS[path]);
      assert.equal(asset.type, type, path);
    }
  });

  test('the vendored .mjs and .css files of the manifest, and no other vendored file', (t) => {
    const { platform, root } = fixture(t);

    const assets = loadAssets(platform.files, root);
    const at = (path: string) => assets.get(`/assets/${assets.build}/${path}`);

    assert.equal(at('vendor/xterm/xterm/lib/xterm.mjs')?.type, JS);
    assert.equal(
      text(at('vendor/xterm/xterm/lib/xterm.mjs')?.body),
      VENDORED['vendor/xterm/xterm/lib/xterm.mjs'],
    );
    assert.equal(at('vendor/xterm/headless/lib-headless/xterm-headless.mjs')?.type, JS);
    assert.equal(at('vendor/xterm/xterm/css/xterm.css')?.type, CSS);
    for (const path of [
      'vendor/xterm/THIRD-PARTY-NOTICES',
      'vendor/xterm/xterm/LICENSE',
      'vendor/xterm/xterm/lib/xterm.d.mts',
      'vendor/xterm/xterm/typings/xterm.d.ts',
      'vendor/xterm/xterm/lib/xterm.mjs.map',
      'vendor/xterm/extra.mjs',
      'vendor/MANIFEST.json',
    ]) {
      assert.equal(at(path), null, path);
    }
  });

  test('nothing else is on the list', (t) => {
    const { platform, root } = fixture(t);

    const assets = loadAssets(platform.files, root);
    const b = assets.build;

    for (const path of [
      `/assets/${b}/web/tsconfig.json`,
      `/assets/${b}/web/index.html`,
      `/assets/${b}/web/.hidden.js`,
      `/assets/${b}/bin/skydeck-keeper`,
      `/assets/${b}/src/window/server.ts`,
      `/assets/${b}/docs/design.md`,
      `/assets/${b}/web/`,
      `/assets/${b}/web`,
      `/assets/${b}/web/sub`,
      `/assets/${b}/web/../web/app.js`,
      `/assets/${b}/web/%2e%2e/web/app.js`,
      `/assets/0000000000000000/web/app.js`,
      `/assets/__VERSION__/web/app.js`,
      '/assets/web/app.js',
      '/web/app.js',
      'web/app.js',
      '/index.html',
      '/manifest.webmanifest',
      '/favicon.ico',
      '',
    ]) {
      assert.equal(assets.get(path), null, path);
    }
  });

  test("the checkout's own manifest: every .mjs and .css is served, nothing else of vendor/", (t) => {
    const { platform, root } = withRealVendor(t);

    const assets = loadAssets(platform.files, root);
    const entries = readManifest(platform.files, root);

    assert.ok(entries);
    const served = entries
      .map((e) => e.path)
      .filter((path) => assets.get(`/assets/${assets.build}/${path}`) !== null);
    assert.deepEqual(
      served,
      entries.map((e) => e.path).filter((path) => /\.(mjs|css)$/.test(path)),
    );
    assert.ok(served.includes('vendor/xterm/xterm/lib/xterm.mjs'));
    assert.ok(served.includes('vendor/xterm/xterm/css/xterm.css'));
  });

  test("no web/ is no error: '/' is not on the list", (t) => {
    const { platform, root } = fixture(t);
    rmSync(join(root, 'web'), { recursive: true });

    const assets = loadAssets(platform.files, root);

    assert.equal(assets.get('/'), null);
  });

  test("an empty web/ is no error: '/' is not on the list", (t) => {
    const { platform, root } = fixture(t);
    rmSync(join(root, 'web'), { recursive: true });
    mkdirSync(join(root, 'web'));

    const assets = loadAssets(platform.files, root);

    assert.equal(assets.get('/'), null);
  });

  test('refuses a checkout whose vendored file was altered', (t) => {
    const { platform, root } = fixture(t);
    appendFileSync(join(root, 'vendor/xterm/xterm/lib/xterm.mjs'), '// altered\n');

    assert.throws(
      () => loadAssets(platform.files, root),
      /vendor\/xterm\/xterm\/lib\/xterm\.mjs differs from vendor\/MANIFEST\.json/,
    );
  });

  test('refuses a checkout whose vendored file that the page does not load was altered', (t) => {
    const { platform, root } = fixture(t);
    appendFileSync(join(root, 'vendor/xterm/xterm/LICENSE'), 'altered\n');

    assert.throws(() => loadAssets(platform.files, root), /vendor\/xterm\/xterm\/LICENSE differs/);
  });

  test('refuses a checkout whose vendored file is missing', (t) => {
    const { platform, root } = fixture(t);
    rmSync(join(root, 'vendor/xterm/xterm/css/xterm.css'));

    assert.throws(
      () => loadAssets(platform.files, root),
      /vendor\/xterm\/xterm\/css\/xterm\.css is missing/,
    );
  });

  test('refuses a checkout without vendor/MANIFEST.json', (t) => {
    const { platform, root } = fixture(t);
    rmSync(join(root, 'vendor/MANIFEST.json'));

    assert.throws(() => loadAssets(platform.files, root), /vendor\/MANIFEST\.json is missing/);
  });

  test('refuses a vendored file that changed between reading it and checking it', (t) => {
    const { platform, root } = fixture(t);
    let reads = 0;
    const racing: Files = {
      ...platform.files,
      readBytes(path, start, end) {
        const bytes = platform.files.readBytes(path, start, end);
        // the first read is the build's; the manifest check reads the file as it is on disk
        if (path.endsWith('/xterm/lib/xterm.mjs') && reads++ === 0) {
          return Uint8Array.from([...bytes, 0x20]);
        }
        return bytes;
      },
    };

    assert.throws(() => loadAssets(racing, root), /vendor\/xterm\/xterm\/lib\/xterm\.mjs/);
    assert.ok(reads >= 1);
  });

  test('refuses a checkout without bin/skydeck-keeper', (t) => {
    const { platform, root } = fixture(t, { skip: ['bin/skydeck-keeper'] });

    assert.throws(() => loadAssets(platform.files, root), /bin\/skydeck-keeper is missing/);
  });

  test('refuses a keeper that is not UTF-8', (t) => {
    const { platform, root } = fixture(t);
    put(root, 'bin/skydeck-keeper', Uint8Array.from([0x23, 0xff, 0x0a]));

    assert.throws(() => loadAssets(platform.files, root), /bin\/skydeck-keeper is not UTF-8/);
  });
});

// ---------------------------------------------------------------------------------------------
// hostOk and securityHeaders

test('hostOk: exactly 127.0.0.1:<port>', () => {
  assert.equal(hostOk('127.0.0.1:8123', 8123), true);
  for (const host of [
    undefined,
    '',
    'localhost:8123',
    '127.0.0.1',
    '127.0.0.1:',
    '127.0.0.1:8124',
    '127.0.0.1:08123',
    '127.0.0.1:8123 ',
    ' 127.0.0.1:8123',
    '127.0.0.1.:8123',
    '127.1:8123',
    '[::1]:8123',
    'http://127.0.0.1:8123',
    '127.0.0.1:8123@evil.example',
    'evil.example',
  ]) {
    assert.equal(hostOk(host, 8123), false, String(host));
  }
});

test('hostOk: no port that cannot be bound', () => {
  assert.equal(hostOk('127.0.0.1:0', 0), false);
  assert.equal(hostOk('127.0.0.1:65536', 65536), false);
  assert.equal(hostOk('127.0.0.1:-1', -1), false);
  assert.equal(hostOk('127.0.0.1:NaN', Number.NaN), false);
  assert.equal(hostOk('127.0.0.1:65535', 65535), true);
  assert.equal(hostOk('127.0.0.1:1', 1), true);
});

test('hostOk at port 80: 127.0.0.1 with and without :80, as a browser sends it; never localhost', () => {
  assert.equal(hostOk('127.0.0.1:80', 80), true);
  assert.equal(hostOk('127.0.0.1', 80), true);
  for (const host of ['localhost', 'localhost:80', '127.0.0.1:080', '127.0.0.1:8080', undefined]) {
    assert.equal(hostOk(host, 80), false, String(host));
  }
  assert.equal(hostOk('127.0.0.1', 8080), false); // without a port only for 80
});

test('securityHeaders: the policy of S2 8.2.1 with the port, nosniff, DENY, no-referrer', () => {
  assert.deepEqual(securityHeaders(8123), {
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; manifest-src 'self'; " +
      "connect-src 'self' ws://127.0.0.1:8123; base-uri 'none'; form-action 'none'; " +
      "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
});

// ---------------------------------------------------------------------------------------------
// httpHandler, over a real listener on 127.0.0.1

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request with exactly this request target and Host header (default: the right one). */
function send(
  port: number,
  path: string,
  options: { host?: string; method?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        agent: false,
        headers: { Host: options.host ?? `127.0.0.1:${port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Serves `assets` on a port the system picks; the handler reads the port as tasks 20 and 23 do. */
async function serve(t: TestContext, platform: Platform, assets: Assets): Promise<number> {
  let bound = 0;
  const listener = await platform.net.listenHttp(
    { host: '127.0.0.1', port: 0 },
    { request: httpHandler(assets, () => bound) },
  );
  bound = listener.port;
  t.after(() => listener.close());
  return bound;
}

async function served(t: TestContext): Promise<{ root: string; port: number; build: string }> {
  const { platform, root } = fixture(t);
  const assets = loadAssets(platform.files, root);
  return { root, port: await serve(t, platform, assets), build: assets.build };
}

function assertSecurityHeaders(answer: Answer, port: number): void {
  const expected = securityHeaders(port);
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(answer.headers[name.toLowerCase()], value, name);
  }
  assert.match(
    String(answer.headers['content-security-policy']),
    new RegExp(`ws://127\\.0\\.0\\.1:${port};`),
  );
  const cors = Object.keys(answer.headers).filter((name) => name.startsWith('access-control-'));
  assert.deepEqual(cors, []);
}

describe('httpHandler', () => {
  test('GET / → index.html with the build in its asset paths, not cached', async (t) => {
    const { port, build } = await served(t);

    const answer = await send(port, '/');

    assert.equal(answer.status, 200);
    assert.equal(answer.headers['content-type'], HTML);
    assert.equal(answer.body, INDEX.replaceAll('/assets/__VERSION__/', `/assets/${build}/`));
    assert.equal(answer.headers['cache-control'], 'no-store');
  });

  test('GET a versioned file of web/ → its bytes, its type, immutable', async (t) => {
    const { port, build } = await served(t);

    const answer = await send(port, `/assets/${build}/web/app.js`);

    assert.equal(answer.status, 200);
    assert.equal(answer.body, OTHERS['web/app.js']);
    assert.equal(answer.headers['content-type'], JS);
    assert.equal(answer.headers['content-length'], String(Buffer.byteLength(answer.body)));
    assert.equal(answer.headers['cache-control'], IMMUTABLE);
  });

  test('GET a versioned vendored file → its bytes, its type, immutable', async (t) => {
    const { port, build } = await served(t);

    const mjs = await send(port, `/assets/${build}/vendor/xterm/xterm/lib/xterm.mjs`);
    const css = await send(port, `/assets/${build}/vendor/xterm/xterm/css/xterm.css`);

    assert.equal(mjs.status, 200);
    assert.equal(mjs.body, VENDORED['vendor/xterm/xterm/lib/xterm.mjs']);
    assert.equal(mjs.headers['content-type'], JS);
    assert.equal(mjs.headers['cache-control'], IMMUTABLE);
    assert.equal(css.headers['cache-control'], IMMUTABLE);
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], CSS);
  });

  test('another version, ../, %2e%2e, a source map and anything off the list → 404', async (t) => {
    const { port, build } = await served(t);

    for (const path of [
      `/assets/0000000000000000/web/app.js`,
      `/assets/__VERSION__/web/app.js`,
      `/assets/${build}/web/../web/app.js`,
      `/assets/${build}/../${build}/web/app.js`,
      `/assets/${build}/web/%2e%2e/web/app.js`,
      `/assets/${build}/web/%2E%2E/web/app.js`,
      `/assets/${build}/web%2fapp.js`,
      `/assets/${build}/web/app%2ejs`,
      `/assets/${build}//web/app.js`,
      `/assets/${build}/vendor/xterm/xterm/lib/xterm.mjs.map`,
      `/assets/${build}/vendor/xterm/THIRD-PARTY-NOTICES`,
      `/assets/${build}/vendor/MANIFEST.json`,
      `/assets/${build}/web/tsconfig.json`,
      `/assets/${build}/web/index.html`,
      `/assets/${build}/bin/skydeck-keeper`,
      `/assets/${build}/src/window/server.ts`,
      '/manifest.webmanifest',
      '/favicon.ico',
      '/ws',
      '/index.html',
      '/web/app.js',
      '//',
    ]) {
      const answer = await send(port, path);
      assert.equal(answer.status, 404, path);
      assert.equal(answer.headers['cache-control'], 'no-store', path);
    }
  });

  test('a file added to web/ after start → 404', async (t) => {
    const { root, port, build } = await served(t);
    put(root, 'web/late.js', 'export {};\n');

    const answer = await send(port, `/assets/${build}/web/late.js`);

    assert.equal(answer.status, 404);
  });

  test('a file changed on disk after start → the bytes read at start', async (t) => {
    const { root, port, build } = await served(t);
    put(root, 'web/app.js', 'changed\n');
    put(root, 'web/index.html', 'changed\n');
    put(root, 'vendor/xterm/xterm/lib/xterm.mjs', 'changed\n');

    const app = await send(port, `/assets/${build}/web/app.js`);
    const index = await send(port, '/');
    const xterm = await send(port, `/assets/${build}/vendor/xterm/xterm/lib/xterm.mjs`);

    assert.equal(app.body, OTHERS['web/app.js']);
    assert.match(index.body, /^<!doctype html>/);
    assert.equal(xterm.body, VENDORED['vendor/xterm/xterm/lib/xterm.mjs']);
  });

  test('a query string is not part of the path, nor of the cache rule', async (t) => {
    const { port, build } = await served(t);

    const index = await send(port, '/?x=1');
    const app = await send(port, `/assets/${build}/web/app.js?v=2`);

    assert.equal(index.status, 200);
    assert.equal(index.headers['content-type'], HTML);
    assert.equal(index.headers['cache-control'], 'no-store');
    assert.equal(app.body, OTHERS['web/app.js']);
    assert.equal(app.headers['cache-control'], IMMUTABLE);
  });

  test('every answer (200, 404, 421, 403, 405) carries the security headers and no CORS header', async (t) => {
    const { port, build } = await served(t);

    const answers = [
      await send(port, '/'),
      await send(port, `/assets/${build}/web/app.js`),
      await send(port, '/nothing'),
      await send(port, '/', { host: `localhost:${port}` }),
      await send(port, '/', { method: 'OPTIONS' }),
      await send(port, '/', { method: 'POST' }),
    ];

    assert.deepEqual(
      answers.map((a) => [a.status, a.headers['content-type'], a.headers['cache-control']]),
      [
        [200, HTML, 'no-store'],
        [200, JS, IMMUTABLE],
        [404, TEXT, 'no-store'],
        [421, TEXT, 'no-store'],
        [403, TEXT, 'no-store'],
        [405, TEXT, 'no-store'],
      ],
    );
    for (const answer of answers) {
      assertSecurityHeaders(answer, port);
    }
  });

  test('immutable only under /assets/: a file at an address that never changes is no-store', async (t) => {
    const { platform } = testPlatform(t);
    const icon = { body: Uint8Array.from([1, 2, 3]), type: 'image/x-icon' };
    const assets: Assets = {
      build: '0123456789abcdef',
      keeperCode: '',
      get: (path) => (path === '/favicon.ico' ? icon : null), // as stage E's list will have it
    };
    const port = await serve(t, platform, assets);

    const answer = await send(port, '/favicon.ico');

    assert.equal(answer.status, 200);
    assert.equal(answer.headers['cache-control'], 'no-store');
  });

  test('a request without a Host header (HTTP/1.0) → 421', async (t) => {
    const { port } = await served(t);

    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      socket.end('GET / HTTP/1.0\r\n\r\n');
    });

    assert.match(raw, /^HTTP\/1\.1 421 /);
    assert.match(raw, /\r\ncontent-security-policy: default-src 'none';/i);
    assert.doesNotMatch(raw, /doctype/);
  });

  test('a Host other than 127.0.0.1:<port> → 421, whatever the path', async (t) => {
    const { port, build } = await served(t);

    for (const host of [
      `localhost:${port}`,
      '127.0.0.1',
      `127.0.0.1:${port + 1}`,
      `[::1]:${port}`,
      `rebind.example:${port}`,
    ]) {
      for (const path of ['/', `/assets/${build}/web/app.js`, '/nothing']) {
        const answer = await send(port, path, { host });
        assert.equal(answer.status, 421, `${host} ${path}`);
        assert.doesNotMatch(answer.body, /doctype|import/);
      }
    }
  });

  test('OPTIONS → 403; with a wrong Host, 421 first', async (t) => {
    const { port, build } = await served(t);

    assert.equal((await send(port, '/', { method: 'OPTIONS' })).status, 403);
    assert.equal(
      (await send(port, `/assets/${build}/web/app.js`, { method: 'OPTIONS' })).status,
      403,
    );
    assert.equal((await send(port, '*', { method: 'OPTIONS' })).status, 403);
    assert.equal(
      (await send(port, '/', { method: 'OPTIONS', host: `localhost:${port}` })).status,
      421,
    );
  });

  test('a method other than GET and OPTIONS → 405 with Allow: GET, whatever the path', async (t) => {
    const { port, build } = await served(t);

    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of ['/', `/assets/${build}/web/app.js`, '/nothing']) {
        const answer = await send(port, path, { method });
        assert.equal(answer.status, 405, `${method} ${path}`);
        assert.equal(answer.headers.allow, 'GET', `${method} ${path}`);
        assert.equal(answer.headers['cache-control'], 'no-store', `${method} ${path}`);
        assert.doesNotMatch(answer.body, /doctype|import/);
      }
    }
  });

  test('a method other than GET with a wrong Host → 421 first', async (t) => {
    const { port } = await served(t);

    for (const method of ['HEAD', 'POST']) {
      const answer = await send(port, '/', { method, host: `localhost:${port}` });
      assert.equal(answer.status, 421, method);
      assert.equal(answer.headers.allow, undefined, method);
    }
  });

  test('no web/: GET / → 404', async (t) => {
    const { platform, root } = fixture(t);
    rmSync(join(root, 'web'), { recursive: true });
    const port = await serve(t, platform, loadAssets(platform.files, root));

    const answer = await send(port, '/');

    assert.equal(answer.status, 404);
    assertSecurityHeaders(answer, port);
  });

  test('the port is read at each request', async (t) => {
    const { platform, root } = fixture(t);
    const assets = loadAssets(platform.files, root);
    let bound = 0;
    const listener = await platform.net.listenHttp(
      { host: '127.0.0.1', port: 0 },
      { request: httpHandler(assets, () => bound) },
    );
    t.after(() => listener.close());
    const port = listener.port;

    const before = await send(port, '/');
    bound = port;
    const after = await send(port, '/');

    assert.equal(before.status, 421);
    assert.equal(after.status, 200);
    assertSecurityHeaders(after, port);
  });
});
