// Update now in the page (follow-up F38, milestone 2; S2 16.5 "Update now", 6.3): the dialog's
// second click, the running form on every page while an update runs, S2 6.3's bar while the server
// is away (the update's log first, `skydeck window` second), the result bar after it comes back,
// and no end of a connection that leaves a page inert. Against scripted stand-ins of
// test-page/helpers/shell.ts, in the manner of `bannerWorld`: the test sends each `update` itself
// and answers each act; a stand-in that comes back on the same port serving other files is
// another build. Nothing real is applied.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { createSettings } from '../src/window/settings.ts';
import type { UpdatePayload } from '../src/window/protocol.ts';
import { testDeck } from '../test/helpers/deck.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  connection,
  escape,
  honest,
  pageUrl,
  readPage,
  scriptedList,
  showsText,
  standinServer,
  storeKey,
} from './helpers/shell.ts';
import type { Standin, StandinConnection } from './helpers/shell.ts';
import { until } from './helpers/terminal.ts';

const TO = '5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';
const LOG = '/home/you/.local/state/skydeck/update.log';
const LINES = ['1 new commit on origin/main (0123456..5d6e7f8):', '  5d6e7f8  the new commit'];
const RUNNING = 'skydeck is being updated to 5d6e7f8. The window comes back by itself.';
const STALE_UNSTORED =
  "this window's page is not the one skydeck's server serves, and its key could not be stored, so it cannot reload itself; run skydeck window again";
const NOT_VALID = "this window's key is not valid; run skydeck window again";

/** An `update` payload: an update to TO that can be applied, unless `over` says otherwise. */
function state(over: Partial<UpdatePayload> = {}): UpdatePayload {
  return {
    checking: false,
    check: {
      state: 'available',
      summary: '1 new commit on origin/main',
      to: TO,
      lines: LINES,
      blocked: null,
    },
    checkedAtNs: '1794474000000000000',
    fetchedAtNs: '1794474000000000000',
    failure: null,
    applying: null,
    log: LOG,
    result: null,
    ...over,
  };
}

const APPLYING = state({ applying: { to: TO, sinceNs: '1794474000000000000' } });

/** What the page sent on one connection, and that connection. */
interface Seen {
  conn: StandinConnection;
  acts: Record<string, unknown>[];
}

interface World {
  standin: Standin;
  secret: Uint8Array;
  pages: Page[];
  /** Every connection so far, in order, with the acts it carried. */
  seen: Seen[];
  /** Sends `update` to every open connection. */
  tell(update: UpdatePayload): void;
  /** The `n`-th act (1, 2, …) of the kind `kind` on any connection, once it has come. */
  act(kind: string, n?: number): Promise<{ seen: Seen; act: Record<string, unknown> }>;
  /** Answers `act` on its connection. */
  answer(
    at: { seen: Seen; act: Record<string, unknown> },
    result: { ok: boolean; error?: string; update?: UpdatePayload },
  ): void;
}

/** A socket handler for a stand-in: every page proven by `secret`, lists answered, acts recorded. */
function socketOf(
  secret: Uint8Array,
  seen: Seen[],
  options: { first?: UpdatePayload; assetVersion?: string } = {},
): (conn: StandinConnection) => void {
  return honest(secret, {
    ...(options.assetVersion === undefined ? {} : { assetVersion: options.assetVersion }),
    open: (conn, message) => {
      let entry = seen.find((s) => s.conn === conn);
      if (entry === undefined) {
        entry = { conn, acts: [] };
        seen.push(entry);
        // The server's `update` right after `start` (pages.ts): what holds now.
        if (options.first !== undefined) conn.send({ t: 'update', update: options.first });
      }
      if (message['t'] === 'view') {
        conn.send(scriptedList([], []));
      } else if (message['t'] === 'act') {
        entry.acts.push(message);
      }
    },
  });
}

