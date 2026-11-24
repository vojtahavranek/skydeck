// Follow-up F44 (S2 7.6, 12.1, 12.15) on the window's real server: the number 1-9 of a parked
// session's terminal. Parking frees it at once and the next terminal takes it; back under Open the
// session takes the lowest free number, none while all nine are taken; no two terminals ever hold
// one number, also around a move, a restart, a parking written by another connection, `/clear`, a
// terminal opened for a parked session, and a write that fails (the registry's, through the
// server's `beforeSlotsWrite` seam, or the mark's own, through a held write lock). Sessions run in
// real keepers with the stand-in; in the test process (A19) on realTestPlatform. Every wait is for
// a fact (a list, a message), never for a time.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import { isoFromNs } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { markParked, markUnparked } from '../../src/sessions/meta.ts';
import type { ListMessage, RowPayload } from '../../src/window/protocol.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, StartOptions, TestPage, TestServer } from '../helpers/window.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b';

const NAMES = new Map([
  [S1, 'S1'],
  [S2, 'S2'],
  [S3, 'S3'],
  [S4, 'S4'],
  [S5, 'S5'],
]);

const name = (id: string): string => NAMES.get(id) ?? id.slice(-2);

// ---------------------------------------------------------------------------------------------
// Helpers

/** A section as drawn: "<session>:<slot>" for each row. */
function drawn(list: ListMessage, section: string): string[] {
  return (list.sections.find((one) => one.name === section)?.rows ?? []).map(
    (row) => `${name(row.id)}:${row.slot ?? '-'}`,
  );
}

const reads = (order: string[]) => (list: ListMessage) =>
  JSON.stringify(drawn(list, 'open')) === JSON.stringify(order);

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return rowsOf(list).find((row) => row.id === sessionId);
}

function sectionOf(list: ListMessage, sessionId: string): string | null {
  return (
    list.sections.find((section) => section.rows.some((row) => row.id === sessionId))?.name ?? null
  );
}

/** The terminal whose session is, or is to be, `sessionId`, as the server's hub lists it. */
function termOfSession(test: TestServer, sessionId: string): string {
  const term = test.server.hub
    .list()
    .find((one) => (one.sessionId ?? one.expectedSessionId) === sessionId)?.id;
  assert.ok(term !== undefined, `a terminal of ${name(sessionId)}`);
  return term;
}

/** The number the registry holds for terminal `term`. */
function hubSlot(test: TestServer, term: string): number | null | undefined {
  return test.server.hub.list().find((one) => one.id === term)?.slot;
}

/** No two terminals with one number: in the registry and in `list`. */
function noNumberTwice(test: TestServer, list?: ListMessage): void {
  const held = test.server.hub.list().flatMap((term) => (term.slot === null ? [] : [term.slot]));
  assert.equal(new Set(held).size, held.length, `the registry's numbers: ${held.join(' ')}`);
  if (list !== undefined) {
    const shown = list.terminals.flatMap((term) => (term.slot === null ? [] : [term.slot]));
    assert.equal(new Set(shown).size, shown.length, `the list's numbers: ${shown.join(' ')}`);
  }
}

async function act(
  page: TestPage,
  kind: 'park' | 'unpark' | 'reorder' | 'resume',
  sessionId: string,
): Promise<void> {
  const message =
    kind === 'reorder'
      ? { kind, sessionId, direction: 'up' as const }
      : kind === 'resume'
        ? { kind, sessionId, cols: 80, rows: 24 }
        : { kind, sessionId };
  const result = await page.act(message);
  assert.equal(result.ok, true, `${kind} ${name(sessionId)}: ${JSON.stringify(result)}`);
}

/** `sessions` resumed in this order, each in a terminal of the window (numbers 1, 2, …). */
async function started(
  t: TestContext,
  sessions: readonly string[],
  options: { more?: readonly string[]; server?: StartOptions } = {},
): Promise<{ d: ServerSandbox; test: TestServer; page: TestPage; list: ListMessage }> {
  const d = serverSandbox(t);
  for (const id of [S1, S2, S3, S4, S5, ...(options.more ?? [])]) d.resumable(id);
  const test = await d.start(options.server);
  const page = await connectTestPage(t, d, test.server);
  for (const sessionId of sessions) await act(page, 'resume', sessionId);
  const order = sessions.map((id, at) => `${name(id)}:${at + 1}`);
  const list = await page.list(reads(order), `Open reads ${order.join(' ')}`);
  return { d, test, page, list };
}

