// The settings screen in the page (follow-up F36, issue #164; S2 12.13): opened by the title bar's
// gear (F39) and by the switcher's `> settings`. F39's short screen: four groups (the fourth,
// Updates, F38's), seven controls under plain labels, each saved as it is picked, a refusal beside it, `after a restart`; then the
// closed Advanced, which holds F36's screen of every other setting: the file's path on top, each
// setting in the server's order under its group, a changeable one in a control that fits it with
// Save and Default, a shown-only one as text with what it names; a save, a refusal beside the
// field, a default; the keyboard (Tab stays inside, Enter saves the field, Esc closes, the keyboard goes
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
  shownText,
  toZone,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import { until } from './helpers/terminal.ts';

function configOf(l: Launched): Record<string, unknown> {
  return JSON.parse(readFileSync(l.d.deck.places.configPath, 'utf8')) as Record<string, unknown>;
}

const row = (key: string): string => `#settings .setting[data-key="${key}"]`;

/** Whether the screen is shown and drawn from this opening's answer. */
async function shown(page: Page): Promise<boolean> {
  return readPage(
    page,
    () =>
      document.getElementById('settings')?.hidden === false &&
      document.querySelectorAll('#settings .setting').length > 0 &&
      // The server's answer of this opening came (`Reading the settings…` gone).
      (document.querySelector('#settings .settings-status') as HTMLElement | null)?.hidden === true,
    null,
  );
}

async function opened(page: Page): Promise<void> {
  await until(() => shown(page), 'the settings screen is shown and drawn');
}

/** Opens the screen's closed Advanced with a click on its button. */
async function advanced(page: Page): Promise<void> {
  await page.locator('#settings .settings-advanced-button').click();
  await until(
    async () =>
      (await readPage(page, () => document.getElementById('settings-advanced')?.hidden, null)) ===
      false,
    'Advanced is open',
  );
}

/** The short screen's row of `key`, and its control. */
const short = (key: string): string => `#settings .short-setting[data-key="${key}"]`;
const shortControl = (key: string): string => `${short(key)} :is(select, input)`;

