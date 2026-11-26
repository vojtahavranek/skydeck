// A session's shell on the page (issue #199, S2 12.6, 12.9): the page's second terminal view, in
// `#shell` under `#terminal`. The view's own members for it (each view keeps its own terminals
// and ignores another's terminal and channel; `reset`, `drop`, `heightFor`), and the page with a
// list that carries `shells`: nothing is drawn and nothing attached until the page shows a shell.
// The key (step 2.4), with real keys against a real test server whose shell is the stand-in shell:
// Ctrl+Shift+S in either zone opens one shell under the session's terminal with the keyboard in
// it, and no single key of the list does; the refusals' toasts; the key again hides and shows it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { S1, S2 } from '../test/helpers/platform.ts';
import { stillRuns } from '../test/helpers/keeper.ts';
import { SHELL_PROMPT } from '../test/helpers/shell-standin.ts';
import { connectTestPage, startTestServer } from '../test/helpers/window.ts';
import { SHELL_TEXTS } from '../web/shell-panel-text.js';
import { browser, newPage } from './helpers/browser.ts';
import {
  after,
  assetBase,
  clickRow,
  connection,
  editWorld,
  launched,
  logOf,
  mark,
  pageUrl,
  readPage,
  RESTARTED,
  shownText,
  scriptedList,
  showsText,
  TERM_A,
  TERM_B,
  TERM_C,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import {
  hexOf,
  inputOf,
  shownTerm,
  promptOf,
  resumeHere,
  screenText,
  untilScreen,
  until,
} from './helpers/terminal.ts';
import type { ServerSandbox, StartOptions } from '../test/helpers/window.ts';

test('issue #199: the second terminal view of the page', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "two views in two boxes: each shows its own terminal's snap and output and ignores the other's terminal and channel; reset() and drop(id) detach; heightFor(4) is 4 rows of the cell and the room",
    async (t) => {
      const page = await newPage(t, chromium);
      const started = await startTestServer(t);
      await page.goto(pageUrl(started.server.port));
      const base = await assetBase(page);
      const result = await page.evaluate(async (base) => {
        type View = {
          show(term: object | null): void;
          snap(message: object): void;
          output(channel: number, bytes: Uint8Array): void;
          attached(): string[];
          reset(): void;
          drop(id: string): void;
          heightFor(rows: number): number | null;
        };
        const module = (await import(`${base}terminal-view.js`)) as {
          createTerminalView(root: HTMLElement, deps: object): View;
        };
        const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
        const frame = (): Promise<void> =>
          new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
        const make = (top: number): { root: HTMLElement; view: View; sent: object[] } => {
          const root = document.createElement('div');
          root.className = 'terminal';
          root.style.cssText = `position:fixed;left:0;top:${top}px;width:800px;height:300px`;
          document.body.append(root);
          const sent: object[] = [];
          const view = module.createTerminalView(root, {
            send: (message: object) => sent.push(message),
            chord: () => false,
            openLink: () => {},
          });
          return { root, view, sent };
        };
        const a = make(0);
        const b = make(320);
        const payload = (id: string): object => ({
          id,
          state: 'running',
          cols: 80,
          rows: 12,
          ownsSize: true,
        });
        const A = 'a1a1a1a1a1a1';
        const B = 'b2b2b2b2b2b2';
        a.view.show(payload(A));
        b.view.show(payload(B));
        await tick();
        for (const view of [a.view, b.view]) {
          view.snap({ t: 'snap', term: A, ch: 3, cols: 80, rows: 4, data: 'snap-of-A\r\n' });
          view.snap({ t: 'snap', term: B, ch: 4, cols: 80, rows: 12, data: 'snap-of-B\r\n' });
          view.output(3, new TextEncoder().encode('out-of-A'));
          view.output(4, new TextEncoder().encode('out-of-B'));
        }
        await frame();
        const text = (root: HTMLElement): string =>
          root.querySelector('.xterm-rows')?.textContent ?? '';
        const shown = { a: text(a.root), b: text(b.root) };
        // A's terminal is 4 rows high (its snap's size): what heightFor(4) must give, with the room.
        const screen = a.root.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0;
        const height = a.view.heightFor(4);
        const attachedBefore = { a: a.view.attached(), b: b.view.attached() };
        const sentBefore = b.sent.length;
        b.view.reset();
        const afterReset = {
          attached: b.view.attached(),
          sent: b.sent.slice(sentBefore),
          boxes: b.root.querySelectorAll('.tv-term').length,
        };
        const aBefore = a.sent.length;
        a.view.drop('ffffffffffff');
        const dropUnknown = a.sent.slice(aBefore);
        a.view.drop(A);
        const afterDrop = {
          attached: a.view.attached(),
          sent: a.sent.slice(aBefore),
          boxes: a.root.querySelectorAll('.tv-term').length,
        };
        // The room of the style sheet above and below the text.
        const style = getComputedStyle(a.root);
        const px = (side: string): number =>
          Number(/^\s*([\d.]+)px/.exec(style.getPropertyValue(`--tv-pad-${side}`))?.[1] ?? 0);
        return {
          shown,
          attachedBefore,
          afterReset,
          dropUnknown,
          afterDrop,
          height,
          screen,
          room: px('top') + px('bottom'),
        };
      }, base);

      assert.ok(result.shown.a.includes('snap-of-A') && result.shown.a.includes('out-of-A'));
      assert.ok(!result.shown.a.includes('-of-B'), `a shows nothing of B: ${result.shown.a}`);
      assert.ok(result.shown.b.includes('snap-of-B') && result.shown.b.includes('out-of-B'));
      assert.ok(!result.shown.b.includes('-of-A'), `b shows nothing of A: ${result.shown.b}`);
      assert.deepEqual(result.attachedBefore, { a: ['a1a1a1a1a1a1'], b: ['b2b2b2b2b2b2'] });
      assert.deepEqual(result.afterReset, {
        attached: [],
        sent: [{ t: 'detach', term: 'b2b2b2b2b2b2' }],
        boxes: 0,
      });
      assert.deepEqual(result.dropUnknown, [], 'an id the view does not have: nothing');
      assert.deepEqual(result.afterDrop, {
        attached: [],
        sent: [{ t: 'detach', term: 'a1a1a1a1a1a1' }],
        boxes: 0,
      });
      assert.ok(result.room > 0, 'the style sheet leaves room above and below');
      assert.ok(result.screen > 0, "xterm.js drew A's 4 rows");
      assert.equal(result.height, Math.round(result.screen) + result.room);
    },
  );

  await t.test(
    'a list that carries a shell: no panel is drawn and no attach is sent for it (nothing shows a shell yet)',
    async (t) => {
      const page = await newPage(t, chromium);
      const list = scriptedList(
        [{ id: S1, terminal: TERM_A, slot: 1 }],
        [{ id: TERM_A, slot: 1, sessionId: S1 }],
        null,
        [{ id: TERM_B, of: TERM_A }],
      );
      const w = await editWorld(t, page, list);
      await until(
        () => w.sent.some((one) => one['t'] === 'attach' && one['term'] === TERM_A),
        "the session's terminal attached",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const drawn = await readPage(
        page,
        () => ({
          shell: (document.getElementById('shell') as HTMLElement).hidden,
          bar: (document.getElementById('shell-bar') as HTMLElement).hidden,
          height: (document.getElementById('shell') as HTMLElement).getBoundingClientRect().height,
          terms: document.querySelectorAll('#shell .tv-term').length,
        }),
        null,
      );
      assert.deepEqual(drawn, { shell: true, bar: true, height: 0, terms: 0 });
      assert.deepEqual(
        w.sent.filter((one) => one['term'] === TERM_B),
        [],
        'nothing sent for the shell',
      );
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Step 2.4: the key

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

/** Whether the panel is drawn, and laid out under the session's terminal. */
async function panel(page: Page): Promise<{ shown: boolean; under: boolean }> {
  return readPage(
    page,
    () => {
      const shell = document.getElementById('shell') as HTMLElement;
      const terminal = document.getElementById('terminal') as HTMLElement;
      const box = shell.getBoundingClientRect();
      return {
        shown: !shell.hidden && box.height > 0,
        under: box.top >= terminal.getBoundingClientRect().bottom - 0.5,
      };
    },
    null,
  );
}

async function untilPanel(page: Page, shown: boolean): Promise<void> {
  await until(
    async () => (await panel(page)).shown === shown,
    `the panel ${shown ? 'shown' : 'hidden'}`,
  );
}

/** S1 resumed into the window's terminal, its prompt shown and the keyboard in it. */
async function inWindow(
  t: TestContext,
  chromium: Browser,
  server?: (d: ServerSandbox) => StartOptions,
): Promise<Launched & { term: string }> {
  const l = await launched(t, chromium, server === undefined ? {} : { server });
  l.d.resumable(S1);
  l.d.resumable(S2);
  const term = await resumeHere(l.page, S1);
  await untilScreen(l.page, promptOf(S1));
  // The server opens a shell once the terminal shows its session (its mapping, at a tick).
  await until(
    () =>
      l.server.hub
        .list()
        .some((one) => one.id === term && one.sessionId === S1 && one.program !== null),
    'S1 reported in its terminal',
  );
  return { ...l, term };
}

const shellsOf = (l: Launched): string[] =>
  (l.server.hub.shells?.() ?? []).map((shell) => shell.id);

/** Opened: the panel shown under the terminal, the keyboard in it, the stand-in's prompt there. */
async function untilShellOpen(l: Launched): Promise<void> {
  await untilPanel(l.page, true);
  assert.equal((await panel(l.page)).under, true, "under the session's terminal");
  await untilKeyboard(l.page, 'shell');
  await untilScreen(l.page, new RegExp(SHELL_PROMPT.trimEnd()), undefined, '#shell');
}

/** `line` typed into the shell with real keys, and its output on the shell's screen. */
async function typedInShell(page: Page, line: string, shows: RegExp): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await untilScreen(page, shows, undefined, '#shell');
}

/** No `act` went out since the mark `name`. */
async function noActSince(page: Page, name: string): Promise<void> {
  const acts = after(await logOf(page), name).filter((one) => one.e === 'out' && one.t === 'act');
  assert.deepEqual(acts, [], 'no act was sent');
}

test("issue #199: the key opens, shows and hides the session's shell", async (t) => {
  const chromium = await browser(t);

  for (const [way, zone, key] of [
    ['Ctrl+Shift+S in the terminal zone', 'terminal', 'Control+Shift+S'],
    ['Ctrl+Shift+S in the list zone', 'list', 'Control+Shift+S'],
  ] as const) {
    await t.test(
      `A1: ${way} opens one shell under the session's terminal with the keyboard in it; pressing again and again never makes a second`,
      async (t) => {
        const l = await inWindow(t, chromium);
        await toZone(l.page, zone);

        await l.page.keyboard.press(key);

        await untilShellOpen(l);
        await typedInShell(l.page, 'echo "typed $((40 + 2))"', /^typed 42$/m);
        assert.equal(shellsOf(l).length, 1);
        for (let n = 0; n < 4; n++) {
          await l.page.keyboard.press('Control+Shift+S');
          await untilPanel(l.page, n % 2 === 1);
        }
        await toZone(l.page, 'list');
        await l.page.keyboard.press('Control+Shift+S');
        await untilKeyboard(l.page, 'shell');
        assert.equal((await panel(l.page)).shown, true);
        assert.equal(shellsOf(l).length, 1, 'never a second shell');
        assert.deepEqual(l.problems, []);
      },
    );
  }

  await t.test(
    'no single key of the list opens a shell (ruled): a sentence with an `s` typed into the list by mistake sends no act and opens no panel',
    async (t) => {
      const l = await inWindow(t, chromium);
      await toZone(l.page, 'list');
      await mark(l.page, 'typed');

      for (const delay of [0, 120]) {
        await l.page.keyboard.type('yes, she is so shy ss', { delay });
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await noActSince(l.page, 'typed');
      assert.equal((await panel(l.page)).shown, false, 'no panel');
      assert.deepEqual(shellsOf(l), [], 'no shell');
      assert.equal(await keyboard(l.page), 'list', 'the keyboard stays in the list');
    },
  );

  await t.test(
    'A2: a session that does not run and an ended terminal: the toast, no act, no shell',
    async (t) => {
      const l = await inWindow(t, chromium);
      await clickRow(l.page, S2);
      await mark(l.page, 'not running');
      await l.page.keyboard.press('Control+Shift+S');
      await showsText(l.page, '#toast', new RegExp(escapeRe(SHELL_TEXTS.openFirst)));
      await noActSince(l.page, 'not running');

      await clickRow(l.page, S1);
      await toZone(l.page, 'terminal');
      await l.page.keyboard.type('/exit');
      await l.page.keyboard.press('Enter');
      await l.page.waitForSelector('#cards [data-card="ended"]', {
        state: 'attached',
        timeout: 20_000,
      });
      await mark(l.page, 'ended');
      await l.page.keyboard.press('Control+Shift+S');
      await showsText(l.page, '#toast', new RegExp(escapeRe(SHELL_TEXTS.ended)));
      await noActSince(l.page, 'ended');
      assert.deepEqual(shellsOf(l), []);
    },
  );

  await t.test(
    "A2: a login shell that ends at once: the server's words as the toast, and no panel left",
    async (t) => {
      const l = await inWindow(t, chromium, (d) => {
        const quick = join(d.s.bin, 'quick-shell');
        writeFileSync(quick, '#!/bin/sh\necho bye\nexit 3\n', { mode: 0o755 });
        // A long wait for an end at once: on a loaded machine the script may take more than
        // the server's 400 ms between its start and its exit.
        return { platform: (p) => ({ ...p, loginShell: quick }), shellEndedAtOnceMs: 5000 };
      });

      await l.page.keyboard.press('Control+Shift+S');

      // The panel may come and go while the server waits for the end (a list brings the shell).
      await showsText(l.page, '#toast', /^Shell: the shell ended at once \(status 3\)/);
      // The toast comes with the act's answer, the panel goes with the next list.
      await untilPanel(l.page, false);
      assert.deepEqual(shellsOf(l), []);
    },
  );

  await t.test(
    'A4: the keyboard in the shell, the key hides the panel and gives the keyboard to the session; the shell runs on; hidden, the key shows it with the keyboard',
    async (t) => {
      const l = await inWindow(t, chromium);
      await l.page.keyboard.press('Control+Shift+S');
      await untilShellOpen(l);
      const [id] = shellsOf(l);
      await typedInShell(l.page, 'sleep 2; echo "later $((6 * 7))"', /sleep 2/);

      await l.page.keyboard.press('Control+Shift+S');

      await untilPanel(l.page, false);
      await untilKeyboard(l.page, 'terminal');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.deepEqual(shellsOf(l), [id], 'it keeps running');

      await l.page.keyboard.press('Control+Shift+S');

      await untilPanel(l.page, true);
      await untilKeyboard(l.page, 'shell');
      await untilScreen(l.page, /^later 42$/m, undefined, '#shell');
      assert.deepEqual(shellsOf(l), [id]);
    },
  );

  await t.test(
    'A2: scripted — a session elsewhere and one not started: the toast from its row, or the server’s refusal; an act answered ok whose shell no list brought opens no panel later',
    async (t) => {
      const page = await newPage(t, chromium);
      const elsewhere = { pid: 4242, tty: 'pts/3', dir: '/home/u/project' };
      let shells: { id: string; of: string }[] = [];
      const listNow = (): Record<string, unknown> => {
        const list = scriptedList(
          [
            { id: S1, terminal: TERM_A, slot: 1 },
            { id: S2, terminal: null, slot: null },
          ],
          [{ id: TERM_A, slot: 1, sessionId: S1 }],
          null,
          shells,
        ) as { sections: { rows: Record<string, unknown>[] }[] };
        const rows = list.sections[0]?.rows ?? [];
        const second = rows[1];
        if (second !== undefined) {
          second['state'] = 'waiting';
          second['elsewhere'] = elsewhere;
        }
        return list;
      };
      const w = await editWorld(t, page, () => listNow());

      // S2 runs in another terminal: the toast from its row, no act.
      await clickRow(page, S2);
      await mark(page, 'elsewhere');
      await page.keyboard.press('Control+Shift+S');
      await showsText(page, '#toast', new RegExp(escapeRe(SHELL_TEXTS.elsewhere)));
      await noActSince(page, 'elsewhere');

      // S1's terminal: the act; the server refuses (not started yet): its words as the toast.
      await clickRow(page, S1);
      await page.keyboard.press('Control+Shift+S');
      const refused = await w.act(1);
      assert.deepEqual(
        [refused['kind'], refused['term']],
        ['shell', TERM_A],
        'the act names the terminal',
      );
      w.answer(refused, {
        ok: false,
        error: 'this session has not started yet: open a shell once it runs',
      });
      await showsText(
        page,
        '#toast',
        /^Shell: this session has not started yet: open a shell once it runs/,
      );

      // Answered ok, and the next list brings no shell: the act is forgotten.
      await page.keyboard.press('Control+Shift+S');
      const second = await w.act(2);
      w.answer(second, { ok: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      w.list(() => listNow()); // a list after the answer, without the shell
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = await keyboard(page);
      shells = [{ id: TERM_B, of: TERM_A }];
      w.list(() => listNow()); // later, a shell of that terminal (another window's)
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal((await panel(page)).shown, false, 'no panel opens');
      assert.equal(await keyboard(page), before, 'the keyboard did not move');

      // A shell that a list brought, and that ended before the act's answer (the server's wait
      // for an end at once): the panel came and went, and the refusal is still the toast.
      shells = [];
      w.list(() => listNow());
      await new Promise((resolve) => setTimeout(resolve, 300));
      await clickRow(page, S1);
      await page.keyboard.press('Control+Shift+S');
      const third = await w.act(3);
      shells = [{ id: 'cccccccccccc', of: TERM_A }];
      w.list(() => listNow());
      await untilPanel(page, true);
      shells = [];
      w.list(() => listNow());
      await untilPanel(page, false);
      w.answer(third, { ok: false, error: 'the shell ended at once (status 3)' });
      await showsText(page, '#toast', /^Shell: the shell ended at once \(status 3\)/);
    },
  );
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------
// Step 2.5: the keyboard between the two, and the chords

/**
 * The middle of `text` on the shown screen of the view in `root` (the last row that holds it; the
 * text may span several of xterm.js's spans).
 */
async function whereIs(page: Page, root: string, text: string): Promise<{ x: number; y: number }> {
  const at = await page.evaluate(
    ({ root, text }) => {
      const box = document.querySelector(`${root} .tv-term:not([hidden])`);
      let found: { x: number; y: number } | null = null;
      for (const row of box?.querySelectorAll('.xterm-rows > div') ?? []) {
        const nodes: Text[] = [];
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          nodes.push(node as Text);
        }
        const whole = nodes.map((node) => node.data).join('');
        const index = whole.lastIndexOf(text);
        if (index === -1) continue;
        const place = (offset: number): [Text, number] => {
          let left = offset;
          for (const node of nodes) {
            if (left <= node.data.length) return [node, left];
            left -= node.data.length;
          }
          const last = nodes[nodes.length - 1] as Text;
          return [last, last.data.length];
        };
        const range = document.createRange();
        range.setStart(...place(index));
        range.setEnd(...place(index + text.length));
        const rect = range.getBoundingClientRect();
        found = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return found;
    },
    { root, text },
  );
  assert.ok(at !== null, `${text} is on the screen of ${root}`);
  return at;
}

/** A click in the middle of the shown screen of the view in `root`. */
async function clickIn(page: Page, root: string): Promise<void> {
  await page.locator(`${root} .tv-term:not([hidden]) .xterm-screen`).click();
}

/** The shell open, shown, with the keyboard in it, under S1's terminal. */
async function withShell(t: TestContext, chromium: Browser): Promise<Launched & { term: string }> {
  const l = await inWindow(t, chromium);
  await l.page.keyboard.press('Control+Shift+S');
  await untilShellOpen(l);
  return l;
}

test("issue #199: the keyboard between the session's terminal and its shell, and the chords", async (t) => {
  const chromium = await browser(t);

  await t.test(
    'A4: a click moves the keyboard between the two; with the panel shown and the keyboard in the session or the list the key gives it to the shell; Ctrl+Shift+L returns to the side that had it',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;

      await clickIn(page, '#terminal');
      await untilKeyboard(page, 'terminal');
      await clickIn(page, '#shell');
      await untilKeyboard(page, 'shell');
      await clickIn(page, '#terminal');
      await untilKeyboard(page, 'terminal');

      await page.keyboard.press('Control+Shift+S');
      await untilKeyboard(page, 'shell');
      assert.equal((await panel(page)).shown, true, 'the panel stays shown');

      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'list');
      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'shell');

      await clickIn(page, '#terminal');
      await untilKeyboard(page, 'terminal');
      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'list');
      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'terminal');

      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'list');
      await page.keyboard.press('Control+Shift+S');
      await untilKeyboard(page, 'shell');
      assert.equal((await panel(page)).shown, true);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'A10: find, copy, the paste and the raw Ctrl+Shift+V act on the terminal that has the keyboard: the shell, then the session',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page, d } = l;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: `http://127.0.0.1:${l.server.port}`,
      });
      const clipboard = (): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
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
      const writes = (): Promise<string[]> =>
        page.evaluate(() => [...(Reflect.get(globalThis, 'testWrites') as string[])]);
      const putOnClipboard = (text: string): Promise<void> =>
        page.evaluate(
          (text) =>
            (Reflect.get(globalThis, 'testWriteText') as (t: string) => Promise<void>)(text),
          text,
        );
      await typedInShell(page, 'echo "needle-$((1 + 1))"', /^needle-2$/m);

      // Find, in the shell: its own find bar, over the shell's screen.
      await page.keyboard.press('Control+Shift+F');
      await page.waitForFunction(
        () =>
          document.activeElement?.classList.contains('tv-find-input') === true &&
          document.getElementById('shell')?.contains(document.activeElement) === true,
        null,
        { timeout: 20_000 },
      );
      assert.equal(await page.locator('#terminal .tv-find').isHidden(), true);
      await page.keyboard.type('needle-2');
      await page.keyboard.press('Enter');
      await until(
        async () => (await page.locator('#shell .tv-find-count').textContent()) === '1 of 1',
        "one match in the shell's screen",
      );
      await page.keyboard.press('Escape');
      await untilKeyboard(page, 'shell');

      // Copy: the shell's selection, written once (by one view only), then by Ctrl+Shift+C.
      const word = await whereIs(page, '#shell', 'needle-2');
      await page.mouse.dblclick(word.x, word.y);
      await until(async () => (await writes()).length >= 1, 'copied on select');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const copied = await writes();
      assert.equal(copied.length, 1, `written once: ${JSON.stringify(copied)}`);
      assert.match(copied[0] ?? '', /needle/);
      await putOnClipboard('copied elsewhere');
      await page.keyboard.press('Control+Shift+C');
      await until(async () => (await writes()).length === 2, 'Ctrl+Shift+C wrote it');
      assert.equal((await writes())[1], copied[0]);
      assert.equal(await clipboard(), copied[0]);

      // Ctrl+V pastes into the shell (its terminal echoes it), nothing reaches the session.
      const sessionInput = inputOf(d.record, S1);
      await putOnClipboard('pasted-into-shell');
      await page.keyboard.press('Control+V');
      await untilScreen(page, /pasted-into-shell/, undefined, '#shell');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(inputOf(d.record, S1), sessionInput, 'the session got nothing');
      await page.keyboard.press('Control+U'); // the shell's line cleared again

      // The raw Ctrl+V (Ctrl+Shift+V, Claude Code's image paste): the byte 16 goes to the terminal
      // that has the keyboard, as the server's `input` of it says, and to no other.
      const hub = l.server.hub;
      const inputs: string[] = [];
      const input = hub.input.bind(hub);
      hub.input = (term, data) => {
        inputs.push(`${term} ${Buffer.from(data).toString('hex')}`);
        return input(term, data);
      };
      t.after(() => {
        hub.input = input;
      });
      const [shellId] = shellsOf(l);
      await page.keyboard.press('Control+Shift+V');
      await until(() => inputs.includes(`${shellId} 16`), 'the raw Ctrl+V reached the shell');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(
        inputs.filter((one) => one.startsWith(l.term)),
        [],
        'the session got nothing of it',
      );
      await page.keyboard.press('x'); // the byte asked the shell's line for one literal character

      // The session's terminal: each acts there.
      await clickIn(page, '#terminal');
      await untilKeyboard(page, 'terminal');
      await page.keyboard.press('Control+Shift+F');
      await page.waitForFunction(
        () =>
          document.activeElement?.classList.contains('tv-find-input') === true &&
          document.getElementById('terminal')?.contains(document.activeElement) === true,
        null,
        { timeout: 20_000 },
      );
      assert.equal(await page.locator('#shell .tv-find').isHidden(), true);
      await page.keyboard.press('Escape');
      await untilKeyboard(page, 'terminal');
      await putOnClipboard('pasted-into-session');
      await page.keyboard.press('Control+V');
      await until(
        () => inputOf(d.record, S1).includes(hexOf('pasted-into-session')),
        'the session got the paste',
      );
      assert.ok(!(await screenText(page, '#shell')).includes('pasted-into-session'));
      const before = inputs.length;
      await page.keyboard.press('Control+Shift+V');
      await until(
        () => inputs.slice(before).includes(`${l.term} 16`),
        "the raw Ctrl+V reached the session's terminal",
      );
      assert.deepEqual(
        inputs.slice(before).filter((one) => one.startsWith(shellId ?? '-')),
        [],
        'the shell got nothing of it',
      );
      assert.deepEqual(l.problems, []);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Step 2.7: after a reload, a reconnect and a server restart; a shell that is gone

/** Whether the header's Shell shows its dot (a shell is open, shown or hidden). */
async function dot(page: Page): Promise<boolean> {
  return readPage(
    page,
    () =>
      document.querySelector<HTMLElement>('#cards .header-shell-mark')?.checkVisibility() === true,
    null,
  );
}

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

test('issue #199: after a reload, a reconnect and a server restart every shell is hidden; a shell that is gone leaves', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'A9: with the panel shown, a reload and then a connection cut: each time the panel is hidden and the dot shows; the key shows it again with its screen, output written meanwhile included',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      const [id] = shellsOf(l);
      await typedInShell(page, 'echo "marker-$((3 * 3))"', /^marker-9$/m);

      await page.addInitScript(KEEP_SOCKETS);
      await page.reload();
      await connection(page, 'open');
      await until(async () => await dot(page), 'the dot after the reload');
      assert.equal((await panel(page)).shown, false, 'hidden after the reload');
      await toZone(page, 'terminal');
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');
      await untilScreen(page, /^marker-9$/m, undefined, '#shell');

      await page.keyboard.type('sleep 2; echo "meanwhile-$((5 + 5))"');
      await page.keyboard.press('Enter');
      await page.evaluate(() => {
        const sockets = Reflect.get(globalThis, 'testSockets') as WebSocket[];
        sockets.at(-1)?.close();
      });
      await connection(page, 'lost');
      await connection(page, 'open');
      await until(async () => await dot(page), 'the dot after the reconnect');
      assert.equal((await panel(page)).shown, false, 'hidden after the reconnect');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await toZone(page, 'terminal');
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilScreen(page, /^meanwhile-10$/m, undefined, '#shell');
      assert.deepEqual(shellsOf(l), [id], 'the same shell all along');
    },
  );

  await t.test(
    'A7: after the server is stopped and another started, the page says so, the dot shows, the key shows the panel with the screen from before, and a typed command runs in the same process',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page, d } = l;
      await typedInShell(page, 'echo "pid-$$"', /^pid-\d+$/m);
      const pid = /^pid-(\d+)$/m.exec(await screenText(page, '#shell'))?.[1];
      assert.ok(pid !== undefined);
      const port = l.server.port;

      await l.server.stop('the test restarts it');
      const again = await d.start({ port });

      await showsText(page, '#info-text', RESTARTED);
      await connection(page, 'open');
      await until(async () => await dot(page), 'the dot after the restart');
      assert.equal((await panel(page)).shown, false);
      await toZone(page, 'terminal');
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');
      await untilScreen(page, new RegExp(`^pid-${pid}$`, 'm'), undefined, '#shell');
      await typedInShell(page, 'echo "again-$$"', new RegExp(`^again-${pid}$`, 'm'));
      assert.equal((again.server.hub.shells?.() ?? []).length, 1);
    },
  );

  await t.test(
    "selecting another session and coming back keeps this page's panel shown or hidden; a session with its own shell shows its own state; `exit` closes the panel and the keyboard goes to the session's terminal",
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      const s2 = await resumeHere(page, S2);
      await untilScreen(page, promptOf(S2));
      await until(
        () =>
          l.server.hub.list().some((one) => one.id === s2 && one.sessionId === S2 && one.program),
        'S2 reported',
      );
      assert.equal((await panel(page)).shown, false, 'S2 has no shell: no panel');
      await clickRow(page, S1);
      await page.keyboard.press('Enter');
      await untilPanel(page, true); // S1's shell was shown: shown again

      // S2's own shell, then hidden; S1's stays shown.
      await clickRow(page, S2);
      await page.keyboard.press('Enter');
      await untilPanel(page, false);
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, false);
      await clickRow(page, S1);
      await page.keyboard.press('Enter');
      await untilPanel(page, true);
      await clickRow(page, S2);
      await page.keyboard.press('Enter');
      await untilPanel(page, false);
      assert.equal(await dot(page), true, "S2's hidden shell: the dot");
      assert.equal(shellsOf(l).length, 2);

      // Another terminal starts on the session's side: from S1's shell to S2, whose shell is shown
      // too, and back, the keyboard lands in the session's terminal each time, not in its shell.
      await page.keyboard.press('Control+Shift+S'); // S2's shell shown again, the keyboard in it
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');
      await page.keyboard.press('Control+Shift+1');
      await until(async () => (await shownTerm(page)) === l.term, "S1's terminal shown");
      await untilPanel(page, true);
      await untilKeyboard(page, 'terminal');
      await clickIn(page, '#shell');
      await untilKeyboard(page, 'shell');
      await page.keyboard.press('Control+Shift+2');
      await until(async () => (await shownTerm(page)) === s2, "S2's terminal shown");
      await untilPanel(page, true);
      await untilKeyboard(page, 'terminal');
      // The same through the list, where nothing gives the new terminal the keyboard at once: from
      // S2's shell to the list, S1 selected there, and back to the terminal zone.
      await clickIn(page, '#shell');
      await untilKeyboard(page, 'shell');
      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'list');
      await page.keyboard.press('k');
      await until(async () => (await shownTerm(page)) === l.term, "S1's terminal shown again");
      await untilPanel(page, true);
      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'terminal');

      // `exit` in S1's shell: the panel goes, the keyboard is in S1's terminal, and the view lets
      // that shell's terminal go.
      const s1Shell = (l.server.hub.shells?.() ?? []).find((one) => one.of === l.term)?.id;
      assert.ok(s1Shell !== undefined);
      await clickRow(page, S1);
      await page.keyboard.press('Enter');
      await untilPanel(page, true);
      await clickIn(page, '#shell');
      await untilKeyboard(page, 'shell');
      await page.keyboard.type('exit');
      await page.keyboard.press('Enter');
      await untilPanel(page, false);
      await untilKeyboard(page, 'terminal');
      await until(async () => !(await dot(page)), 'no dot: no shell');
      assert.equal(shellsOf(l).length, 1, "S2's shell runs on");
      await until(
        async () =>
          (await readPage(
            page,
            (id) => document.querySelectorAll(`#shell .tv-term[data-term="${id}"]`).length,
            s1Shell,
          )) === 0,
        "the view dropped the ended shell's terminal",
      );
    },
  );

  await t.test(
    'a shell that ends while the keyboard is elsewhere (ruled): moved to the list, or to the list’s filter, before the `exit`, the keyboard stays there after the panel went',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      for (const where of ['list', 'filter'] as const) {
        if (where === 'filter') {
          await page.keyboard.press('Control+Shift+S'); // a new shell, the keyboard in it
          await untilPanel(page, true);
          await untilKeyboard(page, 'shell');
          await untilScreen(page, new RegExp(SHELL_PROMPT.trimEnd()), undefined, '#shell');
        }
        // The shell ends once the test says so (a file it waits for), not by a clock.
        const go = join(l.d.s.home, `go-${where}`);
        await page.keyboard.type(`while [ ! -e '${go}' ]; do sleep 0.1; done; exit`);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Control+Shift+L');
        await untilKeyboard(page, 'list');
        if (where === 'filter') {
          await page.keyboard.press('/');
          await until(
            () =>
              readPage(
                page,
                () => document.activeElement?.classList.contains('list-filter') === true,
                null,
              ),
            'the keyboard in the filter',
          );
        }
        const holder = await readPage(page, () => document.activeElement?.className ?? '', null);

        writeFileSync(go, '');

        await untilPanel(page, false);
        await until(() => shellsOf(l).length === 0, 'the shell gone on the server');
        await until(async () => !(await dot(page)), 'no dot');
        assert.equal(
          await readPage(page, () => document.activeElement?.className ?? '', null),
          holder,
          `${where}: the keyboard stays where it was`,
        );
        assert.equal(await keyboard(page), 'list');
        assert.equal(await shownText(page, '#focus-zone'), 'Focus: list');
        if (where === 'filter') {
          await page.keyboard.press('Escape');
        }
      }
      assert.deepEqual(l.problems, []);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Step 3.1: the ends on the page, and the dialogs' line

const SHELL_LINE = 'Ending the session ends its shell too.';

/** Whether the session's terminal (`#terminal`) has the whole terminal area under the cards. */
async function wholeArea(page: Page): Promise<{ whole: boolean; detail: string }> {
  return readPage(
    page,
    () => {
      const zone = document.getElementById('right-zone') as HTMLElement;
      const cards = (document.getElementById('cards') as HTMLElement).getBoundingClientRect();
      const terminal = (document.getElementById('terminal') as HTMLElement).getBoundingClientRect();
      const rect = zone.getBoundingClientRect();
      const bottom = rect.bottom - (parseFloat(getComputedStyle(zone).borderBottomWidth) || 0);
      return {
        whole:
          Math.abs(terminal.bottom - bottom) <= 1 && Math.abs(terminal.top - cards.bottom) <= 1,
        detail: JSON.stringify({ terminal, cards: cards.bottom, bottom }),
      };
    },
    null,
  );
}

/** The program of the one shell the server has (its pid and start), read before an end. */
function shellProgramOf(l: Launched): { pid: number; procStart: number } {
  const [shell] = l.server.hub.shells?.() ?? [];
  assert.ok(shell?.program !== null && shell?.program !== undefined, 'a shell with its program');
  return shell.program;
}

/** The panel and the dot gone, no shell on the server, and the shell's program `program` ended. */
async function shellGone(l: Launched, program: { pid: number; procStart: number }): Promise<void> {
  await untilPanel(l.page, false);
  await until(async () => !(await dot(l.page)), 'no dot');
  await until(() => shellsOf(l).length === 0, 'no shell on the server');
  await until(() => !stillRuns(program.pid, program.procStart), "the shell's program ended");
}

/** The ended bar shown, the panel and the dot gone, the session's terminal over the whole area. */
async function endedWithoutShell(
  l: Launched,
  program: { pid: number; procStart: number },
): Promise<void> {
  const { page } = l;
  await page.waitForSelector('#cards [data-card="ended"]', { state: 'attached', timeout: 20_000 });
  await shellGone(l, program);
  await until(async () => (await wholeArea(page)).whole, 'the ended terminal over the whole area');
  assert.equal(
    await page.locator('#cards .header-shell').isVisible(),
    false,
    'no Shell in the header of an ended terminal',
  );
}

/** The dialog "Mark done" or "Park" shown, and its line on the session's shell (null: none). */
async function dialogShellLine(page: Page): Promise<string | null> {
  await page.waitForSelector('#end-dialog:not([hidden])', { state: 'attached', timeout: 20_000 });
  return readPage(
    page,
    () => {
      const line = document.querySelector<HTMLElement>('#end-dialog .end-shell');
      return line === null || !line.checkVisibility() ? null : (line.textContent ?? '');
    },
    null,
  );
}

/** Waits until the window can end S1 (the header offers Restart then: the row is endable). */
async function endable(page: Page): Promise<void> {
  await page.waitForSelector('#cards .header-restart', { state: 'visible', timeout: 20_000 });
}

test("issue #199: the session's end and its restart on the page", async (t) => {
  const chromium = await browser(t);

  await t.test(
    'A5: the dialogs say that ending the session ends its shell; End session and park from the header with the panel shown: the panel and the dot go with the closed terminal, the keyboard stays in the terminal zone, on what is visible there',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      await endable(page);
      await toZone(page, 'list');
      await page.keyboard.press('d');
      assert.equal(await dialogShellLine(page), SHELL_LINE, 'the dialog "Mark done" says it');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#end-dialog[hidden]', { state: 'attached' });
      await page.keyboard.press('w');
      assert.equal(await dialogShellLine(page), SHELL_LINE, 'the dialog "Park" says it');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#end-dialog[hidden]', { state: 'attached' });
      await toZone(page, 'terminal');
      await clickIn(page, '#shell');
      await untilKeyboard(page, 'shell');

      const program = shellProgramOf(l);
      await page.locator('#cards .header-park').click();
      assert.equal(await dialogShellLine(page), SHELL_LINE);
      await page.locator('#end-dialog:not([hidden]) .end-end').click();

      // The end closes the session's terminal (S2 12.15): the pane is the parked session's card.
      await shellGone(l, program);
      await until(
        () =>
          readPage(page, () => document.getElementById('right-zone')?.dataset['pane'], null).then(
            (pane) => pane !== 'terminal',
          ),
        'the terminal closed',
      );
      await until(
        () =>
          readPage(
            page,
            () => {
              const at = document.activeElement;
              return (
                at instanceof HTMLElement &&
                at.checkVisibility() &&
                document.getElementById('right-zone')?.contains(at) === true &&
                document.getElementById('shell')?.contains(at) === false
              );
            },
            null,
          ),
        'the keyboard in the terminal zone, on what is visible there',
      );
      assert.equal(await shownText(page, '#focus-zone'), 'Focus: terminal');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'A5: `/exit` typed into the session with the panel shown: the panel and the dot go, the ended bar over the whole area, the keyboard stays in the session’s terminal',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      await clickIn(page, '#terminal');
      await untilKeyboard(page, 'terminal');
      const shell = shellProgramOf(l);

      await page.keyboard.type('/exit');
      await page.keyboard.press('Enter');

      await endedWithoutShell(l, shell);
      await untilKeyboard(page, 'terminal');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'A5: the session’s program killed with the keyboard in the shell: the panel and the dot go, the ended bar over the whole area, the keyboard in the session’s terminal',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      const program = l.server.hub.list().find((one) => one.id === l.term)?.program;
      assert.ok(program !== null && program !== undefined);
      const shell = shellProgramOf(l);

      process.kill(program.pid, 'SIGKILL');

      await endedWithoutShell(l, shell);
      await untilKeyboard(page, 'terminal');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'A6: `r` with the panel shown: the panel stays, under the new terminal, the same shell and process with its screen; Restart from the header with the panel hidden: the dot stays; the dialog "Restart" says nothing of the shell',
    async (t) => {
      const l = await withShell(t, chromium);
      const { page } = l;
      await typedInShell(page, 'echo "marker-$$"', /^marker-\d+$/m);
      const [before] = l.server.hub.shells?.() ?? [];
      assert.ok(before?.program !== null && before?.program !== undefined);
      await endable(page);

      await toZone(page, 'list');
      await page.keyboard.press('r');
      await page.waitForSelector('#restart-dialog:not([hidden])', { state: 'attached' });
      const words = await page.locator('#restart-dialog').innerText();
      assert.doesNotMatch(words, /shell/i, 'a restart keeps the shell: the dialog says nothing');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');

      const paneTerm = (): Promise<string> =>
        readPage(
          page,
          () => document.getElementById('right-zone')?.dataset['paneTerm'] ?? '',
          null,
        );
      await until(async () => {
        const now = await paneTerm();
        return now !== '' && now !== l.term;
      }, 'the new terminal shown');
      const second = await paneTerm();
      await untilScreen(page, promptOf(S1));
      await untilPanel(page, true);
      assert.equal((await panel(page)).under, true);
      await untilScreen(
        page,
        new RegExp(`^marker-${before.program.pid}$`, 'm'),
        undefined,
        '#shell',
      );
      const moved = l.server.hub.shells?.() ?? [];
      assert.deepEqual(
        moved.map((one) => [one.id, one.of, one.program?.pid]),
        [[before.id, second, before.program.pid]],
        'the same shell and process, under the new terminal',
      );

      // Hidden, then Restart from the header: the dot stays, the panel stays hidden.
      await page.keyboard.press('Control+Shift+S');
      await untilKeyboard(page, 'shell');
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, false);
      await endable(page);
      await page.locator('#cards .header-restart').click();
      await page.waitForSelector('#restart-dialog:not([hidden])', { state: 'attached' });
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await until(async () => {
        const now = await paneTerm();
        return now !== '' && now !== second;
      }, 'the third terminal shown');
      await untilScreen(page, promptOf(S1));
      await until(async () => await dot(page), 'the dot stays');
      assert.equal((await panel(page)).shown, false, 'still hidden');
      const third = await paneTerm();
      assert.deepEqual(
        (l.server.hub.shells?.() ?? []).map((one) => [one.id, one.of, one.program?.pid]),
        [[before.id, third, before.program.pid]],
      );
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilScreen(
        page,
        new RegExp(`^marker-${before.program.pid}$`, 'm'),
        undefined,
        '#shell',
      );
      assert.deepEqual(l.problems, []);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Milestone 2's review: what the page does with the keyboard, the views and the streams

const SHELL_A = 'a1a1a1a1a1a1'; // S1's shell, under TERM_A
const SHELL_C = 'c3c3c3c3c3c3'; // S2's shell, under TERM_C
const SHELL_E = 'e5e5e5e5e5e5'; // a second shell of S1, after the first one ended

/**
 * A scripted world: S1 running in TERM_A (slot 1), S2 in TERM_C (slot 2); `shells` are the list's
 * shells (changed by `set`, which sends the list); acts are only recorded (the test answers).
 */
async function scriptedWorld(
  t: TestContext,
  chromium: Browser,
  shells: { id: string; of: string }[] = [],
): Promise<{
  page: Page;
  w: Awaited<ReturnType<typeof editWorld>>;
  set(next: { id: string; of: string }[]): void;
}> {
  const page = await newPage(t, chromium);
  // Room for both: in an area too low for both the shell takes the whole area, and the keyboard.
  await page.setViewportSize({ width: 1280, height: 900 });
  let now = shells;
  const listNow = (): Record<string, unknown> =>
    scriptedList(
      [
        { id: S1, terminal: TERM_A, slot: 1 },
        { id: S2, terminal: TERM_C, slot: 2 },
      ],
      [
        { id: TERM_A, slot: 1, sessionId: S1 },
        { id: TERM_C, slot: 2, sessionId: S2 },
      ],
      null,
      now,
    );
  const w = await editWorld(t, page, () => listNow());
  return {
    page,
    w,
    set(next) {
      now = next;
      w.list(() => listNow());
    },
  };
}

/** How many terminal boxes the shells' view holds (shown or not). */
async function shellBoxes(page: Page): Promise<number> {
  return readPage(page, () => document.querySelectorAll('#shell .tv-term').length, null);
}

const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("issue #199: the keyboard where the user put it, a held key, a shell that is gone, and the shells' streams", async (t) => {
  const chromium = await browser(t);

  await t.test(
    'a held Ctrl+Shift+S acts once: its auto-repeats do not show the panel again',
    async (t) => {
      const { page } = await scriptedWorld(t, chromium, [{ id: SHELL_A, of: TERM_A }]);
      await clickRow(page, S1);
      await page.keyboard.press('Control+Shift+S'); // shown, the keyboard in the shell
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');

      // Ctrl+Shift+S held: its first keydown, then three auto-repeats, then its keyup (CDP, as the
      // held keys of the restart dialog's test are sent; modifiers 2 | 8: Ctrl and Shift).
      const cdp = await page.context().newCDPSession(page);
      const key = { key: 'S', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 10 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }); // hides
      for (let n = 0; n < 3; n++) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, autoRepeat: true });
      }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });

      await settle();
      assert.equal((await panel(page)).shown, false, 'hidden once, not shown again');
    },
  );

  await t.test(
    'a shell this page hid that then ends leaves the view: its terminal detached, no box left, and a second shell of the session makes one box, not two',
    async (t) => {
      const { page, w, set } = await scriptedWorld(t, chromium, [{ id: SHELL_A, of: TERM_A }]);
      await clickRow(page, S1);
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, false);
      assert.equal(await shellBoxes(page), 1, 'hidden: still attached');
      const before = w.sent.length;

      set([]); // its exit
      await until(
        () => w.sent.slice(before).some((one) => one['t'] === 'detach' && one['term'] === SHELL_A),
        'its terminal detached',
      );
      assert.equal(await shellBoxes(page), 0);

      set([{ id: SHELL_E, of: TERM_A }]);
      await settle();
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      assert.equal(await shellBoxes(page), 1, 'one box');
    },
  );

  await t.test(
    'the shell an act asked for takes the keyboard only while the keyboard is where it was at the press: moved to the session meanwhile, it stays there',
    async (t) => {
      const { page, w, set } = await scriptedWorld(t, chromium);
      await clickRow(page, S1);
      await toZone(page, 'list');
      await untilKeyboard(page, 'list');
      await page.keyboard.press('Control+Shift+S'); // from the list
      const asked = await w.act(1);
      assert.deepEqual([asked['kind'], asked['term']], ['shell', TERM_A]);
      await clickIn(page, '#terminal'); // the user goes on in Claude Code's terminal
      await untilKeyboard(page, 'terminal');

      set([{ id: SHELL_A, of: TERM_A }]);
      await untilPanel(page, true);
      await settle();
      assert.equal(await keyboard(page), 'terminal', 'the keyboard stays where the user put it');
      w.answer(asked, { ok: true });
    },
  );

  await t.test(
    'the shell an act asked for takes no keyboard while text of the page is selected when the list brings it: the keyboard and the selection stay',
    async (t) => {
      const { page, w, set } = await scriptedWorld(t, chromium);
      await clickRow(page, S1);
      await toZone(page, 'list');
      await untilKeyboard(page, 'list');
      await page.keyboard.press('Control+Shift+S');
      const asked = await w.act(1);
      // Text of the header selected (a drag over it, as a user selects it to copy).
      const selected = await page.evaluate(() => {
        const title = document.querySelector('#cards .card-header');
        const walker = document.createTreeWalker(title ?? document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node !== null && (node.textContent ?? '').trim() === '') node = walker.nextNode();
        if (node === null) return '';
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return selection?.toString() ?? '';
      });
      assert.ok(selected.length > 0, 'text of the header is selected');
      assert.equal(await keyboard(page), 'list');

      set([{ id: SHELL_A, of: TERM_A }]);
      await untilPanel(page, true);
      await settle();
      assert.equal(await keyboard(page), 'list', 'the keyboard stays in the list');
      assert.equal(
        await page.evaluate(() => getSelection()?.toString() ?? ''),
        selected,
        'the selection stays',
      );
      w.answer(asked, { ok: true });
    },
  );

  await t.test(
    'a dialog opened while the act waits keeps the keyboard when the list brings the shell',
    async (t) => {
      const { page, w, set } = await scriptedWorld(t, chromium);
      await clickRow(page, S1);
      await toZone(page, 'list');
      await untilKeyboard(page, 'list');
      await page.keyboard.press('Control+Shift+S');
      const asked = await w.act(1);
      await page.keyboard.press('l'); // the label dialog, from the list
      await page.waitForFunction(
        () => document.getElementById('editor')?.contains(document.activeElement) === true,
        null,
        { timeout: 20_000 },
      );

      set([{ id: SHELL_A, of: TERM_A }]);
      await settle(800);
      assert.equal(
        await readPage(
          page,
          () => document.getElementById('editor')?.contains(document.activeElement) === true,
          null,
        ),
        true,
        'the dialog keeps the keyboard',
      );
      w.answer(asked, { ok: true });
    },
  );

  await t.test(
    "the asked shell takes no keyboard once another session is the pane's, also with that one's shell shown; a hidden window keeps only the shown shell attached; a shell's notice is shown in its view",
    async (t) => {
      const { page, w, set } = await scriptedWorld(t, chromium, [{ id: SHELL_C, of: TERM_C }]);
      // S2's shell shown, then the keyboard back in the list.
      await clickRow(page, S2);
      await page.keyboard.press('Control+Shift+S');
      await untilPanel(page, true);
      await untilKeyboard(page, 'shell');
      await page.keyboard.press('Control+Shift+L');
      await untilKeyboard(page, 'list');
      // S1 selected, its shell asked for from the list, then S2 selected again (the keyboard in
      // the list all the while): the list that brings S1's shell gives it no keyboard.
      await page.keyboard.press('k');
      await until(async () => (await shownTerm(page)) === TERM_A, "S1's terminal shown");
      await page.keyboard.press('Control+Shift+S');
      const asked = await w.act(1);
      await page.keyboard.press('j');
      await until(async () => (await shownTerm(page)) === TERM_C, "S2's terminal shown");
      await untilPanel(page, true); // S2's own shell

      set([
        { id: SHELL_C, of: TERM_C },
        { id: SHELL_A, of: TERM_A },
      ]);
      await settle(800);
      assert.equal(await keyboard(page), 'list', 'no keyboard to the other session’s shell');
      w.answer(asked, { ok: true });

      // Both shells attached (S1's shown once), S2's shown: the window hidden keeps S2's only.
      await page.keyboard.press('k');
      await untilPanel(page, true);
      await page.keyboard.press('j');
      await until(async () => (await shownTerm(page)) === TERM_C, "S2's terminal shown again");
      await untilPanel(page, true);
      assert.equal(await shellBoxes(page), 2);
      const before = w.sent.length;
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await until(
        () => w.sent.slice(before).some((one) => one['t'] === 'detach' && one['term'] === SHELL_A),
        "the hidden shell's terminal detached",
      );
      assert.ok(
        !w.sent.slice(before).some((one) => one['t'] === 'detach' && one['term'] === SHELL_C),
        'the shown one stays',
      );
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // A notice of the shown shell (its input refused): on the shell's terminal.
      w.send({ t: 'notice', kind: 'input-full', term: SHELL_C, text: 'input full' });
      await page.waitForSelector('#shell .tv-bar[data-kind="input-full"]', {
        state: 'visible',
        timeout: 20_000,
      });
    },
  );

  await t.test(
    "a shell another window resized is drawn at that window's size here, with the hint that another window sizes it",
    async (t) => {
      const l = await withShell(t, chromium);
      const [id] = shellsOf(l);
      assert.ok(id !== undefined);
      const other = await connectTestPage(t, l.d, l.server);
      other.send({ t: 'attach', term: id, cols: 60, rows: 7 });
      await other.next('snap', 'the other page’s snap');
      other.send({ t: 'input', term: id, data: ' ' }); // it types: it owns the size
      other.send({ t: 'resize', term: id, cols: 60, rows: 7 });

      await until(
        async () =>
          (await readPage(
            l.page,
            () =>
              document.querySelectorAll('#shell .tv-term:not([hidden]) .xterm-rows > div').length,
            null,
          )) === 7,
        'seven rows here',
      );
      await l.page.waitForSelector('#shell .tv-term:not([hidden]) .tv-hint', {
        state: 'visible',
        timeout: 20_000,
      });
    },
  );
});
