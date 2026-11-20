// The row under the list's filter field (S2 12.8; plan E task 97, E4; follow-up F35): four chips,
// the FILTERS `Running`, `Open PR`, `Has note` and `Done`, buttons that each show whether they are
// on (`aria-pressed`), in a group of their own; and at the end of the same row, apart from them,
// the switch `Show done`, which ADDS the done sessions: a labelled check box (a button with
// `role="checkbox"` and `aria-checked`, so that Tab reaches it and Enter or Space presses it as a
// chip). While the chip `Done` is on, the switch keeps its state and is drawn dimmed, its tooltip
// saying why: that chip lists the done sessions by itself. What a chip or the switch does is the
// list's (web/list.js keeps the state and sends it in the page's `view`: `chips`, `showDone`);
// which rows they leave is the server's. A mousedown on a chip or on the switch is cancelled, so
// that a click leaves the keyboard where it was (D17): in the filter field, on the list, in the
// terminal. Their words are fixed; nothing from the server reaches them.

/** @import { SearchChip } from '../src/window/protocol.ts' */

/** The chips in the order shown, with their words and tooltips (S2 12.8). */
export const CHIPS = /** @type {const} */ ([
  ['running', 'Running', 'only the sessions under Open'],
  ['open-pr', 'Open PR', 'only the sessions with a pull request that is not merged or closed'],
  ['note', 'Has note', 'only the sessions with a note'],
  ['done', 'Done', 'only sessions marked done'],
]);

/** The switch's words and its tooltips: as it is, and dimmed while the chip `Done` is on. */
export const SHOW_DONE = {
  text: 'Show done',
  tip: 'also list sessions marked done (a)',
  dimmedTip: 'the Done filter lists done sessions by itself',
};

/**
 * @param {HTMLElement} root the row under the filter field (list.js makes it)
 * @param {{ toggle(chip: SearchChip): void, showDone(): void }} hooks
 * @returns {{ render(chips: readonly string[], showDone: boolean): void }}
 */
export function createChips(root, hooks) {
  const group = document.createElement('div');
  group.className = 'list-chips';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Narrow the list');
  /** @type {Map<SearchChip, HTMLButtonElement>} */
  const buttons = new Map();
  for (const [chip, text, tip] of CHIPS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-chip';
    button.dataset.chip = chip;
    button.textContent = text;
    button.title = tip;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => hooks.toggle(chip));
    buttons.set(chip, button);
  }
  group.replaceChildren(...buttons.values());

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'list-switch';
  toggle.setAttribute('role', 'checkbox');
  toggle.setAttribute('aria-checked', 'false');
  toggle.dataset.dimmed = 'false';
  toggle.title = SHOW_DONE.tip;
  const box = document.createElement('span');
  box.className = 'list-switch-box';
  box.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'list-switch-text';
  label.textContent = SHOW_DONE.text;
  toggle.append(box, label);
  toggle.addEventListener('mousedown', (event) => event.preventDefault());
  toggle.addEventListener('click', () => hooks.showDone());
  root.replaceChildren(group, toggle);

  /**
   * Shows which chips are on (those `chips` names), the switch checked while `showDone`, and
   * dimmed, with its other tooltip, while the chip `Done` is on.
   * @param {readonly string[]} chips
   * @param {boolean} showDone
   */
  const render = (chips, showDone) => {
    for (const [chip, button] of buttons) {
      const pressed = String(chips.includes(chip));
      if (button.getAttribute('aria-pressed') !== pressed) {
        button.setAttribute('aria-pressed', pressed);
      }
    }
    const checked = String(showDone);
    if (toggle.getAttribute('aria-checked') !== checked) {
      toggle.setAttribute('aria-checked', checked);
    }
    const dimmed = chips.includes('done');
    if (toggle.dataset.dimmed !== String(dimmed)) {
      toggle.dataset.dimmed = String(dimmed);
    }
    const tip = dimmed ? SHOW_DONE.dimmedTip : SHOW_DONE.tip;
    if (toggle.title !== tip) {
      toggle.title = tip;
    }
  };

  return { render };
}
