// The list's search and blocks on the page (S2 12.2, 12.8, 12.9's list zone; plan E task 97, E4–E7,
// E6 and E7 as ruled 2026-11-16 for follow-up F3, and follow-up F9's cards): the filter's words and
// the short id, the chips under the filter field, done sessions while filtering, and the blocks of
// one group in every section — open by default — drawn as CARDS: a caption line (the fold arrow, the
// group's name, its number of sessions) over every session of the block as an ordinary row; a closed
// block is its caption alone, none of its rows drawn, and that caption can hold the selection (no
// session is selected then). (The code and the protocol call a block a stack: `data-stack`,
// `row.stack`, `closedStacks`.) The rules are the server's (task 96): most cases run a real test
// server on realTestPlatform with sessions made the way step 1 sees them (transcripts, the store's
// meta, pull requests saved with `savePrResult`), and the page draws what that server sends; the
// cases of a terminal that has not reported, and of what the page draws before the server answers,
// run a scripted stand-in that applies the server's own rule (`stackRows`).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Locator, Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import { attachManualPr, markDone, setGroup, setNote } from '../src/sessions/meta.ts';
import { controlClient } from '../src/window/client.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import type { TerminalState } from '../src/window/hub.ts';
import type { ClosedBlock } from '../src/window/protocol.ts';
import { stackRows } from '../src/window/view/search/stacks.ts';
import { MAY_START as SERVER_MAY_START } from '../src/window/view/sections.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { startTestServer } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  after,
  connection,
  editWorld,
  escape,
  logOf,
  mark,
  PAGE_WAIT_MS,
  pageUrl,
  problemsOf,
  readPage,
  RECORDER,
  resumeFromList,
  scriptedList,
  selectedRow,
  showsText,
  shownText,
  TERM_A,
  TERM_B,
  TERM_C,
  termOf,
  toZone,
} from './helpers/shell.ts';
import type { EditWorld, Launched } from './helpers/shell.ts';
import { inputOf, resumeHere, shownTerm, until } from './helpers/terminal.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4e1a-8b8c-7d6e5f4a3b2c';
const S7 = '6b1f9c7e-4d8a-4f2b-9c9d-8e7f6a5b4c3d';
const S8 = '7c2a0d8f-5e9b-4a3c-8dae-9f8a7b6c5d4e';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const DAY = 86_400n * SEC;

/** The lines the key bar says for a refused ← or click on a caption (web/list.js's). */
const HOLDS_SELECTED = /^this block holds the selected session; it stays open$/;
const STARTING = /^this block holds a session that is still starting; it stays open$/;
const ENDED = /^this block holds a terminal that ended at its start; close it first$/;
const NO_SESSION = /^no session selected$/;

// ---------------------------------------------------------------------------------------------
// Sessions as step 1 sees them

/** A session last active `agoNs` before now, titled `title` (a `custom-title` record). */
function session(d: ServerSandbox, sessionId: string, agoNs: bigint, title: string): void {
  const dir = join(d.s.home, 'project');
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

/** Attaches the pull request `o/r#<number>` to `sessionId`, last read now as `state`. */
function pullRequest(
  d: ServerSandbox,
  sessionId: string,
  number: number,
  state: 'open' | 'merged',
): void {
  const url = `https://github.com/o/r/pull/${number}`;
  attachManualPr(d.deck, sessionId, url);
  d.deck.store.savePrResult(url, {
    ok: true,
    atNs: d.platform.clock.nowNs(),
    title: `PR ${number}`,
    state,
    review: null,
    checks: null,
  });
}

// ---------------------------------------------------------------------------------------------
// The page, with every `view` and `focus` it sends recorded

/**
 * An init script that records in the page every `view` message the page sends, whole
 * (`sentViews`), and every `focus` (`sentFocuses`). It wraps whichever `send` WebSocket's
 * prototype has when it runs, so that it works before or after helpers/shell.ts's RECORDER
 * (Playwright does not define their order).
 */
const VIEWS = `(() => {
  const views = [];
  const focuses = [];
  Reflect.set(globalThis, 'sentViews', views);
  Reflect.set(globalThis, 'sentFocuses', focuses);
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message !== null && message.t === 'view') views.push(message);
        if (message !== null && message.t === 'focus') focuses.push(message);
      } catch {}
    }
    return send.call(this, data);
  };
})();`;

/**
 * An init script that records in the page the `terminals` of the last `list` the page received
 * (`receivedTerminals`): what the page itself knows of each terminal's session, which (c2)'s copy
 * reads to refuse closing a block; and that list's `needYou.order` (`receivedOrder`). It wraps the
 * `onmessage` handler the page sets, so the page's own handler takes the same list right after it
 * is recorded.
 */
const LISTS = `(() => {
  const record = (event) => {
    if (typeof event.data !== 'string' || !event.data.startsWith('{')) return;
    try {
      const message = JSON.parse(event.data);
      if (message !== null && message.t === 'list' && Array.isArray(message.terminals)) {
        Reflect.set(globalThis, 'receivedTerminals', message.terminals);
        Reflect.set(globalThis, 'receivedOrder', message.needYou?.order ?? []);
      }
    } catch {}
  };
  // web/connection.js takes messages through \`onmessage\`: wrap what it sets. The accessor is
  // the native prototype's; helpers/shell.ts's RECORDER may have put a subclass in front of it.
  let owner = WebSocket.prototype;
  while (owner !== null && !Object.hasOwn(owner, 'onmessage')) owner = Object.getPrototypeOf(owner);
  if (owner === null) return;
  const handler = Object.getOwnPropertyDescriptor(owner, 'onmessage');
  Object.defineProperty(owner, 'onmessage', {
    ...handler,
    set(listener) {
      handler.set.call(
        this,
        typeof listener === 'function'
          ? function (event) {
              record(event);
              return listener.call(this, event);
            }
          : listener,
      );
    },
  });
})();`;

/**
 * helpers/shell.ts's `launched` (a real test server; the page opened with a launch token, as
 * `skydeck window` opens it; connected), with VIEWS and LISTS among its init scripts from the
 * start, so that the first views the page sends are recorded too.
 */
async function launchedWithViews(t: TestContext, chromium: Browser): Promise<Launched> {
  const page = await newPage(t, chromium);
  await page.addInitScript(RECORDER);
  await page.addInitScript(VIEWS);
  await page.addInitScript(LISTS);
  const problems = problemsOf(page);
  const started = await startTestServer(t);
  const { token } = await controlClient(started.d.platform.net, started.d.files.serverSock).token(
    30,
  );
  await page.goto(pageUrl(started.server.port, token));
  await connection(page, 'open');
  return { ...started, page, problems };
}

/** Every `view` the page sent so far, whole. */
async function sentViews(page: Page): Promise<Record<string, unknown>[]> {
  return readPage(
    page,
    () => (Reflect.get(globalThis, 'sentViews') ?? []) as Record<string, unknown>[],
    null,
  );
}

/** Every `focus` the page sent so far, whole. */
async function sentFocuses(page: Page): Promise<Record<string, unknown>[]> {
  return readPage(
    page,
    () => (Reflect.get(globalThis, 'sentFocuses') ?? []) as Record<string, unknown>[],
    null,
  );
}

/** The `needYou.order` of the last list the page received. */
async function receivedOrder(page: Page): Promise<string[]> {
  return readPage(page, () => (Reflect.get(globalThis, 'receivedOrder') ?? []) as string[], null);
}

/**
 * Waits until the PAGE's own last list holds `count` terminals, each with its session reported (S2
 * 7.5), so that the page lets a block of them close: its copy of the server's rule (c2) refuses
 * while a row's terminal has `sessionId` null in its `list.terminals`. The server's hub can be
 * ahead of the page by a list (at most one a second): waiting on the hub is not enough (F6, L6:
 * a block that did not close on a slow runner).
 */
async function untilPageReported(page: Page, count: number): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const terminals = await readPage(
      page,
      () => (Reflect.get(globalThis, 'receivedTerminals') ?? []) as { sessionId: unknown }[],
      null,
    );
    if (
      terminals.length === count &&
      terminals.every((term) => typeof term.sessionId === 'string')
    ) {
      return;
    }
    if (performance.now() > deadline) {
      assert.fail(`the page's terminals are ${JSON.stringify(terminals)}`);
    }
    await sleep(50);
  }
}

/** The last `view` the page sent. */
async function lastView(page: Page): Promise<Record<string, unknown>> {
  const last = (await sentViews(page)).at(-1);
  assert.ok(last !== undefined, 'the page sent a view');
  return last;
}

/** `view.closed`'s entries: each of `groups` closed in `section`. */
function shut(section: ClosedBlock['section'], ...groups: string[]): ClosedBlock[] {
  return groups.map((group) => ({ section, group }));
}

/** Waits until the last view the page sent names exactly `entries` as closed. */
async function untilClosed(page: Page, entries: ClosedBlock[]): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const last = (await sentViews(page)).at(-1);
    if (JSON.stringify(last?.['closed']) === JSON.stringify(entries)) return;
    if (performance.now() > deadline) {
      assert.fail(`the last view's closed is ${JSON.stringify(last?.['closed'])}`);
    }
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------
// A scripted server that applies the server's own rule

/** A row of `blockedList`: its session, its group (null: none) and its title. */
interface ScriptedRow {
  id: string;
  group: string | null;
  title?: string;
  /** Counted in its closed block's `needYou` (its own `attention` stays null). */
  needsYou?: boolean;
}

/** A terminal of `blockedList`: the session it was opened for (`of`), what it reported, its state. */
interface ScriptedTerm {
  id: string;
  slot: number;
  of: string;
  sessionId: string | null;
  state: string;
}

/**
 * A scripted list (helpers/shell.ts's `scriptedList`: every row under Open) whose blocks the
 * server's own rule draws (`stackRows`, with `closed` and `selected` as the page's last view gave
 * them: a closed block's rows left out, its caption in `closedStacks`), and whose rows carry what
 * the server's `rowPayload` says of their terminal: one that has not reported and may still start
 * makes its row `starting`, one that reported and may still start `running`.
 */
function blockedList(
  rows: readonly ScriptedRow[],
  terms: readonly ScriptedTerm[],
  closed: readonly ClosedBlock[],
  selected: string | null,
): Record<string, unknown> {
  const termOfRow = (id: string): ScriptedTerm | undefined => terms.find((term) => term.of === id);
  const base = scriptedList(
    rows.map((row) => ({
      id: row.id,
      terminal: termOfRow(row.id)?.id ?? null,
      slot: termOfRow(row.id)?.slot ?? null,
      ...(row.title === undefined ? {} : { title: row.title }),
    })),
    terms.map(({ id, slot, sessionId }) => ({ id, slot, sessionId })),
  ) as {
    sections: { rows: Record<string, unknown>[] }[];
    terminals: Record<string, unknown>[];
  } & Record<string, unknown>;
  const drawn = stackRows(
    (base.sections[0]?.rows ?? []).map((payload, at) => {
      const term = termOfRow(payload['id'] as string);
      const mayStart = term !== undefined && SERVER_MAY_START.has(term.state as TerminalState);
      const group = rows[at]?.group ?? null;
      return {
        id: payload['id'] as string,
        group,
        needsYou: rows[at]?.needsYou ?? false,
        unreported: term !== undefined && term.sessionId === null,
        row: {
          ...payload,
          group,
          starting: term !== undefined && term.sessionId === null && mayStart,
          state:
            term !== undefined && term.sessionId !== null && mayStart ? 'running' : 'not-running',
        },
      };
    }),
    'open',
    closed,
    selected,
  );
  return {
    ...base,
    terminals: base.terminals.map((term) => ({
      ...term,
      state: terms.find((one) => one.id === term['id'])?.state ?? 'running',
    })),
    sections: [
      {
        ...base.sections[0],
        count: rows.length,
        rows: drawn.rows.map(({ entry, stack }) => ({ ...entry.row, stack })),
        closedStacks: drawn.closed,
      },
    ],
  };
}

/** The `closed` of the last view the page sent to `world` ([] before any). */
function closedOf(world: EditWorld | null): ClosedBlock[] {
  const views = (world?.sent ?? []).filter((message) => message['t'] === 'view');
  return (views.at(-1)?.['closed'] ?? []) as ClosedBlock[];
}

/** A page with RECORDER and VIEWS on a scripted `editWorld` that answers every view with `list`. */
async function scriptedPage(
  t: TestContext,
  chromium: Browser,
  list: (world: () => EditWorld | null) => (selected: string | null) => Record<string, unknown>,
): Promise<{ page: Page; world: EditWorld; problems: string[] }> {
  let world: EditWorld | null = null;
  const page = await newPage(t, chromium);
  await page.addInitScript(RECORDER);
  await page.addInitScript(VIEWS);
  const problems = problemsOf(page);
  world = await editWorld(
    t,
    page,
    list(() => world),
  );
  return { page, world, problems };
}

// ---------------------------------------------------------------------------------------------
// What the list shows

/** One line of the list's body: a session's row, or a block's caption (F9). */
interface Line {
  kind: 'row' | 'caption';
  /** A row's `data-id`; '' for a caption (captions carry none). */
  id: string;
  section: string;
  /** The group of the card the line is in (its caption's name), '' for a row in no card. */
  card: string;
  /** The card's `data-open` ('true', 'false'), '' for a row in no card. */
  open: string;
  /** `data-selected="true"`. */
  selected: boolean;
  /** `data-stack` ('head', 'member'), '' for a row in no block and for a caption. */
  stack: string;
  /** A row's slot number, '' when none is shown. */
  slot: string;
  /** A row's title; a caption's group name. */
  text: string;
  /** A caption's number of sessions; '' for a row. */
  count: string;
  /** A caption's ` · 1 needs you`, '' when not shown (and for a row). */
  need: string;
  /** A row's ticket key and group as shown (both hidden inside a card). */
  key: string;
  group: string;
  marks: string[];
  /** Where the row's state icon (a caption's arrow) starts, in pixels from the list's left edge. */
  indent: number;
}

/** The lines the list draws, in order (visible ones only). */
async function lines(page: Page): Promise<Line[]> {
  return readPage(
    page,
    () => {
      const shown = (element: Element | null | undefined): string =>
        element instanceof HTMLElement && element.checkVisibility()
          ? (element.textContent ?? '')
          : '';
      const list = document.getElementById('list');
      const left = list?.getBoundingClientRect().left ?? 0;
      let section = '';
      const drawn: Line[] = [];
      for (const element of document.querySelectorAll(
        '#list .list-section, #list .block-head, #list .list-row',
      )) {
        if (!(element instanceof HTMLElement) || !element.checkVisibility()) continue;
        if (element.classList.contains('list-section')) {
          section = element.dataset['section'] ?? '';
          continue;
        }
        const caption = element.classList.contains('block-head');
        const block = element.closest('.list-block');
        const card =
          block instanceof HTMLElement
            ? (block.querySelector(':scope > .block-head .block-name')?.textContent ?? '')
            : '';
        const icon = element.querySelector(caption ? '.block-twist' : '.row-icon');
        drawn.push({
          kind: caption ? 'caption' : 'row',
          id: caption ? '' : (element.dataset['id'] ?? ''),
          section,
          card,
          open: block instanceof HTMLElement ? (block.dataset['open'] ?? '') : '',
          selected: element.dataset['selected'] === 'true',
          stack: caption ? '' : (element.dataset['stack'] ?? ''),
          slot: caption ? '' : shown(element.querySelector('.row-slot')),
          text: caption
            ? (element.querySelector('.block-name')?.textContent ?? '')
            : shown(element.querySelector('.row-title')),
          count: caption ? shown(element.querySelector('.block-count')) : '',
          need: caption ? shown(element.querySelector('.block-need')) : '',
          key: caption ? '' : shown(element.querySelector('.row-key')),
          group: caption ? '' : shown(element.querySelector('.row-group')),
          marks: caption
            ? []
            : [...element.querySelectorAll('.row-mark')].map(shown).filter((text) => text !== ''),
          indent: Math.round((icon ?? element).getBoundingClientRect().left - left),
        });
      }
      return drawn;
    },
    null,
  );
}

