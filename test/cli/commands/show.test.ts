import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatShow } from '../../../src/cli/output.ts';
import type { ShowJson } from '../../../src/cli/output.ts';
import { main } from '../../../src/cli/main.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { attachManualPr, setNote } from '../../../src/sessions/meta.ts';
import { refCases } from '../../helpers/command-cases.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { S1, S2, SEC, T0, fakeRunner, runResult } from '../../helpers/platform.ts';
import type { RunCall } from '../../helpers/platform.ts';
import {
  twoSessions,
  userRecord,
  withRunner,
  writeTranscript,
} from '../../helpers/session-files.ts';
import { testDeck } from '../../helpers/deck.ts';

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
