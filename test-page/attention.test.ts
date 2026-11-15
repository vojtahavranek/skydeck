// Attention in the page (S2 12.1, 12.2, 12.4, 12.9, 13, 17.4; plan B task 55, B13–B17): the
// marks on the rows, the title bar's count and the window title, Ctrl+Shift+J, and desktop
// notifications — the permission asked only on a click, a notification shown, clicked and closed.
// Every case runs against a scripted stand-in server (`attentionWorld` below) that sends lists
// with `attention` and `needYou`, and `notify`; the page has web/'s real modules. Notifications go
// to the recording double of helpers/notification.ts, never to the desktop (B17: every other page
// sees the inert `Notification` of helpers/browser.ts).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, inertNotification, newPage, NOTIFICATION_DOUBLE } from './helpers/browser.ts';
import {
  clickNotification,
  closedByBrowser,
  installDouble,
  notificationDouble,
  notificationsOf,
  pageFocus,
  setPermission,
} from './helpers/notification.ts';
import type { NotificationRecord } from './helpers/notification.ts';
import {
  active,
  clickRow,
  connection,
  honest,
  PAGE_WAIT_MS,
  problemsOf,
  scriptedList,
  selectedRow,
  showsText,
  standinServer,
  storeKey,
  TERM_A,
  TERM_B,
  TERM_C,
  toZone,
  zone,
} from './helpers/shell.ts';

type Row = Record<string, unknown>;

/** A fourth and a fifth session id. */
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
/** The stand-in's `nowNs` (scriptedList's). */
const NOW_NS = 1794474000000000000n;
const MIN = 60_000_000_000n;
const ago = (ns: bigint): string => String(NOW_NS - ns);

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

/** A row's `attention` (plan B 2.3), `minutes` ago. */
function attention(reason: string, minutes: bigint, detail: string | null = null): Row {
  return { reason, detail, sinceNs: ago(minutes * MIN) };
}

interface Sections {
  open?: Row[];
  week?: Row[];
}

/** A list of these sections and terminals; `needYou` as given (left out when undefined). */
function listOf(
  sections: Sections,
  terminals: Row[],
  needYou: { count: number; order: string[] } | undefined,
  counts: Row = {},
): Row {
  const list: Row = {
    ...scriptedList([], []),
    counts: {
      working: 0,
      waiting: 0,
      running: 0,
      starting: 0,
      elsewhere: 0,
      notRunning: 0,
      ...counts,
    },
    sections: (['open', 'week', 'earlier'] as const).map((name) => ({
      name,
      folded: false,
      firstNs: null,
      lastNs: null,
      count: name === 'earlier' ? 0 : (sections[name]?.length ?? 0),
      rows: name === 'earlier' ? [] : (sections[name] ?? []),
    })),
    terminals,
  };
  if (needYou !== undefined) list['needYou'] = needYou;
  return list;
}

/** What the page sent to an `attentionWorld`, and the means to script it. */
interface AttentionWorld {
  page: Page;
  problems: string[];
  /** Every message the page sent after its `start` but pings, in order. */
  sent: Row[];
  /** The lists from now on: `lists(view)` for the page's last `view`; sent now unless `send` is false. */
  set(lists: (view: { filter: string; selected: string | null }) => Row, send?: boolean): void;
  /** Sends `message` on the connection the page uses now. */
  send(message: Row): void;
}

let worldSeed = 90;

/**
 * A scripted stand-in (as helpers/shell.ts's `editWorld`, with a way to send any message): the
 * page on a new page of `newPage`, with `before` run first (the doubles' init scripts), is opened
 * with a stored key and connected; every `view` is answered with `lists` of that view, every
 * `attach` with an empty `snap` at the size it proposed, and every `act` is only recorded.
 */
async function attentionWorld(
  t: TestContext,
  chromium: Browser,
  first: (view: { filter: string; selected: string | null }) => Row,
  before?: (page: Page) => Promise<void>,
): Promise<AttentionWorld> {
  const page = await newPage(t, chromium);
  await before?.(page);
  const problems = problemsOf(page);
  const secret = new Uint8Array(32).fill(worldSeed++);
  const sent: Row[] = [];
  let lists = first;
  let view = { filter: '', selected: null as string | null };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        sent.push(message);
        if (message['t'] === 'view') {
          view = {
            filter: typeof message['filter'] === 'string' ? message['filter'] : '',
            selected: (message['selected'] as string | null) ?? null,
          };
          conn.send(lists(view));
        } else if (message['t'] === 'attach') {
          const { term, cols, rows } = message as { term: string; cols: number; rows: number };
          conn.send({ t: 'snap', term, ch: 1, cols, rows, data: '' });
        }
      },
    }),
  });
  const conn = (): { send(message: unknown): void } => {
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
    problems,
    sent,
    set(next, send = true) {
      lists = next;
      if (send) conn().send(lists(view));
    },
    send: (message) => conn().send(message),
  };
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

