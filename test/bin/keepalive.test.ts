// Runs the real bin/skydeck-keepalive the way wsl.exe runs it (`/bin/sh <script> <runtimeDir>`):
// the test stands in for wsl.exe, which is never started. Nothing is on PATH but sh and the
// programs the script may use (sleep, mv, rm). The processes it watches are `sleep`s and `sh`s the
// test starts, so their /proc entries are real, except where a test hands it a stand-in for /proc
// (SKYDECK_TEST_PROC) to make an entry unreadable. The interval is 1 s
// (SKYDECK_TEST_KEEPALIVE_SECONDS).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const script = fileURLToPath(new URL('../../bin/skydeck-keepalive', import.meta.url));

const INTERVAL_MS = 1000;
/**
 * The wait for an exit that comes before the loop or from a signal, not from an interval. Generous:
 * on a loaded machine starting a shell can take a second. Where it matters that the exit does not
 * wait for the interval, that interval is far longer (30 s) or the alternative never exits.
 */
const QUICK_MS = 5000;
const BOOT_ID = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
/** A boot id that is not the current one: the same text with its first digit changed. */
const OTHER_BOOT_ID = (BOOT_ID.startsWith('0') ? '1' : '0') + BOOT_ID.slice(1);
const INTEROP = '/run/WSL/1234_interop';
/** Root can read and write whatever the mode says, so the tests that rely on a mode prove nothing. */
const IS_ROOT = process.getuid?.() === 0;
/** A directory name the script must quote everywhere: a space, quotes, glob characters, a newline. */
const ODD_NAME = `dir 'q" *[x]\n`;

/** Field 22 of /proc/<pid>/stat, counted after the last `)` (design 5.5). */
function procStart(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[19]); // fields[0] is field 3, the state
}

/** A pid line of plan contract 2.8; with `keeper`, the two fields a keeper's line adds. */
function pidLine(pid: number, start: number, bootId: string, keeper = false): string {
  return `${pid} ${start} ${bootId}${keeper ? ' 1 0' : ''}\n`;
}

interface Place {
  s: Sandbox;
  /** The runtime directory handed to the script, with an empty `terms/`. */
  dir: string;
}

/**
 * A sandbox whose PATH holds only sh and the programs the keep-alive may use (`programs`), and a
 * runtime directory whose name needs quoting.
 */
function place(t: TestContext, programs: string[] = ['sleep', 'mv', 'rm']): Place {
  const s = sandbox(t);
  s.link('sh', ...programs);
  const dir = join(s.root, `run ${ODD_NAME}`);
  mkdirSync(join(dir, 'terms'), { recursive: true, mode: 0o700 });
  return { s, dir };
}

/**
 * A stand-in for /proc (SKYDECK_TEST_PROC), so that a test can make an entry unreadable: it holds
 * the real boot id in `sys/kernel/random/boot_id` and, for each pid in `live`, a link to the real
 * `/proc/<pid>`. Returns its path.
 */
