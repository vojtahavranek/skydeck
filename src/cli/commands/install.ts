// `skydeck install` (design 8): the directories and the database, three links, the two hook entries
// in Claude Code's settings file (shown and asked first, with a backup), a first refresh, and the
// one-time offer to mark old sessions as done (7.1, D20). Running it again changes nothing. It
// writes nothing for the window (S2 16.1): it only says so when python3 3.9 or newer, which the
// window's keepers need, is not found. Last, it offers to turn off Claude Code's ← shortcut
// (follow-up F11, S2 7.9). On a system without a boot id (macOS, for now) it does none of this: it
// says that skydeck cannot work there and stops (follow-up F23).
//
// The settings file is the one place where skydeck changes Claude Code's configuration on its own
// account (principle 2), so that step adds nothing but the two entries, never touches other hooks,
// never writes over a change it did not show, and records what uninstall needs to undo exactly
// this change. Every check that can stop install runs before anything is created, so a refusal, or
// a no, leaves nothing behind (ruled by the plan owner). The ← step is the user's own choice made
// through skydeck: after a yes it sets that one key in Claude Code's global config file, and it
// never changes install's result.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  LEFT_ARROW_KEY,
  LEFT_ARROW_LABEL,
  readLeftArrow,
  turnLeftArrowOff,
} from '../../claude/global-config.ts';
import type { TurnOffResult } from '../../claude/global-config.ts';
import { addHookEntries, hookEntry, rewriteReport, settingsPath } from '../../claude/settings.ts';
import type { RewriteReport, SettingsEdit } from '../../claude/settings.ts';
import { SkydeckError } from '../../platform/errors.ts';
import type { Places } from '../../platform/paths.ts';
import { NS_PER_DAY } from '../../platform/time.ts';
import type { Files, Platform } from '../../platform/types.ts';
import type { Deck } from '../../sessions/deck.ts';
import { resolveDeckPlaces } from '../../sessions/deck.ts';
import { isListed } from '../../sessions/list.ts';
import { loadRows } from '../../sessions/load.ts';
import { markDone } from '../../sessions/meta.ts';
import { describeError } from '../../sessions/problems.ts';
import { sanitize } from '../../text/sanitize.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { refreshWithProgress, withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { jsonText } from '../json.ts';
import { PYTHON3_NEEDED, probePython3 } from '../python.ts';
import { backupBase, createBackup, nextBackupName } from '../settings-backup.ts';

const SPEC: ArgSpec = {
  usage:
    'skydeck install\n' +
    '\n' +
    "Creates skydeck's directories and database, links the hook, the skydeck command\n" +
    "(~/.local/bin/skydeck) and Node.js, adds the two hook entries to Claude Code's\n" +
    'settings file after showing them and asking, reads in what is there, offers once to\n' +
    "mark old sessions as done, and offers to turn off Claude Code's ← shortcut. Running it\n" +
    'again changes nothing.\n',
  flags: {},
  min: 0,
  max: 0,
};

/** kv settings_backup when there was no settings file: uninstall then removes the file. */
const NO_FILE = 'none';

interface Link {
  path: string;
  target: string;
}

/** What install found before it changed anything. */
interface Prepared {
  settingsPath: string;
  /** The settings file's text when it was read (and shown), null when there was none. */
  text: string | null;
  edit: SettingsEdit;
  /** What writing the file back would change besides the entries; null when there is no file. */
  rewrite: RewriteReport | null;
  /**
   * The name of the backup, without `-2`, `-3`, …: made when the question is asked, so that the
   * path the question names is the one the backup gets however long the answer takes. null when
   * there is no file to keep.
   */
  backupBase: string | null;
  links: Link[];
}

