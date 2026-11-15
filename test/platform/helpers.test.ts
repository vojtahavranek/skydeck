import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { isAlive } from '../../src/claude/live.ts';
import { procStartFromStat } from '../../src/claude/procstat.ts';
import { main } from '../../src/cli/main.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { realPlatform } from '../../src/platform/real.ts';
import type { RunResult } from '../../src/platform/types.ts';
import { capture } from '../helpers/capture.ts';
import { testContext } from '../helpers/context.ts';
import { testDeck } from '../helpers/deck.ts';
import { keepersToKill, killKeepersIn } from '../helpers/kill.ts';
import {
  BOOT_A,
  BOOT_B,
  fakeClock,
  fakeProc,
  fakeProcesses,
  fakeRunner,
  realTestPlatform,
  runResult,
  S1,
  S2,
  S3,
  SEC,
  statLine,
  T0,
  testPlatform,
} from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';
import { writeWindowConfig } from '../helpers/window-config.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function collect(iterator: AsyncIterableIterator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterator) {
    out.push(chunk);
  }
  return out;
}

describe('constants', () => {
  test('are those of plan section 3', () => {
    assert.equal(T0, 1_794_474_000_000_000_000n);
    assert.equal(SEC, 1_000_000_000n);
    assert.equal(S1, '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d');
    assert.equal(S2, '1c6a4d2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e');
    assert.equal(S3, '2d7b5e3a-0f4c-4b8d-9e5f-4a3b2c1d0e9f');
    assert.equal(BOOT_A, '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f');
    assert.equal(BOOT_B, '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a');
  });
});

describe('fakeClock', () => {
  test('starts at the given time and advances by milliseconds', () => {
    const clock = fakeClock(T0);

    assert.equal(clock.nowNs(), T0);
    clock.advanceMs(1500);
    assert.equal(clock.nowNs(), T0 + 1_500_000_000n);
  });

  test('sleep advances the time instead of waiting', async () => {
    const clock = fakeClock(T0);
    clock.advanceMs(1500);

    await clock.sleep(1000);

    assert.equal(clock.nowNs(), T0 + 1_500_000_000n + SEC);
  });

  test('setNs jumps to a time', () => {
    const clock = fakeClock(T0);

    clock.setNs(T0 + 5n);

    assert.equal(clock.nowNs(), T0 + 5n);
  });

  test('monotonicNs moves with advanceMs and sleep only: setNs, a step of the wall clock, leaves it', async () => {
    const clock = fakeClock(T0);
    const start = clock.monotonicNs();

    clock.advanceMs(1500);
    const advanced = clock.monotonicNs();
    await clock.sleep(1000);
    const slept = clock.monotonicNs();
    clock.setNs(T0 - 3600n * SEC);
    const back = clock.monotonicNs();
    clock.setNs(T0 + 3600n * SEC);
    const forward = clock.monotonicNs();

    assert.equal(advanced - start, 1_500_000_000n);
    assert.equal(slept - start, 2_500_000_000n);
    assert.equal(back, slept, 'a step back moves it not');
    assert.equal(forward, slept, 'nor a step forward');
  });

  test('monotonicNs moves by the advance alone when a timer steps the wall clock during it', () => {
    for (const stepNs of [-3600n * SEC, 3600n * SEC]) {
      const clock = fakeClock(T0);
      clock.after(100, () => {
        clock.setNs(clock.nowNs() + stepNs);
      });
      const start = clock.monotonicNs();

      clock.advanceMs(200);

      assert.equal(clock.monotonicNs() - start, 200_000_000n, `a step of ${stepNs} ns`);
    }
  });

  test('every is called from advanceMs once per period that passed, at its time, until stopped', () => {
    const clock = fakeClock(T0);
    const seen: bigint[] = [];

    const stop = clock.every(5000, () => {
      seen.push(clock.nowNs() - T0);
    });
    const running = clock.timers();
    clock.advanceMs(4999);
    const before = [...seen];
    clock.advanceMs(1);
    clock.advanceMs(12_000);
    const after = [...seen];
    stop();
    stop();
    clock.advanceMs(60_000);

    assert.equal(running, 1);
    assert.deepEqual(before, []);
    assert.deepEqual(after, [5n * SEC, 10n * SEC, 15n * SEC]);
    assert.deepEqual(seen, after, 'nothing after it was stopped');
    assert.equal(clock.timers(), 0);
    assert.equal(clock.nowNs(), T0 + 77n * SEC);
  });

  test('timers fire in time order, sleep fires them too, and setNs does not', async () => {
    const clock = fakeClock(T0);
    const seen: string[] = [];
    clock.every(3000, () => {
      seen.push(`a${(clock.nowNs() - T0) / SEC}`);
    });
    clock.every(2000, () => {
      seen.push(`b${(clock.nowNs() - T0) / SEC}`);
    });

    await clock.sleep(6000);
    clock.setNs(T0 + 60n * SEC);

    assert.deepEqual(seen, ['b2', 'a3', 'b4', 'a6', 'b6']);
    assert.equal(clock.timers(), 2);
  });

  test('setNs moves every running timer to one period after the new time, as a real interval after a jump', () => {
    const clock = fakeClock(T0);
    let calls = 0;
    clock.every(5000, () => {
      calls++;
    });

    clock.setNs(T0 + 300n * SEC);
    clock.advanceMs(4999);
    const before = calls;
    clock.advanceMs(1);

    assert.equal(before, 0, 'not 60 calls for the periods jumped over');
    assert.equal(calls, 1);
  });

  test('a timer stopped by another one in the same advance is not called again', () => {
    const clock = fakeClock(T0);
    let calls = 0;
    const stopCounted = clock.every(2000, () => {
      calls++;
    });
    clock.every(3000, () => {
      stopCounted();
    });

    clock.advanceMs(10_000);

    assert.equal(calls, 1, 'at 2 s only; stopped at 3 s');
    assert.equal(clock.timers(), 1);
  });

  test('every refuses a period that is not a positive whole number of milliseconds', () => {
    const clock = fakeClock(T0);

    for (const ms of [0, -5, 1.5, Number.NaN]) {
      assert.throws(() => clock.every(ms, () => {}), RangeError, String(ms));
    }
    assert.equal(clock.timers(), 0);
  });
});

describe('statLine', () => {
  test('field 22 is the start time and the name may hold spaces and a parenthesis', () => {
    const line = statLine(4242, 51234567, 'we) ird');

    assert.equal(line.slice(line.lastIndexOf(')') + 2).split(' ')[19], '51234567');
    assert.ok(line.startsWith('4242 (we) ird) '), line);
  });

  test('has the 52 fields of a real line and no newline', () => {
    const line = statLine(7, 99);

    assert.equal(line.slice(line.lastIndexOf(')') + 2).split(' ').length, 50);
    assert.ok(!line.includes('\n'));
    assert.ok(line.startsWith('7 (claude) '), line);
  });
});

