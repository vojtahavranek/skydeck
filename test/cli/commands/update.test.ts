// `skydeck update [--check]` (F8: U1–U5, U8's cases with the fake runner). git is a script
// (test/helpers/update.ts) that answers exactly the calls the command makes and fails the test for
// any other; the window's server is absent here (test/cli/commands/update-server.test.ts has the
// cases with one). Every root is a directory inside the test's sandbox (hazard 1).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Net, Platform } from '../../../src/platform/types.ts';
import { SkydeckError } from '../../../src/platform/errors.ts';
import { SCHEMA_VERSION } from '../../../src/store/migrations.ts';
import { DatabaseNewerError, openStore } from '../../../src/store/store.ts';
import type { Run } from '../../helpers/install.ts';
import { run } from '../../helpers/install.ts';
import { testPlatform } from '../../helpers/platform.ts';
import type { FakeRunner, TestPlatform } from '../../helpers/platform.ts';
import {
  NEW,
  OLD,
  commitId,
  migrationsEntry,
  runUpdate,
  scriptedGit,
  scriptedRepo,
  subCommand,
} from '../../helpers/update.ts';
import type { ScriptedRepo } from '../../helpers/update.ts';

const IN_CLAUDE_CODE =
  "skydeck: skydeck update is not run from inside a Claude Code session: it restarts the window's server, and every session in the window would inherit that session's environment; run it in a terminal of your own (skydeck update --check only looks)\n";

interface Updater {
  tp: TestPlatform;
  root: string;
  repo: ScriptedRepo;
  runner: FakeRunner;
  platform: Platform;
  /** `skydeck update <args>` on this checkout. */
  update(args?: string[]): Promise<Run>;
  /** The sub-commands of the git calls made, in order (`fetch` included, where it came). */
  trace(): string[];
}

/** A checkout `<sandbox>/checkout` played by the scripted git, with no window server. */
function updater(
  t: TestContext,
  over: Partial<ScriptedRepo> = {},
  env: Record<string, string | undefined> = {},
): Updater {
  const tp = testPlatform(t, { env });
  const root = join(tp.sandbox.root, 'checkout');
  mkdirSync(root);
  const order: string[] = [];
  const repo = scriptedRepo(root, {
    ...over,
    onCall: (call, interactive) => {
      order.push(call.command === 'git' ? subCommand(call, root) : `launch ${call.args.join(' ')}`);
      over.onCall?.(call, interactive);
    },
  });
  const runner = scriptedGit(repo);
  const platform: Platform = { ...tp.platform, runner, appRoot: root };
  return {
    tp,
    root,
    repo,
    runner,
    platform,
    update: (args = []) => runUpdate(platform, tp.sandbox, args),
    trace: () => [...order],
  };
}

/** The checks before the fetch, in their order (U2 2–6), and HEAD's id. */
const BEFORE_FETCH = ['rev-parse', 'symbolic-ref', 'for-each-ref', 'status', 'rev-parse'];
/** What a look at one commit on the upstream calls, after the fetch (U4). */
const LOOK = ['rev-parse', 'merge-base', 'rev-list', 'log', 'ls-tree', 'ls-tree'];

/** The report of one new commit (U4). */
const ONE_COMMIT = `1 new commit on origin/main (0123456..fedcba9):\n  fedcba9  the new commit\n`;

// ---------------------------------------------------------------------------------------------
// U1: the command

