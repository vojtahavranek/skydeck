// Follow-up F30's rules for the page (web/end-text.js): which `d` asks first in the dialog "Mark
// done", the heading's cut, and when the dialog closes by itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ListMessage,
  RowPayload,
  SectionPayload,
  TerminalPayload,
} from '../../src/window/protocol.ts';
import {
  asksFirst,
  cannotEndText,
  cutTitle,
  dialogFollows,
  END_TEXTS,
  TITLE_MAX,
} from '../../web/end-text.js';
import { sessionRow } from '../../web/pane.js';
import { S1, S2 } from '../helpers/platform.ts';

const TERM = 'a1b2c3d4e5f6';

function row(id: string, more: Partial<RowPayload> = {}): RowPayload {
  return {
    id,
    shortId: id.slice(0, 8),
    title: `title of ${id.slice(0, 8)}`,
    titleSource: 'summary',
    group: null,
    groupSource: null,
    state: 'waiting',
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
    terminal: TERM,
    slot: 1,
    elsewhere: null,
    starting: false,
    attention: null,
    stack: null,
    endable: true,
    ...more,
  };
}

function terminal(more: Partial<TerminalPayload> = {}): TerminalPayload {
  return {
    id: TERM,
    slot: 1,
    sessionId: S1,
    state: 'running',
    notReported: false,
    cols: 80,
    rows: 24,
    ownsSize: true,
    openedNs: '1794470400000000000',
    ...more,
  };
}

function listOf(
  rows: RowPayload[],
  terminals: TerminalPayload[],
  selectedRow?: RowPayload,
): ListMessage {
  const section = (name: SectionPayload['name'], shown: RowPayload[]): SectionPayload => ({
    name,
    folded: false,
    firstNs: null,
    lastNs: null,
    count: shown.length,
    rows: shown,
    closedStacks: [],
  });
  return {
    t: 'list',
    nowNs: '1794474000000000000',
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    needYou: { count: 0, order: [] },
    sections: [section('open', rows), section('week', []), section('earlier', [])],
    doneHidden: 0,
    banner: null,
    terminals,
    selected: null,
    dirs: [],
    filtering: false,
    switcher: null,
    selectedRow: selectedRow ?? null,
  } as ListMessage;
}

test('asksFirst: only a session not marked done that the window can end in its terminal', () => {
  const cases: [string, RowPayload, boolean][] = [
    ['endable, waiting', row(S1), true],
    ['endable, working', row(S1, { state: 'working' }), true],
    ['already marked done (d marks it undone)', row(S1, { done: true }), false],
    ['not endable (an older keeper, not connected)', row(S1, { endable: false }), false],
    ['no endable field (a server before F30)', row(S1, { endable: undefined }), false],
    [
      'running in another terminal',
      row(S1, { terminal: null, slot: null, elsewhere: { pid: 1, tty: null, dir: null } }),
      false,
    ],
    ['not running', row(S1, { state: 'not-running', terminal: null, endable: false }), false],
  ];
  for (const [what, given, expected] of cases) {
    assert.equal(asksFirst(given), expected, what);
  }
});

test('cutTitle: a title up to the limit whole; a longer one cut with … at the limit, never half a pair', () => {
  assert.equal(cutTitle('fix the retry'), 'fix the retry');
  const exact = 'x'.repeat(TITLE_MAX);
  assert.equal(cutTitle(exact), exact);
  const long = 'y'.repeat(TITLE_MAX + 1);
  assert.equal(cutTitle(long), `${'y'.repeat(TITLE_MAX - 1)}…`);
  assert.equal(Array.from(cutTitle(long)).length, TITLE_MAX);
  const emoji = '🙂'.repeat(TITLE_MAX + 5);
  const cut = cutTitle(emoji);
  assert.equal(cut, `${'🙂'.repeat(TITLE_MAX - 1)}…`);
  assert.ok(cut.isWellFormed());
  assert.equal(
    cutTitle('<b>"quoted"</b> & \'more\''),
    '<b>"quoted"</b> & \'more\'',
    'text as it is',
  );
});

