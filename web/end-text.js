// Follow-up F30's words and rules for the page, pure (no DOM): whether `d` or the header's `Done`
// asks first in the dialog "Mark done" (web/end-dialog.js), what the dialog says, when it closes by
// itself, and what the toast says of each outcome. A session the window can end is one whose row
// says so (`endable`, the server's rule: it runs in its terminal of the window, whose keeper knows
// how and is connected); every other session is marked done at once, as before.

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

/**
 * Whether `d` or `Done` on `row` asks first: a session not marked done that the window can end.
 * @param {RowPayload} row
 * @returns {boolean}
 */
export function asksFirst(row) {
  return !row.done && row.endable === true && typeof row.terminal === 'string';
}

/**
 * The toast of `d` on a running session the window cannot end: F34's for a session Claude Code
 * runs in its background, else `cannotEnd`.
 * @param {RowPayload} row
 * @returns {string}
 */
export function cannotEndText(row) {
  return row.elsewhere?.background === true ? END_TEXTS.cannotEndBackground : END_TEXTS.cannotEnd;
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
 * @param {ListMessage} list
 * @param {string} sessionId
 * @param {string} term
 * @param {(list: ListMessage, id: string) => RowPayload | null} rowOf the page's `sessionRow`
 * @returns {{ close: string } | { stay: RowPayload, working: boolean }}
 */
export function dialogFollows(list, sessionId, term, rowOf) {
  const row = rowOf(list, sessionId);
  if (row === null) {
    return { close: END_TEXTS.gone };
  }
  if (row.done) {
    return { close: END_TEXTS.doneElsewhere };
  }
  const terminal = list.terminals.find((candidate) => candidate.id === term);
  const over =
    terminal === undefined ||
    terminal.state === 'ended' ||
    terminal.state === 'lost' ||
    terminal.state === 'not-started';
  if (over || row.terminal !== term || row.state === 'not-running') {
    return { close: END_TEXTS.stopped };
  }
  return { stay: row, working: row.state === 'working' };
}