/** An open card's caption in a shape; CLOSED: a closed one's; `*` before either: selected. */
const OPEN = (group: string): string => `▾ ${group}`;
const CLOSED = (group: string): string => `▸ ${group}`;

/** The lines in short: a row's id, a caption's OPEN or CLOSED; `*` before the selected line. */
function shapeOf(drawn: readonly Line[]): string[] {
  return drawn.map((line) => {
    const text = line.kind === 'row' ? line.id : (line.open === 'true' ? OPEN : CLOSED)(line.text);
    return line.selected ? `*${text}` : text;
  });
}

/** The ids of the rows drawn, in order. */
async function rowIds(page: Page): Promise<string[]> {
  return (await lines(page)).filter((line) => line.kind === 'row').map((line) => line.id);
}

/** Waits until `check` holds for the lines the list draws; fails with what it drew. */
async function untilLines(
  page: Page,
  check: (drawn: Line[]) => boolean,
  what: string,
): Promise<Line[]> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const drawn = await lines(page);
    if (check(drawn)) return drawn;
    if (performance.now() > deadline) {
      assert.fail(`${what}: the list draws ${JSON.stringify(shapeOf(drawn))}`);
    }
    await sleep(50);
  }
}

/** Waits until the lines drawn are `want` (shapeOf's, the selection marked); returns them. */
async function untilShape(page: Page, want: readonly string[], what: string): Promise<Line[]> {
  return untilLines(page, (drawn) => JSON.stringify(shapeOf(drawn)) === JSON.stringify(want), what);
}

/** Waits until the rows drawn are exactly `ids`, in order. */
async function untilRows(page: Page, ids: string[], what: string): Promise<Line[]> {
  return untilLines(
    page,
    (drawn) =>
      drawn
        .filter((line) => line.kind === 'row')
        .map((line) => line.id)
        .join() === ids.join(),
    what,
  );
}

/** Waits until the selected row is `id`. */
async function untilSelected(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (id) => document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
    id,
    { timeout: PAGE_WAIT_MS },
  );
}

/** What is selected in the list: `row <id>`, `caption <group>`, or `nothing`. */
async function selectedLine(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const one = document.querySelector('#list [data-selected="true"]');
      if (!(one instanceof HTMLElement)) return 'nothing';
      return one.classList.contains('block-head')
        ? `caption ${one.querySelector('.block-name')?.textContent ?? ''}`
        : `row ${one.dataset['id'] ?? ''}`;
    },
    null,
  );
}

/** The caption line of the block of `group` in `section` (the whole line is the control). */
function captionOf(page: Page, section: string, group: string): Locator {
  return page
    .locator(`#list .list-block[data-section="${section}"] > .block-head`)
    .filter({ has: page.locator('.block-name', { hasText: new RegExp(`^${escape(group)}$`) }) });
}

/** Waits until the right side shows the pane `kind` (app.js's `#right-zone[data-pane]`). */
async function untilPane(page: Page, kind: string): Promise<void> {
  await page.waitForSelector(`#right-zone[data-pane="${kind}"]`, {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** The pane's group card (F9): whether it is shown, and its texts as shown. */
async function groupCard(
  page: Page,
): Promise<{ shown: boolean; name: string; count: string; need: string; hint: string }> {
  return readPage(
    page,
    () => {
      const card = document.querySelector('#cards .card[data-card="group"]');
      const text = (selector: string): string => {
        const part = card?.querySelector(selector);
        return part instanceof HTMLElement && part.checkVisibility()
          ? (part.textContent ?? '')
          : '';
      };
      return {
        shown: card instanceof HTMLElement && card.checkVisibility(),
        name: text('.card-group-name'),
        count: text('.card-group-count'),
        need: text('.card-group-need'),
        hint: text('.card-group-hint'),
      };
    },
    null,
  );
}

/** How many terminals the terminal view shows (not hidden), and whether its find bar is shown. */
async function terminalsShown(page: Page): Promise<{ terms: number; find: boolean }> {
  return readPage(
    page,
    () => ({
      terms: document.querySelectorAll('#terminal .tv-term:not([hidden])').length,
      find: [...document.querySelectorAll('.tv-find')].some(
        (bar) => bar instanceof HTMLElement && !bar.hidden,
      ),
    }),
    null,
  );
}

/** Whether a dialog of stage D is shown. */
async function editorShown(page: Page): Promise<boolean> {
  return readPage(page, () => document.querySelector('#editor:not([hidden])') !== null, null);
}

/** Empties the key bar's message, so that the next one can be told from the last. */
async function clearKeyBar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const message = document.getElementById('key-message');
    if (message !== null) message.textContent = '';
  });
}

/** Where the keyboard is: the filter field, the list itself, the terminal, or what else. */
async function keyboardOn(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const element = document.activeElement;
      if (element === null || element === document.body) return 'nothing';
      if (element.classList.contains('list-filter')) return 'the filter';
      if (element.id === 'list') return 'the list';
      if (document.getElementById('terminal')?.contains(element) === true) return 'the terminal';
      return `${element.tagName}.${element.className}`;
    },
    null,
  );
}

/** The chips under the filter field: each one's text and `aria-pressed`. */
async function chips(page: Page): Promise<[string, string][]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#list .list-chips button')].map(
        (button) =>
          [button.textContent ?? '', button.getAttribute('aria-pressed') ?? ''] as [string, string],
      ),
    null,
  );
}

/** A click on the chip named `name` (`Running`, `Open PR`, `Has note`, `Show done`). */
async function clickChip(page: Page, name: string): Promise<void> {
  await page.locator('#list .list-chips button', { hasText: name }).click();
}

/**
 * A double click at a human pace on the centre of `target`: the first click, then `between`
 * (the list has redrawn under the pointer meanwhile, as it does within a person's double click),
 * then the second press, with the click count Chromium gives the second click of a double click.
 */
