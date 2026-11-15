// The restorer (plan C 2.3, task 73): the one coordinator of restores in the window's server —
// C5, C6, C7, C9, C17, C22, C23 — tested without a server: the window terminal, the refusal and
// `gone` are injected, the platform is testPlatform through restoreDeck.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { SkydeckError } from '../../src/platform/errors.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { lockKey, lockTakenNs, readLock } from '../../src/sessions/resume.ts';
import type { LaunchSpec, OpenResult } from '../../src/terminals/types.ts';
import type { RestoreOutcomeLine, RestoreStreamLine } from '../../src/window/protocol.ts';
import { createRestorer } from '../../src/window/restorer.ts';
import type { Restorer } from '../../src/window/restorer.ts';
import { deckWith } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_A, BOOT_B, T0 } from '../helpers/platform.ts';
import {
  BOOT_C,
  HOUR,
  MINUTE,
  addSession,
  fakeTabs,
  restoreDeck,
  sid,
} from '../helpers/restore.ts';

type Size = { cols: number; rows: number };

const CONFIG = { restoreBatch: 2, restoreStartTimeoutSeconds: 3, restoreMinFreeMb: 4096 };

const BUSY = (): Error =>
  Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

/** `count` sessions that ended unexpectedly in BOOT_A, in list order sid(1)…, all preselected. */
function restarted(
  t: TestContext,
  count: number,
  options: Parameters<typeof restoreDeck>[1] = {},
): TestDeck {
  const d = restoreDeck(t, { config: CONFIG, ...options });
  for (let n = 1; n <= count; n++) {
    addSession(d, sid(n), {
      boot: BOOT_A,
      pid: 100 + n,
      startNs: T0 - HOUR,
      activityNs: T0 - BigInt(n) * MINUTE,
    });
  }
  refresh(d.deck);
  return d;
}

interface World {
  restorer: Restorer;
  /** Every line `progress` got, in order. */
  progress: string[];
  /** The log's lines. */
  logs: string[];
  /** How many lines `progress` had got at each call of `changed()`. */
  changed: number[];
  /** The size each terminal was built with, in order. */
  sizes: Size[];
  /** The specs the terminals opened, in order. */
  specs: LaunchSpec[];
  /** The size `size()` answers now. */
  size: Size;
}

interface WorldOptions {
  deck?: Deck;
  /** Default: every session's claude starts. */
  starts?: (id: string) => boolean;
  result?: (id: string) => OpenResult | 'reject';
  onOpen?: (count: number, id: string) => void;
  refuse?: (id: string) => string | null;
  gone?: (id: string) => string | null;
  heartbeatMs?: number;
  /** Called at each changed(), after it was counted. */
  onChanged?: () => void;
}

