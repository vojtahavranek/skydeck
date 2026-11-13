// `skydeck label <ref> [<text>]` (design 7.1, 7.5): set a session's label, or clear it.
import { cleanLabel } from '../../sessions/labels.ts';
import { loadRows } from '../../sessions/load.ts';
import { setLabel } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck label <ref> [<text>]

Sets the label of a session. The text is all the arguments after <ref>, joined by one space; it
must be one line without control characters, and must not start with '-'. Without text, the label
is cleared.
`,
  flags: {},
  min: 1,
  max: Infinity,
};

export const command: Command = {
  name: 'label',
  summary: "Set or clear a session's label",
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = '', ...words] = parsed.positionals; // `min` guarantees the reference
    const label = words.length === 0 ? null : cleanLabel(words.join(' '));
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      setLabel(deck, row.id, label);
      ctx.io.stdout(
        label === null ? `${row.shortId} label cleared\n` : `${row.shortId} label: ${label}\n`,
      );
      return EXIT.ok;
    });
  },
};
