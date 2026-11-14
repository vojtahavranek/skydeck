// The list (S2 12.1, 12.2 stage A, 12.9's list zone, 12.10; plan task 27): its sections, rows,
// footer, filter and keys, the title bar's counts, and clicks. Real test servers run on
// realTestPlatform with real keepers and the stand-in program (test/helpers/window.ts), with
// sessions made the way step 1 sees them (transcripts, the store's meta); a scripted stand-in
// server (helpers/shell.ts) sends rows a real server cannot make on demand.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import { markDone } from '../src/sessions/meta.ts';
import type { RowPayload, SectionPayload, TerminalPayload } from '../src/window/protocol.ts';
import { sleep, until } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  after,
  clickRow,
  connection,
  honest,
  launched,
  logOf,
  mark,
  PAGE_WAIT_MS,
  readPage,
  selectedRow,
  showsText,
  standinServer,
  storeKey,
  TERM_A,
  TERM_B,
  termOf,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { Standin } from './helpers/shell.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const DAY = 86_400n * SEC;

// ---------------------------------------------------------------------------------------------
// Sessions as step 1 sees them

/**
 * A session last active `agoNs` before now: a transcript with one user record at that time (as
 * `d.resumable` makes, with any time), and more records (a `custom-title`, say) when given.
 */
function session(
  d: ServerSandbox,
  sessionId: string,
  agoNs: bigint,
  more: Record<string, unknown>[] = [],
): void {
  const dir = join(d.s.home, 'project');
  mkdirSync(dir, { recursive: true });
  const folder = join(d.s.claudeHome, 'projects', 'project');
  mkdirSync(folder, { recursive: true });
  const timestamp = isoFromNs(d.platform.clock.nowNs() - agoNs);
  const lines = [
    { type: 'user', sessionId, timestamp, cwd: dir, entrypoint: 'cli' },
    ...more.map((record) => ({ sessionId, timestamp, ...record })),
  ];
  writeFileSync(
    join(folder, `${sessionId}.jsonl`),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
}

// ---------------------------------------------------------------------------------------------
// What the list shows

interface Drawn {
  id: string;
  section: string;
  slot: string;
  key: string;
  group: string;
  title: string;
  marks: string[];
  chip: string;
  chipTip: string;
  dotted: boolean;
  note: boolean;
  noteTip: string;
  age: string;
  state: string;
}

/** The rows the list draws, in order, each with the section it is under and its visible parts. */
async function drawn(page: Page): Promise<Drawn[]> {
  return readPage(
    page,
    () => {
      const shown = (element: Element | null): string =>
        element instanceof HTMLElement && element.checkVisibility()
          ? (element.textContent ?? '')
          : '';
      let section = '';
      const rows = [];
      for (const element of document.querySelectorAll('#list .list-section, #list .list-row')) {
        if (!(element instanceof HTMLElement) || !element.checkVisibility()) continue;
        if (element.classList.contains('list-section')) {
          section = element.dataset['section'] ?? '';
          continue;
        }
        const chip = element.querySelector('.row-chip');
        const note = element.querySelector('.row-note');
        rows.push({
          id: element.dataset['id'] ?? '',
          section,
          slot: shown(element.querySelector('.row-slot')),
          key: shown(element.querySelector('.row-key')),
          group: shown(element.querySelector('.row-group')),
          title: shown(element.querySelector('.row-title')),
          marks: [...element.querySelectorAll('.row-mark')]
            .map(shown)
            .filter((text) => text !== ''),
          chip: shown(chip),
          chipTip: chip instanceof HTMLElement ? chip.title : '',
          dotted: chip instanceof HTMLElement && chip.dataset['dotted'] === 'true',
          note: shown(note) !== '',
          noteTip: note instanceof HTMLElement ? note.title : '',
          age: shown(element.querySelector('.row-age')),
          state: shown(element.querySelector('.row-state')),
        });
      }
      return rows;
    },
    null,
  );
}

/** The ids of the rows drawn, in order. */
async function drawnIds(page: Page): Promise<string[]> {
  return (await drawn(page)).map((row) => row.id);
}

/** Waits until `check` holds for what the list draws; fails with what it drew. */
async function untilDrawn(
  page: Page,
  check: (rows: Drawn[]) => boolean,
  what: string,
): Promise<Drawn[]> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const rows = await drawn(page);
    if (check(rows)) return rows;
    if (performance.now() > deadline) {
      assert.fail(`${what}: the list draws ${JSON.stringify(rows, null, 1)}`);
    }
    await sleep(50);
  }
}

