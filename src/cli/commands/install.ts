// `skydeck install` (design 8): the directories and the database, three links, the two hook entries
// in Claude Code's settings file (shown and asked first, with a backup), a first refresh, and the
// one-time offer to mark old sessions as done (7.1, D20). Running it again changes nothing.
//
// The settings file is the one place where skydeck changes Claude Code's configuration
// (principle 2), so that step adds nothing but the two entries, never touches other hooks, and
// records what uninstall needs to undo exactly this change.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { addHookEntries, hookEntry, settingsPath } from '../../claude/settings.ts';
import { SkydeckError } from '../../platform/errors.ts';
import { NS_PER_DAY, isoFromNs } from '../../platform/time.ts';
import type { Files } from '../../platform/types.ts';
import type { Deck } from '../../sessions/deck.ts';
import { isListed } from '../../sessions/list.ts';
import { loadRows } from '../../sessions/load.ts';
import { describeError } from '../../sessions/problems.ts';
import { sanitize } from '../../text/sanitize.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { refreshWithProgress, withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { jsonText } from '../json.ts';

const SPEC: ArgSpec = {
  usage:
    'skydeck install\n' +
    '\n' +
    "Creates skydeck's directories and database, links the hook, the skydeck command\n" +
    "(~/.local/bin/skydeck) and Node.js, adds the two hook entries to Claude Code's\n" +
    'settings file after showing them and asking, reads in what is there, and offers once\n' +
    'to mark old sessions as done. Running it again changes nothing.\n',
  flags: {},
  min: 0,
  max: 0,
};

/** kv settings_backup when there was no settings file: uninstall then removes the file. */
const NO_FILE = 'none';
/** Backups made in one second take `-2`, `-3`, …; this many is more than any real use makes. */
const MAX_BACKUPS_PER_SECOND = 1000;

export const command: Command = {
  name: 'install',
  summary: 'Install the hooks and links',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    return withDeck(ctx, { refresh: false }, async (deck) => {
      makeLinks(ctx, deck);
      if (!(await addHooks(ctx, deck))) {
        throw new SkydeckError('settings not changed: the hook entries were not added');
      }
      refreshWithProgress(ctx, deck);
      await offerFirstRun(ctx, deck);
      ctx.io.stdout('skydeck is installed\n');
      return EXIT.ok;
    });
  },
};

/** Each link and where install points it (uninstall.ts removes exactly these). */
function links(deck: Deck): { path: string; target: string }[] {
  const { places, platform } = deck;
  return [
    { path: places.hookPath, target: join(platform.appRoot, 'bin', 'skydeck-hook') },
    { path: places.binLink, target: join(platform.appRoot, 'bin', 'skydeck') },
    { path: places.nodeLink, target: platform.nodePath },
  ];
}

/**
 * Creates the links, or points a link left by another checkout at this one. Something that is not
 * a symbolic link is never replaced (it is not skydeck's); all three are checked before any is made.
 * A link that already points where it should is not touched.
 */
function makeLinks(ctx: Context, deck: Deck): void {
  const { files } = deck.platform;
  const wanted = links(deck);
  for (const { path } of wanted) {
    const info = files.lstat(path);
    if (info !== null && info.kind !== 'symlink') {
      throw new SkydeckError(
        `${path} exists and is not a symbolic link; move it away and run skydeck install again`,
      );
    }
  }
  for (const { path, target } of wanted) {
    if (files.readlink(path) === target) {
      continue;
    }
    files.mkdirp(dirname(path));
    files.symlink(target, path);
    ctx.io.stdout(`linked ${sanitize(path)} -> ${sanitize(target)}\n`);
  }
}

/**
 * Design 8 (3). Adds the two entries when they are missing, after showing them and asking. Returns
 * false when the user did not say yes (nothing is written then).
 */
