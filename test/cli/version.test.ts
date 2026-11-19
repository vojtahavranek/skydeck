// The version line (follow-up F20): what `skydeck --version` and `-V` print, and the first line of
// `skydeck doctor`. The real git runs only on throwaway repositories inside the sandbox
// (test/helpers/git-checkout.ts), and every app root is checked to lie inside the sandbox before
// it runs: never on this repository's own checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { main } from '../../src/cli/main.ts';
import { VERSION_GIT_MS, versionLine } from '../../src/cli/version.ts';
import pkg from '../../package.json' with { type: 'json' };
import type { Platform, Runner } from '../../src/platform/types.ts';
import { testContext, testContextOn } from '../helpers/context.ts';
import { gitCheckout, gitTestEnv, insideSandbox } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { fakeRunner, realTestPlatform, runResult, testPlatform } from '../helpers/platform.ts';
import type { RealTestPlatform } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const UNKNOWN = `${pkg.version} (commit unknown)\n`;

/** A real machine whose git sees no configuration of this one, and a throwaway checkout in it. */
function machine(t: TestContext): {
  tp: RealTestPlatform;
  checkout: GitCheckout;
  platform: Platform;
} {
  const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
  const checkout = gitCheckout(tp.sandbox);
  return { tp, checkout, platform: { ...tp.platform, appRoot: checkout.root } };
}

/** What the checkout's line should say: its short commit and the date of that commit. */
function expected(checkout: GitCheckout, extra = ''): string {
  const date = checkout.git(checkout.root, 'log', '-1', '--format=%cI').slice(0, 10);
  return `${pkg.version} (${checkout.id().slice(0, 7)}, ${date}${extra})\n`;
}

/**
 * `skydeck <flag>` through main on `platform`, once its app root is checked to lie inside the
 * sandbox: exit 0 and nothing on stderr in every case; returns what it printed.
 */
async function version(platform: Platform, s: Sandbox, flag = '--version'): Promise<string> {
  insideSandbox(s, platform.appRoot);
  const c = testContextOn({ platform });
  const code = await main([flag], c.ctx);
  assert.equal(code, 0, c.stderr());
  assert.equal(c.stderr(), '');
  return c.stdout();
}

/** Another checkout, at another commit, with a tracked file changed: what git must not look at. */
function changedElsewhere(s: Sandbox): GitCheckout {
  const elsewhere = gitCheckout(s, { name: 'elsewhere', content: { 'OTHER.md': 'there\n' } });
  writeFileSync(join(elsewhere.root, 'OTHER.md'), 'changed there\n');
  return elsewhere;
}

