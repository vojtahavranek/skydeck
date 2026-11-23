// Follow-up F43 (S2 7.6, 7.8): a terminal's number is free as soon as its program ends, not when
// its ended terminal is closed. End to end on the server: sessions resumed into the window's
// terminals (real keepers running the stand-in), a program ended by `/exit`; the next list shows
// the ended terminal without a number and its row under Recent without one, and the next resume
// takes the number — also for a session marked done that kept running (the owner's case), around
// a move's stored numbers and a server restart. In the test process (A19) on realTestPlatform.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { ListMessage, RowPayload } from '../../src/window/protocol.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { connectTestPage, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';

const NAMES = new Map([
  [S1, 'S1'],
  [S2, 'S2'],
  [S3, 'S3'],
  [S4, 'S4'],
]);

/** A section as drawn: "<session>:<slot>" for each row, the session by its name in the test. */
function drawn(list: ListMessage, name: 'open' | 'week' | 'earlier'): string[] {
  return (list.sections.find((section) => section.name === name)?.rows ?? []).map(
    (row) => `${NAMES.get(row.id) ?? row.id}:${row.slot ?? '-'}`,
  );
}

const reads = (order: string[]) => (list: ListMessage) =>
  JSON.stringify(drawn(list, 'open')) === JSON.stringify(order);

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return list.sections.flatMap((section) => section.rows).find((row) => row.id === sessionId);
}

/** The id of the terminal `sessionId`'s row shows in `list`. */
function termOf(list: ListMessage, sessionId: string): string {
  const term = rowOf(list, sessionId)?.terminal ?? null;
  assert.ok(term !== null, `a terminal on the row of ${NAMES.get(sessionId) ?? sessionId}`);
  return term;
}

/** The number of terminal `term` in `list` (undefined: not listed). */
function slotIn(list: ListMessage, term: string): number | null | undefined {
  return list.terminals.find((one) => one.id === term)?.slot;
}

/** No two terminals with one number. */
function assertNoNumberTwice(list: ListMessage): void {
  const slots = list.terminals.flatMap((term) => (term.slot === null ? [] : [term.slot]));
  assert.equal(new Set(slots).size, slots.length, `numbers: ${slots.join(' ')}`);
}

async function resume(page: TestPage, sessionId: string): Promise<void> {
  const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
  assert.equal(result.ok, true, JSON.stringify(result));
}

/** `sessions` resumed in this order, each in a terminal of the window (slots 1, 2, …). */
async function started(
  t: TestContext,
  sessions: readonly string[],
): Promise<{ d: ServerSandbox; server: TestServer; page: TestPage; list: ListMessage }> {
  const d = serverSandbox(t);
  for (const id of [S1, S2, S3, S4]) d.resumable(id);
  const server = await d.start();
  const page = await connectTestPage(t, d, server.server);
  for (const sessionId of sessions) await resume(page, sessionId);
  const order = sessions.map((id, at) => `${NAMES.get(id) ?? id}:${at + 1}`);
  const list = await page.list(reads(order), `Open reads ${order.join(' ')}`);
  return { d, server, page, list };
}

/** `/exit` in the terminal `term`; the first list where its program has ended. */
async function exitIn(page: TestPage, term: string): Promise<ListMessage> {
  page.send({ t: 'input', term, data: '/exit\r' });
  return page.list(
    (candidate) => candidate.terminals.some((one) => one.id === term && one.state === 'ended'),
    `the program of terminal ${term} ended`,
  );
}

describe('the number of a session whose program ended (F43)', () => {
  test('A1: a program that exits leaves its terminal without a number in the next list, and the next resume takes that number while the ended pane is still there', async (t) => {
    const { server, page, list } = await started(t, [S1, S2]);
    const first = termOf(list, S1);
    const ended = await exitIn(page, first);
    assert.equal(slotIn(ended, first), null, 'the ended terminal has no number');
    const row = rowOf(ended, S1);
    assert.equal(row?.terminal, first, "S1's row still shows its ended terminal");
    assert.equal(row?.slot, null, "S1's row has no number");
    assert.equal(slotIn(ended, termOf(list, S2)), 2, 'the other terminal keeps its number');
    await resume(page, S3);
    const after = await page.list(reads(['S3:1', 'S2:2']), 'S3 takes number 1');
    assert.ok(drawn(after, 'week').includes('S1:-'), 'S1 under Recent, without a number');
    assert.equal(
      server.server.hub.list().find((one) => one.id === first)?.state,
      'ended',
      'the ended terminal is still listed, with its last screen',
    );
    assertNoNumberTwice(after);
  });

  test("A2, the owner's case: a session marked done that keeps running and ends later frees its number without Show done, Close or a restart", async (t) => {
    const { page, list } = await started(t, [S1, S2]);
    const first = termOf(list, S1);
    const done = await page.act({ kind: 'done', sessionId: S1 });
    assert.equal(done.ok, true, JSON.stringify(done));
    // Running, it stays under Open with its number (a running session is listed whatever its
    // done mark).
    const marked = await page.list(
      (candidate) => rowOf(candidate, S1)?.done === true,
      'S1 marked done, still running',
    );
    assert.deepEqual(drawn(marked, 'open'), ['S1:1', 'S2:2']);
    const ended = await exitIn(page, first);
    assert.equal(slotIn(ended, first), null);
    const hidden = await page.list(
      (candidate) => rowOf(candidate, S1) === undefined,
      'S1 hidden once its program ended',
    );
    assert.equal(slotIn(hidden, first), null, 'its hidden ended terminal holds no number');
    await resume(page, S3);
    await page.list(reads(['S3:1', 'S2:2']), 'S3 takes number 1');
  });

  test("A4: an exit while a resume opens: no number twice; a moved number's stored entry goes at the end, and nothing gives it back after a restart", async (t) => {
    const { d, server, page, list } = await started(t, [S1, S2, S3]);
    const moved = await page.act({ kind: 'reorder', sessionId: S3, direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'moved');
    const second = termOf(list, S2);
    const kept = (): Record<string, number | null> =>
      JSON.parse(d.deck.store.getKv('window_slots') ?? '{}') as Record<string, number | null>;
    assert.equal(kept()[second], 3, "S2's terminal moved from 2 to 3");
    // The exit and a resume at once.
    page.send({ t: 'input', term: second, data: '/exit\r' });
    await resume(page, S4);
    const both = await page.list(
      (candidate) =>
        candidate.terminals.some((one) => one.id === second && one.state === 'ended') &&
        candidate.terminals.length === 4,
      "S2's program ended and S4 opened",
    );
    assertNoNumberTwice(both);
    assert.equal(slotIn(both, second), null);
    assert.equal(second in kept(), false, 'its moved entry went at its end, before any close');
    const s4 = slotIn(both, termOf(both, S4));
    const ids = [termOf(list, S1), termOf(list, S3), termOf(both, S4)];
    await server.server.stop('the test restarts it');
    const again = await d.start();
    const later = await connectTestPage(t, d, again.server);
    const restarted = await later.list(
      (candidate) => ids.every((id) => candidate.terminals.some((one) => one.id === id)),
      'the three running terminals found',
    );
    assertNoNumberTwice(restarted);
    // Its keeper ends once it has its A; found before that, its hello says its program exited.
    assert.equal(
      slotIn(restarted, second) ?? null,
      null,
      'the ended terminal has no number after the restart',
    );
    assert.deepEqual(
      ids.map((id) => slotIn(restarted, id)),
      [1, 2, s4],
    );
  });
});
