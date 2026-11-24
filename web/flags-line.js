// F15's flags line (S2 12.6) as one component: the New form's and, issue #188, the resume card's
// "Other flags…" (web/cards.js) and, part 2 of #188, the dialog "Restart"'s (web/restart-dialog.js).
// A module of its own, so that a page whose cards module is a test's stand-in still has it.

/** @import { ResultMessage } from '../src/window/protocol.ts' */
import { favouriteControls } from './favourites.js';

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

/**
 * The label `Flags for claude`, the field (monospace; its accessible name the label's words alone,
 * `id`, not the ★'s too), the ★ at its end, and the line of favourite chips under it
 * (favourites.js), which the caller puts right after `line`. `hint` and `lines` are the form's
 * hint and result lines (the ★'s Undo and a favourite's refusal go there).
 * @param {object} parts
 * @param {HTMLFormElement} parts.form
 * @param {HTMLElement} parts.hint
 * @param {HTMLElement} parts.lines
 * @param {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} parts.act
 * @param {string} parts.id the id of the label's words, unique in the page
 * @param {string} parts.placeholder
 * @param {string} parts.value the field's text to start with (before the chips are drawn, so that
 *   each starts on or off by it)
 * @returns {{ line: HTMLElement, flags: HTMLInputElement, favourites: ReturnType<typeof favouriteControls> }}
 */
export function flagsControls({ form, hint, lines, act, id, placeholder, value }) {
  const flags = /** @type {HTMLInputElement} */ (element('input', 'card-field mono'));
  flags.name = 'flags';
  flags.value = value;
  flags.spellcheck = false;
  flags.placeholder = placeholder;
  const words = element('span', 'card-label', 'Flags for claude');
  words.id = id;
  flags.setAttribute('aria-labelledby', id);
  const favourites = favouriteControls({ form, flags, hint, lines, act });
  const withStar = element('span', 'card-flags');
  withStar.append(flags, favourites.star);
  const line = element('label', 'card-form-line');
  line.append(words, withStar);
  return { line, flags, favourites };
}
