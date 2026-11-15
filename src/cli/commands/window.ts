// `skydeck window` (S2 5.1): the one command that starts the window's server and opens a window in
// Edge. It finds, starts and stops the server through src/window/lifecycle.ts (A23), asks it for a
// launch token over server.sock (client.ts), starts Edge with that token (startEdge, S2 5.3) and
// waits for a page to use it (S2 8.2.2): only then does it say that the window is open. Only one
// command starts Edge at a time: it holds `kv` `window_launching` while it starts Edge and waits.
// The window it opens is src/cli/window-open.ts's (`launchWindow`), which `resume` and `new` with
// the window open too (plan C12).
//
// Standard output carries the command's one result line; every other line (the restart, the
// earlier alarm, a failure) goes to standard error with the `skydeck: ` prefix (ruled, task 25).
// Every line that carries foreign text — the checkout a ping names, a path from server.json or the
// configuration (`window.edge`) — is sanitised before it is printed. No line carries a key or a
// launch token, but the address `--print-url` is asked for.
import { SkydeckError, UsageError } from '../../platform/errors.ts';
import { isoFromNs } from '../../platform/time.ts';
import type { Platform } from '../../platform/types.ts';
import type { Deck } from '../../sessions/deck.ts';
import type { Store } from '../../store/store.ts';
import { sanitize } from '../../text/sanitize.ts';
import { replaceSecret } from '../../window/auth.ts';
import { computeBuild } from '../../window/build.ts';
import { controlClient } from '../../window/client.ts';
import type { ControlClient } from '../../window/client.ts';
import { findServer, startServe, stopServer } from '../../window/lifecycle.ts';
import { pidLineState } from '../../window/pidline.ts';
import type { PingAnswer } from '../../window/protocol.ts';
import { readServerLock, resolveRuntimeDir, runtimeFiles } from '../../window/runtime.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec, ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { deadline, launchWindow, POLL_MS, START_MS, windowTimes } from '../window-open.ts';
import type { Wait, WindowTimes } from '../window-open.ts';

const SPEC: ArgSpec = {
  usage: `skydeck window [--print-url] [--new-window] [--restart] [--stop] [--new-secret]

Opens the window: starts the window's server when it does not run, and a window in Edge when
none is open.

  --print-url   print an address for any browser, valid once and for 10 minutes, and start
                nothing on Windows
  --new-window  open another window, also when one is open
  --restart     stop the running server and start a new one; the sessions in the window keep
                running
  --stop        stop the server and start nothing; the sessions in the window keep running
  --new-secret  replace skydeck's key, then open a window: windows opened before cannot
                connect any more
`,
  flags: {
    'print-url': { type: 'boolean' },
    'new-window': { type: 'boolean' },
    restart: { type: 'boolean' },
    stop: { type: 'boolean' },
    'new-secret': { type: 'boolean' },
  },
  min: 0,
  max: 0,
};

const IN_CLAUDE_CODE =
  "the window's server is not started from inside a Claude Code session: every session in the window would inherit that session's environment; run skydeck window in a terminal of your own";

/** lifecycle.ts's ping wait when SKYDECK_TEST_WINDOW_TIMES gives none (S2 5.1: 5 seconds). */
const PING_MS = 5000;

interface Options {
  printUrl: boolean;
  newWindow: boolean;
  restart: boolean;
  stop: boolean;
  newSecret: boolean;
}

/** The options; a usage error for two that cannot go together. */
function optionsOf(parsed: ParsedArgs): Options {
  const flag = (name: string): boolean => parsed.flags[name] === true;
  const options: Options = {
    printUrl: flag('print-url'),
    newWindow: flag('new-window'),
    restart: flag('restart'),
    stop: flag('stop'),
    newSecret: flag('new-secret'),
  };
  if (
    options.stop &&
    (options.printUrl || options.newWindow || options.restart || options.newSecret)
  ) {
    throw new UsageError(`--stop cannot be used with another option\n${SPEC.usage}`);
  }
  if (options.printUrl && options.newWindow) {
    throw new UsageError(`--print-url and --new-window cannot be used together\n${SPEC.usage}`);
  }
  return options;
}

export const command: Command = {
  name: 'window',
  summary: 'Open the window',
  async run(args, ctx) {
    const parsed = parseCommandArgs(args, SPEC);
    if (parsed.help) {
      ctx.io.stdout(SPEC.usage);
      return EXIT.ok;
    }
    const options = optionsOf(parsed);
    // S2 5.1: the server's environment becomes every program's, so nothing is started from a
    // Claude Code session; nothing is looked at either.
    if (ctx.platform.env.CLAUDECODE !== undefined) {
      throw new SkydeckError(IN_CLAUDE_CODE);
    }
    const times = windowTimes(ctx.platform.env);
    return withDeck(ctx, { refresh: false }, (deck) => openWindow(ctx, deck, options, times));
  },
};

