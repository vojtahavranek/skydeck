// The favourite flags of the new form (S2 12.6, follow-up F15): the chips under "Flags for
// claude" and their states as the field's text moves, a click that adds or takes out a
// favourite's flags, the ★ that saves the field's text, the × that removes a chip and the hint's
// Undo, the keyboard of the chip row (one Tab stop, ← →, Space, Delete and Backspace, Enter
// starts, no list key acts), a form that opens empty after a start, a long favourite cut in a card
// that keeps its width, and favourite text shown as text. Against a stand-in server that keeps the
// favourites as the real one does (its rule: src/window/favourites.ts) and sends a `list` after
// each change, as the real server does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { favouriteRefusal } from '../src/window/favourites.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S3 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  clickRow,
  connection,
  honest,
  launched,
  PAGE_WAIT_MS,
  scriptedList,
  showsText,
  standinServer,
  storeKey,
  TERM_C,
} from './helpers/shell.ts';
import type { StandinConnection } from './helpers/shell.ts';

type Row = Record<string, unknown>;

const STAR_TIP = 'Save these flags as a favourite';
const HINT = 'starts in this window · Esc closes';

interface World {
  page: Page;
  /** Every `act` the page sent, in order. */
  acts(): Row[];
  /** Every message the page sent after `start` but pings, in order. */
  sent(): Row[];
  /** The favourites the stand-in keeps now. */
  favourites: string[];
  /** Another window changed the favourites: the stand-in keeps `list` and lists it. */
  setFavourites(list: string[]): void;
  /** How the stand-in answers `act new` (default: ok, S3 started in TERM_C). */
  answerNew: { refuse: string | null };
  /** When set, `favourite-remove` is refused with these words and nothing changes. */
  refuseRemove: { words: string | null };
}

let seed = 90;

/**
 * A page on a stand-in that lists S1 (not running) and keeps `favourites` as the server does:
 * `favourite-add` and `favourite-remove` by the server's rule, each answered, with a list of the
 * change; `new` starts S3 in TERM_C (its snap answers the attach) unless `answerNew.refuse`. The
 * real server sends that list before the answer, or — when it sent the page a list less than a
 * second before (pages.ts, `listDirty`) — up to a second after it, built when it goes out: by
 * default the list comes first; with `late` every list (a view's answer too) is built and sent
 * `late` ms later, so that every answer comes before its list.
 */
async function world(
  t: TestContext,
  chromium: Browser,
  favourites: string[] = [],
  late: number | null = null,
): Promise<World> {
  const secret = new Uint8Array(32).fill(seed++);
  const page = await newPage(t, chromium);
  const sent: Row[] = [];
  const all: Row[] = [];
  const kept = { favourites: [...favourites] };
  let started = false;
  let selected: string | null = null;
  let current: StandinConnection | null = null;
  const answerNew: World['answerNew'] = { refuse: null };
  const refuseRemove: World['refuseRemove'] = { words: null };
  const listNow = (): Row => {
    const rows: { id: string; terminal: string | null; slot: number | null }[] = [
      { id: S1, terminal: null, slot: null },
    ];
    if (started) rows.unshift({ id: S3, terminal: TERM_C, slot: 1 });
    const list = scriptedList(
      rows,
      started ? [{ id: TERM_C, slot: 1, sessionId: S3 }] : [],
      selected === S1
        ? {
            sessionId: S1,
            command: `claude --resume ${S1}`,
            flagsKnown: true,
            unknownFlags: [],
            ended: 'exited',
            expiring: false,
            expired: false,
            note: null,
            noteTooLong: false,
            ticketUrl: null,
          }
        : null,
    );
    return { ...list, dirs: ['/home/u/project'], favourites: [...kept.favourites] };
  };
  const result = (message: Row, refusal: string | null, sessionId: string | null = null): Row => ({
    t: 'result',
    id: message['id'],
    ok: refusal === null,
    lines: refusal === null ? [] : [refusal],
    error: refusal,
    sessionId,
  });
  const sendList = (conn: StandinConnection): void => {
    if (late === null) conn.send(listNow());
    else setTimeout(() => conn.send(listNow()), late);
  };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        current = conn;
        all.push(message);
        if (message['t'] === 'view') {
          selected = (message['selected'] as string | null) ?? null;
          sendList(conn);
        } else if (message['t'] === 'attach') {
          conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
        } else if (message['t'] === 'act') {
          sent.push(message);
          const text = message['text'] as string;
          if (message['kind'] === 'favourite-add') {
            const refusal = favouriteRefusal(text, kept.favourites);
            if (refusal === null) {
              const at = (message['at'] as number | undefined) ?? kept.favourites.length;
              kept.favourites.splice(Math.min(at, kept.favourites.length), 0, text.trim());
              sendList(conn);
            }
            conn.send(result(message, refusal));
          } else if (message['kind'] === 'favourite-remove') {
            if (refuseRemove.words !== null) {
              conn.send(result(message, refuseRemove.words));
              return;
            }
            kept.favourites = kept.favourites.filter((one) => one !== text);
            sendList(conn);
            conn.send(result(message, null));
          } else if (message['kind'] === 'new') {
            if (answerNew.refuse !== null) {
              conn.send(result(message, answerNew.refuse));
            } else {
              started = true;
              conn.send(result(message, null, S3));
              conn.send(listNow());
            }
          }
        }
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  return {
    page,
    acts: () => [...sent],
    sent: () => [...all],
    get favourites() {
      return kept.favourites;
    },
    setFavourites(list) {
      kept.favourites = [...list];
      current?.send(listNow());
    },
    answerNew,
    refuseRemove,
  };
}

/** Opens the new form from S1's row; the keyboard is in its first field. */
async function openForm(page: Page): Promise<void> {
  await clickRow(page, S1);
  await page.keyboard.press('Control+Shift+N');
  await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
}

