// The restore banner's texts (S2 12.7; plan C task 75, C18): the heading, an entry's line, the
// Restore button's label, and the page's own form of a time — `today at 18:02`, `yesterday at
// 18:02`, `on 12 Nov at 18:02`, `on 12 Nov 2025 at 18:02` (a year other than this one) —, 24-hour,
// in the time zone the caller passes (the page passes its own, an IANA name or `UTC`), read through
// Intl.DateTimeFormat. Pure: no DOM, no clock — the caller gives its `now` in milliseconds (a time
// a Date holds, as `Date.now()` is). What is no time of the protocol gives an empty text, and a
// zone Intl does not know is UTC: neither throws.

/** @import { BannerEntryPayload, BannerPayload } from '../src/window/protocol.ts' */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A time of the protocol: integer nanoseconds as a decimal string (S2 8.2.3). */
const DECIMAL_TIME = /^-?[0-9]+$/;
const NS_PER_MS = 1_000_000n;
const MS_PER_DAY = 86_400_000;

/** @typedef {{ year: number, month: number, day: number, hour: number, minute: number }} Parts */

/** One formatter per zone (an unknown zone: UTC's). @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatterOf(timeZone) {
  const zone = typeof timeZone === 'string' ? timeZone : 'UTC';
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    const options = /** @type {const} */ ({
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    try {
      formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
    }
    formatters.set(zone, formatter);
  }
  return formatter;
}

/**
 * The calendar date and the time of day of `ms` in `timeZone`.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {Parts}
 */
function partsOf(ms, timeZone) {
  /** @type {Record<string, number>} */
  const found = {};
  for (const part of formatterOf(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') {
      found[part.type] = Number(part.value);
    }
  }
  return {
    year: found['year'] ?? 1970,
    month: found['month'] ?? 1,
    day: found['day'] ?? 1,
    // h23 gives 0–23; an engine that still says 24 for midnight is read as 0.
    hour: (found['hour'] ?? 0) % 24,
    minute: found['minute'] ?? 0,
  };
}

/**
 * Milliseconds of a time of the protocol, or null for anything else (or a time no Date holds).
 * @param {unknown} ns
 * @returns {number | null}
 */
function msOf(ns) {
  if (typeof ns !== 'string' || !DECIMAL_TIME.test(ns)) {
    return null;
  }
  const ms = Number(BigInt(ns) / NS_PER_MS);
  return Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

/**
 * @param {Parts} parts
 * @returns {string}
 */
function clock(parts) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/**
 * The days from `a`'s calendar date to `b`'s.
 * @param {Parts} a
 * @param {Parts} b
 * @returns {number}
 */
function daysBetween(a, b) {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / MS_PER_DAY,
  );
}

/**
 * C18: when `ns` was, as the banner says it, seen from `nowMs` in `timeZone`: `today at HH:MM`,
 * `yesterday at HH:MM` (the calendar day before, also across a new year), else `on D Mon at HH:MM`
 * this year and `on D Mon YYYY at HH:MM` in another. '' for what is no time of the protocol.
 * @param {string | null} ns
 * @param {number} nowMs
 * @param {string} timeZone
 * @returns {string}
 */
export function activityTime(ns, nowMs, timeZone) {
  const ms = msOf(ns);
  if (ms === null || !Number.isFinite(nowMs)) {
    return '';
  }
  const at = partsOf(ms, timeZone);
  const now = partsOf(nowMs, timeZone);
  const days = daysBetween(at, now);
  if (days === 0) {
    return `today at ${clock(at)}`;
  }
  if (days === 1) {
    return `yesterday at ${clock(at)}`;
  }
  const date = `${at.day} ${MONTHS[at.month - 1] ?? ''}${at.year === now.year ? '' : ` ${at.year}`}`;
  return `on ${date} at ${clock(at)}`;
}

/**
 * S2 12.7's heading: `Before the restart (last activity <activityTime>) <n> sessions were open`
 * (`1 session was open`); without a last activity, the heading without it.
 * @param {Pick<BannerPayload, 'lastActivityNs' | 'entries'>} banner
 * @param {number} nowMs
 * @param {string} timeZone
 * @returns {string}
 */
export function bannerHeading(banner, nowMs, timeZone) {
  const count = Array.isArray(banner.entries) ? banner.entries.length : 0;
  const when = activityTime(banner.lastActivityNs, nowMs, timeZone);
  const open = count === 1 ? '1 session was open' : `${count} sessions were open`;
  return when === ''
    ? `Before the restart ${open}`
    : `Before the restart (last activity ${when}) ${open}`;
}

/**
 * An entry's checkbox label (design 7.8's entry): `<short>  <title> · no exit recorded` or
 * `· ended HH:MM` (in `timeZone`), then `· was working` when it was.
 * @param {BannerEntryPayload} entry
 * @param {string} timeZone
 * @returns {string}
 */
export function entryText(entry, timeZone) {
  const ms = msOf(entry.endedAtNs);
  const ended = ms === null ? 'no exit recorded' : `ended ${clock(partsOf(ms, timeZone))}`;
  return `${entry.shortId}  ${entry.title} · ${ended}${entry.wasWorking === true ? ' · was working' : ''}`;
}

/**
 * The Restore button's label: `Restore <n>`, n the ticked entries.
 * @param {number} count
 * @returns {string}
 */
export function restoreLabel(count) {
  return `Restore ${count}`;
}
