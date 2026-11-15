// Attention end to end on the window's server (S2 10.1, 10.3, 12.4, 13, 14, 8.2.7; plan B task 54,
// B9–B12, B20): real turn ends of the stand-in in window terminals and outside the window, seen by a
// focused page's selection and by typing, window ends of a terminal whose program failed and of one
// whose keeper was lost, `notify` to the page that had focus last, a restart, a busy store and a
// migrated one. In the test process (A19) on realTestPlatform, with real keepers running the
// stand-in. Every wait is for a fact (a list, a record, a process gone, a refresh that listed a new
// session), never for a time: the one-second look and the two-second refresh are held by
// test/window/tick.test.ts.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import { readLiveFiles } from '../../src/claude/live.ts';
import type { Platform } from '../../src/platform/types.ts';
import { setLabel } from '../../src/sessions/meta.ts';
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import type { AttentionRow } from '../../src/store/types.ts';
import type { ListMessage, NotifyMessage, RowPayload } from '../../src/window/protocol.ts';
import { SEEN_AFTER_MS } from '../../src/window/seen.ts';
import {
  procStartOf,
  sleep,
  startProgram,
  stillRuns,
  typeLine,
  until,
  within,
} from '../helpers/keeper.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { serverKeepers } from '../helpers/registry.ts';
import { spoolName, spoolText, hookInput } from '../helpers/spool.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import { connectTestPage, rowsOf, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return rowsOf(list).find((row) => row.id === sessionId);
}

/** The reason `sessionId` needs you in `list` (null: it needs nothing, or is not listed). */
function reasonOf(list: ListMessage, sessionId: string): string | null {
  return rowOf(list, sessionId)?.attention?.reason ?? null;
}

/** What the store holds of `sessionId`, read on the test's own connection. */
function stored(d: ServerSandbox, sessionId: string): AttentionRow | undefined {
  return d.deck.store.attention().find((row) => row.sessionId === sessionId);
}

/** The attention counter: the last value a write was given (S2 10.2). */
function counter(d: ServerSandbox): string | null {
  return d.deck.store.getKv('attention_seq');
}

/** The page's selection and focus as the page sends them: `view` with the selection, then `focus`. */
function show(page: TestPage, focused: boolean, selected: string | null): void {
  page.view({ selected });
  page.send({ t: 'focus', focused, selected, area: { cols: 80, rows: 24 } });
}

/** A line to the stand-in of window terminal `term` through the hub: no page types it. */
function say(test: TestServer, term: string, line: string): void {
  assert.equal(test.server.hub.input(term, Buffer.from(`${line}\r`, 'utf8')), 'ok');
}

/**
 * Resumes `sessionId` in a window terminal from `page`, attaches to it and waits for the
 * stand-in's prompt (typed input before it would meet a pty not yet raw). The terminal's id.
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

/**
 * A turn that ends in the stand-in of `term` and that the server's looks see: `/waiting` first,
 * shown as `asks` (so a look has read it), then `/idle`. A look between the two is what makes it a
 * turn end (S2 10.3); `/busy` alone shows nothing a test could wait for.
 */
async function endTurn(
  page: TestPage,
  test: TestServer,
  term: string,
  sessionId: string,
  detail = 'a question',
): Promise<void> {
  say(test, term, `/waiting ${detail}`);
  await page.list((list) => reasonOf(list, sessionId) === 'asks', `${sessionId} asks`);
  say(test, term, '/idle');
}

let pings = 7000;

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

/**
 * A refresh that ran, as a fact, not a time: a new resumable session the next refresh's scan finds,
 * and a list to `page` with its row. The server runs in this process (A19) and a refresh with its
 * judgements and checks is one synchronous step, so all of that refresh is done once its list is
 * here, and everything the server sent `page` before it has come.
 */
