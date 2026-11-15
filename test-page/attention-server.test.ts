// Attention in a real page against a real server (S2 12.1, 12.2, 12.4, 13, 17.4; plan B task 54,
// B9, B13–B15, F1): a session that finishes while another is selected shows its mark and the
// window title counts it; Ctrl+Shift+J selects it and the hold clears it; a focus report the
// selection makes a program send is no typing; a notification while the page has no focus, and
// its click. The page is built as `launched` builds it (review B, B4), from the parts the helpers
// export, so that the recording `Notification` and the page's focus are in before it loads.
// Notifications go to the recording double, never to the desktop (B17).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { setLabel } from '../src/sessions/meta.ts';
import type { AttentionRow } from '../src/store/types.ts';
import { controlClient } from '../src/window/client.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { startTestServer } from '../test/helpers/window.ts';
import type { StartedServer } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  clickNotification,
  notificationDouble,
  notificationsOf,
  pageFocus,
} from './helpers/notification.ts';
import {
  PAGE_WAIT_MS,
  RECORDER,
  clickRow,
  connection,
  pageUrl,
  problemsOf,
  readPage,
  selectedRow,
} from './helpers/shell.ts';
import { inputOf, promptOf, resumeHere, untilScreen, until } from './helpers/terminal.ts';

/** Sessions a refresh lists, to show that it ran. */
const PROBE_1 = '00000000-0000-4000-8000-000000000001';
const PROBE_2 = '00000000-0000-4000-8000-000000000002';

interface Attended extends Omit<StartedServer, 'page'> {
  page: Page;
  problems: string[];
}

/**
 * As `launched` (helpers/shell.ts): a page (made first, so that it closes first) with `before`'s
 * init scripts and the recorder, a real test server, and the page opened with a launch token of
 * that server; connected, and focused (`pageFocus`: headless Chromium need not say so itself).
 */
async function attended(
  t: TestContext,
  chromium: Browser,
  before?: (page: Page) => Promise<void>,
): Promise<Attended> {
  const page = await newPage(t, chromium);
  await before?.(page);
  await page.addInitScript(RECORDER);
  const problems = problemsOf(page);
  const started = await startTestServer(t);
  const { token } = await controlClient(started.d.platform.net, started.d.files.serverSock).token(
    30,
  );
  await page.goto(pageUrl(started.server.port, token));
  await connection(page, 'open');
  await pageFocus(page, true);
  return { server: started.server, test: started.test, d: started.d, page, problems };
}

/** What the row of `sessionId` shows of attention: its reason and its state line. */
async function rowAttention(
  page: Page,
  sessionId: string,
): Promise<{ attention: string | null; state: string } | null> {
  return readPage(
    page,
    (id) => {
      const row = document.querySelector<HTMLElement>(`#list [data-id="${id}"]`);
      if (row === null) return null;
      return {
        attention: row.dataset['attention'] ?? null,
        state: row.querySelector('.row-state')?.textContent ?? '',
      };
    },
    sessionId,
  );
}

/** Waits until the row of `sessionId` needs you for `reason` (null: it needs nothing). */
async function untilReason(page: Page, sessionId: string, reason: string | null): Promise<void> {
  await until(
    async () => {
      const row = await rowAttention(page, sessionId);
      return row !== null && row.attention === reason;
    },
    `${sessionId}'s row: ${reason ?? 'no attention'}`,
  );
}

async function titleIs(page: Page, title: string): Promise<void> {
  await page.waitForFunction((title) => document.title === title, title, {
    timeout: PAGE_WAIT_MS,
  });
}

/** A line to the stand-in of terminal `term` through the server's hub: nobody types it. */
function say(l: Attended, term: string, line: string): void {
  assert.equal(l.server.hub.input(term, Buffer.from(`${line}\r`, 'utf8')), 'ok');
}

/** `/waiting` (seen as asks, so a look read it), then `/idle`: a turn end the looks see. */
async function endTurn(l: Attended, term: string, sessionId: string): Promise<void> {
  say(l, term, '/waiting a question');
  await untilReason(l.page, sessionId, 'asks');
  say(l, term, '/idle');
}

function stored(l: Attended, sessionId: string): AttentionRow | undefined {
  return l.d.deck.store.attention().find((row) => row.sessionId === sessionId);
}

