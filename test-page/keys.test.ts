// Keys in the terminal view (plan task 28; S2 9.1, 12.9, 17.4): what reaches the program, as the
// stand-in in a real test server's terminal records it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1 } from '../test/helpers/platform.ts';
import { browser } from './helpers/browser.ts';
import type { Logged } from './helpers/shell.ts';
import {
  PAGE_WAIT_MS,
  after,
  connection,
  launched,
  logOf,
  mark,
  pageUrl,
} from './helpers/shell.ts';
import {
  hexOf,
  inputOf,
  promptOf,
  recordsOf,
  resumeHere,
  until,
  untilScreen,
  untilTerminalOf,
} from './helpers/terminal.ts';

/** S2 9.1: a bracketed paste, as xterm.js sends it while the program has mode 2004 on. */
function bracketed(text: string): string {
  return hexOf(`\x1b[200~${text}\x1b[201~`);
}

/** Whether `log` (after a key) reloaded only after a new socket's welcome (as the shell's test). */
function reloadedAfterProof(log: Logged[]): boolean {
  const unload = log.findIndex((entry) => entry.e === 'unload');
  if (unload === -1) return false;
  const before = log.slice(0, unload);
  const fresh = before.filter((entry) => entry.e === 'ws').map((entry) => entry.s);
  return before.some(
    (entry) => entry.e === 'in' && entry.t === 'welcome' && fresh.includes(entry.s),
  );
}

/** The input the stand-in of S1 read after `before` hex characters of it. */
function inputSince(record: string, before: number): string {
  return inputOf(record, S1).slice(before);
}

/** Puts `text` on the page's clipboard (the context may read and write it). */
async function clipboard(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
}

