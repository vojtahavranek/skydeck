/**
 * Issue #189 (S2 7.6, 12.1): no number 1–9 stays free while a terminal of the window whose program
 * may run waits for one. The first terminal on a row of Open that has no number, in Open's order as
 * the server draws it (`openRows`: done ones shown, every block open), takes the lowest free number,
 * the next one the next, until no number is free or none waits; a terminal that has a number keeps
 * it. A terminal on no row of Open (its twin of the window has the row, or its row is under Recent)
 * waits until it has one.
 *
 * Where its row goes (`orderAfterFill`): while an order is kept, a row drawn in no block goes to its
 * number's place, exactly as a new terminal with that number is placed (view/open-sequence.ts), and
 * a row drawn in a group's block of two or more keeps its place and only takes the number (the
 * block's numbers can then read out of order until the next move, design-step-2.md 12.2); no other
 * row moves. The new kept order is written with the numbers in one store transaction, as a move's,
 * and adopted. Without a kept order nothing but the numbers is written and a hand-out never starts
 * one: Open is computed by number as before, and a block follows its first row's number.
 *
 * The registry gives the numbers (`giveSlots`): the free ones by its one rule (`takenSlots`), only
 * to a terminal whose program may run (never to one whose number was freed or whose exit came, F43)
 * and whose number is not withheld (F44: its session is parked, so its row is under Parked, never
 * waiting), and none while a keeper is still being found, whose number is known only at its hello (said once in the log while
 * that holds a free number back). A write that fails gives nothing: it is logged once by kind and
 * the next run tries again.
 *
 * WHEN it runs is the server's, in one place (server.ts, `fillFreedNumbers`): at every change of
 * the registry — so at each moment a number becomes free (an exit applied, a hello that says the
 * program exited, a lost terminal's program that may no longer run, the close of a lost terminal
 * that still held one) — but for the changes inside the setting of parked sessions' numbers (F44,
 * parked-slots.ts), after which it runs once (a number a parking freed goes to one that waits, once
 * the parked rows have left Open's kept order), and after every refresh that worked (the first
 * after the start, a write that failed, the end of a keeper's finding).
 */
import type { Store } from '../store/store.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';
import { writeMovedSlots, writeWithheldSlots } from './moved-slots.ts';
import { writeOpenOrder } from './open-order.ts';
import type { OpenOrder } from './open-order.ts';
import type { Registry } from './terminals.ts';
import { keptNow, openRows } from './view/build.ts';
import type { ViewInput } from './view/build.ts';
import { MAY_START } from './view/sections.ts';

/** What Open is drawn from: the pages' lists' input without a page's view. */
export type FillInput = Omit<ViewInput, 'view' | 'selected'>;

/**
 * The terminals that wait for a number, in Open's order as the server draws it (done ones shown,
 * every block open): the terminal of each row of Open that has a terminal of the window and no
 * number. Which of them may take one is the registry's (`giveSlots`).
 */
export function waitingTerminals(input: FillInput): string[] {
  return openRows(input, true).flatMap((row) =>
    row.terminal !== null && row.slot === null ? [row.terminal] : [],
  );
}

/**
 * Open's kept order once the terminals of `given` hold their numbers, for a hand-out while an order
 * is kept (without one nothing is stored, and Open is computed by number). A row of such a terminal
 * that is drawn in no block goes to its number's place, as a row not kept yet is placed — after the
 * last window terminal with a lower number, before the next with a higher one
 * (view/open-sequence.ts) —; one drawn in a group's block of two or more rows keeps its place and
 * only takes its number, so the block's numbers can read out of order until the next move
 * (design-step-2.md 12.2). Every other row keeps its place: at a hand-out the rows nobody touched
 * never change their order among themselves. The base is the order a freeze would keep now
 * (`keptNow`).
 */
export function orderAfterFill(input: FillInput, given: ReadonlyMap<string, number>): string[] {
  // The rows placed again: those of the given terminals that no block draws.
  const placed = new Set(
    openRows(input, true).flatMap((row) =>
      row.terminal !== null && given.has(row.terminal) && row.stack === null ? [row.id] : [],
    ),
  );
  return keptNow({
    ...input,
    openOrder: keptNow(input).filter((id) => !placed.has(id)),
    terminals: input.terminals.map((terminal) => {
      const slot = given.get(terminal.id);
      return slot === undefined ? terminal : { ...terminal, slot };
    }),
  });
}

