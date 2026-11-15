import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { Ns } from '../../../src/platform/types.ts';
import type { DerivedSession, Holder } from '../../../src/sessions/types.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type { RowPayload, SectionPayload, SelectedPayload } from '../../../src/window/protocol.ts';
import { attentionOf, NO_ATTENTION } from '../../../src/window/view/attention.ts';
import type {
  AttentionFacts,
  AttentionMarks,
  LiveStatus,
} from '../../../src/window/view/attention.ts';
import { buildListMessage } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import { projectDirs } from '../../../src/window/view/sections.ts';
import { attached, ds, meta, prRow, rows } from '../../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

const NOW = T0;
const DAY = NS_PER_DAY;
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';
const NEW = '6b1f9c7e-4d8a-4fca-9c9d-8e7f6a5b4c3d';

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

function section(
  message: ReturnType<typeof buildListMessage>,
  name: SectionPayload['name'],
): SectionPayload {
  const found = message.sections.find((s) => s.name === name);
  assert.ok(found, `no section ${name}`);
  return found;
}

function ids(message: ReturnType<typeof buildListMessage>, name: SectionPayload['name']): string[] {
  return section(message, name).rows.map((row) => row.id);
}

function rowIn(message: ReturnType<typeof buildListMessage>, id: string): RowPayload {
  const row = message.sections.flatMap((s) => s.rows).find((r) => r.id === id);
  assert.ok(row, `no row ${id}`);
  return row;
}

// --- the message -------------------------------------------------------------------------------

test('buildListMessage: a list message with the three sections in order, no banner', () => {
  const message = buildListMessage(input({ rows: rows([ds({ id: S1 })]) }));
  assert.equal(message.t, 'list');
  assert.equal(message.nowNs, String(NOW));
  assert.equal(message.banner, null);
  assert.deepEqual(
    message.sections.map((s) => s.name),
    ['open', 'week', 'earlier'],
  );
  assert.equal(message.selected, null);
});

test('buildListMessage: empty input gives empty sections and zero counts', () => {
  const message = buildListMessage(input({}));
  for (const s of message.sections) {
    assert.equal(s.count, 0);
    assert.deepEqual(s.rows, []);
    assert.equal(s.firstNs, null);
    assert.equal(s.lastNs, null);
  }
  assert.deepEqual(message.counts, {
    working: 0,
    waiting: 0,
    running: 0,
    starting: 0,
    elsewhere: 0,
    notRunning: 0,
  });
  assert.equal(message.doneHidden, 0);
  assert.deepEqual(message.terminals, []);
  assert.deepEqual(message.dirs, []);
});

test('buildListMessage: the message survives JSON unchanged (no bigint anywhere)', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1), ds({ id: S2, lastActivityNs: NOW - 30n * DAY })]),
      terminals: [term(1, { expectedSessionId: S1, slot: 1 })],
      view: { unfolded: ['earlier'] },
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
});

test('buildListMessage: does not change its input', () => {
  const list = rows([ds({ id: S2, lastActivityNs: NOW - DAY }), ds({ id: S1 })]);
  const before = list.map((row) => row.id);
  const terminals = [
    term(2, { expectedSessionId: S2, slot: 2 }),
    term(1, { expectedSessionId: S1, slot: 1 }),
  ];
  buildListMessage(input({ rows: list, terminals }));
  assert.deepEqual(
    list.map((row) => row.id),
    before,
  );
  assert.deepEqual(
    terminals.map((t) => t.id),
    [termId(2), termId(1)],
  );
});

// --- sections ----------------------------------------------------------------------------------

test('sections: running rows are in Open, in the window or elsewhere', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        running(S1, { lastActivityNs: NOW - 30n * DAY }),
        running(S2, { state: 'waiting' }),
        running(S3, { state: 'running' }),
      ]),
      terminals: [term(1, { expectedSessionId: S1, slot: 1 })],
      elsewhere: new Map([[S2, { pid: 9000, tty: '/dev/pts/3' }]]),
    }),
  );
  assert.deepEqual(new Set(ids(message, 'open')), new Set([S1, S2, S3]));
  assert.deepEqual(ids(message, 'week'), []);
  assert.deepEqual(ids(message, 'earlier'), []);
});

test('sections: not running and active within 7 days → This week, the most recent first', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1, lastActivityNs: NOW - 6n * DAY }),
        ds({ id: S2, lastActivityNs: NOW - SEC }),
        ds({ id: S3, lastActivityNs: NOW - 2n * DAY }),
      ]),
    }),
  );
  assert.deepEqual(ids(message, 'week'), [S2, S3, S1]);
  const week = section(message, 'week');
  assert.equal(week.folded, false);
  assert.equal(week.count, 3);
  assert.equal(week.firstNs, String(NOW - 6n * DAY));
  assert.equal(week.lastNs, String(NOW - SEC));
  assert.deepEqual(ids(message, 'open'), []);
});

test('sections: older → Earlier, folded by default with its count and time span, no rows', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1, lastActivityNs: NOW - 8n * DAY }),
        ds({ id: S2, lastActivityNs: NOW - 90n * DAY }),
        ds({ id: S3, lastActivityNs: NOW - 20n * DAY }),
      ]),
    }),
  );
  const earlier = section(message, 'earlier');
  assert.equal(earlier.folded, true);
  assert.equal(earlier.count, 3);
  assert.equal(earlier.firstNs, String(NOW - 90n * DAY));
  assert.equal(earlier.lastNs, String(NOW - 8n * DAY));
  assert.deepEqual(earlier.rows, []);
});

test('sections: Earlier unfolded when the view names it, the most recent first', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1, lastActivityNs: NOW - 8n * DAY }),
        ds({ id: S2, lastActivityNs: NOW - 90n * DAY }),
        ds({ id: S3, lastActivityNs: NOW - 20n * DAY }),
      ]),
      view: { unfolded: ['earlier'] },
    }),
  );
  const earlier = section(message, 'earlier');
  assert.equal(earlier.folded, false);
  assert.equal(earlier.count, 3);
  assert.deepEqual(ids(message, 'earlier'), [S1, S3, S2]);
});

