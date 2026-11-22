// Follow-up F39 (S2 12.13): the short settings screen's one table, pure (no DOM): its groups in
// order, each with its settings — a choice of the page's own (`local`: the theme, web/theme.js),
// or a key of config.json, named as in the server's table (src/window/settings.ts), with its plain
// label, a hint only where the label alone would mislead, and its control. A new setting, or a new
// group, joins the screen by one entry here; web/settings.js draws whatever this table holds.
// The page decides no rule (S2 4.3): a key's value is still checked and saved by the server, and
// a choice's words name exactly the values the server's table takes (test/web/settings-short.test.ts
// holds the two equal).

/**
 * A choice of the page's own: the theme's mode, or the colour theme of the scheme shown.
 * @typedef {object} LocalEntry
 * @property {'mode' | 'palette'} local
 * @property {string} label
 * @property {string | null} hint
 */

/**
 * A group of the short screen.
 * @typedef {object} ShortGroup
 * @property {string} id  stable, for the page's elements (`data-group`)
 * @property {string} title
 * @property {readonly LocalEntry[]} entries
 */

/** @type {readonly ShortGroup[]} */
export const SHORT = [
  {
    id: 'appearance',
    title: 'Appearance',
    entries: [
      { local: 'mode', label: 'Mode', hint: null },
      { local: 'palette', label: 'Colour theme', hint: 'Light and dark each keep their own.' },
    ],
  },
];
