/**
 * The window's server (S2 4.1, 5.2, 5.5; plan task 23): every part of `src/window/` put together
 * into the one server of an installation. `runServer` takes the lock, the runtime directory, the
 * assets and the build and the port, writes `server.json` and `server.pid`, listens on
 * `server.sock`, finds the keepers left running, points the interop link, and starts the tick
 * (tick.ts); `stop` is S2 5.5. The command `skydeck serve` (src/cli/commands/serve.ts) runs it in a process of its own;
 * tests run it in theirs (A19), so nothing here touches the process itself (signals, exit).
 * Stage B (plan B 2.7): Seen, attention and the notifier, wired into the tick, the pages and the
 * lists (`attentionParts`).
 *
 * Stage C (plan C task 74) wires in: `server.sock`'s `POST /resume` and `/new` through the one way
 * the window starts a session (launches.ts), answered as the command would end (C2); the restorer
 * (restorer.ts) behind `act restore`, `act dismiss-restore` and `POST /restore`, with the banner in
 * every list (C6–C9, C22); the 503 of those routes while the server starts or stops (C4); and the
 * pages mark with `GET /status`'s `windowExpectedMs` (page-mark.ts, C20). The server adds no rule
 * of its own.
 */
import { join } from 'node:path';

import pkg from '../../package.json' with { type: 'json' };
import { procStartFromStat } from '../claude/procstat.ts';
import { SkydeckError } from '../platform/errors.ts';
import type { HttpListener, Ns, Platform } from '../platform/types.ts';
import { openDeck } from '../sessions/deck.ts';
import type { Deck } from '../sessions/deck.ts';
import type { LaunchSpec, Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { createActions } from './actions.ts';
import { createAttention } from './attention.ts';
import type { Attention } from './attention.ts';
import { httpHandler, loadAssets } from './assets.ts';
import { createTokens, ensureSecret, failureKind, raiseAlarm } from './auth.ts';
import { isBusy } from './busy.ts';
import { controlHandler } from './control.ts';
import { openLink } from './edge.ts';
import { serverEnvironment } from './env.ts';
import type { KeeperHello } from './frames.ts';
import type { ActionHandler, TerminalHub } from './hub.ts';
import { createInteropFrom, probeSocket } from './interop.ts';
import { createKeepAlive } from './keepalive.ts';
import { createLaunches } from './launches.ts';
import type { Launched } from './launches.ts';
import { rotateLog, serverLog } from './log.ts';
import { createNotifier } from './notify.ts';
import { createPageMark } from './page-mark.ts';
import { createPages } from './pages.ts';
import type { PageState, Pages } from './pages.ts';
import { formatPidLine, parsePidLine } from './pidline.ts';
import { createPrFetches } from './pr-fetches.ts';
import type {
  AttentionPayload,
  KeepAlivePayload,
  LaunchAnswer,
  ListMessage,
  NoticeMessage,
  PingAnswer,
  StatusAnswer,
} from './protocol.ts';
import { createRestorer } from './restorer.ts';
import {
  prepareRuntimeDir,
  readServerJson,
  releaseServerLock,
  resolveRuntimeDir,
  RuntimeDirError,
  runtimeFiles,
  takeServerLock,
  writeKeeperFile,
  writeServerJson,
} from './runtime.ts';
import type { RuntimeFiles, ServerJson } from './runtime.ts';
import { createSeen } from './seen.ts';
import type { Seen } from './seen.ts';
import { selectedPayload } from './selected.ts';
import { decideFoundKeeper } from './starts.ts';
import { createRegistry } from './terminals.ts';
import type { Registry } from './terminals.ts';
import { createTick } from './tick.ts';
import type { Tick } from './tick.ts';
import { buildListMessage } from './view/build.ts';
import { windowTerminal } from './window-terminal.ts';
import { loadXterm } from './xterm.ts';

export interface ServerOptions {
  platform: Platform;
  /** Overrides window.port; tests pass 0 (A6). */
  port?: number;
  /** --foreground: log lines go to stderr instead of server.log. */
  foreground: boolean;
  /** The first interop candidate of S2 6.4 (A32); default '/run/WSL/1_interop', or
   *  SKYDECK_TEST_INTEROP_FIRST when set. Tests always point it into the sandbox. */
  interopFirst?: string;
  /** A31 (ruled, server-findable): ms the start waits between binding the port and writing
   *  server.json, while only the window_server lock names it; default 0. `serve` sets it from
   *  SKYDECK_TEST_SERVE_START_DELAY_MS in a marked test sandbox only. */
  startDelayMs?: number;
}

export interface RunningServer {
  port: number;
  runtimeDir: string;
  serverId: string;
  build: string;
  hub: TerminalHub;
  /** S2 5.5; resolves when everything is closed. A second call is the same stop. */
  stop(reason: string): Promise<void>;
  /** The exit code `serve` ends with (S2 5.2): 0 after the stop, 1 when the stop itself failed.
   *  (10–13 are runServer's rejections; serve's process handler ends it with 1 after an uncaught
   *  error, which leaves this unresolved: the process ends there.) */
  done: Promise<number>;
}

/** S2 5.2: why `serve` ends without running — 0 (a server of this checkout runs), 10–13. */
export class ServeExit extends Error {
  readonly code: 0 | 10 | 11 | 12 | 13;
  constructor(code: 0 | 10 | 11 | 12 | 13, message: string) {
    super(message);
    this.name = 'ServeExit';
    this.code = code;
  }
}

/** S2 6.4's first candidate. */
const INTEROP_FIRST = '/run/WSL/1_interop';
const PROTOCOL = 1;
/** S2 5.1, 5.2: the refusal inside a Claude Code session. */
const IN_CLAUDE_CODE =
  "the window's server is not started from inside a Claude Code session: every session in the window would inherit that session's environment; run skydeck window in a terminal of your own";
/** A21: a server id is 16 hex characters from 8 random bytes. */
const SERVER_ID_BYTES = 8;
/** The server's own store connection waits this long for another process's write lock (ruled). */
const BUSY_TIMEOUT_MS = 250;
/** S2 5.2, 14 (ruled): the line of a start that met a store another process keeps locked. */
const BUSY_AT_START =
  "the window's server cannot start: skydeck's database is busy (another skydeck holds it); try again";
/** How long the python3 check at start may take. */
const PYTHON_CHECK_MS = 5000;
/** Plan C7, S2 8.2.6: a terminal's first size while no page has reported its area. */
const DEFAULT_SIZE = { cols: 120, rows: 40 };
/** Plan C2: a launch of `POST /resume` or `/new` that met a store another process keeps locked. */
const BUSY_LAUNCH = "skydeck: skydeck's database is busy; try again";
/** The rows before the first tick: one array, so that the banner's cache holds (task 73). */
const NO_ROWS: readonly never[] = [];

/**
 * Plan C2: a launch as `skydeck resume` / `new` would end — its exit code and its stderr lines. A
 * refusal's message lines (launches.ts: no prefix, sanitised) as `failureText` prints them, with
 * `skydeck: ` before the first; a launch's lines (launchPrepared's) as they are.
 */
function launchAnswer(launched: Launched): LaunchAnswer {
  const { code, lines, sessionId } = launched;
  if (!launched.refused) return { code, lines, sessionId };
  const [first = '', ...rest] = lines;
  return { code, lines: [`skydeck: ${first}`, ...rest], sessionId: null };
}

/**
 * S2 6.1, 8.2.3: the notices a keep-alive state change gives the pages. `keepalive-lost` when it
 * fails with a reason not told yet since it last ran (a retry that fails the same way says
 * nothing), `keepalive-back` when it runs again after one was told. Exported for its test.
 */
export function keepAliveNotices(): (state: KeepAlivePayload) => {
  kind: Extract<NoticeMessage['kind'], 'keepalive-lost' | 'keepalive-back'>;
  text: string;
} | null {
  let told: string | null = null;
  return (state) => {
    if (state.state === 'running') {
      if (told === null) return null;
      told = null;
      return { kind: 'keepalive-back', text: 'WSL is kept running again' };
    }
    if (state.state !== 'failed') return null;
    const reason = sanitize(state.error ?? 'for no known reason');
    if (reason === told) return null;
    told = reason;
    return {
      kind: 'keepalive-lost',
      text: `WSL is not kept running: ${reason}; skydeck tries again`,
    };
  };
}

/** B12: the view the notifier judges "needs you" over: a page without a filter, Earlier unfolded. */
const NOTIFIER_VIEW = { filter: '', unfolded: ['earlier'], showDone: false, selected: null };

/** Stage B's parts of the server (plan B 2.7): what `runServer` wires into the tick and the pages. */
interface AttentionParts {
  seen: Seen;
  attention: Attention;
  /** The tick's `attention`: each call followed by the notifier's check. */
  tick: Pick<Attention, 'look' | 'refreshed'>;
}

/**
 * Plan B 2.7: Seen (S2 12.4) on the server's clock, attention over the tick's rows, and the notifier
 * (S2 13, B12) over the list a page without a filter gets; a session that begins to be seen writes
 * its seen at once (`seenNow`) and pushes the lists when that changed the facts. The notifier's
 * check never stops the tick (contract 2.6: it throws what its deps throw): a failure is logged by
 * kind, once until a check works again.
 */
function attentionParts(deps: {
  deck: Deck;
  hub: TerminalHub;
  tick: () => Tick | null;
  pages: () => Pick<Pages, 'notify' | 'pushList'>;
  log: (line: string) => void;
  storeNewer: (reason: string) => void;
}): AttentionParts {
  const { deck, hub, log } = deps;
  const seen = createSeen(deck.platform.clock);
  const attention = createAttention({
    deck,
    hub,
    seen,
    rows: () => deps.tick()?.rows() ?? [],
    log,
    storeNewer: deps.storeNewer,
  });
  /** The sessions that need you now, with their titles, in Ctrl+Shift+J's order (B6, B12). */
  const needs = (): Map<string, { title: string; attention: AttentionPayload }> => {
    const tick = deps.tick();
    const message = buildListMessage({
      rows: tick?.rows() ?? [],
      terminals: hub.list(),
      elsewhere: tick?.elsewhere() ?? new Map(),
      view: NOTIFIER_VIEW,
      selected: null,
      nowNs: deck.platform.clock.nowNs(),
      attention: attention.facts(),
    });
    const rows = new Map(message.sections.flatMap((section) => section.rows).map((r) => [r.id, r]));
    const needing = new Map<string, { title: string; attention: AttentionPayload }>();
    for (const id of message.needYou.order) {
      const row = rows.get(id);
      if (row !== undefined && row.attention !== null) {
        needing.set(id, { title: row.title, attention: row.attention });
      }
    }
    return needing;
  };
  const notifier = createNotifier({
    needs,
    ready: () => attention.ready(),
    send: (message) => deps.pages().notify(message),
  });
  let failing: string | null = null;
  const check = (): void => {
    try {
      notifier.check();
      failing = null;
    } catch (error) {
      const kind = failureKind(error);
      if (kind !== failing) log(`notify: the check failed (${kind})`);
      failing = kind;
    }
  };
  // A listener must not throw (contract 2.5): seenNow never does, pushList guards each page and
  // check is wrapped.
  seen.onChange(() => {
    if (attention.seenNow()) {
      deps.pages().pushList();
      check();
    }
  });
  return {
    seen,
    attention,
    tick: {
      look() {
        const changed = attention.look();
        check();
        return changed;
      },
      refreshed() {
        const changed = attention.refreshed();
        check();
        return changed;
      },
    },
  };
}

/** S2 5.2: a server.sock that a process answers on (found by the probe, or at the listen). */
function sockInUse(files: RuntimeFiles): string {
  return `${files.serverSock} is in use by a process that answers on it; see skydeck doctor`;
}

/** Whether `error` says the address is taken (listenHttp's EADDRINUSE). */
function addressInUse(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'EADDRINUSE';
}

/** This process as the lock and the pid files name it (design 5.5). */
function ownLine(platform: Platform): { pid: number; procStart: number; bootId: string } {
  const stat = platform.proc.stat(platform.pid);
  const procStart = stat === null ? null : procStartFromStat(stat);
  const bootId = platform.proc.bootId();
  if (procStart === null || bootId === null || bootId === '') {
    throw new SkydeckError(
      "the window's server cannot start: its own process start or the boot id cannot be read",
    );
  }
  return { pid: platform.pid, procStart, bootId };
}

/** python3 for S2 8.3's status: found when `python3 -I` runs, with its version. */
async function pythonOf(platform: Platform): Promise<StatusAnswer['python']> {
  try {
    const result = await platform.runner.run(
      'python3',
      ['-I', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
      {
        cwd: '/',
        env: Object.fromEntries(
          Object.entries(platform.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        timeoutMs: PYTHON_CHECK_MS,
      },
    );
    const version = result.stdout.trim();
    return result.code === 0 && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
      ? { found: true, version }
      : { found: false, version: null };
  } catch {
    return { found: false, version: null };
  }
}

/**
 * S2 5.2 in this order: the refusal under Claude Code (13); the server's environment; the deck
 * (its connection guarded, S2 10.1); the lock (0 or 11); the runtime directory, taken and
 * prepared (12); the assets, the keeper file and the vendored xterm modules (A35); the secret; the
 * port (10, the lock released); `server.sock` probed (one that refuses removed, one a process
 * answers on fails the start); `server.json` and `server.pid` — before `server.sock` answers, so
 * that every server that answers can be found by them (ruled, server-findable; until then the lock
 * names it); `server.sock` listened on; the keepers found (`rediscover`, each one
 * not started through decideFoundKeeper); the interop link; the tick, whose first run makes the
 * first keep-alive check. A failure on the way gives back everything taken so far, server.json and
 * server.pid included.
 */
export async function runServer(options: ServerOptions): Promise<RunningServer> {
  const { platform } = options;
  const { clock, files: fs } = platform;
  if (platform.env.CLAUDECODE !== undefined) {
    throw new ServeExit(13, IN_CLAUDE_CODE);
  }
  const environment = serverEnvironment(platform.env);
  const startedNs = clock.nowNs();
  // Ruled (review 2): a store another process keeps locked fails a piece of the server's work
  // after 250 ms instead of freezing every terminal for the commands' 5 s (S2 14).
  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: BUSY_TIMEOUT_MS });

  // What is taken, to give back when the start fails.
  let lockTaken = false;
  const listeners: HttpListener[] = [];
  let registry: Registry | null = null;
  let unrecord = (): void => {}; // server.json and server.pid, once they may be written
  const giveBack = async (): Promise<void> => {
    await registry?.stopAll().catch(() => {});
    for (const listener of listeners.reverse()) await listener.close().catch(() => {});
    unrecord(); // before the lock, as the orderly stop does (S2 5.5)
    if (lockTaken) {
      try {
        releaseServerLock(deck);
      } catch {
        // A crashed server's lock is taken over by the next one (design 5.5).
      }
    }
    deck.store.close();
  };

  try {
    const own = ownLine(platform);
    const checkout = platform.appRoot;
    const taken = takeServerLock(deck, { ...own, checkout });
    if (!taken.taken) {
      const { pid, checkout: theirs } = taken.holder;
      throw new ServeExit(
        theirs === checkout ? 0 : 11,
        `a window server already runs (pid ${pid}, from ${sanitize(theirs)})`,
      );
    }
    lockTaken = true;

    const log = serverLog(platform, join(deck.places.stateDir, 'server.log'), options.foreground);
    // What the restore run and the launches are handed must never throw (tasks 72, 73: a hook
    // that throws ends a whole restore, its sessions' locks held for up to 60 s).
    const quietLog = (line: string): void => {
      try {
        log(line);
      } catch {
        // Nowhere left to say it.
      }
    };
    // Plan C20: read before the first tick, whose first refresh makes the store agree with this
    // server's pages, so that a mark a dead server left is seen (and then removed).
    const pageMark = createPageMark({ store: deck.store, log: quietLog });
    let files: RuntimeFiles;
    try {
      files = runtimeFiles(resolveRuntimeDir(deck, 'take').dir);
      prepareRuntimeDir(platform, files);
    } catch (error) {
      if (error instanceof RuntimeDirError) throw new ServeExit(12, error.message);
      throw error;
    }
    const assets = loadAssets(fs, platform.appRoot);
    const build = assets.build;
    writeKeeperFile(fs, files, build, assets.keeperCode);
    const xterm = await loadXterm(platform.appRoot);
    ensureSecret(deck.store, platform.randomBytes);
    const keepersLog = join(deck.places.stateDir, 'keepers.log');
    try {
      rotateLog(fs, keepersLog);
    } catch (error) {
      log(`server: keepers.log was not rotated (${failureKind(error)})`);
    }

    const serverId = Buffer.from(platform.randomBytes(SERVER_ID_BYTES)).toString('hex');
    let boundPort = 0;
    const interop = createInteropFrom(
      platform,
      files,
      options.interopFirst ?? platform.env.SKYDECK_TEST_INTEROP_FIRST ?? INTEROP_FIRST,
    );
    const keepAlive = createKeepAlive({
      platform,
      window: deck.config.window,
      files,
      appRoot: platform.appRoot,
      interop,
    });
    const tokens = createTokens(clock, platform.randomBytes, () => {
      raiseAlarm(deck.store, clock.nowNs());
    });

    // The latest hello of each terminal: what its exit is settled with (S2 7.8).
    const hellos = new Map<string, KeeperHello>();
    // Found keepers whose decision met a busy store (ruled, review 2): decided again after each
    // refresh that worked, while the clock is before their startBy.
    const postponed = new Map<string, KeeperHello>();
    let tick: Tick | null = null;
    /**
     * S2 7.3: a keeper this server did not just spawn starts its program only when the guard, a lock
     * of its hello's take (plan C19: the lock it was spawned with, or a renewal of it — a restore
     * renews the locks it waits on) and the deadline still allow it (task 21); a busy store decides
     * nothing yet.
     */
    const decide = (termId: string, hello: KeeperHello): void => {
      const decision = decideFoundKeeper(deck, hello);
      if (decision.start === 'later') {
        if (!postponed.has(termId)) log(`terminal ${termId}: the store is busy; decided later`);
        postponed.set(termId, hello);
        return;
      }
      postponed.delete(termId);
      if (decision.start) {
        created.start(termId);
      } else if (hello.exited === null) {
        created.refuse(termId, decision.reason);
      }
      log(`terminal ${termId}: a found keeper was ${decision.start ? 'started' : 'refused'}`);
      tick?.reload(); // the decision refreshed on the server's own connection
    };
    /** After a refresh that worked: the postponed decisions, each while its terminal waits for one. */
    const decidePostponed = (): void => {
      for (const [termId, hello] of [...postponed]) {
        const term = created.list().find((candidate) => candidate.id === termId);
        const waiting = term !== undefined && term.exit === null && term.program === null;
        if (!waiting || clock.nowNs() >= BigInt(hello.startBy)) {
          postponed.delete(termId); // ended, forgotten, started — or the keeper refuses by itself
          continue;
        }
        decide(termId, hello);
      }
    };
    const created = createRegistry({
      platform,
      files,
      xterm,
      keeperFile: files.keeperFile(build),
      keepersLog,
      log,
      events: {
        hello(term, hello, origin) {
          hellos.set(term.id, hello);
          if (origin === 'spawned' || hello.started) {
            postponed.delete(term.id);
            return;
          }
          decide(term.id, hello);
        },
        started() {},
        exited(term) {
          // Once per terminal (task 16): its hello is needed no more after this. An exit made up
          // for a keeper that never sent a hello is not settled (ruled, review 2): there is no
          // hello to take the lock value from, and the lock expires by itself.
          const hello = hellos.get(term.id);
          hellos.delete(term.id);
          postponed.delete(term.id);
          if (hello !== undefined) tick?.ended(hello);
        },
      },
    });
    registry = created;

    /** The window terminal (task 21) for a launch of `size`; it spawns nothing before open(). */
    const terminalFor = (size: { cols: number; rows: number }): Terminal => {
      const terminal = windowTerminal(
        {
          registry: created,
          files,
          platform,
          serverEnv: environment.env,
          coreSoft: environment.coreSoft,
          interop: () => interop.current(),
          build,
        },
        size,
      );
      return {
        name: terminal.name,
        opensTabs: terminal.opensTabs,
        async open(spec: LaunchSpec) {
          // S2 6.4: the link is pointed again when a terminal starts.
          try {
            await interop.refresh();
          } catch (error) {
            log(`interop: the link was not pointed (${failureKind(error)})`);
          }
          return terminal.open(spec);
        },
      };
    };
    // Plan D7, D8: an edit shows in every window at once; the pull-request fetches the window asks
    // for run in the background, one at a time, aborted by the stop.
    const stopPrs = new AbortController();
    const prFetches = createPrFetches({
      deck,
      signal: stopPrs.signal,
      changed: () => tick?.reloadNow(),
      log,
    });
    const acting = createActions({
      deck,
      hub: created,
      terminalFor,
      openLink: (url) => openLink(platform, deck.config.window, url, interop.current()),
      log,
      changed: () => tick?.reloadNow(),
      prs: prFetches,
      // Plan C 2.3: the banner's two actions, through the one restorer.
      restore: (sessionIds) => {
        const started = restorer.start({ sessionIds: [...sessionIds], all: false });
        return started.ok ? { ok: true } : { ok: false, error: started.error };
      },
      dismissRestore: (bootId) => restorer.dismiss(bootId),
    });
    // Plan C7, S2 8.2.6: what a terminal the server opens for a command or a restore starts at —
    // the area the page that had focus last reported, read when the terminal is opened.
    const firstSize = (): { cols: number; rows: number } =>
      pages.lastFocused()?.area ?? DEFAULT_SIZE;
    // Plan C1: `POST /resume`, `/new` and the restorer start sessions through the one way the
    // window starts them (launches.ts, stateless: one for the routes, one for restore, beside the
    // actions' own), each with a log of its own prefix that never throws.
    const sockLaunches = createLaunches({
      deck,
      hub: created,
      terminalFor,
      log: (line) => {
        quietLog(`server.sock ${line}`);
      },
    });
    const restoreLaunches = createLaunches({ deck, hub: created, terminalFor, log: quietLog });
    // Plan C6–C9, C22 (task 73): one restore at a time, whoever asked; its report to every page.
    // A run's wait ingests the spool on the server's own connection at every look, which the
    // tick's change marks do not show: `gone`, called at every look after its ingest, tells the
    // tick to load the rows again (review 2), so that what a look took is in the lists within a
    // refresh.
    const restorer = createRestorer({
      deck,
      terminalFor: (size) => restoreLaunches.restoreTerminal(size),
      refuse: (sessionId) => restoreLaunches.refusal(sessionId),
      gone: (sessionId) => {
        tick?.reload();
        return restoreLaunches.gone(sessionId);
      },
      size: firstSize,
      progress: (text) => {
        pages.notice('restore-progress', text);
      },
      changed: () => {
        tick?.reloadNow(); // the rows again (a run began or ended, a dismissal), and the lists
      },
      log: quietLog,
    });
    /** Plan C2: a launch of a route answered as the command would end; never rejects. */
    const launchFor = async (
      route: 'resume' | 'new',
      launch: () => Promise<Launched>,
    ): Promise<LaunchAnswer> => {
      try {
        return launchAnswer(await launch());
      } catch (error) {
        const kind = failureKind(error);
        if (isBusy(error)) {
          quietLog(`server.sock ${route}: the database is busy (${kind})`);
          return { code: 1, lines: [BUSY_LAUNCH], sessionId: null };
        }
        quietLog(`server.sock ${route}: failed (${kind})`);
        return {
          code: 1,
          lines: [`skydeck: the window's server could not start it (${kind})`],
          sessionId: null,
        };
      } finally {
        tick?.reload(); // a launch refreshes and writes on the server's own connection
      }
    };
    const actions: ActionHandler = {
      async act(page, action) {
        try {
          return await acting.act(page, action);
        } finally {
          tick?.reload(); // an action refreshes and writes on the server's own connection
        }
      },
    };

    const listFor = (page: PageState): ListMessage => {
      const rows = tick?.rows() ?? NO_ROWS;
      const { view } = page;
      const row = view.selected === null ? undefined : rows.find((r) => r.id === view.selected);
      const message = buildListMessage({
        rows,
        terminals: created.list(),
        elsewhere: tick?.elsewhere() ?? new Map(),
        view,
        selected: row === undefined ? null : selectedPayload(deck, row),
        nowNs: clock.nowNs(),
        attention: attending.attention.facts(),
      });
      // The sections' rows, and a hidden selection whose header the page shows (E13: it has a
      // terminal of the window), whose pull requests that header shows too (review 2, ruled).
      tick?.listed([
        ...message.sections.flatMap((section) => section.rows.map((r) => r.id)),
        ...(message.selectedRow?.terminal == null ? [] : [message.selectedRow.id]),
      ]);
      return {
        ...message,
        // Plan C9: the view model's banner for the tick's rows — the array itself (its cache).
        banner: restorer.banner(rows),
        terminals: message.terminals.map((term) => ({ ...term, ownsSize: false })),
      };
    };
    // Ruled (review 2): no page is served before the keepers are found and the first tick has run
    // — the hub would list no terminal, so a page could resume a session whose terminal is about
    // to be found, or attach to a terminal not known yet. Until then an upgrade is answered 503
    // (S2 8.2.1), and the page tries again. (If that tick's refresh failed, the first list comes
    // with the next one; the registry is complete either way.)
    let ready = false;
    // Plan C4: from the first line of the orderly stop the launch routes answer 503 'stopping'.
    let stopBegun = false;
    /** Plan C20: the end of the start on the clock that cannot step (null while it starts). */
    let startDoneNs: Ns | null = null;
    // Stage B (plan B 2.7): made before the tick and the pages, which it looks up when it runs.
    const attending = attentionParts({
      deck,
      hub: created,
      tick: () => tick,
      pages: () => pages,
      log,
      storeNewer: (reason) => {
        storeNewer(reason);
      },
    });
    const pages = createPages({
      platform,
      port: () => boundPort,
      store: deck.store,
      tokens,
      hub: created,
      actions,
      welcome: () => ({
        protocol: PROTOCOL,
        assetVersion: build,
        serverId,
        bootId: own.bootId,
        version: pkg.version,
        keepAlive: keepAlive.state(),
        nowNs: String(clock.nowNs()),
      }),
      listFor,
      log,
      starting: () => !ready,
      seen: attending.seen,
    });
    created.onChange(() => {
      pages.pushList();
    });
    const notices = keepAliveNotices();
    keepAlive.onChange((state) => {
      try {
        const notice = notices(state);
        if (notice !== null) pages.notice(notice.kind, notice.text);
      } catch (error) {
        log(`keep-alive: the pages were not told (${failureKind(error)})`);
      }
    });

    // The real stop is set below. Until then a stop asked for (the shutdown route while the
    // server starts, a store migrated under the first tick) is kept, and made once it is set.
    let asked: string | null = null;
    let stop: (reason: string) => Promise<void> = (reason) => {
      asked ??= reason;
      return Promise.resolve();
    };
    /** S2 10.1: the store was migrated under the server — told by the tick or by attention. */
    let migrated = false;
    const storeNewer = (reason: string): void => {
      if (migrated) return;
      migrated = true;
      log('server: the store was migrated by a newer skydeck; the server stops');
      void stop(reason);
    };
    const startedTick = createTick({
      deck,
      hub: created,
      pages,
      keepAlive,
      interop,
      keepersLog,
      log,
      afterRefresh: () => {
        pageMark.update(pages.count()); // plan C20; it never throws
        decidePostponed();
      },
      storeNewer,
      attention: attending.tick,
    });
    tick = startedTick;

    // The port (S2 5.2): taken by anything else, the server gives the lock back and exits 10.
    const port = options.port ?? deck.config.window.port;
    try {
      const http = await platform.net.listenHttp(
        { host: '127.0.0.1', port },
        {
          request: httpHandler(assets, () => boundPort),
          upgrade: (req, socket, head) => {
            pages.upgrade(req, socket, head);
          },
        },
      );
      listeners.push(http);
      boundPort = http.port;
    } catch (error) {
      if (addressInUse(error)) {
        throw new ServeExit(
          10,
          `port ${port} on 127.0.0.1 is used by another program; set window.port in ${deck.places.configPath}`,
        );
      }
      throw error;
    }

    // server.json and server.pid (S2 4.2, 5.2) before server.sock answers (ruled, server-findable):
    // a command finds a server by server.json, so one that answers must have written it already.
    // Until here the window_server lock is what names this server.
    const envOrigin = { dir: environment.origin ?? cwdOf(platform), atNs: String(startedNs) };
    if (options.startDelayMs !== undefined && options.startDelayMs > 0) {
      await clock.sleep(options.startDelayMs); // A31's seam: this step made slow
    }
    // server.sock (S2 5.2, 8.3): one a dead server left behind refuses connections, and goes; one
    // that a process answers on fails the start before server.json is written, so that the record
    // of whatever answers there is left as it is (review 2).
    const sock = await probeSocket(platform, files.serverSock);
    if (sock === 'refused') fs.remove(files.serverSock);
    if (sock === 'accepts') throw new SkydeckError(sockInUse(files));
    const record: ServerJson = {
      pid: own.pid,
      procStart: own.procStart,
      bootId: own.bootId,
      port: boundPort,
      serverId,
      build,
      checkout,
      startedAt: String(startedNs),
      envOrigin,
    };
    unrecord = () => {
      removeOwn(platform, files, serverId, own.pid, log);
    };
    writeServerJson(fs, files.serverJson, record);
    fs.writeText(files.serverPid, formatPidLine(own), 0o600);

    let python: StatusAnswer['python'] = { found: false, version: null };
    const ping = (): PingAnswer => ({
      serverId,
      bootId: own.bootId,
      build,
      protocol: PROTOCOL,
      pid: own.pid,
      port: boundPort,
      checkout,
    });
    let control: HttpListener;
    try {
      control = await platform.net.listenHttp(
        { path: files.serverSock },
        {
          request: controlHandler({
            ping,
            status: () => ({
              starting: !ready, // what answers a page's upgrade with 503 (ruled, server-findable)
              pages: pages.count(),
              terminals: created.list().map((term) => ({
                id: term.id,
                slot: term.slot,
                state: term.state,
                sessionId: term.sessionId,
                pid: term.program?.pid ?? null,
              })),
              keepAlive: keepAlive.state(),
              python,
              build,
              checkout,
              startedAtNs: String(startedNs),
              envOrigin,
              windowExpectedMs: pageMark.expectedMs(
                clock.monotonicNs(),
                startDoneNs,
                pages.count(),
              ),
            }),
            tokens,
            shutdown: () => {
              void stop("skydeck's server was stopped");
            },
            log,
            // Plan C2–C5, C22: the command line's starts, prepared here, never by the command.
            launch: {
              resume: (sessionId) =>
                launchFor('resume', () => sockLaunches.resume(sessionId, firstSize())),
              newSession: (request) =>
                launchFor('new', () => sockLaunches.newSession(request, firstSize())),
              restore: (request, write, closed) => {
                const started = restorer.start(request, write, closed);
                return started.ok ? started.done : Promise.resolve();
              },
            },
            launchState: () => (stopBegun ? 'stopping' : ready ? null : 'starting'),
          }),
        },
      );
    } catch (error) {
      if (addressInUse(error)) throw new SkydeckError(sockInUse(files));
      throw error;
    }
    listeners.push(control);
    python = await pythonOf(platform);

    // The keepers left running (S2 7.3): each found screen is rebuilt; it always settles.
    const found = await created.rediscover();
    if (found.length > 0) log(`server: ${found.length} terminal(s) found`);
    try {
      await interop.refresh(); // before the first keep-alive check (task 19)
    } catch (error) {
      log(`interop: the link was not pointed (${failureKind(error)})`);
    }

    let resolveDone: (code: number) => void = () => {};
    const done = new Promise<number>((resolve) => {
      resolveDone = resolve;
    });
    let stopping: Promise<void> | null = null;
    const askedBefore = (): string | null => asked;
    stop = (reason) => {
      stopping ??= orderlyStop(reason).then(
        () => {
          resolveDone(0);
        },
        (error: unknown) => {
          log(`server: the stop failed (${failureKind(error)})`);
          resolveDone(1);
        },
      );
      return stopping;
    };

    /** S2 5.5. */
    const orderlyStop = async (reason: string): Promise<void> => {
      stopBegun = true;
      log('server: stopping');
      // Plan C20 (ruled 13:28Z): the mark once more as the pages are, before they are told bye —
      // a page that connected since the last refresh is recorded, one that went is not; a write
      // that fails is logged by kind. A server that dies leaves it as its last refresh did.
      pageMark.update(pages.count());
      // Then (plan C8, S2 5.5): a restore ends before anything it uses is closed; the sessions it
      // opened go on starting, the rest are said to be not started.
      await restorer.stop();
      stopPrs.abort();
      await startedTick.stop();
      await prFetches.idle(); // aborted: it saves nothing more and starts no other (plan D8)
      attending.seen.stop(); // no hold ends from now on (plan B 2.7)
      await control.close(); // no command reaches it any more; its file goes with it
      await pages.bye(reason); // then an upgrade is answered 503 until the port closes (task 17)
      for (const listener of listeners) {
        if (listener !== control) await listener.close();
      }
      await created.stopAll(); // every keeper parked; they and their programs keep running
      startedTick.settleAll();
      removeOwn(platform, files, serverId, own.pid, log);
      try {
        releaseServerLock(deck);
      } catch (error) {
        // A store migrated under the server refuses this write too; the lock then names a
        // process that is gone, which the next server takes over (design 5.5).
        log(`server: the lock was not released (${failureKind(error)})`);
      }
      tokens.forgetAll();
      deck.store.close();
      log('server: stopped');
    };

    await startedTick.start();
    log(`server: ${serverId} listening on 127.0.0.1:${boundPort} (build ${build})`);
    startDoneNs = clock.monotonicNs();
    ready = true;
    const early = askedBefore();
    if (early !== null) void stop(early); // asked for while it started (review 2)

    return {
      port: boundPort,
      runtimeDir: files.dir,
      serverId,
      build,
      hub: created,
      stop: (reason) => stop(reason),
      done,
    };
  } catch (error) {
    await giveBack();
    // Ruled (review 2): the start's own writes wait the same 250 ms; a store another process keeps
    // locked longer fails the start at once (S2 5.2's "did not start", exit 1), nothing left.
    if (isBusy(error)) throw new SkydeckError(BUSY_AT_START);
    throw error;
  }
}

/** The directory the server was started in; `/` when it cannot be read (S2 5.2, A29). */
function cwdOf(platform: Platform): string {
  try {
    return platform.cwd;
  } catch {
    return '/';
  }
}

/** server.json and server.pid, each only while it still names this server (S2 5.5). */
function removeOwn(
  platform: Platform,
  files: RuntimeFiles,
  serverId: string,
  pid: number,
  log: (line: string) => void,
): void {
  const { files: fs } = platform;
  try {
    if (readServerJson(fs, files.serverJson)?.serverId === serverId) fs.remove(files.serverJson);
  } catch (error) {
    log(`server: server.json was not removed (${failureKind(error)})`);
  }
  try {
    const text = fs.readText(files.serverPid);
    if (text !== null && parsePidLine(text)?.pid === pid) fs.remove(files.serverPid);
  } catch (error) {
    log(`server: server.pid was not removed (${failureKind(error)})`);
  }
}
