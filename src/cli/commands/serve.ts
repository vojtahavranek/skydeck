// `skydeck serve [--foreground]` (S2 5.2, 5.5): the window's server, in a process of its own.
// `skydeck window` starts it (detached, in /, its output appended to server.log); a person may run
// it with --foreground to see its log on stderr. This file owns what concerns the process itself:
// SIGTERM and SIGINT stop the server (S2 5.5), and an error nobody caught is logged by its name and
// stack frames, never its message, and ends the server with exit 1.
import { join } from 'node:path';

import { MAX_TIMER_MS } from '../../platform/time.ts';
import type { Env, Platform } from '../../platform/types.ts';
import { resolveDeckPlaces } from '../../sessions/deck.ts';
import { sanitize } from '../../text/sanitize.ts';
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
 * never its message. A message can span several lines, quote what a peer sent (Node.js's
 * JSON.parse error quotes its input) and hold a line that looks like a frame (a pasted stack
 * trace), so frames are not found by their pattern alone (ruled, review 2; this replaces task 15's
 * rule): the stack's header — `<name>: <message>` as the message is, however many lines; Node.js's
 * `<name> [<code>]: <message>`; the name alone for an empty message — is removed exactly, and only
 * the lines after it that match `/^\s+at /` are kept. A stack that does not begin with its header
 * gives no frame at all. (Not covered, and not known to happen: an error whose message is cut to
 * its first lines after its stack was first read — the rest of the old message then follows the
 * shorter header, and a line of it that looks like a frame would be kept.) Exported for its test.
 */
export function uncaughtLine(error: unknown): string {
  if (!(error instanceof Error)) {
    return `a value that is not an Error (${typeof error})`;
  }
  let frames: string[] = [];
  try {
    const { stack, name, message } = error;
    const code = (error as { code?: unknown }).code;
    if (typeof stack === 'string' && typeof name === 'string' && typeof message === 'string') {
      const tail = message === '' ? '' : `: ${message}`;
      const headers = [`${name}${tail}`];
      if (typeof code === 'string') headers.push(`${name} [${code}]${tail}`);
      const header = headers.find((h) => stack === h || stack.startsWith(`${h}\n`));
      if (header !== undefined) {
        frames = stack
          .slice(header.length)
          .split('\n')
          .filter((line) => FRAME.test(line))
          .map((line) => line.trim());
      }
    }
  } catch {
    frames = []; // a stack, name or message that cannot be read: the name alone
  }
  return [failureKind(error), ...frames].join(' ');
}

/** A31: SKYDECK_TEST_PORT (any port, 0 included) over window.port, for tests that run serve. */
function testPort(env: Env): number | undefined {
  const text = env.SKYDECK_TEST_PORT;
  if (text === undefined || !/^(0|[1-9][0-9]{0,4})$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65535 ? port : undefined;
}

/** The seam's default: no test runs a server longer, so none can forget to end it. */
const SANDBOX_MAX_SECONDS = 600;
/** How often a marked sandbox's server looks whether its SKYDECK_HOME is still there: the tick's. */
const SANDBOX_LOOK_MS = 1000;

/**
 * A31, the seam ruled for task 25 (review 2): a test run that is killed must not leave a real
 * server running for good (it is detached, in a session of its own). In a marked test sandbox
 * (SKYDECK_TEST_NO_WINDOWS=1) the server stops itself in the orderly way (S2 5.5) after
 * SKYDECK_TEST_SERVE_MAX_SECONDS seconds (`maxMs`; 600 by default, also for a value that is not
 * a whole number of seconds a timer can wait — `invalid` then, for one log line) and once its
 * SKYDECK_HOME (`home`, when absolute) is gone. null outside a marked sandbox: neither exists.
 * Exported for its test.
 */
export function sandboxLimits(
  env: Env,
): { maxMs: number; home: string | null; invalid: boolean } | null {
  if (env.SKYDECK_TEST_NO_WINDOWS !== '1') return null;
  const text = env.SKYDECK_TEST_SERVE_MAX_SECONDS;
  const valid =
    text !== undefined && /^[1-9][0-9]{0,6}$/.test(text) && Number(text) * 1000 <= MAX_TIMER_MS;
  const home = env.SKYDECK_HOME;
  return {
    maxMs: (valid ? Number(text) : SANDBOX_MAX_SECONDS) * 1000,
    home: home !== undefined && home.startsWith('/') ? home : null,
    invalid: text !== undefined && !valid,
  };
}

/** Whether `path` is gone; a look that fails is no answer (it is not gone). */
function isGone(platform: Platform, path: string): boolean {
  try {
    return platform.files.stat(path) === null;
  } catch {
    return false;
  }
}

/**
 * sandboxLimits applied to a running server: its stop after `maxMs` and once SKYDECK_HOME is gone,
 * both given up when the server is done.
 */
function endInSandbox(
  platform: Platform,
  server: RunningServer,
  log: (line: string) => void,
): void {
  const limits = sandboxLimits(platform.env);
  if (limits === null) return;
  if (limits.invalid) {
    log(
      `server: SKYDECK_TEST_SERVE_MAX_SECONDS is not a whole number of seconds; it stops after ${SANDBOX_MAX_SECONDS} s`,
    );
  }
  const stopWith = (reason: string): void => {
    log(`server: stopping: ${reason}`);
    void server.stop(reason);
  };
  const cancelMax = platform.clock.after(limits.maxMs, () => {
    stopWith(`the test sandbox's ${limits.maxMs / 1000} s are over`);
  });
  const home = limits.home;
  const cancelLook =
    home === null
      ? (): void => {}
      : platform.clock.every(SANDBOX_LOOK_MS, () => {
          if (isGone(platform, home)) stopWith('the test sandbox is gone');
        });
  void server.done.then(() => {
    cancelMax();
    cancelLook();
  });
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
        // 10 and 12 carry a path from the configuration or the store's record (review 2).
        ctx.io.stderr(`skydeck: ${sanitize(error.message)}\n`);
        return error.code;
      }
      throw error;
    }
    if (asked !== null) void server.stop(asked);
    endInSandbox(platform, server, log);
    return server.done;
  },
};
