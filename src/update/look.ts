// The look for a newer skydeck (F8's U2–U4; F38): whether the checkout skydeck runs from is behind
// the branch of a remote it follows, which commits would come, and whether they change the
// database's upgrade steps. One look, three callers: `skydeck update` (the command's order, every
// refusal a line), the window's server (its check and the dialog's look) and, through what the
// server stored, doctor. It changes nothing but what a fetch writes (the remote-tracking refs and
// FETCH_HEAD), and throws no error of its own: what cannot be told is a `cannot` with its line.
import type { Files } from '../platform/types.ts';
import { SkydeckError } from '../platform/errors.ts';
import { clip } from '../text/clip.ts';
import { sanitize } from '../text/sanitize.ts';
import { changedFiles, commitOf, gitFailure, GIT_MS } from './git.ts';
import type { Git, QuietFetchOptions } from './git.ts';

/** The file whose change says that the new code may upgrade the database (U4). */
export const MIGRATIONS = 'src/store/migrations.ts';
/** The most commits the report lists (U4). */
export const LISTED = 20;
/** The longest subject the report shows, in UTF-16 units (review 2 C2). */
const SUBJECT_MAX = 200;

/** What the look found: HEAD's commit and the upstream's, and (when they differ) the rest. */
export interface Update {
  branch: string;
  /** The upstream's short name (`origin/main`). */
  upstream: string;
  oldId: string;
  newId: string;
  /** How many commits the upstream has that HEAD does not. */
  count: number;
  /** How many commits HEAD has that the upstream does not (0 for the command: it refuses then). */
  ahead: number;
  /** The newest of them (at most LISTED), newest first. */
  commits: { id: string; subject: string }[];
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
    return await look(git, files, options, seen);
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
    // A rev-parse that timed out tells nothing about the checkout: a git failure.
    cannot(
      `${sanitize(root)} is not a git checkout; update it the way it was installed`,
      top.timedOut,
    );
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
    count: 0,
    ahead: 0,
    commits: [],
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
  update.commits = await newCommits(git, oldId, newId);
  update.upgradesDatabase = (await migrationsOf(git, oldId)) !== (await migrationsOf(git, newId));
  return known();
}

/** The newest LISTED commits of `old..new`, newest first: full id and subject. */
async function newCommits(
  git: Git,
  oldId: string,
  newId: string,
): Promise<{ id: string; subject: string }[]> {
  const out = await git.output([
    'log',
    '--no-show-signature', // log.showSignature would add gpg's lines
    '--no-color',
    '--encoding=UTF-8', // i18n.logOutputEncoding would recode the subjects
    '-z',
    `--max-count=${LISTED}`,
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

/** The blob MIGRATIONS has in `commit`; '' when the commit has no such file. */
async function migrationsOf(git: Git, commit: string): Promise<string> {
  const out = await git.output(['ls-tree', '--full-tree', '-z', commit, '--', MIGRATIONS]);
  // `<mode> SP <type> SP <object> TAB <path> NUL`
  const entry = out.split('\0')[0] ?? '';
  return entry.split('\t')[0]?.split(' ')[2] ?? '';
}

/** A commit's subject as the report shows it: sanitised, and clipped with `…` past SUBJECT_MAX. */
function subjectLine(subject: string): string {
  const text = sanitize(subject);
  return text.length > SUBJECT_MAX ? `${clip(text, SUBJECT_MAX - 1)}…` : text;
}

/** U4's lines for an update that brings commits (`skydeck update --check`'s, and the dialog's). */
export function report(update: Update): string[] {
  const lines = [
    `${counted(update.count, 'new commit', 'new commits')} on ${sanitize(update.upstream)} (${short(update.oldId)}..${short(update.newId)}):`,
    ...update.commits.map((c) => `  ${short(c.id)}  ${subjectLine(c.subject)}`),
  ];
  if (update.count > update.commits.length) {
    lines.push(`  … and ${update.count - update.commits.length} more`);
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
