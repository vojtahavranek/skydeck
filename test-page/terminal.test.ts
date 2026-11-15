// The terminal view in a browser (plan task 28; S2 8.2.4, 8.2.6, 9, 12.6, 15.4, 17.4): a real test
// server whose terminals run the stand-in, and the page's real modules.
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { test } from 'node:test';

import type { Page } from 'playwright';

import type { Platform } from '../src/platform/types.ts';
import { encodeOutputFrame } from '../src/window/protocol.ts';
import type { StreamSink } from '../src/window/hub.ts';
import type { RunningServer } from '../src/window/server.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { serverKeepers } from '../test/helpers/registry.ts';
import { readRecords } from '../test/helpers/standin.ts';
import { startTestServer } from '../test/helpers/window.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser, newContext, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  RECORDER,
  RESTARTED,
  active,
  after,
  assetBase,
  connection,
  honest,
  launched,
  logOf,
  mark,
  pageUrl,
  problemsOf,
  readPage,
  scriptedList,
  showsText,
  standinServer,
  storeKey,
  zone,
} from './helpers/shell.ts';
import type { Logged } from './helpers/shell.ts';
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
  'this terminal is not taking input at the moment: not all of what you typed or pasted reached the program';

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

const MiB = 1024 * 1024;

/** How long the input-full case waits for the page to show what a server message says: under
 *  heavy load (a load of 75 on 16 cores) the page can be more than PAGE_WAIT_MS behind. */
const BEHIND_MS = 60_000;

/** One input the server's hub was given, and its answer ('full' sends the page `input-full`). */
interface InputAnswer {
  term: string;
  bytes: number;
  /** Its first 6 bytes as Latin-1: a key, or the start of a part of a paste. */
  head: string;
  answer: string;
}

/** The inputs the server's hub is given from now on, with its answers, in order. */
function inputAnswers(server: RunningServer): InputAnswer[] {
  const answers: InputAnswer[] = [];
  const input = server.hub.input.bind(server.hub);
  server.hub.input = (term, data) => {
    const answer = input(term, data);
    const head = Buffer.from(data.subarray(0, 6)).toString('latin1');
    answers.push({ term, bytes: data.length, head, answer });
    return answer;
  };
  return answers;
}

/** The page's WebSockets so far, as the recorder logged them. */
function socketsOf(log: Logged[]): number {
  return log.filter((e) => e.e === 'ws').length;
}

/** The `input` messages for `term` the page has sent, as the recorder logged them. */
function inputsSent(log: Logged[], term: string): number {
  return log.filter((e) => e.e === 'out' && e.t === 'input' && e.term === term).length;
}

async function isOpen(page: Page): Promise<boolean> {
  return (
    (await readPage(page, () => document.documentElement.dataset['connection'], null)) === 'open'
  );
}

/**
 * Presses `key` in the shown terminal once the page's connection is open, and again when the
 * page sent nothing for it because it lost the connection meanwhile: while the page reconnects
 * (S2 6.3; under heavy load a drop can come at any time) its `send` drops input. Every loss is
 * followed by a new socket, so one counted while open tells a lost press from a slow one.
 * `settle` runs before each press, once the connection is open (the case's wait for refusals:
 * it then accounts for a reconnect before any input has gone out on the new connection).
 */
async function pressSent(
  page: Page,
  term: string,
  key: string,
  settle: () => Promise<void>,
): Promise<void> {
  for (let tries = 0; ; tries++) {
    assert.ok(
      tries < 5,
      `the page sent ${key} (pressed 5 times; it lost its connection each time)`,
    );
    await connection(page, 'open', BEHIND_MS);
    await settle();
    // The state and the sockets in one read, so that a socket counted here was open.
    const now = await readPage(
      page,
      () => ({
        open: document.documentElement.dataset['connection'] === 'open',
        log: JSON.parse(sessionStorage.getItem('skydeck-test-log') ?? '[]') as Logged[],
      }),
      null,
    );
    if (!now.open) continue;
    const before = inputsSent(now.log, term);
    const sockets = socketsOf(now.log);
    await page.keyboard.press(key);
    const sent = async (): Promise<boolean> => inputsSent(await logOf(page), term) > before;
    await until(
      async () => (await sent()) || socketsOf(await logOf(page)) > sockets,
      `the page sent ${key}, or connected again`,
    );
    if (await sent()) return;
  }
}

/**
 * Pastes `size` bytes of `y` into the shown terminal (the page sends it as `input` messages of
 * 64 KiB, bracketed when the program asked for it) and waits until the server has answered every
 * part; returns those answers.
 */
async function pasteAnswered(
  page: Page,
  answers: InputAnswer[],
  term: string,
  size: number,
  settle: () => Promise<void>,
): Promise<InputAnswer[]> {
  const from = answers.length;
  await page.evaluate((size) => navigator.clipboard.writeText('y'.repeat(size)), size);
  await pressSent(page, term, 'Control+V', settle);
  const parts = (): InputAnswer[] => answers.slice(from).filter((a) => a.term === term);
  await until(
    () => {
      const all = parts();
      const marks = all[0]?.head === '\x1b[200~' ? '\x1b[200~\x1b[201~'.length : 0;
      return all.reduce((sum, a) => sum + a.bytes, 0) >= size + marks;
    },
    `the server's answers to every part of a paste of ${size} bytes`,
    60_000,
  );
  return parts();
}

/** Presses `key` in the shown terminal and returns the server's answer to it. */
async function keyAnswered(
  page: Page,
  answers: InputAnswer[],
  term: string,
  key: string,
  settle: () => Promise<void>,
): Promise<string> {
  const from = answers.length;
  await pressSent(page, term, key, settle);
  const answer = (): InputAnswer | undefined =>
    answers.slice(from).find((a) => a.term === term && a.head === key);
  await until(() => answer() !== undefined, `the server's answer to ${key}`);
  return answer()?.answer ?? '';
}

/**
 * A wait until no `input-full` the server sent for `term` can still reach the page: each one has
 * come (as the recorder saw it, before the view took it into account), or went with a connection
 * the page dropped. The page drops one whose ping had no pong for 3 s (S2 6.3) and connects
 * again; a large paste under heavy load can cause it (the ping waits behind the paste at the
 * server), and what the old connection still carried never comes. Once the server has answered
 * all the old one carried (every input the page sent, or nothing new for 3 s), the new one is
 * open and nothing more has come for 1 s, what has not come is lost. The connection it counts
 * from is the page's latest whenever nothing is on its way. The recorder logs no notice's kind,
 * so a gap or newer-keeper notice for `term` would count too; the case that uses this has none.
 */
async function refusalSync(
  page: Page,
  answers: InputAnswer[],
  term: string,
): Promise<() => Promise<void>> {
  let sockets = socketsOf(await logOf(page));
  let lost = 0;
  return async () => {
    let answered = -1;
    let quietSince = 0;
    let lastReceived = -1;
    let stillSince = 0;
    await until(
      async () => {
        const log = await logOf(page);
        const mine = answers.filter((a) => a.term === term);
        const refused = mine.filter((a) => a.answer === 'full').length;
        const received = log.filter(
          (e) => e.e === 'in' && e.t === 'notice' && e.term === term,
        ).length;
        if (received + lost >= refused) {
          // Nothing on its way: from here on, count from the page's latest connection (a reconnect
          // that lost nothing must not make a later slow refusal look lost).
          if (mine.length >= inputsSent(log, term)) sockets = socketsOf(log);
          return true;
        }
        if (received !== lastReceived) {
          lastReceived = received;
          stillSince = performance.now();
        }
        if (socketsOf(log) === sockets) return false; // the same connection: they are on their way
        if (mine.length !== answered) {
          answered = mine.length;
          quietSince = performance.now();
        }
        if (mine.length < inputsSent(log, term) && performance.now() - quietSince < 3000)
          return false;
        if (!(await isOpen(page)) || performance.now() - stillSince < 1000) return false;
        sockets = socketsOf(log);
        lost = refused - received;
        return true;
      },
      'every input-full the server sent has reached the page, or went with a dropped connection',
      60_000,
    );
  };
}

