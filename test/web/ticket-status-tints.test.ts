// Follow-up F19 (T3): a ticket's status takes the pull requests' tints and no new colour. The rule
// of web/style.css for the row's chip and the header's ticket chip names, for each category with a
// colour, the pair of `--pr-*` variables of its tint — blocked red, review amber, doing blue, done
// green — and writes no colour of its own; todo, closed and none have no entry (the chip's grey).
// The chips stand on the grounds test/web/pr-tints.test.ts measures (a row, hovered or selected,
// and the header), so its contrast rule holds for them as it holds for the pull requests' chips.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { colourSchemes } from './colour-schemes.ts';

const css = (file: string): string =>
  readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8').replaceAll(
    /\/\*[^]*?\*\//g,
    '',
  );

/** The body of the block that starts with `head {`, its nested blocks included. */
function block(text: string, head: string): string {
  const at = text.indexOf(`${head} {`);
  assert.ok(at !== -1, `the rule ${head}`);
  let depth = 0;
  for (let i = text.indexOf('{', at); i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(text.indexOf('{', at) + 1, i);
  }
  throw new Error(`the rule ${head} does not end`);
}

test("style.css: each category with a colour takes its tint's two --pr-* variables, and nothing else", () => {
  const rule = block(css('style.css'), ':where(.row-ticket, .header-ticket)');
  const entries = [...rule.matchAll(/&\[data-category='([a-z]+)'\]\s*\{([^}]*)\}/g)].map(
    ([, category, body]) => [category, (body ?? '').replace(/\s+/g, ' ').trim()],
  );
  assert.deepEqual(entries, [
    ['blocked', '--tint: var(--pr-red); --tint-bg: var(--pr-red-bg); color: var(--tint);'],
    ['review', '--tint: var(--pr-amber); --tint-bg: var(--pr-amber-bg); color: var(--tint);'],
    ['doing', '--tint: var(--pr-blue); --tint-bg: var(--pr-blue-bg); color: var(--tint);'],
    ['done', '--tint: var(--pr-green); --tint-bg: var(--pr-green-bg); color: var(--tint);'],
  ]);
  assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b|rgb|hsl/i, 'no colour of its own');
});

test("the chips draw the tint as the pull requests' chips do, and their grey without one", () => {
  const row = block(css('list.css'), '.row-ticket');
  assert.match(row, /background-color: var\(--tint-bg, transparent\);/);
  assert.match(row, /color: var\(--tint, var\(--dim\)\);/);
  const header = block(css('cards.css'), ".header-ticket[data-status='true']");
  assert.match(header, /background-color: var\(--tint-bg, transparent\);/);
  assert.match(header, /color: var\(--tint, var\(--dim\)\);/);
  // The row's chip has the pull requests' chip's box (list.css .row-chip).
  const chip = block(css('list.css'), '.row-chip');
  for (const line of [
    'padding: 0 6px;',
    'border: 1px solid var(--line2);',
    'border-radius: 9px;',
    'font-size: 11px;',
    'line-height: 16px;',
  ]) {
    assert.ok(chip.includes(line) && row.includes(line), line);
  }
});

// --- the contrast rule for the six categories (as test/web/pr-tints.test.ts has it) -------------

/** A category's text colour and its own background: its tint's pair, or the chip's grey. */
const OF_CATEGORY: Record<string, { text: string; own: string | null }> = {
  blocked: { text: '--pr-red', own: '--pr-red-bg' },
  review: { text: '--pr-amber', own: '--pr-amber-bg' },
  doing: { text: '--pr-blue', own: '--pr-blue-bg' },
  done: { text: '--pr-green', own: '--pr-green-bg' },
  todo: { text: '--dim', own: null },
  closed: { text: '--dim', own: null },
};

/** Where the chips stand: the style sheet and rule that draw that ground, and its variable. */
const GROUNDS = [
  ["a row of the list (the row's chip)", 'style.css', '.list-zone', '--panel'],
  ['a hovered row', 'list.css', '.list-row:hover', '--panel2'],
  ['the selected row', 'list.css', ".list-row[data-selected='true']", '--sel'],
  ["the header (the ticket's chip)", 'cards.css', '.card-header', '--panel'],
] as const;

function luminance(hex: string): number {
  const channel = (at: number): number => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the six categories' contrast: at least 4.5 : 1 on each ground the chips stand on", () => {
  const vars = colourSchemes('style.css');
  test('the grounds are still the variables measured', () => {
    for (const [where, file, selector, name] of GROUNDS) {
      const text = css(file);
      const at = text.indexOf(`\n${selector} {`);
      assert.ok(at !== -1, `${file} ${selector}`);
      const body = text.slice(at, text.indexOf('}', at));
      assert.equal(/\bbackground(?:-color)?:\s*var\((--[\w-]+)\)/.exec(body)?.[1], name, where);
    }
  });
  for (const { name: scheme, values } of vars) {
    test(`${scheme}: every category's text on its own background and on each ground`, (t) => {
      const value = (name: string): string => {
        const found = values.get(name);
        assert.ok(found !== undefined && /^#[0-9a-f]{6}$/i.test(found), `${scheme} ${name}`);
        return found;
      };
      for (const [category, { text, own }] of Object.entries(OF_CATEGORY)) {
        const grounds = [...new Set(GROUNDS.map(([, , , name]) => name as string))];
        const against = [...(own === null ? [] : [own]), ...grounds];
        const measured = against.map((ground) => {
          const ratio = contrast(value(text), value(ground));
          assert.ok(
            ratio >= 4.5,
            `${scheme} ${category} ${text} on ${ground}: ${ratio.toFixed(2)} : 1`,
          );
          return `${ground} ${ratio.toFixed(2)}`;
        });
        t.diagnostic(`${scheme} ${category} (${text}): ${measured.join(', ')}`);
      }
    });
  }
});
