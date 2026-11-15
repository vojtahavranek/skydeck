// `skydeck doctor` (design 8): checks the installation and reports one line per check, `ok`, `info`
// or `problem`, exiting 1 when anything is a problem. It does not refresh: the spool is counted as
// it is, and what the last refresh skipped is read from kv where that refresh recorded it. It
// creates nothing, and it reports what it can however broken the rest is (ruled by the plan
// owner): a configuration that cannot be read, or a database that is missing or cannot be opened,
// is one problem line, and the checks that do not need it still run.
//
// Then the window's lines (S2 16.3, src/cli/window-checks.ts). Ruled by the plan owner (task 24):
// while the window has never been used — no window_secret, or no database to read it from — every
// one of them that would be a problem is `info`, so that doctor exits for the commands as step 1's
// did; once it was used they count as problems.
import { join } from 'node:path';

import { checkNodeVersion } from '../../../bin/node-version.mjs';
import { lookAtClaudeFolders } from '../../claude/folders.ts';
import { HOOK_EVENTS, hookStatus, settingsPath } from '../../claude/settings.ts';
import type { Config } from '../../platform/config.ts';
import { SkydeckError } from '../../platform/errors.ts';
import { resolvePlaces } from '../../platform/paths.ts';
import type { Places } from '../../platform/paths.ts';
import type { Env, Ns, Platform, RunResult } from '../../platform/types.ts';
import { resolveDeckPlaces } from '../../sessions/deck.ts';
import { describeError } from '../../sessions/problems.ts';
import { openStore } from '../../store/store.ts';
import type { Store } from '../../store/store.ts';
import { formatAge } from '../../text/age.ts';
import { sanitize } from '../../text/sanitize.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { EXIT } from '../exit.ts';
import { WINDOW_CHECKS, windowView } from '../window-checks.ts';
import type { WindowCheck, WindowView } from '../window-checks.ts';

const SPEC: ArgSpec = {
  usage:
    'skydeck doctor\n' +
    '\n' +
    'Checks the configuration, the hook entries and links, Node.js, the database, the spool,\n' +
    "hook.log, what the last refresh skipped, Claude Code's folders, gh and the terminal, then\n" +
    'what the window needs (python3, its server, the port, the keep-alive, Edge, the runtime\n' +
    'directory, the vendored files) and its terminals. One line per check; exits 1 when any\n' +
    'line is a problem (a line of the window only once the window has been used).\n',
  flags: {},
  min: 0,
  max: 0,
};

type Kind = 'ok' | 'info' | 'problem';
type Report = (kind: Kind, text: string) => void;

/** What the checks look at; `config` and `store` are null when they could not be had. */
interface Facts {
  platform: Platform;
  places: Places;
  config: Config | null;
  store: Store | null;
}
type Async = void | Promise<void>;

/**
 * A check that needs the configuration (for claudeHome or the terminal) or the database is skipped
 * when that could not be had: a problem line has already said why.
 */
type Check =
  | { name: string; needs: 'nothing'; run(facts: Facts, report: Report): Async }
  | { name: string; needs: 'config'; run(facts: Facts & { config: Config }, report: Report): Async }
  | { name: string; needs: 'store'; run(facts: Facts & { store: Store }, report: Report): Async };

/** More waiting spool files than this means nothing has read the spool for a long time. */
const SPOOL_LIMIT = 1000;
/** hook.log is read from its end; its last lines are all doctor shows. */
const LOG_TAIL_BYTES = 16 * 1024;
const LOG_LINES = 5;
const PROGRAM_TIMEOUT_MS = 10_000;

export const command: Command = {
  name: 'doctor',
  summary: 'Check the installation',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    let problems = 0;
    const report: Report = (kind, text) => {
      if (kind === 'problem') {
        problems++;
      }
      // Paths, log lines, messages and program output are foreign text (design 7.4).
      ctx.io.stdout(`${kind.padEnd(9)}${sanitize(text)}\n`);
    };
    const { platform } = ctx;
    const { places, config } = readConfiguration(platform, report);
    const store = openDatabase(platform, places, report);
    try {
      for (const check of CHECKS) {
        try {
          await runCheck(check, { platform, places, config, store }, report);
        } catch (error) {
          // A doctor that stops at the first surprise shows least when most is wrong, so whatever a
          // check throws, the database's own failures included, is one problem line and the next
          // check runs. (There is no per-item loop here that could wait the busy timeout many times.)
          report('problem', `${check.name}: could not be checked (${describeError(error)})`);
        }
      }
      const view = windowView({ platform, places, config, store });
      const windowReport: Report = (kind, text) => {
        report(kind === 'problem' && !view.used ? 'info' : kind, text);
      };
      for (const check of WINDOW_CHECKS) {
        try {
          await runWindowCheck(check, view, windowReport);
        } catch (error) {
          windowReport('problem', `${check.name}: could not be checked (${describeError(error)})`);
        }
      }
    } finally {
      try {
        store?.close();
      } catch {
        // nothing was left to write; an error here must not hide the report
      }
    }
    return problems > 0 ? EXIT.failure : EXIT.ok;
  },
};

