// Follow-up F40 (S2 12.6): the words of the carry-over bar, as pure functions. They put the
// server's texts into sentences and decide nothing: what is offered, kept and ticked is the
// server's (`list.selected.carryOver`, S2 8.2.3).

/** @import { CarryField, CarryOverPayload } from '../src/window/protocol.ts' */

export const DONE_TEXT = 'mark the old one done';
export const APPLY_TEXT = 'Carry over';
export const DISMISS_TEXT = '×';
export const DISMISS_TITLE = 'Dismiss: carry nothing over';
export const WAITING_TEXT = 'carrying over…';
/** `c` in the list on a pane without the bar (S2 12.9). */
export const NOTHING_TO_CARRY = 'nothing to carry over to this session';
/** A refusal without words (the server always gives some). */
export const NOT_CARRIED = 'skydeck could not carry the fields over';

/** The names of the fields in the kept line. @type {Readonly<Record<CarryField, string>>} */
const NAMES = {
  label: 'label',
  group: 'group',
  ticket: 'ticket',
  note: 'note',
  prs: 'pull requests',
};

/**
 * `Cleared from "<title>"`, and ` · <ticket>` when the old session has one.
 * @param {CarryOverPayload['from']} from
 * @returns {string}
 */
export function carryHeading(from) {
  const ticket = from.ticket === null || from.ticket === '' ? '' : ` · ${from.ticket}`;
  return `Cleared from "${from.title}"${ticket}`;
}

/**
 * A checkbox's words: `label`, `group <group>`, `ticket <name>`, `note`, `1 pull request` /
 * `<n> pull requests`.
 * @param {CarryOverPayload['fields'][number]} field
 * @param {number} prs how many pull requests `prs` would attach
 * @returns {string}
 */
export function fieldText(field, prs) {
  switch (field.name) {
    case 'group':
      return field.text === null ? 'group' : `group ${field.text}`;
    case 'ticket':
      return field.text === null ? 'ticket' : `ticket ${field.text}`;
    case 'prs':
      return prs === 1 ? '1 pull request' : `${prs} pull requests`;
    default:
      return NAMES[field.name];
  }
}

/**
 * `already set here: <names>` for the fields the new session has already; '' for none.
 * @param {readonly CarryField[]} kept
 * @returns {string}
 */
export function keptText(kept) {
  return kept.length === 0 ? '' : `already set here: ${kept.map((name) => NAMES[name]).join(', ')}`;
}
