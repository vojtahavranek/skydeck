// Follow-up F37 (S2 12.9): moving the selected session of Open by key on the page — Shift+↑ and
// Shift+K up, Shift+↓ and Shift+J down — sends `act reorder` for the selected session; a refusal's
// line shows in the key bar; the selection, the zone and the keyboard stay; one act at a time; a
// `view` after an ok; the moved row scrolled into view. Against a scripted stand-in server
// (`editWorld`), and once against a real test server: after a move the slot chord reaches the row
// that shows that number.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  clickRow,
  editWorld,
  keyMessage,
  launched,
  PAGE_WAIT_MS,
  scriptedList,
  selectedRow,
  TERM_A,
  TERM_B,
  TERM_C,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { EditWorld } from './helpers/shell.ts';
import { resumeHere } from './helpers/terminal.ts';

/** Open's rows in this order, each in its terminal, numbered 1, 2, … top to bottom. */
function openList(ids: readonly string[], terms: Record<string, string>): Record<string, unknown> {
  return scriptedList(
    ids.map((id, at) => ({ id, terminal: terms[id] ?? null, slot: at + 1 })),
    ids.map((id, at) => ({ id: terms[id] ?? '', slot: at + 1, sessionId: id })),
  );
}

const TERMS = { [S1]: TERM_A, [S2]: TERM_B, [S3]: TERM_C };

async function world(t: TestContext, chromium: Browser): Promise<{ page: Page; w: EditWorld }> {
  const page = await newPage(t, chromium);
  const w = await editWorld(t, page, openList([S1, S2, S3], TERMS));
  return { page, w };
}

/** The acts of `w` from the `from`-th on, without `t` and `id`. */
function actsFrom(w: EditWorld, from: number): Record<string, unknown>[] {
  return w
    .acts()
    .slice(from)
    .map(({ t: _t, id: _id, ...rest }) => rest);
}

/** The views the page sent so far. */
function views(w: EditWorld): number {
  return w.sent.filter((message) => message['t'] === 'view').length;
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, what);
    await sleep(25);
  }
}

/** The session ids of the list's rows, top to bottom. */
async function drawnOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#list [data-id]')].map(
      (one) => one.getAttribute('data-id') ?? '',
    ),
  );
}