describe('fakeProc', () => {
  const stat = statLine(4242, 99);

  test('answers what it was given', () => {
    const proc = fakeProc({
      bootId: BOOT_A,
      processes: { 4242: { stat, cmdline: ['claude', '--model', 'opus'] } },
      memAvailableMb: 8000,
    });

    assert.equal(proc.bootId(), BOOT_A);
    assert.equal(proc.stat(4242), stat);
    assert.deepEqual(proc.cmdline(4242), bytes('claude\0--model\0opus\0'));
    assert.equal(proc.stat(1), null);
    assert.equal(proc.cmdline(1), null);
    assert.equal(proc.memAvailableMb(), 8000);
  });

  test('setProcess adds, replaces and removes a process', () => {
    const proc = fakeProc({ processes: { 4242: { stat, cmdline: ['claude'] } } });

    proc.setProcess(4242, null);
    assert.equal(proc.stat(4242), null);
    assert.equal(proc.cmdline(4242), null);

    proc.setProcess(5, { stat: statLine(5, 1), cmdline: ['x'] });
    assert.deepEqual(proc.cmdline(5), bytes('x\0'));
  });

  test('setBootId and setMemAvailableMb change the answers, null included', () => {
    const proc = fakeProc({ bootId: BOOT_A, memAvailableMb: 8000 });

    proc.setBootId(BOOT_B);
    proc.setMemAvailableMb(100);
    assert.equal(proc.bootId(), BOOT_B);
    assert.equal(proc.memAvailableMb(), 100);

    proc.setBootId(null);
    proc.setMemAvailableMb(null);
    assert.equal(proc.bootId(), null);
    assert.equal(proc.memAvailableMb(), null);
  });

  test('a process without arguments has a command line of zero bytes', () => {
    const proc = fakeProc({ processes: { 4242: { stat, cmdline: [] } } });

    assert.equal(proc.cmdline(4242)?.length, 0);
  });

  test('without an init everything reads as unavailable', () => {
    const proc = fakeProc();

    assert.equal(proc.bootId(), null);
    assert.equal(proc.stat(1), null);
    assert.equal(proc.memAvailableMb(), null);
  });
});

describe('fakeRunner', () => {
  test('by default run resolves an empty success and records the call', async () => {
    const runner = fakeRunner();

    const result = await runner.run('gh', ['pr', 'view']);

    assert.deepEqual(result, runResult({}));
    assert.deepEqual(runner.calls, [{ command: 'gh', args: ['pr', 'view'], options: undefined }]);
  });

  test('the handler answers run and sees the options', async () => {
    const runner = fakeRunner((call) => runResult({ stdout: call.args.join(' '), code: 3 }));

    const result = await runner.run('gh', ['a', 'b'], { cwd: '/x' });

    assert.equal(result.stdout, 'a b');
    assert.equal(result.code, 3);
    assert.deepEqual(runner.calls[0]?.options, { cwd: '/x' });
  });

  test('an async handler is awaited', async () => {
    const runner = fakeRunner(async () => runResult({ stdout: 'late' }));

    assert.equal((await runner.run('x', [])).stdout, 'late');
  });

  test('runInteractive answers 0 by default and records into interactiveCalls only', async () => {
    const runner = fakeRunner();

    const code = await runner.runInteractive('vi', ['note.md'], { cwd: '/x' });

    assert.equal(code, 0);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(runner.interactiveCalls, [
      { command: 'vi', args: ['note.md'], options: { cwd: '/x' } },
    ]);
  });

  test('the interactive handler decides the exit code', async () => {
    const runner = fakeRunner(undefined, (call) => (call.command === 'vi' ? 7 : null));

    assert.equal(await runner.runInteractive('vi', []), 7);
    assert.equal(await runner.runInteractive('other', []), null);
  });

  test('run honours a signal: an abort rejects with an AbortError while the answer is pending', async () => {
    const runner = fakeRunner(() => new Promise<RunResult>(() => {}));
    const controller = new AbortController();

    const running = runner.run('gh', [], { signal: controller.signal });
    controller.abort();

    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(runner.calls.length, 1);
  });

  test('run with a signal that is already aborted rejects and records no call', async () => {
    const runner = fakeRunner();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(runner.run('gh', [], { signal: controller.signal }), {
      name: 'AbortError',
    });
    assert.equal(runner.calls.length, 0);
  });

  test('an answer that comes before the abort is the result', async () => {
    const runner = fakeRunner(async () => runResult({ stdout: 'in time' }));
    const controller = new AbortController();

    const result = await runner.run('gh', [], { signal: controller.signal });
    controller.abort();

    assert.equal(result.stdout, 'in time');
  });

  test('runResult fills in the defaults', () => {
    assert.deepEqual(runResult({}), {
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      notFound: false,
    });
    assert.equal(runResult({ notFound: true, code: null }).code, null);
  });
});

describe('testPlatform', () => {
  test('lives inside the sandbox', (t) => {
    const tp = testPlatform(t);

    assert.equal(tp.platform.env['SKYDECK_HOME'], tp.sandbox.skydeckHome);
    assert.equal(tp.platform.env['HOME'], tp.sandbox.home);
    assert.equal(tp.places.dataDir, `${tp.sandbox.skydeckHome}/data`);
    assert.equal(tp.places.claudeHome, tp.sandbox.claudeHome);
    assert.equal(tp.platform.homeDir, tp.sandbox.home);
    assert.equal(tp.platform.cwd, tp.sandbox.home);
  });

  test('the fakes are the ones it returns and the platform uses', (t) => {
    const tp = testPlatform(t);

    assert.equal(tp.platform.clock, tp.clock);
    assert.equal(tp.platform.proc, tp.proc);
    assert.equal(tp.platform.runner, tp.runner);
  });

  test('uuid counts 1, 2, ...', (t) => {
    const { platform } = testPlatform(t);

    assert.equal(platform.uuid(), '00000000-0000-4000-8000-000000000001');
    assert.equal(platform.uuid(), '00000000-0000-4000-8000-000000000002');
  });

  test('the clock starts at T0 and /proc at boot A with 8000 MiB free', (t) => {
    const tp = testPlatform(t);

    assert.equal(tp.clock.nowNs(), T0);
    assert.equal(tp.proc.bootId(), BOOT_A);
    assert.equal(tp.proc.memAvailableMb(), 8000);
  });

  test('options change the start time, boot id and free memory', (t) => {
    const tp = testPlatform(t, { startNs: T0 + SEC, bootId: BOOT_B, memAvailableMb: 100 });

    assert.equal(tp.clock.nowNs(), T0 + SEC);
    assert.equal(tp.proc.bootId(), BOOT_B);
    assert.equal(tp.proc.memAvailableMb(), 100);
  });

  test('env entries are added, and undefined removes one; a function gets the sandbox', (t) => {
    const plain = testPlatform(t, { env: { EXTRA: 'x', CLAUDE_CONFIG_DIR: undefined } });
    const fn = testPlatform(t, { env: (s) => ({ XDG_DATA_HOME: `${s.root}/xdg` }) });

    assert.equal(plain.platform.env['EXTRA'], 'x');
    assert.equal(plain.platform.env['CLAUDE_CONFIG_DIR'], undefined);
    assert.equal(plain.places.claudeHome, `${plain.sandbox.home}/.claude`);
    assert.equal(fn.places.claudeHome, fn.sandbox.claudeHome);
    assert.equal(fn.platform.env['XDG_DATA_HOME'], `${fn.sandbox.root}/xdg`);
  });

  test('the file system is real, the node binary is this one, appRoot is the checkout', (t) => {
    const { platform, sandbox } = testPlatform(t);

    platform.files.writeText(`${sandbox.home}/f`, 'x');

    assert.equal(platform.files.readText(`${sandbox.home}/f`), 'x');
    assert.equal(platform.nodePath, process.execPath);
    assert.equal(platform.nodeVersion, '24.19.0');
    assert.notEqual(platform.files.stat(`${platform.appRoot}/bin/skydeck`), null);
  });
});

