/**
 * F37 (S2 12.9, 7.6): moving a session of Open one place up or down by hand. Pure.
 *
 * The move is computed over Open as it is drawn without filter, every block open (`openRows` in
 * `build.ts`): a unit is a block (consecutive rows with the same `stack.head`) or a single row.
 * Inside a block a row trades places with its neighbour of the block; at the block's edge the whole
 * block passes the next unit; a single row passes a whole block. Then `assignSlots` gives the
 * slots of Open's slotted rows, sorted, to those rows in the new order, so that the numbers ascend
 * top to bottom and the set of slots in use does not change (a gap stays a gap).
 *
 * `assignSlots` takes any new order, so that another way of reordering (drag and drop) only needs
 * to say what the new order is.
 *
 * Imports: types only, from `protocol.ts`.
 */
import type { RowPayload } from '../protocol.ts';

export type ReorderDirection = 'up' | 'down';

/** The lines a refused move answers with (S2 12.9). */
export const REORDER_REFUSALS = {
  filter: 'clear the filter first: sessions move only while no filter or chip is set',
  notOpen: 'only a session under Open moves',
  noSlot: 'this terminal has no slot (only nine have one), so it does not move',
  elsewhere: 'a session running in another terminal has no slot, so it does not move',
  background: "a session in Claude Code's background has no slot, so it does not move",
  top: 'already at the top of Open',
  last: 'already the last session with a slot under Open',
  changed: 'the list changed meanwhile; try again',
} as const;

/** A move's outcome: the slots that change, by terminal id, or the line saying why nothing does. */
export type ReorderPlan = { ok: true; slots: Map<string, number> } | { ok: false; error: string };

/** Open's rows cut into units: [first index, end index) of each block or single row. */
function unitsOf(open: readonly RowPayload[]): { start: number; end: number }[] {
  const units: { start: number; end: number }[] = [];
  for (const [index, row] of open.entries()) {
    const head = row.stack?.head ?? null;
    const last = units.at(-1);
    if (head !== null && last !== undefined && open[last.start]?.stack?.head === head) {
      last.end = index + 1;
    } else {
      units.push({ start: index, end: index + 1 });
    }
  }
  return units;
}

/** The refusal for a row of Open without a slot. */
function slotlessRefusal(row: RowPayload): string {
  if (row.elsewhere?.background === true) {
    return REORDER_REFUSALS.background;
  }
  if (row.elsewhere !== null) {
    return REORDER_REFUSALS.elsewhere;
  }
  return REORDER_REFUSALS.noSlot;
}

/**
 * The new drawn order of Open once `sessionId`'s row moved one place in `direction`, or why it
 * cannot move. `open` is Open's rows as drawn without filter, every block open (`openRows`).
 */
export function reorderedRows(
  open: readonly RowPayload[],
  sessionId: string,
  direction: ReorderDirection,
): { ok: true; rows: RowPayload[] } | { ok: false; error: string } {
  const at = open.findIndex((row) => row.id === sessionId);
  const row = open[at];
  if (row === undefined) {
    return { ok: false, error: REORDER_REFUSALS.notOpen };
  }
  if (row.slot === null) {
    return { ok: false, error: slotlessRefusal(row) };
  }
  const rows = [...open];
  const units = unitsOf(open);
  const u = units.findIndex((unit) => unit.start <= at && at < unit.end);
  const unit = units[u];
  if (unit === undefined) {
    return { ok: false, error: REORDER_REFUSALS.notOpen }; // cannot happen: every row is in a unit
  }
  // Inside a block: trade places with the neighbouring row of the block (slotted rows of a block
  // come first, so the row before is slotted; a slotless one after is the block's edge).
  const neighbour = direction === 'up' ? at - 1 : at + 1;
  if (
    unit.end - unit.start > 1 &&
    neighbour >= unit.start &&
    neighbour < unit.end &&
    open[neighbour]?.slot !== null
  ) {
    const other = open[neighbour];
    if (other !== undefined) {
      rows[neighbour] = row;
      rows[at] = other;
      return { ok: true, rows };
    }
  }
  // A single row, or a row at its block's edge: the whole unit passes the next unit.
  if (direction === 'up') {
    const before = units[u - 1];
    if (before === undefined) {
      return { ok: false, error: REORDER_REFUSALS.top };
    }
    return {
      ok: true,
      rows: [
        ...open.slice(0, before.start),
        ...open.slice(unit.start, unit.end),
        ...open.slice(before.start, before.end),
        ...open.slice(unit.end),
      ],
    };
  }
  const after = units[u + 1];
  // Units whose first row has a slot are a prefix of Open: a slotless next one ends them.
  if (after === undefined || open[after.start]?.slot === null) {
    return { ok: false, error: REORDER_REFUSALS.last };
  }
  return {
    ok: true,
    rows: [
      ...open.slice(0, unit.start),
      ...open.slice(after.start, after.end),
      ...open.slice(unit.start, unit.end),
      ...open.slice(after.end),
    ],
  };
}

/**
 * The slots of every slotted row of `sequence`, sorted, given to those rows in `sequence`'s order:
 * only the changed ones, by terminal id. The set of slots stays the same; a row without a slot (or
 * without a terminal) keeps none.
 */
export function assignSlots(sequence: readonly RowPayload[]): Map<string, number> {
  const slotted = sequence.filter(
    (row): row is RowPayload & { slot: number; terminal: string } =>
      row.slot !== null && row.terminal !== null,
  );
  const sorted = slotted.map((row) => row.slot).sort((a, b) => a - b);
  const changes = new Map<string, number>();
  for (const [index, row] of slotted.entries()) {
    const slot = sorted[index];
    if (slot !== undefined && slot !== row.slot) {
      changes.set(row.terminal, slot);
    }
  }
  return changes;
}

/**
 * F37's move of `sessionId`'s row of Open one place in `direction`: the slots that change, by
 * terminal id, so that Open drawn again reads the new order with its numbers ascending; or the
 * refusal (`REORDER_REFUSALS`). `open` is `openRows`'s: Open drawn without filter, every block open.
 * The filter's refusal is the caller's: it knows the page's view.
 */
export function planReorder(
  open: readonly RowPayload[],
  sessionId: string,
  direction: ReorderDirection,
): ReorderPlan {
  const moved = reorderedRows(open, sessionId, direction);
  if (!moved.ok) {
    return moved;
  }
  return { ok: true, slots: assignSlots(moved.rows) };
}
