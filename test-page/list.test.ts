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
const HOUR = 60n * MIN;
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

/**
 * The tooltips the headers carry (F5): `<section> <class of the element>: <its tooltip>` for the
 * header and every element in it whose `title` is not empty, so that a header with none adds
 * nothing and a tooltip on the wrong element shows.
 */
async function headerTips(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#list .list-section')].flatMap((header) =>
        [header, ...header.querySelectorAll('*')]
          .filter((part) => part instanceof HTMLElement && part.title !== '')
          .map(
            (part) =>
              `${(header as HTMLElement).dataset['section']} ${(part as HTMLElement).className}: ${(part as HTMLElement).title}`,
          ),
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

/**
 * The page of a real server with the real web/ reports no problem — no console error, nothing
 * uncaught, no failed load (notes, shell-pinned #66: nothing else catches a real module that
 * does) —, and the list keeps the hooks the shared helpers rely on: exactly one element per
 * session id carries `data-id` (only the rows do), and `data-selected="true"` is on one row at
 * most.
 */
async function healthy(page: Page, problems: readonly string[]): Promise<void> {
  assert.deepEqual(problems, [], 'the page reports no problem');
  const hooks = await readPage(
    page,
    () => ({
      ids: [...document.querySelectorAll('#list [data-id]')].map((e) => e.getAttribute('data-id')),
      rows: document.querySelectorAll('#list .list-row').length,
      selected: document.querySelectorAll('#list [data-selected="true"]').length,
    }),
    null,
  );
  assert.equal(new Set(hooks.ids).size, hooks.ids.length, 'one element per session id');
  assert.equal(hooks.ids.length, hooks.rows, 'only the rows carry data-id');
  assert.ok(hooks.selected <= 1, 'data-selected on one row at most');
}

/**
 * Whether the selected row can be seen whole: inside the list's body, below the pinned section
 * header, and the element at its centre is the row itself (nothing drawn over it).
 */
async function selectedInView(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const row = document.querySelector('#list [data-selected="true"]');
      const body = document.querySelector('#list .list-body');
      if (!(row instanceof HTMLElement) || body === null) return 'no selected row';
      const r = row.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      const header = [...document.querySelectorAll('#list .list-section')]
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.top <= b.top + 1 && box.bottom > b.top)
        .at(0);
      const top = Math.max(b.top, header?.bottom ?? b.top);
      const atCentre = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (r.top < top - 1 || r.bottom > b.bottom + 1) {
        return `row ${r.top}–${r.bottom}, visible ${top}–${b.bottom}`;
      }
      return atCentre !== null && row.contains(atCentre)
        ? 'in view'
        : `covered by ${atCentre?.className ?? 'nothing'}`;
    },
    null,
  );
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
    openedNs: ago(HOUR),
    ...over,
  };
}

/** A fetched pull request `o/r #<number>` of `level`, last read 4 minutes ago. */
function fullPr(
  number: number,
  level: string,
  over: Partial<RowPayload['prs'][number]> = {},
): RowPayload['prs'][number] {
  return {
    url: `https://github.com/o/r/pull/${number}`,
    repo: 'o/r',
    number,
    title: null,
    level,
    error: null,
    okAtNs: ago(4n * MIN),
    ...over,
  };
}

