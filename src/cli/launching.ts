// Where the command line starts a session (design 7.6 "Where"; S2 11.4): here through the
// launcher's handoff, in a new tab through the configured terminal adapter, or in the window,
// whose server starts it (src/cli/window-requests.ts). `whereFor` decides (plan C13); starting a
// prepared `claude` command here or in a tab, and what is said when that fails, is launchPrepared's
// (src/sessions/launch.ts, S2 11.1).
import type { Config } from '../platform/config.ts';
import type { Deck } from '../sessions/deck.ts';
import { launchPrepared } from '../sessions/launch.ts';
import type { LaunchOutcome } from '../sessions/launch.ts';
import type { PreparedLaunch } from '../sessions/resume.ts';
import { terminalFor } from '../terminals/index.ts';
import type { Terminal } from '../terminals/index.ts';

/**
 * Plan C13: where a command goes, from the configured `terminal` and the option given (`flag`,
 * null for none). With `"window"`, no option, `--tab` and `--window` go to the window and `--here`
 * stays here; with `"here"` or `"wezterm"` only `--window` goes to the window, an option names its
 * place and no option is the configured one (`wezterm`: a tab).
 */
export function whereFor(
  config: Config,
  flag: 'here' | 'tab' | 'window' | null,
): 'here' | 'tab' | 'window' {
  if (config.terminal === 'window') return flag === 'here' ? 'here' : 'window';
  if (flag !== null) return flag;
  return config.terminal === 'wezterm' ? 'tab' : 'here';
}

/** The terminal for `where`, or null when a tab was asked for and no adapter opens tabs (D24). */
function chooseTerminal(deck: Deck, where: 'here' | 'tab' | null): Terminal | null {
  if (where === 'here') {
    return terminalFor('here', deck.platform, deck.config);
  }
  const { terminal } = deck.config;
  if (terminal === 'window') {
    // Contract 2.4: the window's launches go through its server (whereFor), never through here.
    throw new RangeError(
      `launchWhere: with "terminal": "window" only here is a terminal of the command line, not ${where ?? 'the configured one'}`,
    );
  }
  const configured = terminalFor(terminal, deck.platform, deck.config);
  return where === 'tab' && !configured.opensTabs ? null : configured;
}

/**
 * launchPrepared with the terminal `where` names: 'here' → hereTerminal; 'tab' → the configured
 * adapter if it opens tabs, else none (the launch fails with "no terminal adapter that opens tabs
 * is configured …" and the command to run, D24); null → config.terminal. With `"terminal":
 * "window"` only 'here' (a RangeError otherwise, contract 2.4). The outcome is launchPrepared's.
 */
export function launchWhere(
  deck: Deck,
  prepared: PreparedLaunch,
  where: 'here' | 'tab' | null,
): Promise<LaunchOutcome> {
  return launchPrepared(deck, prepared, chooseTerminal(deck, where));
}
