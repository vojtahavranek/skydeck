// The page shell (S2 6.3, 8.2.5, 12.1, 12.9, 15.3, 15.4, 17.4; plan task 26): the policy, the key
// dispatch over task 31's table, the reload keys, a dropped file, the server gone and back, WSL
// restarted, the keep-alive and tick notices, another asset version, a stand-in's service worker,
// and the retries. Real test servers run on realTestPlatform with real keepers and the stand-in
// program (test/helpers/window.ts); stand-in servers come from helpers/shell.ts.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Detached, Platform } from '../src/platform/types.ts';
import { securityHeaders } from '../src/window/assets.ts';
import { controlClient } from '../src/window/client.ts';
import { procStartOf, sleep, stillRuns, until } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { startTestServer } from '../test/helpers/window.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser } from './helpers/browser.ts';
import {
  active,
  after,
  assetBase,
  buildOf,
  clickRow,
  escape,
  launched as launchedUnpinned,
  MINIMAL_MODULES,
  fixture,
  pinModules,
  pinnedPage,
  unservedPins,
  PLACEHOLDER,
  press,
  RESTARTED,
  resumeFromList,
  scriptedList,
  selectedRow,
  TERM_A,
  TERM_B,
  TERM_C,
  termOf,
  toZone,
  zone,
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

// ONE place for the whole file: the page shell's own tests run on the pinned minimal modules
// (test-page/fixtures/minimal-*, verbatim copies of web/'s placeholders at 40f7886), on stand-in
// servers and on real test servers alike, so that the real modules of tasks 27–29 change
// nothing here. Each real module is tested with the shell by its own task, in its own file.
const newPage = pinnedPage;
const launched: typeof launchedUnpinned = (t, chromium, options = {}) =>
  launchedUnpinned(t, chromium, {
    ...options,
    modules: { ...MINIMAL_MODULES, ...options.modules },
  });
/** S2 6.1: the Windows client the keep-alive is. */
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe';

const GONE =
  /^skydeck's server is not answering \(since \d\d:\d\d:\d\d\)\. Sessions in the window keep running unless WSL has stopped\. To get back, open a WSL terminal and run: skydeck window$/;
const WSL_RESTARTED =
  /^WSL has restarted since \d\d:\d\d:\d\d: the sessions that were running have ended\.$/;
const STALE =
  "this window's page is not the one skydeck's server serves, and reloading did not change that; close every skydeck window, delete the window's profile folder and run skydeck window --new-secret";

const STALE_UNKNOWN =
  "this window's page is not the one skydeck's server serves, and it cannot tell whether it reloaded already; press Ctrl+Shift+R to reload it, or close it and run skydeck window";
const STALE_UNSTORED =
  "this window's page is not the one skydeck's server serves, and its key could not be stored, so it cannot reload itself; run skydeck window again";
const UNSTORED =
  "this window's key could not be stored: the window works until it is reloaded or closed, and its reload keys do not reload it; run skydeck window again for a window that keeps its key";

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

/** Another app root for a server: this checkout's bin, src and vendor, and a web/ with one more file. */
function otherAppRoot(d: ServerSandbox): string {
  const root = join(d.s.root, 'other-app');
  mkdirSync(root);
  for (const dir of ['bin', 'src', 'vendor']) symlinkSync(join(checkout, dir), join(root, dir));
  cpSync(join(checkout, 'web'), join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web', 'another-build.txt'), 'a file that makes another build\n');
  return root;
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
      // Every key through pressed(), so that each reads its own entry.
      assert.equal(await pressed('Control+Shift+P'), true);
      await showsText(page, '#key-message', /^Ctrl\+Shift\+P: comes in a later stage$/);
      assert.equal(await pressed('Control+Shift+J'), true);
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
      // Its button takes Enter, also in the list zone: a focused button is no list.
      await toZone(l.page, 'list');
      await l.page.focus('#info-close');
      await l.page.keyboard.press('Enter');
      await l.page.waitForSelector('#info[hidden]', { state: 'attached' });
      // Pressed from the keyboard, the × hid itself: the zone has the keyboard again.
      assert.equal(await active(l.page), '#list');
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
      assert.ok(stillRuns(first.child.pid, first.procStart), 'the keep-alive script still runs');
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

  await t.test(
    'Enter on a focused button presses it, also in the list zone: + New opens the form and nothing is resumed',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await clickRow(l.page, S1); // a session that is not running, selected in the list zone
      await showsText(l.page, '#focus-zone', /^Focus: list$/);
      await mark(l.page, 'enter on + New');

      await l.page.focus('#new-button');
      await l.page.keyboard.press('Enter');
      await l.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await sleep(1000);

      assert.deepEqual(
        after(await logOf(l.page), 'enter on + New').filter((e) => e.e === 'out' && e.t === 'act'),
        [],
      );
      assert.deepEqual(l.server.hub.list(), []);
    },
  );

  await t.test('Esc in the new form closes it', async (t) => {
    const standin = await standinServer(t);
    const page = await newPage(t, chromium);
    await page.goto(standin.url);
    await showsText(page, '#problem', /^this window has no key; /);
    await page.keyboard.press('Control+Shift+N');
    await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });

    await page.keyboard.press('Escape');
    await page.waitForSelector('#right-zone:not([data-pane="new"])', { state: 'attached' });
  });

  await t.test(
    'Esc in the list zone gives the list its filter to clear, then goes back to the terminal',
    async (t) => {
      const standin = await standinServer(t);
      const page = await newPage(t, chromium);
      await page.goto(standin.url);
      await showsText(page, '#problem', /^this window has no key; /);
      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('zz');
      await page.focus('#list'); // the keyboard back on the list itself

      await page.keyboard.press('Escape');
      assert.equal(await page.inputValue('#list input'), '', 'the field is cleared');
      assert.equal(await zone(page), 'Focus: list');
      await page.keyboard.press('Escape');
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
    },
  );

  await t.test(
    "texts over S2 8.2.3's limits are not sent: a filter is cut to 1,024 bytes with a line; a label of the new form that is too long is refused with a true sentence; the connection stays",
    async (t) => {
      const secret = new Uint8Array(32).fill(8);
      const page = await newPage(t, chromium);
      const sent: Record<string, unknown>[] = [];
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message) => {
            sent.push(message);
            if (message['t'] === 'view') conn.send(scriptedList([], []));
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');

      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.fill('#list input', 'é'.repeat(600)); // 1,200 bytes of UTF-8
      await showsText(page, '#key-message', /^the filter is cut to its first 1,024 bytes$/);
      const views = sent.filter((message) => message['t'] === 'view');
      assert.equal(views.at(-1)?.['filter'], 'é'.repeat(512));

      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await page.fill('input[name="label"]', 'x'.repeat(1100));
      await page.locator('#cards button', { hasText: 'Start' }).click();
      await showsText(
        page,
        '#cards',
        /the label is longer than skydeck takes: at most 1,024 bytes of UTF-8/,
      );
      await sleep(500);

      assert.deepEqual(
        sent.filter((message) => message['t'] === 'act'),
        [],
      );
      assert.equal(standin.connections.length, 1, 'never closed, never reconnected');
      assert.equal(await shownText(page, '#gone'), '');
    },
  );

  for (const variant of ['skipped', 'moved on'] as const) {
    await t.test(
      `after a reconnect a terminal the new list lacks is ${variant === 'skipped' ? 'skipped' : 'given up when a list without it comes, and the next one is attached'} (ruled, task 26)`,
      async (t) => {
        const secret = new Uint8Array(32).fill(10);
        const page = await newPage(t, chromium);
        await page.addInitScript(RECORDER);
        const both = scriptedList(
          [
            { id: S1, terminal: TERM_A, slot: 1 },
            { id: S2, terminal: TERM_B, slot: 2 },
          ],
          [
            { id: TERM_A, slot: 1, sessionId: S1 },
            { id: TERM_B, slot: 2, sessionId: S2 },
          ],
        );
        const onlyB = scriptedList(
          [
            { id: S1, terminal: null, slot: null },
            { id: S2, terminal: TERM_B, slot: 2 },
          ],
          [{ id: TERM_B, slot: 2, sessionId: S2 }],
        );
        const onlyA = scriptedList(
          [
            { id: S1, terminal: TERM_A, slot: 1 },
            { id: S2, terminal: null, slot: null },
          ],
          [{ id: TERM_A, slot: 1, sessionId: S1 }],
        );
        let snaps = 0;
        const standin = await standinServer(t, {
          socket: honest(secret, {
            open: (conn, message, n) => {
              const snap = (term: unknown): void =>
                conn.send({ t: 'snap', term, ch: ++snaps, cols: 80, rows: 24, data: '' });
              if (message['t'] === 'view') {
                conn.send(n === 1 || variant === 'moved on' ? both : onlyB);
              } else if (message['t'] === 'attach') {
                if (n > 1 && variant === 'moved on' && message['term'] === TERM_B) {
                  conn.send(onlyA); // no snap for B: the list says it is gone
                } else {
                  snap(message['term']);
                }
              }
            },
          }),
        });
        await page.goto(standin.url);
        await storeKey(page, secret);
        await page.goto(standin.url);
        await connection(page, 'open');
        // S1 (terminal A) is shown first; then slot 2 shows B: both are attached, B is shown.
        await page.waitForSelector('#terminal .terminal-placeholder', { timeout: PAGE_WAIT_MS });
        await page.keyboard.press('Control+Shift+Digit2');
        await until(
          () =>
            standin.connections[0]?.received.filter((text) => text.includes('"attach"')).length ===
            2,
          'both terminals attached',
          PAGE_WAIT_MS,
        );
        await mark(page, 'reconnect');

        standin.connections[0]?.ws.terminate();
        await until(() => standin.connections.length === 2, 'a second connection', PAGE_WAIT_MS);
        await connection(page, 'open');
        await sleep(1500);

        const attaches = after(await logOf(page), 'reconnect')
          .filter((e) => e.e === 'out' && e.t === 'attach')
          .map((e) => (e.term === TERM_A ? 'A' : e.term === TERM_B ? 'B' : '?'));
        assert.deepEqual(attaches, variant === 'skipped' ? ['B'] : ['B', 'A']);
      },
    );
  }

  await t.test(
    'timers held for 60 s while the server answers: no close, no bar, no reconnect (ruled, review 2)',
    async (t) => {
      const secret = new Uint8Array(32).fill(11);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      await page.clock.install();
      const standin = await standinServer(t, { socket: honest(secret, {}) });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await sleep(1500); // pings and pongs on time
      await mark(page, 'held');

      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(now + 100);
      await sleep(2000); // no timer runs
      await page.clock.fastForward(60_000); // one late tick
      await page.clock.resume();
      await sleep(4500);

      assert.deepEqual(
        after(await logOf(page), 'held').filter((e) => e.e === 'close' || e.e === 'ws'),
        [],
      );
      assert.equal(await shownText(page, '#gone'), '');
      assert.equal(standin.connections.length, 1);
    },
  );

  await t.test(
    "timers held and a server that stopped answering: found after the late tick's own ping (ruled, review 2)",
    async (t) => {
      const secret = new Uint8Array(32).fill(12);
      const page = await newPage(t, chromium);
      await page.clock.install();
      let answering = true;
      const standin = await standinServer(t, {
        socket: honest(secret, { pings: () => answering }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await sleep(1500);

      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(now + 100);
      answering = false;
      await sleep(1000);
      await page.clock.fastForward(60_000);
      await page.clock.resume();
      await sleep(1000);
      assert.equal(await shownText(page, '#gone'), '', 'not judged at the late tick');

      await showsText(page, '#gone-text', GONE, 4500);
    },
  );

  await t.test(
    "a challenge whose nonce is not canonical is not skydeck's server: no hello, the warning",
    async (t) => {
      const page = await newPage(t, chromium);
      const standin = await standinServer(t, {
        socket: (conn) => {
          const valid = Buffer.alloc(32, 0x40).toString('base64url');
          conn.send({ t: 'challenge', protocol: 1, nonce: `${valid.slice(0, -1)}B` });
        },
      });
      await page.goto(standin.url);
      await storeKey(page, new Uint8Array(32).fill(13));
      standin.connections.length = 0;
      await page.goto(standin.url);

      await showsText(
        page,
        '#problem',
        /^something answers on port \d+ that is not skydeck's server/,
      );
      await sleep(1000);
      assert.equal(standin.connections.length, 1);
      assert.deepEqual(standin.connections[0]?.received, []);
    },
  );

  await t.test(
    'the reconnect schedule of S2 6.3: every second for 10 s, then every 5 s',
    async (t) => {
      const standin = await standinServer(t);
      const page = await newPage(t, chromium);
      await page.goto(standin.url);
      const base = await assetBase(page);
      const delays = await page.evaluate(async (base) => {
        const { retryDelay } = (await import(`${base}connection.js`)) as {
          retryDelay(sinceLostMs: number): number;
        };
        return [0, 1000, 9999, 10_000, 60_000].map(retryDelay);
      }, base);
      assert.deepEqual(delays, [1000, 1000, 1000, 5000, 5000]);
    },
  );

  await t.test(
    'a key that cannot be stored: the window works, says so, and its reload keys do not reload it',
    async (t) => {
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'indexedDB', {
          get() {
            throw new DOMException('no IndexedDB here', 'SecurityError');
          },
        });
      });
      const started = await startTestServer(t);
      const { token } = await controlClient(
        started.d.platform.net,
        started.d.files.serverSock,
      ).token(30);
      await page.goto(pageUrl(started.server.port, token));
      await connection(page, 'open');
      await showsText(page, '#problem', new RegExp(`^${escape(UNSTORED)}$`));
      await mark(page, 'unstored');

      await toZone(page, 'list');
      await page.keyboard.press('F5');
      await sleep(2000);
      assert.deepEqual(
        after(await logOf(page), 'unstored').filter((e) => e.e === 'unload' || e.e === 'ws'),
        [],
      );
    },
  );

  await t.test(
    'a key that cannot be stored and a server of another asset version: no reload (it would lose the key), and a line that says so',
    async (t) => {
      const secret = randomBytes(32);
      const token = randomBytes(32);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'indexedDB', {
          get() {
            throw new DOMException('no IndexedDB here', 'SecurityError');
          },
        });
      });
      const standin = await standinServer(t, {
        socket: honest(secret, { token, assetVersion: 'another-build' }),
      });
      await page.goto(pageUrl(standin.port, token.toString('base64url')));
      await showsText(page, '#problem', new RegExp(`^${escape(STALE_UNSTORED)}$`));
      await connection(page, 'fatal');
      await sleep(1500);

      assert.equal((await logOf(page)).filter((e) => e.e === 'unload').length, 0);
      assert.equal(standin.connections.length, 1);
    },
  );

  await t.test(
    "the keyboard goes back to the zone when what had it goes away: after the notice's × the list takes j; after Esc from the form the shown terminal has it; with the form open Ctrl+Shift+L there and back gives the form's first field",
    async (t) => {
      const secret = new Uint8Array(32).fill(14);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      const rows = scriptedList(
        [
          { id: S1, terminal: TERM_A, slot: 1 },
          { id: S2, terminal: null, slot: null },
        ],
        [{ id: TERM_A, slot: 1, sessionId: S1 }],
      );
      /** Every list the stand-in sent; `landed()` waits until the page has received them all. */
      let listsSent = 0;
      const landed = async (): Promise<void> => {
        const deadline = performance.now() + PAGE_WAIT_MS;
        while (
          (await logOf(page)).filter((e) => e.e === 'in' && e.t === 'list').length < listsSent
        ) {
          assert.ok(performance.now() < deadline, 'the lists reached the page');
          await sleep(50);
        }
        await sleep(100); // and were drawn
      };
      const standin = await standinServer(t, {
        socket: honest(secret, {
          serverId: (n) => `${n}`.repeat(16).slice(0, 16),
          open: (conn, message) => {
            if (message['t'] === 'view') {
              listsSent++;
              conn.send(rows);
            }
            if (message['t'] === 'attach') {
              conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
            }
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await page.waitForSelector('#terminal .terminal-placeholder', { timeout: PAGE_WAIT_MS });

      // A server restarted (another server id): the notice; dismissed in the list zone.
      await toZone(page, 'list');
      standin.connections[0]?.ws.terminate();
      await showsText(page, '#info-text', RESTARTED);
      assert.equal(await selectedRow(page), S1);
      await page.locator('#info-close').click();
      await page.waitForSelector('#info[hidden]', { state: 'attached' });
      assert.equal(await active(page), '#list');
      await page.keyboard.press('j');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
      );
      // A click on the page's chrome (the title bar, the key bar) takes no keyboard: the list
      // keeps it, and its keys work (ruled, review 2 round three).
      await page.locator('.titlebar .logo').click();
      await page.locator('#focus-zone').click();
      assert.equal(await active(page), '#list');
      await page.keyboard.press('k');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S1,
      );
      await landed(); // the list that answers k's view: its render must not come after the blur
      // And while nothing has the keyboard at all, the list zone's keys still apply.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      assert.equal(await active(page), 'BODY');
      await page.keyboard.press('j');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
      );
      await page.keyboard.press('k');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S1,
      );
      await landed();
      // A render that leaves the right side the same (the same list again) also gives the zone
      // the keyboard back (review 2, round four).
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      assert.equal(await active(page), 'BODY');
      listsSent++;
      standin.connections.at(-1)?.send(rows);
      await landed();
      assert.equal(await active(page), '#list');

      // A card replaced while its button had the keyboard: the zone takes it back.
      await clickRow(page, S2); // not running: its resume card
      await page.focus('#cards button');
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
      listsSent++;
      standin.connections.at(-1)?.send(
        scriptedList(
          [
            { id: S1, terminal: TERM_A, slot: 1 },
            { id: S2, terminal: null, slot: null },
          ],
          [{ id: TERM_A, slot: 1, sessionId: S1 }],
          {
            sessionId: S2,
            command: 'claude --resume another-command',
            flagsKnown: true,
            unknownFlags: [],
            ended: 'exited',
            expiring: false,
            expired: false,
          },
        ),
      );
      await showsText(page, '#cards', /claude --resume another-command/);
      assert.equal(await active(page), '#right-zone');

      // A card hidden (not removed) while its button had the keyboard: a list without the
      // selected session leaves the right side empty, cards.hide() hides the card, and the zone
      // takes the keyboard at once (ruled, review 2 round three).
      await page.focus('#cards button');
      listsSent++;
      standin.connections
        .at(-1)
        ?.send(
          scriptedList(
            [{ id: S1, terminal: TERM_A, slot: 1 }],
            [{ id: TERM_A, slot: 1, sessionId: S1 }],
          ),
        );
      await page.waitForSelector('#right-zone[data-pane="none"]', { state: 'attached' });
      assert.equal(await active(page), '#right-zone');
      listsSent++;
      standin.connections.at(-1)?.send(rows); // S2 back

      // Esc closes the form over the shown terminal: the terminal has the keyboard again.
      await page.keyboard.press('Control+Shift+Digit1');
      await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await page.keyboard.press('Escape');
      await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      assert.equal(await active(page), 'in #terminal');
      // A click on the header above the shown terminal, or on the key bar: the terminal has the
      // keyboard (the header's click gives it back once the click is done).
      await page.locator('#cards .card-header').click();
      await page.waitForFunction(
        () => document.getElementById('terminal')?.contains(document.activeElement) === true,
        null,
        { timeout: 5000 },
      );
      await page.locator('#focus-zone').click();
      assert.equal(await active(page), 'in #terminal');

      // The form open, to the list and back: its first field has the keyboard again.
      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await toZone(page, 'list');
      await toZone(page, 'terminal');
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name),
        'directory',
      );
    },
  );

  await t.test(
    'a socket that ends while a launch stores its key is found at once, and the page connects again with its key',
    async (t) => {
      const secret = randomBytes(32);
      const token = randomBytes(32);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      await page.addInitScript(() => {
        // IndexedDB that opens 3 s late (a cold profile, a slow disk).
        const realOpen = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function open(name: string, version?: number) {
          const fake: Record<string, unknown> = { result: null, error: null };
          setTimeout(() => {
            const request = realOpen.call(this, name, version);
            request.onupgradeneeded = () => {
              fake['result'] = request.result;
              (fake['onupgradeneeded'] as (() => void) | undefined)?.();
            };
            request.onsuccess = () => {
              fake['result'] = request.result;
              (fake['onsuccess'] as (() => void) | undefined)?.();
            };
            request.onerror = () => {
              fake['error'] = request.error;
              (fake['onerror'] as (() => void) | undefined)?.();
            };
          }, 3000);
          return fake as unknown as IDBOpenDBRequest;
        };
      });
      let messages = 0;
      const answer = honest(secret, { token });
      const standin = await standinServer(t, {
        socket: (conn) => {
          answer(conn);
          conn.ws.on('message', () => {
            // The launch's hello is answered, and a second later — the key still being stored —
            // its socket ends.
            if (++messages === 1) setTimeout(() => conn.ws.terminate(), 1000);
          });
        },
      });

      await page.goto(pageUrl(standin.port, token.toString('base64url')));
      await until(() => standin.connections.length === 2, 'a second connection', PAGE_WAIT_MS);
      await connection(page, 'open');

      assert.deepEqual(
        (await logOf(page)).filter((e) => e.e === 'out' && e.t === 'hello').map((e) => e.mode),
        ['launch', 'key'],
      );
    },
  );

  await t.test(
    'the re-attach queue and a view that detaches meanwhile: a terminal it detached is not attached again by the queue (ruled, task 26)',
    async (t) => {
      const secret = new Uint8Array(32).fill(15);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      const three = scriptedList(
        [
          { id: S1, terminal: TERM_A, slot: 1 },
          { id: S2, terminal: TERM_B, slot: 2 },
          { id: S3, terminal: TERM_C, slot: 3 },
        ],
        [
          { id: TERM_A, slot: 1, sessionId: S1 },
          { id: TERM_B, slot: 2, sessionId: S2 },
          { id: TERM_C, slot: 3, sessionId: S3 },
        ],
      );
      let snaps = 0;
      let withhold = false;
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message) => {
            if (message['t'] === 'view') conn.send(three);
            else if (message['t'] === 'attach') {
              if (withhold && message['term'] === TERM_A) return; // its snap is late
              conn.send({
                t: 'snap',
                term: message['term'],
                ch: ++snaps,
                cols: 80,
                rows: 24,
                data: '',
              });
            }
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await page.waitForSelector('#terminal .terminal-placeholder', { timeout: PAGE_WAIT_MS });
      await page.keyboard.press('Control+Shift+Digit2');
      await page.keyboard.press('Control+Shift+Digit3');
      await until(
        () =>
          standin.connections[0]?.received.filter((text) => text.includes('"attach"')).length === 3,
        'three terminals attached',
        PAGE_WAIT_MS,
      );
      await mark(page, 'reconnect');
      withhold = true;
      standin.connections[0]?.ws.terminate();
      await until(() => standin.connections.length === 2, 'a second connection', PAGE_WAIT_MS);
      await connection(page, 'open');
      await sleep(1500);
      // The window is hidden: the view detaches all but the shown terminal (C).
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await sleep(500);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      withhold = false;
      await page.keyboard.press('Control+Shift+Digit1'); // A shown again: the view attaches it
      await sleep(1500);

      const names: Record<string, string> = { [TERM_A]: 'A', [TERM_B]: 'B', [TERM_C]: 'C' };
      assert.deepEqual(
        after(await logOf(page), 'reconnect')
          .filter((e) => e.e === 'out' && (e.t === 'attach' || e.t === 'detach'))
          .map((e) => `${e.t} ${names[e.term ?? ''] ?? '?'}`),
        ['attach C', 'attach A', 'detach A', 'detach B', 'attach A'],
      );
    },
  );

  await t.test(
    'neither session storage nor IndexedDB, and a server of another asset version: no reload, and the line of the key that could not be stored',
    async (t) => {
      const secret = randomBytes(32);
      const token = randomBytes(32);
      const page = await newPage(t, chromium);
      await page.addInitScript(() => {
        for (const name of ['sessionStorage', 'indexedDB']) {
          Object.defineProperty(globalThis, name, {
            get() {
              throw new DOMException(`no ${name} here`, 'SecurityError');
            },
          });
        }
      });
      let loads = 0;
      page.on('load', () => loads++);
      const standin = await standinServer(t, {
        socket: honest(secret, { token, assetVersion: 'another-build' }),
      });

      await page.goto(pageUrl(standin.port, token.toString('base64url')));
      await showsText(page, '#problem', new RegExp(`^${escape(STALE_UNSTORED)}$`));
      await connection(page, 'fatal');
      await sleep(1500);

      assert.equal(loads, 1, 'no reload of its own');
      assert.equal(standin.connections.length, 1);
    },
  );

  await t.test(
    'one click on a row from the terminal zone selects it, and Enter then resumes that row',
    async (t) => {
      const secret = new Uint8Array(32).fill(16);
      const page = await newPage(t, chromium);
      const acts: Record<string, unknown>[] = [];
      let views = 0;
      const rows = scriptedList(
        [
          { id: S1, terminal: null, slot: null },
          { id: S2, terminal: null, slot: null },
        ],
        [],
      );
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message) => {
            if (message['t'] === 'view') {
              views++;
              conn.send(rows);
            }
            if (message['t'] === 'act') acts.push(message);
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await page.locator(`#list [data-id="${S2}"]`).waitFor({ timeout: PAGE_WAIT_MS });
      // The page's second view (the first row selected by itself) and its list are done.
      await until(() => views >= 2, 'the second view', PAGE_WAIT_MS);
      await sleep(300);
      assert.equal(await selectedRow(page), S1);
      assert.equal(await zone(page), 'Focus: terminal');

      await page.locator(`#list [data-id="${S2}"]`).click(); // once: no second try
      assert.equal(await selectedRow(page), S2);
      await showsText(page, '#focus-zone', /^Focus: list$/);
      await page.keyboard.press('Enter');
      await until(() => acts.length > 0, 'an act', PAGE_WAIT_MS);

      assert.deepEqual(
        acts.map((act) => [act['kind'], act['sessionId']]),
        [['resume', S2]],
      );
    },
  );

  await t.test(
    "the view's key handler is also given a chord's keyup: the page acts on the keydown only, and the view drops both (contract 2.9 `chord`, for task 28)",
    async (t) => {
      const secret = new Uint8Array(32).fill(17);
      const page = await newPage(t, chromium);
      const rows = scriptedList(
        [
          { id: S1, terminal: TERM_A, slot: 1 },
          { id: S2, terminal: TERM_B, slot: 2 },
        ],
        [
          { id: TERM_A, slot: 1, sessionId: S1 },
          { id: TERM_B, slot: 2, sessionId: S2 },
        ],
      );
      // The view under test, over the pinned minimal one (which it imports as terminal-view-real.js).
      await pinModules(t, page, {
        'terminal-view.js': fixture('chord-view.js'),
        'terminal-view-real.js': MINIMAL_MODULES['terminal-view.js'],
      });
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message) => {
            if (message['t'] === 'view') conn.send(rows);
            if (message['t'] === 'attach') {
              conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
            }
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await page.waitForSelector('#terminal .terminal-placeholder', { timeout: PAGE_WAIT_MS });
      await page.focus('#terminal .terminal-placeholder');
      const calls = async (): Promise<{ pasteRaw: number; dropped: string[] }> =>
        page.evaluate(
          () => Reflect.get(globalThis, 'viewCalls') as { pasteRaw: number; dropped: string[] },
        );

      await page.keyboard.press('Control+Shift+H');
      assert.equal(await page.locator('#help').isHidden(), false, 'the help is shown, once');
      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help[hidden]', { state: 'attached' });
      await page.keyboard.press('Control+Shift+V');
      assert.equal((await calls()).pasteRaw, 1, 'one raw Ctrl+V');
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
      await sleep(300);
      assert.equal(await selectedRow(page), S1, 'back once, not there and back');
      assert.ok((await calls()).dropped.includes('keyup H'), (await calls()).dropped.join(', '));
    },
  );

  await t.test(
    "a mouse click on the notice's × leaves the keyboard where the user was typing: the filter keeps it, and nothing is resumed",
    async (t) => {
      const secret = new Uint8Array(32).fill(18);
      const page = await newPage(t, chromium);
      const sent: Record<string, unknown>[] = [];
      const rows = scriptedList(
        [
          { id: S1, terminal: null, slot: null },
          { id: S2, terminal: null, slot: null },
        ],
        [],
      );
      const standin = await standinServer(t, {
        socket: honest(secret, {
          serverId: (n) => `${n}`.repeat(16).slice(0, 16),
          open: (conn, message) => {
            sent.push(message);
            if (message['t'] === 'view') conn.send(rows);
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('se');
      standin.connections[0]?.ws.terminate(); // the server restarted: the notice
      await showsText(page, '#info-text', RESTARTED);
      await connection(page, 'open');
      // The page's view after the welcome has landed: only what the click and the typing cause
      // comes after `before`.
      await until(
        () => standin.connections[1]?.received.some((text) => text.includes('"t":"view"')) === true,
        "the second connection's view",
        PAGE_WAIT_MS,
      );
      await sleep(300);
      const before = sent.length;

      await page.locator('#info-close').click();
      await page.waitForSelector('#info[hidden]', { state: 'attached' });
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value),
        'se',
        'the filter still has the keyboard',
      );
      await page.keyboard.type('a');
      await page.keyboard.press('Enter');
      await sleep(500);

      assert.equal(await page.inputValue('#list input'), 'sea');
      assert.deepEqual(
        sent.slice(before).filter((message) => message['t'] === 'act'),
        [],
        'nothing resumed',
      );
      const views = sent.slice(before).filter((message) => message['t'] === 'view');
      assert.deepEqual(
        views.map((view) => [view['filter'], view['showDone']]),
        [['sea', false]],
        "only the filter's own view: no show-done toggled",
      );
    },
  );

  await t.test(
    'a list that arrives between the mousedown and the mouseup on a row loses no click (contract 2.9, for task 27)',
    async (t) => {
      const secret = new Uint8Array(32).fill(19);
      const page = await newPage(t, chromium);
      const lists = (title: string): Record<string, unknown> =>
        scriptedList(
          [
            { id: S1, terminal: null, slot: null, title },
            { id: S2, terminal: null, slot: null },
          ],
          [],
        );
      let views = 0;
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message) => {
            if (message['t'] === 'view') {
              views++;
              conn.send(lists('first'));
            }
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await until(() => views >= 2, 'the second view', PAGE_WAIT_MS);
      await toZone(page, 'list');
      const row = page.locator(`#list [data-id="${S2}"]`);
      const box = await row.boundingBox();
      assert.ok(box !== null);

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      standin.connections.at(-1)?.send(lists('changed while the button is down'));
      await showsText(page, '#list', /changed while the button is down/);
      await page.mouse.up();

      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
        { timeout: 5000 },
      );
    },
  );

  await t.test(
    "with a terminal whose keyboard holder is a text control (as xterm.js's is): a drag over a notice's text keeps the selection and Ctrl+C copies it, reaching no program; a list that arrives meanwhile takes nothing; a plain click gives the terminal the keyboard again (ruled, review 2 of task 26)",
    async (t) => {
      const secret = new Uint8Array(32).fill(20);
      const page = await newPage(t, chromium);
      await page.addInitScript(() => {
        const copied: string[] = [];
        Reflect.set(globalThis, 'copied', copied);
        document.addEventListener('copy', () => copied.push(getSelection()?.toString() ?? ''));
      });
      const rows = scriptedList(
        [{ id: S1, terminal: TERM_A, slot: 1 }],
        [{ id: TERM_A, slot: 1, sessionId: S1 }],
      );
      // The view under test, over the pinned minimal one (which it imports as terminal-view-real.js).
      await pinModules(t, page, {
        'terminal-view.js': fixture('textarea-view.js'),
        'terminal-view-real.js': MINIMAL_MODULES['terminal-view.js'],
      });
      const standin = await standinServer(t, {
        socket: honest(secret, {
          serverId: (n) => `${n}`.repeat(16).slice(0, 16),
          open: (conn, message) => {
            if (message['t'] === 'view') conn.send(rows);
            if (message['t'] === 'attach') {
              conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
            }
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await page.waitForSelector('#terminal .xterm-helper-textarea', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        null,
        { timeout: 5000 },
      );
      standin.connections[0]?.ws.terminate(); // the server restarted: the notice
      await showsText(page, '#info-text', RESTARTED);
      await connection(page, 'open');
      assert.equal(await zone(page), 'Focus: terminal');
      const selected = (): Promise<string> => page.evaluate(() => getSelection()?.toString() ?? '');
      const holderHasIt = (): Promise<boolean> =>
        page.evaluate(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        );

      // A drag over the notice's text.
      const box = await page.locator('#info-text').boundingBox();
      assert.ok(box !== null);
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(250); // a person's drag: the button stays down a moment before it moves
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await sleep(100);
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await sleep(300);
      const text = await selected();
      assert.match(text, /restarted/, 'the text stays selected');
      assert.equal(await holderHasIt(), false, 'the terminal did not take the keyboard');

      // A list that arrives meanwhile (a render) takes nothing.
      standin.connections.at(-1)?.send(rows);
      await sleep(500);
      assert.equal(await selected(), text);
      assert.equal(await holderHasIt(), false);

      // Ctrl+C copies the selection and reaches no program.
      await page.keyboard.press('Control+c');
      await sleep(200);
      assert.deepEqual(await page.evaluate(() => Reflect.get(globalThis, 'copied')), [text]);
      assert.deepEqual(await page.evaluate(() => Reflect.get(globalThis, 'programGot')), []);

      // Nothing acts on the end of a selection by itself; the next render, once nothing is
      // selected, gives the keyboard back.
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await sleep(300);
      assert.equal(await holderHasIt(), false, 'no rule on the end of a selection');
      standin.connections.at(-1)?.send(rows);
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        null,
        { timeout: 5000 },
      );
      // Select again, by a drag; then a plain click (it selects nothing): the terminal has the
      // keyboard again; the same after a click on the header above it and into the key help.
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(250);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await sleep(100);
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await sleep(300);
      assert.match(await selected(), /restarted/);
      assert.equal(await holderHasIt(), false);
      await page.locator('#info-text').click();
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        null,
        { timeout: 5000 },
      );
      await page.locator('#cards .card-header').click();
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        null,
        { timeout: 5000 },
      );
      await page.keyboard.press('Control+Shift+H');
      await page.locator('#help').click();
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        null,
        { timeout: 5000 },
      );
    },
  );

  await t.test(
    "a terminal the user's own resume brings takes the keyboard whatever is selected; one that only a list brings does not take it while text is selected (ruled, review 2 of task 26)",
    async (t) => {
      const secret = new Uint8Array(32).fill(21);
      const page = await newPage(t, chromium);
      const terms: Record<string, string> = { [S1]: TERM_A, [S2]: TERM_B, [S3]: TERM_C };
      const running = new Set<string>([S1]);
      let shownSelected: string | null = null;
      const listFor = (selected: string | null): Record<string, unknown> =>
        scriptedList(
          [S1, S2, S3].map((id) => ({
            id,
            terminal: running.has(id) ? (terms[id] ?? null) : null,
            slot: running.has(id) ? [S1, S2, S3].indexOf(id) + 1 : null,
          })),
          [...running].map((id) => ({
            id: terms[id] ?? '',
            slot: [S1, S2, S3].indexOf(id) + 1,
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
      // The view under test, over the pinned minimal one (which it imports as terminal-view-real.js).
      await pinModules(t, page, {
        'terminal-view.js': fixture('textarea-view.js'),
        'terminal-view-real.js': MINIMAL_MODULES['terminal-view.js'],
      });
      const standin = await standinServer(t, {
        socket: honest(secret, {
          serverId: (n) => `${n}`.repeat(16).slice(0, 16),
          open: (conn, message) => {
            if (message['t'] === 'view') {
              shownSelected = (message['selected'] as string | null) ?? null;
              conn.send(listFor(shownSelected));
            } else if (message['t'] === 'attach') {
              conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
            } else if (message['t'] === 'act' && message['kind'] === 'resume') {
              const sessionId = message['sessionId'] as string;
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
      await page.waitForSelector('#terminal .xterm-helper-textarea', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      const holderHasIt = (): Promise<boolean> =>
        page.evaluate(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        );
      const holderGetsIt = (): Promise<unknown> =>
        page.waitForFunction(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
          null,
          { timeout: 5000 },
        );
      const selected = (): Promise<string> => page.evaluate(() => getSelection()?.toString() ?? '');

      // The command of S2's resume card selected to copy it, then "Resume here": the terminal
      // has the keyboard (the selection is in the card, which is hidden now, and the resume is
      // the user's own).
      await clickRow(page, S2);
      await showsText(page, '#cards', /claude --resume /);
      await page.locator('#cards .card-command').click({ clickCount: 3 });
      assert.match(await selected(), /claude --resume /);
      await page.locator('#cards button', { hasText: 'Resume here' }).click();
      await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      await holderGetsIt();

      // A word of a notice copied, then a resume by the keyboard (Ctrl+Shift+L, j, Enter): the
      // selection is still shown, and the terminal takes the keyboard all the same.
      standin.connections[0]?.ws.terminate(); // the server restarted: the notice
      await showsText(page, '#info-text', RESTARTED);
      await connection(page, 'open');
      await page.locator('#info-text').dblclick();
      assert.notEqual(await selected(), '');
      await page.keyboard.press('Control+c');
      await toZone(page, 'list');
      await page.keyboard.press('j'); // S2 → S3
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S3,
      );
      await page.keyboard.press('Enter');
      await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      await holderGetsIt();

      // A selection left in a card that is hidden now holds nothing back: S3's command selected
      // on its card, then a list brings S3's terminal (as if started from a command line).
      running.delete(S3);
      standin.connections.at(-1)?.send(listFor(S3)); // S3 not running: its resume card
      await page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      await page.locator('#cards .card-command').click({ clickCount: 3 });
      assert.match(await selected(), /claude --resume /);
      running.add(S3);
      standin.connections.at(-1)?.send(listFor(S3));
      await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      await holderGetsIt();

      // A terminal that only a list brings while a notice's text is selected: the keyboard and
      // the selection stay.
      running.delete(S3);
      standin.connections.at(-1)?.send(listFor(S3));
      await page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      const box = await page.locator('#info-text').boundingBox();
      assert.ok(box !== null);
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(250);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await sleep(100);
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await sleep(300);
      const text = await selected();
      assert.notEqual(text, '');
      running.add(S3);
      standin.connections.at(-1)?.send(listFor(S3));
      await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      await sleep(300);
      assert.equal(await selected(), text, 'the selection stays');
      assert.equal(await holderHasIt(), false, 'the list did not move the keyboard');
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

  // Last: every module this file pinned was served through the pin (helpers/shell.ts pinModules).
  await t.test('every pinned module was served through the pin', () => {
    assert.deepEqual(unservedPins(), []);
  });
});
