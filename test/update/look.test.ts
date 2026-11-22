// The look for a newer skydeck (F38; src/update/look.ts) on the scripted git: the command's order
// (`tolerant: false`) and the window's (`tolerant: true`), the fetch kinds, the lines it gives.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import { gitOn } from '../../src/update/git.ts';
import { lookForUpdate, report } from '../../src/update/look.ts';
import type { Fetch, Looked } from '../../src/update/look.ts';
import { testPlatform } from '../helpers/platform.ts';
import {
  gitArgs,
  NEW,
  OLD,
  migrationsEntry,
  scriptedGit,
  scriptedRepo,
  subCommand,
} from '../helpers/update.ts';
import type { ScriptedRepo } from '../helpers/update.ts';

interface Looker {
  root: string;
  /** The sub-commands of the git calls made, in order (`fetch` included). */
  trace(): string[];
  look(fetch: Fetch, tolerant: boolean): Promise<Looked>;
}

function looker(t: TestContext, over: Partial<ScriptedRepo> = {}): Looker {
  const tp = testPlatform(t);
  const root = join(tp.sandbox.root, 'checkout');
  mkdirSync(root);
  const order: string[] = [];
  const repo = scriptedRepo(root, {
    ...over,
    onCall: (call) => {
      // The quiet fetch's `-c core.askPass=` stands before its sub-command.
      order.push(gitArgs(call, root).includes('fetch') ? 'fetch' : subCommand(call, root));
    },
  });
  const platform: Platform = { ...tp.platform, runner: scriptedGit(repo), appRoot: root };
  const git = gitOn(platform, root);
  return {
    root,
    trace: () => [...order],
    look: (fetch, tolerant) => lookForUpdate(git, platform.files, { fetch, tolerant }),
  };
}

const QUIET: Fetch = { quiet: {} };
const CHANGES =
  'this checkout has changes that are not committed (1 file, the first: a.txt); commit or undo them first';
const MODIFIED = ' M a.txt\0';

function known(looked: Looked): Extract<Looked, { kind: 'known' }> {
  assert.equal(looked.kind, 'known', JSON.stringify(looked));
  return looked as Extract<Looked, { kind: 'known' }>;
}

