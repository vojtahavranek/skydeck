// The update notice in the page (follow-up F38, issue #163; S2 16.5, 12.1, 12.13): Check now in
// the settings screen's group Updates; the title bar's `Update available` on every page
// exactly while a newer skydeck is known, also through a check whose fetch failed; the dialog it
// opens, which shows the notes of what is new the update brings, the fold of its other changes,
// the database note and, small at the bottom, the commits and the command; or why the checkout
// cannot be updated as it is, or why skydeck cannot tell; its keyboard round, its scroll with the
// heading and the buttons in view, and its colours in both schemes. On a real test server whose
// checker looks at a throwaway checkout inside the sandbox (updateSeam), its only remote a bare
// repository beside it; the check by the clock off, so that only Check now fetches. Never a real home or the
// network.
import assert from 'node:assert/strict';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import type { Platform } from '../src/platform/types.ts';
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

/** WCAG 2's contrast ratio of two colours as getComputedStyle gives them (`rgb(r, g, b)`). */
function contrast(a: string, b: string): number {
  const luminance = (css: string): number => {
    const found = /^rgba?\(([0-9]+), ([0-9]+), ([0-9]+)(?:, 1)?\)$/.exec(css);
    assert.ok(found !== null, `${css} is an opaque rgb() colour`);
    const [r, g, bl] = found.slice(1, 4).map((part) => {
      const c = Number(part) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
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
      // Its first commit carries the version tag v0.9.0: HEAD is 0.9.0, each commit past it +1.
      const c = gitCheckout(d.s);
      c.git(c.root, 'tag', 'v0.9.0');
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

/** Every line of the settings screen's group Updates. */
function allBlockLines(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#settings .settings-updates-line')].map(
        (line) => line.textContent ?? '',
      ),
    null,
  );
}

/** The lines of the group Updates about the checks: those after its first, the version, once shown. */
async function blockLines(page: Page): Promise<string[]> {
  const lines = await allBlockLines(page);
  return /^skydeck /.test(lines[0] ?? '') ? lines.slice(1) : lines;
}

/**
 * The dialog's body as it shows: each note's title and each of its paragraphs, each line, the fold
 * line and each item under it while open, the database note's text and the small lines at the
 * bottom, in order; what is hidden left out.
 */
function dialogLines(page: Page): Promise<string[]> {
  return readPage(
    page,
    () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '#update-dialog :is(.update-note-title, .update-note-text, .update-line, .update-fold, .update-other, .update-database-text, .update-meta)',
        ),
      ]
        .filter((line) => line.offsetParent !== null)
        .map((line) => line.textContent ?? ''),
    null,
  );
}

/** The visible buttons under the dialog's body, by their words. */
function dialogButtons(page: Page): Promise<string> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll<HTMLButtonElement>('#update-dialog .update-actions button')]
        .filter((b) => !b.hidden)
        .map((b) => b.textContent)
        .join('|'),
    null,
  );
}

