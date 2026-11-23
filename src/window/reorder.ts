/**
 * F37, F42 (S2 12.9, 7.6): `act reorder` on the server. The move is computed over Open as the
 * server draws it for the page that sent it (`openRows` over the kept order, the view model's rule
 * in view/slot-moves.ts, checked by `planMove`), never on the page (S2 4.3), and applied as Open's
 * new kept order and new numbers for Open's terminals through the registry, which writes both to
 * the store in one transaction before it applies them and then announces the change (every page's
 * list follows).
 *
 * The whole act is one synchronous section — the rows, the terminals, the rule, `setSlots` and its
 * kv writes —, so no terminal opens between the reading of the numbers and their change.
 */
import { isSessionId } from '../claude/live.ts';
import type { Ns } from '../platform/types.ts';
import type { ListRow } from '../sessions/list.ts';
import type { OpenOrder } from './open-order.ts';
import type { ViewMessage } from './protocol.ts';
import type { Registry } from './terminals.ts';
import { heldPlaces, openRows } from './view/build.ts';
import type { ViewInput } from './view/build.ts';
import { frozenOrder } from './view/open-sequence.ts';
import { isFiltering, searchWords } from './view/search/filter.ts';
import { assignSlots, REORDER_REFUSALS, reorderedRows, withLeftOut } from './view/slot-moves.ts';
import type { ReorderDirection, SlotChanges } from './view/slot-moves.ts';

/** `setSlots` refused because the registry was stopped. */
export const SERVER_STOPPING = "the window's server is stopping";

export interface ReorderDeps {
  registry: Pick<Registry, 'list' | 'setSlots'>;
  /** The tick's rows and the sessions running elsewhere (as the pages' lists are built from). */
  rows: () => readonly ListRow[];
  elsewhere: () => ReadonlyMap<string, { pid: number; tty: string | null }>;
  nowNs: () => Ns;
  /** F42: Open's kept order (open-order.ts): read for the move, and the move's order adopted once
   *  it is written. */
  openOrder: Pick<OpenOrder, 'ids' | 'adopt'>;
  /** F42: writes the moved numbers and Open's new order together (both or neither); a throw
   *  refuses the move, nothing applied. */
  persist: (moved: ReadonlyMap<string, number | null>, order: readonly string[]) => void;
  /** After a move: the restore's memory takes the new order (restore-memory.ts); it never throws.
   *  Absent: nothing is remembered. */
  remember?: () => void;
}

export interface Reorder {
  /**
   * Moves `sessionId`'s row of Open one place in `direction`, for a page whose last view is
   * `view`: refused while that view sets a filter or a chip, else by the rule's refusals
   * (`REORDER_REFUSALS`), or when the registry refuses the numbers (the list changed meanwhile, or
   * the server is stopping). A store that cannot be written throws (the act answers busy).
   */
  reorder(
    view: ViewMessage | undefined,
    sessionId: string,
    direction: ReorderDirection,
  ): { ok: true } | { ok: false; error: string };
}

/** A move planned on the server: the numbers that change and Open's new kept order. */
export type MovePlan =
  { ok: true; slots: SlotChanges; order: string[] } | { ok: false; error: string };

/**
 * The move of `sessionId`'s row of Open one place in `direction` over the view model's input (its
 * `openOrder` the kept order), for a page that shows done ones or not (`showDone`):
 * 1. the rule's new visible order (`reorderedRows` over `openRows(input, showDone)`);
 * 2. the whole sequence: the rows that page does not draw, and the held places, lifted in
 *    (`withLeftOut` over the order a freeze would keep now);
 * 3. the numbers handed out again from its top (`assignSlots`);
 * 4. checked by building Open again with that order and those numbers: the page's visible order is
 *    the intended one, every row keeps its terminal (so the numbers are the ones handed out) and
 *    the numbers ascend in drawn order. When not — two terminals of the window
 *    show a session of Open (a `/resume` inside a terminal), the moved one or one its row would
 *    pass, and that session's row would go to its other terminal with its own number — the move is
 *    refused with `REORDER_REFUSALS.twins`; trying again would not help. The claim of a row by a
 *    terminal (`build.ts`) is not changed for it.
 * `order` is the list the next freeze computes: `frozenOrder` over the new Open.
 */
export function planMove(
  input: Omit<ViewInput, 'view' | 'selected'>,
  showDone: boolean,
  sessionId: string,
  direction: ReorderDirection,
): MovePlan {
  const visible = openRows(input, showDone);
  const intended = reorderedRows(visible, sessionId, direction);
  if (!intended.ok) return intended;
  const all = openRows(input, true);
  const full = frozenOrder(
    input.openOrder ?? [],
    all.map((row) => row.id),
    heldPlaces(input),
  );
  const sequence = withLeftOut(full, all, intended.rows);
  const byId = new Map(all.map((row) => [row.id, row]));
  const slots = assignSlots(sequence.flatMap((id) => byId.get(id) ?? []));
  const after = {
    ...input,
    openOrder: sequence,
    terminals: input.terminals.map((terminal) => ({
      ...terminal,
      slot: slots.has(terminal.id) ? (slots.get(terminal.id) ?? null) : terminal.slot,
    })),
  };
  const shown = openRows(after, showDone);
  const drawn = openRows(after, true);
  const numbers = drawn.flatMap((row) => (row.slot === null ? [] : [row.slot]));
  const terminalOf = new Map(all.map((row) => [row.id, row.terminal]));
  const same =
    shown.length === intended.rows.length &&
    shown.every((row, at) => row.id === intended.rows[at]?.id) &&
    drawn.every((row) => terminalOf.get(row.id) === row.terminal) &&
    numbers.every((slot, at) => at === 0 || (numbers[at - 1] ?? 0) < slot);
  if (!same) return { ok: false, error: REORDER_REFUSALS.twins };
  return {
    ok: true,
    slots,
    order: frozenOrder(
      sequence,
      drawn.map((row) => row.id),
      heldPlaces(after),
    ),
  };
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
          openOrder: deps.openOrder.ids(),
        },
        view?.showDone ?? true,
        sessionId,
        direction,
      );
      if (!plan.ok) return plan;
      // Checked and copied before any write: distinct session ids (anything else cannot happen).
      const order = [...plan.order];
      if (new Set(order).size !== order.length || !order.every((id) => isSessionId(id))) {
        return { ok: false, error: REORDER_REFUSALS.changed };
      }
      const outcome = deps.registry.setSlots(plan.slots, (moved) => {
        deps.persist(moved, order);
        deps.openOrder.adopt(order); // last, after the write: memory and the store cannot part
      });
      if (outcome === 'stopping') return { ok: false, error: SERVER_STOPPING };
      if (outcome === 'changed') return { ok: false, error: REORDER_REFUSALS.changed };
      deps.remember?.();
      return { ok: true };
    },
  };
}
