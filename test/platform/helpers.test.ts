import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { main } from '../../src/cli/main.ts';
import type { RunResult } from '../../src/platform/types.ts';
import { capture } from '../helpers/capture.ts';
import { testContext } from '../helpers/context.ts';
import {
  BOOT_A,
  BOOT_B,
  fakeClock,
  fakeProc,
  fakeRunner,
  runResult,
  S1,
  S2,
  S3,
  SEC,
  statLine,
  T0,
  testPlatform,
} from '../helpers/platform.ts';

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
