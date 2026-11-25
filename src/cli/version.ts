// The version line (follow-up F20): `skydeck --version` prints it, and it is the first line of
// `skydeck doctor`: `<version> (<short commit>, <commit date>[, modified])`, or `<version> (commit
// unknown)`. The commit is the one of the checkout the running code is in (`platform.appRoot`),
// wherever the command runs from, so that a tester can say what they run; the version is that
// commit's (src/update/version.ts: `0.9.16`, the pair alone when git cannot count), and the pair
// of the running code's package.json when not even HEAD's can be read.
//
// It runs often (by people and by scripts), so it never fails, never writes and never waits long:
// six git calls, `log -1` and `status` side by side with the version's chain (its four rounds, the
// first of two calls), as argument lists through the platform's runner (never a shell), all within
// VERSION_GIT_MS from the line's start, in the command's environment without the variables that
// would point git at another repository (src/update/git.ts), with git's search for the repository
// stopped at the app root, with no optional lock (`status` would otherwise refresh the index and
// write it into the checkout) and fetching nothing (GIT_NO_LAZY_FETCH).
import { dirname } from 'node:path';

import type { Platform, RunResult } from '../platform/types.ts';
import { gitEnv } from '../update/git.ts';
import { RUNNING_PAIR, versionOf } from '../update/version.ts';
import type { VersionGit } from '../update/version.ts';

/**
 * How long each git call may take before it is stopped and the commit counts as unknown; the
 * version's chain of calls shares it (each of its calls gets what is left).
 */
export const VERSION_GIT_MS = 2_000;

/** Of each call's output only this much is kept: one commit line, or whether anything changed. */
const KEPT_BYTES = 4096;

/** `log`'s answer: a full commit id (SHA-1 or SHA-256), one space, its date, one line. */
const LOG_ANSWER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d{4}-\d{2}-\d{2})\n?$/;

/** The version line, and the full id of the commit it names (null: not known). */
export interface CheckoutFacts {
  line: string;
  id: string | null;
}

/** The version line and HEAD's full id (doctor hands the id to its update line, F38); never throws. */
export async function checkoutFacts(platform: Platform): Promise<CheckoutFacts> {
  const [commit, version] = await Promise.all([
    checkoutCommit(platform).catch((): null => null), // a platform or a runner that failed
    headVersion(platform).catch((): null => null),
  ]);
  return {
    line: `${version ?? RUNNING_PAIR} (${commit?.text ?? 'commit unknown'})`,
    id: commit?.id ?? null,
  };
}

/** The version line; it never throws. */
export async function versionLine(platform: Platform): Promise<string> {
  return (await checkoutFacts(platform)).line;
}

/** git's environment for the line: see the head of this file. */
function lineEnv(platform: Platform): Record<string, string> {
  return {
    ...gitEnv(platform.env),
    // The app root itself, never a folder above it: a copy of skydeck that is not a checkout but
    // lies inside one would otherwise report that other repository's commit. The variable is a
    // list split at colons, so a colon in the path above the app root makes it name no ceiling: such
    // a copy then reports the outer commit (a checkout with a colon in its path is read rightly).
    GIT_CEILING_DIRECTORIES: dirname(platform.appRoot),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
  };
}

/** HEAD's version (src/update/version.ts) within VERSION_GIT_MS, the running code's pair as its fallback. */
async function headVersion(platform: Platform): Promise<string | null> {
  const root = platform.appRoot;
  const env = lineEnv(platform);
  const git: VersionGit = {
    run: (args, { timeoutMs, maxBytes, input }) =>
      platform.runner.run('git', ['-C', root, '--no-optional-locks', ...args], {
        env,
        timeoutMs,
        maxOutputBytes: maxBytes,
        ...(input === undefined ? {} : { input }),
      }),
    monotonicNs: () => platform.clock.monotonicNs(),
  };
  return versionOf(git, 'HEAD', VERSION_GIT_MS, RUNNING_PAIR);
}

/** `<short commit>, <date>[, modified]` and the full id, or null when git cannot say. */
async function checkoutCommit(platform: Platform): Promise<{ text: string; id: string } | null> {
  const root = platform.appRoot;
  const env = lineEnv(platform);
  const git = (args: readonly string[]): Promise<RunResult> =>
    platform.runner.run('git', ['-C', root, '--no-optional-locks', ...args], {
      env,
      timeoutMs: VERSION_GIT_MS,
      maxOutputBytes: KEPT_BYTES,
    });
  // Side by side, so that the line waits VERSION_GIT_MS at most; both have ended when it answers.
  const [log, status] = await Promise.allSettled([
    // The commit's own date (%cs: the committer's, as `git log` shows it); a full id, so that the
    // owner's core.abbrev changes nothing; no signature check (log.showSignature).
    git(['log', '-1', '--no-show-signature', '--format=%H %cs', 'HEAD', '--']),
    // Tracked files only; no fsmonitor daemon is started for it (that one writes under .git).
    git(['-c', 'core.fsmonitor=false', 'status', '--porcelain', '-z', '--untracked-files=no']),
  ]);
  if (log.status !== 'fulfilled' || status.status !== 'fulfilled') return null;
  if (!answered(log.value) || !answered(status.value)) return null;
  const match = LOG_ANSWER.exec(log.value.stdout);
  if (match === null) return null;
  const [, id = '', date = ''] = match;
  // Whether files changed cannot be told apart from a clean checkout when it is unknown, so a
  // status that failed makes the whole commit unknown above, never a line without "modified".
  return {
    text: `${id.slice(0, 7)}, ${date}${status.value.stdout === '' ? '' : ', modified'}`,
    id,
  };
}

function answered(result: RunResult): boolean {
  return result.code === 0 && !result.timedOut && !result.notFound;
}
