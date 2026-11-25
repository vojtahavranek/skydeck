// The mark unread on the page (S2 12.4, 12.5, 12.9; E1 of its brief): `u` in the list and the
// header's `Unread` / `Read` on the selected session — a session with no mark is marked unread
// (its row's bar and line `marked unread · <age>`, counted in the title bar), `u` again marks it
// read, a session that asks or one marked done is not changed and the toast says why, a row of a
// session not started yet neither; a held `u` acts once; the toast says what was done; the key help
// holds its line. Against a real test server (real keepers running the stand-in), and for the row
// of a session not started yet against a scripted stand-in (`editWorld`). The page decides no
// rule: which rows are unread, and every refusal, are the server's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { controlClient } from '../src/window/client.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { connectTestPage, startTestServer } from '../test/helpers/window.ts';
import type { StartedServer, TestPage } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  clickRow,
  connection,
  editWorld,
  pageUrl,
  problemsOf,
  readPage,
  scriptedList,
  selectedRow,
  shownText,
  toZone,
} from './helpers/shell.ts';

const MARKED = 'Marked unread: it needs you until you come back to it.';
const READ = 'Marked read.';

/** Records each `act` the page sends — its kind and its session —, in `window.skydeckActs`. */
const ACTS = `(() => {
  const send = WebSocket.prototype.send;
  window.skydeckActs = [];
  WebSocket.prototype.send = function (data) {
    try {
      const m = JSON.parse(data);
      if (m.t === 'act') window.skydeckActs.push({ kind: m.kind, sessionId: m.sessionId ?? null });
    } catch {}
    return send.call(this, data);
  };
})();`;

interface World extends Omit<StartedServer, 'page'> {
  page: Page;
  /** A page of the test's own on the same server (no browser). */
  api: TestPage;
  problems: string[];
}

/**
 * A real test server with `stopped` sessions (resumable, not running) and `running` ones resumed
 * in window terminals, and a browser page on it, connected, with every row drawn.
 */
async function world(
  t: TestContext,
  chromium: Browser,
  options: { stopped?: string[]; running?: string[] } = {},
): Promise<World> {
  const { stopped = [], running = [] } = options;
  const page = await newPage(t, chromium);
  await page.addInitScript(ACTS);
  const problems = problemsOf(page);
  const started = await startTestServer(t);
  const { d, server } = started;
  for (const id of [...running, ...stopped]) d.resumable(id);
  const api = await connectTestPage(t, d, server);
  await api.list(
    (list) =>
      [...running, ...stopped].every((id) =>
        list.sections.some((section) => section.rows.some((row) => row.id === id)),
      ),
    'every session listed',
  );
  for (const id of running) {
    const result = await api.act({ kind: 'resume', sessionId: id, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
    await api.list(
      (list) =>
        list.sections.some((section) =>
          section.rows.some((row) => row.id === id && row.state !== 'not-running' && !row.starting),
        ),
      `${id} runs`,
    );
  }
  const { token } = await controlClient(d.platform.net, d.files.serverSock).token(30);
  await page.goto(pageUrl(server.port, token));
  await connection(page, 'open');
  for (const id of [...running, ...stopped]) await drawnRow(page, id);
  return { ...started, page, api, problems };
}

interface DrawnRow {
  attention: string | null;
  state: string;
  bold: boolean;
}

/** `sessionId`'s row as drawn: its mark, its second line, whether its title is bold. */
async function drawnRow(page: Page, sessionId: string): Promise<DrawnRow> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const row = await readPage(
      page,
      (id: string) => {
        const root = document.querySelector<HTMLElement>(`#list .list-row[data-id="${id}"]`);
        if (root === null || !root.checkVisibility()) return null;
        const state = root.querySelector<HTMLElement>('.row-state');
        const title = root.querySelector<HTMLElement>('.row-title');
        return {
          attention: root.dataset['attention'] ?? null,
          state: state?.checkVisibility() === true ? (state.textContent ?? '') : '',
          bold: title !== null && Number(getComputedStyle(title).fontWeight) >= 700,
        };
      },
      sessionId,
    );
    if (row !== null) return row;
    assert.ok(performance.now() < deadline, `${sessionId} drawn`);
    await sleep(25);
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, what);
    await sleep(25);
  }
}

