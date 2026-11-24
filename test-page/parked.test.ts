// Follow-up F44 (S2 12.9, 12.15) on the page: `w` and the header's Park / Unpark, the toast with
// Undo, where the selection goes after `w` (the owner's decision: the next row of the section the
// row left, decided at the list that shows it gone, so the list never jumps), the one guard for
// `w`, `d` and the end dialog, and the key help's line. Against a real test server (real keepers
// running the stand-in), and for the cases that need the moment a list comes held still, against
// a scripted stand-in (`editWorld`). The page decides no rule: which rows are parked, where they
// go and which one needs you are the server's.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { isoFromNs, NS_PER_MINUTE } from '../src/platform/time.ts';
import { controlClient } from '../src/window/client.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { readRecords } from '../test/helpers/standin.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { connectTestPage, startTestServer } from '../test/helpers/window.ts';
import type { ServerSandbox, StartedServer, TestPage } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  RECORDER,
  clickRow,
  connection,
  editWorld,
  holdWriteLock,
  keyMessage,
  pageUrl,
  problemsOf,
  readPage,
  selectedRow,
  shownText,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { EditWorld } from './helpers/shell.ts';
import { screenText } from './helpers/terminal.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';
const S7 = '6b1f9c7e-4d8a-4fca-9c9d-8e7f6a5b4c3d';
const S8 = '7c2a0d8f-5e9b-4adb-8dae-9f8a7b6c5d4e';
const S9 = '8d3b1e9a-6fac-4bec-9ebf-a09b8c7d6e5f';

const PARKED = 'Parked: listed under Parked. It comes back when you send it a prompt.';
const PARKED_RUNNING =
  'Parked: listed under Parked, and it keeps running. It comes back when you send it a prompt.';

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
  /** A page of the test's own on the same server (no browser): it opens the terminals. */
  api: TestPage;
  problems: string[];
}

/** A transcript for `id` with one user record `minutes` ago: its row is last active then. */
function recent(d: ServerSandbox, id: string, minutes: number): void {
  const dir = d.resumable(id);
  const line = {
    type: 'user',
    sessionId: id,
    timestamp: isoFromNs(d.platform.clock.nowNs() - BigInt(minutes) * NS_PER_MINUTE),
    cwd: dir,
    entrypoint: 'cli',
  };
  writeFileSync(
    join(d.s.claudeHome, 'projects', 'project', `${id}.jsonl`),
    `${JSON.stringify(line)}\n`,
  );
}

/**
 * A real test server with `stopped` sessions under Recent (in this order: the first the most
 * recent) and `running` ones resumed in window terminals (numbered 1, 2, … in this order), and a
 * browser page on it (`height`: its viewport's), connected, with every row drawn.
 */
async function world(
  t: TestContext,
  chromium: Browser,
  options: { stopped?: string[]; running?: string[]; height?: number } = {},
): Promise<World> {
  const { stopped = [], running = [], height } = options;
  const page = await newPage(t, chromium);
  if (height !== undefined) await page.setViewportSize({ width: 1280, height });
  await page.addInitScript(ACTS);
  await page.addInitScript(RECORDER);
  const problems = problemsOf(page);
  const started = await startTestServer(t);
  const { d, server } = started;
  for (const [at, id] of [...running, ...stopped].entries()) recent(d, id, at + 1);
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
        list.sections
          .find((section) => section.name === 'open')
          ?.rows.some((row) => row.id === id && row.state !== 'not-running' && !row.starting) ===
        true,
      `${id} runs under Open`,
    );
  }
  const { token } = await controlClient(d.platform.net, d.files.serverSock).token(30);
  await page.goto(pageUrl(server.port, token));
  await connection(page, 'open');
  await untilDrawn(
    page,
    (rows) =>
      running.every((id) => rows.some((row) => row.id === id && row.section === 'open')) &&
      stopped.every((id) => rows.some((row) => row.id === id)),
    'every row drawn',
  );
  return { ...started, page, api, problems };
}

/** A second browser page on `w`'s server, connected. */
async function secondPage(t: TestContext, chromium: Browser, w: World): Promise<Page> {
  const page = await newPage(t, chromium);
  const { token } = await controlClient(w.d.platform.net, w.d.files.serverSock).token(30);
  await page.goto(pageUrl(w.server.port, token));
  await connection(page, 'open');
  return page;
}

interface Drawn {
  id: string;
  section: string;
  slot: string;
  marks: string[];
}

/** The rows the list draws, in order, each with the section it is under. */
async function drawn(page: Page): Promise<Drawn[]> {
  return readPage(
    page,
    () => {
      const shown = (element: Element | null): string =>
        element instanceof HTMLElement && element.checkVisibility()
          ? (element.textContent ?? '')
          : '';
      let section = '';
      const rows = [];
      for (const element of document.querySelectorAll('#list .list-section, #list .list-row')) {
        if (!(element instanceof HTMLElement) || !element.checkVisibility()) continue;
        if (element.classList.contains('list-section')) {
          section = element.dataset['section'] ?? '';
          continue;
        }
        rows.push({
          id: element.dataset['id'] ?? '',
          section,
          slot: shown(element.querySelector('.row-slot')),
          marks: [...element.querySelectorAll('.row-mark')]
            .map(shown)
            .filter((text) => text !== ''),
        });
      }
      return rows;
    },
    null,
  );
}

async function untilDrawn(
  page: Page,
  check: (rows: Drawn[]) => boolean,
  what: string,
): Promise<Drawn[]> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const rows = await drawn(page);
    if (check(rows)) return rows;
    if (performance.now() > deadline) {
      assert.fail(`${what}: the list draws ${JSON.stringify(rows, null, 1)}`);
    }
    await sleep(25);
  }
}

/** The ids drawn under `section`, in order. */
async function idsIn(page: Page, section: string): Promise<string[]> {
  return (await drawn(page)).filter((row) => row.section === section).map((row) => row.id);
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, what);
    await sleep(25);
  }
}

