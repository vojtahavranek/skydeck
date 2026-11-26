// A session's shell on the page (issue #199, S2 12.6, 12.9): the page's second terminal view, in
// `#shell` under `#terminal`. The view's own members for it (each view keeps its own terminals
// and ignores another's terminal and channel; `reset`, `drop`, `heightFor`), and the page with a
// list that carries `shells`: nothing is drawn and nothing attached until the page shows a shell.
// The key (step 2.4), with real keys against a real test server whose shell is the stand-in shell:
// Ctrl+Shift+S in either zone and `s` in the list open one shell under the session's terminal with
// the keyboard in it; the refusals' toasts; the key again hides and shows it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { S1, S2 } from '../test/helpers/platform.ts';
import { SHELL_PROMPT } from '../test/helpers/shell-standin.ts';
import { startTestServer } from '../test/helpers/window.ts';
import { SHELL_TEXTS } from '../web/shell-panel-text.js';
import { browser, newPage } from './helpers/browser.ts';
import {
  after,
  assetBase,
  clickRow,
  editWorld,
  launched,
  logOf,
  mark,
  pageUrl,
  readPage,
  scriptedList,
  showsText,
  TERM_A,
  TERM_B,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import { promptOf, resumeHere, untilScreen, until } from './helpers/terminal.ts';
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
    ['s in the list', 'list', 's'],
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
        await l.page.keyboard.press('s');
        await untilPanel(l.page, true);
        assert.equal(shellsOf(l).length, 1, 'never a second shell');
        assert.deepEqual(l.problems, []);
      },
    );
  }

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
        return { platform: (p) => ({ ...p, loginShell: quick }) };
      });

      await l.page.keyboard.press('Control+Shift+S');

      await showsText(l.page, '#toast', /^Shell: the shell ended at once \(status 3\)/);
      assert.equal((await panel(l.page)).shown, false);
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
    },
  );
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
