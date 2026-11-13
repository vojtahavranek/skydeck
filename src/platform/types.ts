/** Nanoseconds since the Unix epoch. */
export type Ns = bigint;

/** Wall clock. `sleep` resolves after `ms` milliseconds; the fake one advances its time instead. */
export interface Clock {
  nowNs(): Ns;
  sleep(ms: number): Promise<void>;
}

export interface FileInfo {
  size: number;
  mtimeNs: Ns;
  kind: 'file' | 'dir' | 'symlink' | 'other';
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
  /** mkdir -p; `mode` applies to directories it creates. */
  mkdirp(path: string, mode?: number): void;
  rename(from: string, to: string): void;
  /** Removes a file or symlink; no error when absent. */
  remove(path: string): void;
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

/** Linux /proc. Every method returns null when the file cannot be read. */
export interface Proc {
  /** /proc/sys/kernel/random/boot_id without the trailing newline. */
  bootId(): string | null;
  /** The single line of /proc/<pid>/stat without the trailing newline. */
  stat(pid: number): string | null;
  /** Raw bytes of /proc/<pid>/cmdline. */
  cmdline(pid: number): Uint8Array | null;
  /** MemAvailable from /proc/meminfo in MiB (kB / 1024, rounded down). */
  memAvailableMb(): number | null;
}

export interface RunOptions {
  cwd?: string;
  /** Written to the child's stdin, which is then closed. Without it stdin is /dev/null. */
  input?: string;
  /** Kills the child with SIGKILL after this many ms and sets `timedOut`. */
  timeoutMs?: number;
  /** The child's complete environment; omitted → the environment of this process. Tests always pass sandbox.env(). */
  env?: Readonly<Record<string, string>>;
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
}