describe('capture', () => {
  test('by default no stream is a terminal and the size is 80x24', () => {
    const { io } = capture();

    assert.deepEqual(io.isTTY, { stdin: false, stdout: false, stderr: false });
    assert.deepEqual(io.size(), { columns: 80, rows: 24 });
  });

  test('the options set the terminal flags and the size', () => {
    const { io } = capture({ stdinTTY: true, stderrTTY: true, size: { columns: 100, rows: 30 } });

    assert.deepEqual(io.isTTY, { stdin: true, stdout: false, stderr: true });
    assert.deepEqual(io.size(), { columns: 100, rows: 30 });
  });

  test('openKeys counts the key readers not yet given back: return() and the end of the keys give one back', async () => {
    const c = capture({ keys: ['a'] });

    const first = c.io.keys();
    const second = c.io.keys();
    assert.equal(c.openKeys(), 2);
    await first.return?.();
    await first.return?.();
    assert.equal(c.openKeys(), 1);
    assert.deepEqual(await second.next(), { value: 'a', done: false });
    assert.equal(c.openKeys(), 1);
    assert.equal((await second.next()).done, true);
    assert.equal(c.openKeys(), 0);
    assert.equal((await first.next()).done, true, 'a reader given back reads nothing more');
  });

  test('terminate calls every onTerminate callback with the signal until it unsubscribes', () => {
    const c = capture();
    const seen: string[] = [];
    const first = c.io.onTerminate((signal) => seen.push(`a ${signal}`));
    c.io.onTerminate((signal) => seen.push(`b ${signal}`));

    c.terminate('SIGTERM');
    first();
    c.terminate('SIGHUP');
    c.terminate('SIGINT');

    assert.deepEqual(seen, ['a SIGTERM', 'b SIGTERM', 'b SIGHUP', 'b SIGINT']);
  });

  test('resize changes the size and calls every onResize callback until it unsubscribes', () => {
    const c = capture({ size: { columns: 100, rows: 30 } });
    const seen: string[] = [];
    const first = c.io.onResize(() => seen.push(`a ${c.io.size().columns}`));
    c.io.onResize(() => seen.push(`b ${c.io.size().rows}`));

    c.resize({ columns: 60, rows: 10 });
    first();
    c.resize({ columns: 40, rows: 5 });

    assert.deepEqual(seen, ['a 60', 'b 10', 'b 5']);
    assert.deepEqual(c.io.size(), { columns: 40, rows: 5 });
  });

  test('stdout and stderr are recorded separately', () => {
    const c = capture();

    c.io.stdout('a');
    c.io.stderr('b');
    c.io.stdout('c');

    assert.equal(c.stdout(), 'ac');
    assert.equal(c.stderr(), 'b');
  });

  test('readLine answers the lines in order, then null; the prompt goes to stderr', async () => {
    const c = capture({ lines: ['y'], stdinTTY: true });

    assert.equal(c.io.isTTY.stdin, true);
    assert.equal(c.io.isTTY.stdout, false);
    assert.equal(await c.io.readLine('Q? '), 'y');
    assert.equal(await c.io.readLine('Q? '), null);
    assert.deepEqual(c.prompts, ['Q? ', 'Q? ']);
    assert.equal(c.stderr(), 'Q? Q? ');
    assert.equal(c.stdout(), '');
  });

  test('keys yields the chunks, then ends', async () => {
    const c = capture({ keys: ['j', 'q'] });

    assert.deepEqual(await collect(c.io.keys()), ['j', 'q']);
  });

  test('keys without chunks ends at once', async () => {
    assert.deepEqual(await collect(capture().io.keys()), []);
  });

  test('a function chunk is called only when the iterator reaches it', async () => {
    let calls = 0;
    const c = capture({
      keys: [
        'a',
        () => {
          calls++;
          return 'x';
        },
        'b',
      ],
    });
    const iterator = c.io.keys();

    assert.equal(calls, 0);
    assert.deepEqual(await iterator.next(), { value: 'a', done: false });
    assert.equal(calls, 0);
    assert.deepEqual(await iterator.next(), { value: 'x', done: false });
    assert.equal(calls, 1);
    assert.deepEqual(await iterator.next(), { value: 'b', done: false });
    assert.equal((await iterator.next()).done, true);
    assert.equal(calls, 1);
  });
});

describe('testContext', () => {
  test('without t, --version still works through main', async () => {
    const c = testContext();

    const code = await main(['--version'], c.ctx);

    assert.equal(code, 0);
    assert.match(c.stdout(), /^\d+\.\d+\.\d+\n$/);
  });

  test('without t, touching the platform throws a message that says what to do', () => {
    const c = testContext();

    assert.throws(() => c.ctx.platform.clock.nowNs(), /pass t to testContext/);
    assert.throws(() => c.ctx.platform.uuid(), /pass t to testContext/);
  });

  test('with t, the context holds the test platform and the captured io', (t) => {
    const c = testContext(t, { lines: ['yes'], stdinTTY: true });

    c.ctx.io.stdout('out');
    c.ctx.io.stderr('err');

    assert.equal(c.ctx.platform, c.platform);
    assert.equal(c.ctx.platform.clock, c.clock);
    assert.equal(c.stdout(), 'out');
    assert.equal(c.stderr(), 'err');
    assert.equal(c.ctx.io.isTTY.stdin, true);
    assert.equal(c.places.claudeHome, c.sandbox.claudeHome);
  });

  test('with t, prompts are recorded and the platform options apply', async (t) => {
    const c = testContext(t, { lines: ['yes'], startNs: T0 + SEC });

    assert.equal(await c.ctx.io.readLine('Go? '), 'yes');
    assert.deepEqual(c.prompts, ['Go? ']);
    assert.equal(c.ctx.platform.clock.nowNs(), T0 + SEC);
  });
});

