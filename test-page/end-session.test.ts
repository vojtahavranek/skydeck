// Follow-up F30: the dialog "Mark done" for a session that runs in a terminal of the window and can
// be ended (web/end-dialog.js, web/end-text.js, app.js): which `d` asks first, each button, its keys
// (Enter, Space, Esc, Tab inside), the keyboard's place (idle, working, turning working), held
// keys, the dialog's own session (it closes by itself, it never acts on another), the title as
// text, the themes and a small window. Against a scripted stand-in server (`editWorld`) that
// answers each `act` as the case says.
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
  PAGE_WAIT_MS,
  scriptedList,
  TERM_A,
  TERM_B,
  toZone,
} from './helpers/shell.ts';
import type { EditWorld } from './helpers/shell.ts';

type Row = Record<string, unknown>;

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b';
const TERM_C = 'cccccccccccc';
const DONE_WORDS = 'Marked done: hidden from the list. It comes back on new activity.';
const DONE_RUNNING_WORDS = 'Marked done. Stays under Open while it runs; hidden once it stops.';
const CANNOT_WORDS =
  'Marked done. skydeck cannot end this one: end it in its terminal. Hidden once it stops.';
const END = 'End session and mark done';
const KEEP = 'Mark done, keep it running';
const CANCEL = 'Cancel';
const WORKING = 'It is working: ending it now stops the current turn.';

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

interface Sections {
  open?: Row[];
  week?: Row[];
}

function listOf(sections: Sections, terminals: Row[]): Row {
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
    selected: null,
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
  const w = await editWorld(t, page, () => listOf(sections, terminals));
  return {
    page,
    w,
    set(change) {
      sections = change.sections ?? sections;
      terminals = change.terminals ?? terminals;
      w.list(() => listOf(sections, terminals));
    },
  };
}

/** What the dialog shows, and where the keyboard is (a button's words, else `active`'s). */
async function ender(page: Page): Promise<{
  shown: boolean;
  heading: string;
  tip: string;
  line: string;
  warning: string | null;
  buttons: string[];
  focus: string;
  inert: boolean;
  role: string | null;
  modal: string | null;
  bdi: string;
}> {
  return page.evaluate(() => {
    const root = document.getElementById('end-dialog') as HTMLElement;
    const box = root.querySelector('.end-dialog');
    const heading = root.querySelector<HTMLElement>('.end-heading');
    const warning = root.querySelector<HTMLElement>('.end-warning');
    const focused = document.activeElement;
    return {
      shown: !root.hidden,
      heading: heading?.textContent ?? '',
      tip: heading?.title ?? '',
      line: root.querySelector('.end-line')?.textContent ?? '',
      warning: warning === null || warning.hidden ? null : (warning.textContent ?? ''),
      buttons: [...root.querySelectorAll('button')].map((one) => one.textContent ?? ''),
      focus:
        focused instanceof HTMLButtonElement && root.contains(focused)
          ? (focused.textContent ?? '')
          : focused === null
            ? 'none'
            : focused.id !== ''
              ? `#${focused.id}`
              : focused.tagName,
      inert: (document.querySelector('.app') as HTMLElement).inert,
      role: box?.getAttribute('role') ?? null,
      modal: box?.getAttribute('aria-modal') ?? null,
      bdi: root.querySelector('.end-title')?.tagName ?? '',
    };
  });
}

