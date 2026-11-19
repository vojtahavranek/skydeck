// The stand-in program of plan 2.4 (S2 17.1), started in a real pty that a small python3 helper
// of this file makes (never the keeper, which is task 9). Everything happens in a sandbox: the
// stand-in's hook writes under the sandbox's SKYDECK_HOME, its live file under the sandbox's
// CLAUDE_CONFIG_DIR.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';
import { readRecords, standinCommand, waitForRecord } from '../helpers/standin.ts';
import type { StandinRecord } from '../helpers/standin.ts';

const S1 = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';
const S2 = '1c6a4d2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DA1 = '\x1b[c';
const CPR = '\x1b[6n';
const DA1_ANSWER = '\x1b[?1;2c';
const CPR_ANSWER = '\x1b[5;1R';
const PROMPT = 'standin ';

type StartRecord = Extract<StandinRecord, { ev: 'start' }>;
type AnswerRecord = Extract<StandinRecord, { ev: 'answer' }>;

/**
 * Runs argv[3:] in a new pty of argv[1] columns and argv[2] rows (set before the program starts).
 * stdin goes to the pty, the pty to stdout; it prints "pid <n>" on stderr; fd 3 carries control
 * lines: "resize <cols> <rows>", "signal <n>" (to its child), "killgroup" (SIGKILL to the child's
 * process group). When fd 3 or stdout closes (the test process is gone) it kills the child's
 * process group too. It exits with the child's status (128 + n for a signal).
 */
const PTY_HELPER = `
import fcntl, os, pty, select, signal, struct, sys, termios
cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execv(argv[0], argv)
os.write(2, b'pid %d\\n' % pid)
# Input waits in "pending" while the program does not read, so that its output is still read
# (a blocking write here would stop both directions).
fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
pending = b''
inputs = [0, 3]
ctl = b''
def killgroup():
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
while True:
    readable = [fd] + [i for i in inputs if i != 0 or len(pending) < 1 << 20]
    r, w, _ = select.select(readable, [fd] if pending else [], [])
    if fd in w:
        try:
            pending = pending[os.write(fd, pending):]
        except BlockingIOError:
            pass
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            break
        if data == b'':
            break
        if data:
            try:
                os.write(1, data)
            except BrokenPipeError:
                killgroup()
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            inputs.remove(0)
        pending += data
    if 3 in r:
        data = os.read(3, 4096)
        if not data:
            inputs.remove(3)
            killgroup()
        ctl += data
        while b'\\n' in ctl:
            line, ctl = ctl.split(b'\\n', 1)
            words = line.split()
            if words[0] == b'resize':
                size = struct.pack('HHHH', int(words[2]), int(words[1]), 0, 0)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
            elif words[0] == b'signal':
                try:
                    os.kill(pid, int(words[1]))
                except ProcessLookupError:
                    pass
            elif words[0] == b'killgroup':
                killgroup()
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

const PYTHON = ['/usr/bin/python3', '/bin/python3'].find((p) => existsSync(p));

interface Pty {
  /** The pid of the pty's first process (the stand-in, or the wrapper script). */
  pid: Promise<number>;
  /** The pid of the pty helper itself (this file's python3), the test's own child. */
  helperPid: number;
  /** Everything the program wrote to the terminal so far. */
  output(): Buffer;
  write(data: string | Buffer): void;
  control(line: string): void;
  /** Resolves with the byte offset just after `needle`, searching from `from`. */
  waitFor(needle: string, timeoutMs?: number, from?: number): Promise<number>;
  /** How many prompts were drawn so far. */
  prompts(): number;
  /** The helper's exit code (the program's status); rejects when it takes over `timeoutMs`. */
  exited(timeoutMs?: number): Promise<number | null>;
  /** Closes fd 3, as the death of the test process would. */
  closeControl(): void;
}

function count(haystack: Buffer, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    n++;
  }
  return n;
}

/** Per test, the cleanups of its ptys: run before any sandbox of the test is removed. */
const ptyCleanups = new WeakMap<TestContext, (() => Promise<void>)[]>();

/**
 * A sandbox for a test that starts ptys. Its ptys' cleanup is registered before the sandbox's own
 * (t.after runs first in, first out), as keeperSandbox does, so that every helper and its program
 * are gone before the sandbox is removed: a stand-in whose directory goes first ends itself (A33)
 * and races the pty's after hook.
 */
function ptySandbox(t: TestContext): Sandbox {
  if (!ptyCleanups.has(t)) {
    const cleanups: (() => Promise<void>)[] = [];
    ptyCleanups.set(t, cleanups);
    t.after(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
    });
  }
  return sandbox(t);
}

/** A program in a pty; the test made its sandbox with ptySandbox(t) first. */
function inPty(
  t: TestContext,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  options: { cwd: string; cols?: number; rows?: number },
): Pty {
  assert.ok(PYTHON, 'python3 not found');
  const cleanups = ptyCleanups.get(t);
  assert.ok(cleanups, 'inPty: make the sandbox with ptySandbox(t) first');
  const child: ChildProcess = spawn(
    PYTHON,
    [
      '-I',
      '-c',
      PTY_HELPER,
      String(options.cols ?? 80),
      String(options.rows ?? 24),
      command,
      ...args,
    ],
    { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
  );
  let output = Buffer.alloc(0);
  let stderr = '';
  let exited = false;
  let controlOpen = true;
  child.stdout?.on('data', (chunk: Buffer) => {
    output = Buffer.concat([output, chunk]);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const control = child.stdio[3] as NodeJS.WritableStream;
  // A helper that has just gone answers a write here with EPIPE, asynchronously; one that is
  // ending takes the line in without reading it, and its exit resets the socket (ECONNRESET on
  // our read). Neither is an error of the test: nothing is left to act on the line. Any other
  // error of the pipe still fails it (ruled at review 2 of #62).
  control.on('error', (error: NodeJS.ErrnoException) => {
    controlOpen = false;
    if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') {
      throw error;
    }
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      exited = true;
      resolve(code);
    });
  });
  cleanups.push(async () => {
    if (!exited) {
      // Never into a pipe known to be closed: the helper's end is in, or the pipe ended or failed.
      const gone = child.exitCode !== null || child.signalCode !== null;
      if (controlOpen && !gone && control.writable) {
        control.write('killgroup\n');
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exit;
      clearTimeout(timer);
    }
  });
  const pid = (async () => {
    for (let tries = 0; tries < 500; tries++) {
      const match = /^pid (\d+)$/m.exec(stderr);
      if (match) {
        return Number(match[1]);
      }
      await sleep(10);
    }
    throw new Error(`no pid from the pty helper; stderr: ${stderr}`);
  })();
  assert.ok(child.pid !== undefined, 'the pty helper did not start');
  return {
    pid,
    helperPid: child.pid,
    output: () => output,
    write: (data) => {
      child.stdin?.write(data);
    },
    control: (line) => {
      control.write(`${line}\n`);
    },
    waitFor: async (needle, timeoutMs = 5000, from = 0) => {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const at = output.indexOf(needle, from);
        if (at !== -1) {
          return at + Buffer.byteLength(needle);
        }
        if (performance.now() > deadline) {
          throw new Error(
            `${JSON.stringify(needle)} did not appear; screen: ${JSON.stringify(output.toString('utf8'))}; stderr: ${stderr}`,
          );
        }
        await sleep(10);
      }
    },
    prompts: () => count(output, PROMPT),
    exited: async (timeoutMs = 5000) => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the program did not end within ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([exit, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    closeControl: () => {
      controlOpen = false;
      control.end();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Started {
  s: Sandbox;
  pty: Pty;
  /** The record file (STANDIN_RECORD). */
  record: string;
  start: StartRecord;
}

interface StartOptions {
  args?: readonly string[];
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  wrapper?: boolean;
  /** Answer DA1 and CPR at start (default true) and wait for the prompt. */
  answer?: boolean;
  s?: Sandbox;
}

/** The stand-in in a pty, in a sandbox; with `answer` (the default) its prompt is on screen. */
async function startStandin(t: TestContext, options: StartOptions = {}): Promise<Started> {
  const s = options.s ?? ptySandbox(t);
  const command = standinCommand(s, { wrapper: options.wrapper ?? false });
  const recordDir = join(s.root, 'records');
  mkdirSync(recordDir, { recursive: true });
  const record = join(recordDir, 'standin.jsonl');
  const pty = inPty(
    t,
    command,
    options.args ?? ['--session-id', S1],
    s.env({ STANDIN_RECORD: record, ...options.env }),
    { cwd: s.home, cols: options.cols, rows: options.rows },
  );
  const start = await waitForRecord(record, (r): r is StartRecord => r.ev === 'start', 5000);
  if (options.answer ?? true) {
    await pty.waitFor(DA1);
    pty.write(DA1_ANSWER);
    await pty.waitFor(CPR);
    pty.write(CPR_ANSWER);
    await pty.waitFor(PROMPT);
  }
  return { s, pty, record, start };
}

/** Types `text` and Enter, and waits for the next prompt. */
async function typeLine(pty: Pty, text: string): Promise<void> {
  const before = pty.prompts();
  pty.write(`${text}\r`);
  const deadline = performance.now() + 5000;
  while (pty.prompts() <= before) {
    if (performance.now() > deadline) {
      throw new Error(`no prompt after ${JSON.stringify(text)}: ${pty.output().toString('utf8')}`);
    }
    await sleep(10);
  }
}

interface SpoolEvent {
  event: string;
  claudePid: string;
  sessionEnv: string;
  entrypointEnv: string;
  input: Record<string, unknown>;
}

function spoolEvents(s: Sandbox): SpoolEvent[] {
  const dir = join(s.skydeckHome, 'state', 'spool');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ev') && !name.startsWith('.'))
    .sort()
    .map((name) => {
      const content = readFileSync(join(dir, name), 'utf8');
      const marker = content.indexOf('\n--\n');
      assert.notEqual(marker, -1, `no -- line in ${name}`);
      const keys = new Map(
        content
          .slice(0, marker)
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      return {
        event: keys.get('event') ?? '',
        claudePid: keys.get('claude_pid') ?? '',
        sessionEnv: keys.get('session_env') ?? '',
        entrypointEnv: keys.get('entrypoint_env') ?? '',
        input: JSON.parse(content.slice(marker + 4)) as Record<string, unknown>,
      };
    });
}

/** The live-session file of `pid`, or null when there is none. */
function liveFile(s: Sandbox, pid: number): Record<string, unknown> | null {
  const path = join(s.claudeHome, 'sessions', `${pid}.json`);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : null;
}

function procStat(pid: number): string[] {
  const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return line
    .slice(line.lastIndexOf(')') + 2)
    .trim()
    .split(' ');
}

/** The state letter of `pid` in /proc ('Z': it has ended and is not yet reaped), or null. */
function procState(pid: number): string | null {
  try {
    return procStat(pid)[0] ?? null;
  } catch {
    return null;
  }
}

/** The pids of `pid`'s children, from /proc ([] when it cannot be read). */
function childrenOf(pid: number): number[] {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return text === '' ? [] : text.split(' ').map(Number);
  } catch {
    return [];
  }
}

/** Holds the event loop for `ms`: nothing of Node's (an exit, a pipe's end) is seen meanwhile. */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hex(text: string): string {
  return Buffer.from(text, 'utf8').toString('hex');
}

function inputs(record: string): string[] {
  return readRecords(record).flatMap((r) => (r.ev === 'input' ? [r.hex] : []));
}

describe('stand-in: start', () => {
  test('records its arguments, directory, environment and core limit', async (t) => {
    const { s, start } = await startStandin(t, {
      args: ['--session-id', S1, '--model', 'opus', 'a prompt'],
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', WSL_INTEROP: '/run/WSL/9_interop' },
      cols: 100,
      rows: 30,
    });

    assert.deepEqual(start.argv, ['--session-id', S1, '--model', 'opus', 'a prompt']);
    assert.equal(start.cwd, s.home);
    assert.deepEqual(start.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PWD: s.home,
      WSL_INTEROP: '/run/WSL/9_interop',
    });
    const names = [...start.envNames];
    assert.deepEqual(names, [...names].sort());
    for (const name of ['HOME', 'PATH', 'SKYDECK_HOME', 'CLAUDE_CONFIG_DIR', 'STANDIN_RECORD']) {
      assert.ok(names.includes(name), `${name} in ${names.join(' ')}`);
    }
    const limits = readFileSync('/proc/self/limits', 'utf8');
    const ours = /^Max core file size\s+(\S+)/m.exec(limits)?.[1];
    assert.equal(start.coreSoft, ours);
    assert.equal(start.cols, 100);
    assert.equal(start.rows, 30);
    assert.ok(Math.abs(start.ms - Date.now()) < 10_000);
  });

  test('sends DA1, then CPR, and records both answers', async (t) => {
    const { pty, record } = await startStandin(t);

    const da1At = pty.output().indexOf(DA1);
    assert.ok(da1At !== -1 && da1At < pty.output().indexOf(CPR));
    const records = readRecords(record);
    assert.deepEqual(
      records.filter((r) => r.ev === 'da1').map((r) => (r.ev === 'da1' ? r.answer : '')),
      [DA1_ANSWER],
    );
    assert.deepEqual(
      records.filter((r) => r.ev === 'cpr').map((r) => (r.ev === 'cpr' ? r.answer : '')),
      [CPR_ANSWER],
    );
    // The answers are the terminal's, not input: no input record holds them.
    assert.deepEqual(inputs(record), []);
    // Bracketed paste is turned on with the first prompt, as Claude Code does.
    const paste = pty.output().indexOf('\x1b[?2004h');
    assert.ok(paste !== -1 && paste < pty.output().indexOf(PROMPT), 'mode 2004 before the prompt');
  });

  test('without an answer to DA1 it says so on the screen after 2 s and goes on', async (t) => {
    const { pty, record } = await startStandin(t, { answer: false });
    await pty.waitFor(DA1);
    const asked = performance.now();

    await pty.waitFor('no answer to DA1', 5000);
    const waited = performance.now() - asked;
    const said = performance.now();
    await pty.waitFor(PROMPT);
    const then = performance.now() - said;

    assert.ok(waited >= 1800, `said it after ${waited} ms`);
    assert.ok(then < 1000, `the prompt came ${then} ms after; CPR was waited for`);
    const da1 = readRecords(record).find((r) => r.ev === 'da1');
    assert.deepEqual(da1 && { ev: da1.ev, answer: da1.ev === 'da1' ? da1.answer : '' }, {
      ev: 'da1',
      answer: null,
    });
    // A terminal that does not answer DA1 is not waited for again: CPR is sent, not awaited.
    const cpr = readRecords(record).find((r) => r.ev === 'cpr');
    assert.equal(cpr?.ev === 'cpr' ? cpr.answer : 'missing', null);
    assert.ok(pty.output().includes(CPR));
  });

  test('runs the hook with SessionStart and its pid, and writes an idle live file', async (t) => {
    const { s, start } = await startStandin(t);

    const events = spoolEvents(s);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event?.event, 'SessionStart');
    assert.equal(event?.claudePid, String(start.pid));
    assert.equal(event?.sessionEnv, S1);
    assert.equal(event?.entrypointEnv, 'cli');
    assert.equal(event?.input['session_id'], S1);
    assert.equal(event?.input['hook_event_name'], 'SessionStart');
    assert.equal(event?.input['source'], 'startup');
    assert.equal(event?.input['cwd'], s.home);
    assert.equal(typeof event?.input['transcript_path'], 'string');

    const live = liveFile(s, start.pid);
    assert.ok(live);
    assert.equal(live['pid'], start.pid);
    assert.equal(live['sessionId'], S1);
    assert.equal(live['status'], 'idle');
    assert.equal(live['cwd'], s.home);
    assert.equal(live['procStart'], procStat(start.pid)[19]);
    assert.equal(typeof live['startedAt'], 'number');
    assert.equal(typeof live['updatedAt'], 'number');
  });

  test('$STANDIN_HOOK is not honoured: it always runs bin/skydeck-hook', async (t) => {
    const s = ptySandbox(t);
    const calls = join(s.root, 'hook-calls');
    const hook = join(s.root, 'hook-recorder');
    writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${calls}'\n`);
    chmodSync(hook, 0o755);

    const { start } = await startStandin(t, { s, env: { STANDIN_HOOK: hook } });

    assert.equal(existsSync(calls), false);
    assert.equal(spoolEvents(s)[0]?.claudePid, String(start.pid));
  });

  test('--resume and -r resume the session they name; -n names it', async (t) => {
    const long = await startStandin(t, { args: ['--resume', S2] });
    const short = await startStandin(t, { args: ['-r', S2, '-n', 'my label'] });

    for (const { s, start } of [long, short]) {
      const [event] = spoolEvents(s);
      assert.equal(event?.input['session_id'], S2);
      assert.equal(event?.input['source'], 'resume');
      assert.equal(liveFile(s, start.pid)?.['sessionId'], S2);
    }
    const [named] = spoolEvents(short.s);
    assert.equal(named?.input['session_title'], 'my label');
    assert.equal(liveFile(short.s, short.start.pid)?.['name'], 'my label');
    const [unnamed] = spoolEvents(long.s);
    assert.equal(unnamed?.input['session_title'], undefined);
  });

  test('without a session id it makes one up', async (t) => {
    const { s, start, pty } = await startStandin(t, { args: [] });

    const id = liveFile(s, start.pid)?.['sessionId'];
    assert.equal(typeof id, 'string');
    assert.match(id as string, UUID);
    assert.equal(spoolEvents(s)[0]?.input['session_id'], id);
    assert.ok(pty.output().includes(`${PROMPT}${(id as string).slice(0, 8)}> `));
  });

  test('standinCommand: the program replaces the script; with wrapper: true it is its child', async (t) => {
    const direct = await startStandin(t);
    const wrapped = await startStandin(t, { wrapper: true });

    assert.equal(direct.start.pid, await direct.pty.pid);
    const wrapperPid = await wrapped.pty.pid;
    assert.notEqual(wrapped.start.pid, wrapperPid);
    assert.equal(Number(procStat(wrapped.start.pid)[1]), wrapperPid);
    const wrapperArgv = readFileSync(`/proc/${wrapperPid}/cmdline`, 'utf8').split('\0');
    assert.ok(wrapperArgv.includes(join(wrapped.s.bin, 'claude-standin')), wrapperArgv.join(' '));
  });
});

