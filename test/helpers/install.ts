/**
 * Helpers for the tests of `install`, `uninstall` and `doctor`: they run whole commands one after
 * another on one sandboxed platform, each run with its own captured output and answers, and look
 * at the database and Claude Code's folders between runs.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { main } from '../../src/cli/main.ts';
import { settingsPath } from '../../src/claude/settings.ts';
import type { Places } from '../../src/platform/paths.ts';
import { NS_PER_SECOND, isoFromNs } from '../../src/platform/time.ts';
import type { Ns, Platform } from '../../src/platform/types.ts';
import { openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import { capture } from './capture.ts';
import type { CaptureOptions } from './capture.ts';

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** The prompt of every readLine call of this run, in order. */
  prompts: string[];
}

/** `skydeck <argv>` on `platform`, with output, prompts and answers of its own. */
export async function run(
  platform: Platform,
  argv: string[],
  options: CaptureOptions = {},
): Promise<Run> {
  const captured = capture(options);
  const code = await main(argv, { io: captured.io, platform });
  return { code, stdout: captured.stdout(), stderr: captured.stderr(), prompts: captured.prompts };
}

/** fn(store) on the database at places.dbPath, closed afterwards. */
export function withStore<T>(places: Places, fn: (store: Store) => T): T {
  const store = openStore(places.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** <claudeHome>/settings.json of `places`. */
export function settingsFile(places: Places): string {
  return settingsPath(places.claudeHome);
}

/** The settings backup install writes at T0 (the test clock's start), `<settings>.skydeck-backup-<UTC>`. */
export function backupAtT0(places: Places): string {
  return `${settingsFile(places)}.skydeck-backup-20261112T090000Z`;
}

/** Every file beside the settings file whose name starts like a backup's, as paths, sorted. */
export function backups(places: Places): string[] {
  const prefix = `${basename(settingsFile(places))}.skydeck-backup`;
  return readdirSync(places.claudeHome)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => join(places.claudeHome, name));
}

/** <claudeHome>/projects and <claudeHome>/sessions, as a machine that runs Claude Code has them. */
export function claudeFolders(places: Places): void {
  mkdirSync(join(places.claudeHome, 'projects'), { recursive: true });
  mkdirSync(join(places.claudeHome, 'sessions'), { recursive: true });
}

/**
 * A transcript of `sessionId` with one user record at `recordNs` (also the file's modification
 * time), in <claudeHome>/projects/demo/. Returns its path.
 */
export function transcript(
  places: Places,
  sessionId: string,
  recordNs: Ns,
  entrypoint = 'cli',
): string {
  const folder = join(places.claudeHome, 'projects', 'demo');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${sessionId}.jsonl`);
  const record = {
    type: 'user',
    sessionId,
    timestamp: isoFromNs(recordNs),
    cwd: '/home/dev/projects/demo',
    entrypoint,
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  const seconds = Number(recordNs / NS_PER_SECOND);
  utimesSync(path, seconds, seconds);
  return path;
}

/**
 * The lines install prints after `skydeck is installed` (follow-up F22), for the checkout of
 * `platform`: what a new user does next. Words as the plan has them.
 */
export function nextSteps(platform: Platform): string[] {
  return [
    'Open a new terminal: skydeck is found there (if not, add ~/.local/bin to your PATH).',
    'skydeck doctor checks the installation.',
    'skydeck ls lists the sessions: those Claude Code already has, and new ones as they start.',
    'skydeck window opens the window, from a terminal of your own, not from inside Claude Code.',
    `The guide: ${join(platform.appRoot, 'README.md')}`,
  ];
}

/**
 * The end of the stdout of an install that succeeded: a blank line, `skydeck is installed`, a blank
 * line and Next, the next steps numbered but the guide's.
 */
export function installedTail(platform: Platform): string {
  const steps = nextSteps(platform);
  const guide = steps.pop() ?? '';
  const numbered = steps.map((step, index) => `  ${index + 1}. ${step}\n`).join('');
  return `\nskydeck is installed\n\nNext\n${numbered}  ${guide}\n`;
}

/** The prompt of one of install's questions, `> <question> ` (without colour). */
export function prompt(question: string): string {
  return `> ${question} `;
}

/** The stdout of an install that succeeded, in three: what came before the summary, its lines, the tail. */
export interface InstallStdout {
  /** Everything before the summary, ending in a newline (the blank line before it left out). */
  before: string;
  /** The summary: `Changed` and its lines, or the one line `nothing was changed`. */
  summary: string[];
  /** From the blank line before `skydeck is installed` to the end (installedTail). */
  tail: string;
}

export function installStdout(stdout: string): InstallStdout {
  const end = stdout.lastIndexOf('\n\nskydeck is installed\n');
  assert.ok(end >= 0, `no "skydeck is installed" in:\n${stdout}`);
  const head = stdout.slice(0, end + 1);
  const start = head.lastIndexOf('\n\n');
  return {
    before: start < 0 ? '' : head.slice(0, start + 1),
    summary: head
      .slice(start < 0 ? 0 : start + 2)
      .split('\n')
      .filter((line) => line !== ''),
    tail: stdout.slice(end + 1),
  };
}
