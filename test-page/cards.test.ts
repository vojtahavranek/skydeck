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
import { S1, S2 } from '../test/helpers/platform.ts';
import { readRecords } from '../test/helpers/standin.ts';
import { connectTestPage } from '../test/helpers/window.ts';
import { cancels, listKey, terminalKey, windowChord } from '../web/keys.js';
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

/** 2026-11-13T09:00:00Z, the stand-in's `nowNs`. */
const NOW_NS = 1794474000000000000n;
const MINUTE_NS = 60_000_000_000n;

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
    },
  );

  await t.test(
    'a click on the short id copies the whole id and leaves the keyboard where it was; text of the header stays selected when a list changes another of its fields',
    async (t) => {
      const s = await scripted(t, chromium);
      await s.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      const list = (state: string): Row =>
        listWith([[{ id: S1, terminal: null, slot: null }], []], {
          rows: { [S1]: { state, dir: '/home/u/selectable' } },
          list: { selected: selectedOf(S1) },
        });
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
        warnings.some((line) => /transcript/.test(line) && /deleted/.test(line)),
        String(warnings),
      );

      show({ ended: 'unexpectedly' });
      await showsText(s.page, '#cards .card-ended', /^Ended unexpectedly\.$/);

      show({ ended: null, command: null, expired: true });
      await showsText(s.page, '#cards .card-ended', /transcript is gone/);
      assert.equal(await button.isDisabled(), true, 'an expired session cannot be resumed');
      assert.match((await texts(s.page, '.card-command'))[0] ?? '', /cannot/);
    },
  );

  await t.test(
    'Resume here sends act resume; while it waits a second press sends nothing; a refusal shows its lines on the card',
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
      s.serve(ended('ended'));
      await clickRow(s.page, S1);
      await s.page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
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
        lines: [
          'cannot pass -r (--resume) to claude: it picks an existing session; use skydeck resume',
        ],
        error:
          'cannot pass -r (--resume) to claude: it picks an existing session; use skydeck resume',
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
      await showsText(s.page, '#cards .card-new', /cannot pass -r \(--resume\) to claude/);

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

const NAMED: Record<string, string> = {
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  PgUp: 'PageUp',
  PgDn: 'PageDown',
  Esc: 'Escape',
};

/** The key events (US layout) a key name of the help stands for. */
function eventsOf(name: string): KeyLike[] {
  const range = /^Ctrl\+Shift\+1…9$/.exec(name);
  if (range !== null) {
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
  const last = parts.at(-1) as string;
  const ctrlKey = parts.includes('Ctrl');
  const shiftKey = parts.includes('Shift');
  const key =
    NAMED[last] ??
    (last.length === 1 ? (shiftKey ? last.toUpperCase() : last.toLowerCase()) : last);
  return [{ key, code: '', ctrlKey, shiftKey, altKey: false, metaKey: false }];
}

/** What keys.js makes of `e` in `zone`: the kind of its action, or null. */
function kindOf(e: KeyLike, zone: string): string | null {
  if (zone === 'window') {
    const inList = windowChord(e, 'list');
    const inTerminal = windowChord(e, 'terminal');
    assert.deepEqual(inList, inTerminal, `${e.key}: the same chord in both zones`);
    return inList?.kind ?? null;
  }
  if (zone === 'terminal') {
    if (windowChord(e, 'terminal') !== null) return null; // the window's, not the terminal's
    const mapped = terminalKey(e);
    if (mapped !== null) return 'terminal';
    return listKey(e)?.kind === 'reload' ? null : null;
  }
  const action = listKey(e);
  return action === null ? null : action.kind;
}

function checkHelp(help: { zone: string; keys: string[]; text: string }[]): void {
  assert.ok(help.length > 20, `${help.length} lines`);
  const later = /comes in a later stage/;
  const seen = { window: new Set<string>(), list: new Set<string>(), terminal: new Set<string>() };
  for (const line of help) {
    assert.ok(['window', 'list', 'terminal'].includes(line.zone), line.text);
    assert.ok(line.keys.length > 0, `a line with keys: ${line.text}`);
    for (const name of line.keys) {
      if (name === 'Ctrl+click') {
        assert.equal(line.zone, 'terminal', 'a link is opened in the terminal');
        continue;
      }
      for (const e of eventsOf(name)) {
        const kind = kindOf(e, line.zone);
        assert.ok(kind !== null, `${name} (${line.zone}) is a key keys.js handles there`);
        assert.equal(
          kind === 'later',
          later.test(line.text),
          `${name}: marked later exactly when it is`,
        );
        assert.ok(
          cancels(e, line.zone === 'list' ? 'list' : 'terminal', true) || name === 'Ctrl+V',
        );
        seen[line.zone as keyof typeof seen].add(
          `${e.ctrlKey ? 'C' : ''}${e.shiftKey ? 'S' : ''}${e.key}`,
        );
      }
    }
  }
  // Every key keys.js handles is in the help (S2 12.9 and A11: the keys of later stages too).
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  for (const letter of letters) {
    const chord: KeyLike = {
      key: letter.toUpperCase(),
      code: `Key${letter.toUpperCase()}`,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    };
    if (windowChord(chord, 'terminal') !== null) {
      assert.ok(seen.window.has(`CS${chord.key}`), `Ctrl+Shift+${chord.key} is in the help`);
    }
    const plain: KeyLike = {
      key: letter,
      code: `Key${letter.toUpperCase()}`,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    if (listKey(plain) !== null) assert.ok(seen.list.has(letter), `${letter} is in the help`);
  }
  for (const key of [
    '/',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Enter',
    'Escape',
    'F2',
    'F5',
  ]) {
    const plain: KeyLike = {
      key,
      code: '',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    if (listKey(plain) !== null) assert.ok(seen.list.has(key), `${key} is in the help`);
  }
  assert.ok(seen.window.has('CTab'), 'Ctrl+Tab is in the help');
  assert.ok(seen.terminal.has('Cv'), 'Ctrl+V is in the help');
  assert.ok(seen.terminal.has('SEnter'), 'Shift+Enter is in the help');
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

async function realServerCases(
  t: TestContext,
  chromium: Parameters<typeof newPage>[1],
): Promise<void> {
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
      const outside = outsideProgram(l, S2, far, ends);
      await clickRow(l.page, S2);
      await showsText(l.page, '#cards .card', new RegExp(`pid ${outside.pid}\\b`));
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
      await showsText(l.page, '#cards .card-new', /cannot pass -r \(--resume\) to claude/);
      await sleep(500);
      assert.equal(l.server.hub.list().length, 1, 'nothing more started');
      assert.equal(readRecords(l.d.record).filter((record) => record.ev === 'start').length, 1);
    },
  );
}