async function addHooks(ctx: Context, deck: Deck): Promise<boolean> {
  const { files } = deck.platform;
  const { claudeHome, hookPath } = deck.places;
  const path = settingsPath(claudeHome);
  const text = readSettings(files, path);
  const edit = addHookEntries(text, hookPath);
  if (!edit.changed) {
    ctx.io.stdout('hook entries already present\n');
    return true;
  }
  if (text === null && files.stat(claudeHome)?.kind !== 'dir') {
    // Most likely claudeHome or CLAUDE_CONFIG_DIR names the wrong place: do not make it up.
    throw new SkydeckError(
      `Claude Code's directory ${claudeHome} does not exist; run claude once, or set claudeHome`,
    );
  }
  // The exact groups that will be appended, by event; jsonText escapes, rather than drops, any
  // character of the path a terminal would act on, so what is shown is what is written.
  ctx.io.stderr(`skydeck will add these hook entries to ${sanitize(path)}:\n`);
  ctx.io.stderr(
    jsonText(Object.fromEntries(edit.events.map((event) => [event, [hookEntry(hookPath, event)]]))),
  );
  if (!isYes(await ctx.io.readLine('Add them? [y/N] '))) {
    return false;
  }
  const backup = backUp(deck, path, text);
  files.writeText(path, edit.text);
  const { store } = deck;
  store.transaction(() => {
    store.setKv('settings_backup', backup);
    store.setKv('settings_hash', sha256(edit.text));
  });
  ctx.io.stdout(
    backup === NO_FILE
      ? `added the hook entries to ${sanitize(path)} (a new file)\n`
      : `added the hook entries to ${sanitize(path)}; the file as it was is kept in ${sanitize(backup)}\n`,
  );
  return true;
}

function readSettings(files: Files, path: string): string | null {
  try {
    return files.readText(path);
  } catch (error) {
    throw new SkydeckError(`cannot read ${path} (${describeError(error)})`);
  }
}

/**
 * Ruled by the plan owner: every install that changes the file first keeps what is there in a new
 * file `<settingsPath>.skydeck-backup-<YYYYMMDDTHHMMSSZ>` (UTC, the platform clock; `-2`, `-3`, …
 * when that name is taken), readable by the user only, as the file can hold secrets. An older
 * backup is never touched or reused: restoring it could undo what the user changed since. Returns
 * what uninstall may restore: the new backup's path, or NO_FILE when there was no file.
 */
function backUp(deck: Deck, path: string, text: string | null): string {
  if (text === null) {
    return NO_FILE;
  }
  const { files, clock } = deck.platform;
  const stamp = isoFromNs(clock.nowNs())
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
  const base = `${path}.skydeck-backup-${stamp}`;
  for (let n = 1; n <= MAX_BACKUPS_PER_SECOND; n++) {
    const backup = n === 1 ? base : `${base}-${n}`;
    if (files.createExclusive(backup, text)) {
      files.chmod(backup, 0o600);
      return backup;
    }
  }
  throw new SkydeckError(`cannot find a free name for a backup beside ${path}`);
}

/**
 * Design 7.1 "First run", once (D20): the listed sessions that are not running and whose last
 * activity is older than firstRunDoneAfterDays may be marked as done. Nothing changes without a yes.
 */
async function offerFirstRun(ctx: Context, deck: Deck): Promise<void> {
  const { store, config } = deck;
  if (store.getKv('first_run_offered') !== null) {
    return;
  }
  const now = deck.platform.clock.nowNs();
  const days = config.firstRunDoneAfterDays;
  const before = now - BigInt(days) * NS_PER_DAY;
  const old = loadRows(deck).filter(
    (row) => isListed(row, false) && row.state === 'not-running' && row.lastActivityNs < before,
  );
  const mark =
    old.length > 0 &&
    isYes(
      await ctx.io.readLine(
        `Mark ${count(old.length, 'session')} older than ${count(days, 'day')} as done? [y/N] `,
      ),
    );
  store.transaction(() => {
    if (mark) {
      for (const row of old) {
        store.updateMeta(row.id, { doneAtNs: now }, now);
      }
    }
    store.setKv('first_run_offered', '1');
  });
  if (mark) {
    ctx.io.stdout(`marked ${count(old.length, 'session')} as done (skydeck ls --all shows them)\n`);
  }
}

function isYes(answer: string | null): boolean {
  const word = answer?.trim().toLowerCase();
  return word === 'y' || word === 'yes';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