let probes = 0;

/** A refresh that ran, as a fact: a new resumable session the next refresh's scan finds, listed. */
async function aRefresh(d: ServerSandbox, page: TestPage): Promise<ListMessage> {
  const probe = `00000000-0000-4000-8000-${String(++probes).padStart(12, '0')}`;
  d.resumable(probe);
  return page.list((list) => rowOf(list, probe) !== undefined, `the refresh that lists ${probe}`);
}

/** Every `list` the page got from item `from` on. */
function listsSince(page: TestPage, from: number): ListMessage[] {
  return page.all
    .slice(from)
    .flatMap((item) => ('text' in item && item.text.t === 'list' ? [item.text] : []));
}

/** Parks `sessionId` as `skydeck park` does, on the test's own connection. */
function parkAsTheCommand(d: ServerSandbox, sessionId: string): void {
  const row = loadRows(d.deck).find((one) => one.id === sessionId);
  assert.ok(row !== undefined, `${name(sessionId)} is a row of the store`);
  assert.equal(markParked(d.deck, row), true, 'written');
}

function parkedAt(d: ServerSandbox, sessionId: string): Ns {
  const at = d.deck.store.meta(sessionId)?.parkedAtNs ?? null;
  assert.ok(at !== null, 'a parking stored');
  return at;
}

/** The kept order of Open in the store, by name. */
function keptOrder(d: ServerSandbox): string[] {
  const text = d.deck.store.getKv('window_open_order');
  return text === null ? [] : (JSON.parse(text) as string[]).map(name);
}

/** Another process's write lock on the sandbox's store (the fixture's BEGIN IMMEDIATE). */
function holdWriteLock(t: TestContext, d: ServerSandbox): { held: Promise<void>; release(): void } {
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const holder = new Worker(new URL('../fixtures/hold-write-lock.ts', import.meta.url), {
    workerData: { path: join(d.s.skydeckHome, 'data', 'skydeck.db'), signal },
  });
  const release = (): void => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  t.after(async () => {
    release();
    await holder.terminate();
  });
  return {
    held: new Promise<void>((resolve) => holder.once('message', () => resolve())),
    release,
  };
}

/** The server's `beforeSlotsWrite`: it fails the registry's write while `held`. */
function seam(): { held: boolean; options: StartOptions } {
  const one = {
    held: false,
    options: {
      beforeSlotsWrite: () => {
        if (one.held) throw new Error('the test holds the write');
      },
    } as StartOptions,
  };
  return one;
}

const FAILED_LINE = 'terminal registry: the withheld slots were not saved (Error)';

// ---------------------------------------------------------------------------------------------

