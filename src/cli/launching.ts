// Starting a prepared `claude` command (design 7.6 "Where"): here through the launcher's handoff,
// or in a new tab through the configured terminal adapter; when that fails, the command is printed
// for the user to run instead — unless printing it could do harm.
import type { Deck } from '../sessions/deck.ts';
import { describeError } from '../sessions/problems.ts';
import type { PreparedLaunch } from '../sessions/resume.ts';
import { terminalFor } from '../terminals/index.ts';
import type { OpenResult, Terminal } from '../terminals/index.ts';
import { sanitize } from '../text/sanitize.ts';
import { shellJoin, shellQuote } from '../text/shell.ts';
import type { Context } from './context.ts';
import { EXIT } from './exit.ts';

/**
 * The WezTerm adapter's reason when its call timed out (src/terminals/wezterm.ts). The request may
 * have reached WezTerm before the call was killed, so a tab running the session may exist: a
 * printed command pasted now could resume the session a second time (principle 7).
 */
const TAB_MAY_HAVE_OPENED = 'wezterm timed out; a tab may have opened';

/** The command as a POSIX shell line: "cd -- <q dir> && <q argv…>". */
function commandLine(prepared: PreparedLaunch): string {
  return `cd -- ${shellQuote(prepared.cwd)} && ${shellJoin(prepared.argv)}`;
}

/**
 * Whether a word holds something the sanitiser would change (a control character, an escape
 * sequence, a line break or a tab). Such a word is safe inside the quotes of the handoff, which no
 * terminal shows, but not on the user's screen, where it could move the cursor or hide text, nor
 * in a line that may be pasted into a shell.
 */
function unprintable(word: string): boolean {
  return sanitize(word) !== word;
}

/**
 * The reason a launch failed, then what the user can do about it. The command is printed only when
 * running it cannot start the session a second time and it holds nothing a terminal would act on.
 */
function reportFailure(ctx: Context, prepared: PreparedLaunch, reason: string): number {
  const lines = [`skydeck: ${sanitize(reason)}`];
  if (reason === TAB_MAY_HAVE_OPENED) {
    lines.push('skydeck: run skydeck again to see whether the session is running');
  } else if ([prepared.cwd, ...prepared.argv].some(unprintable)) {
    lines.push('skydeck: the command contains control characters and cannot be printed safely');
  } else {
    lines.push('skydeck: to start it yourself, run:', commandLine(prepared));
  }
  ctx.io.stderr(`${lines.join('\n')}\n`);
  return EXIT.failure;
}

/** The terminal for `where`, or null when a tab was asked for and no adapter opens tabs (D24). */
function chooseTerminal(deck: Deck, where: 'here' | 'tab' | null): Terminal | null {
  const configured = terminalFor(deck.config.terminal, deck.platform, deck.config);
  if (where === 'here') {
    return terminalFor('here', deck.platform, deck.config);
  }
  if (where === 'tab' && !configured.opensTabs) {
    return null;
  }
  return configured;
}

/**
 * Opens a prepared command. where 'here' → hereTerminal; 'tab' → the configured adapter if it
 * opens tabs; null → config.terminal. On success returns EXIT.ok (for 'here', the caller must
 * return at once so the launcher can exec). On failure, or 'tab' without a tab adapter (D24),
 * prints the reason and the command ("cd -- <q dir> && <shellJoin argv>") on stderr and returns
 * EXIT.failure. Prints "skydeck: original flags unknown; resuming with defaults" first when
 * !prepared.flagsKnown, and, when prepared.unknownFlags is not empty, "skydeck: started with flags
 * skydeck does not know, not passed on resume: <names>" (names sanitised, joined by one space), both
 * on stderr and before it starts anything.
 *
 * Two failures print no command: a WezTerm call that timed out (a tab may have opened, and the
 * command would resume the session twice) and a command with control characters in it.
 * An open() that rejects is a failed open like any other.
 */
export async function launchPrepared(
  ctx: Context,
  deck: Deck,
  prepared: PreparedLaunch,
  where: 'here' | 'tab' | null,
): Promise<number> {
  if (!prepared.flagsKnown) {
    ctx.io.stderr('skydeck: original flags unknown; resuming with defaults\n');
  }
  if (prepared.unknownFlags.length > 0) {
    const names = prepared.unknownFlags.map(sanitize).join(' ');
    ctx.io.stderr(
      `skydeck: started with flags skydeck does not know, not passed on resume: ${names}\n`,
    );
  }
  const terminal = chooseTerminal(deck, where);
  if (terminal === null) {
    return reportFailure(
      ctx,
      prepared,
      `no terminal adapter that opens tabs is configured (set "terminal" in ${deck.places.configPath})`,
    );
  }
  let result: OpenResult;
  try {
    result = await terminal.open({ cwd: prepared.cwd, argv: prepared.argv });
  } catch (error) {
    result = { ok: false, error: `cannot open the terminal (${describeError(error)})` };
  }
  return result.ok ? EXIT.ok : reportFailure(ctx, prepared, result.error);
}
