import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import {
  BATCH_SIZE,
  CHIP_ORDER,
  GH_TIMEOUT_MS,
  batchArgs,
  chipFor,
  fetchPrs,
  parseBatch,
  prKey,
  prLevel,
  prsDue,
  refreshPrs,
} from '../src/github.ts';
import type { PrKey } from '../src/github.ts';
import { NS_PER_MINUTE } from '../src/platform/time.ts';
import type { Env, RunResult } from '../src/platform/types.ts';
import { openStore } from '../src/store/store.ts';
import type { Store } from '../src/store/store.ts';
import type { PrChecks, PrReview, PrRow, PrState } from '../src/store/types.ts';
import { S1, S2, SEC, T0, fakeClock, fakeRunner, runResult } from './helpers/platform.ts';
import type { RunCall } from './helpers/platform.ts';
import { sandbox } from './helpers/sandbox.ts';

const MIN = NS_PER_MINUTE;
const URL1 = 'https://github.com/o/r/pull/1';

function pr(over: Partial<PrRow> = {}): PrRow {
  return {
    url: URL1,
    owner: 'o',
    repo: 'r',
    number: 1,
    title: null,
    state: null,
    review: null,
    checks: null,
    okAtNs: null,
    triedAtNs: null,
    error: null,
    ...over,
  };
}

function key(url: string): PrKey {
  const parsed = prKey(url);
  assert.ok(parsed, `${url} is a pull request url`);
  return parsed;
}

/** The `pullRequest` object GitHub returns. `rollup` undefined → no commit node at all. */
function prJson(
  state: string,
  isDraft: boolean,
  review: string | null,
  rollup: string | null | undefined,
): Record<string, unknown> {
  return {
    title: 'T',
    state,
    isDraft,
    reviewDecision: review,
    commits: {
      nodes:
        rollup === undefined
          ? []
          : [{ commit: { statusCheckRollup: rollup === null ? null : { state: rollup } } }],
    },
  };
}

const OK_JSON = prJson('OPEN', false, 'APPROVED', 'SUCCESS');

/** What `gh api graphql` prints: one `{ pullRequest }` per alias. */
function ghStdout(pullRequests: unknown[], errors?: unknown[]): string {
  const data: Record<string, unknown> = {};
  pullRequests.forEach((value, i) => {
    data[`p${i}`] = { pullRequest: value };
  });
  return JSON.stringify(errors === undefined ? { data } : { data, errors });
}

/** The number of aliases a `gh` call asks about. */
function aliasesOf(call: RunCall): number {
  return call.args.filter((arg) => /^n\d+=/.test(arg)).length;
}

/** The pull-request numbers a `gh` call asks about, in alias order. */
function numbersOf(call: RunCall): number[] {
  return call.args.filter((arg) => /^n\d+=/.test(arg)).map((arg) => Number(arg.split('=')[1]));
}

/** A fake `gh` that answers every alias of every call with `pullRequest`. */
function answerAll(pullRequest: unknown = OK_JSON): (call: RunCall) => RunResult {
  return (call) =>
    runResult({ stdout: ghStdout(Array.from({ length: aliasesOf(call) }, () => pullRequest)) });
}

const NUM = (n: number): string => `https://github.com/o/r/pull/${n}`;

/** The environment of the "calling process" in these tests: with the three variables `gh` must not see. */
const ENV: Env = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  GH_TOKEN: 'token',
  GH_HOST: 'ghe.example.com',
  GH_FORCE_TTY: '1',
  CLICOLOR_FORCE: '1',
  GH_PROMPT_DISABLED: '0',
  NO_COLOR: undefined,
  TERM: undefined,
};

/** What `gh` gets of ENV: GH_HOST, GH_FORCE_TTY and CLICOLOR_FORCE gone, the two settings made, the rest passed. */
const GH_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  GH_TOKEN: 'token',
  GH_PROMPT_DISABLED: '1',
  NO_COLOR: '1',
};

interface Deck {
  store: Store;
  runner: ReturnType<typeof fakeRunner>;
  clock: ReturnType<typeof fakeClock>;
  deps: {
    runner: ReturnType<typeof fakeRunner>;
    clock: ReturnType<typeof fakeClock>;
    store: Store;
    env: Env;
  };
}

/** A store on a temporary database, a fake clock at T0 and a fake `gh`. */
function deck(t: TestContext, handler?: (call: RunCall) => RunResult | Promise<RunResult>): Deck {
  const store = openStore(join(sandbox(t).root, 'skydeck.db'));
  t.after(() => {
    store.close();
  });
  const runner = fakeRunner(handler);
  const clock = fakeClock(T0);
  return { store, runner, clock, deps: { runner, clock, store, env: ENV } };
}

/**
 * Adds pull requests o/r#from..to, each attached to S1 (a refresh asks only about attached ones);
 * `seen` gives them a successful fetch `ageMin` minutes ago.
 */
function seed(
  store: Store,
  from: number,
  to: number,
  seen?: { state: PrState; ageMin: number; review?: PrReview; checks?: PrChecks },
): void {
  store.transaction(() => {
    for (let number = from; number <= to; number++) {
      store.ensurePr({ url: NUM(number), owner: 'o', repo: 'r', number });
      store.attachPr(S1, NUM(number), 'auto', T0);
      if (seen !== undefined) {
        store.savePrResult(NUM(number), {
          ok: true,
          atNs: T0 - BigInt(seen.ageMin) * MIN,
          title: 'old',
          state: seen.state,
          review: seen.review ?? null,
          checks: seen.checks ?? null,
        });
      }
    }
  });
}

function row(store: Store, number: number): PrRow {
  const found = store.prs().find((p) => p.url === NUM(number));
  assert.ok(found, `row ${number} exists`);
  return found;
}

describe('constants', () => {
  test('a batch holds at most 50 pull requests and gh gets 10 seconds', () => {
    assert.equal(BATCH_SIZE, 50);
    assert.equal(GH_TIMEOUT_MS, 10_000);
  });
});

