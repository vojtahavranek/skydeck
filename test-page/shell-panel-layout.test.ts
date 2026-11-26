// A session's shell on the page (issue #199, S2 12.6, 12.9): the split of the terminal area between
// the session's terminal and its shell's panel (web/shell-panel.js, web/shell-panel-split.js), with
// real keys and a real mouse against a real test server whose shell is the stand-in shell: the
// default third, both programs told their sizes when the panel shows, hides and is dragged, the
// remembered height (after a reload, for another session), the least heights, the double click,
// the window too low for both, and the bar that takes no keyboard and does nothing under a dialog.
//
// Every size a program is told is compared with what the page's own terminal view computes for the
// box it is shown in (`fitsOf`: the view's `fits` for that box, the rule of its every proposal),
// never with a constant, and each is waited for: nothing here depends on the machine's load.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { S1, S2 } from '../test/helpers/platform.ts';
import { SHELL_PROMPT } from '../test/helpers/shell-standin.ts';
import { BAR_PX, BAR_TITLE, MIN_ROWS, SHELL_HEIGHT_KEY } from '../web/shell-panel-split.js';
import { browser, newPage } from './helpers/browser.ts';
import { startTestServer } from '../test/helpers/window.ts';
import {
  assetBase,
  clickRow,
  connection,
  launched,
  pageUrl,
  readPage,
  shownText,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import {
  inputOf,
  promptOf,
  recordsOf,
  resumeHere,
  untilScreen,
  until,
} from './helpers/terminal.ts';

type Size = { cols: number; rows: number };

/**
 * What the page's own terminal view computes for the box of `selector` (`#terminal`, `#shell`):
 * the `fits` of a view of the page's module, made once in a box of its own out of sight.
 */
async function fitsOf(page: Page, selector: string): Promise<Size | null> {
  const base = await assetBase(page);
  return page.evaluate(
    async ({ base, selector }) => {
      type Probe = { fits(width: number, height: number): Size | null };
      let probe = Reflect.get(globalThis, 'testProbe') as Probe | undefined;
      if (probe === undefined) {
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(root: HTMLElement, deps: object): Probe;
        };
        const root = document.createElement('div');
        root.style.cssText = 'position:fixed;left:-5000px;top:0;width:100px;height:100px';
        document.body.append(root);
        probe = module.createTerminalView(root, {
          send: () => {},
          chord: () => false,
          openLink: () => {},
        });
        Reflect.set(globalThis, 'testProbe', probe);
      }
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box === undefined || box.height <= 0 ? null : probe.fits(box.width, box.height);
    },
    { base, selector },
  );
}

/** The layout as the page has it now. */
async function layout(page: Page): Promise<{
  mode: string | null;
  area: number;
  shell: number;
  terminal: number;
  bar: number;
  terminalShown: boolean;
  barShown: boolean;
  stored: string | null;
}> {
  return readPage(
    page,
    (key) => {
      const zone = document.getElementById('right-zone') as HTMLElement;
      const style = getComputedStyle(zone);
      const cards = (document.getElementById('cards') as HTMLElement).getBoundingClientRect();
      const height = (id: string): number =>
        (document.getElementById(id) as HTMLElement).getBoundingClientRect().height;
      const shown = (id: string): boolean =>
        (document.getElementById(id) as HTMLElement).checkVisibility();
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(key);
      } catch {
        stored = null;
      }
      return {
        mode: zone.dataset['shell'] ?? null,
        area:
          zone.getBoundingClientRect().height -
          (parseFloat(style.borderTopWidth) || 0) -
          (parseFloat(style.borderBottomWidth) || 0) -
          cards.height,
        shell: height('shell'),
        terminal: height('terminal'),
        bar: height('shell-bar'),
        terminalShown: shown('terminal'),
        barShown: shown('shell-bar'),
        stored,
      };
    },
    SHELL_HEIGHT_KEY,
  );
}

/** Where the keyboard is: in the shell's panel, the session's terminal, the list, or elsewhere. */
async function keyboard(page: Page): Promise<'shell' | 'terminal' | 'list' | 'other'> {
  return readPage(
    page,
    () => {
      const at = document.activeElement;
      if (document.getElementById('shell')?.contains(at) === true) return 'shell';
      if (document.getElementById('terminal')?.contains(at) === true) return 'terminal';
      if (document.getElementById('list-zone')?.contains(at) === true) return 'list';
      return 'other';
    },
    null,
  );
}

async function untilKeyboard(page: Page, where: string): Promise<void> {
  await until(async () => (await keyboard(page)) === where, `the keyboard in the ${where}`);
}

async function untilPanel(page: Page, shown: boolean): Promise<void> {
  await until(
    () =>
      readPage(
        page,
        () => {
          const shell = document.getElementById('shell') as HTMLElement;
          return !shell.hidden && shell.getBoundingClientRect().height > 0;
        },
        null,
      ).then((now) => now === shown),
    `the panel ${shown ? 'shown' : 'hidden'}`,
  );
}

interface InWindowOptions {
  viewport?: { width: number; height: number };
  /** Init scripts for the page, in force from a reload before S1 is resumed. */
  init?: string[];
  /** A value of the shell's height in the page's localStorage before that reload. */
  stored?: string;
}

/** S1 resumed into the window's terminal and reported there (S2 resumable too). */
async function inWindow(
  t: TestContext,
  chromium: Browser,
  options: InWindowOptions = {},
): Promise<Launched & { term: string }> {
  const l = await launched(t, chromium);
  if (options.viewport !== undefined) await l.page.setViewportSize(options.viewport);
  if (options.stored !== undefined) {
    await l.page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: SHELL_HEIGHT_KEY,
      value: options.stored,
    });
  }
  if (options.init !== undefined || options.stored !== undefined) {
    for (const script of options.init ?? []) await l.page.addInitScript(script);
    await l.page.reload();
    await connection(l.page, 'open');
  }
  l.d.resumable(S1);
  l.d.resumable(S2);
  const term = await resumeHere(l.page, S1);
  await untilScreen(l.page, promptOf(S1));
  await until(
    () =>
      l.server.hub
        .list()
        .some((one) => one.id === term && one.sessionId === S1 && one.program !== null),
    'S1 reported in its terminal',
  );
  return { ...l, term };
}

