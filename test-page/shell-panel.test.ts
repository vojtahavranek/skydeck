// A session's shell on the page (issue #199, S2 12.6): the page's second terminal view, in
// `#shell` under `#terminal`. The view's own members for it (each view keeps its own terminals
// and ignores another's terminal and channel; `reset`, `drop`, `heightFor`), and the page with a
// list that carries `shells`: nothing is drawn and nothing attached until the page shows a shell.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { S1 } from '../test/helpers/platform.ts';
import { startTestServer } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  assetBase,
  editWorld,
  pageUrl,
  readPage,
  scriptedList,
  TERM_A,
  TERM_B,
} from './helpers/shell.ts';
import { until } from './helpers/terminal.ts';

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
