// Copy on select (issue #184; S2 9.1, 9.5, 12.13): a selection the user ends with the mouse in the
// shown terminal is written to the clipboard at its release, as Ctrl+Shift+C writes it — a drag, a
// double and a triple click, a Shift+click that extends, a drag that scrolls, one released outside
// the terminal, a Shift+drag while the program has the mouse —, and nothing else writes it: not a
// click or output that clears a selection, not the search's match, not a terminal that is no longer
// shown, not a plain drag the program's mouse reporting takes, nothing at all while
// `window.copyOnSelect` is false (Ctrl+Shift+C still copies). The switch in Settings applies to the
// next selection of every window of the server, without a reload. A real test server whose
// terminals run the stand-in, and the page's real modules; the clipboard as the terminal's other
// copy tests read it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { browser } from './helpers/browser.ts';
import { PAGE_WAIT_MS, connection, launched, pageUrl, readPage } from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import {
  hexOf,
  inputOf,
  promptOf,
  resumeHere,
  screenText,
  shownTerm,
  until,
  untilScreen,
  untilTerminalOf,
} from './helpers/terminal.ts';

/** What the stand-in prints for `/red alpha bravo charlie`: the line the cases select in. */
const LINE = 'alpha bravo charlie';

/** How long a case waits before it says that nothing was written. */
const QUIET_MS = 600;

/** Grants the page's origin the clipboard (the page writes it; the test reads it). */
async function allowClipboard(page: Page, port: number): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: `http://127.0.0.1:${port}`,
  });
}

async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Puts `text` on the clipboard as another program would (not through the page's own writes). */
async function setClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => {
    const own = Reflect.get(globalThis, 'testWriteText') as
      ((text: string) => Promise<void>) | undefined;
    return (own ?? navigator.clipboard.writeText.bind(navigator.clipboard))(text);
  }, text);
}

/** From now on records every text the page writes to the clipboard, in order (`writes`). */
async function countWrites(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    Reflect.set(globalThis, 'testWriteText', write);
    const writes: string[] = [];
    Reflect.set(globalThis, 'testWrites', writes);
    navigator.clipboard.writeText = (text: string) => {
      writes.push(text);
      return write(text);
    };
  });
  return () => page.evaluate(() => [...(Reflect.get(globalThis, 'testWrites') as string[])]);
}

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** A point of the page. */
interface Point {
  x: number;
  y: number;
}

/**
 * Where `text` stands on the shown terminal's screen: the left and right edges of its last place,
 * and the middle of its row — in the last row that holds `row` exactly (trailing spaces cut), else
 * in the last row that holds `text`.
 */
async function spanOf(
  page: Page,
  text: string,
  row?: string,
): Promise<{ left: number; right: number; y: number }> {
  const found = await readPage(
    page,
    ({ text, row }) => {
      const box = document.querySelector('#terminal .tv-term:not([hidden])');
      const rows = [...(box?.querySelectorAll('.xterm-rows > div') ?? [])];
      for (const line of rows.reverse()) {
        const whole = (line.textContent ?? '').replaceAll(' ', ' ');
        if (row !== null ? whole.trimEnd() !== row : !whole.includes(text)) continue;
        const at = whole.lastIndexOf(text);
        if (at === -1) continue;
        // The row's text nodes in order, to find the node and offset of each end.
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          nodes.push(node as Text);
        }
        const place = (index: number, end: boolean): [Text, number] => {
          let passed = 0;
          for (const node of nodes) {
            const length = node.length;
            if (index < passed + length || (end && index === passed + length)) {
              return [node, index - passed];
            }
            passed += length;
          }
          const last = nodes[nodes.length - 1] as Text;
          return [last, last.length];
        };
        const range = document.createRange();
        range.setStart(...place(at, false));
        range.setEnd(...place(at + text.length, true));
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
      }
      return null;
    },
    { text, row: row ?? null },
  );
  assert.ok(found !== null, `${text} is on the screen`);
  return found;
}

