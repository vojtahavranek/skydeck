// Follow-up F32: a pull request's status says what GitHub says before it merges. Beside its review
// decision and the last commit's rollup, the one query of a batch asks, under an alias of its own
// (q<i>), for GitHub's merge state, the writers' latest reviews, the review threads, the base
// branch's rules (rulesets: approvals needed, resolved conversations, required checks) and the names
// of the checks the last commit has reported. `approved-green` needs a real approval; a required
// check that has not reported is pending; new levels `unresolved-comments`, `blocked`,
// `checks-passing` and `open`. Everything new is optional: an answer without it, or with it
// broken, is read exactly as before, and never becomes "can't read" because of it.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import {
  BATCH_SIZE,
  CHIP_ORDER,
  PR_BATCH_SIZE,
  batchArgs,
  chipFor,
  fetchPrs,
  parseBatch,
  prKey,
  prLevel,
} from '../src/github.ts';
import type { ChipLevel, PrKey } from '../src/github.ts';
import type { RunResult } from '../src/platform/types.ts';
import { openStore } from '../src/store/store.ts';
import type { PrFetchResult, PrRow } from '../src/store/types.ts';
import { S1, T0, fakeClock, fakeRunner, runResult } from './helpers/platform.ts';
import type { RunCall } from './helpers/platform.ts';
import { sandbox } from './helpers/sandbox.ts';

const URL7 = 'https://github.com/acme/web/pull/7';

function key(url: string): PrKey {
  const parsed = prKey(url);
  assert.ok(parsed, `${url} is a pull request url`);
  return parsed;
}

const KEY7 = key(URL7);

// --- GitHub's answer -----------------------------------------------------------------------------

/** The p<i> part, as before F32: title, state, draft, decision and the rollup's state. */
function basics(
  decision: string | null,
  rollup: string | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: 'Fix the retry',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: decision,
    commits: {
      nodes: [{ commit: { statusCheckRollup: rollup === null ? null : { state: rollup } } }],
    },
    ...over,
  };
}

/** A PULL_REQUEST rule of a ruleset. */
function reviewRule(count: number, resolution = false): Record<string, unknown> {
  return {
    type: 'PULL_REQUEST',
    parameters: {
      __typename: 'PullRequestParameters',
      requiredApprovingReviewCount: count,
      requiredReviewThreadResolution: resolution,
      requireCodeOwnerReview: true,
    },
  };
}

/** A REQUIRED_STATUS_CHECKS rule of a ruleset. */
function checksRule(...contexts: string[]): Record<string, unknown> {
  return {
    type: 'REQUIRED_STATUS_CHECKS',
    parameters: {
      __typename: 'RequiredStatusChecksParameters',
      strictRequiredStatusChecksPolicy: true,
      requiredStatusChecks: contexts.map((context) => ({ context })),
    },
  };
}

/** Rules of other kinds, whose parameters are null or of another type. */
const OTHER_RULES = [
  { type: 'DELETION', parameters: null },
  { type: 'NON_FAST_FORWARD', parameters: null },
  { type: 'MERGE_QUEUE', parameters: { __typename: 'MergeQueueParameters' } },
];

/** A reported context: a check run (by name) or a commit status (by context). */
function context(name: string, kind: 'run' | 'status' = 'run'): Record<string, unknown> {
  return kind === 'run'
    ? { __typename: 'CheckRun', name }
    : { __typename: 'StatusContext', context: name };
}

interface Merge {
  mergeState?: string;
  /** The writers' latest opinionated reviews (their states). */
  reviews?: string[];
  /** isResolved of each review thread. */
  threads?: boolean[];
  threadTotal?: number;
  /** The base branch's rules; null: the pull request has no base branch. */
  rules?: unknown[] | null;
  /** The last commit's reported contexts; null: its rollup is null (nothing reported). */
  contexts?: unknown[] | null;
  contextTotal?: number;
}

/** The q<i> part: what GitHub needs before it merges. By default: nothing asks for anything. */
function merge(m: Merge = {}): Record<string, unknown> {
  const reviews = m.reviews ?? [];
  const threads = m.threads ?? [];
  const rules = m.rules === undefined ? [] : m.rules;
  const contexts = m.contexts === undefined ? [context('build')] : m.contexts;
  return {
    mergeStateStatus: m.mergeState ?? 'CLEAN',
    latestOpinionatedReviews: {
      totalCount: reviews.length,
      nodes: reviews.map((state) => ({ state })),
    },
    reviewThreads: {
      totalCount: m.threadTotal ?? threads.length,
      nodes: threads.map((isResolved) => ({ isResolved })),
    },
    baseRef: rules === null ? null : { rules: { totalCount: rules.length, nodes: rules } },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup:
              contexts === null
                ? null
                : { contexts: { totalCount: m.contextTotal ?? contexts.length, nodes: contexts } },
          },
        },
      ],
    },
  };
}

/** What `gh api graphql` prints for one pull request: p0, and q0 unless it is undefined. */
function answer(p: unknown, q?: unknown, errors?: unknown[]): string {
  const data: Record<string, unknown> = { p0: { pullRequest: p } };
  if (q !== undefined) data['q0'] = { pullRequest: q };
  return JSON.stringify(errors === undefined ? { data } : { data, errors });
}

function parseOne(stdout: string, over: Partial<RunResult> = {}): PrFetchResult {
  const result = parseBatch([KEY7], runResult({ stdout, ...over }), T0).get(URL7);
  assert.ok(result, 'one result for the key');
  return result;
}

/** The row a result makes (as store.savePrResult saves it), for prLevel. */
function rowOf(result: PrFetchResult): PrRow {
  if (!result.ok) {
    assert.fail(`an ok result, not the failure "${result.error}"`);
  }
  return {
    url: URL7,
    owner: 'acme',
    repo: 'web',
    number: 7,
    title: result.title,
    state: result.state,
    review: result.review,
    checks: result.checks,
    okAtNs: result.atNs,
    triedAtNs: result.atNs,
    error: null,
  };
}

/** The level the code computes for one answer. */
function levelOf(p: unknown, q?: unknown, errors?: unknown[]): ChipLevel {
  return prLevel(rowOf(parseOne(answer(p, q, errors))));
}

