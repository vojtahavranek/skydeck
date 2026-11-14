// The page shell (S2 6.3, 8.2.5, 12.1, 12.9, 15.3, 15.4, 17.4; plan task 26): the policy, the key
// dispatch over task 31's table, the reload keys, a dropped file, the server gone and back, WSL
// restarted, the keep-alive and tick notices, another asset version, a stand-in's service worker,
// and the retries. Real test servers run on realTestPlatform with real keepers and the stand-in
// program (test/helpers/window.ts); stand-in servers come from helpers/shell.ts.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, CDPSession, Page } from 'playwright';

import type { Detached, Platform } from '../src/platform/types.ts';
import { securityHeaders } from '../src/window/assets.ts';
import { controlClient } from '../src/window/client.ts';
import { procStartOf, sleep, stillRuns, until } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { startTestServer } from '../test/helpers/window.ts';
import type {
  ServerSandbox,
  ServerSandboxOptions,
  StartedServer,
  StartOptions,
} from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  after,
  assetBase,
  connection,
  holdWriteLock,
  honest,
  logOf,
  mark,
  PAGE_WAIT_MS,
  pageUrl,
  problemsOf,
  RECORDER,
  shownText,
  showsText,
  standinServer,
  storeKey,
  wrongProof,
} from './helpers/shell.ts';
import type { Logged } from './helpers/shell.ts';

const checkout = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
/** S2 6.1: the Windows client the keep-alive is. */
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe';

const GONE =
  /^skydeck's server is not answering \(since \d\d:\d\d:\d\d\)\. Sessions in the window keep running unless WSL has stopped\. To get back, open a WSL terminal and run: skydeck window$/;
const RESTARTED = /^skydeck's server restarted; your sessions kept running$/;
const WSL_RESTARTED =
  /^WSL has restarted since \d\d:\d\d:\d\d: the sessions that were running have ended\.$/;
const PLACEHOLDER = /terminal view comes with task 28/;
const STALE =
  "this window's page is not the one skydeck's server serves, and reloading did not change that; close every skydeck window, delete the window's profile folder and run skydeck window --new-secret";

const STALE_UNKNOWN =
  "this window's page is not the one skydeck's server serves, and it cannot tell whether it reloaded already; press F5 to reload it, or close it and run skydeck window";

/** `text` as a regular expression that matches it literally. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Launched extends Omit<StartedServer, 'page'> {
  page: Page;
  problems: string[];
}

/**
 * A page with the recorder (made first, so that it closes first), a real test server, and the
 * page opened with a launch token of that server, as `skydeck window` opens it; connected.
 */
async function launched(
  t: TestContext,
  chromium: Browser,
  options: ServerSandboxOptions & { server?: StartOptions } = {},
): Promise<Launched> {
  const page = await newPage(t, chromium);
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
async function zone(page: Page): Promise<string> {
  return shownText(page, '#focus-zone');
}

/** Puts the page into `wanted` with Ctrl+Shift+L when it is in the other zone. */
async function toZone(page: Page, wanted: 'list' | 'terminal'): Promise<void> {
  if ((await zone(page)) !== `Focus: ${wanted}`) await page.keyboard.press('Control+Shift+L');
  await showsText(page, '#focus-zone', new RegExp(`^Focus: ${wanted}$`));
}

/** The session id of the selected row of the list. */
async function selectedRow(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') ?? null,
  );
}