describe('stand-in: session commands', () => {
  test('/busy, /waiting <what> and /idle set the live file status', async (t) => {
    const { s, pty, start } = await startStandin(t);

    await typeLine(pty, '/busy');
    assert.equal(liveFile(s, start.pid)?.['status'], 'busy');
    await typeLine(pty, '/waiting permission prompt');
    assert.equal(liveFile(s, start.pid)?.['status'], 'waiting');
    assert.equal(liveFile(s, start.pid)?.['waitingFor'], 'permission prompt');
    await typeLine(pty, '/idle');
    assert.equal(liveFile(s, start.pid)?.['status'], 'idle');
    assert.equal(liveFile(s, start.pid)?.['waitingFor'], undefined);
  });

  test('/clear ends the session, starts a new one and the live file names it', async (t) => {
    const { s, pty, start } = await startStandin(t, {
      args: ['--session-id', S1, '-n', 'my label'],
    });

    await typeLine(pty, '/clear');

    const events = spoolEvents(s);
    assert.deepEqual(
      events.map((e) => [e.event, e.input['source'] ?? e.input['reason']]),
      [
        ['SessionStart', 'startup'],
        ['SessionEnd', 'clear'],
        ['SessionStart', 'clear'],
      ],
    );
    assert.equal(events[1]?.input['session_id'], S1);
    const fresh = events[2]?.input['session_id'];
    assert.match(String(fresh), UUID);
    assert.notEqual(fresh, S1);
    assert.equal(events[2]?.sessionEnv, fresh);
    assert.ok(events.every((e) => e.claudePid === String(start.pid)));
    assert.equal(liveFile(s, start.pid)?.['sessionId'], fresh);
    assert.ok(pty.output().includes(`${PROMPT}${String(fresh).slice(0, 8)}> `));
    // The -n name was the first session's; the new one has none.
    assert.equal(events[0]?.input['session_title'], 'my label');
    assert.equal(events[2]?.input['session_title'], undefined);
    assert.equal(liveFile(s, start.pid)?.['name'], undefined);
  });

  test('/exit: SessionEnd prompt_input_exit, the live file removed, exit 0 recorded last', async (t) => {
    const { s, pty, start, record } = await startStandin(t);

    const from = pty.output().length;
    pty.write('/exit\r');

    assert.equal(await pty.exited(), 0);
    assert.deepEqual(
      spoolEvents(s).map((e) => [e.event, e.input['reason'] ?? null]),
      [
        ['SessionStart', null],
        ['SessionEnd', 'prompt_input_exit'],
      ],
    );
    assert.equal(liveFile(s, start.pid), null);
    const last = readRecords(record).at(-1);
    assert.deepEqual(last?.ev === 'exit' && last.code, 0);
    const end = pty.output().subarray(from).toString('utf8');
    assert.ok(end.includes('\x1b[?2004l'), JSON.stringify(end));
    assert.equal(end.includes('\x1b[?1049l'), false, JSON.stringify(end));
  });

  test('/exit on the alternate screen leaves it, then turns bracketed paste off', async (t) => {
    const { pty } = await startStandin(t);
    await typeLine(pty, '/alt');

    const from = pty.output().length;
    pty.write('/exit\r');

    assert.equal(await pty.exited(), 0);
    const end = pty.output().subarray(from).toString('utf8');
    assert.ok(end.includes('\x1b[?1049l\x1b[?2004l'), JSON.stringify(end));
  });

  test('/fail 3 exits 3 with no end event and leaves the live file', async (t) => {
    const { s, pty, start, record } = await startStandin(t);

    pty.write('/fail 3\r');

    assert.equal(await pty.exited(), 3);
    assert.deepEqual(
      spoolEvents(s).map((e) => e.event),
      ['SessionStart'],
    );
    assert.notEqual(liveFile(s, start.pid), null);
    const last = readRecords(record).at(-1);
    assert.deepEqual(last?.ev === 'exit' && last.code, 3);
  });

  test('/fail 300 records the status the process really has (300 mod 256)', async (t) => {
    const { pty, record } = await startStandin(t);

    pty.write('/fail 300\r');

    assert.equal(await pty.exited(), 44);
    const last = readRecords(record).at(-1);
    assert.deepEqual(last?.ev === 'exit' && last.code, 44);
  });
});

