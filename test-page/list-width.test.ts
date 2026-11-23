// The list's width (issue #192; S2 12.1, 12.9): nothing stored is today's layout (400 px at any
// window width); a stored width (the page's localStorage, `skydeck-list-width`) is in force from
// the first painted frame, held to the window less 320 px and never under 240 px, and kept when a
// narrower window shows less of it; a stored value that is no width is nothing stored, or held to
// 240 … 800; at 240 and 800 px rows whose fixed parts fit give no horizontal scroll bar, no
// overlapping parts and titles that end in an ellipsis, and a row whose fixed parts are wider than
// the list scrolls sideways as it does at 400 px before issue #192.
// The handle on the border (web/list-width.js): a drag with the primary button changes the width
// live and stores it at its release (also one outside the window), a double click gives 400 px
// back and removes it, other buttons do nothing; storage that throws, takes nothing or is missing
// still lets it work for the life of the page; a press, a drag and a double click move no
// keyboard and reach neither the rows nor the terminal's program; a second page follows; under a
// dialog it does nothing; the tour's ring lies on the zones at the width in force; and against a
// real test server with the stand-in program the terminal follows by the page's refit, as at a
// window resize. The page has web/'s real modules, on a scripted stand-in server (helpers/shell.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { HANDLE_TITLE, LIST_WIDTH_KEY } from '../web/list-width-text.js';
import { browser, newContext, newPage } from './helpers/browser.ts';
import {
  active,
  after,
  connection,
  honest,
  launched,
  logOf,
  mark,
  PAGE_WAIT_MS,
  problemsOf,
  readPage,
  scriptedList,
  selectedRow,
  standinServer,
  storeKey,
  TERM_A,
  TERM_B,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { Logged, Standin } from './helpers/shell.ts';
import { promptOf, recordsOf, resumeHere, until, untilScreen } from './helpers/terminal.ts';

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

  /** The handle's middle, where a press grabs it. */
  async function handleAt(page: Page): Promise<{ x: number; y: number }> {
    const box = await page.locator('#list-handle').boundingBox();
    assert.ok(box !== null, 'the handle is shown');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Presses the handle with the primary button, moves by each of `by` px in turn (asserting
   *  `live` after each move when given) and releases. */
  async function drag(
    page: Page,
    by: number[],
    live?: (width: number, index: number) => void | Promise<void>,
  ): Promise<void> {
    const at = await handleAt(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (const [index, dx] of by.entries()) {
      await page.mouse.move(at.x + dx, at.y + 40, { steps: 4 });
      if (live !== undefined) await live((await widths(page)).list, index);
    }
    await page.mouse.up();
  }

  await t.test(
    'the handle: over the border, a few px to each side, with the column-resize cursor, its tooltip, no tab stop and no part of either zone',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      const handle = await readPage(
        page,
        () => {
          const element = document.getElementById('list-handle') as HTMLElement;
          const box = element.getBoundingClientRect();
          const zone = document.getElementById('list-zone') as HTMLElement;
          return {
            left: box.left,
            right: box.right,
            border: zone.getBoundingClientRect().right,
            cursor: getComputedStyle(element).cursor,
            title: element.title,
            tabIndex: element.tabIndex,
            inZone:
              zone.contains(element) || document.getElementById('right-zone')?.contains(element),
            // Across the strip, at the header's height, over the rows and over the terminal.
            hits: [box.left + 0.5, box.left + box.width / 2, box.right - 0.5].flatMap((x) =>
              [40, 300, 600].map((y) => document.elementFromPoint(x, y)?.id ?? ''),
            ),
          };
        },
        null,
      );
      assert.ok(handle.left < handle.border - 2 && handle.right > handle.border + 2, 'astride');
      assert.ok(handle.right - handle.left <= 8, 'a narrow strip');
      assert.equal(handle.cursor, 'col-resize');
      assert.equal(handle.title, HANDLE_TITLE);
      assert.equal(handle.tabIndex, -1, 'not a tab stop');
      assert.equal(handle.inZone, false);
      assert.deepEqual(
        new Set(handle.hits),
        new Set(['list-handle']),
        'all of it takes the pointer, over the list, the header and the terminal’s layers',
      );
      // The key help lies over it (it is no dialog: the page under it is not inert).
      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      const covered = await readPage(
        page,
        () => {
          const help = (document.getElementById('help') as HTMLElement).getBoundingClientRect();
          const box = (
            document.getElementById('list-handle') as HTMLElement
          ).getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = help.top + help.height / 2;
          return {
            over: help.left < x && help.right > x,
            hit: document.getElementById('help')?.contains(document.elementFromPoint(x, y)),
          };
        },
        null,
      );
      assert.ok(covered.over, 'at 1400 px the help spans the border');
      assert.equal(covered.hit, true, 'the help, not the handle, is on top');
      await page.keyboard.press('Control+Shift+H');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a drag changes the width live, within 240 … 800 and leaving the right side 320 px; the width at its release is stored, not before',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      await drag(page, [100, 300, 600, -300, -1000, 123], async (width, index) => {
        assert.equal(width, [500, 700, 800, 240, 240, 523][index], `move ${index}`);
        assert.equal((await widths(page)).stored, null, `move ${index}: nothing stored yet`);
      });
      assert.equal((await widths(page)).stored, '523', 'stored at the release');
      // In a window of 1000 px the right side keeps 320: at most 680.
      await windowWidth(page, 1000);
      await drag(page, [400], (width) => assert.equal(width, 680));
      assert.deepEqual(
        { list: (await widths(page)).list, stored: (await widths(page)).stored },
        { list: 680, stored: '680' },
      );
      // A press and a release with no move stores nothing (and changes nothing).
      await page.evaluate((key) => localStorage.removeItem(key), LIST_WIDTH_KEY);
      await drag(page, []);
      assert.equal((await widths(page)).stored, null, 'a click stores nothing');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a release outside the window ends the drag (the pointer is captured); a secondary or a middle press does nothing',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      const at = await handleAt(page);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 200, at.y, { steps: 4 });
      await page.mouse.move(at.x + 200, -50, { steps: 2 }); // above the window
      await page.mouse.up();
      assert.deepEqual(
        { list: (await widths(page)).list, stored: (await widths(page)).stored },
        { list: 600, stored: '600' },
      );
      await page.mouse.move(at.x + 400, 300, { steps: 4 });
      assert.equal((await widths(page)).list, 600, 'the drag is over');
      const grip = await handleAt(page);
      for (const button of ['right', 'middle'] as const) {
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down({ button });
        await page.mouse.move(grip.x + 150, grip.y, { steps: 4 });
        await page.mouse.up({ button });
        assert.equal((await widths(page)).list, 600, button);
      }
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a double click on the handle gives 400 px back and removes the stored value; the window’s clamp then no longer applies',
    async (t) => {
      const { page, problems } = await opened(t, chromium, { stored: '700' });
      assert.equal((await widths(page)).list, 700);
      const at = await handleAt(page);
      await page.mouse.dblclick(at.x, at.y);
      const now = await widths(page);
      assert.deepEqual(
        { list: now.list, stored: now.stored, property: now.property },
        { list: 400, stored: null, property: '' },
      );
      await windowWidth(page, 600);
      assert.equal((await widths(page)).list, 400, 'nothing stored: 400 px in any window');
      assert.deepEqual(problems, []);
    },
  );

  /** A localStorage that throws at its every use, and one that reads nothing and refuses writes. */
  const STORAGES = [
    [
      'storage that throws',
      `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });`,
    ],
    [
      'storage that takes nothing',
      `Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() { throw new DOMException('full', 'QuotaExceededError'); }, removeItem() { throw new DOMException('full', 'QuotaExceededError'); } } });`,
    ],
    [
      'no storage',
      `Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });`,
    ],
  ] as const;

  for (const [what, storage] of STORAGES) {
    await t.test(
      `${what}: 400 px at the load; a drag and a double click still work, the width holds until the page is closed`,
      async (t) => {
        const { page, problems } = await opened(t, chromium, { stored: '700', init: storage });
        assert.equal((await widths(page)).list, 400, 'what is stored cannot be read');
        await drag(page, [200], (width) => assert.equal(width, 600));
        assert.equal((await widths(page)).list, 600, 'it holds after the release');
        await sleep(300);
        assert.equal((await widths(page)).list, 600, 'and stays');
        const at = await handleAt(page);
        await page.mouse.dblclick(at.x, at.y);
        assert.equal((await widths(page)).list, 400);
        await drag(page, [50]);
        await page.reload();
        await connection(page, 'open');
        assert.equal((await widths(page)).list, 400, 'a reload: nothing was kept');
        assert.deepEqual(problems, []);
      },
    );
  }

  await t.test(
    'without the early script, the stored width comes with the page’s modules (web/list-width.js reads it too): the control of the first-paint case',
    async (t) => {
      const { page, problems } = await opened(t, chromium, { stored: '600' });
      await page.addInitScript(FRAMES);
      await page.route('**/assets/*/web/list-width-early.js', (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
      );
      await slow(page, 600);
      await page.reload();
      await connection(page, 'open');
      const { widths: seen } = await framesOf(page);
      assert.ok(seen.includes(400), 'without the early script some frames show 400 px');
      assert.equal(seen.at(-1), 600, 'then the stored width');
      await page.unrouteAll();
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a drag then a reload: the width at the release is in force from the first painted frame',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      await drag(page, [250]);
      assert.equal((await widths(page)).stored, '650');
      await page.addInitScript(FRAMES);
      await page.reload();
      await connection(page, 'open');
      const { widths: seen, first, paint } = await framesOf(page);
      assert.ok(first <= paint + 1, `the first frame (${first}), the first paint (${paint})`);
      assert.deepEqual(
        seen.filter((width) => width !== 650),
        [],
      );
      assert.deepEqual(problems, []);
    },
  );

  /** What the page under the pointer shows of the keyboard and the selection. */
  async function keyboardState(page: Page): Promise<{
    active: string;
    zone: string;
    selected: string | null;
    text: string;
    terminalSelection: number;
  }> {
    return {
      active: await active(page),
      zone: await zone(page),
      selected: await selectedRow(page),
      ...(await readPage(
        page,
        () => ({
          text: getSelection()?.toString() ?? '',
          terminalSelection: document.querySelectorAll('#terminal .xterm-selection div').length,
        }),
        null,
      )),
    };
  }

  for (const where of ['terminal', 'list'] as const) {
    await t.test(
      `the keyboard in the ${where}: a press, a drag over the rows and over the terminal, a double click, a secondary and a middle press leave it there, select no text and no row, and send the terminal’s program nothing (it asked for the mouse); the next key goes where it went before`,
      async (t) => {
        const { page, d, problems } = await opened(t, chromium, {
          snap: '\x1b[?1002h\x1b[?1006hready',
        });
        await toZone(page, where);
        if (where === 'terminal') {
          await until(async () => (await active(page)) === 'in #terminal', 'xterm.js has it');
        }
        const before = await keyboardState(page);
        assert.equal(before.selected, S1);
        const from = d.sent.length;
        const at = await handleAt(page);
        // A press.
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.up();
        // A drag over the rows (left), then over the terminal (right), then back.
        await page.mouse.down();
        await page.mouse.move(at.x - 120, 120, { steps: 6 });
        await page.mouse.move(at.x + 300, 400, { steps: 6 });
        await page.mouse.move(at.x + 50, 200, { steps: 6 });
        await page.mouse.up();
        assert.equal((await widths(page)).list, 450);
        // A double click.
        const grip = await handleAt(page);
        await page.mouse.dblclick(grip.x, grip.y);
        assert.equal((await widths(page)).list, 400);
        // A secondary and a middle press, on the handle where it is now.
        const back = await handleAt(page);
        await page.mouse.move(back.x, back.y);
        for (const button of ['right', 'middle'] as const) {
          await page.mouse.down({ button });
          await page.mouse.up({ button });
        }
        await sleep(300); // app.js's mouseup rule runs after a timeout
        assert.deepEqual(await keyboardState(page), before);
        assert.deepEqual(
          d.sent.slice(from).filter((message) => message['t'] === 'input'),
          [],
          'the terminal’s program got nothing',
        );
        assert.deepEqual(
          d.sent.slice(from).filter((message) => message['t'] === 'view'),
          [],
          'no row was selected',
        );
        // The next key goes where it went before.
        if (where === 'terminal') {
          await page.keyboard.type('x');
          await until(
            () =>
              d.sent
                .slice(from)
                .some((message) => message['t'] === 'input' && message['data'] === 'x'),
            'the x reached the terminal',
          );
        } else {
          await page.keyboard.press('ArrowDown');
          await until(async () => (await selectedRow(page)) === S2, 'ArrowDown moved the list');
        }
        assert.deepEqual(problems, []);
      },
    );
  }

  await t.test(
    'a second page of the same browser takes the width when the first one’s drag ends, and the default at its double click',
    async (t) => {
      const context = await newContext(chromium);
      t.after(() => context.close());
      const one = await context.newPage();
      const two = await context.newPage();
      const problems = [one, two].map((page) => problemsOf(page));
      const d = await deck(t);
      await open(d, one);
      await open(d, two);
      const at = await handleAt(one);
      await one.mouse.move(at.x, at.y);
      await one.mouse.down();
      await one.mouse.move(at.x + 180, at.y, { steps: 4 });
      assert.equal((await widths(one)).list, 580);
      await sleep(200);
      assert.equal((await widths(two)).list, 400, 'not before the drag ends');
      await one.mouse.up();
      await until(async () => (await widths(two)).list === 580, 'the second page follows');
      await one.mouse.dblclick(at.x + 180, at.y);
      await until(async () => (await widths(two)).list === 400, 'and follows the double click');
      assert.deepEqual(problems.flat(), []);
    },
  );

  await t.test(
    'with a dialog open (Settings, the switcher, the tour) the handle does nothing: no drag, no double click, also when its events come straight to it; a dialog that opens during a drag ends it',
    async (t) => {
      const page = await newPage(t, chromium, { tour: true });
      const problems = problemsOf(page);
      await page.setViewportSize({ width: 1400, height: 900 });
      const d = await deck(t);
      await open(d, page, { stored: '600' });
      const tourShown = (): Promise<boolean> =>
        readPage(page, () => document.getElementById('tour')?.hidden === false, null);
      await until(tourShown, 'the tour started by itself');
      /** Tries a drag and a double click by events sent to the handle itself (while the
       *  dialog `shown` is surely there), then by the mouse on the scrim over the handle (a press
       *  there may close the dialog, as the switcher's does: the double click only while it is
       *  still shown). */
      const tries = async (what: string, shown: string): Promise<void> => {
        const still = (): Promise<boolean> =>
          readPage(
            page,
            (selector) => document.querySelector(selector)?.hasAttribute('hidden') === false,
            shown,
          );
        const unchanged = async (how: string): Promise<void> => {
          const now = await widths(page);
          assert.deepEqual(
            { list: now.list, stored: now.stored },
            { list: 600, stored: '600' },
            `${what}, ${how}`,
          );
        };
        assert.ok(await still(), `${what} is shown`);
        await page.evaluate(() => {
          const handle = document.getElementById('list-handle') as HTMLElement;
          const init = { bubbles: true, pointerId: 1, button: 0, clientX: 600, clientY: 450 };
          handle.dispatchEvent(new PointerEvent('pointerdown', init));
          handle.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: 750 }));
          handle.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: 750 }));
          handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
        });
        await unchanged('events sent to the handle');
        const at = { x: 600, y: 450 };
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + 150, at.y, { steps: 4 });
        await page.mouse.up();
        await unchanged('a drag by the mouse');
        if (await still()) {
          await page.mouse.dblclick(at.x, at.y);
          await unchanged('a double click by the mouse');
        }
      };
      await tries('the tour', '#tour');
      await page.keyboard.press('Escape');
      await until(async () => !(await tourShown()), 'the tour is closed');
      for (const [what, open, shown] of [
        ['Settings', '#settings-button', '#settings'],
        ['the switcher', '#switch-button', '#switcher'],
      ] as const) {
        await page.locator(open).click();
        await page.waitForSelector(`${shown}:not([hidden])`, {
          state: 'attached',
          timeout: PAGE_WAIT_MS,
        });
        await tries(what, shown);
        if (
          await readPage(
            page,
            (selector) => document.querySelector(selector)?.hasAttribute('hidden') === false,
            shown,
          )
        ) {
          await page.keyboard.press('Escape');
        }
        await page.waitForSelector(`${shown}[hidden]`, {
          state: 'attached',
          timeout: PAGE_WAIT_MS,
        });
      }
      // The switcher opened by its chord during a drag: the drag ends there.
      const at = await handleAt(page);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x - 100, at.y, { steps: 4 });
      await page.keyboard.press('Control+Shift+P');
      await page.waitForSelector('#switcher:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await page.mouse.move(at.x + 100, at.y, { steps: 4 });
      await page.mouse.up();
      const now = await widths(page);
      assert.deepEqual({ list: now.list, stored: now.stored }, { list: 500, stored: '500' });
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'the tour’s frame around the list and around the right side matches the width in force, in a window that shows all of it and in one that holds it',
    async (t) => {
      for (const width of [1400, 900]) {
        const page = await newPage(t, chromium, { tour: true });
        const problems = problemsOf(page);
        await page.setViewportSize({ width, height: 900 });
        const d = await deck(t);
        await open(d, page, { stored: '700' });
        assert.equal((await widths(page)).list, width === 1400 ? 700 : 580);
        for (const [step, region] of [
          ['1', '#list-zone'],
          ['2', '#right-zone'],
        ] as const) {
          await page.waitForSelector(`#tour:not([hidden])[data-step="${step}"]`, {
            state: 'attached',
            timeout: PAGE_WAIT_MS,
          });
          const boxes = await readPage(
            page,
            (selector) => {
              const plain = (element: Element | null): number[] => {
                const rect = element?.getBoundingClientRect();
                return [
                  rect?.left ?? NaN,
                  rect?.top ?? NaN,
                  rect?.width ?? NaN,
                  rect?.height ?? NaN,
                ];
              };
              return {
                ring: plain(document.querySelector('#tour .tour-spot')),
                region: plain(document.querySelector(selector)),
              };
            },
            region,
          );
          boxes.ring.forEach((value, index) =>
            assert.ok(
              Math.abs(value - (boxes.region[index] ?? NaN)) < 1,
              `${width} px, ${region}: ${JSON.stringify(boxes)}`,
            ),
          );
          await page.keyboard.press('Enter');
        }
        assert.deepEqual(problems, []);
        await page.context().close();
      }
    },
  );

  /** The sizes the stand-in of S1 had: its start's, then every resize's. */
  const sizesOf = (record: string): string[] =>
    recordsOf(record, S1).flatMap((e) =>
      (e.ev === 'start' && e.cols !== null) || e.ev === 'resize' ? [`${e.cols}x${e.rows}`] : [],
    );

  /** Waits until the stand-in's last size is not `not` and has held for 700 ms (past the view's
   *  100 ms refit and app.js's 200 ms `focus`); returns it. */
  async function settledSize(record: string, not?: string): Promise<string> {
    const deadline = performance.now() + PAGE_WAIT_MS;
    let last = sizesOf(record).at(-1);
    let since = performance.now();
    for (;;) {
      const now = sizesOf(record).at(-1);
      if (now !== last) {
        last = now;
        since = performance.now();
      }
      if (last !== undefined && last !== not && performance.now() - since >= 700) return last;
      if (performance.now() > deadline) assert.fail(`the size never settled (${last}, not ${not})`);
      await sleep(50);
    }
  }

  await t.test(
    'against a real server: after a drag the shown terminal has the size a window resize to the same right side gives (the page’s refit), and the page sends nothing such a resize does not',
    async (t) => {
      const l = await launched(t, chromium);
      await l.page.setViewportSize({ width: 1400, height: 900 });
      l.d.resumable(S1);
      await resumeHere(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      const at400 = await settledSize(l.d.record);
      await mark(l.page, 'drag');
      await drag(l.page, [200]);
      assert.equal((await widths(l.page)).list, 600);
      const dragged = await settledSize(l.d.record, at400);
      const byDrag = after(await logOf(l.page), 'drag').filter((entry) => entry.e === 'out');
      const cols = (size: string): number => Number(size.split('x')[0]);
      assert.ok(cols(dragged) < cols(at400), `fewer columns: ${at400} → ${dragged}`);
      const grip = await handleAt(l.page);
      await l.page.mouse.dblclick(grip.x, grip.y);
      assert.equal(await settledSize(l.d.record, dragged), at400, 'the double click: as before');
      await mark(l.page, 'window');
      await windowWidth(l.page, 1200);
      assert.equal(
        await settledSize(l.d.record, at400),
        dragged,
        'a window 200 px narrower gives the same size',
      );
      const byWindow = after(await logOf(l.page), 'window').filter((entry) => entry.e === 'out');
      const types = (log: Logged[]): string[] =>
        [...new Set(log.map((entry) => entry.t ?? ''))].sort();
      assert.ok(types(byDrag).includes('resize'), JSON.stringify(byDrag));
      assert.deepEqual(types(byDrag), types(byWindow), 'the same kinds of message');
      assert.deepEqual(l.problems, []);
    },
  );
});
