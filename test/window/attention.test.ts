// Attention on the server (S2 10.1, 10.2, 10.3, 12.4, 14; stage B's plan, task 52, B9–B11 and the
// rulings after it): the one-second look at live files the test writes, trusted through the fake
// /proc; turn ends, window ends and seen in the store; a busy, migrated or damaged store. On
// testPlatform's fake clock through testDeck, with the real Seen on that clock; the busy store is
// the server's kind of connection (guarded, a 250 ms busy timeout) as test/window/tick.test.ts
// builds it, locked by another connection. One case kills a keeper this test started, by the pid in
// its record, on the real registry.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Ns } from '../../src/platform/types.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import type { AttentionRow, AttentionWrite } from '../../src/store/types.ts';
import { createAttention } from '../../src/window/attention.ts';
import { createNotifier } from '../../src/window/notify.ts';
import type { Attention } from '../../src/window/attention.ts';
import type { TerminalInfo } from '../../src/window/hub.ts';
import type { NotifyMessage } from '../../src/window/protocol.ts';
import { createSeen } from '../../src/window/seen.ts';
import type { Seen } from '../../src/window/seen.ts';
import { attentionOf } from '../../src/window/view/attention.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { until } from '../helpers/keeper.ts';
import { BOOT_A, S1, S2, S3, SEC, T0, statLine } from '../helpers/platform.ts';
import { info, registrySandbox } from '../helpers/registry.ts';
import { ds } from '../helpers/derived.ts';
import { listRow } from '../helpers/rows.ts';

const PID = 4242;
const PID2 = 4343;
const START = 51234567;
const OTHER_START = 61234567;
const MS = 1_000_000n;

/** A SQLite error as node:sqlite throws it: BUSY (5) by default. */
function sqliteError(errcode = 5): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode });
}

function running(id: string): ListRow {
  return listRow({ id, state: 'running' });
}

/** A row that does not run and whose last holding ended unexpectedly (design 6.3). */
function endedUnexpectedly(id: string): ListRow {
  return listRow({ id, marks: ['ended-unexpectedly'] });
}

/**
 * `<claudeHome>/sessions/<pid>.json` for `sessionId` with `status`, written as Claude Code writes
 * it, and the process in the fake /proc with `start` (trusted when it is the file's). `at`: the
 * status time (statusUpdatedAt and updatedAt, epoch ms) unless `over` says otherwise.
 */
function liveFile(
  d: TestDeck,
  pid: number,
  sessionId: string,
  status: string | null,
  at: Ns,
  over: Record<string, unknown> = {},
): void {
  const ms = Number(at / MS);
  writeFileSync(
    join(d.deck.places.claudeHome, 'sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart: String(START),
      status,
      updatedAt: ms,
      statusUpdatedAt: ms,
      ...over,
    }),
  );
  d.proc.setProcess(pid, { stat: statLine(pid, START), cmdline: ['claude'] });
}

function removeLiveFile(d: TestDeck, pid: number): void {
  rmSync(join(d.deck.places.claudeHome, 'sessions', `${pid}.json`));
}

interface World {
  d: TestDeck;
  attention: Attention;
  seen: Seen;
  rows: ListRow[];
  terminals: TerminalInfo[];
  logs: string[];
  storeNewer: string[];
  /** What each recordAttention call got (through the deck the module was given). */
  writes: AttentionWrite[][];
  /** A page of the window, for seen.focus. */
  page: object;
}

/**
 * The module over `d` (a new testDeck by default), the real Seen on the fake clock, rows and
 * terminals the test changes in place, and a spy on recordAttention. `deck` wraps the deck the
 * module is given (deckWith); `take` replaces Seen's take.
 */
function world(
  t: TestContext,
  options: {
    d?: TestDeck;
    deck?: Deck;
    rows?: ListRow[];
    terminals?: TerminalInfo[];
    wrap?: (deck: Deck) => Deck;
    take?: () => Set<string>;
  } = {},
): World {
  const d = options.d ?? testDeck(t);
  const base = options.deck ?? d.deck;
  const writes: AttentionWrite[][] = [];
  const spied = deckWith(base, {
    store: {
      recordAttention: (list) => {
        writes.push(list.map((write) => ({ ...write })));
        return base.store.recordAttention(list);
      },
    },
  });
  const deck = options.wrap === undefined ? spied : options.wrap(spied);
  const seen = createSeen(d.clock);
  t.after(() => {
    seen.stop();
  });
  const rows = options.rows ?? [running(S1), running(S2)];
  const terminals = options.terminals ?? [];
  const logs: string[] = [];
  const storeNewer: string[] = [];
  const take = options.take;
  const attention = createAttention({
    deck,
    hub: { list: () => terminals },
    seen: take === undefined ? seen : { take },
    rows: () => rows,
    log: (line) => {
      logs.push(line);
    },
    storeNewer: (reason) => {
      storeNewer.push(reason);
    },
  });
  return { d, attention, seen, rows, terminals, logs, storeNewer, writes, page: {} };
}

/** The attention rows as the store holds them, read through the test deck's own connection. */
function stored(d: TestDeck): AttentionRow[] {
  return d.deck.store.attention();
}

function row(over: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
  return {
    turnEndedSeq: null,
    turnEndedNs: null,
    seenSeq: null,
    windowEndSeq: null,
    windowEndNs: null,
    ...over,
  };
}

/** Page `w.page` has focus with `sessionId` selected, held for the 1.5 s (S2 12.4). */
function hold(w: World, sessionId: string): void {
  w.seen.focus(w.page, true, sessionId);
  w.d.clock.advanceMs(1500);
}

/** What the view model says of a running row of `sessionId` over the module's facts now. */
function reasonOf(w: World, sessionId: string, state: ListRow['state'] = 'running'): string | null {
  return attentionOf(listRow({ id: sessionId, state }), w.attention.facts())?.reason ?? null;
}

/** The server's own kind of connection (S2 10.1, 14): guarded, a 250 ms busy timeout. */
function guardedDeck(t: TestContext, d: TestDeck): Deck {
  const deck = openDeck(d.platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });
  return deck;
}

/** Another connection holds the write lock until `release()` (also at the test's end). */
function lockStore(t: TestContext, d: TestDeck): { release(): void } {
  const other = new DatabaseSync(d.deck.places.dbPath);
  other.exec('BEGIN IMMEDIATE');
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    other.exec('ROLLBACK');
    other.close();
  };
  t.after(release);
  return { release };
}