/** The fifteen checks the bug's repository requires, and 47 reported contexts that lack `deploy`. */
const REQUIRED = [
  'build',
  'lint',
  'unit',
  'e2e',
  'types',
  'docs',
  'audit',
  'license',
  'sbom',
  'size',
  'a11y',
  'perf',
  'smoke',
  'image',
  'deploy',
];
const REPORTED = [
  ...REQUIRED.filter((name) => name !== 'deploy').map((name) => context(name)),
  ...Array.from({ length: 30 }, (_, i) => context(`extra-${i}`)),
  ...Array.from({ length: 3 }, (_, i) => context(`status-${i}`, 'status')),
];

// --- the query -----------------------------------------------------------------------------------

describe('F32: the one query asks for what GitHub needs before it merges', () => {
  const keys = [key('https://github.com/o/r/pull/1'), key('https://github.com/a/b/pull/22')];
  const query = (batchArgs(keys)[5] ?? '').slice('query='.length);

  test('each pull request has a second alias q<i> on the same variables as p<i>', () => {
    assert.ok(
      query.includes('q0: repository(owner: $o0, name: $r0) { pullRequest(number: $n0) {'),
      query,
    );
    assert.ok(
      query.includes('q1: repository(owner: $o1, name: $r1) { pullRequest(number: $n1) {'),
      query,
    );
    assert.equal(batchArgs([keys[0] as PrKey]).length, 6 + 6, 'no further variable');
  });

  test('p<i> asks exactly what it asked before, so that nothing new can make it unreadable', () => {
    assert.ok(
      query.includes(
        'p0: repository(owner: $o0, name: $r0) { pullRequest(number: $n0) { title state isDraft reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }',
      ),
      query,
    );
  });

  test('q<i> asks for the merge state, the reviews, the threads, the rules and the reported checks', () => {
    for (const part of [
      'mergeStateStatus',
      'latestOpinionatedReviews(first: 50, writersOnly: true) { totalCount nodes { state } }',
      'reviewThreads(first: 100) { totalCount nodes { isResolved } }',
      'baseRef { rules(first: 50) { totalCount nodes { type repositoryRuleset { enforcement } parameters { __typename',
      '... on PullRequestParameters { requiredApprovingReviewCount requiredReviewThreadResolution }',
      '... on RequiredStatusChecksParameters { requiredStatusChecks { context } }',
      'statusCheckRollup { contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { name } ... on StatusContext { context } } } }',
    ]) {
      assert.ok(query.includes(part), part);
    }
    assert.ok(!query.includes('branchProtectionRule'), 'never the classic rule');
  });

  test('a batch of pull requests holds at most PR_BATCH_SIZE; the issues keep BATCH_SIZE', () => {
    assert.equal(PR_BATCH_SIZE, 10);
    assert.equal(BATCH_SIZE, 50);
    const one = key(URL7);
    assert.doesNotThrow(() => batchArgs(Array.from({ length: PR_BATCH_SIZE }, () => one)));
    assert.throws(
      () => batchArgs(Array.from({ length: PR_BATCH_SIZE + 1 }, () => one)),
      RangeError,
    );
  });
});

// --- T3: what is true ----------------------------------------------------------------------------

