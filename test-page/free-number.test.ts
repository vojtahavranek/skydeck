// Follow-up F43 (S2 7.6, 12.1, 12.9): a session's number is free as soon as its program ends. Against
// a real test server with the stand-in: after `/exit` in the terminal of slot 1 its row is under
// Recent with no number, Ctrl+Shift+1 reaches no session, and the next resume takes number 1, which
// Ctrl+Shift+1 then reaches; the other terminal keeps its number. A terminal still running whose
// session ended a moment before its program keeps its number: its row under Recent shows none, and
// Ctrl+Shift+1 still reaches it.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { procStartOf } from '../test/helpers/keeper.ts';
import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../test/helpers/spool.ts';
import { connectTestPage } from '../test/helpers/window.ts';
import { browser } from './helpers/browser.ts';
import { clickRow, keyMessage, launched, selectedRow, termOf, toZone } from './helpers/shell.ts';
import { resumeHere, shownTerm, until } from './helpers/terminal.ts';

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

  await t.test(
    'against a real server: a RUNNING terminal whose session ended a moment before its program (its row under Recent, no number) is still reached by Ctrl+Shift+1',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      d.resumable(S1);
      d.resumable(S2);
      await resumeHere(page, S1);
      await resumeHere(page, S2);
      await until(async () => {
        const rows = (await drawn(page)).filter((row) => row.startsWith('open '));
        return JSON.stringify(rows) === JSON.stringify(['open S1 1', 'open S2 2']);
      }, 'S1 and S2 in slots 1 and 2');
      // S1's session ends (its SessionEnd, as the hook writes it) while its program runs on.
      const term = termOf(l, S1);
      const program = l.server.hub.list().find((one) => one.id === term)?.program ?? null;
      assert.ok(program !== null, "S1's program");
      const procStart = procStartOf(program.pid);
      assert.ok(procStart !== null);
      const fields = {
        event: 'SessionEnd' as const,
        timeNs: d.platform.clock.nowNs(),
        pid: program.pid,
        procStart,
        bootId: d.platform.proc.bootId() ?? '',
        input: hookInput('SessionEnd', S1, { reason: 'other' }),
      };
      writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
      await until(
        async () =>
          (await drawn(page)).some((row) => row.endsWith(' S1 -') && !row.startsWith('open ')),
        "S1's row under Recent without a number",
      );
      const running = l.server.hub.list().find((one) => one.id === term);
      assert.deepEqual(
        [running?.state, running?.slot],
        ['running', 1],
        'its terminal runs, holding 1',
      );

      await clickRow(page, S2);
      await toZone(page, 'list');
      await page.keyboard.press('Control+Shift+1');
      await until(async () => (await selectedRow(page)) === S1, 'Ctrl+Shift+1 reaches S1');
      await until(async () => (await shownTerm(page)) === term, "S1's running terminal is shown");
      assert.deepEqual(l.problems, []);
    },
  );
});
