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
  launched,
  logOf,
  mark,
  pageUrl,
  readPage,
  scriptedList,
  selectedRow,
  showsText,
  toZone,
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
        closedStacks: [],
      },
    ],
    terminals: world.terminals,
    selected:
      selected === null ? null : selectedOf(selected, selected === NEW ? world.offer : null),
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

async function scripted(t: TestContext, chromium: Browser, start: World): Promise<Scripted> {
  const page = await newPage(t, chromium);
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

