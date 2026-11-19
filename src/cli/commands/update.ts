// `skydeck update [--check]` (F8; S2 16.5): brings the checkout the command runs from up to date
// with the branch of a remote it follows, and restarts the window's server for the new code.
//
// It looks first (U2–U4): the checkout is a git work tree of its own, on a branch that follows a
// branch of a remote, with no tracked change; then `git fetch`, the commits that came, and whether
// they change the database's upgrade steps. `--check` ends there. Applying (U5) goes in this
// order: the window's server of this checkout is stopped (its open pages counted first) — so that
// no new code opens the database while an old server holds it —, the fetched commit is merged by
// its id (`merge --ff-only`), and, only when the stopped server had a page open, the new
// checkout's own `bin/skydeck window` is run as a new process: it upgrades the database, starts
// the new server and waits for the window, which reloads itself (S2 6.3, plan C20).
//
// This process is the OLD code (U6). After the merge the files on disk are the new code, so from
// then on it loads nothing: every module it still needs is imported at the top of this file
// (statically, so it is loaded before the command runs), no `import()` and no read of the
// checkout's files follows the merge, and all the new code must do is done by the child.
//
// Standard output carries the report and the result line; every other line goes to standard
// error with the `skydeck: ` prefix. Foreign text (a branch, a remote, a path, a commit's subject,
// git's message) is sanitised.
import { join, resolve } from 'node:path';

import { SkydeckError } from '../../platform/errors.ts';
import type { RunResult } from '../../platform/types.ts';
import { DatabaseNewerError } from '../../store/store.ts';
import { sanitize } from '../../text/sanitize.ts';
import { computeBuild } from '../../window/build.ts';
import { findServer, stopServer } from '../../window/lifecycle.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import { clip } from '../clip.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import {
  changedFiles,
  commitOf,
  definedEnv,
  failureReason,
  gitFailure,
  gitOn,
  GIT_MS,
  MERGE_MS,
  untrackedFiles,
} from '../update-git.ts';
import type { Git } from '../update-git.ts';
import { windowTimes } from '../window-open.ts';
import type { WindowTimes } from '../window-open.ts';
import { hungServerLine, keepRunning, pagesOf } from './window.ts';

const SPEC: ArgSpec = {
  usage: `skydeck update [--check]

Brings this checkout up to date with the branch of a remote it follows (git fetch, then a
fast-forward), and restarts the window's server for the new code: the window stays open and
reloads itself; the sessions in it keep running.

  --check   only look: fetch, and list the new commits; nothing else changes
`,
  flags: { check: { type: 'boolean' } },
  min: 0,
  max: 0,
};

const IN_CLAUDE_CODE =
  "skydeck update is not run from inside a Claude Code session: it restarts the window's server, and every session in the window would inherit that session's environment; run it in a terminal of your own (skydeck update --check only looks)";

/** The file whose change says that the new code may upgrade the database (U4). */
const MIGRATIONS = 'src/store/migrations.ts';
/** The most commits the report lists (U4). */
const LISTED = 20;

export const command: Command = {
  name: 'update',
  summary: "Bring this checkout up to date and restart the window's server",
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const check = parsed.flags.check === true;
    // U2 1: the server it restarts would give every session in the window this environment.
    if (!check && ctx.platform.env.CLAUDECODE !== undefined) {
      throw new SkydeckError(IN_CLAUDE_CODE);
    }
    const git = gitOn(ctx.platform, ctx.platform.appRoot);
    const say = (line: string): void => ctx.io.stdout(`${line}\n`);
    const update = await whatIsNew(ctx, git);
    if (update.newId === update.oldId) {
      say(
        `skydeck is up to date (${sanitize(update.branch)} at ${short(update.oldId)}, as ${sanitize(update.upstream)})`,
      );
      return EXIT.ok;
    }
    for (const line of report(update)) say(line);
    if (check) {
      say('run skydeck update to apply it');
      return EXIT.ok;
    }
    return apply(ctx, git, update);
  },
};

