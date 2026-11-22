/**
 * F37 (S2 12.9, 7.6): `act reorder` on the server. The move is computed over Open as the server
 * draws it (`openRows`, the view model's rule in view/slot-moves.ts, checked by `planMove`), never
 * on the page (S2 4.3),
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
import type { ViewInput } from './view/build.ts';
import { isFiltering, searchWords } from './view/search/filter.ts';
import { assignSlots, REORDER_REFUSALS, reorderedRows } from './view/slot-moves.ts';
import type { ReorderDirection, ReorderPlan } from './view/slot-moves.ts';

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

/**
 * The move of `sessionId`'s row of Open one place in `direction` over the view model's input: the
 * rule's new order (`reorderedRows`) and its slots (`assignSlots`), checked by building Open again
 * with those slots applied. When that is not the intended order with its numbers ascending — two
 * terminals of the window show a session of Open (a `/resume` inside a terminal), the moved one or
 * one its row would pass, and that session's row would go to its other terminal with its own slot
 * — the move is refused with `REORDER_REFUSALS.twins`; trying again would not help. The claim of a row by a terminal (`build.ts`) is not changed for it.
 */
export function planMove(
  input: Omit<ViewInput, 'view' | 'selected'>,
  sessionId: string,
  direction: ReorderDirection,
): ReorderPlan {
  const intended = reorderedRows(openRows(input), sessionId, direction);
  if (!intended.ok) return intended;
  const slots = assignSlots(intended.rows);
  const after = openRows({
    ...input,
    terminals: input.terminals.map((terminal) => ({
      ...terminal,
      slot: slots.get(terminal.id) ?? terminal.slot,
    })),
  });
  const numbers = after.flatMap((row) => (row.slot === null ? [] : [row.slot]));
  const same =
    after.length === intended.rows.length &&
    after.every((row, at) => row.id === intended.rows[at]?.id) &&
    numbers.every((slot, at) => at === 0 || (numbers[at - 1] ?? 0) < slot);
  return same ? { ok: true, slots } : { ok: false, error: REORDER_REFUSALS.twins };
}

export function createReorder(deps: ReorderDeps): Reorder {
  return {
    reorder(view, sessionId, direction) {
      if (view !== undefined && isFiltering(searchWords(view.filter), view.chips ?? [])) {
        return { ok: false, error: REORDER_REFUSALS.filter };
      }
      const plan = planMove(
        {
          rows: deps.rows(),
          terminals: deps.registry.list(),
          elsewhere: deps.elsewhere(),
          nowNs: deps.nowNs(),
        },
        sessionId,
        direction,
      );
      if (!plan.ok) return plan;
      const outcome = deps.registry.setSlots(plan.slots);
      if (outcome === 'stopping') return { ok: false, error: SERVER_STOPPING };
      if (outcome === 'changed') return { ok: false, error: REORDER_REFUSALS.changed };
      deps.remember?.();
      return { ok: true };
    },
  };
}