/**
 * config.json, read as every command reads it. When it cannot be, that is a problem, and the places
 * that do not depend on it (all but claudeHome) come from the environment alone.
 */
function readConfiguration(
  platform: Platform,
  report: Report,
): { places: Places; config: Config | null } {
  try {
    return resolveDeckPlaces(platform);
  } catch (error) {
    report('problem', `configuration: ${messageOf(error)}; the checks that need it are skipped`);
    return { places: resolvePlaces(platform.env, platform.homeDir, null), config: null };
  }
}

/** The database as it is: never created here. Missing or not openable is a problem. */
function openDatabase(platform: Platform, places: Places, report: Report): Store | null {
  const { dbPath } = places;
  try {
    if (platform.files.stat(dbPath) === null) {
      report('problem', `database ${dbPath} does not exist; run skydeck install`);
      return null;
    }
    return openStore(dbPath);
  } catch (error) {
    report(
      'problem',
      `database ${dbPath} cannot be opened (${messageOf(error)}); the checks that need it are skipped`,
    );
    return null;
  }
}

/** A SkydeckError's own message (it names what is wrong); for anything else, describeError. */
function messageOf(error: unknown): string {
  return error instanceof SkydeckError ? error.message : describeError(error);
}

async function runCheck(check: Check, facts: Facts, report: Report): Promise<void> {
  const { config, store } = facts;
  switch (check.needs) {
    case 'nothing':
      await check.run(facts, report);
      return;
    case 'config':
      if (config !== null) {
        await check.run({ ...facts, config }, report);
      }
      return;
    case 'store':
      if (store !== null) {
        await check.run({ ...facts, store }, report);
      }
      return;
  }
}

/** A window check runs only with what it needs (doctor has said why it is missing). */
async function runWindowCheck(check: WindowCheck, view: WindowView, report: Report): Promise<void> {
  if (check.needs === 'config' && view.facts.config === null) return;
  if (check.needs === 'deck' && view.deck === null) return;
  await check.run(view, report);
}

const CHECKS: readonly Check[] = [
  { name: 'hook entries', needs: 'config', run: checkHookEntries },
  { name: 'hook link', needs: 'nothing', run: checkHookLink },
  { name: 'Node.js', needs: 'nothing', run: checkNode },
  { name: 'database', needs: 'store', run: checkDatabase },
  { name: 'spool', needs: 'nothing', run: checkSpool },
  { name: 'last event', needs: 'store', run: checkLastEvent },
  { name: 'spool/bad', needs: 'nothing', run: checkBadFiles },
  { name: 'hook.log', needs: 'nothing', run: checkHookLog },
  { name: 'scripted runs', needs: 'store', run: checkScripted },
  { name: 'last refresh', needs: 'store', run: checkRefreshProblems },
  { name: "Claude Code's folders", needs: 'config', run: checkClaudeFolders },
  { name: 'gh', needs: 'nothing', run: checkGh },
  { name: 'terminal', needs: 'config', run: checkTerminal },
];

/** Design 8: both hook entries present, one problem line per event without its entry. */
function checkHookEntries({ platform, places }: Facts, report: Report): void {
  const { hookPath, claudeHome } = places;
  const path = settingsPath(claudeHome);
  const status = hookStatus(platform.files.readText(path), hookPath);
  const missing = HOOK_EVENTS.filter((event) => !status[event]);
  if (missing.length === 0) {
    report('ok', `hook entries present in ${path}`);
  }
  for (const event of missing) {
    report('problem', `no ${event} hook entry for ${hookPath} in ${path}; run skydeck install`);
  }
}

/** `<hookPath>` resolves to a regular file (the link is not dangling). */
function checkHookLink({ platform, places }: Facts, report: Report): void {
  const { files } = platform;
  const { hookPath } = places;
  if (files.stat(hookPath)?.kind === 'file') {
    report('ok', `${hookPath} -> ${files.realpath(hookPath) ?? hookPath}`);
  } else {
    report('problem', `${hookPath} does not resolve to a file; run skydeck install`);
  }
}