interface ChipState {
  text: string;
  title: string;
  on: boolean;
}

async function chips(page: Page): Promise<ChipState[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#cards .card-favourite')].map((chip) => ({
      text: chip.querySelector('.card-favourite-text')?.textContent ?? '',
      title: (chip as HTMLElement).title,
      on: (chip as HTMLElement).dataset['on'] === 'true',
    })),
  );
}

/** Waits until the chips are `wanted` (their texts), then gives their states. */
async function chipsAre(page: Page, wanted: string[]): Promise<ChipState[]> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const now = await chips(page);
    if (JSON.stringify(now.map((chip) => chip.text)) === JSON.stringify(wanted)) return now;
    assert.ok(performance.now() < deadline, `chips ${JSON.stringify(now)}, wanted ${wanted}`);
    await sleep(30);
  }
}

const ons = async (page: Page): Promise<boolean[]> => (await chips(page)).map((chip) => chip.on);
const flagsValue = (page: Page): Promise<string> => page.inputValue('#cards input[name="flags"]');
const activeIs = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return '';
    if (active instanceof HTMLInputElement) return `input:${active.name}`;
    return active.className;
  });

/** The ★: `disabled` is its aria-disabled (it keeps the keyboard and its place of Tab). */
async function star(page: Page): Promise<{ disabled: boolean; title: string }> {
  return page.evaluate(() => {
    const button = document.querySelector('#cards .card-star');
    return button instanceof HTMLButtonElement && !button.disabled
      ? { disabled: button.getAttribute('aria-disabled') === 'true', title: button.title }
      : { disabled: true, title: 'no star, or one that cannot have the keyboard' };
  });
}

async function hint(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('#cards .card-hint')?.textContent ?? '');
}

async function until<T>(read: () => Promise<T>, wanted: T, what: string): Promise<void> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const now = await read();
    if (JSON.stringify(now) === JSON.stringify(wanted)) return;
    assert.ok(performance.now() < deadline, `${what}: ${JSON.stringify(now)}`);
    await sleep(30);
  }
}

