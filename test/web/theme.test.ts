// The title bar's theme switch (follow-up F13; S2 12.1): its three states and the stored value
// each stands for, the order a click walks them in and what the button says (web/theme-text.js,
// pure); the script that applies the stored choice before the first paint (web/theme-early.js, a
// classic script, run here in a VM context of its own) reads exactly what theme-text.js reads; and
// every style sheet of web/ that has a dark scheme writes it twice — the system's, unless forced
// light, and forced dark — with the same declarations in the same order, so that forced dark is
// exactly the system's dark (the page suite compares the computed values, test-page/theme.test.ts).
// The colour themes of the second switch likewise: each scheme's themes and stored values, the
// order a click walks them, the words; the early script applies each scheme's stored theme by the
// same rule; and each theme of style.css and terminal-view.css is laid over its scheme as style.css
// says (a light one ahead of the dark scheme and within its properties, a dark one a block and its
// twin).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  nextPalette,
  nextTheme,
  PALETTE_KEYS,
  paletteOf,
  PALETTES,
  paletteTitle,
  paletteWord,
  THEME_KEY,
  themeOf,
  themeTitle,
  themeWord,
} from '../../web/theme-text.js';
import type { Palette, Scheme } from '../../web/theme-text.js';

const WEB = new URL('../../web/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, WEB), 'utf8');

/** Stored values that are neither `light` nor `dark`: each means the system's. */
const NOT_A_CHOICE: unknown[] = [
  null,
  undefined,
  '',
  'system',
  'auto',
  'Dark',
  'LIGHT',
  ' dark',
  'light ',
  '"dark"',
  'dark\n',
  'null',
  'true',
  1,
  {},
];

describe('the states and what the button says (web/theme-text.js)', () => {
  test('one key of the page’s localStorage', () => {
    assert.equal(THEME_KEY, 'skydeck-theme');
  });

  test('a stored `light` or `dark` is that state; anything else — none, another word, another case, white space — is the system’s', () => {
    assert.equal(themeOf('light'), 'light');
    assert.equal(themeOf('dark'), 'dark');
    for (const value of NOT_A_CHOICE) {
      assert.equal(themeOf(value), 'system', JSON.stringify(value) ?? String(value));
    }
  });

  test('a click goes Auto → Light → Dark → Auto', () => {
    assert.equal(nextTheme('system'), 'light');
    assert.equal(nextTheme('light'), 'dark');
    assert.equal(nextTheme('dark'), 'system');
  });

  test('the word of each state', () => {
    assert.equal(themeWord('system'), 'Auto');
    assert.equal(themeWord('light'), 'Light');
    assert.equal(themeWord('dark'), 'Dark');
  });

  test('the hover title says the state and what a click does', () => {
    assert.equal(themeTitle('system'), 'Theme: follows the system. Click for light.');
    assert.equal(themeTitle('light'), 'Theme: light. Click for dark.');
    assert.equal(themeTitle('dark'), 'Theme: dark. Click to follow the system.');
  });
});

/** Stored values that are no theme of either scheme: each means the default. */
const NO_THEME: unknown[] = [
  ...NOT_A_CHOICE,
  'default',
  'Iris',
  'PLEIADES',
  ' iris',
  'iris ',
  'light',
  'dark',
];

describe('the colour themes and what their button says (web/theme-text.js)', () => {
  test('one key of the page’s localStorage for each scheme', () => {
    assert.deepEqual(PALETTE_KEYS, {
      light: 'skydeck-palette-light',
      dark: 'skydeck-palette-dark',
    });
  });

  test('the themes of each scheme, the default first: Iris in both, Pleiades in dark only', () => {
    assert.deepEqual(PALETTES, {
      light: ['default', 'iris'],
      dark: ['default', 'iris', 'pleiades'],
    });
  });

  test('a stored theme of the scheme is that theme; anything else — none, another word, another case, white space, a theme of the other scheme only — is the default', () => {
    assert.equal(paletteOf('light', 'iris'), 'iris');
    assert.equal(paletteOf('dark', 'iris'), 'iris');
    assert.equal(paletteOf('dark', 'pleiades'), 'pleiades');
    assert.equal(paletteOf('light', 'pleiades'), 'default', 'Pleiades has no light colours');
    for (const scheme of ['light', 'dark'] as const) {
      for (const value of NO_THEME) {
        assert.equal(paletteOf(scheme, value), 'default', JSON.stringify(value) ?? String(value));
      }
    }
  });

  test('a click goes through the scheme’s themes and back to the default', () => {
    assert.equal(nextPalette('light', 'default'), 'iris');
    assert.equal(nextPalette('light', 'iris'), 'default');
    assert.equal(nextPalette('dark', 'default'), 'iris');
    assert.equal(nextPalette('dark', 'iris'), 'pleiades');
    assert.equal(nextPalette('dark', 'pleiades'), 'default');
  });

  test('the word and the hover title of each theme', () => {
    assert.equal(paletteWord('default'), 'Default');
    assert.equal(paletteWord('iris'), 'Iris');
    assert.equal(paletteWord('pleiades'), 'Pleiades');
    assert.equal(paletteTitle('light', 'default'), 'Light colours: Default. Click for Iris.');
    assert.equal(paletteTitle('light', 'iris'), 'Light colours: Iris. Click for Default.');
    assert.equal(paletteTitle('dark', 'default'), 'Dark colours: Default. Click for Iris.');
    assert.equal(paletteTitle('dark', 'iris'), 'Dark colours: Iris. Click for Pleiades.');
    assert.equal(paletteTitle('dark', 'pleiades'), 'Dark colours: Pleiades. Click for Default.');
  });
});

/** What theme-early.js leaves on `<html>` (its `data-theme` and the two colour themes' attributes,
 *  each null when not set) for `storage` in its window. */
function early(storage: () => unknown): {
  theme: string | null;
  light: string | null;
  dark: string | null;
} {
  const dataset: Record<string, string> = {};
  const window: Record<string, unknown> = {
    document: { documentElement: { dataset } },
  };
  Object.defineProperty(window, 'localStorage', { get: storage });
  runInNewContext(read('theme-early.js'), window);
  assert.deepEqual(
    Object.keys(dataset).filter(
      (name) => name !== 'theme' && name !== 'paletteLight' && name !== 'paletteDark',
    ),
    [],
    'it sets nothing else',
  );
  return {
    theme: dataset['theme'] ?? null,
    light: dataset['paletteLight'] ?? null,
    dark: dataset['paletteDark'] ?? null,
  };
}

describe('the choice before the first paint (web/theme-early.js)', () => {
  /** A localStorage that holds `value` under THEME_KEY (and `stored`'s values under their keys)
   *  and records which keys are read. */
  const holding =
    (value: unknown, asked: unknown[], stored: Record<string, unknown> = {}) =>
    () => ({
      getItem: (key: unknown) => {
        asked.push(key);
        if (key === THEME_KEY) return value;
        return typeof key === 'string' && key in stored ? stored[key] : null;
      },
    });

  test('a stored `light` or `dark` is put on <html> as data-theme; it reads THEME_KEY and the two colour themes’ keys only', () => {
    for (const value of ['light', 'dark']) {
      const asked: unknown[] = [];
      assert.equal(early(holding(value, asked)).theme, value);
      assert.deepEqual(asked, [THEME_KEY, PALETTE_KEYS.light, PALETTE_KEYS.dark]);
    }
  });

  test('each scheme’s stored theme is put on <html> as data-palette-light or data-palette-dark exactly when theme-text.js reads it as a theme but the default; the scheme choice does not matter', () => {
    const values = [...new Set<unknown>([...PALETTES.light, ...PALETTES.dark, ...NO_THEME])];
    for (const theme of [null, 'light', 'dark']) {
      for (const scheme of ['light', 'dark'] as const) {
        for (const value of values) {
          const left = early(holding(theme, [], { [PALETTE_KEYS[scheme]]: value }));
          const palette: Palette = paletteOf(scheme, value);
          const other: Scheme = scheme === 'light' ? 'dark' : 'light';
          const label = `${String(theme)} ${scheme} ${JSON.stringify(value) ?? String(value)}`;
          assert.equal(left[scheme], palette === 'default' ? null : palette, label);
          assert.equal(left[other], null, `${label}: the other scheme's stays the default`);
        }
      }
    }
    assert.deepEqual(
      early(holding('dark', [], { [PALETTE_KEYS.light]: 'iris', [PALETTE_KEYS.dark]: 'pleiades' })),
      { theme: 'dark', light: 'iris', dark: 'pleiades' },
      'all three at once',
    );
  });

  test('every value theme-text.js reads as the system’s leaves <html> without data-theme', () => {
    for (const value of NOT_A_CHOICE) {
      assert.equal(early(holding(value, [])).theme, null, JSON.stringify(value) ?? String(value));
      assert.equal(themeOf(value), 'system');
    }
  });

  test('storage that throws (at reading it, or at its getItem) or is missing: no data-theme, and the script does not throw', () => {
    const denied = (): never => {
      throw new Error('SecurityError: access is denied');
    };
    const none = { theme: null, light: null, dark: null };
    assert.deepEqual(early(denied), none);
    assert.deepEqual(
      early(() => ({ getItem: denied })),
      none,
    );
    assert.deepEqual(
      early(() => undefined),
      none,
    );
    assert.deepEqual(
      early(() => null),
      none,
    );
    assert.deepEqual(
      early(() => ({})),
      none,
    );
  });

  test('a classic script with nothing of its own left global (it is loaded with <script src>, never as a module)', () => {
    const text = read('theme-early.js');
    assert.doesNotMatch(text, /^\s*(import|export)\b/m);
    const window: Record<string, unknown> = {
      document: { documentElement: { dataset: {} } },
      localStorage: { getItem: () => 'dark' },
    };
    const before = new Set(Object.keys(window));
    runInNewContext(text, window);
    assert.deepEqual(
      Object.keys(window).filter((name) => !before.has(name)),
      [],
    );
  });
});

/** A style sheet's declarations of one block, in order, each `name: value` with its spaces closed up. */
function declarations(block: string): string[] {
  return block
    .split(';')
    .map((one) => one.replace(/\s+/g, ' ').trim())
    .filter((one) => one !== '');
}

/** The text of a style sheet without its comments. */
function uncommented(name: string): string {
  return read(name).replaceAll(/\/\*[^]*?\*\//g, '');
}

const SYSTEM_DARK =
  /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}\s*\}/g;
