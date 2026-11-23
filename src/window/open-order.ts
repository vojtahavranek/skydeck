/**
 * F42 (S2 12.1, 10.2): Open's kept order, which the window keeps in one `kv` entry,
 * `window_open_order` — no table, no migration —: a JSON array of session ids, Open's drawn order
 * (done ones shown, blocks consecutive) plus the places held for a process's next session
 * (view/build.ts's `heldPlaces`). Absent until the first move: while it is absent Open is computed
 * as before F42 and nothing is written. A move writes it whole; from then on every refresh that
 * worked takes the order drawn then (the freeze, view/open-sequence.ts's `frozenOrder`), so a row
 * keeps the place it was first drawn at. A freeze of an empty order removes the entry: the kept
 * order ends, and Open is computed again until the next move.
 *
 * An older skydeck leaves the entry alone (it reads only the keys it knows).
 */
import { isSessionId } from '../claude/live.ts';
import type { Store } from '../store/store.ts';
import type { KvKey } from '../store/types.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';

export const OPEN_ORDER_KEY: KvKey = 'window_open_order';

/** At most this many ids are read: Open never holds that many rows. */
const MAX_IDS = 500;

/** The order a text holds: not JSON or not an array is none; of an array, the strings that are
 *  session ids, each once (the first), the first 500. */
export function parseOpenOrder(text: string | null): string[] {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const one of value as unknown[]) {
    if (ids.length >= MAX_IDS) break;
    if (typeof one !== 'string' || !isSessionId(one) || seen.has(one)) continue;
    seen.add(one);
    ids.push(one);
  }
  return ids;
}

/** The kept order the store holds (tolerant: what is not well formed is left out). */
export function readOpenOrder(store: Pick<Store, 'getKv'>): string[] {
  return parseOpenOrder(store.getKv(OPEN_ORDER_KEY));
}

/** Writes the kept order; an empty one removes the entry. */
export function writeOpenOrder(
  store: Pick<Store, 'setKv' | 'deleteKv'>,
  ids: readonly string[],
): void {
  if (ids.length === 0) store.deleteKv(OPEN_ORDER_KEY);
  else store.setKv(OPEN_ORDER_KEY, JSON.stringify(ids));
}

export interface OpenOrder {
  /** The kept order as held (read once when made); empty: nothing is kept. */
  ids(): readonly string[];
  /** A freeze has something to do: an order is kept, or the removal of the entry is still to be
   *  written. */
  keeps(): boolean;
  /** A move's order, already written by the caller in the move's transaction (a list the caller
   *  checked: distinct session ids). A plain assignment: it cannot throw. */
  adopt(ids: readonly string[]): void;
  /**
   * The freeze after a refresh that worked: holds `next` and writes it when it differs from the
   * held order (an empty one removes the entry: the kept order ends). A write that fails is logged
   * once by kind, the memory keeps `next`, and the write is tried again at the next freeze, also an
   * unchanged one. Nothing while nothing is kept (but the removal of the entry, when that write
   * failed), or once `stopping()`. Never throws.
   */
  freeze(next: readonly string[]): void;
}

export function createOpenOrder(deps: {
  store: Pick<Store, 'getKv' | 'setKv' | 'deleteKv'>;
  log: (line: string) => void;
  stopping: () => boolean;
}): OpenOrder {
  let held: readonly string[] = readOpenOrder(deps.store);
  /** A write of `held` failed: the next freeze writes it. */
  let dirty = false;
  let failure: string | null = null;
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((id, at) => id === b[at]);
  return {
    ids: () => held,
    keeps: () => held.length > 0 || dirty,
    adopt(ids) {
      held = ids;
      dirty = false;
    },
    freeze(next) {
      try {
        if (deps.stopping()) return;
        if (held.length === 0) {
          // The kept order ended: only its removal, when that write failed, is written again; no
          // order is kept until a move adopts one.
          if (!dirty) return;
          writeOpenOrder(deps.store, []);
          dirty = false;
          failure = null;
          return;
        }
        if (same(held, next) && !dirty) return;
        held = [...next];
        dirty = true;
        writeOpenOrder(deps.store, held);
        dirty = false;
        failure = null;
      } catch (error) {
        const kind = isBusy(error) ? 'the database is busy' : failureKind(error);
        if (failure !== kind) {
          failure = kind;
          deps.log(`open order: the order of Open was not saved (${kind})`);
        }
      }
    },
  };
}
