// "End session and mark done" end to end on the server (follow-up F30): a page's `act
// end-session` on a session resumed into the window, with a real keeper running the stand-in,
// which on its hang-up runs Claude Code's SessionEnd hook with reason `other` as Claude Code does
// for a closed terminal (design 14): the row says it can be ended; the answer comes once the
// program ended; the terminal is closed and the row, done, leaves the list; the session reads as an
// ordinary ended one — no `ended-unexpectedly`, also when it was working — and restore never
// offers it, also once it is undone. In the test process (A19) on realTestPlatform.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadRows } from '../../src/sessions/load.ts';
import { markUndone } from '../../src/sessions/meta.ts';
import { planRestore } from '../../src/sessions/restore.ts';
import { ENDED_IN_WINDOW } from '../../src/store/types.ts';
import type { ListMessage, RowPayload } from '../../src/window/protocol.ts';
import { S1 } from '../helpers/platform.ts';
import { readRecords } from '../helpers/standin.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage } from '../helpers/window.ts';

const OTHER_BOOT = '00000000-0000-4000-8000-0000000000bb';

function openRow(list: ListMessage): RowPayload | undefined {
  return list.sections
    .find((section) => section.name === 'open')
    ?.rows.find((row) => row.id === S1);
}

/** S1 resumed into the window's terminal and running there, as the page's list shows it. */
async function runningInWindow(
  t: Parameters<typeof serverSandbox>[0],
): Promise<{ d: ServerSandbox; page: TestPage; row: RowPayload }> {
  const d = serverSandbox(t);
  d.resumable(S1);
  const started = await d.start();
  const page = await connectTestPage(t, d, started.server, { view: { selected: S1 } });
  await page.list((list) => rowsOf(list).some((row) => row.id === S1), 'S1 listed');
  const resumed = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const list = await page.list((candidate) => {
    const row = openRow(candidate);
    return row !== undefined && row.state !== 'not-running' && row.endable === true;
  }, 'S1 running in Open, endable');
  const row = openRow(list);
  assert.ok(row !== undefined && row.terminal !== null);
  return { d, page, row };
}

describe('ending a session from the window (F30)', () => {
  for (const working of [false, true]) {
    test(`a session ${working ? 'in the middle of a turn' : 'that waits'}: ended, done, closed, an ordinary end, never offered by restore`, async (t) => {
      const { d, page, row } = await runningInWindow(t);
      const term = row.terminal as string;
      if (working) {
        page.send({ t: 'input', term, data: '/busy\r' });
        await page.list((list) => openRow(list)?.state === 'working', 'S1 working');
      }
      const result = await page.act({ kind: 'end-session', term, sessionId: S1 }, 20_000);
      assert.deepEqual(
        [result.ok, result.ended, result.error],
        [true, true, null],
        JSON.stringify(result),
      );
      assert.notEqual(d.deck.store.meta(S1)?.doneAtNs ?? null, null, 'marked done');
      // The terminal is closed by the server and the row, done, is hidden from the list.
      const after = await page.list(
        (list) => !list.terminals.some((one) => one.id === term) && openRow(list) === undefined,
        'the terminal closed, S1 not listed',
      );
      assert.equal(
        rowsOf(after).some((one) => one.id === S1),
        false,
      );
      // The stand-in got one hang-up and ran its SessionEnd `other`, which the server ingests.
      const records = readRecords(d.platform.env['STANDIN_RECORD'] as string);
      assert.equal(records.filter((one) => one.ev === 'hup').length, 1);
      const deadline = performance.now() + 10_000;
      for (;;) {
        const ends = d.deck.store.events().filter((event) => event.kind === 'end');
        const window = ends.filter((event) => event.rawDetail === ENDED_IN_WINDOW);
        const hook = ends.filter((event) => event.rawDetail === 'other');
        if (window.length === 1 && hook.length === 1) break;
        assert.ok(
          performance.now() < deadline,
          `the two ends: ${JSON.stringify(ends.map((one) => [one.detail, one.rawDetail, one.pid]))}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const ended = loadRows(d.deck).find((one) => one.id === S1);
      assert.equal(ended?.state, 'not-running');
      assert.equal(ended?.done, true);
      assert.deepEqual(ended?.marks, [], 'not ended-unexpectedly, not was-working');
      assert.equal(ended?.session.lastHolding?.endDetail, 'exit');
      // Undone, it shows under Recent and can be resumed; restore (after a restart: another boot)
      // still never offers it.
      markUndone(d.deck, S1);
      const rows = loadRows(d.deck);
      const plan = planRestore(rows, d.deck.store.events(), OTHER_BOOT, true);
      assert.equal(
        plan.some((entry) => entry.row.id === S1),
        false,
      );
      const back = await page.list(
        (list) =>
          list.sections
            .find((section) => section.name === 'week')
            ?.rows.some((one) => one.id === S1) === true,
        'S1 under Recent once undone',
      );
      assert.equal(openRow(back), undefined);
      const again = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
      assert.equal(again.ok, true, `resumable: ${JSON.stringify(again)}`);
    });
  }

  test('a second request while the first waits: refused, one hang-up', async (t) => {
    const { page, row, d } = await runningInWindow(t);
    const term = row.terminal as string;
    const first = page.act({ kind: 'end-session', term, sessionId: S1 }, 20_000);
    const second = await page.act({ kind: 'end-session', term, sessionId: S1 });
    assert.deepEqual([second.ok, second.error], [false, 'skydeck is ending this session already']);
    assert.equal((await first).ended, true);
    const records = readRecords(d.platform.env['STANDIN_RECORD'] as string);
    assert.equal(records.filter((one) => one.ev === 'hup').length, 1);
  });
});
