// The ticket link of a group (S2 12.5): `ticketUrl` with `{key}` replaced by the ticket key that
// `groupPattern` finds in the group. Pure. A title is foreign text and may hold the key, so the key
// may change nothing of the address but the place it fills: not its login or host, and not the
// path around it (by finishing a percent-escape the pattern began).
//
// Follow-up F18: the ticket a user sets on a session (S2 12.5, design 7.1) — what text sets it
// (`readTicket`: a whole link, or a bare key filled into `ticketUrl` by the same rule), and the
// short name its chip shows (`ticketText`).
import { linkToOpen } from '../text/link.ts';
import { sanitize } from '../text/sanitize.ts';

/** Where the key goes in `ticketUrl` (S2 16.4). */
const KEY_PLACE = '{key}';
/** A ticket key: letters, digits, `-`, `_` and `.`, starting with a letter or a digit (S2 12.5). */
const TICKET_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * White space and the control characters of S2 2: the parser drops tabs and line breaks before it
 * reads, so the text would hide from UNFINISHED_ESCAPE what the parser then joins.
 */
const WHITE_SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;
/** A percent-escape left unfinished: a key right after it would finish it (S2 16.4). */
const UNFINISHED_ESCAPE = /%[0-9A-Fa-f]?$/;
/**
 * What stands in for the key when `ticketUrl` is read on its own. It starts with `_`, so no key
 * can be it (a key starts with a letter or a digit): an address whose host is the one read with
 * it cannot owe its host to the key, whatever `ticketUrl` is.
 */
const STAND_IN = '_key_';

/** The key `groupPattern` matches in `group`, when it is one; null otherwise. */
function ticketKey(group: string, groupPattern: string): string | null {
  let match: string | undefined;
  try {
    match = new RegExp(groupPattern).exec(group)?.[0];
  } catch {
    return null; // not a regular expression: the configuration refuses it, so nothing matches
  }
  return match !== undefined && TICKET_KEY.test(match) ? match : null;
}

/**
 * `ticketUrl` with its one `{key}` replaced by `key` (a key by TICKET_KEY's rule), as linkToOpen
 * gives it back; null when `key` is no such key, `ticketUrl` holds white space or a control
 * character, or `%`, or `%` and one hex digit, right before `{key}`, or not exactly one `{key}`,
 * linkToOpen refuses the address, or the parser reads `ticketUrl` with a stand-in for `{key}` with
 * a user name or a password or with another host than the address's.
 */
function keyAddress(key: string, ticketUrl: string): string | null {
  if (!TICKET_KEY.test(key) || WHITE_SPACE_OR_CONTROL.test(ticketUrl)) return null;
  const pieces = ticketUrl.split(KEY_PLACE);
  const [before = ''] = pieces;
  if (pieces.length !== 2 || UNFINISHED_ESCAPE.test(before)) return null;
  const own = URL.parse(pieces.join(STAND_IN));
  const address = linkToOpen(pieces.join(key));
  if (own === null || address === null || own.username !== '' || own.password !== '') return null;
  return URL.parse(address)?.host === own.host ? address : null;
}

/**
 * S2 12.5's ticket link. The key is the text `groupPattern` matches in `group`, only when it
 * matches /^[A-Za-z0-9][A-Za-z0-9._-]*$/. The address is linkToOpen of `ticketUrl` with its one
 * `{key}` replaced by the key, and only when `ticketUrl` holds no white space or control
 * character and no `%`, or `%` and one hex digit, right before `{key}`, and the parser reads
 * `ticketUrl` with a stand-in for `{key}` without a user name or password and with the address's
 * host. Null when `ticketUrl` or `group` is null, nothing matches, the match is not such a key,
 * linkToOpen refuses, or one of those does not hold.
 */
export function ticketAddress(
  group: string | null,
  groupPattern: string,
  ticketUrl: string | null,
): string | null {
  if (group === null || ticketUrl === null) return null;
  const key = ticketKey(group, groupPattern);
  return key === null ? null : keyAddress(key, ticketUrl);
}