function world(d: TestDeck, options: WorldOptions = {}): World {
  const tabs = fakeTabs(d, {
    starts: options.starts,
    result: options.result,
    onOpen: options.onOpen,
  });
  const w: World = {
    restorer: undefined as unknown as Restorer,
    progress: [],
    logs: [],
    changed: [],
    sizes: [],
    specs: tabs.specs,
    size: { cols: 120, rows: 40 },
  };
  w.restorer = createRestorer({
    deck: options.deck ?? d.deck,
    terminalFor: (size) => {
      w.sizes.push(size);
      return tabs.terminal;
    },
    refuse: options.refuse ?? (() => null),
    gone: options.gone ?? (() => null),
    size: () => ({ ...w.size }),
    progress: (text) => w.progress.push(text),
    changed: () => {
      w.changed.push(w.progress.length);
      options.onChanged?.();
    },
    log: (line) => w.logs.push(line),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  return w;
}

/** A stream's lines and its outcome (which must come last, once). */
function stream(written: readonly RestoreStreamLine[]): {
  lines: string[];
  outcome: RestoreOutcomeLine | undefined;
} {
  const outcomes = written.filter((line) => 'outcome' in line);
  assert.ok(outcomes.length <= 1, JSON.stringify(written));
  const last = written.at(-1);
  if (outcomes.length === 1) assert.ok(last !== undefined && 'outcome' in last);
  return {
    lines: written.flatMap((line) => ('line' in line ? [line.line] : [])),
    outcome: last !== undefined && 'outcome' in last ? last.outcome : undefined,
  };
}

/** start, then its done; the stream it wrote. */
async function restore(
  w: World,
  sessionIds: string[],
  asker?: AbortSignal,
): Promise<{ lines: string[]; outcome: RestoreOutcomeLine | undefined }> {
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start({ sessionIds, all: false }, (line) => written.push(line), asker);
  assert.ok(started.ok, JSON.stringify(started));
  await started.done;
  return stream(written);
}

/** `<verb> <short> <title>` for session n, as runRestore reports it. */
function about(d: TestDeck, verb: string, n: number): string {
  const row = loadRows(d.deck).find((r) => r.id === sid(n));
  return `${verb} ${sid(n).slice(0, 8)} ${row?.title ?? '?'}`;
}

/** The progress lines hold exactly one `restore finished:` line, as the last. */
function endsOnce(progress: readonly string[]): void {
  assert.equal(
    progress.filter((line) => line.startsWith('restore finished:')).length,
    1,
    progress.join('\n'),
  );
  assert.match(progress.at(-1) ?? '', /^restore finished: /);
}

const ZERO = { started: 0, timedOut: 0, failed: 0, notStarted: 0 };
const MS = 1_000_000n;

/** Calls `fn` at the first sleep of the clock (the first second of a wait), once. */
function atFirstSleep(d: TestDeck, fn: () => void): void {
  const sleep = d.clock.sleep;
  let done = false;
  d.clock.sleep = (ms) => {
    if (!done) {
      done = true;
      fn();
    }
    return sleep(ms);
  };
}

// --- a run ---------------------------------------------------------------------------------------

test('a run of three over a batch of two: started three times, one finished line, the outcome last', async (t) => {
  const d = restarted(t, 3);
  const w = world(d, {
    onOpen: (count) => {
      if (count === 2) w.size = { cols: 200, rows: 50 }; // the page's area changes between batches
    },
  });
  const { lines, outcome } = await restore(w, [1, 2, 3].map(sid));
  const expected = [
    about(d, 'started', 1),
    about(d, 'started', 2),
    about(d, 'started', 3),
    'restore finished: 3 started',
  ];
  assert.deepEqual(w.progress, expected);
  assert.deepEqual(lines, expected);
  assert.deepEqual(outcome, { code: 0, ...ZERO, started: 3 });
  assert.deepEqual(
    w.specs.map((spec) => spec.sessionId),
    [1, 2, 3].map(sid),
  );
  // Each terminal is built with the size of the moment it is opened (C7).
  assert.deepEqual(w.sizes, [
    { cols: 120, rows: 40 },
    { cols: 120, rows: 40 },
    { cols: 200, rows: 50 },
  ]);
  // changed(): when the run begins (before its first line) and when it is over (after its last).
  assert.deepEqual(w.changed, [0, 4]);
});

test('the banner says running from the start of a run to its end, and not after', async (t) => {
  const d = restarted(t, 2);
  const rows = (): readonly ListRow[] => loadRows(d.deck);
  const seen: (boolean | undefined)[] = [];
  const w = world(d, { onChanged: () => seen.push(w.restorer.banner(rows())?.running) });
  assert.equal(w.restorer.banner(rows())?.running, false);
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.ok(started.ok);
  assert.equal(w.restorer.banner(rows())?.running, true);
  await started.done;
  // At the end sid(2) is still offered: the banner is there, no longer running.
  assert.deepEqual(seen, [true, false]);
});

test('start returns at once: the run has not opened anything when it returns', async (t) => {
  const d = restarted(t, 2);
  const w = world(d);
  const started = w.restorer.start({ sessionIds: [sid(1), sid(2)], all: false });
  assert.ok(started.ok);
  assert.deepEqual(w.specs, []);
  assert.deepEqual(w.progress, []);
  await started.done;
  assert.equal(w.specs.length, 2);
});

test('the set is taken on freshly refreshed rows: a session seen since the last refresh is offered', async (t) => {
  const d = restarted(t, 1);
  // Its transcript and events are there, but no refresh has scanned them yet (C7).
  addSession(d, sid(4), { boot: BOOT_A, pid: 104, startNs: T0 - HOUR, activityNs: T0 - MINUTE });
  const w = world(d);
  const { lines, outcome } = await restore(w, [sid(4)]);
  assert.deepEqual(outcome, { code: 0, ...ZERO, started: 1 }, lines.join('\n'));
});

test('the selected ids are kept in the set’s order, and only those are opened', async (t) => {
  const d = restarted(t, 3);
  const w = world(d);
  const { outcome } = await restore(w, [sid(3), sid(1)]);
  assert.deepEqual(
    w.specs.map((spec) => spec.sessionId),
    [sid(1), sid(3)],
  );
  assert.deepEqual(outcome, { code: 0, ...ZERO, started: 2 });
});

test('a run without write (a page’s act) reports to progress alone and ends the same way', async (t) => {
  const d = restarted(t, 2);
  const w = world(d);
  const started = w.restorer.start({ sessionIds: [sid(1), sid(2)], all: false });
  assert.ok(started.ok);
  await started.done;
  assert.deepEqual(w.progress, [
    about(d, 'started', 1),
    about(d, 'started', 2),
    'restore finished: 2 started',
  ]);
  assert.equal(d.clock.timers(), 0);
});

// --- every run ends with exactly one `restore finished:` line (C6) --------------------------------

/** What one kind of run gives: its progress and its stream. */
async function runOf(
  t: TestContext,
  kind: string,
): Promise<{ progress: string[]; lines: string[]; outcome: RestoreOutcomeLine | undefined }> {
  const waits = { config: { ...CONFIG, restoreStartTimeoutSeconds: 30 } };
  switch (kind) {
    case 'all started': {
      const w = world(restarted(t, 2));
      return { progress: w.progress, ...(await restore(w, [sid(1), sid(2)])) };
    }
    case 'a failure': {
      const w = world(restarted(t, 2), {
        result: (id) =>
          id === sid(2) ? { ok: false, error: 'no tab', timedOut: false } : { ok: true },
      });
      return { progress: w.progress, ...(await restore(w, [sid(1), sid(2)])) };
    }
    case 'the memory stop': {
      const w = world(restarted(t, 2, { memAvailableMb: 3000 }));
      return { progress: w.progress, ...(await restore(w, [sid(1), sid(2)])) };
    }
    case 'the server’s stop': {
      const d = restarted(t, 3, waits);
      const w = world(d, { starts: () => false });
      atFirstSleep(d, () => void w.restorer.stop());
      return { progress: w.progress, ...(await restore(w, [1, 2, 3].map(sid))) };
    }
    case 'the asker’s going': {
      const d = restarted(t, 3, waits);
      const w = world(d, { starts: () => false });
      const asker = new AbortController();
      atFirstSleep(d, () => asker.abort());
      return { progress: w.progress, ...(await restore(w, [1, 2, 3].map(sid), asker.signal)) };
    }
    case 'an empty batch with entries left': {
      const w = world(restarted(t, 3), { starts: () => false });
      return { progress: w.progress, ...(await restore(w, [1, 2, 3].map(sid))) };
    }
    case 'an empty last batch': {
      const w = world(restarted(t, 2), { starts: () => false });
      return { progress: w.progress, ...(await restore(w, [sid(1), sid(2)])) };
    }
    case 'a busy store in the run': {
      const d = restarted(t, 2);
      const deck = deckWith(d.deck, {
        store: {
          hasProcessStartSince: () => {
            throw BUSY();
          },
        },
      });
      const w = world(d, { deck });
      return { progress: w.progress, ...(await restore(w, [sid(1), sid(2)])) };
    }
    case 'a run that fails': {
      const w = world(restarted(t, 2), {
        gone: () => {
          throw new TypeError('x');
        },
        starts: () => false,
      });
      return { progress: w.progress, ...(await restore(w, [sid(1), sid(2)])) };
    }
    case 'a run that cannot begin': {
      const d = restarted(t, 2);
      d.proc.setBootId(null);
      const w = world(d);
      const written: RestoreStreamLine[] = [];
      w.restorer.start({ sessionIds: [sid(1)], all: false }, (line) => written.push(line));
      return { progress: w.progress, ...stream(written) };
    }
  }
  throw new Error(kind);
}

test('every run ends with exactly one `restore finished:` line', async (t) => {
  const runs: [string, string, 0 | 1 | 5][] = [
    ['all started', 'restore finished: 2 started', 0],
    ['a failure', 'restore finished: 1 started, 1 failed', 1],
    ['the memory stop', 'restore finished: 2 not started', 5],
    ['the server’s stop', 'restore finished: 2 timed out, 1 not started', 5],
    ['the asker’s going', 'restore finished: 2 timed out, 1 not started', 5],
    ['an empty batch with entries left', 'restore finished: 2 timed out, 1 not started', 5],
    ['an empty last batch', 'restore finished: 2 timed out', 1],
    ['a busy store in the run', 'restore finished: nothing was started', 1],
    ['a run that fails', 'restore finished: nothing was started', 1],
    ['a run that cannot begin', 'restore finished: nothing was started', 1],
  ];
  for (const [kind, finished, code] of runs) {
    const { progress, lines, outcome } = await runOf(t, kind);
    endsOnce(progress);
    assert.equal(progress.at(-1), finished, kind);
    // The asker hears the same run, its outcome after the finished line.
    assert.deepEqual(lines, progress, kind);
    assert.equal(outcome?.code, code, kind);
  }
});

test('a run with a failure: the failed line, the finished line with both counts, code 1', async (t) => {
  const d = restarted(t, 3);
  const w = world(d, {
    result: (id) =>
      id === sid(2) ? { ok: false, error: 'no tab', timedOut: false } : { ok: true },
    starts: (id) => id !== sid(2),
  });
  const { lines, outcome } = await restore(w, [1, 2, 3].map(sid));
  assert.deepEqual(w.progress, [
    'failed 00000002: no tab',
    about(d, 'started', 1),
    about(d, 'started', 3),
    'restore finished: 2 started, 1 failed',
  ]);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 1, ...ZERO, started: 2, failed: 1 });
  endsOnce(w.progress);
});

