/**
 * Starting Windows programs (S2 2): Edge for the window (S2 5.3), and for the links a page opens
 * (S2 9.6) `rundll32.exe` — the Windows default browser — or, with `window.links` "edge", Edge.
 * skydeck starts exactly three Windows programs, `window.edge`, `rundll32.exe` and the
 * keep-alive's `wsl.exe` (keepalive.ts), and all go through `startWindowsProgram`: an argument
 * list, never a shell, detached, stdio ignored, in a Windows directory, with `WSL_INTEROP`
 * pointing at the runtime directory's interop link (S2 6.4) when there is one.
 */

import { join } from 'node:path';

import type { WindowConfig } from '../platform/config.ts';
import type { Detached, Env, Platform } from '../platform/types.ts';
import { describeError } from '../sessions/problems.ts';
import { driveC } from './drive.ts';
import { deriveProfileDirUnder, edgeArgs, linkToOpen } from './windows.ts';

/**
 * S2 9.6: what opens a link in the Windows default browser (`window.links` "default"). With
 * FILE_PROTOCOL_HANDLER it opens what it is given as the Windows shell would, a program or a
 * `file:` address included (S2 15.5): only what linkToOpen allows, http or https re-serialised, may
 * reach it, and openLink checks that itself whatever its caller did. Widening linkToOpen (another
 * scheme) would let text a program printed start a program on the Windows side.
 */
const RUNDLL32_EXE = '/mnt/c/Windows/System32/rundll32.exe';
/** Its first argument: hands the rest of the command line, the address, to the shell. */
const FILE_PROTOCOL_HANDLER = 'url.dll,FileProtocolHandler';

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
 * stderr /dev/null, in the C: drive (`driveC`: /mnt/c, or a test sandbox's stand-in), with the platform's environment and `WSL_INTEROP` = `interop` when
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
  // A Windows directory, so that the program starts without a "UNC path" warning (S2 5.3): the
  // C: drive, which in a test sandbox is task 24's stand-in or not there at all (ruled, task 23's
  // review 2: no test runs a process in /mnt/c) — then nothing is started, as on a machine
  // without /mnt/c.
  const cwd = driveC(platform.env);
  if (cwd === null) {
    throw Object.assign(new Error('the C: drive is not mounted'), { code: 'ENOENT' });
  }
  return platform.processes.startDetached(command, args, {
    cwd,
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
    // On the C: drive as driveC gives it: /mnt/c, or in a test sandbox its stand-in, so that a
    // sandbox never reads the Windows side (review 2 of task 25; as uninstall and doctor do).
    const drive = driveC(platform.env);
    if (drive === null) {
      return {
        ok: false,
        line: `the C: drive is not mounted, so the Edge profile folder cannot be derived; set window.profileDir to the folder for the window's Edge profile (an absolute Windows path) in ${configPath}`,
      };
    }
    const derived = deriveProfileDirUnder(platform.files, join(drive, 'Users'));
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
 * S2 9.6: opens `url` where `window.links` says. "default": the Windows default browser —
 * `rundll32.exe` with exactly two arguments, `url.dll,FileProtocolHandler` and the re-serialised
 * URL, which linkToOpen holds to printable ASCII (the parser removes tab and line breaks,
 * percent-encodes the rest, and fails a host or a port that keeps one), so that it is one word of
 * the Windows command line. linkToOpen is applied here whatever the caller checked: it is what
 * keeps a link from starting a program, since FileProtocolHandler opens what it is given as the
 * Windows shell would (S2 15.5). "edge": the user's own Edge profile — `window.edge` with the
 * re-serialised URL as its only argument, no profile folder. False, starting nothing, for a URL
 * linkToOpen refuses; false too when the program cannot be started from WSL. True once it was
 * started; it is not waited for, so what Windows does then (a refusal of its own, a browser that
 * opens nothing) is not seen.
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
  const [command, args] =
    window.links === 'edge' ? [window.edge, [link]] : [RUNDLL32_EXE, [FILE_PROTOCOL_HANDLER, link]];
  try {
    await startWindowsProgram(platform, command, args, interop);
    return true;
  } catch {
    return false;
  }
}
