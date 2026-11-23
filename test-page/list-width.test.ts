// The list's width (issue #192; S2 12.1, 12.9): nothing stored is today's layout (400 px at any
// window width); a stored width (the page's localStorage, `skydeck-list-width`) is in force from
// the first painted frame, held to the window less 320 px and never under 240 px, and kept when a
// narrower window shows less of it; a stored value that is no width is nothing stored, or held to
// 240 … 800; at 240 and 800 px rows whose fixed parts fit give no horizontal scroll bar, no
// overlapping parts and titles that end in an ellipsis, and a row whose fixed parts are wider than
// the list scrolls sideways as it does at 400 px before issue #192.
// The page has web/'s real modules, on a scripted stand-in server (helpers/shell.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { LIST_WIDTH_KEY } from '../web/list-width-text.js';
import { browser, newPage } from './helpers/browser.ts';
import {
  connection,
  honest,
  PAGE_WAIT_MS,
  problemsOf,
  readPage,
  scriptedList,
  standinServer,
  storeKey,
  TERM_A,
  TERM_B,
} from './helpers/shell.ts';
import type { Standin } from './helpers/shell.ts';
import { until } from './helpers/terminal.ts';

type Message = Record<string, unknown>;
/** Which rows the list holds (`list`). */
type Rows = 'fit' | 'wide';

/**
 * The rows of the list: two running in the window's terminals (numbers 1 and 2), one under
 * Recent, with titles longer than the widest list. `fit`: besides the title, the number and the
 * age, fixed parts that fit a list of 240 px — a short group and a note, or one pull requests'
 * chip. `wide`: every part a row can show on its first line (a long group, marks, the chip, the
 * ticket's status, a note), wider together than a list of 400 px.
 */
function list(kind: Rows): Message {
  const long =
    'a title long enough to run past the right edge of even the widest list there is, and on, '.repeat(
      2,
    );
  const base = scriptedList(
    [
      { id: S1, terminal: TERM_A, slot: 1, title: `alpha ${long}` },
      { id: S2, terminal: TERM_B, slot: 2, title: `beta ${long}` },
      { id: S3, terminal: null, slot: null, title: `gamma ${long}` },
    ],
    [
      { id: TERM_A, slot: 1, sessionId: S1 },
      { id: TERM_B, slot: 2, sessionId: S2 },
    ],
  );
  const [open] = base['sections'] as { rows: Message[] }[];
  const short = { group: 'web', groupSource: 'user', hasNote: true, noteHead: ['a note'] };
  const chip = { chip: { level: 'checks-failing', open: 1, merged: 30 } };
  const wide = {
    group: 'a group with a long name',
    groupSource: 'user',
    marks: ['crashed', 'expires 3d'],
    hasNote: true,
    noteHead: ['a note'],
    chip: { level: 'checks-failing', open: 1, merged: 30 },
    ticketStatus: { name: 'TRY-1234', status: 'In Progress', category: 'doing' },
  };
  const rows = (open?.rows ?? []).map((row): Message => ({
    ...row,
    ...(kind === 'wide' ? wide : row['id'] === S2 ? chip : short),
  }));
  const recent = rows.filter((row) => row['id'] === S3);
  return {
    ...base,
    sections: [
      { ...open, count: 2, rows: rows.filter((row) => row['id'] !== S3) },
      {
        name: 'week',
        folded: false,
        firstNs: null,
        lastNs: null,
        count: 1,
        rows: recent,
        closedStacks: [],
      },
    ],
  };
}

/** A stand-in server: S1 running in TERM_A, S2 in TERM_B, S3 under Recent. */
interface Deck {
  standin: Standin;
  secret: Uint8Array;
  /** Every message pages sent after their `start` but pings. */
  sent: Message[];
}

let seed = 120;

/** `snap`: what the terminals' snaps hold (the screen and the modes the program asked for);
 *  `rows`: which rows the list holds. */
