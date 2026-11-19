// `skydeck update` with the REAL git (F8, U8) on throwaway repositories: a checkout inside the
// test's sandbox whose only remote is a bare repository beside it (test/helpers/git-checkout.ts,
// which refuses any path outside the sandbox: hazard 1). No window server runs here; git sees no
// configuration of this machine, and nothing reaches the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform } from '../../../src/platform/types.ts';
import { gitCheckout, gitTestEnv, insideSandbox } from '../../helpers/git-checkout.ts';
import type { GitCheckout, GitCheckoutOptions } from '../../helpers/git-checkout.ts';
import type { Run } from '../../helpers/install.ts';
import { realTestPlatform } from '../../helpers/platform.ts';
import type { RealTestPlatform } from '../../helpers/platform.ts';
import { runUpdate } from '../../helpers/update.ts';

interface Real {
  tp: RealTestPlatform;
  c: GitCheckout;
  platform: Platform;
  update(args?: string[]): Promise<Run>;
  /** `status --porcelain` of the checkout, untracked files included. */
  status(): string;
  /** The remote-tracking ref of the checkout's upstream. */
  tracking(): string;
}

/**
 * A real test platform (its runner gives every program the sandbox's environment) whose app root is
 * a throwaway checkout; the command's environment carries git's test settings (gitTestEnv).
 */
function real(t: TestContext, options: GitCheckoutOptions = {}): Real {
  const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
  const c = gitCheckout(tp.sandbox, options);
  const platform: Platform = { ...tp.platform, appRoot: c.root };
  return {
    tp,
    c,
    platform,
    update: (args = []) => runUpdate(platform, tp.sandbox, args),
    status: () => c.git(c.root, 'status', '--porcelain'),
    tracking: () => c.id(`refs/remotes/${c.remoteName}/${c.branch}`),
  };
}

const short = (id: string): string => id.slice(0, 7);

describe('skydeck update with the real git: applying (U5, U8)', () => {
  test('a fast-forward across two commits: both reported newest first, HEAD at the newer, its files there', async (t) => {
    const r = real(t);
    const old = r.c.id();
    const first = r.c.push('add a file', { 'a.txt': 'a\n' });
    const second = r.c.push('change the README', { 'README.md': 'two\n' });

    const u = await r.update();

    assert.equal(u.code, 0, u.stderr);
    assert.equal(
      u.stdout,
      `2 new commits on origin/main (${short(old)}..${short(second)}):\n` +
        `  ${short(second)}  change the README\n  ${short(first)}  add a file\n` +
        `updated to ${short(second)}\n`,
    );
    assert.equal(u.stderr, '');
    assert.equal(r.c.id(), second);
    assert.equal(readFileSync(join(r.c.root, 'README.md'), 'utf8'), 'two\n');
    assert.equal(readFileSync(join(r.c.root, 'a.txt'), 'utf8'), 'a\n');
    assert.equal(r.status(), '');
  });

  test('--check: the report, and only the remote-tracking ref moved — HEAD, the files and the index as they were', async (t) => {
    const r = real(t);
    const old = r.c.id();
    const made = r.c.push('add a file', { 'a.txt': 'a\n' });

    const u = await r.update(['--check']);

    assert.equal(u.code, 0, u.stderr);
    assert.equal(
      u.stdout,
      `1 new commit on origin/main (${short(old)}..${short(made)}):\n  ${short(made)}  add a file\nrun skydeck update to apply it\n`,
    );
    assert.equal(r.c.id(), old);
    assert.equal(r.tracking(), made);
    assert.equal(r.status(), '');
    assert.deepEqual(readdirSync(r.c.root).sort(), ['.git', 'README.md']);
  });

  test('up to date: the line, nothing else; then a commit that changes src/store/migrations.ts brings the database line', async (t) => {
    const r = real(t);
    const old = r.c.id();

    const up = await r.update();
    assert.equal(up.code, 0, up.stderr);
    assert.equal(up.stdout, `skydeck is up to date (main at ${short(old)}, as origin/main)\n`);

    const made = r.c.push('a new upgrade step', { 'src/store/migrations.ts': 'export {};\n' });
    const u = await r.update(['--check']);
    assert.equal(u.code, 0, u.stderr);
    assert.equal(
      u.stdout,
      `1 new commit on origin/main (${short(old)}..${short(made)}):\n  ${short(made)}  a new upgrade step\n` +
        `this update changes the database's upgrade steps: it may upgrade the database, which an older checkout cannot open; a copy of the database as it was is kept first, and docs/install.md ("Going back") says how to return to ${short(old)}\n` +
        'run skydeck update to apply it\n',
    );
  });

  test('the upstream on a remote not named origin', async (t) => {
    const r = real(t, { remoteName: 'upstream', branch: 'trunk' });
    const old = r.c.id();
    const made = r.c.push('on trunk', { 'b.txt': 'b\n' });

    const u = await r.update();

    assert.equal(u.code, 0, u.stderr);
    assert.equal(
      u.stdout,
      `1 new commit on upstream/trunk (${short(old)}..${short(made)}):\n  ${short(made)}  on trunk\nupdated to ${short(made)}\n`,
    );
    assert.equal(r.c.id(), made);
  });

  test('an untracked file in the way of the merge: exit 1 with git’s line — HEAD, the files and the untracked file as they were', async (t) => {
    const r = real(t);
    const old = r.c.id();
    r.c.push('add new.txt', { 'new.txt': 'from the remote\n' });
    writeFileSync(join(r.c.root, 'new.txt'), 'my own\n');

    const u = await r.update();

    assert.equal(u.code, 1);
    // The reason is git's own first line, the one install.md's recovery tells the cases apart by
    // (ruled, the re-check's M1): git prints more lines, and this is the one that reaches the line.
    assert.equal(
      u.stderr,
      'skydeck: the update could not be applied: error: The following untracked working tree files would be overwritten by merge:; the checkout is as it was\n',
    );
    assert.equal(r.c.id(), old);
    assert.equal(r.status(), '?? new.txt\n');
    assert.equal(readFileSync(join(r.c.root, 'new.txt'), 'utf8'), 'my own\n');
  });
});

