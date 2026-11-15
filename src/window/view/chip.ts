/**
 * The window's pull-request chip (S2 12.3, plan D4): open and finished pull requests counted
 * apart. `ls` and the interactive list keep design 7.3's chip (`chipFor`). Pure.
 *
 * Imports (S2 4.3, plan D4): design 7.3's order, `CHIP_ORDER` of `src/github.ts`, so that the
 * order of the pull-request states has one place; the window's message type.
 */
import { CHIP_ORDER } from '../../github.ts';
import type { ChipPayload } from '../protocol.ts';

/** The states of a pull request that is no longer open (design 7.3 never fetches one again). */
const FINISHED: ReadonlySet<string> = new Set(['merged', 'closed']);

/** A level's place in design 7.3's order; one the order does not know comes after every known one. */
function rank(level: string): number {
  const at = (CHIP_ORDER as readonly string[]).indexOf(level);
  return at === -1 ? CHIP_ORDER.length : at;
}

/**
 * S2 12.3 over a row's attached pull requests (merged and closed included); null for none. A
 * level other than `merged` and `closed` is open — open, draft, never fetched, and one that cannot
 * be read, which was last seen open or never seen. The chip's level is the open one that most
 * needs the user, the first in design 7.3's order; with none open, `merged` when one is merged,
 * else `closed`. Closed ones are not counted.
 */
export function windowChip(prs: readonly { level: string }[]): ChipPayload | null {
  if (prs.length === 0) {
    return null;
  }
  let worst: string | null = null;
  let open = 0;
  let merged = 0;
  for (const { level } of prs) {
    if (level === 'merged') {
      merged += 1;
    } else if (!FINISHED.has(level)) {
      open += 1;
      if (worst === null || rank(level) < rank(worst)) {
        worst = level;
      }
    }
  }
  return { level: worst ?? (merged > 0 ? 'merged' : 'closed'), open, merged };
}
