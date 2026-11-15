// Restore in the window's server (plan C task 74; S2 11.3, 11.4, 12.7; C6, C7, C9, C19, C22):
// the banner in every list, a restore asked for by a page (`act restore`) or by a command (`POST
// /restore`), one at a time, its report to every page, the dismissal, and the server's stop ending
// a restore before it closes anything. In the test process (A19) on realTestPlatform, with real
// keepers; every program is held at a gate the test opens (window-restore.ts), so that a case
// waits on what happened, not on a time.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { isoFromNs, NS_PER_MINUTE } from '../../src/platform/time.ts';
import type { Ns, Platform } from '../../src/platform/types.ts';
import { readLock } from '../../src/sessions/resume.ts';
import type { ListMessage, RestoreStreamLine } from '../../src/window/protocol.ts';
import { procStartOf, stillRuns, until, within } from '../helpers/keeper.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import type { SpoolFields } from '../helpers/spool.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import type { StandinRecord } from '../helpers/standin.ts';
import { connectTestPage, rowsOf, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestPage } from '../helpers/window.ts';
import {
  EARLIER_BOOT,
  earlierId,
  post,
  postRestore,
  restoreSandbox,
} from '../helpers/window-restore.ts';
import type { RestoreSandbox } from '../helpers/window-restore.ts';

type StartRecord = Extract<StandinRecord, { ev: 'start' }>;

/** C6's refusal while a restore runs. */
const ALREADY_RUNNING = 'a restore is already running; wait until it has finished';
const FINISHED = /^restore finished: /;

const X1 = earlierId(1);
const X2 = earlierId(2);
const X3 = earlierId(3);

/** The `restore-progress` notices a page received so far, in order. */
function notices(page: TestPage): string[] {
  return page.all.flatMap((item) =>
    'text' in item && item.text.t === 'notice' && item.text.kind === 'restore-progress'
      ? [item.text.text]
      : [],
  );
}

/** Waits until `page` has received a notice that `matches`. */
async function noticed(page: TestPage, matches: RegExp | string, ms = WAIT_MS): Promise<void> {
  const test = (text: string): boolean =>
    typeof matches === 'string' ? text === matches : matches.test(text);
  await until(
    () => notices(page).some(test),
    () => `a notice ${String(matches)} in ${JSON.stringify(notices(page))}`,
    ms,
  );
}

function startsOf(d: ServerSandbox, sessionId: string): StartRecord[] {
  return readRecords(d.record).filter(
    (record): record is StartRecord => record.ev === 'start' && record.argv.includes(sessionId),
  );
}

function startOf(d: ServerSandbox, sessionId: string, ms = WAIT_MS): Promise<StartRecord> {
  return waitForRecord(
    d.record,
    (record): record is StartRecord => record.ev === 'start' && record.argv.includes(sessionId),
    ms,
  );
}

/**
 * X1, X2, X3 of the earlier boot, in this list order (X1's activity the latest), none with an
 * end: all three in the banner, all preselected.
 */
function threeSessions(r: RestoreSandbox): void {
  const baseNs = r.d.platform.clock.nowNs() - 90n * NS_PER_MINUTE;
  r.earlierBoot([
    { sessionId: X1, startNs: baseNs + 20n * NS_PER_MINUTE },
    { sessionId: X2, startNs: baseNs + 10n * NS_PER_MINUTE },
    { sessionId: X3, startNs: baseNs },
  ]);
}

/** A list whose banner offers exactly `ids`. */
function offering(page: TestPage, ids: readonly string[]): Promise<ListMessage> {
  return page.list(
    (l) =>
      JSON.stringify(l.banner?.entries.map((entry) => entry.sessionId)) === JSON.stringify(ids),
    `the banner offering ${ids.join(', ')}`,
  );
}

function outcomeOf(lines: readonly (RestoreStreamLine | string)[]): unknown {
  const last = lines.at(-1);
  return typeof last === 'object' && 'outcome' in last ? last.outcome : null;
}

