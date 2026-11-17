// How `skydeck update` runs git (F8, U3): always `git -C <root> …` as an argument list through the
// platform's runner — never a shell, never a change of directory — in the command's own
// environment without the variables that would point git at another repository, with a timeout
// and formats that depend neither on the locale nor on the owner's git settings. The fetch is the
// exception: it is the owner's own command in their own terminal (runInteractive), with no timeout.
import { SkydeckError } from '../platform/errors.ts';
import type { Env, Platform, RunResult } from '../platform/types.ts';
import { sanitize } from '../text/sanitize.ts';

/** Every git call but the fetch and the merge waits this long (U3). */
export const GIT_MS = 10_000;
/** The fast-forward's wait: it writes the files of the new commit (U3). */
export const MERGE_MS = 60_000;

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

/** git's environment: the command's own without REPOSITORY_VARIABLES. */
function gitEnv(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(definedEnv(env)).filter(([name]) => !REPOSITORY_VARIABLES.includes(name)),
  );
}

const GIT_NOT_FOUND = 'git was not found on PATH; skydeck update needs it';

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
  /** run(), and its standard output; any failure is gitFailure's SkydeckError. */
  output(args: readonly string[]): Promise<string>;
  /** `git -C <root> <args>` with the terminal and no timeout: its exit code, null when it did not end by itself. */
  interactive(args: readonly string[]): Promise<number | null>;
}

export function gitOn(platform: Platform, root: string): Git {
  const env = gitEnv(platform.env);
  let ownSessions = false;
  const run = async (args: readonly string[], timeoutMs = GIT_MS): Promise<RunResult> => {
    const result = await platform.runner.run('git', ['-C', root, ...args], {
      env,
      timeoutMs,
      ...(ownSessions ? { newSession: true } : {}),
    });
    if (result.notFound) throw new SkydeckError(GIT_NOT_FOUND);
    return result;
  };
  return {
    root,
    run,
    ownSessions() {
      ownSessions = true;
    },
    async output(args) {
      const result = await run(args);
      if (result.code !== 0 || result.timedOut) throw gitFailure(args, result, GIT_MS);
      return result.stdout;
    },
    interactive: (args) => platform.runner.runInteractive('git', ['-C', root, ...args], { env }),
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