/** S2 5.1, the steps for the options given. */
async function openWindow(
  ctx: Context,
  deck: Deck,
  options: Options,
  times: WindowTimes,
): Promise<number> {
  const { platform } = deck;
  const say = (line: string): void => ctx.io.stdout(`${line}\n`);
  if (options.stop) {
    const { stopped, keepers } = await stopServer(deck, times);
    say(
      stopped
        ? `stopped skydeck's window server; ${keepRunning(keepers)}`
        : "the window's server is not running",
    );
    return EXIT.ok;
  }
  if (options.newSecret) {
    // The server forgets every token when it stops (S2 8.2.2); the pages of the old key are
    // refused from the next connection on. Replaced only while no server holds the lock (ruled,
    // server-findable): one started after the stop would keep the tokens it minted before.
    await stopServer(deck, times);
    replaceSecret(deck.store, platform.randomBytes, () => {
      refuseUnderServer(platform, deck.store);
    });
  }
  const { ping, pagesBefore, startWait } = await serverToUse(ctx, deck, options.restart, times);
  try {
    return await useServer(ctx, deck, options, times, ping, pagesBefore, startWait);
  } finally {
    startWait?.cancel();
  }
}

/**
 * S2 5.1 steps 2 and 3 with the server `ping` names; `startWait`, when this command started it, is
 * the start wait begun before its start (ruled, server-findable: the wait for a page that comes
 * back counts from the end of the start, within that wait).
 */
async function useServer(
  ctx: Context,
  deck: Deck,
  options: Options,
  times: WindowTimes,
  ping: PingAnswer,
  pagesBefore: number,
  startWait: Wait | null,
): Promise<number> {
  const { platform } = deck;
  const say = (line: string): void => ctx.io.stdout(`${line}\n`);
  // Looked up again: a server that replaced a stale record listens elsewhere (S2 4.2).
  const client = controlClient(
    platform.net,
    runtimeFiles(resolveRuntimeDir(deck, 'follow').dir).serverSock,
  );
  const alarm = deck.store.getKv('window_alarm');
  if (alarm !== null) {
    ctx.io.stderr(
      `skydeck: skydeck's key may be known to another program since ${timeOf(alarm)}; run skydeck window --new-secret\n`,
    );
  }
  if (options.printUrl) {
    // Valid once and for 10 minutes, and not given up: it is meant to be pasted later (S2 5.1).
    const { token } = await client.token(600);
    say(`http://127.0.0.1:${ping.port}/#t=${token}`);
    return EXIT.ok;
  }
  // After a restart the windows of the old server come back once the new one's start is done
  // (S2 6.3): waited for, so that an update does not open a second window (ruled, task 25). After
  // --new-secret they cannot: the old key is refused. The new server answers, and is recorded,
  // before its start is done: the wait counts from the end of the start (ruled, server-findable),
  // and a start that is not done within the start wait is not waited for any longer.
  const comeBack = pagesBefore > 0 && !options.newSecret;
  if (comeBack && !options.newWindow && startWait !== null) {
    await whileStarting(platform, client, startWait);
  }
  if (
    !options.newWindow &&
    (await pageWithin(platform, client, comeBack ? times.reconnectMs : 0))
  ) {
    say('skydeck window: a window is already open');
    return EXIT.ok;
  }
  const launched = await launchWindow(
    deck,
    client,
    ping,
    options.newWindow,
    !options.newSecret, // after --new-secret the old pages are refused: none comes back
    times,
    (line) => {
      ctx.io.stderr(`skydeck: ${line}\n`);
    },
  );
  if (launched === 'came-back') {
    say('skydeck window: a window is already open');
    return EXIT.ok;
  }
  say(`skydeck window: http://127.0.0.1:${ping.port}/ (server pid ${ping.pid})`);
  return EXIT.ok;
}

/**
 * The guard of --new-secret's replace (ruled, server-findable), run inside replaceSecret's one
 * transaction after the stop: it refuses — so that nothing changes, neither the key nor the alarm
 * — while the window_server lock names a holder alive by design 5.5's rule (a server started
 * meanwhile, whose tokens would outlive the key) or one that cannot be judged.
 */
function refuseUnderServer(platform: Platform, store: Store): void {
  const holder = readServerLock(store);
  if (holder === null) return;
  const { pid } = holder.line;
  switch (pidLineState(holder.line, platform.proc, bootIdOf(platform))) {
    case 'dead':
      return;
    case 'alive':
      throw new SkydeckError(
        `skydeck's key was not replaced: a window server (pid ${pid}) started meanwhile; run skydeck window --new-secret again`,
      );
    case 'unknown':
      throw new SkydeckError(
        `skydeck's key was not replaced: cannot tell whether the window's server (pid ${pid}) still runs: the boot id or its /proc entry cannot be read`,
      );
  }
}

/** The current boot id; null when it cannot be read. */
function bootIdOf(platform: Platform): string | null {
  try {
    return platform.proc.bootId();
  } catch {
    return null;
  }
}

function keepRunning(keepers: number): string {
  return keepers === 1
    ? '1 terminal in the window keeps running'
    : `${keepers} terminals in the window keep running`;
}

/** `window_alarm`'s time as doctor shows it; a value that is not a time is not shown. */
function timeOf(ns: string): string {
  try {
    return /^(0|[1-9][0-9]*)$/.test(ns) ? isoFromNs(BigInt(ns)) : 'a time that cannot be read';
  } catch {
    return 'a time that cannot be read';
  }
}

