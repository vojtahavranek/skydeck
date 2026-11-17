// What the right side shows (S2 12.6, plan 2.9 `web/pane.js`; task 26).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TerminalState } from '../../src/window/hub.ts';
import type {
  ListMessage,
  RowPayload,
  SectionPayload,
  TerminalPayload,
} from '../../src/window/protocol.ts';
import { MAY_START as SERVER_MAY_START } from '../../src/window/view/sections.ts';
import { blockInfo, isEnded, MAY_START, paneFor, sessionRow } from '../../web/pane.js';
import { S1, S2, S3 } from '../helpers/platform.ts';

function row(id: string, more: Partial<RowPayload> = {}): RowPayload {
  return {
    id,
    shortId: id.slice(0, 8),
    title: `title of ${id.slice(0, 8)}`,
    titleSource: 'summary',
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: '1794474000000000000',
    lastActivityNs: '1794474000000000000',
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
    ...more,
  };
}

function term(id: string, state: string, sessionId: string | null): TerminalPayload {
  return {
    id,
    slot: 1,
    sessionId,
    state,
    notReported: false,
    cols: 80,
    rows: 24,
    ownsSize: true,
    openedNs: '1794473000000000000',
  };
}

const T1 = '0123456789ab';
const T2 = 'ba9876543210';

test('a row with a terminal shows the terminal view; an ended, lost or not-started one with the ended bar', () => {
  for (const [state, ended] of [
    ['starting', false],
    ['running', false],
    ['reconnecting', false],
    ['newer-keeper', false],
    ['ended', true],
    ['lost', true],
    ['not-started', true],
  ] as const) {
    const terminal = term(T1, state, S1);
    const selected = row(S1, { terminal: T1, state: 'running' });
    assert.deepEqual(paneFor(S1, [selected], [terminal], false), {
      kind: 'terminal',
      row: selected,
      term: terminal,
      ended,
    });
    assert.equal(isEnded(terminal), ended, state);
  }
});

test("a starting terminal's row (its session id from prepareNew, the terminal's own still null) shows it", () => {
  const terminal = term(T2, 'starting', null);
  const selected = row(S2, { terminal: T2, starting: true });
  assert.equal(paneFor(S2, [selected], [terminal], false).kind, 'terminal');
});

test('a session running in another terminal shows the elsewhere card; one not running the resume card', () => {
  const elsewhere = row(S1, {
    state: 'working',
    elsewhere: { pid: 42, tty: '/dev/pts/3', dir: null },
  });
  const resumable = row(S2);
  assert.deepEqual(paneFor(S1, [elsewhere, resumable], [], false), {
    kind: 'elsewhere',
    row: elsewhere,
  });
  assert.deepEqual(paneFor(S2, [elsewhere, resumable], [], false), {
    kind: 'resume',
    row: resumable,
  });
});

test('the new form wins over the selection; no selection or a session not listed shows nothing', () => {
  assert.deepEqual(paneFor(S1, [row(S1)], [], true), { kind: 'new' });
  assert.deepEqual(paneFor(null, [row(S1)], [], false), { kind: 'none' });
  assert.deepEqual(paneFor(S3, [row(S1)], [], false), { kind: 'none' });
});

test('a selected session the list does not show (filtered out) still shows the terminal that holds it', () => {
  const terminal = term(T1, 'running', S3);
  assert.deepEqual(paneFor(S3, [row(S1)], [terminal], false), {
    kind: 'terminal',
    row: null,
    term: terminal,
    ended: false,
  });
});

test("a row whose terminal the list does not carry falls back to the row's own card", () => {
  assert.equal(paneFor(S1, [row(S1, { terminal: T1 })], [], false).kind, 'resume');
});

// --- the selected session the list does not show (stage E, plan E13, task 95) -----------------

/** A list whose sections carry `shown` (in Recent) and whose `selectedRow` is `selectedRow`
 *  (absent when undefined: a list of a server before stage E). */