/** A statement on the database through a connection of its own (damage, a migration). */
function rawExec(d: TestDeck, sql: string): void {
  const db = new DatabaseSync(d.deck.places.dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function terminal(over: Partial<TerminalInfo> & { id: string }): TerminalInfo {
  return {
    slot: 1,
    state: 'ended',
    expectedSessionId: S1,
    sessionId: S1,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 9000, procStart: 1 },
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: { code: null, signal: 1, atNs: String(T0 + 5n * SEC), notStarted: null },
    notReported: false,
    ...over,
  };
}

describe('the look (S2 10.3; B4)', () => {
  test("a busy file, a look, the same file idle, a look: one turn end whose time is exactly the idle file's status time, and facts() says finished", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    assert.equal(w.attention.look(), true, 'the status is new');
    assert.deepEqual(stored(w.d), []);
    assert.equal(w.attention.facts().live.get(S1)?.status, 'busy');

    const ended = T0 + 7n * SEC + 123n * MS;
    liveFile(w.d, PID, S1, 'idle', ended);
    assert.equal(w.attention.look(), true);
    assert.deepEqual(stored(w.d), [row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: ended })]);
    const facts = w.attention.facts();
    assert.deepEqual(facts.live.get(S1), { status: 'idle', waitingFor: null, sinceNs: ended });
    assert.equal(facts.marks.get(S1)?.turnEndedNs, ended);
    // Ruled: turn_ended_ns IS the status time the row shows, so the stale-turn rule finds them equal.
    assert.deepEqual(attentionOf(running(S1), facts), {
      reason: 'finished',
      detail: null,
      sinceNs: String(ended),
    });
  });

  test("the turn end's time is the file's updatedAt when it has no statusUpdatedAt, else the clock at the look; both are finished", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    liveFile(w.d, PID2, S2, 'busy', T0);
    w.attention.look();
    const updated = T0 + 3n * SEC;
    liveFile(w.d, PID, S1, 'idle', updated, { statusUpdatedAt: undefined });
    liveFile(w.d, PID2, S2, 'idle', updated, { statusUpdatedAt: undefined, updatedAt: undefined });
    w.d.clock.advanceMs(9000);
    w.attention.look();
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: updated }),
      row({ sessionId: S2, turnEndedSeq: 2, turnEndedNs: T0 + 9n * SEC }),
    ]);
    assert.equal(reasonOf(w, S1), 'finished');
    assert.equal(reasonOf(w, S2), 'finished');
  });

  test("the status time is the file's statusUpdatedAt before its updatedAt (a rewrite of an idle file keeps it)", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    const status = T0 + 2n * SEC;
    liveFile(w.d, PID, S1, 'idle', status, { updatedAt: Number((status + 5n * SEC) / MS) });
    w.attention.look();
    assert.equal(stored(w.d)[0]?.turnEndedNs, status);
    assert.equal(w.attention.facts().live.get(S1)?.sinceNs, status);
    assert.equal(reasonOf(w, S1), 'finished');
  });

  test('a status time no INTEGER column holds (past 2^63 - 1 ns) is unknown: one foreign file costs no other session its turn end', (t) => {
    const w = world(t, { rows: [running(S1), running(S2), running(S3)] });
    const PID3 = 4444;
    liveFile(w.d, PID, S1, 'busy', T0);
    liveFile(w.d, PID2, S2, 'busy', T0);
    liveFile(w.d, PID3, S3, 'busy', T0);
    w.attention.look();
    const far = 1e13; // epoch ms in the year 2286: 1e19 ns
    const at = T0 + 2n * SEC;
    liveFile(w.d, PID, S1, 'idle', at, { statusUpdatedAt: far }); // its updatedAt counts
    liveFile(w.d, PID2, S2, 'idle', at, { statusUpdatedAt: far, updatedAt: far }); // the clock
    liveFile(w.d, PID3, S3, 'idle', at);
    w.d.clock.advanceMs(3000);
    w.attention.look();
    assert.deepEqual(w.logs, []);
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: at }),
      row({ sessionId: S2, turnEndedSeq: 2, turnEndedNs: T0 + 3n * SEC }),
      row({ sessionId: S3, turnEndedSeq: 3, turnEndedNs: at }),
    ]);
    assert.equal(w.attention.facts().live.get(S2)?.sinceNs, null);
    assert.deepEqual(
      [S1, S2, S3].map((id) => reasonOf(w, id)),
      ['finished', 'finished', 'finished'],
    );
  });

  test('the first look of a new module only sets the baselines: a file idle already records nothing, nor one that turned idle while no module looked', (t) => {
    const d = testDeck(t);
    liveFile(d, PID, S1, 'idle', T0);
    liveFile(d, PID2, S2, 'busy', T0);
    const before = world(t, { d });
    before.attention.look();
    liveFile(d, PID2, S2, 'idle', T0 + SEC);

    const after = world(t, { d });
    after.attention.look();
    after.attention.look();
    assert.deepEqual(stored(d), []);
    assert.deepEqual(after.writes, []);
    assert.equal(after.attention.facts().live.get(S2)?.status, 'idle');
  });

  test('the first look reads the marks: true when the store holds any, false for an empty store and no file', (t) => {
    const d = testDeck(t);
    assert.equal(world(t, { d }).attention.look(), false);
    d.deck.store.recordAttention([{ sessionId: S1, windowEndNs: T0 }]);
    const w = world(t, { d });
    assert.equal(w.attention.look(), true);
    assert.deepEqual(
      w.attention.facts().marks.get(S1),
      row({ sessionId: S1, windowEndSeq: 1, windowEndNs: T0 }),
    );
    assert.equal(w.attention.look(), false, 'read once');
  });

  test('a look that changes nothing says false and writes nothing', (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'waiting', T0, { waitingFor: 'permission · Bash' });
    assert.equal(w.attention.look(), true);
    assert.equal(w.attention.look(), false);
    assert.equal(w.attention.look(), false);
    assert.deepEqual(w.writes, []);
    liveFile(w.d, PID, S1, 'waiting', T0, { waitingFor: 'a question' });
    assert.equal(w.attention.look(), true, 'another detail is a change');
    liveFile(w.d, PID, S1, 'waiting', T0 + SEC, { waitingFor: 'a question' });
    assert.equal(w.attention.look(), true, 'another status time is a change');
    assert.equal(w.attention.facts().live.get(S1)?.sinceNs, T0 + SEC);
    liveFile(w.d, PID, S1, 'busy', T0 + SEC, { waitingFor: 'a question' });
    assert.equal(w.attention.look(), true, 'another status is a change (no turn end: no write)');
    assert.deepEqual(w.writes, []);
  });

  test('a file that cannot be parsed between the busy and the idle look keeps the baseline: the end is recorded', (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    writeFileSync(join(w.d.deck.places.claudeHome, 'sessions', `${PID}.json`), '{"pid": 42');
    assert.equal(w.attention.look(), false, 'nothing changed: the baseline holds');
    assert.equal(w.attention.facts().live.get(S1)?.status, 'busy');
    liveFile(w.d, PID, S1, 'idle', T0 + 2n * SEC);
    w.attention.look();
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: T0 + 2n * SEC }),
    ]);
  });

  test('a file removed and its pid gone drops the baseline: the status goes, and a later idle file of that pid is no turn end', (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    removeLiveFile(w.d, PID);
    w.d.proc.setProcess(PID, null);
    assert.equal(w.attention.look(), true);
    assert.equal(w.attention.facts().live.has(S1), false);
    liveFile(w.d, PID, S1, 'idle', T0 + 2n * SEC);
    w.attention.look();
    assert.deepEqual(stored(w.d), []);
  });

  test("the pid taken by a process with another start drops it too: a dead holder's waiting does not stay", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'waiting', T0, { waitingFor: 'permission · Bash' });
    w.attention.look();
    assert.equal(reasonOf(w, S1), 'asks');
    // The file stays, untrusted now: its pid is another program's.
    w.d.proc.setProcess(PID, { stat: statLine(PID, OTHER_START), cmdline: ['vim'] });
    assert.equal(w.attention.look(), true);
    assert.equal(w.attention.facts().live.has(S1), false);
    assert.equal(reasonOf(w, S1), null);
  });

  test('/proc that throws drops nothing and reads no file: the baseline holds, and the end comes at the look after', (t) => {
    let failing = false;
    const w = world(t, {
      wrap: (deck) =>
        deckWith(deck, {
          proc: {
            stat: (pid) => {
              if (failing) throw Object.assign(new Error('EIO'), { code: 'EIO' });
              return deck.platform.proc.stat(pid);
            },
          },
        }),
    });
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    failing = true;
    liveFile(w.d, PID, S1, 'idle', T0 + SEC);
    assert.equal(w.attention.look(), false);
    assert.equal(w.attention.facts().live.get(S1)?.status, 'busy');
    assert.deepEqual(stored(w.d), []);
    failing = false;
    w.attention.look();
    assert.deepEqual(stored(w.d), [row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: T0 + SEC })]);
  });

  test("a turn end's time is the latest status time among its session's idle holders: a holder whose idle file was missed, seen ending later with an earlier time, hides no finished (ruled)", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    liveFile(w.d, PID2, S1, 'busy', T0);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + 4n * SEC);
    writeFileSync(join(w.d.deck.places.claudeHome, 'sessions', `${PID2}.json`), '{"pid": 43'); // idle at T0 + 2 s, being written
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 4n * SEC }]);
    liveFile(w.d, PID2, S1, 'idle', T0 + 2n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 4n * SEC }]);
    assert.equal(w.attention.facts().live.get(S1)?.sinceNs, T0 + 4n * SEC);
    assert.equal(reasonOf(w, S1), 'finished');
  });

  test("the time comes from the idle baselines, not only from this look's files: a holder idle since later, whose file a look cannot read, still counts", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    liveFile(w.d, PID2, S1, 'busy', T0);
    w.attention.look();
    liveFile(w.d, PID2, S1, 'idle', T0 + 6n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 6n * SEC }]);
    writeFileSync(join(w.d.deck.places.claudeHome, 'sessions', `${PID2}.json`), '{"pid": 43');
    liveFile(w.d, PID, S1, 'idle', T0 + 4n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 6n * SEC }]);
    assert.equal(reasonOf(w, S1), 'finished');
  });

  test("a holder that is still busy lends a turn end no time: the end's time is its idle holders' only", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    liveFile(w.d, PID2, S1, 'busy', T0);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + 2n * SEC);
    liveFile(w.d, PID2, S1, 'busy', T0 + 6n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 2n * SEC }]);
  });

  test("two holders of one session that end their turns at one look: one turn end, the later time, and it is finished whichever holder's time the row shows", (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    liveFile(w.d, PID2, S1, 'busy', T0);
    w.attention.look();
    // B5 shows the first baseline's time: both pids first appeared at one look, so the lower pid's,
    // which is the later one here.
    liveFile(w.d, PID, S1, 'idle', T0 + 4n * SEC);
    liveFile(w.d, PID2, S1, 'idle', T0 + 2n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes, [[{ sessionId: S1, turnEndedNs: T0 + 4n * SEC }]]);
    assert.equal(reasonOf(w, S1), 'finished');

    // The other order: the later time is the second holder's, and it is still the one kept.
    liveFile(w.d, PID, S1, 'busy', T0 + 5n * SEC);
    liveFile(w.d, PID2, S1, 'busy', T0 + 5n * SEC);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + 6n * SEC);
    liveFile(w.d, PID2, S1, 'idle', T0 + 8n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 8n * SEC }]);
    assert.equal(reasonOf(w, S1), 'finished');
  });
});