describe('F32: the bug, and each level alone', () => {
  test('the bug: no decision, rules need 2 with none, a required check missing, a thread open, rollup SUCCESS → checks pending', () => {
    const result = parseOne(
      answer(
        basics(null, 'SUCCESS'),
        merge({
          mergeState: 'BEHIND',
          reviews: [],
          threads: [false],
          rules: [reviewRule(2, true), checksRule(...REQUIRED), ...OTHER_RULES],
          contexts: REPORTED,
        }),
      ),
    );
    assert.equal(REPORTED.length, 47);
    assert.deepEqual(result, {
      ok: true,
      atNs: T0,
      title: 'Fix the retry',
      state: 'open',
      review: 'review-required',
      checks: 'pending',
    });
    assert.equal(prLevel(rowOf(result)), 'checks-pending');
  });

  test('the bug once the check has reported: review required; once approved twice: unresolved comments', () => {
    const rules = [reviewRule(2, true), checksRule(...REQUIRED), ...OTHER_RULES];
    const all = [...REPORTED, context('deploy')];
    const reported = { rules, contexts: all, threads: [false] };
    assert.equal(levelOf(basics(null, 'SUCCESS'), merge(reported)), 'review-required');
    assert.equal(
      levelOf(basics(null, 'SUCCESS'), merge({ ...reported, reviews: ['APPROVED'] })),
      'review-required',
      'one of two',
    );
    assert.equal(
      levelOf(basics(null, 'SUCCESS'), merge({ ...reported, reviews: ['APPROVED', 'APPROVED'] })),
      'unresolved-comments',
    );
    assert.equal(
      levelOf(
        basics(null, 'SUCCESS'),
        merge({ ...reported, reviews: ['APPROVED', 'APPROVED'], threads: [true] }),
      ),
      'approved-green',
      'two of two, every thread resolved, every check reported',
    );
  });

  test('review required by the rules alone (no decision): the rule needs 1, nobody approved', () => {
    const result = parseOne(answer(basics(null, 'SUCCESS'), merge({ rules: [reviewRule(1)] })));
    assert.equal(result.ok && result.review, 'review-required');
    assert.equal(prLevel(rowOf(result)), 'review-required');
  });

  test('the rules need more than the classic decision: APPROVED with 1 of 2 is review required', () => {
    const q = merge({ rules: [reviewRule(2)], reviews: ['APPROVED'] });
    assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), q), 'review-required');
  });

  test('the largest count of the rules counts', () => {
    const q = merge({
      rules: [reviewRule(1), reviewRule(3), reviewRule(2)],
      reviews: ['APPROVED'],
    });
    assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'review-required');
    const three = merge({
      rules: [reviewRule(1), reviewRule(3)],
      reviews: ['APPROVED', 'APPROVED', 'APPROVED'],
    });
    assert.equal(levelOf(basics(null, 'SUCCESS'), three), 'approved-green');
  });

  test('changes requested by a writer, without a decision; not when the decision is APPROVED', () => {
    const q = merge({ reviews: ['APPROVED', 'CHANGES_REQUESTED'] });
    assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'changes-requested');
    assert.equal(levelOf(basics('REVIEW_REQUIRED', 'SUCCESS'), q), 'changes-requested');
    assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), q), 'approved-green');
    const result = parseOne(answer(basics(null, 'PENDING'), q));
    assert.equal(result.ok && result.review, 'changes-requested');
    assert.equal(prLevel(rowOf(result)), 'changes-requested', 'before pending checks');
  });

  test('a required check that has not reported is pending, a check run or a commit status alike', () => {
    const rules = [checksRule('build', 'ci/legacy')];
    const both = [context('build'), context('ci/legacy', 'status')];
    assert.equal(
      levelOf(basics(null, 'SUCCESS'), merge({ rules, contexts: both })),
      'checks-passing',
    );
    for (const contexts of [[context('build')], [context('ci/legacy', 'status')], []]) {
      const result = parseOne(answer(basics(null, 'SUCCESS'), merge({ rules, contexts })));
      assert.equal(result.ok && result.checks, 'pending', JSON.stringify(contexts));
    }
  });

  test('a required check on a commit that reported nothing at all is pending', () => {
    const result = parseOne(
      answer(basics(null, null), merge({ rules: [checksRule('build')], contexts: null })),
    );
    assert.equal(result.ok && result.checks, 'pending');
    assert.equal(prLevel(rowOf(result)), 'checks-pending');
  });

  test('a check run named like a required status context is that context (names are compared exactly)', () => {
    const rules = [checksRule('Build')];
    const result = parseOne(
      answer(basics(null, 'SUCCESS'), merge({ rules, contexts: [context('build')] })),
    );
    assert.equal(result.ok && result.checks, 'pending', 'build is not Build');
  });

  test('failing checks stay failing, whatever is missing', () => {
    const q = merge({ rules: [checksRule('deploy')], contexts: [context('build')] });
    const result = parseOne(answer(basics(null, 'FAILURE'), q));
    assert.equal(result.ok && result.checks, 'failing');
  });

  test('unresolved comments: the rules ask for resolved conversations and a thread is open', () => {
    const q = merge({ rules: [reviewRule(0, true)], threads: [true, false, true] });
    const result = parseOne(answer(basics('APPROVED', 'SUCCESS'), q));
    assert.equal(result.ok && result.review, 'unresolved-comments');
    assert.equal(prLevel(rowOf(result)), 'unresolved-comments');
  });

  test('a REQUIRED_REVIEW_THREAD_RESOLUTION rule asks for resolved conversations too', () => {
    const rule = { type: 'REQUIRED_REVIEW_THREAD_RESOLUTION', parameters: null };
    const q = merge({ rules: [rule], threads: [false] });
    assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), q), 'unresolved-comments');
  });

  test('an open thread with no rule asking for resolution is no finding', () => {
    const q = merge({ rules: [reviewRule(0, false)], threads: [false] });
    assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), q), 'approved-green');
  });

  test('unresolved comments come after review required and before the draft', () => {
    const rules = [reviewRule(1, true)];
    assert.equal(
      levelOf(basics(null, 'SUCCESS'), merge({ rules, threads: [false] })),
      'review-required',
    );
    assert.equal(
      levelOf(
        basics(null, 'SUCCESS', { isDraft: true }),
        merge({ rules, threads: [false], reviews: ['APPROVED'] }),
      ),
      'unresolved-comments',
    );
  });

  test('blocked: nothing above applies and GitHub merges it not (code owners, a deployment…)', () => {
    const result = parseOne(
      answer(basics('APPROVED', 'SUCCESS'), merge({ mergeState: 'BLOCKED' })),
    );
    assert.equal(result.ok && result.review, 'blocked');
    assert.equal(prLevel(rowOf(result)), 'blocked');
  });

  test('blocked, with no rules known and no decision, is still blocked (better than approved)', () => {
    const q = { ...merge({ mergeState: 'BLOCKED' }), baseRef: null };
    assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'blocked');
  });

  test('a merge state of BLOCKED does not hide what explains it, and a draft stays a draft', () => {
    const blocked = { mergeState: 'BLOCKED' };
    const pending = parseOne(answer(basics('APPROVED', 'PENDING'), merge(blocked)));
    assert.deepEqual(pending.ok && [pending.review, pending.checks], ['approved', 'pending']);
    assert.equal(prLevel(rowOf(pending)), 'checks-pending');
    const failing = parseOne(answer(basics('APPROVED', 'FAILURE'), merge(blocked)));
    assert.equal(failing.ok && failing.review, 'approved');
    const draft = parseOne(answer(basics(null, 'SUCCESS', { isDraft: true }), merge(blocked)));
    assert.equal(draft.ok && draft.review, 'not-required');
    assert.equal(prLevel(rowOf(draft)), 'draft');
    assert.equal(
      levelOf(basics(null, 'SUCCESS'), merge({ ...blocked, rules: [reviewRule(1)] })),
      'review-required',
    );
  });

  test('other merge states (BEHIND, DIRTY, UNKNOWN, UNSTABLE, HAS_HOOKS) are not blocked', () => {
    for (const mergeState of ['BEHIND', 'DIRTY', 'UNKNOWN', 'UNSTABLE', 'HAS_HOOKS', 'CLEAN']) {
      assert.equal(
        levelOf(basics('APPROVED', 'SUCCESS'), merge({ mergeState })),
        'approved-green',
        mergeState,
      );
    }
  });
});

describe('F32: approved, green only with a real approval', () => {
  test('a repository with no rules and no review: checks passing; without checks: open', () => {
    const passing = parseOne(answer(basics(null, 'SUCCESS'), merge()));
    assert.deepEqual(passing.ok && [passing.review, passing.checks], ['not-required', 'passing']);
    assert.equal(prLevel(rowOf(passing)), 'checks-passing');
    const open = parseOne(answer(basics(null, null), merge({ contexts: null })));
    assert.deepEqual(open.ok && [open.review, open.checks], ['not-required', null]);
    assert.equal(prLevel(rowOf(open)), 'open');
  });

  test('rules of other kinds only, or a pull-request rule that needs no approval, ask for no review', () => {
    assert.equal(levelOf(basics(null, 'SUCCESS'), merge({ rules: OTHER_RULES })), 'checks-passing');
    assert.equal(
      levelOf(basics(null, 'SUCCESS'), merge({ rules: [reviewRule(0)] })),
      'checks-passing',
    );
  });

  test('approvals nobody asked for are no approval', () => {
    const q = merge({ reviews: ['APPROVED', 'APPROVED'] });
    assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'checks-passing');
  });

  test('the classic decision APPROVED with passing checks is approved, green', () => {
    const result = parseOne(answer(basics('APPROVED', 'SUCCESS'), merge()));
    assert.equal(result.ok && result.review, 'approved');
    assert.equal(prLevel(rowOf(result)), 'approved-green');
  });

  test('rules satisfied, 2 of 2 by writers, with no decision: approved, green', () => {
    const q = merge({ rules: [reviewRule(2)], reviews: ['APPROVED', 'APPROVED'] });
    const result = parseOne(answer(basics(null, 'SUCCESS'), q));
    assert.equal(result.ok && result.review, 'approved');
    assert.equal(prLevel(rowOf(result)), 'approved-green');
  });

  test('a real approval with no checks at all is approved-green, as before (nothing red or amber)', () => {
    const result = parseOne(answer(basics('APPROVED', null), merge({ contexts: null })));
    assert.deepEqual(result.ok && [result.review, result.checks], ['approved', null]);
    assert.equal(prLevel(rowOf(result)), 'approved-green');
  });

  test('a decision GitHub added that is not known here claims nothing: as before', () => {
    const result = parseOne(answer(basics('SOMETHING_NEW', 'SUCCESS'), merge()));
    assert.equal(result.ok && result.review, null);
    assert.equal(prLevel(rowOf(result)), 'approved-green');
  });
});

