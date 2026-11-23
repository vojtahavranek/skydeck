/**
 * F37, F42 (design 7.8): the window remembers the order of Open in this boot, so that a restore
 * after a reboot opens the sessions in that order (src/sessions/restore-order.ts keeps the record
 * and the rule): numbered ones then take ascending numbers, unnumbered ones ascending opening
 * times. A session that left Open while still a restore's candidate keeps its place. The server
 * calls `update` after each refresh that worked and after a move; it writes only when the record
 * changes, and never throws.
 */
import type { ListRow } from '../sessions/list.ts';
import {
  formatRememberedOrder,
  parseRememberedOrder,
  RESTORE_ORDER_KEY,
  rememberOrder,
} from '../sessions/restore-order.ts';
import { restorable } from '../sessions/restore.ts';
import type { Store } from '../store/store.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';

export interface RestoreMemory {
  /** Takes Open's drawn order now (`open`, session ids, done ones shown) into this boot's part;
   *  `rows` tell which sessions that left Open are still a restore's candidate. Never throws. */
  update(open: readonly string[], rows: readonly ListRow[]): void;
}

export function createRestoreMemory(deps: {
  store: Pick<Store, 'getKv' | 'setKv'>;
  bootId: string;
  log: (line: string) => void;
}): RestoreMemory {
  /** The text the store holds, as last read or written; null before the first read. */
  let stored: string | null | undefined;
  let failure: string | null = null;
  return {
    update(open, rows) {
      try {
        if (stored === undefined) stored = deps.store.getKv(RESTORE_ORDER_KEY);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const keep = (sessionId: string): boolean => {
          const row = byId.get(sessionId);
          return row !== undefined && restorable(row);
        };
        const record = parseRememberedOrder(stored);
        const next = formatRememberedOrder(rememberOrder(record, deps.bootId, open, keep));
        if (next === formatRememberedOrder(record)) return;
        deps.store.setKv(RESTORE_ORDER_KEY, next);
        stored = next;
        failure = null;
      } catch (error) {
        const kind = isBusy(error) ? 'the database is busy' : failureKind(error);
        if (failure !== kind) {
          failure = kind;
          deps.log(`restore order: the order of Open was not remembered (${kind})`);
        }
      }
    },
  };
}
