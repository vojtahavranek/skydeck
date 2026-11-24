// Follow-up F41's words for the page, pure (no DOM): the steps of the tour of the window
// (web/tour.js), each pointing at one region of the page, in the words of the mode the page runs
// in — the app window, or a browser tab, where the browser keeps Ctrl+Tab and Ctrl+Shift+N for
// itself (S2 12.9) —; the panel's words; the page's storage key that marks the tour seen; and
// where the panel goes beside its region (`placeNear`). A line is made of parts: text, a key
// (`key`, named as the key help names it, with the zone keys.js classifies it in), the words of a
// control of the page (`ui`, with the element that carries them) and a text to type (`typed`: the
// quick switcher's `> tour` and `> restore`, and the command `skydeck window`).
// test/web/tour-text.test.ts holds every key against web/keys.js and every typed text against the
// server's commands; test-page/tour.test.ts every control against the page.

/** @typedef {'app' | 'tab'} Mode */
/** @typedef {'list' | 'right' | 'keybar' | 'switch' | 'settings'} Region */
/**
 * @typedef {string | { key: string, zone: 'window' | 'list' } | { ui: string, at: string }
 *   | { typed: string }} Part
 */
/** @typedef {{ region: Region, title: string, lines: Part[][] }} TourStep */
/** @typedef {{ left: number, top: number, width: number, height: number }} Box */

/** The element of each region (web/index.html). */
export const REGIONS = /** @type {const} */ ({
  list: '#list-zone',
  right: '#right-zone',
  keybar: '.keybar',
  switch: '#switch-button',
  settings: '#settings-button',
});

/** The page's own localStorage key (the theme's are web/theme-text.js's). */
export const TOUR_KEY = 'skydeck-tour';
/**
 * The mark a browser keeps once it has ended the tour, and the tour's version: the first version
 * wrote `seen`, this one `seen-2`. The tour starts by itself whenever the stored mark is not this
 * one, so a browser marked `seen` sees it once more. Raise it by hand (`seen-3`) only when the tour
 * changed enough that everyone should see it again; an update alone never raises it.
 */
export const TOUR_SEEN = 'seen-2';

export const TOUR_TEXTS = {
  /** The panel's name, for a screen reader. */
  label: 'A tour of the window',
  back: 'Back',
  next: 'Next',
  done: 'Done',
  skip: 'Skip the tour',
  /** The key bar's line for a window chord while the tour is shown (as the dialogs' are). */
  closeFirst: 'close the tour first (Esc)',
};

/**
 * `Step 2 of 7`.
 * @param {number} at  1 for the first step
 * @param {number} of
 * @returns {string}
 */
export function stepText(at, of) {
  return `Step ${at} of ${of}`;
}

/** @param {string} name @returns {Part} */
const windowKey = (name) => ({ key: name, zone: 'window' });
/** @param {string} name @returns {Part} */
const listKey = (name) => ({ key: name, zone: 'list' });
const FOCUS_LIST = { ui: 'Focus: list', at: '#focus-zone' };
const FOCUS_TERMINAL = { ui: 'Focus: terminal', at: '#focus-zone' };
const SWITCH = { ui: 'Switch…', at: '#switch-button' };

/**
 * The steps, in their order, in the words of `mode`.
 * @param {Mode} mode
 * @returns {TourStep[]}
 */
