/**
 * The extra flags of the new form (S2 12.6): words separated by whitespace; '…' and "…" group
 * words (no escapes, no variables). Design 7.7's refusals are `prepareNew`'s, not this module's.
 */

/** Separate words outside quotes: spaces, tabs and line breaks (a pasted text). */
const SEPARATORS = new Set([' ', '\t', '\n', '\r']);

/**
 * S2 12.6: words separated by whitespace, '…' and "…" group words, no escapes; an unclosed quote is
 * an error. Quoted and unquoted parts next to each other form one word, and a quoted empty text is an
 * empty word, as in a shell.
 */
export function splitFlags(
  text: string,
): { ok: true; flags: string[] } | { ok: false; error: string } {
  const flags: string[] = [];
  let word = '';
  let inWord = false; // true once a character or a pair of quotes belongs to the current word
  let quote: string | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (SEPARATORS.has(char)) {
      if (inWord) {
        flags.push(word);
        word = '';
        inWord = false;
      }
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote !== null) {
    return { ok: false, error: `the flags have an unclosed ${quote}` };
  }
  if (inWord) flags.push(word);
  return { ok: true, flags };
}