function listOf(shown: RowPayload[], selectedRow?: RowPayload | null): ListMessage {
  return {
    t: 'list',
    nowNs: '1794474000000000000',
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    needYou: { count: 0, order: [] },
    sections: [
      {
        name: 'open',
        folded: false,
        firstNs: null,
        lastNs: null,
        count: 0,
        rows: [],
        closedStacks: [],
      },
      {
        name: 'week',
        folded: false,
        firstNs: null,
        lastNs: null,
        count: shown.length,
        rows: shown,
        closedStacks: [],
      },
      {
        name: 'earlier',
        folded: true,
        firstNs: null,
        lastNs: null,
        count: 0,
        rows: [],
        closedStacks: [],
      },
    ],
    doneHidden: 0,
    banner: null,
    terminals: [],
    selected: null,
    dirs: [],
    ...(selectedRow === undefined ? {} : { selectedRow }),
  };
}

test("sessionRow: the sections' row of the id, else selectedRow when its id is that id, else null", () => {
  const listed = row(S1, { title: 'listed' });
  const hidden = row(S2, { title: 'hidden' });
  assert.equal(sessionRow(listOf([listed], hidden), S1), listed);
  assert.equal(sessionRow(listOf([listed], hidden), S2), hidden);
  // The sections' row wins over a selectedRow of the same id.
  const stale = row(S1, { title: 'the same session, as selectedRow' });
  assert.equal(sessionRow(listOf([listed], stale), S1), listed);
  // A selectedRow of another id (the selection before; a list from before the connection was
  // lost) is no row of this one.
  assert.equal(sessionRow(listOf([listed], hidden), S3), null);
  assert.equal(sessionRow(listOf([listed], null), S2), null);
  assert.equal(sessionRow(listOf([listed]), S2), null, 'a list without selectedRow');
  assert.equal(sessionRow(null, S1), null, 'no list');
  assert.equal(sessionRow(listOf([listed], hidden), null), null, 'no id');
});

test('paneFor: a hidden session whose selectedRow names a running terminal shows it with that row; an ended one with the ended bar', () => {
  for (const [state, ended] of [
    ['running', false],
    ['reconnecting', false],
    ['ended', true],
    ['lost', true],
    ['not-started', true],
  ] as const) {
    const terminal = term(T1, state, S1);
    const hidden = row(S1, { terminal: T1, state: ended ? 'not-running' : 'running', slot: 1 });
    assert.deepEqual(
      paneFor(S1, [row(S2)], [terminal], false, hidden),
      { kind: 'terminal', row: hidden, term: terminal, ended },
      state,
    );
  }
});

test('paneFor: a hidden session whose terminal is starting (its session id still null) shows it', () => {
  const terminal = term(T2, 'starting', null);
  const hidden = row(S2, { terminal: T2, starting: true });
  assert.deepEqual(paneFor(S2, [], [terminal], false, hidden), {
    kind: 'terminal',
    row: hidden,
    term: terminal,
    ended: false,
  });
});

test("paneFor: a hidden session's row decides, not a terminal whose sessionId is the selection (an ended terminal of a session that runs again elsewhere)", () => {
  const terminal = term(T1, 'ended', S1);
  const elsewhere = row(S1, { state: 'working', elsewhere: { pid: 42, tty: null, dir: null } });
  assert.deepEqual(paneFor(S1, [], [terminal], false, elsewhere), { kind: 'none' });
});

test('paneFor: a row from selectedRow without a terminal shows nothing — no elsewhere card, no resume card (S2 12.9)', () => {
  const resumable = row(S1);
  const elsewhere = row(S2, {
    state: 'working',
    elsewhere: { pid: 42, tty: '/dev/pts/3', dir: null },
  });
  assert.deepEqual(paneFor(S1, [], [], false, resumable), { kind: 'none' });
  assert.deepEqual(paneFor(S2, [], [], false, elsewhere), { kind: 'none' });
  // Nor one whose terminal the list does not carry.
  assert.deepEqual(paneFor(S1, [], [], false, row(S1, { terminal: T1 })), { kind: 'none' });
});

