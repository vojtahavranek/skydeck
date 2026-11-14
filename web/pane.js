// What the right side shows for the selection (S2 12.6, plan 2.9): the terminal view for a row
// with a terminal (with the ended bar when it ended, S2 7.8), the card of a session running
// elsewhere (S2 7.9), the resume card, or the new form. Pure: no DOM, so that node:test loads it
// (test/web/pane.test.ts); app.js applies the answer to the modules of the right side.

/** @import { RowPayload, TerminalPayload } from '../src/window/protocol.ts' */

/**
 * @typedef {{ kind: 'terminal', row: RowPayload | null, term: TerminalPayload, ended: boolean }
 *   | { kind: 'elsewhere', row: RowPayload }
 *   | { kind: 'resume', row: RowPayload }
 *   | { kind: 'new' }
 *   | { kind: 'none' }} Pane
 */

/** The terminal states that show the last screen under the ended bar (S2 7.8; hub.ts). */
const ENDED = new Set(['ended', 'lost', 'not-started']);

/**
 * @param {TerminalPayload} term
 * @returns {boolean}
 */
export function isEnded(term) {
  return ENDED.has(term.state);
}

/**
 * The pane for the selected session `selected` (a session id or null), given the list's rows and
 * terminals and whether the new form is open. A row's `terminal` names its terminal, also a
 * starting or an ended one (task 13); a selected session that the list does not show (filtered
 * out) still shows a terminal that holds it.
 * @param {string | null} selected
 * @param {readonly RowPayload[]} rows
 * @param {readonly TerminalPayload[]} terminals
 * @param {boolean} newOpen
 * @returns {Pane}
 */
export function paneFor(selected, rows, terminals, newOpen) {
  if (newOpen) {
    return { kind: 'new' };
  }
  if (selected === null) {
    return { kind: 'none' };
  }
  const row = rows.find((candidate) => candidate.id === selected) ?? null;
  const termId =
    row !== null
      ? row.terminal
      : (terminals.find((term) => term.sessionId === selected)?.id ?? null);
  const term = termId === null ? undefined : terminals.find((candidate) => candidate.id === termId);
  if (term !== undefined) {
    return { kind: 'terminal', row, term, ended: isEnded(term) };
  }
  if (row === null) {
    return { kind: 'none' };
  }
  if (row.elsewhere !== null) {
    return { kind: 'elsewhere', row };
  }
  return { kind: 'resume', row };
}
