import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { command } from '../../../src/cli/commands/doctor.ts';
import { hookEntry } from '../../../src/claude/settings.ts';
import { NS_PER_DAY, NS_PER_SECOND } from '../../../src/platform/time.ts';
import type { Files, Ns, Platform, RunResult } from '../../../src/platform/types.ts';
import { claudeFolders, run, settingsFile, withStore } from '../../helpers/install.ts';
import type { Run } from '../../helpers/install.ts';
import { S1, SEC, T0, fakeRunner, runResult, testPlatform } from '../../helpers/platform.ts';
import type { FakeRunner, TestPlatform, TestPlatformOptions } from '../../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../../helpers/spool.ts';

const LIST = 'wezterm cli --no-auto-start list';

/** A machine with Claude Code's folders, one hook event in the spool, and skydeck installed. */
async function installedMachine(
  t: Parameters<typeof testPlatform>[0],
  options: TestPlatformOptions = {},
): Promise<TestPlatform> {
  const d = testPlatform(t, options);
  claudeFolders(d.places);
  mkdirSync(d.places.spoolDir, { recursive: true });
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid: 4242,
    input: hookInput('SessionStart', S1, { source: 'startup' }),
  };
  writeFileSync(join(d.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
  const r = await run(d.platform, ['install'], { lines: ['y'] });
  assert.equal(r.code, 0, r.stderr);
  return d;
}

interface DoctorRun extends Run {
  lines: string[];
  problems: string[];
  runner: FakeRunner;
}

/**
 * `skydeck doctor` with a runner that answers every program with exit 0 unless `answers` says
 * otherwise (keyed by the command line joined with spaces).
 */
async function doctor(
  d: TestPlatform,
  options: {
    answers?: Record<string, Partial<RunResult>>;
    platform?: Partial<Platform>;
  } = {},
): Promise<DoctorRun> {
  const answers = options.answers ?? {};
  const runner = fakeRunner((call) =>
    runResult(answers[[call.command, ...call.args].join(' ')] ?? {}),
  );
  const r = await run({ ...d.platform, runner, ...options.platform }, ['doctor']);
  const lines = r.stdout.split('\n').filter((line) => line !== '');
  return { ...r, lines, problems: lines.filter((line) => line.startsWith('problem  ')), runner };
}

/** The doctor found exactly the problems matching `pattern` (at least one) and nothing else. */
function onlyProblem(r: DoctorRun, pattern: RegExp): void {
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(r.problems.length > 0, r.stdout);
  for (const line of r.problems) {
    assert.match(line, pattern, r.stdout);
  }
}

const ageOf = (path: string, nowNs: Ns, ageNs: Ns): void => {
  const seconds = Number((nowNs - ageNs) / NS_PER_SECOND);
  utimesSync(path, seconds, seconds);
};

describe('doctor on a complete installation', () => {
  test('exit 0; every line is ok or info; the age of the last event is shown', async (t) => {
    const d = await installedMachine(t);

    const r = await doctor(d);

    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const line of r.lines) {
      assert.match(line, /^(ok {7}|info {5})\S/, line);
    }
    assert.ok(r.lines.includes('info     last event 20s ago'), r.stdout);
    assert.ok(r.lines.includes('info     hook.log is empty'), r.stdout);
    assert.ok(r.lines.includes('info     scripted runs dropped: 0'), r.stdout);
  });

  test('it asks gh for its version and login, and does not start a terminal', async (t) => {
    const d = await installedMachine(t);

    const r = await doctor(d);

    assert.deepEqual(
      r.runner.calls.map((call) => [call.command, ...call.args].join(' ')),
      ['gh --version', 'gh auth status'],
    );
  });

  test('it reads nothing in: a spool file stays where it is, and is counted', async (t) => {
    const d = await installedMachine(t);
    const fields = {
      event: 'SessionEnd' as const,
      timeNs: T0 - 5n * SEC,
      pid: 4242,
      input: hookInput('SessionEnd', S1, { reason: 'exit' }),
    };
    const file = join(d.places.spoolDir, spoolName(fields, 2));
    writeFileSync(file, spoolText(fields));

    const r = await doctor(d);

    assert.equal(r.code, 0, r.stdout);
    assert.ok(r.lines.includes('info     spool: 1 event waiting to be read'), r.stdout);
    assert.ok(r.lines.includes('info     last event 5s ago'), r.stdout);
    assert.equal(
      withStore(d.places, (store) => store.events().length),
      1,
    );
    assert.ok(existsSync(file));
  });

  test('before any event: "no events yet"', async (t) => {
    const d = testPlatform(t);
    claudeFolders(d.places);
    await run(d.platform, ['install'], { lines: ['y'] });

    const r = await doctor(d);

    assert.ok(r.lines.includes('info     no events yet'), r.stdout);
  });
});