test('the memory stop: step 1’s stopped line, the not started lines, the finished line, code 5', async (t) => {
  const d = restarted(t, 3, { memAvailableMb: 3000 });
  const w = world(d);
  const { lines, outcome } = await restore(w, [1, 2, 3].map(sid));
  assert.deepEqual(w.progress, [
    'stopped: only 3000 MiB of memory available, less than restoreMinFreeMb (4096 MiB)',
    about(d, 'not started', 1),
    about(d, 'not started', 2),
    about(d, 'not started', 3),
    'restore finished: 3 not started',
  ]);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 5, ...ZERO, notStarted: 3 });
  assert.deepEqual(w.specs, []);
  endsOnce(w.progress);
});

test('stop() while a batch waits: timed out, the server’s stop, not started, code 5; stop() after done', async (t) => {
  const d = restarted(t, 3, { config: { ...CONFIG, restoreStartTimeoutSeconds: 30 } });
  const w = world(d, { starts: () => false });
  let doneSeen = false;
  const stops: string[] = [];
  let during: ReturnType<Restorer['start']> | undefined;
  atFirstSleep(d, () => {
    void w.restorer.stop().then(() => stops.push(doneSeen ? 'after done' : 'before done'));
    during = w.restorer.start({ sessionIds: [sid(3)], all: false });
  });
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start({ sessionIds: [1, 2, 3].map(sid), all: false }, (line) =>
    written.push(line),
  );
  assert.ok(started.ok);
  void started.done.then(() => {
    doneSeen = true;
  });
  await started.done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, ['after done']);
  // A start while the stopped run is still ending is the server's stop, not "already running".
  assert.deepEqual(during, { ok: false, error: "the window's server is stopping" });
  assert.deepEqual(w.progress, [
    about(d, 'timed out', 1),
    about(d, 'timed out', 2),
    "stopped: the window's server is stopping",
    about(d, 'not started', 3),
    'restore finished: 2 timed out, 1 not started',
  ]);
  const { lines, outcome } = stream(written);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 5, ...ZERO, timedOut: 2, notStarted: 1 });
  endsOnce(w.progress);
  // What the user keeps: the sessions waited for hold their lock, renewed at the look that saw
  // the stop, so that their terminals may still start them and nothing else does.
  for (const n of [1, 2]) {
    assert.equal(lockTakenNs(readLock(d.deck, sid(n)) ?? ''), d.clock.nowNs());
  }
  assert.equal(readLock(d.deck, sid(3)), null);
  // Nothing starts afterwards.
  const after = w.restorer.start({ sessionIds: [sid(3)], all: false });
  assert.deepEqual(after, { ok: false, error: "the window's server is stopping" });
  assert.equal(w.progress.length, 5);
});

