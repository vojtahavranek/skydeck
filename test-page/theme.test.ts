// The title bar's theme switch (follow-up F13; S2 12.1, 7.2): a button beside `Switch…` that
// goes Auto → Light → Dark → Auto, remembered in the page's localStorage and applied before the
// first paint (web/theme-early.js); forced dark is exactly the system's dark and forced light the
// system's light, for every custom property of the three style sheets that have a dark scheme;
// every terminal of the page is repainted at a click; a second page of the profile follows (the
// `storage` event); a click leaves the keyboard where it was; a stored value that is no choice, or
// storage that throws or is missing, is the system's. The page tells the server its colours again
// (`theme`), and the server answers OSC 10 / 11 from them. The page has web/'s real modules, on a
// scripted stand-in server (helpers/shell.ts) and, for the answers, on a real test server with the
// stand-in program.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import type { Browser, BrowserContext, Page } from 'playwright';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { THEME_KEY, themeTitle, themeWord } from '../web/theme-text.js';
import type { Theme } from '../web/theme-text.js';
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

/** Sixteen cells, one in each ANSI colour (the cell's text is the colour's number in hex). */
const PALETTE =
  '\x1b[H' +
  Array.from({ length: 16 }, (_, n) => `\x1b[${n < 8 ? 30 + n : 82 + n}m${n.toString(16)}`).join(
    '',
  ) +
  '\x1b[0m plain text to select';

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

/** What the switch shows and keeps: the word, the title, `<html data-theme>`, the stored value. */
async function switchState(page: Page): Promise<{
  word: string;
  glyph: string;
  title: string;
  attribute: string | null;
  stored: string | null;
}> {
  return readPage(
    page,
    (key) => {
      const button = document.getElementById('theme-button');
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(key);
      } catch {
        stored = 'throws';
      }
      return {
        word: button?.querySelector('.theme-word')?.textContent ?? '',
        glyph: button?.querySelector('.theme-glyph')?.textContent ?? '',
        title: button?.getAttribute('title') ?? '',
        attribute: document.documentElement.getAttribute('data-theme'),
        stored,
      };
    },
    THEME_KEY,
  );
}

/** Asserts what the switch shows in `theme`. */
async function shows(page: Page, theme: Theme, where: string): Promise<void> {
  const now = await switchState(page);
  assert.equal(now.word, themeWord(theme), `${where}: the word`);
  assert.equal(now.title, themeTitle(theme), `${where}: the title`);
  assert.equal(now.glyph, '◐', `${where}: the half circle`);
  assert.equal(now.attribute, theme === 'system' ? null : theme, `${where}: <html data-theme>`);
}

