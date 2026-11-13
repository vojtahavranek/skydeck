// `skydeck pr add <ref> <url> | pr rm <ref> <url> | pr refresh` (design 7.3, 7.5): attach a pull
// request to a session by hand, detach one, or fetch the status of the pull requests now.
import { fetchPrs, refreshPrs } from '../../github.ts';
import { UsageError } from '../../platform/errors.ts';
import { loadRows } from '../../sessions/load.ts';
import { attachManualPr, detachSessionPr, requirePrKey } from '../../sessions/meta.ts';
import { resolveRef } from '../../sessions/refs.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { formatPrStatus } from '../row.ts';
import type { Deck } from '../../sessions/deck.ts';

const SPEC: ArgSpec = {
  usage: `skydeck pr add <ref> <url> | pr rm <ref> <url> | pr refresh

  pr add <ref> <url>   attach a pull request to a session and read its status now
  pr rm <ref> <url>    detach it; a later 'pr-link' in the transcript does not attach it again
  pr refresh           read the status of every pull request that is not merged or closed, now
`,
  flags: {},
  min: 1,
  max: 3,
};

/** What `gh` is given: the platform's runner, clock and environment, and the deck's store. */
function ghDeps(ctx: Context, deck: Deck) {
  const { runner, clock, env } = ctx.platform;
  return { runner, clock, store: deck.store, env };
}

/** UsageError "missing argument" / "too many arguments" unless `rest` has exactly `count` words. */
function expectArguments(rest: readonly string[], count: number): void {
  if (rest.length !== count) {
    const reason = rest.length < count ? 'missing argument' : 'too many arguments';
    throw new UsageError(`${reason}\n${SPEC.usage}`);
  }
}

export const command: Command = {
  name: 'pr',
  summary: 'Attach, detach or refresh pull requests',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const [subcommand = '', ...rest] = parsed.positionals; // `min` guarantees the subcommand
    switch (subcommand) {
      case 'add': {
        expectArguments(rest, 2);
        const [ref = '', text = ''] = rest;
        const url = requirePrKey(text).url; // arguments first: a bad url is exit 2 whatever <ref> is
        return withDeck(ctx, { refresh: true }, async (deck) => {
          const row = resolveRef(ref, loadRows(deck));
          const key = attachManualPr(deck, row.id, url);
          // A failed fetch is recorded on the pull request (it shows as "can't read"), not thrown.
          await fetchPrs(ghDeps(ctx, deck), [key.url]);
          const view = loadRows(deck)
            .find((candidate) => candidate.id === row.id)
            ?.prs.find((pr) => pr.url === key.url);
          if (view === undefined) {
            throw new Error(`the pull request ${key.url} is not attached to ${row.id}`);
          }
          ctx.io.stdout(`${row.shortId}: attached ${key.url} (${formatPrStatus(view)})\n`);
          return EXIT.ok;
        });
      }
      case 'rm': {
        expectArguments(rest, 2);
        const [ref = '', text = ''] = rest;
        const url = requirePrKey(text).url;
        return withDeck(ctx, { refresh: true }, async (deck) => {
          const row = resolveRef(ref, loadRows(deck));
          const key = detachSessionPr(deck, row.id, url);
          ctx.io.stdout(`${row.shortId}: detached ${key.url}\n`);
          return EXIT.ok;
        });
      }
      case 'refresh': {
        expectArguments(rest, 0);
        return withDeck(ctx, { refresh: true }, async (deck) => {
          const { fetched, failed } = await refreshPrs(ghDeps(ctx, deck), {
            force: true,
            refreshMinutes: deck.config.prRefreshMinutes,
          });
          ctx.io.stdout(`fetched ${fetched}, failed ${failed}\n`);
          return EXIT.ok;
        });
      }
      default:
        throw new UsageError(`unknown subcommand '${subcommand}'\n${SPEC.usage}`);
    }
  },
};
