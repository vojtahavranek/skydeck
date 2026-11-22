// The window's theme (follow-up F13; S2 12.1, 7.2), chosen from F39 in Settings' Appearance (the
// title bar's gear): its Mode — Auto, Light or Dark —, remembered in the page's localStorage and
// applied before the first paint (web/theme-early.js); forced dark is exactly the system's dark and forced light the
// system's light, for every custom property of the three style sheets that have a dark scheme;
// every terminal of the page is repainted at a pick; a second page of the profile follows (the
// `storage` event); a click on the gear takes no keyboard, and after a pick Esc gives the keyboard
// back where it was; a stored value that is no choice, or storage that throws or is missing, is the
// system's. The page tells the server its colours again
// (`theme`), and the server answers OSC 10 / 11 from them. The page has web/'s real modules, on a
// scripted stand-in server (helpers/shell.ts) and, for the answers, on a real test server with the
// stand-in program.
//
// The Colour theme below it (S2 12.1): the theme of the scheme the page shows, offering that
// scheme's themes, each scheme keeping its own; each theme's values the
// same forced as by the system, a light theme leaving the dark scheme as it is; every terminal
// repainted at a pick and the server told the colours; the choices on <html> from the first
// painted frame after a reload, and a second page of the profile following at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import type { Browser, BrowserContext, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { PALETTE_KEYS, PALETTES, paletteWord, THEME_KEY, themeWord } from '../web/theme-text.js';
import type { Palette, Theme } from '../web/theme-text.js';
import { browser, newContext, newPage } from './helpers/browser.ts';
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
  standinServer,
  storeKey,
  TERM_A,
  TERM_B,
  toZone,
  zone,
} from './helpers/shell.ts';
import type { Standin } from './helpers/shell.ts';
import {
  recordsOf,
  resumeHere,
  shownTerm,
  until,
  untilScreen,
  promptOf,
} from './helpers/terminal.ts';

type Scheme = 'light' | 'dark';
type Message = Record<string, unknown>;

/** The terminal's colours of each scheme (style.css), as the page reports them. */
const LIGHT_COLOURS = { fg: '#24292f', bg: '#fbfbf9' };
const DARK_COLOURS = { fg: '#d6d9de', bg: '#121417' };

/** Sixteen cells, one in each ANSI colour (the cell's text is the colour's number in hex), and a
 *  `Y` in the 256 colours' fixed yellow (226, #ffff00), a colour meant for a dark background; the
 *  cursor two rows below. Not on their row: xterm.js draws the cursor's row at once when a
 *  terminal gets the keyboard (as one does when it is shown), so with the cursor there that draw
 *  would stand in for the full one that a terminal hidden at a change of colours owes. */
const PALETTE =
  '\x1b[H' +
  Array.from({ length: 16 }, (_, n) => `\x1b[${n < 8 ? 30 + n : 82 + n}m${n.toString(16)}`).join(
    '',
  ) +
  '\x1b[38;5;226mY' +
  '\x1b[0m plain text to select' +
  '\r\n\r\nthe cursor is here';

/** A stand-in server for the cases on a stand-in: S1 running in TERM_A, S2 in TERM_B. */
interface Deck {
  standin: Standin;
  secret: Uint8Array;
  /** Every message pages sent after their `start` but pings, with the connection's number. */
  sent: { n: number; message: Message }[];
  /** The `start` of every connection, in order. */
  starts(): Message[];
}

let seed = 90;

async function deck(t: TestContext): Promise<Deck> {
  const secret = new Uint8Array(32).fill(seed++);
  const sent: { n: number; message: Message }[] = [];
  const terminals = [
    { id: TERM_A, slot: 1, sessionId: S1 },
    { id: TERM_B, slot: 2, sessionId: S2 },
  ];
  const list = (): Message =>
    scriptedList(
      [
        { id: S1, terminal: TERM_A, slot: 1, title: 'alpha' },
        { id: S2, terminal: TERM_B, slot: 2, title: 'beta' },
      ],
      terminals,
    );
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message, n) => {
        sent.push({ n, message });
        if (message['t'] === 'view') {
          conn.send(list());
        } else if (message['t'] === 'attach') {
          const term = message['term'];
          conn.send({
            t: 'snap',
            term,
            ch: term === TERM_A ? 1 : 2,
            cols: message['cols'],
            rows: message['rows'],
            data: PALETTE,
          });
        }
      },
    }),
  });
  return {
    standin,
    secret,
    sent,
    starts: () =>
      standin.connections.flatMap((conn) =>
        conn.received
          .filter((raw) => raw.startsWith('{'))
          .map((raw) => JSON.parse(raw) as Message)
          .filter((message) => message['t'] === 'start'),
      ),
  };
}

/** Opens the deck's page on `page` (its key stored unless told), connected, a terminal shown. */
async function open(d: Deck, page: Page, store = true): Promise<void> {
  await page.goto(d.standin.url);
  if (store) {
    await storeKey(page, d.secret);
    await page.goto(d.standin.url);
  }
  await connection(page, 'open');
  await page.waitForSelector('#right-zone[data-pane="terminal"]', {
    state: 'attached',
    timeout: PAGE_WAIT_MS,
  });
}

/** A page of its own (newPage) at 1400 × 900 on a fresh deck. */
async function opened(
  t: TestContext,
  chromium: Browser,
  scheme: Scheme = 'light',
): Promise<{ page: Page; d: Deck; problems: string[] }> {
  const page = await newPage(t, chromium);
  const problems = problemsOf(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await systemScheme(page, scheme);
  const d = await deck(t);
  await open(d, page);
  return { page, d, problems };
}

/** Sets the system's scheme the page sees and waits until its media query says so. */
async function systemScheme(page: Page, scheme: Scheme): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForFunction(
    (dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark,
    scheme === 'dark',
    { timeout: PAGE_WAIT_MS },
  );
}

/** What Settings' Mode shows and the page keeps: its value and word, `<html data-theme>`, the
 *  stored value. The dialog is made once, so its controls are there while it is closed too. */
async function switchState(page: Page): Promise<{
  mode: string;
  word: string;
  attribute: string | null;
  stored: string | null;
}> {
  return readPage(
    page,
    (key) => {
      const select = document.getElementById('settings-mode') as HTMLSelectElement | null;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(key);
      } catch {
        stored = 'throws';
      }
      return {
        mode: select?.value ?? '',
        word: select?.selectedOptions[0]?.textContent ?? '',
        attribute: document.documentElement.getAttribute('data-theme'),
        stored,
      };
    },
    THEME_KEY,
  );
}

