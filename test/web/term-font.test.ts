// The terminal's font list (#154; S2 12.6): the one xterm.js draws with (web/terminal-view.js) and
// every `--term-font` of web/'s style sheets, which the page measures the terminal's area with, are
// one list, and it names no symbol or emoji font, so that what its fonts lack is drawn by the
// system's fallback. On Windows a font named in the list wins over that fallback for every
// character it has: "Segoe UI Symbol" has a glyph of one colour for every emoji (the red, orange,
// yellow and white circles came out grey, a joined emoji as its parts squashed into two cells), and
// "Segoe UI Emoji" would draw Claude Code's ⏺ ⚠ as colour emoji, whatever colour the program gives
// them. Another monospace font may join the list; the rule is what is held.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const WEB = new URL('../../web/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, WEB), 'utf8');

/** The families of a CSS font list, unquoted. */
const families = (list: string): string[] =>
  list.split(',').map((family) => family.trim().replace(/^(['"])(.*)\1$/, '$2'));

/** terminal-view.js's FONT, also when the formatter puts the string on a line of its own. */
const view = /^const FONT =\s*'([^']*)';$/m.exec(read('terminal-view.js'))?.[1];

/** Every `--term-font` declaration of web/'s style sheets, by sheet. */
const declared = readdirSync(WEB)
  .filter((name) => name.endsWith('.css'))
  .flatMap((sheet) =>
    [...read(sheet).matchAll(/--term-font\s*:\s*([^;]*);/g)].map((match) => ({
      sheet,
      list: match[1] ?? '',
    })),
  );

test('xterm.js draws with the list the page measures with: every `--term-font` of every style sheet', () => {
  assert.ok(view, 'terminal-view.js has its FONT');
  assert.ok(
    declared.some(({ sheet }) => sheet === 'style.css'),
    'style.css declares --term-font',
  );
  for (const { sheet, list } of declared) {
    assert.deepEqual(families(list), families(view), sheet);
  }
});

test('no symbol or emoji font is named, and the list ends in the generic `monospace`: emoji and symbols are the system fallback’s', () => {
  assert.ok(view);
  const list = families(view);
  assert.equal(list.at(-1), 'monospace');
  for (const family of list) {
    assert.doesNotMatch(family, /Segoe UI (Symbol|Emoji)|emoji|symbol/i);
  }
});
