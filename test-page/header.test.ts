// The header of stage D and the pull-request dialog's list (S2 12.3, 12.5, 12.10; plan D task 38,
// D11–D15, D17): one height for every session and width, the ages that count on, the controls that
// open task 37's dialogs, the ticket link, Done, and every attached pull request in the dialog.
// The cases about heights, ages and what is drawn run against a scripted stand-in server
// (`editWorld`, helpers/shell.ts), so that a list holds exactly what the case says; the cases of
// the controls run against a real test server (test/helpers/window.ts) with the stand-in program,
// sessions made by step 1's helpers, pull requests attached with `attachManualPr` and their status
// saved with `savePrResult`, `gh` answered by test/helpers/gh.ts, and links seen by the Edge stub.
// The page has web/'s real modules in every case.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import type { Deck } from '../src/sessions/deck.ts';
import { attachManualPr, requirePrKey, setLabel, setNote } from '../src/sessions/meta.ts';
import type { PrFetchResult } from '../src/store/types.ts';
import { windowChip } from '../src/window/view/chip.ts';
import { ghRunner } from '../test/helpers/gh.ts';
import type { GhOptions, GhRunner } from '../test/helpers/gh.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  after,
  clickRow,
  editWorld,
  keyMessage,
  launched,
  logOf,
  mark,
  PAGE_WAIT_MS,
  RECORDER,
  resumeFromList,
  scriptedList,
  selectedRow,
  shownText,
  showsText,
  TERM_A,
} from './helpers/shell.ts';
import type { EditWorld, Launched } from './helpers/shell.ts';

type Row = Record<string, unknown>;

/** The stand-in's `nowNs` (scriptedList's): 2026-11-12T09:00:00Z. */
const NOW_NS = 1794474000000000000n;
const SEC_NS = 1_000_000_000n;
const MIN_NS = 60n * SEC_NS;
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const DONE_WORDS = 'Marked done: hidden from the list. It comes back on new activity.';
const DONE_RUNNING_WORDS = 'Marked done. Stays under Open while it runs; hidden once it stops.';
const PR7 = 'https://github.com/acme/web/pull/7';
const PR8 = 'https://github.com/acme/web/pull/8';
const PR9 = 'https://github.com/acme/web/pull/9';
const PR10 = 'https://github.com/acme/web/pull/10';
const TICKETS = 'https://tickets.example/browse/{key}';

// --- the scripted world -----------------------------------------------------------------------

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

/** A pull request of a row (S2 8.2.3 PrPayload), read 4 minutes before the list's now. */
function pr(number: number, level: string, more: Row = {}): Row {
  return {
    url: `https://github.com/acme/web/pull/${number}`,
    repo: 'acme/web',
    number,
    title: `Pull request ${number}`,
    level,
    error: null,
    okAtNs: String(NOW_NS - 4n * MIN_NS),
    ...more,
  };
}

/** A row's `prs` and the chip the server makes of them (S2 12.3, `windowChip`). */
function prsOf(prs: Row[]): Row {
  return { prs, chip: windowChip(prs as { level: string }[]) };
}

interface Sections {
  open?: Row[];
  week?: Row[];
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
      count: name === 'earlier' ? 0 : (sections[name]?.length ?? 0),
      rows: name === 'earlier' ? [] : (sections[name] ?? []),
    })),
    terminals,
    selected,
  };
}

interface Scripted {
  page: Page;
  w: EditWorld;
  /** Sets what the next lists hold and sends one. */
  set(change: { sections?: Sections; terminals?: Row[]; selected?: Record<string, Row> }): void;
}

/** A page with the real modules on an `editWorld` whose lists are made of `start`. */
async function scripted(
  t: TestContext,
  chromium: Browser,
  start: { sections: Sections; terminals?: Row[]; selected?: Record<string, Row> },
  options: { recorder?: boolean } = {},
): Promise<Scripted> {
  const page = await newPage(t, chromium);
  if (options.recorder === true) await page.addInitScript(RECORDER);
  let sections = start.sections;
  let terminals = start.terminals ?? [];
  let selected = start.selected ?? {};
  const listFor = (id: string | null): Row =>
    listOf(sections, terminals, id === null ? null : selectedOf(id, selected[id] ?? {}));
  const w = await editWorld(t, page, listFor);
  return {
    page,
    w,
    set(change) {
      sections = change.sections ?? sections;
      terminals = change.terminals ?? terminals;
      selected = change.selected ?? selected;
      w.list(listFor);
    },
  };
}

// --- reading the page -------------------------------------------------------------------------

/** The text of every shown element matching `selector` in `root`, in order. */
async function texts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)]
        .filter((element) => element instanceof HTMLElement && element.closest('[hidden]') === null)
        .map((element) => element.textContent ?? ''),
    selector,
  );
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

