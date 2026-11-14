import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import { DEFAULT_CONFIG } from '../../src/platform/config.ts';
import type { Detached, Net, Platform, Proc } from '../../src/platform/types.ts';
import type { Interop } from '../../src/window/interop.ts';
import { createKeepAlive } from '../../src/window/keepalive.ts';
import type { KeepAlive } from '../../src/window/keepalive.ts';
import { formatPidLine } from '../../src/window/pidline.ts';
import type { KeepAlivePayload } from '../../src/window/protocol.ts';
import { runtimeFiles } from '../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../src/window/runtime.ts';
import {
  BOOT_A,
  BOOT_B,
  T0,
  fakeClock,
  fakeProcesses,
  realTestPlatform,
  statLine,
  testPlatform,
} from '../helpers/platform.ts';
import type {
  DetachedCall,
  FakeClock,
  FakeProc,
  FakeProcesses,
  TestPlatform,
} from '../helpers/platform.ts';

// The pure fake processes record wsl.exe's command line and start nothing (A32): no test here can
// reach a Windows program, whatever the code under test does.

const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe';
const DISTRO = 'Ubuntu-24.04';
const APP_ROOT = '/opt/skydeck';
const LINK = '/run/user/1000/skydeck-0a1b2c3d/interop';
/** The keep-alive script's pid inside WSL, and its process start. */
const SCRIPT_PID = 777;
const SCRIPT_START = 4242;

/** A started wsl.exe whose end the test decides. */
interface Child {
  detached: Detached;
  exit(code: number | null, signal?: string | null): void;
}

function child(pid: number): Child {
  let settle: (value: { code: number | null; signal: string | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    settle = resolve;
  });
  return {
    detached: { pid, exited },
    exit: (code, signal = null) => {
      settle({ code, signal });
    },
  };
}

/** An interop link that always holds `link`. */
function fixedInterop(link: string | null): Interop {
  return { refresh: () => Promise.resolve(link), current: () => link };
}

interface Setup {
  tp: TestPlatform;
  platform: Platform;
  clock: FakeClock;
  proc: FakeProc;
  processes: FakeProcesses;
  files: RuntimeFiles;
  children: Child[];
  keepAlive: KeepAlive;
  /** Every state onChange gave, in order. */
  changes: KeepAlivePayload[];
}

/** The C: drive in these tests: task 24's stand-in for /mnt/c (only a path: the processes are fakes). */
const C_DRIVE = '/stand-in/c';

function setup(
  t: TestContext,
  options: {
    mode?: 'wsl' | 'off';
    env?: Record<string, string | undefined>;
    /** Answers startDetached; default: a new Child each time, pids from 5001. */
    handler?: (call: DetachedCall) => Detached | Promise<Detached>;
    proc?: (proc: FakeProc) => Proc;
    net?: (net: Net) => Net;
    /** Replaces the fake processes' signal (it is called after the fake recorded the call). */
    signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
  } = {},
): Setup {
  const tp = testPlatform(t, {
    env: { WSL_DISTRO_NAME: DISTRO, SKYDECK_TEST_MNT_C: C_DRIVE, ...options.env },
  });
  const children: Child[] = [];
  const processes = fakeProcesses(
    options.handler ??
      (() => {
        const started = child(5001 + children.length);
        children.push(started);
        return started.detached;
      }),
  );
  const { signal } = options;
  const platform: Platform = {
    ...tp.platform,
    processes:
      signal === undefined
        ? processes
        : {
            ...processes,
            signal: (pid, name) => {
              processes.signals.push({ pid, signal: name });
              return signal(pid, name);
            },
          },
    proc: options.proc?.(tp.proc) ?? tp.proc,
    net: options.net?.(tp.platform.net) ?? tp.platform.net,
  };
  const dir = join(tp.sandbox.root, 'run');
  mkdirSync(join(dir, 'terms'), { recursive: true, mode: 0o700 });
  const files = runtimeFiles(dir);
  const keepAlive = createKeepAlive({
    platform,
    window: { ...DEFAULT_CONFIG.window, keepAlive: options.mode ?? 'wsl' },
    files,
    appRoot: APP_ROOT,
    interop: fixedInterop(LINK),
  });
  const changes: KeepAlivePayload[] = [];
  keepAlive.onChange((state) => {
    changes.push(state);
  });
  return {
    tp,
    platform,
    clock: tp.clock,
    proc: tp.proc,
    processes,
    files,
    children,
    keepAlive,
    changes,
  };
}

/** The keep-alive script's command line, as wsl.exe --exec starts it. */
function scriptCmdline(s: Setup): string[] {
  return ['/bin/sh', `${APP_ROOT}/bin/skydeck-keepalive`, s.files.dir];
}

