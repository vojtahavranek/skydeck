// The quick switcher on the page (S2 12.6-12.9; plan E task 98; decisions E3, E10, E11, E12):
// Ctrl+Shift+P and the title bar's `Switch…` open a panel over every session, typing narrows it by
// the server's ranking, Enter or a click switches to a session or resumes it, and the keyboard never
// leaves the panel while it is shown. Real test servers (helpers/shell.ts `launched`) with the
// stand-in program run the cases about what a pick does; scripted stand-ins (`editWorld`, and a
// world of this file's own for a connection that is lost) run the cases that need an answer to
// come late, a payload no server would send, or a refusal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import { markDone, setGroup, setNote } from '../src/sessions/meta.ts';
import { controlClient } from '../src/window/client.ts';
import type { HiddenBy, SwitchRank } from '../src/window/protocol.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { BOOT_C, PROC_START } from '../test/helpers/restore.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { startTestServer } from '../test/helpers/window.ts';
import { browser, newContext, newPage } from './helpers/browser.ts';
import {
  clickRow,
  connection,
  editWorld,
  escape,
  honest,
  PAGE_WAIT_MS,
  pageUrl,
  problemsOf,
  readPage,
  RECORDER,
  scriptedList,
  selectedRow,
  shownText,
  showsText,
  standinServer,
  storeKey,
  TERM_A,
  TERM_B,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { EditWorld, Launched, StandinConnection } from './helpers/shell.ts';
import {
  inputOf,
  promptOf,
  recordsOf,
  resumeHere,
  shownTerm,
  until,
  untilScreen,
  untilTerminalOf,
} from './helpers/terminal.ts';
import { activityTime } from '../web/banner-text.js';

type Row = Record<string, unknown>;

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4e1a-8b8c-7d6e5f4a3b2c';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;
const DAY = 24n * HOUR;
const DONE_WORDS = 'Marked done: hidden from the list. It comes back on new activity.';
const CHORD = 'Control+Shift+P';
const FIELD = 'the switcher field';
const CLOSE_FIRST = /^close the switcher first \(Esc\)$/;
const NOT_CONNECTED = "skydeck's server is not connected";

// ---------------------------------------------------------------------------------------------
// Sessions as step 1 sees them, and a page of a real server with everything it sends recorded

/** A session last active `agoNs` before now, titled `title`, in `dir` (default: a project directory). */
function session(
  d: ServerSandbox,
  sessionId: string,
  agoNs: bigint,
  title: string,
  dir = join(d.s.home, 'project'),
): void {
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

/**
 * An init script that records in the page every message it sends but pings, whole (`sentMessages`):
 * the views, the acts, the input. It wraps whichever `send` WebSocket's prototype has when it runs,
 * so that it works before or after helpers/shell.ts's RECORDER.
 */
const SENT = `(() => {
  const sent = [];
  Reflect.set(globalThis, 'sentMessages', sent);
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message !== null && message.t !== 'ping') sent.push(message);
      } catch {}
    }
    return send.call(this, data);
  };
})();`;

/**
 * An init script that records, in order, the `switcher.query` of every `list` the page receives
 * that carries the switcher's answer (`switcherAnswers`), before the page's own handler draws it:
 * a wait on the answer to the whole text typed, which an answer to a text typed on the way (`alp`
 * for `alpha`) cannot satisfy. It wraps WebSocket's `onmessage`, which web/connection.js sets.
 */
const ANSWERS = `(() => {
  const answers = [];
  Reflect.set(globalThis, 'switcherAnswers', answers);
  // The accessor is the native WebSocket's: RECORDER may have put a subclass in its place.
  let proto = WebSocket.prototype;
  while (Object.getOwnPropertyDescriptor(proto, 'onmessage') === undefined) {
    proto = Object.getPrototypeOf(proto);
  }
  const native = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  Object.defineProperty(proto, 'onmessage', {
    configurable: true,
    enumerable: native.enumerable,
    get() {
      return native.get.call(this);
    },
    set(handler) {
      if (typeof handler !== 'function') {
        native.set.call(this, handler);
        return;
      }
      native.set.call(this, function (event) {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data);
            const query = message?.t === 'list' ? message.switcher?.query : undefined;
            if (typeof query === 'string') answers.push(query);
          } catch {}
        }
        return handler.call(this, event);
      });
    },
  });
})();`;

/** helpers/shell.ts's `launched`, with SENT among the page's init scripts from the start. */
async function launchedSent(t: TestContext, chromium: Browser): Promise<Launched> {
  const page = await newPage(t, chromium);
  await page.addInitScript(RECORDER);
  await page.addInitScript(SENT);
  await page.addInitScript(ANSWERS);
  const problems = problemsOf(page);
  const started = await startTestServer(t);
  const { token } = await controlClient(started.d.platform.net, started.d.files.serverSock).token(
    30,
  );
  await page.goto(pageUrl(started.server.port, token));
  await connection(page, 'open');
  return { ...started, page, problems };
}

/** Every message the page sent so far (but pings), whole. */
async function sentBy(page: Page): Promise<Row[]> {
  return readPage(
    page,
    () => (Reflect.get(globalThis, 'sentMessages') ?? []) as Record<string, unknown>[],
    null,
  );
}

async function viewsOf(page: Page): Promise<Row[]> {
  return (await sentBy(page)).filter((message) => message['t'] === 'view');
}

async function actsOf(page: Page): Promise<Row[]> {
  return (await sentBy(page)).filter((message) => message['t'] === 'act');
}

async function lastView(page: Page): Promise<Row> {
  const last = (await viewsOf(page)).at(-1);
  assert.ok(last !== undefined, 'the page sent a view');
  return last;
}

/** The view fields the list owns, which a pick changes only as the item's `hiddenBy` says. */
const STABLE = ['filter', 'unfolded', 'showDone', 'chips', 'closed'] as const;

/** Where, from `baseline` on, one of STABLE changed from a view to the next: the view's index and field. */
function transitions(baseline: Row, views: Row[]): { at: number; field: string }[] {
  const changed: { at: number; field: string }[] = [];
  let before = baseline;
  views.forEach((view, at) => {
    for (const field of STABLE) {
      if (JSON.stringify(view[field]) !== JSON.stringify(before[field]))
        changed.push({ at, field });
    }
    before = view;
  });
  return changed;
}

/** The views sent after the first `count` ones, with the view just before them as the baseline. */
async function viewsSince(page: Page, count: number): Promise<{ baseline: Row; views: Row[] }> {
  const all = await viewsOf(page);
  const baseline = all[count - 1];
  assert.ok(baseline !== undefined, 'a view before');
  return { baseline, views: all.slice(count) };
}

// ---------------------------------------------------------------------------------------------
// What the page shows

interface Item {
  id: string;
  rank: string;
  active: boolean;
  icon: string;
  group: string;
  title: string;
  marks: string[];
  line: string;
  chip: string;
  slot: string;
  short: string;
}

interface SwitcherView {
  shown: boolean;
  value: string;
  headings: { rank: string; text: string }[];
  items: Item[];
  offer: { text: string; active: boolean } | null;
  empty: string;
  keys: string;
  /** The footer's note that the text is cut: '' while it is hidden. */
  cut: string;
}

/** What the switcher shows (visible parts only; texts as drawn). */
async function switcherView(page: Page): Promise<SwitcherView> {
  return readPage(
    page,
    () => {
      const root = document.getElementById('switcher');
      const visible = (element: Element | null | undefined): element is HTMLElement =>
        element instanceof HTMLElement && element.checkVisibility();
      const text = (element: Element | null | undefined): string =>
        visible(element) ? (element.textContent ?? '') : '';
      const field = root?.querySelector('input.switcher-field');
      let rank = '';
      const headings: { rank: string; text: string }[] = [];
      const items: Item[] = [];
      for (const element of root?.querySelectorAll('.switcher-heading, [data-id]') ?? []) {
        if (!visible(element)) continue;
        if (element.classList.contains('switcher-heading')) {
          rank = element.dataset['rank'] ?? '';
          headings.push({ rank, text: element.textContent ?? '' });
          continue;
        }
        const title = element.querySelector('.switcher-title');
        items.push({
          id: element.dataset['id'] ?? '',
          rank,
          active: element.dataset['active'] === 'true',
          icon: element.querySelector('.switcher-icon')?.getAttribute('data-icon') ?? '',
          group: text(element.querySelector('.switcher-group')),
          title: text(title),
          marks: [...(title?.querySelectorAll('mark') ?? [])].map((mark) => mark.textContent ?? ''),
          line: text(element.querySelector('.switcher-line')),
          chip: text(element.querySelector('.switcher-chip')),
          slot: text(element.querySelector('.switcher-slot')),
          short: text(element.querySelector('.switcher-short')),
        });
      }
      const offer = root?.querySelector('[data-offer]');
      return {
        shown: root instanceof HTMLElement && !root.hidden,
        value: field instanceof HTMLInputElement ? field.value : '',
        headings,
        items,
        offer: visible(offer)
          ? { text: offer.textContent ?? '', active: offer.dataset['active'] === 'true' }
          : null,
        empty: text(root?.querySelector('.switcher-empty')),
        keys: text(root?.querySelector('.switcher-keys')),
        cut: text(root?.querySelector('.switcher-cut')),
      };
    },
    null,
  );
}

/**
 * Waits until the page has drawn the switcher's answer to `text` — the last list it received with
 * the switcher's answer is the one for `text`, its query as the page sent it — and `check` holds.
 * The wait after typing: an answer to a text typed on the way cannot satisfy it.
 */
async function untilAnswer(
  page: Page,
  text: string,
  check: (view: SwitcherView) => boolean,
  what: string,
): Promise<SwitcherView> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const last = await readPage(
      page,
      () => (Reflect.get(globalThis, 'switcherAnswers') as string[] | undefined)?.at(-1) ?? null,
      null,
    );
    const view = await switcherView(page);
    if (last === text && check(view)) return view;
    if (performance.now() > deadline) {
      assert.fail(
        `${what}: the last answer is to ${JSON.stringify(last)}, not ${JSON.stringify(text)}; the switcher shows ${JSON.stringify(view, null, 1)}`,
      );
    }
    await sleep(50);
  }
}

/** Waits until the switcher's view satisfies `check`; fails with what it showed. */
async function untilSwitcher(
  page: Page,
  check: (view: SwitcherView) => boolean,
  what: string,
): Promise<SwitcherView> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const view = await switcherView(page);
    if (check(view)) return view;
    if (performance.now() > deadline) {
      assert.fail(`${what}: the switcher shows ${JSON.stringify(view, null, 1)}`);
    }
    await sleep(50);
  }
}

/** The ids of the items, in order. */
function idsOf(view: SwitcherView): string[] {
  return view.items.map((item) => item.id);
}

/** Waits until the switcher is shown (or hidden). */
async function switcherShown(page: Page, shown: boolean): Promise<void> {
  await page.waitForSelector(shown ? '#switcher:not([hidden])' : '#switcher[hidden]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** Where the keyboard is: the switcher's field, the list, its filter, the terminal, the cards. */
async function keyboardOn(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const element = document.activeElement;
      if (element === null || element === document.body) return 'nothing';
      if (element.matches('#switcher input.switcher-field')) return 'the switcher field';
      if (element.closest('#switcher') !== null) {
        return `the switcher: ${element.tagName}.${element.className}`;
      }
      if (element.classList.contains('list-filter')) return 'the filter';
      if (element.id === 'list') return 'the list';
      if (document.getElementById('terminal')?.contains(element) === true) return 'the terminal';
      if (element.closest('#cards') !== null) {
        return `the cards: ${element.tagName}[${element.getAttribute('name') ?? ''}]`;
      }
      return `${element.tagName}#${element.id}.${element.className}`;
    },
    null,
  );
}

