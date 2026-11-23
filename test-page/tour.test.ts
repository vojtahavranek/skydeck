// The tour of the window (follow-up F41, issue #162; S2 12.14): it starts by itself after the
// first list in a browser that has not seen this version of it (no mark, or the first version's
// `seen`) — with sessions and on an empty list —, never in one that has or whose storage cannot keep the mark; each step's region stands out and its panel
// says the step's words, in the app window's and in a tab's; its keys and the page under it, which
// takes no key and no click; Done, Skip and Esc mark it seen and give the keyboard back where it
// was; the key help's `Take the tour` starts it again; a lost connection ends it unmarked. On a
// scripted stand-in server (helpers/shell.ts), with the real web/; every context but these cases'
// has the tour marked seen (helpers/browser.ts `newContext`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { S1, S2 } from '../test/helpers/platform.ts';
import type { Mode, Part } from '../web/tour-text.js';
import { REGIONS, stepText, TOUR_KEY, TOUR_SEEN, tourSteps } from '../web/tour-text.js';
import { browser, newPage } from './helpers/browser.ts';
import {
  active,
  connection,
  honest,
  keyMessage,
  launched,
  readPage,
  scriptedList,
  selectedRow,
  showsText,
  shownText,
  standinServer,
  storeKey,
  TERM_A,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { Standin } from './helpers/shell.ts';
import { until } from './helpers/terminal.ts';

const WITH_SESSIONS = scriptedList(
  [
    { id: S1, terminal: TERM_A, slot: 1, title: 'the first session' },
    { id: S2, terminal: null, slot: null, title: 'the second session' },
  ],
  [{ id: TERM_A, slot: 1, sessionId: S1 }],
);
const EMPTY = scriptedList([], []);

/** F38's `update`: none known, or one being applied (its running form locks the page). */
function update(applying: boolean): Record<string, unknown> {
  return {
    checking: false,
    check: null,
    checkedAtNs: null,
    fetchedAtNs: null,
    failure: null,
    applying: applying
      ? { to: '5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80', sinceNs: '1794474000000000000' }
      : null,
    log: '/home/you/.local/state/skydeck/update.log',
    result: null,
  };
}

/** Whether F38's update dialog (its running form) shows, and whether the page is inert. */
async function updateLock(page: Page): Promise<{ shown: boolean; inert: boolean }> {
  return readPage(
    page,
    () => ({
      shown: document.getElementById('update-dialog')?.hidden === false,
      inert: (document.querySelector('.app') as HTMLElement | null)?.inert === true,
    }),
    null,
  );
}

let seed = 140;

/**
 * A page of a stand-in that sends `list` at each `view` and answers each `attach` with an empty
 * snap; opened with a stored key and connected. `tour`: the context does not mark the tour seen.
 */
async function world(
  t: TestContext,
  chromium: Browser,
  list: Record<string, unknown>,
  options: { tour?: boolean; init?: string; update?: Record<string, unknown> } = {},
): Promise<{ page: Page; standin: Standin; inputs: string[] }> {
  const page = await newPage(t, chromium, { tour: options.tour ?? true });
  /** What the page sent to a terminal (`input`), in order. */
  const inputs: string[] = [];
  if (options.init !== undefined) await page.addInitScript(options.init);
  const secret = new Uint8Array(32).fill(seed++);
  const told = new Set<unknown>();
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        if (message['t'] === 'view') {
          // F38: the server's `update` comes right after `start`, before the first list.
          if (options.update !== undefined && !told.has(conn)) {
            told.add(conn);
            conn.send({ t: 'update', update: options.update });
          }
          conn.send(list);
        } else if (message['t'] === 'attach') {
          const { term, cols, rows } = message as { term: string; cols: number; rows: number };
          conn.send({ t: 'snap', term, ch: 1, cols, rows, data: '' });
        } else if (message['t'] === 'input') {
          inputs.push(String(message['data']));
        }
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  return { page, standin, inputs };
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TourShown {
  region: string;
  step: string;
  title: string;
  lines: string[];
  count: string;
  buttons: { text: string; disabled: boolean }[];
  spot: Box;
  target: Box;
  panel: Box;
  /** What a click at the region's middle reaches: the tour's layer, not the region. */
  hit: string;
  viewport: { width: number; height: number };
  inside: boolean;
}

/** The tour as shown, or null while it is hidden. */
async function shownTour(page: Page): Promise<TourShown | null> {
  return readPage(
    page,
    (regions) => {
      const root = document.getElementById('tour');
      if (root === null || root.hidden) return null;
      const box = (element: Element | null): Box => {
        const rect = element?.getBoundingClientRect();
        return {
          left: rect?.left ?? NaN,
          top: rect?.top ?? NaN,
          width: rect?.width ?? NaN,
          height: rect?.height ?? NaN,
        };
      };
      const region = root.dataset['region'] ?? '';
      const target = document.querySelector(regions[region as keyof typeof regions] ?? '');
      const at = box(target);
      const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
      const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '';
      return {
        region,
        step: root.dataset['step'] ?? '',
        title: text('.tour-title'),
        lines: [...root.querySelectorAll('.tour-line')].map((line) => line.textContent ?? ''),
        count: text('.tour-count'),
        buttons: [...root.querySelectorAll('.tour-foot button')].map((one) => ({
          text: one.textContent ?? '',
          disabled: (one as HTMLButtonElement).disabled,
        })),
        spot: box(root.querySelector('.tour-spot')),
        target: at,
        panel: box(root.querySelector('.tour-panel')),
        hit: hit?.className ?? '',
        viewport: { width: innerWidth, height: innerHeight },
        inside: root.contains(document.activeElement),
      };
    },
    REGIONS,
  );
}

async function tourStep(page: Page, step: number): Promise<TourShown> {
  let shown: TourShown | null = null;
  await until(async () => {
    shown = await shownTour(page);
    return shown?.step === String(step);
  }, `the tour shows step ${step}`);
  return shown as unknown as TourShown;
}

/** Whether `.app`, the page under the tour, is inert. */
async function inert(page: Page): Promise<boolean> {
  return readPage(page, () => (document.querySelector('.app') as HTMLElement).inert, null);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function tourHidden(page: Page): Promise<void> {
  await page.waitForSelector('#tour[hidden]', { state: 'attached' });
}

/** The page's storage mark of the tour (null: none). */
async function mark(page: Page): Promise<string | null> {
  return readPage(page, (key) => localStorage.getItem(key), TOUR_KEY);
}

/** A step's lines as the panel shows them. */
const textOf = (line: Part[]): string =>
  line
    .map((part) =>
      typeof part === 'string'
        ? part
        : 'key' in part
          ? part.key
          : 'typed' in part
            ? part.typed
            : part.ui,
    )
    .join('');

/** The list has drawn its rows (or its note on an empty list): the first list came. */
async function listed(page: Page, empty: boolean): Promise<void> {
  if (empty) {
    await showsText(page, '#list', /No session here yet\./);
  } else {
    await page.waitForSelector(`#list [data-id="${S1}"]`, { state: 'attached' });
  }
}

/** Walks every step with `Next` and checks each against tourSteps(mode); ends with Done. */
async function walk(page: Page, mode: Mode): Promise<void> {
  const steps = tourSteps(mode);
  for (const [index, step] of steps.entries()) {
    const shown = await tourStep(page, index + 1);
    const label = `${mode} step ${index + 1}`;
    assert.equal(shown.region, step.region, label);
    assert.equal(shown.title, step.title, label);
    assert.deepEqual(shown.lines, step.lines.map(textOf), label);
    assert.equal(shown.count, stepText(index + 1, steps.length), label);
    const last = index === steps.length - 1;
    assert.deepEqual(
      shown.buttons,
      [
        { text: 'Skip the tour', disabled: false },
        { text: 'Back', disabled: index === 0 },
        { text: last ? 'Done' : 'Next', disabled: false },
      ],
      label,
    );
    // The region stands out: the ring lies on it exactly, and a click there reaches the tour's
    // layer, not the page.
    for (const side of ['left', 'top', 'width', 'height'] as const) {
      assert.ok(
        Math.abs(shown.spot[side] - shown.target[side]) < 1,
        `${label}: the ring's ${side}`,
      );
    }
    assert.ok(shown.target.width > 0 && shown.target.height > 0, `${label}: a region laid out`);
    assert.equal(shown.hit, 'tour-scrim', label);
    // The panel lies beside it, inside the window, and has the keyboard.
    const { panel, target, viewport } = shown;
    assert.ok(panel.left >= 0 && panel.top >= 0, `${label}: inside`);
    assert.ok(panel.left + panel.width <= viewport.width, `${label}: inside`);
    assert.ok(panel.top + panel.height <= viewport.height, `${label}: inside`);
    const overlaps =
      panel.left < target.left + target.width &&
      target.left < panel.left + panel.width &&
      panel.top < target.top + target.height &&
      target.top < panel.top + panel.height;
    assert.ok(!overlaps, `${label}: the panel beside the region, not over it`);
    assert.ok(shown.inside, `${label}: the keyboard in the panel`);
    await page.locator('#tour .tour-next').click();
  }
  await tourHidden(page);
}

/** Every control a step names is one of the page, with the step's words, in this mode. */
async function controlsHold(page: Page, mode: Mode): Promise<void> {
  const controls = tourSteps(mode)
    .flatMap((step) => step.lines.flat())
    .filter((part): part is { ui: string; at: string } => typeof part !== 'string' && 'ui' in part);
  assert.ok(controls.length >= 5);
  for (const { ui, at } of controls) {
    if (at === '#focus-zone') {
      // The key bar shows one of its two words at a time: each, in its zone.
      await toZone(page, ui === 'Focus: list' ? 'list' : 'terminal');
      assert.equal(await zone(page), ui);
      continue;
    }
    const found = await readPage(
      page,
      (at) => {
        const element = document.querySelector(at);
        if (!(element instanceof HTMLElement)) return null;
        return {
          words: [
            element.textContent?.trim() ?? '',
            element.getAttribute('aria-label') ?? '',
            element.title,
          ],
          // A control of the help lies in the help, shown on Ctrl+Shift+H; the others are shown.
          shown: element.closest('#help') !== null || element.checkVisibility(),
        };
      },
      at,
    );
    assert.ok(found !== null, `${ui}: ${at} is on the page`);
    assert.ok(
      found.words.some((words) => words.includes(ui)),
      `${ui}: ${JSON.stringify(found.words)}`,
    );
    assert.ok(found.shown, `${ui}: shown in the ${mode} mode`);
  }
}

/** Opens the key help and presses its `Take the tour`. */
async function fromHelp(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+H');
  await page.waitForSelector('#help:not([hidden])');
  await page.locator('#help .help-tour').click();
}

test('the tour of the window', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'A1: in a browser that has not seen it, the tour starts after the first list, with sessions and on an empty list; Done marks it seen, and the next load shows none',
    async (t) => {
      const { page } = await world(t, chromium, WITH_SESSIONS);
      await listed(page, false);
      const shown = await tourStep(page, 1);
      assert.equal(shown.region, 'list');
      assert.equal(await mark(page), null, 'not seen while it shows');
      // It runs over the real page: the list's rows are there under it.
      assert.equal(await selectedRow(page), S1);
      await walk(page, 'tab');
      assert.equal(await mark(page), TOUR_SEEN);
      await page.reload();
      await connection(page, 'open');
      await listed(page, false);
      assert.equal(await shownTour(page), null, 'seen: not again');

      const empty = await world(t, chromium, EMPTY);
      await listed(empty.page, true);
      await tourStep(empty.page, 1);
      await empty.page.keyboard.press('Escape');
      await tourHidden(empty.page);
      assert.equal(await mark(empty.page), TOUR_SEEN);
    },
  );

  await t.test(
    'A2: a browser marked with the first version’s `seen` sees the tour by itself once more, its old mark kept while it shows; Done marks the current version, and a reload shows none',
    async (t) => {
      // Marked `seen` at its first load only, so that the reload below keeps what Done wrote.
      const old = `try { if (localStorage.getItem('${TOUR_KEY}') === null) localStorage.setItem('${TOUR_KEY}', 'seen'); } catch {}`;
      const { page } = await world(t, chromium, WITH_SESSIONS, { init: old });
      await listed(page, false);
      await tourStep(page, 1);
      assert.equal(await mark(page), 'seen', 'the old mark is not touched while it shows');
      await walk(page, 'tab');
      assert.equal(await mark(page), TOUR_SEEN, 'Done writes the current version');
      assert.notEqual(TOUR_SEEN, 'seen');
      await page.reload();
      await connection(page, 'open');
      await listed(page, false);
      assert.equal(await shownTour(page), null, 'the current mark: not again');
    },
  );

  await t.test(
    'A2: a browser that holds the current mark sees no tour by itself, however the page starts',
    async (t) => {
      const current = `try { localStorage.setItem('${TOUR_KEY}', '${TOUR_SEEN}'); } catch {}`;
      const { page } = await world(t, chromium, WITH_SESSIONS, { init: current });
      await listed(page, false);
      assert.equal(await shownTour(page), null);
      assert.equal(await mark(page), TOUR_SEEN);
    },
  );

  await t.test(
    'A1, A5: it never starts by itself in a browser that has seen it (every other case of the suite), nor where the storage throws or cannot be written, nor over the bar that says the page has no key',
    async (t) => {
      const seen = await world(t, chromium, WITH_SESSIONS, { tour: false });
      await listed(seen.page, false);
      assert.equal(await shownTour(seen.page), null);
      assert.equal(await mark(seen.page), TOUR_SEEN, 'newContext marked it');

      const throwing = await world(t, chromium, WITH_SESSIONS, {
        init: `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });`,
      });
      await listed(throwing.page, false);
      assert.equal(await shownTour(throwing.page), null, 'storage that throws');

      const full = await world(t, chromium, EMPTY, {
        init: `Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() { throw new DOMException('full', 'QuotaExceededError'); }, removeItem() {} } });`,
      });
      await listed(full.page, true);
      assert.equal(await shownTour(full.page), null, 'storage that cannot be written');

      const page = await newPage(t, chromium, { tour: true });
      const standin = await standinServer(t);
      await page.goto(standin.url);
      await showsText(page, '#problem', /^this window has no key; /);
      assert.equal(await shownTour(page), null, 'no key');
    },
  );

  await t.test(
    'A2: in the app window each step says its words — Ctrl+Tab and Ctrl+Shift+N —, and every control a step names is one of the page in each mode',
    async (t) => {
      const { page } = await world(t, chromium, WITH_SESSIONS);
      await listed(page, false);
      await tourStep(page, 1);
      await page.keyboard.press('Escape');
      await tourHidden(page);
      await controlsHold(page, 'tab');
      // The app window (the page's own app-only and tab-only rule reads <html data-display>).
      await page.evaluate(() => {
        document.documentElement.dataset['display'] = 'app';
      });
      await controlsHold(page, 'app');
      await toZone(page, 'terminal');
      await fromHelp(page);
      await walk(page, 'app');
      const app = tourSteps('app').flatMap((step) => step.lines.map(textOf));
      assert.ok(app.some((line) => line.includes('Ctrl+Shift+N starts a new session')));
      assert.ok(app.some((line) => line.includes('Ctrl+Tab back to the previous session')));
    },
  );

  await t.test(
    'A3: Enter and → go on, ← goes back, Tab stays in the panel; the page under it takes no key and no click, a window chord says to close it first; Esc skips, marks it seen and gives the keyboard back',
    async (t) => {
      const { page } = await world(t, chromium, WITH_SESSIONS);
      await listed(page, false);
      await tourStep(page, 1);
      await page.keyboard.press('Enter');
      await tourStep(page, 2);
      await page.keyboard.press('ArrowRight');
      await tourStep(page, 3);
      await page.keyboard.press('ArrowLeft');
      await tourStep(page, 2);
      // Tab and Shift+Tab walk the panel's buttons and stay there.
      const holder = (): Promise<string> =>
        readPage(page, () => document.activeElement?.className ?? '', null);
      assert.equal(await holder(), 'tour-next');
      const walked: string[] = [];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        walked.push(await holder());
      }
      assert.deepEqual(walked, ['tour-skip', 'tour-back', 'tour-next', 'tour-skip']);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await holder(), 'tour-next');
      // Enter on Back presses Back.
      await page.keyboard.press('Shift+Tab');
      assert.equal(await holder(), 'tour-back');
      await page.keyboard.press('Enter');
      await tourStep(page, 1);
      await page.keyboard.press('ArrowLeft');
      assert.equal((await tourStep(page, 1)).step, '1', '← on the first step');

      // A window chord does nothing but say so; the zone stays, no switcher opens.
      const zoneBefore = await zone(page);
      await page.keyboard.press('Control+Shift+L');
      assert.equal(await keyMessage(page), 'close the tour first (Esc)');
      assert.equal(await zone(page), zoneBefore);
      await page.keyboard.press('Control+Shift+P');
      assert.equal(await shownText(page, '#switcher'), '');
      await page.keyboard.press('Control+Shift+H');
      assert.equal(await shownText(page, '#help'), '', 'no help over the tour');
      // A list key acts on nothing; a click on a row selects nothing.
      await page.keyboard.press('j');
      const row = await page.locator(`#list [data-id="${S2}"]`).boundingBox();
      assert.ok(row !== null);
      await page.mouse.click(row.x + row.width / 2, row.y + row.height / 2);
      assert.equal(await selectedRow(page), S1);
      await tourStep(page, 1);

      // Esc skips: hidden, seen, the keyboard where it was (the selected session's terminal).
      await page.keyboard.press('Escape');
      await tourHidden(page);
      assert.equal(await mark(page), TOUR_SEEN);
      await until(async () => (await active(page)) === 'in #terminal', 'the terminal has it');
      // Nothing lies over the page any more: a click on a row selects it.
      await page.mouse.click(row.x + row.width / 2, row.y + row.height / 2);
      await until(async () => (await selectedRow(page)) === S2, 'the row is selected');
    },
  );

  await t.test(
    'A3: Space with any modifiers and Shift+Enter do nothing — a sentence typed as the tour pops up moves it one step at most and reaches no terminal —; the page is inert while it shows; Skip the tour in an unseen browser writes the mark and lifts the inertness',
    async (t) => {
      const { page, inputs } = await world(t, chromium, WITH_SESSIONS);
      await listed(page, false);
      await tourStep(page, 1);
      assert.equal(await inert(page), true, 'the page under the tour is inert');
      await page.keyboard.type('please run the tests and fix what fails now');
      await page.keyboard.press('Enter');
      await pause(300);
      assert.equal((await tourStep(page, 2)).step, '2', 'one step forward, no more');
      assert.equal(await mark(page), null, 'not marked seen');
      // On each button: Space, Shift+Space and Shift+Enter press none of them.
      const holder = (): Promise<string> =>
        readPage(page, () => document.activeElement?.className ?? '', null);
      for (const button of ['tour-next', 'tour-skip', 'tour-back']) {
        while ((await holder()) !== button) await page.keyboard.press('Tab');
        for (const key of ['Space', 'Shift+Space', 'Shift+Enter']) {
          await page.keyboard.press(key);
          await pause(100);
          assert.equal((await shownTour(page))?.step, '2', `${key} on ${button}`);
        }
      }
      // Space with Ctrl, Alt or Meta held presses nothing either; nor does Ctrl let go while Space
      // is held.
      while ((await holder()) !== 'tour-next') await page.keyboard.press('Tab');
      for (const key of ['Control+Space', 'Alt+Space', 'Meta+Space', 'Control+Shift+Space']) {
        await page.keyboard.press(key);
        await pause(100);
        assert.equal((await shownTour(page))?.step, '2', `${key} on tour-next`);
      }
      await page.keyboard.down('Control');
      await page.keyboard.down('Space');
      await page.keyboard.up('Control');
      await page.keyboard.up('Space');
      await pause(100);
      assert.equal((await shownTour(page))?.step, '2', 'Ctrl down, Space down, Ctrl up, Space up');
      assert.equal(await mark(page), null);
      assert.deepEqual(inputs, [], 'nothing reached the terminal');
      assert.equal(await inert(page), true);

      await page.locator('#tour .tour-skip').click();
      await tourHidden(page);
      assert.equal(await mark(page), TOUR_SEEN, 'Skip the tour marks it seen');
      assert.equal(await inert(page), false, 'the page is no longer inert');
      // The keyboard is back in the terminal: a key reaches the program again.
      await until(async () => (await active(page)) === 'in #terminal', 'the terminal has it');
      await page.keyboard.press('z');
      await until(() => inputs.length > 0, 'z reaches the terminal');
    },
  );

  await t.test(
    'A3: a held Enter moves one step; a reload key during the tour reloads the page, and the tour, not marked, shows again; the ring follows its region when the region changes size without a resize of the window',
    async (t) => {
      const { page } = await world(t, chromium, WITH_SESSIONS);
      await listed(page, false);
      await tourStep(page, 1);
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter'); // auto-repeats (Playwright sends them with `repeat`)
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await pause(200);
      assert.equal((await tourStep(page, 2)).step, '2', 'one step for one press');

      // The ring on the list, then a bar above the zones makes the list shorter.
      await page.keyboard.press('ArrowLeft');
      await tourStep(page, 1);
      await page.evaluate(() => {
        const info = document.getElementById('info') as HTMLElement;
        (document.getElementById('info-text') as HTMLElement).textContent = 'a bar over the zones';
        info.hidden = false;
      });
      await until(async () => {
        const shown = await shownTour(page);
        return (
          shown !== null &&
          Math.abs(shown.spot.top - shown.target.top) < 1 &&
          Math.abs(shown.spot.height - shown.target.height) < 1
        );
      }, 'the ring follows the list');

      await page.evaluate(() => Reflect.set(globalThis, 'beforeReload', true));
      await page.keyboard.press('Control+Shift+R');
      await until(
        async () =>
          (await readPage(page, () => Reflect.get(globalThis, 'beforeReload') === true, null)) ===
          false,
        'the page reloaded',
      );
      await connection(page, 'open');
      await tourStep(page, 1);
      assert.equal(await mark(page), null);
    },
  );

  await t.test(
    'A3, A4: the key help’s Take the tour starts it again, whatever was seen; Done and Skip the tour give the keyboard back where it was — the list, the filter with its text',
    async (t) => {
      const { page } = await world(t, chromium, WITH_SESSIONS, { tour: false });
      await listed(page, false);
      await toZone(page, 'list');
      assert.equal(await active(page), '#list');
      await fromHelp(page);
      await tourStep(page, 1);
      assert.equal(await shownText(page, '#help'), '', 'the help hidden');
      for (let step = 1; step <= tourSteps('tab').length; step++) {
        await tourStep(page, step);
        await page.keyboard.press('Enter');
      }
      await tourHidden(page);
      assert.equal(await active(page), '#list');
      assert.equal(await zone(page), 'Focus: list');

      await page.keyboard.press('/');
      await page.keyboard.type('first');
      const field = await active(page);
      await fromHelp(page);
      await tourStep(page, 1);
      await page.locator('#tour .tour-skip').click();
      await tourHidden(page);
      assert.equal(await active(page), field);
      assert.equal(
        await readPage(page, () => (document.activeElement as HTMLInputElement).value, null),
        'first',
      );
      assert.equal(await mark(page), TOUR_SEEN);
    },
  );

  await t.test(
    'A4: Take the tour over an open dialog says to close it first, and starts nothing',
    async (t) => {
      const { page } = await world(t, chromium, WITH_SESSIONS, { tour: false });
      await listed(page, false);
      await page.locator('#settings-button').click();
      await page.waitForSelector('#settings:not([hidden])', { state: 'attached' });
      await fromHelp(page);
      assert.equal(await keyMessage(page), 'close the settings first (Esc)');
      assert.equal(await shownTour(page), null);
    },
  );

  await t.test(
    'A4: the quick switcher’s > tour (the server’s command) starts it again, whatever was seen, by Enter and by a click; the keyboard goes back where it was before the switcher',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await l.page.waitForSelector(`#list [data-id="${S1}"]`, { state: 'attached' });
      assert.equal(await shownTour(l.page), null, 'seen: not by itself');
      await toZone(l.page, 'list');
      await l.page.keyboard.press('Control+Shift+P');
      await l.page.keyboard.type('> to');
      await showsText(
        l.page,
        '#switcher .switcher-offer[data-offer="tour"]',
        /^Tour: a minute’s walk round the window, step by step$/,
      );
      await showsText(l.page, '#switcher .switcher-foot', /Enter start the tour/);
      await l.page.keyboard.press('Enter');
      await tourStep(l.page, 1);
      assert.equal(await shownText(l.page, '#switcher'), '', 'the switcher closed');
      await l.page.keyboard.press('Escape');
      await tourHidden(l.page);
      assert.equal(await active(l.page), '#list');

      await l.page.keyboard.press('Control+Shift+P');
      await l.page.keyboard.type('>T');
      await l.page.locator('#switcher .switcher-offer[data-offer="tour"]').click();
      await tourStep(l.page, 1);
      await l.page.locator('#tour .tour-skip').click();
      await tourHidden(l.page);
      assert.equal(await active(l.page), '#list');

      // A command that names none names > tour among the commands.
      await l.page.keyboard.press('Control+Shift+P');
      await l.page.keyboard.type('> x');
      await showsText(l.page, '#switcher', /> tour starts the tour of the window/);
      assert.equal(await l.page.locator('#switcher .switcher-list [data-offer="tour"]').count(), 0);
      await l.page.keyboard.press('Escape');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'F38: an update that runs closes the tour as it closes the dialogs, without marking it seen; the tour does not start while the running form shows',
    async (t) => {
      const { page, standin } = await world(t, chromium, WITH_SESSIONS);
      await listed(page, false);
      await tourStep(page, 1);
      await page.keyboard.press('Enter');
      await tourStep(page, 2);
      for (const conn of standin.connections) conn.send({ t: 'update', update: update(true) });
      await tourHidden(page);
      await until(async () => (await updateLock(page)).shown, 'the running form');
      assert.deepEqual(await updateLock(page), { shown: true, inert: true });
      assert.equal(await mark(page), null, 'not marked seen');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      assert.equal(await shownTour(page), null);
      // Lifted: the page is usable again, and the tour does not come back by itself.
      for (const conn of standin.connections) conn.send({ t: 'update', update: update(false) });
      await until(async () => !(await updateLock(page)).shown, 'the running form lifted');
      assert.equal((await updateLock(page)).inert, false);
      assert.equal(await shownTour(page), null);
      assert.equal(await mark(page), null);

      // A page whose first list comes while an update runs: no tour over the running form.
      const locked = await world(t, chromium, WITH_SESSIONS, { update: update(true) });
      await listed(locked.page, false);
      await until(async () => (await updateLock(locked.page)).shown, 'the running form');
      assert.equal(await shownTour(locked.page), null);
    },
  );

  await t.test(
    'Behaviour 6: a lost connection ends the tour without marking it seen, and the page coming back does not start it again',
    async (t) => {
      const { page, standin } = await world(t, chromium, WITH_SESSIONS);
      await listed(page, false);
      await tourStep(page, 1);
      await page.keyboard.press('Enter');
      await tourStep(page, 2);
      for (const conn of standin.connections) conn.ws.terminate();
      await connection(page, 'lost');
      await tourHidden(page);
      assert.equal(await mark(page), null);
      assert.equal(
        await readPage(page, () => document.querySelector('.app')?.hasAttribute('inert'), null),
        false,
      );
      await connection(page, 'open');
      await listed(page, false);
      assert.equal(await shownTour(page), null);
      // Not marked: the next load shows it.
      await page.reload();
      await connection(page, 'open');
      await tourStep(page, 1);
    },
  );
});