describe('fakeClock: after', () => {
  test('fires once from advanceMs at its time, in time order with every', () => {
    const clock = fakeClock(T0);
    const seen: string[] = [];
    clock.every(2000, () => {
      seen.push(`every${(clock.nowNs() - T0) / SEC}`);
    });
    clock.after(3000, () => {
      seen.push(`after${(clock.nowNs() - T0) / SEC}`);
    });

    clock.advanceMs(2999);
    const before = [...seen];
    clock.advanceMs(10_000);

    assert.deepEqual(before, ['every2']);
    assert.deepEqual(seen, [
      'every2',
      'after3',
      'every4',
      'every6',
      'every8',
      'every10',
      'every12',
    ]);
    assert.equal(clock.timers(), 1, 'the one of after is gone once it fired');
  });

  test('of two due at once, the one started first fires first; sleep fires them too', async () => {
    const clock = fakeClock(T0);
    const seen: string[] = [];
    clock.after(1000, () => seen.push('a'));
    clock.every(1000, () => seen.push('e'));
    clock.after(1000, () => seen.push('b'));

    await clock.sleep(1000);

    assert.deepEqual(seen, ['a', 'e', 'b']);
  });

  test('the returned function cancels it; calling it again does nothing', () => {
    const clock = fakeClock(T0);
    let calls = 0;
    const cancel = clock.after(1000, () => {
      calls++;
    });

    cancel();
    cancel();
    clock.advanceMs(5000);

    assert.equal(calls, 0);
    assert.equal(clock.timers(), 0);
  });

  test('a callback may start another timer, which fires in the same advance when it falls due', () => {
    const clock = fakeClock(T0);
    const seen: bigint[] = [];
    clock.after(1000, () => {
      seen.push(clock.nowNs() - T0);
      clock.after(1000, () => seen.push(clock.nowNs() - T0));
    });

    clock.advanceMs(5000);

    assert.deepEqual(seen, [SEC, 2n * SEC]);
  });

  test('after 0 fires at the next advance, not at once', () => {
    const clock = fakeClock(T0);
    let calls = 0;

    clock.after(0, () => {
      calls++;
    });
    const atOnce = calls;
    clock.advanceMs(0);

    assert.equal(atOnce, 0);
    assert.equal(calls, 1);
  });

  test('setNs keeps the time that was left, as a real timer after the wall clock jumped', () => {
    const clock = fakeClock(T0);
    let calls = 0;
    clock.after(5000, () => {
      calls++;
    });
    clock.advanceMs(2000);

    clock.setNs(T0 + 300n * SEC);
    clock.advanceMs(2999);
    const before = calls;
    clock.advanceMs(1);

    assert.equal(before, 0);
    assert.equal(calls, 1);
  });

  test('refuses a time that is not a whole number of milliseconds a timer can wait', () => {
    const clock = fakeClock(T0);

    for (const ms of [-1, 1.5, Number.NaN, 2 ** 31]) {
      assert.throws(() => clock.after(ms, () => {}), RangeError, String(ms));
    }
    assert.equal(clock.timers(), 0);
  });
});

describe('fakeProc: fdTarget and tcpListening', () => {
  test('fdTarget answers what setFdTarget gave, null otherwise', () => {
    const proc = fakeProc();

    proc.setFdTarget(42, 3, 'socket:[1234]');
    proc.setFdTarget(42, 4, '/dev/pts/1');
    proc.setFdTarget(42, 4, null);

    assert.equal(proc.fdTarget(42, 3), 'socket:[1234]');
    assert.equal(proc.fdTarget(42, 4), null);
    assert.equal(proc.fdTarget(43, 3), null);
  });

  test('tcpListening: nothing listens by default; the listening ports and null can be set', () => {
    const proc = fakeProc({ tcpListening: [47613] });
    const empty = fakeProc();

    const before = [proc.tcpListening(47613), proc.tcpListening(47614), empty.tcpListening(1)];
    proc.setTcpListening(null);

    assert.deepEqual(before, [true, false, false]);
    assert.equal(proc.tcpListening(47613), null);
  });
});

