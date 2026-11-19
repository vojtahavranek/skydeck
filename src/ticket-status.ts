/**
 * Follow-up F19: a ticket's status (S2 10.2, 12.3, 12.5, 16.4; design 7.1). The configured command
 * and its answer (which provider reads an address is github.ts's `statusProvider`, so that the
 * list model can ask it without importing this file), when a status is due again, and the fetch that saves the results in the store, one row
 * per address. Only `Runner`, `Clock` and `Store` reach the outside world, so a test answers with
 * a fake runner and never runs a program; the window's and the commands' callers pass the real
 * ones. A configured program is run as the user: as a list of words, never through a shell, stdin
 * closed, the user's home as its directory, the caller's environment, 10 seconds, at most 4 KiB
 * of each output read.
 */
import { basename } from 'node:path';

import { fetchIssueStatuses, statusProvider } from './github.ts';
import type { PrKey } from './github.ts';
import type { TicketStatusRule } from './platform/config.ts';
import { nsFromMs } from './platform/time.ts';
import type { Clock, Env, Ns, RunOptions, RunResult, Runner } from './platform/types.ts';
import { ticketKeyOf } from './sessions/ticket.ts';
import type { Store } from './store/store.ts';
import { TICKET_CATEGORIES } from './store/types.ts';
import type { TicketStatusResult, TicketStatusRow } from './store/types.ts';
import { sanitize } from './text/sanitize.ts';

/** T2 b: a status command's time limit, and how much of each of its outputs is read. */
export const STATUS_TIMEOUT_MS = 10_000;
export const STATUS_OUTPUT_BYTES = 4096;
/** T2 b: the longest status text kept, in characters. */
export const STATUS_TEXT_LENGTH = 40;
/** T4: the most status commands one round of the tick starts. */
export const COMMANDS_PER_ROUND = 5;
/** T4: how often a ticket whose category is done or closed is read again. */
export const FINISHED_REFRESH_HOURS = 12;
/** The longest failure's words kept from a program's stderr, in characters (its first line). */
const ERROR_LENGTH = 200;

const MS_PER_MINUTE = 60_000;

/** The two placeholders of a command's arguments. */
const PLACEHOLDERS = /\{url\}|\{key\}/g;

/**
 * T2 b: the program and the arguments of `rule` for `url`: in each argument (never in the
 * program) every `{url}` becomes the address and every `{key}` the ticket's key (ticketKeyOf), in one
 * pass, so that what was put in is not read again. Each argument stays one argument, whatever the
 * address holds: nothing is split, quoted or given to a shell.
 */
export function statusCommand(
  rule: TicketStatusRule,
  url: string,
  key: string,
): { program: string; args: string[] } {
  const [program = '', ...rest] = rule.command;
  return {
    program,
    args: rest.map((arg) => arg.replace(PLACEHOLDERS, (found) => (found === '{url}' ? url : key))),
  };
}

/** A line of a program's output as text: sanitised (design 7.4), trimmed. */
function cleaned(line: string): string {
  return sanitize(line).trim();
}

/** `text` cut to its first `length` characters (code points), with `…` when cut and `mark`. */
function cutTo(text: string, length: number, mark: boolean): string {
  const characters = [...text];
  if (characters.length <= length) return text;
  return mark
    ? `${characters.slice(0, length - 1).join('')}…`
    : characters.slice(0, length).join('').trimEnd();
}

/** The first line of `text` that has anything on it once cleaned; null when there is none. */
function firstCleanLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const clean = cleaned(line);
    if (clean !== '') return cutTo(clean, ERROR_LENGTH, true);
  }
  return null;
}

/**
 * T2 b, the answer's contract: a run that timed out, whose program is missing, that exited other
 * than 0 or was killed, or whose first line of stdout is empty once cleaned, is a failure — "the
 * status command timed out after 10 s", "the status command <name> is not installed" (`program`'s
 * last part), the first cleaned line of stderr (at most 200 characters) or "the status command
 * exited <n>" ("… was killed by a signal"), "the status command printed no status". Else the
 * first line (a CR at its end dropped, sanitised, trimmed, its first 40 characters) is the
 * status, and the second line, when it is one of the six words once trimmed and in lower case,
 * its category; anything else is no category, and the other lines are not read.
 */
export function readStatusAnswer(result: RunResult, program: string, atNs: Ns): TicketStatusResult {
  const fail = (error: string): TicketStatusResult => ({ ok: false, atNs, error });
  if (result.timedOut) {
    return fail(`the status command timed out after ${STATUS_TIMEOUT_MS / 1000} s`);
  }
  if (result.notFound) return fail(`the status command ${basename(program)} is not installed`);
  if (result.code !== 0) {
    return fail(
      firstCleanLine(result.stderr) ??
        (result.code === null
          ? 'the status command was killed by a signal'
          : `the status command exited ${result.code}`),
    );
  }
  const [first = '', second] = result.stdout.split('\n');
  const status = cutTo(cleaned(first), STATUS_TEXT_LENGTH, false);
  if (status === '') return fail('the status command printed no status');
  const word = second === undefined ? '' : cleaned(second).toLowerCase();
  const category = TICKET_CATEGORIES.find((candidate) => candidate === word) ?? null;
  return { ok: true, atNs, status, category };
}

/**
 * T4: the addresses of `urls` whose status is due, each once, in their order: never tried (no row
 * in `rows`), or last tried more than `refreshMinutes` ago — for one whose category is done or
 * closed, more than 12 hours ago. The last attempt counts, not the last success, so that a status
 * that keeps failing is asked for at that pace and not at every round.
 */