/** What the keep-alive script writes when it starts: its own live line. */
function scriptWritesItsLine(
  s: Setup,
  pid = SCRIPT_PID,
  procStart = SCRIPT_START,
  cmdline: readonly string[] = scriptCmdline(s),
): void {
  s.proc.setProcess(pid, { stat: statLine(pid, procStart, 'sh'), cmdline });
  writeFileSync(s.files.keepalivePid, formatPidLine({ pid, procStart, bootId: BOOT_A }));
}

/** The script ends: its process is gone and it removed its line. */
function scriptEnds(s: Setup, pid = SCRIPT_PID): void {
  s.proc.setProcess(pid, null);
  rmSync(s.files.keepalivePid, { force: true });
}

/** Lets the callbacks of a settled `exited` run, as they would between two ticks. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function now(s: Setup): string {
  return String(s.clock.nowNs());
}

function lastChild(s: Setup): Child {
  const last = s.children.at(-1);
  assert.ok(last !== undefined, 'a wsl.exe was started');
  return last;
}

/** Advances to just before `ms` and ticks (no start), then to `ms` and ticks (a start). */
async function startsAgainAfter(s: Setup, ms: number): Promise<void> {
  const before = s.processes.calls.length;
  s.clock.advanceMs(ms - 1);
  await s.keepAlive.tick();
  assert.equal(s.processes.calls.length, before, `no start before ${ms} ms`);
  s.clock.advanceMs(1);
  await s.keepAlive.tick();
  assert.equal(s.processes.calls.length, before + 1, `a start after ${ms} ms`);
  assert.equal(s.keepAlive.state().state, 'starting');
}

// ---------------------------------------------------------------------------------------------
// Starting

test('mode wsl with no keepalive.pid starts wsl.exe with the design arguments, detached, in /mnt/c', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  assert.equal(s.processes.calls.length, 1);
  const [call] = s.processes.calls;
  assert.ok(call !== undefined);
  assert.equal(call.command, WSL_EXE);
  assert.deepEqual(call.args, [
    '-d',
    DISTRO,
    '-u',
    'tester',
    '--exec',
    '/bin/sh',
    `${APP_ROOT}/bin/skydeck-keepalive`,
    s.files.dir,
  ]);
  assert.deepEqual(Object.keys(call.options).sort(), ['cwd', 'env']); // stdio ignored
  assert.equal(call.options.cwd, C_DRIVE);
  assert.equal(call.options.env.WSL_INTEROP, LINK);
  assert.deepEqual(s.keepAlive.state(), {
    mode: 'wsl',
    state: 'starting',
    since: now(s),
    error: null,
  });
});

test('a started keep-alive is running once its script has written a live line, and nothing more is started', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  await s.keepAlive.tick(); // no line yet: still starting, no second start
  assert.equal(s.keepAlive.state().state, 'starting');
  s.clock.advanceMs(1000);
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  assert.deepEqual(s.keepAlive.state(), {
    mode: 'wsl',
    state: 'running',
    since: now(s),
    error: null,
  });
  s.clock.advanceMs(60_000);
  await s.keepAlive.tick();
  assert.equal(s.processes.calls.length, 1);
  assert.deepEqual(
    s.changes.map((c) => c.state),
    ['running'],
  );
});

test('a live keepalive.pid (a keep-alive started before) starts nothing: running', async (t) => {
  const s = setup(t);
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  await s.keepAlive.tick();
  assert.deepEqual(s.processes.calls, []);
  assert.deepEqual(s.keepAlive.state(), {
    mode: 'wsl',
    state: 'running',
    since: now(s),
    error: null,
  });
});

