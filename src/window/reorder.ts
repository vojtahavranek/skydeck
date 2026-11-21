/**
 * F37 (S2 12.9, 7.6): `act reorder` on the server. The move is computed over Open as the server
 * draws it (`openRows`, the view model's rule in view/slot-moves.ts), never on the page (S2 4.3),
 * and applied as new slots for Open's terminals through the registry, which writes them to the
 * store before it applies them and then announces the change (every page's list follows).
 *
 * The whole act is one synchronous section — the rows, the terminals, the rule, `setSlots` and its
 * kv write —, so no terminal opens between the reading of the slots and their change.
 */
import type { Ns } from '../platform/types.ts';
import type { ListRow } from '../sessions/list.ts';
import type { ViewMessage } from './protocol.ts';
import type { Registry } from './terminals.ts';
import { openRows } from './view/build.ts';
import { isFiltering, searchWords } from './view/search/filter.ts';
import { planReorder, REORDER_REFUSALS } from './view/slot-moves.ts';
import type { ReorderDirection } from './view/slot-moves.ts';

/** `setSlots` refused because the registry was stopped. */
export const SERVER_STOPPING = "the window's server is stopping";

export interface ReorderDeps {
  registry: Pick<Registry, 'list' | 'setSlots'>;
  /** The tick's rows and the sessions running elsewhere (as the pages' lists are built from). */
  rows: () => readonly ListRow[];
  elsewhere: () => ReadonlyMap<string, { pid: number; tty: string | null }>;
  nowNs: () => Ns;
  /** After a move: the restore's memory of the slots takes the new ones (slot-memory.ts); it never
   *  throws. Absent: nothing is remembered. */
  remember?: () => void;
}

export interface Reorder {
  /**
   * Moves `sessionId`'s row of Open one place in `direction`, for a page whose last view is
   * `view`: refused while that view sets a filter or a chip, else by the rule's refusals
   * (`REORDER_REFUSALS`), or when the registry refuses the slots (the list changed meanwhile, or
   * the server is stopping). A store that cannot be written throws (the act answers busy).
   */
  reorder(
    view: ViewMessage | undefined,
    sessionId: string,
    direction: ReorderDirection,
  ): { ok: true } | { ok: false; error: string };
}

export function createReorder(deps: ReorderDeps): Reorder {
  return {
    reorder(view, sessionId, direction) {
      if (view !== undefined && isFiltering(searchWords(view.filter), view.chips ?? [])) {
        return { ok: false, error: REORDER_REFUSALS.filter };
      }
      const open = openRows({
        rows: deps.rows(),
        terminals: deps.registry.list(),
        elsewhere: deps.elsewhere(),
        nowNs: deps.nowNs(),
      });
      const plan = planReorder(open, sessionId, direction);
      if (!plan.ok) return plan;
      const outcome = deps.registry.setSlots(plan.slots);
      if (outcome === 'stopping') return { ok: false, error: SERVER_STOPPING };
      if (outcome === 'changed') return { ok: false, error: REORDER_REFUSALS.changed };
      deps.remember?.();
      return { ok: true };
    },
  };
}
