// `skydeck uninstall [--purge]` (design 8): undoes install's change to Claude Code's settings file,
// removes install's links, and with --purge skydeck's own directories. It creates nothing (ruled
// by the plan owner) but one file: the database is opened by itself, without the directories
// `withDeck` would make again, and with no database there is nothing recorded, so only the entries
// install wrote are removed; when that rewrites more of the settings file than those entries, it
// keeps the file as it was in a new backup first. It never removes a backup install made.
//
// Before that (S2 16.2): a running window server is stopped as `skydeck window --stop` stops it
// (lifecycle.ts), and the line says how many terminals keep running; the window's Edge profile
// folder is named when it exists (ruled by the plan owner, task 24), never removed. Keepers and
// their sessions are never stopped and never connected to (S2 7.1): `--purge` judges them by their
// `.pid` lines in every directory that can be the runtime directory and refuses, before it does
// anything, while one may live; otherwise it also removes those directories.
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

import { removeHookEntries, rewriteReport, settingsPath } from '../../claude/settings.ts';
import type { Config } from '../../platform/config.ts';
import { SkydeckError } from '../../platform/errors.ts';
import { runtimeDirCandidates, storeId } from '../../platform/paths.ts';
import type { Places } from '../../platform/paths.ts';
import type { FileInfo, Files, Platform } from '../../platform/types.ts';
import { resolveDeckPlaces } from '../../sessions/deck.ts';
import type { Deck } from '../../sessions/deck.ts';
import { describeError } from '../../sessions/problems.ts';
import { isDatabaseFailure, openStore } from '../../store/store.ts';
import type { Store } from '../../store/store.ts';
import { sanitize } from '../../text/sanitize.ts';
import { driveC, readableWindowsPath } from '../../window/drive.ts';
import { stopServer } from '../../window/lifecycle.ts';
import { listKeeperLines, runtimeFiles } from '../../window/runtime.ts';
import { deriveProfileDirUnder } from '../../window/windows.ts';
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
    "First it stops the window's server; the terminals in the window keep running.\n" +
    '\n' +
    '  --purge  also remove the data, state and configuration directories and the runtime\n' +
    '           directory; refused while a terminal of the window may still run\n',
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
    const { places, config } = resolveDeckPlaces(platform);
    const purge = parsed.flags['purge'] === true;
    let runtimeDirs: string[];
    if (platform.files.stat(places.dbPath) === null) {
      // No database: no record, and no server of this installation (a server opens it first).
      runtimeDirs = runtimeDirsOf(platform, places, null);
      if (purge) refuseWhileKeepersMayLive(platform, runtimeDirs, BEFORE);
      showProfileFolder(ctx, config);
      undo(ctx, places, { hash: null, backup: null });
    } else {
      runtimeDirs = await withStoreAt(places.dbPath, async (store) => {
        const dirs = runtimeDirsOf(platform, places, store.getKv('window_runtime_dir'));
        if (purge) refuseWhileKeepersMayLive(platform, dirs, BEFORE);
        await stopTheServer(ctx, { platform, places, config, store });
        showProfileFolder(ctx, config);
        undo(ctx, places, {
          hash: store.getKv('settings_hash'),
          backup: store.getKv('settings_backup'),
        });
        // Only once all of it is undone: an uninstall that stopped halfway can still restore.
        store.transaction(() => {
          store.deleteKv('settings_hash');
          store.deleteKv('settings_backup');
        });
        return dirs;
      });
    }
    if (purge) {
      // Once more: the server may have been starting a keeper as it stopped. This look can come
      // only after the stop, so it refuses only the purge: the uninstall is done, the data stays.
      refuseWhileKeepersMayLive(platform, runtimeDirs, AFTER);
      const own = [places.dataDir, places.stateDir, places.configDir];
      const unseen: string[] = [];
      for (const dir of runtimeDirs) {
        // One inside skydeck's own directories goes with them.
        if (!own.some((parent) => dir === parent || dir.startsWith(`${parent}/`))) {
          const failed = removeRuntimeDir(ctx, platform, dir);
          if (failed !== null) unseen.push(failed);
        }
      }
      // The store is closed by now.
      for (const dir of own) {
        if (platform.files.lstat(dir) !== null) {
          attempt(`cannot remove ${dir}`, () => platform.files.removeTree(dir));
          ctx.io.stdout(`removed ${sanitize(dir)}\n`);
        }
      }
      if (unseen.length > 0) {
        // A look that came after the undo: it refuses only that directory, and says so (ruled).
        throw new SkydeckError(`${AFTER_UNSEEN} ${unseen.join('; ')}`);
      }
    }
    return EXIT.ok;
  },
};