describe('stand-in: input', () => {
  test('every chunk is recorded as hex, in order, and echoed so that the test can tell them apart', async (t) => {
    const { pty, record } = await startStandin(t);
    const paste = '\x1b[200~pasted text\x1b[201~';

    await typeLine(pty, 'a');
    pty.write('\n');
    await pty.waitFor('⏎');
    pty.write(paste);
    await pty.waitFor('^[[200~pasted text^[[201~');
    pty.write('\x16');
    await pty.waitFor('^V');

    assert.deepEqual(inputs(record), [hex('a\r'), hex('\n'), hex(paste), hex('\x16')]);
  });

  test('/stall <s> reads no input for that long', async (t) => {
    const { pty, record } = await startStandin(t);

    pty.write('/stall 1\r');
    await pty.waitFor('stalling 1 s');
    const stalled = performance.now();
    pty.write('x');
    await waitForRecord(record, (r) => r.ev === 'input' && r.hex === hex('x'), 5000);
    // Measured here on the monotonic clock: the records' wall-clock times can step back.
    const read = performance.now() - stalled;

    assert.ok(read >= 900, `read after ${read} ms`);
    await pty.waitFor(`${PROMPT}${S1.slice(0, 8)}> x`);
  });

  test('a large paste while it stalls reaches it whole and in order', async (t) => {
    const { pty, record } = await startStandin(t);
    const paste = Buffer.from(
      Array.from({ length: 40_000 }, (_, i) => `${String(i).padStart(6, '0')} paste é 🙂 `).join(
        '',
      ),
      'utf8',
    );

    pty.write('/stall 1\r');
    await pty.waitFor('stalling 1 s');
    pty.write(paste);

    const want = paste.toString('hex');
    const deadline = performance.now() + 20_000;
    let got = '';
    while (got.length < want.length + hex('/stall 1\r').length && performance.now() < deadline) {
      await sleep(50);
      got = inputs(record).join('');
    }
    assert.equal(got, hex('/stall 1\r') + want);
  });
});