describe('the banner (S2 12.7, plan C9)', () => {
  test("three sessions of an earlier boot: the first list's banner names them in list order, two preselected, lastActivityNs that boot's last event", async (t) => {
    const r = restoreSandbox(t);
    const { d } = r;
    const lastNs = d.platform.clock.nowNs() - 30n * NS_PER_MINUTE;
    const minutes = (n: number): Ns => BigInt(n) * NS_PER_MINUTE;
    r.earlierBoot([
      // List order by last activity: X3 (its end), X2 (its end), X1.
      { sessionId: X1, startNs: lastNs - minutes(50) }, // no exit recorded: preselected
      { sessionId: X2, startNs: lastNs - minutes(40), endNs: lastNs - minutes(20) }, // long before
      { sessionId: X3, startNs: lastNs - minutes(30), endNs: lastNs, wasWorking: true },
    ]);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    const list = await page.next('list', 'the first list');
    const banner = list.banner;
    assert.ok(banner !== null, 'a banner');
    assert.deepEqual(
      banner.entries.map(({ sessionId, preselected, wasWorking }) => ({
        sessionId,
        preselected,
        wasWorking,
      })),
      [
        { sessionId: X3, preselected: true, wasWorking: true },
        { sessionId: X2, preselected: false, wasWorking: false },
        { sessionId: X1, preselected: true, wasWorking: false },
      ],
    );
    assert.deepEqual(
      rowsOf(list)
        .map((row) => row.id)
        .filter((id) => [X1, X2, X3].includes(id)),
      [X3, X2, X1],
      "the banner's order is the list's",
    );
    assert.equal(banner.bootId, EARLIER_BOOT);
    assert.equal(banner.lastActivityNs, String(lastNs));
    assert.deepEqual(
      banner.entries.map((entry) => entry.endedAtNs),
      [String(lastNs), String(lastNs - minutes(20)), null],
    );
    assert.equal(banner.shown, true);
    assert.equal(banner.running, false);
  });

  test("dismiss-restore: both pages' banners shown false, the kv entry; after stop() a new server on the same sandbox still shown false; another boot is refused", async (t) => {
    const r = restoreSandbox(t);
    const { d } = r;
    threeSessions(r);
    const test = await d.start();
    const a = await connectTestPage(t, d, test.server);
    const b = await connectTestPage(t, d, test.server);
    const offer = await offering(a, [X1, X2, X3]);
    await offering(b, [X1, X2, X3]);

    const other = await a.act({
      kind: 'dismiss-restore',
      bootId: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(other.error, 'this offer to restore is no longer shown');
    assert.equal(d.deck.store.getKv('window_restore_dismissed'), null);

    const result = await a.act({ kind: 'dismiss-restore', bootId: EARLIER_BOOT });
    assert.deepEqual(
      { ok: result.ok, lines: result.lines, sessionId: result.sessionId },
      { ok: true, lines: [], sessionId: null },
    );
    assert.equal(offer.banner?.bootId, EARLIER_BOOT);
    for (const page of [a, b]) {
      await page.list((l) => l.banner?.shown === false, 'the banner no longer shown');
    }
    assert.equal(d.deck.store.getKv('window_restore_dismissed'), EARLIER_BOOT);

    await test.server.stop('the test restarts it');
    const again = await d.start();
    const c = await connectTestPage(t, d, again.server);
    const first = await c.next('list', "the new server's first list");
    assert.equal(first.banner?.shown, false);
    assert.equal(first.banner?.bootId, EARLIER_BOOT, 'the offer is still there for the switcher');
  });
});

describe('a restore from a page (S2 12.7, plan C6, C7)', () => {
  test("act restore starts the banner's sessions, restoreBatch at a time; one restore at a time (C6); each page's notices end with exactly one `restore finished:` line", async (t) => {
    // The gates are held while the case looks: no start may time out meanwhile.
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const { d } = r;
    threeSessions(r);
    const test = await d.start();
    const a = await connectTestPage(t, d, test.server);
    const b = await connectTestPage(t, d, test.server);
    const offer = await offering(a, [X1, X2, X3]);
    await offering(b, [X1, X2, X3]);
    assert.ok(offer.banner?.entries.every((entry) => entry.preselected));

    const result = await a.act({ kind: 'restore', sessionIds: [X1, X2, X3] });
    assert.deepEqual(
      { ok: result.ok, lines: result.lines, error: result.error, sessionId: result.sessionId },
      { ok: true, lines: [], error: null, sessionId: null },
      'answered once the run has begun; it selects nothing (C21)',
    );
    await until(() => r.waiting(X1) && r.waiting(X2), 'the first batch at its gates', WAIT_MS);
    assert.equal(r.waiting(X3), false, 'restoreBatch 2: the third is not opened yet');

    // While it runs: B's banner says so, and every other request is refused.
    const running = await b.list((l) => l.banner?.running === true, "B's banner: running");
    assert.equal(running.banner?.shown, true);
    const refused = await b.act({ kind: 'restore', sessionIds: [X1] });
    assert.deepEqual(
      { ok: refused.ok, error: refused.error },
      { ok: false, error: ALREADY_RUNNING },
    );
    const command = postRestore(d, { sessionIds: [X3], all: false });
    assert.equal((await command.ended).status, 200);
    assert.deepEqual(command.lines, [
      { line: ALREADY_RUNNING },
      { outcome: { code: 1, started: 0, timedOut: 0, failed: 0, notStarted: 0 } },
    ]);

    r.open(X1);
    r.open(X2);
    // The third is opened only once the first two reported their start.
    await until(() => r.waiting(X3), 'the second batch opened', WAIT_MS);
    assert.equal(startsOf(d, X1).length, 1, 'X1 started before the second batch');
    assert.equal(startsOf(d, X2).length, 1, 'X2 started before the second batch');
    r.open(X3);

    for (const page of [a, b]) {
      await noticed(page, 'restore finished: 3 started');
    }
    const seen = notices(a);
    assert.deepEqual(notices(b), seen, 'both pages got the same report');
    assert.equal(seen.length, 4, JSON.stringify(seen));
    assert.deepEqual(
      seen
        .slice(0, 2)
        .map((line) => line.split(' ').slice(0, 2).join(' '))
        .sort(),
      [`started ${X1.slice(0, 8)}`, `started ${X2.slice(0, 8)}`],
    );
    assert.match(seen[2] ?? '', new RegExp(`^started ${X3.slice(0, 8)} `));
    assert.equal(seen.filter((line) => FINISHED.test(line)).length, 1, 'one end mark');
    assert.equal(seen.at(-1), 'restore finished: 3 started');

    assert.deepEqual(
      test.server.hub
        .list()
        .map((term) => term.slot)
        .sort(),
      [1, 2, 3],
    );
    await a.list((l) => l.banner === null, 'the banner gone: nothing left to offer');
  });

  test('restore does not open a second terminal for a session the window is starting', async (t) => {
    const r = restoreSandbox(t);
    const { d } = r;
    threeSessions(r);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]);
    const resumed = await page.act({ kind: 'resume', sessionId: X1, cols: 80, rows: 24 });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    await until(() => r.waiting(X1), "the page's resume at its gate", WAIT_MS);

    const result = await page.act({ kind: 'restore', sessionIds: [X1] });
    assert.equal(result.ok, true, JSON.stringify(result));
    await noticed(page, FINISHED);
    assert.deepEqual(notices(page), [
      `failed ${X1.slice(0, 8)}: this session is already open in the window`,
      'restore finished: 1 failed',
    ]);
    assert.equal(test.server.hub.list().length, 1, 'one terminal');
  });

  test('a session whose program exits at once: `failed <short>: claude ended before the session started (status 3)`, its lock gone; restored again, its ended terminal is closed first (restoreTerminal)', async (t) => {
    // Only the terminal's end can say it before the start's time is up (a timeout says `timed out`).
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const { d } = r;
    threeSessions(r);
    r.open(X1, 3);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]);
    const begun = performance.now();
    const result = await page.act({ kind: 'restore', sessionIds: [X1] });
    assert.equal(result.ok, true, JSON.stringify(result));
    await noticed(page, FINISHED);
    assert.deepEqual(notices(page), [
      `failed ${X1.slice(0, 8)}: claude ended before the session started (status 3)`,
      'restore finished: 1 failed',
    ]);
    assert.ok(performance.now() - begun < 60_000, 'well before the start timeout');
    assert.equal(readLock(d.deck, X1), null, 'its lock given back');
    assert.deepEqual(startsOf(d, X1), []);
    assert.deepEqual(
      test.server.hub.list().map((term) => term.state),
      ['ended'],
      'its ended terminal is listed',
    );

    // Restored again: the terminal restore opens with closes the session's ended one first.
    r.shut(X1);
    const again = await page.act({ kind: 'restore', sessionIds: [X1] });
    assert.equal(again.ok, true, JSON.stringify(again));
    await until(() => r.waiting(X1), "the second restore's program at its gate", WAIT_MS);
    const terms = test.server.hub.list();
    assert.equal(
      terms.length,
      1,
      `one terminal: the ended one was closed before the new one opened (${terms.map((term) => term.state).join(', ')})`,
    );
    assert.notEqual(terms[0]?.state, 'ended');
  });

  test("act restore takes the banner's set (`all` false): a session of an older boot is no longer offered", async (t) => {
    const r = restoreSandbox(t);
    const { d } = r;
    threeSessions(r);
    const old = earlierId(9);
    r.earlierBoot(
      [{ sessionId: old, startNs: d.platform.clock.nowNs() - 300n * NS_PER_MINUTE }],
      '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    );
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]); // the latest earlier boot's, not the older one's
    const result = await page.act({ kind: 'restore', sessionIds: [old] });
    assert.equal(result.ok, true, JSON.stringify(result));
    await noticed(page, FINISHED);
    assert.deepEqual(notices(page), [
      `failed ${old.slice(0, 8)}: no longer offered for restore`,
      'restore finished: 1 failed',
    ]);
    assert.equal(r.waiting(old), false, 'nothing opened for it');
  });
});

