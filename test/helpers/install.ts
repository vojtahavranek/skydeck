/**
 * Helpers for the tests of `install`, `uninstall` and `doctor`: they run whole commands one after
 * another on one sandboxed platform, each run with its own captured output and answers, and look
 * at the database and Claude Code's folders between runs.
 */
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
