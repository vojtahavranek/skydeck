/**
 * F38 (issue #163; S2 16.5 "The window's check"): the server's check for a newer skydeck. One per
 * server; it keeps the state and decides everything, and the pages show what it sends (S2 4.3).
 *
 * - The checkout is the server's app root; in a marked test sandbox (`SKYDECK_TEST_NO_WINDOWS=1`)
 *   the one `SKYDECK_TEST_UPDATE_CHECKOUT` names, and without that variable no check or look ever
 *   runs git (S2 17: every root a test runs git on lies inside its sandbox).
 * - A check (network) is the look of src/update/look.ts with the quiet fetch, in the window's
 *   tolerant order; one at a time, a second request joins the first. A check fails when its fetch
 *   fails, when a git call of its look fails or times out (not a state of the checkout), or when
 *   it throws. A failed fetch hides nothing: the outcome is what the look says on the ref it has,
 *   so an update an earlier fetch brought stays shown. A failed git call, or a check that threw,
 *   shows no notice: the outcome is a `cannot` with its line (a notice always comes from a look
 *   that ran to its end). The failure — its line and its time — is kept until a check that ends
 *   without one. A failure makes no notice of its own.
 * - When: at every tick (each second) with the switch on, when none runs and this server has made
 *   no check yet ("at start") or its last one ended CHECK_EVERY_NS ago or more by the wall clock (or
 *   the clock stepped back behind it); after a check that failed the wait is
 *   RETRY_AFTER_FAILURE_NS, an hour. With the switch off a server that finds a stored outcome looks
 *   once without the network, so that a stale notice does not survive an update made by hand.
 * - The dialog's look runs without the network and replaces the outcome, keeping the times of the
 *   last fetch and the last failure; while a check runs it starts nothing.
 * - A server sends no stored outcome before its own first check or look has ended.
 * - Update now (milestone 2, S2 16.5 "Update now"): `apply(to)` is refused while the server
 *   stops, an update runs, a check runs or a restore runs, and unless a look made now says
 *   `available`, not blocked, with that `to`. Then `kv window_update_run` says `applying`, every
 *   page is told, a line goes to `<stateDir>/update.log`, and one detached process is started that
 *   outlives this server and IS the command: `<checkout>/bin/skydeck update --from-window <to>`,
 *   with the server's own environment, the directory that environment came from, both outputs
 *   appended to the log, and the user's soft core limit given back first (through python3). That
 *   process stops this server, applies, records the outcome and brings the window back; if it ends
 *   while this server still runs, what it recorded becomes `result`. A server that starts reads the
 *   entry of its checkout as `result` and removes it; `seen()` dismisses the result.
 * - Nothing it does can end the server: every chain ends in a catch that logs the failure by its
 *   kind (failureKind), never a message; a record that cannot be written or read leaves the state in
 *   memory, still sent; once stop() was called nothing touches the store or the pages again, a
 *   git call that runs gets SIGTERM (SIGKILL two seconds later) and no further one starts.
 */
import { join } from 'node:path';

import type { Ns } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { gitOn } from '../update/git.ts';
import type { Git } from '../update/git.ts';
import { counted, lookForUpdate, short, subjectLine } from '../update/look.ts';
import type { Looked } from '../update/look.ts';
import {
  checkoutRoot,
  checkPayload,
  clearRun,
  payloadText,
  readCheck,
  readRun,
  RUN_LINE_MAX,
  writeCheck,
  writeRun,
} from '../update/record.ts';
import type { CheckOutcome, CheckRecord, RunRecord } from '../update/record.ts';
import { clipLine } from '../update/git.ts';
import { sanitize } from '../text/sanitize.ts';
import { failureKind } from './auth.ts';
import { serverLog } from './log.ts';
import type { UpdatePayload } from './protocol.ts';

/** "Daily": a check this long after the last one this server made (S2 10.1). */
export const CHECK_EVERY_NS = 24n * 60n * 60n * 1_000_000_000n;
/** The wait after a check that failed (no network, say): an hour (the owner's decision). */
export const RETRY_AFTER_FAILURE_NS = 60n * 60n * 1_000_000_000n;

