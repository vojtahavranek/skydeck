/**
 * Where the commands read the Windows side (S2 5.3, 5.4, 6.1, 16.2, 16.3): the C: drive is
 * `/mnt/c`, where all of stage A expects it (Edge's working directory, `wsl.exe`, the default
 * `window.edge`, the users' folders).
 *
 * In a test sandbox (`SKYDECK_TEST_NO_WINDOWS=1`, A32) nothing under `/mnt/` is read (ruled by the
 * plan owner, task 24): the directory `SKYDECK_TEST_MNT_C` names (an absolute path) stands for
 * `/mnt/c`, and without it the C: drive counts as not mounted. A test can therefore never read the
 * real Windows side, whatever configuration it gives. Outside a sandbox the variable is ignored.
 */

import { isAbsolute, posix } from 'node:path';

import type { Env } from '../platform/types.ts';

/** S2 5.3: the C: drive as WSL mounts it. */
const MNT_C = '/mnt/c';
/** `<letter>:\` and the rest of an absolute Windows path. */
const WINDOWS_ABSOLUTE = /^([A-Za-z]):\\(.*)$/;

function testSandbox(env: Env): boolean {
  return env.SKYDECK_TEST_NO_WINDOWS === '1';
}

/** The directory that is the C: drive here: `/mnt/c`; in a test sandbox SKYDECK_TEST_MNT_C or null. */
export function driveC(env: Env): string | null {
  if (!testSandbox(env)) return MNT_C;
  const standIn = env.SKYDECK_TEST_MNT_C;
  return standIn !== undefined && standIn !== '' && isAbsolute(standIn) ? standIn : null;
}

/**
 * The path a command reads for the absolute path `path`: `path` itself outside a test sandbox. In a
 * sandbox the path is judged after `.` and `..` are resolved (so that `/mnt/` is never walked
 * through): one under `/mnt/c` moves under the stand-in drive, any other one under `/mnt/` is null —
 * it is never read — and any other path is the resolved one.
 */
export function readablePath(env: Env, path: string): string | null {
  if (!testSandbox(env)) return path;
  const resolved = posix.normalize(path).replace(/^\/+/, '/');
  if (resolved !== '/mnt' && !resolved.startsWith('/mnt/')) return resolved;
  const drive = driveC(env);
  if (drive === null) return null;
  if (resolved === MNT_C || resolved === `${MNT_C}/`) return drive;
  if (!resolved.startsWith(`${MNT_C}/`)) return null;
  return posix.join(drive, resolved.slice(MNT_C.length + 1));
}

/**
 * An absolute Windows path (`C:\Users\me\x`) as the Linux path a command reads for it: through
 * `/mnt/<letter>/` (S2 5.4), then readablePath. Null for anything else, and for a path with an empty
 * (but the last), `.` or `..` segment: it would name another folder than it says.
 */
export function readableWindowsPath(env: Env, windowsPath: string): string | null {
  const match = WINDOWS_ABSOLUTE.exec(windowsPath);
  if (match === null) return null;
  const [, letter = '', rest = ''] = match;
  const segments = rest.split('\\');
  if (segments.at(-1) === '') segments.pop();
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const linux = [`/mnt/${letter.toLowerCase()}`, ...segments].join('/');
  return readablePath(env, linux);
}
