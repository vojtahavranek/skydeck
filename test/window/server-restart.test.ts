// Restarting a session from the window (issue #166, with #188's flags) end to end on the server:
// sessions resumed into the window's terminals, real keepers running the stand-in, which ends on
// its hang-up (at once, or `/hup-late <s>` seconds later) as Claude Code does for a closed
// terminal. A page's `act restart`: one hang-up, then the session resumed as a plain resume (or
// with the flags given) in a terminal with the same number and at the same place in Open — after a
// move too, with all nine numbers taken and a tenth terminal waiting, with a terminal opened during
// the restart, in a second window —; not marked done, an ordinary end. When it is given up, and
// when the server stops meanwhile, nothing is resumed. In the test process (A19).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { loadRows } from '../../src/sessions/load.ts';
import { ENDED_IN_WINDOW } from '../../src/store/types.ts';
import type { ListMessage, RowPayload } from '../../src/window/protocol.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { readRecords } from '../helpers/standin.ts';
import type { StandinRecord } from '../helpers/standin.ts';
import { connectTestPage, serverSandbox } from '../helpers/window.ts';
import type {
  ServerSandbox,
  ServerSandboxOptions,
  TestPage,
  TestServer,
} from '../helpers/window.ts';

const RESTARTING = 'skydeck is restarting this session';

/** Session ids 4 to 11, after the helpers' S1–S3. */
const MORE = Array.from(
  { length: 8 },
  (_, at) => `${(at + 4).toString(16).padStart(8, '0')}-1111-4111-8111-${'0'.repeat(11)}${at}`,
);
const NAMES = new Map([S1, S2, S3, ...MORE].map((id, at) => [id, `S${at + 1}`]));

function drawn(list: ListMessage, name: 'open' | 'week' = 'open'): string[] {
  return (list.sections.find((section) => section.name === name)?.rows ?? []).map(
    (row) => `${NAMES.get(row.id) ?? row.id}:${row.slot ?? '-'}`,
  );
}

const reads = (order: string[]) => (list: ListMessage) =>
  JSON.stringify(drawn(list)) === JSON.stringify(order);

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return list.sections.flatMap((section) => section.rows).find((row) => row.id === sessionId);
}

function termOf(list: ListMessage, sessionId: string): string {
  const term = rowOf(list, sessionId)?.terminal ?? null;
  assert.ok(term !== null, `a terminal on the row of ${NAMES.get(sessionId) ?? sessionId}`);
  return term;
}

function assertNoNumberTwice(list: ListMessage): void {
  const slots = list.terminals.flatMap((term) => (term.slot === null ? [] : [term.slot]));
  assert.equal(new Set(slots).size, slots.length, `numbers: ${slots.join(' ')}`);
}

type Start = Extract<StandinRecord, { ev: 'start' }>;

/** The stand-in's starts of `sessionId`, in order: their arguments. */
function startsOf(d: ServerSandbox, sessionId: string): string[][] {
  return readRecords(d.record)
    .filter((one): one is Start => one.ev === 'start' && one.argv.includes(sessionId))
    .map((one) => one.argv);
}

const hups = (d: ServerSandbox): number =>
  readRecords(d.record).filter((one) => one.ev === 'hup').length;

/** `list` when it passes `test` already, else the next list that does (the server sends a list only
 *  when it changed). */
async function listWhere(
  page: TestPage,
  list: ListMessage,
  test: (list: ListMessage) => boolean,
  what: string,
  timeoutMs?: number,
): Promise<ListMessage> {
  return test(list) ? list : page.list(test, what, timeoutMs);
}

