// The version of a commit (docs/design.md 8, the version line; design-step-2.md 16.5): the version
// line, the look for an update and the window's server name a commit by it. It is
// `<major>.<minor>.<patch>`: the first two numbers of `"version"` in the commit's package.json, set
// by hand (rarely), and the number of commits of the commit's first-parent history after the one
// that last changed that pair (that one is `.0`). Every pull request is squashed into one commit, so
// the third number counts merged changes; the third number written in package.json means nothing.
//
// It is read from git's objects alone, never the work tree, and never fetches (a partial clone is
// not read at all; every call has GIT_NO_LAZY_FETCH=1). It costs at most four rounds of git calls
// (PAIR_CHANGES_READ bounds the search), all within the caller's budget. When git cannot count — a
// call that fails or passes the budget, a shallow clone that does not reach the commit that set
// the pair, a partial clone, a package.json that cannot be read or parsed, more changes of it than
// the search reads — the version is the pair alone (`0.9`), never a wrong third number; when not
// even the pair can be read, the caller's own pair, or null. It never throws, but the AbortError
// of a caller's stop.
import pkg from '../../package.json' with { type: 'json' };
import type { Ns, RunResult } from '../platform/types.ts';
import type { Git } from './git.ts';
import { PARTIAL_CLONE_ARGS, partialCloneIn } from './git.ts';

/** The file whose `"version"` gives the first two numbers. */
export const PACKAGE_FILE = 'package.json';
/** The most changes of PACKAGE_FILE in the first-parent history the search reads (newest first). */
export const PAIR_CHANGES_READ = 100;
/** Of the files read, only this much in all; a file past it counts as one that cannot be read. */
export const PACKAGE_BATCH_BYTES = 1024 * 1024;
/** A version written in package.json: three numbers, none with a leading zero. */
export const PACKAGE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** A version as it is shown and stored: three numbers, or the pair alone. */
export const VERSION_TEXT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$/;

/** The pair of the running code's package.json: the version when a checkout's cannot be read. */
export const RUNNING_PAIR = pairOf(pkg.version) ?? pkg.version;

/** A full commit id: 40 hexadecimal digits (SHA-1), or 64 (SHA-256). */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Of a call's output only this much is kept (a list of ids, a count, a setting). */
const SMALL_BYTES = 16 * 1024;

/** How the version runs git: one call, offline, with its timeout and the cap of its output. */
export interface VersionGit {
  run(
    args: readonly string[],
    options: { timeoutMs: number; maxBytes: number; input?: string },
  ): Promise<RunResult>;
  /** A clock that cannot step: what is left of the budget. */
  monotonicNs(): Ns;
}

/** VersionGit over a checkout's Git (src/update/git.ts): every call offline. */
export function versionGitOf(git: Git): VersionGit {
  return {
    run: (args, { timeoutMs, maxBytes, input }) =>
      git.run(args, timeoutMs, {
        offline: true,
        maxBytes,
        ...(input === undefined ? {} : { input }),
      }),
    monotonicNs: () => git.monotonicNs(),
  };
}

/** The pair `<major>.<minor>` of a version written in package.json; null when it is not one. */
export function pairOf(version: unknown): string | null {
  if (typeof version !== 'string') return null;
  const found = PACKAGE_VERSION.exec(version);
  return found === null ? null : `${found[1] ?? ''}.${found[2] ?? ''}`;
}

/** A commit as a place that shows no id names it: its version, else its short id. */
export function versionName(version: string | null, id: string): string {
  return version ?? id.slice(0, 7);
}

/** A call that failed, passed the budget or gave an answer that is not one: the pair alone. */
class Uncounted extends Error {}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The version of `commit` (a full id or a revision such as `HEAD`): `0.9.16`; the pair alone when
 * git cannot count; `fallbackPair` (or null) when the commit's pair cannot be read either. Every
 * call gets what is left of `budgetMs` from the start.
 */
