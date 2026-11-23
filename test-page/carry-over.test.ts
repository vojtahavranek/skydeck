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
  keyMessage,
  launched,
  logOf,
  mark,
  pageUrl,
  readPage,
  scriptedList,
  selectedRow,
  showsText,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { EditWorld, Launched } from './helpers/shell.ts';
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
      await until(
        () => w.sent.some((one) => one['t'] === 'focus' && one['selected'] === S2),
        'a focus names S2',
        PAGE_WAIT_MS,
      );
    },
  );
});

// --- step 6: the bar ----------------------------------------------------------------------------

type Row = Record<string, unknown>;
const OLD = S1;
const NEW = S2;
const REV = 'aaaaaaaaaaaaaaaa';
const REV2 = 'bbbbbbbbbbbbbbbb';
const CHANGED = 'the sessions changed since this offer was drawn; look at it again';

/** A row of a session that is not running (S2 8.2.3), `more` over it. */
function row(id: string, more: Row = {}): Row {
  const list = scriptedList([{ id, terminal: null, slot: null }], []) as {
    sections: { rows: Row[] }[];
  };
  return { ...(list.sections[0]?.rows[0] as Row), ...more };
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

/** An offer (S2 8.2.3 `carryOver`): label, group and ticket offered and ticked, done ticked. */
function offer(more: Row = {}): Row {
  return {
    from: { id: OLD, title: 'fix the retry', ticket: 'TRY-1' },
    fields: [
      { name: 'label', text: 'fix the retry', ticked: true },
      { name: 'group', text: 'backend', ticked: true },
      { name: 'ticket', text: 'TRY-1', ticked: true },
    ],
    prs: 0,
    kept: [],
    done: { ticked: true },
    rev: REV,
    ...more,
  };
}

function selectedOf(sessionId: string, carryOver: Row | null): Row {
  return {
    sessionId,
    command: `cd /home/u/project && claude --resume ${sessionId}`,
    flagsKnown: true,
    unknownFlags: [],
    launchFlags: [],
    ended: null,
    expiring: false,
    expired: false,
    note: null,
    noteTooLong: false,
    ticketUrl: null,
    ticket: null,
    ticketKeys: false,
    ...(carryOver === null ? {} : { carryOver }),
  };
}

interface World {
  rows: Row[];
  terminals: Row[];
  /** The offer of NEW's `selected`, null for none. */
  offer: Row | null;
  /** The offers of other sessions' `selected`, by session. */
  others?: Record<string, Row>;
  /** The closed blocks of Open. */
  closedStacks?: Row[];
}

function listOf(world: World, selected: string | null): Row {
  return {
    ...scriptedList([], []),
    sections: [
      {
        name: 'open',
        folded: false,
        firstNs: null,
        lastNs: null,
        count: world.rows.length,
        rows: world.rows,
        closedStacks: world.closedStacks ?? [],
      },
    ],
    terminals: world.terminals,
    selected:
      selected === null
        ? null
        : selectedOf(selected, selected === NEW ? world.offer : (world.others?.[selected] ?? null)),
  };
}

/** NEW running in TERM_A (slot 1), and OLD not running. */
const RUNNING: World = {
  rows: [row(NEW, { state: 'running', terminal: TERM_A, slot: 1 }), row(OLD)],
  terminals: [terminal(TERM_A, NEW, 1)],
  offer: offer(),
};

interface Scripted {
  page: Page;
  w: EditWorld;
  /** Changes the world and sends the list. */
  set(change: Partial<World>): void;
}

async function scripted(
  t: TestContext,
  chromium: Browser,
  start: World,
  options: { tour?: boolean } = {},
): Promise<Scripted> {
  const page = await newPage(t, chromium, options);
  let world = start;
  const w = await editWorld(t, page, (selected) => listOf(world, selected));
  return {
    page,
    w,
    set(change) {
      world = { ...world, ...change };
      w.list((selected) => listOf(world, selected));
    },
  };
}

interface Bar {
  shown: boolean;
  heading: string;
  /** The shown checkboxes: [field, words, checked]. */
  fields: [string, string, boolean][];
  kept: string;
  message: string;
  buttons: string[];
}

/** What the bar shows. */
async function barOf(page: Page): Promise<Bar> {
  return readPage(
    page,
    () => {
      const host = document.querySelector<HTMLElement>('#cards .carry-over');
      const shown = (element: Element | null) =>
        element instanceof HTMLElement && element.closest('[hidden]') === null;
      const text = (selector: string) => {
        const element = host?.querySelector(selector) ?? null;
        return shown(element) ? (element?.textContent ?? '') : '';
      };
      return {
        shown: host !== null && !host.hidden,
        heading: text('.carry-heading'),
        fields: [...(host?.querySelectorAll<HTMLElement>('.carry-field') ?? [])]
          .filter((label) => shown(label))
          .map((label): [string, string, boolean] => [
            label.dataset['field'] ?? '',
            label.querySelector('.carry-field-text')?.textContent ?? '',
            label.querySelector('input')?.checked === true,
          ]),
        kept: text('.carry-kept'),
        message: text('.carry-message'),
        buttons: [...(host?.querySelectorAll('button') ?? [])]
          .filter((button) => shown(button))
          .map((button) => button.textContent ?? ''),
      };
    },
    null,
  );
}

async function untilBar(page: Page, shown: boolean): Promise<Bar> {
  let bar: Bar | null = null;
  await until(
    async () => {
      bar = await barOf(page);
      return bar.shown === shown;
    },
    `the bar ${shown ? 'shown' : 'hidden'}`,
  );
  return bar as unknown as Bar;
}

/** Where the keyboard is: 'in #terminal', '#list', or the bar's control `bar:<field|button>`. */
async function keyboardAt(page: Page): Promise<string> {
  const inBar = await readPage(
    page,
    () => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element.closest('.carry-over') === null) return '';
      if (element instanceof HTMLButtonElement) return `bar:${element.textContent ?? ''}`;
      return `bar:${element.closest<HTMLElement>('.carry-field')?.dataset['field'] ?? '?'}`;
    },
    null,
  );
  return inBar !== '' ? inBar : active(page);
}

/** The bar's element `selector`, inside the bar. */
function inBar(page: Page, selector: string) {
  return page.locator(`#cards .carry-over ${selector}`);
}

const box = (page: Page, field: string) => inBar(page, `[data-field="${field}"] input`);
const apply = (page: Page) => inBar(page, '.carry-apply');
const dismiss = (page: Page) => inBar(page, '.carry-dismiss');

/** The acts the page sent of the bar's two kinds. */
function barActs(w: EditWorld): Record<string, unknown>[] {
  return w
    .acts()
    .filter((one) => one['kind'] === 'carry-over' || one['kind'] === 'dismiss-carry-over');
}

