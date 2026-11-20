// The list's text (S2 12.1, 12.2, stage A; plan task 27): what a row and its state line say, a
// section header, the footer and the title bar's counts — from exactly what the server's `list`
// says (S2 8.2.3); web/list.js draws it. A row that needs you (stage B, plan B13) has the reason's
// line, web/attention-text.js's, as its second line. Pure: no DOM and no clock, so that node:test
// and the root type check load it (test/web/list.test.ts).
//
// The server sanitised every string when it built the list (design 7.4); the page passes each one
// through the same rule again before showing it (`sanitize`, a copy of src/text/sanitize.ts that
// the test holds to the server's): a page that shows foreign text decides that for itself.

/** @import { ChipPayload, ListMessage, RowPayload, SectionPayload, TerminalPayload } from '../src/window/protocol.ts' */
/** @import { RowTicketPayload } from '../src/window/protocol.ts' */
import { attentionLine } from './attention-text.js';
import { ageBetween } from './format.js';

// --- the sanitiser (a copy of src/text/sanitize.ts: web/ never imports code from src/) ----------

/** An escape sequence: a control string to its end, a CSI, or ESC and the one character after it. */
const ESCAPE_SEQUENCE =
  /(?:\x1b[\]PX^_]|[\u009d\u0090\u0098\u009e\u009f])[^]*?(?:\x07|\x1b\\|\u009c|$)|(?:\x1b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[^]?/gu;
const LINE_BREAKS_AND_TABS = /[\t\n\r]/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDIRECTIONAL_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Design 7.4's sanitiser, as src/text/sanitize.ts has it: escape sequences removed, each tab and
 * line break one space, the other control characters and the bidirectional controls removed. No
 * trim, no collapsing of spaces.
 * @param {string} text
 * @returns {string}
 */
export function sanitize(text) {
  return text
    .replace(ESCAPE_SEQUENCE, '')
    .replace(LINE_BREAKS_AND_TABS, ' ')
    .replace(CONTROLS, '')
    .replace(BIDIRECTIONAL_CONTROLS, '');
}

/**
 * @param {unknown} text
 * @returns {string} the text sanitised and trimmed; '' for anything that is not a string
 */
function clean(text) {
  return typeof text === 'string' ? sanitize(text).trim() : '';
}

// --- rows (S2 12.2) -------------------------------------------------------------------------------

/**
 * @typedef {'working' | 'waiting' | 'running' | 'starting' | 'not-running' | 'crashed'} RowIcon
 * @typedef {{ kind: string, text: string, tip: string }} MarkText
 * @typedef {object} ChipText S2 12.3's chip of a row, as the list draws it
 * @property {string} text the open ones (`PR · failing`, `3 PRs · failing`), or with none open
 *   `3 merged` or `closed`
 * @property {string} merged `+30` for the merged ones beside open ones, in the chip's tint (dim
 *   only on a grey chip, F4); '' when none
 * @property {string} tip each open one with its own state, then the merged and closed counts
 * @property {boolean} dotted its state is `can't read`
 * @property {boolean} dim none is open: the chip is `3 merged` (in merged's tint, F4) or `closed`
 *   (dim)
 * @property {string} level the state the chip names, one of design 7.3's levels, for its tint
 *   (follow-up F4); '' for a level the page does not know, which keeps the chip grey
 * @typedef {object} TicketText F19's small chip of a row: its ticket's status
 * @property {string} text the status, cut at 14 characters with `…`
 * @property {string} tip `<name> · <status>`, the status whole
 * @property {string} category the status' category for its tint (`knownCategory`), '' for none
 * @typedef {object} RowText
 * @property {RowIcon} icon the state icon
 * @property {string} slot the slot number, '' when the row's terminal has none
 * @property {string} key the ticket key the title starts with (dim, monospaced), '' when none
 * @property {string} group the group printed dim before a title that does not start with it, or ''
 * @property {string} title the title, after its key when it has one
 * @property {MarkText[]} marks design 6.3's marks in words, then `done`
 * @property {ChipText | null} chip S2 12.3's chip, null when no pull request is attached
 * @property {TicketText | null} ticket F19: the ticket's status chip, null while none is known
 * @property {string | null} note null without a note; else the note's first line, the ✎'s tooltip
 * @property {string} age a one-line row's age (its last activity); '' on a row of two lines
 * @property {string | null} stateLine the second line of a running or starting row, and of a row
 *   that needs you (the reason's line, B13); else null
 * @property {'asks' | 'ended' | 'finished' | 'other' | null} attention why the row needs you
 *   (S2 12.4: its mark; `other` for a reason the page does not know), null when it needs nothing
 */

/** Design 6.3's marks in words (S2 12.2), in design 6.3's order, and what their tooltips say. */
const MARKS = /** @type {const} */ ([
  ['ended-unexpectedly', 'crashed', 'crashed', 'it ended unexpectedly'],
  ['continued', 'continued', 'continued', 'it continues another session (/clear or a fork)'],
  ['expired', 'expired', 'expired', 'its transcript is gone: it cannot be resumed'],
  // Stage A (ruled, plan task 27): the row carries only that the session is expiring, not when
  // its transcript is deleted, so no number of days.
  [
    'expiring',
    'expiring',
    'expires soon',
    'its transcript will be deleted soon unless the session is resumed',
  ],
  ['duplicate', 'duplicate', '2 processes', 'two live processes hold it'],
]);
const KNOWN_MARKS = new Set([...MARKS.map(([mark]) => mark), 'was-working']);

/**
 * @param {RowPayload} row
 * @returns {MarkText[]}
 */
function marksOf(row) {
  const marks = Array.isArray(row.marks) ? row.marks : [];
  /** @type {MarkText[]} */
  const shown = [];
  for (const [mark, kind, text, tip] of MARKS) {
    if (!marks.includes(mark)) {
      continue;
    }
    // was-working is the kind of crash, not a mark of its own (design 6.3).
    shown.push(
      mark === 'ended-unexpectedly' && marks.includes('was-working')
        ? {
            kind,
            text: 'crashed mid-turn',
            tip: 'it ended unexpectedly in the middle of a turn',
          }
        : { kind, text, tip },
    );
  }
  for (const mark of marks) {
    const text = clean(mark);
    if (!KNOWN_MARKS.has(mark) && text !== '') {
      shown.push({ kind: 'other', text, tip: text });
    }
  }
  if (row.done) {
    shown.push({ kind: 'done', text: 'done', tip: 'marked done' });
  }
  return shown;
}

/** A pull request's level of design 7.3 in S2 12.3's words. */
const LEVEL_WORDS = /** @type {Record<string, string>} */ ({
  'cant-read': "can't read",
  unfetched: 'not fetched',
  'checks-failing': 'failing',
  'changes-requested': 'changes',
  'checks-pending': 'pending',
  'review-required': 'review',
  'unresolved-comments': 'comments',
  draft: 'draft',
  'checks-not-reported': 'pending',
  blocked: 'blocked',
  open: 'open',
  'checks-passing': 'green',
  'approved-green': 'approved',
  merged: 'merged',
  closed: 'closed',
});

/**
 * The state a chip or a pull request names, for its tint (follow-up F4): `level` when it is one
 * of design 7.3's levels, else '' (no state: grey). Only the page's own names reach the markup.
 * @param {string} level
 * @returns {string}
 */
export function knownLevel(level) {
  return Object.hasOwn(LEVEL_WORDS, level) ? level : '';
}

/**
 * @param {string} level
 * @returns {string}
 */
function levelWords(level) {
  return Object.hasOwn(LEVEL_WORDS, level) ? (LEVEL_WORDS[level] ?? level) : clean(level);
}

/**
 * S2 12.3's chip in its words, its two parts apart: the open ones — `PR · failing` for one,
 * `3 PRs · failing` for several, with the state of the one that most needs the user — and `+30`
 * for the merged ones beside them; with none open, `3 merged` when any is merged, else `closed`.
 * @param {ChipPayload} chip a row's `chip`
 * @returns {{ text: string, merged: string }}
 */
function chipParts(chip) {
  const { open, merged } = chip;
  if (open === 0) {
    return { text: merged > 0 ? `${merged} merged` : 'closed', merged: '' };
  }
  const words = levelWords(chip.level);
  return {
    text: open === 1 ? `PR · ${words}` : `${open} PRs · ${words}`,
    merged: merged > 0 ? `+${merged}` : '',
  };
}

/**
 * The whole text of S2 12.3's chip: `PR · failing`, `3 PRs · failing +30`, `3 merged`, `closed`.
 * Exported so that the header shows the same chip with the same words.
 * @param {ChipPayload} chip a row's `chip`
 * @returns {string}
 */
export function chipText(chip) {
  const { text, merged } = chipParts(chip);
  return merged === '' ? text : `${text} ${merged}`;
}

/**
 * One open pull request in the chip's tooltip (S2 12.3): `owner/repo #7 · failing`; one that
 * cannot be read says when it was last read (`last read 3h ago`, `never read` without a read),
 * then its error.
 * @param {RowPayload['prs'][number]} pr
 * @param {string} nowNs
 * @returns {string}
 */
function openPrTip(pr, nowNs) {
  const parts = [`${clean(pr.repo)} #${pr.number}`, levelWords(pr.level)];
  if (pr.level === 'cant-read') {
    const age = pr.okAtNs === null ? '' : ageBetween(nowNs, pr.okAtNs);
    parts.push(pr.okAtNs === null ? 'never read' : age === '' ? '' : `last read ${age} ago`);
    parts.push(clean(pr.error));
  }
  return parts.filter((part) => part !== '').join(' · ');
}

/**
 * A row's chip (S2 12.3): its parts, `dim` when none is open, dotted when it is `can't read`; the
 * tooltip lists each open pull request with its own state, then the merged and closed counts
 * (`30 merged · 1 closed`).
 * @param {RowPayload} row
 * @param {string} nowNs
 * @returns {ChipText | null}
 */
function chipOf(row, nowNs) {
  if (row.chip === null || typeof row.chip !== 'object') {
    return null;
  }
  const prs = Array.isArray(row.prs) ? row.prs : [];
  const finished = (/** @type {string} */ level) => prs.filter((pr) => pr.level === level).length;
  const counts = [
    [finished('merged'), 'merged'],
    [finished('closed'), 'closed'],
  ]
    .filter(([count]) => count !== 0)
    .map(([count, words]) => `${count} ${words}`)
    .join(' · ');
  const tip = [
    ...prs
      .filter((pr) => pr.level !== 'merged' && pr.level !== 'closed')
      .map((pr) => openPrTip(pr, nowNs)),
    counts,
  ]
    .filter((line) => line !== '')
    .join('\n');
  return {
    ...chipParts(row.chip),
    tip,
    dotted: row.chip.level === 'cant-read',
    dim: row.chip.open === 0,
    level: knownLevel(row.chip.level),
  };
}

// --- follow-up F19: a ticket's status (S2 12.2, 12.3) --------------------------------------------

/** The six categories of a ticket's status (T3); each names a pull request's tint (style.css). */
const TICKET_CATEGORIES = ['todo', 'doing', 'review', 'blocked', 'done', 'closed'];
/** The longest status the row's chip shows, in characters, the `…` included. */
export const ROW_STATUS_LENGTH = 14;

/**
 * The category a status names, for its tint: one of the six words, else '' (no category: grey).
 * Only the page's own words reach the markup.
 * @param {unknown} category
 * @returns {string}
 */
export function knownCategory(category) {
  return typeof category === 'string' && TICKET_CATEGORIES.includes(category) ? category : '';
}

/**
 * `text` cut to `length` characters (code points), the cut one ending in `…`.
 * @param {string} text
 * @param {number} length
 * @returns {string}
 */
export function cutText(text, length) {
  const characters = [...text];
  return characters.length <= length ? text : `${characters.slice(0, length - 1).join('')}…`;
}

/**
 * F19 (T7): a row's ticket chip — its status cut at 14 characters, `<name> · <status>` as its
 * tooltip, its category for the tint —; null while the row has no status (or one of a wrong shape).
 * @param {RowPayload} row
 * @returns {TicketText | null}
 */
function ticketOf(row) {
  const ticket = /** @type {RowTicketPayload | null | undefined} */ (row.ticketStatus);
  if (typeof ticket !== 'object' || ticket === null) {
    return null;
  }
  const status = clean(ticket.status);
  if (status === '') {
    return null;
  }
  const name = clean(ticket.name);
  return {
    text: cutText(status, ROW_STATUS_LENGTH),
    tip: name === '' ? status : `${name} · ${status}`,
    category: knownCategory(ticket.category),
  };
}

/** What may stand between a title's ticket key and the rest of it. */
const AFTER_KEY = /^[\s:–—-]+/u;
/** A character that continues a word: a key ends before none of these. */
const WORD = /[\p{L}\p{N}_-]/u;

/**
 * S2 12.2: a title that starts with its group (a ticket key) shows the key apart, dim and
 * monospaced, then the rest of the title; a group the title does not start with is printed dim
 * before the title. A title that starts with the group in the middle of a word (`ORB-21070` and
 * the group `ORB-2107`) is shown whole, and the group not again.
 * @param {RowPayload} row
 * @returns {{ key: string, group: string, title: string }}
 */
function titleOf(row) {
  const title = clean(row.title);
  const group = clean(row.group);
  if (group === '') {
    return { key: '', group: '', title };
  }
  if (!title.startsWith(group)) {
    return { key: '', group, title };
  }
  const next = title.slice(group.length);
  if (next !== '' && WORD.test(next[0] ?? '')) {
    return { key: '', group: '', title };
  }
  return { key: group, group: '', title: next.replace(AFTER_KEY, '') };
}

/**
 * The second line of a running or starting row (S2 12.2, stage A: states only): `starting…` (or
 * S2 7.5's `started, not reported`), `running in another terminal`, else the state, its detail
 * and its time (`working 4m`, `waiting · permission · 3m`).
 * @param {RowPayload} row
 * @param {string} nowNs
 * @param {TerminalPayload | null} terminal
 * @returns {string}
 */
function stateLineOf(row, nowNs, terminal) {
  if (row.starting) {
    return terminal?.notReported === true ? 'started, not reported' : 'starting…';
  }
  if (row.elsewhere !== null) {
    return 'running in another terminal';
  }
  const detail = clean(row.stateDetail);
  const age = ageBetween(nowNs, row.sinceNs);
  const head = detail === '' ? row.state : `${row.state} · ${detail} ·`;
  return age === '' ? (detail === '' ? head : `${row.state} · ${detail}`) : `${head} ${age}`;
}

/**
 * The mark of a row that needs you (S2 12.4): its reason, each drawn in its own way
 * (web/list.css), or `other` for a reason the page does not know.
 * @param {RowPayload} row
 * @returns {'asks' | 'ended' | 'finished' | 'other'}
 */
function attentionMark(row) {
  const reason = row.attention?.reason;
  return reason === 'asks' || reason === 'ended' || reason === 'finished' ? reason : 'other';
}

/**
 * Everything a row shows (S2 12.2, stage A). A running or starting row has two lines — the first,
 * then its state line —, any other one line that ends with its age. A row that needs you (B13)
 * has two lines whatever its state, the reason's line (`attentionLine`) as the second; a row
 * without `attention` (a list of stage A) needs nothing. Every string from the server is
 * sanitised again; nothing becomes markup (web/list.js sets text only).
 * @param {RowPayload} row
 * @param {string} nowNs the server's time now, estimated (S2 8.2.3: ages are the page's, A18)
 * @param {TerminalPayload | null} terminal the row's terminal (`row.terminal` in `list.terminals`)
 * @returns {RowText}
 */
export function rowText(row, nowNs, terminal) {
  const needs = attentionLine(row.attention ?? null, nowNs);
  const twoLines = needs !== null || row.starting || row.state !== 'not-running';
  const marks = marksOf(row);
  /** @type {RowIcon} */
  const icon = row.starting
    ? 'starting'
    : row.state !== 'not-running'
      ? row.state
      : marks.some((mark) => mark.kind === 'crashed')
        ? 'crashed'
        : 'not-running';
  const noteHead = Array.isArray(row.noteHead) ? row.noteHead : [];
  return {
    icon,
    slot: typeof row.slot === 'number' ? String(row.slot) : '',
    ...titleOf(row),
    marks,
    chip: chipOf(row, nowNs),
    ticket: ticketOf(row),
    note: row.hasNote ? clean(noteHead[0] ?? '') : null,
    age: twoLines ? '' : ageBetween(nowNs, row.lastActivityNs),
    stateLine: needs ?? (twoLines ? stateLineOf(row, nowNs, terminal) : null),
    attention: needs === null ? null : attentionMark(row),
  };
}

// --- sections, the footer, the counts (S2 12.1) -------------------------------------------------

// The section with the key `week` (the key of the protocol and the code, S2 12.1) is titled
// Recent, and its header's tooltip says what it holds exactly: a rolling 7 days, not the calendar
// week (F5).
const SECTION_TITLES = { open: 'Open', week: 'Recent', earlier: 'Earlier' };
const SECTION_TIPS = { open: '', week: 'last active in the last 7 days', earlier: '' };

/**
 * A section's header: its name and count, and while folded the time span of its rows (S2 12.1:
 * "the folded header shows the count and the time span"), newest first: `8d–41d ago`; `tip` is
 * the title's tooltip, empty for a section that has none.
 * @param {SectionPayload} section
 * @param {string} nowNs
 * @returns {{ title: string, tip: string, count: string, span: string }}
 */
export function sectionText(section, nowNs) {
  const newest = section.folded ? ageBetween(nowNs, section.lastNs) : '';
  const oldest = section.folded ? ageBetween(nowNs, section.firstNs) : '';
  const span =
    newest === '' || oldest === ''
      ? ''
      : newest === oldest
        ? `${newest} ago`
        : `${newest}–${oldest} ago`;
  return {
    title: Object.hasOwn(SECTION_TITLES, section.name)
      ? SECTION_TITLES[section.name]
      : clean(section.name),
    tip: Object.hasOwn(SECTION_TIPS, section.name) ? SECTION_TIPS[section.name] : '',
    count: String(section.count),
    span,
  };
}

/**
 * The footer under the list (S2 12.1): `17 done hidden · show`; while done sessions are shown,
 * `done sessions shown · hide`; nothing when there is nothing to show or hide.
 * @param {number} doneHidden
 * @param {boolean} showDone
 * @returns {{ text: string, action: 'show' | 'hide' } | null}
 */
export function footerText(doneHidden, showDone) {
  if (showDone) {
    return { text: 'done sessions shown', action: 'hide' };
  }
  return doneHidden > 0 ? { text: `${doneHidden} done hidden`, action: 'show' } : null;
}

/**
 * Follow-up F22: whether `list` holds no session at all — no session in any section (a folded
 * Earlier counts its own; done sessions hidden count for none) and no filter or chip set: a filter
 * that hides every session keeps its own line, "No session matches the filter.". Whether the view
 * filters is the server's (`list.filtering`, E5); a list without it, stage A's rule, the field's
 * text. False before the first list (nothing is known yet). The list's note and the right side's
 * line both follow it.
 * @param {ListMessage | null} list
 * @param {string} filter the filter field's text
 * @returns {boolean}
 */
export function holdsNoSession(list, filter) {
  if (list === null) {
    return false;
  }
  const filtering = typeof list.filtering === 'boolean' ? list.filtering : filter !== '';
  return !filtering && list.sections.every((section) => section.count === 0);
}

/**
 * Follow-up F22: the list's note while it holds no session at all, line by line. `here` names the
 * page's own way to start a session: Ctrl+Shift+N in the app window, `+ New` in a browser tab,
 * where the browser keeps Ctrl+Shift+N (web/list.js shows the one that fits, by style.css's
 * app-only and tab-only rule).
 */
export const NO_SESSION = {
  head: 'No session here yet.',
  terminal: 'Start claude in any terminal: it shows here as soon as it starts.',
  here: {
    app: 'Or start one here with Ctrl+Shift+N.',
    tab: 'Or start one here with + New in the key bar.',
  },
  keys: 'Ctrl+Shift+H shows every key.',
};

/** The title bar's states in the order shown, and their words (S2 12.1, 19 stage A). */
const COUNTS = /** @type {const} */ ([
  ['working', 'working', 'working'],
  ['waiting', 'waiting', 'waiting'],
  ['running', 'running', 'running'],
  ['starting', 'starting', 'starting'],
  ['elsewhere', 'elsewhere', 'in another terminal'],
  ['notRunning', 'not-running', 'not running'],
]);

/**
 * The title bar's counts per state (S2 12.1, stage A: states only; "needs you" comes with stage
 * B): each state that has sessions, `3 working`, `2 in another terminal`, `14 not running`.
 * @param {ListMessage['counts']} counts
 * @returns {{ state: string, text: string }[]}
 */
export function countsText(counts) {
  return COUNTS.filter(([field]) => (counts[field] ?? 0) > 0).map(([field, state, words]) => ({
    state,
    text: `${counts[field]} ${words}`,
  }));
}
