// The pull-request chips' quiet tints (follow-up F4; S2 12.3): every state a chip can show has
// its tint — red for checks failing and changes requested, amber for checks pending, blue for a
// review required, green for approved and green, purple for merged — as the chip's text colour
// and a faint background of style.css's `--pr-<tint>` / `--pr-<tint>-bg`, in the list's rows and
// in the header, in both colour schemes; draft, closed, not fetched, can't read and a level the
// page does not know stay today's grey. A chip that sums several pull requests takes the tint of
// the state its text names, its `+n` too. Size, shape and weight are today's, and the attention
// marks (S2 12.4) keep their colours, their bars and their bold titles. In the header's open pull
// requests, the dialog's lines and the quick switcher's chip only the state's words take the tint,
// as text colour only (ruled). The page has web/'s real modules, on a scripted stand-in server
// (helpers/shell.ts) that answers each `view` with a list of the case's rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { windowChip } from '../src/window/view/chip.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  clickRow,
  connection,
  TERM_A,
  honest,
  PAGE_WAIT_MS,
  scriptedList,
  showsText,
  standinServer,
  storeKey,
} from './helpers/shell.ts';

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

/**
 * A list whose This week holds `rows`, with `selected` (S2 8.2.3), and while the page's view has
 * a switcher text the switcher's payload for it: every row, not running, in their order (E9).
 */
function listOf(
  rows: Row[],
  selected: string | null,
  switcher: string | null = null,
  terminals: Row[] = [],
): Row {
  return {
    ...scriptedList([], []),
    terminals,
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
    switcher:
      switcher === null
        ? null
        : {
            query: switcher,
            command: false,
            items: rows.map((row) => ({ rank: 'not-running', row, found: [], hiddenBy: [] })),
            more: 0,
            restore: null,
          },
  };
}

let seed = 200;

interface World {
  page: Page;
  /** The rows of every later list; a list of them is sent at once, for the page's last view. */
  set(rows: Row[]): void;
}

/**
 * A page at 1400 x 900 with a stored key, connected to a stand-in server that answers every
 * `view` with `listOf(rows, …)` for its selection and switcher text (and `terminals`), and an
 * `attach` with an empty snap.
 */
async function world(
  t: TestContext,
  chromium: Browser,
  first: Row[],
  terminals: Row[] = [],
): Promise<World> {
  const page = await newPage(t, chromium);
  await page.setViewportSize({ width: 1400, height: 900 });
  const secret = new Uint8Array(32).fill(seed++);
  let rows = first;
  let selected: string | null = null;
  let switcher: string | null = null;
  const listNow = (): Row => listOf(rows, selected, switcher, terminals);
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        if (message['t'] === 'view') {
          selected = typeof message['selected'] === 'string' ? message['selected'] : null;
          switcher = typeof message['switcher'] === 'string' ? message['switcher'] : null;
          conn.send(listNow());
        } else if (message['t'] === 'attach') {
          conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
        }
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  return {
    page,
    set(next) {
      rows = next;
      standin.connections.at(-1)?.send(listNow());
    },
  };
}

