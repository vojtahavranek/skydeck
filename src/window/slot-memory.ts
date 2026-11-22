/**
 * F37 (design 7.8): the window remembers which session each slot held in this boot, so that a
 * restore after a reboot opens the sessions in the order of their slots (src/sessions/restore-order.ts
 * keeps the record and the rule). The server calls `update` after each refresh that worked and
 * after a move; it writes only when the record changes, and never throws.
 */
import {
  formatRememberedSlots,
  parseRememberedSlots,
  RESTORE_ORDER_KEY,
  rememberSlots,
} from '../sessions/restore-order.ts';
import type { Store } from '../store/store.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';
import type { TerminalInfo } from './hub.ts';
import { MAY_START } from './view/sections.ts';

export interface SlotMemory {
  /** Takes the slots `terminals` hold now into this boot's part; never throws. */
  update(terminals: readonly TerminalInfo[]): void;
}

/**
 * The holders of `terminals`: each session shown (or, before it reports, the one the terminal was
 * opened for) with the slot of its terminal; of several terminals of one session, one whose
 * program may still run first, then the lower slot. Terminals without a slot hold none.
 */
function holdersOf(terminals: readonly TerminalInfo[]): Map<string, number> {
  const ordered = terminals
    .filter((term): term is TerminalInfo & { slot: number } => term.slot !== null)
    .sort(
      (a, b) =>
        (MAY_START.has(a.state) ? 0 : 1) - (MAY_START.has(b.state) ? 0 : 1) || a.slot - b.slot,
    );
  const holders = new Map<string, number>();
  const slots = new Set<number>();
  for (const term of ordered) {
    const sessionId = term.sessionId ?? term.expectedSessionId;
    if (!holders.has(sessionId) && !slots.has(term.slot)) {
      holders.set(sessionId, term.slot);
      slots.add(term.slot);
    }
  }
  return holders;
}

export function createSlotMemory(deps: {
  store: Pick<Store, 'getKv' | 'setKv'>;
  bootId: string;
  log: (line: string) => void;
}): SlotMemory {
  /** The text the store holds, as last read or written; null before the first read. */
  let stored: string | null | undefined;
  let failure: string | null = null;
  return {
    update(terminals) {
      try {
        if (stored === undefined) stored = deps.store.getKv(RESTORE_ORDER_KEY);
        const next = formatRememberedSlots(
          rememberSlots(parseRememberedSlots(stored), deps.bootId, holdersOf(terminals)),
        );
        if (next === formatRememberedSlots(parseRememberedSlots(stored))) return;
        deps.store.setKv(RESTORE_ORDER_KEY, next);
        stored = next;
        failure = null;
      } catch (error) {
        const kind = isBusy(error) ? 'the database is busy' : failureKind(error);
        if (failure !== kind) {
          failure = kind;
          deps.log(`restore order: the slots were not remembered (${kind})`);
        }
      }
    },
  };
}
