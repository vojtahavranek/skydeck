// Issue #166, with part 2 of #188: the dialog "Restart" for a session that runs in a terminal of
// the window (web/restart-dialog.js, web/restart-text.js, app.js, the header's Restart in
// cards.js): which `r` and Restart ask, the dialog's words and keys (the keyboard on Cancel, typed
// text never restarts), `Other flags…` and back, a refusal shown in the dialog, each answer's toast
// and the ended bar's line, the dialog's own session, nothing moved after an Esc, the pane while a
// restart holds the terminal, every theme at a small window. Against a scripted stand-in server
// (`editWorld`) that answers each `act` as the case says; and one case with a real server, whose
// header shows the new flags once the stand-in has started again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  clickRow,
  editWorld,
  keyMessage,
  launched,
  PAGE_WAIT_MS,
  scriptedList,
  selectedRow,
  showsText,
  TERM_A,
  TERM_B,
  toZone,
} from './helpers/shell.ts';
import type { EditWorld } from './helpers/shell.ts';
import { recordsOf, untilScreen, untilTerminalOf, promptOf } from './helpers/terminal.ts';

type Row = Record<string, unknown>;

const RESTART = 'Restart';
const OTHER = 'Other flags…';
const CANCEL = 'Cancel';
const LINE = 'It ends claude and resumes this session here, with the same flags.';
const WORKING = 'It is working: ending it now stops the current turn.';
const RECORDED = ['--model', 'opus', '--add-dir', '/tmp/a b'];
const FIELD = '#restart-dialog input[name="flags"]';

/** A row (S2 8.2.3) for `id`, not running, with `more` over its fields. */
function row(id: string, more: Row = {}): Row {
  const list = scriptedList([{ id, terminal: null, slot: null }], []) as {
    sections: { rows: Row[] }[];
  };
  return { ...(list.sections[0]?.rows[0] as Row), ...more };
}

/** A row of a session waiting in the window's terminal `term`, which can end it. */
function endable(id: string, term: string, slot: number, more: Row = {}): Row {
  return row(id, { state: 'waiting', terminal: term, slot, endable: true, ...more });
}

function terminal(id: string, sessionId: string, slot: number, more: Row = {}): Row {
  return {
    id,
    slot,
    sessionId,
    state: 'running',
    notReported: false,
    cols: 80,
    rows: 24,
    ownsSize: true,
    openedNs: '1794470400000000000',
    ...more,
  };
}