function fakeProc(p: Place, live: number[] = []): string {
  const proc = join(p.s.root, `proc ${ODD_NAME}`);
  mkdirSync(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
  writeFileSync(join(proc, 'sys', 'kernel', 'random', 'boot_id'), `${BOOT_ID}\n`);
  for (const pid of live) {
    symlinkSync(`/proc/${pid}`, join(proc, String(pid)));
  }
  return proc;
}

function bootIdFile(proc: string): string {
  return join(proc, 'sys', 'kernel', 'random', 'boot_id');
}

interface Live {
  child: ChildProcess;
  pid: number;
  start: number;
  /** Kills it and waits until Node has reaped it, so that its /proc entry is gone. */
  end: () => Promise<void>;
}

/**
 * Starts a real process for a pid line to name: `sleep 60`, or the `command` given. Its standard
 * input is a pipe the test never closes, so a `read` in it waits until the process is killed.
 */
async function liveProcess(
  t: TestContext,
  s: Sandbox,
  command: [string, ...string[]] = [join(s.bin, 'sleep'), '60'],
): Promise<Live> {
  const [program, ...args] = command;
  const child = spawn(program, args, { env: s.env(), stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid !== undefined);
  return {
    child,
    pid,
    start: procStart(pid),
    end: async () => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}

interface Status {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface KeepAlive {
  child: ChildProcess;
  pid: number;
  /** Undefined while it runs. */
  status: () => Status | undefined;
  exited: Promise<Status>;
  stderr: () => string;
}

/** Starts the script as wsl.exe does: `<shell> <script> <args>`, the shell being sh by default. */
function startKeepAlive(
  t: TestContext,
  p: Place,
  options: { args?: string[]; env?: Record<string, string | undefined>; shell?: string } = {},
): KeepAlive {
  const child = spawn(
    options.shell ?? join(p.s.bin, 'sh'),
    [script, ...(options.args ?? [p.dir])],
    {
      env: p.s.env({ SKYDECK_TEST_KEEPALIVE_SECONDS: '1', ...options.env }),
      cwd: p.s.root,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let status: Status | undefined;
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, 'exit').then(([code, signal]) => {
    status = { code: code as number | null, signal: signal as NodeJS.Signals | null };
    return status;
  });
  t.after(() => {
    if (status === undefined) {
      child.kill('SIGKILL');
    }
  });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'the shell did not start');
  return { child, pid, status: () => status, exited, stderr: () => stderr };
}

/** Its exit status, failing when it has not exited within `ms`. */
async function exitsWithin(k: KeepAlive, ms: number): Promise<Status> {
  const result = await Promise.race([k.exited, delay(ms, 'timeout' as const, { ref: false })]);
  assert.notEqual(result, 'timeout', `the keep-alive was still running after ${ms} ms`);
  return result as Status;
}

/** Waits until `check` holds, polling every 10 ms, for at most `ms`. */
async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(10);
  }
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

describe('bin/skydeck-keepalive', { concurrency: true }, () => {
  test('a server.pid naming a live process keeps it; when that process ends it exits 0 and removes keepalive.pid', async (t) => {
    const p = place(t);
    const server = await liveProcess(t, p.s);
    writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
    const k = startKeepAlive(t, p);

    await delay(3 * INTERVAL_MS);
    assert.equal(k.status(), undefined, 'still running after 3 s');
    assert.ok(existsSync(join(p.dir, 'keepalive.pid')));

    await server.end();
    assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
    assert.equal(existsSync(join(p.dir, 'keepalive.pid')), false);
    assert.equal(k.stderr(), '');
  });

  test("a keeper's terms/<id>.pid naming a live process keeps it; when that process ends it exits", async (t) => {
    const p = place(t);
    const keeper = await liveProcess(t, p.s);
    writeFileSync(
      join(p.dir, 'terms', '0123456789ab.pid'),
      pidLine(keeper.pid, keeper.start, BOOT_ID, true),
    );
    const k = startKeepAlive(t, p);

    await delay(3 * INTERVAL_MS);
    assert.equal(k.status(), undefined, 'still running after 3 s');

    await keeper.end();
    assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
    assert.equal(existsSync(join(p.dir, 'keepalive.pid')), false);
    assert.equal(k.stderr(), '');
  });

  test('one live keeper among dead lines keeps it', async (t) => {
    const p = place(t);
    const keeper = await liveProcess(t, p.s);
    writeFileSync(join(p.dir, 'server.pid'), 'garbage\n');
    writeFileSync(join(p.dir, 'terms', 'aaaaaaaaaaaa.pid'), pidLine(1, 1, OTHER_BOOT_ID, true));
    writeFileSync(
      join(p.dir, 'terms', 'bbbbbbbbbbbb.pid'),
      pidLine(keeper.pid, keeper.start, BOOT_ID, true),
    );
    const k = startKeepAlive(t, p);

    await delay(2.5 * INTERVAL_MS);
    assert.equal(k.status(), undefined, 'still running after 2.5 s');
    await keeper.end();
    assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
  });

  describe(
    'lines that do not keep it: it exits 0 within two intervals',
    { concurrency: true },
    () => {
      const cases: [string, (live: Live) => Record<string, string>][] = [
        ['nothing to watch', () => ({})],
        [
          'a live process recorded with another boot id',
          (live) => ({
            'terms/0123456789ab.pid': pidLine(live.pid, live.start, OTHER_BOOT_ID, true),
          }),
        ],
        [
          'a server.pid with another boot id',
          (live) => ({ 'server.pid': pidLine(live.pid, live.start, OTHER_BOOT_ID) }),
        ],
        [
          'the right pid with another process start (a reused pid)',
          (live) => ({
            'terms/0123456789ab.pid': pidLine(live.pid, live.start + 1, BOOT_ID, true),
          }),
        ],
        [
          'garbled lines that name the live pid',
          (live) => ({
            'server.pid': `${live.pid} ${live.start}\n`,
            'terms/000000000001.pid': 'garbage\n',
            'terms/000000000002.pid': '',
            'terms/000000000003.pid': `${live.pid}x ${live.start} ${BOOT_ID}\n`,
            'terms/000000000004.pid': `${live.pid} ${live.start}x ${BOOT_ID}\n`,
            'terms/000000000005.pid': `${live.pid} ${live.start} \n`,
            'terms/000000000006.pid': `${live.pid}\t${live.start}\t${BOOT_ID}\n`,
            'terms/000000000007.pid': `-${live.pid} ${live.start} ${BOOT_ID}\n`,
            'terms/000000000008.pid': ` ${live.start} ${BOOT_ID}\n`,
          }),
        ],
        [
          'a live line in a file that is not <name>.pid',
          (live) => ({
            'terms/0123456789ab.sock': pidLine(live.pid, live.start, BOOT_ID, true),
            'terms/.0123456789ab.pid.1a2b.tmp': pidLine(live.pid, live.start, BOOT_ID, true),
            'keepalive.pid.live': pidLine(live.pid, live.start, BOOT_ID),
          }),
        ],
      ];
      for (const [name, files] of cases) {
        test(name, async (t) => {
          const p = place(t);
          const live = await liveProcess(t, p.s);
          for (const [path, text] of Object.entries(files(live))) {
            writeFileSync(join(p.dir, path), text);
          }
          const k = startKeepAlive(t, p);
          assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
          assert.equal(existsSync(join(p.dir, 'keepalive.pid')), false);
          assert.equal(k.stderr(), '');
        });
      }
    },
  );

  test('keepalive.pid holds its own pid, process start and the boot id; keepalive.interop holds WSL_INTEROP', async (t) => {
    const p = place(t);
    const server = await liveProcess(t, p.s);
    writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
    const k = startKeepAlive(t, p, { env: { WSL_INTEROP: INTEROP } });
    const pidFile = join(p.dir, 'keepalive.pid');
    await waitFor(() => existsSync(pidFile), 5000, 'keepalive.pid');

    assert.equal(read(pidFile), pidLine(k.pid, procStart(k.pid), BOOT_ID));
    assert.equal(read(join(p.dir, 'keepalive.interop')), INTEROP);
    for (const name of ['keepalive.pid', 'keepalive.interop']) {
      assert.equal(statSync(join(p.dir, name)).mode & 0o777, 0o600, `${name} is the user's only`);
    }
    // Nothing else: no temporary file is left behind.
    assert.deepEqual(readdirSync(p.dir).sort(), [
      'keepalive.interop',
      'keepalive.pid',
      'server.pid',
      'terms',
    ]);
    assert.equal(k.status(), undefined);
  });

  test('keepalive.interop is empty when WSL_INTEROP is unset', async (t) => {
    const p = place(t);
    const server = await liveProcess(t, p.s);
    writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
    startKeepAlive(t, p, { env: { WSL_INTEROP: undefined } });
    await waitFor(() => existsSync(join(p.dir, 'keepalive.pid')), 5000, 'keepalive.pid');
    assert.equal(read(join(p.dir, 'keepalive.interop')), '');
  });

  for (const [name, value] of [
    ['a newline', `${INTEROP}\n${INTEROP}`],
    ['a carriage return', `${INTEROP}\r`],
  ]) {
    test(`keepalive.interop is empty when WSL_INTEROP contains ${name}`, async (t) => {
      const p = place(t);
      const server = await liveProcess(t, p.s);
      writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
      startKeepAlive(t, p, { env: { WSL_INTEROP: value } });
      await waitFor(() => existsSync(join(p.dir, 'keepalive.pid')), 5000, 'keepalive.pid');
      assert.equal(read(join(p.dir, 'keepalive.interop')), '');
    });
  }

  // The kernel names a process after the file it was started from: here a symlink of that name to
  // sh, for the keep-alive itself and for the server it watches (an sh waiting in `read`). Not a
  // link to sleep: where sleep is a multi-call binary, it runs no utility under a strange name.
  for (const comm of ['a) b', 'a)\n) b']) {
    test(`a comm of ${JSON.stringify(comm)} still gives the right process start, its own and the server's`, async (t) => {
      const p = place(t);
      const oddShell = join(p.s.bin, comm);
      symlinkSync(realpathSync(join(p.s.bin, 'sh')), oddShell);
      const server = await liveProcess(t, p.s, [oddShell, '-c', 'read -r line']);
      writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
      const k = startKeepAlive(t, p, { shell: oddShell });
      const pidFile = join(p.dir, 'keepalive.pid');
      await waitFor(() => existsSync(pidFile), 5000, 'keepalive.pid');

      for (const pid of [k.pid, server.pid]) {
        assert.ok(readFileSync(`/proc/${pid}/stat`, 'utf8').includes(` (${comm}) `));
      }
      assert.equal(read(pidFile), pidLine(k.pid, procStart(k.pid), BOOT_ID));
      await delay(2.5 * INTERVAL_MS);
      assert.equal(server.child.exitCode, null, 'the server itself still runs');
      assert.equal(k.status(), undefined, 'the server is judged alive: still running');
      await server.end();
      assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
    });
  }

  for (const [signal, code] of [
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    test(`on ${signal} it exits ${code} at once, removes keepalive.pid and stops its sleep`, async (t) => {
      const p = place(t);
      const server = await liveProcess(t, p.s);
      writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
      // A long interval: an exit within a second is the signal's doing, not the loop's.
      const k = startKeepAlive(t, p, { env: { SKYDECK_TEST_KEEPALIVE_SECONDS: '30' } });
      const pidFile = join(p.dir, 'keepalive.pid');
      const children = `/proc/${k.pid}/task/${k.pid}/children`;
      // Its only child once it waits: the sleep (before that, briefly, its mv).
      const sleeping = (): boolean => {
        const pid = (read(children) ?? '').trim();
        return pid !== '' && (read(`/proc/${pid}/stat`) ?? '').includes(' (sleep) ');
      };
      await waitFor(() => existsSync(pidFile) && sleeping(), 5000, 'keepalive.pid and the sleep');
      const sleeper = Number((read(children) ?? '').trim());

      k.child.kill(signal);
      // It exits by itself (128 + the signal's number) rather than dying of the signal.
      assert.deepEqual(await exitsWithin(k, QUICK_MS), { code, signal: null });
      assert.equal(existsSync(pidFile), false);
      await waitFor(
        () => {
          const stat = read(`/proc/${sleeper}/stat`);
          return stat === null || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
        },
        2000,
        'its sleep to end',
      );
    });
  }

  test('a keepalive.pid another keep-alive has written since is left in place', async (t) => {
    const p = place(t);
    const server = await liveProcess(t, p.s);
    writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
    const k = startKeepAlive(t, p);
    const pidFile = join(p.dir, 'keepalive.pid');
    await waitFor(() => existsSync(pidFile), 5000, 'keepalive.pid');
    const other = pidLine(server.pid, server.start, BOOT_ID);
    writeFileSync(pidFile, other);

    await server.end();
    assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
    assert.equal(read(pidFile), other);
  });

  describe(
    'an invalid interval is not a busy loop: the default of 10 s applies',
    { concurrency: true },
    () => {
      for (const value of ['', '0', '00', 'abc', '1.5', '-1', ' 1']) {
        test(JSON.stringify(value), async (t) => {
          const p = place(t);
          const k = startKeepAlive(t, p, { env: { SKYDECK_TEST_KEEPALIVE_SECONDS: value } });
          await delay(1.5 * INTERVAL_MS);
          assert.equal(k.status(), undefined, 'still running after 1.5 s with nothing to watch');
          k.child.kill('SIGTERM');
          await exitsWithin(k, QUICK_MS);
        });
      }
    },
  );

  describe('it refuses to start, exit 2, writing nothing', { concurrency: true }, () => {
    const cases: [string, (p: Place) => string[]][] = [
      ['without an argument', () => []],
      // It exists, relative to the working directory the test gives it.
      ['with a relative directory', (p) => [basename(p.dir)]],
      ['with a directory that does not exist', (p) => [join(p.s.root, 'missing')]],
      ['with a file instead of a directory', (p) => [join(p.dir, 'terms', 'x')]],
      ['with two arguments', (p) => [p.dir, p.dir]],
    ];
    for (const [name, args] of cases) {
      test(name, async (t) => {
        const p = place(t);
        writeFileSync(join(p.dir, 'terms', 'x'), '');
        const k = startKeepAlive(t, p, { args: args(p) });
        assert.deepEqual(await exitsWithin(k, QUICK_MS), { code: 2, signal: null });
        assert.match(k.stderr(), /usage: skydeck-keepalive <runtime directory>/);
        assert.deepEqual(readdirSync(p.dir).sort(), ['terms']);
        assert.deepEqual(readdirSync(join(p.dir, 'terms')), ['x']);
      });
    }
  });

  test('when sleep fails it exits 1 at once rather than looping, and removes keepalive.pid', async (t) => {
    const p = place(t, ['mv', 'rm']);
    const server = await liveProcess(t, p.s, [join(p.s.bin, 'sh'), '-c', 'read -r line']);
    writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
    const k = startKeepAlive(t, p);
    assert.deepEqual(await exitsWithin(k, QUICK_MS), { code: 1, signal: null });
    assert.equal(existsSync(join(p.dir, 'keepalive.pid')), false);
  });

  test('a boot id it cannot read at start: it exits 1 and writes nothing', async (t) => {
    const p = place(t);
    const proc = fakeProc(p);
    rmSync(bootIdFile(proc));
    const k = startKeepAlive(t, p, { env: { SKYDECK_TEST_PROC: proc } });
    assert.deepEqual(await exitsWithin(k, QUICK_MS), { code: 1, signal: null });
    assert.deepEqual(readdirSync(p.dir), ['terms']);
  });

  // Design 5.5 has three answers: alive, dead, unknown. The keep-alive ends only when every line
  // is known dead; a line it cannot judge keeps it (plan task 7, ruled in pull request #34).
  describe(
    'a line it cannot judge keeps it, until the line is known dead',
    { concurrency: true },
    () => {
      test(
        'the boot id cannot be read any more: even a line whose process has ended keeps it',
        { skip: IS_ROOT },
        async (t) => {
          const p = place(t);
          const server = await liveProcess(t, p.s);
          writeFileSync(join(p.dir, 'server.pid'), pidLine(server.pid, server.start, BOOT_ID));
          const proc = fakeProc(p, [server.pid]);
          const k = startKeepAlive(t, p, { env: { SKYDECK_TEST_PROC: proc } });
          await waitFor(() => existsSync(join(p.dir, 'keepalive.pid')), 5000, 'keepalive.pid');

          chmodSync(bootIdFile(proc), 0o000);
          await server.end();
          await delay(2.5 * INTERVAL_MS);
          assert.equal(k.status(), undefined, 'still running while it cannot tell');

          chmodSync(bootIdFile(proc), 0o644);
          assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
        },
      );

      const stats: [string, { mode: number; text: string }, boolean][] = [
        ['/proc/<pid>/stat cannot be read', { mode: 0o000, text: '' }, true],
        ['/proc/<pid>/stat holds no process start', { mode: 0o644, text: '4242 (x) S 1\n' }, false],
      ];
      for (const [name, stat, needsMode] of stats) {
        test(name, { skip: needsMode && IS_ROOT }, async (t) => {
          const p = place(t);
          const proc = fakeProc(p);
          mkdirSync(join(proc, '4242'));
          const statFile = join(proc, '4242', 'stat');
          writeFileSync(statFile, stat.text, { mode: stat.mode });
          writeFileSync(
            join(p.dir, 'terms', '0123456789ab.pid'),
            pidLine(4242, 777, BOOT_ID, true),
          );
          const k = startKeepAlive(t, p, { env: { SKYDECK_TEST_PROC: proc } });

          await delay(2.5 * INTERVAL_MS);
          assert.equal(k.status(), undefined, 'still running while it cannot tell');

          // Now readable, and naming another process start: the line is known dead.
          chmodSync(statFile, 0o644);
          writeFileSync(statFile, `4242 (x) S${' 0'.repeat(18)} 778 0\n`);
          assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
        });
      }

      test('a pid with no /proc entry is known dead', async (t) => {
        const p = place(t);
        const proc = fakeProc(p);
        writeFileSync(join(p.dir, 'server.pid'), pidLine(4242, 777, BOOT_ID));
        const k = startKeepAlive(t, p, { env: { SKYDECK_TEST_PROC: proc } });
        assert.deepEqual(await exitsWithin(k, 2 * INTERVAL_MS), { code: 0, signal: null });
      });
    },
  );

  test(
    'a runtime directory it cannot write to: it exits 1 and leaves nothing behind',
    { skip: IS_ROOT },
    async (t) => {
      const p = place(t);
      const dir = join(p.s.root, 'read-only');
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o500);
      t.after(() => {
        // So that the sandbox can be removed even if something was written; it may be gone already.
        if (existsSync(dir)) chmodSync(dir, 0o700);
      });
      const k = startKeepAlive(t, { ...p, dir });
      const status = await exitsWithin(k, QUICK_MS);
      assert.deepEqual(status, { code: 1, signal: null });
      assert.deepEqual(readdirSync(dir), []);
    },
  );
});

// Outside the concurrent block above: its busy loop holds this process's event loop, which would
// delay the timers and the waits of the tests running beside it.
test('neither file is ever seen half written: a reader in a loop reads whole contents only', async (t) => {
  const p = place(t);
  const pidPattern = new RegExp(`^\\d+ \\d+ ${BOOT_ID}\\n$`);
  for (let run = 0; run < 20; run++) {
    const dir = join(p.s.root, `run-${run}`);
    mkdirSync(join(dir, 'terms'), { recursive: true, mode: 0o700 });
    const k = startKeepAlive(t, { ...p, dir }, { env: { WSL_INTEROP: INTEROP } });
    const seen: { pid: string[]; interop: string[] } = { pid: [], interop: [] };
    // A busy loop on purpose: it reads as often as it can while the script writes.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pid = read(join(dir, 'keepalive.pid'));
      const interop = read(join(dir, 'keepalive.interop'));
      if (pid !== null) seen.pid.push(pid);
      if (interop !== null) seen.interop.push(interop);
      if (pid !== null && interop !== null) break;
    }
    assert.ok(seen.pid.length > 0 && seen.interop.length > 0, `run ${run}: never saw both files`);
    for (const text of seen.pid) {
      assert.match(text, pidPattern, `run ${run}: keepalive.pid read as ${JSON.stringify(text)}`);
    }
    for (const text of seen.interop) {
      assert.equal(text, INTEROP, `run ${run}: keepalive.interop read half written`);
    }
    k.child.kill('SIGTERM');
    await exitsWithin(k, 2 * INTERVAL_MS);
  }
});