/** What a look without a checkout to look at says (a marked test sandbox without the seam). */
export const NO_CHECKOUT_LINE = 'no update is looked for in a test sandbox';

/** The python3 the launcher uses for its core limit (bin/skydeck), never one found on PATH. */
export const PYTHON3 = '/usr/bin/python3';

/**
 * The program that gives the user's soft core limit back before the update runs (S2 16.5): the
 * server's own soft limit is 1 byte, and the launcher would record that 1 as the user's for every
 * later session (bin/skydeck). argv: the soft limit (decimal bytes or `unlimited`), whether
 * LC_CTYPE was set (`1` or empty) and its value, then the command. The soft limit is set within
 * the hard one (clamped to it); one that cannot be set ends it with exit 1 and one line, nothing
 * run. python3 may set LC_CTYPE for itself (PEP 538) and ignores SIGPIPE and SIGXFSZ: the caller's
 * LC_CTYPE and the default dispositions are given back before the exec, as the launcher does.
 */
export const CORE_LIMIT_PROGRAM = `import os, resource, signal, sys
soft_text, ctype_set, ctype = sys.argv[1:4]
command = sys.argv[4:]
try:
    hard = resource.getrlimit(resource.RLIMIT_CORE)[1]
    soft = resource.RLIM_INFINITY if soft_text == "unlimited" else int(soft_text)
    if hard != resource.RLIM_INFINITY and (soft == resource.RLIM_INFINITY or soft > hard):
        soft = hard
    resource.setrlimit(resource.RLIMIT_CORE, (soft, hard))
except Exception as error:
    sys.stderr.write("skydeck: the soft core limit could not be set to %s (%s); the update was not run\\n" % (soft_text, error))
    sys.exit(1)
env = dict(os.environ)
if ctype_set == "1":
    env["LC_CTYPE"] = ctype
else:
    env.pop("LC_CTYPE", None)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
try:
    os.execve(command[0], command, env)
except Exception as error:
    sys.stderr.write("skydeck: cannot run %s (%s)\\n" % (command[0], error))
os._exit(127)
`;

/** Update now's refusals (S2 16.5), each with nothing started. */
export const APPLY_REFUSED = {
  stopping: "the window's server is stopping",
  running: 'an update is already running',
  checking: 'a check for updates is running; try again once it has ended',
  restoring: 'a restore is running; update once it has finished',
  notListed: "the window's last check does not name that commit; open the dialog again",
} as const;

export interface Updates {
  /** The state as every page is told it. */
  payload(): UpdatePayload;
  /** Called every second by the server's tick: starts a check when one is due; never throws. */
  tick(): void;
  /** Check now: a check whatever the switch says (one that runs is joined); its state at the end. */
  check(): Promise<UpdatePayload>;
  /** The dialog's look, without the network; while a check runs, the state as it is. */
  look(): Promise<UpdatePayload>;
  /**
   * Update now (milestone 2): starts the command that applies `to`, or says why not; the state
   * after it either way.
   */
  apply(
    to: string,
  ): Promise<
    { ok: true; update: UpdatePayload } | { ok: false; error: string; update: UpdatePayload }
  >;
  /** A page dismissed the result: it goes from every page. */
  seen(): UpdatePayload;
  /** The server's stop: aborts a running fetch (SIGTERM first), saves nothing of it. */
  stop(): Promise<void>;
}

export interface UpdatesDeps {
  deck: Deck;
  /** Called with the new state on every change: every page is told. */
  changed(payload: UpdatePayload): void;
  log(line: string): void;
  /** The fetch's wait (default FETCH_MS). */
  fetchMs?: number;
  /** The server's environment as its programs get it (serverEnvironment's `env`): the updater's. */
  serverEnv: Readonly<Record<string, string>>;
  /** The user's soft core limit the launcher recorded; null: none (the launcher is started directly). */
  coreSoft: string | null;
  /** The directory the server's environment came from (envOrigin.dir): the updater's working directory. */
  originDir(): string;
  /** Whether a restore runs. */
  restoreRunning(): boolean;
  /** Whether the server's stop has begun. */
  stopping(): boolean;
}

