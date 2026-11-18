// The interactive list as data and one pure function (design 7.4): a model, `reduce(model, key)`
// that gives the next model and what the terminal wrapper must do about it, and the helpers that
// feed it new rows. No terminal, no clock, no files.
import type { Ns } from '../../platform/types.ts';
import { buildList, isListed, matchesFilter } from '../../sessions/list.ts';
import type { ListRow } from '../../sessions/list.ts';
import { sanitize } from '../../text/sanitize.ts';

export type TuiMode = 'list' | 'detail' | 'filter' | 'input';
export interface TuiInput {
  purpose: 'label' | 'group' | 'ticket' | 'pr';
  text: string;
}

export interface TuiModel {
  rows: ReadonlyMap<string, ListRow>; // every row by id
  order: { name: string | null; ids: string[] }[]; // fixed at open, on 'r' and on 'a'
  showAll: boolean;
  filter: string;
  mode: TuiMode;
  input: TuiInput | null;
  selected: string | null; // id under the cursor
  scroll: number; // first body line shown; `render` keeps it while the selected line is in view, else moves it by the least that brings it into view (as `scrolled` does); `reduce` never writes it
  message: string | null; // cleared by the next key
  nowNs: Ns;
}

export type TuiEffect =
  | { kind: 'none' }
  | { kind: 'quit' }
  | { kind: 'refresh' }
  | { kind: 'label'; id: string; text: string } // text '' clears
  | { kind: 'group'; id: string; text: string }
  | { kind: 'ticket'; id: string; text: string } // F18: a link or a key; '' removes it
  | { kind: 'note'; id: string }
  | { kind: 'done'; id: string; done: boolean } // done false = undo
  | { kind: 'pr-add'; id: string; url: string }
  | { kind: 'pr-rm'; id: string; url: string }
  | { kind: 'resume'; id: string };

interface Step {
  model: TuiModel;
  effect: TuiEffect;
}

const NONE: TuiEffect = { kind: 'none' };

/**
 * Every row that could ever be shown, grouped and ordered as in 7.4: the done ones are in it, so
 * that `a` shows them where they belong. The groups are ranked by the members that are listed
 * under `showAll` (7.4: "the most recent activity of a listed member"), as `skydeck ls` ranks
 * them; a group of which nothing is listed comes after those, and "no group" is last.
 */
function orderOf(rows: readonly ListRow[], nowNs: Ns, showAll: boolean): TuiModel['order'] {
  const everything = buildList(rows, { showAll: true, filter: '', nowNs }).groups;
  const rank = new Map<string | null, number>();
  buildList(rows, { showAll, filter: '', nowNs }).groups.forEach((group, at) => {
    rank.set(group.name, at);
  });
  const named = everything.filter((group) => group.name !== null);
  const ranked = (group: { name: string | null }): number => rank.get(group.name) ?? Infinity;
  return [
    ...named.filter((group) => rank.has(group.name)).sort((a, b) => ranked(a) - ranked(b)),
    ...named.filter((group) => !rank.has(group.name)),
    ...everything.filter((group) => group.name === null),
  ].map((group) => ({ name: group.name, ids: group.rows.map((row) => row.id) }));
}

/** Rows of `order` that are listed (showAll) and match the filter, in order. */
export function visibleRows(model: TuiModel): ListRow[] {
  const visible: ListRow[] = [];
  for (const group of model.order) {
    for (const id of group.ids) {
      const row = model.rows.get(id);
      if (row !== undefined && isListed(row, model.showAll) && matchesFilter(row, model.filter)) {
        visible.push(row);
      }
    }
  }
  return visible;
}

/**
 * Keeps the selection on a visible row. When the selected row is not visible any more the cursor
 * goes to the row that takes its place: given `before` (the model the row was visible in), the
 * first row after it in `before`'s visible order that is still visible, else the nearest one
 * before it; without `before`, or when none of those is left, the first visible row (or nowhere).
 * Whatever was open on the old row — the detail, or an input about to be applied to it — is
 * closed, so that nothing is ever applied to a row the user did not choose. A filter being typed
 * stays open: the cursor follows what it matches.
 */
function settle(model: TuiModel, before?: TuiModel): TuiModel {
  const visible = visibleRows(model);
  const shown = new Set(visible.map((row) => row.id));
  if (model.selected !== null && shown.has(model.selected)) {
    return model;
  }
  const closes = model.mode === 'detail' || model.mode === 'input';
  return {
    ...model,
    selected: successor(before, model.selected, shown) ?? visible[0]?.id ?? null,
    mode: closes ? 'list' : model.mode,
    input: closes ? null : model.input,
  };
}

