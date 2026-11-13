import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { DEFAULT_CONFIG } from '../../src/platform/config.ts';
import type { Config } from '../../src/platform/config.ts';
import { HANDOFF_ENV, handoffScript, hereTerminal } from '../../src/terminals/here.ts';
import { terminalFor } from '../../src/terminals/index.ts';
import type { LaunchSpec } from '../../src/terminals/index.ts';
import { weztermTerminal } from '../../src/terminals/wezterm.ts';
import { fakeRunner, runResult, S1, testPlatform } from '../helpers/platform.ts';
import type { RunCall } from '../helpers/platform.ts';

const spec: LaunchSpec = { cwd: '/w', argv: ['claude', '--resume', S1] };

describe('handoffScript', () => {
  test('quotes only the words that need it', () => {
    assert.equal(
      handoffScript({
        cwd: '/home/dev/projects/demo',
        argv: ['claude', '--resume', S1, '-n', 'my label', '--model', 'opus'],
      }),
      `cd -- /home/dev/projects/demo || exit 1\nexec claude --resume ${S1} -n 'my label' --model opus\n`,
    );
  });

  test('quotes a directory with an apostrophe', () => {
    assert.equal(
      handoffScript({ cwd: "/tmp/it's", argv: ['claude'] }),
      "cd -- '/tmp/it'\\''s' || exit 1\nexec claude\n",
    );
  });

  test('quotes a directory that begins with a dash after the --', () => {
    assert.equal(
      handoffScript({ cwd: '-odd dir', argv: ['claude'] }),
      "cd -- '-odd dir' || exit 1\nexec claude\n",
    );
  });
});

describe('hereTerminal', () => {
  test('is the here terminal and does not open tabs', (t) => {
    const { platform } = testPlatform(t);

    const terminal = hereTerminal({ files: platform.files, env: {} });

    assert.equal(terminal.name, 'here');
    assert.equal(terminal.opensTabs, false);
  });

  test('without SKYDECK_HANDOFF it says it was not started through bin/skydeck', async (t) => {
    const { platform } = testPlatform(t);

    const result = await hereTerminal({ files: platform.files, env: {} }).open(spec);

    assert.deepEqual(result, {
      ok: false,
      error: 'not started through bin/skydeck',
      timedOut: false,
    });
  });

  test('an empty SKYDECK_HANDOFF counts as missing', async (t) => {
    const { platform } = testPlatform(t);

    const result = await hereTerminal({
      files: platform.files,
      env: { [HANDOFF_ENV]: '' },
    }).open(spec);

    assert.deepEqual(result, {
      ok: false,
      error: 'not started through bin/skydeck',
      timedOut: false,
    });
  });

  test('with SKYDECK_HANDOFF it writes the handoff script to that file', async (t) => {
    const { platform, sandbox } = testPlatform(t);
    const file = join(sandbox.root, 'h');

    const result = await hereTerminal({
      files: platform.files,
      env: { SKYDECK_HANDOFF: file },
    }).open(spec);

    assert.deepEqual(result, { ok: true });
    assert.equal(platform.files.readText(file), handoffScript(spec));
  });

  test('a handoff file that cannot be written is a rejected promise, not a synchronous throw', async (t) => {
    const { platform, sandbox } = testPlatform(t);
    const terminal = hereTerminal({
      files: platform.files,
      env: { SKYDECK_HANDOFF: join(sandbox.root, 'no-such-dir', 'h') },
    });

    let promise: Promise<unknown> | undefined;
    assert.doesNotThrow(() => {
      promise = terminal.open(spec);
    });

    await assert.rejects(promise as Promise<unknown>, { code: 'ENOENT' });
  });

  test('an empty argument list is rejected and nothing is written', async (t) => {
    const { platform, sandbox } = testPlatform(t);
    const file = join(sandbox.root, 'h');
    const terminal = hereTerminal({ files: platform.files, env: { SKYDECK_HANDOFF: file } });

    await assert.rejects(terminal.open({ cwd: '/w', argv: [] }), /empty argument list/);

    assert.equal(platform.files.readText(file), null);
  });

  test('the variable is named SKYDECK_HANDOFF', () => {
    assert.equal(HANDOFF_ENV, 'SKYDECK_HANDOFF');
  });
});

