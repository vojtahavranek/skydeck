import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { GH_TIMEOUT_MS } from '../../../src/github.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { attachManualPr } from '../../../src/sessions/meta.ts';
import { refresh } from '../../../src/sessions/refresh.ts';
import { S1, SEC, T0, fakeRunner, runResult } from '../../helpers/platform.ts';
import {
  appendRecord,
  prLinkRecord,
  twoSessions,
  withRunner,
  writeTranscript,
  userRecord,
} from '../../helpers/session-files.ts';
import { testContext } from '../../helpers/context.ts';

const PR1 = 'https://github.com/o/r/pull/1';
const USAGE = 'skydeck pr add <ref> <url> | pr rm <ref> <url> | pr refresh';

/** What `gh api graphql` prints for one open pull request, no review, checks passing. */
const OPEN_GREEN = JSON.stringify({
  data: {
    p0: {
      pullRequest: {
        title: 'Fix the retry',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
      },
    },
  },
});

const ghAnswers = (stdout: string) => fakeRunner(() => runResult({ stdout }));
const ghTimesOut = () => fakeRunner(() => runResult({ code: null, timedOut: true }));

const prsOf = (d: ReturnType<typeof twoSessions>, sessionId = S1) =>
  loadRows(d.deck).find((row) => row.id === sessionId)?.prs ?? [];
const prRow = (d: ReturnType<typeof twoSessions>, url = PR1) =>
  d.deck.store.prs().find((row) => row.url === url);

test('pr --help prints the usage and exits 0', async () => {
  const c = testContext();
  assert.equal(await main(['pr', '--help'], c.ctx), 0);
  assert.ok(c.stdout().startsWith(`${USAGE}\n`), c.stdout());
});

test('pr and pr <unknown> are usage errors (exit 2) that show the usage', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['pr'], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: missing argument\n'), d.stderr());
  assert.ok(d.stderr().includes(USAGE), d.stderr());
  assert.equal(await main(['pr', 'frob'], d.ctx), 2);
  assert.match(d.stderr(), /skydeck: unknown subcommand 'frob'\n/);
  assert.equal(d.stdout(), '');
});

test('each subcommand checks its number of arguments (exit 2), in the words of the other commands', async (t) => {
  const d = twoSessions(t);
  const cases: [string[], string][] = [
    [['add'], 'missing argument'],
    [['add', '0b5f'], 'missing argument'],
    [['add', '0b5f', PR1, 'more'], 'too many arguments'],
    [['rm'], 'missing argument'],
    [['rm', '0b5f'], 'missing argument'],
    [['rm', '0b5f', PR1, 'more'], 'too many arguments'],
    [['refresh', 'extra'], 'too many arguments'],
  ];
  for (const [args, reason] of cases) {
    assert.equal(await main(['pr', ...args], d.ctx), 2, args.join(' '));
    assert.match(d.stderr(), new RegExp(`skydeck: ${reason}\\n${USAGE.replaceAll('|', '\\|')}`));
  }
  assert.equal(d.stdout(), '');
  assert.deepEqual(d.deck.store.sessionPrs(), []);
});

test('pr add attaches, fetches that pull request at once and prints its status', async (t) => {
  const d = twoSessions(t);
  const runner = ghAnswers(OPEN_GREEN);

  assert.equal(await main(['pr', 'add', '0b5f', PR1], withRunner(d, runner)), 0);

  assert.equal(d.stdout(), `0b5f3c1e: attached ${PR1} (approved-green)\n`);
  assert.equal(d.stderr(), '');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.command, 'gh');
  assert.equal(runner.calls[0]?.options?.timeoutMs, GH_TIMEOUT_MS);
  const [view] = prsOf(d);
  assert.equal(view?.url, PR1);
  assert.equal(view?.state, 'open');
  assert.equal(view?.title, 'Fix the retry');
  assert.equal(d.deck.store.sessionPrs()[0]?.origin, 'manual');
});

test('pr add with a url that has a trailing path, other case or a query attaches the same pull request', async (t) => {
  const d = twoSessions(t);
  const runner = ghAnswers(OPEN_GREEN);
  assert.equal(
    await main(
      ['pr', 'add', '0b5f', 'HTTPS://GitHub.com/O/R/pull/1/files?x=1#y'],
      withRunner(d, runner),
    ),
    0,
  );
  assert.equal(d.stdout(), `0b5f3c1e: attached ${PR1} (approved-green)\n`);
});

