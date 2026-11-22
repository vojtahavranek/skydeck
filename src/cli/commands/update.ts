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
// `--from-window <commit>` (F38, S2 16.5 "Update now"; not in the usage text) is how the window's
// server applies an update: it starts this command detached, its output appended to the update's
// log. Three things change and nothing else: the look makes no fetch (nothing can wait at a
// prompt, the network is not used) and the upstream must be at <commit>, the one the window
// listed; and the outcome of the merge — never of the bring-back — is written to `kv
// window_update_run` before the window is brought back, for the server that follows (a refusal
// before the merge too, and a checkout already at <commit>). Nothing is recorded after it.
//
// Standard output carries the report and the result line; every other line goes to standard
// error with the `skydeck: ` prefix. Foreign text (a branch, a remote, a path, a commit's subject,
// git's message) is sanitised.
import { join, resolve } from 'node:path';

import { SkydeckError, UsageError } from '../../platform/errors.ts';
import type { RunResult } from '../../platform/types.ts';
import { DatabaseNewerError } from '../../store/store.ts';
import { sanitize } from '../../text/sanitize.ts';
import { computeBuild } from '../../window/build.ts';
import { findServer, stopServer } from '../../window/lifecycle.ts';
import {
  changedFiles,
  commitOf,
  definedEnv,
  failureReason,
  gitOn,
  MERGE_MS,
  untrackedFiles,
} from '../../update/git.ts';
import type { Git } from '../../update/git.ts';
import { lookForUpdate, report, short } from '../../update/look.ts';
import type { Update } from '../../update/look.ts';
import { checkoutRoot, COMMIT_ID, writeRun } from '../../update/record.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
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
  // F38: --from-window is the window's server's alone, so the usage text does not name it.
  flags: { check: { type: 'boolean' }, 'from-window': { type: 'string' } },
  min: 0,
  max: 0,
};

const IN_CLAUDE_CODE =
  "skydeck update is not run from inside a Claude Code session: it restarts the window's server, and every session in the window would inherit that session's environment; run it in a terminal of your own (skydeck update --check only looks)";

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
    const fromWindow = parsed.flags['from-window'];
    if (typeof fromWindow !== 'string') return update(ctx, check, null, NO_RECORD);
    if (check) {
      throw new UsageError(`--from-window cannot be used with --check\n${SPEC.usage}`);
    }
    if (!COMMIT_ID.test(fromWindow)) {
      throw new UsageError(`--from-window takes a full commit id\n${SPEC.usage}`);
    }
    // F38: a refusal or a failed stop (a SkydeckError before the merge) is recorded here, then
    // thrown on; what the merge ended with was recorded by apply (the first record is the one).
    const record = windowRecord(ctx, fromWindow);
    try {
      return await update(ctx, false, fromWindow, record);
    } catch (error) {
      if (error instanceof SkydeckError) await record({ state: 'failed', line: error.message });
      throw error;
    }
  },
};

/** The command after its arguments; `to`: --from-window's commit (null: typed in a terminal). */
async function update(
  ctx: Context,
  check: boolean,
  to: string | null,
  record: Recorder,
): Promise<number> {
  // U2 1: the server it restarts would give every session in the window this environment.
  if (!check && ctx.platform.env.CLAUDECODE !== undefined) {
    throw new SkydeckError(IN_CLAUDE_CODE);
  }
  const git = gitOn(ctx.platform, ctx.platform.appRoot);
  const say = (line: string): void => ctx.io.stdout(`${line}\n`);
  const found = await whatIsNew(ctx, git, to);
  if (found.newId === found.oldId) {
    say(
      `skydeck is up to date (${sanitize(found.branch)} at ${short(found.oldId)}, as ${sanitize(found.upstream)})`,
    );
    // F38: the window's server would otherwise say that the update ended without saying how.
    await record({
      state: 'failed',
      line: `nothing was applied: this checkout is already at ${short(found.oldId)}; run skydeck window in a terminal of your own to restart the window for it`,
    });
    return EXIT.ok;
  }
  for (const line of report(found)) say(line);
  if (check) {
    say('run skydeck update to apply it');
    return EXIT.ok;
  }
  return apply(ctx, git, found, record, to !== null);
}

/**
 * U2 2–8 in their order, then U4's facts: the look of src/update/look.ts in the command's order.
 * Every refusal is a SkydeckError; nothing is changed. With `to` (--from-window) there is no
 * fetch, and the upstream must be at `to`.
 */
async function whatIsNew(ctx: Context, git: Git, to: string | null): Promise<Update> {
  const looked = await lookForUpdate(git, ctx.platform.files, {
    fetch: to === null ? 'terminal' : 'none',
    tolerant: false,
  });
  if (looked.kind === 'cannot') throw new SkydeckError(looked.line);
  const found = looked.update;
  if (to !== null && found.newId !== to) {
    throw new SkydeckError(
      `${sanitize(found.upstream)} is at ${short(found.newId)}, not at ${short(to)}, the commit the window listed; check again in the window; nothing was changed`,
    );
  }
  return found;
}

/** How the merge ended, as `kv window_update_run` keeps it (F38). */
type Outcome = { state: 'applied' } | { state: 'failed'; line: string };

