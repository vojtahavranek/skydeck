// The command line's requests to the window's server (S2 11.4, 8.3; plan C11, C12, C14): `resume`
// and `new` with `--window` send the session id or the new session's fields to the running server
// instead of starting anything themselves, print its answer's lines and exit with its code; then,
// when no page is connected, they open a window as `skydeck window` does (src/cli/window-open.ts).
// `restore` with the window opens that window before its request, then prints the run's lines.
// They never start, restart or signal a server: its environment becomes every session's (S2 5.2),
// so only `skydeck window` starts one. Every line that comes from the server is sanitised again
// before it is printed (the server may be of another build).
import { SkydeckError } from '../platform/errors.ts';
import type { Deck } from '../sessions/deck.ts';
import { isDatabaseFailure } from '../store/store.ts';
import { sanitize } from '../text/sanitize.ts';
import { computeBuild } from '../window/build.ts';
import { controlClient } from '../window/client.ts';
import type { ControlClient } from '../window/client.ts';
import { findServer } from '../window/lifecycle.ts';
import type { LaunchAnswer, NewRequest, PingAnswer, RestoreRequest } from '../window/protocol.ts';
import { resolveRuntimeDir, runtimeFiles } from '../window/runtime.ts';
import type { Context } from './context.ts';
import { launchWindow, windowTimes } from './window-open.ts';
import type { WindowTimes } from './window-open.ts';

/** The server a command sends to. `here` (ruled, task 76): whether the command has `--here`, so
 *  that its lines end with ", or use --here" (restore and the interactive list have none). */
export interface WindowServer {
  client: ControlClient;
  ping: PingAnswer;
  here: boolean;
}

/** lifecycle.ts's ping wait when SKYDECK_TEST_WINDOW_TIMES gives none (S2 5.1: 5 seconds). */
const PING_MS = 5000;

/** The two endings of plan 2.5's lines that only a command with `--here` has. */
const HERE_TAILS = [', or use --here', '; use --here'] as const;

/** `line` with its `--here` ending when `here`, else without it. */
function forHere(line: string, here: boolean): string {
  if (here) return line;
  const tail = HERE_TAILS.find((ending) => line.endsWith(ending));
  return tail === undefined ? line : line.slice(0, -tail.length);
}

/**
 * Plan C11: the running server of this checkout, of any build (the window's own Resume runs on
 * that build too), found as `skydeck window` finds it; a SkydeckError with plan 2.5's line for
 * none, one that does not answer, one still starting past the ping wait and one of another
 * checkout. Never starts, restarts or signals one. `here` false (restore, the interactive list)
 * leaves ", or use --here" out of the lines. The client has the platform's clock (ruled, task 76).
 */
export async function windowServer(
  deck: Deck,
  times: WindowTimes,
  here: boolean,
): Promise<WindowServer> {
  const { platform } = deck;
  const checkout = platform.appRoot;
  const found = await findServer(deck, checkout, computeBuild(platform.files, checkout), times);
  switch (found.kind) {
    case 'ours':
    case 'other-build': {
      // Looked up again: a server that replaced a stale record listens elsewhere (S2 4.2).
      const sock = runtimeFiles(resolveRuntimeDir(deck, 'follow').dir).serverSock;
      return { client: controlClient(platform.net, sock, platform.clock), ping: found.ping, here };
    }
    case 'none':
      throw new SkydeckError(
        forHere('the window is not running; run skydeck window first, or use --here', here),
      );
    case 'hung':
      throw new SkydeckError(
        found.starting === true
          ? `the window's server (pid ${found.pid}) is starting and did not finish within ${(times.pingMs ?? PING_MS) / 1000} s; run skydeck window again, or skydeck window --restart to replace it`
          : `the window's server (pid ${found.pid}) does not answer; skydeck window --restart stops it`,
      );
    case 'other-checkout':
      throw new SkydeckError(
        forHere(
          `the window's server runs from ${sanitize(found.ping.checkout)}, not from this checkout; skydeck window --restart here replaces it, or use --here`,
          here,
        ),
      );
  }
}

const OLDER =
  "the window's server is older than this command and cannot start sessions for it; run skydeck window to restart it, or use --here";

/** `asked`'s answer; 'unknown-route' is C11's older-server line; every line for `server.here`. */
async function answerOf<T>(server: WindowServer, asked: Promise<T | 'unknown-route'>): Promise<T> {
  let answer: T | 'unknown-route';
  try {
    answer = await asked;
  } catch (error) {
    if (error instanceof SkydeckError) {
      throw new SkydeckError(forHere(error.message, server.here), error.exitCode);
    }
    throw error;
  }
  if (answer === 'unknown-route') throw new SkydeckError(forHere(OLDER, server.here));
  return answer;
}

