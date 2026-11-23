/**
 * F42 (S2 12.1, 12.9): Open's order once a move made it the server's. Pure.
 *
 * Until the first move nothing is kept and Open is computed (`compareOpen` in `build.ts`). From
 * then on the server keeps Open's drawn order (kv `window_open_order`, src/window/open-order.ts),
 * and every refresh that worked takes the order drawn then as the kept one (the freeze,
 * `frozenOrder`): a row keeps the place it was first drawn at, so a session closing or opening
 * moves no other row.
 *
 * `openSequence` draws the kept rows in their kept order and places each row not kept yet by
 * today's rule: a terminal of the window with number k before the first window terminal with a
 * higher number (else after the last numbered one), one without a number after the window's
 * terminals, a session that does not run in the window last. With nothing kept that is exactly `compareOpen`'s order.
 *
 * A held place (`build.ts`'s `heldPlaces`): a kept session whose process went on with another
 * session (`/clear`, an in-session `/resume`, a fork made in that process) keeps its place for
 * that process's next session, its successor, which is drawn there (`takes`).
 *
 * Imports: none.
 */

/** One row of Open as today's rule needs it: whether it runs in a terminal of the window, and
 *  that terminal's number. */
export interface SequenceEntry {
  readonly id: string;
  readonly window: boolean;
  readonly slot: number | null;
}

/** The kept sessions that hold a place while not under Open (`held`, in kept order), and of
 *  those the ones a successor takes (`takes`: held id → the successor's id). */
export interface HeldPlaces {
  readonly held: readonly string[];
  readonly takes: ReadonlyMap<string, string>;
}

/** No place held. */
export const NO_HELD_PLACES: HeldPlaces = { held: [], takes: new Map() };

/**
 * Open's order: `today` is every row under Open in `compareOpen`'s order, `kept` the kept order
 * (empty: none), `takes` the held places their successors take. First the kept ids that are under
 * Open, in kept order, each held id of `takes` replaced by its successor; then every other row of
 * `today`, in `today`'s order, inserted where today's rule puts it.
 */
export function openSequence(
  today: readonly SequenceEntry[],
  kept: readonly string[],
  takes: ReadonlyMap<string, string>,
): string[] {
  const byId = new Map(today.map((entry) => [entry.id, entry]));
  const placed: SequenceEntry[] = [];
  const done = new Set<string>();
  const place = (id: string | undefined): void => {
    const entry = id === undefined ? undefined : byId.get(id);
    if (entry !== undefined && !done.has(entry.id)) {
      placed.push(entry);
      done.add(entry.id);
    }
  };
  for (const id of kept) {
    place(byId.has(id) ? id : takes.get(id));
  }
  for (const entry of today) {
    if (done.has(entry.id)) continue;
    done.add(entry.id);
    if (!entry.window) {
      placed.push(entry);
      continue;
    }
    placed.splice(placeOf(placed, entry.slot), 0, entry);
  }
  return placed.map((entry) => entry.id);
}

/**
 * Where today's rule puts a new terminal of the window among the rows placed so far. With number
 * `slot`: before the first window terminal WITH a higher number; if none, right after the last
 * window terminal with a number; if none, before the first window terminal (first when none) — so
 * that a numberless terminal a block draws above numbered ones does not stop it. Without a number:
 * right after the last window terminal (first when none).
 */
function placeOf(placed: readonly SequenceEntry[], slot: number | null): number {
  if (slot === null) {
    return placed.findLastIndex((one) => one.window) + 1;
  }
  const higher = placed.findIndex((one) => one.window && one.slot !== null && one.slot > slot);
  if (higher !== -1) return higher;
  const lastNumbered = placed.findLastIndex((one) => one.window && one.slot !== null);
  if (lastNumbered !== -1) return lastNumbered + 1;
  return Math.max(
    0,
    placed.findIndex((one) => one.window),
  );
}

/**
 * The order a freeze keeps: `drawn` (Open's drawn ids, done ones shown, blocks consecutive), with
 * each held place no successor takes put back right after the nearest earlier id of `kept` that is
 * in the new list, first when there is none. A taken place is not put back: its successor stands
 * at its place in `drawn`. Open empty and nothing held: [] (the kept order ends).
 */
export function frozenOrder(
  kept: readonly string[],
  drawn: readonly string[],
  held: HeldPlaces,
): string[] {
  return withPutBack(
    kept,
    drawn,
    held.held.filter((id) => !held.takes.has(id)),
  );
}

/**
 * `next` with each id of `back` (ids of `old`, not in `next`) put right after the nearest earlier
 * id of `old` that is in the new list — `next` and the ids put back before it —, first when there
 * is none; `back` is taken in `old`'s order.
 */
export function withPutBack(
  old: readonly string[],
  next: readonly string[],
  back: readonly string[],
): string[] {
  const result = [...next];
  const wanted = new Set(back);
  for (const [index, id] of old.entries()) {
    if (!wanted.has(id) || result.includes(id)) continue;
    let at = 0;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const found = result.indexOf(old[earlier] ?? '');
      if (found !== -1) {
        at = found + 1;
        break;
      }
    }
    result.splice(at, 0, id);
  }
  return result;
}