describe('prsDue', () => {
  const rows = (over: Partial<PrRow>): PrRow[] => [pr(over)];
  /** A row whose last attempt, a success, was `ageSec` seconds ago. */
  const tried = (ageSec: bigint, over: Partial<PrRow> = {}): PrRow[] =>
    rows({ state: 'open', okAtNs: T0 - ageSec * SEC, triedAtNs: T0 - ageSec * SEC, ...over });

  test('merged and closed rows are never due, not even when forced', () => {
    for (const state of ['merged', 'closed'] as const) {
      const old = { state, okAtNs: T0 - 600n * MIN, triedAtNs: T0 - 600n * MIN };
      assert.deepEqual(prsDue(rows(old), T0, 5, false), []);
      assert.deepEqual(prsDue(rows({ state, okAtNs: null }), T0, 5, true), []);
      assert.deepEqual(prsDue(rows(old), T0, 5, true), []);
    }
  });

  test('an open row last tried 10 minutes ago is due with a 5 minute refresh', () => {
    const due = tried(600n);
    assert.deepEqual(prsDue(due, T0, 5, false), due);
  });

  test('an open row last tried 1 minute ago is not due', () => {
    assert.deepEqual(prsDue(tried(60n), T0, 5, false), []);
  });

  test('"older than" is strict: exactly the refresh age is not due, one nanosecond more is', () => {
    const at = (triedAtNs: bigint) => rows({ state: 'open', okAtNs: triedAtNs, triedAtNs });
    assert.deepEqual(prsDue(at(T0 - 5n * MIN), T0, 5, false), []);
    assert.equal(prsDue(at(T0 - 5n * MIN - 1n), T0, 5, false).length, 1);
  });

  test('a row that was never tried is due, whatever its state', () => {
    for (const state of ['open', 'draft', null] as const) {
      assert.equal(prsDue(rows({ state, triedAtNs: null }), T0, 5, false).length, 1, `${state}`);
    }
  });

  test('a row that failed, with no success ever, is due only when its last attempt is old enough', () => {
    const failed = (ageSec: bigint) =>
      rows({ state: null, error: 'x', okAtNs: null, triedAtNs: T0 - ageSec * SEC });
    assert.deepEqual(prsDue(failed(60n), T0, 5, false), [], 'tried a minute ago: not again yet');
    assert.equal(prsDue(failed(6n * 60n), T0, 5, false).length, 1, 'tried 6 minutes ago: due');
  });

  test('the last attempt counts, not the last success: a recent failure after an old success is not due', () => {
    const recentFailure = rows({
      state: 'open',
      okAtNs: T0 - 20n * MIN,
      triedAtNs: T0 - MIN,
      error: 'x',
    });
    assert.deepEqual(prsDue(recentFailure, T0, 5, false), []);
  });

  test('a failure after a recent success is not due before the refresh age, and is due after it', () => {
    const failedAfterSuccess = (triedAgoMin: bigint) =>
      rows({
        state: 'open',
        okAtNs: T0 - 2n * MIN,
        triedAtNs: T0 - triedAgoMin * MIN,
        error: 'x',
      });
    assert.deepEqual(prsDue(failedAfterSuccess(1n), T0, 5, false), []);
    assert.equal(prsDue(failedAfterSuccess(6n), T0, 5, false).length, 1);
  });

  test('force makes every non-final row due, whatever its age and its last result', () => {
    const all = [
      pr({ state: 'open', okAtNs: T0 - MIN, triedAtNs: T0 - MIN }),
      pr({ state: 'open', okAtNs: T0 - 2n * MIN, triedAtNs: T0 - MIN, error: 'x' }),
      pr({ state: 'draft', okAtNs: T0, triedAtNs: T0 }),
      pr({ state: null }),
      pr({ state: 'merged', okAtNs: T0 - 600n * MIN }),
      pr({ state: 'closed' }),
    ];
    assert.deepEqual(prsDue(all, T0, 5, true), all.slice(0, 4));
  });

  test('a refresh age that is not a whole number of minutes still works', () => {
    assert.equal(prsDue(tried(29n), T0, 0.5, false).length, 0);
    assert.equal(prsDue(tried(31n), T0, 0.5, false).length, 1);
  });

  test('the order of the rows is kept and the input is not changed', () => {
    const input = [
      pr({ url: NUM(3), number: 3, state: 'open' }),
      pr({ url: NUM(1), number: 1, state: 'open' }),
    ];
    const copy = structuredClone(input);
    assert.deepEqual(
      prsDue(input, T0, 5, false).map((p) => p.number),
      [3, 1],
    );
    assert.deepEqual(input, copy);
  });
});

describe('batchArgs', () => {
  const keys = [key('https://github.com/o/r/pull/1'), key('https://github.com/a/b/pull/22')];
  const args = batchArgs(keys);

  test('starts with api graphql, always against github.com, then -f query=<query>', () => {
    assert.deepEqual(args.slice(0, 5), ['api', 'graphql', '--hostname', 'github.com', '-f']);
    assert.ok(args[5]?.startsWith('query='));
  });

  test('then the owner, repository and number of every key as variables', () => {
    assert.deepEqual(args.slice(6), [
      '-f',
      'o0=o',
      '-f',
      'r0=r',
      '-F',
      'n0=1',
      '-f',
      'o1=a',
      '-f',
      'r1=b',
      '-F',
      'n1=22',
    ]);
  });

  test('the query declares the variables and asks for the status of each pull request', () => {
    const query = (args[5] ?? '').slice('query='.length);
    assert.ok(
      query.includes(
        '$o0: String!, $r0: String!, $n0: Int!, $o1: String!, $r1: String!, $n1: Int!',
      ),
    );
    assert.ok(query.includes('p0: repository(owner: $o0, name: $r0)'));
    assert.ok(query.includes('p1: repository(owner: $o1, name: $r1)'));
    assert.ok(query.includes('pullRequest(number: $n0)'));
    assert.ok(query.includes('pullRequest(number: $n1)'));
    for (const field of ['title', 'state', 'isDraft', 'reviewDecision', 'statusCheckRollup']) {
      assert.ok(query.includes(field), field);
    }
    assert.ok(!query.includes('o/r'));
    assert.ok(!query.includes('a/b'));
  });

  test('values never appear inside the query text, whatever they contain', () => {
    const hostile: PrKey = { url: 'u', owner: 'a"}) { x', repo: "r'\\n", number: 7 };
    const list = batchArgs([hostile]);
    const query = list[5] ?? '';
    assert.ok(!query.includes('a"}'));
    assert.ok(!query.includes("r'"));
    assert.ok(list.includes('o0=a"}) { x'));
    assert.ok(list.includes("r0=r'\\n"));
  });

  test('a batch holds from 1 to BATCH_SIZE keys', () => {
    const one = key(URL1);
    assert.equal(batchArgs([one]).length, 6 + 6);
    assert.equal(
      batchArgs(Array.from({ length: BATCH_SIZE }, () => one)).length,
      6 + 6 * BATCH_SIZE,
    );
    assert.throws(() => batchArgs([]), RangeError);
    assert.throws(() => batchArgs(Array.from({ length: BATCH_SIZE + 1 }, () => one)), RangeError);
  });
});