/** The first and last character of `text` on the screen, as points a drag goes from and to. */
async function endsOf(page: Page, text: string, row?: string): Promise<[Point, Point]> {
  const span = await spanOf(page, text, row);
  return [
    { x: span.left + 2, y: span.y },
    { x: span.right - 2, y: span.y },
  ];
}

/** The shown terminal's box, in page coordinates. */
async function terminalBox(page: Page): Promise<{ left: number; top: number; bottom: number }> {
  return readPage(
    page,
    () => {
      const box = document
        .querySelector('#terminal .tv-term:not([hidden]) .xterm-screen')
        ?.getBoundingClientRect();
      return { left: box?.left ?? 0, top: box?.top ?? 0, bottom: box?.bottom ?? 0 };
    },
    null,
  );
}

/**
 * A drag with the primary button at a person's pace: pressed at `from`, moved in steps to `to`,
 * held there `hold` ms, released there; Shift held throughout when `shift`. `beforeRelease` runs
 * with the button still down.
 */
async function drag(
  page: Page,
  from: Point,
  to: Point,
  options: { shift?: boolean; hold?: number; beforeRelease?: () => Promise<void> } = {},
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  if (options.shift === true) await page.keyboard.down('Shift');
  await page.mouse.down();
  await sleep(100);
  for (const part of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(from.x + (to.x - from.x) * part, from.y + (to.y - from.y) * part);
    await sleep(50);
  }
  if (options.hold !== undefined) await sleep(options.hold);
  await options.beforeRelease?.();
  await page.mouse.up();
  if (options.shift === true) await page.keyboard.up('Shift');
}

/** A click with `clickCount` (2: the second of a double click, 3: of a triple one) at `at`. */
async function clickAt(page: Page, at: Point, clickCount = 1): Promise<void> {
  await page.mouse.move(at.x, at.y);
  for (let count = 1; count <= clickCount; count++) {
    await page.mouse.down({ clickCount: count });
    await page.mouse.up({ clickCount: count });
  }
}

/** A server with S1 resumed in the page's terminal, the line LINE on its screen; `others` are
 *  resumable sessions too. */
async function withLine(
  t: Parameters<typeof launched>[0],
  chromium: Parameters<typeof launched>[1],
  options: Parameters<typeof launched>[2] = {},
  others: string[] = [],
): Promise<{ l: Launched; term: string }> {
  const l = await launched(t, chromium, options);
  await allowClipboard(l.page, l.server.port);
  for (const sessionId of [S1, ...others]) l.d.resumable(sessionId);
  const term = await resumeHere(l.page, S1);
  await untilScreen(l.page, promptOf(S1));
  await typeLine(l.page, `/red ${LINE}`);
  await untilScreen(l.page, new RegExp(`^${LINE}$`, 'm'));
  return { l, term };
}

/** Waits QUIET_MS, then says the clipboard still holds `text`. */
async function stillHolds(page: Page, text: string, why: string): Promise<void> {
  await sleep(QUIET_MS);
  assert.equal(await clipboardText(page), text, why);
}