/** The keyboard's BrowserRefresh key, which Playwright's keyboard does not know: through CDP. */
async function browserRefresh(
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

/** Presses `key` (a Playwright key, or BrowserRefresh with or without a modifier). */
async function press(page: Page, cdp: CDPSession, key: string): Promise<void> {
  const refresh = /^(?:(Shift|Control)\+)?BrowserRefresh$/.exec(key);
  if (refresh === null) await page.keyboard.press(key);
  else await browserRefresh(cdp, (refresh[1] as 'Shift' | 'Control' | undefined) ?? null);
}

/** Whether `log` (after a key) reloaded only after a new socket's welcome: [ws s, in welcome s, unload]. */
function reloadedAfterProof(log: Logged[]): boolean {
  const unload = log.findIndex((entry) => entry.e === 'unload');
  if (unload === -1) return false;
  const before = log.slice(0, unload);
  const fresh = before.filter((entry) => entry.e === 'ws').map((entry) => entry.s);
  return before.some(
    (entry) => entry.e === 'in' && entry.t === 'welcome' && fresh.includes(entry.s),
  );
}

/** The terminal of `sessionId` in the server's hub. */
function termOf(started: { server: StartedServer['server'] }, sessionId: string): string {
  const term = started.server.hub.list().find((info) => info.expectedSessionId === sessionId);
  assert.ok(
    term !== undefined,
    `a terminal for ${sessionId} in ${JSON.stringify(started.server.hub.list(), (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`,
  );
  return term.id;
}

/**
 * Clicks the list's row of `sessionId` until it is the selected one: the minimal list draws its
 * rows anew for every list, so a click can meet a row that moved.
 */
async function clickRow(page: Page, sessionId: string): Promise<void> {
  const row = page.locator(`#list [data-id="${sessionId}"]`);
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    await row.waitFor({ timeout: PAGE_WAIT_MS });
    await row.click().catch(() => {});
    if ((await selectedRow(page)) === sessionId) return;
    assert.ok(performance.now() < deadline, `the row of ${sessionId} selected`);
    await sleep(100);
  }
}

/**
 * Resumes `sessionId` from the list as a user does: a click selects its row (a session that is
 * not running: the list zone), Enter resumes it, and the pane shows its terminal.
 */
async function resumeFromList(page: Page, sessionId: string): Promise<void> {
  await clickRow(page, sessionId);
  await showsText(page, '#focus-zone', /^Focus: list$/);
  await page.keyboard.press('Enter');
  await showsText(page, '#terminal', PLACEHOLDER);
}