/** The checkout the checker looks at, or null in a marked test sandbox without the seam. */
function checkoutOf(deck: Deck): string | null {
  const { env, appRoot } = deck.platform;
  if (env.SKYDECK_TEST_NO_WINDOWS === '1') {
    const seam = env.SKYDECK_TEST_UPDATE_CHECKOUT;
    return seam === undefined || seam === '' ? null : seam;
  }
  return appRoot;
}

/** The python3 that gives the core limit back: the launcher's, SKYDECK_TEST_PYTHON3 in a marked sandbox. */
function python3Of(deck: Deck): string {
  const { env } = deck.platform;
  return env.SKYDECK_TEST_NO_WINDOWS === '1' && env.SKYDECK_TEST_PYTHON3 !== undefined
    ? env.SKYDECK_TEST_PYTHON3
    : PYTHON3;
}

/** An ns time as the page reads it in a sentence: ISO, to the second, UTC. */
function isoOf(atNs: string): string {
  return new Date(Number(BigInt(atNs) / 1_000_000n)).toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
}

/** The outcome a look gives, as it is stored. */
function outcomeOf(looked: Looked): CheckOutcome {
  if (looked.kind === 'cannot') return { kind: 'cannot', line: looked.line };
  const { update, blocked } = looked;
  if (update.count > 0) {
    return {
      kind: 'available',
      upstream: sanitize(update.upstream),
      count: update.count,
      from: update.oldId,
      to: update.newId,
      notes: update.notes,
      moreNotes: update.moreNotes,
      others: update.others.map((commit) => subjectLine(commit.subject)),
      otherCount: update.otherCount,
      upgradesDatabase: update.upgradesDatabase,
      blocked,
    };
  }
  const upstream = sanitize(update.upstream);
  return {
    kind: 'current',
    line:
      update.ahead > 0
        ? `nothing new on ${upstream}: this checkout has ${counted(update.ahead, 'commit', 'commits')} that it does not have`
        : `skydeck is up to date (${sanitize(update.branch)} at ${update.oldId.slice(0, 7)}, as ${upstream})`,
  };
}