describe('doctor: each problem alone', () => {
  test('no hook entries', async (t) => {
    const d = await installedMachine(t);
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');
    const r = await doctor(d);
    onlyProblem(r, /no (SessionStart|SessionEnd) hook entry/);
    assert.equal(r.problems.length, 2);
  });

  test('entries of an install with another hook path are not ours: both are reported missing', async (t) => {
    const d = await installedMachine(t);
    const other = join(d.sandbox.root, 'old-checkout', 'skydeck-hook');
    writeFileSync(
      settingsFile(d.places),
      JSON.stringify({
        hooks: {
          SessionStart: [hookEntry(other, 'SessionStart')],
          SessionEnd: [hookEntry(other, 'SessionEnd')],
        },
      }),
    );
    const r = await doctor(d);
    onlyProblem(r, /no (SessionStart|SessionEnd) hook entry for .*\/skydeck-hook in /);
    assert.equal(r.problems.length, 2);
  });

  test('the hook link does not resolve to a file', async (t) => {
    const d = await installedMachine(t);
    const temporary = join(d.sandbox.root, 'temporary-hook');
    writeFileSync(temporary, '#!/bin/sh\n');
    rmSync(d.places.hookPath);
    symlinkSync(temporary, d.places.hookPath);
    rmSync(temporary);
    const r = await doctor(d);
    onlyProblem(r, /skydeck-hook does not resolve to a file/);
  });

  test('a Node.js that is too old', async (t) => {
    const d = await installedMachine(t);
    const r = await doctor(d, { platform: { nodeVersion: '24.11.0' } });
    onlyProblem(r, /needs Node\.js 24\.12 or newer but found 24\.11\.0/);
  });

  test('a file in spool/bad/', async (t) => {
    const d = await installedMachine(t);
    mkdirSync(d.places.badDir, { recursive: true });
    writeFileSync(join(d.places.badDir, '1-0-1.ev'), 'v=2\n');
    const r = await doctor(d);
    onlyProblem(r, /spool\/bad/);
  });

  test('more than 1000 files in the spool', async (t) => {
    const d = await installedMachine(t);
    for (let i = 1; i <= 1001; i++) {
      writeFileSync(join(d.places.spoolDir, `${T0 - BigInt(i)}-0-${i}.ev`), '');
    }
    const r = await doctor(d);
    onlyProblem(r, /spool: 1001 events waiting to be read/);
  });

  test('gh is not installed', async (t) => {
    const d = await installedMachine(t);
    const r = await doctor(d, {
      answers: { 'gh --version': { code: null, notFound: true } },
    });
    onlyProblem(r, /gh is not installed/);
    assert.ok(!r.runner.calls.some((call) => call.args[0] === 'auth'));
  });

  test('gh is not logged in', async (t) => {
    const d = await installedMachine(t);
    const r = await doctor(d, {
      answers: {
        'gh auth status': { code: 1, stderr: 'You are not logged into any GitHub hosts.\n' },
      },
    });
    // gh's own first line can be just a host name; the exit code and a pointer say more.
    onlyProblem(
      r,
      /^problem {2}gh is not logged in, or GitHub cannot be reached \(gh auth status: exit 1\); run gh auth status to see why$/,
    );
  });

  test('the wezterm terminal does not answer', async (t) => {
    const d = await installedMachine(t);
    writeFileSync(d.places.configPath, '{"terminal":"wezterm"}');
    const r = await doctor(d, { answers: { [LIST]: { code: 1, stderr: 'no running wezterm\n' } } });
    onlyProblem(r, /wezterm/);
    assert.ok(r.runner.calls.some((call) => [call.command, ...call.args].join(' ') === LIST));
  });

  test('a symbolic link loop in the projects folder', async (t) => {
    const d = await installedMachine(t);
    const loop = join(d.places.claudeHome, 'projects', 'loop');
    symlinkSync(loop, loop);
    const r = await doctor(d);
    onlyProblem(r, /^problem {2}transcripts: cannot read .*\/projects\/loop \(ELOOP\)$/);
  });

  test('a database that cannot be written (another skydeck holds the write lock past the busy timeout)', async (t) => {
    const d = await installedMachine(t);
    const signal = new SharedArrayBuffer(4);
    const holder = new Worker(new URL('../../fixtures/hold-write-lock.ts', import.meta.url), {
      workerData: { path: d.places.dbPath, signal },
    });
    const release = async (): Promise<void> => {
      const flag = new Int32Array(signal);
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      await once(holder, 'exit');
    };
    try {
      await once(holder, 'message'); // locked
      const r = await doctor(d);
      onlyProblem(r, /^problem {2}database .* is not writable \(.*locked.*\)$/);
    } finally {
      await release();
    }
  });

  test('a sessions folder that cannot be read', async (t) => {
    const d = await installedMachine(t);
    const sessions = join(d.places.claudeHome, 'sessions');
    const files: Files = {
      ...d.platform.files,
      list(dir: string): string[] {
        if (dir === sessions) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return d.platform.files.list(dir);
      },
    };
    const r = await doctor(d, { platform: { files } });
    onlyProblem(r, /cannot read .*\/sessions \(EACCES\)/);
  });

  test('what the last refresh skipped, sanitised', async (t) => {
    const d = await installedMachine(t);
    withStore(d.places, (store) => {
      store.setKv('scan_problems', JSON.stringify(['cannot read /x/\x1b[31mred (EACCES)']));
      store.setKv('reconcile_problems', JSON.stringify(['process 7: Error: boom']));
    });
    const r = await doctor(d);
    onlyProblem(r, /^problem {2}last refresh: (scan|reconcile): /);
    assert.ok(
      r.lines.includes('problem  last refresh: scan: cannot read /x/red (EACCES)'),
      r.stdout,
    );
    assert.ok(
      r.lines.includes('problem  last refresh: reconcile: process 7: Error: boom'),
      r.stdout,
    );
  });
});

