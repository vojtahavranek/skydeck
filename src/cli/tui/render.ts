// The interactive list as lines of text (design 7.4): a title line, a body, a last line. Pure; the
// terminal wrapper paints what this returns. No escape sequences: the strings of a `ListRow` were
// sanitised when the list model was built, and everything the user or the wrapper can put into the
// model on its own (the filter, the input, the message, the note) is sanitised here.
import { isoFromNs } from '../../platform/time.ts';
import type { ListRow } from '../../sessions/list.ts';
import { sanitize } from '../../text/sanitize.ts';
import { clip } from '../clip.ts';
import { formatNoteLines, formatPrLine, formatRow, stateDetailSuffix } from '../row.ts';
import { visibleRows } from './model.ts';
import type { TuiModel } from './model.ts';

const HELP =
  'j/k move  enter detail  l label  g group  n note  d done  p PR  R resume  / filter  a all  r refresh  q quit';
const MARK_SELECTED = '> ';
const MARK_OTHER = '  ';
const CURSOR = '_';
const ELLIPSIS = '…';
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/** The states in the order the list puts them inside a group (design 7.4). */
const STATES: readonly ListRow['state'][] = ['waiting', 'working', 'running', 'not-running'];

/**
 * The program, how many rows are visible, the filter and "(all)", then how many of the rows are in
 * each state (fix 4: with the order kept between refreshes, a session that starts waiting can be
 * out of view; this line still shows it). The counts come last, so that on a narrow terminal they
 * are what is cut, not the filter or "(all)".
 */
function titleLine(model: TuiModel): string {
  const visible = visibleRows(model);
  const counts = STATES.flatMap((state) => {
    const count = visible.filter((row) => row.state === state).length;
    return count === 0 ? [] : [`${count} ${state}`];
  });
  const filter = model.filter === '' ? '' : `  filter: ${sanitize(model.filter)}`;
  const all = model.showAll ? '  (all)' : '';
  const states = counts.length === 0 ? '' : `  ${counts.join(' · ')}`;
  return `skydeck  ${visible.length} sessions${filter}${all}${states}`;
}

/** The end of `text` that is at most `units` UTF-16 units long and does not start inside a surrogate pair. */
function endOf(text: string, units: number): string {
  let start = Math.max(0, text.length - units);
  const first = text.charCodeAt(start);
  if (start > 0 && first >= LOW_SURROGATE_FIRST && first <= LOW_SURROGATE_LAST) {
    start += 1;
  }
  return text.slice(start);
}

/**
 * `<prefix><text>_`. When it is longer than `columns` the start of the text gives way to an
 * ellipsis, so that the end of it and the cursor, where the user is typing, stay in view.
 */
function typingLine(prefix: string, rawText: string, columns: number): string {
  const text = sanitize(rawText);
  const line = `${prefix}${text}${CURSOR}`;
  const room = columns - prefix.length - ELLIPSIS.length - CURSOR.length;
  if (line.length <= columns || room < 0) {
    return line;
  }
  return `${prefix}${ELLIPSIS}${endOf(text, room)}${CURSOR}`;
}

function lastLine(model: TuiModel, columns: number): string {
  if (model.mode === 'input' && model.input !== null) {
    return typingLine(`${model.input.purpose}: `, model.input.text, columns);
  }
  if (model.mode === 'filter') {
    return typingLine('/', model.filter, columns);
  }
  return model.message === null ? HELP : sanitize(model.message);
}

/** What the list shows, one entry per line, before any row is formatted. */
type Entry = { kind: 'group'; name: string } | { kind: 'row'; row: ListRow };

interface Layout {
  entries: Entry[];
  selectedAt: number; // index in `entries` of the selected row, -1 for none
}

/** The groups that have a visible row: the name, then its rows. */
function listLayout(model: TuiModel): Layout {
  const visible = new Set(visibleRows(model).map((row) => row.id));
  const entries: Entry[] = [];
  let selectedAt = -1;
  for (const group of model.order) {
    const rows = group.ids.flatMap((id) => {
      const row = model.rows.get(id);
      return visible.has(id) && row !== undefined ? [row] : [];
    });
    if (rows.length === 0) {
      continue;
    }
    entries.push({ kind: 'group', name: group.name ?? 'no group' });
    for (const row of rows) {
      if (row.id === model.selected) {
        selectedAt = entries.length;
      }
      entries.push({ kind: 'row', row });
    }
  }
  return { entries, selectedAt };
}