/** A scripted world with NEW's terminal shown and the keyboard in it (`zone` terminal) or on the list. */
async function barWorld(
  t: TestContext,
  chromium: Browser,
  zoneWanted: 'terminal' | 'list' = 'terminal',
  start: World = RUNNING,
): Promise<Scripted> {
  const s = await scripted(t, chromium, start);
  await untilBar(s.page, true);
  if (zoneWanted === 'terminal') {
    await until(
      async () => (await active(s.page)) === 'in #terminal',
      'the terminal has the keyboard',
    );
  } else {
    await toZone(s.page, 'list');
    await until(async () => (await active(s.page)) === '#list', 'the list has the keyboard');
  }
  return s;
}

test('the carry-over bar (F40)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'drawn above a running terminal, an ended one, a resume card and the card of a session running elsewhere; not for the new form or a session without an offer',
    async (t) => {
      const s = await scripted(t, chromium, RUNNING);
      const bar = await untilBar(s.page, true);
      assert.equal(bar.heading, 'Cleared from "fix the retry" · TRY-1');
      const order = await readPage(
        s.page,
        () => {
          const cards = document.getElementById('cards');
          const host = cards?.querySelector('.carry-over');
          const header = cards?.querySelector('.card-header');
          const terminal = document.getElementById('terminal');
          return {
            afterHeader: header?.nextElementSibling === host,
            above:
              (host?.getBoundingClientRect().bottom ?? 1e9) <=
              (terminal?.getBoundingClientRect().top ?? 0) + 0.5,
          };
        },
        null,
      );
      assert.deepEqual(order, { afterHeader: true, above: true });
      s.set({
        rows: [row(NEW, { terminal: TERM_A, slot: 1 }), row(OLD)],
        terminals: [terminal(TERM_A, NEW, 1, { state: 'ended' })],
      });
      await until(
        async () =>
          (await readPage(s.page, () => document.querySelector('.card-ended') !== null, null)) ||
          (await readPage(
            s.page,
            () => document.getElementById('right-zone')?.dataset['pane'] === 'terminal',
            null,
          )),
        'the ended terminal',
      );
      assert.equal((await untilBar(s.page, true)).shown, true, 'above an ended terminal');
      s.set({ rows: [row(NEW), row(OLD)], terminals: [] });
      await showsText(s.page, '#right-zone', /Resume/);
      assert.equal((await untilBar(s.page, true)).shown, true, 'on a resume card');
      s.set({
        rows: [
          row(NEW, {
            state: 'running',
            elsewhere: { pid: 4242, tty: 'pts/3', dir: '/home/u/project' },
          }),
          row(OLD),
        ],
      });
      await until(
        async () =>
          (await readPage(
            s.page,
            () => document.getElementById('right-zone')?.dataset['pane'],
            null,
          )) === 'elsewhere',
        'the card of a session running elsewhere',
      );
      assert.equal((await untilBar(s.page, true)).shown, true, 'on the card of one elsewhere');
      await s.page.keyboard.press('Control+Shift+N');
      await until(
        async () =>
          (await readPage(
            s.page,
            () => document.getElementById('right-zone')?.dataset['pane'],
            null,
          )) === 'new',
        'the new form',
      );
      await untilBar(s.page, false);
      await s.page.keyboard.press('Escape');
      await untilBar(s.page, true);
      s.set({ offer: null });
      await untilBar(s.page, false);
    },
  );

  await t.test(
    'exactly the offered fields, in order, ticked as sent; the kept line; the done checkbox only when offered',
    async (t) => {
      const s = await scripted(t, chromium, {
        ...RUNNING,
        offer: offer({
          fields: [
            { name: 'group', text: 'backend', ticked: false },
            { name: 'note', text: null, ticked: true },
            { name: 'prs', text: null, ticked: false },
          ],
          prs: 3,
          kept: ['label', 'ticket'],
        }),
      });
      const bar = await untilBar(s.page, true);
      assert.deepEqual(bar.fields, [
        ['group', 'group backend', false],
        ['note', 'note', true],
        ['prs', '3 pull requests', false],
        ['done', 'mark the old one done', true],
      ]);
      assert.equal(bar.kept, 'already set here: label, ticket');
      assert.deepEqual(bar.buttons, ['Carry over', '×']);
      s.set({ offer: offer({ done: null, rev: REV2 }) });
      await until(
        async () => (await barOf(s.page)).fields.every(([name]) => name !== 'done'),
        'no done checkbox',
      );
      assert.deepEqual(
        (await barOf(s.page)).fields.map(([name]) => name),
        ['label', 'group', 'ticket'],
      );
      assert.equal((await barOf(s.page)).kept, '');
    },
  );

  for (const zoneWanted of ['terminal', 'list'] as const) {
    await t.test(
      `a click on a checkbox, on Carry over and on × leaves the keyboard ${zoneWanted === 'terminal' ? 'in the terminal' : 'on the list'}, after the click, the answer and the next list`,
      async (t) => {
        const expected = zoneWanted === 'terminal' ? 'in #terminal' : '#list';
        const s = await barWorld(t, chromium, zoneWanted);
        await box(s.page, 'group').click();
        assert.equal(await keyboardAt(s.page), expected, 'after the click on a checkbox');
        assert.equal((await barOf(s.page)).fields[1]?.[2], false, 'the click unticked it');
        await inBar(s.page, '[data-field="ticket"] .carry-field-text').click();
        assert.equal(await keyboardAt(s.page), expected, "after a click on a label's text");
        assert.equal((await barOf(s.page)).fields[2]?.[2], false);
        for (const [button, kind] of [
          [apply, 'carry-over'],
          [dismiss, 'dismiss-carry-over'],
        ] as const) {
          s.set({ offer: offer({ rev: kind === 'carry-over' ? REV : REV2 }) });
          await untilBar(s.page, true);
          const before = barActs(s.w).length;
          await button(s.page).click();
          assert.equal(await keyboardAt(s.page), expected, `after the click on ${kind}`);
          await until(() => barActs(s.w).length === before + 1, `${kind} sent`);
          const sent = barActs(s.w)[before] as Record<string, unknown>;
          assert.equal(sent['kind'], kind);
          s.w.answer(sent, { ok: true });
          await untilBar(s.page, false);
          assert.equal(await keyboardAt(s.page), expected, `after the answer to ${kind}`);
          s.set({ offer: null });
          await s.page.waitForTimeout(200);
          assert.equal(await keyboardAt(s.page), expected, `after the next list (${kind})`);
        }
      },
    );
  }

  await t.test(
    "a click on the bar's ground leaves the keyboard where it was: the list, the terminal, a checkbox of the bar",
    async (t) => {
      const s = await barWorld(t, chromium, 'list');
      const ground = await readPage(
        s.page,
        () => {
          const host = document.querySelector('#cards .carry-over') as HTMLElement;
          const r = host.getBoundingClientRect();
          const labels = [...host.querySelectorAll('.carry-field')].map((one) =>
            one.getBoundingClientRect(),
          );
          const a = labels[0] as DOMRect;
          const b = labels[1] as DOMRect;
          return {
            padding: { x: r.left + 3, y: r.top + 2 },
            between: { x: (a.right + b.left) / 2, y: (a.top + a.bottom) / 2 },
          };
        },
        null,
      );
      for (const where of [ground.padding, ground.between]) {
        await s.page.mouse.click(where.x, where.y);
        assert.equal(await keyboardAt(s.page), '#list');
      }
      await toZone(s.page, 'terminal');
      await until(async () => (await active(s.page)) === 'in #terminal', 'the terminal');
      for (const where of [ground.padding, ground.between]) {
        await s.page.mouse.click(where.x, where.y);
        assert.equal(await keyboardAt(s.page), 'in #terminal');
      }
      await toZone(s.page, 'list');
      await box(s.page, 'label').focus();
      await until(async () => (await keyboardAt(s.page)) === 'bar:label', 'the first checkbox');
      for (const where of [ground.padding, ground.between]) {
        await s.page.mouse.click(where.x, where.y);
        assert.equal(await keyboardAt(s.page), 'bar:label');
      }
    },
  );

  await t.test('a drag over the heading selects its text', async (t) => {
    const s = await barWorld(t, chromium, 'list');
    const r = await inBar(s.page, '.carry-heading').boundingBox();
    assert.ok(r !== null);
    await s.page.mouse.move(r.x + 2, r.y + r.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(r.x + r.width - 2, r.y + r.height / 2, { steps: 5 });
    await s.page.mouse.up();
    const selected = await readPage(s.page, () => getSelection()?.toString() ?? '', null);
    assert.match(selected, /Cleared from/);
  });

  await t.test(
    'Carry over sends one act with the session, the rev, the ticked names in order and done; it waits; ok hides the bar before any list; a refusal is said; × sends dismiss-carry-over; a double click sends one act',
    async (t) => {
      const s = await barWorld(t, chromium, 'list');
      await box(s.page, 'group').click();
      s.w.holdViews(true);
      await apply(s.page).click();
      const sent = await s.w.act(1);
      assert.deepEqual(
        { ...sent, id: 0, t: 0 },
        {
          id: 0,
          t: 0,
          kind: 'carry-over',
          sessionId: NEW,
          rev: REV,
          fields: ['label', 'ticket'],
          done: true,
        },
      );
      assert.equal((await barOf(s.page)).message, 'carrying over…');
      // aria-disabled while it waits: Playwright would wait for it to be enabled.
      await apply(s.page).click({ force: true });
      await s.page.waitForTimeout(150);
      assert.equal(barActs(s.w).length, 1, 'a second click while it waits sends nothing');
      s.w.answer(sent, { ok: false, error: CHANGED });
      await until(async () => (await barOf(s.page)).message === CHANGED, 'the refusal on the bar');
      await showsText(
        s.page,
        '#key-message',
        new RegExp(CHANGED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      const disabled = await readPage(
        s.page,
        () =>
          [...document.querySelectorAll('#cards .carry-over [aria-disabled]')].map((one) =>
            one.getAttribute('aria-disabled'),
          ),
        null,
      );
      assert.ok(
        disabled.every((one) => one === 'false'),
        'the controls work again',
      );
      await apply(s.page).click();
      const again = await s.w.act(2);
      assert.equal((await barOf(s.page)).message, 'carrying over…', 'the next press clears it');
      s.w.answer(again, { ok: true });
      await untilBar(s.page, false);
      s.w.holdViews(false);

      s.set({ offer: offer({ rev: REV2 }) });
      await untilBar(s.page, true);
      await dismiss(s.page).click();
      const dismissed = await s.w.act(3);
      assert.deepEqual([dismissed['kind'], dismissed['sessionId']], ['dismiss-carry-over', NEW]);
      assert.equal((await barOf(s.page)).message, '', '× says nothing while it waits');
      s.w.answer(dismissed, { ok: true });
      await untilBar(s.page, false);

      s.set({ offer: offer({ rev: 'cccccccccccccccc' }) });
      await untilBar(s.page, true);
      await apply(s.page).dblclick();
      await s.page.waitForTimeout(200);
      assert.equal(barActs(s.w).length, 4, 'a double click sends one act');
    },
  );

  await t.test(
    'a list of the same rev with other starting ticks keeps the page’s ticks; a new rev takes its own; the elements stay the same objects; a bad rev or field name draws no bar',
    async (t) => {
      const s = await barWorld(t, chromium, 'list');
      await box(s.page, 'label').click();
      await readPage(
        s.page,
        () => {
          (window as unknown as { kept: Element[] }).kept = [
            ...document.querySelectorAll('#cards .carry-over *'),
          ];
        },
        null,
      );
      const same = (): Promise<boolean> =>
        readPage(
          s.page,
          () => {
            const kept = (window as unknown as { kept: Element[] }).kept;
            const now = [...document.querySelectorAll('#cards .carry-over *')];
            return kept.length === now.length && kept.every((one, i) => one === now[i]);
          },
          null,
        );
      s.set({
        offer: offer({
          fields: [
            { name: 'label', text: 'fix the retry', ticked: true },
            { name: 'group', text: 'backend', ticked: false },
            { name: 'ticket', text: 'TRY-1', ticked: false },
          ],
        }),
      });
      await s.page.waitForTimeout(300);
      assert.deepEqual(
        (await barOf(s.page)).fields.map(([, , checked]) => checked),
        [false, true, true, true],
        "the page's ticks",
      );
      assert.equal(await same(), true, 'the same elements after a list of the same rev');
      s.set({
        offer: offer({
          rev: REV2,
          fields: [
            { name: 'label', text: 'fix the retry', ticked: true },
            { name: 'group', text: 'backend', ticked: false },
          ],
          done: { ticked: false },
        }),
      });
      await until(async () => (await barOf(s.page)).fields.length === 3, 'the new offer drawn');
      assert.deepEqual(
        (await barOf(s.page)).fields.map(([, , checked]) => checked),
        [true, false, false],
      );
      assert.equal(await same(), true, 'the same elements after a list of a new rev');
      s.set({ offer: offer({ rev: 'NOT-HEX-AT-ALL!!' }) });
      await untilBar(s.page, false);
      s.set({ offer: offer() });
      await untilBar(s.page, true);
      s.set({
        offer: offer({ rev: REV2, fields: [{ name: 'title', text: 'x', ticked: true }] }),
      });
      await untilBar(s.page, false);
    },
  );

  await t.test(
    'an offer answered on another page: the list without it removes the bar here',
    async (t) => {
      const s = await barWorld(t, chromium, 'terminal');
      s.set({ offer: null });
      await untilBar(s.page, false);
      assert.equal(await keyboardAt(s.page), 'in #terminal');
    },
  );

  await t.test(
    'with a terminal shown the bar coming and going each send one resize; a click, the wait, a refusal and a tick send none',
    async (t) => {
      const s = await scripted(t, chromium, { ...RUNNING, offer: null });
      await until(async () => (await active(s.page)) === 'in #terminal', 'the terminal');
      await s.page.waitForTimeout(500);
      const resizes = () => s.w.sent.filter((one) => one['t'] === 'resize').length;
      const detaches = () => s.w.sent.filter((one) => one['t'] === 'detach').length;
      const start = resizes();
      s.set({ offer: offer() });
      await untilBar(s.page, true);
      await until(() => resizes() === start + 1, 'one resize when the bar comes');
      const height = async () =>
        readPage(
          s.page,
          () => document.querySelector('#cards .carry-over')?.getBoundingClientRect().height ?? 0,
          null,
        );
      const tall = await height();
      await box(s.page, 'group').click();
      s.w.holdViews(true);
      await apply(s.page).click();
      const sent = await s.w.act(1);
      assert.equal(await height(), tall, 'the wait');
      s.w.answer(sent, {
        ok: false,
        error: `${CHANGED}; and a long tail of words that does not fit on one line of the bar at all, not even close`,
      });
      await until(async () => (await barOf(s.page)).message !== 'carrying over…', 'the refusal');
      assert.equal(await height(), tall, 'the refusal');
      await s.page.waitForTimeout(500);
      assert.equal(resizes(), start + 1, 'none for a click, the wait, a refusal or a tick');
      s.w.holdViews(false);
      s.set({ offer: null });
      await untilBar(s.page, false);
      await until(() => resizes() === start + 2, 'one resize when the bar goes');
      assert.equal(detaches(), 0, 'the terminal stays attached');
    },
  );
});

// --- step 6: the bar on a real server -----------------------------------------------------------

test('the carry-over bar on a real server (F40)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'after /clear in a labelled session the bar shows without a click and again after a reload; Carry over labels the new one and marks the old one done; after another /clear, × keeps it away after a reload and copies nothing',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      l.d.deck.store.updateMeta(S1, { label: 'fix the retry' }, l.d.platform.clock.nowNs());
      await resumeHere(l.page, S1);
      await typeClear(l, S1);
      const n = await untilSelectedMoves(l.page, S1);
      const bar = await untilBar(l.page, true);
      assert.equal(bar.heading, 'Cleared from "fix the retry"');
      assert.deepEqual(
        bar.fields.map(([name, , checked]) => [name, checked]),
        [
          ['label', true],
          ['done', true],
        ],
      );
      await l.page.reload();
      await connection(l.page, 'open');
      await until(async () => (await selectedRow(l.page)) === n, 'the new session selected');
      await untilBar(l.page, true);

      await apply(l.page).click();
      await untilBar(l.page, false);
      await showsText(l.page, '#cards .card-header .header-title', /^fix the retry$/);
      await until(
        async () =>
          await readPage(
            l.page,
            (id) => document.querySelector(`#list [data-id="${id}"]`) === null,
            S1,
          ),
        'the old session gone from the list',
      );
      assert.notEqual(l.d.deck.store.meta(S1)?.doneAtNs ?? null, null);
      assert.equal(l.d.deck.store.meta(n)?.label, 'fix the retry');
      await toZone(l.page, 'list');
      await l.page.keyboard.press('a');
      await until(
        async () =>
          readPage(l.page, (id) => document.querySelector(`#list [data-id="${id}"]`) !== null, S1),
        'the old session under Show done',
      );
      await l.page.keyboard.press('a');
      await l.page.reload();
      await connection(l.page, 'open');
      await until(async () => (await selectedRow(l.page)) === n, 'the new session selected');
      await l.page.waitForTimeout(500);
      assert.equal((await barOf(l.page)).shown, false, 'no bar after the reload');

      await clickRow(l.page, n);
      await until(async () => (await active(l.page)) === 'in #terminal', 'the terminal');
      await typeClear(l, n);
      const n2 = await untilSelectedMoves(l.page, n);
      await untilBar(l.page, true);
      await dismiss(l.page).click();
      await untilBar(l.page, false);
      await l.page.reload();
      await connection(l.page, 'open');
      await until(async () => (await selectedRow(l.page)) === n2, 'the newest session selected');
      await l.page.waitForTimeout(500);
      assert.equal((await barOf(l.page)).shown, false, 'no bar after × and a reload');
      assert.equal(l.d.deck.store.meta(n2), null, 'nothing copied');
    },
  );
});