describe('stand-in: signals', () => {
  test('SIGWINCH after a size change: a resize record with the new size, and a redraw', async (t) => {
    const { pty, record } = await startStandin(t, { cols: 80, rows: 24 });
    pty.write('half');
    await pty.waitFor('> half');

    pty.control('resize 100 30');

    const resize = await waitForRecord(record, (r) => r.ev === 'resize', 5000);
    assert.deepEqual(resize.ev === 'resize' && [resize.cols, resize.rows], [100, 30]);
    // The size, then the prompt with the line typed so far.
    await pty.waitFor(`size 100x30\r\n${PROMPT}${S1.slice(0, 8)}> half`);
  });

  test('a SIGWINCH that leaves the size as it was records nothing and draws nothing', async (t) => {
    const { pty, record } = await startStandin(t, { cols: 80, rows: 24 });

    pty.control('signal 28');
    await sleep(500);
    pty.control('resize 100 30');
    await waitForRecord(record, (r) => r.ev === 'resize', 5000);

    assert.deepEqual(
      readRecords(record).flatMap((r) => (r.ev === 'resize' ? [[r.cols, r.rows]] : [])),
      [[100, 30]],
    );
    assert.equal(pty.output().includes('size 80x24'), false);
  });

  test('SIGHUP while it waits for DA1: a SessionEnd other with no SessionStart before it', async (t) => {
    const { s, pty, record } = await startStandin(t, { answer: false });
    await pty.waitFor(DA1);

    pty.control('signal 1');

    assert.equal(await pty.exited(), 129);
    assert.deepEqual(
      readRecords(record).map((r) => r.ev),
      ['start', 'hup', 'exit'],
    );
    assert.deepEqual(
      spoolEvents(s).map((e) => [e.event, e.input['reason'] ?? null]),
      [['SessionEnd', 'other']],
    );
  });

  test('SIGHUP: a hup record, SessionEnd other, exit 129 recorded last', async (t) => {
    const { s, pty, start, record } = await startStandin(t);

    pty.control('signal 1');

    assert.equal(await pty.exited(), 129);
    const evs = readRecords(record).map((r) => r.ev);
    assert.deepEqual(evs.slice(-2), ['hup', 'exit']);
    const last = readRecords(record).at(-1);
    assert.deepEqual(last?.ev === 'exit' && last.code, 129);
    assert.deepEqual(
      spoolEvents(s).map((e) => [e.event, e.input['reason'] ?? null]),
      [
        ['SessionStart', null],
        ['SessionEnd', 'other'],
      ],
    );
    assert.equal(liveFile(s, start.pid), null);
  });
});