export interface FillDeps {
  registry: Pick<Registry, 'list' | 'nextSlot' | 'giveSlots'>;
  /** Open's input now, as the pages' lists are built (the last refresh's rows, the registry's
   *  terminals, the kept order), or null while there is none (no tick yet). */
  input: () => FillInput | null;
  /** Open's kept order: whether one is kept, and the fill's order adopted once it is written. */
  openOrder: Pick<OpenOrder, 'ids' | 'adopt'>;
  /** Writes the moved numbers, the withheld terminals (F44, as the registry holds them) and, when
   *  an order is kept, Open's new kept order (null: none is), all or none; a throw: nothing
   *  written. */
  persist: (
    moved: ReadonlyMap<string, number | null>,
    withheld: ReadonlySet<string>,
    order: readonly string[] | null,
  ) => void;
  /** After a fill that gave a number: the restore's memory takes Open's order; it never throws.
   *  Absent: nothing is remembered. */
  remember?: () => void;
  log: (line: string) => void;
  /** The server's stop began: nothing is given from then on. */
  stopping: () => boolean;
}

export interface Fill {
  /** Gives the free numbers to the terminals that wait (the module's rule); nothing before the
   *  first `refreshed`, since Open's order is not known until a refresh has worked (its rows).
   *  Never throws. */
  run(): void;
  /** A refresh worked: from now on Open's order is known; then a run. Never throws. */
  refreshed(): void;
}

/**
 * The fill's writes (S2 7.6, 10.2), in one store transaction, all or none: the moved numbers
 * (`window_slots`) and the withheld terminals (`window_slots_withheld`, F44: written with the
 * numbers at every write outside a move, so that neither write undoes the other's part) and, while
 * an order is kept, Open's new kept order (`window_open_order`), as a move's. A store that cannot be
 * written throws.
 */
export function persistFill(
  store: Pick<Store, 'transaction' | 'setKv' | 'deleteKv'>,
  moved: ReadonlyMap<string, number | null>,
  withheld: ReadonlySet<string>,
  order: readonly string[] | null,
): void {
  store.transaction(() => {
    writeMovedSlots(store, moved);
    writeWithheldSlots(store, withheld);
    if (order !== null) writeOpenOrder(store, order);
  });
}

/** What one run came to: a number given, nothing to give, or held back by a keeper being found. */
type Outcome = 'gave' | 'none' | 'finding';

export const HELD_LINE = 'freed numbers: none given while a keeper is still being found';

export function createFill(deps: FillDeps): Fill {
  /** A run is on: a run inside the change it announces has nothing to do. */
  let running = false;
  /** A refresh has worked: Open's order is known. */
  let known = false;
  /** The kind of the last failed write, so that a failure that repeats is logged once; cleared by
   *  a run that gives a number or has none to give. */
  let failure: string | null = null;
  /** A run was held back by a keeper being found and said so (once, until a run gives or has
   *  nothing to give). */
  let held = false;

  const give = (): Outcome => {
    // Cheap first: nothing is built while no number is free or no program may take one.
    if (deps.registry.nextSlot() === null) return 'none';
    const terminals = deps.registry.list();
    if (!terminals.some((one) => one.slot === null && MAY_START.has(one.state))) return 'none';
    const input = deps.input();
    if (input === null) return 'none';
    const waiting = waitingTerminals(input);
    if (waiting.length === 0) return 'none';
    const kept = deps.openOrder.ids().length > 0;
    let gave = false;
    const outcome = deps.registry.giveSlots(waiting, (moved, withheld, given) => {
      const order = kept ? orderAfterFill(input, given) : null;
      deps.persist(moved, withheld, order);
      if (order !== null) deps.openOrder.adopt(order); // after the write: they cannot part
      gave = true;
    });
    if (outcome === 'finding') return 'finding';
    return gave ? 'gave' : 'none';
  };

  const fill: Fill = {
    run() {
      if (!known || running || deps.stopping()) return;
      running = true;
      try {
        const outcome = give();
        if (outcome === 'finding') {
          if (!held) {
            held = true;
            deps.log(HELD_LINE);
          }
          return;
        }
        held = false;
        failure = null;
        if (outcome === 'gave') deps.remember?.();
      } catch (error) {
        const kind = isBusy(error) ? 'the database is busy' : failureKind(error);
        if (failure !== kind) {
          failure = kind;
          deps.log(`freed numbers: a free number was not given (${kind})`);
        }
      } finally {
        running = false;
      }
    },
    refreshed() {
      known = true;
      fill.run();
    },
  };
  return fill;
}
