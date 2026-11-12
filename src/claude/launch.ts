/**
 * Claude Code's launch command line: a table of its flags, a parser for it, and the rewrites
 * skydeck applies to a recorded command (design 5.3 path flags, 7.6 resume, 7.7 new). Pure: file
 * existence is asked through a callback, and nothing outside `src/claude/` is imported.
 */
import { posix } from 'node:path';

export type FlagShape = 'none' | 'one' | 'optional' | 'many';
export interface FlagSpec {
  names: readonly string[]; // every spelling, long and short
  shape: FlagShape;
  remove: boolean; // removed when building a resume command (7.6)
  path: boolean; // values are paths made absolute at ingest (5.3)
}

/** Claude Code 2.1.323 flags (from `claude --help`). */
export const FLAGS: readonly FlagSpec[] = [
  // removed at resume (7.6)
  { names: ['-r', '--resume'], shape: 'optional', remove: true, path: false },
  { names: ['-c', '--continue'], shape: 'none', remove: true, path: false },
  { names: ['--session-id'], shape: 'one', remove: true, path: false },
  { names: ['--fork-session'], shape: 'none', remove: true, path: false },
  { names: ['-n', '--name'], shape: 'one', remove: true, path: false },
  { names: ['-w', '--worktree'], shape: 'optional', remove: true, path: false },
  { names: ['--bg', '--background'], shape: 'none', remove: true, path: false },
  { names: ['--from-pr'], shape: 'optional', remove: true, path: false },
  // they choose which session is opened or where it runs (D28)
  { names: ['--teleport'], shape: 'optional', remove: true, path: false },
  { names: ['--cloud'], shape: 'optional', remove: true, path: false },
  { names: ['--desktop'], shape: 'none', remove: true, path: false },
  // path flags (5.3), kept
  { names: ['--mcp-config'], shape: 'many', remove: false, path: true },
  { names: ['--add-dir'], shape: 'many', remove: false, path: true },
  { names: ['--settings'], shape: 'one', remove: false, path: true },
  { names: ['--plugin-dir'], shape: 'one', remove: false, path: true },
  // kept, several values
  { names: ['--allowedTools', '--allowed-tools'], shape: 'many', remove: false, path: false },
  { names: ['--disallowedTools', '--disallowed-tools'], shape: 'many', remove: false, path: false },
  { names: ['--tools'], shape: 'many', remove: false, path: false },
  { names: ['--betas'], shape: 'many', remove: false, path: false },
  { names: ['--file'], shape: 'many', remove: false, path: false },
  // kept, one value
  ...[
    '--agent',
    '--agents',
    '--append-system-prompt',
    '--autocompact',
    '--debug-file',
    '--effort',
    '--environment',
    '--fallback-model',
    '--input-format',
    '--json-schema',
    '--max-budget-usd',
    '--model',
    '--output-format',
    '--permission-mode',
    '--permission-prompts',
    '--permission-prompt-tool',
    '--plugin-url',
    '--remote-control-session-name-prefix',
    '--setting-sources',
    '--system-prompt',
    '--system-prompt-snapshot',
  ].map((name) => ({ names: [name], shape: 'one' as const, remove: false, path: false })),
  // kept, optional value
  { names: ['-d', '--debug'], shape: 'optional', remove: false, path: false },
  ...['--prompt-suggestions', '--remote-control'].map((name) => ({
    names: [name],
    shape: 'optional' as const,
    remove: false,
    path: false,
  })),
  // kept, no value
  { names: ['-p', '--print'], shape: 'none', remove: false, path: false },
  { names: ['-h', '--help'], shape: 'none', remove: false, path: false },
  { names: ['-v', '--version'], shape: 'none', remove: false, path: false },
  ...[
    '--allow-dangerously-skip-permissions',
    '--ax-screen-reader',
    '--bare',
    '--brief',
    '--chrome',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--exclude-dynamic-system-prompt-sections',
    '--forward-subagent-text',
    '--ide',
    '--include-hook-events',
    '--include-partial-messages',
    '--no-chrome',
    '--no-session-persistence',
    '--replay-user-messages',
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--tmux',
    '--verbose',
  ].map((name) => ({ names: [name], shape: 'none' as const, remove: false, path: false })),
];

const SPEC_BY_NAME: ReadonlyMap<string, FlagSpec> = new Map(
  FLAGS.flatMap((spec) => spec.names.map((name) => [name, spec] as const)),
);

export type ParsedArg =
  | { kind: 'flag'; spec: FlagSpec | null; name: string; tokens: string[]; values: string[] }
  | { kind: 'positional'; tokens: [string] };

/** A token that can be taken as a value: present, and not itself flag-like. */
function isPlainToken(token: string | undefined): boolean {
  return token !== undefined && !token.startsWith('-');
}

