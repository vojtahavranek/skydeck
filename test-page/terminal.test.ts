// The terminal view in a browser (plan task 28; S2 8.2.4, 8.2.6, 9, 12.6, 15.4, 17.4): a real test
// server whose terminals run the stand-in, and the page's real modules.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { readRecords } from '../test/helpers/standin.ts';
import { browser } from './helpers/browser.ts';
import { after, launched, logOf, mark } from './helpers/shell.ts';
import { promptOf, recordsOf, resumeHere, untilScreen, until } from './helpers/terminal.ts';

/** The queries of the stand-in's `/query` (plan 2.4) that the screen side answers: all but
 *  XTVERSION, which stage A does not answer (S2 9.3). */
const ANSWERED = ['DA1', 'DA2', 'CPR', 'DECRQM 2026', 'DECRQSS m', 'OSC 10', 'OSC 11'];

test('the terminal view', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "a cell written red has the computed colour red (xterm.js's styles work under the policy); the page reports no problem",
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await resumeHere(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      await l.page.keyboard.type('/red x');
      await l.page.keyboard.press('Enter');
      await untilScreen(l.page, /^x$/m);
      const colours = await l.page.evaluate(() => {
        const box = document.querySelector('#terminal .tv-term:not([hidden])');
        const cell = [...(box?.querySelectorAll('.xterm-rows span') ?? [])].find(
          (span) => span.textContent === 'x',
        );
        const style = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        probe.style.color = style.getPropertyValue('--tv-red').trim();
        document.body.append(probe);
        const red = getComputedStyle(probe).color;
        probe.style.color = style.getPropertyValue('--term-fg').trim();
        const fg = getComputedStyle(probe).color;
        probe.remove();
        return { cell: cell === undefined ? null : getComputedStyle(cell).color, red, fg };
      });
      assert.equal(colours.cell, colours.red, 'the cell has the theme red');
      assert.notEqual(colours.red, colours.fg);
      assert.deepEqual(l.problems, []);
    },
  );

  await t.test(
    '/query: the stand-in records exactly one answer per query (the screen side’s), and the page sends nothing for any of them',
    async (t) => {
      const l = await launched(t, chromium);
      l.d.resumable(S1);
      await resumeHere(l.page, S1);
      await untilScreen(l.page, promptOf(S1));
      await l.page.keyboard.type('/query');
      await mark(l.page, 'enter');
      await l.page.keyboard.press('Enter');
      await until(
        () =>
          recordsOf(l.d.record, S1).filter((entry) => entry.ev === 'answer').length >=
          ANSWERED.length,
        'every query answered',
      );
      await sleep(2500); // the stand-in closes its queries after 2 s; a late answer would be input
      const records = recordsOf(l.d.record, S1);
      const answers = records.flatMap((entry) => (entry.ev === 'answer' ? [entry.query] : []));
      assert.deepEqual([...answers].sort(), [...ANSWERED].sort(), 'one answer for each');
      const enter = records.findIndex((entry) => entry.ev === 'input' && entry.hex === '0d');
      assert.ok(enter !== -1, 'the Enter of the command');
      assert.deepEqual(
        records.slice(enter + 1).filter((entry) => entry.ev === 'input'),
        [],
        'no input after the command: the page answered nothing',
      );
      const sent = after(await logOf(l.page), 'enter').filter(
        (entry) => entry.e === 'out' && entry.t === 'input',
      );
      assert.equal(sent.length, 1, 'the page sent only the Enter');
      assert.ok(readRecords(l.d.record).length > 0);
    },
  );
});
