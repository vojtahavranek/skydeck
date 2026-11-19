// `skydeck doctor`'s first three lines (follow-up F20): skydeck's version line, the version Claude
// Code says it is, and the system. Each is `info`, before every other line, never a problem, and
// none changes the exit code. git is never run for real here (a fake answers it; the version line
// itself is test/cli/version.test.ts's); the program `claudeCommand` names is the stand-in, or a
// script in the sandbox's bin, never the real `claude`.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import pkg from '../../../package.json' with { type: 'json' };
import type { Platform, RunResult, Runner } from '../../../src/platform/types.ts';
import { claudeFolders, run } from '../../helpers/install.ts';
import type { Run } from '../../helpers/install.ts';
import { fakeRunner, realTestPlatform, runResult, testPlatform } from '../../helpers/platform.ts';
import type { FakeRunner, TestPlatform } from '../../helpers/platform.ts';
import { standinCommand } from '../../helpers/standin.ts';

const ID = `f1fce49${'0'.repeat(33)}`;
const SKYDECK = `info     skydeck ${pkg.version} (f1fce49, 2026-11-19)`;
const OS_RELEASE = '/etc/os-release';
const UBUNTU = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n';
const WSL_KERNEL = '6.6.87.2-microsoft-standard-WSL2';
const SYSTEM = 'info     system: Ubuntu 24.04.1 LTS, Linux 6.6.87.2-microsoft-standard-WSL2';

/** A machine with Claude Code's folders and skydeck installed; the stand-in may run in it. */
async function installedMachine(t: TestContext): Promise<TestPlatform> {
  const d = testPlatform(t, { env: (s) => ({ STANDIN_RECORD: join(s.root, 'standin.jsonl') }) });
  claudeFolders(d.places);
  const r = await run(d.platform, ['install'], { lines: ['y'] });
  assert.equal(r.code, 0, r.stderr);
  return d;
}

/** What the system line reads: /etc/os-release (an Error is thrown) and the kernel release. */
interface System {
  osRelease?: string | null | Error;
  kernel?: string | null;
}

/** The files and /proc of `d`, but for what `system` says (null: cannot be read). */
function systemParts(d: TestPlatform, system: System = {}): Pick<Platform, 'files' | 'proc'> {
  const { files, proc } = d.platform;
  return {
    files: {
      ...files,
      readText(path) {
        if (path !== OS_RELEASE) return files.readText(path);
        if (system.osRelease instanceof Error) throw system.osRelease;
        return system.osRelease === undefined ? UBUNTU : system.osRelease;
      },
    },
    proc: {
      ...proc,
      kernelRelease: () => (system.kernel === undefined ? WSL_KERNEL : system.kernel),
    },
  };
}

interface DoctorRun extends Run {
  lines: string[];
  problems: string[];
  runner: FakeRunner;
}

/**
 * doctor with a runner that starts what lies in the sandbox's bin (the stand-in, a script) for
 * real and answers everything else: git with commit ID of 2026-11-19 and nothing changed, every
 * other program with exit 0, unless `answers` (keyed by the command line) says otherwise.
 */
async function doctor(
  t: TestContext,
  d: TestPlatform,
  options: {
    answers?: Record<string, Partial<RunResult>>;
    system?: System;
    platform?: Partial<Platform>;
  } = {},
): Promise<DoctorRun> {
  const real: Runner = realTestPlatform(t).runner;
  const answers = options.answers ?? {};
  const runner = fakeRunner((call) => {
    if (call.command.startsWith(`${d.sandbox.bin}/`)) {
      return real.run(call.command, call.args, call.options);
    }
    // git's two calls can be answered as `git log` and `git status`.
    const gitKey =
      call.command === 'git' ? `git ${call.args.includes('log') ? 'log' : 'status'}` : '';
    const answer = answers[[call.command, ...call.args].join(' ')] ?? answers[gitKey];
    if (answer !== undefined) return runResult(answer);
    if (call.command === 'git' && call.args.includes('log')) {
      return runResult({ stdout: `${ID} 2026-11-19\n` });
    }
    return runResult({});
  });
  const r = await run(
    { ...d.platform, runner, ...systemParts(d, options.system), ...options.platform },
    ['doctor'],
  );
  const lines = r.stdout.split('\n').filter((line) => line !== '');
  return { ...r, lines, problems: lines.filter((line) => line.startsWith('problem  ')), runner };
}

/** `claudeCommand` set in config.json. */
function claudeCommand(d: TestPlatform, command: string): void {
  writeFileSync(d.places.configPath, JSON.stringify({ claudeCommand: command }));
}

