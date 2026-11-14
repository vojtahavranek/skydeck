// The terminal view in a browser (plan task 28; S2 8.2.4, 8.2.6, 9, 12.6, 15.4, 17.4): a real test
// server whose terminals run the stand-in, and the page's real modules.
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { test } from 'node:test';

import type { Page } from 'playwright';

import type { Platform } from '../src/platform/types.ts';
import type { StreamSink } from '../src/window/hub.ts';
import type { RunningServer } from '../src/window/server.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { serverKeepers } from '../test/helpers/registry.ts';
import { readRecords } from '../test/helpers/standin.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  RECORDER,
  RESTARTED,
  active,
  after,
  connection,
  honest,
  launched,
  logOf,
  mark,
  scriptedList,
  showsText,
  standinServer,
  storeKey,
  zone,
} from './helpers/shell.ts';
import {
  hexOf,
  inputOf,
  noticeText,
  promptOf,
  recordsOf,
  resumeHere,
  screenText,
  shownTerm,
  untilScreen,
  untilTerminalOf,
  until,
} from './helpers/terminal.ts';

/** The queries of the stand-in's `/query` (plan 2.4) that the screen side answers: all but
 *  XTVERSION, which stage A does not answer (S2 9.3). */
const ANSWERED = ['DA1', 'DA2', 'CPR', 'DECRQM 2026', 'DECRQSS m', 'OSC 10', 'OSC 11'];

/** The texts of the server's notices (src/window/terminals.ts). */
const GAP = "part of this terminal's output was lost while skydeck's server was not running";
const NEWER = 'this terminal was started by a newer skydeck; run skydeck window --restart';
const INPUT_FULL =
  'this terminal is not taking input at the moment: what you typed was not sent to the program';

/** Grants the page's origin the clipboard (S2 9.5: the page writes it; the test reads it). */
async function allowClipboard(page: Page, port: number): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: `http://127.0.0.1:${port}`,
  });
}

async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * The sinks the server's hub is given from now on, by terminal (plan task 28: notices "sent by a
 * test server through the hub"); `afterSnapshot` runs right after a sink's snapshot, where the
 * hub tells the state a terminal is in.
 */
function captureSinks(
  server: RunningServer,
  afterSnapshot?: (term: string, sink: StreamSink) => void,
): Map<string, StreamSink> {
  const sinks = new Map<string, StreamSink>();
  const attach = server.hub.attach.bind(server.hub);
  server.hub.attach = (term, sink) => {
    const wrapped: StreamSink = {
      ...sink,
      snapshot(cols, rows, data) {
        sink.snapshot(cols, rows, data);
        afterSnapshot?.(term, sink);
      },
    };
    sinks.set(term, wrapped);
    return attach(term, wrapped);
  };
  return sinks;
}

/** Types `line` into the shown terminal and presses Enter. */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/**
 * The centre of the last place the text `text` is on the shown terminal's screen (the echo of the
 * command that printed it comes before), in page coordinates.
 */
async function whereIs(page: Page, text: string): Promise<{ x: number; y: number }> {
  const at = await page.evaluate((text) => {
    const box = document.querySelector('#terminal .tv-term:not([hidden])');
    const walker = document.createTreeWalker(
      box?.querySelector('.xterm-rows') ?? document.body,
      NodeFilter.SHOW_TEXT,
    );
    let found: { x: number; y: number } | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = (node.textContent ?? '').lastIndexOf(text);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const rect = range.getBoundingClientRect();
      found = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return found;
  }, text);
  assert.ok(at !== null, `${text} is on the screen`);
  return at;
}

/** A click at `at`, with Ctrl held when `ctrl`, after the pointer rested over it (xterm.js finds links on a move). */
async function clickAt(page: Page, at: { x: number; y: number }, ctrl: boolean): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await sleep(200);
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.up();
  if (ctrl) await page.keyboard.up('Control');
}

/** Waits until the server's Edge stub was run with `url` (S2 9.6: `open-link`). */
async function untilOpened(d: ServerSandbox, url: string): Promise<void> {
  await until(() => d.edgeCalls().some((args) => args.includes(url)), `${url} opened`);
}

