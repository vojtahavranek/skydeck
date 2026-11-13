// Runs the real bin/skydeck-hook with nothing on PATH but the six programs design 5.1 allows it.
// The "Claude process" is a `sleep 30` the test starts, so its /proc entries are real.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const hook = fileURLToPath(new URL('../../bin/skydeck-hook', import.meta.url));

const S1 = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';
const INPUT = `{"session_id":"${S1}","hook_event_name":"SessionStart","source":"startup","cwd":"/w"}\n`;
const SLEEP_ARGV_B64 = Buffer.from('sleep\0' + '30\0').toString('base64');

/** A sandbox whose PATH holds only the programs the hook may use. */
function hookSandbox(t: TestContext): Sandbox {
  const s = sandbox(t);
  s.link('sh', 'date', 'cat', 'base64', 'mkdir', 'mv');
  return s;
}

function readStat(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/\n$/, '');
}

/** Starts `sleep 30` and waits until its /proc/<pid>/stat no longer changes. */
async function startProcess(t: TestContext): Promise<number> {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid !== undefined);
  for (let tries = 0; tries < 200; tries++) {
    const before = readStat(pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (before === readStat(pid) && before.split(') ')[1]?.startsWith('S ')) {
      return pid;
    }
  }
  assert.fail('the sleep process never settled');
}

/**
 * The hook gives up without reading its input in some cases (no usable state directory, a date that
 * prints no number). When it has exited before the test has written the input, the write fails with
 * EPIPE. That says nothing about the hook: the test's own assertions on the exit status and on the
 * files decide, so an EPIPE on the child's stdin is dropped and every other error stays one.
 */