describe('while a restore waits (S2 10.1: the rows follow the store)', () => {
  test("the events the restore's looks ingest on the server's connection reach the lists: the rows are loaded again", async (t) => {
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const { d } = r;
    threeSessions(r);
    const ys = [1, 2, 3].map((n) => `f000000${n}-cccc-4ccc-8ccc-cccccccccccc`);
    // Their transcripts first, so that each is a row before its start event comes (the tick's
    // scan reads a transcript; a look of the restore reads only the spool).
    const folder = join(d.s.claudeHome, 'projects', 'project');
    const nowNs = d.platform.clock.nowNs();
    for (const sessionId of ys) {
      const record = (type: string, atNs: bigint): string =>
        `${JSON.stringify({ type, sessionId, timestamp: isoFromNs(atNs), cwd: d.s.home, entrypoint: 'cli' })}\n`;
      writeFileSync(
        join(folder, `${sessionId}.jsonl`),
        record('user', nowNs - 66n * NS_PER_MINUTE) +
          record('assistant', nowNs - 65n * NS_PER_MINUTE),
      );
    }
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.list(
      (l) => ys.every((id) => rowsOf(l).some((row) => row.id === id)),
      'the three rows, from their transcripts',
    );
    const result = await page.act({ kind: 'restore', sessionIds: [X1] });
    assert.equal(result.ok, true, JSON.stringify(result));
    await until(() => r.waiting(X1), 'the restore waits for X1 at its gate', WAIT_MS);

    // Each one's start in the earlier boot, while the restore waits: a look of the restore (one
    // a second) or the tick's refresh (one every 2 s) ingests it, whichever comes first — three,
    // so that a look takes at least one on any but a rare run. Ingested, the session is offered:
    // the banner's entries show whether the rows were loaded again.
    mkdirSync(d.deck.places.spoolDir, { recursive: true });
    for (const [index, sessionId] of ys.entries()) {
      const fields: SpoolFields = {
        event: 'SessionStart',
        timeNs: nowNs - 70n * NS_PER_MINUTE,
        pid: 4_200_000 + index,
        procStart: 4242, // no live process has it: it is not running
        bootId: EARLIER_BOOT,
        pwd: d.s.home,
        input: hookInput('SessionStart', sessionId, { source: 'startup', cwd: d.s.home }),
      };
      writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, index)), spoolText(fields));
      await until(
        () => d.deck.store.events().some((event) => event.sessionId === sessionId),
        `the start of ${sessionId.slice(0, 8)} ingested`,
        WAIT_MS,
      );
      await page.list(
        (l) => l.banner?.entries.some((entry) => entry.sessionId === sessionId) === true,
        `${sessionId.slice(0, 8)} offered while the restore waits`,
      );
    }
    assert.equal(r.waiting(X1) && startsOf(d, X1).length === 0, true, 'the restore still waits');
  });
});

