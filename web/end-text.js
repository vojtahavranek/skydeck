// Follow-up F30's words and rules for the page, pure (no DOM): whether `d` or the header's `Done`
// asks first in the dialog "Mark done" (web/end-dialog.js), what the dialog says, when it closes by
// itself, and what the toast says of each outcome. A session the window can end is one whose row
// says so (`endable`, the server's rule: it runs in its terminal of the window, whose keeper knows
// how and is connected); every other session is marked done at once, as before.
//
// Follow-up F44's dialog "Park" (S2 12.15) is the same dialog with its own words (`PARK_TEXTS`):
// `w` or the header's `Park` on a session not parked that the window can end asks first
// (`asksPark`), and the dialog follows its session with the words of a parking, also closing when
// the session is parked elsewhere (`dialogFollows` with the mark `park`).

/** @import { ListMessage, RowPayload } from '../src/window/protocol.ts' */

/** The heading cuts a longer title to this many characters, `…` included. */
export const TITLE_MAX = 60;

export const END_TEXTS = {
  heading: 'Mark done: ',
  running: 'This session is still running.',
  working: 'It is working: ending it now stops the current turn.',
  end: 'End session and mark done',
  keep: 'Mark done, keep it running',
  cancel: 'Cancel',
  /** The toast while the request waits for its answer. */
  ending: 'Ending the session…',
  /** The toast once the program ended (with Undo). */
  ended: 'Ended and marked done: hidden from the list.',
  /** The toast once the wait is over and the program still runs (with Undo); the server still
   *  records its end and closes its terminal when it ends later. */
  notEnded: 'Marked done. It has not ended yet: end it inside claude if it stays open.',
  /** The toast of `d` on a session that runs and cannot be ended from the window (E4). */
  cannotEnd:
    'Marked done. skydeck cannot end this one: end it in its terminal. Hidden once it stops.',
  /** F34: that toast for a session Claude Code runs in its background (`cannotEndText`): it has
   *  no terminal of the user's, and it is never ended from outside (Claude Code may restart it). */
  cannotEndBackground:
    "Marked done. It runs in Claude Code's background: end it in claude agents. Hidden once it stops.",
  /** The toasts of a dialog that closed by itself: nothing was done. */
  stopped: 'It stopped by itself: nothing was marked done.',
  doneElsewhere: 'It was marked done in another window: nothing was ended.',
  gone: 'It left the list: nothing was marked done.',
};

/** @typedef {'done' | 'park'} DialogMark the dialog's mark: Done's (`d`) or Park's (`w`) */

/**
 * The dialog "Park"'s words, and the toasts of a park: as Done's, with the words of a parking.
 * `parkedElsewhere` is its own (the dialog closes when another window parked the session).
 */
export const PARK_TEXTS = {
  heading: 'Park: ',
  running: END_TEXTS.running,
  working: END_TEXTS.working,
  /** The warning while skydeck cannot tell whether it works (state `running`, design 6.2). */
  unknown: 'skydeck cannot tell whether it is working: ending it now may stop a turn.',
  /** The warning while it asks the user something in the middle of a turn. */
  asking: 'It is asking you something: ending it now stops the current turn.',
  end: 'End session and park',
  keep: 'Park, keep it running',
  cancel: END_TEXTS.cancel,
  ending: END_TEXTS.ending,
  /** The toast once the program ended (with Undo, which un-parks: the program does not come
   *  back). */
  ended: 'Ended and parked: listed under Parked.',
  /** The toast once the wait is over and the program still runs (with Undo). */
  notEnded: 'Parked. It has not ended yet: end it inside claude if it stays open.',
  /** The toast of `w` on a session that runs and cannot be ended from the window. */
  cannotEnd: 'Parked. skydeck cannot end this one: end it in its terminal.',
  /** That toast for a session Claude Code runs in its background (F34). */
  cannotEndBackground: "Parked. It runs in Claude Code's background: end it in claude agents.",
  stopped: 'It stopped by itself: nothing was parked.',
  doneElsewhere: 'It was marked done in another window: nothing was ended or parked.',
  parkedElsewhere: 'It was parked in another window: nothing was ended.',
  gone: 'It left the list: nothing was parked.',
};

/**
 * @typedef {'idle' | 'working' | 'asking' | 'unknown'} ParkPhase
 */

