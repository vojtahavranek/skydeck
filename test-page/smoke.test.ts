// The page suite's smoke test (S2 8.2.1, 17.4, 17.5; plan task 20): Playwright drives headless
// Chromium, and the page, the server's policy and the vendored xterm.js meet here, in wave 3, not
// only when the window's page is built.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Page } from 'playwright';

import { httpHandler, loadAssets, securityHeaders } from '../src/window/assets.ts';
import { testPlatform } from '../test/helpers/platform.ts';
import { sandbox } from '../test/helpers/sandbox.ts';
import type { Sandbox } from '../test/helpers/sandbox.ts';
import { browser, newPage, NOT_INSTALLED } from './helpers/browser.ts';

const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const FIXTURE = join(checkout, 'test-page/fixtures/xterm-smoke');

/** Where test/helpers/sandbox.ts makes a sandbox: the start of its root. */
const SANDBOX_ROOTS = join(realpathSync(tmpdir()), 'skydeck-test-');

/** Where Playwright finds its browsers for this process: a child in a sandbox has another home. */
const BROWSERS = resolve(
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright'),
);

/** What the page's main.js leaves in `window.smoke` once its terminal has taken the write. */
interface Smoke {
  modules: Record<string, string>;
  serialized: string;
  unicodeVersion: string;
}

/**
 * A temporary app root in the sandbox — the fixture as its web/, the checkout's vendor/ and
 * bin/skydeck-keeper (loadAssets refuses an app root without one) — served by task 14's
 * loadAssets and httpHandler on a port the system picks. Returns the page's address.
 */
