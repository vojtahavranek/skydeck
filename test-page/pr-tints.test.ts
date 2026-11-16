// The pull-request chips' quiet tints (follow-up F4; S2 12.3): every state a chip can show has
// its tint — red for checks failing and changes requested, amber for checks pending, blue for a
// review required, green for approved and green, purple for merged — as the chip's text colour
// and a faint background of style.css's `--pr-<tint>` / `--pr-<tint>-bg`, in the list's rows and
// in the header, in both colour schemes; draft, closed, not fetched, can't read and a level the
// page does not know stay today's grey. A chip that sums several pull requests takes the tint of
// the state its text names, its `+n` too. Size, shape and weight are today's, and the attention
// marks (S2 12.4) keep their colours, their bars and their bold titles. The page has web/'s real
// modules, on a scripted stand-in server (`editWorld`, helpers/shell.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { windowChip } from '../src/window/view/chip.ts';
import { browser, newPage } from './helpers/browser.ts';
import { clickRow, editWorld, PAGE_WAIT_MS, scriptedList, showsText } from './helpers/shell.ts';

type Row = Record<string, unknown>;
type Tint = 'red' | 'amber' | 'blue' | 'green' | 'purple';
type Scheme = 'light' | 'dark';

/** The stand-in's `nowNs` (scriptedList's). */
const NOW_NS = 1794474000000000000n;
const MIN_NS = 60_000_000_000n;

/** The n-th session of this file. */
const sid = (n: number): string => `7d1e3c5a-2b4f-4a6e-8c0d-${String(n).padStart(12, '0')}`;

/** A row of a list (S2 8.2.3) for `id`, not running, with `more` over its fields. */
function row(id: string, more: Row = {}): Row {
  const list = scriptedList([{ id, terminal: null, slot: null }], []) as {
    sections: { rows: Row[] }[];
  };
  return { ...(list.sections[0]?.rows[0] as Row), ...more };
}

let prNumber = 0;
/** A pull request of `level` (S2 8.2.3 PrPayload), read 4 minutes before the list's now. */
function pr(level: string): Row {
  prNumber += 1;
  return {
    url: `https://github.com/acme/web/pull/${prNumber}`,
    repo: 'acme/web',
    number: prNumber,
    title: `Pull request ${prNumber}`,
    level,
    error: level === 'cant-read' ? 'gh: HTTP 502' : null,
    okAtNs: String(NOW_NS - 4n * MIN_NS),
  };
}
const merged = (count: number): Row[] => Array.from({ length: count }, () => pr('merged'));

/** A list whose This week holds `rows`, with `selected` (S2 8.2.3). */
function listOf(rows: Row[], selected: string | null): Row {
  return {
    ...scriptedList([], []),
    sections: [
      { name: 'open', folded: false, firstNs: null, lastNs: null, count: 0, rows: [] },
      { name: 'week', folded: false, firstNs: null, lastNs: null, count: rows.length, rows },
      { name: 'earlier', folded: false, firstNs: null, lastNs: null, count: 0, rows: [] },
    ],
    selected:
      selected === null
        ? null
        : {
            sessionId: selected,
            command: `cd /home/u/project && claude --resume ${selected}`,
            flagsKnown: true,
            unknownFlags: [],
            ended: 'exited',
            expiring: false,
            expired: false,
            note: null,
            noteTooLong: false,
            ticketUrl: null,
          },
  };
}

/** Today's grey of a chip that has no tint, as a CSS colour, in the list and in the header. */
interface Grey {
  list: string;
  header: string;
}
const DIM: Grey = { list: 'var(--dim)', header: 'var(--dim)' };
const FAINT: Grey = { list: 'var(--faint)', header: 'var(--faint)' };

interface Case {
  title: string;
  prs: Row[];
  /** The chip the server sends; windowChip's of `prs` when not given. */
  chip?: Row;
  /** The chip's text, as S2 12.3 words it. */
  text: string;
  /** The tint, or the grey the chip keeps. */
  tint: Tint | Grey;
}

