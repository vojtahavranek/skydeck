// The key help (S2 12.9, Ctrl+Shift+H; plan task 29): every key of S2 12.9 and of the list zone
// (stage D's `l`, F2, `g`, `n`, `p`, `d` with plan D task 37; stage B's Ctrl+Shift+J with plan B
// task 55; stage E's Ctrl+Shift+P with plan E task 98, whose field's keys are named as plain text
// in its line, not as keys of a zone), a note on stage D's dialogs, the note for a browser tab and
// the note on the Claude Code bindings the window shadows, and (follow-up F36) the note on the
// settings screen, which has no key of its own; (follow-up F41) under its title, `Take the tour`,
// which starts the tour of the window again (web/tour.js) whether it was seen or not. No key comes
// in a later stage any more (A11's marking is gone with stage E). Its interface is contract 2.9's.
// Every key it names is one web/keys.js handles in that zone, and every key keys.js handles is
// named here (test-page/cards.test.ts reads the help and checks both against keys.js).

/**
 * The sections: who has the key, and its lines — the keys (one `kbd` each; "Ctrl+Shift+1…9" is
 * the nine slots) and what they do.
 * @type {{ zone: 'window' | 'terminal' | 'list', title: string, lines: [string[], string][] }[]}
 */
const SECTIONS = [
  {
    zone: 'window',
    title: 'The window’s own keys, wherever the keyboard is',
    lines: [
      [['Ctrl+Shift+1…9'], 'the session in that slot (the numbers in Open)'],
      [['Ctrl+Tab', 'Ctrl+Shift+O'], 'back to the previous session'],
      [['Ctrl+Shift+L'], 'the keyboard between the list and the terminal'],
      [['Ctrl+Shift+N'], 'a new session'],
      [['Ctrl+Shift+F'], 'find in the terminal’s scrollback'],
      [
        ['Ctrl+Shift+C'],
        'copy the terminal’s selection (one made with the mouse is copied as you let go, unless Copy on select is off in Settings)',
      ],
      [['Ctrl+Shift+V'], 'send a raw Ctrl+V (Claude Code’s image paste)'],
      [['Ctrl+Shift+H'], 'this help, and away again'],
      [
        ['Ctrl+Shift+R', 'Refresh', 'Shift+Refresh', 'Ctrl+Refresh'],
        'reload the page, once skydeck’s server has proven itself (Refresh: the keyboard’s refresh key)',
      ],
      [
        ['Ctrl+Shift+P'],
        'the quick switcher: every session, done ones too — type to narrow; in it ↑ ↓ move, Enter switches to the session or resumes it, Esc closes',
      ],
      [['Ctrl+Shift+J'], 'the next session that needs you; again goes on'],
    ],
  },
  {
    zone: 'terminal',
    title: 'In the terminal: every other key goes to Claude Code',
    lines: [
      [['Ctrl+V'], 'paste text'],
      [['Shift+Enter'], 'a new line'],
      [['Ctrl+click'], 'open a link'],
      [['Alt+F4'], 'close the window, as any window; it never reaches the program'],
    ],
  },
  {
    zone: 'list',
    title: 'In the list',
    lines: [
      [['↑', '↓', 'j', 'k'], 'move'],
      [
        ['Shift+↑', 'Shift+↓', 'Shift+K', 'Shift+J'],
        'move the session up or down in Open; the slot numbers follow',
      ],
      [['Home', 'End', 'PgUp', 'PgDn'], 'the first, the last, a page up, a page down'],
      [['←', '→'], 'fold or unfold Earlier; close or open a group'],
      [['Enter'], 'show a running session’s terminal; resume one that is not running'],
      [['/'], 'filter: several words, all must match, also the start of the short id'],
      [['a'], 'show or hide done sessions'],
      [['Esc'], 'clear the filter, then back to the terminal'],
      [
        ['F5', 'Shift+F5', 'Ctrl+F5', 'Ctrl+R'],
        'reload the page, once skydeck’s server has proven itself',
      ],
      [['l', 'F2'], 'label'],
      [['g'], 'group'],
      [['n'], 'note'],
      [['t'], 'ticket: a link, or a key when a ticket address is set (Settings)'],
      [['p'], 'pull requests: attach one'],
      [['d'], 'done, or undone for a done session (an Undo follows a done)'],
      [['c'], 'carry over after /clear: to the offer of the selected session'],
      [
        ['f'],
        'other flags: resume a session that is not running with flags you choose, from its card or its ended bar',
      ],
    ],
  },
];

const NOTES = [
  'Esc in the terminal is Claude Code’s and never leaves the terminal; so are F5, Shift+F5, Ctrl+F5 and Ctrl+R while the terminal has the keyboard (while the page has it — the new form, a card, the find bar — they reload the page, as in the list). Esc in the new form closes it, and Esc in a resume card’s Other flags… goes back to the card.',
  'In a dialog (label, group, note, ticket, pull requests) Enter saves — Ctrl+Enter in the note, where Enter is a new line — and Esc, Cancel or Close closes it; a changed note needs Esc twice. While a dialog is open the window’s keys do nothing but Ctrl+Shift+H, and the reload keys while no text was changed: close it first (Esc).',
  'The gear at the right of the title bar (or > settings in the quick switcher) opens Settings: the window’s theme and the settings worth changing, each saved as you pick it; every other one under Advanced, where a program, a folder or the port is changed in the file only. In it Tab walks the settings, Enter saves the field you are in (so does leaving it), Esc closes and drops a text not saved.',
  'In a browser tab (skydeck window --print-url) the browser keeps Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and their Shift forms for itself: use Ctrl+Shift+O for the previous session and + New in the key bar for a new one.',
  'The window takes Ctrl+Shift with a letter or a digit, and Ctrl+Tab, for itself. A Claude Code binding on one of them (ctrl+shift+<key>, which a terminal with the kitty keyboard protocol could send) never reaches Claude Code; Ctrl+Shift+-, Alt, Ctrl with a letter and the function keys stay Claude Code’s.',
];

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
 * @param {HTMLElement} root
 * @param {{ tour: () => void }} deps  `tour`: `Take the tour` was pressed (app.js's gate decides)
 */
export function createHelp(root, deps) {
  const box = element('div', 'help-box');
  const title = element('div', 'help-title');
  title.append('Keys ', element('span', 'help-close', '· Ctrl+Shift+H closes this'));
  box.append(title);
  // F41: a click on it moves no keyboard, so that the tour gives it back where it was.
  const again = element('div', 'help-again');
  const tour = /** @type {HTMLButtonElement} */ (element('button', 'help-tour', 'Take the tour'));
  tour.type = 'button';
  tour.addEventListener('mousedown', (event) => event.preventDefault());
  tour.addEventListener('click', () => deps.tour());
  again.append(
    tour,
    element('span', 'help-what', 'a minute’s walk round the window, step by step'),
  );
  box.append(again);
  for (const section of SECTIONS) {
    const part = element('div', 'help-section');
    part.dataset['zone'] = section.zone;
    part.append(element('div', 'help-heading', section.title));
    for (const [keys, what] of section.lines) {
      const line = element('div', 'help-line');
      const names = element('span', 'help-keys');
      for (const key of keys) {
        names.append(element('kbd', '', key));
      }
      line.append(names, element('span', 'help-what', what));
      part.append(line);
    }
    box.append(part);
  }
  const notes = element('div', 'help-notes');
  for (const note of NOTES) {
    notes.append(element('p', 'help-note', note));
  }
  box.append(notes);
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
