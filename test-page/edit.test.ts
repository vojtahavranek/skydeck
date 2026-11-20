// Stage D's editing from the list (S2 12.5, 12.9, 12.10; plan D task 37): the dialogs of D1–D3,
// their modal rules (D2), the Undo toast and `d` (D15), and what app.js gives the cards' header
// (plan D 2.4). Every case runs against a scripted stand-in server (`editWorld`,
// helpers/shell.ts) that answers each `act` as and when the case says; the page has web/'s real
// modules, but where a case pins the recording cards (fixtures/recording-cards.js) to see what
// app.js passes to the header, or to do what the header's controls of task 38 will do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  after,
  clickRow,
  editWorld,
  fixture,
  keyMessage,
  launched,
  logOf,
  mark,
  PAGE_WAIT_MS,
  pinModules,
  RECORDER,
  scriptedList,
  selectedRow,
  showsText,
  TERM_A,
  TERM_B,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { EditWorld, Logged } from './helpers/shell.ts';

type Row = Record<string, unknown>;

/** A fourth session id. */
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
/** The stand-in's `nowNs` (scriptedList's). */
const NOW_NS = 1794474000000000000n;
const DONE_WORDS = 'Marked done: hidden from the list. It comes back on new activity.';
/** F30: the words for a running session the window cannot end (these rows carry no `endable`). */
const DONE_RUNNING_WORDS =
  'Marked done. skydeck cannot end this one: end it in its terminal. Hidden once it stops.';
const LOST = "skydeck's server stopped answering; the action may or may not have been done";

/** A row of a list (S2 8.2.3) for `id`, not running, with `more` over its fields. */
function row(id: string, more: Row = {}): Row {
  const list = scriptedList([{ id, terminal: null, slot: null }], []) as {
    sections: { rows: Row[] }[];
  };
  return { ...(list.sections[0]?.rows[0] as Row), ...more };
}

/** A row of a session running in the window's terminal `term`, in `slot`. */
function running(id: string, term: string, slot: number, more: Row = {}): Row {
  return row(id, { state: 'running', terminal: term, slot, ...more });
}

/** A terminal of the list. */
function terminal(id: string, sessionId: string, slot: number): Row {
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
  };
}

/** `list.selected` for `sessionId` (S2 8.2.3, plan D 2.2), with `more` over it. */
function selectedOf(sessionId: string, more: Row = {}): Row {
  return {
    sessionId,
    command: `cd /home/u/project && claude --resume ${sessionId}`,
    flagsKnown: true,
    unknownFlags: [],
    ended: 'exited',
    expiring: false,
    expired: false,
    note: null,
    noteTooLong: false,
    ticketUrl: null,
    ...more,
  };
}

interface Sections {
  open?: Row[];
  week?: Row[];
  earlier?: Row[];
}

/** A list of these sections and terminals, with `selected`. */
function listOf(sections: Sections, terminals: Row[], selected: Row | null): Row {
  return {
    ...scriptedList([], []),
    sections: (['open', 'week', 'earlier'] as const).map((name) => ({
      name,
      folded: false,
      firstNs: null,
      lastNs: null,
      count: sections[name]?.length ?? 0,
      rows: sections[name] ?? [],
      closedStacks: [],
    })),
    terminals,
    selected,
  };
}

/** A page on an `editWorld` whose lists are `deck`'s: its sections, its terminals and, for the
 *  selected session, `selected[id]` over `selectedOf(id)` (null: the list carries none). */
interface Deck {
  page: Page;
  w: EditWorld;
  /** Sets what the next lists hold and sends one (unless `send` is false). */
  set(
    change: { sections?: Sections; terminals?: Row[]; selected?: Record<string, Row | null> },
    send?: boolean,
  ): void;
}

async function deck(
  t: TestContext,
  chromium: Browser,
  start: { sections: Sections; terminals?: Row[]; selected?: Record<string, Row | null> },
  options: { modules?: Record<string, string>; recorder?: boolean } = {},
): Promise<Deck> {
  const page = await newPage(t, chromium);
  if (options.modules !== undefined) await pinModules(t, page, options.modules);
  if (options.recorder === true) await page.addInitScript(RECORDER);
  let sections = start.sections;
  let terminals = start.terminals ?? [];
  let selected = start.selected ?? {};
  const listFor = (id: string | null): Row =>
    listOf(
      sections,
      terminals,
      id === null || selected[id] === null ? null : selectedOf(id, selected[id] ?? {}),
    );
  const w = await editWorld(t, page, listFor);
  return {
    page,
    w,
    set(change, send = true) {
      sections = change.sections ?? sections;
      terminals = change.terminals ?? terminals;
      selected = change.selected ?? selected;
      w.list(listFor, { send });
    },
  };
}

/** What the dialog shows ('' and null for what it does not show). */
async function dialog(page: Page): Promise<{
  shown: boolean;
  what: string;
  heading: string;
  help: string;
  message: string;
  value: string | null;
  placeholder: string;
  inField: boolean;
  save: string | null;
  saveDisabled: boolean;
  cancel: string;
}> {
  return page.evaluate(() => {
    const root = document.getElementById('editor') as HTMLElement;
    const box = root.querySelector<HTMLElement>('.edit-dialog');
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('.edit-field');
    const text = (selector: string): string => {
      const element = root.querySelector<HTMLElement>(selector);
      return element === null || element.closest('[hidden]') !== null
        ? ''
        : (element.textContent ?? '');
    };
    const save = root.querySelector<HTMLButtonElement>('.edit-save');
    const fieldShown = field !== null && field.closest('[hidden]') === null;
    return {
      shown: !root.hidden,
      what: box?.dataset['what'] ?? '',
      heading: text('.edit-heading'),
      help: text('.edit-help'),
      message: text('.edit-message'),
      value: fieldShown ? field.value : null,
      placeholder: field?.placeholder ?? '',
      inField: fieldShown && document.activeElement === field,
      save: save === null || save.closest('[hidden]') !== null ? null : save.textContent,
      saveDisabled: save?.disabled ?? false,
      cancel: text('.edit-cancel'),
    };
  });
}

/** Waits until the dialog is shown (or hidden) with the keyboard in its field when shown. */
async function dialogShown(page: Page, shown: boolean): Promise<void> {
  await page.waitForSelector(shown ? '#editor:not([hidden])' : '#editor[hidden]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/**
 * Waits until the list that carries `id`'s `selected` has come: the resume card shows the command
 * it holds. (`n` acts only then, D3; before, it says to press it again.)
 */
async function selectedHasCome(page: Page, id: string): Promise<void> {
  await showsText(page, '#cards', new RegExp(`--resume ${id}`));
}

/** Polls `read` until it gives something other than null or false. */
async function eventually<T>(read: () => Promise<T | null | false>, what: string): Promise<T> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== null && value !== false) return value;
    assert.ok(performance.now() < deadline, what);
    await sleep(50);
  }
}

/** The recording cards' calls of `header` (fixtures/recording-cards.js). */
interface HeaderCall {
  row: Row | null;
  selected: Row | null;
  term: Row | null;
  now: string;
}
async function headerCalls(page: Page): Promise<HeaderCall[]> {
  return (await page.evaluate(() => Reflect.get(globalThis, 'headerCalls'))) as HeaderCall[];
}

/** The page's inputs to its terminals after `from` messages of `w.sent`. */
function inputsAfter(w: EditWorld, from: number): Row[] {
  return w.sent.slice(from).filter((message) => message['t'] === 'input');
}

/** Whether the shown terminal (inside #terminal) has the keyboard. */
async function terminalHasKeyboard(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('terminal')?.contains(document.activeElement) === true,
    null,
    { timeout: PAGE_WAIT_MS },
  );
}

/** What the toast shows: its text and whether it has an Undo ('' and false when hidden). */
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

const RECORDING = { 'cards.js': fixture('recording-cards.js') };