describe('parseBatch', () => {
  const keys = [key(NUM(1)), key(NUM(2))];

  function parse(stdout: string, over: Partial<RunResult> = {}) {
    return parseBatch(keys, runResult({ stdout, ...over }), T0);
  }

  test('a readable pull request becomes an ok result', () => {
    const results = parse(ghStdout([OK_JSON, OK_JSON]));
    assert.deepEqual(results.get(NUM(1)), {
      ok: true,
      atNs: T0,
      title: 'T',
      state: 'open',
      review: 'approved',
      checks: 'passing',
    });
    assert.equal(results.size, 2);
    assert.equal(results.get(NUM(2))?.ok, true);
  });

  test('a draft awaiting review with pending checks', () => {
    const result = parse(
      ghStdout([prJson('OPEN', true, 'REVIEW_REQUIRED', 'PENDING'), OK_JSON]),
    ).get(NUM(1));
    assert.deepEqual(result, {
      ok: true,
      atNs: T0,
      title: 'T',
      state: 'draft',
      review: 'review-required',
      checks: 'pending',
    });
  });

  test('MERGED is merged and CLOSED is closed, draft or not', () => {
    const merged = parse(ghStdout([prJson('MERGED', false, null, null), OK_JSON])).get(NUM(1));
    const closed = parse(ghStdout([prJson('CLOSED', true, null, null), OK_JSON])).get(NUM(1));
    assert.equal(merged?.ok && merged.state, 'merged');
    assert.equal(closed?.ok && closed.state, 'closed');
  });

  test('a null rollup and a commit list without nodes both mean checks null', () => {
    const nullRollup = parse(ghStdout([prJson('OPEN', false, null, null), OK_JSON])).get(NUM(1));
    const noCommit = parse(ghStdout([prJson('OPEN', false, null, undefined), OK_JSON])).get(NUM(1));
    assert.equal(nullRollup?.ok && nullRollup.checks, null);
    assert.equal(noCommit?.ok && noCommit.checks, null);
  });

  test('FAILURE and ERROR are failing; PENDING and EXPECTED are pending; others are null', () => {
    const checks = (rollup: string): PrChecks | null | undefined => {
      const result = parse(ghStdout([prJson('OPEN', false, null, rollup), OK_JSON])).get(NUM(1));
      return result?.ok ? result.checks : undefined;
    };
    assert.equal(checks('SUCCESS'), 'passing');
    assert.equal(checks('FAILURE'), 'failing');
    assert.equal(checks('ERROR'), 'failing');
    assert.equal(checks('PENDING'), 'pending');
    assert.equal(checks('EXPECTED'), 'pending');
    assert.equal(checks('SOMETHING_NEW'), null);
  });

  test('the review decision: approved, changes requested, required, anything else null', () => {
    const review = (decision: string | null): PrReview | null | undefined => {
      const result = parse(ghStdout([prJson('OPEN', false, decision, null), OK_JSON])).get(NUM(1));
      return result?.ok ? result.review : undefined;
    };
    assert.equal(review('APPROVED'), 'approved');
    assert.equal(review('CHANGES_REQUESTED'), 'changes-requested');
    assert.equal(review('REVIEW_REQUIRED'), 'review-required');
    assert.equal(review(null), null);
    assert.equal(review('SOMETHING_NEW'), null);
  });

  test('an alias GitHub could not resolve gets the message of its own error; the rest is used', () => {
    const stdout = JSON.stringify({
      data: { p0: { pullRequest: OK_JSON }, p1: null },
      errors: [
        { path: ['p0', 'pullRequest', 'commits'], message: 'about p0, which is readable' },
        {
          path: ['p1', 'pullRequest'],
          message: 'Could not resolve to a PullRequest with the number of 2.',
        },
      ],
    });
    const results = parse(stdout, { code: 1 });
    assert.equal(results.get(NUM(1))?.ok, true);
    assert.deepEqual(results.get(NUM(2)), {
      ok: false,
      atNs: T0,
      error: 'Could not resolve to a PullRequest with the number of 2.',
    });
  });

  test('a pull request that is null inside its repository, or a repository that is null, is unreadable', () => {
    const inner = parse(ghStdout([OK_JSON, null])).get(NUM(2));
    assert.deepEqual(inner, { ok: false, atNs: T0, error: 'not found' });
    const outer = parse(JSON.stringify({ data: { p0: { pullRequest: OK_JSON }, p1: null } }));
    assert.deepEqual(outer.get(NUM(2)), { ok: false, atNs: T0, error: 'not found' });
  });

  test('an alias that is missing, with no errors, is "not found"', () => {
    const stdout = JSON.stringify({ data: { p0: { pullRequest: OK_JSON } } });
    assert.deepEqual(parse(stdout).get(NUM(2)), { ok: false, atNs: T0, error: 'not found' });
  });

  test('an error entry of another alias, or one without a message, is not borrowed', () => {
    const stdout = JSON.stringify({
      data: { p0: { pullRequest: OK_JSON } },
      errors: [
        { path: ['p0'], message: 'about p0' },
        { path: ['p1'] },
        { path: ['p1', 'x'], message: 7 },
      ],
    });
    assert.deepEqual(parse(stdout).get(NUM(2)), { ok: false, atNs: T0, error: 'not found' });
  });

  test('an error that names no path is the message of every alias that has none of its own', () => {
    const message =
      'Something went wrong while executing your query. This may be the result of a timeout.';
    for (const noPath of [{ message }, { path: [], message }, { path: 'p1', message }]) {
      const stdout = JSON.stringify({
        data: { p0: { pullRequest: OK_JSON }, p1: null },
        errors: [noPath],
      });
      const results = parse(stdout, { code: 1 });
      assert.deepEqual(results.get(NUM(2)), { ok: false, atNs: T0, error: message });
      assert.equal(results.get(NUM(1))?.ok, true, 'a readable pull request stays readable');
    }
  });

  test('the error of the alias itself wins over one with no path, wherever it stands', () => {
    const stdout = JSON.stringify({
      data: { p0: null, p1: null },
      errors: [
        { message: 'no path' },
        { path: ['p1', 'pullRequest'], message: 'own error of p1' },
        { path: ['p0'], message: 'own error of p0' },
      ],
    });
    const results = parse(stdout, { code: 1 });
    assert.deepEqual(results.get(NUM(1)), { ok: false, atNs: T0, error: 'own error of p0' });
    assert.deepEqual(results.get(NUM(2)), { ok: false, atNs: T0, error: 'own error of p1' });
  });

  test('of several errors with no path the first one is used', () => {
    const stdout = JSON.stringify({
      data: { p0: { pullRequest: OK_JSON }, p1: null },
      errors: [{ message: 'first' }, { message: 'second' }],
    });
    assert.deepEqual(parse(stdout).get(NUM(2)), { ok: false, atNs: T0, error: 'first' });
  });

  test('a state GitHub added that we do not know is an error, never "closed"', () => {
    const result = parse(ghStdout([prJson('SUSPENDED', false, null, null), OK_JSON])).get(NUM(1));
    assert.equal(result?.ok, false);
  });

  test('a pull request without a title is an error', () => {
    const noTitle = { ...OK_JSON, title: undefined };
    assert.equal(parse(ghStdout([noTitle, OK_JSON])).get(NUM(1))?.ok, false);
  });

  test('a timeout fails every key with its own message', () => {
    const results = parse('', { timedOut: true, code: null });
    for (const url of [NUM(1), NUM(2)]) {
      assert.deepEqual(results.get(url), { ok: false, atNs: T0, error: 'gh timed out after 10 s' });
    }
  });

  test('gh missing fails every key with its own message', () => {
    const results = parse('', { notFound: true, code: null });
    for (const url of [NUM(1), NUM(2)]) {
      assert.deepEqual(results.get(url), { ok: false, atNs: T0, error: 'gh is not installed' });
    }
  });

  test('output that is not an answer fails every key with the first line of stderr', () => {
    const results = parse('', { code: 1, stderr: 'HTTP 401: Bad credentials\nmore' });
    for (const url of [NUM(1), NUM(2)]) {
      assert.deepEqual(results.get(url), {
        ok: false,
        atNs: T0,
        error: 'HTTP 401: Bad credentials',
      });
    }
  });

  test('without stderr the message is the exit code', () => {
    const results = parse('', { code: 4 });
    assert.deepEqual(results.get(NUM(1)), { ok: false, atNs: T0, error: 'gh exited 4' });
  });

  test('exit 0 with output that cannot be read says so, and borrows nothing from stderr', () => {
    const coloured = '\x1b[1;38m{\x1b[m\x1b[1;34m"data"\x1b[m: {}\x1b[1;38m}\x1b[m';
    const message = 'gh returned output skydeck could not read';
    for (const stderr of ['', 'gh: Could not resolve to a PullRequest with the number of 2.']) {
      for (const stdout of [coloured, '', 'null', '{"data":null}']) {
        const results = parse(stdout, { code: 0, stderr });
        for (const url of [NUM(1), NUM(2)]) {
          assert.deepEqual(results.get(url), { ok: false, atNs: T0, error: message }, stdout);
        }
      }
    }
  });

  test('a non-zero exit with output that cannot be read still reports the first line of stderr', () => {
    const coloured = '\x1b[1;38m{\x1b[m}';
    const results = parse(coloured, { code: 1, stderr: 'gh: HTTP 502' });
    assert.deepEqual(results.get(NUM(1)), { ok: false, atNs: T0, error: 'gh: HTTP 502' });
  });

  test('blank lines before the message of stderr are skipped', () => {
    const results = parse('', { code: 1, stderr: '\r\n  \n gh: rate limited \r\nmore' });
    assert.deepEqual(results.get(NUM(1)), { ok: false, atNs: T0, error: 'gh: rate limited' });
  });

  test('a process killed by a signal has no exit code to name', () => {
    const results = parse('', { code: null });
    assert.deepEqual(results.get(NUM(1)), {
      ok: false,
      atNs: T0,
      error: 'gh was killed by a signal',
    });
  });

  test('stdout that is JSON but has no data object counts as no answer', () => {
    for (const stdout of [
      '{"message":"Bad credentials"}',
      '{"data":null,"errors":[{"message":"x"}]}',
      '{"data":[]}',
      '{"data":"x"}',
      'null',
      '[]',
      '"text"',
      '42',
      'not json',
      '{"data":',
    ]) {
      const results = parse(stdout, { code: 1, stderr: 'boom' });
      assert.deepEqual(results.get(NUM(1)), { ok: false, atNs: T0, error: 'boom' }, stdout);
      assert.deepEqual(results.get(NUM(2)), { ok: false, atNs: T0, error: 'boom' }, stdout);
    }
  });

  test('there is one result per key, in a map keyed by url', () => {
    const results = parse(ghStdout([OK_JSON, OK_JSON]));
    assert.deepEqual([...results.keys()], [NUM(1), NUM(2)]);
  });
});

