/**
 * The window's server (S2 4.1, 5.2, 5.5; plan task 23): every part of `src/window/` put together
 * into the one server of an installation. `runServer` takes the lock, the runtime directory, the
 * assets and the build, the port and `server.sock`, finds the keepers left running, points the
 * interop link, writes `server.json` and `server.pid`, and starts the tick (tick.ts); `stop` is
 * S2 5.5. The command `skydeck serve` (src/cli/commands/serve.ts) runs it in a process of its own;
 * tests run it in theirs (A19), so nothing here touches the process itself (signals, exit).
 */
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import pkg from '../../package.json' with { type: 'json' };
import { procStartFromStat } from '../claude/procstat.ts';
import { SkydeckError } from '../platform/errors.ts';
import type { HttpListener, Platform } from '../platform/types.ts';
import { openDeck } from '../sessions/deck.ts';
import type { LaunchSpec, Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { createActions } from './actions.ts';
import { httpHandler, loadAssets } from './assets.ts';
import { createTokens, ensureSecret, failureKind, raiseAlarm } from './auth.ts';
import { controlHandler } from './control.ts';
import { openLink } from './edge.ts';
import { serverEnvironment } from './env.ts';
import type { KeeperHello } from './frames.ts';
import type { ActionHandler, TerminalHub } from './hub.ts';
import { createInteropFrom, probeSocket } from './interop.ts';
import { createKeepAlive } from './keepalive.ts';
import { rotateLog, serverLog } from './log.ts';
import { createPages } from './pages.ts';
import type { PageState } from './pages.ts';
import { formatPidLine, parsePidLine } from './pidline.ts';
import type {
  KeepAlivePayload,
  ListMessage,
  NoticeMessage,
  PingAnswer,
  StatusAnswer,
} from './protocol.ts';
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
/** How long the python3 check at start may take. */
const PYTHON_CHECK_MS = 5000;
/** At most this many upgrades wait while the server starts (as pages' hello cap); the oldest goes. */
const MAX_HELD_UPGRADES = 64;

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
 * port (10, the lock released); `server.sock` (one that refuses removed); the keepers found
 * (`rediscover`, each one not started through decideFoundKeeper); the interop link; `server.json`
 * and `server.pid`; the tick, whose first run makes the first keep-alive check. A failure on the
 * way gives back everything taken so far.
 */
export async function runServer(options: ServerOptions): Promise<RunningServer> {
  const { platform } = options;
  const { clock, files: fs } = platform;
  if (platform.env.CLAUDECODE !== undefined) {
    throw new ServeExit(13, IN_CLAUDE_CODE);
  }
  const environment = serverEnvironment(platform.env);
  const startedNs = clock.nowNs();
  const deck = openDeck(platform, { guardSchema: true });

  // What is taken, to give back when the start fails.
  let lockTaken = false;
  const listeners: HttpListener[] = [];
  let registry: Registry | null = null;
  /** Upgrades that came while the server starts: handed to pages once it is ready. */
  const held: { req: IncomingMessage; socket: Duplex; head: Buffer }[] = [];
  const giveBack = async (): Promise<void> => {
    for (const { socket } of held.splice(0)) socket.destroy();
    await registry?.stopAll().catch(() => {});
    for (const listener of listeners.reverse()) await listener.close().catch(() => {});
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
    let tick: Tick | null = null;
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
          if (origin === 'spawned' || hello.started) return;
          // S2 7.3: a keeper this server did not just spawn starts its program only when the
          // guard, the exact lock and the deadline still allow it (task 21).
          const decision = decideFoundKeeper(deck, hello);
          if (decision.start) {
            created.start(term.id);
          } else if (hello.exited === null) {
            created.refuse(term.id, decision.reason);
          }
          log(`terminal ${term.id}: a found keeper was ${decision.start ? 'started' : 'refused'}`);
          tick?.reload(); // the decision refreshed on the server's own connection
        },
        started() {},
        exited(term) {
          // Once per terminal (task 16): its hello is needed no more after this.
          const hello = hellos.get(term.id);
          hellos.delete(term.id);
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
    const acting = createActions({
      deck,
      hub: created,
      terminalFor,
      openLink: (url) => openLink(platform, deck.config.window, url, interop.current()),
      log,
    });
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
      const rows = tick?.rows() ?? [];
      const { view } = page;
      const row = view.selected === null ? undefined : rows.find((r) => r.id === view.selected);
      const message = buildListMessage({
        rows,
        terminals: created.list(),
        elsewhere: tick?.elsewhere() ?? new Map(),
        view,
        selected: row === undefined ? null : selectedPayload(deck, row),
        nowNs: clock.nowNs(),
      });
      tick?.listed(message.sections.flatMap((section) => section.rows.map((r) => r.id)));
      return {
        ...message,
        terminals: message.terminals.map((term) => ({ ...term, ownsSize: false })),
      };
    };
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
    // Pages are let in once the keepers are found and the first tick has loaded the rows (review
    // 2): before that the hub lists no terminal, so a page could resume a session whose terminal
    // is about to be found and open a second one, or attach to a terminal not known yet. An
    // upgrade that comes earlier waits; nothing of the page protocol changes.
    let ready = false;
    const startedTick = createTick({
      deck,
      hub: created,
      pages,
      keepAlive,
      interop,
      keepersLog,
      log,
      storeNewer: (reason) => {
        log('server: the store was migrated by a newer skydeck; the server stops');
        void stop(reason);
      },
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
            if (ready) {
              pages.upgrade(req, socket, head);
              return;
            }
            socket.on('error', () => {}); // a peer's reset while it waits must not end the server
            held.push({ req, socket, head });
            if (held.length > MAX_HELD_UPGRADES) held.shift()?.socket.destroy();
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

    // server.sock (S2 5.2, 8.3): one a dead server left behind refuses connections.
    if ((await probeSocket(platform, files.serverSock)) === 'refused') {
      fs.remove(files.serverSock);
    }
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
    const envOrigin = { dir: environment.origin ?? cwdOf(platform), atNs: String(startedNs) };
    let control: HttpListener;
    try {
      control = await platform.net.listenHttp(
        { path: files.serverSock },
        {
          request: controlHandler({
            ping,
            status: () => ({
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
            }),
            tokens,
            shutdown: () => {
              void stop("skydeck's server was stopped");
            },
            log,
          }),
        },
      );
    } catch (error) {
      if (addressInUse(error)) {
        throw new SkydeckError(
          `${files.serverSock} is in use by a process that answers on it; see skydeck doctor`,
        );
      }
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
      log('server: stopping');
      await startedTick.stop();
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
    writeServerJson(fs, files.serverJson, record);
    fs.writeText(files.serverPid, formatPidLine(own), 0o600);
    await startedTick.start();
    log(`server: ${serverId} listening on 127.0.0.1:${boundPort} (build ${build})`);
    ready = true;
    const early = askedBefore();
    if (early !== null) {
      // Asked to stop while it started: no page is let in; the pages that waited try again.
      for (const { socket } of held.splice(0)) socket.destroy();
      void stop(early);
    } else {
      for (const { req, socket, head } of held.splice(0)) {
        if (!socket.destroyed) pages.upgrade(req, socket, head);
      }
    }

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
