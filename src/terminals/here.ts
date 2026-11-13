import type { Env, Files } from '../platform/types.ts';
import { shellJoin, shellQuote } from '../text/shell.ts';
import type { LaunchSpec, OpenResult, Terminal } from './types.ts';

/** The launcher (bin/skydeck) creates the handoff file and puts its path in this variable. */
export const HANDOFF_ENV = 'SKYDECK_HANDOFF';

/**
 * The handoff file content (plan 2.10.3): "cd -- <q cwd> || exit 1\nexec <q argv…>\n". It is the one
 * place where skydeck gives a shell a string to run, so every word goes through `shellQuote`. The
 * other fields of a LaunchSpec do not concern a terminal that replaces skydeck.
 */
export function handoffScript(spec: Pick<LaunchSpec, 'cwd' | 'argv'>): string {
  return `cd -- ${shellQuote(spec.cwd)} || exit 1\nexec ${shellJoin(spec.argv)}\n`;
}

/**
 * open() writes handoffScript to the file named by env SKYDECK_HANDOFF (Files.writeText).
 * Without that variable: { ok: false, error: 'not started through bin/skydeck', timedOut: false }.
 * The caller must exit right after a successful open(); the launcher then execs the command.
 */
export function hereTerminal(deps: { files: Files; env: Env }): Terminal {
  return {
    name: 'here',
    opensTabs: false,
    // async, so that a file that cannot be written is a rejected promise like any other failure of
    // open(), not an exception thrown before a promise exists.
    async open(spec: LaunchSpec): Promise<OpenResult> {
      const path = deps.env[HANDOFF_ENV];
      if (path === undefined || path === '') {
        return { ok: false, error: 'not started through bin/skydeck', timedOut: false };
      }
      if (spec.argv.length === 0) {
        // `exec` with nothing after it does nothing: the launcher would exit 0 as if all went well.
        throw new Error('hereTerminal.open: empty argument list');
      }
      deps.files.writeText(path, handoffScript(spec));
      return { ok: true };
    },
  };
}
