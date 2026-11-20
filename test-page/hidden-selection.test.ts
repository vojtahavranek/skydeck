// The selected session the list does not show (S2 12.6, 12.9; plan E13, task 95): a terminal of the
// window whose session a filter hides is still shown with that session's header and an ended bar
// that has Resume and Close; a hidden session without a terminal shows nothing; the list keys act
// on no hidden session. Real test servers run on realTestPlatform with real keepers and the
// stand-in program (test/helpers/window.ts), with sessions made the way step 1 sees them; one
// scripted stand-in server (helpers/shell.ts) holds the ended bar before the exit has arrived.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import type { Deck } from '../src/sessions/deck.ts';
import { attachManualPr, requirePrKey } from '../src/sessions/meta.ts';
import type { PrFetchResult } from '../src/store/types.ts';
import { ghRunner } from '../test/helpers/gh.ts';
import type { GhRunner } from '../test/helpers/gh.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { connectTestPage } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  after,
  clickRow,
  connection,
  escape,
  honest,
  keyMessage,
  launched,
  logOf,
  mark,
  PAGE_WAIT_MS,
  readPage,
  scriptedList,
  selectedRow,
  shownText,
  showsText,
  standinServer,
  storeKey,
  TERM_A,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import { promptOf, resumeHere, until, untilScreen } from './helpers/terminal.ts';

const MIN = 60_000_000_000n;
/** D15's toasts (web/app.js): for a session that runs, and for one that does not. */
/** F30: the words for a running session the window cannot end (these rows carry no `endable`). */
const DONE_RUNNING =
  'Marked done. skydeck cannot end this one: end it in its terminal. Hidden once it stops.';
const DONE_HIDDEN = 'Marked done: hidden from the list. It comes back on new activity.';

/** A session last active `agoNs` before now, titled `title` (a `custom-title` record), in the
 *  directory `dirName` of the sandbox's home. Returns the directory. */
function session(
  d: ServerSandbox,
  sessionId: string,
  agoNs: bigint,
  title: string,
  dirName = 'project',
): string {
  const dir = join(d.s.home, dirName);
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
  return dir;
}

/** The ids of the rows the list draws, in order. */
async function listed(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#list [data-id]')]
        .filter((element) => element instanceof HTMLElement && element.checkVisibility())
        .map((element) => element.getAttribute('data-id') ?? ''),
    null,
  );
}

/** Types `text` into the list's filter (`/`, the text, Enter: the keyboard back on the list) and
 *  waits until the list draws exactly `ids`. */
async function filterTo(page: Page, text: string, ids: string[]): Promise<void> {
  await toZone(page, 'list');
  await page.keyboard.press('/');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await until(
    async () => (await listed(page)).join() === ids.join(),
    `the list draws ${ids.join()}`,
  );
}

/**
 * Waits, in the page, until the terminal view has refitted to what is drawn now: two animation
 * frames (the layout, then its ResizeObserver), then a timer queued after the view's refit timer
 * (`REFIT_MS`, 100 ms, web/terminal-view.js) — an order, not a time, so a loaded machine only
 * makes it later.
 */
async function refitted(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setTimeout(resolve, 150);
          }),
        );
      }),
  );
}

/** The height of the right side's header, 0 while none is shown. */
async function headerHeight(page: Page): Promise<number> {
  return readPage(
    page,
    () => {
      const header = document.querySelector('#cards .card-header');
      return header instanceof HTMLElement && header.checkVisibility()
        ? header.getBoundingClientRect().height
        : 0;
    },
    null,
  );
}

/** The labels of the ended bar's buttons. */
async function barButtons(page: Page): Promise<string[]> {
  return page.locator('#cards .card-bar button').allTextContents();
}

