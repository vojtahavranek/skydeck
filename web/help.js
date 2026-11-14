// The key help (S2 12.9, Ctrl+Shift+H) — the smallest working version, replaced by task 29 (plan
// A16): the window's keys of stage A, and those of later stages marked so (A11). Its interface is
// contract 2.9's.

const KEYS = [
  ['Ctrl+Tab, Ctrl+Shift+O', 'back to the previous session'],
  ['Ctrl+Shift+1 … 9', 'the session in that slot'],
  ['Ctrl+Shift+L', 'focus between list and terminal'],
  ['Ctrl+Shift+N', 'new session'],
  ['Ctrl+Shift+F', 'find in the scrollback'],
  ['Ctrl+Shift+C, Ctrl+Shift+V', 'copy the selection, send a raw Ctrl+V'],
  ['Ctrl+Shift+H', 'this help'],
  ['Ctrl+Shift+P', 'quick switcher: comes in a later stage'],
  ['Ctrl+Shift+J', 'next session that needs you: comes in a later stage'],
];

/** @param {HTMLElement} root */
export function createHelp(root) {
  const box = document.createElement('div');
  box.className = 'help-box';
  const title = document.createElement('div');
  title.className = 'help-title';
  title.textContent = 'Keys';
  box.append(title);
  for (const [keys, what] of KEYS) {
    const line = document.createElement('div');
    line.className = 'help-line';
    line.textContent = `${keys}: ${what}`;
    box.append(line);
  }
  root.replaceChildren(box);
  root.hidden = true;
  return {
    toggle() {
      root.hidden = !root.hidden;
    },
    hide() {
      root.hidden = true;
    },
    /** @returns {boolean} */
    shown: () => !root.hidden,
  };
}
