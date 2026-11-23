/**
 * F37, F42 (design 7.8, S2 12.7): the order a restore opens its sessions in — the order they last
 * had under Open in the window in their boot, so that they come back in the same relative order;
 * sessions with no remembered place follow, in list order.
 *
 * The window's server remembers the order (src/window/restore-memory.ts) in one `kv` entry,
 * `window_restore_order` — no table, no migration —: a JSON array of at most two parts, the newest
 * boot first, each `{ "bootId": "<uuid>", "order": ["<session id>", …] }`: Open's drawn order (done
 * ones shown) as the window last drew it in that boot, with the sessions that left it while still
 * restorable kept at their places. A part F37 wrote, `{ "bootId", "sessions": { "<session id>":
 * <slot> } }`, is read as those sessions in the order of their slots. The command's restore reads it
 * too (`restorePlan`), so both restore in the same order.
 *
 * Pure but for `readRememberedOrder`, which reads the store.
 */
import { isSessionId } from '../claude/live.ts';
import type { Store } from '../store/store.ts';
import type { KvKey } from '../store/types.ts';

export const RESTORE_ORDER_KEY: KvKey = 'window_restore_order';

/** The order of one boot's sessions under Open. */
export interface BootOrder {
  bootId: string;
  order: readonly string[];
}

/** At most two boots' orders, the newest first. */
export type RememberedOrder = readonly BootOrder[];

/** How many boots are kept: the current one and the one before it, which a restore offers. */
const BOOTS_KEPT = 2;

/** At most this many sessions of one boot are read. */
const MAX_SESSIONS = 500;

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The record once `open` (Open's drawn order now, session ids) is taken into `bootId`'s part: the
 * part becomes `open`, with each session of its old order that is not in `open` and for which
 * `keep` holds (still a restore's candidate) put back right after the nearest earlier session of
 * the old order that is in the new list, first when there is none. A part of `bootId` that is not
 * the first becomes the first; a new one goes first and the record keeps at most two parts (the
 * oldest dropped). `open` empty: the record unchanged — a reboot that ends every session before the
 * server cannot empty it, and a new boot's server keeps the earlier boot's part until its first
 * row under Open.
 */
export function rememberOrder(
  record: RememberedOrder,
  bootId: string,
  open: readonly string[],
  keep: (sessionId: string) => boolean,
): RememberedOrder {
  if (open.length === 0) return record;
  const old = record.find((part) => part.bootId === bootId)?.order ?? [];
  const order = [...open];
  const present = new Set(order);
  for (const [index, sessionId] of old.entries()) {
    if (present.has(sessionId) || !keep(sessionId)) continue;
    let at = 0;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const found = order.indexOf(old[earlier] ?? '');
      if (found !== -1) {
        at = found + 1;
        break;
      }
    }
    order.splice(at, 0, sessionId);
    present.add(sessionId);
  }
  const others = record.filter((part) => part.bootId !== bootId);
  return [{ bootId, order }, ...others].slice(0, BOOTS_KEPT);
}

/** The record as the store keeps it (JSON). */
export function formatRememberedOrder(record: RememberedOrder): string {
  return JSON.stringify(record.map((part) => ({ bootId: part.bootId, order: [...part.order] })));
}

/** The session ids of an `order` array: each once (the first), the first 500. */
function readOrder(value: readonly unknown[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const one of value) {
    if (order.length >= MAX_SESSIONS) break;
    if (typeof one !== 'string' || !isSessionId(one) || seen.has(one)) continue;
    seen.add(one);
    order.push(one);
  }
  return order;
}

/** F37's `sessions` object: the entries whose key is a session id and whose value a whole number
 *  1–9, no slot twice (the first kept), in the order of their slots. */
function readSlots(sessions: object): string[] {
  const read: [string, number][] = [];
  const slots = new Set<number>();
  for (const [sessionId, slot] of Object.entries(sessions as Record<string, unknown>)) {
    if (
      isSessionId(sessionId) &&
      typeof slot === 'number' &&
      Number.isInteger(slot) &&
      slot >= 1 &&
      slot <= 9 &&
      !slots.has(slot)
    ) {
      read.push([sessionId, slot]);
      slots.add(slot);
    }
  }
  return read.sort((a, b) => a[1] - b[1]).map(([sessionId]) => sessionId);
}

/**
 * The record a text holds. Not JSON, not an array: none. Of an array, the first two parts that are
 * objects with a boot id (a lowercase UUID) and an `order` array (its session ids, each once, the
 * first 500) or, from F37, a `sessions` object (read by slot). A boot that comes twice is read once
 * (the first).
 */
export function parseRememberedOrder(text: string | null): RememberedOrder {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const parts: BootOrder[] = [];
  for (const part of value as unknown[]) {
    if (parts.length >= BOOTS_KEPT) break;
    if (typeof part !== 'object' || part === null) continue;
    const { bootId, order, sessions } = part as {
      bootId?: unknown;
      order?: unknown;
      sessions?: unknown;
    };
    if (typeof bootId !== 'string' || !BOOT_ID.test(bootId)) continue;
    if (parts.some((known) => known.bootId === bootId)) continue;
    if (Array.isArray(order)) {
      parts.push({ bootId, order: readOrder(order as unknown[]) });
    } else if (typeof sessions === 'object' && sessions !== null && !Array.isArray(sessions)) {
      parts.push({ bootId, order: readSlots(sessions) });
    }
  }
  return parts;
}

/** The record the store holds (tolerant: what is not well formed is left out). */
export function readRememberedOrder(store: Pick<Store, 'getKv'>): RememberedOrder {
  return parseRememberedOrder(store.getKv(RESTORE_ORDER_KEY));
}

/**
 * `entries` in a restore's order: those whose session has a place in the part of the entry's own
 * boot first, by that place (equal places, which only two boots under `--all` can give, in their
 * order); then the others, in their order.
 */
export function inRememberedOrder<T extends { row: { id: string }; bootId: string }>(
  entries: readonly T[],
  record: RememberedOrder,
): T[] {
  const places = new Map(
    record.map((part) => [part.bootId, new Map(part.order.map((id, at) => [id, at]))]),
  );
  const placeOf = (entry: T): number | undefined => places.get(entry.bootId)?.get(entry.row.id);
  const remembered = entries
    .map((entry, at) => ({ entry, at, place: placeOf(entry) }))
    .filter((one): one is { entry: T; at: number; place: number } => one.place !== undefined)
    .sort((a, b) => a.place - b.place || a.at - b.at)
    .map((one) => one.entry);
  const rest = entries.filter((entry) => placeOf(entry) === undefined);
  return [...remembered, ...rest];
}