function withoutEpipe(error: Error | undefined): Error | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EPIPE' ? undefined : error;
}

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  s: Sandbox,
  event: string,
  env: Record<string, string | undefined> = {},
  input: string = INPUT,
  cwd: string = s.root,
): Ran {
  const result = spawnSync(hook, [event], {
    input,
    env: s.env({ CLAUDE_CODE_SESSION_ID: S1, CLAUDE_CODE_ENTRYPOINT: 'cli', ...env }),
    cwd,
    encoding: 'utf8',
  });
  assert.equal(withoutEpipe(result.error), undefined);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertSilent(ran: Ran): void {
  assert.deepEqual(ran, { status: 0, stdout: '', stderr: '' });
}

/** Starts the hook without waiting for it; resolves with its [exit code, signal] once it has closed. */
function startHook(
  s: Sandbox,
  event: string,
  env: Record<string, string | undefined> = {},
  input: string = INPUT,
): Promise<unknown> {
  const child = spawn(hook, [event], {
    env: s.env({ CLAUDE_CODE_SESSION_ID: S1, CLAUDE_CODE_ENTRYPOINT: 'cli', ...env }),
    cwd: s.root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', (error) => {
    // An EPIPE is dropped; any other error of the stream is thrown, as it is when nobody listens.
    if (withoutEpipe(error) !== undefined) {
      throw error;
    }
  });
  child.stdin.end(input);
  return once(child, 'close');
}

/** The one file in `spool`, as [name, content]. */
function onlySpoolFile(spool: string): [string, string] {
  const names = readdirSync(spool);
  assert.equal(names.length, 1, `spool holds ${JSON.stringify(names)}`);
  const name = names[0] as string;
  return [name, readFileSync(join(spool, name), 'utf8')];
}

function bootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Splits a spool file into its lines before `--` and everything after the `--` line. */
function split(content: string): { head: string[]; body: string } {
  const marker = content.indexOf('\n--\n');
  assert.notEqual(marker, -1, 'no -- line');
  return { head: content.slice(0, marker).split('\n'), body: content.slice(marker + 4) };
}

describe('hook: the spool file', () => {
  test('SessionStart writes every key, then -- and the input unchanged', async (t) => {
    const s = hookSandbox(t);
    const pid = await startProcess(t);
    const spool = join(s.skydeckHome, 'state', 'spool');

    const ran = run(s, 'SessionStart', { CLAUDE_PID: String(pid) });

    assertSilent(ran);
    const [name, content] = onlySpoolFile(spool);
    const { head, body } = split(content);
    const timeLine = head[2] ?? '';
    assert.match(timeLine, /^time_ns=[0-9]{19}$/);
    const timeNs = timeLine.slice('time_ns='.length);
    assert.ok(
      BigInt(timeNs) - nowNs() < 5_000_000_000n && nowNs() - BigInt(timeNs) < 5_000_000_000n,
    );
    assert.ok(name.startsWith(`${timeNs}-${pid}-`), name);
    assert.match(name, new RegExp(`^[0-9]{19}-${pid}-[0-9]+\\.ev$`));
    assert.deepEqual(head, [
      'v=1',
      'event=SessionStart',
      `time_ns=${timeNs}`,
      `claude_pid=${pid}`,
      `session_env=${S1}`,
      'entrypoint_env=cli',
      `boot_id=${bootId()}`,
      `stat=${readStat(pid)}`,
      `pwd=${s.root}`,
      `argv_b64=${SLEEP_ARGV_B64}`,
    ]);
    assert.equal(body, INPUT);
  });

  test('SessionEnd has the same keys except argv_b64', async (t) => {
    const s = hookSandbox(t);
    const pid = await startProcess(t);

    const ran = run(s, 'SessionEnd', { CLAUDE_PID: String(pid) });

    assertSilent(ran);
    const [, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    const { head, body } = split(content);
    assert.match(head[2] ?? '', /^time_ns=[0-9]{19}$/);
    assert.deepEqual(head, [
      'v=1',
      'event=SessionEnd',
      head[2],
      `claude_pid=${pid}`,
      `session_env=${S1}`,
      'entrypoint_env=cli',
      `boot_id=${bootId()}`,
      `stat=${readStat(pid)}`,
      `pwd=${s.root}`,
    ]);
    assert.equal(body, INPUT);
  });

  test('variables that are not set give empty values (design 5.2)', (t) => {
    const s = hookSandbox(t);
    const ran = run(s, 'SessionEnd', {
      CLAUDE_CODE_SESSION_ID: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
    });

    assertSilent(ran);
    const [, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    const { head } = split(content);
    assert.ok(head.includes('session_env='));
    assert.ok(head.includes('entrypoint_env='));
  });

  test('without CLAUDE_PID the name part is 0 and pid, stat and argv are empty', (t) => {
    const s = hookSandbox(t);

    const ran = run(s, 'SessionStart', { CLAUDE_PID: undefined });

    assertSilent(ran);
    const [name, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    assert.match(name, /^[0-9]{19}-0-[0-9]+\.ev$/);
    const { head } = split(content);
    assert.ok(head.includes('claude_pid='));
    assert.ok(head.includes('stat='));
    assert.ok(head.includes('argv_b64='));
  });

  test('a process that does not exist gives empty stat and argv', (t) => {
    const s = hookSandbox(t);

    const ran = run(s, 'SessionStart', { CLAUDE_PID: '999999999' });

    assertSilent(ran);
    const [name, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    assert.match(name, /^[0-9]{19}-999999999-[0-9]+\.ev$/);
    const { head } = split(content);
    assert.ok(head.includes('claude_pid=999999999'));
    assert.ok(head.includes('stat='));
    assert.ok(head.includes('argv_b64='));
  });

  test('a CLAUDE_PID that is not a number is recorded as no pid and never reaches the path', (t) => {
    const s = hookSandbox(t);

    const ran = run(s, 'SessionStart', { CLAUDE_PID: '../../etc' });

    assertSilent(ran);
    const [name, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    assert.match(name, /^[0-9]{19}-0-[0-9]+\.ev$/);
    const { head } = split(content);
    assert.ok(head.includes('claude_pid='));
    assert.ok(head.includes('stat='));
  });

  test('the spool is private to the user', (t) => {
    const s = hookSandbox(t);

    run(s, 'SessionStart', { CLAUDE_PID: undefined });

    const state = join(s.skydeckHome, 'state');
    const spool = join(state, 'spool');
    const [name] = onlySpoolFile(spool);
    assert.equal(statSync(spool).mode & 0o077, 0);
    assert.equal(statSync(join(spool, name as string)).mode & 0o077, 0);
  });
});

describe('hook: a value can never add a line to the file', () => {
  test('a working directory with a newline in its name is written as an empty pwd', (t) => {
    const s = hookSandbox(t);
    const dir = join(s.root, 'd\nentrypoint_env=sdk-cli\nclaude_pid=1');
    mkdirSync(dir);

    const ran = run(s, 'SessionStart', { CLAUDE_PID: undefined }, INPUT, dir);

    assertSilent(ran);
    const [, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    const { head, body } = split(content);
    assert.deepEqual(
      head.map((line) => line.split('=')[0]),
      [
        'v',
        'event',
        'time_ns',
        'claude_pid',
        'session_env',
        'entrypoint_env',
        'boot_id',
        'stat',
        'pwd',
        'argv_b64',
      ],
    );
    assert.ok(head.includes('pwd='));
    assert.ok(head.includes('entrypoint_env=cli'));
    assert.ok(head.includes('claude_pid='));
    assert.equal(body, INPUT);
  });

  test('a session id and an entrypoint with a newline are written empty', (t) => {
    const s = hookSandbox(t);

    const ran = run(s, 'SessionEnd', {
      CLAUDE_PID: undefined,
      CLAUDE_CODE_SESSION_ID: `${S1}\nclaude_pid=1`,
      CLAUDE_CODE_ENTRYPOINT: 'cli\nargv_b64=eA==',
    });

    assertSilent(ran);
    const [, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    const { head } = split(content);
    assert.equal(head.length, 9);
    assert.ok(head.includes('session_env='));
    assert.ok(head.includes('entrypoint_env='));
    assert.ok(head.includes('claude_pid='));
    assert.equal(head.filter((line) => line.startsWith('argv_b64=')).length, 0);
  });

  test('a carriage return is treated like a newline: the value is written empty', (t) => {
    const s = hookSandbox(t);
    const dir = join(s.root, 'd\rentrypoint_env=sdk-cli');
    mkdirSync(dir);

    const ran = run(
      s,
      'SessionEnd',
      {
        CLAUDE_PID: undefined,
        CLAUDE_CODE_SESSION_ID: `${S1}\rx`,
        CLAUDE_CODE_ENTRYPOINT: 'cli\r',
      },
      INPUT,
      dir,
    );

    assertSilent(ran);
    const [, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    const { head } = split(content);
    assert.equal(head.length, 9);
    assert.ok(head.includes('session_env='));
    assert.ok(head.includes('entrypoint_env='));
    assert.ok(head.includes('pwd='));
    assert.equal(content.includes('\r'), false);
  });

  test('a CLAUDE_PID with a newline is recorded as no pid', (t) => {
    const s = hookSandbox(t);

    const ran = run(s, 'SessionEnd', { CLAUDE_PID: '1\nargv_b64=eA==' });

    assertSilent(ran);
    const [name, content] = onlySpoolFile(join(s.skydeckHome, 'state', 'spool'));
    assert.match(name, /^[0-9]{19}-0-[0-9]+\.ev$/);
    assert.equal(split(content).head.length, 9);
  });
});

describe('hook: failures stay silent and exit 0', () => {
  test('a state directory that cannot be created', (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root can write anywhere');
      return;
    }
    const s = hookSandbox(t);
    chmodSync(s.skydeckHome, 0o500);
    try {
      const ran = run(s, 'SessionStart');

      assertSilent(ran);
      assert.deepEqual(readdirSync(s.skydeckHome), []);
    } finally {
      chmodSync(s.skydeckHome, 0o700);
    }
  });

  test('SKYDECK_HOME that is a regular file', (t) => {
    const s = hookSandbox(t);
    const file = join(s.root, 'not-a-directory');
    writeFileSync(file, 'keep');

    const ran = run(s, 'SessionStart', { SKYDECK_HOME: file });

    assertSilent(ran);
    assert.equal(readFileSync(file, 'utf8'), 'keep');
  });

  test('a spool that is a regular file is logged to hook.log', (t) => {
    const s = hookSandbox(t);
    const state = join(s.skydeckHome, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'spool'), '');

    const ran = run(s, 'SessionStart');

    assertSilent(ran);
    assert.notEqual(readFileSync(join(state, 'hook.log'), 'utf8'), '');
  });

  test('a spool that cannot be written to is logged and leaves no .ev file', (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root can write anywhere');
      return;
    }
    const s = hookSandbox(t);
    const spool = join(s.skydeckHome, 'state', 'spool');
    mkdirSync(spool, { recursive: true });
    chmodSync(spool, 0o500);
    try {
      const ran = run(s, 'SessionStart');

      assertSilent(ran);
      assert.deepEqual(
        readdirSync(spool).filter((name) => name.endsWith('.ev')),
        [],
      );
      assert.notEqual(readFileSync(join(s.skydeckHome, 'state', 'hook.log'), 'utf8'), '');
    } finally {
      chmodSync(spool, 0o700);
    }
  });

  test('a date that prints no number of nanoseconds drops the event and says so in hook.log', (t) => {
    const s = hookSandbox(t);
    rmSync(join(s.bin, 'date'));
    writeFileSync(join(s.bin, 'date'), '#!/bin/sh\necho garbage\n', { mode: 0o755 });

    const ran = run(s, 'SessionStart');

    assertSilent(ran);
    const state = join(s.skydeckHome, 'state');
    assert.equal(existsSync(join(state, 'spool')), false);
    const log = readFileSync(join(state, 'hook.log'), 'utf8');
    assert.match(log, /SessionStart/);
    assert.match(log, /garbage/);
  });

  test('a write that fails leaves only the temporary file, never an .ev file', (t) => {
    const s = hookSandbox(t);
    rmSync(join(s.bin, 'cat'));
    writeFileSync(join(s.bin, 'cat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const state = join(s.skydeckHome, 'state');

    const ran = run(s, 'SessionStart', { CLAUDE_PID: undefined });

    assertSilent(ran);
    const names = readdirSync(join(state, 'spool'));
    assert.deepEqual(
      names.filter((name) => name.endsWith('.ev')),
      [],
    );
    assert.notEqual(readFileSync(join(state, 'hook.log'), 'utf8'), '');
  });

  test('an error of two lines is one line of hook.log, with its time', (t) => {
    const s = hookSandbox(t);
    rmSync(join(s.bin, 'cat'));
    writeFileSync(
      join(s.bin, 'cat'),
      '#!/bin/sh\necho "cat: first line" >&2\necho "second line" >&2\nexit 1\n',
      {
        mode: 0o755,
      },
    );
    const state = join(s.skydeckHome, 'state');

    const ran = run(s, 'SessionStart', { CLAUDE_PID: undefined });

    assertSilent(ran);
    const lines = readFileSync(join(state, 'hook.log'), 'utf8').split('\n');
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.equal(lines[1], '');
    assert.match(
      lines[0] ?? '',
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ SessionStart write failed: cat: first line second line$/,
    );
  });

  test('the spool directory is closed to others even under a default ACL', (t) => {
    const s = hookSandbox(t);
    const state = join(s.skydeckHome, 'state');
    mkdirSync(state);
    const acl = spawnSync('setfacl', ['-d', '-m', 'g::rwx,o::rx', state], { stdio: 'ignore' });
    if (acl.error !== undefined || acl.status !== 0) {
      t.skip('setfacl is not available or the file system has no ACLs');
      return;
    }

    const ran = run(s, 'SessionStart', { CLAUDE_PID: undefined });

    assertSilent(ran);
    assert.equal(statSync(join(state, 'spool')).mode & 0o077, 0);
  });

  // The hook gives up before it reads its input in the guard cases. Whether the test's write of the
  // input to the pipe happens before the hook has exited is a race, so a small input fails only
  // now and then; an input larger than the pipe's buffer fails every time.
  const NO_STATE_DIRECTORY = {
    SKYDECK_HOME: undefined,
    XDG_STATE_HOME: undefined,
    HOME: 'relative-home',
  };
  const BIGGER_THAN_A_PIPE = 'x'.repeat(4_000_000);

  test('a hook that exits without reading its input is not an error of the test (spawnSync)', (t) => {
    const s = hookSandbox(t);

    const ran = run(s, 'SessionStart', NO_STATE_DIRECTORY, BIGGER_THAN_A_PIPE);

    assertSilent(ran);
  });

  test('a hook that exits without reading its input is not an error of the test (spawn)', async (t) => {
    const s = hookSandbox(t);

    const exit = await startHook(s, 'SessionStart', NO_STATE_DIRECTORY, BIGGER_THAN_A_PIPE);

    assert.deepEqual(exit, [0, null]);
  });

  test('a real failure to start the hook is still an error of the test', (t) => {
    const s = hookSandbox(t);

    assert.throws(() => run(s, 'SessionStart', {}, INPUT, join(s.root, 'no-such-directory')), {
      code: 'ERR_ASSERTION',
    });
  });

  test('a HOME that is not absolute and no other variable gives up quietly', (t) => {
    const s = hookSandbox(t);

    const ran = run(s, 'SessionStart', {
      SKYDECK_HOME: undefined,
      XDG_STATE_HOME: undefined,
      HOME: 'relative-home',
    });

    assertSilent(ran);
    assert.equal(existsSync(join(s.root, 'relative-home')), false);
    assert.equal(existsSync(join(s.root, '.local')), false);
  });
});

describe('hook: where the state directory is', () => {
  const cases: {
    name: string;
    env: (s: Sandbox) => Record<string, string | undefined>;
    spool: (s: Sandbox) => string;
  }[] = [
    {
      name: 'XDG_STATE_HOME/skydeck when SKYDECK_HOME is unset',
      env: (s) => ({ SKYDECK_HOME: undefined, XDG_STATE_HOME: join(s.root, 'xs') }),
      spool: (s) => join(s.root, 'xs', 'skydeck', 'spool'),
    },
    {
      name: '$HOME/.local/state/skydeck when both are unset',
      env: () => ({ SKYDECK_HOME: undefined }),
      spool: (s) => join(s.home, '.local', 'state', 'skydeck', 'spool'),
    },
    {
      name: 'a relative SKYDECK_HOME counts as unset',
      env: () => ({ SKYDECK_HOME: 'rel' }),
      spool: (s) => join(s.home, '.local', 'state', 'skydeck', 'spool'),
    },
    {
      name: 'an empty SKYDECK_HOME counts as unset',
      env: () => ({ SKYDECK_HOME: '' }),
      spool: (s) => join(s.home, '.local', 'state', 'skydeck', 'spool'),
    },
    {
      name: 'a relative XDG_STATE_HOME counts as unset',
      env: () => ({ SKYDECK_HOME: undefined, XDG_STATE_HOME: 'rel' }),
      spool: (s) => join(s.home, '.local', 'state', 'skydeck', 'spool'),
    },
    {
      name: 'SKYDECK_HOME/state wins over XDG_STATE_HOME',
      env: (s) => ({ XDG_STATE_HOME: join(s.root, 'xs') }),
      spool: (s) => join(s.skydeckHome, 'state', 'spool'),
    },
  ];

  for (const c of cases) {
    test(c.name, (t) => {
      const s = hookSandbox(t);

      const ran = run(s, 'SessionStart', c.env(s));

      assertSilent(ran);
      assert.equal(readdirSync(c.spool(s)).length, 1);
      assert.equal(existsSync(join(s.root, 'rel')), false);
    });
  }
});

describe('hook: concurrency and the programs it uses', () => {
  test('ten hooks at once write ten distinct files', async (t) => {
    const s = hookSandbox(t);
    const pid = await startProcess(t);
    const exits: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      exits.push(startHook(s, 'SessionStart', { CLAUDE_PID: String(pid) }));
    }
    const results = await Promise.all(exits);

    for (const result of results) {
      assert.deepEqual(result, [0, null]);
    }
    const spool = join(s.skydeckHome, 'state', 'spool');
    const names = readdirSync(spool);
    assert.equal(names.length, 10);
    assert.equal(new Set(names).size, 10);
    for (const name of names) {
      assert.match(name, /\.ev$/);
      const { body } = split(readFileSync(join(spool, name), 'utf8'));
      assert.equal(body, INPUT);
    }
  });

  test('the script calls no program besides sh, date, cat, base64, mkdir and mv', () => {
    const code = readFileSync(hook, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const denied = [
      'sed',
      'awk',
      'tr',
      'head',
      'tail',
      'od',
      'node',
      'grep',
      'cut',
      'rm',
      'ls',
      'dirname',
      'basename',
      'env',
      'sleep',
      'touch',
      'tee',
      'wc',
      'xargs',
      'find',
      'expr',
      'readlink',
      'hostname',
      'id',
    ];

    for (const word of denied) {
      assert.doesNotMatch(code, new RegExp(`(^|[^\\w./-])${word}([^\\w./-]|$)`), word);
    }
  });

  test('the script is a POSIX sh script and is executable', () => {
    const text = readFileSync(hook, 'utf8');

    assert.ok(text.startsWith('#!/bin/sh\n'));
    assert.ok((statSync(hook).mode & 0o111) === 0o111);
  });
});
