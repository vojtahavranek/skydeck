// Follow-up F18: the ticket of a session in the window (S2 12.5, 12.9; K3, K4, K7, K8). The header's
// line 3 starts with the ticket's chip — its name and ↗, the address as its tooltip, a click opens
// it —, `+ ticket` / `Ticket` stands beside the pull-request button, the header keeps its four lines
// and their heights, the pull requests give way before the chip; `t` and the button open the
// ticket's dialog. The cases of the header and the dialog's acts run against a scripted stand-in
// (`editWorld`, helpers/shell.ts), which records every act (no browser is opened); the cases of
// saving and of the filter run against a real test server with the stand-in program, links seen by
// the Edge stub. The page has web/'s real modules in every case.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { setLabel, setTicket } from '../src/sessions/meta.ts';
import { windowChip } from '../src/window/view/chip.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  clickRow,
  editWorld,
  keyMessage,
  launched,
  PAGE_WAIT_MS,
  scriptedList,
  showsText,
  TERM_A,
  zone,
} from './helpers/shell.ts';
import type { EditWorld, Launched } from './helpers/shell.ts';

type Row = Record<string, unknown>;

const NOW_NS = 1794474000000000000n;
const MIN_NS = 60_000_000_000n;
const BY_KEY = { url: 'https://example.com/browse/ABC-123', text: 'ABC-123' };
const ISSUE = { url: 'https://github.com/owner/repo/issues/5', text: 'repo #5' };
const OTHER = { url: 'https://example.com/tickets/fix-the-upload', text: 'fix-the-upload' };

// --- the scripted world -----------------------------------------------------------------------

/** A row of a session running in the window's terminal `term`, in `slot`, with `more` over it. */
function running(id: string, term: string, slot: number, more: Row = {}): Row {
  const list = scriptedList([{ id, terminal: term, slot }], []) as { sections: { rows: Row[] }[] };
  return { ...(list.sections[0]?.rows[0] as Row), ...more };
}

/** A row of a session not running. */
function resting(id: string, more: Row = {}): Row {
  const list = scriptedList([{ id, terminal: null, slot: null }], []) as {
    sections: { rows: Row[] }[];
  };
  return { ...(list.sections[0]?.rows[0] as Row), ...more };
}

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

/** `list.selected` for `sessionId`, with `more` over it (F18: `ticket`, `ticketKeys`). */
function selectedOf(sessionId: string, more: Row = {}): Row {
  return {
    sessionId,
    command: `cd /home/u/project && claude --resume ${sessionId}`,
    flagsKnown: true,
    unknownFlags: [],
    launchFlags: [],
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

/** An open pull request of a row, read 4 minutes before the list's now. */
function pr(number: number, more: Row = {}): Row {
  return {
    url: `https://github.com/acme/web/pull/${number}`,
    repo: 'acme/web',
    number,
    title: `Pull request ${number}`,
    level: 'checks-failing',
    error: null,
    okAtNs: String(NOW_NS - 4n * MIN_NS),
    ...more,
  };
}

function prsOf(prs: Row[]): Row {
  return { prs, chip: windowChip(prs as { level: string }[]) };
}

interface Scripted {
  page: Page;
  w: EditWorld;
  /** Sets what the next lists hold and sends one. */
  set(change: { open?: Row[]; selected?: Record<string, Row | null> }): void;
}

/** A page on an `editWorld` whose lists hold `open` (S1 running in TERM_A) and `selected[id]`. */
async function scripted(
  t: TestContext,
  chromium: Browser,
  start: { open: Row[]; selected?: Record<string, Row | null> },
): Promise<Scripted> {
  const page = await newPage(t, chromium);
  let open = start.open;
  let selected = start.selected ?? {};
  const listFor = (id: string | null): Row => ({
    ...scriptedList([], []),
    sections: (['open', 'week', 'earlier'] as const).map((name) => ({
      name,
      folded: false,
      firstNs: null,
      lastNs: null,
      count: name === 'open' ? open.length : 0,
      rows: name === 'open' ? open : [],
      closedStacks: [],
    })),
    terminals: open.some((row) => row['terminal'] === TERM_A) ? [terminal(TERM_A, S1, 1)] : [],
    selected: id === null || selected[id] === null ? null : selectedOf(id, selected[id] ?? {}),
  });
  const w = await editWorld(t, page, listFor);
  return {
    page,
    w,
    set(change) {
      open = change.open ?? open;
      selected = change.selected ?? selected;
      w.list(listFor);
    },
  };
}

// --- reading the page -------------------------------------------------------------------------

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

/** The ticket's chip as shown: its text, its tooltip, whether it is cut; null when not shown. */
async function chipOf(page: Page): Promise<{ text: string; tip: string; cut: boolean } | null> {
  return page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('#cards .header-ticket');
    if (chip === null || chip.closest('[hidden]') !== null) return null;
    const name = chip.querySelector<HTMLElement>('.header-ticket-text');
    return {
      text: chip.textContent ?? '',
      tip: chip.title,
      cut:
        name === null || name.scrollWidth > name.clientWidth || chip.scrollWidth > chip.clientWidth,
    };
  });
}