test('sections: Open and This week are never folded', () => {
  const message = buildListMessage(
    input({ rows: rows([running(S1), ds({ id: S2 })]), view: { unfolded: [] } }),
  );
  assert.equal(section(message, 'open').folded, false);
  assert.equal(section(message, 'week').folded, false);
});

test('sections: rows active at the same time are ordered by id', () => {
  const message = buildListMessage(input({ rows: rows([ds({ id: S3 }), ds({ id: S1 })]) }));
  assert.deepEqual(ids(message, 'week'), [S1, S3]);
});

// --- Open's order ------------------------------------------------------------------------------

test('open order: slots 1, 2, 3 by slot, whatever their activity', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        running(S1, { lastActivityNs: NOW - 3n * SEC }),
        running(S2, { lastActivityNs: NOW - 1n * SEC }),
        running(S3, { lastActivityNs: NOW - 2n * SEC }),
      ]),
      terminals: [
        term(1, { expectedSessionId: S2, slot: 3 }),
        term(2, { expectedSessionId: S3, slot: 1 }),
        term(3, { expectedSessionId: S1, slot: 2 }),
      ],
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S3, S1, S2]);
  assert.deepEqual(
    section(message, 'open').rows.map((row) => row.slot),
    [1, 2, 3],
  );
});

test('open order: terminals without a slot after the slots, by opening time', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1), running(S2), running(S3), running(S4)]),
      terminals: [
        term(1, { expectedSessionId: S1, slot: null, openedNs: T0 - 5n * SEC }),
        term(2, { expectedSessionId: S2, slot: 9 }),
        term(3, { expectedSessionId: S3, slot: null, openedNs: T0 - 9n * SEC }),
        term(4, { expectedSessionId: S4, slot: 1 }),
      ],
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S4, S2, S3, S1]);
});

test('open order: sessions running elsewhere last, by the time their process started', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        running(S1, { pid: 300, procStart: 3000 }),
        running(S2, { pid: 100, procStart: 1000 }),
        running(S3),
        running(S4, { pid: 200, procStart: 2000 }),
      ]),
      terminals: [term(1, { expectedSessionId: S3, slot: null })],
      elsewhere: new Map([
        [S1, { pid: 300, tty: null }],
        [S2, { pid: 100, tty: null }],
        [S4, { pid: 200, tty: null }],
      ]),
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S3, S2, S4, S1]);
});

test('open order: does not change when activity or state changes', () => {
  const sessions = (shift: Ns): DerivedSession[] => [
    running(S1, { lastActivityNs: NOW - shift, state: shift > 0n ? 'waiting' : 'working' }),
    running(S2, { lastActivityNs: NOW - 10n * SEC + shift, pid: 20, procStart: 20 }),
    running(S3, { lastActivityNs: NOW - 5n * SEC, pid: 10, procStart: 10 }),
    running(S4, { lastActivityNs: NOW - 2n * SEC + shift }),
  ];
  const build = (shift: Ns) =>
    ids(
      buildListMessage(
        input({
          rows: rows(sessions(shift)),
          terminals: [
            term(1, { expectedSessionId: S4, slot: 2 }),
            term(2, { expectedSessionId: S1, slot: 1 }),
          ],
          elsewhere: new Map([
            [S2, { pid: 20, tty: null }],
            [S3, { pid: 10, tty: null }],
          ]),
        }),
      ),
      'open',
    );
  assert.deepEqual(build(0n), [S1, S4, S3, S2]);
  assert.deepEqual(build(9n * SEC), [S1, S4, S3, S2]);
});

test('open order: a running row the mapping does not place is ordered with the elsewhere ones', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1, { pid: 1, procStart: 1 }), running(S2, { pid: 50, procStart: 50 })]),
      elsewhere: new Map([[S2, { pid: 50, tty: null }]]),
    }),
  );
  // Both are ordered by process start: the rule does not depend on the mapping.
  assert.deepEqual(ids(message, 'open'), [S1, S2]);
  assert.equal(rowIn(message, S1).elsewhere, null);
  assert.equal(message.counts.working, 1);
  assert.equal(message.counts.elsewhere, 1);
});

test('open order: a holder whose process start is unknown comes last', () => {
  const unknown = running(S1, { holders: [holder(1, null)] });
  const known = running(S2, { pid: 999, procStart: 999 });
  for (const list of [
    [unknown, known],
    [known, unknown],
  ]) {
    assert.deepEqual(ids(buildListMessage(input({ rows: rows(list) })), 'open'), [S2, S1]);
  }
});

test('open order: a session running elsewhere is not placed by an ended terminal of the window', () => {
  // S1 exited in the window's terminal, then the user resumed it by hand in another terminal.
  const message = buildListMessage(
    input({
      rows: rows([
        running(S1, { pid: 5000, procStart: 5000 }),
        running(S2, { pid: 10, procStart: 10 }),
      ]),
      terminals: [
        term(1, {
          expectedSessionId: S1,
          sessionId: S1,
          state: 'ended',
          slot: 1,
          exit: { code: 0, signal: null, atNs: String(NOW), notStarted: null },
        }),
      ],
      elsewhere: new Map([
        [S1, { pid: 5000, tty: '/dev/pts/9' }],
        [S2, { pid: 10, tty: null }],
      ]),
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S2, S1]);
  const row = rowIn(message, S1);
  assert.equal(row.terminal, null);
  assert.equal(row.slot, null);
  assert.deepEqual(row.elsewhere, { pid: 5000, tty: '/dev/pts/9', dir: '/home/dev/projects/demo' });
  assert.equal(message.counts.elsewhere, 2);
});

// --- rows tied to terminals --------------------------------------------------------------------

test('rows: a terminal showing a session gives that row its terminal and slot', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1)]),
      terminals: [term(1, { expectedSessionId: S1, slot: 4 })],
    }),
  );
  const row = rowIn(message, S1);
  assert.equal(row.terminal, termId(1));
  assert.equal(row.slot, 4);
  assert.equal(row.starting, false);
  assert.equal(row.elsewhere, null);
});