// --- F18: the ticket a user sets on a session --------------------------------------------------

/** S2 9.6: the longest link the window opens, and so the longest ticket link. */
const MAX_TICKET_LINK = 2048;
/** LF, CR, VT, FF, NEL, LS and PS: whatever could end a line (labels.ts's LINE_BREAK). */
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;

/** The words of K1's refusals; none repeats the text it was given. */
export const TICKET_REFUSALS = {
  lineBreak: 'a ticket must be one line',
  control: 'a ticket cannot contain control characters',
  tooLong: `a ticket link is at most ${MAX_TICKET_LINK.toLocaleString('en-US')} characters`,
  notHttp: 'a ticket link must start with http:// or https://',
  credentials: 'a ticket link cannot hold a user name or a password',
  notOpenable: `the window does not open this link: it must hold no " or \\ and be at most ${MAX_TICKET_LINK.toLocaleString('en-US')} characters once encoded`,
  keyWithoutTicketUrl:
    'a ticket key needs ticketUrl in config.json: set ticketUrl, or give the whole link',
  keyMakesNoLink: 'ticketUrl makes no link the window may open from this key; give the whole link',
  notATicket: 'not a ticket: give an http or https link, or a key like ABC-123',
} as const;

/** What a text sets (K1): the address to store, null to remove the ticket; or why not. */
export type TicketRead = { ok: true; address: string | null } | { ok: false; error: string };

/**
 * F18's K1: the ticket `text` sets, trimmed of white space at both ends. Empty: none (the ticket is
 * removed). A line break, or anything else the sanitiser (design 7.4) would change — a control
 * character, an escape sequence, a bidirectional control —, is refused, as in a label. A bare key
 * (TICKET_KEY) is `ticketUrl` with the key filled in (keyAddress, ticketAddress's rule); refused
 * without a `ticketUrl` with words that say what to do, and when `ticketUrl` makes no link from it.
 * Anything else is a whole link: at most 2,048 characters, read by the URL parser as http or https,
 * without a user name or a password (it is stored, printed and shown), and one linkToOpen gives
 * back, which is what is stored — the address the window opens. Every refusal is one of
 * TICKET_REFUSALS.
 */
export function readTicket(text: string, ticketUrl: string | null): TicketRead {
  const refuse = (error: string): TicketRead => ({ ok: false, error });
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, address: null };
  if (LINE_BREAK.test(trimmed)) return refuse(TICKET_REFUSALS.lineBreak);
  if (sanitize(trimmed) !== trimmed) return refuse(TICKET_REFUSALS.control);
  if (TICKET_KEY.test(trimmed)) {
    if (ticketUrl === null) return refuse(TICKET_REFUSALS.keyWithoutTicketUrl);
    const address = keyAddress(trimmed, ticketUrl);
    return address === null ? refuse(TICKET_REFUSALS.keyMakesNoLink) : { ok: true, address };
  }
  if (trimmed.length > MAX_TICKET_LINK) return refuse(TICKET_REFUSALS.tooLong);
  const parsed = URL.parse(trimmed);
  if (parsed === null) return refuse(TICKET_REFUSALS.notATicket);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return refuse(TICKET_REFUSALS.notHttp);
  }
  if (parsed.username !== '' || parsed.password !== '') return refuse(TICKET_REFUSALS.credentials);
  const address = linkToOpen(trimmed);
  return address === null ? refuse(TICKET_REFUSALS.notOpenable) : { ok: true, address };
}

/** K2: the longest name a part of a path gives, in characters, the cut one ending in `…`. */
export const TICKET_TEXT_LENGTH = 24;
/** What stands in for the key to find where ticketUrl's parsed address holds it (ticketText). */
const NAME_STAND_IN = 'K0skydeckK0';
/** A path `/browse/KEY` (K2). */
const BROWSE = /^\/browse\/([A-Za-z0-9][A-Za-z0-9._-]*)\/?$/;
/** A GitHub issue or pull request, and what may follow its number (K2). */
const GITHUB_ITEM = /^\/[^/]+\/([^/]+)\/(?:issues|pull)\/([1-9][0-9]*)(?:\/.*)?$/;

