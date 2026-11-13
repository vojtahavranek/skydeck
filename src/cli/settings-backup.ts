// The backups of Claude Code's settings file that `skydeck install` and `skydeck uninstall` keep
// before they rewrite it (design 8). Not a command: both commands use it, so that a backup has the
// same name pattern and mode whichever of them made it.
import { SkydeckError } from '../platform/errors.ts';
import { isoFromNs } from '../platform/time.ts';
import type { Clock, Files } from '../platform/types.ts';
import { describeError } from '../sessions/problems.ts';

/** The settings file can hold tokens: its backup is the user's alone, from the start. */
const BACKUP_MODE = 0o600;
/** Backups made in one second take `-2`, `-3`, …; this many is more than any real use makes. */
const MAX_BACKUPS_PER_SECOND = 1000;

/** `<settingsPath>.skydeck-backup-<YYYYMMDDTHHMMSSZ>`, the UTC time of the platform clock now. */
export function backupBase(settingsPath: string, clock: Clock): string {
  const stamp = isoFromNs(clock.nowNs())
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `${settingsPath}.skydeck-backup-${stamp}`;
}

/** `base`, then `base-2`, `base-3`, … */
function* backupNames(base: string): Generator<string> {
  for (let n = 1; n <= MAX_BACKUPS_PER_SECOND; n++) {
    yield n === 1 ? base : `${base}-${n}`;
  }
}

function noFreeName(path: string): SkydeckError {
  return new SkydeckError(`cannot find a free name for a backup of ${path}; it was not changed`);
}

/**
 * The name createBackup will use right now, for a question that names it before anything is made:
 * the first of `base`, `base-2`, … that is not taken. SkydeckError when all are.
 */
export function nextBackupName(files: Files, path: string, base: string): string {
  for (const name of backupNames(base)) {
    if (files.lstat(name) === null) {
      return name;
    }
  }
  throw noFreeName(path);
}

/**
 * Keeps `text`, the content of the settings file `path`, in a new file named from `base` (the first
 * name that is free, taken by O_EXCL, so an older backup is never touched or reused) with mode
 * 600 from the start. Returns its path. SkydeckError when it cannot be written or no name is free;
 * `path` has not been changed by then.
 */
export function createBackup(files: Files, path: string, base: string, text: string): string {
  for (const backup of backupNames(base)) {
    let created: boolean;
    try {
      created = files.createExclusive(backup, text, BACKUP_MODE);
    } catch (error) {
      throw new SkydeckError(
        `cannot write a backup of ${path} (${describeError(error)}); it was not changed`,
      );
    }
    if (created) {
      return backup;
    }
  }
  throw noFreeName(path);
}
