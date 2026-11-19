// `skydeck ticket set <ref> <link-or-key> | ticket clear <ref>` (follow-up F18; design 7.1, 7.5):
// set a session's ticket — a whole link, or a key that ticketUrl turns into one — or remove it.
// Follow-up F19: `ticket refresh [<ref>]` reads the status of a session's ticket now (of every
// session's without <ref>, done ones included, as `pr refresh`), whatever its age. `ticket set` reads nothing (ruled): the status
// comes with the window's next round for a listed session, or with `ticket refresh <ref>`.
import { UsageError } from '../../platform/errors.ts';
import type { Deck } from '../../sessions/deck.ts';
import type { ListRow } from '../../sessions/list.ts';
import { loadRows } from '../../sessions/load.ts';
import { requireTicket, setTicket } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { sanitize } from '../../text/sanitize.ts';
import { fetchTicketStatuses } from '../../ticket-status.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck ticket set <ref> <link-or-key> | ticket clear <ref> | ticket refresh [<ref>]

  ticket set <ref> <link-or-key>   set the session's ticket, replacing the one before: an http or
                                   https link (stored as the window opens it; quote one that holds
                                   ? & or #), or a key like ABC-123, which ticketUrl in config.json
                                   turns into its link (a key needs ticketUrl); the address is what
                                   is stored, so a later ticketUrl does not move it. An empty text
                                   removes the ticket. Its status is not read here: the window
                                   reads it for a session it lists, or use ticket refresh <ref>.
  ticket clear <ref>               remove the session's ticket
  ticket refresh [<ref>]           read the status of the session's ticket now (the one set, else
                                   its group's link); without <ref> of every session's, done ones
                                   included, as pr refresh reads every session's pull requests
`,
  flags: {},
  min: 1,
  max: 3,
};

/** F19: the status deps of a command: its platform's runner, clock, environment and home. */
function statusDeps(deck: Deck) {
  const { runner, clock, env, homeDir } = deck.platform;
  return {
    runner,
    clock,
    env,
    store: deck.store,
    homeDir,
    rules: deck.config.ticketStatus,
    ticketUrl: deck.config.ticketUrl,
  };
}

/** F19: ` · <status>`, and ` (status not read: <words>)` after a failure; '' for none. */
function statusSuffix(row: ListRow | undefined): string {
  const view = row?.ticketStatus;
  if (view === null || view === undefined) return '';
  const status = view.status === null ? '' : ` · ${view.status}`;
  return view.error === null ? status : `${status} (status not read: ${view.error})`;
}

/** UsageError "missing argument" / "too many arguments" unless `rest` has exactly `count` words. */
function expectArguments(rest: readonly string[], count: number): void {
  if (rest.length !== count) {
    const reason = rest.length < count ? 'missing argument' : 'too many arguments';
    throw new UsageError(`${reason}\n${SPEC.usage}`);
  }
}

export const command: Command = {
  name: 'ticket',
  summary: "Set, clear or refresh a session's ticket",
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [subcommand = '', ...rest] = parsed.positionals; // `min` guarantees the subcommand
    if (subcommand === 'refresh') {
      if (rest.length > 1) throw new UsageError(`too many arguments\n${SPEC.usage}`);
      return refresh(rest[0] ?? null);
    }
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

    /** F19: `ticket refresh [<ref>]`. */
    function refresh(ref: string | null): Promise<number> {
      return withDeck(ctx, { refresh: true }, async (deck) => {
        const rows = loadRows(deck);
        if (ref !== null) {
          const row = resolveRef(ref, rows);
          const url = row.ticketStatus?.url;
          if (url === undefined) {
            ctx.io.stdout(`${row.shortId}: no status is read for this session's ticket\n`);
            return EXIT.ok;
          }
          await fetchTicketStatuses(statusDeps(deck), [url]);
          const after = loadRows(deck).find((candidate) => candidate.id === row.id);
          ctx.io.stdout(`${row.shortId} ticket: ${sanitize(url)}${statusSuffix(after)}\n`);
          return EXIT.ok;
        }
        // As `skydeck pr refresh` without a session: every session's, done ones included.
        const urls = rows.flatMap((row) =>
          row.ticketStatus === null ? [] : [row.ticketStatus.url],
        );
        const { fetched, failed } = await fetchTicketStatuses(statusDeps(deck), urls);
        ctx.io.stdout(`fetched ${fetched}, failed ${failed}\n`);
        return EXIT.ok;
      });
    }
  },
};
