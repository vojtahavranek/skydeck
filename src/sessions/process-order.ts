// Design 5.3 "Order" (#207): the order of ONE process's events. The hook stamps an event with the
// wall clock, which can step back (seen on a WSL 2 machine: 2.1 to 2.7 s every 32 s), so two events
// of one process that follow each other closely can carry their stamps in the reverse order. The
// machine's uptime never steps back, and one process lives within one boot: when every event of
// the process carries one, the process's events are ordered by (uptime, time, id); otherwise, by
// (time, id) as before. No comparison mixes the two inside one process. The store's queries use
// the same rule in SQL (PROCESS_RULE in src/store/store.ts), held to this one by a test. Orders
// across processes stay on time.
import type { Ns, UptimeCs } from '../platform/types.ts';

/** What the order reads of an event: `id` is the order it was or will be recorded in. */
export interface Ordered {
  id: number;
  timeNs: Ns;
  uptimeCs?: UptimeCs;
}

/** Whether these events (all of one process) are ordered by their uptime: every one has one. */
export function byUptime(events: readonly Pick<Ordered, 'uptimeCs'>[]): boolean {
  return events.every((event) => event.uptimeCs !== undefined);
}

/** Negative when `a` comes before `b` in a process ordered by uptime (`uptime`) or by time. */
export function compareInProcess(a: Ordered, b: Ordered, uptime: boolean): number {
  if (uptime && a.uptimeCs !== undefined && b.uptimeCs !== undefined && a.uptimeCs !== b.uptimeCs) {
    return a.uptimeCs < b.uptimeCs ? -1 : 1;
  }
  if (a.timeNs !== b.timeNs) {
    return a.timeNs < b.timeNs ? -1 : 1;
  }
  return a.id - b.id;
}

/** All the events of ONE process, in its order (a new array). */
export function processOrder<T extends Ordered>(events: readonly T[]): T[] {
  const uptime = byUptime(events);
  return [...events].sort((a, b) => compareInProcess(a, b, uptime));
}