/** The shell opened by the key (the keyboard where the key was pressed) and shown, with its prompt. */
async function openShell(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+S');
  await untilPanel(page, true);
  await untilKeyboard(page, 'shell');
  await untilScreen(page, new RegExp(SHELL_PROMPT.trimEnd()), undefined, '#shell');
}

/** S1 resumed into the window's terminal and reported there, its shell open with the keyboard. */
async function withShell(
  t: TestContext,
  chromium: Browser,
  viewport?: { width: number; height: number },
  options: Omit<InWindowOptions, 'viewport'> = {},
): Promise<Launched & { term: string }> {
  const l = await inWindow(t, chromium, {
    ...options,
    ...(viewport === undefined ? {} : { viewport }),
  });
  await openShell(l.page);
  return l;
}

/** An init script that keeps every JSON message the page sends in `globalThis.testSent`. */
const KEEP_SENT = `(() => {
  const sent = [];
  globalThis.testSent = sent;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message.t !== 'ping') sent.push(message);
      } catch {}
    }
    return send.call(this, data);
  };
})();`;

type Sent = Record<string, unknown> & { t: string };

/** What the page sent so far (KEEP_SENT). */
async function sentOf(page: Page): Promise<Sent[]> {
  return page.evaluate(() => [...(Reflect.get(globalThis, 'testSent') as Sent[])]);
}

const sizeOf = (message: Sent | undefined): Size | null =>
  message === undefined
    ? null
    : { cols: message['cols'] as number, rows: message['rows'] as number };

/** Keeps every WebSocket the page makes in `globalThis.testSockets` (an init script). */
const KEEP_SOCKETS = `(() => {
  const Native = window.WebSocket;
  const kept = [];
  globalThis.testSockets = kept;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      kept.push(this);
    }
  };
})();`;

/** The window's height that leaves the terminal area `under` px under twice least and the bar. */
async function lowHeight(page: Page, height: number, under: number): Promise<number> {
  const least = await leastOf(page);
  const now = await layout(page);
  return Math.floor(height - (now.area - (2 * least + BAR_PX - under)));
}

/** What the page's own view computes for the whole terminal area (the zone less the cards). */
async function fitsOfArea(page: Page): Promise<Size | null> {
  const base = await assetBase(page);
  return page.evaluate(async (base) => {
    type Probe = { fits(width: number, height: number): Size | null };
    let probe = Reflect.get(globalThis, 'testProbe') as Probe | undefined;
    if (probe === undefined) {
      const module = (await import(`${base}terminal-view.js`)) as {
        createTerminalView(root: HTMLElement, deps: object): Probe;
      };
      const root = document.createElement('div');
      root.style.cssText = 'position:fixed;left:-5000px;top:0;width:100px;height:100px';
      document.body.append(root);
      probe = module.createTerminalView(root, {
        send: () => {},
        chord: () => false,
        openLink: () => {},
      });
      Reflect.set(globalThis, 'testProbe', probe);
    }
    const zone = document.getElementById('right-zone') as HTMLElement;
    const style = getComputedStyle(zone);
    const px = (name: string): number => parseFloat(style.getPropertyValue(name)) || 0;
    const box = zone.getBoundingClientRect();
    const cards = (document.getElementById('cards') as HTMLElement).getBoundingClientRect().height;
    return probe.fits(
      box.width - px('border-left-width') - px('border-right-width'),
      box.height - px('border-top-width') - px('border-bottom-width') - cards,
    );
  }, base);
}

/** The size the session's stand-in program was told last (its start's or a resize's). */
function toldLast(l: Launched, sessionId: string): Size | null {
  const told = recordsOf(l.d.record, sessionId).flatMap((one) =>
    (one.ev === 'start' && one.cols !== null) || one.ev === 'resize'
      ? [{ cols: one.cols as number, rows: one.rows as number }]
      : [],
  );
  return told.at(-1) ?? null;
}

const same = (a: Size | null | undefined, b: Size | null | undefined): boolean =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  a.cols === b.cols &&
  a.rows === b.rows;

/** The server's size of the session terminal `term` and of the one shell. */
function serverSizes(l: Launched, term: string): { session: Size | null; shell: Size | null } {
  const session = l.server.hub.list().find((one) => one.id === term) ?? null;
  const [shell] = l.server.hub.shells?.() ?? [];
  return {
    session: session === null ? null : { cols: session.cols, rows: session.rows },
    shell: shell === undefined ? null : { cols: shell.cols, rows: shell.rows },
  };
}

/**
 * Waits until the session's program (and the server's list of it) has the size the page's view
 * computes for `#terminal`'s box, and, while `shell`, the shell has what it computes for `#shell`'s.
 */