/**
 * Records the outcome for the window's next server (F38); the typed command's records nothing.
 * It never throws: a record that cannot be written is one line on stderr.
 */
type Recorder = (outcome: Outcome) => Promise<void>;

const NO_RECORD: Recorder = () => Promise.resolve();

/**
 * --from-window's record: once, through withDeck (the old server is stopped or was never
 * touched, and no code of the new commit has opened the database yet), the entry naming this
 * checkout's root, read now, before any merge. A second call does nothing.
 */
function windowRecord(ctx: Context, to: string): Recorder {
  const { platform } = ctx;
  const root = checkoutRoot(platform.files, platform.appRoot);
  let recorded = false;
  return async (outcome) => {
    if (recorded) return;
    recorded = true;
    try {
      await withDeck(ctx, { refresh: false }, (deck) => {
        const atNs = String(platform.clock.nowNs());
        writeRun(
          deck.store,
          outcome.state === 'applied'
            ? { v: 1, root, state: 'applied', to, atNs }
            : { v: 1, root, state: 'failed', to, line: outcome.line, atNs },
        );
        return Promise.resolve();
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      ctx.io.stderr(
        `skydeck: the window could not be told how the update ended (${sanitize(why)})\n`,
      );
    }
  };
}

/** What step 1 did: whether it stopped a server, and the pages that server had. */
interface Stopped {
  stopped: boolean;
  pages: number;
  /** When none was stopped: why (`--from-window` refuses then, F38). */
  why: string | null;
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

/**
 * U5, in its order. `record` gets the outcome of the merge once it is known, before the window is
 * brought back (F38; a no-op for the typed command). `fromWindow` (--from-window): a page asked
 * for the update, so step 1 must stop this checkout's server — else nothing is merged — and step
 * 3 brings the window back whatever the stopped server's page count said.
 */
async function apply(
  ctx: Context,
  git: Git,
  update: Update,
  record: Recorder,
  fromWindow: boolean,
): Promise<number> {
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
    if (fromWindow && !step1.stopped) {
      // F38: the server that asked runs on (or another checkout's does): a merge now would be
      // recorded as applied while the old code goes on serving the window.
      const line = `${step1.why ?? "the window's server was not stopped"}, so the update started from the window was not applied; nothing was changed`;
      await record({ state: 'failed', line });
      hold.err(line);
      return EXIT.failure;
    }
    if (hold.interrupted()) {
      // A signal during the stop: no merge; the window back on the old code (ruled, S2).
      const line = 'interrupted before the update was applied; the checkout was not changed';
      await record({ state: 'failed', line });
      const back = await bringBack(ctx, hold, step1, launcher, cwd, env, fromWindow);
      hold.err(`${line}${unlessBack(back)}`);
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
        const line = `the update could not be applied: ${notApplied.why}; the checkout may not be as it was: set it right as docs/install.md says ("Updating"), then run skydeck window`;
        await record({ state: 'failed', line });
        hold.err(line);
        return EXIT.failure;
      }
      const line = `the update could not be applied: ${notApplied.why}; the checkout is as it was`;
      await record({ state: 'failed', line });
      const back = await bringBack(ctx, hold, step1, launcher, cwd, env, fromWindow);
      hold.err(`${line}${unlessBack(back)}`);
      return EXIT.failure;
    }

    // 3. The window's server again, only when the stopped one had a page.
    await record({ state: 'applied' });
    const done = await bringBack(ctx, hold, step1, launcher, cwd, env, fromWindow);
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
          return { stopped: false, pages: 0, why: 'no window server of this checkout runs' };
        case 'hung':
          throw new SkydeckError(hungServerLine(found, times));
        case 'other-checkout':
          const other = `the window's server runs from another checkout (${sanitize(found.ping.checkout)})`;
          hold.err(`${other}; it is left as it is`);
          return { stopped: false, pages: 0, why: other };
        case 'ours':
        case 'other-build': {
          const pages = await pagesOf(deck);
          stopping = true;
          hold.start();
          const { stopped, keepers } = await stopServer(deck, times);
          if (stopped) hold.err(`stopped skydeck's window server; ${keepRunning(keepers)}`);
          return {
            stopped,
            pages,
            why: stopped ? null : "the window's server ended before it could be stopped",
          };
        }
      }
    });
  } catch (error) {
    if (error instanceof DatabaseNewerError) {
      hold.err(
        "the database was written by a newer skydeck, so the window's server is not looked at; it is left as it is",
      );
      return {
        stopped: false,
        pages: 0,
        why: "the database was written by a newer skydeck and the window's server was not looked at",
      };
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
 * U5 step 3: when step 1 stopped a server that had a page — or any server, with `always`
 * (--from-window: a page asked, whatever the count said) —, `<root>/bin/skydeck window` as a new
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
  always: boolean,
): Promise<'ok' | number | null> {
  if (!step1.stopped) return 'ok';
  if (step1.pages === 0 && !always) {
    hold.err("the window's server was stopped for the update; skydeck window starts it again");
    return 'ok';
  }
  const code = await ctx.platform.runner
    .runInteractive(launcher, ['window'], { cwd, env })
    .catch((): null => null);
  return code === 0 ? 'ok' : code;
}