async function aRefresh(d: ServerSandbox, page: TestPage): Promise<void> {
  const probe = `00000000-0000-4000-8000-${String(++probes).padStart(12, '0')}`;
  d.resumable(probe);
  await page.list((list) => rowOf(list, probe) !== undefined, `the refresh that lists ${probe}`);
}

/** Every `notify` the page got so far. */
function notifies(page: TestPage): NotifyMessage[] {
  return page.all.flatMap((item) =>
    'text' in item && item.text.t === 'notify' ? [item.text] : [],
  );
}

/** Every `list` the page got so far. */
function lists(page: TestPage): ListMessage[] {
  return page.all.flatMap((item) => ('text' in item && item.text.t === 'list' ? [item.text] : []));
}

/** Another process's write lock on the sandbox's store (the fixture's BEGIN IMMEDIATE in a worker). */
function holdWriteLock(t: TestContext, d: ServerSandbox): { held: Promise<void>; release(): void } {
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const holder = new Worker(new URL('../fixtures/hold-write-lock.ts', import.meta.url), {
    workerData: { path: d.deck.places.dbPath, signal },
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

/** `text` as one word of a `sh` script. */
const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

// ---------------------------------------------------------------------------------------------

describe('a turn end in a window terminal (S2 10.3, 12.4)', () => {
  test('while a focused page selects another session: asks with its detail, gone at busy; finished at idle, counted and stored; selected unfocused it stays; focused it is cleared after 1.5 s, seen stored later', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server, { view: { selected: S2 } });
    show(page, true, S2);
    const term = await resumed(page, test, S1);

    say(test, term, '/waiting permission prompt');
    const asking = await page.list((list) => reasonOf(list, S1) === 'asks', 'S1 asks');
    assert.equal(rowOf(asking, S1)?.attention?.detail, 'permission prompt');
    say(test, term, '/busy');
    await page.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'S1 no longer asks',
    );
    say(test, term, '/idle');
    const finished = await page.list((list) => reasonOf(list, S1) === 'finished', 'S1 finished');
    assert.deepEqual(finished.needYou, { count: 1, order: [S1] });
    const ended = stored(d, S1);
    assert.ok(ended?.turnEndedSeq !== null && ended?.turnEndedSeq !== undefined, 'a turn end');
    assert.equal(ended.seenSeq, null);

    // Selected in a page that has no focus: nothing is seen. Once the server has the focus (the
    // round trip), a hold it started would end SEEN_AFTER_MS later on a timer of this process; the
    // test's own timer of that length is set after it, so it fires after it — and the next round
    // trip brings any list that hold pushed.
    const before = lists(page).length;
    show(page, false, S1);
    await roundTrip(page);
    await sleep(SEEN_AFTER_MS);
    await roundTrip(page);
    assert.ok(
      lists(page)
        .slice(before)
        .every((list) => reasonOf(list, S1) === 'finished'),
      'still finished in every list',
    );
    assert.equal(stored(d, S1)?.seenSeq, null, 'no seen stored');

    // Focused with it selected: seen after the hold, written at once when the hold ends (Seen's
    // listener, `seenNow`), not at the next look: the hold ends on a timer of this process set
    // before the test's own of the same length.
    const from = performance.now();
    show(page, true, S1);
    await roundTrip(page);
    await sleep(SEEN_AFTER_MS);
    const held = stored(d, S1);
    assert.ok((held?.seenSeq ?? 0) > (held?.turnEndedSeq ?? Infinity), 'seen when the hold ended');
    await page.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'the mark cleared',
    );
    assert.ok(performance.now() - from >= 1500, 'not before the 1.5 s');
    const seen = stored(d, S1);
    assert.ok((seen?.seenSeq ?? 0) > (seen?.turnEndedSeq ?? Infinity), 'seen after the turn end');
  });

  test('a turn that ends while the focused page holds the session is never finished, and its one write holds seen = turn + 1; typing into the terminal clears a mark at once, with no page focused', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server, { view: { selected: S2 } });
    show(page, true, S2);
    const term = await resumed(page, test, S1);
    await endTurn(page, test, term, S1);
    await page.list((list) => reasonOf(list, S1) === 'finished', 'S1 finished');
    show(page, true, S1);
    await page.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'the hold completed',
    );

    // The hold lasts: a turn that ends now is seen in the same write.
    const before = lists(page).length;
    const first = stored(d, S1)?.turnEndedSeq;
    await endTurn(page, test, term, S1, 'another question');
    await until(() => stored(d, S1)?.turnEndedSeq !== first, 'the second turn end stored', WAIT_MS);
    await roundTrip(page);
    const held = stored(d, S1);
    assert.ok(held?.turnEndedSeq !== null && held?.turnEndedSeq !== undefined);
    assert.equal(held.seenSeq, held.turnEndedSeq + 1, 'seen = turn + 1, one write');
    assert.ok(
      lists(page)
        .slice(before)
        .every((list) => reasonOf(list, S1) !== 'finished'),
      'never finished in any list',
    );

    // No page has focus: only a typing can clear it.
    show(page, false, S1);
    await endTurn(page, test, term, S1, 'a third question');
    await page.list((list) => reasonOf(list, S1) === 'finished', 'S1 finished again');
    const unseen = stored(d, S1);
    page.send({ t: 'input', term, data: 'x' });
    // Written on the input path itself (Seen's listener, `seenNow`), not at the next look.
    await roundTrip(page);
    assert.ok(
      (stored(d, S1)?.seenSeq ?? 0) > (unseen?.turnEndedSeq ?? Infinity),
      'seen once the input was taken',
    );
    await page.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'cleared by the typing',
    );
    assert.ok((stored(d, S1)?.seenSeq ?? 0) > (unseen?.turnEndedSeq ?? Infinity));
  });

  test('a session the test runs outside the window: its turn ends are recorded too', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1); // the keeper sandbox's spec runs the stand-in for S1
    const test = await d.start();
    const own = await d.box.start(); // after the server's rediscovery: no terminal of the window
    const { client } = await startProgram(own);
    const page = await connectTestPage(t, d, test.server);
    await page.list(
      (list) => rowOf(list, S1)?.elsewhere !== null && rowOf(list, S1) !== undefined,
      'S1 elsewhere',
    );
    await typeLine(client, '/waiting a question');
    await page.list((list) => reasonOf(list, S1) === 'asks', 'S1 asks');
    await typeLine(client, '/idle');
    const finished = await page.list((list) => reasonOf(list, S1) === 'finished', 'S1 finished');
    assert.equal(finished.needYou.count, 1);
    assert.notEqual(stored(d, S1)?.turnEndedSeq ?? null, null);
    assert.deepEqual(test.server.hub.list(), [], 'no terminal of the window');
  });
});

