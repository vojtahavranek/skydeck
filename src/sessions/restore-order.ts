/**
 * F37 (design 7.8, S2 12.7): the order a restore opens its sessions in — the order of the slots
 * they last had in the window in their boot, so that they come back in the same relative order;
 * sessions with no remembered slot follow, in list order.
 *
 * The window's server remembers the slots (src/window/slot-memory.ts) in one `kv` entry,
 * `window_restore_order` — no table, no migration —: a JSON array of at most two parts, the newest
 * boot first, each `{ "bootId": "<uuid>", "sessions": { "<session id>": <slot> } }`. Within a boot
 * each slot names the latest session that held it and each session one slot. The command's restore
 * reads it too (`restorePlan`), so both restore in the same order.
 *
 * Pure but for `readRememberedSlots`, which reads the store.
 */
import { isSessionId } from '../claude/live.ts';
import type { Store } from '../store/store.ts';
import type { KvKey } from '../store/types.ts';

export const RESTORE_ORDER_KEY: KvKey = 'window_restore_order';

/** The slots of one boot, by session id. */
export interface BootSlots {
  bootId: string;
  sessions: ReadonlyMap<string, number>;
}

/** At most two boots' slots, the newest first. */
export type RememberedSlots = readonly BootSlots[];

/** How many boots are kept: the current one and the one before it, which a restore offers. */
const BOOTS_KEPT = 2;

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The record once `holders` (session id → the slot its terminal of the window has now) are taken
 * into `bootId`'s part: every session that is a holder, or holds a holder's slot, is removed from
 * that part, then the holders are added. A part of `bootId` that is not the first becomes the
 * first; a new one goes first and the record keeps at most two parts (the oldest dropped). No
 * holders: the record unchanged — nothing is removed when a terminal goes, so a reboot that ends
 * the keepers before the server cannot empty it, and a new boot's server keeps the earlier boot's
 * part until its first terminal has a slot.
 */
export function rememberSlots(
  record: RememberedSlots,
  bootId: string,
  holders: ReadonlyMap<string, number>,
): RememberedSlots {
  if (holders.size === 0) return record;
  const own = record.find((part) => part.bootId === bootId);
  const taken = new Set(holders.values());
  const sessions = new Map<string, number>();
  for (const [sessionId, slot] of own?.sessions ?? []) {
    if (!holders.has(sessionId) && !taken.has(slot)) sessions.set(sessionId, slot);
  }
  for (const [sessionId, slot] of holders) sessions.set(sessionId, slot);
  const others = record.filter((part) => part.bootId !== bootId);
  return [{ bootId, sessions }, ...others].slice(0, BOOTS_KEPT);
}

/** The record as the store keeps it (JSON), sessions in slot order. */
export function formatRememberedSlots(record: RememberedSlots): string {
  return JSON.stringify(
    record.map((part) => ({
      bootId: part.bootId,
      sessions: Object.fromEntries([...part.sessions].sort((a, b) => a[1] - b[1])),
    })),
  );
}

/**
 * The record a text holds. Not JSON, not an array: none. Of an array, the first two parts that are
 * objects with a boot id (a lowercase UUID) and a `sessions` object; of each, the entries whose key
 * is a session id and whose value a whole number 1–9, and no slot twice (the first kept). A boot
 * that comes twice is read once (the first).
 */
export function parseRememberedSlots(text: string | null): RememberedSlots {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const parts: BootSlots[] = [];
  for (const part of value as unknown[]) {
    if (parts.length >= BOOTS_KEPT) break;
    if (typeof part !== 'object' || part === null) continue;
    const { bootId, sessions } = part as { bootId?: unknown; sessions?: unknown };
    if (typeof bootId !== 'string' || !BOOT_ID.test(bootId)) continue;
    if (parts.some((known) => known.bootId === bootId)) continue;
    if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) continue;
    const read = new Map<string, number>();
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
        read.set(sessionId, slot);
        slots.add(slot);
      }
    }
    parts.push({ bootId, sessions: read });
  }
  return parts;
}

/** The record the store holds (tolerant: what is not well formed is left out). */
export function readRememberedSlots(store: Pick<Store, 'getKv'>): RememberedSlots {
  return parseRememberedSlots(store.getKv(RESTORE_ORDER_KEY));
}

/**
 * `entries` in a restore's order: those whose session has a remembered slot in the part of the
 * entry's own boot first, by that slot (equal slots, which only two boots under `--all` can give,
 * in their order); then the others, in their order.
 */
export function inRememberedOrder<T extends { row: { id: string }; bootId: string }>(
  entries: readonly T[],
  record: RememberedSlots,
): T[] {
  const slotOf = (entry: T): number | undefined =>
    record.find((part) => part.bootId === entry.bootId)?.sessions.get(entry.row.id);
  const remembered = entries
    .map((entry, at) => ({ entry, at, slot: slotOf(entry) }))
    .filter((one): one is { entry: T; at: number; slot: number } => one.slot !== undefined)
    .sort((a, b) => a.slot - b.slot || a.at - b.at)
    .map((one) => one.entry);
  const rest = entries.filter((entry) => slotOf(entry) === undefined);
  return [...remembered, ...rest];
}
