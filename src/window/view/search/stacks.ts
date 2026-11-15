/**
 * Stacks (S2 12.2, plan E6): in This week and in Earlier, each on its own, the rows of one group
 * stack under the newest. Pure; imports nothing.
 *
 * Which rows reach this rule is the caller's (`build.ts`, task 96): only This week's and Earlier's
 * (running sessions never stack), and none while filtering (S2 12.8: a filter flattens every
 * stack; the caller then gives every row `stack: null`). A view without `opened` is this rule's own
 * (ruled by the plan owner): `view.opened` is passed as it comes, and `undefined` gives no stacks
 * at all, so that a page which cannot draw stacks never has a session hidden in one.
 */

/** RowPayload.stack (E6; task 96 moves this type into protocol.ts, unchanged). */
export interface StackPayload {
  /** The group the stack is of (the rows' group, as sanitised). */
  group: string;
  /** Its rows, the head included: at least 2. */
  size: number;
  /** E6: `opened` names the group, or a member other than the head is selected. */
  open: boolean;
  role: 'head' | 'member';
  /** The head's session id. */
  head: string;
}

export interface StackEntry {
  readonly id: string;
  readonly group: string | null;
  /** E6: a terminal of the window holds the row (its `terminal` is not null), or it needs you
   *  (its `attention` is not null, stage B): it never stacks. */
  readonly held: boolean;
}

/**
 * E6 for the rows of one section (This week or Earlier), in the section's order (most recent
 * first). Returns the rows to draw, in order: every row that is in no stack, at its place; each
 * head at its own place (the first of its group's rows that are not held); right after an open
 * stack's head, its other members in their order; a closed stack's other members left out. A
 * group with one row that is not held is no stack. `stack` is null for a row in no stack.
 *
 * `opened` is `view.opened` as it comes (ruled by the plan owner): `undefined` (a page that cannot
 * draw stacks) → no stacks, every row as it is with `stack: null`; an array, an empty one too →
 * stacks, those of the groups it names open.
 *
 * Groups are compared as the text the entries carry (the row's group is sanitised when step 1's
 * list model is built). The rule keeps no state: a stack stays open after the selection left it
 * only because the page has added its group to `opened` (ruled).
 */
export function stackRows<T extends StackEntry>(
  rows: readonly T[],
  opened: readonly string[] | undefined,
  selected: string | null,
): { entry: T; stack: StackPayload | null }[] {
  if (opened === undefined) {
    return rows.map((entry) => ({ entry, stack: null }));
  }
  const open = new Set(opened);

  // Each group's rows that are not held, in the section's order, and the place of the first.
  const kin = new Map<string, { headAt: number; rows: T[] }>();
  for (const [index, row] of rows.entries()) {
    if (row.group === null || row.held) {
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
  for (const [index, row] of rows.entries()) {
    const group = row.held ? null : row.group;
    const stack = group === null ? undefined : kin.get(group);
    if (group === null || stack === undefined || stack.rows.length < 2) {
      drawn.push({ entry: row, stack: null });
      continue;
    }
    if (index !== stack.headAt) {
      // A member: drawn right after its head when the stack is open, else left out.
      continue;
    }
    const members = stack.rows.slice(1);
    const isOpen = open.has(group) || members.some((member) => member.id === selected);
    const payload = (role: StackPayload['role']): StackPayload => ({
      group,
      size: stack.rows.length,
      open: isOpen,
      role,
      head: row.id,
    });
    drawn.push({ entry: row, stack: payload('head') });
    if (isOpen) {
      for (const member of members) {
        drawn.push({ entry: member, stack: payload('member') });
      }
    }
  }
  return drawn;
}