/**
 * Parses arguments (WITHOUT the program name) with FLAGS (D18):
 * - `--name=value` (long flags only): one token, `values` [value], consumes nothing more; `name`
 *   is the flag as written before the `=`;
 * - shape none: no value; one: the next token whatever it is; optional: the next token if it
 *   exists and does not start with '-'; many: every following token up to the next one starting
 *   with '-';
 * - an unknown token starting with '-' is a flag with spec null; it takes the next token as its
 *   value when that exists and does not start with '-';
 * - '--' and every token after it are positionals;
 * - any other token is a positional.
 * Concatenating every `tokens` array gives back the input exactly.
 */
export function parseLaunchArgs(args: readonly string[]): ParsedArg[] {
  const items: ParsedArg[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (token === '--') {
      for (const rest of args.slice(i)) items.push({ kind: 'positional', tokens: [rest] });
      break;
    }
    if (!token.startsWith('-')) {
      items.push({ kind: 'positional', tokens: [token] });
      i += 1;
      continue;
    }

    // `--name=value`: the `=` must come after a name of at least one character.
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    if (equals > 2) {
      const name = token.slice(0, equals);
      items.push({
        kind: 'flag',
        spec: SPEC_BY_NAME.get(name) ?? null,
        name,
        tokens: [token],
        values: [token.slice(equals + 1)],
      });
      i += 1;
      continue;
    }

    const spec = SPEC_BY_NAME.get(token) ?? null;
    // An unknown flag takes a following plain token, exactly as an optional-value flag does.
    const shape: FlagShape = spec === null ? 'optional' : spec.shape;
    let end = i + 1;
    if (shape === 'one') {
      end = Math.min(end + 1, args.length);
    } else if (shape === 'optional') {
      if (isPlainToken(args[end])) end += 1;
    } else if (shape === 'many') {
      while (isPlainToken(args[end])) end += 1;
    }
    const tokens = args.slice(i, end);
    items.push({ kind: 'flag', spec, name: token, tokens, values: tokens.slice(1) });
    i = end;
  }
  return items;
}

/**
 * 5.3: in a full launch command (program first), each value of a flag with `path: true` that is
 * relative is replaced by resolve(cwd, value) when `exists(resolved)` is true. For the `=` form the
 * token becomes `--flag=<absolute>`. Other tokens are returned unchanged. cwd null → unchanged.
 * An empty value and a cwd that is not absolute are left alone too: resolving against them would
 * give the directory of the running process, not the session's.
 */
export function absolutizePathFlags(
  argv: readonly string[],
  cwd: string | null,
  exists: (path: string) => boolean,
): string[] {
  if (cwd === null || !posix.isAbsolute(cwd)) return [...argv];
  const absolute = (value: string): string => {
    if (value === '' || posix.isAbsolute(value)) return value;
    const resolved = posix.resolve(cwd, value);
    return exists(resolved) ? resolved : value;
  };

  const out = argv.slice(0, 1);
  for (const item of parseLaunchArgs(argv.slice(1))) {
    if (item.kind === 'flag' && item.spec?.path === true) {
      const equalsForm = item.tokens[0] !== item.name;
      if (equalsForm) {
        out.push(`${item.name}=${absolute(item.values[0] ?? '')}`);
      } else {
        out.push(item.name, ...item.values.map(absolute));
      }
    } else {
      out.push(...item.tokens);
    }
  }
  return out;
}

export interface ResumeCommand {
  argv: string[];
  flagsKnown: boolean;
}

/** `-n <label>` when there is a label (design 14: with `--resume` it names the resumed session). */
function labelArgs(label: string | null): string[] {
  return label === null || label === '' ? [] : ['-n', label];
}

/**
 * 7.6. `launch` is a recorded launch command (program first) or null.
 * Result: [claudeCommand, '--resume', sessionId, ...(label ? ['-n', label] : []),
 *          ...every kept token of launch.slice(1) in order].
 * Removed: flags with remove: true (with their values) and positionals. Unknown flags are kept with
 * their value. flagsKnown is false when launch is null. No permission flag is ever added.
 */
export function buildResumeCommand(input: {
  claudeCommand: string;
  launch: readonly string[] | null;
  sessionId: string;
  label: string | null;
}): ResumeCommand {
  const kept: string[] = [];
  if (input.launch !== null) {
    for (const item of parseLaunchArgs(input.launch.slice(1))) {
      if (item.kind === 'flag' && item.spec?.remove !== true) kept.push(...item.tokens);
    }
  }
  return {
    argv: [input.claudeCommand, '--resume', input.sessionId, ...labelArgs(input.label), ...kept],
    flagsKnown: input.launch !== null,
  };
}

/** 7.7: [claudeCommand, '--session-id', sessionId, ...(label ? ['-n', label] : []), ...extra]. */
export function buildNewCommand(input: {
  claudeCommand: string;
  sessionId: string;
  label: string | null;
  extra: readonly string[];
}): string[] {
  return [
    input.claudeCommand,
    '--session-id',
    input.sessionId,
    ...labelArgs(input.label),
    ...input.extra,
  ];
}
