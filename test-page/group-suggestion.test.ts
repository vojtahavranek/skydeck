// The new form's group suggestion (S2 12.6, follow-up F28): when the session the form takes its
// directory from is in a group, one chip with that group's name right after the Group field; a
// click, or Enter or Space on it, puts the name into the field (nothing is filled in without it);
// the field's completions are the groups the list shows, the selected session's first. Scripted
// cases run against a stand-in server (helpers/shell.ts); the last case runs against a real test
// server with the stand-in program (test/helpers/window.ts): the started session is stored in the
// group and lands in that group's card in the list.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  clickRow,
  connection,
  honest,
  launched,
  problemsOf,
  readPage,
  scriptedList,
  showsText,
  standinServer,
  storeKey,
} from './helpers/shell.ts';
import type { Launched } from './helpers/shell.ts';
import { promptOf, resumeHere, until, untilScreen } from './helpers/terminal.ts';

type Row = Record<string, unknown>;

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const MIN = 60_000_000_000n;
const DIRS = ['/home/u/alpha', '/home/u/beta', '/home/u/gamma'];
const LONG = 'image-cache-memory-growth-under-load';

/** The rows of the default world: a title's key, a stored group, none, the stored group again. */
const ROWS: Row[] = [
  { id: S1, title: 'ABC-123 fix the login', group: 'ABC-123', groupSource: 'title', dir: DIRS[0] },
  { id: S2, title: 'tidy the alerts', group: 'infra', groupSource: 'meta', dir: DIRS[1] },
  { id: S3, title: 'read the release notes', dir: DIRS[2] },
  { id: S4, title: 'rotate the keys', group: 'infra', groupSource: 'meta', dir: DIRS[1] },
];

interface World {
  page: Page;
  /** Every `act` the page sent, in order. */
  acts(): Row[];
  problems: string[];
}

interface Script {
  rows?: Row[];
  /** Closed blocks of Recent (F9): their captions, each with its group and its place. */
  closed?: { group: string; at: number }[];
  favourites?: string[];
}

let seed = 120;

/**
 * A page on a stand-in that lists `script.rows` (default ROWS) in Open, not running, and
 * `script.closed` as Recent's closed captions; it answers every `act new` with a refusal (the form
 * stays open with what was sent) and sends nothing for other acts.
 */
async function world(t: TestContext, chromium: Browser, script: Script = {}): Promise<World> {
  const secret = new Uint8Array(32).fill(seed++);
  const page = await newPage(t, chromium);
  const problems = problemsOf(page);
  const acts: Row[] = [];
  const rows = script.rows ?? ROWS;
  const listFor = (selected: string | null): Row => {
    const list = scriptedList(
      rows.map((one) => ({ id: one['id'] as string, terminal: null, slot: null })),
      [],
      selected === null
        ? null
        : {
            sessionId: selected,
            command: `claude --resume ${selected}`,
            flagsKnown: true,
            unknownFlags: [],
            ended: 'exited',
            expiring: false,
            expired: false,
            note: null,
            noteTooLong: false,
            ticketUrl: null,
          },
    ) as Row & { sections: Row[] };
    const open = list.sections[0] as { rows: Row[] };
    open.rows = open.rows.map((one, i) => ({ ...one, ...rows[i] }));
    list.sections.push({
      name: 'week',
      folded: false,
      firstNs: null,
      lastNs: null,
      count: 2 * (script.closed ?? []).length,
      rows: [],
      closedStacks: (script.closed ?? []).map((caption, i) => ({
        group: caption.group,
        size: 2,
        needYou: 0,
        head: `5f0c2a1e-7b3d-4e8a-9c6f-${String(i).padStart(12, '0')}`,
        at: caption.at,
      })),
    });
    return { ...list, dirs: DIRS, favourites: script.favourites ?? [] };
  };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        if (message['t'] === 'view') {
          conn.send(listFor((message['selected'] as string | null) ?? null));
        } else if (message['t'] === 'act') {
          acts.push(message);
          if (message['kind'] === 'new') {
            conn.send({
              t: 'result',
              id: message['id'],
              ok: false,
              lines: ['refused'],
              error: 'refused',
              sessionId: null,
            });
          }
        }
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  return { page, acts: () => [...acts], problems };
}

