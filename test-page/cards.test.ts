// The right side (S2 7.8, 7.9, 12.5, 12.6, 12.9's help, 19; plan task 29): the read-only header,
// the resume card, the card of a session running elsewhere, the ended bar, the new form and the key
// help. Scripted cases run against a stand-in server (helpers/shell.ts); the cases of the plan's
// list run against a real test server with the stand-in program (test/helpers/window.ts).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Page } from 'playwright';

import { prepareResumeById } from '../src/sessions/resume-by-id.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { readRecords } from '../test/helpers/standin.ts';
import { connectTestPage } from '../test/helpers/window.ts';
import { listKey, terminalKey, windowChord } from '../web/keys.js';
import type { KeyLike } from '../web/keys.js';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  clickRow,
  connection,
  escape,
  honest,
  launched,
  PAGE_WAIT_MS,
  scriptedList,
  shownText,
  showsText,
  standinServer,
  storeKey,
  TERM_A,
  zone,
} from './helpers/shell.ts';
import type { Launched, StandinConnection } from './helpers/shell.ts';

/** 2026-11-12T09:00:00Z, the stand-in's `nowNs`. */
const NOW_NS = 1794474000000000000n;
const MINUTE_NS = 60_000_000_000n;
const DAY_NS = 1440n * MINUTE_NS;

type Row = Record<string, unknown>;

/**
 * scriptedList's list with `more` over the fields of each row (by session id), over the
 * terminals' fields (by terminal id), and over the list's own fields.
 */
function listWith(
  base: Parameters<typeof scriptedList>,
  more: {
    rows?: Record<string, Row>;
    terminals?: Record<string, Row>;
    list?: Row;
  } = {},
): Row {
  const list = scriptedList(...base) as {
    sections: { rows: Row[] }[];
    terminals: Row[];
  } & Row;
  for (const section of list.sections) {
    section.rows = section.rows.map((row) => ({ ...row, ...more.rows?.[row['id'] as string] }));
  }
  list.terminals = list.terminals.map((term) => ({
    ...term,
    ...more.terminals?.[term['id'] as string],
  }));
  return { ...list, ...more.list };
}

/** A resume card's payload (S2 8.2.3 `list.selected`) for `sessionId`, with `more` over it. */
function selectedOf(sessionId: string, more: Row = {}): Row {
  return {
    sessionId,
    command: `cd /home/u/project && claude --resume ${sessionId}`,
    flagsKnown: true,
    unknownFlags: [],
    ended: 'exited',
    expiring: false,
    expired: false,
    ...more,
  };
}

interface Scripted {
  page: Page;
  /** Every message the page sent after `start` but pings. */
  sent: Row[];
  /** The connection the page uses now. */
  conn(): StandinConnection;
  /** Sends `list` now, and as the answer to every later `view`. */
  serve(list: Row): void;
  /** Answers each `act` with what `answer` gives (default: nothing). */
  answer: { act: ((message: Row) => Row | null) | null };
}

let seed = 40;

/** A page on a stand-in server that knows the page's key and answers every `view` with a list. */
async function scripted(
  t: TestContext,
  chromium: Parameters<typeof newPage>[1],
): Promise<Scripted> {
  const secret = new Uint8Array(32).fill(seed++);
  const page = await newPage(t, chromium);
  const sent: Row[] = [];
  let current: Row = scriptedList([], []);
  const answer: Scripted['answer'] = { act: null };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        sent.push(message);
        if (message['t'] === 'view') conn.send(current);
        if (message['t'] === 'act') {
          const result = answer.act?.(message) ?? null;
          if (result !== null) conn.send({ t: 'result', id: message['id'], ...result });
        }
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  const conn = (): StandinConnection => {
    const last = standin.connections.at(-1);
    assert.ok(last !== undefined);
    return last;
  };
  return {
    page,
    sent,
    conn,
    serve(list) {
      current = list;
      conn().send(list);
    },
    answer,
  };
}

/** The text of every element matching `selector` inside `#cards`, in order, '' for hidden ones. */
async function texts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      [...document.querySelectorAll(`#cards ${selector}`)].map((element) =>
        element instanceof HTMLElement && element.closest('[hidden]') === null
          ? (element.textContent ?? '')
          : '',
      ),
    selector,
  );
}

/** HH:MM:SS of `ns` in UTC (the pages of newPage run in UTC). */
function clock(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString().slice(11, 19);
}