export function statusesDue(
  urls: readonly string[],
  rows: ReadonlyMap<string, TicketStatusRow>,
  nowNs: Ns,
  refreshMinutes: number,
): string[] {
  const usual = nsFromMs(Math.round(refreshMinutes * MS_PER_MINUTE));
  const finished = nsFromMs(FINISHED_REFRESH_HOURS * 60 * MS_PER_MINUTE);
  return [...new Set(urls)].filter((url) => {
    const row = rows.get(url);
    if (row === undefined) return true;
    const done = row.category === 'done' || row.category === 'closed';
    return row.triedAtNs < nowNs - (done ? finished : usual);
  });
}

export interface StatusDeps {
  runner: Runner;
  clock: Clock;
  /** The caller's environment (`platform.env`): a command runs in it, `gh` as the pull requests'. */
  env: Env;
  store: Store;
  /** The user's home: a command's working directory. */
  homeDir: string;
  /** The configuration's `ticketStatus`. */
  rules: readonly TicketStatusRule[];
  /** The configuration's `ticketUrl`, for `{key}` (ticketKeyOf: the key it puts in an address). */
  ticketUrl: string | null;
}

/** The environment as a child's whole environment: its variables that have a value. */
function childEnvironment(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** A rule's command uses `{key}` in one of its arguments (never in the program, T2 b). */
function usesKey(rule: TicketStatusRule): boolean {
  return rule.command.slice(1).some((arg) => arg.includes('{key}'));
}

/** Review 2 (ruled): the read of an address that gives no key for a command that needs one. */
export const NO_KEY = "the ticket's address gives no key for {key}; use {url} in the rule";

/**
 * One run of a status command for `url`; a runner that rejects (not executable) is a failure.
 * `{key}` is the ticket's key (ticketKeyOf); when the command uses `{key}` and the address gives
 * none, the program is not run and the read fails (NO_KEY), the old status kept.
 */
async function runCommand(
  deps: StatusDeps,
  rule: TicketStatusRule,
  url: string,
  signal: AbortSignal | undefined,
): Promise<TicketStatusResult> {
  const key = ticketKeyOf(url, deps.ticketUrl);
  if (key === null && usesKey(rule)) {
    return { ok: false, atNs: deps.clock.nowNs(), error: NO_KEY };
  }
  const { program, args } = statusCommand(rule, url, key ?? '');
  const options: RunOptions = {
    cwd: deps.homeDir,
    timeoutMs: STATUS_TIMEOUT_MS,
    env: childEnvironment(deps.env),
    maxOutputBytes: STATUS_OUTPUT_BYTES,
  };
  if (signal !== undefined) options.signal = signal;
  try {
    return readStatusAnswer(
      await deps.runner.run(program, args, options),
      program,
      deps.clock.nowNs(),
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    const reason = firstCleanLine(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      atNs: deps.clock.nowNs(),
      error: `the status command could not be run: ${reason ?? 'unknown error'}`,
    };
  }
}

/**
 * T2, T4: reads the status of each of `urls` that a provider takes (each address once) and saves
 * every result with store.saveTicketStatus, telling `saved` after each save. The GitHub issues
 * first, in batches through `gh` (fetchIssueStatuses: two addresses of one issue are asked once,
 * and both saved), then the commands one at a time, in order, at most `maxCommands` of them (the
 * rest is left for a later round). A failure is a failed result saved, never an exception. Once
 * `signal` has fired nothing more is saved and nothing more starts; the counts are those saved.
 */
export async function fetchTicketStatuses(
  deps: StatusDeps,
  urls: readonly string[],
  options: { signal?: AbortSignal; maxCommands?: number; saved?: () => void } = {},
): Promise<{ fetched: number; failed: number }> {
  const { signal } = options;
  const stopped = (): boolean => signal?.aborted === true;
  let fetched = 0;
  let failed = 0;
  const save = (url: string, result: TicketStatusResult): void => {
    deps.store.saveTicketStatus(url, result);
    if (result.ok) fetched++;
    else failed++;
  };
  const issues = new Map<string, string[]>(); // the issue's key url → the addresses of it
  const keys: PrKey[] = [];
  const commands: [string, TicketStatusRule][] = [];
  for (const url of new Set(urls)) {
    const provider = statusProvider(url, deps.rules);
    if (provider?.kind === 'command') {
      commands.push([url, provider.rule]);
    } else if (provider?.kind === 'github') {
      const of = issues.get(provider.key.url);
      if (of === undefined) {
        issues.set(provider.key.url, [url]);
        keys.push(provider.key);
      } else {
        of.push(url);
      }
    }
  }
  if (keys.length > 0 && !stopped()) {
    const results = await fetchIssueStatuses(deps, keys, signal === undefined ? {} : { signal });
    if (!stopped() && results.size > 0) {
      deps.store.transaction(() => {
        for (const [keyUrl, result] of results) {
          for (const url of issues.get(keyUrl) ?? []) save(url, result);
        }
      });
      options.saved?.();
    }
  }
  const limit = options.maxCommands ?? commands.length;
  for (const [url, rule] of commands.slice(0, limit)) {
    if (stopped()) break;
    let result: TicketStatusResult;
    try {
      result = await runCommand(deps, rule, url, signal);
    } catch (error) {
      if (stopped()) break;
      throw error;
    }
    if (stopped()) break; // the caller has gone: what arrived is not wanted
    save(url, result);
    options.saved?.();
  }
  return { fetched, failed };
}