describe('window ends (S2 12.4 reason 2, 14; B10)', () => {
  test("/fail 3: ended after the next refresh, stored at the exit's time, one notify; /exit: no window end", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server, { focused: false });
    const failing = await resumed(page, test, S1);
    const leaving = await resumed(page, test, S2);

    say(test, failing, '/fail 3');
    const ended = await page.list((list) => reasonOf(list, S1) === 'ended', 'S1 ended');
    const end = stored(d, S1);
    assert.ok(end?.windowEndSeq !== null && end?.windowEndSeq !== undefined, 'a window end');
    const exit = test.server.hub.list().find((info) => info.id === failing)?.exit;
    assert.equal(exit?.code, 3);
    assert.equal(end.windowEndNs, BigInt(exit.atNs), "the end is the exit's time");
    const notified = await page.next('notify', 'the notify');
    assert.deepEqual(notified, {
      t: 'notify',
      sessionId: S1,
      title: rowOf(ended, S1)?.title,
      reason: 'ended',
      detail: null,
    });

    say(test, leaving, '/exit');
    await until(
      () => test.server.hub.list().find((info) => info.id === leaving)?.state === 'ended',
      'the second terminal ended',
      WAIT_MS,
    );
    await page.list((list) => rowOf(list, S2)?.state === 'not-running', 'S2 no longer runs');
    const seq = counter(d);
    await aRefresh(d, page); // a refresh with S2's row not running and its holder gone: judged
    await aRefresh(d, page);
    assert.equal(stored(d, S2), undefined, 'an end the user chose is no window end');
    assert.equal(counter(d), seq, 'and nothing else was written');
    assert.equal(reasonOf(lists(page).at(-1) as ListMessage, S2), null);
    assert.deepEqual(
      notifies(page).map((message) => message.sessionId),
      [S1],
      'one notify, for S1',
    );
  });

  test('a program that fails while no server runs: the next server finds its keeper lingering and marks it once, without notify; the server after finds the mark as before, still one, and notifies nothing', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const first = await d.start();
    const page = await connectTestPage(t, d, first.server, { focused: false });
    const term = await resumed(page, first, S1);
    // The stand-in reads nothing for 12 s, then the `/fail 3` that waits in its pty: it fails
    // after the server below is stopped, and its keeper lingers with the exit (S2 7.8).
    say(first, term, '/stall 12');
    say(first, term, '/fail 3');
    await until(() => page.output(1).includes('stalling 12 s'), 'the stall', WAIT_MS);
    await first.server.stop('the test restarts the server');
    await waitForRecord(
      d.record,
      (entry) => entry.ev === 'exit' && entry.code === 3,
      WAIT_MS + 12_000,
    );
    const before = counter(d);

    const second = await d.start();
    const next = await connectTestPage(t, d, second.server, { focused: false });
    const ended = await next.list(
      (list) => reasonOf(list, S1) === 'ended' && list.terminals[0]?.state === 'ended',
      'S1 ended, its terminal found',
    );
    const end = stored(d, S1);
    assert.equal(Number(counter(d)), Number(before ?? '0') + 1, 'one window end');
    const found = second.server.hub.list()[0];
    assert.ok(found?.exit !== null && found?.exit !== undefined && end !== undefined);
    assert.equal(end.windowEndNs, BigInt(found.exit.atNs), "the keeper's exit time");
    await aRefresh(d, next); // refreshes and looks, each followed by the notifier's check
    await aRefresh(d, next);
    assert.deepEqual(notifies(next), [], 'the first judgement notifies nothing (B12)');
    assert.equal(rowOf(ended, S1)?.attention?.reason, 'ended');

    await second.server.stop('the test restarts the server again');
    const third = await d.start();
    const last = await connectTestPage(t, d, third.server, { focused: false });
    await last.list((list) => reasonOf(list, S1) === 'ended', 'S1 still ended');
    await aRefresh(d, last);
    await aRefresh(d, last);
    assert.equal(Number(counter(d)), Number(before ?? '0') + 1, 'still one');
    assert.deepEqual(stored(d, S1), end, 'the mark as before');
    assert.deepEqual(notifies(last), [], 'what needed you before the restart notifies nothing');
  });

  test('a lost keeper whose program lives on and then ends: the terminal lost, no end while the program lives, then one window end at the lost exit, ended, one notify', async (t) => {
    // The program is a `sh` that outlives the hangup of its pty until the test releases it, and so
    // does its child, the stand-in that holds the session (task 57's way).
    let release = '';
    let killOwnKeeper: (() => void) | null = null;
    let record = '';
    // Registered before serverSandbox's cleanup, so it runs first (t.after: first in, first out):
    // also when the case fails half way, the keeper is gone, the `sh` released and the holder's
    // last hook written before the keepers' box waits for the program and the sandbox goes.
    t.after(async () => {
      if (release === '') return;
      writeFileSync(release, '');
      try {
        killOwnKeeper?.();
      } catch {
        // It no longer runs.
      }
      if (record !== '') {
        await waitForRecord(record, (entry) => entry.ev === 'exit', 10_000).catch(() => {});
      }
    });
    const keepers = serverKeepers();
    const d = serverSandbox(t);
    record = d.record;
    d.s.link('sleep');
    release = join(d.s.root, 'release-54');
    const script = join(d.s.bin, 'claude-outlives-hangup');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `release=${shellWord(release)}`,
        `root=${shellWord(d.s.root)}`,
        // 200 rounds (20 s and more), and not past the sandbox; the hook above releases it.
        'trap \'n=0; while [ ! -e "$release" ] && [ -d "$root" ] && [ "$n" -lt 200 ]; do sleep 0.1; n=$((n + 1)); done; exit 129\' HUP',
        'exec 3<&0',
        `${shellWord(d.standin)} "$@" <&3 3<&- &`,
        'wait "$!"',
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    const config = join(d.s.skydeckHome, 'config', 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        ...(JSON.parse(readFileSync(config, 'utf8')) as object),
        claudeCommand: script,
      }),
    );
    d.resumable(S1);
    const test = await d.start({ platform: keepers.platform });
    const page = await connectTestPage(t, d, test.server, { focused: false });
    const term = await resumed(page, test, S1);
    const holder = readRecords(record).find(
      (entry) => entry.ev === 'start' && entry.argv.includes(S1),
    )?.pid;
    const program = test.server.hub.list().find((info) => info.id === term)?.program?.pid;
    assert.ok(holder !== undefined && program !== undefined && holder !== program);
    const holderStart = procStartOf(holder);
    assert.ok(holderStart !== null);
    await page.list(
      (list) => rowOf(list, S1) !== undefined && rowOf(list, S1)?.state !== 'not-running',
      'S1 held',
    );

    // Only the keeper this test's server started, by the pid of its own record.
    const keeper = keepers.keeperOf(d.files, term);
    killOwnKeeper = () => {
      keepers.signalKeeper(keeper, 'SIGKILL');
    };
    keepers.signalKeeper(keeper, 'SIGKILL');
    killOwnKeeper = null;
    await page.list(
      (list) => list.terminals.find((info) => info.id === term)?.state === 'lost',
      'the terminal lost',
    );
    await aRefresh(d, page); // refreshes while the program lives on (checked below: still alive)
    await aRefresh(d, page);
    assert.deepEqual(
      readRecords(record).filter(
        (entry) => entry.pid === holder && (entry.ev === 'hup' || entry.ev === 'exit'),
      ),
      [],
      'the holder still lives',
    );
    assert.equal(stored(d, S1)?.windowEndSeq ?? null, null, 'no end while the program lives');
    assert.deepEqual(notifies(page), []);

    writeFileSync(release, '');
    await waitForRecord(record, (entry) => entry.ev === 'exit' && entry.pid === holder, WAIT_MS);
    // `ended-unexpectedly` needs the holder's process gone, not only its end ingested.
    await until(() => !stillRuns(holder, holderStart), 'the holder is gone', WAIT_MS);
    const ended = await page.list((list) => reasonOf(list, S1) === 'ended', 'S1 ended');
    const lost = test.server.hub.list().find((info) => info.id === term);
    assert.equal(lost?.state, 'lost', 'the terminal stays, lost');
    assert.deepEqual([lost.exit?.code, lost.exit?.signal], [null, 1], 'its exit the lost one');
    const end = stored(d, S1);
    assert.ok(end !== undefined && lost.exit !== null);
    assert.equal(end.windowEndNs, BigInt(lost.exit.atNs), "the end at the lost exit's time");
    const notified = await page.next('notify', 'the notify');
    assert.equal(notified.reason, 'ended');
    assert.equal(notified.title, rowOf(ended, S1)?.title);

    const seq = counter(d);
    await aRefresh(d, page); // two more refreshes judge nothing again
    await aRefresh(d, page);
    assert.equal(counter(d), seq, 'one window end');
    assert.equal(notifies(page).length, 1, 'one notify');
  });
});