export const command: Command = {
  name: 'install',
  summary: 'Install the hooks and links',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    if (!hasBootId(ctx.platform)) {
      ctx.io.stderr(`${NO_BOOT_ID}\n`);
      return EXIT.failure;
    }
    const { places } = resolveDeckPlaces(ctx.platform);
    const prepared = prepare(ctx.platform, places);
    if (prepared.edit.changed) {
      showChange(ctx, places.hookPath, prepared);
      if (!isYes(await ctx.io.readLine('Add them? [y/N] '))) {
        ctx.io.stderr('settings not changed\n');
        return EXIT.failure;
      }
      requireUnchanged(ctx.platform.files, prepared);
    }
    return withDeck(ctx, { refresh: false }, async (deck) => {
      makeLinks(ctx, deck.platform.files, prepared.links);
      if (prepared.edit.changed) {
        writeSettings(ctx, deck, prepared);
      } else {
        ctx.io.stdout('hook entries already present\n');
      }
      refreshWithProgress(ctx, deck);
      await offerFirstRun(ctx, deck);
      // S2 16.1: the commands do not need python3, so this is said and nothing else changes.
      if ((await probePython3(deck.platform)).kind !== 'found') {
        ctx.io.stdout(`${PYTHON3_NEEDED}\n`);
      }
      await offerLeftArrowOff(ctx, deck);
      ctx.io.stdout('skydeck is installed\n');
      return EXIT.ok;
    });
  },
};

/** Each link and where install points it (uninstall.ts removes exactly these). */
function linksFor(platform: Platform, places: Places): Link[] {
  return [
    { path: places.hookPath, target: join(platform.appRoot, 'bin', 'skydeck-hook') },
    { path: places.binLink, target: join(platform.appRoot, 'bin', 'skydeck') },
    { path: places.nodeLink, target: platform.nodePath },
  ];
}

/** Where the boot id is read (src/platform/real.ts). */
const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';

const NO_BOOT_ID =
  'skydeck works on Linux and on Windows with WSL2 (run inside WSL) only: this system has no ' +
  `${BOOT_ID_FILE} (macOS is not supported yet); nothing was changed`;

/**
 * Follow-up F23: whether this system has a boot id. skydeck judges every process by it (design
 * 5.5) and ingest drops a hook event without one, so on a system that has none (macOS, for now)
 * skydeck would record nothing and never show a session as running. Install asks this first of
 * all: before any question, before config.json is read, before anything is created. It is decided
 * by the boot id, not by the system's name. A boot id that cannot be read for another reason
 * (EACCES …) stops install too, naming the cause.
 */
function hasBootId(platform: Platform): boolean {
  try {
    return platform.proc.bootId() !== null;
  } catch (error) {
    throw new SkydeckError(
      `cannot read ${BOOT_ID_FILE} (${describeError(error)}), which skydeck needs to tell which ` +
        'sessions are running; nothing was changed',
    );
  }
}

/**
 * Every check that can stop install, after the boot id's (hasBootId) and before anything is
 * created (ruled by the plan owner): a link path that holds something that is not a symbolic link
 * (never replaced: it is not skydeck's); a settings file that cannot be read or is not JSON; a
 * settings path that is a symbolic link to nothing (never replaced by a file); no settings file
 * and no Claude Code directory (never made up: most likely claudeHome or CLAUDE_CONFIG_DIR names
 * the wrong place).
 */
function prepare(platform: Platform, places: Places): Prepared {
  const { files } = platform;
  const links = linksFor(platform, places);
  for (const { path } of links) {
    refuseNonLink(files, path);
  }
  const path = settingsPath(places.claudeHome);
  const text = readSettings(files, path);
  if (text === null && files.lstat(path)?.kind === 'symlink') {
    throw new SkydeckError(
      `${path} is a symbolic link to ${files.readlink(path) ?? '?'}, which does not exist; ` +
        'create that file or remove the link, then run skydeck install again',
    );
  }
  if (text === null && files.stat(places.claudeHome)?.kind !== 'dir') {
    throw new SkydeckError(
      `Claude Code's directory ${places.claudeHome} does not exist; run claude once, or set claudeHome`,
    );
  }
  return {
    settingsPath: path,
    text,
    edit: addHookEntries(text, places.hookPath),
    rewrite: text === null ? null : rewriteReport(text),
    backupBase: text === null ? null : backupBase(path, platform.clock),
    links,
  };
}

