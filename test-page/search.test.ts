// The list's search and stacks on the page (S2 12.2, 12.8, 12.9's list zone; plan E task 97, E4–E7):
// the filter's words and the short id, the chips under the filter field, done sessions while
// filtering, and the stacks of This week and Earlier with their `×n`, their `+n more` line and
// their keys. The rules are the server's (task 96): every case runs a real test server on
// realTestPlatform with sessions made the way step 1 sees them (transcripts, the store's meta,
// pull requests saved with `savePrResult`), and the page draws what that server sends.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import { attachManualPr, markDone, setGroup, setNote } from '../src/sessions/meta.ts';
import { controlClient } from '../src/window/client.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { startTestServer } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  connection,
  PAGE_WAIT_MS,
  pageUrl,
  problemsOf,
  readPage,
  RECORDER,
  resumeFromList,
  selectedRow,
  showsText,
  shownText,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4e1a-8b8c-7d6e5f4a3b2c';
const S7 = '6b1f9c7e-4d8a-4f2b-9c9d-8e7f6a5b4c3d';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const DAY = 86_400n * SEC;

// ---------------------------------------------------------------------------------------------
// Sessions as step 1 sees them

/** A session last active `agoNs` before now, titled `title` (a `custom-title` record). */
function session(d: ServerSandbox, sessionId: string, agoNs: bigint, title: string): void {
  const dir = join(d.s.home, 'project');
  mkdirSync(dir, { recursive: true });
  const folder = join(d.s.claudeHome, 'projects', 'project');
  mkdirSync(folder, { recursive: true });
  const timestamp = isoFromNs(d.platform.clock.nowNs() - agoNs);
  const lines = [
    { type: 'user', sessionId, timestamp, cwd: dir, entrypoint: 'cli' },
    { type: 'custom-title', customTitle: title, sessionId, timestamp },
  ];
  writeFileSync(
    join(folder, `${sessionId}.jsonl`),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
}

/** Attaches the pull request `o/r#<number>` to `sessionId`, last read now as `state`. */
function pullRequest(
  d: ServerSandbox,
  sessionId: string,
  number: number,
  state: 'open' | 'merged',
): void {
  const url = `https://github.com/o/r/pull/${number}`;
  attachManualPr(d.deck, sessionId, url);
  d.deck.store.savePrResult(url, {
    ok: true,
    atNs: d.platform.clock.nowNs(),
    title: `PR ${number}`,
    state,
    review: null,
    checks: null,
  });
}

// ---------------------------------------------------------------------------------------------
// The page, with every `view` it sends recorded

/**
 * An init script that records in the page every `view` message the page sends, whole
 * (`sentViews`). It wraps whichever `send` WebSocket's prototype has when it runs, so that it
 * works before or after helpers/shell.ts's RECORDER (Playwright does not define their order).
 */
const VIEWS = `(() => {
  const views = [];
  Reflect.set(globalThis, 'sentViews', views);
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message !== null && message.t === 'view') views.push(message);
      } catch {}
    }
    return send.call(this, data);
  };
})();`;

/**
 * helpers/shell.ts's `launched` (a real test server; the page opened with a launch token, as
 * `skydeck window` opens it; connected), with VIEWS among its init scripts from the start, so
 * that the first views the page sends are recorded too.
 */
async function launchedWithViews(t: TestContext, chromium: Browser): Promise<Launched> {
  const page = await newPage(t, chromium);
  await page.addInitScript(RECORDER);
  await page.addInitScript(VIEWS);
  const problems = problemsOf(page);
  const started = await startTestServer(t);
  const { token } = await controlClient(started.d.platform.net, started.d.files.serverSock).token(
    30,
  );
  await page.goto(pageUrl(started.server.port, token));
  await connection(page, 'open');
  return { ...started, page, problems };
}

/** Every `view` the page sent so far, whole. */
async function sentViews(page: Page): Promise<Record<string, unknown>[]> {
  return readPage(
    page,
    () => (Reflect.get(globalThis, 'sentViews') ?? []) as Record<string, unknown>[],
    null,
  );
}

/** The last `view` the page sent. */
async function lastView(page: Page): Promise<Record<string, unknown>> {
  const last = (await sentViews(page)).at(-1);
  assert.ok(last !== undefined, 'the page sent a view');
  return last;
}

/** Waits until the last view the page sent names exactly `groups` as opened. */
async function untilOpened(page: Page, groups: string[]): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const last = (await sentViews(page)).at(-1);
    if (JSON.stringify(last?.['opened']) === JSON.stringify(groups)) return;
    if (performance.now() > deadline) {
      assert.fail(`the last view's opened is ${JSON.stringify(last?.['opened'])}`);
    }
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------
// What the list shows

/** One line of the list's body: a row, or a closed stack's `+n more` line. */
interface Line {
  kind: 'row' | 'more';
  /** A row's `data-id`; a `+n more` line's `data-head`. */
  id: string;
  section: string;
  /** `data-stack` ('head', 'member'), '' for a row in no stack and for the `+n more` line. */
  stack: string;
  /** The head's `×n`, '' when not shown. */
  badge: string;
  /** A row's title; the `+n more` line's text. */
  text: string;
  marks: string[];
  /** Where the row's state icon starts, in pixels from the list's left edge. */
  indent: number;
}

/** The lines the list draws, in order (visible ones only). */
async function lines(page: Page): Promise<Line[]> {
  return readPage(
    page,
    () => {
      const shown = (element: Element | null): string =>
        element instanceof HTMLElement && element.checkVisibility()
          ? (element.textContent ?? '')
          : '';
      const list = document.getElementById('list');
      const left = list?.getBoundingClientRect().left ?? 0;
      let section = '';
      const drawn = [];
      for (const element of document.querySelectorAll(
        '#list .list-section, #list .list-row, #list .list-more',
      )) {
        if (!(element instanceof HTMLElement) || !element.checkVisibility()) continue;
        if (element.classList.contains('list-section')) {
          section = element.dataset['section'] ?? '';
          continue;
        }
        const more = element.classList.contains('list-more');
        const icon = element.querySelector('.row-icon');
        drawn.push({
          kind: more ? ('more' as const) : ('row' as const),
          id: (more ? element.dataset['head'] : element.dataset['id']) ?? '',
          section,
          stack: more ? '' : (element.dataset['stack'] ?? ''),
          badge: shown(element.querySelector('.row-stack')),
          text: more ? (element.textContent ?? '') : shown(element.querySelector('.row-title')),
          marks: [...element.querySelectorAll('.row-mark')]
            .map(shown)
            .filter((text) => text !== ''),
          indent: Math.round((icon ?? element).getBoundingClientRect().left - left),
        });
      }
      return drawn;
    },
    null,
  );
}

/** The ids of the rows drawn, in order. */
async function rowIds(page: Page): Promise<string[]> {
  return (await lines(page)).filter((line) => line.kind === 'row').map((line) => line.id);
}

/** Waits until `check` holds for the lines the list draws; fails with what it drew. */
async function untilLines(
  page: Page,
  check: (drawn: Line[]) => boolean,
  what: string,
): Promise<Line[]> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const drawn = await lines(page);
    if (check(drawn)) return drawn;
    if (performance.now() > deadline) {
      assert.fail(`${what}: the list draws ${JSON.stringify(drawn, null, 1)}`);
    }
    await sleep(50);
  }
}