async function serveFixture(t: TestContext): Promise<{ url: string; port: number }> {
  const { platform, sandbox: s } = testPlatform(t);
  const root = join(s.root, 'app');
  mkdirSync(join(root, 'bin'), { recursive: true });
  symlinkSync(FIXTURE, join(root, 'web'));
  symlinkSync(join(checkout, 'vendor'), join(root, 'vendor'));
  symlinkSync(join(checkout, 'bin/skydeck-keeper'), join(root, 'bin/skydeck-keeper'));
  const assets = loadAssets(platform.files, root);
  let bound = 0;
  const listener = await platform.net.listenHttp(
    { host: '127.0.0.1', port: 0 },
    { request: httpHandler(assets, () => bound) },
  );
  bound = listener.port;
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${bound}/`, port: bound };
}

/** Listeners of the sandbox on another loopback address, 127.0.0.2: TCP and UDP; what reached them. */
async function otherLoopback(
  t: TestContext,
): Promise<{ tcp: number; udp: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((socket) => {
    seen.push('tcp connection');
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.2', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const udp = createSocket('udp4');
  udp.on('message', () => seen.push('udp datagram'));
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.2', resolve));
  t.after(() => new Promise<void>((resolve) => udp.close(() => resolve())));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { tcp: address.port, udp: udp.address().port, seen };
}

/** One `node --test` of a file of test-page/fixtures/ in the sandbox; its exit code and TAP output. */
async function runChild(
  s: Sandbox,
  fixture: string,
  env: Record<string, string>,
): Promise<{ code: unknown; stdout: string }> {
  return promisify(execFile)(
    process.execPath,
    ['--test', '--test-reporter=tap', join(checkout, 'test-page/fixtures', fixture)],
    { cwd: s.home, env: s.env(env), timeout: 120_000 },
  ).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { code?: unknown; stdout?: string }) => ({
      code: error.code,
      stdout: error.stdout ?? '',
    }),
  );
}

/** The `error:` lines of TAP output, trimmed. */
const errorLines = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('error: '));

/** Everything that went wrong in the page: console errors, uncaught errors, failed loads. */
function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.push(`${response.status()}: ${response.url()}`);
    }
  });
  return problems;
}

test('the page suite: headless Chromium', async (t) => {
  const chromium = await browser(t);

  await t.test('a page from a data: URL evaluates 1 + 1', async (t) => {
    const page = await newPage(t, chromium);
    await page.goto('data:text/html,<!doctype html><title>smoke</title>');

    assert.equal(await page.evaluate(() => 1 + 1), 2);
  });

  await t.test(
    "Chromium runs with a sandbox's environment: another home, no display, its temporary directory and its profile in the sandbox",
    async () => {
      const cdp = await chromium.newBrowserCDPSession();
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      await cdp.detach();
      const main = processInfo.find((p) => p.type === 'browser');
      assert.ok(main, 'the browser process');
      const env = new Map(
        readFileSync(`/proc/${main.id}/environ`, 'utf8')
          .split('\0')
          .filter((entry) => entry !== '')
          .map((entry) => [
            entry.slice(0, entry.indexOf('=')),
            entry.slice(entry.indexOf('=') + 1),
          ]),
      );

      const home = env.get('HOME') ?? '';
      assert.notEqual(home, homedir());
      assert.ok(home.startsWith(SANDBOX_ROOTS), home);
      assert.equal(env.get('SKYDECK_TEST_NO_WINDOWS'), '1');
      assert.equal(env.get('TMPDIR'), join(dirname(home), 'tmp'));
      assert.equal(env.get('DISPLAY'), undefined);
      assert.equal(env.get('WAYLAND_DISPLAY'), undefined);
      // The profile Playwright made for it (in this process's temporary directory at the launch).
      const profile = readFileSync(`/proc/${main.id}/cmdline`, 'utf8')
        .split('\0')
        .filter((arg) => arg.startsWith('--user-data-dir='));
      assert.equal(profile.length, 1, String(profile));
      assert.ok(
        profile[0]?.startsWith(`--user-data-dir=${join(dirname(home), 'tmp')}/`),
        String(profile),
      );
    },
  );

  await t.test(
    "a page's time zone is UTC and its language en-US, whatever the machine's",
    async (t) => {
      const page = await newPage(t, chromium);
      await page.goto('data:text/html,<!doctype html><title>smoke</title>');

      assert.deepEqual(
        await page.evaluate(() => [
          Intl.DateTimeFormat().resolvedOptions().timeZone,
          navigator.language,
        ]),
        ['UTC', 'en-US'],
      );
    },
  );

  await t.test(
    'a page reaches nothing but 127.0.0.1: no host name resolves, and neither fetch, a WebSocket nor WebRTC reaches another loopback address',
    async (t) => {
      const { platform } = testPlatform(t);
      // The page's own server, without the window's policy (which would refuse these itself).
      const hosts: string[] = [];
      const own = await platform.net.listenHttp(
        { host: '127.0.0.1', port: 0 },
        {
          request: (req, res) => {
            hosts.push(req.headers.host ?? '');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><title>probe</title>');
          },
        },
      );
      t.after(() => own.close());
      const other = await otherLoopback(t);
      const page = await newPage(t, chromium);
      await page.goto(`http://127.0.0.1:${own.port}/`);

      const failed = await page.evaluate(
        async ({ port, tcp, udp }) => {
          const fails = (attempt: Promise<unknown>): Promise<boolean> =>
            attempt.then(
              () => false,
              () => true,
            );
          const byName = await fails(fetch(`http://localhost:${port}/`, { mode: 'no-cors' }));
          await fails(fetch(`http://127.0.0.2:${tcp}/`, { mode: 'no-cors' }));
          await new Promise<void>((resolve) => {
            const socket = new WebSocket(`ws://127.0.0.2:${tcp}/`);
            socket.onopen = () => {
              socket.close();
              resolve();
            };
            socket.onerror = () => resolve();
          });
          const rtc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.2:${udp}` }] });
          rtc.createDataChannel('probe');
          await rtc.setLocalDescription(await rtc.createOffer());
          await new Promise<void>((resolve) => {
            const done = (): void => {
              if (rtc.iceGatheringState === 'complete') {
                resolve();
              }
            };
            rtc.onicegatheringstatechange = done;
            done();
            setTimeout(resolve, 5000);
          });
          rtc.close();
          return { byName };
        },
        { port: own.port, tcp: other.tcp, udp: other.udp },
      );

      assert.deepEqual(failed, { byName: true });
      assert.deepEqual(hosts, [`127.0.0.1:${own.port}`]); // the page itself, never by `localhost`
      assert.deepEqual(other.seen, []);
    },
  );

  await t.test(
    'the fixture page under the policy of S2 8.2.1: the vendored modules load and a red cell is red',
    async (t) => {
      const { url, port } = await serveFixture(t);
      const page = await newPage(t, chromium);
      const problems = problemsOf(page);

      const response = await page.goto(url);
      await page
        .waitForFunction(() => 'smoke' in globalThis, null, { timeout: 10_000 })
        .catch((error: unknown) => {
          // what kept the page from getting there is in `problems`
          assert.fail(`${String(error)}\n${problems.join('\n')}`);
        });
      const smoke = (await page.evaluate(() => Reflect.get(globalThis, 'smoke'))) as Smoke;
      const red = page.locator('.xterm-rows span', { hasText: 'red' });
      await red.waitFor();
      const colour = await red.evaluate((cell) => globalThis.getComputedStyle(cell).color);

      assert.ok(response);
      assert.equal(response.status(), 200);
      assert.equal(
        response.headers()['content-security-policy'],
        securityHeaders(port)['Content-Security-Policy'],
      );
      assert.deepEqual(smoke.modules, {
        Terminal: 'function',
        FitAddon: 'function',
        SearchAddon: 'function',
        SerializeAddon: 'function',
        UnicodeGraphemesAddon: 'function',
      });
      assert.equal(smoke.serialized, '\x1b[31mred');
      assert.equal(smoke.unicodeVersion, '15-graphemes');
      assert.equal(colour, 'rgb(255, 0, 0)'); // the theme's red: xterm.js's own <style> elements apply
      assert.deepEqual(problems, []);
    },
  );
});

test('without Chromium for Playwright the page suite fails with the command that installs it', async (t) => {
  const s = sandbox(t);
  const empty = join(s.root, 'no-browsers');
  const tmp = join(s.root, 'tmp');
  mkdirSync(empty);
  mkdirSync(tmp);

  const { code, stdout } = await runChild(s, 'launch.ts', {
    PLAYWRIGHT_BROWSERS_PATH: empty,
    TMPDIR: tmp,
  });

  assert.equal(code, 1);
  assert.deepEqual(errorLines(stdout), [`error: '${NOT_INSTALLED}'`]);
  assert.doesNotMatch(stdout, /Executable doesn't exist/);
  // What Playwright made before it found no browser was in the child's sandbox, which is gone.
  assert.deepEqual(readdirSync(tmp), []);
});

test('a browser that fails to close: its sandbox is removed all the same, and the test fails', async (t) => {
  const s = sandbox(t);
  const tmp = join(s.root, 'tmp');
  mkdirSync(tmp);

  const { code, stdout } = await runChild(s, 'close-fails.ts', {
    PLAYWRIGHT_BROWSERS_PATH: BROWSERS,
    TMPDIR: tmp,
  });

  assert.equal(code, 1);
  assert.deepEqual(errorLines(stdout), ["error: 'the close failed on purpose'"]);
  assert.deepEqual(readdirSync(tmp), []);
});
