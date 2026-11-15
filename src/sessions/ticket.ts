// The ticket link of a group (S2 12.5): `ticketUrl` with `{key}` replaced by the ticket key that
// `groupPattern` finds in the group. Pure. A title is foreign text and may hold the key, so nothing
// the key holds may reach the scheme, the user name, the password or the host of the address.
import { linkToOpen } from '../text/link.ts';

/** Where the key goes in `ticketUrl` (S2 16.4). */
const KEY_PLACE = '{key}';
/** A ticket key: letters, digits, `-`, `_` and `.`, starting with a letter or a digit (S2 12.5). */
const TICKET_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * What stands in for the key when `ticketUrl` is read on its own. It starts with `_`, so no key
 * can be it: an address whose parts equal those read with it cannot owe them to its key, whatever
 * `ticketUrl` is (even one that the configuration's check would refuse, S2 16.4).
 */
const STAND_IN = '_key_';

/** The parts of a URL that decide where it goes and as whom; null for what is no URL. */
function origin(url: string): string[] | null {
  const parsed = URL.parse(url);
  return parsed === null ? null : [parsed.protocol, parsed.username, parsed.password, parsed.host];
}

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
 * `{key}` replaced by the key, and only when the scheme, user name, password and host the parser
 * reads in it are those of `ticketUrl` read with a sample key. Null when `ticketUrl` or `group`
 * is null, nothing matches, the match is not such a key, linkToOpen refuses, or those parts
 * differ.
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
  const address = linkToOpen(pieces.join(key));
  const own = origin(pieces.join(STAND_IN));
  if (address === null || own === null) return null;
  const read = origin(address);
  return read !== null && read.every((part, i) => part === own[i]) ? address : null;
}