test('a keepalive.pid naming a live process the test started (real /proc) starts nothing; its end does', async (t) => {
  // The keep-alive's own processes stay the pure fake: only the test's `sleep` is real.
  const real = realTestPlatform(t);
  const sleep = await real.platform.processes.startDetached('sleep', ['30'], {
    cwd: real.sandbox.home,
    env: real.sandbox.env(),
  });
  // Signalled only while it has not ended: once reaped, its pid may be another process's.
  let ended = false;
  void sleep.exited.then(() => {
    ended = true;
  });
  t.after(async () => {
    if (!ended) {
      real.platform.processes.signal(sleep.pid, 'SIGKILL');
      await sleep.exited;
    }
  });
  const stat = real.proc.stat(sleep.pid);
  const procStart = stat === null ? null : procStartFromStat(stat);
  const bootId = real.proc.bootId();
  assert.ok(procStart !== null && bootId !== null);

  const dir = join(real.sandbox.root, 'run');
  mkdirSync(join(dir, 'terms'), { recursive: true, mode: 0o700 });
  const files = runtimeFiles(dir);
  writeFileSync(files.keepalivePid, formatPidLine({ pid: sleep.pid, procStart, bootId }));
  const processes = fakeProcesses();
  const clock = fakeClock(T0);
  const keepAlive = createKeepAlive({
    platform: {
      ...real.platform,
      clock,
      processes,
      env: { ...real.platform.env, WSL_DISTRO_NAME: DISTRO, SKYDECK_TEST_MNT_C: C_DRIVE },
    },
    window: { ...DEFAULT_CONFIG.window, keepAlive: 'wsl' },
    files,
    appRoot: APP_ROOT,
    interop: fixedInterop(LINK),
  });
  await keepAlive.tick();
  assert.equal(keepAlive.state().state, 'running');
  assert.equal(processes.calls.length, 0);

  assert.equal(ended, false, 'the sleep still runs');
  real.platform.processes.signal(sleep.pid, 'SIGKILL');
  await sleep.exited;
  await keepAlive.tick();
  assert.equal(keepAlive.state().state, 'failed');
  clock.advanceMs(5_000);
  await keepAlive.tick();
  assert.equal(processes.calls.length, 1);
  assert.equal(processes.calls[0]?.command, WSL_EXE);
});

test('a keepalive.pid that cannot be judged counts as alive: nothing is started', async (t) => {
  const cases: [string, (proc: FakeProc) => Proc][] = [
    ['no boot id', (proc) => ({ ...proc, bootId: () => null })],
    [
      'a stat that cannot be read',
      (proc) => ({
        ...proc,
        stat: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      }),
    ],
    ['a stat without a process start', (proc) => ({ ...proc, stat: () => '777 (sh) S 1' })],
  ];
  for (const [name, proc] of cases) {
    const s = setup(t, { proc });
    scriptWritesItsLine(s);
    await s.keepAlive.tick();
    assert.deepEqual(s.processes.calls, [], name);
    assert.equal(s.keepAlive.state().state, 'running', name);
  }
});

test('a keepalive.pid that cannot be read counts as alive: nothing is started', async (t) => {
  const s = setup(t);
  mkdirSync(s.files.keepalivePid); // reading it fails with EISDIR, not "missing"
  await s.keepAlive.tick();
  assert.deepEqual(s.processes.calls, []);
  assert.equal(s.keepAlive.state().state, 'running');
});

test('a dead or garbled keepalive.pid does not hold a start back', async (t) => {
  const cases: [string, (s: Setup) => void][] = [
    [
      'another boot',
      (s) => {
        s.proc.setProcess(SCRIPT_PID, { stat: statLine(SCRIPT_PID, SCRIPT_START), cmdline: [] });
        writeFileSync(
          s.files.keepalivePid,
          formatPidLine({ pid: SCRIPT_PID, procStart: SCRIPT_START, bootId: BOOT_B }),
        );
      },
    ],
    [
      'a gone pid',
      (s) => {
        writeFileSync(
          s.files.keepalivePid,
          formatPidLine({ pid: SCRIPT_PID, procStart: SCRIPT_START, bootId: BOOT_A }),
        );
      },
    ],
    [
      'a reused pid',
      (s) => {
        s.proc.setProcess(SCRIPT_PID, { stat: statLine(SCRIPT_PID, 99), cmdline: [] });
        writeFileSync(
          s.files.keepalivePid,
          formatPidLine({ pid: SCRIPT_PID, procStart: SCRIPT_START, bootId: BOOT_A }),
        );
      },
    ],
    [
      'a garbled line',
      (s) => {
        writeFileSync(s.files.keepalivePid, 'not a pid line\n');
      },
    ],
  ];
  for (const [name, arrange] of cases) {
    const s = setup(t);
    arrange(s);
    await s.keepAlive.tick();
    assert.equal(s.processes.calls.length, 1, name);
    assert.equal(s.keepAlive.state().state, 'starting', name);
  }
});

