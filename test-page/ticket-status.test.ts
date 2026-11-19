// Follow-up F19: a ticket's status in the window (S2 12.2, 12.3, 12.5; T6, T7, T9). The header's
// ticket chip shows `<name> · <status> ↗` in the category's tint — the pull requests' own tint of
// that colour, light and dark and under each forced theme — with the address and the status' age
// (or a failure's words) as its tooltip; a ticket from the group has the chip only once a status
// is known or was tried, and shows its status alone (the group chip names it); the list's row has a second small chip after the pull requests' chip, cut
// at 14 characters, that takes no room without a status. Scripted cases run on an `editWorld`
// (helpers/shell.ts); the filter and ↻ run against a real test server whose status program is a
// stand-in script in the sandbox's home (no network, no real gh). web/'s real modules throughout.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { setTicket } from '../src/sessions/meta.ts';
import { windowChip } from '../src/window/view/chip.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  clickRow,
  editWorld,
  launched,
  PAGE_WAIT_MS,
  scriptedList,
  showsText,
} from './helpers/shell.ts';
import type { EditWorld } from './helpers/shell.ts';

type Row = Record<string, unknown>;
type Tint = 'red' | 'amber' | 'blue' | 'green';

const NOW_NS = 1794474000000000000n;
const MIN_NS = 60_000_000_000n;
const URL = 'https://tickets.example.com/browse/ABC-123';

/** A not-running row of `id` with `more` over it. */
function resting(id: string, more: Row = {}): Row {
  const list = scriptedList([{ id, terminal: null, slot: null }], []) as {
    sections: { rows: Row[] }[];
  };
  return { ...(list.sections[0]?.rows[0] as Row), ...more };
}

/** `list.selected` of `sessionId` with `more` over it. */
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
    ticketKeys: true,
    ticketStatus: null,
    ...more,
  };
}

/** A status payload of the header (S2 8.2.3), read `minutes` ago. */
function status(over: Row = {}, minutes = 3n): Row {
  const at = String(NOW_NS - minutes * MIN_NS);
  return {
    url: URL,
    name: 'ABC-123',
    stored: true,
    status: 'In Progress',
    category: 'doing',
    okAtNs: at,
    triedAtNs: at,
    error: null,
    ...over,
  };
}

/** A pull request of a row (S2 8.2.3), open, checks failing. */
function pr(number: number): Row {
  return {
    url: `https://github.com/acme/web/pull/${number}`,
    repo: 'acme/web',
    number,
    title: `Pull request ${number}`,
    level: 'checks-failing',
    error: null,
    okAtNs: String(NOW_NS - 4n * MIN_NS),
  };
}

interface Scripted {
  page: Page;
  w: EditWorld;
  set(change: { rows?: Row[]; selected?: Record<string, Row | null> }): void;
}

/** A page at 1400 x 900 on an `editWorld` whose lists hold `rows` in Recent and `selected[id]`. */
async function scripted(
  t: TestContext,
  chromium: Browser,
  start: { rows: Row[]; selected?: Record<string, Row | null> },
): Promise<Scripted> {
  const page = await newPage(t, chromium);
  await page.setViewportSize({ width: 1400, height: 900 });
  let rows = start.rows;
  let selected = start.selected ?? {};
  const listFor = (id: string | null): Row => ({
    ...scriptedList([], []),
    sections: (['open', 'week', 'earlier'] as const).map((name) => ({
      name,
      folded: false,
      firstNs: null,
      lastNs: null,
      count: name === 'week' ? rows.length : 0,
      rows: name === 'week' ? rows : [],
      closedStacks: [],
    })),
    terminals: [],
    selected: id === null || selected[id] === null ? null : selectedOf(id, selected[id] ?? {}),
  });
  const w = await editWorld(t, page, listFor);
  return {
    page,
    w,
    set(change) {
      rows = change.rows ?? rows;
      selected = change.selected ?? selected;
      w.list(listFor);
    },
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

/** The header's ticket chip: its text, tooltip, colours; null when it is not shown. */
async function headerChip(page: Page) {
  return page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('#cards .header-ticket');
    if (chip === null || chip.closest('[hidden]') !== null) return null;
    const style = getComputedStyle(chip);
    return {
      // The shown parts only (a group's ticket hides its name and its arrow).
      text: [...chip.children]
        .filter((part) => part instanceof HTMLElement && !part.hidden)
        .map((part) => part.textContent ?? '')
        .join(''),
      tip: chip.title,
      color: style.color,
      background: style.backgroundColor,
      height: chip.getBoundingClientRect().height,
    };
  });
}

