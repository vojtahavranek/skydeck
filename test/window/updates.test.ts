// The server's check for a newer skydeck (F38; src/window/updates.ts) with the fake clock and the
// scripted git, the seam variable naming a checkout inside the sandbox (updateSeam). No test here
// starts a real fetch or a real git.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { RunResult } from '../../src/platform/types.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { report } from '../../src/update/look.ts';
import { CHECK_KEY, readCheck, readCheckEntry, writeCheck } from '../../src/update/record.ts';
import type { CheckRecord } from '../../src/update/record.ts';
import type { UpdatePayload } from '../../src/window/protocol.ts';
import {
  CHECK_EVERY_NS,
  createUpdates,
  NO_CHECKOUT_LINE,
  RETRY_AFTER_FAILURE_NS,
} from '../../src/window/updates.ts';
import type { Updates } from '../../src/window/updates.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { T0 } from '../helpers/platform.ts';
import type { FakeRunner } from '../helpers/platform.ts';
import { gitArgs, NEW, OLD, scriptedGit, scriptedRepo, updateSeam } from '../helpers/update.ts';
import type { ScriptedRepo } from '../helpers/update.ts';

/** Lets every pending promise of the scripted git and the checker run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A promise the test resolves itself: a fetch that is still to answer. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface World {
  d: TestDeck;
  deck: Deck;
  root: string;
  repo: ScriptedRepo;
  runner: FakeRunner;
  updates: Updates;
  told: UpdatePayload[];
  logs: string[];
  /** How many fetches were made. */
  fetches(): number;
  /** The stored entry of this checkout. */
  stored(): CheckRecord | null;
  setSwitch(value: 'daily' | 'off'): void;
}

interface WorldOptions {
  repo?: Partial<ScriptedRepo>;
  updateCheck?: 'daily' | 'off';
  /** false: the seam variable is not set (a marked sandbox without it). */
  seam?: boolean;
  /** Changes the deck before the checker is made (a store that fails). */
  deck?: (deck: Deck) => Deck;
  /** Before the checker is made (an entry already stored). */
  before?: (deck: Deck, root: string) => void;
}

function world(t: TestContext, options: WorldOptions = {}): World {
  const d = testDeck(t, {
    env: (s) => (options.seam === false ? {} : updateSeam(s, join(s.root, 'checkout'))),
  });
  const root = join(d.sandbox.root, 'checkout');
  mkdirSync(root);
  const repo = scriptedRepo(root, options.repo);
  const runner = scriptedGit(repo);
  const config = {
    ...d.deck.config,
    window: { ...d.deck.config.window, updateCheck: options.updateCheck ?? 'daily' },
  };
  const base: Deck = { ...d.deck, config, platform: { ...d.deck.platform, runner } };
  const deck = options.deck === undefined ? base : options.deck(base);
  options.before?.(deck, root);
  const told: UpdatePayload[] = [];
  const logs: string[] = [];
  const updates = createUpdates({
    deck,
    changed: (payload) => told.push(payload),
    log: (line) => logs.push(line),
  });
  t.after(() => updates.stop());
  return {
    d,
    deck,
    root,
    repo,
    runner,
    updates,
    told,
    logs,
    fetches: () => runner.calls.filter((call) => gitArgs(call, root).includes('fetch')).length,
    stored: () => readCheck(d.deck.store, root),
    setSwitch: (value) => {
      config.window.updateCheck = value;
    },
  };
}

/** Collects unhandled rejections for the test's time. */
function rejections(t: TestContext): unknown[] {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  t.after(() => {
    process.off('unhandledRejection', listener);
  });
  return seen;
}

