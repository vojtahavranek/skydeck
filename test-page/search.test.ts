// The list's search and blocks on the page (S2 12.2, 12.8, 12.9's list zone; plan E task 97, E4–E7,
// E6 and E7 as ruled 2026-11-16 for follow-up F3): the filter's words and the short id, the chips
// under the filter field, done sessions while filtering, and the blocks of one group in every
// section — open by default — with their `×n`, a closed one's `+n more` line and their keys. (The
// code and the protocol call a block a stack: `data-stack`, `.row-stack`, `row.stack`.) The rules are the server's (task 96): every case runs a real test server on
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
import type { ClosedBlock } from '../src/window/protocol.ts';
import { stackRows } from '../src/window/view/search/stacks.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { startTestServer } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  after,
  connection,
  editWorld,
  logOf,
  mark,
  PAGE_WAIT_MS,
  pageUrl,
  problemsOf,
  readPage,
  RECORDER,
  resumeFromList,
  scriptedList,
  selectedRow,
  showsText,
  shownText,
  TERM_A,
  TERM_B,
  termOf,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import { inputOf, resumeHere, until } from './helpers/terminal.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4e1a-8b8c-7d6e5f4a3b2c';
const S7 = '6b1f9c7e-4d8a-4f2b-9c9d-8e7f6a5b4c3d';
const S8 = '7c2a0d8f-5e9b-4a3c-8dae-9f8a7b6c5d4e';

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

/** `view.closed`'s entries: each of `groups` closed in `section`. */
function shut(section: ClosedBlock['section'], ...groups: string[]): ClosedBlock[] {
  return groups.map((group) => ({ section, group }));
}

/** Waits until the last view the page sent names exactly `entries` as closed. */
async function untilClosed(page: Page, entries: ClosedBlock[]): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const last = (await sentViews(page)).at(-1);
    if (JSON.stringify(last?.['closed']) === JSON.stringify(entries)) return;
    if (performance.now() > deadline) {
      assert.fail(`the last view's closed is ${JSON.stringify(last?.['closed'])}`);
    }
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------
// What the list shows