describe('skydeck update: the command (U1)', () => {
  test('it is listed with its summary; --help prints its usage; an option or an argument it does not have is a usage error', async (t) => {
    const u = updater(t);

    const list = await run(u.platform, ['--help']);
    assert.match(
      list.stdout,
      /\n {2}update +Bring this checkout up to date and restart the window's server\n/,
    );
    const help = await u.update(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^skydeck update \[--check\]\n/);
    for (const args of [['--force'], ['origin'], ['--check', 'main']]) {
      const r = await u.update(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(u.trace(), [], 'git is not run for any of them');
  });
});

// ---------------------------------------------------------------------------------------------
// U2: what must hold, else it refuses

describe('skydeck update: what must hold, else it refuses — exit 1, one line, nothing changed (U2)', () => {
  test('1. CLAUDECODE set: refused before any git call; with --check the variable does not matter', async (t) => {
    const u = updater(t, {}, { CLAUDECODE: '1' });

    const r = await u.update();
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, IN_CLAUDE_CODE);
    assert.deepEqual(u.trace(), []);

    const checked = await u.update(['--check']);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(checked.stdout, `${ONE_COMMIT}run skydeck update to apply it\n`);
    assert.deepEqual(u.trace(), [...BEFORE_FETCH, 'fetch', ...LOOK]);
  });

  test('2. git not found: the line, and no other call', async (t) => {
    const u = updater(t, {
      answers: { 'rev-parse --show-toplevel': { code: null, notFound: true } },
    });

    const r = await u.update();

    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'skydeck: git was not found on PATH; skydeck update needs it\n');
    assert.deepEqual(u.trace(), ['rev-parse']);
  });

  test('3. not the top of a work tree of its own: rev-parse fails, or names another directory', async (t) => {
    const failing = updater(t, { toplevel: null });
    const r = await failing.update();
    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      `skydeck: ${failing.root} is not a git checkout; update it the way it was installed\n`,
    );
    assert.deepEqual(failing.trace(), ['rev-parse']);

    // A directory inside another repository's work tree: its top is the parent.
    const inside = updater(t);
    inside.repo.toplevel = inside.tp.sandbox.root;
    const r2 = await inside.update();
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, / is not a git checkout; update it the way it was installed\n$/);
    assert.deepEqual(inside.trace(), ['rev-parse']);
  });

  test('3. the same directory reached through a symbolic link is its own top', async (t) => {
    const u = updater(t);
    const link = join(u.tp.sandbox.root, 'link');
    symlinkSync(u.root, link);
    u.repo.toplevel = link;

    const r = await u.update(['--check']);

    assert.equal(r.code, 0, r.stderr);
  });

  test('4. a detached HEAD', async (t) => {
    const u = updater(t, { branch: null });

    const r = await u.update();

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      'skydeck: this checkout is not on a branch (detached HEAD); update it with git yourself\n',
    );
    assert.deepEqual(u.trace(), ['rev-parse', 'symbolic-ref']);
  });

  test('5. no upstream, or an upstream that is a local branch', async (t) => {
    for (const upstream of [
      { ref: '', remote: '', short: '' },
      { ref: 'refs/heads/other', remote: '.', short: 'other' },
    ]) {
      const u = updater(t, { branch: 'work', upstream });
      const r = await u.update();
      assert.equal(r.code, 1, JSON.stringify(upstream));
      assert.equal(
        r.stderr,
        'skydeck: the branch work follows no branch of a remote; update it with git yourself\n',
      );
      assert.deepEqual(u.trace(), ['rev-parse', 'symbolic-ref', 'for-each-ref']);
    }
  });

  test('6. a tracked file changed, staged or unmerged: the count and the first path (sanitised); no fetch', async (t) => {
    const u = updater(t, {
      status: ' M docs/\x1b[31mred\nname.md\0R  new.ts\0old.ts\0UU src/x.ts\0',
    });

    const r = await u.update();

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      'skydeck: this checkout has changes that are not committed (3 files, the first: docs/red name.md); commit or undo them first\n',
    );
    assert.deepEqual(u.trace(), ['rev-parse', 'symbolic-ref', 'for-each-ref', 'status']);
  });

  test('6. one changed file: "1 file"', async (t) => {
    const u = updater(t, { status: 'M  README.md\0' });

    const r = await u.update(['--check']);

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      'skydeck: this checkout has changes that are not committed (1 file, the first: README.md); commit or undo them first\n',
    );
  });

  test('7. the fetch fails: the line names the remote (a line break in its name harmless); nothing after the fetch', async (t) => {
    const u = updater(t, {
      fetch: 128,
      upstream: {
        ref: 'refs/remotes/up\nx/main',
        remote: 'up\nx\x1b]0;title\x07',
        short: 'up\nx/main',
      },
    });

    const r = await u.update();

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      "skydeck: git fetch from up x failed (git's own message is above); nothing was changed\n",
    );
    assert.deepEqual(u.trace(), [...BEFORE_FETCH, 'fetch']);
    const fetch = u.runner.interactiveCalls[0];
    assert.deepEqual(fetch?.args, [
      '-C',
      u.root,
      'fetch',
      '--quiet',
      '--',
      'up\nx\x1b]0;title\x07',
    ]);
  });

  test('7. a fetch ended by a signal (Ctrl+C) is a failed fetch', async (t) => {
    const u = updater(t, { fetch: null });

    const r = await u.update();

    assert.equal(r.code, 1);
    assert.match(r.stderr, /^skydeck: git fetch from origin failed /);
    assert.deepEqual(u.trace(), [...BEFORE_FETCH, 'fetch']);
  });

  test('8. ahead of the upstream, or diverged: the count of its own commits; no merge', async (t) => {
    for (const ahead of [1, 3]) {
      const u = updater(t, { ancestor: false, ahead });
      const r = await u.update();
      assert.equal(r.code, 1);
      assert.equal(r.stdout, '');
      assert.equal(
        r.stderr,
        `skydeck: this checkout has ${ahead === 1 ? '1 commit' : '3 commits'} that origin/main does not have; update it with git yourself\n`,
      );
      assert.deepEqual(u.trace(), [
        ...BEFORE_FETCH,
        'fetch',
        'rev-parse',
        'merge-base',
        'rev-list',
      ]);
    }
  });

  test('any other git call that fails: "git <sub-command> failed: <first line>; nothing was changed"', async (t) => {
    const cases: [Partial<ScriptedRepo>, string, string[]][] = [
      [
        {
          answers: {
            'symbolic-ref --quiet HEAD': {
              code: 128,
              stderr: '\nfatal: \x1b[1mbad\x1b[0m HEAD\nmore\n',
            },
          },
        },
        'skydeck: git symbolic-ref failed: fatal: bad HEAD; nothing was changed\n',
        ['rev-parse', 'symbolic-ref'],
      ],
      [
        { answers: { [`rev-list --count ${OLD}..${NEW}`]: { code: null, timedOut: true } } },
        'skydeck: git rev-list failed: no answer within 10 s; nothing was changed\n',
        [...BEFORE_FETCH, 'fetch', 'rev-parse', 'merge-base', 'rev-list'],
      ],
      [
        { answers: { [`merge-base --is-ancestor ${OLD} ${NEW}`]: { code: 128 } } },
        'skydeck: git merge-base failed: exit 128; nothing was changed\n',
        [...BEFORE_FETCH, 'fetch', 'rev-parse', 'merge-base'],
      ],
      [
        { fetched: 'not an id' },
        'skydeck: git rev-parse failed: its answer is not a commit id; nothing was changed\n',
        [...BEFORE_FETCH, 'fetch', 'rev-parse'],
      ],
    ];
    for (const [over, line, trace] of cases) {
      const u = updater(t, over);
      const r = await u.update();
      assert.equal(r.code, 1, line);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, line);
      assert.deepEqual(u.trace(), trace, line);
    }
  });

  test('every refusal before the merge leaves the database unopened and starts nothing', async (t) => {
    for (const over of [
      { toplevel: null },
      { branch: null },
      { status: ' M a\0' },
      { fetch: 1 },
      { ancestor: false, ahead: 2 },
    ] satisfies Partial<ScriptedRepo>[]) {
      const u = updater(t, over);
      const r = await u.update();
      assert.equal(r.code, 1, JSON.stringify(over));
      assert.ok(!existsSync(u.tp.places.dbPath), 'the database was not opened');
      assert.ok(!u.trace().includes('merge'));
      assert.deepEqual(
        u.runner.interactiveCalls.filter((c) => c.command !== 'git'),
        [],
        'no launcher',
      );
      assert.deepEqual(u.tp.processes.calls, []);
      assert.deepEqual(u.tp.processes.signals, []);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// U3: how git is run

describe('skydeck update: how git is run (U3)', () => {
  test('git -C <root> as an argument list, never a shell or another working directory; 10 s each, the merge 60 s; the fetch with the terminal and no timeout', async (t) => {
    const u = updater(t);

    const r = await u.update();

    assert.equal(r.code, 0, r.stderr);
    for (const call of u.runner.calls) {
      assert.equal(call.command, 'git');
      assert.deepEqual(call.args.slice(0, 2), ['-C', u.root]);
      assert.equal(call.options?.cwd, undefined, 'no chdir');
      const sub = subCommand(call, u.root);
      assert.equal(call.options?.timeoutMs, sub === 'merge' ? 60_000 : 10_000, sub);
    }
    assert.deepEqual(
      u.runner.calls.map((c) => c.args.slice(2)),
      [
        ['rev-parse', '--show-toplevel'],
        ['symbolic-ref', '--quiet', 'HEAD'],
        [
          'for-each-ref',
          '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:short)%00',
          'refs/heads/main',
        ],
        ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=no'],
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
        ['merge-base', '--is-ancestor', OLD, NEW],
        ['rev-list', '--count', `${OLD}..${NEW}`],
        [
          'log',
          '--no-show-signature',
          '--no-color',
          '--encoding=UTF-8',
          '-z',
          '--max-count=20',
          '--format=%H%x00%s',
          `${OLD}..${NEW}`,
          '--',
        ],
        ['ls-tree', '--full-tree', '-z', OLD, '--', 'src/store/migrations.ts'],
        ['ls-tree', '--full-tree', '-z', NEW, '--', 'src/store/migrations.ts'],
        ['merge', '--ff-only', NEW],
      ],
    );
    const [fetch] = u.runner.interactiveCalls;
    assert.deepEqual(fetch?.args, ['-C', u.root, 'fetch', '--quiet', '--', 'origin']);
    assert.equal(fetch?.options?.cwd, undefined);
  });

  test("git's environment is the command's without the variables that point git at another repository", async (t) => {
    const pointing = {
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
      GIT_COMMON_DIR: '/elsewhere/common',
      GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/alt',
      GIT_NAMESPACE: 'other',
      GIT_CONFIG: '/elsewhere/config',
      GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
      GIT_CONFIG_COUNT: '1',
      GIT_IMPLICIT_WORK_TREE: '0',
      GIT_GRAFT_FILE: '/elsewhere/grafts',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_REPLACE_REF_BASE: 'refs/other/',
      GIT_PREFIX: 'sub/',
      GIT_SHALLOW_FILE: '/elsewhere/shallow',
    };
    const u = updater(t, {}, { ...pointing, LANG: 'C.UTF-8', GIT_SSH_COMMAND: 'ssh -4' });

    const r = await u.update();

    assert.equal(r.code, 0, r.stderr);
    const gitCalls = [
      ...u.runner.calls,
      ...u.runner.interactiveCalls.filter((c) => c.command === 'git'),
    ];
    assert.ok(gitCalls.length > 10);
    for (const call of gitCalls) {
      const env = call.options?.env;
      assert.ok(env !== undefined, 'the whole environment is given');
      for (const name of Object.keys(pointing)) {
        assert.equal(env[name], undefined, `${name} in ${subCommand(call, u.root)}`);
      }
      assert.equal(env.LANG, 'C.UTF-8', "the rest is the command's own");
      assert.equal(env.GIT_SSH_COMMAND, 'ssh -4');
      assert.equal(env.HOME, u.tp.sandbox.home);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// U4: what it reports

describe('skydeck update: what it reports (U4)', () => {
  test('up to date: one line, exit 0 — no server looked at, the database not opened, nothing merged', async (t) => {
    const u = updater(t, { fetched: OLD });

    for (const args of [[], ['--check']]) {
      const r = await u.update(args);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'skydeck is up to date (main at 0123456, as origin/main)\n');
      assert.equal(r.stderr, '');
    }
    assert.deepEqual(u.trace(), [
      ...BEFORE_FETCH,
      'fetch',
      'rev-parse',
      ...BEFORE_FETCH,
      'fetch',
      'rev-parse',
    ]);
    assert.ok(!existsSync(u.tp.places.dbPath), 'the database was not opened');
    assert.deepEqual(
      u.runner.interactiveCalls.filter((c) => c.command !== 'git'),
      [],
    );
  });

  test('--check, one new commit: the report and "run skydeck update to apply it" — nothing merged, the database not opened', async (t) => {
    const u = updater(t);

    const r = await u.update(['--check']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}run skydeck update to apply it\n`);
    assert.equal(r.stderr, '');
    assert.deepEqual(u.trace(), [...BEFORE_FETCH, 'fetch', ...LOOK]);
    assert.ok(!existsSync(u.tp.places.dbPath));
  });

  test('21 new commits: newest first, the first 20, then "… and 1 more"', async (t) => {
    const commits = Array.from({ length: 21 }, (_, i) => ({
      id: commitId(21 - i),
      subject: `commit ${21 - i}`,
    }));
    const u = updater(t, { behind: 21, commits, fetched: commitId(21) });

    const r = await u.update(['--check']);

    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], '21 new commits on origin/main (0123456..0000015):');
    assert.deepEqual(
      lines.slice(1, 21),
      Array.from({ length: 20 }, (_, i) => `  ${commitId(21 - i).slice(0, 7)}  commit ${21 - i}`),
    );
    assert.equal(lines[21], '  … and 1 more');
    assert.equal(lines[22], 'run skydeck update to apply it');
    assert.equal(lines.length, 24);
  });

  test('20 new commits: all of them, no "more" line', async (t) => {
    const commits = Array.from({ length: 20 }, (_, i) => ({ id: commitId(20 - i), subject: 's' }));
    const u = updater(t, { behind: 20, commits, fetched: commitId(20) });

    const r = await u.update(['--check']);

    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('more'));
    assert.equal(r.stdout.split('\n').length, 23);
  });

  test('a subject with an escape sequence, a line break and a bidirectional control comes out harmless', async (t) => {
    const u = updater(t, {
      commits: [{ id: NEW, subject: 'fix \x1b[2J\x1b]8;;http://x\x07link\r\nnext ‮evil' }],
    });

    const r = await u.update(['--check']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      `1 new commit on origin/main (0123456..fedcba9):\n  fedcba9  fix link  next evil\nrun skydeck update to apply it\n`,
    );
  });

  test('the database line: when src/store/migrations.ts differs between HEAD and the new commit, or is gone — not when it is the same', async (t) => {
    const DB =
      "this update changes the database's upgrade steps: it may upgrade the database, and an upgraded database cannot be opened by an older checkout\n";
    const cases: [string, Record<string, string>, boolean][] = [
      [
        'changed',
        { [OLD]: migrationsEntry('1'.repeat(40)), [NEW]: migrationsEntry('2'.repeat(40)) },
        true,
      ],
      ['gone', { [OLD]: migrationsEntry('1'.repeat(40)), [NEW]: '' }, true],
      ['added', { [OLD]: '', [NEW]: migrationsEntry('2'.repeat(40)) }, true],
      [
        'the same',
        { [OLD]: migrationsEntry('1'.repeat(40)), [NEW]: migrationsEntry('1'.repeat(40)) },
        false,
      ],
    ];
    for (const [name, migrations, said] of cases) {
      const u = updater(t, { migrations });
      const r = await u.update(['--check']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(
        r.stdout,
        `${ONE_COMMIT}${said ? DB : ''}run skydeck update to apply it\n`,
        name,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// U5 with no window server (the cases with one: update-server.test.ts)

describe('skydeck update: applying, no window server (U5)', () => {
  test('the fetched commit merged by its id, "updated to", exit 0; nothing started', async (t) => {
    const u = updater(t);

    const r = await u.update();

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.equal(r.stderr, '');
    assert.deepEqual(u.trace(), [...BEFORE_FETCH, 'fetch', ...LOOK, 'merge']);
    assert.deepEqual(
      u.runner.interactiveCalls.filter((c) => c.command !== 'git'),
      [],
    );
    assert.deepEqual(u.tp.processes.calls, []);
  });

  test('the merge fails: HEAD and status show the checkout as it was — exit 1 and the line; nothing started', async (t) => {
    const u = updater(t, {
      merge: {
        code: 1,
        stderr:
          'error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt\nPlease move or remove them before you merge.\nAborting\n',
      },
    });

    const r = await u.update();

    assert.equal(r.code, 1);
    assert.equal(r.stdout, ONE_COMMIT);
    assert.equal(
      r.stderr,
      'skydeck: the update could not be applied: error: The following untracked working tree files would be overwritten by merge:; the checkout is as it was\n',
    );
    assert.deepEqual(u.trace(), [
      ...BEFORE_FETCH,
      'fetch',
      ...LOOK,
      'merge',
      'rev-parse',
      'status',
    ]);
    assert.deepEqual(
      u.runner.interactiveCalls.filter((c) => c.command !== 'git'),
      [],
    );
  });

  test('the merge fails and the checkout is not as it was (HEAD moved, or files changed, or it cannot be told): no window started, the line says so', async (t) => {
    for (const afterFailedMerge of [
      { head: NEW, status: '' },
      { head: OLD, status: ' M src/a.ts\0' },
      { head: 'not an id', status: '' },
    ]) {
      const u = updater(t, {
        merge: { code: 128, stderr: 'fatal: cannot write\n' },
        afterFailedMerge,
      });
      const r = await u.update();
      assert.equal(r.code, 1);
      assert.equal(
        r.stderr,
        'skydeck: the update could not be applied: fatal: cannot write; the checkout may not be as it was: look at it with git status, then run skydeck window\n',
        JSON.stringify(afterFailedMerge),
      );
    }
  });
});

describe('skydeck update: the 60 s of the merge (ruled by the plan owner)', () => {
  test('a merge the timeout ended is named, and the checkout looked at as after any failure', async (t) => {
    for (const [afterFailedMerge, end] of [
      [{ head: OLD, status: '' }, 'the checkout is as it was'],
      [
        { head: NEW, status: '' },
        'the checkout may not be as it was: look at it with git status, then run skydeck window',
      ],
    ] as const) {
      const u = updater(t, { merge: { code: null, timedOut: true }, afterFailedMerge });
      const r = await u.update();
      assert.equal(r.code, 1);
      assert.equal(r.stdout, ONE_COMMIT);
      assert.equal(
        r.stderr,
        `skydeck: the update could not be applied: git merge timed out; ${end}\n`,
      );
      const trace = u.trace();
      assert.deepEqual(trace.slice(trace.indexOf('merge'), trace.indexOf('merge') + 2), [
        'merge',
        'rev-parse',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The database at step 1 (ruled by the plan owner)

/** Writes a database one schema version newer than this skydeck knows, where the sandbox has it. */
function newerDatabase(tp: TestPlatform): void {
  mkdirSync(tp.places.dataDir, { recursive: true });
  const store = openStore(tp.places.dbPath);
  store.setKv('schema_version', String(SCHEMA_VERSION + 1));
  store.close();
}

describe('skydeck update: the database at step 1 (ruled by the plan owner)', () => {
  test('written by a newer skydeck: the line, no server asked, stopped or started — merged, "updated to", exit 0', async (t) => {
    const u = updater(t);
    newerDatabase(u.tp);
    const asked: string[] = [];
    const net: Net = {
      ...u.platform.net,
      requestUnix(path, request) {
        asked.push(`${request.method} ${request.path}`);
        return u.platform.net.requestUnix(path, request);
      },
    };

    const r = await runUpdate({ ...u.platform, net }, u.tp.sandbox);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.equal(
      r.stderr,
      "skydeck: the database was written by a newer skydeck, so the window's server is not looked at; it is left as it is\n",
    );
    assert.deepEqual(u.trace(), [...BEFORE_FETCH, 'fetch', ...LOOK, 'merge']);
    assert.deepEqual(asked, []);
    assert.deepEqual(
      u.runner.interactiveCalls.filter((c) => c.command !== 'git'),
      [],
    );
    assert.deepEqual(u.tp.processes.calls, []);
    assert.deepEqual(u.tp.processes.signals, []);
  });

  test('one that cannot be opened (a directory in its place): "nothing was changed", no merge', async (t) => {
    const u = updater(t);
    mkdirSync(u.tp.places.dbPath, { recursive: true });

    const r = await u.update();

    assert.equal(r.code, 1);
    assert.equal(r.stdout, ONE_COMMIT);
    assert.match(
      r.stderr,
      new RegExp(
        `^skydeck: cannot open the database ${u.tp.places.dbPath}: .+; nothing was changed\n$`,
      ),
    );
    assert.ok(!u.trace().includes('merge'));
  });

  test('every other command says for a newer database what it said before: the same line, exit 1', async (t) => {
    const tp = testPlatform(t);
    newerDatabase(tp);
    const line = `the database ${tp.places.dbPath} was written by a newer skydeck (schema version ${SCHEMA_VERSION + 1}, this one knows ${SCHEMA_VERSION}); update skydeck`;
    for (const argv of [
      [],
      ['ls'],
      ['show', 'abcd'],
      ['label', 'abcd', 'x'],
      ['group', 'abcd', 'x'],
      ['note', 'abcd', '--set', 'x'],
      ['done', 'abcd'],
      ['undone', 'abcd'],
      ['pr', 'refresh'],
      ['new'],
      ['resume', 'abcd'],
      ['restore', '--dry-run'],
      ['window'],
      ['uninstall'],
    ]) {
      const r = await run(tp.platform, argv);
      assert.equal(r.code, 1, argv.join(' '));
      assert.equal(r.stdout, '', argv.join(' '));
      assert.equal(r.stderr, `skydeck: ${line}\n`, argv.join(' '));
    }
    const doctor = await run(tp.platform, ['doctor']);
    assert.equal(doctor.code, 1);
    assert.ok(
      doctor.stdout.startsWith(
        `problem  database ${tp.places.dbPath} cannot be opened (${line}); the checks that need it are skipped\n`,
      ),
      doctor.stdout,
    );
    // The type that tells it apart for skydeck update keeps the name a reader prints.
    assert.throws(
      () => openStore(tp.places.dbPath),
      (error: unknown) =>
        error instanceof DatabaseNewerError &&
        error instanceof SkydeckError &&
        error.name === 'SkydeckError' &&
        error.exitCode === 1 &&
        error.message === line,
    );
  });
});