const FORCED_DARK = /(?:^|\})\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/g;
const LIGHT = /(?:^|\})\s*:root\s*\{([^}]*)\}/;

/** A dark colour theme's block (the system's dark, unless forced light) and its twin for forced
 *  dark; a light theme's plain rule. */
const themeDark = (palette: string): RegExp =>
  new RegExp(
    `@media \\(prefers-color-scheme: dark\\)\\s*\\{\\s*:root\\[data-palette-dark='${palette}'\\]:not\\(\\[data-theme='light'\\]\\)\\s*\\{([^}]*)\\}\\s*\\}`,
    'g',
  );
const themeDarkTwin = (palette: string): RegExp =>
  new RegExp(
    `(?:^|\\})\\s*:root\\[data-palette-dark='${palette}'\\]\\[data-theme='dark'\\]\\s*\\{([^}]*)\\}`,
    'g',
  );
const themeLight = (palette: string): RegExp =>
  new RegExp(`(?:^|\\})\\s*:root\\[data-palette-light='${palette}'\\]\\s*\\{([^}]*)\\}`, 'g');

/** The themes of `scheme` but the default, which is the scheme's own rules. */
const themesOf = (scheme: Scheme): Palette[] =>
  PALETTES[scheme].filter((palette) => palette !== 'default');

