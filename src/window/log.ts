/**
 * The server's and the keepers' own logs, `<stateDir>/server.log` and `<stateDir>/keepers.log`
 * (S2 4.2, 5.2): one line per event, never conversation content, typed text or the secret; at 1 MiB
 * a file is renamed to `.1` (one older file is kept).
 *
 * server.log has other writers besides the server's lines: the launcher writes its own lines
 * there (ISO time, `launcher:`) before Node.js starts, and the server's stdout and stderr are
 * appended to it (Node.js's own warnings). So the file is only ever appended to and rotated by
 * size; nothing here reads or parses its lines.
 */

// The one append the Files interface does not offer: opening the file in append mode for each
// line, so that lines of other writers are never overwritten and a rotation is followed at once.
import { appendFileSync } from 'node:fs';

import { isoFromNs } from '../platform/time.ts';
import type { Files, Platform } from '../platform/types.ts';
import { sanitize } from '../text/sanitize.ts';

/** The size at which a log is renamed to `<path>.1` (S2 4.2). */
const ROTATE_AT_BYTES = 1024 * 1024;

/**
 * Renames `path` to `<path>.1` when it is 1 MiB or more, replacing an older `.1` (keepers.log, which
 * keepers append to; the server calls it at start and on its tick). A missing file is left alone.
 */
export function rotateLog(files: Files, path: string): void {
  const info = files.stat(path);
  if (info !== null && info.size >= ROTATE_AT_BYTES) {
    files.rename(path, `${path}.1`);
  }
}

/**
 * One line per call with an ISO time; to stderr when `foreground`; at 1 MiB the file becomes .1.
 * The line is made one terminal-safe line (line breaks and tabs become spaces, escape sequences
 * and other controls are removed), so a caller may pass a name and stack frames. The returned
 * function never throws: a line that cannot be written to the file goes to stderr instead.
 */
export function serverLog(
  platform: Platform,
  path: string,
  foreground: boolean,
): (line: string) => void {
  return (line) => {
    const text = `${isoFromNs(platform.clock.nowNs())} ${sanitize(line)}\n`;
    if (foreground) {
      toStderr(text);
      return;
    }
    try {
      rotateLog(platform.files, path);
      appendFileSync(path, text, { mode: 0o600 });
    } catch {
      toStderr(text);
    }
  };
}

/** Writes to this process's stderr; a stderr that cannot be written loses the line. */
function toStderr(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // Nowhere left to say it.
  }
}