test('a second tick while wsl.exe is being started starts no second one', async (t) => {
  const answers: ((detached: Detached) => void)[] = [];
  const s = setup(t, {
    handler: () =>
      new Promise<Detached>((resolve) => {
        answers.push(resolve);
      }),
  });
  const first = s.keepAlive.tick();
  const second = s.keepAlive.tick();
  for (const [i, answer] of answers.entries()) {
    answer(child(5001 + i).detached);
  }
  await Promise.all([first, second]);
  await s.keepAlive.tick();
  assert.equal(s.processes.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------
// When it ends: notices and the retry schedule

test('the started keep-alive gone at a tick: failed with the error through onChange', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  s.clock.advanceMs(10_000);
  scriptEnds(s);
  lastChild(s).exit(0);
  await settle();
  await s.keepAlive.tick();
  const failed = s.keepAlive.state();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.mode, 'wsl');
  assert.equal(failed.since, now(s));
  assert.ok(failed.error !== null && failed.error.includes('wsl.exe'), String(failed.error));
  assert.deepEqual(
    s.changes.map((c) => c.state),
    ['running', 'failed'],
  );
  assert.deepEqual(s.changes.at(-1), failed);
  // A tick while it is down changes nothing and says nothing.
  s.clock.advanceMs(1000);
  await s.keepAlive.tick();
  assert.deepEqual(s.keepAlive.state(), failed);
  assert.equal(s.changes.length, 2);
});

test('a keep-alive is restarted after 5 s, then 30 s, then every 5 minutes (fake clock)', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  await s.keepAlive.tick();

  const endNow = async (): Promise<void> => {
    scriptEnds(s);
    lastChild(s).exit(1);
    await settle();
    await s.keepAlive.tick();
    assert.equal(s.keepAlive.state().state, 'failed');
  };

  await endNow();
  await startsAgainAfter(s, 5_000);
  await endNow();
  await startsAgainAfter(s, 30_000);
  await endNow();
  await startsAgainAfter(s, 300_000);
  await endNow();
  await startsAgainAfter(s, 300_000);
  await endNow();
  await startsAgainAfter(s, 300_000);
  assert.equal(s.processes.calls.length, 6);
});

test('the error while it is down says how wsl.exe ended', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  lastChild(s).exit(1);
  await settle();
  await s.keepAlive.tick();
  const { error } = s.keepAlive.state();
  assert.ok(error !== null && error.includes('exit 1'), String(error));

  await startsAgainAfter(s, 5_000);
  lastChild(s).exit(null, 'SIGKILL');
  await settle();
  await s.keepAlive.tick();
  const signalled = s.keepAlive.state().error;
  assert.ok(signalled !== null && signalled.includes('SIGKILL'), String(signalled));
});

test('a keep-alive that ran for 5 minutes starts the schedule over at 5 s', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  for (const delay of [5_000, 30_000]) {
    lastChild(s).exit(1);
    await settle();
    await s.keepAlive.tick();
    await startsAgainAfter(s, delay);
  }
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  s.clock.advanceMs(300_000);
  scriptEnds(s);
  lastChild(s).exit(0);
  await settle();
  await s.keepAlive.tick();
  await startsAgainAfter(s, 5_000);
});

test('a keep-alive that ran less than 5 minutes goes on with the schedule', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  lastChild(s).exit(1); // one end first: a reset would now show as 5 s instead of 30 s
  await settle();
  await s.keepAlive.tick();
  await startsAgainAfter(s, 5_000);
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  s.clock.advanceMs(299_999);
  scriptEnds(s);
  lastChild(s).exit(0);
  await settle();
  await s.keepAlive.tick();
  await startsAgainAfter(s, 30_000);
});

test('a keep-alive found running whose line goes dead is restarted after 5 s', async (t) => {
  const s = setup(t);
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  scriptEnds(s);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  await startsAgainAfter(s, 5_000);
});

test("the script's line of a wsl.exe that ended is not taken for a running keep-alive", async (t) => {
  // wsl.exe ended (killed on the Windows side) while its script lives on: WSL is no longer held.
  const s = setup(t);
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  lastChild(s).exit(null, 'SIGTERM');
  await settle();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  // The server ends its own orphaned helper: one SIGTERM, its identity known alive.
  const term = [{ pid: SCRIPT_PID, signal: 'SIGTERM' }];
  assert.deepEqual(s.processes.signals, term);
  await s.keepAlive.tick(); // the fake TERM ends nothing: the orphan's line still lives
  await startsAgainAfter(s, 5_000);
  assert.deepEqual(s.processes.signals, term, 'exactly one SIGTERM');
  // The new script writes its own line; that one counts.
  scriptWritesItsLine(s, SCRIPT_PID + 1, SCRIPT_START + 1);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  assert.deepEqual(s.processes.signals, term);
});

test("an orphan's line still there when the next wsl.exe ends before its script started gets no second SIGTERM", async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  lastChild(s).exit(null, 'SIGTERM');
  await settle();
  await s.keepAlive.tick(); // one SIGTERM; the fake ends nothing, so the line stays
  await startsAgainAfter(s, 5_000);
  lastChild(s).exit(1); // before its own script wrote a line: the orphan's is the one there
  await settle();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  assert.deepEqual(s.processes.signals, [{ pid: SCRIPT_PID, signal: 'SIGTERM' }]);
});