test('the right side', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "the header shows the title, the group, the state, the directory, the short id and design 7.3's chip, all as text",
    async (t) => {
      const s = await scripted(t, chromium);
      s.serve(
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          rows: {
            [S1]: {
              title: 'ORB-7 fix <img src=x onerror="window.hacked=1">',
              group: 'ORB-7',
              groupSource: 'title',
              dir: '/home/u/a <b>dir</b>',
              chip: { level: 'checks-failing', count: 3 },
            },
          },
        }),
      );
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card-header', /ORB-7 fix/);

      assert.deepEqual(await texts(s.page, '.card-header .header-title'), [
        'ORB-7 fix <img src=x onerror="window.hacked=1">',
      ]);
      assert.deepEqual(await texts(s.page, '.card-header .header-group'), ['ORB-7']);
      assert.match(
        (await s.page.getAttribute('#cards .header-group', 'title')) ?? '',
        /from the title/,
      );
      assert.deepEqual(await texts(s.page, '.card-header .header-state'), ['not running']);
      assert.deepEqual(await texts(s.page, '.card-header .header-dir'), ['/home/u/a <b>dir</b>']);
      assert.deepEqual(await texts(s.page, '.card-header .header-id'), [S1.slice(0, 8)]);
      assert.deepEqual(await texts(s.page, '.card-header .header-chip'), ['3 PRs · failing']);
      assert.equal(await s.page.evaluate(() => Reflect.get(window, 'hacked')), undefined);
      assert.equal(await s.page.locator('#cards img').count(), 0, 'no markup from a title');

      // The state words of stage A (S2 19), the detail in brackets (design 7.4); one PR; no chip
      // and no group when there are none.
      for (const [fields, state, chip] of [
        [
          { state: 'working', stateDetail: null, chip: { level: 'draft', count: 1 } },
          'working',
          'PR · draft',
        ],
        [{ state: 'waiting', stateDetail: 'permission' }, 'waiting (permission)', ''],
        [
          { state: 'running', elsewhere: { pid: 77, tty: null, dir: null } },
          'running in another terminal',
          '',
        ],
        [{ state: 'not-running', starting: true }, 'starting…', ''],
      ] as const) {
        s.serve(
          listWith([[{ id: S1, terminal: null, slot: null }], []], {
            rows: { [S1]: { group: null, groupSource: null, chip: null, ...fields } },
          }),
        );
        await showsText(s.page, '#cards .header-state', new RegExp(`^${escape(state)}$`));
        assert.deepEqual(await texts(s.page, '.card-header .header-chip'), [chip]);
        assert.deepEqual(await texts(s.page, '.card-header .header-group'), ['']);
      }

      // Nothing selected — the row is gone from the list: no header and no card of a session that
      // is not shown (S2 12.6; ruled for task 27, 14:41Z).
      s.serve(scriptedList([], []));
      await s.page.waitForSelector('#right-zone[data-pane="none"]', { state: 'attached' });
      assert.equal(
        await s.page.evaluate(() => document.getElementById('cards')?.innerText.trim()),
        '',
      );
    },
  );

  await t.test(
    "the header's chip reads exactly as the selected row's chip in the list (one implementation of its words)",
    async (t) => {
      const s = await scripted(t, chromium);
      for (const chip of [
        { level: 'checks-failing', count: 3 },
        { level: 'review-required', count: 1 },
        { level: 'cant-read', count: 2 },
        { level: 'merged', count: 30 },
      ]) {
        s.serve(
          listWith([[{ id: S1, terminal: null, slot: null }], []], { rows: { [S1]: { chip } } }),
        );
        if ((await s.page.locator(`#list [data-id="${S1}"][data-selected="true"]`).count()) === 0) {
          await clickRow(s.page, S1);
        }
        const inList = s.page.locator(`#list [data-id="${S1}"] .row-chip`);
        await s.page.waitForFunction(
          (level) =>
            document.querySelector('#cards .header-chip')?.getAttribute('data-level') === level,
          chip.level,
        );
        const listed = (await inList.textContent()) ?? '';
        assert.notEqual(listed, '');
        assert.deepEqual(await texts(s.page, '.card-header .header-chip'), [listed]);
      }
    },
  );

  await t.test(
    'the header has one height and stays inside the window: a short directory, one of 340 characters, a title of 800, a window of 1280 and of 900 px; the directory and the title are cut with an ellipsis but whole in the page, the short id never cut, the terminal area unchanged',
    async (t) => {
      const s = await scripted(t, chromium);
      await s.page.setViewportSize({ width: 1280, height: 800 });
      const longDir = `/home/u/${'a-very-long-directory-name/'.repeat(13)}end`;
      assert.ok(longDir.length >= 340);
      const longTitle = `a title ${'that goes on '.repeat(61)}end`;
      assert.ok(longTitle.length >= 800);
      const show = (dir: string, title: string): void =>
        s.serve(
          listWith(
            [[{ id: S1, terminal: TERM_A, slot: 1 }], [{ id: TERM_A, slot: 1, sessionId: S1 }]],
            { rows: { [S1]: { dir, title } } },
          ),
        );
      /** The last terminal area the page reported (S2 8.2.3 `focus.area`), once it settled. */
      const lastArea = async (): Promise<unknown> => {
        await sleep(600); // the page reports a resize 200 ms after it settles
        return s.sent.filter((message) => message['t'] === 'focus').at(-1)?.['area'];
      };
      const measure = (): Promise<{
        height: number;
        zoneInside: boolean;
        idInside: boolean;
        pageFits: boolean;
        dirCut: boolean;
        titleCut: boolean;
        dirTitle: string;
        dirText: string;
        titleText: string;
      }> =>
        s.page.evaluate(() => {
          const part = (selector: string): HTMLElement =>
            document.querySelector(selector) as HTMLElement;
          const id = part('#cards .header-id');
          const dir = part('#cards .header-dir');
          const title = part('#cards .header-title');
          const idBox = id.getBoundingClientRect();
          return {
            height: part('#cards .card-header').getBoundingClientRect().height,
            zoneInside: part('#right-zone').getBoundingClientRect().right <= innerWidth,
            idInside:
              idBox.width > 0 && idBox.right <= innerWidth && id.scrollWidth <= id.clientWidth,
            pageFits: document.documentElement.scrollWidth === innerWidth,
            dirCut: dir.scrollWidth > dir.clientWidth,
            titleCut: title.scrollWidth > title.clientWidth,
            dirTitle: dir.title,
            dirText: dir.textContent ?? '',
            titleText: title.textContent ?? '',
          };
        });
      const inside = (m: Awaited<ReturnType<typeof measure>>, what: string): void => {
        assert.ok(m.zoneInside, `${what}: the right zone stays inside the window`);
        assert.ok(m.idInside, `${what}: the short id is whole and inside the window`);
        assert.ok(m.pageFits, `${what}: the page is no wider than the window`);
      };

      show('/home/u/short', 'a title');
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .header-dir', /^\/home\/u\/short$/);
      const short = await measure();
      inside(short, 'a short directory');
      const area = await lastArea();
      assert.ok(area !== undefined);

      show(longDir, 'a title');
      await showsText(s.page, '#cards .header-dir', /end$/);
      const dir = await measure();
      inside(dir, 'a directory of 340 characters');
      assert.ok(dir.dirCut, 'the directory is cut');
      assert.equal(dir.height, short.height, 'a long directory does not change the height');
      assert.equal(dir.dirText, longDir, 'the whole directory is in the page');
      assert.equal(dir.dirTitle, longDir, 'and in its tooltip');
      assert.deepEqual(await lastArea(), area, 'the terminal area does not change');
      await s.page.locator('#cards .header-dir').click({ clickCount: 3 });
      assert.equal(
        await s.page.evaluate(() => getSelection()?.toString().replace(/\n$/, '')),
        longDir,
        'a selection copies the whole directory',
      );
      await s.page.evaluate(() => getSelection()?.removeAllRanges());

      show('/home/u/short', longTitle);
      await showsText(s.page, '#cards .header-title', /end$/);
      const title = await measure();
      inside(title, 'a title of 800 characters');
      assert.ok(title.titleCut, 'the title is cut');
      assert.equal(title.titleText, longTitle);
      assert.equal(title.height, short.height);
      assert.deepEqual(await lastArea(), area, 'the terminal area does not change');

      show(longDir, longTitle);
      await s.page.setViewportSize({ width: 900, height: 700 });
      await sleep(300);
      const narrow = await measure();
      inside(narrow, 'both long at 900 px');
      assert.equal(narrow.height, short.height, 'a narrow window does not change the height');

      // The cards wrap what they show: a resume card with a long unbroken command, flags and
      // directory stays inside the window too.
      s.serve(
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          rows: { [S1]: { dir: longDir, title: longTitle } },
          list: {
            selected: selectedOf(S1, {
              command: `cd ${longDir} && claude --resume ${S1}`,
              unknownFlags: [`--${'x'.repeat(400)}`],
            }),
          },
        }),
      );
      await s.page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      await showsText(s.page, '#cards .card-command', /--resume/);
      inside(await measure(), 'a resume card with long texts at 900 px');
    },
  );

  await t.test(
    'a click on the short id copies the whole id and leaves the keyboard where it was; text of the header stays selected when a list changes another of its fields',
    async (t) => {
      const s = await scripted(t, chromium);
      await s.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      const list = (state: string): Row =>
        listWith(
          [
            [
              { id: S1, terminal: null, slot: null },
              { id: S2, terminal: null, slot: null },
            ],
            [],
          ],
          {
            rows: { [S1]: { state, dir: '/home/u/selectable' } },
            list: { selected: selectedOf(S1) },
          },
        );
      s.serve(list('not-running'));
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .header-id', new RegExp(`^${S1.slice(0, 8)}$`));
      await s.page.focus('#list');

      await s.page.locator('#cards .header-id').click();
      await s.page.waitForFunction(
        async (id) => (await navigator.clipboard.readText()) === id,
        S1,
        { timeout: 5000 },
      );
      assert.equal(await active(s.page), '#list', 'the click took no keyboard');
      // The feedback goes away by itself.
      await showsText(s.page, '#cards .header-copied', /^id copied$/);
      await showsText(s.page, '#cards .header-copied', /^$/, 5000);
      // Another session in the header: the feedback of the first is gone at once, and the second
      // copies its own id.
      await s.page.locator('#cards .header-id').click();
      await showsText(s.page, '#cards .header-copied', /^id copied$/);
      await clickRow(s.page, S2);
      await showsText(s.page, '#cards .header-id', new RegExp(`^${S2.slice(0, 8)}$`));
      assert.equal(await shownText(s.page, '#cards .header-copied'), '');
      await s.page.locator('#cards .header-id').click();
      await s.page.waitForFunction(
        async (id) => (await navigator.clipboard.readText()) === id,
        S2,
        { timeout: 5000 },
      );
      await clickRow(s.page, S1);
      await s.page.focus('#list');

      await s.page.locator('#cards .header-dir').click({ clickCount: 3 });
      const selected = (): Promise<string> =>
        s.page.evaluate(() => getSelection()?.toString().trim() ?? '');
      assert.equal(await selected(), '/home/u/selectable');
      s.serve(list('running')); // the state changes, the directory does not
      await showsText(s.page, '#cards .header-state', /^running$/);
      assert.equal(await selected(), '/home/u/selectable', 'the selection is kept');
    },
  );

  await t.test(
    "the resume card shows how it ended, the last activity, the directory, the exact command, the flags not passed on and the expiring warning; an expired session's button is disabled",
    async (t) => {
      const s = await scripted(t, chromium);
      const rows = [[{ id: S1, terminal: null, slot: null }], []] as Parameters<
        typeof scriptedList
      >;
      const show = (selected: Row, row: Row = {}): void =>
        s.serve(
          listWith(rows, {
            rows: { [S1]: { lastActivityNs: String(NOW_NS - 90n * MINUTE_NS), ...row } },
            list: { selected: selectedOf(S1, selected) },
          }),
        );
      show({ unknownFlags: ['--frobnicate', '--x'] });
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card-command', /claude --resume/);

      assert.deepEqual(await texts(s.page, '.card-command'), [
        `cd /home/u/project && claude --resume ${S1}`,
      ]);
      assert.deepEqual(await texts(s.page, '.card-ended'), ['Exited normally.']);
      // 07:30 UTC on the day of the list (newPage runs in UTC; the time is the page's clock's day).
      assert.match((await texts(s.page, '.card-activity'))[0] ?? '', /07:30/);
      assert.deepEqual(await texts(s.page, '.card-dir'), ['/home/u/project']);
      assert.deepEqual(await texts(s.page, '.card-warning'), [
        'started with flags skydeck does not know, not passed on resume: --frobnicate --x',
      ]);
      const button = s.page.locator('#cards button', { hasText: 'Resume here' });
      assert.equal(await button.isDisabled(), false);
      assert.deepEqual(await texts(s.page, '.card-hint'), [
        'opens in this window, in a new terminal',
      ]);

      show({ ended: 'mid-turn', flagsKnown: false, expiring: true });
      await showsText(
        s.page,
        '#cards .card-ended',
        /^Ended unexpectedly in the middle of a turn\.$/,
      );
      const warnings = await texts(s.page, '.card-warning');
      assert.ok(
        warnings.includes('original flags unknown; resuming with defaults'),
        String(warnings),
      );
      assert.ok(
        warnings.includes('its transcript will be deleted soon unless the session is resumed') &&
          warnings.every((line) => !/[0-9]/.test(line)),
        String(warnings),
      );

      show({ ended: 'unexpectedly' });
      await showsText(s.page, '#cards .card-ended', /^Ended unexpectedly\.$/);

      show({ ended: null, command: null, expired: true });
      await showsText(s.page, '#cards .card-ended', /transcript is gone/);
      assert.equal(await button.isDisabled(), true, 'an expired session cannot be resumed');
      assert.deepEqual(await texts(s.page, '.card-hint'), [''], 'nothing opens: no hint');
      assert.deepEqual(await texts(s.page, '.card-command'), [''], 'nothing will run');
      show({ command: null });
      await showsText(s.page, '#cards .card-command', /cannot/);
    },
  );

  await t.test(
    'Resume here sends act resume; while it waits a second press sends nothing; a refusal shows its lines on the card and releases the button, and so does a lost connection',
    async (t) => {
      const s = await scripted(t, chromium);
      let release: (result: Row) => void = () => {};
      s.answer.act = (message) => {
        void new Promise<Row>((resolve) => {
          release = resolve;
        }).then((result) => s.conn().send({ t: 'result', id: message['id'], ...result }));
        return null;
      };
      s.serve(
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          list: { selected: selectedOf(S1) },
        }),
      );
      await clickRow(s.page, S1);
      const button = s.page.locator('#cards button', { hasText: 'Resume here' });
      await button.click();
      await button.click();
      await sleep(300);
      const acts = s.sent.filter((message) => message['t'] === 'act');
      assert.equal(acts.length, 1, 'one resume');
      assert.equal(acts[0]?.['kind'], 'resume');
      assert.equal(acts[0]?.['sessionId'], S1);

      release({
        ok: false,
        lines: [`${S1.slice(0, 8)} is running (pid 4242)`],
        error: `${S1.slice(0, 8)} is running (pid 4242)`,
        sessionId: null,
      });
      await showsText(
        s.page,
        '#cards .card-lines',
        new RegExp(`${S1.slice(0, 8)} is running \\(pid 4242\\)`),
      );

      // The refusal released the button; a lost connection releases it too.
      await button.click();
      await sleep(300);
      assert.equal(s.sent.filter((message) => message['t'] === 'act').length, 2);
      const first = s.conn();
      first.ws.terminate();
      await showsText(s.page, '#cards .card-lines', /stopped answering/);
      await connection(s.page, 'open');
      assert.notEqual(s.conn(), first, 'a new connection');
      await button.click();
      const deadline = performance.now() + PAGE_WAIT_MS;
      while (s.sent.filter((message) => message['t'] === 'act').length < 3) {
        assert.ok(performance.now() < deadline, 'a resume on the new connection');
        await sleep(50);
      }
    },
  );

  await t.test(
    'a held Enter never resumes or starts again: its auto-repeats on Resume here and in the new form send nothing; a fresh press does',
    async (t) => {
      const s = await scripted(t, chromium);
      s.answer.act = () => ({ ok: false, lines: ['refused'], error: 'refused', sessionId: null });
      const acts = (): number => s.sent.filter((message) => message['t'] === 'act').length;
      const cdp = await s.page.context().newCDPSession(s.page);
      const enter = async (autoRepeat: boolean): Promise<void> => {
        for (const type of ['keyDown', 'keyUp'] as const) {
          if (type === 'keyUp' && autoRepeat) continue; // a held key repeats its keydown only
          await cdp.send('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            ...(type === 'keyDown' ? { text: '\r', autoRepeat } : {}),
          });
        }
      };
      s.serve(
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          list: { selected: selectedOf(S1) },
        }),
      );
      await clickRow(s.page, S1);
      await s.page.focus('#cards button');
      await enter(false);
      await showsText(s.page, '#cards .card-lines', /^refused$/);
      assert.equal(acts(), 1);
      for (let i = 0; i < 3; i++) await enter(true);
      await sleep(300);
      assert.equal(acts(), 1, 'the repeats of a held Enter resume nothing');
      await enter(false);
      await sleep(300);
      assert.equal(acts(), 2, 'a fresh press does');

      await s.page.keyboard.press('Control+Shift+N');
      await s.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await s.page.focus('#cards input[name="label"]');
      await enter(false);
      await showsText(s.page, '#cards .card-new .card-lines', /^refused$/);
      assert.equal(acts(), 3);
      for (let i = 0; i < 3; i++) await enter(true);
      await sleep(300);
      assert.equal(acts(), 3, 'the repeats of a held Enter start nothing');
    },
  );

  await t.test(
    'a list that changes the resume card between the mousedown and the mouseup on its button loses no click',
    async (t) => {
      const s = await scripted(t, chromium);
      s.answer.act = () => ({ ok: false, lines: ['refused'], error: 'refused', sessionId: null });
      const listFor = (command: string): Row =>
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          list: { selected: selectedOf(S1, { command }) },
        });
      s.serve(listFor('claude --resume one'));
      await clickRow(s.page, S1);
      const box = await s.page.locator('#cards button', { hasText: 'Resume here' }).boundingBox();
      assert.ok(box !== null);
      await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await s.page.mouse.down();
      s.serve(listFor('claude --resume two'));
      await showsText(s.page, '#cards .card-command', /two/);
      await s.page.mouse.up();
      await sleep(300);

      assert.equal(
        s.sent.filter((message) => message['t'] === 'act').length,
        1,
        'the click resumed',
      );
    },
  );

  await t.test(
    'a list that changes nothing the resume card says leaves the keyboard on its button; one that changes its command gives the keyboard to the zone (an Enter must not resume what the user has not seen)',
    async (t) => {
      const s = await scripted(t, chromium);
      const listFor = (command: string, sinceNs: string): Row =>
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          rows: { [S1]: { sinceNs } },
          list: { selected: selectedOf(S1, { command }) },
        });
      s.serve(listFor('claude --resume one', '1'));
      await clickRow(s.page, S1);
      await s.page.focus('#cards button');
      s.serve(listFor('claude --resume one', '2')); // a field the card does not show
      await sleep(300);
      assert.equal(await active(s.page), 'BUTTON');
      s.serve(listFor('claude --resume two', '2'));
      await showsText(s.page, '#cards .card-command', /two/);
      assert.equal(await active(s.page), '#right-zone');
    },
  );

  await t.test(
    'a session running in another terminal shows its pid, its terminal device, its directory and that it cannot be shown here',
    async (t) => {
      const s = await scripted(t, chromium);
      s.serve(
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          rows: {
            [S1]: {
              state: 'running',
              dir: '/home/u/far',
              elsewhere: { pid: 4321, tty: '/dev/pts/7', dir: '/home/u/far' },
            },
          },
        }),
      );
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card', /4321/);
      const text = await shownText(s.page, '#cards .card');
      assert.match(text, /pid 4321/);
      assert.match(text, /\/dev\/pts\/7/);
      assert.match(text, /\/home\/u\/far/);
      assert.match(text, /cannot be shown here/);
      assert.equal(await s.page.locator('#cards .card button').count(), 0, 'nothing to press');
    },
  );

  await t.test(
    'the ended bar: the status and the time; a signal; lost; not started; Resume and Close send their actions and show a refusal',
    async (t) => {
      const s = await scripted(t, chromium);
      s.answer.act = (message) =>
        message['kind'] === 'close-terminal'
          ? {
              ok: false,
              lines: ['the program still runs; end it inside claude'],
              error: 'the program still runs; end it inside claude',
              sessionId: null,
            }
          : { ok: false, lines: ['no, not now'], error: 'no, not now', sessionId: null };
      const ended = (state: string): Row =>
        listWith(
          [[{ id: S1, terminal: TERM_A, slot: null }], [{ id: TERM_A, slot: null, sessionId: S1 }]],
          {
            rows: { [S1]: { state: 'not-running' } },
            terminals: { [TERM_A]: { state } },
          },
        );
      const atNs = NOW_NS + 5n * MINUTE_NS + 7_000_000_000n;
      const exit = (more: Row): Row => ({
        t: 'exit',
        term: TERM_A,
        code: null,
        signal: null,
        atNs: String(atNs),
        lost: false,
        notStarted: null,
        ...more,
      });
      s.serve(ended('not-started'));
      await clickRow(s.page, S1);
      await s.page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      // Before the exit arrives: a text true of every terminal whose program is over (this one
      // never started), and both buttons.
      await showsText(s.page, '#cards .card-ended', /^claude is not running in this terminal$/);
      assert.deepEqual(await s.page.locator('#cards .card-bar button').allTextContents(), [
        'Resume',
        'Close',
      ]);
      s.serve(ended('ended'));
      s.conn().send(exit({ code: 0 }));
      await showsText(
        s.page,
        '#cards .card-ended',
        new RegExp(`^claude exited \\(status 0\\) at ${clock(atNs)}`),
      );

      s.conn().send(exit({ signal: 9 }));
      await showsText(
        s.page,
        '#cards .card-ended',
        new RegExp(`^claude was ended by signal 9 at ${clock(atNs)}`),
      );
      s.serve(ended('lost'));
      s.conn().send(exit({ signal: 1, lost: true }));
      await showsText(
        s.page,
        '#cards .card-ended',
        /^the terminal's keeper ended unexpectedly; claude ended with it$/,
      );
      s.serve(ended('not-started'));
      s.conn().send(exit({ notStarted: 'its resume lock was taken over' }));
      await showsText(
        s.page,
        '#cards .card-ended',
        /^not started: its resume lock was taken over$/,
      );

      await s.page.locator('#cards button', { hasText: 'Resume' }).click();
      await showsText(s.page, '#cards .card-lines', /^no, not now$/);
      await s.page.locator('#cards button', { hasText: 'Close' }).click();
      await showsText(
        s.page,
        '#cards .card-lines',
        /^the program still runs; end it inside claude$/,
      );
      const acts = s.sent.filter((message) => message['t'] === 'act');
      assert.deepEqual(
        acts.map((message) => [message['kind'], message['sessionId'] ?? message['term']]),
        [
          ['resume', S1],
          ['close-terminal', TERM_A],
        ],
      );
    },
  );

  await t.test(
    "the new form: the selected session's directory by default and the known ones as its list; Enter sends act new with what was typed; the server's refusal is shown in the form",
    async (t) => {
      const s = await scripted(t, chromium);
      s.answer.act = () => ({
        ok: false,
        lines: ['cannot pass -r to claude: it picks an existing session; use skydeck resume'],
        error: 'cannot pass -r to claude: it picks an existing session; use skydeck resume',
        sessionId: null,
      });
      s.serve(
        listWith(
          [
            [
              { id: S1, terminal: null, slot: null },
              { id: S2, terminal: null, slot: null },
            ],
            [],
          ],
          {
            rows: { [S1]: { dir: '/home/u/one' }, [S2]: { dir: '/home/u/two' } },
            list: { dirs: ['/home/u/two', '/home/u/one', '/srv/three'] },
          },
        ),
      );
      await clickRow(s.page, S2);
      await s.page.keyboard.press('Control+Shift+N');
      await s.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });

      assert.equal(await s.page.inputValue('#cards input[name="directory"]'), '/home/u/two');
      assert.equal(
        await s.page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name),
        'directory',
        'the form has the keyboard in its first field',
      );
      const listed = await s.page.evaluate(() => {
        const input = document.querySelector('#cards input[name="directory"]');
        return input instanceof HTMLInputElement && input.list !== null
          ? [...input.list.options].map((option) => option.value)
          : [];
      });
      assert.deepEqual(listed, ['/home/u/two', '/home/u/one', '/srv/three']);

      await s.page.fill('#cards input[name="directory"]', '/srv/three');
      await s.page.fill('#cards input[name="label"]', 'ORB-9 fix');
      await s.page.fill('#cards input[name="group"]', 'g');
      await s.page.fill('#cards input[name="flags"]', '-r x');
      await s.page.keyboard.press('Enter');
      await showsText(
        s.page,
        '#cards .card-new',
        /cannot pass -r to claude: it picks an existing session/,
      );

      const acts = s.sent.filter((message) => message['t'] === 'act');
      assert.equal(acts.length, 1);
      assert.deepEqual(
        {
          kind: acts[0]?.['kind'],
          dir: acts[0]?.['dir'],
          label: acts[0]?.['label'],
          group: acts[0]?.['group'],
          flags: acts[0]?.['flags'],
          sized: typeof acts[0]?.['cols'] === 'number' && typeof acts[0]?.['rows'] === 'number',
        },
        {
          kind: 'new',
          dir: '/srv/three',
          label: 'ORB-9 fix',
          group: 'g',
          flags: '-r x',
          sized: true,
        },
      );
      assert.equal(await zone(s.page), 'Focus: terminal');
      assert.equal(await s.page.inputValue('#cards input[name="flags"]'), '-r x', 'kept for a fix');
      assert.deepEqual(await texts(s.page, '.card-hint'), ['starts in this window · Esc closes']);
    },
  );

  await t.test(
    'the new form: a second Enter while a start is pending sends nothing; a lost connection ends the wait and Start works again',
    async (t) => {
      const s = await scripted(t, chromium);
      s.answer.act = () => null; // never answered
      const acts = (): number => s.sent.filter((message) => message['t'] === 'act').length;
      s.serve(listWith([[{ id: S1, terminal: null, slot: null }], []]));
      await clickRow(s.page, S1);
      await s.page.keyboard.press('Control+Shift+N');
      await s.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await s.page.fill('#cards input[name="label"]', 'x');
      await s.page.keyboard.press('Enter');
      await s.page.keyboard.press('Enter');
      await sleep(300);
      assert.equal(acts(), 1);

      const first = s.conn();
      first.ws.terminate();
      await showsText(s.page, '#cards .card-new', /stopped answering/);
      await connection(s.page, 'open');
      assert.notEqual(s.conn(), first, 'a new connection');
      await s.page.locator('#cards button', { hasText: 'Start' }).click();
      const deadline = performance.now() + PAGE_WAIT_MS;
      while (acts() < 2) {
        assert.ok(performance.now() < deadline, 'a start on the new connection');
        await sleep(50);
      }
    },
  );

  await t.test(
    'the exact command, the directories, the terminal device and the lines are shown and copied with every space they have',
    async (t) => {
      const s = await scripted(t, chromium);
      const dir = '/home/u/My  Project';
      const command = `cd '${dir}' && claude --resume ${S1}  -n 'a  b'`;
      s.answer.act = () => ({
        ok: false,
        lines: ['two  spaces'],
        error: 'two  spaces',
        sessionId: null,
      });
      s.serve(
        listWith(
          [
            [
              { id: S1, terminal: null, slot: null },
              { id: S2, terminal: null, slot: null },
            ],
            [],
          ],
          {
            rows: {
              [S1]: { dir },
              [S2]: { state: 'running', elsewhere: { pid: 5, tty: '/dev/pts/7  x', dir } },
            },
            list: { selected: selectedOf(S1, { command, unknownFlags: ['--a  b'] }) },
          },
        ),
      );
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card-command', /claude/);
      const rendered = (selector: string): Promise<string[]> =>
        s.page.evaluate(
          (selector) =>
            [...document.querySelectorAll(`#cards ${selector}`)].map((element) =>
              element instanceof HTMLElement ? element.innerText : '',
            ),
          selector,
        );
      assert.deepEqual(await rendered('.card-command'), [command]);
      assert.deepEqual(await rendered('.card-dir'), [dir]);
      assert.deepEqual(await rendered('.header-dir'), [dir]);
      assert.deepEqual(await rendered('.card-warning'), [
        'started with flags skydeck does not know, not passed on resume: --a  b',
      ]);
      for (const selector of [
        '.header-dir',
        '.header-id',
        '.card-command',
        '.card-dir',
        '.card-warning',
        '.card-lines',
        '.card-ended',
        '.card-where',
      ]) {
        assert.equal(
          await s.page.evaluate((selector) => {
            const probe = document.createElement('span');
            probe.className = selector.slice(1);
            document.getElementById('cards')?.append(probe);
            const space = getComputedStyle(probe).whiteSpace;
            probe.remove();
            return space;
          }, selector),
          selector === '.header-dir' || selector === '.header-id' ? 'pre' : 'pre-wrap',
          `${selector} keeps its spaces`,
        );
      }
      await s.page.locator('#cards .card-command').click({ clickCount: 3 });
      assert.equal(
        await s.page.evaluate(() => getSelection()?.toString().replace(/\n$/, '')),
        command,
      );
      await s.page.locator('#cards button', { hasText: 'Resume here' }).click();
      await showsText(s.page, '#cards .card-lines', /two/);
      assert.deepEqual(await rendered('.card-lines'), ['two  spaces']);
      await clickRow(s.page, S2);
      await showsText(s.page, '#cards .card-where', /pid 5/);
      assert.deepEqual(await rendered('.card-where'), ['pid 5 · /dev/pts/7  x']);
    },
  );

  await t.test(
    'a 300-character word in every field of the cards, the bar and the form wraps inside its box: nothing is wider than its box, the cards do not scroll sideways, the text is copied whole',
    async (t) => {
      const s = await scripted(t, chromium);
      await s.page.setViewportSize({ width: 1280, height: 800 });
      const path = `/${'p'.repeat(299)}`;
      s.answer.act = () => ({
        ok: false,
        lines: [`cannot use ${path}`],
        error: `cannot use ${path}`,
        sessionId: null,
      });
      s.serve(
        listWith(
          [
            [
              { id: S1, terminal: null, slot: null },
              { id: S2, terminal: null, slot: null },
              { id: S3, terminal: TERM_A, slot: 1 },
            ],
            [{ id: TERM_A, slot: 1, sessionId: S3 }],
          ],
          {
            rows: {
              [S1]: { dir: path },
              [S2]: { state: 'running', elsewhere: { pid: 9, tty: path, dir: path } },
            },
            terminals: { [TERM_A]: { state: 'not-started' } },
            list: {
              selected: selectedOf(S1, {
                command: `cd ${path} && claude --resume ${S1}`,
                unknownFlags: [`--x=${path}`],
              }),
            },
          },
        ),
      );
      const fits = async (where: string): Promise<void> => {
        const wide = await s.page.evaluate(() =>
          [...document.querySelectorAll('#cards .card, #cards .card *')]
            .filter(
              (element): element is HTMLElement =>
                element instanceof HTMLElement &&
                element.checkVisibility() &&
                element.clientWidth > 0 &&
                element.scrollWidth > element.clientWidth,
            )
            .map(
              (element) => `${element.className}: ${element.scrollWidth} > ${element.clientWidth}`,
            ),
        );
        assert.deepEqual(wide, [], `${where}: nothing wider than its box`);
        const cards = await s.page.evaluate(() => {
          const element = document.getElementById('cards') as HTMLElement;
          return [element.scrollWidth, element.clientWidth];
        });
        assert.equal(cards[0], cards[1], `${where}: the cards do not scroll sideways`);
      };
      const copied = async (selector: string, text: string): Promise<void> => {
        await s.page.locator(`#cards ${selector}`).first().click({ clickCount: 3 });
        assert.equal(
          await s.page.evaluate(() => getSelection()?.toString().replace(/\n$/, '')),
          text,
          `${selector} is copied whole`,
        );
        await s.page.evaluate(() => getSelection()?.removeAllRanges());
      };

      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card-command', /--resume/);
      await fits('the resume card');
      await copied(
        '.card-warning',
        `started with flags skydeck does not know, not passed on resume: --x=${path}`,
      );
      await copied('.card-dir', path);
      await s.page.locator('#cards button', { hasText: 'Resume here' }).click();
      await showsText(s.page, '#cards .card-lines', /cannot use/);
      await fits('a refusal on the resume card');
      await copied('.card-lines', `cannot use ${path}`);

      await clickRow(s.page, S2);
      await showsText(s.page, '#cards .card-where', /pid 9/);
      await fits('the elsewhere card');

      await clickRow(s.page, S3);
      await s.page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      s.conn().send({
        t: 'exit',
        term: TERM_A,
        code: null,
        signal: null,
        atNs: String(NOW_NS),
        lost: false,
        notStarted: path,
      });
      await showsText(s.page, '#cards .card-ended', /^not started: /);
      await fits('the ended bar');
      await copied('.card-ended', `not started: ${path}`);
      await s.page.locator('#cards .card-bar button', { hasText: 'Resume' }).click();
      await showsText(s.page, '#cards .card-lines', /cannot use/);
      await fits("the ended bar's refusal");

      await s.page.keyboard.press('Control+Shift+N');
      await s.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await s.page.locator('#cards button', { hasText: 'Start' }).click();
      await showsText(s.page, '#cards .card-new .card-lines', /cannot use/);
      await fits("the form's refusal");
    },
  );

  await t.test(
    "the times on the right side by the page's clock: today, yesterday, an older day, another year",
    async (t) => {
      const s = await scripted(t, chromium);
      await s.page.clock.setFixedTime(new Date(Number(NOW_NS / 1_000_000n)));
      const card = (lastActivityNs: bigint): void =>
        s.serve(
          listWith([[{ id: S1, terminal: null, slot: null }], []], {
            rows: { [S1]: { lastActivityNs: String(lastActivityNs) } },
            list: { selected: selectedOf(S1) },
          }),
        );
      card(NOW_NS - 90n * MINUTE_NS);
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card-activity', /^today at 07:30$/);
      card(NOW_NS - DAY_NS);
      await showsText(s.page, '#cards .card-activity', /^yesterday at 09:00$/);
      card(NOW_NS - 3n * DAY_NS);
      await showsText(s.page, '#cards .card-activity', /^9 Nov at 09:00$/);
      card(NOW_NS - 366n * DAY_NS);
      await showsText(s.page, '#cards .card-activity', /^11 Nov 2025 at 09:00$/);

      s.serve(
        listWith(
          [[{ id: S1, terminal: TERM_A, slot: null }], [{ id: TERM_A, slot: null, sessionId: S1 }]],
          { terminals: { [TERM_A]: { state: 'ended' } } },
        ),
      );
      await s.page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      const exit = (atNs: bigint): void =>
        s.conn().send({
          t: 'exit',
          term: TERM_A,
          code: 0,
          signal: null,
          atNs: String(atNs),
          lost: false,
          notStarted: null,
        });
      exit(NOW_NS + 5n * MINUTE_NS + 7_000_000_000n);
      await showsText(s.page, '#cards .card-ended', /^claude exited \(status 0\) at 09:05:07$/);
      exit(NOW_NS - DAY_NS);
      await showsText(
        s.page,
        '#cards .card-ended',
        /^claude exited \(status 0\) at 09:00:00 yesterday$/,
      );
      exit(NOW_NS - 3n * DAY_NS);
      await showsText(
        s.page,
        '#cards .card-ended',
        /^claude exited \(status 0\) at 09:00:00 on 9 Nov$/,
      );
    },
  );

  await t.test(
    'every server string of the header and the cards reaches the page as text, never as markup',
    async (t) => {
      const s = await scripted(t, chromium);
      const img = '<img src=x>';
      s.answer.act = () => ({
        ok: false,
        lines: [`no ${img}`],
        error: `no ${img}`,
        sessionId: null,
      });
      const noMarkup = async (where: string): Promise<void> => {
        assert.equal(await s.page.locator('#cards img, #cards b').count(), 0, where);
      };
      s.serve(
        listWith(
          [
            [
              { id: S1, terminal: null, slot: null },
              { id: S2, terminal: null, slot: null },
              { id: S3, terminal: TERM_A, slot: 1 },
            ],
            [{ id: TERM_A, slot: 1, sessionId: S3 }],
          ],
          {
            rows: {
              [S1]: {
                title: `t \u0007 ${img}`,
                shortId: '<b>s</b>',
                group: `<b>g</b>`,
                stateDetail: `<b>d</b>`,
                dir: `/d/${img}`,
                chip: { level: `<b>x</b>`, count: 2 },
              },
              [S2]: {
                state: 'running',
                elsewhere: { pid: 9, tty: `/dev/${img}`, dir: `/e/${img}` },
              },
              [S3]: { title: `t3 ${img}` },
            },
            terminals: { [TERM_A]: { state: 'not-started' } },
            list: {
              selected: selectedOf(S1, { command: `claude ${img}`, unknownFlags: [`--${img}`] }),
              dirs: [`/dirs/${img}`],
            },
          },
        ),
      );
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card-command', /img/);
      await noMarkup('the header and the resume card');
      // A control character reaches the page as the text it is (the server sanitises; the page
      // never interprets).
      assert.deepEqual(await texts(s.page, '.header-title'), [`t \u0007 ${img}`]);
      assert.deepEqual(await texts(s.page, '.header-id'), ['<b>s</b>']);
      await s.page.locator('#cards button', { hasText: 'Resume here' }).click();
      await showsText(s.page, '#cards .card-lines', /no <img src=x>/);
      await noMarkup('a refusal on the card');
      await clickRow(s.page, S2);
      await showsText(s.page, '#cards .card-where', /img/);
      await noMarkup('the elsewhere card');
      // The refusal app.js keeps for S1's card, shown again when S1 is selected again.
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .card-lines', /no <img src=x>/);
      await noMarkup('the refusal kept for the card');
      await clickRow(s.page, S3);
      await s.page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      s.conn().send({
        t: 'exit',
        term: TERM_A,
        code: null,
        signal: null,
        atNs: String(NOW_NS),
        lost: false,
        notStarted: `no ${img}`,
      });
      await showsText(s.page, '#cards .card-ended', /^not started: no <img src=x>$/);
      await noMarkup('the ended bar');
      await s.page.locator('#cards .card-bar button', { hasText: 'Resume' }).click();
      await showsText(s.page, '#cards .card-lines', /no <img src=x>/);
      await noMarkup("the ended bar's refusal");
      await s.page.keyboard.press('Control+Shift+N');
      await s.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await s.page.locator('#cards button', { hasText: 'Start' }).click();
      await showsText(s.page, '#cards .card-new', /no <img src=x>/);
      await noMarkup('the new form');
      assert.deepEqual(
        await s.page.evaluate(() =>
          [...document.querySelectorAll('#cards datalist option')].map(
            (o) => (o as HTMLOptionElement).value,
          ),
        ),
        ['/dirs/<img src=x>'],
      );
    },
  );

  await t.test(
    'Ctrl+Shift+H shows and hides the help; every key in it is one keys.js handles, every key keys.js handles is in it, and the keys of later stages are marked so',
    async (t) => {
      const s = await scripted(t, chromium);
      await s.page.keyboard.press('Control+Shift+H');
      await s.page.waitForSelector('#help:not([hidden])');
      const help = await s.page.evaluate(() =>
        [...document.querySelectorAll('#help [data-zone] .help-line')].map((line) => ({
          zone: line.closest('[data-zone]')?.getAttribute('data-zone') ?? '',
          keys: [...line.querySelectorAll('kbd')].map((kbd) => kbd.textContent ?? ''),
          text: line.textContent ?? '',
        })),
      );
      const notes = await shownText(s.page, '#help .help-notes');
      await s.page.keyboard.press('Control+Shift+H');
      await s.page.waitForSelector('#help[hidden]', { state: 'attached' });

      checkHelp(help);
      assert.match(notes, /browser tab/i, 'the browser-tab note');
      assert.match(notes, /Ctrl\+Shift\+O/);
      assert.match(notes, /\+ New/);
      assert.match(notes, /Claude Code/, 'the note on the Claude Code bindings the window shadows');
      assert.match(notes, /ctrl\+shift/i);
    },
  );

  await realServerCases(t, chromium);
});