/** A program in the sandbox's bin. */
function script(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe('the version line: what the checkout is at', () => {
  for (const flag of ['--version', '-V']) {
    test(`${flag}: the package version, the short commit and the date of that commit`, async (t) => {
      const { tp, checkout, platform } = machine(t);

      const out = await version(platform, tp.sandbox, flag);

      assert.equal(out, expected(checkout));
      assert.match(out, /^\d+\.\d+\.\d+ \([0-9a-f]{7}, \d{4}-\d{2}-\d{2}\)\n$/);
    });
  }

  test('a tracked file changed or removed: ", modified"; an untracked file alone does not count', async (t) => {
    const { tp, checkout, platform } = machine(t);
    const s = tp.sandbox;

    writeFileSync(join(checkout.root, 'new-file.txt'), 'not tracked\n');
    assert.equal(await version(platform, s), expected(checkout));

    writeFileSync(join(checkout.root, 'README.md'), 'two\n');
    assert.equal(await version(platform, s), expected(checkout, ', modified'));

    checkout.git(checkout.root, 'checkout', '--quiet', '--', 'README.md');
    assert.equal(await version(platform, s), expected(checkout));

    checkout.git(checkout.root, 'rm', '--quiet', 'README.md');
    assert.equal(await version(platform, s), expected(checkout, ', modified'));
  });

  test('a new commit: the line follows it', async (t) => {
    const { tp, checkout, platform } = machine(t);
    const first = checkout.id();

    checkout.commit(checkout.root, 'the second commit', { 'two.txt': '2\n' });

    const out = await version(platform, tp.sandbox);
    assert.notEqual(checkout.id(), first);
    assert.equal(out, expected(checkout));
  });
});

describe('the version line: when git cannot say', () => {
  test('a folder that is not a git checkout: commit unknown', async (t) => {
    const { tp } = machine(t);
    const plain = join(tp.sandbox.root, 'plain');
    mkdirSync(plain);

    assert.equal(await version({ ...tp.platform, appRoot: plain }, tp.sandbox), UNKNOWN);
  });

  test('a folder inside a checkout that is not one itself: commit unknown, not the outer commit', async (t) => {
    const { tp, checkout } = machine(t);
    const inner = join(checkout.root, 'unpacked', 'skydeck');
    mkdirSync(inner, { recursive: true });

    assert.equal(await version({ ...tp.platform, appRoot: inner }, tp.sandbox), UNKNOWN);
  });

  test('no git on PATH: commit unknown', async (t) => {
    const { tp, platform } = machine(t);
    const empty = join(tp.sandbox.root, 'empty-bin');
    mkdirSync(empty);

    const out = await version({ ...platform, env: { ...platform.env, PATH: empty } }, tp.sandbox);

    assert.equal(out, UNKNOWN);
  });

  test('a git that does not answer: commit unknown once the limit has passed, not later', async (t) => {
    const tp = realTestPlatform(t);
    script(tp.sandbox.bin, 'git', 'exec sleep 60');
    const plain = join(tp.sandbox.root, 'plain');
    mkdirSync(plain);

    const started = performance.now();
    const out = await version({ ...tp.platform, appRoot: plain }, tp.sandbox);
    const took = performance.now() - started;

    assert.equal(out, UNKNOWN);
    assert.ok(took >= VERSION_GIT_MS - 50, `answered after ${took} ms`);
    // Both calls share the one limit (they run side by side), so the line takes about 2 s.
    assert.ok(took < 3 * VERSION_GIT_MS, `answered after ${took} ms`);
  });

  for (const [what, body] of [
    ['an answer that is not a commit', `echo 'not-a-commit 2026-11-19'`],
    ['a commit without its date', `echo '${'a'.repeat(40)}'`],
    ['a short commit', `echo 'abcdef1 2026-11-19'`],
    ['an answer with a second line', `printf '%s 2026-11-19\\nmore\\n' ${'a'.repeat(40)}`],
    ['a git that fails', `echo 'fatal: something' >&2; exit 128`],
  ] as const) {
    test(`${what}: commit unknown`, async (t) => {
      const tp = realTestPlatform(t);
      script(tp.sandbox.bin, 'git', body);
      const plain = join(tp.sandbox.root, 'plain');
      mkdirSync(plain);

      assert.equal(await version({ ...tp.platform, appRoot: plain }, tp.sandbox), UNKNOWN);
    });
  }

  test('the commit is read but whether files changed is not: commit unknown, never a clean claim', async (t) => {
    const { tp, platform } = machine(t);
    const runner: Runner = {
      ...tp.runner,
      run: (command, args, options) =>
        args.includes('status')
          ? Promise.resolve(runResult({ code: 128, stderr: 'fatal: index file corrupt\n' }))
          : tp.runner.run(command, args, options),
    };

    assert.equal(await version({ ...platform, runner }, tp.sandbox), UNKNOWN);
  });

  test('a git that cannot be started (EACCES): commit unknown', async (t) => {
    const tp = realTestPlatform(t);
    writeFileSync(join(tp.sandbox.bin, 'git'), '#!/bin/sh\necho no\n', { mode: 0o644 });
    const plain = join(tp.sandbox.root, 'plain');
    mkdirSync(plain);

    assert.equal(await version({ ...tp.platform, appRoot: plain }, tp.sandbox), UNKNOWN);
  });

  test('a platform whose every part fails: still the one line and exit 0', async () => {
    const c = testContext();

    const code = await main(['--version'], c.ctx);

    assert.equal(code, 0);
    assert.equal(c.stdout(), UNKNOWN);
    assert.equal(c.stderr(), '');
  });
});

describe('the version line: which repository git looks at', () => {
  test('run from inside another checkout: the checkout of the running code', async (t) => {
    const { tp, checkout, platform } = machine(t);
    const elsewhere = changedElsewhere(tp.sandbox);
    const runner: Runner = {
      ...tp.runner,
      run: (command, args, options = {}) =>
        tp.runner.run(command, args, { ...options, cwd: options.cwd ?? elsewhere.root }),
    };

    const out = await version(
      { ...platform, runner, cwd: elsewhere.root, env: { ...platform.env, PWD: elsewhere.root } },
      tp.sandbox,
    );

    assert.notEqual(elsewhere.id(), checkout.id());
    assert.equal(out, expected(checkout));
  });

  test('an environment that names another repository does not change the answer', async (t) => {
    const { tp, checkout, platform } = machine(t);
    const elsewhere = changedElsewhere(tp.sandbox);
    const git = join(elsewhere.root, '.git');
    const env = {
      ...platform.env,
      GIT_DIR: git,
      GIT_WORK_TREE: elsewhere.root,
      GIT_COMMON_DIR: git,
      GIT_INDEX_FILE: join(git, 'index'),
      GIT_OBJECT_DIRECTORY: join(git, 'objects'),
      GIT_CEILING_DIRECTORIES: '',
      GIT_NAMESPACE: 'other',
    };

    const out = await version({ ...platform, env }, tp.sandbox);

    assert.equal(out, expected(checkout));
  });

  test('nothing is written in the checkout, also when its index is out of date', async (t) => {
    const { tp, checkout, platform } = machine(t);
    const dotGit = join(checkout.root, '.git');
    /** Every entry under .git with its size and modification time, and the index's bytes. */
    const snapshot = (): string[] => [
      ...readdirSync(dotGit, { recursive: true })
        .map(String)
        .sort()
        .map((path) => {
          const info = statSync(join(dotGit, path), { bigint: true });
          return `${path} ${info.size} ${info.mtimeNs}`;
        }),
      `. ${statSync(dotGit, { bigint: true }).mtimeNs}`,
      readFileSync(join(dotGit, 'index')).toString('base64'),
    ];
    // The same content with another time: git compares the content and finds it unchanged, and
    // a git that may write would record the new time in the index.
    const past = Date.now() / 1000 - 3600;
    utimesSync(join(checkout.root, 'README.md'), past, past);
    const before = snapshot();

    const out = await version(platform, tp.sandbox);

    assert.equal(out, expected(checkout));
    assert.deepEqual(snapshot(), before);
    // The case is a real one: a plain `git status` does write the index here.
    checkout.git(checkout.root, 'status', '--porcelain');
    assert.notDeepEqual(snapshot(), before);
  });

  test('what it starts: at most two git calls on the app root, side by side, each within the limit, with no shell and no lock', async (t) => {
    const d = testPlatform(t, {
      env: { GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_INDEX_FILE: '/x' },
    });
    const appRoot = join(d.sandbox.root, 'checkout');
    const id = 'f1fce49' + '0'.repeat(33);
    const runner = fakeRunner((call) =>
      runResult(call.args.includes('log') ? { stdout: `${id} 2026-11-19\n` } : {}),
    );

    const line = await versionLine({ ...d.platform, appRoot, runner });

    assert.equal(line, `${pkg.version} (f1fce49, 2026-11-19)`);
    assert.deepEqual(
      runner.calls.map((call) => [call.command, ...call.args]),
      [
        [
          'git',
          '-C',
          appRoot,
          '--no-optional-locks',
          'log',
          '-1',
          '--no-show-signature',
          '--format=%H %cs',
          'HEAD',
          '--',
        ],
        [
          'git',
          '-C',
          appRoot,
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          'status',
          '--porcelain',
          '-z',
          '--untracked-files=no',
        ],
      ],
    );
    for (const { options } of runner.calls) {
      assert.equal(options?.timeoutMs, VERSION_GIT_MS);
      assert.equal(options?.input, undefined, 'stdin is /dev/null');
      assert.equal(options?.env?.['GIT_DIR'], undefined);
      assert.equal(options?.env?.['GIT_WORK_TREE'], undefined);
      assert.equal(options?.env?.['GIT_INDEX_FILE'], undefined);
      assert.equal(options?.env?.['GIT_OPTIONAL_LOCKS'], '0');
      // git looks for the repository in the app root and never above it.
      assert.equal(options?.env?.['GIT_CEILING_DIRECTORIES'], dirname(appRoot));
      assert.equal(options?.env?.['HOME'], d.sandbox.home);
    }
  });

  test('the two calls run side by side: both are started before either has answered', async (t) => {
    const d = testPlatform(t);
    const appRoot = join(d.sandbox.root, 'checkout');
    const id = 'f1fce49' + '0'.repeat(33);
    const answers: (() => void)[] = [];
    const runner = fakeRunner(
      (call) =>
        new Promise((resolve) => {
          answers.push(() => {
            resolve(runResult(call.args.includes('log') ? { stdout: `${id} 2026-11-19\n` } : {}));
          });
        }),
    );

    const line = versionLine({ ...d.platform, appRoot, runner });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(runner.calls.length, 2, 'both calls before any answer');
    for (const answer of answers) answer();
    assert.equal(await line, `${pkg.version} (f1fce49, 2026-11-19)`);
  });

  test('a tracked file changed (git status lists it): ", modified"', async (t) => {
    const d = testPlatform(t);
    const appRoot = join(d.sandbox.root, 'checkout');
    const id = 'f1fce49' + '0'.repeat(33);
    const runner = fakeRunner((call) =>
      runResult(
        call.args.includes('log')
          ? { stdout: `${id} 2026-11-19\n` }
          : { stdout: ' M src/cli/main.ts\0' },
      ),
    );

    const line = await versionLine({ ...d.platform, appRoot, runner });

    assert.equal(line, `${pkg.version} (f1fce49, 2026-11-19, modified)`);
  });
});

describe('the version line: bin/skydeck of a checkout', () => {
  /** A checkout holding skydeck itself, and the launcher's environment (its programs, git). */
  function skydeckCheckout(t: TestContext) {
    const s = sandbox(t);
    s.link('dirname', 'readlink', 'mktemp', 'cat', 'rm');
    const tmp = join(s.root, 'tmp');
    mkdirSync(tmp);
    const checkout = gitCheckout(s, { content: 'skydeck' });
    const elsewhere = gitCheckout(s, { name: 'elsewhere' });
    const env = { ...checkout.env, TMPDIR: tmp, SKYDECK_NODE: process.execPath };
    const launch = (args: string[]) => {
      insideSandbox(s, checkout.root);
      const r = spawnSync(join(checkout.root, 'bin', 'skydeck'), args, {
        cwd: elsewhere.root, // run from another checkout
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      // Node 24.12 warns once that node:sqlite is experimental, on every run; that is not ours.
      const stderr = r.stderr
        .split('\n')
        .filter((line) => line !== '' && !/ExperimentalWarning|--trace-warnings/.test(line))
        .join('\n');
      return { status: r.status, stdout: r.stdout, stderr };
    };
    return { checkout, elsewhere, launch };
  }

  test('the commit of the checkout the launcher is in, wherever it is run from; then modified', (t) => {
    const { checkout, elsewhere, launch } = skydeckCheckout(t);

    const clean = launch(['--version']);

    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stderr, '');
    assert.notEqual(elsewhere.id(), checkout.id());
    assert.equal(clean.stdout, expected(checkout));

    const manifest = join(checkout.root, 'vendor', 'MANIFEST.json');
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}\n`);
    const modified = launch(['-V']);

    assert.equal(modified.status, 0, modified.stderr);
    assert.equal(modified.stderr, '');
    assert.equal(modified.stdout, expected(checkout, ', modified'));
  });
});
