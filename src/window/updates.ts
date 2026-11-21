/**
 * F38 (issue #163; S2 16.5 "The window's check"): the server's check for a newer skydeck. One per
 * server; it keeps the state and decides everything, and the pages show what it sends (S2 4.3).
 *
 * - The checkout is the server's app root; in a marked test sandbox (`SKYDECK_TEST_NO_WINDOWS=1`)
 *   the one `SKYDECK_TEST_UPDATE_CHECKOUT` names, and without that variable no check or look ever
 *   runs git (S2 17: every root a test runs git on lies inside its sandbox).
 * - A check (network) is the look of src/update/look.ts with the quiet fetch, in the window's
 *   tolerant order; one at a time, a second request joins the first. A fetch that fails hides
 *   nothing: the outcome is what the look says without the network, so an update an earlier fetch
 *   brought stays shown, and the failure — its line and its time — is kept beside it until a check
 *   whose fetch works. A failure makes no notice of its own.
 * - When: at every tick (each second) with the switch on, when none runs and this server has made
 *   no check yet ("at start") or its last one ended CHECK_EVERY_NS ago or more by the wall clock (or
 *   the clock stepped back behind it); after a check whose fetch failed the wait is
 *   RETRY_AFTER_FAILURE_NS. With the switch off a server that finds a stored outcome looks once
 *   without the network, so that a stale notice does not survive an update made by hand.
 * - The dialog's look runs without the network and replaces the outcome, keeping the times of the
 *   last fetch and the last failure; while a check runs it starts nothing.
 * - A server sends no stored outcome before its own first check or look has ended.
 * - Nothing it does can end the server: every chain ends in a catch that logs the failure by its
 *   kind (failureKind), never a message; a record that cannot be written or read leaves the state in
 *   memory, still sent; once stop() was called nothing touches the store or the pages again.
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
/**
 * The wait after a check whose fetch failed. The same as CHECK_EVERY_NS for now: whether a
 * failure is tried again sooner is the owner's to decide, and a decision changes this one line.
 */
export const RETRY_AFTER_FAILURE_NS = CHECK_EVERY_NS;

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
  const checkout = checkoutOf(deck);
  const root = checkout === null ? null : checkoutRoot(platform.files, checkout);
  const git: Git | null = checkout === null ? null : gitOn(platform, checkout);
  const controller = new AbortController();

  /** The state in memory: what the last look said (null: none yet), and whether it is shown. */
  let record: CheckRecord | null = null;
  /** This server's own first check or look has ended: from then on the outcome is sent. */
  let shown = false;
  /** When this server's last check ended (wall clock), and whether its fetch failed. */
  let lastCheck: { atNs: Ns; failed: boolean } | null = null;
  /** The first tick has happened (the switch-off look is made at most once). */
  let started = false;
  let checking: Promise<UpdatePayload> | null = null;
  let looking: Promise<UpdatePayload> | null = null;
  let stopped = false;

  const payload = (): UpdatePayload => {
    const own = shown ? record : null;
    return {
      auto: deck.config.window.updateCheck === 'daily',
      checking: checking !== null,
      check: own === null ? null : checkPayload(own),
      fetchedAtNs: own?.fetchedAtNs ?? null,
      failure:
        own?.failure == null
          ? null
          : { atNs: own.failure.atNs, line: payloadText(own.failure.line) },
    };
  };

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
    shown = true;
    try {
      writeCheck(deck.store, next);
    } catch (error) {
      log(`update check: the outcome could not be stored (${failureKind(error)})`);
    }
    tell();
  };

  /** A record of `looked` at `nowNs`, the times of the last fetch and failure as `fetched` says. */
  const recordOf = (
    looked: Looked,
    nowNs: Ns,
    times: Pick<CheckRecord, 'fetchedAtNs' | 'failure'>,
  ): CheckRecord => ({
    v: 1,
    root: root ?? '',
    lookedAtNs: String(nowNs),
    ...times,
    head: looked.kind === 'cannot' ? looked.head : looked.update.oldId,
    outcome: outcomeOf(looked),
  });

  /** In a marked sandbox without the seam: the state says so; nothing is stored, git never runs. */
  const noCheckout = (): UpdatePayload => {
    if (!stopped) {
      record = {
        v: 1,
        root: '',
        lookedAtNs: String(platform.clock.nowNs()),
        fetchedAtNs: null,
        failure: null,
        head: null,
        outcome: { kind: 'cannot', line: NO_CHECKOUT_LINE },
      };
      shown = true;
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
    const nowNs = platform.clock.nowNs();
    const before = known();
    const fetchFailed = looked.kind === 'known' ? looked.fetchFailed : null;
    const times =
      looked.kind === 'known' && fetchFailed === null
        ? { fetchedAtNs: String(nowNs), failure: null }
        : {
            fetchedAtNs: before?.fetchedAtNs ?? null,
            failure:
              fetchFailed === null
                ? (before?.failure ?? null)
                : { atNs: String(nowNs), line: fetchFailed },
          };
    lastCheck = { atNs: nowNs, failed: fetchFailed !== null };
    keep(recordOf(looked, nowNs, times));
  };

  const check = (): Promise<UpdatePayload> => {
    if (stopped) return Promise.resolve(payload());
    if (git === null) return Promise.resolve(noCheckout());
    if (checking !== null) return checking;
    const running = runCheck(git)
      .catch((error: unknown) => {
        if (!stopped) log(`update check: failed (${failureKind(error)})`);
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
      keep(
        recordOf(looked, platform.clock.nowNs(), {
          fetchedAtNs: before?.fetchedAtNs ?? null,
          failure: before?.failure ?? null,
        }),
      );
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