/**
 * The dialog "Park"'s reading of a row (ruled on review 1): `idle` only when skydeck knows it waits
 * for the user's next prompt with nothing pending (state `waiting`, no detail); `asking` when it
 * waits for an answer in the middle of a turn (a permission, a question: a detail); `working`; and
 * `unknown` for `running`, where skydeck cannot tell (design 6.2). Only `idle` lets the keyboard
 * start on, or stay on, `End session and park`.
 * @param {RowPayload} row
 * @returns {ParkPhase}
 */
export function parkPhase(row) {
  if (row.state === 'working') {
    return 'working';
  }
  if (row.state === 'waiting') {
    return row.stateDetail === null ? 'idle' : 'asking';
  }
  return 'unknown';
}

/**
 * The warning line of the dialog "Park" in `phase`, or null (idle).
 * @param {ParkPhase} phase
 * @returns {string | null}
 */
export function parkWarning(phase) {
  return phase === 'idle' ? null : PARK_TEXTS[phase];
}

/**
 * The words of the dialog of `mark`, and of its toasts.
 * @param {DialogMark} mark
 */
export function textsOf(mark) {
  return mark === 'park' ? PARK_TEXTS : END_TEXTS;
}

/**
 * Whether `d` or `Done` on `row` asks first: a session not marked done that the window can end.
 * @param {RowPayload} row
 * @returns {boolean}
 */
export function asksFirst(row) {
  return !row.done && row.endable === true && typeof row.terminal === 'string';
}

/**
 * F44 (S2 12.15): whether `w` or `Park` on `row` asks first: a session not parked that the window
 * can end (also one marked done: parking ends its done mark).
 * @param {RowPayload} row
 * @returns {boolean}
 */
export function asksPark(row) {
  return row.parked !== true && row.endable === true && typeof row.terminal === 'string';
}

/**
 * The toast of `d` (or, with the mark `park`, of `w`) on a running session the window cannot end:
 * F34's for a session Claude Code runs in its background, else `cannotEnd`.
 * @param {RowPayload} row
 * @param {DialogMark} [mark]
 * @returns {string}
 */
export function cannotEndText(row, mark = 'done') {
  const texts = textsOf(mark);
  return row.elsewhere?.background === true ? texts.cannotEndBackground : texts.cannotEnd;
}

/**
 * The heading's title: the list's title, cut to TITLE_MAX characters (whole code points, never
 * half a pair) with `…` at the end when longer.
 * @param {string} title
 * @returns {string}
 */
export function cutTitle(title) {
  const characters = Array.from(title);
  return characters.length <= TITLE_MAX ? title : `${characters.slice(0, TITLE_MAX - 1).join('')}…`;
}

/**
 * What a list means for the dialog of `sessionId` opened over its terminal `term`: `close` with the
 * toast's words when the session left the list, was marked done (elsewhere: this page is modal) or
 * stopped running there — then nothing is done —, else `stay` with its row and whether it works now.
 * The dialog "Park" (`mark` `park`) closes also when the session was parked elsewhere, and for one
 * marked done only when it was not done before this list (`wasDone`: its row's `done` at the last
 * list, a session marked done can be parked).
 * @param {ListMessage} list
 * @param {string} sessionId
 * @param {string} term
 * @param {(list: ListMessage, id: string) => RowPayload | null} rowOf the page's `sessionRow`
 * @param {DialogMark} [mark]
 * @param {boolean} [wasDone]
 * @returns {{ close: string } | { stay: RowPayload, working: boolean }}
 */
export function dialogFollows(list, sessionId, term, rowOf, mark = 'done', wasDone = false) {
  const texts = textsOf(mark);
  const row = rowOf(list, sessionId);
  if (row === null) {
    return { close: texts.gone };
  }
  if (mark === 'park' && row.parked === true) {
    return { close: PARK_TEXTS.parkedElsewhere };
  }
  if (row.done && !(mark === 'park' && wasDone)) {
    return { close: texts.doneElsewhere };
  }
  const terminal = list.terminals.find((candidate) => candidate.id === term);
  const over =
    terminal === undefined ||
    terminal.state === 'ended' ||
    terminal.state === 'lost' ||
    terminal.state === 'not-started';
  if (over || row.terminal !== term || row.state === 'not-running') {
    return { close: texts.stopped };
  }
  return { stay: row, working: row.state === 'working' };
}