test('the error says whether the keep-alive ran: an orphan left in keepalive.pid is not the next wsl.exe script', async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  lastChild(s).exit(null, 'SIGTERM');
  await settle();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().error, 'the keep-alive ended (wsl.exe signal SIGTERM)');
  await startsAgainAfter(s, 5_000);
  lastChild(s).exit(1); // before its own script ran; the orphan's line is still in the file
  await settle();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().error, 'wsl.exe ended before the keep-alive started (exit 1)');
  await startsAgainAfter(s, 30_000);
});

test('an orphan whose line cannot be judged gets no SIGTERM', async (t) => {
  let unreadable = false;
  const s = setup(t, {
    proc: (proc) => ({
      ...proc,
      stat: (pid) => {
        if (unreadable) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return proc.stat(pid);
      },
    }),
  });
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  unreadable = true; // the line is now 'unknown'
  lastChild(s).exit(null, 'SIGTERM');
  await settle();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  await startsAgainAfter(s, 5_000);
  assert.deepEqual(s.processes.signals, []);
});

test("the script's line first seen at the tick that sees wsl.exe's end is not taken for a running keep-alive", async (t) => {
  // Ticks come a second apart: the script can write its line and wsl.exe end in between.
  const s = setup(t);
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  lastChild(s).exit(null, 'SIGTERM');
  await settle();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  await startsAgainAfter(s, 5_000);
  // Only inferred to be this wsl.exe's script, and keepalive.interop says nothing: no SIGTERM.
  assert.deepEqual(s.processes.signals, []);
});

for (const [name, arrange, signals] of [
  [
    'refused or gone',
    (_t: TestContext, s: Setup) => {
      writeFileSync(s.files.keepaliveInterop, join(s.tp.sandbox.root, 'gone.sock'));
    },
    [{ pid: SCRIPT_PID, signal: 'SIGTERM' }],
  ],
  [
    'accepting',
    async (t: TestContext, s: Setup) => {
      await interopAccepts(t, s);
    },
    [],
  ],
] as const) {
  test(`a line only inferred to be the ended wsl.exe's script is signalled only when its socket is ${name}`, async (t) => {
    // Two servers' keep-alives can cross: another one's healthy script may be the line seen.
    const s = setup(t);
    await s.keepAlive.tick();
    scriptWritesItsLine(s);
    await arrange(t, s);
    lastChild(s).exit(1);
    await settle();
    await s.keepAlive.tick();
    assert.equal(s.keepAlive.state().state, 'failed');
    assert.deepEqual(s.processes.signals, signals);
    await startsAgainAfter(s, 5_000);
  });
}

test("the script's line that could not be read while wsl.exe ran is not taken for a running keep-alive", async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  mkdirSync(s.files.keepalivePid); // unreadable: counts as alive, but names no line
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  rmSync(s.files.keepalivePid, { recursive: true });
  scriptWritesItsLine(s);
  lastChild(s).exit(null, 'SIGTERM');
  await settle();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  await startsAgainAfter(s, 5_000);
});

test("the script's line seen dead ends the keep-alive even before wsl.exe's end is seen", async (t) => {
  const s = setup(t);
  await s.keepAlive.tick();
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  scriptEnds(s);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  await startsAgainAfter(s, 5_000);
});

test('a start that fails is failed with the reason and retried on the same schedule', async (t) => {
  let fail = true;
  const s = setup(t, {
    handler: () => {
      if (fail) {
        throw Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' });
      }
      return child(6000).detached;
    },
  });
  await s.keepAlive.tick();
  const { state, error } = s.keepAlive.state();
  assert.equal(state, 'failed');
  assert.ok(error !== null && error.includes('ENOENT'), String(error));
  assert.deepEqual(
    s.changes.map((c) => c.state),
    ['failed'],
  );

  /** Ticks just before `ms` (no start) and at `ms` (one start). */
  const triesAgainAfter = async (ms: number): Promise<void> => {
    const before = s.processes.calls.length;
    s.clock.advanceMs(ms - 1);
    await s.keepAlive.tick();
    assert.equal(s.processes.calls.length, before, `no start before ${ms} ms`);
    s.clock.advanceMs(1);
    await s.keepAlive.tick();
    assert.equal(s.processes.calls.length, before + 1, `a start after ${ms} ms`);
  };
  await triesAgainAfter(5_000); // fails again, with the same reason: nothing new to say
  assert.equal(s.keepAlive.state().state, 'failed');
  fail = false;
  await triesAgainAfter(30_000);
  assert.equal(s.keepAlive.state().state, 'starting');
  assert.deepEqual(
    s.changes.map((c) => c.state),
    ['failed', 'starting'],
  );
});

// ---------------------------------------------------------------------------------------------
// A keep-alive this server did not start, judged by its keepalive.interop (ruled, review 2)