function checkNode({ platform }: Facts, report: Report): void {
  const { nodeVersion, nodePath } = platform;
  const message = checkNodeVersion(nodeVersion);
  if (message === undefined) {
    report('ok', `Node.js ${nodeVersion} (${nodePath})`);
  } else {
    report('problem', message);
  }
}

function checkDatabase({ platform, store }: Facts & { store: Store }, report: Report): void {
  try {
    store.setKv('doctor_probe', String(platform.clock.nowNs()));
    report('ok', `database ${store.path} is writable`);
  } catch (error) {
    report('problem', `database ${store.path} is not writable (${describeError(error)})`);
  }
}

/** The `.ev` files waiting in the spool: what the next refresh would read. */
function spoolFiles({ platform, places }: Facts): string[] {
  return platform.files
    .list(places.spoolDir)
    .filter((name) => !name.startsWith('.') && name.endsWith('.ev'));
}

function checkSpool(facts: Facts, report: Report): void {
  const count = spoolFiles(facts).length;
  const text = `spool: ${plural(count, 'event')} waiting to be read`;
  if (count > SPOOL_LIMIT) {
    report('problem', `${text} (more than ${SPOOL_LIMIT}: has skydeck not run for a long time?)`);
  } else {
    report('info', text);
  }
}

/**
 * The newest event the hook wrote, stored or still in the spool (a spool file's name starts with
 * its time). Events reconcile made up (`observed`) are not the hook's and do not count.
 */
function checkLastEvent(facts: Facts & { store: Store }, report: Report): void {
  let last: Ns | null =
    facts.store
      .events()
      .filter((event) => event.spoolName !== null)
      .at(-1)?.timeNs ?? null;
  for (const name of spoolFiles(facts)) {
    const time = /^(\d+)-/.exec(name)?.[1];
    if (time !== undefined && (last === null || BigInt(time) > last)) {
      last = BigInt(time);
    }
  }
  report(
    'info',
    last === null
      ? 'no events yet'
      : `last event ${formatAge(facts.platform.clock.nowNs() - last)} ago`,
  );
}

/** Files ingest could not read (design 5.3), with their age range: ingest removes them after seven days. */
function checkBadFiles({ platform, places }: Facts, report: Report): void {
  const { files, clock } = platform;
  const { badDir } = places;
  const names = files.list(badDir);
  if (names.length === 0) {
    report('ok', `${badDir}: no files that could not be read`);
    return;
  }
  const now = clock.nowNs();
  const ages = names
    .map((name) => files.lstat(join(badDir, name)))
    .filter((info) => info !== null)
    .map((info) => now - info.mtimeNs)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const youngest = formatAge(ages[0] ?? 0n);
  const oldest = formatAge(ages.at(-1) ?? 0n);
  const range = youngest === oldest ? youngest : `${youngest} to ${oldest}`;
  report(
    'problem',
    `${badDir}: ${plural(names.length, 'file')} that could not be read, ${range} old; they are removed after seven days`,
  );
}

/** The last lines of hook.log, where the hook writes why it dropped an event. */
function checkHookLog({ platform, places }: Facts, report: Report): void {
  const { files } = platform;
  const { hookLog } = places;
  const size = files.stat(hookLog)?.size ?? 0;
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  const text = size === 0 ? '' : new TextDecoder().decode(files.readBytes(hookLog, start, size));
  // A tail that starts inside the file may start inside a line: that line is not shown.
  const lines = text
    .split('\n')
    .slice(start > 0 ? 1 : 0)
    .filter((line) => line.trim() !== '')
    .slice(-LOG_LINES);
  if (lines.length === 0) {
    report('info', 'hook.log is empty');
  }
  for (const line of lines) {
    report('info', `hook.log: ${line}`);
  }
}

function checkScripted({ store }: Facts & { store: Store }, report: Report): void {
  report('info', `scripted runs dropped: ${store.getKv('dropped_scripted') ?? '0'}`);
}

const REFRESH_STEPS = [
  ['ingest', 'ingest_problems'],
  ['reconcile', 'reconcile_problems'],
  ['scan', 'scan_problems'],
] as const;

/** What the last refresh skipped and why, as it recorded it (src/sessions/problems.ts). */
function checkRefreshProblems({ store }: Facts & { store: Store }, report: Report): void {
  let any = false;
  for (const [step, key] of REFRESH_STEPS) {
    const value = store.getKv(key);
    for (const line of value === null ? [] : linesOf(value)) {
      any = true;
      report('problem', `last refresh: ${step}: ${line}`);
    }
  }
  if (!any) {
    report('ok', 'the last refresh skipped nothing');
  }
}