/** Waits until the keyboard is on `expected` (see keyboardOn). */
async function keyboardIs(page: Page, expected: string): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const on = await keyboardOn(page);
    if (on === expected) return;
    if (performance.now() > deadline) assert.equal(on, expected, 'where the keyboard is');
    await sleep(50);
  }
}

/** Opens the switcher with its chord; waits until it is shown with the keyboard in its field. */
async function openSwitcher(page: Page): Promise<void> {
  await page.keyboard.press(CHORD);
  await switcherShown(page, true);
  await keyboardIs(page, FIELD);
}

/** Selects the field's text and deletes it. */
async function clearField(page: Page): Promise<void> {
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
}

interface ListRow {
  id: string;
  section: string;
  marks: string[];
  selected: boolean;
}

/** The rows the list draws, in order, with their section, their marks and whether selected. */
async function listRows(page: Page): Promise<ListRow[]> {
  return readPage(
    page,
    () => {
      let section = '';
      const drawn: ListRow[] = [];
      for (const element of document.querySelectorAll('#list .list-section, #list .list-row')) {
        if (!(element instanceof HTMLElement) || !element.checkVisibility()) continue;
        if (element.classList.contains('list-section')) {
          section = element.dataset['section'] ?? '';
          continue;
        }
        drawn.push({
          id: element.dataset['id'] ?? '',
          section,
          marks: [...element.querySelectorAll('.row-mark')]
            .filter((mark) => mark instanceof HTMLElement && mark.checkVisibility())
            .map((mark) => mark.textContent ?? ''),
          selected: element.dataset['selected'] === 'true',
        });
      }
      return drawn;
    },
    null,
  );
}

/** Waits until the list draws exactly `ids`, in order. */
async function untilRows(page: Page, ids: string[], what: string): Promise<ListRow[]> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const rows = await listRows(page);
    if (rows.map((row) => row.id).join() === ids.join()) return rows;
    if (performance.now() > deadline) {
      assert.fail(`${what}: the list draws ${JSON.stringify(rows.map((row) => row.id))}`);
    }
    await sleep(50);
  }
}

/** Waits until the selected row is `id`. */
async function untilSelected(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (id) => document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
    id,
    { timeout: PAGE_WAIT_MS },
  );
}

/** Whether the shown terminal (inside #terminal) has the keyboard, waited for. */
async function terminalHasKeyboard(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('terminal')?.contains(document.activeElement) === true,
    null,
    { timeout: PAGE_WAIT_MS },
  );
}

/** Empties the key bar's message, so that the next one can be told from this. */
async function clearMessage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const message = document.getElementById('key-message');
    if (message !== null) message.textContent = '';
  });
}

/**
 * The page of a real server reports no problem (no console error, nothing uncaught, no failed
 * load: ruled for every real-server case), and the switcher keeps its hooks: each item
 * `#switcher [data-id]` is a `.switcher-item`, never inside `#list`, `data-active` `true` on at most
 * one of them and `false` on the others; the list keeps exactly one `#list [data-id]` per row.
 */
async function healthy(l: { page: Page; problems: readonly string[] }): Promise<void> {
  assert.deepEqual(l.problems, [], 'the page reports no problem');
  const hooks = await readPage(
    l.page,
    () => {
      const items = [...document.querySelectorAll('#switcher [data-id]')];
      return {
        notItems: items.filter((item) => !item.classList.contains('switcher-item')).length,
        inList: items.filter((item) => item.closest('#list') !== null).length,
        badActive: items.filter(
          (item) => !['true', 'false'].includes(`${item.getAttribute('data-active')}`),
        ).length,
        active: items.filter((item) => item.getAttribute('data-active') === 'true').length,
        listIds: document.querySelectorAll('#list [data-id]').length,
        listRows: document.querySelectorAll('#list .list-row').length,
      };
    },
    null,
  );
  assert.equal(hooks.notItems, 0, 'every #switcher [data-id] is a .switcher-item');
  assert.equal(hooks.inList, 0, 'no item inside #list');
  assert.equal(hooks.badActive, 0, 'data-active is true or false on every item');
  assert.ok(hooks.active <= 1, 'one active item at most');
  assert.equal(hooks.listIds, hooks.listRows, 'only the list rows carry data-id in #list');
}

// ---------------------------------------------------------------------------------------------
// Scripted worlds: lists as a server would send them

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

/** `list.selected` for `sessionId` (S2 8.2.3, plan D 2.2). */
function selectedOf(sessionId: string): Row {
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
  };
}

interface Sections {
  open?: Row[];
  week?: Row[];
  earlier?: Row[];
  /** Earlier as the server sends it while folded: `rows: []`, its count kept. */
  earlierFolded?: boolean;
}

/** A list of these sections and terminals, with `selected` and the switcher's payload. */
function listOf(
  sections: Sections,
  terminals: Row[],
  selected: Row | null,
  switcher: Row | null,
): Row {
  return {
    ...scriptedList([], []),
    sections: (['open', 'week', 'earlier'] as const).map((name) => {
      const rows = sections[name] ?? [];
      const folded = name === 'earlier' && sections.earlierFolded === true;
      return {
        name,
        folded,
        firstNs: null,
        lastNs: null,
        count: rows.length,
        rows: folded ? [] : rows,
        closedStacks: [],
      };
    }),
    terminals,
    selected,
    switcher,
  };
}

/** What a session is in the switcher: its rank, and what the page's list would change to show it. */
interface Entry {
  id: string;
  title: string;
  rank: SwitchRank;
  hiddenBy?: HiddenBy[];
  /** Over the item's row. */
  row?: Row;
}

/** The occurrences of each of `words` in `title`, as `found` carries them (sorted, not merged). */
function foundIn(title: string, words: string[]): [number, number][] {
  const lower = title.toLowerCase();
  const found: [number, number][] = [];
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
      found.push([at, at + word.length]);
    }
  }
  return found.sort((a, b) => a[0] - b[0]);
}

/** The server's payload for `text`: the entries whose title holds every word, in the order given. */
function payloadFor(text: string, entries: readonly Entry[], more = 0): Row {
  const words = text
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== '');
  return {
    query: text,
    command: false,
    items: entries
      .filter((entry) => words.every((word) => entry.title.toLowerCase().includes(word)))
      .map((entry) => ({
        rank: entry.rank,
        row: row(entry.id, { title: entry.title, ...entry.row }),
        found: foundIn(entry.title, words),
        hiddenBy: entry.hiddenBy ?? [],
      })),
    more,
    restore: null,
  };
}

/** A payload of the command form (E12): no session listed, and `restore` the offer or null. */
function commandPayload(text: string, restore: Row | null): Row {
  return { query: text, command: true, items: [], more: 0, restore };
}

interface Config {
  sections: Sections;
  terminals?: Row[];
  /** What the switcher ranks (payloadFor's input) unless `payload` answers. */
  entries?: readonly Entry[];
  /** The switcher's payload for a text, instead of `payloadFor` over `entries`. */
  payload?: (text: string) => Row;
}

/** Every row of the sections. */
function rowsOf(sections: Sections): Row[] {
  return [...(sections.open ?? []), ...(sections.week ?? []), ...(sections.earlier ?? [])];
}

/** The text of the page's last `view` message of `sent`: its `switcher`, null while it is closed. */
function switcherText(sent: readonly Row[]): string | null {
  const view = sent.filter((message) => message['t'] === 'view').at(-1);
  const text = view?.['switcher'];
  return typeof text === 'string' ? text : null;
}

interface World {
  page: Page;
  w: EditWorld;
  /** Changes what the next lists hold and sends one (unless `send` is false). */
  set(change: Partial<Config>, send?: boolean): void;
}

/**
 * A page on an `editWorld` whose lists are `start`'s: its sections and terminals, the resume
 * card's `selected` for a selected row that is not running, and the switcher's payload for the
 * text of the page's last `view` (null while it sends none).
 */
async function world(t: TestContext, chromium: Browser, start: Config): Promise<World> {
  const page = await newPage(t, chromium);
  await page.addInitScript(ANSWERS);
  let config = start;
  let w: EditWorld | undefined;
  const listFor = (id: string | null): Row => {
    const text = switcherText(w?.sent ?? []);
    const selected = rowsOf(config.sections).find((candidate) => candidate['id'] === id);
    const payload = config.payload ?? ((x: string) => payloadFor(x, config.entries ?? []));
    return listOf(
      config.sections,
      config.terminals ?? [],
      id !== null && selected !== undefined && selected['terminal'] === null
        ? selectedOf(id)
        : null,
      text === null ? null : payload(text),
    );
  };
  const made = await editWorld(t, page, listFor);
  w = made;
  return {
    page,
    w: made,
    set(change, send = true) {
      config = { ...config, ...change };
      made.list(listFor, { send });
    },
  };
}

/** The plain rows and entries of `ORB`: three sessions that are not running. */
const ORB: [string, string][] = [
  [S3, 'plain'],
  [S1, 'orange'],
  [S2, 'orbit'],
];
const ORB_WORLD: Config = {
  sections: { week: ORB.map(([id, title]) => row(id, { title })) },
  entries: ORB.map(([id, title]) => ({ id, title, rank: 'not-running' as const })),
};

let drivenSeed = 120;

/** A scripted stand-in whose connection the test holds down, and whose answers it holds back. */
interface Driven {
  page: Page;
  sent: Row[];
  acts(): Row[];
  /** Whether the stand-in takes a connection (default yes); one made while it does not is dropped. */
  allow(on: boolean): void;
  /** While held, a `view` is recorded but not answered. */
  hold(on: boolean): void;
  /** Sends the list for the page's last view now. */
  push(): void;
  /** Ends the connection the page uses now. */
  drop(): void;
}

async function driven(t: TestContext, chromium: Browser, start: Config): Promise<Driven> {
  const secret = new Uint8Array(32).fill(drivenSeed++);
  const page = await newPage(t, chromium);
  await page.addInitScript(ANSWERS);
  const sent: Row[] = [];
  let allowed = true;
  let held = false;
  let selected: string | null = null;
  const listNow = (): Row => {
    const text = switcherText(sent);
    const candidate = rowsOf(start.sections).find((r) => r['id'] === selected);
    const payload = start.payload ?? ((x: string) => payloadFor(x, start.entries ?? []));
    return listOf(
      start.sections,
      start.terminals ?? [],
      selected !== null && candidate !== undefined && candidate['terminal'] === null
        ? selectedOf(selected)
        : null,
      text === null ? null : payload(text),
    );
  };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      before: () => (allowed ? null : 'drop'),
      open: (conn, message) => {
        sent.push(message);
        if (message['t'] === 'view') {
          selected = (message['selected'] as string | null) ?? null;
          if (!held) conn.send(listNow());
        } else if (message['t'] === 'attach') {
          const { term, cols, rows } = message as { term: string; cols: number; rows: number };
          conn.send({ t: 'snap', term, ch: 1, cols, rows, data: '' });
        }
      },
    }),
  });
  const conn = (): StandinConnection => {
    const last = standin.connections.at(-1);
    assert.ok(last !== undefined, 'the page is connected');
    return last;
  };
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  return {
    page,
    sent,
    acts: () => sent.filter((message) => message['t'] === 'act'),
    allow(on) {
      allowed = on;
    },
    hold(on) {
      held = on;
    },
    push() {
      conn().send(listNow());
    },
    drop() {
      conn().ws.terminate();
    },
  };
}