/** Waits until the ticket's chip shows `text` (with its ↗), or is not shown when `text` is null. */
async function chipShows(page: Page, text: string | null): Promise<void> {
  await eventually(
    async () => (await chipOf(page))?.text === (text === null ? undefined : `${text} ↗`),
    `the ticket's chip: ${JSON.stringify(text)}`,
  );
}

/** The header's height, its lines' heights, and line 3's shown parts: their class and box. */
interface Line3 {
  height: number;
  lines: { name: string; height: number; overflows: boolean }[];
  line: { left: number; right: number };
  parts: { name: string; left: number; right: number; cut: boolean }[];
  /** The open pull requests: whole inside the items' box, left out of it, or cut by its edge. */
  items: ('whole' | 'out' | 'cut' | 'ellipsis')[];
}
async function line3(page: Page): Promise<Line3> {
  return page.evaluate(() => {
    const head = document.querySelector('#cards .card-header') as HTMLElement;
    const prs = head.querySelector('.header-prs') as HTMLElement;
    const lineBox = prs.getBoundingClientRect();
    const style = getComputedStyle(prs);
    const itemsBox = (
      head.querySelector('.header-pr-items') as HTMLElement
    ).getBoundingClientRect();
    return {
      height: head.getBoundingClientRect().height,
      lines: [...head.children].map((line) => ({
        name: line.className,
        height: line.getBoundingClientRect().height,
        overflows: line.scrollHeight > line.clientHeight + 1,
      })),
      line: {
        left: lineBox.left + Number.parseFloat(style.paddingLeft),
        right: lineBox.right - Number.parseFloat(style.paddingRight),
      },
      parts: [...prs.children]
        .filter((part) => part instanceof HTMLElement && part.closest('[hidden]') === null)
        .map((part) => {
          const r = part.getBoundingClientRect();
          return {
            name: part.className.split(' ').at(-1) ?? '',
            left: r.left,
            right: r.right,
            cut: part.scrollWidth > part.clientWidth + 0.5,
          };
        }),
      items: [...head.querySelectorAll<HTMLElement>('.header-pr')].map((item) => {
        const r = item.getBoundingClientRect();
        const inside =
          r.left >= itemsBox.left - 0.5 &&
          r.right <= itemsBox.right + 0.5 &&
          r.top >= itemsBox.top - 0.5 &&
          r.bottom <= itemsBox.bottom + 0.5;
        const out = r.top >= itemsBox.bottom - 0.5 || r.left >= itemsBox.right - 0.5;
        if (inside) return item.scrollWidth <= item.clientWidth ? 'whole' : 'ellipsis';
        return out ? 'out' : 'cut';
      }),
    };
  });
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
}> {
  return page.evaluate(() => {
    const root = document.getElementById('editor') as HTMLElement;
    const box = root.querySelector<HTMLElement>('.edit-dialog');
    const field = root.querySelector<HTMLInputElement>('.edit-field');
    const text = (selector: string): string => {
      const element = root.querySelector<HTMLElement>(selector);
      return element === null || element.closest('[hidden]') !== null
        ? ''
        : (element.textContent ?? '');
    };
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
    };
  });
}

async function dialogShown(page: Page, shown: boolean): Promise<void> {
  await page.waitForSelector(shown ? '#editor:not([hidden])' : '#editor[hidden]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** The texts of the shown elements matching `selector`. */
async function texts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)]
        .filter((element) => element instanceof HTMLElement && element.closest('[hidden]') === null)
        .map((element) => element.textContent ?? ''),
    selector,
  );
}

