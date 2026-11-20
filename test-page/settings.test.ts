// The settings screen in the page (follow-up F36, issue #164; S2 12.13): opened by the title bar's
// `Settings` and by the switcher's `> settings`; the file's path on top, every setting in the
// server's order under its group, a changeable one in a control that fits it with Save and
// Default, a shown-only one as text with what it names; a save, a refusal beside the field, a
// default; the keyboard (Tab stays inside, Enter saves the field, Esc closes, the keyboard goes
// back where it was); every theme with the contrast rule; a small window that scrolls inside the
// dialog; text as text; a second window of the same server following a change; a broken file. On
// a real test server (helpers/shell.ts `launched`) with the sandbox's config.json, never a real
// home.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { S1 } from '../test/helpers/platform.ts';
import { PALETTES } from '../web/theme-text.js';
import { browser } from './helpers/browser.ts';
import {
  active,
  connection,
  launched,
  pageUrl,
  readPage,
  showsText,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import { until } from './helpers/terminal.ts';

function configOf(l: Launched): Record<string, unknown> {
  return JSON.parse(readFileSync(l.d.deck.places.configPath, 'utf8')) as Record<string, unknown>;
}

const row = (key: string): string => `#settings .setting[data-key="${key}"]`;

/** Whether the screen is shown and drawn (its rows came). */
async function shown(page: Page): Promise<boolean> {
  return readPage(
    page,
    () =>
      document.getElementById('settings')?.hidden === false &&
      document.querySelectorAll('#settings .setting').length > 0,
    null,
  );
}

async function opened(page: Page): Promise<void> {
  await until(() => shown(page), 'the settings screen is shown and drawn');
}

async function closed(page: Page): Promise<void> {
  await until(
    async () =>
      (await readPage(page, () => document.getElementById('settings')?.hidden, null)) === true,
    'the settings screen is closed',
  );
}

/** The text of the element `selector` inside the row of `key`. */
function partOf(page: Page, key: string, selector: string): Promise<string> {
  return readPage(
    page,
    ({ at, part }) => document.querySelector(`${at} ${part}`)?.textContent ?? '',
    { at: row(key), part: selector },
  );
}

/** The control's value of `key`. */
function fieldOf(page: Page, key: string): Promise<string> {
  return readPage(
    page,
    (at) =>
      (document.querySelector(`${at} .setting-control`) as HTMLInputElement | null)?.value ?? '',
    row(key),
  );
}

async function messageIs(page: Page, key: string, expected: string | RegExp): Promise<void> {
  await until(
    async () => {
      const text = await partOf(page, key, '.setting-message');
      return typeof expected === 'string' ? text === expected : expected.test(text);
    },
    `${key}'s message ${String(expected)}`,
  );
}

/** Whether the keyboard is inside the settings screen. */
function keyboardInside(page: Page): Promise<boolean> {
  return readPage(
    page,
    () =>
      document.activeElement !== null &&
      document.getElementById('settings')?.contains(document.activeElement) === true,
    null,
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

test('the settings screen (F36, S2 12.13)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "the title bar's Settings opens it: the file's path on top, every setting in the server's order under its group, a changeable one in its control, a shown-only one as text",
    async (t) => {
      const l = await launched(t, chromium, {
        config: { prRefreshMinutes: 7, window: { links: 'edge' } },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await showsText(
        l.page,
        '#settings .settings-file',
        new RegExp(`${l.d.deck.places.configPath}$`),
      );
      const drawn = await readPage(
        l.page,
        () => ({
          keys: [...document.querySelectorAll('#settings .setting')].map(
            (one) => (one as HTMLElement).dataset['key'],
          ),
          groups: [...document.querySelectorAll('#settings .settings-group')].map(
            (one) => one.textContent,
          ),
        }),
        null,
      );
      assert.deepEqual(drawn.keys.slice(0, 3), ['terminal', 'wezterm.domain', 'groupPattern']);
      assert.equal(drawn.keys.length, 18);
      assert.deepEqual(drawn.groups, [
        'Starting sessions',
        'The list',
        'Install',
        'Pull requests',
        'Restore',
        'Claude Code',
        'Tickets',
        'The window',
      ]);
      assert.equal(await fieldOf(l.page, 'prRefreshMinutes'), '7');
      assert.equal(
        await partOf(l.page, 'prRefreshMinutes', '.setting-facts'),
        'default 5 · set in the file',
      );
      assert.equal(await partOf(l.page, 'prRefreshMinutes', '.setting-applies'), 'applies at once');
      assert.equal(await fieldOf(l.page, 'window.links'), 'edge');
      assert.equal(
        await readPage(
          l.page,
          (at) => document.querySelector(`${at} select`) !== null,
          row('window.links'),
        ),
        true,
        'a choice',
      );
      assert.equal(
        await readPage(
          l.page,
          (at) => (document.querySelector(`${at} input`) as HTMLInputElement | null)?.type,
          row('prRefreshMinutes'),
        ),
        'number',
      );
      assert.equal(
        await partOf(l.page, 'claudeCommand', '.setting-value'),
        JSON.stringify(l.d.standin),
      );
      assert.equal(
        await partOf(l.page, 'claudeCommand', '.setting-applies'),
        'names a program: it is changed in the file only',
      );
      assert.equal(
        await readPage(
          l.page,
          (at) => document.querySelector(`${at} input, ${at} button`),
          row('claudeCommand'),
        ),
        null,
        'no control, no Save',
      );
      assert.equal(
        await partOf(l.page, 'window.port', '.setting-applies'),
        "is the window's port: it is changed in the file only",
      );
      assert.equal(
        await partOf(l.page, 'terminal', '.setting-applies'),
        'used by the commands at their next run; the window does not use it',
      );
      assert.equal(await keyboardInside(l.page), true, 'the keyboard is in the screen');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a save, a refusal beside the field, a default: the file follows each, the messages say when it applies',
    async (t) => {
      const l = await launched(t, chromium, { config: { prRefreshMinutes: 7 } });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const field = l.page.locator(`${row('prRefreshMinutes')} .setting-control`);
      await field.fill('9');
      await field.press('Enter');
      await messageIs(l.page, 'prRefreshMinutes', 'Saved: it applies at once.');
      assert.equal(configOf(l)['prRefreshMinutes'], 9);
      assert.equal(
        await partOf(l.page, 'prRefreshMinutes', '.setting-facts'),
        'default 5 · set in the file',
      );

      await field.fill('0');
      await l.page.locator(`${row('prRefreshMinutes')} .setting-save`).click();
      await messageIs(l.page, 'prRefreshMinutes', '"prRefreshMinutes" must be a positive integer');
      assert.equal(await fieldOf(l.page, 'prRefreshMinutes'), '0', 'the text stays in the field');
      assert.equal(configOf(l)['prRefreshMinutes'], 9, 'the file as it was');

      const pattern = l.page.locator(`${row('groupPattern')} .setting-control`);
      await pattern.fill('(');
      await pattern.press('Enter');
      await messageIs(l.page, 'groupPattern', /^"groupPattern" is not a valid regular expression/);

      await l.page.locator(`${row('prRefreshMinutes')} .setting-reset`).click();
      await messageIs(l.page, 'prRefreshMinutes', 'Put back to its default: it applies at once.');
      assert.equal(await fieldOf(l.page, 'prRefreshMinutes'), '5');
      assert.equal(Object.hasOwn(configOf(l), 'prRefreshMinutes'), false);

      await l.page.locator(`${row('window.keepAlive')} select`).selectOption('wsl');
      await l.page.locator(`${row('window.keepAlive')} .setting-save`).click();
      await messageIs(l.page, 'window.keepAlive', 'Saved: it applies after the window restarts.');
      assert.equal(
        await partOf(l.page, 'window.keepAlive', '.setting-pending'),
        'applies after the window restarts: the window uses "off" until then',
      );
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "the keyboard: the switcher's > settings opens it; Tab and Shift+Tab stay inside; Enter saves the field it is in; Esc closes and the keyboard goes back where it was",
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await toZone(l.page, 'list');
      const before = await active(l.page);
      await l.page.keyboard.press('Control+Shift+P');
      await l.page.keyboard.type('> set');
      await showsText(l.page, '#switcher .switcher-offer[data-offer="settings"]', /^Settings/);
      await l.page.keyboard.press('Enter');
      await opened(l.page);
      await until(() => keyboardInside(l.page), 'the keyboard in the screen');
      const count = await readPage(
        l.page,
        () =>
          document.querySelectorAll('#settings input, #settings select, #settings button').length,
        null,
      );
      for (let i = 0; i < count + 3; i++) {
        await l.page.keyboard.press('Tab');
        assert.equal(await keyboardInside(l.page), true, `Tab ${i + 1} stays inside`);
      }
      for (let i = 0; i < count + 3; i++) {
        await l.page.keyboard.press('Shift+Tab');
        assert.equal(await keyboardInside(l.page), true, `Shift+Tab ${i + 1} stays inside`);
      }
      await l.page.locator(`${row('restoreBatch')} .setting-control`).focus();
      await l.page.keyboard.press('Control+a');
      await l.page.keyboard.type('2');
      await l.page.keyboard.press('Enter');
      await messageIs(l.page, 'restoreBatch', 'Saved: it applies at once.');
      assert.equal(configOf(l)['restoreBatch'], 2);
      await l.page.keyboard.press('Control+Shift+N');
      await showsText(l.page, '#key-message', /^close the settings first \(Esc\)$/);
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      assert.equal(await active(l.page), before, 'the keyboard back where it was');
      // And from the title bar, with the keyboard in the list: back to the list.
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      assert.equal(await active(l.page), before);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'every theme, light and dark, each colour theme: the texts of the screen hold 4.5 : 1 against their ground',
    async (t) => {
      const l = await launched(t, chromium);
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const refused = l.page.locator(`${row('restoreBatch')} .setting-control`);
      await refused.fill('0');
      await refused.press('Enter');
      await messageIs(l.page, 'restoreBatch', '"restoreBatch" must be a positive integer');
      await l.page.locator(`${row('window.keepAlive')} select`).selectOption('wsl');
      await l.page.locator(`${row('window.keepAlive')} .setting-save`).click();
      await messageIs(l.page, 'window.keepAlive', /^Saved/);
      const combinations: { scheme: 'light' | 'dark'; palette: string }[] = [
        ...PALETTES.light.map((palette) => ({ scheme: 'light' as const, palette })),
        ...PALETTES.dark.map((palette) => ({ scheme: 'dark' as const, palette })),
      ];
      for (const { scheme, palette } of combinations) {
        await l.page.evaluate(
          ({ scheme, palette }) => {
            const html = document.documentElement;
            html.dataset['theme'] = scheme;
            const name = scheme === 'light' ? 'paletteLight' : 'paletteDark';
            if (palette === 'default') delete html.dataset[name];
            else html.dataset[name] = palette;
          },
          { scheme, palette },
        );
        const pairs = await readPage(
          l.page,
          (at) => {
            /** The first ground behind `element` that is not transparent. */
            const ground = (element: Element): string => {
              for (let e: Element | null = element; e !== null; e = e.parentElement) {
                const colour = getComputedStyle(e).backgroundColor;
                if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
              }
              return getComputedStyle(document.body).backgroundColor;
            };
            const selectors = [
              '#settings .settings-heading',
              '#settings .settings-file',
              '#settings .settings-path',
              '#settings .settings-copy',
              '#settings .settings-help',
              '#settings .settings-group',
              `${at.refused} .setting-key`,
              `${at.refused} .setting-meaning`,
              `${at.refused} .setting-control`,
              `${at.refused} .setting-facts`,
              `${at.refused} .setting-applies`,
              `${at.refused} .setting-message`,
              `${at.refused} .setting-reset`,
              `${at.refused} .setting-save`,
              `${at.pending} .setting-pending`,
              `${at.pending} .setting-message`,
              `${at.shown} .setting-value`,
              '#settings .settings-close',
              '#settings-button',
            ];
            return selectors.map((selector) => {
              const element = document.querySelector(selector);
              return element === null
                ? { selector, fg: 'missing', bg: 'missing' }
                : { selector, fg: getComputedStyle(element).color, bg: ground(element) };
            });
          },
          {
            refused: row('restoreBatch'),
            pending: row('window.keepAlive'),
            shown: row('claudeCommand'),
          },
        );
        for (const { selector, fg, bg } of pairs) {
          assert.notEqual(fg, 'missing', `${selector} is drawn`);
          assert.ok(
            contrast(fg, bg) >= 4.5,
            `${scheme} ${palette}: ${selector} ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)} : 1`,
          );
        }
      }
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a small window: the dialog stays inside it and scrolls inside itself to its last setting',
    async (t) => {
      const l = await launched(t, chromium);
      await l.page.setViewportSize({ width: 420, height: 320 });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const box = await readPage(
        l.page,
        () => {
          const dialog = document.querySelector('#settings .settings-dialog') as HTMLElement;
          const rect = dialog.getBoundingClientRect();
          return {
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            scrolls: dialog.scrollHeight > dialog.clientHeight,
            wide: dialog.scrollWidth > dialog.clientWidth,
            width: innerWidth,
            height: innerHeight,
          };
        },
        null,
      );
      assert.ok(box.top >= 0 && box.left >= 0, JSON.stringify(box));
      assert.ok(box.right <= box.width && box.bottom <= box.height, JSON.stringify(box));
      assert.equal(box.scrolls, true, 'it scrolls inside itself');
      assert.equal(box.wide, false, 'nothing is wider than it');
      const last = l.page.locator(`${row('window.links')} .setting-save`);
      await last.scrollIntoViewIfNeeded();
      await last.click();
      await messageIs(l.page, 'window.links', /^Saved/);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'text as text: a value with markup, a very long one and a right-to-left one are shown and edited as they are',
    async (t) => {
      const markup = '<img src=x onerror="document.title=1">';
      const rtl = 'שלום-[0-9]+';
      const long = `https://tickets.example.com/${'a'.repeat(1900)}/`;
      const l = await launched(t, chromium, {
        config: {
          groupPattern: `${markup}|${rtl}`,
          ticketStatus: [{ match: long, command: [markup, '{key}'] }],
        },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      assert.equal(await fieldOf(l.page, 'groupPattern'), `${markup}|${rtl}`);
      const shownValue = await partOf(l.page, 'ticketStatus', '.setting-value');
      assert.equal(shownValue, JSON.stringify([{ match: long, command: [markup, '{key}'] }]));
      assert.equal(
        await readPage(l.page, () => document.querySelectorAll('#settings img').length, null),
        0,
        'no markup was made',
      );
      const wide = await readPage(
        l.page,
        () => {
          const dialog = document.querySelector('#settings .settings-dialog') as HTMLElement;
          return dialog.scrollWidth > dialog.clientWidth;
        },
        null,
      );
      assert.equal(wide, false, 'a long value wraps inside the dialog');
      const field = l.page.locator(`${row('groupPattern')} .setting-control`);
      await field.fill(`${rtl}|x`);
      await field.press('Enter');
      await messageIs(l.page, 'groupPattern', /^Saved/);
      assert.equal(configOf(l)['groupPattern'], `${rtl}|x`);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a second window of the same server: its open screen follows a change made in the first; a field it is editing keeps its text',
    async (t) => {
      const l = await launched(t, chromium, { config: { prRefreshMinutes: 7 } });
      const other = await l.page.context().newPage();
      await other.goto(pageUrl(l.server.port));
      await connection(other, 'open');
      for (const page of [l.page, other]) {
        await page.locator('#settings-button').click();
        await opened(page);
      }
      const typing = other.locator(`${row('restoreBatch')} .setting-control`);
      await typing.fill('4');
      const field = l.page.locator(`${row('prRefreshMinutes')} .setting-control`);
      await field.fill('11');
      await field.press('Enter');
      await messageIs(l.page, 'prRefreshMinutes', 'Saved: it applies at once.');
      await until(
        async () => (await fieldOf(other, 'prRefreshMinutes')) === '11',
        'the second window follows',
      );
      assert.equal(await fieldOf(other, 'restoreBatch'), '4', 'its own typing stays');
      // Opened again, the second window reads the file as it is now.
      await other.keyboard.press('Escape');
      await closed(other);
      writeFileSync(
        l.d.deck.places.configPath,
        JSON.stringify({ ...configOf(l), restoreMinFreeMb: 2048 }),
      );
      await other.locator('#settings-button').click();
      await opened(other);
      await until(
        async () => (await fieldOf(other, 'restoreMinFreeMb')) === '2048',
        'the hand edit',
      );
      assert.equal(await fieldOf(other, 'restoreBatch'), '3', 'nothing typed before stays');
      assert.equal(
        await partOf(other, 'restoreMinFreeMb', '.setting-pending'),
        'applies after the window restarts: the window uses 4096 until then',
      );
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a broken file: the screen says what doctor says and that it is mended by hand first; a save is refused and the file stays as it was',
    async (t) => {
      const l = await launched(t, chromium);
      const broken = '{ "prRefreshMinutes": 7, }';
      writeFileSync(l.d.deck.places.configPath, broken);
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await showsText(
        l.page,
        '#settings .settings-problem-text',
        new RegExp(
          `^${l.d.deck.places.configPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: not valid JSON`,
        ),
      );
      await showsText(l.page, '#settings .settings-problem-mend', /by hand first/);
      const field = l.page.locator(`${row('prRefreshMinutes')} .setting-control`);
      await field.fill('9');
      await field.press('Enter');
      await messageIs(
        l.page,
        'prRefreshMinutes',
        /mend the file by hand first: nothing was changed$/,
      );
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), broken);
      assert.deepEqual(l.problems, []);
    },
  );
});
