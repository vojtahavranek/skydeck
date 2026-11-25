// Which version tag the workflow Version makes (.github/workflows/version.yml; design.md 8): the
// logic of scripts/next-version-tag.ts, over a git that is given to it (the suite gives it real
// repositories in its sandbox). Versions on main never go backwards, and a run never stalls in
// silence: what it cannot do is a Refusal, which fails the run with a line that says what to do.
//
// - On a push, for the pushed commit H: when H carries a version tag already, none. Else, with no
//   version tag on H's first-parent history, START. Else the next version after the HIGHEST version
//   tag on that history (a tag the owner pushed by hand on an older commit still counts): the next
//   minor (`minor+1`, patch 0) when a commit after the NEAREST tagged commit (first parent; a merge
//   compared with its first parent) adds a file with a note's name right under docs/news/
//   (src/update/news.ts: a note changed or removed is none), else the next patch.
// - Run by hand with `bump` (`minor` or `major`): only when H is the head of `origin/main` as this
//   run fetched it (else a Refusal: main moved, or an old run is re-run); from the highest version
//   tag of the history, H's own included, `major` gives `(major+1).0.0` and `minor`
//   `major.(minor+1).0`; none at all: START.
// - The name it computes already stands on another commit C: on a push, when C lies on main's
//   first-parent line (`origin/main` as this run fetched it) and H on C's, before it (H was passed
//   over: a later commit of main is tagged), none; else a Refusal that names the tag and C (a stray
//   tag: remove it, or step past it with a run by hand).
// - One tag per run, on H: commits pushed together get one, on the last.
// Every git call that fails is an Error: the workflow then fails and makes nothing.
import { NEWS_DIR, NOTE_FILE } from '../src/update/news.ts';
import {
  highestVersion,
  nearestVersion,
  tagName,
  TAGS_ARGS,
  versionTagsOf,
} from '../src/update/version-tags.ts';
import type { Version } from '../src/update/version-tags.ts';

/** The first version, when no version tag is on the history. */
export const START: Version = { major: 0, minor: 9, patch: 0 };

/** The ref a run by hand must stand on: main as the run's checkout fetched it. */
export const MAIN_REF = 'refs/remotes/origin/main';

/** What a run asks for: nothing (a push), or a bump made by hand. */
export type Bump = '' | 'minor' | 'major';

/** One git call in the repository: its standard output; it throws when git fails. */
export type GitOutput = (args: readonly string[]) => Promise<string>;

/** What the run must not do, and why, in one line for the run's log: the run then fails. */
export class Refusal extends Error {}

/** The bump of `text` (the workflow's input, through the environment); null when it is not one. */
export function bumpOf(text: string | undefined): Bump | null {
  if (text === undefined || text === '') return '';
  return text === 'minor' || text === 'major' ? text : null;
}

/** Whether the commits of `range` (first parent) add a note's file right under docs/news/. */
async function addsNote(git: GitOutput, range: string): Promise<boolean> {
  const out = await git([
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--diff-filter=A',
    '--no-renames',
    '--no-show-signature',
    '--name-only',
    '-z',
    '--format=',
    range,
    '--',
    `${NEWS_DIR}/`,
  ]);
  // With -z every path ends with a NUL, and only a NUL: a line break belongs to a name.
  return out
    .split('\0')
    .some(
      (path) => path.startsWith(`${NEWS_DIR}/`) && NOTE_FILE.test(path.slice(NEWS_DIR.length + 1)),
    );
}

/** A first-parent history, the commit first. */
async function chainOf(git: GitOutput, commit: string): Promise<string[]> {
  return (await git(['rev-list', '--first-parent', commit]))
    .split('\n')
    .filter((line) => line !== '');
}

/**
 * Whether `head` was passed over by `at`: `at` lies on main's first-parent line as this run fetched
 * it (MAIN_REF), and `head` on `at`'s, before it. A commit of another branch is never so.
 */
async function passedOver(git: GitOutput, head: string, at: string): Promise<boolean> {
  let main: string[];
  try {
    main = await chainOf(git, MAIN_REF);
  } catch {
    return false; // no main fetched: it cannot be told, so it is refused
  }
  return main.includes(at) && (await chainOf(git, at)).includes(head);
}

/** The tag to make on `head` (a commit, or `HEAD`), or null for none; a Refusal when it may not. */
export async function nextVersionTag(
  git: GitOutput,
  head: string,
  bump: Bump,
): Promise<string | null> {
  const [tags, chain] = await Promise.all([git(TAGS_ARGS), chainOf(git, head)]);
  const headId = chain[0] ?? head;
  if (bump !== '') {
    let main = '';
    try {
      main = (await git(['rev-parse', '--verify', '--quiet', `${MAIN_REF}^{commit}`])).trim();
    } catch {
      // no such ref: refused below
    }
    if (main !== headId) {
      throw new Refusal(
        `this run is not on the head of main (${headId.slice(0, 7)}; main is at ${main === '' ? 'no commit' : main.slice(0, 7)}): main moved since the run was started, or an old run was run again; start the workflow by hand again, on main`,
      );
    }
  }
  const { byCommit, names } = versionTagsOf(tags);
  const nearest = nearestVersion(chain, byCommit);
  const highest = highestVersion(chain, byCommit);
  let next: Version;
  if (nearest === null || highest === null) {
    next = START;
  } else if (bump === 'major') {
    next = { major: highest.major + 1, minor: 0, patch: 0 };
  } else if (bump === 'minor') {
    next = { major: highest.major, minor: highest.minor + 1, patch: 0 };
  } else if (nearest.distance === 0) {
    return null; // the pushed commit carries one already
  } else if (await addsNote(git, `${nearest.commit}..${headId}`)) {
    next = { major: highest.major, minor: highest.minor + 1, patch: 0 };
  } else {
    next = { ...highest, patch: highest.patch + 1 };
  }
  const tag = tagName(next);
  if (!names.has(tag)) return tag;
  const at = names.get(tag) ?? null;
  if (bump === '' && at !== null && (await passedOver(git, headId, at))) {
    return null; // a later commit of main carries the version already
  }
  throw new Refusal(
    `the next version's tag ${tag} stands already on ${at === null ? 'an object that is not a commit' : `commit ${at.slice(0, 7)}`}, which is not later on main than ${headId.slice(0, 7)}: remove that tag if it is a stray one (git push --delete origin ${tag}), or run the workflow by hand with bump minor to step past it`,
  );
}
