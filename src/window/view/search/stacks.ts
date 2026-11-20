/**
 * Blocks (S2 12.2, plan E6 as ruled 2026-11-16, follow-up F9; the code calls a block a stack): in
 * every section — Open, Recent, Earlier —, each on its own, the rows of one group sit together,
 * open unless the page closed the block. An open block is drawn as a card of its rows; a closed one
 * as its caption alone, none of its rows drawn (F9). Pure.
 *
 * Which rows reach this rule is the caller's (`build.ts`): a section's rows (under chips alone the
 * rows they leave, F35), and none during a typed search (S2 12.8: a word flattens every block; the
 * caller then gives every row `stack: null`).
 * A view without `closed` closes nothing: the page and the server are one build, and an open block
 * hides no row.
 *
 * Imports (plan 2.1): types only, from `protocol.ts`.
 */
import type {
  ClosedBlock,
  ClosedStackPayload,
  SectionPayload,
  StackPayload,
} from '../../protocol.ts';

export interface StackEntry {
  readonly id: string;
  readonly group: string | null;
  /** The row needs you (its `attention` is not null, stage B): a closed block counts it (G5). */
  readonly needsYou: boolean;
  /** The row is drawn with a terminal of the window that has not reported a session (S2 7.5: a
   *  start, or a program that ended before it reported): a closed block that holds it is drawn
   *  open, so that the row, and its slot, are on screen (ruled 2026-11-16, review 2 of F3: (c2);
   *  since F9 its first row too, which a closed block hides as well). */
  readonly unreported: boolean;
}

/**
 * E6 for the rows of one section, in the section's order. Returns `rows`, the rows to draw, in
 * order — every row that is in no block, at its place; each OPEN block at the place of its first
 * row, the head, and right after it its other rows in the section's order —, and `closed`, the
 * section's closed blocks in its order, each with the place of its caption (`at`: the number of
 * rows drawn before it). A closed block draws none of its rows (F9). A group with one row is no
 * block. `stack` is null for a row in no block.
 *
 * Every row of a group belongs to its block, one that a terminal of the window holds or that needs
 * you too (G2). A block is open unless `closed` holds an entry of `section` with its group; and it
 * is open, whatever `closed` says, while the selected session is ANY of its rows (G5, F9's K5: the
 * page then forgets that it closed it, so that the selection is never on a row the list does not
 * show, however it got there) or while any of its rows is `unreported` (its terminal has not
 * reported a session, so its slot names none: the row stays on screen). A closed block's `needYou`
 * counts its rows that need you — all of them are hidden.
 *
 * `closed` is `view.closed` as it comes: absent or empty, every block is open. Groups are compared
 * as the text the entries carry (the row's group is sanitised when step 1's list model is built).
 * The rule keeps no state: a block stays closed only while the page names it.
 */
export function stackRows<T extends StackEntry>(
  rows: readonly T[],
  section: SectionPayload['name'],
  closed: readonly ClosedBlock[] | undefined,
  selected: string | null,
): { rows: { entry: T; stack: StackPayload | null }[]; closed: ClosedStackPayload[] } {
  const shut = new Set<string>();
  for (const one of closed ?? []) {
    if (one.section === section) {
      shut.add(one.group);
    }
  }

  // Each group's rows, in the section's order, and the place of the first.
  const kin = new Map<string, { headAt: number; rows: T[] }>();
  for (const [index, row] of rows.entries()) {
    if (row.group === null) {
      continue;
    }
    const known = kin.get(row.group);
    if (known === undefined) {
      kin.set(row.group, { headAt: index, rows: [row] });
    } else {
      known.rows.push(row);
    }
  }

  const drawn: { entry: T; stack: StackPayload | null }[] = [];
  const captions: ClosedStackPayload[] = [];
  for (const [index, row] of rows.entries()) {
    const group = row.group;
    const block = group === null ? undefined : kin.get(group);
    if (group === null || block === undefined || block.rows.length < 2) {
      drawn.push({ entry: row, stack: null });
      continue;
    }
    if (index !== block.headAt) {
      continue; // a later row: drawn right after the first while the block is open, else left out
    }
    const isOpen =
      !shut.has(group) || block.rows.some((one) => one.id === selected || one.unreported);
    if (!isOpen) {
      captions.push({
        group,
        size: block.rows.length,
        needYou: block.rows.filter((one) => one.needsYou).length,
        head: row.id,
        at: drawn.length,
      });
      continue;
    }
    const payload = (role: StackPayload['role']): StackPayload => ({
      group,
      size: block.rows.length,
      role,
      head: row.id,
    });
    drawn.push({ entry: row, stack: payload('head') });
    for (const member of block.rows.slice(1)) {
      drawn.push({ entry: member, stack: payload('member') });
    }
  }
  return { rows: drawn, closed: captions };
}