// ---------------------------------------------------------------------------------------------
// The key help against keys.js

/** The help's names of named keys, and the `key` of the events they stand for. */
const NAMED: Record<string, string> = {
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  PgUp: 'PageUp',
  PgDn: 'PageDown',
  Esc: 'Escape',
  Refresh: 'BrowserRefresh',
};
const NAME_OF = Object.fromEntries(Object.entries(NAMED).map(([name, key]) => [key, name]));

type Section = 'window' | 'terminal' | 'list';
const MODIFIERS = ['Ctrl', 'Shift', 'Alt', 'Meta'] as const;

/** Every key event the tables can be asked about: each character and named key, with each of the
 *  16 sets of modifiers (US and Czech characters; a letter's and a digit's physical key). */
function everyEvent(): KeyLike[] {
  const chars = [
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ...'`-=[]\;\',./~!@#$%^&*()_+{}|:"<>? ',
    ...'+ěščřžýáíéúů§¨',
  ];
  const named = [
    'Enter',
    'Escape',
    'Tab',
    'Backspace',
    'Delete',
    'Insert',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ContextMenu',
    'BrowserRefresh',
    ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ];
  const codeOf = (key: string): string => {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    const shifted = '!@#$%^&*()'.indexOf(key); // US: Shift+1 … Shift+0
    if (shifted !== -1) return `Digit${(shifted + 1) % 10}`;
    const czech = '+ěščřžýáíé'.indexOf(key); // Czech: the number row without Shift
    if (czech !== -1) return `Digit${(czech + 1) % 10}`;
    return named.includes(key) ? key : '';
  };
  const events: KeyLike[] = [];
  for (const key of [...chars, ...named]) {
    for (let bits = 0; bits < 16; bits++) {
      events.push({
        key,
        code: codeOf(key),
        ctrlKey: (bits & 1) !== 0,
        shiftKey: (bits & 2) !== 0,
        altKey: (bits & 4) !== 0,
        metaKey: (bits & 8) !== 0,
      });
    }
  }
  return events;
}