/** The words beside the short screen's control of `key`. */
async function shortSays(page: Page, key: string, expected: string | RegExp): Promise<void> {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const text = await readPage(
      page,
      (at) => document.querySelector(`${at} .short-message`)?.textContent ?? '',
      short(key),
    );
    if (typeof expected === 'string' ? text === expected : expected.test(text)) return;
    assert.ok(
      performance.now() < deadline,
      `${key}'s words ${String(expected)}; it says ${JSON.stringify(text)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** From now on counts the `setting-set` acts the page sends (WebSocket.prototype.send, wrapped). */
async function countSets(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    Reflect.set(globalThis, 'testSets', 0);
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && data.includes('"kind":"setting-set"')) {
        Reflect.set(globalThis, 'testSets', Number(Reflect.get(globalThis, 'testSets')) + 1);
      }
      send.call(this, data);
    };
  });
  return () => page.evaluate(() => Number(Reflect.get(globalThis, 'testSets')));
}

/** From now on holds each act of `kind` back by `ms` before it is sent (a slow answer). */
async function holdBack(page: Page, kind: string, ms: number): Promise<void> {
  await page.evaluate(
    ({ kind, ms }) => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes(`"kind":"${kind}"`)) {
          setTimeout(() => send.call(this, data), ms);
          return;
        }
        send.call(this, data);
      };
    },
    { kind, ms },
  );
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
  const deadline = performance.now() + 20_000;
  for (;;) {
    const text = await partOf(page, key, '.setting-message');
    if (typeof expected === 'string' ? text === expected : expected.test(text)) return;
    assert.ok(
      performance.now() < deadline,
      `${key}'s message ${String(expected)}; it says ${JSON.stringify(text)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
    "the title bar's gear opens it: the short screen, then Advanced, closed, whose button counts the rest; opened, the file's path on top, every other setting in the server's order under its group, a changeable one in its control, a shown-only one as text",
    async (t) => {
      const l = await launched(t, chromium, {
        config: { prRefreshMinutes: 7, window: { links: 'edge' } },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await showsText(
        l.page,
        '#settings .settings-advanced-button',
        /^Advanced \(14 more settings\)$/,
      );
      const closedAt = await readPage(
        l.page,
        () => ({
          expanded: document
            .querySelector('#settings .settings-advanced-button')
            ?.getAttribute('aria-expanded'),
          hidden: document.getElementById('settings-advanced')?.hidden,
          file: (
            document.querySelector('#settings .settings-file') as HTMLElement
          ).checkVisibility(),
          buttons: [...document.querySelectorAll('#settings button')]
            .filter((one) => (one as HTMLElement).checkVisibility())
            .map((one) => one.textContent),
        }),
        null,
      );
      assert.deepEqual(closedAt, {
        expanded: 'false',
        hidden: true,
        file: false,
        // F38: the group Updates' `Check now`, the short screen's one button.
        buttons: ['Check now', 'Advanced (14 more settings)', 'Close'],
      });
      await advanced(l.page);
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
          groups: [...document.querySelectorAll('#settings .settings-list .settings-group')].map(
            (one) => one.textContent,
          ),
        }),
        null,
      );
      assert.deepEqual(drawn.keys.slice(0, 3), [
        'wezterm.domain',
        'groupPattern',
        'firstRunDoneAfterDays',
      ]);
      assert.equal(drawn.keys.length, 14);
      for (const key of [
        'terminal',
        'ticketUrl',
        'window.keepAlive',
        'window.links',
        'window.updateCheck',
      ]) {
        assert.ok(!drawn.keys.includes(key), `${key} is on the short screen, not in Advanced`);
      }
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
        await partOf(l.page, 'wezterm.domain', '.setting-applies'),
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
      await advanced(l.page);
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
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "the keyboard: the switcher's > settings opens it, the keyboard on Mode; Tab reaches Advanced's button, Enter and Space open and close it; Tab and Shift+Tab stay inside; Enter saves the field it is in; Esc closes and the keyboard goes back where it was",
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
      assert.equal(await active(l.page), '#settings-mode', 'on the first choice, Mode');
      const onAdvanced = (): Promise<boolean> =>
        readPage(
          l.page,
          () => document.activeElement?.classList.contains('settings-advanced-button') === true,
          null,
        );
      for (let i = 0; i < 20 && !(await onAdvanced()); i++) {
        await l.page.keyboard.press('Tab');
      }
      assert.equal(await onAdvanced(), true, 'Tab reaches Advanced');
      const expanded = (): Promise<string | null | undefined> =>
        readPage(
          l.page,
          () =>
            document
              .querySelector('#settings .settings-advanced-button')
              ?.getAttribute('aria-expanded'),
          null,
        );
      await l.page.keyboard.press('Enter');
      assert.equal(await expanded(), 'true', 'Enter opens it');
      await l.page.keyboard.press('Space');
      assert.equal(await expanded(), 'false', 'Space closes it');
      await l.page.keyboard.press('Enter');
      assert.equal(await expanded(), 'true', 'and opens it again');
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
      // And from the title bar, with the keyboard in the list: back to the list. Advanced is
      // closed again.
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      assert.equal(await expanded(), 'false', 'Advanced is closed at each opening');
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      assert.equal(await active(l.page), before);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    "a save (Enter, Space on Save), a refusal, Default and another window's change move neither the keyboard nor the dialog's scroll; typing goes on",
    async (t) => {
      const l = await launched(t, chromium, { config: { prRefreshMinutes: 7 } });
      await l.page.setViewportSize({ width: 1000, height: 600 });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await advanced(l.page);
      const field = l.page.locator(`${row('restoreBatch')} .setting-control`);
      await field.focus();
      const where = (page: Page, selector: string): Promise<{ holds: boolean; top: number }> =>
        readPage(
          page,
          (at) => ({
            holds: document.activeElement === document.querySelector(at),
            top: (document.querySelector('#settings .settings-dialog') as HTMLElement).scrollTop,
          }),
          selector,
        );
      const fieldAt = `${row('restoreBatch')} .setting-control`;
      const start = await where(l.page, fieldAt);
      assert.ok(start.holds && start.top > 0, JSON.stringify(start));
      await l.page.keyboard.press('Control+a');
      await l.page.keyboard.type('2');
      await l.page.keyboard.press('Enter');
      await messageIs(l.page, 'restoreBatch', 'Saved: it applies at once.');
      assert.deepEqual(await where(l.page, fieldAt), start, 'after a save');
      await l.page.keyboard.press('Control+a');
      await l.page.keyboard.type('0');
      await l.page.keyboard.press('Enter');
      await messageIs(l.page, 'restoreBatch', '"restoreBatch" must be a positive integer');
      assert.deepEqual(await where(l.page, fieldAt), start, 'after a refusal');
      await l.page.keyboard.type('3'); // the field still has the keyboard: `03`
      assert.equal(await fieldOf(l.page, 'restoreBatch'), '03');
      const saveAt = `${row('restoreBatch')} .setting-save`;
      await l.page.locator(saveAt).focus();
      const onSave = await where(l.page, saveAt);
      await l.page.keyboard.press('Space');
      await messageIs(l.page, 'restoreBatch', 'Saved: it applies at once.');
      assert.deepEqual(await where(l.page, saveAt), onSave, 'after Space on Save');
      const resetAt = `${row('restoreBatch')} .setting-reset`;
      await l.page.locator(resetAt).focus();
      const onReset = await where(l.page, resetAt);
      await l.page.keyboard.press('Enter');
      await messageIs(l.page, 'restoreBatch', 'Put back to its default: it applies at once.');
      assert.deepEqual(await where(l.page, resetAt), onReset, 'after Default');

      const other = await l.page.context().newPage();
      await other.setViewportSize({ width: 1000, height: 600 });
      await other.goto(pageUrl(l.server.port));
      await connection(other, 'open');
      await other.locator('#settings-button').click();
      await opened(other);
      await advanced(other);
      const typingAt = `${row('restoreMinFreeMb')} .setting-control`;
      await other.locator(typingAt).focus();
      await other.keyboard.press('Control+a');
      await other.keyboard.type('20');
      const typing = await where(other, typingAt);
      const pr = l.page.locator(`${row('prRefreshMinutes')} .setting-control`);
      await pr.fill('11');
      await pr.press('Enter');
      await until(async () => (await fieldOf(other, 'prRefreshMinutes')) === '11', 'B follows');
      assert.deepEqual(await where(other, typingAt), typing, "B's keyboard and scroll stay");
      await other.keyboard.type('48');
      assert.equal(await fieldOf(other, 'restoreMinFreeMb'), '2048', 'the typing goes on');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a text longer than a request carries (4,096 bytes) is refused before it is sent, in words that name the limit and the file; the connection stays',
    async (t) => {
      const l = await launched(t, chromium);
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await advanced(l.page);
      const before = readFileSync(l.d.deck.places.configPath, 'utf8');
      const field = l.page.locator(`${row('groupPattern')} .setting-control`);
      await field.fill('a'.repeat(5001));
      await field.press('Enter');
      await messageIs(
        l.page,
        'groupPattern',
        'Longer than the window sends (4,096 bytes as UTF-8): change it in the file by hand.',
      );
      await connection(l.page, 'open');
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), before);
      // 4,096 bytes are sent: the server takes it.
      await field.fill('a'.repeat(4096));
      await field.press('Enter');
      await messageIs(l.page, 'groupPattern', 'Saved: it applies at once.');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'text typed and not saved holds nothing back once the screen is closed: a reload in another dialog passes',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await advanced(l.page);
      await l.page.locator(`${row('restoreBatch')} .setting-control`).fill('9');
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      await toZone(l.page, 'list');
      await until(
        async () =>
          (await readPage(
            l.page,
            () => document.querySelector('#list [data-selected="true"]'),
            null,
          )) !== null,
        'a row selected',
      );
      await l.page.keyboard.press('l');
      await until(
        async () =>
          (await readPage(l.page, () => document.getElementById('editor')?.hidden, null)) === false,
        'the label dialog',
      );
      const loaded = l.page.waitForEvent('load', { timeout: 15_000 });
      await l.page.keyboard.press('F5');
      await loaded;
      await connection(l.page, 'open');
      assert.deepEqual(
        l.problems.filter((line) => !/reload/i.test(line)),
        [],
      );
    },
  );

  await t.test(
    'Esc closes the top layer only: the key help over the screen first, then the screen',
    async (t) => {
      const l = await launched(t, chromium);
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const helpShown = (): Promise<boolean> =>
        readPage(l.page, () => document.getElementById('help')?.hidden === false, null);
      await l.page.keyboard.press('Control+Shift+H');
      await until(helpShown, 'the key help over the screen');
      await l.page.keyboard.press('Escape');
      await until(async () => !(await helpShown()), 'the help closed');
      assert.equal(await shown(l.page), true, 'the screen stays');
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the line under a field goes when its text changes; Save with nothing changed sends nothing; a value with a line break is shown as text, changed in the file',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { groupPattern: '^a\nb', window: { links: 'edge' } },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await advanced(l.page);
      const before = readFileSync(l.d.deck.places.configPath, 'utf8');
      // Nothing changed: no request, the file as it was (restoreBatch is not in it).
      const batch = l.page.locator(`${row('restoreBatch')} .setting-control`);
      await batch.press('Enter');
      await messageIs(l.page, 'restoreBatch', 'Nothing changed, nothing saved.');
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), before);
      // The line goes when the field changes.
      await batch.fill('2');
      assert.equal(await partOf(l.page, 'restoreBatch', '.setting-message'), '');
      await batch.press('Enter');
      await messageIs(l.page, 'restoreBatch', 'Saved: it applies at once.');
      await batch.press('3');
      assert.equal(await partOf(l.page, 'restoreBatch', '.setting-message'), '');
      // groupPattern holds a line break: text, a plain line, no field and no Save to write it.
      assert.equal(await partOf(l.page, 'groupPattern', '.setting-value'), JSON.stringify('^a\nb'));
      assert.equal(
        await partOf(l.page, 'groupPattern', '.setting-note'),
        'holds a line break or a control character, which this field cannot show: change it in the file while it does',
      );
      const visible = await readPage(
        l.page,
        (at) =>
          [...document.querySelectorAll(`${at} input, ${at} button`)].filter((one) =>
            (one as HTMLElement).checkVisibility(),
          ).length,
        row('groupPattern'),
      );
      assert.equal(visible, 0);
      assert.equal(configOf(l)['groupPattern'], '^a\nb');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'every theme, light and dark, each colour theme: the texts of the screen hold 4.5 : 1 against their ground',
    async (t) => {
      const l = await launched(t, chromium);
      // A hand edit the running server does not use yet: Advanced's line for it.
      writeFileSync(
        l.d.deck.places.configPath,
        JSON.stringify({ ...configOf(l), restoreMinFreeMb: 2048 }),
      );
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const ticket = l.page.locator(shortControl('ticketUrl'));
      await ticket.fill('nope');
      await ticket.press('Enter');
      await shortSays(l.page, 'ticketUrl', /^"ticketUrl" must be/);
      // The sandbox's file holds `edge` (its Edge is a stub that records links).
      await l.page.locator(shortControl('window.links')).selectOption('default');
      await shortSays(l.page, 'window.links', 'Saved.');
      await advanced(l.page);
      const refused = l.page.locator(`${row('restoreBatch')} .setting-control`);
      await refused.fill('0');
      await refused.press('Enter');
      await messageIs(l.page, 'restoreBatch', '"restoreBatch" must be a positive integer');
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
              `${at.ticket} .short-label`,
              `${at.ticket} .short-control`,
              `${at.ticket} .short-message`,
              `${at.ticket} .short-hint`,
              `${at.links} .short-message`,
              `${at.keepAlive} .short-mark-text`,
              '#settings .settings-advanced-button',
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
            pending: row('restoreMinFreeMb'),
            shown: row('claudeCommand'),
            ticket: short('ticketUrl'),
            links: short('window.links'),
            keepAlive: short('window.keepAlive'),
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
      await advanced(l.page);
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
      const last = l.page.locator(`${row('ticketRefreshMinutes')} .setting-control`);
      await last.scrollIntoViewIfNeeded();
      await last.fill('20');
      const save = l.page.locator(`${row('ticketRefreshMinutes')} .setting-save`);
      await save.scrollIntoViewIfNeeded();
      await save.click();
      await messageIs(l.page, 'ticketRefreshMinutes', /^Saved/);
      const close = l.page.locator('#settings .settings-close');
      await close.scrollIntoViewIfNeeded();
      assert.equal(await close.isVisible(), true, 'the dialog scrolls to its end');
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
      await advanced(l.page);
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
        await advanced(page);
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
      await advanced(other);
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
    'a broken file: the screen says at its top what doctor says and that it is mended by hand first; a pick on the short screen and a save in Advanced are refused and the file stays as it was',
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
      // A pick on the short screen is refused: its words beside it, the switch as it was.
      const keepAlive = l.page.locator(shortControl('window.keepAlive'));
      const was = await keepAlive.isChecked();
      await keepAlive.click();
      await shortSays(
        l.page,
        'window.keepAlive',
        /mend the file by hand first: nothing was changed$/,
      );
      assert.equal(await keepAlive.isChecked(), was, 'the switch shows the value in use again');
      await advanced(l.page);
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
  await t.test(
    'the short screen (F39): four groups, seven controls (F38: Updates) under plain labels, each showing the file’s value; a hint only under three; `after a restart` beside Keep WSL running; no Save, no Default, no line about the default, the file or when a change applies',
    async (t) => {
      const l = await launched(t, chromium, {
        config: {
          ticketUrl: 'https://tickets.example.com/browse/{key}',
          terminal: 'wezterm',
          window: { links: 'edge', keepAlive: 'off' },
        },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const screen = await readPage(
        l.page,
        () =>
          [...document.querySelectorAll('#settings .settings-short-group')].map((group) => ({
            group: group.querySelector('.settings-group')?.textContent,
            rows: [...group.querySelectorAll('.short-setting')].map((one) => {
              const control = one.querySelector('select, input') as
                HTMLSelectElement | HTMLInputElement;
              const visible = (selector: string): string[] =>
                [...one.querySelectorAll(selector)]
                  .filter((part) => (part as HTMLElement).checkVisibility())
                  .map((part) => part.textContent ?? '');
              return {
                label: one.querySelector('label')?.textContent,
                labelled: (one.querySelector('label') as HTMLLabelElement).control === control,
                control:
                  control instanceof HTMLSelectElement
                    ? [...control.options].map((option) => option.textContent)
                    : `${control.type}${control.getAttribute('role') === 'switch' ? ' switch' : ''}`,
                value:
                  control instanceof HTMLInputElement && control.type === 'checkbox'
                    ? control.checked
                    : control.value,
                hint: visible('.short-hint'),
                mark: visible('.short-mark'),
              };
            }),
          })),
        null,
      );
      assert.deepEqual(screen, [
        {
          group: 'Appearance',
          rows: [
            {
              label: 'Mode',
              labelled: true,
              control: ['Auto', 'Light', 'Dark'],
              value: 'system',
              hint: [],
              mark: [],
            },
            {
              label: 'Colour theme',
              labelled: true,
              control: ['Default', 'Iris'],
              value: 'default',
              hint: ['Light and dark each keep their own.'],
              mark: [],
            },
          ],
        },
        {
          group: 'Links',
          rows: [
            {
              label: 'Open links in',
              labelled: true,
              control: ['The default browser', 'Edge'],
              value: 'edge',
              hint: [],
              mark: [],
            },
            {
              label: 'Ticket address',
              labelled: true,
              control: 'text',
              value: 'https://tickets.example.com/browse/{key}',
              hint: ['With {key} where the ticket key goes. Empty: no link.'],
              mark: [],
            },
          ],
        },
        {
          group: 'The window',
          rows: [
            {
              label: 'Keep WSL running',
              labelled: true,
              control: 'checkbox switch',
              value: false,
              hint: [],
              mark: ['after a restart'],
            },
            {
              label: 'Typed commands start sessions in',
              labelled: true,
              control: ['That terminal', 'A WezTerm tab', 'The window'],
              value: 'wezterm',
              hint: ['skydeck resume, new and restore, typed in a terminal.'],
              mark: [],
            },
          ],
        },
        {
          // F38: the check for a newer skydeck (off in the sandbox), its extra block after it.
          group: 'Updates',
          rows: [
            {
              label: 'Check for updates every day',
              labelled: true,
              control: 'checkbox switch',
              value: false,
              hint: [],
              mark: [],
            },
          ],
        },
      ]);
      const words = await readPage(
        l.page,
        () =>
          [...document.querySelectorAll('#settings .settings-dialog *')]
            .filter(
              (one) =>
                !document.getElementById('settings-advanced')?.contains(one) &&
                one.closest('select') === null &&
                (one as HTMLElement).checkVisibility() &&
                [...one.childNodes].some(
                  (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
                ),
            )
            .map((one) => one.textContent ?? '')
            .join(' | '),
        null,
      );
      assert.doesNotMatch(words, /\bSave\b|\bdefault\b|the file|applies|config\.json/i, words);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'each of the short screen’s keys is saved as it is picked and ends in the file: a choice and the switch at once, the ticket address on Enter and when it is left; an unchanged text sends nothing; a refused address keeps its text, shows the reason and changes nothing',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { ticketUrl: 'https://t.example.com/{key}' },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const sets = await countSets(l.page);
      const windowOf = (): Record<string, unknown> =>
        (configOf(l)['window'] ?? {}) as Record<string, unknown>;

      // The sandbox's file holds `edge` (its Edge is a stub that records links).
      await l.page.locator(shortControl('window.links')).selectOption('default');
      await shortSays(l.page, 'window.links', 'Saved.');
      assert.equal(windowOf()['links'], 'default');

      await l.page.locator(shortControl('terminal')).selectOption('window');
      await shortSays(l.page, 'terminal', 'Saved.');
      assert.equal(configOf(l)['terminal'], 'window');

      await l.page.locator(shortControl('window.keepAlive')).click();
      await shortSays(l.page, 'window.keepAlive', 'Saved.');
      assert.equal(windowOf()['keepAlive'], 'wsl');
      await l.page.locator(shortControl('window.keepAlive')).click();
      await shortSays(l.page, 'window.keepAlive', 'Saved.');
      assert.equal(windowOf()['keepAlive'], 'off');
      assert.equal(await sets(), 4);

      // The text: unchanged, nothing is sent, on Enter or when it is left.
      const ticket = l.page.locator(shortControl('ticketUrl'));
      await ticket.focus();
      await ticket.press('Enter');
      await l.page.locator(shortControl('terminal')).focus();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), 4, 'an unchanged text sends nothing');

      // Enter saves it.
      await ticket.fill('https://tickets.example.com/{key}');
      await ticket.press('Enter');
      await shortSays(l.page, 'ticketUrl', 'Saved.');
      assert.equal(configOf(l)['ticketUrl'], 'https://tickets.example.com/{key}');
      assert.equal(await active(l.page), '#settings-key-ticketUrl', 'the keyboard stays');

      // A refusal: the reason beside it, the text kept, the file as it was; left again, the same
      // text is not sent again.
      const before = readFileSync(l.d.deck.places.configPath, 'utf8');
      await ticket.fill('tickets.example.com/{key}');
      await ticket.press('Enter');
      await shortSays(l.page, 'ticketUrl', /^"ticketUrl" must be null or an http or https address/);
      assert.equal(await ticket.inputValue(), 'tickets.example.com/{key}', 'the text stays');
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), before, 'nothing changed');
      const refusedAt = await sets();
      await l.page.locator(shortControl('terminal')).focus();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), refusedAt, 'the refused text is not sent again when left');

      // Leaving it saves it: an empty one is no link.
      await ticket.fill('');
      await l.page.locator(shortControl('terminal')).focus();
      await shortSays(l.page, 'ticketUrl', 'Saved.');
      assert.equal(Object.hasOwn(configOf(l), 'ticketUrl'), true);
      assert.equal(configOf(l)['ticketUrl'], null);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'a value the running server does not use yet is marked `after a restart`: a hand edit of Open links in, until the file holds what the server uses again; a second window follows a pick',
    async (t) => {
      const l = await launched(t, chromium);
      const other = await l.page.context().newPage();
      await other.goto(pageUrl(l.server.port));
      await connection(other, 'open');
      // The sandbox's file holds `edge`, which the server uses; a hand edit to `default`.
      const config = configOf(l);
      writeFileSync(
        l.d.deck.places.configPath,
        JSON.stringify({
          ...config,
          window: { ...(config['window'] as Record<string, unknown>), links: 'default' },
        }),
      );
      for (const page of [l.page, other]) {
        await page.locator('#settings-button').click();
        await opened(page);
      }
      const mark = (page: Page): Promise<string[]> =>
        readPage(
          page,
          (at) =>
            [...document.querySelectorAll(`${at} .short-mark`)]
              .filter((one) => (one as HTMLElement).checkVisibility())
              .map((one) => one.textContent ?? ''),
          short('window.links'),
        );
      assert.deepEqual(
        await mark(l.page),
        ['after a restart: still “Edge” until then'],
        'the hand edit: the value in use, in the choice’s words',
      );
      assert.equal(await l.page.locator(shortControl('window.links')).inputValue(), 'default');
      // Picked back to the value the server uses, saved at once: no mark; the other window follows.
      await l.page.locator(shortControl('window.links')).selectOption('edge');
      await shortSays(l.page, 'window.links', 'Saved.');
      assert.deepEqual(await mark(l.page), []);
      await until(
        async () => (await other.locator(shortControl('window.links')).inputValue()) === 'edge',
        'the second window follows',
      );
      assert.deepEqual(await mark(other), []);
      assert.deepEqual(l.problems, []);
    },
  );
  await t.test(
    'Esc is the way out without saving: a ticket address typed and not saved is dropped, nothing is sent, the next opening shows the file’s; left by a click on Close it is saved, and a refusal then goes to the key bar',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { ticketUrl: 'https://t.example.com/{key}' },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const sets = await countSets(l.page);
      const before = readFileSync(l.d.deck.places.configPath, 'utf8');
      const ticket = l.page.locator(shortControl('ticketUrl'));
      await ticket.fill('https://other.example.com/{key}');
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), 0, 'nothing is sent');
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), before, 'the file as it was');
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      assert.equal(await ticket.inputValue(), 'https://t.example.com/{key}', "the file's value");

      // A click on Close leaves the field: a good text is saved.
      await ticket.fill('https://tickets.example.com/{key}');
      await l.page.locator('#settings .settings-close').click();
      await closed(l.page);
      await until(
        async () => configOf(l)['ticketUrl'] === 'https://tickets.example.com/{key}',
        'saved at Close',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        await shownText(l.page, '#key-message'),
        '',
        'a save at Close that worked says nothing',
      );
      // The next opening, its answer held back: leaving the field before the answer came sends
      // the saved text nothing again.
      await holdBack(l.page, 'settings', 500);
      const afterSave = await sets();
      await l.page.locator('#settings-button').click();
      await ticket.focus();
      await l.page.keyboard.press('Tab');
      await opened(l.page);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), afterSave, 'the text saved at Close is not sent again');
      assert.equal(await ticket.inputValue(), 'https://tickets.example.com/{key}');
      // A refused one: the key bar says so, the file unchanged.
      const saved = readFileSync(l.d.deck.places.configPath, 'utf8');
      await ticket.fill('nope');
      await l.page.locator('#settings .settings-close').click();
      await closed(l.page);
      await showsText(
        l.page,
        '#key-message',
        /^Ticket address was not saved: "ticketUrl" must be null or an http or https address/,
      );
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), saved, 'nothing changed');
      // The next opening shows the file's value, not the refused text, and leaving it sends
      // nothing.
      const afterRefusal = await sets();
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      assert.equal(await ticket.inputValue(), 'https://tickets.example.com/{key}', "the file's");
      await ticket.focus();
      await l.page.keyboard.press('Tab');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), afterRefusal, 'nothing sent');
      assert.deepEqual(l.problems, []);
    },
  );
  await t.test(
    'a change made while an answer waits: Enter then Tab, or Enter twice, in Ticket address, and a choice picked B, A or B, A, B, end in the file and in `Saved.`; with a broken file, two picks ending on the value in use end in the refusal',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { ticketUrl: 'https://t.example.com/{key}' },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await holdBack(l.page, 'setting-set', 200);
      const sets = await countSets(l.page);
      const ticket = l.page.locator(shortControl('ticketUrl'));
      for (const [address, second] of [
        ['https://one.example.com/{key}', 'Tab'],
        ['https://two.example.com/{key}', 'Enter'],
      ] as const) {
        await ticket.focus();
        await ticket.fill(address);
        await l.page.keyboard.press('Enter');
        await l.page.keyboard.press(second);
        await shortSays(l.page, 'ticketUrl', 'Saved.');
        assert.equal(configOf(l)['ticketUrl'], address, `Enter then ${second}`);
      }
      const terminal = l.page.locator(shortControl('terminal'));
      for (const [picks, end] of [
        [['wezterm', 'window'], 'window'],
        [['here', 'wezterm', 'here'], 'here'],
      ] as const) {
        for (const pick of picks) await terminal.selectOption(pick);
        await shortSays(l.page, 'terminal', 'Saved.');
        await until(async () => configOf(l)['terminal'] === end, `${picks.join(', ')} ends ${end}`);
        assert.equal(await terminal.inputValue(), end);
      }
      assert.ok((await sets()) >= 5, `each change sent: ${await sets()}`);

      // A broken file refuses the first of two picks, the second being the value in use: the
      // refusal is the outcome, the control shows the value in use.
      writeFileSync(l.d.deck.places.configPath, '{ "terminal": "here", }');
      const keepAlive = l.page.locator(shortControl('window.keepAlive'));
      const was = await keepAlive.isChecked();
      await keepAlive.click();
      await keepAlive.click();
      await shortSays(
        l.page,
        'window.keepAlive',
        /mend the file by hand first: nothing was changed$/,
      );
      assert.equal(await keepAlive.isChecked(), was);
      const links = l.page.locator(shortControl('window.links'));
      const in_use = await links.inputValue();
      await links.selectOption(in_use === 'edge' ? 'default' : 'edge');
      await links.selectOption(in_use);
      await shortSays(l.page, 'window.links', /mend the file by hand first: nothing was changed$/);
      assert.equal(await links.inputValue(), in_use);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the window losing the focus (a blur while the field stays the active element) saves nothing; leaving the field then saves it',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { ticketUrl: 'https://t.example.com/{key}' },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const sets = await countSets(l.page);
      const before = readFileSync(l.d.deck.places.configPath, 'utf8');
      const ticket = l.page.locator(shortControl('ticketUrl'));
      await ticket.fill('https://half.example.com/{key}');
      await ticket.evaluate((field) => field.dispatchEvent(new FocusEvent('blur')));
      assert.equal(await active(l.page), '#settings-key-ticketUrl', 'still the active element');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), 0, 'nothing is sent');
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), before);
      assert.equal(await ticket.inputValue(), 'https://half.example.com/{key}', 'the text stays');
      await l.page.keyboard.press('Tab');
      await shortSays(l.page, 'ticketUrl', 'Saved.');
      assert.equal(configOf(l)['ticketUrl'], 'https://half.example.com/{key}');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'another window’s change keeps a ticket address being typed; an address longer than a request carries is refused before it is sent; Tab and Shift+Tab wrap with Advanced closed',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { ticketUrl: 'https://t.example.com/{key}' },
      });
      const other = await l.page.context().newPage();
      await other.goto(pageUrl(l.server.port));
      await connection(other, 'open');
      for (const page of [l.page, other]) {
        await page.locator('#settings-button').click();
        await opened(page);
      }
      const typing = other.locator(shortControl('ticketUrl'));
      await typing.fill('https://typing.example.com/{key}');
      await l.page.locator(shortControl('window.links')).selectOption('default');
      await shortSays(l.page, 'window.links', 'Saved.');
      await until(
        async () => (await other.locator(shortControl('window.links')).inputValue()) === 'default',
        'the other window follows',
      );
      assert.equal(
        await typing.inputValue(),
        'https://typing.example.com/{key}',
        'its typing stays',
      );

      const sets = await countSets(l.page);
      const before = readFileSync(l.d.deck.places.configPath, 'utf8');
      const ticket = l.page.locator(shortControl('ticketUrl'));
      await ticket.fill(`https://long.example.com/${'a'.repeat(5000)}/{key}`);
      await ticket.press('Enter');
      await shortSays(
        l.page,
        'ticketUrl',
        'Longer than the window sends (4,096 bytes as UTF-8): change it in the file by hand.',
      );
      await l.page.locator(shortControl('terminal')).focus();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), 0, 'not sent, at Enter nor when left');
      assert.equal(readFileSync(l.d.deck.places.configPath, 'utf8'), before);

      await l.page.locator('#settings .settings-close').focus();
      await l.page.keyboard.press('Tab');
      assert.equal(await active(l.page), '#settings-mode', 'Tab on Close: back to Mode');
      await l.page.keyboard.press('Shift+Tab');
      assert.equal(
        await readPage(
          l.page,
          () => document.activeElement?.classList.contains('settings-close') === true,
          null,
        ),
        true,
        'Shift+Tab on Mode: Close',
      );
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'the first answer of a later opening keeps a text typed before it came; a field not typed in takes the file’s value and sends nothing when left',
    async (t) => {
      const l = await launched(t, chromium, {
        config: { ticketUrl: 'https://t.example.com/{key}' },
      });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      // Changed behind the screen's back, so the answer brings a new value.
      writeFileSync(
        l.d.deck.places.configPath,
        JSON.stringify({ ...configOf(l), ticketUrl: 'https://file.example.com/{key}' }),
      );
      await holdBack(l.page, 'settings', 800);
      const sets = await countSets(l.page);
      const ticket = l.page.locator(shortControl('ticketUrl'));
      await l.page.locator('#settings-button').click();
      await ticket.fill('https://early.example.com/{key}');
      await opened(l.page);
      assert.equal(await ticket.inputValue(), 'https://early.example.com/{key}', 'kept');
      await l.page.keyboard.press('Tab');
      await shortSays(l.page, 'ticketUrl', 'Saved.');
      assert.equal(configOf(l)['ticketUrl'], 'https://early.example.com/{key}');
      assert.equal(await sets(), 1);

      // Not typed in: the answer draws the file's value, and leaving the field sends nothing.
      await l.page.keyboard.press('Escape');
      await closed(l.page);
      writeFileSync(
        l.d.deck.places.configPath,
        JSON.stringify({ ...configOf(l), ticketUrl: 'https://again.example.com/{key}' }),
      );
      await l.page.locator('#settings-button').click();
      await ticket.focus();
      await opened(l.page);
      assert.equal(await ticket.inputValue(), 'https://again.example.com/{key}', "the file's");
      await l.page.keyboard.press('Tab');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await sets(), 1, 'nothing more sent');
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    'Keep WSL running while its change waits for a restart: the mark says the value in use in the switch’s words, both ways; back to the value in use, `after a restart` alone',
    async (t) => {
      const mark = (page: Page): Promise<string> =>
        readPage(
          page,
          (at) => document.querySelector(`${at} .short-mark`)?.textContent ?? '',
          short('window.keepAlive'),
        );
      // The sandbox's server runs with `off`.
      const off = await launched(t, chromium);
      await off.page.locator('#settings-button').click();
      await opened(off.page);
      const offSwitch = off.page.locator(shortControl('window.keepAlive'));
      assert.equal(await mark(off.page), 'after a restart');
      await offSwitch.click();
      await shortSays(off.page, 'window.keepAlive', 'Saved.');
      assert.equal(await mark(off.page), 'after a restart: still off until then');
      await offSwitch.click();
      await shortSays(off.page, 'window.keepAlive', 'Saved.');
      assert.equal(await mark(off.page), 'after a restart');
      assert.deepEqual(off.problems, []);

      // A server started with `wsl` (its keep-alive fails in the sandbox, as in shell.test.ts).
      const on = await launched(t, chromium, { window: { keepAlive: 'wsl' } });
      await on.page.locator('#settings-button').click();
      await opened(on.page);
      const onSwitch = on.page.locator(shortControl('window.keepAlive'));
      assert.equal(await onSwitch.isChecked(), true);
      await onSwitch.click();
      await shortSays(on.page, 'window.keepAlive', 'Saved.');
      assert.equal(await mark(on.page), 'after a restart: still on until then');
    },
  );
  await t.test(
    'a long running ticket address waiting for a restart: its mark wraps beside the field, the dialog does not scroll sideways',
    async (t) => {
      const long = `https://tickets.example.com/${'a'.repeat(400)}/{key}`;
      const l = await launched(t, chromium, { config: { ticketUrl: long } });
      writeFileSync(
        l.d.deck.places.configPath,
        JSON.stringify({ ...configOf(l), ticketUrl: 'https://short.example.com/{key}' }),
      );
      await l.page.setViewportSize({ width: 1000, height: 700 });
      await l.page.locator('#settings-button').click();
      await opened(l.page);
      const box = await readPage(
        l.page,
        (at) => {
          const dialog = document.querySelector('#settings .settings-dialog') as HTMLElement;
          const mark = document.querySelector(`${at} .short-mark`) as HTMLElement;
          const field = document.querySelector(`${at} input`) as HTMLElement;
          return {
            text: mark.textContent,
            wide: dialog.scrollWidth > dialog.clientWidth,
            besideField: mark.getBoundingClientRect().left >= field.getBoundingClientRect().right,
            inside: mark.getBoundingClientRect().right <= dialog.getBoundingClientRect().right,
          };
        },
        short('ticketUrl'),
      );
      assert.equal(box.text, `after a restart: still “${long}” until then`);
      assert.deepEqual(
        { wide: box.wide, besideField: box.besideField, inside: box.inside },
        { wide: false, besideField: true, inside: true },
      );
      assert.deepEqual(l.problems, []);
    },
  );
});
