// Follow-up F19 (T2 a, T3): a GitHub issue's status, read through `gh` as the pull requests' status
// is (design 7.3): the key of an issue's address, the batch of its own (`issue(number: …) { state
// stateReason }`, at most 50 a call, 10 s, the environment without GH_HOST and the colour
// variables), and the answer in words and a category — open is `doing`, closed as completed `done`,
// not planned and duplicate `closed`, a state not known here its own words and no category. A
// failure of `gh` is a failure of every issue of the batch, in the pull requests' words.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BATCH_SIZE,
  GH_TIMEOUT_MS,
  fetchIssueStatuses,
  issueBatchArgs,
  issueKey,
  parseIssueBatch,
} from '../src/github.ts';
import type { PrKey } from '../src/github.ts';
import type { RunResult } from '../src/platform/types.ts';
import { T0, fakeClock, fakeRunner, runResult } from './helpers/platform.ts';

function key(url: string): PrKey {
  const parsed = issueKey(url);
  assert.ok(parsed, `${url} is an issue address`);
  return parsed;
}

describe('issueKey', () => {
  test('an issue address, as linkToOpen stores it or as typed, is its lower-cased key', () => {
    assert.deepEqual(issueKey('https://github.com/Owner/Repo/issues/5'), {
      url: 'https://github.com/owner/repo/issues/5',
      owner: 'owner',
      repo: 'repo',
      number: 5,
    });
    for (const text of [
      'https://github.com/owner/repo/issues/5#issuecomment-1',
      'https://github.com/owner/repo/issues/5?x=1',
      'https://github.com/owner/repo/issues/5/',
      'http://www.github.com/owner/repo/issues/5',
    ]) {
      assert.equal(issueKey(text)?.url, 'https://github.com/owner/repo/issues/5', text);
    }
  });

  test('a pull request, another host, a bad number or name is no issue', () => {
    for (const text of [
      'https://github.com/owner/repo/pull/5',
      'https://example.com/owner/repo/issues/5',
      'https://github.com/owner/repo/issues/0',
      'https://github.com/owner/repo/issues/05',
      'https://github.com/owner/repo/issues/5x',
      'https://github.com/owner/repo/issues',
      'https://github.com/owner/../issues/5',
      'https://github.com/-owner/repo/issues/5',
      'https://github.com/owner/repo/issues/2147483648',
      'https://gist.github.com/owner/repo/issues/5',
    ]) {
      assert.equal(issueKey(text), null, text);
    }
  });
});

describe('issueBatchArgs', () => {
  const keys = [key('https://github.com/o/r/issues/1'), key('https://github.com/o2/r.x/issues/22')];

  test('api graphql against github.com, the query, then the variables of each issue', () => {
    const args = issueBatchArgs(keys);
    assert.deepEqual(args.slice(0, 5), ['api', 'graphql', '--hostname', 'github.com', '-f']);
    assert.deepEqual(args.slice(6), [
      '-f',
      'o0=o',
      '-f',
      'r0=r',
      '-F',
      'n0=1',
      '-f',
      'o1=o2',
      '-f',
      'r1=r.x',
      '-F',
      'n1=22',
    ]);
    assert.equal(
      args[5],
      'query=query($o0: String!, $r0: String!, $n0: Int!, $o1: String!, $r1: String!, $n1: Int!) { i0: repository(owner: $o0, name: $r0) { issue(number: $n0) { state stateReason } } i1: repository(owner: $o1, name: $r1) { issue(number: $n1) { state stateReason } } }',
    );
  });

  test('a batch holds 1 to BATCH_SIZE issues', () => {
    assert.throws(() => issueBatchArgs([]), RangeError);
    const many = Array.from({ length: BATCH_SIZE + 1 }, (_, i) =>
      key(`https://github.com/o/r/issues/${i + 1}`),
    );
    assert.throws(() => issueBatchArgs(many), RangeError);
    assert.equal(issueBatchArgs(many.slice(0, BATCH_SIZE)).filter((a) => a === '-F').length, 50);
  });
});

/** gh's answer for `issues`, alias by alias: an issue object, null, or left out (undefined). */
function answer(
  issues: (Record<string, unknown> | null | undefined)[],
  errors?: unknown,
): RunResult {
  const data: Record<string, unknown> = {};
  issues.forEach((issue, i) => {
    if (issue !== undefined) data[`i${i}`] = { issue };
  });
  return runResult({ stdout: JSON.stringify(errors === undefined ? { data } : { data, errors }) });
}

