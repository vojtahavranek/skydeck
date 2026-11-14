/**
 * The resume card's facts for the selected session (S2 12.6, plan A27): the exact command a resume
 * would run (design 7.6's, built by the same function the resume uses), the flags it would not
 * pass on, how the session ended, and whether its transcript is expiring or gone. It only reads:
 * no lock, no refresh, nothing stored — the page asks for it on every `list`.
 */
import { buildResumeCommand, unknownFlags } from '../claude/launch.ts';
import { isSessionId } from '../claude/session-id.ts';
import type { Deck } from '../sessions/deck.ts';
import type { ListRow } from '../sessions/list.ts';
import { sanitize } from '../text/sanitize.ts';
import { printableCommand } from '../text/shell.ts';
import type { SelectedPayload } from './protocol.ts';

/**
 * How the session ended, for the card: mid-turn when it ended unexpectedly while a turn was in
 * progress (the mark `was-working`), unexpectedly (`ended-unexpectedly`), exited when its last
 * holding ended with an end event of kind exit; else nothing to say (it moved on, was cleared, or
 * no end is known).
 */
function endedOf(row: ListRow): SelectedPayload['ended'] {
  if (row.marks.includes('was-working')) return 'mid-turn';
  if (row.marks.includes('ended-unexpectedly')) return 'unexpectedly';
  return row.session.lastHolding?.endDetail === 'exit' ? 'exited' : null;
}

/**
 * A27: what the resume card shows for `row`. `command` is printableCommand of the directory and the
 * argument list buildResumeCommand gives for the session (claudeCommand, its recorded launch, its
 * label), as `prepareResume` builds them; null when the directory is not known or a word holds
 * anything the sanitiser would change. `unknownFlags` are sanitised: they come from a recorded
 * command line. Takes no lock and reads nothing but `deck.config`.
 */
export function selectedPayload(deck: Deck, row: ListRow): SelectedPayload {
  const launch = row.session.launch;
  const dir = row.session.dir;
  // Only a lowercase UUID is built into a command (buildResumeCommand throws for anything else);
  // every row skydeck lists has one, but the card must not fail the list over it.
  const argv = isSessionId(row.id)
    ? buildResumeCommand({
        claudeCommand: deck.config.claudeCommand,
        launch,
        sessionId: row.id,
        label: row.label,
      }).argv
    : null;
  return {
    sessionId: row.id,
    command: dir === null || argv === null ? null : printableCommand(dir, argv),
    flagsKnown: launch !== null,
    unknownFlags: launch === null ? [] : unknownFlags(launch).map(sanitize),
    ended: endedOf(row),
    expiring: row.marks.includes('expiring'),
    expired: row.marks.includes('expired'),
  };
}