/** Waits until the right side shows the terminal `term`. */
async function showsTerminal(page: Page, term: string): Promise<void> {
  await page.waitForSelector(`#right-zone[data-pane="terminal"][data-pane-term="${term}"]`, {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** The terminal of `sessionId` in the hub once there is one in `state` (other than `not`). */
async function terminalIn(
  l: Launched,
  sessionId: string,
  state: string,
  not?: string,
): Promise<string> {
  let found = '';
  await until(() => {
    found =
      l.server.hub
        .list()
        .find(
          (info) => info.expectedSessionId === sessionId && info.state === state && info.id !== not,
        )?.id ?? '';
    return found !== '';
  }, `a ${state} terminal of ${sessionId}`);
  return found;
}

/** A page of a real server whose runner holds every `gh` (as test-page/header.test.ts). */
async function withGh(t: TestContext, chromium: Browser): Promise<Launched & { gh: GhRunner }> {
  let gh: GhRunner | null = null;
  const l = await launched(t, chromium, {
    server: {
      platform: (platform) => {
        gh = ghRunner(platform.runner, { hold: 'held' });
        return { ...platform, runner: gh };
      },
    },
  });
  assert.ok(gh !== null);
  return { ...l, gh };
}

/** Attaches the open pull request `url` to `sessionId` as `skydeck pr add` does, read just now. */
function attach(deck: Deck, sessionId: string, url: string): void {
  deck.store.ensurePr(requirePrKey(url));
  const read: PrFetchResult = {
    ok: true,
    atNs: deck.platform.clock.nowNs(),
    title: 'Fix the retry',
    state: 'open',
    review: null,
    checks: 'passing',
  };
  deck.store.savePrResult(url, read);
  attachManualPr(deck, sessionId, url);
}

/** Whether stage D's dialog is shown, and its heading. */
async function dialog(page: Page): Promise<{ shown: boolean; heading: string }> {
  return readPage(
    page,
    () => {
      const root = document.getElementById('editor');
      return {
        shown: root instanceof HTMLElement && !root.hidden,
        heading: root?.querySelector('.edit-heading')?.textContent ?? '',
      };
    },
    null,
  );
}

/** The pull-request dialog's lines, in order. */
async function prLines(page: Page): Promise<string[]> {
  return page.locator('#editor .edit-pr .edit-pr-text').allTextContents();
}

/** The page of a real server with the real web/ reported no problem (ruled for tasks 27-29). */
function noProblems(l: Launched): void {
  assert.deepEqual(l.problems, [], 'the page reports no problem');
}

async function realServerCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    'a filter that hides the selected running session sends no resize; the header keeps its height; /exit → the ended bar with Resume and Close; Resume runs it again; Close forgets it and the right side is empty; the filter cleared → the row is selected again',
    async (t) => {
      const l = await launched(t, chromium);
      const { page } = l;
      session(l.d, S1, 2n * MIN, 'alpha work');
      session(l.d, S2, 3n * MIN, 'omega work');
      const first = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await showsText(page, '#cards .header-title', /^alpha work$/);
      await refitted(page); // the terminal view has fitted its size
      const height = await headerHeight(page);
      assert.ok(height > 0, 'a header is shown');
      await mark(page, 'filter');

      await filterTo(page, 'omega', [S2]);
      assert.equal(await selectedRow(page), null, 'the list shows no row selected');
      await showsTerminal(page, first);
      assert.equal(await shownText(page, '#cards .header-title'), 'alpha work');
      assert.equal(await shownText(page, '#cards .header-id'), S1.slice(0, 8));
      await refitted(page); // a resize would follow the area's change by then
      assert.equal(await headerHeight(page), height, 'the header keeps its height');
      assert.deepEqual(
        after(await logOf(page), 'filter').filter(
          (entry) => entry.e === 'out' && entry.t === 'resize',
        ),
        [],
        'no resize',
      );

      // /exit: the ended bar, with Resume and Close at once.
      const p = await connectTestPage(t, l.d, l.server, { focused: false, view: null });
      p.send({ t: 'input', term: first, data: '/exit\r' });
      await showsText(page, '#cards .card-ended', /^claude exited \(status 0\) at \d\d:\d\d:\d\d/);
      assert.deepEqual(await barButtons(page), ['Resume', 'Close']);
      assert.equal(await shownText(page, '#cards .header-title'), 'alpha work');
      assert.deepEqual(await listed(page), [S2], 'still hidden');

      // Resume on the bar: it runs again in the window, still hidden by the filter.
      await page.locator('#cards .card-bar button', { hasText: 'Resume' }).click();
      const second = await terminalIn(l, S1, 'running', first);
      await showsTerminal(page, second);
      await untilScreen(page, promptOf(S1));
      assert.equal(await selectedRow(page), null);
      assert.deepEqual(await listed(page), [S2]);

      // /exit again, then Close: the terminal is forgotten, the right side shows nothing.
      p.send({ t: 'input', term: second, data: '/exit\r' });
      await showsText(page, '#cards .card-ended', /^claude exited \(status 0\)/);
      assert.deepEqual(await barButtons(page), ['Resume', 'Close']);
      await page.locator('#cards .card-bar button', { hasText: 'Close' }).click();
      await page.waitForSelector('#right-zone[data-pane="none"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      assert.equal(await headerHeight(page), 0, 'no header');
      assert.deepEqual(
        l.server.hub.list().filter((info) => info.expectedSessionId === S1),
        [],
        'the terminal is forgotten',
      );

      // The filter cleared (Esc on the list): the row is shown, and selected again.
      await toZone(page, 'list');
      await page.keyboard.press('Escape');
      await until(async () => (await selectedRow(page)) === S1, 'S1 selected again');
      await page.waitForSelector('#right-zone[data-pane="resume"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      noProblems(l);
    },
  );

  await t.test(
    "a selected session without a terminal that the filter hides: the right side shows nothing (S2 12.9); the list keys d, l, F2, g, n, t, p say `no session selected` and send nothing; the New form's directory is the first known one, not the hidden session's",
    async (t) => {
      const l = await launched(t, chromium);
      const { page } = l;
      const alpha = session(l.d, S1, 3n * MIN, 'alpha work', 'alpha-dir');
      const omega = session(l.d, S2, 2n * MIN, 'omega work', 'omega-dir');
      await clickRow(page, S1);
      await page.waitForSelector('#right-zone[data-pane="resume"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await filterTo(page, 'omega', [S2]);
      assert.equal(await selectedRow(page), null);
      await page.waitForSelector('#right-zone[data-pane="none"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      assert.equal(await headerHeight(page), 0, 'no header');
      assert.equal(await page.locator('#cards .card:visible').count(), 0, 'no card');

      await mark(page, 'keys');
      for (const key of ['d', 'l', 'F2', 'g', 'n', 't', 'p']) {
        // The key bar's line stays 5 s: emptied first, so that each key must say it again (the
        // page's own timer only empties it).
        await page.evaluate(() => {
          const line = document.getElementById('key-message');
          if (line !== null) line.textContent = '';
        });
        assert.equal(await keyMessage(page), '', `emptied before ${key}`);
        await page.keyboard.press(key);
        await showsText(page, '#key-message', /^no session selected$/);
        assert.equal(await keyMessage(page), 'no session selected', key);
        assert.equal(await page.locator('#editor:not([hidden])').count(), 0, `no dialog: ${key}`);
      }
      // A key's message and its act are both made in its keydown, which `press` has awaited.
      assert.equal(await page.locator('#editor:not([hidden])').count(), 0, 'no dialog');
      assert.deepEqual(
        after(await logOf(page), 'keys').filter((entry) => entry.e === 'out' && entry.t === 'act'),
        [],
        'nothing sent',
      );

      // The New form: the user sees no session, so its directory is the most recent one (S2's),
      // not the hidden S1's.
      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      assert.equal(await page.inputValue('#cards input[name="directory"]'), omega);
      assert.notEqual(omega, alpha);
      await page.keyboard.press('Escape');
      await page.waitForSelector('#right-zone[data-pane="none"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      noProblems(l);
    },
  );

  await t.test(
    "the New form's directory on a hidden selection that a terminal of the window shows: the selected session's, as while it was listed (S2 12.6; review 2's S2, ruled)",
    async (t) => {
      const l = await launched(t, chromium);
      const { page } = l;
      const alpha = session(l.d, S1, 2n * MIN, 'alpha work', 'alpha-dir');
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      // S2 is active after S1's start: the first of the known directories.
      const omega = session(l.d, S2, 0n, 'omega work', 'omega-dir');
      await until(async () => (await listed(page)).includes(S2), 'S2 listed');
      /** The New form's directory and its first suggestion, then the form closed (Esc). */
      const newForm = async (): Promise<{ value: string; first: string }> => {
        await page.keyboard.press('Control+Shift+N');
        await page.waitForSelector('#right-zone[data-pane="new"]', {
          state: 'attached',
          timeout: PAGE_WAIT_MS,
        });
        const shown = {
          value: await page.inputValue('#cards input[name="directory"]'),
          first: (await page.getAttribute('#card-new-dirs option', 'value')) ?? '',
        };
        await page.keyboard.press('Escape');
        await page.waitForSelector('#right-zone[data-pane="terminal"]', {
          state: 'attached',
          timeout: PAGE_WAIT_MS,
        });
        return shown;
      };
      assert.deepEqual(await newForm(), { value: alpha, first: omega }, 'while S1 is listed');
      await filterTo(page, 'omega', [S2]);
      assert.equal(await selectedRow(page), null);
      assert.deepEqual(await newForm(), { value: alpha, first: omega }, 'once S1 is hidden');
      noProblems(l);
    },
  );
}

async function stageDCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    "with stage D: the header's label control (a click on the title) of a hidden running session opens its label dialog and saves its label; the header's Done marks it done with the toast of a running session, and once its terminal ended with the toast of a hidden one",
    async (t) => {
      const l = await withGh(t, chromium);
      const { page } = l;
      session(l.d, S1, 2n * MIN, 'alpha work');
      session(l.d, S2, 3n * MIN, 'omega work');
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await filterTo(page, 'omega', [S2]);
      assert.equal(await selectedRow(page), null);
      await showsText(page, '#cards .header-title', /^alpha work$/);

      await page.locator('#cards .header-title').click();
      await until(async () => (await dialog(page)).shown, 'the label dialog');
      assert.equal((await dialog(page)).heading, 'Label — alpha work');
      await page.keyboard.type('alpha renamed');
      await page.keyboard.press('Enter');
      await until(async () => !(await dialog(page)).shown, 'the dialog closed');
      await until(
        () => l.d.deck.store.meta(S1)?.label === 'alpha renamed',
        "S1's label in the store",
      );
      await showsText(page, '#cards .header-title', /^alpha renamed$/);
      assert.deepEqual(await listed(page), [S2], 'still hidden');

      // Done: the toast of a running session (ruled 13:05Z: a row with no section takes it from
      // the row itself), not "hidden from the list".
      await page.locator('#cards .header-done').click();
      await until(() => (l.d.deck.store.meta(S1)?.doneAtNs ?? null) !== null, 'S1 marked done');
      await showsText(page, '#toast .toast-text', new RegExp(`^${escape(DONE_RUNNING)}$`));
      await showsText(page, '#cards .header-done', /^Undone$/);
      assert.equal(await selectedRow(page), null);
      // Undone, then /exit: Done on the ended terminal of the hidden session says it is hidden.
      await page.locator('#cards .header-done').click();
      await until(() => (l.d.deck.store.meta(S1)?.doneAtNs ?? null) === null, 'S1 undone');
      await showsText(page, '#cards .header-done', /^Done$/);
      const p = await connectTestPage(t, l.d, l.server, { focused: false, view: null });
      p.send({ t: 'input', term, data: '/exit\r' });
      await showsText(page, '#cards .card-ended', /^claude exited \(status 0\)/);
      await page.locator('#cards .header-done').click();
      await until(() => (l.d.deck.store.meta(S1)?.doneAtNs ?? null) !== null, 'S1 done again');
      await showsText(page, '#toast .toast-text', new RegExp(`^${escape(DONE_HIDDEN)}$`));
      noProblems(l);
    },
  );

  await t.test(
    "with stage D: the filter `repo#12` matches the session only by a pull request; `p`'s dialog stays open after × detaches it and goes on listing the session's row, which the list no longer shows",
    async (t) => {
      const l = await withGh(t, chromium);
      const { page } = l;
      session(l.d, S1, 2n * MIN, 'alpha work');
      session(l.d, S2, 3n * MIN, 'omega work');
      attach(l.d.deck, S1, 'https://github.com/acme/repo/pull/12');
      attach(l.d.deck, S1, 'https://github.com/acme/other/pull/5');
      await until(async () => (await listed(page)).join() === [S1, S2].join(), 'both listed');
      await clickRow(page, S1);
      await filterTo(page, 'repo#12', [S1]);
      assert.equal(await selectedRow(page), S1);

      await page.keyboard.press('p');
      await until(async () => (await dialog(page)).shown, 'the pull-request dialog');
      await until(async () => (await prLines(page)).length === 2, 'its two lines');
      const lines = await prLines(page);
      assert.match(lines[0] ?? '', /^acme\/other #5 · /);
      assert.match(lines[1] ?? '', /^acme\/repo #12 · /);

      await page
        .locator('#editor .edit-pr', { hasText: 'acme/repo #12' })
        .locator('.edit-pr-remove')
        .click();
      // The list no longer shows S1 (the filter matched it by that pull request alone) …
      await until(async () => (await listed(page)).length === 0, 'S1 hidden by the filter');
      assert.equal(await selectedRow(page), null);
      // … and the dialog, still open, lists the session's row as the server has it now.
      await until(async () => (await prLines(page)).length === 1, 'the line of #12 gone');
      assert.match((await prLines(page))[0] ?? '', /^acme\/other #5 · /);
      assert.equal((await dialog(page)).shown, true, 'the dialog stays open');
      noProblems(l);
    },
  );
}

/** A scripted stand-in's page and the means to serve it lists (helpers/shell.ts). */
async function scripted(
  t: TestContext,
  chromium: Browser,
): Promise<{ page: Page; serve(list: Record<string, unknown>): void }> {
  const secret = new Uint8Array(32).fill(95);
  const page = await newPage(t, chromium);
  let current: Record<string, unknown> = scriptedList([], []);
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        if (message['t'] === 'view') conn.send(current);
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  return {
    page,
    serve(list) {
      current = list;
      standin.connections.at(-1)?.send(list);
    },
  };
}

test('the selected session the list does not show', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "a hidden selection's ended terminal, before its exit has arrived: `claude is not running in this terminal` with Resume and Close, from its selectedRow; a selectedRow of another session is not used",
    async (t) => {
      const s = await scripted(t, chromium);
      const shown = scriptedList(
        [{ id: S1, terminal: TERM_A, slot: null, title: 'alpha work' }],
        [{ id: TERM_A, slot: null, sessionId: S1 }],
      );
      s.serve(shown);
      // The first row is selected at the first list.
      await until(async () => (await selectedRow(s.page)) === S1, 'S1 selected');
      await showsTerminal(s.page, TERM_A);

      // The list no longer shows S1 (as a filter would); its terminal ended, no exit sent yet.
      const [row] = (shown['sections'] as { rows: Record<string, unknown>[] }[])[0]?.rows ?? [];
      assert.ok(row !== undefined);
      const ended = (selectedRow: Record<string, unknown>): Record<string, unknown> => ({
        ...scriptedList([], [{ id: TERM_A, slot: null, sessionId: S1 }]),
        terminals: [
          {
            id: TERM_A,
            slot: null,
            sessionId: S1,
            state: 'ended',
            notReported: false,
            cols: 80,
            rows: 24,
            ownsSize: true,
            openedNs: '1794470400000000000',
          },
        ],
        selectedRow,
      });
      s.serve(ended({ ...row, state: 'not-running' }));
      await showsText(s.page, '#cards .card-ended', /^claude is not running in this terminal$/);
      assert.deepEqual(await barButtons(s.page), ['Resume', 'Close']);
      assert.equal(await shownText(s.page, '#cards .header-title'), 'alpha work');
      assert.equal(await selectedRow(s.page), null);

      // A selectedRow of another session (the server's answer for the selection before): stage
      // A's bar, drawn from the terminal alone — no header, no Resume.
      s.serve(ended({ ...row, id: S2, shortId: S2.slice(0, 8), state: 'not-running' }));
      await until(async () => (await headerHeight(s.page)) === 0, 'no header');
      await showsTerminal(s.page, TERM_A);
      assert.deepEqual(await barButtons(s.page), []);
    },
  );

  await realServerCases(t, chromium);
  await stageDCases(t, chromium);
});