/** The tint of each level of design 7.3 (F4's table, P1); a level without one stays grey. */
const TINT_OF: Record<string, Tint> = {
  'checks-failing': 'red',
  'changes-requested': 'red',
  'checks-pending': 'amber',
  'review-required': 'blue',
  'approved-green': 'green',
  merged: 'purple',
};

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
      const { page } = await world(t, chromium, ROWS);
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
    "the attention marks stay the strongest: the rows that need you keep their bars, their reason lines in their own colours and the boldest titles (700; a running session's 600, any other row's 400), light and dark; a chip on them is in its quiet tint, not bold, without a bar; a row that needs nothing has no bar",
    async (t) => {
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
        row(sid(105), {
          title: 'running, needs nothing',
          state: 'running',
          terminal: TERM_A,
          slot: 1,
          prs: [pr('merged')],
          chip: windowChip([{ level: 'merged' }]),
        }),
      ];
      const { page } = await world(t, chromium, rows, [
        {
          id: TERM_A,
          slot: 1,
          sessionId: sid(105),
          state: 'running',
          notReported: false,
          cols: 80,
          rows: 24,
          ownsSize: true,
          openedNs: String(NOW_NS - 60n * MIN_NS),
        },
      ]);
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
        running: 'purple',
      };
      for (const s of ['light', 'dark'] as const) {
        await scheme(page, s);
        const drawn = await page.evaluate(() =>
          [...document.querySelectorAll('#list .list-row')].map((element) => {
            const chip = element.querySelector('.row-chip') as Element;
            return {
              reason:
                element.getAttribute('data-attention') ??
                (element.getAttribute('data-lines') === '2' ? 'running' : 'none'),
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
          ['asks', 'finished', 'ended', 'none', 'running'],
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
          if (d.reason === 'none' || d.reason === 'running') {
            assert.equal(d.bar, 'none', `${s} ${d.reason}: a row that needs nothing has no bar`);
            // Measured, so that the documents say what is true: only a row that needs you has a
            // title of 700; a running session's (two lines) is 600, any other row's 400.
            assert.equal(d.titleWeight, d.reason === 'running' ? '600' : '400', `${s} ${d.reason}`);
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

  /** Every level of design 7.3, and one the page does not know, each once. */
  const LEVELS = [
    'checks-failing',
    'changes-requested',
    'checks-pending',
    'review-required',
    'approved-green',
    'draft',
    'unfetched',
    'cant-read',
    'later-level',
    'merged',
    'closed',
  ];

  /** The colour, background and words of each `part` in each `whole`, and of the rest of it. */
  async function partsOf(page: Page, whole: string, part: string) {
    return page.evaluate(
      ([whole, part]) =>
        [...document.querySelectorAll(whole as string)].map((element) => {
          const state = element.querySelector(part as string) as HTMLElement;
          const others = [...element.querySelectorAll('*')].filter(
            (child) => child !== state && child.children.length === 0,
          );
          return {
            text: element.textContent ?? '',
            words: state.textContent ?? '',
            level: state.getAttribute('data-level'),
            color: getComputedStyle(state).color,
            background: getComputedStyle(state).backgroundColor,
            weight: getComputedStyle(state).fontWeight,
            own: getComputedStyle(element).color,
            others: others.map((child) => getComputedStyle(child).color),
          };
        }),
      [whole, part],
    );
  }

  await t.test(
    "the header's open pull requests and the pull-request dialog's lines: only the state's words take the tint, as text colour only, light and dark; the rest of the line, a grey state and the words themselves are today's",
    async (t) => {
      const prs = LEVELS.map(pr);
      const id = sid(201);
      const { page } = await world(t, chromium, [
        row(id, { title: 'every state', prs, chip: windowChip(prs as { level: string }[]) }),
      ]);
      await clickRow(page, id);
      await showsText(page, '#cards .header-title', /^every state$/);
      const open = prs.filter((p) => p['level'] !== 'merged' && p['level'] !== 'closed');
      await page.locator('#cards .header-prs-button').click();
      await page.waitForFunction(
        (count) => document.querySelectorAll('.edit-prs-open .edit-pr').length === count,
        open.length,
        { timeout: PAGE_WAIT_MS },
      );
      await page.locator('.edit-pr-fold').click();
      await page.waitForFunction(
        (count) =>
          [...document.querySelectorAll('.edit-pr')].filter((line) =>
            (line as HTMLElement).checkVisibility(),
          ).length === count,
        prs.length,
        { timeout: PAGE_WAIT_MS },
      );
      const words: Record<string, [string, string]> = {
        'checks-failing': ['failing', 'checks failing'],
        'changes-requested': ['changes', 'changes requested'],
        'checks-pending': ['pending', 'checks pending'],
        'review-required': ['review', 'review required'],
        'approved-green': ['approved', 'approved, green'],
        draft: ['draft', 'draft'],
        unfetched: ['not fetched', 'not fetched'],
        'cant-read': ["can't read", "can't read"],
        'later-level': ['later-level', 'later-level'],
        merged: ['merged', 'merged'],
        closed: ['closed', 'closed'],
      };
      for (const s of ['light', 'dark'] as const) {
        await scheme(page, s);
        const items = await partsOf(page, '#cards .header-pr', '.header-pr-state');
        const lines = await partsOf(page, '.edit-pr-text', '.edit-pr-state');
        assert.equal(items.length, open.length, 'one item per open pull request');
        assert.equal(lines.length, prs.length, 'one line per pull request');
        const drawn: [string, (typeof items)[number], Row, number][] = [
          ...items.map((item, at): [string, (typeof items)[number], Row, number] => [
            'header',
            item,
            open[at] as Row,
            0,
          ]),
          ...lines.map((line, at): [string, (typeof items)[number], Row, number] => [
            'dialog',
            line,
            [...open, ...prs.filter((p) => !open.includes(p))][at] as Row,
            1,
          ]),
        ];
        for (const [place, got, given, which] of drawn) {
          const level = given['level'] as string;
          const where = `${s}, ${place}, ${level}`;
          const tint = TINT_OF[level];
          const [want] = await resolve(page, [
            tint === undefined
              ? { color: got.own, background: 'transparent' }
              : { color: `var(--pr-${tint})`, background: 'transparent' },
          ]);
          // Today's words and text, whole: the item is the repository, the number, the words.
          assert.equal(got.words, words[level]?.[which], `${where}: the words`);
          const head = `acme/web #${String(given['number'])} · ${words[level]?.[which] ?? ''}`;
          assert.ok(got.text.startsWith(head), `${where}: ${JSON.stringify(got.text)}`);
          if (place === 'header') assert.equal(got.text, head, `${where}: the item's text`);
          assert.equal(
            got.level,
            level === 'later-level' ? '' : level,
            `${where}: the state it names`,
          );
          assert.equal(got.color, want?.color, `${where}: the words' colour`);
          assert.equal(got.background, want?.background, `${where}: no background`);
          assert.equal(got.weight, '400', `${where}: not bold`);
          assert.ok(
            got.others.every((color) => color === got.own),
            `${where}: the rest of the line keeps its colour ${got.own}: ${JSON.stringify(got.others)}`,
          );
        }
      }
    },
  );

  for (const s of ['light', 'dark'] as const) {
    await t.test(
      `the quick switcher's chip, ${s}: the state's words in its tint, as text colour only, also on the highlighted item; a grey state keeps today's faint; the words are today's`,
      async (t) => {
        const { page } = await world(t, chromium, ROWS);
        await scheme(page, s);
        await page.waitForFunction(
          (count) => document.querySelectorAll('#list .row-chip:not([hidden])').length === count,
          CASES.length,
          { timeout: PAGE_WAIT_MS },
        );
        await page.keyboard.press('Control+Shift+P');
        await page.waitForFunction(
          (count) => document.querySelectorAll('#switcher .switcher-item').length === count,
          CASES.length,
          { timeout: PAGE_WAIT_MS },
        );
        const items = await page.evaluate(() =>
          [...document.querySelectorAll('#switcher .switcher-item')].map((item) => {
            const chip = item.querySelector('.switcher-chip') as HTMLElement;
            const meta = item.querySelector('.switcher-meta') as HTMLElement;
            return {
              active: item.getAttribute('data-active') === 'true',
              itemBackground: getComputedStyle(item).backgroundColor,
              text: chip.textContent ?? '',
              color: getComputedStyle(chip).color,
              background: getComputedStyle(chip).backgroundColor,
              weight: getComputedStyle(chip).fontWeight,
              meta: getComputedStyle(meta).color,
            };
          }),
        );
        const [sel, faint] = await resolve(page, [
          { color: '', background: 'var(--sel)' },
          { color: 'var(--faint)', background: 'transparent' },
        ]);
        assert.equal(items[0]?.active, true, 'the first item is highlighted');
        assert.equal(items[0]?.itemBackground, sel?.background, 'on --sel');
        for (const [at, c] of CASES.entries()) {
          const item = items[at];
          assert.ok(item !== undefined);
          const [want] = await resolve(page, [
            typeof c.tint === 'string'
              ? { color: `var(--pr-${c.tint})`, background: 'transparent' }
              : { color: 'var(--faint)', background: 'transparent' },
          ]);
          const where = `${s}, switcher, ${c.text}${item.active ? ' (highlighted)' : ''}`;
          assert.equal(item.text, c.text, `${where}: today's words`);
          assert.equal(item.color, want?.color, `${where}: its colour`);
          assert.equal(item.background, want?.background, `${where}: no background`);
          assert.equal(item.weight, '400', `${where}: not bold`);
          assert.equal(item.meta, faint?.color, `${where}: the rest of its line stays faint`);
        }
      },
    );
  }

  await t.test(
    'the tints are scoped to the elements that show a state: any other element with a `data-level` gets neither a tint nor a colour, and passes none down',
    async (t) => {
      const { page } = await world(t, chromium, ROWS);
      await page.waitForFunction(
        (count) => document.querySelectorAll('#list .row-chip:not([hidden])').length === count,
        CASES.length,
        { timeout: PAGE_WAIT_MS },
      );
      const found = await page.evaluate(() => {
        const outer = document.createElement('div');
        outer.dataset['level'] = 'checks-failing';
        const inner = document.createElement('span');
        inner.className = 'row-chip-merged';
        inner.textContent = '+1';
        outer.append(inner);
        document.querySelector('#list')?.append(outer);
        const style = getComputedStyle(outer);
        const out = {
          color: style.color,
          tint: style.getPropertyValue('--tint'),
          innerTint: getComputedStyle(inner).getPropertyValue('--tint'),
          parent: getComputedStyle(outer.parentElement as Element).color,
        };
        outer.remove();
        return out;
      });
      assert.deepEqual(
        found,
        { color: found.parent, tint: '', innerTint: '', parent: found.parent },
        'no tint outside the chips and the state words',
      );
    },
  );

  await t.test(
    "a state that changes while the page is open: the list's chip, the header's chip and item, the dialog's line and the switcher's chip take the new tint, and lose it for a grey state",
    async (t) => {
      const X = sid(301);
      const B = sid(302);
      const C = sid(303);
      const p1 = pr('checks-pending');
      const p3 = pr('approved-green');
      const p2 = pr('review-required');
      const p4 = pr('approved-green');
      const at = (given: Row, level: string): Row => ({ ...given, level });
      const rowsOf = (levels: [string, string, string, string]): Row[] => {
        const x = [at(p1, levels[0]), at(p3, levels[1])];
        const b = [at(p2, levels[2])];
        const c = [at(p4, levels[3])];
        return [
          row(X, { title: 'x', prs: x, chip: windowChip(x as { level: string }[]) }),
          row(B, { title: 'b', prs: b, chip: windowChip(b as { level: string }[]) }),
          row(C, { title: 'c', prs: c, chip: windowChip(c as { level: string }[]) }),
        ];
      };
      const first: [string, string, string, string] = [
        'checks-pending',
        'approved-green',
        'review-required',
        'approved-green',
      ];
      const second: [string, string, string, string] = [
        'checks-failing',
        'draft',
        'merged',
        'draft',
      ];
      const w = await world(t, chromium, rowsOf(first));
      const { page } = w;
      await clickRow(page, X);
      await showsText(page, '#cards .header-title', /^x$/);
      await page.locator('#cards .header-prs-button').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.edit-prs-open .edit-pr').length === 2,
        null,
        {
          timeout: PAGE_WAIT_MS,
        },
      );
      /** The colour each place draws now, and the colour it should draw for `level`. */
      const colours = async () =>
        page.evaluate(() => {
          const colour = (selector: string): string[] =>
            [...document.querySelectorAll(selector)].map(
              (element) => getComputedStyle(element).color,
            );
          return {
            list: colour('#list .row-chip'),
            header: colour('#cards .header-chip'),
            items: colour('#cards .header-pr-state'),
            lines: colour('.edit-prs-open .edit-pr-state'),
            switcher: colour('#switcher .switcher-chip'),
          };
        });
      const expect = async (
        levels: [string, string, string, string],
        withDialog: boolean,
      ): Promise<Record<string, string[]>> => {
        const colour = async (level: string, grey: string): Promise<string> => {
          const tint = TINT_OF[level];
          const [got] = await resolve(page, [
            { color: tint === undefined ? grey : `var(--pr-${tint})`, background: '' },
          ]);
          return got?.color ?? '';
        };
        // The chips name the state windowChip picks: X's the worse of its two.
        const chipOf = (prs: string[]): string =>
          (windowChip(prs.map((level) => ({ level }))) as { level: string }).level;
        const xChip = chipOf([levels[0], levels[1]]);
        const out: Record<string, string[]> = {
          list: [
            await colour(xChip, 'var(--dim)'),
            await colour(levels[2], levels[2] === 'closed' ? 'var(--faint)' : 'var(--dim)'),
            await colour(levels[3], 'var(--dim)'),
          ],
          header: [await colour(xChip, 'var(--dim)')],
        };
        if (withDialog) {
          // The item's and the line's grey is the colour of the text around them.
          out['items'] = [
            await colour(levels[0], 'var(--dim)'),
            await colour(levels[1], 'var(--dim)'),
          ];
          out['lines'] = [
            await colour(levels[0], 'var(--text)'),
            await colour(levels[1], 'var(--text)'),
          ];
        }
        return out;
      };
      const settle = async (wanted: Record<string, string[]>, what: string): Promise<void> => {
        const deadline = performance.now() + PAGE_WAIT_MS;
        let last: Record<string, string[]> = {};
        for (;;) {
          const got = await colours();
          last = Object.fromEntries(
            Object.keys(wanted).map((key) => [key, got[key as keyof typeof got]]),
          );
          if (JSON.stringify(last) === JSON.stringify(wanted)) return;
          if (performance.now() > deadline) break;
          await sleep(50);
        }
        assert.deepEqual(last, wanted, what);
      };
      await settle(await expect(first, true), 'the first states');
      w.set(rowsOf(second));
      await settle(
        await expect(second, true),
        'pending → failing, approved → draft, review → merged',
      );

      // The switcher's chips, drawn while it is open, follow too.
      await page.keyboard.press('Escape');
      await page.waitForSelector('.edit-dialog', { state: 'hidden', timeout: PAGE_WAIT_MS });
      await page.keyboard.press('Control+Shift+P');
      await page.waitForFunction(
        () => document.querySelectorAll('#switcher .switcher-item').length === 3,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      const switcherOf = async (levels: [string, string, string, string]): Promise<string[]> => {
        const want = await expect(levels, false);
        const faint = (await resolve(page, [{ color: 'var(--faint)', background: '' }]))[0]?.color;
        const dim = (await resolve(page, [{ color: 'var(--dim)', background: '' }]))[0]?.color;
        // The switcher's grey is its line's faint, where the list's chip is dim.
        return (want['list'] ?? []).map((color) => (color === dim ? (faint as string) : color));
      };
      await settle({ switcher: await switcherOf(second) }, 'the switcher, the second states');
      w.set(rowsOf(first));
      await settle({ switcher: await switcherOf(first) }, 'the switcher, back to the first states');
    },
  );
});
