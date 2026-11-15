// The window a command opens (S2 5.1 step 2), moved out of src/cli/commands/window.ts so that
// `resume`, `new` and `restore` with the window (plan C12) open it as `skydeck window` does: the
// waits of A31 (`windowTimes`), plan C20's wait for the window the server expects back, the
// `window_launching` lock, a launch token, Edge, the wait for the token's use, the token given up
// (`launchWindow`).
import { procStartFromStat } from '../claude/procstat.ts';
import { SkydeckError } from '../platform/errors.ts';
import { MAX_TIMER_MS, NS_PER_MS } from '../platform/time.ts';
import type { Env, Platform } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { sanitize } from '../text/sanitize.ts';
import type { ControlClient } from '../window/client.ts';
import { startEdge } from '../window/edge.ts';
import type { LifecycleTimes } from '../window/lifecycle.ts';
import { pidLineState } from '../window/pidline.ts';
import type { PingAnswer } from '../window/protocol.ts';

/** S2 8.2.2: what the page says on 4004, and so does a command still waiting for that token. */
const ALARM =
  "this window's launch address was used by another program, which may now have skydeck's key; run skydeck window --new-secret";

/** How often a wait looks again: at the token, at the pages, at the lock. */
export const POLL_MS = 100;
/** lifecycle.ts's start wait when SKYDECK_TEST_WINDOW_TIMES gives none (S2 5.2: 10 seconds). */
export const START_MS = 10_000;

/**
 * The waits of S2 5.1 (A31), the design's values by default: a page has `pageMs` (30 s) to use
 * the launch token, a used token is watched `reuseMs` (2 s) more for a second use, a
 * `window_launching` older than `launchingMs` (45 s, longer than the wait it guards) holds
 * nothing, and after a restart the pages the old server had get `reconnectMs` (7 s: the page's
 * longest retry interval is 5 s, S2 6.3; ruled, task 25) to come back. The wait for a window the
 * server expects back (plan C20) ends at the server's word, and at the latest after `startMs` and
 * `reconnectMs` of its own. A command that sends a request to start sessions (`resume` and `new`
 * with the window, S2 11.4) waits `answerMs` (30 s, plan C17) for the answer, and a restore's
 * answer ends after `answerMs` without a line. The lifecycle's own times (ping, start, stop, kill)
 * are passed on as they are.
 */
export interface WindowTimes extends LifecycleTimes {
  pageMs: number;
  reuseMs: number;
  launchingMs: number;
  reconnectMs: number;
  answerMs: number;
}

const DEFAULT_WAITS = {
  pageMs: 30_000,
  reuseMs: 2000,
  launchingMs: 45_000,
  reconnectMs: 7000,
  answerMs: 30_000,
};
const TIME_NAMES: readonly string[] = [
  'pingMs',
  'startMs',
  'stopMs',
  'killMs',
  'pageMs',
  'reuseMs',
  'launchingMs',
  'reconnectMs',
  'answerMs',
];

/**
 * A31: SKYDECK_TEST_WINDOW_TIMES (`name=ms` pairs separated by commas, the names of
 * WindowTimes) over the defaults — honoured only in a test sandbox, marked by
 * SKYDECK_TEST_NO_WINDOWS=1, where a value that is not such pairs is an error; anywhere else the
 * variable is ignored.
 */
export function windowTimes(env: Env): WindowTimes {
  const times: WindowTimes = { ...DEFAULT_WAITS };
  const text = env.SKYDECK_TEST_WINDOW_TIMES;
  if (env.SKYDECK_TEST_NO_WINDOWS !== '1' || text === undefined) return times;
  for (const pair of text.split(',')) {
    const match = /^([A-Za-z]+)=(0|[1-9][0-9]{0,9})$/.exec(pair);
    const name = match?.[1] ?? '';
    const ms = Number(match?.[2]);
    if (match === null || !TIME_NAMES.includes(name) || ms > MAX_TIMER_MS) {
      throw new SkydeckError(
        `SKYDECK_TEST_WINDOW_TIMES is not name=ms pairs of ${TIME_NAMES.join(', ')}: ${sanitize(text)}`,
      );
    }
    (times as unknown as Record<string, number>)[name] = ms;
  }
  return times;
}

/** The current boot id; null when it cannot be read. */
function bootIdOf(platform: Platform): string | null {
  try {
    return platform.proc.bootId();
  } catch {
    return null;
  }
}

/** Plan C20's line, said once when a command waits for the window the server expects back; the
 *  `say` it is given adds the `skydeck: ` of the command's other diagnostic lines. */