/** The key `url` holds in the place of ticketUrl's `{key}`; null when it does not fit ticketUrl. */
function keyIn(url: string, ticketUrl: string | null): string | null {
  if (ticketUrl === null) return null;
  const around = keyAddress(NAME_STAND_IN, ticketUrl)?.split(NAME_STAND_IN);
  if (around?.length !== 2) return null;
  const [before = '', after = ''] = around;
  if (!url.startsWith(before) || !url.endsWith(after)) return null;
  if (url.length <= before.length + after.length) return null;
  const key = url.slice(before.length, url.length - after.length);
  return keyAddress(key, ticketUrl) === url ? key : null;
}

/** A part of a path decoded (as it is when it does not decode), sanitised, trimmed. */
function decoded(part: string): string {
  let text: string;
  try {
    text = decodeURIComponent(part);
  } catch {
    text = part;
  }
  return sanitize(text).trim();
}

/** `text` cut to at most TICKET_TEXT_LENGTH characters (code points), the cut one ending in `…`. */
function cut(text: string): string {
  const characters = [...text];
  return characters.length <= TICKET_TEXT_LENGTH
    ? text
    : `${characters.slice(0, TICKET_TEXT_LENGTH - 1).join('')}…`;
}

/**
 * F18's K2: the short name of the ticket address `url` (one the store holds, readTicket's), for
 * its chip. In this order: the key, when `url` is the configured `ticketUrl` with a key filled in;
 * `KEY` for a path `/browse/KEY`; `repo #n` for `github.com/owner/repo/issues/n` or `/pull/n`
 * (and anything after the number); the last part of the path that is not empty, decoded, at most
 * TICKET_TEXT_LENGTH characters with `…`; else the host (with its port). Only ever text: every
 * part is sanitised (design 7.4). Pure.
 */
export function ticketText(url: string, ticketUrl: string | null): string {
  const key = keyIn(url, ticketUrl);
  if (key !== null) return key;
  const parsed = URL.parse(url);
  if (parsed === null) return cut(sanitize(url));
  const browse = BROWSE.exec(parsed.pathname);
  if (browse?.[1] !== undefined) return browse[1];
  const github = parsed.host === 'github.com' ? GITHUB_ITEM.exec(parsed.pathname) : null;
  if (github?.[1] !== undefined && github[2] !== undefined) {
    return `${cut(decoded(github[1]))} #${github[2]}`;
  }
  const last = parsed.pathname
    .split('/')
    .map(decoded)
    .filter((part) => part !== '')
    .at(-1);
  return last === undefined ? sanitize(parsed.host) : cut(last);
}

/** F19: the longest key a part of a path gives `{key}`, in characters. */
export const TICKET_KEY_LENGTH = 128;

/**
 * Follow-up F19 (review 2, ruled): the ticket's KEY for a status command's `{key}` — never the
 * chip's display name (ticketText). In this order: the key the address holds in the place of the
 * configured `ticketUrl`'s `{key}`; else the `KEY` of a path `/browse/KEY`; else the last part of
 * the path that is not empty, as written (not percent-decoded), when it is a key by TICKET_KEY's
 * rule — letters, digits, `.`, `_` and `-`, starting with a letter or a digit, so never an option
 * like `--help` — of at most TICKET_KEY_LENGTH characters, whole (never cut). Null when the
 * address gives none. Pure.
 */
export function ticketKeyOf(url: string, ticketUrl: string | null): string | null {
  const key = keyIn(url, ticketUrl);
  if (key !== null) return key;
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  const browse = BROWSE.exec(parsed.pathname);
  if (browse?.[1] !== undefined) return browse[1];
  const last = parsed.pathname
    .split('/')
    .filter((part) => part !== '')
    .at(-1);
  return last !== undefined && last.length <= TICKET_KEY_LENGTH && TICKET_KEY.test(last)
    ? last
    : null;
}