/** The help's name of a key event in a section (`null`: keys.js does not classify it there). */
function helpNameOf(e: KeyLike, section: Section): string | null {
  const held = (e: KeyLike): string =>
    MODIFIERS.filter((m) => e[`${m.toLowerCase()}Key` as 'ctrlKey'])
      .map((m) => `${m}+`)
      .join('');
  if (section === 'window') {
    const chord = windowChord(e, 'terminal');
    assert.deepEqual(windowChord(e, 'list'), chord, `${held(e)}${e.key}: the same in both zones`);
    if (chord === null) return null;
    if (chord.kind === 'slot') return 'Ctrl+Shift+1…9';
    if (e.key === 'Tab' || e.key === 'BrowserRefresh')
      return `${held(e)}${NAME_OF[e.key] ?? e.key}`;
    return `Ctrl+Shift+${e.key.toUpperCase()}`;
  }
  if (windowChord(e, 'terminal') !== null) return null; // the window's own, in its section
  if (section === 'terminal') {
    const mapped = terminalKey(e);
    if (mapped === null) return null;
    if (e.key === 'F4') return 'Alt+F4'; // with or without Shift (keys.js)
    return `${held(e)}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
  }
  if (listKey(e) === null) return null;
  if (e.key.length === 1 && !e.ctrlKey) return e.key; // the character chose the key, Shift too
  return `${held(e)}${NAME_OF[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)}`;
}

/** The key events (US layout) a key name of the help stands for. */
function eventsOf(name: string): KeyLike[] {
  if (name === 'Ctrl+Shift+1…9') {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => ({
      key: '!@#$%^&*('[digit - 1] as string,
      code: `Digit${digit}`,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    }));
  }
  const parts = name.split('+');
  const last = name.endsWith('++') ? '+' : (parts.at(-1) as string);
  const has = (m: string): boolean => parts.slice(0, -1).includes(m);
  const key =
    NAMED[last] ??
    (last.length === 1 ? (has('Shift') ? last.toUpperCase() : last.toLowerCase()) : last);
  return [
    {
      key,
      code: '',
      ctrlKey: has('Ctrl'),
      shiftKey: has('Shift'),
      altKey: has('Alt'),
      metaKey: has('Meta'),
    },
  ];
}

/** The kind keys.js gives `e` in a section, or null. */
function kindOf(e: KeyLike, section: Section): string | null {
  if (section === 'window') return windowChord(e, 'terminal')?.kind ?? null;
  if (windowChord(e, 'terminal') !== null) return null;
  if (section === 'terminal') return terminalKey(e) === null ? null : 'terminal';
  return listKey(e)?.kind ?? null;
}

/**
 * Both directions, exhaustively: every key the help shows is one keys.js classifies in that
 * section, marked `comes in a later stage` exactly when keys.js gives `later`; and every event
 * keys.js classifies (window chords, the terminal's mapping, list keys) has its name in the help.
 */
function checkHelp(help: { zone: string; keys: string[]; text: string }[]): void {
  const later = /comes in a later stage/;
  const shown = { window: new Set<string>(), terminal: new Set<string>(), list: new Set<string>() };
  for (const line of help) {
    assert.ok(['window', 'terminal', 'list'].includes(line.zone), line.text);
    const section = line.zone as Section;
    assert.ok(line.keys.length > 0, `a line with keys: ${line.text}`);
    for (const name of line.keys) {
      if (name === 'Ctrl+click') {
        assert.equal(section, 'terminal', 'a link is opened in the terminal');
        continue;
      }
      for (const e of eventsOf(name)) {
        const kind = kindOf(e, section);
        assert.ok(kind !== null, `${name} (${section}) is a key keys.js handles there`);
        assert.equal(helpNameOf(e, section), name, `${name} is named as the test names it`);
        assert.equal(kind === 'later', later.test(line.text), `${name}: marked later exactly when`);
      }
      shown[section].add(name);
    }
  }
  const missing: string[] = [];
  for (const e of everyEvent()) {
    for (const section of ['window', 'terminal', 'list'] as const) {
      const name = helpNameOf(e, section);
      if (name !== null && !shown[section].has(name)) missing.push(`${section}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'every key keys.js classifies is in the help');
}

