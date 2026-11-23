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
 *   | { kind: 'group', section: string, group: string, size: number, needYou: number }
 *   | { kind: 'none' }} Pane
 * `group` (F9): a closed block's caption is selected — the pane shows a small card of the group, no
 * terminal, and nothing has the keyboard.
 */

/** The terminal states that show the last screen under the ended bar (S2 7.8; hub.ts). */
const ENDED = new Set(['ended', 'lost', 'not-started']);

/**
 * The terminal states in which a terminal may still come to hold a session (S2 7.5): ENDED's exact
 * complement. A COPY OF THE SERVER'S SET (`MAY_START`, src/window/view/sections.ts), held equal to
 * it, and with ENDED parting every state, by test/web/pane.test.ts; a change of one is a change of
 * the other. web/list.js reads it to tell which line ← and a click on the caption say on a block
 * that an unreported terminal holds open (F6).
 * @type {ReadonlySet<string>}
 */
export const MAY_START = new Set(['starting', 'running', 'reconnecting', 'newer-keeper']);

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

/**
 * F9: the block of `group` in the section `section` as `list` draws it — its closed caption
 * (`closedStacks`), or the rows of its open card (each with a `stack` of that group) —, as the
 * number of its sessions and how many of them need you; null when the section draws neither (no
 * such block, the section folded, or a word typed: no block then; F35: under chips alone the
 * blocks are drawn). The group card of the pane and
 * the list's rule for a selected caption read it.
 * @param {ListMessage | null} list
 * @param {string} section
 * @param {string} group
 * @returns {{ size: number, needYou: number } | null}
 */
export function blockInfo(list, section, group) {
  const part = list?.sections.find((candidate) => candidate.name === section);
  if (part === undefined) {
    return null;
  }
  const caption = part.closedStacks.find((candidate) => candidate.group === group);
  if (caption !== undefined) {
    return { size: caption.size, needYou: caption.needYou };
  }
  const rows = part.rows.filter((row) => (row.stack ?? null)?.group === group);
  if (rows.length === 0) {
    return null;
  }
  return {
    size: rows[0]?.stack?.size ?? rows.length,
    needYou: rows.filter((row) => row.attention !== null).length,
  };
}

/**
 * Follow-up F40 (S2 12.9, "The selection follows its terminal"): the session the selection
 * follows to, or null. When the list drawn until now (`before`) had the selected session shown by
 * a terminal T — its row's `terminal` (a hidden selection without a row: a terminal that holds
 * it), whose `sessionId` was the selection — and in the list that came (`list`) T is still there,
 * not ended, shows ANOTHER session, and the selected session's row no longer has T, that other
 * session (after `/clear`, an in-session `/resume` or a fork inside T: the page cannot tell them
 * apart). Pure.
 * @param {ListMessage | null} before
 * @param {ListMessage} list
 * @param {string | null} selected
 * @returns {string | null}
 */
export function movedWith(before, list, selected) {
  if (before === null || selected === null) {
    return null;
  }
  const row = sessionRow(before, selected);
  const termId =
    row !== null
      ? row.terminal
      : (before.terminals.find((term) => term.sessionId === selected)?.id ?? null);
  const was = termId === null ? undefined : before.terminals.find((term) => term.id === termId);
  if (was === undefined || was.sessionId !== selected) {
    return null;
  }
  const now = list.terminals.find((term) => term.id === was.id);
  if (now === undefined || isEnded(now) || now.sessionId === null || now.sessionId === selected) {
    return null;
  }
  if (sessionRow(list, selected)?.terminal === now.id) {
    return null;
  }
  return now.sessionId;
}

/**
 * F40: the most-recently-used order after the selection followed its terminal from `from` to
 * `to`: `to` takes `from`'s place (any other `to` dropped), or comes first when `from` is not
 * there — so that the "previous" chord goes to the session the user came from, not to `from`.
 * @param {readonly string[]} mru
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function movedMru(mru, from, to) {
  if (from === to) {
    return [...mru];
  }
  if (!mru.includes(from)) {
    return [to, ...mru.filter((id) => id !== to)];
  }
  return mru.filter((id) => id !== to).map((id) => (id === from ? to : id));
}