test('the terminal view', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "a cell written red has the computed colour red (xterm.js's styles work under the policy); the page reports no problem",
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await resumeHere(l.page, S1);
      // The hook of the shared helpers (resumeFromList): the shown terminal has the keyboard
      // inside #terminal (xterm.js's textarea).
      assert.equal(await active(l.page), 'in #terminal');
      assert.deepEqual(l.problems, [], 'no problem once the terminal is shown');
      await untilScreen(l.page, promptOf(S1));
      await l.page.keyboard.type('/red x');
      await l.page.keyboard.press('Enter');
      await untilScreen(l.page, /^x$/m);
      const colours = await l.page.evaluate(() => {
        const box = document.querySelector('#terminal .tv-term:not([hidden])');
        const cell = [...(box?.querySelectorAll('.xterm-rows span') ?? [])].find(
          (span) => span.textContent === 'x',
        );
        const style = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        probe.style.color = style.getPropertyValue('--tv-red').trim();
        document.body.append(probe);
        const red = getComputedStyle(probe).color;
        probe.style.color = style.getPropertyValue('--term-fg').trim();
        const fg = getComputedStyle(probe).color;
        probe.remove();
        return { cell: cell === undefined ? null : getComputedStyle(cell).color, red, fg };
      });
      assert.equal(colours.cell, colours.red, 'the cell has the theme red');
      assert.notEqual(colours.red, colours.fg);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    '/query: the stand-in records exactly one answer per query (the screen side’s), and the page sends nothing for any of them',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await resumeHere(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      await l.page.keyboard.type('/query');
      await mark(l.page, 'enter');
      await l.page.keyboard.press('Enter');
      await until(
        () =>
          recordsOf(l.d.record, S1).filter((entry) => entry.ev === 'answer').length >=
          ANSWERED.length,
        'every query answered',
      );
      await sleep(2500); // the stand-in closes its queries after 2 s; a late answer would be input
      const records = recordsOf(l.d.record, S1);
      const answers = records.flatMap((entry) => (entry.ev === 'answer' ? [entry.query] : []));
      assert.deepEqual([...answers].sort(), [...ANSWERED].sort(), 'one answer for each');
      const enter = records.findIndex((entry) => entry.ev === 'input' && entry.hex === '0d');
      assert.ok(enter !== -1, 'the Enter of the command');
      assert.deepEqual(
        records.slice(enter + 1).filter((entry) => entry.ev === 'input'),
        [],
        'no input after the command: the page answered nothing',
      );
      const sent = after(await logOf(l.page), 'enter').filter(
        (entry) => entry.e === 'out' && entry.t === 'input',
      );
      assert.equal(sent.length, 1, 'the page sent only the Enter');
      assert.ok(readRecords(l.d.record).length > 0);
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );
  await t.test(
    'switching: Ctrl+Shift+1 and 2, Ctrl+Tab and Ctrl+Shift+O switch between two terminals; a terminal shown before needs no new snap',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2);
      const term1 = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const term2 = await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      await mark(page, 'switching');
      const shows = async (key: string, term: string, sessionId: string): Promise<void> => {
        await page.keyboard.press(key);
        await until(async () => (await shownTerm(page)) === term, `${key} shows ${term}`);
        await untilScreen(page, promptOf(sessionId), 2000);
        assert.equal(await untilTerminalOf(page, sessionId), term, 'with the keyboard in it');
      };
      await shows('Control+Shift+Digit1', term1, S1);
      await shows('Control+Shift+Digit2', term2, S2);
      await shows('Control+Tab', term1, S1);
      await shows('Control+Shift+O', term2, S2);
      const since = after(await logOf(page), 'switching');
      assert.deepEqual(
        since.filter(
          (entry) =>
            (entry.e === 'in' && entry.t === 'snap') ||
            (entry.e === 'out' && (entry.t === 'attach' || entry.t === 'detach')),
        ),
        [],
        'no attach, detach or snap: both stayed attached',
      );
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the ninth terminal shown detaches the least recently shown; one shown again while attached costs no snap',
    async (t) => {
      const secret = new Uint8Array(32).fill(28);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      const ids = Array.from({ length: 9 }, (_, i) => `0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7${i}`);
      const terms = Array.from({ length: 9 }, (_, i) => `${i + 1}`.repeat(12));
      const list = scriptedList(
        ids.map((id, i) => ({ id, terminal: terms[i] ?? null, slot: i + 1 })),
        ids.map((id, i) => ({ id: terms[i] ?? '', slot: i + 1, sessionId: id })),
      );
      /** What the page asked of the stand-in: `attach <slot>` / `detach <slot>`. */
      const asked: string[] = [];
      let channel = 0;
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message) => {
            if (message['t'] === 'view') conn.send(list);
            const term = message['term'];
            if (typeof term !== 'string') return;
            const slot = terms.indexOf(term) + 1;
            if (message['t'] === 'attach') {
              asked.push(`attach ${slot}`);
              conn.send({
                t: 'snap',
                term,
                ch: ++channel,
                cols: 80,
                rows: 24,
                data: `the screen of terminal ${slot}`,
              });
            }
            if (message['t'] === 'detach') asked.push(`detach ${slot}`);
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      const show = async (slot: number): Promise<void> => {
        await page.keyboard.press(`Control+Shift+Digit${slot}`);
        await until(async () => (await shownTerm(page)) === terms[slot - 1], `slot ${slot} shown`);
        await untilScreen(page, new RegExp(`the screen of terminal ${slot}$`, 'm'));
      };
      const attached = (): Promise<string[]> =>
        page.evaluate(() =>
          [...document.querySelectorAll('#terminal .tv-term')].map(
            (box) => (box as HTMLElement).dataset['term'] ?? '',
          ),
        );
      // The first row is selected at the start: slot 1 is shown and attached.
      await untilScreen(page, /the screen of terminal 1$/m);
      for (let slot = 2; slot <= 8; slot++) await show(slot);
      assert.equal(asked.filter((what) => what.startsWith('detach')).length, 0, 'eight stay');
      await show(9);
      await until(() => asked.includes('detach 1'), 'the least recently shown detached');
      assert.equal((await attached()).length, 8);
      assert.ok(!(await attached()).includes(terms[0] ?? ''));
      const before = asked.length;
      await show(2);
      assert.deepEqual(asked.slice(before), [], 'slot 2 was attached: no attach, no snap');
      await show(1);
      await until(() => asked.slice(before).includes('attach 1'), 'slot 1 attached again');
      await until(() => asked.slice(before).includes('detach 3'), 'now slot 3 is the oldest');
      assert.deepEqual(asked.slice(before).sort(), ['attach 1', 'detach 3']);

      // The window hidden (S2 12.6): all but the shown one detached at once; shown again, a
      // terminal that was detached costs one snap.
      const hide = async (hidden: boolean): Promise<void> => {
        await page.evaluate((hidden) => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
          document.dispatchEvent(new Event('visibilitychange'));
        }, hidden);
      };
      const hiddenAt = asked.length;
      await hide(true);
      await until(() => asked.length - hiddenAt === 7, 'seven detached');
      assert.ok(asked.slice(hiddenAt).every((what) => what.startsWith('detach')));
      assert.ok(!asked.slice(hiddenAt).includes('detach 1'), 'the shown one stays');
      assert.deepEqual(await attached(), [terms[0]]);
      await hide(false);
      await sleep(300);
      assert.equal(asked.length - hiddenAt, 7, 'nothing attached again by itself');
      await show(5);
      assert.deepEqual(asked.slice(hiddenAt + 7), ['attach 5']);
    },
  );

  await t.test(
    'OSC 52 from the shown terminal of a focused window writes the clipboard; from a hidden one it does not',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await allowClipboard(page, l.server.port);
      d.resumable(S1);
      d.resumable(S2);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await page.evaluate(() => navigator.clipboard.writeText('before'));
      await typeLine(page, '/osc52 from-the-shown-one');
      await until(async () => (await clipboardText(page)) === 'from-the-shown-one', 'written');

      await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      await page.keyboard.press('Control+Shift+Digit1');
      await untilTerminalOf(page, S1);
      // S1 reads its next line only after the stall, when S2 is shown and S1 is hidden.
      await typeLine(page, '/stall 3');
      await typeLine(page, '/osc52 from-a-hidden-one');
      await page.keyboard.press('Control+Shift+Digit2');
      await untilTerminalOf(page, S2);
      await until(
        () => inputOf(d.record, S1).includes(hexOf('/osc52 from-a-hidden-one')),
        'the hidden one wrote its OSC 52',
      );
      await sleep(1500);
      assert.equal(await clipboardText(page), 'from-the-shown-one', 'the clipboard is as it was');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'links: a Ctrl+click on a URL in the text opens it, a plain click does not; an OSC 8 link whose text differs shows its target at the first Ctrl+click and opens at the second',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await typeLine(page, '/red see https://example.com/plain.');
      await untilScreen(page, /^see https:\/\/example\.com\/plain\.$/m);
      const plain = await whereIs(page, 'example.com/plain');
      await clickAt(page, plain, false);
      await sleep(500);
      assert.deepEqual(d.edgeCalls(), [], 'a plain click opens nothing');
      await clickAt(page, plain, true);
      await untilOpened(d, 'https://example.com/plain'); // without the full stop after it

      await typeLine(page, '/link https://example.com/target click-here');
      await untilScreen(page, /click-here/);
      const link = await whereIs(page, 'click-here');
      const calls = d.edgeCalls().length;
      await clickAt(page, link, true);
      await until(
        async () =>
          (await noticeText(page, 'link')) ===
          'this link leads to https://example.com/target; Ctrl+click it again to open it',
        'the target shown',
      );
      assert.equal(d.edgeCalls().length, calls, 'not opened yet');
      await clickAt(page, link, true);
      await untilOpened(d, 'https://example.com/target');
      assert.equal(await noticeText(page, 'link'), '', 'the target is no longer shown');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'find: Ctrl+Shift+F finds a line printed 3,000 lines up; a paste into its field works and reaches no program; Esc gives the terminal the keyboard back',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await allowClipboard(page, l.server.port);
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await typeLine(page, '/lines 4000');
      await untilScreen(page, /^line 4000$/m);
      assert.doesNotMatch(await screenText(page), /^line 1000$/m);
      await page.keyboard.press('Control+Shift+F');
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('tv-find-input') === true,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      await page.keyboard.type('line 1000');
      await page.keyboard.press('Enter');
      await untilScreen(page, /^line 1000$/m);
      await until(
        async () =>
          (await page.evaluate(() => document.querySelector('.tv-find-count')?.textContent)) ===
          '1 of 1',
        'one match',
      );
      // The page cancels only a paste xterm.js took: one into the find bar's field is the field's.
      await page.evaluate(() => navigator.clipboard.writeText('line 2000'));
      const before = inputOf(d.record, S1);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+V');
      await until(
        async () =>
          (await page.evaluate(
            () => (document.querySelector('.tv-find-input') as HTMLInputElement).value,
          )) === 'line 2000',
        'pasted into the field',
      );
      await untilScreen(page, /^line 2000$/m);
      await sleep(300);
      assert.equal(inputOf(d.record, S1), before, 'the paste reached no program');
      await page.keyboard.press('Escape');
      await untilTerminalOf(page, S1);
      assert.equal(await page.locator('.tv-find').isHidden(), true);
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'input-full (the program stalled, a large paste): shown on its terminal, gone once input is taken again',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await allowClipboard(page, l.server.port);
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await typeLine(page, '/stall 10');
      await untilScreen(page, /stalling 10 s/);
      // More than the keeper (4 MiB), the sockets and the server (4 MiB) take while it stalls.
      await page.evaluate(() => navigator.clipboard.writeText('y'.repeat(10 * 1024 * 1024)));
      await page.keyboard.press('Control+V');
      await until(async () => (await noticeText(page, 'input-full')) === INPUT_FULL, 'shown');
      // A key while it stalls is not taken either: the notice stays.
      await page.keyboard.press('x');
      await sleep(1500);
      assert.equal(await noticeText(page, 'input-full'), INPUT_FULL, 'still not taking input');
      // Once the program reads again, a key is taken and the notice goes.
      await until(
        async () => {
          await page.keyboard.press('z');
          await sleep(1500);
          return (await noticeText(page, 'input-full')) === '';
        },
        'gone once input is taken',
        60_000,
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'the reconnecting bar while the server cannot reach the keeper (stopped for 3 s), and input-full for a key meanwhile; both gone after',
    async (t) => {
      const sockets: { path: string; socket: Socket }[] = [];
      const keepers = serverKeepers();
      const l = await launched(t, chromium, {
        server: {
          platform: (p: Platform) =>
            keepers.platform({
              ...p,
              net: {
                ...p.net,
                async connectUnix(path: string) {
                  const socket = await p.net.connectUnix(path);
                  sockets.push({ path, socket });
                  return socket;
                },
              },
            }),
        },
      });
      const { page, d } = l;
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const keeper = keepers.keeperOf(d.files, term);
      keepers.signalKeeper(keeper, 'SIGSTOP');
      try {
        // A stopped keeper keeps its connection: the server reconnects only once it ends.
        for (const { path, socket } of sockets) {
          if (path === d.files.termSock(term)) socket.destroy();
        }
        await until(
          async () => (await noticeText(page, 'reconnecting')) === 'reconnecting to this terminal',
          'the reconnecting bar',
        );
        await page.keyboard.press('q');
        await until(
          async () => (await noticeText(page, 'input-full')) === INPUT_FULL,
          'input-full',
        );
        await sleep(3000);
        assert.equal(await noticeText(page, 'reconnecting'), 'reconnecting to this terminal');
      } finally {
        keepers.signalKeeper(keeper, 'SIGCONT');
      }
      await until(async () => (await noticeText(page, 'reconnecting')) === '', 'reconnected');
      await page.keyboard.press('w');
      await until(async () => (await noticeText(page, 'input-full')) === '', 'input taken again');
      await until(() => inputOf(d.record, S1).endsWith(hexOf('w')), 'the key reached the program');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'gap and newer-keeper notices (sent through the hub): shown on their terminal; the × by mouse leaves the keyboard in the terminal, by Enter or Space gives it back to the terminal; a new occasion shows again',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const sinks = captureSinks(l.server);
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const sink = sinks.get(term);
      assert.ok(sink !== undefined, 'the page’s sink');
      const close = (kind: string): string =>
        `#terminal .tv-bar[data-kind="${kind}"] .tv-bar-close`;
      const inTerminal = (): Promise<boolean> =>
        page.evaluate(() => document.activeElement?.closest('#terminal .xterm') != null);

      sink.notice('gap', GAP);
      sink.notice('newer-keeper', NEWER);
      await until(async () => (await noticeText(page, 'gap')) === GAP, 'the gap shown');
      await until(async () => (await noticeText(page, 'newer-keeper')) === NEWER, 'newer shown');
      assert.equal(await inTerminal(), true);

      // A mouse click on the × takes no keyboard: it stays in the terminal.
      await page.locator(close('gap')).click();
      assert.equal(await noticeText(page, 'gap'), '');
      assert.equal(await inTerminal(), true, 'the keyboard stayed in the terminal');

      // Enter on a focused ×: the notice goes and the terminal takes the keyboard back.
      await page.locator(close('newer-keeper')).focus();
      assert.equal(await inTerminal(), false);
      await page.keyboard.press('Enter');
      assert.equal(await noticeText(page, 'newer-keeper'), '');
      await until(inTerminal, 'the keyboard back in the terminal after Enter');
      assert.equal(await zone(page), 'Focus: terminal');

      // New occasions (after a record of the stream): shown again although dismissed before.
      await typeLine(page, '/red a record');
      await untilScreen(page, /^a record$/m);
      sink.notice('gap', GAP);
      sink.notice('newer-keeper', NEWER);
      await until(async () => (await noticeText(page, 'gap')) === GAP, 'a new gap shown');
      await until(async () => (await noticeText(page, 'newer-keeper')) === NEWER, 'shown again');

      // Space on a focused ×, the same.
      await page.locator(close('gap')).focus();
      await page.keyboard.press('Space');
      assert.equal(await noticeText(page, 'gap'), '');
      await until(inTerminal, 'the keyboard back in the terminal after Space');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'after a server restart: a notice the new server does not repeat after its snapshot no longer holds and goes (gap); a dismissed one it repeats is not shown again (newer-keeper)',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const sinks = captureSinks(l.server);
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const sink = sinks.get(term);
      assert.ok(sink !== undefined, 'the page’s sink');
      sink.notice('gap', GAP);
      sink.notice('newer-keeper', NEWER);
      await until(async () => (await noticeText(page, 'gap')) === GAP, 'the gap shown');
      await until(async () => (await noticeText(page, 'newer-keeper')) === NEWER, 'newer shown');
      await page.locator('#terminal .tv-bar[data-kind="newer-keeper"] .tv-bar-close').click();

      const port = l.server.port;
      await mark(page, 'restart');
      await l.server.stop('the test restarts it');
      const again = await d.start({ port });
      // The new server repeats the newer keeper after the snapshot; it holds no gap.
      captureSinks(again.server, (_, repeated) => repeated.notice('newer-keeper', NEWER));
      await until(
        async () =>
          after(await logOf(page), 'restart').some(
            (entry) => entry.e === 'in' && entry.t === 'snap' && entry.term === term,
          ),
        'a fresh snap',
      );
      await typeLine(page, '/red after');
      await untilScreen(page, /^after$/m);
      assert.equal(await noticeText(page, 'gap'), '', 'not repeated: no longer holds');
      assert.equal(await noticeText(page, 'newer-keeper'), '', 'dismissed: not shown again');
      // The connection lost and made again while the server restarted is no problem of the page.
      assert.deepEqual(
        l.problems.filter((p) => !/ERR_CONNECTION_REFUSED|WebSocket/.test(p)),
        [],
        'the page reports no problem',
      );
    },
  );

  await t.test(
    'after a server restart the terminal shows the same screen, from a fresh snap',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const port = l.server.port;
      // A first restart puts app.js's "restarted" bar above the list and the terminal: the
      // terminal's area gets smaller and the program redraws at the new size. The second one
      // shows the same bar, so the area stays as it is and the screens can be compared whole.
      await l.server.stop('the test restarts it');
      let server = (await d.start({ port })).server;
      await showsText(page, '#info-text', RESTARTED);
      await connection(page, 'open');
      await typeLine(page, '/red before the second restart');
      await untilScreen(page, /^before the second restart$/m);
      await sleep(1000); // nothing more comes: the screen is still
      const screen = await screenText(page);

      await mark(page, 'restart');
      await server.stop('the test restarts it again');
      server = (await d.start({ port })).server;
      await until(
        async () =>
          after(await logOf(page), 'restart').some(
            (entry) => entry.e === 'in' && entry.t === 'snap' && entry.term === term,
          ),
        'a fresh snap',
      );
      await until(async () => (await screenText(page)) === screen, 'the same screen, whole', 5000);
      assert.ok(server.port === port);
      assert.deepEqual(
        l.problems.filter((p) => !/ERR_CONNECTION_REFUSED|WebSocket/.test(p)),
        [],
        'the page reports no problem',
      );
    },
  );

  await t.test(
    "text of a notice selected with the mouse stays selected while the terminal's output and sizes arrive, and Ctrl+C copies it; Ctrl+Shift+C copies the terminal's selection; the program's window title is ignored",
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await allowClipboard(page, l.server.port);
      const sinks = captureSinks(l.server);
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      sinks.get(term)?.notice('gap', GAP);
      await until(async () => (await noticeText(page, 'gap')) === GAP, 'the gap shown');
      // A drag over the notice's text at a person's pace.
      const text = page.locator('#terminal .tv-bar[data-kind="gap"] .tv-bar-text');
      const box = await text.boundingBox();
      assert.ok(box !== null);
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(250);
      for (const x of [box.x + 40, box.x + 120, box.x + box.width - 2]) {
        await page.mouse.move(x, box.y + box.height / 2);
        await sleep(100);
      }
      await page.mouse.up();
      const selected = (): Promise<string> => page.evaluate(() => getSelection()?.toString() ?? '');
      assert.match(await selected(), /^part of this terminal/);
      // Output and a resize arrive meanwhile (the program is driven from the server's side).
      const keeperInput = l.server.hub.input.bind(l.server.hub);
      keeperInput(term, Buffer.from('/lines 30\r'));
      await untilScreen(page, /^line 30$/m);
      await page.setViewportSize({ width: 1100, height: 650 });
      await until(
        () => recordsOf(d.record, S1).some((entry) => entry.ev === 'resize' && entry.rows !== 40),
        'resized',
      );
      await sleep(500);
      assert.match(await selected(), /^part of this terminal/, 'the selection is kept');
      const before = inputOf(d.record, S1);
      await page.keyboard.press('Control+C');
      await until(async () => /^part of this terminal/.test(await clipboardText(page)), 'copied');
      assert.equal(inputOf(d.record, S1), before, 'no interrupt reached the program');

      // Ctrl+Shift+C: the terminal's own selection (a double click in it selects a word; the
      // terminal takes the keyboard on the click).
      const word = await whereIs(page, 'line 30');
      await page.mouse.dblclick(word.x, word.y);
      await untilTerminalOf(page, S1);
      await page.keyboard.press('Control+Shift+C');
      await until(async () => /^(line|30)$/.test(await clipboardText(page)), 'the word copied');

      await typeLine(page, '/title not the window title');
      await untilScreen(page, /\/title not the window title/);
      await sleep(300);
      assert.ok(!(await page.title()).includes('not the window title'));
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a program that ends inside a synchronized update leaves its last screen readable at once, not a second later',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      // In the page: when the exit came (the recorder logs it before app.js gets it) and when the
      // screen first showed the program's last words.
      await page.evaluate((term) => {
        const times: { exit?: number; drawn?: number } = {};
        Reflect.set(globalThis, 'drawTimes', times);
        const timer = setInterval(() => {
          const log = JSON.parse(sessionStorage.getItem('skydeck-test-log') ?? '[]') as {
            e: string;
            t?: string;
            term?: string;
          }[];
          if (times.exit === undefined && log.some((e) => e.e === 'in' && e.t === 'exit')) {
            times.exit = performance.now();
          }
          const rows = document.querySelector(
            `#terminal .tv-term[data-term="${term}"] .xterm-rows`,
          );
          if (times.drawn === undefined && rows?.textContent?.includes('the last words') === true) {
            times.drawn = performance.now();
          }
          if (times.exit !== undefined && times.drawn !== undefined) clearInterval(timer);
        }, 5);
      }, term);
      // ESC [ ? 2026 h (synchronized output on) with the last words, and the program ends at once:
      // both lines in one read, sent from the server's side so that nothing comes between them.
      l.server.hub.input(term, Buffer.from('/red \x1b[?2026hthe last words\r/fail 3\r'));
      await page.waitForSelector('#terminal .tv-term.over', { timeout: PAGE_WAIT_MS });
      await until(
        async () =>
          (await page.evaluate(
            () => (Reflect.get(globalThis, 'drawTimes') as { drawn?: number }).drawn,
          )) !== undefined,
        'the last screen drawn',
      );
      const times = await page.evaluate(
        () => Reflect.get(globalThis, 'drawTimes') as { exit?: number; drawn?: number },
      );
      assert.ok(times.exit !== undefined && times.drawn !== undefined);
      // xterm.js on its own draws a held-back screen a second after it held it back.
      assert.ok(
        times.drawn - times.exit < 400,
        `drawn ${Math.round(times.drawn - times.exit)} ms after the exit came`,
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "a program's malformed sequence puts nothing into the console (the page's xterm.js logs nothing)",
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const console: string[] = [];
      page.on('console', (message) => console.push(`${message.type()}: ${message.text()}`));
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      // ESC é, and é inside an APC: parsing errors that xterm.js logs at its default level.
      await page.keyboard.type('/red ');
      await page.keyboard.press('Escape');
      await page.keyboard.type('é');
      await page.keyboard.press('Escape');
      await page.keyboard.type('_é');
      await page.keyboard.press('Escape');
      await page.keyboard.type('\\ after');
      await page.keyboard.press('Enter');
      await untilScreen(page, /after$/m);
      await sleep(500);
      assert.deepEqual(console, [], 'nothing in the console');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test('an ended terminal is dimmed and takes no input', async (t) => {
    const l = await launched(t, chromium);
    const { page, d } = l;
    d.resumable(S1);
    await resumeHere(page, S1);
    await untilScreen(page, promptOf(S1));
    await typeLine(page, '/exit');
    await page.waitForSelector('#terminal .tv-term.over:not([hidden])', { timeout: PAGE_WAIT_MS });
    await mark(page, 'ended');
    await page.locator('#terminal .tv-term:not([hidden]) .xterm-screen').click();
    await page.keyboard.type('nothing');
    await sleep(500);
    assert.deepEqual(
      after(await logOf(page), 'ended').filter((entry) => entry.e === 'out' && entry.t === 'input'),
      [],
    );
    assert.deepEqual(l.problems, [], 'the page reports no problem');
  });
});
