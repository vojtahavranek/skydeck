/**
 * The extra flags of the new form (S2 12.6): words separated by any whitespace; '…' and "…" group
 * words (no escapes, no variables). Design 7.7's refusals are `prepareNew`'s, not this module's.
 */

/**
 * Separates words outside quotes: any whitespace — spaces, tabs, line breaks, and the no-break
 * space a text copied from a web page or a chat brings — so that nothing can hide inside one word.
 */
const SEPARATOR = /^\s$/;

/**
 * S2 12.6: words separated by any whitespace, '…' and "…" group words, no escapes; an unclosed
 * quote is an error, and so is a NUL anywhere (no program can be given it). Quoted and unquoted
 * parts next to each other form one word, and a quoted empty text is an empty word, as in a shell.
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
    } else if (SEPARATOR.test(char)) {
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
  if (text.includes('\0')) {
    // No program can be given an argument holding a NUL: exec refuses it.
    return { ok: false, error: 'the flags contain a NUL character' };
  }
  if (inWord) flags.push(word);
  return { ok: true, flags };
}
