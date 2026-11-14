// `skydeck serve [--foreground]` (S2 5.2, 5.5): the window's server, in a process of its own.
// `skydeck window` starts it (detached, in /, its output appended to server.log); a person may run
// it with --foreground to see its log on stderr. This file owns what concerns the process itself:
// SIGTERM and SIGINT stop the server (S2 5.5), and an error nobody caught is logged by its name and
// stack frames, never its message, and ends the server with exit 1.
import { join } from 'node:path';

import type { Env } from '../../platform/types.ts';
import { resolveDeckPlaces } from '../../sessions/deck.ts';
import { failureKind } from '../../window/auth.ts';
import { serverLog } from '../../window/log.ts';
import { runServer, ServeExit } from '../../window/server.ts';
import type { RunningServer } from '../../window/server.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec } from '../args.ts';
import type { Command } from '../command.ts';
import { EXIT } from '../exit.ts';

const SPEC: ArgSpec = {
  usage: `skydeck serve [--foreground]

The window's server. skydeck window starts it; there is no need to run it by hand.

  --foreground  log to stderr instead of server.log, for debugging
SIGTERM or SIGINT stops it; the sessions in the window keep running.
`,
  flags: { foreground: { type: 'boolean' } },
  min: 0,
  max: 0,
};

/** A stack line that is a frame (`    at …`); every other line can belong to the message. */
const FRAME = /^\s+at /;

/**
 * S2 5.2: an uncaught error for the log — its name and code (failureKind) and its stack frames,
 * without the message: a message can span several lines and quote what a peer sent (Node.js's
 * JSON.parse error quotes its input), so only the lines that are frames are kept (ruled, task 15).
 * Exported for its test.
 */
export function uncaughtLine(error: unknown): string {
  if (!(error instanceof Error)) {
    return `a value that is not an Error (${typeof error})`;
  }
  let stack = '';
  try {
    stack = typeof error.stack === 'string' ? error.stack : '';
  } catch {
    // a stack that cannot be read: the name alone
  }
  const frames = stack
    .split('\n')
    .filter((line) => FRAME.test(line))
    .map((line) => line.trim());
  return [failureKind(error), ...frames].join(' ');
}

/** A31: SKYDECK_TEST_PORT (any port, 0 included) over window.port, for tests that run serve. */
function testPort(env: Env): number | undefined {
  const text = env.SKYDECK_TEST_PORT;
  if (text === undefined || !/^(0|[1-9][0-9]{0,4})$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65535 ? port : undefined;
}

export const command: Command = {
  name: 'serve',
  summary: "The window's server (started by skydeck window)",
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const foreground = parsed.flags['foreground'] === true;
    const { platform } = ctx;
    let log: (line: string) => void;
    try {
      const { places } = resolveDeckPlaces(platform);
      log = serverLog(platform, join(places.stateDir, 'server.log'), foreground);
    } catch {
      // The configuration cannot be read: runServer says why; until then stderr is the log.
      log = serverLog(platform, '/dev/null', true);
    }
    const crashed = (error: unknown): void => {
      log(`server: uncaught error: ${uncaughtLine(error)}`);
      process.exit(EXIT.failure);
    };
    process.on('uncaughtException', crashed);
    process.on('unhandledRejection', crashed);

    let server: RunningServer | null = null;
    let asked: string | null = null;
    // A stop that is under way is not cut short by another signal: stop() is one stop (S2 5.5).
    const stopOn = (signal: 'SIGTERM' | 'SIGINT'): void => {
      const reason = `skydeck's server was stopped (${signal})`;
      if (server === null) asked ??= reason;
      else void server.stop(reason);
    };
    process.on('SIGTERM', () => {
      stopOn('SIGTERM');
    });
    process.on('SIGINT', () => {
      stopOn('SIGINT');
    });

    try {
      server = await runServer({ platform, port: testPort(platform.env), foreground });
    } catch (error) {
      if (error instanceof ServeExit) {
        ctx.io.stderr(`skydeck: ${error.message}\n`);
        return error.code;
      }
      throw error;
    }
    if (asked !== null) void server.stop(asked);
    return server.done;
  },
};