describe('fetchPrs and refreshPrs', () => {
  test('120 due rows go out in 3 gh calls of 50, 50 and 20, each with a 10 second timeout', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 120, { state: 'open', ageMin: 10 });
    const outcome = await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.deepEqual(outcome, { fetched: 120, failed: 0 });
    assert.deepEqual(runner.calls.map(aliasesOf), [50, 50, 20]);
    for (const call of runner.calls) {
      assert.equal(call.command, 'gh');
      assert.deepEqual(call.options, { timeoutMs: 10000, env: GH_ENV });
    }
    for (const p of store.prs()) {
      assert.equal(p.okAtNs, T0);
      assert.equal(p.triedAtNs, T0);
      assert.equal(p.error, null);
      assert.equal(p.state, 'open');
      assert.equal(p.review, 'approved');
      assert.equal(p.checks, 'passing');
      assert.equal(p.title, 'T');
    }
  });

  test('every pull request is asked about once, under the alias of its own number', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 60, { state: 'open', ageMin: 10 });
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    const asked = runner.calls.flatMap(numbersOf).sort((a, b) => a - b);
    assert.deepEqual(
      asked,
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
  });

  test('a batch that timed out keeps the old status, records the attempt and counts as failed', async (t) => {
    let call = 0;
    const { store, runner, deps } = deck(t, (c) =>
      ++call === 1 ? runResult({ code: null, timedOut: true }) : answerAll()(c),
    );
    seed(store, 1, 60, { state: 'open', ageMin: 10, review: 'approved', checks: 'passing' });
    const outcome = await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.deepEqual(outcome, { fetched: 10, failed: 50 });
    const [first, second] = runner.calls;
    assert.ok(first && second);
    for (const number of numbersOf(first)) {
      const failed = row(store, number);
      assert.equal(failed.state, 'open');
      assert.equal(failed.title, 'old');
      assert.equal(failed.review, 'approved');
      assert.equal(failed.checks, 'passing');
      assert.equal(failed.okAtNs, T0 - 10n * MIN);
      assert.equal(failed.triedAtNs, T0);
      assert.equal(failed.error, 'gh timed out after 10 s');
    }
    for (const number of numbersOf(second)) {
      const fresh = row(store, number);
      assert.equal(fresh.okAtNs, T0);
      assert.equal(fresh.title, 'T');
      assert.equal(fresh.error, null);
    }
  });

  test('a failed batch does not stop the batches after it', async (t) => {
    const { store, runner, deps } = deck(t, () => runResult({ code: 1, stderr: 'HTTP 502' }));
    seed(store, 1, 60);
    const outcome = await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.deepEqual(outcome, { fetched: 0, failed: 60 });
    assert.equal(runner.calls.length, 2);
    assert.ok(store.prs().every((p) => p.error === 'HTTP 502' && p.state === null));
  });

  test('a gh that cannot be started is a failure of the rows, not an exception', async (t) => {
    const { store, deps } = deck(t, () => {
      throw new Error('spawn gh EACCES\nstack');
    });
    seed(store, 1, 2);
    const outcome = await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.deepEqual(outcome, { fetched: 0, failed: 2 });
    assert.equal(row(store, 1).error, 'gh could not be run: spawn gh EACCES');
    assert.equal(row(store, 1).triedAtNs, T0);
  });

  test('gh missing fails the rows with a message and leaves them readable later', async (t) => {
    const { store, deps } = deck(t, () => runResult({ code: null, notFound: true }));
    seed(store, 1, 3);
    assert.deepEqual(await refreshPrs(deps, { force: false, refreshMinutes: 5 }), {
      fetched: 0,
      failed: 3,
    });
    assert.ok(store.prs().every((p) => p.error === 'gh is not installed'));
  });

  test('a pull request GitHub cannot find is saved as failed with its message', async (t) => {
    const { store, deps } = deck(t, () =>
      runResult({
        code: 1,
        stdout: JSON.stringify({
          data: { p0: { pullRequest: OK_JSON }, p1: { pullRequest: null } },
          errors: [{ path: ['p1', 'pullRequest'], message: 'Could not resolve' }],
        }),
      }),
    );
    seed(store, 1, 2);
    assert.deepEqual(await refreshPrs(deps, { force: false, refreshMinutes: 5 }), {
      fetched: 1,
      failed: 1,
    });
    assert.equal(row(store, 1).state, 'open');
    assert.equal(row(store, 2).state, null);
    assert.equal(row(store, 2).error, 'Could not resolve');
  });

  test('merged and closed rows are never sent, even when forced', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1, { state: 'merged', ageMin: 600 });
    seed(store, 2, 2, { state: 'closed', ageMin: 600 });
    seed(store, 3, 3, { state: 'open', ageMin: 10 });
    await refreshPrs(deps, { force: true, refreshMinutes: 5 });
    assert.deepEqual(runner.calls.flatMap(numbersOf), [3]);
    assert.equal(row(store, 1).okAtNs, T0 - 600n * MIN);
    assert.equal(row(store, 1).state, 'merged');
  });

  test('a row that is not due is sent only when forced', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1, { state: 'open', ageMin: 1 });
    assert.deepEqual(await refreshPrs(deps, { force: false, refreshMinutes: 5 }), {
      fetched: 0,
      failed: 0,
    });
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(await refreshPrs(deps, { force: true, refreshMinutes: 5 }), {
      fetched: 1,
      failed: 0,
    });
    assert.equal(runner.calls.length, 1);
  });

  test('with nothing due there is no gh call', async (t) => {
    const { runner, deps } = deck(t, answerAll());
    assert.deepEqual(await refreshPrs(deps, { force: true, refreshMinutes: 5 }), {
      fetched: 0,
      failed: 0,
    });
    assert.equal(runner.calls.length, 0);
  });

  test('refreshPrs leaves out a pull request that no session has attached any more, even when forced', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 3, { state: 'open', ageMin: 10 });
    store.attachPr(S2, NUM(3), 'auto', T0);
    store.ensurePr({ url: NUM(4), owner: 'o', repo: 'r', number: 4 }); // known, attached to nobody
    store.detachPr(S1, NUM(2), T0); // its only attachment is gone
    store.detachPr(S1, NUM(3), T0); // S2 still has it

    for (const force of [false, true]) {
      runner.calls.length = 0;
      await refreshPrs(deps, { force, refreshMinutes: 5 });
      assert.deepEqual(runner.calls.flatMap(numbersOf).sort(), [1, 3], `force ${force}`);
    }
    assert.equal(row(store, 2).triedAtNs, T0 - 10n * MIN, 'the detached one was never asked about');
    assert.equal(row(store, 4).triedAtNs, null);
  });

  test('refreshPrs asks about a pull request again once a session has it attached again', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1, { state: 'open', ageMin: 10 });
    store.detachPr(S1, NUM(1), T0);
    await refreshPrs(deps, { force: true, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 0);

    store.attachPr(S1, NUM(1), 'manual', T0);
    await refreshPrs(deps, { force: true, refreshMinutes: 5 });
    assert.deepEqual(runner.calls.flatMap(numbersOf), [1]);
  });

  test('fetchPrs fetches exactly the pull requests it is given, due or not', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 2, { state: 'open', ageMin: 1 });
    const outcome = await fetchPrs(deps, [NUM(1)]);
    assert.deepEqual(outcome, { fetched: 1, failed: 0 });
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(numbersOf(runner.calls[0] as RunCall), [1]);
    assert.equal(row(store, 1).okAtNs, T0);
    assert.equal(row(store, 1).title, 'T');
    assert.equal(row(store, 2).title, 'old');
  });

  test('an abort while gh runs saves nothing and starts no further batch', async (t) => {
    const controller = new AbortController();
    const { store, runner, deps } = deck(t, () => new Promise<RunResult>(() => {}));
    seed(store, 1, 60, { state: 'open', ageMin: 10 });

    const fetching = refreshPrs(deps, {
      force: false,
      refreshMinutes: 5,
      signal: controller.signal,
    });
    controller.abort();

    assert.deepEqual(await fetching, { fetched: 0, failed: 0 });
    assert.equal(runner.calls.length, 1, 'the second batch never started');
    assert.equal(runner.calls[0]?.options?.signal, controller.signal);
    assert.ok(store.prs().every((p) => p.triedAtNs === T0 - 10n * MIN && p.error === null));
  });

  test('an answer that arrives after the abort is not saved', async (t) => {
    const controller = new AbortController();
    const { store, deps } = deck(t);
    // A gh that answered just as the signal fired: the runner hands its result back anyway.
    const late = {
      ...deps.runner,
      run: (command: string, args: readonly string[]): Promise<RunResult> => {
        controller.abort();
        return Promise.resolve(answerAll()({ command, args, options: undefined }));
      },
    };
    seed(store, 1, 2, { state: 'open', ageMin: 10 });

    const outcome = await fetchPrs({ ...deps, runner: late }, [NUM(1), NUM(2)], {
      signal: controller.signal,
    });

    assert.deepEqual(outcome, { fetched: 0, failed: 0 });
    assert.ok(store.prs().every((p) => p.title === 'old' && p.triedAtNs === T0 - 10n * MIN));
  });

  test('a signal that is already aborted asks gh nothing', async (t) => {
    const controller = new AbortController();
    controller.abort();
    const { store, deps } = deck(t);
    let asked = 0;
    const counting = {
      ...deps.runner,
      run: (): Promise<RunResult> => {
        asked++;
        return Promise.resolve(runResult({}));
      },
    };
    seed(store, 1, 2, { state: 'open', ageMin: 10 });

    const outcome = await fetchPrs({ ...deps, runner: counting }, [NUM(1), NUM(2)], {
      signal: controller.signal,
    });

    assert.deepEqual(outcome, { fetched: 0, failed: 0 });
    assert.equal(asked, 0);
  });

  test('without a signal the options of the gh call have none', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1, { state: 'open', ageMin: 10 });

    await fetchPrs(deps, [NUM(1)]);

    assert.equal(Object.hasOwn(runner.calls[0]?.options ?? {}, 'signal'), false);
  });

  test('fetchPrs with no urls makes no call', async (t) => {
    const { runner, deps } = deck(t, answerAll());
    assert.deepEqual(await fetchPrs(deps, []), { fetched: 0, failed: 0 });
    assert.equal(runner.calls.length, 0);
  });

  test('a url that is no row of the store is not asked about, and a repeated one only once', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1);
    const outcome = await fetchPrs(deps, [NUM(1), NUM(9), NUM(1)]);
    assert.deepEqual(outcome, { fetched: 1, failed: 0 });
    assert.deepEqual(runner.calls.flatMap(numbersOf), [1]);
    assert.deepEqual(await fetchPrs(deps, [NUM(9)]), { fetched: 0, failed: 0 });
    assert.equal(runner.calls.length, 1);
  });

  test('the time of a result is the clock when the answer arrived', async (t) => {
    const { store, clock, deps } = deck(t, (c) => {
      clock.advanceMs(2500);
      return answerAll()(c);
    });
    seed(store, 1, 1);
    await fetchPrs(deps, [NUM(1)]);
    assert.equal(row(store, 1).okAtNs, T0 + 2n * SEC + 500_000_000n);
  });

  test('a refresh after a success is not due again until the refresh age has passed', async (t) => {
    const { store, clock, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1);
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    clock.advanceMs(4 * 60_000);
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 1);
    clock.advanceMs(2 * 60_000);
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 2);
  });
});

