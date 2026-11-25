// The window's fetch that never asks (F38; Git.fetchQuietly in src/update/git.ts): its call and
// environment on the fake runner, and with the real git on throwaway checkouts inside the sandbox
// (test/helpers/git-checkout.ts): a path remote, and an ssh remote whose `ssh` is a sandbox stub
// that connects nowhere. Nothing reaches the network.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform, RunOptions } from '../../src/platform/types.ts';
import {
  FETCH_GRACE_MS,
  FETCH_MS,
  FETCH_OUTPUT_BYTES,
  gitOn,
  quietEnv,
} from '../../src/update/git.ts';
import { gitCheckout, gitTestEnv } from '../helpers/git-checkout.ts';
import { realTestPlatform, runResult, testPlatform } from '../helpers/platform.ts';

describe('the quiet fetch on the fake runner', () => {
  test('its arguments and options: a session of its own, no input, the timeout, the grace, the cap, the signal', async (t) => {
    const tp = testPlatform(t);
    const root = join(tp.sandbox.root, 'checkout');
    const controller = new AbortController();

    const line = await gitOn(tp.platform, root).fetchQuietly('origin', {
      signal: controller.signal,
    });

    assert.equal(line, null);
    const [call] = tp.runner.calls;
    assert.ok(call !== undefined);
    assert.equal(call.command, 'git');
    assert.deepEqual(call.args, [
      '-C',
      root,
      '-c',
      'core.askPass=',
      'fetch',
      '--quiet',
      '--',
      'origin',
    ]);
    const { env, ...options } = call.options ?? {};
    assert.deepEqual(options, {
      newSession: true,
      timeoutMs: FETCH_MS,
      killGraceMs: FETCH_GRACE_MS,
      maxOutputBytes: FETCH_OUTPUT_BYTES,
      signal: controller.signal,
    });
    assert.equal(FETCH_MS, 60_000);
    assert.equal(FETCH_GRACE_MS, 2_000);
    assert.equal(FETCH_OUTPUT_BYTES, 16 * 1024);
    assert.equal(env?.GIT_TERMINAL_PROMPT, '0');
  });

  test('its environment: nothing can ask, and none of the repository variables', async (t) => {
    const tp = testPlatform(t, {
      env: {
        GIT_DIR: '/elsewhere/.git',
        GIT_WORK_TREE: '/elsewhere',
        GIT_CONFIG_PARAMETERS: "'core.askPass'='x'",
        GIT_NAMESPACE: 'n',
        SSH_ASKPASS: '/usr/bin/ssh-askpass',
        GIT_ASKPASS: '/usr/bin/askpass',
        GIT_SSH_COMMAND: 'ssh -i key',
      },
    });

    await gitOn(tp.platform, join(tp.sandbox.root, 'checkout')).fetchQuietly('origin');

    const env = tp.runner.calls[0]?.options?.env ?? {};
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_ASKPASS, '');
    // An ssh older than 8.4 ignores SSH_ASKPASS_REQUIRE: its askpass is a program that asks nothing.
    assert.equal(env.SSH_ASKPASS, '/bin/false');
    assert.equal(env.SSH_ASKPASS_REQUIRE, 'never');
    assert.equal(env.GCM_INTERACTIVE, 'never');
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_NAMESPACE']) {
      assert.equal(name in env, false, name);
    }
    assert.equal(env.GIT_SSH_COMMAND, 'ssh -i key'); // the owner's, as for git pull
    assert.equal(env.HOME, tp.sandbox.home);
  });

  test("with the stop's signal every call carries it with the grace, and none starts once it fired", async (t) => {
    const tp = testPlatform(t);
    const root = join(tp.sandbox.root, 'checkout');
    const controller = new AbortController();
    const git = gitOn(tp.platform, root, { signal: controller.signal });

    await git.run(['status']);
    await git.output(['rev-parse', 'HEAD']);
    assert.deepEqual(
      tp.runner.calls.map((call) => [call.options?.signal, call.options?.killGraceMs]),
      [
        [controller.signal, FETCH_GRACE_MS],
        [controller.signal, FETCH_GRACE_MS],
      ],
    );
    controller.abort();
    await assert.rejects(git.run(['status']), { name: 'AbortError' });
    await assert.rejects(git.fetchQuietly('origin'), { name: 'AbortError' });
    assert.equal(tp.runner.calls.length, 2, 'nothing started after the stop');
    // Without it (skydeck update) nothing of this is passed.
    await gitOn(tp.platform, root).run(['status']);
    assert.equal(tp.runner.calls.at(-1)?.options?.signal, undefined);
    assert.equal(tp.runner.calls.at(-1)?.options?.killGraceMs, undefined);
  });

  test('WSLENV gains GCM_INTERACTIVE once, what is there kept', () => {
    const wslenv = (value: string | undefined): string | undefined =>
      quietEnv(value === undefined ? {} : { WSLENV: value }).WSLENV;

    assert.equal(wslenv(undefined), 'GCM_INTERACTIVE');
    assert.equal(wslenv(''), 'GCM_INTERACTIVE');
    assert.equal(wslenv('A:B/p'), 'A:B/p:GCM_INTERACTIVE');
    assert.equal(wslenv('A:GCM_INTERACTIVE'), 'A:GCM_INTERACTIVE');
    assert.equal(wslenv('GCM_INTERACTIVE/u:B'), 'GCM_INTERACTIVE/u:B');
  });

  test('a fetch that fails: its line, git fetch from <remote> failed: <git first line>, clipped', async (t) => {
    const tp = testPlatform(t);
    const root = join(tp.sandbox.root, 'checkout');
    const answers = [
      runResult({ code: 128, stderr: 'fatal: could not read from remote repository\nmore\n' }),
      runResult({ code: null, timedOut: true }),
      runResult({ code: 1, stderr: `${'y'.repeat(1000)}\n` }),
    ];
    const platform: Platform = {
      ...tp.platform,
      runner: { ...tp.runner, run: () => Promise.resolve(answers.shift() ?? runResult({})) },
    };
    const git = gitOn(platform, root);

    assert.equal(
      await git.fetchQuietly('origin'),
      'git fetch from origin failed: fatal: could not read from remote repository',
    );
    assert.equal(
      await git.fetchQuietly('origin', { timeoutMs: 500 }),
      'git fetch from origin failed: no answer within 0.5 s',
    );
    const long = (await git.fetchQuietly('origin')) ?? '';
    assert.equal(long.length, 300);
    assert.ok(long.endsWith('…'));
  });
});

