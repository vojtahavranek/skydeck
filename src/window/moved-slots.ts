/**
 * F37 (S2 7.6, 10.2): the slots moved by hand, which the window keeps in one `kv` entry,
 * `window_slots` — no table, no migration —: a JSON object from terminal id (12 lowercase hex
 * characters) to slot 1–9, or null (F42: a move took the terminal's slot away), holding every live
 * terminal whose slot is not the one of its keeper's meta. The registry applies it at each
 * terminal's hello (terminals.ts), so that a moved slot survives a server restart while the
 * terminal's keeper runs. An older skydeck leaves the entry
 * alone (it reads only the keys it knows) and goes by the meta's slots.
 */
import type { Store } from '../store/store.ts';
import type { KvKey } from '../store/types.ts';

export const MOVED_SLOTS_KEY: KvKey = 'window_slots';

/** A terminal id (window-terminal.ts: 6 random bytes in lowercase hex). */
const TERMINAL_ID = /^[0-9a-f]{12}$/;

/**
 * The moved slots the store holds. A value that is not JSON, or not an object, is none; of an
 * object, the entries whose key is a terminal id and whose value a whole number 1–9 or null are
 * read, the others left out.
 */
export function readMovedSlots(store: Pick<Store, 'getKv'>): Map<string, number | null> {
  const moved = new Map<string, number | null>();
  const stored = store.getKv(MOVED_SLOTS_KEY);
  if (stored === null) return moved;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return moved;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return moved;
  for (const [id, slot] of Object.entries(value as Record<string, unknown>)) {
    if (TERMINAL_ID.test(id) && slot === null) {
      moved.set(id, null);
    } else if (
      TERMINAL_ID.test(id) &&
      Number.isInteger(slot) &&
      (slot as number) >= 1 &&
      (slot as number) <= 9
    ) {
      moved.set(id, slot as number);
    }
  }
  return moved;
}

/** Writes the moved slots; none removes the entry. */
export function writeMovedSlots(
  store: Pick<Store, 'setKv' | 'deleteKv'>,
  moved: ReadonlyMap<string, number | null>,
): void {
  if (moved.size === 0) store.deleteKv(MOVED_SLOTS_KEY);
  else store.setKv(MOVED_SLOTS_KEY, JSON.stringify(Object.fromEntries(moved)));
}