/** S1's payload of the right side (`list.selected`): what a plain resume passes on. */
function selectedOf(more: Row = {}): Row {
  return {
    sessionId: S1,
    command: null,
    flagsKnown: true,
    unknownFlags: [],
    launchFlags: RECORDED,
    resumeFlags: RECORDED,
    ended: null,
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

interface Sections {
  open?: Row[];
  week?: Row[];
}

function listOf(sections: Sections, terminals: Row[], selected: string | null): Row {
  return {
    ...scriptedList([], []),
    sections: (['open', 'week', 'earlier'] as const).map((name) => ({
      name,
      folded: false,
      firstNs: null,
      lastNs: null,
      count: (sections as Record<string, Row[] | undefined>)[name]?.length ?? 0,
      rows: (sections as Record<string, Row[] | undefined>)[name] ?? [],
      closedStacks: [],
    })),
    terminals,
    selected: selected === S1 ? selectedOf() : null,
    favourites: [],
  };
}

interface Deck {
  page: Page;
  w: EditWorld;
  set(change: { sections?: Sections; terminals?: Row[] }): void;
}

async function deck(
  t: TestContext,
  chromium: Browser,
  start: { sections: Sections; terminals?: Row[] },
  viewport?: { width: number; height: number },
): Promise<Deck> {
  const page = await newPage(t, chromium);
  if (viewport !== undefined) await page.setViewportSize(viewport);
  let sections = start.sections;
  let terminals = start.terminals ?? [];
  const w = await editWorld(t, page, (selected) => listOf(sections, terminals, selected));
  return {
    page,
    w,
    set(change) {
      sections = change.sections ?? sections;
      terminals = change.terminals ?? terminals;
      w.list((selected) => listOf(sections, terminals, selected));
    },
  };
}

/** One deck: S1 waiting in TERM_A, which the window can end; S2 not running. */
const one = (
  t: TestContext,
  chromium: Browser,
  more: Row = {},
  viewport?: { width: number; height: number },
) =>
  deck(
    t,
    chromium,
    {
      sections: { open: [endable(S1, TERM_A, 1, more)], week: [row(S2)] },
      terminals: [terminal(TERM_A, S1, 1)],
    },
    viewport,
  );

/** What the dialog shows, and where the keyboard is (a button's words, the field, else `active`'s). */
async function restarter(page: Page): Promise<{
  shown: boolean;
  heading: string;
  tip: string;
  line: string;
  warning: string | null;
  buttons: string[];
  said: string;
  focus: string;
  inert: boolean;
  role: string | null;
  modal: string | null;
  view: string;
}> {
  return page.evaluate(() => {
    const root = document.getElementById('restart-dialog') as HTMLElement;
    const box = root.querySelector<HTMLElement>('.restart-dialog');
    const heading = root.querySelector<HTMLElement>('.end-heading');
    const warning = root.querySelector<HTMLElement>('.end-warning');
    const line = root.querySelector<HTMLElement>('.end-line');
    const visible = (one: Element): boolean => one.closest('[hidden]') === null;
    const lines = [...root.querySelectorAll<HTMLElement>('.card-lines')].filter(visible);
    const focused = document.activeElement;
    return {
      shown: !root.hidden,
      heading: heading?.textContent ?? '',
      tip: heading?.title ?? '',
      line: line !== null && visible(line) ? (line.textContent ?? '') : '',
      warning: warning === null || warning.hidden ? null : (warning.textContent ?? ''),
      buttons: [...root.querySelectorAll('button')]
        .filter(visible)
        .map((one) => one.textContent ?? ''),
      said: lines.map((one) => one.textContent ?? '').join('|'),
      focus:
        focused instanceof HTMLButtonElement && root.contains(focused)
          ? (focused.textContent ?? '')
          : focused instanceof HTMLInputElement && root.contains(focused)
            ? `field:${focused.name}`
            : focused === null
              ? 'none'
              : focused.id !== ''
                ? `#${focused.id}`
                : focused.tagName,
      inert: (document.querySelector('.app') as HTMLElement).inert,
      role: box?.getAttribute('role') ?? null,
      modal: box?.getAttribute('aria-modal') ?? null,
      view: box?.dataset['view'] ?? '',
    };
  });
}

async function shown(page: Page, open: boolean): Promise<void> {
  await page.waitForSelector(open ? '#restart-dialog:not([hidden])' : '#restart-dialog[hidden]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

async function toast(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.getElementById('toast') as HTMLElement;
    return root.hidden ? '' : (root.querySelector('.toast-text')?.textContent ?? '');
  });
}

async function eventually<T>(read: () => Promise<T | null | false>, what: string): Promise<T> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== null && value !== false) return value;
    assert.ok(performance.now() < deadline, what);
    await sleep(50);
  }
}

async function toastIs(page: Page, text: string): Promise<void> {
  await eventually(
    async () => (await toast(page)) === text,
    `the toast ${JSON.stringify(text)}: ${JSON.stringify(await toast(page))}`,
  );
}

/** Selects `id` in the list and gives the list the keyboard, then presses `r`. */
async function rFrom(page: Page, id: string): Promise<void> {
  await clickRow(page, id);
  await toZone(page, 'list');
  await page.keyboard.press('r');
}

/** The acts of `w` from the `from`-th on, as kind and their fields. */
function actsAfter(w: EditWorld, from = 0): Row[] {
  return w
    .acts()
    .slice(from)
    .map(({ t: _t, id: _id, ...rest }) => rest);
}

/** Whether the header's Restart is shown. */
async function headerRestart(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('#cards .header-restart');
    return button !== null && button.closest('[hidden]') === null;
  });
}