describe('Git.output: what a call may add to its run', () => {
  test("maxBytes, input and offline reach the runner; offline adds GIT_NO_LAZY_FETCH=1 to git's environment only for that call", async (t) => {
    const tp = testPlatform(t);
    const root = join(tp.sandbox.root, 'checkout');
    const calls: RunOptions[] = [];
    const platform: Platform = {
      ...tp.platform,
      runner: {
        ...tp.runner,
        run: (_command, _args, options = {}) => {
          calls.push(options);
          return Promise.resolve(runResult({ stdout: 'x' }));
        },
      },
    };
    const git = gitOn(platform, root);

    await git.output(['cat-file', 'blob', 'b'], { maxBytes: 8192, offline: true });
    await git.output(['cat-file', '--batch-check'], { input: 'a:b\n' });
    await git.output(['status']);

    assert.equal(calls[0]?.maxOutputBytes, 8192);
    assert.equal(calls[0]?.env?.['GIT_NO_LAZY_FETCH'], '1');
    assert.equal(calls[0]?.input, undefined);
    assert.equal(calls[1]?.input, 'a:b\n');
    assert.equal(calls[1]?.env?.['GIT_NO_LAZY_FETCH'], undefined);
    assert.equal(calls[2]?.maxOutputBytes, undefined);
    assert.equal(calls[2]?.env?.['GIT_NO_LAZY_FETCH'], undefined);
  });
});

