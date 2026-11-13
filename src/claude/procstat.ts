/** Parsing of what the kernel exposes under /proc/<pid>/ (design 5.3, 5.5). Pure: no file I/O. */

/** Index of field 22 among the fields after the command name (field 3 is index 0). */
const START_INDEX = 19;

/**
 * Field 22 (starttime) of a /proc/<pid>/stat line, counted after the LAST ')' — the command name
 * (field 2) is parenthesised and may itself contain spaces and parentheses. null when the field is
 * absent, not digits, or too large to be compared exactly (not a safe integer).
 */
export function procStartFromStat(line: string): number | null {
  const close = line.lastIndexOf(')');
  if (close === -1) return null;
  const fields = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const start = fields[START_INDEX];
  if (start === undefined || !/^[0-9]+$/.test(start)) return null;
  const value = Number(start);
  return Number.isSafeInteger(value) ? value : null;
}

// A byte-order mark is a character like any other in an argument: keep it.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * /proc/<pid>/cmdline bytes → arguments: UTF-8 decode, split on NUL, drop the last element when
 * empty (the kernel terminates every argument with NUL). [] for empty input.
 */
export function argvFromCmdline(bytes: Uint8Array): string[] {
  const parts = utf8.decode(bytes).split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
