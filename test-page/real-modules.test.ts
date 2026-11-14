// The page with web/'s REAL modules (ruled by the plan owner, the review of the pinned shell tests):
// the page shell's own tests run on pinned copies of the placeholders (helpers/shell.ts
// `pinModules`), so the first case keeps the real list, terminal view, cards and help under the
// shell's check that a page of a real server loads, connects and reports no problem. It relies on
// nothing a module draws, so it stays true when tasks 27–29 replace them; each of those tasks also
// asserts an empty `problems` in its own file. The others check app.js's sizes against the real
// cards' header and the real view's `fits` (Z1 of task 26, item 5), on a stand-in server.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { securityHeaders } from '../src/window/assets.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S2 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import { actsWorld, clickRow, launched, TERM_B, TERM_C, TERM_D, zone } from './helpers/shell.ts';

test('the page with the real modules of web/', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "a real server's page with web/'s own modules loads under the server's policy, connects and reports no problem",
    async (t) => {
      const l = await launched(t, chromium); // no `modules`: nothing pinned
      await sleep(1500);

      const response = await l.page.reload();
      await l.page.waitForSelector('html[data-connection="open"]', { state: 'attached' });
      await sleep(1500);

      assert.equal(
        response?.headers()['content-security-policy'],
        securityHeaders(l.server.port)['Content-Security-Policy'],
      );
      assert.deepEqual(l.problems, []);
      assert.match(await zone(l.page), /^Focus: terminal$/, 'the terminal is the default zone');
    },
  );

  await t.test(
    "with the real cards, the rows an act asks for are the rows the terminal area has once that terminal is shown: Resume here, Resume on the ended bar, and the new form after another session's header was shown (Z1, item 5)",
    async (t) => {
      const page = await newPage(t, chromium); // nothing pinned
      const w = await actsWorld(t, page);
      const resumeButton = page.locator('#cards button', { hasText: /^Resume$/ });
      /** The rows of the act of `kind` sent last, and of the `focus` sent last. */
      const rowsOf = async (kind: string): Promise<{ asked: unknown; shown: unknown }> => {
        await sleep(500);
        const act = w.acts.filter((sent) => sent['kind'] === kind).at(-1);
        return { asked: act?.['rows'], shown: w.focuses.at(-1)?.rows };
      };

      // "Resume here" on S2's resume card.
      await clickRow(page, S2);
      await page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
      await page.locator('#cards button', { hasText: 'Resume here' }).click();
      await page.waitForSelector('#right-zone[data-pane-term="' + TERM_B + '"]', {
        state: 'attached',
      });
      const fromCard = await rowsOf('resume');
      assert.equal(fromCard.asked, fromCard.shown, 'Resume here');

      // S2's terminal ends; Resume on its ended bar.
      w.end(S2);
      await resumeButton.waitFor();
      await sleep(500);
      const underBar = w.focuses.at(-1)?.rows;
      await resumeButton.click();
      await resumeButton.waitFor({ state: 'hidden' });
      const fromBar = await rowsOf('resume');
      assert.notEqual(underBar, fromBar.shown, 'the ended bar took rows (else this tests nothing)');
      assert.equal(fromBar.asked, fromBar.shown, 'Resume on the ended bar');

      // The new form, opened while S2's header is shown.
      await page.keyboard.press('Control+Shift+N');
      await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
      await page.fill('input[name="directory"]', '/home/u/project');
      await page.locator('#cards button', { hasText: 'Start' }).click();
      await page.waitForSelector('#right-zone[data-pane-term="' + TERM_C + '"]', {
        state: 'attached',
      });
      const fromForm = await rowsOf('new');
      assert.equal(fromForm.asked, fromForm.shown, 'the new form');
    },
  );

  for (const [what, width] of [
    ['a window 1280 px wide', 1280],
    [
      "a window 1295 px wide (an area of 895 px, where the fit addon's answer flipped: M4 of task 28's review)",
      1295,
    ],
  ] as const) {
    await t.test(
      `with the real view and cards, ${what}: the size an act asks for, columns and rows, is the size the terminal has once shown, and no resize follows its start — Resume here, Resume on the ended bar, the new form (Z1, item 5)`,
      async (t) => {
        const page = await newPage(t, chromium); // nothing pinned
        await page.setViewportSize({ width, height: 800 });
        const w = await actsWorld(t, page);
        /** The terminal `term` that the last act of `kind` started is shown; its sizes agree. */
        const startedAtItsSize = async (kind: string, term: string): Promise<void> => {
          await page.waitForSelector(`#right-zone[data-pane-term="${term}"]`, {
            state: 'attached',
          });
          await sleep(1500); // a resize of the view's comes at its next fit
          const act = w.acts.filter((sent) => sent['kind'] === kind).at(-1);
          const asked = { cols: act?.['cols'], rows: act?.['rows'] };
          assert.deepEqual(asked, w.focuses.at(-1), `${kind}: the size asked is the area's`);
          const attach = w.attaches.filter((sent) => sent['term'] === term).at(-1);
          assert.deepEqual(
            { cols: attach?.['cols'], rows: attach?.['rows'] },
            asked,
            `${kind}: the view proposes the size asked`,
          );
          assert.deepEqual(
            w.resizes.filter((sent) => sent['term'] === term),
            [],
            `${kind}: no resize follows the start`,
          );
        };

        await clickRow(page, S2);
        await page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
        await page.locator('#cards button', { hasText: 'Resume here' }).click();
        await startedAtItsSize('resume', TERM_B);

        w.end(S2);
        const resume = page.locator('#cards button', { hasText: /^Resume$/ });
        await resume.waitFor();
        await resume.click();
        await startedAtItsSize('resume', TERM_D);

        await page.keyboard.press('Control+Shift+N');
        await page.waitForSelector('#right-zone[data-pane="new"]', { state: 'attached' });
        await page.fill('input[name="directory"]', '/home/u/project');
        await page.locator('#cards button', { hasText: 'Start' }).click();
        await startedAtItsSize('new', TERM_C);
      },
    );
  }

  await t.test(
    "with the real view and cards, at each window height over more than one row's height: the size Resume here asks for is the size the view proposes for its terminal once shown, and no resize follows (Z1, item 5: the zone's 2 px top border is not the terminal's)",
    async (t) => {
      const rowsSeen = new Set<unknown>();
      let heights = 1; // set from the first height's cell: one more than a row's height, and one
      for (let i = 0; i < heights; i++) {
        const height = 780 + i;
        await t.test(`a window 1280 × ${height} px`, async (t) => {
          const page = await newPage(t, chromium); // nothing pinned
          await page.setViewportSize({ width: 1280, height });
          const w = await actsWorld(t, page);
          if (i === 0) {
            const cell = await page.evaluate(
              () => document.getElementById('cell-measure')?.getBoundingClientRect().height ?? 0,
            );
            assert.ok(cell > 0, 'the cell has a height');
            heights = Math.ceil(cell) + 2;
          }
          await clickRow(page, S2);
          await page.waitForSelector('#right-zone[data-pane="resume"]', { state: 'attached' });
          await page.locator('#cards button', { hasText: 'Resume here' }).click();
          await page.waitForSelector(`#right-zone[data-pane-term="${TERM_B}"]`, {
            state: 'attached',
          });
          await sleep(1500); // a resize of the view's comes at its next fit
          const act = w.acts.filter((sent) => sent['kind'] === 'resume').at(-1);
          const attach = w.attaches.filter((sent) => sent['term'] === TERM_B).at(-1);
          const asked = { cols: act?.['cols'], rows: act?.['rows'] };
          rowsSeen.add(asked.rows);
          assert.deepEqual({ cols: attach?.['cols'], rows: attach?.['rows'] }, asked, 'proposed');
          assert.deepEqual(
            w.resizes.filter((sent) => sent['term'] === TERM_B),
            [],
            'no resize follows the start',
          );
        });
      }
      assert.ok(
        rowsSeen.size >= 2,
        `the heights crossed a row (rows seen: ${[...rowsSeen].join(', ')})`,
      );
    },
  );
});
