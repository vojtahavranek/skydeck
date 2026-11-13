// `skydeck undone <ref>` (design 7.1, 7.5): show a hidden session again.
import { loadRows } from '../../sessions/load.ts';
import { markUndone } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck undone <ref>

Shows a session that was hidden with 'skydeck done' in the list again. <ref> may be the session's
label: hidden sessions are searched too.
`,
  flags: {},
  min: 1,
  max: 1,
};

export const command: Command = {
  name: 'undone',
  summary: 'Show a hidden session again',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = ''] = parsed.positionals; // `min` guarantees the reference
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      markUndone(deck, row.id);
      ctx.io.stdout(`${row.shortId} undone\n`);
      return EXIT.ok;
    });
  },
};