describe('refreshPrs: the pace of an automatic refresh, and the explicit one', () => {
  const timedOut = (): RunResult => runResult({ code: null, timedOut: true });

  test('a pull request that keeps failing is asked about at the pace of the refresh age, not at every refresh', async (t) => {
    const { store, clock, runner, deps } = deck(t, timedOut);
    seed(store, 1, 1);
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 1, 'never tried: asked');
    clock.advanceMs(4 * 60_000);
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 1, 'the last attempt was 4 minutes ago');
    clock.advanceMs(2 * 60_000);
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 2, 'the last attempt was 6 minutes ago');
  });

  test('with session ids, only the pull requests those sessions have attached are asked about', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 4, { state: 'open', ageMin: 10 }); // all attached to S1
    store.attachPr(S2, NUM(4), 'auto', T0); // 4 is S2's too
    store.detachPr(S1, NUM(4), T0); // …and no longer S1's
    for (const [sessionIds, expected] of [
      [[S1], [1, 2, 3]],
      [[S2], [4]],
      [
        [S1, S2],
        [1, 2, 3, 4],
      ],
      [[], []],
    ] as const) {
      runner.calls.length = 0;
      await refreshPrs(deps, { force: true, refreshMinutes: 5, sessionIds });
      assert.deepEqual(runner.calls.flatMap(numbersOf).sort(), expected, sessionIds.join());
    }
  });

  test('with session ids and no force, the automatic rule still applies to their pull requests', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 2, { state: 'open', ageMin: 10 });
    store.savePrResult(NUM(2), { ok: false, atNs: T0 - MIN, error: 'x' });
    await refreshPrs(deps, { force: false, refreshMinutes: 5, sessionIds: [S1] });
    assert.deepEqual(runner.calls.flatMap(numbersOf), [1]);
  });

  test('an explicit refresh asks about a pull request that failed a minute ago, and one read a minute ago', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 2, { state: 'open', ageMin: 2 });
    store.savePrResult(NUM(1), { ok: false, atNs: T0 - MIN, error: 'gh timed out after 10 s' });
    await refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 0, 'automatic: both were tried within 5 minutes');
    await refreshPrs(deps, { force: true, refreshMinutes: 5 });
    assert.deepEqual(runner.calls.flatMap(numbersOf).sort(), [1, 2]);
    assert.equal(row(store, 1).error, null);
  });
});

