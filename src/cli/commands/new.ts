// `skydeck new [--label <text>] [--group <text>] [--here | --tab] [-- <claude flags>]` (design 7.7).
import { UsageError } from '../../platform/errors.ts';
import { prepareNew } from '../../sessions/resume.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec, ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { launchPrepared } from '../launching.ts';

const SPEC: ArgSpec = {
  usage: `skydeck new [--label <text>] [--group <text>] [--here | --tab] [-- <claude flags>]

Starts a new Claude Code session in the current directory, with a session id skydeck chooses,
so that the label and group are attached to it from the start.

  --label <text>  the session's label, also passed to claude as its name
  --group <text>  the session's group
  --here          replace skydeck with claude in this terminal
  --tab           open claude in a new terminal tab
  -- <flags>      everything after -- is passed to claude as it is
Without --here or --tab, the configured "terminal" decides.
`,
  flags: {
    label: { type: 'string' },
    group: { type: 'string' },
    here: { type: 'boolean' },
    tab: { type: 'boolean' },
  },
  min: 0,
  max: 0,
  allowRest: true,
};

/** 'here', 'tab' or null (the configured terminal); UsageError when both are given. */
function whereFrom(parsed: ParsedArgs, usage: string): 'here' | 'tab' | null {
  const here = parsed.flags['here'] === true;
  const tab = parsed.flags['tab'] === true;
  if (here && tab) {
    throw new UsageError(`--here and --tab cannot be used together\n${usage}`);
  }
  return here ? 'here' : tab ? 'tab' : null;
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
      const prepared = prepareNew(deck, {
        label: text(parsed.flags['label']),
        group: text(parsed.flags['group']),
        extra: parsed.rest,
      });
      const outcome = await launchPrepared(deck, prepared, where);
      for (const line of outcome.lines) {
        ctx.io.stderr(`${line}\n`);
      }
      return outcome.code;
    });
  },
};