describe('several pages (S2 8.2.7, 13; B20)', () => {
  test('the second page sees the same marks; a seen in the first clears them in both; notify goes only to the page that had focus last, and to none while one has focus', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const a = await connectTestPage(t, d, test.server, { view: { selected: S2 } });
    const term = await resumed(a, test, S1);
    const b = await connectTestPage(t, d, test.server, { view: { selected: S2 } }); // focused after a
    show(a, false, S2);
    show(b, false, S2);
    await roundTrip(a);
    await roundTrip(b);

    say(test, term, '/waiting which file');
    await a.list((list) => reasonOf(list, S1) === 'asks', 'a: S1 asks');
    await b.list((list) => reasonOf(list, S1) === 'asks', 'b: S1 asks');
    const notified = await b.next('notify', "b's notify");
    assert.equal(notified.reason, 'asks');
    assert.equal(notified.detail, 'which file');
    say(test, term, '/idle');
    const inA = await a.list((list) => reasonOf(list, S1) === 'finished', 'a: S1 finished');
    const inB = await b.list((list) => reasonOf(list, S1) === 'finished', 'b: S1 finished');
    assert.deepEqual(rowOf(inB, S1)?.attention, rowOf(inA, S1)?.attention, 'the same marks');

    show(a, true, S1); // a seen in the first page
    await a.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'a: cleared',
    );
    await b.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'b: cleared',
    );

    // One page has focus: nothing is notified.
    show(a, true, S2);
    await roundTrip(a);
    await endTurn(a, test, term, S1, 'one more question');
    await a.list((list) => reasonOf(list, S1) === 'finished', 'a: finished again');
    await b.list((list) => reasonOf(list, S1) === 'finished', 'b: finished again');
    await roundTrip(a);
    await roundTrip(b);
    assert.deepEqual(notifies(a), [], 'a never got one');
    assert.deepEqual(
      notifies(b).map((message) => message.reason),
      ['asks'],
      'b got only the one while no page had focus',
    );
  });
});