describe('the merge in a session of its own (ruled by the plan owner, review 2 S2)', () => {
  /** Fields 5 and 6 of a /proc/<pid>/stat line: the process group and the session. */
  function groupAndSession(stat: string): { pgrp: string; session: string } {
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pgrp: fields[2] ?? '', session: fields[3] ?? '' };
  }

  test("the merge's git is in neither this process's session nor its process group; the other calls are", async (t) => {
    const r = real(t);
    r.c.push('add a file', { 'a.txt': 'a\n' });
    // git on the sandbox's PATH becomes a wrapper that records its own process group and session
    // (as /proc/self/stat says them to the shell that is about to exec git), then runs git.
    const record = join(r.tp.sandbox.root, 'git-calls.txt');
    const wrapper = join(r.tp.sandbox.bin, 'git');
    rmSync(wrapper);
    writeFileSync(
      wrapper,
      `#!/bin/sh\nread -r skydeck_stat </proc/self/stat\nprintf '%s\\t%s\\n' "$*" "$skydeck_stat" >>'${record}'\nexec '${r.c.gitPath}' "$@"\n`,
      { mode: 0o755 },
    );
    const mine = groupAndSession(readFileSync('/proc/self/stat', 'utf8'));

    const u = await runUpdate({ ...r.platform, appRoot: r.c.root }, r.tp.sandbox);

    assert.equal(u.code, 0, u.stderr);
    const calls = readFileSync(record, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [args = '', stat = ''] = line.split('\t');
        return { args, ...groupAndSession(stat) };
      });
    const merges = calls.filter((c) => c.args.includes(' merge --ff-only '));
    assert.equal(merges.length, 1, JSON.stringify(calls));
    const [mergeCall] = merges;
    assert.notEqual(mergeCall?.session, mine.session, 'not in this session');
    assert.notEqual(mergeCall?.pgrp, mine.pgrp, 'not in this process group');
    const top = calls.find((c) => c.args.endsWith('rev-parse --show-toplevel'));
    assert.equal(top?.session, mine.session, 'the control: a call before the merge shares it');
    // The look at HEAD after the merge is in a session of its own too (the re-check's M1).
    const after = calls.slice(calls.findIndex((c) => c.args.includes(' merge --ff-only ')) + 1);
    const look = after.find((c) => c.args.endsWith('rev-parse --verify HEAD^{commit}'));
    assert.ok(look !== undefined, JSON.stringify(after));
    assert.notEqual(look.session, mine.session, 'the look after the merge: not in this session');
    assert.notEqual(look.pgrp, mine.pgrp);
  });
});

describe("git's own refusals of the fast-forward: the first line that reaches the command's line (the re-check's T1)", () => {
  test('a folder of the owner’s, untracked, where the new commit puts a file: git refuses and writes nothing — its first line, the checkout and the folder as they were', async (t) => {
    const r = real(t);
    const old = r.c.id();
    r.c.push('add the file sub', { sub: 'from the remote\n' });
    mkdirSync(join(r.c.root, 'sub'));
    writeFileSync(join(r.c.root, 'sub', 'mine.txt'), 'my own\n');

    const u = await r.update();

    assert.equal(u.code, 1);
    assert.equal(
      u.stderr,
      'skydeck: the update could not be applied: error: Updating the following directories would lose untracked files in them:; the checkout is as it was\n',
    );
    assert.equal(r.c.id(), old);
    assert.equal(readFileSync(join(r.c.root, 'sub', 'mine.txt'), 'utf8'), 'my own\n');
  });
});

