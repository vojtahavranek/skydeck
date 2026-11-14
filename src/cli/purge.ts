// What `skydeck uninstall --purge` may remove (docs/design.md 8, 9.1; S2 4.2, plan A38): the
// directories skydeck keeps, each only with what skydeck itself writes there. Principle 6: nothing
// of the user's is destroyed — a directory that is a symbolic link, is another user's, cannot be
// looked at, or holds anything else is left alone, and the caller names it in its last line with
// exit 1, whatever directory it is (ruled, purge-care).
//
// It uses only lstat, readdir (Files.list), unlink (Files.remove) and rmdir (Files.rmdir), which
// behave alike on symbolic links in every Node.js 24: lstat never follows a link, unlink removes
// the link itself, rmdir refuses one (ENOTDIR). readdir does follow a link, so it is called on a
// path lstat has shown to be a directory (the checks for a late entry list it again later; should
// it have become a link by then, the rmdir that follows refuses it). Never removeTree or rmSync:
// on Node.js 24.12.0 rmSync's check of what a path is follows a symbolic link (24.19.0 looks at
// the link itself), so it leaves a dangling link in place without an error, with or without
// `force`, and throws on a link to a directory unless `recursive` is given. The removal itself
// never follows a link, on either version (ruled, purge-care).
//
// THE LISTS BELOW ARE THE ONE PLACE that says what skydeck writes into its directories. Whoever
// makes skydeck write a new file or directory into one of them adds it here (name and kind), or
// `--purge` leaves that directory alone from then on.
import { isAbsolute, join, resolve } from 'node:path';

import type { FileInfo, Files, Platform } from '../platform/types.ts';
import { describeError } from '../sessions/problems.ts';

type Kind = FileInfo['kind'];

/** One entry a directory may hold: its name, the kinds it may have (a socket is 'other'), and for a directory what it may hold in turn. */
interface Entry {
  name: string | RegExp;
  kinds: readonly Kind[];
  inside?: Spec;
}
export type Spec = readonly Entry[];

/** Files.writeText's and Files.symlink's temporary: `.<name>.<12 hex>.tmp`, beside the file. */
const HEX12 = '[0-9a-f]{12}';
const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A spool file as the hook names it (bin/skydeck-hook): `<time ns>-<claude pid>-<hook pid>.ev`. */
const SPOOL_FILE = '[0-9]+-[0-9]+-[0-9]+\\.ev';

// ---------------------------------------------------------------------------------------------
// The runtime directory (S2 4.2): plan A38's list lives here

/** terms/: keepers' sockets and `.pid` lines, the keeper's `.<id>.<pid>.tmp` and Files.writeText's temporary. */
const TERMS: Spec = [
  { name: new RegExp(`^${HEX12}\\.sock$`), kinds: ['other'] },
  { name: new RegExp(`^${HEX12}\\.pid$`), kinds: ['file'] },
  { name: new RegExp(`^\\.${HEX12}(?:\\.pid)?\\.(?:${HEX12}|[0-9]+)\\.tmp$`), kinds: ['file'] },
];

export const RUNTIME_DIR: Spec = [
  { name: 'server.json', kinds: ['file'] },
  { name: 'server.pid', kinds: ['file'] },
  { name: 'server.sock', kinds: ['other'] },
  { name: 'keepalive.pid', kinds: ['file'] },
  { name: 'keepalive.interop', kinds: ['file'] },
  { name: 'interop', kinds: ['symlink'] },
  { name: 'terms', kinds: ['dir'], inside: TERMS },
  { name: /^keeper-[A-Za-z0-9_-]+\.py$/, kinds: ['file'] },
  // The writers' temporaries: Files.writeText's and symlink's, the keep-alive script's `.<name>.<pid>.tmp`.
  {
    name: new RegExp(
      `^\\.(?:server\\.json|server\\.pid|keepalive\\.pid|keepalive\\.interop|interop|keeper-[A-Za-z0-9_-]+\\.py)\\.(?:${HEX12}|[0-9]+)\\.tmp$`,
    ),
    kinds: ['file', 'symlink'],
  },
];

