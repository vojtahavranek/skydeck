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
import { browser } from './helpers/browser.ts';
import { assetBase, clickRow, connection, launched, readPage, toZone } from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import { promptOf, recordsOf, resumeHere, untilScreen, until } from './helpers/terminal.ts';

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

/** S1 resumed into the window's terminal and reported there, its shell open with the keyboard. */
async function withShell(
  t: TestContext,
  chromium: Browser,
  viewport?: { width: number; height: number },
): Promise<Launched & { term: string }> {
  const l = await launched(t, chromium);
  if (viewport !== undefined) await l.page.setViewportSize(viewport);
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
  await l.page.keyboard.press('Control+Shift+S');
  await untilPanel(l.page, true);
  await untilKeyboard(l.page, 'shell');
  await untilScreen(l.page, new RegExp(SHELL_PROMPT.trimEnd()), undefined, '#shell');
  return { ...l, term };
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

      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');

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
    'A8: a window too low for both: the shell over the whole terminal area with no bar and no session terminal; higher again shows both',
    async (t) => {
      const l = await withShell(t, chromium, { width: 1100, height: 700 });
      const { page, term } = l;
      const least = await leastOf(page);
      const split = await layout(page);
      assert.equal(split.mode, 'split');
      // The window's height that leaves the area 10 px under twice the least and the bar.
      const low = 700 - (split.area - (2 * least + BAR_PX - 10));

      await page.setViewportSize({ width: 1100, height: Math.floor(low) });

      await until(async () => (await layout(page)).mode === 'full', 'the shell over the area');
      const full = await layout(page);
      assert.equal(full.terminalShown, false, "the session's terminal not laid out");
      assert.equal(full.barShown, false, 'no bar');
      near(full.shell, full.area, 'the whole terminal area');
      await until(async () => (await keyboard(page)) === 'shell', 'the keyboard in the shell');
      const shellFits = await fitsOf(page, '#shell');
      await until(() => same(serverSizes(l, term).shell, shellFits), 'the shell told its size');

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
      // first, which a double click would remove.
      await dragBar(page, -60);
      await until(async () => (await layout(page)).stored !== null, 'a height stored');
      await page.waitForSelector('#cards .header-restart', { state: 'visible', timeout: 20_000 });
      await clickRow(page, S1);
      await toZone(page, 'list');
      const before = await layout(page);
      await page.keyboard.press('d');
      await page.waitForSelector('#end-dialog:not([hidden])', { state: 'attached' });
      await dragBar(page, -120); // the dialog's scrim lies over it
      const at = await barAt(page);
      // And the bar's own events, past the scrim: a press, a move, a release, a double click.
      await page.evaluate(
        ({ x, y }) => {
          const bar = document.getElementById('shell-bar') as HTMLElement;
          const event = (type: string, dy: number): PointerEvent =>
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              pointerId: 1,
              clientX: x,
              clientY: y + dy,
            });
          bar.dispatchEvent(event('pointerdown', 0));
          bar.dispatchEvent(event('pointermove', -120));
          bar.dispatchEvent(event('pointerup', -120));
          bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        },
        { x: at.x, y: at.y },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const during = await layout(page);
      assert.deepEqual(
        [during.shell, during.stored],
        [before.shell, before.stored],
        'nothing changed under the dialog',
      );
      await page.keyboard.press('Escape');
      await page.waitForSelector('#end-dialog[hidden]', { state: 'attached' });
      assert.deepEqual(l.problems, []);
    },
  );
});
