/**
 * Which holders of a session run in the window, for `skydeck show` (C15, S2 11.4; plan task 78):
 * a holder is in the window when it is a keeper's program or descends from it — S2 7.5's walk
 * (`holderPlace`), up to 8 parents below the program, so 9 below the keeper — and that keeper is
 * alive by its `.pid` line in the runtime directory (S2 4.2, design 5.5). It does not depend on a
 * running server: it reads the store's record of the directory and the keepers' lines, creates
 * nothing and connects to nothing.
 */
import type { Deck } from '../sessions/deck.ts';
import type { Holder } from '../sessions/types.ts';
import { holderPlace } from './mapping.ts';
import { listKeeperLines, resolveRuntimeDir, runtimeFiles } from './runtime.ts';

/** S2 7.5's 8 parents below a terminal's program, and the keeper one above it. */
const KEEPER_STEPS = 9;

/**
 * C15: the pids of `holders` that descend from a keeper alive by its .pid line in the runtime
 * directory the store records (resolveRuntimeDir 'follow'). Creates nothing; [] on any doubt.
 *
 * A keeper counts only when its line is 'alive' (design 5.5); a holder of another boot, one without
 * a recorded process start, one whose chain cannot be read ('unknown') or that is the keeper itself
 * is not in the window. Without a boot id, or when any read throws, nothing is.
 */
export function holdersInWindow(deck: Deck, holders: readonly Holder[]): ReadonlySet<number> {
  const inWindow = new Set<number>();
  if (holders.length === 0) {
    return inWindow; // nothing to judge: no file is read
  }
  const { platform } = deck;
  try {
    const bootId = platform.proc.bootId();
    if (bootId === null) {
      return inWindow;
    }
    const { dir } = resolveRuntimeDir(deck, 'follow');
    const keepers = new Map<number, { procStart: number; termId: string }>();
    for (const keeper of listKeeperLines(platform, runtimeFiles(dir))) {
      if (keeper.state === 'alive' && keeper.line !== null) {
        keepers.set(keeper.line.pid, { procStart: keeper.line.procStart, termId: keeper.id });
      }
    }
    for (const holder of holders) {
      if (holder.process.bootId !== bootId) {
        continue; // of another boot: no process of this one
      }
      const place = holderPlace(holder, keepers, platform.proc, KEEPER_STEPS);
      if (typeof place === 'object' && place.steps >= 1) {
        inWindow.add(holder.process.pid);
      }
    }
    return inWindow;
  } catch {
    return new Set(); // a read that failed: nothing is said
  }
}
