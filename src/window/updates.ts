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
 * - Nothing it does can end the server: every chain ends in a catch that logs the failure by its
 *   kind (failureKind), never a message; a record that cannot be written or read leaves the state in
 *   memory, still sent; once stop() was called nothing touches the store or the pages again, a
 *   git call that runs gets SIGTERM (SIGKILL two seconds later) and no further one starts.
 */
import type { Ns } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { gitOn } from '../update/git.ts';
import type { Git } from '../update/git.ts';
import { counted, lookForUpdate, report } from '../update/look.ts';
import type { Looked } from '../update/look.ts';
import {
  checkoutRoot,
  checkPayload,
  payloadText,
  readCheck,
  writeCheck,
} from '../update/record.ts';
import type { CheckOutcome, CheckRecord } from '../update/record.ts';
import { sanitize } from '../text/sanitize.ts';
import { failureKind } from './auth.ts';
import type { UpdatePayload } from './protocol.ts';

/** "Daily": a check this long after the last one this server made (S2 10.1). */
export const CHECK_EVERY_NS = 24n * 60n * 60n * 1_000_000_000n;
/** The wait after a check that failed (no network, say): an hour (the owner's decision). */
export const RETRY_AFTER_FAILURE_NS = 60n * 60n * 1_000_000_000n;

/** What a look without a checkout to look at says (a marked test sandbox without the seam). */
export const NO_CHECKOUT_LINE = 'no update is looked for in a test sandbox';

export interface Updates {
  /** The state as every page is told it. */
  payload(): UpdatePayload;
  /** Called every second by the server's tick: starts a check when one is due; never throws. */
  tick(): void;
  /** Check now: a check whatever the switch says (one that runs is joined); its state at the end. */
  check(): Promise<UpdatePayload>;
  /** The dialog's look, without the network; while a check runs, the state as it is. */
  look(): Promise<UpdatePayload>;
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

/** The outcome a look gives, as it is stored. */
function outcomeOf(looked: Looked): CheckOutcome {
  if (looked.kind === 'cannot') return { kind: 'cannot', line: looked.line };
  const { update, blocked } = looked;
  if (update.count > 0) {
    return {
      kind: 'available',
      upstream: sanitize(update.upstream),
      count: update.count,
      to: update.newId,
      lines: report(update),
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

  const payload = (): UpdatePayload => ({
    checking: checking !== null,
    check: record === null ? null : checkPayload(record),
    checkedAtNs: record?.checkedAtNs ?? null,
    fetchedAtNs: record?.fetchedAtNs ?? null,
    failure:
      record?.failure == null
        ? null
        : { atNs: record.failure.atNs, line: payloadText(record.failure.line) },
  });

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
      v: 1,
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
        v: 1,
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
    if (stopped) return Promise.resolve(payload());
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
        v: 1,
        root: root ?? '',
        lookedAtNs: String(platform.clock.nowNs()),
        checkedAtNs: before?.checkedAtNs ?? null,
        fetchedAtNs: before?.fetchedAtNs ?? null,
        failure: before?.failure ?? null,
        head: looked.kind === 'cannot' ? looked.head : looked.update.oldId,
        outcome: outcomeOf(looked),
      });
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
    async stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      await Promise.allSettled([checking, looking]);
    },
  };
}