test('paneFor: a listed row wins over selectedRow, and a selectedRow of another session is not used', () => {
  const listed = row(S1);
  const hiddenView = row(S1, { terminal: T1, state: 'running' });
  const terminal = term(T1, 'running', S1);
  assert.deepEqual(paneFor(S1, [listed], [terminal], false, hiddenView), {
    kind: 'resume',
    row: listed,
  });
  // The selection before: stage A's answer for S3 (its terminal with row null, else none).
  const before = row(S2, { terminal: T2, state: 'running' });
  const ownTerm = term(T1, 'running', S3);
  assert.deepEqual(paneFor(S3, [], [ownTerm, term(T2, 'running', S2)], false, before), {
    kind: 'terminal',
    row: null,
    term: ownTerm,
    ended: false,
  });
  assert.deepEqual(paneFor(S3, [], [term(T2, 'running', S2)], false, before), { kind: 'none' });
});

test("paneFor: with no row at all, stage A's answer — a terminal whose sessionId is the selection, with row null; else none", () => {
  const terminal = term(T1, 'ended', S3);
  assert.deepEqual(paneFor(S3, [], [terminal], false, null), {
    kind: 'terminal',
    row: null,
    term: terminal,
    ended: true,
  });
  assert.deepEqual(paneFor(S3, [], [], false, null), { kind: 'none' });
  assert.deepEqual(paneFor(S3, [], [], false), { kind: 'none' });
  // The new form still wins.
  assert.deepEqual(paneFor(S1, [], [terminal], true, row(S1, { terminal: T1 })), { kind: 'new' });
});

// F6 (ruled 2026-11-16, review 2's S1): the page's copy of the server's `MAY_START`.

/** Every terminal state, held by the compiler: a Record over the type must name each one once. */
const STATES: Record<TerminalState, true> = {
  starting: true,
  running: true,
  ended: true,
  lost: true,
  'not-started': true,
  reconnecting: true,
  'newer-keeper': true,
};

test("MAY_START: the page's copy is the server's set, state for state", () => {
  assert.deepEqual([...MAY_START].sort(), [...SERVER_MAY_START].sort());
});

test('MAY_START and the ended states part the terminal states: each state in exactly one', () => {
  for (const state of Object.keys(STATES)) {
    const term = { state } as TerminalPayload;
    assert.notEqual(MAY_START.has(state), isEnded(term), state);
  }
  assert.equal(
    MAY_START.size +
      Object.keys(STATES).filter((state) => isEnded({ state } as TerminalPayload)).length,
    Object.keys(STATES).length,
  );
});

/** A list of `sections` only (blockInfo reads nothing else). */
function listWith(sections: Partial<SectionPayload>[]): ListMessage {
  return {
    sections: sections.map((section) => ({
      name: 'open',
      folded: false,
      firstNs: null,
      lastNs: null,
      count: 0,
      rows: [],
      closedStacks: [],
      ...section,
    })),
  } as unknown as ListMessage;
}

test("blockInfo (F9): a closed caption's size and needYou; an open card's size and its rows that need you; null for a block the section does not draw", () => {
  const list = listWith([
    {
      name: 'open',
      rows: [
        row(S1, { stack: { group: 'G', size: 2, role: 'head', head: S1 } }),
        row(S2, {
          stack: { group: 'G', size: 2, role: 'member', head: S1 },
          attention: { reason: 'asks', detail: null, sinceNs: '1' },
        }),
        row(S3, { group: 'H' }),
      ],
    },
    {
      name: 'week',
      rows: [],
      closedStacks: [{ group: 'G', size: 4, needYou: 3, head: S3, at: 0 }],
    },
  ]);
  assert.deepEqual(blockInfo(list, 'open', 'G'), { size: 2, needYou: 1 });
  assert.deepEqual(blockInfo(list, 'week', 'G'), { size: 4, needYou: 3 });
  // A row in no block of its group, another group, another section, no list: none.
  assert.equal(blockInfo(list, 'open', 'H'), null);
  assert.equal(blockInfo(list, 'open', 'NOPE'), null);
  assert.equal(blockInfo(list, 'earlier', 'G'), null);
  assert.equal(blockInfo(null, 'open', 'G'), null);
  // A section with no closed block and no row of the group: none.
  assert.equal(blockInfo(listWith([{ name: 'week' }]), 'week', 'G'), null);
});