describe('parking frees the number at once (F44, A4)', () => {
  test('S2 in number 2 parked: the list that answers has it under Parked with no number; a resume takes 2; un-parked, S2 takes the lowest free one', async (t) => {
    const { test, page, list } = await started(t, [S1, S2, S3]);
    const second = termOfSession(test, S2);
    await act(page, 'park', S2);
    assert.equal(hubSlot(test, second), null, 'freed in the act itself');
    const parked = await page.list((one) => sectionOf(one, S2) === 'parked', 'S2 under Parked');
    assert.equal(rowOf(parked, S2)?.slot, null);
    assert.equal(parked.terminals.find((one) => one.id === second)?.slot, null);
    assert.deepEqual(drawn(parked, 'open'), ['S1:1', 'S3:3']);
    noNumberTwice(test, parked);
    await act(page, 'resume', S4);
    const taken = await page.list(reads(['S1:1', 'S4:2', 'S3:3']), 'S4 takes 2');
    noNumberTwice(test, taken);
    await act(page, 'unpark', S2);
    const back = await page.list(reads(['S1:1', 'S4:2', 'S3:3', 'S2:4']), 'S2 back with 4');
    assert.equal(hubSlot(test, second), 4);
    noNumberTwice(test, back);
    assert.ok(list.terminals.length === 3);
  });

  test('parked by another connection (the command): its number is free within a refresh, and a resume takes it', async (t) => {
    const { d, test, page } = await started(t, [S1, S2]);
    const second = termOfSession(test, S2);
    parkAsTheCommand(d, S2);
    const parked = await page.list(
      (one) => sectionOf(one, S2) === 'parked',
      'S2 under Parked within a refresh',
    );
    assert.equal(hubSlot(test, second), null);
    assert.deepEqual(drawn(parked, 'open'), ['S1:1']);
    await act(page, 'resume', S3);
    noNumberTwice(test, await page.list(reads(['S1:1', 'S3:2']), 'S3 takes 2'));
  });

  test('all nine taken: un-parked it takes none, is drawn as a row without one, and a move moves it as any such row (F42)', async (t) => {
    const others = Array.from(
      { length: 9 },
      (_, at) => `00000000-0000-4000-9000-${String(at + 1).padStart(12, '0')}`,
    );
    for (const [at, id] of others.entries()) NAMES.set(id, `N${at + 1}`);
    const { test, page } = await started(t, [S1], { more: others });
    const first = termOfSession(test, S1);
    await act(page, 'park', S1);
    await page.list((one) => sectionOf(one, S1) === 'parked', 'S1 under Parked');
    for (const id of others) await act(page, 'resume', id);
    const nine = others.map((id, at) => `${name(id)}:${at + 1}`);
    await page.list(reads(nine), 'nine numbers taken');
    await act(page, 'unpark', S1);
    const back = await page.list(reads([...nine, 'S1:-']), 'S1 back under Open, last, no number');
    assert.equal(hubSlot(test, first), null);
    noNumberTwice(test, back);
    await act(page, 'reorder', S1);
    const moved = await page.list(
      reads([...nine.slice(0, 8), 'S1:9', 'N9:-']),
      'S1 moved above N9 takes 9',
    );
    assert.equal(hubSlot(test, first), 9);
    noNumberTwice(test, moved);
  });
});

describe('what brings a parked session back with a number (F44, A3 in the window)', () => {
  test('bytes typed and not sent, and refreshes, do not; a prompt record after the parking does, with the lowest free number', async (t) => {
    const { d, test, page } = await started(t, [S1, S2, S3]);
    const second = termOfSession(test, S2);
    await act(page, 'park', S2);
    await page.list((one) => sectionOf(one, S2) === 'parked', 'S2 under Parked');
    assert.equal(test.server.hub.input(second, Buffer.from('typed, not sent', 'utf8')), 'ok');
    await aRefresh(d, page);
    const still = await aRefresh(d, page);
    assert.equal(sectionOf(still, S2), 'parked');
    assert.equal(hubSlot(test, second), null);
    await act(page, 'resume', S4);
    await page.list(reads(['S1:1', 'S4:2', 'S3:3']), 'S4 takes 2');
    // The user's own prompt, dated after the parking, as Claude Code appends it.
    appendFileSync(
      join(d.s.claudeHome, 'projects', 'project', `${S2}.jsonl`),
      `${JSON.stringify({ type: 'user', sessionId: S2, timestamp: isoFromNs(parkedAt(d, S2) + 1_000_000_000n), cwd: join(d.s.home, 'project'), entrypoint: 'cli' })}\n`,
    );
    const back = await page.list(
      reads(['S1:1', 'S4:2', 'S3:3', 'S2:4']),
      'S2 back under Open by itself, with 4',
    );
    noNumberTwice(test, back);
  });

  test('/clear in a parked session’s terminal: the new session is under Open with the lowest free number, the old one stays under Parked', async (t) => {
    const { test, page } = await started(t, [S1, S2, S3]);
    const second = termOfSession(test, S2);
    await act(page, 'park', S2);
    await page.list((one) => sectionOf(one, S2) === 'parked', 'S2 under Parked');
    page.send({ t: 'input', term: second, data: '/clear\r' });
    const cleared = await page.list(
      (one) =>
        one.terminals.some(
          (term) => term.id === second && term.sessionId !== null && term.sessionId !== S2,
        ) && one.terminals.some((term) => term.id === second && term.slot === 2),
      'the terminal shows the new session, with 2',
    );
    const next = cleared.terminals.find((term) => term.id === second)?.sessionId ?? '';
    NAMES.set(next, 'next');
    assert.equal(sectionOf(cleared, S2), 'parked', 'the old session stays parked');
    assert.equal(sectionOf(cleared, next), 'open');
    assert.equal(rowOf(cleared, next)?.slot, 2);
    noNumberTwice(test, cleared);
  });
});

