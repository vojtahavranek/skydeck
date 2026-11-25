// The server's check for a newer skydeck (F38; src/window/updates.ts) with the fake clock and the
// scripted git, the seam variable naming a checkout inside the sandbox (updateSeam). No test here
// starts a real fetch or a real git.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { UpdateCheck } from '../../src/platform/config.ts';
import type { Detached, RunResult } from '../../src/platform/types.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import {
  CHECK_KEY,
  checkoutRoot,
  clearRun,
  readCheck,
  readCheckEntry,
  readRunEntry,
  RUN_KEY,
  writeCheck,
  writeRun,
} from '../../src/update/record.ts';
import type { CheckRecord, RunRecord } from '../../src/update/record.ts';
import type { UpdatePayload } from '../../src/window/protocol.ts';
import {
  APPLY_REFUSED,
  CHECK_EVERY_NS,
  CORE_LIMIT_PROGRAM,
  createUpdates,
  NO_CHECKOUT_LINE,
  PYTHON3,
  RETRY_AFTER_FAILURE_NS,
  retryAfterNs,
} from '../../src/window/updates.ts';
import type { Updates } from '../../src/window/updates.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { fakeProcesses, T0 } from '../helpers/platform.ts';
import type { FakeProcesses, FakeRunner } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import {
  availableOutcome,
  availablePayload,
  gitArgs,
  NEW,
  OLD,
  scriptedGit,
  scriptedRepo,
  updateSeam,
} from '../helpers/update.ts';
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
  /** The checkout's real path; `seam` is the path the seam variable names (a link to it, or it). */
  root: string;
  seam: string;
  processes: FakeProcesses;
  /** What the restore and the server's stop answer to the checker (the test changes them). */
  restoring: { now: boolean };
  serverStopping: { now: boolean };
  repo: ScriptedRepo;
  runner: FakeRunner;
  updates: Updates;
  told: UpdatePayload[];
  logs: string[];
  /** How many fetches were made. */
  fetches(): number;
  /** The stored entry of this checkout. */
  stored(): CheckRecord | null;
  setUpdateCheck(value: UpdateCheck): void;
}

interface WorldOptions {
  repo?: Partial<ScriptedRepo>;
  /** The setting (default "daily": the tests that wait a day; those of each value name it). */
  updateCheck?: UpdateCheck;
  /** false: the seam variable is not set (a marked sandbox without it). */
  seam?: boolean;
  /** Changes the deck before the checker is made (a store that fails). */
  deck?: (deck: Deck) => Deck;
  /** Before the checker is made (an entry already stored). */
  before?: (deck: Deck, root: string) => void;
  /** Milestone 2: what startDetached answers (default: a pid and an exit that never comes). */
  processes?: FakeProcesses;
  coreSoft?: string | null;
  serverEnv?: Record<string, string>;
  originDir?: string;
  /** true: the seam names a symbolic link to the checkout, not the checkout itself. */
  link?: boolean;
}

/** The server's environment the tests hand the checker (the updater's). */
const SERVER_ENV = { PATH: '/usr/bin:/bin', HOME: '/home/you', SKYDECK_TEST_NO_WINDOWS: '1' };

