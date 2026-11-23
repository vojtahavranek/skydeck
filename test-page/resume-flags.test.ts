// Issue #188, part 1 (design 7.6 "Other flags", S2 12.6, 12.9): the resume card's `Other flags…` —
// the New form's flags field (the field, the ★, the favourite chips) filled with the flags a plain
// resume passes on, Start that resumes with exactly the field's flags, a refusal shown in the form
// with the card kept, Esc back to the card, the list key `f` and the keyboard alone. Scripted cases
// run against a stand-in server; the last ones against a real test server whose terminals run the
// stand-in program: the flags it is started with, the header once it has started, a later plain
// resume, a second window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { lockKey } from '../src/sessions/resume.ts';
import { controlClient } from '../src/window/client.ts';
import { splitFlags } from '../src/window/flags.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { connectTestPage } from '../test/helpers/window.ts';
import { flagsText } from '../web/favourite-text.js';
import { browser, newPage } from './helpers/browser.ts';
import {
  PAGE_WAIT_MS,
  RECORDER,
  TERM_A,
  active,
  clickRow,
  connection,
  honest,
  keyMessage,
  launched,
  pageUrl,
  scriptedList,
  selectedRow,
  showsText,
  standinServer,
  storeKey,
  toZone,
} from './helpers/shell.ts';
import type { Launched, StandinConnection } from './helpers/shell.ts';
import { promptOf, recordsOf, until, untilScreen, untilTerminalOf } from './helpers/terminal.ts';

type Row = Record<string, unknown>;

const EDITOR = '#cards .card-flags-form';
const FIELD = `${EDITOR} input[name="flags"]`;
const HINT = 'resumes in this window with these flags · Esc goes back';
const CANNOT_SHOW =
  'the flags it was started with hold a character this field cannot show; Resume here passes them on as they are';

/** What a plain resume of S1 passes on, with a value that holds spaces and both quotes. */
const RECORDED = [
  '--model',
  'opus',
  '--append-system-prompt',
  `it's "brief"`,
  '--add-dir',
  '/tmp/a b',
];

/** The resume card's payload (S2 8.2.3 `list.selected`) for S1, with `more` over it. */
function selectedOf(more: Row = {}): Row {
  return {
    sessionId: S1,
    command: `cd -- /home/u/project && claude --resume ${S1} --model opus`,
    flagsKnown: true,
    unknownFlags: [],
    launchFlags: RECORDED,
    resumeFlags: RECORDED,
    ended: 'exited',
    expiring: false,
    expired: false,
    note: null,
    noteTooLong: false,
    ticketUrl: null,
    ticket: null,
    ticketKeys: false,
    ...more,
  };
}

interface World {
  page: Page;
  /** Every `act` the page sent, in order. */
  acts(): Row[];
  /** The selected payload of S1 the lists carry from now on (a list follows at once). */
  setSelected(more: Row): void;
  /** How `act resume` is answered: refused with these words, else ok (S1 starts in TERM_A). */
  answer: { refuse: string | null };
  conn(): StandinConnection;
}

let seed = 120;

/**
 * A page on a stand-in that lists S1 (not running) and S2 (running in TERM_A), with S1's resume
 * card payload while the page's view selects S1, and `favourites`; it keeps the favourites as the
 * server does (added last, removed by text), and answers `act resume` as `answer` says — ok: S1
 * then runs in TERM_A's place (TERM_A's snap answers the attach).
 */
