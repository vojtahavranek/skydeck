// The look for a newer skydeck (F8's U2–U4; F38): whether the checkout skydeck runs from is behind
// the branch of a remote it follows, which commits would come, which notes of what is new they
// bring (src/update/news.ts), and whether they change the database's upgrade steps. One look, three callers: `skydeck update` (the command's order, every
// refusal a line), the window's server (its check and the dialog's look) and, through what the
// server stored, doctor. It changes nothing but what a fetch writes (the remote-tracking refs and
// FETCH_HEAD), and throws no error of its own: what cannot be told is a `cannot` with its line.
import type { Files } from '../platform/types.ts';
import { SkydeckError } from '../platform/errors.ts';
import { clip } from '../text/clip.ts';
import { sanitize } from '../text/sanitize.ts';
import {
  changedFiles,
  commitOf,
  gitFailure,
  GIT_MS,
  PARTIAL_CLONE_ARGS,
  partialCloneIn,
} from './git.ts';
import type { Git, QuietFetchOptions } from './git.ts';
import { NEWS_DIR, NOTE_BYTES, NOTE_FILE, NOTES_SHOWN, parseNote } from './news.ts';
import type { Note } from './news.ts';
import { versionGitOf, versionName, versionOf } from './version.ts';

/** The file whose change says that the new code may upgrade the database (U4). */
export const MIGRATIONS = 'src/store/migrations.ts';
/** The most commits the report lists (U4). */
export const LISTED = 20;
/** The longest subject the report shows, in UTF-16 units (review 2 C2). */
const SUBJECT_MAX = 200;
/** The most note files a look reads (newest first); the rest count as notes unread. */
export const NOTES_READ = 40;
/**
 * The largest tree of NEWS_DIR (its object, in bytes) whose notes a look reads, in either commit;
 * a larger one, or a listing of it past four times as many bytes, gives no notes.
 */
export const NEWS_TREE_BYTES = 256 * 1024;
const NEWS_LIST_BYTES = 4 * NEWS_TREE_BYTES;

/** What the look found: HEAD's commit and the upstream's, and (when they differ) the rest. */
export interface Update {
  branch: string;
  /** The upstream's short name (`origin/main`). */
  upstream: string;
  oldId: string;
  newId: string;
  /**
   * The versions of the two commits (src/update/version.ts: `0.9.16`, or `0.9.16+3` past the
   * nearest version tag), each read from the tags and the history git has; null: no version. The
   * same for both when nothing would come.
   */
  oldVersion: string | null;
  newVersion: string | null;
  /** How many commits the upstream has that HEAD does not. */
  count: number;
  /** How many commits HEAD has that the upstream does not (0 for the command: it refuses then). */
  ahead: number;
  /** The newest of them (at most LISTED), newest first. */
  commits: { id: string; subject: string }[];
  /**
   * The notes the update brings — the note files the new commit has and HEAD's does not (by
   * path), read from git's objects — newest first (by file name, descending), at most
   * NOTES_SHOWN: sanitised and clipped. A file that is not a well-formed note is left out.
   */
  notes: Note[];
  /** How many more notes it brings than `notes` holds (those not read count too). */
  moreNotes: number;
  /** The newest commits (at most LISTED) that add none of those notes, newest first. */
  others: { id: string; subject: string }[];
  /** How many commits of the update add none of its notes. */
  otherCount: number;
  /** Whether MIGRATIONS differs between the two commits, or is gone. */
  upgradesDatabase: boolean;
}

/**
 * Which fetch the look makes: the command's, in the owner's terminal; none (what the
 * remote-tracking ref already says); or the window's, which never asks (Git.fetchQuietly).
 */
export type Fetch = 'terminal' | 'none' | { quiet: QuietFetchOptions };

export interface LookOptions {
  fetch: Fetch;
  /**
   * false: the command's order exactly (U2): a changed file refuses before the fetch, a failed
   * fetch and an ahead or diverged checkout after it, each a `cannot`. true: the window's: a fetch
   * that fails does not end the look (`fetchFailed`), and the two refusals that only stop an apply
   * — changes, ahead — are `blocked`, the facts read all the same.
   */
  tolerant: boolean;
}

