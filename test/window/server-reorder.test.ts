// Moving a session of Open by hand, end to end on the server (follow-up F37, S2 12.9, 7.6): a
// page's `act reorder` on sessions resumed into the window's terminals (real keepers running the
// stand-in). The numbers follow the new order and each slot's row is the one drawn there; every
// page shows it, a page connected later too; the order survives a stop and a crash of the server
// while the keepers run; a closed terminal's moved slot does not come back; a terminal opened
// around a move never shares a slot. In the test process (A19) on realTestPlatform.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { parseRememberedSlots } from '../../src/sessions/restore-order.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { REORDER_REFUSALS } from '../../src/window/view/slot-moves.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { until } from '../helpers/keeper.ts';
import { connectTestPage, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';

/** Open as drawn: "<session>:<slot>" for each row, the session by its name in the test. */
function open(list: ListMessage): string[] {
  const name = new Map([
    [S1, 'S1'],
    [S2, 'S2'],
    [S3, 'S3'],
    [S4, 'S4'],
  ]);
  return (list.sections.find((section) => section.name === 'open')?.rows ?? []).map(
    (row) => `${name.get(row.id) ?? row.id}:${row.slot ?? '-'}`,
  );
}

const reads = (order: string[]) => (list: ListMessage) =>
  JSON.stringify(open(list)) === JSON.stringify(order);

/** The terminals' slots by the session each shows. */
function slotsOf(list: ListMessage): Map<string | null, number | null> {
  return new Map(list.terminals.map((term) => [term.sessionId, term.slot]));
}

/** Each listed slot names the terminal whose row shows that number (A1: Ctrl+Shift+N reaches it). */
function assertSlotsMatchRows(list: ListMessage): void {
  const rows = list.sections.find((section) => section.name === 'open')?.rows ?? [];
  for (const row of rows) {
    if (row.slot === null) continue;
    const term = list.terminals.find((candidate) => candidate.slot === row.slot);
    assert.equal(term?.id, row.terminal, `slot ${row.slot}`);
  }
}

/** `sessions` resumed in this order, each in a terminal of the window (slots 1, 2, 3, …). */
async function resumed(
  page: TestPage,
  sessions: readonly string[],
  order: string[],
): Promise<ListMessage> {
  for (const sessionId of sessions) {
    const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  return page.list(reads(order), `Open reads ${order.join(' ')}`);
}

async function threeOpen(
  t: TestContext,
): Promise<{ d: ServerSandbox; first: TestServer; page: TestPage }> {
  const d = serverSandbox(t);
  for (const id of [S1, S2, S3, S4]) d.resumable(id);
  const first = await d.start();
  const page = await connectTestPage(t, d, first.server);
  await resumed(page, [S1, S2, S3], ['S1:1', 'S2:2', 'S3:3']);
  return { d, first, page };
}

describe('moving a session of Open (F37)', () => {
  test('Shift+↑ on slot 3: the numbers read 1 2 3 in the new order on every page, a page connected later too', async (t) => {
    const { d, first, page } = await threeOpen(t);
    const other = await connectTestPage(t, d, first.server);
    const result = await page.act({ kind: 'reorder', sessionId: S3, direction: 'up' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const order = ['S1:1', 'S3:2', 'S2:3'];
    const shown = await page.list(reads(order), 'the new order on the page that moved it');
    assertSlotsMatchRows(shown);
    // What a restore after a reboot goes by (design 7.8): this boot's slots, as moved.
    const remembered = parseRememberedSlots(d.deck.store.getKv('window_restore_order'))[0];
    assert.deepEqual(Object.fromEntries(remembered?.sessions ?? []), { [S1]: 1, [S3]: 2, [S2]: 3 });
    await other.list(reads(order), 'the new order on the other page');
    const later = await connectTestPage(t, d, first.server);
    assertSlotsMatchRows(await later.list(reads(order), 'the new order after a reload'));
    const down = await page.act({ kind: 'reorder', sessionId: S1, direction: 'down' });
    assert.equal(down.ok, true, JSON.stringify(down));
    await other.list(reads(['S3:1', 'S1:2', 'S2:3']), 'moved down');
  });

  test('each refusal answers its line and changes no slot; a busy store answers busy', async (t) => {
    const { d, page } = await threeOpen(t);
    const before = slotsOf(await page.list(() => true, 'a list'));
    const refusals: [Parameters<TestPage['act']>[0], string][] = [
      [{ kind: 'reorder', sessionId: S1, direction: 'up' }, REORDER_REFUSALS.top],
      [{ kind: 'reorder', sessionId: S3, direction: 'down' }, REORDER_REFUSALS.last],
      [{ kind: 'reorder', sessionId: S4, direction: 'up' }, REORDER_REFUSALS.notOpen],
    ];
    for (const [action, line] of refusals) {
      const result = await page.act(action);
      assert.deepEqual([result.ok, result.error], [false, line]);
    }
    page.view({ filter: 'demo' });
    const filtered = await page.act({ kind: 'reorder', sessionId: S2, direction: 'up' });
    assert.deepEqual([filtered.ok, filtered.error], [false, REORDER_REFUSALS.filter]);
    page.view({ chips: ['running'] });
    const chipped = await page.act({ kind: 'reorder', sessionId: S2, direction: 'up' });
    assert.deepEqual([chipped.ok, chipped.error], [false, REORDER_REFUSALS.filter]);
    page.view({});

    const other = new DatabaseSync(d.deck.places.dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      const busy = await page.act({ kind: 'reorder', sessionId: S2, direction: 'up' });
      assert.deepEqual([busy.ok, busy.error], [false, "skydeck's database is busy; try again"]);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    const after = await page.list(() => true, 'a list');
    assert.deepEqual(slotsOf(after), before);
    assert.equal(d.deck.store.getKv('window_slots'), null, 'nothing moved, nothing kept');
  });

  test('the order survives a stop and a crash of the server while the keepers run; a closed terminal does not come back', async (t) => {
    const { d, first, page } = await threeOpen(t);
    const moved = await page.act({ kind: 'reorder', sessionId: S3, direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'moved');
    assert.ok(d.deck.store.getKv('window_slots') !== null);

    await first.server.stop('the test restarts it');
    const second = await d.start();
    const again = await connectTestPage(t, d, second.server);
    assertSlotsMatchRows(
      await again.list(reads(['S1:1', 'S3:2', 'S2:3']), 'the order after a stop'),
    );

    await second.drop();
    const third = await d.start();
    const after = await connectTestPage(t, d, third.server);
    const list = await after.list(reads(['S1:1', 'S3:2', 'S2:3']), 'the order after a crash');

    // S2's terminal (moved to 3) is ended and closed: its entry goes with it.
    const term = list.terminals.find((one) => one.sessionId === S2)?.id ?? '';
    const ended = await after.act({ kind: 'end-session', term, sessionId: S2 }, 30_000);
    assert.equal(ended.ok, true, JSON.stringify(ended));
    await after.list(
      (candidate) => !candidate.terminals.some((one) => one.id === term),
      "S2's terminal closed",
    );
    const kept = JSON.parse(d.deck.store.getKv('window_slots') ?? '{}') as Record<string, number>;
    assert.equal(term in kept, false, 'its moved slot is not kept');
    await third.server.stop('the test restarts it');
    const fourth = await d.start();
    const last = await connectTestPage(t, d, fourth.server);
    await last.list(reads(['S1:1', 'S3:2']), 'without S2 after a restart');
    // A terminal opened now takes the lowest free slot.
    const resumedS4 = await last.act({ kind: 'resume', sessionId: S4, cols: 80, rows: 24 });
    assert.equal(resumedS4.ok, true, JSON.stringify(resumedS4));
    await last.list(reads(['S1:1', 'S3:2', 'S4:3']), 'S4 in the lowest free slot');
  });

  test('a resume sent together with a reorder: four terminals, four slots, none shared', async (t) => {
    const { page } = await threeOpen(t);
    const [resume, reorder] = await Promise.all([
      page.act({ kind: 'resume', sessionId: S4, cols: 80, rows: 24 }),
      page.act({ kind: 'reorder', sessionId: S3, direction: 'up' }),
    ]);
    assert.equal(resume.ok, true, JSON.stringify(resume));
    assert.equal(reorder.ok, true, JSON.stringify(reorder));
    const list = await page.list((candidate) => candidate.terminals.length === 4, 'four terminals');
    const slots = list.terminals.map((term) => term.slot);
    assert.deepEqual([...slots].sort(), [1, 2, 3, 4]);
    assertSlotsMatchRows(list);
  });

  test('without a move, a refresh takes the slots of the window into the restore order', async (t) => {
    const { d } = await threeOpen(t);
    const remembered = (): Record<string, number> =>
      Object.fromEntries(
        parseRememberedSlots(d.deck.store.getKv('window_restore_order'))[0]?.sessions ?? [],
      );
    await until(
      () => JSON.stringify(remembered()) === JSON.stringify({ [S1]: 1, [S2]: 2, [S3]: 3 }),
      () => `the restore order holds the three slots: ${JSON.stringify(remembered())}`,
      10_000,
    );
  });

  test("a moved terminal closed while the store is locked: its entry goes at the next refresh's write", async (t) => {
    const { d, page } = await threeOpen(t);
    const moved = await page.act({ kind: 'reorder', sessionId: S3, direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const list = await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'moved');
    const term = list.terminals.find((one) => one.sessionId === S2)?.id ?? '';
    const kept = (): Record<string, number> =>
      JSON.parse(d.deck.store.getKv('window_slots') ?? '{}') as Record<string, number>;
    assert.equal(kept()[term], 3, "S2's terminal moved from 2 to 3");
    page.send({ t: 'input', term, data: '/exit\r' });
    await page.list(
      (candidate) => candidate.terminals.some((one) => one.id === term && one.state === 'ended'),
      "S2's program ended",
    );
    const other = new DatabaseSync(d.deck.places.dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      const closed = await page.act({ kind: 'close-terminal', term });
      assert.equal(closed.ok, true, 'a close answers ok whatever the write does');
      assert.equal(kept()[term], 3, 'the write met the lock: the entry is still stored');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    await until(
      () => !(term in kept()),
      () => `the entry gone after a refresh: ${JSON.stringify(kept())}`,
      10_000,
    );
  });
});