/** Waits until the stand-in has recorded `count` starts of `sessionId`. */
async function untilStarts(d: ServerSandbox, sessionId: string, count: number): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (startsOf(d, sessionId).length < count) {
    assert.ok(performance.now() < deadline, `${count} starts of ${NAMES.get(sessionId)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function resume(page: TestPage, sessionId: string): Promise<void> {
  const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
  assert.equal(result.ok, true, JSON.stringify(result));
}

/** `sessions` resumed in this order, each in a terminal of the window (numbers 1, 2, …). */
async function started(
  t: TestContext,
  sessions: readonly string[],
  options: ServerSandboxOptions = {},
): Promise<{ d: ServerSandbox; server: TestServer; page: TestPage; list: ListMessage }> {
  const d = serverSandbox(t, options);
  for (const id of [S1, S2, S3, ...MORE]) d.resumable(id);
  const server = await d.start();
  const page = await connectTestPage(t, d, server.server);
  for (const sessionId of sessions) await resume(page, sessionId);
  const order = sessions.map((id, at) => `${NAMES.get(id)}:${at < 9 ? at + 1 : '-'}`);
  const list = await page.list(
    (candidate) =>
      reads(order)(candidate) &&
      sessions.every((id) => rowOf(candidate, id)?.state !== 'not-running'),
    `Open reads ${order.join(' ')}, every session running`,
  );
  return { d, server, page, list };
}

/** A list in which `sessionId` runs again in a terminal other than `old`. */
async function runsAgain(page: TestPage, sessionId: string, old: string): Promise<ListMessage> {
  return page.list(
    (list) => {
      const row = rowOf(list, sessionId);
      return (
        row !== undefined &&
        row.terminal !== null &&
        row.terminal !== old &&
        row.state !== 'not-running' &&
        !list.terminals.some((one) => one.id === old)
      );
    },
    `${NAMES.get(sessionId)} running again in a new terminal, the old one gone`,
  );
}

describe('restarting a session from the window (#166)', () => {
  test('with other flags, then plainly: one hang-up each, the same number and place, the flags given and then those passed on; not done, an ordinary end; the header’s flags follow', async (t) => {
    const { d, page, list } = await started(t, [S1, S2, S3]);
    page.view({ selected: S2 });
    const old = termOf(list, S2);
    const flagged = await page.act(
      { kind: 'restart', term: old, sessionId: S2, flags: '--model example' },
      20_000,
    );
    assert.deepEqual(
      [flagged.ok, flagged.ended, flagged.sessionId, flagged.error],
      [true, true, S2, null],
      JSON.stringify(flagged),
    );
    const again = await runsAgain(page, S2, old);
    assert.deepEqual(drawn(again), ['S1:1', 'S2:2', 'S3:3']);
    assertNoNumberTwice(again);
    assert.deepEqual(startsOf(d, S2).at(-1), ['--resume', S2, '--model', 'example']);
    await listWhere(
      page,
      again,
      (candidate) =>
        JSON.stringify(candidate.selected?.launchFlags) === JSON.stringify(['--model', 'example']),
      'the header says --model example once the stand-in has started',
    );
    // Plainly: the flags of the latest start are passed on.
    const next = termOf(again, S2);
    const plain = await page.act({ kind: 'restart', term: next, sessionId: S2 }, 20_000);
    assert.deepEqual([plain.ok, plain.ended], [true, true], JSON.stringify(plain));
    const third = await runsAgain(page, S2, next);
    assert.deepEqual(drawn(third), ['S1:1', 'S2:2', 'S3:3']);
    assert.deepEqual(startsOf(d, S2).at(-1), ['--resume', S2, '--model', 'example']);
    assert.equal(hups(d), 2, 'one hang-up per restart');
    assert.equal(d.deck.store.meta(S2)?.doneAtNs ?? null, null, 'never marked done');
    const ends = d.deck.store
      .events()
      .filter((event) => event.sessionId === S2 && event.rawDetail === ENDED_IN_WINDOW);
    assert.equal(ends.length, 2, 'each end recorded as one the user asked for');
    const row = loadRows(d.deck).find((one) => one.id === S2);
    assert.deepEqual(row?.marks, [], 'never ended unexpectedly');
  });

  test('after a move (Open’s order kept): the restarted row keeps its place and number', async (t) => {
    const { d, page, list } = await started(t, [S1, S2, S3]);
    const moved = await page.act({ kind: 'reorder', sessionId: S3, direction: 'up' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    await page.list(reads(['S1:1', 'S3:2', 'S2:3']), 'moved');
    const order = d.deck.store.getKv('window_open_order');
    const old = termOf(list, S3);
    const result = await page.act({ kind: 'restart', term: old, sessionId: S3 }, 20_000);
    assert.equal(result.ok, true, JSON.stringify(result));
    const again = await runsAgain(page, S3, old);
    assert.deepEqual(drawn(again), ['S1:1', 'S3:2', 'S2:3']);
    assert.equal(d.deck.store.getKv('window_open_order'), order, 'the kept order unchanged');
  });

  test('all nine numbers taken and a tenth terminal waiting: the restart keeps its number, the tenth stays without; a terminal opened during the restart takes a free number, never the held one', async (t) => {
    const ten = [S1, S2, S3, ...MORE.slice(0, 7)];
    const { page, list } = await started(t, ten);
    const fourth = termOf(list, MORE[0] as string);
    page.send({ t: 'input', term: fourth, data: '/hup-late 2\r' });
    // Number 7 is free once S7's program ended (F43); the tenth terminal keeps none (#189 aside).
    page.send({ t: 'input', term: termOf(list, MORE[3] as string), data: '/exit\r' });
    await page.list((candidate) => drawn(candidate).length === 9, 'S7 left Open');
    const restarting = page.act(
      { kind: 'restart', term: fourth, sessionId: MORE[0] as string },
      30_000,
    );
    await page.list(
      (candidate) =>
        candidate.terminals.some((one) => one.id === fourth && one.restarting === true),
      'S4 restarting',
    );
    await resume(page, MORE[7] as string); // S11, during the restart
    const result = await restarting;
    assert.equal(result.ok, true, JSON.stringify(result));
    const after = await runsAgain(page, MORE[0] as string, fourth);
    const byName = new Map(drawn(after).map((one) => one.split(':') as [string, string]));
    assert.equal(byName.get('S4'), '4', 'S4 keeps number 4');
    assert.equal(byName.get('S11'), '7', 'the terminal opened meanwhile took the free number 7');
    assert.equal(byName.get('S10'), '-', 'the tenth still waits');
    assertNoNumberTwice(after);
  });

  test('a second window: its list shows the new terminal on the session’s row, with its number', async (t) => {
    const { d, server, page, list } = await started(t, [S1, S2]);
    const other = await connectTestPage(t, d, server.server, { view: { selected: S1 } });
    const old = termOf(list, S1);
    await other.list((candidate) => rowOf(candidate, S1)?.terminal === old, 'the second window');
    const result = await page.act({ kind: 'restart', term: old, sessionId: S1 }, 20_000);
    assert.equal(result.ok, true, JSON.stringify(result));
    const seen = await runsAgain(other, S1, old);
    assert.deepEqual(drawn(seen), ['S1:1', 'S2:2']);
    assert.equal(seen.selected?.sessionId, S1);
  });

  test('one at a time: while a restart waits for the end, a second restart, an end, a resume, a done mark and Close are refused', async (t) => {
    const { d, page, list } = await started(t, [S1]);
    const old = termOf(list, S1);
    page.send({ t: 'input', term: old, data: '/hup-late 2\r' });
    const first = page.act({ kind: 'restart', term: old, sessionId: S1 }, 30_000);
    await page.list(
      (candidate) => candidate.terminals.some((one) => one.id === old && one.restarting === true),
      'S1 restarting',
    );
    for (const action of [
      { kind: 'restart' as const, term: old, sessionId: S1 },
      { kind: 'end-session' as const, term: old, sessionId: S1 },
      { kind: 'resume' as const, sessionId: S1, cols: 80, rows: 24 },
      { kind: 'done' as const, sessionId: S1 },
      { kind: 'close-terminal' as const, term: old },
    ]) {
      const answer = await page.act(action);
      assert.deepEqual([answer.ok, answer.error], [false, RESTARTING], action.kind);
    }
    assert.equal((await first).ok, true);
    await untilStarts(d, S1, 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(hups(d), 1);
    assert.equal(startsOf(d, S1).length, 2, 'one resume');
  });
});

describe('restarting a session: when it does not work (#166)', () => {
  test('not ended within the wait: given up and said so; the session runs on with its number; its later end is an ordinary one, nothing resumed', async (t) => {
    const { d, page, list } = await started(t, [S1, S2], {
      env: { SKYDECK_TEST_END_WAIT_MS: '1000' },
    });
    const old = termOf(list, S1);
    page.send({ t: 'input', term: old, data: '/hup-late 3\r' });
    const result = await page.act({ kind: 'restart', term: old, sessionId: S1 }, 20_000);
    assert.deepEqual(
      [result.ok, result.ended, result.error],
      [false, false, 'claude has not ended within 10 seconds, so it runs on'],
    );
    const running = await page.list(
      (candidate) => !candidate.terminals.some((one) => one.restarting === true),
      'no longer restarting',
    );
    assert.deepEqual(drawn(running), ['S1:1', 'S2:2']);
    // Its ended terminal is there, with its bar, under Recent without a number.
    await page.list(
      (candidate) =>
        candidate.terminals.some((one) => one.id === old && one.state === 'ended') &&
        rowOf(candidate, S1)?.terminal === old &&
        drawn(candidate, 'week').includes('S1:-'),
      'its program ended later: its ended terminal under Recent',
      15_000,
    );
    assert.equal(startsOf(d, S1).length, 1, 'never resumed');
    assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
    const deadline = performance.now() + 10_000;
    while (
      !d.deck.store
        .events()
        .some((event) => event.sessionId === S1 && event.rawDetail === ENDED_IN_WINDOW)
    ) {
      assert.ok(performance.now() < deadline, 'its end recorded as one the user asked for');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  test('the server stops while the program ends: after its next start the terminal is an ordinary ended one without a number, and nothing resumes the session', async (t) => {
    const { d, server, page, list } = await started(t, [S1, S2]);
    const old = termOf(list, S1);
    page.send({ t: 'input', term: old, data: '/hup-late 3\r' });
    void page.act({ kind: 'restart', term: old, sessionId: S1 }, 30_000).catch(() => {});
    await page.list(
      (candidate) => candidate.terminals.some((one) => one.id === old && one.restarting === true),
      'S1 restarting',
    );
    await server.server.stop('the test restarts it');
    const again = await d.start();
    const later = await connectTestPage(t, d, again.server);
    const ended = await later.list(
      (candidate) =>
        candidate.terminals.some((one) => one.id === old && one.state === 'ended') &&
        rowOf(candidate, S1)?.terminal === old &&
        JSON.stringify(drawn(candidate)) === JSON.stringify(['S2:2']),
      'its terminal found, its program ended, S1 under Recent',
      20_000,
    );
    const term = ended.terminals.find((one) => one.id === old);
    assert.deepEqual([term?.slot, term?.restarting], [null, undefined]);
    assert.ok(drawn(ended, 'week').includes('S1:-'));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(startsOf(d, S1).length, 1, 'nothing resumed it');
    assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
  });
});
