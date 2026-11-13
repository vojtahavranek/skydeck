/**
 * The server's and the keepers' own logs, `<stateDir>/server.log` and `<stateDir>/keepers.log`
 * (S2 4.2, 5.2): one line per event, never conversation content, typed text or the secret; at 1 MiB
 * a file is copied to `.1` and emptied in place (one older file is kept).
 *
 * Both files have writers that hold them open: the server's own stdout and stderr are appended to
 * server.log (Node.js's warnings, a fatal error of its own), each keeper's stderr to keepers.log,
 * and the launcher writes its lines to server.log before Node.js starts. A rename would leave
 * those descriptors on the old file, so a rotation copies and truncates instead: writers that
 * append go on at the start of the same file. A line one of them appends between the copy and the
 * truncate is lost. Nothing here reads or parses the lines.
 */

// What the Files interface does not offer: appending (each line opens the file in append mode, so
// other writers' lines are never overwritten), copying bytes as they are, and truncating in place.
// And a synchronous write to fd 2, whose failure is an error here and not an 'error' event of
// process.stderr that nobody handles (that would end the server).
import { appendFileSync, copyFileSync, truncateSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isoFromNs } from '../platform/time.ts';
import type { Files, Platform } from '../platform/types.ts';
import { sanitize } from '../text/sanitize.ts';

/** The size at which a log is copied to `<path>.1` and emptied (S2 4.2). */
const ROTATE_AT_BYTES = 1024 * 1024;

/**
 * When `path` is 1 MiB or more: copies it to `<path>.1` (through the temporary `.<name>.1.tmp`
 * beside it, renamed over an older `.1`), then truncates `path` in place, so that a writer holding
 * it open in append mode goes on writing into it (keepers.log, which keepers append to; the server
 * calls it at start and on its tick). A missing or smaller file is left alone. A failure is thrown
 * and leaves `path` as it was, with no temporary behind.
 */
export function rotateLog(files: Files, path: string): void {
  const info = files.stat(path);
  if (info === null || info.size < ROTATE_AT_BYTES) {
    return;
  }
  // A fixed name: one process rotates a log (the server), and this module draws no randomness.
  const temp = join(dirname(path), `.${basename(path)}.1.tmp`);
  try {
    files.remove(temp);
    copyFileSync(path, temp);
    files.chmod(temp, 0o600);
    files.rename(temp, `${path}.1`);
  } catch (error) {
    files.remove(temp);
    throw error;
  }
  truncateSync(path, 0);
}

/**
 * One line per call with an ISO time; to stderr when `foreground`; at 1 MiB the file becomes .1.
 * The line is made one terminal-safe line (line breaks and tabs become spaces, escape sequences
 * and other controls are removed), so a caller may pass a name and stack frames. The returned
 * function never throws: a rotation that fails does not stop the line, a time that cannot be shown
 * is `-`, a line that cannot be appended to the file goes to stderr, and one that cannot be
 * written there either is lost.
 */
export function serverLog(
  platform: Platform,
  path: string,
  foreground: boolean,
): (line: string) => void {
  return (line) => {
    const text = `${timeOf(platform)} ${sanitize(line)}\n`;
    if (foreground) {
      toStderr(text);
      return;
    }
    try {
      rotateLog(platform.files, path);
    } catch {
      // The line goes to the file that is there; the rotation is tried again with the next one.
    }
    try {
      appendFileSync(path, text, { mode: 0o600 });
    } catch {
      toStderr(text);
    }
  };
}

/** The ISO time of the platform's clock, or `-` when it cannot be read or shown. */
function timeOf(platform: Platform): string {
  try {
    return isoFromNs(platform.clock.nowNs());
  } catch {
    return '-';
  }
}

/** Writes to fd 2 synchronously; a stderr that cannot be written loses the line. */
function toStderr(text: string): void {
  const bytes = Buffer.from(text);
  try {
    let done = 0;
    while (done < bytes.length) {
      const written = writeSync(2, bytes, done);
      if (written <= 0) break; // never spin on a descriptor that takes nothing
      done += written;
    }
  } catch {
    // Nowhere left to say it.
  }
}