export type Looked =
  /**
   * Nothing is known: U2's line; `head` is HEAD's full id when the look got that far. `failed`: a
   * git call failed or timed out (git missing, an answer that is not one) — not a state of the
   * checkout (not a checkout, a detached HEAD, no branch of a remote, a change while the fetch
   * ran). `fetchFailed`: the quiet fetch's line, when it ran and failed before the look ended so.
   */
  | {
      kind: 'cannot';
      line: string;
      head: string | null;
      failed: boolean;
      fetchFailed: string | null;
    }
  /** What is known; `blocked`: why it cannot be applied as it is; `fetchFailed`: the fetch's line. */
  | { kind: 'known'; update: Update; blocked: string | null; fetchFailed: string | null };

/** The short id of a commit: its first seven hexadecimal digits, whatever git's settings say. */
export function short(id: string): string {
  return id.slice(0, 7);
}

/** `n` and the word for one or more of it (`1 file`, `3 files`). */
export function counted(n: number, one: string, more: string): string {
  return `${n} ${n === 1 ? one : more}`;
}

/** A count git printed; a SkydeckError naming the call when it is not one. */
async function countOf(git: Git, args: readonly string[]): Promise<number> {
  const text = (await git.output(args)).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new SkydeckError('git rev-list failed: its answer is not a count; nothing was changed');
  }
  return Number(text);
}

/** The ref HEAD names (`refs/heads/<branch>`); null for a detached HEAD (or one that names no branch). */
async function headRef(git: Git): Promise<string | null> {
  const args = ['symbolic-ref', '--quiet', 'HEAD'];
  const head = await git.run(args);
  if (head.code === 1 && !head.timedOut) return null;
  if (head.code !== 0 || head.timedOut) throw gitFailure(args, head, GIT_MS);
  const ref = head.stdout.trim();
  return ref.startsWith('refs/heads/') ? ref : null;
}

/** U2 6's line when a tracked file changed, is staged or unmerged; null when none (untracked files do not count). */
async function changesLine(git: Git): Promise<string | null> {
  const changed = await changedFiles(git);
  const [first] = changed;
  if (first === undefined) return null;
  return `this checkout has changes that are not committed (${counted(changed.length, 'file', 'files')}, the first: ${sanitize(first)}); commit or undo them first`;
}

/** U2 8's line for a checkout with `ahead` commits its upstream does not have. */
function aheadLine(ahead: number, upstream: string): string {
  return `this checkout has ${counted(ahead, 'commit', 'commits')} that ${sanitize(upstream)} does not have; update it with git yourself`;
}

/**
 * A refusal the look makes itself, with its line (U2's words); `failed` when what it says comes
 * from a git call that failed or timed out rather than from the checkout's state.
 */
class Refusal extends SkydeckError {
  readonly failed: boolean;
  constructor(line: string, failed: boolean) {
    super(line);
    this.failed = failed;
  }
}

/** What the look saw before it ended: HEAD, and the quiet fetch's failure. */
interface Seen {
  head: string | null;
  fetchFailed: string | null;
}

/**
 * The look (U2–U4). The command's order with `tolerant: false`, the window's with `true` (see
 * LookOptions). A SkydeckError of a git call inside is a `cannot` with its message; any other
 * error (an AbortError of the window's stop, a runner that failed) is thrown on.
 */
export async function lookForUpdate(git: Git, files: Files, options: LookOptions): Promise<Looked> {
  const seen: Seen = { head: null, fetchFailed: null };
  try {
    const looked = await look(git, files, options, seen);
    if (looked.kind === 'known') await addVersions(git, looked.update);
    return looked;
  } catch (error) {
    if (error instanceof SkydeckError) {
      return {
        kind: 'cannot',
        line: error.message,
        head: seen.head,
        // A refusal says whether git failed; any other SkydeckError is a git call that failed.
        failed: error instanceof Refusal ? error.failed : true,
        fetchFailed: seen.fetchFailed,
      };
    }
    throw error;
  }
}