/**
 * S2 5.1 step 1: the server to use — one of this checkout, the current build and boot found
 * answering; otherwise a new one, after the one of another build (or any one, `--restart`) was
 * stopped with S2 5.1's line. A server of another checkout, or one that does not answer, is
 * reported (exit 1) unless `--restart` replaces it. `pagesBefore`: the pages the stopped server
 * reported (GET /status) just before its stop — 0 when none was stopped, or it did not answer, or
 * its answer had no page count that can be read (ruled, task 25). `startWait`: for a server this
 * command started, the start wait begun right before its start (the caller cancels it); else null.
 */
async function serverToUse(
  ctx: Context,
  deck: Deck,
  restart: boolean,
  times: WindowTimes,
): Promise<{ ping: PingAnswer; pagesBefore: number; startWait: Wait | null }> {
  const { platform } = deck;
  const checkout = platform.appRoot;
  const found = await findServer(deck, checkout, computeBuild(platform.files, checkout), times);
  if (!restart) {
    switch (found.kind) {
      case 'ours':
        return { ping: found.ping, pagesBefore: 0, startWait: null };
      case 'other-checkout':
        throw new SkydeckError(
          `the window's server runs from ${sanitize(found.ping.checkout)}; run skydeck window there, or skydeck window --restart here to replace it`,
        );
      case 'hung':
        throw new SkydeckError(
          found.starting === true
            ? `the window's server (pid ${found.pid}) is starting and did not finish within ${(times.pingMs ?? PING_MS) / 1000} s; run skydeck window again, or skydeck window --restart to replace it`
            : `the window's server (pid ${found.pid}) does not answer; skydeck window --restart stops it`,
        );
      case 'other-build':
      case 'none':
        break;
    }
  }
  let pagesBefore = 0;
  if (found.kind !== 'none') {
    // A hung server would only make the command wait out the client's 5 s once more.
    if (found.kind !== 'hung') pagesBefore = await pagesOf(deck);
    // A diagnostic line, so on standard error: standard output has the one result line (ruled).
    ctx.io.stderr(
      `skydeck: restarting the window's server for the new build; new sessions in the window get the environment of this shell (${sanitize(platform.cwd)})\n`,
    );
    // One found not answering is not pinged again: SIGTERM at once (S2 5.1; ruled, task 25).
    await stopServer(deck, times, found.kind === 'hung' ? { hungPid: found.pid } : {});
  }
  const startWait = deadline(platform, times.startMs ?? START_MS);
  let started: Awaited<ReturnType<typeof startServe>>;
  try {
    started = await startServe(deck, times);
  } catch (error) {
    startWait.cancel();
    throw error;
  }
  if (!started.ok) {
    startWait.cancel();
    throw new SkydeckError(sanitize(started.line));
  }
  return { ping: started.ping, pagesBefore, startWait };
}

/**
 * While the server says that its start is not done (`GET /status` `starting`, ruled,
 * server-findable), looking again every POLL_MS, until `wait` is over; an answer that cannot be
 * had ends the wait too (the wait for the page says what is wrong).
 */
async function whileStarting(platform: Platform, client: ControlClient, wait: Wait): Promise<void> {
  while (!wait.over()) {
    const status = await client.status().catch((error: unknown) => {
      if (error instanceof SkydeckError) return null;
      throw error;
    });
    if (status?.starting !== true) return;
    await platform.clock.sleep(POLL_MS);
  }
}

/** How long the old server's page count is waited for (the client's own wait for an answer). */
const STATUS_MS = 5000;

/**
 * The running server's page count, read on its own from `GET /status` (ruled, task 25): the server
 * about to be stopped can be of an older build, whose /status the client's reader would refuse whole
 * for another field. 0 when it does not answer, or its answer holds no `pages` that is a whole
 * number ≥ 0.
 */
async function pagesOf(deck: Deck): Promise<number> {
  const sock = runtimeFiles(resolveRuntimeDir(deck, 'follow').dir).serverSock;
  let answer: { status: number; body: unknown };
  try {
    answer = await deck.platform.net.requestUnix(sock, {
      method: 'GET',
      path: '/status',
      timeoutMs: STATUS_MS,
    });
  } catch {
    return 0; // refused, gone, no answer in time: no page that could come back
  }
  const body = answer.body;
  const pages =
    answer.status === 200 && typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as { pages?: unknown }).pages
      : undefined;
  return typeof pages === 'number' && Number.isSafeInteger(pages) && pages >= 0 ? pages : 0;
}

/**
 * Whether a page is connected (GET /status `pages`), looking again every POLL_MS until `ms` is
 * over (0: one look).
 */
async function pageWithin(platform: Platform, client: ControlClient, ms: number): Promise<boolean> {
  const wait = deadline(platform, ms);
  try {
    for (;;) {
      if ((await client.status()).pages > 0) return true;
      if (ms === 0 || wait.over()) return false;
      await platform.clock.sleep(POLL_MS);
    }
  } finally {
    wait.cancel();
  }
}