/** A row's ticket chip: its text, tooltip, colours and box; null when it takes no room. */
async function rowChip(page: Page, id: string) {
  return page.evaluate((id) => {
    const chip = document.querySelector<HTMLElement>(`#list [data-id="${id}"] .row-ticket`);
    if (chip === null || chip.hidden || getComputedStyle(chip).display === 'none') return null;
    const style = getComputedStyle(chip);
    const box = chip.getBoundingClientRect();
    return {
      text: chip.textContent ?? '',
      tip: chip.title,
      color: style.color,
      background: style.backgroundColor,
      padding: style.padding,
      radius: style.borderRadius,
      border: style.borderTopWidth,
      size: style.fontSize,
      height: box.height,
    };
  }, id);
}

/** CSS colours as the page computes them. */
async function resolve(page: Page, color: string, background: string) {
  return page.evaluate(
    ([color, background]) => {
      const probe = document.createElement('span');
      document.body.append(probe);
      probe.style.color = color as string;
      probe.style.backgroundColor = background as string;
      const style = getComputedStyle(probe);
      const out = { color: style.color, background: style.backgroundColor };
      probe.remove();
      return out;
    },
    [color, background],
  );
}

/** The six categories and none, each with the pull requests' tint it takes (or grey). */
const CATEGORIES: [string | null, Tint | null][] = [
  ['todo', null],
  ['doing', 'blue'],
  ['review', 'amber'],
  ['blocked', 'red'],
  ['done', 'green'],
  ['closed', null],
  [null, null],
];

/** A pull request's level of each tint (S2 12.3's table), and of the grey a draft keeps. */
const LEVEL_OF_TINT: Record<Tint | 'grey', string> = {
  red: 'checks-failing',
  amber: 'checks-pending',
  blue: 'review-required',
  green: 'approved-green',
  grey: 'draft',
};

/** The themes a case runs in: the system's light and dark, and each forced against the system. */
const THEMES: { name: string; system: 'light' | 'dark'; forced: 'light' | 'dark' | null }[] = [
  { name: 'light', system: 'light', forced: null },
  { name: 'dark', system: 'dark', forced: null },
  { name: 'forced dark under a light system', system: 'light', forced: 'dark' },
  { name: 'forced light under a dark system', system: 'dark', forced: 'light' },
];

async function theme(page: Page, which: (typeof THEMES)[number]): Promise<void> {
  await page.emulateMedia({ colorScheme: which.system });
  await page.evaluate((forced) => {
    if (forced === null) delete document.documentElement.dataset['theme'];
    else document.documentElement.dataset['theme'] = forced;
  }, which.forced);
  await sleep(50);
}

