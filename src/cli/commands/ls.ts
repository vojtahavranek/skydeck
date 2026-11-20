// `skydeck ls [--all] [--json] [--refresh]` (design 7.4, 7.5): print the session list, as text or as
// the stable JSON. Without `--refresh` it never touches the network (design 7.3).
import { refreshPrs } from '../../github.ts';
import { buildList, flatRows } from '../../sessions/list.ts';
import { loadRows } from '../../sessions/load.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { jsonText } from '../json.ts';
import { formatList, listJson } from '../output.ts';

const SPEC: ArgSpec = {
  usage: `skydeck ls [--all] [--json] [--refresh]

Prints the sessions skydeck knows, in groups, one row each. It never starts or stops a session.

  --all       also list the sessions marked done, and the copies of a session Claude Code made
              that have no message yet
  --json      print the list as JSON (version 1) instead of text
  --refresh   first read the status of the pull requests of the sessions printed that are not merged
              or closed (gh); without it the status printed is the one saved, and nothing touches
              the network
`,
  flags: {
    all: { type: 'boolean' },
    json: { type: 'boolean' },
    refresh: { type: 'boolean' },
  },
  min: 0,
  max: 0,
};

export const command: Command = {
  name: 'ls',
  summary: 'Print the session list',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    return withDeck(ctx, { refresh: true }, async (deck) => {
      const { runner, clock, env } = ctx.platform;
      const showAll = parsed.flags['all'] === true;
      const build = () => {
        const nowNs = clock.nowNs();
        return { nowNs, model: buildList(loadRows(deck), { showAll, filter: '', nowNs }) };
      };
      let { nowNs, model } = build();
      if (parsed.flags['refresh'] === true) {
        // An explicit refresh (design 7.3) of the sessions that are printed: every pull request
        // they have attached that is not merged or closed, whatever its age and its last result.
        // A failed fetch is saved on the pull request ("can't read"), never thrown.
        await refreshPrs(
          { runner, clock, store: deck.store, env },
          {
            force: true,
            refreshMinutes: deck.config.prRefreshMinutes,
            sessionIds: flatRows(model).map((row) => row.id),
          },
        );
        ({ nowNs, model } = build());
      }
      ctx.io.stdout(
        parsed.flags['json'] === true
          ? jsonText(listJson(model))
          : formatList(model, nowNs, ctx.io.size().columns),
      );
      return EXIT.ok;
    });
  },
};