/** Two pages of one stand-in, connected with a stored key; the test sends every `update`. */
async function world(t: TestContext, chromium: Browser): Promise<World> {
  const secret = new Uint8Array(32).fill(91);
  const seen: Seen[] = [];
  const standin = await standinServer(t, { socket: socketOf(secret, seen) });
  const first = await newPage(t, chromium);
  await first.goto(standin.url);
  await storeKey(first, secret);
  await first.goto(standin.url);
  await connection(first, 'open');
  const second = await first.context().newPage();
  await second.goto(standin.url);
  await connection(second, 'open');
  return {
    standin,
    secret,
    pages: [first, second],
    seen,
    tell(update) {
      for (const { conn } of seen) {
        if (conn.ws.readyState === conn.ws.OPEN) conn.send({ t: 'update', update });
      }
    },
    async act(kind, n = 1) {
      let found: { seen: Seen; act: Record<string, unknown> } | null = null;
      await until(() => {
        const all = seen.flatMap((s) => s.acts.map((act) => ({ seen: s, act })));
        found = all.filter((a) => a.act['kind'] === kind)[n - 1] ?? null;
        return found !== null;
      }, `act ${kind} #${n}`);
      assert.ok(found !== null);
      return found;
    },
    answer({ seen: s, act }, result) {
      const error = result.error ?? null;
      s.conn.send({
        t: 'result',
        id: act['id'],
        ok: result.ok,
        lines: error === null ? [] : [error],
        error,
        sessionId: null,
        ...(result.update === undefined ? {} : { update: result.update }),
      });
    },
  };
}

/** Whether the update dialog shows, its lines, its visible buttons, and whether the page is inert. */
function dialogOf(page: Page): Promise<{
  shown: boolean;
  lines: string[];
  buttons: string[];
  inert: boolean;
  focus: string;
}> {
  return readPage(
    page,
    () => {
      const root = document.getElementById('update-dialog');
      return {
        shown: root?.hidden === false,
        lines: [...document.querySelectorAll('#update-dialog .update-line')].map(
          (line) => line.textContent ?? '',
        ),
        buttons: [...document.querySelectorAll<HTMLButtonElement>('#update-dialog button')]
          .filter((button) => !button.hidden)
          .map((button) => button.textContent ?? ''),
        inert: (document.querySelector('.app') as HTMLElement | null)?.inert === true,
        focus: document.activeElement?.className ?? '',
      };
    },
    null,
  );
}

/** Opens the dialog on `page` and answers its look with `update`. */
async function openDialog(w: World, page: Page, update: UpdatePayload, n: number): Promise<void> {
  await until(
    async () => await readPage(page, () => !document.getElementById('update-button')?.hidden, null),
    'the title bar shows Update available',
  );
  await page.locator('#update-button').click();
  w.answer(await w.act('update-look', n), { ok: true, update });
  await until(
    async () => (await dialogOf(page)).lines[0] === LINES[0],
    'the dialog drew the answer',
  );
}

/** Waits until the running form shows on `page`, over an inert page. */
async function runningOn(page: Page): Promise<void> {
  await until(async () => {
    const d = await dialogOf(page);
    return d.shown && d.inert && d.lines.join('\n') === RUNNING && d.buttons.length === 0;
  }, 'the running form');
}

/** Waits until the running form is gone and the page is not inert. */
async function liftedOn(page: Page): Promise<void> {
  await until(async () => {
    const d = await dialogOf(page);
    return !d.shown && !d.inert;
  }, 'the running form lifted, the page not inert');
}

/** The applying state told, both pages in the running form, then the stand-in gone. */
async function appliedAndGone(w: World): Promise<void> {
  w.tell(APPLYING);
  for (const page of w.pages) await runningOn(page);
  await w.standin.close();
}

const AWAY = new RegExp(
  `^skydeck is being updated \\(since \\d\\d:\\d\\d:\\d\\d\\): the server restarts by itself and this window comes back; sessions keep running\\. If it is not back within two minutes, the update's log says why: ${escape(LOG)} — read it first; then, in a WSL terminal: skydeck window$`,
);

