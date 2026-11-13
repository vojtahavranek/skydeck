// Which session the user means by `<ref>` (design 7.5).
import { RefError } from '../platform/errors.ts';
import { sanitize } from '../text/sanitize.ts';
import { isListed } from './list.ts';
import type { ListRow } from './list.ts';

/** A prefix shorter than this is too likely to name several sessions to be searched at all. */
const MIN_PREFIX_LENGTH = 4;

/**
 * 7.5 <ref>: (1) a row whose id equals ref (lowercased); (2) if ref has ≥ 4 characters, rows whose
 * id starts with it (lowercased), among all rows; (3) rows whose label equals ref, among the rows
 * `isListed(row, true)` accepts (D22: done ones included). The first step with ≥ 1 match decides:
 * exactly one → it; several → RefError "'<ref>' matches <n> sessions" with candidates, in the order
 * of `rows`; none at all → RefError "no session matches '<ref>'".
 *
 * The text typed is only compared, never passed on: what is returned is a row, and its id is the
 * stored one (a lowercase UUID, see `isSessionId`). The text is sanitised where a message repeats it.
 */
export function resolveRef(ref: string, rows: readonly ListRow[]): ListRow {
  const lowered = ref.toLowerCase();
  const steps: (() => ListRow[])[] = [
    () => rows.filter((row) => row.id === lowered),
    () => (ref.length < MIN_PREFIX_LENGTH ? [] : rows.filter((row) => row.id.startsWith(lowered))),
    () => rows.filter((row) => row.label === ref && isListed(row, true)),
  ];
  for (const step of steps) {
    const matches = step();
    const [first] = matches;
    if (first === undefined) {
      continue;
    }
    if (matches.length === 1) {
      return first;
    }
    throw new RefError(
      `'${sanitize(ref)}' matches ${matches.length} sessions`,
      matches.map((row) => ({ id: row.id, title: row.title })),
    );
  }
  throw new RefError(`no session matches '${sanitize(ref)}'`, []);
}
