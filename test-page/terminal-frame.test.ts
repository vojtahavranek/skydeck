// The terminal's frame (follow-up F2 of step 2; S2 8.2.6, 12.6): the room between the terminal's
// text and its box, the size counted inside that room, and the softer lines around the terminal.
// A real test server whose terminals run the stand-in, or the view's module alone in a page of the
// server; the page's real style sheets, light and dark (Playwright's colour-scheme emulation).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { S1 } from '../test/helpers/platform.ts';
import { startTestServer } from '../test/helpers/window.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  after,
  assetBase,
  launched,
  logOf,
  mark,
  pageUrl,
  readPage,
  showsText,
  toZone,
} from './helpers/shell.ts';
import {
  inputOf,
  promptOf,
  recordsOf,
  resumeHere,
  screenText,
  untilScreen,
  until,
} from './helpers/terminal.ts';

/** D1 of F2: the room between the terminal's text and its box, in CSS pixels; RIGHT lies between
 *  the text and the scroll bar's room. */
const TOP = 8;
const BOTTOM = 8;
const LEFT = 10;
const RIGHT = 10;
/** The room the view leaves for xterm.js's scroll bar at the box's right edge (S2 8.2.6). */
const SCROLL_BAR = 14;

const SCHEMES = ['light', 'dark'] as const;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The shown terminal's area (`#terminal`), its text (xterm.js's screen) and its scroll bar. */
interface Geometry {
  box: Box;
  text: Box;
  bar: (Box & { visible: boolean }) | null;
}

async function geometry(page: Page): Promise<Geometry> {
  return readPage(
    page,
    () => {
      const plain = (r: DOMRect): Box => ({
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      });
      const area = document.getElementById('terminal');
      const term = document.querySelector('#terminal .tv-term:not([hidden])');
      const screen = term?.querySelector('.xterm-screen');
      if (area === null || !(screen instanceof HTMLElement)) throw new Error('no shown terminal');
      const bar = term?.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
      return {
        box: plain(area.getBoundingClientRect()),
        text: plain(screen.getBoundingClientRect()),
        bar:
          bar instanceof HTMLElement
            ? { ...plain(bar.getBoundingClientRect()), visible: bar.classList.contains('visible') }
            : null,
      };
    },
    null,
  );
}

/** The sizes the stand-in of S1 had, in order: its start's, then every resize's. */
function sizesOf(d: ServerSandbox): string[] {
  return recordsOf(d.record, S1).flatMap((e) =>
    (e.ev === 'start' && e.cols !== null) || e.ev === 'resize' ? [`${e.cols}x${e.rows}`] : [],
  );
}

/** The resizes the stand-in of S1 recorded, in order. */
function resizesOf(d: ServerSandbox): string[] {
  return recordsOf(d.record, S1).flatMap((e) => (e.ev === 'resize' ? [`${e.cols}x${e.rows}`] : []));
}

/** How far the area inside the room reaches past the text's right and bottom edges. */
function slack(g: Geometry): { right: number; bottom: number } {
  return {
    right: g.box.right - SCROLL_BAR - RIGHT - g.text.right,
    bottom: g.box.bottom - BOTTOM - g.text.bottom,
  };
}

/**
 * Whether `cols` × `rows` is what the area inside the room holds: the text starts at LEFT and TOP,
 * ends inside the room, and one more column or row would not fit (within xterm.js's rounding of
 * the screen to whole pixels: a column is the screen's width / cols, ± 1 px).
 */
function countOfInside(g: Geometry, cols: number, rows: number): string | null {
  const cell = (g.text.right - g.text.left) / cols;
  const row = (g.text.bottom - g.text.top) / rows;
  const { right, bottom } = slack(g);
  const problems = [
    Math.abs(g.text.left - g.box.left - LEFT) > 0.01 ? `left ${g.text.left - g.box.left}` : '',
    Math.abs(g.text.top - g.box.top - TOP) > 0.01 ? `top ${g.text.top - g.box.top}` : '',
    right < -0.01 || right >= cell + 1 ? `right slack ${right} (cell ${cell})` : '',
    bottom < -0.01 || bottom >= row - 0.01 ? `bottom slack ${bottom} (row ${row})` : '',
  ].filter((p) => p !== '');
  return problems.length === 0 ? null : problems.join(', ');
}

/** The size the alt screen's frame shows (the stand-in redraws it at every resize). */
async function frameSize(page: Page): Promise<{ cols: number; rows: number } | null> {
  const shown = /alt screen (\d+)x(\d+)/.exec(await screenText(page));
  return shown === null ? null : { cols: Number(shown[1]), rows: Number(shown[2]) };
}