describe('the call to gh', () => {
  test('always names github.com, so GH_HOST cannot send it elsewhere', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1);
    await fetchPrs(deps, [NUM(1)]);
    assert.deepEqual(runner.calls[0]?.args.slice(0, 4), [
      'api',
      'graphql',
      '--hostname',
      'github.com',
    ]);
  });

  test('GH_HOST, GH_FORCE_TTY and CLICOLOR_FORCE are removed, GH_PROMPT_DISABLED and NO_COLOR are set, the rest passes', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 2, { state: 'open', ageMin: 10 });
    await fetchPrs(deps, [NUM(1)]);
    await refreshPrs(deps, { force: true, refreshMinutes: 5 });
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.deepEqual(call.options, { timeoutMs: 10000, env: GH_ENV });
    }
    assert.equal(ENV['GH_HOST'], 'ghe.example.com', "the caller's environment is not changed");
  });

  test('an empty environment still gets the two settings', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1);
    await fetchPrs({ ...deps, env: {} }, [NUM(1)]);
    assert.deepEqual(runner.calls[0]?.options, {
      timeoutMs: 10000,
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
  });

  test('the environment is not optional: deps without it do not compile', () => {
    const compileOnly = (store: Store): unknown =>
      // @ts-expect-error `env` is required in the deps of fetchPrs
      fetchPrs({ runner: fakeRunner(), clock: fakeClock(T0), store }, []);
    assert.equal(typeof compileOnly, 'function');
  });
});

