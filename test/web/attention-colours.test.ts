// The colour of the mark unread (S2 12.4; web/attention.css): its line's text, `marked unread ·
// <age>`, has a contrast of at least 4.5 : 1 (WCAG 2) on every ground a row stands on — a plain
// row (--panel), a hovered one (--panel2, and --line in a block) and the selected one (--sel) — in
// both schemes and every colour theme of style.css, read from the files themselves; forced dark
// declares the same value as the system's dark.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { colourSchemes } from './colour-schemes.ts';

const MIN_CONTRAST = 4.5;
const GROUNDS = ['--panel', '--panel2', '--line', '--sel'];

/** `#rrggbb` as three linear channels. */
function channels(hex: string): [number, number, number] {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is a #rrggbb colour`);
  return [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b2] = channels(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** --need-unread of attention.css in each scheme (attention.css has no colour themes). */
function unreadOf(scheme: 'light' | 'dark'): string {
  const found = colourSchemes('attention.css').find((one) => one.name === scheme);
  const value = found?.values.get('--need-unread');
  assert.ok(value !== undefined, `--need-unread in attention.css (${scheme})`);
  return value;
}

describe('the mark unread: its line reads on every ground of a row', () => {
  test('a colour of its own in each scheme, the same in forced dark as in the system dark', () => {
    const css = readFileSync(new URL('../../web/attention.css', import.meta.url), 'utf8');
    const forced = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(forced, new RegExp(`--need-unread:\\s*${unreadOf('dark')};`));
    assert.notEqual(unreadOf('light'), unreadOf('dark'));
  });

  for (const scheme of colourSchemes('style.css')) {
    test(`${scheme.name}: at least ${String(MIN_CONTRAST)} : 1 on ${GROUNDS.join(', ')}`, () => {
      const text = unreadOf(scheme.scheme);
      for (const ground of GROUNDS) {
        const value = scheme.values.get(ground);
        assert.ok(value !== undefined, `${scheme.name} ${ground}`);
        const ratio = contrast(text, value);
        assert.ok(
          ratio >= MIN_CONTRAST,
          `${scheme.name}: ${text} on ${ground} ${value} is ${ratio.toFixed(2)} : 1`,
        );
      }
    });
  }
});