/** keepalive.interop names a unix socket in the sandbox that accepts connections. */
async function interopAccepts(t: TestContext, s: Setup): Promise<{ close(): Promise<void> }> {
  const path = join(s.tp.sandbox.root, 'ka.sock');
  const listener = await s.platform.net.listenHttp(
    { path },
    {
      request: (_req, res) => {
        res.end();
      },
    },
  );
  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await listener.close(); // removes the socket file: the path is then gone
    }
  };
  t.after(close);
  writeFileSync(s.files.keepaliveInterop, path);
  return { close };
}

const TERM_SCRIPT = [{ pid: SCRIPT_PID, signal: 'SIGTERM' }];

test('a keep-alive found running is taken when its keepalive.interop socket accepts', async (t) => {
  const s = setup(t);
  scriptWritesItsLine(s);
  await interopAccepts(t, s);
  await s.keepAlive.tick();
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  assert.deepEqual(s.processes.calls, []);
  assert.deepEqual(s.processes.signals, []);
});

for (const [name, arrange] of [
  [
    'refuses a connection',
    (s: Setup) => {
      const path = join(s.tp.sandbox.root, 'not-a-socket');
      writeFileSync(path, '');
      writeFileSync(s.files.keepaliveInterop, path);
    },
  ],
  [
    'is gone',
    (s: Setup) => {
      writeFileSync(s.files.keepaliveInterop, join(s.tp.sandbox.root, 'gone.sock'));
    },
  ],
] as const) {
  test(`a keep-alive found running whose keepalive.interop socket ${name} is an orphan: one SIGTERM, then a start`, async (t) => {
    const s = setup(t);
    scriptWritesItsLine(s);
    arrange(s);
    await s.keepAlive.tick();
    assert.deepEqual(s.processes.signals, TERM_SCRIPT);
    assert.equal(s.processes.calls.length, 1);
    assert.equal(s.keepAlive.state().state, 'starting');
    await s.keepAlive.tick(); // the fake TERM ends nothing: the orphan's line still lives
    s.clock.advanceMs(300_000);
    await s.keepAlive.tick();
    assert.deepEqual(s.processes.signals, TERM_SCRIPT, 'exactly one SIGTERM');
    assert.equal(s.processes.calls.length, 1);
  });
}

const NOT_JUDGED: [string, (s: Setup) => void, ((net: Net) => Net)?][] = [
  ['no keepalive.interop', () => {}],
  [
    'an empty keepalive.interop',
    (s) => {
      writeFileSync(s.files.keepaliveInterop, '');
    },
  ],
  [
    'a relative path',
    (s) => {
      writeFileSync(s.files.keepaliveInterop, 'run/WSL/1_interop');
    },
  ],
  [
    'more than one line',
    (s) => {
      writeFileSync(s.files.keepaliveInterop, '/x\n/y');
    },
  ],
  [
    'an unreadable keepalive.interop',
    (s) => {
      mkdirSync(s.files.keepaliveInterop);
    },
  ],
  [
    'another error (ENOTDIR)',
    (s) => {
      const file = join(s.tp.sandbox.root, 'file');
      writeFileSync(file, '');
      writeFileSync(s.files.keepaliveInterop, join(file, 'sock'));
    },
  ],
];
for (const [name, arrange] of NOT_JUDGED) {
  test(`a keep-alive found running with ${name} is not judged: running, nothing started or signalled`, async (t) => {
    const s = setup(t);
    scriptWritesItsLine(s);
    arrange(s);
    await s.keepAlive.tick();
    assert.equal(s.keepAlive.state().state, 'running');
    assert.deepEqual(s.processes.calls, []);
    assert.deepEqual(s.processes.signals, []);
  });
}

test('a keepalive.interop connection that does not answer in time is not judged: running', async (t) => {
  const s = setup(t, {
    net: (net) => ({ ...net, connectUnix: () => new Promise(() => {}) }),
  });
  scriptWritesItsLine(s);
  writeFileSync(s.files.keepaliveInterop, join(s.tp.sandbox.root, 'silent.sock'));
  const ticked = s.keepAlive.tick();
  s.clock.advanceMs(2_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    ticked.then(() => 'answered'),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 2_000, 'hung'); // the test's own wait, not the code's clock
    }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, 'answered', 'the tick waits no longer than the probe');
  assert.equal(s.keepAlive.state().state, 'running');
  assert.deepEqual(s.processes.calls, []);
  assert.deepEqual(s.processes.signals, []);
});

test('an unknown line whose keepalive.interop is refused does not count as running, and gets no SIGTERM', async (t) => {
  const s = setup(t, { proc: (proc) => ({ ...proc, bootId: () => null }) });
  scriptWritesItsLine(s);
  writeFileSync(s.files.keepaliveInterop, join(s.tp.sandbox.root, 'gone.sock'));
  await s.keepAlive.tick();
  assert.equal(s.processes.calls.length, 1);
  assert.deepEqual(s.processes.signals, []);
});

