// F44 (S2 12.1, 12.2, 12.4, 12.8, 12.15): the section Parked of the window's list model, its order,
// its numbers and its quiet, over `buildListMessage` (and `openRows`, `keptNow`).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NS_PER_DAY, NS_PER_MINUTE } from '../../../src/platform/time.ts';
import type { Ns } from '../../../src/platform/types.ts';
import type { DerivedSession, Holder } from '../../../src/sessions/types.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type { RowPayload, SearchChip, SectionPayload } from '../../../src/window/protocol.ts';
import type {
  AttentionFacts,
  AttentionMarks,
  LiveStatus,
} from '../../../src/window/view/attention.ts';
import { buildListMessage, keptNow, openRows } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import { parkedTerminals, sectionOf } from '../../../src/window/view/sections.ts';
import { ds, meta, rows } from '../../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

const NOW = T0;
const DAY = NS_PER_DAY;
const MIN = NS_PER_MINUTE;
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';

type Message = ReturnType<typeof buildListMessage>;

function termId(n: number): string {
  return n.toString(16).padStart(12, '0');
}

/** A terminal of the window showing `sessionId` (a resume, running), with `slot`. */
function term(n: number, sessionId: string, slot: number | null): TerminalInfo {
  return {
    id: termId(n),
    slot,
    state: 'running',
    sessionId,
    expectedSessionId: sessionId,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 4000 + n, procStart: 100 + n },
    openedNs: T0 - DAY + BigInt(n) * SEC,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
  };
}

function holder(pid: number): Holder {
  return {
    process: { bootId: BOOT_A, pid, procStart: 500 + pid },
    sinceNs: T0,
    live: null,
    scripted: false,
  };
}

/** `parkedAgo`: parked that long before NOW (the derived mark set); absent: not parked. */
interface Shape {
  title: string;
  runs?: boolean;
  pid?: number;
  ago?: Ns;
  parkedAgo?: Ns;
  state?: DerivedSession['state'];
}

