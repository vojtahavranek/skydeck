// The list's section headers (S2 12.1, follow-up F17): each is a band on the page's --bg, sunken
// against the list (--panel), with a mark per section before its title. Its words must be read
// on that ground and Open's mark seen there, in both schemes: the variables of web/style.css and
// the rules of web/list.css, as test/web/card-edge.test.ts reads them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { colourSchemes } from './colour-schemes.ts';

/** WCAG 2's least contrast for text of this size (12 px), and for a mark that must be seen. */
const TEXT_MIN = 4.5;
const MARK_MIN = 3;
/** The least contrast of the band's ground against the list's, so that the band is seen at all
 *  (as built: 1.10 : 1 light, 1.09 : 1 dark). */
const GROUND_MIN = 1.05;

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

/** The declarations of the rule of web/list.css for exactly `selector` (comments left out). */
function rule(selector: string): string {
  const css = readFileSync(new URL('../../web/list.css', import.meta.url), 'utf8').replaceAll(
    /\/\*[^]*?\*\//g,
    '',
  );
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at !== -1, `list.css has the rule ${selector}`);
  assert.equal(css.indexOf(`\n${selector} {`, at + 1), -1, `list.css has one rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

/** The variable a declaration of `property` in `declarations` names: `var(--x)` gives `--x`. */
function variable(declarations: string, property: string): string {
  const found = new RegExp(`(?:^|[;{\\s])${property}:\\s*var\\((--[\\w-]+)\\);`).exec(declarations);
  assert.ok(found !== null, `${property}: var(--…) in ${declarations.trim()}`);
  return found[1] as string;
}

const BAND = '.list-section';
const MARK = '.section-mark';
const mark = (section: string): string => `${BAND}[data-section='${section}'] ${MARK}`;

describe("the section headers' bands (F17)", () => {
  test("a band: the page's --bg as its ground, a 1 px --line above and below, 28 px high, square, sticky", () => {
    const band = rule(BAND);
    assert.equal(variable(band, 'background'), '--bg');
    assert.match(band, /\bborder-top:\s*1px solid var\(--line\);/);
    assert.match(band, /\bborder-bottom:\s*1px solid var\(--line\);/);
    assert.match(band, /\bheight:\s*28px;/);
    assert.match(band, /\bposition:\s*sticky;/);
    assert.doesNotMatch(band, /border-radius|margin/, 'square, edge to edge');
    assert.match(band, /\bfont-size:\s*12px;/);
    assert.match(band, /\bfont-weight:\s*700;/);
    assert.match(band, /\btext-transform:\s*uppercase;/);
  });

  test('the marks: Open --accent, Recent --dim, Earlier --faint; the titles: Open and Recent --text, Earlier --dim; the count dim', () => {
    assert.equal(variable(rule(MARK), 'background'), '--faint');
    assert.equal(variable(rule(mark('open')), 'background'), '--accent');
    assert.equal(variable(rule(mark('week')), 'background'), '--dim');
    assert.equal(variable(rule(BAND), 'color'), '--text');
    assert.equal(variable(rule(`${BAND}[data-section='earlier']`), 'color'), '--dim');
    assert.equal(variable(rule('.section-count'), 'color'), '--dim');
    assert.equal(variable(rule('.section-span'), 'color'), '--dim');
  });

  for (const { name, values: scheme } of colourSchemes('style.css')) {
    test(`${name}: every word of a band at least ${TEXT_MIN} : 1 against it, Open's mark at least ${MARK_MIN} : 1; the band at least ${GROUND_MIN} : 1 against the list`, () => {
      const colour = (property: string): string => {
        const value = scheme.get(property);
        assert.ok(value, `${name} sets ${property}`);
        return value;
      };
      const ground = colour(variable(rule(BAND), 'background'));
      const words = {
        'Open and Recent': colour(variable(rule(BAND), 'color')),
        Earlier: colour(variable(rule(`${BAND}[data-section='earlier']`), 'color')),
        count: colour(variable(rule('.section-count'), 'color')),
        span: colour(variable(rule('.section-span'), 'color')),
      };
      const ratios = Object.fromEntries(
        Object.entries(words).map(([what, ink]) => [what, contrast(ink, ground)]),
      );
      for (const [what, ratio] of Object.entries(ratios)) {
        assert.ok(ratio >= TEXT_MIN, `${name}: ${what} ${ratio.toFixed(2)} : 1`);
      }
      const open = contrast(colour(variable(rule(mark('open')), 'background')), ground);
      assert.ok(open >= MARK_MIN, `${name}: Open's mark ${open.toFixed(2)} : 1`);
      const off = contrast(ground, colour('--panel'));
      assert.ok(off >= GROUND_MIN, `${name}: the band against the list ${off.toFixed(2)} : 1`);
    });
  }
});