/** The stand-in resuming `sessionId` outside the window, as in another terminal (S2 7.9). */
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

/** Sessions of an earlier boot (design 7.8) in a server's sandbox: transcripts and a `start` event. */
function earlierBoot(d: ServerSandbox, ids: string[]): void {
  const first = d.platform.clock.nowNs() - 2n * HOUR;
  ids.forEach((id, index) => {
    const dir = d.resumable(id);
    const timeNs = first + BigInt(index) * SEC;
    d.deck.store.insertEvent({
      spoolName: `${timeNs}-${990_000 + index}-start-${id}.ev`,
      timeNs,
      kind: 'start',
      detail: 'startup',
      rawDetail: 'startup',
      sessionId: id,
      bootId: BOOT_C,
      pid: 990_000 + index,
      procStart: PROC_START,
      cwd: dir,
      argv: ['claude'],
      name: null,
      payload: null,
    } as never);
  });
}

// ---------------------------------------------------------------------------------------------
// Opening and typing

async function openingCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    'Ctrl+Shift+P from the terminal, from the list and from the filter field opens the panel with the keyboard in its field and the help hidden; Esc closes it and the keyboard goes back where it was; Ctrl+Shift+P again closes it; the view carries the text while shown and null once closed',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'beta work');
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      await keyboardIs(page, 'the terminal');
      assert.equal((await switcherView(page)).shown, false, 'closed to begin with');

      // From the terminal, with the help shown: the help goes, the keyboard is in the field.
      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help:not([hidden])', { state: 'attached' });
      await openSwitcher(page);
      await page.waitForSelector('#help[hidden]', { state: 'attached' });
      await until(async () => (await lastView(page))['switcher'] === '', 'a view with the text');
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await keyboardIs(page, 'the terminal');
      await until(async () => (await lastView(page))['switcher'] === null, 'a view without it');

      // From the list.
      await toZone(page, 'list');
      await keyboardIs(page, 'the list');
      await openSwitcher(page);
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await keyboardIs(page, 'the list');

      // From the filter field; the chord closes it again.
      await page.keyboard.press('/');
      await keyboardIs(page, 'the filter');
      await openSwitcher(page);
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await keyboardIs(page, 'the filter');
      await openSwitcher(page);
      await page.keyboard.press(CHORD);
      await switcherShown(page, false);
      await keyboardIs(page, 'the filter');
      await healthy(l);
    },
  );

  await t.test(
    "the title bar's `Switch…` (clicked with element.click()) opens it with the keyboard in its field and the help hidden; the key bar's hint says `Ctrl+Shift+P switch`; Esc closes it and the keyboard goes back to the list",
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      await untilRows(page, [S1], 'the session');
      assert.match(await shownText(page, '#switch-button'), /^\s*⌕\s*Switch…\s*Ctrl\+Shift\+P\s*$/);
      const hints = await readPage(
        page,
        () =>
          [...document.querySelectorAll('.keybar .hint')].map((hint) =>
            (hint.textContent ?? '').replace(/\s+/g, ' ').trim(),
          ),
        null,
      );
      assert.ok(hints.includes('Ctrl+Shift+P switch'), `the key bar's hints: ${hints.join(' | ')}`);

      await toZone(page, 'list');
      await page.keyboard.press('Control+Shift+H');
      await page.waitForSelector('#help:not([hidden])', { state: 'attached' });
      await page.evaluate(() => document.getElementById('switch-button')?.click());
      await switcherShown(page, true);
      await keyboardIs(page, FIELD);
      await page.waitForSelector('#help[hidden]', { state: 'attached' });
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await keyboardIs(page, 'the list');
      await healthy(l);
    },
  );

  await t.test(
    "typing → the items of the server's ranking, the matched parts in `mark` elements, each item's short id shown, its icon, its line and its heading; a short id's first 4 characters → its session first",
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'alpha login fix');
      session(d, S2, 3n * MIN, 'beta login');
      session(d, S3, 4n * MIN, 'alpha deploy');
      await untilRows(page, [S1, S2, S3], 'the three sessions');
      await openSwitcher(page);
      let view = await untilSwitcher(page, (v) => v.items.length === 3, 'every session listed');
      assert.deepEqual(view.headings, [{ rank: 'not-running', text: 'Not running' }]);
      assert.deepEqual(idsOf(view), [S1, S2, S3]);
      assert.deepEqual(
        view.items.map((item) => item.active),
        [true, false, false],
        'the highlight starts on the first item',
      );
      for (const item of view.items) {
        assert.equal(item.short, item.id.slice(0, 8), 'the short id');
        assert.notEqual(item.icon, '', 'the state icon');
        assert.match(item.line, /^not running · .+ · .*project/, 'the second line');
        assert.deepEqual(item.marks, [], 'nothing matched yet');
      }

      await page.keyboard.type('login');
      view = await untilAnswer(
        page,
        'login',
        (v) =>
          idsOf(v).join() === [S1, S2].join() && v.items.every((i) => i.marks.join() === 'login'),
        'the sessions whose title has login (the answer to the whole word)',
      );
      assert.deepEqual(
        view.items.map((item) => [item.title, item.marks]),
        [
          ['alpha login fix', ['login']],
          ['beta login', ['login']],
        ],
      );
      await page.keyboard.type(' alpha');
      view = await untilAnswer(page, 'login alpha', (v) => idsOf(v).join() === S1, 'both words');
      assert.deepEqual([...(view.items[0]?.marks ?? [])].sort(), ['alpha', 'login']);
      assert.equal((await lastView(page))['switcher'], 'login alpha');

      await clearField(page);
      await untilAnswer(
        page,
        '',
        (v) => v.items.length === 3 && v.items.every((i) => i.marks.length === 0),
        'all again',
      );
      await page.keyboard.type(S3.slice(0, 4));
      view = await untilAnswer(
        page,
        S3.slice(0, 4),
        (v) => v.items.length > 0 && v.items.length < 3,
        'by short id',
      );
      assert.equal(view.items[0]?.id, S3, 'its session first');
      await healthy(l);
    },
  );

  await t.test(
    'a mousedown on a heading or on the footer leaves the keyboard in the field and closes nothing; Tab and Shift+Tab stay in it; a click outside the panel closes it',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'beta work');
      await untilRows(page, [S1, S2], 'the sessions');
      await openSwitcher(page);
      await untilSwitcher(page, (v) => v.items.length === 2, 'both listed');
      await page.keyboard.type('work');

      await page.locator('#switcher .switcher-heading').first().click();
      assert.equal(await keyboardOn(page), FIELD, 'a click on a heading');
      await page.locator('#switcher .switcher-foot').click();
      assert.equal(await keyboardOn(page), FIELD, 'a click on the footer');
      await sleep(300);
      assert.equal((await switcherView(page)).shown, true, 'a click on the panel closes nothing');
      await keyboardIs(page, FIELD);

      await page.keyboard.press('Tab');
      assert.equal(await keyboardOn(page), FIELD, 'Tab');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await keyboardOn(page), FIELD, 'Shift+Tab');
      assert.equal((await switcherView(page)).value, 'work', 'and the text is as typed');

      await page.mouse.click(3, 3); // the scrim, outside the panel
      await switcherShown(page, false);
      assert.equal(await selectedRow(page), S1, 'a click outside selects nothing');
      await healthy(l);
    },
  );

  await t.test(
    '17 words typed → the footer says only the first 16 words are searched and the server got 16; a text of 16 words → the note is hidden again',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      await untilRows(page, [S1], 'the session');
      await openSwitcher(page);
      assert.equal((await switcherView(page)).cut, '', 'not cut');
      const words = Array.from({ length: 17 }, (_, i) => `w${String(i + 1).padStart(2, '0')}`);
      await page.keyboard.type(words.join(' '));
      await untilSwitcher(
        page,
        (v) => v.cut === 'only the first 16 words are searched',
        'the note that the text is cut',
      );
      await until(
        async () => (await lastView(page))['switcher'] === words.slice(0, 16).join(' '),
        'a view with the first 16 words',
      );
      for (const view of await viewsOf(page)) {
        const text = view['switcher'];
        if (typeof text === 'string') {
          assert.ok(text.split(/\s+/u).filter(Boolean).length <= 16, `a view with ${text}`);
        }
      }
      await clearField(page);
      await page.keyboard.type(words.slice(0, 16).join(' '));
      await untilSwitcher(page, (v) => v.cut === '' && v.value.split(' ').length === 16, 'no note');
      await healthy(l);
    },
  );

  await t.test(
    'a text of more than 1,024 bytes in few words → the footer says only the first 1,024 bytes are searched and the server got 1,024 bytes (ruled on review 1)',
    async (t) => {
      const d = await world(t, chromium, ORB_WORLD);
      const { page, w } = d;
      await untilSelected(page, S3);
      await openSwitcher(page);
      // 515 × `ä`: 1,030 bytes of UTF-8 in one word; the page sends the first 512 (1,024 bytes).
      await page.keyboard.insertText('ä'.repeat(515));
      await untilSwitcher(
        page,
        (v) => v.cut === 'only the first 1,024 bytes are searched',
        'the note that the text is cut to its bytes',
      );
      await until(
        () => switcherText(w.sent) === 'ä'.repeat(512),
        'a view with the first 1,024 bytes',
      );
      for (const message of w.sent) {
        const text = message['t'] === 'view' ? message['switcher'] : null;
        if (typeof text === 'string') {
          assert.ok(new TextEncoder().encode(text).length <= 1024, 'no view over 1,024 bytes');
        }
      }
      await clearField(page);
      await untilSwitcher(page, (v) => v.cut === '', 'no note for an empty text');
    },
  );

  await t.test(
    'a double click on `Switch…` opens the switcher once: its second click does not close it',
    async (t) => {
      const d = await world(t, chromium, ORB_WORLD);
      const { page } = d;
      await untilSelected(page, S3);
      await page.locator('#switch-button').dblclick();
      await switcherShown(page, true);
      await sleep(800);
      assert.equal((await switcherView(page)).shown, true, 'still shown');
      await keyboardIs(page, FIELD);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Enter on each kind of session (E10)

async function pickCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    'Enter on a session open in the window → its terminal shown with the keyboard (no new terminal, the typed text and the Enter never reach any program); the footer says `Enter switch`',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'beta work');
      const first = await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      const typedBefore = inputOf(d.record, S1);
      await clickRow(page, S2); // the selection is elsewhere, in the list

      await openSwitcher(page);
      await page.keyboard.type('alpha');
      const view = await untilAnswer(
        page,
        'alpha',
        (v) => idsOf(v).join() === S1,
        'the open session',
      );
      assert.equal(view.items[0]?.rank, 'open');
      assert.equal(view.keys, '↑ ↓ move · Enter switch · Esc close');
      await page.keyboard.press('Enter');
      assert.equal(await untilTerminalOf(page, S1), first);
      assert.equal(await shownTerm(page), first);
      await switcherShown(page, false);
      await sleep(800);
      assert.equal(inputOf(d.record, S1), typedBefore, 'nothing of it reached the program');
      assert.equal(
        l.server.hub.list().filter((info) => info.expectedSessionId === S1).length,
        1,
        'no second terminal',
      );
      assert.equal(
        (await actsOf(page)).filter((act) => act['kind'] === 'resume').length,
        1,
        'only the first resume',
      );
      await healthy(l);
    },
  );

  await t.test(
    'Enter on a session that is not running → resumed into the window (the stand-in starts, a slot is given) and its terminal takes the keyboard; the footer says `Enter resume here`; the switcher then lists it under Open with its slot',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'beta work');
      await untilRows(page, [S1, S2], 'the sessions');
      await openSwitcher(page);
      await page.keyboard.type('beta');
      const view = await untilAnswer(page, 'beta', (v) => idsOf(v).join() === S2, 'the session');
      assert.equal(view.items[0]?.rank, 'not-running');
      assert.equal(view.keys, '↑ ↓ move · Enter resume here · Esc close');
      await page.keyboard.press('Enter');
      await untilTerminalOf(page, S2);
      await untilScreen(page, promptOf(S2));
      assert.ok(
        recordsOf(d.record, S2).some((record) => record.ev === 'start'),
        'the stand-in started for S2',
      );
      assert.equal(await selectedRow(page), S2);
      await switcherShown(page, false);

      await openSwitcher(page);
      const after = await untilSwitcher(
        page,
        (v) => v.items.find((item) => item.id === S2)?.rank === 'open',
        'S2 listed under Open',
      );
      assert.deepEqual(
        after.headings.map((heading) => heading.text),
        ['Open', 'Not running'],
      );
      assert.match(after.items.find((item) => item.id === S2)?.slot ?? '', /\d/, 'a slot is given');
      await healthy(l);
    },
  );

  await t.test(
    'Enter on a session that runs elsewhere (a stand-in the test runs outside the window) → its card with its pid; nothing is resumed',
    async (t) => {
      const ends: (() => Promise<void>)[] = [];
      t.after(async () => {
        for (const end of ends) await end();
      });
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      const far = join(d.s.home, 'far');
      session(d, S2, 2n * MIN, 'beta far work', far);
      await clickRow(page, S2);
      await showsText(page, '#cards .card-command', /--resume/);
      const outside = outsideProgram(l, S2, far, ends);
      await showsText(page, '#cards .card', new RegExp(`pid ${outside.pid}\\b`));
      await clickRow(page, S1); // the selection is elsewhere

      await openSwitcher(page);
      await page.keyboard.type('beta far');
      const view = await untilAnswer(
        page,
        'beta far',
        (v) => idsOf(v).join() === S2,
        'the session',
      );
      assert.equal(view.items[0]?.rank, 'open');
      assert.equal(view.keys, '↑ ↓ move · Enter switch · Esc close');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#right-zone[data-pane="elsewhere"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await untilSelected(page, S2);
      await showsText(page, '#cards .card', new RegExp(`pid ${outside.pid}\\b`));
      await switcherShown(page, false);
      await sleep(500);
      assert.deepEqual(
        (await actsOf(page)).filter((act) => act['sessionId'] === S2),
        [],
        'nothing sent for it',
      );
      assert.deepEqual(
        l.server.hub.list().filter((info) => info.expectedSessionId === S2),
        [],
        'no terminal for it',
      );
      await healthy(l);
    },
  );

  await t.test(
    "Enter on an expired session → its card, with the server's refusal on it; no terminal",
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'gone work');
      setNote(d.deck, S2, 'attached, so that it stays listed once expired');
      await untilRows(page, [S1, S2], 'the sessions');
      rmSync(join(d.s.claudeHome, 'projects', 'project', `${S2}.jsonl`));
      await until(
        async () =>
          (await listRows(page)).find((r) => r.id === S2)?.marks.includes('expired') === true,
        'S2 marked expired',
      );

      await openSwitcher(page);
      await page.keyboard.type('gone');
      await untilAnswer(page, 'gone', (v) => idsOf(v).join() === S2, 'the expired session');
      await page.keyboard.press('Enter');
      await untilSelected(page, S2);
      await showsText(
        page,
        '#cards .card-lines',
        new RegExp(`^${S2.slice(0, 8)} has expired: its transcript is gone$`),
      );
      assert.equal(
        await page.locator('#right-zone[data-pane="resume"]').count(),
        1,
        'the resume card is what shows it',
      );
      assert.deepEqual(
        l.server.hub.list().filter((info) => info.expectedSessionId === S2),
        [],
        'no terminal',
      );
      await healthy(l);
    },
  );

  await t.test(
    'Enter on a done session → resumed, listed under Open with `done`; Show done is turned on by one view that changes only that',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'beta finished');
      markDone(d.deck, S2);
      await untilRows(page, [S1], 'the done session hidden');
      const count = (await viewsOf(page)).length;

      await openSwitcher(page);
      await page.keyboard.type('finished');
      const view = await untilAnswer(
        page,
        'finished',
        (v) => idsOf(v).join() === S2,
        'the done session',
      );
      assert.equal(view.items[0]?.rank, 'done');
      assert.deepEqual(view.headings, [{ rank: 'done', text: 'Done' }]);
      await page.keyboard.press('Enter');
      await untilTerminalOf(page, S2);
      const rows = await listRows(page);
      const listed = rows.find((r) => r.id === S2);
      assert.equal(listed?.section, 'open');
      assert.ok(listed?.marks.includes('done'), `its marks: ${listed?.marks.join()}`);
      const { baseline, views } = await viewsSince(page, count);
      assert.deepEqual(
        transitions(baseline, views).map((change) => change.field),
        ['showDone'],
        'one view, and it changes only showDone',
      );
      assert.equal((await lastView(page))['showDone'], true);
      await healthy(l);
    },
  );

  await t.test(
    'Enter on a session in a folded Earlier → Earlier unfolded by one view that changes only that, the row selected (and resumed)',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S5, 20n * DAY, 'old five');
      session(d, S6, 21n * DAY, 'old six');
      await untilRows(page, [S1], 'Earlier folded');
      const count = (await viewsOf(page)).length;

      await openSwitcher(page);
      await page.keyboard.type('old five');
      await untilAnswer(page, 'old five', (v) => idsOf(v).join() === S5, 'the old session');
      await page.keyboard.press('Enter');
      await untilTerminalOf(page, S5);
      await untilRows(page, [S5, S1, S6], 'Earlier unfolded, S5 running under Open');
      const { baseline, views } = await viewsSince(page, count);
      assert.deepEqual(
        transitions(baseline, views).map((change) => change.field),
        ['unfolded'],
        'one view, and it changes only unfolded',
      );
      assert.deepEqual((await lastView(page))['unfolded'], ['earlier']);
      await healthy(l);
    },
  );

  await t.test(
    'Enter on a session the filter hides → the filter and the chips cleared by one view, the key bar says so, the row selected (and resumed)',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'omega work');
      setNote(d.deck, S2, 'a note');
      await untilRows(page, [S1, S2], 'the sessions');
      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('omega');
      await page.keyboard.press('Enter');
      await page.locator('#list .list-chips button', { hasText: 'Has note' }).click();
      await untilRows(page, [S2], 'the filter and the chip');
      const count = (await viewsOf(page)).length;

      await openSwitcher(page);
      await page.keyboard.type('alpha');
      await untilAnswer(page, 'alpha', (v) => idsOf(v).join() === S1, 'the hidden session');
      await page.keyboard.press('Enter');
      await untilTerminalOf(page, S1);
      await showsText(
        page,
        '#key-message',
        new RegExp(`^the filter was cleared to show ${S1.slice(0, 8)}$`),
      );
      assert.equal(await page.inputValue('#list input.list-filter'), '');
      assert.deepEqual(
        await page
          .locator('#list .list-chips button')
          .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-pressed'))),
        ['false', 'false', 'false', 'false'],
        'no chip pressed',
      );
      await untilRows(page, [S1, S2], 'both listed');
      const { baseline, views } = await viewsSince(page, count);
      const changed = transitions(baseline, views);
      assert.deepEqual(
        changed.map((change) => change.field).sort(),
        ['chips', 'filter'],
        'only the filter and the chips changed',
      );
      assert.equal(changed[0]?.at, changed[1]?.at, 'in one view');
      await healthy(l);
    },
  );

  await t.test(
    'a click on an item does what Enter does: a session that is not running is resumed and its terminal takes the keyboard',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'beta work');
      await untilRows(page, [S1, S2], 'the sessions');
      await openSwitcher(page);
      await untilSwitcher(page, (v) => v.items.length === 2, 'both listed');
      await page.locator(`#switcher [data-id="${S2}"]`).click();
      await untilTerminalOf(page, S2);
      await switcherShown(page, false);
      assert.ok(recordsOf(d.record, S2).some((record) => record.ev === 'start'));
      assert.deepEqual(
        recordsOf(d.record, S1).filter((record) => record.ev === 'start'),
        [],
        'S1 was not started',
      );
      await healthy(l);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Scripted: what a pick, the highlight and the footer do with payloads no real server needs to make