describe('when a check runs', () => {
  test('the first tick starts one check; later ticks none until 24 hours passed, then one', async (t) => {
    const w = world(t);

    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    for (let i = 0; i < 5; i++) w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    w.d.clock.setNs(T0 + CHECK_EVERY_NS - 1n);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    w.d.clock.setNs(T0 + CHECK_EVERY_NS);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 2);
  });

  test('after a check whose fetch failed the next comes after RETRY_AFTER_FAILURE_NS', async (t) => {
    const w = world(t, { repo: { quietFetch: { code: 128, stderr: 'fatal: gone\n' } } });

    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    w.d.clock.setNs(T0 + RETRY_AFTER_FAILURE_NS - 1n);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    w.d.clock.setNs(T0 + RETRY_AFTER_FAILURE_NS);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 2);
  });

  test('a clock stepped back behind the last check checks', async (t) => {
    const w = world(t);
    w.updates.tick();
    await flush();

    w.d.clock.setNs(T0 - 1n);
    w.updates.tick();
    await flush();

    assert.equal(w.fetches(), 2);
  });

  test('switch off: no check at any tick; check() still runs one', async (t) => {
    const w = world(t, { updateCheck: 'off' });

    for (let i = 0; i < 3; i++) w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 0);
    assert.equal(w.runner.calls.length, 0);

    const answer = await w.updates.check();
    assert.equal(w.fetches(), 1);
    assert.equal(answer.check?.state, 'available');
    assert.equal(answer.checking, false);
  });

  test('off, then daily at run time: the next tick checks', async (t) => {
    const w = world(t, { updateCheck: 'off' });
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 0);

    w.setSwitch('daily');
    w.updates.tick();
    await flush();

    assert.equal(w.fetches(), 1);
  });

  test('two check() calls while one runs: one fetch, the same answer', async (t) => {
    const fetch = deferred<Partial<RunResult>>();
    const w = world(t, { repo: { quietFetch: () => fetch.promise } });

    const first = w.updates.check();
    const second = w.updates.check();
    await flush();
    assert.equal(w.updates.payload().checking, true);
    w.updates.tick();
    fetch.resolve({});
    const [a, b] = await Promise.all([first, second]);

    assert.equal(w.fetches(), 1);
    assert.deepEqual(a, b);
    assert.equal(a.checking, false);
    assert.equal(a.check?.state, 'available');
  });
});

