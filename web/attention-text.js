// The page's words of attention (S2 12.1, 12.2, 12.4, 13; plan B13, B14, contract 2.8): the second
// line of a row that needs you, the title bar's count, the window title, a notification's title
// and body, and which session Ctrl+Shift+J selects. Which rows need you, why, and in which order
// is the server's (S2 4.3: `attention` on a row, `needYou` on the list); the page only words it.
// Pure: no DOM and no clock, so that node:test and the root type check load it
// (test/web/attention-text.test.ts).
//
// Every string from the server passes the page's sanitiser again (web/list-text.js's `sanitize`,
// the server's rule) and is handed on as text: a title and a detail never become markup. This
// module and list-text.js import each other's functions (rowText words a row's attention here);
// neither calls the other while it loads.

/** @import { AttentionPayload, NotifyMessage } from '../src/window/protocol.ts' */
import { ageBetween } from './format.js';
import { sanitize } from './list-text.js';

/**
 * @param {unknown} text
 * @returns {string} the text sanitised and trimmed; '' for anything that is not a string
 */
function clean(text) {
  return typeof text === 'string' ? sanitize(text).trim() : '';
}

/**
 * A count of the protocol: a whole number from 0 up; anything else is none (a list without
 * `needYou`, stage A's).
 * @param {unknown} count
 * @returns {number}
 */
function countOf(count) {
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * The first words of a reason (S2 12.2, 13): the row's line and the notification's body. A reason
 * the page does not know is shown as the server named it, sanitised (as list-text.js shows a mark
 * it does not know).
 * @param {unknown} reason
 * @returns {{ row: string, body: string }}
 */
function wordsOf(reason) {
  switch (reason) {
    case 'asks':
      return { row: 'needs you', body: 'asks' };
    case 'finished':
      return { row: 'finished · not seen', body: 'finished' };
    case 'ended':
      return { row: 'ended unexpectedly · not seen', body: 'ended unexpectedly' };
    default: {
      const named = clean(reason);
      return { row: named, body: named };
    }
  }
}

/**
 * B13: the second line of a row that needs you — `needs you · <detail> · 3m` (`needs you · 3m`
 * without a detail), `finished · not seen · 2m`, `ended unexpectedly · not seen · 2m` — its age
 * format.js's from `sinceNs` (none when that is not known); null when `attention` is null (or
 * absent, as in a list of stage A).
 * @param {AttentionPayload | null} attention
 * @param {string} nowNs the server's time now, estimated (S2 8.2.3: ages are the page's)
 * @returns {string | null}
 */
export function attentionLine(attention, nowNs) {
  if (typeof attention !== 'object' || attention === null || Array.isArray(attention)) {
    return null;
  }
  const detail = attention.reason === 'asks' ? clean(attention.detail) : '';
  const age = ageBetween(nowNs, attention.sinceNs);
  return [wordsOf(attention.reason).row, detail, age].filter((part) => part !== '').join(' · ');
}

/**
 * B13: the title bar's count, `3 need you` (`1 needs you`), or null for 0. The text only: the dot
 * before it is the style sheet's (web/list.css), not a character.
 * @param {number} count `needYou.count`
 * @returns {string | null}
 */
export function needYouText(count) {
  const n = countOf(count);
  return n === 0 ? null : `${n} ${n === 1 ? 'needs' : 'need'} you`;
}

/**
 * S2 12.1: the window title, `(3) skydeck`, or `skydeck` for 0, so that the taskbar shows it.
 * @param {number} count `needYou.count`
 * @returns {string}
 */
export function windowTitle(count) {
  const n = countOf(count);
  return n === 0 ? 'skydeck' : `(${n}) skydeck`;
}

/**
 * S2 13, B13: a notification's title — the session's title — and its body — `asks: <detail>`
 * (`asks` without a detail), `finished`, `ended unexpectedly` —, both sanitised and plain text;
 * nothing is added to them.
 * @param {NotifyMessage} message
 * @returns {{ title: string, body: string }}
 */
export function notificationText(message) {
  const detail = message.reason === 'asks' ? clean(message.detail) : '';
  const words = wordsOf(message.reason).body;
  return { title: clean(message.title), body: detail === '' ? words : `${words}: ${detail}` };
}

/**
 * How many of those that need you the filter or the fold hides, in the key bar's words.
 * @param {number} hidden
 * @param {boolean} more whether some are shown
 * @returns {string}
 */
function hiddenText(hidden, more) {
  const which = more ? `${hidden} more` : String(hidden);
  return hidden === 1
    ? `${which} that needs you is hidden by the filter or the fold`
    : `${which} that need you are hidden by the filter or the fold`;
}

/**
 * B14, Ctrl+Shift+J: the session to select — the next of `order` (`needYou.order`, as the server
 * sends it) after the selected one, else the first; after the last the first — and what the key
 * bar says, or null. None: `no session needs you`; only the selected one: it stays selected (no
 * id) and `no other session needs you`. When `count` (`needYou.count`, which counts rows the
 * filter or the fold hides) is greater than the order, the key bar says how many are hidden
 * instead: `2 more that need you are hidden by the filter or the fold`, or with none shown
 * `2 that need you are hidden by the filter or the fold`.
 * @param {string[]} order
 * @param {string | null} selected
 * @param {number} count
 * @returns {{ id: string | null, say: string | null }}
 */
export function nextNeeding(order, selected, count) {
  const ids = Array.isArray(order) ? order.filter((id) => typeof id === 'string') : [];
  const hidden = Math.max(0, countOf(count) - ids.length);
  if (ids.length === 0) {
    return { id: null, say: hidden > 0 ? hiddenText(hidden, false) : 'no session needs you' };
  }
  const at = selected === null ? -1 : ids.indexOf(selected);
  const next = ids.slice(at + 1).find((id) => id !== selected) ?? ids.find((id) => id !== selected);
  const say = hidden > 0 ? hiddenText(hidden, true) : null;
  if (next === undefined) {
    return { id: null, say: say ?? 'no other session needs you' };
  }
  return { id: next, say };
}
