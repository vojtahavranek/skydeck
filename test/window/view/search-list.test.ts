/**
 * Stage E's search in the list message (plan E 2.4, task 96): `buildListMessage` with the filter of
 * several words and the short id (E2), done sessions while filtering (E5), the chips (E4), the
 * stacks (E6) and the switcher's items (E9). Pure: step 1's builders, no platform.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NS_PER_DAY, NS_PER_MINUTE } from '../../../src/platform/time.ts';
import type { ListRow } from '../../../src/sessions/list.ts';
import type { DerivedSession, Holder } from '../../../src/sessions/types.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type {
  ClosedBlock,
  ClosedStackPayload,
  RowPayload,
  SectionPayload,
  StackPayload,
  SwitchItem,
} from '../../../src/window/protocol.ts';
import type { AttentionFacts, AttentionMarks } from '../../../src/window/view/attention.ts';
import { buildListMessage } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import { foundIn, searchWords } from '../../../src/window/view/search/filter.ts';
import { MAX_ITEMS } from '../../../src/window/view/search/switcher.ts';
import { rowPayload } from '../../../src/window/view/sections.ts';
import { attached, ds, meta, prRow, rows } from '../../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

const NOW = T0;
const DAY = NS_PER_DAY;
const MIN = NS_PER_MINUTE;
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';
const NEW = '6b1f9c7e-4d8a-4fca-9c9d-8e7f6a5b4c3d';

type Message = ReturnType<typeof buildListMessage>;

function termId(n: number): string {
  return n.toString(16).padStart(12, '0');
}

/** A terminal of the window showing `sessionId` (a resume, running). */
function term(
  n: number,
  over: Partial<TerminalInfo> & { expectedSessionId: string },
): TerminalInfo {
  return {
    id: termId(n),
    slot: null,
    state: 'running',
    sessionId: over.expectedSessionId,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 4000 + n, procStart: 100 + n },
    openedNs: T0 - DAY + BigInt(n) * SEC,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

function holder(pid: number, procStart: number | null): Holder {
  return { process: { bootId: BOOT_A, pid, procStart }, sinceNs: T0, live: null, scripted: false };
}

/** A running session held by `pid` (process start `procStart`). */
function running(
  id: string,
  over: Omit<Parameters<typeof ds>[0], 'id'> & { pid?: number; procStart?: number } = {},
): DerivedSession {
  const { pid = 9000, procStart = 500, ...rest } = over;
  return ds({ id, state: 'working', holders: [holder(pid, procStart)], ...rest });
}

/** A session that is not running, titled `title`, last active `ago` before NOW. */
function idle(id: string, title: string, ago: bigint, done = false): DerivedSession {
  return ds({
    id,
    lastActivityNs: NOW - ago,
    hidden: done,
    doneAtNs: done ? T0 : null,
    transcript: { aiTitle: title },
  });
}

function input(
  over: Partial<Omit<ViewInput, 'view'>> & { view?: Partial<ViewInput['view']> },
): ViewInput {
  return {
    rows: [],
    terminals: [],
    elsewhere: new Map(),
    selected: null,
    nowNs: NOW,
    ...over,
    view: { filter: '', unfolded: [], showDone: false, selected: null, ...over.view },
  };
}

function section(message: Message, name: SectionPayload['name']): SectionPayload {
  const found = message.sections.find((s) => s.name === name);
  assert.ok(found, `no section ${name}`);
  return found;
}

function ids(message: Message, name: SectionPayload['name']): string[] {
  return section(message, name).rows.map((row) => row.id);
}

/** Every row the sections carry, in order. */
function allIds(message: Message): string[] {
  return message.sections.flatMap((s) => s.rows.map((row) => row.id));
}

function rowIn(message: Message, id: string): RowPayload {
  const row = message.sections.flatMap((s) => s.rows).find((r) => r.id === id);
  assert.ok(row, `no row ${id}`);
  return row;
}

function items(message: Message): SwitchItem[] {
  assert.ok(message.switcher, 'no switcher');
  return message.switcher.items;
}

/** The switcher's items as `id:rank`, in order. */
function ranked(message: Message): string[] {
  return items(message).map((item) => `${item.row.id}:${item.rank}`);
}

function item(message: Message, id: string): SwitchItem {
  const found = items(message).find((one) => one.row.id === id);
  assert.ok(found, `no item ${id}`);
  return found;
}

function marksOf(over: Partial<AttentionMarks>): AttentionMarks {
  return {
    turnEndedSeq: null,
    turnEndedNs: null,
    seenSeq: null,
    windowEndSeq: null,
    windowEndNs: null,
    ...over,
  };
}

// --- the filter: words and the short id (E2) ---------------------------------------------------

test('filter: two words in two fields → that row only, in either order', () => {
  const list = rows(
    [
      idle(S1, 'fix login', MIN),
      idle(S2, 'fix parser', 2n * MIN),
      idle(S3, 'other work', 3n * MIN),
    ],
    { metas: [meta(S1, { group: 'Shop' }), meta(S3, { group: 'Shop' })] },
  );
  const filtered = (filter: string) =>
    allIds(buildListMessage(input({ rows: list, view: { filter } })));
  assert.deepEqual(filtered('shop fix'), [S1]);
  assert.deepEqual(filtered('fix shop'), [S1]);
  assert.deepEqual(filtered('  FIX\tShop  '), [S1]);
  assert.deepEqual(filtered('fix'), [S1, S2]);
  assert.deepEqual(filtered('shop'), [S1, S3]);
  assert.deepEqual(filtered('shop parser'), []);
});

test('filter: the short id — a word of at least 4 characters that starts the id; the whole id too', () => {
  const list = rows([idle(S1, 'alpha', MIN), idle(S2, 'beta', 2n * MIN)]);
  const filtered = (filter: string) =>
    allIds(buildListMessage(input({ rows: list, view: { filter } })));
  assert.equal(S1.slice(0, 4), '0b5f');
  assert.deepEqual(filtered('0b5f'), [S1]);
  assert.deepEqual(filtered('0B5F3C1E'), [S1]);
  assert.deepEqual(filtered(S1), [S1]);
  assert.deepEqual(filtered(`${S1.slice(0, 8)} alpha`), [S1]);
  assert.deepEqual(filtered(`${S1.slice(0, 8)} beta`), []);
  // Three characters are not enough, and a word inside the id is not its start.
  assert.deepEqual(filtered('0b5'), []);
  assert.deepEqual(filtered('5f3c'), []);
});

test('filter: `fix 2` does not match a session through the hex digits of its id', () => {
  assert.ok(S3.startsWith('2'));
  const list = rows([
    idle(S1, 'fix login', MIN),
    idle(S2, 'fix bug 2', 2n * MIN),
    idle(S3, 'fix other', 3n * MIN),
  ]);
  const filtered = (filter: string) =>
    allIds(buildListMessage(input({ rows: list, view: { filter } })));
  assert.deepEqual(filtered('fix 2'), [S2]);
  assert.deepEqual(filtered('2 fix'), [S2]);
  assert.deepEqual(filtered('2d7b'), [S3]);
});

test('filtering: true with a word or a chip, false with neither (white space alone is no word)', () => {
  const list = rows([idle(S1, 'alpha', MIN), idle(S2, 'old', 30n * DAY)]);
  const build = (view: Partial<ViewInput['view']>) => buildListMessage(input({ rows: list, view }));
  assert.equal(build({ filter: 'alpha' }).filtering, true);
  assert.equal(build({ filter: 'zzz' }).filtering, true);
  assert.equal(build({ chips: ['note'] }).filtering, true);
  assert.equal(build({ filter: 'alpha', chips: ['running'] }).filtering, true);
  assert.equal(build({}).filtering, false);
  assert.equal(build({ chips: [] }).filtering, false);
  // White space is no word: nothing filters, Earlier folds as without a filter.
  const blank = build({ filter: ' \t\n\u00a0 ' });
  assert.equal(blank.filtering, false);
  assert.equal(section(blank, 'earlier').folded, true);
  assert.deepEqual(allIds(blank), [S1]);
});

// --- done sessions while filtering (E5) --------------------------------------------------------

test('done: a filter that matches a done row lists it with its done mark, and doneHidden is 0', () => {
  const list = rows([
    idle(S1, 'beta work', MIN),
    idle(S2, 'beta done', 2n * MIN, true),
    idle(S3, 'gamma done', 3n * MIN, true),
    idle(S4, 'beta old done', 30n * DAY, true),
  ]);
  const message = buildListMessage(input({ rows: list, view: { filter: 'beta' } }));
  assert.deepEqual(ids(message, 'week'), [S1, S2]);
  assert.deepEqual(ids(message, 'earlier'), [S4]);
  assert.equal(rowIn(message, S1).done, false);
  assert.equal(rowIn(message, S2).done, true);
  assert.equal(rowIn(message, S4).done, true);
  assert.equal(message.doneHidden, 0);
  // A filter that matches no done row: no footer either (doneHidden is 0 while filtering).
  const other = buildListMessage(input({ rows: list, view: { filter: 'work' } }));
  assert.deepEqual(allIds(other), [S1]);
  assert.equal(other.doneHidden, 0);
});

test('done: the chip `note` alone lists the done rows with a note, and doneHidden is 0', () => {
  const list = rows(
    [idle(S1, 'alpha', MIN), idle(S2, 'beta', 2n * MIN, true), idle(S3, 'gamma', 3n * MIN, true)],
    { metas: [meta(S1, { note: 'n1' }), meta(S2, { note: 'n2' })] },
  );
  const message = buildListMessage(input({ rows: list, view: { chips: ['note'] } }));
  assert.deepEqual(allIds(message), [S1, S2]);
  assert.equal(rowIn(message, S2).done, true);
  assert.equal(message.doneHidden, 0);
});

test("done: without a filter or a chip, stage A's rule — hidden, counted in doneHidden", () => {
  const list = rows([
    idle(S1, 'alpha', MIN),
    idle(S2, 'beta', 2n * MIN, true),
    idle(S3, 'gamma', 30n * DAY, true),
  ]);
  const message = buildListMessage(input({ rows: list }));
  assert.deepEqual(allIds(message), [S1]);
  assert.equal(message.doneHidden, 2);
  const blank = buildListMessage(input({ rows: list, view: { filter: '   ', chips: [] } }));
  assert.deepEqual(allIds(blank), [S1]);
  assert.equal(blank.doneHidden, 2);
  const shown = buildListMessage(
    input({ rows: list, view: { showDone: true, unfolded: ['earlier'] } }),
  );
  assert.deepEqual(allIds(shown), [S1, S2, S3]);
  assert.equal(shown.doneHidden, 0);
});

// --- the counts (E5) ---------------------------------------------------------------------------

test('counts: counts and needYou.count are the same with and without a filter that lists a done row', () => {
  const list = rows([
    idle(S1, 'alpha', MIN),
    idle(S2, 'beta done', 2n * MIN, true),
    running(S3, { transcript: { aiTitle: 'gamma' } }),
    idle(S4, 'beta asks', 3n * MIN),
  ]);
  const facts: AttentionFacts = {
    marks: new Map([
      [S2, marksOf({ windowEndSeq: 1, windowEndNs: NOW - SEC })],
      [S4, marksOf({ windowEndSeq: 2, windowEndNs: NOW - SEC })],
    ]),
    live: new Map(),
  };
  const plain = buildListMessage(input({ rows: list, attention: facts }));
  const filtered = buildListMessage(
    input({ rows: list, attention: facts, view: { filter: 'beta' } }),
  );
  assert.deepEqual(allIds(filtered), [S2, S4]);
  assert.deepEqual(filtered.counts, plain.counts);
  assert.deepEqual(plain.counts, {
    working: 1,
    waiting: 0,
    running: 0,
    starting: 0,
    elsewhere: 0,
    background: 0,
    notRunning: 1,
  });
  assert.equal(filtered.needYou.count, plain.needYou.count);
  assert.equal(plain.needYou.count, 1);
  // What holds (E5 with B7): the done row the filter lists needs you and is shown, so it is in
  // needYou.order (Ctrl+Shift+J reaches what the list shows); it is not counted, as without the
  // filter, so neither the title bar nor `(n) skydeck` moves.
  assert.deepEqual(filtered.needYou.order, [S2, S4]);
  assert.deepEqual(plain.needYou.order, [S4]);
});

test('counts: a done row that needs nothing, listed by a filter, is in no count either', () => {
  const list = rows([idle(S1, 'alpha', MIN), idle(S2, 'beta done', 2n * MIN, true)]);
  const plain = buildListMessage(input({ rows: list }));
  const filtered = buildListMessage(input({ rows: list, view: { filter: 'beta' } }));
  assert.deepEqual(allIds(filtered), [S2]);
  assert.equal(plain.counts.notRunning, 1);
  assert.deepEqual(filtered.counts, plain.counts);
  const chip = buildListMessage(
    input({
      rows: rows([idle(S1, 'alpha', MIN), idle(S2, 'beta', MIN, true)], {
        metas: [meta(S2, { note: 'n' })],
      }),
      view: { chips: ['note'] },
    }),
  );
  assert.deepEqual(allIds(chip), [S2]);
  assert.equal(chip.counts.notRunning, 1);
});

// --- the chips (E4) ----------------------------------------------------------------------------

/** S1 in a terminal of the window; S2 elsewhere, with a note; S3 a draft pull request; S4 a merged
 *  and a closed one, with a note; S5 in Earlier, with a note and one never fetched and one that
 *  cannot be read; S6 starting in a terminal of the window. */
function chipWorld(): Pick<ViewInput, 'rows' | 'terminals' | 'elsewhere'> {
  const draft = prRow('acme/web', 1, { state: 'draft' });
  const merged = prRow('acme/web', 2, { state: 'merged' });
  const closed = prRow('acme/web', 3, { state: 'closed' });
  const unfetched = prRow('acme/api', 4, { state: null, okAtNs: null });
  const unreadable = prRow('acme/api', 5, { error: 'not found' });
  const list = rows(
    [
      running(S1, { pid: 9001, transcript: { aiTitle: 'alpha' } }),
      running(S2, { pid: 9002, transcript: { aiTitle: 'beta' } }),
      idle(S3, 'gamma', MIN),
      idle(S4, 'delta', 2n * MIN),
      idle(S5, 'epsilon', 30n * DAY),
      idle(S6, 'zeta', 3n * MIN),
    ],
    {
      metas: [meta(S2, { note: 'n' }), meta(S4, { note: 'n' }), meta(S5, { note: 'n' })],
      prs: [draft, merged, closed, unfetched, unreadable],
      sessionPrs: [
        attached(S3, draft),
        attached(S4, merged),
        attached(S4, closed),
        attached(S5, unfetched),
        attached(S5, unreadable),
      ],
    },
  );
  return {
    rows: list,
    terminals: [
      term(1, { expectedSessionId: S1, slot: 1 }),
      term(6, { expectedSessionId: S6, sessionId: null, state: 'starting', slot: 2 }),
    ],
    elsewhere: new Map([[S2, { pid: 9002, tty: null }]]),
  };
}

test('chips: `running` keeps the rows in Open — in the window, elsewhere, starting', () => {
  const message = buildListMessage(input({ ...chipWorld(), view: { chips: ['running'] } }));
  assert.deepEqual(ids(message, 'open'), [S1, S6, S2]);
  assert.deepEqual(ids(message, 'week'), []);
  assert.deepEqual(ids(message, 'earlier'), []);
});

test('chips: `open-pr` keeps the rows with a pull request not known to be merged or closed', () => {
  const message = buildListMessage(input({ ...chipWorld(), view: { chips: ['open-pr'] } }));
  assert.deepEqual(allIds(message), [S3, S5]);
});

test('chips: `note` keeps the rows with a note', () => {
  const message = buildListMessage(input({ ...chipWorld(), view: { chips: ['note'] } }));
  assert.deepEqual(allIds(message), [S2, S4, S5]);
});

test('chips: two together, and with a word — every chip and every word must hold', () => {
  const world = chipWorld();
  const build = (view: Partial<ViewInput['view']>) =>
    allIds(buildListMessage(input({ ...world, view })));
  assert.deepEqual(build({ chips: ['note', 'open-pr'] }), [S5]);
  assert.deepEqual(build({ chips: ['note', 'running'] }), [S2]);
  assert.deepEqual(build({ chips: ['running', 'note'], filter: 'beta' }), [S2]);
  assert.deepEqual(build({ chips: ['running', 'note'], filter: 'alpha' }), []);
  assert.deepEqual(build({ chips: ['open-pr'], filter: 'acme/api' }), [S5]);
  assert.deepEqual(build({ chips: ['running', 'open-pr', 'note'] }), []);
});

test('chips: while a chip is set Earlier is unfolded', () => {
  const message = buildListMessage(input({ ...chipWorld(), view: { chips: ['note'] } }));
  assert.equal(section(message, 'earlier').folded, false);
  assert.deepEqual(ids(message, 'earlier'), [S5]);
  for (const s of message.sections) {
    assert.equal(s.folded, false, s.name);
  }
  const plain = buildListMessage(input({ ...chipWorld() }));
  assert.equal(section(plain, 'earlier').folded, true);
});

// --- blocks (E6 as ruled 2026-11-16: G1 to G5; the code calls a block a stack) ------------------

/** Three rows of ORB-1 in Recent, the newest first: S1, S2, S3. */
function orbWeek(): ListRow[] {
  return rows([
    idle(S1, 'ORB-1 fix one', MIN),
    idle(S2, 'ORB-1 fix two', 2n * MIN),
    idle(S3, 'ORB-1 fix three', 3n * MIN),
  ]);
}

/** `view.closed` naming `groups` in `section`. */
function shut(section: SectionPayload['name'], ...groups: string[]): ClosedBlock[] {
  return groups.map((group) => ({ section, group }));
}

/** The block payload of a row of ORB-1 headed by `head` (an open block: F9 draws no row of a
 *  closed one). */
function orb(
  over: Partial<StackPayload> & Pick<StackPayload, 'size' | 'head' | 'role'>,
): StackPayload {
  return { group: 'ORB-1', ...over };
}

/** The closed blocks of `name` (F9: each its caption, none of its rows in `rows`). */
function captions(message: Message, name: SectionPayload['name']): ClosedStackPayload[] {
  return section(message, name).closedStacks;
}

test('blocks: three rows of ORB-1 in Recent are one block, OPEN by default — without `closed` and with `closed: []` (G1, G4)', () => {
  for (const view of [{}, { closed: [] }, { closed: shut('open', 'ORB-1') }]) {
    const why = JSON.stringify(view);
    const message = buildListMessage(input({ rows: orbWeek(), view }));
    assert.deepEqual(ids(message, 'week'), [S1, S2, S3], why);
    assert.deepEqual(rowIn(message, S1).stack, orb({ size: 3, head: S1, role: 'head' }), why);
    assert.deepEqual(rowIn(message, S2).stack, orb({ size: 3, head: S1, role: 'member' }), why);
    assert.deepEqual(rowIn(message, S3).stack, orb({ size: 3, head: S1, role: 'member' }), why);
    assert.deepEqual(captions(message, 'week'), [], why);
  }
});

test("blocks: `closed` naming Recent and ORB-1 closes that block: NO row of it, its caption alone (F9); count and time span all its rows'", () => {
  const message = buildListMessage(
    input({ rows: orbWeek(), view: { closed: shut('week', 'ORB-1') } }),
  );
  const week = section(message, 'week');
  assert.equal(week.count, 3);
  assert.deepEqual(ids(message, 'week'), []);
  assert.deepEqual(captions(message, 'week'), [
    { group: 'ORB-1', size: 3, needYou: 0, head: S1, at: 0 },
  ]);
  assert.equal(week.firstNs, String(NOW - 3n * MIN));
  assert.equal(week.lastNs, String(NOW - MIN));
  // Another group's entry, another section's, another case: the block stays open.
  for (const closed of [shut('week', 'ORB-2', 'orb-1', 'ORB-1 '), shut('earlier', 'ORB-1')]) {
    const other = buildListMessage(input({ rows: orbWeek(), view: { closed } }));
    assert.deepEqual(ids(other, 'week'), [S1, S2, S3], JSON.stringify(closed));
    assert.deepEqual(captions(other, 'week'), [], JSON.stringify(closed));
  }
});

test('blocks: a selected row opens its closed block — any of its rows, the FIRST too (G5, F9 K5)', () => {
  const closed = shut('week', 'ORB-1');
  for (const selected of [S1, S2, S3]) {
    const message = buildListMessage(input({ rows: orbWeek(), view: { closed, selected } }));
    assert.deepEqual(ids(message, 'week'), [S1, S2, S3], selected);
    assert.deepEqual(captions(message, 'week'), [], selected);
    assert.deepEqual(rowIn(message, S1).stack, orb({ size: 3, head: S1, role: 'head' }), selected);
    // Apart from `stack`, the row is the row as it is in no block (E13's `selectedRow`).
    assert.deepEqual({ ...rowIn(message, selected), stack: null }, message.selectedRow, selected);
  }
});

test('blocks: every section carries `closedStacks`: [] with nothing closed, while filtering and while folded (F9)', () => {
  const list = rows([idle(S1, 'ORB-1 old', 30n * DAY), idle(S2, 'ORB-1 older', 31n * DAY)]);
  const closed = shut('earlier', 'ORB-1');
  const folded = buildListMessage(input({ rows: list, view: { closed } }));
  assert.deepEqual(
    folded.sections.map((s) => [s.name, s.closedStacks]),
    [
      ['open', []],
      ['week', []],
      ['earlier', []],
    ],
  );
  const unfolded = buildListMessage(input({ rows: list, view: { closed, unfolded: ['earlier'] } }));
  assert.deepEqual(captions(unfolded, 'earlier'), [
    { group: 'ORB-1', size: 2, needYou: 0, head: S1, at: 0 },
  ]);
  const filtering = buildListMessage(
    input({ rows: list, view: { closed, unfolded: ['earlier'], filter: 'orb' } }),
  );
  assert.deepEqual(ids(filtering, 'earlier'), [S1, S2]);
  assert.deepEqual(captions(filtering, 'earlier'), []);
});

test('blocks: a group in two sections is two blocks, each closed on its own (G1)', () => {
  const list = rows([
    running(S5, { pid: 9005, transcript: { aiTitle: 'ORB-1 runs' } }),
    running(S6, { pid: 9006, procStart: 600, transcript: { aiTitle: 'ORB-1 runs too' } }),
    idle(S1, 'ORB-1 fix one', MIN),
    idle(S2, 'ORB-1 fix two', 2n * MIN),
    idle(S3, 'ORB-1 fix old', 30n * DAY),
    idle(S4, 'ORB-1 fix older', 31n * DAY),
  ]);
  const elsewhere = new Map([
    [S5, { pid: 9005, tty: null }],
    [S6, { pid: 9006, tty: null }],
  ]);
  const build = (closed?: ClosedBlock[]) =>
    buildListMessage(input({ rows: list, elsewhere, view: { closed, unfolded: ['earlier'] } }));
  const open = build();
  assert.deepEqual(ids(open, 'open'), [S5, S6]);
  assert.deepEqual(ids(open, 'week'), [S1, S2]);
  assert.deepEqual(ids(open, 'earlier'), [S3, S4]);
  assert.deepEqual(rowIn(open, S5).stack, orb({ size: 2, head: S5, role: 'head' }));
  assert.deepEqual(rowIn(open, S1).stack, orb({ size: 2, head: S1, role: 'head' }));
  assert.deepEqual(rowIn(open, S3).stack, orb({ size: 2, head: S3, role: 'head' }));
  for (const name of ['open', 'week', 'earlier'] as const) {
    const one = build(shut(name, 'ORB-1'));
    for (const other of ['open', 'week', 'earlier'] as const) {
      assert.equal(ids(one, other).length, other === name ? 0 : 2, `${name} closed, ${other}`);
      assert.equal(captions(one, other).length, other === name ? 1 : 0, `${name}, ${other}`);
      assert.equal(section(one, other).count, 2, `${name} closed, ${other}`);
    }
  }
  // A folded Earlier carries no rows, its count all of them, whatever is closed.
  const folded = buildListMessage(input({ rows: list, elsewhere }));
  assert.deepEqual(section(folded, 'earlier').rows, []);
  assert.equal(section(folded, 'earlier').count, 2);
});

test('blocks: in Open, three running sessions of one group are one block, with their slots (G1)', () => {
  const list = rows(
    [
      running(S1, { pid: 9001, transcript: { aiTitle: 'test one' } }),
      running(S2, { pid: 9002, transcript: { aiTitle: 'test two' } }),
      running(S3, { pid: 9003, transcript: { aiTitle: 'test three' } }),
    ],
    {
      metas: [
        meta(S1, { group: 'test' }),
        meta(S2, { group: 'test' }),
        meta(S3, { group: 'test' }),
      ],
    },
  );
  const terminals = [
    term(1, { expectedSessionId: S1, slot: 1 }),
    term(2, { expectedSessionId: S2, slot: 2 }),
    term(3, { expectedSessionId: S3, slot: 3 }),
  ];
  const message = buildListMessage(input({ rows: list, terminals }));
  assert.deepEqual(ids(message, 'open'), [S1, S2, S3]);
  const head: StackPayload = { group: 'test', size: 3, role: 'head', head: S1 };
  assert.deepEqual(
    section(message, 'open').rows.map((row) => [row.slot, row.terminal, row.stack]),
    [
      [1, termId(1), head],
      [2, termId(2), { ...head, role: 'member' }],
      [3, termId(3), { ...head, role: 'member' }],
    ],
  );
  const closed = buildListMessage(
    input({ rows: list, terminals, view: { closed: shut('open', 'test') } }),
  );
  assert.deepEqual(ids(closed, 'open'), []);
  assert.equal(section(closed, 'open').count, 3);
  assert.deepEqual(captions(closed, 'open'), [
    { group: 'test', size: 3, needYou: 0, head: S1, at: 0 },
  ]);
});

test("blocks: in Open a block sits at its first member's place in Open's order, its members after it (G3)", () => {
  const list = rows([
    running(S1, { pid: 9001, transcript: { aiTitle: 'ORB-1 one' } }),
    running(S2, { pid: 9002, transcript: { aiTitle: 'plain two' } }),
    running(S3, { pid: 9003, transcript: { aiTitle: 'ORB-1 three' } }),
    running(S4, { pid: 9004, procStart: 400, transcript: { aiTitle: 'ORB-1 elsewhere' } }),
  ]);
  const message = buildListMessage(
    input({
      rows: list,
      terminals: [
        term(1, { expectedSessionId: S1, slot: 1 }),
        term(2, { expectedSessionId: S2, slot: 2 }),
        term(3, { expectedSessionId: S3, slot: 3 }),
      ],
      elsewhere: new Map([[S4, { pid: 9004, tty: null }]]),
    }),
  );
  // Open's order: slots 1, 2, 3, then S4 elsewhere; the block of ORB-1 at S1's place.
  assert.deepEqual(ids(message, 'open'), [S1, S3, S4, S2]);
  assert.deepEqual(
    section(message, 'open').rows.map((row) => row.stack?.role ?? null),
    ['head', 'member', 'member', null],
  );
});

test('blocks: a row with an ended terminal of the window and a row that needs you are members like any other (G2)', () => {
  const list = rows([
    idle(S1, 'ORB-1 ended here', MIN),
    idle(S2, 'ORB-1 needs you', 2n * MIN),
    idle(S3, 'ORB-1 fix three', 3n * MIN),
    idle(S4, 'ORB-1 fix four', 4n * MIN),
  ]);
  const facts: AttentionFacts = {
    marks: new Map([[S2, marksOf({ windowEndSeq: 1, windowEndNs: NOW - SEC })]]),
    live: new Map(),
  };
  const build = (closed: ClosedBlock[], selected: string | null = null) =>
    buildListMessage(
      input({
        rows: list,
        terminals: [term(1, { expectedSessionId: S1, state: 'ended', slot: 1 })],
        attention: facts,
        view: { closed, selected },
      }),
    );
  const open = build([]);
  assert.equal(rowIn(open, S1).terminal, termId(1));
  assert.equal(rowIn(open, S1).slot, 1);
  assert.equal(rowIn(open, S2).attention?.reason, 'ended');
  assert.deepEqual(ids(open, 'week'), [S1, S2, S3, S4]);
  assert.deepEqual(rowIn(open, S1).stack, orb({ size: 4, head: S1, role: 'head' }));
  assert.deepEqual(rowIn(open, S2).stack, orb({ size: 4, head: S1, role: 'member' }));
  // Closed: no row; its caption counts the one row that needs you.
  const closed = build(shut('week', 'ORB-1'));
  assert.deepEqual(ids(closed, 'week'), []);
  assert.deepEqual(captions(closed, 'week'), [
    { group: 'ORB-1', size: 4, needYou: 1, head: S1, at: 0 },
  ]);
  assert.equal(section(closed, 'week').count, 4);
  // Selected, the row that needs you opens its block.
  assert.deepEqual(ids(build(shut('week', 'ORB-1'), S2), 'week'), [S1, S2, S3, S4]);
});

test('blocks: a closed block whose member is drawn with a terminal that has not reported a session is drawn open, so that its row and its slot show (ruled 2026-11-16)', () => {
  // Open: S1 (slot 1, reported) and S2 (slot 2, started for S2, not reported); Recent: S3 and
  // S4, whose terminal (slot 3) ended before its program reported. All of `test`.
  const list = rows(
    [
      running(S1, { pid: 9001, transcript: { aiTitle: 'one' } }),
      idle(S2, 'two', MIN),
      idle(S3, 'three', 2n * MIN),
      idle(S4, 'four', 3n * MIN),
    ],
    {
      metas: [S1, S2, S3, S4].map((id) => meta(id, { group: 'test' })),
    },
  );
  const terminals = [
    term(1, { expectedSessionId: S1, slot: 1 }),
    term(2, { expectedSessionId: S2, sessionId: null, slot: 2, notReported: true }),
    term(3, { expectedSessionId: S4, sessionId: null, slot: 3, state: 'ended', program: null }),
  ];
  const closed = [...shut('open', 'test'), ...shut('week', 'test')];
  const message = buildListMessage(input({ rows: list, terminals, view: { closed } }));
  assert.deepEqual(ids(message, 'open'), [S1, S2]);
  assert.equal(rowIn(message, S2).slot, 2);
  assert.deepEqual(captions(message, 'open'), []);
  assert.deepEqual(ids(message, 'week'), [S3, S4]);
  assert.equal(rowIn(message, S4).slot, 3);
  assert.deepEqual(captions(message, 'week'), []);
  // Reported, the block is closed again, as `closed` says.
  const reported = buildListMessage(
    input({
      rows: list,
      terminals: [terminals[0] as TerminalInfo, term(2, { expectedSessionId: S2, slot: 2 })],
      view: { closed },
    }),
  );
  // (S2, reported and not running, is in Recent now: S1 is alone in Open.)
  assert.deepEqual(ids(reported, 'open'), [S1]);
  assert.deepEqual(ids(reported, 'week'), []);
  assert.deepEqual(captions(reported, 'week'), [
    { group: 'test', size: 3, needYou: 0, head: S2, at: 0 },
  ]);
  // An unreported FIRST row opens its block too: a closed block hides it as well (F9); needYou
  // does not move.
  const head = buildListMessage(
    input({
      rows: list,
      terminals: [term(2, { expectedSessionId: S2, sessionId: null, slot: 2 })],
      view: { closed },
    }),
  );
  // (S1 runs without a terminal of the window now: Open's order puts S2, the terminal, first.)
  assert.deepEqual(ids(head, 'open'), [S2, S1]);
  assert.equal(rowIn(head, S2).stack?.role, 'head');
  assert.deepEqual(captions(head, 'open'), []);
  assert.deepEqual(ids(head, 'week'), []);
  assert.equal(captions(head, 'week').length, 1);
  assert.deepEqual(
    head.needYou,
    buildListMessage(
      input({
        rows: list,
        terminals: [term(2, { expectedSessionId: S2, sessionId: null, slot: 2 })],
      }),
    ).needYou,
  );
});

test('blocks: a filter or a chip flattens every block, in every section', () => {
  const list = rows(
    [
      running(S4, { pid: 9004, transcript: { aiTitle: 'ORB-1 runs' } }),
      running(S5, { pid: 9005, procStart: 600, transcript: { aiTitle: 'ORB-1 runs too' } }),
      idle(S1, 'ORB-1 fix one', MIN),
      idle(S2, 'ORB-1 fix two', 2n * MIN),
      idle(S3, 'ORB-1 fix three', 3n * MIN),
    ],
    {
      metas: [
        meta(S1, { note: 'n' }),
        meta(S2, { note: 'n' }),
        meta(S4, { note: 'n' }),
        meta(S5, { note: 'n' }),
      ],
    },
  );
  const elsewhere = new Map([
    [S4, { pid: 9004, tty: null }],
    [S5, { pid: 9005, tty: null }],
  ]);
  for (const view of [{ filter: 'fix' }, { filter: 'orb-1' }, { chips: ['note' as const] }]) {
    for (const closed of [undefined, [], [...shut('open', 'ORB-1'), ...shut('week', 'ORB-1')]]) {
      const why = `${JSON.stringify(view)} ${JSON.stringify(closed)}`;
      const message = buildListMessage(input({ rows: list, elsewhere, view: { closed, ...view } }));
      assert.ok(section(message, 'week').rows.length >= 2, why);
      for (const row of message.sections.flatMap((s) => s.rows)) {
        assert.equal(row.stack, null, `${row.id} ${why}`);
      }
      for (const s of message.sections) {
        assert.deepEqual(s.closedStacks, [], `${s.name} ${why}`);
      }
    }
  }
});

test('blocks: `needYou` and the counts are the same with and without closed blocks; Ctrl+Shift+J reaches a hidden member (G5)', () => {
  // Open: S1 (slot 1, needs you: waiting), S2 (slot 2), S3 (slot 3, needs you), all of `test`;
  // Recent: S4, S5 (needs you: ended), S6 of ORB-1.
  const list = rows(
    [
      running(S1, { pid: 9001, transcript: { aiTitle: 'one' } }),
      running(S2, { pid: 9002, transcript: { aiTitle: 'two' } }),
      running(S3, { pid: 9003, transcript: { aiTitle: 'three' } }),
      idle(S4, 'ORB-1 four', MIN),
      idle(S5, 'ORB-1 five', 2n * MIN),
      idle(S6, 'ORB-1 six', 3n * MIN),
    ],
    {
      metas: [
        meta(S1, { group: 'test' }),
        meta(S2, { group: 'test' }),
        meta(S3, { group: 'test' }),
      ],
    },
  );
  const facts: AttentionFacts = {
    marks: new Map([[S5, marksOf({ windowEndSeq: 1, windowEndNs: NOW - SEC })]]),
    live: new Map([
      [S1, { status: 'waiting', waitingFor: null, sinceNs: NOW - 10n * SEC }],
      [S3, { status: 'waiting', waitingFor: null, sinceNs: NOW - 20n * SEC }],
    ]),
  };
  const build = (closed?: ClosedBlock[]) =>
    buildListMessage(
      input({
        rows: list,
        terminals: [
          term(1, { expectedSessionId: S1, slot: 1 }),
          term(2, { expectedSessionId: S2, slot: 2 }),
          term(3, { expectedSessionId: S3, slot: 3 }),
        ],
        attention: facts,
        view: { closed },
      }),
    );
  const plain = build();
  assert.deepEqual(new Set(plain.needYou.order), new Set([S1, S3, S5]));
  assert.equal(plain.needYou.count, 3);
  const allClosed = build([...shut('open', 'test'), ...shut('week', 'ORB-1')]);
  assert.deepEqual(ids(allClosed, 'open'), []);
  assert.deepEqual(ids(allClosed, 'week'), []);
  // Every row of a closed block is hidden, the first too: each caption counts all that need you.
  assert.equal(captions(allClosed, 'open')[0]?.needYou, 2);
  assert.equal(captions(allClosed, 'week')[0]?.needYou, 1);
  for (const closed of [
    [],
    shut('open', 'test'),
    shut('week', 'ORB-1'),
    shut('earlier', 'ORB-1'),
  ]) {
    const message = build(closed);
    const why = JSON.stringify(closed);
    assert.deepEqual(message.needYou, plain.needYou, why);
    assert.deepEqual(message.counts, plain.counts, why);
  }
  assert.deepEqual(allClosed.needYou, plain.needYou);
  assert.deepEqual(allClosed.counts, plain.counts);
});

// --- the switcher (E8, E9) ---------------------------------------------------------------------

/** S1 in the window (slot 1), S2 elsewhere; S3 not running, S4 done (Recent); S5 not running,
 *  S6 done (Earlier). */
function switchWorld(): Pick<ViewInput, 'rows' | 'terminals' | 'elsewhere'> {
  return {
    rows: rows([
      running(S1, { pid: 9001, transcript: { aiTitle: 'alpha one' } }),
      running(S2, { pid: 9002, transcript: { aiTitle: 'beta two' } }),
      idle(S3, 'gamma three', MIN),
      idle(S4, 'delta four', 2n * MIN, true),
      idle(S5, 'epsilon five', 30n * DAY),
      idle(S6, 'zeta six', 40n * DAY, true),
    ]),
    terminals: [term(1, { expectedSessionId: S1, slot: 1 })],
    elsewhere: new Map([[S2, { pid: 9002, tty: null }]]),
  };
}

test('switcher: null without view.switcher, and while it is null', () => {
  assert.equal(buildListMessage(input({ ...switchWorld() })).switcher, null);
  assert.equal(
    buildListMessage(input({ ...switchWorld(), view: { switcher: null } })).switcher,
    null,
  );
});

test("switcher: '' lists every session listed with done ones shown, ranked open, not running, done", () => {
  const message = buildListMessage(input({ ...switchWorld(), view: { switcher: '' } }));
  assert.deepEqual(ranked(message), [
    `${S1}:open`,
    `${S2}:open`,
    `${S3}:not-running`,
    `${S5}:not-running`,
    `${S4}:done`,
    `${S6}:done`,
  ]);
  assert.equal(message.switcher?.more, 0);
  assert.equal(message.switcher?.query, '');
  assert.equal(message.switcher?.command, false);
  assert.equal(message.switcher?.restore, null);
  for (const one of items(message)) {
    assert.deepEqual(one.found, [], one.row.id);
  }
});

test("switcher: Open's items in Open's order (slots, then elsewhere), whatever their activity", () => {
  const message = buildListMessage(
    input({
      rows: rows([
        running(S1, { pid: 9001, lastActivityNs: NOW - 9n * MIN, transcript: { aiTitle: 'a' } }),
        running(S2, { pid: 9002, lastActivityNs: NOW - MIN, transcript: { aiTitle: 'b' } }),
        running(S3, { pid: 9003, lastActivityNs: NOW, transcript: { aiTitle: 'c' } }),
        idle(S4, 'd', 10n * MIN),
      ]),
      terminals: [
        term(1, { expectedSessionId: S2, slot: 2 }),
        term(2, { expectedSessionId: S1, slot: 1 }),
      ],
      elsewhere: new Map([[S3, { pid: 9003, tty: null }]]),
      view: { switcher: '' },
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1, S2, S3]);
  assert.deepEqual(ranked(message), [
    `${S1}:open`,
    `${S2}:open`,
    `${S3}:open`,
    `${S4}:not-running`,
  ]);
});

test('switcher: the candidates are sorted by the view model, whatever order the rows come in', () => {
  const list = rows([
    idle(S6, 'older', 3n * MIN),
    running(S3, { pid: 9003, procStart: 700, transcript: { aiTitle: 'c' } }),
    idle(S5, 'newest', MIN),
    running(S2, { pid: 9002, procStart: 600, transcript: { aiTitle: 'b' } }),
    idle(S4, 'middle', 2n * MIN),
    running(S1, { pid: 9001, transcript: { aiTitle: 'a' } }),
  ]);
  const message = buildListMessage(
    input({
      rows: list,
      terminals: [term(1, { expectedSessionId: S1, slot: 1 })],
      elsewhere: new Map([
        [S2, { pid: 9002, tty: null }],
        [S3, { pid: 9003, tty: null }],
      ]),
      view: { switcher: '' },
    }),
  );
  assert.deepEqual(ranked(message), [
    `${S1}:open`,
    `${S2}:open`,
    `${S3}:open`,
    `${S5}:not-running`,
    `${S4}:not-running`,
    `${S6}:not-running`,
  ]);
});

test('switcher: a done session that runs is open (S2 12.10): a filter hides it by `filter` alone', () => {
  const list = rows([
    running(S1, { hidden: true, doneAtNs: T0, transcript: { aiTitle: 'alpha' } }),
    idle(S2, 'beta', MIN),
  ]);
  const message = buildListMessage(
    input({
      rows: list,
      elsewhere: new Map([[S1, { pid: 9000, tty: null }]]),
      view: { switcher: '', filter: 'beta' },
    }),
  );
  assert.equal(item(message, S1).row.done, true);
  assert.equal(item(message, S1).rank, 'open');
  assert.deepEqual(item(message, S1).hiddenBy, ['filter']);
  // Without the filter the list shows it, done mark and all.
  const plain = buildListMessage(
    input({
      rows: list,
      elsewhere: new Map([[S1, { pid: 9000, tty: null }]]),
      view: { switcher: '' },
    }),
  );
  assert.deepEqual(ids(plain, 'open'), [S1]);
  assert.deepEqual(item(plain, S1).hiddenBy, []);
});

test("switcher: each item's hiddenBy says what this page's list would have to change (filter, done, folded)", () => {
  const world = switchWorld();
  const hidden = (view: Partial<ViewInput['view']>) => {
    const message = buildListMessage(input({ ...world, view: { switcher: '', ...view } }));
    return Object.fromEntries(items(message).map((one) => [one.row.id, one.hiddenBy]));
  };
  assert.deepEqual(hidden({}), {
    [S1]: [],
    [S2]: [],
    [S3]: [],
    [S4]: ['done'],
    [S5]: ['folded'],
    [S6]: ['done', 'folded'],
  });
  assert.deepEqual(hidden({ filter: 'gamma' }), {
    [S1]: ['filter'],
    [S2]: ['filter'],
    [S3]: [],
    [S4]: ['filter', 'done'],
    [S5]: ['filter', 'folded'],
    [S6]: ['filter', 'done', 'folded'],
  });
  // A done row the filter matches is listed while filtering; so is a match in Earlier.
  assert.deepEqual(hidden({ filter: 'zeta' })[S6], []);
  assert.deepEqual(hidden({ filter: 'delta' })[S4], []);
  // Earlier unfolded by the view: no `folded`; done shown: no `done`.
  assert.deepEqual(hidden({ filter: 'gamma', unfolded: ['earlier'] })[S6], ['filter', 'done']);
  assert.deepEqual(hidden({ showDone: true })[S6], ['folded']);
  assert.deepEqual(hidden({ showDone: true, unfolded: ['earlier'] }), {
    [S1]: [],
    [S2]: [],
    [S3]: [],
    [S4]: [],
    [S5]: [],
    [S6]: [],
  });
  // A chip hides as a word does.
  assert.deepEqual(hidden({ chips: ['running'] })[S3], ['filter']);
  assert.deepEqual(hidden({ chips: ['running'] })[S1], []);
});

test('switcher: a row of a closed block, its first too, is no hidden row (selecting it opens the block)', () => {
  const message = buildListMessage(
    input({ rows: orbWeek(), view: { closed: shut('week', 'ORB-1'), switcher: 'orb' } }),
  );
  assert.deepEqual(ids(message, 'week'), []);
  assert.deepEqual(
    items(message).map((one) => [one.row.id, one.hiddenBy]),
    [
      [S1, []],
      [S2, []],
      [S3, []],
    ],
  );
  // The switcher's row is the row as the list carries it once the block opens, without the block.
  assert.equal(item(message, S1).row.stack, null);
  const opened = buildListMessage(
    input({ rows: orbWeek(), view: { closed: shut('week', 'ORB-1'), selected: S1 } }),
  );
  assert.deepEqual({ ...rowIn(opened, S1), stack: null }, item(message, S1).row);
});

test("switcher: with stage B's facts the sessions that need you come first, in B's order, shown or not", () => {
  const facts: AttentionFacts = {
    marks: new Map([
      [S3, marksOf({ windowEndSeq: 3, windowEndNs: NOW - SEC })],
      [S5, marksOf({ windowEndSeq: 2, windowEndNs: NOW - SEC })],
      [S6, marksOf({ windowEndSeq: 1, windowEndNs: NOW - SEC })],
    ]),
    live: new Map([[S1, { status: 'waiting', waitingFor: null, sinceNs: NOW - 10n * SEC }]]),
  };
  const message = buildListMessage(
    input({ ...switchWorld(), attention: facts, view: { switcher: '' } }),
  );
  assert.deepEqual(ranked(message), [
    `${S1}:need`,
    `${S6}:need`,
    `${S5}:need`,
    `${S3}:need`,
    `${S2}:open`,
    `${S4}:done`,
  ]);
  // The list's own order of what it shows (Earlier folded, done hidden) agrees on the shown ones.
  assert.deepEqual(message.needYou.order, [S1, S3]);
  // Words choose among them; the rank and the order stay.
  const words = buildListMessage(
    input({ ...switchWorld(), attention: facts, view: { switcher: 'e' } }),
  );
  assert.deepEqual(ranked(words), [
    `${S1}:need`,
    `${S6}:need`,
    `${S5}:need`,
    `${S3}:need`,
    `${S2}:open`,
    `${S4}:done`,
  ]);
  const some = buildListMessage(
    input({ ...switchWorld(), attention: facts, view: { switcher: 'five' } }),
  );
  assert.deepEqual(ranked(some), [`${S5}:need`]);
});

test('switcher: its words follow the filter rule (several words, the short id) and ignore the page filter', () => {
  const world = switchWorld();
  const build = (switcher: string, view: Partial<ViewInput['view']> = {}) =>
    buildListMessage(input({ ...world, view: { switcher, ...view } }));
  assert.deepEqual(ranked(build('three gamma')), [`${S3}:not-running`]);
  assert.deepEqual(ranked(build(S5.slice(0, 4))), [`${S5}:not-running`]);
  assert.deepEqual(ranked(build('2d7b')), [`${S3}:not-running`]);
  assert.deepEqual(ranked(build('2')), []);
  // The page's filter shows only S3; the switcher still finds S6 (done, in the folded Earlier).
  const filtered = build('zeta', { filter: 'gamma' });
  assert.deepEqual(allIds(filtered), [S3]);
  assert.deepEqual(ranked(filtered), [`${S6}:done`]);
  assert.deepEqual(item(filtered, S6).hiddenBy, ['filter', 'done', 'folded']);
  // The chips choose nothing of the switcher's either.
  assert.deepEqual(ranked(build('gamma', { chips: ['running'] })), [`${S3}:not-running`]);
});

test("switcher: each item's found is foundIn(title, words), and its query is the text as sent", () => {
  const message = buildListMessage(input({ ...switchWorld(), view: { switcher: '  GAMMA  th' } }));
  assert.equal(message.switcher?.query, '  GAMMA  th');
  const gamma = item(message, S3);
  assert.deepEqual(gamma.found, foundIn('gamma three', searchWords('  GAMMA  th')));
  assert.deepEqual(gamma.found, [
    [0, 5],
    [6, 8],
  ]);
});

test("switcher: command form — '>restore' lists no session, command true; restore is always null here", () => {
  for (const text of ['>restore', '>', '> alpha', '>r']) {
    const message = buildListMessage(input({ ...switchWorld(), view: { switcher: text } }));
    assert.deepEqual(message.switcher, {
      query: text,
      command: true,
      items: [],
      more: 0,
      restore: null,
    });
  }
  // A space first is no command: sessions are searched for the word `>restore`.
  const spaced = buildListMessage(input({ ...switchWorld(), view: { switcher: ' >restore' } }));
  assert.equal(spaced.switcher?.command, false);
  assert.deepEqual(spaced.switcher?.items, []);
});

test('switcher: counts, needYou and the sections are the same with and without it', () => {
  const facts: AttentionFacts = {
    marks: new Map([[S6, marksOf({ windowEndSeq: 1, windowEndNs: NOW - SEC })]]),
    live: new Map(),
  };
  for (const view of [
    {},
    { filter: 'gamma' },
    { closed: shut('week', 'gamma') },
    { chips: ['running' as const] },
  ]) {
    const without = buildListMessage(input({ ...switchWorld(), attention: facts, view }));
    for (const switcher of ['', 'zeta', '>restore']) {
      const withIt = buildListMessage(
        input({ ...switchWorld(), attention: facts, view: { ...view, switcher } }),
      );
      assert.notEqual(withIt.switcher, null);
      assert.deepEqual(
        { ...withIt, switcher: null },
        without,
        `${JSON.stringify(view)} ${switcher}`,
      );
    }
  }
});

test("switcher: a `new` terminal's own row is an item; a session step 1 does not list is none", () => {
  const list = rows([idle(S1, 'alpha', MIN), ds({ id: S2, transcript: null })]);
  const message = buildListMessage(
    input({
      rows: list,
      terminals: [
        term(1, {
          expectedSessionId: NEW,
          sessionId: null,
          kind: 'new',
          label: 'fix login',
          state: 'starting',
          slot: 1,
        }),
      ],
      view: { switcher: '' },
    }),
  );
  assert.deepEqual(ranked(message), [`${NEW}:open`, `${S1}:not-running`]);
});

test(`switcher: at most MAX_ITEMS (${MAX_ITEMS}) items; more counts the rest`, () => {
  const many = Array.from({ length: MAX_ITEMS + 3 }, (_, n) =>
    idle(
      `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      `task ${n}`,
      BigInt(n + 1) * MIN,
    ),
  );
  const message = buildListMessage(input({ rows: rows(many), view: { switcher: 'task' } }));
  assert.equal(items(message).length, MAX_ITEMS);
  assert.equal(message.switcher?.more, 3);
});

// --- cost: nothing is made searchable when nothing is searched ---------------------------------

/** `row` behind a proxy that counts the reads of its title. */
function counted(row: ListRow): { row: ListRow; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(row, {
    get(target, key, receiver) {
      if (key === 'title') {
        reads += 1;
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { row: proxy, reads: () => reads };
}

test('cost: with no word and the switcher closed no row is made searchable (its title is read only for its payload)', () => {
  const [source] = rows([idle(S1, 'alpha', MIN)]);
  assert.ok(source);
  const forPayload = counted({ ...source });
  rowPayload(forPayload.row, { terminal: null, elsewhere: null });
  const payloadReads = forPayload.reads();

  const plain = counted({ ...source });
  buildListMessage(input({ rows: [plain.row], view: { chips: ['note'], closed: [] } }));
  assert.equal(plain.reads(), payloadReads);

  const searched = counted({ ...source });
  buildListMessage(input({ rows: [searched.row], view: { filter: 'alpha' } }));
  assert.ok(searched.reads() > payloadReads, 'a word makes the row searchable');

  const switching = counted({ ...source });
  buildListMessage(input({ rows: [switching.row], view: { switcher: '' } }));
  assert.ok(switching.reads() > payloadReads, 'the open switcher makes the row searchable');
});
