// Follow-up F39 (S2 12.13): the short settings screen's one table, pure (no DOM): its groups in
// order, each with its settings — a choice of the page's own (`local`: the theme, web/theme.js),
// or a key of config.json, named as in the server's table (src/window/settings.ts), with its plain
// label, a hint only where the label alone would mislead, and its control. A new setting, or a new
// group, joins the screen by one entry here; web/settings.js draws whatever this table holds, and
// the screen's Advanced holds every key of the server's table that this one does not name.
// The page decides no rule (S2 4.3): a key's value is still checked and saved by the server, and
// a choice's words name exactly the values the server's table takes, a switch's two values two of
// them (test/web/settings-short.test.ts holds the two tables together).

/**
 * A choice of the page's own: the theme's mode, or the colour theme of the scheme shown.
 * @typedef {object} LocalEntry
 * @property {'mode' | 'palette'} local
 * @property {string} label
 * @property {string | null} hint
 */

/**
 * A key of config.json: a choice (`words`: each of the server's values in plain words, in its
 * order), a switch (`on` and `off`: the value each side saves) or a one-line text.
 * @typedef {{ key: string, label: string, hint: string | null } & (
 *   | { control: 'choice', words: Readonly<Record<string, string>> }
 *   | { control: 'switch', on: string, off: string }
 *   | { control: 'text' }
 * )} KeyEntry
 */

/**
 * A group of the short screen.
 * @typedef {object} ShortGroup
 * @property {string} id  stable, for the page's elements (`data-group`)
 * @property {string} title
 * @property {readonly (LocalEntry | KeyEntry)[]} entries
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
  {
    id: 'links',
    title: 'Links',
    entries: [
      {
        key: 'window.links',
        label: 'Open links in',
        hint: null,
        control: 'choice',
        words: { default: 'The default browser', edge: 'Edge' },
      },
      {
        key: 'ticketUrl',
        label: 'Ticket address',
        hint: 'With {key} where the ticket key goes. Empty: no link.',
        control: 'text',
      },
    ],
  },
  {
    id: 'window',
    title: 'The window',
    entries: [
      {
        key: 'window.keepAlive',
        label: 'Keep WSL running',
        hint: null,
        control: 'switch',
        on: 'wsl',
        off: 'off',
      },
      {
        key: 'terminal',
        label: 'Typed commands start sessions in',
        hint: 'skydeck resume, new and restore, typed in a terminal.',
        control: 'choice',
        words: { here: 'That terminal', wezterm: 'A WezTerm tab', window: 'The window' },
      },
    ],
  },
  {
    // F38: the check for a newer skydeck; web/settings.js puts its extra block (the last check,
    // `Check now`) after the switch.
    id: 'updates',
    title: 'Updates',
    entries: [
      {
        key: 'window.updateCheck',
        label: 'Check for updates every day',
        hint: null,
        control: 'switch',
        on: 'daily',
        off: 'off',
      },
    ],
  },
];

/** The keys of config.json the short screen shows; the screen's Advanced holds every other one. */
export const SHORT_KEYS = new Set(
  SHORT.flatMap((group) => group.entries.flatMap((entry) => ('key' in entry ? [entry.key] : []))),
);
