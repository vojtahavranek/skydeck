// `skydeck unpark <ref>` (follow-up F44; design 7.1, 7.5): end a session's parking.
import { loadRows } from '../../sessions/load.ts';
import { markUnparked } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck unpark <ref>

Ends the parking of a session that was parked with 'skydeck park': it is listed as before, and
the window lists it under Open while it runs. It changes nothing else, and never starts or stops
a process. Sending the session a prompt ends its parking as well.
`,
  flags: {},
  min: 1,
  max: 1,
};

export const command: Command = {
  name: 'unpark',
  summary: 'End the parking of a session',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = ''] = parsed.positionals; // `min` guarantees the reference
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      markUnparked(deck, row.id);
      ctx.io.stdout(`${row.shortId} unparked\n`);
      return EXIT.ok;
    });
  },
};