/** What the toast shows: its text and whether it has an Undo ('' and false when hidden). */
async function toast(page: Page): Promise<{ text: string; undo: boolean }> {
  return readPage(
    page,
    () => {
      const root = document.getElementById('toast') as HTMLElement;
      if (root.hidden) return { text: '', undo: false };
      const undo = root.querySelector<HTMLElement>('.toast-undo');
      return {
        text: root.querySelector('.toast-text')?.textContent ?? '',
        undo: undo !== null && !undo.hidden && undo.checkVisibility(),
      };
    },
    null,
  );
}

/** Waits until the toast says `text` (with no Undo). */
async function toastSays(page: Page, text: string): Promise<void> {
  await until(async () => (await toast(page)).text === text, `the toast says ${text}`);
  assert.equal((await toast(page)).undo, false, 'no Undo: u again is its undo');
}

async function acts(page: Page): Promise<{ kind: string; sessionId: string | null }[]> {
  return readPage(
    page,
    () => Reflect.get(window, 'skydeckActs') as { kind: string; sessionId: string | null }[],
    null,
  );
}

/** The header's Unread / Read button: its text and its tooltip. */
async function headerUnread(page: Page): Promise<{ text: string; tip: string }> {
  return {
    text: await shownText(page, '#cards .header-unread'),
    tip: await readPage(
      page,
      () => document.querySelector<HTMLElement>('#cards .header-unread')?.title ?? '',
      null,
    ),
  };
}

/** The title bar's count of those that need you ('' when none). */
async function needYou(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const count = document.querySelector<HTMLElement>('.counts .count[data-state="need-you"]');
      return count !== null && count.checkVisibility() ? (count.textContent ?? '') : '';
    },
    null,
  );
}

/** Selects `sessionId`'s row with a click and gives the list the keyboard. */
async function pick(page: Page, sessionId: string): Promise<void> {
  await clickRow(page, sessionId);
  await toZone(page, 'list');
}

async function untilRow(
  page: Page,
  sessionId: string,
  check: (row: DrawnRow) => boolean,
  what: string,
): Promise<DrawnRow> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const row = await drawnRow(page, sessionId);
    if (check(row)) return row;
    assert.ok(performance.now() < deadline, `${what}: ${JSON.stringify(row)}`);
    await sleep(25);
  }
}

