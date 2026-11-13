import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { isoFromNs } from '../../../src/platform/time.ts';
import { attachManualPr, markDone } from '../../../src/sessions/meta.ts';
import { testContext } from '../../helpers/context.ts';
import { testDeck } from '../../helpers/deck.ts';
import { S1, S2, SEC, T0, fakeRunner, runResult } from '../../helpers/platform.ts';
import type { RunCall } from '../../helpers/platform.ts';
import {
  twoSessions,
  userRecord,
  withRunner,
  writeTranscript,
} from '../../helpers/session-files.ts';
import type { TestDeck } from '../../helpers/deck.ts';

const USAGE = 'skydeck ls [--all] [--json] [--refresh]\n';
const PR1 = 'https://github.com/o/r/pull/1';
const PR2 = 'https://github.com/o/r/pull/2';
const PR3 = 'https://github.com/o/r/pull/3';

/** What `gh api graphql` prints for `count` open pull requests (aliases p0, p1, …), checks passing. */
function openAnswer(count: number): string {
  const open = {
    pullRequest: {
      title: 'Fix the retry',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    },
  };
  return JSON.stringify({
    data: Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, open])),
  });
}

/** `gh` answers every question about as many open pull requests as the question has aliases. */
function ghOpen() {
  return fakeRunner((call: RunCall) => {
    const aliases = call.args.filter((arg) => /^n\d+=/.test(arg)).length;
    return runResult({ stdout: openAnswer(aliases) });
  });
}

/**
 * S1 has a pull request never fetched and one fetched a minute ago; S2 has one never fetched
 * (design 7.3: the fresh one is not asked about again).
 */
function sessionsWithPrs(t: Parameters<typeof twoSessions>[0]): TestDeck {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  attachManualPr(d.deck, S1, PR2);
  d.deck.store.savePrResult(PR2, {
    ok: true,
    atNs: T0 - 60n * SEC,
    title: 'Fresh',
    state: 'open',
    review: null,
    checks: 'passing',
  });
  attachManualPr(d.deck, S2, PR3);
  return d;
}

interface ListedJson {
  version: number;
  generatedAt: string;
  sessions: {
    id: string;
    done: boolean;
    prs: { url: string; state: string | null; error: string | null }[];
  }[];
}

function listed(d: TestDeck): ListedJson {
  return JSON.parse(d.stdout()) as ListedJson;
}

test('ls --help prints its usage and exits 0', async () => {
  const c = testContext();
  assert.equal(await main(['ls', '--help'], c.ctx), 0);
  assert.ok(c.stdout().startsWith(USAGE), c.stdout());
  assert.equal(c.stderr(), '');
});

test('ls with an argument is a usage error (exit 2) that shows the usage', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['ls', 'extra'], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: too many arguments\n'), d.stderr());
  assert.ok(d.stderr().includes(USAGE), d.stderr());
  assert.equal(d.stdout(), '');
});

test('ls with a flag it does not have is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['ls', '--frob'], d.ctx), 2);
  assert.ok(d.stderr().includes(USAGE), d.stderr());
  assert.equal(d.stdout(), '');
});

test('ls with no sessions prints "no sessions" and exits 0', async (t) => {
  const d = testDeck(t);
  assert.equal(await main(['ls'], d.ctx), 0);
  assert.equal(d.stdout(), 'no sessions\n');
  assert.equal(d.stderr(), '');
});

test('ls --json with no sessions: version 1, no sessions, generatedAt is the clock', async (t) => {
  const d = testDeck(t);
  assert.equal(await main(['ls', '--json'], d.ctx), 0);
  assert.deepEqual(JSON.parse(d.stdout()), {
    version: 1,
    generatedAt: isoFromNs(T0),
    sessions: [],
  });
  assert.ok(d.stdout().endsWith('}\n'), 'JSON.stringify(value, null, 2) and a newline');
  assert.equal(d.stdout(), `${JSON.stringify(JSON.parse(d.stdout()), null, 2)}\n`);
});

test('ls prints the sessions the deck knows in one group, one row each, indented', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['ls'], d.ctx), 0);
  assert.equal(
    d.stdout(),
    [
      'no group',
      '  not-running 2026-11-12 08:59 demo   30s  0b5f3c1e',
      '  not-running 2026-11-12 08:59 demo   30s  1c6a4d2f',
      '',
    ].join('\n'),
  );
});