test('pr add when gh times out still attaches, says "can\'t read" and exits 0', async (t) => {
  const d = twoSessions(t);

  assert.equal(await main(['pr', 'add', '0b5f', PR1], withRunner(d, ghTimesOut())), 0);

  assert.equal(
    d.stdout(),
    `0b5f3c1e: attached ${PR1} (can't read, last read never (gh timed out after 10 s))\n`,
  );
  assert.equal(prsOf(d)[0]?.level, 'cant-read');
  assert.equal(prRow(d)?.state, null);
});

test('pr add when gh is not installed says so, as a status, and exits 0', async (t) => {
  const d = twoSessions(t);
  const runner = fakeRunner(() => runResult({ code: null, notFound: true }));
  assert.equal(await main(['pr', 'add', '0b5f', PR1], withRunner(d, runner)), 0);
  assert.equal(
    d.stdout(),
    `0b5f3c1e: attached ${PR1} (can't read, last read never (gh is not installed))\n`,
  );
});

test('pr add runs gh with the environment of the process, never as a shell command', async (t) => {
  const d = twoSessions(t, { env: { GH_HOST: 'evil.example', HOME_MARK: 'kept' } });
  const runner = ghAnswers(OPEN_GREEN);
  await main(['pr', 'add', '0b5f', PR1], withRunner(d, runner));
  const env = runner.calls[0]?.options?.env;
  assert.equal(env?.['GH_HOST'], undefined, 'GH_HOST cannot send the question elsewhere');
  assert.equal(env?.['HOME_MARK'], 'kept');
});

test('pr add with a url that is not a pull request is a usage error (exit 2): nothing attached, gh not run', async (t) => {
  const d = twoSessions(t);
  const runner = ghAnswers(OPEN_GREEN);
  assert.equal(await main(['pr', 'add', '0b5f', 'not-a-url'], withRunner(d, runner)), 2);
  assert.equal(d.stderr(), 'skydeck: not a GitHub pull-request URL: not-a-url\n');
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(d.deck.store.prs(), []);
});

test('the url is checked before the reference: a bad url is exit 2 whatever the reference is', async (t) => {
  const d = twoSessions(t);
  const runner = ghAnswers(OPEN_GREEN);
  for (const sub of ['add', 'rm']) {
    const before = d.stderr().length;
    assert.equal(await main(['pr', sub, 'nope1234', 'not-a-url'], withRunner(d, runner)), 2, sub);
    assert.equal(
      d.stderr().slice(before),
      'skydeck: not a GitHub pull-request URL: not-a-url\n',
      sub,
    );
  }
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(d.deck.store.sessionPrs(), []);
});

test('pr add with a reference that matches nothing exits 3 and runs no gh', async (t) => {
  const d = twoSessions(t);
  const runner = ghAnswers(OPEN_GREEN);
  assert.equal(await main(['pr', 'add', 'nope1234', PR1], withRunner(d, runner)), 3);
  assert.deepEqual(runner.calls, []);
});

test('pr add of an already attached pull request that is merged does not fetch it again', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0,
    title: 'Done',
    state: 'merged',
    review: 'approved',
    checks: 'passing',
  });
  const runner = ghAnswers(OPEN_GREEN);

  assert.equal(await main(['pr', 'add', '0b5f', PR1], withRunner(d, runner)), 0);

  assert.deepEqual(runner.calls, []);
  assert.equal(d.stdout(), `0b5f3c1e: attached ${PR1} (merged)\n`);
});

test('pr rm detaches, and the row no longer has the pull request', async (t) => {
  const d = twoSessions(t);
  await main(['pr', 'add', '0b5f', PR1], withRunner(d, ghAnswers(OPEN_GREEN)));
  assert.equal(prsOf(d).length, 1);

  assert.equal(await main(['pr', 'rm', '0b5f', PR1], d.ctx), 0);

  assert.equal(
    d.stdout(),
    `0b5f3c1e: attached ${PR1} (approved-green)\n0b5f3c1e: detached ${PR1}\n`,
  );
  assert.deepEqual(prsOf(d), []);
});

