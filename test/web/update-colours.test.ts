// The update dialog's colours (web/update.css; S2 12.1): each of its texts — a note's title and
// text, a line, the fold line and its list, the database note, the small lines at the bottom — is
// read at least 4.5 : 1 (WCAG 2) on the ground it stands on, the dialog's --panel or the database
// note's --panel2, in each colour scheme and each colour theme (test/web/colour-schemes.ts), and
// the database note's mark at its left at least 3 : 1. The variables are web/style.css's, the rules
// web/update.css's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { colourSchemes } from './colour-schemes.ts';

const TEXT_MIN = 4.5;
const MARK_MIN = 3;

/** WCAG 2's contrast ratio of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is a #rrggbb colour`);
    const [r, g, b] = [1, 3, 5].map((at) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const CSS = readFileSync(new URL('../../web/update.css', import.meta.url), 'utf8').replaceAll(
  /\/\*[^]*?\*\//g,
  '',
);

/** The declarations of the rule of web/update.css for exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at !== -1, `update.css has the rule ${selector}`);
  assert.equal(CSS.indexOf(`\n${selector} {`, at + 1), -1, `update.css has one rule ${selector}`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

/** The variable a declaration of `property` in `declarations` names: `var(--x)` gives `--x`. */
function variable(declarations: string, property: string): string {
  const found = new RegExp(`(?:^|[;{\\s])${property}:\\s*var\\((--[\\w-]+)\\)`).exec(declarations);
  assert.ok(found !== null, `${property}: var(--…) in ${declarations.trim()}`);
  return found[1] as string;
}

/** Each text of the dialog: its rule, and the ground it stands on. */
const TEXTS: [string, string][] = [
  ['.update-body', '--panel'],
  ['.update-note-title', '--panel'],
  ['.update-note-text', '--panel'],
  ['.update-line', '--panel'],
  ['.update-fold', '--panel'],
  ['.update-other', '--panel'],
  ['.update-database', '--panel2'],
  ['.update-meta', '--panel'],
];

describe("the update dialog's colours (S2 12.1)", () => {
  test('the rules name their colours; the database note stands on --panel2 with its mark in --wait', () => {
    assert.equal(variable(rule('.update-database'), 'background'), '--panel2');
    assert.match(rule('.update-database'), /border-left: 3px solid var\(--wait\);/);
    assert.equal(variable(rule('.update-meta'), 'color'), '--dim');
    assert.equal(variable(rule('.update-note-title'), 'color'), '--text');
    // The dialog's own ground is edit.css's --panel.
    const edit = readFileSync(new URL('../../web/edit.css', import.meta.url), 'utf8');
    assert.match(edit, /\n\.edit-dialog \{[^}]*background: var\(--panel\);/);
  });

  for (const scheme of colourSchemes('style.css')) {
    test(`${scheme.name}: every text at least ${TEXT_MIN} : 1, the mark at least ${MARK_MIN} : 1`, () => {
      const value = (name: string): string => {
        const found = scheme.values.get(name);
        assert.ok(found !== undefined, `${scheme.name} has ${name}`);
        return found;
      };
      for (const [selector, ground] of TEXTS) {
        const colour = variable(rule(selector), 'color');
        const ratio = contrast(value(colour), value(ground));
        assert.ok(
          ratio >= TEXT_MIN,
          `${selector} (${colour} on ${ground}): ${ratio.toFixed(2)} : 1 in ${scheme.name}`,
        );
      }
      const mark = contrast(value('--wait'), value('--panel2'));
      assert.ok(mark >= MARK_MIN, `the mark: ${mark.toFixed(2)} : 1 in ${scheme.name}`);
    });
  }
});