describe('weztermTerminal', () => {
  const ARGS = ['cli', '--no-auto-start', 'spawn', '--cwd', '/w', '--', 'claude', '--resume', S1];

  test('is the wezterm terminal and opens tabs', () => {
    const terminal = weztermTerminal({ runner: fakeRunner(), env: {} }, null);

    assert.equal(terminal.name, 'wezterm');
    assert.equal(terminal.opensTabs, true);
  });

  test('runs wezterm cli spawn with a 10 s timeout and is ok on exit 0', async () => {
    const runner = fakeRunner(() => runResult({ code: 0 }));

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, { ok: true });
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(runner.calls[0], {
      command: 'wezterm',
      args: ARGS,
      options: { timeoutMs: 10000 },
    });
  });

  test('never starts a WezTerm server of its own: with no window open the call fails', async () => {
    const runner = fakeRunner(() => runResult({ code: 0 }));

    await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(runner.calls[0]?.args.slice(0, 3), ['cli', '--no-auto-start', 'spawn']);
  });

  test('passes the domain name before --cwd', async () => {
    const runner = fakeRunner(() => runResult({ code: 0 }));

    await weztermTerminal({ runner, env: {} }, 'WSL:Ubuntu').open(spec);

    assert.deepEqual(runner.calls[0]?.args, [
      'cli',
      '--no-auto-start',
      'spawn',
      '--domain-name',
      'WSL:Ubuntu',
      '--cwd',
      '/w',
      '--',
      'claude',
      '--resume',
      S1,
    ]);
  });

  test('passes the arguments as a list: nothing is quoted or split', async () => {
    const runner = fakeRunner(() => runResult({ code: 0 }));
    const odd: LaunchSpec = { cwd: '/w x', argv: ['claude', '-n', "it's a label", ''] };

    await weztermTerminal({ runner, env: {} }, null).open(odd);

    assert.deepEqual(runner.calls[0]?.args, [
      'cli',
      '--no-auto-start',
      'spawn',
      '--cwd',
      '/w x',
      '--',
      'claude',
      '-n',
      "it's a label",
      '',
    ]);
  });

  test('a failure reports the first line of stderr', async () => {
    const runner = fakeRunner(() => runResult({ code: 1, stderr: 'no running wezterm\nmore' }));

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, { ok: false, error: 'no running wezterm', timedOut: false });
  });

  test('the stderr line is printable: escapes and a carriage return are removed', async () => {
    const runner = fakeRunner(() =>
      runResult({ code: 1, stderr: '\x1b[31mno running wezterm\x1b[0m\r\nmore' }),
    );

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, { ok: false, error: 'no running wezterm', timedOut: false });
  });

  test('a stderr that is blank counts as no stderr', async () => {
    const runner = fakeRunner(() => runResult({ code: 2, stderr: '  \x1b[0m\nreal' }));

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, { ok: false, error: 'wezterm exited 2', timedOut: false });
  });

  test('a failure without stderr reports the exit code', async () => {
    const runner = fakeRunner(() => runResult({ code: 1, stderr: '' }));

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, { ok: false, error: 'wezterm exited 1', timedOut: false });
  });

  test('a timeout is reported as such', async () => {
    const runner = fakeRunner(() => runResult({ code: null, timedOut: true }));

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, {
      ok: false,
      error: 'wezterm timed out; a tab may have opened',
      timedOut: true,
    });
  });

  test('a program that is not found is not retried outside WSL', async () => {
    const runner = fakeRunner(() => runResult({ code: null, notFound: true }));

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, { ok: false, error: 'wezterm is not installed', timedOut: false });
    assert.equal(runner.calls.length, 1);
  });

  test('an empty WSL_DISTRO_NAME does not count as WSL', async () => {
    const runner = fakeRunner(() => runResult({ code: null, notFound: true }));

    await weztermTerminal({ runner, env: { WSL_DISTRO_NAME: '' } }, null).open(spec);

    assert.equal(runner.calls.length, 1);
  });

  test('in WSL a missing wezterm is retried once as wezterm.exe and that result counts', async () => {
    const seen: RunCall[] = [];
    const runner = fakeRunner((call) => {
      seen.push(call);
      return call.command === 'wezterm'
        ? runResult({ code: null, notFound: true })
        : runResult({ code: 0 });
    });

    const result = await weztermTerminal({ runner, env: { WSL_DISTRO_NAME: 'Ubuntu' } }, null).open(
      spec,
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(
      seen.map((c) => c.command),
      ['wezterm', 'wezterm.exe'],
    );
    assert.deepEqual(seen[1]?.args, ARGS);
    assert.deepEqual(seen[1]?.options, { timeoutMs: 10000 });
  });

  test('in WSL, when wezterm.exe is missing too, the answer is "not installed" after two calls', async () => {
    const runner = fakeRunner(() => runResult({ code: null, notFound: true }));

    const result = await weztermTerminal({ runner, env: { WSL_DISTRO_NAME: 'Ubuntu' } }, null).open(
      spec,
    );

    assert.deepEqual(result, { ok: false, error: 'wezterm is not installed', timedOut: false });
    assert.equal(runner.calls.length, 2);
  });

  test('in WSL a failure of wezterm.exe is reported from its own output', async () => {
    const runner = fakeRunner((call) =>
      call.command === 'wezterm'
        ? runResult({ code: null, notFound: true })
        : runResult({ code: 3, stderr: 'boom\n' }),
    );

    const result = await weztermTerminal({ runner, env: { WSL_DISTRO_NAME: 'Ubuntu' } }, null).open(
      spec,
    );

    assert.deepEqual(result, { ok: false, error: 'boom', timedOut: false });
  });

  test('in WSL a wezterm that is found is not retried', async () => {
    const runner = fakeRunner(() => runResult({ code: 1, stderr: 'x' }));

    await weztermTerminal({ runner, env: { WSL_DISTRO_NAME: 'Ubuntu' } }, null).open(spec);

    assert.equal(runner.calls.length, 1);
  });

  test('a program killed by a signal (no code, no timeout) is reported', async () => {
    const runner = fakeRunner(() => runResult({ code: null }));

    const result = await weztermTerminal({ runner, env: {} }, null).open(spec);

    assert.deepEqual(result, {
      ok: false,
      error: 'wezterm exited without a status',
      timedOut: false,
    });
  });
});

