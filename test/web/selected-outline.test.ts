// The selected row's outline (follow-up: the outline in both zones). While the list has the
// keyboard the selected row, a selected row inside a block and a selected closed caption keep their
// `--sel` fill AND show the `--selline` outline the terminal zone shows, so the outline is drawn on
// the fill, and on the list's ground (`--panel`) or a card's (`--panel2`) around it. The variables
// of web/style.css in each colour scheme and each colour theme; what the page draws is
// test-page/selected-outline.test.ts's.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { colourSchemes } from './colour-schemes.ts';

/** The least contrast of the outline against the fill (the weakest pair, light, is 2.62 : 1). */
const ON_FILL_MIN = 2.5;
/** The least contrast of the outline against the ground it is drawn next to (the weakest: 3.07). */
const ON_GROUND_MIN = 3;

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

describe("the selected row's outline is seen on its fill and on the ground around it", () => {
  for (const { name, values: scheme } of colourSchemes('style.css')) {
    test(`${name}: --selline is at least ${ON_FILL_MIN} : 1 against --sel and ${ON_GROUND_MIN} : 1 against --panel and --panel2`, () => {
      const line = scheme.get('--selline');
      const fill = scheme.get('--sel');
      const list = scheme.get('--panel');
      const card = scheme.get('--panel2');
      assert.ok(line && fill && list && card, 'the variables are set');
      const ratios = {
        fill: contrast(line, fill),
        list: contrast(line, list),
        card: contrast(line, card),
      };
      assert.ok(ratios.fill >= ON_FILL_MIN, `${name}: on the fill ${JSON.stringify(ratios)}`);
      assert.ok(
        ratios.list >= ON_GROUND_MIN && ratios.card >= ON_GROUND_MIN,
        `${name}: on the ground ${JSON.stringify(ratios)}`,
      );
    });
  }
});
