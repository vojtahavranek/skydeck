// Issue #166's words and rules for the page (web/restart-text.js): which row `r` and Restart offer
// the dialog for, what the toast says for every other, what each answer of `act restart` means
// (the dialog stays, a toast, the ended bar's line), and when the dialog closes by itself. Pure.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ListMessage, ResultMessage, RowPayload } from '../../src/window/protocol.ts';
import { END_TEXTS } from '../../web/end-text.js';
import { listKey } from '../../web/keys.js';
import { sessionRow } from '../../web/pane.js';
import {
  noRestartText,
  offersRestart,
  RESTART_TEXTS,
  restartFollows,
  restartOutcome,
} from '../../web/restart-text.js';
import { S1, S2 } from '../helpers/platform.ts';

const TERM = 'aaaaaaaaaaaa';

function row(over: Partial<RowPayload> = {}): RowPayload {
  return {
    id: S1,
    shortId: S1.slice(0, 8),
    title: 'fix the retry',
    titleSource: 'label',
    group: null,
    groupSource: null,
    state: 'waiting',
    stateDetail: null,
    sinceNs: '1',
    lastActivityNs: '1',
    dir: '/w',
    marks: [],
    hasNote: false,
    noteHead: [],
    done: false,
    prs: [],
    chip: null,
    terminal: TERM,
    slot: 1,
    elsewhere: null,
    starting: false,
    attention: null,
    stack: null,
    endable: true,
    ticketStatus: null,
    copyOf: null,
    ...over,
  } as RowPayload;
}

const result = (over: Partial<ResultMessage>): ResultMessage => ({
  t: 'result',
  id: 1,
  ok: false,
  lines: [],
  error: null,
  sessionId: null,
  ...over,
});

function list(rows: RowPayload[], terminals: { id: string; state: string }[]): ListMessage {
  return {
    sections: [{ name: 'open', rows }],
    terminals: terminals.map((term) => ({ ...term, sessionId: S1, slot: 1 })),
    selectedRow: null,
  } as unknown as ListMessage;
}

describe('restart-text', () => {
  test('`r` is the list key that asks for a restart', () => {
    const key = {
      key: 'r',
      code: 'KeyR',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    assert.deepEqual(listKey(key), { kind: 'restart' });
    assert.equal(listKey({ ...key, key: 'R', shiftKey: true }), null);
  });

  test('offered only for a session not marked done that the window can end, on its terminal', () => {
    assert.equal(offersRestart(row()), true);
    assert.equal(offersRestart(row({ done: true })), false);
    assert.equal(offersRestart(row({ endable: false })), false);
    assert.equal(offersRestart(row({ terminal: null })), false);
  });

  test('every other row: the toast says why, in its own words', () => {
    assert.equal(noRestartText(row({ done: true }), false), RESTART_TEXTS.markedDone);
    assert.equal(
      noRestartText(row({ state: 'not-running', endable: false }), false),
      RESTART_TEXTS.notRunning,
    );
    assert.equal(
      noRestartText(row({ terminal: null, endable: false }), false),
      RESTART_TEXTS.notRunning,
    );
    const elsewhere = { pid: 4, tty: '/dev/pts/3', dir: '/w', background: false };
    assert.equal(
      noRestartText(row({ terminal: null, endable: false, elsewhere }), false),
      RESTART_TEXTS.elsewhere,
    );
    assert.equal(
      noRestartText(
        row({ terminal: null, endable: false, elsewhere: { ...elsewhere, background: true } }),
        false,
      ),
      RESTART_TEXTS.background,
    );
    assert.equal(noRestartText(row({ endable: false }), false), RESTART_TEXTS.cannotEnd);
    assert.equal(
      noRestartText(row({ endable: false }), true),
      'skydeck is restarting this session',
    );
  });

  test('the dialog’s words: the end dialog’s warning; Restart, Other flags…, Cancel', () => {
    assert.equal(RESTART_TEXTS.working, END_TEXTS.working);
    assert.equal(
      RESTART_TEXTS.line,
      'It ends claude and resumes this session here, with the same flags.',
    );
    assert.deepEqual(
      [RESTART_TEXTS.restart, RESTART_TEXTS.other, RESTART_TEXTS.cancel],
      ['Restart', 'Other flags…', 'Cancel'],
    );
  });

  test('an answer: a refusal stays in the dialog; given up, restarted, and ended without a resume each a toast, the last on the bar too', () => {
    assert.deepEqual(restartOutcome(result({ error: 'cannot pass -w to claude' })), {
      stay: 'cannot pass -w to claude',
    });
    const waited = 'it has not ended within 10 seconds; if it ends later, resume it from its bar';
    assert.deepEqual(restartOutcome(result({ error: waited, ended: false })), {
      toast: `Not restarted: ${waited}.`,
      bar: null,
    });
    assert.deepEqual(restartOutcome(result({ ok: true, ended: true, sessionId: S1 })), {
      toast: 'Restarted.',
      bar: null,
    });
    const said = 'Restart: it ended, but was not resumed: 0b5f3c1e: directory /w no longer exists';
    assert.deepEqual(
      restartOutcome(result({ ended: true, error: '0b5f3c1e: directory /w no longer exists' })),
      { toast: said, bar: said },
    );
    // The connection lost while it waited: nothing is known, the dialog closes.
    const lost = "skydeck's server stopped answering; the action may or may not have been done";
    assert.deepEqual(restartOutcome(result({ error: lost })), {
      toast: `Restart: ${lost}`,
      bar: null,
    });
    // Without an error, its lines.
    assert.deepEqual(
      restartOutcome(result({ ended: true, lines: ['skydeck: not started: the deadline passed'] })),
      {
        toast: 'Restart: it ended, but was not resumed: skydeck: not started: the deadline passed',
        bar: 'Restart: it ended, but was not resumed: skydeck: not started: the deadline passed',
      },
    );
  });

  test('before a press the dialog follows its session: it closes when it stopped, was marked done, left the list', () => {
    const running = [{ id: TERM, state: 'running' }];
    assert.deepEqual(restartFollows(list([row()], running), S1, TERM, sessionRow), {
      stay: row(),
      working: false,
    });
    assert.deepEqual(
      restartFollows(list([row({ state: 'working' })], running), S1, TERM, sessionRow),
      { stay: row({ state: 'working' }), working: true },
    );
    assert.deepEqual(restartFollows(list([], running), S1, TERM, sessionRow), {
      close: RESTART_TEXTS.gone,
    });
    assert.deepEqual(restartFollows(list([row({ done: true })], running), S1, TERM, sessionRow), {
      close: RESTART_TEXTS.doneElsewhere,
    });
    assert.deepEqual(
      restartFollows(list([row()], [{ id: TERM, state: 'ended' }]), S1, TERM, sessionRow),
      { close: RESTART_TEXTS.stopped },
    );
    assert.deepEqual(
      restartFollows(list([row({ terminal: 'bbbbbbbbbbbb' })], running), S1, TERM, sessionRow),
      { close: RESTART_TEXTS.stopped },
    );
    assert.deepEqual(restartFollows(list([row({ id: S2 })], running), S1, TERM, sessionRow), {
      close: RESTART_TEXTS.gone,
    });
  });
});
