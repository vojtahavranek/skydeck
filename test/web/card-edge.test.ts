// A block's card in the list (follow-up F9): its edge must be seen as an edge in both schemes —
// the first try's `--edge` barely showed in dark (1.05 : 1 against the card) — and the card must sit
// one step off the list's background. The variables of web/style.css and the rule of web/list.css.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/** The least contrast of the card's edge against the list and against the card itself. */
const EDGE_MIN = 1.3;

/** The custom properties of a block of CSS declarations. */
function properties(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name as string, (value as string).trim());
  }
  return found;
}

/** The light (`:root`) and dark (`prefers-color-scheme: dark`) variables of web/style.css. */
function schemes(): { light: Map<string, string>; dark: Map<string, string> } {
  const css = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8').replaceAll(
    /\/\*[^]*?\*\//g,
    '',
  );
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
  const light = /:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(light !== null && dark !== null, 'style.css has a light and a dark :root');
  return { light: properties(light[1] ?? ''), dark: properties(dark[1] ?? '') };
}

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

/** The declarations of the first rule of web/list.css for `selector`. */
function rule(selector: string): string {
  const css = readFileSync(new URL('../../web/list.css', import.meta.url), 'utf8');
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at !== -1, `list.css has the rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

describe("a block's card (F9)", () => {
  test('the card is drawn with --card-edge as its border and --panel2 as its background', () => {
    const card = rule('.list-block');
    assert.match(card, /\bborder:\s*1px solid var\(--card-edge\);/);
    assert.match(card, /\bbackground:\s*var\(--panel2\);/);
    assert.match(card, /\bborder-radius:\s*8px;/);
    assert.match(card, /\bmargin:\s*8px;/);
  });

  for (const [name, scheme] of Object.entries(schemes())) {
    test(`${name}: the edge is at least ${EDGE_MIN} : 1 against the list and the card; the card is off the list`, () => {
      const edge = scheme.get('--card-edge');
      const panel = scheme.get('--panel');
      const card = scheme.get('--panel2');
      assert.ok(edge && panel && card, 'the variables are set');
      const ratios = { list: contrast(edge, panel), card: contrast(edge, card) };
      assert.ok(
        ratios.list >= EDGE_MIN && ratios.card >= EDGE_MIN,
        `${name}: ${JSON.stringify(ratios)}`,
      );
      assert.notEqual(card.toLowerCase(), panel.toLowerCase(), 'the card is one step off');
    });
  }
});