export async function versionOf(
  git: VersionGit,
  commit: string,
  budgetMs: number,
  fallbackPair: string | null = null,
): Promise<string | null> {
  const startNs = git.monotonicNs();
  const call = async (
    args: readonly string[],
    maxBytes = SMALL_BYTES,
    input?: string,
  ): Promise<RunResult> => {
    const left = budgetMs - Number((git.monotonicNs() - startNs) / 1_000_000n);
    if (left < 1) throw new Uncounted();
    return git.run(args, { timeoutMs: left, maxBytes, ...(input === undefined ? {} : { input }) });
  };
  const answer = async (
    args: readonly string[],
    maxBytes?: number,
    input?: string,
  ): Promise<string> => {
    const result = await call(args, maxBytes, input);
    if (result.code !== 0 || result.timedOut || result.notFound) throw new Uncounted();
    return result.stdout;
  };
  let pair = fallbackPair;
  try {
    // 1. Not a partial clone (nothing is read there: an older git would fetch what is missing),
    // and whether the history is shallow.
    const [config, shallow] = await Promise.all([
      call(PARTIAL_CLONE_ARGS),
      answer(['rev-parse', '--is-shallow-repository']),
    ]);
    if (config.timedOut || config.notFound || (config.code !== 0 && config.code !== 1)) {
      return pair;
    }
    if (config.code === 0 && partialCloneIn(config.stdout)) return pair;
    // 2. The commits of the first-parent history that change package.json, newest first.
    const changes = (
      await answer([
        'rev-list',
        '--first-parent',
        `--max-count=${PAIR_CHANGES_READ}`,
        commit,
        '--',
        PACKAGE_FILE,
      ])
    )
      .split('\n')
      .filter((line) => line !== '');
    if (changes.length === 0 || !changes.every((id) => COMMIT_ID.test(id))) return pair;
    // 3. Their package.json, in one call.
    const pairs = parseBatch(
      await answer(
        ['cat-file', '--batch'],
        PACKAGE_BATCH_BYTES,
        changes.map((id) => `${id}:${PACKAGE_FILE}\n`).join(''),
      ),
      changes.length,
    ).map(pairOfFile);
    // The commit's own package.json is that of the newest change (none after it on the chain).
    pair = pairs[0] ?? pair;
    if (pairs[0] === null || pairs[0] === undefined) return pair;
    let bump: string | null = null;
    for (let i = 0; i < changes.length; i += 1) {
      const here = pairs[i] ?? null;
      if (here === null) return pair; // a package.json that cannot be read: no guess
      if (i + 1 < changes.length) {
        if (pairs[i + 1] === null) return pair;
        if (pairs[i + 1] !== here) {
          bump = changes[i] ?? null;
          break;
        }
        continue;
      }
      // The oldest change found: it adds package.json to the chain, unless the search stopped at
      // its limit or the history is cut there (a shallow clone's boundary looks like a root).
      if (changes.length === PAIR_CHANGES_READ || shallow.trim() !== 'false') return pair;
      bump = changes[i] ?? null;
    }
    if (bump === null) return pair;
    // 4. How many commits of the first-parent history came after it.
    const count = (
      await answer(['rev-list', '--first-parent', '--count', `${bump}..${commit}`])
    ).trim();
    if (!/^(0|[1-9][0-9]*)$/.test(count)) return pair;
    return `${pairs[0]}.${count}`;
  } catch (error) {
    if (isAbort(error)) throw error;
    return pair;
  }
}

/**
 * `cat-file --batch`'s answer for `n` objects asked for: each one's content, or null when it is
 * missing, not a file, or not all there (the output was capped).
 */
function parseBatch(out: string, n: number): (Buffer | null)[] {
  const bytes = Buffer.from(out, 'utf8');
  const files: (Buffer | null)[] = [];
  let at = 0;
  while (files.length < n) {
    const end = bytes.indexOf(0x0a, at);
    if (end < 0) break;
    const header = bytes.subarray(at, end).toString('utf8');
    at = end + 1;
    // `<object> SP blob SP <size> LF <content> LF`, or `<name> SP missing LF` (or `ambiguous`).
    const found = /^[0-9a-f]+ ([a-z]+) ([0-9]+)$/.exec(header);
    if (found === null) {
      files.push(null);
      continue;
    }
    const size = Number(found[2]);
    if (at + size + 1 > bytes.length) break;
    files.push(found[1] === 'blob' ? bytes.subarray(at, at + size) : null);
    at += size + 1;
  }
  while (files.length < n) files.push(null);
  return files;
}

/** The pair of a package.json's bytes; null when they are not JSON with a well-formed version. */
function pairOfFile(file: Buffer | null): string | null {
  if (file === null) return null;
  try {
    const parsed: unknown = JSON.parse(file.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return pairOf((parsed as Record<string, unknown>)['version']);
  } catch {
    return null;
  }
}
