// `skydeck uninstall [--purge]` (design 8): undoes install's change to Claude Code's settings file,
// removes install's links, and with --purge skydeck's own directories. It creates nothing (ruled
// by the plan owner) but one file: the database is opened by itself, without the directories
// `withDeck` would make again, and with no database there is nothing recorded, so only the entries
// install wrote are removed; when that rewrites more of the settings file than those entries, it
// keeps the file as it was in a new backup first. It never removes a backup install made.
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

import { removeHookEntries, rewriteReport, settingsPath } from '../../claude/settings.ts';
import { SkydeckError } from '../../platform/errors.ts';
import type { Places } from '../../platform/paths.ts';
import type { Files, Platform } from '../../platform/types.ts';
import { resolveDeckPlaces } from '../../sessions/deck.ts';
import { describeError } from '../../sessions/problems.ts';
import { isDatabaseFailure, openStore } from '../../store/store.ts';
import type { Store } from '../../store/store.ts';
import { sanitize } from '../../text/sanitize.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { EXIT } from '../exit.ts';
import { backupBase, createBackup } from '../settings-backup.ts';

const SPEC: ArgSpec = {
  usage:
    'skydeck uninstall [--purge]\n' +
    '\n' +
    "Puts Claude Code's settings file back as it was before install when nobody changed it\n" +
    'since, otherwise removes only the two hook entries install wrote (after a new backup of\n' +
    'the file, when that rewrites more than those entries), and removes the links install\n' +
    'made. The database stays. The backups of the settings file are kept (it names them).\n' +
    '\n' +
    '  --purge  also remove the data, state and configuration directories\n',
  flags: { purge: { type: 'boolean' } },
  min: 0,
  max: 0,
};

/** What install recorded in kv. */
interface Recorded {
  hash: string | null;
  backup: string | null;
}

export const command: Command = {
  name: 'uninstall',
  summary: 'Remove the hooks and links',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const { platform } = ctx;
    const { places } = resolveDeckPlaces(platform);
    if (platform.files.stat(places.dbPath) === null) {
      undo(ctx, places, { hash: null, backup: null });
    } else {
      withStoreAt(places.dbPath, (store) => {
        undo(ctx, places, {
          hash: store.getKv('settings_hash'),
          backup: store.getKv('settings_backup'),
        });
        // Only once all of it is undone: an uninstall that stopped halfway can still restore.
        store.transaction(() => {
          store.deleteKv('settings_hash');
          store.deleteKv('settings_backup');
        });
      });
    }
    if (parsed.flags['purge'] === true) {
      // The store is closed by now.
      for (const dir of [places.dataDir, places.stateDir, places.configDir]) {
        if (platform.files.lstat(dir) !== null) {
          attempt(`cannot remove ${dir}`, () => platform.files.removeTree(dir));
          ctx.io.stdout(`removed ${sanitize(dir)}\n`);
        }
      }
    }
    return EXIT.ok;
  },
};

/**
 * fn(store) on the existing database, closed afterwards. As in withDeck, a failure of the database
 * as a whole is an error naming it, not an internal error.
 */
function withStoreAt(path: string, fn: (store: Store) => void): void {
  const store = openStore(path);
  try {
    fn(store);
  } catch (error) {
    if (isDatabaseFailure(error)) {
      throw new SkydeckError(`the database ${path} failed: ${describeError(error)}`);
    }
    throw error;
  } finally {
    try {
      store.close();
    } catch {
      // Each write is committed already; an error here would hide the one that ended the command.
    }
  }
}

/** The settings first (they name the hook link), then the links; last, where the backups are. */
function undo(ctx: Context, places: Places, recorded: Recorded): void {
  restoreSettings(ctx, ctx.platform.files, places, recorded);
  removeLinks(ctx, ctx.platform, places);
  showBackups(ctx, ctx.platform.files, places);
}

/**
 * Design 8: when the file is still exactly what install wrote (its hash) and the recorded backup
 * still exists, the state before install comes back: the backup, or no file at all for `none`. In
 * every other case exactly the entries install wrote are removed (removeHookEntries), and
 * everything else stays. That goes through parsing and writing the file in skydeck's formatting:
 * when this changes more than the entries, the file as it is now is kept first in a new backup,
 * named like install's, and uninstall says where (ruled by the plan owner). The backups
 * themselves are never removed.
 */
