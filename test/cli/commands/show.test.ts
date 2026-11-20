import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { EXIT } from '../../../src/cli/exit.ts';
import { jsonText } from '../../../src/cli/json.ts';
import { formatShow, showJson } from '../../../src/cli/output.ts';
import type { ShowJson } from '../../../src/cli/output.ts';
import { main } from '../../../src/cli/main.ts';
import { openDeck, resolveDeckPlaces } from '../../../src/sessions/deck.ts';
import type { Deck } from '../../../src/sessions/deck.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { attachManualPr, setNote, setTicket } from '../../../src/sessions/meta.ts';
import { refCases } from '../../helpers/command-cases.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { SESSION, keeperSandbox, startProgram } from '../../helpers/keeper.ts';
import { S1, S2, SEC, T0, fakeRunner, runResult } from '../../helpers/platform.ts';
import type { RunCall } from '../../helpers/platform.ts';
import {
  startRunning,
  twoSessions,
  userRecord,
  withRunner,
  writeTranscript,
} from '../../helpers/session-files.ts';
import { testDeck } from '../../helpers/deck.ts';
import { testContext, testContextOn } from '../../helpers/context.ts';

const USAGE_FIRST_LINE = 'skydeck show <ref> [--json] [--refresh]';
const PR1 = 'https://github.com/o/r/pull/1';
const PR2 = 'https://github.com/o/r/pull/2';
const PR3 = 'https://github.com/o/r/pull/3';

refCases('show', USAGE_FIRST_LINE);

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

function ghOpen() {
  return fakeRunner((call: RunCall) => {
    const aliases = call.args.filter((arg) => /^n\d+=/.test(arg)).length;
    return runResult({ stdout: openAnswer(aliases) });
  });
}

/** S1: one pull request never fetched, one fetched a minute ago. S2: one never fetched. */
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

const rowOf = (d: TestDeck, id = S1) => {
  const row = loadRows(d.deck).find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`no row ${id}`);
  }
  return row;
};

test('show prints the session with formatShow, for a prefix of its id', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['show', '0b5f'], d.ctx), 0);
  assert.equal(d.stdout(), formatShow(rowOf(d), d.deck.store.links(), T0));
  assert.equal(d.stderr(), '');
  assert.ok(d.stdout().startsWith('2026-11-12 08:59 demo\n'), d.stdout());
  assert.ok(d.stdout().includes(`\nid:        ${S1}\n`), d.stdout());
});

test('show finds a session by its full id, and by its label', async (t) => {
  const d = twoSessions(t);
  d.deck.store.updateMeta(S2, { label: 'work' }, T0);
  assert.equal(await main(['show', S1], d.ctx), 0);
  assert.ok(d.stdout().includes(`id:        ${S1}`));
  assert.equal(await main(['show', 'work'], d.ctx), 0);
  assert.ok(d.stdout().includes(`id:        ${S2}`));
});

test('show with a label that two sessions have exits 3, prints nothing, and lists both', async (t) => {
  const d = twoSessions(t);
  d.deck.store.updateMeta(S1, { label: 'work' }, T0);
  d.deck.store.updateMeta(S2, { label: 'work' }, T0);
  assert.equal(await main(['show', 'work'], d.ctx), 3);
  assert.equal(d.stdout(), '');
  assert.ok(d.stderr().startsWith("skydeck: 'work' matches 2 sessions\n"), d.stderr());
  assert.ok(d.stderr().includes('0b5f3c1e') && d.stderr().includes('1c6a4d2f'), d.stderr());
});

test('show --json prints one parsed object with the session fields and the extra keys', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['show', S1, '--json'], d.ctx), 0);
  const json = JSON.parse(d.stdout()) as ShowJson;
  assert.equal(json.id, S1);
  assert.equal(json.shortId, '0b5f3c1e');
  assert.equal(json.note, null);
  assert.equal(json.launch, null);
  assert.deepEqual(json.unknownFlags, []);
  assert.deepEqual(json.links, []);
  assert.deepEqual(json.holders, []);
  assert.equal(d.stdout(), `${JSON.stringify(json, null, 2)}\n`);
});

