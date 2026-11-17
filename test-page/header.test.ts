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
/** S2 9.6: what opens a link in the Windows default browser (window.links "default"). */
const RUNDLL32_EXE = '/mnt/c/Windows/System32/rundll32.exe';

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
      closedStacks: [],
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
  /** Each open pull request of line 3: shown whole inside the items' box, inside it with an
   *  ellipsis (one wider than the box alone), left out of it, or cut by its edge. */
  items: ('whole' | 'ellipsis' | 'out' | 'cut')[];
  /** The widths of the title, the group chip and the state on line 1. */
  widths: { title: number; group: number; state: number };
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
    const itemsBox = (
      head.querySelector('.header-pr-items') as HTMLElement
    ).getBoundingClientRect();
    const items = [...head.querySelectorAll<HTMLElement>('.header-pr')].map((item) => {
      const r = item.getBoundingClientRect();
      const inside =
        r.left >= itemsBox.left - 0.5 &&
        r.right <= itemsBox.right + 0.5 &&
        r.top >= itemsBox.top - 0.5 &&
        r.bottom <= itemsBox.bottom + 0.5;
      const out = r.top >= itemsBox.bottom - 0.5 || r.left >= itemsBox.right - 0.5;
      return inside
        ? item.scrollWidth <= item.clientWidth
          ? ('whole' as const)
          : ('ellipsis' as const)
        : out
          ? ('out' as const)
          : ('cut' as const);
    });
    const width = (selector: string): number =>
      (head.querySelector(selector) as HTMLElement).getBoundingClientRect().width;
    return {
      items,
      widths: {
        title: width('.header-title'),
        group: width('.header-group'),
        state: width('.header-state'),
      },
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
          // The open pull requests as far as they fit: each shown whole, or left out whole.
          assert.ok(!m.items.includes('cut'), `${where}: no item is cut (${m.items.join(' ')})`);
          assert.ok(
            !m.items.slice(1).includes('ellipsis'),
            `${where}: only a first item wider than the line alone ends in an ellipsis`,
          );
          if (m.items.length > 0) assert.notEqual(m.items[0], 'out', `${where}: the first item`);
          // Line 1 short of room: the title, the chip and the state each keep a share.
          for (const [part, px] of Object.entries(m.widths)) {
            if (part !== 'group' || shown['group'] !== null) {
              assert.ok(px >= 40, `${where}: the ${part} keeps ${px} px`);
            }
          }
        }
        // Eight long ones do not fit on the line: some are left out (whole).
        assert.ok((await measure(s.page)).items.includes('out'), `at ${width} px: some left out`);
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
          week: [
            row(S2, { title: 'plain', titleSource: 'generated' }),
            row(S3, { title: 'only merged', ...prsOf([pr(5, 'merged'), pr(6, 'merged')]) }),
          ],
        },
        terminals: [terminal(TERM_A, S1, 1, { openedNs: '1741064760000000000' })],
      });
      const { page, w } = s;
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
      // D17: a drag over the link selects it and opens nothing; a click opens it.
      const chip = await page.locator('#cards .header-group').boundingBox();
      assert.ok(chip !== null);
      await page.mouse.move(chip.x + 1, chip.y + chip.height / 2);
      await page.mouse.down();
      await page.mouse.move(chip.x + chip.width - 1, chip.y + chip.height / 2, { steps: 6 });
      await page.mouse.up();
      await sleep(300);
      assert.notEqual(await page.evaluate(() => getSelection()?.toString() ?? ''), '');
      assert.deepEqual(w.acts(), [], 'a drag over the link opens nothing');
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await page.locator('#cards .header-group').click();
      const opened = await eventually(async () => w.acts()[0] ?? null, 'the link opened');
      assert.deepEqual(
        [opened['kind'], opened['url']],
        ['open-link', 'https://tickets.example/browse/ORB-7'],
      );

      // Only merged ones attached: none is open, but some are attached — the chip `2 merged`,
      // the button `Pull requests`, no hint.
      await clickRow(page, S3);
      await showsText(page, '#cards .header-title', /^only merged$/);
      assert.deepEqual(await texts(page, '#cards .header-chip'), ['2 merged']);
      assert.deepEqual(await texts(page, '#cards .header-pr'), []);
      assert.deepEqual(await texts(page, '#cards .header-prs-none'), []);
      assert.deepEqual(await texts(page, '#cards .header-prs-button'), ['Pull requests']);

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
      // A list that changes another of the header's texts keeps the selection (set when changed).
      s.set({
        sections: { week: [row(S1, { title: 'select this title', dir: '/u/b' }), row(S2)] },
      });
      await showsText(page, '#cards .header-dir', /^\/u\/b$/);
      assert.match(await page.evaluate(() => getSelection()?.toString() ?? ''), /select this/);
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

  await t.test(
    "refusals and waits (plan D 2.5, D13, D17): a drag over a pull request or the note's line opens nothing; a refused link of the header is a line in the key bar; in the dialog a refused link, × and ↻ show under the field, × and ↻ send one act while it waits, × from the keyboard leaves the keyboard in the field, a refusal after the dialog closed is the toast `not saved: …` (a line's link and ×); the fold is closed at every open",
    async (t) => {
      const s = await scripted(t, chromium, {
        sections: {
          week: [
            row(S1, {
              hasNote: true,
              noteHead: ['a note to select'],
              ...prsOf([pr(7, 'checks-failing'), pr(8, 'merged')]),
            }),
          ],
        },
      });
      const { page, w } = s;
      const actsOf = (kind: string): Row[] => w.acts().filter((act) => act['kind'] === kind);
      const drag = async (selector: string): Promise<void> => {
        const box = await page.locator(selector).first().boundingBox();
        assert.ok(box !== null, selector);
        await page.mouse.move(box.x + 1, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
        await page.mouse.up();
        await sleep(300);
        assert.notEqual(await page.evaluate(() => getSelection()?.toString() ?? ''), '', selector);
        await page.evaluate(() => getSelection()?.removeAllRanges());
      };
      await showsAll(page, '#cards .header-pr', ['acme/web #7 · failing']);
      await drag('#cards .header-pr');
      await drag('#cards .header-note-text');
      assert.deepEqual(w.acts(), [], 'a drag opens nothing');
      assert.equal((await dialog(page)).shown, false);

      await page.locator('#cards .header-pr').click();
      const link = await eventually(async () => actsOf('open-link')[0] ?? null, 'open-link');
      assert.equal(link['url'], PR7);
      w.answer(link, { ok: false, error: 'skydeck does not open that link' });
      await showsText(page, '#key-message', /^skydeck does not open that link$/);

      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await page.locator('#editor .edit-pr-text').first().click();
      const lineLink = await eventually(async () => actsOf('open-link')[1] ?? null, 'the line');
      assert.equal(lineLink['url'], PR7);
      w.answer(lineLink, { ok: false, error: 'not that one' });
      await eventually(async () => (await dialog(page)).message === 'not that one', 'shown');

      const remove = page.locator('#editor .edit-pr-remove').first();
      await remove.click();
      await remove.click({ force: true }); // disabled while its answer waits
      await sleep(300);
      assert.equal(actsOf('pr-rm').length, 1, 'one pr-rm while it waits');
      w.answer(actsOf('pr-rm')[0] as Row, { ok: false, error: `${PR7} is not attached` });
      await eventually(
        async () => (await dialog(page)).message === `${PR7} is not attached`,
        "×'s refusal",
      );
      const refresh = page.locator('#editor .edit-pr-refresh');
      await refresh.click();
      await refresh.click({ force: true });
      await sleep(300);
      assert.equal(actsOf('pr-refresh').length, 1, 'one pr-refresh while it waits');
      assert.equal(actsOf('pr-refresh')[0]?.['sessionId'], S1);
      w.answer(actsOf('pr-refresh')[0] as Row, { ok: false, error: "skydeck's database is busy" });
      await eventually(
        async () => (await dialog(page)).message === "skydeck's database is busy",
        "↻'s refusal",
      );

      // × pressed from the keyboard: the keyboard goes back to the field, the toast follows.
      await page.focus('#editor .edit-pr-remove');
      await page.keyboard.press('Enter');
      await eventually(async () => actsOf('pr-rm').length === 2, 'the second pr-rm');
      assert.ok((await dialog(page)).inField, 'the keyboard is in the field');
      w.answer(actsOf('pr-rm')[1] as Row, { ok: true });
      await eventually(async () => (await toast(page)).text === 'Detached acme/web #7', 'toast');
      // This stand-in sends no list without the line, so its × stays disabled (C2) — until the
      // toast's Undo attaches it again.
      assert.equal(await remove.isDisabled(), true, '× disabled until the list without the line');
      await page.locator('#toast .toast-undo').click();
      const add = await eventually(async () => actsOf('pr-add')[0] ?? null, "Undo's pr-add");
      assert.equal(add['url'], PR7);
      w.answer(add, { ok: true });
      await eventually(async () => !(await remove.isDisabled()), '× enabled again');

      // A refusal after the dialog closed: the toast — of a line's link (review 1) and of ×.
      await page.locator('#editor .edit-pr-text').first().click();
      const closedLink = await eventually(async () => actsOf('open-link')[2] ?? null, 'a link');
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      w.answer(closedLink, { ok: false, error: 'no such link' });
      await eventually(async () => (await toast(page)).text === 'not saved: no such link', 'toast');
      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await remove.click();
      await eventually(async () => actsOf('pr-rm').length === 3, 'the third pr-rm');
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      w.answer(actsOf('pr-rm')[2] as Row, { ok: false, error: 'it went' });
      await eventually(async () => (await toast(page)).text === 'not saved: it went', 'toast');

      // The fold: open, closed by the next open.
      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await page.locator('#editor .edit-pr-fold').click();
      await showsAll(page, '#editor .edit-pr-fold', ['1 merged ▾']);
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await showsAll(page, '#editor .edit-pr-fold', ['1 merged ▸']);
      assert.deepEqual(await prLines(page), ['acme/web #7 · checks failing · checked 4m ago']);
    },
  );

  await t.test(
    "review 2's M1, C2, S1, C1: a double click on × detaches one pull request, whether the list or the answer comes first, and × stays disabled until the list without its line; a drag held over a line whose age counts seconds keeps its selection and opens nothing; ↻ from the keyboard leaves the keyboard in the field",
    async (t) => {
      const three = [pr(7, 'draft'), pr(8, 'draft'), pr(9, 'draft')];
      const s = await scripted(t, chromium, { sections: { week: [row(S1, prsOf(three))] } });
      const { page, w } = s;
      const rms = (): Row[] => w.acts().filter((act) => act['kind'] === 'pr-rm');
      const withPrs = (prs: Row[]): void => s.set({ sections: { week: [row(S1, prsOf(prs))] } });
      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await eventually(async () => (await prLines(page)).length === 3, 'three lines');
      const first = await page.locator('#editor .edit-pr-remove').first().boundingBox();
      assert.ok(first !== null);
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);

      // The list that removes the line comes before the answer: the next line's × is under the
      // pointer when the second click of the double click comes.
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await eventually(async () => rms().length === 1, 'the first pr-rm');
      withPrs([three[1] as Row, three[2] as Row]);
      await eventually(async () => (await prLines(page)).length === 2, 'its line gone');
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await sleep(300);
      assert.deepEqual(
        rms().map((act) => act['url']),
        [PR7],
        'the second click detaches nothing',
      );
      w.answer(rms()[0] as Row, { ok: true });
      await eventually(async () => (await toast(page)).text === 'Detached acme/web #7', 'toast');

      // The answer comes before the list: the second click, and a slow third one, send nothing
      // while the line is still shown; it goes with the list.
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await eventually(async () => rms().length === 2, 'the second pr-rm');
      w.answer(rms()[1] as Row, { ok: true });
      await eventually(async () => (await toast(page)).text === 'Detached acme/web #8', 'toast');
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await sleep(600);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await sleep(300);
      assert.equal(rms().length, 2, 'nothing more is detached');
      assert.equal((await dialog(page)).message, '', 'and nothing is refused');
      withPrs([three[2] as Row]);
      await eventually(async () => (await prLines(page)).length === 1, 'the line goes');

      // A line whose age counts seconds: a drag held over a tick keeps its selection, opens nothing.
      withPrs([pr(9, 'draft', { okAtNs: String(NOW_NS - 5n * SEC_NS) })]);
      await showsAll(page, '#editor .edit-pr-text', ['acme/web #9 · draft · checked 5s ago']);
      const line = await page.locator('#editor .edit-pr-text').boundingBox();
      assert.ok(line !== null);
      await page.mouse.move(line.x + 1, line.y + line.height / 2);
      await page.mouse.down();
      await page.mouse.move(line.x + line.width - 1, line.y + line.height / 2, { steps: 6 });
      await sleep(1200);
      await page.mouse.up();
      await sleep(1200);
      assert.match(
        await page.evaluate(() => getSelection()?.toString() ?? ''),
        /acme\/web #9 · draft · checked/,
        'the selection is kept',
      );
      assert.deepEqual(
        w.acts().filter((act) => act['kind'] === 'open-link'),
        [],
        'the drag opens nothing',
      );
      // Without the selection the age counts on again.
      await page.evaluate(() => getSelection()?.removeAllRanges());
      const frozen = (await prLines(page))[0] ?? '';
      await eventually(async () => {
        const now = (await prLines(page))[0] ?? '';
        return now !== frozen && /^acme\/web #9 · draft · checked \d+s ago$/.test(now);
      }, 'the age repainted');

      // ↻ pressed from the keyboard: the keyboard goes back to the field.
      await page.focus('#editor .edit-pr-refresh');
      await page.keyboard.press('Enter');
      const refresh = await eventually(
        async () => w.acts().find((act) => act['kind'] === 'pr-refresh') ?? null,
        'pr-refresh',
      );
      assert.ok((await dialog(page)).inField, 'the keyboard is in the field');
      w.answer(refresh, { ok: true });
    },
  );

  await t.test(
    "review 2's round 2, S1: with the field holding the keyboard, a press on a line held 2.5 s keeps its text, and the drag that follows selects it and opens nothing; a list during a press fills its new lines; a drag that ends in `dragend` lets the lines count on",
    async (t) => {
      const s = await scripted(t, chromium, {
        sections: {
          week: [
            row(
              S1,
              prsOf([pr(7, 'draft', { okAtNs: String(NOW_NS - 5n * SEC_NS) }), pr(8, 'merged')]),
            ),
          ],
        },
      });
      const { page, w } = s;
      await page.locator('#cards .header-prs-button').click();
      await dialogShown(page, true);
      await eventually(async () => (await prLines(page)).length === 1, 'a line');
      assert.ok((await dialog(page)).inField, 'the field has the keyboard (D2)');
      const line = await page.locator('#editor .edit-pr-text').first().boundingBox();
      assert.ok(line !== null);
      const y = line.y + line.height / 2;
      await page.mouse.move(line.x + 30, y);
      await page.mouse.down();
      const atPress = (await prLines(page))[0];
      // Long enough for the age to pass at least one more whole second.
      await sleep(2500);
      assert.equal((await prLines(page))[0], atPress, 'not drawn again while the button is down');
      await page.mouse.move(line.x + line.width - 2, y, { steps: 6 });
      await page.mouse.up();
      await sleep(300);
      assert.match(await page.evaluate(() => getSelection()?.toString() ?? ''), /draft · checked/);
      assert.deepEqual(
        w.acts().filter((act) => act['kind'] === 'open-link'),
        [],
        'the drag opens nothing',
      );
      await page.evaluate(() => getSelection()?.removeAllRanges());

      // A press on the fold (a button) while a list brings another line: the new line is filled.
      const fold = await page.locator('#editor .edit-pr-fold').boundingBox();
      assert.ok(fold !== null);
      await page.mouse.move(fold.x + fold.width / 2, fold.y + fold.height / 2);
      await page.mouse.down();
      s.set({
        sections: {
          week: [
            row(
              S1,
              prsOf([
                pr(6, 'draft'),
                pr(7, 'draft', { okAtNs: String(NOW_NS - 5n * SEC_NS) }),
                pr(8, 'merged'),
              ]),
            ),
          ],
        },
      });
      await eventually(async () => (await prLines(page)).length === 2, 'two lines');
      assert.ok(
        (await prLines(page)).every((text) => text !== ''),
        `no empty line while the button is down: ${JSON.stringify(await prLines(page))}`,
      );
      // A drag and drop ends with `dragend` and no `mouseup`: the lines count on after it.
      const before = (await prLines(page))[1] ?? '';
      await page.evaluate(() => dispatchEvent(new DragEvent('dragend')));
      await eventually(async () => ((await prLines(page))[1] ?? '') !== before, 'counted on');
      await page.mouse.up();
    },
  );

  await t.test(
    "review 2's round 2, S5 and C3: a × whose line a list no longer holds is forgotten, so the line attached again has a × that acts; a × answered after its dialog closed, or answered and then closed before its list, is forgotten too",
    async (t) => {
      const seven = pr(7, 'draft');
      const eight = pr(8, 'draft');
      const s = await scripted(t, chromium, {
        sections: { week: [row(S1, prsOf([seven, eight]))] },
      });
      const { page, w } = s;
      const rms = (): Row[] => w.acts().filter((act) => act['kind'] === 'pr-rm');
      const withPrs = (prs: Row[]): void => s.set({ sections: { week: [row(S1, prsOf(prs))] } });
      const removeOf = (n: number): ReturnType<Page['locator']> =>
        page.locator('#editor .edit-pr', { hasText: `#${n} ·` }).locator('.edit-pr-remove');
      const open = async (): Promise<void> => {
        await page.locator('#cards .header-prs-button').click();
        await dialogShown(page, true);
      };
      await open();
      await eventually(async () => (await prLines(page)).length === 2, 'two lines');

      // S5: × of #7, its ok, the list without it, then a list that holds it again.
      await removeOf(7).click();
      await eventually(async () => rms().length === 1, 'pr-rm');
      w.answer(rms()[0] as Row, { ok: true });
      withPrs([eight]);
      await eventually(async () => (await prLines(page)).length === 1, '#7 gone');
      withPrs([seven, eight]);
      await eventually(async () => (await prLines(page)).length === 2, '#7 back');
      assert.equal(await removeOf(7).isDisabled(), false, 'its × acts');

      // C3: × of #7 answered before any list, then Esc; attached again elsewhere (the lists still
      // hold it): opened again, its × acts.
      await removeOf(7).click();
      await eventually(async () => rms().length === 2, 'pr-rm');
      w.answer(rms()[1] as Row, { ok: true });
      await eventually(async () => removeOf(7).isDisabled(), 'disabled until its list');
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      await open();
      assert.equal(await removeOf(7).isDisabled(), false, 'forgotten at the close');

      // C3: × of #8, Esc before its answer, then ok: opened again, its × acts.
      await removeOf(8).click();
      await eventually(async () => rms().length === 3, 'pr-rm');
      await page.keyboard.press('Escape');
      await dialogShown(page, false);
      w.answer(rms()[2] as Row, { ok: true });
      await eventually(async () => (await toast(page)).text === 'Detached acme/web #8', 'toast');
      await open();
      assert.equal(await removeOf(8).isDisabled(), false, 'forgotten at its ok');
    },
  );

  await t.test(
    "review 2's S6: a double click on the header's Done of a running session marks it done once, also when the list with `done` and the answer come before its second click (D15: the first click only)",
    async (t) => {
      const shown = running(S1, TERM_A, 1);
      const s = await scripted(t, chromium, {
        sections: { open: [shown] },
        terminals: [terminal(TERM_A, S1, 1)],
      });
      const { page, w } = s;
      const marks = (): Row[] =>
        w.acts().filter((act) => act['kind'] === 'done' || act['kind'] === 'undone');
      await showsText(page, '#cards .header-done', /^Done$/);
      const done = await page.locator('#cards .header-done').boundingBox();
      assert.ok(done !== null);
      await page.mouse.move(done.x + done.width / 2, done.y + done.height / 2);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await eventually(async () => marks().length === 1, 'done sent');
      // The real server's order: the list that shows the write, then the answer — both before the
      // second click of the double click, which then finds a done row.
      s.set({ sections: { open: [{ ...shown, done: true }] } });
      await showsText(page, '#cards .header-done', /^Undone$/);
      w.answer(marks()[0] as Row, { ok: true });
      await eventually(async () => (await toast(page)).text === DONE_RUNNING_WORDS, 'the toast');
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await sleep(300);
      assert.deepEqual(
        marks().map((act) => act['kind']),
        ['done'],
        'the second click of the double click sends nothing',
      );
      assert.deepEqual(await texts(page, '#cards .header-done'), ['Undone']);
      // A fresh click acts: Undone.
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await eventually(async () => marks().length === 2, 'undone sent');
      assert.equal(marks()[1]?.['kind'], 'undone');
    },
  );

  await t.test(
    "review 2's S2: Enter held on the header's Note button opens the note dialog and its repeats type nothing into the note; a fresh Enter does (the key that opened a dialog, S2 12.9)",
    async (t) => {
      const s = await scripted(t, chromium, {
        sections: { week: [row(S1, { hasNote: true, noteHead: ['kept'] })] },
        selected: { [S1]: { note: 'kept' } },
      });
      const { page } = s;
      await showsText(page, '#cards .card-command', /--resume/); // its `selected` has come
      const cdp = await page.context().newCDPSession(page);
      const enter = async (type: 'keyDown' | 'keyUp', autoRepeat = false): Promise<void> => {
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          ...(type === 'keyDown' ? { text: '\r', autoRepeat } : {}),
        });
      };
      await page.focus('#cards .header-note-button');
      await enter('keyDown');
      await dialogShown(page, true);
      assert.equal((await dialog(page)).value, 'kept');
      for (let i = 0; i < 3; i++) await enter('keyDown', true);
      await enter('keyUp');
      await sleep(200);
      assert.equal((await dialog(page)).value, 'kept', 'the repeats typed nothing');
      await enter('keyDown');
      await enter('keyUp');
      await eventually(async () => (await dialog(page)).value === 'kept\n', 'a fresh Enter');
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
    'the real server with window.links "default": a click on the header’s pull-request link starts rundll32.exe with url.dll,FileProtocolHandler and its address; the Edge stub is not run',
    async (t) => {
      // rundll32.exe is answered here and never passed on (it would open a browser on the
      // desktop); were it passed on, the A32 guard would refuse it.
      const rundll32: { args: readonly string[]; cwd: string }[] = [];
      const others: string[] = [];
      const l = await launched(t, chromium, {
        window: { links: 'default' },
        server: {
          platform: (platform) => ({
            ...platform,
            runner: ghRunner(platform.runner, { hold: 'held' }),
            processes: {
              ...platform.processes,
              startDetached(command, args, options) {
                if (command === RUNDLL32_EXE) {
                  rundll32.push({ args, cwd: options.cwd });
                  return Promise.resolve({ pid: 4_000_001, exited: new Promise(() => {}) });
                }
                others.push(command);
                return platform.processes.startDetached(command, args, options);
              },
            },
          }),
        },
      });
      const deck = l.d.deck;
      assert.equal(deck.config.window.links, 'default');
      l.d.resumable(S1);
      attach(deck, S1, PR7, read(deck, 'open', null, 'failing'));
      await clickRow(l.page, S1);
      await showsAll(l.page, '#cards .header-pr', ['acme/web #7 · failing']);
      await l.page.locator('#cards .header-pr').first().click();
      await eventually(async () => rundll32.length > 0, 'rundll32.exe started');
      assert.deepEqual(rundll32, [{ args: ['url.dll,FileProtocolHandler', PR7], cwd: l.d.cDrive }]);
      assert.ok(!others.includes(deck.config.window.edge), 'the Edge stub was not started');
      await sleep(500);
      assert.deepEqual(l.d.edgeCalls(), []);
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
    'the real server, a quiet page: `d` on a row of Recent selects the next row of Recent (the order of `list` and `result`, ruled 06:38Z)',
    async (t) => {
      const l = await withGh(t, chromium);
      for (const id of [S1, S2, S3, S4]) l.d.resumable(id);
      await eventually(async () => (await sectionRows(l.page, 'week')).length === 4, 'four rows');
      const order = await sectionRows(l.page, 'week');
      await clickRow(l.page, order[1] as string);
      await showsText(l.page, '#cards .card-command', /--resume/); // its `selected` has come
      // A quiet page: no list for more than the once-a-second rule's second, so that the server's
      // list of the write comes before the answer (review 2's S3).
      await sleep(1500);
      await mark(l.page, 'd');
      await l.page.keyboard.press('d');
      await eventually(async () => (await selectedRow(l.page)) === order[2], 'the next row');
      const since = after(await logOf(l.page), 'd').filter(
        (entry) =>
          (entry.e === 'in' && (entry.t === 'list' || entry.t === 'result')) || entry.t === 'act',
      );
      assert.deepEqual(
        since.slice(0, 3).map((entry) => `${entry.e} ${entry.t ?? ''}`),
        ['out act', 'in list', 'in result'],
        'the list of the write came before the answer',
      );
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
