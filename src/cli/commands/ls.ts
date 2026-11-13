// `skydeck ls [--all] [--json] [--refresh]` (design 7.4, 7.5): print the session list, as text or as
// the stable JSON. Without `--refresh` it never touches the network (design 7.3).
import { refreshPrs } from '../../github.ts';
import { buildList } from '../../sessions/list.ts';
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

  --all       also list the sessions marked done
  --json      print the list as JSON (version 1) instead of text
  --refresh   first read the status of the pull requests that are stale or were never read (gh);
              without it the status printed is the one saved, and nothing touches the network
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
      if (parsed.flags['refresh'] === true) {
        // A failed fetch is saved on the pull request ("can't read"), never thrown.
        await refreshPrs(
          { runner, clock, store: deck.store, env },
          { force: false, refreshMinutes: deck.config.prRefreshMinutes },
        );
      }
      const rows = loadRows(deck);
      const nowNs = clock.nowNs();
      const model = buildList(rows, {
        showAll: parsed.flags['all'] === true,
        filter: '',
        nowNs,
      });
      ctx.io.stdout(
        parsed.flags['json'] === true
          ? jsonText(listJson(model))
          : formatList(model, nowNs, ctx.io.size().columns),
      );
      return EXIT.ok;
    });
  },
};
