// `skydeck new [--label <text>] [--group <text>] [--here | --tab | --window] [-- <claude flags>]`
// (design 7.7; S2 11.4: `--window` sends the directory, label, group and flags to the window's
// server, src/cli/window-requests.ts).
import { UsageError } from '../../platform/errors.ts';
import { prepareNew } from '../../sessions/resume.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec, ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { launchWhere } from '../launching.ts';
import { newInWindow } from '../window-requests.ts';

const SPEC: ArgSpec = {
  usage: `skydeck new [--label <text>] [--group <text>] [--here | --tab | --window] [-- <claude flags>]

Starts a new Claude Code session in the current directory, with a session id skydeck chooses,
so that the label and group are attached to it from the start.

  --label <text>  the session's label, also passed to claude as its name
  --group <text>  the session's group
  --here          replace skydeck with claude in this terminal
  --tab           open claude in a new terminal tab
  --window        start it in the skydeck window (skydeck window must be running)
  -- <flags>      everything after -- is passed to claude as it is
Without --here, --tab or --window, the configured "terminal" decides.
`,
  flags: {
    label: { type: 'string' },
    group: { type: 'string' },
    here: { type: 'boolean' },
    tab: { type: 'boolean' },
    window: { type: 'boolean' },
  },
  min: 0,
  max: 0,
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

function text(value: string | boolean | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export const command: Command = {
  name: 'new',
  summary: 'Start a new session here',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const where = whereFrom(parsed, SPEC.usage);
    return withDeck(ctx, { refresh: true }, async (deck) => {
      if (where === 'window') {
        // The window's server checks and prepares it as this command would (S2 8.3).
        return newInWindow(ctx, deck, {
          dir: deck.platform.cwd,
          label: text(parsed.flags['label']),
          group: text(parsed.flags['group']),
          flags: parsed.rest,
        });
      }
      const prepared = prepareNew(deck, {
        dir: deck.platform.cwd,
        label: text(parsed.flags['label']),
        group: text(parsed.flags['group']),
        extra: parsed.rest,
      });
      const outcome = await launchWhere(deck, prepared, where);
      for (const line of outcome.lines) {
        ctx.io.stderr(`${line}\n`);
      }
      return outcome.code;
    });
  },
};