test('show --json carries the directory as it is', async (t) => {
  const d = testDeck(t);
  const dir = '/home/dev/pro\u0007jects/a\u009bb';
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 30n * SEC), cwd: dir }]);

  assert.equal(await main(['show', S1, '--json'], d.ctx), 0);

  assert.equal((JSON.parse(d.stdout()) as ShowJson).dir, dir);
  assert.doesNotMatch(d.stdout(), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test('show --json comes before or after the reference', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['show', '--json', S1], d.ctx), 0);
  assert.equal((JSON.parse(d.stdout()) as ShowJson).id, S1);
});

test('show prints a note line by line, sanitised, and show --json keeps the note and escapes it', async (t) => {
  const d = twoSessions(t);
  const note = 'one \x1b[31mred\x1b[0m\ntwo\u009b2J three';
  setNote(d.deck, S1, note);

  assert.equal(await main(['show', '0b5f'], d.ctx), 0);
  assert.ok(!/[\x1b\x07\u0080-\u009f]/.test(d.stdout()), JSON.stringify(d.stdout()));
  assert.ok(d.stdout().endsWith('\nnote:\n  one red\n  two three\n'), JSON.stringify(d.stdout()));

  const before = d.stdout().length;
  assert.equal(await main(['show', '0b5f', '--json'], d.ctx), 0);
  const text = d.stdout().slice(before);
  assert.ok(!/[\x1b\x07\u0080-\u009f]/.test(text), JSON.stringify(text));
  assert.equal((JSON.parse(text) as ShowJson).note, note, 'the stored note, exactly');
});

test('show without --refresh never starts gh, and shows an unfetched pull request as "not fetched"', async (t) => {
  const d = sessionsWithPrs(t);
  const runner = ghOpen();
  assert.equal(await main(['show', '0b5f'], withRunner(d, runner)), 0);
  assert.deepEqual(runner.calls, []);
  assert.ok(d.stdout().includes(`\npr:        ${PR1}  not fetched\n`), d.stdout());
  assert.ok(
    d.stdout().includes(`\npr:        ${PR2}  approved-green checks passing\n`),
    d.stdout(),
  );
});

test('show --refresh asks gh about every pull request of that session, the fresh one too, in one call', async (t) => {
  const d = sessionsWithPrs(t);
  const runner = ghOpen();

  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.command, 'gh');
  const numbers = (runner.calls[0]?.args ?? []).filter((arg) => /^n\d+=/.test(arg)).sort();
  assert.deepEqual(numbers, ['n0=1', 'n1=2'], 'both pull requests of S1, not the one of S2');
  assert.ok(
    d.stdout().includes(`\npr:        ${PR1}  approved-green checks passing\n`),
    d.stdout(),
  );
  assert.equal(
    d.deck.store.prs().find((pr) => pr.url === PR3)?.state,
    null,
    'the pull request of the other session stays as it was',
  );
});

test('show --refresh asks again about a pull request whose last fetch failed, though it was read a minute before', async (t) => {
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

  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);

  assert.equal(runner.calls.length, 1);
  assert.ok(
    d.stdout().includes(`\npr:        ${PR1}  approved-green checks passing\n`),
    d.stdout(),
  );
});

test('show --refresh never asks about a merged or a closed pull request', async (t) => {
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
  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);
  assert.deepEqual(runner.calls, []);
  assert.ok(d.stdout().includes(`\npr:        ${PR1}  merged\n`), d.stdout());
});

test('show --refresh --json prints the status it just read', async (t) => {
  const d = sessionsWithPrs(t);
  assert.equal(await main(['show', '0b5f', '--refresh', '--json'], withRunner(d, ghOpen())), 0);
  const json = JSON.parse(d.stdout()) as ShowJson;
  assert.deepEqual(
    json.prs.map((pr) => [pr.url, pr.state]),
    [
      [PR1, 'open'],
      [PR2, 'open'],
    ],
  );
});

test("show --refresh when gh times out exits 0, and the pull request shows as can't read", async (t) => {
  const d = sessionsWithPrs(t);
  const runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);
  assert.ok(
    d
      .stdout()
      .includes(`\npr:        ${PR1}  can't read, last read never (gh timed out after 10 s)\n`),
    d.stdout(),
  );
  assert.equal(d.stderr(), '');
});