// ---------------------------------------------------------------------------------------------
// Step 1's directories (design 9.1)

/** `<dataDir>`: the database and the files SQLite keeps beside it; install's two links and their temporaries. */
export const DATA_DIR: Spec = [
  { name: /^skydeck\.db(?:-wal|-shm|-journal)?$/, kinds: ['file'] },
  { name: 'skydeck-hook', kinds: ['symlink'] },
  { name: 'node', kinds: ['symlink'] },
  { name: new RegExp(`^\\.(?:skydeck-hook|node)\\.${HEX12}\\.tmp$`), kinds: ['symlink'] },
];

/**
 * `<stateDir>`: the spool (the hook's files and temporaries, bad/), locks/ (created, unused),
 * hook.log, the notes being edited and their temporaries, the window's logs, their rotations and
 * the rotations' temporaries (S2 4.2), and the runtime directory of this store when the rule put it
 * there (`run-<store id>`, S2 4.2).
 */
export function stateDirSpec(storeId: string): Spec {
  return [
    {
      name: 'spool',
      kinds: ['dir'],
      inside: [
        { name: new RegExp(`^${SPOOL_FILE}$`), kinds: ['file'] },
        { name: new RegExp(`^\\.${SPOOL_FILE}\\.tmp$`), kinds: ['file'] },
        {
          name: 'bad',
          kinds: ['dir'],
          inside: [{ name: new RegExp(`^${SPOOL_FILE}$`), kinds: ['file'] }],
        },
      ],
    },
    { name: 'locks', kinds: ['dir'], inside: [] },
    { name: 'hook.log', kinds: ['file'] },
    { name: new RegExp(`^note-${SESSION_ID}\\.md$`), kinds: ['file'] },
    { name: new RegExp(`^\\.note-${SESSION_ID}\\.md\\.${HEX12}\\.tmp$`), kinds: ['file'] },
    { name: /^(?:server|keepers)\.log(?:\.1)?$/, kinds: ['file'] },
    { name: /^\.(?:server|keepers)\.log\.1\.tmp$/, kinds: ['file'] },
    { name: `run-${storeId}`, kinds: ['dir'], inside: RUNTIME_DIR },
  ];
}

/** `<configDir>`: config.json (the user writes it; skydeck only reads it). */
export const CONFIG_DIR: Spec = [{ name: 'config.json', kinds: ['file'] }];

// ---------------------------------------------------------------------------------------------
// Removing one

export type Purged =
  | { kind: 'removed' }
  | { kind: 'absent' }
  /** Left alone on purpose: not skydeck's to remove. `why` follows "it". */
  | { kind: 'left'; why: string }
  /** Could not be judged or removed. `why` follows "it". */
  | { kind: 'failed'; why: string };

function ruleFor(spec: Spec, name: string): Entry | undefined {
  return spec.find((entry) =>
    typeof entry.name === 'string' ? entry.name === name : entry.name.test(name),
  );
}

/**
 * Removes `given` when it is a plain path (no `.` or `..`, which can lead through a symbolic link;
 * repeated and trailing slashes are dropped first), a directory of the user's that is not a symbolic link, and every entry below it is
 * one `spec` allows, of its kind, each directory the user's: first those entries, then each
 * directory once it is empty. Otherwise nothing of it is removed: 'left', with why. A look that
 * fails is 'failed'; so is a removal that fails, and an entry that appeared while it was purged (it
 * stays, and so does the directory holding it).
 */