const SID = '11111111-2222-4333-8444-555555555555';
const TERM = 'aaaaaaaaaaaaaaaa';
const TICKET = 'https://tickets.example.com/browse/{key}';

/**
 * Two pages of a stand-in whose list has one running, endable session, and whose settings screen
 * is the server's own for a sandbox config.json holding a ticket address (createSettings); every
 * act is recorded, and only `settings` is answered.
 */
async function rowWorld(t: TestContext, chromium: Browser): Promise<World> {
  const secret = new Uint8Array(32).fill(95);
  const seen: Seen[] = [];
  const d = testDeck(t, { config: { ticketUrl: TICKET } });
  const settings = createSettings({ deck: d.deck, log: () => {} });
  const list = (): Record<string, unknown> => {
    const made = scriptedList(
      [{ id: SID, terminal: TERM, slot: 1, title: 'alpha' }],
      [{ id: TERM, slot: 1, sessionId: SID }],
    ) as { sections: { rows: Record<string, unknown>[] }[] };
    const row = made.sections[0]?.rows[0];
    if (row !== undefined) row['endable'] = true;
    return made as unknown as Record<string, unknown>;
  };
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        let entry = seen.find((s) => s.conn === conn);
        if (entry === undefined) {
          entry = { conn, acts: [] };
          seen.push(entry);
        }
        if (message['t'] === 'view') {
          conn.send(list());
        } else if (message['t'] === 'act') {
          entry.acts.push(message);
          if (message['kind'] === 'settings') {
            conn.send({
              t: 'result',
              id: message['id'],
              ok: true,
              lines: [],
              error: null,
              sessionId: null,
              settings: settings.payload(),
            });
          }
        }
      },
    }),
  });
  const first = await newPage(t, chromium);
  await first.goto(standin.url);
  await storeKey(first, secret);
  await first.goto(standin.url);
  await connection(first, 'open');
  const second = await first.context().newPage();
  await second.goto(standin.url);
  await connection(second, 'open');
  return {
    standin,
    secret,
    pages: [first, second],
    seen,
    tell(update) {
      for (const { conn } of seen) {
        if (conn.ws.readyState === conn.ws.OPEN) conn.send({ t: 'update', update });
      }
    },
    act: () => Promise.reject(new Error('not used here')),
    answer: () => {},
  };
}

/** Which of the page's dialogs are hidden, whether it is inert, and where the keyboard is. */
function pageFacts(page: Page): Promise<{
  hidden: Record<string, boolean | undefined>;
  inert: boolean;
  inUpdate: boolean;
  focus: string;
}> {
  return readPage(
    page,
    () => {
      const hid = (id: string): boolean | undefined => {
        const hidden = document.getElementById(id)?.hidden;
        return hidden === undefined ? undefined : hidden === true;
      };
      const holder = document.activeElement;
      return {
        hidden: {
          editor: hid('editor'),
          end: hid('end-dialog'),
          settings: hid('settings'),
          switcher: hid('switcher'),
        },
        inert: (document.querySelector('.app') as HTMLElement | null)?.inert === true,
        inUpdate: document.getElementById('update-dialog')?.contains(holder) === true,
        focus: `${holder?.tagName ?? ''}#${holder?.id ?? ''}.${holder?.className ?? ''}`,
      };
    },
    null,
  );
}