test('copy on select (issue #184)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'a drag copies its selection at the release, once, not at each move; Ctrl+C then still interrupts the program; a click, output and a resize that clear it leave the clipboard as it was',
    async (t) => {
      const { l, term } = await withLine(t, chromium);
      const { page, d } = l;
      const writes = await countWrites(page);
      await setClipboard(page, 'before');
      const [from, to] = await endsOf(page, 'bravo', LINE);
      await drag(page, from, to, {
        beforeRelease: async () => {
          assert.deepEqual(await writes(), [], 'nothing while the button is down');
        },
      });
      await until(async () => (await clipboardText(page)) === 'bravo', 'the drag copied');
      await sleep(300);
      assert.deepEqual(await writes(), ['bravo'], 'one write, at the release');

      // A click that clears a selection writes nothing: the text the user copied elsewhere stays.
      await drag(page, from, to);
      await until(async () => (await writes()).length === 2, 'selected again');
      await setClipboard(page, 'copied elsewhere');
      await clickAt(page, (await endsOf(page, 'charlie', LINE))[0]);
      await stillHolds(page, 'copied elsewhere', 'a click that clears the selection');

      // Output, and a resize that clears a selection, write nothing either.
      await drag(page, from, to);
      await until(async () => (await writes()).length === 3, 'selected once more');
      await setClipboard(page, 'copied elsewhere');
      l.server.hub.input(term, Buffer.from('/lines 3\r'));
      await untilScreen(page, /^line 3$/m);
      await page.setViewportSize({ width: 1100, height: 600 });
      await stillHolds(page, 'copied elsewhere', 'output and a resize');
      assert.deepEqual(await writes(), ['bravo', 'bravo', 'bravo']);

      // Ctrl+C with text selected still reaches the program as an interrupt, and copies nothing.
      const [again, till] = await endsOf(page, 'bravo', LINE);
      await drag(page, again, till);
      await until(async () => (await clipboardText(page)) === 'bravo', 'selected after the resize');
      await setClipboard(page, 'copied elsewhere');
      const before = inputOf(d.record, S1).length;
      await page.keyboard.press('Control+C');
      await until(() => inputOf(d.record, S1).slice(before).includes('03'), 'the interrupt');
      await stillHolds(page, 'copied elsewhere', 'Ctrl+C copies nothing');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a double click copies the word, a triple click the line, a Shift+click the text from the last click to it',
    async (t) => {
      const { l } = await withLine(t, chromium);
      const { page } = l;
      await setClipboard(page, 'before');
      const [charlie] = await endsOf(page, 'charlie', LINE);
      await clickAt(page, charlie, 2);
      await until(async () => (await clipboardText(page)) === 'charlie', 'the word');
      const [bravo] = await endsOf(page, 'bravo', LINE);
      await clickAt(page, bravo, 3);
      await until(async () => (await clipboardText(page)) === LINE, 'the line');

      await setClipboard(page, 'before');
      const [start] = await endsOf(page, 'alpha', LINE);
      await clickAt(page, start);
      await stillHolds(page, 'before', 'a plain click selects nothing');
      const [, end] = await endsOf(page, 'charlie', LINE);
      await page.mouse.move(end.x, end.y);
      await page.keyboard.down('Shift');
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await until(
        async () => (await clipboardText(page)) === LINE,
        'from the click to the Shift+click',
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a drag released outside the terminal copies; one that scrolls the scrollback copies every line it reached',
    async (t) => {
      const { l, term } = await withLine(t, chromium);
      const { page } = l;
      await setClipboard(page, 'before');
      const [, end] = await endsOf(page, 'charlie', LINE);
      const box = await terminalBox(page);
      const outside = { x: box.left - 60, y: end.y };
      assert.equal(
        await readPage(
          page,
          ({ x, y }) =>
            document.getElementById('terminal')?.contains(document.elementFromPoint(x, y)),
          outside,
        ),
        false,
        'the release is outside the terminal',
      );
      await drag(page, end, outside);
      await until(async () => (await clipboardText(page)) === LINE, 'released over the list');

      // A press elsewhere before the release (after a release the page never heard, the window
      // having lost the mouse) means the release ends no selection of the terminal's.
      await setClipboard(page, 'copied elsewhere');
      const [from, to] = await endsOf(page, 'bravo', LINE);
      await drag(page, from, to, {
        beforeRelease: () =>
          page.evaluate(() => {
            document
              .getElementById('list')
              ?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
          }),
      });
      await stillHolds(page, 'copied elsewhere', 'the release of another press');

      l.server.hub.input(term, Buffer.from('/lines 300\r'));
      await untilScreen(page, /^line 300$/m);
      await untilScreen(page, promptOf(S1));
      const top = Number(/^line (\d+)$/m.exec(await screenText(page))?.[1]);
      assert.ok(top > 100, `the screen starts at line ${top}`);
      const [, last] = await endsOf(page, `line ${top}`, `line ${top}`);
      const above = { x: last.x, y: box.top - 30 };
      await drag(page, last, above, { hold: 800 });
      await until(
        async () => (await clipboardText(page)).split(/\r?\n/).length > 5,
        'the lines the drag scrolled to',
      );
      const lines = (await clipboardText(page)).split(/\r?\n/);
      const first = Number(/^line (\d+)$/.exec(lines[0] ?? '')?.[1]);
      assert.ok(first < top - 3, `from line ${first}, above line ${top} where it was pressed`);
      assert.deepEqual(
        lines,
        Array.from({ length: top - first + 1 }, (_, at) => `line ${first + at}`),
        'every line from there to the press',
      );
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "the search's match is a selection that copies nothing (Ctrl+Shift+C still copies it); a selection whose terminal is no longer shown at the release copies nothing",
    async (t) => {
      const { l } = await withLine(t, chromium, {}, [S2]);
      const { page } = l;
      await setClipboard(page, 'before');
      await page.keyboard.press('Control+Shift+F');
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('tv-find-input') === true,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      await page.keyboard.type('bravo');
      await page.keyboard.press('Enter');
      await until(
        async () =>
          / of /.test(
            await readPage(
              page,
              () => document.querySelector('.tv-find-count')?.textContent ?? '',
              null,
            ),
          ),
        'a match',
      );
      await stillHolds(page, 'before', "the search's match");
      await page.keyboard.press('Control+Shift+C');
      await until(async () => (await clipboardText(page)) === 'bravo', 'it was selected');
      await page.keyboard.press('Escape');
      await untilTerminalOf(page, S1);

      // A second terminal; S1 shown again, with S2 the previous one.
      const term2 = await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      await page.keyboard.press('Control+Shift+O');
      await untilTerminalOf(page, S1);
      await untilScreen(page, new RegExp(`^${LINE}$`, 'm'));
      await setClipboard(page, 'before');
      const [from, to] = await endsOf(page, 'bravo', LINE);
      await drag(page, from, to, {
        beforeRelease: async () => {
          await page.keyboard.press('Control+Shift+O');
          await until(async () => (await shownTerm(page)) === term2, 'S2 shown, the button down');
        },
      });
      await stillHolds(page, 'before', 'the terminal of the press is no longer shown');
      // Shown again, a selection ended in it copies.
      await page.keyboard.press('Control+Shift+O');
      await untilTerminalOf(page, S1);
      await drag(page, from, to);
      await until(async () => (await clipboardText(page)) === 'bravo', 'shown, it copies');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    "while the program has turned mouse reporting on, a plain drag is the program's and copies nothing; a Shift+drag selects and copies",
    async (t) => {
      const { l, term } = await withLine(t, chromium);
      const { page, d } = l;
      await typeLine(page, '/mouse');
      await page.waitForSelector('#terminal .tv-term:not([hidden]) .xterm.enable-mouse-events', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await setClipboard(page, 'before');
      const before = inputOf(d.record, S1).length;
      const [from, to] = await endsOf(page, 'bravo', LINE);
      await drag(page, from, to);
      // SGR reports (mode 1006): the press ESC [ < 0 ; x ; y M and the release … m.
      await until(
        () => inputOf(d.record, S1).slice(before).includes(hexOf('\x1b[<0;')),
        'the program got the press',
      );
      await stillHolds(page, 'before', "a plain drag is the program's");
      await drag(page, from, to, { shift: true });
      await until(async () => (await clipboardText(page)) === 'bravo', 'the Shift+drag copied');
      // With xterm.js's default encoding (mode 1006 off) a report is no input of the user's, which
      // would clear the selection: the program's next plain drag leaves that selection standing,
      // and it is not copied a second time.
      // (The first Enter ends the line the reports so far went into.)
      l.server.hub.input(term, Buffer.from('\r/red \x1b[?1006ldefault encoding\r'));
      await untilScreen(page, /^default encoding$/m);
      await setClipboard(page, 'copied elsewhere');
      const reports = inputOf(d.record, S1).length;
      const [charlie, end] = await endsOf(page, 'charlie', LINE);
      await drag(page, charlie, end);
      await until(
        () => inputOf(d.record, S1).slice(reports).includes(hexOf('\x1b[M')),
        'the program got that press, in the default encoding',
      );
      await stillHolds(page, 'copied elsewhere', "the program's drag copies no earlier selection");
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'with window.copyOnSelect false nothing a selection does writes the clipboard, and Ctrl+Shift+C still copies',
    async (t) => {
      const { l } = await withLine(t, chromium, { window: { copyOnSelect: false } });
      const { page } = l;
      const writes = await countWrites(page);
      await setClipboard(page, 'before');
      const [from, to] = await endsOf(page, 'bravo', LINE);
      await drag(page, from, to);
      await clickAt(page, (await endsOf(page, 'charlie', LINE))[0], 2);
      await stillHolds(page, 'before', 'off: no copy');
      assert.deepEqual(await writes(), []);
      await page.keyboard.press('Control+Shift+C');
      await until(async () => (await clipboardText(page)) === 'charlie', 'Ctrl+Shift+C copies');
      assert.deepEqual(await writes(), ['charlie']);
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'Copy on select switched in Settings applies to the next selection, without a reload, in a second window of the same server too',
    async (t) => {
      const { l } = await withLine(t, chromium);
      // Each window opened from now on notes the value of every list it receives.
      await l.page.context().addInitScript(() => {
        const Native = window.WebSocket;
        window.WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener('message', (message) => {
              if (typeof message.data !== 'string') return;
              const parsed = JSON.parse(message.data) as { t?: string; copyOnSelect?: boolean };
              if (parsed.t === 'list')
                Reflect.set(globalThis, 'testCopyOnSelect', parsed.copyOnSelect);
            });
          }
        };
      });
      const windows: Page[] = [];
      for (let i = 0; i < 2; i++) {
        const page = await l.page.context().newPage();
        await page.goto(pageUrl(l.server.port));
        await connection(page, 'open');
        await untilTerminalOf(page, S1);
        await untilScreen(page, new RegExp(`^${LINE}$`, 'm'));
        await page.evaluate(() => Reflect.set(globalThis, 'testLoaded', true));
        windows.push(page);
      }
      const [one, two] = windows as [Page, Page];
      const seen = (page: Page): Promise<unknown> =>
        page.evaluate(() => Reflect.get(globalThis, 'testCopyOnSelect'));
      /** A drag over `bravo` in `page`, with `before` on the clipboard first. */
      const select = async (page: Page): Promise<void> => {
        await page.bringToFront();
        await setClipboard(page, 'before');
        const [from, to] = await endsOf(page, 'bravo', LINE);
        await drag(page, from, to);
      };
      const flip = async (to: boolean): Promise<void> => {
        await one.bringToFront();
        await one.locator('#settings-button').click();
        const control = one.locator(
          '#settings .short-setting[data-key="window.copyOnSelect"] input',
        );
        await control.waitFor({ state: 'visible' });
        assert.equal(await control.isChecked(), !to);
        await control.click();
        await until(
          async () =>
            (await one
              .locator('#settings .short-setting[data-key="window.copyOnSelect"] .short-message')
              .textContent()) === 'Saved.',
          'saved',
        );
        await one.keyboard.press('Escape');
        for (const page of windows) {
          await until(async () => (await seen(page)) === to, `the window's next list says ${to}`);
        }
      };
      assert.equal(await seen(one), true);
      await flip(false);
      for (const page of windows) {
        await select(page);
        await stillHolds(page, 'before', 'switched off');
      }
      await flip(true);
      for (const page of windows) {
        await select(page);
        await until(async () => (await clipboardText(page)) === 'bravo', 'switched on again');
      }
      for (const page of [one, two]) {
        assert.equal(
          await page.evaluate(() => Reflect.get(globalThis, 'testLoaded')),
          true,
          'not reloaded',
        );
      }
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );
});
