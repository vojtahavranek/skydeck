// How skydeck runs git on its own checkout (F8, U3; F38): always `git -C <root> …` as an argument
// list through the platform's runner — never a shell, never a change of directory — in the
// caller's own environment without the variables that would point git at another repository,
// with a timeout and formats that depend neither on the locale nor on the owner's git settings.
// Used by `skydeck update`, by the window's check for a newer skydeck and by doctor (S2 16.5).
// `skydeck update`'s fetch is the exception: it is the owner's own command in their own terminal
// (runInteractive), with no timeout. The window's fetch is the other: it never asks (fetchQuietly).
import { SkydeckError } from '../platform/errors.ts';
import type { Env, Platform, RunResult } from '../platform/types.ts';
import { clip } from '../text/clip.ts';
import { sanitize } from '../text/sanitize.ts';

/** Every git call but the fetch and the merge waits this long (U3). */
export const GIT_MS = 10_000;
/** The fast-forward's wait: it writes the files of the new commit (U3). */
export const MERGE_MS = 60_000;
/** The window's fetch waits this long (F38). */
export const FETCH_MS = 60_000;
/** A fetch that is cut (its timeout, the server's stop) gets SIGTERM, and SIGKILL this much later. */
export const FETCH_GRACE_MS = 2_000;
/** Of the window's fetch's output only this much is kept (its first line is what is read). */
export const FETCH_OUTPUT_BYTES = 16 * 1024;
/** The longest line of git's or of a refusal that is stored or sent (F38). */
export const LINE_MAX = 300;

/** `text` as it is when it is at most `max` long, else its start and `…`, `max` long in all. */
export function clipLine(text: string, max = LINE_MAX): string {
  return text.length > max ? `${clip(text, max - 1)}…` : text;
}

/**
 * The variables that tie a git process to one repository, left out of git's environment so that
 * `-C <root>` alone says which repository it works on. They are git's own list — what `git
 * rev-parse --local-env-vars` prints (git 2.43), the variables git itself clears before it runs
 * git in another repository (a submodule) — and GIT_NAMESPACE, which makes git see only one
 * namespace's refs. A GIT_DIR or GIT_WORK_TREE inherited from a hook or an alias would make every
 * call act on another repository; GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT (the `-c` of an
 * outer git) would bring settings in. The other variables (the transport's GIT_SSH_COMMAND, the
 * locale) stay: they are the owner's, as for `git pull`.
 */
const REPOSITORY_VARIABLES: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

