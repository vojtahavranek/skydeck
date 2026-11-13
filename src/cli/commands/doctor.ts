// `skydeck doctor` (design 8): checks the installation and reports one line per check, `ok`, `info`
// or `problem`, exiting 1 when anything is a problem. It does not refresh: the spool is counted as
// it is, and what the last refresh skipped is read from kv where that refresh recorded it.
import { join } from 'node:path';

import { checkNodeVersion } from '../../../bin/node-version.mjs';
import { HOOK_EVENTS, hookStatus, settingsPath } from '../../claude/settings.ts';
import { listTranscriptFiles } from '../../claude/transcripts.ts';
import type { Env, Ns, RunResult } from '../../platform/types.ts';
import type { Deck } from '../../sessions/deck.ts';
import { describeError } from '../../sessions/problems.ts';
import { formatAge } from '../../text/age.ts';
import { sanitize } from '../../text/sanitize.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage:
    'skydeck doctor\n' +
    '\n' +
    'Checks the hook entries and links, Node.js, the database, the spool, hook.log, what\n' +
    "the last refresh skipped, Claude Code's folders, gh and the terminal. One line per\n" +
    'check; exits 1 when any line is a problem.\n',
  flags: {},
  min: 0,
  max: 0,
};

type Kind = 'ok' | 'info' | 'problem';
type Report = (kind: Kind, text: string) => void;

interface Check {
  name: string;
  run(deck: Deck, report: Report): void | Promise<void>;
}

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
    return withDeck(ctx, { refresh: false }, async (deck) => {
      let problems = 0;
      const report: Report = (kind, text) => {
        if (kind === 'problem') {
          problems++;
        }
        // Paths, log lines and program output are foreign text (design 7.4).
        ctx.io.stdout(`${kind.padEnd(9)}${sanitize(text)}\n`);
      };
      for (const check of CHECKS) {
        try {
          await check.run(deck, report);
        } catch (error) {
          // A doctor that stops at the first surprise shows least when most is wrong, so whatever a
          // check throws, the database's own failures included, is one problem line and the next
          // check runs. (There is no per-item loop here that could wait the busy timeout many times.)
          report('problem', `${check.name}: could not be checked (${describeError(error)})`);
        }
      }
      return problems > 0 ? EXIT.failure : EXIT.ok;
    });
  },
};

const CHECKS: readonly Check[] = [
  { name: 'hook entries', run: checkHookEntries },
  { name: 'hook link', run: checkHookLink },
  { name: 'Node.js', run: checkNode },
  { name: 'database', run: checkDatabase },
  { name: 'spool', run: checkSpool },
  { name: 'last event', run: checkLastEvent },
  { name: 'spool/bad', run: checkBadFiles },
  { name: 'hook.log', run: checkHookLog },
  { name: 'scripted runs', run: checkScripted },
  { name: 'last refresh', run: checkRefreshProblems },
  { name: "Claude Code's folders", run: checkClaudeFolders },
  { name: 'gh', run: checkGh },
  { name: 'terminal', run: checkTerminal },
];

/** Design 8: both hook entries present, one problem line per event without its entry. */
function checkHookEntries(deck: Deck, report: Report): void {
  const { hookPath, claudeHome } = deck.places;
  const path = settingsPath(claudeHome);
  const status = hookStatus(deck.platform.files.readText(path), hookPath);
  const missing = HOOK_EVENTS.filter((event) => !status[event]);
  if (missing.length === 0) {
    report('ok', `hook entries present in ${path}`);
  }
  for (const event of missing) {
    report('problem', `no ${event} hook entry for ${hookPath} in ${path}; run skydeck install`);
  }
}

/** `<hookPath>` resolves to a regular file (the link is not dangling). */
function checkHookLink(deck: Deck, report: Report): void {
  const { files } = deck.platform;
  const { hookPath } = deck.places;
  if (files.stat(hookPath)?.kind === 'file') {
    report('ok', `${hookPath} -> ${files.realpath(hookPath) ?? hookPath}`);
  } else {
    report('problem', `${hookPath} does not resolve to a file; run skydeck install`);
  }
}

function checkNode(deck: Deck, report: Report): void {
  const { nodeVersion, nodePath } = deck.platform;
  const message = checkNodeVersion(nodeVersion);
  if (message === undefined) {
    report('ok', `Node.js ${nodeVersion} (${nodePath})`);
  } else {
    report('problem', message);
  }
}

