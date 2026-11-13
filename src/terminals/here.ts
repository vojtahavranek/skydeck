import type { Env, Files } from '../platform/types.ts';
import { shellJoin, shellQuote } from '../text/shell.ts';
import type { LaunchSpec, OpenResult, Terminal } from './types.ts';

/** The launcher (bin/skydeck) creates the handoff file and puts its path in this variable. */
export const HANDOFF_ENV = 'SKYDECK_HANDOFF';

/**
 * The handoff file content (plan 2.10.3): "cd -- <q cwd> || exit 1\nexec <q argv…>\n". It is the one
 * place where skydeck gives a shell a string to run, so every word goes through `shellQuote`.
 */
export function handoffScript(spec: LaunchSpec): string {
  return `cd -- ${shellQuote(spec.cwd)} || exit 1\nexec ${shellJoin(spec.argv)}\n`;
}

/**
 * open() writes handoffScript to the file named by env SKYDECK_HANDOFF (Files.writeText).
 * Without that variable: { ok: false, error: 'not started through bin/skydeck' }.
 * The caller must exit right after a successful open(); the launcher then execs the command.
 */
export function hereTerminal(deps: { files: Files; env: Env }): Terminal {
  return {
    name: 'here',
    opensTabs: false,
    open(spec: LaunchSpec): Promise<OpenResult> {
      const path = deps.env[HANDOFF_ENV];
      if (path === undefined || path === '') {
        return Promise.resolve({ ok: false, error: 'not started through bin/skydeck' });
      }
      deps.files.writeText(path, handoffScript(spec));
      return Promise.resolve({ ok: true });
    },
  };
}
