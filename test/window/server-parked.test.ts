// F44 (S2 12.1, 12.4, 12.15) on the window's real server: a session's parking, written as the
// command writes it (the test's own connection to the store, which is not the server's), reaches
// every page within a refresh; a parked session is quiet (no `notify`, in no `needYou`); and a
// prompt of the user's in its transcript brings it back by itself. In the test process (A19) on
// realTestPlatform, with real keepers running the stand-in. Every wait is for a fact (a list, a
// message), never for a time.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { isoFromNs } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { markParked } from '../../src/sessions/meta.ts';
import type { ListMessage, NotifyMessage, RowPayload } from '../../src/window/protocol.ts';
import { until } from '../helpers/keeper.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { connectTestPage, rowsOf, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return rowsOf(list).find((row) => row.id === sessionId);
}

/** The name of the section that draws `sessionId`'s row in `list`, null when none does. */
function sectionOf(list: ListMessage, sessionId: string): string | null {
  return (
    list.sections.find((section) => section.rows.some((row) => row.id === sessionId))?.name ?? null
  );
}

/** Parks `sessionId` as `skydeck park` does: `markParked` over the rows of the test's own
 *  connection (another connection than the server's). */
function parkAsTheCommand(d: ServerSandbox, sessionId: string): void {
  const row = loadRows(d.deck).find((one) => one.id === sessionId);
  assert.ok(row !== undefined, `${sessionId} is a row of the store`);
  assert.equal(markParked(d.deck, row), true, 'written');
}

/** The parking time the store holds for `sessionId`. */
function parkedAt(d: ServerSandbox, sessionId: string): Ns {
  const meta = d.deck.store.meta(sessionId);
  assert.ok(meta?.parkedAtNs !== null && meta?.parkedAtNs !== undefined, 'a parking stored');
  return meta.parkedAtNs;
}

/** A line to the stand-in of window terminal `term` through the hub: no page types it. */
function say(test: TestServer, term: string, line: string): void {
  assert.equal(test.server.hub.input(term, Buffer.from(`${line}\r`, 'utf8')), 'ok');
}

/**
 * Resumes `sessionId` in a window terminal from `page`, attaches to it and waits for the
 * stand-in's prompt (a line said before it would meet a pty not yet raw). The terminal's id.
 */
async function resumed(page: TestPage, test: TestServer, sessionId: string): Promise<string> {
  const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const term = test.server.hub.list().find((info) => info.expectedSessionId === sessionId)?.id;
  assert.ok(term !== undefined, 'its terminal');
  page.send({ t: 'attach', term, cols: 80, rows: 24 });
  let snap = await page.next('snap', 'the snap');
  while (snap.term !== term) snap = await page.next('snap', 'the snap');
  const prompt = `standin ${sessionId.slice(0, 8)}> `;
  const { ch, data } = snap;
  await until(
    () => (data + page.output(ch)).includes(prompt),
    () => `${JSON.stringify(prompt)} in ${JSON.stringify(page.output(ch).slice(-300))}`,
    WAIT_MS,
  );
  return term;
}

let pings = 9100;

/** A ping and its pong: everything the server sent before it is in `page.all` afterwards. */
async function roundTrip(page: TestPage): Promise<void> {
  const n = ++pings;
  page.send({ t: 'ping', n });
  for (;;) {
    const pong = await page.next('pong', `the pong ${n}`);
    if (pong.n === n) return;
  }
}

let probes = 0;

/** A refresh that ran, as a fact: a new resumable session the next refresh's scan finds, listed. */
async function aRefresh(d: ServerSandbox, page: TestPage): Promise<void> {
  const probe = `00000000-0000-4000-8000-${String(++probes).padStart(12, '0')}`;
  d.resumable(probe);
  await page.list((list) => rowOf(list, probe) !== undefined, `the refresh that lists ${probe}`);
}

/** The last `list` the page got. */
function latest(page: TestPage): ListMessage {
  const lists = page.all.flatMap((item) =>
    'text' in item && item.text.t === 'list' ? [item.text] : [],
  );
  const last = lists.at(-1);
  assert.ok(last !== undefined, 'a list');
  return last;
}