/** `env` as a child's whole environment: the variables that are set. */
export function definedEnv(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** git's environment: the command's own without REPOSITORY_VARIABLES (also the version line's, F20). */
export function gitEnv(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(definedEnv(env)).filter(([name]) => !REPOSITORY_VARIABLES.includes(name)),
  );
}

/**
 * The window's fetch's environment (F38): git's (gitEnv), and nothing that could ask. git asks
 * nothing on a terminal (GIT_TERMINAL_PROMPT=0) and runs no askpass program (an empty GIT_ASKPASS,
 * beside `-c core.askPass=`: whichever git reads first); ssh starts no askpass that could ask
 * (SSH_ASKPASS_REQUIRE=never, and SSH_ASKPASS=/bin/false for an ssh older than 8.4); Git Credential Manager opens no dialog
 * (GCM_INTERACTIVE=never). On WSL the usual credential helper is the Windows
 * `git-credential-manager.exe`, which gets only the variables WSLENV names, so GCM_INTERACTIVE is
 * added to WSLENV (what is there kept; not twice). The owner's GIT_SSH_COMMAND stays.
 */
export function quietEnv(env: Env): Record<string, string> {
  const quiet = gitEnv(env);
  const names = (quiet.WSLENV ?? '').split(':').filter((entry) => entry !== '');
  const named = names.some((entry) => entry.split('/')[0] === 'GCM_INTERACTIVE');
  return {
    ...quiet,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    // An ssh older than 8.4 does not know SSH_ASKPASS_REQUIRE and, with no terminal and a
    // DISPLAY, runs SSH_ASKPASS (or its default program when unset): /bin/false asks nothing.
    // git itself reads GIT_ASKPASS first, whose empty value ends its search.
    SSH_ASKPASS: '/bin/false',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    WSLENV: named ? (quiet.WSLENV ?? '') : [...names, 'GCM_INTERACTIVE'].join(':'),
  };
}

const GIT_NOT_FOUND = 'git was not found on PATH; skydeck update needs it';

/** How the window's fetch is cut short: the server's stop, and a wait other than FETCH_MS. */
export interface QuietFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** git on one checkout. */
export interface Git {
  /** The checkout (`platform.appRoot`). */
  root: string;
  /** `git -C <root> <args>` with a timeout (GIT_MS unless given); a SkydeckError when git is not found. */
  run(args: readonly string[], timeoutMs?: number): Promise<RunResult>;
  /**
   * From now on every call runs in a session of its own (RunOptions.newSession): the terminal's
   * Ctrl+C and hang-up reach none of them. `skydeck update` calls it right before the merge, so that
   * neither the merge nor a look after it can be cut by a signal (ruled by the plan owner, S2).
   */
  ownSessions(): void;
  /**
   * run(), and its standard output; any failure is gitFailure's SkydeckError. With `maxBytes` only
   * the first that many bytes of each output are kept (RunOptions.maxOutputBytes): a blob of a
   * fetched commit, which can be of any size.
   */
  output(args: readonly string[], maxBytes?: number): Promise<string>;
  /** `git -C <root> <args>` with the terminal and no timeout: its exit code, null when it did not end by itself. */
  interactive(args: readonly string[]): Promise<number | null>;
  /**
   * The window's fetch (F38): `git -C <root> -c core.askPass= fetch --quiet -- <remote>` that
   * never asks: quietEnv, a session of its own (no terminal: neither git nor ssh can open
   * /dev/tty), stdin /dev/null, FETCH_MS (or `timeoutMs`), the output capped, and SIGTERM first
   * when it is cut (killGraceMs). null when it worked, else its line, `git fetch from <remote>
   * failed: <why>`, clipped to LINE_MAX. An abort through `signal` rejects with an AbortError.
   */
  fetchQuietly(remote: string, options?: QuietFetchOptions): Promise<string | null>;
}

/** What only the window's checker gives gitOn (F38). */
export interface GitOptions {
  /**
   * The server's stop: once it fires, a git call that runs gets SIGTERM (SIGKILL after
   * FETCH_GRACE_MS) and every later call rejects with an AbortError before it starts.
   */
  signal?: AbortSignal;
}

export function gitOn(platform: Platform, root: string, gitOptions: GitOptions = {}): Git {
  const env = gitEnv(platform.env);
  const { signal } = gitOptions;
  const stoppable = signal === undefined ? {} : { signal, killGraceMs: FETCH_GRACE_MS };
  let ownSessions = false;
  const run = async (
    args: readonly string[],
    timeoutMs = GIT_MS,
    maxBytes?: number,
  ): Promise<RunResult> => {
    const result = await platform.runner.run('git', ['-C', root, ...args], {
      env,
      timeoutMs,
      ...(maxBytes === undefined ? {} : { maxOutputBytes: maxBytes }),
      ...(ownSessions ? { newSession: true } : {}),
      ...stoppable,
    });
    if (result.notFound) throw new SkydeckError(GIT_NOT_FOUND);
    return result;
  };
  return {
    root,
    run: (args, timeoutMs) => run(args, timeoutMs),
    ownSessions() {
      ownSessions = true;
    },
    async output(args, maxBytes) {
      const result = await run(args, GIT_MS, maxBytes);
      if (result.code !== 0 || result.timedOut) throw gitFailure(args, result, GIT_MS);
      return result.stdout;
    },
    interactive: (args) => platform.runner.runInteractive('git', ['-C', root, ...args], { env }),
    async fetchQuietly(remote, options = {}) {
      const timeoutMs = options.timeoutMs ?? FETCH_MS;
      const fetchSignal = options.signal ?? signal;
      const result = await platform.runner.run(
        'git',
        ['-C', root, '-c', 'core.askPass=', 'fetch', '--quiet', '--', remote],
        {
          env: quietEnv(platform.env),
          newSession: true,
          timeoutMs,
          killGraceMs: FETCH_GRACE_MS,
          maxOutputBytes: FETCH_OUTPUT_BYTES,
          ...(fetchSignal === undefined ? {} : { signal: fetchSignal }),
        },
      );
      if (result.code === 0 && !result.timedOut && !result.notFound) return null;
      return clipLine(
        `git fetch from ${sanitize(remote)} failed: ${failureReason(result, timeoutMs)}`,
      );
    },
  };
}

/** The first argument of `args` that is not an option: the sub-command. */
function subCommandOf(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith('-')) ?? 'git';
}

/** Why a git call failed, in one line: git's first line (sanitised), or what ended it. */
export function failureReason(result: RunResult, timeoutMs: number): string {
  if (result.notFound) return GIT_NOT_FOUND;
  if (result.timedOut) return `no answer within ${timeoutMs / 1000} s`;
  const line = result.stderr
    .split('\n')
    .map((text) => sanitize(text).trim())
    .find((text) => text !== '');
  if (line !== undefined) return line;
  return result.code === null ? 'ended by a signal' : `exit ${result.code}`;
}

/** U2's last line: `git <sub-command> failed: <first line of its message>; nothing was changed`. */
export function gitFailure(
  args: readonly string[],
  result: RunResult,
  timeoutMs: number,
): SkydeckError {
  return new SkydeckError(
    `git ${subCommandOf(args)} failed: ${failureReason(result, timeoutMs)}; nothing was changed`,
  );
}

/** A full commit id: 40 hexadecimal digits (SHA-1), or 64 (SHA-256). */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `rev-parse --verify <rev>^{commit}`: the commit's full id. */
export async function commitOf(git: Git, rev: string): Promise<string> {
  const args = ['rev-parse', '--verify', `${rev}^{commit}`];
  const id = (await git.output(args)).trim();
  if (!COMMIT_ID.test(id)) {
    throw new SkydeckError(
      `git rev-parse failed: its answer is not a commit id; nothing was changed`,
    );
  }
  return id;
}

/** `status --porcelain -z --untracked-files=no`: the paths of the tracked files that changed. */
export async function changedFiles(git: Git): Promise<string[]> {
  const out = await git.output([
    '--no-optional-locks', // a look: no refresh of the index written behind the owner's back
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=no',
  ]);
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i] ?? '';
    if (entry.length < 4) continue; // the empty field after the last NUL
    paths.push(entry.slice(3));
    // A rename or a copy is followed by the path it came from, a field of its own.
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i += 1;
  }
  return paths;
}

/**
 * The files git does not track and does not ignore (`ls-files -z --others --exclude-standard`), as
 * git lists them: read before the merge and after one that failed, so that a git that ended after
 * writing new files is not taken for one that changed nothing (ruled by the plan owner, review 2 S1).
 */
export async function untrackedFiles(git: Git): Promise<string> {
  return git.output(['ls-files', '-z', '--others', '--exclude-standard']);
}