/** Waits until `sessionId`'s row is drawn under `section`. */
async function under(page: Page, sessionId: string, section: string): Promise<Drawn> {
  const rows = await untilDrawn(
    page,
    (all) => all.some((row) => row.id === sessionId && row.section === section),
    `${sessionId} under ${section}`,
  );
  return rows.find((row) => row.id === sessionId) as Drawn;
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

/** The acts the page sent so far: kind and session. */
async function acts(page: Page): Promise<{ kind: string; sessionId: string | null }[]> {
  return readPage(
    page,
    () => Reflect.get(window, 'skydeckActs') as { kind: string; sessionId: string | null }[],
    null,
  );
}

/** The list's scroll place, and how many scroll events its body fired since `watchScroll`. */
async function scroll(page: Page): Promise<{ top: number; events: number }> {
  return readPage(
    page,
    () => {
      const body = document.querySelector('#list .list-body') as HTMLElement;
      return { top: body.scrollTop, events: Number(Reflect.get(window, 'skydeckScrolls') ?? 0) };
    },
    null,
  );
}

async function watchScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.set(window, 'skydeckScrolls', 0);
    document.querySelector('#list .list-body')?.addEventListener('scroll', () => {
      Reflect.set(window, 'skydeckScrolls', Number(Reflect.get(window, 'skydeckScrolls')) + 1);
    });
  });
}

/** Whether `sessionId`'s row is inside the list's visible box (below the stuck bands too). */
async function inView(page: Page, sessionId: string): Promise<boolean> {
  return readPage(
    page,
    (id) => {
      const body = document.querySelector('#list .list-body') as HTMLElement;
      const row = document.querySelector(`#list [data-id="${id}"]`);
      if (row === null) return false;
      const b = body.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return r.top >= b.top - 0.5 && r.bottom <= b.top + body.clientHeight + 0.5;
    },
    sessionId,
  );
}

/** Whether the band of `section` is out of the list's view, below it. */
async function bandBelowView(page: Page, section: string): Promise<boolean> {
  return readPage(
    page,
    (name) => {
      const body = document.querySelector('#list .list-body') as HTMLElement;
      const band = document.querySelector(`#list .list-section[data-section="${name}"]`);
      if (band === null) return true;
      return (
        band.getBoundingClientRect().top >= body.getBoundingClientRect().top + body.clientHeight
      );
    },
    section,
  );
}

/** Selects `sessionId`'s row with a click and gives the list the keyboard. */
async function pick(page: Page, sessionId: string): Promise<void> {
  await clickRow(page, sessionId);
  await toZone(page, 'list');
}

/** Waits until the selection is `want` (null: none). */
async function selectionIs(page: Page, want: string | null, what: string): Promise<void> {
  await until(async () => (await selectedRow(page)) === want, `${what}: selected ${want}`);
}

/** What the right side shows (`#right-zone[data-pane]`). */
async function pane(page: Page): Promise<string | null> {
  return readPage(
    page,
    () => document.getElementById('right-zone')?.getAttribute('data-pane') ?? null,
    null,
  );
}

/** A refresh that ran, as a fact: a new session it lists is drawn. */
let probes = 0;
async function aRefresh(w: World): Promise<void> {
  const probe = `00000000-0000-4000-8000-${String(++probes).padStart(12, '0')}`;
  recent(w.d, probe, 600);
  await untilDrawn(w.page, (rows) => rows.some((row) => row.id === probe), `${probe} listed`);
}

/** Keys dispatched on the list in one task, before any list or answer can come. */
async function inOneTask(page: Page, keys: KeyboardEventInit[]): Promise<void> {
  const sent = JSON.stringify(keys);
  await page.evaluate((all: string) => {
    const list = document.getElementById('list') as HTMLElement;
    for (const init of JSON.parse(all) as KeyboardEventInit[]) {
      list.dispatchEvent(
        new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
      );
    }
  }, sent);
}

const KEY_W = { key: 'w', code: 'KeyW' };
const KEY_D = { key: 'd', code: 'KeyD' };

/**
 * Types `text` on the page and returns the sessions whose programs (the stand-ins of the window's
 * terminals) received it, from the stand-ins' records of their input.
 */
async function typedReaches(w: World, text: string): Promise<string[]> {
  const from = Date.now();
  await w.page.keyboard.type(text);
  await sleep(600);
  const sessionOf = new Map<number, string>();
  for (const term of w.server.hub.list()) {
    if (term.program !== null) {
      sessionOf.set(term.program.pid, term.sessionId ?? term.expectedSessionId);
    }
  }
  const received = new Map<number, string>();
  for (const record of readRecords(w.d.record)) {
    if (record.ev === 'input' && record.ms >= from) {
      received.set(
        record.pid,
        (received.get(record.pid) ?? '') + Buffer.from(record.hex, 'hex').toString('latin1'),
      );
    }
  }
  return [...received]
    .filter(([, got]) => got.includes(text))
    .map(([pid]) => sessionOf.get(pid) ?? `pid ${pid}`);
}

/** The header's Park / Unpark button: its text. */
async function headerPark(page: Page): Promise<string> {
  return shownText(page, '#cards .header-park');
}

