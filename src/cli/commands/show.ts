// `skydeck show <ref> [--json] [--refresh]` (design 7.5): one session in full. Without `--refresh`
// it never touches the network (design 7.3).
import { refreshPrs } from '../../github.ts';
import { loadRows } from '../../sessions/load.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { ticketAddress } from '../../sessions/ticket.ts';
import { holdersInWindow } from '../../window/in-window.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { jsonText } from '../json.ts';
import { formatShow, showJson } from '../output.ts';

const SPEC: ArgSpec = {
  usage: `skydeck show <ref> [--json] [--refresh]

Prints one session: its state and marks, label and group, the ticket address when ticketUrl gives
one, project directory, launch command (and the flags in it that skydeck does not know, which a
resume does not pass on), the sessions it continues, the processes that hold it, its pull requests
and its note.

  --json      print it as JSON instead of text
  --refresh   first read the status of this session's pull requests that are not merged or closed
              (gh); without it the status printed is the one saved, and nothing touches the network
`,
  flags: {
    json: { type: 'boolean' },
    refresh: { type: 'boolean' },
  },
  min: 1,
  max: 1,
};

export const command: Command = {
  name: 'show',
  summary: 'Show one session',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [ref = ''] = parsed.positionals; // `min` guarantees the reference
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const { runner, clock, env } = ctx.platform;
      let row = resolveRef(ref, loadRows(deck));
      if (parsed.flags['refresh'] === true && row.prs.length > 0) {
        // An explicit refresh (design 7.3) of this session: every pull request it has attached
        // that is not merged or closed, whatever its age and its last result.
        await refreshPrs(
          { runner, clock, store: deck.store, env },
          { force: true, refreshMinutes: deck.config.prRefreshMinutes, sessionIds: [row.id] },
        );
        const id = row.id;
        row = loadRows(deck).find((candidate) => candidate.id === id) ?? row;
      }
      const links = deck.store.links();
      const { groupPattern, ticketUrl } = deck.config;
      ctx.io.stdout(
        parsed.flags['json'] === true
          ? jsonText(showJson(row, links))
          : formatShow(
              row,
              links,
              clock.nowNs(),
              ticketAddress(row.group, groupPattern, ticketUrl),
              // S2 11.4: which holders run in the window, from the keepers' .pid lines alone.
              holdersInWindow(deck, row.session.holders),
            ),
      );
      return EXIT.ok;
    });
  },
};