// --- T2: never worse than before -----------------------------------------------------------------

describe('F32: an answer without the new parts, or with them broken, is read as before', () => {
  /** What the code made of an answer before F32: the p part only. */
  const before = (p: Record<string, unknown>): PrFetchResult => parseOne(answer(p));

  const cases: [string, Record<string, unknown>][] = [
    ['APPROVED, SUCCESS', basics('APPROVED', 'SUCCESS')],
    ['no decision, SUCCESS', basics(null, 'SUCCESS')],
    ['REVIEW_REQUIRED, PENDING', basics('REVIEW_REQUIRED', 'PENDING')],
    ['no decision, no rollup', basics(null, null)],
    ['a draft', basics(null, 'SUCCESS', { isDraft: true })],
  ];

  test('no q<i> at all: exactly the result of before', () => {
    const ok = (state: string, review: string | null, checks: string | null) => ({
      ok: true,
      atNs: T0,
      title: 'Fix the retry',
      state,
      review,
      checks,
    });
    assert.deepEqual(
      cases.map(([, p]) => before(p)),
      [
        ok('open', 'approved', 'passing'),
        ok('open', null, 'passing'),
        ok('open', 'review-required', 'pending'),
        ok('open', null, null),
        ok('draft', null, 'passing'),
      ],
    );
    assert.deepEqual(
      cases.map(([, p]) => levelOf(p)),
      ['approved-green', 'approved-green', 'checks-pending', 'approved-green', 'draft'],
      'the levels of before F32',
    );
  });

  test('q<i> null, a q<i> repository that is null, or q<i> not an object: as before, never a failure', () => {
    for (const [name, p] of cases) {
      const expected = before(p);
      for (const data of [
        { p0: { pullRequest: p }, q0: { pullRequest: null } },
        { p0: { pullRequest: p }, q0: null },
        { p0: { pullRequest: p }, q0: 'x' },
        { p0: { pullRequest: p }, q0: { pullRequest: [] } },
      ]) {
        assert.deepEqual(parseOne(JSON.stringify({ data })), expected, name);
      }
    }
  });

  test('an error under q<i> never fails the pull request, nor gives it its message', () => {
    for (const path of [
      ['q0'],
      ['q0', 'pullRequest'],
      ['q0', 'pullRequest', 'reviewThreads'],
      ['q0', 'pullRequest', 'mergeStateStatus'],
      ['q0', 'pullRequest', 'baseRef', 'rules'],
      ['q0', 'pullRequest', 'baseRef', 'rules', 'nodes', 0, 'parameters'],
      ['q0', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup', 'contexts'],
    ]) {
      const errors = [{ path, message: 'Resource not accessible by integration' }];
      const stdout = JSON.stringify({
        data: { p0: { pullRequest: basics(null, 'SUCCESS') }, q0: { pullRequest: null } },
        errors,
      });
      const result = parseOne(stdout, { code: 1 });
      assert.deepEqual(result, before(basics(null, 'SUCCESS')), JSON.stringify(path));
    }
  });

  test('a pull request whose p<i> is null keeps its own error, not one of q<i>', () => {
    const stdout = JSON.stringify({
      data: { p0: null, q0: null },
      errors: [
        { path: ['q0', 'pullRequest', 'baseRef'], message: 'about q0' },
        { path: ['p0', 'pullRequest'], message: 'Could not resolve to a PullRequest.' },
      ],
    });
    assert.deepEqual(parseOne(stdout, { code: 1 }), {
      ok: false,
      atNs: T0,
      error: 'Could not resolve to a PullRequest.',
    });
    const onlyQ = JSON.stringify({
      data: { p0: null, q0: null },
      errors: [{ path: ['q0', 'pullRequest'], message: 'about q0' }],
    });
    assert.deepEqual(parseOne(onlyQ, { code: 1 }), { ok: false, atNs: T0, error: 'not found' });
  });

  test('a part an error lies under is not used: a rollup that is null by an error is not "nothing reported"', () => {
    const q = merge({ rules: [checksRule('build')], contexts: null });
    const errors = [
      {
        path: ['q0', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'],
        message: 'timeout',
      },
    ];
    const result = parseOne(answer(basics(null, 'SUCCESS'), q, errors), { code: 1 });
    assert.equal(result.ok && result.checks, 'passing');
  });

  test('a part an error lies under is not used: rules, reviews, threads, merge state', () => {
    const at = (part: string) => [{ path: ['q0', 'pullRequest', part], message: 'x' }];
    const needs = merge({ rules: [reviewRule(1)] });
    assert.equal(levelOf(basics(null, 'SUCCESS'), needs, at('baseRef')), 'approved-green');
    assert.equal(
      levelOf(basics(null, 'SUCCESS'), needs, at('latestOpinionatedReviews')),
      'approved-green',
      'approvals that cannot be counted',
    );
    const threads = merge({ rules: [reviewRule(0, true)], threads: [false] });
    assert.equal(
      levelOf(basics('APPROVED', 'SUCCESS'), threads, at('reviewThreads')),
      'approved-green',
    );
    const blocked = merge({ mergeState: 'BLOCKED' });
    assert.equal(
      levelOf(basics('APPROVED', 'SUCCESS'), blocked, at('mergeStateStatus')),
      'approved-green',
    );
    assert.equal(
      levelOf(basics('APPROVED', 'SUCCESS'), blocked, [
        { path: ['q1', 'pullRequest'], message: 'x' },
      ]),
      'blocked',
      'an error of another alias is not one of q0',
    );
  });

  test('no base branch (baseRef null): the rules are not known, as before', () => {
    const q = merge({ rules: null, reviews: [] });
    const result = parseOne(answer(basics(null, 'SUCCESS'), q));
    assert.equal(result.ok && result.review, null);
    assert.equal(prLevel(rowOf(result)), 'approved-green');
    assert.equal(levelOf(basics('REVIEW_REQUIRED', 'SUCCESS'), q), 'review-required');
  });

  test('rules that cannot be read (null, not a list, a node without a type) claim no "nothing asks"', () => {
    const p = basics(null, 'SUCCESS');
    for (const baseRef of [
      { rules: null },
      { rules: { totalCount: 1, nodes: 'x' } },
      { rules: { totalCount: 1 } },
      { rules: { totalCount: 1, nodes: [null] } },
      { rules: { totalCount: 1, nodes: [{ parameters: null }] } },
      { rules: { totalCount: 1, nodes: [{ type: 'PULL_REQUEST', parameters: null }] } },
      {
        rules: {
          totalCount: 1,
          nodes: [{ type: 'PULL_REQUEST', parameters: { __typename: 'PullRequestParameters' } }],
        },
      },
      {
        rules: {
          totalCount: 1,
          nodes: [
            {
              type: 'PULL_REQUEST',
              parameters: {
                __typename: 'PullRequestParameters',
                requiredApprovingReviewCount: '2',
                requiredReviewThreadResolution: false,
              },
            },
          ],
        },
      },
      { rules: { totalCount: 51, nodes: OTHER_RULES } },
      'x',
    ]) {
      const result = parseOne(answer(p, { ...merge(), baseRef }));
      assert.equal(result.ok && result.review, null, JSON.stringify(baseRef));
      assert.equal(prLevel(rowOf(result)), 'approved-green', JSON.stringify(baseRef));
    }
  });

  test('a rule that is seen still counts when others cannot be read', () => {
    const rules = { totalCount: 60, nodes: [reviewRule(2), null] };
    const q = { ...merge(), baseRef: { rules } };
    assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'review-required');
    const checks = { totalCount: 60, nodes: [checksRule('deploy'), null] };
    const result = parseOne(
      answer(basics(null, 'SUCCESS'), { ...merge(), baseRef: { rules: checks } }),
    );
    assert.equal(result.ok && result.checks, 'pending');
  });

  test('more rules than were asked for: no approval is claimed from those that were seen', () => {
    const rules = { totalCount: 51, nodes: [reviewRule(1)] };
    const q = { ...merge({ reviews: ['APPROVED'] }), baseRef: { rules } };
    const result = parseOne(answer(basics(null, 'SUCCESS'), q));
    assert.equal(result.ok && result.review, null);
  });

  test('more than 100 contexts: a missing required one is not known to be missing', () => {
    const q = merge({ rules: [checksRule('deploy')], contexts: REPORTED, contextTotal: 101 });
    const result = parseOne(answer(basics(null, 'SUCCESS'), q));
    assert.equal(result.ok && result.checks, 'passing');
  });

  test('reported contexts that cannot be read: a missing required one is not known to be missing', () => {
    const rules = [checksRule('deploy')];
    for (const contexts of [
      [null],
      [{ __typename: 'CheckRun' }],
      [{ __typename: 'StatusContext', name: 'deploy' }],
      [{ __typename: 'SomethingNew', name: 'x' }],
      ['deploy'],
    ]) {
      const result = parseOne(answer(basics(null, 'SUCCESS'), merge({ rules, contexts })));
      assert.equal(result.ok && result.checks, 'passing', JSON.stringify(contexts));
    }
    for (const commits of [
      null,
      { nodes: [] },
      { nodes: 'x' },
      { nodes: [{ commit: null }] },
      { nodes: [{ commit: {} }] },
      { nodes: [{ commit: { statusCheckRollup: 'x' } }] },
      { nodes: [{ commit: { statusCheckRollup: { contexts: null } } }] },
      { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
    ]) {
      const result = parseOne(answer(basics(null, 'SUCCESS'), { ...merge({ rules }), commits }));
      assert.equal(result.ok && result.checks, 'passing', JSON.stringify(commits));
    }
  });

  test('more than 100 threads: an open one seen counts; none seen open claims nothing', () => {
    const rules = [reviewRule(0, true)];
    const open = merge({ rules, threads: [true, false], threadTotal: 150 });
    assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), open), 'unresolved-comments');
    const resolved = merge({ rules, threads: [true, true], threadTotal: 150 });
    assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), resolved), 'approved-green');
  });

  test('threads and reviews that cannot be read claim nothing', () => {
    const rules = [reviewRule(1, true)];
    for (const broken of [null, 'x', { totalCount: 1 }, { nodes: 'x' }]) {
      const threads = { ...merge({ rules, reviews: ['APPROVED'] }), reviewThreads: broken };
      assert.equal(
        levelOf(basics(null, 'SUCCESS'), threads),
        'approved-green',
        JSON.stringify(broken),
      );
      const reviews = { ...merge({ rules }), latestOpinionatedReviews: broken };
      assert.equal(
        levelOf(basics(null, 'SUCCESS'), reviews),
        'approved-green',
        JSON.stringify(broken),
      );
    }
  });

  test('reviews not all seen: too few approvals among them is not "review required"', () => {
    const reviews = { totalCount: 60, nodes: [{ state: 'APPROVED' }] };
    const q = { ...merge({ rules: [reviewRule(2)] }), latestOpinionatedReviews: reviews };
    assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'approved-green');
    const nulls = { totalCount: 2, nodes: [{ state: 'APPROVED' }, null] };
    const q2 = { ...merge({ rules: [reviewRule(2)] }), latestOpinionatedReviews: nulls };
    assert.equal(levelOf(basics(null, 'SUCCESS'), q2), 'approved-green');
  });

  test('a merge state that is no string is not known', () => {
    for (const mergeStateStatus of [null, 7, undefined]) {
      const q = { ...merge(), mergeStateStatus };
      assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), q), 'approved-green');
    }
  });

  test('merged and closed pull requests are what they were, whatever q<i> says', () => {
    const q = merge({ mergeState: 'BLOCKED', rules: [reviewRule(2), checksRule('deploy')] });
    for (const state of ['MERGED', 'CLOSED']) {
      const p = basics('APPROVED', 'SUCCESS', { state });
      assert.deepEqual(parseOne(answer(p, q)), before(p), state);
      assert.equal(levelOf(p, q), state.toLowerCase());
    }
  });

  test('a p<i> that cannot be understood still fails as before, whatever q<i> says', () => {
    const result = parseOne(answer(basics(null, 'SUCCESS', { title: 7 }), merge()));
    assert.deepEqual(result, { ok: false, atNs: T0, error: 'GitHub answered without a title' });
  });

  test('a whole-query failure still fails every pull request as before', () => {
    const stdout = JSON.stringify({ errors: [{ message: 'Something went wrong' }] });
    const result = parseOne(stdout, { code: 1, stderr: 'gh: Something went wrong\n' });
    assert.deepEqual(result, { ok: false, atNs: T0, error: 'gh: Something went wrong' });
  });
});

