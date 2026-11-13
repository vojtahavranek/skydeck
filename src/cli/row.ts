// One list row, one chip and one pull request as one line of text (design 7.3, 7.4). Pure. The
// strings of a `ListRow` and of a `PrView` were sanitised when the list model was built, so they
// are printed as they are.
import type { ChipLevel } from '../github.ts';
import { isoFromNs } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type { ListRow, PrView } from '../sessions/list.ts';
import { formatAge } from '../text/age.ts';
import { clip } from './clip.ts';

const STATE_WIDTH = 11; // 'not-running', the longest state
const AGE_WIDTH = 4;
const ELLIPSIS = '…';

/** "<count>pr:<level>", e.g. "2pr:checks-failing". */
export function formatChip(chip: { level: ChipLevel; count: number }): string {
  return `${chip.count}pr:${chip.level}`;
}

/**
 * One pull request on one line (design 7.3: never "closed" when unreadable): level cant-read →
 * "<url>  can't read, last read <time or 'never'>" plus " (<error>)" when there is an error; level
 * unfetched → "<url>  not fetched" (D11); otherwise "<url>  <level>".
 */
export function formatPrLine(pr: PrView): string {
  if (pr.level === 'cant-read') {
    const lastRead = pr.okAtNs === null ? 'never' : isoFromNs(pr.okAtNs);
    const error = pr.error === null ? '' : ` (${pr.error})`;
    return `${pr.url}  can't read, last read ${lastRead}${error}`;
  }
  if (pr.level === 'unfetched') {
    return `${pr.url}  not fetched`;
  }
  return `${pr.url}  ${pr.level}`;
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

/**
 * One list row on one line: the state, the title, the time in state, then the marks, the pull
 * request chip, "note" and the short id, each after two spaces and only when there is something to
 * show. A title that makes the line longer than `width` is cut and ends with an ellipsis.
 */
export function formatRow(row: ListRow, nowNs: Ns, width: number): string {
  const head = `${row.state.padEnd(STATE_WIDTH)} `;
  const parts = [
    row.marks.join(','),
    row.chip === null ? '' : formatChip(row.chip),
    row.hasNote ? 'note' : '',
    row.shortId,
  ].filter((part) => part !== '');
  const tail = `  ${formatAge(nowNs - row.sinceNs).padStart(AGE_WIDTH)}${parts
    .map((part) => `  ${part}`)
    .join('')}`;
  return head + fitTitle(row.title, width - head.length - tail.length) + tail;
}