function checkDatabase(deck: Deck, report: Report): void {
  const { store, platform } = deck;
  try {
    store.setKv('doctor_probe', String(platform.clock.nowNs()));
    report('ok', `database ${store.path} is writable`);
  } catch (error) {
    report('problem', `database ${store.path} is not writable (${describeError(error)})`);
  }
}

/** The `.ev` files waiting in the spool: what the next refresh would read. */
function spoolFiles(deck: Deck): string[] {
  return deck.platform.files
    .list(deck.places.spoolDir)
    .filter((name) => !name.startsWith('.') && name.endsWith('.ev'));
}

function checkSpool(deck: Deck, report: Report): void {
  const count = spoolFiles(deck).length;
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
function checkLastEvent(deck: Deck, report: Report): void {
  let last: Ns | null =
    deck.store
      .events()
      .filter((event) => event.spoolName !== null)
      .at(-1)?.timeNs ?? null;
  for (const name of spoolFiles(deck)) {
    const time = /^(\d+)-/.exec(name)?.[1];
    if (time !== undefined && (last === null || BigInt(time) > last)) {
      last = BigInt(time);
    }
  }
  report(
    'info',
    last === null
      ? 'no events yet'
      : `last event ${formatAge(deck.platform.clock.nowNs() - last)} ago`,
  );
}

/** Files ingest could not read (design 5.3), with their age range: ingest removes them after seven days. */
function checkBadFiles(deck: Deck, report: Report): void {
  const { files, clock } = deck.platform;
  const { badDir } = deck.places;
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
function checkHookLog(deck: Deck, report: Report): void {
  const { files } = deck.platform;
  const { hookLog } = deck.places;
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

function checkScripted(deck: Deck, report: Report): void {
  report('info', `scripted runs dropped: ${deck.store.getKv('dropped_scripted') ?? '0'}`);
}

const REFRESH_STEPS = [
  ['ingest', 'ingest_problems'],
  ['reconcile', 'reconcile_problems'],
  ['scan', 'scan_problems'],
] as const;

/** What the last refresh skipped and why, as it recorded it (src/sessions/problems.ts). */
function checkRefreshProblems(deck: Deck, report: Report): void {
  let any = false;
  for (const [step, key] of REFRESH_STEPS) {
    const value = deck.store.getKv(key);
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
 * live sessions), so doctor looks itself: `sessions` can be listed, and every folder and file under
 * `projects` can be looked at (design 5.6).
 */
function checkClaudeFolders(deck: Deck, report: Report): void {
  const { files } = deck.platform;
  const { claudeHome } = deck.places;
  const sessions = join(claudeHome, 'sessions');
  const projects = join(claudeHome, 'projects');

  const sessionsInfo = files.stat(sessions);
  if (sessionsInfo === null) {
    report('info', `${sessions} does not exist yet`);
  } else if (sessionsInfo.kind !== 'dir') {
    report('problem', `${sessions} is not a folder`);
  } else {
    try {
      files.list(sessions);
      report('ok', `${sessions} can be read`);
    } catch (error) {
      report('problem', `cannot read ${sessions} (${describeError(error)})`);
    }
  }

  if (files.stat(projects) === null) {
    report('info', `${projects} does not exist yet`);
    return;
  }
  const listing = listTranscriptFiles(files, claudeHome);
  if (listing.unreadable.length === 0) {
    report('ok', `transcripts: ${plural(listing.files.length, 'file')} under ${projects}`);
  }
  for (const { path, reason } of listing.unreadable) {
    report('problem', `transcripts: cannot read ${path} (${reason})`);
  }
}

/** `gh` reads pull-request status (design 7.3): it must be there and logged in. */
async function checkGh(deck: Deck, report: Report): Promise<void> {
  const { runner, env } = deck.platform;
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
    report('problem', `gh is not logged in (${failure(auth)}); run gh auth login`);
  }
}

/**
 * The tab adapter answers. `--no-auto-start`: without it `wezterm cli` starts a hidden server when
 * no WezTerm window is open, and the check would pass where opening a tab fails. From WSL,
 * `wezterm.exe` is tried when `wezterm` is not found, as the adapter does (D15).
 */
async function checkTerminal(deck: Deck, report: Report): Promise<void> {
  const { runner, env } = deck.platform;
  if (deck.config.terminal !== 'wezterm') {
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

/** Why a program failed, in a few words: its own first line of stderr when it has one. */
function failure(result: RunResult): string {
  if (result.timedOut) {
    return 'timed out';
  }
  if (result.notFound) {
    return 'not installed';
  }
  const line = firstLine(result.stderr);
  if (line !== '') {
    return line;
  }
  return result.code === null ? 'ended without a status' : `exit ${result.code}`;
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