/** A `list` with sections Open, Recent and Earlier holding these rows. */
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

      // Recent, the most recent first; Earlier folded: its header only, with its count and span.
      await untilDrawn(page, (rows) => rows.length === 2, 'two rows of Recent');
      await healthy(page, l.problems);
      assert.deepEqual(await drawnIds(page), [S1, S2]);
      assert.deepEqual(
        (await drawn(page)).map((row) => row.section),
        ['week', 'week'],
      );
      assert.deepEqual(await headers(page), [
        'open Open 0',
        'week Recent 2',
        'earlier Earlier 2 20d–30d ago',
      ]);
      // F5: the key `week` reaches the page (`data-section` above) and its header is titled
      // Recent, with the exact meaning one hover away; the other two headers carry no tooltip.
      assert.deepEqual(await headerTips(page), [
        'week section-title: last active in the last 7 days',
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
      assert.deepEqual(await headers(page), ['open Open 0', 'week Recent 2', 'earlier Earlier 2']);
      assert.deepEqual(await headerTips(page), [
        'week section-title: last active in the last 7 days',
      ]);
      assert.ok((await sentAfter(page, 'unfold')).includes('view'));

      // ← with the selection in Earlier: the selection moves to the row above it, then it folds.
      await clickRow(page, S4);
      await page.keyboard.press('ArrowLeft');
      await untilDrawn(page, (rows) => rows.length === 2, 'Earlier folded again');
      assert.equal(await selectedRow(page), S2);
      assert.deepEqual(await headers(page), [
        'open Open 0',
        'week Recent 2',
        'earlier Earlier 2 20d–30d ago',
      ]);
      await healthy(page, l.problems);
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
      await healthy(page, l.problems);
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
      await healthy(page, l.problems);
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
      await untilDrawn(page, (rows) => rows.length === 2, 'Recent');
      await healthy(page, l.problems);
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
      // A filter unfolds every section and lists the done sessions it matches (S2 12.8): the match
      // in Earlier is shown, and the done one with its mark `done`; no footer.
      const matched = await untilDrawn(
        page,
        (rows) => rows.map((row) => row.id).join() === [S2, S4, S3].join(),
        'the rows that match',
      );
      assert.deepEqual(
        matched.map((row) => [row.id, row.marks.includes('done')]),
        [
          [S2, false],
          [S4, true],
          [S3, false],
        ],
      );
      assert.equal(await page.inputValue('#list .list-filter'), 'beta');
      assert.equal(await inField(), true);
      await showsText(page, '#list .list-footer', /^$/);
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
      await healthy(page, l.problems);
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
      await healthy(page, l.problems);
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
      await healthy(page, l.problems);
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
      await healthy(page, l.problems);
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
      await healthy(page, l.problems);
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
                fullPr(7, 'cant-read', { error: 'gh: HTTP 502', okAtNs: ago(3n * HOUR) }),
                fullPr(8, 'merged'),
              ],
              chip: { level: 'cant-read', open: 1, merged: 1 },
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
        chip: "PR · can't read +1",
        age: '3d',
        state: '',
      });
      assert.equal(rows[3]?.dotted, true);
      assert.equal(
        rows[3]?.chipTip,
        "o/r #7 · can't read · last read 3h ago · gh: HTTP 502\n1 merged",
      );
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
    'a double click whose two clicks land on different rows (a list moved the rows between them) resumes nothing: it is two single clicks',
    async (t) => {
      const week = [fullRow(S2), fullRow(S3)];
      let current = fullList({ week });
      const s = await scripted(t, chromium, () => current, 40);
      await untilDrawn(s.page, (rows) => rows.length === 2, 'two rows');
      const box = await s.page.locator(`#list [data-id="${S3}"]`).boundingBox();
      assert.ok(box !== null);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      await s.page.mouse.click(x, y); // the first click, on S3
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S3,
      );
      await sleep(300); // its view's list has landed
      // A newer session joins Recent at its top: every row below moves down one place, and
      // S2 (not running) is now under the pointer.
      current = fullList({ week: [fullRow(S4, { lastActivityNs: ago(SEC) }), ...week] });
      s.send(current);
      await untilDrawn(s.page, (rows) => rows.length === 3, 'a row joined');
      const under = await s.page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('[data-id]')?.getAttribute('data-id'),
        { x, y },
      );
      assert.equal(under, S2, 'another row is under the pointer now');
      const before = s.sent.length;
      // The second click of a double click, alone: Chromium makes it a dblclick by its count.
      await s.page.mouse.down({ clickCount: 2 });
      await s.page.mouse.up({ clickCount: 2 });
      await sleep(500);
      assert.deepEqual(
        s.sent.slice(before).filter((message) => message['t'] === 'act'),
        [],
        'no resume',
      );
      assert.equal(await selectedRow(s.page), S2, 'the second click selected the row it landed on');
    },
  );

  await t.test(
    'a double click begun off a row forgets an earlier click on a row: first click on blank space or on the Earlier header, a list moves that row under the pointer, the second click resumes nothing',
    async (t) => {
      const press2 = async (page: Page): Promise<void> => {
        // The second click of a double click, alone: Chromium makes it a dblclick by its count.
        await page.mouse.down({ clickCount: 2 });
        await page.mouse.up({ clickCount: 2 });
      };
      const underPointer = (page: Page, x: number, y: number): Promise<string | null> =>
        page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest('[data-id]')?.getAttribute('data-id') ?? null,
          { x, y },
        );

      // Blank space under the last row.
      const week = [fullRow(S1), fullRow(S2), fullRow(S3)];
      let current = fullList({ week });
      const s = await scripted(t, chromium, () => current, 42);
      await untilDrawn(s.page, (rows) => rows.length === 3, 'three rows');
      await s.page.locator(`#list [data-id="${S3}"]`).click(); // an earlier single click on S3
      await sleep(300);
      const box = await s.page.locator(`#list [data-id="${S3}"]`).boundingBox();
      assert.ok(box !== null);
      const x = box.x + box.width / 2;
      const y = box.y + box.height + 12;
      assert.equal(await underPointer(s.page, x, y), null, 'blank space below S3');
      await s.page.mouse.click(x, y); // the first click of a double click, off any row
      current = fullList({ week: [fullRow(S4, { lastActivityNs: ago(SEC) }), ...week] });
      s.send(current);
      await untilDrawn(s.page, (rows) => rows.length === 4, 'a row joined');
      assert.equal(await underPointer(s.page, x, y), S3, 'S3 moved under the pointer');
      let before = s.sent.length;
      await press2(s.page);
      await sleep(500);
      assert.deepEqual(
        s.sent.slice(before).filter((message) => message['t'] === 'act'),
        [],
        'no resume after a first click on blank space',
      );

      // The Earlier header: its first click unfolds Earlier, the list that answers moves the row
      // clicked before under the pointer.
      const t2 = await scripted(
        t,
        chromium,
        (view) =>
          Array.isArray(view['unfolded']) && view['unfolded'].includes('earlier')
            ? fullList({
                week: [fullRow(S4, { lastActivityNs: ago(SEC) }), fullRow(S1), fullRow(S2)],
                earlier: [fullRow(S3, { lastActivityNs: ago(9n * DAY) })],
              })
            : fullList({ week: [fullRow(S1), fullRow(S2)], earlier: 'folded' }),
        43,
      );
      await untilDrawn(t2.page, (rows) => rows.length === 2, 'two rows, Earlier folded');
      await t2.page.locator(`#list [data-id="${S2}"]`).click(); // an earlier single click on S2
      await sleep(300);
      const header = await t2.page
        .locator('#list .list-section[data-section="earlier"]')
        .boundingBox();
      assert.ok(header !== null);
      const hx = header.x + header.width / 2;
      const hy = header.y + header.height / 2;
      await t2.page.mouse.click(hx, hy); // the first click, on the header: Earlier unfolds
      await untilDrawn(t2.page, (rows) => rows.length === 4, 'Earlier unfolded, a row joined');
      assert.equal(await underPointer(t2.page, hx, hy), S2, 'S2 moved under the pointer');
      before = t2.sent.length;
      await press2(t2.page);
      await sleep(500);
      assert.deepEqual(
        t2.sent.slice(before).filter((message) => message['t'] === 'act'),
        [],
        'no resume after a first click on the header',
      );
    },
  );

  await t.test(
    'a held Enter (auto-repeat) resumes nothing more: from the filter field nothing, on the list once; the next press acts again',
    async (t) => {
      const list = fullList({ week: [fullRow(S1), fullRow(S2)] });
      const s = await scripted(t, chromium, () => list, 41);
      await untilDrawn(s.page, (rows) => rows.length === 2, 'two rows');
      const acts = (): Record<string, unknown>[] =>
        s.sent.filter((message) => message['t'] === 'act');
      await clickRow(s.page, S1);

      // Held in the filter field: it ends the entry, and its repeats reach no row.
      await s.page.keyboard.press('/');
      await s.page.keyboard.type('sess');
      await s.page.keyboard.down('Enter');
      await s.page.keyboard.down('Enter'); // repeat: true
      await s.page.keyboard.down('Enter');
      await s.page.keyboard.up('Enter');
      await sleep(500);
      assert.deepEqual(acts(), [], 'nothing resumed from the field');
      assert.equal(await active(s.page), '#list');

      // Held on the list: one resume for the press, none for its repeats.
      await s.page.keyboard.down('Enter');
      await s.page.keyboard.down('Enter');
      await s.page.keyboard.down('Enter');
      await s.page.keyboard.up('Enter');
      await until(() => acts().length > 0, 'an act', PAGE_WAIT_MS);
      await sleep(500);
      assert.deepEqual(
        acts().map((act) => [act['kind'], act['sessionId']]),
        [['resume', S1]],
      );
      // The next press is a press again.
      await s.page.keyboard.press('Enter');
      await until(() => acts().length > 1, 'a second act', PAGE_WAIT_MS);
    },
  );

  await t.test(
    "S2 12.3's chip: one open failing pull request and 30 merged show `PR · failing` and `+30` in the chip's tint (F4); `3 merged` is purple, `closed` dim, an unreadable one dotted; a row without pull requests has no chip; hostile text in a chip stays text",
    async (t) => {
      const merged = Array.from({ length: 30 }, (_, at) => fullPr(100 + at, 'merged'));
      const hostile = '<img src=x onerror="window.pwned=1"><b>x</b>';
      const S5 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';
      const S6 = '6b1f9c7e-4d8a-4fca-9c9d-8e7f6a5b4c3d';
      const list = fullList({
        week: [
          fullRow(S1, {
            prs: [fullPr(7, 'checks-failing'), ...merged],
            chip: { level: 'checks-failing', open: 1, merged: 30 },
          }),
          fullRow(S2, {
            prs: [...merged.slice(0, 3), fullPr(9, 'closed')],
            chip: { level: 'merged', open: 0, merged: 3 },
          }),
          fullRow(S3, {
            prs: [fullPr(9, 'closed')],
            chip: { level: 'closed', open: 0, merged: 0 },
          }),
          fullRow(S4, {
            prs: [fullPr(5, 'cant-read', { okAtNs: null, error: 'gh: HTTP 502' })],
            chip: { level: 'cant-read', open: 1, merged: 0 },
          }),
          // Markup in the chip's level, a repository and an error reaches the page as text.
          fullRow(S5, {
            prs: [
              fullPr(7, hostile, { repo: hostile }),
              fullPr(8, 'cant-read', { repo: hostile, error: hostile, okAtNs: null }),
            ],
            chip: { level: hostile, open: 2, merged: 0 },
          }),
          fullRow(S6),
        ],
      });
      const s = await scripted(t, chromium, () => list, 44);
      const rows = await untilDrawn(s.page, (rows) => rows.length === 6, 'six rows');
      assert.deepEqual(
        rows.map((row) => [row.chip, row.chipTip, row.dotted]),
        [
          ['PR · failing +30', 'o/r #7 · failing\n30 merged', false],
          ['3 merged', '3 merged · 1 closed', false],
          ['closed', '1 closed', false],
          ["PR · can't read", "o/r #5 · can't read · never read · gh: HTTP 502", true],
          [
            `2 PRs · ${hostile}`,
            `${hostile} #7 · ${hostile}\n${hostile} #8 · can't read · never read · ${hostile}`,
            false,
          ],
          ['', '', false],
        ],
      );
      const markup = await readPage(
        s.page,
        () => ({
          elements: document.querySelectorAll('#list img, #list b').length,
          pwned: Reflect.get(window, 'pwned') as unknown,
          errors: Reflect.get(globalThis, 'pageErrors') as string[],
        }),
        null,
      );
      assert.deepEqual(markup, { elements: 0, pwned: undefined, errors: [] });
      /** Whether the row's chip element is drawn at all (an empty one would be a bordered box). */
      const chipShown = (id: string): Promise<boolean> =>
        readPage(
          s.page,
          (id) => {
            const chip = document.querySelector(`#list [data-id="${id}"] .row-chip`);
            return chip instanceof HTMLElement && chip.checkVisibility();
          },
          id,
        );
      assert.equal(await chipShown(S1), true);
      assert.equal(await chipShown(S6), false, 'a row without pull requests draws no chip');
      const looks = await readPage(
        s.page,
        (ids) => {
          const probe = document.createElement('span');
          document.body.append(probe);
          /** A colour as the page computes it. */
          const computed = (color: string): string => {
            probe.style.color = color;
            return getComputedStyle(probe).color;
          };
          const faint = computed('var(--faint)');
          const red = computed('var(--pr-red)');
          const purple = computed('var(--pr-purple)');
          probe.remove();
          const colour = (id: string, part: string): string => {
            const found = document.querySelector(`#list [data-id="${id}"] ${part}`);
            return found instanceof HTMLElement && found.checkVisibility()
              ? getComputedStyle(found).color
              : 'not shown';
          };
          return {
            faint,
            red,
            purple,
            failing: colour(ids[0] ?? '', '.row-chip-text'),
            failingText: document.querySelector(`#list [data-id="${ids[0]}"] .row-chip-text`)
              ?.textContent,
            plus: colour(ids[0] ?? '', '.row-chip-merged'),
            plusText: document.querySelector(`#list [data-id="${ids[0]}"] .row-chip-merged`)
              ?.textContent,
            merged: colour(ids[1] ?? '', '.row-chip-text'),
            mergedPlus: colour(ids[1] ?? '', '.row-chip-merged'),
            closed: colour(ids[2] ?? '', '.row-chip-text'),
          };
        },
        [S1, S2, S3],
      );
      assert.equal(looks.failingText, 'PR · failing');
      assert.equal(looks.plusText, ' +30');
      // F4 (ruled): a tinted chip's `+30` keeps the chip's tint; `3 merged` is merged's purple.
      assert.equal(looks.failing, looks.red, 'the open part is in the failing tint');
      assert.equal(looks.plus, looks.red, "the +30 keeps the chip's tint");
      assert.equal(looks.merged, looks.purple, '3 merged is purple');
      assert.equal(looks.mergedPlus, 'not shown', 'no +n with none open');
      assert.equal(looks.closed, looks.faint, 'closed is dim');
      // The same row without pull requests: no chip at all.
      s.send(fullList({ week: [fullRow(S1)] }));
      await untilDrawn(s.page, (rows) => rows.length === 1 && rows[0]?.chip === '', 'no chip');
      assert.equal(await chipShown(S1), false, 'the chip is gone once its pull requests are');
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
              chip: { level: 'draft', open: 1, merged: 0 },
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

      // A later list is counted from when IT came, not from the page's load nor the first list:
      // seconds after both (3 s at least), a row 10 s in its state reads 10 s — 12 s at most
      // under load; counted from the load or the first list it would read 13 s or more.
      const uptime = await readPage(s.page, () => performance.now(), null);
      if (uptime < 3000) await sleep(3000 - uptime);
      const later = NOW + 600n * SEC;
      s.send(
        fullList(
          { open: [fullRow(S1, { state: 'working', sinceNs: String(later - 10n * SEC) })] },
          [],
          { nowNs: String(later) },
        ),
      );
      await untilDrawn(s.page, (rows) => /^working 1[0-2]s$/.test(rows[0]?.state ?? ''), '10 s');
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
      assert.equal(await selectedInView(s.page), 'in view');
      await s.page.keyboard.press('PageUp');
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        ids[0],
      );

      // Up from the bottom of a long list: the selected row is never under the pinned header.
      await s.page.keyboard.press('End');
      for (let i = 0; i < 40; i++) {
        await s.page.keyboard.press('ArrowUp');
        const where = await selectedInView(s.page);
        assert.equal(where, 'in view', `after ${i + 1} × ↑`);
      }
      await s.page.keyboard.press('End');
      await s.page.keyboard.press('PageUp');
      assert.equal(await selectedInView(s.page), 'in view', 'after PageUp');
      await s.page.keyboard.press('PageUp');
      assert.equal(await selectedInView(s.page), 'in view', 'after a second PageUp');
    },
  );

  await t.test(
    'a selected row that moves to another section is scrolled into view (Enter on a row deep in Recent brings it to Open)',
    async (t) => {
      const ids = Array.from(
        { length: 60 },
        (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      );
      const week = ids.map((id, i) => fullRow(id, { lastActivityNs: ago(BigInt(i + 1) * MIN) }));
      let current = fullList({ week });
      const s = await scripted(t, chromium, () => current, 38);
      await untilDrawn(s.page, (rows) => rows.length === 60, 'sixty rows');
      await toZone(s.page, 'list');
      await s.page.keyboard.press('End');
      const last = ids[59] ?? '';
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        last,
      );
      // Its terminal comes: the row is now the first under Open, at the top of the list.
      current = fullList(
        {
          open: [fullRow(last, { state: 'running', sinceNs: ago(SEC), terminal: TERM_A, slot: 1 })],
          week: week.slice(0, 59),
        },
        [fullTerminal(TERM_A, { slot: 1, sessionId: last })],
      );
      s.send(current);
      await untilDrawn(s.page, (rows) => rows[0]?.id === last, 'the row under Open');
      await sleep(200);
      assert.equal(await selectedInView(s.page), 'in view');
    },
  );

  await t.test(
    'sections and rows in exactly the order the server sent them, the list keys following it; a new order is drawn as sent',
    async (t) => {
      let current = fullList({
        open: [
          fullRow(S4, {
            state: 'working',
            sinceNs: ago(MIN),
            elsewhere: { pid: 4242, tty: null, dir: null },
          }),
        ],
        // Neither in the order of the ids nor in the order of activity.
        week: [
          fullRow(S3, { lastActivityNs: ago(5n * DAY) }),
          fullRow(S1, { lastActivityNs: ago(MIN) }),
          fullRow(S2, { lastActivityNs: ago(3n * DAY) }),
        ],
      });
      // The sections too: Recent before Open, an order no server sends, drawn as sent.
      const sections = current['sections'] as SectionPayload[];
      current = { ...current, sections: [sections[1], sections[0], sections[2]] };
      const s = await scripted(t, chromium, () => current, 39);
      await untilDrawn(s.page, (rows) => rows.length === 4, 'four rows');
      assert.deepEqual(await drawnIds(s.page), [S3, S1, S2, S4]);
      assert.deepEqual(await headers(s.page), ['week Recent 3', 'open Open 1']);
      await toZone(s.page, 'list');
      await s.page.keyboard.press('Home');
      const order: (string | null)[] = [await selectedRow(s.page)];
      for (let i = 0; i < 3; i++) {
        const before = order.at(-1);
        await s.page.keyboard.press('ArrowDown');
        await s.page.waitForFunction(
          (id) =>
            document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') !== id,
          before ?? null,
          { timeout: PAGE_WAIT_MS },
        );
        order.push(await selectedRow(s.page));
      }
      assert.deepEqual(order, [S3, S1, S2, S4], '↓ follows the drawn order');

      current = fullList({
        open: [
          fullRow(S4, {
            state: 'working',
            sinceNs: ago(MIN),
            elsewhere: { pid: 4242, tty: null, dir: null },
          }),
        ],
        week: [
          fullRow(S2, { lastActivityNs: ago(3n * DAY) }),
          fullRow(S3, { lastActivityNs: ago(5n * DAY) }),
          fullRow(S1, { lastActivityNs: ago(MIN) }),
        ],
      });
      s.send(current);
      await untilDrawn(
        s.page,
        (rows) => rows.map((row) => row.id).join() === [S4, S2, S3, S1].join(),
        'the new order',
      );
      assert.deepEqual(await headers(s.page), ['open Open 1', 'week Recent 3']);
    },
  );

  await t.test(
    'a click on the Earlier header folds and unfolds it (ruled): ONE click, from either zone, the keyboard on #list; folded with the selection inside, the row above is selected; while a filter is set nothing folds and the selection stays; a filter that matches nothing says so',
    async (t) => {
      const s = await scripted(
        t,
        chromium,
        (view) => {
          const filter = typeof view['filter'] === 'string' ? view['filter'] : '';
          if (filter === 'nothing') return fullList({});
          // S2 12.8: while a filter is set every section is unfolded (the server's rule).
          const unfolded =
            filter !== '' ||
            (Array.isArray(view['unfolded']) && view['unfolded'].includes('earlier'));
          return fullList({
            week: [fullRow(S1)],
            earlier: unfolded ? [fullRow(S2, { lastActivityNs: ago(9n * DAY) })] : 'folded',
          });
        },
        36,
      );
      const header = s.page.locator('#list .list-section[data-section="earlier"]');
      await untilDrawn(s.page, (rows) => rows.length === 1, 'one row');
      assert.deepEqual(await headers(s.page), [
        'open Open 0',
        'week Recent 1',
        'earlier Earlier 4 9d–30d ago',
      ]);
      assert.equal(await zone(s.page), 'Focus: terminal');

      await header.click(); // once, from the terminal zone
      await untilDrawn(s.page, (rows) => rows.length === 2, 'Earlier unfolded by a click');
      assert.equal(await active(s.page), '#list');
      assert.equal(await zone(s.page), 'Focus: list');

      // Folded by a click with the selection inside: the row above is selected first.
      await clickRow(s.page, S2);
      await header.click();
      await untilDrawn(s.page, (rows) => rows.length === 1, 'folded again by a click');
      assert.equal(await selectedRow(s.page), S1);
      assert.equal(await active(s.page), '#list');

      // While a filter is set the server unfolds every section: ← and a click fold nothing, and
      // the selection stays where it is.
      await header.click();
      await untilDrawn(s.page, (rows) => rows.length === 2, 'unfolded');
      await clickRow(s.page, S2);
      await s.page.keyboard.press('/');
      await s.page.keyboard.type('se');
      await s.page.keyboard.press('Enter');
      assert.equal(await active(s.page), '#list');
      const views = s.sent.filter((message) => message['t'] === 'view').length;
      await s.page.keyboard.press('ArrowLeft');
      await header.click();
      await sleep(500);
      assert.deepEqual(await drawnIds(s.page), [S1, S2]);
      assert.equal(await selectedRow(s.page), S2, 'the selection stays');
      assert.equal(
        s.sent.filter((message) => message['t'] === 'view').length,
        views,
        'no view: nothing to fold',
      );

      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('/');
      await s.page.keyboard.type('nothing');
      await showsText(s.page, '#list .list-empty', /^No session matches the filter\.$/);
      assert.deepEqual(await drawnIds(s.page), []);
      assert.deepEqual(await headers(s.page), []);
    },
  );

  await t.test(
    'the selection is never on a row the list does not show (ruled): a filter that excludes it, done sessions hidden again with `a`, the row gone from the list — no row selected, the right side empty, Enter resumes nothing, ↓ and ↑ start from the first row shown',
    async (t) => {
      const done = fullRow(S4, { done: true, title: 'a done one' });
      const base = [
        fullRow(S1),
        fullRow(S2, { title: 'other two' }),
        fullRow(S3, { title: 'other three' }),
      ];
      const s = await scripted(
        t,
        chromium,
        (view) => {
          const filter = typeof view['filter'] === 'string' ? view['filter'] : '';
          const rows = view['showDone'] === true ? [...base, done] : base;
          return fullList({
            week: filter === '' ? rows : rows.filter((row) => row.title.includes(filter)),
          });
        },
        37,
      );
      await untilDrawn(s.page, (rows) => rows.length === 3, 'three rows');
      const pane = (): Promise<string | null> =>
        s.page.evaluate(
          () => document.getElementById('right-zone')?.getAttribute('data-pane') ?? null,
        );
      const acts = (): number => s.sent.filter((message) => message['t'] === 'act').length;
      /** No row drawn selected, nothing on the right side, and Enter on the list resumes nothing. */
      const nothingSelected = async (what: string): Promise<void> => {
        await s.page.waitForFunction(
          () => document.querySelector('#list [data-selected="true"]') === null,
          null,
          { timeout: PAGE_WAIT_MS },
        );
        assert.equal(await pane(), 'none', `${what}: the right side`);
        assert.equal(await active(s.page), '#list', `${what}: the keyboard on the list`);
        const before = acts();
        await s.page.keyboard.press('Enter');
        await sleep(300);
        assert.equal(acts(), before, `${what}: Enter resumes nothing`);
      };

      // A filter that excludes the selected row.
      await clickRow(s.page, S1);
      assert.equal(await pane(), 'resume');
      await s.page.keyboard.press('/');
      await s.page.keyboard.type('other');
      await untilDrawn(s.page, (rows) => rows.length === 2, 'the filter');
      await s.page.keyboard.press('Enter'); // the keyboard back on the list
      await nothingSelected('filtered out');
      await s.page.keyboard.press('ArrowDown');
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S2,
        { timeout: PAGE_WAIT_MS },
      );
      await s.page.keyboard.press('Escape'); // the filter cleared
      await untilDrawn(s.page, (rows) => rows.length === 3, 'no filter');

      // Done sessions shown, one selected, hidden again with `a`.
      await s.page.keyboard.press('a');
      await untilDrawn(s.page, (rows) => rows.length === 4, 'done shown');
      await clickRow(s.page, S4);
      await s.page.keyboard.press('a');
      await untilDrawn(s.page, (rows) => rows.length === 3, 'done hidden again');
      await nothingSelected('done hidden');
      await s.page.keyboard.press('ArrowUp');
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S1,
        { timeout: PAGE_WAIT_MS },
      );

      // The row gone from the server's list.
      await clickRow(s.page, S3);
      s.send(fullList({ week: [fullRow(S1), fullRow(S2, { title: 'other two' })] }));
      await untilDrawn(s.page, (rows) => rows.length === 2, 'the row gone');
      await nothingSelected('gone');
      await s.page.keyboard.press('ArrowDown');
      await s.page.waitForFunction(
        (id) =>
          document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
        S1,
        { timeout: PAGE_WAIT_MS },
      );
      assert.deepEqual(await s.page.evaluate(() => Reflect.get(globalThis, 'pageErrors')), []);
    },
  );
});