/** The class of what has the keyboard. */
function holder(page: Page): Promise<string> {
  return readPage(page, () => document.activeElement?.className ?? '', null);
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

/** The version of `rev` in the world's checkout: 0.9.0, and `+n` n commits past the first. */
function versionAt(w: World, rev: string): string {
  const first = w.c.git(w.c.root, 'rev-list', '--max-parents=0', 'HEAD').trim();
  const n = w.c.git(w.c.root, 'rev-list', '--first-parent', '--count', `${first}..${rev}`).trim();
  return n === '0' ? '0.9.0' : `0.9.0+${n}`;
}

/**
 * The bottom lines for the checkout's HEAD and its upstream now: their versions on the upstream,
 * then the two ids.
 */
function bottom(w: World, blocked = false): string[] {
  const range = `${versionAt(w, 'HEAD')} → ${versionAt(w, 'origin/main')} on origin/main (${w.c.id().slice(0, 7)} → ${w.c.id('origin/main').slice(0, 7)})`;
  return blocked ? [range] : [range, 'In a terminal instead: skydeck update'];
}

const DATABASE =
  'This update may upgrade the database. A copy is kept first; an older skydeck cannot open it afterwards. Going back to ';
const SET_RIGHT = 'Once that is set right, in a WSL terminal of your own: skydeck update';

test('the update notice (F38, S2 16.5)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'Check now: up to date shows no control; a pushed commit shows it on two pages, with its age; a remote that is gone keeps it, and the block says why',
    async (t) => {
      const w = await world(t, chromium);
      await openSettings(w.l.page);
      assert.deepEqual(await blockLines(w.l.page), ['No check was made yet.']);
      // Above the lines of the checks, the version of the server's checkout.
      await until(
        async () => (await allBlockLines(w.l.page))[0] === 'skydeck 0.9.0',
        'the group Updates names the version',
      );
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
    'the dialog: no note, the changes open under their count, the database note, the bottom lines; text as text; Esc gives the keyboard back; a window chord says to close it first',
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
      assert.deepEqual(lines, [
        '▾ 2 changes',
        'changes the upgrade steps',
        '<b>bold</b> & <img src=x onerror="window.hit=1">',
        `${DATABASE}${w.c.id().slice(0, 7)}: docs/install.md, "Going back".`,
        ...bottom(w),
      ]);
      assert.equal(
        await readPage(
          w.l.page,
          () => document.querySelector('#update-dialog b, #update-dialog img') === null,
          null,
        ),
        true,
      );
      assert.equal(await readPage(w.l.page, () => 'hit' in window, null), false);
      assert.equal(await holder(w.l.page), 'update-close', 'the keyboard starts on Close');
      assert.equal(await dialogButtons(w.l.page), 'Update now|Close', 'Update now before Close');
      await w.l.page.keyboard.press('Control+Shift+N');
      await showsText(w.l.page, '#key-message', /^close the dialog first \(Esc\)$/);
      await closeDialog(w.l.page);
      assert.equal(await active(w.l.page), before, 'the keyboard back where it was');
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'the notes: newest first, the title heavier, code runs and ids in the terminal font; every commit a note: no fold line; with other changes the fold, folded at every open, opened and closed by Enter, Space and a click; Tab goes round it',
    async (t) => {
      const w = await world(t, chromium);
      w.c.push('adds the first note', {
        'docs/news/2026-11-01-first.md': '# The first `note`\n\nRun `skydeck doctor`\nonce.\n',
      });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 1 new commit on origin\/main$/);
      await closeSettings(w.l.page);

      assert.deepEqual(await openDialog(w.l.page), [
        'The first note',
        'Run skydeck doctor once.',
        ...bottom(w),
      ]);
      assert.deepEqual(
        await readPage(
          w.l.page,
          () =>
            [...document.querySelectorAll('#update-dialog code')].map((c) => ({
              text: c.textContent,
              font: getComputedStyle(c).fontFamily,
            })),
          null,
        ),
        [
          'note',
          'skydeck doctor',
          w.c.id().slice(0, 7),
          w.c.id('origin/main').slice(0, 7),
          'skydeck update',
        ].map((text) => ({ text, font: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' })),
        "code runs, ids and the command in the terminal's font",
      );
      const style = await readPage(
        w.l.page,
        () => {
          const of = (selector: string): CSSStyleDeclaration =>
            getComputedStyle(document.querySelector(selector) as Element);
          return {
            title: of('#update-dialog .update-note-title').fontWeight,
            text: of('#update-dialog .update-note-text').fontWeight,
            body: of('#update-dialog .update-body').fontFamily,
            page: getComputedStyle(document.body).fontFamily,
          };
        },
        null,
      );
      assert.deepEqual(
        { title: style.title, text: style.text, body: style.body },
        { title: '600', text: '400', body: style.page },
        "the window's font, the title heavier",
      );
      for (const key of ['Tab', 'Tab', 'Shift+Tab'] as const) {
        await w.l.page.keyboard.press(key);
      }
      assert.equal(await holder(w.l.page), 'edit-save update-now', 'no fold line in the round');
      await closeDialog(w.l.page);

      w.c.push('a plain change', { 'a.txt': 'a\n' });
      w.c.push('changes the upgrade steps', { 'src/store/migrations.ts': 'export {};\n' });
      w.c.push('adds the second note', {
        'docs/news/2026-11-02-second.md':
          '# The second\n\nIt is newer.\n\nIt has two paragraphs.\n',
      });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 4 new commits on origin\/main$/);
      await closeSettings(w.l.page);
      const folded = [
        'The second',
        'It is newer.',
        'It has two paragraphs.',
        'The first note',
        'Run skydeck doctor once.',
        '▸ 2 other changes',
        `${DATABASE}${w.c.id().slice(0, 7)}: docs/install.md, "Going back".`,
        ...bottom(w),
      ];
      const opened = [
        ...folded.slice(0, 5),
        '▾ 2 other changes',
        'changes the upgrade steps',
        'a plain change',
        ...folded.slice(6),
      ];
      assert.deepEqual(await openDialog(w.l.page), folded);
      const expanded = (): Promise<string | null> =>
        readPage(
          w.l.page,
          () =>
            document.querySelector('#update-dialog .update-fold')?.getAttribute('aria-expanded') ??
            null,
          null,
        );
      assert.equal(await expanded(), 'false');
      assert.equal(await holder(w.l.page), 'update-close');
      for (const [key, on] of [
        ['Tab', 'update-fold'],
        ['Tab', 'edit-save update-now'],
        ['Tab', 'update-close'],
        ['Shift+Tab', 'edit-save update-now'],
        ['Shift+Tab', 'update-fold'],
        ['Shift+Tab', 'update-close'],
        ['Tab', 'update-fold'],
      ] as const) {
        await w.l.page.keyboard.press(key);
        assert.equal(await holder(w.l.page), on, `${key} goes to ${on}`);
      }
      await w.l.page.keyboard.press('Enter');
      await until(async () => (await expanded()) === 'true', 'Enter opens the fold');
      assert.deepEqual(await dialogLines(w.l.page), opened);
      await w.l.page.keyboard.press('Space');
      await until(async () => (await expanded()) === 'false', 'Space closes it');
      assert.deepEqual(await dialogLines(w.l.page), folded);
      assert.equal(await holder(w.l.page), 'update-fold', 'the keyboard stays on the fold line');
      await w.l.page.locator('#update-dialog .update-fold').click();
      await until(async () => (await expanded()) === 'true', 'a click opens it');
      await closeDialog(w.l.page);
      assert.deepEqual(await openDialog(w.l.page), folded, 'folded again at the next open');
      await closeDialog(w.l.page);
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'markup in a note — its title, its text, a code run: drawn as text, no element made, nothing run',
    async (t) => {
      const w = await world(t, chromium);
      w.c.push('a note with markup', {
        'docs/news/2026-11-03-markup.md':
          '# <img src=x onerror="window.hit=1"> <script>window.hit=2</script> `<b>code</b>`\n\n' +
          'A <img src=y onerror="window.hit=3"> text <script>window.hit=4</script> and ' +
          '`<img src=z onerror="window.hit=5">` <a href="http://x">link</a>.\n',
      });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 1 new commit on origin\/main$/);
      await closeSettings(w.l.page);

      const lines = await openDialog(w.l.page);
      assert.deepEqual(lines.slice(0, 2), [
        '<img src=x onerror="window.hit=1"> <script>window.hit=2</script> <b>code</b>',
        'A <img src=y onerror="window.hit=3"> text <script>window.hit=4</script> and <img src=z onerror="window.hit=5"> <a href="http://x">link</a>.',
      ]);
      const made = await readPage(
        w.l.page,
        () => {
          const body = document.querySelector('#update-dialog .update-body') as Element;
          return {
            tags: [
              ...new Set([...body.querySelectorAll('*')].map((e) => e.tagName.toLowerCase())),
            ].sort(),
            codes: [...body.querySelectorAll('.update-note code')].map((c) => c.textContent),
            hit: 'hit' in window,
          };
        },
        null,
      );
      assert.deepEqual(
        made.tags.filter(
          (tag) => !['button', 'code', 'div', 'li', 'p', 'span', 'ul'].includes(tag),
        ),
        [],
        `only the dialog's own elements: ${made.tags.join(' ')}`,
      );
      assert.deepEqual(made.codes, ['<b>code</b>', '<img src=z onerror="window.hit=5">']);
      assert.equal(made.hit, false, 'nothing ran');
      await closeDialog(w.l.page);
      assert.deepEqual(w.l.problems, []);
    },
  );

  await t.test(
    'a dialog longer than the window: 20 notes and `… and 1 more`, its body scrolls inside it, the heading and the buttons stay in view; both colour schemes read at least 4.5 : 1',
    async (t) => {
      const w = await world(t, chromium);
      const files: Record<string, string> = {};
      for (let i = 1; i <= 21; i += 1) {
        const day = String(i).padStart(2, '0');
        files[`docs/news/2026-10-${day}-note-${i}.md`] =
          `# Note ${i}\n\n${'A sentence that says what changed. '.repeat(16).trim()}\n`;
      }
      w.c.push('adds 21 notes', files);
      w.c.push('changes the upgrade steps', { 'src/store/migrations.ts': 'export {};\n' });
      await openSettings(w.l.page);
      await checkNow(w.l.page, /^Last check: [01]s ago — 2 new commits on origin\/main$/);
      await closeSettings(w.l.page);
      await w.l.page.setViewportSize({ width: 900, height: 560 });

      const lines = await openDialog(w.l.page);
      const titles = lines.filter((line) => /^Note [0-9]+$/.test(line));
      assert.equal(titles.length, 20);
      assert.equal(titles[0], 'Note 21');
      assert.equal(titles[19], 'Note 2');
      assert.ok(lines.includes('… and 1 more'));
      assert.ok(lines.includes('▸ 1 other change'));

      /** Where the body is scrolled, whether its last line lies inside its box, the heading and the buttons in view. */
      const where = (): Promise<{
        top: number;
        scrolls: boolean;
        lastInside: boolean;
        heading: boolean;
        buttons: boolean;
      }> =>
        readPage(
          w.l.page,
          () => {
            const body = document.querySelector('#update-dialog .update-body') as HTMLElement;
            const box = body.getBoundingClientRect();
            const metas = body.querySelectorAll('.update-meta');
            const last = (metas[metas.length - 1] as Element).getBoundingClientRect();
            const inside = (selector: string): boolean => {
              const r = (document.querySelector(selector) as Element).getBoundingClientRect();
              return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
            };
            return {
              top: body.scrollTop,
              scrolls: body.scrollHeight > body.clientHeight,
              lastInside: last.top >= box.top && last.bottom <= box.bottom + 0.5,
              heading: inside('#update-dialog .update-heading'),
              buttons:
                inside('#update-dialog .update-now') && inside('#update-dialog .update-close'),
            };
          },
          null,
        );
      const start = await where();
      assert.deepEqual(start, {
        top: 0,
        scrolls: true,
        lastInside: false,
        heading: true,
        buttons: true,
      });
      // From the keyboard, Close keeping it: End, Home, PageDown, ↓, ↑.
      assert.equal(await holder(w.l.page), 'update-close');
      await w.l.page.keyboard.press('End');
      const end = await where();
      assert.ok(end.top > 0, `End scrolls (${end.top})`);
      assert.equal(end.lastInside, true, 'End brings the last line inside the body');
      assert.equal(end.heading && end.buttons, true);
      await w.l.page.keyboard.press('Home');
      assert.equal((await where()).top, 0, 'Home goes back to the top');
      await w.l.page.keyboard.press('PageDown');
      const page = (await where()).top;
      assert.ok(page > 100, `PageDown scrolls a page (${page})`);
      await w.l.page.keyboard.press('ArrowDown');
      assert.equal((await where()).top, page + 40, '↓ a line further');
      await w.l.page.keyboard.press('ArrowUp');
      assert.equal((await where()).top, page);
      await w.l.page.keyboard.press('PageUp');
      assert.equal((await where()).top, 0);
      assert.equal(await holder(w.l.page), 'update-close', 'the keyboard stayed on Close');
      assert.equal(
        await readPage(w.l.page, () => document.getElementById('update-dialog')?.hidden, null),
        false,
        'no key closed the dialog',
      );
      // By the wheel's way: the body's own scroll.
      await w.l.page.locator('#update-dialog .update-body').hover();
      await w.l.page.mouse.wheel(0, 100_000);
      await until(async () => (await where()).lastInside, 'the wheel brings the last line in');
      const wheeled = await where();
      assert.ok(wheeled.top > 0 && wheeled.heading && wheeled.buttons);
      assert.equal((await dialogLines(w.l.page)).at(-1), 'In a terminal instead: skydeck update');

      for (const colorScheme of ['light', 'dark'] as const) {
        await w.l.page.emulateMedia({ colorScheme });
        const pairs = await readPage(
          w.l.page,
          () => {
            const colour = (selector: string, property: 'color' | 'backgroundColor'): string =>
              getComputedStyle(document.querySelector(selector) as Element)[property];
            const dialog = colour('#update-dialog .update-dialog', 'backgroundColor');
            const marked = colour('#update-dialog .update-database', 'backgroundColor');
            return [
              ['.update-note-title', dialog],
              ['.update-note-text', dialog],
              ['.update-line', dialog],
              ['.update-fold', dialog],
              ['.update-meta', dialog],
              ['.update-database-text', marked],
            ].map(([selector, ground]) => ({
              selector,
              text: colour(`#update-dialog ${selector ?? ''}`, 'color'),
              ground: ground ?? '',
            }));
          },
          null,
        );
        for (const { selector, text, ground } of pairs) {
          const ratio = contrast(text, ground);
          assert.ok(
            ratio >= 4.5,
            `${colorScheme} ${selector}: ${text} on ${ground}, ${ratio.toFixed(2)} : 1`,
          );
        }
        if (colorScheme === 'dark') {
          assert.notEqual(pairs[0]?.ground, 'rgb(255, 255, 255)', 'the dark scheme is drawn');
        }
      }
      await closeDialog(w.l.page);
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
      assert.deepEqual(changed, [
        '▾ 1 change',
        'a commit to bring',
        'This checkout cannot be updated as it is: this checkout has changes that are not committed (1 file, the first: README.md); commit or undo them first',
        SET_RIGHT,
        ...bottom(w, true),
      ]);
      await closeDialog(w.l.page);

      w.c.git(w.c.root, 'checkout', '--', 'README.md');
      w.c.commit(w.c.root, 'a local commit', { 'local.txt': 'l\n' });
      const diverged = await openDialog(w.l.page);
      assert.deepEqual(diverged.slice(-3), [
        'This checkout cannot be updated as it is: this checkout has 1 commit that origin/main does not have; update it with git yourself',
        SET_RIGHT,
        ...bottom(w, true),
      ]);
      assert.equal(await dialogButtons(w.l.page), 'Close', 'Close alone: no Update now');
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
        /^skydeck is up to date \(main at 0\.9\.0\+[0-9]+, [0-9a-f]{7}, as origin\/main\)$/,
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
    "opened from the keyboard on its own control: the page inert, Tab goes round Update now and Close, the key help refused, another window's check drawn again; Esc gives the keyboard back to the control",
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
      assert.deepEqual(lines.slice(0, 2), ['▾ 1 change', 'the first commit to bring']);
      const inert = (): Promise<boolean> =>
        readPage(w.l.page, () => (document.querySelector('.app') as HTMLElement).inert, null);
      assert.equal(await inert(), true, 'the page under the dialog is inert');
      // The fold line, Update now (milestone 2) and Close: Tab and Shift+Tab go round the three.
      assert.equal(await holder(w.l.page), 'update-close', 'the keyboard starts on Close');
      for (const [key, on] of [
        ['Shift+Tab', 'edit-save update-now'],
        ['Tab', 'update-close'],
        ['Tab', 'update-fold'],
        ['Tab', 'edit-save update-now'],
        ['Tab', 'update-close'],
      ] as const) {
        await w.l.page.keyboard.press(key);
        assert.equal(await holder(w.l.page), on, `${key} goes to ${on}`);
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
        async () => (await dialogLines(w.l.page))[0] === '▾ 2 changes',
        'the open dialog is drawn again',
      );

      await closeDialog(w.l.page);
      assert.equal(await inert(), false);
      assert.equal(await active(w.l.page), '#update-button', 'the keyboard back on the control');
      assert.deepEqual(w.l.problems, []);
    },
  );
});