describe('a parking and the moves around it (F44, A4, A7)', () => {
  test('a move just before the parking and one just after: no shared number, the order as the rule says', async (t) => {
    const { d, test, page } = await started(t, [S1, S2, S3]);
    const third = termOfSession(test, S3);
    await act(page, 'reorder', S3);
    await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'S3 moved up');
    await act(page, 'park', S3);
    assert.equal(hubSlot(test, third), null);
    const slots = JSON.parse(d.deck.store.getKv('window_slots') ?? '{}') as Record<string, unknown>;
    assert.equal(third in slots, false, 'its moved entry went with the parking');
    assert.deepEqual(keptOrder(d), ['S1', 'S2'], 'it left the kept order at once');
    await page.list(reads(['S1:1', 'S2:3']), 'S3 parked');
    await act(page, 'reorder', S2);
    const after = await page.list(reads(['S2:1', 'S1:3']), 'S2 moved up');
    assert.equal(hubSlot(test, third), null, 'the move gave the parked terminal nothing');
    noNumberTwice(test, after);
    await act(page, 'unpark', S3);
    const back = await page.list(reads(['S2:1', 'S3:2', 'S1:3']), 'S3 back with 2');
    noNumberTwice(test, back);
  });

  test('with a kept order, parking and un-parking move no other row of Open, on two pages', async (t) => {
    const { d, test, page } = await started(t, [S1, S2, S3]);
    const other = await connectTestPage(t, d, test.server);
    await act(page, 'reorder', S3);
    for (const one of [page, other]) {
      await one.list(reads(['S1:1', 'S3:2', 'S2:3']), 'the kept order');
    }
    const from = [page.all.length, other.all.length];
    await act(page, 'park', S1);
    assert.deepEqual(keptOrder(d), ['S3', 'S2'], 'S1 left the kept order in the act');
    for (const one of [page, other]) await one.list(reads(['S3:2', 'S2:3']), 'S1 parked');
    await act(other, 'unpark', S1);
    for (const one of [page, other]) {
      await one.list(reads(['S1:1', 'S3:2', 'S2:3']), 'S1 back: a row not kept, by its number');
    }
    for (const [at, one] of [page, other].entries()) {
      for (const list of listsSince(one, from[at] ?? 0)) {
        const rest = drawn(list, 'open')
          .map((entry) => entry.split(':')[0])
          .filter((entry) => entry !== 'S1');
        assert.deepEqual(rest, ['S3', 'S2'], 'no other row moved');
      }
    }
  });
});

describe('a restart (F44, A4)', () => {
  test('a crash after the freed number was taken: the stored withheld set is read at the start, so the terminal that took the number keeps it whatever the order of the hellos', async (t) => {
    const { d, test, page } = await started(t, [S1, S2]);
    const second = termOfSession(test, S2);
    await act(page, 'park', S2);
    await act(page, 'resume', S3);
    await page.list(reads(['S1:1', 'S3:2']), 'S3 takes 2');
    const third = termOfSession(test, S3);
    await test.drop();
    const again = await d.start();
    const later = await connectTestPage(t, d, again.server);
    const first = await later.list((one) => one.terminals.length === 3, 'the first list');
    assert.deepEqual(drawn(first, 'open'), ['S1:1', 'S3:2']);
    assert.equal(hubSlot(again, third), 2);
    assert.equal(hubSlot(again, second), null);
    assert.deepEqual(
      again.logs().filter((line) => line.includes("is another terminal's")),
      [],
      'no hello found its slot taken',
    );
    noNumberTwice(again, first);
  });

  test('parked: still no number after a restart; un-parked while the server was down: a number at the first list', async (t) => {
    const { d, test, page } = await started(t, [S1, S2, S3]);
    const second = termOfSession(test, S2);
    await act(page, 'park', S2);
    await page.list((one) => sectionOf(one, S2) === 'parked', 'S2 under Parked');
    await test.server.stop('the test restarts it');
    const again = await d.start();
    const later = await connectTestPage(t, d, again.server);
    const first = await later.list(
      (one) => one.terminals.length === 3,
      'the three terminals found, in the first list',
    );
    assert.equal(sectionOf(first, S2), 'parked');
    assert.equal(hubSlot(again, second), null);
    assert.deepEqual(drawn(first, 'open'), ['S1:1', 'S3:3']);
    noNumberTwice(again, first);
    await again.server.stop('the test restarts it again');
    markUnparked(d.deck, S2);
    const third = await d.start();
    const last = await connectTestPage(t, d, third.server);
    const back = await last.list((one) => one.terminals.length === 3, 'the first list');
    assert.deepEqual(drawn(back, 'open'), ['S1:1', 'S2:2', 'S3:3']);
    noNumberTwice(third, back);
  });
});