/** Waits until the texts of `selector` are `wanted`. */
async function showsAll(page: Page, selector: string, wanted: string[]): Promise<void> {
  let last: string[] = [];
  await eventually(
    async () => {
      last = await texts(page, selector);
      return JSON.stringify(last) === JSON.stringify(wanted);
    },
    `${selector}: ${JSON.stringify(wanted)}`,
  ).catch(() => {
    assert.deepEqual(last, wanted, selector);
  });
}

/** The header's box and its four lines, and whether its controls are whole and inside it. */
interface Measured {
  height: number;
  lines: { name: string; height: number; overflows: boolean }[];
  whole: Record<string, boolean | null>;
}
async function measure(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    const head = document.querySelector('#cards .card-header') as HTMLElement;
    const box = head.getBoundingClientRect();
    const whole = (selector: string): boolean | null => {
      const element = head.querySelector(selector);
      if (!(element instanceof HTMLElement) || element.closest('[hidden]') !== null) return null;
      const r = element.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.left >= box.left &&
        r.right <= box.right &&
        r.right <= innerWidth &&
        element.scrollWidth <= element.clientWidth
      );
    };
    return {
      height: box.height,
      lines: [...head.children].map((line) => ({
        name: line.className,
        height: line.getBoundingClientRect().height,
        overflows: line.scrollHeight > line.clientHeight + 1,
      })),
      whole: Object.fromEntries(
        [
          '.header-id',
          '.header-prs-button',
          '.header-note-button',
          '.header-done',
          '.header-group-edit',
          '.header-group-add',
        ].map((selector) => [selector, whole(selector)]),
      ),
    };
  });
}

/** What the dialog shows: whether it is shown, its heading, its message, its field's value. */
async function dialog(page: Page): Promise<{
  shown: boolean;
  heading: string;
  message: string;
  value: string | null;
  inField: boolean;
}> {
  return page.evaluate(() => {
    const root = document.getElementById('editor') as HTMLElement;
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('.edit-field');
    const text = (selector: string): string => {
      const element = root.querySelector<HTMLElement>(selector);
      return element === null || element.closest('[hidden]') !== null
        ? ''
        : (element.textContent ?? '');
    };
    return {
      shown: !root.hidden,
      heading: text('.edit-heading'),
      message: text('.edit-message'),
      value: field === null || field.closest('[hidden]') !== null ? null : field.value,
      inField: field !== null && document.activeElement === field,
    };
  });
}