describe('doctor: information', () => {
  test('the last five lines of hook.log, not the ones before', async (t) => {
    const d = await installedMachine(t);
    const lines = [1, 2, 3, 4, 5, 6, 7].map((n) => `hook line ${n}`);
    writeFileSync(d.places.hookLog, `${lines.join('\n')}\n`);

    const r = await doctor(d);

    assert.equal(r.code, 0, r.stdout);
    for (const n of [3, 4, 5, 6, 7]) {
      assert.ok(r.lines.includes(`info     hook.log: hook line ${n}`), r.stdout);
    }
    assert.doesNotMatch(r.stdout, /hook line [12]\b/);
  });

  test('hook.log lines are sanitised', async (t) => {
    const d = await installedMachine(t);
    writeFileSync(d.places.hookLog, 'cannot write \x1b]0;title\x07spool\n');
    const r = await doctor(d);
    assert.ok(r.lines.includes('info     hook.log: cannot write spool'), r.stdout);
  });

  test('scripted runs dropped', async (t) => {
    const d = await installedMachine(t);
    withStore(d.places, (store) => store.setKv('dropped_scripted', '3'));
    const r = await doctor(d);
    assert.ok(r.lines.includes('info     scripted runs dropped: 3'), r.stdout);
  });

  test('files in spool/bad/: how many, their ages, and that they are removed after seven days', async (t) => {
    const d = await installedMachine(t);
    mkdirSync(d.places.badDir, { recursive: true });
    const young = join(d.places.badDir, '1-0-1.ev');
    const old = join(d.places.badDir, '1-0-2.ev');
    writeFileSync(young, '');
    writeFileSync(old, '');
    ageOf(young, T0, 3600n * SEC);
    ageOf(old, T0, 3n * NS_PER_DAY);

    const r = await doctor(d);

    assert.equal(r.problems.length, 1, r.stdout);
    assert.match(r.problems[0] ?? '', /spool\/bad: 2 files .*1h to 3d old.*seven days/);
  });

  test('Claude Code folders that do not exist yet are information, not problems', async (t) => {
    const d = testPlatform(t);
    await run(d.platform, ['install'], { lines: ['y'] });
    const r = await doctor(d);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(
      r.lines.some((line) => /^info {5}.*\/projects does not exist yet/.test(line)),
      r.stdout,
    );
    assert.ok(
      r.lines.some((line) => /^info {5}.*\/sessions does not exist yet/.test(line)),
      r.stdout,
    );
  });

  test('wezterm from WSL: wezterm.exe is asked when wezterm is not found', async (t) => {
    const d = await installedMachine(t, { env: { WSL_DISTRO_NAME: 'Ubuntu' } });
    writeFileSync(d.places.configPath, '{"terminal":"wezterm"}');
    const r = await doctor(d, { answers: { [LIST]: { code: null, notFound: true } } });
    assert.equal(r.code, 0, r.stdout);
    assert.ok(
      r.runner.calls.some(
        (call) => [call.command, ...call.args].join(' ') === 'wezterm.exe cli --no-auto-start list',
      ),
    );
  });
});