describe('terminalFor', () => {
  test("'here' gives the here terminal", (t) => {
    const { platform } = testPlatform(t);

    assert.equal(terminalFor('here', platform, DEFAULT_CONFIG).name, 'here');
  });

  test("'wezterm' gives the wezterm terminal", (t) => {
    const { platform } = testPlatform(t);

    assert.equal(terminalFor('wezterm', platform, DEFAULT_CONFIG).name, 'wezterm');
  });

  test("'here' reads SKYDECK_HANDOFF from the platform's environment", async (t) => {
    const { platform, sandbox } = testPlatform(t, {
      env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }),
    });

    const result = await terminalFor('here', platform, DEFAULT_CONFIG).open(spec);

    assert.deepEqual(result, { ok: true });
    assert.equal(platform.files.readText(join(sandbox.root, 'handoff')), handoffScript(spec));
  });

  test("'wezterm' uses the configured domain and the platform's runner", async (t) => {
    const { platform, runner } = testPlatform(t);
    const config: Config = { ...DEFAULT_CONFIG, wezterm: { domain: 'WSL:Ubuntu' } };

    const result = await terminalFor('wezterm', platform, config).open(spec);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(runner.calls[0]?.args.slice(0, 5), [
      'cli',
      '--no-auto-start',
      'spawn',
      '--domain-name',
      'WSL:Ubuntu',
    ]);
  });

  test("'wezterm' without a configured domain passes none", async (t) => {
    const { platform, runner } = testPlatform(t);

    await terminalFor('wezterm', platform, DEFAULT_CONFIG).open(spec);

    assert.equal(runner.calls[0]?.args.includes('--domain-name'), false);
  });
});