test('the mark unread in the window (S2 12.4)', async (t) => {
  const chromium = await browser(t);

  await t.test('the key help (Ctrl+Shift+H) holds the line for u', async (t) => {
    const w = await world(t, chromium, { stopped: [S1] });
    await pick(w.page, S1);
    await w.page.keyboard.press('Control+Shift+H');
    await until(
      async () =>
        (await shownText(w.page, '#help')).includes(
          'unread: the session needs you again until you come back to it (select it again, or type into it); on one marked unread, finished or ended, mark it read',
        ),
      'the help names u',
    );
    assert.deepEqual(w.problems, []);
  });

  await t.test(
    'u marks the selected session unread: its bar, its bold title and `marked unread · <age>`, counted; the toast; the header says Read; u again marks it read; the header does both; the selection stays',
    async (t) => {
      const w = await world(t, chromium, { stopped: [S1, S2] });
      await pick(w.page, S1);
      assert.deepEqual(await headerUnread(w.page), {
        text: 'Unread',
        tip: 'mark it unread: it needs you until you come back to it (u)',
      });

      await w.page.keyboard.press('u');
      const marked = await untilRow(w.page, S1, (row) => row.attention === 'unread', 'marked');
      assert.match(marked.state, /^marked unread · \d+s$/);
      assert.equal(marked.bold, true);
      await toastSays(w.page, MARKED);
      await until(async () => (await needYou(w.page)) === '1 needs you', 'counted');
      await until(async () => (await headerUnread(w.page)).text === 'Read', 'the header: Read');
      assert.equal((await headerUnread(w.page)).tip, 'mark it read (u)');
      assert.equal(await selectedRow(w.page), S1, 'the selection stays');
      assert.equal(await w.page.title(), '(1) skydeck');

      await w.page.keyboard.press('u');
      await untilRow(w.page, S1, (row) => row.attention === null, 'read');
      await toastSays(w.page, READ);
      await until(async () => (await needYou(w.page)) === '', 'no longer counted');
      await until(async () => (await headerUnread(w.page)).text === 'Unread', 'Unread again');

      // The header's control, the same both ways.
      await w.page.locator('#cards .header-unread').click();
      await untilRow(w.page, S1, (row) => row.attention === 'unread', 'marked by the header');
      await toastSays(w.page, MARKED);
      await until(async () => (await headerUnread(w.page)).text === 'Read', 'Read');
      await w.page.locator('#cards .header-unread').click();
      await untilRow(w.page, S1, (row) => row.attention === null, 'read by the header');
      await toastSays(w.page, READ);
      assert.equal(await selectedRow(w.page), S1);
      assert.deepEqual(await acts(w.page), [
        { kind: 'unread', sessionId: S1 },
        { kind: 'read', sessionId: S1 },
        { kind: 'unread', sessionId: S1 },
        { kind: 'read', sessionId: S1 },
      ]);
      assert.equal((await drawnRow(w.page, S2)).attention, null, 'the other row is as it was');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test('a held u acts once', async (t) => {
    const w = await world(t, chromium, { stopped: [S1] });
    await pick(w.page, S1);
    await w.page.keyboard.down('u');
    await w.page.keyboard.down('u'); // an auto-repeat
    await w.page.keyboard.down('u');
    await w.page.keyboard.up('u');
    await untilRow(w.page, S1, (row) => row.attention === 'unread', 'marked');
    await sleep(300);
    assert.deepEqual(await acts(w.page), [{ kind: 'unread', sessionId: S1 }], 'one act');
    assert.equal((await drawnRow(w.page, S1)).attention, 'unread');
  });

  await t.test(
    'u on a finished session marks it read; on one that asks nothing changes and the toast says why',
    async (t) => {
      const w = await world(t, chromium, { running: [S1], stopped: [S2] });
      const term = w.server.hub.list().find((info) => info.expectedSessionId === S1)?.id;
      assert.ok(term !== undefined);
      await pick(w.page, S2); // S1 is not selected: its turn end is not seen
      const say = (line: string): void => {
        assert.equal(w.server.hub.input(term, Buffer.from(`${line}\r`, 'utf8')), 'ok');
      };
      say('/waiting a question');
      await untilRow(w.page, S1, (row) => row.attention === 'asks', 'S1 asks');
      await clickRow(w.page, S1);
      await toZone(w.page, 'list');
      await w.page.keyboard.press('u');
      await toastSays(w.page, 'it asks something: it needs you until it is answered');
      assert.equal((await headerUnread(w.page)).text, 'Unread');
      assert.equal((await drawnRow(w.page, S1)).attention, 'asks', 'nothing changed');

      await pick(w.page, S2);
      say('/idle');
      await untilRow(w.page, S1, (row) => row.attention === 'finished', 'S1 finished');
      // Back on it with the keyboard and at once `u`, before its hold of 1.5 s reads it.
      await w.page.keyboard.press('ArrowUp');
      await until(async () => (await selectedRow(w.page)) === S1, 'S1 selected');
      await until(async () => (await headerUnread(w.page)).text === 'Read', 'Read on finished');
      await w.page.keyboard.press('u');
      await untilRow(w.page, S1, (row) => row.attention === null, 'read');
      await toastSays(w.page, READ);
      assert.deepEqual(
        (await acts(w.page)).filter((one) => one.sessionId === S1).map((one) => one.kind),
        ['unread', 'read'],
      );
    },
  );

  await t.test('u on a session marked done changes nothing, and the toast says why', async (t) => {
    const w = await world(t, chromium, { stopped: [S1, S2] });
    assert.equal((await w.api.act({ kind: 'done', sessionId: S1 })).ok, true);
    await pick(w.page, S2);
    await w.page.keyboard.press('a'); // done sessions shown
    await drawnRow(w.page, S1);
    await pick(w.page, S1);
    await w.page.keyboard.press('u');
    await toastSays(w.page, 'it is marked done: a done session needs nothing');
    assert.equal((await drawnRow(w.page, S1)).attention, null);
  });
});

test('the mark unread on the row of a session not started yet: the server says why, in the toast', async (t) => {
  const chromium = await browser(t);
  const page = await newPage(t, chromium);
  const list = scriptedList(
    [
      { id: S3, terminal: 'aaaaaaaaaaaa', slot: 1, title: 'a new session' },
      { id: S2, terminal: null, slot: null },
    ],
    [{ id: 'aaaaaaaaaaaa', slot: 1, sessionId: null }],
  );
  const sections = list['sections'] as { rows: Record<string, unknown>[] }[];
  const first = sections[0]?.rows[0];
  assert.ok(first !== undefined);
  first['starting'] = true;
  const w = await editWorld(t, page, list);
  await drawnRow(page, S3);
  await pick(page, S3);
  await page.keyboard.press('u');
  const act = await w.act(1);
  assert.deepEqual([act['kind'], act['sessionId']], ['unread', S3]);
  w.answer(act, { ok: false, error: 'this session has not started yet; mark it once it runs' });
  await toastSays(page, 'this session has not started yet; mark it once it runs');
});

test('u again at once is its undo: the answered act counts until the next list; one act at a time', async (t) => {
  const chromium = await browser(t);
  const page = await newPage(t, chromium);
  const listWith = (attention: Record<string, unknown> | null): Record<string, unknown> => {
    const list = scriptedList([{ id: S1, terminal: null, slot: null, title: 'one' }], []);
    const sections = list['sections'] as { rows: Record<string, unknown>[] }[];
    const first = sections[0]?.rows[0];
    assert.ok(first !== undefined);
    first['attention'] = attention;
    return list;
  };
  const w = await editWorld(t, page, listWith(null));
  await drawnRow(page, S1);
  await pick(page, S1);
  await page.keyboard.press('u');
  const first = await w.act(1);
  assert.equal(first['kind'], 'unread');
  await page.keyboard.press('u'); // while the first waits: nothing
  await sleep(200);
  assert.equal(w.acts().length, 1, 'one act at a time');

  w.answer(first, { ok: true });
  await toastSays(page, MARKED);
  // No list yet: the header and `u` go by the answer.
  await until(async () => (await headerUnread(page)).text === 'Read', 'Read at the answer');
  await page.keyboard.press('u');
  const second = await w.act(2);
  assert.equal(second['kind'], 'read', 'u again undoes it');
  w.answer(second, { ok: true });
  await toastSays(page, READ);
  await until(async () => (await headerUnread(page)).text === 'Unread', 'Unread at the answer');

  // The next list decides again: here it shows the mark (another page marked it meanwhile).
  w.list(listWith({ reason: 'unread', detail: null, sinceNs: '1794474000000000000' }));
  await untilRow(page, S1, (row) => row.attention === 'unread', 'the list shows it');
  assert.equal((await headerUnread(page)).text, 'Read');
  await page.keyboard.press('u');
  const third = await w.act(3);
  assert.equal(third['kind'], 'read');
});

test("the page says which selection is its own (`focus.byPage`): the first row it selects at its first list and the one it reports again once reconnected, never the user's", async (t) => {
  const chromium = await browser(t);
  const page = await newPage(t, chromium);
  const list = scriptedList(
    [
      { id: S1, terminal: null, slot: null },
      { id: S2, terminal: null, slot: null },
    ],
    [],
  );
  const w = await editWorld(t, page, list);
  await drawnRow(page, S2);
  const focuses = (): { selected: unknown; byPage: unknown }[] =>
    w.sent
      .filter((one) => one['t'] === 'focus')
      .map((one) => ({ selected: one['selected'], byPage: one['byPage'] }));
  await until(() => focuses().some((one) => one.selected === S1), 'the first row selected');
  assert.deepEqual(
    focuses().find((one) => one.selected === S1),
    { selected: S1, byPage: true },
    'the first row, selected by the page',
  );

  await clickRow(page, S2);
  await until(() => focuses().at(-1)?.selected === S2, 'S2 selected');
  assert.equal(focuses().at(-1)?.byPage, undefined, "the user's click");

  const before = focuses().length;
  w.drop();
  await connection(page, 'open');
  await until(() => focuses().length > before, 'the focus after the reconnect');
  assert.deepEqual(focuses()[before], { selected: S2, byPage: true }, 'reported again: its own');
});
