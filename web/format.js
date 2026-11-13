// The page's age format (A18): a copy of src/text/age.ts's rule (design 7.4), because the server
// sends times, not ages (S2 8.2.3). test/web/format.test.ts runs both over one table of durations.
// Pure: no DOM, no clock.

const NS_PER_SECOND = 1_000_000_000n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;
const SECONDS_PER_DAY = 86_400n;

/** A time of the protocol: integer nanoseconds as a decimal string (S2 8.2.3). */
const DECIMAL_TIME = /^-?[0-9]+$/;

/**
 * Design 7.4's compact age of a duration in ns (negative counts as 0): < 60 s → "<n>s";
 * < 60 min → "<n>m"; < 48 h → "<n>h"; otherwise "<n>d". Always rounded down.
 * @param {bigint} durationNs
 * @returns {string}
 */
export function formatAge(durationNs) {
  const seconds = durationNs <= 0n ? 0n : durationNs / NS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  if (seconds < SECONDS_PER_HOUR) {
    return `${seconds / SECONDS_PER_MINUTE}m`;
  }
  if (seconds < 48n * SECONDS_PER_HOUR) {
    return `${seconds / SECONDS_PER_HOUR}h`;
  }
  return `${seconds / SECONDS_PER_DAY}d`;
}

/**
 * The age between two times of the protocol (decimal strings of nanoseconds), computed exactly:
 * the times lie far above 2^53. A `thenNs` after `nowNs` counts as 0. Anything that is not two
 * integer times — an empty, null or malformed value — gives an empty string: one bad value must
 * not break the list (ruled for task 31). Never throws.
 * @param {string | null | undefined} nowNs
 * @param {string | null | undefined} thenNs
 * @returns {string}
 */
export function ageBetween(nowNs, thenNs) {
  const now = parseTime(nowNs);
  const then = parseTime(thenNs);
  return now === null || then === null ? '' : formatAge(now - then);
}

/**
 * `BigInt` alone would also take "", " 1 " and "0x10", and throw on "1.5"; a time of the
 * protocol is an integer in decimal digits.
 * @param {unknown} value
 * @returns {bigint | null}
 */
function parseTime(value) {
  return typeof value === 'string' && DECIMAL_TIME.test(value) ? BigInt(value) : null;
}
