// "End session and mark done" end to end on the server (follow-up F30): a page's `act
// end-session` on a session resumed into the window, with a real keeper running the stand-in,
// which on its hang-up runs Claude Code's SessionEnd hook with reason `other` as Claude Code does
// for a closed terminal (design 14): the row says it can be ended; the answer comes once the
// program ended; the terminal is closed and the row, done, leaves the list; the session reads as an
// ordinary ended one — no `ended-unexpectedly`, also when it was working — and restore never
// offers it, also once it is undone. The dialog "Park"'s end (S2 12.15, `mark` `park`): parked in
// place of marked done, the same end; its number freed and taken by another; a second page sees
// it; resumed from its row it stays parked; not ended within the wait; refused when parked
// already. In the test process (A19) on realTestPlatform.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadRows } from '../../src/sessions/load.ts';
import { markUndone } from '../../src/sessions/meta.ts';
import { planRestore } from '../../src/sessions/restore.ts';
import { ENDED_IN_WINDOW } from '../../src/store/types.ts';
import type { ListMessage, RowPayload } from '../../src/window/protocol.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { readRecords } from '../helpers/standin.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, ServerSandboxOptions, TestPage } from '../helpers/window.ts';

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

function rowIn(list: ListMessage, section: string, id = S1): RowPayload | undefined {
  return list.sections.find((one) => one.name === section)?.rows.find((row) => row.id === id);
}

/** `sessions` resumed into the window's terminals in this order (numbers 1, 2, …), each running. */
async function resumedInWindow(
  t: Parameters<typeof serverSandbox>[0],
  sessions: string[],
  options: ServerSandboxOptions = {},
): Promise<{ d: ServerSandbox; other: TestPage; page: TestPage; list: ListMessage }> {
  const d = serverSandbox(t, options);
  for (const id of [S1, S2, S3]) d.resumable(id);
  const started = await d.start();
  const page = await connectTestPage(t, d, started.server);
  const second = await connectTestPage(t, d, started.server);
  await page.list((list) => rowsOf(list).some((row) => row.id === S1), 'listed');
  for (const sessionId of sessions) {
    const resumed = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
  }
  const list = await page.list(
    (candidate) =>
      sessions.every((id, at) => {
        const row = rowIn(candidate, 'open', id);
        return row?.endable === true && row.slot === at + 1;
      }),
    'every session running under Open, endable, numbered',
  );
  return { d, other: second, page, list };
}

