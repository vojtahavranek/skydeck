// The terminal view in a browser (plan task 28; S2 8.2.4, 8.2.6, 9, 12.6, 15.4, 17.4): a real test
// server whose terminals run the stand-in, and the page's real modules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { test } from 'node:test';

import type { Page } from 'playwright';

import type { Platform } from '../src/platform/types.ts';
import type { StreamSink } from '../src/window/hub.ts';
import { parsePidLine } from '../src/window/pidline.ts';
import type { RunningServer } from '../src/window/server.ts';
import { procStartOf, sleep, stillRuns } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { readRecords } from '../test/helpers/standin.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  RECORDER,
  after,
  connection,
  honest,
  launched,
  logOf,
  mark,
  scriptedList,
  standinServer,
  storeKey,
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

/**
 * Sends `signal` to the keeper of the terminal `term`, a process this test's server started: its
 * pid line is checked (a whole pid above 1, never this process), the process must be the one the
 * line names (its start) and run with this sandbox on its command line.
 */
function signalOwnKeeper(
  d: ServerSandbox,
  term: string,
  signal: 'SIGSTOP' | 'SIGCONT',
): { pid: number; procStart: number } {
  const line = parsePidLine(readFileSync(d.files.termPid(term), 'utf8'));
  assert.ok(line !== null, `terminal ${term} has a pid line`);
  const { pid, procStart } = line;
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `a pid to signal: ${pid}`);
  assert.ok(pid !== process.pid && pid !== process.ppid, 'never this process or its parent');
  assert.equal(procStartOf(pid), procStart, 'the process the pid line names');
  assert.ok(stillRuns(pid, procStart));
  const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  assert.ok(cmdline.includes(d.s.root), 'a keeper of this sandbox');
  process.kill(pid, signal);
  return { pid, procStart };
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
    },
  );

  await t.test(
    'find: Ctrl+Shift+F finds a line printed 3,000 lines up; Esc gives the terminal the keyboard back',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
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
      await page.keyboard.press('Escape');
      await untilTerminalOf(page, S1);
      assert.equal(await page.locator('.tv-find').isHidden(), true);
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
    },
  );

  await t.test(
    'the reconnecting bar while the server cannot reach the keeper (stopped for 3 s), and input-full for a key meanwhile; both gone after',
    async (t) => {
      const sockets: { path: string; socket: Socket }[] = [];
      const l = await launched(t, chromium, {
        server: {
          platform: (p: Platform) => ({
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
      signalOwnKeeper(d, term, 'SIGSTOP');
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
        signalOwnKeeper(d, term, 'SIGCONT');
      }
      await until(async () => (await noticeText(page, 'reconnecting')) === '', 'reconnected');
      await page.keyboard.press('w');
      await until(async () => (await noticeText(page, 'input-full')) === '', 'input taken again');
      await until(() => inputOf(d.record, S1).endsWith(hexOf('w')), 'the key reached the program');
    },
  );

  await t.test(
    'gap and newer-keeper notices (sent through the hub) are shown on their terminal; after a server restart the terminal shows the same screen from a fresh snap, a dismissed gap the server repeats is not shown again, and a notice the new server does not repeat goes',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const sinks = captureSinks(l.server);
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await typeLine(page, '/red before the restart');
      await untilScreen(page, /^before the restart$/m);
      const sink = sinks.get(term);
      assert.ok(sink !== undefined, 'the page’s sink');
      sink.notice('gap', GAP);
      sink.notice('newer-keeper', NEWER);
      await until(async () => (await noticeText(page, 'gap')) === GAP, 'the gap shown');
      await until(async () => (await noticeText(page, 'newer-keeper')) === NEWER, 'newer shown');
      // Dismissed: the gap's × (a mouse click leaves the keyboard in the terminal).
      await page.locator('#terminal .tv-bar[data-kind="gap"] .tv-bar-close').click();
      assert.equal(await noticeText(page, 'gap'), '');
      await untilTerminalOf(page, S1);
      const screen = await screenText(page);

      const port = l.server.port;
      await mark(page, 'restart');
      await l.server.stop('the test restarts it');
      const again = await d.start({ port });
      // The new server repeats the gap after the snapshot; it does not hold a newer keeper.
      captureSinks(again.server, (_, repeated) => repeated.notice('gap', GAP));
      await until(
        async () =>
          after(await logOf(page), 'restart').some(
            (entry) => entry.e === 'in' && entry.t === 'snap' && entry.term === term,
          ),
        'a fresh snap',
      );
      // The same screen; the "restarted" bar above it then makes the area smaller, and the
      // program redraws below for the new size.
      const kept = screen.slice(
        0,
        screen.indexOf('before the restart') + 'before the restart'.length,
      );
      await until(async () => (await screenText(page)).startsWith(kept), 'the same screen');
      await typeLine(page, '/red after');
      await untilScreen(page, /^after$/m);
      assert.equal(await noticeText(page, 'newer-keeper'), '', 'not repeated: no longer holds');
      assert.equal(await noticeText(page, 'gap'), '', 'dismissed: not shown for a repeat');
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
  });
});
