// The header's text and the pull-request dialog's (S2 12.3, 12.5; plan D task 38, D11–D13): a
// pull request's words in the header's line and on its line of the dialog, their tooltips, the
// fold of the merged and closed ones, "opened <time> · last active <age>", where the title comes
// from, the note's line, and the flags the session was started with (follow-up F16). web/cards.js
// and web/edit.js draw them. Pure: no DOM and no clock,
// so that node:test and the root type check load it (test/web/header-text.test.ts); the caller
// passes the server's time now (`serverNow`, A18) and the moment a terminal opened in words.
//
// Every string from the server is sanitised again (list-text.js's `sanitize`, design 7.4) and is
// handed on for `textContent` or a `title` only, never as markup.

/** @import { PrPayload, RowPayload, SelectedPayload } from '../src/window/protocol.ts' */
import { ageBetween } from './format.js';
import { chipText, knownLevel, sanitize } from './list-text.js';

/** An error is cut to this many UTF-16 units on its line of the dialog (its tooltip has it whole). */
export const ERROR_MAX = 120;

/**
 * @param {unknown} text
 * @returns {string} the text sanitised and trimmed; '' for anything that is not a string
 */
function clean(text) {
  return typeof text === 'string' ? sanitize(text).trim() : '';
}

/**
 * `text` cut to ERROR_MAX units with the cut marked by '…', never inside a surrogate pair (as the
 * server caps a note's line).
 * @param {string} text
 * @returns {string}
 */
