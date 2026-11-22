// The update notice in the page (follow-up F38, issue #163; S2 16.5, 12.1, 12.13): Check now in
// the settings screen and its block `Updates`; the title bar's `Update available` on every page
// exactly while a newer skydeck is known, also through a check whose fetch failed; the dialog it
// opens, which lists the commits as `skydeck update --check` does and gives the command, or why the
// checkout cannot be updated as it is, or why skydeck cannot tell. On a real test server whose
// checker looks at a throwaway checkout inside the sandbox (updateSeam), its only remote a bare
// repository beside it; the switch off, so that only Check now fetches. Never a real home or the
// network.
import assert from 'node:assert/strict';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import type { Platform } from '../src/platform/types.ts';
import { gitOn } from '../src/update/git.ts';
import { lookForUpdate, report } from '../src/update/look.ts';
import { gitCheckout, gitTestEnv } from '../test/helpers/git-checkout.ts';
import type { GitCheckout } from '../test/helpers/git-checkout.ts';
import { updateSeam } from '../test/helpers/update.ts';
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

interface World {
  l: Launched;
  c: GitCheckout;
  /** A second page of the same server, connected. */
  other: Page;
  /** The sandbox's platform with git's test settings: for the test's own look at the checkout. */
  platform: Platform;
}

/** A launched page and a second one, the server's checker on a checkout of the sandbox. */
async function world(
  t: TestContext,
  chromium: Browser,
  prepare: (c: GitCheckout) => void = () => {},
): Promise<World> {
  let made: GitCheckout | null = null;
  const l = await launched(t, chromium, {
    window: { updateCheck: 'off' },
    server: (d) => {
      const c = gitCheckout(d.s);
      prepare(c);
      made = c;
      return {
        platform: (p) => ({
          ...p,
          env: { ...p.env, ...gitTestEnv(d.s), ...updateSeam(d.s, c) },
        }),
      };
    },
  });
  const c = made as GitCheckout | null;
  assert.ok(c !== null);
  const other = await l.page.context().newPage();
  await other.goto(pageUrl(l.server.port));
  await connection(other, 'open');
  const platform: Platform = {
    ...l.d.platform,
    env: { ...l.d.platform.env, ...gitTestEnv(l.d.s) },
  };
  return { l, c, other, platform };
}

/** Whether the title bar's `Update available` shows on `page`. */
function noticeShown(page: Page): Promise<boolean> {
  return readPage(page, () => document.getElementById('update-button')?.hidden === false, null);
}

async function noticeIs(page: Page, shown: boolean, what: string): Promise<void> {
  await until(async () => (await noticeShown(page)) === shown, what);
}

/** The lines of the settings screen's block `Updates`. */
function blockLines(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#settings .settings-updates-line')].map(
        (line) => line.textContent ?? '',
      ),
    null,
  );
}

/** The dialog's lines. */
function dialogLines(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#update-dialog .update-line')].map(
        (line) => line.textContent ?? '',
      ),
    null,
  );
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('#settings-button').click();
  await until(
    async () =>
      (await readPage(
        page,
        () => document.querySelector('#settings .settings-check-now') !== null,
        null,
      )) &&
      (await readPage(page, () => document.getElementById('settings')?.hidden === false, null)),
    'the settings screen is shown',
  );
}

/** Check now in the open settings screen, until the block's first line matches `pattern`. */
async function checkNow(page: Page, pattern: RegExp): Promise<string[]> {
  await page.locator('#settings .settings-check-now').click();
  let lines: string[] = [];
  await until(
    async () => {
      lines = await blockLines(page);
      return pattern.test(lines[0] ?? '') && !lines.includes('Checking…');
    },
    `the block says ${String(pattern)}`,
  );
  return lines;
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await until(
    async () =>
      (await readPage(page, () => document.getElementById('settings')?.hidden, null)) === true,
    'the settings screen closed',
  );
}

/** Opens the dialog and waits for the look's answer; its lines. */
async function openDialog(page: Page): Promise<string[]> {
  await page.locator('#update-button').click();
  let lines: string[] = [];
  await until(async () => {
    lines = await dialogLines(page);
    return lines.length > 0 && lines[0] !== 'Looking at the checkout…';
  }, 'the dialog answered');
  return lines;
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await until(
    async () =>
      (await readPage(page, () => document.getElementById('update-dialog')?.hidden, null)) === true,
    'the dialog closed',
  );
}

/** What `skydeck update --check` prints for the checkout now, without the network. */
async function checkLines(w: World): Promise<string[]> {
  const looked = await lookForUpdate(gitOn(w.platform, w.c.root), w.platform.files, {
    fetch: 'none',
    tolerant: true,
  });
  assert.equal(looked.kind, 'known');
  assert.ok(looked.kind === 'known');
  return report(looked.update);
}

const APPLY = 'To apply it, in a WSL terminal of your own: skydeck update';
const SET_RIGHT = 'Once that is set right, in a WSL terminal of your own: skydeck update';