describe('parseIssueBatch', () => {
  const one = [key('https://github.com/o/r/issues/1')];
  const url = 'https://github.com/o/r/issues/1';

  test('open is `open` / doing; reopened is still open', () => {
    for (const reason of [null, 'REOPENED']) {
      assert.deepEqual(
        parseIssueBatch(one, answer([{ state: 'OPEN', stateReason: reason }]), T0).get(url),
        { ok: true, atNs: T0, status: 'open', category: 'doing' },
      );
    }
  });

  test('closed as completed is `closed` / done; not planned and duplicate are closed in their words', () => {
    const cases: [string | null, string, string | null][] = [
      ['COMPLETED', 'closed', 'done'],
      ['NOT_PLANNED', 'not planned', 'closed'],
      ['DUPLICATE', 'duplicate', 'closed'],
      // No reason (closed before GitHub kept one): closed, but done or not is not known.
      [null, 'closed', null],
      // A reason GitHub added: its words in lower case, no category.
      ['SOME_NEW_REASON', 'some new reason', null],
    ];
    for (const [reason, status, category] of cases) {
      assert.deepEqual(
        parseIssueBatch(one, answer([{ state: 'CLOSED', stateReason: reason }]), T0).get(url),
        { ok: true, atNs: T0, status, category },
        String(reason),
      );
    }
  });

  test('a state not known here is its own words in lower case, without a category', () => {
    assert.deepEqual(
      parseIssueBatch(one, answer([{ state: 'LOCKED_FOR_GOOD', stateReason: null }]), T0).get(url),
      { ok: true, atNs: T0, status: 'locked for good', category: null },
    );
    const long = parseIssueBatch(one, answer([{ state: 'X'.repeat(60) }]), T0).get(url);
    assert.equal(long?.ok === true ? long.status : null, 'x'.repeat(40));
  });

  test('an issue without a state is a failure', () => {
    assert.deepEqual(parseIssueBatch(one, answer([{ stateReason: null }]), T0).get(url), {
      ok: false,
      atNs: T0,
      error: 'GitHub answered without a state',
    });
  });

  test('an issue GitHub could not find takes the message of its own error, else "not found"', () => {
    const two = [...one, key('https://github.com/o/r/issues/2')];
    const result = parseIssueBatch(
      two,
      answer(
        [{ state: 'OPEN', stateReason: null }, null],
        [
          {
            type: 'NOT_FOUND',
            path: ['i1', 'issue'],
            message: 'Could not resolve to an issue or pull request with the number of 2.',
          },
        ],
      ),
      T0,
    );
    assert.equal(result.get(url)?.ok, true);
    assert.deepEqual(result.get('https://github.com/o/r/issues/2'), {
      ok: false,
      atNs: T0,
      error: 'Could not resolve to an issue or pull request with the number of 2.',
    });
    assert.deepEqual(parseIssueBatch(one, answer([undefined]), T0).get(url), {
      ok: false,
      atNs: T0,
      error: 'not found',
    });
  });

  test("gh's failures fail every issue, in the pull requests' words", () => {
    const cases: [RunResult, string][] = [
      [runResult({ code: null, timedOut: true }), 'gh timed out after 10 s'],
      [runResult({ code: null, notFound: true }), 'gh is not installed'],
      [
        runResult({
          code: 4,
          stderr:
            'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.\n',
        }),
        'To get started with GitHub CLI, please run:  gh auth login',
      ],
      [runResult({ code: 1 }), 'gh exited 1'],
      [runResult({ code: null }), 'gh was killed by a signal'],
      [runResult({ code: 0, stdout: 'not json' }), 'gh returned output skydeck could not read'],
    ];
    for (const [result, error] of cases) {
      assert.deepEqual(parseIssueBatch(one, result, T0).get(url), { ok: false, atNs: T0, error });
    }
  });
});

describe('fetchIssueStatuses', () => {
  test('120 issues go out in 3 gh calls of 50, 50 and 20, 10 s each, without GH_HOST and the colour variables', async () => {
    const runner = fakeRunner((call) => {
      const count = call.args.filter((a) => a === '-F').length;
      return answer(Array.from({ length: count }, () => ({ state: 'OPEN', stateReason: null })));
    });
    const keys = Array.from({ length: 120 }, (_, i) =>
      key(`https://github.com/o/r/issues/${i + 1}`),
    );
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      GH_HOST: 'ghe.example.com',
      GH_FORCE_TTY: '1',
      CLICOLOR_FORCE: '1',
    };

    const results = await fetchIssueStatuses({ runner, clock: fakeClock(T0), env }, keys);

    assert.deepEqual(
      runner.calls.map((call) => call.args.filter((a) => a === '-F').length),
      [50, 50, 20],
    );
    for (const call of runner.calls) {
      assert.equal(call.command, 'gh');
      assert.equal(call.options?.timeoutMs, GH_TIMEOUT_MS);
      assert.deepEqual(call.options?.env, {
        PATH: '/usr/bin',
        HOME: '/home/u',
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
      });
    }
    assert.equal(results.size, 120);
    assert.ok([...results.values()].every((result) => result.ok));
  });

  test('a repeated issue is asked about once; no call for none; a runner that throws fails the batch', async () => {
    const runner = fakeRunner(() => answer([{ state: 'OPEN', stateReason: null }]));
    const deps = { runner, clock: fakeClock(T0), env: {} };
    const issue = key('https://github.com/o/r/issues/1');

    assert.equal((await fetchIssueStatuses(deps, [])).size, 0);
    assert.equal(runner.calls.length, 0);
    const results = await fetchIssueStatuses(deps, [issue, issue]);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.args.filter((a) => a === '-F').length, 1);
    assert.equal(results.size, 1);

    const failing = fakeRunner(() => {
      throw new Error('spawn gh EACCES\nmore');
    });
    const failed = await fetchIssueStatuses({ ...deps, runner: failing }, [issue]);
    assert.deepEqual(failed.get(issue.url), {
      ok: false,
      atNs: T0,
      error: 'gh could not be run: spawn gh EACCES',
    });
  });

  test('an aborted signal gives no results and starts no further batch', async () => {
    const stop = new AbortController();
    const runner = fakeRunner(() => {
      stop.abort();
      return answer(Array.from({ length: 50 }, () => ({ state: 'OPEN', stateReason: null })));
    });
    const keys = Array.from({ length: 60 }, (_, i) =>
      key(`https://github.com/o/r/issues/${i + 1}`),
    );
    const results = await fetchIssueStatuses({ runner, clock: fakeClock(T0), env: {} }, keys, {
      signal: stop.signal,
    });
    assert.equal(results.size, 0);
    assert.equal(runner.calls.length, 1);
  });
});