describe('stand-in: drawing commands', () => {
  test('each command writes its sequence', async (t) => {
    const { pty } = await startStandin(t);
    const cases: [string, string][] = [
      ['/red hi there', '\x1b[31mhi there\x1b[0m'],
      ['/mouse', '\x1b[?1000h\x1b[?1006h'],
      ['/hide-cursor', '\x1b[?25l'],
      ['/cursor 4', '\x1b[4 q'],
      ['/lines 3', 'line 1\r\nline 2\r\nline 3\r\n'],
      ['/osc52 hello', `\x1b]52;c;${Buffer.from('hello').toString('base64')}\x1b\\`],
      [
        '/link https://example.com/x click here',
        '\x1b]8;;https://example.com/x\x1b\\click here\x1b]8;;\x1b\\',
      ],
      ['/title my title', '\x1b]2;my title\x1b\\'],
      ['/wide', '🙂 👩‍💻 👍🏽'],
    ];
    for (const [command, sequence] of cases) {
      const from = pty.output().length;
      await typeLine(pty, command);
      assert.ok(
        pty.output().indexOf(sequence, from) !== -1,
        `${command}: ${JSON.stringify(pty.output().subarray(from).toString('utf8'))}`,
      );
    }
  });

  test('/alt draws a frame on the alternate screen; /main leaves it', async (t) => {
    const { pty } = await startStandin(t, { cols: 40, rows: 10 });

    const from = pty.output().length;
    await typeLine(pty, '/alt');
    const alt = pty.output().subarray(from).toString('utf8');
    assert.ok(alt.includes('\x1b[?1049h'), JSON.stringify(alt));
    assert.ok(alt.includes(`┌${'─'.repeat(38)}┐`), JSON.stringify(alt));
    assert.ok(alt.includes(`└${'─'.repeat(38)}┘`), JSON.stringify(alt));

    // A resize on the alternate screen draws the box again at the new size.
    pty.control('resize 50 12');
    await pty.waitFor(`┌${'─'.repeat(48)}┐`);

    const back = pty.output().length;
    await typeLine(pty, '/main');
    assert.ok(pty.output().indexOf('\x1b[?1049l', back) !== -1);
  });

  test('/flood <bytes> writes exactly that many bytes of numbered lines', async (t) => {
    const { pty } = await startStandin(t);
    const prompt = `${PROMPT}${S1.slice(0, 8)}> `;

    await typeLine(pty, '/flood 100000');

    const out = pty.output();
    const start = out.indexOf('/flood 100000\r\n') + '/flood 100000\r\n'.length;
    const end = out.indexOf(prompt, start);
    // The program writes "\n"; the terminal's ONLCR (kept by Node's raw mode, as for Claude
    // Code) turns each into "\r\n" on the way.
    const flood = out.subarray(start, end).toString('latin1').replaceAll('\r\n', '\n');
    assert.equal(flood.length, 100000);
    assert.match(flood, /^flood 0*1 /);
    assert.ok(flood.includes('flood 00000100 '));
  });

  test('an unknown command says so', async (t) => {
    const { pty } = await startStandin(t);

    await typeLine(pty, '/nonsense x');

    assert.ok(pty.output().includes('unknown command: /nonsense'));
  });
});

