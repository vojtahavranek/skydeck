// The interactive list as lines of text (design 7.4): a title line, a body, a last line. Pure; the
// terminal wrapper paints what this returns. No escape sequences: the strings of a `ListRow` were
// sanitised when the list model was built, and everything the user or the wrapper can put into the
// model on its own (the filter, the input, the message, the note) is sanitised here.
import { isoFromNs } from '../../platform/time.ts';
import type { ListRow } from '../../sessions/list.ts';
import { sanitize } from '../../text/sanitize.ts';
import { clip } from '../clip.ts';
import { formatPrLine, formatRow } from '../row.ts';
import { visibleRows } from './model.ts';
import type { TuiModel } from './model.ts';

const HELP =
  'j/k move  enter detail  l label  g group  n note  d done  p PR  R resume  / filter  a all  r refresh  q quit';
const MARK_SELECTED = '> ';
const MARK_OTHER = '  ';
const NOTE_INDENT = '  ';
const CURSOR = '_';
const ELLIPSIS = '…';
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

function titleLine(model: TuiModel): string {
  const filter = model.filter === '' ? '' : `  filter: ${sanitize(model.filter)}`;
  return `skydeck  ${visibleRows(model).length} sessions${filter}${model.showAll ? '  (all)' : ''}`;
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

/**
 * The first `height` lines of `lines` from `start`, which is `hint` while the selected line is in
 * view, else the line that puts the selected one in the middle; never past the end.
 */
function windowStart(total: number, height: number, selectedLine: number, hint: number): number {
  const last = Math.max(0, total - height);
  const wanted = Number.isFinite(hint) ? Math.floor(hint) : 0;
  const start = Math.min(last, Math.max(0, wanted));
  if (selectedLine < 0 || (selectedLine >= start && selectedLine < start + height)) {
    return start;
  }
  return Math.min(last, Math.max(0, selectedLine - Math.floor(height / 2)));
}

/** Groups with a visible row: the name, then the rows, the selected one marked. */
function listBody(model: TuiModel, columns: number, height: number): string[] {
  const visible = new Set(visibleRows(model).map((row) => row.id));
  const lines: string[] = [];
  let selectedLine = -1;
  for (const group of model.order) {
    const rows = group.ids.flatMap((id) => {
      const row = model.rows.get(id);
      return visible.has(id) && row !== undefined ? [row] : [];
    });
    if (rows.length === 0) {
      continue;
    }
    lines.push(group.name ?? 'no group');
    for (const row of rows) {
      const selected = row.id === model.selected;
      if (selected) {
        selectedLine = lines.length;
      }
      lines.push(
        (selected ? MARK_SELECTED : MARK_OTHER) +
          formatRow(row, model.nowNs, columns - MARK_SELECTED.length),
      );
    }
  }
  if (lines.length === 0) {
    lines.push('no sessions');
  }
  const start = windowStart(lines.length, height, selectedLine, model.scroll);
  return lines.slice(start, start + height);
}

/** The lines of a note: split at line breaks and each sanitised on its own, a final break ends a line. */
function noteLines(note: string): string[] {
  const lines = note.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map(sanitize);
}

function detailBody(row: ListRow): string[] {
  const detail = row.stateDetail === null || row.stateDetail === '' ? '' : ` (${row.stateDetail})`;
  const lines = [
    `title: ${row.title}`,
    `id: ${row.id}`,
    `state: ${row.state}${detail}`,
    `since: ${isoFromNs(row.sinceNs)}`,
    `dir: ${row.dir ?? '-'}`,
    `group: ${row.group ?? '-'}`,
    `marks: ${row.marks.length === 0 ? '-' : row.marks.join(',')}`,
    ...row.prs.map((pr) => `pr: ${formatPrLine(pr)}`),
  ];
  if (row.note !== null) {
    lines.push('note:', ...noteLines(row.note).map((line) => NOTE_INDENT + line));
  }
  return lines;
}

function body(model: TuiModel, columns: number, height: number): string[] {
  const row = model.selected === null ? undefined : model.rows.get(model.selected);
  const lines =
    model.mode === 'detail' && row !== undefined
      ? detailBody(row).slice(0, height)
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
  const height = rows - 2;
  const lines = body(model, columns, height);
  while (lines.length < height) {
    lines.push('');
  }
  return [clip(titleLine(model), columns), ...lines, last];
}
