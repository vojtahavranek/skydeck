/**
 * The server's environment (S2 5.2) and the environment of a terminal's program (S2 7.4). Pure:
 * the environment arrives as a parameter, never from `process.env`.
 */

import { CLAUDE_CHILD_VARIABLES } from '../claude/terminal.ts';
import type { Env } from '../platform/types.ts';

/** The launcher's handoff file (design 7.6): its own business, never a program's. */
const HANDOFF = 'SKYDECK_HANDOFF';
/** Set by the launcher beside the NODE_COMPILE_CACHE it gives Node.js (S2 5.2). */
const LAUNCHER_CACHE = 'SKYDECK_LAUNCHER_CACHE';
const COMPILE_CACHE = 'NODE_COMPILE_CACHE';
/** The soft core limit the launcher found before it set 1 byte for `serve` (S2 2). */
const CORE_SOFT = 'SKYDECK_CORE_SOFT';
/** The directory `skydeck window` ran in, passed to `serve` (A29). */
const ENV_ORIGIN = 'SKYDECK_ENV_ORIGIN';

/** S2 7.4: the variables that say which terminal or multiplexer a process runs in. */
const TERMINAL_VARIABLES: readonly string[] = [
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'WT_SESSION',
  'WT_PROFILE_ID',
  'TMUX',
  'TMUX_PANE',
  'STY',
  'VTE_VERSION',
  'KITTY_WINDOW_ID',
  'ITERM_SESSION_ID',
  // The terminal of the shell that ran `skydeck window`, not the new one: a pinentry would draw
  // there, and an editor's Claude Code extension would be reached from every session.
  'CLAUDE_CODE_SSE_PORT',
  'ENABLE_IDE_INTEGRATION',
  'GPG_TTY',
  'SSH_TTY',
];
/**
 * S2 7.4 names these families by prefix: every `WEZTERM_*` and `KONSOLE_*`, and every `VSCODE_*`
 * (an editor's integrated terminal sets many, pointing at that editor's sockets, and their names
 * change between versions).
 */
const TERMINAL_PREFIXES: readonly string[] = ['WEZTERM_', 'KONSOLE_', 'VSCODE_'];
/** Set beside GIT_ASKPASS by an editor's integrated terminal: GIT_ASKPASS is then the editor's. */
const EDITOR_ASKPASS_MARKER = 'VSCODE_GIT_ASKPASS_MAIN';

/** A core limit as the launcher writes it: decimal bytes, or `unlimited`. */
const CORE_LIMIT = /^(?:[0-9]+|unlimited)$/;

/**
 * Removes the launcher's variables in place: the handoff file, and the compile cache the launcher
 * set for Node.js alone (it equals the marker) together with the marker. A NODE_COMPILE_CACHE that
 * differs from the marker is the user's own and stays.
 */
function dropLauncherVariables(env: Record<string, string>): void {
  delete env[HANDOFF];
  const marker = env[LAUNCHER_CACHE];
  if (marker !== undefined && env[COMPILE_CACHE] === marker) {
    delete env[COMPILE_CACHE];
  }
  delete env[LAUNCHER_CACHE];
}

/** Removes `name` from `env` and returns its value, or undefined when it was absent. */
function takeOut(env: Record<string, string>, name: string): string | undefined {
  const value = env[name];
  delete env[name];
  return value;
}

/**
 * S2 5.2: the server's own environment without SKYDECK_HANDOFF, without NODE_COMPILE_CACHE when it
 * equals SKYDECK_LAUNCHER_CACHE, without the marker; SKYDECK_CORE_SOFT and SKYDECK_ENV_ORIGIN
 * (A29) taken out and returned. Each is null when absent or unusable: a core limit that is not
 * decimal bytes or `unlimited`, an origin that is not an absolute path.
 */
export function serverEnvironment(env: Env): {
  env: Record<string, string>;
  coreSoft: string | null;
  origin: string | null;
} {
  // fromEntries defines own properties: a variable named __proto__ stays a variable.
  const result: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  dropLauncherVariables(result);
  const coreSoft = takeOut(result, CORE_SOFT);
  const origin = takeOut(result, ENV_ORIGIN);
  return {
    env: result,
    coreSoft: coreSoft !== undefined && CORE_LIMIT.test(coreSoft) ? coreSoft : null,
    origin: origin !== undefined && origin.startsWith('/') ? origin : null,
  };
}

function isTerminalVariable(name: string): boolean {
  return (
    TERMINAL_VARIABLES.includes(name) || TERMINAL_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * S2 7.4: the program's environment from the server's (as serverEnvironment returned it): without
 * the terminal and multiplexer variables, skydeck's own variables (removed again, so that an
 * environment that did not pass through serverEnvironment is safe too) and the variables Claude
 * Code sets for its children; with TERM=xterm-256color, COLORTERM=truecolor, PWD = `cwd`, and
 * WSL_INTEROP = `interop` when a live link is given (otherwise WSL_INTEROP is left as it is).
 * TERM_PROGRAM is never set (Claude Code would take the terminal for an editor's).
 */
export function programEnvironment(
  serverEnv: Readonly<Record<string, string>>,
  options: { cwd: string; interop: string | null },
): Record<string, string> {
  const env: Record<string, string> = { ...serverEnv };
  dropLauncherVariables(env);
  delete env[CORE_SOFT];
  delete env[ENV_ORIGIN];
  if (env[EDITOR_ASKPASS_MARKER] !== undefined) {
    // The editor's askpass script runs "$VSCODE_GIT_ASKPASS_NODE" "$VSCODE_GIT_ASKPASS_MAIN",
    // which go below; left alone it would answer git with empty credentials.
    delete env.GIT_ASKPASS;
  }
  for (const name of Object.keys(env)) {
    if (isTerminalVariable(name) || CLAUDE_CHILD_VARIABLES.includes(name)) {
      delete env[name];
    }
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.PWD = options.cwd;
  if (options.interop !== null) {
    env.WSL_INTEROP = options.interop;
  }
  return env;
}