/** Every `notify` the page got so far. */
function notifies(page: TestPage): NotifyMessage[] {
  return page.all.flatMap((item) =>
    'text' in item && item.text.t === 'notify' ? [item.text] : [],
  );
}

// ---------------------------------------------------------------------------------------------

describe('a parking written outside the window (S2 12.1, 12.15)', () => {
  test('shows within a refresh on two pages: under Parked, with its time, in no other section', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const a = await connectTestPage(t, d, test.server);
    const b = await connectTestPage(t, d, test.server);
    for (const page of [a, b]) {
      await page.list((list) => sectionOf(list, S1) === 'week', 'S1 under Recent');
    }
    parkAsTheCommand(d, S1);
    const at = String(parkedAt(d, S1));
    for (const page of [a, b]) {
      const list = await page.list((one) => sectionOf(one, S1) === 'parked', 'S1 under Parked');
      assert.deepEqual(
        list.sections.map((section) => section.name),
        ['open', 'parked', 'week', 'earlier'],
      );
      assert.equal(rowOf(list, S1)?.parked, true);
      assert.equal(rowOf(list, S1)?.parkedAtNs, at);
      assert.deepEqual(
        list.sections.find((section) => section.name === 'parked')?.rows.map((row) => row.id),
        [S1],
      );
      assert.equal(sectionOf(list, S2), 'week', 'S2 stays where it was');
    }
  });

  test("a prompt in a parked session's transcript, outside the window, brings it back by itself, to Recent (it does not run)", async (t) => {
    const d = serverSandbox(t);
    const dir = d.resumable(S2);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.list((list) => sectionOf(list, S2) === 'week', 'S2 under Recent');
    parkAsTheCommand(d, S2);
    await page.list((list) => sectionOf(list, S2) === 'parked', 'S2 under Parked');
    // The user's own prompt, dated after the parking, as Claude Code appends it.
    const after = parkedAt(d, S2) + 1_000_000_000n;
    appendFileSync(
      join(d.s.claudeHome, 'projects', 'project', `${S2}.jsonl`),
      `${JSON.stringify({ type: 'user', sessionId: S2, timestamp: isoFromNs(after), cwd: dir, entrypoint: 'cli' })}\n`,
    );
    const back = await page.list(
      (list) => sectionOf(list, S2) === 'week',
      'S2 back under Recent by itself',
    );
    assert.equal(rowOf(back, S2)?.parked, false);
    assert.equal(rowOf(back, S2)?.parkedAtNs, null);
    // The stored time stays; the row is no longer parked because of the prompt.
    assert.equal(d.deck.store.meta(S2)?.parkedAtNs, parkedAt(d, S2));
  });
});

describe('a parked session is quiet (S2 12.4, 13)', () => {
  test('with no page focused: a session that starts to ask gets its notify (the control); parked, starting to ask again gets none, its mark shows and it is in no needYou', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server, { focused: false });
    const term = await resumed(page, test, S1);

    // The control: not parked, no page focused, so `notify` is sent.
    say(test, term, '/waiting the first question');
    const notified = await page.next('notify', 'the notify of the control');
    assert.equal(notified.sessionId, S1);
    assert.equal(notified.reason, 'asks');
    say(test, term, '/busy');
    await page.list(
      (list) => rowOf(list, S1) !== undefined && rowOf(list, S1)?.attention === null,
      'S1 no longer asks',
    );

    parkAsTheCommand(d, S1);
    const parked = await page.list(
      (list) => sectionOf(list, S1) === 'parked',
      'S1 under Parked while it runs',
    );
    assert.notEqual(rowOf(parked, S1)?.state, 'not-running', 'it runs');
    assert.equal(rowOf(parked, S1)?.slot, null, 'no number on its row');
    assert.equal(
      parked.terminals.find((one) => one.id === term)?.slot,
      null,
      'nor on its terminal in the list',
    );

    say(test, term, '/waiting the second question');
    const asking = await page.list(
      (list) => rowOf(list, S1)?.attention?.reason === 'asks',
      'S1 asks, parked',
    );
    assert.equal(sectionOf(asking, S1), 'parked');
    assert.equal(rowOf(asking, S1)?.needsYou, false);
    assert.deepEqual(asking.needYou, { count: 0, order: [] });
    // Two more refreshes and everything the server sent before them: still one notify.
    await aRefresh(d, page);
    await aRefresh(d, page);
    await roundTrip(page);
    assert.deepEqual(
      notifies(page).map((message) => [message.sessionId, message.reason]),
      [[S1, 'asks']],
      'only the control was notified',
    );
  });
});

