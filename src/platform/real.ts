import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { SkydeckError } from './errors.ts';
import { MAX_TIMER_MS, NS_PER_MS } from './time.ts';
import type {
  Clock,
  Detached,
  Env,
  FileInfo,
  Files,
  Net,
  Ns,
  Platform,
  Proc,
  Processes,
  RunOptions,
  RunResult,
  Runner,
} from './types.ts';

export interface RealPlatformOptions {
  /**
   * Refuse Windows programs whatever the environment says (A32). The test platforms set it;
   * without it they are refused only while SKYDECK_TEST_NO_WINDOWS is 1 in this process's
   * environment or in the one given to the child.
   */
  refuseWindows?: boolean;
}

/** The real platform: Date/hrtime clock, node:fs, /proc, node:child_process, process.env. */
export function realPlatform(options: RealPlatformOptions = {}): Platform {
  const env = { ...process.env };
  const guard = windowsGuard(
    options.refuseWindows === true || env['SKYDECK_TEST_NO_WINDOWS'] === '1',
    env,
  );
  const uid = process.getuid?.() ?? -1;
  return {
    clock: realClock(),
    files: realFiles(),
    proc: realProc(),
    runner: realRunner(guard),
    processes: realProcesses(guard),
    net: realNet(),
    randomBytes: (count) => new Uint8Array(randomBytes(count)),
    pid: process.pid,
    uid,
    userName: userNameOf(uid),
    env,
    homeDir: homedir(),
    // Read when asked: a shell may sit in a directory that was removed, and `--version` must still work.
    get cwd(): string {
      try {
        return process.cwd();
      } catch {
        throw new SkydeckError('the current directory no longer exists');
      }
    },
    uuid: () => randomUUID(),
    nodePath: process.execPath,
    nodeVersion: process.versions.node,
    appRoot: fileURLToPath(new URL('../../', import.meta.url)).replace(/(?<=.)\/$/, ''),
  };
}

/**
 * os.userInfo().username; for a user without a passwd entry (where it throws) the uid as text,
 * which names no lingering file, so the user counts as not lingering.
 */