/** The files under `dir` whose name ends with `.lock`, as paths relative to it. */
function locks(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.lock'));
}

describe('the quiet fetch with the real git', () => {
  test('a pushed commit arrives: the remote-tracking ref moves, HEAD and the files do not', async (t) => {
    const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
    const c = gitCheckout(tp.sandbox);
    const head = c.id();
    const pushed = c.push('the second commit', { 'README.md': 'two\n' });

    const line = await gitOn(tp.platform, c.root).fetchQuietly('origin');

    assert.equal(line, null);
    assert.equal(c.id('origin/main'), pushed);
    assert.equal(c.id(), head);
    assert.equal(readFileSync(join(c.root, 'README.md'), 'utf8'), 'one\n');
  });

  /**
   * A checkout whose remote is `ssh://stub.invalid/x` and whose ssh is a sandbox script: it records
   * its environment and whether it can open /dev/tty, writes its pid, then sleeps (it connects
   * nowhere). The test ends it.
   */
  function sshRemote(t: TestContext): {
    platform: Platform;
    root: string;
    record: string;
    stubPid: () => number | null;
  } {
    const tp = realTestPlatform(t, {
      env: (s) => ({
        ...gitTestEnv(s),
        GIT_SSH: join(s.root, 'ssh-stub'),
        GIT_SSH_VARIANT: 'simple',
      }),
    });
    const s = tp.sandbox;
    s.link('env');
    const c = gitCheckout(s);
    c.git(c.root, 'remote', 'set-url', 'origin', 'ssh://stub.invalid/x');
    const record = join(s.root, 'ssh-record');
    const pidFile = join(s.root, 'ssh-pid');
    writeFileSync(
      join(s.root, 'ssh-stub'),
      [
        '#!/bin/sh',
        `echo $$ > '${pidFile}'`,
        `env > '${record}'`,
        `if (exec 3</dev/tty) 2>/dev/null; then echo 'tty: open' >> '${record}'; else echo 'tty: none' >> '${record}'; fi`,
        'exec sleep 30',
        '',
      ].join('\n'),
    );
    chmodSync(join(s.root, 'ssh-stub'), 0o755);
    const stubPid = (): number | null =>
      existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null;
    t.after(() => {
      const pid = stubPid();
      if (pid !== null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
    return { platform: tp.platform, root: c.root, record, stubPid };
  }

  test('an ssh remote: no terminal, the switches there, a timeout ends it, and no lock is left', async (t) => {
    const r = sshRemote(t);

    const started = Date.now();
    const line = await gitOn(r.platform, r.root).fetchQuietly('origin', { timeoutMs: 500 });

    assert.equal(line, 'git fetch from origin failed: no answer within 0.5 s');
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    const recorded = readFileSync(r.record, 'utf8');
    assert.match(recorded, /^tty: none$/m);
    assert.match(recorded, /^GIT_TERMINAL_PROMPT=0$/m);
    assert.match(recorded, /^GIT_ASKPASS=$/m);
    assert.match(recorded, /^SSH_ASKPASS_REQUIRE=never$/m);
    assert.match(recorded, /^GCM_INTERACTIVE=never$/m);
    assert.match(recorded, /^SSH_ASKPASS=\/bin\/false$/m);
    assert.deepEqual(locks(join(r.root, '.git')), []);
  });

  test('an ssh remote, the fetch aborted: it rejects with an AbortError and no lock is left', async (t) => {
    const r = sshRemote(t);
    const controller = new AbortController();

    const running = gitOn(r.platform, r.root).fetchQuietly('origin', {
      signal: controller.signal,
    });
    const until = Date.now() + 5000;
    while (r.stubPid() === null && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(r.stubPid() !== null, 'the ssh stub did not start');
    controller.abort();

    await assert.rejects(running, { name: 'AbortError' });
    assert.deepEqual(locks(join(r.root, '.git')), []);
  });
});
