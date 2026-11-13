import type { Ns } from './types.ts';

export const NS_PER_MS = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;
export const NS_PER_MINUTE = 60n * NS_PER_SECOND;
export const NS_PER_DAY = 86_400n * NS_PER_SECOND;

/** The longest wait a Node.js timer keeps: 2^31 − 1 ms (a longer one fires at once). */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * "2026-11-12T14:03:05.123Z" (UTC, milliseconds, truncated). Throws RangeError for a time outside
 * what `Date` can show (about ±275,760 years): whoever turns foreign numbers into `Ns` bounds them.
 */
export function isoFromNs(ns: Ns): string {
  return new Date(Number(ns / NS_PER_MS)).toISOString();
}

/** Epoch milliseconds (integer number) to Ns. Throws RangeError for a number that is not an integer. */
export function nsFromMs(ms: number): Ns {
  return BigInt(ms) * NS_PER_MS;
}

/** An ISO 8601 date-time with seconds optional, and a `Z` or `±hh:mm` ending. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO 8601 timestamp (as in transcripts); null when it is not one or `Date.parse`
 * rejects its values. A time without `Z` or an offset is refused, as is any other text `Date.parse`
 * would guess at: either would make the result depend on the machine's time zone or on V8.
 */
export function nsFromIso(iso: string): Ns | null {
  if (!ISO_TIMESTAMP.test(iso)) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : nsFromMs(ms);
}
