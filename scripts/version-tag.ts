// Which version tag the workflow Version makes (.github/workflows/version.yml; design.md 8): the
// logic of scripts/next-version-tag.ts, over a git that is given to it (the suite gives it real
// repositories in its sandbox).
//
// - On a push, for the pushed commit H: when H carries a version tag already, none. Else T, the
//   nearest version tag on H's first-parent history; no T at all: START. Else, when a commit of
//   T..H (first parent; a merge compared with its first parent) adds a file with a note's name
//   right under docs/news/ (src/update/news.ts: a note changed or removed is none), the next minor
//   (`minor+1`, patch 0); else the next patch.
// - Run by hand with `bump` (`minor` or `major`): from the nearest version tag, H's own included
//   (the highest of H's), `major` gives `(major+1).0.0` and `minor` `major.(minor+1).0`; no T at
//   all: START.
// - One tag per run, on H: commits pushed together get one, on the last. A tag that exists already
//   (on any commit) is never made again: none.
// Every git call that fails is an Error: the workflow then fails and makes nothing.
import { NEWS_DIR, NOTE_FILE } from '../src/update/news.ts';
import { nearestVersion, tagName, TAGS_ARGS, versionTagsOf } from '../src/update/version-tags.ts';
import type { Version } from '../src/update/version-tags.ts';

/** The first version, when no version tag is on the history. */
export const START: Version = { major: 0, minor: 9, patch: 0 };

/** What a run asks for: nothing (a push), or a bump made by hand. */
export type Bump = '' | 'minor' | 'major';

/** One git call in the repository: its standard output; it throws when git fails. */
export type GitOutput = (args: readonly string[]) => Promise<string>;

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
  return out
    .split(/[\0\n]/)
    .some(
      (path) => path.startsWith(`${NEWS_DIR}/`) && NOTE_FILE.test(path.slice(NEWS_DIR.length + 1)),
    );
}

/** The tag to make on `head` (a commit, or `HEAD`), or null for none. */
export async function nextVersionTag(
  git: GitOutput,
  head: string,
  bump: Bump,
): Promise<string | null> {
  const [tags, chainOut] = await Promise.all([
    git(TAGS_ARGS),
    git(['rev-list', '--first-parent', head]),
  ]);
  const { byCommit, names } = versionTagsOf(tags);
  const chain = chainOut.split('\n').filter((line) => line !== '');
  const nearest = nearestVersion(chain, byCommit);
  let next: Version;
  if (nearest === null) {
    next = START;
  } else if (bump === 'major') {
    next = { major: nearest.version.major + 1, minor: 0, patch: 0 };
  } else if (bump === 'minor') {
    next = { major: nearest.version.major, minor: nearest.version.minor + 1, patch: 0 };
  } else if (nearest.distance === 0) {
    return null; // the pushed commit carries one already
  } else if (await addsNote(git, `${nearest.commit}..${chain[0] ?? head}`)) {
    next = { major: nearest.version.major, minor: nearest.version.minor + 1, patch: 0 };
  } else {
    next = { ...nearest.version, patch: nearest.version.patch + 1 };
  }
  const tag = tagName(next);
  return names.has(tag) ? null : tag;
}