/** Something at a link path that is not a symbolic link is not skydeck's: it is never replaced. */
function refuseNonLink(files: Files, path: string): void {
  const info = files.lstat(path);
  if (info !== null && info.kind !== 'symlink') {
    throw new SkydeckError(
      `${path} exists and is not a symbolic link; move it away and run skydeck install again`,
    );
  }
}

function readSettings(files: Files, path: string): string | null {
  try {
    return files.readText(path);
  } catch (error) {
    throw new SkydeckError(`cannot read ${path} (${describeError(error)})`);
  }
}

/**
 * The exact groups that will be appended, by event. jsonText escapes, rather than drops, any
 * character of the path a terminal would act on, so what is shown is what is written.
 *
 * The file does not go back as it was, only with the entries added: it is parsed and written in
 * skydeck's formatting. When that would change more than the entries, one more line says so and
 * names the backup (ruled by the plan owner; no refusal: Claude Code rewrites the file in the same
 * formatting whenever it saves a setting). A number that would lose digits is the one case where
 * content, not formatting, changes: its key is named.
 */
function showChange(ctx: Context, hookPath: string, prepared: Prepared): void {
  const { files } = ctx.platform;
  const added = Object.fromEntries(
    prepared.edit.events.map((event) => [event, [hookEntry(hookPath, event)]]),
  );
  ctx.io.stderr(`skydeck will add these hook entries to ${sanitize(prepared.settingsPath)}:\n`);
  ctx.io.stderr(jsonText(added));
  const { rewrite, backupBase: base } = prepared;
  if (rewrite?.reformatted === true && base !== null) {
    const lost =
      rewrite.lossyPaths.length === 0
        ? ''
        : ` and ${rewrite.lossyPaths.join(', ')} would lose digits`;
    const backup = nextBackupName(files, prepared.settingsPath, base);
    ctx.io.stderr(
      sanitize(
        `the rest of the file will be rewritten in skydeck's formatting${lost}; ` +
          `the file as it is now is kept in ${backup}`,
      ) + '\n',
    );
  }
}

/**
 * The settings file must still be what was read and shown: the user may have saved it while the
 * question was open (or another session's /model did), and writing the old text plus the entries
 * would undo that change.
 */
function requireUnchanged(files: Files, prepared: Prepared): void {
  if (readSettings(files, prepared.settingsPath) !== prepared.text) {
    throw new SkydeckError(
      `${prepared.settingsPath} changed while the question was open, so skydeck left it as it ` +
        'is; run skydeck install again',
    );
  }
}

/**
 * Creates the links, or points a link left by another checkout at this one. A link that already
 * points where it should is not touched. prepare() refused anything that is not a link; each path
 * is looked at again here, since the question was open in between.
 */
function makeLinks(ctx: Context, files: Files, links: readonly Link[]): void {
  for (const { path, target } of links) {
    if (files.readlink(path) === target) {
      continue;
    }
    refuseNonLink(files, path);
    try {
      files.mkdirp(dirname(path));
      files.symlink(target, path);
    } catch (error) {
      throw new SkydeckError(`cannot create the link ${path} (${describeError(error)})`);
    }
    ctx.io.stdout(`linked ${sanitize(path)} -> ${sanitize(target)}\n`);
  }
}

/**
 * Design 8 (3) after the yes: checks once more, right before writing, that the file is what was
 * shown; keeps it in a new backup; writes the entries; records the backup and the hash. A write
 * that fails is an ordinary error naming the file, and the backup this run made of the unchanged
 * file is removed again.
 */
function writeSettings(ctx: Context, deck: Deck, prepared: Prepared): void {
  const { files } = deck.platform;
  const { settingsPath: path, text, edit } = prepared;
  requireUnchanged(files, prepared);
  const backup =
    text === null || prepared.backupBase === null
      ? NO_FILE
      : createBackup(files, path, prepared.backupBase, text);
  try {
    files.writeText(path, edit.text);
  } catch (error) {
    let kept = '';
    if (backup !== NO_FILE) {
      try {
        files.remove(backup);
      } catch {
        kept = `; its backup stays in ${backup}`;
      }
    }
    throw new SkydeckError(
      `cannot write ${path} (${describeError(error)}); it was not changed${kept}`,
    );
  }
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
        markDone(deck, row.id);
      }
    }
    store.setKv('first_run_offered', '1');
  });
  if (mark) {
    ctx.io.stdout(`marked ${count(old.length, 'session')} as done (skydeck ls --all shows them)\n`);
  }
}