/** Every state of F4's table, and the chips that sum several pull requests (P3). */
const CASES: Case[] = [
  { title: 'checks failing', prs: [pr('checks-failing')], text: 'PR · failing', tint: 'red' },
  {
    title: 'changes requested',
    prs: [pr('changes-requested')],
    text: 'PR · changes',
    tint: 'red',
  },
  { title: 'checks pending', prs: [pr('checks-pending')], text: 'PR · pending', tint: 'amber' },
  { title: 'review required', prs: [pr('review-required')], text: 'PR · review', tint: 'blue' },
  { title: 'approved', prs: [pr('approved-green')], text: 'PR · approved', tint: 'green' },
  { title: 'only merged', prs: merged(3), text: '3 merged', tint: 'purple' },
  { title: 'closed', prs: [pr('closed')], text: 'closed', tint: FAINT },
  { title: 'draft', prs: [pr('draft')], text: 'PR · draft', tint: DIM },
  { title: 'not fetched', prs: [pr('unfetched')], text: 'PR · not fetched', tint: DIM },
  // The list draws can't read faint and dotted, the header dim and dotted (as today).
  {
    title: "can't read",
    prs: [pr('cant-read')],
    text: "PR · can't read",
    tint: { list: 'var(--faint)', header: 'var(--dim)' },
  },
  // A level the page does not know names no state: today's grey.
  {
    title: 'a level the page does not know',
    prs: [pr('later-level')],
    chip: { level: 'later-level', open: 1, merged: 0 },
    text: 'PR · later-level',
    tint: DIM,
  },
  {
    title: 'two to review, three merged',
    prs: [pr('review-required'), pr('review-required'), ...merged(3)],
    text: '2 PRs · review +3',
    tint: 'blue',
  },
  {
    title: 'failing, thirty merged',
    prs: [pr('checks-failing'), ...merged(30)],
    text: 'PR · failing +30',
    tint: 'red',
  },
  {
    title: 'approved and failing',
    prs: [pr('approved-green'), pr('checks-failing')],
    text: '2 PRs · failing',
    tint: 'red',
  },
  {
    title: 'approved and a draft, one merged',
    prs: [pr('approved-green'), pr('draft'), ...merged(1)],
    text: '2 PRs · draft +1',
    tint: DIM,
  },
  {
    title: "can't read and changes, four merged",
    prs: [pr('cant-read'), pr('changes-requested'), ...merged(4)],
    text: "2 PRs · can't read +4",
    tint: { list: 'var(--faint)', header: 'var(--dim)' },
  },
];

const ROWS = CASES.map((c, at) =>
  row(sid(at + 1), {
    title: c.title,
    lastActivityNs: String(NOW_NS - BigInt(at + 1) * 10n * MIN_NS),
    prs: c.prs,
    chip: c.chip ?? windowChip(c.prs as { level: string }[]),
  }),
);

/** What a chip looks like: its colours (its `+n`'s too, null without one), weight and shape. */
interface Look {
  text: string;
  color: string;
  background: string;
  count: string | null;
  weight: string;
  border: string;
  padding: string;
  radius: string;
  size: string;
  height: number;
  bar: string;
}

/** The look of the chip `selector`, with its `+n` in `countSelector`. */
async function lookOf(page: Page, selector: string, countSelector: string): Promise<Look> {
  return page.evaluate(
    ([selector, countSelector]) => {
      const chip = document.querySelector(selector as string);
      if (!(chip instanceof HTMLElement)) throw new Error(`no ${selector}`);
      const style = getComputedStyle(chip);
      const count = chip.querySelector(countSelector as string);
      return {
        text: chip.textContent ?? '',
        color: style.color,
        background: style.backgroundColor,
        count:
          count instanceof HTMLElement && (count.textContent ?? '') !== ''
            ? getComputedStyle(count).color
            : null,
        weight: style.fontWeight,
        border: `${style.borderTopWidth} ${style.borderRightWidth} ${style.borderBottomWidth} ${style.borderLeftWidth}`,
        padding: style.padding,
        radius: style.borderRadius,
        size: style.fontSize,
        height: chip.getBoundingClientRect().height,
        bar: getComputedStyle(chip, '::before').content,
      };
    },
    [selector, countSelector],
  );
}

/** CSS colours as the page computes them: a text colour and a background colour each. */
async function resolve(page: Page, colors: { color: string; background: string }[]) {
  return page.evaluate((colors) => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const out = colors.map(({ color, background }) => {
      probe.style.color = color;
      probe.style.backgroundColor = background;
      const style = getComputedStyle(probe);
      return { color: style.color, background: style.backgroundColor };
    });
    probe.remove();
    return out;
  }, colors);
}

/** The colours `c` should have in `place`: its tint's variables, or today's grey without one. */
function wanted(c: Case, place: keyof Grey): { color: string; background: string } {
  return typeof c.tint === 'string'
    ? { color: `var(--pr-${c.tint})`, background: `var(--pr-${c.tint}-bg)` }
    : { color: c.tint[place], background: 'transparent' };
}

