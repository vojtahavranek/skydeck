// Issue #166's words and rules for the page, pure (no DOM): whether `r` or the header's `Restart`
// offers the dialog "Restart" (web/restart-dialog.js), what the dialog says, when it closes by
// itself, and what the toast and the ended bar say of each outcome. A session the window can
// restart is one it can end (`endable`, the server's rule: it runs in its terminal of the window,
// whose keeper knows how and is connected) that is not marked done; the server decides again.

/** @import { ListMessage, ResultMessage, RowPayload } from '../src/window/protocol.ts' */
import { END_TEXTS } from './end-text.js';

export const RESTART_TEXTS = {
  heading: 'Restart: ',
  line: 'It ends claude and resumes this session here, with the same flags.',
  /** The end dialog's own warning: a restart ends the program as an end does. */
  working: END_TEXTS.working,
  restart: 'Restart',
  other: 'Other flags…',
  cancel: 'Cancel',
  /** The hint of the dialog's Other flags…. */
  hint: 'restarts with these flags · Esc goes back',
  /** The dialog's line while the server restarts it. */
  pending: 'Restarting…',
  /** The toast once the session runs again. */
  restarted: 'Restarted.',
  /** The header's state while a restart holds the shown terminal. */
  state: 'restarting…',
  /** The dialog's Other flags… before the list brought what a plain resume passes on. */
  notYet: 'the flags it was started with are not here yet; press Other flags… again',
  /** The toasts of a dialog that closed by itself: nothing was done. */
  stopped: 'It stopped by itself: nothing was restarted.',
  doneElsewhere: 'It was marked done in another window: nothing was restarted.',
  gone: 'It left the list: nothing was restarted.',
  /** `r` (or `Restart`) on a session the window cannot restart. */
  noSession: 'no session selected',
  markedDone: 'r restarts no session marked done: mark it undone first (d)',
  notRunning: 'r restarts only a session that runs in a terminal of this window; Enter resumes one',
  elsewhere:
    'r restarts only a session that runs in a terminal of this window; this one runs in another terminal',
  background:
    "r restarts only a session that runs in a terminal of this window; this one runs in Claude Code's background",
  cannotEnd: 'skydeck cannot end this one, so it cannot restart it: end it in its terminal',
  restarting: 'skydeck is restarting this session',
};

/** The tooltip of the header's Restart (S2 12.5). */
export const RESTART_TIP = 'end claude and resume this session (r)';

/**
 * Whether `r` or `Restart` on `row` opens the dialog: a session not marked done that the window
 * can end, with its terminal on the row.
 * @param {RowPayload} row
 * @returns {boolean}
 */
export function offersRestart(row) {
  return !row.done && row.endable === true && typeof row.terminal === 'string';
}

/**
 * Why `r` on `row` opens no dialog (the toast), for a row `offersRestart` refuses.
 * @param {RowPayload} row
 * @param {boolean} restarting a restart holds the row's terminal now
 * @returns {string}
 */
export function noRestartText(row, restarting) {
  if (restarting) {
    return RESTART_TEXTS.restarting;
  }
  if (row.done) {
    return RESTART_TEXTS.markedDone;
  }
  if (row.elsewhere !== null) {
    return row.elsewhere.background === true ? RESTART_TEXTS.background : RESTART_TEXTS.elsewhere;
  }
  if (row.state === 'not-running' || typeof row.terminal !== 'string') {
    return RESTART_TEXTS.notRunning;
  }
  return RESTART_TEXTS.cannotEnd;
}

/**
 * What an answer of `act restart` means for the page: `stay` with the refusal for the dialog's line
 * (nothing was ended: the dialog stays open, the field keeps its text), else the toast's words and,
 * when the session ended and was not resumed, the line its ended bar shows (`bar`).
 * @param {ResultMessage} result
 * @returns {{ stay: string } | { toast: string, bar: string | null }}
 */
export function restartOutcome(result) {
  const why = result.error ?? result.lines.join(' ');
  if (result.ended === undefined) {
    return { stay: why === '' ? 'skydeck could not restart it' : why };
  }
  if (result.ended === false) {
    return { toast: `Not restarted: ${why}.`, bar: null };
  }
  if (result.ok) {
    return { toast: RESTART_TEXTS.restarted, bar: null };
  }
  const said = `Restart: it ended, but was not resumed: ${why}`;
  return { toast: said, bar: said };
}

/**
 * What a list means for the dialog of `sessionId` opened over its terminal `term`, before Restart
 * was pressed: `close` with the toast's words when the session left the list, was marked done
 * (elsewhere: this page is modal) or stopped running there — then nothing is done —, else `stay`
 * with its row and whether it works now.
 * @param {ListMessage} list
 * @param {string} sessionId
 * @param {string} term
 * @param {(list: ListMessage, id: string) => RowPayload | null} rowOf the page's `sessionRow`
 * @returns {{ close: string } | { stay: RowPayload, working: boolean }}
 */
export function restartFollows(list, sessionId, term, rowOf) {
  const row = rowOf(list, sessionId);
  if (row === null) {
    return { close: RESTART_TEXTS.gone };
  }
  if (row.done) {
    return { close: RESTART_TEXTS.doneElsewhere };
  }
  const terminal = list.terminals.find((candidate) => candidate.id === term);
  const over =
    terminal === undefined ||
    terminal.state === 'ended' ||
    terminal.state === 'lost' ||
    terminal.state === 'not-started';
  if (over || row.terminal !== term || row.state === 'not-running') {
    return { close: RESTART_TEXTS.stopped };
  }
  return { stay: row, working: row.state === 'working' };
}
