// Follow-up F43 (S2 7.6, 12.1, 12.9): a session's number is free as soon as its program ends. Against
// a real test server with the stand-in: after `/exit` in the terminal of slot 1 its row is under
// Recent with no number, Ctrl+Shift+1 reaches no session, and the next resume takes number 1, which
// Ctrl+Shift+1 then reaches; the other terminal keeps its number.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { connectTestPage } from '../test/helpers/window.ts';
import { browser } from './helpers/browser.ts';
import { clickRow, keyMessage, launched, selectedRow, termOf, toZone } from './helpers/shell.ts';
import { resumeHere, until } from './helpers/terminal.ts';

const NAMES = new Map([
  [S1, 'S1'],
  [S2, 'S2'],
  [S3, 'S3'],
]);

/** The list as drawn: "<section> <session> <number>" for each row of S1–S3, in order. */
async function drawn(page: Page): Promise<string[]> {
  const rows = await page.evaluate(() => {
    const out: [string, string, string][] = [];
    let section = '';
    for (const element of document.querySelectorAll('#list .list-section, #list [data-id]')) {
      if (element.classList.contains('list-section')) {
        section = (element as HTMLElement).dataset['section'] ?? '';
        continue;
      }
      const slot = element.querySelector('.row-slot')?.textContent ?? '';
      out.push([section, element.getAttribute('data-id') ?? '', slot === '' ? '-' : slot]);
    }
    return out;
  });
  return rows.flatMap(([section, id, slot]) => {
    const name = NAMES.get(id);
    return name === undefined ? [] : [`${section} ${name} ${slot}`];
  });
}

test('F43: the number of a session whose program ended', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'against a real server: /exit in slot 1 → its row under Recent has no number and Ctrl+Shift+1 reaches nothing; the next resume takes 1 and Ctrl+Shift+1 reaches it',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2);
      d.resumable(S3);
      await resumeHere(page, S1);
      await resumeHere(page, S2);
      await until(async () => {
        const rows = (await drawn(page)).filter((row) => row.startsWith('open '));
        return JSON.stringify(rows) === JSON.stringify(['open S1 1', 'open S2 2']);
      }, 'S1 and S2 in slots 1 and 2');

      const p = await connectTestPage(t, d, l.server, { focused: false, view: null });
      p.send({ t: 'input', term: termOf(l, S1), data: '/exit\r' });
      await until(
        async () => (await drawn(page)).includes('week S1 -'),
        'S1 under Recent without a number',
      );
      const rest = (await drawn(page)).filter((row) => !row.startsWith('open '));
      assert.ok(
        rest.every((row) => row.endsWith(' -')),
        `no row under Recent or Earlier has a number: ${rest.join(', ')}`,
      );
      assert.deepEqual(
        (await drawn(page)).filter((row) => row.startsWith('open ')),
        ['open S2 2'],
        'the other terminal keeps its number',
      );

      await clickRow(page, S2);
      await toZone(page, 'list');
      await page.keyboard.press('Control+Shift+1');
      await until(
        async () => (await keyMessage(page)) === 'no session in slot 1',
        'Ctrl+Shift+1 reaches no session',
      );
      assert.equal(await selectedRow(page), S2, 'the selection stays');

      await resumeHere(page, S3);
      await until(
        async () =>
          (await drawn(page)).filter((row) => row.startsWith('open ')).includes('open S3 1'),
        'S3 takes number 1',
      );
      await clickRow(page, S2);
      await toZone(page, 'list');
      await page.keyboard.press('Control+Shift+1');
      await until(async () => (await selectedRow(page)) === S3, 'Ctrl+Shift+1 reaches S3');
      await page.keyboard.press('Control+Shift+2');
      await until(async () => (await selectedRow(page)) === S2, 'Ctrl+Shift+2 reaches S2');
      assert.deepEqual(l.problems, []);
    },
  );
});