// --- T4: kept in the columns there are; T3's order -----------------------------------------------

describe('F32: prLevel and chipFor', () => {
  function pr(over: Partial<PrRow>): PrRow {
    return {
      url: URL7,
      owner: 'acme',
      repo: 'web',
      number: 7,
      title: 'T',
      state: 'open',
      review: null,
      checks: null,
      okAtNs: T0,
      triedAtNs: T0,
      error: null,
      ...over,
    };
  }

  test('CHIP_ORDER: unresolved comments and blocked after review required; open and checks passing before approved', () => {
    assert.deepEqual(
      [...CHIP_ORDER],
      [
        'cant-read',
        'unfetched',
        'checks-failing',
        'changes-requested',
        'checks-pending',
        'review-required',
        'unresolved-comments',
        'blocked',
        'draft',
        'open',
        'checks-passing',
        'approved-green',
        'merged',
        'closed',
      ],
    );
  });

  test('each stored review gives its level; T3 order: … review required, unresolved comments, draft, blocked …', () => {
    assert.equal(
      prLevel(pr({ review: 'unresolved-comments', checks: 'passing' })),
      'unresolved-comments',
    );
    assert.equal(prLevel(pr({ review: 'blocked', checks: 'passing' })), 'blocked');
    assert.equal(prLevel(pr({ review: 'not-required', checks: 'passing' })), 'checks-passing');
    assert.equal(prLevel(pr({ review: 'not-required', checks: null })), 'open');
    assert.equal(
      prLevel(pr({ review: 'unresolved-comments', checks: 'pending' })),
      'checks-pending',
    );
    assert.equal(
      prLevel(pr({ review: 'unresolved-comments', state: 'draft' })),
      'unresolved-comments',
    );
    assert.equal(prLevel(pr({ review: 'blocked', state: 'draft' })), 'draft');
    assert.equal(prLevel(pr({ review: 'not-required', state: 'draft' })), 'draft');
    assert.equal(prLevel(pr({ review: 'blocked', checks: 'failing' })), 'checks-failing');
    assert.equal(prLevel(pr({ review: 'not-required', checks: 'failing' })), 'checks-failing');
  });

  test('a row read before F32 shows as before: approved, or nothing known, is approved-green', () => {
    assert.equal(prLevel(pr({ review: 'approved', checks: 'passing' })), 'approved-green');
    assert.equal(prLevel(pr({ review: 'approved', checks: null })), 'approved-green');
    assert.equal(prLevel(pr({ review: null, checks: 'passing' })), 'approved-green');
    assert.equal(prLevel(pr({ review: null, checks: null })), 'approved-green');
  });

  test('prLevel only returns levels of CHIP_ORDER, one row of each in its order', () => {
    const everything: PrRow[] = [
      pr({ error: 'x' }),
      pr({ state: null }),
      pr({ checks: 'failing' }),
      pr({ review: 'changes-requested' }),
      pr({ checks: 'pending' }),
      pr({ review: 'review-required' }),
      pr({ review: 'unresolved-comments' }),
      pr({ review: 'blocked' }),
      pr({ state: 'draft' }),
      pr({ review: 'not-required' }),
      pr({ review: 'not-required', checks: 'passing' }),
      pr({ review: 'approved', checks: 'passing' }),
      pr({ state: 'merged' }),
      pr({ state: 'closed' }),
    ];
    assert.deepEqual(everything.map(prLevel), [...CHIP_ORDER]);
  });

  test('chipFor: the new levels by the new order', () => {
    const level = (...rows: PrRow[]) => chipFor(rows)?.level;
    assert.equal(
      level(pr({ review: 'blocked' }), pr({ review: 'unresolved-comments' })),
      'unresolved-comments',
    );
    assert.equal(
      level(pr({ review: 'blocked' }), pr({ review: 'review-required' })),
      'review-required',
    );
    assert.equal(level(pr({ review: 'blocked' }), pr({ state: 'draft' })), 'blocked');
    assert.equal(level(pr({ state: 'draft' }), pr({ review: 'not-required' })), 'draft');
    assert.equal(
      level(pr({ review: 'not-required' }), pr({ review: 'not-required', checks: 'passing' })),
      'open',
    );
    assert.equal(
      level(
        pr({ review: 'approved', checks: 'passing' }),
        pr({ review: 'not-required', checks: 'passing' }),
      ),
      'checks-passing',
    );
    assert.deepEqual(chipFor([pr({ review: 'approved' }), pr({ state: 'merged' })]), {
      level: 'approved-green',
      count: 2,
    });
  });
});