test('Update now in the page (F38, milestone 2, S2 16.5)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'available: the dialog offers Update now, the keyboard on Close; blocked: no Update now; a refusal is drawn in the dialog',
    async (t) => {
      const w = await world(t, chromium);
      const [page] = w.pages;
      assert.ok(page !== undefined);
      w.tell(state());
      await openDialog(w, page, state(), 1);
      const open = await dialogOf(page);
      assert.deepEqual(open.buttons, ['Update now', 'Close']);
      // The title bar's order: the notice before `Switch…` and the gear.
      assert.deepEqual(
        await readPage(
          page,
          () => [...document.querySelectorAll('.titlebar button')].map((button) => button.id),
          null,
        ),
        ['notify-on', 'update-button', 'switch-button', 'settings-button'],
      );
      assert.equal(open.focus, 'update-close', 'the keyboard starts on Close');
      await page.keyboard.press('Escape');
      await liftedOn(page);

      const blocked = state({
        check: {
          state: 'available',
          summary: '1 new commit on origin/main',
          to: TO,
          lines: LINES,
          blocked:
            'this checkout has changes that are not committed (1 file, the first: a.txt); commit or undo them first',
        },
      });
      await openDialog(w, page, blocked, 2);
      assert.deepEqual((await dialogOf(page)).buttons, ['Close']);
      await page.keyboard.press('Escape');
      await liftedOn(page);

      await openDialog(w, page, state(), 3);
      await page.locator('#update-dialog .update-now').click();
      const apply = await w.act('update-apply');
      assert.deepEqual(
        { kind: apply.act['kind'], to: apply.act['to'] },
        { kind: 'update-apply', to: TO },
      );
      w.answer(apply, {
        ok: false,
        error: 'a check for updates is running; try again once it has ended',
        update: state(),
      });
      await until(
        async () =>
          (await dialogOf(page)).lines.at(-1) ===
          'a check for updates is running; try again once it has ended',
        'the refusal in the dialog',
      );
      assert.equal((await dialogOf(page)).shown, true);
    },
  );

  await t.test(
    'Update now sends exactly `to`; told `applying`, both pages show the running form, inert, and neither can act; the stand-in gone: the bar names the log before skydeck window, nothing inert; back as another build with `updated to`: one reload, the bar; × dismisses it on both',
    async (t) => {
      const w = await world(t, chromium);
      const [first, second] = w.pages;
      assert.ok(first !== undefined && second !== undefined);
      let loads = 0;
      first.on('load', () => loads++);
      w.tell(state());
      await openDialog(w, first, state(), 1);
      await first.locator('#update-dialog .update-now').click();
      const apply = await w.act('update-apply');
      assert.equal(apply.act['to'], TO);
      w.answer(apply, { ok: true, update: APPLYING });
      w.tell(APPLYING);
      for (const page of w.pages) await runningOn(page);
      // Neither page can act: no button; a window chord says so; Esc does not close the form.
      await second.keyboard.press('Control+Shift+N');
      await showsText(second, '#key-message', /^skydeck is being updated$/);
      await first.keyboard.press('Escape');
      await runningOn(first);
      assert.equal((await w.act('update-apply', 1)).act['to'], TO);
      assert.equal(
        w.seen.flatMap((s) => s.acts).filter((a) => a['kind'] === 'update-apply').length,
        1,
        'no second update-apply',
      );

      const { port } = w.standin;
      await w.standin.close();
      for (const page of w.pages) {
        await showsText(page, '#gone-text', AWAY);
        await liftedOn(page);
        await connection(page, 'lost');
      }
      assert.deepEqual(
        await readPage(
          first,
          () => [...document.querySelectorAll('#gone-text code')].map((c) => c.textContent),
          null,
        ),
        [LOG, 'skydeck window'],
      );

      // Back: the same port, other files (another build), the result for every page.
      const loadsBefore = loads;
      const result = state({ check: null, result: { ok: true, text: 'updated to 5d6e7f8' } });
      const back: Seen[] = [];
      await standinServer(t, {
        port,
        web: { 'another-build.txt': 'the new commit\n' },
        socket: socketOf(w.secret, back, { first: result }),
      });
      for (const page of w.pages) {
        await connection(page, 'open');
        await showsText(page, '#update-result-text', /^updated to 5d6e7f8$/);
        await liftedOn(page);
      }
      assert.equal(loads - loadsBefore, 1, 'the page reloaded once');

      await first.locator('#update-result-close').click();
      const seenAct = back
        .flatMap((s) => s.acts.map((act) => ({ seen: s, act })))
        .find((a) => a.act['kind'] === 'update-seen');
      await until(
        () => back.some((s) => s.acts.some((a) => a['kind'] === 'update-seen')),
        'act update-seen',
      );
      const dismissed = state({ check: null });
      const sent =
        seenAct ??
        back
          .flatMap((s) => s.acts.map((act) => ({ seen: s, act })))
          .find((a) => a.act['kind'] === 'update-seen');
      assert.ok(sent !== undefined);
      sent.seen.conn.send({
        t: 'result',
        id: sent.act['id'],
        ok: true,
        lines: [],
        error: null,
        sessionId: null,
        update: dismissed,
      });
      for (const { conn } of back) conn.send({ t: 'update', update: dismissed });
      for (const page of w.pages) {
        await until(
          async () =>
            (await readPage(page, () => document.getElementById('update-result')?.hidden, null)) ===
            true,
          'the result bar gone',
        );
      }
    },
  );

  await t.test(
    'the group Updates is shown from the start: its line and `Check now` while the screen still reads the settings',
    async (t) => {
      const w = await world(t, chromium);
      const [page] = w.pages;
      assert.ok(page !== undefined);
      w.tell(state());
      await page.locator('#settings-button').click();
      // The stand-in never answers `act settings`: the screen stays at its reading line.
      await w.act('settings');
      await showsText(page, '#settings .settings-status', /^Reading the settings…$/);
      const seen = await readPage(
        page,
        () => ({
          group: (
            document.querySelector('#settings [data-group="updates"]') as HTMLElement | null
          )?.checkVisibility(),
          lines: [...document.querySelectorAll('#settings .settings-updates-line')]
            .filter((line) => (line as HTMLElement).checkVisibility())
            .map((line) => line.textContent),
          checkNow: (
            document.querySelector('#settings .settings-check-now') as HTMLElement | null
          )?.checkVisibility(),
        }),
        null,
      );
      assert.deepEqual(
        { group: seen.group, checkNow: seen.checkNow },
        { group: true, checkNow: true },
      );
      assert.equal(seen.lines.length, 1, JSON.stringify(seen.lines));
      assert.match(seen.lines[0] ?? '', /^Last check: .* — 1 new commit on origin\/main$/);
    },
  );

  await t.test(
    'refused before the stop: told `applying`, then `applying` null with a failed result while connected — the form lifted on both pages, not inert, the bar gives the line',
    async (t) => {
      const w = await world(t, chromium);
      const [first] = w.pages;
      assert.ok(first !== undefined);
      w.tell(state());
      await openDialog(w, first, state(), 1);
      w.tell(APPLYING);
      for (const page of w.pages) await runningOn(page);
      const line =
        "this checkout's git index is locked (/x/.git/index.lock): another git command runs in it, or one was cut off and left the file; nothing was changed";
      w.tell(state({ result: { ok: false, text: line } }));
      for (const page of w.pages) {
        await liftedOn(page);
        await showsText(page, '#update-result-text', new RegExp(`^${escape(line)}$`));
        await connection(page, 'open');
      }
    },
  );

  await t.test(
    'Settings open on the second page when `applying` comes: it closes; no Tab, click or Esc reaches anything under the running form, and nothing is sent',
    async (t) => {
      const w = await world(t, chromium);
      const [, second] = w.pages;
      assert.ok(second !== undefined);
      w.tell(state());
      await second.locator('#settings-button').click();
      await until(
        async () =>
          (await readPage(second, () => document.getElementById('settings')?.hidden, null)) ===
          false,
        'the settings screen is shown',
      );
      const box = await second.locator('#settings .settings-check-now').boundingBox();
      assert.ok(box !== null);
      w.tell(APPLYING);
      await runningOn(second);
      assert.equal(
        await readPage(second, () => document.getElementById('settings')?.hidden, null),
        true,
        'the settings screen closed first',
      );
      const sent = (): unknown[] => w.seen.flatMap((s) => s.acts).map((a) => a['kind']);
      const before = sent();
      for (let i = 0; i < 6; i++) {
        await second.keyboard.press('Tab');
        assert.equal(
          await readPage(
            second,
            () =>
              document.getElementById('update-dialog')?.contains(document.activeElement) === true,
            null,
          ),
          true,
          'Tab stays in the running form',
        );
      }
      await second.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await second.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runningOn(second);
      assert.deepEqual(sent(), before, 'nothing was sent');
    },
  );

  for (const which of [
    'the editor',
    'the editor with a save in flight',
    '"Mark done"',
    'the switcher',
  ] as const) {
    await t.test(
      `${which} open on the second page when \`applying\` comes: it closes; no key or click reaches anything under the running form, nothing is sent; lifted, the page is usable`,
      async (t) => {
        const w = await rowWorld(t, chromium);
        const [, second] = w.pages;
        assert.ok(second !== undefined);
        const kinds = (): unknown[] => w.seen.flatMap((s) => s.acts).map((a) => a['kind']);
        // The first row is selected by itself; the list takes the keyboard.
        await until(
          async () =>
            (await readPage(
              second,
              (id) =>
                document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') ===
                id,
              SID,
            )) === true,
          'the session selected',
        );
        await second.keyboard.press('Control+Shift+L');
        await until(
          async () => (await pageFacts(second)).focus.includes('#list'),
          'the list has the keyboard',
        );
        const start = await pageFacts(second);
        const id =
          which === '"Mark done"' ? 'end' : which === 'the switcher' ? 'switcher' : 'editor';
        if (id === 'editor') {
          await second.keyboard.press('l');
        } else if (id === 'end') {
          await second.keyboard.press('d');
        } else {
          await second.keyboard.press('Control+Shift+P');
        }
        await until(async () => (await pageFacts(second)).hidden[id] === false, `${which} shown`);
        if (id === 'editor') await second.keyboard.type('half typed');
        if (id === 'switcher') await second.keyboard.type('al');
        if (which === 'the editor with a save in flight') {
          await second.keyboard.press('Enter');
          await until(() => kinds().includes('label'), 'the label sent');
        }
        const before = kinds();
        w.tell(APPLYING);
        await runningOn(second);
        const during = await pageFacts(second);
        assert.deepEqual(
          during.hidden,
          { editor: true, end: true, settings: true, switcher: true },
          'every other dialog closed under the running form',
        );
        for (const key of ['Tab', 'Tab', 'Enter', 'Escape', 'x', 'd', 'Space']) {
          await second.keyboard.press(key);
        }
        await second.mouse.click(300, 300);
        await second.mouse.click(60, 120);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = await pageFacts(second);
        assert.equal(after.inUpdate, true, 'the keyboard stays in the running form');
        assert.equal(after.inert, true);
        assert.deepEqual(kinds().slice(before.length), [], 'nothing sent while the form is shown');
        w.tell(state({ result: { ok: false, text: 'refused' } }));
        await liftedOn(second);
        await until(
          async () => (await pageFacts(second)).focus === start.focus,
          'the keyboard back where it was',
        );
      },
    );
  }

  await t.test(
    'a ticket address half typed in Settings when `applying` comes: closing it for the running form sends no setting-set; the next opening shows the file’s value',
    async (t) => {
      const w = await rowWorld(t, chromium);
      const [, second] = w.pages;
      assert.ok(second !== undefined);
      const kinds = (): unknown[] => w.seen.flatMap((s) => s.acts).map((a) => a['kind']);
      const field = '#settings .short-setting[data-key="ticketUrl"] input';
      const shownValue = (): Promise<string | null> =>
        readPage(
          second,
          (selector) => {
            const input = document.querySelector<HTMLInputElement>(selector);
            return input !== null && input.checkVisibility() ? input.value : null;
          },
          field,
        );
      await second.locator('#settings-button').click();
      await until(async () => (await shownValue()) === TICKET, 'the ticket address shown');
      await second.locator(field).click();
      await second.keyboard.press('Control+A');
      await second.keyboard.type('https://half.example.com/{key}');
      const before = kinds();

      w.tell(APPLYING);
      await runningOn(second);
      await new Promise((resolve) => setTimeout(resolve, 300));

      assert.equal(
        await readPage(second, () => document.getElementById('settings')?.hidden, null),
        true,
      );
      assert.deepEqual(kinds().slice(before.length), [], 'no setting-set, nothing sent');
      w.tell(state({ result: { ok: false, text: 'refused' } }));
      await liftedOn(second);
      await second.locator('#settings-button').click();
      await until(async () => (await shownValue()) === TICKET, 'the file’s value again');
      assert.ok(!kinds().includes('setting-set'));
    },
  );

  await t.test(
    'back with the same build and a failed result: no reload, the bar gives the reason, no running form',
    async (t) => {
      const w = await world(t, chromium);
      const [first] = w.pages;
      assert.ok(first !== undefined);
      let loads = 0;
      first.on('load', () => loads++);
      const { port } = w.standin;
      await appliedAndGone(w);
      await showsText(first, '#gone-text', AWAY);
      const why = 'the update could not be applied: error: a refusal; the checkout is as it was';
      await standinServer(t, {
        port,
        socket: socketOf(w.secret, [], {
          first: state({ result: { ok: false, text: why } }),
        }),
      });
      await connection(first, 'open');
      await showsText(first, '#update-result-text', new RegExp(`^${escape(why)}$`));
      await liftedOn(first);
      assert.equal(loads, 0, 'no reload: the same build');
    },
  );

  await t.test(
    'an update to a new build on a page whose key could not be stored: fatal with its line, the running form gone, not inert, its controls take a click',
    async (t) => {
      const secret = new Uint8Array(32).fill(92);
      const token = new Uint8Array(32).fill(93);
      const page = await newPage(t, chromium);
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'indexedDB', {
          get() {
            throw new DOMException('no IndexedDB here', 'SecurityError');
          },
        });
      });
      const seen: Seen[] = [];
      const standin = await standinServer(t, {
        socket: (conn) => {
          honest(secret, {
            token,
            open: (c, message) => {
              if (!seen.some((s) => s.conn === c)) seen.push({ conn: c, acts: [] });
              if (message['t'] === 'view') c.send(scriptedList([], []));
            },
          })(conn);
        },
      });
      await page.goto(pageUrl(standin.port, Buffer.from(token).toString('base64url')));
      await connection(page, 'open');
      await until(() => seen.length > 0, 'the page connected');
      for (const { conn } of seen) conn.send({ t: 'update', update: APPLYING });
      await runningOn(page);
      const { port } = standin;
      await standin.close();
      await showsText(page, '#gone-text', AWAY);

      await standinServer(t, {
        port,
        web: { 'another-build.txt': 'the new commit\n' },
        socket: honest(secret, {}),
      });
      await showsText(page, '#problem', new RegExp(`^${escape(STALE_UNSTORED)}$`));
      await connection(page, 'fatal');
      await liftedOn(page);
      await page.locator('#switch-button').click();
      await until(
        async () =>
          (await readPage(page, () => document.getElementById('switcher')?.hidden, null)) === false,
        'the switcher opens on a click',
      );
    },
  );

  await t.test(
    'a return that closes with 4003 (the key not valid): fatal, the running form gone, not inert, its controls take a click',
    async (t) => {
      const w = await world(t, chromium);
      const [first] = w.pages;
      assert.ok(first !== undefined);
      const { port } = w.standin;
      await appliedAndGone(w);
      await showsText(first, '#gone-text', AWAY);
      // Another secret: the page's proof fails, and the stand-in closes with 4003.
      await standinServer(t, { port, socket: honest(new Uint8Array(32).fill(94), {}) });
      await showsText(first, '#problem', new RegExp(`^${escape(NOT_VALID)}$`));
      await connection(first, 'fatal');
      await liftedOn(first);
      await first.locator('#switch-button').click();
      await until(
        async () =>
          (await readPage(first, () => document.getElementById('switcher')?.hidden, null)) ===
          false,
        'the switcher opens on a click',
      );
    },
  );
});
