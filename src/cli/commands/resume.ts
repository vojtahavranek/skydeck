// `skydeck resume <ref> [--here | --tab]` (design 7.6).
import { UsageError } from '../../platform/errors.ts';
import { loadRows } from '../../sessions/load.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { prepareResume } from '../../sessions/resume.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec, ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { launchPrepared } from '../launching.ts';

const SPEC: ArgSpec = {
  usage: `skydeck resume <ref> [--here | --tab]

Resumes a session that is not running, in its own directory and with the flags it was started
with. <ref> is a session id, an id prefix of at least 4 characters, or a label.

  --here  replace skydeck with claude in this terminal
  --tab   open claude in a new terminal tab
Without either, the configured "terminal" decides.
`,
  flags: { here: { type: 'boolean' }, tab: { type: 'boolean' } },
  min: 1,
  max: 1,
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

export const command: Command = {
  name: 'resume',
  summary: 'Resume a session',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const where = whereFrom(parsed, SPEC.usage);
    const [ref = ''] = parsed.positionals;
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      const outcome = await launchPrepared(deck, prepareResume(deck, row), where);
      for (const line of outcome.lines) {
        ctx.io.stderr(`${line}\n`);
      }
      return outcome.code;
    });
  },
};
