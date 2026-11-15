// The links skydeck may hand to a browser (S2 9.6): the window's `open-link` and the ticket address
// (S2 12.5). Pure; imports nothing, so that `src/sessions/` and `src/window/` can both use it.

/** S2 9.6: the longest URL the server opens. */
const MAX_LINK_LENGTH = 2048;

/**
 * S2 9.6: the URL to open (re-serialised), or null when it must not be opened: longer than 2,048
 * characters, not a URL, or not http/https. The re-serialised URL — the one passed to Edge — must
 * fit the same limit (percent-encoding can make it longer than what the page sent), and must hold
 * no '"' and no backslash: it becomes one argument of a Windows program, and either can change how
 * that program splits its command line. (The parser encodes a '"' everywhere but in the host, and
 * a backslash keeps only in the query and the fragment.)
 */
export function linkToOpen(url: string): string | null {
  if (url.length > MAX_LINK_LENGTH) return null;
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return null;
  }
  const href = parsed.href;
  if (href.length > MAX_LINK_LENGTH || href.includes('"') || href.includes('\\')) return null;
  return href;
}