async function look(
  git: Git,
  files: Files,
  { fetch, tolerant }: LookOptions,
  seen: Seen,
): Promise<Looked> {
  const { root } = git;
  const cannot = (line: string, failed = false): never => {
    throw new Refusal(line, failed);
  };
  // 2, 3: git is found, and the root is the top of a work tree of its own.
  const top = await git.run(['rev-parse', '--show-toplevel']);
  const topDir = top.stdout.replace(/\n$/, '');
  if (
    top.code !== 0 ||
    top.timedOut ||
    topDir === '' ||
    files.realpath(topDir) === null ||
    files.realpath(topDir) !== files.realpath(root)
  ) {
    // A rev-parse that timed out tells nothing about the checkout: for the window a git failure,
    // in git's words; the command keeps its own line.
    if (tolerant && top.timedOut) throw gitFailure(['rev-parse', '--show-toplevel'], top, GIT_MS);
    cannot(`${sanitize(root)} is not a git checkout; update it the way it was installed`);
  }
  // 4: on a branch.
  const ref = await headRef(git);
  if (ref === null) {
    return cannot('this checkout is not on a branch (detached HEAD); update it with git yourself');
  }
  const branch = ref.slice('refs/heads/'.length);
  // 5: following a branch of a remote.
  // Each field ends with a NUL, so that a line break in one (a remote's name may hold one) cannot
  // be taken for the end of the record. The pattern matches the branch alone (a branch `main`
  // leaves no room for a `main/…`), so the one record, when there is one, is the branch's.
  const tracking = await git.output([
    'for-each-ref',
    '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:short)%00',
    ref,
  ]);
  const fields = tracking.split('\0');
  const [refname, upstreamRef = '', remote = '', upstream = ''] = fields;
  if (
    refname !== ref ||
    !upstreamRef.startsWith('refs/remotes/') ||
    remote === '' ||
    remote === '.'
  ) {
    cannot(
      `the branch ${sanitize(branch)} follows no branch of a remote; update it with git yourself`,
    );
  }
  // 6: no tracked change (untracked files do not count) — for the command, before the fetch.
  if (!tolerant) {
    const changes = await changesLine(git);
    if (changes !== null) cannot(changes);
  }
  const oldId = await commitOf(git, 'HEAD');
  seen.head = oldId;
  // 7: the fetch.
  let fetchFailed: string | null = null;
  if (fetch === 'terminal') {
    // In the owner's terminal: a passphrase prompt works, Ctrl+C ends it.
    if ((await git.interactive(['fetch', '--quiet', '--', remote])) !== 0) {
      cannot(
        `git fetch from ${sanitize(remote)} failed (git's own message is above); nothing was changed`,
        true,
      );
    }
  } else if (fetch !== 'none') {
    fetchFailed = await git.fetchQuietly(remote, fetch.quiet);
    seen.fetchFailed = fetchFailed; // kept when the look then ends as a `cannot`
    if (fetchFailed !== null && !tolerant) cannot(fetchFailed, true);
  }
  if (fetch !== 'none') {
    // The fetch can wait at a prompt while the checkout is used: what was looked at before it is
    // looked at again (review 2 C3).
    const refAfter = await headRef(git);
    const headAfter = await commitOf(git, 'HEAD');
    if (refAfter !== ref || headAfter !== oldId) {
      const where =
        refAfter === null ? 'detached HEAD' : sanitize(refAfter.slice('refs/heads/'.length));
      cannot(
        `this checkout changed while git fetch ran (${where} at ${short(headAfter)}); run skydeck update again`,
      );
    }
  }
  // For the command a change refuses (again, after the fetch); for the window it blocks an apply.
  const changes = await changesLine(git);
  if (changes !== null && !tolerant) cannot(changes);
  let blocked = changes;
  const newId = await commitOf(git, upstreamRef);
  const update: Update = {
    branch,
    upstream,
    oldId,
    newId,
    oldVersion: null,
    newVersion: null,
    count: 0,
    ahead: 0,
    commits: [],
    notes: [],
    moreNotes: 0,
    others: [],
    otherCount: 0,
    upgradesDatabase: false,
  };
  const known = (): Looked => ({ kind: 'known', update, blocked, fetchFailed });
  if (newId === oldId) return known();
  // 8: HEAD is behind the upstream, not ahead of it and not beside it.
  const ancestorArgs = ['merge-base', '--is-ancestor', oldId, newId];
  const ancestor = await git.run(ancestorArgs);
  if (ancestor.code === 1 && !ancestor.timedOut) {
    const ahead = await countOf(git, ['rev-list', '--count', `${newId}..${oldId}`]);
    if (!tolerant) cannot(aheadLine(ahead, upstream));
    update.ahead = ahead;
    blocked ??= aheadLine(ahead, upstream);
  } else if (ancestor.code !== 0 || ancestor.timedOut) {
    throw gitFailure(ancestorArgs, ancestor, GIT_MS);
  }
  update.count = await countOf(git, ['rev-list', '--count', `${oldId}..${newId}`]);
  if (update.count === 0 && update.ahead > 0) return known(); // ahead only: nothing would come
  // The notes first: the commits that add them are not among the other changes. Reading them never
  // costs the update itself: whatever stops it (a git call that fails or times out, a limit
  // passed) gives no notes, and every commit is one of the other changes.
  let news: News = NO_NEWS;
  try {
    news = await newsOf(git, oldId, newId);
  } catch (error) {
    if (!(error instanceof SkydeckError)) throw error;
  }
  const listed = await newCommits(git, oldId, newId, LISTED + news.adders.size);
  update.commits = listed.slice(0, LISTED);
  update.notes = news.notes.slice(0, NOTES_SHOWN);
  update.moreNotes = news.notes.length - update.notes.length + news.unread;
  update.others = listed.filter((c) => !news.adders.has(c.id)).slice(0, LISTED);
  update.otherCount = Math.max(0, update.count - news.adders.size);
  update.upgradesDatabase = (await migrationsOf(git, oldId)) !== (await migrationsOf(git, newId));
  return known();
}

