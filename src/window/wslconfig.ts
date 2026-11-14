/**
 * `%USERPROFILE%\.wslconfig` as doctor reads it (S2 6.1, 16.3): only `[general]`
 * `instanceIdleTimeout`, the setting that keeps a distribution running (-1). skydeck never writes
 * that file (S2 2).
 *
 * The names are matched exactly as WSL documents them, and the value must be exactly a whole
 * number: a spelling or a value WSL might read otherwise is never reported as a protection in
 * effect, which is the safe side — at worst doctor says WSL is not kept running when it is.
 */

/** `[name]`, spaces allowed inside and around the brackets. */
const SECTION = /^\[\s*([^\]]*?)\s*\]$/;
/** An optional minus and decimal digits, nothing else. */
const WHOLE = /^-?[0-9]+$/;

/**
 * The value of `instanceIdleTimeout` in the `[general]` section — the last one when the key occurs
 * more than once, as a later line overrides an earlier one — or null when there is none or it is
 * not a whole number. Lines are split at LF (a CR before it is dropped); a UTF-8 byte order mark,
 * blank lines and lines starting with `#` or `;` are skipped; a key before any section header, or
 * a line that is neither a header nor `key = value`, belongs to no section.
 */
export function instanceIdleTimeout(text: string): number | null {
  let section: string | null = null;
  let value: number | null = null;
  for (const raw of text.replace(/^﻿/, '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      section = SECTION.exec(line)?.[1] ?? null;
      continue;
    }
    const equals = line.indexOf('=');
    if (section !== 'general' || equals < 0) continue;
    if (line.slice(0, equals).trim() !== 'instanceIdleTimeout') continue;
    const text = line.slice(equals + 1).trim();
    const number = Number(text);
    value = WHOLE.test(text) && Number.isSafeInteger(number) ? number : null;
  }
  return value;
}
