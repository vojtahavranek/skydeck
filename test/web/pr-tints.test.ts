// The pull-request chips' quiet tints (follow-up F4): the variables of web/style.css, in both
// colour schemes and each colour theme (test/web/colour-schemes.ts), read from the files themselves. Each tint's text has a contrast of at least
// 4.5 : 1 (WCAG 2) against its own background (the list's and the header's chips) and against
// every background the state's words stand on (PLACES: a row, a hovered and a selected row, the
// header, the dialog, the switcher and its highlighted item — each checked to be that variable
// still); it is no stronger than an ordinary row's title (`--dim`) on --panel and on --sel; and it
// is a softer colour than the attention colour of its family (S2 12.4's marks stay the strongest).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { colourSchemes } from './colour-schemes.ts';

const TINTS = ['red', 'amber', 'blue', 'green', 'purple'] as const;
const MIN_CONTRAST = 4.5;
/**
 * How much stronger than an ordinary row's title (`--dim`) a tint's text may be, in contrast on the
 * same background: the owner's condition — "needs you / finished should be still more important" —
 * so that on an ordinary row a chip is never the brightest thing (ruled).
 */
const DIM_MARGIN = 0.1;

/**
 * Where a state's words (a chip, or the words alone) stand beside their own background: the style
 * sheet and rule that draw that background, and the variable it is.
 */
const PLACES = [
  ['a row of the list', 'style.css', '.list-zone', '--panel'],
  ['a hovered row', 'list.css', '.list-row:hover', '--panel2'],
  ['the selected row', 'list.css', ".list-row[data-selected='true']", '--sel'],
  [
    "the header (its chip and its open pull requests' words)",
    'cards.css',
    '.card-header',
    '--panel',
  ],
  ["the pull-request dialog's lines", 'edit.css', '.edit-dialog', '--panel'],
  ["the quick switcher's chip", 'search.css', '.switcher-panel', '--panel'],
  [
    "the switcher's highlighted item",
    'search.css',
    ".switcher-item[data-active='true'],\n.switcher-offer[data-active='true']",
    '--sel',
  ],
] as const;

/** The background variable a rule of `file` draws, `null` when it draws none of `var(--…)`. */
function backgroundOf(file: string, selector: string): string | null {
  const css = readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8');
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at !== -1, `${file} has the rule ${selector}`);
  const block = css.slice(at, css.indexOf('}', at));
  return /\bbackground(?:-color)?:\s*var\((--[\w-]+)\)/.exec(block)?.[1] ?? null;
}

/** The custom properties of a block of CSS declarations. */
function properties(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name as string, (value as string).trim());
  }
  return found;
}

/** The light (`:root`) and dark (`prefers-color-scheme: dark`, unless forced light; forced dark is
 *  the same declarations, test/web/theme.test.ts) variables of a style sheet. */
function schemes(file: string): { light: Map<string, string>; dark: Map<string, string> } {
  const css = readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8').replaceAll(
    /\/\*[^]*?\*\//g,
    '',
  );
  const dark =
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(
      css,
    );
  const light = /:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(light !== null && dark !== null, `${file} has a light and a dark :root`);
  return { light: properties(light[1] ?? ''), dark: properties(dark[1] ?? '') };
}