test('an asker that goes while a batch waits: the command’s stop, code 5; the server lives on', async (t) => {
  const d = restarted(t, 3, { config: { ...CONFIG, restoreStartTimeoutSeconds: 30 } });
  const w = world(d, { starts: () => false });
  const asker = new AbortController();
  atFirstSleep(d, () => {
    asker.abort();
  });
  const { lines, outcome } = await restore(w, [1, 2, 3].map(sid), asker.signal);
  assert.deepEqual(w.progress, [
    about(d, 'timed out', 1),
    about(d, 'timed out', 2),
    'stopped: the command that asked for it stopped',
    about(d, 'not started', 3),
    'restore finished: 2 timed out, 1 not started',
  ]);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 5, ...ZERO, timedOut: 2, notStarted: 1 });
  endsOnce(w.progress);
  // The restorer is free again.
  const next = await restore(w, [sid(3)]);
  assert.equal(next.outcome?.code, 1); // sid(3)'s claude does not start here either
});

test('an asker gone before the run begins: nothing opened, every entry not started, code 5', async (t) => {
  const d = restarted(t, 2);
  const w = world(d);
  const asker = new AbortController();
  asker.abort();
  const { outcome } = await restore(w, [sid(1), sid(2)], asker.signal);
  assert.deepEqual(w.specs, []);
  assert.deepEqual(w.progress, [
    'stopped: the command that asked for it stopped',
    about(d, 'not started', 1),
    about(d, 'not started', 2),
    'restore finished: 2 not started',
  ]);
  assert.deepEqual(outcome, { code: 5, ...ZERO, notStarted: 2 });
});

test('an asker that fires after the outcome was written does nothing', async (t) => {
  const d = restarted(t, 2);
  const w = world(d);
  const asker = new AbortController();
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start(
    { sessionIds: [sid(1), sid(2)], all: false },
    (line) => {
      written.push(line);
      if ('outcome' in line) asker.abort(); // the command read it and closed: the promise is pending
    },
    asker.signal,
  );
  assert.ok(started.ok);
  await started.done;
  const { outcome } = stream(written);
  assert.deepEqual(outcome, { code: 0, ...ZERO, started: 2 });
  assert.deepEqual(w.progress, [
    about(d, 'started', 1),
    about(d, 'started', 2),
    'restore finished: 2 started',
  ]);
  assert.deepEqual(w.logs, []);
  assert.deepEqual(w.changed, [0, 3]);
});

test('an empty batch with entries left: no session of this batch started, the rest not started, code 5', async (t) => {
  const d = restarted(t, 3);
  const w = world(d, { starts: () => false });
  const { outcome } = await restore(w, [1, 2, 3].map(sid));
  assert.deepEqual(w.progress, [
    about(d, 'timed out', 1),
    about(d, 'timed out', 2),
    'stopped: no session of this batch started',
    about(d, 'not started', 3),
    'restore finished: 2 timed out, 1 not started',
  ]);
  assert.deepEqual(outcome, { code: 5, ...ZERO, timedOut: 2, notStarted: 1 });
  assert.equal(w.specs.length, 2);
  endsOnce(w.progress);
});

test('an empty last (only) batch: its timed out lines, no stopped line, code 1', async (t) => {
  const d = restarted(t, 2);
  const w = world(d, { starts: () => false });
  const { outcome } = await restore(w, [sid(1), sid(2)]);
  assert.deepEqual(w.progress, [
    about(d, 'timed out', 1),
    about(d, 'timed out', 2),
    'restore finished: 2 timed out',
  ]);
  assert.deepEqual(outcome, { code: 1, ...ZERO, timedOut: 2 });
  endsOnce(w.progress);
});

test('a busy store in the run: the busy stop, the finished line, code 1, one log line by kind', async (t) => {
  const d = restarted(t, 3);
  let busy = false;
  const deck = deckWith(d.deck, {
    store: {
      hasProcessStartSince: (...args) => {
        if (busy) throw BUSY();
        return d.deck.store.hasProcessStartSince(...args);
      },
    },
  });
  const w = world(d, {
    deck,
    onOpen: (count) => {
      if (count === 3) busy = true; // the second batch's wait finds the store locked
    },
  });
  const { lines, outcome } = await restore(w, [1, 2, 3].map(sid));
  assert.deepEqual(w.progress, [
    about(d, 'started', 1),
    about(d, 'started', 2),
    "stopped: skydeck's database is busy; press Restore again (or run skydeck restore) for the rest",
    'restore finished: 2 started',
  ]);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 1, ...ZERO, started: 2 });
  assert.deepEqual(w.logs, [
    'restore: the run stopped: the database is busy (Error (ERR_SQLITE_ERROR))',
  ]);
  endsOnce(w.progress);
});

test('a run that fails unexpectedly: what it opened goes on starting, code 1, one log line by kind', async (t) => {
  const d = restarted(t, 3);
  const w = world(d, {
    gone: (id) => {
      if (id === sid(1)) throw new TypeError('a hook fell over with private text');
      return null;
    },
    starts: () => false,
  });
  const { lines, outcome } = await restore(w, [1, 2, 3].map(sid));
  assert.deepEqual(w.progress, [
    'stopped unexpectedly (TypeError); the sessions it opened go on starting: run skydeck to see which',
    'restore finished: nothing was started',
  ]);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 1, ...ZERO });
  assert.deepEqual(w.logs, ['restore: the run failed (TypeError)']);
  // The restorer is free again.
  assert.ok(w.restorer.start({ sessionIds: [sid(3)], all: false }).ok);
});

