/**
 * Claude Code's launch command line: a table of its flags, a parser for it, and the rewrites
 * skydeck applies to a recorded command (design 5.3 path flags, 7.6 resume, 7.7 new). Pure: file
 * existence is asked through a callback, and nothing outside `src/claude/` is imported.
 */
import { posix } from 'node:path';

import { isSessionId } from './session-id.ts';

/** The one session-id rule (`session-id.ts`), exported here as before. */
export { isSessionId };

export type FlagShape = 'none' | 'one' | 'optional' | 'many';
export interface FlagSpec {
  names: readonly string[]; // every spelling, long and short
  shape: FlagShape;
  remove: boolean; // removed when building a resume command (7.6)
  /**
   * The flag picks an existing session or replays one (`--resume`, `--continue`, `--fork-session`,
   * the deep-link flags, …), so `skydeck new` refuses it (7.7). Always a removed flag. A removed
   * flag that only says where or how a NEW session starts (`--worktree`, `--tmux`, the cloud flags)
   * is `false`: a resume drops it, but `new` may pass it.
   */
  picksSession: boolean;
  path: boolean; // values are paths made absolute at ingest (5.3)
}

/**
 * Claude Code 2.1.323 flags: every root flag the program declares, those hidden from
 * `claude --help` included. `test/fixtures/claude/flags-2.1.323.json` is Claude Code's own table;
 * a test compares the two.
 */