/** What the fetch brought: HEAD's commit and the upstream's, and (when they differ) the rest. */
interface Update {
  branch: string;
  /** The upstream's short name (`origin/main`). */
  upstream: string;
  oldId: string;
  newId: string;
  /** How many commits the upstream has that HEAD does not. */
  count: number;
  /** The newest of them (at most LISTED), newest first. */
  commits: { id: string; subject: string }[];
  /** Whether MIGRATIONS differs between the two commits, or is gone. */
  upgradesDatabase: boolean;
}

/** The short id of a commit: its first seven hexadecimal digits, whatever git's settings say. */
function short(id: string): string {
  return id.slice(0, 7);
}

/** `n` and the word for one or more of it (`1 file`, `3 files`). */
function counted(n: number, one: string, more: string): string {
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

/** U2 6: no tracked file changed, staged or unmerged (untracked files do not count). */
async function refuseChanges(git: Git): Promise<void> {
  const changed = await changedFiles(git);
  const [first] = changed;
  if (first !== undefined) {
    throw new SkydeckError(
      `this checkout has changes that are not committed (${counted(changed.length, 'file', 'files')}, the first: ${sanitize(first)}); commit or undo them first`,
    );
  }
}

/** U2 2–8 in their order, then U4's facts. Every refusal is a SkydeckError; nothing is changed. */
async function whatIsNew(ctx: Context, git: Git): Promise<Update> {
  const { root } = git;
  const { files } = ctx.platform;
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
    throw new SkydeckError(
      `${sanitize(root)} is not a git checkout; update it the way it was installed`,
    );
  }
  // 4: on a branch.
  const ref = await headRef(git);
  if (ref === null) {
    throw new SkydeckError(
      'this checkout is not on a branch (detached HEAD); update it with git yourself',
    );
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
    throw new SkydeckError(
      `the branch ${sanitize(branch)} follows no branch of a remote; update it with git yourself`,
    );
  }
  // 6: no tracked change (untracked files do not count).
  await refuseChanges(git);
  const oldId = await commitOf(git, 'HEAD');
  // 7: the fetch, in the owner's terminal: a passphrase prompt works, Ctrl+C ends it.
  if ((await git.interactive(['fetch', '--quiet', '--', remote])) !== 0) {
    throw new SkydeckError(
      `git fetch from ${sanitize(remote)} failed (git's own message is above); nothing was changed`,
    );
  }
  // The fetch can wait at a prompt while the checkout is used: what was looked at before it is
  // looked at again (review 2 C3).
  const refAfter = await headRef(git);
  const headAfter = await commitOf(git, 'HEAD');
  if (refAfter !== ref || headAfter !== oldId) {
    const where =
      refAfter === null ? 'detached HEAD' : sanitize(refAfter.slice('refs/heads/'.length));
    throw new SkydeckError(
      `this checkout changed while git fetch ran (${where} at ${short(headAfter)}); run skydeck update again`,
    );
  }
  await refuseChanges(git);
  const newId = await commitOf(git, upstreamRef);
  const update: Update = {
    branch,
    upstream,
    oldId,
    newId,
    count: 0,
    commits: [],
    upgradesDatabase: false,
  };
  if (newId === oldId) return update;
  // 8: HEAD is behind the upstream, not ahead of it and not beside it.
  const ancestorArgs = ['merge-base', '--is-ancestor', oldId, newId];
  const ancestor = await git.run(ancestorArgs);
  if (ancestor.code === 1 && !ancestor.timedOut) {
    const ahead = await countOf(git, ['rev-list', '--count', `${newId}..${oldId}`]);
    throw new SkydeckError(
      `this checkout has ${counted(ahead, 'commit', 'commits')} that ${sanitize(upstream)} does not have; update it with git yourself`,
    );
  }
  if (ancestor.code !== 0 || ancestor.timedOut) throw gitFailure(ancestorArgs, ancestor, GIT_MS);
  update.count = await countOf(git, ['rev-list', '--count', `${oldId}..${newId}`]);
  update.commits = await newCommits(git, oldId, newId);
  update.upgradesDatabase = (await migrationsOf(git, oldId)) !== (await migrationsOf(git, newId));
  return update;
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

/** The longest subject the report shows, in UTF-16 units (review 2 C2). */
const SUBJECT_MAX = 200;

/** A commit's subject as the report shows it: sanitised, and clipped with `…` past SUBJECT_MAX. */
function subjectLine(subject: string): string {
  const text = sanitize(subject);
  return text.length > SUBJECT_MAX ? `${clip(text, SUBJECT_MAX - 1)}…` : text;
}

/** U4's lines for an update that brings commits. */
function report(update: Update): string[] {
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

/** What step 1 did: whether it stopped a server, and the pages that server had. */
interface Stopped {
  stopped: boolean;
  pages: number;
}

/**
 * The command's lines, and the signals it holds once the server's stop has begun (ruled by the plan
 * owner, review 2 S2 and its re-check's R1): from the moment stopServer is called — or, when no
 * server is stopped, from the merge's start — until the last line, SIGINT and SIGTERM do not end
 * the command: it never ends silently with the server stopped or the checkout being written.
 * `interrupted` says whether one came. Before the hold starts a signal ends the command as it always
 * did (the fetch above all). SIGHUP is not held: with the terminal gone nobody would read what the
 * command says (install.md says what a closed terminal leaves).
 */
interface Held {
  /** Starts the hold (right before stopServer, and right before the merge); again does nothing. */
  start(): void;
  /** Ends it; again does nothing. */
  release(): void;
  interrupted(): boolean;
  out(line: string): void;
  err(line: string): void;
}

function held(ctx: Context): Held {
  let release: (() => void) | null = null;
  let interrupted = false;
  return {
    start() {
      release ??= ctx.io.holdSignals(() => {
        interrupted = true;
      });
    },
    release() {
      release?.();
    },
    interrupted: () => interrupted,
    out(line) {
      ctx.io.stdout(`${line}\n`);
    },
    err(line) {
      ctx.io.stderr(`skydeck: ${line}\n`);
    },
  };
}

/** How the merge ended: by itself with a code, not at all (it did not start), or cut off. */
type Merged =
  | { kind: 'ended'; result: RunResult }
  | { kind: 'not-started'; why: string }
  | { kind: 'cut-off'; why: string };

/**
 * `merge --ff-only --no-squash <id>` in a session of its own (the terminal's Ctrl+C and hang-up do
 * not reach it, ruled by the plan owner, S2). `--no-squash`: a `branch.<name>.mergeOptions` of
 * `--squash` would make it exit 0 with HEAD where it was (review 2 C1).
 */
async function merge(git: Git, id: string): Promise<Merged> {
  let result: RunResult;
  try {
    // The merge and every look after it in a session of its own (ruled, S2; review 2's re-check M1).
    git.ownSessions();
    result = await git.run(['merge', '--ff-only', '--no-squash', id], MERGE_MS);
  } catch (error) {
    // git not found, or a start that failed (EAGAIN …): it changed nothing (review 2 C4).
    return {
      kind: 'not-started',
      why: error instanceof Error ? sanitize(error.message) : 'git merge could not be started',
    };
  }
  if (result.timedOut) return { kind: 'cut-off', why: 'git merge timed out' };
  if (result.code === null) return { kind: 'cut-off', why: 'git merge was ended by a signal' };
  return { kind: 'ended', result };
}

/** U5, in its order. */
async function apply(ctx: Context, git: Git, update: Update): Promise<number> {
  const { platform } = ctx;
  // Everything steps 3 and 4 need from the platform is taken now, before the merge.
  const times = windowTimes(platform.env);
  const launcher = join(git.root, 'bin', 'skydeck');
  const cwd = platform.cwd;
  const env = definedEnv(platform.env);

  // U2 10: an index lock would fail the merge after the server's stop (ruled by the plan owner).
  await refuseLockedIndex(ctx, git);
  // What a merge that failed is compared with, besides HEAD and the tracked files (S1).
  const untrackedBefore = await untrackedFiles(git);

  const hold = held(ctx);
  try {
    // 1. The server of this checkout is stopped; the database is closed again before step 2.
    const step1 = await stopForUpdate(ctx, times, hold);
    if (hold.interrupted()) {
      // A signal during the stop: no merge; the window back on the old code (ruled, S2).
      const back = await bringBack(ctx, hold, step1, launcher, cwd, env);
      hold.err(
        `interrupted before the update was applied; the checkout was not changed${unlessBack(back)}`,
      );
      return EXIT.failure;
    }

    // 2. The fast-forward to the commit the report named. From its start on a signal abandons
    // nothing: the merge ends, step 3 runs, the result line is printed — also when no server was
    // stopped, so the hold starts here at the latest (ruled, review 2's re-check R1).
    hold.start();
    const merged = await merge(git, update.newId);
    // From here on this process loads nothing from the checkout (U6).
    const notApplied = await failedMerge(git, update, merged, untrackedBefore);
    if (notApplied !== null) {
      if (!notApplied.asItWas) {
        hold.err(
          `the update could not be applied: ${notApplied.why}; the checkout may not be as it was: set it right as docs/install.md says ("Updating"), then run skydeck window`,
        );
        return EXIT.failure;
      }
      const back = await bringBack(ctx, hold, step1, launcher, cwd, env);
      hold.err(
        `the update could not be applied: ${notApplied.why}; the checkout is as it was${unlessBack(back)}`,
      );
      return EXIT.failure;
    }

    // 3. The window's server again, only when the stopped one had a page.
    const done = await bringBack(ctx, hold, step1, launcher, cwd, env);
    // 4. The result.
    const id = short(update.newId);
    if (done === 'ok') {
      hold.out(`updated to ${id}`);
      return EXIT.ok;
    }
    hold.err(`updated to ${id}${unlessBack(done)}`);
    return EXIT.failure;
  } finally {
    hold.release();
  }
}

/**
 * The tail of a line that follows a bring-back (step 3): nothing when it went well; else that the
 * new `skydeck window` did not, and to run it (ruled, review 2's re-check R2).
 */
function unlessBack(back: 'ok' | number | null): string {
  if (back === 'ok') return '';
  return back === null
    ? ', but skydeck window could not be started or was ended by a signal; run skydeck window'
    : `, but skydeck window ended with exit ${back}; run skydeck window`;
}

/**
 * Why the update was not applied, and whether the checkout is as it was; null when it was applied
 * (the merge ended with 0 and HEAD is the new commit). A merge that did not end by itself — the 60
 * s, a signal — is never "as it was", whatever HEAD and the status say: a cut-off checkout can hold
 * the new commit's files untracked and the index lock (ruled by the plan owner, review 2 S1). One
 * that ended with 0 but left HEAD elsewhere is not applied, and not as it was either (C1). One git
 * refused, or that did not start, is looked at: HEAD and the status.
 */
async function failedMerge(
  git: Git,
  update: Update,
  merged: Merged,
  untrackedBefore: string,
): Promise<{ why: string; asItWas: boolean } | null> {
  switch (merged.kind) {
    case 'cut-off':
      return { why: merged.why, asItWas: false };
    case 'not-started':
      return { why: merged.why, asItWas: await asItWas(git, update.oldId, untrackedBefore) };
    case 'ended': {
      const { result } = merged;
      if (result.code !== 0) {
        return {
          why: failureReason(result, MERGE_MS),
          asItWas: await asItWas(git, update.oldId, untrackedBefore),
        };
      }
      const head = await commitOf(git, 'HEAD').catch((): null => null);
      if (head === update.newId) return null;
      return {
        why: `git merge ended, but HEAD is not at ${short(update.newId)}`,
        asItWas: false,
      };
    }
  }
}

/** U2 10: `rev-parse --git-path index.lock`, resolved against the root, must not exist. */
async function refuseLockedIndex(ctx: Context, git: Git): Promise<void> {
  const path = resolve(
    git.root,
    (await git.output(['rev-parse', '--git-path', 'index.lock'])).replace(/\n$/, ''),
  );
  if (ctx.platform.files.lstat(path) !== null) {
    throw new SkydeckError(
      `this checkout's git index is locked (${sanitize(path)}): another git command runs in it, or one was cut off and left the file; nothing was changed`,
    );
  }
}

/**
 * U5 step 1 on the deck (opened here, and closed again when it returns): the window's server of
 * this checkout, when there is one, has its pages counted and is stopped; the hold of `hold` starts
 * right before stopServer is called. A server of another checkout is left as it is; a server that
 * does not answer is refused (U2 9). A database written by a newer skydeck is no error here — its
 * message asks for this command —: the server is not looked at, and the update goes on without
 * steps 1 and 3 (ruled by the plan owner). Any other error ends the command and says what was left
 * as it was: `nothing was changed` before stopServer was called, `the checkout was not changed`
 * once it was (a server asked to shut down, or signalled, that did not end).
 */
async function stopForUpdate(ctx: Context, times: WindowTimes, hold: Held): Promise<Stopped> {
  let stopping = false;
  try {
    return await withDeck(ctx, { refresh: false }, async (deck) => {
      const root = deck.platform.appRoot;
      const found = await findServer(deck, root, computeBuild(deck.platform.files, root), times);
      switch (found.kind) {
        case 'none':
          return { stopped: false, pages: 0 };
        case 'hung':
          throw new SkydeckError(hungServerLine(found, times));
        case 'other-checkout':
          hold.err(
            `the window's server runs from another checkout (${sanitize(found.ping.checkout)}); it is left as it is`,
          );
          return { stopped: false, pages: 0 };
        case 'ours':
        case 'other-build': {
          const pages = await pagesOf(deck);
          stopping = true;
          hold.start();
          const { stopped, keepers } = await stopServer(deck, times);
          if (stopped) hold.err(`stopped skydeck's window server; ${keepRunning(keepers)}`);
          return { stopped, pages };
        }
      }
    });
  } catch (error) {
    if (error instanceof DatabaseNewerError) {
      hold.err(
        "the database was written by a newer skydeck, so the window's server is not looked at; it is left as it is",
      );
      return { stopped: false, pages: 0 };
    }
    if (error instanceof SkydeckError) {
      const left = stopping ? 'the checkout was not changed' : 'nothing was changed';
      throw new SkydeckError(`${error.message}; ${left}`, error.exitCode);
    }
    throw error;
  }
}

/**
 * After a merge git refused: whether HEAD is still `oldId`, no tracked file changed and the
 * untracked files are those of before the merge; false when that cannot be told.
 */
async function asItWas(git: Git, oldId: string, untrackedBefore: string): Promise<boolean> {
  try {
    return (
      (await commitOf(git, 'HEAD')) === oldId &&
      (await changedFiles(git)).length === 0 &&
      (await untrackedFiles(git)) === untrackedBefore
    );
  } catch (error) {
    if (error instanceof SkydeckError) return false;
    throw error;
  }
}

/**
 * U5 step 3: when step 1 stopped a server that had a page, `<root>/bin/skydeck window` as a new
 * process with the command's own environment, working directory and terminal — its exit code
 * ('ok' for 0; null when it could not be started or a signal ended it). When the stopped server
 * had no page: nothing is started, and a line says so ('ok'). When none was stopped: 'ok'.
 */
async function bringBack(
  ctx: Context,
  hold: Held,
  step1: Stopped,
  launcher: string,
  cwd: string,
  env: Record<string, string>,
): Promise<'ok' | number | null> {
  if (!step1.stopped) return 'ok';
  if (step1.pages === 0) {
    hold.err("the window's server was stopped for the update; skydeck window starts it again");
    return 'ok';
  }
  const code = await ctx.platform.runner
    .runInteractive(launcher, ['window'], { cwd, env })
    .catch((): null => null);
  return code === 0 ? 'ok' : code;
}