describe('what a check gives', () => {
  test('each outcome becomes the record and the payload', async (t) => {
    const cases: [Partial<ScriptedRepo>, UpdatePayload['check']][] = [
      [
        { fetched: OLD },
        { state: 'current', summary: 'skydeck is up to date (main at 0123456, as origin/main)' },
      ],
      [
        { ancestor: false, ahead: 2, behind: 0 },
        {
          state: 'current',
          summary: 'nothing new on origin/main: this checkout has 2 commits that it does not have',
        },
      ],
      [
        {},
        {
          state: 'available',
          summary: '1 new commit on origin/main',
          to: NEW,
          lines: ['1 new commit on origin/main (0123456..fedcba9):', '  fedcba9  the new commit'],
          blocked: null,
        },
      ],
      [
        { status: ' M a.txt\0' },
        {
          state: 'available',
          summary: '1 new commit on origin/main',
          to: NEW,
          lines: ['1 new commit on origin/main (0123456..fedcba9):', '  fedcba9  the new commit'],
          blocked:
            'this checkout has changes that are not committed (1 file, the first: a.txt); commit or undo them first',
        },
      ],
      [
        { upstream: { ref: '', remote: '', short: '' } },
        {
          state: 'cannot',
          summary: 'the branch main follows no branch of a remote; update it with git yourself',
        },
      ],
    ];
    for (const [over, expected] of cases) {
      const w = world(t, { repo: over });
      const answer = await w.updates.check();
      assert.deepEqual(answer.check, expected, JSON.stringify(over));
      const stored = w.stored();
      assert.ok(stored !== null);
      assert.equal(stored.root, w.root);
      assert.equal(stored.outcome.kind, expected?.state);
      assert.equal(stored.head, expected?.state === 'cannot' ? null : OLD);
      if (stored.outcome.kind === 'available') {
        assert.deepEqual(
          stored.outcome.lines,
          expected?.state === 'available' ? expected.lines : null,
        );
      }
      assert.equal(answer.failure, null);
      assert.equal(answer.fetchedAtNs, expected?.state === 'cannot' ? null : String(T0));
    }
  });

  test('the lines are those of report(), the database line included', async (t) => {
    const w = world(t, {
      repo: {
        migrations: {
          [NEW]: '100644 blob 6666666666666666666666666666666666666666\tsrc/store/migrations.ts\0',
        },
      },
    });

    const answer = await w.updates.check();

    assert.ok(answer.check?.state === 'available');
    assert.equal(answer.check.lines.length, 3);
    assert.match(answer.check.lines[2] ?? '', /^this update changes the database's upgrade steps/);
    assert.deepEqual(
      answer.check.lines,
      report({
        branch: 'main',
        upstream: 'origin/main',
        oldId: OLD,
        newId: NEW,
        count: 1,
        ahead: 0,
        commits: [{ id: NEW, subject: 'the new commit' }],
        upgradesDatabase: true,
      }),
    );
  });

  test('an update known from an earlier fetch, then a check whose fetch fails: it stays, the failure beside it; the next check that works clears it', async (t) => {
    const w = world(t);
    const first = await w.updates.check();
    assert.equal(first.check?.state, 'available');
    assert.equal(first.fetchedAtNs, String(T0));

    w.repo.quietFetch = {
      code: 128,
      stderr: "fatal: '/gone' does not appear to be a git repository\n",
    };
    w.d.clock.setNs(T0 + 5n);
    const failed = await w.updates.check();
    assert.ok(failed.check?.state === 'available');
    assert.equal(failed.check.to, NEW);
    assert.deepEqual(failed.failure, {
      atNs: String(T0 + 5n),
      line: "git fetch from origin failed: fatal: '/gone' does not appear to be a git repository",
    });
    assert.equal(failed.fetchedAtNs, String(T0));
    assert.deepEqual(w.stored()?.failure, failed.failure);

    w.repo.quietFetch = {};
    w.d.clock.setNs(T0 + 9n);
    const again = await w.updates.check();
    assert.equal(again.failure, null);
    assert.equal(again.fetchedAtNs, String(T0 + 9n));
  });

  test('a fetch that fails with nothing known: what the ref says, and the failure', async (t) => {
    const w = world(t, { repo: { fetched: OLD, quietFetch: { code: null, timedOut: true } } });

    const answer = await w.updates.check();

    assert.equal(answer.check?.state, 'current');
    assert.equal(answer.fetchedAtNs, null);
    assert.equal(answer.failure?.line, 'git fetch from origin failed: no answer within 60 s');
  });

  test('look() makes no fetch, replaces the outcome, keeps the last fetch and failure', async (t) => {
    const w = world(t, { repo: { quietFetch: { code: 1, stderr: 'fatal: no\n' } } });
    const checked = await w.updates.check();
    assert.equal(w.fetches(), 1);
    assert.equal(checked.check?.state, 'available');

    w.repo.fetched = OLD; // the checkout was brought up to date by hand
    w.d.clock.setNs(T0 + 7n);
    const looked = await w.updates.look();

    assert.equal(w.fetches(), 1);
    assert.equal(looked.check?.state, 'current');
    assert.deepEqual(looked.failure, checked.failure);
    assert.equal(looked.fetchedAtNs, checked.fetchedAtNs);
    assert.equal(w.stored()?.lookedAtNs, String(T0 + 7n));
    assert.equal(w.stored()?.outcome.kind, 'current');
  });

  test('look() while a check runs answers checking and starts nothing', async (t) => {
    const fetch = deferred<Partial<RunResult>>();
    const w = world(t, { repo: { quietFetch: () => fetch.promise } });
    const running = w.updates.check();
    await flush();
    const calls = w.runner.calls.length;

    const looked = await w.updates.look();

    assert.equal(looked.checking, true);
    assert.equal(w.runner.calls.length, calls);
    fetch.resolve({});
    await running;
  });

  test('stop() aborts the fetch through its signal and writes nothing', async (t) => {
    const fetch = deferred<Partial<RunResult>>();
    const w = world(t, { repo: { quietFetch: () => fetch.promise } });
    const running = w.updates.check();
    await flush();
    const signal = w.runner.calls.find((call) => gitArgs(call, w.root).includes('fetch'))?.options
      ?.signal;
    assert.ok(signal !== undefined);
    const told = w.told.length;

    await w.updates.stop();
    fetch.resolve({});
    await running;
    await flush();

    assert.equal(signal.aborted, true);
    assert.equal(w.d.deck.store.getKv(CHECK_KEY), null);
    assert.equal(w.told.length, told);
    assert.deepEqual(w.logs, []);
  });

  test('changed is called on each change: the check starting, its outcome, its end, a look', async (t) => {
    const w = world(t);

    await w.updates.check();
    assert.deepEqual(
      w.told.map((p) => [p.checking, p.check?.state ?? null]),
      [
        [true, null],
        [true, 'available'],
        [false, 'available'],
      ],
    );
    await w.updates.look();
    assert.equal(w.told.length, 4);
  });
});

describe('the store and the server', () => {
  test('a stored entry of another root is not shown; the record names this checkout', async (t) => {
    const other: CheckRecord = {
      v: 1,
      root: '/another/checkout',
      lookedAtNs: '1',
      checkedAtNs: '1',
      fetchedAtNs: '1',
      failure: null,
      head: OLD,
      outcome: {
        kind: 'available',
        upstream: 'origin/main',
        count: 1,
        to: NEW,
        lines: ['x'],
        blocked: null,
      },
    };
    const w = world(t, {
      updateCheck: 'off',
      before: (deck) => {
        writeCheck(deck.store, other);
      },
    });

    w.updates.tick();
    await flush();
    assert.equal(w.runner.calls.length, 0, "no look for another checkout's entry");
    assert.equal(w.updates.payload().check, null);

    await w.updates.check();
    assert.equal(readCheckEntry(w.d.deck.store)?.root, w.root);
  });

  test("a stored outcome is not sent before this server's own first check has ended", async (t) => {
    const fetch = deferred<Partial<RunResult>>();
    const w = world(t, {
      repo: { quietFetch: () => fetch.promise, fetched: OLD },
      before: (deck, root) => {
        writeCheck(deck.store, {
          v: 1,
          root,
          lookedAtNs: '1',
          checkedAtNs: '1',
          fetchedAtNs: '1',
          failure: null,
          head: OLD,
          outcome: {
            kind: 'available',
            upstream: 'origin/main',
            count: 1,
            to: NEW,
            lines: ['x'],
            blocked: null,
          },
        });
      },
    });

    w.updates.tick();
    await flush();
    assert.equal(w.updates.payload().check, null);
    assert.equal(w.updates.payload().fetchedAtNs, null);
    fetch.resolve({});
    await flush();
    assert.equal(w.updates.payload().check?.state, 'current');
  });

  test('with the switch off and a stored outcome the first tick looks once, without a fetch', async (t) => {
    const w = world(t, {
      updateCheck: 'off',
      before: (deck, root) => {
        writeCheck(deck.store, {
          v: 1,
          root,
          lookedAtNs: '1',
          checkedAtNs: '1',
          fetchedAtNs: '1',
          failure: null,
          head: OLD,
          outcome: { kind: 'current', line: 'old' },
        });
      },
    });

    w.updates.tick();
    w.updates.tick();
    await flush();
    w.updates.tick();
    await flush();

    assert.equal(w.fetches(), 0);
    assert.ok(w.runner.calls.length > 0, 'a look was made');
    assert.equal(
      w.runner.calls.filter(
        (call) =>
          gitArgs(call, w.root)[0] === 'rev-parse' &&
          gitArgs(call, w.root)[1] === '--show-toplevel',
      ).length,
      1,
    );
    assert.equal(w.updates.payload().check?.state, 'available');
    assert.equal(w.updates.payload().fetchedAtNs, '1');
  });

  test('in a marked sandbox without the seam variable no call reaches the runner at all', async (t) => {
    const w = world(t, { seam: false });

    w.updates.tick();
    await flush();
    const checked = await w.updates.check();
    const looked = await w.updates.look();

    assert.equal(w.runner.calls.length, 0);
    assert.equal(w.runner.interactiveCalls.length, 0);
    assert.deepEqual(checked.check, { state: 'cannot', summary: NO_CHECKOUT_LINE });
    assert.deepEqual(looked.check, { state: 'cannot', summary: NO_CHECKOUT_LINE });
    assert.equal(w.d.deck.store.getKv(CHECK_KEY), null);
  });

  test("no rejection escapes: a store that is busy at the check's end — one log line, the outcome still sent", async (t) => {
    const seen = rejections(t);
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    const w = world(t, {
      deck: (deck) =>
        deckWith(deck, {
          store: {
            setKv: () => {
              throw busy;
            },
          },
        }),
    });

    w.updates.tick();
    const answer = await w.updates.check(); // joins the tick's check
    await flush();

    assert.equal(w.fetches(), 1);
    assert.equal(answer.check?.state, 'available');
    assert.equal(w.told.at(-1)?.check?.state, 'available');
    assert.deepEqual(w.logs, [
      'update check: the outcome could not be stored (Error (ERR_SQLITE_ERROR))',
    ]);
    assert.deepEqual(seen, []);
  });

  test('a store closed after stop() while a fetch is still to answer: nothing written, sent or thrown', async (t) => {
    const seen = rejections(t);
    const fetch = deferred<Partial<RunResult>>();
    const w = world(t, { repo: { quietFetch: () => fetch.promise } });
    w.updates.tick();
    await flush();
    const told = w.told.length;

    const stopping = w.updates.stop();
    w.d.deck.store.close();
    fetch.resolve({});
    await stopping;
    await flush();
    w.updates.tick();
    await w.updates.check();
    await w.updates.look();
    await flush();

    assert.equal(w.told.length, told);
    assert.deepEqual(w.logs, []);
    assert.deepEqual(seen, []);
  });
});

describe('a check that fails (review of milestone 1)', () => {
  test('the waits: a day after a check, an hour after one that failed', () => {
    assert.equal(CHECK_EVERY_NS, 24n * 3_600_000_000_000n);
    assert.equal(RETRY_AFTER_FAILURE_NS, 3_600_000_000_000n);
  });

  test('a check that throws (a git that cannot be started) is a failed check: said, and tried again an hour later, not at every tick', async (t) => {
    const w = world(t, {
      repo: {
        quietFetch: () =>
          Promise.reject(Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' })),
      },
    });

    for (let i = 0; i < 10; i++) {
      w.d.clock.setNs(T0 + BigInt(i) * 1_000_000_000n);
      w.updates.tick();
      await flush();
    }
    assert.equal(w.fetches(), 1);
    const state = w.updates.payload();
    assert.deepEqual(state.failure, {
      atNs: String(T0),
      line: 'skydeck could not check for an update (Error (EAGAIN))',
    });
    assert.equal(state.checkedAtNs, String(T0));
    assert.notEqual(state.check, null, 'Settings does not say that no check was made');
    assert.deepEqual(w.logs, ['update check: failed (Error (EAGAIN))']);
    w.d.clock.setNs(T0 + RETRY_AFTER_FAILURE_NS - 1n);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    w.d.clock.setNs(T0 + RETRY_AFTER_FAILURE_NS);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 2);
  });

  test('a Check now that throws keeps what an earlier check found, the failure beside it', async (t) => {
    const w = world(t);
    await w.updates.check();
    w.repo.quietFetch = () => Promise.reject(new Error('spawn git EAGAIN'));
    w.d.clock.setNs(T0 + 5n);

    const answer = await w.updates.check();

    assert.equal(answer.check?.state, 'available');
    assert.equal(answer.fetchedAtNs, String(T0));
    assert.equal(answer.checkedAtNs, String(T0 + 5n));
    assert.equal(answer.failure?.line, 'skydeck could not check for an update (Error)');
    assert.deepEqual(w.stored()?.failure, answer.failure);
  });

  test('a cannot that a git failure made is a failed check: the outcome before stands, the hour', async (t) => {
    const w = world(t);
    await w.updates.check();
    w.repo.answers['rev-parse --show-toplevel'] = { code: null, timedOut: true };
    w.d.clock.setNs(T0 + 7n);

    const answer = await w.updates.check();

    assert.equal(answer.check?.state, 'available', 'a timeout tells nothing of the checkout');
    assert.match(answer.failure?.line ?? '', /is not a git checkout/);
    assert.equal(answer.failure?.atNs, String(T0 + 7n));
    delete w.repo.answers['rev-parse --show-toplevel'];
    w.d.clock.setNs(T0 + 7n + RETRY_AFTER_FAILURE_NS - 1n);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1, 'not before the hour');
    w.d.clock.setNs(T0 + 7n + RETRY_AFTER_FAILURE_NS);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 2, 'checked again after the hour (the timed-out look made none)');
  });

  test('a check that ends cannot by a state of the checkout: its own time, and no stale failure', async (t) => {
    const w = world(t, { repo: { quietFetch: { code: 128, stderr: 'fatal: gone\n' } } });
    const failed = await w.updates.check();
    assert.notEqual(failed.failure, null);

    w.repo.branch = null; // detached since
    w.d.clock.setNs(T0 + 3n * 86_400_000_000_000n);
    const answer = await w.updates.check();

    assert.deepEqual(answer.check, {
      state: 'cannot',
      summary: 'this checkout is not on a branch (detached HEAD); update it with git yourself',
    });
    assert.equal(answer.failure, null);
    assert.equal(answer.checkedAtNs, String(T0 + 3n * 86_400_000_000_000n));
    // A state of the checkout is no failure: the next check is a day later, not an hour.
    const calls = w.runner.calls.length;
    w.d.clock.setNs(T0 + 3n * 86_400_000_000_000n + RETRY_AFTER_FAILURE_NS);
    w.updates.tick();
    await flush();
    assert.equal(w.runner.calls.length, calls);
  });

  test('a failed fetch is not lost when the look then ends as changed while the fetch ran', async (t) => {
    const w = world(t, {
      repo: { quietFetch: { code: 128, stderr: 'fatal: gone\n' }, afterFetch: { head: NEW } },
    });

    const answer = await w.updates.check();

    assert.equal(answer.check?.state, 'cannot');
    assert.equal(answer.failure?.line, 'git fetch from origin failed: fatal: gone');
  });

  test('a stored outcome that cannot be read: the check goes on, one log line', async (t) => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    const w = world(t, {
      deck: (deck) =>
        deckWith(deck, {
          store: {
            getKv: () => {
              throw busy;
            },
          },
        }),
    });

    const answer = await w.updates.check();

    assert.equal(answer.check?.state, 'available');
    assert.deepEqual(w.logs, [
      'update check: the stored outcome could not be read (Error (ERR_SQLITE_ERROR))',
    ]);
  });
});