/**
 * What the page got after it last sent `term` input, as the recorder logged it in the page's own
 * order: the input-full notices for `term` (the view keeps the notice after an input exactly when
 * one came, S2 12.6), and whether it made a new connection since.
 */
function afterInput(log: Logged[], term: string): { refusals: number; reconnected: boolean } {
  let refusals = 0;
  let reconnected = false;
  for (const e of log) {
    if (e.e === 'out' && e.t === 'input' && e.term === term) {
      refusals = 0;
      reconnected = false;
    } else if (e.e === 'in' && e.t === 'notice' && e.term === term) {
      refusals++;
    } else if (e.e === 'ws') {
      reconnected = true;
    }
  }
  return { refusals, reconnected };
}

/** Which terminals held an input-full notice after a change, and how many notices for a terminal
 *  the page had received by then (as the recorder logged them, before the page handled each). */
interface InputFullChange {
  terms: string[];
  notices: number;
}

/**
 * Records in the page, from now on, every change of which terminals hold an input-full notice
 * (one shown for a moment only is in it too); `inputFullChanges` gives them in order.
 */
async function watchInputFull(page: Page): Promise<void> {
  await page.evaluate(() => {
    const area = document.getElementById('terminal');
    if (area === null) throw new Error('no #terminal');
    const changes: { terms: string[]; notices: number }[] = [];
    let last = '';
    new MutationObserver(() => {
      const terms = [...area.querySelectorAll<HTMLElement>('.tv-term')]
        .filter((box) => box.querySelector('.tv-bar[data-kind="input-full"]') !== null)
        .map((box) => box.dataset['term'] ?? '');
      if (terms.join(' ') === last) return;
      last = terms.join(' ');
      const log = JSON.parse(sessionStorage.getItem('skydeck-test-log') ?? '[]') as {
        e: string;
        t?: string;
        term?: string;
      }[];
      const notices = log.filter(
        (e) => e.e === 'in' && e.t === 'notice' && e.term !== undefined,
      ).length;
      changes.push({ terms, notices });
    }).observe(area, { childList: true, subtree: true });
    Object.assign(window, { inputFullChanges: changes });
  });
}