/**
 * fn(store) on the existing database, closed afterwards. As in withDeck, a failure of the database
 * as a whole is an error naming it, not an internal error.
 */
async function withStoreAt<T>(path: string, fn: (store: Store) => Promise<T>): Promise<T> {
  const store = openStore(path);
  try {
    return await fn(store);
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

// ---------------------------------------------------------------------------------------------
// The window (S2 16.2)

/**
 * S2 16.2: the server stopped as `skydeck window --stop` stops it. `keepers` is what keeps running
 * in the window: the keepers whose `.pid` line is alive or cannot be judged, read before the stop
 * (stopServer). A server that cannot be stopped is the command's error: nothing is undone.
 */
async function stopTheServer(ctx: Context, deck: Deck): Promise<void> {
  const { stopped, keepers } = await stopServer(deck);
  if (stopped) {
    const terminals =
      keepers === 1
        ? '1 terminal in the window keeps running'
        : `${keepers} terminals in the window keep running`;
    ctx.io.stdout(`stopped skydeck's window server; ${terminals}\n`);
  }
}

/**
 * S2 16.2, 5.4: the Edge profile folder — window.profileDir, else derived — named when it exists
 * (ruled by the plan owner, task 24: Edge creates it at the window's first start). skydeck never
 * removes it. Nothing is said when it cannot be found or looked at.
 */
function showProfileFolder(ctx: Context, config: Config): void {
  const { env, files } = ctx.platform;
  let folder = config.window.profileDir;
  if (folder === null) {
    const drive = driveC(env);
    const derived = drive === null ? null : deriveProfileDirUnder(files, join(drive, 'Users'));
    if (derived?.ok !== true) return;
    folder = derived.dir;
  }
  const path = readableWindowsPath(env, folder);
  try {
    if (path === null || files.stat(path)?.kind !== 'dir') return;
  } catch {
    return;
  }
  ctx.io.stdout(
    `the window's Edge profile is in ${sanitize(folder)}; Edge wrote it and skydeck leaves it (delete it yourself)\n`,
  );
}

/**
 * S2 16.2: every directory that can be the runtime directory — the one the store records and each
 * one the rule of 4.2 can give — since this command may run with another environment than the
 * server did.
 */
function runtimeDirsOf(platform: Platform, places: Places, recorded: string | null): string[] {
  // Normalised — repeated and trailing slashes dropped — so that a link is seen as a link
  // (`<link>/` would be followed); `.` and `..` are kept, and such a path is never removed.
  const record =
    recorded !== null && recorded.startsWith('/')
      ? recorded.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
      : null;
  const dirs = [
    ...(record !== null ? [record] : []),
    ...runtimeDirCandidates(platform.env, places.stateDir, storeId(places.dbPath)),
  ];
  return [...new Set(dirs)];
}

/** What a refusal of `--purge` says was done: before anything (S2 16.2), or after the stop. */
const BEFORE = 'uninstall --purge removed nothing';
const AFTER = 'skydeck is uninstalled, but --purge removed no directory';
const AFTER_UNSEEN = 'skydeck is uninstalled, but --purge did not remove';

/**
 * S2 16.2: `--purge` refuses (exit 1), before it changes anything — and once more after the
 * server's stop, before it removes a directory, then refusing only the purge (`done` says what was
 * done by then) — while a keeper may live in any
 * of `dirs` — by its `.pid` line and design 5.5's rule, never by connecting to it; a line that
 * cannot be told dead, or a `.pid` file that cannot be read, counts as alive — naming them. A
 * terms/ that cannot be listed refuses too: what is in it cannot be told.
 */
function refuseWhileKeepersMayLive(
  platform: Platform,
  dirs: readonly string[],
  done: string,
): void {
  const open: string[] = [];
  for (const dir of dirs) {
    const files = runtimeFiles(dir);
    let lines: ReturnType<typeof listKeeperLines>;
    try {
      lines = listKeeperLines(platform, files);
    } catch (error) {
      throw new SkydeckError(
        `${done}: the terminals in ${files.termsDir} cannot be listed (${describeError(error)})`,
      );
    }
    for (const { id, line, state } of lines) {
      if (state !== 'dead') {
        const which = line === null ? 'its .pid file cannot be read' : `pid ${line.pid}`;
        open.push(`${id} (${which}) in ${dir}`);
      }
    }
  }
  if (open.length > 0) {
    throw new SkydeckError(
      `${done}: terminals of the window may still run: ${open.join(', ')}; ` +
        'purging would remove their keeper sockets, and their screens could not be shown again; ' +
        'end those sessions first, then run skydeck uninstall --purge again',
    );
  }
}

type Kind = FileInfo['kind'];

/** What a runtime directory holds (S2 4.2), each of its kind (a socket is 'other'). */
const RUNTIME_ENTRIES: Readonly<Record<string, Kind>> = {
  'server.json': 'file',
  'server.pid': 'file',
  'server.sock': 'other',
  'keepalive.pid': 'file',
  'keepalive.interop': 'file',
  interop: 'symlink',
  terms: 'dir',
};
const KEEPER_CODE = /^keeper-[A-Za-z0-9_-]+\.py$/;
/**
 * The temporaries its writers leave when a write is cut short: Files.writeText's and symlink's
 * `.<name>.<12 hex>.tmp`, the keep-alive script's `.<name>.<pid>.tmp`.
 */
const RUNTIME_TEMP =
  /^\.(?:server\.json|server\.pid|keepalive\.pid|keepalive\.interop|interop|keeper-[A-Za-z0-9_-]+\.py)\.(?:[0-9a-f]{12}|[0-9]+)\.tmp$/;
/** In terms/: `<terminal id>.sock` (a socket) and `.pid` (a file). */
const TERMS_ENTRY = /^[0-9a-f]{12}\.(sock|pid)$/;
/** The keeper's `.<id>.<pid>.tmp` and Files.writeText's `.<id>.pid.<12 hex>.tmp`. */
const TERMS_TEMP = /^\.[0-9a-f]{12}(?:\.pid)?\.(?:[0-9a-f]{12}|[0-9]+)\.tmp$/;

/** The kinds an entry of a runtime directory may have; null for a name it does not hold. */
function runtimeKinds(name: string): readonly Kind[] | null {
  const kind = Object.hasOwn(RUNTIME_ENTRIES, name) ? RUNTIME_ENTRIES[name] : undefined;
  if (kind !== undefined) return [kind];
  if (KEEPER_CODE.test(name)) return ['file'];
  if (RUNTIME_TEMP.test(name)) return ['file', 'symlink'];
  return null;
}

function termsKinds(name: string): readonly Kind[] | null {
  const entry = TERMS_ENTRY.exec(name);
  if (entry !== null) return [entry[1] === 'sock' ? 'other' : 'file'];
  return TERMS_TEMP.test(name) ? ['file'] : null;
}

/**
 * Removes a runtime directory only when it is a plain path (no `.` or `..`), a directory of the
 * user's that is not a symbolic link, holding nothing but what a runtime directory holds, each of
 * its kind: the store's record is only a path, and nothing of the user's is destroyed (A38,
 * principle 6); otherwise it is left alone and named. A look that fails refuses this directory's
 * removal: the reason is returned for the command's last line (ruled), and the purge goes on.
 */
function removeRuntimeDir(ctx: Context, platform: Platform, dir: string): string | null {
  const { files } = platform;
  let foreign: string | null = null;
  try {
    const info = resolve(dir) === dir ? files.lstat(dir) : undefined;
    if (info === undefined) {
      foreign = 'is not a plain path (a . or .. in it)';
    } else if (info === null) {
      return null;
    } else if (info.kind !== 'dir') {
      foreign = info.kind === 'symlink' ? 'is a symbolic link' : 'is not a directory';
    } else if (info.uid !== platform.uid) {
      foreign = `belongs to uid ${info.uid}`;
    } else {
      const other = foreignEntry(files, dir);
      foreign = other === null ? null : `holds ${other}, which skydeck did not write`;
    }
  } catch (error) {
    return `${dir}: it cannot be looked at (${describeError(error)})`;
  }
  if (foreign !== null) {
    ctx.io.stdout(`left ${sanitize(dir)} alone: it ${sanitize(foreign)}\n`);
    return null;
  }
  attempt(`cannot remove ${dir}`, () => files.removeTree(dir));
  ctx.io.stdout(`removed ${sanitize(dir)}\n`);
  return null;
}

/** The first entry that a runtime directory does not hold, or not of that kind (`terms/<name>` inside terms/). */
function foreignEntry(files: Files, dir: string): string | null {
  const odd = (path: string, kinds: readonly Kind[] | null): boolean => {
    const kind = files.lstat(path)?.kind;
    return kinds === null || (kind !== undefined && !kinds.includes(kind));
  };
  for (const name of files.list(dir)) {
    if (odd(join(dir, name), runtimeKinds(name))) return name;
  }
  const terms = join(dir, 'terms');
  if (files.lstat(terms)?.kind !== 'dir') return null;
  for (const name of files.list(terms)) {
    if (odd(join(terms, name), termsKinds(name))) return `terms/${name}`;
  }
  return null;
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
