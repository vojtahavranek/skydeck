// What a label or a group may be (design 7.1). Both are one line of text the user typed.
import { UsageError } from '../platform/errors.ts';

/** LF, CR, VT, FF, NEL, LS and PS: whatever could end a line. */
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;

/** The text trimmed, or a UsageError saying why it cannot be a one-line `kind`. */
function oneLine(kind: string, text: string): string {
  const trimmed = text.trim();
  if (LINE_BREAK.test(trimmed)) {
    throw new UsageError(`a ${kind} must be one line`);
  }
  if (trimmed === '') {
    throw new UsageError(`a ${kind} cannot be empty`);
  }
  return trimmed;
}

/**
 * Trimmed label. UsageError when it contains a line break, is empty after trimming, or starts with
 * '-': the label is passed to Claude Code as the session name, where it would be read as a flag.
 * The message does not repeat the text.
 */
export function cleanLabel(text: string): string {
  const label = oneLine('label', text);
  if (label.startsWith('-')) {
    throw new UsageError("a label cannot start with '-' (Claude Code would read it as a flag)");
  }
  return label;
}

/** Trimmed group. UsageError when it contains a line break or is empty after trimming. */
export function cleanGroup(text: string): string {
  return oneLine('group', text);
}