test('a run that cannot begin (no boot id): its line and the finished line to every page, code 1', (t) => {
  const d = restarted(t, 2);
  d.proc.setBootId(null);
  const w = world(d);
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false }, (line) =>
    written.push(line),
  );
  const why =
    'cannot read the boot id (/proc/sys/kernel/random/boot_id): restore cannot tell which sessions are still running';
  assert.deepEqual(started, { ok: false, error: why });
  assert.deepEqual(w.progress, [why, 'restore finished: nothing was started']);
  const { lines, outcome } = stream(written);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 1, ...ZERO });
  assert.deepEqual(w.changed, []);
  assert.deepEqual(w.specs, []);
  // The user's own refusal: said, not logged.
  assert.deepEqual(w.logs, []);
});

test('a run that cannot begin (a busy store at planning): the busy line, finished, code 1', (t) => {
  const d = restarted(t, 2);
  const deck = deckWith(d.deck, {
    store: {
      events: () => {
        throw BUSY();
      },
    },
  });
  const w = world(d, { deck });
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false }, (line) =>
    written.push(line),
  );
  assert.deepEqual(started, { ok: false, error: "skydeck's database is busy; try again" });
  assert.deepEqual(w.progress, [
    "skydeck's database is busy; try again",
    'restore finished: nothing was started',
  ]);
  assert.deepEqual(stream(written).outcome, { code: 1, ...ZERO });
  assert.deepEqual(w.logs, [
    'restore: could not begin: the database is busy (Error (ERR_SQLITE_ERROR))',
  ]);
});

test('a run that cannot begin for another reason: its kind, never its text, code 1', (t) => {
  const d = restarted(t, 2);
  const deck = deckWith(d.deck, {
    store: {
      events: () => {
        throw new RangeError('private text');
      },
    },
  });
  const w = world(d, { deck });
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.deepEqual(started, { ok: false, error: 'restore could not begin (RangeError)' });
  assert.deepEqual(w.progress, [
    'restore could not begin (RangeError)',
    'restore finished: nothing was started',
  ]);
  assert.deepEqual(w.logs, ['restore: could not begin (RangeError)']);
});

test('a run that cannot begin says a message that quotes foreign text only sanitised', (t) => {
  const d = restarted(t, 2);
  const deck = deckWith(d.deck, {
    store: {
      events: () => {
        throw new SkydeckError('cannot read "a\u001b]0;owned\u0007\u001b[2Jb\nc"');
      },
    },
  });
  const w = world(d, { deck });
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false }, (line) =>
    written.push(line),
  );
  const shown = 'cannot read "ab c"';
  assert.deepEqual(started, { ok: false, error: shown });
  assert.deepEqual(w.progress, [shown, 'restore finished: nothing was started']);
  assert.deepEqual(stream(written).lines, w.progress);
  assert.deepEqual(w.logs, []); // a message is never logged
});

// --- one at a time; a refused request is no run (C6, ruled F1) ----------------------------------

test('a second start while one runs is refused, nothing planned, nothing to progress; after done accepted', async (t) => {
  const d = restarted(t, 3);
  let events = 0;
  const deck = deckWith(d.deck, {
    store: {
      events: () => {
        events += 1;
        return d.deck.store.events();
      },
    },
  });
  const w = world(d, { deck });
  const first = w.restorer.start({ sessionIds: [sid(1), sid(2)], all: false });
  assert.ok(first.ok);
  const before = events;
  const written: RestoreStreamLine[] = [];
  const second = w.restorer.start({ sessionIds: [sid(3)], all: true }, (line) =>
    written.push(line),
  );
  const refusal = 'a restore is already running; wait until it has finished';
  assert.deepEqual(second, { ok: false, error: refusal });
  assert.equal(events, before); // nothing planned for it
  // Its asker alone gets its line and the outcome: no finished line ends the running report.
  assert.deepEqual(written, [{ line: refusal }, { outcome: { code: 1, ...ZERO } }]);
  await first.done;
  assert.deepEqual(w.progress, [
    about(d, 'started', 1),
    about(d, 'started', 2),
    'restore finished: 2 started',
  ]);
  assert.deepEqual(w.changed, [0, 3]);
  const third = await restore(w, [sid(3)]);
  assert.deepEqual(third.outcome, { code: 0, ...ZERO, started: 1 });
});

test('stop() with no run resolves at once, and nothing starts afterwards', async (t) => {
  const d = restarted(t, 1);
  const w = world(d);
  await w.restorer.stop();
  await w.restorer.stop();
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false }, (line) =>
    written.push(line),
  );
  assert.deepEqual(started, { ok: false, error: "the window's server is stopping" });
  assert.deepEqual(written, [
    { line: "the window's server is stopping" },
    { outcome: { code: 1, ...ZERO } },
  ]);
  assert.deepEqual(w.progress, []);
  assert.deepEqual(w.specs, []);
});

// --- the set, refuse, gone (C7, C8) -------------------------------------------------------------

test('an id no longer offered is failed first, before the run; the others start; code 1', async (t) => {
  const d = restarted(t, 2);
  addSession(d, sid(9), { boot: BOOT_B, pid: 109, startNs: T0 }); // runs in this boot: not offered
  const w = world(d);
  const { lines, outcome } = await restore(w, [sid(9), sid(1), sid(42)]);
  assert.deepEqual(w.progress, [
    'failed 00000009: no longer offered for restore',
    'failed 00000042: no longer offered for restore',
    about(d, 'started', 1),
    'restore finished: 1 started, 2 failed',
  ]);
  assert.deepEqual(lines, w.progress);
  assert.deepEqual(outcome, { code: 1, ...ZERO, started: 1, failed: 2 });
  assert.deepEqual(
    w.specs.map((spec) => spec.sessionId),
    [sid(1)],
  );
});