// --- step 7: c in the list, and the bar's keys -------------------------------------------------

/** The `input` messages the page sent (a key that reached the terminal). */
function inputs(w: EditWorld): number {
  return w.sent.filter((one) => one['t'] === 'input').length;
}

/** The acts of `kind` the page sent. */
function actsOf(w: EditWorld, kind: string): Record<string, unknown>[] {
  return w.acts().filter((one) => one['kind'] === kind);
}

const ORDER = ['bar:label', 'bar:group', 'bar:ticket', 'bar:done', 'bar:Carry over', 'bar:×'];

/** `c` from the list: the keyboard on the bar's first checkbox. */
async function onBar(s: Scripted): Promise<void> {
  await toZone(s.page, 'list');
  await s.page.keyboard.press('c');
  await until(
    async () => (await keyboardAt(s.page)).startsWith('bar:'),
    'c: the keyboard on the bar',
  );
  await showsText(s.page, '#focus-zone', /^Focus: list$/);
}

/** A held key: its first keydown, `repeats` auto-repeats, then its release. */
async function hold(
  page: Page,
  key: string,
  repeats: number,
  between?: () => Promise<void>,
): Promise<void> {
  await page.keyboard.down(key);
  await between?.();
  for (let i = 0; i < repeats; i++) await page.keyboard.down(key);
  await page.keyboard.up(key);
}

