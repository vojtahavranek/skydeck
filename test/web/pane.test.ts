// What the right side shows (S2 12.6, plan 2.9 `web/pane.js`; task 26).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RowPayload, TerminalPayload } from '../../src/window/protocol.ts';
import { isEnded, paneFor } from '../../web/pane.js';
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
