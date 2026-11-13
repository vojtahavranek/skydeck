// `skydeck uninstall [--purge]` (design 8): undoes install's change to Claude Code's settings file,
// removes install's links, and with --purge skydeck's own directories. It never creates anything:
// with no database there is nothing recorded, and only the entries naming the hook are removed.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { removeHookEntries, settingsPath } from '../../claude/settings.ts';
import { SkydeckError } from '../../platform/errors.ts';
import type { Places } from '../../platform/paths.ts';
import type { Files, Platform } from '../../platform/types.ts';
import { resolveDeckPlaces } from '../../sessions/deck.ts';
import { describeError } from '../../sessions/problems.ts';
import { sanitize } from '../../text/sanitize.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage:
    'skydeck uninstall [--purge]\n' +
    '\n' +
    "Puts Claude Code's settings file back as it was before install when nobody changed it\n" +
    'since, otherwise removes only the hook entries that name skydeck-hook, and removes the\n' +
    'links install made. The database stays.\n' +
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
      await withDeck(ctx, { refresh: false }, async (deck) => {
        const { store } = deck;
        undo(ctx, places, {
          hash: store.getKv('settings_hash'),
          backup: store.getKv('settings_backup'),
        });
        store.transaction(() => {
          store.deleteKv('settings_hash');
          store.deleteKv('settings_backup');
        });
      });
    }
    if (parsed.flags['purge'] === true) {
      // After withDeck: the store is closed.
      for (const dir of [places.dataDir, places.stateDir, places.configDir]) {
        if (platform.files.lstat(dir) !== null) {
          platform.files.removeTree(dir);
          ctx.io.stdout(`removed ${sanitize(dir)}\n`);
        }
      }
    }
    return EXIT.ok;
  },
};

/** The settings first (they name the hook link), then the links. */
function undo(ctx: Context, places: Places, recorded: Recorded): void {
  restoreSettings(ctx, ctx.platform.files, places, recorded);
  removeLinks(ctx, ctx.platform, places);
}

/**
 * Design 8: when the file is still exactly what install wrote (its hash), the state before install
 * comes back: the backup, or no file at all. Otherwise, or when the backup is gone, exactly the hook
 * objects whose command names hookPath are removed, and everything else stays.
 */
function restoreSettings(ctx: Context, files: Files, places: Places, recorded: Recorded): void {
  const path = settingsPath(places.claudeHome);
  const text = readOrFail(files, path);
  if (text === null) {
    return;
  }
  if (recorded.hash !== null && sha256(text) === recorded.hash) {
    if (recorded.backup === 'none') {
      files.remove(path);
      ctx.io.stdout(`removed ${sanitize(path)}: there was none before skydeck install\n`);
      return;
    }
    const before = recorded.backup === null ? null : readOrFail(files, recorded.backup);
    if (recorded.backup !== null && before !== null) {
      files.writeText(path, before);
      files.remove(recorded.backup);
      ctx.io.stdout(`restored ${sanitize(path)} from ${sanitize(recorded.backup)}\n`);
      return;
    }
  }
  const edit = removeHookEntries(text, places.hookPath);
  if (edit.changed) {
    files.writeText(path, edit.text);
    ctx.io.stdout(`removed the hook entries from ${sanitize(path)}\n`);
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
      files.remove(path);
      ctx.io.stdout(`removed ${sanitize(path)}\n`);
    } else {
      ctx.io.stdout(`left ${sanitize(path)} alone: it points at ${sanitize(current)}\n`);
    }
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