test('a line of another boot is never signalled', async (t) => {
  const s = setup(t);
  s.proc.setProcess(SCRIPT_PID, { stat: statLine(SCRIPT_PID, SCRIPT_START), cmdline: [] });
  writeFileSync(
    s.files.keepalivePid,
    formatPidLine({ pid: SCRIPT_PID, procStart: SCRIPT_START, bootId: BOOT_B }),
  );
  writeFileSync(s.files.keepaliveInterop, join(s.tp.sandbox.root, 'gone.sock'));
  await s.keepAlive.tick();
  assert.equal(s.processes.calls.length, 1);
  assert.deepEqual(s.processes.signals, []);
});

test('a keep-alive found running whose socket later goes: failed, one SIGTERM, restarted after 5 s', async (t) => {
  const s = setup(t);
  scriptWritesItsLine(s);
  const socket = await interopAccepts(t, s);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  await socket.close();
  s.clock.advanceMs(2_999);
  await s.keepAlive.tick(); // an accepting socket is asked again only after 3 s
  assert.equal(s.keepAlive.state().state, 'running');
  s.clock.advanceMs(1);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  assert.deepEqual(s.processes.signals, TERM_SCRIPT);
  await startsAgainAfter(s, 5_000);
  assert.deepEqual(s.processes.signals, TERM_SCRIPT, 'exactly one SIGTERM');
});

test('a found keep-alive whose socket accepts is asked again every 3 s; after any other answer at once', async (t) => {
  let connects = 0;
  let refuse: string | null = null;
  const s = setup(t, {
    net: (net) => ({
      ...net,
      connectUnix: (path) => {
        connects++;
        return refuse === null
          ? net.connectUnix(path)
          : Promise.reject(Object.assign(new Error(refuse), { code: refuse }));
      },
    }),
  });
  scriptWritesItsLine(s);
  await interopAccepts(t, s);
  await s.keepAlive.tick();
  assert.equal(connects, 1);
  for (let i = 0; i < 2; i++) {
    s.clock.advanceMs(1_000);
    await s.keepAlive.tick();
  }
  assert.equal(connects, 1, 'not again within 3 s');
  s.clock.advanceMs(1_000);
  await s.keepAlive.tick();
  assert.equal(connects, 2, 'again after 3 s');
  refuse = 'EACCES'; // no judgement: running, and asked again at the next tick
  s.clock.advanceMs(3_000);
  await s.keepAlive.tick();
  s.clock.advanceMs(1_000);
  await s.keepAlive.tick();
  assert.equal(connects, 4);
  assert.equal(s.keepAlive.state().state, 'running');
  assert.deepEqual(s.processes.signals, []);
});

test("a found keep-alive's wsl.exe gone right after its socket accepted is replaced within 9 s, inside WSL's 15 s", async (t) => {
  // S2 6: WSL stops 15 s after its last Windows client. 3 s until the socket is asked again, one
  // tick, the first 5 s retry: the new wsl.exe starts by 9 s on the fake clock (with real timers a
  // timer due at a tick fires after it, one tick more: just under 10 s), room left for its start.
  const s = setup(t);
  scriptWritesItsLine(s);
  const socket = await interopAccepts(t, s);
  await s.keepAlive.tick(); // accepted at 0 s
  await socket.close(); // its wsl.exe, and with it the session's socket, goes at once
  let ms = 0;
  while (s.processes.calls.length === 0 && ms < 15_000) {
    s.clock.advanceMs(1_000); // the server's tick, every second
    ms += 1_000;
    await s.keepAlive.tick();
  }
  assert.equal(s.processes.calls.length, 1);
  assert.ok(ms <= 9_000, `the new wsl.exe started after ${ms} ms`);
});

test('after a found keep-alive is lost, the next one found is asked at every tick until its socket accepts', async (t) => {
  let connects = 0;
  let refuse: string | null = null;
  const s = setup(t, {
    net: (net) => ({
      ...net,
      connectUnix: (path) => {
        connects++;
        return refuse === null
          ? net.connectUnix(path)
          : Promise.reject(Object.assign(new Error(refuse), { code: refuse }));
      },
    }),
  });
  scriptWritesItsLine(s);
  await interopAccepts(t, s);
  await s.keepAlive.tick(); // accepted: not asked again for 3 s
  scriptEnds(s);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'failed');
  // Another keep-alive's line is there when the retry is due; its socket gives no judgement.
  scriptWritesItsLine(s, SCRIPT_PID + 1, SCRIPT_START + 1);
  refuse = 'EACCES';
  s.clock.advanceMs(5_000);
  await s.keepAlive.tick();
  assert.equal(s.keepAlive.state().state, 'running');
  await s.keepAlive.tick();
  assert.equal(connects, 3, 'asked at the adoption and again at the next tick');
  assert.deepEqual(s.processes.calls, []);
});