/** Opens the new form (from the row of `sessionId` when given); the keyboard is in Directory. */
async function openForm(page: Page, sessionId: string | null = null): Promise<void> {
  if (sessionId !== null) await clickRow(page, sessionId);
  await page.keyboard.press('Control+Shift+N');
  await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
}

async function closeForm(page: Page): Promise<void> {
  await page.focus('#cards input[name="directory"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#right-zone:not([data-pane="new"])', { state: 'attached' });
}

interface Chip {
  text: string;
  title: string;
  label: string | null;
  tag: string;
  type: string;
}

/** The form's group chips (at most one is right). */
async function chips(page: Page): Promise<Chip[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#cards .card-group-chip')].map((chip) => ({
      text: chip.textContent ?? '',
      title: (chip as HTMLElement).title,
      label: chip.getAttribute('aria-label'),
      tag: chip.tagName,
      type: chip.getAttribute('type') ?? '',
    })),
  );
}

const groupValue = (page: Page): Promise<string> => page.inputValue('#cards input[name="group"]');
const activeIs = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return '';
    if (active instanceof HTMLInputElement) return `input:${active.name}`;
    return active.className;
  });

/** The options of the Group field's list of completions, in order; null without a list. */
async function completions(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const input = document.querySelector('#cards input[name="group"]');
    if (!(input instanceof HTMLInputElement) || input.list === null) return null;
    return [...input.list.options].map((option) => option.value);
  });
}

interface Box {
  what: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every element of the form's card with its box, in order (the card itself first), but the
 *  lists of completions (a datalist is never drawn). */
async function boxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const card = document.querySelector('#cards .card-new')?.closest('.card');
    if (!(card instanceof HTMLElement)) return [];
    const drawn = [card, ...card.querySelectorAll('*')].filter(
      (element) => element.closest('datalist') === null,
    );
    return drawn.map((element) => {
      const r = element.getBoundingClientRect();
      const name = element.getAttribute('name');
      return {
        what: `${element.tagName}.${element.className}${name === null ? '' : `[${name}]`}`,
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
      };
    });
  });
}

/**
 * What decides the card's pixels: its markup (the card's `outerHTML`) and its fields' values and
 * keyboard. With `withoutCompletions` the Group field's list of completions is taken out of a
 * copy first — its `list` attribute and its datalist, which no pixel shows at rest — so that a
 * form of a list with groups compares with one of a list without any. Screenshots of two pages are
 * not compared: their antialiasing differs by a level here and there on a busy machine (review 2).
 */
async function cardMarkup(
  page: Page,
  withoutCompletions = false,
): Promise<{ html: string; values: string[]; keyboard: string }> {
  // The form gives Directory the keyboard as it opens: read it once that has happened.
  await page.waitForFunction(
    () => (document.activeElement as HTMLInputElement | null)?.name === 'directory',
  );
  return page.evaluate((strip) => {
    const card = document.querySelector('#cards .card-new')?.closest('.card');
    if (!(card instanceof HTMLElement)) return { html: '', values: [], keyboard: '' };
    const copy = card.cloneNode(true) as HTMLElement;
    if (strip) {
      copy.querySelector('#card-new-groups')?.remove();
      copy.querySelector('input[name="group"]')?.removeAttribute('list');
    }
    return {
      html: copy.outerHTML,
      values: [...card.querySelectorAll('input')].map((input) => `${input.name}=${input.value}`),
      keyboard: (document.activeElement as HTMLInputElement | null)?.name ?? '',
    };
  }, withoutCompletions);
}

