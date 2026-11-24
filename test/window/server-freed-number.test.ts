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

import { readMovedSlots, readWithheldSlots } from '../../src/window/moved-slots.ts';
import { writeOpenOrder } from '../../src/window/open-order.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { stillRuns, until } from '../helpers/keeper.ts';
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

/** The first list whose Open reads `order` (`each` sees every list until then); on a timeout the
 *  last Open seen is in the message. */
async function openReads(
  page: TestPage,
  order: readonly string[],
  what: string,
  each: (list: ListMessage) => void = () => {},
): Promise<ListMessage> {
  let last: string[] = [];
  try {
    return await page.list((list) => {
      each(list);
      last = openOf(list);
      return JSON.stringify(last) === JSON.stringify(order);
    }, what);
  } catch {
    assert.fail(`${what}: Open read ${last.join(' ')}, not ${order.join(' ')}`);
  }
}

/** Returns once `page` got no list for a little more than a second (the pages' pace, S2 8.2.8). */
async function quietSecond(page: TestPage): Promise<void> {
  for (;;) {
    try {
      await page.list(() => true, 'a list', 1100);
    } catch {
      return;
    }
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

/**
 * `count` sessions resumed in order into the window's terminals: 1–9 take 1–9, the rest none.
 * `waits`: the sessions without a number in Open's drawn order — their opening order on the wall
 * clock, which a step back of that clock can turn around, so the cases read it from the list.
 */
async function resumedMany(
  t: TestContext,
  count: number,
): Promise<{
  d: ServerSandbox;
  server: TestServer;
  page: TestPage;
  list: ListMessage;
  waits: number[];
}> {
  const d = serverSandbox(t);
  const ids = Array.from({ length: count }, (_, at) => nth(at + 1));
  for (const id of ids) d.resumable(id);
  const server = await d.start();
  const page = await connectTestPage(t, d, server.server);
  for (const sessionId of ids) {
    const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const numbered = ONE_TO_NINE.map((n) => `${n}:${n}`);
  const rest = ids.slice(9).map((_, at) => `${at + 10}:-`);
  let last: string[] = [];
  const list = await page
    .list((candidate) => {
      last = openOf(candidate);
      return (
        JSON.stringify(last.slice(0, 9)) === JSON.stringify(numbered) &&
        JSON.stringify(last.slice(9).sort()) === JSON.stringify([...rest].sort())
      );
    }, 'every terminal opened')
    .catch(() => assert.fail(`every terminal opened: Open read ${last.join(' ')}`));
  const waits = openOf(list)
    .slice(9)
    .map((entry) => Number.parseInt(entry, 10));
  return { d, server, page, list, waits };
}

const ONE_TO_NINE = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Open as `1:1 … 9:9`, then the waiting ones, with `given` (number → session) in place. */
function openWith(waits: readonly number[], given: ReadonlyMap<number, number>): string[] {
  const takers = new Set(given.values());
  return [
    ...ONE_TO_NINE.flatMap((n) => {
      const taker = given.get(n);
      return taker === undefined ? [`${n}:${n}`] : [`${taker}:${n}`];
    }),
    ...waits.filter((n) => !takers.has(n)).map((n) => `${n}:-`),
  ];
}

describe('a freed number goes to a running terminal without one (#189)', () => {
  test("the report's case, live: two programs of twelve end, the first two waiting terminals take their numbers, at their numbers' places, on every page, after a reload and a restart", async (t) => {
    const { d, server, page, list, waits } = await resumedMany(t, 12);
    const [w1, w2] = waits as [number, number, number];
    const other = await connectTestPage(t, d, server.server);
    // At the change that frees it, not a refresh later: no list shows a free number while a
    // running terminal has none.
    const seen: string[] = [];
    const watch = (candidate: ListMessage): void => {
      const held = new Set(
        candidate.terminals.flatMap((one) => (one.slot === null ? [] : [one.slot])),
      );
      const waits = candidate.terminals.some((one) => one.slot === null && one.state === 'running');
      if (held.size < 9 && waits) seen.push(openOf(candidate).join(' '));
    };
    // One after the other: the number freed first goes to the first that waits.
    page.send({ t: 'input', term: termWith(list, 6), data: '/exit\r' });
    await openReads(page, openWith(waits, new Map([[6, w1]])), 'the first waiting takes 6', watch);
    page.send({ t: 'input', term: termWith(list, 8), data: '/exit\r' });
    const filled = openWith(
      waits,
      new Map([
        [6, w1],
        [8, w2],
      ]),
    );
    const first = await openReads(page, filled, 'the gaps filled', watch);
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
    const { d, server, list, waits } = await resumedMany(t, 12);
    const [w1, w2] = waits as [number, number, number];
    const programs = [6, 8].map((slot) => {
      const term = server.server.hub.list().find((one) => one.id === termWith(list, slot));
      assert.ok(term?.program !== null && term?.program !== undefined, `number ${slot} runs`);
      return { ...term.program };
    });
    await server.server.stop('the test ends two programs while no server runs');
    for (const { pid, procStart } of programs) {
      // The stand-in this sandbox's server started, and still that process (its process start),
      // checked right before the signal, with no await between.
      assert.ok(Number.isSafeInteger(pid) && pid > 1, `not a pid to signal: ${pid}`);
      assert.ok(pid !== process.pid && pid !== process.ppid, 'never this process or its parent');
      assert.ok(stillRuns(pid, procStart), `program ${pid} no longer runs`);
      process.kill(pid, 'SIGKILL');
    }
    await until(
      () => programs.every(({ pid, procStart }) => !stillRuns(pid, procStart)),
      'the two programs are gone',
      10_000,
    );
    const second = await d.start();
    const page = await connectTestPage(t, d, second.server);
    const filled = openWith(
      waits,
      new Map([
        [6, w1],
        [8, w2],
      ]),
    );
    assertNumbersSound(await openReads(page, filled, 'the gaps filled at the start'));
  });

  test("with a kept order (a move before): the row that takes the number goes to its number's place, every other row keeps its own, both written together; a move after hands the numbers out as before", async (t) => {
    const { d, page, list, waits } = await resumedMany(t, 12);
    const [w1, w2, w3] = waits as [number, number, number];
    // The last waiting one moved above the one before it: Open's order is the server's from now
    // on; no number changes.
    const moved = await page.act({ kind: 'reorder', sessionId: nth(w3), direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const kept = [w1, w3, w2];
    await openReads(page, openWith(kept, new Map()), 'the last waiting one moved up');
    page.send({ t: 'input', term: termWith(list, 6), data: '/exit\r' });
    const filled = openWith(kept, new Map([[6, w1]]));
    const after = await openReads(page, filled, 'the first waiting takes 6, at its place');
    assertNumbersSound(after);
    const taker = after.terminals.find((one) => one.slot === 6)?.id ?? '';
    const stored = JSON.parse(d.deck.store.getKv('window_slots') ?? '{}') as Record<
      string,
      unknown
    >;
    assert.equal(stored[taker], 6, 'the number is stored');
    assert.deepEqual(
      (JSON.parse(d.deck.store.getKv('window_open_order') ?? '[]') as string[]).map((id) =>
        Number.parseInt(id.slice(-12), 16),
      ),
      [1, 2, 3, 4, 5, w1, 7, 8, 9, w3, w2],
      'and the order with it',
    );
    // A move after: it goes down past 7, the numbers follow the order among the numbers in use.
    const down = await page.act({ kind: 'reorder', sessionId: nth(w1), direction: 'down' });
    assert.equal(down.ok, true, JSON.stringify(down));
    assertNumbersSound(
      await openReads(
        page,
        ['1:1', '2:2', '3:3', '4:4', '5:5', '7:6', `${w1}:7`, '8:8', '9:9', `${w3}:-`, `${w2}:-`],
        'it below 7',
      ),
    );
  });

  test('a write that fails gives nothing: the number stays free, logged once; the first refresh that works after gives it', async (t) => {
    const { d, server, page, list, waits } = await resumedMany(t, 11);
    const [w1] = waits as [number, number];
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
    const filled = openWith(waits, new Map([[4, w1]]));
    assertNumbersSound(await openReads(page, filled, 'given once the store can be written'));
    const logged = server.logs().filter((line) => line.includes('freed numbers:'));
    assert.deepEqual(logged.length, 1, logged.join('\n'));
    assert.ok(
      logged[0]?.endsWith('freed numbers: a free number was not given (the database is busy)'),
      logged[0],
    );
  });
});

describe('the hand-out meets Parked, on the server (F44, #189)', () => {
  test('a parking frees its number for the first that waits, a row of a block of the kept order keeps its place; un-parked with all nine held it waits, and the next number freed goes to it at its place', async (t) => {
    const { d, server, waits } = await resumedMany(t, 10);
    const [w1] = waits as [number];
    // The waiting terminal in a block with 8 (group G), and an order kept (written while the
    // server is down, as Open draws it).
    const nowNs = d.platform.clock.nowNs();
    for (const n of [8, w1]) d.deck.store.updateMeta(nth(n), { group: 'G' }, nowNs);
    await server.server.stop('the test restarts it with a kept order');
    writeOpenOrder(d.deck.store, [1, 2, 3, 4, 5, 6, 7, 8, w1, 9].map(nth));
    const second = await d.start();
    const page = await connectTestPage(t, d, second.server);
    const block = ['1:1', '2:2', '3:3', '4:4', '5:5', '6:6', '7:7', '8:8', `${w1}:-`, '9:9'];
    let list = await openReads(page, block, 'the block of 8 and the waiting one, kept');

    // Parked: 5 gives its number up, and the waiting row takes it where it stands, in its block,
    // in the act itself (the registry right after its answer), and no list on the way shows the
    // number free while a terminal that is not withheld waits.
    const parkedTerm = second.server.hub.list().find((one) => one.sessionId === nth(5))?.id ?? '';
    const waitingTerm = second.server.hub.list().find((one) => one.slot === null)?.id ?? '';
    const seen: string[] = [];
    const watch = (candidate: ListMessage): void => {
      const parkedRows = new Set(
        (candidate.sections.find((one) => one.name === 'parked')?.rows ?? []).map((row) => row.id),
      );
      const held = candidate.terminals.filter((one) => one.slot !== null).length;
      const waits = candidate.terminals.some(
        (one) =>
          one.slot === null && one.state === 'running' && !parkedRows.has(one.sessionId ?? ''),
      );
      if (held < 9 && waits) seen.push(openOf(candidate).join(' '));
    };
    // A list goes to a page at most once a second (a later one waits for that second to end): the
    // parking comes after a second with none, so that a list it pushed on the way would be seen.
    await quietSecond(page);
    const parked = await page.act({ kind: 'park', sessionId: nth(5) });
    assert.equal(parked.ok, true, JSON.stringify(parked));
    assert.deepEqual(
      [parkedTerm, waitingTerm].map(
        (id) => second.server.hub.list().find((one) => one.id === id)?.slot,
      ),
      [null, 5],
      'given in the act',
    );
    // The give's write kept the withheld set (a restart would otherwise give the parked one its
    // number back over the one that took it).
    assert.deepEqual(readWithheldSlots(d.deck.store), new Set([parkedTerm]));
    assert.equal(readMovedSlots(d.deck.store).get(waitingTerm), 5);
    const taken = ['1:1', '2:2', '3:3', '4:4', '6:6', '7:7', '8:8', `${w1}:5`, '9:9'];
    list = await openReads(page, taken, 'the parked number taken in the block', watch);
    assert.deepEqual(seen, [], 'a list with a free number and a waiting terminal');
    assertNumbersSound(list);
    assert.equal(
      list.terminals.find((one) => one.sessionId === nth(5))?.slot,
      null,
      'the parked one has none',
    );

    // Un-parked with all nine held: it takes none (F44), waits, and no number is free.
    const unparked = await page.act({ kind: 'unpark', sessionId: nth(5) });
    assert.equal(unparked.ok, true, JSON.stringify(unparked));
    list = await openReads(page, [...taken, '5:-'], 'un-parked, waiting');
    assert.equal(second.server.hub.list().filter((one) => one.slot !== null).length, 9);

    // The next number freed (1's program ends) goes to it, at that number's place.
    page.send({ t: 'input', term: termWith(list, 1), data: '/exit\r' });
    const after = ['5:1', '2:2', '3:3', '4:4', '6:6', '7:7', '8:8', `${w1}:5`, '9:9'];
    assertNumbersSound(await openReads(page, after, 'the un-parked one takes 1'));
  });
  test("the give's write goes through the server's seam for the slots' writes: failing there, nothing is given and it is logged once; released, the next refresh gives", async (t) => {
    const { d, server, waits } = await resumedMany(t, 10);
    const [w1] = waits as [number];
    await server.server.stop('the test restarts it with the seam');
    // Armed, the seam lets its first write through (the parking's own) and fails the others.
    const seam = { armed: false, calls: 0 };
    const second = await d.start({
      beforeSlotsWrite: () => {
        if (!seam.armed) return;
        seam.calls += 1;
        if (seam.calls >= 2) throw new Error('the test holds the write');
      },
    });
    const page = await connectTestPage(t, d, second.server);
    const nine = ['1:1', '2:2', '3:3', '4:4', '5:5', '6:6', '7:7', '8:8', '9:9'];
    await openReads(page, [...nine, `${w1}:-`], 'restarted, the tenth waits');
    const waitingTerm = second.server.hub.list().find((one) => one.slot === null)?.id ?? '';
    seam.armed = true;
    const parked = await page.act({ kind: 'park', sessionId: nth(5) });
    assert.equal(parked.ok, true, JSON.stringify(parked));
    assert.equal(
      second.server.hub.list().find((one) => one.id === waitingTerm)?.slot,
      null,
      'its write failed: nothing given',
    );
    assert.ok(seam.calls >= 2, `the give's write went through the seam (${seam.calls} calls)`);
    const failed = 'freed numbers: a free number was not given (Error)';
    seam.armed = false;
    const given = ['1:1', '2:2', '3:3', '4:4', `${w1}:5`, '6:6', '7:7', '8:8', '9:9'];
    assertNumbersSound(await openReads(page, given, 'given at a later refresh'));
    const logged = second.logs().filter((line) => line.includes('freed numbers:'));
    assert.equal(logged.length, 1, logged.join('\n'));
    assert.ok(logged[0]?.endsWith(failed), logged[0]);
  });
});
