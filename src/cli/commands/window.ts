// `skydeck window` (S2 5.1): the one command that starts the window's server and opens a window in
// Edge. It finds, starts and stops the server through src/window/lifecycle.ts (A23), asks it for a
// launch token over server.sock (client.ts), starts Edge with that token (startEdge, S2 5.3) and
// waits for a page to use it (S2 8.2.2): only then does it say that the window is open. Only one
// command starts Edge at a time: it holds `kv` `window_launching` while it starts Edge and waits.
//
// Standard output carries the command's one result line; every other line (the restart, the
// earlier alarm, a failure) goes to standard error with the `skydeck: ` prefix (ruled, task 25).
// Every line that carries foreign text — the checkout a ping names, a path from server.json or the
// configuration (`window.edge`) — is sanitised before it is printed. No line carries a key or a
// launch token, but the address `--print-url` is asked for.
import { procStartFromStat } from '../../claude/procstat.ts';
import { SkydeckError, UsageError } from '../../platform/errors.ts';
import { isoFromNs, MAX_TIMER_MS, NS_PER_MS } from '../../platform/time.ts';
import type { Env, Platform } from '../../platform/types.ts';
import type { Deck } from '../../sessions/deck.ts';
import type { Store } from '../../store/store.ts';
import { sanitize } from '../../text/sanitize.ts';
import { replaceSecret } from '../../window/auth.ts';
import { computeBuild } from '../../window/build.ts';
import { controlClient } from '../../window/client.ts';
import type { ControlClient } from '../../window/client.ts';
import { startEdge } from '../../window/edge.ts';
import { findServer, startServe, stopServer } from '../../window/lifecycle.ts';
import type { LifecycleTimes } from '../../window/lifecycle.ts';
import { pidLineState } from '../../window/pidline.ts';
import type { PingAnswer } from '../../window/protocol.ts';
import { readServerLock, resolveRuntimeDir, runtimeFiles } from '../../window/runtime.ts';
import { parseCommandArgs } from '../args.ts';
import type { ArgSpec, ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import type { Context } from '../context.ts';
import { withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';

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
/** S2 8.2.2: what the page says on 4004, and so does a command still waiting for that token. */
const ALARM =
  "this window's launch address was used by another program, which may now have skydeck's key; run skydeck window --new-secret";

/** How often a wait looks again: at the token, at the pages, at the lock. */
const POLL_MS = 100;
/** lifecycle.ts's ping wait when SKYDECK_TEST_WINDOW_TIMES gives none (S2 5.1: 5 seconds). */
const PING_MS = 5000;
/** lifecycle.ts's start wait when SKYDECK_TEST_WINDOW_TIMES gives none (S2 5.2: 10 seconds). */
const START_MS = 10_000;

interface Options {
  printUrl: boolean;
  newWindow: boolean;
  restart: boolean;
  stop: boolean;
  newSecret: boolean;
}

/**
 * The waits of S2 5.1 (A31), the design's values by default: a page has `pageMs` (30 s) to use
 * the launch token, a used token is watched `reuseMs` (2 s) more for a second use, a
 * `window_launching` older than `launchingMs` (45 s, longer than the wait it guards) holds
 * nothing, and after a restart the pages the old server had get `reconnectMs` (7 s: the page's
 * longest retry interval is 5 s, S2 6.3; ruled, task 25) to come back. The lifecycle's own times
 * (ping, start, stop, kill) are passed on as they are.
 */
interface Times extends LifecycleTimes {
  pageMs: number;
  reuseMs: number;
  launchingMs: number;
  reconnectMs: number;
}

const DEFAULT_WAITS = { pageMs: 30_000, reuseMs: 2000, launchingMs: 45_000, reconnectMs: 7000 };
const TIME_NAMES: readonly string[] = [
  'pingMs',
  'startMs',
  'stopMs',
  'killMs',
  'pageMs',
  'reuseMs',
  'launchingMs',
  'reconnectMs',
];

/**
 * A31: SKYDECK_TEST_WINDOW_TIMES (`name=ms` pairs separated by commas, the names of Times) over
 * the defaults — honoured only in a test sandbox, marked by SKYDECK_TEST_NO_WINDOWS=1, where a
 * value that is not such pairs is an error; anywhere else the variable is ignored.
 */
function timesOf(env: Env): Times {
  const times: Times = { ...DEFAULT_WAITS };
  const text = env.SKYDECK_TEST_WINDOW_TIMES;
  if (env.SKYDECK_TEST_NO_WINDOWS !== '1' || text === undefined) return times;
  for (const pair of text.split(',')) {
    const match = /^([A-Za-z]+)=(0|[1-9][0-9]{0,9})$/.exec(pair);
    const name = match?.[1] ?? '';
    const ms = Number(match?.[2]);
    if (match === null || !TIME_NAMES.includes(name) || ms > MAX_TIMER_MS) {
      throw new SkydeckError(
        `SKYDECK_TEST_WINDOW_TIMES is not name=ms pairs of ${TIME_NAMES.join(', ')}: ${sanitize(text)}`,
      );
    }
    (times as unknown as Record<string, number>)[name] = ms;
  }
  return times;
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
    const times = timesOf(ctx.platform.env);
    return withDeck(ctx, { refresh: false }, (deck) => openWindow(ctx, deck, options, times));
  },
};

/** S2 5.1, the steps for the options given. */
async function openWindow(
  ctx: Context,
  deck: Deck,
  options: Options,
  times: Times,
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
  times: Times,
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
  await launch(deck, client, ping, options, times);
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
  times: Times,
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

/**
 * S2 5.1 step 2: holding `window_launching`, a launch token for 30 s, Edge started with it, and
 * the wait for a page to use it; the token is given up when the wait ends, whatever its end. While
 * another command holds the lock, this one waits for that one's page (and is done when it comes,
 * unless `--new-window`), or for the lock to be given up or to go stale, and then launches itself.
 * Throws a SkydeckError with S2 5.1's line when no page used the token, when it was used twice (the
 * alarm), and when Edge could not be started (S2 5.3; the server keeps running).
 */
async function launch(
  deck: Deck,
  client: ControlClient,
  ping: PingAnswer,
  options: Options,
  times: Times,
): Promise<void> {
  const { platform } = deck;
  const lock = launchingLock(deck, times.launchingMs);
  while (!lock.take()) {
    if (!options.newWindow && (await client.status()).pages > 0) return;
    await platform.clock.sleep(POLL_MS);
  }
  try {
    const token = await client.token(30);
    try {
      const edge = await startEdge(
        platform,
        deck.config.window,
        deck.places.configPath,
        ping.port,
        token.token,
        null, // the command's own WSL_INTEROP: it runs in the user's terminal
      );
      if (!edge.ok) {
        throw new SkydeckError(sanitize(edge.line));
      }
      const outcome = await waitForUse(platform, client, token.id, times);
      if (outcome === 'reused') {
        throw new SkydeckError(ALARM);
      }
      if (outcome === 'not-used') {
        throw new SkydeckError(
          `Edge was started, but no window connected within ${seconds(times.pageMs)}; open the window in any browser with skydeck window --print-url`,
        );
      }
      if (outcome === 'forgotten') {
        throw new SkydeckError(
          "the window's server stopped or restarted before a window used its launch address; run skydeck window again",
        );
      }
    } finally {
      // So that no unused token is left on Edge's command line (S2 5.1). A server that is gone or
      // restarted has forgotten it already.
      await client.dropToken(token.id).catch((error: unknown) => {
        if (!(error instanceof SkydeckError)) throw error;
      });
    }
  } finally {
    lock.release();
  }
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return s === 1 ? '1 second' : `${s} seconds`;
}

/**
 * S2 5.1, 8.2.2: `used` once a page used the token and no second use came in the `reuseMs` that
 * follow; `reused` when one did (the alarm); `not-used` when no page used it within `pageMs` (or
 * it expired, or was given up); `forgotten` when the server no longer answers for it before its
 * use (a restarted server knows no tokens). After the use a state that cannot be read ends the
 * wait as a use: a server that forgot the token can no longer be reached with it.
 */
async function waitForUse(
  platform: Platform,
  client: ControlClient,
  id: string,
  times: Times,
): Promise<'used' | 'reused' | 'not-used' | 'forgotten'> {
  const { clock } = platform;
  const stateOf = (): Promise<string | null> =>
    client.tokenState(id).catch((error: unknown) => {
      if (error instanceof SkydeckError) return null;
      throw error;
    });
  const pageWait = deadline(platform, times.pageMs);
  try {
    for (;;) {
      const state = await stateOf();
      if (state === null) return 'forgotten';
      if (state === 'reused') return 'reused';
      if (state === 'used') break;
      if (state !== 'waiting' || pageWait.over()) return 'not-used';
      await clock.sleep(POLL_MS);
    }
  } finally {
    pageWait.cancel();
  }
  const reuseWait = deadline(platform, times.reuseMs);
  try {
    for (;;) {
      if (reuseWait.over()) return 'used';
      await clock.sleep(POLL_MS);
      const state = await stateOf();
      if (state === 'reused') return 'reused';
      if (state === null) return 'used';
    }
  } finally {
    reuseWait.cancel();
  }
}

/** A deadline `ms` from now on the platform's clock (a timer: WSL's wall clock steps back). */
interface Wait {
  over(): boolean;
  cancel(): void;
}

function deadline(platform: Platform, ms: number): Wait {
  let late = false;
  const cancel = platform.clock.after(ms, () => {
    late = true;
  });
  return { over: () => late, cancel };
}

// ---------------------------------------------------------------------------------------------
// window_launching

/**
 * `kv` `window_launching` (S2 5.1): `<16 hex> <taken ns> <pid> <process start> <boot id>` — a
 * random mark of the holding command (two commands of one process are told apart), the wall-clock
 * time it was taken and the holder's identity as design 5.5 judges it (left out when it cannot be
 * read). It holds nothing when it does not parse, is `launchingMs` old (or as far ahead: the clock
 * cannot be believed then), or names a holder that is dead by design 5.5's rule — a command that
 * was interrupted leaves it behind. Taken in one transaction; given up only by its holder.
 */
const LAUNCHING = /^[0-9a-f]{16} (0|[1-9][0-9]*)(?: ([1-9][0-9]*) (0|[1-9][0-9]*) (\S+))?$/;

function launchingLock(deck: Deck, staleMs: number): { take(): boolean; release(): void } {
  const { platform, store } = deck;
  const mark = Buffer.from(platform.randomBytes(8)).toString('hex');
  const identity = identityOf(platform);
  let mine: string | null = null;
  return {
    take() {
      return store.transaction(() => {
        const held = store.getKv('window_launching');
        if (held !== null && holds(platform, held, staleMs)) return false;
        mine = `${mark} ${platform.clock.nowNs()}${identity}`;
        store.setKv('window_launching', mine);
        return true;
      });
    },
    release() {
      const value = mine;
      if (value === null) return;
      try {
        store.transaction(() => {
          if (store.getKv('window_launching') === value) store.deleteKv('window_launching');
        });
      } catch {
        // Left behind, it holds nothing once this process has ended (design 5.5) or is stale;
        // an error from here would hide the one that ended the command.
      }
    },
  };
}

/** ` <pid> <process start> <boot id>` of this process; '' when it cannot be read. */
function identityOf(platform: Platform): string {
  try {
    const stat = platform.proc.stat(platform.pid);
    const procStart = stat === null ? null : procStartFromStat(stat);
    const bootId = platform.proc.bootId();
    if (procStart === null || bootId === null || /\s/.test(bootId) || bootId === '') return '';
    return ` ${platform.pid} ${procStart} ${bootId}`;
  } catch {
    return '';
  }
}

/** Whether `value` of window_launching still holds the lock for its holder. */
function holds(platform: Platform, value: string, staleMs: number): boolean {
  const match = LAUNCHING.exec(value);
  if (match === null) return false;
  const taken = BigInt(match[1] ?? '0');
  const now = platform.clock.nowNs();
  const stale = BigInt(staleMs) * NS_PER_MS;
  if (now - taken >= stale || taken - now >= stale) return false;
  if (match[2] === undefined) return true;
  const pid = Number(match[2]);
  const procStart = Number(match[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(procStart)) return false;
  return (
    pidLineState({ pid, procStart, bootId: match[4] ?? '' }, platform.proc, bootIdOf(platform)) !==
    'dead'
  );
}