function userNameOf(uid: number): string {
  try {
    return userInfo().username;
  } catch {
    return String(uid);
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

/** "Does not exist": the path, or a directory on the way to it, is not there. */
function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// The last time handed out, so that a clock that steps backwards cannot make the time go back.
let lastNs: Ns = 0n;

function realClock(): Clock {
  return {
    nowNs(): Ns {
      const now = BigInt(Date.now()) * NS_PER_MS;
      if (now > lastNs) {
        lastNs = now;
      }
      return lastNs;
    },
    monotonicNs(): Ns {
      return process.hrtime.bigint();
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },
    every(ms: number, callback: () => void): () => void {
      if (!Number.isSafeInteger(ms) || ms < 1) {
        throw new RangeError(`not a positive whole number of milliseconds: ${ms}`);
      }
      const timer = setInterval(callback, ms);
      timer.unref(); // whatever reads the keys keeps the process alive, not this
      return () => {
        clearInterval(timer);
      };
    },
    after(ms: number, callback: () => void): () => void {
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMER_MS) {
        throw new RangeError(`not a whole number of milliseconds a timer can wait: ${ms}`);
      }
      const timer = setTimeout(callback, ms);
      timer.unref(); // a socket or a child keeps the process alive, not a pending timer
      return () => {
        clearTimeout(timer);
      };
    },
  };
}

function infoOf(stats: BigIntStats): FileInfo {
  let kind: FileInfo['kind'] = 'other';
  if (stats.isFile()) {
    kind = 'file';
  } else if (stats.isDirectory()) {
    kind = 'dir';
  } else if (stats.isSymbolicLink()) {
    kind = 'symlink';
  }
  return {
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs,
    kind,
    mode: Number(stats.mode & 0o7777n),
    uid: Number(stats.uid),
  };
}

/** `fn()`, or `missing` when it fails because the path does not exist. */
function orIfMissing<T, M>(fn: () => T, missing: M): T | M {
  try {
    return fn();
  } catch (error) {
    if (isMissing(error)) {
      return missing;
    }
    throw error;
  }
}

/**
 * Removes a file or a symbolic link (never what it points to); nothing when it is not there. A
 * directory is refused (EISDIR). unlink, not rmSync: on Node.js 24.12.0 rmSync's check of what a
 * path is follows a symbolic link (24.19.0 looks at the link itself), so it leaves a dangling link
 * in place without an error, with or without `force`, and throws on a link to a directory unless
 * `recursive` is given. Its removal itself never follows a link, on either version.
 */
function unlinkIfThere(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

/** A name beside `path` for a file that will be renamed over it. */
function siblingTemp(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
}

function realFiles(): Files {
  return {
    stat: (path) => orIfMissing(() => infoOf(statSync(path, { bigint: true })), null),
    lstat: (path) => orIfMissing(() => infoOf(lstatSync(path, { bigint: true })), null),
    readText: (path) => orIfMissing(() => readFileSync(path, 'utf8'), null),
    readBytes(path, start, end) {
      const fd = openSync(path, 'r');
      try {
        // Clamped to the file, so that `end` may be "far away" without a huge allocation.
        const length = Math.max(0, Math.min(end, fstatSync(fd).size) - start);
        const buffer = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const n = readSync(fd, buffer, filled, length - filled, start + filled);
          if (n === 0) {
            break;
          }
          filled += n;
        }
        return filled === length ? buffer : buffer.slice(0, filled);
      } finally {
        closeSync(fd);
      }
    },
    list: (dir) => orIfMissing(() => readdirSync(dir).sort(), []),
    writeText(path, text, mode) {
      // Through a symlink the file it points to is replaced and the link stays (a settings file is
      // often one); a dangling link is replaced by the file.
      const target = orIfMissing(
        () => (lstatSync(path).isSymbolicLink() ? realpathSync(path) : path),
        path,
      );
      const newMode = mode ?? orIfMissing(() => statSync(target).mode & 0o7777, undefined);
      const temp = siblingTemp(target);
      try {
        writeFileSync(temp, text, { flag: 'wx', mode: newMode });
        if (newMode !== undefined) {
          chmodSync(temp, newMode); // exact, whatever the umask
        }
        renameSync(temp, target);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
    createExclusive(path, text, mode) {
      // Written to a temporary file and linked into place: link() fails when the name exists, and
      // the name never shows a file that is empty or half written. With a mode, the temporary file
      // is created with it (the umask can only narrow it) and set exactly before it is linked, so
      // the file never has a wider mode, not even for a moment.
      const temp = siblingTemp(path);
      try {
        writeFileSync(temp, text, { flag: 'wx', mode });
        if (mode !== undefined) {
          chmodSync(temp, mode);
        }
        try {
          linkSync(temp, path);
          return true;
        } catch (error) {
          if (errorCode(error) === 'EEXIST') {
            return false;
          }
          throw error;
        }
      } finally {
        rmSync(temp, { force: true });
      }
    },
    mkdirp(path, mode) {
      mkdirSync(path, { recursive: true, mode });
    },
    rename: (from, to) => {
      renameSync(from, to);
    },
    remove: unlinkIfThere,
    rmdir(path) {
      try {
        rmdirSync(path);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    },
    removeTree: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    symlink(target, path) {
      const temp = siblingTemp(path);
      try {
        symlinkSync(target, temp);
        renameSync(temp, path);
      } catch (error) {
        unlinkIfThere(temp);
        throw error;
      }
    },
    readlink(path) {
      try {
        return readlinkSync(path);
      } catch (error) {
        if (isMissing(error) || errorCode(error) === 'EINVAL') {
          return null; // not there, or not a symlink
        }
        throw error;
      }
    },
    realpath(path) {
      try {
        return realpathSync(path);
      } catch (error) {
        if (isMissing(error) || errorCode(error) === 'ELOOP') {
          return null;
        }
        throw error;
      }
    },
    chmod: (path, mode) => {
      chmodSync(path, mode);
    },
  };
}

/** The file, or what a vanished process leaves, is not there: ENOENT, ENOTDIR, ESRCH. */
function isGone(error: unknown): boolean {
  return isMissing(error) || errorCode(error) === 'ESRCH';
}

function realProc(): Proc {
  // Lenient: every failure reads as "not there" (cmdline, meminfo: a caller only loses a detail).
  const read = (path: string): Buffer | null => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  };
  // Strict, for what liveness is judged by (stat, the boot id): null only when the file is not
  // there; any other failure (EACCES, EMFILE, EIO …) is thrown, so that a process that could not be
  // read is never taken for one that is gone.
  const readStrict = (path: string): Buffer | null => {
    try {
      return readFileSync(path);
    } catch (error) {
      if (isGone(error)) {
        return null;
      }
      const code = errorCode(error) ?? 'unknown error';
      throw Object.assign(new SkydeckError(`cannot read ${path} (${code})`), { code });
    }
  };
  const lineOf = (bytes: Buffer | null): string | null => {
    if (bytes === null) {
      return null;
    }
    const text = bytes.toString('utf8');
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  };
  const isPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;
  return {
    bootId: () => lineOf(readStrict('/proc/sys/kernel/random/boot_id')),
    stat: (pid) => (isPid(pid) ? lineOf(readStrict(`/proc/${pid}/stat`)) : null),
    cmdline(pid) {
      const bytes = isPid(pid) ? read(`/proc/${pid}/cmdline`) : null;
      return bytes === null ? null : new Uint8Array(bytes);
    },
    memAvailableMb() {
      const kb = /^MemAvailable:\s+(\d+)\s*kB/m.exec(
        read('/proc/meminfo')?.toString('utf8') ?? '',
      )?.[1];
      return kb === undefined ? null : Math.floor(Number(kb) / 1024);
    },
    fdTarget(pid, fd) {
      if (!isPid(pid) || !Number.isSafeInteger(fd) || fd < 0) {
        return null;
      }
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        return null; // closed, the process ended, or not ours to read
      }
    },
    tcpListening(port) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        return false;
      }
      let readable = false;
      for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const table = read(path)?.toString('utf8');
        if (table === undefined) {
          continue;
        }
        readable = true;
        // "  sl  local_address rem_address   st ...": the address ends in ":<port in hex>"; LISTEN is 0A.
        for (const line of table.split('\n').slice(1)) {
          const [, local, , state] = line.trim().split(/\s+/);
          if (state === '0A' && local !== undefined) {
            if (Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16) === port) {
              return true;
            }
          }
        }
      }
      return readable ? false : null;
    },
  };
}