async function world(t: TestContext, chromium: Browser, favourites: string[] = []): Promise<World> {
  const secret = new Uint8Array(32).fill(seed++);
  const page = await newPage(t, chromium);
  const acts: Row[] = [];
  const kept = [...favourites];
  let selected: string | null = null;
  let started = false;
  let more: Row = {};
  const answer: World['answer'] = { refuse: null };
  const listNow = (): Row => {
    const rows = started
      ? [{ id: S1, terminal: TERM_A, slot: 1 }]
      : [
          { id: S2, terminal: TERM_A, slot: 1 },
          { id: S1, terminal: null, slot: null },
        ];
    const terminals = [{ id: TERM_A, slot: 1, sessionId: started ? S1 : S2 }];
    return {
      ...scriptedList(rows, terminals, selected === S1 && !started ? selectedOf(more) : null),
      dirs: ['/home/u/project'],
      favourites: [...kept],
    };
  };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        if (message['t'] === 'view') {
          selected = (message['selected'] as string | null) ?? null;
          conn.send(listNow());
        } else if (message['t'] === 'attach') {
          conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
        } else if (message['t'] === 'act') {
          acts.push(message);
          const kind = message['kind'];
          const reply = (refusal: string | null, sessionId: string | null = null): void =>
            conn.send({
              t: 'result',
              id: message['id'],
              ok: refusal === null,
              lines: refusal === null ? [] : [refusal],
              error: refusal,
              sessionId,
            });
          if (kind === 'favourite-add') {
            kept.push((message['text'] as string).trim());
            conn.send(listNow());
            reply(null);
          } else if (kind === 'favourite-remove') {
            kept.splice(kept.indexOf(message['text'] as string), 1);
            conn.send(listNow());
            reply(null);
          } else if (kind === 'resume') {
            if (answer.refuse !== null) {
              reply(answer.refuse);
            } else {
              started = true;
              conn.send(listNow());
              reply(null, S1);
            }
          }
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
    acts: () => acts,
    setSelected(next) {
      more = next;
      conn().send(listNow());
    },
    answer,
    conn,
  };
}

/** Selects S1 with a click and waits for its resume card with both buttons. */
async function cardOfS1(page: Page): Promise<void> {
  await clickRow(page, S1);
  await page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
  await page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).waitFor();
}

/** The texts of the resume card's buttons on its action line, '' for a hidden one. */
async function cardButtons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#cards .card-actions button')]
      .filter((button) => button.closest('.card-flags-form') === null)
      .map((button) =>
        button instanceof HTMLButtonElement && button.closest('[hidden]') === null
          ? `${button.textContent}${button.disabled ? ':disabled' : ''}`
          : '',
      ),
  );
}

/** The field's value, its caret (start and end), and whether it has the keyboard. */
async function fieldNow(
  page: Page,
): Promise<{ value: string; start: number | null; end: number | null; focused: boolean }> {
  return page.evaluate((selector) => {
    const field = document.querySelector(selector) as HTMLInputElement;
    return {
      value: field.value,
      start: field.selectionStart,
      end: field.selectionEnd,
      focused: document.activeElement === field,
    };
  }, FIELD);
}

/** The acts of kind resume the page sent, without `t` and `id`. */
function resumes(w: World): Row[] {
  return w
    .acts()
    .filter((act) => act['kind'] === 'resume')
    .map(({ t: _t, id: _id, ...rest }) => rest);
}

/** The chips' texts and whether each is on. */
async function chips(page: Page): Promise<{ text: string; on: boolean }[]> {
  return page.evaluate(
    (editor) =>
      [...document.querySelectorAll(`${editor} .card-favourite`)].map((chip) => ({
        text: chip.querySelector('.card-favourite-text')?.textContent ?? '',
        on: (chip as HTMLElement).dataset['on'] === 'true',
      })),
    EDITOR,
  );
}