/** Asserts what Mode shows in `theme`, and <html data-theme>. */
async function shows(page: Page, theme: Theme, where: string): Promise<void> {
  const now = await switchState(page);
  assert.equal(now.mode, theme, `${where}: Mode's value`);
  assert.equal(now.word, themeWord(theme), `${where}: Mode's word`);
  assert.equal(now.attribute, theme === 'system' ? null : theme, `${where}: <html data-theme>`);
}

/** Whether the settings screen is shown. */
function settingsShown(page: Page): Promise<boolean> {
  return readPage(page, () => document.getElementById('settings')?.hidden === false, null);
}

/** Opens Settings with a mouse click on the title bar's gear, as the user's. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('#settings-button').click();
  await until(() => settingsShown(page), 'Settings is open');
}

/** In Settings (opened by the gear), picks `value` in the control `selector`, then Esc closes it. */
async function pick(page: Page, selector: string, value: string): Promise<void> {
  await openSettings(page);
  await page.locator(selector).selectOption(value);
  await page.keyboard.press('Escape');
  await until(async () => !(await settingsShown(page)), 'Settings is closed');
}

/** The mode after each: Auto → Light → Dark → Auto (the order the old switch clicked through). */
const NEXT: Readonly<Record<Theme, Theme>> = { system: 'light', light: 'dark', dark: 'system' };

/** Picks the next mode after the one shown (NEXT) in Settings, and closes it. */
async function nextMode(page: Page): Promise<void> {
  const now = (await switchState(page)).mode as Theme;
  await pick(page, '#settings-mode', NEXT[now]);
}

/**
 * The computed value on <html> of every custom property that style.css, terminal-view.css and
 * attention.css define (read from the page's own style sheets, nested rules and media blocks
 * included), and of `color-scheme`.
 */
async function computed(page: Page): Promise<Record<string, string>> {
  return readPage(
    page,
    () => {
      const names = new Set<string>();
      const sheets = new Set<string>();
      const walk = (rules: CSSRuleList, sheet: string): void => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            for (const name of rule.style) {
              if (name.startsWith('--')) {
                names.add(name);
                sheets.add(sheet);
              }
            }
          }
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules, sheet);
        }
      };
      for (const sheet of document.styleSheets) {
        const name = /\/web\/(style|terminal-view|attention)\.css$/.exec(sheet.href ?? '')?.[1];
        if (name !== undefined) walk(sheet.cssRules, name);
      }
      const style = getComputedStyle(document.documentElement);
      const values: Record<string, string> = {
        'color-scheme': style.colorScheme,
        sheets: [...sheets].sort().join(' '),
      };
      for (const name of [...names].sort()) values[name] = style.getPropertyValue(name).trim();
      return values;
    },
    null,
  );
}

/** The colours a terminal of the page draws: its background, its text, the sixteen colours, the
 *  selection. */
interface TermColours {
  background: string | null;
  foreground: string | null;
  palette: (string | null)[];
  selection: string | null;
}

async function termColours(page: Page, term: string): Promise<TermColours> {
  return readPage(
    page,
    (term) => {
      const box = document.querySelector(`#terminal .tv-term[data-term="${term}"]`);
      const style = (element: Element | null | undefined): CSSStyleDeclaration | null =>
        element instanceof Element ? getComputedStyle(element) : null;
      const spans = [...(box?.querySelectorAll('.xterm-rows span') ?? [])];
      return {
        background: style(box?.querySelector('.xterm-scrollable-element'))?.backgroundColor ?? null,
        foreground: style(box?.querySelector('.xterm-rows'))?.color ?? null,
        palette: Array.from(
          { length: 16 },
          (_, n) => style(spans.find((span) => span.textContent === n.toString(16)))?.color ?? null,
        ),
        selection: style(box?.querySelector('.xterm-selection div'))?.backgroundColor ?? null,
      };
    },
    term,
  );
}

/** The colour the `Y` of PALETTE is drawn in, and the terminal's background, each as [r, g, b]. */
async function yellowOn(page: Page, term: string): Promise<{ text: number[]; ground: number[] }> {
  const found = await readPage(
    page,
    (term) => {
      const box = document.querySelector(`#terminal .tv-term[data-term="${term}"]`);
      const span = [...(box?.querySelectorAll('.xterm-rows span') ?? [])].find(
        (one) => one.textContent === 'Y',
      );
      const ground = box?.querySelector('.xterm-scrollable-element');
      return {
        text: span === undefined ? '' : getComputedStyle(span).color,
        ground: ground instanceof Element ? getComputedStyle(ground).backgroundColor : '',
      };
    },
    term,
  );
  const channels = (css: string): number[] => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  return { text: channels(found.text), ground: channels(found.ground) };
}