test("the carry-over bar's keys (F40)", async (t) => {
  const chromium = await browser(t);

  await t.test(
    'c, Tab, Space, Enter, Esc; with the keyboard on the bar no list key acts',
    async (t) => {
      const s = await barWorld(t, chromium, 'terminal');
      await onBar(s);
      assert.equal(await keyboardAt(s.page), 'bar:label');
      for (const expected of ORDER.slice(1)) {
        await s.page.keyboard.press('Tab');
        assert.equal(await keyboardAt(s.page), expected);
      }
      await s.page.keyboard.press('Tab'); // wraps to the first
      await s.page.keyboard.press('Tab');
      assert.equal(await keyboardAt(s.page), 'bar:group');
      await s.page.keyboard.press('Space');
      assert.equal((await barOf(s.page)).fields[1]?.[2], false, 'Space unticks group');
      for (const key of ['d', 'j', 'c']) await s.page.keyboard.press(key);
      assert.equal(await keyboardAt(s.page), 'bar:group', 'no list key acts');
      assert.equal(await selectedRow(s.page), NEW);
      assert.deepEqual(actsOf(s.w, 'done'), []);
      for (let i = 0; i < 3; i++) await s.page.keyboard.press('Tab');
      assert.equal(await keyboardAt(s.page), 'bar:Carry over');
      await s.page.keyboard.press('Enter');
      const sent = await s.w.act(1);
      assert.deepEqual(sent['fields'], ['label', 'ticket']);
      await s.page.waitForTimeout(150);
      assert.equal(barActs(s.w).length, 1, 'once');
      s.w.answer(sent, { ok: false, error: CHANGED });
      await until(async () => (await barOf(s.page)).message === CHANGED, 'refused');
      await hold(s.page, 'Escape', 4);
      assert.equal(await keyboardAt(s.page), '#list', 'Esc: the list');
      await showsText(s.page, '#focus-zone', /^Focus: list$/);
      assert.equal(inputs(s.w), 0, 'nothing reached the terminal');
    },
  );

  for (const smallest of [false, true]) {
    await t.test(
      smallest
        ? 'the trap on the smallest bar (one checkbox, no done) and on one whose new rev hid two checkboxes'
        : 'the trap: from every control Tab and Shift+Tab stay in the bar and wrap; twenty of each and a held Tab never leave it',
      async (t) => {
        const start = smallest
          ? {
              ...RUNNING,
              offer: offer({
                fields: [{ name: 'label', text: 'fix the retry', ticked: true }],
                done: null,
              }),
            }
          : RUNNING;
        const s = await barWorld(t, chromium, 'terminal', start);
        await onBar(s);
        const order = smallest ? ['bar:label', 'bar:Carry over', 'bar:×'] : ORDER;
        for (let at = 0; at < order.length; at++) {
          await s.page.keyboard.press('Tab');
          assert.equal(
            await keyboardAt(s.page),
            order[(at + 1) % order.length],
            `Tab from ${order[at]}`,
          );
        }
        for (let at = 0; at < order.length; at++) {
          await s.page.keyboard.press('Shift+Tab');
          const expected = order[(order.length - at - 1) % order.length];
          assert.equal(await keyboardAt(s.page), expected, `Shift+Tab ${at + 1}`);
        }
        for (const key of ['Tab', 'Shift+Tab']) {
          for (let i = 0; i < 20; i++) {
            await s.page.keyboard.press(key);
            assert.ok((await keyboardAt(s.page)).startsWith('bar:'), `${key} ${i + 1}`);
            assert.equal(await zone(s.page), 'Focus: list');
          }
        }
        await hold(s.page, 'Tab', 6);
        assert.ok((await keyboardAt(s.page)).startsWith('bar:'), 'a held Tab walks on inside');
        if (smallest) {
          // A new rev of the full bar, then one that hides group and ticket again.
          s.set({ offer: offer({ rev: REV2 }) });
          await until(async () => (await barOf(s.page)).fields.length === 4, 'the full bar');
          s.set({
            offer: offer({
              rev: 'cccccccccccccccc',
              fields: [{ name: 'label', text: 'fix the retry', ticked: true }],
            }),
          });
          await until(async () => (await barOf(s.page)).fields.length === 2, 'two hidden');
          await box(s.page, 'label').focus();
          const seen = new Set<string>();
          for (let i = 0; i < 8; i++) {
            await s.page.keyboard.press('Tab');
            seen.add(await keyboardAt(s.page));
          }
          assert.deepEqual([...seen].sort(), ['bar:Carry over', 'bar:done', 'bar:label', 'bar:×']);
        } else {
          s.w.holdViews(true);
          await inBar(s.page, '.carry-apply').focus();
          await s.page.keyboard.press('Enter');
          await s.w.act(1);
          for (let i = 0; i < 6; i++) {
            await s.page.keyboard.press('Tab');
            assert.ok((await keyboardAt(s.page)).startsWith('bar:'), 'Tab while the answer waits');
          }
        }
        assert.equal(inputs(s.w), 0, 'no input');
      },
    );
  }

  for (const button of ['Carry over', '×'] as const) {
    for (const over of ['resume', 'terminal'] as const) {
      await t.test(
        `a held Enter on ${button} over a ${over === 'resume' ? 'resume card' : 'running terminal'}: one act, and its repeats are no list key`,
        async (t) => {
          const start: World =
            over === 'resume'
              ? { rows: [row(NEW), row(OLD)], terminals: [], offer: offer() }
              : RUNNING;
          const s = await barWorld(t, chromium, 'list', start);
          await onBar(s);
          await (button === 'Carry over' ? apply : dismiss)(s.page).focus();
          await hold(s.page, 'Enter', 5, async () => {
            const sent = await s.w.act(1);
            s.w.answer(sent, { ok: true });
            await untilBar(s.page, false);
            s.set({ offer: null });
            await s.page.waitForTimeout(100);
          });
          await s.page.waitForTimeout(200);
          assert.equal(barActs(s.w).length, 1, 'one act of the bar');
          assert.deepEqual(actsOf(s.w, 'resume'), [], 'no resume');
          assert.equal(await keyboardAt(s.page), '#list', 'the list has the keyboard');
          assert.equal(await zone(s.page), 'Focus: list');
          assert.equal(inputs(s.w), 0, 'no input');
          await s.page.keyboard.press('Enter');
          if (over === 'resume') {
            await until(() => actsOf(s.w, 'resume').length === 1, 'a fresh Enter resumes');
          } else {
            await until(
              async () => (await active(s.page)) === 'in #terminal',
              'a fresh Enter shows the terminal',
            );
            assert.equal(inputs(s.w), 0);
          }
        },
      );
    }
  }

  await t.test(
    'a redraw with the same rev keeps the focused checkbox; Tab to Carry over, another such list, Enter: one act, nothing typed',
    async (t) => {
      const s = await barWorld(t, chromium, 'terminal');
      await onBar(s);
      await s.page.keyboard.press('Tab');
      await readPage(
        s.page,
        () => {
          (window as unknown as { focused: Element | null }).focused = document.activeElement;
        },
        null,
      );
      for (const state of ['working', 'waiting', 'running']) {
        s.set({
          rows: [row(NEW, { state, terminal: TERM_A, slot: 1 }), row(OLD)],
          offer: offer({
            fields: [
              { name: 'label', text: 'fix the retry', ticked: state !== 'working' },
              { name: 'group', text: 'backend', ticked: state === 'working' },
              { name: 'ticket', text: 'TRY-1', ticked: false },
            ],
          }),
        });
        await s.page.waitForTimeout(150);
        const same = await readPage(
          s.page,
          () =>
            (window as unknown as { focused: Element | null }).focused === document.activeElement,
          null,
        );
        assert.equal(same, true, `the same element after a ${state} list`);
      }
      assert.equal(await keyboardAt(s.page), 'bar:group');
      await s.page.keyboard.press('Tab');
      await s.page.keyboard.press('Tab');
      await s.page.keyboard.press('Tab');
      assert.equal(await keyboardAt(s.page), 'bar:Carry over');
      s.set({ rows: [row(NEW, { state: 'working', terminal: TERM_A, slot: 1 }), row(OLD)] });
      await s.page.waitForTimeout(150);
      await s.page.keyboard.press('Enter');
      await s.w.act(1);
      await s.page.waitForTimeout(150);
      assert.equal(barActs(s.w).length, 1);
      assert.equal(inputs(s.w), 0, 'nothing reached the terminal');
    },
  );

  await t.test(
    'a new rev that hides the focused checkbox gives the keyboard to the next one, the last field’s to the one before; one while Carry over has it to the first checkbox; Enter then sends nothing',
    async (t) => {
      const s = await barWorld(t, chromium, 'terminal');
      await onBar(s);
      s.set({
        offer: offer({
          rev: REV2,
          fields: [
            { name: 'group', text: 'backend', ticked: true },
            { name: 'ticket', text: 'TRY-1', ticked: true },
          ],
          kept: ['label'],
        }),
      });
      await until(async () => (await keyboardAt(s.page)) === 'bar:group', 'the next checkbox');
      assert.equal(await zone(s.page), 'Focus: list');
      await s.page.keyboard.press('Enter');
      await s.page.keyboard.press('Tab');
      assert.equal(await keyboardAt(s.page), 'bar:ticket');
      s.set({
        offer: offer({
          rev: 'cccccccccccccccc',
          fields: [{ name: 'group', text: 'backend', ticked: true }],
          kept: ['label', 'ticket'],
          done: null,
        }),
      });
      await until(async () => (await keyboardAt(s.page)) === 'bar:group', 'the one before');
      await s.page.keyboard.press('Tab');
      assert.equal(await keyboardAt(s.page), 'bar:Carry over');
      s.set({ offer: offer({ rev: 'dddddddddddddddd' }) });
      await until(async () => (await keyboardAt(s.page)) === 'bar:label', 'the first checkbox');
      await s.page.keyboard.press('Enter');
      await s.page.waitForTimeout(200);
      assert.deepEqual(barActs(s.w), [], 'no act');
      assert.equal(inputs(s.w), 0, 'nothing reached the terminal');
    },
  );

  await t.test(
    'the bar answered from another page, or another row clicked, with the keyboard on it: the list takes it; Enter next types nothing',
    async (t) => {
      const s = await barWorld(t, chromium, 'terminal');
      await onBar(s);
      await apply(s.page).focus();
      s.set({ offer: null });
      await untilBar(s.page, false);
      assert.equal(await keyboardAt(s.page), '#list');
      assert.equal(await zone(s.page), 'Focus: list');
      await s.page.keyboard.press('Enter');
      await until(async () => (await active(s.page)) === 'in #terminal', 'the terminal shown');
      assert.equal(inputs(s.w), 0, 'the Enter typed nothing');
      s.set({ offer: offer({ rev: REV2 }) });
      await untilBar(s.page, true);
      await onBar(s);
      await clickRow(s.page, OLD);
      await untilBar(s.page, false);
      assert.equal(await zone(s.page), 'Focus: list');
      assert.equal(inputs(s.w), 0);
    },
  );

  await t.test(
    'F41: in a browser that has not seen the tour, the tour shows over the bar; c, Enter and Tab do not reach the bar; after Esc the bar is there untouched, the keyboard back in the terminal, and c moves it to the bar',
    async (t) => {
      const s = await scripted(t, chromium, RUNNING, { tour: true });
      await untilBar(s.page, true);
      // The tour's root has no box of its own: attached and not hidden is shown.
      await s.page.waitForSelector('#tour:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      const before = await barOf(s.page);
      const inTour = () =>
        readPage(
          s.page,
          () => document.getElementById('tour')?.contains(document.activeElement) === true,
          null,
        );
      for (const key of ['c', 'Enter', 'Tab', 'Space']) {
        await s.page.keyboard.press(key);
        assert.equal(await inTour(), true, `${key}: the keyboard stays in the tour`);
        assert.ok(!(await keyboardAt(s.page)).startsWith('bar:'), `${key}: not on the bar`);
      }
      await s.page.waitForTimeout(200);
      assert.deepEqual(barActs(s.w), [], 'no act of the bar');
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('#tour[hidden]', { state: 'attached', timeout: PAGE_WAIT_MS });
      assert.deepEqual(await barOf(s.page), before, 'the bar is untouched');
      await until(
        async () => (await active(s.page)) === 'in #terminal',
        'the keyboard back in the terminal',
      );
      await onBar(s);
      assert.equal(await keyboardAt(s.page), 'bar:label');
      assert.equal(inputs(s.w), 0, 'nothing reached the terminal');
    },
  );

  await t.test(
    'Ctrl+Shift+L with the keyboard on the bar gives the terminal the keyboard',
    async (t) => {
      const s = await barWorld(t, chromium, 'terminal');
      await onBar(s);
      await s.page.keyboard.press('Control+Shift+L');
      await until(async () => (await active(s.page)) === 'in #terminal', 'the terminal');
      assert.equal(await zone(s.page), 'Focus: terminal');
    },
  );

  await t.test(
    'under a filter that hides the new row c still reaches the bar, and Enter on Carry over sends the act; c with nothing selected and on a pane without a bar says why',
    async (t) => {
      const s = await barWorld(t, chromium, 'terminal');
      await toZone(s.page, 'list');
      await s.page.keyboard.press('/');
      await s.page.keyboard.type('zzz');
      await s.page.keyboard.press('Enter');
      const hidden = row(NEW, { state: 'running', terminal: TERM_A, slot: 1 });
      s.set({ rows: [] });
      s.w.list(() => ({
        ...listOf({ rows: [], terminals: RUNNING.terminals, offer: offer() }, NEW),
        selectedRow: hidden,
      }));
      await until(
        async () =>
          readPage(s.page, (id) => document.querySelector(`#list [data-id="${id}"]`) === null, NEW),
        'the row hidden',
      );
      await untilBar(s.page, true);
      await s.page.keyboard.press('c');
      await until(async () => (await keyboardAt(s.page)) === 'bar:label', 'c: the bar');
      for (let i = 0; i < 4; i++) await s.page.keyboard.press('Tab');
      assert.equal(await keyboardAt(s.page), 'bar:Carry over');
      await s.page.keyboard.press('Enter');
      const sent = await s.w.act(1);
      assert.equal(sent['sessionId'], NEW);

      const other = await scripted(t, chromium, { rows: [], terminals: [], offer: null });
      await toZone(other.page, 'list');
      await other.page.keyboard.press('c');
      await showsText(other.page, '#key-message', /^no session selected$/);
      other.set({ rows: [row(OLD)] });
      await until(async () => (await selectedRow(other.page)) === OLD, 'OLD selected');
      await toZone(other.page, 'list');
      await other.page.keyboard.press('c');
      await showsText(other.page, '#key-message', /^nothing to carry over to this session$/);
    },
  );
});

// --- the review of 4035aed ----------------------------------------------------------------------

/** The `view`s the page sent so far. */
function views(w: EditWorld): number {
  return w.sent.filter((one) => one['t'] === 'view').length;
}

/** A new rev of the offer: another label, the note offered and ticked. */
const UNSEEN = offer({
  rev: REV2,
  fields: [
    { name: 'label', text: 'another label', ticked: true },
    { name: 'group', text: 'backend', ticked: true },
    { name: 'ticket', text: 'TRY-1', ticked: true },
    { name: 'note', text: null, ticked: true },
  ],
});

test('the carry-over bar after the review (F40)', async (t) => {
  const chromium = await browser(t);

  for (const dialog of ['the tour', 'Settings'] as const) {
    await t.test(
      `${dialog} gives the keyboard back to Carry over after a new rev came under it: it goes to the first checkbox, and Enter sends nothing`,
      async (t) => {
        const s = await barWorld(t, chromium, 'terminal');
        await onBar(s);
        await apply(s.page).focus();
        assert.equal(await keyboardAt(s.page), 'bar:Carry over');
        if (dialog === 'the tour') {
          await s.page.keyboard.press('Control+Shift+H');
          await s.page.waitForSelector('#help:not([hidden])');
          await s.page.locator('#help .help-tour').click();
          await s.page.waitForSelector('#tour:not([hidden])', {
            state: 'attached',
            timeout: PAGE_WAIT_MS,
          });
        } else {
          await s.page.locator('#settings-button').click();
          await s.page.waitForSelector('#settings:not([hidden])', {
            state: 'attached',
            timeout: PAGE_WAIT_MS,
          });
        }
        s.set({ offer: UNSEEN });
        await s.page.waitForTimeout(400);
        await s.page.keyboard.press('Escape');
        await s.page.waitForSelector(
          dialog === 'the tour' ? '#tour[hidden]' : '#settings[hidden]',
          {
            state: 'attached',
            timeout: PAGE_WAIT_MS,
          },
        );
        await until(async () => (await keyboardAt(s.page)) === 'bar:label', 'the first checkbox');
        assert.equal(await zone(s.page), 'Focus: list');
        await s.page.keyboard.press('Enter');
        await s.page.waitForTimeout(300);
        assert.deepEqual(barActs(s.w), [], 'no act');
        assert.equal(inputs(s.w), 0, 'nothing reached the terminal');
      },
    );
  }

  for (const dialog of ['the tour', 'Settings'] as const) {
    await t.test(
      `${dialog}: an offer that goes to another rev and back under it restarts the ticks, and the keyboard goes to the first checkbox; Enter sends nothing`,
      async (t) => {
        const s = await barWorld(t, chromium, 'terminal');
        await onBar(s);
        await s.page.keyboard.press('Space'); // label unticked
        for (let i = 0; i < 3; i++) await s.page.keyboard.press('Tab');
        assert.equal(await keyboardAt(s.page), 'bar:done');
        await s.page.keyboard.press('Space'); // done unticked
        await s.page.keyboard.press('Tab');
        assert.equal(await keyboardAt(s.page), 'bar:Carry over');
        assert.deepEqual(
          (await barOf(s.page)).fields.map(([, , checked]) => checked),
          [false, true, true, false],
        );
        if (dialog === 'the tour') {
          await s.page.keyboard.press('Control+Shift+H');
          await s.page.waitForSelector('#help:not([hidden])');
          await s.page.locator('#help .help-tour').click();
          await s.page.waitForSelector('#tour:not([hidden])', {
            state: 'attached',
            timeout: PAGE_WAIT_MS,
          });
        } else {
          await s.page.locator('#settings-button').click();
          await s.page.waitForSelector('#settings:not([hidden])', {
            state: 'attached',
            timeout: PAGE_WAIT_MS,
          });
        }
        s.set({ offer: offer({ rev: REV2 }) });
        await s.page.waitForTimeout(400);
        s.set({ offer: offer() });
        await s.page.waitForTimeout(400);
        await s.page.keyboard.press('Escape');
        await s.page.waitForSelector(
          dialog === 'the tour' ? '#tour[hidden]' : '#settings[hidden]',
          {
            state: 'attached',
            timeout: PAGE_WAIT_MS,
          },
        );
        await until(async () => (await keyboardAt(s.page)) === 'bar:label', 'the first checkbox');
        assert.deepEqual(
          (await barOf(s.page)).fields.map(([, , checked]) => checked),
          [true, true, true, true],
          'the restarted ticks',
        );
        await s.page.keyboard.press('Enter');
        await s.page.waitForTimeout(300);
        assert.deepEqual(barActs(s.w), [], 'no act');
        assert.equal(inputs(s.w), 0);
      },
    );
  }

  for (const button of ['right', 'middle'] as const) {
    for (const from of ['bar', 'list'] as const) {
      await t.test(
        `a ${button} press on the heading leaves the keyboard ${from === 'bar' ? 'on the bar' : 'on the list'}; the next Enter reaches no program`,
        async (t) => {
          const s = await barWorld(t, chromium, 'list');
          if (from === 'bar') await onBar(s);
          const before = await keyboardAt(s.page);
          const at = await inBar(s.page, '.carry-heading').boundingBox();
          assert.ok(at !== null);
          await s.page.mouse.click(at.x + 4, at.y + at.height / 2, { button });
          await s.page.waitForTimeout(300);
          assert.equal(await keyboardAt(s.page), before);
          assert.equal(await zone(s.page), 'Focus: list');
          await s.page.keyboard.press('Enter');
          await s.page.waitForTimeout(300);
          assert.equal(inputs(s.w), 0, 'nothing reached the terminal');
          assert.deepEqual(barActs(s.w), []);
        },
      );
    }
  }

  await t.test(
    'with the New form open over the selection, a terminal that moves to another session sends a focus naming it',
    async (t) => {
      const page = await newPage(t, chromium);
      const w = await editWorld(
        t,
        page,
        scriptedList(
          [
            { id: S1, terminal: TERM_A, slot: 1 },
            { id: S3, terminal: null, slot: null },
          ],
          [{ id: TERM_A, slot: 1, sessionId: S1 }],
        ),
      );
      await clickRow(page, S1);
      await page.keyboard.press('Control+Shift+N');
      await until(
        async () =>
          (await readPage(
            page,
            () => document.getElementById('right-zone')?.dataset['pane'],
            null,
          )) === 'new',
        'the New form',
      );
      await page.waitForTimeout(500);
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
      await until(
        () => w.sent.some((one) => one['t'] === 'focus' && one['selected'] === S2),
        'a focus names S2',
      );
    },
  );

  for (const from of ['bar', 'list', 'terminal'] as const) {
    await t.test(
      `a click on the heading that selects nothing leaves the keyboard ${from === 'bar' ? 'on the bar' : from === 'list' ? 'on the list' : 'in the terminal'}`,
      async (t) => {
        const s = await barWorld(t, chromium, from === 'terminal' ? 'terminal' : 'list');
        if (from === 'bar') await onBar(s);
        const before = await keyboardAt(s.page);
        const zoneBefore = await zone(s.page);
        await inBar(s.page, '.carry-heading').click();
        await s.page.waitForTimeout(300);
        assert.equal(await keyboardAt(s.page), before);
        assert.equal(await zone(s.page), zoneBefore);
        if (from !== 'terminal') {
          await s.page.keyboard.press('Enter');
          await s.page.waitForTimeout(300);
          assert.equal(inputs(s.w), 0, 'the next Enter reaches no program');
          assert.deepEqual(barActs(s.w), []);
        }
      },
    );
  }

  await t.test(
    'a click on the refusal over the heading leaves the keyboard on the bar',
    async (t) => {
      const s = await barWorld(t, chromium, 'list');
      await onBar(s);
      await apply(s.page).focus();
      await s.page.keyboard.press('Enter');
      s.w.answer(await s.w.act(1), { ok: false, error: CHANGED });
      await until(async () => (await barOf(s.page)).message === CHANGED, 'the refusal');
      await inBar(s.page, '.carry-message').click();
      await s.page.waitForTimeout(300);
      assert.equal(await keyboardAt(s.page), 'bar:Carry over');
      assert.equal(await zone(s.page), 'Focus: list');
      assert.equal(inputs(s.w), 0);
    },
  );

  await t.test('a held Enter on Carry over whose act is refused sends one act', async (t) => {
    const s = await barWorld(t, chromium, 'list');
    await onBar(s);
    await apply(s.page).focus();
    await hold(s.page, 'Enter', 6, async () => {
      s.w.answer(await s.w.act(1), { ok: false, error: CHANGED });
      await until(async () => (await barOf(s.page)).message === CHANGED, 'refused');
    });
    await s.page.waitForTimeout(300);
    assert.equal(barActs(s.w).length, 1);
  });

  await t.test('while the answer waits a checkbox takes no press', async (t) => {
    const s = await barWorld(t, chromium, 'list');
    await apply(s.page).click();
    await s.w.act(1);
    const before = (await barOf(s.page)).fields;
    await box(s.page, 'group').click({ force: true });
    await s.page.waitForTimeout(200);
    assert.deepEqual((await barOf(s.page)).fields, before);
  });

  for (const button of ['Carry over', '×'] as const) {
    await t.test(
      `the second click of a double click on ${button} sends nothing, also when the first was refused in between`,
      async (t) => {
        const s = await barWorld(t, chromium, 'list');
        const at = await (button === 'Carry over' ? apply : dismiss)(s.page).boundingBox();
        assert.ok(at !== null);
        await s.page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
        await s.page.mouse.down({ clickCount: 1 });
        await s.page.mouse.up({ clickCount: 1 });
        s.w.answer(await s.w.act(1), { ok: false, error: CHANGED });
        await until(async () => (await keyMessage(s.page)) === CHANGED, 'refused');
        await s.page.mouse.down({ clickCount: 2 });
        await s.page.mouse.up({ clickCount: 2 });
        await s.page.waitForTimeout(300);
        assert.equal(barActs(s.w).length, 1);
      },
    );
  }

  await t.test(
    'an ok carry-over asks for its list with one view; an ok dismissal with one view; after an ok carry-over its dialogs wait for that list',
    async (t) => {
      const s = await barWorld(t, chromium, 'list');
      s.w.holdViews(true);
      await apply(s.page).click();
      const sent = await s.w.act(1);
      const before = views(s.w);
      s.w.answer(sent, { ok: true });
      await untilBar(s.page, false);
      await s.page.waitForTimeout(300);
      assert.equal(views(s.w) - before, 1, 'one view after the carry over');
      await s.page.keyboard.press('l');
      await showsText(s.page, '#key-message', /^the label is not here yet; press l again$/);
      s.w.holdViews(false);
      s.set({ offer: offer({ rev: REV2 }) });
      await untilBar(s.page, true);
      await dismiss(s.page).click();
      const dismissed = await s.w.act(2);
      const beforeDismiss = views(s.w);
      s.w.answer(dismissed, { ok: true });
      await untilBar(s.page, false);
      await s.page.waitForTimeout(300);
      assert.equal(views(s.w) - beforeDismiss, 1, 'one view after the dismissal');
    },
  );

  await t.test(
    "a refusal that comes back after another session's offer was selected is not drawn on that bar",
    async (t) => {
      const s = await barWorld(t, chromium, 'list', {
        ...RUNNING,
        others: {
          [OLD]: offer({ rev: 'eeeeeeeeeeeeeeee', from: { id: S3, title: 'older', ticket: null } }),
        },
      });
      await apply(s.page).click();
      const sent = await s.w.act(1);
      await clickRow(s.page, OLD);
      await until(
        async () => (await barOf(s.page)).heading === 'Cleared from "older"',
        "OLD's bar",
      );
      s.w.answer(sent, { ok: false, error: CHANGED });
      await showsText(
        s.page,
        '#key-message',
        new RegExp(CHANGED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.equal((await barOf(s.page)).message, '', "not on OLD's bar");
    },
  );

  await t.test('the bar is hidden on a group card and on an empty pane', async (t) => {
    // NEW and OLD are one open block (a card); ← on NEW closes it and selects its caption.
    const stack = (role: 'head' | 'member') => ({ group: 'blocked', size: 2, role, head: NEW });
    const s = await barWorld(t, chromium, 'list', {
      ...RUNNING,
      rows: [
        row(NEW, { state: 'running', terminal: TERM_A, slot: 1, stack: stack('head') }),
        row(OLD, { stack: stack('member') }),
      ],
    });
    await s.page.keyboard.press('ArrowLeft');
    await until(
      async () =>
        (await readPage(
          s.page,
          () => document.getElementById('right-zone')?.dataset['pane'],
          null,
        )) === 'group',
      'the group card',
    );
    await untilBar(s.page, false);
    await s.page.keyboard.press('ArrowRight'); // opens the block and selects its first row
    await untilBar(s.page, true);
    s.set({ rows: [row(OLD)], terminals: [] });
    await until(
      async () =>
        (await readPage(
          s.page,
          () => document.getElementById('right-zone')?.dataset['pane'],
          null,
        )) === 'none',
      'the empty pane',
    );
    await untilBar(s.page, false);
  });
});