/** One line of the list's body: a row, or a closed block's `+n more` line. */
interface Line {
  kind: 'row' | 'more';
  /** A row's `data-id`; a `+n more` line's `data-head`. */
  id: string;
  section: string;
  /** `data-stack` ('head', 'member'), '' for a row in no block and for the `+n more` line. */
  stack: string;
  /** The head's `×n`, '' when not shown. */
  badge: string;
  /** A row's slot number, '' when none is shown. */
  slot: string;
  /** A row's title; the `+n more` line's whole text. */
  text: string;
  /** The `+n more` line's part ` · 1 needs you`, '' when not shown (and for a row). */
  need: string;
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
          slot: more ? '' : shown(element.querySelector('.row-slot')),
          text: more ? (element.textContent ?? '') : shown(element.querySelector('.row-title')),
          need: more ? shown(element.querySelector('.more-need')) : '',
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
 * A double click at a human pace on the centre of `selector`: the first click, then `between`
 * (the list has redrawn under the pointer meanwhile, as it does within a person's double click),
 * then the second press, with the click count Chromium gives the second click of a double click.
 */
async function doubleClick(
  page: Page,
  selector: string,
  between: () => Promise<unknown>,
): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box !== null, selector);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await between();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

/** The types of the messages the page sent after the mark `name` (helpers/shell.ts's log). */
async function sentAfter(page: Page, name: string): Promise<string[]> {
  return after(await logOf(page), name)
    .filter((entry) => entry.e === 'out')
    .map((entry) => entry.t ?? '');
}

/**
 * The page of a real server reports no problem (no console error, nothing uncaught, no failed
 * load); the list keeps the hooks the shared helpers rely on — exactly one `#list [data-id]` per
 * drawn row (the `+n more` lines carry `data-head`, never `data-id`), `data-selected="true"` on one
 * row at most —; and every view the page sent holds `chips` and `closed` and no `opened` (the
 * field `closed` replaced), at most 64 entries, each exactly a section and a group, the group a
 * well-formed text of at most 1,024 bytes, each entry once.
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
    assert.ok(Array.isArray(view['closed']), `every view holds closed: ${JSON.stringify(view)}`);
    assert.ok(Array.isArray(view['chips']), `every view holds chips: ${JSON.stringify(view)}`);
    assert.ok(!Object.hasOwn(view, 'opened'), 'no view holds opened');
    const closed = view['closed'] as unknown[];
    assert.ok(closed.length <= 64, 'at most 64 entries');
    const seen = new Set<string>();
    for (const entry of closed) {
      assert.deepEqual(Object.keys(entry as object).sort(), ['group', 'section']);
      const { section, group } = entry as { section: unknown; group: unknown };
      assert.ok(['open', 'week', 'earlier'].includes(section as string), String(section));
      assert.equal(typeof group, 'string');
      assert.ok((group as string).isWellFormed());
      assert.ok(Buffer.byteLength(group as string) <= 1024, 'a group of at most 1,024 bytes');
      const key = JSON.stringify([section, group]);
      assert.ok(!seen.has(key), 'each entry once');
      seen.add(key);
    }
  }
}

// ---------------------------------------------------------------------------------------------

test('search and stacks in the list', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "every view the page sends holds `closed` (`[]` at least) and `chips`: the page's first view (the welcome's), a select's, and the list's own",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'ORB-1 one');
      session(d, S2, 3n * MIN, 'ORB-1 two');
      session(d, S3, 4n * MIN, 'plain');
      setNote(d.deck, S1, 'a note');
      await untilRows(page, [S1, S2, S3], 'an open block and a row');
      const [first] = await sentViews(page);
      assert.deepEqual(
        { selected: first?.['selected'], chips: first?.['chips'], closed: first?.['closed'] },
        { selected: null, chips: [], closed: [] },
        "the first view (the welcome's): nothing selected yet",
      );

      // A select's view (app.js's), then the list's own (a block closed, a chip).
      await toZone(page, 'list');
      await page.keyboard.press('End');
      await untilSelected(page, S3);
      const selects = (await sentViews(page)).filter((view) => view['selected'] === S3);
      assert.ok(selects.length > 0, 'a view with the selection');
      for (const view of selects) {
        assert.deepEqual([view['chips'], view['closed']], [[], []], "a select's view");
      }
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilClosed(page, shut('week', 'ORB-1'));
      await untilRows(page, [S1, S3], 'the block closed');
      await clickChip(page, 'Has note');
      await untilRows(page, [S1], 'Has note');
      assert.deepEqual(
        { chips: (await lastView(page))['chips'], closed: (await lastView(page))['closed'] },
        { chips: ['note'], closed: shut('week', 'ORB-1') },
        'the list keeps both, each sent whole',
      );
      await page.keyboard.press('ArrowUp');
      await untilSelected(page, S1);
      assert.deepEqual(
        { chips: (await lastView(page))['chips'], closed: (await lastView(page))['closed'] },
        { chips: ['note'], closed: shut('week', 'ORB-1') },
        'a select after them holds them too',
      );
      await healthy(page, l.problems);
    },
  );

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

      // While filtering the footer is not shown, with done sessions shown too (E5).
      await page.keyboard.press('/');
      await page.keyboard.type('one');
      await untilRows(page, [S1, S2], 'a filter while done ones are shown');
      await page.waitForFunction(
        () => document.querySelector('#list .list-footer')?.closest('[hidden]') !== null,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      await page.keyboard.press('Escape');
      await showsText(page, '#list .list-footer', /^done sessions shown · hide$/);

      await clickChip(page, 'Show done');
      await untilRows(page, [S1], 'the chip hides them');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.equal((await lastView(page))['showDone'], false);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a block: three sessions of ORB-1 in This week → OPEN by default: the head with ×3, the members indented, no line; ← on the head → closed, the line `+2 more in ORB-1`; ↓ from a closed head skips its members and the line; → on the head → open; ← on a member → the head selected and the block closed; a click on the line → open; ← → on a row in no block fold and unfold Earlier as before; a click on ×3 closes and opens, and with a member selected leaves the block open, the selection where it was and says why',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      session(d, S5, 20n * DAY, 'old work');
      const open = await untilRows(page, [S1, S2, S3, S4], 'the block, open by default');
      assert.deepEqual(
        open.map(({ kind, id, stack, badge, text }) => ({ kind, id, stack, badge, text })),
        [
          { kind: 'row', id: S1, stack: 'head', badge: '×3', text: 'first' },
          { kind: 'row', id: S2, stack: 'member', badge: '', text: 'second' },
          { kind: 'row', id: S3, stack: 'member', badge: '', text: 'third' },
          { kind: 'row', id: S4, stack: '', badge: '', text: 'plain work' },
        ],
      );
      const [head, first, second, plain] = open;
      assert.ok(first !== undefined && head !== undefined && second !== undefined);
      assert.ok(first.indent > head.indent, 'a member is indented');
      assert.equal(second.indent, first.indent);
      assert.equal(plain?.indent, head.indent);
      assert.equal(await selectedRow(page), S1, 'the head is the first row');
      assert.deepEqual((await lastView(page))['closed'], []);

      // ← on the open head closes the block: its line, the members left out.
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      const closed = await untilLines(
        page,
        (drawn) => drawn.map((line) => line.id).join() === [S1, S1, S4].join(),
        'the closed block',
      );
      assert.deepEqual(
        closed.map(({ kind, id, stack, badge, text, need }) => ({
          kind,
          id,
          stack,
          badge,
          text,
          need,
        })),
        [
          { kind: 'row', id: S1, stack: 'head', badge: '×3', text: 'first', need: '' },
          { kind: 'more', id: S1, stack: '', badge: '', text: '+2 more in ORB-1', need: '' },
          { kind: 'row', id: S4, stack: '', badge: '', text: 'plain work', need: '' },
        ],
      );
      await untilClosed(page, shut('week', 'ORB-1'));
      assert.equal(await selectedRow(page), S1);

      // ↓ from the closed head: the next row in no block (the members and the line are skipped).
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S4);
      await page.keyboard.press('ArrowUp');
      await untilSelected(page, S1);

      // → on the closed head opens it; ← on a member: the head selected and the block closed.
      await page.keyboard.press('ArrowRight');
      await untilRows(page, [S1, S2, S3, S4], '→ on the head');
      await untilClosed(page, []);
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S4], '← on a member closes the block');
      assert.equal(await selectedRow(page), S1);
      await untilClosed(page, shut('week', 'ORB-1'));

      // A click on the line opens the block; the keyboard stays on the list.
      await page.locator(`#list .list-more[data-head="${S1}"]`).click();
      await untilRows(page, [S1, S2, S3, S4], 'a click on the line');
      assert.equal(await keyboardOn(page), 'the list');
      await untilClosed(page, []);

      // On a row in no block ← and → fold and unfold Earlier, as in stage A.
      await page.keyboard.press('End');
      await untilSelected(page, S4);
      await page.keyboard.press('ArrowRight');
      await untilRows(page, [S1, S2, S3, S4, S5], '→ unfolds Earlier');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S2, S3, S4], '← folds Earlier');
      assert.equal(await selectedRow(page), S4);

      // A click on ×3 closes and opens the block and leaves the selection and the keyboard.
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S4], 'a click on ×3 closes');
      assert.equal(await selectedRow(page), S4);
      assert.equal(await keyboardOn(page), 'the list');
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S2, S3, S4], 'a click on ×3 opens');
      assert.equal(await selectedRow(page), S4);

      // With a member selected, a click on ×3 does not close the block: the selection stays and
      // the key bar says why (ruled 2026-11-16); ← on the member selects the head and closes it.
      await page.locator(`#list [data-id="${S3}"]`).click();
      await untilSelected(page, S3);
      const views = (await sentViews(page)).length;
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await showsText(
        page,
        '#key-message',
        /^this block holds the selected session; it stays open$/,
      );
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S4], 'still open');
      assert.equal(await selectedRow(page), S3);
      assert.equal((await sentViews(page)).length, views, 'no view');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S4], '← on the member closes it');
      assert.equal(await selectedRow(page), S1);
      await untilClosed(page, shut('week', 'ORB-1'));
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a selected session that becomes a member of a closed block → the block opens, the page forgets it closed it, and it stays open when the selection goes to a row outside it; a filter flattens every block; a reload forgets the closed blocks',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      session(d, S5, 20n * DAY, 'ORB-1 old'); // alone in Earlier: no block
      await untilRows(page, [S2, S3, S4], 'the open block of two');
      assert.equal(await selectedRow(page), S2, 'its head selected (the first row)');
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S2, S4], 'closed');
      await untilClosed(page, shut('week', 'ORB-1'));

      // A newer session of ORB-1: it is the head now, and the selected S2 one of its members. The
      // server opens the block for the selection (G5); the page forgets that it was closed.
      session(d, S1, 1n * MIN, 'ORB-1 first');
      const open = await untilRows(page, [S1, S2, S3, S4], 'open for its selected member');
      assert.deepEqual(
        open.map((line) => line.stack),
        ['head', 'member', 'member', ''],
      );
      assert.equal(await selectedRow(page), S2);
      await untilClosed(page, []);

      // The selection leaves the block: it stays open.
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S4], 'the block stays open');
      assert.deepEqual((await lastView(page))['closed'], []);

      // A filter flattens every block, a closed one too: no head, no member, no badge, no line.
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S4], 'closed again');
      await page.keyboard.press('/');
      await page.keyboard.type('orb');
      const flat = await untilRows(page, [S1, S2, S3, S5], 'the filter, Earlier unfolded');
      assert.deepEqual(
        flat.map((line) => [line.stack, line.badge]),
        [
          ['', ''],
          ['', ''],
          ['', ''],
          ['', ''],
        ],
      );
      assert.equal((await lines(page)).filter((line) => line.kind === 'more').length, 0);
      // While filtering ← folds nothing and closes nothing: with the selection in Earlier it stays.
      await page.keyboard.press('Enter');
      await page.locator(`#list [data-id="${S5}"]`).click();
      await untilSelected(page, S5);
      await page.keyboard.press('ArrowLeft');
      await sleep(300);
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S5]);
      assert.equal(await selectedRow(page), S5);
      await page.keyboard.press('Escape');
      await untilRows(page, [S1, S4], 'the filter cleared: the block closed again');
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'));

      // A reload (F5, from the list) forgets it: the page starts again with every block open.
      await page.evaluate(() => Reflect.set(globalThis, 'beforeReload', true));
      await page.keyboard.press('F5');
      await page.waitForFunction(
        () => Reflect.get(globalThis, 'beforeReload') === undefined,
        null,
        {
          timeout: PAGE_WAIT_MS,
        },
      );
      await connection(page, 'open');
      await untilRows(page, [S1, S2, S3, S4], 'every block open after the reload');
      const views = await sentViews(page);
      assert.ok(views.length > 0);
      assert.ok(
        views.every((view) => JSON.stringify(view['closed']) === '[]'),
        'no view after the reload closes a block',
      );
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "Ctrl+Tab back to a member of an open block selects it; Ctrl+Tab skips a member of a block the user closed that no terminal of the window holds (the page does not know a closed block's members), as it skips a filtered or a folded row",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilRows(page, [S1, S2, S3, S4], 'the open block');

      await toZone(page, 'list');
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await page.keyboard.press('Control+Tab');
      await untilSelected(page, S2);
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S4], 'the block still open');

      // The user closes the block (← on the member: its head selected). Ctrl+Tab then skips S2.
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S4], 'closed');
      await untilSelected(page, S1);
      await untilClosed(page, shut('week', 'ORB-1'));
      await page.keyboard.press('Control+Tab');
      await untilSelected(page, S4);
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S4], 'the block stays closed');
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'));
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'three running sessions of one group are a block under Open, open by default, with their slot numbers; ← closes it and → opens it; a slot chord, Ctrl+Tab and a switcher pick of a hidden member (a terminal of the window holds it) each select it and open its block',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2, S3]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2, S3]) {
        await resumeHere(page, id);
      }
      // Each program has reported its session (S2 7.5), so that a terminal's slot names it: a
      // slot chord reaches a hidden member through its terminal (a named limit before that).
      await until(
        () => l.server.hub.list().every((term) => term.sessionId === term.expectedSessionId),
        'the three programs reported their sessions',
      );
      const open = await untilLines(
        page,
        (drawn) =>
          drawn.map((line) => `${line.section}:${line.id}:${line.stack}`).join() ===
          [`open:${S1}:head`, `open:${S2}:member`, `open:${S3}:member`].join(),
        'the block under Open',
      );
      assert.deepEqual(
        open.map(({ slot, badge }) => [slot, badge]),
        [
          ['1', '×3'],
          ['2', ''],
          ['3', ''],
        ],
      );
      assert.ok((open[1]?.indent ?? 0) > (open[0]?.indent ?? 0), 'the members are indented');

      // From the list: ← on the head closes it, → opens it.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilLines(
        page,
        (drawn) => drawn.map((line) => `${line.kind}${line.id}`).join() === `row${S1},more${S1}`,
        'closed: the head and its line',
      );
      await untilClosed(page, shut('open', 'test'));
      assert.equal(
        (await lines(page)).find((line) => line.kind === 'more')?.text,
        '+2 more in test',
      );
      await page.keyboard.press('ArrowRight');
      await untilRows(page, [S1, S2, S3], '→ opens it');
      await untilClosed(page, []);

      // A slot chord of a hidden member: it is selected and its block opens.
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1], 'closed again');
      await untilClosed(page, shut('open', 'test'));
      await page.keyboard.press('Control+Shift+Digit3');
      await untilSelected(page, S3);
      await untilRows(page, [S1, S2, S3], 'open for the slot chord');
      // The page forgot that it closed it: it stays open when the selection leaves (the server
      // draws it open whatever is selected).
      await untilClosed(page, []);

      // Ctrl+Tab back to a hidden member that a terminal of the window holds: selected, open.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1], 'closed with the head selected');
      await untilClosed(page, shut('open', 'test'));
      await page.keyboard.press('Control+Tab'); // the previous session: S3
      await untilSelected(page, S3);
      await untilRows(page, [S1, S2, S3], 'open for Ctrl+Tab');
      await untilClosed(page, []);

      // A pick in the switcher of a hidden member: selected, its block open.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1], 'closed for the switcher');
      await untilClosed(page, shut('open', 'test'));
      await page.keyboard.press('Control+Shift+P');
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('switcher-field') === true,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      await page.keyboard.type(S2.slice(0, 8));
      await page.keyboard.press('Enter'); // waits for the answer to the whole text, then picks
      await untilSelected(page, S2);
      await untilRows(page, [S1, S2, S3], 'open for the pick');
      await untilClosed(page, []);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "a click on `×n` while a member other than the head is selected never moves the selection: from that member's terminal the block stays open, the key bar says why, nothing is sent, and what is typed next reaches the MEMBER's program; with the head selected the click closes it (ruled 2026-11-16)",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2, S3]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2, S3]) {
        await resumeHere(page, id);
      }
      await until(
        () => l.server.hub.list().every((term) => term.sessionId === term.expectedSessionId),
        'the three programs reported their sessions',
      );
      await untilRows(page, [S1, S2, S3], 'the open block under Open');
      // The member S2's terminal has the keyboard (a click on a running row).
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.waitForFunction(
        () => document.getElementById('terminal')?.contains(document.activeElement) === true,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      const term2 = termOf(l, S2);
      assert.equal(
        await page.evaluate(() => document.getElementById('right-zone')?.dataset['paneTerm']),
        term2,
      );
      const views = (await sentViews(page)).length;
      await mark(page, 'refused');
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await showsText(
        page,
        '#key-message',
        /^this block holds the selected session; it stays open$/,
      );
      assert.deepEqual(await rowIds(page), [S1, S2, S3], 'the block stays open');
      assert.equal(await selectedRow(page), S2, 'the selection stays');
      assert.equal(
        await page.evaluate(() => document.getElementById('right-zone')?.dataset['paneTerm']),
        term2,
        'the right side stays',
      );
      assert.equal((await sentViews(page)).length, views, 'no view');
      assert.deepEqual(
        (await sentAfter(page, 'refused')).filter((type) => type !== 'input' && type !== 'ping'),
        [],
        'nothing but input sent',
      );
      const before2 = inputOf(d.record, S2);
      const before1 = inputOf(d.record, S1);
      await page.keyboard.type('typedafterclose');
      const typed = Buffer.from('typedafterclose', 'utf8').toString('hex');
      await until(() => inputOf(d.record, S2).slice(before2.length).includes(typed), 'S2 read it');
      assert.equal(inputOf(d.record, S1), before1, "nothing reached the head's program");

      // The guard lets go: with the head selected, the click closes the block.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1], 'closed with the head selected');
      await untilClosed(page, shut('open', 'test'));
      assert.equal(await selectedRow(page), S1);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'one group in two sections is two blocks, remembered each on its own: closing one leaves the other open, opening one leaves the other closed, a selection that opens one leaves the other closed; `×n` on one with a member of the other selected closes it and leaves the selection (review 2, S4)',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2]) {
        await resumeHere(page, id);
      }
      await until(
        () => l.server.hub.list().every((term) => term.sessionId === term.expectedSessionId),
        'the two programs reported their sessions',
      );
      session(d, S3, 1n * MIN, 'week three');
      session(d, S4, 2n * MIN, 'week four');
      setGroup(d.deck, S3, 'test');
      setGroup(d.deck, S4, 'test');
      const shape = async (): Promise<string> =>
        (await lines(page)).map((line) => `${line.section}:${line.kind}:${line.id}`).join(' ');
      const both = (open: boolean, week: boolean): string =>
        [
          `open:row:${S1}`,
          open ? `open:row:${S2}` : `open:more:${S1}`,
          `week:row:${S3}`,
          week ? `week:row:${S4}` : `week:more:${S3}`,
        ].join(' ');
      await until(async () => (await shape()) === both(true, true), 'two open blocks');
      assert.equal(await selectedRow(page), S2, "Open's member, from its resume");

      // `×2` on This week's block with Open's member selected: closed, the selection stays.
      await page.locator(`#list [data-id="${S3}"] .row-stack`).click();
      await until(async () => (await shape()) === both(true, false), "This week's closed");
      await untilClosed(page, shut('week', 'test'));
      assert.equal(await selectedRow(page), S2, 'the selection stays');

      // Open's closed too (its head selected first): two entries, one per section.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await until(async () => (await shape()) === both(false, false), 'both closed');
      await untilClosed(page, [...shut('week', 'test'), ...shut('open', 'test')]);

      // Opening This week's leaves Open's closed.
      await page.locator(`#list .list-more[data-head="${S3}"]`).click();
      await until(async () => (await shape()) === both(false, true), "This week's open");
      await untilClosed(page, shut('open', 'test'));

      // A selection that opens Open's (a slot chord of its hidden member) leaves This week's closed.
      await page.locator(`#list [data-id="${S3}"] .row-stack`).click();
      await until(async () => (await shape()) === both(false, false), 'both closed again');
      await untilClosed(page, [...shut('open', 'test'), ...shut('week', 'test')]);
      await page.keyboard.press('Control+Shift+Digit2');
      await untilSelected(page, S2);
      await until(async () => (await shape()) === both(true, false), "Open's opened by the chord");
      await untilClosed(page, shut('week', 'test'));

      // A resume into a closed block of Open (CONSIDER c of review 2): Open's closed again, then
      // This week's head S3 resumed from the list; it joins Open's block, the server selects it
      // after the resume, and the block opens.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilClosed(page, [...shut('week', 'test'), ...shut('open', 'test')]);
      await resumeHere(page, S3);
      await untilLines(
        page,
        (drawn) =>
          drawn.map((line) => `${line.section}:${line.id}:${line.stack}`).join(' ') ===
          [`open:${S1}:head`, `open:${S2}:member`, `open:${S3}:member`, `week:${S4}:`].join(' '),
        "S3 under Open, in its block's open members",
      );
      assert.equal(await selectedRow(page), S3);
      await untilClosed(page, shut('week', 'test'));
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a closed block whose member has a terminal that has not reported a session is drawn open: the page forgets that it closed it, ← and `×n` say why they do nothing, the slot chord reaches the row; once it reported the block stays open and ← closes it (ruled 2026-11-16)',
    async (t) => {
      // A scripted server that applies the server's own rule (`stackRows`) to two rows of `test`
      // under Open: S1 in TERM_A (slot 1, reported), S2 in TERM_B (slot 2), reported or not.
      let reported = true;
      let world: Awaited<ReturnType<typeof editWorld>> | null = null;
      const blockList = (selected: string | null): Record<string, unknown> => {
        const terminals = [
          { id: TERM_A, slot: 1, sessionId: S1 },
          { id: TERM_B, slot: 2, sessionId: reported ? S2 : null },
        ];
        const base = scriptedList(
          [
            { id: S1, terminal: TERM_A, slot: 1, title: 'one' },
            { id: S2, terminal: TERM_B, slot: 2, title: 'two' },
          ],
          terminals,
        ) as { sections: { rows: Record<string, unknown>[] }[] } & Record<string, unknown>;
        const views = (world?.sent ?? []).filter((message) => message['t'] === 'view');
        const closed = (views.at(-1)?.['closed'] ?? []) as ClosedBlock[];
        const rows: Record<string, unknown>[] = (base.sections[0]?.rows ?? []).map((row) => ({
          ...row,
          group: 'test',
        }));
        const drawn = stackRows(
          rows.map((row) => ({
            id: row['id'] as string,
            group: 'test',
            needsYou: false,
            unreported: terminals.find((term) => term.id === row['terminal'])?.sessionId === null,
            row,
          })),
          'open',
          closed,
          selected,
        ).map(({ entry, stack }) => ({ ...entry.row, stack }));
        return {
          ...base,
          sections: [{ ...base.sections[0], count: 2, rows: drawn }],
        };
      };
      const page = await newPage(t, chromium);
      await page.addInitScript(RECORDER);
      await page.addInitScript(VIEWS);
      const problems = problemsOf(page);
      world = await editWorld(t, page, blockList);
      const w = world;
      const resend = (): void => w.list(blockList);
      await untilRows(page, [S1, S2], 'the open block');
      await toZone(page, 'list');
      assert.equal(await selectedRow(page), S1);
      await page.keyboard.press('ArrowLeft');
      await untilClosed(page, shut('open', 'test'));
      await untilRows(page, [S1], 'closed');

      // S2's terminal starts again and has not reported: the block is drawn open, the page forgets.
      reported = false;
      resend();
      await untilRows(page, [S1, S2], 'open while S2 has not reported');
      await untilClosed(page, []);
      // ← and ×2 do nothing and say why; nothing is sent.
      const views = (await sentViews(page)).length;
      await page.keyboard.press('ArrowLeft');
      await showsText(
        page,
        '#key-message',
        /^this block holds a session that is still starting; it stays open$/,
      );
      await page.evaluate(() => {
        const message = document.getElementById('key-message');
        if (message !== null) message.textContent = '';
      });
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await showsText(
        page,
        '#key-message',
        /^this block holds a session that is still starting; it stays open$/,
      );
      assert.equal((await sentViews(page)).length, views, 'no view');
      assert.deepEqual(await rowIds(page), [S1, S2]);
      // The slot chord reaches the drawn row of the unreported terminal.
      await page.keyboard.press('Control+Shift+Digit2');
      await untilSelected(page, S2);

      // Reported: the block stays open (the page forgot it was closed); ← on its head closes it.
      reported = true;
      resend();
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await toZone(page, 'list');
      assert.deepEqual(await rowIds(page), [S1, S2], 'still open after the report');
      await page.keyboard.press('ArrowLeft');
      await untilClosed(page, shut('open', 'test'));
      await untilRows(page, [S1], 'closed again: the guard let go');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a closed block whose hidden member needs you: `+2 more in test · 1 needs you`, that part alone in the needs-you colour, no bar and no bold; the title bar the same open or closed; Ctrl+Shift+J selects the hidden member and opens its block',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2, S3]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2, S3]) {
        await resumeHere(page, id);
      }
      // Each program has reported its session: until then its block cannot be closed.
      await until(
        () => l.server.hub.list().every((term) => term.sessionId === term.expectedSessionId),
        'the three programs reported their sessions',
      );
      await untilRows(page, [S1, S2, S3], 'the open block under Open');
      // S3 asks a question: it needs you, while S1 is selected.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      assert.equal(
        l.server.hub.input(termOf(l, S3), Buffer.from('/waiting a question\r', 'utf8')),
        'ok',
      );
      await page.waitForFunction(
        (id) =>
          document.querySelector(`#list [data-id="${id}"]`)?.getAttribute('data-attention') ===
          'asks',
        S3,
        { timeout: PAGE_WAIT_MS },
      );
      const counts = async (): Promise<string> => shownText(page, '#counts');
      await until(
        async () => (await counts()).startsWith('1 needs you'),
        'the title bar counts it',
      );
      const countsOpen = await counts();
      const titleOpen = await page.title();

      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      const closed = await untilLines(
        page,
        (drawn) => drawn.some((line) => line.kind === 'more' && line.need !== ''),
        'the closed block says that a hidden member needs you',
      );
      assert.deepEqual(
        closed.map(({ kind, id, text, need }) => ({ kind, id, text, need })),
        [
          { kind: 'row', id: S1, text: (await lines(page))[0]?.text ?? '', need: '' },
          { kind: 'more', id: S1, text: '+2 more in test · 1 needs you', need: ' · 1 needs you' },
        ],
      );
      const look = await readPage(
        page,
        () => {
          const line = document.querySelector<HTMLElement>('#list .list-more');
          const text = line?.querySelector('.more-text');
          const need = line?.querySelector('.more-need');
          const counted = document.querySelector('#counts .count[data-state="need-you"]');
          const style = (element: Element | null | undefined) =>
            element instanceof Element ? getComputedStyle(element) : null;
          const before =
            style(line) === null ? null : getComputedStyle(line as Element, '::before');
          return {
            attention: line?.dataset['attention'] ?? null,
            textColour: style(text)?.color ?? '',
            lineColour: style(line)?.color ?? '',
            needColour: style(need)?.color ?? '',
            countColour: style(counted)?.color ?? '',
            weights: [style(line)?.fontWeight, style(text)?.fontWeight, style(need)?.fontWeight],
            bar: [style(line)?.borderLeftWidth, before?.content ?? 'none'],
          };
        },
        null,
      );
      assert.equal(look.attention, null, 'the line is no row that needs you');
      assert.equal(
        look.needColour,
        look.countColour,
        "the part in the title bar's need-you colour",
      );
      assert.notEqual(look.textColour, look.needColour, '`+2 more in test` keeps its look');
      assert.equal(look.textColour, look.lineColour);
      assert.deepEqual(look.weights, ['400', '400', '400'], 'no bold');
      assert.deepEqual(look.bar, ['0px', 'none'], 'no bar');
      assert.equal(await counts(), countsOpen, 'the title bar does not move');
      assert.equal(await page.title(), titleOpen);

      // Ctrl+Shift+J: the hidden member that needs you, its block opened.
      await page.keyboard.press('Control+Shift+J');
      await untilSelected(page, S3);
      await untilRows(page, [S1, S2, S3], 'open for Ctrl+Shift+J');
      await untilClosed(page, []);
      assert.equal((await lines(page)).filter((line) => line.kind === 'more').length, 0);

      // A group too long for the line: the group gives way, ` · 1 needs you` is never cut off
      // (review 2, S2).
      const long = `inbox-cleaner-oom-investigation-${'x'.repeat(28)}`; // 60 characters
      for (const id of [S1, S2, S3]) setGroup(d.deck, id, long);
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await until(
        async () =>
          (await readPage(
            page,
            (id) => document.querySelector(`#list [data-id="${id}"] .row-group`)?.textContent ?? '',
            S1,
          )) === long,
        'the long group shown',
      );
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilClosed(page, shut('open', long));
      await untilLines(
        page,
        (drawn) => drawn.some((line) => line.kind === 'more' && line.need === ' · 1 needs you'),
        'the closed long block',
      );
      const fit = await readPage(
        page,
        () => {
          const line = document.querySelector<HTMLElement>('#list .list-more');
          const text = line?.querySelector<HTMLElement>('.more-text');
          const need = line?.querySelector<HTMLElement>('.more-need');
          if (line == null || text == null || need == null) return null;
          const box = line.getBoundingClientRect();
          const style = getComputedStyle(line);
          const inner = {
            left: box.left + parseFloat(style.paddingLeft),
            right: box.right - parseFloat(style.paddingRight),
          };
          const part = need.getBoundingClientRect();
          return {
            needInside:
              part.width > 0 && part.left >= inner.left && part.right <= inner.right + 0.5,
            textCut: text.scrollWidth > text.clientWidth,
            needText: need.textContent,
          };
        },
        null,
      );
      assert.deepEqual(fit, { needInside: true, textCut: true, needText: ' · 1 needs you' });
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "`d` on a closed block's head marks that session only: the next member is the head (×2, `+1 more`); stage D's selection after `d` takes the row after it of those drawn when `d` was pressed — the row after the block, whose members were not drawn",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilRows(page, [S1, S2, S3, S4], 'the open block');
      assert.equal(await selectedRow(page), S1);
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S4], 'the closed block');
      await untilClosed(page, shut('week', 'ORB-1'));
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
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'), 'still closed');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a group of 1,025 bytes is never in a view the page sends, so its block cannot be closed: ← and its ×2 do nothing on it, and it stays open; ← on a block beside it still closes that one; nor one of 400 `€` (400 units, 1,200 bytes); one of 1,024 bytes of non-ASCII text is',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      const long = 'g'.repeat(1025);
      const fits = `${'€'.repeat(341)}f`; // 1,024 bytes of UTF-8 in 342 units
      const euros = '€'.repeat(400); // 1,200 bytes in 400 units
      session(d, S1, 1n * MIN, 'long head');
      session(d, S2, 2n * MIN, 'long member');
      setGroup(d.deck, S1, long);
      setGroup(d.deck, S2, long);
      session(d, S3, 3n * MIN, 'ORB-1 head');
      session(d, S4, 4n * MIN, 'ORB-1 member');
      await untilRows(page, [S1, S2, S3, S4], 'two open blocks');
      assert.equal(await selectedRow(page), S1);

      // ← on the long block's head, then on its member, and a click on its ×2: nothing is sent,
      // nothing folds, it stays open.
      await toZone(page, 'list');
      const before = (await sentViews(page)).length;
      await page.keyboard.press('ArrowLeft');
      // (Its ×2 stands after the group's 1,025 characters, past the list's edge: a click event.)
      await page.locator(`#list [data-id="${S1}"] .row-stack`).dispatchEvent('click');
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S2);
      await page.keyboard.press('ArrowLeft');
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S4], 'it stays open');
      assert.equal(await selectedRow(page), S2, 'the selection stays on its member');
      assert.deepEqual(
        (await sentViews(page)).slice(before).map((view) => view['selected']),
        [S2],
        "no view but the selection's",
      );

      // The guard lets go: ← on the block beside it closes that one.
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S3);
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S2, S3], 'ORB-1 closed');
      await untilClosed(page, shut('week', 'ORB-1'));

      // A group of 1,024 bytes is sent: its block closes.
      session(d, S6, 5n * MIN, 'fits head');
      session(d, S7, 6n * MIN, 'fits member');
      setGroup(d.deck, S6, fits);
      setGroup(d.deck, S7, fits);
      await untilRows(page, [S1, S2, S3, S6, S7], 'a third block, open');
      await page.locator(`#list [data-id="${S6}"] .row-stack`).dispatchEvent('click');
      await untilRows(page, [S1, S2, S3, S6], 'the block of 1,024 bytes closed');
      await untilClosed(page, [...shut('week', 'ORB-1'), ...shut('week', fits)]);

      // 400 `€`: the bytes count, not the units: never sent, the block stays open.
      session(d, S8, 7n * MIN, 'euro head');
      session(d, S5, 8n * MIN, 'euro member');
      setGroup(d.deck, S8, euros);
      setGroup(d.deck, S5, euros);
      await untilRows(page, [S1, S2, S3, S6, S8, S5], 'a fourth block, open');
      await page.locator(`#list [data-id="${S8}"] .row-stack`).dispatchEvent('click');
      await page.locator(`#list [data-id="${S8}"]`).click();
      await untilSelected(page, S8);
      await page.keyboard.press('ArrowLeft');
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S2, S3, S6, S8, S5], 'it stays open');
      assert.deepEqual((await lastView(page))['closed'], [
        ...shut('week', 'ORB-1'),
        ...shut('week', fits),
      ]);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'at most 64 entries in `closed`: closing a 65th block drops the oldest, which opens again, and the page stays connected (the server refuses a 65th)',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      const id = (n: number): string =>
        `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
      for (let g = 1; g <= 65; g++) {
        session(d, id(2 * g), BigInt(2 * g) * MIN, `GR-${g} head`);
        session(d, id(2 * g + 1), BigInt(2 * g + 1) * MIN, `GR-${g} member`);
      }
      await untilLines(
        page,
        (drawn) => drawn.filter((line) => line.stack === 'head').length === 65,
        '65 open blocks',
      );
      for (let g = 1; g <= 65; g++) {
        await page.locator(`#list [data-id="${id(2 * g)}"] .row-stack`).click();
        const deadline = performance.now() + PAGE_WAIT_MS;
        while (
          !((await lastView(page))['closed'] as ClosedBlock[]).some(
            (one) => one.group === `GR-${g}`,
          )
        ) {
          assert.ok(performance.now() < deadline, `GR-${g} closed`);
          await sleep(20);
        }
      }
      const closed = (await lastView(page))['closed'] as ClosedBlock[];
      assert.equal(closed.length, 64);
      assert.deepEqual(
        closed,
        Array.from({ length: 64 }, (_, i) => ({ section: 'week', group: `GR-${i + 2}` })),
      );
      // The oldest is open again; the page never lost its connection.
      await untilLines(
        page,
        (drawn) => drawn.some((line) => line.kind === 'row' && line.id === id(3)),
        'GR-1 open again',
      );
      // No view was refused: the server closes a page's socket with 1008 for one (under load a
      // page may also reconnect after a silence, which is no refusal).
      assert.deepEqual(
        (await logOf(page)).filter((entry) => entry.e === 'close' && entry.code === 1008),
        [],
      );
      await connection(page, 'open');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a filter of blanks is no filter (the list decides by `list.filtering`): the blocks are drawn and close, the footer is shown, ← and → fold and unfold Earlier',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'plain work');
      session(d, S4, 20n * DAY, 'old work');
      session(d, S5, 4n * MIN, 'done work');
      markDone(d.deck, S5);
      await untilRows(page, [S1, S2, S3], 'This week: an open block and a row');

      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('   ');
      await page.keyboard.press('Enter');
      await sleep(500);
      assert.deepEqual((await lastView(page))['filter'], '   ');
      const drawn = await untilRows(page, [S1, S2, S3], 'the block as before');
      assert.equal(drawn[0]?.badge, '×2');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.equal(await shownText(page, '#list .list-empty'), '');
      await page.locator(`#list [data-id="${S3}"]`).click();
      await untilSelected(page, S3);
      await page.keyboard.press('ArrowRight');
      await untilRows(page, [S1, S2, S3, S4], '→ unfolds Earlier');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S2, S3], '← folds it');
      await page.keyboard.press('Home');
      await untilSelected(page, S1);
      await page.keyboard.press('ArrowLeft');
      await untilLines(
        page,
        (lines) =>
          lines.map((line) => `${line.kind}${line.id}`).join() === `row${S1},more${S1},row${S3}`,
        '← on the head closes the block',
      );
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'the `+n more` line from a terminal: a click opens the block and takes no keyboard; a double click at a human pace opens it, and its second click — landing on the first member — selects nothing, moves the keyboard nowhere and resumes nothing',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S8, 1n * MIN, 'plain run');
      session(d, S1, 2n * MIN, 'ORB-1 first');
      session(d, S2, 3n * MIN, 'ORB-1 second');
      await untilRows(page, [S8, S1, S2], 'a row and an open block');
      await resumeFromList(page, S8);
      await untilRows(page, [S8, S1, S2], 'S8 under Open');
      assert.equal(await keyboardOn(page), 'the terminal');

      // A click on ×2 closes it; one click on the line opens it, the keyboard in the terminal,
      // the selection on S8.
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S8, S1], 'closed by its ×2');
      assert.equal(await keyboardOn(page), 'the terminal');
      await page.locator(`#list .list-more[data-head="${S1}"]`).click();
      await untilRows(page, [S8, S1, S2], 'a click on the line opens it');
      assert.equal(await keyboardOn(page), 'the terminal');
      assert.equal(await selectedRow(page), S8);
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S8, S1], 'closed again by its ×2');
      assert.equal(await keyboardOn(page), 'the terminal');

      // A double click: its second press lands on S2, drawn where the line was.
      await mark(page, 'double');
      await doubleClick(page, `#list .list-more[data-head="${S1}"]`, () =>
        untilRows(page, [S8, S1, S2], 'open after the first click'),
      );
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S8, S1, S2], 'open');
      assert.equal(await selectedRow(page), S8, 'the selection where it was');
      assert.equal(await keyboardOn(page), 'the terminal', 'the keyboard where it was');
      assert.equal(
        await page.evaluate(() => document.getElementById('right-zone')?.dataset['pane']),
        'terminal',
      );
      assert.ok(!(await sentAfter(page, 'double')).includes('act'), 'nothing resumed');

      // A sequence begun on a row whose second click is on a closed block's line: no toggle.
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S8, S1], 'closed');
      const row = await page.locator(`#list [data-id="${S8}"] .row-title`).boundingBox();
      const line = await page.locator(`#list .list-more[data-head="${S1}"]`).boundingBox();
      assert.ok(row !== null && line !== null);
      await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S8, S1], 'still closed');
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'));

      // Each sequence begins afresh: after the clicks on the line above, a double click on a row
      // that is not running (the head S1) resumes it, as in stage A.
      await mark(page, 'resume');
      await doubleClick(page, `#list [data-id="${S1}"] .row-title`, () => Promise.resolve());
      const deadline = performance.now() + PAGE_WAIT_MS;
      while (!(await sentAfter(page, 'resume')).includes('act')) {
        assert.ok(performance.now() < deadline, 'a double click on S1 resumes it');
        await sleep(50);
      }
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "a block's ×n from a terminal: a click closes and opens it and takes no keyboard; a double click at a human pace closes it once (its second click does not open it again) and moves nothing else",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S8, 1n * MIN, 'plain run');
      session(d, S1, 2n * MIN, 'ORB-1 first');
      session(d, S2, 3n * MIN, 'ORB-1 second');
      session(d, S3, 4n * MIN, 'plain idle');
      await untilRows(page, [S8, S1, S2, S3], 'a row, an open block, a row');
      await resumeFromList(page, S8);
      await untilRows(page, [S8, S1, S2, S3], 'S8 under Open');

      const badge = `#list [data-id="${S1}"] .row-stack`;
      await page.locator(badge).click();
      await untilRows(page, [S8, S1, S3], 'a click on ×2 closes it');
      assert.equal(await keyboardOn(page), 'the terminal');
      await page.locator(badge).click();
      await untilRows(page, [S8, S1, S2, S3], 'and opens it');
      assert.equal(await keyboardOn(page), 'the terminal');

      await mark(page, 'double');
      await doubleClick(page, badge, () =>
        untilRows(page, [S8, S1, S3], 'closed after the first click'),
      );
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S8, S1, S3], 'still closed');
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'));
      assert.equal(await selectedRow(page), S8);
      assert.equal(await keyboardOn(page), 'the terminal');
      assert.ok(!(await sentAfter(page, 'double')).includes('act'), 'nothing resumed');

      // A sequence begun on the head's row whose second click is on its ×2: the row is selected
      // by the first click, the second neither toggles the block nor resumes the head.
      const title = await page.locator(`#list [data-id="${S1}"] .row-title`).boundingBox();
      const onBadge = await page.locator(badge).boundingBox();
      assert.ok(title !== null && onBadge !== null);
      await mark(page, 'row then badge');
      await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await untilSelected(page, S1);
      await page.mouse.move(onBadge.x + onBadge.width / 2, onBadge.y + onBadge.height / 2);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S8, S1, S3], 'not opened');
      assert.ok(!(await sentAfter(page, 'row then badge')).includes('act'), 'nothing resumed');

      // Each sequence begins afresh: a double click on a row that is not running resumes it, as
      // in stage A, after all the clicks on ×2 above.
      await mark(page, 'resume');
      await doubleClick(page, `#list [data-id="${S3}"] .row-title`, () => Promise.resolve());
      const deadline = performance.now() + PAGE_WAIT_MS;
      while (!(await sentAfter(page, 'resume')).includes('act')) {
        assert.ok(performance.now() < deadline, 'a double click on S3 resumes it');
        await sleep(50);
      }
      await page.waitForSelector('#right-zone[data-pane="terminal"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'two blocks: ×n closing one with a member of the other selected leaves the selection; ← on a member closes its block and leaves an unfolded Earlier unfolded',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 a');
      session(d, S2, 2n * MIN, 'ORB-1 b');
      session(d, S3, 3n * MIN, 'ORB-2 a');
      session(d, S4, 4n * MIN, 'ORB-2 b');
      session(d, S5, 20n * DAY, 'old work');
      await untilRows(page, [S1, S2, S3, S4], 'two open blocks');

      await toZone(page, 'list');
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      await untilRows(page, [S1, S3, S4], 'ORB-1 closed');
      await untilClosed(page, shut('week', 'ORB-1'));
      assert.equal(await selectedRow(page), S4, 'the member of ORB-2 stays selected');

      // Earlier unfolded (a click on its header), then ← on ORB-2's member.
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await untilRows(page, [S1, S3, S4, S5], 'Earlier unfolded');
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S3, S5], 'ORB-2 closed');
      assert.equal(await selectedRow(page), S3);
      await untilClosed(page, shut('week', 'ORB-1', 'ORB-2'));
      assert.deepEqual((await lastView(page))['unfolded'], ['earlier'], 'Earlier still unfolded');
      assert.deepEqual(await rowIds(page), [S1, S3, S5]);
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
      const open = await untilRows(page, [S1, S2, S6, S7], 'open');
      assert.equal(open[1]?.stack, 'member');
      assert.equal(open[1]?.text, hostileTitle);
      await page.locator(`#list [data-id="${S1}"] .row-stack`).click();
      const closed = await untilLines(
        page,
        (drawn) => drawn.some((line) => line.kind === 'more'),
        'the closed block',
      );
      assert.deepEqual(closed.find((line) => line.kind === 'more')?.text, `+2 more in ${hostile}`);
      assert.equal(await page.evaluate(() => document.querySelector('img')), null);
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, 'pwned')), undefined);
      await untilClosed(page, shut('week', hostile));
      await healthy(page, l.problems);
    },
  );
});