/** The row that takes the place of `gone` in `before`'s visible order, among the ids in `shown`. */
function successor(
  before: TuiModel | undefined,
  gone: string | null,
  shown: ReadonlySet<string>,
): string | null {
  if (before === undefined || gone === null) {
    return null;
  }
  const old = visibleRows(before).map((row) => row.id);
  const at = old.indexOf(gone);
  if (at < 0) {
    return null;
  }
  const after = old.slice(at + 1).find((id) => shown.has(id));
  return after ?? old.slice(0, at).findLast((id) => shown.has(id)) ?? null;
}

export function initModel(rows: readonly ListRow[], nowNs: Ns): TuiModel {
  return settle({
    rows: new Map(rows.map((row) => [row.id, row])),
    order: orderOf(rows, nowNs, false),
    showAll: false,
    filter: '',
    mode: 'list',
    input: null,
    selected: null,
    scroll: 0,
    message: null,
    nowNs,
  });
}

/**
 * The old order kept where it still holds: a row that is gone, or no longer listed at all, leaves
 * it. A row that is new, or whose group changed, goes to the end of its group, several in the
 * order `fresh` gives them; a group that did not exist goes after the named ones and before "no
 * group" (7.4: it is last); a group left empty is dropped.
 */
function keepOrder(old: TuiModel['order'], fresh: TuiModel['order']): TuiModel['order'] {
  const groupOf = new Map<string, string | null>();
  for (const group of fresh) {
    for (const id of group.ids) {
      groupOf.set(id, group.name);
    }
  }
  const placed = new Set<string>();
  const order = old.map((group) => {
    const ids = group.ids.filter((id) => groupOf.has(id) && groupOf.get(id) === group.name);
    for (const id of ids) {
      placed.add(id);
    }
    return { name: group.name, ids };
  });
  for (const group of fresh) {
    for (const id of group.ids) {
      if (placed.has(id)) {
        continue;
      }
      let target = order.find((candidate) => candidate.name === group.name);
      if (target === undefined) {
        target = { name: group.name, ids: [] };
        // "No group" is last (7.4): a new named group goes in front of it.
        const noGroup = order.findIndex((candidate) => candidate.name === null);
        order.splice(group.name !== null && noGroup >= 0 ? noGroup : order.length, 0, target);
      }
      target.ids.push(id);
    }
  }
  return order.filter((group) => group.ids.length > 0);
}

/**
 * New rows for the model. `reorder` true: `order` is computed again with `buildList`. False: the
 * order is kept (it does not change under the cursor) and only adjusted for rows that appeared,
 * went away, are no longer listed at all, or changed group. The filter, `showAll` and the message
 * stay, and so does the selection, unless its row is not visible any more: then the cursor goes
 * to the row that takes its place — the next row after it in the order shown before that is still
 * visible, else the nearest one before it, else the first visible row (ruled in fix 4: a key
 * pressed next must not act on a row far from the one the user chose) — and a detail or an input
 * that was open on the old row is closed (`mode` is 'list' afterwards), so that the caller must
 * not assume the mode survives.
 */
export function withRows(
  model: TuiModel,
  rows: readonly ListRow[],
  nowNs: Ns,
  reorder: boolean,
): TuiModel {
  const fresh = orderOf(rows, nowNs, model.showAll);
  return settle(
    {
      ...model,
      rows: new Map(rows.map((row) => [row.id, row])),
      order: reorder ? fresh : keepOrder(model.order, fresh),
      nowNs,
    },
    model,
  );
}

export function withMessage(model: TuiModel, message: string | null): TuiModel {
  return { ...model, message };
}

// --- keys ------------------------------------------------------------------------------------------

/** One printable character: a single code point the sanitiser would leave as it is. */
function isPrintable(key: string): boolean {
  const first = key.codePointAt(0);
  if (first === undefined || key.length !== String.fromCodePoint(first).length) {
    return false;
  }
  return sanitize(key) === key;
}

function withoutLastCharacter(text: string): string {
  return Array.from(text).slice(0, -1).join('');
}

function selectedRow(model: TuiModel): ListRow | undefined {
  return model.selected === null ? undefined : model.rows.get(model.selected);
}

function stay(model: TuiModel): Step {
  return { model, effect: NONE };
}

function move(model: TuiModel, delta: number): Step {
  const visible = visibleRows(model);
  const at = visible.findIndex((row) => row.id === model.selected);
  const next = visible[Math.min(visible.length - 1, Math.max(0, at + delta))];
  return stay(at < 0 || next === undefined ? model : { ...model, selected: next.id });
}

/**
 * The input `l`, `g`, `t` or `p` opens. The label, the group and the ticket (F18: its address)
 * start as the user set them, so that `enter` straight away changes nothing and clearing one takes
 * a deliberate delete; a group that only `groupPattern` took from the title is not the user's and
 * starts empty. A pull-request URL starts empty.
 */