/** What the Windows guard (A32) looks at: a program under /mnt/ or named *.exe, in any case. */
function isWindowsCommand(command: string): boolean {
  return command.startsWith('/mnt/') || /\.exe$/i.test(command);
}

/** Where execvp looks when the child's environment has no PATH (glibc's default, and more). */
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * Every file `command` can lead execvp to, as text the kernel resolves: the path itself when it
 * holds a '/' (joined to the working directory, not normalised: `a/link/../x` follows `link`
 * first), else `<dir>/<command>` for every directory of `path` (execvp goes on past one it cannot
 * run, so every one counts, not only the first). [] when the working directory is gone.
 */
function candidatesOf(command: string, cwd: string | undefined, path: string): string[] {
  let base: string;
  try {
    base = cwd ?? process.cwd();
  } catch {
    return [];
  }
  const under = (dir: string): string => (dir.startsWith('/') ? dir : `${base}/${dir}`);
  if (command.includes('/')) {
    return [under(command)];
  }
  // An empty entry of PATH is the working directory.
  return path.split(':').map((dir) => `${dir === '' ? base : under(dir)}/${command}`);
}

/**
 * Whether the file starts with "MZ": a Windows program, which WSL interop would run. Only a regular
 * file is opened: opening a FIFO would block this whole process until something writes to it.
 */
