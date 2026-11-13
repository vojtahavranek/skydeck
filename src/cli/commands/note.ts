// `skydeck note <ref> [--set <text>]` (design 7.1, 7.5): edit a session's note in $EDITOR, or set it.
import { loadRows } from '../../sessions/load.ts';
import { setNote } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { discardKeptNote, editNote } from '../notes.ts';

const SPEC: ArgSpec = {
  usage: `skydeck note <ref> [--set <text>]

Edits the note of a session in $VISUAL, else $EDITOR, else vi (stdin must be a terminal). With
--set the note is replaced by <text> at once, and --set '' clears it. A note is free text of any
length and is stored as typed.
`,
  flags: { set: { type: 'string' } },
  min: 1,
  max: 1,
};

export const command: Command = {
  name: 'note',
  summary: "Edit a session's note",
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = ''] = parsed.positionals; // `min` guarantees the reference
    const text = parsed.flags['set'];
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const row = resolveRef(ref, loadRows(deck));
      if (typeof text === 'string') {
        setNote(deck, row.id, text);
        discardKeptNote(deck, row.id);
      } else {
        await editNote(ctx, deck, row.id);
      }
      const note = deck.store.meta(row.id)?.note ?? null;
      ctx.io.stdout(`${row.shortId} note ${note === null ? 'cleared' : 'saved'}\n`);
      return EXIT.ok;
    });
  },
};
