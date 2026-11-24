/**
 * Issue #189 (S2 7.6, 12.1): no number 1–9 stays free while a terminal of the window whose program
 * may run waits for one. The first terminal on a row of Open that has no number, in Open's order as
 * the server draws it (`openRows`: done ones shown, every block open), takes the lowest free number,
 * the next one the next, until no number is free or none waits; a terminal that has a number keeps
 * it. A terminal on no row of Open (its twin of the window has the row, or its row is under Recent)
 * waits until it has one.
 *
 * The row of a terminal that got a number goes to its number's place, exactly as a new terminal with
 * that number is placed (view/open-sequence.ts's rule), with and without a kept order, so that the
 * numbers keep following Open's order and no later move renumbers a terminal because of the fill.
 * Without a kept order Open is computed by number and nothing but the numbers is written; with one,
 * the new kept order is written with the numbers in one store transaction, as a move's, and adopted.
 *
 * The registry gives the numbers (`giveSlots`): the free ones by its one rule (`takenSlots`), only
 * to a terminal whose program may run, never to one whose number was freed (F43), and none while a
 * keeper is still being found, whose number is known only at its hello. A write that fails gives
 * nothing: it is logged once by kind and the next run tries again.
 *
 * WHEN it runs is the server's, in one place (server.ts, `fillFreedNumbers`): at every change of
 * the registry — so at each moment a number becomes free (an exit applied, a hello that says the
 * program exited, a lost terminal's program that may no longer run, the close of a lost terminal
 * that still held one) — and after every refresh that worked (the first after the start, a write
 * that failed, the end of a keeper's finding).
 */
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';
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
 * Open's kept order once the terminals of `given` hold their numbers: the order a freeze would keep
 * now (`keptNow`) without the rows of those terminals, which are then placed as rows not kept yet
 * are — a terminal with number k after the last window terminal with a lower number, before the
 * next with a higher one (view/open-sequence.ts) —, every other row at its place. A block such a
 * row heads goes with it; one it is in but does not head stays where it is.
 */
export function orderAfterFill(input: FillInput, given: ReadonlyMap<string, number>): string[] {
  const placed = new Set(
    openRows(input, true).flatMap((row) =>
      row.terminal !== null && given.has(row.terminal) ? [row.id] : [],
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
   *  terminals, the kept order), or null before the first refresh that worked: Open's order is not
   *  known yet. */
  input: () => FillInput | null;
  /** Open's kept order: whether one is kept, and the fill's order adopted once it is written. */
  openOrder: Pick<OpenOrder, 'ids' | 'adopt'>;
  /** Writes the moved numbers and, when an order is kept, Open's new kept order (null: none is),
   *  both or neither; a throw: nothing written. */
  persist: (moved: ReadonlyMap<string, number | null>, order: readonly string[] | null) => void;
  /** After a fill that gave a number: the restore's memory takes Open's order; it never throws.
   *  Absent: nothing is remembered. */
  remember?: () => void;
  log: (line: string) => void;
  /** The server's stop began: nothing is given from then on. */
  stopping: () => boolean;
}

export interface Fill {
  /** Gives the free numbers to the terminals that wait (the module's rule). Never throws. */
  run(): void;
}

export function createFill(deps: FillDeps): Fill {
  /** A run is on: a run inside the change it announces has nothing to do. */
  let running = false;
  /** The kind of the last failed write, so that a failure that repeats is logged once. */
  let failure: string | null = null;
  return {
    run() {
      if (running || deps.stopping()) return;
      running = true;
      try {
        // Cheap first: nothing is built while no number is free or no program may take one.
        if (deps.registry.nextSlot() === null) return;
        const terminals = deps.registry.list();
        if (!terminals.some((one) => one.slot === null && MAY_START.has(one.state))) return;
        const input = deps.input();
        if (input === null) return;
        const waiting = waitingTerminals(input);
        if (waiting.length === 0) return;
        const kept = deps.openOrder.ids().length > 0;
        let gave = false;
        deps.registry.giveSlots(waiting, (moved, given) => {
          const order = kept ? orderAfterFill(input, given) : null;
          deps.persist(moved, order);
          if (order !== null) deps.openOrder.adopt(order); // after the write: they cannot part
          gave = true;
        });
        if (gave) {
          failure = null;
          deps.remember?.();
        }
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
  };
}