test('dialogFollows: it stays while its session runs in its terminal, and says whether it works', () => {
  const waiting = dialogFollows(listOf([row(S1)], [terminal()]), S1, TERM, sessionRow);
  assert.deepEqual('stay' in waiting && [waiting.stay.id, waiting.working], [S1, false]);
  const working = dialogFollows(
    listOf([row(S1, { state: 'working' })], [terminal()]),
    S1,
    TERM,
    sessionRow,
  );
  assert.deepEqual('stay' in working && working.working, true);
  // A list that holds it only as the selected row (a filter hides it) keeps it too.
  const hidden = dialogFollows(listOf([], [terminal()], row(S1)), S1, TERM, sessionRow);
  assert.ok('stay' in hidden);
  // Another session's change, or the selection moving, is nothing to it.
  const other = dialogFollows(
    listOf([row(S1), row(S2, { done: true, terminal: null })], [terminal()]),
    S1,
    TERM,
    sessionRow,
  );
  assert.ok('stay' in other);
});

test('dialogFollows: it closes, nothing done, when its session stopped, was marked done or left the list', () => {
  const cases: [string, ListMessage, string][] = [
    [
      'marked done in another window',
      listOf([row(S1, { done: true })], [terminal()]),
      END_TEXTS.doneElsewhere,
    ],
    ['left the list', listOf([row(S2)], [terminal()]), END_TEXTS.gone],
    ['its terminal ended', listOf([row(S1)], [terminal({ state: 'ended' })]), END_TEXTS.stopped],
    ['its terminal was lost', listOf([row(S1)], [terminal({ state: 'lost' })]), END_TEXTS.stopped],
    ['its terminal is gone', listOf([row(S1)], []), END_TEXTS.stopped],
    [
      'it is not running',
      listOf([row(S1, { state: 'not-running' })], [terminal()]),
      END_TEXTS.stopped,
    ],
    [
      'it runs in another terminal now',
      listOf([row(S1, { terminal: 'ffffffffffff' })], [terminal()]),
      END_TEXTS.stopped,
    ],
  ];
  for (const [what, list, text] of cases) {
    assert.deepEqual(dialogFollows(list, S1, TERM, sessionRow), { close: text }, what);
  }
});

test('the words of the dialog and its toasts', () => {
  assert.deepEqual(END_TEXTS, {
    heading: 'Mark done: ',
    running: 'This session is still running.',
    working: 'It is working: ending it now stops the current turn.',
    end: 'End session and mark done',
    keep: 'Mark done, keep it running',
    cancel: 'Cancel',
    ending: 'Ending the session…',
    ended: 'Ended and marked done: hidden from the list.',
    notEnded: 'Marked done. It has not ended yet: end it inside claude if it stays open.',
    cannotEnd:
      'Marked done. skydeck cannot end this one: end it in its terminal. Hidden once it stops.',
    cannotEndBackground:
      "Marked done. It runs in Claude Code's background: end it in claude agents. Hidden once it stops.",
    stopped: 'It stopped by itself: nothing was marked done.',
    doneElsewhere: 'It was marked done in another window: nothing was ended.',
    gone: 'It left the list: nothing was marked done.',
  });
});

test('F34: cannotEndText: the background toast only for a session Claude Code runs in its background', () => {
  const cases: [string, RowPayload, string][] = [
    [
      "in Claude Code's background",
      row(S1, {
        terminal: null,
        slot: null,
        elsewhere: { pid: 1, tty: null, dir: null, background: true },
      }),
      END_TEXTS.cannotEndBackground,
    ],
    [
      'in another terminal',
      row(S1, {
        terminal: null,
        slot: null,
        elsewhere: { pid: 1, tty: '/dev/pts/2', dir: null, background: false },
      }),
      END_TEXTS.cannotEnd,
    ],
    [
      'in another terminal, a server before F34',
      row(S1, { terminal: null, slot: null, elsewhere: { pid: 1, tty: null, dir: null } }),
      END_TEXTS.cannotEnd,
    ],
    ['in a terminal of the window it cannot end', row(S1, { endable: false }), END_TEXTS.cannotEnd],
  ];
  for (const [what, given, text] of cases) {
    assert.equal(cannotEndText(given), text, what);
  }
});

test('F34: no word of the page tells a user to kill a process or names a signal', () => {
  for (const [name, text] of Object.entries(END_TEXTS)) {
    assert.doesNotMatch(text, /kill|signal|\bSIG|pkill|ctrl\+c/i, name);
  }
});