function inputFor(key: 'l' | 'g' | 't' | 'p', row: ListRow): TuiInput {
  switch (key) {
    case 'l':
      return { purpose: 'label', text: row.label ?? '' };
    case 'g':
      return { purpose: 'group', text: row.groupSource === 'meta' ? (row.group ?? '') : '' };
    case 't':
      return { purpose: 'ticket', text: row.ticket?.url ?? '' };
    case 'p':
      return { purpose: 'pr', text: '' };
  }
}

/** `l g t n d p R`, which act on the selected row in the list and in the detail alike. */
function actOnRow(model: TuiModel, key: string): Step | null {
  switch (key) {
    case 'l':
    case 'g':
    case 't':
    case 'p': {
      const row = selectedRow(model);
      if (row === undefined) {
        return stay(model);
      }
      return stay({ ...model, mode: 'input', input: inputFor(key, row) });
    }
    case 'n':
    case 'd':
    case 'R': {
      const row = selectedRow(model);
      if (row === undefined) {
        return stay(model);
      }
      const effect: TuiEffect =
        key === 'n'
          ? { kind: 'note', id: row.id }
          : key === 'd'
            ? { kind: 'done', id: row.id, done: !row.done }
            : { kind: 'resume', id: row.id };
      return { model, effect };
    }
    default:
      return null;
  }
}

function reduceList(model: TuiModel, key: string): Step {
  switch (key) {
    case 'j':
    case 'down':
      return move(model, 1);
    case 'k':
    case 'up':
      return move(model, -1);
    case 'enter':
      return stay(selectedRow(model) === undefined ? model : { ...model, mode: 'detail' });
    case '/':
      return stay({ ...model, mode: 'filter' });
    case 'a': {
      const showAll = !model.showAll;
      return stay(
        settle({
          ...model,
          showAll,
          order: orderOf([...model.rows.values()], model.nowNs, showAll),
        }),
      );
    }
    case 'r':
      return { model, effect: { kind: 'refresh' } };
    case 'q':
      return { model, effect: { kind: 'quit' } };
    default:
      return actOnRow(model, key) ?? stay(model);
  }
}

function reduceDetail(model: TuiModel, key: string): Step {
  if (key === 'escape' || key === 'enter' || key === 'q') {
    return stay({ ...model, mode: 'list' });
  }
  return actOnRow(model, key) ?? stay(model);
}

function reduceFilter(model: TuiModel, key: string): Step {
  switch (key) {
    case 'enter':
      return stay({ ...model, mode: 'list' });
    case 'escape':
      return stay(settle({ ...model, mode: 'list', filter: '' }));
    case 'backspace':
      return stay(settle({ ...model, filter: withoutLastCharacter(model.filter) }));
    default:
      return stay(isPrintable(key) ? settle({ ...model, filter: model.filter + key }) : model);
  }
}

/**
 * What `enter` in the input does: the text goes out as the effect of its purpose. Pull-request
 * text is trimmed; one that is empty, or only a dash, is not an effect (there is nothing to add
 * or remove).
 */
function finishInput(model: TuiModel, input: TuiInput): Step {
  const closed: TuiModel = { ...model, mode: 'list', input: null };
  const row = selectedRow(model);
  if (row === undefined) {
    return stay(closed);
  }
  if (input.purpose !== 'pr') {
    return { model: closed, effect: { kind: input.purpose, id: row.id, text: input.text } };
  }
  const text = input.text.trim();
  const remove = text.startsWith('-');
  const url = (remove ? text.slice(1) : text).trim();
  if (url === '') {
    return stay(closed);
  }
  return { model: closed, effect: { kind: remove ? 'pr-rm' : 'pr-add', id: row.id, url } };
}

function reduceInput(model: TuiModel, key: string): Step {
  const input = model.input;
  if (input === null) {
    return stay({ ...model, mode: 'list' });
  }
  switch (key) {
    case 'enter':
      return finishInput(model, input);
    case 'escape':
      return stay({ ...model, mode: 'list', input: null });
    case 'backspace':
      return stay({ ...model, input: { ...input, text: withoutLastCharacter(input.text) } });
    default:
      return stay(
        isPrintable(key) ? { ...model, input: { ...input, text: input.text + key } } : model,
      );
  }
}

/**
 * Key names: 'up' 'down' 'enter' 'escape' 'backspace' 'ctrl-c', or one printable character. Any
 * key clears the message; `ctrl-c` quits in every mode; with no visible row every key that acts
 * on a row gives effect `none`.
 */
export function reduce(model: TuiModel, key: string): { model: TuiModel; effect: TuiEffect } {
  const base = model.message === null ? model : { ...model, message: null };
  if (key === 'ctrl-c') {
    return { model: base, effect: { kind: 'quit' } };
  }
  switch (base.mode) {
    case 'list':
      return reduceList(base, key);
    case 'detail':
      return reduceDetail(base, key);
    case 'filter':
      return reduceFilter(base, key);
    case 'input':
      return reduceInput(base, key);
  }
}