/** The recorded JSON array of lines; anything else is shown as it is. */
function linesOf(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // shown as it is
  }
  return [value];
}

/**
 * The refresh skips what it cannot read without a word (an unreadable sessions folder reads as no
 * live sessions), so doctor looks itself (design 5.6), through src/claude/ (design 11).
 */
function checkClaudeFolders({ platform, places }: Facts, report: Report): void {
  const { sessions, projects } = lookAtClaudeFolders(platform.files, places.claudeHome);
  if (sessions.missing) {
    report('info', `${sessions.path} does not exist yet`);
  } else if (sessions.unreadable.length === 0) {
    report('ok', `${sessions.path} can be read`);
  }
  for (const { path, reason } of sessions.unreadable) {
    report('problem', `cannot read ${path} (${reason})`);
  }
  if (projects.missing) {
    report('info', `${projects.path} does not exist yet`);
  } else if (projects.unreadable.length === 0) {
    report('ok', `transcripts: ${plural(projects.transcripts, 'file')} under ${projects.path}`);
  }
  for (const { path, reason } of projects.unreadable) {
    report('problem', `transcripts: cannot read ${path} (${reason})`);
  }
}

/** `gh` reads pull-request status (design 7.3): it must be there and logged in. */
async function checkGh({ platform }: Facts, report: Report): Promise<void> {
  const { runner, env } = platform;
  const options = {
    timeoutMs: PROGRAM_TIMEOUT_MS,
    env: { ...definedEnv(env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  };
  const version = await runner.run('gh', ['--version'], options);
  if (version.notFound) {
    report('problem', 'gh is not installed: pull requests cannot be read');
    return;
  }
  if (version.code !== 0) {
    report('problem', `gh --version failed (${failure(version)})`);
    return;
  }
  report('ok', firstLine(version.stdout) || 'gh is installed');
  const auth = await runner.run('gh', ['auth', 'status'], options);
  if (auth.code === 0) {
    report('ok', 'gh is logged in');
  } else {
    // Its own first line can be only a host name, and an expired token or no network fails the
    // same way: the exit status and where to look say more.
    report(
      'problem',
      `gh is not logged in, or GitHub cannot be reached (gh auth status: ${outcome(auth)}); run gh auth status to see why`,
    );
  }
}

/**
 * The configured terminal (S2 16.4): `here` and `window` start no program and are named; for
 * `wezterm`, the tab adapter answers. `--no-auto-start`: without it `wezterm cli` starts a hidden
 * server when no WezTerm window is open, and the check would pass where opening a tab fails. From
 * WSL, `wezterm.exe` is tried when `wezterm` is not found, as the adapter does (D15).
 */
async function checkTerminal(
  { platform, config }: Facts & { config: Config },
  report: Report,
): Promise<void> {
  const { runner, env } = platform;
  if (config.terminal === 'window') {
    // S2 11.4: the window's server starts them; whether it runs is the server line's to say.
    report(
      'ok',
      'terminal: window (sessions start in the skydeck window; resume, new and restore need skydeck window to run)',
    );
    return;
  }
  if (config.terminal !== 'wezterm') {
    report('ok', 'terminal: here (sessions start in the terminal skydeck runs in)');
    return;
  }
  const args = ['cli', '--no-auto-start', 'list'];
  const options = { timeoutMs: PROGRAM_TIMEOUT_MS, env: definedEnv(env) };
  let result = await runner.run('wezterm', args, options);
  if (result.notFound && (env['WSL_DISTRO_NAME'] ?? '') !== '') {
    result = await runner.run('wezterm.exe', args, options);
  }
  if (result.code === 0) {
    report('ok', 'terminal: wezterm answers');
  } else {
    report(
      'problem',
      `terminal: wezterm cli --no-auto-start list failed (${failure(result)}); is a WezTerm window open?`,
    );
  }
}

/** How a program ended, in a few words: timed out, not installed, or its exit status. */
function outcome(result: RunResult): string {
  if (result.timedOut) {
    return 'timed out';
  }
  if (result.notFound) {
    return 'not installed';
  }
  return result.code === null ? 'ended without a status' : `exit ${result.code}`;
}

/** Why a program failed: its own first line of stderr when it has one, else how it ended. */
function failure(result: RunResult): string {
  const line = result.timedOut || result.notFound ? '' : firstLine(result.stderr);
  return line !== '' ? line : outcome(result);
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

/** The environment a program runs in: the caller's, without unset entries. */
function definedEnv(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