describe("lookForUpdate, the window's order (tolerant)", () => {
  test('a changed tracked file still fetches and is known, blocked by the changes line', async (t) => {
    const l = looker(t, { status: MODIFIED });

    const looked = known(await l.look(QUIET, true));

    assert.ok(l.trace().includes('fetch'));
    assert.equal(looked.blocked, CHANGES);
    assert.equal(looked.update.count, 1);
    assert.equal(looked.fetchFailed, null);
  });

  test('diverged: known, the commits listed, blocked by the ahead line', async (t) => {
    const l = looker(t, { ancestor: false, ahead: 2, behind: 1 });

    const looked = known(await l.look(QUIET, true));

    assert.equal(looked.update.count, 1);
    assert.equal(looked.update.ahead, 2);
    assert.deepEqual(looked.update.commits, [{ id: NEW, subject: 'the new commit' }]);
    assert.equal(
      looked.blocked,
      'this checkout has 2 commits that origin/main does not have; update it with git yourself',
    );
  });

  test('diverged and changed: the changes line blocks', async (t) => {
    const l = looker(t, { ancestor: false, ahead: 2, status: MODIFIED });

    assert.equal(known(await l.look(QUIET, true)).blocked, CHANGES);
  });

  test('ahead only: count 0, ahead n, no commits read', async (t) => {
    const l = looker(t, { ancestor: false, ahead: 3, behind: 0 });

    const looked = known(await l.look(QUIET, true));

    assert.equal(looked.update.count, 0);
    assert.equal(looked.update.ahead, 3);
    assert.deepEqual(looked.update.commits, []);
    assert.ok(!l.trace().includes('log'));
  });

  test('up to date: known with count 0 and nothing blocked', async (t) => {
    const l = looker(t, { fetched: OLD });

    const looked = known(await l.look(QUIET, true));

    assert.equal(looked.update.newId, OLD);
    assert.equal(looked.update.count, 0);
    assert.equal(looked.blocked, null);
  });

  test("no upstream, a local upstream, detached, not a checkout, git missing: cannot, with the command's lines", async (t) => {
    const cases: [Partial<ScriptedRepo>, string][] = [
      [
        { upstream: { ref: '', remote: '', short: '' } },
        'the branch main follows no branch of a remote; update it with git yourself',
      ],
      [
        { upstream: { ref: 'refs/heads/other', remote: '.', short: 'other' } },
        'the branch main follows no branch of a remote; update it with git yourself',
      ],
      [
        { branch: null },
        'this checkout is not on a branch (detached HEAD); update it with git yourself',
      ],
    ];
    for (const [over, line] of cases) {
      const l = looker(t, over);
      const looked = await l.look(QUIET, true);
      assert.deepEqual(looked, {
        kind: 'cannot',
        line,
        head: null,
        failed: false,
        fetchFailed: null,
      });
      assert.ok(!l.trace().includes('fetch'));
    }
    const notCheckout = looker(t, { toplevel: null });
    assert.deepEqual(await notCheckout.look(QUIET, true), {
      kind: 'cannot',
      line: `${notCheckout.root} is not a git checkout; update it the way it was installed`,
      head: null,
      failed: false,
      fetchFailed: null,
    });
    const missing = looker(t, { answers: { 'rev-parse --show-toplevel': { notFound: true } } });
    assert.deepEqual(await missing.look(QUIET, true), {
      kind: 'cannot',
      line: 'git was not found on PATH; skydeck update needs it',
      head: null,
      failed: true,
      fetchFailed: null,
    });
  });

  test('a git call that fails or times out is a cannot that failed; a state of the checkout is not', async (t) => {
    const timedOut = looker(t, {
      answers: { 'rev-parse --show-toplevel': { code: null, timedOut: true } },
    });
    const slow = await timedOut.look(QUIET, true);
    assert.ok(slow.kind === 'cannot' && slow.failed, JSON.stringify(slow));
    const failing = looker(t, {
      answers: { 'symbolic-ref --quiet HEAD': { code: 128, stderr: 'fatal: bad\n' } },
    });
    assert.deepEqual(await failing.look(QUIET, true), {
      kind: 'cannot',
      line: 'git symbolic-ref failed: fatal: bad; nothing was changed',
      head: null,
      failed: true,
      fetchFailed: null,
    });
    const detached = await looker(t, { branch: null }).look(QUIET, true);
    assert.ok(detached.kind === 'cannot' && !detached.failed);
  });

  test("fetch 'none' makes no fetch call and no look after one", async (t) => {
    const l = looker(t);

    const looked = known(await l.look('none', true));

    assert.equal(looked.update.count, 1);
    assert.deepEqual(l.trace(), [
      'rev-parse',
      'symbolic-ref',
      'for-each-ref',
      'rev-parse',
      'status',
      'rev-parse',
      'merge-base',
      'rev-list',
      'log',
      'ls-tree',
      'ls-tree',
    ]);
  });

  test('a quiet fetch that fails or times out: known, with its line, the facts those of the ref as it was', async (t) => {
    const failed = looker(t, {
      quietFetch: { code: 128, stderr: "fatal: '/gone' does not appear to be a git repository\n" },
    });
    const looked = known(await failed.look(QUIET, true));
    assert.equal(
      looked.fetchFailed,
      "git fetch from origin failed: fatal: '/gone' does not appear to be a git repository",
    );
    // An update an earlier fetch brought is still there.
    assert.equal(looked.update.count, 1);
    assert.equal(looked.update.newId, NEW);

    const slow = looker(t, { quietFetch: { code: null, timedOut: true } });
    assert.equal(
      known(await slow.look(QUIET, true)).fetchFailed,
      'git fetch from origin failed: no answer within 60 s',
    );
  });

  test('a failure line of 5,000 characters comes back as 300, ending in …', async (t) => {
    const l = looker(t, { quietFetch: { code: 1, stderr: `${'x'.repeat(5000)}\n` } });

    const line = known(await l.look(QUIET, true)).fetchFailed ?? '';

    assert.equal(line.length, 300);
    assert.ok(line.startsWith('git fetch from origin failed: xxx'));
    assert.ok(line.endsWith('…'));
  });

  test('the branch moved while the fetch ran: cannot', async (t) => {
    const l = looker(t, { afterFetch: { head: NEW } });

    const looked = await l.look(QUIET, true);

    assert.deepEqual(looked, {
      kind: 'cannot',
      line: 'this checkout changed while git fetch ran (main at fedcba9); run skydeck update again',
      head: OLD,
      failed: false,
      fetchFailed: null,
    });
  });

  test('a fetch that failed is not lost when the look then ends as changed while it ran', async (t) => {
    const l = looker(t, {
      afterFetch: { head: NEW },
      quietFetch: { code: 128, stderr: 'fatal: gone\n' },
    });

    const looked = await l.look(QUIET, true);

    assert.ok(looked.kind === 'cannot');
    assert.equal(looked.failed, false);
    assert.equal(looked.fetchFailed, 'git fetch from origin failed: fatal: gone');
  });

  test('the database line comes with report() for a commit that changes the upgrade steps', async (t) => {
    const l = looker(t, { migrations: { [NEW]: migrationsEntry('6'.repeat(40)) } });

    const looked = known(await l.look(QUIET, true));

    assert.equal(looked.update.upgradesDatabase, true);
    assert.match(
      report(looked.update).at(-1) ?? '',
      /^this update changes the database's upgrade steps/,
    );
  });
});

describe("lookForUpdate, the command's order (not tolerant)", () => {
  test('a failed fetch, terminal or quiet: cannot, as today', async (t) => {
    const terminal = looker(t, { fetch: 1 });
    assert.deepEqual(await terminal.look('terminal', false), {
      kind: 'cannot',
      line: "git fetch from origin failed (git's own message is above); nothing was changed",
      head: OLD,
      failed: true,
      fetchFailed: null,
    });
    const quiet = looker(t, { quietFetch: { code: 1, stderr: 'fatal: no\n' } });
    assert.deepEqual(await quiet.look(QUIET, false), {
      kind: 'cannot',
      line: 'git fetch from origin failed: fatal: no',
      head: OLD,
      failed: true,
      fetchFailed: 'git fetch from origin failed: fatal: no',
    });
  });

  test('a changed file refuses before any fetch call', async (t) => {
    const l = looker(t, { status: MODIFIED });

    assert.deepEqual(await l.look('terminal', false), {
      kind: 'cannot',
      line: CHANGES,
      head: null,
      failed: false,
      fetchFailed: null,
    });
    assert.deepEqual(l.trace(), ['rev-parse', 'symbolic-ref', 'for-each-ref', 'status']);
  });

  test('ahead or diverged: cannot with the ahead line', async (t) => {
    const l = looker(t, { ancestor: false, ahead: 1 });

    assert.deepEqual(await l.look('terminal', false), {
      kind: 'cannot',
      line: 'this checkout has 1 commit that origin/main does not have; update it with git yourself',
      head: OLD,
      failed: false,
      fetchFailed: null,
    });
  });
});
