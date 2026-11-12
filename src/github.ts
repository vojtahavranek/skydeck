/** Pull requests (design 7.3). This file holds the pull-request key; the rest of 2.6 is added by task 9. */

export interface PrKey {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

const MAX_PR_NUMBER = 2147483647;

// Scheme and host are case-insensitive; everything after the host is matched case-sensitively.
const PREFIX = /^https?:\/\/(?:www\.)?github\.com\//i;
// <owner>/<repo>/pull/<number>, then the end or a '/', '?' or '#' (anything after is stripped).
// The number has no sign and no leading zero, so '0', '01' and '12abc' do not match.
const REST = /^([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)(?:[/?#]|$)/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * 7.3 key. Accepts http(s)://github.com/<owner>/<repo>/pull/<number> (host case-insensitive,
 * optional "www."), anything after the number stripped (/files, ?x, #y). Validates owner, repo
 * (not '.' or '..') and number (1..2147483647, no leading zeros). Returns the lowercased url
 * `https://github.com/<owner>/<repo>/pull/<number>` and lowercased owner/repo; null when invalid.
 */
export function prKey(text: string): PrKey | null {
  const prefix = PREFIX.exec(text);
  if (prefix === null) return null;
  const match = REST.exec(text.slice(prefix[0].length));
  if (match === null) return null;
  const [, owner, repo, digits] = match;
  if (owner === undefined || repo === undefined || digits === undefined) return null;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  const number = Number(digits);
  if (number > MAX_PR_NUMBER) return null;
  const lowerOwner = owner.toLowerCase();
  const lowerRepo = repo.toLowerCase();
  return {
    url: `https://github.com/${lowerOwner}/${lowerRepo}/pull/${number}`,
    owner: lowerOwner,
    repo: lowerRepo,
    number,
  };
}
