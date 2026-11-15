// The restore banner on the page (S2 12.7, 12.9, 15.4; plan C task 75, C10, C18, C21): the offer
// the view model sends — the sessions with their checkboxes, "Restore <n>", "Not now" —, the report
// of every run, and what neither may do to the keyboard, the selection or a terminal's size. Every
// case runs against a scripted stand-in server (`bannerWorld`, helpers/shell.ts) that sends the
// lists and report lines the case gives and answers each `act` as and when the case says; the page
// has web/'s real modules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, newContext, newPage } from './helpers/browser.ts';
import {
  active,
  bannerWorld,
  clickRow,
  keyMessage,
  PAGE_WAIT_MS,
  scriptedList,
  selectedRow,
  showsText,
  TERM_A,
} from './helpers/shell.ts';
import type { BannerWorld } from './helpers/shell.ts';

type Fields = Record<string, unknown>;

/** A fourth session id. */
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
/** The earlier boot the banner offers, and another one (lower-case UUIDs, plan C 2.2). */
const BOOT = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const OTHER_BOOT = '9a8b7c6d-5e4f-4321-8fed-cba987654321';
/** The boot's last event: 2024-03-12 18:02 UTC — "on 12 Mar 2024 at 18:02" in the page's UTC
 *  (helpers/browser.ts), the same on any day after 2024. */
const LAST_NS = String(BigInt(Date.UTC(2024, 2, 12, 18, 2)) * 1_000_000n);
const RUNNING_ALREADY = 'a restore is already running; wait until it has finished';
/** The line that ends a report whose finished line never came (ruled on review 2, S1). */
const NOT_ARRIVED = 'the end of this report did not arrive; the list shows what started';