/** The ids of the list's rows that are drawn, in order. */
async function shownRows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#list .list-row')]
      .filter((element) => element instanceof HTMLElement && element.checkVisibility())
      .map((element) => element.getAttribute('data-id') ?? ''),
  );
}

/**
 * Waits until the list that carries `id`'s `selected` has come: the resume card shows the command
 * it holds (`t` acts only then; before, it says to press it again).
 */
async function selectedHasCome(page: Page, id: string): Promise<void> {
  await showsText(page, '#cards', new RegExp(`--resume ${id}`));
}

/** Waits until the Edge stub was run with `url` (S2 9.6). */
async function opened(l: Launched, url: string): Promise<void> {
  await eventually(
    async () => l.d.edgeCalls().some((args) => args.includes(url)),
    `${url} opened by the Edge stub`,
  );
}

test("F18: a session's ticket in the header, its dialog and the filter", async (t) => {
  const chromium = await browser(t);

  await t.test(
    "the chip: first on line 3, the ticket's name and ↗, the whole address its tooltip; a click that selected no text sends `open-link` with the address, a drag opens nothing; without a ticket nothing is there and the button reads `+ ticket`, with one `Ticket`; markup in a name stays text",
    async (t) => {
      const s = await scripted(t, chromium, {
        open: [running(S1, TERM_A, 1, { title: 'with a ticket' })],
        selected: { [S1]: { ticket: BY_KEY } },
      });
      const { page, w } = s;
      await showsText(page, '#cards .header-title', /^with a ticket$/);
      await chipShows(page, 'ABC-123');
      assert.equal((await chipOf(page))?.tip, BY_KEY.url);
      assert.deepEqual(await texts(page, '#cards .header-ticket-button'), ['Ticket']);
      assert.equal(
        await page.getAttribute('#cards .header-ticket-button', 'title'),
        'the ticket (t)',
      );
      const parts = (await line3(page)).parts.map((part) => part.name);
      assert.deepEqual(parts, [
        'header-ticket',
        'header-prs-none',
        'header-pr-items',
        'header-ticket-button',
        'header-prs-button',
      ]);

      // D17: a drag over the chip selects its text and opens nothing; a click opens it.
      const box = await page.locator('#cards .header-ticket').boundingBox();
      assert.ok(box !== null);
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      await sleep(300);
      assert.notEqual(await page.evaluate(() => getSelection()?.toString() ?? ''), '');
      assert.deepEqual(w.acts(), [], 'a drag over the chip opens nothing');
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await page.locator('#cards .header-ticket').click();
      const act = await w.act(1);
      assert.deepEqual([act['kind'], act['url']], ['open-link', BY_KEY.url]);
      assert.equal((await dialog(page)).shown, false, 'the chip never edits');

      // A GitHub issue, then another address: the server's names, the addresses as tooltips.
      for (const ticket of [ISSUE, OTHER]) {
        s.set({ selected: { [S1]: { ticket } } });
        await chipShows(page, ticket.text);
        assert.equal((await chipOf(page))?.tip, ticket.url);
      }

      // Markup in a name and an address is text: no element is made of it.
      const img = '<img src=x onerror="document.title=1">';
      s.set({ selected: { [S1]: { ticket: { url: `https://example.com/${img}`, text: img } } } });
      await chipShows(page, img);
      assert.equal(await page.locator('#cards img').count(), 0);
      assert.equal((await chipOf(page))?.tip, `https://example.com/${img}`);

      // Without a ticket: nothing there, `+ ticket`.
      s.set({ selected: { [S1]: {} } });
      await chipShows(page, null);
      assert.deepEqual(await texts(page, '#cards .header-ticket-button'), ['+ ticket']);
      assert.equal(
        await page.getAttribute('#cards .header-ticket-button', 'title'),
        'set a ticket (t)',
      );
      assert.equal(w.acts().length, 1);
    },
  );

  await t.test(
    "one height and line 3's places: no ticket, a ticket by a key, a GitHub issue, another address, and a ticket beside three pull requests, at 1280, 900 and 800 px → the same four lines and heights; without a ticket the pull requests' chip starts the line and `+ PR` ends it, `+ ticket` just before it; with one the chip starts the line, whole, and the pull requests give way before it",
    async (t) => {
      const plain = running(S1, TERM_A, 1, { title: 'a title' });
      const three = running(S1, TERM_A, 1, {
        title: 'a title',
        ...prsOf([pr(1), pr(2), pr(3)]),
      });
      const s = await scripted(t, chromium, { open: [plain] });
      const variants: [string, Row, Row | null][] = [
        ['no ticket', plain, null],
        ['a ticket by a key', plain, BY_KEY],
        ['a GitHub issue', plain, ISSUE],
        ['another address', plain, OTHER],
        ['no ticket, three pull requests', three, null],
        ['a ticket beside three pull requests', three, BY_KEY],
      ];
      let height: number | null = null;
      let lineHeights: number[] | null = null;
      /** The chip's width for each ticket's name: its content's, whatever the window's width. */
      const chipWidths = new Map<string, number>();
      for (const width of [1280, 900, 800]) {
        await s.page.setViewportSize({ width, height: 800 });
        for (const [what, shown, ticket] of variants) {
          s.set({ open: [shown], selected: { [S1]: ticket === null ? {} : { ticket } } });
          await chipShows(s.page, ticket === null ? null : (ticket['text'] as string));
          await sleep(150);
          const m = await line3(s.page);
          const where = `${what} at ${width} px`;
          height ??= m.height;
          lineHeights ??= m.lines.map((line) => line.height);
          assert.equal(m.height, height, `${where}: the header's height`);
          assert.deepEqual(
            m.lines.map((line) => line.name),
            ['header-top', 'header-sub', 'header-prs', 'header-note'],
            `${where}: four lines`,
          );
          assert.deepEqual(
            m.lines.map((line) => line.height),
            lineHeights,
            `${where}: heights`,
          );
          for (const line of m.lines) assert.ok(!line.overflows, `${where}: ${line.name}`);
          const part = (name: string) => m.parts.find((candidate) => candidate.name === name);
          const first = m.parts[0];
          const prsButton = part('header-prs-button');
          const ticketButton = part('header-ticket-button');
          assert.ok(first !== undefined && prsButton !== undefined && ticketButton !== undefined);
          assert.ok(
            Math.abs(prsButton.right - m.line.right) < 1,
            `${where}: + PR ends the line ${JSON.stringify(m)}`,
          );
          assert.ok(
            Math.abs(prsButton.left - 8 - ticketButton.right) < 1,
            `${where}: the ticket's button just before + PR`,
          );
          assert.ok(!prsButton.cut && !ticketButton.cut, `${where}: the buttons are whole`);
          assert.ok(
            Math.abs(first.left - m.line.left) < 1,
            `${where}: the first part starts the line`,
          );
          if (ticket === null) {
            assert.equal(part('header-ticket'), undefined, `${where}: no chip`);
            assert.equal(
              first.name,
              shown === three ? 'header-chip' : 'header-prs-none',
              `${where}: what line 3 shows today starts it`,
            );
          } else {
            assert.equal(first.name, 'header-ticket', `${where}: the chip starts the line`);
            assert.equal(first.cut, false, `${where}: the chip is whole`);
            const name = ticket['text'] as string;
            const chipWidth = first.right - first.left;
            const seen = chipWidths.get(name) ?? chipWidth;
            chipWidths.set(name, seen);
            assert.ok(
              Math.abs(chipWidth - seen) < 0.5,
              `${where}: the chip keeps its width (${chipWidth} px, ${seen} px before): it does not share the room with the pull requests`,
            );
            const after = m.parts[1];
            assert.ok(after !== undefined && Math.abs(after.left - 8 - first.right) < 1, where);
          }
          assert.ok(!m.items.includes('cut'), `${where}: no pull request is cut (${m.items})`);
        }
        // Narrow, beside the ticket: the pull requests gave way (some left out), the chip did not.
        if (width !== 1280) {
          const m = await line3(s.page);
          assert.ok(
            m.items.includes('out'),
            `at ${width} px: a pull request left out (${m.items})`,
          );
          assert.equal((await chipOf(s.page))?.cut, false);
        }
      }
    },
  );

  await t.test(
    "the dialog: `t` and the header's button open it with one field — the address, or empty —, its placeholder `a link` and the key only with ticketUrl; Enter sends `act ticket`; a refusal stays in the dialog with the server's words and the text; `ok` closes it with the keyboard where it was; Esc closes it; `t` before the list carries `selected` says to press it again",
    async (t) => {
      const s = await scripted(t, chromium, {
        open: [resting(S1, { title: 'first' }), resting(S2, { title: 'second' })],
        selected: { [S1]: {}, [S2]: { ticket: ISSUE, ticketKeys: true } },
      });
      const { page, w } = s;
      await clickRow(page, S1);
      await showsText(page, '#cards .header-title', /^first$/);
      await selectedHasCome(page, S1);
      await page.keyboard.press('t');
      await dialogShown(page, true);
      let shown = await dialog(page);
      assert.equal(shown.what, 'ticket');
      assert.equal(shown.heading, 'Ticket — first');
      assert.equal(shown.value, '');
      assert.equal(shown.placeholder, 'a link');
      assert.equal(shown.inField, true);
      assert.equal(
        shown.help,
        'An http or https link, stored as the window opens it (a key needs ticketUrl in config.json). Empty removes it.',
      );
      await page.keyboard.type('ABC-123');
      await page.keyboard.press('Enter');
      const refused = await w.act(1);
      assert.deepEqual(
        [refused['kind'], refused['sessionId'], refused['text']],
        ['ticket', S1, 'ABC-123'],
      );
      const words =
        'a ticket key needs ticketUrl in config.json: set ticketUrl, or give the whole link';
      w.answer(refused, { ok: false, error: words });
      await showsText(page, '#editor .edit-message', new RegExp(`^${words}$`));
      shown = await dialog(page);
      assert.deepEqual([shown.shown, shown.value, shown.inField], [true, 'ABC-123', true]);

      await page.keyboard.press('Control+a');
      await page.keyboard.type(BY_KEY.url);
      await page.keyboard.press('Enter');
      const saved = await w.act(2);
      assert.equal(saved['text'], BY_KEY.url);
      w.holdViews(true);
      const views = w.sent.filter((m) => m['t'] === 'view').length;
      w.answer(saved, { ok: true });
      await dialogShown(page, false);
      assert.equal(await active(page), '#list', 'the keyboard back on the list');
      assert.equal(await zone(page), 'Focus: list');
      // C1: until the list that holds the saved ticket has come, `t` and the button wait (a
      // dialog from the old `selected` would send the old text back).
      await eventually(
        async () => w.sent.filter((m) => m['t'] === 'view').length > views,
        'the page asks for the list (a view)',
      );
      await page.keyboard.press('t');
      await showsText(page, '#key-message', /^the ticket is not here yet; press t again$/);
      assert.equal((await dialog(page)).shown, false);
      await page.locator('#cards .header-ticket-button').click();
      await sleep(300);
      assert.equal((await dialog(page)).shown, false, 'the button waits too');
      assert.equal(w.acts().length, 2, 'nothing sent meanwhile');
      w.holdViews(false);
      s.set({ selected: { [S1]: { ticket: BY_KEY }, [S2]: { ticket: ISSUE, ticketKeys: true } } });
      await chipShows(page, 'ABC-123');

      // The header's button opens it too, with the address; Esc closes it and sends nothing.
      await page.locator('#cards .header-ticket-button').click();
      await dialogShown(page, true);
      shown = await dialog(page);
      assert.deepEqual([shown.what, shown.value, shown.inField], ['ticket', BY_KEY.url, true]);
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      assert.equal(await active(page), '#list', 'the button took no keyboard; it is where it was');

      // With ticketUrl configured the placeholder names a key; empty text removes the ticket.
      await clickRow(page, S2);
      await showsText(page, '#cards .header-title', /^second$/);
      await chipShows(page, ISSUE.text); // its `selected` has come
      await page.keyboard.press('t');
      await dialogShown(page, true);
      shown = await dialog(page);
      assert.deepEqual(
        [shown.value, shown.placeholder],
        [ISSUE.url, 'a link, or a key like ABC-123'],
      );
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.keyboard.press('Enter');
      const removed = await w.act(3);
      assert.deepEqual(
        [removed['kind'], removed['sessionId'], removed['text']],
        ['ticket', S2, ''],
      );
      w.answer(removed, { ok: true });
      await dialogShown(page, false);
      assert.equal(w.acts().length, 3);

      // Before the list carries the session's `selected`, `t` says to press it again.
      s.set({ selected: { [S1]: null } });
      await clickRow(page, S1);
      await sleep(300);
      await page.keyboard.press('t');
      await showsText(page, '#key-message', /^the ticket is not here yet; press t again$/);
      assert.equal((await dialog(page)).shown, false);
      assert.equal(await keyMessage(page), 'the ticket is not here yet; press t again');
    },
  );

  await t.test(
    'the real server with ticketUrl: `t`, a key and Enter save the filled address and the chip shows the key, its click opens the address; the header button, a whole link and Enter replace it; a refusal shows its words; the filter finds the session by the ticket; an empty text removes it',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { ticketUrl: 'https://example.com/browse/{key}' },
      });
      l.d.resumable(S1);
      l.d.resumable(S2);
      setLabel(l.d.deck, S1, 'with a ticket');
      setLabel(l.d.deck, S2, 'without one');
      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .header-title', /^with a ticket$/);
      await eventually(
        async () => (await texts(l.page, '#cards .header-ticket-button'))[0] === '+ ticket',
        '+ ticket',
      );
      await selectedHasCome(l.page, S1);

      await l.page.keyboard.press('t');
      await dialogShown(l.page, true);
      assert.equal((await dialog(l.page)).placeholder, 'a link, or a key like ABC-123');
      await l.page.keyboard.type('ABC-123');
      await l.page.keyboard.press('Enter');
      await dialogShown(l.page, false);
      await chipShows(l.page, 'ABC-123');
      assert.equal(l.d.deck.store.meta(S1)?.ticket, BY_KEY.url);
      assert.equal(await active(l.page), '#list');
      await l.page.locator('#cards .header-ticket').click();
      await opened(l, BY_KEY.url);

      await l.page.locator('#cards .header-ticket-button').click();
      await dialogShown(l.page, true);
      assert.equal((await dialog(l.page)).value, BY_KEY.url);
      await l.page.keyboard.press('Control+a');
      await l.page.keyboard.type('javascript:alert(1)');
      await l.page.keyboard.press('Enter');
      await showsText(
        l.page,
        '#editor .edit-message',
        /^a ticket link must start with http:\/\/ or https:\/\/$/,
      );
      assert.equal((await dialog(l.page)).value, 'javascript:alert(1)');
      await l.page.keyboard.press('Control+a');
      await l.page.keyboard.type(ISSUE.url);
      await l.page.keyboard.press('Enter');
      await dialogShown(l.page, false);
      await chipShows(l.page, 'repo #5');
      assert.equal(l.d.deck.store.meta(S1)?.ticket, ISSUE.url);

      // The filter: by the ticket's name, then by its address; the other session is not shown.
      await clickRow(l.page, S1); // the list has the keyboard (a click in the header gave it away)
      await l.page.keyboard.press('/');
      await l.page.keyboard.type('repo #5');
      await eventually(
        async () => JSON.stringify(await shownRows(l.page)) === JSON.stringify([S1]),
        'by the name',
      );
      await l.page.keyboard.press('Control+a');
      await l.page.keyboard.type('github.com/owner');
      await eventually(
        async () => JSON.stringify(await shownRows(l.page)) === JSON.stringify([S1]),
        'by the address',
      );
      await l.page.keyboard.press('Escape');
      await eventually(async () => (await shownRows(l.page)).length === 2, 'both again');

      // Set by a command meanwhile: the window shows it; then removed in the dialog.
      setTicket(l.d.deck, S2, OTHER.url);
      await clickRow(l.page, S2);
      await chipShows(l.page, 'fix-the-upload');
      await l.page.keyboard.press('t');
      await dialogShown(l.page, true);
      await l.page.keyboard.press('Control+a');
      await l.page.keyboard.press('Delete');
      await l.page.keyboard.press('Enter');
      await dialogShown(l.page, false);
      await chipShows(l.page, null);
      assert.equal(l.d.deck.store.meta(S2)?.ticket, null);
      assert.deepEqual(l.problems, []);
    },
  );
});
