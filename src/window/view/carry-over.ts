/**
 * Follow-up F40 (design 7.1, S2 12.6): the parts of the offer to carry fields over after `/clear`,
 * as a pure function over the list's rows and three lookups the server gives it. It reads and
 * compares fields of rows and nothing else, so it throws for no row data; it imports no value
 * (the hash of `rev` and the cleaning of a label or a group at the write are
 * `src/window/carry-over.ts`'s).
 */
import type { ListRow } from '../../sessions/list.ts';
import type { CarryField, CarryOverPayload } from '../protocol.ts';

/** The five fields, in the order the bar lists them. */
export const CARRY_FIELDS: readonly CarryField[] = ['label', 'group', 'ticket', 'note', 'prs'];

/** The ticks of the five fields and of `mark the old one done`. */
export type CarryTicks = Record<CarryField | 'done', boolean>;

/** The first offer ever: label, group, ticket and done ticked, note and pull requests not. */
export const DEFAULT_TICKS: Readonly<CarryTicks> = {
  label: true,
  group: true,
  ticket: true,
  note: false,
  prs: false,
  done: true,
};

/** How many `clear` links the walk up the chain follows at most. */
export const MAX_HOPS = 64;

/**
 * The stored ticks (`kv window_carry_over_ticks`, a JSON object of booleans), member by member: a
 * boolean is taken, anything else (no entry, no JSON, another type) is that member's default.
 */
export function readTicks(stored: string | null): CarryTicks {
  const ticks: CarryTicks = { ...DEFAULT_TICKS };
  if (stored === null) return ticks;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return ticks;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ticks;
  const members = parsed as Record<string, unknown>;
  for (const name of [...CARRY_FIELDS, 'done'] as const) {
    const value = members[name];
    if (typeof value === 'boolean') ticks[name] = value;
  }
  return ticks;
}

/** The offered fields' values, raw as the rows have them; only the offered ones are present. */
export interface CarryValues {
  label?: string;
  group?: string;
  /** The ticket's address. */
  ticket?: string;
  /** The note as stored. */
  note?: string;
  /** The urls of the pull requests the new session lacks. */
  prs?: string[];
}

export interface CarryParts {
  /** The old session: the one the walk found. */
  fromId: string;
  payload: Omit<CarryOverPayload, 'rev'>;
  values: CarryValues;
}

export interface CarryInput {
  /** The new session's row. */
  to: ListRow;
  rowOf(id: string): ListRow | undefined;
  /** The session the `clear` link of `id` comes from, when it counts (the mark), else null. */
  clearedFrom(id: string): string | null;
  /** The session has a pull request of origin `manual` that is not detached. Asked only for a
   *  session whose only field is pull requests. */
  byHand(id: string): boolean;
  /** A resume lock of the session is held. */
  resuming(id: string): boolean;
  /** The starting ticks (readTicks). */
  ticks: CarryTicks;
}

/** A note holding more than white space. */
function noteSet(note: string | null): note is string {
  return note !== null && note.trim() !== '';
}

/**
 * For the walk only (ruled 2026-11-22): the row has a field THE USER set — a label, a stored
 * group, a ticket, a note, or a pull request attached by hand and not detached. `byHand` is asked
 * last, so only for a session whose only field is pull requests.
 */
function userSet(row: ListRow, byHand: (id: string) => boolean): boolean {
  return (
    row.label !== null ||
    row.groupSource === 'meta' ||
    row.ticket !== null ||
    noteSet(row.note) ||
    (row.prs.length > 0 && byHand(row.id))
  );
}

/** The old session's field `name` is set: what the offer of the session found lists. */
function has(row: ListRow, name: CarryField): boolean {
  switch (name) {
    case 'label':
      return row.label !== null;
    case 'group':
      return row.groupSource === 'meta';
    case 'ticket':
      return row.ticket !== null;
    case 'note':
      return noteSet(row.note);
    case 'prs':
      return row.prs.length > 0;
  }
}

/**
 * The offer's parts, or null for none: the walk up the new session's `clear` links to the first
 * session with a row and a field the user set (a session without one is stepped over and left as
 * it is; a missing link, a session met twice or more than MAX_HOPS links end it with none); then,
 * of that session's fields, the ones the new session has already (kept: a label, a stored group,
 * a ticket, a stored note, every pull request) and the ones it may take (offered); none offered is
 * no offer. `mark the old one done` is offered while the old session is not running, not done
 * and not being resumed.
 */
export function carryOffer(input: CarryInput): CarryParts | null {
  const { to } = input;
  const seen = new Set<string>([to.id]);
  let at = to.id;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const fromId = input.clearedFrom(at);
    if (fromId === null || seen.has(fromId)) return null;
    seen.add(fromId);
    const from = input.rowOf(fromId);
    if (from !== undefined && userSet(from, input.byHand)) return partsOf(input, from);
    at = fromId;
  }
  return null;
}

function partsOf(input: CarryInput, from: ListRow): CarryParts | null {
  const { to, ticks } = input;
  const present = new Set(to.prs.map((pr) => pr.url));
  const toAdd = from.prs.map((pr) => pr.url).filter((url) => !present.has(url));
  const keptHere: Record<CarryField, boolean> = {
    label: to.label !== null,
    group: to.groupSource === 'meta',
    ticket: to.ticket !== null,
    note: to.note !== null,
    prs: toAdd.length === 0,
  };
  const fields: CarryOverPayload['fields'] = [];
  const kept: CarryField[] = [];
  const values: CarryValues = {};
  for (const name of CARRY_FIELDS) {
    if (!has(from, name)) continue;
    if (keptHere[name]) {
      kept.push(name);
      continue;
    }
    fields.push({ name, text: textOf(from, name), ticked: ticks[name] });
    switch (name) {
      case 'label':
        values.label = from.label ?? '';
        break;
      case 'group':
        values.group = from.group ?? '';
        break;
      case 'ticket':
        values.ticket = from.ticket?.url ?? '';
        break;
      case 'note':
        values.note = from.note ?? '';
        break;
      case 'prs':
        values.prs = toAdd;
        break;
    }
  }
  if (fields.length === 0) return null;
  const doneOffered = from.state === 'not-running' && !from.done && !input.resuming(from.id);
  return {
    fromId: from.id,
    payload: {
      from: { id: from.id, title: from.title, ticket: from.ticket?.text ?? null },
      fields,
      prs: values.prs?.length ?? 0,
      kept,
      done: doneOffered ? { ticked: ticks.done } : null,
    },
    values,
  };
}

/** The bar's text of an offered field: the label, the group, the ticket's short name. */
function textOf(row: ListRow, name: CarryField): string | null {
  switch (name) {
    case 'label':
      return row.label;
    case 'group':
      return row.group;
    case 'ticket':
      return row.ticket?.text ?? null;
    case 'note':
    case 'prs':
      return null;
  }
}