function startsWithMz(path: string): boolean {
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) {
      return false; // a FIFO, a device, a directory: nothing interop runs
    }
    fd = openSync(path, 'r');
    const head = new Uint8Array(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x4d && head[1] === 0x5a;
  } catch {
    return false; // not a readable file: nothing interop could run from here
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Whether `candidate`, followed as the kernel follows it, is a Windows program. Judged only when it
 * exists: a PATH directory under /mnt/ that does not hold the program is no reason to refuse (the
 * command's own name is judged by the guard itself).
 */
function leadsToWindows(candidate: string): boolean {
  let real: string;
  try {
    real = realpathSync.native(candidate); // the kernel's resolution, `..` after the link
  } catch {
    return false; // not there: starting it fails as ENOENT
  }
  return isWindowsCommand(candidate) || isWindowsCommand(real) || startsWithMz(real);
}

/**
 * Refuses a Windows program (A32): `command` itself, and every file it can lead to through `PATH`
 * (the child's, or execvp's default when it has none) and symbolic links, judged by name (under
 * /mnt/, *.exe) and by content (a file that starts with "MZ", which is what WSL interop runs).
 * Only the program itself is judged: `sh -c '/mnt/c/…'` is a shell, and runs. Active when
 * `always`, or when the environment given to the child carries SKYDECK_TEST_NO_WINDOWS=1. An Error
 * with `code` 'EWINDOWS' for a refusal, null otherwise.
 */
type WindowsGuard = (
  command: string,
  options: { cwd?: string; env?: Readonly<Record<string, string>> },
) => Error | null;

function windowsGuard(always: boolean, ownEnv: Env): WindowsGuard {
  return (command, options) => {
    if (!always && options.env?.['SKYDECK_TEST_NO_WINDOWS'] !== '1') {
      return null;
    }
    const path = (options.env ?? ownEnv)['PATH'] ?? DEFAULT_PATH;
    if (
      !isWindowsCommand(command) &&
      !candidatesOf(command, options.cwd, path).some(leadsToWindows)
    ) {
      return null;
    }
    return Object.assign(new Error(`refused to start a Windows program under test: ${command}`), {
      code: 'EWINDOWS',
    });
  };
}

/** After a timeout with the child already gone: how long its last output may still take to arrive. */
const PIPE_GRACE_MS = 100;

/**
 * What `run` and `requestUnix` reject with when their signal fires: an Error named AbortError, as
 * Node's own APIs use.
 */
function abortError(what = 'run'): Error {
  return new DOMException(`the ${what} was aborted`, 'AbortError');
}

function realRunner(guard: WindowsGuard): Runner {
  return {
    run(command, args, options: RunOptions = {}) {
      return new Promise<RunResult>((resolve, reject) => {
        const { signal } = options;
        if (signal?.aborted === true) {
          reject(abortError()); // nothing is started
          return;
        }
        const refused = guard(command, options);
        if (refused !== null) {
          reject(refused);
          return;
        }
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let graceTimer: NodeJS.Timeout | undefined;
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                  timedOut = true;
                  child.kill('SIGKILL');
                } else {
                  // The child is gone but something it started still holds the pipes: give what
                  // the child wrote a moment to arrive, then stop waiting for the rest.
                  graceTimer = setTimeout(() => {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    settle(child.exitCode);
                  }, PIPE_GRACE_MS);
                }
              }, options.timeoutMs);
        /** Marks the run as answered; false when it already was. */
        const finish = (): boolean => {
          if (settled) {
            return false;
          }
          settled = true;
          clearTimeout(timer);
          clearTimeout(graceTimer);
          signal?.removeEventListener('abort', abort);
          return true;
        };
        const settle = (code: number | null, notFound = false): void => {
          if (finish()) {
            resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, notFound });
          }
        };
        // The caller no longer wants the answer: the child is killed and nothing it, or something
        // it started, still holds is waited for.
        function abort(): void {
          if (finish()) {
            child.kill('SIGKILL');
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
            reject(abortError());
          }
        }
        signal?.addEventListener('abort', abort, { once: true });

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
        // A child that does not read its input closes the pipe: EPIPE is not an error of ours.
        child.stdin?.on('error', () => {});
        child.on('error', (error) => {
          if (errorCode(error) === 'ENOENT') {
            settle(null, true);
          } else if (finish()) {
            reject(error);
          }
        });
        // A grandchild may hold the pipes open after the child was killed; do not wait for it.
        child.on('exit', () => {
          if (timedOut) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle(null);
          }
        });
        child.on('close', (code) => {
          settle(code);
        });
        if (options.input !== undefined) {
          child.stdin?.end(options.input);
        }
      });
    },
    runInteractive(command, args, options = {}) {
      return new Promise<number | null>((resolve, reject) => {
        const refused = guard(command, options);
        if (refused !== null) {
          reject(refused);
          return;
        }
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: 'inherit',
        });
        child.on('error', (error) => {
          if (errorCode(error) === 'ENOENT') {
            resolve(null);
          } else {
            reject(error);
          }
        });
        child.on('close', (code) => {
          resolve(code);
        });
      });
    },
  };
}