describe('fakeProcesses', () => {
  const options = { cwd: '/', env: { PATH: '/x' } };

  test('records startDetached calls; by default answers new pids whose exit never comes', async () => {
    const processes = fakeProcesses();

    const a = await processes.startDetached('/opt/edge', ['--app=x'], options);
    const b = await processes.startDetached('sh', [], { ...options, input: 'spec' });
    let exited = false;
    void a.exited.then(() => {
      exited = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.notEqual(a.pid, b.pid);
    assert.deepEqual(processes.calls, [
      { command: '/opt/edge', args: ['--app=x'], options },
      { command: 'sh', args: [], options: { ...options, input: 'spec' } },
    ]);
    assert.equal(exited, false);
  });

  test('a handler answers, and its rejection is the rejection', async () => {
    const processes = fakeProcesses((call) => {
      if (call.command === 'missing') {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { pid: 77, exited: Promise.resolve({ code: 0, signal: null }) };
    });

    const child = await processes.startDetached('ok', [], options);

    assert.equal(child.pid, 77);
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    await assert.rejects(processes.startDetached('missing', [], options), { code: 'ENOENT' });
  });

  test('a Windows command is recorded and answered like any other: a fake starts nothing (ruling on A32)', async () => {
    const asked: string[] = [];
    const processes = fakeProcesses((call) => {
      asked.push(call.command);
      return { pid: 7, exited: new Promise(() => {}) };
    });
    const keepAlive = [
      '-d',
      'Ubuntu',
      '-u',
      'tester',
      '--exec',
      '/bin/sh',
      '/s/bin/skydeck-keepalive',
      '/run',
    ];

    const child = await processes.startDetached('wsl.exe', keepAlive, options);
    await processes.startDetached('/mnt/c/x/msedge.exe', ['--app=x'], options);
    const unscripted = await fakeProcesses().startDetached('X.EXE', [], options);

    assert.equal(child.pid, 7);
    assert.ok(unscripted.pid > 0);
    assert.deepEqual(asked, ['wsl.exe', '/mnt/c/x/msedge.exe']);
    assert.deepEqual(processes.calls[0], { command: 'wsl.exe', args: keepAlive, options });
  });

  test('a Windows command given to the fake starts no process: no child, no exec', async (t) => {
    const tp = testPlatform(t);
    const marker = `${tp.sandbox.root}/marker`;
    for (const name of ['wsl.exe', 'msedge.exe']) {
      writeFileSync(`${tp.sandbox.bin}/${name}`, `#!/bin/sh\necho "$0" >> ${marker}\n`, {
        mode: 0o755,
      });
    }
    const env = tp.platform.env as Record<string, string>;

    await tp.platform.processes.startDetached('wsl.exe', ['--exec', '/bin/sh'], {
      cwd: tp.sandbox.root,
      env,
    });
    await tp.platform.processes.startDetached(`${tp.sandbox.bin}/msedge.exe`, [], {
      cwd: tp.sandbox.root,
      env,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(tp.processes.calls.length, 2);
    assert.equal(existsSync(marker), false, 'neither stub ran');
  });

  test('signal refuses what the real one refuses: a pid that is not a positive whole number', () => {
    const processes = fakeProcesses(undefined, [0]);

    for (const pid of [0, -1, Number.NaN, 1.5]) {
      assert.throws(() => processes.signal(pid, 'SIGTERM'), RangeError, String(pid));
    }
    assert.deepEqual(processes.signals, []);
  });

  test('signal answers from the set of live pids and records every call', () => {
    const processes = fakeProcesses(undefined, [10]);

    const answers = [processes.signal(10, 'SIGTERM'), processes.signal(11, 'SIGKILL')];
    processes.live.delete(10);

    assert.deepEqual(answers, [true, false]);
    assert.equal(processes.signal(10, 'SIGKILL'), false);
    assert.deepEqual(processes.signals, [
      { pid: 10, signal: 'SIGTERM' },
      { pid: 11, signal: 'SIGKILL' },
      { pid: 10, signal: 'SIGKILL' },
    ]);
  });
});

describe('testPlatform: step 2 members', () => {
  test('randomBytes counts 0, 1, 2, … across calls', (t) => {
    const { platform } = testPlatform(t);

    assert.deepEqual([...platform.randomBytes(4)], [0, 1, 2, 3]);
    assert.deepEqual([...platform.randomBytes(4)], [4, 5, 6, 7]);
    assert.ok(platform.randomBytes(1) instanceof Uint8Array);
  });

  test('pid 4000, the real uid, user name tester', (t) => {
    const { platform } = testPlatform(t);

    assert.equal(platform.pid, 4000);
    assert.equal(platform.uid, process.getuid?.());
    assert.equal(platform.userName, 'tester');
  });

  test('the processes are fake, record every call, and are the ones it returns', async (t) => {
    const tp = testPlatform(t);

    await tp.platform.processes.startDetached('sh', [], { cwd: '/', env: {} });
    await tp.platform.processes.startDetached('/mnt/c/Windows/System32/wsl.exe', [], {
      cwd: '/',
      env: {},
    });

    assert.equal(tp.platform.processes, tp.processes);
    assert.deepEqual(
      tp.processes.calls.map((call) => call.command),
      ['sh', '/mnt/c/Windows/System32/wsl.exe'],
    );
  });

  test('realProcesses: true signals only the processes it started and that still run, never a pid of the fake /proc', async (t) => {
    const kill = t.mock.method(process, 'kill', () => true);
    const tp = testPlatform(t, { realProcesses: true });
    tp.sandbox.link('sh');
    const env = tp.platform.env as Record<string, string>;
    const child = await tp.platform.processes.startDetached('sh', ['-c', 'exit 0'], {
      cwd: tp.sandbox.root,
      env,
    });
    // A fixture that names a pid of the developer's: the fake /proc says it is alive.
    tp.proc.setProcess(4242, { stat: statLine(4242, 100), cmdline: ['claude'] });

    assert.throws(
      () => tp.platform.processes.signal(4242, 'SIGTERM'),
      /only the processes it started/,
    );
    assert.throws(
      () => tp.platform.processes.signal(tp.platform.pid, 'SIGKILL'),
      /only the processes it started/,
    );
    await child.exited;
    assert.throws(
      () => tp.platform.processes.signal(child.pid, 'SIGTERM'),
      /only the processes it started/,
    );
    assert.equal(kill.mock.callCount(), 0);
  });

  test('realProcesses: true signals a process it started while it runs', async (t) => {
    const tp = testPlatform(t, { realProcesses: true });
    tp.sandbox.link('sleep');
    const child = await tp.platform.processes.startDetached('sleep', ['30'], {
      cwd: tp.sandbox.root,
      env: tp.platform.env as Record<string, string>,
    });

    assert.equal(tp.platform.processes.signal(child.pid, 'SIGKILL'), true);
    assert.deepEqual(await child.exited, { code: null, signal: 'SIGKILL' });
  });

  test('realProcesses: true gives real processes that still refuse Windows programs, whatever the environment', async (t) => {
    const tp = testPlatform(t, {
      realProcesses: true,
      env: { SKYDECK_TEST_NO_WINDOWS: undefined },
    });
    tp.sandbox.link('sh');
    const env = tp.platform.env as Record<string, string>;

    const child = await tp.platform.processes.startDetached('sh', ['-c', 'echo $$ > ran'], {
      cwd: tp.sandbox.root,
      env,
    });
    await child.exited;
    writeFileSync(`${tp.sandbox.bin}/cmd.exe`, `#!/bin/sh\necho x > ${tp.sandbox.root}/marker\n`, {
      mode: 0o755,
    });

    assert.equal(readFileSync(`${tp.sandbox.root}/ran`, 'utf8'), `${child.pid}\n`);
    await assert.rejects(
      tp.platform.processes.startDetached('cmd.exe', [], { cwd: tp.sandbox.root, env }),
      { code: 'EWINDOWS' },
    );
    assert.equal(existsSync(`${tp.sandbox.root}/marker`), false);
  });

  test('net is the real one: a test listens on a unix socket in the sandbox', async (t) => {
    const { platform, sandbox: s } = testPlatform(t);
    const path = `${s.root}/x.sock`;
    const listener = await platform.net.listenHttp(
      { path },
      { request: (_req, res) => res.end('{"ok":true}') },
    );
    t.after(() => listener.close());

    const answer = await platform.net.requestUnix(path, {
      method: 'GET',
      path: '/',
      timeoutMs: 5000,
    });

    assert.deepEqual(answer, { status: 200, body: { ok: true } });
  });
});

describe('sandbox: step 2', () => {
  test('env() carries SKYDECK_TEST_NO_WINDOWS=1, which a test can remove', (t) => {
    const s = sandbox(t);

    assert.equal(s.env()['SKYDECK_TEST_NO_WINDOWS'], '1');
    assert.equal('SKYDECK_TEST_NO_WINDOWS' in s.env({ SKYDECK_TEST_NO_WINDOWS: undefined }), false);
  });

  test('link of a program that is already linked does nothing', (t) => {
    const s = sandbox(t);

    s.link('sh');
    s.link('sh', 'cat');

    assert.ok(existsSync(`${s.bin}/sh`));
    assert.ok(existsSync(`${s.bin}/cat`));
  });
});

describe('realTestPlatform (A36)', () => {
  const PROGRAMS = [
    'python3',
    'sh',
    'sleep',
    'date',
    'cat',
    'base64',
    'mkdir',
    'mv',
    'rm',
    'dirname',
    'readlink',
  ];

  test('the real clock, /proc, boot id and pid', (t) => {
    const { platform } = realTestPlatform(t);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const procStart = procStartFromStat(platform.proc.stat(process.pid) ?? '');

    const diff = platform.clock.nowNs() - BigInt(Date.now()) * 1_000_000n;

    assert.ok(diff > -5_000_000_000n && diff < 5_000_000_000n, `off by ${diff} ns`);
    assert.equal(platform.proc.bootId(), bootId);
    assert.equal(platform.pid, process.pid);
    assert.equal(platform.uid, process.getuid?.());
    assert.equal(platform.userName, userInfo().username);
    assert.equal(
      isAlive({ pid: platform.pid, procStart, bootId }, platform.proc, platform.proc.bootId()),
      true,
    );
  });

  test('the members it returns are the ones the platform uses', (t) => {
    const tp = realTestPlatform(t);

    assert.equal(tp.platform.clock, tp.clock);
    assert.equal(tp.platform.proc, tp.proc);
    assert.equal(tp.platform.runner, tp.runner);
    assert.equal(tp.platform.processes, tp.processes);
  });

  test('bootId overrides only the boot id; every other /proc read stays real', (t) => {
    const { platform } = realTestPlatform(t, { bootId: BOOT_B });

    assert.equal(platform.proc.bootId(), BOOT_B);
    assert.ok(platform.proc.stat(process.pid)?.startsWith(`${process.pid} (`));
    assert.notEqual(platform.proc.memAvailableMb(), null);
  });

  test('lives inside the sandbox with its environment; appRoot is the checkout', (t) => {
    const tp = realTestPlatform(t, { env: (s) => ({ EXTRA: s.root }) });

    assert.equal(tp.platform.env['SKYDECK_HOME'], tp.sandbox.skydeckHome);
    assert.equal(tp.platform.env['PATH'], tp.sandbox.bin);
    assert.equal(tp.platform.env['SKYDECK_TEST_NO_WINDOWS'], '1');
    assert.equal(tp.platform.env['EXTRA'], tp.sandbox.root);
    assert.equal(tp.platform.homeDir, tp.sandbox.home);
    assert.equal(tp.platform.cwd, tp.sandbox.home);
    assert.equal(tp.places.dataDir, `${tp.sandbox.skydeckHome}/data`);
    assert.equal(tp.platform.nodeVersion, process.versions.node);
    assert.notEqual(tp.platform.files.stat(`${tp.platform.appRoot}/bin/skydeck`), null);
  });

  test('the programs a keeper, the stand-in, the hook and the launcher need are on its PATH', async (t) => {
    const { platform, sandbox: s } = realTestPlatform(t);
    const env = platform.env as Record<string, string>;

    const found = await platform.runner.run('sh', ['-c', 'command -v python3; command -v sh'], {
      env,
    });

    for (const program of PROGRAMS) {
      assert.ok(existsSync(`${s.bin}/${program}`), program);
    }
    assert.equal(found.stdout, `${s.bin}/python3\n${s.bin}/sh\n`);
  });

  test("a run without env or cwd gets the sandbox environment and home, never the developer's", async (t) => {
    const { platform, sandbox: s } = realTestPlatform(t);
    const script =
      'printf "%s|%s|%s|%s|%s|%s" "$HOME" "$SKYDECK_HOME" "$SKYDECK_TEST_NO_WINDOWS" "$PATH" "$(pwd)" "$(command -v claude; command -v skydeck)"';

    const plain = await platform.runner.run('sh', ['-c', script]);
    const interactive = await platform.runner.runInteractive('sh', [
      '-c',
      `[ "$HOME|$PATH|$(pwd)" = "${s.home}|${s.bin}|${s.home}" ]`,
    ]);

    assert.equal(
      plain.stdout,
      `${s.home}|${s.skydeckHome}|1|${s.bin}|${s.home}|`,
      'no claude, no skydeck',
    );
    assert.notEqual(s.home, userInfo().homedir);
    assert.equal(interactive, 0);
  });

  test('a keeper-like python3 -c started detached with the sandbox environment runs', async (t) => {
    const { platform, sandbox: s } = realTestPlatform(t);

    const child = await platform.processes.startDetached(
      'python3',
      ['-c', 'import os, sys; open(sys.argv[1], "w").write(str(os.getsid(0)))', `${s.root}/sid`],
      { cwd: s.root, env: platform.env as Record<string, string> },
    );

    assert.deepEqual(await child.exited, { code: 0, signal: null });
    assert.equal(readFileSync(`${s.root}/sid`, 'utf8'), String(child.pid));
  });

  test('its processes and runner refuse Windows programs whatever the environment says', async (t) => {
    const { platform, sandbox: s } = realTestPlatform(t, {
      env: { SKYDECK_TEST_NO_WINDOWS: undefined },
    });
    writeFileSync(`${s.bin}/cmd.exe`, `#!/bin/sh\necho x > ${s.root}/marker\n`, { mode: 0o755 });
    const options = { cwd: s.root, env: platform.env as Record<string, string> };

    await assert.rejects(platform.processes.startDetached('cmd.exe', [], options), {
      code: 'EWINDOWS',
    });
    await assert.rejects(platform.runner.run('cmd.exe', [], options), { code: 'EWINDOWS' });

    assert.equal(existsSync(`${s.root}/marker`), false);
  });

  test('testDeck(t, { real: true }) opens a deck on it', (t) => {
    const d = testDeck(t, { real: true, config: { claudeCommand: '/bin/true' } });

    assert.equal(d.platform.pid, process.pid);
    assert.equal(d.deck.platform, d.platform);
    assert.equal(d.deck.config.claudeCommand, '/bin/true');
    assert.equal(d.deck.places.dbPath, `${d.sandbox.skydeckHome}/data/skydeck.db`);
    assert.ok(existsSync(d.deck.places.dbPath));
    assert.equal(
      d.platform.proc.bootId(),
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    );
  });
});

describe('writeWindowConfig (A32)', () => {
  test('a key given as undefined is left out: the stub, keepAlive off and links edge stay', (t) => {
    const s = sandbox(t);

    const { edgeStub } = writeWindowConfig(s, {
      edge: undefined,
      keepAlive: undefined,
      links: undefined,
      port: 47001,
    });
    const config = loadConfig(realPlatform().files, `${s.skydeckHome}/config/config.json`);

    assert.deepEqual(config.window, {
      port: 47001,
      edge: edgeStub,
      profileDir: null,
      keepAlive: 'off',
      links: 'edge',
    });
  });

  test('writes a config.json that parses, with the Edge stub, the keep-alive off and links to the stub', (t) => {
    const s = sandbox(t);

    const { edgeStub } = writeWindowConfig(s);
    const config = loadConfig(realPlatform().files, `${s.skydeckHome}/config/config.json`);

    assert.deepEqual(config.window, {
      port: 47613,
      edge: edgeStub,
      profileDir: null,
      keepAlive: 'off',
      links: 'edge',
    });
    assert.ok(edgeStub.startsWith(`${s.root}/`), edgeStub);
    assert.ok(!/\.exe$/i.test(edgeStub) && !edgeStub.startsWith('/mnt/'), edgeStub);
  });

  test('what the test passes is merged over it', (t) => {
    const s = sandbox(t);

    const { edgeStub } = writeWindowConfig(s, { keepAlive: 'wsl', links: 'default', port: 47000 });
    const config = loadConfig(realPlatform().files, `${s.skydeckHome}/config/config.json`);

    assert.deepEqual(config.window, {
      port: 47000,
      edge: edgeStub,
      profileDir: null,
      keepAlive: 'wsl',
      links: 'default',
    });
  });

  test('keeps the other keys of a config.json that is already there', (t) => {
    const s = sandbox(t);
    mkdirSync(`${s.skydeckHome}/config`);
    writeFileSync(
      `${s.skydeckHome}/config/config.json`,
      JSON.stringify({ claudeCommand: '/x/standin', window: { port: 1 } }),
    );

    writeWindowConfig(s);
    const config = loadConfig(realPlatform().files, `${s.skydeckHome}/config/config.json`);

    assert.equal(config.claudeCommand, '/x/standin');
    assert.equal(config.window.port, 1);
    assert.equal(config.window.keepAlive, 'off');
    assert.equal(config.window.links, 'edge');
  });

  test('a key the configuration does not know is written as given, so a test can see it refused', (t) => {
    const s = sandbox(t);

    writeWindowConfig(s, { colour: 1 });

    assert.throws(
      () => loadConfig(realPlatform().files, `${s.skydeckHome}/config/config.json`),
      /window\.colour/,
    );
  });

  test('running the Edge stub records its arguments, one entry per run', async (t) => {
    const s = sandbox(t);
    const { edgeStub, edgeCalls } = writeWindowConfig(s);
    const { runner } = realPlatform();

    const before = edgeCalls();
    const first = await runner.run(
      edgeStub,
      ['--app=http://127.0.0.1:1/#t', 'a b', '', 'two\nlines'],
      { env: s.env() },
    );
    await runner.run(edgeStub, [], { env: s.env() });

    assert.deepEqual(before, []);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(edgeCalls(), [['--app=http://127.0.0.1:1/#t', 'a b', '', 'two\nlines'], []]);
  });
});

describe('killKeepersIn (A34)', () => {
  type Exit = { code: number | null; signal: string | null };

  /** A `sleep 30` this test started itself, killed when the test ends if still running. */
  async function sleeper(
    t: TestContext,
    s: Sandbox,
  ): Promise<{ pid: number; procStart: number; exited: Promise<Exit> }> {
    s.link('sleep');
    const platform = realPlatform();
    const child = await platform.processes.startDetached('sleep', ['30'], {
      cwd: s.root,
      env: s.env(),
    });
    let ended = false;
    void child.exited.then(() => {
      ended = true;
    });
    t.after(async () => {
      if (!ended) {
        platform.processes.signal(child.pid, 'SIGKILL');
        await child.exited;
      }
    });
    const procStart = procStartFromStat(platform.proc.stat(child.pid) ?? '');
    assert.ok(procStart !== null);
    return { pid: child.pid, procStart, exited: child.exited };
  }

  /** How the process ended within `ms`, or 'running' (far less than the 30 s of its sleep). */
  function exitWithin(p: { exited: Promise<Exit> }, ms: number): Promise<Exit | 'running'> {
    return Promise.race([
      p.exited,
      new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), ms)),
    ]);
  }

  const BOOT = (): string => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

  function writeLine(dir: string, id: string, line: string): void {
    mkdirSync(`${dir}/terms`, { recursive: true });
    writeFileSync(`${dir}/terms/${id}.pid`, `${line}\n`);
  }

  function outside(t: TestContext): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'skydeck-outside-')));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  const alive = (pid: number): boolean => realPlatform().proc.stat(pid) !== null;

  test('a directory outside the sandbox fails the assertion and nothing is signalled', async (t) => {
    const s = sandbox(t);
    const keeper = await sleeper(t, s);
    const dir = outside(t);
    writeLine(dir, 'aaaaaaaaaaaa', `${keeper.pid} ${keeper.procStart} ${BOOT()} 1 1`);

    assert.throws(() => killKeepersIn(s, dir), assert.AssertionError);

    assert.equal(await exitWithin(keeper, 300), 'running');
    assert.equal(alive(keeper.pid), true);
  });

  test('a symlink inside the sandbox that points out fails the assertion too', async (t) => {
    const s = sandbox(t);
    const keeper = await sleeper(t, s);
    const dir = outside(t);
    writeLine(dir, 'aaaaaaaaaaaa', `${keeper.pid} ${keeper.procStart} ${BOOT()} 1 1`);
    symlinkSync(dir, `${s.root}/run`);
    mkdirSync(`${s.root}/run2`);
    symlinkSync(`${dir}/terms`, `${s.root}/run2/terms`);

    assert.throws(() => killKeepersIn(s, `${s.root}/run`), assert.AssertionError);
    assert.throws(() => killKeepersIn(s, `${s.root}/run2`), assert.AssertionError);
    assert.throws(() => killKeepersIn(s, `${s.root}/run/../../`), assert.AssertionError);

    assert.equal(await exitWithin(keeper, 300), 'running');
    assert.equal(alive(keeper.pid), true);
  });

  test('the sandbox root itself is not a runtime directory under it', (t) => {
    const s = sandbox(t);

    assert.throws(() => killKeepersIn(s, s.root), assert.AssertionError);
  });

  test('inside: a live keeper line is killed at once; a dead line, another process start and another boot are skipped', async (t) => {
    const s = sandbox(t);
    const keeper = await sleeper(t, s);
    const reused = await sleeper(t, s);
    const otherBoot = await sleeper(t, s);
    const stranger = await sleeper(t, s);
    writeLine(outside(t), 'aaaaaaaaaaaa', `${stranger.pid} ${stranger.procStart} ${BOOT()} 1 1`);
    const dir = `${s.skydeckHome}/run`;
    writeLine(dir, 'aaaaaaaaaaaa', `${keeper.pid} ${keeper.procStart} ${BOOT()} 1 1`);
    writeLine(dir, 'bbbbbbbbbbbb', `${reused.pid} ${reused.procStart + 1} ${BOOT()} 1 1`);
    writeLine(dir, 'cccccccccccc', `${otherBoot.pid} ${otherBoot.procStart} ${BOOT_B} 1 1`);
    writeLine(dir, 'dddddddddddd', `999999999 1 ${BOOT()} 1 0`);
    writeLine(dir, 'eeeeeeeeeeee', 'garbage');
    writeFileSync(
      `${dir}/terms/.ffffffffffff.pid.1a2b.tmp`,
      `${reused.pid} ${reused.procStart} ${BOOT()} 1 1\n`,
    );

    killKeepersIn(s, dir);

    assert.deepEqual(await exitWithin(keeper, 5000), { code: null, signal: 'SIGKILL' });
    for (const [other, why] of [
      [reused, 'another process start'],
      [otherBoot, 'another boot'],
      [stranger, 'a line outside the sandbox'],
    ] as const) {
      assert.equal(await exitWithin(other, 100), 'running', why);
      assert.equal(alive(other.pid), true, why);
    }
  });

  test('an entry that vanished or is not a file is skipped: the keepers after it are still killed', async (t) => {
    const s = sandbox(t);
    const keeper = await sleeper(t, s);
    const dir = `${s.skydeckHome}/run`;
    writeLine(dir, 'bbbbbbbbbbbb', `${keeper.pid} ${keeper.procStart} ${BOOT()} 1 1`);
    // Sorted before the live line: a keeper that ended removed its file, a link left dangling.
    symlinkSync(`${dir}/terms/gone.pid`, `${dir}/terms/aaaaaaaaaaaa.pid`);
    mkdirSync(`${dir}/terms/aaaaaaaaaaab.pid`);

    killKeepersIn(s, dir);

    assert.deepEqual(await exitWithin(keeper, 5000), { code: null, signal: 'SIGKILL' });
  });

  test('a .pid file that leads out of the sandbox fails the assertion before any keeper is signalled', async (t) => {
    const s = sandbox(t);
    const keeper = await sleeper(t, s);
    const elsewhere = await sleeper(t, s);
    const out = outside(t);
    writeLine(out, 'cccccccccccc', `${elsewhere.pid} ${elsewhere.procStart} ${BOOT()} 1 1`);
    const dir = `${s.skydeckHome}/run`;
    writeLine(dir, 'aaaaaaaaaaaa', `${keeper.pid} ${keeper.procStart} ${BOOT()} 1 1`);
    // Sorted after the live line, so a helper that signalled as it read would have signalled already.
    symlinkSync(`${out}/terms/cccccccccccc.pid`, `${dir}/terms/zzzzzzzzzzzz.pid`);

    assert.throws(() => killKeepersIn(s, dir), assert.AssertionError);

    assert.equal(await exitWithin(keeper, 300), 'running');
    assert.equal(await exitWithin(elsewhere, 0), 'running');
  });

  test('keepersToKill: alive lines are to kill, unreadable ones unknown; dead, garbled and own ones neither', () => {
    const proc = fakeProc({
      bootId: BOOT_A,
      processes: {
        10: { stat: statLine(10, 100), cmdline: [] },
        11: { stat: statLine(11, 100), cmdline: [] },
        13: { stat: statLine(13, 999), cmdline: [] },
        14: { stat: statLine(14, 100), cmdline: [] },
        4000: { stat: statLine(4000, 100), cmdline: [] },
      },
    });
    const stat = proc.stat.bind(proc);
    proc.stat = (pid) => {
      if (pid === 11) {
        throw Object.assign(new Error('cannot read /proc/11/stat (EACCES)'), { code: 'EACCES' });
      }
      return stat(pid);
    };
    const lines = [
      `10 100 ${BOOT_A} 1 1\n`, // alive
      `11 100 ${BOOT_A} 1 1\n`, // cannot be read
      `12 100 ${BOOT_A} 1 0\n`, // no such process
      `13 100 ${BOOT_A} 1 1\n`, // pid reused
      `14 100 ${BOOT_B} 1 1\n`, // another boot
      `4000 100 ${BOOT_A} 1 1\n`, // this process
      'garbage\n',
      `1 100 ${BOOT_A} 1 1\n`, // init
      `15 100 ${BOOT_A} 1 1\r\n`, // not a pid line (contract 2.8)
    ];

    assert.deepEqual(keepersToKill(lines, proc, BOOT_A, [4000]), { kill: [10], unknown: [11] });
    assert.deepEqual(keepersToKill(lines, proc, null, [4000]), {
      kill: [],
      unknown: [10, 11, 12, 13, 14],
    });
  });

  test('a line whose process cannot be read is not signalled; the others are, then it throws', async (t) => {
    const s = sandbox(t);
    const first = await sleeper(t, s);
    const unreadable = await sleeper(t, s);
    const last = await sleeper(t, s);
    const dir = `${s.skydeckHome}/run`;
    writeLine(dir, 'aaaaaaaaaaaa', `${first.pid} ${first.procStart} ${BOOT()} 1 1`);
    writeLine(dir, 'bbbbbbbbbbbb', `${unreadable.pid} ${unreadable.procStart} ${BOOT()} 1 1`);
    writeLine(dir, 'cccccccccccc', `${last.pid} ${last.procStart} ${BOOT()} 1 1`);
    // /proc/<pid>/stat of the middle one fails as it would without permission (EACCES).
    const readFileSync = fs.readFileSync;
    const denied = `/proc/${unreadable.pid}/stat`;
    const mocked = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof readFileSync>) => {
      if (args[0] === denied) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${denied}'`), {
          code: 'EACCES',
        });
      }
      return readFileSync(...args);
    });
    syncBuiltinESMExports(); // the named imports of node:fs (real.ts, kill.ts) now see the mock
    let thrown: unknown;
    try {
      killKeepersIn(s, dir);
    } catch (error) {
      thrown = error;
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }

    assert.match(String(thrown), new RegExp(`could not tell whether ${unreadable.pid} still run`));
    assert.deepEqual(await exitWithin(first, 5000), { code: null, signal: 'SIGKILL' });
    assert.deepEqual(await exitWithin(last, 5000), { code: null, signal: 'SIGKILL' });
    assert.equal(await exitWithin(unreadable, 300), 'running');
  });

  test('a line that names this process is skipped: the test lives on', (t) => {
    const s = sandbox(t);
    const self = procStartFromStat(realPlatform().proc.stat(process.pid) ?? '');
    writeLine(`${s.skydeckHome}/run`, 'aaaaaaaaaaaa', `${process.pid} ${self} ${BOOT()} 1 1`);
    const kill = t.mock.method(process, 'kill', () => true);

    killKeepersIn(s, `${s.skydeckHome}/run`);

    assert.equal(kill.mock.callCount(), 0);
  });

  test('a runtime directory that does not exist (yet) is nothing to do', (t) => {
    const s = sandbox(t);

    killKeepersIn(s, `${s.skydeckHome}/run`);
  });
});