export const FLAGS: readonly FlagSpec[] = [
  // removed at resume (7.6)
  { names: ['-r', '--resume'], shape: 'optional', remove: true, picksSession: true, path: false },
  { names: ['-c', '--continue'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['--session-id'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--fork-session'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['-n', '--name'], shape: 'one', remove: true, picksSession: false, path: false },
  {
    names: ['-w', '--worktree'],
    shape: 'optional',
    remove: true,
    picksSession: false,
    path: false,
  },
  {
    names: ['--bg', '--background'],
    shape: 'none',
    remove: true,
    picksSession: false,
    path: false,
  },
  { names: ['--from-pr'], shape: 'optional', remove: true, picksSession: true, path: false },
  // they choose which session is opened or where it runs (D28); --tmux needs -w, which is removed
  { names: ['--tmux'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--teleport'], shape: 'optional', remove: true, picksSession: true, path: false },
  {
    names: ['--cloud', '--remote'],
    shape: 'optional',
    remove: true,
    picksSession: false,
    path: false,
  },
  { names: ['--desktop'], shape: 'none', remove: true, picksSession: false, path: false },
  {
    names: ['--environment', '--pool'],
    shape: 'one',
    remove: true,
    picksSession: false,
    path: false,
  },
  // they choose a session or act once (D28)
  { names: ['--rewind-files'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--resume-session-at'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--resume-drops-turn'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--reply-on-resume'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['--attach-serve'], shape: 'one', remove: true, picksSession: true, path: false },
  {
    names: ['--session-began-as-copy'],
    shape: 'one',
    remove: true,
    picksSession: true,
    path: false,
  },
  { names: ['--init-only'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--handle-uri'], shape: 'one', remove: true, picksSession: true, path: false },
  // they only work with the cloud flags above, which are removed
  { names: ['--ref'], shape: 'one', remove: true, picksSession: false, path: false },
  { names: ['--on-branch'], shape: 'one', remove: true, picksSession: false, path: false },
  { names: ['--correlation-id'], shape: 'one', remove: true, picksSession: false, path: false },
  {
    names: ['--forward-home-settings'],
    shape: 'one',
    remove: true,
    picksSession: false,
    path: false,
  },
  // one-time actions
  { names: ['--init'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--maintenance'], shape: 'none', remove: true, picksSession: false, path: false },
  // deep-link launches carry prompt text, which skydeck never stores (principle 4)
  { names: ['--deep-link-origin'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['--deep-link-repo'], shape: 'one', remove: true, picksSession: true, path: false },
  {
    names: ['--deep-link-last-fetch'],
    shape: 'one',
    remove: true,
    picksSession: true,
    path: false,
  },
  { names: ['--deep-link-cwd-b64'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--prefill'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--prefill-b64'], shape: 'one', remove: true, picksSession: true, path: false },
  // path flags (5.3), kept
  { names: ['--mcp-config'], shape: 'many', remove: false, picksSession: false, path: true },
  { names: ['--add-dir'], shape: 'many', remove: false, picksSession: false, path: true },
  { names: ['--settings'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--plugin-dir'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--plugin-dir-no-mcp'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--system-prompt-file'], shape: 'one', remove: false, picksSession: false, path: true },
  {
    names: ['--append-system-prompt-file'],
    shape: 'one',
    remove: false,
    picksSession: false,
    path: true,
  },
  {
    names: ['--append-subagent-system-prompt-file'],
    shape: 'one',
    remove: false,
    picksSession: false,
    path: true,
  },
  // kept, several values
  {
    names: ['--allowedTools', '--allowed-tools'],
    shape: 'many',
    remove: false,
    picksSession: false,
    path: false,
  },
  {
    names: ['--disallowedTools', '--disallowed-tools'],
    shape: 'many',
    remove: false,
    picksSession: false,
    path: false,
  },
  ...['--tools', '--betas', '--file', '--channels', '--dangerously-load-development-channels'].map(
    (name) => ({
      names: [name],
      shape: 'many' as const,
      remove: false,
      picksSession: false,
      path: false,
    }),
  ),
  // kept, one value
  ...[
    '--managed-settings',
    '--setting-sources',
    '--client-data-url',
    '--watch-artifact',
    '--watch-artifact-no-autoreact',
    '--team-name',
    '--agent-id',
    '--agent-name',
    '--agent-color',
    '--parent-session-id',
    '--lead-verify-key',
    '--agent-type',
    '--model',
    '--agent',
    '--routine',
    '--effort',
    '--fast-mode',
    '--permission-mode',
    '--inherit-permission-mode',
    '--proactivity',
    '--debug-file',
    '--system-prompt',
    '--append-system-prompt',
    '--system-prompt-snapshot',
    '--append-subagent-system-prompt',
    '--plan-mode-instructions',
    '--permission-prompt-tool',
    '--permission-prompts',
    '--json-schema',
    '--fallback-model',
    '--advisor',
    '--agents',
    '--plugin-url',
    '--remote-control-session-name-prefix',
    '--exec',
    '-m',
    '--sdk-url',
    '--thinking',
    '--thinking-display',
    '--max-thinking-tokens',
    '--max-turns',
    '--max-budget-usd',
    '--task-budget',
    '--autocompact',
    '--workload',
    '--output-format',
    '--input-format',
    '--teammate-mode',
    '--messaging-socket-path',
    '--project-config-root',
    '--runner-declares',
  ].map((name) => ({
    names: [name],
    shape: 'one' as const,
    remove: false,
    picksSession: false,
    path: false,
  })),
  // kept, optional value
  { names: ['-d', '--debug'], shape: 'optional', remove: false, picksSession: false, path: false },
  {
    names: ['--remote-control', '--rc'],
    shape: 'optional',
    remove: false,
    picksSession: false,
    path: false,
  },
  ...['--project', '--prompt-suggestions'].map((name) => ({
    names: [name],
    shape: 'optional' as const,
    remove: false,
    picksSession: false,
    path: false,
  })),
  // kept, no value
  { names: ['-p', '--print'], shape: 'none', remove: false, picksSession: false, path: false },
  { names: ['-h', '--help'], shape: 'none', remove: false, picksSession: false, path: false },
  {
    names: ['-v', '--version', '-V'],
    shape: 'none',
    remove: false,
    picksSession: false,
    path: false,
  },
  {
    names: ['-d2e', '--debug-to-stderr'],
    shape: 'none',
    remove: false,
    picksSession: false,
    path: false,
  },
  ...[
    '--verbose',
    '--bare',
    '--safe-mode',
    '--include-hook-events',
    '--include-partial-messages',
    '--forward-subagent-text',
    '--session-mirror',
    '--await-claim',
    '--await-initialize',
    '--managed-settings-in-initialize',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--replay-user-messages',
    '--host-auth-is-org-sign-in',
    '--enable-auth-status',
    '--restricted',
    '--allow-other-models',
    '--exclude-dynamic-system-prompt-sections',
    '--include-unsupported-models',
    '--no-session-persistence',
    '--ide',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--chrome',
    '--no-chrome',
    '--enable-auto-mode',
    '--agents-view-if-allowed',
    '--brief',
    '--ax-screen-reader',
    '--plan-mode-required',
    '--hard-fail',
  ].map((name) => ({
    names: [name],
    shape: 'none' as const,
    remove: false,
    picksSession: false,
    path: false,
  })),
];

const SPEC_BY_NAME: ReadonlyMap<string, FlagSpec> = new Map(
  FLAGS.flatMap((spec) => spec.names.map((name) => [name, spec] as const)),
);

export type ParsedArg =
  | { kind: 'flag'; spec: FlagSpec | null; name: string; tokens: string[]; values: string[] }
  | { kind: 'positional'; tokens: [string] };

/** Claude Code's parser calls a token a flag when it starts with '-' and has 2+ characters. */
function isFlagLike(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/** A token that can be taken as a value: present, not flag-like (a lone '-' is a value). */
function isPlainToken(token: string | undefined): boolean {
  return token !== undefined && !isFlagLike(token);
}

/** One flag token, read: which flag it is, and what of it is a value written in the same token. */
interface FlagToken {
  spec: FlagSpec | null; // null: a flag that is in no table
  specs: readonly FlagSpec[]; // every flag the token holds: several in a cluster, none if unknown
  name: string; // the flag as written, without a value glued to it
  glued: string | null; // the value glued to the flag in the same token, if any
  shape: FlagShape; // how many of the following tokens it takes when nothing is glued
  endsFlags: boolean; // the token ends in `--`: every token after it is positional
}

/** An unknown flag takes a following plain token, exactly as an optional-value flag does. */
const UNKNOWN_SHAPE: FlagShape = 'optional';

/**
 * `name`: as much of the token as can be classified (a short token: the unknown letter alone).
 * `read`: the flags of the token that were read before the unknown part. The token is unknown as a
 * whole (`spec` null), but `-cZ` did start with `-c`, and whoever must not miss that flag
 * (`skydeck new`, the print flag) finds it in `specs`.
 */
function unknownFlag(
  token: string,
  name: string = token,
  read: readonly FlagSpec[] = [],
): FlagToken {
  return {
    spec: null,
    specs: read,
    name,
    glued: null,
    shape: UNKNOWN_SHAPE,
    endsFlags: false,
  };
}

/** A cluster is represented by its first removable flag, else by its last. */
function representative(specs: readonly FlagSpec[]): FlagSpec | null {
  return specs.find((spec) => spec.remove) ?? specs.at(-1) ?? null;
}

/**
 * `--name`, `--name=value`, `-x`, `-xvalue`, `-xyz` (a cluster of short flags). A token that is a
 * flag's own name is that flag, whatever its length (`-d2e`). Otherwise a short token is read
 * letter by letter as Claude Code's own parser reads it:
 * - a value-taking flag ends the cluster and takes the rest of the token, `=` included, as its
 *   value when there is a rest;
 * - after a no-value flag, a '-' starts a new token: the rest of the token with one more '-' in
 *   front. `-c-model` is `-c --model`, and `-c-` is `-c --`, which ends the flags;
 * - a letter that is not in the table makes the whole token an unknown flag, named by that letter
 *   alone (a long flag that is not in the table, by its name).
 * A cluster is represented by its first removable flag, else by its last.
 */
function readFlagToken(token: string): FlagToken {
  const exact = SPEC_BY_NAME.get(token);
  if (exact !== undefined) {
    return {
      spec: exact,
      specs: [exact],
      name: token,
      glued: null,
      shape: exact.shape,
      endsFlags: false,
    };
  }

  if (token.startsWith('--')) {
    // `--name=value`: the `=` must come after a name of at least one character.
    const equals = token.indexOf('=');
    if (equals > 2) {
      const name = token.slice(0, equals);
      const spec = SPEC_BY_NAME.get(name) ?? null;
      const specs = spec === null ? [] : [spec];
      const glued = token.slice(equals + 1);
      return { spec, specs, name, glued, shape: 'none', endsFlags: false };
    }
    return unknownFlag(token);
  }

  const specs: FlagSpec[] = [];
  for (let letter = 1; letter < token.length; letter += 1) {
    const spec = SPEC_BY_NAME.get(`-${token[letter]}`);
    if (spec === undefined) {
      const name = `-${String.fromCodePoint(token.codePointAt(letter) as number)}`;
      return unknownFlag(token, name, specs);
    }
    specs.push(spec);
    if (spec.shape !== 'none') {
      const rest = token.slice(letter + 1);
      const glued = rest === '' ? null : rest;
      const name = token.slice(0, letter + 1);
      return {
        spec: representative(specs),
        specs,
        name,
        glued,
        shape: spec.shape,
        endsFlags: false,
      };
    }
    if (token[letter + 1] === '-') {
      const inner = readNewToken(`-${token.slice(letter + 1)}`);
      if (inner.endsFlags) {
        return {
          spec: representative(specs),
          specs,
          name: token,
          glued: null,
          shape: 'none',
          endsFlags: true,
        };
      }
      if (inner.spec === null) return { ...inner, specs: [...specs, ...inner.specs] };
      const all = [...specs, ...inner.specs];
      const name =
        inner.glued === null ? token : token.slice(0, token.length - inner.glued.length - 1);
      return {
        spec: representative(all),
        specs: all,
        name,
        glued: inner.glued,
        shape: inner.shape,
        endsFlags: false,
      };
    }
    if (letter === token.length - 1) {
      return {
        spec: representative(specs),
        specs,
        name: token,
        glued: null,
        shape: 'none',
        endsFlags: false,
      };
    }
  }
  return unknownFlag(token);
}

/** The token a cluster hands on after a no-value flag: `--` (end of the flags) or a long flag. */
function readNewToken(token: string): FlagToken {
  if (token === '--') {
    return { spec: null, specs: [], name: token, glued: null, shape: 'none', endsFlags: true };
  }
  return readFlagToken(token);
}

/** The end (exclusive) of the tokens a flag at args[start - 1] takes as values, by its shape. */
function valuesEnd(args: readonly string[], start: number, shape: FlagShape): number {
  switch (shape) {
    case 'none':
      return start;
    case 'one':
      return Math.min(start + 1, args.length);
    case 'optional':
      return isPlainToken(args[start]) ? start + 1 : start;
    case 'many': {
      // The first value is taken whatever it is; the others up to the next flag-like token.
      let end = Math.min(start + 1, args.length);
      while (isPlainToken(args[end])) end += 1;
      return end;
    }
  }
}

/**
 * Parses arguments (WITHOUT the program name) with FLAGS (D18), the way Claude Code's parser does:
 * - `--name=value` (long flags): one token, `values` [value], consumes nothing more; `name` is the
 *   flag as written before the `=`;
 * - a short flag glued to its value (`-rabc`) is one token that takes nothing more; a cluster of
 *   short flags (`-cp`, `-c-model`, `-c-`) is one token (see readFlagToken), and `-c-` ends the
 *   flags; `name` is the token without the value;
 * - shape none: no value; one: the next token whatever it is; optional: the next token if it
 *   exists and is not flag-like; many: the next token whatever it is, then every following token up
 *   to the next flag-like one — a token is flag-like when it starts with '-' and has more than one
 *   character, so a lone '-' is a value;
 * - an unknown flag is a flag with spec null; it takes the next token as its value when that
 *   exists and is not flag-like;
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
    if (!isFlagLike(token)) {
      items.push({ kind: 'positional', tokens: [token] });
      i += 1;
      continue;
    }
    const flag = readFlagToken(token);
    const end = flag.glued === null ? valuesEnd(args, i + 1, flag.shape) : i + 1;
    const tokens = args.slice(i, end);
    items.push({
      kind: 'flag',
      spec: flag.spec,
      name: flag.name,
      tokens,
      values: flag.glued === null ? tokens.slice(1) : [flag.glued],
    });
    i = end;
    if (flag.endsFlags) {
      for (const rest of args.slice(i)) items.push({ kind: 'positional', tokens: [rest] });
      break;
    }
  }
  return items;
}

/**
 * 5.3: in a full launch command (program first), each value of a flag with `path: true` that is
 * relative is replaced by resolve(cwd, value) when `exists(resolved)` is true. For the `=` form the
 * token becomes `--flag=<absolute>`. Other tokens are returned unchanged. cwd null → unchanged.
 * An empty value and a cwd that is not absolute are left alone too: resolving against them would
 * give the directory of the running process, not the session's. An `exists` that throws counts as
 * false and the value stays as written: a path-flag value can be inline JSON, longer than a file
 * name may be, or hold a NUL, and a stat then fails with something other than "not found".
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
    try {
      return exists(resolved) ? resolved : value;
    } catch {
      return value;
    }
  };

  const out = argv.slice(0, 1);
  for (const item of parseLaunchArgs(argv.slice(1))) {
    if (item.kind === 'flag' && item.spec?.path === true) {
      // The path flags are long flags, so a value glued to one is written `--flag=value`.
      const glued = item.tokens[0] !== item.name;
      if (glued) {
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

/** The tokens of `args` (WITHOUT the program name) that a resume passes on: known, not removed. */
function passedOnTokens(args: readonly string[]): string[] {
  return parseLaunchArgs(args).flatMap((item) =>
    item.kind === 'flag' && item.spec !== null && !item.spec.remove ? item.tokens : [],
  );
}

/**
 * The flags of a recorded or a stored command (program first) that a resume passes on again, with
 * their values, in order — what `buildResumeCommand` puts after the session id and the label: no
 * program, no removed flag, no flag that is in no table (`unknownFlags` names those), nothing after
 * `--`. The same for a command and for `storableArgv` of it. Follow-up F16: the window's header
 * shows them as the flags the session was started with.
 */
export function passedOnFlags(launch: readonly string[]): string[] {
  return passedOnTokens(launch.slice(1));
}

/**
 * What skydeck stores of a recorded launch command (design 5.3, principle 4): the program (first
 * element) and the flags, with their values, that a resume keeps — in order. Positional arguments
 * (an initial prompt), `--` and everything after it, and every flag with `remove: true` (with its
 * values) are dropped, so a prompt reaches the database neither as a positional argument nor inside
 * a removed flag such as `--prefill-b64`. A flag that is in no table is stored as its bare name
 * (`--flag=value` as `--flag`, `-cZfix` as `-Z`): what follows it cannot be classified, and skydeck
 * never stores text it cannot classify, but the name lets a resume say the flag was not passed on
 * (`unknownFlags`).
 * [] for an empty command. `buildResumeCommand` gives the same result for a command and for
 * `storableArgv` of it.
 */
export function storableArgv(argv: readonly string[]): string[] {
  const stored = argv.slice(0, 1);
  for (const item of parseLaunchArgs(argv.slice(1))) {
    if (item.kind !== 'flag') continue;
    if (item.spec === null) stored.push(item.name);
    else if (!item.spec.remove) stored.push(...item.tokens);
  }
  return stored;
}

/**
 * The names of the flags in a recorded or a stored command (program first) that are in no table, in
 * order, each once. A `--flag=value` is named `--flag`; a short token with an unknown letter is
 * named by that letter alone (`-cZfix` is `-Z`). A resume does not pass these on.
 */
export function unknownFlags(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (const item of parseLaunchArgs(argv.slice(1))) {
    if (item.kind === 'flag' && item.spec === null && !names.includes(item.name)) {
      names.push(item.name);
    }
  }
  return names;
}

/**
 * Whether a recorded launch command (program first) has the print flag (`-p`, `--print`), alone or
 * inside a cluster of short flags such as `-cp`. A `-p` that is the value of another flag, or
 * comes after `--`, is not the flag. Ask it of the RECORDED command: `storableArgv` drops a cluster
 * with a removed flag (`-cp`) as a whole.
 */
export function isPrintRun(argv: readonly string[]): boolean {
  const print = SPEC_BY_NAME.get('-p');
  if (print === undefined) return false;
  // A token with an unknown letter is not counted, although `specs` holds what was read before it.
  return parseLaunchArgs(argv.slice(1)).some(
    (item) =>
      item.kind === 'flag' &&
      item.spec !== null &&
      readFlagToken(item.tokens[0] as string).specs.includes(print),
  );
}

/** A flag found in an argument list: as written (a cluster of short flags: the whole token), and its table entry. */
export interface FoundFlag {
  written: string;
  spec: FlagSpec;
}

/** Every flag of `args` (WITHOUT the program name), each flag of a cluster such as `-cp` on its own. */
function flagsIn(args: readonly string[]): FoundFlag[] {
  return parseLaunchArgs(args).flatMap((item) => {
    if (item.kind !== 'flag') return [];
    // An unknown token's `name` is the unknown part alone; the flags read before it are in the token.
    const written = item.spec === null ? (item.tokens[0] as string) : item.name;
    return readFlagToken(item.tokens[0] as string).specs.map((spec) => ({ written, spec }));
  });
}

/**
 * The flags in `args` (WITHOUT the program name) that pick an existing session (`picksSession`), in
 * order: alone, as `--flag=value`, or inside a cluster of short flags (`-cp`; `written` is then the
 * whole token). The flags read before the first unknown letter of a cluster count (`-cZ`,
 * `-c-frob`): the token is unknown to the parser, but it does start with `-c`. A flag that is
 * another flag's value, or comes after `--`, is not one. `skydeck new`
 * refuses these (7.7); `--worktree` and the other flags that say where a new session starts are not.
 */
export function sessionPickingFlags(args: readonly string[]): FoundFlag[] {
  return flagsIn(args).filter((found) => found.spec.picksSession);
}

/** The `--name` / `-n` flags in `args`, found the way `sessionPickingFlags` finds its flags. */
export function nameFlags(args: readonly string[]): FoundFlag[] {
  return flagsIn(args).filter((found) => found.spec.names.includes('--name'));
}

export interface ResumeCommand {
  argv: string[];
  flagsKnown: boolean;
}

/**
 * The id goes onto a command line after `--resume` or `--session-id`, where a value such as
 * `--dangerously-skip-permissions` would be read as a flag: only a lowercase UUID is built into a
 * command, whatever the caller checked.
 */
function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new RangeError(`not a session id (a lowercase UUID): ${JSON.stringify(sessionId)}`);
  }
}

/** `-n <label>` when there is a label (design 14: with `--resume` it names the resumed session). */
function labelArgs(label: string | null): string[] {
  return label === null || label === '' ? [] : ['-n', label];
}

/**
 * 7.6. `launch` is a recorded launch command (program first) or null.
 * Result: [claudeCommand, '--resume', sessionId, ...(label ? ['-n', label] : []),
 *          ...every kept token of launch.slice(1) in order].
 * Removed: flags with remove: true (with their values), positionals, and flags that are in no table
 * (with what follows them; `unknownFlags` names them). flagsKnown is false when launch is null. No
 * permission flag is ever added. Throws RangeError when sessionId is not a lowercase UUID.
 */
export function buildResumeCommand(input: {
  claudeCommand: string;
  launch: readonly string[] | null;
  sessionId: string;
  label: string | null;
}): ResumeCommand {
  assertSessionId(input.sessionId);
  const kept = input.launch === null ? [] : passedOnFlags(input.launch);
  return {
    argv: [input.claudeCommand, '--resume', input.sessionId, ...labelArgs(input.label), ...kept],
    flagsKnown: input.launch !== null,
  };
}

/**
 * 7.7: [claudeCommand, '--session-id', sessionId, ...(label ? ['-n', label] : []), ...extra].
 * Throws RangeError when sessionId is not a lowercase UUID.
 */
export function buildNewCommand(input: {
  claudeCommand: string;
  sessionId: string;
  label: string | null;
  extra: readonly string[];
}): string[] {
  assertSessionId(input.sessionId);
  return [
    input.claudeCommand,
    '--session-id',
    input.sessionId,
    ...labelArgs(input.label),
    ...input.extra,
  ];
}