describe('a restore from a command (S2 8.3, 11.4; plan C5, C22)', () => {
  test('POST /restore with all and an id not offered: `failed <short>: no longer offered for restore`, the outcome code 1; the pages get the report', async (t) => {
    const r = restoreSandbox(t);
    const { d } = r;
    threeSessions(r);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]);
    const notOffered = '9f9f9f9f-0000-4000-8000-000000000000';
    const answer = postRestore(d, { sessionIds: [notOffered], all: true });
    assert.equal((await answer.ended).status, 200);
    assert.deepEqual(answer.lines, [
      { line: 'failed 9f9f9f9f: no longer offered for restore' },
      { line: 'restore finished: 1 failed' },
      { outcome: { code: 1, started: 0, timedOut: 0, failed: 1, notStarted: 0 } },
    ]);
    await noticed(page, FINISHED);
    assert.deepEqual(notices(page), [
      'failed 9f9f9f9f: no longer offered for restore',
      'restore finished: 1 failed',
    ]);
    assert.deepEqual(test.server.hub.list(), []);
  });

  test('restoreMinFreeMb 999999999: `stopped: only …`, nothing started, code 5', async (t) => {
    const r = restoreSandbox(t, { config: { restoreMinFreeMb: 999_999_999 } });
    const { d } = r;
    threeSessions(r);
    await d.start();
    const answer = postRestore(d, { sessionIds: [X1, X2], all: false });
    assert.equal((await answer.ended).status, 200);
    const texts = answer.texts();
    assert.match(
      texts[0] ?? '',
      /^stopped: only [0-9]+ MiB of memory available, less than restoreMinFreeMb \(999999999 MiB\)$/,
    );
    assert.deepEqual(
      texts.slice(1).map((line) => line.split(' ').slice(0, 3).join(' ')),
      [`not started ${X1.slice(0, 8)}`, `not started ${X2.slice(0, 8)}`, 'restore finished: 2'],
    );
    assert.equal(texts.at(-1), 'restore finished: 2 not started');
    assert.deepEqual(outcomeOf(answer.lines), {
      code: 5,
      started: 0,
      timedOut: 0,
      failed: 0,
      notStarted: 2,
    });
    assert.equal(r.waiting(X1) || r.waiting(X2), false, 'no program');
  });

  test('a restore asked for by a command stops when its asker goes: the server lives, the opened sessions go on, the rest not started; one `restore finished:` line; a later act restore is accepted', async (t) => {
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const { d } = r;
    threeSessions(r);
    r.open(X1); // X1 starts; X2 waits at its gate; X3 is of the second batch
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]);
    const asker = new AbortController();
    const answer = postRestore(
      d,
      { sessionIds: [X1, X2, X3], all: false },
      {
        signal: asker.signal,
        onLine: (line) => {
          if (typeof line === 'object' && 'line' in line && line.line.startsWith('started ')) {
            asker.abort(); // the asker goes after the first `started` line (Ctrl+C)
          }
        },
      },
    );
    await assert.rejects(answer.ended, (error: unknown) => (error as Error).name === 'AbortError');
    await noticed(page, FINISHED);
    const seen = notices(page);
    assert.deepEqual(
      seen.map((line) => line.split(' ').slice(0, 2).join(' ')),
      [
        `started ${X1.slice(0, 8)}`,
        `timed out`,
        'stopped: the',
        `not started`,
        'restore finished:',
      ],
      JSON.stringify(seen),
    );
    assert.match(seen[1] ?? '', new RegExp(`^timed out ${X2.slice(0, 8)} `));
    assert.equal(seen[2], 'stopped: the command that asked for it stopped');
    assert.match(seen[3] ?? '', new RegExp(`^not started ${X3.slice(0, 8)} `));
    assert.equal(seen[4], 'restore finished: 1 started, 1 timed out, 1 not started');
    assert.equal(seen.filter((line) => FINISHED.test(line)).length, 1);

    // The server lives and the sessions it opened go on.
    const status = await d.platform.net.requestUnix(d.files.serverSock, {
      method: 'GET',
      path: '/status',
      timeoutMs: 10_000,
    });
    assert.equal(status.status, 200);
    const first = startsOf(d, X1)[0];
    assert.ok(first !== undefined);
    const procStart = procStartOf(first.pid);
    assert.ok(procStart !== null && stillRuns(first.pid, procStart), "X1's program runs");
    r.open(X2);
    await startOf(d, X2); // its terminal was opened: it starts the session now
    assert.equal(r.waiting(X3), false, 'X3 was never opened');

    const later = await page.act({ kind: 'restore', sessionIds: [X3] });
    assert.equal(later.ok, true, JSON.stringify(later));
    await until(() => r.waiting(X3), "the later restore's terminal", WAIT_MS);
  });
});