test('rows: after /clear the terminal is on the new session’s row, the old one has none', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1 }), running(S2)]),
      terminals: [term(1, { expectedSessionId: S1, sessionId: S2, slot: 1 })],
    }),
  );
  assert.equal(rowIn(message, S2).terminal, termId(1));
  assert.equal(rowIn(message, S2).slot, 1);
  assert.equal(rowIn(message, S1).terminal, null);
  assert.equal(rowIn(message, S1).starting, false);
  assert.deepEqual(ids(message, 'open'), [S2]);
  assert.deepEqual(ids(message, 'week'), [S1]);
});

test('rows: an ended terminal stays on its row, which is no longer open', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1, lastActivityNs: NOW - SEC })]),
      terminals: [
        term(1, {
          expectedSessionId: S1,
          state: 'ended',
          slot: 1,
          exit: { code: 0, signal: null, atNs: String(NOW), notStarted: null },
        }),
      ],
    }),
  );
  assert.deepEqual(ids(message, 'open'), []);
  assert.deepEqual(ids(message, 'week'), [S1]);
  assert.equal(rowIn(message, S1).terminal, termId(1));
  assert.equal(rowIn(message, S1).starting, false);
});

test('rows: the terminal showing a session wins over one starting for it, then the lower slot', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1)]),
      terminals: [
        term(1, { expectedSessionId: S1, sessionId: null, slot: 1 }),
        term(2, { expectedSessionId: S1, slot: 3 }),
        term(3, { expectedSessionId: S1, slot: 2 }),
      ],
    }),
  );
  assert.equal(rowIn(message, S1).terminal, termId(3));
  assert.equal(rowIn(message, S1).slot, 2);
  assert.equal(message.terminals.length, 3);
});

test('rows: elsewhere carries the pid and tty from the mapping', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1)]),
      elsewhere: new Map([[S1, { pid: 9000, tty: '/dev/pts/7' }]]),
    }),
  );
  assert.deepEqual(rowIn(message, S1).elsewhere, {
    pid: 9000,
    tty: '/dev/pts/7',
    dir: '/home/dev/projects/demo',
  });
  assert.equal(rowIn(message, S1).terminal, null);
});

test('rows: an elsewhere entry for a row that is not running is ignored', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1 })]),
      elsewhere: new Map([[S1, { pid: 9000, tty: null }]]),
    }),
  );
  assert.equal(rowIn(message, S1).elsewhere, null);
  assert.deepEqual(ids(message, 'week'), [S1]);
  assert.equal(message.counts.elsewhere, 0);
  assert.equal(message.counts.notRunning, 1);
});

test('rows: attention and stack are null', () => {
  const message = buildListMessage(input({ rows: rows([running(S1), ds({ id: S2 })]) }));
  for (const row of message.sections.flatMap((s) => s.rows)) {
    assert.equal(row.attention, null);
    assert.equal(row.stack, null);
  }
});

// --- starting ----------------------------------------------------------------------------------

test('starting: a resume terminal without a session yet marks the expected row, under Open', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1, lastActivityNs: NOW - 20n * DAY })]),
      terminals: [term(1, { expectedSessionId: S1, sessionId: null, state: 'starting', slot: 1 })],
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1]);
  const row = rowIn(message, S1);
  assert.equal(row.starting, true);
  assert.equal(row.terminal, termId(1));
  assert.equal(row.slot, 1);
  assert.equal(row.state, 'not-running');
  assert.equal(section(message, 'earlier').count, 0);
});

test('starting: a terminal not reported for a while is still starting and stays where it is', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1 }), running(S2)]),
      terminals: [
        term(1, { expectedSessionId: S1, sessionId: null, slot: 1, notReported: true }),
        term(2, { expectedSessionId: S2, slot: 2 }),
      ],
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1, S2]);
  assert.equal(rowIn(message, S1).starting, true);
  assert.equal(message.terminals.find((t) => t.id === termId(1))?.notReported, true);
});

test('starting: a starting row of a done session shows under Open with its done mark', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1, hidden: true, doneAtNs: T0 - DAY })]),
      terminals: [term(1, { expectedSessionId: S1, sessionId: null, slot: 1 })],
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1]);
  assert.equal(rowIn(message, S1).done, true);
  assert.equal(message.doneHidden, 0);
});

test('starting: a new terminal without a session row gives a row of its own, titled with the label', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1)]),
      terminals: [
        term(1, { expectedSessionId: S1, slot: 1 }),
        term(2, {
          expectedSessionId: NEW,
          sessionId: null,
          kind: 'new',
          label: 'fix',
          dir: '/home/dev/projects/other',
          state: 'starting',
          slot: 2,
          openedNs: NOW - 2n * SEC,
        }),
      ],
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1, NEW]);
  const row = rowIn(message, NEW);
  assert.equal(row.shortId, NEW.slice(0, 8));
  assert.equal(row.title, 'fix');
  assert.equal(row.titleSource, 'label');
  assert.equal(row.starting, true);
  assert.equal(row.terminal, termId(2));
  assert.equal(row.slot, 2);
  assert.equal(row.state, 'not-running');
  assert.equal(row.dir, '/home/dev/projects/other');
  assert.equal(row.sinceNs, String(NOW - 2n * SEC));
  assert.equal(row.lastActivityNs, String(NOW - 2n * SEC));
  assert.equal(row.group, null);
  assert.deepEqual(row.marks, []);
  assert.equal(row.hasNote, false);
  assert.equal(row.done, false);
  assert.deepEqual(row.prs, []);
  assert.equal(row.chip, null);
  assert.equal(row.elsewhere, null);
  assert.equal(message.counts.starting, 1);
});