const until = async (check: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const deadline = performance.now() + ms;
  while (!check()) {
    assert.ok(performance.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe('ending a session and parking it from the window (the dialog "Park")', () => {
  test('ended and parked: under Parked, not running, its terminal closed and its number taken by another, on a second page too; an ordinary end, never offered by restore; resumed from its row it stays parked with no number', async (t) => {
    const { d, other, page, list } = await resumedInWindow(t, [S1, S2]);
    const term = rowIn(list, 'open')?.terminal as string;
    const result = await page.act(
      { kind: 'end-session', term, sessionId: S1, mark: 'park' },
      20_000,
    );
    assert.deepEqual(
      [result.ok, result.ended, result.error],
      [true, true, null],
      JSON.stringify(result),
    );
    const meta = d.deck.store.meta(S1);
    assert.notEqual(meta?.parkedAtNs ?? null, null, 'parked');
    assert.equal(meta?.doneAtNs ?? null, null, 'not marked done');
    for (const [who, one] of [
      ['this page', page],
      ['a second page', other],
    ] as const) {
      const after = await one.list((candidate) => {
        const row = rowIn(candidate, 'parked');
        return (
          row !== undefined &&
          row.state === 'not-running' &&
          !candidate.terminals.some((terminal) => terminal.id === term)
        );
      }, `${who}: S1 under Parked, not running, its terminal closed`);
      assert.equal(rowIn(after, 'open'), undefined, who);
      assert.equal(rowIn(after, 'parked')?.slot ?? null, null, who);
    }
    // Its number is free: the next session resumed takes 1.
    const resumed = await page.act({ kind: 'resume', sessionId: S3, cols: 80, rows: 24 });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    await page.list((candidate) => rowIn(candidate, 'open', S3)?.slot === 1, 'S3 takes 1');
    // One hang-up; the window's end and Claude Code's own, read as a deliberate exit.
    assert.equal(readRecords(d.record).filter((one) => one.ev === 'hup').length, 1);
    await until(() => {
      const ends = d.deck.store.events().filter((one) => one.kind === 'end');
      return (
        ends.some((one) => one.rawDetail === ENDED_IN_WINDOW) &&
        ends.some((one) => one.rawDetail === 'other')
      );
    }, 'the two ends');
    const ended = loadRows(d.deck).find((one) => one.id === S1);
    assert.deepEqual(
      [
        ended?.state,
        ended?.parked,
        ended?.done,
        ended?.marks,
        ended?.session.lastHolding?.endDetail,
      ],
      ['not-running', true, false, [], 'exit'],
    );
    const plan = planRestore(loadRows(d.deck), d.deck.store.events(), OTHER_BOOT, true);
    assert.equal(
      plan.some((entry) => entry.row.id === S1),
      false,
      'restore never offers it',
    );
    // Resumed from its row: it runs under Parked, still parked, with no number.
    const again = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(again.ok, true, JSON.stringify(again));
    const back = await page.list((candidate) => {
      const row = rowIn(candidate, 'parked');
      return row !== undefined && row.state !== 'not-running' && !row.starting;
    }, 'S1 running under Parked');
    assert.equal(rowIn(back, 'parked')?.slot ?? null, null, 'no number');
    assert.equal(rowIn(back, 'open'), undefined);
    assert.notEqual(d.deck.store.meta(S1)?.parkedAtNs ?? null, null, 'still parked');
  });

  test('not ended within the wait: parked, `ended` false, it runs on under Parked without a number; its later end is recorded and its terminal closed', async (t) => {
    const { d, page, list } = await resumedInWindow(t, [S1], {
      env: { SKYDECK_TEST_END_WAIT_MS: '1000' },
    });
    const term = rowIn(list, 'open')?.terminal as string;
    page.send({ t: 'input', term, data: '/hup-late 3\r' });
    await until(() => readRecords(d.record).some((one) => one.ev === 'hup-late'), '/hup-late read');
    const result = await page.act(
      { kind: 'end-session', term, sessionId: S1, mark: 'park' },
      20_000,
    );
    assert.deepEqual([result.ok, result.ended], [true, false], JSON.stringify(result));
    const running = await page.list((candidate) => {
      const row = rowIn(candidate, 'parked');
      return row !== undefined && row.state !== 'not-running';
    }, 'S1 running under Parked');
    assert.equal(rowIn(running, 'parked')?.slot ?? null, null, 'no number');
    await page.list(
      (candidate) =>
        !candidate.terminals.some((one) => one.id === term) &&
        rowIn(candidate, 'parked')?.state === 'not-running',
      'its later end: the terminal closed, S1 not running under Parked',
      15_000,
    );
    await until(
      () => d.deck.store.events().some((one) => one.rawDetail === ENDED_IN_WINDOW),
      'its end recorded as the user asked',
    );
    assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
  });

  test('refused when another page parked it meanwhile: nothing ended, the first time kept; a second request while one waits is refused', async (t) => {
    const { d, other, page, list } = await resumedInWindow(t, [S1, S2]);
    const term = rowIn(list, 'open')?.terminal as string;
    const parked = await other.act({ kind: 'park', sessionId: S1 });
    assert.equal(parked.ok, true, JSON.stringify(parked));
    await page.list((candidate) => rowIn(candidate, 'parked') !== undefined, 'S1 under Parked');
    const first = d.deck.store.meta(S1)?.parkedAtNs;
    const refused = await page.act({ kind: 'end-session', term, sessionId: S1, mark: 'park' });
    assert.deepEqual([refused.ok, refused.error], [false, 'it was parked meanwhile']);
    assert.equal(d.deck.store.meta(S1)?.parkedAtNs, first);
    assert.equal(readRecords(d.record).filter((one) => one.ev === 'hup').length, 0);
    // S2: two requests at once, one hang-up.
    const term2 = rowIn(list, 'open', S2)?.terminal as string;
    const waiting = page.act(
      { kind: 'end-session', term: term2, sessionId: S2, mark: 'park' },
      20_000,
    );
    const second = await page.act({
      kind: 'end-session',
      term: term2,
      sessionId: S2,
      mark: 'park',
    });
    assert.deepEqual([second.ok, second.error], [false, 'skydeck is ending this session already']);
    assert.equal((await waiting).ended, true);
    assert.equal(readRecords(d.record).filter((one) => one.ev === 'hup').length, 1);
  });
});