/** The property names of a block's declarations. */
const namesOf = (block: string): string[] =>
  declarations(block).map((one) => one.split(':')[0] ?? '');

/** The style sheets with colour themes. */
const THEMED = ['style.css', 'terminal-view.css'];

describe('one set of dark values (H4): the media block and its twin', () => {
  const sheets = readdirSync(WEB).filter((name) => name.endsWith('.css'));

  test('the three style sheets with a dark scheme are style.css, terminal-view.css and attention.css', () => {
    assert.deepEqual(
      sheets.filter((name) => uncommented(name).includes('prefers-color-scheme')).sort(),
      ['attention.css', 'style.css', 'terminal-view.css'],
    );
  });

  for (const name of sheets) {
    test(`${name}: every scheme query is a dark one scoped to "not forced light", with one twin for forced dark holding the same declarations in the same order`, () => {
      const css = uncommented(name);
      assert.doesNotMatch(css, /prefers-color-scheme:\s*light/, 'no light query');
      assert.doesNotMatch(css, /light-dark\(/, 'no light-dark()');
      const queries = css.match(/prefers-color-scheme/g)?.length ?? 0;
      const system = [...css.matchAll(SYSTEM_DARK)];
      const forced = [...css.matchAll(FORCED_DARK)];
      // A themed sheet has a dark block and its twin for each dark theme too (below).
      const darkThemes = THEMED.includes(name) ? themesOf('dark').length : 0;
      assert.equal(system.length + darkThemes, queries, 'every query is a scoped dark block');
      assert.equal(forced.length, system.length, 'one forced-dark rule for the default');
      if (queries === 0) {
        assert.doesNotMatch(css, /data-theme/, 'no forced rule without a system one');
        return;
      }
      assert.equal(system.length, 1, 'one default dark block');
      // No other rule reads the switch: what forced dark draws is the twins' variables only.
      assert.equal(
        css.match(/data-theme/g)?.length,
        2 + 2 * darkThemes,
        'data-theme only in the dark blocks and their twins',
      );
      const dark = declarations(system[0]?.[1] ?? '');
      assert.ok(dark.length > 0, 'the dark block declares something');
      assert.deepEqual(declarations(forced[0]?.[1] ?? ''), dark, 'the twin is the same');
      // Forced light is plain :root: every property the dark block sets has its light value there.
      const light = LIGHT.exec(css);
      assert.ok(light !== null, 'a light :root');
      const lightNames = new Set(declarations(light[1] ?? '').map((one) => one.split(':')[0]));
      for (const one of dark) {
        assert.ok(lightNames.has(one.split(':')[0]), `${one.split(':')[0]} has a light value`);
      }
    });
  }

  test('the style sheets with colour themes are style.css and terminal-view.css; no other reads them', () => {
    assert.deepEqual(
      sheets.filter((name) => /data-palette/.test(uncommented(name))).sort(),
      THEMED,
    );
  });

  for (const name of THEMED) {
    test(`${name}: every theme of PALETTES but the default is there, laid over its scheme: a light one a plain rule ahead of the dark scheme, a dark one a scoped dark block with its twin holding the same declarations in the same order; each sets only properties the dark scheme sets, so that the scheme's own rules, and nothing else, decide what it leaves`, () => {
      const css = uncommented(name);
      const system = [...css.matchAll(SYSTEM_DARK)][0];
      assert.ok(system !== undefined, 'a default dark block');
      const darkNames = new Set(namesOf(system[1] ?? ''));
      const light = themesOf('light');
      const dark = themesOf('dark');
      assert.equal(
        css.match(/data-palette-light/g)?.length,
        light.length,
        'one rule per light theme',
      );
      assert.equal(css.match(/data-palette-dark/g)?.length, 2 * dark.length, 'two per dark theme');
      for (const palette of light) {
        const rules = [...css.matchAll(themeLight(palette))];
        assert.equal(rules.length, 1, `light ${palette}: one rule`);
        const rule = rules[0];
        assert.ok(
          rule !== undefined && (rule.index ?? 0) < (system.index ?? 0),
          `light ${palette} ahead of the dark scheme`,
        );
        const names = namesOf(rule[1] ?? '');
        assert.ok(names.length > 0, `light ${palette} declares something`);
        for (const one of names) {
          assert.ok(darkNames.has(one), `light ${palette}: ${one} is the dark scheme's too`);
        }
      }
      for (const palette of dark) {
        const blocks = [...css.matchAll(themeDark(palette))];
        const twins = [...css.matchAll(themeDarkTwin(palette))];
        assert.equal(blocks.length, 1, `dark ${palette}: one block`);
        assert.equal(twins.length, 1, `dark ${palette}: one twin`);
        const declared = declarations(blocks[0]?.[1] ?? '');
        assert.ok(declared.length > 0, `dark ${palette} declares something`);
        assert.deepEqual(
          declarations(twins[0]?.[1] ?? ''),
          declared,
          `dark ${palette}: the twin is the same`,
        );
        for (const one of namesOf(blocks[0]?.[1] ?? '')) {
          assert.ok(darkNames.has(one), `dark ${palette}: ${one} is the dark scheme's too`);
        }
      }
    });
  }

  test('style.css: color-scheme light in :root, dark in the dark block (scroll bars, form controls)', () => {
    const css = uncommented('style.css');
    assert.ok(declarations(LIGHT.exec(css)?.[1] ?? '').includes('color-scheme: light'));
    const dark = [...css.matchAll(SYSTEM_DARK)][0]?.[1] ?? '';
    assert.ok(declarations(dark).includes('color-scheme: dark'));
  });
});