test('ls cuts a row to the width of the terminal, less the indent', async (t) => {
  const d = twoSessions(t, { size: { columns: 40, rows: 24 } });
  d.deck.store.updateMeta(
    S1,
    { label: 'a label that is far too long to fit on a row of forty' },
    T0,
  );
  assert.equal(await main(['ls'], d.ctx), 0);
  const lines = d.stdout().split('\n');
  assert.equal(lines[0], 'no group');
  const row = lines.find((line) => line.includes('0b5f3c1e')) ?? '';
  assert.ok(row.startsWith('  not-running a label'), row);
  assert.ok(row.includes('…'), row);
  assert.ok(row.endsWith('  0b5f3c1e'), row);
});

test('ls --json carries the directory as it is, and still prints nothing a terminal acts on', async (t) => {
  const d = testDeck(t);
  const dir = '/home/dev/pro\u0007jects/a\u009bb';
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 30n * SEC), cwd: dir }]);

  assert.equal(await main(['ls', '--json'], d.ctx), 0);

  assert.equal((JSON.parse(d.stdout()) as { sessions: { dir: string }[] }).sessions[0]?.dir, dir);
  assert.doesNotMatch(d.stdout(), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test('ls --json lists the sessions in list order with the stable keys', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['ls', '--json'], d.ctx), 0);
  const json = listed(d);
  assert.equal(json.version, 1);
  assert.equal(json.generatedAt, isoFromNs(T0));
  assert.deepEqual(
    json.sessions.map((session) => session.id),
    [S1, S2],
  );
  assert.deepEqual(Object.keys(json.sessions[0] ?? {}), [
    'id',
    'shortId',
    'title',
    'titleSource',
    'label',
    'group',
    'state',
    'stateDetail',
    'since',
    'lastActivity',
    'dir',
    'marks',
    'hasNote',
    'continuedFrom',
    'done',
    'prs',
  ]);
});

test('ls hides a session marked done', async (t) => {
  const d = twoSessions(t);
  markDone(d.deck, S1);
  assert.equal(await main(['ls', '--json'], d.ctx), 0);
  assert.deepEqual(
    listed(d).sessions.map((session) => session.id),
    [S2],
  );
});

test('ls --all shows a session marked done, flagged as done', async (t) => {
  const d = twoSessions(t);
  markDone(d.deck, S1);
  assert.equal(await main(['ls', '--all', '--json'], d.ctx), 0);
  const { sessions } = listed(d);
  assert.deepEqual(
    sessions.map((session) => [session.id, session.done]),
    [
      [S1, true],
      [S2, false],
    ],
  );
});

test('ls without --refresh never starts gh, and prints the cached status', async (t) => {
  const d = sessionsWithPrs(t);
  const runner = ghOpen();
  assert.equal(await main(['ls'], withRunner(d, runner)), 0);
  assert.deepEqual(runner.calls, []);
  assert.match(d.stdout(), /2pr:unfetched {2}0b5f3c1e/);
  assert.match(d.stdout(), /1pr:unfetched {2}1c6a4d2f/);
});

/** The pull request numbers a `gh` call asks about (every test pull request is in o/r). */
function askedNumbers(call: RunCall | undefined): string[] {
  return (call?.args ?? []).flatMap((arg) => /^n\d+=(\d+)$/.exec(arg)?.[1] ?? []).sort();
}

test('ls --refresh asks gh about every attached pull request, the fresh one too, in one call', async (t) => {
  const d = sessionsWithPrs(t);
  const runner = ghOpen();

  assert.equal(await main(['ls', '--refresh'], withRunner(d, runner)), 0);

  assert.equal(runner.calls.length, 1, 'one call for all three pull requests');
  assert.equal(runner.calls[0]?.command, 'gh');
  assert.deepEqual(askedNumbers(runner.calls[0]), ['1', '2', '3']);
});

test('ls --refresh asks only about the pull requests of the sessions it prints: not a done session, unless --all', async (t) => {
  const d = sessionsWithPrs(t);
  markDone(d.deck, S2); // S2 has PR3
  const runner = ghOpen();

  assert.equal(await main(['ls', '--refresh'], withRunner(d, runner)), 0);
  assert.deepEqual(askedNumbers(runner.calls[0]), ['1', '2'], 'S1 prints; S2 is done and hidden');
  assert.equal(runner.calls.length, 1);
  assert.equal(d.deck.store.prs().find((pr) => pr.url === PR3)?.state, null);

  runner.calls.length = 0;
  assert.equal(await main(['ls', '--all', '--refresh'], withRunner(d, runner)), 0);
  assert.deepEqual(askedNumbers(runner.calls[0]), ['1', '2', '3'], '--all prints S2 too');
  assert.equal(d.deck.store.prs().find((pr) => pr.url === PR3)?.state, 'open');
});