test('stage D: the dialogs, the Undo toast and the list keys', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "what the header gets: a running row, the list's `selected` for it, its terminal and a `now` that counts on; a list that changes only `selected` calls it again (plan D 2.4)",
    async (t) => {
      let ticket = 'https://tickets.example/browse/ABC-1';
      const d = await deck(
        t,
        chromium,
        {
          sections: { open: [running(S1, TERM_A, 1)] },
          terminals: [terminal(TERM_A, S1, 1)],
          selected: { [S1]: { ticketUrl: ticket } },
        },
        { modules: RECORDING },
      );
      const { page } = d;
      const withTicket = (url: string): Promise<HeaderCall> =>
        eventually(async () => {
          const last = (await headerCalls(page)).at(-1);
          return last?.selected?.['ticketUrl'] === url ? last : null;
        }, `a header call whose selected has ${url}`);
      const call = await withTicket(ticket);
      assert.equal(call.row?.['id'], S1);
      assert.equal(call.selected?.['sessionId'], S1);
      assert.equal(call.term?.['id'], TERM_A);
      assert.match(call.now, /^\d+$/);
      assert.ok(BigInt(call.now) >= NOW_NS, 'the server now, from the list');

      const now = (): Promise<bigint> =>
        page.evaluate(() => (Reflect.get(globalThis, 'headerNow') as () => string)()).then(BigInt);
      const first = await now();
      await sleep(1100);
      assert.ok(
        (await now()) - first >= 1_000_000_000n,
        'now counts on with the time since the list',
      );

      const calls = (await headerCalls(page)).length;
      ticket = 'https://tickets.example/browse/ABC-2';
      d.set({ selected: { [S1]: { ticketUrl: ticket } } });
      await withTicket(ticket);
      assert.ok((await headerCalls(page)).length > calls, 'called again for a change of selected');

      // The cards' `say` is a line of the key bar (plan D 2.4).
      await page.evaluate(() =>
        (Reflect.get(globalThis, 'cardsDeps') as { say(text: string): void }).say('a line'),
      );
      await showsText(page, '#key-message', /^a line$/);
    },
  );

  await t.test(
    'what the header gets: the resume and the elsewhere panes get `selected` too, and `term` null',
    async (t) => {
      const d = await deck(
        t,
        chromium,
        {
          sections: {
            open: [
              running(S1, TERM_A, 1),
              row(S3, { state: 'running', elsewhere: { pid: 77, tty: null, dir: null } }),
            ],
            week: [row(S2)],
          },
          terminals: [terminal(TERM_A, S1, 1)],
        },
        { modules: RECORDING },
      );
      for (const id of [S2, S3]) {
        await clickRow(d.page, id);
        const call = await eventually(async () => {
          const last = (await headerCalls(d.page)).at(-1);
          return last?.row?.['id'] === id && last.selected?.['sessionId'] === id ? last : null;
        }, `the header of ${id} with its selected`);
        assert.equal(call.term, null, `${id}: no terminal`);
        assert.match(call.now, /^\d+$/);
      }
    },
  );

  await t.test(
    "the label dialog: `l` opens it with the label and the keyboard in its field, Enter sends `act label`, a refusal stays under the field with the text, `ok` closes it with the keyboard back on the list at once; F2 is `l`; a title that is not the label is the field's placeholder",
    async (t) => {
      const d = await deck(t, chromium, {
        sections: {
          week: [
            row(S2, { title: 'my label', titleSource: 'label' }),
            row(S3, { title: 'Fix the build', titleSource: 'generated' }),
          ],
        },
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      let shown = await dialog(page);
      assert.equal(shown.what, 'label');
      assert.equal(shown.heading, 'Label — my label');
      assert.equal(shown.value, 'my label');
      assert.equal(shown.inField, true, 'the keyboard in the field');
      assert.equal(shown.save, 'Save');
      assert.equal(shown.cancel, 'Cancel');
      assert.equal(
        shown.help,
        'Shown as the title, and passed to Claude Code as the session name on the next start or resume. Empty clears it.',
      );

      await page.keyboard.press('Control+a');
      await page.keyboard.type('-x');
      await page.keyboard.press('Enter');
      const refused = await w.act(1);
      assert.deepEqual(
        { kind: refused['kind'], sessionId: refused['sessionId'], text: refused['text'] },
        { kind: 'label', sessionId: S2, text: '-x' },
      );
      assert.equal((await dialog(page)).saveDisabled, true, 'Save waits for the answer');
      w.answer(refused, { ok: false, error: "a label cannot start with '-'" });
      await showsText(page, '#editor .edit-message', /^a label cannot start with '-'$/);
      shown = await dialog(page);
      assert.equal(shown.shown, true);
      assert.equal(shown.value, '-x', 'the text stays');
      assert.equal(shown.inField, true, 'the keyboard stays');
      assert.equal(shown.saveDisabled, false);

      await page.keyboard.press('Control+a');
      await page.keyboard.type('new name');
      await page.keyboard.press('Enter');
      const saved = await w.act(2);
      assert.equal(saved['text'], 'new name');
      // At once, before any further list (deps.closed): the world answers no `view` meanwhile, so
      // no list comes (the page asks for one, M2).
      w.holdViews(true);
      w.answer(saved, { ok: true });
      await dialogShown(page, false);
      assert.equal(await active(page), '#list', 'the keyboard back on the list');
      assert.equal(await zone(page), 'Focus: list');
      w.holdViews(false);
      d.set({}); // the list that holds the result

      await clickRow(page, S3);
      await page.keyboard.press('F2');
      await dialogShown(page, true);
      shown = await dialog(page);
      assert.equal(shown.what, 'label');
      assert.equal(shown.value, '', 'a title that is not the label is not in the field');
      assert.equal(shown.placeholder, 'Fix the build');
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      assert.equal(await active(page), '#list');
      assert.equal(w.acts().length, 2);
    },
  );

  await t.test(
    'the group dialog: empty for a group taken from the title (its key the placeholder), filled for one the user set; Enter sends `act group`',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: {
          week: [
            row(S2, { title: 'ABC-1 fix', group: 'ABC-1', groupSource: 'title' }),
            row(S3, { title: 'Docs', group: 'topic', groupSource: 'meta' }),
          ],
        },
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('g');
      await dialogShown(page, true);
      let shown = await dialog(page);
      assert.equal(shown.what, 'group');
      assert.equal(shown.heading, 'Group — ABC-1 fix');
      assert.equal(shown.value, '');
      assert.equal(shown.placeholder, 'ABC-1');
      assert.equal(shown.help, 'Empty: the ticket key at the start of the title is used.');
      await page.keyboard.type('XYZ-9');
      await page.keyboard.press('Enter');
      const act = await w.act(1);
      assert.deepEqual(
        { kind: act['kind'], sessionId: act['sessionId'], text: act['text'] },
        { kind: 'group', sessionId: S2, text: 'XYZ-9' },
      );
      w.answer(act, { ok: true });
      await dialogShown(page, false);

      await clickRow(page, S3);
      await page.keyboard.press('g');
      await dialogShown(page, true);
      shown = await dialog(page);
      assert.equal(shown.value, 'topic', 'a group the user set is in the field');
    },
  );

  await t.test(
    'the note dialog: the note in the box, Enter a line break, Ctrl+Enter sends `act note` whose base is the listed string exactly (CRLF too); a later list changes neither the box nor the base; the conflict keeps the text',
    async (t) => {
      const note = 'line 1\r\nline 2';
      const d = await deck(t, chromium, {
        sections: { week: [row(S2, { title: 'Notes here', hasNote: true })] },
        selected: { [S2]: { note } },
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      await page.keyboard.press('n');
      await dialogShown(page, true);
      let shown = await dialog(page);
      assert.equal(shown.what, 'note');
      assert.equal(shown.heading, 'Note — Notes here');
      assert.equal(shown.value, 'line 1\nline 2', 'the note in its text box');
      assert.equal(shown.inField, true);
      assert.equal(shown.help, 'Ctrl+Enter saves. Plain text, kept on this machine.');

      await page.keyboard.press('Enter');
      await page.keyboard.type('x');
      await sleep(300);
      assert.equal(w.acts().length, 0, 'Enter is a line break');
      const typed = (await dialog(page)).value;
      assert.equal(typed?.split('\n').length, 3, typed ?? '');

      d.set({ selected: { [S2]: { note: 'changed elsewhere' } } });
      await sleep(500);
      assert.equal((await dialog(page)).value, typed, 'a later list does not change the box');

      await page.keyboard.press('Control+Enter');
      const act = await w.act(1);
      assert.equal(act['kind'], 'note');
      assert.equal(act['sessionId'], S2);
      assert.equal(act['text'], typed);
      assert.equal(act['base'], note, 'the base is the listed string, CRLF and all');
      const conflict =
        'the note was changed elsewhere while you edited it; your text is still in the box';
      w.answer(act, { ok: false, error: conflict });
      await showsText(page, '#editor .edit-message', new RegExp(`^${conflict}$`));
      shown = await dialog(page);
      assert.equal(shown.value, typed, 'the text stays');
      assert.equal(shown.inField, true);
    },
  );

  await t.test(
    'the note dialog refuses before sending: 65,537 bytes, and text that is not well formed (a lone surrogate, which the server would close the connection for); the text stays',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { week: [row(S2)] },
        selected: { [S2]: { note: 'short' } },
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      await page.keyboard.press('n');
      await dialogShown(page, true);
      const long = `${'é'.repeat(32768)}a`; // 65,537 bytes of UTF-8
      await page.fill('#editor .edit-field', long);
      await page.keyboard.press('Control+Enter');
      await showsText(
        page,
        '#editor .edit-message',
        /^the note is longer than skydeck takes: at most 65,536 bytes of UTF-8$/,
      );
      assert.equal((await dialog(page)).value, long);

      await page.evaluate(() => {
        const field = document.querySelector<HTMLTextAreaElement>('#editor .edit-field');
        if (field === null) throw new Error('no field');
        field.value = 'a\ud800b';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.keyboard.press('Control+Enter');
      await showsText(
        page,
        '#editor .edit-message',
        /^the note holds text that is not well formed; skydeck cannot take it$/,
      );
      assert.deepEqual(
        await page.evaluate(() => {
          const value = document.querySelector<HTMLTextAreaElement>('#editor .edit-field')?.value;
          return [value?.length, value?.charCodeAt(1)];
        }),
        [3, 0xd800],
        'the text stays',
      );
      await sleep(300);
      assert.equal(w.acts().length, 0, 'nothing sent');
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset['connection']),
        'open',
        'the connection stays',
      );
    },
  );

  await t.test(
    "`n` acts only once a list carries the session's `selected`; a note too long for the window opens without a field or Save, with D5's sentence",
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { week: [row(S2), row(S3)] },
        selected: { [S2]: { note: null, noteTooLong: true }, [S3]: null },
      });
      const { page } = d;
      await clickRow(page, S3);
      await page.keyboard.press('n');
      await showsText(page, '#key-message', /^the note is not here yet; press n again$/);
      assert.equal((await dialog(page)).shown, false);

      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      await page.keyboard.press('n');
      await dialogShown(page, true);
      const shown = await dialog(page);
      assert.equal(shown.what, 'note');
      assert.equal(shown.value, null, 'no text box');
      assert.equal(shown.save, null, 'no Save');
      assert.equal(
        shown.message,
        `this note is longer than the window edits; use skydeck note ${S2.slice(0, 8)}`,
      );
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
    },
  );

  await t.test(
    'the pull-request dialog: `p` opens it, Enter sends `pr-add` with the URL, a refusal keeps the text',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2, { title: 'Ship it' })] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('p');
      await dialogShown(page, true);
      const shown = await dialog(page);
      assert.equal(shown.what, 'pr');
      assert.equal(shown.heading, 'Pull requests — Ship it');
      assert.equal(shown.value, '');
      assert.equal(shown.inField, true);
      assert.equal(shown.save, 'Attach');
      // Ruled: Attach keeps the dialog open, so nothing is left to cancel.
      assert.equal(shown.cancel, 'Close');
      assert.equal(shown.help, 'Pull requests a session touched are attached by themselves.');
      const url = 'https://github.com/owner/repo/pull/7';
      await page.keyboard.type(url);
      await page.keyboard.press('Enter');
      const act = await w.act(1);
      assert.deepEqual(
        { kind: act['kind'], sessionId: act['sessionId'], url: act['url'] },
        { kind: 'pr-add', sessionId: S2, url },
      );
      w.answer(act, { ok: false, error: `not a GitHub pull-request URL: ${url}` });
      await showsText(page, '#editor .edit-message', /^not a GitHub pull-request URL: /);
      assert.equal((await dialog(page)).value, url, 'the text stays');
    },
  );

  await t.test(
    "Attach's `ok` empties the field and keeps the pull-request dialog open, the keyboard in its field (ruled; every other dialog closes on `ok`)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('p');
      await dialogShown(page, true);
      for (const [n, number] of [
        [1, 7],
        [2, 8],
      ] as const) {
        await page.keyboard.type(`https://github.com/owner/repo/pull/${number}`);
        await page.keyboard.press('Enter');
        w.answer(await w.act(n), { ok: true });
        await eventually(async () => (await dialog(page)).value === '', 'the field emptied');
        const shown = await dialog(page);
        assert.equal(shown.shown, true, 'the dialog stays open');
        assert.equal(shown.inField, true, 'the keyboard stays in the field');
        assert.equal(shown.message, '');
        assert.equal(shown.saveDisabled, false);
      }
      assert.equal(await dialog(page).then((shown) => shown.value), '');
      await page.click('#editor .edit-cancel'); // `Close`
      await dialogShown(page, false);
      assert.equal(await active(page), '#list');
    },
  );

  await t.test(
    'a held Enter saves once; the held key that opened a dialog types nothing into it; a title with markup in the heading is text',
    async (t) => {
      const markup = '<img src=x onerror="window.hacked=1">';
      const d = await deck(t, chromium, {
        sections: { week: [row(S2, { title: markup, titleSource: 'label' }), row(S3)] },
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      assert.equal((await dialog(page)).heading, `Label — ${markup}`);
      assert.equal(await page.locator('#editor img').count(), 0, 'no markup from a title');
      assert.equal(await page.evaluate(() => Reflect.get(window, 'hacked')), undefined);
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter'); // repeat: true
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await sleep(300);
      assert.equal(w.acts().length, 1, 'one act for a held Enter');
      w.answer(w.acts()[0] as Row, { ok: true });
      await dialogShown(page, false);

      await clickRow(page, S3);
      await page.keyboard.down('l');
      await page.keyboard.down('l'); // repeat: true
      await page.keyboard.down('l');
      await page.keyboard.up('l');
      await dialogShown(page, true);
      assert.equal((await dialog(page)).value, '', 'the held l is not typed');
    },
  );

  await t.test(
    "a resume's answer and its terminal never take the keyboard from a dialog (review A): typed through the answer and through the list that brings the terminal, every character is in the box, no `input` and no other `act` is sent; when the dialog closes, the resumed terminal takes the keyboard",
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { open: [running(S1, TERM_A, 1)], week: [row(S2)] },
        terminals: [terminal(TERM_A, S1, 1)],
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await showsText(page, '#focus-zone', /^Focus: list$/);
      await selectedHasCome(page, S2);
      await page.keyboard.press('Enter'); // resumes S2
      const resume = await w.act(1);
      assert.equal(resume['kind'], 'resume');
      await page.keyboard.press('n');
      await dialogShown(page, true);
      // The answer 500 ms after the act, and the list with its terminal at once after it.
      const answered = sleep(500).then(() => {
        w.answer(resume, { ok: true, sessionId: S2 });
        d.set({
          sections: { open: [running(S1, TERM_A, 1), running(S2, TERM_B, 2)] },
          terminals: [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2)],
        });
      });
      await page.keyboard.type('typed through the answer ', { delay: 40 });
      await answered;
      await page.waitForSelector(`#right-zone[data-pane-term="${TERM_B}"]`, {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await page.keyboard.type('and the list', { delay: 20 });
      await sleep(300);
      const shown = await dialog(page);
      assert.equal(shown.value, 'typed through the answer and the list');
      assert.equal(shown.inField, true);
      assert.deepEqual(inputsAfter(w, 0), [], 'no input reached a terminal');
      assert.deepEqual(
        w.acts().map((act) => act['kind']),
        ['resume'],
        'no other act',
      );

      await page.keyboard.press('Escape');
      await showsText(page, '#editor .edit-message', /^Esc again discards your text$/);
      assert.equal((await dialog(page)).shown, true);
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      await terminalHasKeyboard(page);
      assert.equal(await zone(page), 'Focus: terminal');
      const from = w.sent.length;
      await page.keyboard.type('x');
      await eventually(
        async () => inputsAfter(w, from).some((m) => m['term'] === TERM_B && m['data'] === 'x'),
        "the resumed terminal's program gets the next key",
      );
    },
  );

  await t.test(
    'Esc: an unchanged dialog closes at once; a changed note needs a second Esc, and a held Esc is not one; Cancel closes even a changed note',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { week: [row(S2)] },
        selected: { [S2]: { note: 'kept' } },
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      await page.keyboard.press('n');
      await dialogShown(page, true);
      await page.keyboard.press('Escape');
      await dialogShown(page, false);

      await page.keyboard.press('n');
      await dialogShown(page, true);
      await page.keyboard.type(' and more');
      await page.keyboard.down('Escape');
      await page.keyboard.down('Escape'); // repeat: true
      await page.keyboard.down('Escape');
      await page.keyboard.up('Escape');
      await sleep(200);
      let shown = await dialog(page);
      assert.equal(shown.shown, true, 'a held Esc is one Esc');
      assert.equal(shown.message, 'Esc again discards your text');
      assert.equal(shown.value, 'kept and more');
      await page.keyboard.press('Escape');
      await dialogShown(page, false);

      await page.keyboard.press('n');
      await dialogShown(page, true);
      shown = await dialog(page);
      assert.equal(shown.value, 'kept', 'a new dialog starts from the stored note');
      assert.equal(shown.message, '');
      await page.keyboard.type('!');
      await page.click('#editor .edit-cancel');
      await dialogShown(page, false);
      assert.equal(await active(page), '#list');
      assert.equal(w.acts().length, 0);
    },
  );

  await t.test(
    "the reload keys: with changed text they say `save or cancel the edit first` and do not reload; unchanged, F5 reloads after the server's proof",
    async (t) => {
      const d = await deck(
        t,
        chromium,
        { sections: { week: [row(S2)] }, selected: { [S2]: { note: 'n' } } },
        { recorder: true },
      );
      const { page } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      await page.keyboard.press('n');
      await dialogShown(page, true);
      await page.keyboard.type('x');
      await mark(page, 'changed');
      for (const key of ['F5', 'Control+r', 'Control+Shift+R']) {
        await page.keyboard.press(key);
        await showsText(page, '#key-message', /^save or cancel the edit first$/);
        await page.evaluate(() => {
          const message = document.getElementById('key-message');
          if (message !== null) message.textContent = '';
        });
      }
      await sleep(1500);
      assert.deepEqual(
        after(await logOf(page), 'changed').filter((entry) => entry.e === 'unload'),
        [],
        'no reload',
      );
      assert.equal((await dialog(page)).value, 'nx');

      await page.click('#editor .edit-cancel');
      await page.keyboard.press('n');
      await dialogShown(page, true);
      await mark(page, 'unchanged');
      await page.keyboard.press('F5');
      const deadline = performance.now() + PAGE_WAIT_MS;
      while (!after(await logOf(page), 'unchanged').some((entry) => entry.e === 'unload')) {
        assert.ok(performance.now() < deadline, 'F5 reloads');
        await sleep(100);
      }
      const log: Logged[] = after(await logOf(page), 'unchanged');
      const unload = log.findIndex((entry) => entry.e === 'unload');
      const fresh = log
        .slice(0, unload)
        .filter((entry) => entry.e === 'ws')
        .map((entry) => entry.s);
      assert.ok(
        log
          .slice(0, unload)
          .some((entry) => entry.e === 'in' && entry.t === 'welcome' && fresh.includes(entry.s)),
        "after a new connection's proof",
      );
    },
  );

  await t.test(
    "the connection lost while a save waits: stage A's line in the dialog, the text and the keyboard kept",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.type('a label');
      await page.keyboard.press('Enter');
      await w.act(1);
      w.drop();
      await showsText(page, '#editor .edit-message', new RegExp(`^${LOST}$`));
      const shown = await dialog(page);
      assert.equal(shown.shown, true);
      assert.equal(shown.value, 'a label');
      assert.equal(shown.inField, true);
      assert.equal(shown.saveDisabled, false);
    },
  );

  await t.test(
    'while a dialog is shown: Ctrl+Shift+1 and Ctrl+Shift+L say `close the edit first (Esc)` and change nothing, `j` and `d` are text of the field, Ctrl+Shift+H shows the help, a click on the scrim does nothing',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { open: [running(S1, TERM_A, 1)], week: [row(S2)] },
        terminals: [terminal(TERM_A, S1, 1)],
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      for (const chord of ['Control+Shift+Digit1', 'Control+Shift+L']) {
        await page.keyboard.press(chord);
        await showsText(page, '#key-message', /^close the edit first \(Esc\)$/);
        await page.evaluate(() => {
          const message = document.getElementById('key-message');
          if (message !== null) message.textContent = '';
        });
        assert.equal(await selectedRow(page), S2, chord);
        assert.equal(await zone(page), 'Focus: list', chord);
        assert.equal((await dialog(page)).inField, true, chord);
      }
      await page.keyboard.type('jd');
      await sleep(300);
      assert.equal((await dialog(page)).value, 'jd');
      assert.equal(await selectedRow(page), S2);
      assert.equal(w.acts().length, 0, 'no done');

      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help:not([hidden])', { state: 'attached' });
      assert.equal((await dialog(page)).inField, true);
      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help[hidden]', { state: 'attached' });

      const box = await page.locator(`#list [data-id="${S1}"]`).boundingBox();
      assert.ok(box !== null);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(300);
      const shown = await dialog(page);
      assert.equal(shown.shown, true, 'the dialog stays');
      assert.equal(shown.inField, true, 'the keyboard stays in the field');
      assert.equal(await selectedRow(page), S2, 'the click selected nothing');
    },
  );

  await t.test(
    "a click inside a dialog that selects nothing gives the keyboard back to its field; a drag that selects the heading's text keeps the selection (ruled: D2 for the mouse, D17)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2, { title: 'Copy me' })] } });
      const { page } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      for (const part of ['.edit-heading', '.edit-help']) {
        await page.locator(`#editor ${part}`).click();
        await eventually(async () => (await dialog(page)).inField, `${part}: the field again`);
      }
      const heading = await page.locator('#editor .edit-heading').boundingBox();
      assert.ok(heading !== null);
      await page.mouse.move(heading.x + 2, heading.y + heading.height / 2);
      await page.mouse.down();
      await page.mouse.move(heading.x + heading.width - 2, heading.y + heading.height / 2, {
        steps: 5,
      });
      await page.mouse.up();
      await sleep(300);
      assert.match(
        await page.evaluate(() => getSelection()?.toString() ?? ''),
        /Copy me/,
        'the heading is selected',
      );
      assert.equal((await dialog(page)).inField, false, 'the selection is not taken away');
    },
  );

  for (const how of ['in the field', 'on Cancel'] as const) {
    await t.test(
      `a held Enter ${how} that closes a dialog opened over the list resumes nothing; the next press does (review 2, M1)`,
      async (t) => {
        const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
        const { page, w } = d;
        await clickRow(page, S2);
        await page.keyboard.press('l');
        await dialogShown(page, true);
        if (how === 'on Cancel') {
          await page.keyboard.press('Tab');
          assert.equal(
            await page.evaluate(() => document.activeElement?.className),
            'edit-cancel',
            'Tab: Cancel has the keyboard',
          );
          await page.keyboard.down('Enter'); // presses Cancel
        } else {
          await page.keyboard.type('a name');
          await page.keyboard.down('Enter'); // saves
          w.answer(await w.act(1), { ok: true });
        }
        await dialogShown(page, false);
        assert.equal(await active(page), '#list');
        await page.keyboard.down('Enter'); // held: an auto-repeat (repeat: true)
        await page.keyboard.down('Enter');
        await page.keyboard.up('Enter');
        await sleep(300);
        assert.deepEqual(
          w.acts().map((act) => act['kind']),
          how === 'on Cancel' ? [] : ['label'],
          'the held Enter resumed nothing',
        );
        await page.keyboard.press('Enter');
        await eventually(
          async () => w.acts().at(-1)?.['kind'] === 'resume',
          'the next press resumes',
        );
      },
    );
  }

  await t.test(
    "the dialog's field takes the keyboard back whenever nothing has it: after a save from the Save button (refused) or the Attach button (ok), after a click on the key help, after the toast's Undo pressed from the keyboard (review 2, S1)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2)] } });
      const { page, w } = d;
      const value = async (): Promise<string | null> => (await dialog(page)).value;

      // A refused save from Save: the text and the keyboard stay.
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.type('ab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab'); // Save
      await page.keyboard.press('Enter');
      w.answer(await w.act(1), { ok: false, error: 'refused' });
      await showsText(page, '#editor .edit-message', /^refused$/);
      assert.equal((await dialog(page)).inField, true, 'the field has the keyboard at once');
      await page.keyboard.type('cd');
      assert.equal(await value(), 'abcd', 'typed after the refusal: in the field');

      // A click on the key help (over the dialog), the help away again.
      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help:not([hidden])', { state: 'attached' });
      await page.locator('#help .help-title').click();
      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help[hidden]', { state: 'attached' });
      await page.keyboard.type('ef');
      assert.equal(await value(), 'abcdef', 'typed after the help: in the field');
      await page.click('#editor .edit-cancel');
      await dialogShown(page, false);

      // Attach's `ok` from the Attach button.
      await page.keyboard.press('p');
      await dialogShown(page, true);
      await page.keyboard.type('https://github.com/owner/repo/pull/9');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab'); // Attach
      await page.keyboard.press('Enter');
      w.answer(await w.act(2), { ok: true });
      await eventually(async () => (await value()) === '', 'the field emptied');
      await page.keyboard.type('x');
      assert.equal(await value(), 'x', 'typed after Attach: in the field');
      await page.click('#editor .edit-cancel');
      await dialogShown(page, false);

      // The toast's Undo over a dialog, reached with Tab and pressed with Enter.
      await clickRow(page, S1);
      await selectedHasCome(page, S1); // its view's list came before `d`
      await page.keyboard.press('d');
      w.answer(await w.act(3), { ok: true });
      await eventually(async () => (await toast(page)).undo, 'the toast');
      await page.keyboard.press('l');
      await dialogShown(page, true);
      for (let tab = 0; tab < 6; tab++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(() => document.activeElement?.className === 'toast-undo')) break;
      }
      assert.equal(
        await page.evaluate(() => document.activeElement?.className),
        'toast-undo',
        "Tab reaches the toast's Undo",
      );
      await page.keyboard.press('Enter');
      assert.equal((await w.act(4))['kind'], 'undone');
      await page.keyboard.type('gh');
      assert.equal(await value(), 'gh', 'typed after the Undo: in the field');
    },
  );

  await t.test(
    'a dialog over a shown terminal: Tab and Shift+Tab never put the keyboard into the page under it, and nothing typed reaches the terminal (review 2, S2)',
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { open: [running(S1, TERM_A, 1)] },
        terminals: [terminal(TERM_A, S1, 1)],
      });
      const { page, w } = d;
      await page.waitForSelector(`#right-zone[data-pane-term="${TERM_A}"]`, { state: 'attached' });
      await toZone(page, 'list');
      await page.keyboard.press('l');
      await dialogShown(page, true);
      const from = w.sent.length;
      const inPage = (): Promise<boolean> =>
        page.evaluate(
          () => document.querySelector('.app')?.contains(document.activeElement) === true,
        );
      for (const key of [...Array(8).fill('Shift+Tab'), ...Array(8).fill('Tab')] as string[]) {
        await page.keyboard.press(key);
        assert.equal(await inPage(), false, `${key}: the keyboard is not in the page under it`);
        await page.keyboard.type('q');
        assert.equal(await inPage(), false, `${key}, q: the keyboard is not in the page under it`);
      }
      await sleep(300);
      assert.deepEqual(inputsAfter(w, from), [], 'nothing reached the terminal');
    },
  );

  await t.test(
    'while a dialog is shown no list key acts, with the keyboard on a button of the dialog or on nothing (text of the help selected): `d`, `j`, `a`, `n`, Enter (review 2, S2)',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2), row(S3)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      /** `keys`: on a button, Enter is the button's (it presses it), so it is tried on nothing. */
      const keys = async (where: string, more: string[] = []): Promise<void> => {
        const from = w.sent.length;
        for (const key of ['d', 'j', 'a', 'n', ...more]) await page.keyboard.press(key);
        await sleep(300);
        assert.deepEqual(
          w.sent.slice(from).filter((m) => m['t'] === 'act' || m['t'] === 'view'),
          [],
          `${where}: no act and no view`,
        );
        assert.equal(await selectedRow(page), S2, `${where}: the selection stays`);
        assert.equal((await dialog(page)).shown, true, `${where}: the dialog stays`);
      };
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'edit-cancel');
      await keys('on Cancel');

      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help:not([hidden])', { state: 'attached' });
      const title = await page.locator('#help .help-title').boundingBox();
      assert.ok(title !== null);
      await page.mouse.move(title.x + 2, title.y + title.height / 2);
      await page.mouse.down();
      await page.mouse.move(title.x + title.width - 2, title.y + title.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.equal(await active(page), 'BODY', 'nothing has the keyboard');
      assert.notEqual(await page.evaluate(() => getSelection()?.toString() ?? ''), '');
      await keys('on nothing', ['Enter']);
    },
  );

  await t.test(
    'an answer acts only on the dialog of its own act: one that comes after its dialog was closed and another opened changes nothing there, an `ok` or a refusal (review 2, S2)',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2), row(S3)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.type('one');
      await page.keyboard.press('Enter');
      const first = await w.act(1);
      await page.keyboard.press('Escape'); // closed while its act waits
      await dialogShown(page, false);
      await clickRow(page, S3);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.type('two');
      w.answer(first, { ok: true });
      await sleep(500);
      let shown = await dialog(page);
      assert.equal(shown.shown, true, "an earlier act's ok does not close another dialog");
      assert.equal(shown.value, 'two');

      await page.keyboard.press('Enter');
      const second = await w.act(2);
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.type('three');
      w.answer(second, { ok: false, error: 'refused' });
      await sleep(500);
      shown = await dialog(page);
      assert.equal(shown.message, '', "an earlier act's refusal shows nothing here");
      assert.equal(shown.value, 'three');
      assert.equal(shown.saveDisabled, false);
    },
  );

  await t.test(
    'held keys act once: `d` held through its answer and a list that still shows the row (done) sends no `undone`; Enter held through a refusal sends its act once (review 2, S2)',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2); // its view's list came before `d`
      await page.keyboard.down('d');
      w.answer(await w.act(1), { ok: true });
      d.set({ sections: { week: [row(S2, { done: true })] } }); // listed with `a`, say
      await sleep(500);
      await page.keyboard.down('d'); // held: an auto-repeat
      await page.keyboard.down('d');
      await page.keyboard.up('d');
      await sleep(300);
      assert.deepEqual(
        w.acts().map((act) => act['kind']),
        ['done'],
      );

      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.type('x');
      await page.keyboard.down('Enter');
      w.answer(await w.act(2), { ok: false, error: 'refused' });
      await showsText(page, '#editor .edit-message', /^refused$/);
      await page.keyboard.down('Enter'); // held through the refusal
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await sleep(300);
      assert.equal(w.acts().length, 2, 'the held Enter sent its act once');
    },
  );

  await t.test(
    'the note dialog while its save waits takes no typing; a first Esc warns again after more text; Shift+Enter is a line break in a note opened over a terminal (review 2, S2)',
    async (t) => {
      const d = await deck(
        t,
        chromium,
        {
          sections: { open: [running(S1, TERM_A, 1)], week: [row(S2)] },
          terminals: [terminal(TERM_A, S1, 1)],
          selected: { [S1]: { note: 'n' }, [S2]: { note: 'n' } },
        },
        { modules: RECORDING },
      );
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      await page.keyboard.press('n');
      await dialogShown(page, true);
      await page.keyboard.type(' more');
      await page.keyboard.press('Control+Enter');
      const act = await w.act(1);
      await page.keyboard.type('z');
      assert.equal((await dialog(page)).value, 'n more', 'nothing typed while the save waits');
      w.answer(act, { ok: false, error: 'refused' });
      await showsText(page, '#editor .edit-message', /^refused$/);

      await page.keyboard.press('Escape');
      await showsText(page, '#editor .edit-message', /^Esc again discards your text$/);
      await page.keyboard.type('!');
      assert.equal((await dialog(page)).message, '', 'the warning goes with more text');
      await page.keyboard.press('Escape');
      assert.equal((await dialog(page)).shown, true, 'the next Esc warns again');
      assert.equal((await dialog(page)).message, 'Esc again discards your text');
      await page.keyboard.press('Escape');
      await dialogShown(page, false);

      // Over a terminal (the cards' `edit`, as the header's Note of task 38).
      await page.keyboard.press('Control+Shift+1');
      await page.waitForSelector(`#right-zone[data-pane-term="${TERM_A}"]`, { state: 'attached' });
      await terminalHasKeyboard(page);
      await eventually(async () => {
        const last = (await headerCalls(page)).at(-1);
        return last?.selected?.['sessionId'] === S1;
      }, "the list with S1's selected");
      await page.evaluate(
        (id) =>
          (Reflect.get(globalThis, 'cardsDeps') as { edit(what: string, id: string): void }).edit(
            'note',
            id,
          ),
        S1,
      );
      await dialogShown(page, true);
      const from = w.sent.length;
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('x');
      assert.equal((await dialog(page)).value, 'n\nx', 'Shift+Enter is a line break');
      assert.deepEqual(inputsAfter(w, from), []);
    },
  );

  await t.test(
    "an Enter or Esc that ends an IME composition is the IME's: no save, no close (review 2, C3)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      for (const key of ['Enter', 'Escape']) {
        await page.evaluate((key) => {
          const field = document.querySelector('#editor .edit-field');
          if (field === null) throw new Error('no field');
          field.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              code: key,
              isComposing: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        }, key);
      }
      await sleep(300);
      assert.equal(w.acts().length, 0, 'no save');
      assert.equal((await dialog(page)).shown, true, 'no close');
      await page.keyboard.press('Enter');
      await w.act(1);
    },
  );

  await t.test(
    "the toast stays 5 s, timed in the page; a later toast is shown its own 5 s, whatever the earlier one's timer (review 2, S2 and C6)",
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { open: [running(S4, TERM_A, 1)], week: [row(S1)] },
        terminals: [terminal(TERM_A, S4, 1)],
      });
      const { page, w } = d;
      await page.evaluate(() => {
        const root = document.getElementById('toast') as HTMLElement;
        const times: { what: string; at: number }[] = [];
        Reflect.set(globalThis, 'toastTimes', times);
        new MutationObserver(() =>
          times.push({
            what: root.hidden ? 'hidden' : (root.querySelector('.toast-text')?.textContent ?? ''),
            at: performance.now(),
          }),
        ).observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
      });
      await clickRow(page, S1);
      await selectedHasCome(page, S1); // its view's list came before `d`
      await page.keyboard.press('d');
      w.answer(await w.act(1), { ok: true });
      await eventually(async () => (await toast(page)).text === DONE_WORDS, 'the first toast');
      await sleep(3000);
      await clickRow(page, S4);
      await toZone(page, 'list');
      await page.keyboard.press('d');
      w.answer(await w.act(2), { ok: true });
      await page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
      const times = (await page.evaluate(() => Reflect.get(globalThis, 'toastTimes'))) as {
        what: string;
        at: number;
      }[];
      const first = times.find((entry) => entry.what === DONE_WORDS);
      const second = times.find((entry) => entry.what === DONE_RUNNING_WORDS);
      const hidden = times.filter((entry) => entry.what === 'hidden');
      assert.ok(first !== undefined && second !== undefined, JSON.stringify(times));
      assert.equal(hidden.length, 1, `hidden once: ${JSON.stringify(times)}`);
      const shownFor = (hidden[0]?.at ?? 0) - second.at;
      assert.ok(shownFor >= 4990, `the second toast shown for ${shownFor} ms`);
      assert.ok(second.at - first.at >= 2990, 'the second came 3 s after the first');
    },
  );

  for (const order of ['before', 'after'] as const) {
    await t.test(
      `the selection after \`d\` with the list that holds its result ${order} the answer: the next row of the section (ruled 06:38Z)`,
      async (t) => {
        const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2), row(S3)] } });
        const { page, w } = d;
        await clickRow(page, S2);
        await selectedHasCome(page, S2); // its view's list came before `d`
        await page.keyboard.press('d');
        const act = await w.act(1);
        if (order === 'before') {
          // The real server: write, the lists, then the answer; no list after it.
          d.set({ sections: { week: [row(S1), row(S3)] } });
          await eventually(
            async () => (await page.locator(`#list [data-id="${S2}"]`).count()) === 0,
            'the row gone',
          );
          w.answer(act, { ok: true });
        } else {
          w.holdViews(true); // the page then asks for the list; it comes late, as the test's
          w.answer(act, { ok: true });
          await eventually(async () => (await toast(page)).undo, 'the toast');
          d.set({ sections: { week: [row(S1), row(S3)] } });
        }
        await eventually(async () => (await selectedRow(page)) === S3, 'the next row');
      },
    );
  }

  await t.test(
    "before `d`'s answer, a list that still shows the row as not done is older than the write and holds no result; at an answer that found no list holding it, the page asks for one (review 2's S3, ruled)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2), row(S3)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      await page.keyboard.press('d');
      const act = await w.act(1);
      d.set({ sections: { week: [row(S1), row(S2), row(S3)] } }); // crosses the write: S2 not done
      await sleep(300);
      // The list that holds the write, which the page gets only by asking for it.
      d.set({ sections: { week: [row(S1), row(S3)] } }, false);
      const views = w.sent.filter((m) => m['t'] === 'view').length;
      w.answer(act, { ok: true });
      await eventually(async () => (await selectedRow(page)) === S3, 'the next row');
      assert.equal(
        w.sent.filter((m) => m['t'] === 'view').length > views,
        true,
        'the page asked for the list',
      );
    },
  );

  await t.test(
    "the list that holds `d`'s result decides once: a list before the answer that still has the row (listed with `a`) → no move, and a later list without it moves nothing either (ruled 06:38Z)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2), row(S3)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2); // its view's list came before `d`
      await page.keyboard.press('d');
      const act = await w.act(1);
      d.set({ sections: { week: [row(S1), row(S2, { done: true }), row(S3)] } });
      await sleep(400);
      w.answer(act, { ok: true });
      await eventually(async () => (await toast(page)).undo, 'the toast');
      await sleep(300);
      assert.equal(await selectedRow(page), S2, 'still listed: no move');
      d.set({ sections: { week: [row(S1), row(S3)] } }); // hidden later (done sessions hidden again)
      await eventually(
        async () => (await page.locator(`#list [data-id="${S2}"]`).count()) === 0,
        'the row gone',
      );
      await sleep(300);
      assert.equal(await selectedRow(page), null, 'the main rule: no row selected');
    },
  );

  for (const [what, key, before, after] of [
    ['label', 'l', { title: 'old', titleSource: 'label' }, { title: 'new', titleSource: 'label' }],
    [
      'group',
      'g',
      { group: 'OLD-1', groupSource: 'meta' },
      { group: 'NEW-2', groupSource: 'meta' },
    ],
    ['note', 'n', {}, {}],
  ] as const) {
    await t.test(
      `after this page's own \`ok\` of the ${what}, \`${key}\` waits for the list that holds it: none yet → \`the ${what} is not here yet; press ${key} again\`; that list (before or after the answer) → the dialog starts from it (review 2 C1, ruled)`,
      async (t) => {
        const d = await deck(t, chromium, {
          sections: { week: [row(S2, before)] },
          selected: { [S2]: { note: 'old note' } },
        });
        const { page, w } = d;
        const newer = { sections: { week: [row(S2, after)] }, selected: { [S2]: { note: 'new' } } };
        const expected = what === 'label' ? 'new' : what === 'group' ? 'NEW-2' : 'new';
        await clickRow(page, S2);
        await selectedHasCome(page, S2);
        const save = async (n: number): Promise<Row> => {
          await page.keyboard.press(key);
          await dialogShown(page, true);
          await page.keyboard.press('Control+Enter'); // saves in every dialog
          return w.act(n);
        };
        // The answer first, no list yet (the page asks for one, whose answer is late): the key
        // waits.
        w.holdViews(true);
        const views = w.sent.filter((m) => m['t'] === 'view').length;
        w.answer(await save(1), { ok: true });
        await dialogShown(page, false);
        await eventually(
          async () => w.sent.filter((m) => m['t'] === 'view').length > views,
          'the page asks for the list (a view)',
        );
        await page.keyboard.press(key);
        await showsText(
          page,
          '#key-message',
          new RegExp(`^the ${what} is not here yet; press ${key} again$`),
        );
        assert.equal((await dialog(page)).shown, false);
        w.holdViews(false);
        d.set(newer);
        await sleep(300);
        await page.keyboard.press(key);
        await dialogShown(page, true);
        assert.equal((await dialog(page)).value, expected, 'from the list that holds it');
        await page.click('#editor .edit-cancel');
        await dialogShown(page, false);

        // The list first (the real server's order), then the answer: nothing waits.
        const act = await save(2);
        d.set(newer);
        await sleep(300);
        w.answer(act, { ok: true });
        await dialogShown(page, false);
        await page.keyboard.press(key);
        await dialogShown(page, true);
        assert.equal((await dialog(page)).value, expected);
      },
    );
  }

  await t.test(
    'the pull-request dialog does not wait after its own `ok` (review 2 C1, ruled)',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('p');
      await dialogShown(page, true);
      await page.keyboard.type('https://github.com/owner/repo/pull/1');
      await page.keyboard.press('Enter');
      w.answer(await w.act(1), { ok: true });
      await eventually(async () => (await dialog(page)).value === '', 'the field emptied');
      await page.click('#editor .edit-cancel');
      await dialogShown(page, false);
      await page.keyboard.press('p');
      await dialogShown(page, true);
    },
  );

  await t.test(
    "after an `ok` that no list followed, the page asks for one (a `view`), and its answer ends the wait at once — the server sends no list equal to the last one, so a save that changes nothing shown would wait for good (review 2's re-check, M2)",
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { week: [row(S2, { title: 'kept', titleSource: 'label' })] },
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.press('Enter'); // unchanged: no list would follow
      const act = await w.act(1);
      const views = w.sent.filter((m) => m['t'] === 'view').length;
      w.answer(act, { ok: true });
      await dialogShown(page, false);
      await eventually(
        async () => w.sent.filter((m) => m['t'] === 'view').length === views + 1,
        'one view asks for the list',
      );
      await page.keyboard.press('l');
      await dialogShown(page, true);
      assert.equal((await dialog(page)).value, 'kept');
    },
  );

  await t.test(
    "only an `ok` makes a key wait: after a refused save `l` opens at once; `p` never waits, also after a label's `ok` with no list yet; a key opened from the header's controls says `press l again` (review 2's re-check, review 1's nit)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2)] } }, { modules: RECORDING });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2);
      w.holdViews(true); // no list comes after an answer: only the page's own rule decides
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.type('-x');
      await page.keyboard.press('Enter');
      w.answer(await w.act(1), { ok: false, error: 'refused' });
      await showsText(page, '#editor .edit-message', /^refused$/);
      await page.click('#editor .edit-cancel');
      await dialogShown(page, false);
      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.click('#editor .edit-cancel');
      await dialogShown(page, false);

      await page.keyboard.press('l');
      await dialogShown(page, true);
      await page.keyboard.press('Enter');
      w.answer(await w.act(2), { ok: true });
      await dialogShown(page, false);
      await page.keyboard.press('p');
      await dialogShown(page, true);
      assert.equal((await dialog(page)).what, 'pr', 'p does not wait');
      await page.click('#editor .edit-cancel');
      await dialogShown(page, false);
      // The cards' `edit` (the header's controls of task 38) names the dialog's own key.
      await page.evaluate(
        (id) =>
          (Reflect.get(globalThis, 'cardsDeps') as { edit(what: string, id: string): void }).edit(
            'label',
            id,
          ),
        S2,
      );
      await showsText(page, '#key-message', /^the label is not here yet; press l again$/);
    },
  );

  await t.test(
    'a refusal whose dialog was closed meanwhile shows as a toast `not saved: <the error>`, as text; an `ok` stays silent (review 2 C4, ruled)',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      for (const [n, ok] of [
        [1, true],
        [2, false],
      ] as const) {
        await page.keyboard.press('l');
        await dialogShown(page, true);
        await page.keyboard.type('x');
        await page.keyboard.press('Enter');
        const act = await w.act(n);
        await page.keyboard.press('Escape');
        await dialogShown(page, false);
        w.answer(act, ok ? { ok: true } : { ok: false, error: 'a label <b>refused</b>' });
        await sleep(400);
        assert.deepEqual(
          await toast(page),
          ok
            ? { text: '', undo: false }
            : { text: 'not saved: a label <b>refused</b>', undo: false },
        );
        if (!ok) assert.equal(await page.locator('#toast b').count(), 0, 'as text');
        await page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });
        d.set({ sections: { week: [row(S2)] } }); // the list after the answer
        await sleep(300);
      }
    },
  );

  for (const answer of ['leave', 'stay'] as const) {
    await t.test(
      `a dialog with changed text asks before the page goes (the tab's reload, closing the window): ${answer} (review 2 C2, ruled)`,
      async (t) => {
        const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
        const { page } = d;
        await clickRow(page, S2);
        await page.keyboard.press('l');
        await dialogShown(page, true);
        await page.keyboard.type('unsaved');
        const asked = Promise.race([
          new Promise<string>((resolve) => {
            page.once('dialog', (prompt) => {
              resolve(prompt.type());
              void (answer === 'leave' ? prompt.accept() : prompt.dismiss());
            });
          }),
          sleep(5000).then(() => 'no prompt'),
        ]);
        const closed = new Promise<void>((resolve) => page.once('close', () => resolve()));
        await page.close({ runBeforeUnload: true });
        assert.equal(await asked, 'beforeunload');
        if (answer === 'leave') {
          await closed;
          assert.equal(page.isClosed(), true);
        } else {
          await sleep(500);
          assert.equal(page.isClosed(), false, 'the page stays');
          const shown = await dialog(page);
          assert.equal(shown.value, 'unsaved', 'the text is still in the field');
          assert.equal(shown.inField, true);
        }
      },
    );
  }

  await t.test(
    'no prompt when nothing was changed: an unchanged dialog, and no dialog (review 2 C2, ruled)',
    async (t) => {
      for (const open of [true, false]) {
        const d = await deck(t, chromium, { sections: { week: [row(S2)] } });
        const { page } = d;
        await clickRow(page, S2);
        await page.keyboard.type('j'); // a user gesture, so that a prompt could be shown
        if (open) {
          await page.keyboard.press('l');
          await dialogShown(page, true);
        }
        let asked = false;
        page.on('dialog', (prompt) => {
          asked = true;
          void prompt.accept();
        });
        const closed = new Promise<void>((resolve) => page.once('close', () => resolve()));
        await page.close({ runBeforeUnload: true });
        await closed;
        assert.equal(asked, false, open ? 'an unchanged dialog' : 'no dialog');
      }
    },
  );

  for (const key of ['Enter', 'Escape'] as const) {
    await t.test(
      `a held ${key} that closes a dialog opened over a terminal types nothing into the terminal; the next press does`,
      async (t) => {
        const d = await deck(
          t,
          chromium,
          {
            sections: { open: [running(S1, TERM_A, 1)] },
            terminals: [terminal(TERM_A, S1, 1)],
          },
          { modules: RECORDING },
        );
        const { page, w } = d;
        await page.waitForSelector(`#right-zone[data-pane-term="${TERM_A}"]`, {
          state: 'attached',
        });
        await terminalHasKeyboard(page);
        // What the header's controls of task 38 do: edit the label of the session shown.
        await page.evaluate(
          (id) =>
            (Reflect.get(globalThis, 'cardsDeps') as { edit(what: string, id: string): void }).edit(
              'label',
              id,
            ),
          S1,
        );
        await dialogShown(page, true);
        assert.equal((await dialog(page)).inField, true);
        const from = w.sent.length;
        await page.keyboard.down(key);
        if (key === 'Enter') w.answer(await w.act(1), { ok: true });
        await dialogShown(page, false);
        await terminalHasKeyboard(page);
        await page.keyboard.down(key); // held: an auto-repeat (repeat: true)
        await page.keyboard.down(key);
        await page.keyboard.up(key);
        await sleep(300);
        assert.deepEqual(inputsAfter(w, from), [], 'nothing of the held key reached the program');
        await page.keyboard.press(key);
        await eventually(
          async () =>
            inputsAfter(w, from).some(
              (m) => m['term'] === TERM_A && m['data'] === (key === 'Enter' ? '\r' : '\x1b'),
            ),
          'the next press reaches the program',
        );
      },
    );
  }

  await t.test(
    "`d` sends `done`; the toast shows D15's words; its Undo sends `undone` and takes no keyboard; a running session's words; `d` on a done row sends `undone` and shows no toast",
    async (t) => {
      const d = await deck(t, chromium, {
        sections: { open: [running(S4, TERM_A, 1)], week: [row(S1), row(S2), row(S3)] },
        terminals: [terminal(TERM_A, S4, 1)],
      });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2); // its view's list came before `d`
      await page.keyboard.press('d');
      const done = await w.act(1);
      assert.deepEqual(
        { kind: done['kind'], sessionId: done['sessionId'] },
        { kind: 'done', sessionId: S2 },
      );
      w.answer(done, { ok: true });
      await eventually(async () => (await toast(page)).text === DONE_WORDS, 'the toast');
      assert.equal((await toast(page)).undo, true);
      await page.click('#toast .toast-undo');
      const undone = await w.act(2);
      assert.deepEqual(
        { kind: undone['kind'], sessionId: undone['sessionId'] },
        { kind: 'undone', sessionId: S2 },
      );
      assert.equal(await active(page), '#list', 'the Undo took no keyboard');
      assert.equal((await toast(page)).text, '', 'the toast goes with its Undo');
      w.answer(undone, { ok: true });

      // A running session's words.
      await clickRow(page, S4);
      await toZone(page, 'list');
      await page.keyboard.press('d');
      const running4 = await w.act(3);
      w.answer(running4, { ok: true });
      await eventually(async () => (await toast(page)).text === DONE_RUNNING_WORDS, 'the toast');
      await page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 15_000 });

      // `d` on a done row (shown with `a`): undone, no toast.
      d.set({ sections: { week: [row(S1), row(S2, { done: true }), row(S3)] } });
      await clickRow(page, S2);
      await selectedHasCome(page, S2); // its view's list came before `d`
      await page.keyboard.press('d');
      const again = await w.act(4);
      assert.deepEqual(
        { kind: again['kind'], sessionId: again['sessionId'] },
        { kind: 'undone', sessionId: S2 },
      );
      w.answer(again, { ok: true });
      await sleep(500);
      assert.equal((await toast(page)).text, '', 'no toast for undone');
    },
  );

  await t.test(
    '`d` acts at its first keydown only: a held `d` sends one act, a second `d` while the answer waits sends nothing; a refused `d` moves nothing',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2), row(S3)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2); // its view's list came before `d`
      await page.keyboard.down('d');
      await page.keyboard.down('d'); // repeat: true
      await page.keyboard.down('d');
      await page.keyboard.up('d');
      await page.keyboard.press('d'); // while the answer waits
      await sleep(400);
      assert.equal(w.acts().length, 1, 'one act');
      w.answer(w.acts()[0] as Row, { ok: false, error: "skydeck's database is busy; try again" });
      await showsText(page, '#key-message', /^skydeck's database is busy; try again$/);
      assert.equal((await toast(page)).text, '');
      // The list then lacks the row (another window marked it): the main rule, no move.
      d.set({ sections: { week: [row(S1), row(S3)] } });
      await eventually(
        async () => ((await page.locator(`#list [data-id="${S2}"]`).count()) === 0 ? true : null),
        'the row gone',
      );
      await sleep(300);
      assert.equal(await selectedRow(page), null, 'a refused d moves the selection nowhere');
    },
  );

  await t.test(
    "the selection after this page's `d` in Recent: the next row, on the last row the one before it, on the only row none — never a row of Open",
    async (t) => {
      const R = running(S4, TERM_A, 1);
      const d = await deck(t, chromium, {
        sections: { open: [R], week: [row(S1), row(S2), row(S3)] },
        terminals: [terminal(TERM_A, S4, 1)],
      });
      const { page, w } = d;
      const doneOf = async (n: number, id: string, week: Row[]): Promise<void> => {
        await page.keyboard.press('d');
        const act = await w.act(n);
        assert.equal(act['sessionId'], id);
        w.answer(act, { ok: true });
        await eventually(async () => (await toast(page)).text !== '', 'the toast');
        d.set({ sections: { open: [R], week } });
      };
      await clickRow(page, S2);
      await selectedHasCome(page, S2); // its view's list came before `d`
      w.holdViews(true); // each list comes after the answer, as the test sends it
      await doneOf(1, S2, [row(S1), row(S3)]);
      await eventually(async () => (await selectedRow(page)) === S3, 'the next row');
      await doneOf(2, S3, [row(S1)]);
      await eventually(async () => (await selectedRow(page)) === S1, 'the row before it');
      await doneOf(3, S1, []);
      await eventually(
        async () => (await page.locator(`#list [data-id="${S1}"]`).count()) === 0,
        'the row gone',
      );
      await sleep(300);
      assert.equal(await selectedRow(page), null, 'none: never a row of Open');
    },
  );

  await t.test(
    'the selection after `d` moves only while the done session is still the selected one (ruled): `d` on A, ↑ to Z before the list comes → the selection stays on Z',
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2), row(S3)] } });
      const { page, w } = d;
      await clickRow(page, S2);
      await selectedHasCome(page, S2); // its view's list came before `d`
      await page.keyboard.press('d');
      const act = await w.act(1);
      await page.keyboard.press('ArrowUp');
      await eventually(async () => (await selectedRow(page)) === S1, 'moved up');
      w.answer(act, { ok: true });
      d.set({ sections: { week: [row(S1), row(S3)] } });
      await eventually(
        async () => (await page.locator(`#list [data-id="${S2}"]`).count()) === 0,
        'the row gone',
      );
      await sleep(300);
      assert.equal(await selectedRow(page), S1);
    },
  );

  await t.test(
    "the Undo of this page's `d` selects that session again once it is back, while the selection is where that `d` left it; moved meanwhile, it stays (ruled)",
    async (t) => {
      const d = await deck(t, chromium, { sections: { week: [row(S1), row(S2), row(S3)] } });
      const { page, w } = d;
      const undoOf = async (n: number): Promise<void> => {
        await page.click('#toast .toast-undo');
        const undo = await w.act(n);
        assert.equal(undo['kind'], 'undone');
        w.answer(undo, { ok: true });
        d.set({ sections: { week: [row(S1), row(S2), row(S3)] } });
      };
      for (const [n, moved] of [
        [1, false],
        [3, true],
      ] as const) {
        await clickRow(page, S2);
        await selectedHasCome(page, S2); // its view's list came before `d`
        w.holdViews(true); // the lists come after the answers, as the test sends them
        await page.keyboard.press('d');
        w.answer(await w.act(n), { ok: true });
        await eventually(async () => (await toast(page)).undo, 'the toast');
        d.set({ sections: { week: [row(S1), row(S3)] } });
        await eventually(async () => (await selectedRow(page)) === S3, 'the next row');
        if (moved) {
          await page.keyboard.press('ArrowUp');
          await eventually(async () => (await selectedRow(page)) === S1, 'moved up');
        }
        await undoOf(n + 1);
        await eventually(
          async () => (await page.locator(`#list [data-id="${S2}"]`).count()) === 1,
          'the row back',
        );
        await sleep(300);
        assert.equal(
          await selectedRow(page),
          moved ? S1 : S2,
          moved ? 'it stays' : 'selected again',
        );
        w.holdViews(false);
        d.set({}); // the list its re-selection's view would have got
      }
    },
  );

  await t.test(
    "the cards' `done` (the header's Done of task 38): one act per session while it waits, the toast, and the selection left to the main rule",
    async (t) => {
      const d = await deck(
        t,
        chromium,
        { sections: { week: [row(S1), row(S2), row(S3)] } },
        { modules: RECORDING },
      );
      const { page, w } = d;
      await clickRow(page, S2);
      await page.evaluate((id) => {
        const deps = Reflect.get(globalThis, 'cardsDeps') as { done(id: string): void };
        deps.done(id);
        deps.done(id);
      }, S2);
      await sleep(300);
      assert.equal(w.acts().length, 1, 'one act while it waits');
      w.answer(w.acts()[0] as Row, { ok: true });
      await eventually(async () => (await toast(page)).text === DONE_WORDS, 'the toast');
      d.set({ sections: { week: [row(S1), row(S3)] } });
      await eventually(
        async () => (await page.locator(`#list [data-id="${S2}"]`).count()) === 0,
        'the row gone',
      );
      await sleep(300);
      assert.equal(await selectedRow(page), null, 'no row selected (S2 12.9)');
    },
  );

  for (const [key, what] of [
    ['l', 'label'],
    ['n', 'note'],
  ] as const) {
    await t.test(
      `the real server: \`${key}\`, a save that changes nothing, \`${key}\` again → the ${what} dialog opens (review 2's re-check, M2)`,
      async (t) => {
        const l = await launched(t, chromium);
        l.d.resumable(S1);
        await clickRow(l.page, S1);
        await showsText(l.page, '#cards .card-command', /--resume/); // its `selected` has come
        const opens = async (when: string): Promise<void> => {
          await l.page.keyboard.press(key);
          await dialogShown(l.page, true).catch(async (error: unknown) => {
            assert.fail(
              `${when}: no dialog (${String(error).split('\n')[0]}); the key bar: ${await keyMessage(l.page)}; ${await zone(l.page)}; the keyboard: ${await active(l.page)}; selected ${String(await selectedRow(l.page))}; editor ${String((await dialog(l.page)).shown)}`,
            );
          });
        };
        await opens('first');
        await mark(l.page, `${key} saved`);
        await l.page.keyboard.press(key === 'n' ? 'Control+Enter' : 'Enter'); // saves, unchanged
        await dialogShown(l.page, false);
        // The server sends no list equal to the last one: the list after the result is the one
        // the page asks for (M2). Without it none comes, and the key waits for good.
        await eventually(async () => {
          const since = after(await logOf(l.page), `${key} saved`).filter((e) => e.e === 'in');
          const result = since.findIndex((e) => e.t === 'result');
          return result !== -1 && since.slice(result + 1).some((e) => e.t === 'list');
        }, 'a list after the result');
        await opens('after the save');
        assert.equal((await dialog(l.page)).what, what);
        assert.equal(await keyMessage(l.page), '');
        assert.deepEqual(l.problems, []);
      },
    );
  }

  await t.test(
    'the real server: five `d` 300 ms apart from the first row of Recent mark five rows done (review 2’s S3, ruled)',
    async (t) => {
      const l = await launched(t, chromium);
      const ids = [
        S1,
        S2,
        S3,
        S4,
        '4f9d7a5c-2b6e-4daf-9a7b-6c5d4e3f2a1b',
        '5a0e8b6d-3c7f-4eb0-8b8c-7d6e5f4a3b2c',
      ];
      for (const id of ids) l.d.resumable(id);
      const drawn = (): Promise<string[]> =>
        l.page.evaluate(() =>
          [...document.querySelectorAll('#list [data-id]')].map(
            (element) => element.getAttribute('data-id') ?? '',
          ),
        );
      await eventually(async () => (await drawn()).length === 6, 'six rows');
      const first = (await drawn())[0] as string;
      await clickRow(l.page, first);
      await showsText(l.page, '#cards .card-command', /--resume/); // its `selected` has come
      for (let n = 0; n < 5; n++) {
        await l.page.keyboard.press('d');
        await sleep(300);
      }
      await eventually(async () => (await drawn()).length === 1, 'one row left');
      assert.deepEqual(l.problems, []);
    },
  );
});
