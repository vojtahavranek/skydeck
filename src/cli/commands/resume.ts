// `skydeck resume <ref> [--here | --tab | --window] [-- <claude flags>]` (design 7.6; S2 11.4:
// `--window`, or `"terminal": "window"` without `--here`, sends the session id to the window's
// server, src/cli/window-requests.ts; plan C13's whereFor decides). Issue #188: the words after
// `--` are the flags of this resume in place of the recorded ones (design 7.6 "Other flags"); the
// window's server is handed them as they are and checks them itself, as for `new --window`.
import { UsageError } from '../../platform/errors.ts';
import { loadRows } from '../../sessions/load.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { prepareResumeById } from '../../sessions/resume-by-id.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec, ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { launchWhere, whereFor } from '../launching.ts';
import { resumeInWindow } from '../window-requests.ts';

const SPEC: ArgSpec = {
  usage: `skydeck resume <ref> [--here | --tab | --window] [-- <claude flags>]

Resumes a session that is not running, in its own directory and with the flags it was started
with. <ref> is a session id, an id prefix of at least 4 characters, or a label.

  --here      replace skydeck with claude in this terminal
  --tab       open claude in a new terminal tab
  --window    start it in the skydeck window (skydeck window must be running)
  -- <flags>  claude's flags for this resume, in place of the ones it was started with;
              -- alone resumes it with none
Without --here, --tab or --window, the configured "terminal" decides.
`,
  flags: { here: { type: 'boolean' }, tab: { type: 'boolean' }, window: { type: 'boolean' } },
  min: 1,
  max: 1,
  allowRest: true,
};

/** 'here', 'tab', 'window' or null (the configured terminal); UsageError when two are given. */
function whereFrom(parsed: ParsedArgs, usage: string): 'here' | 'tab' | 'window' | null {
  const given = (['here', 'tab', 'window'] as const).filter((name) => parsed.flags[name] === true);
  if (given.length > 1) {
    const names = given.map((name) => `--${name}`);
    throw new UsageError(
      `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''} cannot be used together\n${usage}`,
    );
  }
  return given[0] ?? null;
}

export const command: Command = {
  name: 'resume',
  summary: 'Resume a session',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const flag = whereFrom(parsed, SPEC.usage);
    const [ref = ''] = parsed.positionals;
    // #188: `--` given, its words (maybe none) in place of the recorded flags; else the recorded.
    const flags = parsed.restGiven ? parsed.rest : null;
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      const where = whereFor(deck.config, flag);
      // The window's server prepares the resume itself, through the guard and the lock (S2 8.3),
      // and checks the flags as this command would.
      if (where === 'window') return resumeInWindow(ctx, deck, row.id, flags);
      // The guard refreshes again by itself and decides on the rows of that refresh, not on these.
      const outcome = await launchWhere(deck, prepareResumeById(deck, row.id, flags), where);
      for (const line of outcome.lines) {
        ctx.io.stderr(`${line}\n`);
      }
      return outcome.code;
    });
  },
};