/** `#rrggbb` as three channels 0–255. */
function channels(hex: string): [number, number, number] {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is a #rrggbb colour`);
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** An sRGB channel, linear. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2's relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2's contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLCH's chroma and hue (degrees) of a colour: how strong a colour it is, and of which family. */
function chromaHue(hex: string): { chroma: number; hue: number } {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { chroma: Math.hypot(a, bb), hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** The distance of two hues in degrees (0–180). */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('the chip tints of web/style.css (follow-up F4)', () => {
  const style = colourSchemes('style.css');
  const attention = schemes('attention.css');

  test('the helpers measure as WCAG 2 does', () => {
    assert.equal(contrast('#000000', '#ffffff'), 21);
    assert.equal(contrast('#777777', '#777777'), 1);
    assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
    assert.ok(chromaHue('#808080').chroma < 1e-6);
    assert.ok(hueDistance(chromaHue('#ff0000').hue, 29) < 1);
  });

  for (const { name: scheme, scheme: kind, values: vars } of style) {
    const value = (name: string): string => {
      const found = vars.get(name);
      assert.ok(found !== undefined, `${scheme}: ${name} is set`);
      return found;
    };

    test(`${scheme}: every tint has its pair of variables, each a #rrggbb colour`, () => {
      for (const tint of TINTS) {
        channels(value(`--pr-${tint}`));
        channels(value(`--pr-${tint}-bg`));
      }
    });

    test(`${scheme}: each tint's text has at least ${MIN_CONTRAST} : 1 against its own background and every background its words stand on`, (t) => {
      const grounds = [...new Set(PLACES.map(([, , , name]) => name))];
      for (const tint of TINTS) {
        const text = value(`--pr-${tint}`);
        const against: [string, string][] = [
          [`--pr-${tint}-bg`, value(`--pr-${tint}-bg`)],
          ...grounds.map((name): [string, string] => [name, value(name)]),
        ];
        const measured = against.map(([name, background]) => {
          const ratio = contrast(text, background);
          assert.ok(
            ratio >= MIN_CONTRAST,
            `${scheme} --pr-${tint} ${text} on ${name} ${background}: ${ratio.toFixed(2)} : 1`,
          );
          return `${name} ${ratio.toFixed(2)}`;
        });
        t.diagnostic(`${scheme} --pr-${tint} ${text}: ${measured.join(', ')}`);
      }
    });

    test(`${scheme}: no tint's text is stronger than an ordinary row's title (--dim): on --panel and on --sel at most --dim's contrast + ${String(DIM_MARGIN)}`, (t) => {
      for (const ground of ['--panel', '--sel']) {
        const limit = contrast(value('--dim'), value(ground)) + DIM_MARGIN;
        for (const tint of TINTS) {
          const ratio = contrast(value(`--pr-${tint}`), value(ground));
          assert.ok(
            ratio <= limit,
            `${scheme} --pr-${tint} on ${ground}: ${ratio.toFixed(2)} above --dim's ${(limit - DIM_MARGIN).toFixed(2)} + ${String(DIM_MARGIN)}`,
          );
        }
        t.diagnostic(`${scheme} --dim on ${ground}: ${(limit - DIM_MARGIN).toFixed(2)}`);
      }
    });

    test(`${scheme}: where the words stand, the background is still the one measured`, (t) => {
      for (const [where, file, selector, name] of PLACES) {
        assert.equal(backgroundOf(file, selector), name, `${where}: ${file} ${selector}`);
        t.diagnostic(`${where}: ${name} ${value(name)}`);
      }
    });

    test(`${scheme}: no tint reuses an attention colour or the waiting and crash colours`, () => {
      const taken = new Set(
        ['--wait', '--wait-bg', '--crash', '--crash-bg', '--accent', '--selline']
          .map(value)
          .concat([...attention[kind].values()].filter((v) => v.startsWith('#')))
          .map((v) => v.toLowerCase()),
      );
      for (const tint of TINTS) {
        for (const name of [`--pr-${tint}`, `--pr-${tint}-bg`]) {
          assert.ok(
            !taken.has(value(name).toLowerCase()),
            `${scheme} ${name} is a colour of its own`,
          );
        }
      }
    });

    test(`${scheme}: red, amber and green are softer colours of the attention marks' families`, () => {
      const need = (name: string): string => {
        const found = attention[kind].get(name) ?? attention.light.get(name);
        assert.ok(found !== undefined, `${name} in attention.css`);
        return found.startsWith('var(') ? value(found.slice(4, -1)) : found;
      };
      for (const [tint, mark] of [
        ['red', need('--need-ended')],
        ['amber', need('--need')],
        ['green', need('--need-finished')],
      ] as const) {
        const ours = chromaHue(value(`--pr-${tint}`));
        const theirs = chromaHue(mark);
        assert.ok(
          ours.chroma < theirs.chroma,
          `${scheme} --pr-${tint}: chroma ${ours.chroma.toFixed(3)} below the mark's ${theirs.chroma.toFixed(3)}`,
        );
        assert.ok(
          hueDistance(ours.hue, theirs.hue) <= 30,
          `${scheme} --pr-${tint}: hue ${ours.hue.toFixed(0)} near the mark's ${theirs.hue.toFixed(0)}`,
        );
      }
    });
  }
});