/** Opens `path` for appending, creating it with mode 0o600 (the umask can only narrow it). */
function appendTo(path: string | undefined, opened: number[]): number | 'ignore' {
  if (path === undefined) {
    return 'ignore';
  }
  const fd = openSync(path, 'a', 0o600);
  opened.push(fd);
  return fd;
}

/** Above the largest pid Linux can give (pid_max is at most 2^22): no such process. */
const MAX_PID = 2_147_483_647;

/**
 * Throws a RangeError for a pid that is not a positive whole number: process.kill(0) signals this
 * process's group, -1 every process the user owns, -n the group n. Shared with the test fakes.
 */
export function assertProcessId(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new RangeError(`not a process id: ${pid}`);
  }
}

function realProcesses(guard: WindowsGuard): Processes {
  return {
    startDetached(command, args, options) {
      return new Promise<Detached>((resolve, reject) => {
        const refused = guard(command, options);
        if (refused !== null) {
          reject(refused);
          return;
        }
        const opened: number[] = [];
        let child: ChildProcess;
        try {
          const stdio: StdioOptions = [
            options.input === undefined ? 'ignore' : 'pipe',
            appendTo(options.stdoutTo, opened),
            appendTo(options.stderrTo, opened),
          ];
          // detached: setsid(), a session of its own, so no SIGHUP from this process's terminal.
          child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            detached: true,
            stdio,
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        } finally {
          // The child has its own copies once spawn returned (fork and exec happen inside it).
          for (const fd of opened) {
            closeSync(fd);
          }
        }
        const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
          child.on('exit', (code, signal) => {
            done({ code, signal });
          });
        });
        let started = false;
        child.on('error', (error) => {
          if (!started) {
            reject(error); // ENOENT: the program or the working directory does not exist
          }
        });
        child.once('spawn', () => {
          started = true;
          child.unref();
          resolve({ pid: child.pid ?? 0, exited });
        });
        if (options.input !== undefined && child.stdin !== null) {
          const stdin = child.stdin as Socket;
          stdin.on('error', () => {}); // a child that does not read closes the pipe: not our error
          stdin.end(options.input);
          stdin.unref();
        }
      });
    },
    signal(pid, signal) {
      assertProcessId(pid);
      if (pid > MAX_PID) {
        return false; // no process has it, and process.kill would throw a TypeError
      }
      try {
        process.kill(pid, signal);
        return true;
      } catch (error) {
        if (errorCode(error) === 'ESRCH') {
          return false;
        }
        throw error;
      }
    },
  };
}