async function deck(t: TestContext, snap = 'ready', rows: Rows = 'fit'): Promise<Deck> {
  const secret = new Uint8Array(32).fill(seed++);
  const sent: Message[] = [];
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        sent.push(message);
        if (message['t'] === 'view') {
          conn.send(list(rows));
        } else if (message['t'] === 'attach') {
          const { term, cols, rows } = message as { term: string; cols: number; rows: number };
          conn.send({ t: 'snap', term, ch: term === TERM_A ? 1 : 2, cols, rows, data: snap });
        }
      },
    }),
  });
  return { standin, secret, sent };
}

/**
 * Opens the deck's page on `page` with its key stored (and `stored` under LIST_WIDTH_KEY when it
 * is given; `init` an init script for the second load), connected, a terminal shown.
 */
async function open(
  d: Deck,
  page: Page,
  options: { stored?: string; init?: string } = {},
): Promise<void> {
  await page.goto(d.standin.url);
  await storeKey(page, d.secret);
  if (options.stored !== undefined) {
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
      LIST_WIDTH_KEY,
      options.stored,
    ] as const);
  }
  if (options.init !== undefined) await page.addInitScript(options.init);
  await page.goto(d.standin.url);
  await connection(page, 'open');
  await page.waitForSelector('#right-zone[data-pane="terminal"]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** A page of its own at `width` × 900 on a fresh deck (whose snaps hold `snap`, its list `rows`). */
async function opened(
  t: TestContext,
  chromium: Browser,
  options: { width?: number; stored?: string; init?: string; snap?: string; rows?: Rows } = {},
): Promise<{ page: Page; d: Deck; problems: string[] }> {
  const page = await newPage(t, chromium);
  const problems = problemsOf(page);
  await page.setViewportSize({ width: options.width ?? 1400, height: 900 });
  const d = await deck(t, options.snap, options.rows);
  await open(d, page, options);
  return { page, d, problems };
}

/** The list's and the right side's widths, `--list-width` on <html>, and what is stored. */
async function widths(page: Page): Promise<{
  list: number;
  right: number;
  window: number;
  property: string;
  stored: string | null;
}> {
  return readPage(
    page,
    (key) => {
      let stored: string | null;
      try {
        stored = localStorage.getItem(key);
      } catch {
        stored = 'throws';
      }
      return {
        list: document.getElementById('list-zone')?.getBoundingClientRect().width ?? NaN,
        right: document.getElementById('right-zone')?.getBoundingClientRect().width ?? NaN,
        window: innerWidth,
        property: document.documentElement.style.getPropertyValue('--list-width'),
        stored,
      };
    },
    LIST_WIDTH_KEY,
  );
}

/** Sets the window to `width` × 900 and waits until the layout has it. */
async function windowWidth(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await until(async () => (await widths(page)).window === width, `the window is ${width} px wide`);
}

/**
 * How the list zone lays out: the elements that scroll sideways (`overflow-x` auto or scroll and
 * wider content), the parts of a row, a row's line, a section's band, the chips' row and the
 * filter's bar that leave the list or their group, the pairs of such parts that overlap, and each
 * row title's width and whether it ends in an ellipsis.
 */
async function layout(page: Page): Promise<{
  scrolls: string[];
  leaves: string[];
  overlaps: string[];
  titles: { width: number; ellipsis: boolean }[];
  parts: number;
  rows: number;
}> {
  return readPage(
    page,
    () => {
      const scrolls: string[] = [];
      const leaves: string[] = [];
      const overlaps: string[] = [];
      const zone = document.getElementById('list-zone') as HTMLElement;
      for (const element of [zone, ...zone.querySelectorAll('*')]) {
        const overflow = getComputedStyle(element).overflowX;
        if (
          (overflow === 'auto' || overflow === 'scroll') &&
          element.scrollWidth > element.clientWidth
        ) {
          scrolls.push(`${element.className}: ${element.scrollWidth} > ${element.clientWidth}`);
        }
      }
      const shown = (element: Element): DOMRect | null => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const inside = (part: DOMRect, box: DOMRect): boolean =>
        part.left >= box.left - 0.5 && part.right <= box.right + 0.5;
      const overlap = (a: DOMRect, b: DOMRect): boolean =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const groups = [
        ...zone.querySelectorAll('.list-row'),
        ...zone.querySelectorAll('.row-line'),
        ...zone.querySelectorAll('.list-section'),
        ...zone.querySelectorAll('.list-chiprow'),
        ...zone.querySelectorAll('.list-filterbar'),
      ];
      const list = zone.getBoundingClientRect();
      let parts = 0;
      for (const group of groups) {
        const box = shown(group);
        if (box === null) continue;
        const children = [...group.children].flatMap((child) => {
          const rect = shown(child);
          return rect === null ? [] : [{ child, rect }];
        });
        parts += children.length;
        children.forEach(({ child, rect }, index) => {
          if (!inside(rect, list)) leaves.push(`${child.className} leaves the list`);
          if (!inside(rect, box)) leaves.push(`${child.className} leaves its ${group.className}`);
          for (const other of children.slice(index + 1)) {
            if (overlap(rect, other.rect)) {
              overlaps.push(`${child.className} overlaps ${other.child.className}`);
            }
          }
        });
      }
      const titles = [...zone.querySelectorAll('.row-title')].map((title) => ({
        width: title.getBoundingClientRect().width,
        ellipsis:
          getComputedStyle(title).textOverflow === 'ellipsis' &&
          title.scrollWidth > title.clientWidth,
      }));
      return {
        scrolls,
        leaves,
        overlaps,
        titles,
        parts,
        rows: zone.querySelectorAll('.list-row').length,
      };
    },
    null,
  );
}

await test('the list’s width (issue #192)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'nothing stored: the list is 400 px wide at every window width, also where the right side has less than 320 px; <html> has no --list-width',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      for (const width of [1920, 1400, 1000, 720, 600, 560]) {
        await windowWidth(page, width);
        const now = await widths(page);
        assert.equal(now.list, 400, `${width} px`);
        assert.equal(now.right, width - 400, `${width} px: the right side has the rest`);
        assert.equal(now.property, '', `${width} px`);
        assert.equal(now.stored, null);
      }
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a stored width: shown at most the window less 320 px, never under 240 px; the stored value stays, and a wider window shows it again',
    async (t) => {
      const { page, problems } = await opened(t, chromium, { stored: '700' });
      for (const [width, shown] of [
        [1400, 700],
        [1020, 700],
        [1000, 680],
        [900, 580],
        [560, 240],
        [480, 240],
        [1400, 700],
      ] as const) {
        await windowWidth(page, width);
        const now = await widths(page);
        assert.equal(now.list, shown, `${width} px`);
        assert.equal(now.stored, '700', `${width} px: the stored width is kept`);
      }
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a stored value that is no width: no whole number is nothing stored (400 px), a whole number is held to 240 … 800; the page works',
    async (t) => {
      for (const [stored, shown] of [
        ['', 400],
        ['wide', 400],
        ['500.5', 400],
        ['1e3', 400],
        [' 500', 400],
        ['-20', 240],
        ['100', 240],
        ['99999999999999999999', 800],
        ['523', 523],
      ] as const) {
        const { page, problems } = await opened(t, chromium, { stored });
        const now = await widths(page);
        assert.equal(now.list, shown, JSON.stringify(stored));
        assert.equal(now.stored, stored, `${JSON.stringify(stored)} is left as it is`);
        await page.locator(`#list [data-id="${S2}"]`).click();
        await page.waitForFunction(
          (id) =>
            document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
          S2,
          { timeout: PAGE_WAIT_MS },
        );
        assert.deepEqual(problems, [], JSON.stringify(stored));
        await page.context().close();
      }
    },
  );

  /** An init script that records, at every animation frame from the first, the list's width
   *  (null while it is not in the document). */
  const FRAMES = `(() => {
    const frames = [];
    Reflect.set(globalThis, 'widthFrames', frames);
    const tick = (at) => {
      frames.push({ at, width: document.getElementById('list-zone')?.getBoundingClientRect().width ?? null });
      if (frames.length < 400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();`;

  /** The frames FRAMES recorded once the list was in the document, and the page's first paint. */
  async function framesOf(page: Page): Promise<{ widths: number[]; first: number; paint: number }> {
    await until(
      async () =>
        (await page.evaluate(
          () => (Reflect.get(globalThis, 'widthFrames') as unknown[] | undefined)?.length ?? 0,
        )) >= 30,
      '30 frames recorded',
    );
    return page.evaluate(() => {
      const frames = Reflect.get(globalThis, 'widthFrames') as {
        at: number;
        width: number | null;
      }[];
      const listed = frames.filter((frame) => frame.width !== null);
      return {
        widths: listed.map((frame) => frame.width as number),
        first: listed[0]?.at ?? Infinity,
        paint:
          performance.getEntriesByType('paint').find((entry) => entry.name === 'first-paint')
            ?.startTime ?? -1,
      };
    });
  }

  /** Holds every load of list-width-early.js and of app.js for `ms`, then lets it go on. Holding
   *  the early script too is what tells a blocking script in <head> from one that is late. */
  async function slow(page: Page, ms: number): Promise<void> {
    await page.route('**/assets/*/web/{app,list-width-early}.js', async (route) => {
      await sleep(ms);
      await route.fallback();
    });
  }

  await t.test(
    'a stored width is in force from the first painted frame after a reload, also while the early script and the page’s modules are each held back 600 ms',
    async (t) => {
      const { page, problems } = await opened(t, chromium, { stored: '600' });
      await page.addInitScript(FRAMES);
      for (const held of [0, 600]) {
        if (held > 0) await slow(page, held);
        await page.reload();
        await connection(page, 'open');
        const { widths: seen, first, paint } = await framesOf(page);
        assert.ok(paint > 0, 'the page was painted');
        assert.ok(
          first <= paint + 1,
          `the first frame with the list (${first}) comes no later than the first paint (${paint})`,
        );
        assert.deepEqual(
          seen.filter((width) => width !== 600),
          [],
          `held ${held} ms: every frame shows 600 px`,
        );
        await page.unrouteAll();
      }
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'at 240 px and at 800 px, rows whose fixed parts fit: no horizontal scroll bar, no part overlaps another or leaves its row, and each title ends in an ellipsis; a row whose fixed parts are wider than the list scrolls sideways at 240 px as it does at 400 px with nothing stored (the layout before issue #192), its parts still apart',
    async (t) => {
      for (const [rows, stored] of [
        ['fit', '240'],
        ['fit', '800'],
        ['wide', undefined],
        ['wide', '240'],
      ] as const) {
        const what = `${rows} rows, ${stored ?? 'nothing stored'}`;
        const { page, problems } = await opened(t, chromium, { rows, stored });
        assert.equal((await widths(page)).list, Number(stored ?? 400), what);
        const found = await layout(page);
        assert.equal(found.rows, 3, `${what}: three rows`);
        assert.ok(found.parts > 15, `${what}: the parts were measured (${found.parts})`);
        assert.deepEqual(found.overlaps, [], `${what}: no part overlaps another`);
        if (rows === 'fit') {
          assert.deepEqual(found.scrolls, [], `${what}: no horizontal scroll bar`);
          assert.deepEqual(found.leaves, [], `${what}: every part inside its row`);
          assert.deepEqual(
            found.titles.filter((title) => !title.ellipsis || title.width < 20),
            [],
            `${what}: each title shown, ending in an ellipsis`,
          );
        } else {
          assert.deepEqual(
            found.scrolls.map((one) => one.split(':')[0]),
            ['list-body'],
            `${what}: the rows scroll sideways`,
          );
        }
        assert.deepEqual(problems, []);
        await page.context().close();
      }
    },
  );
});