test('ls --refresh shows the status it just read, in the rows and in the JSON', async (t) => {
  const d = sessionsWithPrs(t);
  assert.equal(await main(['ls', '--refresh'], withRunner(d, ghOpen())), 0);
  assert.match(d.stdout(), /2pr:approved-green {2}0b5f3c1e/);
  assert.match(d.stdout(), /1pr:approved-green {2}1c6a4d2f/);
});

test('ls --refresh asks again about a pull request whose last fetch failed, though it was read a minute before', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0 - 120n * SEC,
    title: 'Fix',
    state: 'open',
    review: null,
    checks: null,
  });
  d.deck.store.savePrResult(PR1, {
    ok: false,
    atNs: T0 - 60n * SEC,
    error: 'gh timed out after 10 s',
  });
  const runner = ghOpen();

  assert.equal(await main(['ls', '--refresh', '--json'], withRunner(d, runner)), 0);

  assert.equal(runner.calls.length, 1);
  assert.deepEqual(listed(d).sessions[0]?.prs[0], {
    url: PR1,
    repo: 'o/r',
    number: 1,
    state: 'open',
    review: null,
    checks: 'passing',
    okAt: isoFromNs(T0),
    error: null,
  });
});

test('ls --refresh never asks about a merged or a closed pull request', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  attachManualPr(d.deck, S1, PR2);
  for (const [url, state] of [
    [PR1, 'merged'],
    [PR2, 'closed'],
  ] as const) {
    d.deck.store.savePrResult(url, {
      ok: true,
      atNs: T0 - 600n * SEC,
      title: 'Done',
      state,
      review: null,
      checks: null,
    });
  }
  const runner = ghOpen();
  assert.equal(await main(['ls', '--refresh'], withRunner(d, runner)), 0);
  assert.deepEqual(runner.calls, []);
});

test('after ls --refresh, ls --json shows the state of every pull request', async (t) => {
  const d = sessionsWithPrs(t);
  const runner = ghOpen();
  assert.equal(await main(['ls', '--refresh', '--json'], withRunner(d, runner)), 0);
  const json = listed(d);
  const states = json.sessions.flatMap((session) => session.prs.map((pr) => [pr.url, pr.state]));
  assert.deepEqual(states.sort(), [
    [PR1, 'open'],
    [PR2, 'open'],
    [PR3, 'open'],
  ]);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(
    d.deck.store.prs().map((pr) => pr.state),
    ['open', 'open', 'open'],
    'what gh answered is saved',
  );
});

test("ls --refresh when gh times out exits 0 and the pull requests show as can't read", async (t) => {
  const d = sessionsWithPrs(t);
  const runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  assert.equal(await main(['ls', '--refresh', '--json'], withRunner(d, runner)), 0);
  const json = listed(d);
  const s1 = json.sessions.find((session) => session.id === S1);
  const unreadable = s1?.prs.find((pr) => pr.url === PR1);
  assert.equal(unreadable?.state, null);
  assert.equal(unreadable?.error, 'gh timed out after 10 s');
  assert.equal(d.stderr(), '');
});

test('ls --refresh runs gh in the environment of the process, never as a shell command', async (t) => {
  const d = twoSessions(t, { env: { GH_HOST: 'evil.example', HOME_MARK: 'kept' } });
  attachManualPr(d.deck, S1, PR1);
  const runner = ghOpen();
  assert.equal(await main(['ls', '--refresh'], withRunner(d, runner)), 0);
  const env = runner.calls[0]?.options?.env;
  assert.equal(env?.['GH_HOST'], undefined, 'GH_HOST cannot send the question elsewhere');
  assert.equal(env?.['HOME_MARK'], 'kept');
});

test('ls --refresh does not ask gh about a pull request no session has attached', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.detachPr(S1, PR1, T0);
  const runner = ghOpen();
  assert.equal(await main(['ls', '--refresh'], withRunner(d, runner)), 0);
  assert.deepEqual(runner.calls, []);
});

test('ls shows an error text from gh without its escape sequences', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  const runner = fakeRunner(() => runResult({ code: 1, stderr: 'boom \x1b[31mred\x1b[0m\n' }));
  assert.equal(await main(['ls', '--refresh', '--json'], withRunner(d, runner)), 0);
  assert.ok(!d.stdout().includes('\x1b'), JSON.stringify(d.stdout()));
  assert.equal(listed(d).sessions[0]?.prs[0]?.error, 'boom red');
});