function cut(text) {
  if (text.length <= ERROR_MAX) {
    return text;
  }
  let end = ERROR_MAX - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

/** Whether a level is final: design 7.3 never fetches a merged or closed pull request again. */
const finalLevel = (/** @type {string} */ level) => level === 'merged' || level === 'closed';

/**
 * The attached pull requests apart (S2 12.3): the open ones — not known to be merged or closed —
 * and the merged and closed ones, each in the order the server sent them.
 * @param {readonly PrPayload[]} prs
 * @returns {{ open: PrPayload[], finished: PrPayload[] }}
 */
export function splitPrs(prs) {
  return {
    open: prs.filter((pr) => !finalLevel(pr.level)),
    finished: prs.filter((pr) => finalLevel(pr.level)),
  };
}

/**
 * A pull request by its repository and number: `acme/web #7` (the toast of ×, D13).
 * @param {PrPayload} pr
 * @returns {string}
 */
export function prName(pr) {
  return `${clean(pr.repo)} #${pr.number}`;
}

/**
 * An open pull request in the header's line (S2 12.5): `acme/web #7 · failing`, in the chip's own
 * words for its state (S2 12.3) — list-text.js's, through the chip of one pull request.
 * @param {PrPayload} pr
 * @returns {string}
 */
export function prItemText(pr) {
  const { name, state } = prItemParts(pr);
  return name + state;
}

/**
 * prItemText in its parts (follow-up F4), so that only the state's words take its tint: the name
 * with its separator (`acme/web #7 · `), the state's words (`failing`), and the state they name
 * (`knownLevel`: '' for a level the page does not know).
 * @param {PrPayload} pr
 * @returns {{ name: string, state: string, level: string }}
 */
export function prItemParts(pr) {
  return {
    name: `${prName(pr)} · `,
    state: chipText({ level: pr.level, open: 1, merged: 0 }).replace(/^PR · /, ''),
    level: knownLevel(pr.level),
  };
}

/** A level in the dialog's words (D13); an unknown one is shown as sent, sanitised. */
const LINE_WORDS = /** @type {Record<string, string>} */ ({
  'cant-read': "can't read",
  unfetched: 'not fetched',
  'checks-failing': 'checks failing',
  'changes-requested': 'changes requested',
  'checks-pending': 'checks pending',
  'review-required': 'review required',
  draft: 'draft',
  'approved-green': 'approved, green',
  merged: 'merged',
  closed: 'closed',
});

/**
 * A pull request on its line of the dialog (D13): `acme/web #7 · approved, green · checked 4m ago`;
 * one that cannot be read says when it was last read (`never read` without a read) and its error,
 * `acme/web #7 · can't read · last read 3h ago · gh: HTTP 502`. A merged or closed one says no
 * age: it is never read again (design 7.3). The error is cut to ERROR_MAX units unless `cutError`
 * is false. A time that cannot be read gives no age.
 * @param {PrPayload} pr
 * @param {string} nowNs the server's time now (`serverNow`)
 * @param {boolean} [cutError]
 * @returns {string}
 */
export function prLineText(pr, nowNs, cutError = true) {
  const { head, state, tail } = prLineParts(pr, nowNs, cutError);
  return head + state + tail;
}

/**
 * prLineText in its parts (follow-up F4), so that only the state's words take its tint: the head
 * (`acme/web #7 · `), the state's words (`checks failing`), the tail (` · checked 4m ago`), and the
 * state they name (`knownLevel`: '' for a level the page does not know). Without words for the
 * state the head has no separator.
 * @param {PrPayload} pr
 * @param {string} nowNs the server's time now (`serverNow`)
 * @param {boolean} [cutError]
 * @returns {{ head: string, state: string, tail: string, level: string }}
 */
export function prLineParts(pr, nowNs, cutError = true) {
  const words = Object.hasOwn(LINE_WORDS, pr.level)
    ? (LINE_WORDS[pr.level] ?? pr.level)
    : clean(pr.level);
  const rest = [];
  const age = pr.okAtNs === null ? '' : ageBetween(nowNs, pr.okAtNs);
  if (pr.level === 'cant-read') {
    rest.push(pr.okAtNs === null ? 'never read' : age === '' ? '' : `last read ${age} ago`);
    const error = clean(pr.error);
    rest.push(cutError ? cut(error) : error);
  } else if (!finalLevel(pr.level) && age !== '') {
    rest.push(`checked ${age} ago`);
  }
  return {
    head: words === '' ? prName(pr) : `${prName(pr)} · `,
    state: words,
    tail: rest
      .filter((part) => part !== '')
      .map((part) => ` · ${part}`)
      .join(''),
    level: knownLevel(pr.level),
  };
}

/**
 * The tooltip of a pull request's line in the dialog: its title (D13), and after it the whole
 * error when the line cut it.
 * @param {PrPayload} pr
 * @returns {string}
 */
export function prLineTip(pr) {
  const error = pr.level === 'cant-read' ? clean(pr.error) : '';
  return [clean(pr.title), cut(error) === error ? '' : error]
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * The tooltip of an open pull request in the header's line: the dialog's words with the error
 * whole (as the chip's tooltip, S2 12.3), then its title.
 * @param {PrPayload} pr
 * @param {string} nowNs
 * @returns {string}
 */
export function prItemTip(pr, nowNs) {
  return [prLineText(pr, nowNs, false), clean(pr.title)].filter((part) => part !== '').join('\n');
}

/**
 * The fold of the dialog's merged and closed pull requests (D13, the mockup's words):
 * `30 merged, 2 closed ▸`, `▾` while unfolded; '' when there are none.
 * @param {number} merged
 * @param {number} closed
 * @param {boolean} unfolded
 * @returns {string}
 */
export function foldText(merged, closed, unfolded) {
  const counts = [
    [merged, 'merged'],
    [closed, 'closed'],
  ]
    .filter(([count]) => count !== 0)
    .map(([count, words]) => `${count} ${words}`)
    .join(', ');
  return counts === '' ? '' : `${counts} ${unfolded ? '▾' : '▸'}`;
}

/**
 * The header's "opened <time> · last active <age>" (S2 12.5, D11): `opened` only while the pane
 * shows a terminal of the window (`openedMoment` is that moment in words, '' without one); an age
 * that cannot be counted is left out.
 * @param {string} openedMoment
 * @param {string} lastActivityNs the row's
 * @param {string} nowNs the server's time now (`serverNow`)
 * @returns {string}
 */
export function timesText(openedMoment, lastActivityNs, nowNs) {
  const age = ageBetween(nowNs, lastActivityNs);
  return [
    openedMoment === '' ? '' : `opened ${openedMoment}`,
    age === '' ? '' : `last active ${age}`,
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/** Where the title comes from (design 7.1's order), in the header's words. */
const SOURCES = /** @type {Record<string, string>} */ ({
  label: 'title: your label',
  name: "title: Claude Code's name",
  generated: "title: Claude Code's summary",
  fallback: 'title: start time and folder',
});

/**
 * The title's source in words (S2 12.5, D11); '' for one this page does not know.
 * @param {string} titleSource
 * @returns {string}
 */
export function titleSourceText(titleSource) {
  return Object.hasOwn(SOURCES, titleSource) ? (SOURCES[titleSource] ?? '') : '';
}

/** The most characters of the flags the header's second line shows (F16): characters as they are
 *  seen (grapheme clusters), so that a joined emoji or a letter with its mark is never split. */
export const STARTED_WITH_MAX = 40;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `value` when it is an array of strings, each sanitised again (not trimmed: a value is shown as
 * recorded); else null — a list of another server, or one of the wrong shape, holds none.
 * @param {unknown} value
 * @returns {string[] | null}
 */
function strings(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value.map((item) => sanitize(/** @type {string} */ (item)));
}

/**
 * Follow-up F16: the flags the session was started with, the last item of the header's second
 * line — `selected.launchFlags` (the recorded ones a resume passes on again) in the order
 * recorded, then `selected.unknownFlags` (the ones the recording knows only by name, bare, as
 * recorded; ruled by the lead: a session started with a flag never shows nothing), joined by one
 * space, a value with spaces as it was recorded (not quoted) — cut to STARTED_WITH_MAX characters
 * over the whole, the last of them `…`, when longer. Its tooltip holds the whole text uncut,
 * `Started with: <flags>`, and when there are names, a second line `Not recognised, not passed
 * again on resume: <names>`. "Started with": a model changed inside the session later is not
 * seen. `text` and `tip` are '' when no flag was recorded. Each field is read on its own: a
 * missing one, or one of the wrong shape, holds none.
 * @param {SelectedPayload | null} selected `list.selected` when it is the row's session
 * @returns {{ text: string, tip: string }}
 */
export function startedWithText(selected) {
  const unknown = strings(selected?.unknownFlags) ?? [];
  const flags = [...(strings(selected?.launchFlags) ?? []), ...unknown];
  if (flags.length === 0) {
    return { text: '', tip: '' };
  }
  const whole = flags.join(' ');
  const characters = [...GRAPHEMES.segment(whole)].map((part) => part.segment);
  const text =
    characters.length <= STARTED_WITH_MAX
      ? whole
      : `${characters.slice(0, STARTED_WITH_MAX - 1).join('')}…`;
  const tip = [
    `Started with: ${whole}`,
    unknown.length === 0 ? '' : `Not recognised, not passed again on resume: ${unknown.join(' ')}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { text, tip };
}

/** A line break of a note, as the server splits one (a lone carriage return too). */
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Whether `note` holds another line with something on it after its first such line.
 * @param {string} note
 */
function moreLines(note) {
  const filled = note.split(LINE_BREAK).filter((line) => clean(line) !== '');
  return filled.length > 1;
}

/**
 * The header's note line (S2 12.5, D12): its first line, ` …` after it when there are more, or the
 * hint `no note` (`empty`). The whole note in `selected` decides whether there are more; without
 * it (not here yet, or too long for the window, D5) the list's head of the note does.
 * @param {RowPayload} row
 * @param {SelectedPayload | null} selected `list.selected` when it is the row's session
 * @returns {{ text: string, empty: boolean }}
 */
export function noteLine(row, selected) {
  if (!row.hasNote) {
    return { text: 'no note', empty: true };
  }
  const head = Array.isArray(row.noteHead) ? row.noteHead : [];
  const first = clean(head[0] ?? '');
  const note = selected?.note;
  const more = typeof note === 'string' ? moreLines(note) : head.length > 1;
  if (first === '') {
    return { text: '…', empty: false };
  }
  return { text: more ? `${first} …` : first, empty: false };
}

/**
 * Follow-up F18: the ticket's chip at the start of the header's third line (S2 12.5), from
 * `selected.ticket` (the server's address and short name, K2): the name, sanitised again — the
 * address when nothing is left of it —, the whole address as its tooltip, and the address a click
 * opens (`open-link`, which the server checks again). Null without a ticket, or for one of the
 * wrong shape. Its text is one part, so that a later status can be a second one beside it.
 * @param {SelectedPayload | null} selected `list.selected` when it is the row's session
 * @returns {{ text: string, tip: string, url: string } | null}
 */
export function ticketChip(selected) {
  const ticket = /** @type {unknown} */ (selected?.ticket);
  if (typeof ticket !== 'object' || ticket === null) {
    return null;
  }
  const { url, text } = /** @type {{ url?: unknown, text?: unknown }} */ (ticket);
  if (typeof url !== 'string' || url === '' || typeof text !== 'string') {
    return null;
  }
  const name = sanitize(text).trim();
  return { text: name === '' ? url : name, tip: url, url };
}

/**
 * Follow-up F18: the ticket dialog's field (S2 12.5): it starts with the ticket's address (empty
 * without one); its placeholder `a link`, and `, or a key like ABC-123` only when the server takes
 * a bare key (`selected.ticketKeys`: ticketUrl is configured); its line of help.
 * @param {SelectedPayload | null} selected `list.selected` of the dialog's session
 * @returns {{ value: string, placeholder: string, help: string }}
 */
export function ticketField(selected) {
  const value = ticketChip(selected)?.url ?? '';
  const keys = selected?.ticketKeys === true;
  return {
    value,
    placeholder: keys ? 'a link, or a key like ABC-123' : 'a link',
    help: keys
      ? "A link is stored as the window opens it; a key becomes ticketUrl's link. Empty removes it."
      : 'An http or https link, stored as the window opens it (a key needs ticketUrl in config.json). Empty removes it.',
  };
}