test('show --refresh runs gh in the environment of the process', async (t) => {
  const d = twoSessions(t, { env: { GH_HOST: 'evil.example', HOME_MARK: 'kept' } });
  attachManualPr(d.deck, S1, PR1);
  const runner = ghOpen();
  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);
  const env = runner.calls[0]?.options?.env;
  assert.equal(env?.['GH_HOST'], undefined, 'GH_HOST cannot send the question elsewhere');
  assert.equal(env?.['HOME_MARK'], 'kept');
});

test('show --refresh of a session with nothing to fetch does not start gh', async (t) => {
  const d = twoSessions(t);
  const runner = ghOpen();
  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);
  assert.deepEqual(runner.calls, []);
});

test('show prints the error of a pull request without its escape sequences', async (t) => {
  const d = twoSessions(t);
  attachManualPr(d.deck, S1, PR1);
  const runner = fakeRunner(() => runResult({ code: 1, stderr: 'boom \x1b[31mred\x1b[0m\x07\n' }));
  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);
  assert.ok(!/[\x1b\x07]/.test(d.stdout()), JSON.stringify(d.stdout()));
  assert.ok(d.stdout().includes('(boom red)'), d.stdout());
});

// --- the ticket address (S2 12.5, D16) ---------------------------------------------------------

const JIRA = 'https://example.atlassian.net/browse/{key}';

test('show prints the ticket address after the group set by the user, with ticketUrl set', async (t) => {
  const d = twoSessions(t, { config: { ticketUrl: JIRA } });
  d.deck.store.updateMeta(S1, { group: 'ABC-12 cleanup' }, T0);

  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);

  assert.ok(
    d
      .stdout()
      .includes(
        '\ngroup:     ABC-12 cleanup\nticket:    https://example.atlassian.net/browse/ABC-12\n',
      ),
    d.stdout(),
  );
  assert.equal(d.stderr(), '');
});

test('show prints the ticket address of a group taken from the title', async (t) => {
  const d = twoSessions(t, { config: { ticketUrl: 'https://Example.net:443/t/{key}' } });
  d.deck.store.updateMeta(S1, { label: 'ABC-12 fix the retry' }, T0);

  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);

  assert.equal(rowOf(d).groupSource, 'title');
  assert.ok(
    d.stdout().includes('\ngroup:     ABC-12\nticket:    https://example.net/t/ABC-12\n'),
    d.stdout(),
  );
});

test('show finds the key with the configured groupPattern', async (t) => {
  const d = twoSessions(t, { config: { ticketUrl: JIRA, groupPattern: '[a-z]+-[0-9]+' } });
  d.deck.store.updateMeta(S1, { group: 'abc-12 cleanup' }, T0);

  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);

  assert.ok(
    d
      .stdout()
      .includes(
        '\ngroup:     abc-12 cleanup\nticket:    https://example.atlassian.net/browse/abc-12\n',
      ),
    d.stdout(),
  );
});

test('show prints no ticket line without ticketUrl, or without a ticket key in the group', async (t) => {
  const without = twoSessions(t);
  without.deck.store.updateMeta(S1, { group: 'ABC-12' }, T0);
  assert.equal(await main(['show', '0b5f'], without.ctx), EXIT.ok);
  assert.ok(without.stdout().includes('\ngroup:     ABC-12\n'), without.stdout());
  assert.doesNotMatch(without.stdout(), /ticket:/);

  const noKey = twoSessions(t, { config: { ticketUrl: JIRA } });
  noKey.deck.store.updateMeta(S1, { group: 'cleanup' }, T0);
  assert.equal(await main(['show', '0b5f'], noKey.ctx), EXIT.ok);
  assert.ok(noKey.stdout().includes('\ngroup:     cleanup\n'), noKey.stdout());
  assert.doesNotMatch(noKey.stdout(), /ticket:/);

  const noGroup = twoSessions(t, { config: { ticketUrl: JIRA } });
  assert.equal(await main(['show', '0b5f'], noGroup.ctx), EXIT.ok);
  assert.doesNotMatch(noGroup.stdout(), /ticket:/);
});

test("show --json is unchanged by ticketUrl: the group's link is not in it, and `ticket` (F18) is null without one set", async (t) => {
  const d = twoSessions(t, { config: { ticketUrl: JIRA } });
  d.deck.store.updateMeta(S1, { group: 'ABC-12' }, T0);

  assert.equal(await main(['show', '0b5f', '--json'], d.ctx), EXIT.ok);

  assert.equal(
    d.stdout(),
    `${JSON.stringify(showJson(rowOf(d), d.deck.store.links()), null, 2)}\n`,
  );
  assert.doesNotMatch(d.stdout(), /atlassian/);
  assert.equal((JSON.parse(d.stdout()) as ShowJson).ticket, null);
});

