// What the right side shows for the selection (S2 12.6, plan 2.9): the terminal view for a row
// with a terminal (with the ended bar when it ended, S2 7.8), the card of a session running
// elsewhere (S2 7.9), the resume card, or the new form. Pure: no DOM, so that node:test loads it
// (test/web/pane.test.ts); app.js applies the answer to the modules of the right side.

/** @import { ListMessage, RowPayload, TerminalPayload } from '../src/window/protocol.ts' */

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
 * The selected session's row (S2 12.9, plan E13): the sections' row of `id`, else the list's
 * `selectedRow` when its id is `id` (the server's answer can be for the selection before, until
 * the next list or while the connection is lost), else null — also for a null list or id. The one
 * helper for it: app.js's call of `paneFor`, the header's `edit` and `done` (stage D), the New
 * form's directory (a hidden row's only while it has a terminal) and `editor.update` use it; the
 * list keys take the sections' row only, and act on no session the list does not show.
 * @param {ListMessage | null} list
 * @param {string | null} id
 * @returns {RowPayload | null}
 */
export function sessionRow(list, id) {
  if (list === null || id === null) {
    return null;
  }
  for (const section of list.sections) {
    const row = section.rows.find((candidate) => candidate.id === id);
    if (row !== undefined) {
      return row;
    }
  }
  const hidden = list.selectedRow ?? null;
  return hidden !== null && hidden.id === id ? hidden : null;
}

/**
 * The pane for the selected session `selected` (a session id or null), given the list's rows and
 * terminals and whether the new form is open. A row's `terminal` names its terminal, also a
 * starting or an ended one (task 13). A selected session that the rows lack is decided by
 * `selectedRow` (what `sessionRow` gave, E13) when it is that session's: by its `terminal` too,
 * but without a terminal it shows nothing — no card for a session the list does not show (S2
 * 12.9, ruled). Without such a row, a terminal that holds the session is still shown, with row
 * null (stage A).
 * @param {string | null} selected
 * @param {readonly RowPayload[]} rows
 * @param {readonly TerminalPayload[]} terminals
 * @param {boolean} newOpen
 * @param {RowPayload | null} [selectedRow]
 * @returns {Pane}
 */
export function paneFor(selected, rows, terminals, newOpen, selectedRow = null) {
  if (newOpen) {
    return { kind: 'new' };
  }
  if (selected === null) {
    return { kind: 'none' };
  }
  const listed = rows.find((candidate) => candidate.id === selected) ?? null;
  const hidden = listed === null && selectedRow?.id === selected ? selectedRow : null;
  const row = listed ?? hidden;
  const termId =
    row !== null
      ? row.terminal
      : (terminals.find((term) => term.sessionId === selected)?.id ?? null);
  const term = termId === null ? undefined : terminals.find((candidate) => candidate.id === termId);
  if (term !== undefined) {
    return { kind: 'terminal', row, term, ended: isEnded(term) };
  }
  if (listed === null) {
    return { kind: 'none' };
  }
  if (listed.elsewhere !== null) {
    return { kind: 'elsewhere', row: listed };
  }
  return { kind: 'resume', row: listed };
}