export function tourSteps(mode) {
  return [
    {
      region: 'list',
      title: 'The list',
      lines: [
        ['Every Claude Code session, one row each: those of this window and of any terminal.'],
        ['Open holds the running ones, Recent the last 7 days, Earlier the rest.'],
        ['A number 1–9 before a row of Open is its slot in the window.'],
      ],
    },
    {
      region: 'right',
      title: 'The right side',
      lines: [
        ['The selected session: its terminal, when it runs in this window.'],
        ['Otherwise its card: what it is about, and how to resume it here, with other flags too.'],
      ],
    },
    {
      region: 'keybar',
      title: 'Where the keyboard is',
      lines: [
        ['The key bar says it: ', FOCUS_LIST, ' or ', FOCUS_TERMINAL, '.'],
        [windowKey('Ctrl+Shift+L'), ' moves it between the list and the terminal.'],
        ['With ', FOCUS_TERMINAL, ' a letter you type goes to Claude Code.'],
      ],
    },
    {
      region: 'list',
      title: 'The list’s keys',
      lines: [
        [
          'With ',
          FOCUS_LIST,
          ' only: ',
          listKey('↑'),
          ' ',
          listKey('↓'),
          ' move, ',
          listKey('Enter'),
          ' shows or resumes the session.',
        ],
        [listKey('Shift+↑'), ' ', listKey('Shift+↓'), ' move a session up or down in Open.'],
        [
          listKey('l'),
          ' label · ',
          listKey('g'),
          ' group · ',
          listKey('n'),
          ' note · ',
          listKey('t'),
          ' ticket · ',
          listKey('p'),
          ' pull requests · ',
          listKey('d'),
          ' done · ',
          listKey('w'),
          ' park · ',
          listKey('r'),
          ' restart',
        ],
        [listKey('/'), ' filter · ', listKey('a'), ' show done sessions'],
      ],
    },
    {
      region: 'switch',
      title: 'Getting around',
      lines: [
        [SWITCH, ' (', windowKey('Ctrl+Shift+P'), ') finds any session by its words.'],
        [
          windowKey('Ctrl+Shift+1…9'),
          ' goes to a slot, ',
          windowKey(mode === 'tab' ? 'Ctrl+Shift+O' : 'Ctrl+Tab'),
          ' back to the previous session.',
        ],
        [windowKey('Ctrl+Shift+J'), ' goes to the next session that needs you.'],
        mode === 'tab'
          ? [{ ui: '+ New', at: '#new-button' }, ' in the key bar starts a new session.']
          : [windowKey('Ctrl+Shift+N'), ' starts a new session.'],
      ],
    },
    {
      region: 'list',
      title: 'After a restart',
      lines: [
        ['A restart of the PC or of WSL ends the running sessions.'],
        [
          'Run ',
          { typed: 'skydeck window' },
          ' again: the top of the list offers the ones that were open.',
        ],
        [
          'Restore brings the ticked ones back; after Not now, ',
          { typed: '> restore' },
          ' in ',
          SWITCH,
          ' offers it again.',
        ],
      ],
    },
    {
      region: 'settings',
      title: 'Settings and every key',
      lines: [
        [
          'The gear opens ',
          { ui: 'Settings', at: '#settings-button' },
          ': the theme, links, the window.',
        ],
        [windowKey('Ctrl+Shift+H'), ' shows every key.'],
        [
          'This tour again: ',
          { ui: 'Take the tour', at: '#help .help-tour' },
          ' in the key help, or ',
          { typed: '> tour' },
          ' in ',
          SWITCH,
        ],
      ],
    },
  ];
}

/**
 * Where the panel goes (its top left corner, whole pixels), beside `region` and inside the
 * viewport with `margin` to spare: to the region's right, else its left, else below it, else above
 * it, the first that fits — from the region's top (right, left) or its left edge (below, above),
 * moved in as far as the viewport needs —; when none fits, the middle of the viewport.
 * @param {Box} region
 * @param {{ width: number, height: number }} panel
 * @param {{ width: number, height: number }} viewport
 * @param {number} [gap]  between the region and the panel
 * @param {number} [margin]  between the panel and the viewport's edge
 * @returns {{ left: number, top: number }}
 */
export function placeNear(region, panel, viewport, gap = 12, margin = 8) {
  /** @param {number} value @param {number} size @param {number} room */
  const clamp = (value, size, room) => Math.max(margin, Math.min(value, room - size - margin));
  const right = region.left + region.width;
  const bottom = region.top + region.height;
  const across = clamp(region.left, panel.width, viewport.width);
  const down = clamp(region.top, panel.height, viewport.height);
  const candidates = [
    { left: right + gap, top: down, fits: right + gap + panel.width + margin <= viewport.width },
    {
      left: region.left - gap - panel.width,
      top: down,
      fits: region.left - gap - panel.width >= margin,
    },
    {
      left: across,
      top: bottom + gap,
      fits: bottom + gap + panel.height + margin <= viewport.height,
    },
    {
      left: across,
      top: region.top - gap - panel.height,
      fits: region.top - gap - panel.height >= margin,
    },
  ];
  const place = candidates.find((candidate) => candidate.fits) ?? {
    left: clamp((viewport.width - panel.width) / 2, panel.width, viewport.width),
    top: clamp((viewport.height - panel.height) / 2, panel.height, viewport.height),
  };
  return { left: Math.round(place.left), top: Math.round(place.top) };
}
