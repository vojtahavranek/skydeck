// `skydeck done <ref>` (design 7.1, 7.5): hide a session. Nothing is stopped.
import { loadRows } from '../../sessions/load.ts';
import { markDone } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck done <ref>

Hides a session from the list (skydeck ls --all still shows it). It never stops a process. The
session is shown again when it has new activity, or with 'skydeck undone <ref>'.
`,
  flags: {},
  min: 1,
  max: 1,
};

export const command: Command = {
  name: 'done',
  summary: 'Hide a session',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = ''] = parsed.positionals; // `min` guarantees the reference
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      markDone(deck, row.id);
      ctx.io.stdout(`${row.shortId} done\n`);
      return EXIT.ok;
    });
  },
};