// ---------------------------------------------------------------------------------------------
// The SIGTERM reaches only a keep-alive script of this runtime directory (ruled, review 2)

/** A found keep-alive whose socket is gone: an orphan, which gets the SIGTERM if anything does. */
function orphanFound(s: Setup, cmdline?: readonly string[]): void {
  scriptWritesItsLine(s, SCRIPT_PID, SCRIPT_START, cmdline);
  writeFileSync(s.files.keepaliveInterop, join(s.tp.sandbox.root, 'gone.sock'));
}

test("an orphan whose command line is this runtime directory's keep-alive script gets the SIGTERM", async (t) => {
  const s = setup(t);
  orphanFound(s);
  await s.keepAlive.tick();
  assert.deepEqual(s.processes.signals, TERM_SCRIPT);
});

for (const [name, cmdline] of [
  ['another program', ['sleep', '30']],
  ['a keeper', ['python3', '/run/skydeck/keeper-abc.py', '0123456789ab']],
  [
    'the keep-alive of another runtime directory',
    ['/bin/sh', `${APP_ROOT}/bin/skydeck-keepalive`, '/elsewhere/run'],
  ],
  ['a script named like it', ['/bin/sh', `${APP_ROOT}/bin/skydeck-keepalive-old`, 'RUNTIME']],
  ['an empty command line', []],
] as const) {
  test(`an orphan whose command line is ${name} gets no SIGTERM, and a new keep-alive is started`, async (t) => {
    const s = setup(t);
    orphanFound(
      s,
      cmdline.map((arg) => (arg === 'RUNTIME' ? s.files.dir : arg)),
    );
    await s.keepAlive.tick();
    assert.deepEqual(s.processes.signals, []);
    assert.equal(s.processes.calls.length, 1);
    assert.equal(s.keepAlive.state().state, 'starting');
  });
}

test('an orphan whose command line cannot be read gets no SIGTERM', async (t) => {
  const s = setup(t, { proc: (proc) => ({ ...proc, cmdline: () => null }) });
  orphanFound(s);
  await s.keepAlive.tick();
  assert.deepEqual(s.processes.signals, []);
  assert.equal(s.processes.calls.length, 1);
});

test('a SIGTERM that fails does not stop the start of a new keep-alive', async (t) => {
  const s = setup(t, {
    signal: () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    },
  });
  orphanFound(s);
  await s.keepAlive.tick();
  assert.deepEqual(s.processes.signals, TERM_SCRIPT);
  assert.equal(s.processes.calls.length, 1);
  assert.equal(s.keepAlive.state().state, 'starting');
});

// ---------------------------------------------------------------------------------------------
// Off, and no distribution

test('mode off never starts anything and is off', async (t) => {
  const s = setup(t, { mode: 'off' });
  const off = { mode: 'off', state: 'off', since: null, error: null };
  assert.deepEqual(s.keepAlive.state(), off);
  for (let i = 0; i < 5; i++) {
    await s.keepAlive.tick();
    s.clock.advanceMs(300_000);
  }
  assert.deepEqual(s.processes.calls, []);
  assert.deepEqual(s.keepAlive.state(), off);
  assert.deepEqual(s.changes, []);
});

for (const [name, value] of [
  ['unset', undefined],
  ['empty', ''],
] as const) {
  test(`WSL_DISTRO_NAME ${name}: failed with a reason, nothing started, never retried`, async (t) => {
    const s = setup(t, { env: { WSL_DISTRO_NAME: value } });
    await s.keepAlive.tick();
    const failed = s.keepAlive.state();
    assert.equal(failed.mode, 'wsl');
    assert.equal(failed.state, 'failed');
    assert.ok(
      failed.error !== null && failed.error.includes('WSL_DISTRO_NAME'),
      failed.error ?? '',
    );
    for (let i = 0; i < 5; i++) {
      s.clock.advanceMs(300_000);
      await s.keepAlive.tick();
    }
    assert.deepEqual(s.processes.calls, []);
    assert.deepEqual(s.keepAlive.state(), failed);
  });
}

test('the state a listener gets is a copy: changing it changes nothing', async (t) => {
  const s = setup(t);
  scriptWritesItsLine(s);
  await s.keepAlive.tick();
  const given = s.changes.at(-1);
  assert.ok(given !== undefined);
  given.state = 'off';
  s.keepAlive.state().state = 'off';
  assert.equal(s.keepAlive.state().state, 'running');
});