async function dialogShown(page: Page, shown: boolean): Promise<void> {
  await page.waitForSelector(shown ? '#editor:not([hidden])' : '#editor[hidden]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** The pull-request dialog's lines that are shown, in order. */
function prLines(page: Page): Promise<string[]> {
  return texts(page, '#editor .edit-pr .edit-pr-text');
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

/** The tooltip of the element `selector`. */
async function tipOf(page: Page, selector: string): Promise<string> {
  return (await page.getAttribute(selector, 'title')) ?? '';
}

// --- the real server ----------------------------------------------------------------------------

/** A page of a real server whose runner answers `gh` as `options` says (held: never, by default). */
async function withGh(
  t: TestContext,
  chromium: Browser,
  options: GhOptions = { hold: 'held' },
  config: Record<string, unknown> = {},
): Promise<Launched & { gh: GhRunner }> {
  let gh: GhRunner | null = null;
  const l = await launched(t, chromium, {
    config,
    server: {
      platform: (platform) => {
        gh = ghRunner(platform.runner, options);
        return { ...platform, runner: gh };
      },
    },
  });
  assert.ok(gh !== null);
  return { ...l, gh };
}

/**
 * Attaches `url` to `sessionId` as `skydeck pr add` does (`attachManualPr`), with `result` saved
 * first (`savePrResult`), so that no refresh finds it due; `null` leaves it never fetched.
 */
function attach(deck: Deck, sessionId: string, url: string, result: PrFetchResult | null): void {
  deck.store.ensurePr(requirePrKey(url));
  if (result !== null) deck.store.savePrResult(url, result);
  attachManualPr(deck, sessionId, url);
}

/** An answer of GitHub for `savePrResult`, read now. */
function read(
  deck: Deck,
  state: 'open' | 'draft' | 'merged' | 'closed',
  review: 'approved' | 'changes-requested' | 'review-required' | null,
  checks: 'passing' | 'failing' | 'pending' | null,
  title = 'Fix the retry',
): PrFetchResult {
  return { ok: true, atNs: deck.platform.clock.nowNs(), title, state, review, checks };
}

/** Whether `url` is attached to `sessionId` in the store (not detached). */
function attached(deck: Deck, sessionId: string, url: string): boolean {
  return deck.store
    .sessionPrs()
    .some((link) => link.sessionId === sessionId && link.url === url && link.detachedAtNs === null);
}

/** Waits until the Edge stub was run with `url` (S2 9.6). */
async function opened(l: Launched, url: string): Promise<void> {
  await eventually(
    async () => l.d.edgeCalls().some((args) => args.includes(url)),
    `${url} opened by the Edge stub`,
  );
}

/** The ids of the list's rows in a section, in order. */
async function sectionRows(page: Page, section: string): Promise<string[]> {
  return page.evaluate((section) => {
    // A section's header comes before its rows; the rows are not inside it.
    const rows: string[] = [];
    let current = '';
    for (const element of document.querySelectorAll('#list .list-section, #list [data-id]')) {
      if (element.classList.contains('list-section')) {
        current = element.getAttribute('data-section') ?? '';
      } else if (current === section) {
        rows.push(element.getAttribute('data-id') ?? '');
      }
    }
    return rows;
  }, section);
}

test("stage D's header and the pull-request dialog's list", async (t) => {
  const chromium = await browser(t);

  // --- one height -------------------------------------------------------------------------------

  await t.test(
    "one height (D12): bare, with three open pull requests, thirty merged and a note of five lines, a directory of 340 characters, and stage D's longest texts, at 1280 and 900 px → the same header height in four lines of one line each; the buttons and the short id never cut; no resize while only the content changes",
    async (t) => {
      const term = terminal(TERM_A, S1, 1);
      const bare = running(S1, TERM_A, 1, { title: 'a title' });
      const s = await scripted(t, chromium, {
        sections: { open: [bare] },
        terminals: [term],
      });
      const note5 = 'one\ntwo\nthree\nfour\nfive';
      const longDir = `/home/u/${'a-very-long-directory-name/'.repeat(13)}end`;
      assert.ok(longDir.length >= 340);
      const eight = Array.from({ length: 8 }, (_, at) =>
        pr(at + 1, 'checks-failing', {
          repo: `some-organisation/${'r'.repeat(40)}`,
          title: 'A pull request title that is long '.repeat(30),
        }),
      );
      const variants: [string, Row, Row][] = [
        ['bare', bare, {}],
        [
          'three open, thirty merged, a note of five lines, a ticket link',
          running(S1, TERM_A, 1, {
            title: 'ORB-7 fix the retry',
            group: 'ORB-7',
            groupSource: 'title',
            hasNote: true,
            noteHead: ['one', 'two', 'three'],
            ...prsOf([
              pr(1, 'checks-failing'),
              pr(2, 'review-required'),
              pr(3, 'draft'),
              ...Array.from({ length: 30 }, (_, at) => pr(100 + at, 'merged')),
            ]),
          }),
          { note: note5, ticketUrl: 'https://tickets.example/browse/ORB-7' },
        ],
        ['a directory of 340 characters', running(S1, TERM_A, 1, { dir: longDir }), {}],
        [
          "stage D's longest texts",
          running(S1, TERM_A, 1, {
            title: `L${'l'.repeat(1023)}`,
            titleSource: 'label',
            group: 'G'.repeat(200),
            groupSource: 'meta',
            stateDetail: 'permission '.repeat(30),
            dir: longDir,
            hasNote: true,
            noteHead: ['n'.repeat(1000), 'second'],
            ...prsOf(eight),
          }),
          {
            note: `${'n'.repeat(1000)}\nsecond`,
            ticketUrl: `https://tickets.example/browse/${'K'.repeat(1900)}`,
          },
        ],
      ];
      let height: number | null = null;
      for (const width of [1280, 900]) {
        await s.page.setViewportSize({ width, height: 800 });
        s.set({ sections: { open: [bare] }, selected: {} });
        await showsText(s.page, '#cards .header-title', /^a title$/);
        await sleep(800); // a resize for the new width is the page's to send, before `from`
        const from = s.w.sent.length;
        for (const [what, shown, selected] of variants) {
          s.set({ sections: { open: [shown] }, selected: { [S1]: selected } });
          await showsText(
            s.page,
            '#cards .header-title',
            new RegExp(`^${(shown['title'] as string).slice(0, 40)}`),
          );
          await sleep(200);
          const m = await measure(s.page);
          const where = `${what} at ${width} px`;
          height ??= m.height;
          assert.equal(m.height, height, `${where}: the header's height`);
          assert.deepEqual(
            m.lines.map((line) => line.name),
            ['header-top', 'header-sub', 'header-prs', 'header-note'],
            `${where}: four lines`,
          );
          for (const line of m.lines) {
            assert.ok(!line.overflows, `${where}: ${line.name} is one line`);
          }
          for (const [control, whole] of Object.entries(m.whole)) {
            assert.notEqual(whole, false, `${where}: ${control} is whole and inside the header`);
          }
          assert.equal(m.whole['.header-id'], true, `${where}: the short id`);
          assert.equal(m.whole['.header-prs-button'], true, `${where}: the pull-request button`);
        }
        await sleep(800);
        const resized = s.w.sent.slice(from).filter((message) => message['t'] === 'resize');
        assert.deepEqual(resized, [], `at ${width} px: no resize while only the content changed`);
      }
    },
  );

  await t.test(
    'a pull request attached, and a note set, changed and cleared, while the terminal runs (the real server): the same height, and the page sends no resize',
    async (t) => {
      const l = await withGh(t, chromium);
      l.d.resumable(S1);
      await resumeFromList(l.page, S1);
      await showsText(l.page, '#cards .header-prs-none', /^no pull request$/);
      await sleep(1000); // the terminal's first size is settled
      const before = (await measure(l.page)).height;
      await mark(l.page, 'content');
      attach(l.d.deck, S1, PR7, read(l.d.deck, 'open', null, 'failing'));
      await showsAll(l.page, '#cards .header-pr', ['acme/web #7 · failing']);
      setNote(l.d.deck, S1, 'a note\nof two lines');
      await showsText(l.page, '#cards .header-note-text', /^a note …$/);
      assert.equal((await measure(l.page)).height, before);
      setNote(l.d.deck, S1, 'another note');
      await showsText(l.page, '#cards .header-note-text', /^another note$/);
      setNote(l.d.deck, S1, null);
      await showsText(l.page, '#cards .header-note-text', /^no note$/);
      assert.equal((await measure(l.page)).height, before);
      await sleep(800);
      const resized = after(await logOf(l.page), 'content').filter(
        (entry) => entry.e === 'out' && entry.t === 'resize',
      );
      assert.deepEqual(resized, [], 'no resize');
      assert.deepEqual(l.problems, []);
    },
  );

  // --- what the header shows ----------------------------------------------------------------------

  await t.test(
    "the header's four lines: the title, the group chip, ✎, the state, Note and Done; the directory, the times, the title's source and the short id; the chip, the open pull requests and `Pull requests`; the note's first line",
    async (t) => {
      const prs = [pr(7, 'checks-failing'), pr(8, 'review-required'), pr(9, 'merged')];
      const s = await scripted(t, chromium, {
        sections: {
          open: [
            running(S1, TERM_A, 1, {
              title: 'ORB-7 fix the retry',
              titleSource: 'label',
              group: 'ORB-7',
              groupSource: 'title',
              hasNote: true,
              noteHead: ['first line', 'second line'],
              lastActivityNs: String(NOW_NS - 3n * MIN_NS),
              ...prsOf(prs),
            }),
          ],
          week: [row(S2, { title: 'plain', titleSource: 'generated' })],
        },
        terminals: [terminal(TERM_A, S1, 1, { openedNs: '1741064760000000000' })],
      });
      const { page } = s;
      await showsText(page, '#cards .header-title', /^ORB-7 fix the retry$/);
      assert.deepEqual(await texts(page, '#cards .header-group'), ['ORB-7']);
      assert.match(await tipOf(page, '#cards .header-group'), /from the title/);
      assert.equal(await page.getAttribute('#cards .header-group', 'data-link'), 'false');
      assert.deepEqual(await texts(page, '#cards .header-group-edit'), ['✎']);
      assert.deepEqual(await texts(page, '#cards .header-group-add'), []);
      assert.deepEqual(await texts(page, '#cards .header-state'), ['running']);
      assert.deepEqual(await texts(page, '#cards .header-note-button'), ['Note']);
      assert.deepEqual(await texts(page, '#cards .header-done'), ['Done']);
      assert.deepEqual(await texts(page, '#cards .header-dir'), ['/home/u/project']);
      // 2025-03-04T05:06Z: the pages of newPage run in UTC.
      assert.deepEqual(await texts(page, '#cards .header-times'), [
        'opened 4 Mar 2025 at 05:06 · last active 3m',
      ]);
      assert.deepEqual(await texts(page, '#cards .header-source'), ['title: your label']);
      assert.deepEqual(await texts(page, '#cards .header-id'), [S1.slice(0, 8)]);
      assert.deepEqual(await texts(page, '#cards .header-chip'), ['2 PRs · failing +1']);
      assert.match(await tipOf(page, '#cards .header-chip'), /acme\/web #7 · failing/);
      assert.deepEqual(await texts(page, '#cards .header-pr'), [
        'acme/web #7 · failing',
        'acme/web #8 · review',
      ]);
      assert.equal(
        await tipOf(page, '#cards .header-pr'),
        'acme/web #7 · checks failing · checked 4m ago\nPull request 7',
      );
      assert.deepEqual(await texts(page, '#cards .header-prs-none'), []);
      assert.deepEqual(await texts(page, '#cards .header-prs-button'), ['Pull requests']);
      assert.deepEqual(await texts(page, '#cards .header-note-text'), ['first line …']);

      // With the ticket address: the key and ↗, underlined, the address as its tooltip.
      s.set({ selected: { [S1]: { ticketUrl: 'https://tickets.example/browse/ORB-7' } } });
      await showsText(page, '#cards .header-group', /^ORB-7 ↗$/);
      assert.equal(await page.getAttribute('#cards .header-group', 'data-link'), 'true');
      assert.equal(
        await tipOf(page, '#cards .header-group'),
        'https://tickets.example/browse/ORB-7',
      );
      assert.match(
        await page.evaluate(
          () =>
            getComputedStyle(document.querySelector('#cards .header-group-key') as Element)
              .textDecorationLine,
        ),
        /underline/,
      );

      // A session not running, without a group, pull requests or a note: no `opened`, `+ group`,
      // `no pull request` with `+ PR`, and `no note`.
      await clickRow(page, S2);
      await showsText(page, '#cards .header-title', /^plain$/);
      assert.deepEqual(await texts(page, '#cards .header-group'), []);
      assert.deepEqual(await texts(page, '#cards .header-group-edit'), []);
      assert.deepEqual(await texts(page, '#cards .header-group-add'), ['+ group']);
      assert.match((await texts(page, '#cards .header-times'))[0] ?? '', /^last active \d+s$/);
      assert.deepEqual(await texts(page, '#cards .header-source'), [
        "title: Claude Code's summary",
      ]);
      assert.deepEqual(await texts(page, '#cards .header-chip'), []);
      assert.deepEqual(await texts(page, '#cards .header-pr'), []);
      assert.deepEqual(await texts(page, '#cards .header-prs-none'), ['no pull request']);
      assert.deepEqual(await texts(page, '#cards .header-prs-button'), ['+ PR']);
      assert.deepEqual(await texts(page, '#cards .header-note-text'), ['no note']);
      assert.equal(await page.getAttribute('#cards .header-note-text', 'data-empty'), 'true');
    },
  );

  await t.test(
    "ages count on from the page's clock (no new list): `last active 1m` becomes `2m` in the header, `checked 3m ago` becomes `4m` in an open pull-request dialog",
    async (t) => {
      const s = await scripted(
        t,
        chromium,
        {
          sections: {
            week: [
              row(S1, {
                lastActivityNs: String(NOW_NS - 117n * SEC_NS),
                ...prsOf([pr(7, 'draft', { okAtNs: String(NOW_NS - 237n * SEC_NS) })]),
              }),
            ],
          },
        },
        { recorder: true },
      );
      const { page, w } = s;
      await showsText(page, '#cards .header-times', /^last active 1m$/);
      w.holdViews(true); // no list comes from here on
      await mark(page, 'ages');
      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await showsAll(page, '#editor .edit-pr-text', ['acme/web #7 · draft · checked 3m ago']);
      await showsText(page, '#cards .header-times', /^last active 2m$/, 10_000);
      await showsAll(page, '#editor .edit-pr-text', ['acme/web #7 · draft · checked 4m ago']);
      const lists = after(await logOf(page), 'ages').filter((e) => e.e === 'in' && e.t === 'list');
      assert.deepEqual(lists, [], 'no list came meanwhile');
    },
  );

  await t.test(
    'every text a user or a program wrote — a title, a group, a note line, a pull request’s repository, title and error, a ticket address — appears as text in the header and the dialog and creates no element',
    async (t) => {
      const img = '<img src=x onerror="window.hacked=1">';
      const s = await scripted(t, chromium, {
        sections: {
          week: [
            row(S1, {
              title: `t ${img}`,
              group: `<b>g</b>`,
              groupSource: 'meta',
              hasNote: true,
              noteHead: [`note ${img}`],
              ...prsOf([
                pr(7, 'cant-read', {
                  repo: `<b>o</b>/${img}`,
                  title: `<b>${img}</b>`,
                  error: `e ${img}`,
                }),
                pr(8, 'merged', { title: img }),
              ]),
            }),
          ],
        },
        selected: { [S1]: { ticketUrl: `https://t.example/${img}`, note: `note ${img}` } },
      });
      const { page } = s;
      await showsText(page, '#cards .header-title', /^t <img/);
      assert.deepEqual(await texts(page, '#cards .header-group-key'), ['<b>g</b>']);
      assert.equal(await tipOf(page, '#cards .header-group'), `https://t.example/${img}`);
      assert.deepEqual(await texts(page, '#cards .header-note-text'), [`note ${img}`]);
      assert.deepEqual(await texts(page, '#cards .header-pr'), [`<b>o</b>/${img} #7 · can't read`]);
      assert.match(await tipOf(page, '#cards .header-pr'), /<b><img src=x/);
      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await page.locator('#editor .edit-pr-fold').click();
      await showsAll(page, '#editor .edit-pr-text', [
        `<b>o</b>/${img} #7 · can't read · last read 4m ago · e ${img}`,
        'acme/web #8 · merged',
      ]);
      assert.equal(
        await page.locator('#cards img, #cards b, #editor img, #editor b, #toast img').count(),
        0,
      );
      assert.equal(await page.evaluate(() => Reflect.get(window, 'hacked')), undefined);
    },
  );

  // --- the controls (scripted) ----------------------------------------------------------------------

  await t.test(
    'D17: a drag over the title selects it and opens nothing; a click on it opens the label dialog; Done takes no keyboard on a click, and Done clicked twice while its answer waits sends one act',
    async (t) => {
      const s = await scripted(t, chromium, {
        sections: { week: [row(S1, { title: 'select this title' }), row(S2)] },
      });
      const { page, w } = s;
      await showsText(page, '#cards .header-title', /^select this title$/);
      const box = await page.locator('#cards .header-title').boundingBox();
      assert.ok(box !== null);
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await sleep(300);
      assert.match(await page.evaluate(() => getSelection()?.toString() ?? ''), /select this/);
      assert.equal((await dialog(page)).shown, false, 'a drag opens nothing');
      await page.evaluate(() => getSelection()?.removeAllRanges());

      await page.locator('#cards .header-title').click();
      await dialogShown(page, true);
      const shown = await dialog(page);
      assert.equal(shown.heading, 'Label — select this title');
      assert.ok(shown.inField);
      await page.keyboard.press('Escape');
      await dialogShown(page, false);

      await page.focus('#list');
      const done = page.locator('#cards .header-done');
      await done.click();
      await done.click();
      await sleep(300);
      assert.equal(await active(page), '#list', 'the button took no keyboard');
      const acts = w.acts().filter((act) => act['kind'] === 'done');
      assert.equal(acts.length, 1, 'one act while its answer waits');
      assert.equal(acts[0]?.['sessionId'], S1);
      w.answer(acts[0] as Row, { ok: true });
      await eventually(async () => (await toast(page)).text === DONE_WORDS, 'the toast');
    },
  );

  // --- the controls (the real server) -----------------------------------------------------------

  await t.test(
    "the real server: an item's click opens the pull request; the button opens the dialog with every attached one in D13's words, the fold opens and closes; × detaches it, the toast `Detached acme/web #7` and its Undo attaches it again",
    async (t) => {
      const l = await withGh(t, chromium);
      const deck = l.d.deck;
      l.d.resumable(S1);
      attach(deck, S1, PR7, read(deck, 'open', null, 'failing'));
      attach(deck, S1, PR8, read(deck, 'open', 'review-required', 'passing'));
      attach(deck, S1, PR9, read(deck, 'merged', 'approved', 'passing'));
      attach(deck, S1, PR10, read(deck, 'closed', null, null));
      await clickRow(l.page, S1);
      await showsAll(l.page, '#cards .header-pr', [
        'acme/web #7 · failing',
        'acme/web #8 · review',
      ]);
      assert.deepEqual(await texts(l.page, '#cards .header-chip'), ['2 PRs · failing +1']);

      await l.page.locator('#cards .header-pr').first().click();
      await opened(l, PR7);

      await l.page.locator('#cards .header-prs-button').click();
      await dialogShown(l.page, true);
      assert.match((await dialog(l.page)).heading, /^Pull requests — /);
      await eventually(async () => {
        const lines = await prLines(l.page);
        return (
          lines.length === 2 &&
          /^acme\/web #7 · checks failing · checked \d+s ago$/.test(lines[0] ?? '') &&
          /^acme\/web #8 · review required · checked \d+s ago$/.test(lines[1] ?? '')
        );
      }, 'the open ones in the dialog');
      assert.deepEqual(await texts(l.page, '#editor .edit-pr-fold'), ['1 merged, 1 closed ▸']);
      await l.page.locator('#editor .edit-pr-fold').click();
      await showsAll(l.page, '#editor .edit-pr-fold', ['1 merged, 1 closed ▾']);
      // In the order the server sends them: sorted by address.
      assert.deepEqual((await prLines(l.page)).slice(2), [
        'acme/web #10 · closed',
        'acme/web #9 · merged',
      ]);
      assert.ok((await dialog(l.page)).inField, 'the fold leaves the keyboard in the field');
      await l.page.locator('#editor .edit-pr-fold').click();
      await eventually(async () => (await prLines(l.page)).length === 2, 'folded again');

      // A click on a line opens it too.
      const calls = l.d.edgeCalls().length;
      await l.page.locator('#editor .edit-pr-text').nth(1).click();
      await eventually(async () => l.d.edgeCalls().length > calls, 'the line opened');
      assert.ok(l.d.edgeCalls().at(-1)?.includes(PR8));

      await l.page.locator('#editor .edit-pr-remove').first().click();
      await eventually(async () => !attached(deck, S1, PR7), 'detached in the store');
      await eventually(
        async () => (await toast(l.page)).text === 'Detached acme/web #7',
        'the toast',
      );
      assert.equal((await toast(l.page)).undo, true);
      await eventually(async () => (await prLines(l.page)).length === 1, 'its line is gone');
      assert.ok((await dialog(l.page)).inField, '× leaves the keyboard in the field');
      await l.page.locator('#toast .toast-undo').click();
      await eventually(async () => attached(deck, S1, PR7), 'attached again');
      await eventually(async () => (await prLines(l.page)).length === 2, 'its line is back');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the real server: a URL in the dialog’s field is attached, its line `not fetched` while `gh` holds its answer, then its state, the dialog open all along; ↻ asks `gh` again',
    async (t) => {
      const l = await withGh(t, chromium);
      l.d.resumable(S1);
      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .header-prs-button', /^\+ PR$/);
      await l.page.locator('#cards .header-prs-button').click();
      await dialogShown(l.page, true);
      assert.deepEqual(await texts(l.page, '#editor .edit-pr-none'), ['no pull request attached']);
      await l.page.keyboard.type(PR7);
      await l.page.keyboard.press('Enter');
      await showsAll(l.page, '#editor .edit-pr-text', ['acme/web #7 · not fetched']);
      assert.equal((await dialog(l.page)).value, '', 'the field is empty again');
      await l.gh.started(1, PAGE_WAIT_MS);
      l.gh.release();
      await eventually(
        async () =>
          /^acme\/web #7 · approved, green · checked \d+s ago$/.test(
            (await prLines(l.page))[0] ?? '',
          ),
        "the stand-in's state",
      );
      assert.equal((await dialog(l.page)).shown, true, 'the dialog stays open');
      await showsAll(l.page, '#cards .header-pr', ['acme/web #7 · approved']);

      const runs = l.gh.runs.length;
      await l.page.locator('#editor .edit-pr-refresh').click();
      await l.gh.started(runs + 1, PAGE_WAIT_MS);
      assert.ok(l.gh.runs.at(-1)?.prs.includes('acme/web#7'));
      l.gh.release();
      assert.ok((await dialog(l.page)).inField, '↻ leaves the keyboard in the field');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the real server: the title’s click opens the label dialog; saved, the new title is in the header and the list',
    async (t) => {
      const l = await withGh(t, chromium);
      l.d.resumable(S1);
      await clickRow(l.page, S1);
      await l.page.locator('#cards .header-title').click();
      await dialogShown(l.page, true);
      await l.page.keyboard.type('the new title');
      await l.page.keyboard.press('Enter');
      await dialogShown(l.page, false);
      await showsText(l.page, '#cards .header-title', /^the new title$/);
      await showsText(l.page, `#list [data-id="${S1}"]`, /the new title/);
      await showsText(l.page, '#cards .header-source', /^title: your label$/);
      assert.equal(l.d.deck.store.meta(S1)?.label, 'the new title');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the real server with `ticketUrl`: the chip of `ABC-12` shows ↗ and its click opens the ticket; ✎ opens the group dialog; a group `a/b?c` (pattern `^\\S+`) is no link, the chip plain text',
    async (t) => {
      const l = await withGh(
        t,
        chromium,
        { hold: 'held' },
        {
          ticketUrl: TICKETS,
          groupPattern: '^\\S+',
        },
      );
      l.d.resumable(S1);
      setLabel(l.d.deck, S1, 'ABC-12 try');
      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .header-group', /^ABC-12 ↗$/);
      await l.page.locator('#cards .header-group').click();
      await opened(l, 'https://tickets.example/browse/ABC-12');
      assert.equal((await dialog(l.page)).shown, false, 'the chip never edits');

      await l.page.locator('#cards .header-group-edit').click();
      await dialogShown(l.page, true);
      assert.match((await dialog(l.page)).heading, /^Group — ABC-12 try$/);
      await l.page.keyboard.type('a/b?c');
      await l.page.keyboard.press('Enter');
      await dialogShown(l.page, false);
      await showsText(l.page, '#cards .header-group', /^a\/b\?c$/);
      assert.equal(await l.page.getAttribute('#cards .header-group', 'data-link'), 'false');
      const calls = l.d.edgeCalls().length;
      await l.page.locator('#cards .header-group').click();
      await sleep(500);
      assert.equal(l.d.edgeCalls().length, calls, 'plain text opens nothing');
      assert.equal((await dialog(l.page)).shown, false);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the real server without `ticketUrl`: the chip is plain text and only ✎ edits; with no group `+ group` opens the group dialog; the note’s line shows its first line sanitised and its click opens the dialog with the whole note',
    async (t) => {
      const l = await withGh(t, chromium);
      l.d.resumable(S1);
      l.d.resumable(S2, join(l.d.s.home, 'other'));
      setLabel(l.d.deck, S1, 'ABC-12 try');
      const note = 'first \x1b[31mred\x1b[0m line\nsecond\n\nfourth';
      setNote(l.d.deck, S2, note);
      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .header-group', /^ABC-12$/);
      await l.page.locator('#cards .header-group').click();
      await sleep(500);
      assert.deepEqual(l.d.edgeCalls(), [], 'no link');
      assert.equal((await dialog(l.page)).shown, false, 'the chip never edits');
      await l.page.locator('#cards .header-group-edit').click();
      await dialogShown(l.page, true);
      assert.match((await dialog(l.page)).heading, /^Group — /);
      await l.page.keyboard.press('Escape');
      await dialogShown(l.page, false);

      await clickRow(l.page, S2);
      await showsText(l.page, '#cards .header-note-text', /^first red line …$/);
      assert.deepEqual(await texts(l.page, '#cards .header-group-add'), ['+ group']);
      await l.page.locator('#cards .header-group-add').click();
      await dialogShown(l.page, true);
      assert.match((await dialog(l.page)).heading, /^Group — /);
      await l.page.keyboard.press('Escape');
      await dialogShown(l.page, false);
      await showsText(l.page, '#cards .card-command', /--resume/); // its `selected` has come
      await l.page.locator('#cards .header-note-text').click();
      await dialogShown(l.page, true);
      const shown = await dialog(l.page);
      assert.match(shown.heading, /^Note — /);
      assert.equal(shown.value, note);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the real server: Done marks the session done, with the toast, and its Undo brings it back; a running session’s Done keeps it under Open marked done, the button then says Undone',
    async (t) => {
      const l = await withGh(t, chromium);
      l.d.resumable(S1);
      l.d.resumable(S2, join(l.d.s.home, 'other'));
      await resumeFromList(l.page, S2);
      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .header-done', /^Done$/);
      await l.page.locator('#cards .header-done').click();
      await eventually(async () => (await toast(l.page)).text === DONE_WORDS, 'the toast');
      await eventually(
        async () => (await l.page.locator(`#list [data-id="${S1}"]`).count()) === 0,
        'S1 hidden from the list',
      );
      assert.notEqual(l.d.deck.store.meta(S1)?.doneAtNs ?? null, null);
      await l.page.locator('#toast .toast-undo').click();
      await eventually(
        async () => (await l.page.locator(`#list [data-id="${S1}"]`).count()) === 1,
        'S1 back in the list',
      );
      assert.equal(l.d.deck.store.meta(S1)?.doneAtNs ?? null, null);

      await clickRow(l.page, S2);
      await showsText(l.page, '#cards .header-done', /^Done$/);
      await l.page.locator('#cards .header-done').click();
      await eventually(async () => (await toast(l.page)).text === DONE_RUNNING_WORDS, 'the toast');
      await showsText(l.page, '#cards .header-done', /^Undone$/);
      assert.deepEqual(await sectionRows(l.page, 'open'), [S2]);
      await showsText(l.page, `#list [data-id="${S2}"]`, /done/);
      assert.equal(await selectedRow(l.page), S2);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the real server, a quiet page: `d` on a row of This week selects the next row of This week (the order of `list` and `result`, ruled 06:38Z)',
    async (t) => {
      const l = await withGh(t, chromium);
      for (const id of [S1, S2, S3, S4]) l.d.resumable(id);
      await eventually(async () => (await sectionRows(l.page, 'week')).length === 4, 'four rows');
      const order = await sectionRows(l.page, 'week');
      await clickRow(l.page, order[1] as string);
      await showsText(l.page, '#cards .card-command', /--resume/); // its `selected` has come
      await l.page.keyboard.press('d');
      await eventually(async () => (await selectedRow(l.page)) === order[2], 'the next row');
      assert.deepEqual(await sectionRows(l.page, 'week'), [order[0], order[2], order[3]]);
      assert.equal(await keyMessage(l.page), '');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the real server: the page reports no problem with the header and both dialogs shown',
    async (t) => {
      const l = await withGh(t, chromium);
      l.d.resumable(S1);
      await clickRow(l.page, S1);
      await showsText(l.page, '#cards .header-prs-button', /^\+ PR$/);
      await l.page.locator('#cards .header-prs-button').click();
      await dialogShown(l.page, true);
      await l.page.keyboard.press('Escape');
      await dialogShown(l.page, false);
      assert.equal(await shownText(l.page, '#key-message'), '');
      assert.deepEqual(l.problems, []);
    },
  );
});