/** WCAG 2's contrast ratio of two colours given as [r, g, b]. */
function contrastOf(a: number[], b: number[]): number {
  const luminance = (rgb: number[]): number => {
    const [r, g, bl] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Waits until the shown terminal is `term` and has drawn its sixteen colours. */
async function untilShown(page: Page, term: string): Promise<void> {
  await until(async () => (await shownTerm(page)) === term, `${term} shown`);
  await until(
    async () => (await termColours(page, term)).palette.every((colour) => colour !== null),
    `${term} drew its colours`,
  );
}

/**
 * From now on notes, at each change of the page's colours (the two switches' attributes on
 * <html>, the system's scheme), the cells every terminal has drawn so far; see untilRedrawn. The
 * observers are the test's own, made after the page's, so each runs after the page's retheme.
 */
async function noteRedraws(page: Page): Promise<void> {
  await page.evaluate(() => {
    const drawn = new WeakSet<Element>();
    (window as unknown as { testDrawnBefore: WeakSet<Element> }).testDrawnBefore = drawn;
    const note = (): void => {
      for (const span of document.querySelectorAll('#terminal .tv-term .xterm-rows span')) {
        drawn.add(span);
      }
    };
    new MutationObserver(note).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette-light', 'data-palette-dark'],
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', note);
  });
}

/**
 * Waits until `term` has drawn its row of the sixteen colours again since the last change of the
 * page's colours (noteRedraws). The page sets a terminal's new colours at once, and xterm.js
 * 6.0.0 puts its background, its text and the sixteen colours' classes in its style sheet at once,
 * but draws the rows in its next animation frame (a hidden terminal's once it is shown again):
 * a colour that minimumContrastRatio adjusts is written into the cell at that draw. Until then a
 * read finds the new background with the cells' old adjustment. For a shown terminal no painted
 * frame shows that state. A terminal hidden at the change shows it for one frame when it is shown
 * again (its full draw comes a frame after the one that first lays it out): a known defect of the
 * page, and not what this wait is for. The tests assert the colours after the draw.
 */
async function untilRedrawn(page: Page, term: string): Promise<void> {
  await until(
    () =>
      readPage(
        page,
        (term) => {
          const drawn = (window as unknown as { testDrawnBefore?: WeakSet<Element> })
            .testDrawnBefore;
          const box = document.querySelector(`#terminal .tv-term[data-term="${term}"]`);
          const zero = [...(box?.querySelectorAll('.xterm-rows span') ?? [])].find(
            (span) => span.textContent === '0',
          );
          return drawn !== undefined && zero !== undefined && !drawn.has(zero);
        },
        term,
      ),
    `${term} drawn again since the change of colours`,
  );
}

/** Selects the shown terminal's first line with the mouse, then gives the list the keyboard (so
 *  that every measure of the selection is of an unfocused terminal). */
async function selectFirstLine(page: Page, term: string): Promise<void> {
  const screen = page.locator(`#terminal .tv-term[data-term="${term}"] .xterm-screen`);
  const box = await screen.boundingBox();
  assert.ok(box !== null, 'the terminal has a screen');
  await page.mouse.move(box.x + 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 6, { steps: 5 });
  await page.mouse.up();
  await until(
    async () => (await termColours(page, term)).selection !== null,
    'the selection is drawn',
  );
  await toZone(page, 'list');
}

/** The `theme` messages pages sent after `from` (an index of `sent`). */
function themesSent(d: Deck, from: number): { n: number; message: Message }[] {
  return d.sent.slice(from).filter((entry) => entry.message['t'] === 'theme');
}

/** What Settings' Colour theme shows and the page keeps: its value, its options' words, the two
 *  attributes on <html> and the two stored values. */
async function paletteState(page: Page): Promise<{
  value: string;
  words: string[];
  light: string | null;
  dark: string | null;
  storedLight: string | null;
  storedDark: string | null;
}> {
  return readPage(
    page,
    (keys) => {
      const select = document.getElementById('settings-palette') as HTMLSelectElement | null;
      const stored = (key: string): string | null => {
        try {
          return localStorage.getItem(key);
        } catch {
          return 'throws';
        }
      };
      return {
        value: select?.value ?? '',
        words: [...(select?.options ?? [])].map((option) => option.textContent ?? ''),
        light: document.documentElement.getAttribute('data-palette-light'),
        dark: document.documentElement.getAttribute('data-palette-dark'),
        storedLight: stored(keys.light),
        storedDark: stored(keys.dark),
      };
    },
    PALETTE_KEYS,
  );
}

/** Asserts what Colour theme shows: `palette`, among the themes of `scheme`. */
async function showsPalette(
  page: Page,
  scheme: Scheme,
  palette: Palette,
  where: string,
): Promise<void> {
  const now = await paletteState(page);
  assert.equal(now.value, palette, `${where}: its value`);
  assert.deepEqual(now.words, PALETTES[scheme].map(paletteWord), `${where}: ${scheme}'s themes`);
}

/** Asserts the two attributes on <html> and the two stored values. */
async function keeps(
  page: Page,
  light: string | null,
  dark: string | null,
  where: string,
): Promise<void> {
  const now = await paletteState(page);
  assert.deepEqual(
    { light: now.light, dark: now.dark, storedLight: now.storedLight, storedDark: now.storedDark },
    { light, dark, storedLight: light, storedDark: dark },
    `${where}: <html> and the storage`,
  );
}

/** Picks the shown scheme's next colour theme in Settings (after the last, the default), and
 *  closes it. The choices are read once Settings is open, which draws them as the page is now. */
async function nextPalette(page: Page): Promise<void> {
  await openSettings(page);
  const { value, values } = await readPage(
    page,
    () => {
      const select = document.getElementById('settings-palette') as HTMLSelectElement;
      return { value: select.value, values: [...select.options].map((option) => option.value) };
    },
    null,
  );
  await page
    .locator('#settings-palette')
    .selectOption(values[(values.indexOf(value) + 1) % values.length] ?? '');
  await page.keyboard.press('Escape');
  await until(async () => !(await settingsShown(page)), 'Settings is closed');
}

/** The terminal's colours of each theme (style.css), as the page reports them. */
const LIGHT_IRIS_COLOURS = { fg: '#241523', bg: '#f6f2fd' };
const DARK_IRIS_COLOURS = { fg: '#fffaff', bg: '#1d1929' };

test("the window's theme, in Settings' Appearance (follow-up F13, F39)", async (t) => {
  const chromium = await browser(t);

  await t.test(
    "the title bar has no theme button and no text `Settings`: after `Switch…` a gear, drawn inline, named and with the tooltip Settings, opens Settings, whose Appearance comes first, drawn without the server's answer; Mode offers Auto, Light and Dark, Auto at first; each pick applies at once and keeps it in localStorage (`light`, `dark`, removed for Auto) and on <html data-theme>",
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      const bar = await readPage(
        page,
        () => {
          const gear = document.getElementById('settings-button');
          return {
            old: ['theme-button', 'palette-button'].filter((id) => document.getElementById(id)),
            texts: [...document.querySelectorAll('.titlebar button')].map((one) =>
              (one.textContent ?? '').replace(/\s+/g, ' ').trim(),
            ),
            parent: gear?.parentElement?.className ?? null,
            after: gear?.previousElementSibling?.id ?? null,
            name: gear?.getAttribute('aria-label') ?? null,
            title: gear?.getAttribute('title') ?? null,
            type: gear?.getAttribute('type') ?? null,
            text: gear?.textContent?.trim() ?? null,
            drawing: gear?.querySelector('svg')?.getAttribute('aria-hidden') ?? null,
            images: gear?.querySelectorAll('img, image, use').length ?? -1,
          };
        },
        null,
      );
      assert.deepEqual(bar.old, [], 'no theme button');
      assert.ok(!bar.texts.includes('Settings'), `no text Settings: ${JSON.stringify(bar.texts)}`);
      assert.equal(bar.parent, 'titlebar');
      assert.equal(bar.after, 'switch-button', 'right after Switch…');
      assert.equal(bar.name, 'Settings', 'its accessible name');
      assert.equal(bar.title, 'Settings', 'its tooltip');
      assert.equal(bar.type, 'button');
      assert.equal(bar.text, '', 'no text, no emoji');
      assert.equal(bar.drawing, 'true', 'an inline drawing, not read out');
      assert.equal(bar.images, 0, 'no picture fetched');
      assert.equal(
        await page.getByRole('button', { name: 'Settings', exact: true }).getAttribute('id'),
        'settings-button',
      );

      await openSettings(page);
      const appearance = await readPage(
        page,
        () => {
          const first = document.querySelector('#settings .settings-short-group');
          return {
            group: first?.querySelector('.settings-group')?.textContent ?? null,
            labels: [...(first?.querySelectorAll('label') ?? [])].map((one) => one.textContent),
            modes: [...(document.getElementById('settings-mode') as HTMLSelectElement).options].map(
              (option) => [option.value, option.textContent],
            ),
            keyboard: document.activeElement?.id ?? null,
          };
        },
        null,
      );
      // The stand-in never answers `act settings`: Appearance needs no answer.
      assert.deepEqual(appearance, {
        group: 'Appearance',
        labels: ['Mode', 'Colour theme'],
        modes: [
          ['system', 'Auto'],
          ['light', 'Light'],
          ['dark', 'Dark'],
        ],
        keyboard: 'settings-mode',
      });
      await page.keyboard.press('Escape');
      await until(async () => !(await settingsShown(page)), 'closed');
      await shows(page, 'system', 'at first');
      assert.equal((await switchState(page)).stored, null);

      for (const [theme, stored] of [
        ['light', 'light'],
        ['dark', 'dark'],
        ['system', null],
        ['light', 'light'],
      ] as const) {
        await nextMode(page);
        await shows(page, theme, `after a pick of ${theme}`);
        assert.equal((await switchState(page)).stored, stored, `${theme}: stored`);
      }
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'forced dark under a light system gives every custom property of style.css, terminal-view.css and attention.css, and color-scheme, the value the system’s dark gives; forced light under a dark system the system’s light; forced dark under a dark system and Auto are the system’s',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      const light = await computed(page); // Auto, light system
      assert.equal(light['sheets'], 'attention style terminal-view', 'all three sheets read');
      assert.ok(Object.keys(light).length > 60, `${Object.keys(light).length} properties`);
      await systemScheme(page, 'dark');
      const dark = await computed(page); // Auto, dark system
      assert.deepEqual(Object.keys(dark), Object.keys(light));
      for (const name of ['--bg', '--term-bg', '--tv-red', '--tv-selection', '--need-finished']) {
        assert.notEqual(dark[name], light[name], `${name} differs between the schemes`);
      }
      assert.equal(light['color-scheme'], 'light');
      assert.equal(dark['color-scheme'], 'dark');

      await nextMode(page); // Light, under a dark system
      await shows(page, 'light', 'forced light');
      assert.deepEqual(await computed(page), light, 'forced light under a dark system');
      await nextMode(page); // Dark, under a dark system
      assert.deepEqual(await computed(page), dark, 'forced dark under a dark system');
      await systemScheme(page, 'light');
      assert.deepEqual(await computed(page), dark, 'forced dark under a light system');
      await nextMode(page); // Auto
      assert.deepEqual(await computed(page), light, 'Auto under a light system');
      await nextMode(page); // Light, under a light system
      assert.deepEqual(await computed(page), light, 'forced light under a light system');
      await systemScheme(page, 'dark');
      assert.deepEqual(await computed(page), light, 'forced light does not follow the system');
      await nextMode(page);
      await nextMode(page); // Auto, under a dark system
      assert.deepEqual(await computed(page), dark, 'Auto follows the system again');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'at a pick every terminal of the page is repainted in the new colours — background, text, the sixteen colours and the selection — as after a flip of the system: the shown one at once, a hidden one when it is shown again',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      await noteRedraws(page);
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      await selectFirstLine(page, TERM_A);
      const light = await termColours(page, TERM_A);
      await systemScheme(page, 'dark');
      await until(
        async () => (await termColours(page, TERM_A)).background !== light.background,
        'the system’s flip repaints the terminal',
      );
      await untilRedrawn(page, TERM_A);
      const dark = await termColours(page, TERM_A);
      for (const key of ['background', 'foreground', 'selection'] as const) {
        assert.notEqual(dark[key], light[key], `${key} differs between the schemes`);
      }
      light.palette.forEach((colour, n) => {
        assert.notEqual(dark.palette[n], colour, `colour ${n} differs between the schemes`);
      });
      await systemScheme(page, 'light');
      await until(
        async () => (await termColours(page, TERM_A)).background === light.background,
        'back to light',
      );

      // B shown, A hidden; B's line selected too.
      await clickRow(page, S2);
      await untilShown(page, TERM_B);
      await selectFirstLine(page, TERM_B);
      assert.deepEqual(await termColours(page, TERM_B), light, 'B in the light colours');

      await nextMode(page); // Light: nothing changes under a light system
      assert.deepEqual(await termColours(page, TERM_B), light);
      await nextMode(page); // Dark, under a light system
      await until(
        async () => (await termColours(page, TERM_B)).background === dark.background,
        'B repainted at the pick',
      );
      await untilRedrawn(page, TERM_B);
      assert.deepEqual(await termColours(page, TERM_B), dark, 'B in the dark colours');
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      await untilRedrawn(page, TERM_A);
      assert.deepEqual(await termColours(page, TERM_A), dark, 'A, hidden at the pick, is dark');

      await nextMode(page); // Auto: the light system's again
      await until(
        async () => (await termColours(page, TERM_A)).background === light.background,
        'A repainted at the pick',
      );
      await untilRedrawn(page, TERM_A);
      assert.deepEqual(await termColours(page, TERM_A), light);
      await clickRow(page, S2);
      await untilShown(page, TERM_B);
      await untilRedrawn(page, TERM_B);
      assert.deepEqual(await termColours(page, TERM_B), light, 'B, hidden at the pick, is light');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'every terminal draws its text at least 4.5 : 1 against its background (xterm.js’s minimumContrastRatio): the fixed yellow meant for a dark background is darkened on the light scheme and left as it is on the dark one',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      const YELLOW = [255, 255, 0].join();
      for (const scheme of ['light', 'dark'] as const) {
        await systemScheme(page, scheme);
        const hex = (scheme === 'light' ? LIGHT_COLOURS : DARK_COLOURS).bg;
        const background = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join();
        // The scheme's own end state: the background can change a frame before the text is
        // drawn again, and the other scheme's text on it is no answer.
        let last = { text: [] as number[], ground: [] as number[] };
        await until(
          async () => {
            last = await yellowOn(page, TERM_A);
            const { text, ground } = last;
            if (ground.join() !== background || text.length !== 3) return false;
            return scheme === 'dark'
              ? text.join() === YELLOW
              : text.join() !== YELLOW && contrastOf(text, ground) >= 4.5;
          },
          `${scheme}: the yellow is ${scheme === 'dark' ? 'left as it is' : 'darkened to 4.5 : 1'}`,
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}; last drawn ${JSON.stringify(last)}`);
        });
      }
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a mouse click on the gear takes no keyboard from where it was before Settings opens; after a pick, Esc gives it back: to the terminal (what is typed next goes to its program) and to the list; the gear from the keyboard: Enter opens Settings, Esc gives the keyboard back to the gear',
    async (t) => {
      const { page, d, problems } = await opened(t, chromium);
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      await toZone(page, 'terminal');
      assert.equal(await active(page), 'in #terminal');
      const gear = await page.locator('#settings-button').boundingBox();
      assert.ok(gear !== null, 'the gear is drawn');
      await page.mouse.move(gear.x + gear.width / 2, gear.y + gear.height / 2);
      await page.mouse.down();
      assert.equal(await active(page), 'in #terminal', 'the press takes no keyboard');
      await page.mouse.up();
      await until(() => settingsShown(page), 'Settings opened by the click');
      assert.equal(await active(page), '#settings-mode', 'then the keyboard is in Settings');
      await page.locator('#settings-mode').selectOption('light');
      await page.keyboard.press('Escape');
      await until(async () => !(await settingsShown(page)), 'closed');
      await shows(page, 'light', 'picked from the terminal');
      await sleep(100); // the page's own keyboard rules run after a mouseup (a timer of 0)
      assert.equal(await active(page), 'in #terminal', 'the terminal has the keyboard again');
      assert.equal(await zone(page), 'Focus: terminal');
      const from = d.sent.length;
      await page.keyboard.type('x');
      await until(
        () =>
          d.sent
            .slice(from)
            .some(
              ({ message }) =>
                message['t'] === 'input' && message['term'] === TERM_A && message['data'] === 'x',
            ),
        'the x reached the terminal',
      );

      await toZone(page, 'list');
      assert.equal(await active(page), '#list');
      await nextMode(page);
      await shows(page, 'dark', 'picked from the list');
      await sleep(100);
      assert.equal(await active(page), '#list', 'the list has the keyboard again');
      assert.equal(await zone(page), 'Focus: list');

      await page.focus('#settings-button');
      await page.keyboard.press('Enter');
      await until(() => settingsShown(page), 'Enter on the gear opens Settings');
      assert.equal(await active(page), '#settings-mode');
      await page.locator('#settings-mode').selectOption('system');
      await page.keyboard.press('Escape');
      await until(async () => !(await settingsShown(page)), 'closed');
      await shows(page, 'system', 'picked from the keyboard');
      assert.equal(await active(page), '#settings-button', 'back on the gear');
      assert.deepEqual(problems, []);
    },
  );

  /** An init script: records, at every animation frame (run right before its paint), what that
   *  frame draws of the theme, until 400 frames. */
  const FRAMES = (): void => {
    const frames: { at: number; bg: string; scheme: string; theme: string | null }[] = [];
    Reflect.set(globalThis, 'themeFrames', frames);
    const tick = (at: number): void => {
      const style = getComputedStyle(document.documentElement);
      frames.push({
        at,
        bg: style.getPropertyValue('--bg').trim(),
        scheme: style.colorScheme,
        theme: document.documentElement.getAttribute('data-theme'),
      });
      if (frames.length < 400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /** The frames FRAMES recorded and the page's first paint (performance's `first-paint`). */
  async function framesOf(
    page: Page,
  ): Promise<{ frames: { at: number; bg: string; scheme: string }[]; firstPaint: number }> {
    await until(
      async () =>
        (await page.evaluate(
          () => (Reflect.get(globalThis, 'themeFrames') as unknown[] | undefined)?.length ?? 0,
        )) >= 30,
      '30 frames recorded',
    );
    return page.evaluate(() => ({
      frames: Reflect.get(globalThis, 'themeFrames') as {
        at: number;
        bg: string;
        scheme: string;
      }[],
      firstPaint:
        performance.getEntriesByType('paint').find((entry) => entry.name === 'first-paint')
          ?.startTime ?? -1,
    }));
  }

  /**
   * Holds every load of theme-early.js and of app.js for `ms`, then lets the request go on to the
   * routes registered before (the control's empty early script) or to the server. Holding the early
   * script too is what tells a blocking script in <head> from one that is late — `async`, `defer`, or
   * at the end of <body> would let a frame be painted before it ran (review 2, S1).
   */
  async function slow(page: Page, ms: number): Promise<void> {
    await page.route('**/assets/*/web/{app,theme-early}.js', async (route) => {
      await sleep(ms);
      await route.fallback();
    });
  }

  await t.test(
    'the choice survives a reload, and no frame is drawn in the other theme: from the first painted frame on, every frame is in the stored theme, also while the early script and the page’s modules are each held back 600 ms; without the early script the first frames are the system’s (so the measure would see a flash)',
    async (t) => {
      const { page, d, problems } = await opened(t, chromium);
      await nextMode(page);
      await nextMode(page); // Dark, under a light system
      await shows(page, 'dark', 'before the reload');
      await page.addInitScript(FRAMES);
      const darkBg = '#16181c';
      const lightBg = '#f3f4f6';

      /** Reloads (the early script and app.js held back `held` ms when it is not 0) and asserts
       *  that every frame from the first paint on has `bg` and `scheme`. */
      const reloadIn = async (held: number, bg: string, scheme: Scheme): Promise<void> => {
        if (held > 0) await slow(page, held);
        await page.reload();
        await connection(page, 'open');
        const { frames, firstPaint } = await framesOf(page);
        assert.ok(firstPaint > 0, 'the page was painted');
        assert.ok(
          (frames[0]?.at ?? Infinity) <= firstPaint + 1,
          `the first recorded frame (${frames[0]?.at}) comes no later than the first paint (${firstPaint})`,
        );
        const other = frames.filter((frame) => frame.bg !== bg || frame.scheme !== scheme);
        assert.deepEqual(other, [], `${scheme}, held ${held} ms: no frame in another theme`);
        await shows(page, scheme, `after the reload (held ${held} ms)`);
        await page.unrouteAll();
      };

      for (const held of [0, 600]) await reloadIn(held, darkBg, 'dark');
      assert.deepEqual(
        d.starts().at(-1)?.['theme'],
        DARK_COLOURS,
        'the start after the reload reports the dark colours',
      );

      // The other way round: forced light under a dark system.
      await systemScheme(page, 'dark');
      await nextMode(page);
      await nextMode(page); // Light
      await shows(page, 'light', 'before the second reload');
      for (const held of [0, 600]) await reloadIn(held, lightBg, 'light');

      // The control: the early script served empty, it and the modules held back: the first frames
      // follow the system (dark), then web/theme.js applies the stored light.
      await page.route('**/assets/*/web/theme-early.js', (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
      );
      await slow(page, 600);
      await page.reload();
      await connection(page, 'open');
      const control = await framesOf(page);
      assert.ok(
        control.frames.some((frame) => frame.bg === darkBg),
        'without the early script some frames show the system’s dark',
      );
      assert.equal(control.frames.at(-1)?.bg, lightBg, 'then the stored light');
      await page.unrouteAll();
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a second page of the same profile follows a pick at once (the storage event): its Mode, <html data-theme>, its colours, and it tells its server its colours',
    async (t) => {
      const context: BrowserContext = await newContext(chromium);
      t.after(() => context.close());
      const one = await context.newPage();
      const two = await context.newPage();
      const problems = [...[one, two].map((page) => problemsOf(page))];
      for (const page of [one, two]) await systemScheme(page, 'dark');
      const d = await deck(t);
      await open(d, one);
      await open(d, two, false); // the same profile: the key is stored already
      const twoConnection = d.standin.connections.length;
      const dark = await computed(two);
      for (const [theme, colours] of [
        ['light', LIGHT_COLOURS],
        ['dark', DARK_COLOURS],
        ['system', DARK_COLOURS],
      ] as const) {
        const from = d.sent.length;
        await nextMode(one);
        await shows(one, theme, `the picked page, ${theme}`);
        await until(
          async () => (await switchState(two)).word === themeWord(theme),
          `the second page shows ${theme}`,
        );
        await shows(two, theme, `the second page, ${theme}`);
        assert.equal(
          (await computed(two))['--bg'],
          theme === 'light' ? '#f3f4f6' : dark['--bg'],
          `the second page's colours, ${theme}`,
        );
        await until(
          () => themesSent(d, from).some((entry) => entry.n === twoConnection),
          `the second page tells its server (${theme})`,
        );
        assert.deepEqual(
          themesSent(d, from)
            .filter((entry) => entry.n === twoConnection)
            .map((entry) => entry.message),
          [{ t: 'theme', theme: colours }],
        );
      }
      assert.deepEqual(problems.flat(), []);
    },
  );

  await t.test(
    'a stored value that is neither `light` nor `dark` is the system’s, and a pick still goes to Light and stores it',
    async (t) => {
      const { page, problems } = await opened(t, chromium, 'dark');
      const dark = await computed(page);
      for (const value of [
        'Dark',
        'LIGHT',
        'system',
        'auto',
        '',
        ' dark',
        'light ',
        '"dark"',
        '1',
      ]) {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
          key: THEME_KEY,
          value,
        });
        await page.reload();
        await connection(page, 'open');
        await shows(page, 'system', JSON.stringify(value));
        assert.deepEqual(await computed(page), dark, `${JSON.stringify(value)}: the system's dark`);
      }
      await nextMode(page);
      await shows(page, 'light', 'a pick');
      assert.equal((await switchState(page)).stored, 'light', 'the pick stores its choice');
      assert.deepEqual(problems, []);
    },
  );

  for (const [what, storage] of [
    [
      'storage that throws',
      `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });`,
    ],
    [
      'no storage',
      `Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });`,
    ],
    [
      'storage that takes nothing',
      `Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() { throw new DOMException('full', 'QuotaExceededError'); }, removeItem() { throw new DOMException('full', 'QuotaExceededError'); } } });`,
    ],
  ] as const) {
    await t.test(
      `${what}: the page follows the system; Mode still works for the life of the page (and tells the server); a reload is the system's again`,
      async (t) => {
        const page = await newPage(t, chromium);
        const problems = problemsOf(page);
        await systemScheme(page, 'light');
        const d = await deck(t);
        // The key is stored first, on a page with its storage.
        await page.goto(d.standin.url);
        await storeKey(page, d.secret);
        await page.addInitScript(storage);
        await page.goto(d.standin.url);
        await connection(page, 'open');
        await shows(page, 'system', 'at the load');
        const light = await computed(page);
        const from = d.sent.length;
        await nextMode(page);
        await nextMode(page);
        await shows(page, 'dark', 'two picks');
        assert.notEqual((await computed(page))['--bg'], light['--bg'], 'the page is dark');
        assert.deepEqual(
          themesSent(d, from).map((entry) => entry.message['theme']),
          [LIGHT_COLOURS, DARK_COLOURS],
        );
        await page.reload();
        await connection(page, 'open');
        await shows(page, 'system', 'after a reload');
        assert.deepEqual(await computed(page), light);
        assert.deepEqual(problems, []);
      },
    );
  }

  await t.test(
    'the page tells the server its colours again (`theme`, exactly fg and bg): after each pick whose colours are new or not, after a flip of the system while it follows the system, never after a flip while forced; a reconnect’s start carries the colours of the moment',
    async (t) => {
      const { page, d, problems } = await opened(t, chromium);
      assert.deepEqual(d.starts()[0]?.['theme'], LIGHT_COLOURS, 'start: the light colours');
      let from = d.sent.length;
      const expect = async (colours: (typeof LIGHT_COLOURS)[], what: string): Promise<void> => {
        await until(() => themesSent(d, from).length >= colours.length, what);
        await sleep(200);
        assert.deepEqual(
          themesSent(d, from).map((entry) => entry.message),
          colours.map((theme) => ({ t: 'theme', theme })),
          what,
        );
        from = d.sent.length;
      };
      await nextMode(page); // Light
      await expect([LIGHT_COLOURS], 'a pick to Light');
      await nextMode(page); // Dark
      await expect([DARK_COLOURS], 'a pick to Dark');
      // Each flip is waited for until a `change` listener of the test's own has run (it was added
      // after the page's, so the page's has run too): two flips with no frame between them would
      // run no listener at all (review 2, S2).
      await page.evaluate(() => {
        Reflect.set(globalThis, 'testFlips', 0);
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          Reflect.set(globalThis, 'testFlips', Number(Reflect.get(globalThis, 'testFlips')) + 1);
        });
      });
      const flips = (): Promise<number> =>
        page.evaluate(() => Number(Reflect.get(globalThis, 'testFlips')));
      for (const scheme of ['dark', 'light'] as const) {
        const before = await flips();
        await systemScheme(page, scheme);
        await until(async () => (await flips()) > before, `the page saw the flip to ${scheme}`);
      }
      await sleep(300);
      assert.deepEqual(themesSent(d, from), [], 'no message for flips while forced');
      await nextMode(page); // Auto, light system
      await expect([LIGHT_COLOURS], 'a pick to Auto');
      await systemScheme(page, 'dark');
      await expect([DARK_COLOURS], 'the system flips to dark');
      await systemScheme(page, 'light');
      await expect([LIGHT_COLOURS], 'and back');

      // A new connection: its start has the colours of now.
      await nextMode(page);
      await nextMode(page); // Dark
      const before = d.standin.connections.length;
      d.standin.connections.at(-1)?.ws.terminate();
      await until(() => d.standin.connections.length > before, 'the page connects again');
      await connection(page, 'open');
      assert.deepEqual(d.starts().at(-1)?.['theme'], DARK_COLOURS, 'the new start: dark');
      assert.deepEqual(
        problems.filter((problem) => !problem.startsWith('console:')),
        [],
      );
    },
  );

  await t.test(
    "on a real server, a program's OSC 10 and OSC 11 questions are answered with the colours of the page's Mode: light at first, dark after the picks to Dark, light again at Auto (the stand-in's /query)",
    async (t) => {
      const l = await launched(t, chromium);
      await systemScheme(l.page, 'light');
      l.d.resumable(S1);
      await resumeHere(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      /** Asks the stand-in's /query and returns its newest OSC 10 and 11 answers' colours. */
      const asked = async (): Promise<{ fg: string; bg: string }> => {
        const count = recordsOf(l.d.record, S1).filter((r) => r.ev === 'answer').length;
        await l.page.keyboard.type('/query');
        await l.page.keyboard.press('Enter');
        await until(
          () => recordsOf(l.d.record, S1).filter((r) => r.ev === 'answer').length >= count + 7,
          'every query answered',
        );
        await untilScreen(l.page, new RegExp(`${promptOf(S1).source}\\s*$`));
        const answers = recordsOf(l.d.record, S1).flatMap((r) =>
          r.ev === 'answer' ? [{ query: r.query, answer: r.answer }] : [],
        );
        const colour = (query: string): string => {
          const answer = answers.filter((a) => a.query === query).at(-1)?.answer ?? '';
          const m =
            /rgb:([0-9a-f]{2})[0-9a-f]{2}\/([0-9a-f]{2})[0-9a-f]{2}\/([0-9a-f]{2})[0-9a-f]{2}/.exec(
              answer,
            );
          return m === null ? answer : `#${m[1]}${m[2]}${m[3]}`;
        };
        return { fg: colour('OSC 10'), bg: colour('OSC 11') };
      };
      assert.deepEqual(await asked(), LIGHT_COLOURS, 'at first: the light colours');
      await nextMode(l.page);
      await nextMode(l.page); // Dark
      assert.equal(await active(l.page), 'in #terminal', 'the picks left the keyboard there');
      assert.deepEqual(await asked(), DARK_COLOURS, 'after the picks to Dark');
      await nextMode(l.page); // Auto, light system
      assert.deepEqual(await asked(), LIGHT_COLOURS, 'at Auto');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'Colour theme, under Mode in Appearance, shows the default at first and offers the themes of the scheme the page shows; a pick applies it, keeps it under its scheme’s key and puts it on <html>, each scheme keeping its own; it follows the scheme shown, as Mode or the system changes it',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      await showsPalette(page, 'light', 'default', 'at first');
      await keeps(page, null, null, 'at first');

      await nextPalette(page);
      await showsPalette(page, 'light', 'iris', 'light, a pick');
      await keeps(page, 'iris', null, 'light, a pick');

      await nextMode(page);
      await nextMode(page); // Dark, under a light system
      await showsPalette(page, 'dark', 'default', 'forced dark: its own choice');
      await nextPalette(page);
      await showsPalette(page, 'dark', 'iris', 'dark, a pick');
      await nextPalette(page);
      await showsPalette(page, 'dark', 'pleiades', 'dark, two picks');
      await keeps(page, 'iris', 'pleiades', 'each scheme its own');

      await nextMode(page); // Auto, under a light system
      await showsPalette(page, 'light', 'iris', 'Auto under a light system');
      await systemScheme(page, 'dark');
      await until(
        async () => (await paletteState(page)).value === 'pleiades',
        'it follows the system',
      );
      await showsPalette(page, 'dark', 'pleiades', 'Auto under a dark system');
      await nextPalette(page);
      await showsPalette(page, 'dark', 'default', 'dark, back to the default');
      await keeps(page, 'iris', null, 'the default is no attribute and no key');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'each theme gives the custom properties of style.css and terminal-view.css its own values, the same forced as by the system; a light theme leaves the dark scheme as it is; the attention colours stay',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      const light = await computed(page);
      await systemScheme(page, 'dark');
      const dark = await computed(page);
      await systemScheme(page, 'light');
      await nextPalette(page); // light Iris
      const lightIris = await computed(page);
      await systemScheme(page, 'dark');
      assert.deepEqual(await computed(page), dark, 'light Iris leaves the dark scheme as it is');
      await nextPalette(page); // dark Iris
      const darkIris = await computed(page);
      await nextPalette(page); // Pleiades
      const pleiades = await computed(page);

      const own = [
        '--bg',
        '--panel2',
        '--accent',
        '--term-bg',
        '--tv-red',
        '--tv-cursor',
        '--tv-selection',
      ];
      for (const [what, values, scheme] of [
        ['light Iris', lightIris, light],
        ['dark Iris', darkIris, dark],
        ['Pleiades', pleiades, dark],
      ] as const) {
        assert.deepEqual(Object.keys(values), Object.keys(scheme), `${what}: the same properties`);
        for (const name of own) {
          assert.notEqual(values[name], scheme[name], `${what}: ${name} is its own`);
        }
        assert.equal(values['--need-finished'], scheme['--need-finished'], `${what}: attention`);
        assert.equal(values['color-scheme'], scheme['color-scheme'], `${what}: color-scheme`);
      }
      assert.notEqual(
        pleiades['--on-accent'],
        dark['--on-accent'],
        'Pleiades: dark text on its accent',
      );

      await nextMode(page); // Light, under a dark system
      assert.deepEqual(await computed(page), lightIris, 'forced light under a dark system');
      await nextMode(page); // Dark, under a dark system
      assert.deepEqual(await computed(page), pleiades, 'forced dark under a dark system');
      await systemScheme(page, 'light');
      assert.deepEqual(await computed(page), pleiades, 'forced dark under a light system');
      await nextMode(page); // Auto, under a light system
      assert.deepEqual(await computed(page), lightIris, 'Auto under a light system');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    "at a pick of a colour theme every terminal of the page is repainted in the theme's colours — the shown one at once, a hidden one when it is shown again — and the server is told the colours",
    async (t) => {
      const { page, d, problems } = await opened(t, chromium);
      await noteRedraws(page);
      // B shown first, so that it is on the page, hidden, at the pick; then A shown.
      await clickRow(page, S2);
      await untilShown(page, TERM_B);
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      assert.equal(
        await readPage(
          page,
          (term) =>
            document.querySelector<HTMLElement>(`#terminal .tv-term[data-term="${term}"]`)?.hidden,
          TERM_B,
        ),
        true,
        'B is on the page and hidden at the pick',
      );
      const light = await termColours(page, TERM_A);
      const from = d.sent.length;
      await nextPalette(page); // light Iris
      await until(
        async () => (await termColours(page, TERM_A)).background !== light.background,
        'A repainted at the pick',
      );
      await untilRedrawn(page, TERM_A);
      const iris = await termColours(page, TERM_A);
      assert.equal(iris.background, 'rgb(246, 242, 253)', 'the background');
      assert.equal(iris.foreground, 'rgb(36, 21, 35)', 'the text');
      assert.equal(iris.palette[1], 'rgb(205, 49, 49)', 'red');
      await until(() => themesSent(d, from).length > 0, 'the server is told');
      assert.deepEqual(themesSent(d, from).at(-1)?.message['theme'], LIGHT_IRIS_COLOURS);
      await clickRow(page, S2);
      await untilShown(page, TERM_B);
      await untilRedrawn(page, TERM_B);
      assert.deepEqual(await termColours(page, TERM_B), iris, 'B, hidden at the pick, is Iris');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'the colour themes survive a reload: from the first painted frame on, every frame is in the stored theme, also while the early script and the modules are held back 600 ms; a second page of the same profile follows a pick at once and tells its server its colours',
    async (t) => {
      const context: BrowserContext = await newContext(chromium);
      t.after(() => context.close());
      const one = await context.newPage();
      const two = await context.newPage();
      const problems = [one, two].map((page) => problemsOf(page));
      for (const page of [one, two]) await systemScheme(page, 'dark');
      const d = await deck(t);
      await open(d, one);
      await open(d, two, false); // the same profile: the key is stored already
      const from = d.sent.length;
      await nextPalette(one); // dark Iris
      await until(async () => (await paletteState(two)).dark === 'iris', 'the second page follows');
      await showsPalette(two, 'dark', 'iris', 'the second page');
      assert.equal((await computed(two))['--bg'], (await computed(one))['--bg'], 'its colours');
      await until(
        () => new Set(themesSent(d, from).map((entry) => entry.n)).size === 2,
        'both pages tell their server',
      );
      for (const entry of themesSent(d, from)) {
        assert.deepEqual(entry.message['theme'], DARK_IRIS_COLOURS, `connection ${entry.n}`);
      }

      await two.close();
      await one.addInitScript(FRAMES);
      const bg = (await computed(one))['--bg'];
      for (const held of [0, 600]) {
        if (held > 0) await slow(one, held);
        await one.reload();
        await connection(one, 'open');
        const { frames, firstPaint } = await framesOf(one);
        assert.ok(firstPaint > 0, 'the page was painted');
        assert.ok(
          (frames[0]?.at ?? Infinity) <= firstPaint + 1,
          `the first recorded frame (${frames[0]?.at}) comes no later than the first paint (${firstPaint})`,
        );
        const other = frames.filter((frame) => frame.bg !== bg);
        assert.deepEqual(other, [], `held ${held} ms: no frame in another theme`);
        await showsPalette(one, 'dark', 'iris', `after the reload (held ${held} ms)`);
        await one.unrouteAll();
      }
      assert.deepEqual(
        d.starts().at(-1)?.['theme'],
        DARK_IRIS_COLOURS,
        'the start after the reload',
      );
      for (const found of problems) assert.deepEqual(found, []);
    },
  );
});