// --- the ticket the user set (F18, K7) ---------------------------------------------------------

test('show prints the ticket the user set after the group, with or without ticketUrl', async (t) => {
  for (const config of [{}, { ticketUrl: JIRA }]) {
    const d = twoSessions(t, { config });
    setTicket(d.deck, S1, 'https://github.com/owner/repo/issues/5');
    assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);
    assert.ok(
      d
        .stdout()
        .includes('\ngroup:     -\nticket:    https://github.com/owner/repo/issues/5\ndir:'),
      d.stdout(),
    );
  }
});

test("the ticket the user set is the one ticket line: it stands in for the group's link, which the window's group chip keeps", async (t) => {
  const d = twoSessions(t, { config: { ticketUrl: JIRA } });
  d.deck.store.updateMeta(S1, { group: 'ABC-12' }, T0);
  setTicket(d.deck, S1, 'https://github.com/owner/repo/issues/5');

  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);

  assert.ok(
    d.stdout().includes('\ngroup:     ABC-12\nticket:    https://github.com/owner/repo/issues/5\n'),
    d.stdout(),
  );
  assert.equal(d.stdout().match(/^ticket:/gm)?.length, 1);
});

test('show --json carries the ticket the user set: its address and its name', async (t) => {
  const d = twoSessions(t);
  setTicket(d.deck, S1, 'https://example.com/browse/ABC-123');

  assert.equal(await main(['show', '0b5f', '--json'], d.ctx), EXIT.ok);

  // F19: and its status' fields, null while no status is known (no provider reads this one).
  assert.deepEqual((JSON.parse(d.stdout()) as ShowJson).ticket, {
    url: 'https://example.com/browse/ABC-123',
    text: 'ABC-123',
    status: null,
    category: null,
    okAt: null,
    triedAt: null,
    error: null,
  });
});

for (const args of [['show', S1], ['show', S1, '--json'], ['ls']]) {
  test(`a wrong ticketUrl fails skydeck ${args.join(' ')} with its one line, exit 1`, async (t) => {
    const c = testContext(t);
    mkdirSync(c.places.configDir, { recursive: true });
    writeFileSync(c.places.configPath, JSON.stringify({ ticketUrl: 'https:///{key}/browse' }));

    assert.equal(await main(args, c.ctx), EXIT.failure);

    assert.equal(
      c.stderr(),
      `skydeck: ${c.places.configPath}: "ticketUrl" must be null or an http or https address with {key} once, after its host\n`,
    );
    assert.equal(c.stdout(), '');
  });
}

// --- the window's mark (C15, S2 11.4) ------------------------------------------------------------

test('show marks a holder that runs in a keeper of the window; show --json is unchanged for it', async (t) => {
  let deck: Deck | null = null;
  t.after(() => deck?.store.close());
  const box = keeperSandbox(t);
  const c = testContextOn(box.tp);
  const { claudeHome } = resolveDeckPlaces(box.tp.platform).places;
  mkdirSync(join(claudeHome, 'projects'), { recursive: true });
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true });
  const keeper = await box.start();
  // Its prompt is on the screen: its SessionStart hook has run, the stand-in holds SESSION.
  const { started } = await startProgram(keeper);

  assert.equal(await main(['show', SESSION.slice(0, 8)], c.ctx), EXIT.ok);

  const holders = c
    .stdout()
    .split('\n')
    .filter((line) => line.startsWith('holder:'));
  assert.equal(holders.length, 1, c.stdout());
  assert.match(
    holders[0] ?? '',
    new RegExp(`^holder: {4}pid ${started.pid} since \\S+Z \\(in the skydeck window\\)$`),
  );
  assert.equal(c.stderr(), '');

  const before = c.stdout().length;
  assert.equal(await main(['show', SESSION.slice(0, 8), '--json'], c.ctx), EXIT.ok);
  const text = c.stdout().slice(before);
  deck = openDeck(box.tp.platform);
  const row = loadRows(deck).find((candidate) => candidate.id === SESSION);
  assert.ok(row !== undefined);
  assert.equal(text, jsonText(showJson(row, deck.store.links())));
  assert.deepEqual(
    (JSON.parse(text) as ShowJson).holders.map((h) => h.pid),
    [started.pid],
  );
  assert.doesNotMatch(text, /window/);
});

