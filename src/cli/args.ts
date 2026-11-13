// Argument parsing shared by every command (plan 2.9.3).
import { parseArgs } from 'node:util';

import { UsageError } from '../platform/errors.ts';

export interface ArgSpec {
  /** Printed for --help; appended to usage errors. */
  usage: string;
  flags: Record<string, { type: 'boolean' | 'string'; short?: string }>;
  /** Positionals: at least `min`, at most `max`. */
  min: number;
  max: number;
  /** Keep everything after '--' in `rest` (for `new`). */
  allowRest?: boolean;
}

export interface ParsedArgs {
  help: boolean;
  /** Only the flags that were given. */
  flags: Record<string, string | boolean | undefined>;
  positionals: string[];
  rest: string[];
}

/**
 * node:util parseArgs (strict). '--help' or '-h' before any '--' → { help: true } and nothing else
 * is checked. A parse error, or a positional count outside [min, max], throws UsageError whose
 * message is the reason, a newline, and spec.usage.
 *
 * With `allowRest`, the first '--' ends the arguments of the command: what follows is returned
 * untouched in `rest`. Without it, '--' only makes what follows positional.
 */
export function parseCommandArgs(args: readonly string[], spec: ArgSpec): ParsedArgs {
  const dashes = args.indexOf('--');
  const beforeDashes = dashes === -1 ? args : args.slice(0, dashes);
  if (beforeDashes.includes('--help') || beforeDashes.includes('-h')) {
    return { help: true, flags: {}, positionals: [], rest: [] };
  }
  const keepRest = spec.allowRest === true && dashes !== -1;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...(spec.allowRest === true ? beforeDashes : args)],
      options: spec.flags,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (isParseError(error)) {
      throw new UsageError(`${reasonOf(error)}\n${spec.usage}`);
    }
    throw error;
  }
  const positionals = parsed.positionals;
  if (positionals.length > spec.max) {
    throw new UsageError(`too many arguments\n${spec.usage}`);
  }
  if (positionals.length < spec.min) {
    throw new UsageError(`missing argument\n${spec.usage}`);
  }
  const flags: ParsedArgs['flags'] = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    // parseArgs returns its values in an object without a prototype, and an array only for a flag
    // declared `multiple`, which a spec cannot do.
    if (typeof value === 'string' || typeof value === 'boolean') {
      flags[name] = value;
    }
  }
  return { help: false, flags, positionals, rest: keepRest ? args.slice(dashes + 1) : [] };
}

function isParseError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  );
}

/**
 * node:util's message with its hint about '--' removed (it is wrong for a command that takes no
 * positional arguments) and its first letter lower-cased, like the other messages.
 */
function reasonOf(error: Error): string {
  const text = error.message.replace(/\. To specify a positional argument[^]*$/, '');
  return text.charAt(0).toLowerCase() + text.slice(1);
}