test("the resume card's Other flags… (#188)", async (t) => {
  const chromium = await browser(t);

  await t.test(
    "Other flags… beside Resume here; it opens the New form's flags field in place of the action line, filled with the plain resume's flags written so that they parse back word for word (spaces, both quotes), the keyboard at its end; Will run stays",
    async (t) => {
      const w = await world(t, chromium, ['--verbose', '--model opus']);
      await cardOfS1(w.page);
      assert.deepEqual(await cardButtons(w.page), ['Resume here', 'Other flags…']);
      assert.equal(
        await w.page
          .locator('#cards .card-actions button', { hasText: 'Other flags…' })
          .getAttribute('title'),
        'Resume it with other flags for claude (f)',
      );

      await w.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await w.page.waitForSelector(FIELD);
      const now = await fieldNow(w.page);
      assert.equal(now.value, flagsText(RECORDED));
      assert.equal(
        now.value,
        `--model opus --append-system-prompt 'it'"'"'s "brief"' --add-dir '/tmp/a b'`,
      );
      assert.deepEqual(splitFlags(now.value), { ok: true, flags: RECORDED }, 'parses back');
      assert.equal(now.focused, true, 'the keyboard in the field');
      assert.deepEqual([now.start, now.end], [now.value.length, now.value.length], 'at its end');
      assert.equal(await active(w.page), 'INPUT');
      await showsText(w.page, '#focus-zone', /^Focus: terminal$/);
      // The New form's component: its label, the ★, the chip row; the form's own Start and hint.
      await showsText(w.page, `${EDITOR} .card-label`, /^Flags for claude$/);
      assert.equal(await w.page.locator(`${EDITOR} .card-star`).count(), 1);
      // A chip is on at once when the recorded flags hold its words.
      assert.deepEqual(await chips(w.page), [
        { text: '--verbose', on: false },
        { text: '--model opus', on: true },
      ]);
      await showsText(w.page, `${EDITOR} .card-hint`, new RegExp(`^${HINT}$`));
      assert.equal(await w.page.locator(`${EDITOR} button[type="submit"]`).textContent(), 'Start');
      // The action line is gone while the form is open; Will run still says the plain resume.
      assert.deepEqual(await cardButtons(w.page), ['', '']);
      await showsText(w.page, '#cards .card-command', /--model opus$/);
      assert.deepEqual(resumes(w), [], 'opening sends nothing');
    },
  );

  await t.test(
    'a favourite chip adds its flags at the end of the field and a second click takes them out; the field’s text is what Start sends',
    async (t) => {
      const w = await world(t, chromium, ['--mcp-config /tmp/a.json']);
      w.answer.refuse = 'refused to look';
      await cardOfS1(w.page);
      await w.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await w.page.waitForSelector(FIELD);
      const chip = w.page.locator(`${EDITOR} .card-favourite-text`, { hasText: '--mcp-config' });
      await chip.click();
      assert.equal(
        (await fieldNow(w.page)).value,
        `${flagsText(RECORDED)} --mcp-config /tmp/a.json`,
      );
      assert.deepEqual(await chips(w.page), [{ text: '--mcp-config /tmp/a.json', on: true }]);
      assert.equal((await fieldNow(w.page)).focused, true, 'a click on a chip takes no keyboard');
      await chip.click();
      assert.equal((await fieldNow(w.page)).value, flagsText(RECORDED));
      assert.deepEqual(await chips(w.page), [{ text: '--mcp-config /tmp/a.json', on: false }]);
      await chip.click();
      await w.page.keyboard.press('Enter');
      await until(() => resumes(w).length === 1, 'act resume sent');
      assert.deepEqual(resumes(w)[0]?.['flags'], `${flagsText(RECORDED)} --mcp-config /tmp/a.json`);
    },
  );

  await t.test(
    "Start sends act resume with exactly the field's text as flags, the size of the terminal area as for Resume; an empty field sends an empty text (no flags at all); once started the terminal has the keyboard",
    async (t) => {
      const w = await world(t, chromium);
      w.answer.refuse = 'not now';
      await cardOfS1(w.page);
      await w.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await w.page.waitForSelector(FIELD);
      await w.page.fill(FIELD, '');
      await w.page.locator(`${EDITOR} button[type="submit"]`).click();
      await until(() => resumes(w).length === 1, 'act resume sent');
      const first = resumes(w)[0] ?? {};
      assert.equal(first['flags'], '');
      assert.equal(first['sessionId'], S1);
      assert.equal(typeof first['cols'], 'number');
      assert.equal(typeof first['rows'], 'number');

      w.answer.refuse = null;
      await w.page.fill(FIELD, `--model example  'go on'`);
      await w.page.keyboard.press('Enter');
      await until(() => resumes(w).length === 2, 'the second act resume sent');
      assert.equal(
        resumes(w)[1]?.['flags'],
        `--model example  'go on'`,
        'as typed: the server splits',
      );
      await untilTerminalOf(w.page, S1);
      assert.equal(await w.page.locator(EDITOR).count(), 0, 'the form is gone with the card');
    },
  );

  await t.test(
    "a refusal shows on the form's line, where the New form shows its own; the form keeps its text and the keyboard, the card stays, its own line says nothing",
    async (t) => {
      const w = await world(t, chromium);
      const refusal =
        'cannot pass --worktree to claude on a resume: it says where or how a new session starts';
      w.answer.refuse = refusal;
      await cardOfS1(w.page);
      await w.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await w.page.waitForSelector(FIELD);
      await w.page.keyboard.type(' --worktree');
      await w.page.keyboard.press('Enter');
      await showsText(w.page, `${EDITOR} .card-lines`, new RegExp(`^${refusal}$`));
      const now = await fieldNow(w.page);
      assert.equal(now.value, `${flagsText(RECORDED)} --worktree`);
      assert.equal(now.focused, true);
      assert.equal(await w.page.locator('#right-zone[data-pane="resume"]').count(), 1);
      // The card's own result line (a plain resume's) is hidden and holds nothing.
      assert.equal(
        await w.page.evaluate(() =>
          [...document.querySelectorAll('#cards .card-lines')]
            .filter((lines) => lines.closest('.card-flags-form') === null)
            .map((lines) => lines.textContent)
            .join(''),
        ),
        '',
      );
      // Another list (S1's facts unchanged) keeps all of it.
      w.setSelected({});
      await w.page.waitForTimeout(300);
      assert.equal((await fieldNow(w.page)).value, `${flagsText(RECORDED)} --worktree`);
      await showsText(w.page, `${EDITOR} .card-lines`, new RegExp(`^${refusal}$`));
    },
  );

  await t.test(
    'Esc goes back to the card: nothing sent, the action line again, the keyboard on Other flags…; opened again, the field holds the plain resume’s flags, not what was typed; another session shown and S1 again, the card is the plain one',
    async (t) => {
      const w = await world(t, chromium);
      await cardOfS1(w.page);
      await w.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await w.page.waitForSelector(FIELD);
      await w.page.keyboard.type(' --verbose');
      await w.page.keyboard.press('Escape');
      await w.page.waitForSelector(EDITOR, { state: 'detached' });
      assert.deepEqual(await cardButtons(w.page), ['Resume here', 'Other flags…']);
      assert.equal(
        await w.page.evaluate(() => document.activeElement?.textContent ?? ''),
        'Other flags…',
      );
      await showsText(w.page, '#focus-zone', /^Focus: terminal$/);
      assert.deepEqual(resumes(w), []);
      await w.page.keyboard.press('Enter'); // on Other flags…: opens it again
      await w.page.waitForSelector(FIELD);
      assert.equal((await fieldNow(w.page)).value, flagsText(RECORDED));
      // Another session shown, then S1 again: its card is the plain one.
      await w.page.keyboard.type(' --verbose');
      await clickRow(w.page, S2);
      await w.page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      await clickRow(w.page, S1);
      await w.page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      assert.deepEqual(await cardButtons(w.page), ['Resume here', 'Other flags…']);
      assert.equal(await w.page.locator(EDITOR).count(), 0);
      assert.deepEqual(resumes(w), []);
    },
  );

  await t.test(
    'keyboard only: f in the list opens it with the keyboard in the field (a held f types nothing); Tab walks the ★, the chip row and Start; Space on a chip, Enter starts; f on a session with no resume card says why',
    async (t) => {
      const w = await world(t, chromium, ['--verbose']);
      w.answer.refuse = 'refused';
      // The page opens on S2, which runs in the window (its terminal shown): no resume card.
      await until(async () => (await selectedRow(w.page)) === S2, 'S2 selected');
      await toZone(w.page, 'list');
      await w.page.keyboard.press('f');
      await until(
        async () => (await keyMessage(w.page)).startsWith('this session is not on a resume card'),
        'the key bar says why',
      );
      assert.equal(
        await keyMessage(w.page),
        'this session is not on a resume card: f resumes one with other flags',
      );
      await toZone(w.page, 'list');
      await w.page.keyboard.press('ArrowDown');
      await until(async () => (await selectedRow(w.page)) === S1, 'S1 selected');
      await w.page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      await w.page.keyboard.down('f');
      await w.page.waitForSelector(FIELD);
      for (let i = 0; i < 3; i++) await w.page.keyboard.down('f'); // held
      await w.page.keyboard.up('f');
      const opened = await fieldNow(w.page);
      assert.equal(opened.value, flagsText(RECORDED), 'nothing typed by the held f');
      assert.equal(opened.focused, true);

      await w.page.keyboard.press('Tab');
      assert.equal(
        await w.page.evaluate(() => document.activeElement?.classList.contains('card-star')),
        true,
        'the ★',
      );
      await w.page.keyboard.press('Tab');
      assert.equal(
        await w.page.evaluate(() => document.activeElement?.classList.contains('card-favourites')),
        true,
        'the chip row',
      );
      await w.page.keyboard.press(' ');
      assert.deepEqual(await chips(w.page), [{ text: '--verbose', on: true }]);
      await w.page.keyboard.press('Tab');
      assert.equal(await w.page.evaluate(() => document.activeElement?.textContent), 'Start');
      await w.page.keyboard.press('Enter');
      await until(() => resumes(w).length === 1, 'act resume sent');
      assert.equal(resumes(w)[0]?.['flags'], `${flagsText(RECORDED)} --verbose`);
      await showsText(w.page, `${EDITOR} .card-lines`, /^refused$/);
      // Esc from the keyboard as well (Start has it); then Shift+Tab reaches Resume here.
      await w.page.keyboard.press('Escape');
      await w.page.waitForSelector(EDITOR, { state: 'detached' });
      await w.page.keyboard.press('Shift+Tab');
      assert.equal(await w.page.evaluate(() => document.activeElement?.textContent), 'Resume here');
    },
  );

  await t.test(
    'an expired session: Other flags… disabled and f says why; flags the field cannot show: the field opens empty, a line says so',
    async (t) => {
      const w = await world(t, chromium);
      await cardOfS1(w.page);
      w.setSelected({ expired: true });
      await until(
        async () =>
          (await cardButtons(w.page)).join(',') === 'Resume here:disabled,Other flags…:disabled',
        'both disabled',
      );
      await toZone(w.page, 'list');
      await w.page.keyboard.press('f');
      await until(async () => (await keyMessage(w.page)) !== '', 'the key bar answers');
      assert.equal(await keyMessage(w.page), 'its transcript is gone: it cannot be resumed');
      assert.equal(await w.page.locator(EDITOR).count(), 0);

      w.setSelected({ resumeFlags: null });
      await until(
        async () => (await cardButtons(w.page)).join(',') === 'Resume here,Other flags…',
        'enabled again',
      );
      await w.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await w.page.waitForSelector(FIELD);
      assert.equal((await fieldNow(w.page)).value, '');
      await showsText(w.page, `${EDITOR} .card-warning`, new RegExp(`^${CANNOT_SHOW}$`));
      // Expired while open: the form goes, nothing resumes it.
      w.setSelected({ expired: true });
      await w.page.waitForSelector(EDITOR, { state: 'detached' });
      assert.deepEqual(resumes(w), []);
    },
  );

  await realServerCases(t, chromium);
});

