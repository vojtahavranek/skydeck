/** Nanoseconds since the Unix epoch. */
export type Ns = bigint;

/** Wall clock. `sleep` resolves after `ms` milliseconds; the fake one advances its time instead. */
export interface Clock {
  nowNs(): Ns;
  /**
   * A reading of a clock that cannot step (CLOCK_MONOTONIC): it never goes back and never jumps,
   * whatever the wall clock does (WSL steps `nowNs`'s clock now and then). Its value is no time of
   * day; only the difference of two readings means something — how long passed between them. For
   * what must count real time: a wait that a step of the wall clock must neither stretch nor cut
   * short (plan C20's expectation of the window, task 74).
   */
  monotonicNs(): Ns;
  sleep(ms: number): Promise<void>;
  /**
   * Calls `callback` every `ms` milliseconds (a positive whole number; RangeError otherwise) until
   * the returned function is called (calling it again does nothing). The real clock's timer does
   * not keep the process alive by itself; the fake one calls `callback` from `advanceMs` (and so
   * from `sleep`) once for every period that passed. `callback` must not throw: a timer has nobody
   * to report to (the real one would end the process).
   */
  every(ms: number, callback: () => void): () => void;
  /**
   * Calls `callback` once after `ms` milliseconds (a whole number from 0 to 2^31 − 1; RangeError
   * otherwise) unless the returned function was called first (calling it again does nothing).
   * The real one does not keep the process alive by itself; the fake one fires from advanceMs, in
   * time order with `every`. `callback` must not throw, as for `every`.
   */
  after(ms: number, callback: () => void): () => void;
}

export interface FileInfo {
  size: number;
  mtimeNs: Ns;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  /** Permission bits: stat.mode & 0o7777. */
  mode: number;
  uid: number;
  /** The inode number: a file renamed over this path has another one. */
  ino: bigint;
}

/** The file system. Every path is absolute. Errors other than "does not exist" are thrown. */
export interface Files {
  /** Follows symlinks. null when the path does not exist. */
  stat(path: string): FileInfo | null;
  /** Does not follow symlinks. null when the path does not exist. */
  lstat(path: string): FileInfo | null;
  /** UTF-8 content, null when the file does not exist. */
  readText(path: string): string | null;
  /** Bytes [start, end) of a file. Throws when it does not exist. */
  readBytes(path: string, start: number, end: number): Uint8Array;
  /** Entry names (not paths) sorted by UTF-16 code unit; [] when the directory does not exist. */
  list(dir: string): string[];
  /**
   * Replaces the file atomically: writes `.<name>.<random>.tmp` beside it, then renames. A symlink
   * is followed (the file it points to is replaced, the link stays; a dangling one is replaced).
   * Without `mode` an existing file keeps its mode, a new one gets the umask default.
   */
  writeText(path: string, text: string, mode?: number): void;
  /**
   * Creates the file only if it does not exist; false when it already exists. The content is
   * written to a temporary file that is then hard-linked into place, so no reader ever sees the
   * file empty or half written. Needs a file system with hard links. With `mode` the file has
   * exactly that mode from the start (never a wider one first); without, the umask default.
   */
  createExclusive(path: string, text: string, mode?: number): boolean;
  /**
   * Writes `text` to a new file beside `path`, `.<name>.<random>.tmp`, created exclusively (O_EXCL)
   * with exactly `mode` from the start, whatever the umask, and synced to disk (fsync). Returns its
   * path; `path` itself is not touched. The caller renames it over `path` or removes it. Throws
   * when it cannot be written, and then leaves nothing behind.
   */
  createTempBeside(path: string, text: string, mode: number): string;
  /** mkdir -p; `mode` applies to directories it creates. */
  mkdirp(path: string, mode?: number): void;
  rename(from: string, to: string): void;
  /**
   * Removes a file or symlink, never following a symlink (a dangling one is removed too); no error
   * when absent; a directory is refused.
   */
  remove(path: string): void;
  /**
   * Removes an empty directory (rmdir(2)): a symbolic link is refused (ENOTDIR) and never followed;
   * one that is not empty is refused (ENOTEMPTY); no error when absent.
   */
  rmdir(path: string): void;
  /** rm -rf; no error when absent. */
  removeTree(path: string): void;
  /** Creates `path` as a symlink to `target`, replacing an existing symlink or file at `path`. */
  symlink(target: string, path: string): void;
  /** The link's target, null when `path` is not a symlink. */
  readlink(path: string): string | null;
  /** The canonical path, null when it does not resolve. */
  realpath(path: string): string | null;
  /** chmod. */
  chmod(path: string, mode: number): void;
}