describe('seen (S2 12.4; B9)', () => {
  test('while the session is being seen, a turn end and its seen are one write: seen = turn + 1, never finished', (t) => {
    const w = world(t);
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    hold(w, S1);
    liveFile(w.d, PID, S1, 'idle', T0 + 2n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes, [[{ sessionId: S1, turnEndedNs: T0 + 2n * SEC, seen: true }]]);
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: T0 + 2n * SEC, seenSeq: 2 }),
    ]);
    assert.equal(reasonOf(w, S1), null);
  });

  test('a hold that starts on a finished session writes seen at once (Seen.onChange → seenNow)', (t) => {
    const w = world(t);
    const answers: boolean[] = [];
    w.seen.onChange(() => {
      answers.push(w.attention.seenNow());
    });
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + SEC);
    w.attention.look();
    assert.equal(reasonOf(w, S1), 'finished');

    hold(w, S1);
    assert.deepEqual(answers, [true]);
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: T0 + SEC, seenSeq: 2 }),
    ]);
    assert.equal(reasonOf(w, S1), null, 'the facts know it at once');
  });

  test('typing into a terminal that shows a finished session makes it seen at once, also when it is not the selection', (t) => {
    const w = world(t);
    w.seen.onChange(() => {
      w.attention.seenNow();
    });
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + SEC);
    w.attention.look();
    w.seen.focus(w.page, true, S2);
    w.seen.typed(w.page, S1);
    assert.equal(stored(w.d)[0]?.seenSeq, 2);
  });

  test('a hold over a session without a mark writes nothing, at that look and at every later one (no periodic seen)', (t) => {
    const w = world(t);
    w.seen.onChange(() => {
      w.attention.seenNow();
    });
    liveFile(w.d, PID, S1, 'idle', T0);
    w.attention.look();
    hold(w, S1);
    for (let i = 0; i < 10; i += 1) {
      w.d.clock.advanceMs(1000);
      w.attention.look();
    }
    assert.deepEqual(w.writes, []);
    assert.deepEqual(stored(w.d), []);
  });

  test("a held session that is no row yet ends a turn: its seen rides in the end's write all the same, never finished (ruled)", (t) => {
    const w = world(t, { rows: [running(S1)] });
    liveFile(w.d, PID2, S2, 'busy', T0);
    w.attention.look();
    hold(w, S2);
    liveFile(w.d, PID2, S2, 'idle', T0 + SEC);
    w.attention.look();
    assert.deepEqual(w.writes, [[{ sessionId: S2, turnEndedNs: T0 + SEC, seen: true }]]);
    assert.equal(reasonOf(w, S2), null);
  });

  test('a seen is written only for an id among the rows: a selection naming no row writes nothing and creates no row (F6)', (t) => {
    const w = world(t, { rows: [running(S1)] });
    w.seen.onChange(() => {
      w.attention.seenNow();
    });
    // S2 has an unseen turn end, but no row; 'nothing' is no session at all.
    liveFile(w.d, PID2, S2, 'busy', T0);
    w.attention.look();
    liveFile(w.d, PID2, S2, 'idle', T0 + SEC);
    w.attention.look();
    hold(w, S2);
    w.attention.look();
    w.seen.focus(w.page, true, 'nothing');
    w.d.clock.advanceMs(1500);
    w.attention.look();
    assert.deepEqual(stored(w.d), [row({ sessionId: S2, turnEndedSeq: 1, turnEndedNs: T0 + SEC })]);
    // Once it is a row, the next look clears it (a mark of a session already being seen).
    w.seen.focus(w.page, true, S2);
    w.d.clock.advanceMs(1500);
    w.rows.push(running(S2));
    w.attention.look();
    assert.equal(stored(w.d)[0]?.seenSeq, 2);
  });

  test('a mark that becomes known while the hold already lasts is cleared at the look (ruled): the marks read late', (t) => {
    const d = testDeck(t);
    d.deck.store.recordAttention([{ sessionId: S1, windowEndNs: T0 }]);
    let busy = true;
    const w = world(t, {
      d,
      wrap: (deck) =>
        deckWith(deck, {
          store: {
            attention: () => {
              if (busy) throw sqliteError();
              return deck.store.attention();
            },
          },
        }),
    });
    w.seen.onChange(() => {
      w.attention.seenNow();
    });
    w.attention.look();
    hold(w, S1);
    assert.deepEqual(w.writes, [], 'no mark known yet: nothing to clear');
    busy = false;
    assert.equal(w.attention.look(), true);
    assert.deepEqual(w.writes, [[{ sessionId: S1, seen: true }]]);
    assert.deepEqual(stored(d), [
      row({ sessionId: S1, windowEndSeq: 1, windowEndNs: T0, seenSeq: 2 }),
    ]);
    assert.equal(reasonOf(w, S1, 'not-running'), null);
    w.attention.look();
    assert.equal(w.writes.length, 1, 'once: nothing left to clear');
  });

  test('seenNow is cheap: with nothing to clear it reads nothing and writes nothing (200 calls)', (t) => {
    let reads = 0;
    const w = world(t, {
      wrap: (deck) =>
        deckWith(deck, {
          store: {
            attention: () => {
              reads += 1;
              return deck.store.attention();
            },
          },
        }),
    });
    liveFile(w.d, PID, S1, 'idle', T0);
    w.attention.look();
    w.seen.focus(w.page, true, S2);
    for (let i = 0; i < 200; i += 1) {
      w.seen.typed(w.page, S1);
      assert.equal(w.attention.seenNow(), false);
    }
    assert.equal(reads, 1, 'the marks are read once, at the first look');
    assert.deepEqual(w.writes, []);
  });
});