/** The headers drawn: `<section> <title> <count>[ <span>]`. */
async function headers(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#list .list-section')]
        .filter((element) => element instanceof HTMLElement && element.checkVisibility())
        .map((element) =>
          [
            (element as HTMLElement).dataset['section'],
            ...[...element.querySelectorAll('.section-title, .section-count, .section-span')]
              .filter((part) => part instanceof HTMLElement && part.checkVisibility())
              .map((part) => part.textContent),
          ].join(' '),
        ),
    null,
  );
}

/** What the page sent after the mark `name`: the types of its messages, pings left out. */
async function sentAfter(page: Page, name: string): Promise<string[]> {
  return after(await logOf(page), name)
    .filter((entry) => entry.e === 'out')
    .map((entry) => entry.t ?? '');
}

// ---------------------------------------------------------------------------------------------
// A scripted stand-in server

const NOW = 1_794_474_000_000_000_000n;
const ago = (ns: bigint): string => String(NOW - ns);

/** A full row of S2 8.2.3 (the shell's scriptedList makes only the fields it needs). */
function fullRow(id: string, over: Partial<RowPayload> = {}): RowPayload {
  return {
    id,
    shortId: id.slice(0, 8),
    title: `session ${id.slice(0, 8)}`,
    titleSource: 'generated',
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: ago(2n * DAY),
    lastActivityNs: ago(2n * DAY),
    dir: '/home/u/project',
    marks: [],
    hasNote: false,
    noteHead: [],
    done: false,
    prs: [],
    chip: null,
    terminal: null,
    slot: null,
    elsewhere: null,
    starting: false,
    attention: null,
    stack: null,
    ...over,
  };
}

function fullTerminal(id: string, over: Partial<TerminalPayload> = {}): TerminalPayload {
  return {
    id,
    slot: 1,
    sessionId: null,
    state: 'running',
    notReported: false,
    cols: 80,
    rows: 24,
    ownsSize: true,
    ...over,
  };
}

/** A `list` with sections Open, This week and Earlier holding these rows. */
function fullList(
  sections: { open?: RowPayload[]; week?: RowPayload[]; earlier?: RowPayload[] | 'folded' },
  terminals: TerminalPayload[] = [],
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  const section = (name: SectionPayload['name'], rows: RowPayload[]): SectionPayload => ({
    name,
    folded: false,
    firstNs: null,
    lastNs: null,
    count: rows.length,
    rows,
  });
  const earlier: SectionPayload =
    sections.earlier === 'folded'
      ? {
          name: 'earlier',
          folded: true,
          firstNs: ago(30n * DAY),
          lastNs: ago(9n * DAY),
          count: 4,
          rows: [],
        }
      : section('earlier', sections.earlier ?? []);
  return {
    t: 'list',
    nowNs: String(NOW),
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    sections: [section('open', sections.open ?? []), section('week', sections.week ?? []), earlier],
    doneHidden: 0,
    banner: null,
    terminals,
    selected: null,
    dirs: [],
    ...more,
  };
}

interface Scripted {
  page: Page;
  standin: Standin;
  /** Every message the page sent after `start`, but pings. */
  sent: Record<string, unknown>[];
  /** Sends a list on the open connection. */
  send(list: Record<string, unknown>): void;
}

/**
 * A page connected to a stand-in server that answers every `view` with `answer(view)` (the page's
 * stored key, as a window that was launched before), and answers attach with an empty snap.
 */
async function scripted(
  t: TestContext,
  chromium: Browser,
  answer: (view: Record<string, unknown>) => Record<string, unknown>,
  fill: number,
): Promise<Scripted> {
  const secret = new Uint8Array(32).fill(fill);
  const page = await newPage(t, chromium);
  await page.addInitScript(() => {
    // The page's own console errors and uncaught errors, for the test to assert on.
    Reflect.set(globalThis, 'pageErrors', []);
    addEventListener('error', (event) =>
      (Reflect.get(globalThis, 'pageErrors') as string[]).push(String(event.message)),
    );
  });
  const sent: Record<string, unknown>[] = [];
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        sent.push(message);
        if (message['t'] === 'view') conn.send(answer(message));
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
  return {
    page,
    standin,
    sent,
    send: (list) => standin.connections.at(-1)?.send(list),
  };
}

