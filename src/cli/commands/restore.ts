// `skydeck restore [--all] [--dry-run] [--yes]` (design 7.8): bring back what was open before the
// machine went down.
import { buildResumeCommand } from '../../claude/launch.ts';
import { RestoreStoppedError, SkydeckError, UsageError } from '../../platform/errors.ts';
import { isoFromNs } from '../../platform/time.ts';
import type { Deck } from '../../sessions/deck.ts';
import { buildList, flatRows } from '../../sessions/list.ts';
import { loadRows } from '../../sessions/load.ts';
import { planRestore, runRestore } from '../../sessions/restore.ts';
import type { RestoreEntry } from '../../sessions/restore.ts';
import { terminalFor } from '../../terminals/index.ts';
import { sanitize } from '../../text/sanitize.ts';
import { printableCommand } from '../../text/shell.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck restore [--all] [--dry-run] [--yes]

Resumes the sessions that ended unexpectedly in the last boot before this one (a restart, or a
WSL shutdown), a few at a time in new tabs; without a terminal that opens tabs, the first one here
and, for each of the others, a "skydeck resume <id> --here" line printed to run in another
terminal. Preselected are the sessions that were still open when that boot ended; at a terminal
you can change the selection before anything starts.

  --all      also offer what ended unexpectedly in older boots and in this one
  --dry-run  print the sessions and their commands, start nothing
  --yes      take the preselection without asking (needed when stdin is not a terminal)
`,
  flags: {
    all: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
  },
  min: 0,
  max: 0,
};

const PROMPT = 'Toggle numbers, Enter to start, q to cancel: ';

export const command: Command = {
  name: 'restore',
  summary: 'Bring back what was open',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const all = parsed.flags['all'] === true;
    const dryRun = parsed.flags['dry-run'] === true;
    const yes = parsed.flags['yes'] === true;
    if (!dryRun && !yes && !ctx.io.isTTY.stdin) {
      throw new UsageError(
        `stdin is not a terminal: pass --yes to take the preselection\n${SPEC.usage}`,
      );
    }
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const entries = plan(deck, all);
      if (entries.length === 0) {
        ctx.io.stdout('nothing to restore\n');
        return EXIT.ok;
      }
      if (dryRun) {
        printPlan(ctx, deck, entries);
        return EXIT.ok;
      }
      const chosen = yes
        ? entries.filter((entry) => entry.preselected)
        : await choose(ctx, entries);
      if (chosen.length === 0) {
        ctx.io.stdout('nothing selected\n');
        return EXIT.ok;
      }
      const outcome = await runRestore(
        {
          deck,
          terminal: terminalFor(deck.config.terminal, deck.platform, deck.config),
          report: (line) => ctx.io.stdout(`${line}\n`),
        },
        chosen,
      );
      if (outcome.stoppedForMemory) {
        throw new RestoreStoppedError(
          `restore stopped: not enough memory to start ${outcome.notStarted.length} more (listed above)`,
        );
      }
      const notResumed = outcome.failed.length + outcome.timedOut.length;
      if (outcome.handedOff !== null && notResumed > 0) {
        // The launcher execs claude once this returns, so the caller sees claude's exit status,
        // never this one: the failure is said here instead.
        ctx.io.stderr(
          `skydeck: ${notResumed} of ${chosen.length} selected sessions could not be resumed; see above\n`,
        );
      }
      return notResumed > 0 ? EXIT.failure : EXIT.ok;
    });
  },
};

/**
 * The entries planRestore gives for the rows in list order (`ls --all`), with the boot id the rows
 * were derived with as the current one: never a second read, so a read that failed for the rows and
 * one that worked are not mixed (design 7.6). No rows: nothing to restore.
 */
function plan(deck: Deck, all: boolean): RestoreEntry[] {
  const loaded = loadRows(deck);
  const [first] = loaded;
  if (first === undefined) {
    return [];
  }
  const { bootId } = first.session;
  if (bootId === null) {
    // Without it every process looks dead: this boot's running sessions would be offered, and the
    // guard could not see that they run (principle 7).
    throw new SkydeckError(
      'cannot read the boot id (/proc/sys/kernel/random/boot_id): restore cannot tell which sessions are still running',
    );
  }
  const rows = flatRows(
    buildList(loaded, { showAll: true, filter: '', nowNs: deck.platform.clock.nowNs() }),
  );
  return planRestore(rows, deck.store.events(), bootId, all);
}

/** "<n>. [x| ] <short>  <title>  <how it ended>[  was working]" */
function entryLine(entry: RestoreEntry, index: number, selected: boolean): string {
  const ended =
    entry.endedAtNs === null ? 'no exit recorded' : `ended ${isoFromNs(entry.endedAtNs)}`;
  const working = entry.wasWorking ? '  was working' : '';
  return `${index + 1}. [${selected ? 'x' : ' '}] ${entry.row.shortId}  ${entry.row.title}  ${ended}${working}\n`;
}

/** --dry-run: each entry, preselection marked, with the command a resume would run (not checked by the guard). */
function printPlan(ctx: Context, deck: Deck, entries: readonly RestoreEntry[]): void {
  entries.forEach((entry, index) => {
    ctx.io.stdout(entryLine(entry, index, entry.preselected));
    ctx.io.stdout(`    ${commandLine(deck, entry)}\n`);
  });
}

/** "cd -- <q dir> && <q argv…>", or why it is not shown. */
function commandLine(deck: Deck, entry: RestoreEntry): string {
  const { row } = entry;
  const dir = row.session.dir;
  if (dir === null) {
    return '(its project directory is not known)';
  }
  const { argv } = buildResumeCommand({
    claudeCommand: deck.config.claudeCommand,
    launch: row.session.launch,
    sessionId: row.id,
    label: row.label,
  });
  return (
    printableCommand(dir, argv) ??
    '(the command contains control characters and cannot be printed safely)'
  );
}

/**
 * D19: the list, then a prompt; a line of numbers separated by spaces toggles them and shows the
 * list again, an empty line confirms, `q` (or the end of input) cancels with RestoreStoppedError.
 * A line with anything that is not a number of the list is refused whole and asked again.
 */
async function choose(ctx: Context, entries: readonly RestoreEntry[]): Promise<RestoreEntry[]> {
  const selected = entries.map((entry) => entry.preselected);
  const show = (): void => {
    entries.forEach((entry, index) =>
      ctx.io.stdout(entryLine(entry, index, selected[index] ?? false)),
    );
  };
  show();
  for (;;) {
    const line = await ctx.io.readLine(PROMPT);
    const answer = line?.trim() ?? 'q';
    if (answer === 'q') {
      throw new RestoreStoppedError('restore cancelled; nothing was started');
    }
    if (answer === '') {
      return entries.filter((_entry, index) => selected[index]);
    }
    const words = answer.split(/\s+/);
    const wrong = words.find((word) => !isNumberOf(word, entries.length));
    if (wrong !== undefined) {
      ctx.io.stderr(`skydeck: '${sanitize(wrong)}' is not a number from 1 to ${entries.length}\n`);
      continue;
    }
    for (const word of words) {
      const index = Number(word) - 1;
      selected[index] = !selected[index];
    }
    show();
  }
}

function isNumberOf(word: string, count: number): boolean {
  return /^[0-9]+$/.test(word) && Number(word) >= 1 && Number(word) <= count;
}