test('#166: the dialog "Restart" for a session that runs in a terminal of the window', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'which `r` and Restart ask: only a running session not marked done that the window can end; every other says why; the header shows Restart only then',
    async (t) => {
      const elsewhere = { pid: 4242, tty: '/dev/pts/3', dir: null, background: false };
      const d = await deck(t, chromium, {
        sections: {
          open: [
            endable(S1, TERM_A, 1),
            endable(S2, TERM_B, 2, { done: true }),
            row(S3, { state: 'running', elsewhere }),
          ],
          week: [row('3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a')],
        },
        terminals: [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2)],
      });
      const { page, w } = d;
      await rFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('Escape');
      await shown(page, false);
      assert.equal(await headerRestart(page), true);
      for (const [id, words] of [
        [S2, 'r restarts no session marked done: mark it undone first (d)'],
        [
          S3,
          'r restarts only a session that runs in a terminal of this window; this one runs in another terminal',
        ],
        [
          '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a',
          'r restarts only a session that runs in a terminal of this window; Enter resumes one',
        ],
      ] as const) {
        await rFrom(page, id);
        await toastIs(page, words);
        assert.equal((await restarter(page)).shown, false, id);
        assert.equal(await headerRestart(page), false, `no Restart in the header of ${id}`);
      }
      // A terminal of an older keeper, not connected: the window cannot end it.
      d.set({
        sections: { open: [endable(S1, TERM_A, 1, { endable: false })], week: [] },
      });
      await sleep(300);
      await rFrom(page, S1);
      await toastIs(
        page,
        'skydeck cannot end this one, so it cannot restart it: end it in its terminal',
      );
      assert.equal(await headerRestart(page), false);
      assert.deepEqual(w.acts(), [], 'nothing sent');
    },
  );

  await t.test(
    'its words, modal, the keyboard on Cancel; `r` then Enter, and `r` then letters then Enter, restart nothing; the warning while it works; the key help refused',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      await rFrom(page, S1);
      await shown(page, true);
      const state = await restarter(page);
      assert.deepEqual(
        [state.role, state.modal, state.inert, state.buttons, state.line, state.warning],
        ['dialog', 'true', true, [RESTART, OTHER, CANCEL], LINE, null],
      );
      assert.equal(state.heading.startsWith('Restart: '), true);
      assert.equal(state.focus, CANCEL, 'the keyboard starts on Cancel');
      await page.keyboard.press('Enter');
      await shown(page, false);
      assert.equal(await active(page), '#list', 'Cancel: the keyboard back where it was');
      // A sentence typed into the list by mistake: `r`, letters, a space, Enter; and a word with a
      // `d` after its `r`, then Enter (the `d` reaches no list key while the dialog is shown).
      for (const typed of ['run the tests', 'worked']) {
        await toZone(page, 'list');
        await page.keyboard.type(typed);
        await page.keyboard.press('Enter');
        await sleep(300);
        assert.equal((await restarter(page)).shown, false, typed);
        // (A Space in a sentence presses Cancel; a letter after it is a list key again, which
        // can open another dialog: Esc closes it.)
        await page.keyboard.press('Escape');
      }
      assert.deepEqual(
        actsAfter(w).filter((one) =>
          ['restart', 'end-session', 'done'].includes(String(one['kind'])),
        ),
        [],
        'nothing restarted, ended or marked done',
      );
      // Working: the end dialog's warning.
      await page.keyboard.press('Escape');
      d.set({ sections: { open: [endable(S1, TERM_A, 1, { state: 'working' })], week: [] } });
      await sleep(300);
      await rFrom(page, S1);
      await shown(page, true);
      assert.equal((await restarter(page)).warning, WORKING);
      await page.keyboard.press('Control+Shift+H');
      assert.equal(await keyMessage(page), 'close the dialog first (Esc)');
      await page.keyboard.press('Escape');
      await shown(page, false);
    },
  );

  await t.test(
    'no wrap, and a typed character keeps the keyboard on Cancel: `r` letters Tab Enter, `r` letters ← ← Enter, `r` Tab Enter, `r` letters Shift+Tab Shift+Tab Enter restart nothing and the letters reach nothing in the list; a click on Restart still works; `r` ← ← Enter and `r` Shift+Tab Shift+Tab Enter restart',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await clickRow(page, S1);
      const letters = ['d', 'l', 'n', 't'];
      const nothing: [string, string[]][] = [
        ['r letters Tab Enter', ['r', ...letters, 'Tab', 'Enter']],
        ['r letters ← ← Enter', ['r', ...letters, 'ArrowLeft', 'ArrowLeft', 'Enter']],
        ['r Tab Enter', ['r', 'Tab', 'Tab', 'ArrowRight', 'Enter']],
        [
          'r letters Shift+Tab Shift+Tab Enter',
          ['r', ...letters, 'Shift+Tab', 'Shift+Tab', 'Enter'],
        ],
      ];
      for (const [name, keys] of nothing) {
        await toZone(page, 'list');
        for (const key of keys) await page.keyboard.press(key);
        await shown(page, false);
        await sleep(300);
        assert.deepEqual(w.acts(), [], `${name}: nothing sent`);
        const open = await page.evaluate(() =>
          ['editor', 'end-dialog', 'restart-dialog'].map(
            (id) => !(document.getElementById(id) as HTMLElement).hidden,
          ),
        );
        assert.deepEqual(open, [false, false, false], `${name}: no dialog opened`);
        assert.equal(await selectedRow(page), S1, name);
        assert.equal(await active(page), '#list', `${name}: the keyboard back on the list`);
      }
      // Typed text, then the keyboard stays on Cancel, but a click on Restart presses it.
      await toZone(page, 'list');
      await page.keyboard.press('r');
      await shown(page, true);
      await page.keyboard.press('x');
      await page.keyboard.press('ArrowLeft');
      assert.equal((await restarter(page)).focus, CANCEL, 'the arrows move nothing after typing');
      await page.click('#restart-dialog .restart-restart');
      const clicked = await w.act(1);
      assert.deepEqual(actsAfter(w), [{ kind: 'restart', term: TERM_A, sessionId: S1 }]);
      w.answer(clicked, { ok: true, ended: true, sessionId: S1 });
      await shown(page, false);
      let n = 1;
      for (const [name, keys] of [
        ['r ← ← Enter', ['r', 'ArrowLeft', 'ArrowLeft', 'Enter']],
        ['r Shift+Tab Shift+Tab Enter', ['r', 'Shift+Tab', 'Shift+Tab', 'Enter']],
      ] as const) {
        await toZone(page, 'list');
        for (const key of keys) await page.keyboard.press(key);
        n += 1;
        const act = await w.act(n);
        assert.deepEqual(
          actsAfter(w, n - 1),
          [{ kind: 'restart', term: TERM_A, sessionId: S1 }],
          name,
        );
        w.answer(act, { ok: true, ended: true, sessionId: S1 });
        await shown(page, false);
      }
      // ← and Shift+Tab stop at Restart, Tab and → at Cancel.
      await toZone(page, 'list');
      await page.keyboard.press('r');
      await shown(page, true);
      const walk = async (key: string): Promise<string[]> => {
        const seen: string[] = [];
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press(key);
          seen.push((await restarter(page)).focus);
        }
        return seen;
      };
      assert.deepEqual(await walk('ArrowLeft'), [OTHER, RESTART, RESTART]);
      assert.deepEqual(await walk('Tab'), [OTHER, CANCEL, CANCEL]);
      assert.deepEqual(await walk('Shift+Tab'), [OTHER, RESTART, RESTART]);
      assert.deepEqual(await walk('ArrowRight'), [OTHER, CANCEL, CANCEL]);
      await page.keyboard.press('Escape');
      await shown(page, false);
      assert.equal(w.acts().length, 3);
    },
  );

  await t.test(
    'the header’s Restart is the first button to give way in a narrow header: no button is cut at any width from 640 px, Restart shown once there is room, `r` still there',
    async (t) => {
      const { page } = await one(t, chromium, {}, { width: 640, height: 500 });
      await clickRow(page, S1);
      const header = () =>
        page.evaluate(() => {
          const head = document.querySelector('#cards .card-header') as HTMLElement;
          const box = head.getBoundingClientRect();
          const right = box.right - parseFloat(getComputedStyle(head).paddingRight);
          const buttons = [...head.querySelectorAll<HTMLElement>('.header-top .header-button')]
            .filter(
              (one) => getComputedStyle(one).display !== 'none' && one.closest('[hidden]') === null,
            )
            .map((one) => ({
              text: one.textContent ?? '',
              inside: one.getBoundingClientRect().right <= right + 0.5,
            }));
          return buttons;
        });
      const at640 = await header();
      assert.deepEqual(
        at640.filter((one) => ['Note', 'Restart', 'Done'].includes(one.text)),
        [
          { text: 'Note', inside: true },
          { text: 'Done', inside: true },
        ],
        'at 640 px: Restart gives way, Note and Done whole',
      );
      let shownAt: number | null = null;
      for (let width = 640; width <= 1100; width += 20) {
        await page.setViewportSize({ width, height: 500 });
        await sleep(50);
        const now = await header();
        assert.deepEqual(
          now.filter((one) => !one.inside).map((one) => one.text),
          [],
          `nothing cut at ${width} px`,
        );
        if (shownAt === null && now.some((one) => one.text === 'Restart')) shownAt = width;
      }
      assert.ok(shownAt !== null && shownAt <= 900, `Restart shown from ${shownAt} px`);
      // Narrow again: `r` restarts as before.
      await page.setViewportSize({ width: 640, height: 500 });
      await toZone(page, 'list');
      await page.keyboard.press('r');
      await shown(page, true);
      await page.keyboard.press('Escape');
    },
  );

  await t.test(
    'Restart by the keyboard (r, ←, ←, Enter): one `act restart` for its session and terminal; `Restarting…`, not in a refusal’s colour, until the answer; then the toast, the keyboard back on the list, nothing selected anew',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await rFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      assert.equal((await restarter(page)).focus, RESTART);
      await page.keyboard.press('Enter');
      const restart = await w.act(1);
      assert.deepEqual(actsAfter(w), [{ kind: 'restart', term: TERM_A, sessionId: S1 }]);
      const waiting = await restarter(page);
      assert.deepEqual([waiting.shown, waiting.said], [true, 'Restarting…']);
      const colours = await page.evaluate(() => {
        const line = document.querySelector('#restart-dialog .restart-lines') as HTMLElement;
        const probe = document.createElement('div');
        probe.style.color = 'var(--dim)';
        document.body.append(probe);
        const dim = getComputedStyle(probe).color;
        probe.style.color = 'var(--crash)';
        const crash = getComputedStyle(probe).color;
        probe.remove();
        return { line: getComputedStyle(line).color, dim, crash };
      });
      assert.equal(colours.line, colours.dim, 'Restarting… is no refusal');
      assert.notEqual(colours.line, colours.crash);
      await page.keyboard.press('Enter'); // pressed again while it waits: nothing more is sent
      await sleep(200);
      assert.equal(w.acts().length, 1);
      w.answer(restart, { ok: true, ended: true, sessionId: S1 });
      await shown(page, false);
      await toastIs(page, 'Restarted.');
      assert.equal(await active(page), '#list');
      assert.equal(await selectedRow(page), S1);
      // The next dialog's line is no longer marked as waiting.
      await page.keyboard.press('r');
      await shown(page, true);
      assert.equal(
        await page.evaluate(
          () =>
            (document.querySelector('#restart-dialog .restart-lines') as HTMLElement).dataset[
              'pending'
            ] ?? null,
        ),
        null,
      );
      await page.keyboard.press('Escape');
      await shown(page, false);
    },
  );

  await t.test(
    'Other flags… (r, ←, Enter) and back: the field holds the plain resume’s flags; Esc goes back with the keyboard on Other flags…; its Restart sends the field’s text; a refusal stays, with the text and the keyboard',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await clickRow(page, S1);
      await toZone(page, 'list');
      await sleep(300); // the list with S1's payload
      await page.keyboard.press('r');
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      assert.equal((await restarter(page)).focus, OTHER);
      await page.keyboard.press('Enter');
      await page.waitForSelector(FIELD, { timeout: PAGE_WAIT_MS });
      const flags = await restarter(page);
      assert.equal(flags.view, 'flags');
      assert.equal(flags.focus, 'field:flags');
      assert.deepEqual(flags.buttons.includes(RESTART), true, 'its button reads Restart');
      assert.equal(
        await page.inputValue(FIELD),
        "--model opus --add-dir '/tmp/a b'",
        'the flags a plain resume passes on',
      );
      await showsText(
        page,
        '#restart-dialog .card-hint',
        /^restarts with these flags · Esc goes back$/,
      );
      await page.keyboard.press('Escape');
      const back = await restarter(page);
      assert.deepEqual([back.view, back.focus, back.shown], ['main', OTHER, true]);
      assert.deepEqual(w.acts(), [], 'nothing sent');
      // Again, another flag, Enter.
      await page.keyboard.press('Enter');
      await page.waitForSelector(FIELD, { timeout: PAGE_WAIT_MS });
      await page.keyboard.type(' --worktree');
      await page.keyboard.press('Enter');
      const refusedAct = await w.act(1);
      assert.deepEqual(actsAfter(w), [
        {
          kind: 'restart',
          term: TERM_A,
          sessionId: S1,
          flags: "--model opus --add-dir '/tmp/a b' --worktree",
        },
      ]);
      const words =
        'cannot pass --worktree to claude on a resume: it says where or how a new session starts';
      w.answer(refusedAct, { ok: false, error: words });
      await eventually(async () => (await restarter(page)).said === words, 'the refusal shown');
      const refused = await restarter(page);
      assert.deepEqual(
        [refused.shown, refused.view, refused.focus],
        [true, 'flags', 'field:flags'],
      );
      assert.equal(await page.inputValue(FIELD), "--model opus --add-dir '/tmp/a b' --worktree");
      // Fixed, and sent with the click of its Restart.
      await page.fill(FIELD, '--model example');
      await page.click('#restart-dialog .restart-go');
      const second = await w.act(2);
      assert.deepEqual(actsAfter(w, 1), [
        { kind: 'restart', term: TERM_A, sessionId: S1, flags: '--model example' },
      ]);
      w.answer(second, { ok: true, ended: true, sessionId: S1 });
      await shown(page, false);
      await toastIs(page, 'Restarted.');
    },
  );

  await t.test(
    'given up, and ended without a resume: the toast in each one’s words; the ended bar of its terminal shows why',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      await rFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      const waited = 'it has not ended within 10 seconds; if it ends later, resume it from its bar';
      w.answer(await w.act(1), { ok: false, ended: false, error: waited });
      await shown(page, false);
      await toastIs(page, `Not restarted: ${waited}.`);
      await rFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      const why = '0b5f3c1e: directory /w no longer exists';
      w.answer(await w.act(2), { ok: false, ended: true, error: why });
      await toastIs(page, `Restart: it ended, but was not resumed: ${why}`);
      d.set({
        sections: { open: [], week: [row(S1, { terminal: TERM_A, slot: null })] },
        terminals: [terminal(TERM_A, S1, 1, { state: 'ended', slot: null })],
      });
      await showsText(
        page,
        '#cards .card-bar + .card-lines',
        /^Restart: it ended, but was not resumed: 0b5f3c1e: directory \/w no longer exists$/,
      );
      const bar = await page.evaluate(() =>
        [...document.querySelectorAll('#cards .card-bar button')].map((one) => one.textContent),
      );
      assert.deepEqual(bar, ['Resume', 'Other flags…', 'Close']);
    },
  );

  await t.test(
    'Esc while the answer is awaited closes the dialog; the user moves on; the answer moves nothing (the selection, the zone) and comes as a toast',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await rFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      const restart = await w.act(1);
      await page.keyboard.press('Escape');
      await shown(page, false);
      await clickRow(page, S2);
      await toZone(page, 'list');
      w.answer(restart, { ok: true, ended: true, sessionId: S1 });
      await toastIs(page, 'Restarted.');
      await sleep(300);
      assert.equal(await selectedRow(page), S2, 'the selection stays where the user put it');
      assert.equal(await active(page), '#list');
      // A refusal that comes after an Esc is a toast too.
      await rFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      const second = await w.act(2);
      await page.keyboard.press('Escape');
      await shown(page, false);
      w.answer(second, { ok: false, error: 'skydeck is restarting this session' });
      await toastIs(page, 'Restart: skydeck is restarting this session');
    },
  );

  await t.test(
    'before a press the dialog follows its session: it stopped by itself, nothing sent; while a restart holds the terminal the pane shows its screen without the bar and the header says restarting…',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      await rFrom(page, S1);
      await shown(page, true);
      d.set({
        sections: { open: [], week: [row(S1, { terminal: TERM_A, slot: null })] },
        terminals: [terminal(TERM_A, S1, 1, { state: 'ended', slot: null })],
      });
      await shown(page, false);
      await toastIs(page, 'It stopped by itself: nothing was restarted.');
      assert.deepEqual(w.acts(), []);
      d.set({
        sections: { open: [endable(S1, TERM_A, 1, { state: 'not-running', endable: false })] },
        terminals: [terminal(TERM_A, S1, 1, { state: 'ended', restarting: true })],
      });
      await showsText(page, '#cards .header-state-text', /^restarting…$/);
      const pane = await page.evaluate(() => ({
        pane: document.getElementById('right-zone')?.dataset['pane'],
        bar: document.querySelector('#cards .card-bar')?.closest('[hidden]') === null,
      }));
      assert.deepEqual(pane, { pane: 'terminal', bar: false });
      await toZone(page, 'list');
      await page.keyboard.press('r');
      await toastIs(page, 'skydeck is restarting this session');
    },
  );

  await t.test(
    'held keys: a held Enter, Space, Tab or arrow presses and walks nothing; a held Enter in Other flags… restarts nothing more than its first press',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await clickRow(page, S1);
      await toZone(page, 'list');
      await sleep(300); // the list with S1's payload
      await page.keyboard.press('r');
      await shown(page, true);
      const cdp = await page.context().newCDPSession(page);
      const held = async (key: string, code: string, keyCode: number, text = '') => {
        for (let i = 0; i < 3; i++) {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            autoRepeat: true,
            ...(text === '' ? {} : { text }),
          });
        }
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        });
      };
      for (const [key, code, keyCode, text] of [
        ['Tab', 'Tab', 9, ''],
        ['ArrowLeft', 'ArrowLeft', 37, ''],
        ['ArrowRight', 'ArrowRight', 39, ''],
        ['Enter', 'Enter', 13, '\r'],
        [' ', 'Space', 32, ' '],
      ] as const) {
        await held(key, code, keyCode, text);
        const state = await restarter(page);
        assert.deepEqual([state.shown, state.focus], [true, CANCEL], `a held ${code}`);
      }
      assert.deepEqual(w.acts(), [], 'nothing pressed');
      // The Enter that opens Other flags…, held: its repeats reach the field and submit nothing.
      await page.keyboard.press('ArrowLeft');
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
      });
      await page.waitForSelector(FIELD, { timeout: PAGE_WAIT_MS });
      await held('Enter', 'Enter', 13, '\r');
      await sleep(300);
      assert.deepEqual(w.acts(), [], 'a held Enter restarts nothing');
      assert.equal((await restarter(page)).focus, 'field:flags');
      // A fresh Enter restarts once.
      await page.keyboard.press('Enter');
      await w.act(1);
      await sleep(300);
      assert.equal(w.acts().length, 1, 'one restart');
    },
  );

  await t.test(
    'Other flags… before the list has brought what a plain resume passes on: the dialog says so and opens no field; once the list has, it opens filled',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      // A list that never carries S1's payload.
      const bare = listOf(
        { open: [endable(S1, TERM_A, 1)], week: [row(S2)] },
        [terminal(TERM_A, S1, 1)],
        null,
      );
      w.list(() => bare);
      await clickRow(page, S1);
      await toZone(page, 'list');
      await page.keyboard.press('r');
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await eventually(
        async () =>
          (await restarter(page)).said ===
          'the flags it was started with are not here yet; press Other flags… again',
        'the dialog says the flags are not here yet',
      );
      assert.equal(await page.locator(FIELD).count(), 0, 'no field');
      assert.equal((await restarter(page)).view, 'main');
      d.set({});
      await sleep(300);
      await page.keyboard.press('Enter');
      await page.waitForSelector(FIELD, { timeout: PAGE_WAIT_MS });
      assert.equal(await page.inputValue(FIELD), "--model opus --add-dir '/tmp/a b'");
      assert.deepEqual(w.acts(), []);
    },
  );

  await t.test(
    'flags a plain restart does not pass on: the dialog warns of them as the resume card does, in both views',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      const warned = listOf(
        { open: [endable(S1, TERM_A, 1)], week: [row(S2)] },
        [terminal(TERM_A, S1, 1)],
        S1,
      );
      w.list(() => ({
        ...warned,
        selected: selectedOf({ unknownFlags: ['--zzz-example'] }),
      }));
      await clickRow(page, S1);
      await toZone(page, 'list');
      await sleep(300);
      await page.keyboard.press('r');
      await shown(page, true);
      const words = 'started with flags skydeck does not know, not passed on resume: --zzz-example';
      const warnings = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('#restart-dialog .card-warning')]
            .filter((one) => one.closest('[hidden]') === null)
            .map((one) => one.textContent),
        );
      await eventually(
        async () => JSON.stringify(await warnings()) === JSON.stringify([words]),
        'the warning in the dialog',
      );
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await page.waitForSelector(FIELD, { timeout: PAGE_WAIT_MS });
      assert.deepEqual(await warnings(), [words], 'also in Other flags…');
      // A session whose start was never recorded: its flags are unknown.
      await page.keyboard.press('Escape');
      w.list(() => ({ ...warned, selected: selectedOf({ flagsKnown: false, resumeFlags: [] }) }));
      await eventually(
        async () =>
          JSON.stringify(await warnings()) ===
          JSON.stringify(['original flags unknown; resuming with defaults']),
        'the unknown flags said',
      );
      assert.deepEqual(w.acts(), []);
    },
  );

  await t.test(
    'every theme at a small window: the dialog in the page’s colours, all of it inside the window, Other flags… too',
    async (t) => {
      const d = await one(t, chromium, { state: 'working' }, { width: 360, height: 300 });
      const { page } = d;
      await clickRow(page, S1);
      await toZone(page, 'list');
      await sleep(300);
      await page.keyboard.press('r');
      await shown(page, true);
      const colours = () =>
        page.evaluate(() => {
          const probe = (property: string, value: string): string => {
            const element = document.createElement('div');
            element.style.setProperty(property, value);
            document.body.append(element);
            const resolved = getComputedStyle(element).getPropertyValue(property);
            element.remove();
            return resolved;
          };
          const box = document.querySelector('#restart-dialog .restart-dialog') as HTMLElement;
          const go = document.querySelector('#restart-dialog .restart-restart') as HTMLElement;
          const warning = document.querySelector('#restart-dialog .end-warning') as HTMLElement;
          return {
            box: getComputedStyle(box).backgroundColor,
            text: getComputedStyle(box).color,
            go: getComputedStyle(go).backgroundColor,
            warning: getComputedStyle(warning).backgroundColor,
            panel: probe('background-color', 'var(--panel)'),
            ink: probe('color', 'var(--text)'),
            accent: probe('background-color', 'var(--accent)'),
            wait: probe('background-color', 'var(--wait-bg)'),
          };
        });
      const inside = (selector: string) =>
        page.evaluate((selector) => {
          return [...document.querySelectorAll(selector)]
            .filter((one) => one.closest('[hidden]') === null)
            .map((one) => {
              const r = one.getBoundingClientRect();
              return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
            });
        }, selector);
      const schemes: [string, 'light' | 'dark', Record<string, string>][] = [
        ['light', 'light', {}],
        ['light iris', 'light', { paletteLight: 'iris' }],
        ['dark', 'dark', {}],
        ['dark iris', 'dark', { paletteDark: 'iris' }],
        ['dark pleiades', 'dark', { paletteDark: 'pleiades' }],
      ];
      const seen = new Set<string>();
      for (const [name, theme, palette] of schemes) {
        await page.evaluate(
          ({ theme, palette }) => {
            const root = document.documentElement;
            root.dataset['theme'] = theme;
            delete root.dataset['paletteLight'];
            delete root.dataset['paletteDark'];
            for (const [key, value] of Object.entries(palette)) root.dataset[key] = value;
          },
          { theme, palette },
        );
        const c = await colours();
        assert.deepEqual(
          [c.box, c.text, c.go, c.warning],
          [c.panel, c.ink, c.accent, c.wait],
          name,
        );
        seen.add(c.box);
        const main = await inside(
          '#restart-dialog .restart-dialog, #restart-dialog button, #restart-dialog .end-warning',
        );
        assert.deepEqual(main, [true, true, true, true, true], `${name}: all of it inside`);
      }
      assert.ok(seen.size >= 2, 'the themes differ');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await page.waitForSelector(FIELD, { timeout: PAGE_WAIT_MS });
      const form = await inside(
        `#restart-dialog .restart-dialog, ${FIELD}, #restart-dialog .restart-go`,
      );
      assert.deepEqual(form, [true, true, true], 'Other flags…: all of it inside');
      assert.equal((await restarter(page)).focus, 'field:flags');
    },
  );

  await t.test(
    'a real server: Other flags…, `--model example`, Restart: the stand-in starts again with it, the header shows it once it has started, the row keeps its number, the keyboard is back in the list',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await clickRow(l.page, S1);
      await l.page.locator('#cards .card-actions button', { hasText: 'Resume here' }).click();
      const first = await untilTerminalOf(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      await toZone(l.page, 'list');
      // Once the session runs in its terminal and can be ended, the header offers Restart.
      await eventually(() => headerRestart(l.page), 'the header’s Restart');
      await sleep(500); // the list with S1's payload
      await l.page.keyboard.press('r');
      await shown(l.page, true);
      await l.page.keyboard.press('ArrowLeft');
      await l.page.keyboard.press('Enter');
      await l.page.waitForSelector(FIELD, { timeout: PAGE_WAIT_MS });
      await l.page.fill(FIELD, '--model example');
      await l.page.keyboard.press('Enter');
      await shown(l.page, false);
      await toastIs(l.page, 'Restarted.');
      await eventually(
        async () =>
          l.page.evaluate((old) => {
            const zone = document.getElementById('right-zone');
            const term = zone?.dataset['paneTerm'] ?? '';
            return zone?.dataset['pane'] === 'terminal' && term !== '' && term !== old;
          }, first),
        'the new terminal shown in the old one’s place',
      );
      await l.page.waitForFunction(
        () => {
          const item = document.querySelector('#cards .header-flags');
          return (
            item instanceof HTMLElement &&
            !item.hidden &&
            item.title === 'Started with: --model example'
          );
        },
        null,
        { timeout: PAGE_WAIT_MS },
      );
      const starts = recordsOf(l.d.record, S1).flatMap((one) =>
        one.ev === 'start' ? [one.argv] : [],
      );
      assert.deepEqual(starts.at(-1), ['--resume', S1, '--model', 'example']);
      const slot = await l.page.evaluate(
        (id) => document.querySelector(`#list [data-id="${id}"] .row-slot`)?.textContent ?? '',
        S1,
      );
      assert.match(slot, /1/);
      assert.equal(await active(l.page), '#list');
    },
  );
});