test('starting: a new terminal without a label is titled "new session in <dir>"', () => {
  const message = buildListMessage(
    input({
      terminals: [
        term(1, {
          expectedSessionId: NEW,
          sessionId: null,
          kind: 'new',
          label: null,
          dir: '/home/dev/projects/other',
          slot: 1,
        }),
      ],
    }),
  );
  const row = rowIn(message, NEW);
  assert.equal(row.title, 'new session in /home/dev/projects/other');
  assert.equal(row.titleSource, 'fallback');
});

test("starting: a new terminal's label and directory are sanitised", () => {
  const message = buildListMessage(
    input({
      terminals: [
        term(1, {
          expectedSessionId: NEW,
          sessionId: null,
          kind: 'new',
          label: '\x1b]0;pwned\x07fix\x1b[2J',
          dir: '/home/dev/odd\x1b[31mdir',
          slot: 1,
        }),
        term(2, {
          expectedSessionId: S1,
          sessionId: null,
          kind: 'new',
          label: '\x1b[2J  ',
          dir: '/home/dev/x\ny',
          slot: 2,
        }),
      ],
    }),
  );
  assert.equal(rowIn(message, NEW).title, 'fix');
  assert.equal(rowIn(message, NEW).dir, '/home/dev/odddir');
  assert.equal(rowIn(message, S1).title, 'new session in /home/dev/x y');
  assert.equal(rowIn(message, S1).titleSource, 'fallback');
});

test('starting: once the new session has a row, that row (not starting once its program holds it)', () => {
  const newTerminal = (sessionId: string | null) =>
    term(1, {
      expectedSessionId: NEW,
      sessionId,
      kind: 'new',
      label: 'fix',
      slot: 1,
    });
  const withRow = rows([running(NEW, { transcript: null })], {
    metas: [meta(NEW, { label: 'fix the bug' })],
  });
  const shown = buildListMessage(input({ rows: withRow, terminals: [newTerminal(NEW)] }));
  assert.deepEqual(ids(shown, 'open'), [NEW]);
  assert.equal(rowIn(shown, NEW).title, 'fix the bug');
  assert.equal(rowIn(shown, NEW).state, 'working');
  assert.equal(rowIn(shown, NEW).starting, false);
  assert.equal(rowIn(shown, NEW).terminal, termId(1));
  // A row of the new id that is not running yet, its terminal still without a session: starting.
  const notYet = buildListMessage(
    input({
      rows: rows([ds({ id: NEW, transcript: { aiTitle: 'from the transcript' } })]),
      terminals: [newTerminal(null)],
    }),
  );
  assert.deepEqual(ids(notYet, 'open'), [NEW]);
  assert.equal(rowIn(notYet, NEW).title, 'from the transcript');
  assert.equal(rowIn(notYet, NEW).starting, true);
});

test('starting: a new terminal that ended before its session started keeps its row, not starting', () => {
  const message = buildListMessage(
    input({
      terminals: [
        term(1, {
          expectedSessionId: NEW,
          sessionId: null,
          kind: 'new',
          label: 'fix',
          state: 'ended',
          slot: 1,
          openedNs: NOW - 60n * SEC,
          exit: { code: 127, signal: null, atNs: String(NOW), notStarted: null },
        }),
      ],
    }),
  );
  assert.deepEqual(ids(message, 'open'), []);
  assert.deepEqual(ids(message, 'week'), [NEW]);
  const row = rowIn(message, NEW);
  assert.equal(row.starting, false);
  assert.equal(row.terminal, termId(1));
  assert.equal(message.counts.notRunning, 1);
});

test('starting: a resume terminal whose session has no row gives no row', () => {
  const message = buildListMessage(
    input({ terminals: [term(1, { expectedSessionId: S1, sessionId: null, slot: 1 })] }),
  );
  assert.deepEqual(
    message.sections.flatMap((s) => s.rows),
    [],
  );
  assert.equal(message.terminals.length, 1);
});

test('starting: a live terminal wins over an ended one of the same session (resumed again)', () => {
  const ended = (sessionId: string | null) =>
    term(1, {
      expectedSessionId: S1,
      sessionId,
      state: 'ended',
      slot: 1,
      exit: { code: 0, signal: null, atNs: String(NOW), notStarted: null },
    });
  const again = term(2, { expectedSessionId: S1, sessionId: null, state: 'starting', slot: 2 });
  for (const endedShows of [null, S1]) {
    const message = buildListMessage(
      input({ rows: rows([ds({ id: S1 })]), terminals: [ended(endedShows), again] }),
    );
    assert.deepEqual(ids(message, 'open'), [S1], String(endedShows));
    const row = rowIn(message, S1);
    assert.equal(row.terminal, termId(2), String(endedShows));
    assert.equal(row.slot, 2);
    assert.equal(row.starting, true);
    assert.equal(message.counts.starting, 1);
  }
  // Once the second terminal's program holds the session, it still wins over the ended one.
  const holding = buildListMessage(
    input({
      rows: rows([running(S1)]),
      terminals: [ended(S1), term(2, { expectedSessionId: S1, slot: 2 })],
    }),
  );
  assert.equal(rowIn(holding, S1).terminal, termId(2));
  assert.equal(rowIn(holding, S1).slot, 2);
});