/**
 * The versions of a look that is `known`, both side by side, each call within GIT_MS, offline. It
 * never costs the look: whatever stops it gives no version, and the rest stays as it is (only the
 * AbortError of the window's stop is thrown on, as from any other call of the look).
 */
async function addVersions(git: Git, update: Update): Promise<void> {
  const versionGit = versionGitOf(git);
  const same = update.newId === update.oldId;
  const [oldVersion, newVersion] = await Promise.all([
    versionOf(versionGit, update.oldId, GIT_MS),
    same ? Promise.resolve(null) : versionOf(versionGit, update.newId, GIT_MS),
  ]);
  update.oldVersion = oldVersion;
  update.newVersion = same ? oldVersion : newVersion;
}

/** The newest `max` commits of `old..new`, newest first: full id and subject. */
async function newCommits(
  git: Git,
  oldId: string,
  newId: string,
  max: number,
): Promise<{ id: string; subject: string }[]> {
  const out = await git.output([
    'log',
    '--no-show-signature', // log.showSignature would add gpg's lines
    '--no-color',
    '--encoding=UTF-8', // i18n.logOutputEncoding would recode the subjects
    '-z',
    `--max-count=${max}`,
    '--format=%H%x00%s',
    `${oldId}..${newId}`,
    '--',
  ]);
  const fields = out.split('\0');
  const commits: { id: string; subject: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    commits.push({ id: fields[i] ?? '', subject: fields[i + 1] ?? '' });
  }
  return commits;
}

/** A note file of a commit: its blob and its size in bytes. */
interface NoteFile {
  blob: string;
  size: number;
}

/** What an update brings of the notes: the well-formed ones read, newest first; how many were not read; the commits that add a note's file. */
interface News {
  notes: Note[];
  unread: number;
  adders: Set<string>;
}

const NO_NEWS: News = { notes: [], unread: 0, adders: new Set() };

/** Every call of the notes' reading: no object fetched (a partial clone's are missing, not fetched). */
const OFFLINE = { offline: true } as const;