describe('finished pull requests are left as they are', () => {
  test('fetchPrs of a merged or closed url makes no call, as for `pr add` while gh fails', async (t) => {
    const { store, runner, deps } = deck(t, () => runResult({ code: null, timedOut: true }));
    seed(store, 1, 1, { state: 'merged', ageMin: 600 });
    seed(store, 2, 2, { state: 'closed', ageMin: 600 });
    const before = store.prs();
    assert.deepEqual(await fetchPrs(deps, [NUM(1), NUM(2)]), { fetched: 0, failed: 0 });
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(store.prs(), before);
    assert.equal(prLevel(row(store, 1)), 'merged');
    assert.equal(prLevel(row(store, 2)), 'closed');
  });

  test('in a mixed list only the pull requests that are not finished are asked about', async (t) => {
    const { store, runner, deps } = deck(t, answerAll());
    seed(store, 1, 1, { state: 'merged', ageMin: 600 });
    seed(store, 2, 3);
    assert.deepEqual(await fetchPrs(deps, [NUM(1), NUM(2), NUM(3)]), { fetched: 2, failed: 0 });
    assert.deepEqual(runner.calls.flatMap(numbersOf), [2, 3]);
  });

  /** A refresh of o/r#1 whose gh call hangs until `release()`, and a second one answered at once. */
  function overlap(t: TestContext, slowAnswer: RunResult, fastAnswer: RunResult) {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const made = deck(t, async () => {
      if (++calls === 1) {
        await gate;
        return slowAnswer;
      }
      return fastAnswer;
    });
    seed(made.store, 1, 1, { state: 'open', ageMin: 10 });
    return { ...made, release };
  }

  test('a slow refresh that then fails does not mark what a faster one found merged as unreadable', async (t) => {
    const merged = runResult({ stdout: ghStdout([prJson('MERGED', false, null, null)]) });
    const { store, deps, release } = overlap(t, runResult({ code: null, timedOut: true }), merged);
    const slow = refreshPrs(deps, { force: false, refreshMinutes: 5 });
    assert.deepEqual(await refreshPrs(deps, { force: true, refreshMinutes: 5 }), {
      fetched: 1,
      failed: 0,
    });
    assert.equal(row(store, 1).state, 'merged');
    release();
    assert.deepEqual(await slow, { fetched: 0, failed: 0 });
    const after = row(store, 1);
    assert.equal(after.state, 'merged');
    assert.equal(after.error, null);
    assert.equal(after.okAtNs, T0);
    assert.equal(prLevel(after), 'merged');
  });

  test('a slow refresh that then answers with an older status does not reopen a merged pull request', async (t) => {
    const merged = runResult({ stdout: ghStdout([prJson('MERGED', false, null, null)]) });
    const stale = runResult({ stdout: ghStdout([prJson('OPEN', false, 'APPROVED', 'SUCCESS')]) });
    const { store, deps, release } = overlap(t, stale, merged);
    const slow = refreshPrs(deps, { force: false, refreshMinutes: 5 });
    await refreshPrs(deps, { force: true, refreshMinutes: 5 });
    release();
    assert.deepEqual(await slow, { fetched: 0, failed: 0 });
    assert.equal(row(store, 1).state, 'merged');
    assert.equal(row(store, 1).review, null);
  });

  test('a result for a pull request that is still open is saved as before', async (t) => {
    const open = runResult({ stdout: ghStdout([prJson('OPEN', true, null, 'PENDING')]) });
    const { store, deps, release } = overlap(t, open, open);
    const slow = refreshPrs(deps, { force: false, refreshMinutes: 5 });
    release();
    assert.deepEqual(await slow, { fetched: 1, failed: 0 });
    assert.equal(row(store, 1).state, 'draft');
  });
});

