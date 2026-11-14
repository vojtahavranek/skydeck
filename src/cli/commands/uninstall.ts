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
//
// The purge is careful (principle 6; src/cli/purge.ts): from each directory only what skydeck
// writes there, then the directory; one that is not only skydeck's is left alone and named. And it
// refuses, before anything is undone, while a place variable is set but ignored (design 9.1).
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';

import { removeHookEntries, rewriteReport, settingsPath } from '../../claude/settings.ts';
import type { Config } from '../../platform/config.ts';
import { SkydeckError } from '../../platform/errors.ts';
import { runtimeDirCandidates, storeId } from '../../platform/paths.ts';
import type { Places } from '../../platform/paths.ts';
import type { Env, Files, Platform } from '../../platform/types.ts';
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
import { CONFIG_DIR, DATA_DIR, RUNTIME_DIR, purgeDir, stateDirSpec } from '../purge.ts';
import type { Spec } from '../purge.ts';
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
    '  --purge  also remove what skydeck wrote into the data, state, configuration and\n' +
    '           runtime directories, then those directories; one holding anything else is\n' +
    '           left alone. Refused while a terminal of the window may still run, and while\n' +
    '           HOME, SKYDECK_HOME or an XDG_* variable is set but empty or relative\n',
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
    const purge = parsed.flags['purge'] === true;
    if (purge) refuseOnUnusablePlaceVariables(platform.env);
    const { places, config } = resolveDeckPlaces(platform);
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
      const notRemoved: string[] = [];
      for (const dir of runtimeDirs) {
        // One inside skydeck's own directories is purged with them (stateDirSpec's run-<id>).
        if (!own.some((parent) => dir === parent || dir.startsWith(`${parent}/`))) {
          const purged = purgeDir(platform, dir, RUNTIME_DIR);
          if (purged.kind === 'removed') ctx.io.stdout(`removed ${sanitize(dir)}\n`);
          // Ruled (purge-care): any directory left alone is named in the last line, exit 1.
          if (purged.kind === 'left' || purged.kind === 'failed') {
            notRemoved.push(sanitize(`${dir}: it ${purged.why}`)); // a name may hold a line break
          }
        }
      }
      // The store is closed by now. Step 1's directories, each with only what skydeck writes there;
      // two places that are one directory are one purge with both lists.
      const specs = new Map<string, Spec>();
      for (const [dir, spec] of [
        [places.dataDir, DATA_DIR],
        [places.stateDir, stateDirSpec(storeId(places.dbPath))],
        [places.configDir, CONFIG_DIR],
      ] as const) {
        specs.set(dir, [...(specs.get(dir) ?? []), ...spec]);
      }
      // The deepest first: a place inside another (XDG_STATE_HOME under the data directory) goes
      // before the one that holds it, so that one run removes both.
      for (const [dir, spec] of [...specs].sort(([a], [b]) => b.length - a.length)) {
        const purged = purgeDir(platform, dir, spec);
        if (purged.kind === 'removed') ctx.io.stdout(`removed ${sanitize(dir)}\n`);
        if (purged.kind === 'left' || purged.kind === 'failed') {
          notRemoved.push(sanitize(`${dir}: it ${purged.why}`)); // a name may hold a line break
        }
      }
      if (notRemoved.length > 0) {
        // After the undo: the uninstall is done, these directories stay, and the line says so.
        throw new SkydeckError(`${AFTER_UNSEEN} ${notRemoved.join('; ')}`);
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

/**
 * The variables that choose the directories `--purge` removes (design 9.1, S2 4.2). HOME too
 * (ruled, purge-care): the home directory is HOME as it is, so an empty or relative one makes every
 * place relative to the working directory.
 */
const PLACE_VARIABLES = [
  'HOME',
  'SKYDECK_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
] as const;

/**
 * Design 9.1 (D26) ignores a place variable that is empty or not absolute, so `SKYDECK_HOME=sandbox
 * skydeck uninstall --purge` would purge the installation found without it: most likely the real
 * one. HOME is not ignored but taken as it is, so an empty or relative one puts every place under
 * the working directory. Before anything is done, `--purge` refuses while one of them is set but
 * empty or not absolute, each named with what it would do.
 */
function refuseOnUnusablePlaceVariables(env: Env): void {
  const ignored = PLACE_VARIABLES.flatMap((name) => {
    const value = env[name];
    if (value === undefined || (value !== '' && isAbsolute(value))) return [];
    const shown = `${name} is set to ${JSON.stringify(value)}`;
    const why = value === '' ? 'empty' : 'not an absolute path';
    // HOME is not ignored but taken as it is (os.homedir()): its clause says what that does.
    return [
      name === 'HOME'
        ? `${shown} (${why}), which skydeck takes as it is, so every place would be relative to the working directory`
        : `${shown} but ignored (${why}), so skydeck would find the installation it finds without it`,
    ];
  });
  if (ignored.length > 0) {
    throw new SkydeckError(
      `${BEFORE}: ${ignored.join('; ')}; it does not purge the installation it would then find. ` +
        'Unset the variable, or set it to an absolute path',
    );
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
