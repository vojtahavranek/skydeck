/**
 * F37, F42 (S2 12.9, 7.6): moving a session of Open one place up or down by hand. Pure.
 *
 * The move is computed over Open as the page that sent it draws it without filter, every block open
 * (`openRows` in `build.ts`): a unit is a block (consecutive rows with the same `stack.head`) or a
 * single row. Inside a block a row trades places with its neighbour of the block; at the block's
 * edge the whole block passes the next unit; a single row passes a whole block. Any row of Open
 * moves (F42): also a terminal of the window without a number, a session running in another
 * terminal and one in Claude Code's background. Then `assignSlots` hands the numbers Open's window
 * terminals hold out again from the top of the new order, ascending, among the window's terminals
 * only, so that the set of numbers in use does not change (a gap stays a gap): a terminal can gain
 * a number and another lose its own.
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
  top: 'already at the top of Open',
  last: 'already at the bottom of Open',
  changed: 'the list changed meanwhile; try again',
  /** Two terminals of the window show a session of Open (a `/resume` inside a terminal), and the
   *  move — of that session, or of a row that would pass it — would not read as intended: see
   *  reorder.ts's `planMove`. */
  twins: 'a session here is shown by two terminals; close one of them first',
} as const;

/** The numbers that change, by terminal id: a number, or null for a terminal that loses its own. */
export type SlotChanges = Map<string, number | null>;

/** A move's outcome over one sequence: Open's new drawn order and the numbers that change, or the
 *  line saying why nothing does. */
export type ReorderPlan =
  { ok: true; rows: RowPayload[]; slots: SlotChanges } | { ok: false; error: string };

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
  const rows = [...open];
  const units = unitsOf(open);
  const u = units.findIndex((unit) => unit.start <= at && at < unit.end);
  const unit = units[u];
  if (unit === undefined) {
    return { ok: false, error: REORDER_REFUSALS.notOpen }; // cannot happen: every row is in a unit
  }
  // Inside a block: trade places with the neighbouring row of the block, whatever either's kind.
  const neighbour = direction === 'up' ? at - 1 : at + 1;
  if (unit.end - unit.start > 1 && neighbour >= unit.start && neighbour < unit.end) {
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
  if (after === undefined) {
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
 * F42 (S2 12.9, 7.6): the numbers Open's rows of terminals of the window hold, sorted, handed out
 * again from the top of `sequence`: the first of those rows take them in order, every later one
 * none. A row not in the window never has one. Only the changed ones, by terminal id (null: the
 * terminal loses its number). The set of numbers in use stays the same.
 */
export function assignSlots(sequence: readonly RowPayload[]): SlotChanges {
  const windowRows = sequence.filter(
    (row): row is RowPayload & { terminal: string } => row.terminal !== null,
  );
  const sorted = windowRows
    .flatMap((row) => (row.slot === null ? [] : [row.slot]))
    .sort((a, b) => a - b);
  const changes: SlotChanges = new Map();
  for (const [index, row] of windowRows.entries()) {
    const slot = sorted[index] ?? null;
    if (slot !== row.slot) {
      changes.set(row.terminal, slot);
    }
  }
  return changes;
}

/**
 * F42 (S2 12.9): a move is one visible step on the page that made it. `moved` is the page's
 * visible Open after the move; `full` the whole kept order a freeze would keep now (Open with done
 * ones shown, `all`, and the held places). Each id of `full` that `moved` does not have goes right
 * after the last row of its group in the new sequence when that group has a row there, else right
 * after the nearest earlier id of `full` that is in the new list, first when there is none. Ids.
 */
export function withLeftOut(
  full: readonly string[],
  all: readonly RowPayload[],
  moved: readonly RowPayload[],
): string[] {
  const groupOf = new Map(all.map((row) => [row.id, row.group]));
  const result = moved.map((row) => row.id);
  const visible = new Set(result);
  for (const [index, id] of full.entries()) {
    if (visible.has(id) || result.includes(id)) continue;
    const group = groupOf.get(id) ?? null;
    let at = -1;
    if (group !== null) {
      at = result.findLastIndex((one) => groupOf.get(one) === group);
    }
    if (at === -1) {
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const found = result.indexOf(full[earlier] ?? '');
        if (found !== -1) {
          at = found;
          break;
        }
      }
    }
    result.splice(at + 1, 0, id);
  }
  return result;
}

/**
 * The move of `sessionId`'s row of Open one place in `direction` over one sequence: Open's new
 * drawn order and the numbers that change, so that Open drawn again reads the new order with its
 * numbers ascending from the top; or the refusal (`REORDER_REFUSALS`). `open` is `openRows`'s:
 * Open drawn without filter, every block open. The filter's refusal is the caller's: it knows the
 * page's view. The server's move (reorder.ts's `planMove`) adds the kept order and its check.
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
  return { ok: true, rows: moved.rows, slots: assignSlots(moved.rows) };
}