describe("the server's stop (S2 5.5, plan C4, C8)", () => {
  test('the server stopped while a restore waits: a POST /resume once the stop has begun is 503 stopping and starts nothing; stop() resolves within 10 s; the stream got `stopped: …` and code 5; one `restore finished:` line; the started stand-ins still run', async (t) => {
    // The restore's looks of the wait (one a second, clock.sleep(1000)) can be held, so that the
    // stop is seen to have begun while the restore still waits. Let go before the sandbox's own
    // hooks run (they stop the server, which waits for the restore): a case that fails while the
    // hold is on ends instead of hanging.
    let hold: Promise<void> | null = null;
    let release = (): void => {};
    let held = false;
    t.after(() => {
      release();
    });
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const { d } = r;
    threeSessions(r);
    r.open(X1);
    const test = await d.start({
      platform: (p): Platform => ({
        ...p,
        clock: {
          ...p.clock,
          sleep: async (ms) => {
            if (hold !== null && ms === 1000) {
              held = true;
              await hold;
            }
            return p.clock.sleep(ms);
          },
        },
      }),
    });
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]);
    const answer = postRestore(d, { sessionIds: [X1, X2, X3], all: false });
    await until(
      () => answer.texts().some((line) => line.startsWith(`started ${X1.slice(0, 8)}`)),
      'X1 started; X2 is waited for',
      WAIT_MS,
    );
    const first = startsOf(d, X1)[0];
    assert.ok(first !== undefined);
    const procStart = procStartOf(first.pid);
    assert.ok(procStart !== null);
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await until(() => held, "the restore's next look held", WAIT_MS);

    const stopped = test.server.stop('the test stops it');
    const resume = await post(d, '/resume', { sessionId: X3 });
    assert.deepEqual(resume, { status: 503, body: { error: 'stopping' } });
    const before = performance.now();
    release();
    await within(stopped, 'the stop', 10_000);
    assert.ok(performance.now() - before < 10_000);

    assert.equal((await answer.ended).status, 200);
    const texts = answer.texts();
    assert.ok(texts.includes("stopped: the window's server is stopping"), JSON.stringify(texts));
    assert.deepEqual(outcomeOf(answer.lines), {
      code: 5,
      started: 1,
      timedOut: 1,
      failed: 0,
      notStarted: 1,
    });
    assert.equal(r.waiting(X3), false, 'nothing started for X3');
    assert.equal(startsOf(d, X3).length, 0);
    const seen = notices(page);
    assert.equal(seen.filter((line) => FINISHED.test(line)).length, 1, JSON.stringify(seen));
    assert.equal(seen.at(-1), 'restore finished: 1 started, 1 timed out, 1 not started');
    assert.ok(stillRuns(first.pid, procStart), "X1's program runs on after the stop");
  });
});

