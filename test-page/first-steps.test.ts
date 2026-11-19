// Follow-up F22: the window with no session at all. The list's place says so in a short muted
// text — no session here yet; start `claude` in any terminal, or one here (Ctrl+Shift+N in the app
// window, + New in a browser tab's key bar); Ctrl+Shift+H shows every key — and the right side,
// blank before, has one muted line. Shown only while the list holds no session at all: a filter or
// a chip that hides every session keeps "No session matches the filter."; gone without a reload
// when a session arrives, back when the last one is done or gone; nothing of a list with sessions
// moves. The page has web/'s real modules, on a scripted stand-in server (helpers/shell.ts) and on
// a real test server with sessions made the way step 1 sees them.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import { markDone } from '../src/sessions/meta.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  clickRow,
  connection,
  honest,
  launched,
  PAGE_WAIT_MS,
  problemsOf,
  readPage,
  scriptedList,
  showsText,
  standinServer,
  storeKey,
  toZone,
} from './helpers/shell.ts';

const HEAD = 'No session here yet.';
const IN_A_TERMINAL = 'Start claude in any terminal: it shows here as soon as it starts.';
const HERE_APP = 'Or start one here with Ctrl+Shift+N.';
const HERE_TAB = 'Or start one here with + New in the key bar.';
const KEYS = 'Ctrl+Shift+H shows every key.';
/** The note as a browser tab shows it (the suite's pages are tabs), line by line. */
const NOTE_TAB = [HEAD, IN_A_TERMINAL, HERE_TAB, KEYS].join('\n');
const NOTE_APP = [HEAD, IN_A_TERMINAL, HERE_APP, KEYS].join('\n');
const RIGHT = 'The selected session shows here.';
const NO_MATCH = 'No session matches the filter.';

const MIN = 60_000_000_000n;

/** What the page shows of F22's two texts, and how. */
interface Shown {
  /** The note's visible text (innerText), or null when it is not in the list or not shown. */
  note: string | null;
  role: string | null;
  /** The right side's line, or null when it is not shown. */
  right: string | null;
  rightRole: string | null;
  /** The filter's own empty line, or null. */
  noMatch: string | null;
  /** Every element of the two that the keyboard could reach (a control, a tabindex). */
  reachable: number;
  /** The note lies under the Open band and inside the list's body, whole, with no overflow. */
  placed: string;
}

async function shown(page: Page): Promise<Shown> {
  return readPage(
    page,
    () => {
      const visible = (element: Element | null): element is HTMLElement =>
        element instanceof HTMLElement && element.checkVisibility();
      const note = document.querySelector('#list .list-none');
      const right = document.getElementById('right-none');
      const noMatch = document.querySelector('#list .list-empty');
      const reachable = [note, right].flatMap((root) =>
        root === null
          ? []
          : [root, ...root.querySelectorAll('*')].filter(
              (element) =>
                element instanceof HTMLElement &&
                (element.tabIndex >= 0 ||
                  element.matches('a, button, input, select, textarea, [tabindex]')),
            ),
      ).length;
      let placed = 'not shown';
      if (visible(note)) {
        const body = document.querySelector('#list .list-body') as HTMLElement;
        const band = document.querySelector('#list .list-section[data-section="open"]');
        const n = note.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        const o = band?.getBoundingClientRect();
        placed =
          o === undefined || n.top < o.bottom - 0.5
            ? `not under the Open band (${n.top} < ${o?.bottom})`
            : n.left < b.left - 0.5 || n.right > b.left + body.clientWidth + 0.5
              ? `wider than the list (${n.left}–${n.right} in ${b.left}–${b.left + body.clientWidth})`
              : n.bottom > b.top + body.clientHeight + 0.5
                ? `below the list's body (${n.bottom} > ${b.top + body.clientHeight})`
                : note.scrollWidth > note.clientWidth + 0.5
                  ? `overflows (${note.scrollWidth} > ${note.clientWidth})`
                  : 'whole';
      }
      return {
        note: visible(note) ? note.innerText.trim() : null,
        role: note?.getAttribute('role') ?? null,
        right: visible(right) ? right.innerText.trim() : null,
        rightRole: right?.getAttribute('role') ?? null,
        noMatch: visible(noMatch) ? noMatch.innerText.trim() : null,
        reachable,
        placed,
      };
    },
    null,
  );
}