/** Switches the page's colour scheme and waits until its media query says so. */
async function scheme(page: Page, wantedScheme: Scheme): Promise<void> {
  await page.emulateMedia({ colorScheme: wantedScheme });
  await page.waitForFunction(
    (dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark,
    wantedScheme === 'dark',
    { timeout: PAGE_WAIT_MS },
  );
}

/** Asserts the colours, weight and shape of `look` for case `c` in `place` and `scheme`. */
async function assertLook(
  page: Page,
  look: Look,
  c: Case,
  place: keyof Grey,
  where: string,
  shape: Pick<Look, 'weight' | 'border' | 'padding' | 'radius' | 'size' | 'height'>,
): Promise<void> {
  const want = wanted(c, place);
  const [resolved, faint] = await resolve(page, [
    want,
    { color: 'var(--faint)', background: 'transparent' },
  ]);
  assert.ok(resolved !== undefined && faint !== undefined);
  assert.equal(look.text, c.text, `${where}: the chip's words are today's`);
  assert.equal(look.color, resolved.color, `${where}: ${c.text} has the text colour ${want.color}`);
  assert.equal(
    look.background,
    resolved.background,
    `${where}: ${c.text} has the background ${want.background}`,
  );
  if (/\+\d+$/.test(c.text)) {
    // P3: the count keeps the chip's tint; a grey chip's count stays faint, as today.
    assert.equal(
      look.count,
      typeof c.tint === 'string' ? resolved.color : faint.color,
      `${where}: the count of ${c.text}`,
    );
  }
  // P2: no bold, no thicker border, the same size and shape as today; no bar of its own.
  assert.deepEqual(
    {
      weight: look.weight,
      border: look.border,
      padding: look.padding,
      radius: look.radius,
      size: look.size,
      height: look.height,
    },
    shape,
    `${where}: ${c.text} keeps today's size, shape and weight`,
  );
  assert.equal(look.bar, 'none', `${where}: ${c.text} draws no bar`);
}

test("the pull-request chips' quiet tints (follow-up F4)", async (t) => {
  const chromium = await browser(t);

  await t.test(
    'every state of the table and every summed chip, in the list and in the header, light and dark: the tint’s text colour and faint background, or today’s grey; the `+n` in the chip’s tint; the same weight, size and shape; also on the selected row',
    async (t) => {
      const page = await newPage(t, chromium);
      await page.setViewportSize({ width: 1400, height: 900 });
      await editWorld(t, page, (selected) => listOf(ROWS, selected));
      await page.waitForFunction(
        (count) => document.querySelectorAll('#list .row-chip:not([hidden])').length === count,
        CASES.length,
        { timeout: PAGE_WAIT_MS },
      );
      const listChip = (at: number): string => `#list [data-id="${sid(at + 1)}"] .row-chip`;
      const listShape = {
        weight: '400',
        border: '1px 1px 1px 1px',
        padding: '0px 6px',
        radius: '9px',
        size: '11px',
        height: 18,
      };
      const values: Record<Scheme, string> = { light: '', dark: '' };
      for (const s of ['light', 'dark'] as const) {
        await scheme(page, s);
        values[s] = (await resolve(page, [{ color: 'var(--pr-red)', background: '' }]))[0]
          ?.color as string;
        for (const [at, c] of CASES.entries()) {
          const look = await lookOf(page, listChip(at), '.row-chip-merged');
          await assertLook(page, look, c, 'list', `${s}, list`, listShape);
        }
      }
      assert.notEqual(values.light, values.dark, 'each scheme has its own values');

      // The header's chip of each row, and the list's chip of the selected row (on --sel).
      for (const [at, c] of CASES.entries()) {
        await scheme(page, 'light');
        await clickRow(page, sid(at + 1));
        await showsText(page, '#cards .header-title', new RegExp(`^${RegExp.escape(c.title)}$`));
        for (const s of ['light', 'dark'] as const) {
          await scheme(page, s);
          const header = await lookOf(page, '#cards .header-chip', '.header-chip-merged');
          await assertLook(page, header, c, 'header', `${s}, header`, {
            ...listShape,
            height: header.height,
          });
          assert.equal(header.height, 18, `${s}, header: ${c.text} keeps its height`);
          const selected = await page.evaluate(
            (id) =>
              getComputedStyle(document.querySelector(`#list [data-id="${id}"]`) as Element)
                .backgroundColor,
            sid(at + 1),
          );
          const [sel] = await resolve(page, [{ color: '', background: 'var(--sel)' }]);
          assert.equal(selected, sel?.background, `${s}: the row is drawn selected`);
          const look = await lookOf(page, listChip(at), '.row-chip-merged');
          await assertLook(page, look, c, 'list', `${s}, list, selected`, listShape);
        }
      }
    },
  );

  await t.test(
    'the attention marks stay the strongest: the rows that need you keep their bars, bold titles and reason lines in their own colours, light and dark; a chip on them is in its quiet tint, not bold, without a bar; a row that needs nothing has no bar',
    async (t) => {
      const page = await newPage(t, chromium);
      const since = String(NOW_NS - 3n * MIN_NS);
      const rows = [
        row(sid(101), {
          title: 'asks',
          attention: { reason: 'asks', detail: 'permission · Bash', sinceNs: since },
          prs: [pr('checks-pending')],
          chip: windowChip([{ level: 'checks-pending' }]),
        }),
        row(sid(102), {
          title: 'finished',
          attention: { reason: 'finished', detail: null, sinceNs: since },
          prs: [pr('approved-green')],
          chip: windowChip([{ level: 'approved-green' }]),
        }),
        row(sid(103), {
          title: 'ended',
          attention: { reason: 'ended', detail: null, sinceNs: since },
          prs: [pr('checks-failing')],
          chip: windowChip([{ level: 'checks-failing' }]),
        }),
        row(sid(104), {
          title: 'needs nothing',
          prs: [pr('review-required')],
          chip: windowChip([{ level: 'review-required' }]),
        }),
      ];
      await editWorld(t, page, (selected) => listOf(rows, selected));
      await page.waitForFunction(
        () => document.querySelectorAll('#list .list-row[data-attention]').length === 3,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      // Today's colours of the three reasons (style.css's --wait and --crash, attention.css's
      // --need-finished), written out so that a change of them shows here.
      const marks: Record<Scheme, Record<string, string>> = {
        light: {
          asks: 'rgb(183, 121, 31)',
          finished: 'rgb(31, 138, 76)',
          ended: 'rgb(201, 60, 55)',
        },
        dark: {
          asks: 'rgb(240, 185, 65)',
          finished: 'rgb(76, 194, 122)',
          ended: 'rgb(242, 102, 95)',
        },
      };
      const tintOf: Record<string, Tint> = {
        asks: 'amber',
        finished: 'green',
        ended: 'red',
        none: 'blue',
      };
      for (const s of ['light', 'dark'] as const) {
        await scheme(page, s);
        const drawn = await page.evaluate(() =>
          [...document.querySelectorAll('#list .list-row')].map((element) => {
            const chip = element.querySelector('.row-chip') as Element;
            return {
              reason: element.getAttribute('data-attention') ?? 'none',
              bar: getComputedStyle(element, '::before').content,
              barColor: getComputedStyle(element, '::before').backgroundColor,
              titleWeight: getComputedStyle(element.querySelector('.row-title') as Element)
                .fontWeight,
              stateColor: getComputedStyle(element.querySelector('.row-state') as Element).color,
              chipColor: getComputedStyle(chip).color,
              chipBackground: getComputedStyle(chip).backgroundColor,
              chipWeight: getComputedStyle(chip).fontWeight,
              chipBar: getComputedStyle(chip, '::before').content,
            };
          }),
        );
        assert.deepEqual(
          drawn.map((d) => d.reason),
          ['asks', 'finished', 'ended', 'none'],
        );
        for (const d of drawn) {
          const tint = tintOf[d.reason] as Tint;
          const [want] = await resolve(page, [
            { color: `var(--pr-${tint})`, background: `var(--pr-${tint}-bg)` },
          ]);
          assert.equal(d.chipColor, want?.color, `${s} ${d.reason}: the chip's tint`);
          assert.equal(
            d.chipBackground,
            want?.background,
            `${s} ${d.reason}: the chip's background`,
          );
          assert.equal(d.chipWeight, '400', `${s} ${d.reason}: the chip is not bold`);
          assert.equal(d.chipBar, 'none', `${s} ${d.reason}: the chip has no bar`);
          if (d.reason === 'none') {
            assert.equal(d.bar, 'none', `${s}: a row that needs nothing has no bar`);
            assert.notEqual(d.titleWeight, '700', `${s}: its title is not bold`);
            continue;
          }
          const mark = marks[s][d.reason];
          assert.equal(d.bar, '""', `${s} ${d.reason}: the bar is drawn`);
          assert.equal(d.barColor, mark, `${s} ${d.reason}: the bar's colour is today's`);
          assert.equal(d.stateColor, mark, `${s} ${d.reason}: the reason's line is today's`);
          assert.equal(d.titleWeight, '700', `${s} ${d.reason}: the title stays bold`);
          assert.notEqual(d.chipColor, mark, `${s} ${d.reason}: the chip is not the mark's colour`);
        }
      }
    },
  );
});