describe('a busy store (S2 14; B11)', () => {
  test('the store locked at the look of a turn end: nothing written, one log line with a kind; the next look after the lock is gone writes it once', (t) => {
    const d = testDeck(t);
    const w = world(t, { d, deck: guardedDeck(t, d) });
    liveFile(d, PID, S1, 'busy', T0);
    w.attention.look();
    const lock = lockStore(t, d);
    liveFile(d, PID, S1, 'idle', T0 + SEC);
    assert.equal(w.attention.look(), true, 'the status changed');
    w.attention.look();
    assert.deepEqual(w.logs, [
      'attention: the database is busy; the writes are kept for the next look (Error (ERR_SQLITE_ERROR))',
    ]);
    assert.equal(reasonOf(w, S1), null, 'not finished before it is stored');
    lock.release();
    assert.deepEqual(stored(d), []);

    assert.equal(w.attention.look(), true);
    assert.deepEqual(stored(d), [row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: T0 + SEC })]);
    assert.equal(reasonOf(w, S1), 'finished');
    w.attention.look();
    assert.equal(stored(d)[0]?.turnEndedSeq, 1, 'written once');

    // A write worked: the next busy store is logged again.
    liveFile(d, PID, S1, 'busy', T0 + 2n * SEC);
    w.attention.look();
    const again = lockStore(t, d);
    liveFile(d, PID, S1, 'idle', T0 + 3n * SEC);
    w.attention.look();
    again.release();
    assert.equal(w.logs.length, 2);
  });

  test('a second turn end of that session while the store is locked is folded: the later one is stored, with one value', (t) => {
    const d = testDeck(t);
    const w = world(t, { d, deck: guardedDeck(t, d) });
    liveFile(d, PID, S1, 'busy', T0);
    w.attention.look();
    const lock = lockStore(t, d);
    liveFile(d, PID, S1, 'idle', T0 + SEC);
    w.attention.look();
    liveFile(d, PID, S1, 'busy', T0 + 2n * SEC);
    w.attention.look();
    liveFile(d, PID, S1, 'idle', T0 + 3n * SEC);
    w.attention.look();
    lock.release();
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 3n * SEC }]);
    assert.deepEqual(stored(d), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: T0 + 3n * SEC }),
    ]);
  });

  test('a kept turn end seen in its write, then the user gone and a later turn end: the fold keeps that seen and the later turn is finished', (t) => {
    const d = testDeck(t);
    const w = world(t, { d, deck: guardedDeck(t, d) });
    liveFile(d, PID, S1, 'busy', T0);
    w.attention.look();
    hold(w, S1);
    const lock = lockStore(t, d);
    liveFile(d, PID, S1, 'idle', T0 + SEC);
    w.attention.look(); // kept: the turn end and its seen, one write
    w.seen.focus(w.page, false, S1);
    liveFile(d, PID, S1, 'busy', T0 + 2n * SEC);
    w.attention.look();
    liveFile(d, PID, S1, 'idle', T0 + 3n * SEC);
    w.attention.look();
    lock.release();
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [
      { sessionId: S1, seen: true },
      { sessionId: S1, turnEndedNs: T0 + 3n * SEC },
    ]);
    assert.deepEqual(stored(d), [
      row({ sessionId: S1, turnEndedSeq: 2, turnEndedNs: T0 + 3n * SEC, seenSeq: 1 }),
    ]);
    assert.equal(reasonOf(w, S1), 'finished');
  });

  test('a kept seen, then the user gone and a turn end of that session, then the lock gone: turn_ended_seq > seen_seq, finished (F4)', (t) => {
    const d = testDeck(t);
    const w = world(t, { d, deck: guardedDeck(t, d) });
    w.seen.onChange(() => {
      w.attention.seenNow();
    });
    liveFile(d, PID, S1, 'busy', T0);
    w.attention.look();
    liveFile(d, PID, S1, 'idle', T0 + SEC);
    w.attention.look();
    assert.equal(reasonOf(w, S1), 'finished');

    const lock = lockStore(t, d);
    hold(w, S1); // seenNow: the store is busy, the seen is kept
    w.seen.focus(w.page, false, S1); // the user leaves
    liveFile(d, PID, S1, 'busy', T0 + 2n * SEC);
    w.attention.look();
    liveFile(d, PID, S1, 'idle', T0 + 3n * SEC);
    w.attention.look();
    lock.release();
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [
      { sessionId: S1, seen: true },
      { sessionId: S1, turnEndedNs: T0 + 3n * SEC },
    ]);
    const [s1] = stored(d);
    assert.ok(s1 !== undefined && s1.turnEndedSeq !== null && s1.seenSeq !== null);
    assert.ok(s1.turnEndedSeq > s1.seenSeq);
    assert.equal(reasonOf(w, S1), 'finished');
  });

  test('a kept turn end lands while take() gives the session: its seen comes after it, not finished (ruled)', (t) => {
    const d = testDeck(t);
    const w = world(t, { d, deck: guardedDeck(t, d) });
    liveFile(d, PID, S1, 'busy', T0);
    w.attention.look();
    const lock = lockStore(t, d);
    liveFile(d, PID, S1, 'idle', T0 + SEC);
    w.attention.look(); // kept; nobody looks at S1
    hold(w, S1); // no listener here: only the look can clear it
    lock.release();
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [
      { sessionId: S1, turnEndedNs: T0 + SEC },
      { sessionId: S1, seen: true },
    ]);
    assert.deepEqual(stored(d), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: T0 + SEC, seenSeq: 2 }),
    ]);
    assert.equal(reasonOf(w, S1), null);
  });

  test('while writes are kept, seenNow and refreshed touch no store (never at every key): theirs join the kept ones, in order, for the next look', (t) => {
    const d = testDeck(t);
    const w = world(t, {
      d,
      deck: guardedDeck(t, d),
      rows: [running(S1), endedUnexpectedly(S2)],
    });
    liveFile(d, PID, S1, 'busy', T0);
    w.attention.look();
    liveFile(d, PID, S1, 'idle', T0 + SEC);
    w.attention.look(); // S1 finished, stored
    const lock = lockStore(t, d);
    liveFile(d, PID, S1, 'busy', T0 + 2n * SEC);
    liveFile(d, PID2, S2, 'busy', T0);
    w.attention.look();
    liveFile(d, PID2, S2, 'idle', T0 + 2n * SEC);
    w.attention.look(); // S2's turn end kept
    const calls = w.writes.length;

    w.seen.focus(w.page, true, S1);
    w.d.clock.advanceMs(1500);
    w.terminals.push(terminal({ id: 'aaaaaaaaaaaa', sessionId: S2 }));
    for (let i = 0; i < 200; i += 1) {
      assert.equal(w.attention.seenNow(), false);
    }
    assert.equal(w.attention.refreshed(), false);
    assert.equal(w.writes.length, calls, 'no write was tried');
    lock.release();
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [
      { sessionId: S2, turnEndedNs: T0 + 2n * SEC },
      { sessionId: S1, seen: true },
      { sessionId: S2, windowEndNs: T0 + 5n * SEC },
    ]);
  });

  test('the store migrated under the server: storeNewer once, nothing written, and later calls do nothing', (t) => {
    const d = testDeck(t);
    d.deck.store.recordAttention([{ sessionId: S1, windowEndNs: T0 }]); // a mark to clear
    const w = world(t, { d, deck: guardedDeck(t, d), rows: [endedUnexpectedly(S1), running(S2)] });
    liveFile(d, PID2, S2, 'busy', T0);
    w.attention.look();
    rawExec(d, `UPDATE kv SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    liveFile(d, PID2, S2, 'idle', T0 + SEC);
    w.attention.look();
    assert.deepEqual(w.storeNewer, ['skydeck was updated; run skydeck window']);
    const calls = w.writes.length;

    w.terminals.push(terminal({ id: 'aaaaaaaaaaaa' }));
    liveFile(d, PID2, S2, 'busy', T0 + 2n * SEC);
    hold(w, S1);
    assert.equal(w.attention.look(), false);
    assert.equal(w.attention.refreshed(), false);
    assert.equal(w.attention.seenNow(), false);
    assert.equal(w.writes.length, calls, 'nothing tried after it');
    assert.equal(w.attention.facts().live.get(S2)?.status, 'idle', 'the facts stay as they were');
    assert.deepEqual(w.storeNewer, ['skydeck was updated; run skydeck window']);
    assert.deepEqual(stored(d), [row({ sessionId: S1, windowEndSeq: 1, windowEndNs: T0 })]);
    assert.deepEqual(w.logs, []);
  });

  test("B2's limit (2^53 - 1) is no busy store: logged by its kind, not kept, not tried again", (t) => {
    const w = world(t);
    w.d.deck.store.setKv('attention_seq', String(Number.MAX_SAFE_INTEGER));
    liveFile(w.d, PID, S1, 'busy', T0);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + SEC);
    w.attention.look();
    w.attention.look();
    assert.equal(w.writes.length, 1, 'not tried again');
    assert.deepEqual(w.logs, ['attention: a write failed and is dropped (RangeError)']);
    assert.deepEqual(stored(w.d), []);

    w.d.deck.store.setKv('attention_seq', '7');
    liveFile(w.d, PID, S1, 'busy', T0 + 2n * SEC);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + 3n * SEC);
    w.attention.look();
    assert.deepEqual(w.writes.at(-1), [{ sessionId: S1, turnEndedNs: T0 + 3n * SEC }]);
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, turnEndedSeq: 8, turnEndedNs: T0 + 3n * SEC }),
    ]);

    // A write worked: the next refusal is logged again.
    w.d.deck.store.setKv('attention_seq', String(Number.MAX_SAFE_INTEGER));
    liveFile(w.d, PID, S1, 'busy', T0 + 4n * SEC);
    w.attention.look();
    liveFile(w.d, PID, S1, 'idle', T0 + 5n * SEC);
    w.attention.look();
    assert.deepEqual(w.logs, [
      'attention: a write failed and is dropped (RangeError)',
      'attention: a write failed and is dropped (RangeError)',
    ]);
  });
});

describe('a damaged store (ruled): no attention facts, logged once by kind, and the look goes on', () => {
  for (const [what, damage, kind] of [
    [
      'one damaged attention row',
      `INSERT INTO attention (session_id, turn_ended_seq) VALUES ('${S2}', 'abc')`,
      'Error',
    ],
    [
      'a schema_version of 2 without the attention table',
      'DROP TABLE attention',
      'Error (ERR_SQLITE_ERROR)',
    ],
  ] as const) {
    test(what, (t) => {
      const d = testDeck(t);
      d.deck.store.recordAttention([{ sessionId: S1, windowEndNs: T0 }]);
      rawExec(d, damage);
      assert.throws(() => d.deck.store.attention(), 'the store itself refuses every session');
      const w = world(t, { d });
      liveFile(d, PID, S1, 'waiting', T0, { waitingFor: 'permission · Bash' });
      liveFile(d, PID2, S2, 'busy', T0);
      assert.equal(w.attention.look(), true);
      w.attention.look();
      assert.deepEqual(w.attention.facts().marks, new Map());
      assert.equal(reasonOf(w, S1), 'asks', 'the live statuses still count');
      liveFile(d, PID2, S2, 'idle', T0 + SEC);
      w.attention.look();
      liveFile(d, PID2, S2, 'busy', T0 + 2n * SEC);
      w.attention.look();
      liveFile(d, PID2, S2, 'idle', T0 + 3n * SEC);
      w.attention.look();
      assert.deepEqual(w.logs, [
        `attention: the marks cannot be read; there are no attention facts (${kind})`,
        `attention: a write failed and is dropped (${kind})`,
      ]);
      w.attention.refreshed();
      assert.equal(w.attention.ready(), true, 'no facts is no reason to wait');
    });
  }
});

describe('window ends (S2 12.4 reason 2; B10)', () => {
  /** A world whose marks are read (one look) with `terminals` and `rows`. */
  function ended(t: TestContext, terminals: TerminalInfo[], rows: ListRow[]): World {
    const w = world(t, { terminals, rows });
    w.attention.look();
    return w;
  }

  test("a terminal ended with an exit, its row not running and ended-unexpectedly: windowEndSeq and the exit's time", (t) => {
    const w = ended(t, [terminal({ id: 'aaaaaaaaaaaa' })], [endedUnexpectedly(S1)]);
    assert.equal(w.attention.refreshed(), true);
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, windowEndSeq: 1, windowEndNs: T0 + 5n * SEC }),
    ]);
    assert.deepEqual(attentionOf(endedUnexpectedly(S1), w.attention.facts()), {
      reason: 'ended',
      detail: null,
      sinceNs: String(T0 + 5n * SEC),
    });
  });

  test("a lost one (a keeper that died: its exit's time is the server's clock): the same", (t) => {
    const lostAt = T0 + 9n * SEC;
    const w = ended(
      t,
      [
        terminal({
          id: 'aaaaaaaaaaaa',
          state: 'lost',
          exit: { code: null, signal: 1, atNs: String(lostAt), notStarted: null },
        }),
      ],
      [endedUnexpectedly(S1)],
    );
    w.attention.refreshed();
    assert.deepEqual(stored(w.d), [row({ sessionId: S1, windowEndSeq: 1, windowEndNs: lostAt })]);
  });

  test('a lost keeper this test started, killed by the pid in its record: its terminal gives the window end', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const spec = box.spec();
    await r.registry.spawn(spec);
    r.registry.start(spec.id);
    await until(() => info(r.registry, spec.id).state === 'running', 'the program runs', 15_000);
    box.signalKeeper(box.keeperOf(spec.id), 'SIGKILL');
    await until(() => info(r.registry, spec.id).state === 'lost', 'the keeper is lost', 10_000);
    const exit = info(r.registry, spec.id).exit;
    assert.ok(exit !== null);
    assert.deepEqual([exit.code, exit.signal, exit.notStarted], [null, 1, null]);

    const sessionId = spec.meta.sessionId;
    const w = world(t, { rows: [endedUnexpectedly(sessionId)] });
    const attention = createAttention({
      deck: w.d.deck,
      hub: r.registry,
      seen: w.seen,
      rows: () => w.rows,
      log: (line) => {
        w.logs.push(line);
      },
      storeNewer: (reason) => {
        w.storeNewer.push(reason);
      },
    });
    attention.look();
    assert.equal(attention.refreshed(), true);
    assert.deepEqual(stored(w.d), [
      row({ sessionId, windowEndSeq: 1, windowEndNs: BigInt(exit.atNs) }),
    ]);
    assert.deepEqual(w.logs, []);
  });

  test('nothing for a deliberate end (no mark), a row that runs again (whatever its marks say), a not-started terminal, a lost one whose program never started, or one still running', (t) => {
    const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
    const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
    const S6 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';
    const notStarted = 'the keeper ended before the program started';
    const w = ended(
      t,
      [
        terminal({ id: 'aaaaaaaaaaa1', sessionId: S1 }),
        terminal({ id: 'aaaaaaaaaaa2', sessionId: S2 }),
        terminal({
          id: 'aaaaaaaaaaa3',
          sessionId: S3,
          state: 'not-started',
          exit: { code: null, signal: null, atNs: String(T0), notStarted },
        }),
        terminal({
          id: 'aaaaaaaaaaa4',
          sessionId: S4,
          state: 'lost',
          program: null,
          exit: { code: null, signal: null, atNs: String(T0), notStarted },
        }),
        terminal({ id: 'aaaaaaaaaaa5', sessionId: S5, state: 'running', exit: null }),
        terminal({ id: 'aaaaaaaaaaa6', sessionId: S6 }),
      ],
      [
        listRow({ id: S1 }),
        running(S2),
        listRow({ id: S6, state: 'running', marks: ['ended-unexpectedly'] }),
        endedUnexpectedly(S3),
        endedUnexpectedly(S4),
        endedUnexpectedly(S5),
      ],
    );
    assert.equal(w.attention.refreshed(), false);
    assert.deepEqual(stored(w.d), []);
    assert.deepEqual(w.writes, []);
  });

  test('a terminal whose row still runs is not judged yet: it is judged at the first refresh where its row no longer runs, and then once (ruled)', (t) => {
    const w = ended(
      t,
      [
        terminal({ id: 'aaaaaaaaaaa1', sessionId: S1, state: 'lost' }),
        terminal({ id: 'aaaaaaaaaaa2', sessionId: S2 }),
      ],
      [running(S1), listRow({ id: S2 })],
    );
    // S1's program still lives on its SIGHUP; S2 ended deliberately.
    assert.equal(w.attention.refreshed(), false);
    w.rows.splice(0, 2, endedUnexpectedly(S1), endedUnexpectedly(S2));
    assert.equal(w.attention.refreshed(), true);
    assert.equal(w.attention.refreshed(), false);
    w.rows.splice(0, 1, running(S1));
    w.attention.refreshed();
    w.rows.splice(0, 1, endedUnexpectedly(S1));
    w.attention.refreshed();
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, windowEndSeq: 1, windowEndNs: T0 + 5n * SEC }),
    ]);
  });

  test("a terminal is not judged while its row's last holder still lives: the refresh between the end event and the exit stores nothing, the next one stores the window end (ruled)", (t) => {
    const holding = {
      process: { bootId: BOOT_A, pid: 9000, procStart: 1 },
      endedAtNs: T0 + 4n * SEC,
      endDetail: 'other' as const,
    };
    // The end event is ingested (the row no longer runs) while the process still lives on its
    // SIGHUP: no `ended-unexpectedly` mark yet (design 6.3 needs the holder gone).
    const ending = listRow({
      id: S1,
      session: ds({ id: S1, lastHolding: { ...holding, alive: true } }),
    });
    const w = ended(t, [terminal({ id: 'aaaaaaaaaaaa', state: 'lost' })], [ending]);
    assert.equal(w.attention.refreshed(), false);
    assert.deepEqual(w.writes, []);
    w.rows.splice(
      0,
      1,
      listRow({
        id: S1,
        marks: ['ended-unexpectedly'],
        session: ds({ id: S1, lastHolding: { ...holding, alive: false } }),
      }),
    );
    assert.equal(w.attention.refreshed(), true);
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, windowEndSeq: 1, windowEndNs: T0 + 5n * SEC }),
    ]);
  });

  test("a new module over a store that holds that exit's time (a server restart finds the keeper again): nothing", (t) => {
    const d = testDeck(t);
    const first = world(t, {
      d,
      terminals: [terminal({ id: 'aaaaaaaaaaaa' })],
      rows: [endedUnexpectedly(S1)],
    });
    first.attention.look();
    first.attention.refreshed();
    const again = world(t, {
      d,
      terminals: [terminal({ id: 'aaaaaaaaaaaa' })],
      rows: [endedUnexpectedly(S1)],
    });
    again.attention.look();
    assert.equal(again.attention.refreshed(), false);
    assert.deepEqual(again.writes, []);
    assert.equal(stored(d)[0]?.windowEndSeq, 1);
  });

  test('a later end of the same session (another exit time) is recorded again', (t) => {
    const d = testDeck(t);
    d.deck.store.recordAttention([
      { sessionId: S1, windowEndNs: T0 },
      { sessionId: S1, seen: true },
    ]);
    const w = world(t, {
      d,
      terminals: [terminal({ id: 'aaaaaaaaaaaa' })],
      rows: [endedUnexpectedly(S1)],
    });
    w.attention.look();
    w.attention.refreshed();
    assert.deepEqual(stored(d), [
      row({ sessionId: S1, windowEndSeq: 3, windowEndNs: T0 + 5n * SEC, seenSeq: 2 }),
    ]);
  });

  test('the session being seen: its seen in the same write, after the window end', (t) => {
    const w = ended(t, [terminal({ id: 'aaaaaaaaaaaa' })], [endedUnexpectedly(S1)]);
    hold(w, S1);
    w.attention.refreshed();
    assert.deepEqual(w.writes, [[{ sessionId: S1, windowEndNs: T0 + 5n * SEC, seen: true }]]);
    assert.deepEqual(stored(w.d), [
      row({ sessionId: S1, windowEndSeq: 1, windowEndNs: T0 + 5n * SEC, seenSeq: 2 }),
    ]);
  });

  test('two ended terminals of one session at one refresh, that session being seen: the seen after both ends', (t) => {
    const w = ended(
      t,
      [
        terminal({ id: 'aaaaaaaaaaa1' }),
        terminal({
          id: 'aaaaaaaaaaa2',
          exit: { code: null, signal: 1, atNs: String(T0 + 7n * SEC), notStarted: null },
        }),
      ],
      [endedUnexpectedly(S1)],
    );
    hold(w, S1);
    w.attention.refreshed();
    assert.deepEqual(w.writes, [
      [
        { sessionId: S1, windowEndNs: T0 + 5n * SEC },
        { sessionId: S1, windowEndNs: T0 + 7n * SEC, seen: true },
      ],
    ]);
    assert.equal(reasonOf(w, S1, 'not-running'), null);
  });

  test('the session is the one the terminal shows, else the one it was opened for', (t) => {
    const w = ended(
      t,
      [
        terminal({ id: 'aaaaaaaaaaa1', expectedSessionId: S1, sessionId: S2 }),
        terminal({ id: 'aaaaaaaaaaa2', expectedSessionId: S1, sessionId: null }),
      ],
      [endedUnexpectedly(S1), endedUnexpectedly(S2)],
    );
    w.attention.refreshed();
    assert.deepEqual(w.writes, [
      [
        { sessionId: S2, windowEndNs: T0 + 5n * SEC },
        { sessionId: S1, windowEndNs: T0 + 5n * SEC },
      ],
    ]);
  });

  test('before the marks are read nothing is judged; the first refresh after they are judges it', (t) => {
    let busy = true;
    const w = world(t, {
      terminals: [terminal({ id: 'aaaaaaaaaaaa' })],
      rows: [endedUnexpectedly(S1)],
      wrap: (deck) =>
        deckWith(deck, {
          store: {
            attention: () => {
              if (busy) throw sqliteError();
              return deck.store.attention();
            },
          },
        }),
    });
    w.attention.look();
    assert.equal(w.attention.refreshed(), false);
    assert.deepEqual(w.writes, []);
    assert.deepEqual(w.logs, [
      'attention: the marks cannot be read yet, the database is busy (Error (ERR_SQLITE_ERROR))',
    ]);
    busy = false;
    w.attention.look();
    assert.equal(w.attention.refreshed(), true);
    assert.equal(stored(w.d)[0]?.windowEndNs, T0 + 5n * SEC);
  });

  test('a terminal whose session is no row skydeck knows is judged at once, to nothing: a row that appears later records nothing for it', (t) => {
    const w = ended(t, [terminal({ id: 'aaaaaaaaaaaa', sessionId: S3 })], [endedUnexpectedly(S1)]);
    assert.equal(w.attention.refreshed(), false);
    w.rows.push(endedUnexpectedly(S3));
    assert.equal(w.attention.refreshed(), false);
    assert.deepEqual(w.writes, []);
  });

  test('a terminal gone from the list is forgotten: listed again later, it is judged again', (t) => {
    const w = ended(t, [terminal({ id: 'aaaaaaaaaaaa' })], [listRow({ id: S1 })]);
    w.attention.refreshed();
    w.terminals.pop();
    w.attention.refreshed();
    w.terminals.push(terminal({ id: 'aaaaaaaaaaaa' }));
    w.rows.splice(0, 1, endedUnexpectedly(S1));
    w.attention.refreshed();
    assert.equal(stored(w.d)[0]?.windowEndSeq, 1);
  });
});

describe('ready() (B12)', () => {
  test('false until the marks are read and refreshed() was called after it; true after', (t) => {
    let busy = true;
    const w = world(t, {
      wrap: (deck) =>
        deckWith(deck, {
          store: {
            attention: () => {
              if (busy) throw sqliteError();
              return deck.store.attention();
            },
          },
        }),
    });
    assert.equal(w.attention.ready(), false);
    w.attention.look();
    w.attention.refreshed();
    assert.equal(w.attention.ready(), false, 'a refresh before the marks are read');
    busy = false;
    w.attention.look();
    assert.equal(w.attention.ready(), false, 'the marks are read, no refresh since');
    w.attention.refreshed();
    assert.equal(w.attention.ready(), true);
    w.attention.look();
    assert.equal(w.attention.ready(), true);
  });

  test("a busy store at the start: ready() waits until the first refresh's window ends are stored, so the first judgement holds them and nothing notifies (ruled); then it stays true", (t) => {
    const d = testDeck(t);
    const w = world(t, {
      d,
      deck: guardedDeck(t, d),
      terminals: [
        terminal({ id: 'aaaaaaaaaaa1', sessionId: S1 }),
        terminal({ id: 'aaaaaaaaaaa2', sessionId: S2 }),
      ],
      rows: [endedUnexpectedly(S1), endedUnexpectedly(S2), running(S3)],
    });
    const sent: NotifyMessage[] = [];
    const notifier = createNotifier({
      needs: () =>
        new Map(
          w.rows.flatMap((r) => {
            const attention = attentionOf(r, w.attention.facts());
            return attention === null ? [] : [[r.id, { title: r.title, attention }] as const];
          }),
        ),
      ready: () => w.attention.ready(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    liveFile(d, PID, S3, 'busy', T0);
    w.attention.look();
    const lock = lockStore(t, d);
    w.attention.refreshed(); // the two window ends are kept
    assert.equal(w.attention.ready(), false);
    notifier.check();
    lock.release();
    w.attention.look(); // stored now
    assert.equal(w.attention.ready(), true);
    notifier.check(); // the first judgement: both ends in it, nothing sent
    assert.equal(sent.length, 0);

    const again = lockStore(t, d);
    liveFile(d, PID, S3, 'idle', T0 + SEC);
    w.attention.look(); // S3's turn end is kept
    assert.equal(w.attention.ready(), true, 'once true, it stays');
    again.release();
    w.attention.look();
    notifier.check();
    assert.deepEqual(
      sent.map((message) => [message.sessionId, message.reason]),
      [[S3, 'finished']],
    );
  });
});

describe("never throws (ruled: it is the tick and Seen's listener, and neither may throw)", () => {
  test('a take() that throws: look and seenNow log it by kind, once until it works again, and say false', (t) => {
    let failing = true;
    const w = world(t, {
      take: () => {
        if (failing) throw new TypeError('broken');
        return new Set();
      },
    });
    liveFile(w.d, PID, S1, 'busy', T0);
    assert.equal(w.attention.look(), true, 'the statuses it took before the failure are facts');
    assert.equal(w.attention.look(), false);
    assert.equal(w.attention.seenNow(), false);
    w.attention.seenNow();
    assert.deepEqual(w.logs, [
      'attention: the look failed (TypeError)',
      'attention: the seen could not be written (TypeError)',
    ]);
    failing = false;
    w.attention.look();
    w.attention.seenNow();
    failing = true;
    w.attention.look();
    w.attention.seenNow();
    assert.equal(w.logs.length, 4);
  });

  test('a hub whose list() throws: refreshed logs it by kind, once until it works again, and says false', (t) => {
    let failing = true;
    const w = world(t);
    const attention = createAttention({
      deck: w.d.deck,
      hub: {
        list: () => {
          if (failing) throw new RangeError('broken');
          return [];
        },
      },
      seen: w.seen,
      rows: () => w.rows,
      log: (line) => {
        w.logs.push(line);
      },
      storeNewer: () => {},
    });
    attention.look();
    assert.equal(attention.refreshed(), false);
    attention.refreshed();
    assert.equal(attention.ready(), false);
    failing = false;
    attention.refreshed();
    assert.equal(attention.ready(), true);
    failing = true;
    attention.refreshed();
    assert.deepEqual(w.logs, [
      'attention: the window ends could not be judged (RangeError)',
      'attention: the window ends could not be judged (RangeError)',
    ]);
  });

  test("a store that fails every write: Seen's typed, which calls seenNow, never throws to its caller", (t) => {
    const w = world(t, {
      wrap: (deck) =>
        deckWith(deck, {
          store: {
            recordAttention: () => {
              throw sqliteError(11); // CORRUPT: no busy store, not kept
            },
          },
        }),
    });
    w.seen.onChange(() => {
      w.attention.seenNow();
    });
    liveFile(w.d, PID, S1, 'busy', T0);
    w.d.deck.store.recordAttention([{ sessionId: S1, windowEndNs: T0 }]);
    w.attention.look();
    assert.doesNotThrow(() => {
      w.seen.typed(w.page, S1);
    });
    assert.deepEqual(w.logs, [
      'attention: a write failed and is dropped (Error (ERR_SQLITE_ERROR))',
    ]);
  });
});