/** Waits until the rows drawn are exactly `ids`, in order. */
async function untilRows(page: Page, ids: string[], what: string): Promise<Line[]> {
  return untilLines(
    page,
    (drawn) =>
      drawn
        .filter((line) => line.kind === 'row')
        .map((line) => line.id)
        .join() === ids.join(),
    what,
  );
}

/** Waits until the selected row is `id`. */
async function untilSelected(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (id) => document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
    id,
    { timeout: PAGE_WAIT_MS },
  );
}

/** Where the keyboard is: the filter field, the list itself, the terminal, or what else. */
async function keyboardOn(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const element = document.activeElement;
      if (element === null || element === document.body) return 'nothing';
      if (element.classList.contains('list-filter')) return 'the filter';
      if (element.id === 'list') return 'the list';
      if (document.getElementById('terminal')?.contains(element) === true) return 'the terminal';
      return `${element.tagName}.${element.className}`;
    },
    null,
  );
}

/** The chips under the filter field: each one's text and `aria-pressed`. */
async function chips(page: Page): Promise<[string, string][]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#list .list-chips button')].map(
        (button) =>
          [button.textContent ?? '', button.getAttribute('aria-pressed') ?? ''] as [string, string],
      ),
    null,
  );
}

/** A click on the chip named `name` (`Running`, `Open PR`, `Has note`, `Show done`). */
async function clickChip(page: Page, name: string): Promise<void> {
  await page.locator('#list .list-chips button', { hasText: name }).click();
}