async function doubleClick(
  page: Page,
  target: string | Locator,
  between: () => Promise<unknown>,
): Promise<void> {
  const box = await (typeof target === 'string' ? page.locator(target) : target).boundingBox();
  assert.ok(box !== null, String(target));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await between();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

/** The types of the messages the page sent after the mark `name` (helpers/shell.ts's log). */
async function sentAfter(page: Page, name: string): Promise<string[]> {
  return after(await logOf(page), name)
    .filter((entry) => entry.e === 'out')
    .map((entry) => entry.t ?? '');
}

/**
 * The page of a real server reports no problem (no console error, nothing uncaught, no failed
 * load); the list keeps the hooks the shared helpers rely on — exactly one `#list [data-id]` per
 * drawn row (captions carry none), `data-selected="true"` on one row or one caption at most, no
 * `×n` and no `+n more` line (F9), every card starting with its one caption, an open one holding
 * at least two rows and a closed one none —; and every view the page sent holds `chips` and
 * `closed` and no `opened` (the field `closed` replaced), at most 64 entries, each exactly a
 * section and a group, the group a well-formed text of at most 1,024 bytes, each entry once.
 */
async function healthy(page: Page, problems: readonly string[]): Promise<void> {
  assert.deepEqual(problems, [], 'the page reports no problem');
  const hooks = await readPage(
    page,
    () => ({
      ids: [...document.querySelectorAll('#list [data-id]')].map((e) => e.getAttribute('data-id')),
      rows: document.querySelectorAll('#list .list-row').length,
      selected: document.querySelectorAll('#list [data-selected="true"]').length,
      selectedLines: document.querySelectorAll(
        '#list .list-row[data-selected="true"], #list .block-head[data-selected="true"]',
      ).length,
      old: document.querySelectorAll('#list .row-stack, #list .list-more').length,
      cards: [...document.querySelectorAll('#list .list-block')].map((block) => ({
        head:
          block.firstElementChild?.classList.contains('block-head') === true &&
          block.querySelectorAll('.block-head').length === 1,
        open: block.getAttribute('data-open'),
        rows: block.querySelectorAll('.list-row').length,
      })),
    }),
    null,
  );
  assert.equal(new Set(hooks.ids).size, hooks.ids.length, 'one element per session id');
  assert.equal(hooks.ids.length, hooks.rows, 'only the rows carry data-id');
  assert.ok(hooks.selected <= 1, 'data-selected on one line at most');
  assert.equal(hooks.selected, hooks.selectedLines, 'data-selected on a row or a caption only');
  assert.equal(hooks.old, 0, 'no `×n` and no `+n more` line');
  for (const card of hooks.cards) {
    assert.ok(card.head, 'a card starts with its one caption');
    assert.ok(
      card.open === 'true' ? card.rows >= 2 : card.open === 'false' && card.rows === 0,
      `a card's rows: ${JSON.stringify(card)}`,
    );
  }
  const views = await sentViews(page);
  assert.ok(views.length > 0, 'the page sent views');
  for (const view of views) {
    assert.ok(Array.isArray(view['closed']), `every view holds closed: ${JSON.stringify(view)}`);
    assert.ok(Array.isArray(view['chips']), `every view holds chips: ${JSON.stringify(view)}`);
    assert.ok(!Object.hasOwn(view, 'opened'), 'no view holds opened');
    const closed = view['closed'] as unknown[];
    assert.ok(closed.length <= 64, 'at most 64 entries');
    const seen = new Set<string>();
    for (const entry of closed) {
      assert.deepEqual(Object.keys(entry as object).sort(), ['group', 'section']);
      const { section, group } = entry as { section: unknown; group: unknown };
      assert.ok(['open', 'week', 'earlier'].includes(section as string), String(section));
      assert.equal(typeof group, 'string');
      assert.ok((group as string).isWellFormed());
      assert.ok(Buffer.byteLength(group as string) <= 1024, 'a group of at most 1,024 bytes');
      const key = JSON.stringify([section, group]);
      assert.ok(!seen.has(key), 'each entry once');
      seen.add(key);
    }
  }
}

// ---------------------------------------------------------------------------------------------

test('search and stacks in the list', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "every view the page sends holds `closed` (`[]` at least) and `chips`: the page's first view (the welcome's), a select's, and the list's own",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'ORB-1 one');
      session(d, S2, 3n * MIN, 'ORB-1 two');
      session(d, S3, 4n * MIN, 'plain');
      setNote(d.deck, S1, 'a note');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3], 'an open card and a row');
      const [first] = await sentViews(page);
      assert.deepEqual(
        { selected: first?.['selected'], chips: first?.['chips'], closed: first?.['closed'] },
        { selected: null, chips: [], closed: [] },
        "the first view (the welcome's): nothing selected yet",
      );

      // A select's view (app.js's), then the list's own (a block closed, a chip).
      await toZone(page, 'list');
      await page.keyboard.press('End');
      await untilSelected(page, S3);
      const selects = (await sentViews(page)).filter((view) => view['selected'] === S3);
      assert.ok(selects.length > 0, 'a view with the selection');
      for (const view of selects) {
        assert.deepEqual([view['chips'], view['closed']], [[], []], "a select's view");
      }
      await captionOf(page, 'week', 'ORB-1').click();
      await untilClosed(page, shut('week', 'ORB-1'));
      await untilShape(page, [CLOSED('ORB-1'), `*${S3}`], 'the block closed');
      await clickChip(page, 'Has note');
      await untilRows(page, [S1], 'Has note');
      assert.deepEqual(
        { chips: (await lastView(page))['chips'], closed: (await lastView(page))['closed'] },
        { chips: ['note'], closed: shut('week', 'ORB-1') },
        'the list keeps both, each sent whole',
      );
      await page.keyboard.press('ArrowUp');
      await untilSelected(page, S1);
      assert.deepEqual(
        { chips: (await lastView(page))['chips'], closed: (await lastView(page))['closed'] },
        { chips: ['note'], closed: shut('week', 'ORB-1') },
        'a select after them holds them too',
      );
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'the filter: two words typed → the rows that have both; the first characters of a short id → its row; a done session that matches is listed with `done`, and the footer is gone; the field names the short id',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'alpha login fix');
      session(d, S2, 3n * MIN, 'beta login');
      session(d, S3, 4n * MIN, 'alpha deploy');
      session(d, S4, 5n * MIN, 'alpha login done');
      markDone(d.deck, S4);
      await untilRows(page, [S1, S2, S3], 'Recent');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.match(
        (await page.getAttribute('#list .list-filter', 'placeholder')) ?? '',
        /short id/,
      );

      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('login alpha');
      const matched = await untilRows(page, [S1, S4], 'both words, in any order');
      assert.deepEqual(
        matched.map((line) => line.marks),
        [[], ['done']],
      );
      assert.equal(await shownText(page, '#list .list-footer'), '', 'no footer while filtering');

      await page.keyboard.press('Escape');
      await untilRows(page, [S1, S2, S3], 'the filter cleared');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      await page.keyboard.press('/');
      await page.keyboard.type(S3.slice(0, 6));
      await untilRows(page, [S3], 'the short id');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'the chips: Running, Open PR, Has note and Show done under the filter field; each pressed → aria-pressed and the rows the server sent, every chip set holding, the keyboard where it was; a chip that matches nothing → `No session matches the filter.`; nothing folds while a chip is set',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'with an open pull request and a note'); // open PR + note
      session(d, S2, 3n * MIN, 'with a merged pull request'); // merged PR
      session(d, S3, 4n * MIN, 'with a note'); // note
      session(d, S4, 5n * MIN, 'plain'); // nothing
      session(d, S5, 20n * DAY, 'old with a note'); // Earlier, note
      pullRequest(d, S1, 1, 'open');
      setNote(d.deck, S1, 'the open one');
      pullRequest(d, S2, 2, 'merged');
      setNote(d.deck, S3, 'only a note');
      setNote(d.deck, S5, 'an old note');
      await untilRows(page, [S1, S2, S3, S4], 'Recent, Earlier folded');
      assert.deepEqual(await chips(page), [
        ['Running', 'false'],
        ['Open PR', 'false'],
        ['Has note', 'false'],
        ['Show done', 'false'],
      ]);

      // Running with nothing running: the list says so; the keyboard stays on the list.
      await toZone(page, 'list');
      await clickChip(page, 'Running');
      await showsText(page, '#list .list-empty', /^No session matches the filter\.$/);
      assert.deepEqual(await rowIds(page), []);
      assert.equal(await keyboardOn(page), 'the list');
      assert.deepEqual(
        (await chips(page)).map(([, pressed]) => pressed),
        ['true', 'false', 'false', 'false'],
      );
      assert.deepEqual((await lastView(page))['chips'], ['running']);
      await clickChip(page, 'Running');
      await untilRows(page, [S1, S2, S3, S4], 'Running off');

      // Open PR, from the filter field: the keyboard stays in the field.
      await page.keyboard.press('/');
      assert.equal(await keyboardOn(page), 'the filter');
      await clickChip(page, 'Open PR');
      await untilRows(page, [S1], 'Open PR: the open one, not the merged one');
      assert.equal(await keyboardOn(page), 'the filter');
      // With Has note too: every chip set must hold.
      await clickChip(page, 'Has note');
      await untilRows(page, [S1], 'Open PR and Has note');
      assert.deepEqual((await lastView(page))['chips'], ['open-pr', 'note']);
      await clickChip(page, 'Open PR');
      // Has note alone: Earlier is unfolded while a chip is set.
      const noted = await untilRows(page, [S1, S3, S5], 'Has note');
      assert.deepEqual(
        noted.map((line) => line.section),
        ['week', 'week', 'earlier'],
      );
      assert.equal(await keyboardOn(page), 'the filter');
      assert.deepEqual(
        (await chips(page)).map(([, pressed]) => pressed),
        ['false', 'false', 'true', 'false'],
      );

      // Nothing folds while a chip is set: neither ← on Earlier's row nor a click on its header.
      await page.keyboard.press('Enter'); // the keyboard back to the list
      await page.locator(`#list [data-id="${S5}"]`).click();
      await untilSelected(page, S5);
      await sleep(300);
      const before = (await sentViews(page)).length;
      await page.keyboard.press('ArrowLeft');
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await sleep(500);
      assert.deepEqual(await rowIds(page), [S1, S3, S5], 'Earlier stays unfolded');
      assert.equal(await selectedRow(page), S5, 'and the selection on its row');
      assert.equal((await sentViews(page)).length, before, 'no view: nothing folded');
      await clickChip(page, 'Has note');
      await untilRows(page, [S1, S2, S3, S4], 'no chip: Earlier folded as before');

      // Running, once a session runs: from the terminal the keyboard stays in the terminal.
      await resumeFromList(page, S4);
      assert.equal(await keyboardOn(page), 'the terminal');
      await clickChip(page, 'Running');
      const running = await untilRows(page, [S4], 'Running');
      assert.deepEqual(
        running.map((line) => line.section),
        ['open'],
      );
      assert.equal(await keyboardOn(page), 'the terminal');
      await clickChip(page, 'Running');
      await untilRows(page, [S4, S1, S2, S3], 'Running off');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "`Show done`, the list key `a` and the footer's `show` are one state: each turns the others on, and off",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 2n * MIN, 'open one');
      session(d, S2, 3n * MIN, 'done one');
      markDone(d.deck, S2);
      await untilRows(page, [S1], 'the done session hidden');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      const showDone = async (): Promise<string | undefined> =>
        (await chips(page)).find(([name]) => name === 'Show done')?.[1];

      await toZone(page, 'list');
      await clickChip(page, 'Show done');
      await untilRows(page, [S1, S2], 'the chip shows them');
      assert.equal(await showDone(), 'true');
      await showsText(page, '#list .list-footer', /^done sessions shown · hide$/);
      assert.equal(await keyboardOn(page), 'the list');

      await page.keyboard.press('a');
      await untilRows(page, [S1], '`a` hides them');
      assert.equal(await showDone(), 'false');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);

      await page.keyboard.press('a');
      await untilRows(page, [S1, S2], '`a` shows them');
      assert.equal(await showDone(), 'true');

      await page.locator('#list .footer-action', { hasText: 'hide' }).click();
      await untilRows(page, [S1], 'the footer hides them');
      assert.equal(await showDone(), 'false');
      await page.locator('#list .footer-action', { hasText: 'show' }).click();
      await untilRows(page, [S1, S2], 'the footer shows them');
      assert.equal(await showDone(), 'true');

      // While filtering the footer is not shown, with done sessions shown too (E5).
      await page.keyboard.press('/');
      await page.keyboard.type('one');
      await untilRows(page, [S1, S2], 'a filter while done ones are shown');
      await page.waitForFunction(
        () => document.querySelector('#list .list-footer')?.closest('[hidden]') !== null,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      await page.keyboard.press('Escape');
      await showsText(page, '#list .list-footer', /^done sessions shown · hide$/);

      await clickChip(page, 'Show done');
      await untilRows(page, [S1], 'the chip hides them');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.equal((await lastView(page))['showDone'], false);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a block is a card: three sessions of ORB-1 in Recent → OPEN by default, one box (a 1 px edge, rounded, its own background) with a caption line (`ORB-1`, `3`, the tip `close the group`) over its three rows, every one drawn alike (no indent, its ticket key not repeated); ← on the first, on a middle and on the last session closes the block — none of its rows drawn, the first neither — and selects its caption (`open the group`); → and Enter on the caption open it and select the first session, Enter resuming nothing; ↓ ↑ and j k from the caption to the row after it and back; ← → on a row in no block fold and unfold Earlier as before',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      session(d, S5, 20n * DAY, 'old work');
      const open = await untilShape(
        page,
        [OPEN('ORB-1'), `*${S1}`, S2, S3, S4],
        'the card, open by default',
      );
      const fields = (line: Line | undefined): Partial<Line> => {
        const { kind, id, card, open, stack, text, count, need, key, group } = line ?? ({} as Line);
        return { kind, id, card, open, stack, text, count, need, key, group };
      };
      const row = { count: '', need: '', key: '', group: '' };
      assert.deepEqual(open.map(fields), [
        {
          kind: 'caption',
          id: '',
          card: 'ORB-1',
          open: 'true',
          stack: '',
          text: 'ORB-1',
          count: '3',
          need: '',
          key: '',
          group: '',
        },
        { kind: 'row', id: S1, card: 'ORB-1', open: 'true', stack: 'head', text: 'first', ...row },
        {
          kind: 'row',
          id: S2,
          card: 'ORB-1',
          open: 'true',
          stack: 'member',
          text: 'second',
          ...row,
        },
        {
          kind: 'row',
          id: S3,
          card: 'ORB-1',
          open: 'true',
          stack: 'member',
          text: 'third',
          ...row,
        },
        { kind: 'row', id: S4, card: '', open: '', stack: '', text: 'plain work', ...row },
      ]);
      assert.deepEqual(
        open.slice(2, 4).map((line) => line.indent),
        [open[1]?.indent, open[1]?.indent],
        'no row of the card is indented',
      );
      const box = await readPage(
        page,
        (ids) => {
          const card = document.querySelector('#list .list-block');
          const header = document.querySelector('#list .list-section[data-section="week"]');
          if (!(card instanceof HTMLElement) || !(header instanceof HTMLElement)) return null;
          const outer = card.getBoundingClientRect();
          const inside = (id: string): boolean => {
            const row = document.querySelector(`#list [data-id="${id}"]`)?.getBoundingClientRect();
            return (
              row !== undefined &&
              row.top >= outer.top &&
              row.bottom <= outer.bottom &&
              row.left >= outer.left &&
              row.right <= outer.right
            );
          };
          const style = getComputedStyle(card);
          return {
            edge: style.borderTopWidth,
            rounded: parseFloat(style.borderTopLeftRadius) > 0,
            ownBackground: style.backgroundColor !== getComputedStyle(header).backgroundColor,
            inside: ids.map(inside),
          };
        },
        [S1, S2, S3, S4],
      );
      assert.deepEqual(box, {
        edge: '1px',
        rounded: true,
        ownBackground: true,
        inside: [true, true, true, false],
      });
      assert.equal(await captionOf(page, 'week', 'ORB-1').getAttribute('title'), 'close the group');
      assert.deepEqual((await lastView(page))['closed'], []);

      // ← on the FIRST session: closed, none of its rows drawn, its caption selected.
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      const closed = await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], '← on the first');
      await showsText(page, '#focus-zone', /^Focus: list$/); // the list zone, its caption selected
      assert.deepEqual(fields(closed[0]), {
        kind: 'caption',
        id: '',
        card: 'ORB-1',
        open: 'false',
        stack: '',
        text: 'ORB-1',
        count: '3',
        need: '',
        key: '',
        group: '',
      });
      await untilClosed(page, shut('week', 'ORB-1'));
      assert.equal(await captionOf(page, 'week', 'ORB-1').getAttribute('title'), 'open the group');
      assert.equal(await page.locator(`#list [data-id="${S1}"]`).count(), 0, 'its first not drawn');

      // ↓ ↑, j k: the row after the caption, and back to the caption.
      await page.keyboard.press('ArrowDown');
      await untilShape(page, [CLOSED('ORB-1'), `*${S4}`], '↓ from the caption');
      await page.keyboard.press('ArrowUp');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], '↑ to the caption');
      await page.keyboard.press('j');
      await untilShape(page, [CLOSED('ORB-1'), `*${S4}`], 'j from the caption');
      await page.keyboard.press('k');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], 'k to the caption');

      // → opens it and selects the first session.
      await page.keyboard.press('ArrowRight');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3, S4], '→ on the caption');
      await untilClosed(page, []);

      // ← on a MIDDLE session; then Enter on the caption: open, the first selected, no resume.
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], '← on a middle session');
      await untilClosed(page, shut('week', 'ORB-1'));
      await mark(page, 'enter');
      await page.keyboard.press('Enter');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3, S4], 'Enter on the caption');
      await untilClosed(page, []);
      await sleep(300);
      assert.ok(!(await sentAfter(page, 'enter')).includes('act'), 'Enter resumed nothing');

      // ← on the LAST session.
      await page.locator(`#list [data-id="${S3}"]`).click();
      await untilSelected(page, S3);
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], '← on the last session');
      await untilClosed(page, shut('week', 'ORB-1'));

      // On a row in no block ← and → fold and unfold Earlier, as in stage A.
      await page.keyboard.press('End');
      await untilSelected(page, S4);
      await page.keyboard.press('ArrowRight');
      await untilShape(page, [CLOSED('ORB-1'), `*${S4}`, S5], '→ unfolds Earlier');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [CLOSED('ORB-1'), `*${S4}`], '← folds Earlier');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "↑ ↓, j k, Home and End move through the rows and the CLOSED captions in the list's order: an open caption is passed over, a closed one is a stop, and the rows it hides are none",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'plain top');
      session(d, S2, 2n * MIN, 'ORB-1 a');
      session(d, S3, 3n * MIN, 'ORB-1 b');
      session(d, S4, 4n * MIN, 'ORB-2 a');
      session(d, S5, 5n * MIN, 'ORB-2 b');
      session(d, S6, 6n * MIN, 'plain bottom');
      await untilShape(
        page,
        [`*${S1}`, OPEN('ORB-1'), S2, S3, OPEN('ORB-2'), S4, S5, S6],
        'two open cards',
      );
      await captionOf(page, 'week', 'ORB-2').click();
      await untilClosed(page, shut('week', 'ORB-2'));
      await untilShape(
        page,
        [`*${S1}`, OPEN('ORB-1'), S2, S3, CLOSED('ORB-2'), S6],
        'ORB-2 closed',
      );
      await toZone(page, 'list');
      const expected = (selected: string): string[] =>
        [S1, OPEN('ORB-1'), S2, S3, CLOSED('ORB-2'), S6].map((line) =>
          line === selected ? `*${line}` : line,
        );
      for (const [key, to] of [
        ['ArrowDown', S2], // over the open caption
        ['ArrowDown', S3],
        ['ArrowDown', CLOSED('ORB-2')], // the closed caption is a stop
        ['ArrowDown', S6], // its rows are none
        ['ArrowUp', CLOSED('ORB-2')],
        ['k', S3],
        ['k', S2],
        ['k', S1], // over the open caption
        ['j', S2],
        ['End', S6],
        ['k', CLOSED('ORB-2')],
        ['Home', S1],
      ] as const) {
        await page.keyboard.press(key);
        await untilShape(page, expected(to), `${key} to ${to}`);
      }
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "a selected closed caption stands for its block, not for a session: the pane shows the group's card (`test`, `3 sessions`, ` · 1 needs you`, `→ or Enter opens the group`), no terminal is shown and none has the keyboard; `view` and `focus` say `selected: null`; d, l, F2, g, n and p say `no session selected` and send nothing; Ctrl+Shift+F, C and V act on no terminal, from the list and from the terminal zone, and nothing typed reaches a program; a filter typed keeps the caption selected and the group card; a click on the selected caption from the terminal zone opens the block, selects its first session and gives the keyboard to the list, not to that session's terminal",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2, S3]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2, S3]) {
        await resumeHere(page, id);
      }
      await untilPageReported(page, 3); // the PAGE knows each session (F6, L6)
      await untilShape(page, [OPEN('test'), S1, S2, `*${S3}`], 'the open card under Open');
      // S2 asks a question: it needs you.
      assert.equal(
        l.server.hub.input(termOf(l, S2), Buffer.from('/waiting a question\r', 'utf8')),
        'ok',
      );
      await page.waitForFunction(
        (id) =>
          document.querySelector(`#list [data-id="${id}"]`)?.getAttribute('data-attention') ===
          'asks',
        S2,
        { timeout: PAGE_WAIT_MS },
      );
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await toZone(page, 'list');
      const views = (await sentViews(page)).length;
      const focuses = (await sentFocuses(page)).length;
      await page.keyboard.press('ArrowLeft');
      await untilClosed(page, shut('open', 'test'));
      const closed = await untilShape(page, [`*${CLOSED('test')}`], 'closed, its caption selected');
      assert.equal(closed[0]?.need, ' · 1 needs you');
      await untilPane(page, 'group');
      assert.deepEqual(await groupCard(page), {
        shown: true,
        name: 'test',
        count: '3 sessions',
        need: ' · 1 needs you',
        hint: '→ or Enter opens the group',
      });
      assert.equal(await shownTerm(page), '', 'the pane names no terminal');
      assert.deepEqual(await terminalsShown(page), { terms: 0, find: false }, 'none is shown');
      assert.equal(await keyboardOn(page), 'the list');
      // Every view and focus from the one that selected the caption on says `selected: null`.
      const since = (messages: Record<string, unknown>[]): unknown[] => {
        const selected = messages.map((message) => message['selected']);
        return selected.slice(Math.max(0, selected.indexOf(null)));
      };
      const viewed = since((await sentViews(page)).slice(views));
      assert.ok(viewed.length > 0, 'views were sent');
      assert.deepEqual(
        viewed,
        viewed.map(() => null),
        'each view says selected: null',
      );
      const focused = since((await sentFocuses(page)).slice(focuses));
      assert.ok(focused.length > 0, 'a focus was sent');
      assert.deepEqual(
        focused,
        focused.map(() => null),
        'each focus says selected: null',
      );

      // The keys that act on a session: each says so and does nothing.
      const inputs = [S1, S2, S3].map((id) => inputOf(d.record, id));
      await mark(page, 'keys');
      for (const key of ['d', 'l', 'F2', 'g', 'n', 'p']) {
        await clearKeyBar(page);
        await page.keyboard.press(key);
        await showsText(page, '#key-message', NO_SESSION);
        assert.equal(await editorShown(page), false, `${key} opens no dialog`);
      }
      // The window's keys of a terminal: no find bar, nothing copied or pasted, from the list…
      for (const chord of ['Control+Shift+F', 'Control+Shift+C', 'Control+Shift+V']) {
        await page.keyboard.press(chord);
      }
      await sleep(300);
      assert.deepEqual(await terminalsShown(page), { terms: 0, find: false });
      assert.equal(await keyboardOn(page), 'the list');
      // …and from the terminal zone: the zone itself has the keyboard, no terminal.
      await toZone(page, 'terminal');
      assert.equal(await active(page), '#right-zone', 'the zone has the keyboard, no terminal');
      for (const chord of ['Control+Shift+F', 'Control+Shift+C', 'Control+Shift+V']) {
        await page.keyboard.press(chord);
      }
      await page.keyboard.type('typedonthecaption');
      await sleep(500);
      assert.deepEqual(await terminalsShown(page), { terms: 0, find: false });
      assert.equal(await active(page), '#right-zone');
      assert.deepEqual(
        [S1, S2, S3].map((id) => inputOf(d.record, id)),
        inputs,
        'no program read anything',
      );
      assert.deepEqual(
        (await sentAfter(page, 'keys')).filter((type) => type !== 'focus'),
        [],
        'nothing sent but focus',
      );
      assert.ok(
        (await sentFocuses(page)).slice(focuses).every((focus) => focus['selected'] === null),
        'each focus with selected: null',
      );
      assert.equal(await selectedLine(page), 'caption test');

      // A filter typed (ruled (b)): no caption drawn, but the caption stays selected, and its card.
      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('test');
      await untilShape(page, [S1, S2, S3], 'flat rows while filtering');
      assert.equal(await selectedLine(page), 'nothing', 'nothing drawn selected');
      await untilPane(page, 'group');
      assert.equal((await groupCard(page)).name, 'test', 'the group card stays');
      assert.equal((await lastView(page))['selected'], null);
      await page.keyboard.press('Escape');
      await untilShape(page, [`*${CLOSED('test')}`], 'the filter cleared: the caption selected');
      assert.equal(await keyboardOn(page), 'the list');
      await clearKeyBar(page);
      await page.keyboard.press('d');
      await showsText(page, '#key-message', NO_SESSION);

      // A click on the selected caption from the terminal zone: open, its first session
      // selected, the keyboard on the list (ruled (e)) — not in S1's terminal, which is shown.
      await toZone(page, 'terminal');
      const before1 = inputOf(d.record, S1);
      await captionOf(page, 'open', 'test').click();
      await untilShape(page, [OPEN('test'), `*${S1}`, S2, S3], 'open, its first selected');
      await untilClosed(page, []);
      await showsText(page, '#focus-zone', /^Focus: list$/);
      assert.equal(await keyboardOn(page), 'the list');
      await untilPane(page, 'terminal');
      assert.equal(await shownTerm(page), termOf(l, S1));
      await page.keyboard.type('xyz');
      await sleep(500);
      assert.equal(inputOf(d.record, S1), before1, 'nothing typed reached its program');
      assert.equal(await keyboardOn(page), 'the list');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "right after ← the list may still draw the card open (the server's answer has not come, ruled (c)): its caption is drawn selected on the open card, no row is, the pane shows the group's card; → there opens the block and selects its first session, and so does Enter, resuming nothing",
    async (t) => {
      const rows: ScriptedRow[] = [
        { id: S1, group: 'test', title: 'one' },
        { id: S2, group: 'test', title: 'two' },
        { id: S3, group: 'test', title: 'three' },
        { id: S4, group: null, title: 'four' },
      ];
      const { page, world, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => blockedList(rows, [], closedOf(w()), selected),
      );
      const resend = (): void =>
        world.list((selected) => blockedList(rows, [], closedOf(world), selected));
      await untilShape(page, [OPEN('test'), `*${S1}`, S2, S3, S4], 'the open card');
      await toZone(page, 'list');
      for (const [key, from] of [
        ['ArrowRight', S2],
        ['Enter', S3],
      ] as const) {
        await page.locator(`#list [data-id="${from}"]`).click();
        await untilSelected(page, from);
        world.holdViews(true);
        await page.keyboard.press('ArrowLeft');
        await untilShape(page, [`*${OPEN('test')}`, S1, S2, S3, S4], `← on ${from}, no answer yet`);
        await untilPane(page, 'group');
        assert.equal((await groupCard(page)).count, '3 sessions');
        await page.keyboard.press(key);
        await untilShape(page, [OPEN('test'), `*${S1}`, S2, S3, S4], `${key} on the caption`);
        assert.equal(world.selected(), S1, 'the last view selects the first session');
        assert.deepEqual(closedOf(world), [], 'and names the block open');
        world.holdViews(false);
        resend();
        await sleep(300);
        assert.deepEqual(shapeOf(await lines(page)), [OPEN('test'), `*${S1}`, S2, S3, S4]);
      }
      assert.deepEqual(world.acts(), [], 'nothing resumed');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    "← on the first, a middle and the last session of an open card sends the closing and the caption's `selected: null` together (ruled 1), and →, Enter and a click on the selected closed caption open the block before they select its first session: no view the page sends names the block closed while one of its sessions is selected",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3, S4], 'the open card');
      await toZone(page, 'list');
      const block = new Set([S1, S2, S3]);
      /** The views sent since the `from`-th that name ORB-1 closed with a session of it selected. */
      const offending = async (from: number): Promise<Record<string, unknown>[]> =>
        (await sentViews(page))
          .slice(from)
          .filter(
            (view) =>
              block.has(view['selected'] as string) &&
              ((view['closed'] ?? []) as ClosedBlock[]).some(
                (one) => one.section === 'week' && one.group === 'ORB-1',
              ),
          );
      await mark(page, 'ruled 1');
      for (const [id, opener] of [
        [S1, 'ArrowRight'],
        [S2, 'Enter'],
        [S3, 'click'],
      ] as const) {
        await page.locator(`#list [data-id="${id}"]`).click();
        await untilSelected(page, id);
        const from = (await sentViews(page)).length;
        await page.keyboard.press('ArrowLeft');
        await untilClosed(page, shut('week', 'ORB-1'));
        await sleep(200); // a later view of the same ← would come now
        assert.deepEqual(
          await offending(from),
          [],
          `← on ${id}: no view closes it with it selected`,
        );
        await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], `← on ${id}: its caption selected`);
        // Opened again from the selected caption (ruled 3): the block's leaving `closed` and its
        // first session's selection in ONE view — none names it closed with S1 selected, and none
        // before that one names it open with nothing selected.
        const opened = (await sentViews(page)).length;
        if (opener === 'click') await captionOf(page, 'week', 'ORB-1').click();
        else await page.keyboard.press(opener);
        await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3, S4], `${opener}: open again`);
        await untilClosed(page, []);
        await sleep(200);
        assert.deepEqual(
          await offending(opened),
          [],
          `${opener}: no view names it closed with its first selected`,
        );
        const since = (await sentViews(page)).slice(opened);
        const firstSelect = since.findIndex((view) => view['selected'] === S1);
        assert.ok(firstSelect !== -1, `${opener}: a view selects S1`);
        assert.deepEqual(
          since.slice(0, firstSelect + 1).map((view) => [view['selected'], view['closed']]),
          [[S1, []]],
          `${opener}: the first view after it selects S1 and names the block open, together`,
        );
      }
      assert.ok(!(await sentAfter(page, 'ruled 1')).includes('act'), 'nothing resumed');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "right after ←, before the list that draws the card closed (ruled 2), ↓ and j select the line AFTER the card and ↑ and k the line before it — never the list's first line: the still-open card counts as its caption, its rows as none",
    async (t) => {
      const rows: ScriptedRow[] = [
        { id: S5, group: null, title: 'five' },
        { id: S6, group: null, title: 'six' },
        { id: S1, group: 'test', title: 'one' },
        { id: S2, group: 'test', title: 'two' },
        { id: S3, group: 'test', title: 'three' },
        { id: S4, group: null, title: 'four' },
      ];
      const { page, world, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => blockedList(rows, [], closedOf(w()), selected),
      );
      const resend = (): void =>
        world.list((selected) => blockedList(rows, [], closedOf(world), selected));
      const open = [S5, S6, OPEN('test'), S1, S2, S3, S4];
      const marked = (shape: string[], selected: string): string[] =>
        shape.map((line) => (line === selected ? `*${line}` : line));
      await untilShape(page, marked(open, S5), 'a card between rows');
      await toZone(page, 'list');
      for (const [key, to] of [
        ['ArrowDown', S4],
        ['ArrowUp', S6],
        ['j', S4],
        ['k', S6],
      ] as const) {
        await page.locator(`#list [data-id="${S2}"]`).click();
        await untilSelected(page, S2);
        world.holdViews(true);
        await page.keyboard.press('ArrowLeft');
        await untilShape(page, marked(open, OPEN('test')), `← on S2, no answer yet`);
        await page.keyboard.press(key);
        await untilShape(page, marked(open, to), `${key} from the still-open card: ${to}`);
        world.holdViews(false);
        resend();
        await untilShape(page, marked([S5, S6, CLOSED('test'), S4], to), 'the answer: closed');
        await captionOf(page, 'open', 'test').click(); // the selection elsewhere: it opens
        await untilShape(page, marked(open, to), 'open again');
      }
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    "right after →, Enter or a click on the selected caption, before the list that draws the block open (review 2's mirror of ruled 2): ↓ and j select the line AFTER the caption, ↑ and k the line BEFORE it — never the list's first line",
    async (t) => {
      const rows: ScriptedRow[] = [
        { id: S5, group: null, title: 'five' },
        { id: S6, group: null, title: 'six' },
        { id: S1, group: 'test', title: 'one' },
        { id: S2, group: 'test', title: 'two' },
        { id: S3, group: 'test', title: 'three' },
        { id: S4, group: null, title: 'four' },
      ];
      const { page, world, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => blockedList(rows, [], closedOf(w()), selected),
      );
      const resend = (): void =>
        world.list((selected) => blockedList(rows, [], closedOf(world), selected));
      const open = [S5, S6, OPEN('test'), S1, S2, S3, S4];
      const closedShape = [S5, S6, CLOSED('test'), S4];
      const marked = (shape: string[], selected: string): string[] =>
        shape.map((line) => (line === selected ? `*${line}` : line));
      await untilShape(page, marked(open, S5), 'a card between rows');
      await toZone(page, 'list');
      for (const opener of ['ArrowRight', 'Enter', 'click'] as const) {
        for (const [move, to] of [
          ['ArrowDown', S4],
          ['j', S4],
          ['ArrowUp', S6],
          ['k', S6],
        ] as const) {
          await page.locator(`#list [data-id="${S2}"]`).click();
          await untilSelected(page, S2);
          await page.keyboard.press('ArrowLeft');
          await untilShape(
            page,
            marked(closedShape, CLOSED('test')),
            'closed, its caption selected',
          );
          world.holdViews(true);
          if (opener === 'click') await captionOf(page, 'open', 'test').click();
          else await page.keyboard.press(opener);
          await until(async () => world.selected() === S1, `${opener}: the view selects S1`);
          await page.keyboard.press(move);
          await until(
            async () => world.selected() === to,
            `${opener} then ${move}: the view selects ${to}`,
          );
          await untilShape(
            page,
            marked(closedShape, to),
            `${opener} then ${move}: ${to} drawn selected`,
          );
          world.holdViews(false);
          resend();
          await untilShape(page, marked(open, to), 'the answer: open, the selection kept');
        }
      }
      assert.deepEqual(world.acts(), [], 'nothing resumed');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    '→ then ←, before the list that draws the block open, with the block in an unfolded Earlier (review 2): Earlier stays unfolded and the block is closed again with its caption selected, in one view (closed with it, selected null), and the answer draws the caption selected; and → then a fold of Earlier selects the line above Earlier, never leaving the hidden session selected',
    async (t) => {
      const openRows: ScriptedRow[] = [
        { id: S5, group: null, title: 'five' },
        { id: S6, group: null, title: 'six' },
      ];
      const earlierRows: ScriptedRow[] = [
        { id: S1, group: 'test', title: 'one' },
        { id: S2, group: 'test', title: 'two' },
        { id: S4, group: null, title: 'four' },
      ];
      /** Open's rows as `blockedList` draws them, then Earlier, folded unless the page's last view
       *  unfolds it, whose rows the server's rule draws too (after s2-qf9's probe). */
      const twoSections = (world: EditWorld | null, selected: string | null) => {
        const closed = closedOf(world);
        const views = (world?.sent ?? []).filter((message) => message['t'] === 'view');
        const unfolded = ((views.at(-1)?.['unfolded'] ?? []) as string[]).includes('earlier');
        const open = blockedList(openRows, [], closed, selected) as {
          sections: Record<string, unknown>[];
        } & Record<string, unknown>;
        const earlier = blockedList(
          earlierRows,
          [],
          closed
            .filter((one) => one.section === 'earlier')
            .map((one) => ({ section: 'open' as const, group: one.group })),
          selected,
        ) as {
          sections: (Record<string, unknown> & { rows: unknown[]; closedStacks: unknown[] })[];
        };
        const part = earlier.sections[0];
        return {
          ...open,
          sections: [
            open.sections[0],
            {
              ...part,
              name: 'earlier',
              folded: !unfolded,
              count: earlierRows.length,
              rows: unfolded ? (part?.rows ?? []) : [],
              closedStacks: unfolded ? (part?.closedStacks ?? []) : [],
            },
          ],
        };
      };
      const { page, world, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => twoSections(w(), selected),
      );
      const resend = (): void => world.list((selected) => twoSections(world, selected));
      const views = (from: number): [unknown, unknown, unknown][] =>
        world.sent
          .slice(from)
          .filter((message) => message['t'] === 'view')
          .map((view) => [view['selected'], view['closed'], view['unfolded']]);
      await untilShape(page, [`*${S5}`, S6], 'Earlier folded');
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await untilShape(page, [`*${S5}`, S6, OPEN('test'), S1, S2, S4], 'Earlier unfolded');
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [S5, S6, `*${CLOSED('test')}`, S4], 'closed in Earlier');

      // → then ←, the answer held: two views, the second closing it again with nothing selected.
      world.holdViews(true);
      let from = world.sent.length;
      await page.keyboard.press('ArrowRight');
      await until(async () => world.selected() === S1, '→: the view selects S1');
      await page.keyboard.press('ArrowLeft');
      await until(async () => views(from).length >= 2, '←: a second view');
      await sleep(300);
      assert.deepEqual(views(from), [
        [S1, [], ['earlier']],
        [null, shut('earlier', 'test'), ['earlier']],
      ]);
      world.holdViews(false);
      resend();
      await untilShape(
        page,
        [S5, S6, `*${CLOSED('test')}`, S4],
        'the answer: its caption selected',
      );
      assert.equal(await selectedLine(page), 'caption test');
      await untilPane(page, 'group');

      // → then a fold of Earlier (a click on its header), the answer held: the line above
      // Earlier is selected (S6), and Earlier folds.
      world.holdViews(true);
      from = world.sent.length;
      await page.keyboard.press('ArrowRight');
      await until(async () => world.selected() === S1, '→ again: the view selects S1');
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await until(
        async () => JSON.stringify(views(from).at(-1)?.[2]) === '[]',
        'a view folds Earlier',
      );
      assert.equal(world.selected(), S6, 'the line above Earlier is selected');
      world.holdViews(false);
      resend();
      await untilShape(page, [S5, `*${S6}`], 'Earlier folded, S6 selected');
      assert.deepEqual(world.acts(), [], 'nothing resumed');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a held ← on a session of an open card in an unfolded Earlier closes the block and selects its caption once: its auto-repeats do nothing on the caption (ruled (d)) — Earlier stays unfolded and no session above is selected; a fresh ← on a caption in Earlier folds Earlier and selects the line above it (ruled (g)): a row, or a closed caption',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'plain recent');
      session(d, S4, 2n * MIN, 'ORB-1 a');
      session(d, S5, 3n * MIN, 'ORB-1 b');
      session(d, S2, 20n * DAY, 'ORB-9 old a');
      session(d, S3, 21n * DAY, 'ORB-9 old b');
      await untilShape(page, [`*${S1}`, OPEN('ORB-1'), S4, S5], 'Recent, Earlier folded');
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await untilShape(
        page,
        [`*${S1}`, OPEN('ORB-1'), S4, S5, OPEN('ORB-9'), S2, S3],
        'Earlier unfolded',
      );
      await page.locator(`#list [data-id="${S3}"]`).click();
      await untilSelected(page, S3);
      await toZone(page, 'list');

      // ← held: its first keydown closes ORB-9 and selects the caption; the repeats — as a
      // person's, after the list that draws it closed — do nothing.
      await page.keyboard.down('ArrowLeft');
      await untilShape(page, [S1, OPEN('ORB-1'), S4, S5, `*${CLOSED('ORB-9')}`], 'ORB-9 closed');
      for (let repeat = 0; repeat < 4; repeat++) await page.keyboard.down('ArrowLeft');
      await page.keyboard.up('ArrowLeft');
      await sleep(500);
      assert.deepEqual((await lastView(page))['closed'], shut('earlier', 'ORB-9'));
      assert.deepEqual(
        shapeOf(await lines(page)),
        [S1, OPEN('ORB-1'), S4, S5, `*${CLOSED('ORB-9')}`],
        'the caption selected, Earlier still unfolded',
      );
      assert.deepEqual((await lastView(page))['unfolded'], ['earlier']);
      assert.equal(await selectedLine(page), 'caption ORB-9');

      // A fresh ←: Earlier folds, and the line above it is selected — here a row.
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [S1, OPEN('ORB-1'), S4, `*${S5}`], 'Earlier folded, S5 selected');
      assert.deepEqual((await lastView(page))['unfolded'], []);

      // The line above a closed caption: ORB-1 closed (← on S5), Earlier unfolded, ↓ to ORB-9.
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [S1, `*${CLOSED('ORB-1')}`], 'ORB-1 closed');
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await untilShape(
        page,
        [S1, `*${CLOSED('ORB-1')}`, CLOSED('ORB-9')],
        'Earlier unfolded: ORB-9 still closed',
      );
      await page.keyboard.press('ArrowDown');
      await untilShape(page, [S1, CLOSED('ORB-1'), `*${CLOSED('ORB-9')}`], '↓ to ORB-9');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [S1, `*${CLOSED('ORB-1')}`], 'Earlier folded, ORB-1 selected');
      assert.deepEqual((await lastView(page))['unfolded'], []);
      assert.deepEqual((await lastView(page))['closed'], [
        ...shut('earlier', 'ORB-9'),
        ...shut('week', 'ORB-1'),
      ]);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'an Enter held on a selected caption opens the block and selects its first session once: its auto-repeats never resume that session (ruled (d)); a fresh Enter on it resumes it',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'plain work');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3], 'the open card');
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S3], 'its caption selected');
      await untilClosed(page, shut('week', 'ORB-1'));

      // As a person's held key: its repeats come after the list that draws the block open.
      await mark(page, 'held');
      await page.keyboard.down('Enter');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3], 'open, its first selected');
      for (let repeat = 0; repeat < 4; repeat++) await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await sleep(500);
      assert.deepEqual(
        (await sentAfter(page, 'held')).filter((type) => type === 'act'),
        [],
        'nothing resumed',
      );
      await untilPane(page, 'resume');

      // The guard lets go at the release: a fresh Enter resumes S1.
      await mark(page, 'fresh');
      await page.keyboard.press('Enter');
      await until(async () => (await sentAfter(page, 'fresh')).includes('act'), 'S1 resumed');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'Ctrl+Tab back to a session of an open card selects it; from a selected caption Ctrl+Tab skips the sessions of the closed block that no terminal of the window holds — a middle one and the first — as it skips a filtered or a folded row',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3, S4], 'the open card');

      await toZone(page, 'list');
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await page.keyboard.press('Control+Tab');
      await untilShape(page, [OPEN('ORB-1'), S1, `*${S2}`, S3, S4], 'back to S2, the card open');

      // ← on S2: the caption selected. Ctrl+Tab skips S2 (hidden, no terminal): S4.
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], 'closed');
      await untilClosed(page, shut('week', 'ORB-1'));
      await page.keyboard.press('Control+Tab');
      await untilShape(page, [CLOSED('ORB-1'), `*${S4}`], 'Ctrl+Tab: S4');
      // From S4 the sessions before are S2 and S1, the FIRST: both hidden, both skipped.
      await clearKeyBar(page);
      await page.keyboard.press('Control+Tab');
      await showsText(page, '#key-message', /^no previous session$/);
      await sleep(300);
      assert.deepEqual(shapeOf(await lines(page)), [CLOSED('ORB-1'), `*${S4}`]);
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'));
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a selected caption whose block dissolves (one session of its group left) leaves NOTHING selected — never a session — and the pane empty (ruled (a)); ↓ then takes the first line; K5: the block that forms again under the remembered closing around the selected FIRST session is drawn open, the page forgets that it closed it, and it stays open when the selection leaves; a reload forgets every closing',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilShape(page, [OPEN('ORB-1'), `*${S2}`, S3, S4], 'the open card of two');
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S4], 'closed, its caption selected');
      await untilClosed(page, shut('week', 'ORB-1'));

      // S3 goes to another group: ORB-1 is a block no more, and nothing is selected.
      const views = (await sentViews(page)).length;
      setGroup(d.deck, S3, 'other');
      await untilShape(page, [S2, S3, S4], 'no block: three rows, none selected');
      await untilPane(page, 'none');
      assert.equal(await selectedLine(page), 'nothing');
      assert.deepEqual(
        (await sentViews(page)).slice(views).map((view) => view['selected']),
        [],
        'no view selects a session',
      );
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'), 'still named');
      await page.keyboard.press('ArrowDown');
      await untilShape(page, [`*${S2}`, S3, S4], '↓ with nothing selected: the first line');

      // S3 back in ORB-1: the block forms again around the selected S2, its FIRST, under the
      // closing the page still names — drawn open, and the page forgets the closing.
      setGroup(d.deck, S3, 'ORB-1');
      const formed = await untilShape(
        page,
        [OPEN('ORB-1'), `*${S2}`, S3, S4],
        'formed again, open for its selected first session',
      );
      assert.deepEqual(
        formed.map((line) => line.stack),
        ['', 'head', 'member', ''],
      );
      await untilClosed(page, []);

      // The selection leaves the block: it stays open.
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [OPEN('ORB-1'), S2, S3, `*${S4}`]);
      assert.deepEqual((await lastView(page))['closed'], []);

      // A reload (F5, from the list) forgets a closing: the page starts again with every block open.
      await captionOf(page, 'week', 'ORB-1').click();
      await untilShape(page, [CLOSED('ORB-1'), `*${S4}`], 'closed again');
      await page.evaluate(() => Reflect.set(globalThis, 'beforeReload', true));
      await page.keyboard.press('F5');
      await page.waitForFunction(
        () => Reflect.get(globalThis, 'beforeReload') === undefined,
        null,
        {
          timeout: PAGE_WAIT_MS,
        },
      );
      await connection(page, 'open');
      await untilRows(page, [S2, S3, S4], 'every block open after the reload');
      const after = await sentViews(page);
      assert.ok(after.length > 0);
      assert.ok(
        after.every((view) => JSON.stringify(view['closed']) === '[]'),
        'no view after the reload closes a block',
      );
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a selected caption whose block a session starting into it opens ((c2): a terminal that has not reported) leaves NOTHING selected, the pane empty, and no key acts until the owner moves: d, l, F2, g, n and p say `no session selected`, Enter does nothing, nothing selects a session; with nothing selected ↑ takes the first line — a closed caption, as good a first stop as a row; ← and a click on the held block say why they do nothing, the slot chord reaches its row; once reported the block stays open and ← closes it',
    async (t) => {
      let reported = true;
      const rows: ScriptedRow[] = [
        { id: S3, group: 'alpha', title: 'three' },
        { id: S4, group: 'alpha', title: 'four' },
        { id: S1, group: 'test', title: 'one' },
        { id: S2, group: 'test', title: 'two' },
      ];
      const terms = (): ScriptedTerm[] => [
        { id: TERM_A, slot: 1, of: S1, sessionId: S1, state: 'running' },
        { id: TERM_B, slot: 2, of: S2, sessionId: reported ? S2 : null, state: 'running' },
      ];
      const { page, world, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => blockedList(rows, terms(), closedOf(w()), selected),
      );
      const resend = (): void =>
        world.list((selected) => blockedList(rows, terms(), closedOf(world), selected));
      await untilShape(page, [OPEN('alpha'), `*${S3}`, S4, OPEN('test'), S1, S2], 'two cards');
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('alpha')}`, OPEN('test'), S1, S2], 'alpha closed');
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S1);
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [CLOSED('alpha'), `*${CLOSED('test')}`], 'test closed, its caption');
      assert.deepEqual(closedOf(world), [...shut('open', 'alpha'), ...shut('open', 'test')]);

      // S2 starts again into it and has not reported: the block is drawn open, nothing selected.
      reported = false;
      resend();
      await untilShape(page, [CLOSED('alpha'), OPEN('test'), S1, S2], 'open, nothing selected');
      await untilPane(page, 'none');
      assert.deepEqual(closedOf(world), shut('open', 'alpha'), 'the page forgot it closed test');
      const from = world.sent.length;
      for (const key of ['d', 'l', 'F2', 'g', 'n', 'p']) {
        await clearKeyBar(page);
        await page.keyboard.press(key);
        await showsText(page, '#key-message', NO_SESSION);
        assert.equal(await editorShown(page), false, `${key} opens no dialog`);
      }
      await page.keyboard.press('Enter');
      await sleep(300);
      assert.equal(await selectedLine(page), 'nothing', 'no key selected anything');
      assert.deepEqual(world.acts(), [], 'no act');
      assert.deepEqual(
        world.sent
          .slice(from)
          .filter((message) => message['selected'] !== undefined && message['selected'] !== null),
        [],
        'no view or focus selects a session',
      );
      // A click on the held block's caption: it says why; no view.
      await clearKeyBar(page);
      await captionOf(page, 'open', 'test').click();
      await showsText(page, '#key-message', STARTING);
      assert.equal(world.sent.slice(from).filter((m) => m['t'] === 'view').length, 0, 'no view');

      // ↑ with nothing selected: the first line, the closed caption of alpha; then ↓ to S1, ←.
      await page.keyboard.press('ArrowUp');
      await untilShape(page, [`*${CLOSED('alpha')}`, OPEN('test'), S1, S2], '↑: the first line');
      await untilPane(page, 'group');
      assert.equal((await groupCard(page)).name, 'alpha');
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S1);
      const views = world.sent.filter((message) => message['t'] === 'view').length;
      await clearKeyBar(page);
      await page.keyboard.press('ArrowLeft');
      await showsText(page, '#key-message', STARTING);
      assert.equal(world.sent.filter((m) => m['t'] === 'view').length, views, '← sends no view');
      assert.equal(await selectedRow(page), S1);
      // The slot chord reaches the drawn row of the unreported terminal.
      await page.keyboard.press('Control+Shift+Digit2');
      await untilSelected(page, S2);

      // Reported: the block stays open (the page forgot it was closed); ← on S1 closes it.
      reported = true;
      resend();
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await toZone(page, 'list');
      assert.deepEqual(shapeOf(await lines(page)), [CLOSED('alpha'), OPEN('test'), `*${S1}`, S2]);
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [CLOSED('alpha'), `*${CLOSED('test')}`], 'closed: the guard let go');
      assert.deepEqual(closedOf(world), [...shut('open', 'alpha'), ...shut('open', 'test')]);
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    "a block an unreported terminal holds open says which (F6, L1): `still starting` while that terminal may still start (`reconnecting` too), the ended line once it ended at its start, on ← and on a click on the caption; the starting line when both kinds hold it, in either order; the selected session's line before both; the guard lets go once the ended terminal is closed; F9: the FIRST session's unreported terminal holds it open too — a closed block is drawn open for it, its selected caption dropped, ← and the click refused",
    async (t) => {
      // The server's own rules over the rows of `test` under Open — S1 in TERM_A, S2 in TERM_B,
      // S3 in TERM_C, each present or not, reported or not, in any state — and S4, in no block,
      // where the selection waits while the caption is clicked. (The real server lists an ended,
      // unreported row in Recent or Earlier and a starting one under Open, so one block never holds
      // both kinds; the page's rule does not depend on the section, and this case holds that the
      // starting line wins, whichever row comes first.)
      const term = (
        id: string,
        slot: number,
        of: string,
        sessionId: string | null,
        state: string,
      ) => ({ id, slot, of, sessionId, state }) satisfies ScriptedTerm;
      let terms: ScriptedTerm[] = [
        term(TERM_A, 1, S1, S1, 'running'),
        term(TERM_B, 2, S2, S2, 'running'),
      ];
      let ids = [S1, S2, S4];
      const rowsNow = (): ScriptedRow[] =>
        ids.map((id) => ({ id, group: id === S4 ? null : 'test', title: id.slice(0, 4) }));
      const { page, world, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => blockedList(rowsNow(), terms, closedOf(w()), selected),
      );
      /** Sets the terminals (and the rows), sends the list, and waits until `fact` holds of it. */
      const step = async (
        next: ScriptedTerm[],
        nextIds: string[],
        fact: () => Promise<boolean>,
        what: string,
      ): Promise<void> => {
        terms = next;
        ids = nextIds;
        world.list((selected) => blockedList(rowsNow(), terms, closedOf(world), selected));
        await until(fact, what);
      };
      /** A row's state line ('' when none, null when the row is not drawn). */
      const stateOf = async (id: string): Promise<string | null> =>
        readPage(
          page,
          (id) => {
            const row = document.querySelector(`#list [data-id="${id}"]`);
            if (row === null) return null;
            const line = row.querySelector('.row-state');
            return line instanceof HTMLElement && line.checkVisibility()
              ? (line.textContent ?? '')
              : '';
          },
          id,
        );
      const viewCount = (): number => world.sent.filter((m) => m['t'] === 'view').length;
      /** ← on the block's selected first session, then a click on its caption with the selection
       *  on S4: each says `line`, nothing is sent, the selection stays. */
      const refusesBoth = async (line: RegExp, what: string): Promise<void> => {
        await page.keyboard.press('Home'); // the first session: an open caption is no stop
        await untilSelected(page, S1);
        let views = viewCount();
        await clearKeyBar(page);
        await page.keyboard.press('ArrowLeft');
        await showsText(page, '#key-message', line);
        assert.equal(viewCount(), views, `${what}: ← sends no view`);
        assert.equal(await selectedRow(page), S1, `${what}: S1 stays selected`);
        await page.keyboard.press('End');
        await untilSelected(page, S4);
        views = viewCount();
        await clearKeyBar(page);
        await captionOf(page, 'open', 'test').click();
        await showsText(page, '#key-message', line);
        assert.equal(viewCount(), views, `${what}: the click sends no view`);
        assert.equal(await selectedRow(page), S4, `${what}: S4 stays selected`);
      };
      const shapeIs = (want: string[]) => async (): Promise<boolean> =>
        JSON.stringify(shapeOf(await lines(page))) === JSON.stringify(want);
      await untilShape(page, [OPEN('test'), `*${S1}`, S2, S4], 'the open card');
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('test')}`, S4], 'closed');
      assert.deepEqual(closedOf(world), shut('open', 'test'));

      // S2's terminal ended at its start: the block is drawn open (its caption no longer
      // selected: nothing is), and ← and the click say the ended line.
      await step(
        [term(TERM_A, 1, S1, S1, 'running'), term(TERM_B, 2, S2, null, 'ended')],
        [S1, S2, S4],
        shapeIs([OPEN('test'), S1, S2, S4]),
        'open for the ended, unreported terminal',
      );
      assert.deepEqual(closedOf(world), []);
      await refusesBoth(ENDED, 'ended');

      // S2's terminal reconnecting, unreported: it may still start — the starting line.
      await step(
        [term(TERM_A, 1, S1, S1, 'running'), term(TERM_B, 2, S2, null, 'reconnecting')],
        [S1, S2, S4],
        async () => (await stateOf(S2)) === 'starting…',
        'S2 starting again',
      );
      await refusesBoth(STARTING, 'reconnecting');

      // Both kinds, in both orders: the starting line.
      await step(
        [
          term(TERM_A, 1, S1, S1, 'running'),
          term(TERM_B, 2, S2, null, 'starting'),
          term(TERM_C, 3, S3, null, 'ended'),
        ],
        [S1, S2, S3, S4],
        async () => (await rowIds(page)).length === 4 && (await stateOf(S3)) === '',
        'S2 starting, S3 ended',
      );
      await refusesBoth(STARTING, 'starting, then ended');
      await step(
        [
          term(TERM_A, 1, S1, S1, 'running'),
          term(TERM_B, 2, S2, null, 'ended'),
          term(TERM_C, 3, S3, null, 'starting'),
        ],
        [S1, S2, S3, S4],
        async () => (await stateOf(S2)) === '' && (await stateOf(S3)) === 'starting…',
        'S2 ended, S3 starting',
      );
      await refusesBoth(STARTING, 'ended, then starting');

      // A session of the block selected: on the click its line comes first.
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await clearKeyBar(page);
      await captionOf(page, 'open', 'test').click();
      await showsText(page, '#key-message', HOLDS_SELECTED);
      assert.equal(await selectedRow(page), S2);
      await toZone(page, 'list');

      // S3 leaves; the ended terminal is closed (S2 keeps its row, without a terminal): ← closes.
      await step(
        [term(TERM_A, 1, S1, S1, 'running')],
        [S1, S2, S4],
        async () => {
          const s2 = await readPage(
            page,
            (id) =>
              document.querySelector(`#list [data-id="${id}"] .row-slot`)?.textContent ?? null,
            S2,
          );
          return (await rowIds(page)).join() === [S1, S2, S4].join() && s2 === '';
        },
        'S3 gone, S2 without a terminal',
      );
      await page.keyboard.press('Home');
      await untilSelected(page, S1);
      await clearKeyBar(page);
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('test')}`, S4], 'closed: the guard let go');
      assert.deepEqual(closedOf(world), shut('open', 'test'));

      // F9: the FIRST session's terminal unreported: the closed block is drawn open for it (its
      // caption no longer selected), the page forgets the closing, ← and the click are refused.
      await step(
        [term(TERM_A, 1, S1, null, 'starting')],
        [S1, S2, S4],
        async () =>
          (await shapeIs([OPEN('test'), S1, S2, S4])()) && (await stateOf(S1)) === 'starting…',
        'open for its first, unreported',
      );
      assert.deepEqual(closedOf(world), [], 'the page forgot it closed it');
      await untilPane(page, 'none');
      await refusesBoth(STARTING, 'the first starting');

      // Reported: ← on it closes the block.
      await step(
        [term(TERM_A, 1, S1, S1, 'running')],
        [S1, S2, S4],
        async () => (await stateOf(S1)) !== 'starting…',
        'the first reported',
      );
      await page.keyboard.press('Home');
      await untilSelected(page, S1);
      await clearKeyBar(page);
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('test')}`, S4], 'closed');
      assert.equal(await shownText(page, '#key-message'), '', 'nothing refused');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'three running sessions of one group are a card under Open, open by default, with their slot numbers; ← closes it (its caption selected) and → opens it; a slot chord of a hidden member and of the hidden FIRST, Ctrl+Tab from the caption and a switcher pick of a hidden member and of the hidden first (a terminal of the window holds each) select it and open its block',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2, S3]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2, S3]) {
        await resumeHere(page, id);
      }
      // Each program has reported its session (S2 7.5), so that a terminal's slot names it: a
      // slot chord reaches a hidden session through its terminal (a named limit before that).
      await untilPageReported(page, 3); // the PAGE knows each session (F6, L6)
      const open = await untilShape(page, [OPEN('test'), S1, S2, `*${S3}`], 'the card under Open');
      assert.deepEqual(
        open.map(({ section, slot }) => [section, slot]),
        [
          ['open', ''],
          ['open', '1'],
          ['open', '2'],
          ['open', '3'],
        ],
      );
      /** ← on `id` (selected) from the list: the block closes, its caption selected. */
      const closeFrom = async (id: string): Promise<void> => {
        await untilSelected(page, id);
        await toZone(page, 'list');
        await page.keyboard.press('ArrowLeft');
        await untilShape(page, [`*${CLOSED('test')}`], `closed from ${id}: its caption alone`);
        await untilClosed(page, shut('open', 'test'));
      };
      /** `id` is selected, its block open, and the page forgot the closing. */
      const openedFor = async (id: string, what: string): Promise<void> => {
        await untilSelected(page, id);
        await untilShape(
          page,
          [OPEN('test'), ...[S1, S2, S3].map((one) => (one === id ? `*${one}` : one))],
          what,
        );
        await untilClosed(page, []);
      };

      await page.locator(`#list [data-id="${S1}"]`).click();
      await closeFrom(S1);
      await page.keyboard.press('ArrowRight');
      await openedFor(S1, '→ opens it');

      // A slot chord of a hidden member, then of the hidden first.
      await closeFrom(S1);
      await page.keyboard.press('Control+Shift+Digit3');
      await openedFor(S3, 'open for the chord of slot 3');
      await closeFrom(S3);
      await page.keyboard.press('Control+Shift+Digit1');
      await openedFor(S1, 'open for the chord of slot 1, its first');

      // Ctrl+Tab from the caption: the session selected last, S1, the hidden first.
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.locator(`#list [data-id="${S1}"]`).click();
      await closeFrom(S1);
      await page.keyboard.press('Control+Tab');
      await openedFor(S1, 'open for Ctrl+Tab');

      // A pick in the switcher of a hidden member, then of the hidden first.
      for (const [from, pick] of [
        [S1, S2],
        [S2, S1],
      ] as const) {
        await closeFrom(from);
        await page.keyboard.press('Control+Shift+P');
        await page.waitForFunction(
          () => document.activeElement?.classList.contains('switcher-field') === true,
          null,
          { timeout: PAGE_WAIT_MS },
        );
        await page.keyboard.type(pick.slice(0, 8));
        await page.keyboard.press('Enter'); // waits for the answer to the whole text, then picks
        await openedFor(pick, `open for the pick of ${pick}`);
      }
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "a click on the caption while a session of its block is selected never moves the selection: from that session's terminal (a middle one) the block stays open, the key bar says why, nothing is sent, and what is typed next reaches THAT session's program",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2, S3]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2, S3]) {
        await resumeHere(page, id);
      }
      await untilPageReported(page, 3); // the PAGE knows each session (F6, L6)
      await untilShape(page, [OPEN('test'), S1, S2, `*${S3}`], 'the open card under Open');
      // S2's terminal has the keyboard (a click on a running row).
      await page.locator(`#list [data-id="${S2}"]`).click();
      await untilSelected(page, S2);
      await page.waitForFunction(
        () => document.getElementById('terminal')?.contains(document.activeElement) === true,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      const term2 = termOf(l, S2);
      assert.equal(await shownTerm(page), term2);
      const views = (await sentViews(page)).length;
      await mark(page, 'refused');
      await captionOf(page, 'open', 'test').click();
      await showsText(page, '#key-message', HOLDS_SELECTED);
      assert.deepEqual(shapeOf(await lines(page)), [OPEN('test'), S1, `*${S2}`, S3], 'still open');
      assert.equal(await shownTerm(page), term2, 'the right side stays');
      assert.equal((await sentViews(page)).length, views, 'no view');
      assert.deepEqual(
        (await sentAfter(page, 'refused')).filter((type) => type !== 'input' && type !== 'ping'),
        [],
        'nothing but input sent',
      );
      const before2 = inputOf(d.record, S2);
      const before1 = inputOf(d.record, S1);
      await page.keyboard.type('typedafterclick');
      const typed = Buffer.from('typedafterclick', 'utf8').toString('hex');
      await until(() => inputOf(d.record, S2).slice(before2.length).includes(typed), 'S2 read it');
      assert.equal(inputOf(d.record, S1), before1, "nothing reached the first's program");
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'one group in two sections is two blocks, remembered each on its own: closing one leaves the other open, opening one leaves the other closed, a selection that opens one leaves the other closed; a click on one with a session of the other selected closes it and leaves the selection (review 2, S4); a resume into a closed block of Open opens it',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const id of [S1, S2]) {
        d.resumable(id);
        setGroup(d.deck, id, 'test');
      }
      for (const id of [S1, S2]) {
        await resumeHere(page, id);
      }
      await untilPageReported(page, 2); // the PAGE knows each session (F6, L6)
      session(d, S3, 1n * MIN, 'week three');
      session(d, S4, 2n * MIN, 'week four');
      setGroup(d.deck, S3, 'test');
      setGroup(d.deck, S4, 'test');
      /** Open's block, then Recent's, each open or closed; `*` marks `selected`. */
      const both = (open: boolean, week: boolean, selected: string): string[] =>
        [
          ...(open ? [OPEN('test'), S1, S2] : [`open:${CLOSED('test')}`]),
          ...(week ? [OPEN('test'), S3, S4] : [`week:${CLOSED('test')}`]),
        ].map((line) => {
          const bare = line.replace(/^(open|week):/, '');
          return line === selected ? `*${bare}` : bare;
        });
      await untilShape(page, both(true, true, S2), "two open blocks, Open's S2 selected");

      // A click on Recent's caption with Open's S2 selected: closed, the selection stays.
      await captionOf(page, 'week', 'test').click();
      await untilShape(page, both(true, false, S2), "Recent's closed");
      await untilClosed(page, shut('week', 'test'));

      // Open's closed too (← on S2: its caption selected): two entries, one per section.
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, both(false, false, `open:${CLOSED('test')}`), 'both closed');
      await untilClosed(page, [...shut('week', 'test'), ...shut('open', 'test')]);

      // Opening Recent's leaves Open's closed (and its caption selected).
      await captionOf(page, 'week', 'test').click();
      await untilShape(page, both(false, true, `open:${CLOSED('test')}`), "Recent's open");
      await untilClosed(page, shut('open', 'test'));

      // A selection that opens Open's (a slot chord of its hidden S2) leaves Recent's closed.
      await captionOf(page, 'week', 'test').click();
      await untilShape(page, both(false, false, `open:${CLOSED('test')}`), 'both closed again');
      await untilClosed(page, [...shut('open', 'test'), ...shut('week', 'test')]);
      await page.keyboard.press('Control+Shift+Digit2');
      await untilShape(page, both(true, false, S2), "Open's opened by the chord");
      await untilClosed(page, shut('week', 'test'));

      // A resume into a closed block of Open (CONSIDER c of review 2): Recent's opened, Open's
      // closed (← on S2), then Recent's S3 resumed from the list; it joins Open's block, the
      // server selects it after the resume, and the block opens.
      await captionOf(page, 'week', 'test').click();
      await untilShape(page, both(true, true, S2), 'both open');
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilClosed(page, shut('open', 'test'));
      await resumeHere(page, S3);
      const joined = await untilShape(
        page,
        [OPEN('test'), S1, S2, `*${S3}`, S4],
        "S3 under Open, in its block's open card",
      );
      assert.deepEqual(
        joined.map((line) => `${line.section}:${line.card}`),
        ['open:test', 'open:test', 'open:test', 'open:test', 'week:'],
      );
      await untilClosed(page, []);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "a closed caption whose hidden session needs you: ` · 1 needs you` in the needs-you colour, no bar, no bold, its space drawn; the title bar the same open or closed; Ctrl+Shift+J from a selected caption selects the hidden session that needs you and opens its block — a member of one block and the FIRST of another, in Ctrl+Shift+J's order",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      for (const [id, group] of [
        [S1, 'alpha'],
        [S2, 'alpha'],
        [S3, 'beta'],
        [S4, 'beta'],
      ] as const) {
        d.resumable(id);
        setGroup(d.deck, id, group);
      }
      for (const id of [S1, S2, S3, S4]) {
        await resumeHere(page, id);
      }
      await untilPageReported(page, 4); // the PAGE knows each session (F6, L6)
      await untilShape(page, [OPEN('alpha'), S1, S2, OPEN('beta'), S3, `*${S4}`], 'two cards');
      // S2 (alpha's second) asks a question, then S3 (beta's FIRST).
      for (const id of [S2, S3]) {
        assert.equal(
          l.server.hub.input(termOf(l, id), Buffer.from('/waiting a question\r', 'utf8')),
          'ok',
        );
        await page.waitForFunction(
          (id) =>
            document.querySelector(`#list [data-id="${id}"]`)?.getAttribute('data-attention') ===
            'asks',
          id,
          { timeout: PAGE_WAIT_MS },
        );
      }
      const counts = async (): Promise<string> => shownText(page, '#counts');
      await until(async () => (await counts()).startsWith('2 need you'), 'the title bar counts');
      const countsOpen = await counts();
      const titleOpen = await page.title();

      // alpha closed (← on S1: its caption selected), beta closed by a click on its caption.
      await page.locator(`#list [data-id="${S1}"]`).click();
      await untilSelected(page, S1);
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('alpha')}`, OPEN('beta'), S3, S4], 'alpha closed');
      await captionOf(page, 'open', 'beta').click();
      const closed = await untilShape(page, [`*${CLOSED('alpha')}`, CLOSED('beta')], 'both closed');
      await untilClosed(page, shut('open', 'alpha', 'beta'));
      assert.deepEqual(
        closed.map(({ text, count, need }) => [text, count, need]),
        [
          ['alpha', '2', ' · 1 needs you'],
          ['beta', '2', ' · 1 needs you'],
        ],
      );
      const look = await readPage(
        page,
        () => {
          const head = [...document.querySelectorAll<HTMLElement>('#list .block-head')].find(
            (one) => one.querySelector('.block-name')?.textContent === 'beta',
          );
          const style = (selector: string) => {
            const part = head?.querySelector(selector);
            return part instanceof Element ? getComputedStyle(part) : null;
          };
          const counted = document.querySelector('#counts .count[data-state="need-you"]');
          const need = head?.querySelector('.block-need')?.firstChild;
          const count = head?.querySelector('.block-count');
          let gap: number | null = null;
          if (need != null && count != null && need.textContent?.[1] === '·') {
            const dot = document.createRange();
            dot.setStart(need, 1);
            dot.setEnd(need, 2);
            gap = dot.getBoundingClientRect().left - count.getBoundingClientRect().right;
          }
          return {
            attention: head?.dataset['attention'] ?? null,
            nameColour: style('.block-name')?.color ?? '',
            countColour: style('.block-count')?.color ?? '',
            needColour: style('.block-need')?.color ?? '',
            titleColour: counted instanceof Element ? getComputedStyle(counted).color : '',
            needWeight: style('.block-need')?.fontWeight ?? '',
            bar: head === undefined ? 'none' : getComputedStyle(head, '::before').content,
            gap,
          };
        },
        null,
      );
      assert.equal(look.attention, null, 'the caption is no row that needs you');
      assert.equal(look.needColour, look.titleColour, "in the title bar's need-you colour");
      assert.notEqual(look.nameColour, look.needColour, 'the name keeps its look');
      assert.notEqual(look.countColour, look.needColour, 'the count keeps its look');
      assert.equal(look.needWeight, '400', 'no bold');
      assert.equal(look.bar, 'none', 'no bar');
      // The space before `·` is drawn (F6, L2): the dot stands clear of the count.
      assert.ok(look.gap !== null && look.gap >= 2, `the gap before the dot (${look.gap} px)`);
      assert.equal(await counts(), countsOpen, 'the title bar does not move');
      assert.equal(await page.title(), titleOpen);

      // Ctrl+Shift+J twice: each hidden session that needs you, in order, its block opened.
      const order = await receivedOrder(page);
      assert.deepEqual([...order].sort(), [S2, S3].sort());
      const blockOf = (id: string): string => (id === S2 ? 'alpha' : 'beta');
      const shapeWith = (selected: string, open: readonly string[]): string[] =>
        (['alpha', 'beta'] as const).flatMap((group) => {
          const ids = group === 'alpha' ? [S1, S2] : [S3, S4];
          return open.includes(group)
            ? [OPEN(group), ...ids.map((id) => (id === selected ? `*${id}` : id))]
            : [CLOSED(group)];
        });
      const [first, second] = order as [string, string];
      await page.keyboard.press('Control+Shift+J');
      await untilShape(page, shapeWith(first, [blockOf(first)]), 'the first that needs you');
      await page.keyboard.press('Control+Shift+J');
      await untilShape(page, shapeWith(second, ['alpha', 'beta']), 'the second');
      await untilClosed(page, []);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "a long group name in a caption, open and closed, is cut with an ellipsis, and the arrow, the count and ` · 1 needs you` stay whole inside the line; an odd and hostile name (markup, a tab, an escape sequence, a bell, a bidirectional control) is shown as sanitised text, in the caption and in the pane's group card, and makes no element",
    async (t) => {
      const long = `inbox-cleaner-oom-investigation-${'x'.repeat(120)}`;
      const longer = 'L'.repeat(200);
      const odd = '<img src=x onerror="window.pwned=1">‮\tcut\x1b[31mred\x07';
      const oddShown = '<img src=x onerror="window.pwned=1"> cutred';
      // The page draws the group as text after its own sanitiser (the server's has run before,
      // for a real list); this stand-in sends the odd name raw.
      const rows: ScriptedRow[] = [
        { id: S1, group: long },
        { id: S2, group: long },
        { id: S3, group: longer },
        { id: S4, group: longer, needsYou: true },
        { id: S6, group: longer },
        { id: S5, group: odd },
        { id: S7, group: odd },
      ];
      const { page, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => blockedList(rows, [], closedOf(w()), selected),
      );
      await untilShape(
        page,
        [OPEN(long), `*${S1}`, S2, OPEN(longer), S3, S4, S6, OPEN(oddShown), S5, S7],
        'three open cards',
      );
      // Two of them closed by a click on their caption (S1 stays selected).
      await captionOf(page, 'open', longer).click();
      await untilShape(
        page,
        [OPEN(long), `*${S1}`, S2, CLOSED(longer), OPEN(oddShown), S5, S7],
        'the second closed',
      );
      await captionOf(page, 'open', oddShown).click();
      await untilShape(
        page,
        [OPEN(long), `*${S1}`, S2, CLOSED(longer), CLOSED(oddShown)],
        'an open card and two captions',
      );
      const fits = await readPage(
        page,
        () =>
          [...document.querySelectorAll<HTMLElement>('#list .block-head')].map((head) => {
            const box = head.getBoundingClientRect();
            const style = getComputedStyle(head);
            const left = box.left + parseFloat(style.paddingLeft);
            const right = box.right - parseFloat(style.paddingRight);
            const whole = (selector: string): boolean | null => {
              const part = head.querySelector<HTMLElement>(selector);
              if (part === null || !part.checkVisibility()) return null;
              const at = part.getBoundingClientRect();
              return at.width > 0 && at.left >= left - 0.5 && at.right <= right + 0.5;
            };
            const name = head.querySelector<HTMLElement>('.block-name');
            return {
              cut: name !== null && name.scrollWidth > name.clientWidth,
              ellipsis: name === null ? '' : getComputedStyle(name).textOverflow,
              twist: whole('.block-twist'),
              count: whole('.block-count'),
              need: whole('.block-need'),
            };
          }),
        null,
      );
      assert.deepEqual(fits.slice(0, 2), [
        { cut: true, ellipsis: 'ellipsis', twist: true, count: true, need: null },
        { cut: true, ellipsis: 'ellipsis', twist: true, count: true, need: true },
      ]);
      assert.deepEqual(
        fits.slice(2).map(({ twist, count, need }) => ({ twist, count, need })),
        [{ twist: true, count: true, need: null }],
        'the odd one: its arrow and count whole too',
      );
      // The odd one selected: the pane's group card shows its name as text too.
      await toZone(page, 'list');
      await page.keyboard.press('End');
      await untilShape(page, [OPEN(long), S1, S2, CLOSED(longer), `*${CLOSED(oddShown)}`], 'End');
      await untilPane(page, 'group');
      assert.deepEqual(await groupCard(page), {
        shown: true,
        name: oddShown,
        count: '2 sessions',
        need: '',
        hint: '→ or Enter opens the group',
      });
      // ↑ to the long one: its card says ` · 1 needs you` too.
      await page.keyboard.press('ArrowUp');
      await untilShape(page, [OPEN(long), S1, S2, `*${CLOSED(longer)}`, CLOSED(oddShown)], '↑');
      await until(async () => (await groupCard(page)).name === longer, 'its group card');
      assert.deepEqual(await groupCard(page), {
        shown: true,
        name: longer,
        count: '3 sessions',
        need: ' · 1 needs you',
        hint: '→ or Enter opens the group',
      });
      assert.equal(await page.evaluate(() => document.querySelectorAll('img').length), 0);
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, 'pwned')), undefined);
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a filter flattens every block, a closed one too: no card, no caption, every row matched with its ticket key or its group shown again; while filtering ← folds nothing and closes nothing; cleared, the cards come back as they were',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'tea one');
      session(d, S4, 4n * MIN, 'tea two');
      setGroup(d.deck, S3, 'test');
      setGroup(d.deck, S4, 'test');
      session(d, S5, 20n * DAY, 'ORB-1 old'); // alone in Earlier: no block
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, OPEN('test'), S3, S4], 'two cards');
      await page.locator(`#list [data-id="${S3}"]`).click();
      await untilSelected(page, S3);
      await captionOf(page, 'week', 'ORB-1').click();
      await untilShape(page, [CLOSED('ORB-1'), OPEN('test'), `*${S3}`, S4], 'ORB-1 closed');
      await untilClosed(page, shut('week', 'ORB-1'));

      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('o');
      const flat = await untilShape(
        page,
        [S1, S2, `*${S3}`, S4, S5],
        'flat rows, Earlier unfolded',
      );
      assert.deepEqual(
        flat.map(({ card, stack, key, group }) => ({ card, stack, key, group })),
        [
          { card: '', stack: '', key: 'ORB-1', group: '' },
          { card: '', stack: '', key: 'ORB-1', group: '' },
          { card: '', stack: '', key: '', group: 'test' },
          { card: '', stack: '', key: '', group: 'test' },
          { card: '', stack: '', key: 'ORB-1', group: '' },
        ],
      );
      assert.equal(
        await page.locator('#list .list-block, #list .block-head').count(),
        0,
        'no card',
      );
      // While filtering ← folds nothing and closes nothing: with the selection in Earlier it stays.
      await page.keyboard.press('Enter');
      await page.locator(`#list [data-id="${S5}"]`).click();
      await untilSelected(page, S5);
      const views = (await sentViews(page)).length;
      await page.keyboard.press('ArrowLeft');
      await sleep(300);
      assert.deepEqual(shapeOf(await lines(page)), [S1, S2, S3, S4, `*${S5}`]);
      assert.equal((await sentViews(page)).length, views, 'no view');
      await page.keyboard.press('Escape');
      await untilShape(page, [CLOSED('ORB-1'), OPEN('test'), S3, S4], 'the filter cleared');
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'));
      await healthy(page, l.problems);
    },
  );

  await t.test(
    "`d` on a session of an open card marks that session only: the card holds the others (`2`), and stage D's selection after `d` takes the row after it",
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'ORB-1 third');
      session(d, S4, 4n * MIN, 'plain work');
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3, S4], 'the open card');
      await toZone(page, 'list');
      await page.keyboard.press('d');
      const after = await untilShape(page, [OPEN('ORB-1'), `*${S2}`, S3, S4], 'S1 done');
      assert.equal(after[0]?.count, '2');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.deepEqual((await lastView(page))['closed'], []);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a group of 1,025 bytes is never in a view the page sends, so its block cannot be closed: ← on its sessions and a click on its caption do nothing, and it stays open; ← on a block beside it still closes that one; nor one of 400 `€` (400 units, 1,200 bytes); one of 1,024 bytes of non-ASCII text is',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      const long = 'g'.repeat(1025);
      const fits = `${'€'.repeat(341)}f`; // 1,024 bytes of UTF-8 in 342 units
      const euros = '€'.repeat(400); // 1,200 bytes in 400 units
      session(d, S1, 1n * MIN, 'long first');
      session(d, S2, 2n * MIN, 'long second');
      setGroup(d.deck, S1, long);
      setGroup(d.deck, S2, long);
      session(d, S3, 3n * MIN, 'ORB-1 first');
      session(d, S4, 4n * MIN, 'ORB-1 second');
      await untilShape(page, [OPEN(long), `*${S1}`, S2, OPEN('ORB-1'), S3, S4], 'two open cards');

      // ← on the long block's first and second session: nothing is sent, nothing folds.
      await toZone(page, 'list');
      const before = (await sentViews(page)).length;
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S2);
      await page.keyboard.press('ArrowLeft');
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [
        OPEN(long),
        S1,
        `*${S2}`,
        OPEN('ORB-1'),
        S3,
        S4,
      ]);
      assert.deepEqual(
        (await sentViews(page)).slice(before).map((view) => view['selected']),
        [S2],
        "no view but the selection's",
      );
      // A click on its caption with the selection outside it (S3): nothing either.
      await page.keyboard.press('ArrowDown');
      await untilSelected(page, S3);
      const clicked = (await sentViews(page)).length;
      await captionOf(page, 'week', long).click();
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [
        OPEN(long),
        S1,
        S2,
        OPEN('ORB-1'),
        `*${S3}`,
        S4,
      ]);
      assert.equal((await sentViews(page)).length, clicked, 'the click sends no view');

      // The guard lets go: ← on the block beside it closes that one.
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [OPEN(long), S1, S2, `*${CLOSED('ORB-1')}`], 'ORB-1 closed');
      await untilClosed(page, shut('week', 'ORB-1'));

      // A group of 1,024 bytes is sent: its block closes.
      session(d, S6, 5n * MIN, 'fits first');
      session(d, S7, 6n * MIN, 'fits second');
      setGroup(d.deck, S6, fits);
      setGroup(d.deck, S7, fits);
      await untilRows(page, [S1, S2, S6, S7], 'a third card, open');
      await captionOf(page, 'week', fits).click();
      await untilShape(
        page,
        [OPEN(long), S1, S2, `*${CLOSED('ORB-1')}`, CLOSED(fits)],
        'the block of 1,024 bytes closed',
      );
      await untilClosed(page, [...shut('week', 'ORB-1'), ...shut('week', fits)]);

      // 400 `€`: the bytes count, not the units: never sent, the block stays open.
      session(d, S8, 7n * MIN, 'euro first');
      session(d, S5, 8n * MIN, 'euro second');
      setGroup(d.deck, S8, euros);
      setGroup(d.deck, S5, euros);
      await untilRows(page, [S1, S2, S8, S5], 'a fourth card, open');
      await captionOf(page, 'week', euros).click();
      await page.locator(`#list [data-id="${S8}"]`).click();
      await untilSelected(page, S8);
      await page.keyboard.press('ArrowLeft');
      await sleep(500);
      assert.deepEqual(
        shapeOf(await lines(page)),
        [OPEN(long), S1, S2, CLOSED('ORB-1'), CLOSED(fits), OPEN(euros), `*${S8}`, S5],
        'it stays open',
      );
      assert.deepEqual((await lastView(page))['closed'], [
        ...shut('week', 'ORB-1'),
        ...shut('week', fits),
      ]);
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'at most 64 entries in `closed`: closing a 65th block drops the oldest, which opens again, and the page stays connected (the server refuses a 65th); a selected caption whose block that drop opens leaves NOTHING selected (ruled (a))',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      const id = (n: number): string =>
        `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
      for (let g = 1; g <= 65; g++) {
        session(d, id(2 * g), BigInt(2 * g) * MIN, `GR-${g} first`);
        session(d, id(2 * g + 1), BigInt(2 * g + 1) * MIN, `GR-${g} second`);
      }
      await untilLines(
        page,
        (drawn) => drawn.filter((line) => line.kind === 'caption').length === 65,
        '65 open cards',
      );
      // GR-1's caption selected (← on its first session), then 64 more closed by their captions.
      await untilSelected(page, id(2));
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilClosed(page, shut('week', 'GR-1'));
      await until(async () => (await selectedLine(page)) === 'caption GR-1', 'its caption');
      for (let g = 2; g <= 65; g++) {
        await captionOf(page, 'week', `GR-${g}`).click();
        const deadline = performance.now() + PAGE_WAIT_MS;
        while (
          !((await lastView(page))['closed'] as ClosedBlock[]).some(
            (one) => one.group === `GR-${g}`,
          )
        ) {
          assert.ok(performance.now() < deadline, `GR-${g} closed`);
          await sleep(20);
        }
      }
      const closed = (await lastView(page))['closed'] as ClosedBlock[];
      assert.equal(closed.length, 64);
      assert.deepEqual(
        closed,
        Array.from({ length: 64 }, (_, i) => ({ section: 'week', group: `GR-${i + 2}` })),
      );
      // The oldest is open again — nothing selected —; the page never lost its connection.
      await untilLines(
        page,
        (drawn) => drawn.some((line) => line.kind === 'row' && line.id === id(3)),
        'GR-1 open again',
      );
      await untilPane(page, 'none');
      assert.equal(await selectedLine(page), 'nothing');
      assert.equal((await lastView(page))['selected'], null);
      // No view was refused: the server closes a page's socket with 1008 for one (under load a
      // page may also reconnect after a silence, which is no refusal).
      assert.deepEqual(
        (await logOf(page)).filter((entry) => entry.e === 'close' && entry.code === 1008),
        [],
      );
      await connection(page, 'open');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a filter of blanks is no filter (the list decides by `list.filtering`): the cards are drawn and close, the footer is shown, ← and → fold and unfold Earlier',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 first');
      session(d, S2, 2n * MIN, 'ORB-1 second');
      session(d, S3, 3n * MIN, 'plain work');
      session(d, S4, 20n * DAY, 'old work');
      session(d, S5, 4n * MIN, 'done work');
      markDone(d.deck, S5);
      await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3], 'Recent: an open card and a row');

      await toZone(page, 'list');
      await page.keyboard.press('/');
      await page.keyboard.type('   ');
      await page.keyboard.press('Enter');
      await sleep(500);
      assert.deepEqual((await lastView(page))['filter'], '   ');
      const drawn = await untilShape(page, [OPEN('ORB-1'), `*${S1}`, S2, S3], 'the card as before');
      assert.equal(drawn[0]?.count, '2');
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.equal(await shownText(page, '#list .list-empty'), '');
      await page.locator(`#list [data-id="${S3}"]`).click();
      await untilSelected(page, S3);
      await page.keyboard.press('ArrowRight');
      await untilRows(page, [S1, S2, S3, S4], '→ unfolds Earlier');
      await page.keyboard.press('ArrowLeft');
      await untilRows(page, [S1, S2, S3], '← folds it');
      await page.keyboard.press('Home');
      await untilSelected(page, S1);
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('ORB-1')}`, S3], '← on its first closes the block');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'the mouse on a caption: a click closes and opens its block and never moves the selection, from the list and from a terminal, taking no keyboard; with any session of the block selected — the first, a middle, the last — the click to close is refused with `this block holds the selected session; it stays open` and sends nothing; a click on the selected closed caption opens the block and selects its first session, as → does',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S8, 1n * MIN, 'plain run');
      session(d, S1, 2n * MIN, 'ORB-1 first');
      session(d, S2, 3n * MIN, 'ORB-1 second');
      session(d, S3, 4n * MIN, 'ORB-1 third');
      session(d, S4, 5n * MIN, 'plain idle');
      const caption = captionOf(page, 'week', 'ORB-1');
      await untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3, S4], 'a row, a card, a row');
      await toZone(page, 'list');
      await caption.click();
      await untilShape(page, [`*${S8}`, CLOSED('ORB-1'), S4], 'a click closes it');
      await untilClosed(page, shut('week', 'ORB-1'));
      assert.equal(await keyboardOn(page), 'the list');
      await caption.click();
      await untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3, S4], 'a click opens it');
      await untilClosed(page, []);

      // With any of its sessions selected the click to close is refused.
      for (const id of [S1, S2, S3]) {
        await page.locator(`#list [data-id="${id}"]`).click();
        await untilSelected(page, id);
        const views = (await sentViews(page)).length;
        await clearKeyBar(page);
        await caption.click();
        await showsText(page, '#key-message', HOLDS_SELECTED);
        assert.deepEqual(
          shapeOf(await lines(page)),
          [S8, OPEN('ORB-1'), ...[S1, S2, S3].map((one) => (one === id ? `*${one}` : one)), S4],
          `${id}: still open, still selected`,
        );
        assert.equal((await sentViews(page)).length, views, `${id}: no view`);
      }

      // The selected closed caption: a click opens it and selects its first session.
      await page.keyboard.press('ArrowLeft'); // on S3: closed, its caption selected
      await untilShape(page, [S8, `*${CLOSED('ORB-1')}`, S4], 'closed, its caption selected');
      await caption.click();
      await untilShape(page, [S8, OPEN('ORB-1'), `*${S1}`, S2, S3, S4], 'open, its first selected');
      await untilClosed(page, []);
      assert.equal(await keyboardOn(page), 'the list');

      // From a terminal: the clicks take no keyboard and leave the selection.
      await resumeFromList(page, S8);
      await untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3, S4], 'S8 under Open');
      await caption.click();
      await untilShape(page, [`*${S8}`, CLOSED('ORB-1'), S4], 'closed from the terminal');
      assert.equal(await keyboardOn(page), 'the terminal');
      await caption.click();
      await untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3, S4], 'opened from the terminal');
      assert.equal(await keyboardOn(page), 'the terminal');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a double click on a caption at a human pace toggles its block once — closed or open, its second click acts on nothing — and moves nothing else; its second click landing on a row the first click drew selects nothing and resumes nothing; on the selected closed caption it opens the block and selects the first session once, resuming nothing; a sequence begun on a row whose second click is on a caption toggles nothing; each sequence begins afresh',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S8, 1n * MIN, 'plain run');
      session(d, S1, 2n * MIN, 'ORB-1 first');
      session(d, S2, 3n * MIN, 'ORB-1 second');
      session(d, S3, 4n * MIN, 'plain idle');
      const caption = captionOf(page, 'week', 'ORB-1');
      await untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3], 'a row, a card, a row');
      await resumeFromList(page, S8);
      await untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3], 'S8 under Open');
      assert.equal(await keyboardOn(page), 'the terminal');

      // On the open caption: closed once; on the closed one: opened once.
      await mark(page, 'double');
      await doubleClick(page, caption, () =>
        untilShape(page, [`*${S8}`, CLOSED('ORB-1'), S3], 'closed after the first click'),
      );
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [`*${S8}`, CLOSED('ORB-1'), S3], 'still closed');
      assert.deepEqual((await lastView(page))['closed'], shut('week', 'ORB-1'));
      await doubleClick(page, caption, () =>
        untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3], 'open after the first click'),
      );
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [`*${S8}`, OPEN('ORB-1'), S1, S2, S3]);
      assert.equal(await keyboardOn(page), 'the terminal', 'the keyboard where it was');
      assert.ok(!(await sentAfter(page, 'double')).includes('act'), 'nothing resumed');

      // The second click lands on S1, which the first click drew: nothing selected, resumed.
      await caption.click();
      await untilShape(page, [`*${S8}`, CLOSED('ORB-1'), S3], 'closed');
      await mark(page, 'onto a row');
      const at = await caption.boundingBox();
      assert.ok(at !== null);
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await untilShape(page, [`*${S8}`, OPEN('ORB-1'), S1, S2, S3], 'open');
      const row = await page.locator(`#list [data-id="${S1}"] .row-title`).boundingBox();
      assert.ok(row !== null);
      await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [`*${S8}`, OPEN('ORB-1'), S1, S2, S3]);
      assert.equal(await keyboardOn(page), 'the terminal');
      await untilPane(page, 'terminal');
      assert.ok(!(await sentAfter(page, 'onto a row')).includes('act'), 'nothing resumed');

      // A sequence begun on a row (S3) whose second click is on a closed caption: no toggle.
      await caption.click();
      await untilShape(page, [`*${S8}`, CLOSED('ORB-1'), S3], 'closed again');
      await mark(page, 'row then caption');
      const title = await page.locator(`#list [data-id="${S3}"] .row-title`).boundingBox();
      const line = await caption.boundingBox();
      assert.ok(title !== null && line !== null);
      await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await untilSelected(page, S3);
      await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [S8, CLOSED('ORB-1'), `*${S3}`], 'not opened');
      assert.ok(!(await sentAfter(page, 'row then caption')).includes('act'), 'nothing resumed');

      // The selected closed caption (↑ from S3): open, S1 selected once, nothing resumed.
      await toZone(page, 'list');
      await page.keyboard.press('ArrowUp');
      await untilShape(page, [S8, `*${CLOSED('ORB-1')}`, S3], 'the caption selected');
      await mark(page, 'selected caption');
      await doubleClick(page, caption, () =>
        untilShape(page, [S8, OPEN('ORB-1'), `*${S1}`, S2, S3], 'open after the first click'),
      );
      await sleep(500);
      assert.deepEqual(shapeOf(await lines(page)), [S8, OPEN('ORB-1'), `*${S1}`, S2, S3]);
      assert.ok(!(await sentAfter(page, 'selected caption')).includes('act'), 'S1 not resumed');
      await untilPane(page, 'resume');

      // Each sequence begins afresh: a double click on a row that is not running resumes it, as
      // in stage A, after all the clicks on the caption above.
      await mark(page, 'resume');
      await doubleClick(page, `#list [data-id="${S3}"] .row-title`, () => Promise.resolve());
      await until(async () => (await sentAfter(page, 'resume')).includes('act'), 'S3 resumed');
      await page.waitForSelector('#right-zone[data-pane="terminal"]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'two blocks: a click closing one with a session of the other selected leaves the selection; ← on a session closes its block, selects its caption and leaves an unfolded Earlier unfolded',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      session(d, S1, 1n * MIN, 'ORB-1 a');
      session(d, S2, 2n * MIN, 'ORB-1 b');
      session(d, S3, 3n * MIN, 'ORB-2 a');
      session(d, S4, 4n * MIN, 'ORB-2 b');
      session(d, S5, 20n * DAY, 'old work');
      await untilShape(
        page,
        [OPEN('ORB-1'), `*${S1}`, S2, OPEN('ORB-2'), S3, S4],
        'two open cards',
      );

      await toZone(page, 'list');
      await page.locator(`#list [data-id="${S4}"]`).click();
      await untilSelected(page, S4);
      await captionOf(page, 'week', 'ORB-1').click();
      await untilShape(page, [CLOSED('ORB-1'), OPEN('ORB-2'), S3, `*${S4}`], 'ORB-1 closed');
      await untilClosed(page, shut('week', 'ORB-1'));

      // Earlier unfolded (a click on its header), then ← on ORB-2's S4.
      await page.locator('#list .list-section[data-section="earlier"]').click();
      await untilShape(
        page,
        [CLOSED('ORB-1'), OPEN('ORB-2'), S3, `*${S4}`, S5],
        'Earlier unfolded',
      );
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [CLOSED('ORB-1'), `*${CLOSED('ORB-2')}`, S5], 'ORB-2 closed');
      await untilClosed(page, shut('week', 'ORB-1', 'ORB-2'));
      assert.deepEqual((await lastView(page))['unfolded'], ['earlier'], 'Earlier still unfolded');
      await healthy(page, l.problems);
    },
  );

  await t.test(
    'a hostile group in a caption and a hostile title on a row of its card are text, open and closed',
    async (t) => {
      const l = await launchedWithViews(t, chromium);
      const { page, d } = l;
      const hostile = '<img src=x onerror="window.pwned=1">';
      const hostileTitle = '<img src=y onerror="window.pwned=2"> a session';
      session(d, S1, 1n * MIN, 'the first');
      session(d, S2, 2n * MIN, hostileTitle);
      session(d, S6, 3n * MIN, 'another');
      session(d, S7, 4n * MIN, 'plain');
      for (const id of [S1, S2, S6]) setGroup(d.deck, id, hostile);
      const open = await untilShape(page, [OPEN(hostile), `*${S1}`, S2, S6, S7], 'open');
      assert.equal(open[2]?.text, hostileTitle);
      assert.equal(open[0]?.text, hostile);
      await page.locator(`#list [data-id="${S7}"]`).click();
      await untilSelected(page, S7);
      await captionOf(page, 'week', hostile).click();
      const closed = await untilShape(page, [CLOSED(hostile), `*${S7}`], 'closed');
      assert.equal(closed[0]?.text, hostile);
      assert.equal(await page.evaluate(() => document.querySelector('img')), null);
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, 'pwned')), undefined);
      await untilClosed(page, shut('week', hostile));
      await healthy(page, l.problems);
    },
  );

  await t.test(
    '`closedStacks` is required (ruled on review 1 of F9): a list whose section lacks it is not read as `no closed block` — the page fails on it as on a section that lacks `rows` (an error, its last drawing kept: the closed caption does not vanish), and draws the next good list',
    async (t) => {
      const rows: ScriptedRow[] = [
        { id: S1, group: 'test', title: 'one' },
        { id: S2, group: 'test', title: 'two' },
        { id: S3, group: null, title: 'three' },
      ];
      /** The section's field to leave out of the next list, '' for none. */
      let drop = '';
      const build = (world: EditWorld | null, selected: string | null): Record<string, unknown> => {
        const list = blockedList(rows, [], closedOf(world), selected) as {
          sections: Record<string, unknown>[];
        } & Record<string, unknown>;
        if (drop === '') return list;
        return {
          ...list,
          sections: list.sections.map((section) =>
            Object.fromEntries(Object.entries(section).filter(([name]) => name !== drop)),
          ),
        };
      };
      const { page, world, problems } = await scriptedPage(
        t,
        chromium,
        (w) => (selected) => build(w(), selected),
      );
      await untilShape(page, [OPEN('test'), `*${S1}`, S2, S3], 'the open card');
      await toZone(page, 'list');
      await page.keyboard.press('ArrowLeft');
      await untilShape(page, [`*${CLOSED('test')}`, S3], 'closed, its caption selected');
      assert.deepEqual(problems, []);

      for (const field of ['rows', 'closedStacks']) {
        const before = problems.length;
        drop = field;
        world.list((selected) => build(world, selected));
        await until(
          async () => problems.length > before,
          `the page fails on a list without ${field}`,
        );
        assert.match(problems.at(-1) ?? '', /^pageerror: .*(not iterable|undefined)/, field);
        // Its last drawing is kept: the closed caption is still there, not drawn as none.
        assert.deepEqual(shapeOf(await lines(page)), [`*${CLOSED('test')}`, S3], field);
        drop = '';
        world.list((selected) => build(world, selected));
        await untilShape(
          page,
          [`*${CLOSED('test')}`, S3],
          `a good list after the one without ${field}`,
        );
      }
    },
  );
});