/** A program in the sandbox's bin; `sh` and the programs it names are linked there. */
function program(d: TestPlatform, name: string, body: string, links: string[] = []): string {
  d.sandbox.link('sh', ...links);
  const path = join(d.sandbox.bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

/** The three lines, and that they came first, were info and changed nothing of the exit code. */
function firstThree(r: DoctorRun, exit = 0): string[] {
  assert.equal(r.code, exit, r.stdout + r.stderr);
  assert.equal(r.stderr, '');
  const three = r.lines.slice(0, 3);
  for (const line of three) {
    assert.match(line, /^info {5}\S/, r.stdout);
  }
  return three;
}

describe('doctor: the three lines at the top (follow-up F20)', () => {
  test('skydeck, Claude Code (the stand-in), the system: first, in this order, each info; exit 0', async (t) => {
    const d = await installedMachine(t);
    const standin = standinCommand(d.sandbox);
    claudeCommand(d, standin);

    const r = await doctor(t, d);

    assert.deepEqual(firstThree(r), [SKYDECK, 'info     Claude Code 0.0.0-standin', SYSTEM]);
    assert.match(r.lines[3] ?? '', /^ok {7}hook entries present in /);
    assert.deepEqual(r.problems, []);
    // The program was started once, with --version alone, stdin closed, 5 s, 4 KiB kept, in
    // doctor's own environment.
    const started = r.runner.calls.filter((call) => call.command === standin);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.args, ['--version']);
    assert.equal(started[0]?.options?.input, undefined);
    assert.equal(started[0]?.options?.timeoutMs, 5000);
    assert.equal(started[0]?.options?.maxOutputBytes, 4096);
    assert.equal(started[0]?.options?.env?.['HOME'], d.sandbox.home);
  });

  test('the skydeck line: modified, and commit unknown', async (t) => {
    const d = await installedMachine(t);

    const modified = await doctor(t, d, { answers: { 'git status': { stdout: ' M x.ts\0' } } });
    assert.equal(firstThree(modified)[0], `${SKYDECK.slice(0, -1)}, modified)`);

    const unknown = await doctor(t, d, { answers: { 'git log': { code: null, notFound: true } } });
    assert.equal(firstThree(unknown)[0], `info     skydeck ${pkg.version} (commit unknown)`);
  });

  test('before every other line: a configuration that cannot be read, then its problem; nothing started for Claude Code', async (t) => {
    const d = await installedMachine(t);
    writeFileSync(d.places.configPath, '{"nope":1}');

    const r = await doctor(t, d);

    assert.deepEqual(firstThree(r, 1), [
      SKYDECK,
      'info     Claude Code: version not read (the configuration cannot be read)',
      SYSTEM,
    ]);
    assert.match(r.lines[3] ?? '', /^problem {2}configuration: .*unknown key "nope"/);
    assert.equal(r.problems.length, 1, r.stdout);
    assert.deepEqual(
      r.runner.calls.filter((call) => !['git', 'gh', 'python3'].includes(call.command)),
      [],
    );
  });

  test('before every other line: with nothing installed, the missing database comes after them; exit 1 as before', async (t) => {
    const d = testPlatform(t);
    claudeFolders(d.places);

    const r = await doctor(t, d, {
      answers: { 'claude --version': { stdout: '2.1.0 (Claude Code)\n' } },
    });

    assert.deepEqual(firstThree(r, 1), [SKYDECK, 'info     Claude Code 2.1.0', SYSTEM]);
    assert.match(r.lines[3] ?? '', /^problem {2}database .* does not exist; run skydeck install$/);
  });

  test('a real problem elsewhere still makes the exit code 1, and the three lines are not among the problems', async (t) => {
    const d = await installedMachine(t);
    claudeCommand(d, join(d.sandbox.bin, 'no-such-claude'));

    const r = await doctor(t, d, { answers: { 'gh --version': { code: null, notFound: true } } });

    firstThree(r, 1);
    assert.deepEqual(r.problems, ['problem  gh is not installed: pull requests cannot be read']);
  });
});

describe('doctor: the Claude Code line (follow-up F20)', () => {
  test("its environment is doctor's without the launcher's own variables (S2 5.2, 7.4); a compile cache of the user's stays", async (t) => {
    for (const [cache, kept] of [
      ['/sandbox-cache/skydeck', undefined],
      ['/my/own/cache', '/my/own/cache'],
    ] as const) {
      const d = testPlatform(t, {
        env: {
          SKYDECK_HANDOFF: '/tmp/skydeck-handoff.x',
          SKYDECK_LAUNCHER_CACHE: '/sandbox-cache/skydeck',
          NODE_COMPILE_CACHE: cache,
          KEPT_VARIABLE: 'kept',
        },
      });
      claudeFolders(d.places);
      assert.equal((await run(d.platform, ['install'], { lines: ['y'] })).code, 0);

      const r = await doctor(t, d, { answers: { 'claude --version': { stdout: '2.1.0\n' } } });

      const env = r.runner.calls.find((call) => call.command === 'claude')?.options?.env ?? {};
      assert.equal(env['SKYDECK_HANDOFF'], undefined, cache);
      assert.equal(env['SKYDECK_LAUNCHER_CACHE'], undefined, cache);
      assert.equal(env['NODE_COMPILE_CACHE'], kept, cache);
      assert.equal(env['KEPT_VARIABLE'], 'kept', cache);
      assert.equal(env['HOME'], d.sandbox.home, cache);
    }
  });

  /** doctor on an installed machine whose claudeCommand is `command`; the line, and exit 0. */
  async function claudeLine(
    t: TestContext,
    setUp: (d: TestPlatform) => string,
    answers: Record<string, Partial<RunResult>> = {},
  ): Promise<{ line: string; r: DoctorRun; d: TestPlatform }> {
    const d = await installedMachine(t);
    claudeCommand(d, setUp(d));
    const r = await doctor(t, d, { answers });
    const line = firstThree(r)[1] ?? '';
    assert.deepEqual(r.problems, [], r.stdout);
    // The program's path is not shown (it can hold a user name).
    for (const shown of r.lines.slice(0, 3)) {
      assert.ok(!shown.includes(d.sandbox.root), shown);
    }
    return { line, r, d };
  }

  test('a claudeCommand that is not there: "not installed"', async (t) => {
    const { line } = await claudeLine(t, (d) => join(d.sandbox.bin, 'no-such-claude'));
    assert.equal(line, 'info     Claude Code: version not read (not installed)');
  });

  test('the default claude, not on PATH: "not installed"', async (t) => {
    const { line, r } = await claudeLine(t, () => 'claude', {
      'claude --version': { code: null, notFound: true },
    });
    assert.equal(line, 'info     Claude Code: version not read (not installed)');
    assert.ok(r.runner.calls.some((call) => call.command === 'claude'));
  });

  test('one that hangs: "timed out after 5 s", and doctor goes on after the 5 s', async (t) => {
    const started = performance.now();
    const { line, r } = await claudeLine(t, (d) =>
      program(d, 'claude', 'exec sleep 60', ['sleep']),
    );
    const took = performance.now() - started;

    assert.equal(line, 'info     Claude Code: version not read (timed out after 5 s)');
    assert.ok(took >= 4950, `doctor took ${took} ms`);
    assert.ok(took < 15_000, `doctor took ${took} ms`);
    assert.ok(
      r.lines.some((line) => line.startsWith('ok       gh is logged in')),
      r.stdout,
    );
  });

  test('one that exits 3: "exited 3", whatever it printed', async (t) => {
    const { line } = await claudeLine(t, (d) =>
      program(d, 'claude', 'echo "1.2.3 (Claude Code)"; echo "oops" >&2; exit 3'),
    );
    assert.equal(line, 'info     Claude Code: version not read (exited 3)');
  });

  test('one that a signal ends: "ended by a signal"', async (t) => {
    const { line } = await claudeLine(t, (d) => program(d, 'claude', 'kill -9 $$'));
    assert.equal(line, 'info     Claude Code: version not read (ended by a signal)');
  });

  test('one that prints nothing, or an empty first line: "printed no version"', async (t) => {
    for (const body of ['exit 0', `printf '\\n1.2.3\\n'`, `printf '\\033[31m\\033[0m  \\n'`]) {
      const { line } = await claudeLine(t, (d) => program(d, 'claude', body));
      assert.equal(line, 'info     Claude Code: version not read (printed no version)', body);
    }
  });

  test('one that cannot be started (not executable): "could not be started: EACCES"', async (t) => {
    const { line } = await claudeLine(t, (d) => {
      const path = join(d.sandbox.bin, 'claude');
      writeFileSync(path, '#!/bin/sh\necho 1.2.3\n', { mode: 0o644 });
      return path;
    });
    assert.equal(line, 'info     Claude Code: version not read (could not be started: EACCES)');
  });

  test('a long first line with control characters: they are dropped, the first 60 characters kept, the rest of the output not shown', async (t) => {
    const tail = 'x'.repeat(100);
    const { line, r } = await claudeLine(t, (d) =>
      program(
        d,
        'claude',
        `printf '\\033[31m1.2.3\\033[0m\\a (Claude\\tCode) \\033]0;title\\007${tail}\\r\\nsecond line\\n'`,
      ),
    );
    assert.equal(line, `info     Claude Code 1.2.3 (Claude Code) ${'x'.repeat(40)}`);
    assert.equal(line.length - 'info     Claude Code '.length, 60);
    assert.ok(!r.stdout.includes('second line'), r.stdout);
    assert.ok(!r.stdout.includes('title'), r.stdout);
  });

  // Ruled by the plan owner: Claude Code prints `<version> (Claude Code)`, and the line already
  // says whose version it is.
  test('a first line that ends with exactly " (Claude Code)": that part is dropped, after the cleaning, before the cut', async (t) => {
    const nines = '9'.repeat(70);
    const fifty = `2.1.5-${'a'.repeat(44)}`;
    for (const [body, shown] of [
      [`printf '  2.1.5 (Claude Code)  \\r\\n'`, '2.1.5'],
      [`printf '2.1.5\\t(Claude Code)\\n'`, '2.1.5'],
      [`printf '\\033[1m2.1.5 (Claude Code)\\033[0m\\n'`, '2.1.5'],
      [`printf '${nines} (Claude Code)\\n'`, '9'.repeat(60)],
      // 64 characters with the name: dropped before the cut, so all 50 are shown.
      [`printf '${fifty} (Claude Code)\\n'`, fifty],
    ] as const) {
      const { line } = await claudeLine(t, (d) => program(d, 'claude', body));
      assert.equal(line, `info     Claude Code ${shown}`, body);
    }
  });

  test('any other first line is shown as it is, cleaned and cut', async (t) => {
    for (const first of [
      '2.1.5 (claude code)',
      '2.1.5 (Claude Code) beta',
      '2.1.5 (Claude Code).',
      '2.1.5(Claude Code)',
      '(Claude Code)',
      'Claude Code 2.1.5',
    ]) {
      const { line } = await claudeLine(t, (d) =>
        program(d, 'claude', `printf '%s\\n' '${first}'`),
      );
      assert.equal(line, `info     Claude Code ${first}`, first);
    }
  });
});

describe('doctor: the system line (follow-up F20)', () => {
  async function systemLine(t: TestContext, system: System): Promise<string> {
    const d = await installedMachine(t);
    const r = await doctor(t, d, { system });
    assert.deepEqual(r.problems, [], r.stdout);
    return firstThree(r)[2] ?? '';
  }

  test('neither can be read: "unknown" for each part', async (t) => {
    assert.equal(
      await systemLine(t, { osRelease: null, kernel: null }),
      'info     system: unknown, Linux unknown',
    );
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    assert.equal(
      await systemLine(t, { osRelease: denied, kernel: '' }),
      'info     system: unknown, Linux unknown',
    );
  });

  test('PRETTY_NAME as os-release writes it: double quotes with escapes, single quotes, none; the last one counts', async (t) => {
    const cases: [string, string][] = [
      ['PRETTY_NAME="Debian GNU/Linux 12 \\"bookworm\\""\n', 'Debian GNU/Linux 12 "bookworm"'],
      [
        "PRETTY_NAME='Fedora Linux 41 (Workstation Edition)'\n",
        'Fedora Linux 41 (Workstation Edition)',
      ],
      ['PRETTY_NAME=Arch\n', 'Arch'],
      ['PRETTY_NAME="Old"\nPRETTY_NAME="New"\n', 'New'],
      ['# PRETTY_NAME="a comment"\nNAME="Plain"\n', 'unknown'],
      ['PRETTY_NAME=""\n', 'unknown'],
      ['PRETTY_NAME="Evil\x1b]0;title\x07 \x1b[31mOS\x1b[0m\t1"\n', 'Evil OS 1'],
    ];
    for (const [osRelease, name] of cases) {
      assert.equal(
        await systemLine(t, { osRelease }),
        `info     system: ${name}, Linux 6.6.87.2-microsoft-standard-WSL2`,
        osRelease,
      );
    }
  });

  test('the kernel release as the platform reads it (Proc.kernelRelease), cleaned', async (t) => {
    assert.equal(
      await systemLine(t, { kernel: '6.8.0-48-generic' }),
      'info     system: Ubuntu 24.04.1 LTS, Linux 6.8.0-48-generic',
    );
    assert.equal(
      await systemLine(t, { kernel: '6.8.0\x1b[2J-odd\x07' }),
      'info     system: Ubuntu 24.04.1 LTS, Linux 6.8.0-odd',
    );
  });

  test("on this machine: its own /etc/os-release is read (the kernel is the test platform's)", async (t) => {
    const d = await installedMachine(t);
    const r = await run({ ...d.platform }, ['doctor']);
    const line = r.stdout.split('\n')[2] ?? '';
    assert.match(line, /^info {5}system: \S.*, Linux 6\.6\.0-test$/);
  });
});