test('starting: a new terminal keeps its row when the session has a row step 1 does not list', () => {
  // `claude` started (so the session has events), then ended before any prompt: no transcript.
  const newSession = ds({ id: NEW, transcript: null, lastActivityNs: NOW - SEC });
  const ended = term(1, {
    expectedSessionId: NEW,
    sessionId: null,
    kind: 'new',
    label: 'fix',
    state: 'ended',
    slot: 1,
    exit: { code: 0, signal: null, atNs: String(NOW), notStarted: null },
  });
  const message = buildListMessage(input({ rows: rows([newSession]), terminals: [ended] }));
  assert.deepEqual(ids(message, 'week'), [NEW]);
  assert.equal(rowIn(message, NEW).terminal, termId(1));
  assert.equal(rowIn(message, NEW).starting, false);
  assert.equal(message.counts.notRunning, 1);
  // A row of that session marked done is hidden as any done row that stopped.
  const done = buildListMessage(
    input({
      rows: rows([ds({ id: NEW, transcript: null, hidden: true, doneAtNs: T0 })]),
      terminals: [ended],
    }),
  );
  assert.deepEqual(
    done.sections.flatMap((s) => s.rows),
    [],
  );
  assert.equal(done.doneHidden, 1);
  // With done sessions shown, it is listed with its terminal.
  const shownDone = buildListMessage(
    input({
      rows: rows([ds({ id: NEW, transcript: null, hidden: true, doneAtNs: T0 })]),
      terminals: [ended],
      view: { showDone: true },
    }),
  );
  assert.deepEqual(ids(shownDone, 'week'), [NEW]);
  assert.equal(rowIn(shownDone, NEW).terminal, termId(1));
  assert.equal(rowIn(shownDone, NEW).done, true);
  assert.equal(shownDone.doneHidden, 0);
});

// --- done --------------------------------------------------------------------------------------

test('done: hidden, counted in doneHidden', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1, hidden: true, doneAtNs: T0 }),
        ds({ id: S2, hidden: true, doneAtNs: T0, lastActivityNs: NOW - 30n * DAY }),
        ds({ id: S3 }),
      ]),
    }),
  );
  assert.deepEqual(ids(message, 'week'), [S3]);
  assert.equal(section(message, 'earlier').count, 0);
  assert.equal(message.doneHidden, 2);
});

test('done: showDone lists them in their sections, and nothing is hidden', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1, hidden: true, doneAtNs: T0 }),
        ds({ id: S2, hidden: true, doneAtNs: T0, lastActivityNs: NOW - 30n * DAY }),
        ds({ id: S3, lastActivityNs: NOW - SEC }),
      ]),
      view: { showDone: true, unfolded: ['earlier'] },
    }),
  );
  assert.deepEqual(ids(message, 'week'), [S1, S3]);
  assert.deepEqual(ids(message, 'earlier'), [S2]);
  assert.equal(rowIn(message, S1).done, true);
  assert.equal(message.doneHidden, 0);
});

test('done: a running done session stays under Open with its done mark (S2 12.10)', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1, { hidden: true, doneAtNs: T0 })]),
      terminals: [term(1, { expectedSessionId: S1, slot: 1 })],
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1]);
  assert.equal(rowIn(message, S1).done, true);
  assert.equal(message.doneHidden, 0);
  assert.equal(message.counts.working, 1);
});

test('done: a done session running elsewhere stays under Open too', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1, { hidden: true, doneAtNs: T0 })]),
      elsewhere: new Map([[S1, { pid: 9000, tty: null }]]),
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1]);
  assert.equal(message.doneHidden, 0);
});

test('done: once it stops, a done session is hidden, even while its ended terminal is there', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1, hidden: true, doneAtNs: T0 })]),
      terminals: [term(1, { expectedSessionId: S1, state: 'ended', slot: 1 })],
    }),
  );
  assert.deepEqual(
    message.sections.flatMap((s) => s.rows),
    [],
  );
  assert.equal(message.doneHidden, 1);
});

test('listed: sessions step 1 does not list are not listed (an expired one with nothing attached)', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1, marks: ['expired'] }),
        ds({ id: S2, transcript: null }),
        ds({ id: S3, transcript: { entrypoint: 'sdk-ts' } }),
        ds({ id: S4 }),
      ]),
      view: { showDone: true },
    }),
  );
  assert.deepEqual(ids(message, 'week'), [S4]);
  assert.equal(message.doneHidden, 0);
  assert.equal(message.counts.notRunning, 1);
});

// --- filter ------------------------------------------------------------------------------------

test('filter: design 7.4 — title, group, note, directory, pull requests; case-insensitive', () => {
  const pr = prRow('acme/web', 4711);
  const list = rows(
    [
      ds({ id: S1, transcript: { aiTitle: 'Refactor the parser' } }),
      ds({ id: S2 }),
      ds({ id: S3 }),
      ds({ id: S4, dir: '/home/dev/projects/zebra' }),
      ds({ id: S5 }),
      ds({ id: S6, transcript: { aiTitle: 'Unrelated' } }),
    ],
    {
      metas: [meta(S2, { group: 'Infra' }), meta(S3, { note: 'remember the PARSER\nsecond' })],
      prs: [pr],
      sessionPrs: [attached(S5, pr)],
    },
  );
  const filtered = (filter: string) =>
    ids(buildListMessage(input({ rows: list, view: { filter } })), 'week').sort();
  assert.deepEqual(filtered('parser'), [S1, S3].sort());
  assert.deepEqual(filtered('INFRA'), [S2]);
  assert.deepEqual(filtered('zebra'), [S4]);
  assert.deepEqual(filtered('acme/web#4711'), [S5]);
  assert.deepEqual(filtered('4711'), [S5]);
  assert.deepEqual(filtered(''), [S1, S2, S3, S4, S5, S6].sort());
});