/**
 * The first body line shown: `hint` (made a valid one), moved by the least that brings the
 * selected row into view, and its group header with it when it is the first row of its group. The
 * row wins when there is room for only one line.
 */
function windowStart(layout: Layout, height: number, hint: number): number {
  const last = Math.max(0, layout.entries.length - height);
  const wanted = Number.isFinite(hint) ? Math.floor(hint) : 0;
  let start = Math.min(last, Math.max(0, wanted));
  const at = layout.selectedAt;
  if (at < 0 || height <= 0) {
    return start;
  }
  const top = layout.entries[at - 1]?.kind === 'group' ? at - 1 : at;
  start = Math.min(start, top);
  if (at >= start + height) {
    start = at - height + 1;
  }
  return Math.min(last, Math.max(0, start));
}

function bodyHeight(size: { rows: number }): number {
  return Math.max(0, Math.floor(size.rows) - 2);
}

/**
 * The model with `scroll` moved by the least that keeps the selected row (and its group header,
 * for the first row of a group) in view on a screen of this size: one line for every row the
 * cursor moves, two when it steps onto the first row of a group from below. A scroll that is out
 * of range or leaves blank lines under a full list is made valid. The terminal wrapper calls this
 * after every key, every `withRows` (a refresh can move the selection) and every resize, so that the window does not jump; `render` uses the same rule,
 * so it also shows the selected row when the wrapper has not. The detail does not scroll.
 */
export function scrolled(model: TuiModel, size: { columns: number; rows: number }): TuiModel {
  if (model.mode === 'detail') {
    return model;
  }
  const scroll = windowStart(listLayout(model), bodyHeight(size), model.scroll);
  return scroll === model.scroll ? model : { ...model, scroll };
}

/** Groups with a visible row: the name, then the rows, the selected one marked. */
function listBody(model: TuiModel, columns: number, height: number): string[] {
  const layout = listLayout(model);
  const lines = layout.entries.map((entry, at) =>
    entry.kind === 'group'
      ? entry.name
      : (at === layout.selectedAt ? MARK_SELECTED : MARK_OTHER) +
        formatRow(entry.row, model.nowNs, columns - MARK_SELECTED.length),
  );
  if (lines.length === 0) {
    lines.push('no sessions');
  }
  const start = windowStart(layout, height, model.scroll);
  return lines.slice(start, start + height);
}

function detailBody(row: ListRow): string[] {
  const lines = [
    `title: ${row.title}`,
    `id: ${row.id}`,
    `state: ${row.state}${stateDetailSuffix(row.stateDetail)}`,
    `since: ${isoFromNs(row.sinceNs)}`,
    `dir: ${row.dir ?? '-'}`,
    `group: ${row.group ?? '-'}`,
    `marks: ${row.marks.length === 0 ? '-' : row.marks.join(',')}`,
    ...row.prs.map((pr) => `pr: ${formatPrLine(pr)}`),
  ];
  // A note that has nothing to show gets no heading, as in `show`.
  const note = row.note === null ? [] : formatNoteLines(row.note);
  if (note.length > 0) {
    lines.push('note:', ...note);
  }
  return lines;
}

/** The first `height` lines; when some are left out the last line shown is an ellipsis (with room for one line, the first). */
function cutTo(lines: string[], height: number): string[] {
  if (lines.length <= height) {
    return lines;
  }
  return height >= 2 ? [...lines.slice(0, height - 1), ELLIPSIS] : lines.slice(0, height);
}

function body(model: TuiModel, columns: number, height: number): string[] {
  const row = model.selected === null ? undefined : model.rows.get(model.selected);
  const lines =
    model.mode === 'detail' && row !== undefined
      ? cutTo(detailBody(row), height)
      : listBody(model, columns, height);
  return lines.map((line) => clip(line, columns));
}

/**
 * Exactly `size.rows` lines of at most `size.columns` characters: the title line, the body (the
 * list, or the detail of the selected row) padded with empty lines, and the last line (the input,
 * the filter, the message, or the key help). With one line there is only the last one.
 */
export function render(model: TuiModel, size: { columns: number; rows: number }): string[] {
  const columns = Math.max(0, size.columns);
  const rows = Math.max(0, size.rows);
  if (rows === 0) {
    return [];
  }
  const last = clip(lastLine(model, columns), columns);
  if (rows === 1) {
    return [last];
  }
  const height = bodyHeight(size);
  const lines = body(model, columns, height);
  while (lines.length < height) {
    lines.push('');
  }
  return [clip(titleLine(model), columns), ...lines, last];
}