/** The n-th made-up session id (for the long banners). */
function sessionN(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${'0'.repeat(12)}`;
}

/** One entry of the banner (S2 8.2.3 BannerEntryPayload) for `id`, `more` over its fields. */
function entryOf(id: string, more: Fields = {}): Fields {
  return {
    sessionId: id,
    shortId: id.slice(0, 8),
    title: `session ${id.slice(0, 8)}`,
    endedAtNs: null,
    wasWorking: false,
    preselected: true,
    ...more,
  };
}

/** A banner (BannerPayload) of `entries`, offered for BOOT, `more` over its fields. */
function bannerOf(entries: Fields[], more: Fields = {}): Fields {
  return { bootId: BOOT, lastActivityNs: LAST_NS, entries, shown: true, running: false, ...more };
}

/** The banner of a restore that runs while nothing is offered (task 73's payload). */
const RUNNING_ONLY = {
  bootId: null,
  lastActivityNs: null,
  entries: [],
  shown: true,
  running: true,
};

/** The three sessions S1, S2 (preselected) and S3 (not). */
function three(more: Fields = {}): Fields {
  return bannerOf(
    [entryOf(S1), entryOf(S2), entryOf(S3, { preselected: false, endedAtNs: LAST_NS })],
    more,
  );
}

/** A list (S2 8.2.3) of S1, S2 and S3 not running (or `rows`), with `banner`. */
function listOf(
  banner: Fields | null,
  rows: Parameters<typeof scriptedList>[0] = [S1, S2, S3].map((id) => ({
    id,
    terminal: null,
    slot: null,
  })),
  terminals: Parameters<typeof scriptedList>[1] = [],
): Fields {
  return { ...scriptedList(rows, terminals), banner };
}

/** S1 running in the window's terminal TERM_A (slot 1). */
const RUNNING_ROWS = [{ id: S1, terminal: TERM_A, slot: 1 }];
const RUNNING_TERMS = [{ id: TERM_A, slot: 1, sessionId: S1 }];

async function world(
  t: TestContext,
  chromium: Browser,
  first: Fields,
): Promise<[Page, BannerWorld]> {
  const page = await newPage(t, chromium);
  const w = await bannerWorld(t, page, first);
  return [page, w];
}

/** What the banner shows: null for each part it does not show. */
interface Shown {
  banner: boolean;
  offer: boolean;
  heading: string | null;
  entries: { id: string; text: string; checked: boolean; disabled: boolean }[];
  restore: { text: string; disabled: boolean } | null;
  notNow: boolean;
  running: string | null;
  message: string | null;
  report: string[];
  close: boolean;
}

async function shown(page: Page): Promise<Shown> {
  return page.evaluate(() => {
    const root = document.getElementById('banner') as HTMLElement;
    const visible = (element: Element | null): element is HTMLElement =>
      element instanceof HTMLElement && element.checkVisibility();
    const one = (selector: string): HTMLElement | null => {
      const found = root.querySelector(selector);
      return visible(found) ? found : null;
    };
    const restore = one('.banner-restore') as HTMLButtonElement | null;
    return {
      banner: visible(root),
      offer: one('.banner-offer') !== null,
      heading: one('.banner-heading')?.textContent ?? null,
      entries: [...root.querySelectorAll<HTMLElement>('.banner-entry')]
        .filter(visible)
        .map((label) => {
          const box = label.querySelector('input') as HTMLInputElement;
          return {
            id: label.dataset['id'] ?? '',
            text: label.querySelector('.banner-entry-text')?.textContent ?? '',
            checked: box.checked,
            disabled: box.disabled,
          };
        }),
      restore: restore === null ? null : { text: restore.textContent, disabled: restore.disabled },
      notNow: one('.banner-not-now') !== null,
      running: one('.banner-running')?.textContent ?? null,
      message: one('.banner-message')?.textContent ?? null,
      report: [...root.querySelectorAll('.banner-report-line')]
        .filter(visible)
        .map((line) => line.textContent),
      close: one('.banner-report-close') !== null,
    };
  });
}

/** Polls what the banner shows until `ok` holds (fails after PAGE_WAIT_MS, saying what it shows). */
async function until(page: Page, ok: (shown: Shown) => boolean, what: string): Promise<Shown> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const now = await shown(page);
    if (ok(now)) return now;
    if (performance.now() > deadline)
      assert.fail(`${what}; the banner shows ${JSON.stringify(now)}`);
    await sleep(50);
  }
}

const ticks = (now: Shown): boolean[] => now.entries.map((entry) => entry.checked);

/** The checkbox of `id`'s entry. */
const box = (id: string): string => `#banner .banner-entry[data-id="${id}"] input`;

/** The acts' kinds and what each names. */
function actsOf(w: BannerWorld): Fields[] {
  return w.acts().map((act) => {
    const rest = { ...act };
    delete rest['t'];
    delete rest['id'];
    return rest;
  });
}

/** Lets the page act on what it got (a key's repeat, a list): the cases that assert "nothing". */
async function settle(): Promise<void> {
  await sleep(300);
}

test('stage C: the restore banner on the page', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'a banner of three, two preselected: two ticked, `Restore 2`; a click unticks (`Restore 1`) and the list keeps the keyboard; Restore sends the one id, once — not on a second click while it waits, not on a held Enter —; Not now sends the boot id, once',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      const first = await until(page, (now) => now.offer, 'the offer is shown');
      assert.equal(
        first.heading,
        'Before the restart (last activity on 12 Mar 2024 at 18:02) 3 sessions were open',
      );
      assert.deepEqual(
        first.entries.map((entry) => [entry.id, entry.text, entry.checked]),
        [
          [S1, `${S1.slice(0, 8)}  session ${S1.slice(0, 8)} · no exit recorded`, true],
          [S2, `${S2.slice(0, 8)}  session ${S2.slice(0, 8)} · no exit recorded`, true],
          [S3, `${S3.slice(0, 8)}  session ${S3.slice(0, 8)} · ended 18:02`, false],
        ],
      );
      assert.deepEqual(first.restore, { text: 'Restore 2', disabled: false });
      assert.equal(first.notNow, true);

      await clickRow(page, S1);
      assert.equal(await active(page), '#list');
      await page.click(box(S2));
      const unticked = await until(page, (now) => now.restore?.text === 'Restore 1', 'Restore 1');
      assert.deepEqual(ticks(unticked), [true, false, false]);
      assert.equal(await active(page), '#list', 'a click in the banner leaves the keyboard');

      await page.click('#banner .banner-restore');
      await w.act(1);
      assert.deepEqual(actsOf(w), [{ kind: 'restore', sessionIds: [S1] }]);
      await page.click('#banner .banner-restore'); // while its act waits
      await page.focus('#banner .banner-restore');
      await page.keyboard.down('Enter'); // a press while it waits
      await page.keyboard.down('Enter'); // repeat: true
      await page.keyboard.up('Enter');
      await settle();
      assert.equal(w.acts().length, 1, 'nothing more while it waits');

      w.answer(await w.act(1), { ok: true });
      await settle();
      // Held past its own answer: the auto-repeats press nothing (C10), whatever waits.
      await page.keyboard.down('Enter'); // a fresh press acts
      w.answer(await w.act(2), { ok: true });
      await settle();
      await page.keyboard.down('Enter'); // repeat: true
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await settle();
      assert.equal(w.acts().length, 2, 'a held Enter on Restore sends one act');

      await page.click('#banner .banner-not-now');
      await w.act(3);
      assert.deepEqual(actsOf(w).at(-1), { kind: 'dismiss-restore', bootId: BOOT });
      await page.click('#banner .banner-not-now'); // while its act waits
      await settle();
      assert.equal(w.acts().length, 3, 'Not now acts once while its act waits');
      w.answer(await w.act(3), { ok: false, error: 'this offer to restore is no longer shown' });
      await until(page, (now) => now.message !== null, 'the refusal');
      await page.focus('#banner .banner-not-now');
      await page.keyboard.down('Enter'); // a fresh press acts
      w.answer(await w.act(4), { ok: false, error: 'this offer to restore is no longer shown' });
      await settle();
      await page.keyboard.down('Enter'); // repeat: true
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await settle();
      assert.equal(w.acts().length, 4, 'a held Enter on Not now sends one act');
    },
  );

  for (const control of ['Restore', 'Not now', "the report's ×"] as const) {
    await t.test(
      `a held Enter on ${control} that takes the control away resumes nothing; the next press does (the rule of review 2 of task 37, M1)`,
      async (t) => {
        const [page, w] = await world(t, chromium, listOf(three()));
        await until(page, (now) => now.offer, 'the offer is shown');
        await clickRow(page, S3);
        if (control === "the report's ×") {
          w.progress(`started ${S1.slice(0, 8)} session`);
          w.progress('restore finished: 1 started');
          await until(page, (now) => now.close, 'the × is shown');
        }
        const selector =
          control === 'Restore'
            ? '#banner .banner-restore'
            : control === 'Not now'
              ? '#banner .banner-not-now'
              : '#banner .banner-report-close';
        await page.focus(selector);
        await page.keyboard.down('Enter'); // presses it
        if (control === 'Restore') {
          w.answer(await w.act(1), { ok: true });
          w.list(listOf(three({ running: true })));
          await until(page, (now) => now.restore === null, 'Restore is gone');
        } else if (control === 'Not now') {
          w.answer(await w.act(1), { ok: true });
          w.list(listOf(three({ shown: false })));
          await until(page, (now) => !now.offer, 'the offer is gone');
        } else {
          await until(page, (now) => now.report.length === 0, 'the report is gone');
        }
        await keyboardOn(page, '#list'); // the list takes the keyboard back
        const before = w.acts().length;
        await page.keyboard.down('Enter'); // held: an auto-repeat (repeat: true)
        await page.keyboard.down('Enter');
        await page.keyboard.up('Enter');
        await settle();
        assert.deepEqual(
          w.acts().slice(before),
          [],
          'the held Enter sent nothing (no resume, no second act)',
        );
        await page.keyboard.press('Enter');
        const resume = await w.act(before + 1);
        assert.deepEqual([resume['kind'], resume['sessionId']], ['resume', S3]);
      },
    );
  }

  await t.test(
    'the ticks stay across lists of the same boot (an entry that left is dropped, a new one takes its preselection) and start again for another boot',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      await page.click(box(S1)); // unticks
      await page.click(box(S3)); // ticks
      const changed = await until(page, (now) => now.restore?.text === 'Restore 2', 'changed');
      assert.deepEqual(ticks(changed), [false, true, true]);

      w.list(
        listOf(
          bannerOf([
            entryOf(S2),
            entryOf(S3, { preselected: false }),
            entryOf(S4, { title: 'new here' }),
          ]),
        ),
      );
      const same = await until(
        page,
        (now) => now.entries.length === 3 && now.entries[2]?.id === S4,
        'S4 listed',
      );
      assert.deepEqual(
        same.entries.map((entry) => [entry.id, entry.checked]),
        [
          [S2, true],
          [S3, true],
          [S4, true],
        ],
      );
      assert.equal(same.restore?.text, 'Restore 3');
      assert.equal(same.heading?.endsWith('3 sessions were open'), true);

      // S1, unticked before it left, comes back: it is a new entry and takes its preselection.
      w.list(
        listOf(
          bannerOf([
            entryOf(S1),
            entryOf(S2),
            entryOf(S3, { preselected: false }),
            entryOf(S4, { title: 'new here' }),
          ]),
        ),
      );
      const back = await until(page, (now) => now.entries.length === 4, 'S1 back');
      assert.deepEqual(
        back.entries.map((entry) => [entry.id, entry.checked]),
        [
          [S1, true],
          [S2, true],
          [S3, true],
          [S4, true],
        ],
      );

      w.list(
        listOf(
          bannerOf([entryOf(S1), entryOf(S2, { preselected: false })], { bootId: OTHER_BOOT }),
        ),
      );
      const other = await until(page, (now) => now.entries.length === 2, 'the other boot');
      assert.deepEqual(
        other.entries.map((entry) => [entry.id, entry.checked]),
        [
          [S1, true],
          [S2, false],
        ],
      );
      await page.click('#banner .banner-not-now');
      await w.act(1);
      assert.deepEqual(actsOf(w), [{ kind: 'dismiss-restore', bootId: OTHER_BOOT }]);
    },
  );

  await t.test(
    "the times are the page's own time zone's (C18): in a page in Europe/Prague the heading's last activity and an entry's end read in Prague's time",
    async (t) => {
      // A context of the zone (newContext makes UTC ones unless told); 2024-03-12 18:02 UTC is
      // 19:02 in Prague.
      const context = await newContext(chromium, { timezoneId: 'Europe/Prague' });
      t.after(() => context.close());
      const page = await context.newPage();
      await bannerWorld(t, page, listOf(three()));
      const offer = await until(page, (now) => now.offer, 'the offer is shown');
      assert.equal(
        offer.heading,
        'Before the restart (last activity on 12 Mar 2024 at 19:02) 3 sessions were open',
      );
      assert.equal(
        offer.entries[2]?.text,
        `${S3.slice(0, 8)}  session ${S3.slice(0, 8)} · ended 19:02`,
      );
    },
  );

  await t.test(
    "a click on an entry's text ticks it, as on its checkbox, and leaves the keyboard where it was",
    async (t) => {
      const [page] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      await clickRow(page, S1);
      await page.click(`#banner .banner-entry[data-id="${S3}"] .banner-entry-text`);
      const ticked = await until(page, (now) => now.restore?.text === 'Restore 3', 'Restore 3');
      assert.deepEqual(ticks(ticked), [true, true, true]);
      await settle();
      assert.equal(await active(page), '#list', 'the keyboard stays on the list');
    },
  );

  await t.test(
    "the page sends no restore of more than 1,000 sessions (S2 8.2.3's limit, for which the server would close the connection): the banner says so; 1,000 are sent",
    async (t) => {
      const ids = Array.from({ length: 1001 }, (_, n) => sessionN(n + 1));
      const [page, w] = await world(t, chromium, listOf(bannerOf(ids.map((id) => entryOf(id)))));
      await until(page, (now) => now.restore?.text === 'Restore 1001', 'Restore 1001');
      await page.click('#banner .banner-restore');
      const refused = await until(page, (now) => now.message !== null, 'the refusal');
      assert.equal(refused.message, 'skydeck restores at most 1,000 sessions at once; untick some');
      assert.deepEqual(w.acts(), [], 'nothing was sent');
      await page.click(box(ids[0] as string));
      await until(page, (now) => now.restore?.text === 'Restore 1000', 'Restore 1000');
      await page.click('#banner .banner-restore');
      const act = await w.act(1);
      assert.deepEqual(act['sessionIds'], ids.slice(1));
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset['connection']),
        'open',
      );
    },
  );

  await t.test(
    "the page sends no Not now for a boot id that is not a lower-case UUID (S2 8.2.3's form, for which the server would close the connection), an upper-case one included: the banner says so",
    async (t) => {
      for (const bootId of ['stand-in-boot', BOOT.toUpperCase()]) {
        const [page, w] = await world(t, chromium, listOf(three({ bootId })));
        await until(page, (now) => now.notNow, 'Not now is shown');
        await page.click('#banner .banner-not-now');
        const refused = await until(page, (now) => now.message !== null, 'the refusal');
        assert.equal(
          refused.message,
          "this offer's boot id is not one skydeck takes; it cannot be dismissed",
        );
        await settle();
        assert.deepEqual(w.acts(), [], `nothing was sent (${bootId})`);
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset['connection']),
          'open',
        );
      }
    },
  );

  await t.test(
    'a session the banner names twice is offered once, and Restore names it once',
    async (t) => {
      const [page, w] = await world(
        t,
        chromium,
        listOf(bannerOf([entryOf(S1), entryOf(S1, { title: 'again' }), entryOf(S2)])),
      );
      const offer = await until(page, (now) => now.offer, 'the offer is shown');
      assert.deepEqual(
        offer.entries.map((entry) => entry.id),
        [S1, S2],
      );
      assert.equal(offer.restore?.text, 'Restore 2');
      await page.click('#banner .banner-restore');
      await w.act(1);
      assert.deepEqual(actsOf(w), [{ kind: 'restore', sessionIds: [S1, S2] }]);
    },
  );

  for (const which of ['the row last single-clicked', 'another row'] as const) {
    await t.test(
      `a double click on Not now whose second click lands, as the offer goes, on a row that moved under the pointer acts on nothing outside the banner — no resume, the selection and the keyboard as they were — when the row last single-clicked is ${which === 'another row' ? 'another' : 'that row'}; a click of its own then selects the row (ruled on review 2's re-check, N1)`,
      async (t) => {
        const [page, w] = await world(t, chromium, listOf(three(), TEN));
        await until(page, (now) => now.notNow, 'Not now is shown');
        const at = await page.locator('#banner .banner-not-now').boundingBox();
        assert.ok(at !== null);
        const x = at.x + at.width / 2;
        const y = at.y + at.height / 2;
        // The row that lies under Not now once the offer is gone.
        w.list(listOf(null, TEN));
        await until(page, (now) => !now.banner, 'no banner');
        const under = await page.evaluate(
          ([px, py]) =>
            (
              document.elementFromPoint(px as number, py as number)?.closest('#list [data-id]') as
                HTMLElement | null | undefined
            )?.dataset['id'] ?? null,
          [x, y],
        );
        assert.ok(under !== null, 'a row lies under Not now without the banner');
        const other = TEN.map((row) => row.id).find((id) => id !== under) as string;
        w.list(listOf(three(), TEN));
        await until(page, (now) => now.notNow, 'Not now again');
        await clickRow(page, which === 'another row' ? other : under);
        const selected = await selectedRow(page);
        // The filter's field has the keyboard: a mousedown on a row would give it to the list.
        await page.focus('#list .list-filter');
        const keyboard = await active(page);
        assert.equal(keyboard, 'INPUT');

        await page.mouse.click(x, y); // the double click's first click: Not now
        w.answer(await w.act(1), { ok: true });
        w.list(listOf(three({ shown: false }), TEN));
        await until(page, (now) => !now.banner, 'the offer is gone');
        await page.mouse.move(x, y);
        await page.mouse.down({ clickCount: 2 }); // its second click, now on the row
        await page.mouse.up({ clickCount: 2 });
        await settle();
        assert.deepEqual(
          actsOf(w).map((act) => act['kind']),
          ['dismiss-restore'],
          'no resume, nothing but the dismissal',
        );
        assert.equal(await selectedRow(page), selected, 'the selection did not move');
        assert.equal(await active(page), keyboard, 'the keyboard did not move');

        await page.mouse.click(x, y); // a click of its own
        await page.waitForFunction(
          (id) =>
            document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id,
          under,
          { timeout: PAGE_WAIT_MS },
        );
        await settle();
        assert.deepEqual(
          actsOf(w).map((act) => act['kind']),
          ['dismiss-restore'],
          'a single click selects and resumes nothing',
        );
        // A double click of its own, begun on the row, is the list's again: it resumes the row
        // (review 2's T6: the banner's mark is taken back by the next first click elsewhere).
        await page.mouse.click(x, y);
        await page.mouse.down({ clickCount: 2 });
        await page.mouse.up({ clickCount: 2 });
        const resume = await w.act(2);
        assert.deepEqual([resume['kind'], resume['sessionId']], ['resume', under]);
      },
    );
  }

  for (const control of ['Restore', 'Not now'] as const) {
    await t.test(
      `the second click of a double click on ${control} presses nothing, also once the first click's answer has come (the rule of review 2 of task 38); a later click acts`,
      async (t) => {
        const [page, w] = await world(t, chromium, listOf(three()));
        await until(page, (now) => now.offer, 'the offer is shown');
        const selector =
          control === 'Restore' ? '#banner .banner-restore' : '#banner .banner-not-now';
        const at = await page.locator(selector).boundingBox();
        assert.ok(at !== null);
        const x = at.x + at.width / 2;
        const y = at.y + at.height / 2;
        await page.mouse.click(x, y); // detail 1: acts
        w.answer(await w.act(1), { ok: true });
        await settle();
        await page.mouse.move(x, y);
        await page.mouse.down({ clickCount: 2 }); // the double click's second click: detail 2
        await page.mouse.up({ clickCount: 2 });
        await settle();
        assert.equal(w.acts().length, 1, 'the second click of a double click sent nothing');
        await page.mouse.click(x, y); // a click of its own
        const second = await w.act(2);
        assert.equal(second['kind'], control === 'Restore' ? 'restore' : 'dismiss-restore');
      },
    );
  }

  await t.test(
    "Tab and Space work on the banner's controls as the browser's own: Shift+Tab from the list walks Not now, Restore and the checkboxes; Space ticks; Enter on a checkbox does nothing; Space held on Restore acts once, at its release; a held Tab walks on",
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      await clickRow(page, S1);
      const focused = (): Promise<string> =>
        page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          const entry = element?.closest('.banner-entry') as HTMLElement | null;
          return entry !== null && entry !== undefined
            ? `entry ${entry.dataset['id'] ?? ''}`
            : element?.id !== undefined && element.id !== ''
              ? `#${element.id}`
              : (element?.className ?? 'none');
        });
      const walked: string[] = [];
      for (let n = 0; n < 5; n++) {
        await page.keyboard.press('Shift+Tab');
        walked.push(await focused());
      }
      assert.deepEqual(walked, [
        'banner-button banner-not-now',
        'banner-button primary banner-restore',
        `entry ${S3}`,
        `entry ${S2}`,
        `entry ${S1}`,
      ]);
      await page.keyboard.press('Shift+Tab'); // none before the banner's first checkbox but the page's
      await page.focus(box(S3));
      await page.keyboard.press('Space');
      await until(page, (now) => now.restore?.text === 'Restore 3', 'Space ticks');
      await page.keyboard.press('Enter');
      await settle();
      assert.equal((await shown(page)).restore?.text, 'Restore 3', 'Enter on a checkbox: nothing');
      assert.deepEqual(w.acts(), []);

      await page.keyboard.press('Tab'); // Restore
      assert.equal(await focused(), 'banner-button primary banner-restore');
      await page.keyboard.down(' ');
      await page.keyboard.down(' '); // repeat: true
      await settle();
      assert.deepEqual(w.acts(), [], 'nothing before the release');
      await page.keyboard.up(' ');
      await w.act(1);
      await settle();
      assert.equal(w.acts().length, 1, 'Space held on Restore: one act, at its release');
      w.answer(await w.act(1), { ok: false, error: 'refused' });
      await until(page, (now) => now.message === 'refused', 'the refusal');

      await page.focus('#banner .banner-restore');
      const held: string[] = [];
      await page.keyboard.down('Tab');
      held.push(await focused());
      for (let n = 0; n < 2; n++) {
        await page.keyboard.down('Tab'); // repeat: true
        held.push(await focused());
      }
      await page.keyboard.up('Tab');
      assert.deepEqual(held, ['banner-button banner-not-now', '#list', 'list-filter']);
    },
  );

  await t.test("a checkbox keeps the keyboard when the entries' order changes", async (t) => {
    const [page, w] = await world(t, chromium, listOf(three()));
    await until(page, (now) => now.offer, 'the offer is shown');
    await page.focus(box(S3));
    w.list(listOf(bannerOf([entryOf(S3, { preselected: false }), entryOf(S1), entryOf(S2)])));
    await until(page, (now) => now.entries[0]?.id === S3, 'S3 first');
    await settle();
    assert.equal(
      await page.evaluate(
        (selector) => document.activeElement === document.querySelector(selector),
        box(S3),
      ),
      true,
      "S3's checkbox keeps the keyboard",
    );
  });

  await t.test(
    "a line that starts a new report takes the ended report's × away; when the × had the keyboard, the list takes it",
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three({ running: true })));
      await until(page, (now) => now.offer, 'the offer is shown');
      await clickRow(page, S1);
      w.progress('started 0b5f3c1e one');
      w.progress('restore finished: 1 started');
      await until(page, (now) => now.close, 'the ×');
      await page.focus('#banner .banner-report-close');
      w.progress('started 1c6a4d2f two');
      await until(page, (now) => now.report.length === 1 && !now.close, 'a new report');
      await keyboardOn(page, '#list');
    },
  );

  await t.test(
    "the heading's `today` becomes `yesterday` at midnight with no list coming (the banner's own timer; ruled on review 2, S2), and a tick that changes nothing keeps a selection of it",
    async (t) => {
      const page = await newPage(t, chromium);
      // The page's clock (Playwright's, flowing from here): 23:58 UTC, the page's zone.
      await page.clock.install({ time: new Date('2026-11-15T23:58:00Z') });
      const today = String(BigInt(Date.UTC(2026, 10, 15, 18, 2)) * 1_000_000n);
      await bannerWorld(t, page, listOf(three({ lastActivityNs: today })));
      const heading = 'Before the restart (last activity today at 18:02) 3 sessions were open';
      await until(page, (now) => now.heading === heading, 'today');
      const selected = (): Promise<string> => page.evaluate(() => getSelection()?.toString() ?? '');
      await page.evaluate(() => {
        const element = document.querySelector('#banner .banner-heading') as HTMLElement;
        getSelection()?.selectAllChildren(element);
      });
      assert.equal(await selected(), heading);
      await page.clock.fastForward('00:40'); // a tick, still before midnight
      assert.equal((await shown(page)).heading, heading);
      assert.equal(await selected(), heading, 'an unchanged heading keeps its selection');
      await page.clock.fastForward('05:00'); // past midnight, no list
      await until(
        page,
        (now) =>
          now.heading ===
          'Before the restart (last activity yesterday at 18:02) 3 sessions were open',
        'yesterday',
      );
    },
  );

  await t.test('`shown: false` or a null banner: no offer is shown', async (t) => {
    const [page, w] = await world(t, chromium, listOf(three()));
    await until(page, (now) => now.offer, 'the offer is shown');
    w.list(listOf(three({ shown: false })));
    await until(page, (now) => !now.banner, 'shown false: nothing');
    w.list(listOf(three()));
    await until(page, (now) => now.offer, 'shown again');
    w.list(listOf(null));
    const none = await until(page, (now) => !now.banner, 'null: nothing');
    assert.deepEqual(none.entries, []);
  });

  await t.test(
    '`running`: the buttons are gone, the checkboxes disabled, `A restore is running.`; a banner that only says a restore runs shows that alone; Restore and Not now are back once it ends',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three({ running: true })));
      const running = await until(page, (now) => now.running !== null, 'running');
      assert.equal(running.running, 'A restore is running.');
      assert.equal(running.restore, null);
      assert.equal(running.notNow, false);
      assert.deepEqual(
        running.entries.map((entry) => entry.disabled),
        [true, true, true],
      );
      assert.deepEqual(ticks(running), [true, true, false]);

      w.list(listOf(RUNNING_ONLY));
      const only = await until(page, (now) => now.entries.length === 0, 'running only');
      assert.equal(only.offer, true);
      assert.equal(only.running, 'A restore is running.');
      assert.equal(only.heading, null, 'no heading for nothing offered');
      assert.equal(only.restore, null);

      w.list(listOf(three()));
      const back = await until(page, (now) => now.restore !== null, 'the buttons are back');
      assert.equal(back.running, null);
      assert.deepEqual(
        back.entries.map((entry) => entry.disabled),
        [false, false, false],
      );

      // Restore is disabled at 0 ticked.
      await page.click(box(S1));
      await page.click(box(S2));
      const none = await until(page, (now) => now.restore?.text === 'Restore 0', 'Restore 0');
      assert.equal(none.restore?.disabled, true);
      await page.click('#banner .banner-restore', { force: true });
      await settle();
      assert.deepEqual(w.acts(), [], 'nothing to restore: no act');
    },
  );

  await t.test(
    'the report: lines in order, the `not started` lines after a `stopped:` line in the same report, `restore finished:` gives the ×, the × removes it; a line after the finished line starts a new report',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three({ running: true })));
      await until(page, (now) => now.offer, 'the offer is shown');
      const lines = [
        `started ${S1.slice(0, 8)} session one`,
        `timed out ${S2.slice(0, 8)} session two`,
        'stopped: only 300 MB of memory free',
        `not started ${S3.slice(0, 8)} session three`,
      ];
      for (const line of lines) w.progress(line);
      const report = await until(page, (now) => now.report.length === 4, 'four lines');
      assert.deepEqual(report.report, lines);
      assert.equal(report.close, false, 'no × before the finished line');
      // A line that holds the words further on (a session's title) is no boundary.
      w.progress('started 0b5f3c1e restore finished: all');
      const titled = await until(page, (now) => now.report.length === 5, 'five lines');
      assert.equal(titled.close, false, 'no × for a title holding the words');
      lines.push('started 0b5f3c1e restore finished: all');

      w.progress('restore finished: 1 started, 1 timed out, 1 not started');
      const finished = await until(page, (now) => now.close, 'the ×');
      assert.deepEqual(finished.report, [
        ...lines,
        'restore finished: 1 started, 1 timed out, 1 not started',
      ]);

      w.progress(`started ${S3.slice(0, 8)} session three`);
      const next = await until(page, (now) => now.report.length === 1, 'a new report');
      assert.deepEqual(next.report, [`started ${S3.slice(0, 8)} session three`]);
      assert.equal(next.close, false);
      w.progress('restore finished: 3 started');
      await until(page, (now) => now.close, 'the × again');

      await page.click('#banner .banner-report-close');
      const removed = await until(page, (now) => now.report.length === 0, 'the report is gone');
      assert.equal(removed.close, false);
      assert.equal(removed.offer, true, 'the offer stays');
    },
  );

  await t.test(
    "a report whose run came while the banner is null (a command's restore) or not shown (after Not now) is drawn",
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(null));
      await connectionListed(page);
      w.progress('started 0b5f3c1e from a command');
      const fromCommand = await until(page, (now) => now.report.length === 1, 'drawn');
      assert.equal(fromCommand.banner, true);
      assert.equal(fromCommand.offer, false);
      w.progress('restore finished: 1 started');
      await until(page, (now) => now.close, 'the ×');
      await page.click('#banner .banner-report-close');
      await until(page, (now) => !now.banner, 'nothing left');

      w.list(listOf(three({ shown: false, running: true })));
      await settle();
      assert.equal((await shown(page)).banner, false, 'shown false: no offer');
      w.progress('started 1c6a4d2f from the switcher');
      const notShown = await until(page, (now) => now.report.length === 1, 'drawn');
      assert.equal(notShown.offer, false);
    },
  );

  await t.test(
    'a report whose finished line never came ends at the first list that says no restore runs (a null banner): one last line, its ×; the next run starts a new report (ruled on review 2, S1)',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three({ running: true })));
      await until(page, (now) => now.running !== null, 'running');
      w.progress('started 0b5f3c1e one');
      w.progress('timed out 1c6a4d2f two');
      await until(page, (now) => now.report.length === 2, 'two lines');
      w.list(listOf(null)); // the server restarted, or the run's end was lost
      const ended = await until(page, (now) => now.close, 'the ×');
      assert.deepEqual(ended.report, [
        'started 0b5f3c1e one',
        'timed out 1c6a4d2f two',
        NOT_ARRIVED,
      ]);
      w.list(listOf(null, [{ id: S2, terminal: null, slot: null }])); // another list: nothing more
      await settle();
      assert.deepEqual((await shown(page)).report, ended.report, 'it ends once');
      w.progress('started 2d7b5e3a three');
      const next = await until(page, (now) => now.report.length === 1, 'a new report');
      assert.deepEqual(next.report, ['started 2d7b5e3a three']);
      assert.equal(next.close, false);
    },
  );

  await t.test(
    'lists that say a restore runs never end a report (shown or not, with or without an offer); the first that says none runs does, with the offer shown again',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      w.progress('started 0b5f3c1e one'); // the run's first line before its list
      await until(page, (now) => now.report.length === 1, 'the line');
      for (const banner of [
        three({ running: true }),
        three({ shown: false, running: true }),
        RUNNING_ONLY,
      ]) {
        w.list(listOf(banner));
        await settle();
        const now = await shown(page);
        assert.deepEqual(now.report, ['started 0b5f3c1e one'], JSON.stringify(banner));
        assert.equal(now.close, false);
      }
      w.list(listOf(three()));
      const ended = await until(page, (now) => now.close, 'the ×');
      assert.deepEqual(ended.report, ['started 0b5f3c1e one', NOT_ARRIVED]);
      assert.equal(ended.restore?.text, 'Restore 2', 'the offer is back');
    },
  );

  await t.test(
    'a report that has its finished line, and an empty one, are left as they are by a list that says no restore runs',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three({ running: true })));
      await until(page, (now) => now.running !== null, 'running');
      w.list(listOf(three()));
      await settle();
      assert.deepEqual((await shown(page)).report, [], 'no line for an empty report');
      w.progress('started 0b5f3c1e one');
      w.progress('restore finished: 1 started');
      await until(page, (now) => now.close, 'the ×');
      w.list(listOf(null));
      w.list(listOf(three({ bootId: OTHER_BOOT })));
      await settle();
      assert.deepEqual((await shown(page)).report, [
        'started 0b5f3c1e one',
        'restore finished: 1 started',
      ]);
    },
  );

  await t.test(
    "runs that bring no running list (one that cannot begin; one over within the page's second): their finished line ends the report, and a list that says none runs adds nothing (review 2, T5)",
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      await viewsSent(w, 2); // the list answering it cannot fall between the lines
      w.progress("skydeck's database is busy; try again");
      w.progress('restore finished: nothing was started');
      await until(page, (now) => now.close, 'the ×');
      w.list(listOf(bannerOf([entryOf(S1, { title: 'drawn' }), entryOf(S2)])));
      const after = await until(
        page,
        (now) => now.entries[0]?.text.includes('drawn') === true,
        'the list is drawn',
      );
      assert.deepEqual(after.report, [
        "skydeck's database is busy; try again",
        'restore finished: nothing was started',
      ]);

      w.progress('started 0b5f3c1e one');
      w.progress('started 1c6a4d2f two');
      w.progress('restore finished: 2 started');
      await until(page, (now) => now.report.length === 3 && now.close, 'the short run');
      w.list(listOf(bannerOf([entryOf(S3, { preselected: false, title: 'left' })])));
      const fewer = await until(
        page,
        (now) => now.entries.length === 1 && now.entries[0]?.text.includes('left') === true,
        'the list with fewer entries is drawn',
      );
      assert.deepEqual(fewer.report, [
        'started 0b5f3c1e one',
        'started 1c6a4d2f two',
        'restore finished: 2 started',
      ]);
    },
  );

  await t.test(
    'under a banner that never said a restore runs, a report without its finished line ends at the next list that says none runs, and so does the report after it (review 2, T5)',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      await viewsSent(w, 2);
      w.progress('started 0b5f3c1e one');
      await until(page, (now) => now.report.length === 1, 'the line');
      w.list(listOf(bannerOf([entryOf(S1, { title: 'drawn 1' }), entryOf(S2)])));
      const first = await until(page, (now) => now.close, 'the first report ends');
      assert.deepEqual(first.report, ['started 0b5f3c1e one', NOT_ARRIVED]);
      w.progress('started 1c6a4d2f two');
      await until(
        page,
        (now) => now.report.length === 1 && now.report[0] === 'started 1c6a4d2f two',
        'a new report',
      );
      w.list(listOf(bannerOf([entryOf(S1, { title: 'drawn 2' }), entryOf(S2)])));
      const second = await until(page, (now) => now.close, 'the second report ends');
      assert.deepEqual(second.report, ['started 1c6a4d2f two', NOT_ARRIVED]);
    },
  );

  await t.test(
    'a refusal is shown in the banner as its line (`a restore is already running; …`, Not now refused); one that comes once the offer is gone, in the key bar',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      await page.click('#banner .banner-restore');
      w.answer(await w.act(1), { ok: false, error: RUNNING_ALREADY });
      const refused = await until(page, (now) => now.message !== null, 'the refusal');
      assert.equal(refused.message, RUNNING_ALREADY);
      assert.deepEqual(refused.restore, { text: 'Restore 2', disabled: false }, 'Restore again');

      await page.click('#banner .banner-not-now');
      const notNow = await w.act(2);
      await until(page, (now) => now.message === null, 'a new act clears the line');
      w.answer(notNow, { ok: false, error: 'this offer to restore is no longer shown' });
      await until(
        page,
        (now) => now.message === 'this offer to restore is no longer shown',
        "Not now's refusal",
      );

      await page.click('#banner .banner-not-now');
      const late = await w.act(3);
      w.list(listOf(three({ shown: false })));
      await until(page, (now) => !now.banner, 'the offer is gone');
      w.answer(late, { ok: false, error: 'this offer to restore is no longer shown' });
      await showsText(page, '#key-message', /^this offer to restore is no longer shown$/);
    },
  );

  await t.test(
    "the refusal's line stays through lists that change neither the boot nor whether a restore runs, and goes at Restore's next act, when a run begins or ends, and for another boot",
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      /** Restore, refused with `error`, its line shown. */
      const refuse = async (n: number, error: string): Promise<void> => {
        await page.click('#banner .banner-restore');
        w.answer(await w.act(n), { ok: false, error });
        await until(page, (now) => now.message === error, `refusal ${n}`);
      };

      await refuse(1, 'first');
      w.list(listOf(three(), [{ id: S1, terminal: null, slot: null }])); // other rows, same banner
      w.list(listOf(three({ entries: [entryOf(S1), entryOf(S2)] }))); // the same boot, fewer
      await settle();
      assert.equal((await shown(page)).message, 'first', 'the line stays');

      await page.click('#banner .banner-restore');
      const second = await w.act(2);
      await until(page, (now) => now.message === null, "Restore's act clears the line");
      w.answer(second, { ok: false, error: RUNNING_ALREADY });
      await until(page, (now) => now.message === RUNNING_ALREADY, 'refusal 2');
      w.list(listOf(three({ running: true })));
      const begun = await until(page, (now) => now.running !== null, 'a run began');
      assert.equal(begun.message, null, 'a run that begins clears the line');

      // A refusal that comes while a run goes on, then the run's end.
      w.list(listOf(three()));
      await until(page, (now) => now.restore !== null, 'the run ended');
      await page.click('#banner .banner-restore');
      const third = await w.act(3);
      w.list(listOf(three({ running: true })));
      await until(page, (now) => now.running !== null, 'running again');
      w.answer(third, { ok: false, error: RUNNING_ALREADY });
      await until(page, (now) => now.message === RUNNING_ALREADY, 'refusal 3, while it runs');
      w.list(listOf(three()));
      const over = await until(page, (now) => now.restore !== null, 'the run ended');
      assert.equal(over.message, null, 'a run that ends clears the line');

      await refuse(4, 'fourth');
      w.list(listOf(three({ bootId: OTHER_BOOT })));
      await until(page, (now) => now.message === null, 'another boot clears the line');
    },
  );

  await t.test(
    'a hostile title and report line are text: no element is made of them',
    async (t) => {
      const hostile = '<img src=x onerror="globalThis.pwned=1"><b>bold</b>';
      const [page, w] = await world(
        t,
        chromium,
        listOf(bannerOf([entryOf(S1, { title: hostile })])),
      );
      const offer = await until(page, (now) => now.offer, 'the offer is shown');
      assert.equal(offer.entries[0]?.text, `${S1.slice(0, 8)}  ${hostile} · no exit recorded`);
      w.progress(`started ${S1.slice(0, 8)} ${hostile}`);
      const report = await until(page, (now) => now.report.length === 1, 'the line');
      assert.equal(report.report[0], `started ${S1.slice(0, 8)} ${hostile}`);
      assert.deepEqual(
        await page.evaluate(() => [
          document.querySelector('img'),
          document.querySelector('#banner b'),
          Reflect.get(globalThis, 'pwned') ?? null,
        ]),
        [null, null, null],
      );
    },
  );

  await t.test(
    'thirty entries and 200 report lines (of 205): the banner takes at most 40 % of the list zone and scrolls inside, the filter and a row of the list stay visible',
    async (t) => {
      const ids = Array.from({ length: 30 }, (_, n) => sessionN(n + 1));
      const [page, w] = await world(t, chromium, listOf(bannerOf(ids.map((id) => entryOf(id)))));
      await until(page, (now) => now.entries.length === 30, 'thirty entries');
      for (let n = 1; n <= 205; n++) w.progress(`started line ${n}`);
      const report = await until(
        page,
        (now) => now.report.length === 200 && now.report.at(-1) === 'started line 205',
        'the last 200',
      );
      assert.equal(report.report[0], 'started line 6');
      const layout = await page.evaluate(() => {
        const zone = (document.getElementById('list-zone') as HTMLElement).getBoundingClientRect();
        const banner = document.getElementById('banner') as HTMLElement;
        const filter = document.querySelector('#list input') as HTMLElement;
        const rows = [...document.querySelectorAll('#list [data-id]')].map((row) =>
          row.getBoundingClientRect(),
        );
        const body = document.querySelector('#list .list-body')?.getBoundingClientRect() ?? zone;
        const f = filter.getBoundingClientRect();
        // Scrolled to its end, the banner shows its last line inside its own box: it scrolls,
        // it does not paint over the list.
        banner.scrollTop = banner.scrollHeight;
        const box = banner.getBoundingClientRect();
        const last = [...banner.querySelectorAll('.banner-report-line')]
          .at(-1)
          ?.getBoundingClientRect();
        return {
          zone: zone.height,
          banner: box.height,
          scrolls:
            banner.scrollTop > 0 &&
            last !== undefined &&
            last.bottom <= box.bottom + 1 &&
            last.top >= box.top,
          filter: f.height > 0 && f.top >= zone.top && f.bottom <= zone.bottom,
          rowShown: rows.some(
            (row) => row.height > 0 && row.top < body.bottom && row.bottom > body.top,
          ),
        };
      });
      assert.ok(layout.banner <= layout.zone * 0.4 + 1, JSON.stringify(layout));
      assert.equal(layout.scrolls, true, 'the banner scrolls inside');
      assert.equal(layout.filter, true, "the filter's field is visible");
      assert.equal(layout.rowShown, true, 'a row of the list is visible');
    },
  );

  await t.test(
    "with a terminal shown, a banner that comes and goes sends no `resize` and leaves the terminal's box and the header's height; a click on it, its result and its report lines leave the keyboard in the terminal",
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(null, RUNNING_ROWS, RUNNING_TERMS));
      await page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      await page.waitForFunction(
        () => document.getElementById('terminal')?.contains(document.activeElement) === true,
        null,
        { timeout: PAGE_WAIT_MS },
      );
      await sleep(1000); // the view's own fitting after its snap
      const boxes = (): Promise<{ terminal: number[]; header: number }> =>
        page.evaluate(() => {
          const term = (document.getElementById('terminal') as HTMLElement).getBoundingClientRect();
          const header = document.querySelector('#cards .card-header')?.getBoundingClientRect();
          return {
            terminal: [term.left, term.top, term.width, term.height],
            header: header?.height ?? -1,
          };
        });
      const before = await boxes();
      const from = w.sent.length;

      w.list(listOf(three(), RUNNING_ROWS, RUNNING_TERMS));
      await until(page, (now) => now.offer, 'the offer is shown');
      await sleep(600); // past the page's 200 ms resize wait
      assert.deepEqual(await boxes(), before, 'the banner came: the same boxes');

      await page.click(box(S3));
      await page.click('#banner .banner-restore');
      w.answer(await w.act(1), { ok: true });
      w.list(listOf(three({ running: true }), RUNNING_ROWS, RUNNING_TERMS));
      w.progress(`started ${S1.slice(0, 8)} session`);
      await until(page, (now) => now.report.length === 1, 'the line');
      w.list(listOf(null, RUNNING_ROWS, RUNNING_TERMS));
      await until(page, (now) => now.offer === false, 'the offer went');
      await sleep(600);
      assert.deepEqual(await boxes(), before, 'the banner went: the same boxes');
      assert.deepEqual(
        w.sent.slice(from).filter((message) => message['t'] === 'resize'),
        [],
        'no resize',
      );
      assert.equal(await active(page), 'in #terminal', 'the terminal kept the keyboard');
      assert.equal(await selectedRow(page), S1, 'the selection did not move');
    },
  );

  await t.test(
    'a title of 1,024 bytes wraps inside the list zone and does not widen it',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(null));
      await connectionListed(page);
      const width = (): Promise<number> =>
        page.evaluate(
          () => (document.getElementById('list-zone') as HTMLElement).getBoundingClientRect().width,
        );
      const before = await width();
      w.list(listOf(bannerOf([entryOf(S1, { title: 'x'.repeat(1024) })])));
      await until(page, (now) => now.entries.length === 1, 'the entry');
      const fits = await page.evaluate(() => {
        const zone = (document.getElementById('list-zone') as HTMLElement).getBoundingClientRect();
        const banner = document.getElementById('banner') as HTMLElement;
        const label = (
          document.querySelector('#banner .banner-entry') as HTMLElement
        ).getBoundingClientRect();
        return {
          inside: label.left >= zone.left && label.right <= zone.right,
          noScroll: banner.scrollWidth <= banner.clientWidth,
          lines: label.height,
        };
      });
      assert.equal(await width(), before, 'the zone keeps its width');
      assert.equal(fits.inside, true, 'the entry lies inside the zone');
      assert.equal(fits.noScroll, true, 'nothing scrolls sideways');
      assert.ok(fits.lines > 40, `the title wraps (${fits.lines} px)`);
    },
  );

  await t.test(
    'a restore-progress notice and the result of `act restore` move neither the selection nor the keyboard (the list zone)',
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown');
      await clickRow(page, S2);
      await page.click('#banner .banner-restore');
      w.answer(await w.act(1), { ok: true });
      w.list(listOf(three({ running: true })));
      for (const line of [
        'started 0b5f3c1e one',
        'started 1c6a4d2f two',
        'restore finished: 2 started',
      ]) {
        w.progress(line);
      }
      await until(page, (now) => now.close, 'the run is reported');
      await settle();
      assert.equal(await selectedRow(page), S2, 'the selection stays');
      assert.equal(await active(page), '#list', 'the keyboard stays');
    },
  );

  await t.test(
    "while stage D's dialog is shown the banner takes no click, and a restore's lines move no keyboard",
    async (t) => {
      const [page, w] = await world(t, chromium, listOf(null));
      await connectionListed(page);
      await clickRow(page, S2);
      await page.keyboard.press('l');
      await page.waitForSelector('#editor:not([hidden])', {
        state: 'attached',
        timeout: PAGE_WAIT_MS,
      });
      const inField = (): Promise<boolean> =>
        page.evaluate(() => document.activeElement?.classList.contains('edit-field') === true);
      assert.equal(await inField(), true);

      w.list(listOf(three()));
      await until(page, (now) => now.offer, 'the offer is shown under the scrim');
      for (const selector of [
        box(S1),
        box(S3),
        '#banner .banner-restore',
        '#banner .banner-not-now',
      ]) {
        const at = await page.locator(selector).boundingBox();
        assert.ok(at !== null, selector);
        await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
      }
      w.progress('started 0b5f3c1e one');
      w.progress('restore finished: 1 started');
      const after = await until(page, (now) => now.close, 'the report is drawn');
      await settle();
      assert.deepEqual(ticks(after), [true, true, false], 'no tick changed');
      assert.deepEqual(w.acts(), [], 'no act');
      assert.equal(await inField(), true, "the dialog's field keeps the keyboard");
      assert.equal(await keyMessage(page), '', 'nothing said');
    },
  );
});

/** Waits until the page has sent its `n`-th `view` (the world answers each with its list). */
async function viewsSent(w: BannerWorld, n: number): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  while (w.sent.filter((message) => message['t'] === 'view').length < n) {
    assert.ok(performance.now() < deadline, `the page's view ${n}`);
    await sleep(20);
  }
}

/** Ten sessions not running (a list long enough to move under the banner's place). */
const TEN = Array.from({ length: 10 }, (_, n) => ({
  id: sessionN(n + 1),
  terminal: null,
  slot: null,
}));

/** Waits until the element `id` names (as `active` says it) has the keyboard. */
async function keyboardOn(page: Page, id: string): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const now = await active(page);
    if (now === id) return;
    if (performance.now() > deadline) assert.fail(`the keyboard is on ${now}, not ${id}`);
    await sleep(20);
  }
}

/** Waits until the page has drawn its first list (a row of it). */
async function connectionListed(page: Page): Promise<void> {
  await page.waitForSelector('#list [data-id]', { state: 'attached', timeout: PAGE_WAIT_MS });
}