test('filter: applies to Open and Earlier too, and the counts of the sections follow it', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        running(S1, { transcript: { aiTitle: 'keep me' } }),
        running(S2, { transcript: { aiTitle: 'drop me' } }),
        ds({ id: S3, lastActivityNs: NOW - 30n * DAY, transcript: { aiTitle: 'keep old' } }),
        ds({ id: S4, lastActivityNs: NOW - 30n * DAY, transcript: { aiTitle: 'drop old' } }),
      ]),
      view: { filter: 'keep' },
    }),
  );
  assert.deepEqual(ids(message, 'open'), [S1]);
  assert.equal(section(message, 'earlier').count, 1);
  assert.deepEqual(ids(message, 'earlier'), [S3]);
});

test('filter: while a filter is set every section is unfolded (S2 12.8, ruled)', () => {
  const list = rows([
    ds({ id: S1, lastActivityNs: NOW - 30n * DAY, transcript: { aiTitle: 'parser old' } }),
    ds({ id: S2, lastActivityNs: NOW - 60n * DAY, transcript: { aiTitle: 'parser older' } }),
    ds({ id: S3, transcript: { aiTitle: 'parser new' } }),
  ]);
  const filtered = buildListMessage(input({ rows: list, view: { filter: 'parser' } }));
  for (const s of filtered.sections) {
    assert.equal(s.folded, false, s.name);
  }
  assert.deepEqual(ids(filtered, 'earlier'), [S1, S2]);
  assert.equal(section(filtered, 'earlier').count, 2);
  // Without a filter, Earlier folds again (the view did not unfold it).
  const plain = buildListMessage(input({ rows: list, view: { filter: '' } }));
  assert.equal(section(plain, 'earlier').folded, true);
  assert.deepEqual(section(plain, 'earlier').rows, []);
  assert.equal(section(plain, 'earlier').count, 2);
});

test('filter: the title bar counts do not depend on the filter', () => {
  const list = rows([
    running(S1, { transcript: { aiTitle: 'alpha' } }),
    running(S2, { state: 'waiting', transcript: { aiTitle: 'beta' } }),
    ds({ id: S3, transcript: { aiTitle: 'gamma' } }),
  ]);
  const all = buildListMessage(input({ rows: list }));
  const filtered = buildListMessage(input({ rows: list, view: { filter: 'gamma' } }));
  assert.deepEqual(filtered.counts, all.counts);
  assert.deepEqual(ids(filtered, 'open'), []);
});

test('filter: does not show done sessions in stage A; doneHidden counts the matching ones', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1, hidden: true, doneAtNs: T0, transcript: { aiTitle: 'parser done' } }),
        ds({ id: S2, hidden: true, doneAtNs: T0, transcript: { aiTitle: 'other done' } }),
        ds({ id: S3, transcript: { aiTitle: 'parser open' } }),
      ]),
      view: { filter: 'parser' },
    }),
  );
  assert.deepEqual(ids(message, 'week'), [S3]);
  assert.equal(message.doneHidden, 1);
  const shown = buildListMessage(
    input({
      rows: rows([ds({ id: S1, hidden: true, doneAtNs: T0, transcript: { aiTitle: 'parser' } })]),
      view: { filter: 'parser', showDone: true },
    }),
  );
  assert.deepEqual(ids(shown, 'week'), [S1]);
});

test('filter: a new terminal’s own row is matched by its title and directory', () => {
  const terminals = [
    term(1, {
      expectedSessionId: NEW,
      sessionId: null,
      kind: 'new',
      label: 'fix login',
      dir: '/home/dev/projects/shop',
      slot: 1,
    }),
  ];
  const build = (filter: string) =>
    ids(buildListMessage(input({ terminals, view: { filter } })), 'open');
  assert.deepEqual(build('LOGIN'), [NEW]);
  assert.deepEqual(build('shop'), [NEW]);
  assert.deepEqual(build('nothing'), []);
});

// --- counts ------------------------------------------------------------------------------------

test('counts: per state of the listed rows, starting and elsewhere separately', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        running(S1, { state: 'working' }),
        running(S2, { state: 'waiting' }),
        running(S3, { state: 'running' }),
        running(S4, { state: 'working' }),
        ds({ id: S5 }),
        ds({ id: S6, lastActivityNs: NOW - 30n * DAY }),
        ds({ id: NEW, hidden: true, doneAtNs: T0 }),
      ]),
      terminals: [
        term(1, { expectedSessionId: S1, slot: 1 }),
        term(2, { expectedSessionId: S2, slot: 2 }),
        term(3, { expectedSessionId: S3, slot: 3 }),
        term(4, { expectedSessionId: S5, sessionId: null, slot: 4 }),
      ],
      elsewhere: new Map([[S4, { pid: 9000, tty: null }]]),
    }),
  );
  assert.deepEqual(message.counts, {
    working: 1,
    waiting: 1,
    running: 1,
    starting: 1,
    elsewhere: 1,
    notRunning: 1,
  });
});

test('counts: every listed row counts once, folded Earlier included, hidden done ones not', () => {
  const message = buildListMessage(
    input({
      rows: rows([
        ds({ id: S1 }),
        ds({ id: S2, lastActivityNs: NOW - 30n * DAY }),
        ds({ id: S3, lastActivityNs: NOW - 60n * DAY }),
        ds({ id: S4, hidden: true, doneAtNs: T0 }),
      ]),
    }),
  );
  assert.equal(message.counts.notRunning, 3);
  const withDone = buildListMessage(
    input({
      rows: rows([ds({ id: S1 }), ds({ id: S4, hidden: true, doneAtNs: T0 })]),
      view: { showDone: true },
    }),
  );
  assert.equal(withDone.counts.notRunning, 2);
});

// --- terminals ---------------------------------------------------------------------------------

