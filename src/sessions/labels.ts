// What a label or a group may be (design 7.1). Both are one line of text the user typed.
import { UsageError } from '../platform/errors.ts';
import { sanitize } from '../text/sanitize.ts';

/** LF, CR, VT, FF, NEL, LS and PS: whatever could end a line. */
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;

/**
 * The text trimmed, or a UsageError saying why it cannot be a one-line `kind`: it has a line
 * break, or anything else the sanitiser (design 7.4) would change (a tab, an escape sequence, a
 * control or bidirectional character), or nothing at all. The message never repeats the text.
 */
function oneLine(kind: string, text: string): string {
  const trimmed = text.trim();
  if (LINE_BREAK.test(trimmed)) {
    throw new UsageError(`a ${kind} must be one line`);
  }
  if (sanitize(trimmed) !== trimmed) {
    throw new UsageError(`a ${kind} cannot contain control characters`);
  }
  if (trimmed === '') {
    throw new UsageError(`a ${kind} cannot be empty`);
  }
  return trimmed;
}

/**
 * Trimmed label. UsageError when it contains a line break or any other character the sanitiser
 * would change, is empty after trimming, or starts with '-': the label is passed to Claude Code as
 * the session name, where it would be read as a flag. The message does not repeat the text.
 */
export function cleanLabel(text: string): string {
  const label = oneLine('label', text);
  if (label.startsWith('-')) {
    throw new UsageError("a label cannot start with '-' (Claude Code would read it as a flag)");
  }
  return label;
}

/** Trimmed group. UsageError when it contains a line break or any other character the sanitiser would change, or is empty after trimming. */
export function cleanGroup(text: string): string {
  return oneLine('group', text);
}
