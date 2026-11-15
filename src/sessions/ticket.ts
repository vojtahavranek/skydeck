// The ticket link of a group (S2 12.5): `ticketUrl` with `{key}` replaced by the ticket key that
// `groupPattern` finds in the group. Pure. A title is foreign text and may hold the key, so the key
// may change nothing of the address but the place it fills: not its login or host, and not the
// path around it (by finishing a percent-escape the pattern began).
import { linkToOpen } from '../text/link.ts';

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
  if (group === null || ticketUrl === null || WHITE_SPACE_OR_CONTROL.test(ticketUrl)) return null;
  const pieces = ticketUrl.split(KEY_PLACE);
  const [before = ''] = pieces;
  if (pieces.length !== 2 || UNFINISHED_ESCAPE.test(before)) return null;
  const key = ticketKey(group, groupPattern);
  if (key === null) return null;
  const own = URL.parse(pieces.join(STAND_IN));
  const address = linkToOpen(pieces.join(key));
  if (own === null || address === null || own.username !== '' || own.password !== '') return null;
  return URL.parse(address)?.host === own.host ? address : null;
}
