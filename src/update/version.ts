// The version of a commit (design.md 8, the version line; design-step-2.md 16.5): the version line,
// the look for an update and the window's server name a commit by it. The version is a git tag
// (src/update/version-tags.ts: `v0.9.16`, made by the workflow Version at every push to main): a
// commit's version is the nearest version tag on its first-parent history — at the tag `0.9.16`, n
// commits past it `0.9.16+n` (a merge whose tag has not arrived yet, commits of the checkout's
// own) — or none: no version tag reachable (none made yet, a shallow clone that does not reach
// one, a fetch that brings no tags), more than CHAIN_READ commits past the nearest, or a git call
// that fails or does not answer in time. Then every place shows the commit ids as it did before
// versions. Never a guess, never a fetch, never a failure of the place.
//
// Two git calls side by side, each within the caller's bound and offline (GIT_NO_LAZY_FETCH): the
// tags (`for-each-ref`) and the first-parent history (`rev-list`). Both read only refs, commits and
// tag objects, which a partial clone always has (its filters leave out blobs and trees), so nothing
// is fetched there either; a shallow clone's history ends at its boundary, so a tag past it is not
// found. It never throws, but the AbortError of a caller's stop.
import type { RunResult } from '../platform/types.ts';
import type { Git } from './git.ts';
import { nearestVersion, TAGS_ARGS, versionTagsOf, versionText } from './version-tags.ts';

/** How many commits of a first-parent history are searched for a version tag, the commit first. */
export const CHAIN_READ = 10_000;
/** Of the list of tags, only this much is kept; a longer one counts as a call that failed. */
export const TAGS_BYTES = 1024 * 1024;
/** A version as it is shown and stored: `0.9.16`, or `0.9.16+3` past the tag. */
export const VERSION_TEXT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[1-9][0-9]*)?$/;

/** A full commit id: 40 hexadecimal digits (SHA-1), or 64 (SHA-256). */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** How the version runs git: one call, offline, with its timeout and the cap of its output. */
export interface VersionGit {
  run(
    args: readonly string[],
    options: { timeoutMs: number; maxBytes: number },
  ): Promise<RunResult>;
}

/** VersionGit over a checkout's Git (src/update/git.ts): every call offline. */
export function versionGitOf(git: Git): VersionGit {
  return {
    run: (args, { timeoutMs, maxBytes }) => git.run(args, timeoutMs, { offline: true, maxBytes }),
  };
}

/** A commit as a place that shows no id names it: its version, else its short id. */
export function versionName(version: string | null, id: string): string {
  return version ?? id.slice(0, 7);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function answered(result: RunResult, maxBytes: number): boolean {
  return (
    result.code === 0 &&
    !result.timedOut &&
    !result.notFound &&
    Buffer.byteLength(result.stdout) < maxBytes
  );
}

/**
 * The version of `commit` (a full id or a revision such as `HEAD`): `0.9.16`, `0.9.16+3`, or null
 * (no version). Each of its two calls waits `timeoutMs` at most; they run side by side.
 */
export async function versionOf(
  git: VersionGit,
  commit: string,
  timeoutMs: number,
): Promise<string | null> {
  const chainBytes = 65 * CHAIN_READ + 1;
  try {
    const [tags, chain] = await Promise.all([
      git.run(TAGS_ARGS, { timeoutMs, maxBytes: TAGS_BYTES }),
      git.run(['rev-list', '--first-parent', `--max-count=${CHAIN_READ}`, commit], {
        timeoutMs,
        maxBytes: chainBytes,
      }),
    ]);
    if (!answered(tags, TAGS_BYTES) || !answered(chain, chainBytes)) return null;
    const ids = chain.stdout.split('\n').filter((line) => line !== '');
    if (ids.length === 0 || !ids.every((id) => COMMIT_ID.test(id))) return null;
    const nearest = nearestVersion(ids, versionTagsOf(tags.stdout).byCommit);
    if (nearest === null) return null;
    const text = versionText(nearest.version);
    return nearest.distance === 0 ? text : `${text}+${nearest.distance}`;
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}