/** A JSON answer as its value, other text as the text, nothing as null. */
function answerBody(text: string): unknown {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function realNet(): Net {
  return {
    listenHttp(where, handlers) {
      return new Promise((resolve, reject) => {
        const server = createServer();
        const sockets = new Set<Duplex>();
        server.on('connection', (socket: Duplex) => {
          sockets.add(socket);
          socket.once('close', () => {
            sockets.delete(socket);
          });
        });
        server.on('request', handlers.request);
        if (handlers.upgrade !== undefined) {
          server.on('upgrade', handlers.upgrade);
        }
        server.once('error', reject);
        server.once('listening', () => {
          server.off('error', reject);
          server.on('error', () => {}); // a failed accept must not end the process
          const address = server.address();
          resolve({
            port: typeof address === 'object' && address !== null ? address.port : 0,
            close: () =>
              new Promise<void>((done) => {
                server.close(() => {
                  done();
                });
                for (const socket of sockets) {
                  socket.destroy();
                }
              }),
          });
        });
        if ('path' in where) {
          // The socket is created by bind() inside listen(): with this umask it has mode 0o600 from
          // its first moment.
          const umask = process.umask(0o177);
          try {
            server.listen(where.path);
          } finally {
            process.umask(umask);
          }
        } else {
          server.listen(where.port, '127.0.0.1'); // loopback only (principle 8), whatever was passed
        }
      });
    },
    connectUnix(path) {
      return new Promise((resolve, reject) => {
        const socket = createConnection({ path });
        const fail = (error: Error): void => {
          socket.destroy();
          reject(error);
        };
        socket.once('error', fail);
        socket.once('connect', () => {
          socket.off('error', fail);
          resolve(socket);
        });
      });
    },
    requestUnix(path, request) {
      const { timeoutMs, signal } = request;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) {
        // Node would wait 1 ms for such a timer: refused as Clock.after refuses it.
        return Promise.reject(
          new RangeError(`not a whole number of milliseconds a timer can wait: ${timeoutMs}`),
        );
      }
      if (signal?.aborted === true) {
        return Promise.reject(abortError('request')); // nothing is sent
      }
      return new Promise((resolve, reject) => {
        const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
        const headers: Record<string, string> =
          payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              };
        const req = httpRequest({
          socketPath: path,
          method: request.method,
          path: request.path,
          headers,
          agent: false,
        });
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const abort = (): void => {
          fail(abortError('request'));
        };
        const fail = (error: unknown): void => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            req.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const succeed = (answer: { status: number; body: unknown }): void => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            resolve(answer);
          }
        };
        signal?.addEventListener('abort', abort, { once: true });
        const arm = (): void => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            fail(withCode(`no answer on ${path} within ${request.timeoutMs} ms`, 'ETIMEDOUT'));
          }, request.timeoutMs);
        };
        arm();
        req.on('error', fail);
        req.on('response', (res) => {
          const { onLine } = request;
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
            if (onLine === undefined) {
              return;
            }
            arm(); // a stream that keeps coming is not cut off
            try {
              for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n')) {
                const line = text.slice(0, end);
                text = text.slice(end + 1);
                onLine(line);
              }
            } catch (error) {
              fail(error);
            }
          });
          res.on('end', () => {
            if (onLine === undefined) {
              succeed({ status: res.statusCode ?? 0, body: answerBody(text) });
              return;
            }
            try {
              if (text !== '') {
                onLine(text);
              }
              succeed({ status: res.statusCode ?? 0, body: null });
            } catch (error) {
              fail(error);
            }
          });
          res.on('close', () => {
            if (!res.complete) {
              fail(withCode(`the answer on ${path} was cut off`, 'ECONNRESET'));
            }
          });
        });
        req.end(payload);
      });
    },
  };
}