const WAITING_LINE =
  'waiting up to 7 s for the open window to come back; --new-window opens one now';

/**
 * Plan C20: whether the window the server expects back came back — a page connected. The wait is
 * the server's fact: while its GET /status says that it expects a window (`windowExpectedMs` set
 * while its start is not done, above 0 after it) and no page is connected, `say`s WAITING_LINE
 * once and looks again every POLL_MS; it goes on (false) once the server expects none any more,
 * and at the latest after `startMs` and `reconnectMs` of its own, whatever the server says (a mark
 * that is stale never leaves the user without a window). A server that sends no
 * `windowExpectedMs` (one of an older build) expects none.
 */
async function windowComesBack(
  platform: Platform,
  client: ControlClient,
  times: WindowTimes,
  say: (line: string) => void,
): Promise<boolean> {
  const bound = deadline(
    platform,
    Math.min((times.startMs ?? START_MS) + times.reconnectMs, MAX_TIMER_MS),
  );
  let said = false;
  try {
    for (;;) {
      const status = await client.status();
      if (status.pages > 0) return true;
      const expected = status.windowExpectedMs ?? null;
      if (expected === null || (status.starting !== true && expected <= 0) || bound.over()) {
        return false;
      }
      if (!said) {
        say(WAITING_LINE);
        said = true;
      }
      await platform.clock.sleep(POLL_MS);
    }
  } finally {
    bound.cancel();
  }
}

/**
 * S2 5.1 step 2: unless `newWindow`, or when no old window can come back (`oldMayReturn` false:
 * `--new-secret`), first plan C20's wait for the window the server expects back ('came-back' when
 * it came: no window opened); then, holding `window_launching`, a launch token for 30 s, Edge
 * started with it, and the wait for a page to use it; the token is given up when the wait ends,
 * whatever its end. While another command holds the lock, this one waits for that one's page (and
 * is done when it comes, unless `newWindow`), or for the lock to be given up or to go stale, and
 * then launches itself. Throws a SkydeckError with S2 5.1's line when no page used the token, when
 * it was used twice (the alarm), and when Edge could not be started (S2 5.3; the server keeps
 * running).
 */
export async function launchWindow(
  deck: Deck,
  client: ControlClient,
  ping: PingAnswer,
  newWindow: boolean,
  oldMayReturn: boolean,
  times: WindowTimes,
  say: (line: string) => void,
): Promise<'opened' | 'came-back'> {
  const { platform } = deck;
  if (!newWindow && oldMayReturn && (await windowComesBack(platform, client, times, say))) {
    return 'came-back';
  }
  const lock = launchingLock(deck, times.launchingMs);
  while (!lock.take()) {
    if (!newWindow && (await client.status()).pages > 0) return 'opened';
    await platform.clock.sleep(POLL_MS);
  }
  try {
    const token = await client.token(30);
    try {
      const edge = await startEdge(
        platform,
        deck.config.window,
        deck.places.configPath,
        ping.port,
        token.token,
        null, // the command's own WSL_INTEROP: it runs in the user's terminal
      );
      if (!edge.ok) {
        throw new SkydeckError(sanitize(edge.line));
      }
      const outcome = await waitForUse(platform, client, token.id, times);
      if (outcome === 'reused') {
        throw new SkydeckError(ALARM);
      }
      if (outcome === 'not-used') {
        throw new SkydeckError(
          `Edge was started, but no window connected within ${seconds(times.pageMs)}; open the window in any browser with skydeck window --print-url`,
        );
      }
      if (outcome === 'forgotten') {
        throw new SkydeckError(
          "the window's server stopped or restarted before a window used its launch address; run skydeck window again",
        );
      }
    } finally {
      // So that no unused token is left on Edge's command line (S2 5.1). A server that is gone or
      // restarted has forgotten it already.
      await client.dropToken(token.id).catch((error: unknown) => {
        if (!(error instanceof SkydeckError)) throw error;
      });
    }
  } finally {
    lock.release();
  }
  return 'opened';
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return s === 1 ? '1 second' : `${s} seconds`;
}

/**
 * S2 5.1, 8.2.2: `used` once a page used the token and no second use came in the `reuseMs` that
 * follow; `reused` when one did (the alarm); `not-used` when no page used it within `pageMs` (or
 * it expired, or was given up); `forgotten` when the server no longer answers for it before its
 * use (a restarted server knows no tokens). After the use a state that cannot be read ends the
 * wait as a use: a server that forgot the token can no longer be reached with it.
 */