describe('the acts park and unpark (S2 8.2.3, 12.15)', () => {
  test("page A's park is in page B's next list, and its unpark too; a second park answers ok and keeps the first time", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const a = await connectTestPage(t, d, test.server);
    const b = await connectTestPage(t, d, test.server);
    for (const page of [a, b]) {
      await page.list((list) => sectionOf(list, S1) === 'week', 'S1 under Recent');
    }
    const parked = await a.act({ kind: 'park', sessionId: S1 });
    assert.deepEqual(
      { ok: parked.ok, lines: parked.lines, error: parked.error, sessionId: parked.sessionId },
      { ok: true, lines: [], error: null, sessionId: null },
    );
    const at = String(parkedAt(d, S1));
    for (const page of [a, b]) {
      const list = await page.list((one) => sectionOf(one, S1) === 'parked', 'S1 under Parked');
      assert.equal(rowOf(list, S1)?.parkedAtNs, at);
    }
    const again = await b.act({ kind: 'park', sessionId: S1 });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(String(parkedAt(d, S1)), at, 'the first time is kept');

    const unparked = await b.act({ kind: 'unpark', sessionId: S1 });
    assert.equal(unparked.ok, true, JSON.stringify(unparked));
    for (const page of [a, b]) {
      const list = await page.list((one) => sectionOf(one, S1) === 'week', 'S1 back');
      assert.equal(rowOf(list, S1)?.parked, false);
    }
    assert.equal(d.deck.store.meta(S1)?.parkedAtNs, null);
  });

  test('the mark survives a restart of the server', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const first = await d.start();
    const page = await connectTestPage(t, d, first.server);
    await page.list((list) => sectionOf(list, S1) === 'week', 'S1 under Recent');
    assert.equal((await page.act({ kind: 'park', sessionId: S1 })).ok, true);
    await page.list((list) => sectionOf(list, S1) === 'parked', 'S1 under Parked');
    await first.server.stop('the test restarts the server');
    const second = await d.start();
    const later = await connectTestPage(t, d, second.server);
    const list = await later.list((one) => rowOf(one, S1) !== undefined, "the new server's list");
    assert.equal(sectionOf(list, S1), 'parked');
    assert.equal(rowOf(list, S1)?.parkedAtNs, String(parkedAt(d, S1)));
  });

  test('a parked session resumed from its row runs under Parked, still parked, with no number shown', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.list((list) => sectionOf(list, S1) === 'week', 'S1 under Recent');
    assert.equal((await page.act({ kind: 'park', sessionId: S1 })).ok, true);
    await page.list((list) => sectionOf(list, S1) === 'parked', 'S1 under Parked');
    const term = await resumed(page, test, S1);
    const running = await page.list(
      (list) => rowOf(list, S1)?.state !== 'not-running' && rowOf(list, S1) !== undefined,
      'S1 runs',
    );
    assert.equal(sectionOf(running, S1), 'parked');
    assert.equal(rowOf(running, S1)?.parked, true);
    assert.equal(rowOf(running, S1)?.slot, null);
    assert.equal(rowOf(running, S1)?.terminal, term);
    assert.equal(running.terminals.find((one) => one.id === term)?.slot, null);
    // A key typed into it and not sent does not end the parking (the stand-in writes no prompt).
    assert.equal(test.server.hub.input(term, Buffer.from('typed, not sent', 'utf8')), 'ok');
    await aRefresh(d, page);
    await aRefresh(d, page);
    await roundTrip(page);
    const still = latest(page);
    assert.equal(sectionOf(still, S1), 'parked');
  });
});