/** Whether the checkout is a partial clone, whose missing objects an older git would fetch. */
async function partialClone(git: Git): Promise<boolean> {
  const result = await git.run(PARTIAL_CLONE_ARGS);
  if (result.code === 1 && !result.timedOut) return false; // no such setting
  if (result.code !== 0 || result.timedOut) throw gitFailure(PARTIAL_CLONE_ARGS, result, GIT_MS);
  return partialCloneIn(result.stdout);
}

/**
 * The sizes of NEWS_DIR's tree in each commit (`cat-file --batch-check`, one call): null for a
 * commit that has no such tree.
 */
async function treeSizes(git: Git, commits: readonly string[]): Promise<(number | null)[]> {
  const out = await git.output(['cat-file', '--batch-check'], {
    ...OFFLINE,
    input: commits.map((commit) => `${commit}:${NEWS_DIR}\n`).join(''),
  });
  const lines = out.split('\n');
  return commits.map((_, i) => {
    // `<object> SP <type> SP <size>`, or `<name> SP missing`
    const found = /^[0-9a-f]+ tree ([0-9]+)$/.exec(lines[i] ?? '');
    return found === null ? null : Number(found[1]);
  });
}

/**
 * The note files `commit` has (`ls-tree -l` of NEWS_DIR, from git's objects, never the work tree):
 * regular files of NEWS_DIR itself whose name is a note's, by path. A listing past
 * NEWS_LIST_BYTES is a SkydeckError (the look then shows no notes).
 */
async function noteFiles(git: Git, commit: string): Promise<Map<string, NoteFile>> {
  const args = ['ls-tree', '-l', '-z', '--full-tree', commit, '--', `${NEWS_DIR}/`];
  const out = await git.output(args, { ...OFFLINE, maxBytes: NEWS_LIST_BYTES });
  if (Buffer.byteLength(out) >= NEWS_LIST_BYTES) {
    throw new SkydeckError(`git ls-tree of ${NEWS_DIR} is longer than ${NEWS_LIST_BYTES} bytes`);
  }
  const files = new Map<string, NoteFile>();
  // `<mode> SP <type> SP <object> SP+ <size> TAB <path> NUL`
  for (const entry of out.split('\0')) {
    const found = /^(100644|100755) blob ([0-9a-f]+) +([0-9]+)\t([^]*)$/.exec(entry);
    if (found === null) continue;
    const [, , blob = '', size = '', path = ''] = found;
    const name = path.slice(NEWS_DIR.length + 1);
    if (!path.startsWith(`${NEWS_DIR}/`) || !NOTE_FILE.test(name)) continue;
    files.set(path, { blob, size: Number(size) });
  }
  return files;
}

/**
 * The notes `newId` brings over `oldId` (S2 16.5 "What an update brings"): the note files only the
 * new commit has, newest first; of them the first NOTES_READ are read (one larger than NOTE_BYTES
 * is not), and the well-formed notes kept; `unread`: how many were not read for that limit;
 * `adders`: the commits of the update that add a note kept or one not read for that limit — a
 * commit whose note was read and refused is one of the other changes. Nothing in a partial clone;
 * nothing when NEWS_DIR's tree is larger than NEWS_TREE_BYTES in
 * either commit (a SkydeckError, as every failure of a call here).
 */
async function newsOf(git: Git, oldId: string, newId: string): Promise<News> {
  if (await partialClone(git)) return NO_NEWS;
  const [oldSize, newSize] = await treeSizes(git, [oldId, newId]);
  if (newSize === null || newSize === undefined) return NO_NEWS;
  if (newSize > NEWS_TREE_BYTES || (oldSize ?? 0) > NEWS_TREE_BYTES) {
    throw new SkydeckError(`the tree of ${NEWS_DIR} is larger than ${NEWS_TREE_BYTES} bytes`);
  }
  const before =
    oldSize === null || oldSize === undefined ? new Map() : await noteFiles(git, oldId);
  const after = await noteFiles(git, newId);
  const added = [...after.keys()]
    .filter((path) => !before.has(path))
    .sort()
    .reverse();
  const notes: Note[] = [];
  const kept: string[] = [];
  for (const path of added.slice(0, NOTES_READ)) {
    const file = after.get(path);
    if (file === undefined || file.size > NOTE_BYTES) continue;
    const text = await git.output(['cat-file', 'blob', file.blob], {
      ...OFFLINE,
      maxBytes: NOTE_BYTES,
    });
    const note = parseNote(text);
    if (note === null) continue;
    notes.push(note);
    kept.push(path);
  }
  const notRead = added.slice(NOTES_READ);
  return {
    notes,
    unread: notRead.length,
    adders: await noteCommits(git, oldId, newId, [...kept, ...notRead]),
  };
}