function session(id: string, shape: Shape): DerivedSession {
  const { title, runs = false, pid = 9000, ago = MIN, parkedAgo, state } = shape;
  return ds({
    id,
    state: state ?? (runs ? 'running' : 'not-running'),
    holders: runs ? [holder(pid)] : [],
    lastActivityNs: NOW - ago,
    parkedAtNs: parkedAgo === undefined ? null : NOW - parkedAgo,
    parked: parkedAgo !== undefined,
    transcript: { aiTitle: title, lastUserNs: NOW - ago },
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

function rowIn(message: Message, id: string): RowPayload {
  const row = message.sections.flatMap((s) => s.rows).find((r) => r.id === id);
  assert.ok(row, `no row ${id}`);
  return row;
}

/**
 * S1 runs in terminal 1 (slot 1), parked 5 minutes ago; S2 ended, parked a minute ago; S3 nine days
 * old, parked two days ago; S4 runs in terminal 2 (slot 2), not parked; S5 ended an hour ago, not
 * parked; S6 runs in terminal 3 (slot 3), not parked.
 */
function world(): Pick<ViewInput, 'rows' | 'terminals'> {
  return {
    rows: rows([
      session(S1, { title: 'parked running', runs: true, pid: 9001, parkedAgo: 5n * MIN }),
      session(S2, { title: 'parked ended', ago: 10n * MIN, parkedAgo: MIN }),
      session(S3, { title: 'parked old', ago: 9n * DAY, parkedAgo: 2n * DAY }),
      session(S4, { title: 'open one', runs: true, pid: 9004 }),
      session(S5, { title: 'recent one', ago: 60n * MIN }),
      session(S6, { title: 'open two', runs: true, pid: 9006 }),
    ]),
    terminals: [term(1, S1, 1), term(2, S4, 2), term(3, S6, 3)],
  };
}

// --- the section -------------------------------------------------------------------------------

test('Parked is the second section on every view, and never folded whatever `unfolded` says', () => {
  const views: Partial<ViewInput['view']>[] = [
    {},
    { unfolded: ['earlier'] },
    { unfolded: ['parked' as string] },
    { showDone: true },
    { filter: 'parked' },
    { filter: 'nothing matches this' },
    { chips: ['running'] as SearchChip[] },
    { chips: ['note'] as SearchChip[] },
    { chips: ['done'] as SearchChip[], showDone: true },
  ];
  for (const view of views) {
    const message = buildListMessage(input({ ...world(), view }));
    const label = JSON.stringify(view);
    assert.deepEqual(
      message.sections.map((s) => s.name),
      ['open', 'parked', 'week', 'earlier'],
      label,
    );
    assert.equal(section(message, 'parked').folded, false, label);
  }
});

test('Parked holds every parked session — running, ended, nine days old — and no other section has them', () => {
  const message = buildListMessage(input(world()));
  assert.deepEqual(ids(message, 'parked'), [S2, S1, S3]);
  assert.equal(section(message, 'parked').count, 3);
  assert.deepEqual(ids(message, 'open'), [S4, S6]);
  assert.deepEqual(ids(message, 'week'), [S5]);
  assert.equal(section(message, 'earlier').count, 0);
  for (const name of ['open', 'week', 'earlier'] as const) {
    for (const id of [S1, S2, S3]) {
      assert.ok(!ids(message, name).includes(id), `${id} in ${name}`);
    }
  }
  // sectionOf: parked first, whatever runs or how old.
  const [s1, s2, s3] = world().rows;
  assert.ok(s1 && s2 && s3);
  assert.equal(sectionOf(s1, NOW, true), 'parked');
  assert.equal(sectionOf(s2, NOW, false), 'parked');
  assert.equal(sectionOf(s3, NOW, false), 'parked');
});

test('Parked: the most recently parked first, whatever the last activity; ties by id', () => {
  const list = rows([
    session(S3, { title: 'c', ago: MIN, parkedAgo: 3n * MIN }),
    session(S1, { title: 'a', ago: 9n * DAY, parkedAgo: 2n * MIN }),
    session(S5, { title: 'e', ago: 2n * MIN, parkedAgo: 2n * MIN }),
    session(S2, { title: 'b', ago: 5n * MIN, parkedAgo: 4n * MIN }),
  ]);
  const message = buildListMessage(input({ rows: list }));
  assert.deepEqual(ids(message, 'parked'), [S1, S5, S3, S2]);
});

test('a parked row carries `parked` and its time; an unparked one `parked` false and no time', () => {
  const message = buildListMessage(input(world()));
  assert.equal(rowIn(message, S1).parked, true);
  assert.equal(rowIn(message, S1).parkedAtNs, String(NOW - 5n * MIN));
  assert.equal(rowIn(message, S4).parked, false);
  assert.equal(rowIn(message, S4).parkedAtNs, null);
  // The stored time stays after a prompt ended the parking: the row is not parked, and carries none.
  const ended = rows([
    ds({
      id: S1,
      parkedAtNs: NOW - 5n * MIN,
      parked: false,
      transcript: { aiTitle: 'back', lastUserNs: NOW - MIN },
    }),
  ]);
  const back = buildListMessage(input({ rows: ended }));
  assert.deepEqual(ids(back, 'week'), [S1]);
  assert.equal(rowIn(back, S1).parked, false);
  assert.equal(rowIn(back, S1).parkedAtNs, null);
});

test('Parked: blocks form in it and close as in every section; its count is all its rows', () => {
  const list = rows(
    [
      session(S1, { title: 'ORB-1 one', parkedAgo: MIN }),
      session(S2, { title: 'ORB-1 two', parkedAgo: 3n * MIN }),
      session(S3, { title: 'other', parkedAgo: 2n * MIN }),
    ],
    { metas: [meta(S1, { group: 'ORB-1' }), meta(S2, { group: 'ORB-1' })] },
  );
  const open = buildListMessage(input({ rows: list }));
  assert.deepEqual(ids(open, 'parked'), [S1, S2, S3]);
  assert.deepEqual(rowIn(open, S1).stack, { group: 'ORB-1', size: 2, role: 'head', head: S1 });
  assert.deepEqual(rowIn(open, S2).stack, { group: 'ORB-1', size: 2, role: 'member', head: S1 });
  const closed = buildListMessage(
    input({ rows: list, view: { closed: [{ section: 'parked', group: 'ORB-1' }] } }),
  );
  assert.deepEqual(ids(closed, 'parked'), [S3]);
  assert.equal(section(closed, 'parked').count, 3);
  assert.deepEqual(section(closed, 'parked').closedStacks, [
    { group: 'ORB-1', size: 2, needYou: 0, head: S1, at: 0 },
  ]);
  // A block closed in Open closes nothing under Parked.
  const elsewhere = buildListMessage(
    input({ rows: list, view: { closed: [{ section: 'open', group: 'ORB-1' }] } }),
  );
  assert.deepEqual(ids(elsewhere, 'parked'), [S1, S2, S3]);
});

// --- the numbers -------------------------------------------------------------------------------

test("a parked running row has no slot, and neither has its terminal in `terminals`; Open's rows keep theirs", () => {
  const message = buildListMessage(input(world()));
  assert.equal(rowIn(message, S1).slot, null);
  assert.equal(rowIn(message, S1).terminal, termId(1));
  assert.deepEqual(
    message.terminals.map((t) => [t.id, t.slot]),
    [
      [termId(1), null],
      [termId(2), 2],
      [termId(3), 3],
    ],
  );
  assert.equal(rowIn(message, S4).slot, 2);
  assert.equal(rowIn(message, S6).slot, 3);
});

test('parkedTerminals: every terminal of a parked session, twins too, by its session or the one it was opened for', () => {
  const { rows: list } = world();
  const twin = term(4, S1, 4);
  const opening: TerminalInfo = { ...term(5, S2, null), sessionId: null, state: 'starting' };
  const other = term(6, S4, 6);
  assert.deepEqual(
    [...parkedTerminals(list, [term(1, S1, 1), twin, opening, other])].sort(),
    [termId(1), termId(4), termId(5)].sort(),
  );
  assert.deepEqual([...parkedTerminals(list, [])], []);
});

// --- Open's order (F42) ------------------------------------------------------------------------

test('a parked row is not in openRows; keptNow drops it and no other id moves', () => {
  const { rows: list, terminals } = world();
  assert.deepEqual(
    openRows({ rows: list, terminals, elsewhere: new Map(), nowNs: NOW }).map((r) => r.id),
    [S4, S6],
  );
  // S6 was moved above S4 and S1 was kept between them before it was parked.
  const kept = keptNow({
    rows: list,
    terminals,
    elsewhere: new Map(),
    nowNs: NOW,
    openOrder: [S6, S1, S4],
  });
  assert.deepEqual(kept, [S6, S4]);
  const message = buildListMessage(input({ rows: list, terminals, openOrder: [S6, S1, S4] }));
  assert.deepEqual(ids(message, 'open'), [S6, S4]);
  // Un-parked (the mark gone), it comes back as a row that was not kept: after the window's
  // terminals with a lower number; the kept rows keep their order.
  const unparked = rows([
    session(S1, { title: 'parked running', runs: true, pid: 9001 }),
    session(S4, { title: 'open one', runs: true, pid: 9004 }),
    session(S6, { title: 'open two', runs: true, pid: 9006 }),
  ]);
  const back = buildListMessage(input({ rows: unparked, terminals, openOrder: [S6, S4] }));
  const order = ids(back, 'open');
  assert.deepEqual(
    order.filter((id) => id !== S1),
    [S6, S4],
  );
  assert.ok(order.includes(S1));
});

// --- quiet (S2 12.4) ---------------------------------------------------------------------------

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

function liveOf(status: string, over: Partial<LiveStatus> = {}): LiveStatus {
  return { status, waitingFor: null, sinceNs: null, ...over };
}

/**
 * S1 asks (running, waiting), S2 ended unexpectedly, S3 finished (running, idle, an unseen turn
 * end); each in one group `G` with S4, which needs nothing. `parked`: S1, S2 and S3 are parked.
 */
function quietWorld(parked: boolean): { list: ReturnType<typeof rows>; facts: AttentionFacts } {
  const parkedAgo = parked ? MIN : undefined;
  const list = rows(
    [
      session(S1, { title: 'asks', runs: true, pid: 9001, state: 'waiting', parkedAgo }),
      session(S2, { title: 'ended', ago: 2n * MIN, parkedAgo }),
      session(S3, { title: 'finished', runs: true, pid: 9003, parkedAgo }),
      session(S4, { title: 'quiet', ago: 3n * MIN }),
    ],
    { metas: [S1, S2, S3, S4].map((id) => meta(id, { group: 'G' })) },
  );
  const facts: AttentionFacts = {
    marks: new Map([
      [S2, marksOf({ windowEndSeq: 3, windowEndNs: NOW - 5n * SEC })],
      [S3, marksOf({ turnEndedSeq: 5, turnEndedNs: NOW - 2n * SEC, seenSeq: 4 })],
    ]),
    live: new Map([
      [S1, liveOf('waiting', { waitingFor: 'permission · Bash', sinceNs: NOW - 10n * SEC })],
      [S3, liveOf('idle')],
    ]),
  };
  return { list, facts };
}

test('quiet: a parked row that asks, finished or ended keeps its attention and has needsYou false', () => {
  const { list, facts } = quietWorld(true);
  const message = buildListMessage(input({ rows: list, attention: facts }));
  assert.equal(rowIn(message, S1).attention?.reason, 'asks');
  assert.equal(rowIn(message, S2).attention?.reason, 'ended');
  assert.equal(rowIn(message, S3).attention?.reason, 'finished');
  for (const id of [S1, S2, S3, S4]) {
    assert.equal(rowIn(message, id).needsYou, false, id);
  }
  assert.deepEqual(message.needYou, { count: 0, order: [] });
  // In its state's count instead (the title bar's parts still add up).
  assert.deepEqual(message.counts, {
    working: 0,
    waiting: 1,
    running: 1,
    starting: 0,
    elsewhere: 0,
    background: 0,
    notRunning: 2,
  });
});

test('quiet: a closed block under Parked counts none of them as needing you', () => {
  const { list, facts } = quietWorld(true);
  const message = buildListMessage(
    input({ rows: list, attention: facts, view: { closed: [{ section: 'parked', group: 'G' }] } }),
  );
  assert.deepEqual(
    section(message, 'parked').closedStacks.map((c) => [c.group, c.size, c.needYou]),
    [['G', 3, 0]],
  );
});

test('un-parked, the same rows need you: needsYou true, counted, in the order and in a closed caption', () => {
  const { list, facts } = quietWorld(false);
  const message = buildListMessage(input({ rows: list, attention: facts }));
  for (const id of [S1, S2, S3]) {
    assert.equal(rowIn(message, id).needsYou, true, id);
  }
  assert.equal(rowIn(message, S4).needsYou, false);
  assert.equal(message.needYou.count, 3);
  assert.deepEqual(message.needYou.order, [S1, S2, S3]);
  assert.deepEqual(message.counts, {
    working: 0,
    waiting: 0,
    running: 0,
    starting: 0,
    elsewhere: 0,
    background: 0,
    notRunning: 1,
  });
  const closed = buildListMessage(
    input({ rows: list, attention: facts, view: { closed: [{ section: 'week', group: 'G' }] } }),
  );
  assert.deepEqual(
    section(closed, 'week').closedStacks.map((c) => [c.group, c.size, c.needYou]),
    [['G', 2, 1]],
  );
});

// --- the switcher (S2 12.8) --------------------------------------------------------------------

test('the switcher: a parked row is ranked `parked`, never `need`, after Open and before Not running, the most recently parked first', () => {
  const { list, facts } = quietWorld(true);
  const more = rows([
    session(S5, { title: 'parked long ago', ago: MIN, parkedAgo: 9n * DAY }),
    session(S6, { title: 'open', runs: true, pid: 9006 }),
  ]);
  const message = buildListMessage(
    input({ rows: [...list, ...more], attention: facts, view: { switcher: '' } }),
  );
  assert.ok(message.switcher);
  assert.deepEqual(
    message.switcher.items.map((item) => [item.rank, item.row.id]),
    [
      ['open', S6],
      ['parked', S1],
      ['parked', S2],
      ['parked', S3],
      ['parked', S5],
      ['not-running', S4],
    ],
  );
  // Ties of the parking time by id; the last activity does not order them.
  assert.ok(S1 < S2 && S2 < S3);
  // Un-parked, those that need you rank `need` again.
  const unparked = quietWorld(false);
  const back = buildListMessage(
    input({ rows: unparked.list, attention: unparked.facts, view: { switcher: '' } }),
  );
  assert.ok(back.switcher);
  assert.deepEqual(
    back.switcher.items.filter((item) => item.rank === 'need').map((item) => item.row.id),
    [S1, S2, S3],
  );
});