describe('stand-in: /query', () => {
  const answers: [string, string][] = [
    ['DA1', '\x1b[?62;22c'],
    ['DA2', '\x1b[>0;276;0c'],
    ['CPR', '\x1b[7;1R'],
    ['DECRQM 2026', '\x1b[?2026;2$y'],
    ['DECRQSS m', '\x1bP1$r0m\x1b\\'],
    ['XTVERSION', '\x1bP>|xterm.js(6.0.0)\x1b\\'],
    ['OSC 10', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
    ['OSC 11', '\x1b]11;rgb:0000/0000/0000\x07'],
  ];
  const queries = [
    '\x1b[c',
    '\x1b[>c',
    '\x1b[6n',
    '\x1b[?2026$p',
    '\x1bP$qm\x1b\\',
    '\x1b[>0q',
    '\x1b]10;?\x1b\\',
    '\x1b]11;?\x1b\\',
  ].join('');

  test('sends the queries and records one answer per query', async (t) => {
    const { pty, record } = await startStandin(t);

    pty.write('/query\r');
    await pty.waitFor(queries);
    // The answers in another order than the queries, in two chunks, with typing between: what
    // answers nothing becomes ONE input record when the query closes.
    const reversed = [...answers].reverse().map(([, answer]) => answer);
    pty.write(`${reversed.slice(0, 4).join('')}z`);
    await sleep(100);
    pty.write('y');
    await sleep(100);
    pty.write(reversed.slice(4).join(''));
    await pty.waitFor(`${PROMPT}${S1.slice(0, 8)}> zy`, 5000, pty.output().indexOf(queries));

    const got = readRecords(record)
      .filter((r): r is AnswerRecord => r.ev === 'answer')
      .map((r) => [r.query, r.answer]);
    assert.deepEqual(got.sort(), [...answers].sort());
    assert.deepEqual(inputs(record), [hex('/query\r'), hex('zy')]);
  });

  test('records no answer when the terminal does not answer, and goes on', async (t) => {
    const { pty, record } = await startStandin(t);

    pty.write('/query\r');
    const asked = await pty.waitFor(queries);
    await pty.waitFor(PROMPT, 5000, asked);
    await typeLine(pty, 'after');

    assert.deepEqual(
      readRecords(record).filter((r) => r.ev === 'answer'),
      [],
    );
    assert.deepEqual(inputs(record), [hex('/query\r'), hex('after\r')]);
  });
});

/** No spool file, record file, live file or state directory anywhere in the sandbox. */
function assertNothingWritten(s: Sandbox): void {
  const everything = readdirSync(s.root, { recursive: true }).map(String);
  assert.deepEqual(
    everything.filter((path) => path.endsWith('.ev') || path.endsWith('.jsonl')),
    [],
  );
  assert.equal(existsSync(join(s.skydeckHome, 'state')), false);
  assert.equal(existsSync(join(s.claudeHome, 'sessions')), false);
  assert.equal(existsSync(join(s.home, '.local')), false);
}

describe('stand-in: refusing to run outside a sandbox (A33)', () => {
  // The variable may only shorten the 10 minutes; anything else is refused before anything runs.
  for (const value of ['', '0', '0.5', '601', '3000000', '-5', '1e2', 'ten', ' 5']) {
    test(`STANDIN_MAX_SECONDS ${JSON.stringify(value)} → exit 2, nothing written`, (t) => {
      const s = sandbox(t);
      const ran = spawnSync(standinCommand(s), ['--session-id', S1], {
        cwd: s.root,
        env: s.env({ STANDIN_RECORD: join(s.root, 'standin.jsonl'), STANDIN_MAX_SECONDS: value }),
        input: '',
        encoding: 'utf8',
        timeout: 10_000,
      });

      assert.equal(ran.status, 2, ran.stderr);
      assert.match(ran.stderr, /STANDIN_MAX_SECONDS/);
      assertNothingWritten(s);
    });
  }

  for (const name of ['STANDIN_RECORD', 'SKYDECK_HOME', 'CLAUDE_CONFIG_DIR'] as const) {
    for (const [what, value] of [
      ['unset', undefined],
      ['empty', ''],
      ['relative', 'relative'],
    ] as const) {
      test(`${name} ${what} → exit 2, nothing written`, (t) => {
        const s = sandbox(t);
        const command = standinCommand(s);
        const record = join(s.root, 'standin.jsonl');
        // Relative values point at the sandbox's own directories, so that a stand-in that
        // accepted them would leave its files where the test looks.
        const relative = {
          STANDIN_RECORD: 'standin.jsonl',
          SKYDECK_HOME: 'skydeck-home',
          CLAUDE_CONFIG_DIR: 'claude-home',
        }[name];
        const ran = spawnSync(command, ['--session-id', S1], {
          cwd: s.root,
          env: s.env({
            STANDIN_RECORD: record,
            [name]: value === 'relative' ? relative : value,
          }),
          input: '',
          encoding: 'utf8',
          timeout: 10_000,
        });

        assert.equal(ran.status, 2, ran.stderr);
        assert.match(ran.stderr, new RegExp(name));
        assertNothingWritten(s);
      });
    }
  }
});

describe('stand-in: --version (follow-up F20)', () => {
  // What `skydeck doctor` asks the program it starts sessions with: one line, as Claude Code
  // prints its version, and nothing else is done.
  test('--version alone: one line on stdout, exit 0, nothing on stderr, nothing written', (t) => {
    const s = sandbox(t);
    const ran = spawnSync(standinCommand(s), ['--version'], {
      cwd: s.root,
      env: s.env({ STANDIN_RECORD: join(s.root, 'standin.jsonl') }),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, '0.0.0-standin (Claude Code)\n');
    assert.equal(ran.stderr, '');
    assertNothingWritten(s);
  });

  test('outside a sandbox --version is refused as everything else is', (t) => {
    const s = sandbox(t);
    const ran = spawnSync(standinCommand(s), ['--version'], {
      cwd: s.root,
      env: s.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(ran.status, 2, ran.stderr);
    assert.equal(ran.stdout, '');
    assert.match(ran.stderr, /STANDIN_RECORD/);
  });
});

describe('stand-in: ending itself (A33)', () => {
  for (const [what, act] of [
    ['a hangup', (pty: Pty) => pty.control('signal 1')],
    ['/clear', (pty: Pty) => pty.write('/clear\r')],
    ['/busy', (pty: Pty) => pty.write('/busy\r')],
    ['/exit', (pty: Pty) => pty.write('/exit\r')],
  ] as const) {
    test(`its record directory gone, then ${what} at once → exit 0, nothing written`, async (t) => {
      const { s, pty, start } = await startStandin(t);
      const live = liveFile(s, start.pid);

      rmSync(join(s.root, 'records'), { recursive: true, force: true });
      rmSync(s.skydeckHome, { recursive: true, force: true });
      act(pty);

      assert.equal(await pty.exited(), 0);
      assert.equal(existsSync(s.skydeckHome), false);
      assert.equal(existsSync(join(s.root, 'records')), false);
      // Not even the live file is touched.
      assert.deepEqual(liveFile(s, start.pid), live);
    });
  }

  test('its record directory gone → exit 0 within 2 s, no hook, nothing written', async (t) => {
    const { s, pty, record } = await startStandin(t);
    const records = readRecords(record).length;
    assert.ok(records > 0);

    rmSync(join(s.root, 'records'), { recursive: true, force: true });
    rmSync(s.skydeckHome, { recursive: true, force: true });
    const removed = performance.now();
    const code = await pty.exited();
    const took = performance.now() - removed;

    assert.equal(code, 0);
    assert.ok(took < 2000, `ended after ${took} ms`);
    assert.equal(existsSync(s.skydeckHome), false);
    assert.equal(existsSync(join(s.root, 'records')), false);
  });

  test('STANDIN_MAX_SECONDS=2 → exit 0 after about 2 s with SessionEnd other', async (t) => {
    const began = performance.now();
    const { s, pty, start, record } = await startStandin(t, {
      env: { STANDIN_MAX_SECONDS: '2' },
    });

    const code = await pty.exited();
    const took = performance.now() - began;

    assert.equal(code, 0);
    assert.ok(took >= 1800 && took < 5000, `ended after ${took} ms`);
    assert.deepEqual(
      spoolEvents(s).map((e) => [e.event, e.input['reason'] ?? null]),
      [
        ['SessionStart', null],
        ['SessionEnd', 'other'],
      ],
    );
    assert.equal(liveFile(s, start.pid), null);
    const last = readRecords(record).at(-1);
    assert.deepEqual(last?.ev === 'exit' && last.code, 0);
  });
});

describe('stand-in: limits on its life', () => {
  test('STANDIN_MAX_SECONDS 600 and 1.5 are taken', async (t) => {
    const long = await startStandin(t, { env: { STANDIN_MAX_SECONDS: '600' } });
    const short = await startStandin(t, { env: { STANDIN_MAX_SECONDS: '1.5' } });

    assert.equal(await short.pty.exited(), 0);
    assert.deepEqual(
      readRecords(long.record).filter((r) => r.ev === 'exit'),
      [],
    );
  });

  test('the pty helper takes the program with it when the test process is gone', async (t) => {
    const { pty, start } = await startStandin(t);

    pty.closeControl();

    assert.equal(await pty.exited(3000), 128 + 9);
    assert.equal(existsSync(`/proc/${start.pid}`), false);
  });
});

describe("stand-in: this file's pty helper", () => {
  // The helper goes first: the program ends, the helper exits, and the test holds the event loop
  // until the helper is a zombie, so that its `after` hook runs before Node has seen the helper's
  // end and sends `killgroup` into a pipe whose other end is closed. That write fails with EPIPE,
  // asynchronously; it must not fail the file ("generated asynchronous activity after the test
  // ended … write EPIPE", seen in a full run under load).
  for (let round = 1; round <= 20; round++) {
    test(`a helper gone before its after hook runs fails nothing (round ${round})`, (t) => {
      const s = ptySandbox(t);
      s.link('true');
      const pty = inPty(t, join(s.bin, 'true'), [], s.env(), { cwd: s.home });

      const deadline = performance.now() + 5000;
      while (procState(pty.helperPid) !== 'Z') {
        assert.ok(performance.now() < deadline, 'the pty helper did not end');
        blockFor(5);
      }
    });
  }

  // A moment earlier: the helper has reaped the program but not yet exited (Python is ending), so
  // `killgroup` is taken in but never read, and the helper's exit resets the socket: Node's read
  // of the pipe fails with ECONNRESET. It must not fail the file either (review 2 of #62).
  for (let round = 1; round <= 20; round++) {
    test(`a helper still ending when its after hook runs fails nothing (round ${round})`, (t) => {
      const s = ptySandbox(t);
      s.link('true');
      const pty = inPty(t, join(s.bin, 'true'), [], s.env(), { cwd: s.home });

      const deadline = performance.now() + 5000;
      let started = false;
      for (;;) {
        const children = childrenOf(pty.helperPid);
        started ||= children.length > 0;
        const state = procState(pty.helperPid);
        if (state === 'Z' || (started && children.length === 0 && state !== null)) break;
        assert.ok(performance.now() < deadline, 'the pty helper did not reap its program');
        blockFor(0.2);
      }
    });
  }
});

describe('stand-in: the helpers', () => {
  test('readRecords: no file → []; an unfinished last line is left out', (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'r.jsonl');
    assert.deepEqual(readRecords(path), []);
    writeFileSync(path, `${JSON.stringify({ pid: 1, ms: 2, ev: 'hup' })}\n{"pid":`);
    assert.deepEqual(readRecords(path), [{ pid: 1, ms: 2, ev: 'hup' }]);
  });

  test('waitForRecord: rejects after its timeout naming what it saw', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'r.jsonl');
    await assert.rejects(
      waitForRecord(path, (r) => r.ev === 'exit', 100),
      /within 100 ms/,
    );
  });

  test('standinCommand twice in one sandbox works', (t) => {
    const s = sandbox(t);
    const first = standinCommand(s);
    const second = standinCommand(s, { wrapper: true });
    assert.equal(first, second);
    for (const program of ['sh', 'date', 'cat', 'base64', 'mkdir', 'mv']) {
      assert.ok(existsSync(join(s.bin, program)), program);
    }
  });
});
