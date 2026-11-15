// The chips under the list's filter field (S2 12.8; plan E task 97, E4): `Running`, `Open PR`,
// `Has note` and `Show done`, four buttons that each show whether they are on (`aria-pressed`).
// What a chip does is the list's (web/list.js keeps the state and sends it in the page's `view`);
// which rows a chip leaves is the server's. A mousedown on a chip is cancelled, so that a click
// leaves the keyboard where it was (D17): in the filter field, on the list, in the terminal.
// The buttons' words are fixed; nothing from the server reaches them.

/** @typedef {'running' | 'open-pr' | 'note' | 'done'} Chip */

/** The chips in the order shown, with their words (S2 12.8). */
const CHIPS = /** @type {const} */ ([
  ['running', 'Running', 'only the sessions under Open'],
  ['open-pr', 'Open PR', 'only the sessions with a pull request that is not merged or closed'],
  ['note', 'Has note', 'only the sessions with a note'],
  ['done', 'Show done', 'also the sessions marked done (a)'],
]);

/**
 * @param {HTMLElement} root the row of chips under the filter field (list.js makes it)
 * @param {{ toggle(chip: Chip): void }} hooks
 * @returns {{ render(chips: readonly string[], showDone: boolean): void }}
 */
export function createChips(root, hooks) {
  /** @type {Map<Chip, HTMLButtonElement>} */
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
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Narrow the list');
  root.replaceChildren(...buttons.values());

  /**
   * Shows which chips are on: those `chips` names, and `Show done` while `showDone`.
   * @param {readonly string[]} chips
   * @param {boolean} showDone
   */
  const render = (chips, showDone) => {
    for (const [chip, button] of buttons) {
      const pressed = String(chip === 'done' ? showDone : chips.includes(chip));
      if (button.getAttribute('aria-pressed') !== pressed) {
        button.setAttribute('aria-pressed', pressed);
      }
    }
  };

  return { render };
}
