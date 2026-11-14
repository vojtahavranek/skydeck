// The page suite's smoke test (S2 8.2.1, 17.4, 17.5; plan task 20): Playwright drives headless
// Chromium, and the page, the server's policy and the vendored xterm.js meet here, in wave 3, not
// only when the window's page is built.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Page } from 'playwright';

import { httpHandler, loadAssets, securityHeaders } from '../src/window/assets.ts';
import { testPlatform } from '../test/helpers/platform.ts';
import { sandbox } from '../test/helpers/sandbox.ts';
import { browser, newPage, NOT_INSTALLED } from './helpers/browser.ts';

const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const FIXTURE = join(checkout, 'test-page/fixtures/xterm-smoke');

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
  mkdirSync(empty);

  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--test', '--test-reporter=tap', join(checkout, 'test-page/fixtures/launch.ts')],
    { cwd: s.home, env: s.env({ PLAYWRIGHT_BROWSERS_PATH: empty }), timeout: 120_000 },
  ).then(
    () => assert.fail('the launch succeeded without a browser'),
    (error: { code?: unknown; stdout?: string }) => {
      assert.equal(error.code, 1);
      return { stdout: error.stdout ?? '' };
    },
  );

  const errors = stdout.split('\n').filter((line) => line.trim().startsWith('error: '));
  assert.deepEqual(
    errors.map((line) => line.trim()),
    [`error: '${NOT_INSTALLED}'`],
  );
  assert.doesNotMatch(stdout, /Executable doesn't exist/);
});
