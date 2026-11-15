// The ticket link of a group (S2 12.5): `ticketUrl` with `{key}` replaced by the ticket key that
// `groupPattern` finds in the group. Pure. A title is foreign text and may hold the key, so the key
// may change nothing of the address but the place it fills: not its scheme, login or host, and
// not the path around it.
import { linkToOpen } from '../text/link.ts';

/** Where the key goes in `ticketUrl` (S2 16.4). */
const KEY_PLACE = '{key}';
/** A ticket key: letters, digits, `-`, `_` and `.`, starting with a letter or a digit (S2 12.5). */
const TICKET_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * What stands in for the key when `ticketUrl` is read on its own. It starts with `_`, so no key
 * can be it (a key starts with a letter or a digit), and the parser keeps it as it is wherever a
 * key could stand: the address read with the key must be the one read with it, character for
 * character, the key in its place.
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
 * `{key}` replaced by the key, and only when it is, character for character, `ticketUrl` as the
 * parser reads it with a stand-in for `{key}` and the key in the stand-in's place, without a user
 * name or password, and with that reading's host. Null when `ticketUrl` or `group` is null,
 * nothing matches, the match is not such a key, linkToOpen refuses, or the parser read the key
 * otherwise (a key that finishes a percent-escape into a dot segment, a key in the host, …).
 */
export function ticketAddress(
  group: string | null,
  groupPattern: string,
  ticketUrl: string | null,
): string | null {
  if (group === null || ticketUrl === null) return null;
  const pieces = ticketUrl.split(KEY_PLACE);
  if (pieces.length !== 2) return null;
  const key = ticketKey(group, groupPattern);
  if (key === null) return null;
  const own = URL.parse(pieces.join(STAND_IN));
  const address = linkToOpen(pieces.join(key));
  if (own === null || address === null || own.username !== '' || own.password !== '') return null;
  const asOwn = own.href.split(STAND_IN).join(key) === address;
  return asOwn && URL.parse(address)?.host === own.host ? address : null;
}
