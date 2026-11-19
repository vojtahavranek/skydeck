// What the new form starts from (S2 12.6): the session it takes its directory from, that session's
// group as the Group field's one suggestion (follow-up F28), and the groups the list shows as the
// field's completions. Pure: no DOM, so that node:test loads it (test/web/new-form-text.test.ts);
// app.js gives its answer to cards.js's `newForm` when the form opens.

/** @import { ListMessage, RowPayload } from '../src/window/protocol.ts' */
import { sanitize } from './list-text.js';
import { sessionRow } from './pane.js';

/**
 * @typedef {object} NewFormDefaults
 * @property {string} dir the Directory field's text: the session's directory, else the most
 *   recent known one, else ''
 * @property {string[]} dirs the known project directories, most recent first (the list's `dirs`)
 * @property {string | null} group the group the session is in, as the list shows it (its stored
 *   group, or the key at the start of its title); null when there is no such session or it is in
 *   no group. The form shows it as a chip and never puts it into the field by itself.
 * @property {string[]} groups the groups of the list's sessions, each once, as the list shows
 *   them: `group` first, then the others in the list's order
 */

/**
 * A group as the list shows it: through the page's sanitiser (design 7.4; the server sanitised it
 * already, and the page decides for itself, list-text.js), so that the chip, its title and the
 * field get the text the user sees; null for none, also for one that shows as nothing.
 * @param {string | null} group
 * @returns {string | null}
 */
function shown(group) {
  const text = group === null ? '' : sanitize(group);
  return text === '' ? null : text;
}

/**
 * The session the form starts from: the selected session's row while the list shows it, or while
 * a terminal of the window shows it although the list does not (a hidden selection, E13; ruled on
 * review 2 of stage E: its header was what the user saw). null for no selection, a hidden one
 * without a terminal of the window, or a session the list has no row of.
 * @param {ListMessage | null} list
 * @param {string | null} selected
 * @returns {RowPayload | null}
 */
function sourceRow(list, selected) {
  const row = sessionRow(list, selected);
  if (row === null || list === null) {
    return null;
  }
  const listed = list.sections.some((section) => section.rows.some((one) => one.id === row.id));
  return listed || row.terminal !== null ? row : null;
}

/**
 * The groups the list shows, each once, in its order: section by section, a closed block's
 * caption (F9: none of its rows is in `rows`) at its place among the rows — right before
 * `rows[at]`, or after the last row for `rows.length`, captions at one place in their order; one
 * placed past the rows is drawn by no list (web/list.js), so it is offered by none. A group is
 * its shown text (`shown`), exact: `abc` and `ABC`, `x` and `x `, NFC and NFD are different
 * groups. A row without one adds none.
 * @param {ListMessage | null} list
 * @returns {string[]}
 */
function listedGroups(list) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string | null} group */
  const add = (group) => {
    const text = shown(group);
    if (text !== null) {
      seen.add(text);
    }
  };
  for (const section of list?.sections ?? []) {
    const captions = section.closedStacks;
    /** @param {number} at */
    const captionsAt = (at) => {
      for (const caption of captions) {
        if (caption.at === at) {
          add(caption.group);
        }
      }
    };
    section.rows.forEach((row, at) => {
      captionsAt(at);
      add(row.group);
    });
    captionsAt(section.rows.length);
  }
  return [...seen];
}

/**
 * What the new form starts from, for the list the page has and its selected session id.
 * @param {ListMessage | null} list
 * @param {string | null} selected
 * @returns {NewFormDefaults}
 */
export function newFormDefaults(list, selected) {
  const dirs = [...(list?.dirs ?? [])];
  const row = sourceRow(list, selected);
  const own = shown(row?.group ?? null);
  const others = listedGroups(list).filter((one) => one !== own);
  return {
    dir: row?.dir ?? dirs[0] ?? '',
    dirs,
    group: own,
    groups: own === null ? others : [own, ...others],
  };
}