describe('the take mark end to end (C19, task 80)', () => {
  test("a restored session whose program ends after the restore stopped waiting: at the next refresh its lock, which the restore renewed, is gone, and its ended bar's Resume is not refused", async (t) => {
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 2 } });
    const { d } = r;
    threeSessions(r);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]);
    const result = await page.act({ kind: 'restore', sessionIds: [X1] });
    assert.equal(result.ok, true, JSON.stringify(result));
    await noticed(page, FINISHED);
    assert.match(notices(page)[0] ?? '', new RegExp(`^timed out ${X1.slice(0, 8)} `));
    assert.notEqual(readLock(d.deck, X1), null, 'the lock kept after the timeout (renewed)');

    r.open(X1, 3); // the program ends now, after the wait
    await until(() => readLock(d.deck, X1) === null, 'the lock given back', WAIT_MS);
    await page.list(
      (l) => l.terminals.some((term) => term.state === 'ended'),
      "the terminal's ended bar",
    );
    r.open(X1); // the next program of X1 goes on to the stand-in
    const resumed = await page.act({ kind: 'resume', sessionId: X1, cols: 80, rows: 24 });
    assert.deepEqual(
      { ok: resumed.ok, error: resumed.error, sessionId: resumed.sessionId },
      { ok: true, error: null, sessionId: X1 },
    );
  });

  test('a restore whose keeper says hello after the 5 s of open(): the session is started, not `failed … taken over`', async (t) => {
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const { d } = r;
    threeSessions(r);
    r.open(X1);
    // Stage A's seam (window-terminal.test.ts, slowPython; copied, it is no seam of its own):
    // python3 that sleeps 7 s before it runs the real one.
    const slow = join(d.s.root, 'slow-bin');
    mkdirSync(slow);
    const python = join(slow, 'python3');
    writeFileSync(python, `#!/bin/sh\nsleep 7\nexec ${join(d.s.bin, 'python3')} "$@"\n`);
    chmodSync(python, 0o755);
    const test = await d.start({
      platform: (p) => ({ ...p, env: { ...p.env, PATH: `${slow}:${d.s.bin}` } }),
    });
    const page = await connectTestPage(t, d, test.server);
    await offering(page, [X1, X2, X3]);
    const result = await page.act({ kind: 'restore', sessionIds: [X1] });
    assert.equal(result.ok, true, JSON.stringify(result));
    await noticed(page, FINISHED, 60_000);
    assert.deepEqual(
      notices(page).map((line) => line.split(' ').slice(0, 2).join(' ')),
      [`started ${X1.slice(0, 8)}`, 'restore finished:'],
      JSON.stringify(notices(page)),
    );
    assert.equal(notices(page).at(-1), 'restore finished: 1 started');
    assert.equal(startsOf(d, X1).length, 1);
  });
});
