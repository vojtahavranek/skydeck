// Moving a session of Open by hand, end to end on the server (follow-up F37, S2 12.9, 7.6): a
// page's `act reorder` on sessions resumed into the window's terminals (real keepers running the
// stand-in). The numbers follow the new order and each slot's row is the one drawn there; every
// page shows it, a page connected later too; the order survives a stop and a crash of the server
// while the keepers run; a closed terminal's moved slot does not come back; a terminal opened
// around a move never shares a slot. In the test process (A19) on realTestPlatform.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { parseRememberedOrder } from '../../src/sessions/restore-order.ts';
import { readOpenOrder, writeOpenOrder } from '../../src/window/open-order.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { REORDER_REFUSALS } from '../../src/window/view/slot-moves.ts';
import { isoFromNs } from '../../src/platform/time.ts';
import { BOOT_A, S1, S2, S3 } from '../helpers/platform.ts';
import { procStartOf, sleep, until } from '../helpers/keeper.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
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
    // What a restore after a reboot goes by (design 7.8): this boot's order of Open, as moved.
    const remembered = parseRememberedOrder(d.deck.store.getKv('window_restore_order'))[0];
    assert.deepEqual(remembered?.order, [S1, S3, S2]);
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

  test('without a move, a refresh takes the order of Open into the restore order', async (t) => {
    const { d } = await threeOpen(t);
    const remembered = (): readonly string[] =>
      parseRememberedOrder(d.deck.store.getKv('window_restore_order'))[0]?.order ?? [];
    await until(
      () => JSON.stringify(remembered()) === JSON.stringify([S1, S2, S3]),
      () => `the restore order holds Open's order: ${JSON.stringify(remembered())}`,
      10_000,
    );
  });

  test("a moved terminal whose program ends while the store is locked: its entry goes at the next refresh's write; its close answers ok", async (t) => {
    const { d, page } = await threeOpen(t);
    const moved = await page.act({ kind: 'reorder', sessionId: S3, direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const list = await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'moved');
    const term = list.terminals.find((one) => one.sessionId === S2)?.id ?? '';
    const kept = (): Record<string, number> =>
      JSON.parse(d.deck.store.getKv('window_slots') ?? '{}') as Record<string, number>;
    assert.equal(kept()[term], 3, "S2's terminal moved from 2 to 3");
    const other = new DatabaseSync(d.deck.places.dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      // F43: the number is freed at the end of the program, and the entry written away then.
      page.send({ t: 'input', term, data: '/exit\r' });
      await page.list(
        (candidate) => candidate.terminals.some((one) => one.id === term && one.state === 'ended'),
        "S2's program ended",
      );
      assert.equal(kept()[term], 3, 'the write met the lock: the entry is still stored');
      const closed = await page.act({ kind: 'close-terminal', term });
      assert.equal(closed.ok, true, 'a close answers ok whatever the write does');
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

/** The kept order in the store, the sessions by their names in the test (others by id). */
function keptOrder(d: ServerSandbox): string[] {
  const name = new Map([
    [S1, 'S1'],
    [S2, 'S2'],
    [S3, 'S3'],
    [S4, 'S4'],
  ]);
  return readOpenOrder(d.deck.store).map((id) => name.get(id) ?? id);
}

/** S1, S2, S3 resumed (slots 1, 2, 3) by a first server that is then stopped, `order` written as
 *  Open's kept order, and a second server started over the running keepers. */
async function startedWithOrder(
  t: TestContext,
  order: readonly string[],
): Promise<{ d: ServerSandbox; server: TestServer; page: TestPage }> {
  const { d, first } = await threeOpen(t);
  await first.server.stop('the test restarts it');
  writeOpenOrder(d.deck.store, order);
  const server = await d.start();
  const page = await connectTestPage(t, d, server.server);
  return { d, server, page };
}

/** Ends `sessionId`'s program and closes its terminal (the end-session act); the first list
 *  without that terminal and without the session under Open. */
async function endSession(
  page: TestPage,
  list: ListMessage,
  sessionId: string,
): Promise<ListMessage> {
  const term = list.terminals.find((one) => one.sessionId === sessionId)?.id ?? '';
  const ended = await page.act({ kind: 'end-session', term, sessionId }, 30_000);
  assert.equal(ended.ok, true, JSON.stringify(ended));
  return page.list(
    (candidate) =>
      !candidate.terminals.some((one) => one.id === term) &&
      !(candidate.sections.find((section) => section.name === 'open')?.rows ?? []).some(
        (row) => row.id === sessionId,
      ),
    `the terminal of ${sessionId} closed`,
  );
}

describe("Open's kept order on the server (F42)", () => {
  test('an order the store keeps is drawn on the first list, on a page connected later too', async (t) => {
    const { d, server, page } = await startedWithOrder(t, [S3, S1, S2]);
    const first = await page.list(() => true, 'the first list');
    assert.deepEqual(open(first), ['S3:3', 'S1:1', 'S2:2']);
    const later = await connectTestPage(t, d, server.server);
    assert.deepEqual(open(await later.list(() => true, 'a later first list')), [
      'S3:3',
      'S1:1',
      'S2:2',
    ]);
    assert.deepEqual(keptOrder(d), ['S3', 'S1', 'S2']);
  });

  test('without a kept order nothing is ever written to it', async (t) => {
    const { d, page } = await threeOpen(t);
    // Refreshes ran: the restore order took the slots.
    await until(
      () => d.deck.store.getKv('window_restore_order') !== null,
      'a refresh wrote the restore order',
      10_000,
    );
    const resumedS4 = await page.act({ kind: 'resume', sessionId: S4, cols: 80, rows: 24 });
    assert.equal(resumedS4.ok, true, JSON.stringify(resumedS4));
    await page.list(reads(['S1:1', 'S2:2', 'S3:3', 'S4:4']), 'S4 opened');
    await until(
      () => d.deck.store.getKv('window_restore_order')?.includes(S4) === true,
      'a refresh after S4 opened',
      10_000,
    );
    assert.equal(d.deck.store.getKv('window_open_order'), null);
  });

  test('a terminal closed leaves the kept order at the next refresh, the others keep their places; one opened after is kept where it was first drawn', async (t) => {
    const { d, page } = await startedWithOrder(t, [S3, S1, S2]);
    const list = await page.list(reads(['S3:3', 'S1:1', 'S2:2']), 'the kept order');
    assert.deepEqual(open(await endSession(page, list, S1)), ['S3:3', 'S2:2']);
    await until(
      () => JSON.stringify(keptOrder(d)) === JSON.stringify(['S3', 'S2']),
      () => `S1 left the kept order: ${JSON.stringify(keptOrder(d))}`,
      10_000,
    );
    // S4 takes the lowest free slot, 1, and is drawn at its number's place: before S3's 3.
    const resumedS4 = await page.act({ kind: 'resume', sessionId: S4, cols: 80, rows: 24 });
    assert.equal(resumedS4.ok, true, JSON.stringify(resumedS4));
    await page.list(reads(['S4:1', 'S3:3', 'S2:2']), 'S4 at its number’s place');
    await until(
      () => JSON.stringify(keptOrder(d)) === JSON.stringify(['S4', 'S3', 'S2']),
      () => `S4 kept where it was first drawn: ${JSON.stringify(keptOrder(d))}`,
      10_000,
    );
  });

  test('closing every terminal ends the kept order; the next terminal opened is drawn by the rule and kept nowhere', async (t) => {
    const { d, page } = await startedWithOrder(t, [S3, S1, S2]);
    let list = await page.list(reads(['S3:3', 'S1:1', 'S2:2']), 'the kept order');
    for (const sessionId of [S1, S2, S3]) {
      list = await endSession(page, list, sessionId);
    }
    await until(
      () => d.deck.store.getKv('window_open_order') === null,
      () => `the kept order removed: ${JSON.stringify(keptOrder(d))}`,
      10_000,
    );
    const resumedS4 = await page.act({ kind: 'resume', sessionId: S4, cols: 80, rows: 24 });
    assert.equal(resumedS4.ok, true, JSON.stringify(resumedS4));
    await page.list(reads(['S4:1']), 'S4 opened');
    await until(
      () => d.deck.store.getKv('window_restore_order')?.includes(S4) === true,
      'a refresh after S4 opened',
      10_000,
    );
    assert.equal(d.deck.store.getKv('window_open_order'), null);
  });

  test('/clear typed into a terminal: the new session takes the old one’s place in the kept order', async (t) => {
    const { d, server, page } = await startedWithOrder(t, [S3, S1, S2]);
    const list = await page.list(reads(['S3:3', 'S1:1', 'S2:2']), 'the kept order');
    const term = list.terminals.find((one) => one.sessionId === S1)?.id ?? '';
    // F40: a label on S1, so that its new session is offered a carry over.
    d.deck.store.updateMeta(S1, { label: 'the old label' }, d.platform.clock.nowNs());
    page.send({ t: 'input', term, data: '/clear\r' });
    const cleared = await page.list(
      (candidate) =>
        candidate.terminals.some(
          (one) => one.id === term && one.sessionId !== null && one.sessionId !== S1,
        ),
      'the terminal shows the new session',
    );
    const next = cleared.terminals.find((one) => one.id === term)?.sessionId ?? '';
    await until(
      () => JSON.stringify(keptOrder(d)) === JSON.stringify(['S3', next, 'S2']),
      () => `the new session at S1's place: ${JSON.stringify(keptOrder(d))}`,
      15_000,
    );
    const name = (row: { id: string }): string => (row.id === next ? 'next' : row.id);
    assert.deepEqual(
      (cleared.sections.find((section) => section.name === 'open')?.rows ?? []).map(name),
      [S3, 'next', S2],
    );
    // F40 meets F42: a page that selects the new session gets its offer, on the row that took
    // the old one's place.
    const selecting = await connectTestPage(t, d, server.server, { view: { selected: next } });
    const offered = await selecting.list(
      (candidate) => candidate.selected?.carryOver !== undefined,
      'the offer to carry over',
    );
    assert.equal(offered.selected?.carryOver?.from.id, S1);
    assert.deepEqual(
      (offered.sections.find((section) => section.name === 'open')?.rows ?? []).map(name),
      [S3, 'next', S2],
    );
  });

  test('a place held across refreshes: the process went on with a session not listed yet, and the kept order keeps the old one', async (t) => {
    // The process is this test's own (alive, on BOOT_A as the servers' /proc says): it held S1,
    // then went on with S4 after `/clear`. S4's transcript is not of the command line, so it is
    // not listed: no row takes S1's place, which is held.
    const d = serverSandbox(t, { bootId: BOOT_A });
    d.resumable(S1);
    const folder = join(d.s.claudeHome, 'projects', 'project');
    mkdirSync(folder, { recursive: true });
    const now = d.platform.clock.nowNs();
    const line = {
      type: 'user',
      sessionId: S4,
      timestamp: isoFromNs(now - 5_000_000_000n),
      cwd: join(d.s.home, 'project'),
      entrypoint: 'sdk-ts',
    };
    writeFileSync(join(folder, `${S4}.jsonl`), `${JSON.stringify(line)}\n`);
    const pid = process.pid;
    const procStart = procStartOf(pid);
    assert.ok(procStart !== null);
    const events = [
      { session: S1, source: 'startup', atNs: now - 10_000_000_000n },
      { session: S4, source: 'clear', atNs: now - 5_000_000_000n },
    ];
    for (const [at, one] of events.entries()) {
      const fields = {
        event: 'SessionStart' as const,
        timeNs: one.atNs,
        pid,
        procStart,
        input: hookInput('SessionStart', one.session, { source: one.source }),
      };
      writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, at + 1)), spoolText(fields));
    }
    writeOpenOrder(d.deck.store, [S1]);
    await d.start();
    await until(() => d.deck.store.linksTo(S4).length > 0, 'the clear link ingested', 10_000);
    // Several refreshes (one every two seconds): S1 keeps its place in the kept order.
    await sleep(6_000);
    assert.deepEqual(readOpenOrder(d.deck.store), [S1]);
  });

  test('a store locked during a refresh: the freeze is logged once, the refresh does not fail, the next one writes', async (t) => {
    const { d, server, page } = await startedWithOrder(t, [S3, S1, S2]);
    const list = await page.list(reads(['S3:3', 'S1:1', 'S2:2']), 'the kept order');
    const term = list.terminals.find((one) => one.sessionId === S1)?.id ?? '';
    const other = new DatabaseSync(d.deck.places.dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      // The program ends without a hook: nothing to ingest, so the refresh itself writes nothing.
      page.send({ t: 'input', term, data: '/fail\r' });
      await page.list(reads(['S3:3', 'S2:2']), "S1's program ended");
      await until(
        () => server.logs().some((line) => line.includes('the order of Open was not saved')),
        'the freeze met the lock',
        10_000,
      );
      assert.deepEqual(keptOrder(d), ['S3', 'S1', 'S2'], 'nothing written under the lock');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    await until(
      () => JSON.stringify(keptOrder(d)) === JSON.stringify(['S3', 'S2']),
      () => `written at the next refresh: ${JSON.stringify(keptOrder(d))}`,
      10_000,
    );
    const logged = server.logs().filter((line) => line.includes('open order:'));
    assert.equal(logged.length, 1, logged.join('\n'));
    assert.ok(
      logged[0]?.endsWith('open order: the order of Open was not saved (the database is busy)'),
    );
    assert.equal(
      server.logs().some((line) => /refresh/.test(line) && /fail/.test(line)),
      false,
      server.logs().join('\n'),
    );
  });
});

/** Session `n` of the ten-session test. */
function tenth(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Open as drawn in the ten-session test: "<n>:<slot>". */
function openTen(list: ListMessage): string[] {
  return (list.sections.find((section) => section.name === 'open')?.rows ?? []).map(
    (row) => `${Number.parseInt(row.id.slice(-12), 16)}:${row.slot ?? '-'}`,
  );
}

const readsTen = (order: string[]) => (list: ListMessage) =>
  JSON.stringify(openTen(list)) === JSON.stringify(order);

describe('moving any session of Open (F42)', () => {
  test('ten terminals: Shift+↑ on the tenth gives it 9 and the ninth none, on every page, a page connected later, after a stop and after a crash', async (t) => {
    const d = serverSandbox(t);
    const ids = Array.from({ length: 10 }, (_, at) => tenth(at + 1));
    for (const id of ids) d.resumable(id);
    const first = await d.start();
    const page = await connectTestPage(t, d, first.server);
    for (const sessionId of ids) {
      const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    const start = ['1:1', '2:2', '3:3', '4:4', '5:5', '6:6', '7:7', '8:8', '9:9', '10:-'];
    await page.list(readsTen(start), 'ten terminals, the tenth without a number');
    const other = await connectTestPage(t, d, first.server);
    const moved = await page.act({ kind: 'reorder', sessionId: tenth(10), direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const order = ['1:1', '2:2', '3:3', '4:4', '5:5', '6:6', '7:7', '8:8', '10:9', '9:-'];
    assertSlotsMatchRows(await page.list(readsTen(order), 'the tenth above the ninth'));
    await other.list(readsTen(order), 'the other page');
    const later = await connectTestPage(t, d, first.server);
    await later.list(readsTen(order), 'a page connected later');
    assert.deepEqual(readOpenOrder(d.deck.store), [...ids.slice(0, 8), tenth(10), tenth(9)]);

    await first.server.stop('the test restarts it');
    const second = await d.start();
    const again = await connectTestPage(t, d, second.server);
    assertSlotsMatchRows(await again.list(readsTen(order), 'the order after a stop'));
    await second.drop();
    const third = await d.start();
    const after = await connectTestPage(t, d, third.server);
    const list = await after.list(readsTen(order), 'the order after a crash');
    assertSlotsMatchRows(list);
    const slots = list.terminals.flatMap((term) => (term.slot === null ? [] : [term.slot]));
    assert.equal(new Set(slots).size, slots.length, 'no two terminals share a number');
  });

  test('a terminal ended after a move leaves a gap, the others keep their numbers and places; a new terminal takes the lowest free number at its place', async (t) => {
    const { d, page } = await threeOpen(t);
    const moved = await page.act({ kind: 'reorder', sessionId: S3, direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    let list = await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'moved');
    list = await endSession(page, list, S1);
    assert.deepEqual(open(list), ['S3:2', 'S2:3']);
    await until(
      () => JSON.stringify(keptOrder(d)) === JSON.stringify(['S3', 'S2']),
      () => `S1 left the kept order: ${JSON.stringify(keptOrder(d))}`,
      10_000,
    );
    const resumedS4 = await page.act({ kind: 'resume', sessionId: S4, cols: 80, rows: 24 });
    assert.equal(resumedS4.ok, true, JSON.stringify(resumedS4));
    assertSlotsMatchRows(
      await page.list(reads(['S4:1', 'S3:2', 'S2:3']), 'S4 with 1, at its place'),
    );
  });

  test('each refusal leaves the numbers and the kept order as they are', async (t) => {
    const { d, page } = await threeOpen(t);
    const moved = await page.act({ kind: 'reorder', sessionId: S2, direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const list = await page.list(reads(['S2:1', 'S1:2', 'S3:3']), 'moved');
    const kept = d.deck.store.getKv('window_open_order');
    const slots = d.deck.store.getKv('window_slots');
    for (const [action, line] of [
      [{ kind: 'reorder', sessionId: S2, direction: 'up' }, REORDER_REFUSALS.top],
      [{ kind: 'reorder', sessionId: S3, direction: 'down' }, REORDER_REFUSALS.last],
      [{ kind: 'reorder', sessionId: S4, direction: 'up' }, REORDER_REFUSALS.notOpen],
    ] as const) {
      const result = await page.act(action);
      assert.deepEqual([result.ok, result.error], [false, line]);
    }
    page.view({ filter: 'demo' });
    const filtered = await page.act({ kind: 'reorder', sessionId: S1, direction: 'up' });
    assert.deepEqual([filtered.ok, filtered.error], [false, REORDER_REFUSALS.filter]);
    page.view({});
    assert.equal(d.deck.store.getKv('window_open_order'), kept);
    assert.equal(d.deck.store.getKv('window_slots'), slots);
    assert.deepEqual(
      slotsOf(list),
      slotsOf(await page.list(reads(['S2:1', 'S1:2', 'S3:3']), 'a list after')),
    );
  });
});
