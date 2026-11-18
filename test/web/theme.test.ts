// The title bar's theme switch (follow-up F13; S2 12.1): its three states and the stored value
// each stands for, the order a click walks them in and what the button says (web/theme-text.js,
// pure); the script that applies the stored choice before the first paint (web/theme-early.js, a
// classic script, run here in a VM context of its own) reads exactly what theme-text.js reads; and
// every style sheet of web/ that has a dark scheme writes it twice — the system's, unless forced
// light, and forced dark — with the same declarations in the same order, so that forced dark is
// exactly the system's dark (the page suite compares the computed values, test-page/theme.test.ts).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { nextTheme, THEME_KEY, themeOf, themeTitle, themeWord } from '../../web/theme-text.js';

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

/** What theme-early.js leaves on `<html>` (its `data-theme`, or null) for `storage` in its window. */
function early(storage: () => unknown): { theme: string | null } {
  const dataset: Record<string, string> = {};
  const window: Record<string, unknown> = {
    document: { documentElement: { dataset } },
  };
  Object.defineProperty(window, 'localStorage', { get: storage });
  runInNewContext(read('theme-early.js'), window);
  assert.deepEqual(
    Object.keys(dataset).filter((name) => name !== 'theme'),
    [],
    'it sets nothing else',
  );
  return { theme: dataset['theme'] ?? null };
}

describe('the choice before the first paint (web/theme-early.js)', () => {
  /** A localStorage that holds `value` under THEME_KEY and records which keys are read. */
  const holding = (value: unknown, asked: unknown[]) => () => ({
    getItem: (key: unknown) => {
      asked.push(key);
      return key === THEME_KEY ? value : null;
    },
  });

  test('a stored `light` or `dark` is put on <html> as data-theme; it reads THEME_KEY only', () => {
    for (const value of ['light', 'dark']) {
      const asked: unknown[] = [];
      assert.equal(early(holding(value, asked)).theme, value);
      assert.deepEqual(asked, [THEME_KEY]);
    }
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
    assert.equal(early(denied).theme, null);
    assert.equal(early(() => ({ getItem: denied })).theme, null);
    assert.equal(early(() => undefined).theme, null);
    assert.equal(early(() => null).theme, null);
    assert.equal(early(() => ({})).theme, null);
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
      assert.equal(system.length, queries, 'every query is the scoped dark block');
      assert.equal(forced.length, queries, 'one forced-dark rule for each');
      if (queries === 0) {
        assert.doesNotMatch(css, /data-theme/, 'no forced rule without a system one');
        return;
      }
      assert.equal(queries, 1, 'one dark block');
      // No other rule reads the switch: what forced dark draws is the twin's variables only.
      assert.equal(css.match(/data-theme/g)?.length, 2, 'data-theme only in the two rules');
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

  test('style.css: color-scheme light in :root, dark in the dark block (scroll bars, form controls)', () => {
    const css = uncommented('style.css');
    assert.ok(declarations(LIGHT.exec(css)?.[1] ?? '').includes('color-scheme: light'));
    const dark = [...css.matchAll(SYSTEM_DARK)][0]?.[1] ?? '';
    assert.ok(declarations(dark).includes('color-scheme: dark'));
  });
});
