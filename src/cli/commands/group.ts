// `skydeck group <ref> [<text>]` (design 7.1, 7.5): set a session's group, or clear it.
import { cleanGroup } from '../../sessions/labels.ts';
import { loadRows } from '../../sessions/load.ts';
import { setGroup } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck group <ref> [<text>]

Sets the group of a session. The text is all the arguments after <ref>, joined by one space; it
must be one line without control characters. Without text, or with an empty text (a script may
pass an empty variable), the group is cleared (a title that starts with a ticket key still gives
the session that key as its group).
`,
  flags: {},
  min: 1,
  max: Infinity,
};

export const command: Command = {
  name: 'group',
  summary: "Set or clear a session's group",
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = '', ...words] = parsed.positionals; // `min` guarantees the reference
    const text = words.join(' ');
    const group = text.trim() === '' ? null : cleanGroup(text); // no text, or an empty one, clears
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      setGroup(deck, row.id, group);
      ctx.io.stdout(
        group === null ? `${row.shortId} group cleared\n` : `${row.shortId} group: ${group}\n`,
      );
      return EXIT.ok;
    });
  },
};