describe('a parked session resumed from its row (F44, A4, A6, the review’s Critical)', () => {
  test('no list any page gets from the act on carries a number for it; un-parked at once it takes the lowest free number', async (t) => {
    const { d, test, page } = await started(t, [S1]);
    const other = await connectTestPage(t, d, test.server);
    await act(page, 'park', S2);
    for (const one of [page, other]) {
      await one.list((list) => sectionOf(list, S2) === 'parked', 'S2 under Parked');
    }
    const from = [page.all.length, other.all.length];
    await act(page, 'resume', S2);
    const term = termOfSession(test, S2);
    assert.equal(hubSlot(test, term), null, 'withheld in the step that opened it');
    const running = await page.list(
      (list) => rowOf(list, S2)?.terminal === term && sectionOf(list, S2) === 'parked',
      'S2 runs under Parked',
    );
    assert.equal(rowOf(running, S2)?.parked, true, 'still parked');
    await act(page, 'resume', S3);
    await page.list(reads(['S1:1', 'S3:2']), 'S3 takes 2: S2 holds none');
    for (const [at, one] of [page, other].entries()) {
      for (const list of listsSince(one, from[at] ?? 0)) {
        assert.equal(rowOf(list, S2)?.slot ?? null, null, 'no number on its row');
        assert.equal(list.terminals.find((x) => x.id === term)?.slot ?? null, null);
      }
    }
    await act(page, 'unpark', S2);
    const back = await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'S2 under Open with 3');
    noNumberTwice(test, back);
  });

  for (const lost of [false, true]) {
    test(`resumed parked, the server stopped, un-parked on another connection, started again with window_slots_withheld ${lost ? 'deleted' : 'as stored'}: the first list has it under Open with a number`, async (t) => {
      const { d, test, page } = await started(t, [S1]);
      await act(page, 'park', S2);
      await page.list((list) => sectionOf(list, S2) === 'parked', 'S2 under Parked');
      await act(page, 'resume', S2);
      const term = termOfSession(test, S2);
      assert.equal(hubSlot(test, term), null);
      await test.server.stop('the test restarts it');
      assert.notEqual(d.deck.store.getKv('window_slots_withheld'), null, 'stored');
      if (lost) d.deck.store.deleteKv('window_slots_withheld');
      markUnparked(d.deck, S2);
      const again = await d.start();
      const later = await connectTestPage(t, d, again.server);
      const first = await later.list((one) => one.terminals.length === 2, 'the first list');
      assert.deepEqual(drawn(first, 'open'), ['S1:1', 'S2:2']);
      noNumberTwice(again, first);
    });
  }
});