test("the new form's group suggestion", async (t) => {
  const chromium = await browser(t);

  await t.test(
    "no chip without a selection, nor for a selected session in no group; the Group field empty; the card is that of a list without any group (the same markup but for the Group field's list of completions, the same values, every box), its Group field where it was",
    async (t) => {
      const plain = await world(t, chromium, {
        rows: ROWS.map(({ id, title, dir }) => ({ id, title, dir })),
      });
      await openForm(plain.page, S3);
      const before = await boxes(plain.page);
      const markup = await cardMarkup(plain.page);
      assert.equal(markup.keyboard, 'directory');
      assert.equal(await completions(plain.page), null, 'no group: no list of completions');

      // Nothing selected: a list with no row (the page selects the first row of a list by
      // itself), only a closed block's caption — its group a completion, no chip.
      const none = await world(t, chromium, { rows: [], closed: [{ group: 'ops-7', at: 0 }] });
      await openForm(none.page);
      assert.equal(await none.page.locator('#list [data-selected="true"]').count(), 0);
      assert.deepEqual(await chips(none.page), [], 'nothing selected');
      assert.equal(await groupValue(none.page), '');
      assert.deepEqual(await completions(none.page), ['ops-7']);

      const w = await world(t, chromium);
      await openForm(w.page, S3);
      assert.deepEqual(await chips(w.page), [], 'a session in no group');
      assert.equal(await groupValue(w.page), '');
      assert.deepEqual(await boxes(w.page), before, 'every box as before');
      assert.deepEqual(await cardMarkup(w.page, true), markup, 'the same markup and values');
      const placed = await w.page.evaluate(() => {
        const group = document.querySelector('#cards input[name="group"]');
        const label = document.querySelector('#cards input[name="label"]');
        if (!(group instanceof HTMLElement) || !(label instanceof HTMLElement)) return null;
        const g = group.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        return {
          parent: group.parentElement?.className,
          left: g.left === l.left,
          width: g.width === l.width,
          wrapper: document.querySelectorAll('#cards .card-group-field').length,
        };
      });
      assert.deepEqual(placed, { parent: 'card-form-line', left: true, width: true, wrapper: 0 });
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    "the chip of the selected session's group — a stored group, a title's key — right after the Group field on its line: the name, its title and accessible name `Use the group …`; the field empty until a click; the card's height and its other boxes as without a chip",
    async (t) => {
      const w = await world(t, chromium);
      await openForm(w.page, S3);
      const without = await boxes(w.page);
      await closeForm(w.page);

      for (const [id, group] of [
        [S2, 'infra'],
        [S1, 'ABC-123'],
      ] as const) {
        await openForm(w.page, id);
        assert.deepEqual(await chips(w.page), [
          {
            text: group,
            title: `Use the group ${group}`,
            label: `Use the group ${group}`,
            tag: 'BUTTON',
            type: 'button',
          },
        ]);
        assert.equal(await groupValue(w.page), '', `${group}: nothing filled in by itself`);
        assert.equal(
          await w.page.getByRole('button', { name: `Use the group ${group}`, exact: true }).count(),
          1,
        );
        assert.equal(
          // A text field with a list of completions is a combobox, as Directory is.
          await w.page.getByRole('combobox', { name: 'Group', exact: true }).count(),
          1,
          "the field's name is its label alone",
        );
        const placed = await w.page.evaluate(() => {
          const field = document.querySelector('#cards input[name="group"]');
          const chip = document.querySelector('#cards .card-group-chip');
          const line = field?.closest('.card-form-line');
          if (!(field instanceof HTMLElement) || !(chip instanceof HTMLElement) || !line) {
            return null;
          }
          const f = field.getBoundingClientRect();
          const c = chip.getBoundingClientRect();
          const l = line.getBoundingClientRect();
          return {
            after: c.left >= f.right && c.left - f.right < 12,
            inLine: c.top >= l.top && c.bottom <= l.bottom && c.right <= l.right,
            middle: Math.abs(c.top + c.height / 2 - (f.top + f.height / 2)) < 1.5,
            sameLine: chip.closest('.card-form-line') === line,
          };
        });
        assert.deepEqual(placed, { after: true, inLine: true, middle: true, sameLine: true });
        const withChip = await boxes(w.page);
        const others = (list: Box[]): Box[] =>
          list.filter((box) => !/card-group-(field|chip)|\[group\]/.test(box.what));
        assert.deepEqual(others(withChip), others(without), `${group}: every other box as before`);
        const field = withChip.find((box) => box.what.endsWith('[group]'));
        const plainField = without.find((box) => box.what.endsWith('[group]'));
        assert.ok(field !== undefined && plainField !== undefined);
        assert.deepEqual(
          { x: field.x, y: field.y, h: field.h },
          { x: plainField.x, y: plainField.y, h: plainField.h },
          'the field narrower, nothing else',
        );
        assert.ok(field.w < plainField.w);
        await closeForm(w.page);
      }
      assert.deepEqual(w.acts(), [], 'a chip shown sends nothing');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    'a click puts the name into the Group field, replacing what is there; the keyboard stays where it was; nothing is sent',
    async (t) => {
      const w = await world(t, chromium);
      await openForm(w.page, S2);
      await w.page.fill('#cards input[name="group"]', 'something else');
      await w.page.focus('#cards input[name="directory"]');
      await w.page.click('#cards .card-group-chip');
      assert.equal(await groupValue(w.page), 'infra');
      assert.equal(await activeIs(w.page), 'input:directory', 'a click takes no keyboard');
      await w.page.click('#cards .card-group-chip');
      assert.equal(await groupValue(w.page), 'infra', 'a second click: the same');
      await w.page.fill('#cards input[name="group"]', '');
      await w.page.click('#cards input[name="group"]');
      await w.page.click('#cards .card-group-chip');
      assert.equal(await groupValue(w.page), 'infra');
      assert.equal(await activeIs(w.page), 'input:group');
      assert.deepEqual(w.acts(), []);
      assert.deepEqual(await chips(w.page), [
        {
          text: 'infra',
          title: 'Use the group infra',
          label: 'Use the group infra',
          tag: 'BUTTON',
          type: 'button',
        },
      ]);
    },
  );

  await t.test(
    'the keyboard: Tab from the Group field reaches the chip, then the flags field; Enter and Space on it fill the field and start nothing; no list key acts there; Enter in a field then starts with the group',
    async (t) => {
      const w = await world(t, chromium);
      await openForm(w.page, S1);
      const order: string[] = [];
      for (let i = 0; i < 5; i++) {
        await w.page.keyboard.press('Tab');
        order.push(await activeIs(w.page));
      }
      assert.deepEqual(order, [
        'input:label',
        'input:group',
        'card-group-chip mono',
        'input:flags',
        'card-button card-star',
      ]);
      await w.page.keyboard.press('Shift+Tab');
      assert.equal(await activeIs(w.page), 'input:flags');
      await w.page.keyboard.press('Shift+Tab');
      assert.equal(await activeIs(w.page), 'card-group-chip mono', 'Shift+Tab back');
      await w.page.keyboard.press('Shift+Tab');
      assert.equal(await activeIs(w.page), 'input:group');

      await w.page.fill('#cards input[name="group"]', 'x');
      await w.page.focus('#cards .card-group-chip');
      await w.page.keyboard.press('Enter');
      assert.equal(await groupValue(w.page), 'ABC-123', 'Enter');
      assert.equal(await activeIs(w.page), 'card-group-chip mono', 'the chip keeps the keyboard');
      await w.page.fill('#cards input[name="group"]', 'y');
      await w.page.focus('#cards .card-group-chip');
      await w.page.keyboard.press('Space');
      assert.equal(await groupValue(w.page), 'ABC-123', 'Space');
      await w.page.keyboard.down('Enter');
      await w.page.keyboard.down('Enter'); // held
      await w.page.keyboard.up('Enter');
      for (const key of ['j', 'k', 'd', 'l', 'g', 'n', 'p', '/', 'ArrowDown', 'ArrowUp']) {
        await w.page.keyboard.press(key);
      }
      assert.equal(await activeIs(w.page), 'card-group-chip mono');
      assert.equal(await w.page.getAttribute('#right-zone', 'data-pane'), 'new');
      assert.equal(await w.page.isVisible('#editor'), false, 'no dialog');
      assert.equal(await groupValue(w.page), 'ABC-123');
      assert.deepEqual(w.acts(), [], 'the chip starts nothing');

      await w.page.focus('#cards input[name="flags"]');
      await w.page.keyboard.press('Enter');
      await showsText(w.page, '#cards .card-new .card-lines', /^refused$/);
      const starts = w.acts().filter((act) => act['kind'] === 'new');
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.['group'], 'ABC-123');
      await w.page.focus('#cards .card-group-chip');
      await w.page.keyboard.press('Escape');
      await w.page.waitForSelector('#right-zone:not([data-pane="new"])', { state: 'attached' });
    },
  );

  await t.test(
    "Start sends the Group field's text: empty without a click (the chip shown), the chip's group after one",
    async (t) => {
      const w = await world(t, chromium);
      await openForm(w.page, S1);
      await w.page.click('#cards button:text-is("Start")');
      await showsText(w.page, '#cards .card-new .card-lines', /^refused$/);
      await w.page.click('#cards .card-group-chip');
      await w.page.click('#cards button:text-is("Start")');
      await until(
        () => w.acts().filter((act) => act['kind'] === 'new').length === 2,
        'the second start',
      );
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['dir'], act['group']]),
        [
          ['new', DIRS[0], ''],
          ['new', DIRS[0], 'ABC-123'],
        ],
      );
    },
  );

  await t.test(
    "completions: the groups of the list's sessions, each once, as the list shows them, the selected session's first; a closed block's group too",
    async (t) => {
      const w = await world(t, chromium, {
        closed: [
          { group: 'ops-7', at: 0 },
          { group: 'infra', at: 0 },
        ],
      });
      await openForm(w.page, S2);
      assert.deepEqual(await completions(w.page), ['infra', 'ABC-123', 'ops-7']);
      await closeForm(w.page);
      await openForm(w.page, S3);
      assert.deepEqual(await completions(w.page), ['ABC-123', 'infra', 'ops-7']);
      await closeForm(w.page);
      await openForm(w.page, S1);
      assert.deepEqual(await completions(w.page), ['ABC-123', 'infra', 'ops-7']);
      assert.equal(
        await w.page.getAttribute('#cards input[name="group"]', 'list'),
        'card-new-groups',
      );
      assert.equal(
        await w.page.getAttribute('#cards input[name="directory"]', 'list'),
        'card-new-dirs',
        "the Directory field's list as before",
      );
    },
  );

  await t.test(
    'a long group name is cut at 28 characters with `…`, whole in the title; the chip takes at most half the line; in a small window nothing runs past the card and its height stays; a name with markup is text',
    async (t) => {
      const w = await world(t, chromium, {
        rows: [
          { id: S1, title: 'long', group: LONG, groupSource: 'meta', dir: DIRS[0] },
          { id: S2, title: 'markup', group: '<b>x</b>', groupSource: 'meta', dir: DIRS[1] },
          { id: S3, title: 'none', dir: DIRS[2] },
        ],
      });
      for (const [width, height] of [
        [1280, 800],
        [800, 560],
      ] as const) {
        await w.page.setViewportSize({ width, height });
        await openForm(w.page, S3);
        const plainHeight = (await boxes(w.page))[0]?.h;
        await closeForm(w.page);
        await openForm(w.page, S1);
        assert.deepEqual(await chips(w.page), [
          {
            text: `${LONG.slice(0, 27)}…`,
            title: `Use the group ${LONG}`,
            label: `Use the group ${LONG}`,
            tag: 'BUTTON',
            type: 'button',
          },
        ]);
        const fit = await w.page.evaluate(() => {
          const card = document.querySelector('#cards .card-new')?.closest('.card');
          const chip = document.querySelector('#cards .card-group-chip');
          const wrapper = document.querySelector('#cards .card-group-field');
          const start = document.querySelector('#cards button.primary');
          if (
            !(card instanceof HTMLElement) ||
            !(chip instanceof HTMLElement) ||
            !(wrapper instanceof HTMLElement) ||
            start === null
          ) {
            return null;
          }
          const c = card.getBoundingClientRect();
          const s = start.getBoundingClientRect();
          return {
            half: chip.getBoundingClientRect().width <= wrapper.clientWidth / 2 + 0.5,
            fits:
              card.scrollWidth <= card.clientWidth && wrapper.scrollWidth <= wrapper.clientWidth,
            start: s.left >= c.left && s.right <= c.right && s.bottom <= c.bottom,
            ellipsis: getComputedStyle(chip).textOverflow,
            height: c.height,
          };
        });
        assert.ok(fit !== null);
        assert.deepEqual(
          {
            half: fit.half,
            fits: fit.fits,
            start: fit.start,
            ellipsis: fit.ellipsis,
            height: fit.height,
          },
          { half: true, fits: true, start: true, ellipsis: 'ellipsis', height: plainHeight },
          `at ${width} × ${height}`,
        );
        await w.page.click('#cards .card-group-chip');
        assert.equal(await groupValue(w.page), LONG, 'the whole name into the field');
        await closeForm(w.page);
      }
      await openForm(w.page, S2);
      assert.deepEqual(
        (await chips(w.page)).map((chip) => [chip.text, chip.title]),
        [['<b>x</b>', 'Use the group <b>x</b>']],
      );
      assert.equal(await w.page.locator('#cards b').count(), 0, 'text, never markup');
      await w.page.click('#cards .card-group-chip');
      assert.equal(await groupValue(w.page), '<b>x</b>');
      assert.deepEqual(w.problems, []);
    },
  );

  await t.test(
    "in the light and the dark scheme, and in a theme forced against the system's: the chip in a favourite chip's colours",
    async (t) => {
      const w = await world(t, chromium, { favourites: ['--verbose'] });
      /** The chip's colours and an off favourite chip's. */
      const colours = async (): Promise<{ chip: string[]; favourite: string[] }> =>
        w.page.evaluate(() => {
          const of = (selector: string): string[] => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return [];
            const style = getComputedStyle(element);
            return [style.color, style.backgroundColor, style.borderTopColor, style.borderTopWidth];
          };
          return { chip: of('#cards .card-group-chip'), favourite: of('#cards .card-favourite') };
        });
      const seen: Record<string, string[]> = {};
      for (const [system, forced] of [
        ['light', null],
        ['dark', null],
        ['dark', 'light'],
        ['light', 'dark'],
      ] as const) {
        await w.page.emulateMedia({ colorScheme: system });
        if (forced !== null) {
          await w.page.evaluate((theme) => localStorage.setItem('skydeck-theme', theme), forced);
          await w.page.reload();
          await connection(w.page, 'open');
        }
        await openForm(w.page, S2);
        await w.page.waitForSelector('#cards .card-favourite');
        await w.page.mouse.move(2, 2);
        const now = await colours();
        assert.equal(now.chip.length, 4, 'the chip is there');
        assert.deepEqual(
          now.chip,
          now.favourite,
          `${system}${forced === null ? '' : `, forced ${forced}`}`,
        );
        seen[forced ?? system] = [...(seen[forced ?? system] ?? []), now.chip.join()];
        await closeForm(w.page);
      }
      assert.equal(seen['light']?.[0], seen['light']?.[1], 'forced light is the light scheme');
      assert.equal(seen['dark']?.[0], seen['dark']?.[1], 'forced dark is the dark scheme');
      assert.notEqual(seen['light']?.[0], seen['dark']?.[0], 'light and dark differ');
    },
  );

  await t.test(
    "on a real test server: a session whose group is its title's key; the chip, then Start: the new session's own stored group is that key and its row lands in that group's card in the list; a start without the click stores no group",
    async (t) => {
      const l = await launched(t, chromium);
      const { page } = l;
      session(l.d, S1, 2n * MIN, 'ABC-123 fix the login');
      await resumeHere(page, S1);
      await untilScreen(page, promptOf(S1));
      assert.equal(l.d.deck.store.meta(S1)?.group ?? null, null, "S1's group is its title's");

      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      assert.deepEqual(
        (await chips(page)).map((chip) => chip.text),
        ['ABC-123'],
      );
      await page.click('#cards .card-group-chip');
      await page.keyboard.press('Enter'); // the keyboard is still in Directory
      const second = await newSession(l, [S1]);
      await until(
        () => l.d.deck.store.meta(second)?.group === 'ABC-123',
        'the new session stored in ABC-123',
      );
      await until(
        async () => (await cardOf(page, 'ABC-123')).join() === [S1, second].sort().join(),
        "the new session's row in ABC-123's card, beside S1",
      );

      // The form again, from the new session (now selected): its own group is the chip; a start
      // without the click is in no group.
      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      assert.deepEqual(
        (await chips(page)).map((chip) => chip.text),
        ['ABC-123'],
      );
      assert.equal(await groupValue(page), '');
      await page.keyboard.press('Enter');
      const third = await newSession(l, [S1, second]);
      await until(async () => (await listedIds(page)).includes(third), 'the third session listed');
      assert.equal(l.d.deck.store.meta(third)?.group ?? null, null, 'no group stored');
      assert.deepEqual((await cardOf(page, 'ABC-123')).sort(), [S1, second].sort());
      assert.deepEqual(l.problems, []);
    },
  );
});