test('F44: parking a session in the window', async (t) => {
  const chromium = await browser(t);

  await t.test('the key help (Ctrl+Shift+H) holds the line for w', async (t) => {
    const w = await world(t, chromium, { stopped: [S1] });
    await pick(w.page, S1);
    await w.page.keyboard.press('Control+Shift+H');
    await until(
      async () =>
        (await shownText(w.page, '#help')).includes(
          'park: the session waits under Parked until you send it a prompt; on a parked one, unpark (an Undo follows a park)',
        ),
      'the help names w',
    );
    assert.deepEqual(w.problems, []);
  });

  await t.test(
    "w on a running row: under Parked without a number, its mark `parked <age>`, the toast with Undo; w on it under Parked un-parks with no toast; the header's control does both and leaves the selection with the session; a second page follows",
    async (t) => {
      const w = await world(t, chromium, { running: [S1, S2] });
      const other = await secondPage(t, chromium, w);
      await clickRow(other, S2);
      await pick(w.page, S1);
      assert.equal((await drawn(w.page)).find((row) => row.id === S1)?.slot, '1');
      await w.page.keyboard.press('w');
      const row = await under(w.page, S1, 'parked');
      assert.equal(row.slot, '', 'no number');
      assert.match(row.marks.join(' '), /^parked \d+s$/);
      await until(async () => (await toast(w.page)).text === PARKED_RUNNING, 'the toast');
      assert.equal((await toast(w.page)).undo, true);
      assert.deepEqual(await acts(w.page), [{ kind: 'park', sessionId: S1 }]);
      // The second page follows; its own selection stays.
      await under(other, S1, 'parked');
      assert.equal(await selectedRow(other), S2);

      // w on the row under Parked: back under Open, still selected, no toast.
      await w.page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      await pick(w.page, S1);
      await w.page.keyboard.press('w');
      await under(w.page, S1, 'open');
      assert.equal(await selectedRow(w.page), S1);
      await sleep(300);
      assert.deepEqual(await toast(w.page), { text: '', undo: false });
      assert.equal(await zone(w.page), 'Focus: list');

      // The header's control: Park, then Unpark; the selection stays with the session.
      assert.equal(await headerPark(w.page), 'Park');
      await w.page.locator('#cards .header-park').click();
      await under(w.page, S1, 'parked');
      assert.equal(await selectedRow(w.page), S1, 'the header leaves the selection with it');
      await until(async () => (await headerPark(w.page)) === 'Unpark', 'Unpark');
      await w.page.locator('#cards .header-park').click();
      await under(w.page, S1, 'open');
      assert.equal(await selectedRow(w.page), S1);
      assert.equal(await headerPark(w.page), 'Park');
      assert.deepEqual(
        (await acts(w.page)).map((one) => one.kind),
        ['park', 'unpark', 'park', 'unpark'],
      );
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'a held w acts once; w on a hidden selection says `no session selected`; d on a parked running row leaves it under Open marked done',
    async (t) => {
      const w = await world(t, chromium, { running: [S1], stopped: [S2] });
      await pick(w.page, S2);
      await w.page.keyboard.down('w');
      await w.page.keyboard.down('w'); // an auto-repeat
      await w.page.keyboard.down('w');
      await w.page.keyboard.up('w');
      await under(w.page, S2, 'parked');
      await sleep(300);
      assert.deepEqual(await acts(w.page), [{ kind: 'park', sessionId: S2 }], 'one act');

      // A hidden selection: a filter that hides the selected row.
      await pick(w.page, S1);
      await w.page.keyboard.press('/');
      await w.page.keyboard.type('nothing matches this');
      await w.page.keyboard.press('Enter');
      await until(async () => (await drawn(w.page)).length === 0, 'the filter hides every row');
      await toZone(w.page, 'list');
      await w.page.keyboard.press('w');
      await until(async () => (await keyMessage(w.page)) === 'no session selected', 'the line');
      await w.page.keyboard.press('Escape');
      await under(w.page, S1, 'open');
      assert.equal((await acts(w.page)).length, 1);

      // d on a parked running row: under Open, marked done (a parked running row is no row gone).
      // First w on the only row of Open: none is selected.
      await pick(w.page, S1);
      await w.page.keyboard.press('w');
      await under(w.page, S1, 'parked');
      await selectionIs(w.page, null, 'the only row of Open: none');
      assert.equal(await zone(w.page), 'Focus: list');
      await w.page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      await pick(w.page, S1);
      await w.page.keyboard.press('d');
      // The stand-in's keeper can end it: the dialog asks first; keep it running.
      await w.page.waitForSelector('#end-dialog:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await w.page.keyboard.press('Enter'); // the keyboard starts on `Mark done, keep it running`
      const done = await under(w.page, S1, 'open');
      assert.ok(done.marks.includes('done'), JSON.stringify(done.marks));
      assert.ok(!done.marks.some((mark) => mark.startsWith('parked')));
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'a parked row that asks shows its mark; Ctrl+Shift+J skips it and goes to one that needs you',
    async (t) => {
      const w = await world(t, chromium, { running: [S1, S2], stopped: [S3] });
      await pick(w.page, S1);
      await w.page.keyboard.press('w');
      await under(w.page, S1, 'parked');
      const term1 = w.server.hub.list().find((info) => info.expectedSessionId === S1)?.id;
      const term2 = w.server.hub.list().find((info) => info.expectedSessionId === S2)?.id;
      assert.ok(term1 !== undefined && term2 !== undefined);
      await pick(w.page, S3);
      assert.equal(w.server.hub.input(term1, Buffer.from('/waiting a question\r')), 'ok');
      await until(
        async () =>
          (await readPage(
            w.page,
            (id) =>
              document.querySelector<HTMLElement>(`#list [data-id="${id}"]`)?.dataset[
                'attention'
              ] ?? null,
            S1,
          )) === 'asks',
        "the parked row's mark",
      );
      await w.page.keyboard.press('Control+Shift+J');
      await until(async () => (await keyMessage(w.page)) === 'no session needs you', 'skipped');
      assert.equal(await selectedRow(w.page), S3);
      assert.equal(w.server.hub.input(term2, Buffer.from('/waiting another\r')), 'ok');
      await until(
        async () =>
          (await readPage(
            w.page,
            (id) =>
              document.querySelector<HTMLElement>(`#list [data-id="${id}"]`)?.dataset[
                'attention'
              ] ?? null,
            S2,
          )) === 'asks',
        "S2's mark",
      );
      await toZone(w.page, 'list');
      await w.page.keyboard.press('Control+Shift+J');
      await selectionIs(w.page, S2, 'Ctrl+Shift+J');
      await toZone(w.page, 'list');
      await w.page.keyboard.press('Control+Shift+J');
      await until(
        async () => (await keyMessage(w.page)) === 'no other session needs you',
        'the parked one is skipped',
      );
      assert.deepEqual(w.problems, []);
    },
  );

  for (const [name, key, form] of [
    ['Enter', { key: 'Enter', code: 'Enter' }, false],
    ['Esc', { key: 'Escape', code: 'Escape' }, false],
    ['Ctrl+Shift+N', { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }, true],
  ] as [string, KeyboardEventInit, boolean][]) {
    await t.test(
      `w then ${name} before the list that decides: the selection stays with the parked session (the user moved), and typed text reaches no other session's program${form ? '; the new form stays open' : ''}`,
      async (t) => {
        const w = await world(t, chromium, { running: [S1, S2, S3] });
        await pick(w.page, S1);
        await inOneTask(w.page, [KEY_W, key]);
        await under(w.page, S1, 'parked');
        await aRefresh(w); // the list that decides, and the next
        assert.equal(await selectedRow(w.page), S1, 'the selection stays');
        if (form) {
          assert.equal(await pane(w.page), 'new', 'the form stays open');
        } else {
          assert.equal(await zone(w.page), 'Focus: terminal');
        }
        const reached = await typedReaches(w, 'zqzq');
        assert.deepEqual(
          reached.filter((id) => id !== S1),
          [],
          'no other session got the text',
        );
        if (form) assert.deepEqual(reached, [], 'the form took it');
        assert.deepEqual(await acts(w.page), [{ kind: 'park', sessionId: S1 }]);
        assert.deepEqual(w.problems, []);
      },
    );
  }

  await t.test(
    "d on a stopped row under Parked whose next row under Parked runs, then Esc before the list that decides: the selection does not move to the running row, and typed text reaches no session's program",
    async (t) => {
      const w = await world(t, chromium, { running: [S2, S3], stopped: [S1] });
      for (const id of [S2, S1]) {
        const result = await w.api.act({ kind: 'park', sessionId: id });
        assert.equal(result.ok, true, JSON.stringify(result));
      }
      await under(w.page, S2, 'parked');
      await under(w.page, S1, 'parked');
      assert.deepEqual(await idsIn(w.page, 'parked'), [S1, S2]);
      await pick(w.page, S1);
      await inOneTask(w.page, [KEY_D, { key: 'Escape', code: 'Escape' }]);
      await untilDrawn(w.page, (rows) => !rows.some((row) => row.id === S1), 'S1 done, hidden');
      await aRefresh(w);
      assert.notEqual(await selectedRow(w.page), S2, 'not the running row');
      assert.deepEqual(await typedReaches(w, 'zqzq'), [], 'no program got the text');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'a held w with rows after the selected one parks one row and sends one act: its auto-repeats do nothing, also once the selection moved on',
    async (t) => {
      const w = await world(t, chromium, { stopped: [S1, S2, S3, S4] });
      await pick(w.page, S1);
      await w.page.keyboard.down('w');
      await selectionIs(w.page, S2, 'moved on');
      for (let i = 0; i < 3; i++) {
        await w.page.keyboard.down('w'); // an auto-repeat (`repeat` true)
        await sleep(150);
      }
      await w.page.keyboard.up('w');
      await aRefresh(w);
      assert.deepEqual(await acts(w.page), [{ kind: 'park', sessionId: S1 }], 'one act');
      assert.deepEqual((await idsIn(w.page, 'week')).slice(0, 3), [S2, S3, S4]);
      assert.equal(await selectedRow(w.page), S2);
    },
  );

  await t.test(
    'the guard: w then d at once on a row parks it and marks nothing done; d then w at once on a stopped row marks it done and parks nothing; one act each',
    async (t) => {
      const w = await world(t, chromium, { stopped: [S1, S2, S3] });
      // Both keys in one task, before any list can come (a real server answers in milliseconds).
      const both = async (first: string, second: string): Promise<void> => {
        await w.page.evaluate(
          (keys: string[]) => {
            const list = document.getElementById('list') as HTMLElement;
            for (const key of keys) {
              list.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key,
                  code: `Key${key.toUpperCase()}`,
                  bubbles: true,
                }),
              );
            }
          },
          [first, second],
        );
      };
      await pick(w.page, S1);
      await both('w', 'd');
      await under(w.page, S1, 'parked');
      await sleep(300);
      assert.deepEqual(await acts(w.page), [{ kind: 'park', sessionId: S1 }]);
      assert.equal(w.d.deck.store.meta(S1)?.doneAtNs, null);

      await pick(w.page, S2);
      await both('d', 'w');
      await untilDrawn(w.page, (rows) => !rows.some((row) => row.id === S2), 'S2 done, hidden');
      await sleep(300);
      assert.deepEqual((await acts(w.page)).slice(1), [{ kind: 'done', sessionId: S2 }]);
      assert.equal(w.d.deck.store.meta(S2)?.parkedAtNs ?? null, null);
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'the selection under Recent: w on a middle row selects the row after it, on the last the one before, on the only one none — the right side shows no session, later lists select nothing, ↓ starts from the first row and Ctrl+Tab goes back to the parked session',
    async (t) => {
      const w = await world(t, chromium, { stopped: [S1, S2, S3, S4] });
      assert.deepEqual(await idsIn(w.page, 'week'), [S1, S2, S3, S4]);
      await pick(w.page, S2);
      await watchScroll(w.page);
      await w.page.keyboard.press('w');
      await selectionIs(w.page, S3, 'the row after it');
      await under(w.page, S2, 'parked');
      assert.equal(await zone(w.page), 'Focus: list');

      // The last row of its section: the one before it.
      await pick(w.page, S4);
      await w.page.keyboard.press('w');
      await selectionIs(w.page, S3, 'the row before it');
      await under(w.page, S4, 'parked');

      // A run of w, each after the selection moved: one row each.
      await w.page.keyboard.press('w'); // S3 → S1 (the one before it)
      await selectionIs(w.page, S1, 'after S3');
      await under(w.page, S3, 'parked');
      // The only row of Recent: none selected.
      await w.page.keyboard.press('w');
      await under(w.page, S1, 'parked');
      await selectionIs(w.page, null, 'none');
      assert.equal(await pane(w.page), 'none', 'the right side shows no session');
      assert.equal(await zone(w.page), 'Focus: list');
      assert.deepEqual(
        (await acts(w.page)).map((one) => one.sessionId),
        [S2, S4, S3, S1],
        'one row each',
      );
      await aRefresh(w);
      await aRefresh(w);
      assert.equal(await selectedRow(w.page), null, 'no later list selects a row');
      assert.equal(await pane(w.page), 'none');
      await w.page.keyboard.press('Control+Tab');
      await selectionIs(w.page, S1, 'Ctrl+Tab: the session just parked');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'two w in one tick park one row and un-park none; Undo with the selection still where w left it selects the session again, back in its section; Undo after the user moved the selection leaves it',
    async (t) => {
      const w = await world(t, chromium, { stopped: [S1, S2, S3, S4] });
      await pick(w.page, S2);
      await w.page.evaluate(() => {
        const list = document.getElementById('list') as HTMLElement;
        for (let i = 0; i < 2; i++) {
          list.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true }),
          );
        }
      });
      await selectionIs(w.page, S3, 'the row after it');
      await under(w.page, S2, 'parked');
      await sleep(300);
      assert.deepEqual(await acts(w.page), [{ kind: 'park', sessionId: S2 }]);

      // Undo, the selection still on S3: S2 back under Recent, selected again.
      await until(async () => (await toast(w.page)).undo, 'the Undo');
      await w.page.locator('#toast .toast-undo').click();
      await under(w.page, S2, 'week');
      await selectionIs(w.page, S2, 'selected again');
      assert.deepEqual((await acts(w.page)).at(-1), { kind: 'unpark', sessionId: S2 });

      // Undo after the user moved the selection: it stays.
      await w.page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      await pick(w.page, S2);
      await w.page.keyboard.press('w');
      await selectionIs(w.page, S3, 'the row after it');
      await w.page.keyboard.press('ArrowDown');
      await selectionIs(w.page, S4, 'moved by the user');
      await until(async () => (await toast(w.page)).undo, 'the Undo');
      await w.page.locator('#toast .toast-undo').click();
      await under(w.page, S2, 'week');
      await sleep(300);
      assert.equal(await selectedRow(w.page), S4);

      // The only row of its section, then Undo: none selected, so the session is selected again.
      await w.page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      for (const id of [S1, S3, S4]) {
        await pick(w.page, id);
        await w.page.keyboard.press('w');
        await under(w.page, id, 'parked');
      }
      await w.page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      await pick(w.page, S2);
      await w.page.keyboard.press('w');
      await selectionIs(w.page, null, 'none');
      await until(async () => (await toast(w.page)).undo, 'the Undo');
      await w.page.locator('#toast .toast-undo').click();
      await under(w.page, S2, 'week');
      await selectionIs(w.page, S2, 'selected again from none');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'a refused w (the store busy) moves nothing; after d on a parked session the Undo parks it again',
    async (t) => {
      const w = await world(t, chromium, { stopped: [S1, S2, S3] });
      await pick(w.page, S2);
      const lock = holdWriteLock(t, w.d.deck.places.dbPath);
      await lock.held;
      await w.page.keyboard.press('w');
      await until(async () => /busy/.test(await keyMessage(w.page)), 'the busy line');
      assert.equal(await selectedRow(w.page), S2, 'nothing moved');
      lock.release();
      await sleep(300);
      assert.deepEqual(await idsIn(w.page, 'week'), [S1, S2, S3]);

      // d on a parked session, then Undo: parked again.
      await w.page.keyboard.press('w');
      await under(w.page, S2, 'parked');
      await w.page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      await pick(w.page, S2);
      await w.page.keyboard.press('d');
      await untilDrawn(w.page, (rows) => !rows.some((row) => row.id === S2), 'S2 done, hidden');
      await until(async () => (await toast(w.page)).undo, 'the Undo');
      await w.page.locator('#toast .toast-undo').click();
      await under(w.page, S2, 'parked');
      assert.deepEqual((await acts(w.page)).slice(-2), [
        { kind: 'done', sessionId: S2 },
        { kind: 'park', sessionId: S2 },
      ]);
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    "the list does not jump (Parked out of view): w on Open's top row selects the next one, a running row, with the keyboard in the list and no key reaching its terminal; no scroll event and the same scrollTop until after the toast and the next list, and the same for Undo; the header's Park scrolls to the row under Parked, its Unpark back under Open",
    async (t) => {
      const running = [S1, S2, S3, S4, S5, S6, S7, S8];
      const w = await world(t, chromium, { running, stopped: [S9], height: 420 });
      assert.equal(await bandBelowView(w.page, 'week'), true, 'Open fills the list');
      await pick(w.page, S1);
      const before = await scroll(w.page);
      await watchScroll(w.page);
      await w.page.keyboard.press('w');
      await selectionIs(w.page, S2, 'the next row of Open');
      await until(async () => (await toast(w.page)).text === PARKED_RUNNING, 'the toast');
      await aRefresh(w); // and the next list
      assert.deepEqual(await scroll(w.page), { ...before, events: 0 }, 'no scroll at any moment');
      assert.equal(await bandBelowView(w.page, 'parked'), true, 'Parked still out of view');
      assert.equal(await zone(w.page), 'Focus: list');
      // A key typed now reaches no terminal: the keyboard is the list's.
      const screenBefore = await screenText(w.page);
      await w.page.keyboard.press('x');
      await sleep(300);
      assert.equal(await screenText(w.page), screenBefore, "nothing typed into S2's terminal");

      // Undo with the selection still there: S1 back under Open, selected again beside it.
      await w.page.locator('#toast .toast-undo').click();
      await under(w.page, S1, 'open');
      await selectionIs(w.page, S1, 'selected again');
      await aRefresh(w);
      assert.deepEqual(await scroll(w.page), { ...before, events: 0 }, 'Undo: no scroll either');

      // The mirror: the header's Park follows the row to Parked, its Unpark back under Open.
      await w.page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      await w.page.locator('#cards .header-park').click();
      await under(w.page, S1, 'parked');
      await until(() => inView(w.page, S1), 'the list scrolled to it under Parked');
      assert.notEqual((await scroll(w.page)).top, before.top);
      await until(async () => (await headerPark(w.page)) === 'Unpark', 'Unpark');
      await w.page.locator('#cards .header-park').click();
      await under(w.page, S1, 'open');
      await until(() => inView(w.page, S1), 'the list scrolled back to it under Open');
      assert.equal(await selectedRow(w.page), S1);
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'w on a row under Parked un-parks it — its middle, last and only row —: back under Open, still selected, its row scrolled into view, the keyboard in the list, no other row of Parked selected; w again parks that same session again (R-8); no second row of Parked was un-parked',
    async (t) => {
      const running = [S1, S2, S3, S4, S5, S6, S7, S8];
      const w = await world(t, chromium, { running, height: 420 });
      // Park S6, S7, S8 from the header (the selection stays): Parked is S8, S7, S6.
      for (const id of [S6, S7, S8]) {
        await pick(w.page, id);
        await w.page.locator('#cards .header-park').click();
        await under(w.page, id, 'parked');
        await until(async () => (await headerPark(w.page)) === 'Unpark', 'parked');
      }
      assert.deepEqual(await idsIn(w.page, 'parked'), [S8, S7, S6]);
      const cases: [string, string][] = [
        [S7, 'the middle row'],
        [S6, 'the last row'],
        [S8, 'the only row'],
      ];
      for (const [id, what] of cases) {
        const parkedBefore = await idsIn(w.page, 'parked');
        await pick(w.page, id);
        // Open's top out of view, so that its row must be scrolled to.
        await w.page.evaluate(() => {
          const body = document.querySelector('#list .list-body') as HTMLElement;
          body.scrollTop = body.scrollHeight;
        });
        await w.page.keyboard.press('w');
        await under(w.page, id, 'open');
        assert.equal(await selectedRow(w.page), id, `${what}: still selected`);
        await until(() => inView(w.page, id), `${what}: scrolled into view under Open`);
        assert.equal(await zone(w.page), 'Focus: list', what);
        assert.deepEqual(
          await idsIn(w.page, 'parked'),
          parkedBefore.filter((one) => one !== id),
          `${what}: no other row of Parked moved`,
        );
      }
      // R-8: w again on the same session parks it again, and moves the selection on in Open: S8,
      // back with its number 8, is Open's last row, so the one before it.
      assert.deepEqual((await idsIn(w.page, 'open')).slice(-2), [S7, S8]);
      await w.page.keyboard.press('w');
      await under(w.page, S8, 'parked');
      await selectionIs(w.page, S7, "Open's last row: the one before it");
      assert.deepEqual(
        (await acts(w.page)).map((one) => `${one.kind} ${one.sessionId}`),
        [
          `park ${S6}`,
          `park ${S7}`,
          `park ${S8}`,
          `unpark ${S7}`,
          `unpark ${S6}`,
          `unpark ${S8}`,
          `park ${S8}`,
        ],
      );
      assert.deepEqual(w.problems, []);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The moment a list comes, held still: a scripted stand-in (editWorld).

/** A row of a scripted list. */
function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    shortId: id.slice(0, 8),
    title: `session ${id.slice(0, 8)}`,
    titleSource: 'summary',
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: '1794474000000000000',
    lastActivityNs: '1794474000000000000',
    dir: '/home/u/project',
    marks: [],
    hasNote: false,
    noteHead: [],
    done: false,
    prs: [],
    chip: null,
    terminal: null,
    slot: null,
    elsewhere: null,
    starting: false,
    attention: null,
    stack: null,
    ...over,
  };
}

/** A scripted list: `week`'s rows and `parked`'s (each parked a minute ago). */
function listOf(week: string[], parked: string[] = []): Record<string, unknown> {
  const section = (name: string, rows: Record<string, unknown>[]) => ({
    name,
    folded: false,
    firstNs: null,
    lastNs: null,
    count: rows.length,
    rows,
    closedStacks: [],
  });
  return {
    t: 'list',
    nowNs: '1794474000000000000',
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    sections: [
      section('open', []),
      section(
        'parked',
        parked.map((id) =>
          row(id, { parked: true, parkedAtNs: String(1794474000000000000n - 60_000_000_000n) }),
        ),
      ),
      section(
        'week',
        week.map((id) => row(id)),
      ),
      section('earlier', []),
    ],
    doneHidden: 0,
    banner: null,
    terminals: [],
    selected: null,
    dirs: [],
  };
}

async function scriptedWorld(
  t: TestContext,
  chromium: Browser,
): Promise<{ page: Page; w: EditWorld }> {
  const page = await newPage(t, chromium);
  const w = await editWorld(t, page, listOf([S1, S2, S3]));
  await untilDrawn(page, (rows) => rows.length === 3, 'three rows');
  return { page, w };
}

test('F44: the selection after w, with the moment of the list held still', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'the list that shows the row gone decides, before the answer: the next row is selected then; the answer only shows the toast',
    async (t) => {
      const { page, w } = await scriptedWorld(t, chromium);
      await pick(page, S2);
      await page.keyboard.press('w');
      const act = await w.act(1);
      assert.equal(act['kind'], 'park');
      // An older list, the row still in its section: nothing moves.
      w.list(listOf([S1, S2, S3]));
      await sleep(200);
      assert.equal(await selectedRow(page), S2);
      // The list that carries the parking, before the answer: the selection moves there.
      w.list(listOf([S1, S3], [S2]));
      await selectionIs(page, S3, 'at the list that shows it gone');
      assert.deepEqual(await toast(page), { text: '', undo: false }, 'no toast before the answer');
      w.answer(act, { ok: true });
      await until(async () => (await toast(page)).text === PARKED, 'the toast at the answer');
      assert.equal(await selectedRow(page), S3);
    },
  );

  await t.test(
    'the answer first: the page asks for a list (a view), and that list decides',
    async (t) => {
      const { page, w } = await scriptedWorld(t, chromium);
      await pick(page, S2);
      await page.keyboard.press('w');
      const act = await w.act(1);
      const views = w.sent.filter((message) => message['t'] === 'view').length;
      w.list(listOf([S1, S3], [S2]), { send: false }); // the answer to the next view
      w.answer(act, { ok: true });
      await until(
        () => w.sent.filter((message) => message['t'] === 'view').length > views,
        'a view after the answer',
      );
      await selectionIs(page, S3, 'at the list the view brought');
    },
  );

  await t.test(
    'the user moves the selection before the list comes: it stays where they put it',
    async (t) => {
      const { page, w } = await scriptedWorld(t, chromium);
      await pick(page, S2);
      await page.keyboard.press('w');
      const act = await w.act(1);
      await page.keyboard.press('ArrowUp');
      await selectionIs(page, S1, 'moved by the user');
      w.list(listOf([S1, S3], [S2]));
      w.answer(act, { ok: true });
      await until(async () => (await toast(page)).text === PARKED, 'the toast');
      await sleep(200);
      assert.equal(await selectedRow(page), S1);
    },
  );

  await t.test(
    'w on the only row of its section: none selected, the next lists select nothing, ↓ starts from the first row',
    async (t) => {
      const page = await newPage(t, chromium);
      const w = await editWorld(t, page, listOf([S1], [S2, S3]));
      await untilDrawn(page, (rows) => rows.length === 3, 'three rows');
      await pick(page, S1);
      await page.keyboard.press('w');
      const act = await w.act(1);
      w.list(listOf([], [S1, S2, S3]));
      await selectionIs(page, null, 'none');
      w.answer(act, { ok: true });
      w.list(listOf([], [S1, S2, S3]));
      await sleep(200);
      assert.equal(await selectedRow(page), null, 'a later list selects nothing');
      assert.equal(w.selected(), null, 'the view says none');
      assert.equal(await zone(page), 'Focus: list');
      await page.keyboard.press('ArrowDown');
      await selectionIs(page, S1, '↓ from the first row');
    },
  );

  await t.test('a refused w moves nothing, and its line is the refusal', async (t) => {
    const { page, w } = await scriptedWorld(t, chromium);
    await pick(page, S2);
    await page.keyboard.press('w');
    const act = await w.act(1);
    w.answer(act, { ok: false, error: "skydeck's database is busy; try again" });
    await until(
      async () => (await keyMessage(page)) === "skydeck's database is busy; try again",
      'the line',
    );
    w.list(listOf([S1, S3], [S2])); // a later list (another page parked it): it moves nothing
    await sleep(200);
    assert.equal(await selectedRow(page), S2);
    // A list later shows it parked by another window: nothing moves, w on it un-parks.
    await page.keyboard.press('w');
    const second = await w.act(2);
    assert.equal(second['kind'], 'unpark');
  });
});

// ---------------------------------------------------------------------------------------------
// The one guard, the Undo's words both ways and the toast of `d` under Parked, on the scripted
// stand-in: each act is answered first and the list that decides is held back (its `view` is not
// answered), so that the second key meets a session whose mark this page's list has not decided.

const TERM = 'aaaaaaaaaaaa';
const DONE_RUNNING = 'Marked done. Stays under Open while it runs; hidden once it stops.';

type Rows = {
  open?: Record<string, unknown>[];
  parked?: Record<string, unknown>[];
  week?: Record<string, unknown>[];
};

/** A scripted list of these rows, by section, and `terminals`. */
function listRows(
  sections: Rows,
  terminals: Record<string, unknown>[] = [],
): Record<string, unknown> {
  const base = listOf([]) as { sections: { name: string }[] } & Record<string, unknown>;
  return {
    ...base,
    sections: base.sections.map((section) => {
      const rows =
        (sections as Record<string, Record<string, unknown>[] | undefined>)[section.name] ?? [];
      return { ...section, count: rows.length, rows };
    }),
    terminals,
  };
}

/** A running session in the window's terminal TERM that the window can end. */
function endableRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return row(id, { state: 'waiting', terminal: TERM, slot: 1, endable: true, ...over });
}

function termOf(sessionId: string, slot: number | null): Record<string, unknown> {
  return {
    id: TERM,
    slot,
    sessionId,
    state: 'running',
    notReported: false,
    cols: 80,
    rows: 24,
    ownsSize: true,
    openedNs: '1794470400000000000',
  };
}

const PARKED_FIELDS = { parked: true, parkedAtNs: String(1794474000000000000n - 60_000_000_000n) };

/** Whether the end dialog ("Mark done") is shown. */
async function enderShown(page: Page): Promise<boolean> {
  return readPage(page, () => document.getElementById('end-dialog')?.hidden === false, null);
}

async function scripted(
  t: TestContext,
  chromium: Browser,
  first: Record<string, unknown>,
  count: number,
): Promise<{ page: Page; w: EditWorld }> {
  const page = await newPage(t, chromium);
  const w = await editWorld(t, page, first);
  await untilDrawn(page, (rows) => rows.length === count, `${count} rows`);
  return { page, w };
}

/** The kinds of `w`'s acts so far. */
const kinds = (w: EditWorld): unknown[] => w.acts().map((one) => one['kind']);

test('F44: the one guard, and the Undo that gives back what was there', async (t) => {
  const chromium = await browser(t);

  await t.test('w answered, its list held: a second w on the session sends nothing', async (t) => {
    const { page, w } = await scriptedWorld(t, chromium);
    await pick(page, S2);
    await page.keyboard.press('w');
    const act = await w.act(1);
    w.holdViews(true);
    w.answer(act, { ok: true });
    await until(async () => (await toast(page)).text === PARKED, 'the toast');
    await page.keyboard.press('w');
    await sleep(300);
    assert.deepEqual(kinds(w), ['park']);
  });

  await t.test(
    'w answered, its list held: d on the session sends nothing, and opens no end dialog on one the window can end',
    async (t) => {
      const { page, w } = await scripted(
        t,
        chromium,
        listRows({ open: [endableRow(S2), row(S3, { state: 'running', terminal: null })] }, [
          termOf(S2, 1),
        ]),
        2,
      );
      await pick(page, S2);
      await page.keyboard.press('w');
      const act = await w.act(1);
      w.holdViews(true);
      w.answer(act, { ok: true });
      await until(async () => (await toast(page)).text === PARKED_RUNNING, 'the toast');
      await page.keyboard.press('d');
      await sleep(300);
      assert.equal(await enderShown(page), false, 'no dialog');
      assert.deepEqual(kinds(w), ['park']);
    },
  );

  await t.test('d answered, its list held: w on the session sends nothing', async (t) => {
    const { page, w } = await scriptedWorld(t, chromium);
    await pick(page, S2);
    await page.keyboard.press('d');
    const act = await w.act(1);
    assert.equal(act['kind'], 'done');
    w.holdViews(true);
    w.answer(act, { ok: true });
    await until(async () => (await toast(page)).text !== '', 'the toast');
    await page.keyboard.press('w');
    await sleep(300);
    assert.deepEqual(kinds(w), ['done']);
  });

  for (const [button, keys, kind] of [
    ['Mark done, keep it running', ['Enter'], 'done'],
    ['End session and mark done', ['ArrowLeft', 'Enter'], 'end-session'],
  ] as [string, string[], string][]) {
    await t.test(
      `the end dialog's ${button}, answered, its list held: w and d on the session send nothing, and no dialog opens again`,
      async (t) => {
        const { page, w } = await scripted(
          t,
          chromium,
          listRows({ week: [row(S1)], open: [endableRow(S2)] }, [termOf(S2, 1)]),
          2,
        );
        await pick(page, S2);
        await page.keyboard.press('d');
        await until(() => enderShown(page), 'the dialog');
        for (const key of keys) await page.keyboard.press(key);
        const act = await w.act(1);
        assert.equal(act['kind'], kind);
        w.holdViews(true);
        w.answer(act, { ok: true, ...(kind === 'end-session' ? { ended: false } : {}) });
        await until(async () => (await toast(page)).undo, 'the toast');
        await toZone(page, 'list');
        await page.keyboard.press('w');
        await page.keyboard.press('d');
        await sleep(300);
        assert.equal(await enderShown(page), false, 'no dialog again');
        assert.deepEqual(kinds(w), [kind]);
      },
    );
  }

  await t.test('the Undo after parking a session marked done marks it done again', async (t) => {
    const { page, w } = await scripted(
      t,
      chromium,
      listRows({ week: [row(S1), row(S2, { done: true }), row(S3)] }),
      3,
    );
    await pick(page, S2);
    await page.keyboard.press('w');
    const act = await w.act(1);
    w.list(listRows({ week: [row(S1), row(S3)], parked: [row(S2, PARKED_FIELDS)] }));
    w.answer(act, { ok: true });
    await until(async () => (await toast(page)).undo, 'the Undo');
    await page.locator('#toast .toast-undo').click();
    assert.equal((await w.act(2))['kind'], 'done');
  });

  for (const [button, keys, kind, words] of [
    ['Mark done, keep it running', ['Enter'], 'done', DONE_RUNNING],
    ['End session and mark done', ['ArrowLeft', 'Enter'], 'end-session', ''],
  ] as [string, string[], string, string][]) {
    await t.test(
      `a parked running session marked done through ${button}: the toast ${words === '' ? 'of the end' : 'of a running session'}, and its Undo parks it again`,
      async (t) => {
        const { page, w } = await scripted(
          t,
          chromium,
          listRows(
            { week: [row(S1)], parked: [endableRow(S2, { slot: null, ...PARKED_FIELDS })] },
            [termOf(S2, null)],
          ),
          2,
        );
        await pick(page, S2);
        await page.keyboard.press('d');
        await until(() => enderShown(page), 'the dialog');
        for (const key of keys) await page.keyboard.press(key);
        const act = await w.act(1);
        assert.equal(act['kind'], kind);
        w.list(
          listRows({ week: [row(S1)], open: [endableRow(S2, { slot: 1, done: true })] }, [
            termOf(S2, 1),
          ]),
        );
        w.answer(act, { ok: true, ...(kind === 'end-session' ? { ended: false } : {}) });
        await until(async () => (await toast(page)).undo, 'the Undo');
        if (words !== '')
          assert.equal((await toast(page)).text, words, 'it runs: the running words');
        await page.locator('#toast .toast-undo').click();
        assert.equal((await w.act(2))['kind'], 'park');
      },
    );
  }

  await t.test(
    'an Undo whose session the next list does not list (a done running row that stopped meanwhile) selects it no more, also when a later list lists it',
    async (t) => {
      const running = { state: 'running', terminal: null };
      const { page, w } = await scripted(
        t,
        chromium,
        listRows({ open: [row(S2, { ...running, done: true }), row(S4, running)] }),
        2,
      );
      await pick(page, S2);
      await page.keyboard.press('w');
      const act = await w.act(1);
      w.list(
        listRows({ open: [row(S4, running)], parked: [row(S2, { ...running, ...PARKED_FIELDS })] }),
      );
      await selectionIs(page, S4, 'the next row');
      w.answer(act, { ok: true });
      await until(async () => (await toast(page)).undo, 'the Undo');
      w.holdViews(true);
      await page.locator('#toast .toast-undo').click();
      const undo = await w.act(2);
      assert.equal(undo['kind'], 'done');
      w.answer(undo, { ok: true });
      // S2 stopped meanwhile: done and stopped, it is hidden.
      w.list(listRows({ open: [row(S4, running)] }));
      await sleep(200);
      // Later (done sessions shown, say) it is listed again: the Undo is long over.
      w.list(listRows({ open: [row(S4, running)], week: [row(S2, { done: true })] }));
      await sleep(300);
      assert.equal(await selectedRow(page), S4);
    },
  );
});
