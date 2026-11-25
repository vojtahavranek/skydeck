// The version tags (design.md 8, the version line): a version is a git tag `v<major>.<minor>.<patch>`
// (decimal numbers without leading zeros) on a commit of main, made by the workflow Version
// (.github/workflows/version.yml, scripts/version-tag.ts) at every push to main, or by the owner by
// hand. Nothing else is a version tag (`v1.2`, `v01.2.3`, `version-1`, `v1.2.3-rc1` are not); when a
// commit carries several, the highest counts. Pure: the tags are read from `for-each-ref`'s answer
// (TAGS_ARGS), which the caller runs; used by the reading of a commit's version
// (src/update/version.ts) and by the script that names the next tag.

/** A version: its three numbers. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** A version tag's name. */
export const VERSION_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** The version a tag names; null when the name is not a version tag's (or a number is not safe). */
export function parseVersionTag(name: string): Version | null {
  const found = VERSION_TAG.exec(name);
  if (found === null) return null;
  const [major, minor, patch] = [found[1], found[2], found[3]].map(Number) as [
    number,
    number,
    number,
  ];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch };
}

/** Negative when `a` is lower than `b`, 0 when equal, positive when higher. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `0.9.16`. */
export function versionText(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** `v0.9.16`: a tag's name, made of the numbers alone. */
export function tagName(version: Version): string {
  return `v${versionText(version)}`;
}

/**
 * `for-each-ref` of every tag: its full name, its object's type and id, and, for an annotated tag,
 * the type and id of the object it peels to; each field ends with a NUL, so no name can break a
 * record.
 */
export const TAGS_ARGS: readonly string[] = [
  'for-each-ref',
  '--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00',
  'refs/tags/',
];

/** A full object id: 40 hexadecimal digits (SHA-1), or 64 (SHA-256). */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The version tags of TAGS_ARGS' answer, by the commit they name: the highest of each commit's (a
 * tag whose object is not a commit, or whose name is not a version tag's, is none), and every
 * version tag's name (`names`, whatever its commit).
 */
export function versionTagsOf(out: string): {
  byCommit: Map<string, Version>;
  names: Set<string>;
} {
  const byCommit = new Map<string, Version>();
  const names = new Set<string>();
  // Five fields of a record, each ended by a NUL; records are separated by a line break.
  const fields = out.split('\0');
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const refname = (fields[i] ?? '').replace(/^\n/, '');
    const [type, id, peeledType, peeledId] = fields.slice(i + 1, i + 5) as [
      string,
      string,
      string,
      string,
    ];
    if (!refname.startsWith('refs/tags/')) continue;
    const name = refname.slice('refs/tags/'.length);
    const version = parseVersionTag(name);
    if (version === null) continue;
    names.add(name);
    const commit = type === 'commit' ? id : peeledType === 'commit' ? peeledId : null;
    if (commit === null || !OBJECT_ID.test(commit)) continue;
    const known = byCommit.get(commit);
    if (known === undefined || compareVersions(version, known) > 0) byCommit.set(commit, version);
  }
  return { byCommit, names };
}

/**
 * The nearest version tag on a first-parent history (`chain`: commit ids, the commit itself first):
 * its version and how many commits of the chain come before its commit; null when none carries one.
 */
export function nearestVersion(
  chain: readonly string[],
  byCommit: ReadonlyMap<string, Version>,
): { version: Version; distance: number; commit: string } | null {
  for (const [distance, commit] of chain.entries()) {
    const version = byCommit.get(commit);
    if (version !== undefined) return { version, distance, commit };
  }
  return null;
}