// --- through the store ---------------------------------------------------------------------------

describe('F32: fetchPrs saves the new facts in the columns there are', () => {
  function deck(t: TestContext, handler: (call: RunCall) => RunResult) {
    const store = openStore(join(sandbox(t).root, 'skydeck.db'));
    t.after(() => {
      store.close();
    });
    store.transaction(() => {
      store.ensurePr({ url: URL7, owner: 'acme', repo: 'web', number: 7 });
      store.attachPr(S1, URL7, 'auto', T0);
    });
    const runner = fakeRunner(handler);
    return { store, runner, deps: { runner, clock: fakeClock(T0), store, env: {} } };
  }

  test('the bug, then each later answer, saved and read back as its level', async (t) => {
    let q: unknown = merge({
      mergeState: 'BEHIND',
      threads: [false],
      rules: [reviewRule(2, true), checksRule(...REQUIRED)],
      contexts: REPORTED,
    });
    const d = deck(t, () => runResult({ stdout: answer(basics(null, 'SUCCESS'), q) }));
    const level = (): ChipLevel => {
      const row = d.store.prs().find((p) => p.url === URL7);
      assert.ok(row);
      return prLevel(row);
    };
    assert.deepEqual(await fetchPrs(d.deps, [URL7]), { fetched: 1, failed: 0 });
    assert.equal(level(), 'checks-pending');
    const row = d.store.prs().find((p) => p.url === URL7);
    assert.deepEqual(row && [row.review, row.checks], ['review-required', 'pending']);

    q = merge({ rules: [reviewRule(0, true)], threads: [false] });
    await fetchPrs(d.deps, [URL7]);
    assert.equal(level(), 'unresolved-comments');

    q = merge({ mergeState: 'BLOCKED' });
    await fetchPrs(d.deps, [URL7]);
    assert.equal(level(), 'blocked');

    q = merge();
    await fetchPrs(d.deps, [URL7]);
    assert.equal(level(), 'checks-passing');

    q = undefined; // an answer without the new parts, as a stand-in of before gives
    await fetchPrs(d.deps, [URL7]);
    assert.equal(level(), 'approved-green');
  });

  test('a batch over PR_BATCH_SIZE goes out in batches of PR_BATCH_SIZE', async (t) => {
    const store = openStore(join(sandbox(t).root, 'skydeck.db'));
    t.after(() => {
      store.close();
    });
    const urls = Array.from({ length: 25 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`);
    store.transaction(() => {
      urls.forEach((url, i) => {
        store.ensurePr({ url, owner: 'o', repo: 'r', number: i + 1 });
      });
    });
    const runner = fakeRunner((call) => {
      const count = call.args.filter((arg) => /^n\d+=/.test(arg)).length;
      const data = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `p${i}`,
          { pullRequest: basics(null, 'SUCCESS') },
        ]),
      );
      return runResult({ stdout: JSON.stringify({ data }) });
    });
    const result = await fetchPrs({ runner, clock: fakeClock(T0), store, env: {} }, urls);
    assert.deepEqual(result, { fetched: 25, failed: 0 });
    assert.deepEqual(
      runner.calls.map((call) => call.args.filter((arg) => /^n\d+=/.test(arg)).length),
      [10, 10, 5],
    );
  });
});

// --- ruled: only rules of enforced rulesets count -------------------------------------------------

describe('F32: only the rules of rulesets that are enforced count', () => {
  /** `rule` in a ruleset of `enforcement`; null: the ruleset cannot be read. */
  const inRuleset = (rule: Record<string, unknown>, enforcement: unknown) => ({
    ...rule,
    repositoryRuleset: enforcement === null ? null : { enforcement },
  });

  test("the query asks each rule for its ruleset's enforcement", () => {
    const query = (batchArgs([KEY7])[5] ?? '').slice('query='.length);
    assert.ok(
      query.includes('nodes { type repositoryRuleset { enforcement } parameters { __typename'),
      query,
    );
  });

  test('a ruleset in evaluate mode that would ask for two approvals asks for none; disabled likewise', () => {
    for (const enforcement of ['EVALUATE', 'DISABLED']) {
      const q = merge({ rules: [inRuleset(reviewRule(2, true), enforcement)], threads: [false] });
      const result = parseOne(answer(basics(null, 'SUCCESS'), q));
      assert.equal(result.ok && result.review, 'not-required', enforcement);
      assert.equal(prLevel(rowOf(result)), 'checks-passing', enforcement);
    }
    const active = merge({ rules: [inRuleset(reviewRule(2, true), 'ACTIVE')], threads: [false] });
    assert.equal(levelOf(basics(null, 'SUCCESS'), active), 'review-required');
  });

  test('required checks and resolved conversations of a ruleset in evaluate mode are not asked for', () => {
    const checks = merge({
      rules: [inRuleset(checksRule('deploy'), 'EVALUATE')],
      contexts: [context('build')],
    });
    const result = parseOne(answer(basics(null, 'SUCCESS'), checks));
    assert.equal(result.ok && result.checks, 'passing');
    const threads = merge({
      rules: [
        inRuleset({ type: 'REQUIRED_REVIEW_THREAD_RESOLUTION', parameters: null }, 'EVALUATE'),
      ],
      threads: [false],
    });
    assert.equal(levelOf(basics('APPROVED', 'SUCCESS'), threads), 'approved-green');
  });

  test('an enforced rule beside one in evaluate mode still counts, by its own count', () => {
    const q = merge({
      rules: [inRuleset(reviewRule(3), 'EVALUATE'), inRuleset(reviewRule(1), 'ACTIVE')],
      reviews: ['APPROVED'],
    });
    assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'approved-green');
  });

  test('where the enforcement cannot be read, the rule counts', () => {
    for (const rule of [
      reviewRule(2),
      inRuleset(reviewRule(2), null),
      inRuleset(reviewRule(2), 7),
      inRuleset(reviewRule(2), 'SOMETHING_NEW'),
      { ...reviewRule(2), repositoryRuleset: {} },
      { ...reviewRule(2), repositoryRuleset: 'x' },
    ]) {
      const q = merge({ rules: [rule] });
      assert.equal(levelOf(basics(null, 'SUCCESS'), q), 'review-required', JSON.stringify(rule));
    }
  });

  test("an error under a rule's ruleset leaves the rules read, and that rule counting", () => {
    const q = merge({ rules: [inRuleset(reviewRule(2), null), checksRule('deploy')] });
    for (const tail of [['repositoryRuleset'], ['repositoryRuleset', 'enforcement']]) {
      const errors = [
        {
          path: ['q0', 'pullRequest', 'baseRef', 'rules', 'nodes', 0, ...tail],
          message: 'Resource not accessible by integration',
        },
      ];
      const result = parseOne(answer(basics(null, 'SUCCESS'), q, errors), { code: 1 });
      assert.deepEqual(result.ok && [result.review, result.checks], ['review-required', 'pending']);
    }
  });
});

// --- ruled: a query GitHub rejects as a whole is asked once more, as before F32 -------------------

describe('F32: a query GitHub rejects as a whole is asked once more with the query of before', () => {
  /** The query of before F32 for one pull request, exactly as main sent it. */
  const BEFORE =
    'query=query($o0: String!, $r0: String!, $n0: Int!) { p0: repository(owner: $o0, name: $r0) { pullRequest(number: $n0) { title state isDraft reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }';

  /** What gh prints when GitHub refuses a query it cannot validate (as seen from GitHub). */
  function rejected(kind: 'field' | 'type' = 'field'): RunResult {
    const error =
      kind === 'field'
        ? {
            path: ['query', 'q0', 'pullRequest', 'mergeStateStatus'],
            extensions: {
              code: 'undefinedField',
              typeName: 'PullRequest',
              fieldName: 'mergeStateStatus',
            },
            locations: [{ line: 1, column: 300 }],
            message: "Field 'mergeStateStatus' doesn't exist on type 'PullRequest'",
          }
        : {
            path: [
              'query',
              'q0',
              'pullRequest',
              'baseRef',
              'rules',
              'nodes',
              'parameters',
              '... on PullRequestParameters',
            ],
            extensions: { code: 'undefinedType', typeName: 'PullRequestParameters' },
            locations: [{ line: 1, column: 400 }],
            message: "No such type PullRequestParameters, so it can't be a fragment condition",
          };
    return runResult({
      code: 1,
      stdout: JSON.stringify({ errors: [error] }),
      stderr: `gh: ${error.message}\n`,
    });
  }

  function deck(t: TestContext, urls: string[], handler: (call: RunCall) => RunResult) {
    const store = openStore(join(sandbox(t).root, 'skydeck.db'));
    t.after(() => {
      store.close();
    });
    store.transaction(() => {
      for (const url of urls) {
        const parsed = key(url);
        store.ensurePr({ url, owner: parsed.owner, repo: parsed.repo, number: parsed.number });
      }
    });
    const runner = fakeRunner(handler);
    return {
      store,
      runner,
      deps: { runner, clock: fakeClock(T0), store, env: { PATH: '/usr/bin' } },
    };
  }

  /** gh's answer of before for every alias of a call: p<i> only. */
  const before = (call: RunCall): RunResult => {
    const count = call.args.filter((arg) => /^n\d+=/.test(arg)).length;
    const data = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `p${i}`,
        { pullRequest: basics('APPROVED', 'SUCCESS') },
      ]),
    );
    return runResult({ stdout: JSON.stringify({ data }) });
  };

  test('an unknown field: once more with the query of before, on the same variables, read as before', async (t) => {
    let call = 0;
    const d = deck(t, [URL7], (c) => (++call === 1 ? rejected() : before(c)));
    assert.deepEqual(await fetchPrs(d.deps, [URL7]), { fetched: 1, failed: 0 });
    assert.equal(d.runner.calls.length, 2);
    const [first, second] = d.runner.calls;
    assert.ok(first && second);
    assert.ok(first.args[5]?.includes(' q0: '), 'the first asks the new query');
    assert.equal(second.args[5], BEFORE);
    assert.deepEqual(second.args.slice(0, 5), first.args.slice(0, 5));
    assert.deepEqual(second.args.slice(6), first.args.slice(6));
    assert.deepEqual(second.options, first.options, 'the same timeout and environment');
    const row = d.store.prs().find((p) => p.url === URL7);
    assert.ok(row);
    assert.deepEqual([row.review, row.checks, row.error], ['approved', 'passing', null]);
    assert.equal(prLevel(row), 'approved-green');
  });

  test('an unknown type in a fragment condition is a rejection too', async (t) => {
    let call = 0;
    const d = deck(t, [URL7], (c) => (++call === 1 ? rejected('type') : before(c)));
    assert.deepEqual(await fetchPrs(d.deps, [URL7]), { fetched: 1, failed: 0 });
    assert.equal(d.runner.calls[1]?.args[5], BEFORE);
  });

  test('rejected again: the pull requests fail with what the second gh said, as before; no third call', async (t) => {
    const d = deck(t, [URL7], () => rejected());
    assert.deepEqual(await fetchPrs(d.deps, [URL7]), { fetched: 0, failed: 1 });
    assert.equal(d.runner.calls.length, 2);
    const row = d.store.prs().find((p) => p.url === URL7);
    assert.equal(row?.error, "gh: Field 'mergeStateStatus' doesn't exist on type 'PullRequest'");
  });

  test('each batch on its own: only the rejected batch is asked again, for its own pull requests', async (t) => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`);
    let call = 0;
    const d = deck(t, urls, (c) => (++call === 1 ? rejected() : before(c)));
    assert.deepEqual(await fetchPrs(d.deps, urls), { fetched: 15, failed: 0 });
    const numbers = (c: RunCall) => c.args.filter((arg) => /^n\d+=/.test(arg));
    assert.deepEqual(
      d.runner.calls.map((c) => [numbers(c).length, c.args[5]?.includes(' q0: ')]),
      [
        [10, true],
        [10, false],
        [5, true],
      ],
    );
    assert.deepEqual(numbers(d.runner.calls[1] as RunCall), numbers(d.runner.calls[0] as RunCall));
  });

  test('other failures are not asked again', async (t) => {
    const failures: [string, RunResult][] = [
      ['a timeout', runResult({ code: null, timedOut: true })],
      ['gh missing', runResult({ code: null, notFound: true })],
      ['an HTTP error', runResult({ code: 1, stdout: '', stderr: 'gh: HTTP 502\n' })],
      ['output that is no JSON', runResult({ code: 0, stdout: 'not json' })],
      [
        "GitHub's own error without a path",
        runResult({
          code: 1,
          stdout: JSON.stringify({ data: null, errors: [{ message: 'Something went wrong' }] }),
          stderr: 'gh: Something went wrong\n',
        }),
      ],
      [
        'rate limited',
        runResult({
          code: 1,
          stdout: JSON.stringify({
            errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
          }),
          stderr: 'gh: API rate limit exceeded\n',
        }),
      ],
      [
        'an answer with data, and an error of one alias',
        runResult({
          code: 1,
          stdout: answer(basics(null, 'SUCCESS'), merge(), [
            { path: ['q0', 'pullRequest', 'baseRef'], message: 'x', extensions: { code: 'x' } },
          ]),
        }),
      ],
    ];
    for (const [name, result] of failures) {
      await t.test(name, async (t) => {
        const d = deck(t, [URL7], () => result);
        await fetchPrs(d.deps, [URL7]);
        assert.equal(d.runner.calls.length, 1, name);
      });
    }
  });

  test('a gh that cannot be started is not asked again', async (t) => {
    const d = deck(t, [URL7], () => {
      throw new Error('spawn gh EACCES');
    });
    assert.deepEqual(await fetchPrs(d.deps, [URL7]), { fetched: 0, failed: 1 });
    assert.equal(d.runner.calls.length, 1);
  });

  test('an abort that came with the rejection asks nothing more and saves nothing', async (t) => {
    const controller = new AbortController();
    const d = deck(t, [URL7], () => {
      controller.abort();
      return rejected();
    });
    assert.deepEqual(await fetchPrs(d.deps, [URL7], { signal: controller.signal }), {
      fetched: 0,
      failed: 0,
    });
    assert.equal(d.runner.calls.length, 1);
  });
});