/**
 * Linux /proc. bootId and stat, by which liveness is judged (design 5.5), return null only when
 * the file is not there (ENOENT, ENOTDIR, ESRCH: the process is gone, or /proc is not Linux's) and
 * throw any other failure (EACCES, EMFILE …) as a SkydeckError carrying its `code`: a process that
 * could not be read is never taken for one that is gone. The other methods return null when the
 * file cannot be read.
 */
export interface Proc {
  /** /proc/sys/kernel/random/boot_id without the trailing newline. */
  bootId(): string | null;
  /** The single line of /proc/<pid>/stat without the trailing newline; null for a pid ≤ 0. */
  stat(pid: number): string | null;
  /** Raw bytes of /proc/<pid>/cmdline. */
  cmdline(pid: number): Uint8Array | null;
  /** MemAvailable from /proc/meminfo in MiB (kB / 1024, rounded down). */
  memAvailableMb(): number | null;
  /** The target of the symbolic link /proc/<pid>/fd/<fd>; null when it cannot be read. */
  fdTarget(pid: number, fd: number): string | null;
  /**
   * Whether /proc/net/tcp or /proc/net/tcp6 lists a socket in state LISTEN (0A) on `port`; null
   * when neither can be read (A30). False for a number that is not a port (1–65535).
   */
  tcpListening(port: number): boolean | null;
}

export interface RunOptions {
  cwd?: string;
  /** Written to the child's stdin, which is then closed. Without it stdin is /dev/null. */
  input?: string;
  /** Kills the child with SIGKILL after this many ms and sets `timedOut`. */
  timeoutMs?: number;
  /** The child's complete environment; omitted → the environment of this process. Tests always pass sandbox.env(). */
  env?: Readonly<Record<string, string>>;
  /**
   * The child starts in a session of its own (setsid), so that the terminal's signals — Ctrl+C, a
   * closed terminal — do not reach it (`skydeck update`'s merge, F8). Its pipes are as without.
   */
  newSession?: boolean;
  /**
   * When it fires, the child is killed (SIGKILL), nothing it started is waited for, and run()
   * rejects with an Error named `AbortError`. Already aborted: nothing is started, run() rejects.
   * A signal that fires after run() has answered changes nothing.
   */
  signal?: AbortSignal;
}

export interface RunResult {
  /** Exit code; null when killed by a signal, timed out or not started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The program does not exist (ENOENT). So does a `cwd` that does not exist: check it first. */
  notFound: boolean;
}

/** Starts programs as argument lists, never through a shell. */
export interface Runner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /**
   * Inherits stdin/stdout/stderr (for $EDITOR). Resolves with the exit code, null on signal or
   * ENOENT (the program, or a `cwd`, does not exist).
   */
  runInteractive(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Readonly<Record<string, string>> },
  ): Promise<number | null>;
}

export interface DetachedOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Written to the child's stdin, which is then closed; without it stdin is /dev/null. */
  input?: string;
  /** Files stdout and stderr are appended to (created with mode 0o600); without, /dev/null. */
  stdoutTo?: string;
  stderrTo?: string;
}