test('the update notice (F38, S2 16.5)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'Check now: up to date shows no control; a pushed commit shows it on two pages, with its age; a remote that is gone keeps it, and the block says why',
    async (t) => {
      const w = await world(t, chromium);
      await openSettings(w.l.page);
      assert.deepEqual(await blockLines(w.l.page), ['No check was made yet.']);
      const current = await checkNow(w.l.page, /^Last check: [01]s ago — skydeck is up to date/);
      assert.equal(current.length, 1);
      assert.equal(await noticeShown(w.l.page), false);
      assert.equal(await noticeShown(w.other), false);

      w.c.push('the first new commit', { 'a.txt': 'a\n' });
      await checkNow(w.l.page, /^Last check: [01]s ago — 1 new commit on origin\/main$/);
      await noticeIs(w.l.page, true, 'the control on the first page');
      await noticeIs(w.other, true, 'the control on the second page');

      renameSync(w.c.remote, `${w.c.remote}-moved`);
      const failed = await checkNow(
        w.l.page,
        /^The last check failed [01]s ago: git fetch from origin failed: /,
      );
      assert.match(failed[1] ?? '', /^Known from [0-9]+s ago: 1 new commit on origin\/main$/);
      assert.equal(await noticeShown(w.l.page), true, 'the control stays');
      assert.equal(await noticeShown(w.other), true);
      await closeSettings(w.l.page);
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'the dialog: the commits as skydeck update --check lists them, the database line, the command; text as text; Esc gives the keyboard back; a window chord says to close it first',
    async (t) => {
      const w = await world(t, chromium);
      w.c.push('<b>bold</b> & <img src=x onerror="window.hit=1">', { 'b.txt': 'b\n' });
      w.c.push('changes the upgrade steps', { 'src/store/migrations.ts': 'export {};\n' });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 2 new commits on origin\/main$/);
      await closeSettings(w.l.page);
      await toZone(w.l.page, 'list');
      const before = await active(w.l.page);

      const lines = await openDialog(w.l.page);
      const expected = await checkLines(w);
      assert.deepEqual(lines, [...expected, APPLY]);
      assert.match(lines.at(-2) ?? '', /^this update changes the database's upgrade steps/);
      assert.ok(
        lines.some((line) => line.endsWith('<b>bold</b> & <img src=x onerror="window.hit=1">')),
      );
      assert.equal(
        await readPage(
          w.l.page,
          () => document.querySelector('#update-dialog b, #update-dialog img') === null,
          null,
        ),
        true,
      );
      assert.equal(await readPage(w.l.page, () => 'hit' in window, null), false);
      assert.equal(
        await readPage(w.l.page, () => document.activeElement?.className ?? '', null),
        'update-close',
        'the keyboard starts on Close',
      );
      assert.equal(
        await readPage(
          w.l.page,
          () =>
            [...document.querySelectorAll('#update-dialog button')]
              .map((b) => b.textContent)
              .join('|'),
          null,
        ),
        'Close',
        'no button but Close: no Update now',
      );
      await w.l.page.keyboard.press('Control+Shift+N');
      await showsText(w.l.page, '#key-message', /^close the dialog first \(Esc\)$/);
      await closeDialog(w.l.page);
      assert.equal(await active(w.l.page), before, 'the keyboard back where it was');
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'a changed tracked file and a diverged checkout: each its reason and the command once that is set right, no Update now',
    async (t) => {
      const w = await world(t, chromium);
      w.c.push('a commit to bring', { 'a.txt': 'a\n' });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 1 new commit on origin\/main$/);
      await closeSettings(w.l.page);

      writeFileSync(join(w.c.root, 'README.md'), 'changed by hand\n');
      const changed = await openDialog(w.l.page);
      assert.deepEqual(changed.slice(-2), [
        'This checkout cannot be updated as it is: this checkout has changes that are not committed (1 file, the first: README.md); commit or undo them first',
        SET_RIGHT,
      ]);
      await closeDialog(w.l.page);

      w.c.git(w.c.root, 'checkout', '--', 'README.md');
      w.c.commit(w.c.root, 'a local commit', { 'local.txt': 'l\n' });
      const diverged = await openDialog(w.l.page);
      assert.deepEqual(diverged.slice(-2), [
        'This checkout cannot be updated as it is: this checkout has 1 commit that origin/main does not have; update it with git yourself',
        SET_RIGHT,
      ]);
      assert.equal(
        await readPage(
          w.l.page,
          () => document.querySelectorAll('#update-dialog button').length,
          null,
        ),
        1,
      );
      await closeDialog(w.l.page);
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'the branch set to follow no remote while the control shows: the dialog says skydeck cannot tell, and the control goes on both pages; a merge by hand: up to date, the control goes',
    async (t) => {
      const w = await world(t, chromium);
      w.c.push('a commit to bring', { 'a.txt': 'a\n' });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 1 new commit on origin\/main$/);
      await closeSettings(w.l.page);
      await noticeIs(w.other, true, 'the control on the second page');

      w.c.git(w.c.root, 'branch', '--unset-upstream');
      const lines = await openDialog(w.l.page);
      assert.deepEqual(lines, [
        'skydeck cannot tell here whether there is an update: the branch main follows no branch of a remote; update it with git yourself',
        SET_RIGHT,
      ]);
      await closeDialog(w.l.page);
      await noticeIs(w.l.page, false, 'the control goes on the first page');
      await noticeIs(w.other, false, 'the control goes on the second page');

      // Following the remote again, and the update fetched once more: then merged by hand.
      w.c.git(w.c.root, 'branch', '--set-upstream-to=origin/main');
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 1 new commit on origin\/main$/);
      await closeSettings(w.l.page);
      await noticeIs(w.other, true, 'the control again');
      w.c.git(w.c.root, 'merge', '--ff-only', '--quiet', 'origin/main');
      const merged = await openDialog(w.l.page);
      assert.equal(merged.length, 1);
      assert.match(
        merged[0] ?? '',
        /^skydeck is up to date \(main at [0-9a-f]{7}, as origin\/main\)$/,
      );
      await closeDialog(w.l.page);
      await noticeIs(w.l.page, false, 'the control goes on the first page');
      await noticeIs(w.other, false, 'the control goes on the second page');
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'a branch that follows no remote from the start: no control; the block gives the reason after Check now',
    async (t) => {
      const w = await world(t, chromium, (c) => {
        c.git(c.root, 'branch', '--unset-upstream');
      });
      await openSettings(w.l.page);
      const lines = await checkNow(
        w.l.page,
        /^Last check: [01]s ago — the branch main follows no branch of a remote/,
      );
      assert.equal(lines.length, 1);
      assert.match(
        lines[0] ?? '',
        /^Last check: [01]s ago — the branch main follows no branch of a remote; update it with git yourself$/,
      );
      assert.equal(await noticeShown(w.l.page), false);
      assert.equal(await noticeShown(w.other), false);
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'while a check runs the block says Checking…, drawn from the update every page is told',
    async (t) => {
      const w = await world(t, chromium);
      // The sandbox's git, from now on: the fetch waits two seconds, so that the check is seen
      // running; every call is the real git's.
      const bin = join(w.l.d.s.bin, 'git');
      rmSync(bin);
      writeFileSync(
        bin,
        [
          '#!/bin/sh',
          'for a in "$@"; do [ "$a" = fetch ] && sleep 2; done',
          `exec '${w.c.gitPath}' "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      w.c.push('a commit to bring', { 'a.txt': 'a\n' });
      await openSettings(w.l.page);
      await w.l.page.locator('#settings .settings-check-now').click();
      await until(
        async () => (await blockLines(w.l.page)).includes('Checking…'),
        'the block says Checking…',
      );
      // The second page's screen, opened while the check runs, follows the same messages.
      await openSettings(w.other);
      await until(async () => {
        const lines = await blockLines(w.other);
        return /^Last check: [0-9]+s ago — 1 new commit on origin\/main$/.test(lines[0] ?? '');
      }, 'the second page follows the end of the check');
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    "opened from the keyboard on its own control: the page inert, Tab stays on Close, the key help refused, another window's check drawn again; Esc gives the keyboard back to the control",
    async (t) => {
      const w = await world(t, chromium);
      w.c.push('the first commit to bring', { 'a.txt': 'a\n' });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 1 new commit on origin\/main$/);
      await closeSettings(w.l.page);
      await noticeIs(w.l.page, true, 'the control');

      await w.l.page.locator('#update-button').focus();
      assert.equal(await active(w.l.page), '#update-button');
      await w.l.page.keyboard.press('Enter');
      let lines: string[] = [];
      await until(async () => {
        lines = await dialogLines(w.l.page);
        return lines.length > 0 && lines[0] !== 'Looking at the checkout…';
      }, 'the dialog answered');
      assert.match(lines[0] ?? '', /^1 new commit on origin\/main/);
      const inert = (): Promise<boolean> =>
        readPage(w.l.page, () => (document.querySelector('.app') as HTMLElement).inert, null);
      assert.equal(await inert(), true, 'the page under the dialog is inert');
      const holder = (): Promise<string> =>
        readPage(w.l.page, () => document.activeElement?.className ?? '', null);
      for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
        await w.l.page.keyboard.press(key);
        assert.equal(await holder(), 'update-close', `${key} stays on Close`);
      }
      await w.l.page.keyboard.press('Control+Shift+H');
      await showsText(w.l.page, '#key-message', /^close the dialog first \(Esc\)$/);
      assert.equal(
        await readPage(w.l.page, () => document.getElementById('help')?.hidden, null),
        true,
        'the key help stays hidden',
      );

      // Another window's Check now: the open dialog follows what every page is told.
      w.c.push('the second commit to bring', { 'b.txt': 'b\n' });
      await openSettings(w.other);
      await checkNow(w.other, /^Last check: [01]s ago — 2 new commits on origin\/main$/);
      await until(
        async () => /^2 new commits on origin\/main/.test((await dialogLines(w.l.page))[0] ?? ''),
        'the open dialog is drawn again',
      );

      await closeDialog(w.l.page);
      assert.equal(await inert(), false);
      assert.equal(await active(w.l.page), '#update-button', 'the keyboard back on the control');
      assert.deepEqual(w.l.problems, []);
    },
  );
});
