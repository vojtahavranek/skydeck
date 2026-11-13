// A word that starts with '=' is expanded by zsh (`=ls` is the path of ls), so it is quoted too.
const SAFE_WORD = /^(?!=)[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * POSIX sh quoting. A non-empty word made only of [A-Za-z0-9_@%+=:,./-] is returned unchanged,
 * except that a word starting with '=' is quoted (zsh would expand it if the printed command were
 * pasted there). Anything else is wrapped in single quotes, each ' inside becoming '\'' . The
 * empty word is ''.
 */
export function shellQuote(word: string): string {
  return SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The words quoted with shellQuote, joined by one space. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}