test('all: true offers what ended unexpectedly in any boot', async (t) => {
  const d = restarted(t, 1);
  addSession(d, sid(5), { boot: BOOT_C, pid: 105, startNs: T0 - 2n * HOUR });
  refresh(d.deck);
  const w = world(d);
  const narrow = await restore(w, [sid(5)]);
  assert.deepEqual(narrow.lines, [
    'failed 00000005: no longer offered for restore',
    'restore finished: 1 failed',
  ]);
  const written: RestoreStreamLine[] = [];
  const started = w.restorer.start({ sessionIds: [sid(5)], all: true }, (line) =>
    written.push(line),
  );
  assert.ok(started.ok);
  await started.done;
  assert.deepEqual(stream(written), {
    lines: [about(d, 'started', 5), 'restore finished: 1 started'],
    outcome: { code: 0, ...ZERO, started: 1 },
  });
});

test('a session refuse names: its line, never opened, never locked; the others start', async (t) => {
  const d = restarted(t, 3);
  const w = world(d, {
    refuse: (id) => (id === sid(2) ? 'this session is already open in the window' : null),
  });
  const { outcome } = await restore(w, [1, 2, 3].map(sid));
  assert.ok(w.progress.includes('failed 00000002: this session is already open in the window'));
  assert.deepEqual(
    w.specs.map((spec) => spec.sessionId),
    [sid(1), sid(3)],
  );
  assert.equal(d.deck.store.getKv(lockKey(sid(2))), null);
  assert.deepEqual(outcome, { code: 1, ...ZERO, started: 2, failed: 1 });
  endsOnce(w.progress);
});

test('gone for a session after its terminal opened: failed at the next look, the run goes on, code 1', async (t) => {
  const d = restarted(t, 3);
  const w = world(d, {
    starts: (id) => id !== sid(1),
    gone: (id) => (id === sid(1) ? 'its terminal was closed' : null),
  });
  const { outcome } = await restore(w, [1, 2, 3].map(sid));
  assert.deepEqual(w.progress, [
    'failed 00000001: its terminal was closed',
    about(d, 'started', 2),
    about(d, 'started', 3),
    'restore finished: 2 started, 1 failed',
  ]);
  assert.deepEqual(outcome, { code: 1, ...ZERO, started: 2, failed: 1 });
  assert.equal(readLock(d.deck, sid(1)), null);
});

// --- the heartbeat (C17) ------------------------------------------------------------------------

test('heartbeat: 10 s without a line writes waiting for <n> sessions to write only', async (t) => {
  const d = restarted(t, 2, { config: { ...CONFIG, restoreStartTimeoutSeconds: 25 } });
  const w = world(d, { starts: () => false });
  const { lines } = await restore(w, [sid(1), sid(2)]);
  assert.deepEqual(lines, [
    'waiting for 2 sessions',
    'waiting for 2 sessions',
    about(d, 'timed out', 1),
    about(d, 'timed out', 2),
    'restore finished: 2 timed out',
  ]);
  assert.ok(!w.progress.some((line) => line.startsWith('waiting')), w.progress.join('\n'));
  assert.equal(d.clock.timers(), 0);
});

test('heartbeat: n counts the sessions without an outcome yet; one is one session', async (t) => {
  const d = restarted(t, 2, { config: { ...CONFIG, restoreStartTimeoutSeconds: 15 } });
  const w = world(d, { starts: (id) => id === sid(1) });
  const { lines } = await restore(w, [sid(1), sid(2)]);
  assert.deepEqual(lines, [
    about(d, 'started', 1),
    'waiting for 1 session',
    about(d, 'timed out', 2),
    'restore finished: 1 started, 1 timed out',
  ]);
});

test('heartbeat: n counts only the sessions of the run, not the ids no longer offered', async (t) => {
  const d = restarted(t, 2, { config: { ...CONFIG, restoreStartTimeoutSeconds: 15 } });
  const w = world(d, { starts: () => false });
  const { lines } = await restore(w, [sid(1), sid(2), sid(41), sid(42)]);
  assert.deepEqual(lines, [
    'failed 00000041: no longer offered for restore',
    'failed 00000042: no longer offered for restore',
    'waiting for 2 sessions',
    about(d, 'timed out', 1),
    about(d, 'timed out', 2),
    'restore finished: 2 timed out, 2 failed',
  ]);
});

test('heartbeat: with heartbeatMs 1000, every second without a line', async (t) => {
  const d = restarted(t, 2);
  const w = world(d, { heartbeatMs: 1000, starts: () => false });
  const { lines } = await restore(w, [sid(1), sid(2)]);
  assert.deepEqual(lines, [
    'waiting for 2 sessions',
    'waiting for 2 sessions',
    'waiting for 2 sessions',
    about(d, 'timed out', 1),
    about(d, 'timed out', 2),
    'restore finished: 2 timed out',
  ]);
});

test('heartbeat: every line re-arms it', async (t) => {
  const d = restarted(t, 3, { config: { ...CONFIG, restoreBatch: 3 } });
  const begin = d.clock.nowNs();
  const w = world(d, {
    heartbeatMs: 1500,
    starts: (id) => id === sid(3),
    // sid(2)'s terminal closes at the look one second in.
    gone: (id) =>
      id === sid(2) && d.clock.nowNs() >= begin + 1000n * MS ? 'its terminal was closed' : null,
  });
  const { lines } = await restore(w, [1, 2, 3].map(sid));
  // Without the re-arm at the failed line (1 s) the heartbeat would come at 1.5 s and 3 s.
  assert.deepEqual(lines, [
    about(d, 'started', 3),
    'failed 00000002: its terminal was closed',
    'waiting for 1 session',
    about(d, 'timed out', 1),
    'restore finished: 1 started, 1 timed out, 1 failed',
  ]);
});

// --- the banner and the dismissal (C9) ----------------------------------------------------------

