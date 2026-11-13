// One list row, one chip and one pull request as one line of text (design 7.3, 7.4). Pure. The
// strings of a `ListRow` and of a `PrView` were sanitised when the list model was built, so they
// are printed as they are.
import type { ChipLevel } from '../github.ts';
import { isoFromNs } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type { ListRow, PrView } from '../sessions/list.ts';
import { formatAge } from '../text/age.ts';
import { sanitize } from '../text/sanitize.ts';
import { clip } from './clip.ts';

const STATE_WIDTH = 11; // 'not-running', the longest state
const AGE_WIDTH = 4;
const ELLIPSIS = '…';

/**
 * The state detail as the state line prints it after the state: " (<detail>)". Nothing when there
 * is none, or when it is nothing once sanitised (Claude Code can write a `waitingFor` that is only
 * control characters). `show` and the detail view of the list both print it.
 */
export function stateDetailSuffix(detail: string | null): string {
  return detail === null || detail.trim() === '' ? '' : ` (${detail})`;
}

const NOTE_INDENT = '  ';

/**
 * The lines under a `note:` heading, for `show` and for the detail view of the list alike (design
 * 7.4: a note is free multi-line text, sanitised line by line). Split at every line break, a lone
 * `\r` too (printed raw it would move the cursor, and the sanitiser would turn it into a space in
 * the middle of a line); each line sanitised on its own and indented by two spaces; a line that is
 * nothing once sanitised is empty, without trailing spaces. Empty lines at the start and the end
 * are dropped, so a note of nothing has no lines.
 */
export function formatNoteLines(note: string): string[] {
  const lines = note.split(/\r\n|\r|\n/).map((line) => {
    const clean = sanitize(line);
    return clean.trim() === '' ? '' : NOTE_INDENT + clean;
  });
  while (lines[0] === '') {
    lines.shift();
  }
  while (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

/** "<count>pr:<level>", e.g. "2pr:checks-failing". */
export function formatChip(chip: { level: ChipLevel; count: number }): string {
  return `${chip.count}pr:${chip.level}`;
}

/**
 * The status of one pull request as a line prints it after the url (design 7.3: never "closed"
 * when unreadable): level cant-read → "can't read, last read <time or 'never'>" plus " (<error>)"
 * when there is an error; level unfetched → "not fetched" (D11); otherwise the level.
 */
export function formatPrStatus(pr: PrView): string {
  if (pr.level === 'cant-read') {
    const lastRead = pr.okAtNs === null ? 'never' : isoFromNs(pr.okAtNs);
    const error = pr.error === null ? '' : ` (${pr.error})`;
    return `can't read, last read ${lastRead}${error}`;
  }
  return pr.level === 'unfetched' ? 'not fetched' : pr.level;
}

/** One pull request on one line: "<url>  <status>" (`formatPrStatus`). */
export function formatPrLine(pr: PrView): string {
  return `${pr.url}  ${formatPrStatus(pr)}`;
}

/**
 * The title cut to `budget` characters, ending with an ellipsis, with at least one title
 * character kept whatever the budget; text that fits, or that cannot be made shorter, is returned
 * as it is.
 */
function fitTitle(title: string, budget: number): string {
  if (title.length <= budget || title === '') {
    return title;
  }
  // `clip` gives nothing when there is no room, or when the first character is a surrogate pair
  // that does not fit: one whole character is kept all the same.
  const head =
    clip(title, budget - ELLIPSIS.length) || String.fromCodePoint(title.codePointAt(0) ?? 0);
  return head.length + ELLIPSIS.length >= title.length ? title : head + ELLIPSIS;
}

/** What a row shows after the title, from everything to the least that is ever dropped to. */
interface Columns {
  age: boolean;
  note: boolean;
  marks: 'all' | 'first';
  chip: 'count' | 'level';
}

/**
 * The columns after the title, most first. A row that does not fit goes down this list until the
 * title has room (`MIN_TITLE`); the short id is in every one of them, and so are the state and
 * the title.
 */
const COLUMN_STEPS: readonly Columns[] = [
  { age: true, note: true, marks: 'all', chip: 'count' },
  { age: true, note: false, marks: 'all', chip: 'count' },
  { age: false, note: false, marks: 'all', chip: 'count' },
  { age: false, note: false, marks: 'first', chip: 'count' },
  { age: false, note: false, marks: 'first', chip: 'level' },
];

/** Columns are dropped until the title has this many characters (or all of it, when it is shorter). */
const MIN_TITLE = 24;

/** "ended-unexpectedly,was-working", or "ended-unexpectedly+1" when `first`. */
function formatMarks(marks: readonly string[], form: Columns['marks']): string {
  const [first, ...rest] = marks;
  return form === 'first' && first !== undefined && rest.length > 0
    ? `${first}+${rest.length}`
    : marks.join(',');
}

/** Everything after the title: each part after two spaces. */
function tailOf(row: ListRow, nowNs: Ns, columns: Columns): string {
  const parts = [
    formatMarks(row.marks, columns.marks),
    row.chip === null
      ? ''
      : columns.chip === 'count'
        ? formatChip(row.chip)
        : `pr:${row.chip.level}`,
    columns.note && row.hasNote ? 'note' : '',
    row.shortId,
  ].filter((part) => part !== '');
  const age = columns.age ? `  ${formatAge(nowNs - row.sinceNs).padStart(AGE_WIDTH)}` : '';
  return age + parts.map((part) => `  ${part}`).join('');
}

/**
 * One list row on one line: the state, the title, the time in state, then the marks, the pull
 * request chip, "note" and the short id, each after two spaces and only when there is something to
 * show. When that is longer than `width`, columns are dropped until the title has 24 characters
 * (or all of it): the note mark, the time in state, all marks but the first (shown as "+n"), the
 * pull-request count. The state, the title and the short id always stay. A title that still does
 * not fit is cut and ends with an ellipsis.
 */
export function formatRow(row: ListRow, nowNs: Ns, width: number): string {
  const head = `${row.state.padEnd(STATE_WIDTH)} `;
  const wanted = Math.min(row.title.length, MIN_TITLE);
  let tail = '';
  let room = 0;
  for (const columns of COLUMN_STEPS) {
    tail = tailOf(row, nowNs, columns);
    room = width - head.length - tail.length;
    if (room >= wanted) {
      break;
    }
  }
  return head + fitTitle(row.title, room) + tail;
}