test('the list', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'sections and their order as the server sent them; Earlier folded with its count and span, ← and → fold and unfold it; a hostile title appears as text',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const hostile = '<img src=x onerror="window.pwned=1">';
      session(d, S1, 2n * MIN, [{ type: 'custom-title', customTitle: hostile }]);
      session(d, S2, 2n * DAY);
      session(d, S3, 20n * DAY);
      session(d, S4, 30n * DAY);

      // This week most recent first; Earlier folded: its header only, with its count and span.
      await untilDrawn(page, (rows) => rows.length === 2, 'two rows of This week');
      assert.deepEqual(await drawnIds(page), [S1, S2]);
      assert.deepEqual(
        (await drawn(page)).map((row) => row.section),
        ['week', 'week'],
      );
      assert.deepEqual(await headers(page), [
        'open Open 0',
        'week This week 2',
        'earlier Earlier 2 20d–30d ago',
      ]);
      const [first] = await drawn(page);
      assert.equal(first?.title, hostile);
      assert.equal(await page.locator('#list img').count(), 0, 'no element made from the title');
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, 'pwned')), undefined);

      // → unfolds Earlier (a view round trip), ← folds it again.
      await toZone(page, 'list');
      await mark(page, 'unfold');
      await page.keyboard.press('ArrowRight');
      await untilDrawn(page, (rows) => rows.length === 4, 'Earlier unfolded');
      assert.deepEqual(await drawnIds(page), [S1, S2, S3, S4]);
      assert.deepEqual(
        (await drawn(page)).map((row) => row.section),
        ['week', 'week', 'earlier', 'earlier'],
      );
      assert.deepEqual(await headers(page), [
        'open Open 0',
        'week This week 2',
        'earlier Earlier 2',
      ]);
      assert.ok((await sentAfter(page, 'unfold')).includes('view'));

      // ← with the selection in Earlier: the selection moves to the row above it, then it folds.
      await clickRow(page, S4);
      await page.keyboard.press('ArrowLeft');
      await untilDrawn(page, (rows) => rows.length === 2, 'Earlier folded again');
      assert.equal(await selectedRow(page), S2);
      assert.deepEqual(await headers(page), [
        'open Open 0',
        'week This week 2',
        'earlier Earlier 2 20d–30d ago',
      ]);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'done sessions: hidden with the footer "1 done hidden · show"; `a` and the footer show them with the mark `done`, and hide them again',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN);
      session(d, S2, 3n * MIN);
      markDone(d.deck, S2);

      await untilDrawn(page, (rows) => rows.length === 1, 'the done session hidden');
      assert.deepEqual(await drawnIds(page), [S1]);
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);

      await toZone(page, 'list');
      await page.keyboard.press('a');
      const rows = await untilDrawn(page, (rows) => rows.length === 2, 'done shown');
      assert.deepEqual(
        rows.map((row) => [row.id, row.marks]),
        [
          [S1, []],
          [S2, ['done']],
        ],
      );
      await showsText(page, '#list .list-footer', /^done sessions shown · hide$/);
      await page.keyboard.press('a');
      await untilDrawn(page, (rows) => rows.length === 1, 'done hidden by `a`');

      // The footer's own "show" and "hide", each with one click; the list keeps the keyboard.
      await page.locator('#list .footer-action').click();
      await untilDrawn(page, (rows) => rows.length === 2, 'done shown by the footer');
      await page.locator('#list .footer-action', { hasText: 'hide' }).click();
      await untilDrawn(page, (rows) => rows.length === 1, 'done hidden by the footer');
      assert.equal(await active(page), '#list');
      assert.equal(await zone(page), 'Focus: list');
    },
  );

  await t.test(
    '`/` filters: the field takes the keyboard and what is typed there is only text (no list key, no resume); Enter gives the keyboard back to the list; Esc clears the filter, the next Esc goes back to the terminal; Esc in the field always ends the entry',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, [{ type: 'custom-title', customTitle: 'alpha work' }]);
      session(d, S2, 3n * MIN, [{ type: 'custom-title', customTitle: 'beta work' }]);
      session(d, S3, 20n * DAY, [{ type: 'custom-title', customTitle: 'beta old' }]);
      session(d, S4, 4n * MIN, [{ type: 'custom-title', customTitle: 'beta done' }]);
      markDone(d.deck, S4);
      await untilDrawn(page, (rows) => rows.length === 2, 'This week');
      const inField = (): Promise<boolean> =>
        page.evaluate(() => document.activeElement?.classList.contains('list-filter') === true);
      const inRight = (): Promise<boolean> =>
        page.evaluate(
          () => document.getElementById('right-zone')?.contains(document.activeElement) === true,
        );

      await toZone(page, 'list');
      await page.keyboard.press('/');
      assert.equal(await inField(), true, 'the filter field has the keyboard');
      assert.equal(await page.inputValue('#list .list-filter'), '', '`/` is not typed');
      // `a` (show done) and `j` (move) typed here are letters of the filter, nothing else.
      await page.keyboard.type('betaj');
      await page.keyboard.press('Backspace');
      // A filter unfolds every section (S2 12.8): the match in Earlier is shown; the done one is
      // counted in the footer, not shown.
      await untilDrawn(
        page,
        (rows) => rows.map((row) => row.id).join() === [S2, S3].join(),
        'the rows that match',
      );
      assert.equal(await page.inputValue('#list .list-filter'), 'beta');
      assert.equal(await inField(), true);
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      // No move: the selection (S1) is filtered out, and no row that is drawn got it.
      assert.equal(await selectedRow(page), null);

      // Enter in the field resumes nothing: the keyboard goes back to the list, the filter stays.
      await page.keyboard.press('Enter');
      assert.equal(await active(page), '#list');
      assert.equal(await page.inputValue('#list .list-filter'), 'beta', 'the filter stays');
      await sleep(500);
      assert.deepEqual(l.server.hub.list(), [], 'nothing resumed');
      // On the list the letters are list keys again.
      await page.keyboard.press('j');
      await page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
        { timeout: PAGE_WAIT_MS },
      );
      assert.equal(await page.inputValue('#list .list-filter'), 'beta');

      // S2 12.9: Esc clears the filter (the keyboard stays on the list), then goes back to the
      // terminal.
      await page.keyboard.press('Escape');
      await untilDrawn(page, (rows) => rows.length === 2, 'the filter cleared');
      assert.equal(await page.inputValue('#list .list-filter'), '');
      assert.equal(await zone(page), 'Focus: list');
      assert.equal(await active(page), '#list');
      await page.keyboard.press('Escape');
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
      assert.equal(await inRight(), true, 'the keyboard is in the terminal zone');

      // Esc in the field itself, with text in it: the same first step — cleared, the keyboard
      // on the list.
      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('alpha');
      await untilDrawn(page, (rows) => rows.length === 1, 'alpha');
      await page.keyboard.press('Escape');
      await untilDrawn(page, (rows) => rows.length === 2, 'cleared from the field');
      assert.equal(await page.inputValue('#list .list-filter'), '');
      assert.equal(await active(page), '#list');
      assert.equal(await zone(page), 'Focus: list');
      await page.keyboard.press('Escape');
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
      assert.equal(await inRight(), true);

      // Esc in the EMPTY field ends the entry too (ruled, plan task 27): the keyboard on the
      // list, and the next Esc goes back to the terminal — two Escs from an empty field.
      await toZone(page, 'list');
      await page.keyboard.press('/');
      assert.equal(await inField(), true);
      await page.keyboard.press('Escape');
      assert.equal(await active(page), '#list');
      assert.equal(await zone(page), 'Focus: list');
      await page.keyboard.press('Escape');
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
      assert.equal(await inRight(), true);
      assert.deepEqual(l.server.hub.list(), [], 'nothing resumed');
    },
  );

  await t.test(
    '↑ ↓ j k Home End move the selection, and each move sends `view` and `focus`',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN);
      session(d, S2, 2n * MIN);
      session(d, S3, 3n * MIN);
      await untilDrawn(page, (rows) => rows.length === 3, 'three rows');
      await toZone(page, 'list');
      assert.equal(await selectedRow(page), S1, 'the first row is selected by itself');

      const moves: [string, string][] = [
        ['ArrowDown', S2],
        ['j', S3],
        ['j', S3], // the last row stays
        ['ArrowUp', S2],
        ['k', S1],
        ['End', S3],
        ['Home', S1],
      ];
      for (const [key, expected] of moves) {
        const selectedBefore = await selectedRow(page);
        await mark(page, key + expected);
        await page.keyboard.press(key);
        await page.waitForFunction(
          (id) =>
            document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
          expected,
          { timeout: PAGE_WAIT_MS },
        );
        if (selectedBefore !== expected) {
          const deadline = performance.now() + PAGE_WAIT_MS;
          let types = await sentAfter(page, key + expected);
          while (!(types.includes('view') && types.includes('focus'))) {
            assert.ok(performance.now() < deadline, `${key}: ${types.join(', ')}`);
            await sleep(50);
            types = await sentAfter(page, key + expected);
          }
        }
        assert.equal(await zone(page), 'Focus: list', `${key} keeps the list`);
      }
    },
  );

  await t.test(
    'Enter on a row that is not running resumes it: its terminal in slot 1, the row under Open with two lines, the title bar counts it',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN);
      session(d, S2, 3n * MIN);
      await untilDrawn(page, (rows) => rows.length === 2, 'two rows');
      await showsText(page, '#counts', /^2 not running$/);

      await clickRow(page, S2);
      await showsText(page, '#focus-zone', /^Focus: list$/);
      await page.keyboard.press('Enter');
      const rows = await untilDrawn(
        page,
        (rows) => rows[0]?.id === S2 && rows[0].section === 'open' && rows[0].slot === '1',
        'the resumed session under Open in slot 1',
      );
      assert.notEqual(rows[0]?.state, '', 'a second line');
      assert.equal(rows[0]?.age, '', 'no age on its first line');
      termOf(l, S2);
      await showsText(page, '#counts', /^1 (starting|running|working|waiting) · 1 not running$/);
    },
  );

  await t.test(
    'every part of a row: slot, ticket key, group, marks in words, the chip (dotted when unreadable) with its tooltip, ✎ with the note line, the age; the state lines of stage A; the counts',
    async (t) => {
      const note = ['\x1b[31mcall\x1b[0m Bob first', 'then the rest'];
      const list = fullList(
        {
          open: [
            fullRow(S1, {
              title: 'ORB-2107: fix the login',
              group: 'ORB-2107',
              groupSource: 'title',
              state: 'working',
              sinceNs: ago(4n * MIN),
              terminal: TERM_A,
              slot: 1,
            }),
            fullRow(S2, {
              title: 'new session in /home/u/project',
              titleSource: 'fallback',
              starting: true,
              terminal: TERM_B,
              slot: 2,
            }),
            fullRow(S3, {
              state: 'waiting',
              stateDetail: 'permission',
              sinceNs: ago(3n * MIN),
              elsewhere: { pid: 4242, tty: '/dev/pts/3', dir: '/home/u/project' },
            }),
          ],
          week: [
            fullRow(S4, {
              title: 'tidy the logs',
              group: 'infra',
              groupSource: 'meta',
              lastActivityNs: ago(3n * DAY),
              marks: ['ended-unexpectedly', 'was-working', 'expiring'],
              hasNote: true,
              noteHead: note,
              prs: [
                {
                  url: 'https://github.com/o/r/pull/7',
                  repo: 'o/r',
                  number: 7,
                  title: null,
                  level: 'cant-read',
                  error: 'gh: HTTP 502',
                },
                {
                  url: 'https://github.com/o/r/pull/8',
                  repo: 'o/r',
                  number: 8,
                  title: null,
                  level: 'merged',
                  error: null,
                },
              ],
              chip: { level: 'cant-read', count: 2 },
            }),
          ],
        },
        [
          fullTerminal(TERM_A, { slot: 1, sessionId: S1 }),
          fullTerminal(TERM_B, { slot: 2, sessionId: null, state: 'starting' }),
        ],
        {
          counts: { working: 1, waiting: 0, running: 0, starting: 1, elsewhere: 1, notRunning: 1 },
        },
      );
      const s = await scripted(t, chromium, () => list, 31);
      const rows = await untilDrawn(s.page, (rows) => rows.length === 4, 'four rows');
      const pick = (row: Drawn | undefined): Partial<Drawn> =>
        row === undefined
          ? {}
          : {
              slot: row.slot,
              key: row.key,
              group: row.group,
              title: row.title,
              marks: row.marks,
              chip: row.chip,
              age: row.age,
              state: row.state,
            };
      assert.deepEqual(pick(rows[0]), {
        slot: '1',
        key: 'ORB-2107',
        group: '',
        title: 'fix the login',
        marks: [],
        chip: '',
        age: '',
        state: 'working 4m',
      });
      assert.deepEqual(pick(rows[1]), {
        slot: '2',
        key: '',
        group: '',
        title: 'new session in /home/u/project',
        marks: [],
        chip: '',
        age: '',
        state: 'starting…',
      });
      assert.equal(rows[2]?.state, 'running in another terminal');
      assert.equal(rows[2]?.slot, '');
      assert.deepEqual(pick(rows[3]), {
        slot: '',
        key: '',
        group: 'infra',
        title: 'tidy the logs',
        marks: ['crashed mid-turn', 'expires soon'],
        chip: "2 PRs · can't read",
        age: '3d',
        state: '',
      });
      assert.equal(rows[3]?.dotted, true);
      assert.equal(rows[3]?.chipTip, "o/r #7 · can't read · gh: HTTP 502\no/r #8 · merged");
      assert.equal(rows[3]?.note, true);
      assert.equal(rows[3]?.noteTip, 'call Bob first', "the note's first line, sanitised");
      await showsText(
        s.page,
        '#counts',
        /^1 working · 1 starting · 1 in another terminal · 1 not running$/,
      );

      // S2 7.5: a starting terminal that is not reported says so on its row.
      s.send({
        ...list,
        terminals: [
          fullTerminal(TERM_A, { slot: 1, sessionId: S1 }),
          fullTerminal(TERM_B, { slot: 2, sessionId: null, notReported: true }),
        ],
      });
      await untilDrawn(
        s.page,
        (rows) => rows[1]?.state === 'started, not reported',
        'started, not reported',
      );
      assert.deepEqual(await s.page.evaluate(() => Reflect.get(globalThis, 'pageErrors')), []);
    },
  );

  await t.test(
    'one click selects, from either zone: a row with a terminal focuses the terminal, another the list; a double click resumes a row that is not running',
    async (t) => {
      const list = fullList(
        {
          open: [fullRow(S1, { state: 'running', sinceNs: ago(MIN), terminal: TERM_A, slot: 1 })],
          week: [fullRow(S2), fullRow(S3)],
        },
        [fullTerminal(TERM_A, { slot: 1, sessionId: S1 })],
      );
      const s = await scripted(t, chromium, () => list, 32);
      await untilDrawn(s.page, (rows) => rows.length === 3, 'three rows');
      assert.equal(await zone(s.page), 'Focus: terminal');

      await s.page.locator(`#list [data-id="${S2}"] .row-title`).click(); // once, from the terminal zone
      assert.equal(await selectedRow(s.page), S2);
      await showsText(s.page, '#focus-zone', /^Focus: list$/);
      assert.equal(await active(s.page), '#list');

      await s.page.locator(`#list [data-id="${S1}"] .row-title`).click(); // once, from the list zone
      assert.equal(await selectedRow(s.page), S1);
      await showsText(s.page, '#focus-zone', /^Focus: terminal$/);

      const before = s.sent.length;
      await s.page.locator(`#list [data-id="${S3}"]`).dblclick();
      await until(
        () => s.sent.slice(before).some((message) => message['t'] === 'act'),
        'an act',
        PAGE_WAIT_MS,
      );
      assert.deepEqual(
        s.sent
          .slice(before)
          .filter((message) => message['t'] === 'act')
          .map((message) => [message['kind'], message['sessionId']]),
        [['resume', S3]],
      );
      assert.equal(
        await s.page.evaluate(() => getSelection()?.toString() ?? ''),
        '',
        'a double click selects no text of the row',
      );
    },
  );

  await t.test(
    'a list that changes a row between the mousedown and the mouseup on its title loses no click',
    async (t) => {
      const quiet = fullList({ week: [fullRow(S1), fullRow(S2, { title: 'the second' })] });
      const s = await scripted(t, chromium, () => quiet, 33);
      await untilDrawn(s.page, (rows) => rows.length === 2, 'two rows');
      await toZone(s.page, 'list');
      const title = s.page.locator(`#list [data-id="${S2}"] .row-title`);
      const box = await title.boundingBox();
      assert.ok(box !== null);

      await s.page.mouse.move(box.x + 4, box.y + box.height / 2);
      await s.page.mouse.down();
      // The row gets marks, a chip, a note and another title while the button is down.
      s.send(
        fullList({
          week: [
            fullRow(S1),
            fullRow(S2, {
              title: 'the second, changed',
              marks: ['ended-unexpectedly'],
              hasNote: true,
              noteHead: ['n'],
              chip: { level: 'draft', count: 1 },
            }),
          ],
        }),
      );
      await untilDrawn(s.page, (rows) => rows[1]?.title === 'the second, changed', 'the change');
      await s.page.mouse.up();
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
        { timeout: 5000 },
      );
    },
  );

  await t.test(
    "ages move on between lists (A18): the page counts from the list's time",
    async (t) => {
      // A row 55 s in its state when the list was made: it says "5<n>s", then "1m" with no new list.
      const list = fullList(
        { open: [fullRow(S1, { state: 'working', sinceNs: String(NOW - 55n * SEC) })] },
        [],
      );
      const s = await scripted(t, chromium, () => list, 34);
      await untilDrawn(s.page, (rows) => /^working 5\ds$/.test(rows[0]?.state ?? ''), 'seconds');
      const views = s.sent.filter((message) => message['t'] === 'view').length;
      await untilDrawn(s.page, (rows) => rows[0]?.state === 'working 1m', 'a minute');
      assert.equal(
        s.sent.filter((message) => message['t'] === 'view').length,
        views,
        'no new view, so no new list',
      );
    },
  );

  await t.test(
    'PgDn and PgUp move by a page, and the selected row is scrolled into view',
    async (t) => {
      const ids = Array.from(
        { length: 60 },
        (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      );
      const list = fullList({
        week: ids.map((id, i) => fullRow(id, { lastActivityNs: ago(BigInt(i + 1) * MIN) })),
      });
      const s = await scripted(t, chromium, () => list, 35);
      await untilDrawn(s.page, (rows) => rows.length === 60, 'sixty rows');
      await toZone(s.page, 'list');
      await s.page.keyboard.press('Home');
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        ids[0],
      );
      await s.page.keyboard.press('PageDown');
      await sleep(300);
      const down = ids.indexOf((await selectedRow(s.page)) ?? '');
      assert.ok(down > 3 && down < 59, `PageDown moved to row ${down}`);
      const inView = await s.page.evaluate(() => {
        const row = document.querySelector('#list [data-selected="true"]');
        const body = document.querySelector('#list .list-body');
        if (row === null || body === null) return false;
        const r = row.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      });
      assert.ok(inView, 'the selected row is in view');
      await s.page.keyboard.press('PageUp');
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        ids[0],
      );
    },
  );

  await t.test(
    'a filter that matches nothing says so; a folded Earlier is unfolded with a click on its header',
    async (t) => {
      let unfolded = false;
      const s = await scripted(
        t,
        chromium,
        (view) => {
          if (typeof view['filter'] === 'string' && view['filter'] !== '') {
            return fullList({});
          }
          unfolded = Array.isArray(view['unfolded']) && view['unfolded'].includes('earlier');
          return fullList({
            week: [fullRow(S1)],
            earlier: unfolded ? [fullRow(S2, { lastActivityNs: ago(9n * DAY) })] : 'folded',
          });
        },
        36,
      );
      await untilDrawn(s.page, (rows) => rows.length === 1, 'one row');
      assert.deepEqual(await headers(s.page), [
        'open Open 0',
        'week This week 1',
        'earlier Earlier 4 9d–30d ago',
      ]);
      await s.page.locator('#list .list-section[data-section="earlier"]').click();
      await untilDrawn(s.page, (rows) => rows.length === 2, 'Earlier unfolded by a click');
      await s.page.locator('#list .list-section[data-section="earlier"]').click();
      await untilDrawn(s.page, (rows) => rows.length === 1, 'folded again by a click');

      await toZone(s.page, 'list');
      await s.page.keyboard.press('/');
      await s.page.keyboard.type('nothing');
      await showsText(s.page, '#list .list-empty', /^No session matches the filter\.$/);
      assert.deepEqual(await drawnIds(s.page), []);
    },
  );
});