/** A mouse click on the switch, as the user's (mousedown, mouseup, click). */
async function clickSwitch(page: Page): Promise<void> {
  await page.locator('#theme-button').click();
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

/** Waits until the shown terminal is `term` and has drawn its sixteen colours. */
async function untilShown(page: Page, term: string): Promise<void> {
  await until(async () => (await shownTerm(page)) === term, `${term} shown`);
  await until(
    async () => (await termColours(page, term)).palette.every((colour) => colour !== null),
    `${term} drew its colours`,
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

test("the title bar's theme switch (follow-up F13)", async (t) => {
  const chromium = await browser(t);

  await t.test(
    'the button sits in the title bar right before `Switch…`, in its style: a half circle and `Auto`; each click goes to the next state — Light, Dark, Auto — with its word and its hover title, keeps it in localStorage (`light`, `dark`, removed for Auto) and on <html data-theme>; `Switch…` does not move',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      const layout = await readPage(
        page,
        () => {
          const button = document.getElementById('theme-button');
          const sw = document.getElementById('switch-button');
          const style = (element: Element | null): Record<string, string> => {
            if (element === null) return {};
            const s = getComputedStyle(element);
            return {
              fontSize: s.fontSize,
              color: s.color,
              background: s.backgroundColor,
              border: s.borderTopColor + ' ' + s.borderTopWidth + ' ' + s.borderTopStyle,
              radius: s.borderTopLeftRadius,
              padding: s.padding,
              cursor: s.cursor,
            };
          };
          return {
            parent: button?.parentElement?.className ?? null,
            next: button?.nextElementSibling?.id ?? null,
            type: button?.getAttribute('type') ?? null,
            glyphHidden: button?.querySelector('.theme-glyph')?.getAttribute('aria-hidden') ?? null,
            mine: style(button),
            switch: style(sw),
          };
        },
        null,
      );
      assert.equal(layout.parent, 'titlebar');
      assert.equal(layout.next, 'switch-button', 'right before Switch…');
      assert.equal(layout.type, 'button');
      assert.equal(layout.glyphHidden, 'true', 'the glyph is not read out');
      assert.deepEqual(layout.mine, layout.switch, "the title bar's own style, as Switch…'s");
      await shows(page, 'system', 'at first');
      assert.equal((await switchState(page)).stored, null);

      const switchAt = async (): Promise<number[]> =>
        readPage(
          page,
          () => {
            const box = document.getElementById('switch-button')?.getBoundingClientRect();
            const mine = document.getElementById('theme-button')?.getBoundingClientRect();
            return [box?.left ?? -1, box?.width ?? -1, mine?.left ?? -1, mine?.width ?? -1];
          },
          null,
        );
      const at = await switchAt();
      for (const [theme, stored] of [
        ['light', 'light'],
        ['dark', 'dark'],
        ['system', null],
        ['light', 'light'],
      ] as const) {
        await clickSwitch(page);
        await shows(page, theme, `after a click to ${theme}`);
        assert.equal((await switchState(page)).stored, stored, `${theme}: stored`);
        assert.deepEqual(await switchAt(), at, `${theme}: neither button moves or changes width`);
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

      await clickSwitch(page); // Light, under a dark system
      await shows(page, 'light', 'forced light');
      assert.deepEqual(await computed(page), light, 'forced light under a dark system');
      await clickSwitch(page); // Dark, under a dark system
      assert.deepEqual(await computed(page), dark, 'forced dark under a dark system');
      await systemScheme(page, 'light');
      assert.deepEqual(await computed(page), dark, 'forced dark under a light system');
      await clickSwitch(page); // Auto
      assert.deepEqual(await computed(page), light, 'Auto under a light system');
      await clickSwitch(page); // Light, under a light system
      assert.deepEqual(await computed(page), light, 'forced light under a light system');
      await systemScheme(page, 'dark');
      assert.deepEqual(await computed(page), light, 'forced light does not follow the system');
      await clickSwitch(page);
      await clickSwitch(page); // Auto, under a dark system
      assert.deepEqual(await computed(page), dark, 'Auto follows the system again');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'at a click every terminal of the page is repainted in the new colours — background, text, the sixteen colours and the selection — as after a flip of the system: the shown one at once, a hidden one when it is shown again',
    async (t) => {
      const { page, problems } = await opened(t, chromium);
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      await selectFirstLine(page, TERM_A);
      const light = await termColours(page, TERM_A);
      await systemScheme(page, 'dark');
      await until(
        async () => (await termColours(page, TERM_A)).background !== light.background,
        'the system’s flip repaints the terminal',
      );
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

      await clickSwitch(page); // Light: nothing changes under a light system
      assert.deepEqual(await termColours(page, TERM_B), light);
      await clickSwitch(page); // Dark, under a light system
      await until(
        async () => (await termColours(page, TERM_B)).background === dark.background,
        'B repainted at the click',
      );
      assert.deepEqual(await termColours(page, TERM_B), dark, 'B in the dark colours');
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      assert.deepEqual(await termColours(page, TERM_A), dark, 'A, hidden at the click, is dark');

      await clickSwitch(page); // Auto: the light system's again
      await until(
        async () => (await termColours(page, TERM_A)).background === light.background,
        'A repainted at the click',
      );
      assert.deepEqual(await termColours(page, TERM_A), light);
      await clickRow(page, S2);
      await untilShown(page, TERM_B);
      assert.deepEqual(await termColours(page, TERM_B), light, 'B, hidden at the click, is light');
      assert.deepEqual(problems, []);
    },
  );

  await t.test(
    'a mouse click on the switch leaves the keyboard where it was: in the terminal (what is typed next goes to its program) and in the list; Enter on the switch, given the keyboard by Tab, goes on by one state, a held Enter or Space by one only, a held Tab or Shift+Tab walks on past it',
    async (t) => {
      const { page, d, problems } = await opened(t, chromium);
      await clickRow(page, S1);
      await untilShown(page, TERM_A);
      await toZone(page, 'terminal');
      assert.equal(await active(page), 'in #terminal');
      await clickSwitch(page);
      await shows(page, 'light', 'clicked from the terminal');
      await sleep(100); // the page's own keyboard rules run after a mouseup (a timer of 0)
      assert.equal(await active(page), 'in #terminal', 'the terminal keeps the keyboard');
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
      await clickSwitch(page);
      await shows(page, 'dark', 'clicked from the list');
      await sleep(100);
      assert.equal(await active(page), '#list', 'the list keeps the keyboard');
      assert.equal(await zone(page), 'Focus: list');

      await page.focus('#theme-button');
      await page.keyboard.press('Enter');
      await shows(page, 'system', 'Enter on the switch');
      assert.equal(await active(page), '#theme-button');

      // A held key acts once (S2 12.9): six keydowns of one held Enter, or of a held Space, go on
      // by one state and tell the server once (review 2, C2).
      for (const [key, theme] of [
        ['Enter', 'light'],
        ['Space', 'dark'],
      ] as const) {
        const before = d.sent.length;
        for (let i = 0; i < 6; i++) await page.keyboard.down(key);
        await page.keyboard.up(key);
        await sleep(300);
        await shows(page, theme, `a held ${key}`);
        assert.equal(themesSent(d, before).length, 1, `a held ${key}: one theme message`);
      }
      // A held Tab or Shift+Tab walks on past the switch, as everywhere in the page (review 2, S5):
      // only a held Enter's repeats are cancelled. What took the keyboard on the way is recorded:
      // the walk went through the switch and on.
      const walk = async (start: () => Promise<void>, shift: boolean): Promise<string[]> => {
        await start();
        await page.evaluate(() => {
          const trail: string[] = [];
          Reflect.set(globalThis, 'focusTrail', trail);
          document.addEventListener('focusin', (event) => {
            const target = event.target;
            trail.push(
              target instanceof HTMLElement && target.id !== '' ? `#${target.id}` : 'other',
            );
          });
        });
        if (shift) await page.keyboard.down('Shift');
        for (let i = 0; i < 6; i++) await page.keyboard.down('Tab');
        await page.keyboard.up('Tab');
        if (shift) await page.keyboard.up('Shift');
        return page.evaluate(() => [...(Reflect.get(globalThis, 'focusTrail') as string[])]);
      };
      for (const [what, start, shift] of [
        // Backward from the list: the switch comes after `Switch…`.
        ['Shift+Tab', () => page.focus('#list'), true],
        // Forward from the page's last control (the key bar's `+ New`): Tab wraps through the
        // document to the title bar, whose first control is the switch.
        ['Tab', () => page.focus('#new-button'), false],
      ] as const) {
        const trail = await walk(start, shift);
        const at = trail.indexOf('#theme-button');
        assert.ok(at !== -1, `a held ${what} reaches the switch: ${trail.join(' ')}`);
        assert.ok(trail.length > at + 1, `a held ${what} walks on past it: ${trail.join(' ')}`);
        assert.notEqual(await active(page), '#theme-button', `a held ${what} does not stop there`);
        await shows(page, 'dark', `a held ${what} changes no state`);
      }
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
      await clickSwitch(page);
      await clickSwitch(page); // Dark, under a light system
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
      await clickSwitch(page);
      await clickSwitch(page); // Light
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
    'a second page of the same profile follows a click at once (the storage event): its word, <html data-theme>, its colours, and it tells its server its colours',
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
        await clickSwitch(one);
        await shows(one, theme, `the clicked page, ${theme}`);
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
    'a stored value that is neither `light` nor `dark` is the system’s, and a click still goes to Light and stores it',
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
      await clickSwitch(page);
      await shows(page, 'light', 'a click');
      assert.equal((await switchState(page)).stored, 'light', 'the click stores its choice');
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
      `${what}: the page follows the system; the button still works for the life of the page (and tells the server); a reload is the system's again`,
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
        await clickSwitch(page);
        await clickSwitch(page);
        await shows(page, 'dark', 'two clicks');
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
    'the page tells the server its colours again (`theme`, exactly fg and bg): after each click whose colours are new or not, after a flip of the system while it follows the system, never after a flip while forced; a reconnect’s start carries the colours of the moment',
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
      await clickSwitch(page); // Light
      await expect([LIGHT_COLOURS], 'a click to Light');
      await clickSwitch(page); // Dark
      await expect([DARK_COLOURS], 'a click to Dark');
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
      await clickSwitch(page); // Auto, light system
      await expect([LIGHT_COLOURS], 'a click to Auto');
      await systemScheme(page, 'dark');
      await expect([DARK_COLOURS], 'the system flips to dark');
      await systemScheme(page, 'light');
      await expect([LIGHT_COLOURS], 'and back');

      // A new connection: its start has the colours of now.
      await clickSwitch(page);
      await clickSwitch(page); // Dark
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
    "on a real server, a program's OSC 10 and OSC 11 questions are answered with the colours of the page's switch: light at first, dark after the clicks to Dark, light again at Auto (the stand-in's /query)",
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
      await clickSwitch(l.page);
      await clickSwitch(l.page); // Dark
      assert.equal(await active(l.page), 'in #terminal', 'the clicks left the keyboard there');
      assert.deepEqual(await asked(), DARK_COLOURS, 'after the clicks to Dark');
      await clickSwitch(l.page); // Auto, light system
      assert.deepEqual(await asked(), LIGHT_COLOURS, 'at Auto');
      assert.deepEqual(l.problems, []);
    },
  );
});