test('keys in the terminal view', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'Shift+Enter → 0a; Ctrl+Shift+V → 16; Ctrl+V with text on the clipboard → a bracketed paste and never 16; Ctrl+Shift+P → nothing, the switcher shown; Esc → nothing, the switcher hidden',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: `http://127.0.0.1:${l.server.port}`,
      });
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const press = async (key: string, expected: string): Promise<void> => {
        const before = inputOf(d.record, S1).length;
        await page.keyboard.press(key);
        if (expected === '') {
          await sleep(800);
          assert.equal(inputSince(d.record, before), '', `${key} sends nothing`);
          return;
        }
        await until(() => inputSince(d.record, before).length >= expected.length, `${key}`);
        assert.equal(inputSince(d.record, before), expected, key);
      };

      await press('Shift+Enter', '0a');
      await press('Control+Shift+V', '16');
      await clipboard(page, 'pasted text');
      await press('Control+V', bracketed('pasted text'));
      // Stage E (plan E task 98): Ctrl+Shift+P opens the switcher and sends the program nothing;
      // Esc closes it, and that Esc is the switcher's, not the program's.
      await press('Control+Shift+P', '');
      await page.waitForSelector('#switcher:not([hidden])', { state: 'attached' });
      await press('Escape', '');
      await page.waitForSelector('#switcher[hidden]', { state: 'attached' });
      // One raw Ctrl+V in all of it: Ctrl+Shift+V's (Ctrl+V pasted, and no key was sent twice).
      const bytes = Buffer.from(inputOf(d.record, S1), 'hex');
      assert.equal(bytes.filter((byte) => byte === 0x16).length, 1);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test('a paste of 2 MiB arrives whole, in input messages of at most 64 KiB', async (t) => {
    const l = await launched(t, chromium);
    const { page, d } = l;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: `http://127.0.0.1:${l.server.port}`,
    });
    d.resumable(S1);
    await resumeHere(page, S1);
    await untilScreen(page, promptOf(S1));
    // The sizes of the input messages the page sends (under the recorder's WebSocket).
    await page.evaluate(() => {
      const sizes: number[] = [];
      Reflect.set(globalThis, 'inputSizes', sizes);
      const proto = Object.getPrototypeOf(WebSocket.prototype) as WebSocket;
      const send = proto.send;
      proto.send = function (this: WebSocket, data) {
        if (typeof data === 'string') {
          const message = JSON.parse(data) as { t?: string; data?: string };
          if (message.t === 'input' && typeof message.data === 'string') {
            sizes.push(new TextEncoder().encode(message.data).length);
          }
        }
        send.call(this, data);
      };
    });
    const text = Array.from({ length: 2 * 1024 * 16 }, (_, i) =>
      `${String(i).padStart(7, '0')} ${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-+'.slice(0, 55)}`.padEnd(
        64,
        '.',
      ),
    ).join('');
    assert.equal(text.length, 2 * 1024 * 1024);
    await clipboard(page, text);
    const before = inputOf(d.record, S1).length;
    await page.keyboard.press('Control+V');
    const expected = bracketed(text);
    await until(
      () => inputSince(d.record, before).length >= expected.length,
      'the whole paste read by the program',
      60_000,
    );
    assert.ok(inputSince(d.record, before) === expected, 'the paste arrives whole and in order');
    const sizes = await page.evaluate(() => Reflect.get(globalThis, 'inputSizes') as number[]);
    assert.ok(sizes.length >= 32, `${sizes.length} messages`);
    assert.ok(
      sizes.every((size) => size <= 64 * 1024),
      `at most 64 KiB each: ${Math.max(...sizes)}`,
    );
    assert.equal(
      sizes.reduce((sum, size) => sum + size, 0),
      expected.length / 2,
    );
    // xterm.js does not cancel a paste: the page does, so that the pasted text does not stay in
    // xterm.js's hidden textarea (megabytes there make the page slow at everything after).
    assert.equal(
      await page.evaluate(
        () =>
          (document.querySelector('#terminal .xterm-helper-textarea') as HTMLTextAreaElement).value
            .length,
      ),
      0,
      'nothing of the paste is left in the textarea',
    );
    assert.deepEqual(l.problems, [], 'the page reports no problem');
  });

  await t.test(
    'F5, Ctrl+R, Shift+F5 and Ctrl+F5: with the terminal holding the keyboard they reach the program; with the find bar holding it they reload, after the server’s proof',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const keys: [string, string][] = [
        ['F5', '1b5b31357e'],
        ['Control+r', '12'],
        ['Shift+F5', '1b5b31353b327e'],
        ['Control+F5', '1b5b31353b357e'],
      ];
      for (const [key, sent] of keys) {
        const before = inputOf(d.record, S1).length;
        await mark(page, `terminal ${key}`);
        await page.keyboard.press(key);
        await until(() => inputSince(d.record, before).length >= sent.length, key);
        assert.equal(inputSince(d.record, before), sent, `${key} reaches the program`);
        await sleep(300);
        assert.ok(
          !after(await logOf(page), `terminal ${key}`).some((entry) => entry.e === 'unload'),
          `${key} does not reload while xterm.js has the keyboard`,
        );
      }
      for (const [key] of keys) {
        await connection(page, 'open');
        await untilTerminalOf(page, S1);
        await page.keyboard.press('Control+Shift+F');
        await page.waitForFunction(
          () => document.activeElement?.classList.contains('tv-find-input') === true,
          null,
          { timeout: PAGE_WAIT_MS },
        );
        const before = inputOf(d.record, S1).length;
        await mark(page, `find ${key}`);
        await page.keyboard.press(key);
        await until(
          async () => after(await logOf(page), `find ${key}`).some((e) => e.e === 'unload'),
          `${key} reloads`,
        );
        await page.waitForLoadState('load');
        assert.ok(
          reloadedAfterProof(after(await logOf(page), `find ${key}`)),
          `${key}: after the proof`,
        );
        assert.equal(inputSince(d.record, before), '', `${key} reached no program`);
      }
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'typing makes the page the size owner: the other window shows "sized by another window", and the size follows the page that typed',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const other = await page.context().newPage();
      await other.setViewportSize({ width: 900, height: 500 });
      await other.goto(pageUrl(l.server.port));
      await connection(other, 'open');
      await untilTerminalOf(other, S1);
      const hint = (p: Page): Promise<boolean> =>
        p.evaluate(() => {
          const shown = document.querySelector('#terminal .tv-term:not([hidden]) .tv-hint');
          return shown instanceof HTMLElement && !shown.hidden;
        });
      const rowsOf = (p: Page): Promise<number> =>
        p.evaluate(
          () =>
            document.querySelectorAll('#terminal .tv-term:not([hidden]) .xterm-rows > div').length,
        );
      await until(() => hint(other), 'the second window says the size is another window’s');
      assert.equal(await hint(page), false, 'the first window owns the size');
      assert.equal(await rowsOf(other), await rowsOf(page), 'at the owner’s size');
      const firstRows = await rowsOf(page);

      const resizes = (): number =>
        recordsOf(d.record, S1).filter((entry) => entry.ev === 'resize').length;
      const before = resizes();
      await other.keyboard.type('a');
      await until(async () => !(await hint(other)), 'the typing window owns the size');
      await until(() => hint(page), 'the first window now says another window sizes it');
      await until(() => resizes() > before, 'the program resized');
      // The owner's size settles (its layout may still send one more proposal).
      let quiet = resizes();
      let since = performance.now();
      await until(() => {
        if (resizes() !== quiet) [quiet, since] = [resizes(), performance.now()];
        return performance.now() - since >= 1500;
      }, 'the sizes settle');
      const last = recordsOf(d.record, S1)
        .filter((entry) => entry.ev === 'resize')
        .at(-1);
      assert.ok(last !== undefined && last.ev === 'resize');
      assert.notEqual(last.rows, firstRows, 'the size of the window that typed');
      await until(async () => (await rowsOf(other)) === last.rows, 'the second window at its size');
      await until(async () => (await rowsOf(page)) === last.rows, 'the first one at the new size');

      // Sizes come from the server only: the window that does not own the size is made smaller,
      // its terminal stays at the owner's size (its proposal is only remembered).
      const ownerRows = await rowsOf(other);
      const resized = resizes();
      await page.setViewportSize({ width: 1000, height: 420 });
      await sleep(1500);
      assert.equal(await rowsOf(page), ownerRows, 'still the owner’s size');
      assert.equal(await rowsOf(other), ownerRows);
      assert.equal(resizes(), resized, 'the program was not resized');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );

  await t.test(
    'a paste that holds ESC [ 2 0 1 ~ cannot end its own bracketed paste: the program reads one paste, the end marker once, at its end',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: `http://127.0.0.1:${l.server.port}`,
      });
      d.resumable(S1);
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await clipboard(page, 'harmless \x1b[201~ /red NOT-PASTED\r');
      const before = inputOf(d.record, S1).length;
      await page.keyboard.press('Control+V');
      const expected = bracketed('harmless [201~ /red NOT-PASTED\r');
      await until(() => inputSince(d.record, before).length >= expected.length, 'the paste read');
      await sleep(300);
      assert.equal(inputSince(d.record, before), expected, 'one paste, its ESC taken out');
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );
});