async function shown(page: Page, open: boolean): Promise<void> {
  await page.waitForSelector(open ? '#end-dialog:not([hidden])' : '#end-dialog[hidden]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

async function toast(page: Page): Promise<{ text: string; undo: boolean }> {
  return page.evaluate(() => {
    const root = document.getElementById('toast') as HTMLElement;
    if (root.hidden) return { text: '', undo: false };
    const undo = root.querySelector<HTMLElement>('.toast-undo');
    return {
      text: root.querySelector('.toast-text')?.textContent ?? '',
      undo: undo !== null && undo.closest('[hidden]') === null,
    };
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

async function toastIs(page: Page, text: string, undo: boolean): Promise<void> {
  await eventually(
    async () => {
      const now = await toast(page);
      return now.text === text && now.undo === undo;
    },
    `the toast ${JSON.stringify(text)}${undo ? ' with Undo' : ''}: ${JSON.stringify(await toast(page))}`,
  );
}

/** Selects `id` in the list and gives the list the keyboard, then presses `d`. */
async function dFrom(page: Page, id: string): Promise<void> {
  await clickRow(page, id);
  await toZone(page, 'list');
  await page.keyboard.press('d');
}

/** The acts of `w` from the `from`-th on, as kind and their fields. */
function actsAfter(w: EditWorld, from = 0): Row[] {
  return w
    .acts()
    .slice(from)
    .map(({ t: _t, id: _id, ...rest }) => rest);
}

/** One deck with S1 waiting in TERM_A, which the window can end. */
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

test('F30: the dialog "Mark done" for a session the window can end', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'which `d` asks first: only a running session not marked done that the window can end',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: {
          open: [
            endable(S1, TERM_A, 1),
            endable(S2, TERM_B, 2, { state: 'working' }),
            row(S3, { state: 'running', terminal: TERM_C, slot: 3, endable: false }),
            row(S4, { state: 'running', elsewhere: { pid: 4242, tty: '/dev/pts/3', dir: null } }),
          ],
          week: [row(S5)],
        },
        terminals: [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2), terminal(TERM_C, S3, 3)],
      });
      const { page, w } = d;
      for (const [id, working] of [
        [S1, false],
        [S2, true],
      ] as const) {
        await dFrom(page, id);
        await shown(page, true);
        const state = await ender(page);
        assert.deepEqual(
          [state.role, state.modal, state.inert, state.buttons, state.line],
          ['dialog', 'true', true, [END, KEEP, CANCEL], 'This session is still running.'],
        );
        assert.equal(state.warning, working ? WORKING : null);
        assert.equal(state.focus, KEEP, 'the keyboard starts on the second button, always');
        assert.deepEqual(w.acts(), [], 'nothing marked yet');
        await page.keyboard.press('Escape');
        await shown(page, false);
      }
      // A running one the window cannot end (an older keeper), or one in another terminal: as
      // before, but the toast says skydeck cannot end it.
      for (const [n, id] of [
        [1, S3],
        [2, S4],
      ] as const) {
        await dFrom(page, id);
        const done = await w.act(n);
        assert.deepEqual(actsAfter(w, n - 1), [{ kind: 'done', sessionId: id }]);
        w.answer(done, { ok: true });
        await toastIs(page, CANNOT_WORDS, true);
        assert.equal((await ender(page)).shown, false);
      }
      // One that does not run: D15's `d`, its toast word for word.
      await dFrom(page, S5);
      w.answer(await w.act(3), { ok: true });
      await toastIs(page, DONE_WORDS, true);
      // One marked done: `d` marks it undone, no dialog, no toast.
      d.set({ sections: { open: [endable(S1, TERM_A, 1, { done: true })], week: [] } });
      await sleep(300); // the list that marks it done has come
      await dFrom(page, S1);
      const undone = await w.act(4);
      assert.deepEqual(actsAfter(w, 3), [{ kind: 'undone', sessionId: S1 }]);
      w.answer(undone, { ok: true });
      assert.equal((await ender(page)).shown, false);
    },
  );

  await t.test(
    'End (d, ←, Enter): one `end-session` for its session and terminal; `Ending the session…` stays until the answer; ended, with Undo',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await dFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      assert.equal((await ender(page)).focus, END);
      await page.keyboard.press('Enter');
      const end = await w.act(1);
      assert.deepEqual(actsAfter(w), [{ kind: 'end-session', term: TERM_A, sessionId: S1 }]);
      await shown(page, false);
      await toastIs(page, 'Ending the session…', false);
      await sleep(5600);
      assert.equal((await toast(page)).text, 'Ending the session…', 'it stays past 5 s');
      w.answer(end, { ok: true, ended: true });
      await toastIs(page, 'Ended and marked done: hidden from the list.', true);
      await page.click('#toast .toast-undo');
      await w.act(2);
      assert.deepEqual(actsAfter(w, 1), [{ kind: 'undone', sessionId: S1 }]);
    },
  );

  await t.test(
    'End: not ended within the wait, still marked done, with Undo; refused, nothing done: the server’s words',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await dFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      w.answer(await w.act(1), { ok: true, ended: false });
      await toastIs(
        page,
        'Marked done. It has not ended yet: end it inside claude if it stays open.',
        true,
      );
      await dFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');
      w.answer(await w.act(2), { ok: false, error: 'it was marked done meanwhile' });
      await toastIs(page, 'End session: it was marked done meanwhile', false);
    },
  );

  await t.test(
    'Mark done, keep it running: D15’s `d` on a running session, its words and Undo; Cancel and Esc: nothing, the keyboard back on the list',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await dFrom(page, S1);
      await shown(page, true);
      assert.equal((await ender(page)).focus, KEEP);
      await page.keyboard.press(' ');
      const done = await w.act(1);
      assert.deepEqual(actsAfter(w), [{ kind: 'done', sessionId: S1 }]);
      w.answer(done, { ok: true });
      await toastIs(page, DONE_RUNNING_WORDS, true);
      // Cancel (Tab from the second button; → too), by Space; then Esc; then a click.
      await page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      for (const how of ['space', 'escape', 'click'] as const) {
        await dFrom(page, S1);
        await shown(page, true);
        if (how === 'space') {
          await page.keyboard.press('ArrowRight');
          assert.equal((await ender(page)).focus, CANCEL);
          await page.keyboard.press(' ');
        } else if (how === 'escape') {
          await page.keyboard.press('Escape');
        } else {
          await page.click('#end-dialog .end-cancel');
        }
        await shown(page, false);
        assert.equal(await active(page), '#list', `${how}: the keyboard back where it was`);
        assert.equal((await ender(page)).inert, false);
        assert.equal(w.acts().length, 1, `${how}: nothing sent`);
        assert.equal((await toast(page)).text, '');
      }
    },
  );

  await t.test(
    'Tab and Shift+Tab, → and ←, walk the three buttons and stay inside; a click acts at once',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await dFrom(page, S1);
      await shown(page, true);
      const walk = async (key: string): Promise<string[]> => {
        const seen: string[] = [];
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press(key);
          seen.push((await ender(page)).focus);
        }
        return seen;
      };
      assert.equal((await ender(page)).focus, KEEP);
      assert.deepEqual(await walk('Tab'), [CANCEL, END, KEEP, CANCEL]);
      assert.deepEqual(await walk('Shift+Tab'), [KEEP, END, CANCEL, KEEP]);
      assert.deepEqual(await walk('ArrowRight'), [CANCEL, END, KEEP, CANCEL]);
      assert.deepEqual(await walk('ArrowLeft'), [KEEP, END, CANCEL, KEEP]);
      assert.deepEqual(w.acts(), [], 'walking presses nothing');
      // A window chord says so and does nothing; a list key does nothing.
      await page.keyboard.press('Control+Shift+L');
      assert.equal(await keyMessage(page), 'close the dialog first (Esc)');
      await page.keyboard.press('j');
      assert.equal((await ender(page)).focus, KEEP);
      await page.click('#end-dialog .end-keep');
      await w.act(1);
      assert.deepEqual(actsAfter(w), [{ kind: 'done', sessionId: S1 }]);
    },
  );

  await t.test(
    'the keyboard: on the second button, idle or working; moved off End when it turns working; never back towards End by itself',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      await dFrom(page, S1);
      await shown(page, true);
      assert.deepEqual([(await ender(page)).focus, (await ender(page)).warning], [KEEP, null]);
      await page.keyboard.press('ArrowLeft'); // the user's own move to End
      assert.equal((await ender(page)).focus, END);
      d.set({ sections: { open: [endable(S1, TERM_A, 1, { state: 'working' })] } });
      await eventually(async () => (await ender(page)).warning === WORKING, 'the warning');
      assert.equal((await ender(page)).focus, KEEP, 'moved off End');
      d.set({ sections: { open: [endable(S1, TERM_A, 1)] } });
      await eventually(
        async () => (await ender(page)).warning === null,
        'no warning once it waits',
      );
      assert.equal((await ender(page)).focus, KEEP, 'it stays where it is');
      // On Cancel when it turns working: it stays on Cancel.
      await page.keyboard.press('Tab');
      assert.equal((await ender(page)).focus, CANCEL);
      d.set({ sections: { open: [endable(S1, TERM_A, 1, { state: 'working' })] } });
      await eventually(async () => (await ender(page)).warning === WORKING, 'the warning again');
      assert.equal((await ender(page)).focus, CANCEL);
      assert.deepEqual(w.acts(), []);
    },
  );

  await t.test(
    'held keys: the `d` that opened it presses nothing; an auto-repeated Enter or Space presses nothing',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await clickRow(page, S1);
      await toZone(page, 'list');
      await page.keyboard.down('d');
      await shown(page, true);
      await page.keyboard.down('d'); // held: an auto-repeat
      await page.keyboard.down('d');
      await page.keyboard.up('d');
      await sleep(300);
      assert.deepEqual(w.acts(), [], 'the held d marked nothing');
      assert.equal((await ender(page)).focus, KEEP);
      await page.keyboard.press('ArrowLeft'); // on End: the auto-repeats below must press nothing
      assert.equal((await ender(page)).focus, END);
      // Auto-repeats that come without a press in the dialog (a key held since before it opened).
      const cdp = await page.context().newCDPSession(page);
      for (const [key, code, keyCode] of [
        ['Enter', 'Enter', 13],
        [' ', 'Space', 32],
      ] as const) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
          autoRepeat: true,
          ...(key === 'Enter' ? { text: '\r' } : { text: ' ' }),
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        });
      }
      await sleep(300);
      assert.deepEqual(w.acts(), [], 'no auto-repeat pressed End');
      assert.equal((await ender(page)).shown, true);
      // A fresh Enter presses End once; held on, it does nothing more where the keyboard goes.
      await page.keyboard.down('Enter');
      await w.act(1);
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await sleep(300);
      assert.deepEqual(actsAfter(w), [{ kind: 'end-session', term: TERM_A, sessionId: S1 }]);
    },
  );

  await t.test(
    'a held Enter on the header’s Done: the dialog opens, its auto-repeats press nothing',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await clickRow(page, S1);
      const done = page.locator('#cards .header-done');
      await done.waitFor({ timeout: PAGE_WAIT_MS });
      await done.focus();
      await page.keyboard.down('Enter');
      await shown(page, true);
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await sleep(300);
      assert.deepEqual(w.acts(), []);
      assert.equal((await ender(page)).focus, KEEP);
      await page.keyboard.press('Escape');
      await shown(page, false);
      assert.equal(await active(page), 'BUTTON', 'Cancel: the keyboard back on Done');
    },
  );

  await t.test(
    'its own session: it closes by itself, nothing marked, when the session stops, is marked done elsewhere or leaves the list',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      const cases: [string, () => void, string][] = [
        [
          'stopped',
          () =>
            d.set({
              sections: { open: [], week: [row(S1), row(S2)] },
              terminals: [terminal(TERM_A, S1, 1, { state: 'ended' })],
            }),
          'It stopped by itself: nothing was marked done.',
        ],
        [
          'done elsewhere',
          () => d.set({ sections: { open: [endable(S1, TERM_A, 1, { done: true })] } }),
          'It was marked done in another window: nothing was ended.',
        ],
        [
          'left the list',
          () => d.set({ sections: { open: [], week: [row(S2)] } }),
          'It left the list: nothing was marked done.',
        ],
      ];
      for (const [what, change, words] of cases) {
        d.set({
          sections: { open: [endable(S1, TERM_A, 1)], week: [row(S2)] },
          terminals: [terminal(TERM_A, S1, 1)],
        });
        await dFrom(page, S1);
        await shown(page, true);
        change();
        await shown(page, false);
        await toastIs(page, words, false);
        assert.equal((await ender(page)).inert, false, what);
        await page.keyboard.press('Enter'); // the next key acts outside, never as End
        await sleep(200);
        assert.equal(
          w.acts().some((act) => act['kind'] === 'end-session' || act['kind'] === 'done'),
          false,
          `${what}: nothing marked, nothing ended`,
        );
      }
    },
  );

  await t.test(
    'a change of the list behind it never makes it act on another session',
    async (t) => {
      const d = await one(t, chromium);
      const { page, w } = d;
      await dFrom(page, S1);
      await shown(page, true);
      // Another session takes the first place and the first slot; S1 moves to TERM_B.
      d.set({
        sections: { open: [endable(S2, TERM_A, 1), endable(S1, TERM_B, 2)], week: [] },
        terminals: [terminal(TERM_A, S2, 1), terminal(TERM_B, S1, 2)],
      });
      await shown(page, false);
      await toastIs(page, 'It stopped by itself: nothing was marked done.', false);
      assert.deepEqual(w.acts(), []);
      // Only the order changes, its terminal stays: it stays, and acts on its own session.
      d.set({
        sections: { open: [endable(S1, TERM_A, 1)], week: [row(S2)] },
        terminals: [terminal(TERM_A, S1, 1)],
      });
      await dFrom(page, S1);
      await shown(page, true);
      d.set({
        sections: { open: [endable(S3, TERM_B, 2), endable(S1, TERM_A, 1)], week: [row(S2)] },
        terminals: [terminal(TERM_B, S3, 2), terminal(TERM_A, S1, 1)],
      });
      await sleep(500);
      assert.equal((await ender(page)).shown, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await w.act(1);
      assert.deepEqual(actsAfter(w), [{ kind: 'end-session', term: TERM_A, sessionId: S1 }]);
    },
  );

  await t.test(
    'words typed into the list by mistake never end a session: each `d` then Enter or Space marks it done and keeps it running, as `d` did; d, ←, Enter ends it',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { open: [endable(S1, TERM_A, 1)] },
        terminals: [terminal(TERM_A, S1, 1)],
      });
      const { page, w } = d;
      await clickRow(page, S1);
      await toZone(page, 'list');
      let n = 0;
      for (const typed of ['do not touch the tests', 'done\n', 'd ', 'worked\n', 'fixed\n']) {
        await page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
        await toZone(page, 'list');
        for (const character of typed) {
          await page.keyboard.press(
            character === '\n' ? 'Enter' : character === ' ' ? 'Space' : character,
          );
        }
        n += 1;
        const act = await w.act(n);
        assert.deepEqual(
          actsAfter(w, n - 1),
          [{ kind: 'done', sessionId: S1 }],
          `${JSON.stringify(typed)}: marked done, nothing ended`,
        );
        w.answer(act, { ok: true });
        await toastIs(page, DONE_RUNNING_WORDS, true);
        assert.equal((await ender(page)).shown, false, JSON.stringify(typed));
        await sleep(300);
        assert.equal(
          w.acts().some((one) => one['kind'] === 'end-session'),
          false,
          `${JSON.stringify(typed)}: no end-session`,
        );
      }
      // On purpose: d, ←, Enter.
      await page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      await toZone(page, 'list');
      await page.keyboard.press('d');
      await shown(page, true);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await w.act(n + 1);
      assert.deepEqual(actsAfter(w, n), [{ kind: 'end-session', term: TERM_A, sessionId: S1 }]);
    },
  );

  await t.test(
    'the title is text: markup and quotes as they are, a long one cut with … (whole in the tooltip), a right-to-left one isolated',
    async (t) => {
      const marked = `<img src=x onerror="window.pwned=1"> "quoted" & 'single'`;
      const long = `${'a long title '.repeat(10)}end`;
      const rtl = 'שלום עולם 123';
      const d = await one(t, chromium, { title: marked });
      const { page } = d;
      await dFrom(page, S1);
      await shown(page, true);
      let state = await ender(page);
      assert.equal(state.heading, `Mark done: ${marked}`);
      assert.equal(state.tip, marked);
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('#end-dialog img').length),
        0,
      );
      assert.equal(await page.evaluate(() => Reflect.get(window, 'pwned')), undefined);
      assert.equal(state.bdi, 'BDI');
      await page.keyboard.press('Escape');
      const titles: [string, string][] = [
        [long, `Mark done: ${Array.from(long).slice(0, 59).join('')}…`],
        [rtl, `Mark done: ${rtl}`],
      ];
      for (const [title, heading] of titles) {
        d.set({ sections: { open: [endable(S1, TERM_A, 1, { title })], week: [row(S2)] } });
        await eventually(
          async () =>
            (await page.locator(`#list [data-id="${S1}"]`).textContent())?.includes(
              title.slice(0, 8),
            ) === true,
          'the new title listed',
        );
        await dFrom(page, S1);
        await shown(page, true);
        state = await ender(page);
        assert.equal(state.heading, heading);
        assert.equal(state.tip, title);
        await page.keyboard.press('Escape');
        await shown(page, false);
      }
    },
  );

  await t.test(
    'light, dark and the forced themes: the dialog in the page’s colours; a small window shows all of it',
    async (t) => {
      const d = await one(t, chromium, { state: 'working' }, { width: 360, height: 300 });
      const { page } = d;
      await dFrom(page, S1);
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
          const box = document.querySelector('#end-dialog .end-dialog') as HTMLElement;
          const end = document.querySelector('#end-dialog .end-end') as HTMLElement;
          const warning = document.querySelector('#end-dialog .end-warning') as HTMLElement;
          return {
            box: getComputedStyle(box).backgroundColor,
            text: getComputedStyle(box).color,
            end: getComputedStyle(end).backgroundColor,
            warning: getComputedStyle(warning).backgroundColor,
            panel: probe('background-color', 'var(--panel)'),
            ink: probe('color', 'var(--text)'),
            accent: probe('background-color', 'var(--accent)'),
            wait: probe('background-color', 'var(--wait-bg)'),
          };
        });
      const states: Record<string, Awaited<ReturnType<typeof colours>>> = {};
      const scheme = async (value: 'light' | 'dark'): Promise<void> => {
        await page.emulateMedia({ colorScheme: value });
        await page.waitForFunction(
          (dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark,
          value === 'dark',
        );
      };
      const force = (value: string | null) =>
        page.evaluate((theme) => {
          if (theme === null) delete document.documentElement.dataset['theme'];
          else document.documentElement.dataset['theme'] = theme;
        }, value);
      await scheme('light');
      states['light'] = await colours();
      await scheme('dark');
      states['dark'] = await colours();
      await force('light');
      states['forced light'] = await colours();
      await scheme('light');
      await force('dark');
      states['forced dark'] = await colours();
      await force(null);
      for (const [name, c] of Object.entries(states)) {
        assert.deepEqual(
          [c.box, c.text, c.end, c.warning],
          [c.panel, c.ink, c.accent, c.wait],
          name,
        );
      }
      assert.notEqual(states['light']?.box, states['dark']?.box);
      assert.deepEqual(states['forced light'], states['light']);
      assert.deepEqual(states['forced dark'], states['dark']);
      // A small window: the dialog and its three buttons inside it, the warning shown.
      const fit = await page.evaluate(() => {
        const inside = (element: Element): boolean => {
          const r = element.getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        };
        return [
          ...document.querySelectorAll(
            '#end-dialog .end-dialog, #end-dialog button, #end-dialog .end-warning',
          ),
        ].map(inside);
      });
      assert.deepEqual(fit, [true, true, true, true, true]);
      assert.equal((await ender(page)).focus, KEEP);
    },
  );

  await t.test(
    'the key help never covers it: opening it hides the help, and Ctrl+Shift+H is refused while it is shown',
    async (t) => {
      const { page, w } = await one(t, chromium);
      const help = (): Promise<boolean> =>
        page.evaluate(() => !(document.getElementById('help') as HTMLElement).hidden);
      const onTop = (): Promise<boolean> =>
        page.evaluate(() => {
          const end = document.querySelector('#end-dialog .end-end') as HTMLElement;
          const r = end.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return top !== null && end.contains(top);
        });
      // The dialog first, then the help's chord.
      await dFrom(page, S1);
      await shown(page, true);
      await page.keyboard.press('Control+Shift+H');
      assert.equal(await keyMessage(page), 'close the dialog first (Esc)');
      assert.equal(await help(), false);
      assert.equal(await onTop(), true);
      await page.keyboard.press('Escape');
      await shown(page, false);
      // The help first, then `d`: the dialog opens with the help gone.
      await toZone(page, 'list');
      await page.keyboard.press('Control+Shift+H');
      await eventually(help, 'the help shown');
      await page.keyboard.press('d');
      await shown(page, true);
      assert.equal(await help(), false, 'the help went');
      assert.equal(await onTop(), true, 'nothing lies over the End button');
      await page.keyboard.press('Escape');
      await shown(page, false);
      assert.deepEqual(w.acts(), []);
    },
  );

  await t.test(
    'a press acts on the dialog’s own session and terminal also when the selection moved behind it (a resume answered meanwhile)',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { open: [endable(S1, TERM_A, 1)], week: [row(S2)] },
        terminals: [terminal(TERM_A, S1, 1)],
      });
      const { page, w } = d;
      // A resume of S2 sent and not answered yet.
      await clickRow(page, S2);
      await toZone(page, 'list');
      await page.keyboard.press('Enter');
      const resume = await w.act(1);
      assert.deepEqual(actsAfter(w), [
        { kind: 'resume', sessionId: S2, cols: resume['cols'], rows: resume['rows'] },
      ]);
      await dFrom(page, S1);
      await shown(page, true);
      // Its answer: the page selects S2 and S2 runs in TERM_B.
      d.set({
        sections: { open: [endable(S1, TERM_A, 1), endable(S2, TERM_B, 2)], week: [] },
        terminals: [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2)],
      });
      w.answer(resume, { ok: true, sessionId: S2 });
      await eventually(
        async () =>
          (await page.evaluate(() =>
            document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id'),
          )) === S2,
        'S2 selected behind the dialog',
      );
      assert.equal((await ender(page)).shown, true);
      await page.click('#end-dialog .end-end');
      await w.act(2);
      assert.deepEqual(actsAfter(w, 1), [{ kind: 'end-session', term: TERM_A, sessionId: S1 }]);
    },
  );

  await t.test(
    'Enter and Space with Shift, Ctrl, Alt or Meta, fresh or held, press nothing',
    async (t) => {
      const { page, w } = await one(t, chromium);
      await dFrom(page, S1);
      await shown(page, true);
      const cdp = await page.context().newCDPSession(page);
      const bits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
      for (const name of ['end', 'keep', 'cancel'] as const) {
        await page.evaluate((selector) => {
          (document.querySelector(selector) as HTMLElement).focus();
        }, `#end-dialog .end-${name}`);
        for (const modifier of ['Shift', 'Control', 'Alt', 'Meta'] as const) {
          for (const [key, code, keyCode, text] of [
            ['Enter', 'Enter', 13, '\r'],
            [' ', 'Space', 32, ' '],
          ] as const) {
            for (const autoRepeat of [false, true, true]) {
              await cdp.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key,
                code,
                windowsVirtualKeyCode: keyCode,
                modifiers: bits[modifier],
                autoRepeat,
                text,
              });
            }
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key,
              code,
              windowsVirtualKeyCode: keyCode,
              modifiers: bits[modifier],
            });
          }
        }
        await sleep(200);
        assert.deepEqual(w.acts(), [], `nothing pressed on ${name}`);
        assert.equal((await ender(page)).shown, true, `still shown on ${name}`);
      }
    },
  );
});