async function inputFullChanges(page: Page): Promise<InputFullChange[]> {
  return page.evaluate(
    () => (window as unknown as { inputFullChanges: InputFullChange[] }).inputFullChanges,
  );
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
    'OSC 52 writes the clipboard from the shown terminal of a focused, visible window only; not from a hidden terminal, an unfocused or hidden window, nor a read, a payload over 1 MiB or one that is not base64',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await allowClipboard(page, l.server.port);
      const sinks = captureSinks(l.server);
      d.resumable(S1);
      d.resumable(S2);
      const term1 = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await page.evaluate(() => navigator.clipboard.writeText('before'));
      await typeLine(page, '/osc52 from-the-shown-one');
      await until(async () => (await clipboardText(page)) === 'from-the-shown-one', 'written');

      const term2 = await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      // S1 is attached and not shown: its program writes the clipboard.
      l.server.hub.input(term1, Buffer.from('/osc52 from-a-hidden-one\r'));
      await until(
        () => inputOf(d.record, S1).includes(hexOf('/osc52 from-a-hidden-one')),
        'the hidden one wrote its OSC 52',
      );
      await sleep(1000);
      assert.equal(await clipboardText(page), 'from-the-shown-one', 'not from a hidden terminal');

      // The shown one, in a window without focus, then in a hidden window.
      const sink = sinks.get(term2);
      assert.ok(sink !== undefined);
      const osc52 = (payload: string): void => {
        sink.output(Buffer.from(`\x1b]52;c;${payload}\x07`, 'latin1'));
      };
      const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
      await page.evaluate(() => {
        Reflect.set(globalThis, 'hasFocusOf', document.hasFocus.bind(document));
        document.hasFocus = () => false;
      });
      osc52(base64('from-an-unfocused-window'));
      await sleep(500);
      await page.evaluate(() => {
        document.hasFocus = Reflect.get(globalThis, 'hasFocusOf') as () => boolean;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      });
      osc52(base64('from-a-hidden-window'));
      await sleep(500);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      });
      // A read, a payload over 1 MiB, one that is not base64.
      await mark(page, 'reads');
      osc52('?');
      osc52(base64('x'.repeat(1024 * 1024 + 1)));
      osc52('%%% not base64 %%%');
      await sleep(1000);
      assert.equal(await clipboardText(page), 'from-the-shown-one', 'none of them wrote it');
      assert.deepEqual(
        after(await logOf(page), 'reads').filter((e) => e.e === 'out' && e.t === 'input'),
        [],
        'a read is never answered',
      );
      // And the same path writes it when nothing stands against it.
      osc52(base64('through the same path'));
      await until(async () => (await clipboardText(page)) === 'through the same path', 'written');
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
    'input-full (the program stalled, a large paste): shown on its terminal once input is refused and not before, kept while input is refused, gone once input is taken again',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await allowClipboard(page, l.server.port);
      // What the server did with each input is read from its hub, never assumed: under load it
      // refuses a large paste early, while the keeper is slow to fill, and a key right after can
      // then be taken (the queue fell back under its limit) — and the notice rightly goes.
      const answers = inputAnswers(l.server);
      const sinks = captureSinks(l.server);
      const refused = (some: InputAnswer[]): number =>
        some.filter((a) => a.answer === 'full').length;
      const shown = async (): Promise<boolean> =>
        (await noticeText(page, 'input-full')) === INPUT_FULL;
      d.resumable(S1);
      d.resumable(S2);
      // Two terminals attached, so that "on its terminal" can fail: S2's stays attached, hidden.
      const other = await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await watchInputFull(page);
      const refusalsReached = await refusalSync(page, answers, term);
      // Long enough that everything up to the second paste reaches the server while it stalls,
      // even under heavy load (17 s at a load of 50; over 40 s once at 85); checked below.
      const stall = '/stall 60\r';
      await typeLine(page, stall.slice(0, -1));
      await untilScreen(page, /stalling 60 s/);
      const stalled = (): boolean => inputOf(d.record, S1).endsWith(hexOf(stall));
      const stillStalled = 'the stall still on (the program read nothing since /stall)';
      // Input the server takes shows nothing: the typed line, and a paste it takes whole while
      // the program stalls (the keeper alone takes 4 MiB).
      await pasteAnswered(page, answers, term, MiB, refusalsReached);
      await sleep(1500);
      assert.equal(refused(answers), 0, 'the server took all of it');
      assert.deepEqual(await inputFullChanges(page), [], 'no notice without a refusal');
      // More than the keeper (4 MiB), the sockets and the server (4 MiB) take while it stalls.
      // Pasted again when the page dropped its connection before any refusal of it came (it
      // never learns of them then).
      for (let pastes = 0; ; pastes++) {
        assert.ok(pastes < 3, 'a refusal of the paste reached the page (pasted 3 times)');
        const first = await pasteAnswered(page, answers, term, 10 * MiB, refusalsReached);
        assert.ok(stalled(), stillStalled);
        assert.ok(refused(first) > 0, 'part of the paste refused');
        await refusalsReached();
        const got = afterInput(await logOf(page), term);
        if (got.refusals > 0) break;
        assert.ok(got.reconnected, 'a refusal of the paste reached the page');
      }
      await until(shown, 'shown', BEHIND_MS);
      const firstShown = await inputFullChanges(page);
      assert.deepEqual(firstShown.at(-1)?.terms, [term], 'on its terminal only');
      assert.ok((firstShown[0]?.notices ?? 0) > 0, 'shown only once a refusal reached the page');
      // Every refusal of the first paste is in before the second is sent (each press waits for
      // that): only the second's can keep the notice then.
      // Input refused while it shows keeps it: a second paste, refused in part whatever the
      // first left room for (all that is taken while it stalls, some 8.3 MiB, is far below the
      // 17 MiB pasted; at most 8.3 - 1 - 4 MiB is left for this one).
      const second = await pasteAnswered(page, answers, term, 6 * MiB, refusalsReached);
      assert.ok(stalled(), stillStalled);
      assert.ok(refused(second) > 0, 'part of the second paste refused');
      await refusalsReached();
      await sleep(1500);
      // Kept when a refusal of it reached the page, which it does unless the page dropped its
      // connection meanwhile (then the page never learns of it, and the notice rightly goes).
      const keeps = async (what: string): Promise<void> => {
        const got = afterInput(await logOf(page), term);
        if (got.refusals === 0) {
          assert.ok(got.reconnected, `a refusal reached the page ${what}`);
          await until(
            async () => !(await shown()),
            `gone ${what}: no refusal of it came`,
            BEHIND_MS,
          );
        } else {
          assert.equal(await shown(), true, `kept ${what}`);
        }
      };
      await keeps('while input is refused');
      // Keys, each another letter, until the server takes one (it refuses them while more than
      // 4 MiB wait for the keeper, which may outlast the stall): a refused key keeps the notice,
      // the taken one makes it go. Each is pressed once the page has every refusal sent before.
      const letters = 'xabcdefghijklmnopqrstuvwz0123456789';
      const keys: { key: string; answer: string }[] = [];
      const deadline = performance.now() + 120_000;
      for (;;) {
        assert.ok(performance.now() < deadline, `a key taken: ${JSON.stringify(keys)}`);
        const key = letters.charAt(keys.length % letters.length);
        const answer = await keyAnswered(page, answers, term, key, refusalsReached);
        keys.push({ key, answer });
        if (answer === 'ok') break;
        assert.equal(answer, 'full', `the server's answer to ${key}`);
        await sleep(1500);
        await refusalsReached();
        await keeps(`after ${key} was refused`);
      }
      await until(
        async () => (await noticeText(page, 'input-full')) === '',
        'gone once a key is taken',
        BEHIND_MS,
      );
      const changes = await inputFullChanges(page);
      assert.deepEqual(changes.at(-1)?.terms, [], 'gone from every terminal');
      assert.ok(
        changes.every((change) => change.terms.every((id) => id === term)),
        'never on the other terminal',
      );
      // The program reads the key the server took, and none it refused.
      const taken = keys.at(-1)?.key ?? '';
      const keysRead = (): string => {
        const read = Buffer.from(inputOf(d.record, S1), 'hex').toString('latin1');
        return read
          .slice(read.indexOf(stall) + stall.length)
          .replaceAll('\x1b[200~', '')
          .replaceAll('\x1b[201~', '')
          .replaceAll('y', '');
      };
      // (Polled slowly: the record holds all the program read, several MiB.)
      for (const readBy = performance.now() + 60_000; !keysRead().includes(taken);) {
        if (performance.now() >= readBy) {
          assert.fail(
            `the program read ${taken} within 60 s; besides the pastes it read ${JSON.stringify(keysRead())}`,
          );
        }
        await sleep(500);
      }
      assert.equal(keysRead(), taken, 'only the key taken reached the program');
      // A refusal for the other terminal (sent through its stream while this one is shown) is
      // shown on that one only. It is sent once the page has caught up with the program's echo
      // (the taken key is its last) and that terminal is attached on the current connection;
      // again when the page connects anew or that terminal is attached anew before it shows (a
      // notice through a stream that has ended is dropped: the server ends a stream it marked
      // lost while the page was behind, S2 8.2.8).
      // (The key may begin a row of its own: the echo wraps.)
      await untilScreen(page, new RegExp(`[y~]\\n?${taken}$`, 'm'), BEHIND_MS);
      const onOther = async (): Promise<boolean> =>
        (await inputFullChanges(page)).at(-1)?.terms.join(' ') === other;
      const snapsOf = (log: Logged[]): number =>
        log.filter((e) => e.e === 'in' && e.t === 'snap' && e.term === other).length;
      const attachedNow = (log: Logged[]): boolean =>
        log.some(
          (e) => e.e === 'in' && e.t === 'snap' && e.term === other && e.s === socketsOf(log),
        );
      for (let sends = 0; !(await onOther()); sends++) {
        assert.ok(sends < 5, 'on the other terminal only (sent 5 times)');
        await until(
          async () => (await isOpen(page)) && attachedNow(await logOf(page)),
          'the other terminal attached on the current connection',
          BEHIND_MS,
        );
        const sink = sinks.get(other);
        assert.ok(sink !== undefined, "the other terminal's sink");
        const log = await logOf(page);
        const sockets = socketsOf(log);
        const snaps = snapsOf(log);
        sink.notice('input-full', INPUT_FULL);
        await until(
          async () => {
            if (await onOther()) return true;
            const now = await logOf(page);
            return socketsOf(now) > sockets || snapsOf(now) > snaps;
          },
          'on the other terminal only',
          BEHIND_MS,
        );
      }
      assert.equal(await noticeText(page, 'input-full'), '', 'not on the shown terminal');
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
      // Only xterm.js's own textarea is inside `.xterm`: the view's controls are beside it, so that
      // app.js never takes a key held on one of them for the program's (#70's rule).
      await page.keyboard.press('Control+Shift+F');
      await page.keyboard.press('Escape');
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelectorAll(
              '#terminal .xterm .tv-find, #terminal .xterm .tv-bar, #terminal .xterm .tv-hint, #terminal .xterm button, #terminal .xterm input',
            ).length,
        ),
        0,
        'no control of the view inside .xterm',
      );

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
      // And the new stream is live: a line typed now appears.
      await typeLine(page, '/red after the second restart');
      await untilScreen(page, /^after the second restart$/m);
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

  await t.test(
    "focus reporting: xterm.js's own report when the program turns it on, or when a snapshot restores it, reaches no program and makes no window the size owner; a real focus change is reported",
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const reports = (): { in: number; out: number } => {
        const read = Buffer.from(inputOf(d.record, S1), 'hex').toString('latin1');
        return { in: read.split('\x1b[I').length - 1, out: read.split('\x1b[O').length - 1 };
      };
      // The program turns focus reporting on (the screen side keeps the mode for snapshots).
      l.server.hub.input(term, Buffer.from('/red \x1b[?1004hreports on\r'));
      await untilScreen(page, /^reports on$/m);
      await sleep(800);
      assert.deepEqual(reports(), { in: 0, out: 0 }, 'nothing that the user did');
      // Real focus changes: the list takes the keyboard, then the terminal again.
      await page.keyboard.press('Control+Shift+L');
      await until(() => reports().out === 1, 'the focus leaving reported');
      await page.keyboard.press('Control+Shift+L');
      await until(() => reports().in === 1, 'the focus coming back reported');

      // A second window that only attaches: its snapshot restores the mode.
      const other = await page.context().newPage();
      await other.setViewportSize({ width: 900, height: 500 });
      await other.goto(pageUrl(l.server.port));
      await connection(other, 'open');
      await untilTerminalOf(other, S1);
      await untilScreen(other, /^reports on$/m);
      await sleep(1000);
      assert.deepEqual(reports(), { in: 1, out: 1 }, 'the second window sent nothing');
      const hinted = (p: Page): Promise<boolean> =>
        p.evaluate(() => {
          const hint = document.querySelector('#terminal .tv-term:not([hidden]) .tv-hint');
          return hint instanceof HTMLElement && !hint.hidden;
        });
      assert.equal(await hinted(other), true, 'the second window does not own the size');
      assert.equal(await hinted(page), false, 'the first one still does');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'one narrowing of the window is one resize of the program (at most two), and the page is never wider than its window',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await sleep(1000);
      const resizes = (): string[] =>
        recordsOf(d.record, S1).flatMap((e) => (e.ev === 'resize' ? [`${e.cols}x${e.rows}`] : []));
      for (const width of [900, 1000, 1280]) {
        const before = resizes().length;
        await page.setViewportSize({ width, height: 720 });
        await sleep(1500);
        const got = resizes().slice(before);
        assert.ok(got.length >= 1 && got.length <= 2, `${width} px: ${JSON.stringify(got)}`);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth),
          width,
          `${width} px: the page is as wide as its window`,
        );
      }
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'queries the stand-in does not ask are swallowed too: the page sends nothing for any of them',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const sinks = captureSinks(l.server);
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const sink = sinks.get(term);
      assert.ok(sink !== undefined);
      const ESC = '\x1b';
      const probes: [string, string][] = [
        ['DA1', `${ESC}[c`],
        ['DA1 0', `${ESC}[0c`],
        ['DA2', `${ESC}[>c`],
        ['DA3', `${ESC}[=c`],
        ['DSR 5', `${ESC}[5n`],
        ['CPR 6', `${ESC}[6n`],
        ['DECXCPR ?6', `${ESC}[?6n`],
        ['DSR ?15', `${ESC}[?15n`],
        ['DSR ?996', `${ESC}[?996n`],
        ['DECRQM ansi 4', `${ESC}[4$p`],
        ['DECRQM ?2026', `${ESC}[?2026$p`],
        ['DECRQM ?1004', `${ESC}[?1004$p`],
        ['DECRQSS m', `${ESC}P$qm${ESC}\\`],
        ['DECRQSS "p', `${ESC}P$q"p${ESC}\\`],
        ['DECRQSS SP q', `${ESC}P$q q${ESC}\\`],
        ['XTVERSION >0q', `${ESC}[>0q`],
        ['XTVERSION >q', `${ESC}[>q`],
        ['CSI 14t', `${ESC}[14t`],
        ['CSI 16t', `${ESC}[16t`],
        ['CSI 18t', `${ESC}[18t`],
        ['CSI 19t', `${ESC}[19t`],
        ['CSI 21t', `${ESC}[21t`],
        ['OSC 4;1;?', `${ESC}]4;1;?\x07`],
        ['OSC 10;?', `${ESC}]10;?\x07`],
        ['OSC 10;?;?', `${ESC}]10;?;?${ESC}\\`],
        ['OSC 11;?', `${ESC}]11;?${ESC}\\`],
        ['OSC 12;?', `${ESC}]12;?\x07`],
        ['OSC 52 read', `${ESC}]52;c;?\x07`],
        ['ENQ', '\x05'],
        ['kitty ?u', `${ESC}[?u`],
        ['DECID', `${ESC}Z`],
        ['DECREQTPARM', `${ESC}[0x`],
        ['XTGETTCAP', `${ESC}P+q544e${ESC}\\`],
        ['DECSET 1004', `${ESC}[?1004h`],
        ['DECSET 2004;1004', `${ESC}[?2004;1004h`],
        ['DECSET 2031', `${ESC}[?2031h`],
        ['DECSET 2048', `${ESC}[?2048h`],
        ['DECSET 1000;1006', `${ESC}[?1000;1006h`],
        ['soft reset', `${ESC}[!p`],
        ['RIS', `${ESC}c`],
      ];
      await mark(page, 'probes');
      const answered: string[] = [];
      for (const [name, bytes] of probes) {
        const before = after(await logOf(page), 'probes').filter(
          (e) => e.e === 'out' && e.t === 'input',
        ).length;
        sink.output(Buffer.from(bytes, 'latin1'));
        await sleep(150);
        const now = after(await logOf(page), 'probes').filter(
          (e) => e.e === 'out' && e.t === 'input',
        ).length;
        if (now > before) answered.push(name);
      }
      await sleep(500);
      assert.deepEqual(answered, [], 'answered by the page');
      assert.deepEqual(
        after(await logOf(page), 'probes').filter((e) => e.e === 'out' && e.t === 'input'),
        [],
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a line of 40,000 closing brackets after a URL does not hold the page under the mouse; an OSC 8 target over 2,048 characters is not offered',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const sinks = captureSinks(l.server);
      d.resumable(S1);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const sink = sinks.get(term);
      assert.ok(sink !== undefined);
      sink.output(Buffer.from(`\r\nhttp://x${')'.repeat(40_000)}\r\nbelow\r\n`));
      await untilScreen(page, /^below$/m);
      const brackets = await whereIs(page, '))))))))');
      const started = performance.now();
      await page.mouse.move(brackets.x, brackets.y);
      await page.mouse.move(brackets.x + 30, brackets.y);
      await page.evaluate(() => 1);
      const held = performance.now() - started;
      assert.ok(held < 3000, `the page answered ${Math.round(held)} ms after the moves`);

      sink.output(
        Buffer.from(
          `\x1b]8;;https://example.com/${'a'.repeat(10_000)}\x1b\\a-long-target\x1b]8;;\x1b\\\r\n`,
        ),
      );
      await untilScreen(page, /^a-long-target$/m);
      const calls = d.edgeCalls().length;
      await clickAt(page, await whereIs(page, 'a-long-target'), true);
      await sleep(500);
      assert.equal(await noticeText(page, 'link'), '', 'no target shown');
      await clickAt(page, await whereIs(page, 'a-long-target'), true);
      await sleep(500);
      assert.equal(d.edgeCalls().length, calls, 'nothing opened');

      // A plain URL over 2,048 characters: the page does not even ask the server to open it.
      sink.output(Buffer.from(`https://example.org/${'b'.repeat(2100)}\r\nafter-long-url\r\n`));
      await untilScreen(page, /^after-long-url$/m);
      await mark(page, 'long url');
      await clickAt(page, await whereIs(page, 'https://example.org/'), true);
      await sleep(500);
      assert.deepEqual(
        after(await logOf(page), 'long url').filter((e) => e.e === 'out' && e.t === 'act'),
        [],
        'no open-link asked for',
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'records that come while a very large snap is parsed reach the screen, in order, and nothing is thrown',
    async (t) => {
      const secret = new Uint8Array(32).fill(29);
      const page = await newPage(t, chromium);
      const problems = problemsOf(page);
      const term = 'aaaaaaaaaaaa';
      const list = scriptedList(
        [{ id: S1, terminal: term, slot: 1 }],
        [{ id: term, slot: 1, sessionId: S1 }],
      );
      // 300 coloured cells a row, about 52 MB of text: longer than xterm.js 6.0.0 lets wait.
      const row = Array.from(
        { length: 300 },
        (_, c) => `\x1b[38;5;${(c * 7) % 256}m${String.fromCharCode(97 + (c % 26))}`,
      ).join('');
      const big = `${Array.from({ length: Math.ceil(52_000_000 / row.length) }, () => row).join('\r\n')}\x1b[0m\r\n`;
      let channel = 0;
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message) => {
            if (message['t'] === 'view') conn.send(list);
            if (message['t'] !== 'attach') return;
            channel++;
            conn.send({ t: 'snap', term, ch: channel, cols: 300, rows: 40, data: big });
            const ch = channel;
            void (async () => {
              for (let k = 1; k <= 20; k++) {
                await sleep(100);
                conn.ws.send(encodeOutputFrame(ch, Buffer.from(`record ${k}\r\n`)));
              }
            })();
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await untilScreen(page, /^record 20$/m, 120_000);
      const screen = await screenText(page);
      for (let k = 1; k <= 20; k++) {
        assert.match(screen, new RegExp(`^record ${k}$`, 'm'), `record ${k} on the screen`);
      }
      assert.deepEqual(problems, [], 'nothing thrown, nothing lost');
    },
  );

  await t.test(
    'output that would wait beyond what the view holds for xterm.js is dropped and a fresh snap asked for, nothing thrown; the fresh snap then shows',
    async (t) => {
      const l = await launched(t, chromium);
      const base = await assetBase(l.page);
      const result = await l.page.evaluate(async (base) => {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(
            root: HTMLElement,
            deps: object,
          ): {
            show(term: object): void;
            snap(message: object): void;
            output(channel: number, bytes: Uint8Array): void;
          };
        };
        const sent: Record<string, unknown>[] = [];
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:0;top:0;width:733px;height:411px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: (message: Record<string, unknown>) => sent.push(message),
          chord: () => false,
          openLink: () => {},
        });
        const term = 'eeeeeeeeeeee';
        view.show({
          id: term,
          slot: null,
          sessionId: null,
          state: 'running',
          notReported: false,
          cols: 80,
          rows: 24,
          ownsSize: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        view.snap({ t: 'snap', term, ch: 7, cols: 80, rows: 24, data: 'the first snap\r\n' });
        // 40 MB of records in one go, faster than any parse: more than the view holds.
        const record = new TextEncoder().encode(`${'\x1b[31mx\x1b[0m'.repeat(6000)}\r\n`);
        for (let given = 0; given < 40_000_000; given += record.length) view.output(7, record);
        const attaches = sent.filter((message) => message['t'] === 'attach').length;
        view.snap({ t: 'snap', term, ch: 8, cols: 80, rows: 24, data: 'a fresh snap\r\n' });
        view.output(8, new TextEncoder().encode('and the stream after it\r\n'));
        const deadline = performance.now() + 60_000;
        const rows = (): string => root.querySelector('.xterm-rows')?.textContent ?? '';
        while (!rows().includes('and the stream after it') && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { attaches, rows: rows() };
      }, base);
      assert.equal(result.attaches, 2, 'the attach of the show and one fresh snap asked for');
      assert.match(result.rows, /a fresh snap.*and the stream after it/s);
      assert.doesNotMatch(result.rows, /the first snap/);
      assert.deepEqual(l.problems, [], 'nothing thrown');
    },
  );

  await t.test(
    "after a reconnect, a terminal whose own attach was lost with the connection gets the view's size, not the list's",
    async (t) => {
      const secret = new Uint8Array(32).fill(30);
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      const terms = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'];
      const list = scriptedList(
        [
          { id: S1, terminal: terms[0] ?? '', slot: 1 },
          { id: S2, terminal: terms[1] ?? '', slot: 2 },
        ],
        [
          { id: terms[0] ?? '', slot: 1, sessionId: S1 },
          { id: terms[1] ?? '', slot: 2, sessionId: S2 },
        ],
      );
      let channel = 0;
      const standin = await standinServer(t, {
        socket: honest(secret, {
          open: (conn, message, n) => {
            if (message['t'] === 'view') conn.send(list);
            const term = message['term'];
            if (message['t'] !== 'attach' || typeof term !== 'string') return;
            if (n === 1 && term === terms[1]) {
              // The view's own attach of B: the connection is lost before it is answered.
              setTimeout(() => conn.ws.terminate(), 50);
              return;
            }
            conn.send({ t: 'snap', term, ch: ++channel, cols: 80, rows: 24, data: `${term}\r\n` });
          },
        }),
      });
      await page.goto(standin.url);
      await storeKey(page, secret);
      await page.goto(standin.url);
      await connection(page, 'open');
      await untilScreen(page, /^a{12}$/m);
      await sleep(500);
      await page.keyboard.press('Control+Shift+Digit2');
      await until(async () => (await shownTerm(page)) === terms[1], 'B shown');
      await until(() => standin.connections.length >= 2, 'the page connected again');
      await connection(page, 'open');
      await untilScreen(page, /^b{12}$/m);
      // app.js attached B again with the list's size (80x24); the view's own size must follow.
      const conn = standin.connections.at(-1);
      assert.ok(conn !== undefined);
      const resizeOfB = (): Record<string, unknown> | undefined =>
        conn.received
          .map((text) => JSON.parse(text) as Record<string, unknown>)
          .find((message) => message['t'] === 'resize' && message['term'] === terms[1]);
      await until(() => resizeOfB() !== undefined, "B's own size sent");
      assert.notDeepEqual([resizeOfB()?.['cols'], resizeOfB()?.['rows']], [80, 24]);
    },
  );

  await t.test(
    'sizes settle: for every width 420–1500 px and height 200–900 px at pixel ratios 1, 1.25, 1.5 and 2, the view proposes once what `fits` answers, then never again; a terminal opened at `fits` gets no resize; `fits` answers whole numbers from 1 up, or null, for any area',
    async (t) => {
      const started = await startTestServer(t);
      for (const ratio of [1, 1.25, 1.5, 2]) {
        const context = await newContext(chromium, { deviceScaleFactor: ratio });
        t.after(() => context.close());
        const page = await context.newPage();
        await page.goto(pageUrl(started.server.port));
        const base = await assetBase(page);
        const result = await page.evaluate(async (base) => {
          type View = {
            show(term: object): void;
            snap(message: object): void;
            size(message: object): void;
            fits(width: number, height: number): { cols: number; rows: number } | null;
          };
          const module = (await import(`${base}terminal-view.js`)) as {
            createTerminalView(root: HTMLElement, deps: object): View;
          };
          const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
          const make = (
            width: number,
            height: number,
          ): { view: View; root: HTMLElement; sent: Record<string, unknown>[] } => {
            const sent: Record<string, unknown>[] = [];
            const root = document.createElement('div');
            root.className = 'terminal';
            root.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px`;
            document.body.append(root);
            const view = module.createTerminalView(root, {
              send: (message: Record<string, unknown>) => sent.push(message),
              chord: () => false,
              openLink: () => {},
            });
            return { view, root, sent };
          };
          const payload = (id: string, cols: number, rows: number): object => ({
            id,
            slot: null,
            sessionId: null,
            state: 'running',
            notReported: false,
            cols,
            rows,
            ownsSize: true,
          });
          const bad: string[] = [];
          // One terminal through every area, as the server applies each proposal (R1, R2).
          const { view, root, sent } = make(900, 500);
          const term = 'eeeeeeeeeeee';
          view.show(payload(term, 80, 24));
          await tick();
          view.snap({ t: 'snap', term, ch: 7, cols: 80, rows: 24, data: '' });
          let size = { cols: 80, rows: 24 };
          const areas: [number, number][] = [];
          for (let width = 420; width <= 1500; width++) areas.push([width, 500]);
          for (let height = 200; height <= 900; height++) areas.push([907, height]);
          for (const [width, height] of areas) {
            root.style.width = `${width}px`;
            root.style.height = `${height}px`;
            const answer = view.fits(width, height);
            const proposals: string[] = [];
            for (let step = 0; step < 4; step++) {
              const before = sent.length;
              view.show(payload(term, size.cols, size.rows)); // as app.js at each list
              await Promise.resolve();
              const resize = sent.slice(before).find((message) => message['t'] === 'resize');
              if (resize === undefined) break;
              size = { cols: resize['cols'] as number, rows: resize['rows'] as number };
              proposals.push(`${size.cols}x${size.rows}`);
              view.size({ t: 'size', term, ...size, owner: true });
              await tick();
            }
            const settled = `${size.cols}x${size.rows}`;
            if (
              proposals.length > 1 ||
              answer === null ||
              settled !== `${answer.cols}x${answer.rows}`
            ) {
              bad.push(
                `${width}x${height}: ${proposals.join(' -> ')}; fits ${JSON.stringify(answer)}`,
              );
            }
          }
          root.remove();
          // A terminal opened at what `fits` answers, with none open and with one open (R2).
          const opened: string[] = [];
          for (const [width, height] of [
            [865, 500],
            [895, 500],
            [920, 500],
            [1295, 500],
            [1320, 500],
            [1455, 500],
            [733, 411],
            [907, 333],
          ] as const) {
            for (const withOne of [false, true]) {
              const made = make(width, height);
              if (withOne) {
                made.view.show(payload('aaaaaaaaaaaa', 80, 24));
                await tick();
              }
              const answer = made.view.fits(width, height);
              if (answer === null) {
                opened.push(`${width}x${height}: null`);
                made.root.remove();
                continue;
              }
              const id = 'ffffffffffff';
              made.view.show(payload(id, answer.cols, answer.rows));
              await tick();
              made.view.snap({ t: 'snap', term: id, ch: 9, ...answer, data: '' });
              made.view.show(payload(id, answer.cols, answer.rows));
              await tick();
              const asked = made.sent.filter(
                (message) =>
                  message['term'] === id &&
                  (message['t'] === 'attach' || message['t'] === 'resize'),
              );
              const wrong = asked.filter(
                (message) => message['cols'] !== answer.cols || message['rows'] !== answer.rows,
              );
              if (wrong.length > 0 || asked.some((message) => message['t'] === 'resize')) {
                opened.push(
                  `${width}x${height}${withOne ? ' (one open)' : ''}: fits ${answer.cols}x${answer.rows}, sent ${JSON.stringify(asked)}`,
                );
              }
              made.root.remove();
            }
          }
          // Whatever it is given: whole numbers from 1 up, or null.
          const promise = make(733, 411);
          const odd = (): unknown[] =>
            [
              [0, 0],
              [5, 5],
              [100, -1],
              [-3, 100],
              [Number.NaN, 100],
              [100, Number.POSITIVE_INFINITY],
              [0.5, 0.5],
            ].map(([w, h]) => promise.view.fits(w ?? 0, h ?? 0));
          const answers = [...odd()];
          promise.view.show(payload('bbbbbbbbbbbb', 80, 24));
          await tick();
          answers.push(...odd());
          promise.root.remove();
          return { ratio: devicePixelRatio, areas: areas.length, bad, opened, answers };
        }, base);
        assert.deepEqual(result.bad.slice(0, 5), [], `${ratio}x: of ${result.areas} areas`);
        assert.deepEqual(result.opened, [], `${ratio}x: a terminal opened at fits`);
        for (const answer of result.answers) {
          if (answer === null) continue;
          const { cols, rows } = answer as { cols: number; rows: number };
          assert.ok(
            Number.isInteger(cols) && cols >= 1 && Number.isInteger(rows) && rows >= 1,
            `${ratio}x: ${JSON.stringify(answer)} is whole and at least 1`,
          );
        }
        for (const at of [0, 2, 3, 4, 7, 9, 10, 11]) {
          assert.equal(result.answers[at], null, `${ratio}x: answer ${at} is null (no area)`);
        }
      }
    },
  );

  await t.test(
    "the rule is xterm.js's own: at the proposed size the real screen ends inside the box (the addon's 14 px scroll bar left free), and one more column or one more row would not; a sample of widths and heights at each pixel ratio, at two font sizes",
    async (t) => {
      const started = await startTestServer(t);
      for (const ratio of [1, 1.25, 1.5, 2]) {
        const context = await newContext(chromium, { deviceScaleFactor: ratio });
        t.after(() => context.close());
        const page = await context.newPage();
        await page.goto(pageUrl(started.server.port));
        const base = await assetBase(page);
        for (const fontSize of ['14px', '13.3px']) {
          const bad = await page.evaluate(
            async ({ base, fontSize }) => {
              // 13.3 px: a font whose cell is no whole number of pixels high (xterm.js rounds it up).
              document.documentElement.style.setProperty('--term-font-size', fontSize);
              const module = (await import(`${base}terminal-view.js`)) as {
                createTerminalView(
                  root: HTMLElement,
                  deps: object,
                ): {
                  show(term: object): void;
                  size(message: object): void;
                  snap(message: object): void;
                };
              };
              const sent: Record<string, unknown>[] = [];
              const root = document.createElement('div');
              root.className = 'terminal';
              root.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px';
              document.body.append(root);
              const view = module.createTerminalView(root, {
                send: (message: Record<string, unknown>) => sent.push(message),
                chord: () => false,
                openLink: () => {},
              });
              const term = 'eeeeeeeeeeee';
              const payload = (cols: number, rows: number): object => ({
                id: term,
                slot: null,
                sessionId: null,
                state: 'running',
                notReported: false,
                cols,
                rows,
                ownsSize: true,
              });
              view.show(payload(80, 24));
              await new Promise((resolve) => setTimeout(resolve, 20));
              // Its snap: from now on the view proposes (before it, its own attach waits for one).
              view.snap({
                t: 'snap',
                term,
                ch: 7,
                cols: 80,
                rows: 24,
                data: '',
              });
              const screen = (): DOMRect => {
                const element = root.querySelector('.xterm-screen');
                if (!(element instanceof HTMLElement)) throw new Error('no .xterm-screen');
                return element.getBoundingClientRect();
              };
              /** The server applies a size: the view resizes its xterm.js; wait until it has. */
              const apply = async (cols: number, rows: number): Promise<DOMRect> => {
                view.size({ t: 'size', term, cols, rows, owner: true });
                for (let i = 0; i < 40; i++) {
                  await new Promise((resolve) => setTimeout(resolve, 0));
                  const element = root.querySelector('.xterm-rows');
                  if (element !== null && element.children.length === rows) break;
                }
                return screen();
              };
              const box = root.querySelector('.tv-screen');
              if (!(box instanceof HTMLElement)) throw new Error('no .tv-screen');
              const out: string[] = [];
              let size = { cols: 80, rows: 24 };
              const areas: [number, number][] = [];
              const step = fontSize === '14px' ? 13 : 29;
              for (let width = 420; width <= 1500; width += step) areas.push([width, 500]);
              for (let height = 200; height <= 900; height += step) areas.push([907, height]);
              for (const [width, height] of areas) {
                root.style.width = `${width}px`;
                root.style.height = `${height}px`;
                const before = sent.length;
                view.show(payload(size.cols, size.rows));
                await Promise.resolve();
                const resize = sent.slice(before).find((message) => message['t'] === 'resize');
                if (resize !== undefined) {
                  size = { cols: resize['cols'] as number, rows: resize['rows'] as number };
                }
                // Edges, not widths: the screen's right edge leaves the box the room the fit addon
                // gave its scroll bar (14 px), its bottom edge stays in the box — whatever padding
                // the page's styles give xterm.js's element (it is not repeated here).
                const room = box.getBoundingClientRect();
                const right = room.right - 14;
                const bottom = room.bottom;
                const at = await apply(size.cols, size.rows);
                const wider = await apply(size.cols + 1, size.rows);
                const higher = await apply(size.cols, size.rows + 1);
                await apply(size.cols, size.rows);
                const where = `${width}x${height} → ${size.cols}x${size.rows}`;
                if (at.right > right + 0.01 || at.bottom > bottom + 0.01) {
                  out.push(
                    `${where}: the screen ends at ${at.right}, ${at.bottom}; the room ${right}, ${bottom}`,
                  );
                }
                if (size.cols < 1000 && wider.right <= right + 0.01) {
                  out.push(`${where}: one more column (to ${wider.right}) would fit ${right}`);
                }
                if (size.rows < 500 && higher.bottom <= bottom + 0.01) {
                  out.push(`${where}: one more row (to ${higher.bottom}) would fit ${bottom}`);
                }
              }
              root.remove();
              return out;
            },
            { base, fontSize },
          );
          assert.deepEqual(bad.slice(0, 5), [], `${ratio}x, ${fontSize}`);
        }
      }
    },
  );

  await t.test(
    "a change of the page's font size brings an open terminal a new proposal, at the new font, whose screen ends inside the box",
    async (t) => {
      const l = await launched(t, chromium);
      const base = await assetBase(l.page);
      const result = await l.page.evaluate(async (base) => {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(
            root: HTMLElement,
            deps: object,
          ): { show(term: object): void; snap(message: object): void; size(message: object): void };
        };
        const sent: Record<string, unknown>[] = [];
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:0;top:0;width:733px;height:411px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: (message: Record<string, unknown>) => sent.push(message),
          chord: () => false,
          openLink: () => {},
        });
        const term = 'f0f0f0f0f0f0';
        const payload = (cols: number, rows: number): object => ({
          id: term,
          slot: null,
          sessionId: null,
          state: 'running',
          notReported: false,
          cols,
          rows,
          ownsSize: true,
        });
        const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
        view.show(payload(80, 24));
        await tick();
        const first = sent.find((message) => message['t'] === 'attach');
        const cols = first?.['cols'] as number;
        const rows = first?.['rows'] as number;
        view.snap({ t: 'snap', term, ch: 7, cols, rows, data: '' });
        await tick();
        document.documentElement.style.setProperty('--term-font-size', '18px');
        const before = sent.length;
        view.show(payload(cols, rows));
        await tick();
        const resize = sent.slice(before).find((message) => message['t'] === 'resize');
        let end: { right: number; bottom: number; rowHeight: number } | null = null;
        if (resize !== undefined) {
          view.size({ t: 'size', term, cols: resize['cols'], rows: resize['rows'], owner: true });
          for (let i = 0; i < 40; i++) {
            await tick();
            if (root.querySelector('.xterm-rows')?.children.length === resize['rows']) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          const screen = root.querySelector('.xterm-screen')?.getBoundingClientRect();
          end =
            screen === undefined
              ? null
              : {
                  right: screen.right,
                  bottom: screen.bottom,
                  rowHeight: screen.height / (resize['rows'] as number),
                };
        }
        document.documentElement.style.removeProperty('--term-font-size');
        const box = root.querySelector('.tv-screen')?.getBoundingClientRect();
        root.remove();
        return {
          first: { cols, rows },
          resize: resize === undefined ? null : { cols: resize['cols'], rows: resize['rows'] },
          end,
          room: box === undefined ? null : { right: box.right - 14, bottom: box.bottom },
        };
      }, base);
      assert.ok(result.resize !== null, 'a new proposal');
      const resize = result.resize as { cols: number; rows: number };
      assert.ok(
        resize.cols < result.first.cols && resize.rows < result.first.rows,
        'a larger font',
      );
      assert.ok(result.end !== null && result.room !== null);
      assert.ok(result.end.right <= result.room.right + 0.01, 'the screen ends inside the box');
      assert.ok(result.end.bottom <= result.room.bottom + 0.01);
      assert.ok(
        result.end.rowHeight > 18,
        `drawn at the new font: rows ${result.end.rowHeight} px high`,
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a window 1295 px wide (where the fit addon flipped between 104 and 103 columns) gives the program its size once, and then no resize',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await page.setViewportSize({ width: 1295, height: 720 });
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await sleep(2000);
      const resizes = (): string[] =>
        recordsOf(d.record, S1).flatMap((e) => (e.ev === 'resize' ? [`${e.cols}x${e.rows}`] : []));
      const settled = resizes();
      await sleep(5000);
      assert.deepEqual(resizes(), settled, `no resize while nothing changes: ${settled.join(' ')}`);
      assert.ok(settled.length <= 2, `${settled.join(' ')}`);
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "the view's own rule keeps the fit to the area: in a box that grows with what it holds (a grid column without min-width: 0), a wide terminal does not widen the area it is fitted to",
    async (t) => {
      const l = await launched(t, chromium);
      const base = await assetBase(l.page);
      const result = await l.page.evaluate(async (base) => {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(
            root: HTMLElement,
            deps: object,
          ): {
            show(term: object): void;
            fits(width: number, height: number): { cols: number; rows: number } | null;
          };
        };
        const sent: Record<string, unknown>[] = [];
        const grid = document.createElement('div');
        grid.style.cssText =
          'position:fixed;left:0;top:0;width:900px;height:400px;display:grid;grid-template-columns:400px 1fr';
        // As in the page: the grid item is a zone (no min-width: 0) that holds the view's root.
        const side = document.createElement('div');
        const zone = document.createElement('div');
        zone.style.cssText = 'display:flex;flex-direction:column;min-height:0';
        const root = document.createElement('div');
        root.className = 'terminal';
        zone.append(root);
        grid.append(side, zone);
        document.body.append(grid);
        const view = module.createTerminalView(root, {
          send: (message: Record<string, unknown>) => sent.push(message),
          chord: () => false,
          openLink: () => {},
        });
        // A terminal 200 columns wide: its screen is far wider than the column's 500 px.
        view.show({
          id: 'abababababab',
          slot: null,
          sessionId: null,
          state: 'running',
          notReported: false,
          cols: 200,
          rows: 24,
          ownsSize: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const attach = sent.find((message) => message['t'] === 'attach');
        return {
          proposed: attach === undefined ? null : { cols: attach['cols'], rows: attach['rows'] },
          fits: view.fits(500, 400),
          width: zone.getBoundingClientRect().width,
        };
      }, base);
      assert.deepEqual(result.proposed, result.fits, 'fitted to the column, not to the terminal');
      assert.equal(result.width, 500, 'the column stays as wide as the grid makes it');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a snap that has to wait behind output is taken whole, however large: no fresh snap asked for',
    async (t) => {
      const l = await launched(t, chromium);
      const base = await assetBase(l.page);
      const result = await l.page.evaluate(async (base) => {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(
            root: HTMLElement,
            deps: object,
          ): {
            show(term: object): void;
            snap(message: object): void;
            output(channel: number, bytes: Uint8Array): void;
          };
        };
        const sent: Record<string, unknown>[] = [];
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:0;top:0;width:733px;height:411px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: (message: Record<string, unknown>) => sent.push(message),
          chord: () => false,
          openLink: () => {},
        });
        const term = 'b1b1b1b1b1b1';
        view.show({
          id: term,
          slot: null,
          sessionId: null,
          state: 'running',
          notReported: false,
          cols: 80,
          rows: 24,
          ownsSize: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        view.snap({ t: 'snap', term, ch: 7, cols: 80, rows: 24, data: 'the first snap\r\n' });
        // 12 MB of coloured output: xterm.js is behind, and the next snap has to wait.
        const record = new TextEncoder().encode(`${'\x1b[32mx\x1b[0m'.repeat(6000)}\r\n`);
        for (let given = 0; given < 12_000_000; given += record.length) view.output(7, record);
        // A snap of 33,000,000 characters (a page that fell behind, a reconnect).
        const line = `${'y'.repeat(78)}\r\n`;
        const data = `${line.repeat(Math.ceil(33_000_000 / line.length))}the end of the big snap\r\n`;
        view.snap({ t: 'snap', term, ch: 8, cols: 80, rows: 24, data });
        const attaches = sent.filter((message) => message['t'] === 'attach').length;
        const rows = (): string => root.querySelector('.xterm-rows')?.textContent ?? '';
        const deadline = performance.now() + 90_000;
        while (!rows().includes('the end of the big snap') && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return {
          size: data.length,
          attaches,
          later: sent.filter((message) => message['t'] === 'attach').length,
          shown: rows().includes('the end of the big snap'),
        };
      }, base);
      assert.ok(result.size > 32_000_000);
      assert.equal(result.attaches, 1, 'only the attach of the show');
      assert.equal(result.later, 1, 'and none after');
      assert.equal(result.shown, true, 'the big snap is shown');
      assert.deepEqual(l.problems, [], 'nothing thrown');
    },
  );

  await t.test(
    'a dismissal is forgotten once a snapshot is followed by the stream without that notice: a gap that comes again after the next snap shows',
    async (t) => {
      const l = await launched(t, chromium);
      const base = await assetBase(l.page);
      const result = await l.page.evaluate(async (base) => {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(
            root: HTMLElement,
            deps: object,
          ): {
            show(term: object): void;
            snap(message: object): void;
            output(channel: number, bytes: Uint8Array): void;
            notice(term: string, kind: string, text: string): void;
          };
        };
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:0;top:0;width:733px;height:411px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: () => {},
          chord: () => false,
          openLink: () => {},
        });
        const term = 'c2c2c2c2c2c2';
        view.show({
          id: term,
          slot: null,
          sessionId: null,
          state: 'running',
          notReported: false,
          cols: 80,
          rows: 24,
          ownsSize: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
        const shown = (): string =>
          root.querySelector('.tv-bar[data-kind="gap"] .tv-bar-text')?.textContent ?? '';
        const snap = (ch: number): void => {
          view.snap({ t: 'snap', term, ch, cols: 80, rows: 24, data: 'a screen\r\n' });
        };
        snap(7);
        view.output(7, bytes('a record\r\n'));
        view.notice(term, 'gap', 'a gap');
        root.querySelector<HTMLButtonElement>('.tv-bar[data-kind="gap"] .tv-bar-close')?.click();
        // A snap whose repeat holds no gap, followed by the stream: the dismissal is forgotten.
        snap(8);
        view.output(8, bytes('a record\r\n'));
        // The next snap repeats a gap with the same text: a new one, shown.
        snap(9);
        view.notice(term, 'gap', 'a gap');
        return shown();
      }, base);
      assert.equal(result, 'a gap');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a write xterm.js refuses asks for one fresh snap; what comes until it is dropped, and the fresh snap and its stream show',
    async (t) => {
      const l = await launched(t, chromium);
      const base = await assetBase(l.page);
      const result = await l.page.evaluate(async (base) => {
        // The view's own xterm.js module (the same URL): its `write` throws once, for one record.
        const xterm = (await import(`${base}../vendor/xterm/xterm/lib/xterm.mjs`)) as {
          Terminal: { prototype: { write(data: string | Uint8Array, then?: () => void): void } };
        };
        const proto = xterm.Terminal.prototype;
        const write = proto.write;
        let thrown = 0;
        proto.write = function (data, then) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          if (thrown === 0 && text.includes('refused by xterm.js')) {
            thrown++;
            throw new Error('write data discarded, use flow control to avoid losing data');
          }
          write.call(this, data, then);
        };
        try {
          const module = (await import(`${base}terminal-view.js`)) as {
            createTerminalView(
              root: HTMLElement,
              deps: object,
            ): {
              show(term: object): void;
              snap(message: object): void;
              output(channel: number, bytes: Uint8Array): void;
            };
          };
          const sent: Record<string, unknown>[] = [];
          const root = document.createElement('div');
          root.className = 'terminal';
          root.style.cssText = 'position:fixed;left:0;top:0;width:733px;height:411px';
          document.body.append(root);
          const view = module.createTerminalView(root, {
            send: (message: Record<string, unknown>) => sent.push(message),
            chord: () => false,
            openLink: () => {},
          });
          const term = 'dddddddddddd';
          view.show({
            id: term,
            slot: null,
            sessionId: null,
            state: 'running',
            notReported: false,
            cols: 80,
            rows: 24,
            ownsSize: true,
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
          view.snap({ t: 'snap', term, ch: 7, cols: 80, rows: 24, data: 'the first snap\r\n' });
          view.output(7, bytes('a record before\r\n'));
          await new Promise((resolve) => setTimeout(resolve, 100));
          view.output(7, bytes('refused by xterm.js\r\n'));
          view.output(7, bytes('a record after it\r\n'));
          const attaches = sent.filter((message) => message['t'] === 'attach').length;
          view.snap({ t: 'snap', term, ch: 8, cols: 80, rows: 24, data: 'a fresh snap\r\n' });
          view.output(8, bytes('and the stream after it\r\n'));
          const rows = (): string => root.querySelector('.xterm-rows')?.textContent ?? '';
          const deadline = performance.now() + 20_000;
          while (!rows().includes('and the stream after it') && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return { thrown, attaches, rows: rows() };
        } finally {
          proto.write = write;
        }
      }, base);
      assert.equal(result.thrown, 1, 'xterm.js refused one write');
      assert.equal(result.attaches, 2, 'the attach of the show and one fresh snap asked for');
      assert.match(result.rows, /a fresh snap.*and the stream after it/s);
      assert.doesNotMatch(result.rows, /the first snap|a record after it/);
      assert.deepEqual(l.problems, [], 'nothing thrown');
    },
  );

  await t.test(
    'a dismissed gap is the text its bar showed: when a later gap replaced the first, the repeat of the later one after a snap stays hidden',
    async (t) => {
      const l = await launched(t, chromium);
      const base = await assetBase(l.page);
      const result = await l.page.evaluate(async (base) => {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(
            root: HTMLElement,
            deps: object,
          ): {
            show(term: object): void;
            snap(message: object): void;
            output(channel: number, bytes: Uint8Array): void;
            notice(term: string, kind: string, text: string): void;
          };
        };
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:0;top:0;width:733px;height:411px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: () => {},
          chord: () => false,
          openLink: () => {},
        });
        const term = 'cccccccccccc';
        view.show({
          id: term,
          slot: null,
          sessionId: null,
          state: 'running',
          notReported: false,
          cols: 80,
          rows: 24,
          ownsSize: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
        const shown = (): string =>
          root.querySelector('.tv-bar[data-kind="gap"] .tv-bar-text')?.textContent ?? '';
        view.snap({ t: 'snap', term, ch: 7, cols: 80, rows: 24, data: 'a screen\r\n' });
        view.output(7, bytes('a record\r\n'));
        view.notice(term, 'gap', 'the first gap');
        view.notice(term, 'gap', 'a later gap');
        const before = shown();
        root.querySelector<HTMLButtonElement>('.tv-bar[data-kind="gap"] .tv-bar-close')?.click();
        const dismissed = shown();
        // A snap, and the server's repeat of the gap it holds: the later one.
        view.snap({ t: 'snap', term, ch: 8, cols: 80, rows: 24, data: 'a screen\r\n' });
        view.notice(term, 'gap', 'a later gap');
        const repeated = shown();
        return { before, dismissed, repeated };
      }, base);
      assert.equal(result.before, 'a later gap', 'the bar shows the later gap');
      assert.equal(result.dismissed, '');
      assert.equal(result.repeated, '', 'its repeat stays hidden');
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