/** The commits of `old..new` that add one of `paths` (none: no git call, which without a path would name every commit that adds a file). */
async function noteCommits(
  git: Git,
  oldId: string,
  newId: string,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const out = await git.output(
    [
      'log',
      '--diff-filter=A',
      '--no-renames', // a note moved from another name is added here
      '--no-show-signature',
      '--no-color',
      '-z',
      '--format=%H',
      `${oldId}..${newId}`,
      '--',
      ...paths,
    ],
    OFFLINE,
  );
  return new Set(
    out
      .split('\0')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  );
}

/** The blob MIGRATIONS has in `commit`; '' when the commit has no such file. */
async function migrationsOf(git: Git, commit: string): Promise<string> {
  const out = await git.output(['ls-tree', '--full-tree', '-z', commit, '--', MIGRATIONS]);
  // `<mode> SP <type> SP <object> TAB <path> NUL`
  const entry = out.split('\0')[0] ?? '';
  return entry.split('\t')[0]?.split(' ')[2] ?? '';
}

/** A commit's subject as the report shows it: sanitised, and clipped with `…` past SUBJECT_MAX. */
export function subjectLine(subject: string): string {
  const text = sanitize(subject);
  return text.length > SUBJECT_MAX ? `${clip(text, SUBJECT_MAX - 1)}…` : text;
}

/**
 * The versions an update goes between, `0.9.16 → 0.9.19` (a version not known: the commit's short
 * id); null when neither is known.
 */
export function versionsLine(update: Update): string | null {
  if (update.oldVersion === null && update.newVersion === null) return null;
  return `${versionName(update.oldVersion, update.oldId)} → ${versionName(update.newVersion, update.newId)}`;
}

/** `skydeck is up to date (<branch> at <version>, <id>, as <upstream>)`; without a version known, the id alone. */
export function upToDateLine(update: Update): string {
  const at =
    update.oldVersion === null
      ? short(update.oldId)
      : `${update.oldVersion}, ${short(update.oldId)}`;
  return `skydeck is up to date (${sanitize(update.branch)} at ${at}, as ${sanitize(update.upstream)})`;
}

/** U4's lines for an update that brings commits (`skydeck update --check`'s and `skydeck update`'s). */
export function report(update: Update): string[] {
  const versions = versionsLine(update);
  const ids = `${short(update.oldId)}..${short(update.newId)}`;
  const lines = [
    `${counted(update.count, 'new commit', 'new commits')} on ${sanitize(update.upstream)} (${versions === null ? ids : `${versions}, ${ids}`}):`,
    ...update.commits.map((c) => `  ${short(c.id)}  ${subjectLine(c.subject)}`),
  ];
  if (update.count > update.commits.length) {
    lines.push(`  … and ${update.count - update.commits.length} more`);
  }
  if (update.notes.length > 0) {
    lines.push('what is new:', ...update.notes.map((note) => `  ${note.title}`));
    if (update.moreNotes > 0) lines.push(`  … and ${update.moreNotes} more`);
  }
  if (update.upgradesDatabase) {
    // F21: the store keeps a copy of the database before it upgrades it; the guide says how to go
    // back to the commit the checkout is at now, which this line names.
    lines.push(
      `this update changes the database's upgrade steps: it may upgrade the database, which an older checkout cannot open; a copy of the database as it was is kept first, and docs/install.md ("Going back") says how to return to ${short(update.oldId)}`,
    );
  }
  return lines;
}
