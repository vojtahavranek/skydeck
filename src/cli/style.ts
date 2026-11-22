// The few colours install and doctor use: bold headings and questions, `ok` green, `problem` red,
// backups and links dim. Only on a terminal, and never when the user asked for none (NO_COLOR,
// no-color.org) or the terminal cannot show it (TERM=dumb). Colour is put around text that is
// already sanitised (src/text/sanitize.ts), never taken from it: what the user sees of a path or a
// program's output is the same in both modes.
import type { Env } from '../platform/types.ts';
import type { Io } from './context.ts';

/** Each function returns its text as it is when colour is off. */
export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
}

const PLAIN: Style = {
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
  green: (text) => text,
};

/** SGR on and the matching off, so that a coloured word does not end the bold around it. */
function sgr(on: number, off: number): (text: string) => string {
  return (text) => `\x1b[${on}m${text}\x1b[${off}m`;
}

const COLOURED: Style = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  red: sgr(31, 39),
  green: sgr(32, 39),
};

/**
 * The style for what is written to `stream`: colour when that stream is a terminal, NO_COLOR is
 * unset or empty and TERM is not `dumb`; else every function gives its text back unchanged.
 */
export function styleFor(io: Io, env: Env, stream: 'stdout' | 'stderr'): Style {
  const noColor = (env['NO_COLOR'] ?? '') !== '';
  return io.isTTY[stream] && !noColor && env['TERM'] !== 'dumb' ? COLOURED : PLAIN;
}