describe('skydeck update with the real git: the refusals (U2, U8)', () => {
  /** Asserts a refusal: exit 1, the line, no stdout, HEAD and the remote-tracking ref unmoved. */
  async function refused(r: Real, line: string, args: string[] = []): Promise<void> {
    const head = r.c.id();
    const tracking = r.tracking();
    const u = await r.update(args);
    assert.equal(u.code, 1, u.stdout);
    assert.equal(u.stdout, '');
    assert.equal(u.stderr, `skydeck: ${line}\n`);
    assert.equal(r.c.id(), head, 'HEAD unmoved');
    assert.equal(r.tracking(), tracking, 'nothing fetched');
  }

  test('a changed tracked file, or a staged one: refused before the fetch; an untracked file alone is no change', async (t) => {
    const r = real(t);
    r.c.push('remote work', { 'c.txt': 'c\n' });
    writeFileSync(join(r.c.root, 'README.md'), 'changed\n');
    await refused(
      r,
      'this checkout has changes that are not committed (1 file, the first: README.md); commit or undo them first',
    );
    r.c.git(r.c.root, 'checkout', '--', 'README.md');
    writeFileSync(join(r.c.root, 'staged.txt'), 'staged\n');
    r.c.git(r.c.root, 'add', 'staged.txt');
    writeFileSync(join(r.c.root, 'README.md'), 'changed\n');
    await refused(
      r,
      'this checkout has changes that are not committed (2 files, the first: README.md); commit or undo them first',
    );

    r.c.git(r.c.root, 'reset', '--quiet', '--hard');
    writeFileSync(join(r.c.root, 'untracked.txt'), 'mine\n');
    const u = await r.update(['--check']);
    assert.equal(u.code, 0, u.stderr);
    assert.match(u.stdout, /^1 new commit on origin\/main /);
  });

  test('U2 10: an index lock left in the checkout — refused before anything is changed (only when there is something to apply)', async (t) => {
    const r = real(t);
    r.c.push('remote work', { 'c.txt': 'c\n' });
    const lock = join(r.c.root, '.git', 'index.lock');
    writeFileSync(lock, '');
    const head = r.c.id();

    const checked = await r.update(['--check']);
    assert.equal(checked.code, 0, checked.stderr);
    const u = await r.update();

    assert.equal(u.code, 1);
    assert.match(u.stdout, /^1 new commit on origin\/main /);
    assert.equal(
      u.stderr,
      `skydeck: this checkout's git index is locked (${lock}): another git command runs in it, or one was cut off and left the file; nothing was changed\n`,
    );
    assert.equal(r.c.id(), head);
  });

  test('a detached HEAD', async (t) => {
    const r = real(t);
    r.c.git(r.c.root, 'checkout', '--quiet', '--detach');
    await refused(
      r,
      'this checkout is not on a branch (detached HEAD); update it with git yourself',
    );
  });

  test('a branch with no upstream, or one that follows a local branch', async (t) => {
    const r = real(t);
    r.c.git(r.c.root, 'branch', '--quiet', '--unset-upstream');
    await refused(r, 'the branch main follows no branch of a remote; update it with git yourself');
    r.c.git(r.c.root, 'branch', '--quiet', 'local');
    r.c.git(r.c.root, 'branch', '--quiet', '--set-upstream-to=local');
    await refused(r, 'the branch main follows no branch of a remote; update it with git yourself');
  });

  test('ahead of the upstream, then diverged from it', async (t) => {
    const r = real(t);
    r.c.commit(r.c.root, 'my own', { 'mine.txt': 'mine\n' });
    await refused(
      r,
      'this checkout has 1 commit that origin/main does not have; update it with git yourself',
    );
    r.c.commit(r.c.root, 'my second', { 'mine2.txt': 'mine\n' });
    r.c.push('theirs', { 'theirs.txt': 'theirs\n' });
    const head = r.c.id();
    const u = await r.update();
    assert.equal(u.code, 1);
    assert.equal(
      u.stderr,
      'skydeck: this checkout has 2 commits that origin/main does not have; update it with git yourself\n',
    );
    assert.equal(r.c.id(), head);
  });

  test('a remote that is gone: the fetch fails, nothing changed', async (t) => {
    const r = real(t);
    rmSync(r.c.remote, { recursive: true, force: true });
    await refused(
      r,
      "git fetch from origin failed (git's own message is above); nothing was changed",
    );
  });

  test('not a git checkout: a directory in no repository, and one inside a work tree', async (t) => {
    const r = real(t);
    const plain = join(r.tp.sandbox.root, 'plain');
    mkdirSync(plain);
    const inside = join(r.c.root, 'sub');
    mkdirSync(inside);
    for (const root of [plain, inside]) {
      const u = await runUpdate({ ...r.platform, appRoot: root }, r.tp.sandbox);
      assert.equal(u.code, 1);
      assert.equal(
        u.stderr,
        `skydeck: ${root} is not a git checkout; update it the way it was installed\n`,
      );
    }
  });
});