describe('a write that fails (F44, A4: R-b)', () => {
  test('the registry’s write held (the seam): parked, the row has no number anywhere, the registry keeps it, a resume takes another; released, the next refresh frees it', async (t) => {
    const write = seam();
    const { d, test, page } = await started(t, [S1, S2], { server: write.options });
    const other = await connectTestPage(t, d, test.server);
    const second = termOfSession(test, S2);
    write.held = true;
    await act(page, 'park', S2);
    for (const one of [page, other]) {
      const list = await one.list((x) => sectionOf(x, S2) === 'parked', 'S2 under Parked');
      assert.equal(rowOf(list, S2)?.slot, null);
      assert.equal(list.terminals.find((x) => x.id === second)?.slot, null);
    }
    await aRefresh(d, page);
    await aRefresh(d, page);
    assert.equal(hubSlot(test, second), 2, 'the registry still holds 2');
    await act(page, 'resume', S4);
    const taken = await page.list(reads(['S1:1', 'S4:3']), 'S4 takes 3, not 2');
    noNumberTwice(test, taken);
    assert.equal(
      test.logs().filter((line) => line.includes(FAILED_LINE)).length,
      1,
      'logged once while it repeats',
    );
    write.held = false;
    await aRefresh(d, page);
    assert.equal(hubSlot(test, second), null, 'withheld after the next refresh');
    await act(page, 'resume', S5);
    noNumberTwice(test, await page.list(reads(['S1:1', 'S5:2', 'S4:3']), 'S5 takes 2'));

    // The other way: un-parked while the write is held, it is under Open without a number.
    write.held = true;
    await act(page, 'unpark', S2);
    const back = await page.list(reads(['S1:1', 'S5:2', 'S4:3', 'S2:-']), 'S2 back, no number');
    noNumberTwice(test, back);
    write.held = false;
    await page.list(reads(['S1:1', 'S5:2', 'S4:3', 'S2:4']), 'S2 takes 4 at the next refresh');
    noNumberTwice(test);
  });

  test('the seam held at a spawn: a parked session resumed keeps its born number in the registry, no page is sent it; un-parked (still held) it shows that number', async (t) => {
    const write = seam();
    const { test, page } = await started(t, [S1], { server: write.options });
    await act(page, 'park', S2);
    await page.list((list) => sectionOf(list, S2) === 'parked', 'S2 under Parked');
    write.held = true;
    const from = page.all.length;
    await act(page, 'resume', S2);
    const term = termOfSession(test, S2);
    assert.equal(hubSlot(test, term), 2, 'its born number: the withholding was not written');
    await page.list(
      (list) => rowOf(list, S2)?.terminal === term && sectionOf(list, S2) === 'parked',
      'S2 runs under Parked',
    );
    await act(page, 'unpark', S2);
    const back = await page.list(reads(['S1:1', 'S2:2']), 'S2 under Open with its number');
    noNumberTwice(test, back);
    for (const list of listsSince(page, from)) {
      if (sectionOf(list, S2) !== 'parked') continue;
      assert.equal(rowOf(list, S2)?.slot ?? null, null, 'no page was sent it while parked');
      assert.equal(list.terminals.find((x) => x.id === term)?.slot ?? null, null);
    }
  });

  test('with a kept order, un-parked while the write is held over refreshes, then released: the row takes its number and its place by that number (no other row moves)', async (t) => {
    const write = seam();
    const { d, page } = await started(t, [S1, S2, S3], { server: write.options });
    await act(page, 'reorder', S3);
    await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'the kept order');
    await act(page, 'park', S1);
    await page.list(reads(['S3:2', 'S2:3']), 'S1 parked');
    write.held = true;
    await act(page, 'unpark', S1);
    await page.list(reads(['S3:2', 'S2:3', 'S1:-']), 'S1 back, no number');
    await aRefresh(d, page);
    await aRefresh(d, page);
    assert.deepEqual(keptOrder(d).slice(0, 3), ['S3', 'S2', 'S1'], 'kept at its numberless place');
    write.held = false;
    await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'S1 by its number 1, first');
    const later = await aRefresh(d, page);
    assert.deepEqual(drawn(later, 'open'), ['S1:1', 'S3:2', 'S2:3'], 'and it stays there');
    assert.deepEqual(
      keptOrder(d).filter((id) => ['S1', 'S2', 'S3'].includes(id)),
      ['S1', 'S3', 'S2'],
    );
  });

  test('the mark’s own write busy (a held write lock): the act answers busy, the row stays where it was with its number, nothing is withheld', async (t) => {
    const { d, test, page } = await started(t, [S1, S2]);
    const second = termOfSession(test, S2);
    const lock = holdWriteLock(t, d);
    await lock.held;
    const result = await page.act({ kind: 'park', sessionId: S2 });
    assert.deepEqual(
      { ok: result.ok, error: result.error },
      { ok: false, error: "skydeck's database is busy; try again" },
    );
    lock.release();
    assert.equal(hubSlot(test, second), 2);
    const list = await page.list(reads(['S1:1', 'S2:2']), 'S2 where it was');
    assert.equal(rowOf(list, S2)?.parked, false);
    assert.equal(d.deck.store.meta(S2)?.parkedAtNs ?? null, null);
    assert.equal(d.deck.store.getKv('window_slots_withheld'), null);
  });
});