export interface Detached {
  pid: number;
  /**
   * Settles when the child exits while this process lives. The child never keeps this process
   * alive and gets no SIGHUP from this process's terminal (setsid, a session of its own).
   */
  exited: Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Starting programs that outlive the call, and signalling processes. With SKYDECK_TEST_NO_WINDOWS=1
 * (the test sandbox, A32), and always for realPlatform({ refuseWindows: true }) (the real processes
 * of the test platforms), a Windows program — under /mnt/, ending in .exe (any case), or a file
 * that starts with "MZ", also when reached through PATH or a symbolic link — is refused with an
 * Error whose `code` is 'EWINDOWS', and nothing is started. Runner.run and runInteractive too.
 */
export interface Processes {
  /**
   * Starts a program detached in a new session. Rejects with an Error whose `code` is 'ENOENT'
   * when the program, `cwd`, or the directory of `stdoutTo` or `stderrTo` does not exist.
   */
  startDetached(
    command: string,
    args: readonly string[],
    options: DetachedOptions,
  ): Promise<Detached>;
  /**
   * process.kill; false when no such process exists (ESRCH, or a pid above 2^31 − 1). Callers
   * check the identity first. A pid that is not a positive whole number (0 and -1 would signal a
   * group or every process) is a RangeError, and nothing is sent.
   */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
}

export interface HttpHandlers {
  request(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void;
  upgrade?(
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void;
}

export interface HttpListener {
  /** The bound TCP port; 0 for a unix socket. */
  port: number;
  /**
   * Stops listening and ends every open connection, upgraded ones included, instead of waiting
   * for them; a unix socket's file is removed. Resolves when the server has closed.
   */
  close(): Promise<void>;
}

/** Sockets: the HTTP server of the window and the unix sockets of the server and the keepers. */
export interface Net {
  /**
   * An HTTP server on 127.0.0.1:<port> (0: the system picks) or on a unix socket path (created
   * with mode 0o600). Rejects with an Error whose `code` is 'EADDRINUSE' when it is taken. The
   * real one listens on 127.0.0.1 whatever `host` says: never on another interface.
   */
  listenHttp(
    where: { host: '127.0.0.1'; port: number } | { path: string },
    handlers: HttpHandlers,
  ): Promise<HttpListener>;
  /** Connects to a unix socket; rejects with `code` 'ECONNREFUSED' or 'ENOENT'. */
  connectUnix(path: string): Promise<import('node:net').Socket>;
  /**
   * One HTTP/1.1 request over a unix socket with a JSON body; rejects on timeout (`code`
   * 'ETIMEDOUT'), refusal or a missing socket. `onLine` receives a streamed body line by line
   * when given (each line without its '\n', a last line without one too); `body` is then null.
   * Otherwise `body` is the answer parsed as JSON, its text when it is not JSON, null when empty.
   * The timeout counts from the request; with `onLine` it starts again with every chunk received.
   * A `timeoutMs` that is not a whole number from 0 to 2^31 − 1 rejects with a RangeError.
   * When `signal` fires, the request is destroyed, its timer cleared, and it rejects with an Error
   * named `AbortError` (as Runner.run); already aborted: nothing is sent; one that fires after the
   * answer changes nothing.
   */
  requestUnix(
    path: string,
    request: {
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      timeoutMs: number;
      onLine?: (line: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ status: number; body: unknown }>;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Everything the outside world provides. Tests build one with test/helpers/platform.ts. */
export interface Platform {
  clock: Clock;
  files: Files;
  proc: Proc;
  runner: Runner;
  env: Env;
  homeDir: string;
  /** The real platform reads it when asked and throws a SkydeckError if the directory is gone. */
  cwd: string;
  /** A new random lowercase UUID (crypto.randomUUID in the real platform). */
  uuid(): string;
  /** Absolute path of the running Node.js binary (process.execPath). */
  nodePath: string;
  /** process.versions.node, e.g. "24.19.0". */
  nodeVersion: string;
  /** Absolute path of the skydeck checkout (the directory holding bin/ and src/). */
  appRoot: string;
  processes: Processes;
  net: Net;
  /**
   * `count` random bytes (crypto.randomBytes); the fake one returns 0, 1, 2, … in order. A property,
   * not a method, so that the import check of plan 2.1 does not read the declaration as a call.
   */
  randomBytes: (count: number) => Uint8Array;
  pid: number;
  uid: number;
  /** os.userInfo().username, for /var/lib/systemd/linger/<user>. */
  userName: string;
}
