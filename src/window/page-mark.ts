/**
 * The pages mark (plan C20; S2 5.1, 10.2): `kv` `window_pages_open` is in the store while the
 * server has pages connected, so that the next server — after a WSL restart, a crash or `--stop`,
 * with the old window still open — knows that a window may come back. A server that finds the
 * mark at its start expects that window from the end of its start until a page connects or
 * EXPECT_MS have passed, and says so in `GET /status` (`windowExpectedMs`): the wait is the
 * server's fact, which every command that would open a window reads (`skydeck window`, a second
 * one meanwhile, the window a command opens), not each command's own guess.
 *
 * At an orderly stop the server writes the mark once more as its pages are (plan task 74); a server
 * that dies leaves the key as its last refresh wrote it. The next server's first refresh makes the
 * store agree with its own pages, so a mark that a dead server left costs at most one wait.
 * Nothing here holds a page, a window or a session: the key is "1" or absent.
 */
import { NS_PER_MS } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type { Store } from '../store/store.ts';
import { failureKind } from './auth.ts';

/**
 * C20: how long a window is expected back after the start — the page tries again every 5 s at
 * most (S2 6.3), and its first try may meet the start's last moment.
 */
const EXPECT_MS = 7000;
const KEY = 'window_pages_open';

export interface PageMark {
  /** Whether kv window_pages_open was there when the mark was created (the server's start). */
  readonly foundAtStart: boolean;
  /** Makes the store agree with `pages`: the key ('1') when > 0, none at 0. The first call writes
   *  or removes whatever the store holds; later calls write only on a change. A write that fails
   *  is logged by kind and tried again at the next call. */
  update(pages: number): void;
  /** C20: from `startDoneNs` (the end of the server's start; null while it is not done: 7,000)
   *  the server expects a window back while foundAtStart, no page has connected since (`pages`
   *  > 0 seen by update or by this call) and 7 s have not passed: the ms left (a whole number,
   *  never 0 and never more than 7,000: a clock that stepped back does not lengthen it beyond the
   *  step), else null. `nowNs` and `startDoneNs` are of the one clock the server gives it. */
  expectedMs(nowNs: Ns, startDoneNs: Ns | null, pages: number): number | null;
}

/**
 * The mark of one server, created at its start: it reads the key once (a read that fails is
 * logged by kind and counts as no mark — nothing is expected that cannot be known). Never throws.
 */
export function createPageMark(deps: { store: Store; log: (line: string) => void }): PageMark {
  const { store, log } = deps;
  const foundAtStart = found(store, log);
  /** What the store holds as far as this mark wrote it; null before the first write that worked
   *  and after one that failed. */
  let stored: boolean | null = null;
  let pageSeen = false;
  return {
    foundAtStart,
    update(pages) {
      const open = pages > 0;
      if (open) pageSeen = true;
      if (stored === open) return;
      try {
        if (open) store.setKv(KEY, '1');
        else store.deleteKv(KEY);
        stored = open;
      } catch (error) {
        stored = null;
        log(
          `page mark: ${KEY} could not be ${open ? 'written' : 'removed'} (${failureKind(error)})`,
        );
      }
    },
    expectedMs(nowNs, startDoneNs, pages) {
      if (pages > 0) pageSeen = true;
      if (!foundAtStart || pageSeen) return null;
      if (startDoneNs === null) return EXPECT_MS;
      const leftNs = BigInt(EXPECT_MS) * NS_PER_MS - (nowNs - startDoneNs);
      if (leftNs <= 0n) return null;
      // A part of a millisecond left is 1: 0 would read as "nothing expected" on the wire.
      const left = (leftNs + NS_PER_MS - 1n) / NS_PER_MS;
      return left > BigInt(EXPECT_MS) ? EXPECT_MS : Number(left);
    },
  };
}

function found(store: Store, log: (line: string) => void): boolean {
  try {
    return store.getKv(KEY) !== null;
  } catch (error) {
    log(`page mark: ${KEY} could not be read (${failureKind(error)})`);
    return false;
  }
}
