import { spawn } from 'node:child_process';
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
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SkydeckError } from './errors.ts';
import { NS_PER_MS } from './time.ts';
import type {
  Clock,
  FileInfo,
  Files,
  Ns,
  Platform,
  Proc,
  RunOptions,
  RunResult,
  Runner,
} from './types.ts';

/** The real platform: Date/hrtime clock, node:fs, /proc, node:child_process, process.env. */
export function realPlatform(): Platform {
  return {
    clock: realClock(),
    files: realFiles(),
    proc: realProc(),
    runner: realRunner(),
    env: { ...process.env },
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
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
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
  return { size: Number(stats.size), mtimeNs: stats.mtimeNs, kind };
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
    createExclusive(path, text) {
      // Written to a temporary file and linked into place: link() fails when the name exists, and
      // the name never shows a file that is empty or half written.
      const temp = siblingTemp(path);
      try {
        writeFileSync(temp, text, { flag: 'wx' });
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
    remove: (path) => {
      rmSync(path, { force: true });
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
        rmSync(temp, { force: true });
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

function realProc(): Proc {
  const read = (path: string): Buffer | null => {
    try {
      return readFileSync(path);
    } catch {
      return null; // every failure reads as "not there": the process ended, or /proc is not Linux's
    }
  };
  const readLine = (path: string): string | null => {
    const bytes = read(path);
    if (bytes === null) {
      return null;
    }
    const text = bytes.toString('utf8');
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  };
  const isPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;
  return {
    bootId: () => readLine('/proc/sys/kernel/random/boot_id'),
    stat: (pid) => (isPid(pid) ? readLine(`/proc/${pid}/stat`) : null),
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
  };
}

/** After a timeout with the child already gone: how long its last output may still take to arrive. */
const PIPE_GRACE_MS = 100;

function realRunner(): Runner {
  return {
    run(command, args, options: RunOptions = {}) {
      return new Promise<RunResult>((resolve, reject) => {
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
        const settle = (code: number | null, notFound = false): void => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            clearTimeout(graceTimer);
            resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, notFound });
          }
        };

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
          } else if (!settled) {
            settled = true;
            clearTimeout(timer);
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