// ---------------------------------------------------------------------------------------------
// Against a real test server (the plan's list)

/** Whether the shown terminal (inside `#terminal`) has the keyboard (S2 11.3). */
async function terminalHasKeyboard(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('terminal')?.contains(document.activeElement) === true,
    null,
    { timeout: PAGE_WAIT_MS },
  );
}

/** Waits until the right side shows the terminal `term`. */
async function showsTerminal(page: Page, term: string): Promise<void> {
  await page.waitForSelector(`#right-zone[data-pane="terminal"][data-pane-term="${term}"]`, {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** The terminal of `sessionId` in the hub once there is one whose state is `state`. */
async function terminalIn(
  l: Launched,
  sessionId: string,
  state: string,
  not?: string,
): Promise<string> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const term = l.server.hub
      .list()
      .find(
        (info) => info.expectedSessionId === sessionId && info.state === state && info.id !== not,
      );
    if (term !== undefined) return term.id;
    assert.ok(performance.now() < deadline, `a ${state} terminal of ${sessionId}`);
    await sleep(50);
  }
}

/**
 * The stand-in resuming `sessionId` outside the window, as in another terminal (S2 7.9): a child
 * of the test with the sandbox's environment. `ended` is registered by the caller BEFORE the
 * sandbox (t.after runs first in, first out): it ends the program with `/exit` while its sandbox
 * is still there, and only the test's own child handle is ever signalled.
 */
function outsideProgram(
  l: Launched,
  sessionId: string,
  dir: string,
  ends: (() => Promise<void>)[],
): ChildProcess {
  const child = spawn(l.d.standin, ['--resume', sessionId], {
    cwd: dir,
    env: l.d.platform.env,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.stdin?.on('error', () => {});
  ends.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.write('/exit\r');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
  });
  return child;
}

/**
 * The page of a real server with the real web/ reported no problem: no console error, nothing
 * uncaught, no failed load (ruled for tasks 27-29, 14:19Z).
 */
function noProblems(l: Launched): void {
  assert.deepEqual(l.problems, [], 'the page reports no problem');
}

async function realServerCases(
  t: TestContext,
  chromium: Parameters<typeof newPage>[1],
): Promise<void> {
  await t.test(
    'the page of a real server with the real web/ reports no problem with a card shown, the form open and the help open; a resume card shown for a selected row leaves the keyboard on the list',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .card-command', /--resume/);
      assert.equal(await active(l.page), '#list', 'the card took no keyboard');
      noProblems(l);
      await l.page.keyboard.press('Control+Shift+N');
      await l.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      noProblems(l);
      await l.page.keyboard.press('Escape');
      await l.page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      await l.page.keyboard.press('Control+Shift+H');
      await l.page.waitForSelector('#help:not([hidden])');
      noProblems(l);
      await l.page.keyboard.press('Control+Shift+H');
      await l.page.waitForSelector('#help[hidden]', { state: 'attached' });
      await sleep(300);
      noProblems(l);
    },
  );

  await t.test(
    "the resume card of a not-running session shows the command the server sent; Resume here starts it, with the keyboard in its terminal; a refusal shows the guard's message on the card",
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      l.d.resumable(S2, join(l.d.s.home, 'other'));
      const p = await connectTestPage(t, l.d, l.server, { focused: false, view: { selected: S1 } });
      const list = await p.list((list) => list.selected?.sessionId === S1, 'the card of S1');
      const command = list.selected?.command;
      assert.ok(typeof command === 'string' && command.length > 0);

      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .card-command', new RegExp(`^${escape(command)}$`));
      noProblems(l); // once the card has rendered
      await l.page.locator('#cards button', { hasText: 'Resume here' }).click();
      const term = await terminalIn(l, S1, 'running');
      await showsTerminal(l.page, term);
      await terminalHasKeyboard(l.page);
      assert.equal(await zone(l.page), 'Focus: terminal');

      // Another skydeck is resuming S2 (the test takes its lock as `skydeck resume` does).
      prepareResumeById(l.d.deck, S2);
      await clickRow(l.page, S2);
      await l.page.locator('#cards button', { hasText: 'Resume here' }).click();
      await showsText(
        l.page,
        '#cards .card-lines',
        new RegExp(`^${S2.slice(0, 8)} is being resumed \\(\\d+ s ago\\); try again in \\d+ s$`),
      );
      assert.equal(
        l.server.hub.list().filter((info) => info.expectedSessionId === S2).length,
        0,
        'nothing started',
      );
      noProblems(l);
    },
  );

  await t.test(
    'a session running in another terminal shows the card with its pid; /exit in a terminal → the bar with status 0; Resume on the bar starts it again; Close forgets the terminal',
    async (t) => {
      const ends: (() => Promise<void>)[] = [];
      t.after(async () => {
        for (const end of ends) await end();
      });
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      const far = l.d.resumable(S2, join(l.d.s.home, 'far'));
      // S2's resume card is shown; then S2 starts in another terminal: within a tick the card
      // turns into the elsewhere card, with no button left to press.
      await clickRow(l.page, S2);
      await showsText(l.page, '#cards .card-command', /--resume/);
      const outside = outsideProgram(l, S2, far, ends);
      await showsText(l.page, '#cards .card', new RegExp(`pid ${outside.pid}\\b`));
      assert.equal(await l.page.locator('#cards button:visible').count(), 0, 'no stale button');
      assert.match(await shownText(l.page, '#cards .card'), /cannot be shown here/);

      await clickRow(l.page, S1);
      await l.page.locator('#cards button', { hasText: 'Resume here' }).click();
      const first = await terminalIn(l, S1, 'running');
      await showsTerminal(l.page, first);
      const p = await connectTestPage(t, l.d, l.server, { focused: false, view: null });
      p.send({ t: 'input', term: first, data: '/exit\r' });
      await showsText(
        l.page,
        '#cards .card-ended',
        /^claude exited \(status 0\) at \d\d:\d\d:\d\d/,
      );
      assert.equal(await l.page.locator('#cards button', { hasText: 'Close' }).count(), 1);

      await l.page.locator('#cards button', { hasText: 'Resume' }).first().click();
      const second = await terminalIn(l, S1, 'running', first);
      await showsTerminal(l.page, second);
      await terminalHasKeyboard(l.page);

      p.send({ t: 'input', term: second, data: '/exit\r' });
      await showsText(l.page, '#cards .card-ended', /^claude exited \(status 0\)/);
      await l.page.locator('#cards button', { hasText: 'Close' }).click();
      await l.page.waitForSelector('#right-zone[data-pane="resume"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      assert.deepEqual(
        l.server.hub.list().filter((info) => info.expectedSessionId === S1),
        [],
        'the terminal is forgotten',
      );
      noProblems(l);
    },
  );

  await t.test(
    "Ctrl+Shift+N opens the form; a label fix and flags --model opus → a row fix starts; flags -r x → the server's message in the form, nothing started",
    async (t) => {
      const l = await launched(t, chromium);
      const dir = join(l.d.s.home, 'fresh');
      mkdirSync(dir);
      await l.page.keyboard.press('Control+Shift+N');
      await l.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await l.page.fill('#cards input[name="directory"]', dir);
      await l.page.fill('#cards input[name="label"]', 'fix');
      await l.page.fill('#cards input[name="flags"]', '--model opus');
      await l.page.keyboard.press('Enter');

      await showsText(l.page, '#cards .header-title', /^fix$/);
      const started = l.server.hub.list();
      assert.equal(started.length, 1);
      const deadline = performance.now() + PAGE_WAIT_MS;
      let argv: string[] = [];
      while (performance.now() < deadline) {
        const start = readRecords(l.d.record).find((record) => record.ev === 'start');
        if (start !== undefined && start.ev === 'start') {
          argv = start.argv;
          break;
        }
        await sleep(50);
      }
      assert.ok(argv.includes('--model') && argv.includes('opus'), JSON.stringify(argv));
      assert.ok(argv.includes('fix'), JSON.stringify(argv));

      await l.page.keyboard.press('Control+Shift+N');
      await l.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await l.page.fill('#cards input[name="directory"]', dir);
      await l.page.fill('#cards input[name="flags"]', '-r x');
      await l.page.locator('#cards button', { hasText: 'Start' }).click();
      await showsText(
        l.page,
        '#cards .card-new',
        /cannot pass -r to claude: it picks an existing session/,
      );
      await sleep(500);
      assert.equal(l.server.hub.list().length, 1, 'nothing more started');
      assert.equal(readRecords(l.d.record).filter((record) => record.ev === 'start').length, 1);
      noProblems(l);
    },
  );
}