test('terminals: each carries its id, slot, session, state, notReported, size and when it was opened, no ownsSize', () => {
  const message = buildListMessage(
    input({
      rows: rows([running(S1), ds({ id: S2 })]),
      terminals: [
        term(1, { expectedSessionId: S1, slot: 1, state: 'reconnecting', cols: 120, rows: 40 }),
        term(2, {
          expectedSessionId: S2,
          sessionId: null,
          slot: null,
          state: 'starting',
          notReported: true,
        }),
      ],
    }),
  );
  assert.deepEqual(message.terminals, [
    {
      id: termId(1),
      slot: 1,
      sessionId: S1,
      state: 'reconnecting',
      notReported: false,
      cols: 120,
      rows: 40,
      openedNs: String(T0 - DAY + SEC),
    },
    {
      id: termId(2),
      slot: null,
      sessionId: null,
      state: 'starting',
      notReported: true,
      cols: 80,
      rows: 24,
      openedNs: String(T0 - DAY + 2n * SEC),
    },
  ]);
});

test("rows: a row's chip is the window's (S2 12.3) and each pull request carries its last read", () => {
  const failing = prRow('acme/web', 7, { checks: 'failing' });
  const merged = prRow('acme/api', 30, { state: 'merged' });
  const prs = [failing, merged];
  const message = buildListMessage(
    input({ rows: rows([ds({ id: S1 })], { prs, sessionPrs: prs.map((pr) => attached(S1, pr)) }) }),
  );
  const row = rowIn(message, S1);
  assert.deepEqual(row.chip, { level: 'checks-failing', open: 1, merged: 1 });
  assert.deepEqual(
    row.prs.map((pr) => pr.okAtNs),
    [String(T0), String(T0)],
  );
});

// --- selected and dirs -------------------------------------------------------------------------

const CARD: SelectedPayload = {
  sessionId: S1,
  command: "cd /home/dev/projects/demo && claude --resume '0b5f3c1e'",
  flagsKnown: true,
  unknownFlags: [],
  ended: 'exited',
  expiring: false,
  expired: false,
  note: 'a note\r\nas stored',
  noteTooLong: false,
  ticketUrl: null,
};

test("selected: the resume card of the view's selected session", () => {
  const message = buildListMessage(
    input({ rows: rows([ds({ id: S1 })]), selected: CARD, view: { selected: S1 } }),
  );
  assert.deepEqual(message.selected, CARD);
});

test('selected: a card for another session than the selected one is not sent', () => {
  const list = rows([ds({ id: S1 }), ds({ id: S2 })]);
  const other = buildListMessage(input({ rows: list, selected: CARD, view: { selected: S2 } }));
  assert.equal(other.selected, null);
  const none = buildListMessage(input({ rows: list, selected: CARD, view: { selected: null } }));
  assert.equal(none.selected, null);
});

test('dirs: the known project directories, as projectDirs gives them', () => {
  const list = rows([
    ds({ id: S1, dir: '/home/dev/a', lastActivityNs: NOW - DAY }),
    ds({ id: S2, dir: '/home/dev/b', hidden: true, doneAtNs: T0 }),
  ]);
  const message = buildListMessage(input({ rows: list }));
  assert.deepEqual(message.dirs, projectDirs(list));
  assert.deepEqual(message.dirs, ['/home/dev/b', '/home/dev/a']);
});

// --- needs nothing but its input ---------------------------------------------------------------

test("src/window/view/ imports values only from text, the two list functions of A8, D4's CHIP_ORDER and windowChip, and B's attention", () => {
  const dir = join(import.meta.dirname, '../../../src/window/view');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  assert.deepEqual(files.sort(), [
    'attention.ts',
    'banner.ts',
    'build.ts',
    'chip.ts',
    'sections.ts',
  ]);
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+'([^']+)';/gms)];
    for (const [, isType, what, from] of imports) {
      if (isType !== undefined) {
        continue;
      }
      const names = (what ?? '').replace(/[{}\s]/g, '').split(',');
      const allowed =
        from === './sections.ts' ||
        from === './attention.ts' ||
        (from === './chip.ts' && names.every((n) => n === 'windowChip')) ||
        from === '../../text/sanitize.ts' ||
        (from === '../../sessions/list.ts' &&
          names.every((n) => n === 'isListed' || n === 'matchesFilter')) ||
        (from === '../../github.ts' && names.every((n) => n === 'CHIP_ORDER'));
      assert.ok(allowed, `${name}: import ${what ?? ''} from '${from ?? ''}'`);
    }
  }
});

// --- attention (stage B, S2 12.4, plan B7) -----------------------------------------------------

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
 * S1 asks (running, waiting since T0 - 10 s); S2 ended (not running, window end 3); S3 finished
 * (running, idle, turn end 5); S4 running, idle, needs nothing; S5 in Earlier, ended (window end
 * 2); S6 done and hidden, ended (window end 1).
 */
function attentionWorld(): { list: ReturnType<typeof rows>; facts: AttentionFacts } {
  const list = rows([
    running(S1, { state: 'waiting', pid: 9001, procStart: 501, transcript: { aiTitle: 'alpha' } }),
    ds({ id: S2, transcript: { aiTitle: 'beta' } }),
    running(S3, { state: 'running', pid: 9003, procStart: 503, transcript: { aiTitle: 'gamma' } }),
    running(S4, { state: 'running', pid: 9004, procStart: 504, transcript: { aiTitle: 'delta' } }),
    ds({ id: S5, lastActivityNs: NOW - 30n * DAY, transcript: { aiTitle: 'epsilon' } }),
    ds({ id: S6, hidden: true, doneAtNs: T0, transcript: { aiTitle: 'zeta' } }),
  ]);
  const facts: AttentionFacts = {
    marks: new Map([
      [S2, marksOf({ windowEndSeq: 3, windowEndNs: NOW - 5n * SEC })],
      [S3, marksOf({ turnEndedSeq: 5, turnEndedNs: NOW - 2n * SEC, seenSeq: 4 })],
      [S4, marksOf({ turnEndedSeq: 6, turnEndedNs: NOW - SEC, seenSeq: 7 })],
      [S5, marksOf({ windowEndSeq: 2, windowEndNs: NOW - 30n * DAY })],
      [S6, marksOf({ windowEndSeq: 1, windowEndNs: NOW - DAY })],
    ]),
    live: new Map([
      [S1, liveOf('waiting', { waitingFor: 'permission · Bash', sinceNs: NOW - 10n * SEC })],
      [S3, liveOf('idle')],
      [S4, liveOf('idle')],
    ]),
  };
  return { list, facts };
}

