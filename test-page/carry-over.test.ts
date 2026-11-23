// Follow-up F40 (design 7.1, S2 12.6, 12.9): after `/clear` in a terminal of the window, the page
// that showed it keeps showing it, its selection on the new session's row; and the carry-over bar.
// Real test servers whose terminals run the stand-in, and scripted ones (`editWorld`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { controlClient } from '../src/window/client.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  RECORDER,
  TERM_A,
  active,
  after,
  clickRow,
  connection,
  editWorld,
  launched,
  logOf,
  mark,
  pageUrl,
  scriptedList,
  selectedRow,
  showsText,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import {
  hexOf,
  inputOf,
  promptOf,
  resumeHere,
  shownTerm,
  until,
  untilScreen,
} from './helpers/terminal.ts';

/** Another page of the launched server, opened with a launch token of its own; connected. */
async function anotherPage(t: TestContext, chromium: Browser, l: Launched): Promise<Page> {
  const page = await newPage(t, chromium);
  await page.addInitScript(RECORDER);
  const { token } = await controlClient(l.d.platform.net, l.d.files.serverSock).token(30);
  await page.goto(pageUrl(l.server.port, token));
  await connection(page, 'open');
  return page;
}

/** Waits until `page`'s selected row is not `from` (and is one); that row's id. */
async function untilSelectedMoves(page: Page, from: string): Promise<string> {
  let now: string | null = null;
  await until(
    async () => {
      now = await selectedRow(page);
      return now !== null && now !== from;
    },
    `the selection moves off ${from.slice(0, 8)}`,
  );
  assert.ok(now !== null);
  return now;
}

/**
 * Types `/clear` and Enter into the shown terminal of `page` (the keyboard is in it), once the
 * server has seen the terminal's program hold `sessionId` and a list has told the page so (lists
 * come at most once a second): the follow rule follows a terminal that showed the selection, not
 * one still starting (S2 12.9).
 */
async function typeClear(l: Launched, sessionId: string, page: Page = l.page): Promise<void> {
  await until(
    () => l.server.hub.list().some((term) => term.sessionId === sessionId),
    `a terminal reports ${sessionId.slice(0, 8)}`,
  );
  await page.waitForTimeout(1500);
  await untilScreen(page, promptOf(sessionId));
  await page.keyboard.type('/clear');
  await page.keyboard.press('Enter');
}

test('the selection after /clear (F40)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'the page that showed the terminal shows it on the new session, with the keyboard in it; a second page that showed it follows; one that showed another session does not',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      l.d.resumable(S2);
      const term = await resumeHere(l.page, S1);
      const second = await anotherPage(t, chromium, l);
      await clickRow(second, S1);
      await until(
        async () => (await shownTerm(second)) === term,
        "the second page shows S1's terminal",
      );
      const third = await anotherPage(t, chromium, l);
      await clickRow(third, S2);
      await l.page.bringToFront();
      await mark(l.page, 'clear');
      await typeClear(l, S1);

      const n = await untilSelectedMoves(l.page, S1);
      assert.equal(await shownTerm(l.page), term, 'the same terminal is shown');
      assert.equal(await active(l.page), 'in #terminal', 'the keyboard is still in it');
      await l.page.keyboard.type('z');
      await until(
        () => inputOf(l.d.record, S1).endsWith(hexOf('z')),
        'the next character reaches the program',
      );
      const sent = after(await logOf(l.page), 'clear').filter(
        (entry) => entry.e === 'out' && entry.t === 'view',
      );
      assert.ok(sent.length > 0, 'a view was sent once the selection moved');

      assert.equal(await untilSelectedMoves(second, S1), n, 'the second page follows');
      assert.equal(await shownTerm(second), term);
      assert.equal(await selectedRow(third), S2, 'the third page stays on S2');
    },
  );

  await t.test(
    'with a session selected before the one cleared, Ctrl+Tab after the /clear goes to it, not to the old session',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      l.d.resumable(S2);
      await clickRow(l.page, S2);
      await resumeHere(l.page, S1);
      await typeClear(l, S1);
      await untilSelectedMoves(l.page, S1);
      await l.page.keyboard.press('Control+Tab');
      await until(async () => (await selectedRow(l.page)) === S2, 'Ctrl+Tab selects S2');
    },
  );

  await t.test(
    'a scripted terminal that moves to another session while the list has the keyboard: the selection follows, the keyboard stays in the list',
    async (t) => {
      const page = await newPage(t, chromium);
      const before = scriptedList(
        [
          { id: S1, terminal: TERM_A, slot: 1 },
          { id: S3, terminal: null, slot: null },
        ],
        [{ id: TERM_A, slot: 1, sessionId: S1 }],
      );
      const w = await editWorld(t, page, before);
      await clickRow(page, S1);
      await toZone(page, 'list');
      const keyboard = await active(page);
      w.list(
        scriptedList(
          [
            { id: S2, terminal: TERM_A, slot: 1 },
            { id: S1, terminal: null, slot: null },
            { id: S3, terminal: null, slot: null },
          ],
          [{ id: TERM_A, slot: 1, sessionId: S2 }],
        ),
      );
      await until(async () => (await selectedRow(page)) === S2, 'the selection follows to S2');
      await showsText(page, '#focus-zone', /^Focus: list$/);
      assert.equal(await active(page), keyboard, 'the keyboard stays where it was');
      await until(() => w.selected() === S2, 'a view names S2', PAGE_WAIT_MS);
    },
  );
});

