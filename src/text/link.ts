// The links skydeck may hand to a browser (S2 9.6): the window's `open-link` and the ticket address
// (S2 12.5). Pure; imports nothing, so that `src/sessions/` and `src/window/` can both use it.

/** S2 9.6: the longest URL the server opens. */
const MAX_LINK_LENGTH = 2048;
/** One word of a Windows command line: printable ASCII, no space (S2 9.6). */
const ONE_WORD = /^[\x21-\x7e]+$/;

/**
 * S2 9.6: the URL to open (re-serialised), or null when it must not be opened: longer than 2,048
 * characters, not a URL, or not http/https. The re-serialised URL — the one passed to a Windows
 * program (Edge or `rundll32.exe`) — must fit the same limit (percent-encoding can make it longer
 * than what the page sent), and must hold no '"' and no backslash: it becomes one argument of a
 * Windows program, and either can change how that program splits its command line. (The parser
 * encodes a '"' everywhere but in the host, and a backslash keeps only in the query and the
 * fragment.) It must also be one word of the command line, printable ASCII only (U+0021–U+007E):
 * `FileProtocolHandler` takes the rest of the line as it is. The http/https rule is what keeps a
 * link from starting a program: `rundll32.exe url.dll,FileProtocolHandler` opens what it is given
 * as the Windows shell would, a program or a `file:` address included (S2 15.5).
 */
export function linkToOpen(url: string): string | null {
  if (url.length > MAX_LINK_LENGTH) return null;
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return null;
  }
  const href = parsed.href;
  if (href.length > MAX_LINK_LENGTH || href.includes('"') || href.includes('\\')) return null;
  // The parser leaves no white space, control or non-ASCII character in what it gives back; held
  // here too, so that the one-word rule does not rest on the parser (follow-up F1, C1).
  if (!ONE_WORD.test(href)) return null;
  return href;
}