test('pr rm of a pull request that was never attached exits 1 and says so', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['pr', 'rm', '0b5f', 'https://github.com/o/r/pull/9'], d.ctx), 1);
  assert.equal(d.stderr(), 'skydeck: https://github.com/o/r/pull/9 is not attached to 0b5f3c1e\n');
  assert.equal(d.stdout(), '');
});

test('pr rm with a url that is not a pull request is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['pr', 'rm', '0b5f', 'nope'], d.ctx), 2);
  assert.equal(d.stderr(), 'skydeck: not a GitHub pull-request URL: nope\n');
});

test('an auto-attached pull request removed with pr rm stays detached when a rescan sees its pr-link again', async (t) => {
  const d = twoSessions(t);
  writeTranscript(d, S1, [userRecord(S1, T0 - 30n * SEC), prLinkRecord(S1, PR1, T0 - 20n * SEC)]);

  // Any command refreshes first: the scan attaches the pull request found in the transcript.
  assert.equal(await main(['pr', 'rm', '0b5f', PR1], d.ctx), 0);
  assert.equal(d.deck.store.sessionPrs()[0]?.origin, 'auto', 'it was attached by the scan');
  assert.deepEqual(prsOf(d), []);

  appendRecord(d, S1, prLinkRecord(S1, PR1, T0 + 5n * SEC), T0 + 5n * SEC);
  const scan = refresh(d.deck).scan;

  assert.ok(scan.read >= 1, 'the transcript was read again');
  assert.equal(d.deck.store.sessionPrs().length, 1);
  assert.notEqual(d.deck.store.sessionPrs()[0]?.detachedAtNs, null);
  assert.deepEqual(prsOf(d), [], 'still detached');
});

test('pr refresh fetches every pull request that is not final and prints the counts', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  const runner = ghAnswers(OPEN_GREEN);

  assert.equal(await main(['pr', 'refresh'], withRunner(d, runner)), 0);

  assert.equal(d.stdout(), 'fetched 1, failed 0\n');
  assert.equal(runner.calls.length, 1);
  assert.equal(prRow(d)?.state, 'open');
  assert.equal(prRow(d)?.error, null);
});

test('pr refresh fetches again even when the last fetch is recent (it is forced)', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0,
    title: 'T',
    state: 'open',
    review: null,
    checks: null,
  });
  const runner = ghAnswers(OPEN_GREEN);

  assert.equal(await main(['pr', 'refresh'], withRunner(d, runner)), 0);

  assert.equal(runner.calls.length, 1);
  assert.equal(d.stdout(), 'fetched 1, failed 0\n');
  assert.equal(prRow(d)?.checks, 'passing');
});

test('pr refresh when gh times out prints the failure count, exits 0 and keeps the state', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0,
    title: 'T',
    state: 'open',
    review: null,
    checks: null,
  });

  assert.equal(await main(['pr', 'refresh'], withRunner(d, ghTimesOut())), 0);

  assert.equal(d.stdout(), 'fetched 0, failed 1\n');
  assert.equal(prRow(d)?.error, 'gh timed out after 10 s');
  assert.equal(prRow(d)?.state, 'open');
});

test('pr refresh does not ask about a pull request that every session has detached', async (t) => {
  const d = twoSessions(t);
  await main(['pr', 'add', '0b5f', PR1], withRunner(d, ghTimesOut())); // cannot be read
  await main(['pr', 'rm', '0b5f', PR1], d.ctx);
  const runner = ghTimesOut();

  assert.equal(await main(['pr', 'refresh'], withRunner(d, runner)), 0);

  assert.ok(d.stdout().endsWith('fetched 0, failed 0\n'), d.stdout());
  assert.deepEqual(runner.calls, []);

  // attached again, it is asked about again
  await main(['pr', 'add', '0b5f', PR1], withRunner(d, ghAnswers(OPEN_GREEN)));
  const again = ghAnswers(OPEN_GREEN);
  await main(['pr', 'refresh'], withRunner(d, again));
  assert.equal(again.calls.length, 1);
});

test('pr refresh with nothing to fetch prints zeros and does not run gh', async (t) => {
  const d = twoSessions(t);
  const runner = ghAnswers(OPEN_GREEN);
  assert.equal(await main(['pr', 'refresh'], withRunner(d, runner)), 0);
  assert.equal(d.stdout(), 'fetched 0, failed 0\n');
  assert.deepEqual(runner.calls, []);
});