// ---------------------------------------------------------------------------------------------
// A real test server whose terminals run the stand-in program.

/** Another page of the launched server, opened with a launch token of its own; connected. */
async function anotherPage(t: TestContext, chromium: Browser, l: Launched): Promise<Page> {
  const page = await newPage(t, chromium);
  await page.addInitScript(RECORDER);
  const { token } = await controlClient(l.d.platform.net, l.d.files.serverSock).token(30);
  await page.goto(pageUrl(l.server.port, token));
  await connection(page, 'open');
  return page;
}

/** Waits until the header's item of the flags the session was started with (F16) says `flags`. */
async function untilStartedWith(page: Page, flags: string): Promise<void> {
  await page.waitForFunction(
    (whole) => {
      const item = document.querySelector('#cards .header-flags');
      return item instanceof HTMLElement && !item.hidden && item.title === `Started with: ${whole}`;
    },
    flags,
    { timeout: PAGE_WAIT_MS },
  );
}

/** The argument lists S1's stand-ins were started with, in order (the program's name left out). */
function startsOf(l: Launched): string[][] {
  return recordsOf(l.d.record, S1).flatMap((entry) => (entry.ev === 'start' ? [entry.argv] : []));
}

/** Ends S1's program in the shown terminal of the window (the stand-in's /exit), then Close. */
async function endAndClose(t: TestContext, l: Launched, term: string): Promise<void> {
  const p = await connectTestPage(t, l.d, l.server, { focused: false, view: null });
  p.send({ t: 'input', term, data: '/exit\r' });
  await showsText(l.page, '#cards .card-ended', /^claude exited \(status 0\)/);
  await l.page.locator('#cards .card-bar button', { hasText: 'Close' }).click();
  await l.page.waitForSelector('#right-zone[data-pane="resume"]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

async function realServerCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    'a real server: resumed with other flags, the stand-in runs with them in place of the recorded ones; the header shows them once it has started, in a second window too; after /exit and Close, Will run and the field hold them, and a plain Resume here passes them on',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await cardOfS1(l.page);
      // No recorded launch yet: the field opens empty.
      await l.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await l.page.waitForSelector(FIELD);
      assert.equal((await fieldNow(l.page)).value, '');
      await l.page.keyboard.type(`--model example --append-system-prompt 'be brief'`);
      await l.page.keyboard.press('Enter');
      const first = await untilTerminalOf(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      assert.deepEqual(startsOf(l), [
        ['--resume', S1, '--model', 'example', '--append-system-prompt', 'be brief'],
      ]);
      // Recorded as every start is: the header says it once the stand-in has reported its start
      // (its tooltip holds the whole, the item is cut at 40 characters).
      await untilStartedWith(l.page, '--model example --append-system-prompt be brief');
      const second = await anotherPage(t, chromium, l);
      await clickRow(second, S1);
      await untilStartedWith(second, '--model example --append-system-prompt be brief');

      await endAndClose(t, l, first);
      await showsText(
        l.page,
        '#cards .card-command',
        /--resume \S+ --model example --append-system-prompt 'be brief'$/,
      );
      await l.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await l.page.waitForSelector(FIELD);
      assert.equal(
        (await fieldNow(l.page)).value,
        `--model example --append-system-prompt 'be brief'`,
        "the plain resume's flags now",
      );
      await l.page.keyboard.press('Escape');
      await l.page.waitForSelector(EDITOR, { state: 'detached' });
      await l.page.locator('#cards .card-actions button', { hasText: 'Resume here' }).click();
      await untilTerminalOf(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      assert.deepEqual(startsOf(l).at(-1), [
        '--resume',
        S1,
        '--model',
        'example',
        '--append-system-prompt',
        'be brief',
      ]);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a real server: a flag a resume must not take is refused on the form, in the server’s words; nothing started, the card and the field kept',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await cardOfS1(l.page);
      await l.page.locator('#cards .card-actions button', { hasText: 'Other flags…' }).click();
      await l.page.waitForSelector(FIELD);
      await l.page.keyboard.type('--model example -w feat');
      await l.page.keyboard.press('Enter');
      await showsText(
        l.page,
        `${EDITOR} .card-lines`,
        /^cannot pass -w to claude on a resume: it says where or how a new session starts$/,
      );
      assert.equal((await fieldNow(l.page)).value, '--model example -w feat');
      assert.deepEqual(startsOf(l), []);
      assert.deepEqual(
        l.server.hub.list().filter((term) => term.expectedSessionId === S1),
        [],
        'no terminal opened',
      );
      assert.equal(l.d.deck.store.getKv(lockKey(S1)), null, 'no lock');
      assert.deepEqual(l.problems, []);
    },
  );
}
