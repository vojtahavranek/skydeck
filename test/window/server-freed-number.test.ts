// A number 1–9 that becomes free goes to a running terminal of the window that has none (S2 7.6,
// issue #189): the first such terminal in Open's order takes the lowest free number, the others
// keep theirs. End to end on the server: sessions resumed into the window's terminals (real
// keepers running the stand-in), more than nine of them, so that some wait without a number; a
// program ended by `/exit`, or while no server ran. In the test process (A19) on
// realTestPlatform.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { ListMessage } from '../../src/window/protocol.ts';
import { until } from '../helpers/keeper.ts';
import { connectTestPage, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

/** Session `n` of these tests. */
function nth(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Open as drawn: "<n>:<slot>" for each row. */
function openOf(list: ListMessage): string[] {
  return (list.sections.find((section) => section.name === 'open')?.rows ?? []).map(
    (row) => `${Number.parseInt(row.id.slice(-12), 16)}:${row.slot ?? '-'}`,
  );
}

/** The first list whose Open reads `order`; on a timeout the last Open seen is in the message. */
async function openReads(
  page: TestPage,
  order: readonly string[],
  what: string,
): Promise<ListMessage> {
  let last: string[] = [];
  try {
    return await page.list((list) => {
      last = openOf(list);
      return JSON.stringify(last) === JSON.stringify(order);
    }, what);
  } catch {
    assert.fail(`${what}: Open read ${last.join(' ')}, not ${order.join(' ')}`);
  }
}

/** No two terminals with one number, and each number shown names the terminal of its row. */
function assertNumbersSound(list: ListMessage): void {
  const slots = list.terminals.flatMap((term) => (term.slot === null ? [] : [term.slot]));
  assert.equal(new Set(slots).size, slots.length, `numbers: ${slots.join(' ')}`);
  for (const row of list.sections.flatMap((section) => section.rows)) {
    if (row.slot === null) continue;
    const term = list.terminals.find((candidate) => candidate.slot === row.slot);
    assert.equal(term?.id, row.terminal, `number ${row.slot}`);
  }
}

/** The terminal that holds `slot` in `list`. */
function termWith(list: ListMessage, slot: number): string {
  const term = list.terminals.find((one) => one.slot === slot)?.id;
  assert.ok(term !== undefined, `a terminal with number ${slot}`);
  return term;
}

/** `count` sessions resumed in order into the window's terminals: 1–9 take 1–9, the rest none. */
async function resumedMany(
  t: TestContext,
  count: number,
): Promise<{ d: ServerSandbox; server: TestServer; page: TestPage; list: ListMessage }> {
  const d = serverSandbox(t);
  const ids = Array.from({ length: count }, (_, at) => nth(at + 1));
  for (const id of ids) d.resumable(id);
  const server = await d.start();
  const page = await connectTestPage(t, d, server.server);
  for (const sessionId of ids) {
    const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const order = ids.map((_, at) => `${at + 1}:${at < 9 ? at + 1 : '-'}`);
  const list = await openReads(page, order, 'every terminal opened');
  return { d, server, page, list };
}

describe('a freed number goes to a running terminal without one (#189)', () => {
  test("the report's case, live: two programs of twelve end, the first two waiting terminals take their numbers, at their numbers' places, on every page, after a reload and a restart", async (t) => {
    const { d, server, page, list } = await resumedMany(t, 12);
    const other = await connectTestPage(t, d, server.server);
    for (const slot of [6, 8]) {
      page.send({ t: 'input', term: termWith(list, slot), data: '/exit\r' });
    }
    const filled = ['1:1', '2:2', '3:3', '4:4', '5:5', '10:6', '7:7', '11:8', '9:9', '12:-'];
    // At the change that frees it, not a refresh later: no list shows a free number while a
    // running terminal has none.
    const seen: string[] = [];
    const first = await page.list((candidate) => {
      const held = new Set(
        candidate.terminals.flatMap((one) => (one.slot === null ? [] : [one.slot])),
      );
      const waits = candidate.terminals.some((one) => one.slot === null && one.state === 'running');
      if (held.size < 9 && waits) seen.push(openOf(candidate).join(' '));
      return JSON.stringify(openOf(candidate)) === JSON.stringify(filled);
    }, 'the gaps filled');
    assert.deepEqual(seen, [], 'a list with a free number and a waiting terminal');
    assertNumbersSound(first);
    assertNumbersSound(await openReads(other, filled, 'the other page'));
    const later = await connectTestPage(t, d, server.server);
    await openReads(later, filled, 'a page connected later');

    await server.server.stop('the test restarts it');
    const second = await d.start();
    const again = await connectTestPage(t, d, second.server);
    assertNumbersSound(await openReads(again, filled, 'after a server restart'));
  });

  test("the report's case at a server start: programs that ended while no server ran leave numbers the first refresh hands to the waiting terminals", async (t) => {
    const { d, server, list } = await resumedMany(t, 12);
    const programs = [6, 8].map((slot) => {
      const term = server.server.hub.list().find((one) => one.id === termWith(list, slot));
      assert.ok(term?.program !== null && term?.program !== undefined, `number ${slot} runs`);
      return term.program.pid;
    });
    await server.server.stop('the test ends two programs while no server runs');
    for (const pid of programs) process.kill(pid, 'SIGKILL');
    await until(
      () =>
        programs.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
      'the two programs are gone',
      10_000,
    );
    const second = await d.start();
    const page = await connectTestPage(t, d, second.server);
    const filled = ['1:1', '2:2', '3:3', '4:4', '5:5', '10:6', '7:7', '11:8', '9:9', '12:-'];
    assertNumbersSound(await openReads(page, filled, 'the gaps filled at the start'));
  });

  test("with a kept order (a move before): the row that takes the number goes to its number's place, every other row keeps its own, both written together; a move after hands the numbers out as before", async (t) => {
    const { d, page, list } = await resumedMany(t, 12);
    // 12 moved above 11: Open's order is the server's from now on; no number changes.
    const moved = await page.act({ kind: 'reorder', sessionId: nth(12), direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const before = ['1:1', '2:2', '3:3', '4:4', '5:5', '6:6', '7:7', '8:8', '9:9', '10:-', '12:-'];
    await openReads(page, [...before, '11:-'], '12 above 11');
    page.send({ t: 'input', term: termWith(list, 6), data: '/exit\r' });
    const filled = ['1:1', '2:2', '3:3', '4:4', '5:5', '10:6', '7:7', '8:8', '9:9', '12:-', '11:-'];
    const after = await openReads(page, filled, '10 takes 6, at its place');
    assertNumbersSound(after);
    const ten = after.terminals.find((one) => one.slot === 6)?.id ?? '';
    const stored = JSON.parse(d.deck.store.getKv('window_slots') ?? '{}') as Record<
      string,
      unknown
    >;
    assert.equal(stored[ten], 6, 'the number is stored');
    assert.deepEqual(
      (JSON.parse(d.deck.store.getKv('window_open_order') ?? '[]') as string[]).map((id) =>
        Number.parseInt(id.slice(-12), 16),
      ),
      [1, 2, 3, 4, 5, 10, 7, 8, 9, 12, 11],
      'and the order with it',
    );
    // A move after: 10 down past 7, the numbers follow the order among the numbers in use.
    const down = await page.act({ kind: 'reorder', sessionId: nth(10), direction: 'down' });
    assert.equal(down.ok, true, JSON.stringify(down));
    assertNumbersSound(
      await openReads(
        page,
        ['1:1', '2:2', '3:3', '4:4', '5:5', '7:6', '10:7', '8:8', '9:9', '12:-', '11:-'],
        '10 below 7',
      ),
    );
  });

  test('a write that fails gives nothing: the number stays free, logged once; the first refresh that works after gives it', async (t) => {
    const { d, server, page, list } = await resumedMany(t, 11);
    const other = new DatabaseSync(d.deck.places.dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      page.send({ t: 'input', term: termWith(list, 4), data: '/exit\r' });
      const ended = await page.list(
        (candidate) =>
          candidate.terminals.some((one) => one.state === 'ended') &&
          !openOf(candidate).includes('4:4'),
        "4's program ended",
      );
      assert.deepEqual(
        ended.terminals.filter((one) => one.slot === null && one.state === 'running').length,
        2,
        'both waiting terminals still wait',
      );
      await until(
        () => server.logs().some((line) => line.includes('freed numbers:')),
        'the fill met the lock',
        10_000,
      );
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    const filled = ['1:1', '2:2', '3:3', '10:4', '5:5', '6:6', '7:7', '8:8', '9:9', '11:-'];
    assertNumbersSound(await openReads(page, filled, 'given once the store can be written'));
    const logged = server.logs().filter((line) => line.includes('freed numbers:'));
    assert.deepEqual(logged.length, 1, logged.join('\n'));
    assert.ok(
      logged[0]?.endsWith('freed numbers: a free number was not given (the database is busy)'),
      logged[0],
    );
  });
});