/** Session `n` (1–99): a session id that is not one of the shared ones. */
function sid(n: number): string {
  return `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
}

/** The `view` messages among `sent`, and the first `count` of them left out. */
function viewsAfter(sent: readonly Row[], count: number): { baseline: Row; views: Row[] } {
  const all = sent.filter((message) => message['t'] === 'view');
  const baseline = all[count - 1];
  assert.ok(baseline !== undefined, 'a view before');
  return { baseline, views: all.slice(count) };
}

async function scriptedPickCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    'a double click on an item picks once: its second click acts on nothing under it, neither the list row nor the card beneath',
    async (t) => {
      const ids = [S1, S2, S3, S4, S5, S6];
      const d = await world(t, chromium, {
        sections: { week: ids.map((id, i) => row(id, { title: `session ${i + 1}` })) },
        entries: ids.map((id, i) => ({ id, title: `session ${i + 1}`, rank: 'not-running' })),
      });
      const { page, w } = d;
      await page.setViewportSize({ width: 760, height: 720 }); // the panel lies over the list
      await untilSelected(page, S1);
      // What every click of the page lands on, for the second click of each double click.
      await page.evaluate(() => {
        const clicks: unknown[] = [];
        Reflect.set(globalThis, 'clicks', clicks);
        addEventListener(
          'click',
          (event) => {
            const target = event.target instanceof Element ? event.target : null;
            clicks.push({
              detail: event.detail,
              row: target?.closest('#list [data-id]')?.getAttribute('data-id') ?? null,
              cards: target?.closest('#cards') !== null,
              switcher: target?.closest('#switcher') !== null,
            });
          },
          true,
        );
      });
      let beneath = 0;
      for (const id of ids) {
        const before = w.acts().length;
        await openSwitcher(page);
        await untilSwitcher(page, (v) => v.items.length === ids.length, 'every session listed');
        const box = await page.locator(`#switcher [data-id="${id}"]`).boundingBox();
        assert.ok(box !== null);
        await page.mouse.dblclick(box.x + 12, box.y + box.height / 2);
        await switcherShown(page, false);
        await sleep(400);
        const acts = w.acts().slice(before);
        assert.deepEqual(
          acts.map((act) => [act['kind'], act['sessionId']]),
          [['resume', id]],
          `one resume, for ${id}`,
        );
        assert.equal(w.selected(), id, 'the selection stays on the picked session');
        const clicks = await readPage(
          page,
          () => {
            const all = Reflect.get(globalThis, 'clicks') as Record<string, unknown>[];
            return all.splice(0, all.length);
          },
          null,
        );
        // The second click acted on nothing: none of its events reached the page (the switcher
        // takes them before any listener of the page, a recorder of the test's included).
        assert.deepEqual(
          clicks.filter((click) => click['detail'] === 2 && click['switcher'] === false),
          [],
          `no second click reached the page for ${id}`,
        );
        // What lay under the item once the switcher closed: a row of another session, or a card.
        const under = await page.evaluate(
          ([x, y]) => {
            const target = document.elementFromPoint(x as number, y as number);
            return {
              row: target?.closest('#list [data-id]')?.getAttribute('data-id') ?? null,
              cards: target?.closest('#cards') != null,
              switcher: target?.closest('#switcher') != null,
            };
          },
          [box.x + 12, box.y + box.height / 2],
        );
        if (!under.switcher && ((under.row !== null && under.row !== id) || under.cards)) {
          beneath++;
        }
      }
      assert.ok(
        beneath > 0,
        'no second click landed on a list row or a card: the case proves nothing at this layout',
      );
    },
  );

  await t.test(
    'Enter held on `Switch…` opens the switcher and picks nothing: its repeats in the field act on no item, and none reaches the list (review 2, S1)',
    async (t) => {
      const d = await world(t, chromium, ORB_WORLD);
      const { page, w } = d;
      await untilSelected(page, S3);
      await page.focus('#switch-button');
      await page.keyboard.down('Enter'); // opens the switcher (the button's click)
      await switcherShown(page, true);
      await untilAnswer(page, '', (v) => v.items.length === ORB.length, 'every session listed');
      for (let i = 0; i < 3; i++) {
        await page.keyboard.down('Enter'); // auto-repeats, in the switcher's field
      }
      await page.keyboard.up('Enter');
      await sleep(400);
      assert.deepEqual(w.acts(), [], 'no pick, no resume');
      assert.equal((await switcherView(page)).shown, true, 'the switcher stays');
      assert.equal(await selectedRow(page), S3, 'the selection where it was');
      assert.equal(await keyboardOn(page), FIELD);
    },
  );

  await t.test(
    'the highlight goes to the first item for the answer to another text, also when the highlighted session is in it: ↓ ↓ on `orbit`, then `or` → `orange` highlighted, Enter resumes it (review 2, S2)',
    async (t) => {
      const d = await world(t, chromium, ORB_WORLD);
      const { page, w } = d;
      await untilSelected(page, S3);
      await openSwitcher(page);
      await untilAnswer(page, '', (v) => v.items.length === ORB.length, 'every session listed');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await untilSwitcher(
        page,
        (v) => v.items.find((item) => item.active)?.id === S2,
        'the highlight on orbit',
      );
      await page.keyboard.type('or');
      const view = await untilAnswer(
        page,
        'or',
        (v) => idsOf(v).join() === [S1, S2].join(),
        'the answer to or: orange, orbit',
      );
      assert.deepEqual(
        view.items.map((item) => item.active),
        [true, false],
        'the first item is highlighted',
      );
      await page.keyboard.press('Enter');
      const act = await w.act(1);
      assert.deepEqual([act['kind'], act['sessionId']], ['resume', S1]);
    },
  );

  await t.test(
    'opened from the filter field, a pick of a session without a terminal puts the keyboard on the list, where Enter on its row would: a session elsewhere, and one not running whose resume is refused (review 2, S4)',
    async (t) => {
      const d = await world(t, chromium, {
        sections: {
          week: [
            row(S3, { title: 'plain' }),
            row(S1, {
              title: 'far away',
              state: 'running',
              elsewhere: { pid: 77, tty: null, dir: null },
            }),
            row(S2, { title: 'resting' }),
          ],
        },
        entries: [
          {
            id: S1,
            title: 'far away',
            rank: 'open',
            row: { state: 'running', elsewhere: { pid: 77, tty: null, dir: null } },
          },
          { id: S2, title: 'resting', rank: 'not-running' },
        ],
      });
      const { page, w } = d;
      await untilSelected(page, S3);
      for (const [id, text] of [
        [S1, 'far'],
        [S2, 'resting'],
      ] as const) {
        await toZone(page, 'list');
        await page.keyboard.press('/');
        await keyboardIs(page, 'the filter');
        await openSwitcher(page);
        await page.keyboard.type(text);
        await untilAnswer(page, text, (v) => idsOf(v).join() === id, `the answer to ${text}`);
        await page.keyboard.press('Enter');
        await switcherShown(page, false);
        await untilSelected(page, id);
        await keyboardIs(page, 'the list');
        if (id === S2) {
          const act = await w.act(1);
          assert.deepEqual([act['kind'], act['sessionId']], ['resume', S2]);
          w.answer(act, { ok: false, error: 'resting cannot be resumed' });
          await showsText(page, '#cards', /resting cannot be resumed/);
          await keyboardIs(page, 'the list');
        }
        await page.keyboard.type('j');
        assert.equal(await page.inputValue('#list input.list-filter'), '', 'the filter holds no j');
      }
    },
  );

  await t.test(
    'the footer says what Enter sends: a running session with no terminal of the window and not elsewhere → `Enter resume here`, and Enter sends its resume (one rule for both, ruled on review 2, C1)',
    async (t) => {
      const lost = { state: 'running', terminal: null, elsewhere: null };
      const d = await world(t, chromium, {
        sections: { open: [row(S1, { title: 'lost keeper', ...lost })] },
        entries: [{ id: S1, title: 'lost keeper', rank: 'open', row: lost }],
      });
      const { page, w } = d;
      await untilSelected(page, S1);
      await openSwitcher(page);
      const view = await untilAnswer(page, '', (v) => idsOf(v).join() === S1, 'the session');
      assert.equal(view.keys, '↑ ↓ move · Enter resume here · Esc close');
      await page.keyboard.press('Enter');
      const act = await w.act(1);
      assert.deepEqual([act['kind'], act['sessionId']], ['resume', S1]);
    },
  );

  await t.test(
    'a refused resume of a picked session the list does not show is said in the key bar (ruled on review 2, C2)',
    async (t) => {
      const d = await world(t, chromium, {
        ...ORB_WORLD,
        entries: [{ id: S4, title: 'went away', rank: 'not-running' }],
      });
      const { page, w } = d;
      await untilSelected(page, S3);
      await openSwitcher(page);
      await untilAnswer(page, '', (v) => idsOf(v).join() === S4, 'the session');
      await page.keyboard.press('Enter');
      const act = await w.act(1);
      assert.deepEqual([act['kind'], act['sessionId']], ['resume', S4]);
      w.answer(act, { ok: false, error: 'no session went away here' });
      await showsText(page, '#key-message', /^no session went away here$/);
    },
  );

  await t.test(
    "an `input` that comes after the switcher closed (an IME's, after the blur) sends no text: the next view is the reopened switcher's empty one (ruled on review 2, C3)",
    async (t) => {
      const d = await world(t, chromium, ORB_WORLD);
      const { page, w } = d;
      await untilSelected(page, S3);
      await openSwitcher(page);
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await page.evaluate(() => {
        const field = document.querySelector('#switcher input.switcher-field');
        if (!(field instanceof HTMLInputElement)) throw new Error('no switcher field');
        field.value = 'latemark';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      // The page's messages arrive in order: the reopened switcher's view comes after anything
      // that late `input` could have sent.
      const before = w.sent.length;
      await openSwitcher(page);
      await until(
        () => w.sent.slice(before).some((m) => m['t'] === 'view' && m['switcher'] === ''),
        "the reopened switcher's view",
      );
      assert.deepEqual(
        w.sent.filter((m) => m['t'] === 'view' && m['switcher'] === 'latemark'),
        [],
        'no view with the late text',
      );
    },
  );

  await t.test(
    'the click guard lets go again: after a pick by a click, and after a click outside closed the switcher, a later double click on a row of the list resumes it (ruled on review 1)',
    async (t) => {
      const d = await world(t, chromium, ORB_WORLD);
      const { page, w } = d;
      await untilSelected(page, S3);
      /** A double click on the list's row of `id`: its resume is the page's next act. */
      const resumesByDoubleClick = async (id: string, what: string): Promise<void> => {
        const before = w.acts().length;
        await page.locator(`#list [data-id="${id}"]`).dblclick();
        const act = await w.act(before + 1);
        assert.deepEqual([act['kind'], act['sessionId']], ['resume', id], what);
      };

      // After a pick by a click on an item (the guard's sequence began in the switcher).
      await openSwitcher(page);
      await untilSwitcher(page, (v) => v.items.length === ORB.length, 'every session listed');
      await page.locator(`#switcher [data-id="${S1}"]`).click();
      await switcherShown(page, false);
      const picked = await w.act(1);
      assert.deepEqual([picked['kind'], picked['sessionId']], ['resume', S1]);
      await resumesByDoubleClick(S2, 'a double click after a pick');

      // After a click outside the panel closed the switcher.
      await openSwitcher(page);
      await page.mouse.click(8, 400); // on the scrim, outside the panel
      await switcherShown(page, false);
      await resumesByDoubleClick(S3, 'a double click after a close');
    },
  );

  await t.test(
    'a click on the restore offer sends nothing and the switcher stays; Enter on it restores (E12: Enter only, ruled on review 1)',
    async (t) => {
      const lastActivityNs = String(BigInt(Date.now() - 3_600_000) * 1_000_000n);
      const restore: Row = { count: 2, lastActivityNs, sessionIds: [S1, S2] };
      const d = await world(t, chromium, {
        ...ORB_WORLD,
        payload: (text) =>
          text.startsWith('>')
            ? commandPayload(text, restore)
            : payloadFor(text, ORB_WORLD.entries ?? []),
      });
      const { page, w } = d;
      await untilSelected(page, S3);
      await openSwitcher(page);
      await page.keyboard.type('>restore');
      await untilAnswer(page, '>restore', (v) => v.offer !== null, 'the offer');
      await page.locator('#switcher [data-offer]').click();
      await sleep(400);
      assert.deepEqual(w.acts(), [], 'a click on the offer sends nothing');
      assert.equal((await switcherView(page)).shown, true, 'the switcher stays');
      assert.equal(await keyboardOn(page), FIELD, 'the keyboard stays in the field');
      assert.equal(
        await page.evaluate(
          () =>
            getComputedStyle(document.querySelector('#switcher [data-offer]') as Element).cursor,
        ),
        'default',
        'the offer shows no pointer',
      );
      await page.keyboard.press('Enter');
      const act = await w.act(1);
      assert.deepEqual([act['kind'], act['sessionIds']], ['restore', [S1, S2]]);
    },
  );

  await t.test(
    "a pick of a row in a folded Earlier when the page has already unfolded it (the list in flight said folded) sends no view that changes `unfolded`, nor anything else of the list's",
    async (t) => {
      const d = await world(t, chromium, {
        sections: {
          week: [row(S3, { title: 'plain' })],
          earlier: [row(S1, { title: 'old orange' })],
          earlierFolded: true,
        },
        entries: [{ id: S1, title: 'old orange', rank: 'not-running', hiddenBy: ['folded'] }],
      });
      const { page, w } = d;
      await untilSelected(page, S3);
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await until(
        () =>
          w.sent.some(
            (message) =>
              message['t'] === 'view' && JSON.stringify(message['unfolded']) === '["earlier"]',
          ),
        'the page unfolds Earlier',
      );
      const count = w.sent.filter((message) => message['t'] === 'view').length;
      await openSwitcher(page);
      await page.keyboard.type('old');
      await untilAnswer(page, 'old', (v) => idsOf(v).join() === S1, 'the old session');
      await page.keyboard.press('Enter');
      const act = await w.act(1);
      assert.deepEqual([act['kind'], act['sessionId']], ['resume', S1]);
      await until(() => w.selected() === S1, 'the pick selects S1');
      const { baseline, views } = viewsAfter(w.sent, count);
      assert.deepEqual(transitions(baseline, views), [], 'the list changed nothing');
    },
  );

  await t.test(
    '`Enter switch` for a session open or elsewhere and `Enter resume here` for one that is not running, as the highlight moves; `<n> more: type to narrow` follows when sessions were left out',
    async (t) => {
      const d = await world(t, chromium, {
        sections: {
          open: [
            running(S1, TERM_A, 1, { title: 'running one' }),
            row(S3, {
              title: 'elsewhere one',
              state: 'running',
              elsewhere: { pid: 77, tty: null, dir: null },
            }),
          ],
          week: [row(S2, { title: 'idle one' })],
        },
        terminals: [terminal(TERM_A, S1, 1)],
        payload: (text) => ({
          ...payloadFor(text, [
            { id: S1, title: 'running one', rank: 'open', row: running(S1, TERM_A, 1) },
            {
              id: S3,
              title: 'elsewhere one',
              rank: 'open',
              row: { state: 'running', elsewhere: { pid: 77, tty: null, dir: null } },
            },
            { id: S2, title: 'idle one', rank: 'not-running' },
          ]),
          more: 7,
        }),
      });
      const { page } = d;
      await untilSelected(page, S1);
      await openSwitcher(page);
      const view = await untilSwitcher(page, (v) => v.items.length === 3, 'three items');
      assert.deepEqual(idsOf(view), [S1, S3, S2]);
      assert.deepEqual(
        view.headings.map((heading) => heading.text),
        ['Open', 'Not running'],
      );
      const keys = (action: string): string =>
        `↑ ↓ move · Enter ${action} · Esc close · 7 more: type to narrow`;
      const active = async (): Promise<string> =>
        (await switcherView(page)).items.find((item) => item.active)?.id ?? '';
      assert.equal(view.keys, keys('switch'));
      assert.equal(await active(), S1);

      await page.keyboard.press('ArrowDown');
      await untilSwitcher(page, (v) => v.items[1]?.active === true, 'the elsewhere one');
      assert.equal((await switcherView(page)).keys, keys('switch'));
      await page.keyboard.press('ArrowDown');
      await untilSwitcher(page, (v) => v.items[2]?.active === true, 'the idle one');
      assert.equal((await switcherView(page)).keys, keys('resume here'));
      await page.keyboard.press('ArrowUp');
      await untilSwitcher(page, (v) => v.items[1]?.active === true, 'back to the elsewhere one');
      await page.keyboard.press('PageDown');
      await untilSwitcher(page, (v) => v.items[2]?.active === true, 'a page down: the last one');
      await page.keyboard.press('PageUp');
      await untilSwitcher(page, (v) => v.items[0]?.active === true, 'a page up: the first one');
    },
  );

  await t.test(
    'the highlight follows ↑ ↓ at each repeat of a held key, stays on its session when a list arrives that reorders the items, and is scrolled into view',
    async (t) => {
      const ids = Array.from({ length: 40 }, (_, i) => sid(i + 10));
      const entries = (order: string[]): Entry[] =>
        order.map((id) => ({ id, title: `item ${id.slice(0, 8)}`, rank: 'not-running' }));
      const d = await world(t, chromium, {
        sections: { week: ids.map((id) => row(id, { title: `item ${id.slice(0, 8)}` })) },
        entries: entries(ids),
      });
      const { page } = d;
      await openSwitcher(page);
      await untilSwitcher(page, (v) => v.items.length === 40, 'forty items');
      const activeAt = async (): Promise<number> =>
        (await switcherView(page)).items.findIndex((item) => item.active);

      await page.keyboard.down('ArrowDown');
      await page.keyboard.down('ArrowDown'); // held: an auto-repeat
      await page.keyboard.down('ArrowDown');
      await page.keyboard.up('ArrowDown');
      await until(async () => (await activeAt()) === 3, 'a held ↓ acts at each repeat');
      for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
      await until(async () => (await activeAt()) === 33, 'thirty more');
      const inView = await page.evaluate(() => {
        const item = document.querySelector('#switcher [data-active="true"]');
        const list = document.querySelector('#switcher .switcher-list');
        if (item === null || list === null) return false;
        const a = item.getBoundingClientRect();
        const b = list.getBoundingClientRect();
        return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
      });
      assert.equal(inView, true, 'the highlighted item is scrolled into view');

      // A list that reorders the items: the highlight stays on the same session.
      const kept = ids[33];
      assert.ok(kept !== undefined);
      d.set({ entries: entries([...ids].reverse()) });
      await untilSwitcher(
        page,
        (v) => v.items[0]?.id === ids[39] && v.items.find((item) => item.active)?.id === kept,
        'the highlight stays on its session',
      );
    },
  );

  await t.test(
    'the page decides the command form from `switcher.command`, never from the text: a payload that says so lists no session and shows a line of its own without an offer; another text lists what the payload lists',
    async (t) => {
      const entries: Entry[] = [
        { id: S1, title: '>go there', rank: 'not-running' },
        { id: S2, title: 'plain', rank: 'not-running' },
      ];
      const d = await world(t, chromium, {
        sections: { week: [row(S1, { title: '>go there' }), row(S2, { title: 'plain' })] },
        entries,
        payload: (text) =>
          text.startsWith('>x') || text === 'plain'
            ? commandPayload(text, null)
            : payloadFor(text, entries),
      });
      const { page } = d;
      await openSwitcher(page);
      await page.keyboard.type('zzz');
      let view = await untilAnswer(page, 'zzz', (v) => v.empty !== '', 'nothing matches');
      assert.equal(view.empty, 'No session matches.');
      assert.deepEqual(view.items, []);

      for (const text of ['>x', 'plain']) {
        await clearField(page);
        await page.keyboard.type(text);
        view = await untilAnswer(
          page,
          text,
          (v) => v.empty !== '' && v.empty !== 'No session matches.',
          `${text}: a line of its own`,
        );
        assert.deepEqual(view.items, [], `${text}: no session listed`);
        assert.equal(view.offer, null, `${text}: no offer`);
      }

      await clearField(page);
      await page.keyboard.type('>go');
      view = await untilAnswer(
        page,
        '>go',
        (v) => idsOf(v).join() === S1,
        '>go: the payload lists it',
      );
      assert.equal(view.empty, '');
    },
  );
}

// ---------------------------------------------------------------------------------------------
// The query: a pick acts only on the list for the text last sent (E10)

async function queryCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    '`or` answered, `orb` typed and Enter while the answer for `orb` is held → nothing is picked; a click on an item of the list for `or` meanwhile does nothing; when the answer comes, its first item is picked',
    async (t) => {
      const d = await world(t, chromium, ORB_WORLD);
      const { page, w } = d;
      await untilSelected(page, S3);
      await openSwitcher(page);
      await page.keyboard.type('or');
      await untilAnswer(
        page,
        'or',
        (v) => idsOf(v).join() === [S1, S2].join() && v.items.every((i) => i.marks.join() === 'or'),
        'the list for or',
      );

      w.holdViews(true);
      await page.keyboard.type('b');
      await until(() => switcherText(w.sent) === 'orb', 'the view for orb sent');
      await page.keyboard.press('Enter'); // kept: the list for orb has not come
      await page.locator(`#switcher [data-id="${S1}"]`).click(); // an item of the list for or
      await sleep(800);
      assert.deepEqual(w.acts(), [], 'nothing picked');
      assert.equal(w.selected(), S3, 'the selection did not move');
      assert.equal((await switcherView(page)).shown, true, 'the switcher is still open');

      w.holdViews(false);
      d.set({}); // the answer for orb comes
      const act = await w.act(1);
      assert.deepEqual([act['kind'], act['sessionId']], ['resume', S2], 'its first item');
      await switcherShown(page, false);
      await until(() => w.selected() === S2, 'S2 selected');
      assert.equal(w.acts().length, 1, 'picked once');
    },
  );

  await t.test(
    'a kept Enter is dropped when the text changes, when the switcher closes or when the connection is lost; Enter while the page is not connected does nothing and is not kept; an Enter on a list that is current picks',
    async (t) => {
      const d = await driven(t, chromium, ORB_WORLD);
      const { page } = d;
      await untilSelected(page, S3);
      const quiet = async (what: string): Promise<void> => {
        await sleep(800);
        assert.deepEqual(d.acts(), [], what);
      };

      // The text changes after the Enter was kept.
      await openSwitcher(page);
      await page.keyboard.type('or');
      await untilAnswer(page, 'or', (v) => idsOf(v).join() === [S1, S2].join(), 'the list for or');
      d.hold(true);
      await page.keyboard.type('b');
      await until(() => switcherText(d.sent) === 'orb', 'the view for orb sent');
      await page.keyboard.press('Enter');
      await page.keyboard.type('i');
      await until(() => switcherText(d.sent) === 'orbi', 'the view for orbi sent');
      d.hold(false);
      d.push();
      await untilSwitcher(
        page,
        (v) => idsOf(v).join() === S2 && v.items[0]?.marks.join() === 'orbi',
        'the list for orbi',
      );
      await quiet('the text changed: the Enter was dropped');

      // The switcher closes after the Enter was kept, and is opened again.
      await clearField(page);
      d.hold(true);
      await page.keyboard.type('orb');
      await until(() => switcherText(d.sent) === 'orb', 'the view for orb sent again');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await openSwitcher(page);
      await until(
        () => d.sent.filter((m) => m['t'] === 'view').at(-1)?.['switcher'] === '',
        'the view of the reopened switcher',
      );
      d.hold(false);
      d.push();
      await untilSwitcher(page, (v) => v.items.length > 0, 'a list for the reopened switcher');
      await quiet('the switcher closed: the Enter was dropped');

      // The connection is lost after the Enter was kept.
      await clearField(page);
      d.hold(true);
      await page.keyboard.type('orb');
      await until(() => switcherText(d.sent) === 'orb', 'the view for orb sent a third time');
      await page.keyboard.press('Enter');
      d.allow(false);
      d.drop();
      await connection(page, 'lost');
      await untilSwitcher(
        page,
        (v) => v.empty === NOT_CONNECTED,
        'the switcher says it is not connected',
      );
      d.allow(true);
      d.hold(false);
      await connection(page, 'open');
      d.push();
      await untilSwitcher(page, (v) => idsOf(v).join() === S2, 'the list for orb, again');
      await quiet('the connection was lost: the Enter was dropped');

      // Not connected when Enter is pressed: nothing happens and nothing waits for the connection.
      d.allow(false);
      d.drop();
      await connection(page, 'lost');
      await untilSwitcher(
        page,
        (v) => v.empty === NOT_CONNECTED && v.items.length === 0,
        'not connected',
      );
      await page.keyboard.press('Enter');
      await sleep(300);
      d.allow(true);
      await connection(page, 'open');
      d.push();
      await untilSwitcher(page, (v) => idsOf(v).join() === S2, 'the list, once connected');
      await quiet('Enter while not connected was not kept');

      // And an Enter on a list that is current does pick (the page was able to act all along).
      await page.keyboard.press('Enter');
      await until(() => d.acts().length === 1, 'the Enter of a current list picks');
      assert.deepEqual([d.acts()[0]?.['kind'], d.acts()[0]?.['sessionId']], ['resume', S2]);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// The modal rule (E11)

/** S1 runs in the window; S2 and S3 are not running; the switcher ranks all three. */
const MODAL: Config = {
  sections: {
    open: [running(S1, TERM_A, 1, { title: 'running one' })],
    week: [row(S2, { title: 'second one' }), row(S3, { title: 'third one' })],
  },
  terminals: [terminal(TERM_A, S1, 1)],
  entries: [
    { id: S1, title: 'running one', rank: 'open', row: running(S1, TERM_A, 1) },
    { id: S2, title: 'second one', rank: 'not-running' },
    { id: S3, title: 'third one', rank: 'not-running' },
  ],
};

/** The `input` messages the page sent to a program, from `w.sent`. */
function inputs(w: EditWorld): Row[] {
  return w.sent.filter((message) => message['t'] === 'input');
}

/** Waits until the resume card of `id` has come (its list carried `selected`). */
async function cardOf(page: Page, id: string): Promise<void> {
  await showsText(page, '#cards', new RegExp(`--resume ${id}`));
}

async function modalCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    "Enter on a session that is not running, then Ctrl+Shift+P at once and typing: every character is in the switcher's field and the page sends no `input`; the resume's answer and list move the keyboard nowhere; `j`, `d` and `/` are text; the resume's terminal takes the keyboard when the switcher closes",
    async (t) => {
      const d = await world(t, chromium, MODAL);
      const { page, w } = d;
      await clickRow(page, S2);
      await cardOf(page, S2);
      await page.keyboard.press('Enter');
      const resume = await w.act(1);
      assert.deepEqual([resume['kind'], resume['sessionId']], ['resume', S2]);
      await openSwitcher(page);
      await page.keyboard.type('jd/ x');
      await sleep(500); // the resume takes its time
      const running2 = running(S2, TERM_B, 2, { title: 'second one' });
      d.set({
        sections: {
          open: [running(S1, TERM_A, 1, { title: 'running one' }), running2],
          week: [row(S3, { title: 'third one' })],
        },
        terminals: [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2)],
      });
      w.answer(resume, { ok: true, sessionId: S2 });
      await until(async () => (await shownTerm(page)) === TERM_B, "the resume's terminal shown");
      await sleep(500);
      assert.equal(await keyboardOn(page), FIELD, 'the keyboard moved nowhere');
      await page.keyboard.type('abc');
      assert.equal((await switcherView(page)).value, 'jd/ xabc', 'every character is text');
      assert.deepEqual(inputs(w), [], 'nothing reached a program');
      assert.deepEqual(
        w.acts().map((act) => act['kind']),
        ['resume'],
        'the `d` was text: no done',
      );
      assert.equal(await page.locator('#list input.list-filter:focus').count(), 0, 'no filter');

      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await terminalHasKeyboard(page);
      assert.equal(await shownTerm(page), TERM_B);
    },
  );

  await t.test(
    'while shown, Ctrl+Shift+1, Ctrl+Shift+L, Ctrl+Shift+H and Ctrl+Shift+N say `close the switcher first (Esc)` and change nothing; Esc closes it',
    async (t) => {
      const d = await world(t, chromium, MODAL);
      const { page } = d;
      await clickRow(page, S2);
      await cardOf(page, S2);
      await openSwitcher(page);
      for (const chord of [
        'Control+Shift+Digit1',
        'Control+Shift+L',
        'Control+Shift+H',
        'Control+Shift+N',
      ]) {
        await page.keyboard.press(chord);
        await showsText(page, '#key-message', CLOSE_FIRST);
        await clearMessage(page);
        assert.equal(await selectedRow(page), S2, chord);
        assert.equal(await zone(page), 'Focus: list', chord);
        assert.equal(await keyboardOn(page), FIELD, chord);
        assert.equal((await switcherView(page)).shown, true, chord);
        assert.equal(await page.locator('#help:not([hidden])').count(), 0, `${chord}: no help`);
        assert.equal(
          await page.locator('#right-zone[data-pane="resume"]').count(),
          1,
          `${chord}: the pane did not change`,
        );
      }
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await keyboardIs(page, 'the list');
    },
  );

  await t.test(
    'a held Enter picks once: a session that is not running is resumed once; a session open in the window is shown and none of the repeats reaches its program, the next press does',
    async (t) => {
      const d = await world(t, chromium, MODAL);
      const { page, w } = d;
      await untilSelected(page, S1);
      await openSwitcher(page);
      await page.keyboard.type('second');
      await untilAnswer(page, 'second', (v) => idsOf(v).join() === S2, 'the idle session');
      await page.keyboard.down('Enter'); // picks
      await page.keyboard.down('Enter'); // held: an auto-repeat
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await switcherShown(page, false);
      await sleep(800);
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['sessionId']]),
        [['resume', S2]],
        'one resume',
      );

      await openSwitcher(page);
      await page.keyboard.type('running');
      await untilAnswer(page, 'running', (v) => idsOf(v).join() === S1, 'the open session');
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await terminalHasKeyboard(page);
      await sleep(800);
      assert.deepEqual(inputs(w), [], 'no repeat of the Enter reached the program');
      await page.keyboard.press('Enter'); // the next press does
      await until(() => inputs(w).length === 1, 'the next Enter reaches the program');
      assert.equal(inputs(w)[0]?.['data'], '\r');
    },
  );

  await t.test(
    'a held Esc that closes the switcher over a running terminal sends the program nothing; the next press does (stage A held-key rule)',
    async (t) => {
      const d = await world(t, chromium, MODAL);
      const { page, w } = d;
      await untilSelected(page, S1);
      await toZone(page, 'terminal');
      await terminalHasKeyboard(page);
      await openSwitcher(page);
      await page.keyboard.down('Escape'); // closes it
      await page.keyboard.down('Escape'); // held: an auto-repeat
      await page.keyboard.down('Escape');
      await page.keyboard.up('Escape');
      await switcherShown(page, false);
      await terminalHasKeyboard(page);
      await sleep(800);
      assert.deepEqual(inputs(w), [], 'no repeat of the Esc reached the program');
      await page.keyboard.press('Escape');
      await until(() => inputs(w).length === 1, 'the next Esc reaches the program');
      assert.equal(inputs(w)[0]?.['data'], '\x1b');
    },
  );

  await t.test(
    'Esc while the New form is open closes the switcher only: the form stays and its field has the keyboard again',
    async (t) => {
      const d = await world(t, chromium, MODAL);
      const { page } = d;
      await clickRow(page, S2);
      await cardOf(page, S2);
      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await until(async () => (await keyboardOn(page)).startsWith('the cards:'), 'the form has it');
      const before = await keyboardOn(page);
      await openSwitcher(page);
      await page.keyboard.type('x');
      await page.keyboard.press('Escape');
      await switcherShown(page, false);
      await keyboardIs(page, before);
      assert.equal(
        await page.locator('#right-zone[data-pane="new"]').count(),
        1,
        'the form is still open',
      );
    },
  );

  await t.test(
    'with stage D: Ctrl+Shift+P and a click on `Switch…` while a dialog is shown say `close the edit first (Esc)` and open nothing; once it is closed the chord opens the switcher',
    async (t) => {
      const d = await world(t, chromium, MODAL);
      const { page } = d;
      await clickRow(page, S2);
      await cardOf(page, S2);
      await page.keyboard.press('l');
      await page.waitForSelector('#editor:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await page.keyboard.press(CHORD);
      await showsText(page, '#key-message', /^close the edit first \(Esc\)$/);
      assert.equal((await switcherView(page)).shown, false, 'the chord opened nothing');
      await clearMessage(page);
      await page.evaluate(() => document.getElementById('switch-button')?.click());
      await showsText(page, '#key-message', /^close the edit first \(Esc\)$/);
      assert.equal((await switcherView(page)).shown, false, 'the click opened nothing');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#editor[hidden]', { state: 'attached', timeout: PAGE_WAIT_MS });
      await openSwitcher(page);
    },
  );

  await t.test(
    "with stage D: a toast shown when the switcher opens lies under the panel and over the scrim: at an item's centre `elementFromPoint` is the item, and the toast's Undo can be clicked",
    async (t) => {
      const d = await world(t, chromium, MODAL);
      const { page, w } = d;
      await clickRow(page, S2);
      await cardOf(page, S2);
      /** What lies on top where: one read, because the toast stays 5 s. Null when it is gone. */
      const measure = (): Promise<{
        items: number;
        itemsOnTop: boolean;
        undoOnTop: boolean;
        undoAt: { x: number; y: number };
        panelOverToast: boolean | null;
      } | null> =>
        page.evaluate(() => {
          const toast = document.getElementById('toast');
          const undo = toast?.querySelector('.toast-undo');
          const panel = document.querySelector('#switcher .switcher-panel');
          if (
            !(toast instanceof HTMLElement) ||
            toast.hidden ||
            !(undo instanceof HTMLElement) ||
            !(panel instanceof HTMLElement)
          ) {
            return null;
          }
          const centre = (element: Element): { x: number; y: number } => {
            const r = element.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          };
          const top = (at: { x: number; y: number }): Element | null =>
            document.elementFromPoint(at.x, at.y);
          const items = [...document.querySelectorAll('#switcher [data-id]')];
          const a = toast.getBoundingClientRect();
          const b = panel.getBoundingClientRect();
          const left = Math.max(a.left, b.left);
          const right = Math.min(a.right, b.right);
          const upper = Math.max(a.top, b.top);
          const lower = Math.min(a.bottom, b.bottom);
          const shared =
            right > left && lower > upper
              ? top({ x: (left + right) / 2, y: (upper + lower) / 2 })
              : undefined;
          const undoAt = centre(undo);
          const undoTop = top(undoAt);
          return {
            items: items.length,
            itemsOnTop: items.every((item) => {
              const found = top(centre(item));
              return found !== null && item.contains(found);
            }),
            undoOnTop: undoTop !== null && undo.contains(undoTop),
            undoAt,
            panelOverToast: shared === undefined ? null : shared !== null && panel.contains(shared),
          };
        });

      for (let attempt = 1; attempt <= 4; attempt++) {
        const n = w.acts().length + 1;
        await page.keyboard.press('d');
        const done = await w.act(n);
        assert.equal(done['kind'], 'done');
        w.answer(done, { ok: true });
        await showsText(page, '#toast .toast-text', new RegExp(`^${escape(DONE_WORDS)}$`));
        await page.keyboard.press(CHORD); // at once: the toast lasts 5 s
        await switcherShown(page, true);
        await untilSwitcher(page, (v) => v.items.length > 0, 'the switcher lists items');
        const seen = await measure();
        if (seen === null) {
          // The toast was gone before it could be measured (a loaded machine): once more.
          await page.keyboard.press('Escape');
          await switcherShown(page, false);
          continue;
        }
        assert.ok(seen.items > 0, 'the switcher lists items');
        assert.equal(
          seen.itemsOnTop,
          true,
          "an item's centre is the item: the toast is not over it",
        );
        assert.equal(seen.undoOnTop, true, 'the Undo is on top of the scrim');
        assert.notEqual(seen.panelOverToast, false, 'the panel is over the toast where they meet');
        // A click on the toast's text leaves the keyboard on nothing; the next key gives it back
        // to the field before it acts (E11): `j` is text there, nothing moves, nothing is sent.
        await page.locator('#toast .toast-text').click();
        assert.equal(await keyboardOn(page), 'nothing', 'the click took the keyboard away');
        const sentBefore = w.acts().length;
        await page.keyboard.type('j');
        assert.equal((await switcherView(page)).value, 'j', 'the field holds j');
        assert.equal(await keyboardOn(page), FIELD);
        assert.equal(await selectedRow(page), S2, 'the selection unmoved');
        assert.equal(w.acts().length, sentBefore, 'nothing sent');
        await page.mouse.click(seen.undoAt.x, seen.undoAt.y);
        const undone = await w.act(n + 1);
        assert.deepEqual([undone['kind'], undone['sessionId']], ['undone', S2]);
        assert.equal((await switcherView(page)).shown, true, 'the click closed nothing');
        return;
      }
      assert.fail('the toast was gone each time before it could be measured');
    },
  );
}