describe('a stop in the middle (review of milestone 1)', () => {
  /** A world whose git calls go through `onCall` with the checker, to stop it at a given call. */
  function stoppable(
    t: TestContext,
    at: (args: readonly string[], fetched: boolean) => boolean,
  ): { w: World; stopped(): boolean; callsAfter(): number } {
    let updates: Updates | null = null;
    let fetched = false;
    let stopped = false;
    let after = 0;
    let root = '';
    const w = world(t, {
      repo: {
        onCall: (call) => {
          const args = gitArgs(call, root);
          if (stopped) {
            after += 1;
            return;
          }
          if (args.includes('fetch')) fetched = true;
          else if (updates !== null && at(args, fetched)) {
            stopped = true;
            void updates.stop();
          }
        },
      },
    });
    root = w.root;
    updates = w.updates;
    return { w, stopped: () => stopped, callsAfter: () => after };
  }

  test('a stop after the fetch has answered, in the look that follows: nothing stored or told, no further git call', async (t) => {
    const s = stoppable(t, (args, fetched) => fetched && args.includes('symbolic-ref'));
    const told = s.w.told.length;

    await s.w.updates.check();
    await flush();

    assert.ok(s.stopped(), 'the stop came after the fetch');
    assert.equal(s.w.d.deck.store.getKv(CHECK_KEY), null);
    assert.equal(s.w.told.length, told + 1, 'only the start of the check was told');
    assert.equal(s.callsAfter(), 0);
    assert.deepEqual(s.w.logs, []);
  });

  test('a stop during a look: nothing stored or told, no further git call', async (t) => {
    const s = stoppable(t, (args) => args.includes('for-each-ref'));

    await s.w.updates.look();
    await flush();

    assert.ok(s.stopped());
    assert.equal(s.w.d.deck.store.getKv(CHECK_KEY), null);
    assert.deepEqual(s.w.told, []);
    assert.equal(s.callsAfter(), 0);
    assert.deepEqual(s.w.logs, []);
  });
});

describe("a stop at the look's last git call (review of milestone 1)", () => {
  for (const kind of ['check', 'look'] as const) {
    test(`${kind}: the look answers after the stop, and nothing of it is stored or told`, async (t) => {
      let updates: Updates | null = null;
      let root = '';
      let trees = 0;
      let stopped = false;
      const w = world(t, {
        repo: {
          onCall: (call) => {
            // The second ls-tree is the look's last call: the stop comes while it is answered.
            if (gitArgs(call, root)[0] === 'ls-tree' && ++trees === 2 && updates !== null) {
              stopped = true;
              void updates.stop();
            }
          },
        },
      });
      root = w.root;
      updates = w.updates;
      const told = w.told.length;

      await (kind === 'check' ? w.updates.check() : w.updates.look());
      await flush();

      assert.ok(stopped);
      assert.equal(w.d.deck.store.getKv(CHECK_KEY), null);
      assert.equal(w.told.length, told + (kind === 'check' ? 1 : 0));
      assert.equal(w.updates.payload().check, null);
    });
  }
});