export function purgeDir(platform: Platform, given: string, spec: Spec): Purged {
  const { files } = platform;
  // Repeated and trailing slashes dropped first: `<link>/` would be followed through the link.
  const dir = given.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  let why: string | null;
  try {
    if (!isAbsolute(dir)) return { kind: 'left', why: 'is not an absolute path' };
    if (resolve(dir) !== dir) {
      return { kind: 'left', why: 'is not a plain path (a . or .. in it)' };
    }
    const info = files.lstat(dir);
    if (info === null) return { kind: 'absent' };
    why = notOwnDirectory(info, platform.uid) ?? foreignIn(platform, dir, spec, '');
  } catch (error) {
    return { kind: 'failed', why: `cannot be looked at (${describeError(error)})` };
  }
  if (why !== null) return { kind: 'left', why };
  try {
    removeEntries(files, dir, spec, '');
    const [late] = files.list(dir);
    if (late !== undefined) {
      return {
        kind: 'failed',
        why: `still holds ${late}: something came into it while it was purged`,
      };
    }
    files.rmdir(dir); // rmdir(2): refuses a link, never follows one, and nothing else can go with it
  } catch (error) {
    if (error instanceof RemovalFailed) {
      return {
        kind: 'failed',
        why: `cannot be removed: ${error.entry} (${describeError(error.failure)})`,
      };
    }
    return { kind: 'failed', why: `cannot be removed (${describeError(error)})` };
  }
  return { kind: 'removed' };
}

function notOwnDirectory(info: FileInfo, uid: number): string | null {
  if (info.kind === 'symlink') return 'is a symbolic link';
  if (info.kind !== 'dir') return 'is not a directory';
  if (info.uid !== uid) return `belongs to uid ${info.uid}`;
  return null;
}

/** Why the first entry below `dir` (named from the top) is not one `spec` allows; null when all are. */
function foreignIn(platform: Platform, dir: string, spec: Spec, prefix: string): string | null {
  const { files } = platform;
  for (const name of files.list(dir)) {
    const path = `${prefix}${name}`;
    // The name first: one that is on no list is foreign, also when lstat cannot find it — a name
    // that is not UTF-8 is listed decoded and is then not there by that name (every rule is ASCII,
    // so a name a rule allows always is). Only a listed name that is gone is skipped.
    const rule = ruleFor(spec, name);
    if (rule === undefined) return `holds ${path}, which skydeck did not write`;
    const info = files.lstat(join(dir, name));
    if (info === null) continue; // gone meanwhile
    if (!rule.kinds.includes(info.kind)) return `holds ${path}, which skydeck did not write`;
    if (info.kind === 'dir') {
      if (info.uid !== platform.uid) return `holds ${path}, which belongs to uid ${info.uid}`;
      const inner = foreignIn(platform, join(dir, name), rule.inside ?? [], `${path}/`);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * Removes what `spec` allows below `dir` (`prefix` names it from the purged directory); an entry
 * that is not (one that appeared since the look) stays. A removal that fails is a RemovalFailed.
 */
function removeEntries(files: Files, dir: string, spec: Spec, prefix: string): void {
  for (const name of files.list(dir)) {
    const path = join(dir, name);
    const entry = `${prefix}${name}`;
    const info = files.lstat(path);
    const rule = ruleFor(spec, name);
    if (info === null || rule === undefined || !rule.kinds.includes(info.kind)) continue;
    if (info.kind === 'dir') {
      removeEntries(files, path, rule.inside ?? [], `${entry}/`);
      if (files.list(path).length === 0) removing(entry, () => files.rmdir(path));
    } else {
      removing(entry, () => files.remove(path));
    }
  }
}

/** A removal that failed, and the entry (named from the purged directory) it failed on. */
class RemovalFailed extends Error {
  readonly entry: string;
  readonly failure: unknown;
  constructor(entry: string, failure: unknown) {
    super(`cannot remove ${entry}`);
    this.entry = entry;
    this.failure = failure;
  }
}

function removing(entry: string, remove: () => void): void {
  try {
    remove();
  } catch (error) {
    throw new RemovalFailed(entry, error);
  }
}
