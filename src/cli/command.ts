import type { Context } from './context.ts';

/**
 * A command is a file `src/cli/commands/<name>.ts` that exports one of these as `command`.
 * `run` gets the arguments after the command name (including `--help`, which the command
 * handles itself) and returns the exit code.
 */
export type Command = {
  name: string;
  summary: string;
  run(args: string[], ctx: Context): Promise<number>;
};