/**
 * Waits until the program has the size the page shows on its alt screen and that size is the
 * count of the area inside the room (the page proposed it and the server applied it); returns it.
 */
async function settled(
  page: Page,
  d: ServerSandbox,
): Promise<{ cols: number; rows: number; g: Geometry }> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const size = await frameSize(page);
    const g = await geometry(page);
    const now = sizesOf(d).at(-1);
    const wrong =
      size === null
        ? 'no frame'
        : now !== `${size.cols}x${size.rows}`
          ? `the program is ${now}, the frame ${size.cols}x${size.rows}`
          : countOfInside(g, size.cols, size.rows);
    if (wrong === null && size !== null) return { ...size, g };
    if (performance.now() > deadline) {
      assert.fail(
        `the size never settled on the area inside the room: ${wrong}; ${JSON.stringify(g)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Waits until the terminal's area and the shown terminal's xterm.js element have not changed
 * size for `quiet` ms, measured in the page (five times the view's 100 ms wait before it
 * proposes a changed layout): what a view that measures what it holds would answer comes by then.
 */
async function keptStill(page: Page, quiet = 500): Promise<void> {
  await page.evaluate(
    async ({ quiet, wait }) => {
      let last = performance.now();
      const observer = new ResizeObserver(() => {
        last = performance.now();
      });
      for (const selector of ['#terminal', '#terminal .tv-term:not([hidden]) .xterm']) {
        const element = document.querySelector(selector);
        if (element !== null) observer.observe(element);
      }
      const deadline = performance.now() + wait;
      while (performance.now() - last < quiet) {
        if (performance.now() > deadline) throw new Error('the terminal never kept still');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      observer.disconnect();
    },
    { quiet, wait: PAGE_WAIT_MS },
  );
}

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** The number of the first `line <n>` the shown terminal shows (the stand-in's `/lines`), or -1. */
async function firstLine(page: Page): Promise<number> {
  const shown = /^line (\d+)$/m.exec(await screenText(page));
  return shown === null ? -1 : Number(shown[1]);
}

/**
 * Waits until the first line shown is no longer line `from` and has not changed for 300 ms (a
 * scroll that goes on is waited for to its end); returns it.
 */
async function scrolledFrom(page: Page, from: number, what: string): Promise<number> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  let last = from;
  let since = performance.now();
  for (;;) {
    const now = await firstLine(page);
    if (now !== last) {
      last = now;
      since = performance.now();
    }
    if (last !== from && performance.now() - since >= 300) return last;
    if (performance.now() > deadline) {
      assert.fail(`${what}: the screen never scrolled from line ${from} (now ${last})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A real server's page at `width` × `height` with S1 resumed in it and its prompt shown. */
async function resumed(
  t: TestContext,
  chromium: Browser,
  width: number,
  height: number,
): Promise<Awaited<ReturnType<typeof launched>>> {
  const l = await launched(t, chromium);
  await l.page.setViewportSize({ width, height });
  l.d.resumable(S1);
  await resumeHere(l.page, S1);
  await untilScreen(l.page, promptOf(S1));
  return l;
}

/** `css` (any colour) as the browser computes it: `rgb(r, g, b)`. */
async function resolved(page: Page, css: string): Promise<string> {
  return readPage(
    page,
    (css) => {
      const probe = document.createElement('span');
      probe.style.color = css;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    },
    css,
  );
}

/** `rgb(r, g, b)` as its three numbers. */
function channels(colour: string): [number, number, number] {
  const match = /^rgba?\((\d+), (\d+), (\d+)/.exec(colour);
  assert.ok(match !== null, `a colour: ${colour}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG's contrast ratio of two `rgb(…)` colours (1: the same luminance). */
function contrast(a: string, b: string): number {
  const luminance = (colour: string): number => {
    const [r, g, bl] = channels(colour).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/**
 * The colours (`r,g,b`) of the page's pixels in `clip` (CSS pixels at a pixel ratio of 1), as the
 * screenshot has them; the browser decodes the picture, in a blank page of the same context.
 */
async function coloursIn(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<string[]> {
  const png = await page.screenshot({ clip });
  const blank = await page.context().newPage();
  try {
    return await blank.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no canvas');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      return [...seen];
    }, png.toString('base64'));
  } finally {
    await blank.close();
  }
}

/** Switches the page to `scheme` and waits until the shown terminal has taken its background. */
async function scheme(page: Page, which: 'light' | 'dark'): Promise<string> {
  await page.emulateMedia({ colorScheme: which });
  const bg = await resolved(page, 'var(--term-bg)');
  await page.waitForFunction(
    (bg) => {
      const element = document.querySelector(
        '#terminal .tv-term:not([hidden]) .xterm-scrollable-element',
      );
      return element instanceof HTMLElement && getComputedStyle(element).backgroundColor === bg;
    },
    bg,
    { timeout: PAGE_WAIT_MS },
  );
  return bg;
}

test("the terminal's frame", async (t) => {
  const chromium = await browser(t);

  await t.test(
    "at 1400 × 900 and 1100 × 700, light and dark: the terminal's text starts 10 px from its box's left and 8 px below its top and ends inside 10 px before the scroll bar's room and 8 px above its bottom, less than one cell more; the program's size is the count of that inner area; the margin is the terminal's own background",
    async (t) => {
      const l = await resumed(t, chromium, 1400, 900);
      const { page, d } = l;
      await typeLine(page, '/alt'); // a box drawn along all four edges of the screen
      for (const [width, height] of [
        [1400, 900],
        [1100, 700],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const which of SCHEMES) {
          const bg = channels(await scheme(page, which)).join(',');
          const { cols, rows, g } = await settled(page, d);
          const where = `${width}x${height}, ${which}, ${cols}x${rows}`;
          assert.equal(countOfInside(g, cols, rows), null, where);
          // The margin, 2 px clear of the text (a glyph's edge may be smoothed into it): every
          // pixel is the terminal's background — no line of another colour along the box's edges.
          const { box, text } = g;
          const strips = {
            left: { x: box.left, y: box.top, width: LEFT - 2, height: box.bottom - box.top },
            top: {
              x: box.left,
              y: box.top,
              width: box.right - SCROLL_BAR - box.left,
              height: TOP - 2,
            },
            bottom: {
              x: box.left,
              y: text.bottom + 2,
              width: box.right - SCROLL_BAR - box.left,
              height: box.bottom - text.bottom - 2,
            },
            right: {
              x: text.right + 2,
              y: box.top,
              width: box.right - SCROLL_BAR - text.right - 2,
              height: box.bottom - box.top,
            },
          };
          for (const [side, clip] of Object.entries(strips)) {
            assert.deepEqual(await coloursIn(page, clip), [bg], `${where}: the ${side} margin`);
          }
        }
      }
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'narrowing the window by less than one cell sends no resize; narrowing it on until one column fewer fits sends exactly one, of one column fewer, and nothing follows it',
    async (t) => {
      const l = await resumed(t, chromium, 1400, 900);
      const { page, d } = l;
      await typeLine(page, '/alt');
      let width = 1400;
      let { cols, rows, g } = await settled(page, d);
      // At least 2 px of room past the text, so that a narrowing of 1 px or more leaves it whole.
      if (slack(g).right < 2) {
        width += 3;
        await page.setViewportSize({ width, height: 900 });
        await keptStill(page);
        const wider = await settled(page, d);
        assert.deepEqual([wider.cols, wider.rows], [cols, rows], '3 px wider: still the same size');
        g = wider.g;
      }
      const step = Math.floor(slack(g).right);
      assert.ok(
        step >= 1 && step < (g.text.right - g.text.left) / cols,
        `${step} px is under a cell`,
      );
      const before = resizesOf(d).length;
      await mark(page, 'narrowing');
      await page.setViewportSize({ width: width - step, height: 900 });
      await keptStill(page);
      assert.deepEqual(resizesOf(d).slice(before), [], `${step} px narrower: no resize`);
      // One pixel more and the text no longer fits: one column fewer does.
      await page.setViewportSize({ width: width - step - 1, height: 900 });
      await until(() => resizesOf(d).length > before, 'the program was resized');
      await untilScreen(page, new RegExp(`alt screen ${cols - 1}x${rows}`));
      await keptStill(page);
      assert.deepEqual(resizesOf(d).slice(before), [`${cols - 1}x${rows}`]);
      const sent = after(await logOf(page), 'narrowing').filter(
        (e) => e.e === 'out' && e.t === 'resize',
      );
      assert.equal(sent.length, 1, 'the page proposed once');
      ({ cols, rows, g } = await settled(page, d));
      assert.equal(countOfInside(g, cols, rows), null);
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "the scroll bar stays at the terminal's right edge, and 10 px or more lie between the text and it",
    async (t) => {
      const l = await resumed(t, chromium, 1400, 900);
      const { page } = l;
      await typeLine(page, '/lines 120'); // more than the screen holds: a scrollback
      await untilScreen(page, /^line 120$/m);
      const { box } = await geometry(page);
      await page.mouse.move((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      await page.waitForSelector('#terminal .tv-term:not([hidden]) .scrollbar.vertical.visible', {
        timeout: PAGE_WAIT_MS,
      });
      const g = await geometry(page);
      assert.ok(g.bar !== null && g.bar.visible, 'the scroll bar shows');
      assert.equal(g.bar.right, g.box.right, "at the terminal's right edge");
      assert.equal(g.bar.right - g.bar.left, SCROLL_BAR);
      assert.ok(
        g.bar.left - g.text.right >= RIGHT - 0.01,
        `${g.bar.left - g.text.right} px between the text and the scroll bar`,
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "the lines that frame the terminal (the list's right edge, under the header, over the key bar, under an ended bar) are --edge in both schemes, softer than --line against the terminal and their neighbour but visible; the focused zone's top edge keeps its own colour",
    async (t) => {
      const l = await resumed(t, chromium, 1400, 900);
      const { page } = l;
      const lines = async (): Promise<Record<string, string>> =>
        readPage(
          page,
          () => {
            const style = (selector: string): CSSStyleDeclaration => {
              const element = document.querySelector(selector);
              if (element === null) throw new Error(`no ${selector}`);
              return getComputedStyle(element);
            };
            const ended = document.querySelector('#right-zone[data-pane="terminal"] #cards .card');
            return {
              list: style('#list-zone').borderRightColor,
              header: style('#cards .card-header').borderBottomColor,
              keys: style('.keybar').borderTopColor,
              ...(ended === null ? {} : { ended: getComputedStyle(ended).borderBottomColor }),
              focused: style('.zone.focused').borderTopColor,
              widths: [
                style('#list-zone').borderRightWidth,
                style('#cards .card-header').borderBottomWidth,
                style('.keybar').borderTopWidth,
              ].join(' '),
            };
          },
          null,
        );
      const check = async (which: 'light' | 'dark', withEnded: boolean): Promise<void> => {
        await page.emulateMedia({ colorScheme: which });
        const edge = await resolved(page, 'var(--edge)');
        const line = await resolved(page, 'var(--line)');
        const terminal = await resolved(page, 'var(--term-bg)');
        const now = await lines();
        assert.equal(now['widths'], '1px 1px 1px', which);
        for (const name of ['list', 'header', 'keys', ...(withEnded ? ['ended'] : [])]) {
          assert.equal(now[name], edge, `${which}: the ${name} line is --edge`);
        }
        assert.equal(now['focused'], await resolved(page, 'var(--selline)'), `${which}: focus`);
        // Softer than --line against the terminal and each line's other neighbour, still visible.
        const neighbours = {
          'the list': await resolved(page, 'var(--panel)'),
          'the key bar': await resolved(page, 'var(--panel2)'),
          'the header': await resolved(page, 'var(--panel)'),
        };
        assert.ok(
          contrast(edge, terminal) < contrast(line, terminal) && contrast(edge, terminal) > 1.05,
          `${which}: against the terminal ${contrast(edge, terminal)} (--line ${contrast(line, terminal)})`,
        );
        for (const [name, colour] of Object.entries(neighbours)) {
          assert.ok(
            contrast(edge, colour) < contrast(line, colour),
            `${which}: against ${name} ${contrast(edge, colour)} (--line ${contrast(line, colour)})`,
          );
        }
      };
      await showsText(page, '#focus-zone', /^Focus: terminal$/);
      for (const which of SCHEMES) await check(which, false);
      await toZone(page, 'list');
      for (const which of SCHEMES) await check(which, false);
      await toZone(page, 'terminal');
      await typeLine(page, '/exit');
      await page
        .locator('#cards .card button', { hasText: /^Resume$/ })
        .waitFor({ timeout: PAGE_WAIT_MS });
      for (const which of SCHEMES) await check(which, true);
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "the room is exact: over a sweep of widths and heights of more than one cell, in both schemes, the text starts at 10 px and 8 px, never ends past 10 px before the scroll bar's room or 8 px above the bottom, and reaches both exactly",
    async (t) => {
      const page = await newPage(t, chromium);
      const started = await startTestServer(t);
      await page.goto(pageUrl(started.server.port));
      const base = await assetBase(page);
      for (const which of SCHEMES) {
        await page.emulateMedia({ colorScheme: which });
        const out = await page.evaluate(async (base) => {
          const module = (await import(`${base}terminal-view.js`)) as {
            createTerminalView(
              root: HTMLElement,
              deps: object,
            ): {
              show(term: object): void;
              snap(message: object): void;
              size(message: object): void;
            };
          };
          const sent: Record<string, unknown>[] = [];
          const root = document.createElement('div');
          root.className = 'terminal';
          root.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px';
          document.body.append(root);
          const view = module.createTerminalView(root, {
            send: (message: Record<string, unknown>) => sent.push(message),
            chord: () => false,
            openLink: () => {},
          });
          const term = 'e1e1e1e1e1e1';
          const payload = (cols: number, rows: number): object => ({
            id: term,
            slot: null,
            sessionId: null,
            state: 'running',
            notReported: false,
            cols,
            rows,
            ownsSize: true,
          });
          view.show(payload(80, 24));
          await new Promise((resolve) => setTimeout(resolve, 20));
          view.snap({ t: 'snap', term, ch: 7, cols: 80, rows: 24, data: '' });
          // The view's own size goes out with the snap when it differs from the snap's.
          const own = sent.findLast((message) => message['t'] === 'resize');
          let size =
            own === undefined
              ? { cols: 80, rows: 24 }
              : { cols: own['cols'] as number, rows: own['rows'] as number };
          const areas: [number, number][] = [];
          for (let width = 900; width <= 918; width++) areas.push([width, 500]);
          for (let height = 500; height <= 520; height++) areas.push([907, height]);
          const insets: {
            at: string;
            left: number;
            top: number;
            right: number;
            bottom: number;
            cell: number;
            row: number;
          }[] = [];
          for (const [width, height] of areas) {
            root.style.width = `${width}px`;
            root.style.height = `${height}px`;
            const before = sent.length;
            view.show(payload(size.cols, size.rows));
            await Promise.resolve();
            const resize = sent.slice(before).find((message) => message['t'] === 'resize');
            if (resize !== undefined) {
              size = { cols: resize['cols'] as number, rows: resize['rows'] as number };
            }
            view.size({ t: 'size', term, ...size, owner: true });
            for (let i = 0; i < 40; i++) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (root.querySelector('.xterm-rows')?.children.length === size.rows) break;
            }
            const box = root.getBoundingClientRect();
            const screen = root.querySelector('.xterm-screen')?.getBoundingClientRect();
            if (screen === undefined) throw new Error('no screen');
            insets.push({
              at: `${width}x${height} ${size.cols}x${size.rows}`,
              left: screen.left - box.left,
              top: screen.top - box.top,
              right: box.right - screen.right,
              bottom: box.bottom - screen.bottom,
              cell: screen.width / size.cols,
              row: screen.height / size.rows,
            });
          }
          root.remove();
          return insets;
        }, base);
        const wrong = out.filter(
          (i) =>
            Math.abs(i.left - LEFT) > 0.01 ||
            Math.abs(i.top - TOP) > 0.01 ||
            i.right < SCROLL_BAR + RIGHT - 0.01 ||
            i.right >= SCROLL_BAR + RIGHT + i.cell + 1 ||
            i.bottom < BOTTOM - 0.01 ||
            i.bottom >= BOTTOM + i.row - 0.01,
        );
        assert.deepEqual(wrong.slice(0, 5), [], which);
        const widths = out.slice(0, 19);
        const heights = out.slice(19);
        assert.ok(
          widths.some((i) => Math.abs(i.right - SCROLL_BAR - RIGHT) < 0.51),
          `${which}: the text reaches 10 px before the scroll bar's room at some width`,
        );
        assert.ok(
          heights.some((i) => Math.abs(i.bottom - BOTTOM) < 0.01),
          `${which}: the text reaches 8 px above the bottom at some height`,
        );
      }
    },
  );

  await t.test(
    "the room is read from the style sheet: changed there — also on an ancestor, also in another unit than px — the text moves with it and the view's proposal and `fits` count the room as drawn (one source for both)",
    async (t) => {
      const page = await newPage(t, chromium);
      const started = await startTestServer(t);
      await page.goto(pageUrl(started.server.port));
      const base = await assetBase(page);
      const result = await page.evaluate(async (base) => {
        type View = {
          show(term: object): void;
          snap(message: object): void;
          size(message: object): void;
          fits(width: number, height: number): { cols: number; rows: number } | null;
        };
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(root: HTMLElement, deps: object): View;
        };
        const sent: Record<string, unknown>[] = [];
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: (message: Record<string, unknown>) => sent.push(message),
          chord: () => false,
          openLink: () => {},
        });
        const term = 'e2e2e2e2e2e2';
        const payload = (cols: number, rows: number): object => ({
          id: term,
          slot: null,
          sessionId: null,
          state: 'running',
          notReported: false,
          cols,
          rows,
          ownsSize: true,
        });
        const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
        view.show(payload(80, 24));
        await tick();
        const first = sent.find((message) => message['t'] === 'attach');
        let size = { cols: first?.['cols'] as number, rows: first?.['rows'] as number };
        view.snap({ t: 'snap', term, ch: 7, ...size, data: '' });
        await tick();
        const measure = async (): Promise<object> => {
          const before = sent.length;
          view.show(payload(size.cols, size.rows));
          await tick();
          const resize = sent.slice(before).find((message) => message['t'] === 'resize');
          if (resize !== undefined) {
            size = { cols: resize['cols'] as number, rows: resize['rows'] as number };
          }
          view.size({ t: 'size', term, ...size, owner: true });
          for (let i = 0; i < 40; i++) {
            await tick();
            if (root.querySelector('.xterm-rows')?.children.length === size.rows) break;
          }
          const box = root.getBoundingClientRect();
          const screen = root.querySelector('.xterm-screen')?.getBoundingClientRect();
          if (screen === undefined) throw new Error('no screen');
          return {
            size: { ...size },
            resized: resize !== undefined,
            fits: view.fits(900, 500),
            left: screen.left - box.left,
            top: screen.top - box.top,
            right: box.right - screen.right,
            bottom: box.bottom - screen.bottom,
            cell: screen.width / size.cols,
            row: screen.height / size.rows,
          };
        };
        const root2 = document.documentElement.style;
        const as = await measure();
        root2.setProperty('--tv-pad-top', '30px');
        root2.setProperty('--tv-pad-right', '50px');
        root2.setProperty('--tv-pad-bottom', '20px');
        root2.setProperty('--tv-pad-left', '40px');
        const changed = await measure();
        for (const side of ['top', 'right', 'bottom', 'left'])
          root2.removeProperty(`--tv-pad-${side}`);
        const back = await measure();
        // On an ancestor of xterm.js's element (the view's root), in rem: counted as it is drawn.
        root.style.setProperty('--tv-pad-left', '2rem');
        root.style.setProperty('--tv-pad-right', '1.5rem');
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const ancestor = await measure();
        root.style.removeProperty('--tv-pad-left');
        root.style.removeProperty('--tv-pad-right');
        root.remove();
        return { as, changed, back, ancestor, rem };
      }, base);
      type Measured = {
        size: { cols: number; rows: number };
        resized: boolean;
        fits: { cols: number; rows: number } | null;
        left: number;
        top: number;
        right: number;
        bottom: number;
        cell: number;
        row: number;
      };
      const as = result.as as Measured;
      const changed = result.changed as Measured;
      const back = result.back as Measured;
      const ancestor = result.ancestor as Measured;
      assert.deepEqual([as.left, as.top], [LEFT, TOP], 'the page as it is');
      assert.ok(changed.resized, 'a new proposal for the new room');
      assert.deepEqual(changed.fits, changed.size, '`fits` counts the same room');
      assert.deepEqual(
        [changed.left, changed.top],
        [40, 30],
        'the text moved with the style sheet',
      );
      assert.ok(
        changed.right >= SCROLL_BAR + 50 - 0.01 &&
          changed.right < SCROLL_BAR + 50 + changed.cell + 1,
        `right ${changed.right}`,
      );
      assert.ok(
        changed.bottom >= 20 - 0.01 && changed.bottom < 20 + changed.row,
        `bottom ${changed.bottom}`,
      );
      assert.deepEqual(back.size, as.size, 'and back');
      assert.deepEqual(back.fits, as.size);
      // 2rem at the left and 1.5rem at the right, set on the view's root.
      const left = 2 * result.rem;
      const right = 1.5 * result.rem;
      assert.ok(ancestor.resized, "a new proposal for the ancestor's room");
      assert.deepEqual(ancestor.fits, ancestor.size, '`fits` counts the same room');
      assert.equal(ancestor.left, left, 'drawn at 2rem');
      assert.ok(
        ancestor.right >= SCROLL_BAR + right - 0.01 &&
          ancestor.right < SCROLL_BAR + right + ancestor.cell + 1,
        `right ${ancestor.right}: counted as drawn (${right} px and the scroll bar's room)`,
      );
    },
  );

  await t.test(
    'a wheel in each of the four margins does what one over the nearest text cell does, once: it scrolls the scrollback as far as one over the text; in the mouse mode of the program it reaches the program as one report, as one over the text does',
    async (t) => {
      const l = await resumed(t, chromium, 1400, 900);
      const { page, d } = l;
      await typeLine(page, '/lines 200');
      await untilScreen(page, /^line 200$/m);
      const g = await geometry(page);
      const { box, text } = g;
      const middle = { x: (text.left + text.right) / 2, y: (text.top + text.bottom) / 2 };
      const points = {
        text: middle,
        left: { x: box.left + 4, y: middle.y },
        top: { x: middle.x, y: box.top + 4 },
        bottom: { x: middle.x, y: box.bottom - 3 },
        right: { x: box.right - SCROLL_BAR - 4, y: middle.y },
      };
      assert.ok(points.right.x > text.right, 'the right point is in the margin');
      const bottom = await firstLine(page);
      const scrolled: Record<string, number> = {};
      for (const [where, at] of Object.entries(points)) {
        await page.mouse.move(at.x, at.y);
        await page.mouse.wheel(0, -100);
        scrolled[where] = bottom - (await scrolledFrom(page, bottom, `a wheel at ${where}`));
        // Back to the bottom, with the wheel over the text.
        await page.mouse.move(middle.x, middle.y);
        await page.mouse.wheel(0, 5000);
        await until(async () => (await firstLine(page)) === bottom, 'back at the bottom');
      }
      assert.ok((scrolled['text'] ?? 0) > 0, JSON.stringify(scrolled));
      for (const where of Object.keys(points)) {
        assert.equal(scrolled[where], scrolled['text'], `${where}: ${JSON.stringify(scrolled)}`);
      }

      // The program's mouse mode (SGR reports): one report per wheel, in a margin as over the text.
      await typeLine(page, '/mouse');
      await page.waitForSelector('#terminal .tv-term:not([hidden]) .xterm.enable-mouse-events', {
        timeout: PAGE_WAIT_MS,
      });
      const typed = (): string => Buffer.from(inputOf(d.record, S1), 'hex').toString('latin1');
      for (const [where, at] of Object.entries(points)) {
        const from = typed().length;
        await page.mouse.move(at.x, at.y);
        await page.mouse.wheel(0, -100);
        // A key after it: the program has the wheel's reports once it has the key (one stream).
        await page.keyboard.press('KeyQ');
        await until(() => typed().slice(from).includes('q'), `the key after a wheel at ${where}`);
        const read = typed().slice(from);
        const reports = read.slice(0, read.indexOf('q')).split('\x1b[<64;').length - 1;
        assert.equal(reports, 1, `${where}: ${JSON.stringify(read)}`);
      }
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "at a fractional width of the terminal's area (as at a display scale of 125 %), the size a resume asks for is the one the view proposes: the program is not resized when its terminal attaches",
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      const base = await assetBase(page);
      // A width at which one pixel more holds one column more, by the view's own rule.
      const width = await page.evaluate(async (base) => {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(
            root: HTMLElement,
            deps: object,
          ): { fits(width: number, height: number): { cols: number; rows: number } | null };
        };
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: () => {},
          chord: () => false,
          openLink: () => {},
        });
        try {
          for (let w = 900; w < 1100; w++) {
            const now = view.fits(w, 600);
            const wider = view.fits(w + 1, 600);
            if (now !== null && wider !== null && wider.cols > now.cols) return w;
          }
          return null;
        } finally {
          root.remove();
        }
      }, base);
      assert.ok(width !== null, 'a column boundary between 900 and 1100 px');
      // The right zone half a pixel wider than that width, at a whole-pixel left edge.
      await page.addStyleTag({
        content: '.main { grid-template-columns: 400px calc(100% - 400.5px); }',
      });
      await page.setViewportSize({ width: width + 401, height: 900 });
      const zone = await readPage(
        page,
        () => document.getElementById('right-zone')?.getBoundingClientRect().width ?? 0,
        null,
      );
      assert.equal(zone, width + 0.5);
      l.d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await typeLine(page, '/alt');
      const { cols, rows } = await settled(page, d);
      assert.deepEqual(
        resizesOf(d),
        [],
        `started at ${sizesOf(d)[0]}; the view proposes ${cols}x${rows}`,
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "what lies over the terminal keeps its place in the terminal's box and changes no size: a bar, the 'sized by another window' hint, the find bar; an ended terminal's dimmed screen fills the box, its text inset as before",
    async (t) => {
      const page = await newPage(t, chromium);
      const started = await startTestServer(t);
      await page.goto(pageUrl(started.server.port));
      const base = await assetBase(page);
      const result = await page.evaluate(async (base) => {
        type View = {
          show(term: object): void;
          snap(message: object): void;
          size(message: object): void;
          exit(message: object): void;
          notice(term: string, kind: string, text: string): void;
          find(): void;
        };
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(root: HTMLElement, deps: object): View;
        };
        const sent: Record<string, unknown>[] = [];
        const root = document.createElement('div');
        root.className = 'terminal';
        root.style.cssText = 'position:fixed;left:30px;top:40px;width:1000px;height:700px';
        document.body.append(root);
        const view = module.createTerminalView(root, {
          send: (message: Record<string, unknown>) => sent.push(message),
          chord: () => false,
          openLink: () => {},
        });
        const term = 'e3e3e3e3e3e3';
        const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
        const payload = (cols: number, rows: number, state = 'running'): object => ({
          id: term,
          slot: null,
          sessionId: null,
          state,
          notReported: false,
          cols,
          rows,
          ownsSize: true,
        });
        view.show(payload(80, 24));
        await tick();
        const first = sent.find((message) => message['t'] === 'attach');
        const size = { cols: first?.['cols'] as number, rows: first?.['rows'] as number };
        view.snap({ t: 'snap', term, ch: 7, ...size, data: '' });
        view.size({ t: 'size', term, ...size, owner: true });
        await tick();
        const box = root.getBoundingClientRect();
        const at = (selector: string): object | null => {
          const element = root.querySelector(selector);
          if (!(element instanceof HTMLElement) || element.closest('[hidden]') !== null)
            return null;
          const r = element.getBoundingClientRect();
          return {
            left: r.left - box.left,
            top: r.top - box.top,
            right: box.right - r.right,
            bottom: box.bottom - r.bottom,
          };
        };
        /** What the view sends when it measures again (as at each list app.js renders). */
        const proposed = async (owns: boolean): Promise<number> => {
          const before = sent.length;
          view.show({ ...payload(size.cols, size.rows), ownsSize: owns });
          await tick();
          return sent.length - before;
        };
        const shown = { text: at('.xterm-screen') };
        view.notice(term, 'gap', 'part of the output was lost');
        await tick();
        const bar = { bars: at('.tv-bars'), bar: at('.tv-bar'), sent: await proposed(true) };
        view.size({ t: 'size', term, ...size, owner: false });
        await tick();
        const hint = { hint: at('.tv-hint'), sent: await proposed(false) };
        view.find();
        await tick();
        const find = { find: at('.tv-find'), sent: await proposed(false) };
        view.exit({
          t: 'exit',
          term,
          code: 0,
          signal: null,
          atNs: '1',
          lost: false,
          notStarted: null,
        });
        view.show(payload(size.cols, size.rows, 'ended'));
        await tick();
        const screen = root.querySelector('.tv-term.over .tv-screen');
        const ended = {
          screen: at('.tv-term.over .tv-screen'),
          opacity: screen === null ? null : getComputedStyle(screen).opacity,
          text: at('.tv-term.over .xterm-screen'),
        };
        root.remove();
        return { shown, bar, hint, find, ended, sent: sent.map((message) => message['t']) };
      }, base);
      const inset = (box: unknown): number[] => {
        const b = box as { left: number; top: number };
        return [b.left, b.top];
      };
      assert.deepEqual(inset(result.shown.text), [LEFT, TOP], 'the text, running');
      const bars = result.bar.bars as { left: number; top: number; right: number };
      assert.deepEqual(
        [bars.left, bars.top, bars.right],
        [0, 0, 16],
        'the bars: over the top, the scroll bar left free',
      );
      assert.deepEqual(inset(result.bar.bar), [0, 0], 'a bar at the top left');
      assert.deepEqual(
        [
          (result.hint.hint as { right: number }).right,
          (result.hint.hint as { bottom: number }).bottom,
        ],
        [20, 6],
        'the hint at the bottom right',
      );
      assert.deepEqual(
        [(result.find.find as { right: number }).right, (result.find.find as { top: number }).top],
        [22, 6],
        'the find bar at the top right',
      );
      assert.deepEqual(
        [result.bar.sent, result.hint.sent, result.find.sent],
        [0, 0, 0],
        'no size proposed',
      );
      assert.deepEqual(
        result.ended.screen,
        { left: 0, top: 0, right: 0, bottom: 0 },
        'the ended screen fills the box',
      );
      assert.equal(result.ended.opacity, '0.55', 'dimmed');
      assert.deepEqual(inset(result.ended.text), [LEFT, TOP], 'its text inset as before');
      assert.ok(!result.sent.includes('resize'), JSON.stringify(result.sent));
    },
  );
});