/** Waits until `check` holds for what `shown` reads; fails with what it read. */
async function until(page: Page, check: (s: Shown) => boolean, what: string): Promise<Shown> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const now = await shown(page);
    if (check(now)) return now;
    if (performance.now() > deadline) assert.fail(`${what}: ${JSON.stringify(now, null, 1)}`);
    await sleep(50);
  }
}

/** The boxes of every band and row of the list and of the right side's parts, rounded. */
async function boxes(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [
        ...document.querySelectorAll(
          '#list .list-filterbar, #list .list-section, #list .list-row, #list .list-footer, #cards, #cards .card-header, #terminal',
        ),
      ]
        .filter((element) => element instanceof HTMLElement && element.checkVisibility())
        .map((element) => {
          const r = element.getBoundingClientRect();
          const name = (element as HTMLElement).dataset['id'] ?? element.className;
          return `${name} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
        }),
    null,
  );
}

type Row = Record<string, unknown>;

/** A scripted list: `rows` in Recent, nothing else; `filtering` as the server says it. */
function listOf(rows: Row[], more: Row = {}): Row {
  const base = scriptedList([], []) as Row & { sections: Row[] };
  const section = (name: string, held: Row[]): Row => ({
    name,
    folded: false,
    firstNs: null,
    lastNs: null,
    count: held.length,
    rows: held,
    closedStacks: [],
  });
  return {
    ...base,
    needYou: { count: 0, order: [] },
    sections: [section('open', []), section('week', rows), section('earlier', [])],
    filtering: false,
    switcher: null,
    selectedRow: null,
    ...more,
  };
}

/** A row of Recent that is not running. */
function row(id: string, title: string): Row {
  const list = scriptedList([{ id, terminal: null, slot: null, title }], []) as {
    sections: { rows: Row[] }[];
  };
  return { ...(list.sections[0]?.rows[0] as Row) };
}

/**
 * A page on a stand-in server that answers every `view` with `answer(view)`, and any list sent
 * later with `send`.
 */
async function scripted(
  t: TestContext,
  chromium: Browser,
  answer: (view: Row) => Row,
  fill: number,
): Promise<{ page: Page; send: (list: Row) => void; problems: string[] }> {
  const secret = new Uint8Array(32).fill(fill);
  const page = await newPage(t, chromium);
  const problems = problemsOf(page);
  let send: (list: Row) => void = () => {};
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        send = (list) => conn.send(list);
        if (message['t'] === 'view') conn.send(answer(message));
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  return { page, send: (list) => send(list), problems };
}

/** A session last active `agoNs` before now, as step 1 sees it: a transcript with one prompt. */
function session(d: ServerSandbox, sessionId: string, agoNs: bigint): void {
  const dir = join(d.s.home, 'project');
  mkdirSync(dir, { recursive: true });
  const folder = join(d.s.claudeHome, 'projects', 'project');
  mkdirSync(folder, { recursive: true });
  const timestamp = isoFromNs(d.platform.clock.nowNs() - agoNs);
  writeFileSync(
    join(folder, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId, timestamp, cwd: dir, entrypoint: 'cli' })}\n`,
  );
}

/** The relative luminance of a computed `rgb(...)` colour (WCAG 2). */
function luminance(colour: string): number {
  const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
    const c = Number(part) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

test('the window with no session at all (follow-up F22)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'no session: the note under the Open band (a note, not a control), the right side has one line; the app window names Ctrl+Shift+N, a tab + New',
    async (t) => {
      const s = await scripted(t, chromium, () => listOf([]), 71);

      const now = await until(s.page, (x) => x.note !== null, 'the note');
      assert.equal(now.note, NOTE_TAB);
      assert.equal(now.role, 'note');
      assert.equal(now.right, RIGHT);
      assert.equal(now.rightRole, 'note');
      assert.equal(now.noMatch, null, "the filter's line is not shown");
      assert.equal(now.reachable, 0, 'nothing of it in the tab order, no control');
      assert.equal(now.placed, 'whole');
      // The Open band stays, with its count 0 (S2 12.1: Open is always there).
      await showsText(s.page, '#list .list-section[data-section="open"] .section-count', /^0$/);

      // The New form, opened from there, takes the right side: the line goes while the form is
      // shown (the note stays in the list), and comes back when Esc closes it.
      await s.page.locator('#new-button').click();
      await s.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      const form = await until(s.page, (x) => x.right === null, 'the line gone under the form');
      assert.equal(form.note, NOTE_TAB);
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('#right-zone[data-pane="none"]', { state: 'attached' });
      await until(s.page, (x) => x.right === RIGHT, 'the line back after Esc');

      // In the app window (not a tab) the note names the key: the page's own app-only rule.
      await s.page.evaluate(() => {
        document.documentElement.dataset['display'] = 'app';
      });
      await until(s.page, (x) => x.note === NOTE_APP, 'the app window');

      // Tab from the list goes past both texts: nothing of them takes the keyboard.
      await toZone(s.page, 'list');
      for (let n = 0; n < 12; n++) {
        await s.page.keyboard.press('Tab');
        const inside = await s.page.evaluate(
          () => document.activeElement?.closest('.list-none, #right-none') !== null,
        );
        assert.equal(inside, false, `Tab ${n + 1}: ${await active(s.page)}`);
      }
      assert.deepEqual(s.problems, []);
    },
  );

  await t.test(
    'a filter or a chip that hides every session keeps its own line, "No session matches the filter.": no note, no right-side line',
    async (t) => {
      const s = await scripted(
        t,
        chromium,
        (view) => {
          const filter = typeof view['filter'] === 'string' ? view['filter'] : '';
          const chips = Array.isArray(view['chips']) ? view['chips'] : [];
          const filtering = filter !== '' || chips.length > 0;
          return filtering ? listOf([], { filtering: true }) : listOf([row(S1, 'alpha work')]);
        },
        72,
      );
      await showsText(s.page, `#list [data-id="${S1}"]`, /alpha work/);
      assert.equal((await shown(s.page)).note, null, 'a session: no note');

      await toZone(s.page, 'list');
      await s.page.keyboard.press('/');
      await s.page.keyboard.type('zzz');
      const filtered = await until(s.page, (x) => x.noMatch !== null, 'the filter matches nothing');
      assert.equal(filtered.noMatch, NO_MATCH);
      assert.equal(filtered.note, null);
      assert.equal(filtered.right, null);

      await s.page.keyboard.press('Escape'); // clears the filter
      await showsText(s.page, `#list [data-id="${S1}"]`, /alpha work/);
      await s.page.locator('#list .list-chip[data-chip="running"]').click();
      const chipped = await until(s.page, (x) => x.noMatch !== null, 'the chip matches nothing');
      assert.equal(chipped.noMatch, NO_MATCH);
      assert.equal(chipped.note, null);
      assert.equal(chipped.right, null);
      assert.deepEqual(s.problems, []);
    },
  );

  await t.test(
    'the same list with sessions before and after the note: every band, row and part of the right side where it was; with sessions the note is not in the list and the line not shown',
    async (t) => {
      const rows = [row(S1, 'alpha work'), row(S2, 'beta work')];
      const s = await scripted(t, chromium, () => listOf(rows), 73);
      await showsText(s.page, `#list [data-id="${S2}"]`, /beta work/);
      await s.page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      await sleep(300);
      const before = await boxes(s.page);
      const withSessions = await shown(s.page);
      assert.equal(withSessions.note, null);
      assert.equal(withSessions.right, null);
      assert.equal(
        await s.page.evaluate(() => document.querySelector('#list .list-none')),
        null,
        'no element of the note in the list while it holds sessions',
      );

      s.send(listOf([]));
      await until(s.page, (x) => x.note !== null && x.right !== null, 'the last ones gone');
      s.send(listOf(rows));
      await until(s.page, (x) => x.note === null && x.right === null, 'back');
      // S1 is selected again once it is listed again (S2 12.9); the click makes the selection
      // certain, so that the right side shows what it showed.
      await clickRow(s.page, S1);
      await s.page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      await s.page.mouse.move(0, 0);
      await sleep(300);
      assert.deepEqual(await boxes(s.page), before);
      assert.deepEqual(s.problems, []);
    },
  );

  await t.test(
    'a session arriving while the right side shows nothing either way (the last one gone, then a new one; nothing is selected for the user): the note and the line go',
    async (t) => {
      const s = await scripted(t, chromium, () => listOf([row(S1, 'alpha work')]), 76);
      await s.page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });

      s.send(listOf([])); // the last one marked done, or gone: nothing selected
      await until(s.page, (x) => x.note !== null && x.right === RIGHT, 'no session');
      s.send(listOf([row(S2, 'beta work')])); // `claude` started in another terminal
      await showsText(s.page, `#list [data-id="${S2}"]`, /beta work/);
      // No list selects a session once one was selected: the right side still shows nothing,
      // and the line goes with the note.
      await s.page.waitForSelector('#right-zone[data-pane="none"]', { state: 'attached' });
      await until(s.page, (x) => x.note === null && x.right === null, 'a session again');
      await sleep(300);
      const after = await shown(s.page);
      assert.equal(after.note, null);
      assert.equal(after.right, null);
      assert.deepEqual(s.problems, []);
    },
  );

  await t.test(
    "muted and readable in light and dark, under the system's scheme and under each forced theme",
    async (t) => {
      const s = await scripted(t, chromium, () => listOf([]), 74);
      await until(s.page, (x) => x.note !== null, 'the note');
      for (const [system, forced] of [
        ['light', null],
        ['dark', null],
        ['dark', 'light'],
        ['light', 'dark'],
      ] as const) {
        await s.page.emulateMedia({ colorScheme: system });
        await s.page.evaluate((theme) => {
          if (theme === null) delete document.documentElement.dataset['theme'];
          else document.documentElement.dataset['theme'] = theme;
        }, forced);
        const colours = await readPage(
          s.page,
          () => {
            const style = (selector: string): CSSStyleDeclaration =>
              getComputedStyle(document.querySelector(selector) as Element);
            // --dim, resolved as a colour the way the page resolves it.
            const probe = document.createElement('span');
            probe.style.color = 'var(--dim)';
            document.body.append(probe);
            const dim = getComputedStyle(probe).color;
            probe.remove();
            return {
              dim,
              text: style('#list').color,
              note: style('#list .list-none').color,
              line: style('#list .list-none > *').color,
              noteFont: `${style('#list .list-none').fontFamily} ${style('#list .list-none').fontSize}`,
              listFont: `${style('#list').fontFamily} ${style('#list').fontSize}`,
              list: style('#list-zone').backgroundColor,
              right: style('#right-none').color,
              rightGround: getComputedStyle(document.body).backgroundColor,
            };
          },
          null,
        );
        const what = `${system}${forced === null ? '' : `, forced ${forced}`}`;
        assert.equal(colours.note, colours.dim, `${what}: the note in --dim`);
        assert.equal(colours.line, colours.dim, `${what}: each of its lines too`);
        assert.notEqual(colours.note, colours.text, `${what}: muted, not the text's colour`);
        assert.equal(colours.noteFont, colours.listFont, `${what}: the list's own type`);
        assert.equal(colours.right, colours.dim, `${what}: the right side's line in --dim`);
        assert.ok(
          contrast(colours.note, colours.list) >= 4.5,
          `${what}: ${JSON.stringify(colours)}`,
        );
        assert.ok(
          contrast(colours.right, colours.rightGround) >= 4.5,
          `${what}: ${JSON.stringify(colours)}`,
        );
      }
      assert.deepEqual(s.problems, []);
    },
  );

  await t.test(
    'whole in a narrow window: the list keeps its width and the note wraps inside it',
    async (t) => {
      const s = await scripted(t, chromium, () => listOf([]), 75);
      for (const [width, height] of [
        [420, 600],
        [700, 480],
      ] as const) {
        await s.page.setViewportSize({ width, height });
        const now = await until(s.page, (x) => x.note !== null, `the note at ${width}x${height}`);
        assert.equal(now.placed, 'whole', `${width}x${height}`);
        assert.equal(now.note, NOTE_TAB);
      }
      assert.deepEqual(s.problems, []);
    },
  );

  await t.test(
    'a real server: the note with no session; gone without a reload when the first session arrives (selected, its card on the right); back when the last one is marked done, with the footer',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await page.evaluate(() => Reflect.set(globalThis, 'f22SameLoad', true));

      const empty = await until(page, (x) => x.note !== null, 'no session yet');
      assert.equal(empty.note, NOTE_TAB);
      assert.equal(empty.right, RIGHT);

      session(d, S1, 2n * MIN);
      await showsText(page, `#list [data-id="${S1}"]`, /./);
      const one = await until(
        page,
        (x) => x.note === null && x.right === null,
        'the first session',
      );
      assert.equal(one.noMatch, null);
      await page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });

      markDone(d.deck, S1);
      const done = await until(page, (x) => x.note !== null, 'the last one done');
      assert.equal(done.note, NOTE_TAB);
      assert.equal(done.right, RIGHT);
      await showsText(page, '#list .list-footer', /^1 done hidden · show$/);
      assert.equal(
        await page.evaluate(() => Reflect.get(globalThis, 'f22SameLoad')),
        true,
        'no reload',
      );
      assert.deepEqual(l.problems, []);
    },
  );
});