/** `POST /resume` within `times.answerMs`: the answer, or a SkydeckError. Prints nothing. */
export function requestResume(
  server: WindowServer,
  sessionId: string,
  times: WindowTimes,
): Promise<LaunchAnswer> {
  return answerOf(server, server.client.resume(sessionId, times.answerMs));
}

/** `POST /new` within `times.answerMs`: the answer, or a SkydeckError. Prints nothing. */
export function requestNew(
  server: WindowServer,
  request: NewRequest,
  times: WindowTimes,
): Promise<LaunchAnswer> {
  return answerOf(server, server.client.newSession(request, times.answerMs));
}

/**
 * Plan C14's request (`restore` with `"terminal": "window"`, task 77, which calls it inside its own
 * withDeck with the deck it planned with; ruled, task 76): first C12's window when no page is
 * connected (none under CLAUDECODE), so that the terminals start at the window's size and a start
 * dialog can be answered; then `POST /restore`, every line of the run on stdout as it arrives
 * (sanitised), heartbeats too. The outcome's code; with 5, the line that says the run stopped.
 * Rejects with a SkydeckError of plan 2.5 (a server that stopped answering, an older one, …).
 */
export async function restoreInWindow(
  ctx: Context,
  deck: Deck,
  server: WindowServer,
  request: RestoreRequest,
  times: WindowTimes,
): Promise<number> {
  await windowFor(ctx, deck, server, times);
  const outcome = await answerOf(
    server,
    server.client.restore(
      request,
      (line) => {
        ctx.io.stdout(`${sanitize(line)}\n`);
      },
      times.answerMs,
    ),
  );
  if (outcome.code === 5) {
    ctx.io.stderr('skydeck: restore stopped before it finished; see above\n');
  }
  return outcome.code;
}

/** `resume <ref> --window` (S2 11.4): the request for the session `<ref>` resolved to. */
export function resumeInWindow(ctx: Context, deck: Deck, sessionId: string): Promise<number> {
  return inWindow(ctx, deck, (server, times) => requestResume(server, sessionId, times));
}

/** `new --window` (S2 11.4): the request with the current directory, label, group and flags. */
export function newInWindow(ctx: Context, deck: Deck, request: NewRequest): Promise<number> {
  return inWindow(ctx, deck, (server, times) => requestNew(server, request, times));
}

/**
 * resume / new with the window: the server, the request, every line of the answer on stderr
 * (sanitised), then plan C12's window — none after a code of 2 or 3 (a usage or reference
 * refusal: nothing was started); the answer's code, 1 for a code that is not 0–5.
 */
async function inWindow(
  ctx: Context,
  deck: Deck,
  ask: (server: WindowServer, times: WindowTimes) => Promise<LaunchAnswer>,
): Promise<number> {
  const times = windowTimes(deck.platform.env);
  const server = await windowServer(deck, times, true);
  const answer = await ask(server, times);
  for (const line of answer.lines) {
    ctx.io.stderr(`${sanitize(line)}\n`);
  }
  if (answer.code !== 2 && answer.code !== 3) {
    await windowFor(ctx, deck, server, times);
  }
  return Number.isSafeInteger(answer.code) && answer.code >= 0 && answer.code <= 5
    ? answer.code
    : 1;
}

/**
 * Plan C12: when no page is connected, a window opened as `skydeck window` opens one (C20's wait
 * included: a window the server expects back is waited for). A window that cannot be opened is one
 * line on stderr and changes nothing else — also when the store fails while the window's lock is
 * taken (locked past its busy timeout, read-only): the answer's code stays, and a restore still
 * sends its request. Under CLAUDECODE no window is ever opened (S2 5.1
 * refuses `skydeck window` there; this is no second door): the command says so when no page is
 * connected.
 */
async function windowFor(
  ctx: Context,
  deck: Deck,
  server: WindowServer,
  times: WindowTimes,
): Promise<void> {
  const say = (line: string): void => ctx.io.stderr(`skydeck: ${line}\n`);
  const inClaudeCode = deck.platform.env.CLAUDECODE !== undefined;
  try {
    if ((await server.client.status()).pages > 0) return;
    if (inClaudeCode) {
      say('no window is open; run skydeck window in a terminal of your own');
      return;
    }
    await launchWindow(deck, server.client, server.ping, false, true, times, say);
  } catch (error) {
    const reason =
      error instanceof SkydeckError
        ? error.message
        : isDatabaseFailure(error)
          ? `the database ${deck.store.path} failed: ${sanitize(error instanceof Error ? error.message : String(error))}`
          : null;
    if (reason === null) throw error;
    say(
      `the window could not be opened: ${reason}; run skydeck window${inClaudeCode ? ' in a terminal of your own' : ''}`,
    );
  }
}