test('show of a session held outside the window prints its holder line as before and creates no runtime directory', async (t) => {
  const d = twoSessions(t);
  startRunning(d, S1, 4242);

  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);

  assert.equal(d.stdout(), formatShow(rowOf(d), d.deck.store.links(), T0));
  assert.ok(d.stdout().includes('\nholder:    pid 4242 since '), d.stdout());
  assert.doesNotMatch(d.stdout(), /skydeck window/);
  assert.equal(existsSync(join(d.sandbox.skydeckHome, 'run')), false);
});

/** F32: `gh` answers an approved pull request with passing checks that GitHub will not merge (q<i>: BLOCKED). */
function ghBlocked() {
  return fakeRunner((call: RunCall) => {
    const aliases = call.args.filter((arg) => /^n\d+=/.test(arg)).length;
    const { data } = JSON.parse(openAnswer(aliases)) as {
      data: Record<string, { pullRequest: Record<string, unknown> }>;
    };
    for (let i = 0; i < aliases; i++) {
      const p = data[`p${i}`];
      if (p !== undefined) p.pullRequest['reviewDecision'] = 'APPROVED';
      data[`q${i}`] = {
        pullRequest: {
          mergeStateStatus: 'BLOCKED',
          latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'APPROVED' }] },
          reviewThreads: { totalCount: 0, nodes: [] },
          baseRef: { rules: { totalCount: 0, nodes: [] } },
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        },
      };
    }
    return runResult({ stdout: JSON.stringify({ data }) });
  });
}

test('F32: show prints a pull request GitHub will not merge as blocked, with its stored review', async (t) => {
  const d = sessionsWithPrs(t);
  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, ghBlocked())), 0);
  assert.ok(
    d.stdout().includes(`\npr:        ${PR1}  blocked review blocked checks passing\n`),
    d.stdout(),
  );

  const before = d.stdout().length;
  assert.equal(await main(['show', '0b5f', '--json'], d.ctx), 0);
  const json = JSON.parse(d.stdout().slice(before)) as ShowJson;
  assert.deepEqual(
    json.prs.map((pr) => [pr.review, pr.checks]),
    [
      ['blocked', 'passing'],
      ['blocked', 'passing'],
    ],
  );
});

test('F32 (ruled): a required check that has not reported is stored as not-reported; the review comes first', async (t) => {
  const d = sessionsWithPrs(t);
  const runner = fakeRunner((call: RunCall) => {
    const aliases = call.args.filter((arg) => /^n\d+=/.test(arg)).length;
    const { data } = JSON.parse(openAnswer(aliases)) as { data: Record<string, unknown> };
    for (let i = 0; i < aliases; i++) {
      data[`q${i}`] = {
        pullRequest: {
          mergeStateStatus: 'BLOCKED',
          latestOpinionatedReviews: { totalCount: 0, nodes: [] },
          reviewThreads: { totalCount: 0, nodes: [] },
          baseRef: {
            rules: {
              totalCount: 2,
              nodes: [
                {
                  type: 'PULL_REQUEST',
                  repositoryRuleset: { enforcement: 'ACTIVE' },
                  parameters: {
                    __typename: 'PullRequestParameters',
                    requiredApprovingReviewCount: 1,
                    requiredReviewThreadResolution: false,
                  },
                },
                {
                  type: 'REQUIRED_STATUS_CHECKS',
                  repositoryRuleset: { enforcement: 'ACTIVE' },
                  parameters: {
                    __typename: 'RequiredStatusChecksParameters',
                    requiredStatusChecks: [{ context: 'deploy' }],
                  },
                },
              ],
            },
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'build' }] },
                  },
                },
              },
            ],
          },
        },
      };
    }
    return runResult({ stdout: JSON.stringify({ data }) });
  });
  assert.equal(await main(['show', '0b5f', '--refresh'], withRunner(d, runner)), 0);
  assert.ok(
    d
      .stdout()
      .includes(
        `\npr:        ${PR1}  review-required review review-required checks not-reported\n`,
      ),
    d.stdout(),
  );
});