function world(t: TestContext, options: WorldOptions = {}): World {
  const seamName = options.link === true ? 'link' : 'checkout';
  const d = testDeck(t, {
    env: (s) => (options.seam === false ? {} : updateSeam(s, join(s.root, seamName))),
  });
  const root = join(d.sandbox.root, 'checkout');
  mkdirSync(root);
  const seam = join(d.sandbox.root, seamName);
  if (options.link === true) symlinkSync(root, seam);
  const repo = scriptedRepo(seam, options.repo);
  const runner = scriptedGit(repo);
  const processes = options.processes ?? fakeProcesses();
  const config = {
    ...d.deck.config,
    window: { ...d.deck.config.window, updateCheck: options.updateCheck ?? 'daily' },
  };
  const base: Deck = { ...d.deck, config, platform: { ...d.deck.platform, runner, processes } };
  const deck = options.deck === undefined ? base : options.deck(base);
  options.before?.(deck, root);
  const told: UpdatePayload[] = [];
  const logs: string[] = [];
  const restoring = { now: false };
  const serverStopping = { now: false };
  const updates = createUpdates({
    deck,
    changed: (payload) => told.push(payload),
    log: (line) => logs.push(line),
    serverEnv: options.serverEnv ?? SERVER_ENV,
    coreSoft: options.coreSoft ?? null,
    originDir: () => options.originDir ?? d.sandbox.home,
    restoreRunning: () => restoring.now,
    stopping: () => serverStopping.now,
  });
  t.after(() => updates.stop());
  return {
    d,
    deck,
    root,
    seam,
    processes,
    restoring,
    serverStopping,
    repo,
    runner,
    updates,
    told,
    logs,
    fetches: () => runner.calls.filter((call) => gitArgs(call, seam).includes('fetch')).length,
    stored: () => readCheck(d.deck.store, root),
    setUpdateCheck: (value) => {
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
    w.d.clock.setNs(T0 + CHECK_EVERY_NS.daily - 1n);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    w.d.clock.setNs(T0 + CHECK_EVERY_NS.daily);
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

  test('"off": no check at any tick; check() still runs one', async (t) => {
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

    w.setUpdateCheck('daily');
    w.updates.tick();
    await flush();

    assert.equal(w.fetches(), 1);
  });

  const MINUTE = 60_000_000_000n;
  /** Each value but "off": its wait after a check, and after one that failed. */
  const EVERY = [
    { value: '15min', wait: 15n * MINUTE, afterFailure: 15n * MINUTE },
    { value: 'hourly', wait: 60n * MINUTE, afterFailure: 60n * MINUTE },
    { value: 'daily', wait: 24n * 60n * MINUTE, afterFailure: 60n * MINUTE },
  ] as const;

  for (const { value, wait, afterFailure } of EVERY) {
    test(`"${value}": a check at start, none before the wait, one exactly at it, and so on`, async (t) => {
      const w = world(t, { updateCheck: value });

      w.updates.tick();
      await flush();
      assert.equal(w.fetches(), 1, 'at start');
      for (const [at, fetches] of [
        [wait - 1n, 1],
        [wait, 2],
        [wait + 1n, 2],
        [2n * wait - 1n, 2],
        [2n * wait, 3],
      ] as const) {
        w.d.clock.setNs(T0 + at);
        w.updates.tick();
        await flush();
        assert.equal(w.fetches(), fetches, `${value} at +${at} ns`);
      }
    });

    test(`"${value}": after a check that failed the next comes after ${afterFailure / MINUTE} minutes, then the wait again`, async (t) => {
      const w = world(t, {
        updateCheck: value,
        repo: { quietFetch: { code: 128, stderr: 'fatal: gone\n' } },
      });

      w.updates.tick();
      await flush();
      assert.equal(w.fetches(), 1);
      assert.notEqual(w.updates.payload().failure, null);
      w.d.clock.setNs(T0 + afterFailure - 1n);
      w.updates.tick();
      await flush();
      assert.equal(w.fetches(), 1);
      // The remote answers again: the check after the failure works, and the wait is the value's.
      w.repo.quietFetch = {};
      w.d.clock.setNs(T0 + afterFailure);
      w.updates.tick();
      await flush();
      assert.equal(w.fetches(), 2);
      assert.equal(w.updates.payload().failure, null);
      w.d.clock.setNs(T0 + afterFailure + wait - 1n);
      w.updates.tick();
      await flush();
      assert.equal(w.fetches(), 2);
      w.d.clock.setNs(T0 + afterFailure + wait);
      w.updates.tick();
      await flush();
      assert.equal(w.fetches(), 3);
    });

    test(`"${value}": a clock stepped back behind the last check checks`, async (t) => {
      const w = world(t, { updateCheck: value });
      w.updates.tick();
      await flush();

      w.d.clock.setNs(T0 - 1n);
      w.updates.tick();
      await flush();

      assert.equal(w.fetches(), 2);
    });
  }

  test('a change while the server runs applies at the next tick: to a shorter wait, a check due by it is made at once', async (t) => {
    const w = world(t, { updateCheck: 'daily' });
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);

    // 20 minutes on: due by "15min", not by "hourly".
    w.d.clock.setNs(T0 + 20n * MINUTE);
    w.setUpdateCheck('hourly');
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1, 'not an hour yet');
    w.setUpdateCheck('15min');
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 2, 'due by the new wait: at the next tick');

    // To a longer wait: the next check waits for it, from the last check.
    w.setUpdateCheck('daily');
    w.d.clock.setNs(T0 + 20n * MINUTE + 60n * MINUTE);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 2, 'a day is not over');
    w.setUpdateCheck('hourly');
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 3, 'an hour is');

    // Off: none at any tick, whatever the time.
    w.setUpdateCheck('off');
    w.d.clock.setNs(T0 + 3n * 24n * 60n * MINUTE);
    for (let i = 0; i < 3; i++) w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 3);
  });

  test("a change after a failed check: the wait after the failure is the new value's", async (t) => {
    const w = world(t, {
      updateCheck: 'hourly',
      repo: { quietFetch: { code: 128, stderr: 'fatal: gone\n' } },
    });
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);

    w.d.clock.setNs(T0 + 15n * MINUTE);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1, 'an hour after a failure with "hourly"');
    w.setUpdateCheck('15min');
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 2, '15 minutes with "15min"');
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
      [{}, availablePayload()],
      [
        { status: ' M a.txt\0' },
        availablePayload({
          blocked:
            'this checkout has changes that are not committed (1 file, the first: a.txt); commit or undo them first',
        }),
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
          stored.outcome.others,
          expected?.state === 'available' ? expected.others : null,
        );
      }
      assert.equal(answer.failure, null);
      assert.equal(answer.fetchedAtNs, expected?.state === 'cannot' ? null : String(T0));
    }
  });

  test('an update that changes the upgrade steps says so; the notes it brings and the other changes go with it', async (t) => {
    const blob = 'a'.repeat(40);
    const w = world(t, {
      repo: {
        migrations: {
          [NEW]: '100644 blob 6666666666666666666666666666666666666666\tsrc/store/migrations.ts\0',
        },
        news: { [NEW]: `100644 blob ${blob}      40\tdocs/news/2026-11-25-a.md\0` },
        blobs: { [blob]: '# A `note`\n\nIt says so.\n' },
        behind: 2,
        commits: [
          { id: NEW, subject: 'adds the note' },
          { id: OLD.replace('0', 'e'), subject: 'another change' },
        ],
        noteAdders: [NEW],
      },
    });

    const answer = await w.updates.check();

    assert.deepEqual(
      answer.check,
      availablePayload({
        summary: '2 new commits on origin/main',
        notes: [
          {
            title: [
              { text: 'A ', code: false },
              { text: 'note', code: true },
            ],
            paragraphs: [[{ text: 'It says so.', code: false }]],
          },
        ],
        others: ['another change'],
        otherCount: 1,
        upgradesDatabase: true,
      }),
    );
    const stored = w.stored();
    assert.ok(stored?.v === 2 && stored.outcome.kind === 'available');
    assert.deepEqual(stored.outcome.notes, [{ title: 'A `note`', paragraphs: ['It says so.'] }]);
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
      v: 2,
      root: '/another/checkout',
      lookedAtNs: '1',
      checkedAtNs: '1',
      fetchedAtNs: '1',
      failure: null,
      head: OLD,
      outcome: availableOutcome(),
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
          v: 2,
          root,
          lookedAtNs: '1',
          checkedAtNs: '1',
          fetchedAtNs: '1',
          failure: null,
          head: OLD,
          outcome: availableOutcome(),
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

  test('with "off" and a stored outcome the first tick looks once, without a fetch', async (t) => {
    const w = world(t, {
      updateCheck: 'off',
      before: (deck, root) => {
        writeCheck(deck.store, {
          v: 2,
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

  test('a stored record of the shape before (version 1) is none: with the switch off no look and nothing shown; the switch on, the check is made and stores the new shape', async (t) => {
    const before = (deck: Deck, root: string): void => {
      deck.store.setKv(
        CHECK_KEY,
        JSON.stringify({
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
            lines: ['1 new commit on origin/main (0123456..fedcba9):'],
            blocked: null,
          },
        }),
      );
    };
    const off = world(t, { updateCheck: 'off', before });
    off.updates.tick();
    await flush();
    assert.equal(off.runner.calls.length, 0, 'no look: nothing stored is known');
    assert.equal(off.updates.payload().check, null);

    const on = world(t, { before });
    on.updates.tick();
    await flush();
    assert.equal(on.fetches(), 1);
    assert.deepEqual(on.updates.payload().check, availablePayload());
    assert.equal(on.stored()?.v, 2);
    assert.equal(on.updates.payload().fetchedAtNs, String(T0), 'no time of the old record kept');
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
  test('the waits: 15 minutes, an hour or a day after a check; an hour after one that failed, 15 minutes with "15min"', () => {
    assert.deepEqual(CHECK_EVERY_NS, {
      '15min': 15n * 60_000_000_000n,
      hourly: 3_600_000_000_000n,
      daily: 24n * 3_600_000_000_000n,
    });
    assert.equal(RETRY_AFTER_FAILURE_NS, 3_600_000_000_000n);
    assert.equal(retryAfterNs('15min'), 15n * 60_000_000_000n);
    assert.equal(retryAfterNs('hourly'), 3_600_000_000_000n);
    assert.equal(retryAfterNs('daily'), 3_600_000_000_000n);
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

  /** An earlier server's stored entry: an update to NEW known, HEAD then at OLD. */
  const earlier = (deck: Deck, root: string): void => {
    writeCheck(deck.store, {
      v: 2,
      root,
      lookedAtNs: '1',
      checkedAtNs: '1',
      fetchedAtNs: '1',
      failure: null,
      head: OLD,
      outcome: availableOutcome(),
    });
  };

  test("after an update, a new server's first check that throws shows no notice: a cannot with its line", async (t) => {
    // The update was applied: HEAD is NEW, the upstream's commit too.
    const w = world(t, {
      repo: {
        head: NEW,
        fetched: NEW,
        quietFetch: () => Promise.reject(new Error('spawn git EAGAIN')),
      },
      before: earlier,
    });

    const answer = await w.updates.check();

    assert.deepEqual(answer.check, {
      state: 'cannot',
      summary: 'skydeck could not check for an update (Error)',
    });
    assert.equal(answer.failure?.line, 'skydeck could not check for an update (Error)');
    assert.equal(answer.fetchedAtNs, '1', 'the stored entry gives the last fetch time only');
    assert.equal(w.stored()?.head, null);
    assert.equal(w.stored()?.outcome.kind, 'cannot');
  });

  test("after an update, a new server's first check whose git call times out shows no notice; the next comes an hour later", async (t) => {
    const w = world(t, {
      repo: {
        head: NEW,
        fetched: NEW,
        answers: { 'symbolic-ref --quiet HEAD': { code: null, timedOut: true } },
      },
      before: earlier,
    });

    w.updates.tick();
    await flush();

    const line = 'git symbolic-ref failed: no answer within 10 s; nothing was changed';
    assert.deepEqual(w.updates.payload().check, { state: 'cannot', summary: line });
    assert.equal(w.updates.payload().failure?.line, line);
    const calls = w.runner.calls.length;
    w.d.clock.setNs(T0 + RETRY_AFTER_FAILURE_NS - 1n);
    w.updates.tick();
    await flush();
    assert.equal(w.runner.calls.length, calls, 'not before the hour');
    w.d.clock.setNs(T0 + RETRY_AFTER_FAILURE_NS);
    w.updates.tick();
    await flush();
    assert.ok(w.runner.calls.length > calls, 'checked again after the hour');
  });

  test("a window's look that times out in the tolerant order: git's words, not that it is no checkout", async (t) => {
    const w = world(t, {
      repo: { answers: { 'rev-parse --show-toplevel': { code: null, timedOut: true } } },
    });

    const answer = await w.updates.check();

    assert.deepEqual(answer.check, {
      state: 'cannot',
      summary: 'git rev-parse failed: no answer within 10 s; nothing was changed',
    });
  });

  test("the dialog's look whose git call fails replaces what was known: the notice goes", async (t) => {
    const w = world(t);
    const checked = await w.updates.check();
    assert.equal(checked.check?.state, 'available');
    w.repo.answers['merge-base --is-ancestor ' + OLD + ' ' + NEW] = {
      code: 128,
      stderr: 'fatal: bad object\n',
    };

    const looked = await w.updates.look();

    assert.deepEqual(looked.check, {
      state: 'cannot',
      summary: 'git merge-base failed: fatal: bad object; nothing was changed',
    });
    assert.equal(w.stored()?.outcome.kind, 'cannot');
    assert.equal(w.told.at(-1)?.check?.state, 'cannot');
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
      // Milestone 2: the start's read of an update's entry meets the same store.
      'update: the entry of the last update could not be read (Error (ERR_SQLITE_ERROR))',
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

// ---------------------------------------------------------------------------------------------
// Milestone 2: Update now (S2 16.5 "Update now")

/** An `exited` the test settles itself: the updater ending while the server still runs. */
function updater(pid = 7001): {
  detached: Detached;
  end(code: number | null, signal?: string | null): void;
} {
  const exit = deferred<{ code: number | null; signal: string | null }>();
  return {
    detached: { pid, exited: exit.promise },
    end: (code, signal = null) => {
      exit.resolve({ code, signal });
    },
  };
}

const LOG_LINE = /^[0-9T:.-]+Z update to fedcba9 started from the window\n$/;

describe('Update now: the start of the updater', () => {
  test("without a core limit: the seam checkout's launcher, `update --from-window <to>`, the server's environment key for key, the origin as working directory, both outputs to update.log", async (t) => {
    const w = world(t);
    await w.updates.check();

    const answer = await w.updates.apply(NEW);

    assert.equal(answer.ok, true);
    const log = join(w.d.places.stateDir, 'update.log');
    assert.deepEqual(w.processes.calls, [
      {
        command: join(w.seam, 'bin', 'skydeck'),
        args: ['update', '--from-window', NEW],
        options: { cwd: w.d.sandbox.home, env: SERVER_ENV, stdoutTo: log, stderrTo: log },
      },
    ]);
    assert.notEqual(join(w.seam, 'bin', 'skydeck'), join(process.cwd(), 'bin', 'skydeck'));
    assert.match(readFileSync(log, 'utf8'), LOG_LINE);
    assert.deepEqual(answer.update.applying, { to: NEW, sinceNs: String(T0) });
    assert.equal(answer.update.log, log);
  });

  test('with a core limit: through python3 (-I -S -c, the program, the limit, LC_CTYPE set or not), then the launcher', async (t) => {
    const envs: Record<string, string>[] = [SERVER_ENV, { ...SERVER_ENV, LC_CTYPE: 'cs_CZ.UTF-8' }];
    for (const env of envs) {
      const w = world(t, { coreSoft: 'unlimited', serverEnv: env });
      await w.updates.check();
      assert.equal((await w.updates.apply(NEW)).ok, true);
      const [call] = w.processes.calls;
      assert.equal(call?.command, PYTHON3, "no SKYDECK_TEST_PYTHON3 here: the launcher's python3");
      assert.deepEqual(call?.args, [
        '-I',
        '-S',
        '-c',
        CORE_LIMIT_PROGRAM,
        'unlimited',
        env.LC_CTYPE === undefined ? '' : '1',
        env.LC_CTYPE ?? '',
        join(w.seam, 'bin', 'skydeck'),
        'update',
        '--from-window',
        NEW,
      ]);
      assert.deepEqual(call?.options.env, env);
    }
  });

  test('in a marked sandbox SKYDECK_TEST_PYTHON3 replaces /usr/bin/python3', async (t) => {
    const w = world(t, {
      coreSoft: '0',
      deck: (deck) => ({
        ...deck,
        platform: {
          ...deck.platform,
          env: { ...deck.platform.env, SKYDECK_TEST_PYTHON3: '/sandbox/python3' },
        },
      }),
    });
    await w.updates.check();
    await w.updates.apply(NEW);
    assert.equal(w.processes.calls[0]?.command, '/sandbox/python3');
  });

  test('the working directory is `/` when the origin is no directory any more', async (t) => {
    const w = world(t, { originDir: '/no/such/dir' });
    await w.updates.check();
    await w.updates.apply(NEW);
    assert.equal(w.processes.calls[0]?.options.cwd, '/');
  });

  test('in a marked sandbox without the seam variable nothing is started, and no git runs', async (t) => {
    const w = world(t, { seam: false });
    const answer = await w.updates.apply(NEW);
    assert.deepEqual(answer, {
      ok: false,
      error: APPLY_REFUSED.notListed,
      update: w.updates.payload(),
    });
    assert.deepEqual(w.processes.calls, []);
    assert.deepEqual(w.runner.calls, []);
  });

  test('`applying` is written (with the root) and sent to the pages before the start', async (t) => {
    let atStart: { entry: RunRecord | null; told: UpdatePayload | undefined } | null = null;
    let w: World | null = null;
    const processes = fakeProcesses(() => {
      if (w !== null) {
        atStart = { entry: readRunEntry(w.d.deck.store), told: w.told.at(-1) };
      }
      return updater().detached;
    });
    w = world(t, { processes });
    await w.updates.check();

    await w.updates.apply(NEW);

    assert.deepEqual(atStart, {
      entry: { v: 1, root: w.root, state: 'applying', to: NEW, atNs: String(T0) },
      told: { ...w.updates.payload(), applying: { to: NEW, sinceNs: String(T0) } },
    });
  });
});

describe('Update now: refused, nothing started', () => {
  test('each refusal of S2 16.5 with its words', async (t) => {
    // The server is stopping.
    const stopping = world(t);
    await stopping.updates.check();
    stopping.serverStopping.now = true;
    const stopAnswer = await stopping.updates.apply(NEW);
    assert.equal(stopAnswer.ok ? '' : stopAnswer.error, APPLY_REFUSED.stopping);
    // A restore runs.
    const restoring = world(t);
    await restoring.updates.check();
    restoring.restoring.now = true;
    const restoreAnswer = await restoring.updates.apply(NEW);
    assert.equal(restoreAnswer.ok ? '' : restoreAnswer.error, APPLY_REFUSED.restoring);
    // A check runs.
    const fetch = deferred<Partial<RunResult>>();
    const checking = world(t, { repo: { quietFetch: () => fetch.promise } });
    const running = checking.updates.check();
    await flush();
    const checkAnswer = await checking.updates.apply(NEW);
    assert.equal(checkAnswer.ok ? '' : checkAnswer.error, APPLY_REFUSED.checking);
    fetch.resolve({});
    await running;
    // Another commit than the look names.
    const other = world(t);
    await other.updates.check();
    const otherAnswer = await other.updates.apply('e'.repeat(40));
    assert.equal(otherAnswer.ok ? '' : otherAnswer.error, APPLY_REFUSED.notListed);
    // Up to date now (a look made now says so).
    const current = world(t, { repo: { fetched: OLD } });
    const currentAnswer = await current.updates.apply(NEW);
    assert.equal(currentAnswer.ok ? '' : currentAnswer.error, APPLY_REFUSED.notListed);
    for (const w of [stopping, restoring, checking, other, current]) {
      assert.deepEqual(w.processes.calls, []);
      assert.equal(w.d.deck.store.getKv(RUN_KEY), null);
    }
  });

  test("blocked: the look's line and what to do; the new state goes to every page", async (t) => {
    const w = world(t, { repo: { status: ' M a.txt\0' } });
    const told = w.told.length;

    const answer = await w.updates.apply(NEW);

    assert.deepEqual(answer, {
      ok: false,
      error:
        'this checkout has changes that are not committed (1 file, the first: a.txt); commit or undo them first; open the dialog again once that is set right',
      update: w.updates.payload(),
    });
    assert.ok(w.told.length > told, 'the look told every page');
    assert.equal(w.told.at(-1)?.check?.state, 'available');
    assert.equal(w.fetches(), 0, 'the look made now uses no network');
    assert.deepEqual(w.processes.calls, []);
  });

  test("a second apply while one runs: 'an update is already running', also while the first is still starting", async (t) => {
    const w = world(t);
    await w.updates.check();
    const first = w.updates.apply(NEW); // its look still runs
    const second = await w.updates.apply(NEW);
    assert.deepEqual(second.ok ? '' : second.error, APPLY_REFUSED.running);
    assert.equal((await first).ok, true);
    const third = await w.updates.apply(NEW);
    assert.deepEqual(third.ok ? '' : third.error, APPLY_REFUSED.running);
    assert.equal(w.processes.calls.length, 1);
  });

  test('a start that rejects: the entry removed, `applying` taken back, the words with the kind', async (t) => {
    const w = world(t, {
      processes: fakeProcesses(() => {
        throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
      }),
    });
    await w.updates.check();

    const answer = await w.updates.apply(NEW);

    assert.deepEqual(answer, {
      ok: false,
      error:
        'the update could not be started (Error (EAGAIN)); run skydeck update in a terminal of your own',
      update: w.updates.payload(),
    });
    assert.equal(answer.update.applying, null);
    assert.equal(w.d.deck.store.getKv(RUN_KEY), null);
    assert.equal(w.told.at(-1)?.applying, null);
  });

  test('no tick starts a check while an update runs', async (t) => {
    const w = world(t);
    w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
    assert.equal((await w.updates.apply(NEW)).ok, true);
    w.d.clock.setNs(T0 + CHECK_EVERY_NS.daily * 2n);
    for (let i = 0; i < 3; i++) w.updates.tick();
    await flush();
    assert.equal(w.fetches(), 1);
  });
});

describe('Update now: how it ended', () => {
  test('the updater ends while the server runs, the entry `failed`: its line is the result, the entry removed, `applying` taken back, a look made', async (t) => {
    const run = updater();
    const w = world(t, { processes: fakeProcesses(() => run.detached) });
    await w.updates.check();
    await w.updates.apply(NEW);
    writeRun(w.d.deck.store, {
      v: 1,
      root: w.root,
      state: 'failed',
      to: NEW,
      line: "this checkout's git index is locked (/x/.git/index.lock): …; nothing was changed",
      atNs: String(T0),
    });
    const calls = w.runner.calls.length;

    run.end(1);
    await flush();

    const state = w.updates.payload();
    assert.deepEqual(state.result, {
      ok: false,
      text: "this checkout's git index is locked (/x/.git/index.lock): …; nothing was changed",
    });
    assert.equal(state.applying, null);
    assert.equal(w.d.deck.store.getKv(RUN_KEY), null);
    assert.ok(w.runner.calls.length > calls, 'a look was made');
    assert.equal(w.fetches(), 1, 'without the network');
    assert.deepEqual(w.told.at(-1), state);
  });

  test("the updater ends with the entry still `applying`: 'ended without saying how', with its exit and the log; the entry removed", async (t) => {
    const run = updater();
    const w = world(t, { processes: fakeProcesses(() => run.detached) });
    await w.updates.check();
    await w.updates.apply(NEW);

    run.end(3);
    await flush();

    const log = join(w.d.places.stateDir, 'update.log');
    assert.deepEqual(w.updates.payload().result, {
      ok: false,
      text: `the update ended without saying how (exit 3); see ${log}`,
    });
    assert.equal(w.updates.payload().applying, null);
    assert.equal(w.d.deck.store.getKv(RUN_KEY), null);
  });

  test("the updater ends while the entry names another root, or is gone: 'ended without saying how', and that entry is left as it is", async (t) => {
    for (const other of [true, false]) {
      const run = updater();
      const w = world(t, { processes: fakeProcesses(() => run.detached) });
      await w.updates.check();
      await w.updates.apply(NEW);
      const theirs: RunRecord = { v: 1, root: '/elsewhere', state: 'applied', to: NEW, atNs: '1' };
      if (other) writeRun(w.d.deck.store, theirs);
      else clearRun(w.d.deck.store);

      run.end(null, 'SIGKILL');
      await flush();

      const log = join(w.d.places.stateDir, 'update.log');
      assert.deepEqual(w.updates.payload().result, {
        ok: false,
        text: `the update ended without saying how (signal SIGKILL); see ${log}`,
      });
      assert.deepEqual(readRunEntry(w.d.deck.store), other ? theirs : null);
    }
  });

  test('a server that starts with the entry `applied` or `failed`: the result, the entry removed', async (t) => {
    for (const [entry, result] of [
      [
        { v: 1, state: 'applied', to: NEW, atNs: '1' },
        { ok: true, text: 'updated to fedcba9' },
      ],
      [
        {
          v: 1,
          state: 'failed',
          to: NEW,
          line: 'the update could not be applied: x; the checkout is as it was',
          atNs: '1',
        },
        { ok: false, text: 'the update could not be applied: x; the checkout is as it was' },
      ],
    ] as const) {
      const w = world(t, {
        before: (deck, root) => {
          writeRun(deck.store, { ...entry, root } as RunRecord);
        },
      });
      assert.deepEqual(w.updates.payload().result, result);
      assert.equal(w.d.deck.store.getKv(RUN_KEY), null);
    }
  });

  test("a server that starts with the entry still `applying` (an updater that could not record, also after an update that worked): 'did not record how it ended', not ok, the entry removed", async (t) => {
    const w = world(t, {
      before: (deck, root) => {
        writeRun(deck.store, {
          v: 1,
          root,
          state: 'applying',
          to: NEW,
          atNs: '1794474000000000000',
        });
      },
    });
    const log = join(w.d.places.stateDir, 'update.log');
    assert.deepEqual(w.updates.payload().result, {
      ok: false,
      text: `an update started from the window at 2026-11-12T09:00:00Z did not record how it ended; its log says: ${log}`,
    });
    assert.equal(w.d.deck.store.getKv(RUN_KEY), null);
  });

  test('a run entry of another root at the start: no result, the entry left as it is', async (t) => {
    const theirs: RunRecord = { v: 1, root: '/elsewhere', state: 'applied', to: NEW, atNs: '1' };
    const w = world(t, {
      before: (deck) => {
        writeRun(deck.store, theirs);
      },
    });
    assert.equal(w.updates.payload().result, null);
    assert.deepEqual(readRunEntry(w.d.deck.store), theirs);
  });

  test("the seam through a symbolic link: the `applying` entry's root is the real path, and the updater's entry for that checkout is this server's own", async (t) => {
    const run = updater();
    const w = world(t, { link: true, processes: fakeProcesses(() => run.detached) });
    await w.updates.check();
    await w.updates.apply(NEW);
    assert.notEqual(w.seam, w.root);
    assert.equal(readRunEntry(w.d.deck.store)?.root, w.root);
    assert.equal(w.processes.calls[0]?.command, join(w.seam, 'bin', 'skydeck'));
    // What the updater writes: checkoutRoot of the app root it resolved.
    writeRun(w.d.deck.store, {
      v: 1,
      root: checkoutRoot(w.deck.platform.files, w.seam),
      state: 'failed',
      to: NEW,
      line: 'a line of the updater',
      atNs: '2',
    });

    run.end(1);
    await flush();

    assert.deepEqual(w.updates.payload().result, { ok: false, text: 'a line of the updater' });
  });

  test('seen() clears the result and tells every page', async (t) => {
    const w = world(t, {
      before: (deck, root) => {
        writeRun(deck.store, { v: 1, root, state: 'applied', to: NEW, atNs: '1' });
      },
    });
    assert.notEqual(w.updates.payload().result, null);
    const told = w.told.length;
    const answer = w.updates.seen();
    assert.equal(answer.result, null);
    assert.equal(w.told.length, told + 1);
    assert.equal(w.told.at(-1)?.result, null);
  });
});

describe("Update now: the handler of the updater's end cannot end the server", () => {
  test("its `exited` settling while the store's getKv throws the busy error: one log line, `applying` taken back, a result naming the log, the pages told, no rejection", async (t) => {
    const seen = rejections(t);
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    let failing = false;
    const run = updater();
    const w = world(t, {
      processes: fakeProcesses(() => run.detached),
      deck: (deck) =>
        deckWith(deck, {
          store: {
            getKv: (key) => {
              if (failing) throw busy;
              return deck.store.getKv(key);
            },
          },
        }),
    });
    await w.updates.check();
    await w.updates.apply(NEW);
    failing = true;
    const logs = w.logs.length;

    run.end(1);
    await flush();

    const log = join(w.d.places.stateDir, 'update.log');
    assert.deepEqual(w.logs.slice(logs, logs + 1), [
      'update: the entry of the update could not be read (Error (ERR_SQLITE_ERROR))',
    ]);
    assert.equal(w.updates.payload().applying, null);
    assert.deepEqual(w.updates.payload().result, {
      ok: false,
      text: `the update ended without saying how (exit 1); see ${log}`,
    });
    assert.equal(w.told.at(-1)?.applying, null);
    assert.deepEqual(seen, []);
  });

  test('settling after stop() with the store closed: nothing read, written, sent or thrown', async (t) => {
    const seen = rejections(t);
    const run = updater();
    const w = world(t, { processes: fakeProcesses(() => run.detached) });
    await w.updates.check();
    await w.updates.apply(NEW);
    await w.updates.stop();
    w.d.deck.store.close();
    const told = w.told.length;
    const logs = [...w.logs];

    run.end(0);
    await flush();

    assert.equal(w.told.length, told);
    assert.deepEqual(w.logs, logs);
    assert.deepEqual(seen, []);
  });
});

describe('the core-limit program with the real python3', () => {
  /** A script that prints its core limits and its environment, then writes a marker. */
  function probe(dir: string): { script: string; marker: string } {
    const script = join(dir, 'probe.sh');
    const marker = join(dir, 'ran');
    writeFileSync(
      script,
      `#!/bin/sh\n/usr/bin/grep '^Max core file size' /proc/self/limits\n/usr/bin/env\n: > '${marker}'\n`,
      { mode: 0o755 },
    );
    return { script, marker };
  }

  /**
   * The program run as the updater's start runs it, from a python3 whose core limits are
   * (soft, hard) first, as the server's are: its output, status and whether the probe ran.
   */
  function runProgram(
    t: TestContext,
    limits: { soft: number; hard: number | null },
    args: { coreSoft: string; ctype: string | null },
    env: Record<string, string | undefined>,
  ): { status: number | null; out: string; err: string; ran: boolean } {
    const s = sandbox(t);
    const { script, marker } = probe(s.root);
    const setFirst = `import os, resource, sys
hard = ${limits.hard === null ? 'resource.getrlimit(resource.RLIMIT_CORE)[1]' : String(limits.hard)}
resource.setrlimit(resource.RLIMIT_CORE, (${limits.soft}, hard))
os.execv(sys.argv[1], sys.argv[1:])`;
    const result = spawnSync(
      PYTHON3,
      [
        '-c',
        setFirst,
        PYTHON3,
        '-I',
        '-S',
        '-c',
        CORE_LIMIT_PROGRAM,
        args.coreSoft,
        args.ctype === null ? '' : '1',
        args.ctype ?? '',
        script,
        'update',
        '--from-window',
        NEW,
      ],
      { env: s.env(env), encoding: 'utf8' },
    );
    return {
      status: result.status,
      out: result.stdout,
      err: result.stderr,
      ran: existsSync(marker),
    };
  }

  /** The soft and hard core limits the probe printed. */
  function limitsOf(out: string): string[] {
    return (/^Max core file size\s+(\S+)\s+(\S+)/m.exec(out) ?? []).slice(1, 3);
  }

  test("a soft limit of 1 is set back to the given one, the hard one kept; the command is exec'd", (t) => {
    const r = runProgram(t, { soft: 1, hard: 1_000_000 }, { coreSoft: '4096', ctype: null }, {});
    assert.equal(r.status, 0, r.err);
    assert.ok(r.ran);
    assert.deepEqual(limitsOf(r.out), ['4096', '1000000']);
  });

  test('a limit above the hard one is clamped to it; `unlimited` too', (t) => {
    for (const coreSoft of ['5000000', 'unlimited']) {
      const r = runProgram(t, { soft: 1, hard: 1_000_000 }, { coreSoft, ctype: null }, {});
      assert.equal(r.status, 0, r.err);
      assert.deepEqual(limitsOf(r.out), ['1000000', '1000000'], coreSoft);
    }
  });

  test("LC_CTYPE as given: unset stays unset, a value stays that value (python3's own coercion undone)", (t) => {
    const unset = runProgram(
      t,
      { soft: 1, hard: null },
      { coreSoft: '0', ctype: null },
      { LC_ALL: undefined, LANG: undefined, LC_CTYPE: undefined },
    );
    assert.equal(unset.status, 0, unset.err);
    assert.ok(!/^LC_CTYPE=/m.test(unset.out), unset.out);
    const posix = runProgram(
      t,
      { soft: 1, hard: null },
      { coreSoft: '0', ctype: 'POSIX' },
      { LC_ALL: undefined, LANG: undefined, LC_CTYPE: 'POSIX' },
    );
    assert.equal(posix.status, 0, posix.err);
    assert.match(posix.out, /^LC_CTYPE=POSIX$/m);
  });

  test('a value it cannot set: exit 1, one line, nothing run', (t) => {
    const r = runProgram(t, { soft: 1, hard: null }, { coreSoft: 'not-a-limit', ctype: null }, {});
    assert.equal(r.status, 1);
    assert.equal(r.ran, false);
    assert.match(
      r.err,
      /^skydeck: the soft core limit could not be set to not-a-limit \(.+\); the update was not run\n$/,
    );
  });
});

describe('Update now: the guards of review 2', () => {
  test('a look that does not run to its end after an `available` record: refused, nothing started (a runner that rejects, a files that throws)', async (t) => {
    for (const kind of ['the runner rejects', 'files throws'] as const) {
      const broken = { now: false };
      const w = world(t, {
        deck: (base) => ({
          ...base,
          platform: {
            ...base.platform,
            runner: {
              ...base.platform.runner,
              run: (command, args, options) =>
                broken.now && kind === 'the runner rejects'
                  ? Promise.reject(new Error('boom'))
                  : base.platform.runner.run(command, args, options),
            },
            files: new Proxy(base.platform.files, {
              get(target, key, receiver) {
                const value = Reflect.get(target, key, receiver) as unknown;
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  if (
                    broken.now &&
                    kind === 'files throws' &&
                    String(args[0]).includes('checkout')
                  ) {
                    throw new TypeError('boom from files');
                  }
                  return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
              },
            }),
          },
        }),
      });
      await w.updates.check();
      assert.equal(w.updates.payload().check?.state, 'available');
      broken.now = true;

      const answer = await w.updates.apply(NEW);

      assert.deepEqual(answer.ok ? '' : answer.error, APPLY_REFUSED.notListed, kind);
      assert.deepEqual(w.processes.calls, [], kind);
      assert.equal(w.d.deck.store.getKv(RUN_KEY), null, kind);
    }
  });

  test("an updater that ends once the server's stop has begun: the entry is neither read nor removed, nothing told", async (t) => {
    const run = updater();
    const w = world(t, { processes: fakeProcesses(() => run.detached) });
    await w.updates.check();
    await w.updates.apply(NEW);
    writeRun(w.d.deck.store, { v: 1, root: w.root, state: 'applied', to: NEW, atNs: '2' });
    w.serverStopping.now = true;
    const told = w.told.length;

    run.end(0);
    await flush();

    assert.deepEqual(readRunEntry(w.d.deck.store)?.state, 'applied', 'left for the next server');
    assert.equal(w.updates.payload().result, null);
    assert.equal(w.told.length, told);
  });

  test('Check now while an update runs or is being started: nothing starts, the state as it is', async (t) => {
    const w = world(t);
    await w.updates.check();
    const fetches = w.fetches();
    const applying = w.updates.apply(NEW); // its look still runs: `starting`
    const during = await w.updates.check();
    assert.equal(during.checking, false);
    assert.equal((await applying).ok, true);
    const after = await w.updates.check();
    assert.equal(after.checking, false);
    assert.notEqual(after.applying, null);
    await flush();
    assert.equal(w.fetches(), fetches, 'no fetch while an update starts or runs');
  });

  test("the server's stop during apply's look: refused as stopping, nothing started", async (t) => {
    const w = world(t);
    await w.updates.check();
    const applying = w.updates.apply(NEW);
    w.serverStopping.now = true;
    const answer = await applying;
    assert.equal(answer.ok ? '' : answer.error, APPLY_REFUSED.stopping);
    assert.deepEqual(w.processes.calls, []);
  });

  test('no tick starts a check while an update is being started (its look runs)', async (t) => {
    const w = world(t);
    await w.updates.check();
    const fetches = w.fetches();
    w.d.clock.setNs(T0 + CHECK_EVERY_NS.daily * 2n);
    const applying = w.updates.apply(NEW);
    w.updates.tick();
    await applying;
    await flush();
    assert.equal(w.fetches(), fetches);
  });

  test('a removal that fails at the start: its own log line, and no result shown, so that the next start shows it once', async (t) => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    let failing = true;
    const w = world(t, {
      before: (deck, root) => {
        writeRun(deck.store, { v: 1, root, state: 'applied', to: NEW, atNs: '1' });
      },
      deck: (deck) =>
        deckWith(deck, {
          store: {
            deleteKv: (key) => {
              if (failing) throw busy;
              deck.store.deleteKv(key);
            },
          },
        }),
    });
    assert.equal(w.updates.payload().result, null);
    assert.deepEqual(w.logs, [
      'update: the entry of the last update could not be removed (Error (ERR_SQLITE_ERROR))',
    ]);
    assert.equal(readRunEntry(w.d.deck.store)?.state, 'applied', 'left for the next start');
    failing = false;
    const next = createUpdates({
      deck: w.deck,
      changed: () => {},
      log: () => {},
      serverEnv: SERVER_ENV,
      coreSoft: null,
      originDir: () => '/',
      restoreRunning: () => false,
      stopping: () => false,
    });
    t.after(() => next.stop());
    assert.deepEqual(next.payload().result, { ok: true, text: 'updated to fedcba9' });
    assert.equal(w.d.deck.store.getKv(RUN_KEY), null);
  });
});