/** How the user turns the shortcut off without skydeck. */
const IN_CLAUDE_CODE = `/config in Claude Code ("${LEFT_ARROW_LABEL}")`;

/**
 * Follow-up F11 (S2 7.9): when Claude Code's ← shortcut is on, says what it does and why it bites
 * in the window, and asks; after a yes, sets leftArrowOpensAgents to false in the global config
 * file, with a backup made as for the settings file. Off: one line. Cannot be told: one line that
 * names the file, left alone. It runs after every other step has succeeded and never changes
 * install's result: whatever goes wrong is one line on stderr. No line holds a value of the file.
 */
async function offerLeftArrowOff(ctx: Context, deck: Deck): Promise<void> {
  const { platform, places } = deck;
  const path = places.claudeGlobalConfig;
  const say = (text: string): void => {
    ctx.io.stdout(`${sanitize(text)}\n`);
  };
  try {
    const reading = readLeftArrow(platform.files, platform.uid, path);
    if (reading.state === 'off') {
      say(OFF_LINE);
      return;
    }
    if (reading.state === 'unknown') {
      say(leftAlone(path, reading.reason ?? 'it cannot be read'));
      return;
    }
    for (const line of [
      "Claude Code's ← shortcut is on: ← on an empty prompt sends the session to the background and opens agent view.",
      "← also closes a group in skydeck's list, so a ← meant for the list can send a window terminal's session away.",
      `Turning it off sets only ${LEFT_ARROW_KEY} in ${path}, after a backup; agent view itself stays (claude agents, /bg).`,
    ]) {
      ctx.io.stderr(`${sanitize(line)}\n`);
    }
    if (!isYes(await ctx.io.readLine('Turn the shortcut off? [y/N] '))) {
      say(
        `the ← shortcut stays on; to turn it off later: ${IN_CLAUDE_CODE}, or skydeck install again`,
      );
      return;
    }
    const base = backupBase(path, platform.clock);
    const result = turnLeftArrowOff(platform.files, platform.uid, path, (text) =>
      createBackup(platform.files, path, base, text),
    );
    for (const line of turnedOffLines(path, result)) {
      say(line);
    }
  } catch (error) {
    const line = `could not turn Claude Code's ← shortcut off: ${stepFailure(error)}; to turn it off: ${IN_CLAUDE_CODE}`;
    ctx.io.stderr(`${sanitize(line)}\n`);
  }
}

const OFF_LINE = "Claude Code's ← shortcut is off";

function leftAlone(path: string, reason: string): string {
  return `Claude Code's ← shortcut: left ${path} alone (${reason}); to turn it off: ${IN_CLAUDE_CODE}`;
}

function turnedOffLines(path: string, result: TurnOffResult): string[] {
  switch (result.kind) {
    case 'written':
      return [
        `turned Claude Code's ← shortcut off in ${path}; the file as it was is kept in ${result.backup}`,
        'the shortcut is off for sessions started from now on; a session already running keeps it until it is started again',
      ];
    case 'off':
      return [OFF_LINE];
    case 'unknown':
      return [leftAlone(path, result.reason)];
    case 'kept-changing':
      return [
        `${path} kept changing while skydeck wrote it, so skydeck left it as it is; to turn the ← shortcut off: ${IN_CLAUDE_CODE}`,
      ];
  }
}

/**
 * What went wrong, without a value of the file: a SkydeckError's own message (the writer's and the
 * backup's name the path and an error code only). Anything else did not come from the write (which
 * turns every failure of its own into a SkydeckError) but from the question, the clock or the
 * output, perhaps after the write: its code or its name, and no claim about the file.
 */
function stepFailure(error: unknown): string {
  if (error instanceof SkydeckError) {
    return error.message;
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  let what = error instanceof Error ? error.name : typeof error;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) {
    what = code;
  }
  return `an unexpected error (${what}); skydeck doctor says whether it is off`;
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