async function untilToldBoxes(
  l: Launched & { term: string },
  sessionId: string,
  term: string,
  shell: boolean,
): Promise<{ session: Size; shell: Size | null }> {
  let last = '';
  for (const deadline = performance.now() + 20_000; ;) {
    const session = await fitsOf(l.page, '#terminal');
    const panel = shell ? await fitsOf(l.page, '#shell') : null;
    const server = serverSizes(l, term);
    const told = toldLast(l, sessionId);
    if (
      session !== null &&
      same(told, session) &&
      same(server.session, session) &&
      (!shell || same(server.shell, panel))
    ) {
      return { session, shell: panel };
    }
    last = JSON.stringify({ session, panel, server, told });
    assert.ok(performance.now() < deadline, `the programs told the boxes' sizes: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The bar's middle, in the page's px. */
async function barAt(page: Page): Promise<{ x: number; y: number }> {
  await page.locator('#shell-bar').waitFor({ state: 'visible', timeout: 20_000 });
  const box = await page.locator('#shell-bar').boundingBox();
  assert.ok(box !== null, 'the bar is laid out');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A drag of the bar by `dy` px (negative: up), with the real mouse, in small steps. */
async function dragBar(page: Page, dy: number): Promise<void> {
  const at = await barAt(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y + dy, { steps: 12 });
  await page.mouse.up();
}

const near = (a: number, b: number, what: string): void =>
  assert.ok(Math.abs(a - b) <= 1, `${what}: ${a} is not ${b} (± 1 px)`);

/** The px of MIN_ROWS rows as the shells' view computes them (its `heightFor`, via the bounds). */
async function leastOf(page: Page): Promise<number> {
  const base = await assetBase(page);
  return page.evaluate(
    async ({ base, rows }) => {
      const module = (await import(`${base}terminal-view.js`)) as {
        createTerminalView(
          root: HTMLElement,
          deps: object,
        ): {
          heightFor(rows: number): number | null;
        };
      };
      const root = document.createElement('div');
      root.style.cssText = 'position:fixed;left:-5000px;top:0;width:100px;height:100px';
      document.body.append(root);
      const view = module.createTerminalView(root, {
        send: () => {},
        chord: () => false,
        openLink: () => {},
      });
      return view.heightFor(rows) ?? Number.NaN;
    },
    { base, rows: MIN_ROWS },
  );
}

test('issue #199: the split of the terminal area between a session and its shell', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "A8: opened without a stored height the panel is a third of the area; the session's program is told fewer rows when it shows and its rows back when it hides; the shell's size is what its box holds, and `stty size` says it",
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      const term = await resumeHere(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      await until(
        () =>
          l.server.hub
            .list()
            .some((one) => one.id === term && one.sessionId === S1 && one.program !== null),
        'S1 reported',
      );
      const { session: whole } = await untilToldBoxes({ ...l, term }, S1, term, false);
      const { page } = l;

      await openShell(page); // the stand-in's prompt there before anything is typed

      const split = await layout(page);
      assert.equal(split.mode, 'split');
      assert.equal(split.stored, null);
      near(split.shell, Math.round(split.area / 3), 'a third of the terminal area');
      near(split.bar, BAR_PX, 'the bar');
      near(split.terminal + split.bar + split.shell, split.area, 'the three fill the area');
      const told = await untilToldBoxes({ ...l, term }, S1, term, true);
      assert.ok(told.session.rows < whole.rows, 'the session got lower');
      assert.equal(told.session.cols, whole.cols, 'and kept its width');
      assert.ok(told.shell !== null);
      await page.keyboard.type('echo "size=$(stty size)"');
      await page.keyboard.press('Enter');
      await untilScreen(
        page,
        new RegExp(`^size=${told.shell.rows} ${told.shell.cols}$`, 'm'),
        undefined,
        '#shell',
      );
      assert.equal(await page.locator('#shell-bar').getAttribute('title'), BAR_TITLE);

      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, false);
      assert.equal((await layout(page)).mode, null, 'not drawn: the zone as before');
      const back = await untilToldBoxes({ ...l, term }, S1, term, false);
      assert.deepEqual(back, { session: whole, shell: null }, 'its full height back');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'A8: a drag of the bar up by 120 px: the panel 120 px higher, both programs told, the height kept; after a reload the shown panel has it, and so has a second session’s panel',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page, term } = l;
      const before = await untilToldBoxes(l, S1, term, true);
      const start = await layout(page);

      await dragBar(page, -120);

      const dragged = await layout(page);
      near(dragged.shell, start.shell + 120, 'the panel 120 px higher');
      assert.equal(dragged.stored, String(Math.round(dragged.shell)), 'kept in localStorage');
      const told = await untilToldBoxes(l, S1, term, true);
      assert.ok(told.session.rows < before.session.rows, 'the session lower');
      assert.ok(
        told.shell !== null && before.shell !== null && told.shell.rows > before.shell.rows,
      );
      assert.equal(await keyboard(page), 'shell', 'the drag moved no keyboard');

      await page.reload();
      await connection(page, 'open');
      await toZone(page, 'terminal');
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      near((await layout(page)).shell, dragged.shell, 'after a reload');

      await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      await until(
        () => l.server.hub.list().some((one) => one.sessionId === S2 && one.program !== null),
        'S2 reported',
      );
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');
      near((await layout(page)).shell, dragged.shell, "a second session's panel");
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'A8: a drag past a bound stops at 4 rows of either; a double click gives the third back and removes the stored value',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page, term } = l;
      const least = await leastOf(page);
      assert.ok(least > 0, 'a cell is measured');

      await dragBar(page, -2000);
      let now = await layout(page);
      near(now.terminal, least, "the session's terminal keeps 4 rows' height");
      let told = await untilToldBoxes(l, S1, term, true);
      assert.equal(told.session.rows, MIN_ROWS, 'the session told 4 rows');

      await dragBar(page, 2000);
      now = await layout(page);
      near(now.shell, least, "the shell keeps 4 rows' height");
      told = await untilToldBoxes(l, S1, term, true);
      assert.equal(told.shell?.rows, MIN_ROWS, 'the shell told 4 rows');
      assert.equal(now.stored, String(Math.round(now.shell)));

      const at = await barAt(page);
      await page.mouse.dblclick(at.x, at.y);
      await until(async () => (await layout(page)).stored === null, 'the stored value removed');
      now = await layout(page);
      near(now.shell, Math.round(now.area / 3), 'a third again');
      await untilToldBoxes(l, S1, term, true);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'A8: a window too low for both: the shell over the whole terminal area with no bar and no session terminal, whose program is told nothing; higher again shows both',
    async (t) => {
      const l = await withShell(t, chromium, { width: 1100, height: 700 }, { init: [KEEP_SENT] });
      const { page, term } = l;
      const split = await layout(page);
      assert.equal(split.mode, 'split');
      await untilToldBoxes(l, S1, term, true);
      const toldBefore = toldLast(l, S1);
      const sentBefore = (await sentOf(page)).length;

      await page.setViewportSize({ width: 1100, height: await lowHeight(page, 700, 10) });

      await until(async () => (await layout(page)).mode === 'full', 'the shell over the area');
      const full = await layout(page);
      assert.equal(full.terminalShown, false, "the session's terminal not laid out");
      assert.equal(full.barShown, false, 'no bar');
      near(full.shell, full.area, 'the whole terminal area');
      await until(async () => (await keyboard(page)) === 'shell', 'the keyboard in the shell');
      const shellFits = await fitsOf(page, '#shell');
      await until(() => same(serverSizes(l, term).shell, shellFits), 'the shell told its size');
      // Its echo back from the shell comes after every refit the change set off.
      await page.keyboard.type('echo "low-$((2 + 3))"');
      await page.keyboard.press('Enter');
      await untilScreen(page, /^low-5$/m, undefined, '#shell');
      assert.deepEqual(
        (await sentOf(page))
          .slice(sentBefore)
          .filter((one) => one.t === 'resize' && one['term'] === term),
        [],
        "the page proposed no size for the session's terminal it does not lay out",
      );
      assert.deepEqual(toldLast(l, S1), toldBefore, "the session's program was told nothing");

      await page.setViewportSize({ width: 1100, height: 700 });

      await until(async () => (await layout(page)).mode === 'split', 'both again');
      const again = await layout(page);
      assert.equal(again.terminalShown && again.barShown, true);
      near(again.shell, Math.round(again.area / 3), 'a third again');
      await untilToldBoxes(l, S1, term, true);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the bar takes no keyboard: after a press on it the keyboard is where it was (the shell, the session, the list); while a dialog is shown it does nothing',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      const press = async (): Promise<void> => {
        const at = await barAt(page);
        await page.mouse.click(at.x, at.y);
        await new Promise((resolve) => setTimeout(resolve, 200));
      };
      await press();
      assert.equal(await keyboard(page), 'shell');
      await page.locator('#terminal .tv-term:not([hidden]) .xterm-screen').click();
      await untilKeyboard(page, 'terminal');
      await press();
      assert.equal(await keyboard(page), 'terminal');
      await toZone(page, 'list');
      await press();
      assert.equal(await keyboard(page), 'list');
      assert.equal(await page.locator('#shell-bar').getAttribute('tabindex'), null);

      // A dialog: the dialog "Mark done" (`d` once the window can end S1), with a height stored
      // first, which a double click would remove, and then a plain click (no drag: the double
      // click's own rule about a drag would hold nothing back).
      await dragBar(page, -60);
      await until(async () => (await layout(page)).stored !== null, 'a height stored');
      await press();
      await page.waitForSelector('#cards .header-restart', { state: 'visible', timeout: 20_000 });
      await clickRow(page, S1);
      await toZone(page, 'list');
      const before = await layout(page);
      await page.keyboard.press('d');
      await page.waitForSelector('#end-dialog:not([hidden])', { state: 'attached' });
      const unchanged = async (how: string): Promise<void> => {
        const now = await layout(page);
        assert.deepEqual([now.shell, now.stored], [before.shell, before.stored], how);
      };
      await dragBar(page, -120); // the dialog's scrim lies over it
      await unchanged('a drag by the mouse, on the scrim');
      const at = await barAt(page);
      /** The bar's own events, past the scrim (the mouse's pointer, id 1). */
      const dispatch = (types: string[], dy: number): Promise<void> =>
        page.evaluate(
          ({ types, x, y }) => {
            const bar = document.getElementById('shell-bar') as HTMLElement;
            for (const type of types) {
              bar.dispatchEvent(
                type === 'dblclick'
                  ? new MouseEvent('dblclick', { bubbles: true, detail: 2 })
                  : new PointerEvent(type, {
                      bubbles: true,
                      button: 0,
                      pointerId: 1,
                      clientX: x,
                      clientY: y,
                    }),
              );
            }
          },
          { types, x: at.x, y: at.y + dy },
        );
      await dispatch(['dblclick'], 0);
      await unchanged('a double click');
      await dispatch(['pointerdown'], 0);
      await unchanged('a press');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#end-dialog[hidden]', { state: 'attached' });
      // The press under the dialog armed nothing: a move and a release after it move nothing.
      await dispatch(['pointermove'], -120);
      await dispatch(['pointerup'], -120);
      await unchanged('a move after a press made under the dialog');
      assert.deepEqual(l.problems, []);
    },
  );
});

test('issue #199: the keyboard when the area gets too low and high again, the sizes the page sends, and the bar’s rules', async (t) => {
  const chromium = await browser(t);
  const VIEW = { width: 1100, height: 700 };

  /** The window made too low for both (10 px under the rule), and the split's `full` laid out. */
  const goLow = async (page: Page): Promise<void> => {
    await page.setViewportSize({
      width: VIEW.width,
      height: await lowHeight(page, VIEW.height, 10),
    });
    await until(
      async () => (await layout(page)).mode === 'full',
      'too low: the shell over the area',
    );
  };
  const goHigh = async (page: Page): Promise<void> => {
    await page.setViewportSize(VIEW);
    await until(async () => (await layout(page)).mode === 'split', 'high again: both');
  };
  const clickSession = (page: Page): Promise<void> =>
    page.locator('#terminal .tv-term:not([hidden]) .xterm-screen').click();

  await t.test(
    "the keyboard in the session's terminal when the area gets too low goes to the shell, and back to the session's terminal when it is high again",
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      await clickSession(page);
      await untilKeyboard(page, 'terminal');

      await goLow(page);
      await untilKeyboard(page, 'shell');
      await goHigh(page);
      await untilKeyboard(page, 'terminal');
      assert.equal(await shownText(page, '#focus-zone'), 'Focus: terminal');

      // And again: the rule holds at every change, not once.
      await goLow(page);
      await untilKeyboard(page, 'shell');
      await goHigh(page);
      await untilKeyboard(page, 'terminal');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a key typed into the shell while the area is too low keeps the keyboard in the shell when it is high again; one in the shell before stays there both ways',
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      await clickSession(page);
      await untilKeyboard(page, 'terminal');
      await goLow(page);
      await untilKeyboard(page, 'shell');
      await page.keyboard.type('echo typed-while-low');
      await page.keyboard.press('Enter');
      await untilScreen(page, /^typed-while-low$/m, undefined, '#shell');

      await goHigh(page);
      assert.equal(await keyboard(page), 'shell', 'the keyboard is the user’s now: it stays');

      await goLow(page);
      assert.equal(await keyboard(page), 'shell');
      await goHigh(page);
      assert.equal(await keyboard(page), 'shell', 'it was in the shell: it stays there');
      assert.deepEqual(l.problems, []);
    },
  );

  for (const [how, toList] of [
    [
      'a click on the list below its rows',
      async (page: Page): Promise<void> => {
        const list = await page.locator('#list').boundingBox();
        assert.ok(list !== null);
        await page.mouse.click(list.x + list.width / 2, list.y + list.height - 10);
      },
    ],
    ['Ctrl+Shift+L', (page: Page) => page.keyboard.press('Control+Shift+L')],
  ] as const) {
    await t.test(
      `the keyboard the change took to the shell, moved by the user to the list while the area is too low (${how}), stays in the list when it is high again`,
      async (t) => {
        const l = await withShell(t, chromium, VIEW);
        const { page } = l;
        await clickSession(page);
        await untilKeyboard(page, 'terminal');
        await goLow(page);
        await untilKeyboard(page, 'shell');

        await toList(page);
        await untilKeyboard(page, 'list');

        await goHigh(page);
        assert.equal(await keyboard(page), 'list', 'it stays where the user put it');
        assert.equal(await shownText(page, '#focus-zone'), 'Focus: list');
        assert.deepEqual(l.problems, []);
      },
    );
  }

  /** The area low by itself with the keyboard in the session's terminal: the shell has it. */
  const lowFromSession = async (t: TestContext): Promise<Launched & { term: string }> => {
    const l = await withShell(t, chromium, VIEW);
    await clickSession(l.page);
    await untilKeyboard(l.page, 'terminal');
    await goLow(l.page);
    await untilKeyboard(l.page, 'shell');
    return l;
  };

  for (const [what, keys] of [
    ['the Windows key alone (as Win+↑ starts)', ['Meta']],
    ['Alt alone (as Alt+Tab starts)', ['Alt']],
    ['Ctrl and Shift held and let go with no letter', ['Control', 'Shift']],
  ] as const) {
    await t.test(
      `${what} while the area is too low is no use of the shell: high again, the keyboard is back in the session's terminal`,
      async (t) => {
        const l = await lowFromSession(t);
        const { page } = l;
        for (const key of keys) await page.keyboard.down(key);
        for (const key of [...keys].reverse()) await page.keyboard.up(key);
        assert.equal(await keyboard(page), 'shell');

        await goHigh(page);
        await untilKeyboard(page, 'terminal');
        assert.deepEqual(l.problems, []);
      },
    );
  }

  await t.test(
    "a chord the window takes for itself while the area is too low (the key help, Ctrl+Shift+H, shown and closed again) is no use of the shell: high again, the keyboard is back in the session's terminal",
    async (t) => {
      const l = await lowFromSession(t);
      const { page } = l;
      const help = (): Promise<boolean> =>
        readPage(page, () => document.getElementById('help')?.hidden === false, null);
      await page.keyboard.press('Control+Shift+H');
      await until(help, 'the key help shown');
      await page.keyboard.press('Control+Shift+H');
      await until(async () => !(await help()), 'the key help closed');
      assert.equal(await keyboard(page), 'shell');

      await goHigh(page);
      await untilKeyboard(page, 'terminal');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "a chord that acts on the shell's view while the area is too low is a use of it: after find (Ctrl+Shift+F, then Esc) and after copy (Ctrl+Shift+C), high again, the keyboard stays in the shell",
    async (t) => {
      for (const chord of ['find', 'copy'] as const) {
        const l = await lowFromSession(t);
        const { page } = l;
        if (chord === 'find') {
          await page.keyboard.press('Control+Shift+F');
          await page.waitForFunction(
            () =>
              document.activeElement?.classList.contains('tv-find-input') === true &&
              document.getElementById('shell')?.contains(document.activeElement) === true,
            null,
            { timeout: 20_000 },
          );
          await page.keyboard.press('Escape');
        } else {
          await page.keyboard.press('Control+Shift+C');
        }
        await untilKeyboard(page, 'shell');

        await goHigh(page);
        assert.equal(await keyboard(page), 'shell', `${chord}: the user's use of the shell`);
        assert.deepEqual(l.problems, []);
      }
    },
  );

  await t.test(
    'text selected when the area is high again: the keyboard stays in the shell, and the selection stays',
    async (t) => {
      const l = await lowFromSession(t);
      const { page } = l;
      const selected = await page.evaluate(() => {
        const header = document.querySelector('#cards .card-header');
        const walker = document.createTreeWalker(header ?? document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node !== null && (node.textContent ?? '').trim() === '') node = walker.nextNode();
        if (node === null) return '';
        const range = document.createRange();
        range.selectNodeContents(node);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        return getSelection()?.toString() ?? '';
      });
      assert.ok(selected.length > 0, 'text of the header selected');

      await goHigh(page);
      assert.equal(await keyboard(page), 'shell', 'no move while text is selected');
      assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ''), selected);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a dialog shown when the area is high again (the switcher, opened while low): the keyboard stays in the dialog, and after it closes it is back in the shell, where the zone had it',
    async (t) => {
      const l = await lowFromSession(t);
      const { page } = l;
      await page.keyboard.press('Control+Shift+P');
      await page.waitForSelector('#switcher:not([hidden])', { state: 'attached', timeout: 20_000 });
      const inSwitcher = (): Promise<boolean> =>
        readPage(
          page,
          () => document.getElementById('switcher')?.contains(document.activeElement) === true,
          null,
        );
      assert.equal(await inSwitcher(), true);

      await goHigh(page);
      assert.equal(await inSwitcher(), true, 'the dialog keeps the keyboard');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#switcher[hidden]', { state: 'attached', timeout: 20_000 });
      await untilKeyboard(page, 'shell');
      assert.deepEqual(l.problems, []);
    },
  );

  /** The window made too low for both while no panel is drawn (nothing to wait for but the size). */
  const lowWindow = async (page: Page): Promise<void> => {
    await page.setViewportSize({
      width: VIEW.width,
      height: await lowHeight(page, VIEW.height, 10),
    });
    await until(
      async () => (await layout(page)).terminalShown && (await layout(page)).area > 0,
      "the session's terminal in the low window",
    );
  };
  /** A typed line runs in the shell (its echo on the shell's screen). */
  const runsInShell = async (page: Page, word: string): Promise<void> => {
    await page.keyboard.type(`echo "${word}-$((1 + 2))"`);
    await page.keyboard.press('Enter');
    await untilScreen(page, new RegExp(`^${word}-3$`, 'm'), undefined, '#shell');
  };

  await t.test(
    'a shell opened by the key in a too-low window keeps the keyboard when the window is higher',
    async (t) => {
      const l = await inWindow(t, chromium, { viewport: VIEW });
      const { page } = l;
      await clickSession(page);
      await untilKeyboard(page, 'terminal');
      await lowWindow(page);
      await untilKeyboard(page, 'terminal');

      await openShell(page);
      assert.equal((await layout(page)).mode, 'full');

      await goHigh(page);
      assert.equal(await keyboard(page), 'shell', 'the shell the user asked for keeps it');
      await runsInShell(page, 'asked');
      assert.deepEqual(l.problems, []);
    },
  );

  for (const [how, show] of [
    ['the key', (page: Page) => page.keyboard.press('Control+Shift+S')],
    ["the header's Shell", (page: Page) => page.locator('#cards .header-shell').click()],
  ] as const) {
    await t.test(
      `a hidden shell shown by ${how} in a too-low window keeps the keyboard when the window is higher`,
      async (t) => {
        const l = await withShell(t, chromium, VIEW);
        const { page } = l;
        await page.keyboard.press('Control+Shift+S'); // hidden, the keyboard to the session
        await untilPanel(page, false);
        await untilKeyboard(page, 'terminal');
        await lowWindow(page);
        await untilKeyboard(page, 'terminal');

        await show(page);
        await untilPanel(page, true);
        await untilKeyboard(page, 'shell');
        assert.equal((await layout(page)).mode, 'full');

        await goHigh(page);
        assert.equal(await keyboard(page), 'shell', 'the shell the user showed keeps it');
        await runsInShell(page, 'shown');
        assert.deepEqual(l.problems, []);
      },
    );
  }

  await t.test(
    'the area too low by itself, then a click into the shell: the keyboard stays in the shell when the area is high again',
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      await clickSession(page);
      await untilKeyboard(page, 'terminal');
      await goLow(page);
      await untilKeyboard(page, 'shell');

      await page.locator('#shell .tv-term:not([hidden]) .xterm-screen').click();

      await goHigh(page);
      assert.equal(await keyboard(page), 'shell', 'the click made it the user’s');
      await runsInShell(page, 'clicked');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the area too low by itself, then a paste into the shell (no key): the keyboard stays in the shell when the area is high again, and the next Enter runs the pasted line there',
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page, d } = l;
      await clickSession(page);
      await untilKeyboard(page, 'terminal');
      await goLow(page);
      await untilKeyboard(page, 'shell');

      // A paste as the mouse's menu makes it: the paste event on the shell's text area, no key.
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'echo "pasted-$((2 + 2))"');
        const area = document.querySelector('#shell .tv-term:not([hidden]) textarea');
        area?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      await untilScreen(page, /echo "pasted-/, undefined, '#shell');

      await goHigh(page);
      assert.equal(await keyboard(page), 'shell', 'the paste made it the user’s');
      const sessionInput = inputOf(d.record, S1);
      await page.keyboard.press('Enter');
      await untilScreen(page, /^pasted-4$/m, undefined, '#shell');
      assert.equal(inputOf(d.record, S1), sessionInput, 'nothing reached the session');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the keyboard in the list stays in the list when the area gets too low and high again',
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      await toZone(page, 'list');
      await untilKeyboard(page, 'list');
      await goLow(page);
      assert.equal(await keyboard(page), 'list');
      await goHigh(page);
      assert.equal(await keyboard(page), 'list');
      assert.equal(await shownText(page, '#focus-zone'), 'Focus: list');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "a connection cut and back while the area is too low: the shell hidden, the session's terminal laid out again with the keyboard",
    async (t) => {
      const l = await withShell(t, chromium, VIEW, { init: [KEEP_SOCKETS] });
      const { page } = l;
      await goLow(page);
      await untilKeyboard(page, 'shell');

      await page.evaluate(() => {
        (Reflect.get(globalThis, 'testSockets') as WebSocket[]).at(-1)?.close();
      });
      await connection(page, 'lost');
      await connection(page, 'open');

      await untilPanel(page, false);
      const now = await layout(page);
      assert.equal(now.mode, null, 'no split laid out');
      assert.equal(now.terminalShown, true, "the session's terminal is laid out");
      await untilKeyboard(page, 'terminal');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "the cards growing while split: the rules are applied again (the session's terminal keeps its least height), and past the rule the shell takes the area",
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      const least = await leastOf(page);
      const start = await layout(page);
      /**
       * The cards grown by content — an element of `px` px put inside `#cards`, as a bar the page
       * shows there (the carry-over bar) grows them — and the split read two frames later: the
       * panel's own observer, not a later list, must have laid it out by then.
       */
      const grow = (
        px: number,
      ): Promise<{ mode: string | null; terminal: number; shell: number }> =>
        page.evaluate(async (px) => {
          const cards = document.getElementById('cards') as HTMLElement;
          cards.querySelector('[data-test-grow]')?.remove();
          if (px > 0) {
            const filler = document.createElement('div');
            filler.dataset['testGrow'] = '';
            filler.style.cssText = `height:${px}px;flex:none`;
            cards.append(filler);
          }
          for (let n = 0; n < 2; n++) {
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          }
          const zone = document.getElementById('right-zone') as HTMLElement;
          const height = (id: string): number =>
            (document.getElementById(id) as HTMLElement).getBoundingClientRect().height;
          return {
            mode: zone.dataset['shell'] ?? null,
            terminal: height('terminal'),
            shell: height('shell'),
          };
        }, px);

      // The area 20 px over the rule: both, each kept at least its least.
      const over = await grow(start.area - (2 * least + BAR_PX) - 20);
      assert.equal(over.mode, 'split', JSON.stringify(over));
      assert.ok(
        over.terminal >= least - 1 && over.shell >= least - 1,
        `both kept: ${JSON.stringify(over)}`,
      );
      assert.ok((await layout(page)).area < start.area - 100, 'the cards did grow');
      // 10 px under it: the shell over the area.
      const under = await grow(start.area - (2 * least + BAR_PX) + 10);
      assert.equal(under.mode, 'full', JSON.stringify(under));
      const back = await grow(0);
      assert.equal(back.mode, 'split', JSON.stringify(back));
      near(back.shell, Math.round(start.area / 3), 'a third again');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "the split's own observer: cards that grow in a page of the module alone (no list, no render) shrink the shell to a third of what is left, and past the rule give it the area",
    async (t) => {
      const page = await newPage(t, chromium);
      const started = await startTestServer(t);
      await page.goto(pageUrl(started.server.port));
      const base = await assetBase(page);
      const result = await page.evaluate(async (base) => {
        type Panel = { draw(shown: boolean): void; mode(): string | null };
        const module = (await import(`${base}shell-panel.js`)) as {
          createShellPanel(deps: object): Panel;
        };
        const frame = (): Promise<void> =>
          new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
        const made = (tag: string, css: string): HTMLElement => {
          const one = document.createElement(tag);
          one.style.cssText = css;
          return one;
        };
        const zone = made(
          'section',
          'position:fixed;left:0;top:0;width:600px;height:600px;display:flex;flex-direction:column',
        );
        const cards = made('div', 'flex:none;height:0');
        const terminal = made('div', 'flex:1;min-height:0');
        const bar = made('div', 'flex:none;height:6px');
        const panel = made('div', 'flex:none;min-height:0');
        zone.append(cards, terminal, bar, panel);
        document.body.append(zone);
        const shell = module.createShellPanel({
          zone,
          cards,
          bar,
          panel,
          blocked: () => false,
          least: () => 84,
        });
        shell.draw(true);
        const read = () => ({
          mode: shell.mode(),
          panel: panel.getBoundingClientRect().height,
          terminal: terminal.getBoundingClientRect().height,
        });
        const seen = [read()];
        for (const height of [300, 430]) {
          cards.style.height = `${height}px`;
          await frame();
          await frame();
          seen.push(read());
        }
        return seen;
      }, base);
      assert.deepEqual(result[0], { mode: 'split', panel: 200, terminal: 394 }, 'a third of 600');
      assert.deepEqual(result[1], { mode: 'split', panel: 100, terminal: 194 }, 'a third of 300');
      assert.equal(result[2]?.mode, 'full', '170 px: under twice 84 and the bar');
    },
  );

  await t.test(
    'too low, selecting a session without a shell: its terminal laid out over the area, with the keyboard',
    async (t) => {
      const l = await inWindow(t, chromium, { viewport: VIEW });
      const { page } = l;
      await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      await clickRow(page, S1);
      await page.keyboard.press('Enter');
      await until(async () => (await layout(page)).terminalShown, "S1's terminal shown");
      await openShell(page);
      await goLow(page);

      await clickRow(page, S2);
      await page.keyboard.press('Enter');

      await untilPanel(page, false);
      await untilKeyboard(page, 'terminal');
      const now = await layout(page);
      assert.equal(now.mode, null);
      assert.equal(now.terminalShown, true);
      near(now.terminal, now.area, 'over the whole area');
      assert.deepEqual(l.problems, []);
    },
  );

  for (const [what, stored, low] of [
    ['without a stored height (a third)', undefined, false],
    ['with a stored height', '300', false],
    ['in a window too low for both (the whole area)', undefined, true],
  ] as const) {
    await t.test(
      `the act's first size ${what} is what the page's view computes for the panel's box, and the shell's attach proposes the same: no resize of it follows`,
      async (t) => {
        const l = await inWindow(t, chromium, {
          viewport: VIEW,
          init: [KEEP_SENT],
          ...(stored === undefined ? {} : { stored }),
        });
        const { page, term } = l;
        if (low) {
          await page.setViewportSize({
            width: VIEW.width,
            height: await lowHeight(page, VIEW.height, 10),
          });
          // The session's terminal, alone in the lower area, told its size first.
          await untilToldBoxes(l, S1, term, false);
        }
        const mark = (await sentOf(page)).length;
        await openShell(page);
        if (stored !== undefined)
          near((await layout(page)).shell, Number(stored), 'the stored height');
        if (low) assert.equal((await layout(page)).mode, 'full');
        // Its echo back from the shell comes after every refit the panel set off.
        await page.keyboard.type('echo "first-$((1 + 1))"');
        await page.keyboard.press('Enter');
        await untilScreen(page, /^first-2$/m, undefined, '#shell');

        const sent = await sentOf(page);
        const asked = sent.find((one) => one.t === 'act' && one['kind'] === 'shell');
        const [shell] = l.server.hub.shells?.() ?? [];
        assert.ok(asked !== undefined && shell !== undefined);
        const fit = await fitsOf(page, '#shell');
        assert.deepEqual(sizeOf(asked), fit, "the act's size is the panel's fit");
        const attach = sent.find((one) => one.t === 'attach' && one['term'] === shell.id);
        assert.deepEqual(sizeOf(attach), fit, 'the attach proposes the same');
        assert.deepEqual(
          sent.filter((one) => one.t === 'resize' && one['term'] === shell.id),
          [],
          'no resize of the shell',
        );
        if (low) {
          assert.deepEqual(
            sent.slice(mark).filter((one) => one.t === 'resize' && one['term'] === term),
            [],
            "no size proposed for the session's terminal it does not lay out",
          );
        }
        assert.deepEqual(l.problems, []);
      },
    );
  }

  await t.test(
    '`focus.area` is the whole terminal area while the panel is drawn (ruled): the panel and the bar are not counted out',
    async (t) => {
      const l = await withShell(t, chromium, VIEW, { init: [KEEP_SENT] });
      const { page } = l;
      /**
       * The `focus` the page sends once the window is `width` px wide (S2 8.2.3: at every change;
       * the zone's size changes, the panel stays drawn), and what the page's own view computes for
       * the whole terminal area and for the session's terminal's box then.
       */
      const focusAt = async (
        width: number,
      ): Promise<{ area: unknown; whole: Size | null; session: Size | null }> => {
        const before = (await sentOf(page)).length;
        await page.setViewportSize({ width, height: VIEW.height });
        let focus: Sent | undefined;
        await until(async () => {
          focus = (await sentOf(page))
            .slice(before)
            .filter((one) => one.t === 'focus')
            .at(-1);
          return focus !== undefined;
        }, 'a focus sent');
        assert.equal((await layout(page)).mode, 'split', 'the panel drawn beside');
        return {
          area: focus?.['area'],
          whole: await fitsOfArea(page),
          session: await fitsOf(page, '#terminal'),
        };
      };
      for (const width of [VIEW.width - 80, VIEW.width]) {
        const now = await focusAt(width);
        assert.ok(
          now.session !== null && now.whole !== null && now.session.rows < now.whole.rows,
          'the panel takes rows of the area',
        );
        assert.deepEqual(now.area, now.whole, `${width} px: the whole area`);
      }
      await dragBar(page, -100);
      const dragged = await focusAt(VIEW.width - 40);
      assert.deepEqual(dragged.area, dragged.whole, 'after a drag of the bar too');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a press on the bar that slips up to 3 px changes and stores nothing, past 3 px it drags; a drag back to its press stores nothing and leaves the height',
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      const start = await layout(page);
      const at = await barAt(page);
      for (const dy of [-1, 1, -2, 2, -3, 3]) {
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x, at.y + dy);
        await page.mouse.up();
        const now = await layout(page);
        assert.deepEqual([now.shell, now.stored], [start.shell, null], `a slip of ${dy} px`);
      }
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x, at.y - 4);
      near((await layout(page)).shell, start.shell + 4, 'past 3 px the drag begins');
      await page.mouse.move(at.x, at.y - 60, { steps: 4 });
      near((await layout(page)).shell, start.shell + 60, 'and follows the pointer');
      await page.mouse.move(at.x, at.y, { steps: 4 });
      await page.mouse.up();
      const back = await layout(page);
      assert.deepEqual(
        [back.shell, back.stored],
        [start.shell, null],
        'back at its press: nothing',
      );
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "a second page of the same browser follows the first one's drag when it ends, and its double click",
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      const two = await page.context().newPage();
      await two.setViewportSize(VIEW);
      await two.goto(pageUrl(l.server.port));
      await connection(two, 'open');
      await clickRow(two, S1);
      await two.keyboard.press('Enter');
      await until(
        async () => (await layout(two)).terminalShown,
        "S1's terminal on the second page",
      );
      await two.keyboard.press('Control+Shift+S'); // the shell is open: shown here too
      await untilPanel(two, true);
      const start = await layout(two);

      await dragBar(page, -100);
      const dragged = await layout(page);
      await until(
        async () => Math.abs((await layout(two)).shell - dragged.shell) <= 1,
        'the second page follows',
      );

      const at = await barAt(page);
      await page.mouse.dblclick(at.x, at.y);
      await until(
        async () => Math.abs((await layout(two)).shell - start.shell) <= 1,
        'and its double click',
      );
      assert.deepEqual(l.problems, []);
    },
  );

  /** A localStorage that throws at its every use, one that reads nothing and refuses writes, none. */
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
      `${what}: the page loads and the shell opens at a third; a drag and a double click work, the height holds until the page is closed`,
      async (t) => {
        const l = await withShell(t, chromium, VIEW, { init: [storage] });
        const { page } = l;
        const start = await layout(page);
        near(start.shell, Math.round(start.area / 3), 'a third');
        await dragBar(page, -100);
        near((await layout(page)).shell, start.shell + 100, 'dragged');
        await page.keyboard.type('echo "held-$((4 + 4))"');
        await page.keyboard.press('Enter');
        await untilScreen(page, /^held-8$/m, undefined, '#shell');
        near((await layout(page)).shell, start.shell + 100, 'it holds');
        const at = await barAt(page);
        await page.mouse.dblclick(at.x, at.y);
        await until(
          async () => Math.abs((await layout(page)).shell - start.shell) <= 1,
          'a third again',
        );
        assert.deepEqual(l.problems, [], 'no problem on the page');
      },
    );
  }

  await t.test(
    'a dialog that opens during a drag ends it: the height stops where the dialog met it, and is kept',
    async (t) => {
      const l = await withShell(t, chromium, VIEW);
      const { page } = l;
      const start = await layout(page);
      const at = await barAt(page);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x, at.y - 60, { steps: 4 });
      await page.keyboard.press('Control+Shift+P'); // the switcher, a dialog
      await page.waitForSelector('#switcher:not([hidden])', { state: 'attached', timeout: 20_000 });
      await page.mouse.move(at.x, at.y - 160, { steps: 4 });
      await page.mouse.up();
      const now = await layout(page);
      near(now.shell, start.shell + 60, 'stopped at the meeting');
      assert.equal(now.stored, String(Math.round(now.shell)), 'kept as at a release');
      await page.keyboard.press('Escape');
      assert.deepEqual(l.problems, []);
    },
  );
});