describe('the test helpers keep real checkouts out (hazard 1)', () => {
  test('a root outside the sandbox is refused before anything runs: this repository, its parent, the sandbox root itself', async (t) => {
    const r = real(t);
    const repository = r.tp.platform.appRoot; // the test platforms' default: this repository
    for (const root of [repository, join(repository, '..'), r.tp.sandbox.root, '/']) {
      await assert.rejects(runUpdate({ ...r.platform, appRoot: root }, r.tp.sandbox), /refused/);
      assert.throws(() => r.c.git(root, 'status'), /refused/);
    }
    assert.throws(() => insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, '..', 'x')), /refused/);
  });
});

// ---------------------------------------------------------------------------------------------
// The real launcher (U6, U8)

/** Every regular file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

describe('the real launcher across an update of itself (U6, U8)', () => {
  test('a new commit that replaces bin/skydeck and every module under src/ and bin/: the command ends cleanly with "updated to"', async (t) => {
    const r = real(t, { content: 'skydeck' });
    const s = r.tp.sandbox;
    s.link('mktemp'); // the launcher's handoff file
    const old = r.c.id();
    const launcher = join(r.c.root, 'bin', 'skydeck');
    const launcherText = readFileSync(join(r.c.other, 'bin', 'skydeck'), 'utf8');
    // The new commit: every module the old process could still load throws when it is loaded, so
    // that one loaded after the merge ends the command with an error (U6); and the launcher gets
    // 64 KiB in front of its old text, inside a here-document its own run skips, made of `exit 42`
    // lines — a shell that read on in the NEW file where it had stopped in the old one would run
    // one of them.
    const poisoned: Record<string, string> = {};
    for (const dir of ['src', 'bin']) {
      for (const path of filesUnder(join(r.c.other, dir))) {
        if (path.endsWith('.ts') || path.endsWith('.mjs')) {
          poisoned[join(dir, path)] =
            `throw new Error('skydeck test: ${dir}/${path} was loaded after the merge');\n`;
        }
      }
    }
    assert.ok(Object.keys(poisoned).length > 50, 'the modules found');
    const padding = 'exit 42\n'.repeat(8192);
    poisoned['bin/skydeck'] = launcherText.replace(
      /^#!\/bin\/sh\n/,
      `#!/bin/sh\n: <<'SKYDECK_TEST_PADDING'\n${padding}SKYDECK_TEST_PADDING\n`,
    );
    const made = r.c.push('a new launcher and poisoned modules', poisoned);
    const inodeBefore = statSync(launcher).ino;

    const env = s.env({ ...gitTestEnv(s), SKYDECK_NODE: process.execPath });
    const u = spawnSync(launcher, ['update'], {
      env,
      cwd: s.home,
      encoding: 'utf8',
      timeout: 120_000,
    });

    assert.equal(u.error, undefined);
    // Node 24.12 warns once that node:sqlite is experimental, on every run; that is not ours.
    assert.equal(
      u.stderr
        .split('\n')
        .filter((line) => line !== '' && !/ExperimentalWarning|--trace-warnings/.test(line))
        .join('\n'),
      '',
    );
    assert.equal(
      u.stdout,
      `1 new commit on origin/main (${short(old)}..${short(made)}):\n  ${short(made)}  a new launcher and poisoned modules\n` +
        // src/store/migrations.ts is one of the modules replaced
        `this update changes the database's upgrade steps: it may upgrade the database, which an older checkout cannot open; a copy of the database as it was is kept first, and docs/install.md ("Going back") says how to return to ${short(old)}\n` +
        `updated to ${short(made)}\n`,
    );
    assert.equal(u.status, 0);
    assert.equal(r.c.id(), made);
    assert.equal(readFileSync(launcher, 'utf8'), poisoned['bin/skydeck']);
    // How git replaced the launcher the shell was reading: a new file in its place (another inode),
    // so that the open one keeps the old text until the shell ends.
    assert.notEqual(statSync(launcher).ino, inodeBefore);
  });
});