test('the favourite flags of the new form', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'no favourite: no chip row; the ★ at the end of the field; the form as before',
    async (t) => {
      const w = await world(t, chromium);
      await openForm(w.page);
      assert.deepEqual(await chips(w.page), []);
      assert.equal(await w.page.isVisible('#cards .card-favourites'), false);
      assert.equal(await w.page.isVisible('#cards .card-star'), true);
      assert.equal(await flagsValue(w.page), '');
      assert.equal(await hint(w.page), HINT);
      const placed = await w.page.evaluate(() => {
        const field = document.querySelector('#cards input[name="flags"]')?.getBoundingClientRect();
        const button = document.querySelector('#cards .card-star')?.getBoundingClientRect();
        return field !== undefined && button !== undefined
          ? { after: button.left >= field.right, line: Math.abs(button.top - field.top) < 12 }
          : null;
      });
      assert.deepEqual(placed, { after: true, line: true });
    },
  );

  await t.test(
    'a chip per favourite, in their order, every one off; typing moves the states as it goes',
    async (t) => {
      const w = await world(t, chromium, ['--model opus', '--verbose', '--model']);
      await openForm(w.page);
      assert.deepEqual(await chipsAre(w.page, ['--model opus', '--verbose', '--model']), [
        { text: '--model opus', title: '--model opus', on: false },
        { text: '--verbose', title: '--verbose', on: false },
        { text: '--model', title: '--model', on: false },
      ]);
      await w.page.click('#cards input[name="flags"]');
      await w.page.keyboard.type('--model op');
      assert.deepEqual(await ons(w.page), [false, false, true]);
      await w.page.keyboard.type('us');
      assert.deepEqual(await ons(w.page), [true, false, true]);
      await w.page.keyboard.type(' --verbose');
      assert.deepEqual(await ons(w.page), [true, true, true]);
      await w.page.keyboard.type(" 'x");
      assert.deepEqual(await ons(w.page), [false, false, false], 'a field that cannot be split');
      await w.page.keyboard.press('Backspace');
      await w.page.keyboard.press('Backspace');
      assert.deepEqual(await ons(w.page), [true, true, true]);
    },
  );

  await t.test(
    'a click on an off chip adds its flags at the end; on an on chip takes them out; the field keeps the keyboard',
    async (t) => {
      const w = await world(t, chromium, ['--model opus', "--append-system-prompt 'be brief'"]);
      await openForm(w.page);
      await chipsAre(w.page, ['--model opus', "--append-system-prompt 'be …"]);
      await w.page.fill('#cards input[name="flags"]', '-d   --verbose  ');
      await w.page.click('#cards .card-favourite >> nth=0');
      assert.equal(await flagsValue(w.page), '-d   --verbose --model opus');
      assert.deepEqual(await ons(w.page), [true, false]);
      assert.equal(await activeIs(w.page), 'input:flags', 'a click on a chip takes no keyboard');
      await w.page.click('#cards .card-favourite >> nth=1');
      assert.equal(
        await flagsValue(w.page),
        "-d   --verbose --model opus --append-system-prompt 'be brief'",
      );
      assert.deepEqual(await ons(w.page), [true, true]);
      await w.page.click('#cards .card-favourite >> nth=0');
      assert.equal(await flagsValue(w.page), "-d   --verbose --append-system-prompt 'be brief'");
      assert.deepEqual(await ons(w.page), [false, true]);
      await w.page.fill('#cards input[name="flags"]', '--append-system-prompt "be brief" -c');
      assert.deepEqual(await ons(w.page), [false, true], 'held by its words, quoted otherwise');
      await w.page.click('#cards .card-favourite >> nth=1');
      assert.equal(await flagsValue(w.page), '-c');

      await w.page.fill('#cards input[name="flags"]', "--x 'open");
      assert.deepEqual(await ons(w.page), [false, false]);
      await w.page.click('#cards .card-favourite >> nth=0');
      assert.equal(await flagsValue(w.page), "--x 'open --model opus", 'added as text');
      assert.deepEqual(w.acts(), [], 'a chip sends nothing');
    },
  );

  await t.test(
    'the ★: enabled only for a text that can be saved, its reason in its title',
    async (t) => {
      const twelve = Array.from({ length: 12 }, (_, i) => `--f${i}`);
      const w = await world(t, chromium, ['--model opus']);
      await openForm(w.page);
      await chipsAre(w.page, ['--model opus']);
      const cases: [string, string | null][] = [
        ['', 'there are no flags to save'],
        ['   ', 'there are no flags to save'],
        ['--verbose', null],
        ["--append-system-prompt 'a b'", null],
        ["--x 'open", "the flags have an unclosed '"],
        ['--x "open', 'the flags have an unclosed "'],
        ['--model\topus', 'the flags contain a line break or another control character'],
        ['--x \u0007', 'the flags contain a line break or another control character'],
        [`--x ${'a'.repeat(196)}`, null],
        [`--x ${'a'.repeat(197)}`, 'a favourite is at most 200 characters'],
        ['--model opus', 'these flags are a favourite already'],
        ["  --model   'opus' ", 'these flags are a favourite already'],
        ['--model opus -c', null],
        ['--resume x', null], // the server's to refuse (prepareNew's rule)
      ];
      for (const [text, reason] of cases) {
        await w.page.fill('#cards input[name="flags"]', text);
        assert.deepEqual(
          await star(w.page),
          {
            disabled: reason !== null,
            title: reason === null ? STAR_TIP : `${STAR_TIP}\n${reason}`,
          },
          JSON.stringify(text),
        );
      }
      w.setFavourites(twelve);
      await chipsAre(w.page, twelve);
      await w.page.fill('#cards input[name="flags"]', '--verbose');
      assert.deepEqual(await star(w.page), {
        disabled: true,
        title: `${STAR_TIP}\nthere are 12 favourites already; remove one first`,
      });
    },
  );

  await t.test(
    'save: the whole text of the field as one favourite; its chip appears, on; a refusal shows its words',
    async (t) => {
      const w = await world(t, chromium, ['--verbose']);
      await openForm(w.page);
      await chipsAre(w.page, ['--verbose']);
      await w.page.fill('#cards input[name="flags"]', '  --model opus   --verbose ');
      await w.page.click('#cards .card-star');
      const after = await chipsAre(w.page, ['--verbose', '--model opus   --verbose']);
      assert.deepEqual(
        after.map((chip) => chip.on),
        [true, true],
      );
      assert.deepEqual(w.acts(), [
        {
          t: 'act',
          id: w.acts()[0]?.['id'],
          kind: 'favourite-add',
          text: '  --model opus   --verbose ',
        },
      ]);
      assert.equal(await flagsValue(w.page), '  --model opus   --verbose ', 'the field as it was');
      assert.equal((await star(w.page)).disabled, true, 'a favourite already');

      // The flags `skydeck new` refuses are the server's to judge (ruled): the ★ takes them, and
      // the server's refusal — prepareNew's words — is the form's result line, as text.
      // A cluster is quoted as typed: `-c<b>x</b>` puts markup into the refusal's words.
      for (const text of ['--resume x', '-n x', '-cp', '-c<b>x</b>']) {
        const words = favouriteRefusal(text, []) ?? '';
        assert.match(words, /^cannot pass .* to claude: /, text);
        await w.page.fill('#cards input[name="flags"]', text);
        assert.equal((await star(w.page)).disabled, false, text);
        await w.page.click('#cards .card-star');
        await until(
          () => w.page.evaluate(() => document.querySelector('#cards .card-lines')?.textContent),
          words,
          `the refusal of ${text}`,
        );
        assert.equal(await flagsValue(w.page), text, 'the field as it was');
        assert.equal(
          await w.page.evaluate(
            () => document.querySelector('#cards .card-lines')?.children.length,
          ),
          0,
          `text, no markup: ${text}`,
        );
      }
      assert.match(favouriteRefusal('-c<b>x</b>', []) ?? '', /<b>x<\/b>/);
      assert.deepEqual(w.favourites, ['--verbose', '--model opus   --verbose'], 'nothing saved');
      await w.page.fill('#cards input[name="flags"]', '-d');
      await w.page.click('#cards .card-star');
      await chipsAre(w.page, ['--verbose', '--model opus   --verbose', '-d']);
      await showsText(w.page, '#cards .card-new .card-lines', /^$/);
    },
  );

  await t.test(
    'remove: × on hover; the hint reads `Removed <text> · Undo`; Undo puts it back at its place; the field never changes',
    async (t) => {
      const w = await world(t, chromium, ['--a', '--model opus', '--c']);
      await openForm(w.page);
      await chipsAre(w.page, ['--a', '--model opus', '--c']);
      await w.page.fill('#cards input[name="flags"]', '-d --model opus');
      const x = w.page.locator('#cards .card-favourite >> nth=1').locator('.card-favourite-x');
      const shown = (): Promise<string> =>
        x.evaluate((element) => getComputedStyle(element).visibility);
      assert.equal(await shown(), 'hidden', 'not shown while the chip is not hovered');
      await w.page.hover('#cards .card-favourite >> nth=1');
      assert.equal(await shown(), 'visible');
      assert.equal(await x.getAttribute('title'), 'Remove this favourite');
      await x.click();
      await chipsAre(w.page, ['--a', '--c']);
      assert.equal(await hint(w.page), 'Removed --model opus · Undo');
      assert.equal(await flagsValue(w.page), '-d --model opus', 'removing never changes the field');
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['text']]),
        [['favourite-remove', '--model opus']],
      );
      assert.equal(await activeIs(w.page), 'input:flags', 'a click on × takes no keyboard');

      await w.page.click('#cards .card-undo');
      await chipsAre(w.page, ['--a', '--model opus', '--c']);
      assert.equal(await activeIs(w.page), 'input:flags', 'a click on Undo takes no keyboard');
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['text'], act['at']]),
        [
          ['favourite-remove', '--model opus', undefined],
          ['favourite-add', '--model opus', 1],
        ],
      );
      assert.equal(await hint(w.page), HINT);
      assert.deepEqual(await ons(w.page), [false, true, false]);

      // The hint keeps its Undo until the favourites change again.
      await w.page.hover('#cards .card-favourite >> nth=0');
      await w.page.click('#cards .card-favourite >> nth=0 >> .card-favourite-x');
      await chipsAre(w.page, ['--model opus', '--c']);
      assert.equal(await hint(w.page), 'Removed --a · Undo');
      w.setFavourites(['--model opus', '--c', '--new']);
      await chipsAre(w.page, ['--model opus', '--c', '--new']);
      assert.equal(await hint(w.page), HINT, 'another window changed them');
      assert.equal(await flagsValue(w.page), '-d --model opus');
    },
  );

  await t.test(
    'a removed favourite that comes back takes the Undo away: saved again from this form, or by another window',
    async (t) => {
      const w = await world(t, chromium, ['--a', '--x']);
      await openForm(w.page);
      await chipsAre(w.page, ['--a', '--x']);
      await w.page.hover('#cards .card-favourite >> nth=1');
      await w.page.click('#cards .card-favourite >> nth=1 >> .card-favourite-x');
      await chipsAre(w.page, ['--a']);
      assert.equal(await hint(w.page), 'Removed --x · Undo');
      await w.page.fill('#cards input[name="flags"]', '--x');
      await w.page.click('#cards .card-star');
      await chipsAre(w.page, ['--a', '--x']);
      assert.equal(await hint(w.page), HINT, 'saved again here');

      await w.page.hover('#cards .card-favourite >> nth=1');
      await w.page.click('#cards .card-favourite >> nth=1 >> .card-favourite-x');
      await chipsAre(w.page, ['--a']);
      assert.equal(await hint(w.page), 'Removed --x · Undo');
      w.setFavourites(['--a', '--x']);
      await chipsAre(w.page, ['--a', '--x']);
      assert.equal(await hint(w.page), HINT, 'put back by another window');
    },
  );

  await t.test(
    'the answer before its list (the real server, when it listed less than a second before): the ★ waits for the list, a second removal keeps its Undo',
    async (t) => {
      const w = await world(t, chromium, ['--a', '--b', '--c'], 700);
      await openForm(w.page);
      await chipsAre(w.page, ['--a', '--b', '--c']);
      await w.page.fill('#cards input[name="flags"]', '--d');
      assert.equal(
        await w.page.evaluate(() => {
          const button = document.querySelector('#cards .card-star');
          if (!(button instanceof HTMLButtonElement)) return 'no star';
          button.click();
          return button.getAttribute('aria-disabled');
        }),
        'true',
        'disabled from the click on, before the answer',
      );
      await until(async () => w.acts().length, 1, 'the save sent');
      await sleep(150);
      assert.equal((await star(w.page)).disabled, true, 'waiting for its list');
      await w.page.click('#cards .card-star', { force: true }); // aria-disabled: Playwright would wait
      await chipsAre(w.page, ['--a', '--b', '--c', '--d']);
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['text']]),
        [['favourite-add', '--d']],
        'one save',
      );
      const sent = w.sent();
      const saved = sent.findIndex((message) => message['t'] === 'act');
      assert.ok(
        sent.slice(saved + 1).some((message) => message['t'] === 'view'),
        'after the answer the page asks for a list (a view)',
      );
      assert.equal(
        await w.page.evaluate(() => document.querySelector('#cards .card-lines')?.textContent),
        '',
      );

      // Two removals within the list's delay: each chip goes at its click, the second's Undo stays
      // when the lists come, and puts it back in its place.
      await w.page.hover('#cards .card-favourite >> nth=0');
      await w.page.click('#cards .card-favourite >> nth=0 >> .card-favourite-x');
      assert.deepEqual(
        (await chips(w.page)).map((chip) => chip.text),
        ['--b', '--c', '--d'],
        'gone at the click',
      );
      await w.page.hover('#cards .card-favourite >> nth=1');
      await w.page.click('#cards .card-favourite >> nth=1 >> .card-favourite-x');
      assert.equal(await hint(w.page), 'Removed --c · Undo');
      assert.deepEqual(
        (await chips(w.page)).map((chip) => chip.text),
        ['--b', '--d'],
      );
      await sleep(1000); // every list of the two removals has come
      assert.deepEqual(w.favourites, ['--b', '--d']);
      assert.equal(await hint(w.page), 'Removed --c · Undo');
      await w.page.click('#cards .card-undo');
      await chipsAre(w.page, ['--b', '--c', '--d']);
      await sleep(1000);
      await chipsAre(w.page, ['--b', '--c', '--d']);
      assert.equal(await hint(w.page), HINT);
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['text'], act['at']]),
        [
          ['favourite-add', '--d', undefined],
          ['favourite-remove', '--a', undefined],
          ['favourite-remove', '--c', undefined],
          ['favourite-add', '--c', 1],
        ],
      );
    },
  );

  await t.test(
    'on the real test server (it answers first when it listed the page less than a second before): two saves in a row, two quick removals and Undo',
    async (t) => {
      const l = await launched(t, chromium);
      const p = l.page;
      await p.keyboard.press('Control+Shift+N');
      await p.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      for (const text of ['--a', '--b']) {
        await p.fill('#cards input[name="flags"]', text);
        await p.click('#cards .card-star');
        const deadline = performance.now() + PAGE_WAIT_MS;
        for (;;) {
          const now = await p.evaluate(
            (text) => ({
              chip: [...document.querySelectorAll('#cards .card-favourite-text')].some(
                (chip) => chip.textContent === text,
              ),
              off:
                document.querySelector('#cards .card-star')?.getAttribute('aria-disabled') ===
                'true',
            }),
            text,
          );
          assert.ok(now.chip || now.off, `${text}: the ★ enabled again with no chip`);
          if (now.chip) break;
          assert.ok(performance.now() < deadline, `${text}: its chip`);
          await sleep(5);
        }
      }
      await chipsAre(p, ['--a', '--b']);
      assert.equal(
        await p.evaluate(() => document.querySelector('#cards .card-lines')?.textContent),
        '',
      );

      await p.hover('#cards .card-favourite >> nth=0');
      await p.click('#cards .card-favourite >> nth=0 >> .card-favourite-x');
      await p.hover('#cards .card-favourite >> nth=0');
      await p.click('#cards .card-favourite >> nth=0 >> .card-favourite-x');
      assert.equal(await hint(p), 'Removed --b · Undo');
      await sleep(1500); // every list of the two removals has come
      await chipsAre(p, []);
      assert.equal(await hint(p), 'Removed --b · Undo');
      await p.click('#cards .card-undo');
      await chipsAre(p, ['--b']);
      await sleep(1500);
      await chipsAre(p, ['--b']);
      assert.equal(await hint(p), HINT);
      assert.equal(
        await p.evaluate(() => document.querySelector('#cards .card-lines')?.textContent),
        '',
      );
      assert.equal(l.d.deck.store.getKv('window_favourites'), '["--b"]');
    },
  );

  await t.test(
    'a held Delete or Backspace removes one chip; the last one gone, the ★ takes the keyboard and the repeats never reach the field',
    async (t) => {
      const w = await world(t, chromium, ['--a', '--b', '--c']);
      await openForm(w.page);
      await chipsAre(w.page, ['--a', '--b', '--c']);
      await w.page.fill('#cards input[name="flags"]', '--verbose --model opus');
      await w.page.focus('#cards .card-favourites');
      await w.page.keyboard.down('Delete');
      await w.page.keyboard.down('Delete'); // auto-repeats
      await w.page.keyboard.down('Delete');
      await w.page.keyboard.up('Delete');
      await chipsAre(w.page, ['--b', '--c']);
      assert.equal(w.acts().length, 1, 'one removal');
      await w.page.keyboard.press('Delete');
      await w.page.keyboard.press('Delete');
      await chipsAre(w.page, []);
      assert.equal(await activeIs(w.page), 'card-button card-star', 'the ★ before the row');

      for (const key of ['Backspace', 'Delete']) {
        w.setFavourites(['--only']);
        await chipsAre(w.page, ['--only']);
        await w.page.focus('#cards input[name="flags"]');
        await w.page.keyboard.press(key === 'Delete' ? 'Home' : 'End');
        await w.page.focus('#cards .card-favourites');
        await w.page.keyboard.down(key);
        await chipsAre(w.page, []);
        assert.equal(await activeIs(w.page), 'card-button card-star', `${key}: no text field`);
        for (let i = 0; i < 5; i++) await w.page.keyboard.down(key); // still held
        await w.page.keyboard.up(key);
        assert.equal(
          await flagsValue(w.page),
          '--verbose --model opus',
          `${key}: the field as it was`,
        );
        assert.equal(await activeIs(w.page), 'card-button card-star');
      }
      assert.equal(w.acts().length, 5, 'one removal for each press');
    },
  );

  await t.test(
    'the ★ from the keyboard keeps it (ruled): Space saves, refused or not, Enter starts; Directory never gets the keyboard or a letter; a click on a disabled ★ leaves the keyboard where it was',
    async (t) => {
      const w = await world(t, chromium, ['--a']);
      w.answerNew.refuse = 'refused';
      await openForm(w.page);
      await chipsAre(w.page, ['--a']);
      const untouched = async (what: string): Promise<void> => {
        assert.equal(await activeIs(w.page), 'card-button card-star', what);
        await w.page.keyboard.type('zz');
        assert.equal(await activeIs(w.page), 'card-button card-star', `${what}: still`);
        assert.equal(
          await w.page.inputValue('#cards input[name="directory"]'),
          '/home/u/project',
          `${what}: Directory untouched`,
        );
        assert.equal(await w.page.inputValue('#cards input[name="label"]'), '', what);
      };
      await w.page.fill('#cards input[name="flags"]', '--x');
      await w.page.focus('#cards .card-star');
      await w.page.keyboard.press('Space');
      await chipsAre(w.page, ['--a', '--x']);
      assert.equal((await star(w.page)).disabled, true, 'a favourite already');
      await untouched('after Space saved');
      assert.equal(await flagsValue(w.page), '--x');

      await w.page.fill('#cards input[name="flags"]', '--resume x');
      await w.page.focus('#cards .card-star');
      await w.page.keyboard.press('Space');
      await until(
        () => w.page.evaluate(() => document.querySelector('#cards .card-lines')?.textContent),
        favouriteRefusal('--resume x', []),
        'the refusal',
      );
      await untouched('after a refusal');

      await w.page.focus('#cards .card-star');
      await w.page.keyboard.press('Enter');
      await showsText(w.page, '#cards .card-new .card-lines', /^refused$/);
      await untouched('after Enter, which starts');
      assert.equal(w.acts().filter((act) => act['kind'] === 'new').length, 1);

      await w.page.fill('#cards input[name="flags"]', '');
      await w.page.focus('#cards input[name="directory"]');
      assert.equal((await star(w.page)).disabled, true);
      await w.page.click('#cards .card-star', { force: true }); // aria-disabled: Playwright would wait
      assert.equal(await activeIs(w.page), 'input:directory', 'a click takes no keyboard');
      assert.equal(
        w.acts().filter((act) => act['kind'] === 'favourite-add').length,
        2,
        'a disabled ★ sends nothing',
      );
    },
  );

  await t.test(
    "a removal the server refuses shows the server's words and changes nothing; Ctrl, Alt or Meta with a row key is not that key",
    async (t) => {
      const w = await world(t, chromium, ['--a', '--b']);
      w.refuseRemove.words = "skydeck's database is busy; try again";
      await openForm(w.page);
      await chipsAre(w.page, ['--a', '--b']);
      await w.page.fill('#cards input[name="flags"]', '--a');
      await w.page.hover('#cards .card-favourite >> nth=0');
      await w.page.click('#cards .card-favourite >> nth=0 >> .card-favourite-x');
      await until(
        () => w.page.evaluate(() => document.querySelector('#cards .card-lines')?.textContent),
        "skydeck's database is busy; try again",
        'the refusal',
      );
      await chipsAre(w.page, ['--a', '--b']);
      assert.equal(await hint(w.page), HINT, 'no Undo for what was not removed');
      assert.equal(await flagsValue(w.page), '--a');
      assert.deepEqual(w.favourites, ['--a', '--b']);

      w.refuseRemove.words = null;
      await w.page.focus('#cards .card-favourites');
      const current = (): Promise<string> =>
        w.page.evaluate(
          () =>
            document.querySelector(
              '#cards .card-favourite[data-current="true"] .card-favourite-text',
            )?.textContent ?? '',
        );
      assert.equal(await current(), '--a');
      for (const key of [
        'Control+ArrowRight',
        'Shift+ArrowRight',
        'Control+Delete',
        'Alt+Delete',
        'Meta+Delete',
        'Control+Backspace',
        'Alt+Backspace',
        'Control+Space',
        'Alt+Space',
        'Meta+Space',
      ]) {
        await w.page.keyboard.press(key);
        assert.equal(await current(), '--a', key);
      }
      await chipsAre(w.page, ['--a', '--b']);
      assert.equal(await flagsValue(w.page), '--a', 'no chip turned on or off');
      assert.equal(
        w.acts().filter((act) => act['kind'] === 'favourite-remove').length,
        1,
        'only the refused one',
      );
      await w.page.keyboard.press('ArrowRight');
      assert.equal(await current(), '--b', 'the key alone acts');
    },
  );

  await t.test(
    'for show, a favourite is sanitised in its chip, its title and the hint; the hint cuts it as the chip does, whole in its title',
    async (t) => {
      const long = "--append-system-prompt 'reply in at most three sentences'";
      const odd = '--x \x1b[31mred\tb\u202eack';
      const w = await world(t, chromium, [odd, long]);
      await openForm(w.page);
      const shown = await chipsAre(w.page, ['--x red back', "--append-system-prompt 'rep…"]);
      assert.deepEqual(
        shown.map((chip) => chip.title),
        ['--x red back', long],
      );
      await w.page.hover('#cards .card-favourite >> nth=1');
      await w.page.click('#cards .card-favourite >> nth=1 >> .card-favourite-x');
      await chipsAre(w.page, ['--x red back']);
      assert.equal(await hint(w.page), "Removed --append-system-prompt 'rep… · Undo");
      assert.equal(await w.page.getAttribute('#cards .card-hint-favourite', 'title'), long);
      await w.page.hover('#cards .card-favourite >> nth=0');
      await w.page.click('#cards .card-favourite >> nth=0 >> .card-favourite-x');
      await chipsAre(w.page, []);
      assert.equal(await hint(w.page), 'Removed --x red back · Undo');
      assert.equal(
        await w.page.getAttribute('#cards .card-hint-favourite', 'title'),
        '--x red back',
      );
      assert.deepEqual(
        w.acts().map((act) => act['text']),
        [long, odd],
        'the removals name the texts as stored',
      );
      assert.equal(
        await w.page.getByRole('textbox', { name: 'Flags for claude', exact: true }).count(),
        1,
        "the field's name is its label alone",
      );
    },
  );

  await t.test(
    'the keyboard: ★ and the chip row after the field and before Start, the row one Tab stop; ← → Space Delete Backspace; Enter starts; no list key acts',
    async (t) => {
      const w = await world(t, chromium, ['--a', '--b', '--c', '--d']);
      w.answerNew.refuse = 'refused';
      await openForm(w.page);
      await chipsAre(w.page, ['--a', '--b', '--c', '--d']);
      await w.page.fill('#cards input[name="flags"]', '-x');
      await w.page.focus('#cards input[name="directory"]');
      const order: string[] = [];
      for (let i = 0; i < 6; i++) {
        await w.page.keyboard.press('Tab');
        order.push(await activeIs(w.page));
      }
      assert.deepEqual(order, [
        'input:label',
        'input:group',
        'input:flags',
        'card-button card-star',
        'card-favourites',
        'card-button primary',
      ]);
      await w.page.keyboard.press('Shift+Tab');
      assert.equal(await activeIs(w.page), 'card-favourites');

      const current = (): Promise<string> =>
        w.page.evaluate(
          () =>
            document.querySelector(
              '#cards .card-favourite[data-current="true"] .card-favourite-text',
            )?.textContent ?? '',
        );
      assert.equal(await current(), '--a');
      const xShown = (): Promise<string> =>
        w.page.evaluate(() => {
          const x = document.querySelector(
            '#cards .card-favourite[data-current="true"] .card-favourite-x',
          );
          return x === null ? '' : getComputedStyle(x).visibility;
        });
      await w.page.mouse.move(0, 0);
      assert.equal(await xShown(), 'visible', 'the × of the chip that has the keyboard');
      await w.page.keyboard.press('ArrowRight');
      await w.page.keyboard.press('ArrowRight');
      assert.equal(await current(), '--c');
      await w.page.keyboard.press('ArrowLeft');
      assert.equal(await current(), '--b');
      await w.page.keyboard.press('ArrowLeft');
      await w.page.keyboard.press('ArrowLeft');
      assert.equal(await current(), '--a', 'it stops at the first');

      await w.page.keyboard.press('Space');
      assert.equal(await flagsValue(w.page), '-x --a');
      assert.deepEqual(await ons(w.page), [true, false, false, false]);
      // What a screen reader hears: the chips' states and the one that has the keyboard.
      assert.deepEqual(
        await w.page.evaluate(() => {
          const row = document.querySelector('#cards .card-favourites');
          const chips = [...document.querySelectorAll('#cards .card-favourite')];
          return {
            selected: chips.map((chip) => chip.getAttribute('aria-selected')),
            current: row?.getAttribute('aria-activedescendant') === chips[0]?.id,
          };
        }),
        { selected: ['true', 'false', 'false', 'false'], current: true },
      );
      await w.page.keyboard.press('Space');
      assert.equal(await flagsValue(w.page), '-x');
      await w.page.keyboard.down(' ');
      await w.page.keyboard.down(' '); // a held Space (one repeat: an even count) turns it on once
      await w.page.keyboard.up(' ');
      assert.equal(await flagsValue(w.page), '-x --a');
      await w.page.keyboard.press('Space');
      assert.equal(await flagsValue(w.page), '-x');

      // No list key and no other key of the page acts while the row has the keyboard.
      for (const key of [
        'j',
        'k',
        'd',
        'l',
        'g',
        'n',
        'p',
        '/',
        'ArrowDown',
        'ArrowUp',
        'Home',
        'End',
      ]) {
        await w.page.keyboard.press(key);
      }
      assert.equal(await activeIs(w.page), 'card-favourites');
      assert.equal(await w.page.getAttribute('#right-zone', 'data-pane'), 'new');
      assert.equal(await w.page.isVisible('#editor'), false, 'no dialog');
      assert.equal(await flagsValue(w.page), '-x');
      assert.deepEqual(w.acts(), []);

      await w.page.keyboard.press('ArrowRight');
      await w.page.keyboard.press('Delete');
      await chipsAre(w.page, ['--a', '--c', '--d']);
      assert.equal(await hint(w.page), 'Removed --b · Undo');
      assert.equal(await activeIs(w.page), 'card-favourites', 'the row keeps the keyboard');
      assert.equal(await current(), '--c', 'the next chip has it');
      await w.page.keyboard.press('ArrowRight');
      await w.page.keyboard.press('Backspace');
      await chipsAre(w.page, ['--a', '--c']);
      assert.equal(await current(), '--c', 'the last one gone: the one before it');
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['text']]),
        [
          ['favourite-remove', '--b'],
          ['favourite-remove', '--d'],
        ],
      );
      assert.equal(await flagsValue(w.page), '-x');

      await w.page.keyboard.press('Enter');
      await showsText(w.page, '#cards .card-new .card-lines', /^refused$/);
      const starts = w.acts().filter((act) => act['kind'] === 'new');
      assert.equal(starts.length, 1, 'Enter on the row starts, once');
      assert.equal(starts[0]?.['flags'], '-x');

      await w.page.focus('#cards .card-favourites');
      await w.page.keyboard.press('Escape');
      await w.page.waitForSelector('#right-zone:not([data-pane="new"])', { state: 'attached' });
    },
  );

  await t.test(
    "a window chord acts from the chip row as from the form's fields (ruled); the row's own keys are no chord",
    async (t) => {
      const w = await world(t, chromium, ['--a', '--b']);
      await openForm(w.page);
      await chipsAre(w.page, ['--a', '--b']);
      await w.page.focus('#cards .card-favourites');
      await showsText(w.page, '#focus-zone', /^Focus: terminal$/);
      await w.page.keyboard.press('Space');
      await w.page.keyboard.press('ArrowRight');
      assert.equal(await flagsValue(w.page), '--a', 'Space is the row’s');
      assert.equal(await activeIs(w.page), 'card-favourites');
      await w.page.keyboard.press('Control+Shift+L');
      await showsText(w.page, '#focus-zone', /^Focus: list$/);
      assert.equal(await flagsValue(w.page), '--a');
      assert.deepEqual(w.acts(), []);
    },
  );

  await t.test('Enter on the ★ starts too, as everywhere in the form', async (t) => {
    const w = await world(t, chromium);
    w.answerNew.refuse = 'refused';
    await openForm(w.page);
    await w.page.fill('#cards input[name="flags"]', '--verbose');
    await w.page.focus('#cards .card-star');
    await w.page.keyboard.press('Enter');
    await showsText(w.page, '#cards .card-new .card-lines', /^refused$/);
    assert.deepEqual(
      w.acts().map((act) => [act['kind'], act['flags']]),
      [['new', '--verbose']],
    );
    await w.page.keyboard.press('Space');
    await chipsAre(w.page, ['--verbose']);
  });

  await t.test(
    'the last chip removed from the keyboard: the ★ takes the keyboard; Enter on Undo is Undo, not Start (ruled), and the chip it puts back takes the keyboard',
    async (t) => {
      const w = await world(t, chromium, ['--only']);
      await openForm(w.page);
      await chipsAre(w.page, ['--only']);
      await w.page.focus('#cards .card-favourites');
      await w.page.keyboard.press('Delete');
      await chipsAre(w.page, []);
      assert.equal(await w.page.isVisible('#cards .card-favourites'), false);
      assert.equal(await activeIs(w.page), 'card-button card-star', 'the ★, never the field');
      assert.equal((await star(w.page)).disabled, true, 'a disabled ★ keeps the keyboard');
      await w.page.keyboard.press('Shift+Tab');
      assert.equal(await activeIs(w.page), 'input:flags', 'the ★ keeps its place of Tab');
      await w.page.keyboard.press('Tab');
      await w.page.keyboard.press('Tab');
      assert.equal(await activeIs(w.page), 'card-button primary', 'no row without a favourite');
      await w.page.keyboard.press('Tab');
      assert.equal(await activeIs(w.page), 'card-undo', 'after Start: the hint’s Undo');
      await w.page.keyboard.press('Enter');
      await chipsAre(w.page, ['--only']);
      assert.equal(await activeIs(w.page), 'card-favourites', 'the chip it put back has it');
      assert.deepEqual(
        w.acts().map((act) => [act['kind'], act['text'], act['at']]),
        [
          ['favourite-remove', '--only', undefined],
          ['favourite-add', '--only', 0],
        ],
        'no new session',
      );
      assert.equal(await hint(w.page), HINT);
      assert.equal(await w.page.getAttribute('#right-zone', 'data-pane'), 'new');
    },
  );

  await t.test(
    'a session started with a favourite; the form opened again: its field empty, every chip off',
    async (t) => {
      const w = await world(t, chromium, ['--model opus', '--verbose']);
      await openForm(w.page);
      await chipsAre(w.page, ['--model opus', '--verbose']);
      await w.page.click('#cards .card-favourite >> nth=0');
      await w.page.click('#cards button:text-is("Start")');
      await w.page.waitForSelector('#right-zone[data-pane="terminal"]', { state: 'attached' });
      const start = w.acts().find((act) => act['kind'] === 'new');
      assert.equal(start?.['flags'], '--model opus', 'Start sends the field’s text');

      await w.page.keyboard.press('Control+Shift+N');
      await w.page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await chipsAre(w.page, ['--model opus', '--verbose']);
      assert.equal(await flagsValue(w.page), '');
      assert.deepEqual(await ons(w.page), [false, false]);
      assert.equal(await hint(w.page), HINT);
    },
  );

  await t.test(
    'twelve favourites, long ones cut at 28 with `…` and whole in the title; the row wraps and Start stays in the card',
    async (t) => {
      const long = (n: number): string =>
        `--append-system-prompt 'reply in ${n} words or less, always'`;
      const favourites = [
        ...Array.from({ length: 6 }, (_, i) => long(i + 1)),
        ...Array.from({ length: 6 }, (_, i) => `--f${i}`),
      ];
      const w = await world(t, chromium, favourites);
      for (const width of [1280, 800]) {
        await w.page.setViewportSize({ width, height: 800 });
        await openForm(w.page);
        const shown = await chipsAre(w.page, [
          ...Array.from({ length: 6 }, () => "--append-system-prompt 'rep…"),
          ...Array.from({ length: 6 }, (_, i) => `--f${i}`),
        ]);
        assert.deepEqual(
          shown.map((chip) => chip.title),
          favourites,
        );
        const box = await w.page.evaluate(() => {
          const card = document.querySelector('#cards .card-new')?.closest('.card');
          const start = document.querySelector('#cards button.primary');
          const row = document.querySelector('#cards .card-favourites');
          if (!(card instanceof HTMLElement) || start === null || !(row instanceof HTMLElement)) {
            return null;
          }
          const c = card.getBoundingClientRect();
          const s = start.getBoundingClientRect();
          const tops = new Set(
            [...row.querySelectorAll('.card-favourite')].map((chip) =>
              Math.round(chip.getBoundingClientRect().top),
            ),
          );
          return {
            inside: s.left >= c.left && s.right <= c.right && s.bottom <= c.bottom,
            fits: card.scrollWidth <= card.clientWidth && row.scrollWidth <= row.clientWidth,
            lines: tops.size,
          };
        });
        assert.ok(box !== null);
        assert.equal(box.inside, true, `Start in the card at ${width} px`);
        assert.equal(box.fits, true, `nothing runs past the card at ${width} px`);
        assert.ok(box.lines >= 2, `the row wraps at ${width} px: ${box.lines} lines`);
        await w.page.keyboard.press('Escape');
      }
    },
  );

  await t.test('favourite text reaches the page as text, never as markup', async (t) => {
    const hostile = `--append-system-prompt '<b>bold</b>' "<img src=x onerror=1>"`;
    const w = await world(t, chromium, [hostile, '<i>x</i>']);
    await openForm(w.page);
    const shown = await chipsAre(w.page, ["--append-system-prompt '<b>…", '<i>x</i>']);
    assert.deepEqual(
      shown.map((chip) => chip.title),
      [hostile, '<i>x</i>'],
    );
    assert.equal(await w.page.locator('#cards b, #cards i, #cards img').count(), 0);
    await w.page.click('#cards .card-favourite >> nth=1');
    assert.equal(await flagsValue(w.page), '<i>x</i>');
    await w.page.hover('#cards .card-favourite >> nth=1');
    await w.page.click('#cards .card-favourite >> nth=1 >> .card-favourite-x');
    await chipsAre(w.page, ["--append-system-prompt '<b>…"]);
    assert.equal(await hint(w.page), 'Removed <i>x</i> · Undo');
    assert.equal(await w.page.locator('#cards i').count(), 0);
  });
});