function restoreSettings(ctx: Context, files: Files, places: Places, recorded: Recorded): void {
  const path = settingsPath(places.claudeHome);
  const text = readOrFail(files, path);
  if (text === null) {
    return;
  }
  if (recorded.hash !== null && sha256(text) === recorded.hash) {
    if (recorded.backup === 'none') {
      attempt(`cannot remove ${path}`, () => files.remove(path));
      ctx.io.stdout(`removed ${sanitize(path)}: there was none before skydeck install\n`);
      return;
    }
    const before = recorded.backup === null ? null : readOrFail(files, recorded.backup);
    if (recorded.backup !== null && before !== null) {
      attempt(`cannot write ${path}`, () => files.writeText(path, before));
      ctx.io.stdout(`restored ${sanitize(path)} from ${sanitize(recorded.backup)}\n`);
      return;
    }
  }
  const edit = removeHookEntries(text, places.hookPath);
  if (!edit.changed) {
    return;
  }
  const rewrite = rewriteReport(text);
  const backup = rewrite.reformatted
    ? createBackup(files, path, backupBase(path, ctx.platform.clock), text)
    : null;
  attempt(`cannot write ${path}`, () => {
    try {
      files.writeText(path, edit.text);
    } catch (error) {
      if (backup !== null) {
        removeQuietly(files, backup); // the file is as it was: this run has nothing to keep
      }
      throw error;
    }
  });
  ctx.io.stdout(`removed the hook entries from ${sanitize(path)}\n`);
  if (backup !== null) {
    const lost =
      rewrite.lossyPaths.length === 0 ? '' : ` and ${rewrite.lossyPaths.join(', ')} lost digits`;
    ctx.io.stdout(
      sanitize(
        `the rest of the file was rewritten in skydeck's formatting${lost}; ` +
          `the file as it was is kept in ${backup}`,
      ) + '\n',
    );
  }
}

/** Removes a file this run made, for a run that is ending in an error anyway; failing to is not worth a second one. */
function removeQuietly(files: Files, path: string): void {
  try {
    files.remove(path);
  } catch {
    // the backup stays; the next lines of the output name every backup
  }
}

/** Each link only when it still points where install pointed it (install.ts gives the same list). */
function removeLinks(ctx: Context, platform: Platform, places: Places): void {
  const { files } = platform;
  const links = [
    { path: places.hookPath, target: join(platform.appRoot, 'bin', 'skydeck-hook') },
    { path: places.binLink, target: join(platform.appRoot, 'bin', 'skydeck') },
    { path: places.nodeLink, target: platform.nodePath },
  ];
  for (const { path, target } of links) {
    const current = files.readlink(path);
    if (current === null) {
      continue;
    }
    if (current === target) {
      attempt(`cannot remove ${path}`, () => files.remove(path));
      ctx.io.stdout(`removed ${sanitize(path)}\n`);
    } else {
      ctx.io.stdout(`left ${sanitize(path)} alone: it points at ${sanitize(current)}\n`);
    }
  }
}

/**
 * Ruled by the plan owner: the backups install made are the user's safety net and are never
 * removed, not even by --purge; uninstall names each one so the user can find them.
 */
function showBackups(ctx: Context, files: Files, places: Places): void {
  const prefix = `${basename(settingsPath(places.claudeHome))}.skydeck-backup-`;
  let names: string[];
  try {
    names = files.list(places.claudeHome);
  } catch (error) {
    ctx.io.stdout(
      `cannot list ${sanitize(places.claudeHome)} to show the backups (${describeError(error)})\n`,
    );
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix)) {
      ctx.io.stdout(`kept the backup ${sanitize(join(places.claudeHome, name))}\n`);
    }
  }
}

/** fn(), with a failure of the file system as an error that says what could not be done. */
function attempt(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    throw new SkydeckError(`${what} (${describeError(error)})`);
  }
}

function readOrFail(files: Files, path: string): string | null {
  try {
    return files.readText(path);
  } catch (error) {
    throw new SkydeckError(`cannot read ${path} (${describeError(error)})`);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
