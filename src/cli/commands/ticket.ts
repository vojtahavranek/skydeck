// `skydeck ticket set <ref> <link-or-key> | ticket clear <ref>` (follow-up F18; design 7.1, 7.5):
// set a session's ticket — a whole link, or a key that ticketUrl turns into one — or remove it.
import { UsageError } from '../../platform/errors.ts';
import { loadRows } from '../../sessions/load.ts';
import { requireTicket, setTicket } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { sanitize } from '../../text/sanitize.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck ticket set <ref> <link-or-key> | ticket clear <ref>

  ticket set <ref> <link-or-key>   set the session's ticket, replacing the one before: an http or
                                   https link (stored as the window opens it; quote one that holds
                                   ? & or #), or a key like ABC-123, which ticketUrl in config.json
                                   turns into its link (a key needs ticketUrl); the address is what
                                   is stored, so a later ticketUrl does not move it. An empty text
                                   removes the ticket.
  ticket clear <ref>               remove the session's ticket
`,
  flags: {},
  min: 1,
  max: 3,
};

/** UsageError "missing argument" / "too many arguments" unless `rest` has exactly `count` words. */
function expectArguments(rest: readonly string[], count: number): void {
  if (rest.length !== count) {
    const reason = rest.length < count ? 'missing argument' : 'too many arguments';
    throw new UsageError(`${reason}\n${SPEC.usage}`);
  }
}

export const command: Command = {
  name: 'ticket',
  summary: "Set or clear a session's ticket",
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [subcommand = '', ...rest] = parsed.positionals; // `min` guarantees the subcommand
    if (subcommand !== 'set' && subcommand !== 'clear') {
      throw new UsageError(`unknown subcommand '${subcommand}'\n${SPEC.usage}`);
    }
    expectArguments(rest, subcommand === 'set' ? 2 : 1);
    const [ref = '', text = ''] = rest;
    return withDeck(ctx, { refresh: true }, async (deck) => {
      // The text first: a refused one is exit 2 whatever <ref> is (as `pr add` checks its url).
      const address = subcommand === 'set' ? requireTicket(text, deck.config.ticketUrl) : null;
      const row = resolveRef(ref, loadRows(deck));
      setTicket(deck, row.id, address);
      ctx.io.stdout(
        address === null
          ? `${row.shortId} ticket cleared\n`
          : `${row.shortId} ticket: ${sanitize(address)}\n`,
      );
      return EXIT.ok;
    });
  },
};
