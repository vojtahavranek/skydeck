/**
 * F44 (S2 7.6, 12.1, 12.15): the numbers of parked sessions' terminals. "Parked now" is derived from
 * the store and the transcripts, and the mark can be written by another process (`skydeck park`),
 * so no act owns the numbers: the server makes the registry agree with the derived state every
 * time its rows or its terminals change, by one idempotent call that names the whole truth
 * (`sync`). The server calls it after every refresh that worked, after every `reloadNow` (an act's
 * write) and in the step that spawns a terminal.
 *
 * `sync` withholds the slot of every terminal whose session is parked (`parkedTerminals`: its
 * session, else the one it was opened for; twins too) and gives the others theirs back; and, while
 * Open's order is kept, drops the parked sessions from it at once (12.1: back under Open such a
 * session is placed as a row that was not kept). It does nothing until `ready()` (the first refresh
 * that worked has run: before it the keepers may still be looked for, and a stored withheld set
 * would be pruned against an empty registry), nothing once `stopping()`, and never throws: a
 * failure is logged once by kind. A write of the registry that fails is the registry's to log; the
 * next call tries again.
 */
import type { ListRow } from '../sessions/list.ts';
import { failureKind } from './auth.ts';
import type { OpenOrder } from './open-order.ts';
import type { Registry } from './terminals.ts';
import { parkedTerminals } from './view/sections.ts';

export interface ParkedSlotsDeps {
  registry: Pick<Registry, 'list' | 'withholdSlots'>;
  /** The rows the lists show now (the tick's). */
  rows: () => readonly ListRow[];
  /** The first refresh that worked has run. */
  ready: () => boolean;
  /** The server's stop began. */
  stopping: () => boolean;
  openOrder: Pick<OpenOrder, 'ids' | 'keeps' | 'freeze'>;
  log: (line: string) => void;
}

export interface ParkedSlots {
  sync(): void;
}

export function createParkedSlots(deps: ParkedSlotsDeps): ParkedSlots {
  let failure: string | null = null;
  return {
    sync() {
      try {
        if (!deps.ready() || deps.stopping()) return;
        const rows = deps.rows();
        deps.registry.withholdSlots(parkedTerminals(rows, deps.registry.list()));
        if (deps.openOrder.keeps()) {
          const parked = new Set(rows.filter((row) => row.parked).map((row) => row.id));
          const kept = deps.openOrder.ids();
          if (kept.some((id) => parked.has(id))) {
            deps.openOrder.freeze(kept.filter((id) => !parked.has(id)));
          }
        }
        failure = null;
      } catch (error) {
        const kind = failureKind(error);
        if (failure !== kind) {
          failure = kind;
          deps.log(`parked slots: the numbers of parked sessions were not set (${kind})`);
        }
      }
    },
  };
}