/** A session last active `agoNs` before now, titled `title` (a `custom-title` record). */
function session(d: ServerSandbox, sessionId: string, agoNs: bigint, title: string): string {
  const dir = join(d.s.home, 'project');
  mkdirSync(dir, { recursive: true });
  const folder = join(d.s.claudeHome, 'projects', 'project');
  mkdirSync(folder, { recursive: true });
  const timestamp = isoFromNs(d.platform.clock.nowNs() - agoNs);
  const lines = [
    { type: 'user', sessionId, timestamp, cwd: dir, entrypoint: 'cli' },
    { type: 'custom-title', customTitle: title, sessionId, timestamp },
  ];
  writeFileSync(
    join(folder, `${sessionId}.jsonl`),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
  return dir;
}

/** The session id of the one terminal the server started that is none of `known`'s. */
async function newSession(l: Launched, known: string[]): Promise<string> {
  let found: string | undefined;
  await until(() => {
    found = l.server.hub
      .list()
      .map((info) => info.expectedSessionId)
      .find((id) => !known.includes(id));
    return found !== undefined;
  }, 'a new terminal');
  return found as string;
}

/** The ids of the rows the list draws, in order. */
async function listedIds(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#list [data-id]')]
        .filter((element) => element instanceof HTMLElement && element.checkVisibility())
        .map((element) => element.getAttribute('data-id') ?? ''),
    null,
  );
}

/** The ids of the rows in the list's card of `group` (F9), sorted; [] when there is none. */
async function cardOf(page: Page, group: string): Promise<string[]> {
  return readPage(
    page,
    (group) => {
      const block = [...document.querySelectorAll('#list .list-block')].find(
        (one) => one.querySelector('.block-name')?.textContent === group,
      );
      return block === undefined
        ? []
        : [...block.querySelectorAll('[data-id]')]
            .map((row) => row.getAttribute('data-id') ?? '')
            .sort();
    },
    group,
  );
}