describe('prLevel', () => {
  test('a pull request with an error cannot be read, whatever else it says', () => {
    assert.equal(prLevel(pr({ state: 'open', error: 'x' })), 'cant-read');
    assert.equal(prLevel(pr({ state: null, error: 'x' })), 'cant-read');
    assert.equal(prLevel(pr({ state: 'merged', error: 'x' })), 'cant-read');
    assert.equal(prLevel(pr({ state: 'closed', error: 'x' })), 'cant-read');
  });

  test('one that was never fetched is "unfetched"', () => {
    assert.equal(prLevel(pr({ state: null })), 'unfetched');
  });

  test('merged and closed are themselves', () => {
    assert.equal(prLevel(pr({ state: 'merged' })), 'merged');
    assert.equal(prLevel(pr({ state: 'closed' })), 'closed');
    assert.equal(
      prLevel(pr({ state: 'merged', checks: 'failing', review: 'changes-requested' })),
      'merged',
    );
  });

  test('failing checks come before changes requested', () => {
    assert.equal(
      prLevel(pr({ state: 'open', checks: 'failing', review: 'changes-requested' })),
      'checks-failing',
    );
  });

  test('changes requested come before pending checks', () => {
    assert.equal(
      prLevel(pr({ state: 'open', checks: 'pending', review: 'changes-requested' })),
      'changes-requested',
    );
  });

  test('pending checks come before a review that is still required', () => {
    assert.equal(
      prLevel(pr({ state: 'open', checks: 'pending', review: 'review-required' })),
      'checks-pending',
    );
  });

  test('a review that is required comes before the draft', () => {
    assert.equal(
      prLevel(pr({ state: 'open', checks: 'passing', review: 'review-required' })),
      'review-required',
    );
    assert.equal(prLevel(pr({ state: 'draft', review: 'review-required' })), 'review-required');
  });

  test('a draft with nothing to report is a draft; failing checks still win', () => {
    assert.equal(prLevel(pr({ state: 'draft' })), 'draft');
    assert.equal(prLevel(pr({ state: 'draft', checks: 'failing' })), 'checks-failing');
  });

  test('approved and green, or open with nothing known, is approved-green', () => {
    assert.equal(
      prLevel(pr({ state: 'open', checks: 'passing', review: 'approved' })),
      'approved-green',
    );
    assert.equal(prLevel(pr({ state: 'open' })), 'approved-green');
  });
});

describe('chipFor', () => {
  const at = (over: Partial<PrRow>): PrRow => pr({ state: 'open', ...over });

  test('no pull requests, no chip', () => {
    assert.equal(chipFor([]), null);
  });

  test('the worst level wins and the count is every pull request', () => {
    assert.deepEqual(
      chipFor([
        at({ checks: 'passing', review: 'approved' }),
        at({ checks: 'failing' }),
        pr({ state: 'merged' }),
      ]),
      { level: 'checks-failing', count: 3 },
    );
  });

  test('merged is worse than closed', () => {
    assert.deepEqual(chipFor([pr({ state: 'merged' }), pr({ state: 'closed' })]), {
      level: 'merged',
      count: 2,
    });
  });

  test('unfetched is worse than failing checks', () => {
    assert.deepEqual(chipFor([pr({ state: null }), at({ checks: 'failing' })]), {
      level: 'unfetched',
      count: 2,
    });
  });

  test('cant-read is worse than unfetched', () => {
    assert.deepEqual(chipFor([pr({ state: null, error: 'x' }), pr({ state: null })]), {
      level: 'cant-read',
      count: 2,
    });
    assert.deepEqual(chipFor([pr({ state: null }), at({ error: 'x' })]), {
      level: 'cant-read',
      count: 2,
    });
  });

  test('a single pull request is its own level', () => {
    assert.deepEqual(chipFor([pr({ state: 'closed' })]), { level: 'closed', count: 1 });
  });

  test('CHIP_ORDER is worst first, and prLevel only returns levels from it', () => {
    assert.deepEqual(
      [...CHIP_ORDER],
      [
        'cant-read',
        'unfetched',
        'checks-failing',
        'changes-requested',
        'checks-pending',
        'review-required',
        'draft',
        'approved-green',
        'merged',
        'closed',
      ],
    );
    const everything: PrRow[] = [
      pr({ error: 'x' }),
      pr({ state: null }),
      at({ checks: 'failing' }),
      at({ review: 'changes-requested' }),
      at({ checks: 'pending' }),
      at({ review: 'review-required' }),
      pr({ state: 'draft' }),
      at({}),
      pr({ state: 'merged' }),
      pr({ state: 'closed' }),
    ];
    assert.deepEqual(everything.map(prLevel), [...CHIP_ORDER]);
  });

  test('an unreadable pull request is never shown as closed', () => {
    assert.equal(prLevel(pr({ state: 'closed', error: 'HTTP 404' })), 'cant-read');
    assert.equal(chipFor([pr({ state: null, error: 'HTTP 404' })])?.level, 'cant-read');
  });
});
