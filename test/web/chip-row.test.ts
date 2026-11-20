// The row under the list's filter field (S2 12.8, follow-up F35): the chips Running, Open PR, Has
// note and Done, and the switch Show done at its end. Their words and tooltips (web/chips.js), and
// that each of their texts is read at least 4.5 : 1 (WCAG 2) on the ground it stands on — the
// list's --panel, a pressed chip's --sel — in each colour scheme and each colour theme
// (test/web/colour-schemes.ts), the dimmed switch too: it stays a control, so it keeps the rule.
// The variables are web/style.css's, the rules web/search.css's, as test/web/section-band.test.ts
// reads them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { CHIPS, SHOW_DONE } from '../../web/chips.js';
import { colourSchemes } from './colour-schemes.ts';

/** WCAG 2's least contrast for text of this size (11.5 px), and for a mark that must be seen. */
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

const CSS = readFileSync(new URL('../../web/search.css', import.meta.url), 'utf8').replaceAll(
  /\/\*[^]*?\*\//g,
  '',
);

/** The declarations of the rule of web/search.css for exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at !== -1, `search.css has the rule ${selector}`);
  assert.equal(CSS.indexOf(`\n${selector} {`, at + 1), -1, `search.css has one rule ${selector}`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

/** The variable a declaration of `property` in `declarations` names: `var(--x)` gives `--x`. */
function variable(declarations: string, property: string): string {
  const found = new RegExp(`(?:^|[;{\\s])${property}:\\s*var\\((--[\\w-]+)\\);`).exec(declarations);
  assert.ok(found !== null, `${property}: var(--…) in ${declarations.trim()}`);
  return found[1] as string;
}

const CHIP = '.list-chip';
const PRESSED = ".list-chip[aria-pressed='true']";
const SWITCH = '.list-switch';
const DIMMED = ".list-switch[data-dimmed='true']";
const BOX = '.list-switch-box';
const CHECKED_BOX = ".list-switch[aria-checked='true'] .list-switch-box";
const DIMMED_BOX = ".list-switch[data-dimmed='true'] .list-switch-box";

describe('the chip row (F35): four filters and the switch Show done', () => {
  test('the chips, their words and tooltips, in order; Show done is no chip', () => {
    assert.deepEqual(CHIPS, [
      ['running', 'Running', 'only the sessions under Open'],
      ['open-pr', 'Open PR', 'only the sessions with a pull request that is not merged or closed'],
      ['note', 'Has note', 'only the sessions with a note'],
      ['done', 'Done', 'only sessions marked done'],
    ]);
    assert.deepEqual(SHOW_DONE, {
      text: 'Show done',
      tip: 'also list sessions marked done (a)',
      dimmedTip: 'the Done filter lists done sessions by itself',
    });
  });

  test('the rules name their colours: the chips as before, the switch at the row’s end', () => {
    assert.equal(variable(rule(CHIP), 'color'), '--dim');
    assert.equal(variable(rule(PRESSED), 'color'), '--text');
    assert.equal(variable(rule(PRESSED), 'background'), '--sel');
    assert.equal(variable(rule(SWITCH), 'color'), '--text');
    assert.match(rule(SWITCH), /\bmargin-left:\s*auto;/, 'apart from the chips, at the end');
    assert.match(rule(SWITCH), /\bbackground:\s*none;/, 'on the list’s own ground');
    assert.match(rule('.list-chiprow'), /\bflex-wrap:\s*wrap;/, 'the row wraps in a narrow list');
    assert.match(rule('.list-chips'), /\bflex-wrap:\s*wrap;/, 'and so do the chips');
    assert.equal(variable(rule(DIMMED), 'color'), '--dim');
    assert.match(rule(BOX), /\bborder:\s*1px solid var\(--dim\);/, 'the box: a 1 px edge');
    assert.equal(variable(rule(CHECKED_BOX), 'color'), '--accent', 'checked: an accent ✓');
    assert.equal(variable(rule(DIMMED_BOX), 'border-color'), '--line2', 'dimmed: a quiet edge');
    assert.match(
      rule(".list-switch[aria-checked='true'] .list-switch-box::after"),
      /content:\s*'✓';/,
    );
  });

  for (const { name, values: scheme } of colourSchemes('style.css')) {
    test(`${name}: every text of the row at least ${TEXT_MIN} : 1 on its ground, the dimmed switch too; the box and its check at least ${MARK_MIN} : 1`, () => {
      const colour = (property: string): string => {
        const value = scheme.get(property);
        assert.ok(value, `${name} sets ${property}`);
        return value;
      };
      const panel = colour('--panel');
      const texts: Record<string, [string, string]> = {
        'a chip': [colour(variable(rule(CHIP), 'color')), panel],
        'a pressed chip': [
          colour(variable(rule(PRESSED), 'color')),
          colour(variable(rule(PRESSED), 'background')),
        ],
        'the switch': [colour(variable(rule(SWITCH), 'color')), panel],
        'the dimmed switch': [colour(variable(rule(DIMMED), 'color')), panel],
        "the switch's check": [colour(variable(rule(CHECKED_BOX), 'color')), panel],
        "the dimmed switch's check": [colour(variable(rule(DIMMED_BOX), 'color')), panel],
      };
      for (const [what, [ink, ground]] of Object.entries(texts)) {
        const ratio = contrast(ink, ground);
        assert.ok(ratio >= TEXT_MIN, `${name}: ${what} ${ratio.toFixed(2)} : 1`);
      }
      const edges: Record<string, string> = {
        "the box's edge": colour(
          /border:\s*1px solid var\((--[\w-]+)\);/.exec(rule(BOX))?.[1] ?? '',
        ),
        "the checked box's edge": colour(variable(rule(CHECKED_BOX), 'border-color')),
      };
      for (const [what, ink] of Object.entries(edges)) {
        const ratio = contrast(ink, panel);
        assert.ok(ratio >= MARK_MIN, `${name}: ${what} ${ratio.toFixed(2)} : 1`);
      }
    });
  }
});
