// `skydeck park <ref>` (follow-up F44; design 7.1, 7.5): set a session aside. Nothing is stopped.
import { loadRows } from '../../sessions/load.ts';
import { markParked } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck park <ref>

Parks a session: it waits, for a review, a person or another part of the work. It stays listed,
with its mark and how long it has been parked, and the window lists it under Parked. It never
stops a process: running in a terminal of the window, it goes on running there, and that terminal
gives its number 1-9 up for the next one. It is no longer parked once you send it a prompt, or
with 'skydeck unpark <ref>'. Parking a session marked done shows it again.
`,
  flags: {},
  min: 1,
  max: 1,
};

export const command: Command = {
  name: 'park',
  summary: 'Set a session aside',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = ''] = parsed.positionals; // `min` guarantees the reference
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      // A session that is parked already keeps the time it was parked (nothing is written).
      markParked(deck, row);
      ctx.io.stdout(`${row.shortId} parked\n`);
      return EXIT.ok;
    });
  },
};