test('dismiss the banner’s boot: stored, changed(), the next banner is not shown', (t) => {
  const d = restarted(t, 2);
  const w = world(d);
  const rows = loadRows(d.deck);
  const banner = w.restorer.banner(rows);
  assert.equal(banner?.bootId, BOOT_A);
  assert.equal(banner?.shown, true);
  assert.deepEqual(w.restorer.dismiss(BOOT_A), { ok: true });
  assert.equal(d.deck.store.getKv('window_restore_dismissed'), BOOT_A);
  assert.equal(w.changed.length, 1);
  const after = w.restorer.banner(rows); // the same rows: the dismissal alone changed
  assert.equal(after?.shown, false);
  assert.equal(after?.entries.length, 2);
});

test('dismiss of another boot, or before any banner: no longer shown, nothing stored', (t) => {
  const d = restarted(t, 2);
  const w = world(d);
  const refused = { ok: false, error: 'this offer to restore is no longer shown' };
  assert.deepEqual(w.restorer.dismiss(BOOT_A), refused);
  w.restorer.banner(loadRows(d.deck));
  assert.deepEqual(w.restorer.dismiss(BOOT_C), refused);
  assert.equal(d.deck.store.getKv('window_restore_dismissed'), null);
  assert.deepEqual(w.changed, []);
});

test('dismiss while the banner only says a restore runs: refused, nothing stored', async (t) => {
  const d = restarted(t, 0);
  const w = world(d);
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.ok(started.ok);
  assert.deepEqual(w.restorer.banner(loadRows(d.deck)), {
    bootId: null,
    lastActivityNs: null,
    entries: [],
    shown: true,
    running: true,
  });
  // A page that still shows an older offer sends its boot.
  assert.deepEqual(w.restorer.dismiss(BOOT_A), {
    ok: false,
    error: 'this offer to restore is no longer shown',
  });
  assert.equal(d.deck.store.getKv('window_restore_dismissed'), null);
  await started.done;
});

test('a dismissal stored by an earlier server hides the banner of that boot', (t) => {
  const d = restarted(t, 1);
  d.deck.store.setKv('window_restore_dismissed', BOOT_A);
  const w = world(d);
  assert.equal(w.restorer.banner(loadRows(d.deck))?.shown, false);
});

test('banner reads the events once for the same rows; again for new rows, a dismissal and a run', async (t) => {
  const d = restarted(t, 2);
  let events = 0;
  let kv = 0;
  const deck = deckWith(d.deck, {
    store: {
      events: () => {
        events += 1;
        return d.deck.store.events();
      },
      getKv: (key) => {
        if (key === 'window_restore_dismissed') kv += 1;
        return d.deck.store.getKv(key);
      },
    },
  });
  const w = world(d, { deck });
  const rows = loadRows(d.deck);
  const first = w.restorer.banner(rows);
  assert.equal(w.restorer.banner(rows), first);
  assert.deepEqual([events, kv], [1, 1]);
  const again = loadRows(d.deck); // a new rows array
  w.restorer.banner(again);
  assert.deepEqual([events, kv], [2, 2]);
  assert.deepEqual(w.restorer.dismiss(BOOT_A), { ok: true });
  w.restorer.banner(again); // the dismissal changed
  w.restorer.banner(again);
  assert.deepEqual([events, kv], [3, 3]);
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.ok(started.ok);
  const planned = events;
  w.restorer.banner(again); // running changed
  w.restorer.banner(again);
  assert.equal(events, planned + 1);
  await started.done;
  w.restorer.banner(again); // running changed back
  assert.ok(events > planned + 1);
});

test('a store that fails while the banner is made keeps the previous one, one log line by kind', (t) => {
  const d = restarted(t, 2);
  let fail = false;
  const deck = deckWith(d.deck, {
    store: {
      events: () => {
        if (fail) throw BUSY();
        return d.deck.store.events();
      },
    },
  });
  const w = world(d, { deck });
  const first = w.restorer.banner(loadRows(d.deck));
  assert.equal(first?.bootId, BOOT_A);
  fail = true;
  const rows = loadRows(d.deck);
  assert.equal(w.restorer.banner(rows), first);
  assert.deepEqual(w.logs, ['restore: the banner was not made (Error (ERR_SQLITE_ERROR))']);
  // It is made again at the next call.
  fail = false;
  const made = w.restorer.banner(rows);
  assert.notEqual(made, first);
  assert.deepEqual(made, first);
});

test('a store that fails while a run goes on: the banner says running all the while, and not after (ruled by the plan owner, task 74)', async (t) => {
  const d = restarted(t, 2);
  let fail = false;
  const deck = deckWith(d.deck, {
    store: {
      // The banner's own read; the run reads no such key.
      getKv: (key) => {
        if (fail && key === 'window_restore_dismissed') throw BUSY();
        return d.deck.store.getKv(key);
      },
    },
  });
  const rows = (): readonly ListRow[] => loadRows(d.deck);
  const seen: (boolean | undefined)[] = [];
  const w = world(d, { deck, onChanged: () => seen.push(w.restorer.banner(rows())?.running) });
  const first = w.restorer.banner(rows());
  assert.equal(first?.running, false);
  fail = true;
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.ok(started.ok);
  const during = w.restorer.banner(rows());
  assert.deepEqual(during, { ...first, running: true }, "the last payload, with the run's flag");
  await started.done;
  assert.deepEqual(seen, [true, false], 'at the run begun and at its end');
  assert.equal(w.restorer.banner(rows()), first, 'after it: the last payload made, as it was');
  // What the failures answered was not kept: made again at the next call that works.
  fail = false;
  const made = w.restorer.banner(rows());
  assert.notEqual(made, first);
  assert.equal(made?.running, false);
});