// ---------------------------------------------------------------------------------------------
// The restore offer (E12): stage C's, so that it runs once stage C is merged

async function offerCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test('the restore offer (stage C)', async (t) => {
    await t.test(
      'a list whose `switcher.restore` holds two ids → the first entry `Restore 2 sessions from <activityTime>`, Enter → `act restore` with the two ids and a refusal in the key bar; one id → `1 session`; a list without it → no entry',
      async (t) => {
        const lastActivityNs = String(BigInt(Date.now() - 3 * 3_600_000) * 1_000_000n);
        let restore: Row | null = { count: 2, lastActivityNs, sessionIds: [S1, S2] };
        const d = await world(t, chromium, {
          ...ORB_WORLD,
          payload: (text) =>
            text.startsWith('>')
              ? commandPayload(text, restore)
              : payloadFor(text, ORB_WORLD.entries ?? []),
        });
        const { page, w } = d;
        await openSwitcher(page);
        await page.keyboard.type('>rest');
        const nowMs = await page.evaluate(() => Date.now());
        const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
        let view = await untilAnswer(page, '>rest', (v) => v.offer !== null, 'the offer');
        // Stage C's words for the time, on the page's clock and in its time zone (E12).
        assert.equal(
          view.offer?.text,
          `Restore 2 sessions from ${activityTime(lastActivityNs, nowMs, zone)}`,
        );
        assert.equal(view.offer?.active, true, 'the first entry is highlighted');
        assert.deepEqual(view.items, [], 'no session listed');
        assert.equal(view.keys, '↑ ↓ move · Enter restore · Esc close');

        await page.keyboard.press('Enter');
        const act = await w.act(1);
        assert.deepEqual([act['kind'], act['sessionIds']], ['restore', [S1, S2]]);
        w.answer(act, { ok: false, error: 'a restore is already running' });
        await showsText(page, '#key-message', /^a restore is already running$/);

        restore = { count: 1, lastActivityNs, sessionIds: [S1] };
        await openSwitcher(page);
        await clearField(page);
        await page.keyboard.type('>restore');
        view = await untilAnswer(
          page,
          '>restore',
          (v) => v.offer !== null,
          'the offer of one session',
        );
        assert.match(view.offer?.text ?? '', /^Restore 1 session from /);

        restore = null;
        d.set({});
        view = await untilSwitcher(page, (v) => v.offer === null, 'no offer');
        assert.notEqual(view.empty, '', 'a line of its own instead');
      },
    );

    await t.test(
      'a real server with the banner dismissed: Ctrl+Shift+P, then Enter, with an offer, sends no `act restore`',
      async (t) => {
        const l = await launchedSent(t, chromium);
        const { page, d } = l;
        earlierBoot(d, [S1, S2, S3]);
        await page.waitForSelector('#banner:not([hidden])', {
          state: 'attached',
          timeout: PAGE_WAIT_MS,
        });
        await page.locator('#banner button', { hasText: 'Not now' }).click();
        await page.waitForSelector('#banner[hidden]', {
          state: 'attached',
          timeout: PAGE_WAIT_MS,
        });
        await openSwitcher(page);
        await page.keyboard.type('>restore');
        const view = await untilAnswer(page, '>restore', (v) => v.offer !== null, 'the offer');
        assert.match(view.offer?.text ?? '', /^Restore \d+ sessions? from /);
        await clearField(page);
        await untilAnswer(page, '', (v) => v.items.length > 0 && v.offer === null, 'the sessions');
        await page.keyboard.press('Enter');
        await switcherShown(page, false);
        await sleep(800);
        assert.deepEqual(
          (await actsOf(page)).filter((act) => act['kind'] === 'restore'),
          [],
          'no restore sent',
        );
        await healthy(l);
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Text, and two pages of one server

/** Markup that would make an element or run a script if a page took it for HTML. */
const HOSTILE_TITLE = '<u data-hostile="title"><img src=x onerror="window.pwned=1"> hostile';
const HOSTILE_GROUP = '<u data-hostile="group"><img src=g onerror="window.pwned=2">';
const HOSTILE_DIR = '<u data-hostile="dir"><img src=d onerror="window.pwned=3">';
const HOSTILE_TYPED = '<u data-hostile="typed"><img src=t onerror="window.pwned=4">';

async function textCases(t: TestContext, chromium: Browser): Promise<void> {
  await t.test(
    'a hostile title, group and directory in an item, and a hostile text typed, create no element; the server logs no marker typed into the filter or the switcher, nor one in a group of `closed`',
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      const markers = ['FILTERMARK-5b7d', 'SWITCHMARK-3e9a', 'GRPMARK-91c2'];
      session(d, S1, 1n * MIN, HOSTILE_TITLE, join(d.s.home, HOSTILE_DIR));
      setGroup(d.deck, S1, HOSTILE_GROUP);
      session(d, S2, 2n * MIN, 'block one');
      session(d, S3, 3n * MIN, 'block two');
      setGroup(d.deck, S2, markers[2] as string);
      setGroup(d.deck, S3, markers[2] as string);
      await until(async () => (await listRows(page)).length >= 2, 'the sessions listed');
      // A click on the block's caption closes it (F9: the caption line is the control).
      await page
        .locator('#list .list-block[data-section="week"] > .block-head')
        .filter({ has: page.locator('.block-name', { hasText: markers[2] as string }) })
        .click();
      await until(
        async () =>
          JSON.stringify((await lastView(page))['closed']) ===
          JSON.stringify([{ section: 'week', group: markers[2] }]),
        'a view that closes the block',
      );
      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type(markers[0] as string);
      await until(
        async () => (await lastView(page))['filter'] === markers[0],
        'a view with the filter',
      );
      await page.keyboard.press('Escape');
      await until(async () => (await lastView(page))['filter'] === '', 'the filter cleared');

      await openSwitcher(page);
      await page.keyboard.type(`${HOSTILE_TYPED} ${markers[1]}`);
      await until(
        async () => `${(await lastView(page))['switcher']}`.includes(markers[1] as string),
        'a view with the switcher text',
      );
      await untilAnswer(
        page,
        `${HOSTILE_TYPED} ${markers[1]}`,
        (v) => v.empty === 'No session matches.',
        'nothing matches it',
      );
      await clearField(page);
      await page.keyboard.type('hostile');
      const view = await untilAnswer(
        page,
        'hostile',
        (v) => idsOf(v).join() === S1,
        'the hostile session',
      );
      const item = view.items[0];
      assert.equal(item?.title, HOSTILE_TITLE, 'its title, as text');
      // `hostile` twice in the title: in `data-hostile` and as its last word, every occurrence.
      assert.deepEqual(item?.marks, ['hostile', 'hostile'], 'its found parts');
      assert.equal(item?.group, HOSTILE_GROUP, 'its group, as text');
      assert.ok(item?.line.includes('data-hostile="dir"'), `its directory, as text: ${item?.line}`);

      const made = await page.evaluate(() => ({
        elements: document.querySelectorAll('[data-hostile], #switcher img, #list img').length,
        pwned: Reflect.get(globalThis, 'pwned') ?? null,
      }));
      assert.deepEqual(made, { elements: 0, pwned: null }, 'no element, no script');
      await sleep(500);
      const log = d.serverLog().join('\n');
      for (const marker of [...markers, 'data-hostile']) {
        assert.ok(!log.includes(marker), `the server's log holds ${marker}`);
      }
      await healthy(l);
    },
  );

  await t.test(
    "two pages of one server: each has its own switcher and filter; a pick in one changes nothing in the other's selection",
    async (t) => {
      const l = await launchedSent(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'alpha work');
      session(d, S2, 2n * MIN, 'beta work');
      session(d, S3, 3n * MIN, 'gamma work');
      const context = await newContext(chromium);
      t.after(() => context.close());
      await context.addInitScript(SENT);
      const other = await context.newPage();
      const otherProblems = problemsOf(other);
      const { token } = await controlClient(l.d.platform.net, l.d.files.serverSock).token(30);
      await other.goto(pageUrl(l.server.port, token));
      await connection(other, 'open');
      await untilRows(page, [S1, S2, S3], 'the first page lists them');
      await untilRows(other, [S1, S2, S3], 'the second page lists them');
      assert.equal(await selectedRow(other), S1);

      // The first page filters and opens its switcher; the second shows neither.
      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('alpha');
      await page.keyboard.press('Enter');
      await untilRows(page, [S1], 'the first page filters');
      await openSwitcher(page);
      await page.keyboard.type('beta');
      await untilAnswer(page, 'beta', (v) => idsOf(v).join() === S2, 'the first switcher lists S2');
      assert.equal((await switcherView(other)).shown, false, 'the second has no switcher open');
      assert.equal(await other.inputValue('#list input.list-filter'), '');
      assert.deepEqual(
        (await listRows(other)).map((r) => r.id),
        [S1, S2, S3],
        'and no filter',
      );
      assert.ok(
        (await viewsOf(other)).every(
          (view) => typeof view['switcher'] !== 'string' && view['filter'] === '',
        ),
        'the second page sent no text of the first',
      );

      // A pick in the first page.
      await page.keyboard.press('Enter');
      await untilTerminalOf(page, S2);
      await sleep(800);
      assert.equal(await selectedRow(other), S1, "the second page's selection did not move");
      await openSwitcher(other);
      const second = await untilSwitcher(other, (v) => v.items.length === 3, 'its own switcher');
      assert.equal(second.value, '', 'with its own text');
      assert.equal((await switcherView(page)).shown, false, 'the first closed after its pick');
      assert.deepEqual(otherProblems, [], 'the second page reports no problem');
      await healthy(l);
    },
  );
}

test('the quick switcher on the page', async (t) => {
  const chromium = await browser(t);
  await openingCases(t, chromium);
  await pickCases(t, chromium);
  await scriptedPickCases(t, chromium);
  await queryCases(t, chromium);
  await modalCases(t, chromium);
  await offerCases(t, chromium);
  await textCases(t, chromium);
});
