// Which terminal the command line starts a prepared `claude` command in (design 7.6 "Where"): here
// through the launcher's handoff, or in a new tab through the configured terminal adapter. Starting
// it, and what is said when that fails, is launchPrepared's (src/sessions/launch.ts, S2 11.1).
import type { Deck } from '../sessions/deck.ts';
import { launchPrepared } from '../sessions/launch.ts';
import type { LaunchOutcome } from '../sessions/launch.ts';
import type { PreparedLaunch } from '../sessions/resume.ts';
import { terminalFor } from '../terminals/index.ts';
import type { Terminal } from '../terminals/index.ts';

/** The terminal for `where`, or null when a tab was asked for and no adapter opens tabs (D24). */
function chooseTerminal(deck: Deck, where: 'here' | 'tab' | null): Terminal | null {
  if (where === 'here') {
    return terminalFor('here', deck.platform, deck.config);
  }
  const configured = terminalFor(deck.config.terminal, deck.platform, deck.config);
  return where === 'tab' && !configured.opensTabs ? null : configured;
}

/**
 * launchPrepared with the terminal `where` names: 'here' → hereTerminal; 'tab' → the configured
 * adapter if it opens tabs, else none (the launch fails with "no terminal adapter that opens tabs
 * is configured …" and the command to run, D24); null → config.terminal. The outcome is
 * launchPrepared's.
 */
export function launchWhere(
  deck: Deck,
  prepared: PreparedLaunch,
  where: 'here' | 'tab' | null,
): Promise<LaunchOutcome> {
  return launchPrepared(deck, prepared, chooseTerminal(deck, where));
}