async function waitForUse(
  platform: Platform,
  client: ControlClient,
  id: string,
  times: WindowTimes,
): Promise<'used' | 'reused' | 'not-used' | 'forgotten'> {
  const { clock } = platform;
  const stateOf = (): Promise<string | null> =>
    client.tokenState(id).catch((error: unknown) => {
      if (error instanceof SkydeckError) return null;
      throw error;
    });
  const pageWait = deadline(platform, times.pageMs);
  try {
    for (;;) {
      const state = await stateOf();
      if (state === null) return 'forgotten';
      if (state === 'reused') return 'reused';
      if (state === 'used') break;
      if (state !== 'waiting' || pageWait.over()) return 'not-used';
      await clock.sleep(POLL_MS);
    }
  } finally {
    pageWait.cancel();
  }
  const reuseWait = deadline(platform, times.reuseMs);
  try {
    for (;;) {
      if (reuseWait.over()) return 'used';
      await clock.sleep(POLL_MS);
      const state = await stateOf();
      if (state === 'reused') return 'reused';
      if (state === null) return 'used';
    }
  } finally {
    reuseWait.cancel();
  }
}

/** A deadline `ms` from now on the platform's clock (a timer: WSL's wall clock steps back). */
export interface Wait {
  over(): boolean;
  cancel(): void;
}

export function deadline(platform: Platform, ms: number): Wait {
  let late = false;
  const cancel = platform.clock.after(ms, () => {
    late = true;
  });
  return { over: () => late, cancel };
}

// ---------------------------------------------------------------------------------------------
// window_launching

/**
 * `kv` `window_launching` (S2 5.1): `<16 hex> <taken ns> <pid> <process start> <boot id>` — a
 * random mark of the holding command (two commands of one process are told apart), the wall-clock
 * time it was taken and the holder's identity as design 5.5 judges it (left out when it cannot be
 * read). It holds nothing when it does not parse, is `launchingMs` old (or as far ahead: the clock
 * cannot be believed then), or names a holder that is dead by design 5.5's rule — a command that
 * was interrupted leaves it behind. Taken in one transaction; given up only by its holder.
 */
const LAUNCHING = /^[0-9a-f]{16} (0|[1-9][0-9]*)(?: ([1-9][0-9]*) (0|[1-9][0-9]*) (\S+))?$/;

function launchingLock(deck: Deck, staleMs: number): { take(): boolean; release(): void } {
  const { platform, store } = deck;
  const mark = Buffer.from(platform.randomBytes(8)).toString('hex');
  const identity = identityOf(platform);
  let mine: string | null = null;
  return {
    take() {
      return store.transaction(() => {
        const held = store.getKv('window_launching');
        if (held !== null && holds(platform, held, staleMs)) return false;
        mine = `${mark} ${platform.clock.nowNs()}${identity}`;
        store.setKv('window_launching', mine);
        return true;
      });
    },
    release() {
      const value = mine;
      if (value === null) return;
      try {
        store.transaction(() => {
          if (store.getKv('window_launching') === value) store.deleteKv('window_launching');
        });
      } catch {
        // Left behind, it holds nothing once this process has ended (design 5.5) or is stale;
        // an error from here would hide the one that ended the command.
      }
    },
  };
}

/** ` <pid> <process start> <boot id>` of this process; '' when it cannot be read. */
function identityOf(platform: Platform): string {
  try {
    const stat = platform.proc.stat(platform.pid);
    const procStart = stat === null ? null : procStartFromStat(stat);
    const bootId = platform.proc.bootId();
    if (procStart === null || bootId === null || /\s/.test(bootId) || bootId === '') return '';
    return ` ${platform.pid} ${procStart} ${bootId}`;
  } catch {
    return '';
  }
}

/** Whether `value` of window_launching still holds the lock for its holder. */
function holds(platform: Platform, value: string, staleMs: number): boolean {
  const match = LAUNCHING.exec(value);
  if (match === null) return false;
  const taken = BigInt(match[1] ?? '0');
  const now = platform.clock.nowNs();
  const stale = BigInt(staleMs) * NS_PER_MS;
  if (now - taken >= stale || taken - now >= stale) return false;
  if (match[2] === undefined) return true;
  const pid = Number(match[2]);
  const procStart = Number(match[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(procStart)) return false;
  return (
    pidLineState({ pid, procStart, bootId: match[4] ?? '' }, platform.proc, bootIdOf(platform)) !==
    'dead'
  );
}