test('a store that fails after a run whose banner was made while it ran: the offer with running false (ruled by the plan owner, task 74)', async (t) => {
  const d = restarted(t, 2);
  let fail = false;
  const deck = deckWith(d.deck, {
    store: {
      getKv: (key) => {
        if (fail && key === 'window_restore_dismissed') throw BUSY();
        return d.deck.store.getKv(key);
      },
    },
  });
  const rows = (): readonly ListRow[] => loadRows(d.deck);
  const w = world(d, { deck });
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.ok(started.ok);
  const during = w.restorer.banner(rows());
  assert.equal(during?.running, true);
  assert.equal(during?.bootId, BOOT_A, 'made while the run goes on, with its offer');
  fail = true;
  await started.done;
  assert.deepEqual(w.restorer.banner(rows()), { ...during, running: false });
});

test('a store that fails after a run that offered nothing: no banner (null while nothing is offered and no restore runs; ruled by the plan owner, task 74)', async (t) => {
  const d = restarted(t, 2);
  let fail = false;
  const deck = deckWith(d.deck, {
    store: {
      getKv: (key) => {
        if (fail && key === 'window_restore_dismissed') throw BUSY();
        return d.deck.store.getKv(key);
      },
    },
  });
  const none: readonly ListRow[] = [];
  const w = world(d, { deck });
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.ok(started.ok);
  assert.deepEqual(w.restorer.banner(none), {
    bootId: null,
    lastActivityNs: null,
    entries: [],
    shown: true,
    running: true,
  });
  fail = true;
  await started.done;
  assert.equal(w.restorer.banner(none), null);
});

test('a store that fails before any banner was made: while a run goes on, the payload of a run with nothing offered; after it, none', async (t) => {
  const d = restarted(t, 2);
  let fail = true;
  const deck = deckWith(d.deck, {
    store: {
      getKv: (key) => {
        if (fail && key === 'window_restore_dismissed') throw BUSY();
        return d.deck.store.getKv(key);
      },
    },
  });
  const rows = (): readonly ListRow[] => loadRows(d.deck);
  const w = world(d, { deck });
  assert.equal(w.restorer.banner(rows()), null);
  const started = w.restorer.start({ sessionIds: [sid(1)], all: false });
  assert.ok(started.ok);
  assert.deepEqual(w.restorer.banner(rows()), {
    bootId: null,
    lastActivityNs: null,
    entries: [],
    shown: true,
    running: true,
  });
  await started.done;
  assert.equal(w.restorer.banner(rows()), null);
  fail = false;
  assert.notEqual(w.restorer.banner(rows()), null, 'made at the next call that works');
});

test('rows without a boot id: no plan, so no banner (the run that cannot begin says why)', (t) => {
  const d = restarted(t, 2);
  d.proc.setBootId(null);
  const w = world(d);
  assert.equal(w.restorer.banner(loadRows(d.deck)), null);
  assert.deepEqual(w.logs, []);
});

// --- texts ---------------------------------------------------------------------------------------

test('a title holding an escape sequence: no control character in any progress or write line', async (t) => {
  const d = restarted(t, 3);
  d.deck.store.updateMeta(sid(1), { label: 'evil \u001b]0;owned\u0007\u001b[2J\ttitle' }, T0);
  refresh(d.deck);
  const w = world(d, {
    refuse: (id) => (id === sid(2) ? 'refused \u001b[31mred\u001b[0m\u0085' : null),
    result: (id) =>
      id === sid(3)
        ? { ok: false, error: 'broken \u009b2J\u202etab', timedOut: false }
        : { ok: true },
    starts: (id) => id === sid(1),
  });
  const { lines } = await restore(w, [1, 2, 3].map(sid));
  assert.equal(lines.length, 4, lines.join('\n'));
  for (const line of [...w.progress, ...lines]) {
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/, line);
  }
});

// --- what the server gives it -------------------------------------------------------------------

test('a progress, write or changed that throws is logged by kind; the run ends, the restorer is free', async (t) => {
  const d = restarted(t, 3);
  const logs: string[] = [];
  const restorer = createRestorer({
    deck: d.deck,
    terminalFor: () => fakeTabs(d).terminal,
    refuse: () => null,
    gone: () => null,
    size: () => ({ cols: 80, rows: 24 }),
    progress: () => {
      throw new RangeError('private text');
    },
    changed: () => {
      throw new TypeError('private text');
    },
    log: (line) => logs.push(line),
  });
  const written: RestoreStreamLine[] = [];
  const started = restorer.start({ sessionIds: [sid(1), sid(2)], all: false }, (line) => {
    written.push(line);
    throw new SyntaxError('private text');
  });
  assert.ok(started.ok);
  await started.done;
  assert.deepEqual(stream(written).outcome, { code: 0, ...ZERO, started: 2 });
  // Each failure by what failed and its kind, never its text.
  const sent = 'restore: a report line was not sent (RangeError)';
  const notWritten = 'restore: a line was not written (SyntaxError)';
  const notTold = 'restore: the lists were not told (TypeError)';
  assert.deepEqual(logs, [
    notTold, // the run began
    ...[1, 2, 3].flatMap(() => [sent, notWritten]), // two started lines, the finished line
    notWritten, // the outcome
    notTold, // the run is over
  ]);
  const next = restorer.start({ sessionIds: [sid(3)], all: false });
  assert.ok(next.ok);
  await next.done;
});

test('heartbeatMs must be a whole number of milliseconds a timer can wait, at least 1', (t) => {
  const d = restarted(t, 0);
  for (const heartbeatMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
    assert.throws(() => world(d, { heartbeatMs }), RangeError, String(heartbeatMs));
  }
  assert.ok(world(d, { heartbeatMs: 2 ** 31 - 1 }).restorer);
});