test('attention: without ViewInput.attention no row needs you and needYou is empty', () => {
  const { list } = attentionWorld();
  const message = buildListMessage(input({ rows: list, view: { unfolded: ['earlier'] } }));
  for (const row of message.sections.flatMap((s) => s.rows)) {
    assert.equal(row.attention, null, row.id);
  }
  assert.deepEqual(message.needYou, { count: 0, order: [] });
  assert.deepEqual(
    buildListMessage(
      input({ rows: list, view: { unfolded: ['earlier'] }, attention: NO_ATTENTION }),
    ),
    message,
  );
});

test("attention: each row's attention is attentionOf over the facts", () => {
  const { list, facts } = attentionWorld();
  const message = buildListMessage(
    input({ rows: list, attention: facts, view: { unfolded: ['earlier'] } }),
  );
  for (const row of list.filter((r) => !r.done)) {
    assert.deepEqual(rowIn(message, row.id).attention, attentionOf(row, facts), row.id);
  }
  assert.deepEqual(rowIn(message, S1).attention, {
    reason: 'asks',
    detail: 'permission · Bash',
    sinceNs: String(NOW - 10n * SEC),
  });
  assert.equal(rowIn(message, S2).attention?.reason, 'ended');
  assert.equal(rowIn(message, S3).attention?.reason, 'finished');
  assert.equal(rowIn(message, S4).attention, null);
  assert.equal(rowIn(message, S5).attention?.reason, 'ended');
});

test("attention: a `new` terminal's own row needs you when its marks say so", () => {
  const facts: AttentionFacts = {
    marks: new Map([[NEW, marksOf({ windowEndSeq: 1, windowEndNs: NOW })]]),
    live: new Map(),
  };
  const message = buildListMessage(
    input({
      terminals: [
        term(1, { expectedSessionId: NEW, sessionId: null, kind: 'new', state: 'ended' }),
      ],
      attention: facts,
    }),
  );
  assert.equal(rowIn(message, NEW).attention?.reason, 'ended');
  assert.deepEqual(message.needYou, { count: 1, order: [NEW] });
});

test('needYou.count: every listed row that needs you, whatever the filter or the fold', () => {
  const { list, facts } = attentionWorld();
  const plain = buildListMessage(input({ rows: list, attention: facts }));
  assert.equal(plain.needYou.count, 4); // S1, S2, S3 and S5 in the folded Earlier; not the done S6
  const filtered = buildListMessage(
    input({ rows: list, attention: facts, view: { filter: 'delta' } }),
  );
  assert.equal(filtered.needYou.count, 4);
  assert.deepEqual(filtered.needYou.order, []);
  const withDone = buildListMessage(
    input({ rows: list, attention: facts, view: { showDone: true } }),
  );
  assert.equal(withDone.needYou.count, 5);
});

test("needYou.order: the rows this page shows that need you, in B6's order", () => {
  const { list, facts } = attentionWorld();
  // Earlier is folded: S5 is not shown.
  const folded = buildListMessage(input({ rows: list, attention: facts }));
  assert.deepEqual(folded.needYou.order, [S1, S2, S3]);
  const unfolded = buildListMessage(
    input({ rows: list, attention: facts, view: { unfolded: ['earlier'] } }),
  );
  assert.deepEqual(unfolded.needYou.order, [S1, S5, S2, S3]);
  // A filter leaves out what it does not match, and unfolds Earlier (S2 12.8).
  const beta = buildListMessage(input({ rows: list, attention: facts, view: { filter: 'beta' } }));
  assert.deepEqual(beta.needYou.order, [S2]);
  const epsilon = buildListMessage(
    input({ rows: list, attention: facts, view: { filter: 'epsilon' } }),
  );
  assert.deepEqual(epsilon.needYou.order, [S5]);
});

test('counts: a row that needs you is counted in needYou.count and in no field of counts', () => {
  const { list, facts } = attentionWorld();
  const without = buildListMessage(input({ rows: list }));
  const withFacts = buildListMessage(input({ rows: list, attention: facts }));
  assert.deepEqual(without.counts, {
    working: 0,
    waiting: 1,
    running: 2,
    starting: 0,
    elsewhere: 0,
    notRunning: 2,
  });
  assert.deepEqual(withFacts.counts, {
    working: 0,
    waiting: 0,
    running: 1,
    starting: 0,
    elsewhere: 0,
    notRunning: 0,
  });
  const total = (counts: typeof without.counts) =>
    Object.values(counts).reduce((sum, n) => sum + n, 0);
  assert.equal(total(withFacts.counts) + withFacts.needYou.count, total(without.counts));
});

test('counts: a row running elsewhere or starting that needs you is in none of counts either', () => {
  const list = rows([running(S1), ds({ id: S2, lastActivityNs: NOW - 20n * DAY })]);
  const facts: AttentionFacts = {
    marks: new Map([
      [S1, marksOf({ windowEndSeq: 1 })],
      [S2, marksOf({ windowEndSeq: 2 })],
    ]),
    live: new Map(),
  };
  const message = buildListMessage(
    input({
      rows: list,
      terminals: [term(1, { expectedSessionId: S2, sessionId: null, state: 'starting', slot: 1 })],
      elsewhere: new Map([[S1, { pid: 9000, tty: null }]]),
      attention: facts,
    }),
  );
  assert.equal(message.counts.elsewhere, 0);
  assert.equal(message.counts.starting, 0);
  assert.deepEqual(message.needYou, { count: 2, order: [S1, S2] });
});