export function createUpdates(deps: UpdatesDeps): Updates {
  const { deck, log } = deps;
  const { platform } = deck;
  const controller = new AbortController();
  const checkout = checkoutOf(deck);
  const root = checkout === null ? null : checkoutRoot(platform.files, checkout);
  // Every git call gets the stop's signal: once it fired none starts, and one that runs ends.
  const git: Git | null =
    checkout === null ? null : gitOn(platform, checkout, { signal: controller.signal });

  /**
   * The state in memory: what this server's own last check or look said; null until the first
   * has ended (a stored outcome is never sent before it).
   */
  let record: CheckRecord | null = null;
  /** When this server's last check ended (wall clock), and whether it failed. */
  let lastCheck: { atNs: Ns; failed: boolean } | null = null;
  /** The first tick has happened (the switch-off look is made at most once). */
  let started = false;
  let checking: Promise<UpdatePayload> | null = null;
  let looking: Promise<UpdatePayload> | null = null;
  let stopped = false;
  const logPath = join(deck.places.stateDir, 'update.log');
  /** The log's path as the pages get it. */
  const shownLog = sanitize(logPath);
  /** An update started from this server: since when, to which commit; null: none runs. */
  let applying: { to: string; sinceNs: string } | null = null;
  /** apply() has passed its refusals and not yet started the process or failed. */
  let starting = false;
  /** How many of the dialog's looks ran to their end: Update now's look must be one of them. */
  let lookEnds = 0;
  /** How the last update from the window ended, until a page dismisses it. */
  let result: { ok: boolean; text: string } | null = null;

  const payload = (): UpdatePayload => ({
    checking: checking !== null,
    check: record === null ? null : checkPayload(record),
    checkedAtNs: record?.checkedAtNs ?? null,
    fetchedAtNs: record?.fetchedAtNs ?? null,
    failure:
      record?.failure == null
        ? null
        : { atNs: record.failure.atNs, line: payloadText(record.failure.line) },
    applying,
    log: shownLog,
    result,
  });

  /** What a run entry of this checkout says as the result. */
  const resultOf = (entry: RunRecord): { ok: boolean; text: string } => {
    switch (entry.state) {
      case 'applied':
        return { ok: true, text: `updated to ${short(entry.to)}` };
      case 'failed':
        return { ok: false, text: clipLine(sanitize(entry.line), RUN_LINE_MAX) };
      case 'applying':
        return {
          ok: false,
          text: `an update started from the window at ${isoOf(entry.atNs)} did not record how it ended; its log says: ${shownLog}`,
        };
    }
  };

  // A server that starts: the entry of its checkout becomes the result, and is removed; another
  // checkout's entry is left as it is.
  // The result is shown only once its entry is removed: one whose removal fails stays for the next
  // start, which shows it then, so that no result is shown twice.
  if (root !== null) {
    let entry: RunRecord | null = null;
    try {
      entry = readRun(deck.store, root);
    } catch (error) {
      log(`update: the entry of the last update could not be read (${failureKind(error)})`);
    }
    if (entry !== null) {
      try {
        clearRun(deck.store);
        result = resultOf(entry);
      } catch (error) {
        log(`update: the entry of the last update could not be removed (${failureKind(error)})`);
      }
    }
  }

  const tell = (): void => {
    if (stopped) return;
    try {
      deps.changed(payload());
    } catch (error) {
      log(`update check: the pages could not be told (${failureKind(error)})`);
    }
  };

  /** The record this server knows: its own, else the stored one of this checkout; null on a failure. */
  const known = (): CheckRecord | null => {
    if (record !== null || root === null) return record;
    try {
      return readCheck(deck.store, root);
    } catch (error) {
      log(`update check: the stored outcome could not be read (${failureKind(error)})`);
      return null;
    }
  };

  /** Keeps `next` as the state, stores it and tells every page (nothing once stopped). */
  const keep = (next: CheckRecord): void => {
    if (stopped) return;
    record = next;
    try {
      writeCheck(deck.store, next);
    } catch (error) {
      log(`update check: the outcome could not be stored (${failureKind(error)})`);
    }
    tell();
  };

  /**
   * A check ended at `nowNs`: with its look, or with the line of what it threw. The outcome is
   * this check's alone — a notice always comes from a look that ran to its end: one that threw,
   * or whose git call failed, is a `cannot` with its line. It failed when its fetch failed, when a
   * git call of its look failed (`cannot` with `failed`) or when it threw: the failure is kept
   * and the next check comes after the hour. What was stored before gives only the time of the
   * last fetch that worked.
   */
  const endCheck = (nowNs: Ns, ended: Looked | { thrown: string }): void => {
    const before = known();
    const at = String(nowNs);
    const thrown = 'thrown' in ended;
    const failureLine = thrown
      ? ended.thrown
      : ended.kind === 'known'
        ? ended.fetchFailed
        : (ended.fetchFailed ?? (ended.failed ? ended.line : null));
    const fetchWorked = !thrown && ended.kind === 'known' && ended.fetchFailed === null;
    lastCheck = { atNs: nowNs, failed: failureLine !== null };
    keep({
      v: 2,
      root: root ?? '',
      lookedAtNs: at,
      head: thrown ? null : ended.kind === 'cannot' ? ended.head : ended.update.oldId,
      outcome: thrown ? { kind: 'cannot', line: ended.thrown } : outcomeOf(ended),
      checkedAtNs: at,
      fetchedAtNs: fetchWorked ? at : (before?.fetchedAtNs ?? null),
      failure: failureLine === null ? null : { atNs: at, line: failureLine },
    });
  };

  /** In a marked sandbox without the seam: the state says so; nothing is stored, git never runs. */
  const noCheckout = (): UpdatePayload => {
    if (!stopped) {
      record = {
        v: 2,
        root: '',
        lookedAtNs: String(platform.clock.nowNs()),
        checkedAtNs: null,
        fetchedAtNs: null,
        failure: null,
        head: null,
        outcome: { kind: 'cannot', line: NO_CHECKOUT_LINE },
      };
      tell();
    }
    return payload();
  };

  const runCheck = async (g: Git): Promise<void> => {
    if (looking !== null) await looking;
    const looked = await lookForUpdate(g, platform.files, {
      fetch: {
        quiet: {
          signal: controller.signal,
          ...(deps.fetchMs === undefined ? {} : { timeoutMs: deps.fetchMs }),
        },
      },
      tolerant: true,
    });
    if (stopped) return;
    endCheck(platform.clock.nowNs(), looked);
  };

  const check = (): Promise<UpdatePayload> => {
    // While an update from the window runs, or is being started, no check starts (Check now from a
    // page that has not been told yet): the state as it is.
    if (stopped || applying !== null || starting) return Promise.resolve(payload());
    if (git === null) return Promise.resolve(noCheckout());
    if (checking !== null) return checking;
    const running = runCheck(git)
      .catch((error: unknown) => {
        if (stopped) return; // the stop's abort: nothing of it is kept
        const kind = failureKind(error);
        log(`update check: failed (${kind})`);
        // A check that threw (a git that could not be started, say) is a failed check: it is
        // said, and tried again after the hour, not at the next tick.
        try {
          endCheck(platform.clock.nowNs(), {
            thrown: `skydeck could not check for an update (${kind})`,
          });
        } catch (again) {
          log(`update check: its failure could not be kept (${failureKind(again)})`);
        }
      })
      .then(() => {
        checking = null;
        tell();
        return payload();
      });
    checking = running;
    tell();
    return running;
  };

  const look = (): Promise<UpdatePayload> => {
    if (stopped || checking !== null) return Promise.resolve(payload());
    if (git === null) return Promise.resolve(noCheckout());
    if (looking !== null) return looking;
    const g = git;
    const running = (async (): Promise<UpdatePayload> => {
      const looked = await lookForUpdate(g, platform.files, { fetch: 'none', tolerant: true });
      if (stopped) return payload();
      const before = known();
      keep({
        v: 2,
        root: root ?? '',
        lookedAtNs: String(platform.clock.nowNs()),
        checkedAtNs: before?.checkedAtNs ?? null,
        fetchedAtNs: before?.fetchedAtNs ?? null,
        failure: before?.failure ?? null,
        head: looked.kind === 'cannot' ? looked.head : looked.update.oldId,
        outcome: outcomeOf(looked),
      });
      lookEnds += 1;
      return payload();
    })()
      .catch((error: unknown) => {
        if (!stopped) log(`update check: the look failed (${failureKind(error)})`);
        return payload();
      })
      .finally(() => {
        looking = null;
      });
    looking = running;
    return running;
  };

  /** The updater ended while this server still runs: what it recorded is the result. */
  const updaterEnded = (code: number | null, signal: string | null): void => {
    if (stopped || deps.stopping()) return;
    const how = code !== null ? `exit ${code}` : `signal ${signal ?? 'unknown'}`;
    const untold = `the update ended without saying how (${how}); see ${shownLog}`;
    let entry: RunRecord | null = null;
    try {
      entry = root === null ? null : readRun(deck.store, root);
    } catch (error) {
      log(`update: the entry of the update could not be read (${failureKind(error)})`);
    }
    if (entry === null || entry.state === 'applying') {
      result = { ok: false, text: untold };
    } else {
      result = resultOf(entry);
    }
    if (entry !== null) {
      try {
        clearRun(deck.store);
      } catch (error) {
        log(`update: the entry of the update could not be removed (${failureKind(error)})`);
      }
    }
    applying = null;
    log(`update: the updater ended (${how})`);
    tell();
    void look();
  };

  /** The command line that applies `to`: the launcher, through python3 when a core limit is to be given back. */
  const commandLine = (launcher: string, to: string): { command: string; args: string[] } => {
    const args = [launcher, 'update', '--from-window', to];
    if (deps.coreSoft === null) return { command: launcher, args: args.slice(1) };
    const ctype = deps.serverEnv.LC_CTYPE;
    return {
      command: python3Of(deck),
      args: [
        '-I',
        '-S',
        '-c',
        CORE_LIMIT_PROGRAM,
        deps.coreSoft,
        ctype === undefined ? '' : '1',
        ctype ?? '',
        ...args,
      ],
    };
  };

  /** The updater's working directory: where the environment came from, else `/`. */
  const workingDir = (): string => {
    try {
      const dir = deps.originDir();
      return platform.files.stat(dir)?.kind === 'dir' ? dir : '/';
    } catch {
      return '/';
    }
  };

  const apply = async (
    to: string,
  ): Promise<
    { ok: true; update: UpdatePayload } | { ok: false; error: string; update: UpdatePayload }
  > => {
    const refused = (error: string): { ok: false; error: string; update: UpdatePayload } => ({
      ok: false,
      error,
      update: payload(),
    });
    if (stopped || deps.stopping()) return refused(APPLY_REFUSED.stopping);
    if (applying !== null || starting) return refused(APPLY_REFUSED.running);
    if (checking !== null) return refused(APPLY_REFUSED.checking);
    if (deps.restoreRunning()) return refused(APPLY_REFUSED.restoring);
    starting = true;
    try {
      // A look made now, run to its end, must name `to`, not blocked (it replaces the outcome,
      // every page told). No check can begin meanwhile: check() and the tick wait for `starting`.
      if (looking !== null) await looking;
      const ends = lookEnds;
      await look();
      if (stopped || deps.stopping()) return refused(APPLY_REFUSED.stopping);
      const check = record === null || lookEnds === ends ? null : checkPayload(record);
      if (check?.state === 'available' && check.to === to && check.blocked !== null) {
        return refused(`${check.blocked}; open the dialog again once that is set right`);
      }
      if (check?.state !== 'available' || check.to !== to || checkout === null || root === null) {
        return refused(APPLY_REFUSED.notListed);
      }
      const sinceNs = String(platform.clock.nowNs());
      try {
        writeRun(deck.store, { v: 1, root, state: 'applying', to, atNs: sinceNs });
        applying = { to, sinceNs };
        tell();
        serverLog(platform, logPath, false)(`update to ${short(to)} started from the window`);
        const { command, args } = commandLine(join(checkout, 'bin', 'skydeck'), to);
        const started = await platform.processes.startDetached(command, args, {
          cwd: workingDir(),
          env: deps.serverEnv,
          stdoutTo: logPath,
          stderrTo: logPath,
        });
        log(`update: the updater was started (pid ${started.pid})`);
        void started.exited
          .then(({ code, signal }) => {
            updaterEnded(code, signal);
          })
          .catch((error: unknown) => {
            log(`update: the updater's end could not be handled (${failureKind(error)})`);
          });
        return { ok: true, update: payload() };
      } catch (error) {
        const kind = failureKind(error);
        log(`update: the updater could not be started (${kind})`);
        try {
          clearRun(deck.store);
        } catch (again) {
          log(`update: the entry of the update could not be removed (${failureKind(again)})`);
        }
        applying = null;
        tell();
        return refused(
          `the update could not be started (${kind}); run skydeck update in a terminal of your own`,
        );
      }
    } finally {
      starting = false;
    }
  };

  /** Whether a check is due at `nowNs` (the switch is on). */
  const due = (nowNs: Ns): boolean => {
    if (lastCheck === null) return true;
    if (nowNs < lastCheck.atNs) return true; // the clock stepped back behind it
    const wait = lastCheck.failed ? RETRY_AFTER_FAILURE_NS : CHECK_EVERY_NS;
    return nowNs - lastCheck.atNs >= wait;
  };

  return {
    payload,
    tick() {
      try {
        if (stopped || git === null) return;
        const first = !started;
        started = true;
        if (deck.config.window.updateCheck === 'daily') {
          // check() itself starts nothing while an update runs or is being started.
          if (checking === null && due(platform.clock.nowNs())) void check();
        } else if (first && known() !== null) {
          void look();
        }
      } catch (error) {
        log(`update check: the tick failed (${failureKind(error)})`);
      }
    },
    check,
    look,
    apply,
    seen() {
      result = null;
      tell();
      return payload();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      await Promise.allSettled([checking, looking]);
    },
  };
}