test("F19: a ticket's status in the header, in the list's rows, the filter and ↻", async (t) => {
  const chromium = await browser(t);

  await t.test(
    "every category's tint on the header's chip and the row's chip — the pull requests' tint of that colour, or grey — light, dark and under each forced theme; the words are `<name> · <status> ↗`",
    async (t) => {
      // Each row also has a pull request whose level has the same tint (a draft: grey), so that
      // the two chips are compared as drawn, light and dark and under the forced themes.
      const rows = CATEGORIES.map(([category, tint], at) => {
        const prs = [{ ...pr(at + 1), level: LEVEL_OF_TINT[tint ?? 'grey'] }];
        return resting(at === 0 ? S1 : `7d1e3c5a-2b4f-4a6e-8c0d-${String(at).padStart(12, '0')}`, {
          title: `ticket ${String(category)}`,
          lastActivityNs: String(NOW_NS - BigInt(at + 1) * MIN_NS),
          ticketStatus: { name: 'ABC-123', status: `S ${String(category)}`, category },
          prs,
          chip: windowChip(prs as { level: string }[]),
        });
      });
      const ids = rows.map((row) => row['id'] as string);
      const s = await scripted(t, chromium, {
        rows,
        selected: Object.fromEntries(
          CATEGORIES.map(([category], at) => [
            ids[at] as string,
            {
              ticket: { url: URL, text: 'ABC-123' },
              ticketStatus: status({ status: `S ${String(category)}`, category }),
            },
          ]),
        ),
      });
      const { page } = s;
      for (const [at, [category, tint]] of CATEGORIES.entries()) {
        const id = ids[at] as string;
        await clickRow(page, id);
        await showsText(page, '#cards .header-title', new RegExp(`^ticket ${String(category)}$`));
        const words = `ABC-123 · S ${String(category)} ↗`;
        await eventually(async () => (await headerChip(page))?.text === words, words);
        for (const which of THEMES) {
          await theme(page, which);
          const where = `${String(category)}, ${which.name}`;
          const want =
            tint === null
              ? await resolve(page, 'var(--dim)', 'transparent')
              : await resolve(page, `var(--pr-${tint})`, `var(--pr-${tint}-bg)`);
          const header = await headerChip(page);
          assert.deepEqual(
            [header?.color, header?.background],
            [want.color, want.background],
            `${where}: the header's chip`,
          );
          assert.equal(header?.height, 18, `${where}: the chip keeps its height`);
          const chip = await rowChip(page, id);
          assert.deepEqual(
            [chip?.text, chip?.color, chip?.background],
            [`S ${String(category)}`, want.color, want.background],
            `${where}: the row's chip`,
          );
          // The pull requests' own chips of that tint, beside them: the same colours.
          const theirs = await s.page.evaluate((id) => {
            const look = (selector: string) => {
              const element = document.querySelector(selector) as HTMLElement;
              const style = getComputedStyle(element);
              return [style.color, style.backgroundColor];
            };
            return {
              row: look(`#list [data-id="${id}"] .row-chip`),
              header: look('#cards .header-chip'),
            };
          }, id);
          assert.deepEqual(
            [chip?.color, chip?.background],
            theirs.row,
            `${where}: as the row's PR chip`,
          );
          assert.deepEqual(
            [header?.color, header?.background],
            theirs.header,
            `${where}: as the header's PR chip`,
          );
          // The box of the pull requests' chip (list.css .row-chip).
          assert.deepEqual(
            [chip?.padding, chip?.radius, chip?.border, chip?.size, chip?.height],
            ['0px 6px', '9px', '1px', '11px', 18],
            `${where}: the row's chip has the pull requests' chip's box`,
          );
        }
        await theme(page, THEMES[0] as (typeof THEMES)[number]);
      }
    },
  );

  await t.test(
    "the header chip's tooltip: the address, then `<status>, checked <age> ago`; after a failure its words and the last known status and its age",
    async (t) => {
      const s = await scripted(t, chromium, {
        rows: [resting(S1, { title: 'one' })],
        selected: { [S1]: { ticket: { url: URL, text: 'ABC-123' }, ticketStatus: status() } },
      });
      await clickRow(s.page, S1);
      await eventually(
        async () => (await headerChip(s.page))?.tip === `${URL}\nIn Progress, checked 3m ago`,
        'the tooltip of a status read',
      );
      s.set({
        selected: {
          [S1]: {
            ticket: { url: URL, text: 'ABC-123' },
            ticketStatus: status({
              okAtNs: String(NOW_NS - 120n * MIN_NS),
              error: 'the status command timed out after 10 s',
            }),
          },
        },
      });
      await eventually(
        async () =>
          (await headerChip(s.page))?.tip ===
          `${URL}\nstatus not read: the status command timed out after 10 s\nIn Progress, checked 2h ago`,
        'the tooltip after a failure',
      );
      assert.equal(
        (await headerChip(s.page))?.text,
        'ABC-123 · In Progress ↗',
        'the old status stays',
      );
    },
  );

  await t.test(
    'a ticket from the group: no chip while no status is known or tried (as F18); once one is, the chip shows the status alone (no name, no arrow) in its tint, its tooltip the name, the address and the age; a click opens it; `status not read` after failed reads; the button stays `+ ticket`',
    async (t) => {
      const group = { stored: false };
      const s = await scripted(t, chromium, {
        rows: [
          resting(S1, { title: 'ABC-123 from the title', group: 'ABC-123', groupSource: 'title' }),
        ],
        selected: {
          [S1]: {
            ticketUrl: URL,
            ticketStatus: status({
              ...group,
              status: null,
              category: null,
              okAtNs: null,
              triedAtNs: null,
            }),
          },
        },
      });
      await clickRow(s.page, S1);
      await showsText(s.page, '#cards .header-ticket-button', /^\+ ticket$/);
      await sleep(200);
      assert.equal(await headerChip(s.page), null, 'never tried: no chip');
      assert.equal(await rowChip(s.page, S1), null);

      s.set({
        rows: [
          resting(S1, {
            title: 'ABC-123 from the title',
            group: 'ABC-123',
            groupSource: 'title',
            ticketStatus: { name: 'ABC-123', status: 'Done', category: 'done' },
          }),
        ],
        selected: {
          [S1]: {
            ticketUrl: URL,
            ticketStatus: status({ ...group, status: 'Done', category: 'done' }),
          },
        },
      });
      // The status alone, in its tint: the group chip on line 1 names the ticket (amended T6).
      await eventually(async () => (await headerChip(s.page))?.text === 'Done', 'the chip');
      const green = await resolve(s.page, 'var(--pr-green)', 'var(--pr-green-bg)');
      const chip = await headerChip(s.page);
      assert.deepEqual([chip?.color, chip?.background], [green.color, green.background]);
      assert.equal(chip?.tip, `ABC-123\n${URL}\nDone, checked 3m ago`);
      assert.equal((await rowChip(s.page, S1))?.text, 'Done');
      assert.equal(await showsText(s.page, '#cards .header-ticket-button', /ticket/), '+ ticket');
      // The group chip and its link are F18's: unchanged.
      assert.equal(await s.page.getAttribute('#cards .header-group', 'title'), URL);
      // A click opens the address.
      await s.page.locator('#cards .header-ticket').click();
      const act = await s.w.act(1);
      assert.deepEqual([act['kind'], act['url']], ['open-link', URL]);

      // Tried, never read: `status not read`, grey, the failure's words in its tooltip.
      s.set({
        rows: [
          resting(S1, { title: 'ABC-123 from the title', group: 'ABC-123', groupSource: 'title' }),
        ],
        selected: {
          [S1]: {
            ticketUrl: URL,
            ticketStatus: status({
              ...group,
              status: null,
              category: null,
              okAtNs: null,
              error: 'gh is not installed',
            }),
          },
        },
      });
      await eventually(
        async () => (await headerChip(s.page))?.text === 'status not read',
        'the chip of a failed first read',
      );
      const grey = await resolve(s.page, 'var(--dim)', 'transparent');
      const failed = await headerChip(s.page);
      assert.deepEqual([failed?.color, failed?.background], [grey.color, grey.background]);
      assert.equal(failed?.tip, `ABC-123\n${URL}\nstatus not read: gh is not installed`);
      assert.equal(await rowChip(s.page, S1), null, 'no status: no chip in the row');
    },
  );

  await t.test(
    "the row's chip: right after the pull requests' chip, cut at 14 characters with its whole status as the tooltip; without a status it takes no room and every other part is where it was",
    async (t) => {
      const prs = [pr(1)];
      const base = {
        title: 'a row',
        prs,
        chip: windowChip(prs as { level: string }[]),
        hasNote: true,
        noteHead: ['n'],
      };
      const s = await scripted(t, chromium, {
        rows: [resting(S1, base), resting(S2, { ...base, ticketStatus: null })],
      });
      /** The boxes of a row's parts (left and right). */
      const parts = (id: string) =>
        s.page.evaluate((id) => {
          const row = document.querySelector(`#list [data-id="${id}"]`) as HTMLElement;
          const box = (selector: string) => {
            const element = row.querySelector(selector) as HTMLElement;
            if (getComputedStyle(element).display === 'none') return null;
            const r = element.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.right)];
          };
          return {
            title: box('.row-title'),
            chip: box('.row-chip'),
            ticket: box('.row-ticket'),
            note: box('.row-note'),
            age: box('.row-age'),
          };
        }, id);
      await eventually(async () => (await parts(S1)).chip !== null, 'the rows');
      const before = await parts(S1);
      assert.equal(before.ticket, null, 'no status: no room');
      assert.deepEqual(await parts(S2), before, 'a row with `ticketStatus: null` is the same');

      s.set({
        rows: [
          resting(S1, {
            ...base,
            ticketStatus: {
              name: 'ABC-1',
              status: 'Waiting for the customer',
              category: 'blocked',
            },
          }),
          resting(S2, { ...base, ticketStatus: null }),
        ],
      });
      await eventually(
        async () => (await rowChip(s.page, S1))?.text === 'Waiting for t…',
        'cut at 14',
      );
      assert.equal((await rowChip(s.page, S1))?.tip, 'ABC-1 · Waiting for the customer');
      // The title gives the room (it alone shrinks): the pull requests' chip moves left by the
      // new chip and the gap, the new chip stands right after it, ✎ and the age stay.
      const after = await parts(S1);
      assert.ok(after.ticket !== null && after.chip !== null && before.chip !== null);
      const width = (after.ticket[1] as number) - (after.ticket[0] as number);
      assert.equal((after.ticket[0] as number) - (after.chip[1] as number), 6, 'right after it');
      assert.ok(
        Math.abs((before.chip[0] as number) - (after.chip[0] as number) - (width + 6)) <= 1,
        `the pull requests' chip moved by the new chip and the gap: ${JSON.stringify([before, after])}`,
      );
      assert.deepEqual(
        [after.note, after.age],
        [before.note, before.age],
        '✎ and the age where they were',
      );
      assert.deepEqual(await parts(S2), before, 'the other row unchanged');
    },
  );

  await t.test(
    'line 3 when room is short: the four lines keep their heights; the pull requests give way first, then the status is cut before the name, which stays whole',
    async (t) => {
      const prs = [pr(1), pr(2), pr(3)];
      const long = 'Waiting for the customer to answer us';
      const s = await scripted(t, chromium, {
        rows: [
          resting(S1, {
            title: 'narrow',
            prs,
            chip: windowChip(prs as { level: string }[]),
            ticketStatus: { name: 'ABC-123', status: long, category: 'blocked' },
          }),
        ],
        selected: {
          [S1]: {
            ticket: { url: URL, text: 'ABC-123' },
            ticketStatus: status({ status: long, category: 'blocked' }),
          },
        },
      });
      await clickRow(s.page, S1);
      const measure = () =>
        s.page.evaluate(() => {
          const head = document.querySelector('#cards .card-header') as HTMLElement;
          const name = head.querySelector('.header-ticket-text') as HTMLElement;
          const part = head.querySelector('.header-ticket-status') as HTMLElement;
          const box = head.querySelector('.header-pr-items') as HTMLElement;
          const items = [...head.querySelectorAll<HTMLElement>('.header-pr')];
          const inside = items.filter((item) => {
            const r = item.getBoundingClientRect();
            const b = box.getBoundingClientRect();
            return r.right <= b.right + 0.5 && r.bottom <= b.bottom + 0.5 && r.width > 0;
          }).length;
          return {
            lines: [...head.children].map((line) => line.getBoundingClientRect().height),
            nameWidth: name.getBoundingClientRect().width,
            statusCut: part.scrollWidth > part.clientWidth + 0.5,
            statusWidth: part.getBoundingClientRect().width,
            itemsShown: inside,
          };
        });
      await eventually(
        async () => (await headerChip(s.page))?.text === `ABC-123 · ${long} ↗`,
        'the chip',
      );
      const wide = await measure();
      for (const width of [1100, 900, 800, 640]) {
        await s.page.setViewportSize({ width, height: 800 });
        await sleep(150);
        const m = await measure();
        const where = `${width} px: ${JSON.stringify(m)}`;
        assert.deepEqual(m.lines, wide.lines, `${where}: four lines, their heights`);
        if (m.statusCut) {
          assert.equal(
            m.itemsShown,
            0,
            `${where}: the status is cut only once the pull requests gave way`,
          );
        }
        // A name that lost more than a pixel is cut (a fraction of one is the browser's rounding).
        if (m.nameWidth < wide.nameWidth - 1) {
          assert.ok(m.statusWidth < 12, `${where}: the name is cut only once the status is gone`);
        }
      }
      assert.equal(wide.statusCut, false, 'wide, nothing is cut');
      const narrow = await measure();
      assert.equal(narrow.statusCut, true, 'at 640 px the status is cut');
      assert.equal(narrow.itemsShown, 0);
    },
  );

  await t.test(
    'the real server: the status program reads a ticket set by a command, every part shows it, the filter finds the session by its status, and ↻ in the ticket dialog reads it again',
    async (t) => {
      const l = await launched(t, chromium, {
        config: {
          ticketStatus: [
            {
              match: 'https://tickets.example.com/',
              command: [process.execPath, 'status-standin.mjs', '{url}'],
            },
          ],
        },
      });
      const home = l.d.s.home;
      mkdirSync(join(home, 'status'), { recursive: true });
      writeFileSync(
        join(home, 'status-standin.mjs'),
        // `fail` in the answer: one line on stderr, exit 1.
        "import { readFileSync } from 'node:fs';\nconst text = readFileSync('status/answer.txt', 'utf8');\nif (text.startsWith('fail')) { process.stderr.write('tickets.example.com: 503 Service Unavailable, the tracker is down for maintenance\\n'); process.exitCode = 1; } else { process.stdout.write(text); }\n",
      );
      const answer = (text: string) => writeFileSync(join(home, 'status', 'answer.txt'), text);
      answer('In Review\nreview\n');
      l.d.resumable(S1);
      l.d.resumable(S2);
      setTicket(l.d.deck, S1, URL);
      await clickRow(l.page, S1);
      // Never tried and listed: the tick reads it within a few seconds.
      await eventually(
        async () => (await headerChip(l.page))?.text === 'ABC-123 · In Review ↗',
        'read',
      );
      await eventually(async () => (await rowChip(l.page, S1))?.text === 'In Review', 'the row');

      await l.page.keyboard.press('/');
      await l.page.keyboard.type('in review');
      await eventually(
        async () =>
          JSON.stringify(
            await l.page.evaluate(() =>
              [...document.querySelectorAll('#list .list-row')]
                .filter((row) => (row as HTMLElement).checkVisibility())
                .map((row) => row.getAttribute('data-id')),
            ),
          ) === JSON.stringify([S1]),
        'the filter by the status',
      );
      await l.page.keyboard.press('Escape');

      answer('Done\ndone\n');
      await clickRow(l.page, S1);
      await l.page.keyboard.press('t');
      await l.page.waitForSelector('#editor:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      await showsText(l.page, '#editor .edit-ticket-words', /^In Review · checked \d+s ago$/);
      await l.page.locator('#editor .edit-ticket-refresh').click();
      await showsText(l.page, '#editor .edit-ticket-words', /^Done · checked \d+s ago$/);
      // A failure: the line keeps the last status after the words; cut in the dialog, whole as
      // its tooltip.
      answer('fail');
      await l.page.locator('#editor .edit-ticket-refresh').click();
      const failed = await eventually(async () => {
        const got = await l.page.evaluate(() => {
          const words = document.querySelector('#editor .edit-ticket-words') as HTMLElement;
          return { text: words.textContent ?? '', tip: words.title };
        });
        return got.text.startsWith('status not read: ') ? got : null;
      }, 'the failure line');
      assert.match(
        failed.text,
        /^status not read: tickets\.example\.com: 503 Service Unavailable, the tracker is down for maintenance · last Done, checked \d+s ago$/,
      );
      assert.equal(failed.tip, failed.text, 'the whole line as its tooltip');
      answer('Done\ndone\n');
      await l.page.locator('#editor .edit-ticket-refresh').click();
      await showsText(l.page, '#editor .edit-ticket-words', /^Done · checked \d+s ago$/);
      assert.equal(
        await l.page.evaluate(() => document.activeElement?.classList.contains('edit-field')),
        true,
        'the keyboard stays in the field',
      );
      await l.page.keyboard.press('Escape');
      await eventually(
        async () => (await headerChip(l.page))?.text === 'ABC-123 · Done ↗',
        'the header',
      );
      assert.deepEqual(l.problems, []);
    },
  );
});
