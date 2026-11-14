/**
 * Starting Windows programs (S2 2): Edge for the window (S2 5.3) and for the links a page opens
 * (S2 9.6). skydeck starts exactly two Windows programs, `window.edge` and the keep-alive's
 * `wsl.exe` (keepalive.ts), and both go through `startWindowsProgram`: an argument list, never a
 * shell, detached, stdio ignored, in a Windows directory, with `WSL_INTEROP` pointing at the
 * runtime directory's interop link (S2 6.4) when there is one.
 */

import type { WindowConfig } from '../platform/config.ts';
import type { Detached, Env, Platform } from '../platform/types.ts';
import { describeError } from '../sessions/problems.ts';
import { deriveProfileDir, edgeArgs, linkToOpen } from './windows.ts';

/** A Windows directory, so that the program starts without a "UNC path" warning (S2 5.3). */
const WINDOWS_CWD = '/mnt/c';
/** A launch token as the address carries it: base64url (S2 8.2.2). */
const TOKEN = /^[A-Za-z0-9_-]+$/;
/**
 * A character that can change how a Windows program splits its command line ('"'), or a control
 * character (S2 2: U+0000–U+001F, U+007F and U+0080–U+009F).
 */
const UNSAFE_CHARACTER = /["\x00-\x1f\x7f-\x9f]/;

/**
 * Whether `arg` could be split differently by the Windows program than skydeck meant: the program
 * gets one command line, not a list, and its own parser splits it. A '"' ends a quoted argument, a
 * backslash before the closing quote escapes it, and a control character has no business there.
 * An empty argument may be dropped.
 */
function unsafeArgument(arg: string): boolean {
  return arg === '' || UNSAFE_CHARACTER.test(arg) || arg.endsWith('\\');
}

/** The platform's environment, with WSL_INTEROP = the link when there is one (else as it is). */
function windowsEnvironment(env: Env, interop: string | null): Record<string, string> {
  const result: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  if (interop !== null) {
    result.WSL_INTEROP = interop;
  }
  return result;
}

/**
 * Starts a Windows program as S2 2 says: `args` as an argument list, detached, stdin, stdout and
 * stderr /dev/null, in /mnt/c, with the platform's environment and `WSL_INTEROP` = `interop` when
 * given. Rejects, starting nothing, when an argument is empty or holds a '"' or a control
 * character or ends with a backslash; otherwise as `processes.startDetached` (ENOENT: the program
 * or /mnt/c does not exist).
 */
export async function startWindowsProgram(
  platform: Platform,
  command: string,
  args: readonly string[],
  interop: string | null,
): Promise<Detached> {
  const unsafe = args.find(unsafeArgument);
  if (unsafe !== undefined) {
    throw new Error(`${asJsonString(unsafe)} cannot be passed to a Windows program`);
  }
  return platform.processes.startDetached(command, args, {
    cwd: WINDOWS_CWD,
    env: windowsEnvironment(platform.env, interop),
  });
}

/**
 * `text` as a JSON string — as it stands in config.json — with DEL and the C1 controls escaped
 * too (JSON.stringify escapes only U+0000–U+001F), so that no control character reaches a terminal.
 */
function asJsonString(text: string): string {
  return JSON.stringify(text).replace(
    /[\x7f-\x9f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
}

/**
 * S2 5.3: starts `window.edge` with edgeArgs for the window's profile folder (S2 5.4:
 * `window.profileDir`, or derived). `{ ok: false, line }` when the folder cannot be derived or
 * cannot be passed to Edge, and when Edge cannot be started — S2 5.3's line when the program does
 * not exist. Edge's exit says nothing about the window, so it is not waited for. A RangeError for
 * a port or a token that cannot be part of the address (the caller's mistake, not the user's).
 */
export async function startEdge(
  platform: Platform,
  window: WindowConfig,
  configPath: string,
  port: number,
  token: string,
  interop: string | null,
): Promise<{ ok: true } | { ok: false; line: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`not a port: ${port}`);
  }
  if (!TOKEN.test(token)) {
    throw new RangeError('not a launch token');
  }
  let profileDir = window.profileDir;
  if (profileDir === null) {
    const derived = deriveProfileDir(platform.files);
    if (!derived.ok) {
      return { ok: false, line: `${derived.error} in ${configPath}` };
    }
    profileDir = derived.dir;
  }
  if (unsafeArgument(profileDir)) {
    return {
      ok: false,
      line: `the Edge profile folder ${asJsonString(profileDir)} cannot be passed to Edge (a '"', a control character or a backslash at the end); set window.profileDir in ${configPath}`,
    };
  }
  try {
    await startWindowsProgram(platform, window.edge, edgeArgs(port, token, profileDir), interop);
    return { ok: true };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        ok: false,
        line: `Edge was not found at ${window.edge}; set window.edge in ${configPath}, or open the window in any browser with skydeck window --print-url`,
      };
    }
    return {
      ok: false,
      line: `Edge could not be started from ${window.edge} (${describeError(error)}); open the window in any browser with skydeck window --print-url`,
    };
  }
}

/**
 * S2 9.6: opens `url` in the user's own Edge profile — `window.edge` with the re-serialised URL as
 * its only argument, no profile folder. False, starting nothing, for a URL linkToOpen refuses; false
 * too when Edge cannot be started. True once it was started (it is not waited for).
 */
export async function openLink(
  platform: Platform,
  window: WindowConfig,
  url: string,
  interop: string | null,
): Promise<boolean> {
  const link = linkToOpen(url);
  if (link === null) {
    return false;
  }
  try {
    await startWindowsProgram(platform, window.edge, [link], interop);
    return true;
  } catch {
    return false;
  }
}