/**
 * The page of a real server reports no problem (no console error, nothing uncaught, no failed
 * load); the list keeps the hooks the shared helpers rely on — exactly one `#list [data-id]` per
 * drawn row (the `+n more` lines carry `data-head`, never `data-id`), `data-selected="true"` on one
 * row at most —; and every view the page sent holds `chips` and `opened` (E6: a view without
 * `opened` gets no stacks), each group in it a well-formed text of at most 1,024 bytes.
 */
async function healthy(page: Page, problems: readonly string[]): Promise<void> {
  assert.deepEqual(problems, [], 'the page reports no problem');
  const hooks = await readPage(
    page,
    () => ({
      ids: [...document.querySelectorAll('#list [data-id]')].map((e) => e.getAttribute('data-id')),
      rows: document.querySelectorAll('#list .list-row').length,
      selected: document.querySelectorAll('#list [data-selected="true"]').length,
      selectedRows: document.querySelectorAll('#list .list-row[data-selected="true"]').length,
    }),
    null,
  );
  assert.equal(new Set(hooks.ids).size, hooks.ids.length, 'one element per session id');
  assert.equal(hooks.ids.length, hooks.rows, 'only the rows carry data-id');
  assert.ok(hooks.selected <= 1, 'data-selected on one row at most');
  assert.equal(hooks.selected, hooks.selectedRows, 'data-selected on rows only');
  const views = await sentViews(page);
  assert.ok(views.length > 0, 'the page sent views');
  for (const view of views) {
    assert.ok(Array.isArray(view['opened']), `every view holds opened: ${JSON.stringify(view)}`);
    assert.ok(Array.isArray(view['chips']), `every view holds chips: ${JSON.stringify(view)}`);
    const opened = view['opened'] as unknown[];
    assert.ok(opened.length <= 64, 'at most 64 groups');
    for (const group of opened) {
      assert.equal(typeof group, 'string');
      assert.ok((group as string).isWellFormed());
      assert.ok(Buffer.byteLength(group as string) <= 1024, 'a group of at most 1,024 bytes');
    }
  }
}

// ---------------------------------------------------------------------------------------------