test('attention against the server', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'a session that finishes while another is selected: its mark and `finished · not seen`, the title (1) skydeck; Ctrl+Shift+J selects it, and after the hold the mark is gone and the title skydeck',
    async (t) => {
      const l = await attended(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await clickRow(page, S2);
      await endTurn(l, term, S1);
      await untilReason(page, S1, 'finished');
      const row = await rowAttention(page, S1);
      assert.match(row?.state ?? '', /^finished · not seen( · .+)?$/);
      await titleIs(page, '(1) skydeck');

      const from = performance.now();
      await page.keyboard.press('Control+Shift+J');
      await until(async () => (await selectedRow(page)) === S1, 'S1 selected');
      await untilReason(page, S1, null);
      await titleIs(page, 'skydeck');
      assert.ok(performance.now() - from >= 1500, 'not before the hold of 1.5 s');
      assert.ok((stored(l, S1)?.seenSeq ?? 0) > (stored(l, S1)?.turnEndedSeq ?? Infinity));
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a program that turned focus reporting on: selected by Ctrl+Shift+J in a window without focus, the focus report its terminal sends is no typing — read by the program, the mark is still there and nothing is seen; with focus it goes after the hold',
    async (t) => {
      const l = await attended(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2);
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      say(l, term, '/red \x1b[?1004hreports on');
      await untilScreen(page, /^reports on$/m);
      const reports = (report: string): number =>
        Buffer.from(inputOf(d.record, S1), 'hex').toString('latin1').split(report).length - 1;
      const focusIns = (): number => reports('\x1b[I');
      await clickRow(page, S2);
      // The keyboard left the terminal: the program read `ESC [ O` into its line; an Enter ends it,
      // so that the commands below start a line of their own.
      await until(() => reports('\x1b[O') > 0, 'the program read the focus leaving');
      say(l, term, '');
      await pageFocus(page, false);
      await endTurn(l, term, S1);
      await untilReason(page, S1, 'finished');

      const ins = focusIns();
      await page.keyboard.press('Control+Shift+J');
      await until(async () => (await selectedRow(page)) === S1, 'S1 selected');
      // The selection put the keyboard into the terminal: xterm.js reports the focus to the program.
      await until(() => focusIns() > ins, 'the program read the focus report');
      // The server took that input before the program read it, and a typing writes its seen at once.
      assert.equal(stored(l, S1)?.seenSeq ?? null, null, 'nothing seen: the report is no typing');
      assert.equal(
        (await rowAttention(page, S1))?.attention,
        'finished',
        'the mark is still there',
      );

      await pageFocus(page, true);
      await untilReason(page, S1, null);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the page without focus and a turn that ends: one notification `finished` with the session’s title; its click selects the session',
    async (t) => {
      const l = await attended(t, chromium, (page) => notificationDouble(page, 'granted'));
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2);
      setLabel(d.deck, S1, 'fix the parser');
      const term = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await clickRow(page, S2);
      // While the page has focus it asks: nothing is notified. Then the focus goes, and `busy`,
      // seen by a look (the ask is gone), lies between that and the turn's end (review 2, C1).
      say(l, term, '/waiting a question');
      await untilReason(page, S1, 'asks');
      assert.deepEqual((await notificationsOf(page)).made, [], 'none while the page has focus');
      await pageFocus(page, false);
      say(l, term, '/busy');
      await untilReason(page, S1, null);
      say(l, term, '/idle');
      await until(async () => (await notificationsOf(page)).made.length > 0, 'the notification');
      const shown = await notificationsOf(page);
      assert.deepEqual(
        shown.made.map(({ title, body, tag }) => ({ title, body, tag })),
        [{ title: 'fix the parser', body: 'finished', tag: S1 }],
      );
      // Two refreshes more, each shown by a session it lists: a notify of either came before it.
      for (const probe of [PROBE_1, PROBE_2]) {
        d.resumable(probe);
        await page.locator(`#list [data-id="${probe}"]`).waitFor({ timeout: PAGE_WAIT_MS });
      }
      assert.equal((await notificationsOf(page)).made.length, 1, 'one notification');

      await clickNotification(page, 0);
      await until(async () => (await selectedRow(page)) === S1, 'the click selects the session');
      assert.deepEqual(l.problems, []);
    },
  );
});