describe('the start, the store (S2 10.1, 13, 14; B1, B11, B12)', () => {
  test('a session that needed you before the start, a turn that ended while no server ran, and a first refresh that fails: once a refresh works, finished for the one, nothing for the other, and no notify', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const first = await d.start();
    const page = await connectTestPage(t, d, first.server);
    await resumed(page, first, S2); // a window terminal: its keeper lingers across the restart
    const own = await d.box.start(); // S1 outside the window, started after the rediscovery
    const { client } = await startProgram(own);
    await first.server.stop('the test restarts the server');

    // While no server runs: S1's turn ends; S2 finished, written as a server would have.
    await typeLine(client, '/busy');
    await typeLine(client, '/idle');
    client.socket.destroy(); // the next server claims the keeper
    const idle = readLiveFiles(d.platform.files, d.s.claudeHome).find(
      (file) => file.sessionId === S2,
    );
    assert.ok(idle?.status === 'idle' && idle.statusUpdatedAtNs !== null);
    d.deck.store.recordAttention([{ sessionId: S2, turnEndedNs: idle.statusUpdatedAtNs }]);

    // The seam (ruled, review B's re-check): a process only the store's events name, whose /proc
    // read fails while `held` — the rows cannot be loaded, so every refresh fails until released.
    const ghost = 4_194_301;
    const bootId = d.platform.proc.bootId();
    assert.ok(bootId !== null);
    const fields = {
      event: 'SessionStart' as const,
      timeNs: d.platform.clock.nowNs() - 60_000_000_000n,
      pid: ghost,
      input: hookInput('SessionStart', S3, { source: 'startup' }),
      bootId,
    };
    writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
    let held = true;
    const holding = (p: Platform): Platform => ({
      ...p,
      proc: {
        ...p.proc,
        stat: (pid) => {
          if (held && pid === ghost) throw Object.assign(new Error('EIO'), { code: 'EIO' });
          return p.proc.stat(pid);
        },
      },
    });
    const second = await d.start({ platform: holding });
    const next = await connectTestPage(t, d, second.server, { focused: false });
    await roundTrip(next);
    assert.ok(
      second.logs().some((line) => line.includes(' tick: the refresh failed (Error (EIO))')),
      second.logs().join('\n'),
    );
    assert.ok(
      lists(next).length > 0 && lists(next).every((list) => rowsOf(list).length === 0),
      'no rows yet',
    );

    held = false;
    const listed = await next.list(
      (list) => reasonOf(list, S2) === 'finished' && rowOf(list, S1) !== undefined,
      'S2 finished once a refresh works',
    );
    assert.equal(reasonOf(listed, S1), null, 'a turn that ended while no server ran');
    assert.equal(stored(d, S1), undefined);
    await roundTrip(next);
    assert.deepEqual(notifies(next), [], 'what needed you already notifies nothing');
  });

  test('a store another skydeck keeps locked at a turn end: recorded once when the lock is gone; no log line holds a title or a detail', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    setLabel(d.deck, S1, 'title-marker-54');
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server, { focused: false });
    const term = await resumed(page, test, S1);
    say(test, term, '/waiting detail-marker-54');
    await page.list((list) => reasonOf(list, S1) === 'asks', 'S1 asks');
    const notified = await page.next('notify', 'the notify');
    assert.equal(notified.title, 'title-marker-54');
    assert.equal(notified.detail, 'detail-marker-54');
    const before = counter(d);

    const lock = holdWriteLock(t, d);
    await lock.held;
    say(test, term, '/idle');
    await until(
      () => test.logs().some((line) => line.includes('the writes are kept for the next look')),
      'the write kept',
      WAIT_MS,
    );
    assert.equal(counter(d), before, 'nothing written while locked');
    lock.release();
    await page.list((list) => reasonOf(list, S1) === 'finished', 'S1 finished once free');
    assert.equal(Number(counter(d)), Number(before ?? '0') + 1, 'one value given: recorded once');
    assert.equal(stored(d, S1)?.turnEndedSeq, Number(counter(d)));
    await aRefresh(d, page); // each tick looks before its refresh: more looks, the kept write gone
    await aRefresh(d, page);
    assert.equal(Number(counter(d)), Number(before ?? '0') + 1, 'and not again');
    const marked = test.logs().filter((line) => line.includes('marker-54'));
    assert.deepEqual(marked, [], 'no title, no detail in the log');
  });

  test('a store migrated by another connection: the turn end is refused, bye with the update text, nothing written', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const own = await d.box.start(); // outside the window: the turn end is the only write
    const { client } = await startProgram(own);
    const page = await connectTestPage(t, d, test.server);
    await typeLine(client, '/waiting a question');
    await page.list((list) => reasonOf(list, S1) === 'asks', 'S1 asks');
    const db = new DatabaseSync(d.deck.places.dbPath);
    db.prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();
    // A refresh after the migration that has nothing to write (a live file changed: the rows are
    // loaded again, `working`), and a look that sees `busy`: no bye before the turn end.
    await typeLine(client, '/busy');
    await page.list(
      (list) => rowOf(list, S1)?.state === 'working' && reasonOf(list, S1) === null,
      'S1 working',
    );
    await roundTrip(page);
    assert.equal(
      page.all.some((item) => 'text' in item && item.text.t === 'bye'),
      false,
      'no bye yet',
    );
    await typeLine(client, '/idle');
    const bye = await page.next('bye', 'the bye', WAIT_MS);
    assert.equal(bye.reason, 'skydeck was updated; run skydeck window');
    assert.equal(await within(test.server.done, 'the stop', WAIT_MS), 0);
    assert.equal(stored(d, S1), undefined, 'nothing written');
  });
});