test('search and stacks in the list', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'the filter: two words typed → the rows that have both; the first characters of a short id → its row; a done session that matches is listed with `done`, and the footer is gone; the field names the short id',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'alpha login fix');
      session(d, S2, 3n * MIN, 'beta login');
      session(d, S3, 4n * MIN, 'alpha deploy');
      session(d, S4, 5n * MIN, 'alpha login done');
      markDone(d.deck, S4);
      await untilRows(page, [S1, S2, S3], 'This week');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.match(
        (await page.getAttribute('#list .list-filter', 'placeholder')) ?? '',
        /short id/,
      );

      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('login alpha');
      const matched = await untilRows(page, [S1, S4], 'both words, in any order');
      assert.deepEqual(
        matched.map((line) => line.marks),
        [[], ['done']],
      );
      assert.equal(await shownText(page, '#list .list-footer'), '', 'no footer while filtering');

      await page.keyboard.press('Escape');
      await untilRows(page, [S1, S2, S3], 'the filter cleared');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      await page.keyboard.press('/');
      await page.keyboard.type(S3.slice(0, 6));
      await untilRows(page, [S3], 'the short id');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'the chips: Running, Open PR, Has note and Show done under the filter field; each pressed → aria-pressed and the rows the server sent, every chip set holding, the keyboard where it was; a chip that matches nothing → `No session matches the filter.`; nothing folds while a chip is set',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'with an open pull request and a note'); // open PR + note
      session(d, S2, 3n * MIN, 'with a merged pull request'); // merged PR
      session(d, S3, 4n * MIN, 'with a note'); // note
      session(d, S4, 5n * MIN, 'plain'); // nothing
      session(d, S5, 20n * DAY, 'old with a note'); // Earlier, note
      pullRequest(d, S1, 1, 'open');
      setNote(d.deck, S1, 'the open one');
      pullRequest(d, S2, 2, 'merged');
      setNote(d.deck, S3, 'only a note');
      setNote(d.deck, S5, 'an old note');
      await untilRows(page, [S1, S2, S3, S4], 'This week, Earlier folded');
      assert.deepEqual(await chips(page), [
        ['Running', 'false'],
        ['Open PR', 'false'],
        ['Has note', 'false'],
        ['Show done', 'false'],
      ]);

      // Running with nothing running: the list says so; the keyboard stays on the list.
      await toZone(page, 'list');
      await clickChip(page, 'Running');
      await showsText(page, '#list .list-empty', /^No session matches the filter\.$/);
      assert.deepEqual(await rowIds(page), []);
      assert.equal(await keyboardOn(page), 'the list');
      assert.deepEqual(
        (await chips(page)).map(([, pressed]) => pressed),
        ['true', 'false', 'false', 'false'],
      );
      assert.deepEqual((await lastView(page))['chips'], ['running']);
      await clickChip(page, 'Running');
      await untilRows(page, [S1, S2, S3, S4], 'Running off');

      // Open PR, from the filter field: the keyboard stays in the field.
      await page.keyboard.press('/');
      assert.equal(await keyboardOn(page), 'the filter');
      await clickChip(page, 'Open PR');
      await untilRows(page, [S1], 'Open PR: the open one, not the merged one');
      assert.equal(await keyboardOn(page), 'the filter');
      // With Has note too: every chip set must hold.
      await clickChip(page, 'Has note');
      await untilRows(page, [S1], 'Open PR and Has note');
      assert.deepEqual((await lastView(page))['chips'], ['open-pr', 'note']);
      await clickChip(page, 'Open PR');
      // Has note alone: Earlier is unfolded while a chip is set.
      const noted = await untilRows(page, [S1, S3, S5], 'Has note');
      assert.deepEqual(
        noted.map((line) => line.section),
        ['week', 'week', 'earlier'],
      );
      assert.equal(await keyboardOn(page), 'the filter');
      assert.deepEqual(
        (await chips(page)).map(([, pressed]) => pressed),
        ['false', 'false', 'true', 'false'],
      );

      // Nothing folds while a chip is set: neither ← on Earlier's row nor a click on its header.
      await page.keyboard.press('Enter'); // the keyboard back to the list
      await page.locator(`#list [data-id="${S5}"]`).click();
      await untilSelected(page, S5);
      await sleep(300);
      const before = (await sentViews(page)).length;
      await page.keyboard.press('ArrowLeft');
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S3, S5], 'Earlier stays unfolded');
      assert.equal(await selectedRow(page), S5, 'and the selection on its row');
      assert.equal((await sentViews(page)).length, before, 'no view: nothing folded');
      await clickChip(page, 'Has note');
      await untilRows(page, [S1, S2, S3, S4], 'no chip: Earlier folded as before');

      // Running, once a session runs: from the terminal the keyboard stays in the terminal.
      await resumeFromList(page, S4);
      assert.equal(await keyboardOn(page), 'the terminal');
      await clickChip(page, 'Running');
      const running = await untilRows(page, [S4], 'Running');
      assert.deepEqual(
        running.map((line) => line.section),
        ['open'],
      );
      assert.equal(await keyboardOn(page), 'the terminal');
      await clickChip(page, 'Running');
      await untilRows(page, [S4, S1, S2, S3], 'Running off');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "`Show done`, the list key `a` and the footer's `show` are one state: each turns the others on, and off",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'open one');
      session(d, S2, 3n * MIN, 'done one');
      markDone(d.deck, S2);
      await untilRows(page, [S1], 'the done session hidden');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      const showDone = async (): Promise<string | undefined> =>
        (await chips(page)).find(([name]) => name === 'Show done')?.[1];

      await toZone(page, 'list');
      await clickChip(page, 'Show done');
      await untilRows(page, [S1, S2], 'the chip shows them');
      assert.equal(await showDone(), 'true');
      await showsText(page, '#list .list-footer', /^done sessions shown · hide$/);
      assert.equal(await keyboardOn(page), 'the list');

      await page.keyboard.press('a');
      await untilRows(page, [S1], '`a` hides them');
      assert.equal(await showDone(), 'false');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);

      await page.keyboard.press('a');
      await untilRows(page, [S1, S2], '`a` shows them');
      assert.equal(await showDone(), 'true');

      await page.locator('#list .footer-action', { hasText: 'hide' }).click();
      await untilRows(page, [S1], 'the footer hides them');
      assert.equal(await showDone(), 'false');
      await page.locator('#list .footer-action', { hasText: 'show' }).click();
      await untilRows(page, [S1, S2], 'the footer shows them');
      assert.equal(await showDone(), 'true');

      await clickChip(page, 'Show done');
      await untilRows(page, [S1], 'the chip hides them');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.equal((await lastView(page))['showDone'], false);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a stack: three sessions of ORB-1 in This week → one row with ×3 and the line `+2 more in ORB-1`; a click on the line → three rows, the members indented and marked; ← on a member → the head selected and the stack closed; → on the head → open; ← on the head → closed; ↓ from a closed head skips its members and the line; ← → on a row in no stack fold and unfold Earlier as before; a click on ×3 opens and closes, and with a member selected selects the head first',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      session(d, S5, 20n * DAY, 'old work');
      const closed = await untilLines(
        page,
        (drawn) => drawn.map((line) => line.id).join() === [S1, S1, S4].join(),
        'the closed stack',
      );
      assert.deepEqual(
        closed.map(({ kind, id, stack, badge, text }) => ({ kind, id, stack, badge, text })),
        [
          { kind: 'row', id: S1, stack: 'head', badge: '×3', text: 'first' },
          { kind: 'more', id: S1, stack: '', badge: '', text: '+2 more in ORB-1' },
          { kind: 'row', id: S4, stack: '', badge: '', text: 'plain work' },
        ],
      );
      assert.equal(await selectedRow(page), S1, 'the head is the first row');
      assert.deepEqual((await lastView(page))['opened'], []);

      // ↓ from the closed head: the next row in no stack (the members and the line are skipped).
      await toZone(page, 'list');
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S4);
      await page.keyboard.press('ArrowUp');
      await untilSelected(page, S1);

      // A click on the line opens the stack; the keyboard stays on the list.
      await page.locator(`#list .list-more[data-head="${S1}"]`).click();
      const open = await untilRows(page, [S1, S2, S3, S4], 'the stack open');
      assert.deepEqual(
        open.map((line) => [line.id, line.stack, line.badge]),
        [
          [S1, 'head', '×3'],
          [S2, 'member', ''],
          [S3, 'member', ''],
          [S4, '', ''],
        ],
      );
      const [head, first, second, plain] = open;
      assert.ok(first !== undefined && head !== undefined && second !== undefined);
      assert.ok(first.indent > head.indent, 'a member is indented');
      assert.equal(second.indent, first.indent);
      assert.equal(plain?.indent, head.indent);
      assert.equal(open.filter((line) => line.kind === 'more').length, 0, 'no line while open');
      assert.equal(await keyboardOn(page), 'the list');
      await untilOpened(page, ['ORB-1']);

      // ← on a member: the head selected and the stack closed.
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S4], '← on a member closes the stack');
      assert.equal(await selectedRow(page), S1);
      await untilOpened(page, []);

      // → on the closed head opens it, ← on the open head closes it.
      await page.keyboard.press('ArrowRight');
      await untilRows(page, [S1, S2, S3, S4], '→ on the head');
      await untilOpened(page, ['ORB-1']);
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S4], '← on the head');
      await untilOpened(page, []);
      assert.equal(await selectedRow(page), S1);

      // On a row in no stack ← and → fold and unfold Earlier, as in stage A.
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S4);
      await page.keyboard.press('ArrowRight');
      await untilRows(page, [S1, S4, S5], '→ unfolds Earlier');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S4], '← folds Earlier');
      assert.equal(await selectedRow(page), S4);

      // A click on ×3 opens and closes the stack and leaves the selection and the keyboard.
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S2, S3, S4], 'a click on ×3 opens');
      assert.equal(await selectedRow(page), S4);
      assert.equal(await keyboardOn(page), 'the list');
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S4], 'a click on ×3 closes');
      assert.equal(await selectedRow(page), S4);

      // With a member selected, a click on ×3 that closes the stack selects the head first.
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S2, S3, S4], 'open again');
      await page.locator(`#list [data-id="${S3}"]`).click();
      await untilSelected(page, S3);
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S4], 'closed with its member selected');
      assert.equal(await selectedRow(page), S1);
      await untilOpened(page, []);
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S4], 'and it stays closed');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a selected session that becomes a member of a closed stack → the stack is open, the page adds its group to `opened`, and it stays open when the selection goes to a row outside it; Ctrl+Tab back to a member of the open stack selects it; a filter → no stack',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilRows(page, [S2, S4], 'the closed stack of two');
      assert.equal(await selectedRow(page), S2, 'its head selected (the first row)');
      await untilOpened(page, []);

      // A newer session of ORB-1: it is the head now, and the selected S2 one of its members. The
      // server opens the stack for the selection (E6); the page remembers it.
      session(d, S1, 1n * MIN, 'ORB-1 first');
      const open = await untilRows(page, [S1, S2, S3, S4], 'open for its selected member');
      assert.deepEqual(
        open.map((line) => line.stack),
        ['head', 'member', 'member', ''],
      );
      assert.equal(await selectedRow(page), S2);
      await untilOpened(page, ['ORB-1']);

      // The selection leaves the stack: it stays open.
      await toZone(page, 'list');
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S4], 'the stack stays open');
      assert.deepEqual((await lastView(page))['opened'], ['ORB-1']);
      // Ctrl+Tab back to the member: selected, the stack still open.
      await page.keyboard.press('Control+Tab');
      await untilSelected(page, S2);
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S4]);
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);

      // A filter flattens every stack: no head, no member, no badge, no line.
      await page.keyboard.press('/');
      await page.keyboard.type('orb');
      const flat = await untilRows(page, [S1, S2, S3], 'the filter');
      assert.deepEqual(
        flat.map((line) => [line.stack, line.badge]),
        [
          ['', ''],
          ['', ''],
          ['', ''],
        ],
      );
      // While filtering the keys of a stack do nothing to it: ← folds nothing either.
      await page.keyboard.press('Enter');
      await page.locator(`#list [data-id="${S2}"]`).click();
      await page.keyboard.press('ArrowLeft');
      await sleep(300);
      assert.deepEqual(await rowIds(page), [S1, S2, S3]);
      await page.keyboard.press('Escape');
      await untilRows(page, [S1, S2, S3, S4], 'the filter cleared: the stack open again');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "`d` on a closed stack's head marks that session only: the next member is the head (×2, `+1 more`); stage D's selection after `d` takes the row after it of those drawn when `d` was pressed — the row after the stack, whose members were not drawn",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilRows(page, [S1, S4], 'the closed stack');
      assert.equal(await selectedRow(page), S1);
      await toZone(page, 'list');
      await page.keyboard.press('d');
      const after = await untilLines(
        page,
        (drawn) =>
          drawn.map((line) => `${line.kind}${line.id}`).join() === `row${S2},more${S2},row${S4}`,
        'S2 the head of the two left',
      );
      assert.equal(after[0]?.badge, '×2');
      assert.equal(after[1]?.text, '+1 more in ORB-1');
      await untilSelected(page, S4);
      await sleep(500);
      assert.equal(await selectedRow(page), S4, 'the selection stays there');
      assert.deepEqual((await lastView(page))['opened'], [], 'the stack stays closed');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a group of 1,025 bytes is never in a view the page sends (its stack opens only while a member is selected); one of 1,024 bytes is',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      const long = 'g'.repeat(1025);
      const fits = 'f'.repeat(1024);
      // The member of the long group first, alone: the page selects it (its first row).
      session(d, S2, 2n * MIN, 'long member');
      setGroup(d.deck, S2, long);
      await untilRows(page, [S2], 'one row');
      assert.equal(await selectedRow(page), S2);
      // Its head comes: the stack is open while its member is selected.
      session(d, S1, 1n * MIN, 'long head');
      setGroup(d.deck, S1, long);
      const open = await untilRows(page, [S1, S2], 'the long stack open for its member');
      assert.deepEqual(
        open.map((line) => line.stack),
        ['head', 'member'],
      );
      await sleep(500);
      assert.deepEqual((await lastView(page))['opened'], [], 'its group is not sent');

      // The selection leaves the member: the stack closes; → and clicks cannot open it.
      await toZone(page, 'list');
      await page.keyboard.press('ArrowUp');
      await untilSelected(page, S1);
      await untilLines(
        page,
        (drawn) => drawn.map((line) => `${line.kind}${line.id}`).join() === `row${S1},more${S1}`,
        'closed',
      );
      await page.keyboard.press('ArrowRight');
      await page.locator(`#list .list-more[data-head="${S1}"]`).click();
      // (Its ×2 stands after the group's 1,025 characters, past the list's edge: a click event.)
      await page.locator(`#list [data-id="${S1}"] .row-stack`).dispatchEvent('click');
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1], 'it stays closed');

      // A group of 1,024 bytes is sent: its stack opens.
      session(d, S3, 3n * MIN, 'fits head');
      session(d, S4, 4n * MIN, 'fits member');
      setGroup(d.deck, S3, fits);
      setGroup(d.deck, S4, fits);
      await untilRows(page, [S1, S3], 'two closed stacks');
      await page.locator(`#list .list-more[data-head="${S3}"]`).click();
      await untilRows(page, [S1, S3, S4], 'the stack of 1,024 bytes open');
      await untilOpened(page, [fits]);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a hostile group in the `+n more` line and a hostile title on a member are text',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      const hostile = '<img src=x onerror="window.pwned=1">';
      const hostileTitle = '<img src=y onerror="window.pwned=2"> a member';
      session(d, S1, 1n * MIN, 'the head');
      session(d, S2, 2n * MIN, hostileTitle);
      session(d, S6, 3n * MIN, 'another');
      session(d, S7, 4n * MIN, 'plain');
      for (const id of [S1, S2, S6]) setGroup(d.deck, id, hostile);
      const closed = await untilLines(
        page,
        (drawn) => drawn.some((line) => line.kind === 'more'),
        'the closed stack',
      );
      assert.deepEqual(closed.find((line) => line.kind === 'more')?.text, `+2 more in ${hostile}`);
      await page.locator(`#list .list-more[data-head="${S1}"]`).click();
      const open = await untilRows(page, [S1, S2, S6, S7], 'open');
      assert.equal(open[1]?.stack, 'member');
      assert.equal(open[1]?.text, hostileTitle);
      assert.equal(await page.evaluate(() => document.querySelector('#list img')), null);
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, 'pwned')), undefined);
      await untilOpened(page, [hostile]);
      await healthy(page, l.problems);
    },
  );
});