describe('doctor: robustness', () => {
  test('a config.json that is not valid: one problem line; the checks that do not need it still run', async (t) => {
    const d = await installedMachine(t);
    writeFileSync(d.places.configPath, '{"nope":1}');

    const r = await doctor(d);

    onlyProblem(r, /^problem {2}configuration: .*unknown key "nope"/);
    assert.equal(r.problems.length, 1);
    // claudeHome and the terminal come from the configuration: those checks are skipped.
    assert.ok(!r.lines.some((line) => /hook entries|transcripts:|terminal:/.test(line)), r.stdout);
    assert.ok(r.lines.includes('info     scripted runs dropped: 0'), r.stdout);
    assert.ok(r.lines.includes('ok       gh is logged in'), r.stdout);
  });

  test('a database that cannot be opened: one problem line; the checks that do not need it still run', async (t) => {
    const d = await installedMachine(t);
    writeFileSync(d.places.dbPath, 'not a database '.repeat(400));

    const r = await doctor(d);

    onlyProblem(r, /^problem {2}database .*skydeck\.db cannot be opened/);
    assert.equal(r.problems.length, 1);
    assert.ok(
      r.lines.some((line) => line.startsWith('ok       hook entries present')),
      r.stdout,
    );
    assert.ok(r.lines.includes('ok       gh is logged in'), r.stdout);
  });

  test('with nothing installed: the missing database is a problem, and doctor creates nothing', async (t) => {
    const d = testPlatform(t);
    claudeFolders(d.places);

    const r = await doctor(d);

    assert.equal(r.code, 1);
    assert.ok(
      r.problems.some((line) => /database .* does not exist; run skydeck install$/.test(line)),
      r.stdout,
    );
    assert.deepEqual(readdirSync(d.sandbox.skydeckHome), []);
  });

  test('a projects folder that is a symbolic link to nothing is a problem', async (t) => {
    const d = await installedMachine(t);
    const projects = join(d.places.claudeHome, 'projects');
    rmSync(projects, { recursive: true });
    symlinkSync('/mnt/not-mounted/claude-projects', projects);

    const r = await doctor(d);

    onlyProblem(r, /^problem {2}transcripts: cannot read .*\/projects \(ENOENT\)$/);
  });

  test('a check that fails unexpectedly is one problem line, and the checks after it still run', async (t) => {
    const d = await installedMachine(t);
    const settings = settingsFile(d.places);
    const files: Files = {
      ...d.platform.files,
      readText(path: string): string | null {
        if (path === settings) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return d.platform.files.readText(path);
      },
    };

    const r = await doctor(d, { platform: { files } });

    onlyProblem(r, /^problem {2}hook entries: could not be checked \(EACCES\)$/);
    assert.ok(
      r.lines.some((line) => line.startsWith('ok       terminal: here')),
      r.stdout,
    );
  });

  test('a long hook.log: only its end is read, and a line cut by that is not shown', async (t) => {
    const d = await installedMachine(t);
    // One line longer than what doctor reads, then three short ones: the read starts inside it.
    const long = `${'x'.repeat(40_000)}\n`;
    const last = [1, 2, 3].map((n) => `late line ${n}`);
    writeFileSync(d.places.hookLog, `${long}${last.join('\n')}\n`);

    const r = await doctor(d);

    const shown = r.lines.filter((line) => line.startsWith('info     hook.log: '));
    assert.deepEqual(
      shown,
      last.map((line) => `info     hook.log: ${line}`),
    );
  });

  test('the last event is the hook’s: an event reconcile made up does not count', async (t) => {
    const d = await installedMachine(t);
    withStore(d.places, (store) => {
      store.insertEvent({
        spoolName: null,
        timeNs: T0 - SEC,
        kind: 'observed',
        detail: '',
        rawDetail: null,
        sessionId: S1,
        bootId: 'b',
        pid: 4243,
        procStart: 1,
        cwd: null,
        argv: null,
        name: null,
        payload: null,
      });
    });

    const r = await doctor(d);

    assert.ok(r.lines.includes('info     last event 20s ago'), r.stdout);
  });
});

describe('doctor: arguments', () => {
  test('--help prints the usage and exits 0', async (t) => {
    const d = testPlatform(t);
    const r = await run(d.platform, ['doctor', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^skydeck doctor\n/);
  });

  test('an argument is a usage error: exit 2', async (t) => {
    const d = testPlatform(t);
    const r = await run(d.platform, ['doctor', 'all']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /skydeck doctor/);
  });

  test('name and summary are those of the plan', () => {
    assert.equal(command.name, 'doctor');
    assert.equal(command.summary, 'Check the installation');
  });
});