/** Waits until the window title is `title` (the sign that a list was taken). */
async function titleIs(page: Page, title: string): Promise<void> {
  await page.waitForFunction((title) => document.title === title, title, {
    timeout: PAGE_WAIT_MS,
  });
}

/** Waits until the double has seen what `holds` says. */
async function recorded(
  page: Page,
  holds: (record: NotificationRecord) => boolean,
  what: string,
): Promise<NotificationRecord> {
  return eventually(async () => {
    const record = await notificationsOf(page);
    return holds(record) && record;
  }, what);
}

/** Empties the key bar's message, so that the next one can be told from the last. */
async function clearKeyMessage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const message = document.getElementById('key-message');
    if (message !== null) message.textContent = '';
  });
}

/** Whether the `messages` include a `t` message whose `selected` is `id`. */
function sentWith(messages: Row[], t: string, id: string): boolean {
  return messages.some((message) => message['t'] === t && message['selected'] === id);
}

/** What a row of the list shows of attention (computed styles included). */
async function rowLooks(page: Page): Promise<
  Record<
    string,
    {
      attention: string | null;
      lines: string;
      weight: string;
      state: string;
      bar: { content: string; colour: string; width: string };
    }
  >
> {
  return page.evaluate(() => {
    const looks: Record<string, unknown> = {};
    for (const element of document.querySelectorAll<HTMLElement>('#list [data-id]')) {
      const title = element.querySelector<HTMLElement>('.row-title');
      const bar = getComputedStyle(element, '::before');
      looks[element.dataset['id'] ?? ''] = {
        attention: element.dataset['attention'] ?? null,
        lines: element.dataset['lines'] ?? '',
        weight: title === null ? '' : getComputedStyle(title).fontWeight,
        state: element.querySelector('.row-state')?.textContent ?? '',
        bar: { content: bar.content, colour: bar.backgroundColor, width: bar.width },
      };
    }
    return looks as never;
  });
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

// B17's source scan, its names built from parts so that the scan does not find itself: a context
// made by Playwright's own calls (a new one, a persistent one, one over CDP), and a page made by a
// browser rather than by a context (which makes a context of its own).
const OWN_CONTEXT = new RegExp(
  ['\\.new' + 'Context\\s*\\(', 'launch' + 'PersistentContext', 'connect' + 'OverCDP'].join('|'),
);
const PAGE_OF_A_BROWSER = new RegExp('(?<!context|context\\(\\))\\.new' + 'Page\\s*\\(');

test('attention in the page', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "a row that needs you: data-attention, a bold title, a left bar in its reason's colour, the reason's line; an ended row that is not running has two lines; a row that needs nothing has neither",
    async (t) => {
      const w = await attentionWorld(t, chromium, () =>
        listOf(
          {
            open: [
              running(S1, TERM_A, 1, {
                state: 'waiting',
                attention: attention('asks', 3n, 'permission · Bash'),
              }),
              running(S2, TERM_B, 2, { attention: attention('finished', 2n) }),
              running(S3, TERM_C, 3),
            ],
            week: [
              row(S4, { marks: ['ended-unexpectedly'], attention: attention('ended', 2n) }),
              row(S5),
            ],
          },
          [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2), terminal(TERM_C, S3, 3)],
          { count: 3, order: [S1, S4, S2] },
          { running: 1, notRunning: 1 },
        ),
      );
      await titleIs(w.page, '(3) skydeck');
      const looks = await rowLooks(w.page);
      const look = (id: string): NonNullable<(typeof looks)[string]> => {
        const found = looks[id];
        assert.ok(found !== undefined, `the row of ${id}`);
        return found;
      };
      const [asks, finished, plain, ended, notRunning] = [S1, S2, S3, S4, S5].map(look) as [
        ReturnType<typeof look>,
        ReturnType<typeof look>,
        ReturnType<typeof look>,
        ReturnType<typeof look>,
        ReturnType<typeof look>,
      ];

      assert.equal(asks.attention, 'asks');
      assert.equal(asks.state, 'needs you · permission · Bash · 3m');
      assert.equal(finished.attention, 'finished');
      assert.equal(finished.state, 'finished · not seen · 2m');
      assert.equal(ended.attention, 'ended');
      assert.equal(ended.lines, '2', 'an ended row that is not running has two lines');
      assert.equal(ended.state, 'ended unexpectedly · not seen · 2m');
      for (const look of [asks, finished, ended]) {
        assert.equal(look.weight, '700', 'a bold title');
        assert.notEqual(look.bar.content, 'none', 'a left bar');
        assert.equal(look.bar.width, '3px');
        assert.notEqual(look.bar.colour, TRANSPARENT);
      }
      assert.equal(new Set([asks, finished, ended].map((look) => look.bar.colour)).size, 3);
      for (const look of [plain, notRunning]) {
        assert.equal(look.attention, null);
        assert.equal(look.bar.content, 'none', 'no bar');
        assert.notEqual(look.weight, '700');
      }
      assert.equal(plain.weight, '600', 'a running row keeps its own title');
      assert.equal(notRunning.lines, '1');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'the title bar starts with `3 need you`, its dot drawn by the style sheet in the attention colour; the window title is (3) skydeck, and skydeck again with a list without; a list of stage A shows neither and throws nothing',
    async (t) => {
      const needing = (): Row =>
        listOf(
          {
            open: [
              running(S1, TERM_A, 1, { attention: attention('asks', 1n) }),
              running(S2, TERM_B, 2),
            ],
            week: [row(S3, { attention: attention('ended', 1n) }), row(S4)],
          },
          [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2)],
          { count: 3, order: [S1, S3] },
          { running: 1, notRunning: 1 },
        );
      const w = await attentionWorld(t, chromium, needing);
      await titleIs(w.page, '(3) skydeck');
      await showsText(w.page, '#counts', /^3 need you · 1 running · 1 not running$/);
      const count = await w.page.evaluate(() => {
        const element = document.querySelector<HTMLElement>('#counts [data-state="need-you"]');
        if (element === null) return null;
        const dot = getComputedStyle(element, '::before');
        const bar = getComputedStyle(
          document.querySelector('#list [data-attention="asks"]') as Element,
          '::before',
        );
        return {
          first: element === document.getElementById('counts')?.firstElementChild,
          text: element.textContent,
          dot: { content: dot.content, colour: dot.backgroundColor, width: dot.width },
          attentionColour: bar.backgroundColor,
        };
      });
      assert.ok(count !== null, 'the count has its element');
      assert.equal(count.first, true, 'the count comes first');
      assert.equal(count.text, '3 need you', 'the text only: no dot character');
      assert.notEqual(count.dot.content, 'none', 'the dot is the style sheet’s');
      assert.notEqual(count.dot.width, '0px');
      assert.equal(count.dot.colour, count.attentionColour, "the rows' attention colour");

      // A list in which nothing needs you.
      w.set(() =>
        listOf(
          { open: [running(S1, TERM_A, 1), running(S2, TERM_B, 2)], week: [row(S3), row(S4)] },
          [terminal(TERM_A, S1, 1), terminal(TERM_B, S2, 2)],
          { count: 0, order: [] },
          { running: 2, notRunning: 2 },
        ),
      );
      await titleIs(w.page, 'skydeck');
      await showsText(w.page, '#counts', /^2 running · 2 not running$/);
      assert.equal(await w.page.locator('#counts [data-state="need-you"]').count(), 0);
      assert.equal(await w.page.locator('#list [data-attention]').count(), 0);

      // Back to three, then a list of stage A (no needYou, rows without attention).
      w.set(needing);
      await titleIs(w.page, '(3) skydeck');
      const stageA = scriptedList(
        [
          { id: S1, terminal: TERM_A, slot: 1 },
          { id: S2, terminal: null, slot: null },
        ],
        [{ id: TERM_A, slot: 1, sessionId: S1 }],
      );
      for (const listed of (stageA['sections'] as { rows: Row[] }[])[0]?.rows ?? []) {
        delete listed['attention'];
      }
      w.set(() => stageA);
      await titleIs(w.page, 'skydeck');
      assert.equal(await w.page.locator('#counts [data-state="need-you"]').count(), 0);
      assert.equal(await w.page.locator('#list [data-attention]').count(), 0);
      await w.page.keyboard.press('Control+Shift+J');
      await showsText(w.page, '#key-message', /^no session needs you$/);
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'Ctrl+Shift+J in both zones selects the first of needYou.order, then the next, then the first again, and sends view and focus with it; none, only the selected one, and those the filter or the fold hides say so',
    async (t) => {
      const sections = (needs: boolean): Sections => ({
        open: [
          running(S1, TERM_A, 1),
          running(S3, TERM_C, 2, needs ? { attention: attention('asks', 2n) } : {}),
        ],
        week: [row(S2, needs ? { attention: attention('ended', 1n) } : {})],
      });
      const terms = [terminal(TERM_A, S1, 1), terminal(TERM_C, S3, 2)];
      const w = await attentionWorld(t, chromium, () =>
        listOf(sections(true), terms, { count: 2, order: [S3, S2] }),
      );
      await titleIs(w.page, '(2) skydeck');
      await eventually(async () => (await selectedRow(w.page)) === S1, 'the first row selected');
      assert.equal(await zone(w.page), 'Focus: terminal');

      /** Ctrl+Shift+J; then `id` is selected, in `zoneAfter`, and view and focus were sent. */
      const next = async (id: string, zoneAfter: string): Promise<void> => {
        const from = w.sent.length;
        await w.page.keyboard.press('Control+Shift+J');
        await eventually(async () => (await selectedRow(w.page)) === id, `${id} selected`);
        await eventually(
          async () =>
            sentWith(w.sent.slice(from), 'view', id) && sentWith(w.sent.slice(from), 'focus', id),
          `view and focus with ${id}`,
        );
        await showsText(w.page, '#focus-zone', new RegExp(`^${zoneAfter}$`));
      };
      await next(S3, 'Focus: terminal'); // from the terminal zone: the first of the order
      await next(S2, 'Focus: list'); // the next (a row that is not running: the list zone)
      await next(S3, 'Focus: terminal'); // from the list zone: after the last, the first again

      // None needs you: nothing moves.
      w.set(() => listOf(sections(false), terms, { count: 0, order: [] }));
      await titleIs(w.page, 'skydeck');
      await clearKeyMessage(w.page);
      await w.page.keyboard.press('Control+Shift+J');
      await showsText(w.page, '#key-message', /^no session needs you$/);
      assert.equal(await selectedRow(w.page), S3);

      // More need you than the page shows: the next, and how many are hidden.
      w.set(() => listOf(sections(true), terms, { count: 4, order: [S3, S2] }));
      await titleIs(w.page, '(4) skydeck');
      await clearKeyMessage(w.page);
      await w.page.keyboard.press('Control+Shift+J');
      await showsText(
        w.page,
        '#key-message',
        /^2 more that need you are hidden by the filter or the fold$/,
      );
      assert.equal(await selectedRow(w.page), S2);

      // None shown, two hidden.
      w.set(() => listOf(sections(false), terms, { count: 2, order: [] }));
      await titleIs(w.page, '(2) skydeck');
      await clearKeyMessage(w.page);
      await w.page.keyboard.press('Control+Shift+J');
      await showsText(
        w.page,
        '#key-message',
        /^2 that need you are hidden by the filter or the fold$/,
      );
      assert.equal(await selectedRow(w.page), S2);

      // Only the selected one needs you: it stays selected.
      w.set(() =>
        listOf(
          {
            open: [running(S1, TERM_A, 1), running(S3, TERM_C, 2)],
            week: [row(S2, { attention: attention('ended', 1n) })],
          },
          terms,
          { count: 1, order: [S2] },
        ),
      );
      await titleIs(w.page, '(1) skydeck');
      await clearKeyMessage(w.page);
      const from = w.sent.length;
      await w.page.keyboard.press('Control+Shift+J');
      await showsText(w.page, '#key-message', /^no other session needs you$/);
      assert.equal(await selectedRow(w.page), S2);
      assert.equal(
        w.sent.slice(from).some((message) => message['t'] === 'view'),
        false,
        'nothing selected anew',
      );
      assert.deepEqual(w.problems, []);
    },
  );

  /** A list in which S1 (running) asks, S2 (not running) ended and S3 (running) finished. */
  const threeNeed = (view: { filter: string; selected: string | null }): Row => {
    const shown = (title: string): boolean => view.filter === '' || title.includes(view.filter);
    const rows = {
      open: [
        running(S1, TERM_A, 1, {
          title: 'alpha',
          attention: attention('asks', 1n, 'permission · Bash'),
        }),
        running(S3, TERM_C, 2, { title: 'gamma', attention: attention('finished', 1n) }),
      ],
      week: [row(S2, { title: 'beta', attention: attention('ended', 1n) })],
    };
    const filtered = {
      open: rows.open.filter((listed) => shown(listed['title'] as string)),
      week: rows.week.filter((listed) => shown(listed['title'] as string)),
    };
    return listOf(filtered, [terminal(TERM_A, S1, 1), terminal(TERM_C, S3, 2)], {
      count: 3,
      order: [S1, S2, S3].filter((id) =>
        [...filtered.open, ...filtered.week].some((listed) => listed['id'] === id),
      ),
    });
  };

  await t.test(
    'notifications, permission `default`: the button is shown and nothing is asked at load or by any key; a click asks once, with user activation; `granted` hides the button; a permission changed outside shows or hides it at the next list or focus',
    async (t) => {
      const w = await attentionWorld(t, chromium, threeNeed, (page) =>
        notificationDouble(page, 'default', 'granted'),
      );
      await titleIs(w.page, '(3) skydeck');
      await showsText(w.page, '#notify-on', /^Turn on notifications$/);
      for (const key of [
        'Control+Shift+J',
        'Control+Shift+L',
        'j',
        'k',
        'Escape',
        'Control+Shift+J',
        'Control+Shift+H',
      ]) {
        await w.page.keyboard.press(key);
      }
      await w.page.waitForSelector('#help:not([hidden])', { timeout: PAGE_WAIT_MS }); // the last key
      await w.page.keyboard.press('Control+Shift+H');
      assert.deepEqual((await notificationsOf(w.page)).asked, [], 'nothing asked yet');

      await w.page.locator('#notify-on').click();
      const record = await recorded(w.page, (r) => r.asked.length > 0, 'the permission asked');
      assert.deepEqual(record.asked, [{ active: true }]);
      await w.page.waitForSelector('#notify-on[hidden]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });

      // Changed outside the page (the browser's own settings): the next list shows the button
      // again, and coming back to the window hides it once the permission is no longer default.
      await setPermission(w.page, 'default');
      w.send(listOf({ open: [row(S1)] }, [], { count: 0, order: [] }));
      await w.page.waitForSelector('#notify-on:not([hidden])', { timeout: PAGE_WAIT_MS });
      await setPermission(w.page, 'denied');
      await pageFocus(w.page, true);
      await w.page.waitForSelector('#notify-on[hidden]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      assert.equal((await notificationsOf(w.page)).asked.length, 1, 'asked once, by the click');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'notifications, permission `granted`: a `notify` while the page is unfocused shows one with the title, the body and the tag; hostile text stays text; a click focuses the window and selects the session; a list in which the session no longer needs you closes it, one that merely does not list it does not; none for the session selected in the focused page',
    async (t) => {
      const w = await attentionWorld(t, chromium, threeNeed, (page) =>
        notificationDouble(page, 'granted'),
      );
      await titleIs(w.page, '(3) skydeck');
      assert.equal(await w.page.locator('#notify-on').isHidden(), true, 'no button');
      assert.equal(await selectedRow(w.page), S1);
      await pageFocus(w.page, false);

      // One notification, with its strings as text.
      w.send({ t: 'notify', sessionId: S2, title: 'beta', reason: 'ended', detail: null });
      let record = await recorded(w.page, (r) => r.made.length === 1, 'a notification');
      assert.deepEqual(record.made[0], {
        title: 'beta',
        body: 'ended unexpectedly',
        tag: S2,
        types: ['string', 'string', 'string'],
      });

      // Hostile text: sanitised, given as plain strings, no element added.
      w.send({
        t: 'notify',
        sessionId: S1,
        title: '<img src=x onerror="document.documentElement.dataset.owned=1">\x1b]0;x\x07alpha',
        reason: 'asks',
        detail: '<script>document.documentElement.dataset.owned=2</script>\x1b[31m',
      });
      record = await recorded(w.page, (r) => r.made.length === 2, 'a second notification');
      assert.deepEqual(record.made[1], {
        title: '<img src=x onerror="document.documentElement.dataset.owned=1">alpha',
        body: 'asks: <script>document.documentElement.dataset.owned=2</script>',
        tag: S1,
        types: ['string', 'string', 'string'],
      });
      assert.deepEqual(
        await w.page.evaluate(() => ({
          images: document.querySelectorAll('img').length,
          scripts: document.querySelectorAll('script').length,
          owned: document.documentElement.dataset['owned'] ?? null,
        })),
        { images: 0, scripts: 1, owned: null },
      );

      // A click: the window to the front, the session selected, the notification closed.
      const views = w.sent.length;
      await clickNotification(w.page, 0);
      record = await recorded(w.page, (r) => r.focused > 0, 'window.focus called');
      assert.equal(record.focused, 1);
      await eventually(async () => (await selectedRow(w.page)) === S2, 'the session selected');
      await eventually(async () => sentWith(w.sent.slice(views), 'view', S2), 'its view');
      assert.ok(record.closed.includes(0), 'a clicked notification is closed');
      assert.equal(record.closed.includes(1), false);

      // A newer notification of a session replaces the older one (its tag); the browser's later
      // `close` of the replaced one forgets nothing, so a list in which the session is listed and
      // no longer needs you closes the newer one.
      w.send({ t: 'notify', sessionId: S1, title: 'alpha', reason: 'asks', detail: null });
      await recorded(w.page, (r) => r.made.length === 3, "alpha's newer notification");
      await closedByBrowser(w.page, 1);
      const alphaSeen =
        (count: number) =>
        (view: { filter: string; selected: string | null }): Row => {
          const list = threeNeed(view);
          const open = (list['sections'] as { rows: Row[] }[])[0]?.rows ?? [];
          const alpha = open.find((listed) => listed['id'] === S1);
          if (alpha !== undefined) alpha['attention'] = null;
          list['needYou'] = { ...(list['needYou'] as Row), count };
          return list;
        };
      w.set(alphaSeen(2));
      record = await recorded(w.page, (r) => r.closed.includes(2), "alpha's newer one closed");
      await titleIs(w.page, '(2) skydeck');

      // A filter that hides gamma, then gamma's notification, then a list (ruled): the list does
      // not carry gamma's row, so its notification stays; and once the row is back with its
      // attention, too.
      const filter = async (text: string): Promise<void> => {
        await toZone(w.page, 'list');
        await w.page.keyboard.press('/');
        await w.page.keyboard.type(text);
        await w.page.waitForSelector(`#list [data-id="${S3}"]`, {
          state: 'detached',
          timeout: PAGE_WAIT_MS,
        });
      };
      await filter('bet');
      w.send({ t: 'notify', sessionId: S3, title: 'gamma', reason: 'finished', detail: null });
      await recorded(w.page, (r) => r.made.length === 4, "gamma's notification");
      w.set(alphaSeen(3)); // a list that differs: its count
      await titleIs(w.page, '(3) skydeck');
      assert.equal((await notificationsOf(w.page)).closed.includes(3), false, "gamma's stays");
      await w.page.keyboard.press('Escape'); // the filter cleared: gamma is listed again
      await w.page.waitForSelector(`#list [data-id="${S3}"]`, { timeout: PAGE_WAIT_MS });
      assert.equal((await notificationsOf(w.page)).closed.includes(3), false, "gamma's stays");

      // A list in which nothing needs you closes every one left, also one whose row it does not
      // carry (gamma's, hidden by the filter again).
      await filter('bet');
      w.set((view) => {
        const shown = (listed: Row): boolean =>
          view.filter === '' || (listed['title'] as string).includes(view.filter);
        return listOf(
          {
            open: [
              running(S1, TERM_A, 1, { title: 'alpha' }),
              running(S3, TERM_C, 2, { title: 'gamma' }),
            ].filter(shown),
            week: [row(S2, { title: 'beta' })].filter(shown),
          },
          [terminal(TERM_A, S1, 1), terminal(TERM_C, S3, 2)],
          { count: 0, order: [] },
        );
      });
      record = await recorded(w.page, (r) => r.closed.includes(3), "gamma's closed");

      // Focused, with the session selected: none; another session: one.
      await titleIs(w.page, 'skydeck');
      const selected = await selectedRow(w.page);
      assert.ok(selected !== null);
      const other = selected === S1 ? S3 : S1;
      await pageFocus(w.page, true);
      const made = record.made.length;
      w.send({ t: 'notify', sessionId: selected, title: 'x', reason: 'finished', detail: null });
      w.send({ t: 'notify', sessionId: other, title: 'y', reason: 'finished', detail: null });
      record = await recorded(w.page, (r) => r.made.length > made, 'the other one');
      assert.deepEqual(
        record.made.slice(made).map((one) => one.tag),
        [other],
      );
      // Unfocused, the selected session gets one.
      await pageFocus(w.page, false);
      w.send({ t: 'notify', sessionId: selected, title: 'x', reason: 'finished', detail: null });
      record = await recorded(w.page, (r) => r.made.length > made + 1, 'the selected one');
      assert.equal(record.made.at(-1)?.tag, selected);

      // A list of stage A (no needYou) is one in which nothing needs you: it closes both, though
      // it carries neither row.
      w.set(() => scriptedList([{ id: S4, terminal: null, slot: null, title: 'delta' }], []));
      record = await recorded(
        w.page,
        (r) => r.closed.includes(made) && r.closed.includes(made + 1),
        'both closed by a list without needYou',
      );
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    "a click on the notification of a session this page's list does not show: with no window terminal it selects nothing and says it is hidden (the window still comes to the front); with one, its terminal is shown and takes the keyboard, as a window chord's",
    async (t) => {
      const w = await attentionWorld(t, chromium, threeNeed, (page) =>
        notificationDouble(page, 'granted'),
      );
      await titleIs(w.page, '(3) skydeck');
      assert.equal(await selectedRow(w.page), S1);
      await toZone(w.page, 'list');
      await w.page.keyboard.press('/');
      await w.page.keyboard.type('alph');
      await w.page.keyboard.press('Enter');
      for (const hidden of [S2, S3]) {
        await w.page.waitForSelector(`#list [data-id="${hidden}"]`, {
          state: 'detached',
          timeout: PAGE_WAIT_MS,
        });
      }
      await showsText(w.page, '#focus-zone', /^Focus: list$/);
      await pageFocus(w.page, false);
      w.send({ t: 'notify', sessionId: S2, title: 'beta', reason: 'ended', detail: null });
      w.send({ t: 'notify', sessionId: S3, title: 'gamma', reason: 'finished', detail: null });
      await recorded(w.page, (r) => r.made.length === 2, 'two notifications');
      const from = w.sent.length;

      // beta: not running, hidden by the filter, no window terminal — nothing is selected.
      await clearKeyMessage(w.page);
      await clickNotification(w.page, 0);
      await showsText(w.page, '#key-message', /^that session is hidden by the filter or the fold$/);
      assert.equal((await notificationsOf(w.page)).focused, 1, 'the window to the front');
      assert.equal(await selectedRow(w.page), S1, 'the selection stays');
      assert.equal(
        await w.page.evaluate(() => document.getElementById('right-zone')?.dataset['paneTerm']),
        TERM_A,
        'the right side stays',
      );
      assert.equal(sentWith(w.sent.slice(from), 'view', S2), false, 'no view selects it');
      assert.equal(sentWith(w.sent.slice(from), 'focus', S2), false, 'no focus reports it');

      // gamma: hidden by the filter, with a window terminal — selected, its terminal shown, and
      // the keyboard goes to it from the list zone (a window chord's move).
      await clickNotification(w.page, 1);
      await w.page.waitForSelector(
        `#right-zone[data-pane="terminal"][data-pane-term="${TERM_C}"]`,
        { state: 'attached', timeout: PAGE_WAIT_MS },
      );
      await eventually(
        async () =>
          sentWith(w.sent.slice(from), 'view', S3) && sentWith(w.sent.slice(from), 'focus', S3),
        'view and focus with gamma',
      );
      await showsText(w.page, '#focus-zone', /^Focus: terminal$/);
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'an Enter held on `Turn on notifications` asks once: its auto-repeats ask nothing (the permission stays `default`, as after a dismissed prompt); a fresh press asks again',
    async (t) => {
      const w = await attentionWorld(t, chromium, threeNeed, (page) =>
        notificationDouble(page, 'default', 'default'),
      );
      await titleIs(w.page, '(3) skydeck');
      await showsText(w.page, '#notify-on', /^Turn on notifications$/);
      await w.page.focus('#notify-on');
      await w.page.keyboard.down('Enter');
      await recorded(w.page, (r) => r.asked.length === 1, 'asked at the first keydown');
      for (let repeat = 0; repeat < 3; repeat++) await w.page.keyboard.down('Enter');
      await w.page.keyboard.up('Enter');
      assert.equal(await active(w.page), '#notify-on', 'the item is still there');
      await w.page.keyboard.press('Enter');
      const record = await recorded(w.page, (r) => r.asked.length >= 2, 'a fresh press asks');
      assert.equal(record.asked.length, 2, 'the repeats asked nothing');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'notifications, permission `denied` or no Notification API at all: no button, nothing shown, nothing asked, nothing thrown',
    async (t) => {
      const denied = await attentionWorld(t, chromium, threeNeed, (page) =>
        notificationDouble(page, 'denied'),
      );
      const none = await attentionWorld(t, chromium, threeNeed, async (page) => {
        await page.addInitScript((marker) => {
          Object.defineProperty(globalThis, marker, { value: true, configurable: true });
          Reflect.deleteProperty(globalThis, 'Notification');
        }, NOTIFICATION_DOUBLE);
      });
      for (const w of [denied, none]) {
        await titleIs(w.page, '(3) skydeck');
        assert.equal(await w.page.locator('#notify-on').isHidden(), true, 'no button');
        await pageFocus(w.page, false);
        w.send({ t: 'notify', sessionId: S2, title: 'beta', reason: 'ended', detail: null });
        w.send(listOf({ open: [row(S1)] }, [], { count: 0, order: [] }));
        await titleIs(w.page, 'skydeck');
        assert.deepEqual(w.problems, []);
      }
      assert.equal(await none.page.evaluate(() => 'Notification' in globalThis), false);
      const record = await notificationsOf(denied.page);
      assert.deepEqual([record.made, record.asked], [[], []]);
    },
  );

  await t.test(
    'with a dialog of stage D shown (opened by `l`), Ctrl+Shift+J and a click on a notification each say `close the edit first (Esc)`, select nothing and leave the keyboard in the field; the click brings the window to the front',
    async (t) => {
      const w = await attentionWorld(t, chromium, threeNeed, (page) =>
        notificationDouble(page, 'granted'),
      );
      await titleIs(w.page, '(3) skydeck');
      await clickRow(w.page, S2); // a row that is not running: the list zone
      await showsText(w.page, '#focus-zone', /^Focus: list$/);
      await w.page.keyboard.press('l');
      await w.page.waitForSelector('#editor:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      const inField = (): Promise<boolean> =>
        w.page.evaluate(
          () => document.activeElement === document.querySelector('#editor .edit-field'),
        );
      await eventually(inField, 'the field has the keyboard');
      const from = w.sent.length;

      await clearKeyMessage(w.page);
      await w.page.keyboard.press('Control+Shift+J');
      await showsText(w.page, '#key-message', /^close the edit first \(Esc\)$/);
      assert.equal(await selectedRow(w.page), S2);
      assert.equal(await inField(), true, 'the keyboard stays in the field');

      await pageFocus(w.page, false);
      w.send({ t: 'notify', sessionId: S3, title: 'gamma', reason: 'finished', detail: null });
      await recorded(w.page, (r) => r.made.length === 1, 'a notification');
      await clearKeyMessage(w.page);
      await clickNotification(w.page, 0);
      await showsText(w.page, '#key-message', /^close the edit first \(Esc\)$/);
      const record = await notificationsOf(w.page);
      assert.equal(record.focused, 1, 'the window to the front');
      assert.equal(await selectedRow(w.page), S2);
      assert.equal(await inField(), true, 'the keyboard stays in the field');
      assert.equal(
        await w.page.evaluate(() => document.getElementById('editor')?.hidden),
        false,
        'the dialog stays',
      );
      assert.equal(
        w.sent.slice(from).some((message) => message['t'] === 'view'),
        false,
        'nothing selected',
      );
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'an Enter held on `Turn on notifications` whose answer comes at once (a policy that denies): the list takes the keyboard back, and the repeats are no list keys (nothing resumes)',
    async (t) => {
      const w = await attentionWorld(t, chromium, threeNeed, (page) =>
        notificationDouble(page, 'default', 'denied'),
      );
      await titleIs(w.page, '(3) skydeck');
      await clickRow(w.page, S2); // not running: Enter on its row would resume it
      await showsText(w.page, '#focus-zone', /^Focus: list$/);
      await w.page.focus('#notify-on');
      assert.equal(await active(w.page), '#notify-on');

      await w.page.keyboard.down('Enter');
      await w.page.waitForSelector('#notify-on[hidden]', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      assert.equal((await notificationsOf(w.page)).asked.length, 1);
      // What had the keyboard went away: the zone's holder takes it back (S2 12.9).
      await eventually(async () => (await active(w.page)) === '#list', 'the list has it back');
      await w.page.keyboard.down('Enter'); // auto-repeats, once the button is gone
      await w.page.keyboard.down('Enter');
      await w.page.keyboard.up('Enter');

      const from = w.sent.length;
      await w.page.keyboard.press('k'); // a list key still acts: S3 above
      await eventually(async () => sentWith(w.sent.slice(from), 'view', S3), 'k moved');
      assert.deepEqual(
        w.sent.filter((message) => message['t'] === 'act'),
        [],
        'no resume',
      );
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'B17: a page of newPage without the double sees the inert Notification (denied, asks nothing, shows nothing); the double and the inert one in either order end with the double',
    async (t) => {
      const standin = await standinServer(t);
      const plain = await newPage(t, chromium);
      await plain.goto(standin.url);
      await showsText(plain, '#problem', /^this window has no key; /);
      const inert = await plain.evaluate(async () => {
        const api = Reflect.get(globalThis, 'Notification') as {
          permission: string;
          requestPermission(): Promise<string>;
          new (title: string): { close(): void };
        };
        const answer = await api.requestPermission();
        new api('nothing is shown').close();
        return {
          permission: api.permission,
          answer,
          native: Function.prototype.toString.call(api).includes('[native code]'),
        };
      });
      assert.deepEqual(inert, { permission: 'denied', answer: 'denied', native: false });
      /** What a service worker's `showNotification` does in `page`: its error, or `shown`. */
      const workerShows = (page: Page): Promise<string> =>
        page.evaluate(async () => {
          const registration = Reflect.get(globalThis, 'ServiceWorkerRegistration') as {
            prototype: { showNotification?(this: unknown, title: string): Promise<void> };
          };
          try {
            await registration.prototype.showNotification?.call(null, 'nothing is shown');
            return 'shown';
          } catch (error) {
            return String(error);
          }
        });
      assert.equal(
        await workerShows(plain),
        'TypeError: no notification is shown in a test',
        "a worker's refuses",
      );
      assert.equal(await plain.locator('#notify-on').isHidden(), true);

      const doubleArg = {
        marker: NOTIFICATION_DOUBLE,
        record: 'skydeckNotificationRecord',
        made: 'skydeckNotificationsMade',
        settings: 'skydeckNotificationSettings',
        permission: 'granted',
        answer: 'granted',
      };
      const isDouble = (page: Page): Promise<boolean> =>
        page.evaluate(
          () =>
            (Reflect.get(globalThis, 'Notification') as { permission: string }).permission ===
            'granted',
        );
      // The inert one first (the context's script at load), then the double: the double.
      await plain.evaluate(installDouble, doubleArg);
      assert.equal(await isDouble(plain), true);
      // The double first, then the inert one: still the double.
      await plain.evaluate(inertNotification, NOTIFICATION_DOUBLE);
      assert.equal(await isDouble(plain), true);

      // The double first, then the inert one: a worker's showNotification refuses all the same
      // (the double has none of its own).
      await plain.evaluate(() => {
        const registration = Reflect.get(globalThis, 'ServiceWorkerRegistration') as {
          prototype: object;
        };
        Reflect.deleteProperty(registration.prototype, 'showNotification');
      });
      await plain.evaluate(installDouble, doubleArg);
      await plain.evaluate(inertNotification, NOTIFICATION_DOUBLE);
      assert.equal(await isDouble(plain), true);
      assert.equal(await workerShows(plain), 'TypeError: no notification is shown in a test');

      // Both as init scripts of one load (the page's double, the context's inert one).
      const doubled = await newPage(t, chromium);
      await notificationDouble(doubled, 'granted');
      await doubled.goto(standin.url);
      await showsText(doubled, '#problem', /^this window has no key; /);
      assert.equal(await isDouble(doubled), true);
      assert.equal(await workerShows(doubled), 'TypeError: no notification is shown in a test');
    },
  );

  await t.test(
    'B17: no browser context of the page suite is made outside helpers/browser.ts',
    () => {
      const root = import.meta.dirname;
      const found: string[] = [];
      for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
        if (!name.endsWith('.ts') || name === join('helpers', 'browser.ts')) continue;
        const text = readFileSync(join(root, name), 'utf8');
        for (const [at, line] of text.split('\n').entries()) {
          if (OWN_CONTEXT.test(line) || PAGE_OF_A_BROWSER.test(line)) {
            found.push(`${name}:${at + 1}: ${line.trim()}`);
          }
        }
      }
      assert.deepEqual(found, [], 'make contexts and pages through newContext and newPage');
    },
  );
});
