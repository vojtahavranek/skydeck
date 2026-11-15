/**
 * The Windows side of the window, as pure rules: Windows paths, the Edge profile folder (S2 5.4),
 * Edge's arguments (S2 5.3) and the links it may open (S2 9.6; the rule lives in src/text/link.ts
 * and is re-exported here). Nothing here starts a program; task 19 does, with what these return.
 */

import { join } from 'node:path';

import type { Files } from '../platform/types.ts';

export { linkToOpen } from '../text/link.ts';

/** `/mnt/<letter>` and what follows it; WSL mounts drives under lowercase letters. */
const DRIVE_PATH = /^\/mnt\/([a-z])(?:\/(.*))?$/;
/** Characters no Windows file name holds: the control characters and " * : < > ? | \\. */
const NOT_IN_A_WINDOWS_NAME = /[\x00-\x1f"*:<>?|\\]/;

/**
 * A name Windows cannot have, or one that names something else there: '.' and '..' (they would
 * leave the drive), a forbidden character (a backslash would split the name, ':' names a stream,
 * '"' would end a quoted argument), a trailing space or dot (Windows drops it).
 */
function notAWindowsName(name: string): boolean {
  return NOT_IN_A_WINDOWS_NAME.test(name) || name.endsWith(' ') || name.endsWith('.');
}

/**
 * '/mnt/c/Users/me/x' → 'C:\\Users\\me\\x'; null for a path not under /mnt/<letter>/, and for one
 * with a segment Windows cannot have (see notAWindowsName).
 */
export function windowsPath(linuxPath: string): string | null {
  const match = DRIVE_PATH.exec(linuxPath);
  if (match === null) return null;
  const [, letter = '', rest = ''] = match;
  const parts = rest.split('/').filter((part) => part !== '');
  if (parts.some(notAWindowsName)) return null;
  return `${letter.toUpperCase()}:\\${parts.join('\\')}`;
}

/** Where Windows keeps its users' folders, as WSL sees it: the Windows form of the profile folder. */
const USERS = '/mnt/c/Users';
/** A user's Edge folder, below their user folder. */
const EDGE_FOLDER = ['AppData', 'Local', 'Microsoft', 'Edge'];
/** The window's profile folder, below the user folder (S2 5.4). */
const PROFILE_FOLDER = 'AppData/Local/skydeck/edge-profile';
const SET_PROFILE_DIR =
  "set window.profileDir to the folder for the window's Edge profile (an absolute Windows path)";

/** A folder that exists (links followed) and whose entries can be listed. */
function isReadableFolder(files: Files, path: string): boolean {
  try {
    if (files.stat(path)?.kind !== 'dir') return false;
    files.list(path);
    return true;
  } catch {
    return false; // permission denied on it or on a folder above it, a loop, …
  }
}

/**
 * S2 5.4: the derived profile folder, or an error naming window.profileDir (none or several users),
 * found under `usersRoot`, the folder that stands for /mnt/c/Users: the C: drive's `Users` as
 * driveC (drive.ts) gives it, a sandbox folder in tests. The profile folder it gives is always
 * under `C:\Users\<name>`.
 */
export function deriveProfileDirUnder(
  files: Files,
  usersRoot: string,
): { ok: true; dir: string } | { ok: false; error: string } {
  const where = `${usersRoot}/<user>/${EDGE_FOLDER.join('/')}`;
  let names: string[];
  try {
    names = files.list(usersRoot);
  } catch {
    return { ok: false, error: `cannot read ${usersRoot} to find ${where}; ${SET_PROFILE_DIR}` };
  }
  const found: { name: string; dir: string }[] = [];
  for (const name of names) {
    const dir = windowsPath(`${USERS}/${name}/${PROFILE_FOLDER}`);
    if (dir !== null && isReadableFolder(files, join(usersRoot, name, ...EDGE_FOLDER))) {
      found.push({ name, dir });
    }
  }
  const [only] = found;
  if (only !== undefined && found.length === 1) {
    return { ok: true, dir: only.dir };
  }
  if (found.length === 0) {
    return { ok: false, error: `no readable Edge folder found at ${where}; ${SET_PROFILE_DIR}` };
  }
  const users = found.map((f) => f.name).join(', ');
  return {
    ok: false,
    error: `Edge folders of several Windows users found at ${where} (${users}); ${SET_PROFILE_DIR}`,
  };
}

/** S2 5.3: the arguments for msedge.exe. */
export function edgeArgs(port: number, token: string, profileDir: string): string[] {
  return [
    `--app=http://127.0.0.1:${port}/#t=${token}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}
