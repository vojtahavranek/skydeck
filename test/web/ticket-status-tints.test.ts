// Follow-up F19 (T3): a ticket's status takes the pull requests' tints and no new colour. The rule
// of web/style.css for the row's chip and the header's ticket chip names, for each category with a
// colour, the pair of `--pr-*` variables of its tint — blocked red, review amber, doing blue, done
// green — and writes no colour of its own; todo, closed and none have no entry (the chip's grey).
// The chips stand on the grounds test/web/pr-tints.test.ts measures (a row, hovered or selected,
// and the header), so its contrast rule holds for them as it holds for the pull requests' chips.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
