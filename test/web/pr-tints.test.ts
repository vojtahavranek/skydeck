// The pull-request chips' quiet tints (follow-up F4): the variables of web/style.css, in both
// colour schemes, read from the file itself. Each tint's text has a contrast of at least 4.5 : 1
// (WCAG 2) against its own background and against the backgrounds a row, the header and the
// dialog draw it on (`--panel`, the hovered row's `--panel2`, the selected row's `--sel`), and it
// is a softer colour than the attention colour of its family (S2 12.4's marks stay the strongest).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const TINTS = ['red', 'amber', 'blue', 'green', 'purple'] as const;
/** The backgrounds a tint's text is drawn on beside its own. */
const BACKGROUNDS = ['--panel', '--panel2', '--sel'] as const;
const MIN_CONTRAST = 4.5;

/** The custom properties of a block of CSS declarations. */
function properties(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name as string, (value as string).trim());
  }
  return found;
}

/** The light (`:root`) and dark (`prefers-color-scheme: dark`) variables of a style sheet. */
function schemes(file: string): { light: Map<string, string>; dark: Map<string, string> } {
  const css = readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8').replaceAll(
    /\/\*[^]*?\*\//g,
    '',
  );
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
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
  const style = schemes('style.css');
  const attention = schemes('attention.css');

  test('the helpers measure as WCAG 2 does', () => {
    assert.equal(contrast('#000000', '#ffffff'), 21);
    assert.equal(contrast('#777777', '#777777'), 1);
    assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
    assert.ok(chromaHue('#808080').chroma < 1e-6);
    assert.ok(hueDistance(chromaHue('#ff0000').hue, 29) < 1);
  });

  for (const scheme of ['light', 'dark'] as const) {
    const vars = style[scheme];
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

    test(`${scheme}: each tint's text has at least ${MIN_CONTRAST} : 1 against its own background, --panel, --panel2 and --sel`, (t) => {
      for (const tint of TINTS) {
        const text = value(`--pr-${tint}`);
        const against: [string, string][] = [
          [`--pr-${tint}-bg`, value(`--pr-${tint}-bg`)],
          ...BACKGROUNDS.map((name): [string, string] => [name, value(name)]),
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

    test(`${scheme}: no tint reuses an attention colour or the waiting and crash colours`, () => {
      const taken = new Set(
        ['--wait', '--wait-bg', '--crash', '--crash-bg', '--accent', '--selline']
          .map(value)
          .concat([...attention[scheme].values()].filter((v) => v.startsWith('#')))
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
        const found = attention[scheme].get(name) ?? attention.light.get(name);
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