test('F37: moving a session of Open by key', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'each of the four keys sends act reorder for the selected session; after ok a view; the selection and the zone stay',
    async (t) => {
      const { page, w } = await world(t, chromium);
      await clickRow(page, S2);
      await toZone(page, 'list');
      const cases: [string, 'up' | 'down'][] = [
        ['Shift+ArrowUp', 'up'],
        ['Shift+K', 'up'],
        ['Shift+ArrowDown', 'down'],
        ['Shift+J', 'down'],
      ];
      for (const [n, [key, direction]] of cases.entries()) {
        await page.keyboard.press(key);
        const sent = await w.act(n + 1);
        assert.deepEqual(actsFrom(w, n), [{ kind: 'reorder', sessionId: S2, direction }], key);
        const before = views(w);
        w.answer(sent, { ok: true });
        await until(() => views(w) > before, `${key}: a view after the ok`);
        assert.equal(await selectedRow(page), S2, key);
        assert.equal(await zone(page), 'Focus: list', key);
      }
      assert.equal(await keyMessage(page), '');
    },
  );

  await t.test('a refusal: its line in the key bar, nothing else changes', async (t) => {
    const { page, w } = await world(t, chromium);
    await clickRow(page, S1);
    await toZone(page, 'list');
    const before = views(w);
    await page.keyboard.press('Shift+ArrowUp');
    w.answer(await w.act(1), { ok: false, error: 'already at the top of Open' });
    await until(
      async () => (await keyMessage(page)) === 'already at the top of Open',
      'the refusal in the key bar',
    );
    assert.equal(await selectedRow(page), S1);
    assert.equal(await zone(page), 'Focus: list');
    assert.deepEqual(await drawnOrder(page), [S1, S2, S3]);
    await sleep(300);
    assert.equal(views(w), before, 'no view after a refusal');
  });

  await t.test(
    'a press while the act waits sends nothing; after its answer the next one is sent',
    async (t) => {
      const { page, w } = await world(t, chromium);
      await clickRow(page, S3);
      await toZone(page, 'list');
      await page.keyboard.press('Shift+ArrowUp');
      const first = await w.act(1);
      await page.keyboard.press('Shift+ArrowUp');
      await page.keyboard.press('Shift+K');
      await sleep(300);
      assert.equal(w.acts().length, 1, 'one act at a time');
      w.answer(first, { ok: true });
      w.list(openList([S1, S3, S2], TERMS));
      await until(async () => (await drawnOrder(page))[1] === S3, 'the new order drawn');
      await page.keyboard.press('Shift+ArrowUp');
      await w.act(2);
      assert.deepEqual(actsFrom(w, 1), [{ kind: 'reorder', sessionId: S3, direction: 'up' }]);
    },
  );

  await t.test('nothing selected: `no session selected`, no act', async (t) => {
    const page = await newPage(t, chromium);
    const w = await editWorld(t, page, openList([], {}));
    await toZone(page, 'list');
    await page.keyboard.press('Shift+ArrowDown');
    await until(
      async () => (await keyMessage(page)) === 'no session selected',
      'the key bar says why',
    );
    assert.deepEqual(w.acts(), []);
  });

  await t.test('after an ok the moved row is scrolled into view', async (t) => {
    const page = await newPage(t, chromium);
    await page.setViewportSize({ width: 900, height: 360 });
    const ids = Array.from(
      { length: 9 },
      (_, n) => `${String(n + 1).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`,
    );
    const terms = Object.fromEntries(ids.map((id, n) => [id, String(n + 1).padStart(12, 'a')]));
    const w = await editWorld(t, page, openList(ids, terms));
    const last = ids[8] as string;
    await clickRow(page, last);
    await toZone(page, 'list');
    // The user scrolls the list back to its top: the selected row is out of view.
    const inView = (id: string): Promise<boolean> =>
      page.evaluate((id) => {
        const row = document.querySelector(`#list [data-id="${id}"]`) as HTMLElement;
        let box: HTMLElement | null = row.parentElement;
        while (
          box !== null &&
          !(box.scrollHeight > box.clientHeight && getComputedStyle(box).overflowY !== 'visible')
        ) {
          box = box.parentElement;
        }
        const outer = (box ?? document.documentElement).getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        return rect.top >= outer.top - 1 && rect.bottom <= outer.bottom + 1;
      }, id);
    await page.evaluate(() => {
      for (const one of document.querySelectorAll<HTMLElement>('#list, #list *')) one.scrollTop = 0;
    });
    assert.equal(await inView(last), false, 'scrolled away from the selected row');
    await page.keyboard.press('Shift+ArrowUp');
    w.answer(await w.act(1), { ok: true });
    w.list(openList([...ids.slice(0, 7), last, ids[7] as string], terms));
    await until(() => inView(last), 'the moved row in view');
    assert.equal(await selectedRow(page), last);
  });

  await t.test(
    'against a real server: after Shift+↑ the slot chords reach the rows that show their numbers',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2);
      await resumeHere(page, S1);
      await resumeHere(page, S2);
      await until(async () => {
        const order = await drawnOrder(page);
        return order.indexOf(S1) === 0 && order.indexOf(S2) === 1;
      }, 'S1 and S2 in slots 1 and 2');
      await clickRow(page, S2);
      await toZone(page, 'list');
      await page.keyboard.press('Shift+ArrowUp');
      await until(async () => (await drawnOrder(page))[0] === S2, 'S2 drawn first');
      await page.keyboard.press('Control+Shift+1');
      await until(async () => (await selectedRow(page)) === S2, 'Ctrl+Shift+1 reaches S2');
      await page.keyboard.press('Control+Shift+2');
      await until(async () => (await selectedRow(page)) === S1, 'Ctrl+Shift+2 reaches S1');
      assert.deepEqual(l.problems, []);
    },
  );
});