/** Another app root for a server: this checkout's bin, src and vendor, and a web/ with one more file. */
function otherAppRoot(d: ServerSandbox): string {
  const root = join(d.s.root, 'other-app');
  mkdirSync(root);
  for (const dir of ['bin', 'src', 'vendor']) symlinkSync(join(checkout, dir), join(root, dir));
  cpSync(join(checkout, 'web'), join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web', 'another-build.txt'), 'a file that makes another build\n');
  return root;
}

/** The build a page was loaded with, from its asset URLs. */
async function buildOf(page: Page): Promise<string> {
  const match = /\/assets\/([^/]+)\/web\/$/.exec(await assetBase(page));
  assert.ok(match !== null);
  return match[1] as string;
}

test('the page shell', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "the page of a real server loads its files under the server's policy, connects and reports no problem",
    async (t) => {
      const page = await newPage(t, chromium);
      const problems = problemsOf(page);
      const started = await startTestServer(t);
      const { token } = await controlClient(
        started.d.platform.net,
        started.d.files.serverSock,
      ).token(30);

      const response = await page.goto(pageUrl(started.server.port, token));
      await connection(page, 'open');
      await sleep(1500);

      assert.equal(
        response?.headers()['content-security-policy'],
        securityHeaders(started.server.port)['Content-Security-Policy'],
      );
      assert.deepEqual(problems, []);
      assert.match(await zone(page), /^Focus: terminal$/, 'the terminal is the default zone');
    },
  );

  await t.test(
    "an inline script put into the served page by a stand-in server does not run; the page's own modules do",
    async (t) => {
      const standin = await standinServer(t, {
        index: { inject: "<script>document.documentElement.dataset.injected = 'ran';</script>" },
      });
      const page = await newPage(t, chromium);
      const problems = problemsOf(page);

      await page.goto(standin.url);
      await showsText(page, '#problem', /^this window has no key; /); // app.js ran

      assert.equal(await page.evaluate(() => document.documentElement.dataset.injected), undefined);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(
        problems[0] ?? '',
        /^console: Executing inline script violates the following Content Security Policy directive 'script-src 'self''/,
      );
    },
  );

  await t.test(
    'keys: the page cancels exactly the keys it handles; Alt+F4 and keys no zone uses are not cancelled; the keys of later stages say so',
    async (t) => {
      const standin = await standinServer(t);
      const page = await newPage(t, chromium);
      await page.addInitScript(() => {
        const seen: { key: string; prevented: boolean }[] = [];
        Reflect.set(globalThis, 'keysSeen', seen);
        // First in the capture phase; read once the event has been dispatched. The modifiers'
        // own keydowns are left out: the entry of a chord is its key's.
        addEventListener(
          'keydown',
          (event) => {
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
            setTimeout(() => seen.push({ key: event.key, prevented: event.defaultPrevented }), 0);
          },
          true,
        );
      });
      await page.goto(standin.url);
      await showsText(page, '#problem', /^this window has no key; /);
      const pressed = async (key: string): Promise<boolean> => {
        const before = (await page.evaluate(
          () => Reflect.get(globalThis, 'keysSeen').length,
        )) as number;
        await page.keyboard.press(key);
        await page.waitForFunction(
          (n) => (Reflect.get(globalThis, 'keysSeen') as unknown[]).length > n,
          before,
        );
        const seen = (await page.evaluate(() => Reflect.get(globalThis, 'keysSeen'))) as {
          key: string;
          prevented: boolean;
        }[];
        assert.equal(seen.length, before + 1, `one keydown for ${key}`);
        return (seen.at(-1) as { prevented: boolean }).prevented;
      };

      // The terminal zone (the default).
      assert.match(await zone(page), /^Focus: terminal$/);
      const terminalZone: [string, boolean][] = [
        ['Control+Shift+P', true],
        ['Control+Shift+J', true],
        ['Control+Shift+F', true],
        ['Control+Shift+C', true],
        ['Control+Shift+V', true],
        ['Control+Shift+O', true],
        ['Control+Tab', true],
        ['Control+Shift+Digit1', true],
        ['Control+Shift+R', true],
        ['Shift+Enter', true],
        ['Alt+F4', false],
        ['Control+Shift+Minus', false],
        ['x', false],
        ['Escape', false],
      ];
      for (const [key, cancelled] of terminalZone) {
        assert.equal(await pressed(key), cancelled, `${key} in the terminal zone`);
      }
      await page.keyboard.press('Control+Shift+P');
      await showsText(page, '#key-message', /^Ctrl\+Shift\+P: comes in a later stage$/);
      await page.keyboard.press('Control+Shift+J');
      await showsText(page, '#key-message', /^Ctrl\+Shift\+J: comes in a later stage$/);

      assert.equal(await pressed('Control+Shift+H'), true);
      await page.waitForSelector('#help:not([hidden])');
      assert.equal(await pressed('Control+Shift+H'), true);
      await page.waitForSelector('#help[hidden]', { state: 'attached' });

      assert.equal(await pressed('Control+Shift+L'), true);
      await showsText(page, '#focus-zone', /^Focus: list$/);
      const listZone: [string, boolean][] = [
        ['j', true],
        ['k', true],
        ['ArrowDown', true],
        ['Home', true],
        ['PageDown', true],
        ['ArrowLeft', true],
        ['Enter', true],
        ['a', true],
        ['F5', true],
        ['Control+r', true],
        ['Alt+F4', false],
        ['Control+Shift+Minus', false],
        ['x', false],
        ['Control+Shift+P', true],
      ];
      for (const [key, cancelled] of listZone) {
        assert.equal(await pressed(key), cancelled, `${key} in the list zone`);
      }
      for (const [key, name] of [
        ['l', 'l'],
        ['g', 'g'],
        ['n', 'n'],
        ['p', 'p'],
        ['d', 'd'],
        ['F2', 'F2'],
      ]) {
        assert.equal(await pressed(key as string), true, `${key} in the list zone`);
        await showsText(page, '#key-message', new RegExp(`^${name}: comes in a later stage$`));
      }
      // `/` gives the filter the keyboard: then `j` types there and is not cancelled.
      assert.equal(await pressed('/'), true);
      assert.equal(await pressed('j'), false);
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value),
        'j',
      );
      assert.equal(await pressed('Control+Shift+L'), true, 'a chord in a text field');
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
    },
  );

  await t.test(
    'in a normal browser tab the key bar names Ctrl+Shift+O and the + New button, which opens the new form',
    async (t) => {
      const standin = await standinServer(t);
      const page = await newPage(t, chromium);
      await page.goto(standin.url);
      await showsText(page, '#problem', /^this window has no key; /);

      assert.equal(
        await page.evaluate(() => matchMedia('(display-mode: standalone)').matches),
        false,
      );
      const hints = await page.locator('.keybar .hint:visible').allTextContents();
      assert.ok(hints.includes('Ctrl+Shift+O previous'), hints.join(' | '));
      assert.ok(!hints.includes('Ctrl+Tab previous'), hints.join(' | '));
      assert.ok(hints.includes('+ New'), hints.join(' | '));
      await page.locator('#new-button').click();
      await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
    },
  );

  await t.test(
    '`input` is split into messages of at most 64 KiB of UTF-8, in order, never inside a character',
    async (t) => {
      const standin = await standinServer(t);
      const page = await newPage(t, chromium);
      await page.goto(standin.url);
      const base = await assetBase(page);

      const got = await page.evaluate(async (base) => {
        const { splitInput } = (await import(`${base}connection.js`)) as {
          splitInput(data: string, binary?: boolean): string[];
        };
        const bytes = (text: string): number => new TextEncoder().encode(text).length;
        const cases = {
          ascii: 'a'.repeat(200_000),
          // 65,535 bytes, then a four-byte character that must not be cut
          pair: `${'a'.repeat(65_535)}😀b`,
          mixed: 'žluťoučký kůň 😀 '.repeat(10_000),
          lone: 'a\ud800b',
        };
        return {
          parts: Object.fromEntries(
            Object.entries(cases).map(([name, text]) => {
              const parts = splitInput(text);
              return [
                name,
                {
                  joined: parts.join('') === text.toWellFormed(),
                  max: Math.max(...parts.map(bytes)),
                  wellFormed: parts.every((part) => part.isWellFormed()),
                  count: parts.length,
                },
              ];
            }),
          ),
          binary: splitInput('\u00ff'.repeat(70_000), true).map((part) => part.length),
          empty: splitInput(''),
        };
      }, base);

      assert.deepEqual(got.parts['ascii'], {
        joined: true,
        max: 65_536,
        wellFormed: true,
        count: 4,
      });
      assert.deepEqual(got.parts['pair'], {
        joined: true,
        max: 65_535,
        wellFormed: true,
        count: 2,
      });
      assert.equal(got.parts['mixed']?.joined, true);
      assert.ok((got.parts['mixed']?.max ?? Infinity) <= 65_536);
      assert.equal(got.parts['mixed']?.wellFormed, true);
      assert.deepEqual(got.parts['lone'], { joined: true, max: 5, wellFormed: true, count: 1 });
      assert.deepEqual(got.binary, [65_536, 4464]);
      assert.deepEqual(got.empty, []);
    },
  );

  await t.test('a dropped file does not navigate the window', async (t) => {
    const standin = await standinServer(t);
    const page = await newPage(t, chromium);
    await page.goto(standin.url);
    await showsText(page, '#problem', /^this window has no key; /);

    const cancelled = await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'dropped.txt', { type: 'text/plain' }));
      return ['#list', '#terminal', 'body'].flatMap((selector) => {
        const target = document.querySelector(selector) as Element;
        return ['dragover', 'drop'].map(
          (type) =>
            !target.dispatchEvent(
              new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
            ),
        );
      });
    });
    const cdp = await page.context().newCDPSession(page);
    const file = join(checkout, 'README.md');
    const at = { x: 300, y: 300 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', {
        type,
        ...at,
        data: { items: [], files: [file], dragOperationsMask: 1 },
      });
    }
    await sleep(1000);

    assert.deepEqual(cancelled, [true, true, true, true, true, true]);
    assert.equal(page.url(), standin.url);
  });

  await t.test(
    'resume from the list, slots, Ctrl+Tab; the server stopped → the bar within 4 s; started again → "restarted", the list back, the shown terminal attached first and the next after its snap',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2, join(d.s.home, 'other'));
      for (const id of [S1, S2]) {
        await page.locator(`#list [data-id="${id}"]`).waitFor({ timeout: PAGE_WAIT_MS });
      }

      await resumeFromList(page, S1);
      await resumeFromList(page, S2);
      const term1 = termOf(l, S1);
      const term2 = termOf(l, S2);
      const snaps = async (term: string): Promise<number> =>
        (await logOf(page)).filter(
          (entry) => entry.e === 'in' && entry.t === 'snap' && entry.term === term,
        ).length;
      assert.ok((await snaps(term1)) >= 1 && (await snaps(term2)) >= 1, 'both attached');

      // Slots (S2 12.9): 1 and 2 are the two terminals in the order they were opened.
      await page.keyboard.press('Control+Shift+Digit1');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S1,
      );
      assert.equal(await zone(page), 'Focus: terminal');
      await page.keyboard.press('Control+Shift+Digit2');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
      );
      await page.keyboard.press('Control+Tab');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S1,
      );
      await page.keyboard.press('Control+Shift+O');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
      );
      assert.equal(await selectedRow(page), S2);

      const port = l.server.port;
      await mark(page, 'stop');
      const stopped = performance.now();
      await l.server.stop('the test stops it');
      await showsText(page, '#gone-text', GONE, 4000);
      assert.ok(performance.now() - stopped < 4000);

      await d.start({ port });
      await showsText(page, '#info-text', RESTARTED);
      await connection(page, 'open');
      assert.equal(await shownText(page, '#gone'), '');
      await page.locator(`#list [data-id="${S1}"]`).waitFor({ timeout: PAGE_WAIT_MS });
      await page.locator(`#list [data-id="${S2}"]`).waitFor({ timeout: PAGE_WAIT_MS });
      const order = async (): Promise<string[]> =>
        after(await logOf(page), 'stop')
          .filter(
            (entry) =>
              (entry.e === 'out' && entry.t === 'attach') ||
              (entry.e === 'in' && entry.t === 'snap'),
          )
          .map(
            (entry) =>
              `${entry.e === 'out' ? 'attach' : 'snap'} ${entry.term === term1 ? 1 : entry.term === term2 ? 2 : '?'}`,
          );
      const deadline = performance.now() + PAGE_WAIT_MS;
      while ((await order()).length < 4 && performance.now() < deadline) await sleep(100);
      assert.deepEqual(await order(), ['attach 2', 'snap 2', 'attach 1', 'snap 1']);
      assert.deepEqual(
        l.problems.filter((p) => !/ERR_CONNECTION_REFUSED|WebSocket/.test(p)),
        [],
      );
    },
  );

  await t.test(
    'a server with another boot id → "WSL has restarted since <time>…", the time the page lost the old server',
    async (t) => {
      const l = await launched(t, chromium);
      const port = l.server.port;
      await l.server.stop('the test stops it');
      const gone = await showsText(l.page, '#gone-text', GONE, 4000);
      await sleep(1500); // the welcome comes in a later second than the loss

      await l.d.start({
        port,
        platform: (p: Platform) => ({ ...p, proc: { ...p.proc, bootId: () => 'another-boot-id' } }),
      });
      const restarted = await showsText(l.page, '#info-text', WSL_RESTARTED);
      await connection(l.page, 'open');
      const time = (text: string): string | undefined => /\d\d:\d\d:\d\d/.exec(text)?.[0];
      assert.equal(time(restarted), time(gone), 'the time the page lost the old server');

      // The notice stays until it is dismissed.
      await sleep(1000);
      assert.match(await shownText(l.page, '#info-text'), WSL_RESTARTED);
      await l.page.locator('#info-close').click();
      await l.page.waitForSelector('#info[hidden]', { state: 'attached' });
    },
  );

  await t.test(
    'the keep-alive failed in welcome → "WSL is not kept running" in the title bar',
    async (t) => {
      const l = await launched(t, chromium, {
        env: { WSL_DISTRO_NAME: 'Test' },
        window: { keepAlive: 'wsl' },
      });
      await showsText(l.page, '#keepalive', /^WSL is not kept running$/);
    },
  );

  await t.test(
    'a keepalive-lost notice → "WSL is not kept running" in the title bar until keepalive-back',
    async (t) => {
      // The keep-alive on wsl, its wsl.exe never run: the script it would run runs in its place, a
      // process this test started and ends itself (as in test/window/server.test.ts).
      const scripts: { child: Detached; procStart: number | null }[] = [];
      t.after(async () => {
        for (const script of scripts) {
          if (script.procStart !== null && stillRuns(script.child.pid, script.procStart)) {
            process.kill(script.child.pid, 'SIGTERM');
          }
          await Promise.race([script.child.exited, sleep(10_000)]);
        }
      });
      const l = await launched(t, chromium, {
        env: { WSL_DISTRO_NAME: 'Test' },
        window: { keepAlive: 'wsl' },
        server: {
          platform: (p: Platform) => ({
            ...p,
            processes: {
              async startDetached(command, args, options) {
                if (command !== WSL_EXE) return p.processes.startDetached(command, args, options);
                const at = args.indexOf('--exec');
                const child = await p.processes.startDetached(
                  args[at + 1] ?? '',
                  args.slice(at + 2),
                  options,
                );
                scripts.push({ child, procStart: procStartOf(child.pid) });
                return child;
              },
              signal: () => false,
            },
          }),
        },
      });
      const client = controlClient(l.d.platform.net, l.d.files.serverSock);
      const deadline = performance.now() + PAGE_WAIT_MS;
      while ((await client.status()).keepAlive.state !== 'running') {
        assert.ok(performance.now() < deadline, 'the keep-alive runs');
        await sleep(100);
      }
      await sleep(500);
      assert.equal(await shownText(l.page, '#keepalive'), '');

      const [first] = scripts;
      assert.ok(first !== undefined && first.procStart !== null);
      process.kill(first.child.pid, 'SIGTERM');
      await showsText(l.page, '#keepalive', /^WSL is not kept running$/);
      await until(() => scripts.length === 2, 'the keep-alive started again', PAGE_WAIT_MS);
      await l.page.waitForSelector('#keepalive[hidden]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
    },
  );

  await t.test('a tick-failed notice is shown until the next list', async (t) => {
    const l = await launched(t, chromium);
    l.d.resumable(S1);
    await l.page.locator(`#list [data-id="${S1}"]`).waitFor({ timeout: PAGE_WAIT_MS });

    const lock = holdWriteLock(t, join(l.d.s.skydeckHome, 'data', 'skydeck.db'));
    await lock.held;
    l.d.resumable(S2, join(l.d.s.home, 'other')); // the refresh must write, and meets the lock
    await showsText(l.page, '#tick', /^skydeck could not refresh the list: .+; it tries again$/);
    lock.release();
    await l.page.locator(`#list [data-id="${S2}"]`).waitFor({ timeout: PAGE_WAIT_MS });
    assert.equal(await shownText(l.page, '#tick'), '');
  });

  await t.test('a server with another asset version → the page reloads itself, once', async (t) => {
    const l = await launched(t, chromium);
    const port = l.server.port;
    const before = await buildOf(l.page);
    await mark(l.page, 'other build');
    await l.server.stop('the test stops it');
    await showsText(l.page, '#gone-text', GONE, 4000);

    const other = await l.d.start({
      port,
      platform: (p: Platform) => ({ ...p, appRoot: otherAppRoot(l.d) }),
    });
    assert.notEqual(other.server.build, before);
    const deadline = performance.now() + PAGE_WAIT_MS;
    while (!after(await logOf(l.page), 'other build').some((e) => e.e === 'unload')) {
      assert.ok(performance.now() < deadline, 'the page reloads');
      await sleep(100);
    }
    await l.page.waitForLoadState('load');
    await connection(l.page, 'open');
    assert.equal(await buildOf(l.page), other.server.build);
    await sleep(2000);
    assert.equal(
      after(await logOf(l.page), 'other build').filter((e) => e.e === 'unload').length,
      1,
      'one reload',
    );
  });

  await t.test(
    "reload keys reload only after a new connection and the server's proof: in the list zone, in the terminal zone, and in the terminal zone while the page has the keyboard",
    async (t) => {
      const l = await launched(t, chromium);
      const { page } = l;
      l.d.resumable(S1);
      await resumeFromList(page, S1); // the placeholder pane: the page, not xterm.js, has the keyboard
      const cdp = await page.context().newCDPSession(page);
      const keys: ['list' | 'terminal', string][] = [
        ['list', 'F5'],
        ['list', 'Shift+F5'],
        ['list', 'Control+r'],
        ['list', 'Control+Shift+R'],
        ['list', 'Control+F5'],
        ['list', 'BrowserRefresh'],
        ['list', 'Shift+BrowserRefresh'],
        ['list', 'Control+BrowserRefresh'],
        ['terminal', 'Control+Shift+R'],
        ['terminal', 'BrowserRefresh'],
        ['terminal', 'F5'],
        ['terminal', 'Control+r'],
        ['terminal', 'Shift+F5'],
        ['terminal', 'Control+F5'],
      ];
      for (const [wanted, key] of keys) {
        const name = `${wanted} ${key}`;
        await connection(page, 'open');
        await showsText(page, '#terminal', PLACEHOLDER);
        await toZone(page, wanted);
        await mark(page, name);
        await press(page, cdp, key);
        const deadline = performance.now() + PAGE_WAIT_MS;
        while (!after(await logOf(page), name).some((e) => e.e === 'unload')) {
          assert.ok(performance.now() < deadline, `${name} reloads`);
          await sleep(100);
        }
        await page.waitForLoadState('load');
        assert.ok(reloadedAfterProof(after(await logOf(page), name)), `${name}: after the proof`);
      }
    },
  );

  await t.test(
    'against a stand-in server without a proof the reload keys reload nothing',
    async (t) => {
      const standin = await standinServer(t, { socket: wrongProof });
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      await page.goto(standin.url);
      await storeKey(page, new Uint8Array(32).fill(7));
      await page.goto(standin.url);
      await showsText(
        page,
        '#problem',
        /^something answers on port \d+ that is not skydeck's server/,
      );
      const cdp = await page.context().newCDPSession(page);
      for (const [wanted, key] of [
        ['list', 'F5'],
        ['list', 'Control+r'],
        ['terminal', 'Control+Shift+R'],
        ['terminal', 'BrowserRefresh'],
        ['terminal', 'F5'],
      ] as const) {
        const name = `${wanted} ${key}`;
        await toZone(page, wanted);
        const connections = standin.connections.length;
        await mark(page, name);
        await press(page, cdp, key);
        await until(
          () =>
            standin.connections.length > connections &&
            (standin.connections.at(-1)?.received.length ?? 0) > 0,
          `${name}: a new connection's hello`,
          PAGE_WAIT_MS,
        );
        await sleep(1000);
        assert.deepEqual(
          after(await logOf(page), name).filter((e) => e.e === 'unload'),
          [],
          `${name} did not reload`,
        );
      }
      assert.equal(page.url(), standin.url);
    },
  );

  await t.test(
    'a 503 at the upgrade, a close 1013 at the hello and a drop right after the challenge are retried, without saying that something else answers',
    async (t) => {
      const secret = new Uint8Array(32).fill(9);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      const plain = await standinServer(t);
      await page.goto(plain.url);
      const build = await buildOf(page);
      await plain.close();
      const standin = await standinServer(t, {
        refuse: 2,
        socket: honest(secret, {
          assetVersion: build,
          before: (n) => (n === 1 ? 'close-1013' : n === 2 ? 'drop' : null),
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);

      await connection(page, 'open');
      assert.ok(standin.upgrades() >= 5, `${standin.upgrades()} upgrades`);
      assert.equal(await shownText(page, '#problem'), '');
      assert.equal(await shownText(page, '#gone'), '');
    },
  );

  await t.test(
    'a server whose asset version never matches the page: exactly one reload, then the line that says what to do',
    async (t) => {
      const secret = new Uint8Array(32).fill(4);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      const standin = await standinServer(t, {
        socket: honest(secret, { assetVersion: 'another-build' }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await mark(page, 'never matches');

      await page.goto(standin.url);
      await showsText(page, '#problem', new RegExp(`^${escape(STALE)}$`));
      await connection(page, 'fatal');
      await sleep(2000);

      const log = after(await logOf(page), 'never matches');
      assert.equal(
        log.filter((entry) => entry.e === 'unload').length,
        2,
        'the goto and one reload',
      );
      assert.equal(
        log.filter((entry) => entry.e === 'out' && entry.t === 'start').length,
        0,
        'no start for a server of another version',
      );
      assert.equal(standin.connections.length, 2);
    },
  );

  await t.test(
    'a page without session storage that meets another asset version does not reload on its own, and says so truthfully',
    async (t) => {
      const secret = new Uint8Array(32).fill(6);
      const page = await newPage(t, chromium);
      const standin = await standinServer(t, {
        socket: honest(secret, { assetVersion: 'another-build' }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      // The page cannot remember that it reloaded: every use of session storage throws.
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'sessionStorage', {
          get() {
            throw new DOMException('session storage is not available', 'SecurityError');
          },
        });
      });
      let loads = 0;
      page.on('load', () => loads++);

      await page.goto(standin.url);
      await showsText(page, '#problem', new RegExp(`^${escape(STALE_UNKNOWN)}$`));
      await connection(page, 'fatal');
      await sleep(2000);

      assert.equal(loads, 1, 'no reload of its own');
      assert.equal(standin.connections.length, 1);
    },
  );

  await t.test('no pong for 3 seconds → the bar within 4 s', async (t) => {
    const secret = new Uint8Array(32).fill(5);
    const page = await newPage(t, chromium);
    const plain = await standinServer(t);
    await page.goto(plain.url);
    const build = await buildOf(page);
    await plain.close();
    const standin = await standinServer(t, {
      socket: honest(secret, { assetVersion: build, pings: false }),
    });
    await page.goto(standin.url);
    await storeKey(page, secret);
    await page.goto(standin.url);
    await connection(page, 'open');
    const opened = performance.now();

    await showsText(page, '#gone-text', GONE, 4500);
    assert.ok(performance.now() - opened < 4500);
  });

  await t.test(
    "a record of Chromium's behaviour (S2 15.3, 17.4, W25): a stand-in server's service worker, then the real server answers its script with 404 — what the next loads show",
    async (t) => {
      const page = await newPage(t, chromium);
      const standin = await standinServer(t, {
        index: {
          html: '<!doctype html><title>stand-in</title><script src="/register.js"></script><p id="standin">the stand-in</p>',
        },
        routes: {
          '/register.js': {
            type: 'text/javascript; charset=utf-8',
            body: "navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => { document.documentElement.dataset.worker = 'ready'; });",
          },
          '/sw.js': {
            type: 'text/javascript; charset=utf-8',
            body: [
              "self.addEventListener('install', () => self.skipWaiting());",
              "self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));",
              "self.addEventListener('fetch', (event) => {",
              "  if (event.request.mode === 'navigate') {",
              "    event.respondWith(new Response('<!doctype html><title>worker</title><p id=\"worker\">from the worker</p>', { headers: { 'Content-Type': 'text/html' } }));",
              '  }',
              '});',
            ].join('\n'),
          },
        },
      });
      const port = standin.port;
      await page.goto(standin.url);
      await page.waitForSelector('html[data-worker="ready"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await page.reload();
      assert.equal(
        await page.locator('#worker').count(),
        1,
        'the worker answers while the stand-in runs',
      );
      await standin.close();

      const started = await startTestServer(t, { server: { port } });
      assert.equal(started.server.port, port);
      await page.goto(pageUrl(port));
      const first = (await page.locator('#worker').count()) === 1 ? 'the worker' : 'the server';
      const updated = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        if (registration === undefined) return 'no registration';
        return registration.update().then(
          () => 'update resolved',
          (error: unknown) => `update rejected: ${String(error)}`,
        );
      });
      await page.goto(pageUrl(port));
      const second = (await page.locator('#worker').count()) === 1 ? 'the worker' : 'the server';
      const registrations = await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistrations()).length,
      );
      t.diagnostic(
        `service worker (Chromium): the first load after the real server came back was answered by ${first}; registration.update() ${updated}; the next load by ${second}; registrations left: ${registrations}`,
      );
    },
  );
});
