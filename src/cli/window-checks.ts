// The lines S2 16.3 adds to `skydeck doctor`: what the window needs and what of it runs. doctor
// starts no program for them but `python3 --version`, nothing on Windows, signals nothing and never
// connects to a keeper (S2 7.1): keepers are judged by their `.pid` lines alone. It talks to the
// window's server over server.sock (GET /ping, GET /status) and connects once, sending nothing, to
// the socket the interop link points at. It creates nothing. In a test sandbox it reads nothing
// under /mnt/ (src/window/drive.ts).
//
// Ruled by the plan owner (task 24): every line here that would be a problem is `info` while the
// window has never been used (no window_secret, or no database to read it from) — doctor.ts
// applies that to what these checks report.
import { isAbsolute, join } from 'node:path';

import type { Config } from '../platform/config.ts';
import { SkydeckError } from '../platform/errors.ts';
import type { Places, RuntimeRule } from '../platform/paths.ts';
import type { Ns, Platform } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { describeError } from '../sessions/problems.ts';
import type { Store } from '../store/store.ts';
import { formatAge } from '../text/age.ts';
import { isoFromNs } from '../platform/time.ts';
import { computeBuild } from '../window/build.ts';
import { controlClient } from '../window/client.ts';
import { driveC, readablePath } from '../window/drive.ts';
import { probeSocket } from '../window/interop.ts';
import { findServer } from '../window/lifecycle.ts';
import { parsePidLine, pidLineState } from '../window/pidline.ts';
import type { PidLine, PidLineState } from '../window/pidline.ts';
import type { PingAnswer, StatusAnswer } from '../window/protocol.ts';
import {
  listKeeperLines,
  prepareRuntimeDir,
  resolveRuntimeDir,
  RuntimeDirError,
  runtimeFiles,
} from '../window/runtime.ts';
import type { RuntimeFiles } from '../window/runtime.ts';
import { verifyVendored } from '../window/vendor.ts';
import { deriveProfileDirUnder } from '../window/windows.ts';
import { instanceIdleTimeout } from '../window/wslconfig.ts';
import { PYTHON3_NEEDED, probePython3 } from './python.ts';

type Kind = 'ok' | 'info' | 'problem';
type Report = (kind: Kind, text: string) => void;

/** What doctor could open: the configuration and the database are null when they could not be had. */
interface WindowFacts {
  platform: Platform;
  places: Places;
  config: Config | null;
  store: Store | null;
}

type Server =
  | { kind: 'none' }
  | { kind: 'hung'; pid: number; starting?: true } // starting: only its lock names it (ruled, server-findable)
  | { kind: 'unknown'; error: string } // server.json, or the lock, names a process that cannot be judged
  | {
      kind: 'ours' | 'other-build' | 'other-checkout';
      ping: PingAnswer;
      status: StatusAnswer | null;
      statusError: string | null;
    };

type Keeper = { id: string; line: PidLine | null; state: PidLineState };

/** What several checks look at, each found once per doctor run. */
export interface WindowView {
  facts: WindowFacts;
  /** The configuration and the database together; null when either could not be had. */
  deck: Deck | null;
  /** window_secret is set (S2 16.3: the window has been used). */
  used: boolean;
  runtime(): { dir: string; rule: RuntimeRule | 'record'; files: RuntimeFiles };
  server(): Promise<Server>;
  keepers(): Keeper[];
}

export interface WindowCheck {
  name: string;
  /** 'config': skipped without a configuration; 'deck': without a configuration or a database. */
  needs: 'nothing' | 'config' | 'deck';
  run(view: WindowView, report: Report): void | Promise<void>;
}

const NOT_MOUNTED = 'the C: drive is not mounted at /mnt/c';
/** findServer's default ping wait, which doctor uses (S2 5.1: 5 seconds). */
const PING_S = 5;
/** Where systemd marks a user whose runtime directory outlives their last login session (S2 4.2). */
const LINGER_DIR = '/var/lib/systemd/linger';
/** The python3 the launcher starts `serve` through (S2 2); a test sandbox may name another (A31). */
const CORE_LIMIT_PYTHON3 = '/usr/bin/python3';
/** At most this many lines for the vendored files: a broken checkout is one finding. */
const VENDOR_LINES = 5;

/** The view for one doctor run. Nothing is looked at before a check asks. */
export function windowView(facts: WindowFacts): WindowView {
  const { platform, places, config, store } = facts;
  const deck = config !== null && store !== null ? { platform, places, config, store } : null;
  let runtime: ReturnType<WindowView['runtime']> | null = null;
  let server: Promise<Server> | null = null;
  let keepers: Keeper[] | null = null;
  const view: WindowView = {
    facts,
    deck,
    used: wasUsed(store),
    runtime() {
      if (deck === null) throw new Error('the runtime directory needs the database');
      if (runtime === null) {
        const { dir, rule } = resolveRuntimeDir(deck, 'follow');
        runtime = { dir, rule, files: runtimeFiles(dir) };
      }
      return runtime;
    },
    server() {
      if (deck === null) throw new Error('the server needs the database');
      server ??= findTheServer(deck, view.runtime().files);
      return server;
    },
    keepers() {
      keepers ??= listKeeperLines(platform, view.runtime().files);
      return keepers;
    },
  };
  return view;
}

/** No database, or one that cannot be read: nothing shows the window was used. */
function wasUsed(store: Store | null): boolean {
  try {
    return store !== null && store.getKv('window_secret') !== null;
  } catch {
    return false;
  }
}

async function findTheServer(deck: Deck, files: RuntimeFiles): Promise<Server> {
  const checkout = deck.platform.appRoot;
  const build = computeBuild(deck.platform.files, checkout);
  let found: Awaited<ReturnType<typeof findServer>>;
  try {
    found = await findServer(deck, checkout, build);
  } catch (error) {
    if (error instanceof SkydeckError) return { kind: 'unknown', error: error.message };
    throw error;
  }
  if (found.kind === 'none' || found.kind === 'hung') return found;
  try {
    const status = await controlClient(deck.platform.net, files.serverSock).status();
    return { kind: found.kind, ping: found.ping, status, statusError: null };
  } catch (error) {
    if (!(error instanceof SkydeckError)) throw error;
    return { kind: found.kind, ping: found.ping, status: null, statusError: error.message };
  }
}

/** A server answered (of whatever checkout or build). */
function answered(server: Server): server is Extract<Server, { ping: PingAnswer }> {
  return (
    server.kind === 'ours' || server.kind === 'other-build' || server.kind === 'other-checkout'
  );
}

/**
 * A server answered and says that its start is not done (GET /status `starting`; ruled,
 * server-findable): what it makes during its start (the interop link) is not there yet.
 */
function stillStarting(server: Server): boolean {
  return answered(server) && server.status?.starting === true;
}

// ---------------------------------------------------------------------------------------------
// The checks, in the order doctor prints them

export const WINDOW_CHECKS: readonly WindowCheck[] = [
  { name: 'python3', needs: 'nothing', run: checkPython },
  { name: 'python3 for the core limit', needs: 'nothing', run: checkCoreLimit },
  { name: "the window's server", needs: 'deck', run: checkServer },
  { name: 'port', needs: 'deck', run: checkPort },
  { name: 'launch alarm', needs: 'deck', run: checkAlarm },
  { name: 'keep-alive', needs: 'deck', run: checkKeepAlive },
  { name: 'interop', needs: 'deck', run: checkInterop },
  { name: 'the C: drive', needs: 'nothing', run: checkDrive },
  { name: 'Edge', needs: 'config', run: checkEdge },
  { name: 'profile folder', needs: 'config', run: checkProfileFolder },
  { name: 'runtime directory', needs: 'deck', run: checkRuntimeDir },
  { name: 'vendored files', needs: 'nothing', run: checkVendored },
  { name: 'keepers', needs: 'deck', run: checkKeepers },
];

/** S2 16.3 python3: the one the keepers run, on PATH (S2 7.1). */
async function checkPython({ facts }: WindowView, report: Report): Promise<void> {
  const found = await probePython3(facts.platform);
  switch (found.kind) {
    case 'found':
      report('ok', `python3 ${found.version} for the window's terminals`);
      return;
    case 'missing':
      report('problem', `python3 is not found: ${PYTHON3_NEEDED}`);
      return;
    case 'old':
      report('problem', `python3 ${found.version} is older than 3.9: ${PYTHON3_NEEDED}`);
      return;
    case 'failed':
      report('problem', `python3 --version failed (${found.why}): ${PYTHON3_NEEDED}`);
  }
}

/**
 * S2 2: the launcher starts `serve` through /usr/bin/python3 (never one on PATH) to set its core
 * limit; it is used when it is an absolute path to an executable file, as the launcher checks it.
 * In a test sandbox SKYDECK_TEST_PYTHON3 takes its place, exactly as for the launcher (A31).
 */
function checkCoreLimit({ facts }: WindowView, report: Report): void {
  const { env, files } = facts.platform;
  const path =
    env.SKYDECK_TEST_NO_WINDOWS === '1' && env.SKYDECK_TEST_PYTHON3 !== undefined
      ? env.SKYDECK_TEST_PYTHON3
      : CORE_LIMIT_PYTHON3;
  const readable = isAbsolute(path) ? readablePath(env, path) : null;
  const info = readable === null ? null : files.stat(readable);
  if (info?.kind === 'file' && (info.mode & 0o111) !== 0) {
    report('ok', `${path} keeps the window's server from writing crash dumps (its core limit)`);
  } else {
    report(
      'problem',
      `${path} is missing or not executable: the window's server would run without the core limit that keeps it from writing crash dumps (S2 2)`,
    );
  }
}

/** S2 16.3 server: never a problem by itself, but another build, another checkout or no answer is. */
async function checkServer(view: WindowView, report: Report): Promise<void> {
  const server = await view.server();
  const { platform } = view.facts;
  switch (server.kind) {
    case 'none':
      report('info', 'no window server runs');
      return;
    case 'unknown':
      report('problem', server.error);
      return;
    case 'hung':
      report(
        'problem',
        server.starting === true
          ? `the window's server (pid ${server.pid}) is starting and did not finish within ${PING_S} s (it holds the window_server lock and has not answered yet); see ${join(view.facts.places.stateDir, 'server.log')}; skydeck window --restart stops it`
          : `the window's server (pid ${server.pid}) is alive but does not answer; skydeck window --restart stops it`,
      );
      return;
  }
  const { ping, status } = server;
  if (status === null) {
    report(
      'problem',
      `the window's server (pid ${ping.pid}) answers, but GET /status failed (${server.statusError ?? '?'})`,
    );
  } else if (status.starting === true) {
    report(
      'info',
      `the window's server (pid ${ping.pid}) is starting, from ${status.checkout}, build ${status.build}; run skydeck doctor again once it has started`,
    );
  } else {
    const up = formatAge(platform.clock.nowNs() - nsOf(status.startedAtNs, platform.clock.nowNs()));
    report(
      'info',
      `the window's server runs: pid ${ping.pid}, from ${status.checkout}, build ${status.build}, up ${up}, ` +
        `${count(status.pages, 'page')}, ${count(status.terminals.length, 'terminal')}; ` +
        `environment of skydeck window run in ${status.envOrigin.dir} at ${timeOf(status.envOrigin.atNs)}`,
    );
  }
  if (server.kind === 'other-build') {
    const build = computeBuild(platform.files, platform.appRoot);
    report(
      'problem',
      ping.build !== build
        ? `the window's server (pid ${ping.pid}) runs another build of this checkout (${ping.build}, this checkout's is ${build}); run skydeck window --restart`
        : `the window's server (pid ${ping.pid}) answers with the boot id ${ping.bootId}, not this boot's; run skydeck window --restart`,
    );
  } else if (server.kind === 'other-checkout') {
    report(
      'problem',
      `the window's server runs from ${ping.checkout}, not from this checkout (${platform.appRoot}); run skydeck window there, or skydeck window --restart here to replace it`,
    );
  }
}

/**
 * S2 16.3 port (A30): a listener on window.port seen in /proc/net/tcp and tcp6, never by binding
 * the port or sending a request: something listens there and no server of this installation that
 * answers holds it.
 */
async function checkPort(view: WindowView, report: Report): Promise<void> {
  const { platform, places, config } = view.deck ?? unreachable();
  const { port } = config.window;
  const where = `port ${port} on 127.0.0.1`;
  const listening = platform.proc.tcpListening(port);
  if (listening === null) {
    report('info', `${where}: /proc/net/tcp cannot be read, so what holds it is not known`);
    return;
  }
  if (!listening) {
    report('ok', `${where} is free for the window's server`);
    return;
  }
  const server = await view.server();
  if (answered(server) && server.ping.port === port) {
    report('ok', `${where}: the window's server listens there`);
  } else if (server.kind === 'hung' || server.kind === 'unknown') {
    report(
      'info',
      `${where} is held; the window's server does not answer, so whether it holds it is not known`,
    );
  } else {
    report(
      'problem',
      `something that is not this installation's window server listens on 127.0.0.1:${port}; stop it, or set window.port in ${places.configPath}`,
    );
  }
}

/** S2 16.3 launch alarm (8.2.2): window_alarm, the time a launch token was presented twice. */
function checkAlarm(view: WindowView, report: Report): void {
  const { store } = view.deck ?? unreachable();
  const alarm = store.getKv('window_alarm');
  if (alarm === null) {
    report('ok', 'no launch alarm');
    return;
  }
  report(
    'problem',
    `a launch token was presented twice at ${timeOf(alarm)}, so another program may have skydeck's key; run skydeck window --new-secret`,
  );
}

/**
 * S2 16.3 keep-alive (6.1): a problem when a server or a keeper runs and neither protection is in
 * effect — `.wslconfig`'s instanceIdleTimeout=-1 (read from the Windows profile folder found as in
 * 5.4), or a running keep-alive: by the server's own word when it answers, else by its pid line and,
 * as the server judges one it did not start, its `keepalive.interop` socket.
 */
async function checkKeepAlive(view: WindowView, report: Report): Promise<void> {
  const { config } = view.deck ?? unreachable();
  const wslconfig = readWslconfig(view);
  if (wslconfig.on) {
    report('ok', '.wslconfig has instanceIdleTimeout=-1 (WSL does not stop by itself)');
    return;
  }
  const server = await view.server();
  const keepAlive = await keepAliveState(view, server);
  switch (keepAlive.kind) {
    case 'running':
      report('info', `keep-alive wsl.exe running (pid ${keepAlive.pid}, since ${keepAlive.since})`);
      return;
    case 'unknown':
      report(
        'info',
        `keep-alive: whether it runs cannot be told (pid ${keepAlive.pid}; the boot id or its /proc entry cannot be read)`,
      );
      return;
    case 'unreadable':
      report('info', 'keep-alive: keepalive.pid cannot be read, so whether it runs cannot be told');
      return;
  }
  if (stillStarting(server) && answered(server) && server.status?.keepAlive.state === 'starting') {
    // By the server's own word (ruled, server-findable, review 2): its keep-alive is starting —
    // its first check starts it (S2 6.1). One that is off, or failed (it cannot start: no
    // WSL_DISTRO_NAME, …), stays the problem below, also while the server starts.
    report(
      'info',
      "keep-alive: not confirmed yet: the window's server is starting, and its first check starts the keep-alive or takes over one that still runs",
    );
    return;
  }
  const serverRuns = server.kind !== 'none';
  const terminals = view.keepers().some((keeper) => keeper.state !== 'dead');
  if (!serverRuns && !terminals) {
    report('info', 'keep-alive: nothing to keep running (no window server and no terminal)');
    return;
  }
  const what =
    serverRuns && terminals ? 'a server and terminals' : serverRuns ? 'a server' : 'terminals';
  const why = [keepAlive.why];
  if (config.window.keepAlive === 'off') why.push('window.keepAlive is off');
  if (answered(server) && server.status?.keepAlive.error) {
    why.push(`the keep-alive ${server.status.keepAlive.state}: ${server.status.keepAlive.error}`);
  }
  why.push(wslconfig.why);
  report(
    'problem',
    `WSL is not kept running while the window has ${what} (${why.join('; ')}): WSL stops 15 s after its last Windows client and ends every session; set instanceIdleTimeout=-1 under [general] in ${wslconfig.windowsPath}; it takes effect at the next WSL restart by itself — wsl --shutdown restarts WSL at once but ends EVERY session and terminal in WSL, so run it only when nothing is running that you want to keep`,
  );
}

type KeepAliveState =
  | { kind: 'running'; pid: number | string; since: string }
  | { kind: 'unknown'; pid: number } // its line cannot be judged
  | { kind: 'unreadable' } // keepalive.pid is there but cannot be read: cannot tell (as the server)
  | { kind: 'none'; why: string };

const NO_KEEP_ALIVE = 'no keep-alive runs';

async function keepAliveState(view: WindowView, server: Server): Promise<KeepAliveState> {
  const { platform } = view.facts;
  const { files } = view.runtime();
  const modified = (): string => {
    try {
      const info = platform.files.stat(files.keepalivePid);
      return info === null ? 'an unknown time' : timeOf(String(info.mtimeNs));
    } catch {
      return 'an unknown time';
    }
  };
  let text: string | null = null;
  let unreadable = false;
  try {
    text = platform.files.readText(files.keepalivePid);
  } catch {
    unreadable = true;
  }
  const line = text === null ? null : parsePidLine(text);
  if (answered(server) && server.status !== null) {
    // The server judges its keep-alive itself, an orphan's wsl.exe included (S2 6.1).
    const { state, since } = server.status.keepAlive;
    if (state !== 'running') return { kind: 'none', why: NO_KEEP_ALIVE };
    return {
      kind: 'running',
      pid: line?.pid ?? '?',
      since: since === null ? modified() : timeOf(since),
    };
  }
  if (unreadable) return { kind: 'unreadable' };
  if (line === null) return { kind: 'none', why: NO_KEEP_ALIVE };
  const state = pidLineState(line, platform.proc, bootIdOf(platform));
  if (state === 'unknown') return { kind: 'unknown', pid: line.pid };
  if (state === 'dead') return { kind: 'none', why: NO_KEEP_ALIVE };
  if ((await keepAliveSocket(view)) === 'refused') {
    return {
      kind: 'none',
      why: "the keep-alive's wsl.exe is gone (its keepalive.interop socket refuses); no keep-alive runs",
    };
  }
  return { kind: 'running', pid: line.pid, since: modified() };
}

/**
 * S2 6.1's judgement of a keep-alive no answering server watches: one connection, sending nothing,
 * to the socket `keepalive.interop` names. 'refused' when it is refused or not there (its wsl.exe is
 * gone); anything else — no file, an empty one, one that cannot be read, a path that is not
 * absolute, no answer in 2 s — is no judgement, and so is a socket inside the runtime directory,
 * which is never connected to (a keeper's, S2 7.1).
 */
async function keepAliveSocket(view: WindowView): Promise<'refused' | 'no judgement'> {
  const { files: fs } = view.facts.platform;
  const { files } = view.runtime();
  let path: string | null;
  try {
    path = fs.readText(files.keepaliveInterop);
  } catch {
    return 'no judgement';
  }
  if (path === null || !path.startsWith('/') || /[\0\n\r]/.test(path)) return 'no judgement';
  let real: string | null;
  try {
    real = fs.realpath(path);
  } catch {
    return 'no judgement';
  }
  if (real === null) return 'refused'; // the path is not there
  const dir = fs.realpath(files.dir) ?? files.dir;
  if (real === dir || real.startsWith(`${dir}/`)) return 'no judgement';
  return (await probeSocket(view.facts.platform, real)) === 'refused' ? 'refused' : 'no judgement';
}

/** `.wslconfig` in the Windows user's folder (S2 6.1): whether it keeps WSL running, and if not why. */
function readWslconfig(
  view: WindowView,
): { on: true } | { on: false; why: string; windowsPath: string } {
  const { files } = view.facts.platform;
  const user = windowsUser(view);
  if (!user.ok) {
    return { on: false, why: user.why, windowsPath: '%USERPROFILE%\\.wslconfig' };
  }
  const path = join(user.folder, '.wslconfig');
  const windowsPath = `C:\\Users\\${user.name}\\.wslconfig`;
  let text: string;
  try {
    const info = files.stat(path);
    if (info === null || info.kind !== 'file') {
      return { on: false, why: `no .wslconfig at ${windowsPath}`, windowsPath };
    }
    text = decodeText(files.readBytes(path, 0, info.size));
  } catch (error) {
    return { on: false, why: `.wslconfig cannot be read (${describeError(error)})`, windowsPath };
  }
  return instanceIdleTimeout(text) === -1
    ? { on: true }
    : { on: false, why: '.wslconfig does not set instanceIdleTimeout=-1', windowsPath };
}

/** UTF-8 (a byte order mark is the parser's to skip), or UTF-16 LE after its byte order mark. */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The Windows user whose folder holds `.wslconfig`: the one window.profileDir names
 * (`C:\Users\<name>\…`), else the one 5.4's derivation finds; with the folder as it is read here.
 */
function windowsUser(
  view: WindowView,
): { ok: true; name: string; folder: string } | { ok: false; why: string } {
  const { platform, config } = view.facts;
  const drive = driveC(platform.env);
  if (drive === null) return { ok: false, why: NOT_MOUNTED };
  const configured = config?.window.profileDir ?? null;
  const fromProfile = configured === null ? null : /^C:\\Users\\([^\\]+)(?:\\|$)/i.exec(configured);
  let name = fromProfile?.[1] ?? null;
  if (name === null) {
    const derived = deriveProfileDirUnder(platform.files, join(drive, 'Users'));
    if (!derived.ok) {
      return {
        ok: false,
        why: `the Windows user folder for .wslconfig cannot be found (${derived.error})`,
      };
    }
    name = /^C:\\Users\\([^\\]+)\\/.exec(derived.dir)?.[1] ?? null;
  }
  if (name === null || name === '.' || name === '..' || name.includes('/')) {
    return { ok: false, why: 'the Windows user folder for .wslconfig cannot be found' };
  }
  return { ok: true, name, folder: join(drive, 'Users', name) };
}

/**
 * S2 16.3 interop (6.4): doctor's own WSL_INTEROP, and the runtime directory's link — one
 * connection to what it points at, sending nothing; never to anything inside the runtime directory
 * (a keeper's socket is never connected to, S2 7.1).
 */
async function checkInterop(view: WindowView, report: Report): Promise<void> {
  const { platform } = view.facts;
  const { files: fs } = platform;
  const own = platform.env.WSL_INTEROP;
  if (own === undefined || own === '') {
    report(
      'problem',
      'WSL_INTEROP is not set: this shell cannot start Windows programs, and a window server started from it has no interop socket of its own (S2 6.4)',
    );
  }
  const { files } = view.runtime();
  const link = files.interop;
  const info = fs.lstat(link);
  const server = await view.server();
  if (info === null) {
    if (answered(server) && !stillStarting(server)) {
      report(
        'problem',
        `${link} does not exist although the window's server runs: no interop socket answered it (S2 6.4)`,
      );
    } else {
      report('info', `${link} does not exist yet: the window's server makes it`);
    }
    return;
  }
  if (info.kind !== 'symlink') {
    report('problem', `${link} is not a symbolic link (S2 6.4)`);
    return;
  }
  const target = fs.readlink(link) ?? '?';
  const real = fs.realpath(link);
  const dir = fs.realpath(files.dir) ?? files.dir;
  if (real !== null && (real === dir || real.startsWith(`${dir}/`))) {
    report(
      'problem',
      `${link} points at ${target}, inside the runtime directory: not an interop socket, and doctor does not connect to it`,
    );
    return;
  }
  const answer = real === null ? 'refused' : await probeSocket(platform, real);
  if (answer === 'accepts') {
    report('ok', `${link} -> ${target} answers`);
  } else if (answer === 'refused' && stillStarting(server)) {
    report(
      'info',
      `${link} -> ${target} points at nothing that answers yet: the window's server is starting and points it again`,
    );
  } else if (answer === 'refused') {
    report(
      'problem',
      `${link} -> ${target} points at nothing that answers: Windows programs the terminals start (pasting an image) fail until the window's server points it again (skydeck window --restart)`,
    );
  } else {
    report('info', `${link} -> ${target}: no answer within 2 s, so whether it works is not known`);
  }
}

/** All of stage A expects C: at /mnt/c: Edge's working directory, wsl.exe, the users' folders. */
function checkDrive({ facts }: WindowView, report: Report): void {
  const drive = driveC(facts.platform.env);
  if (drive !== null && facts.platform.files.stat(join(drive, 'Windows'))?.kind === 'dir') {
    report('ok', `the C: drive is mounted at ${drive}`);
  } else {
    report(
      'problem',
      `${NOT_MOUNTED}: the window needs it (Edge, the keep-alive's wsl.exe, the profile folder)`,
    );
  }
}

/** S2 16.3 Edge: window.edge exists (it is never started here). */
function checkEdge({ facts }: WindowView, report: Report): void {
  const { platform, places } = facts;
  const { edge } = (facts.config ?? unreachable()).window;
  const path = readablePath(platform.env, edge);
  if (path === null) {
    report('problem', `Edge at ${edge} cannot be checked: ${NOT_MOUNTED}`);
    return;
  }
  const info = platform.files.stat(path);
  if (info === null) {
    report('problem', `Edge was not found at ${edge}; set window.edge in ${places.configPath}`);
  } else if (info.kind !== 'file') {
    report('problem', `window.edge ${edge} is not a file; set window.edge in ${places.configPath}`);
  } else {
    report('ok', `Edge: ${edge}`);
  }
}

/** S2 16.3 profile folder (5.4): window.profileDir, or derived without starting a Windows program. */
function checkProfileFolder({ facts }: WindowView, report: Report): void {
  const { platform, places } = facts;
  const { profileDir } = (facts.config ?? unreachable()).window;
  if (profileDir !== null) {
    report('ok', `the window's Edge profile folder: ${profileDir} (window.profileDir)`);
    return;
  }
  const drive = driveC(platform.env);
  if (drive === null) {
    report(
      'problem',
      `the window's Edge profile folder cannot be derived: ${NOT_MOUNTED}; set window.profileDir in ${places.configPath}`,
    );
    return;
  }
  const derived = deriveProfileDirUnder(platform.files, join(drive, 'Users'));
  if (derived.ok) {
    report('ok', `the window's Edge profile folder: ${derived.dir} (derived)`);
  } else {
    report('problem', `${derived.error} in ${places.configPath}`);
  }
}

const HOW: Record<RuntimeRule | 'record', string> = {
  record: 'recorded in the store',
  'skydeck-home': '$SKYDECK_HOME/run',
  'xdg-runtime': 'in $XDG_RUNTIME_DIR',
  'state-dir': 'in the state directory',
};

/**
 * S2 16.3 runtime directory (4.2): the one the store records, or the rule's; a problem when `serve`
 * would refuse it (prepareRuntimeDir's rule: not the user's, not 700, a socket path of 108 bytes or
 * more), judged without creating anything. `info` when XDG_RUNTIME_DIR was passed over because the
 * user does not linger.
 */
function checkRuntimeDir(view: WindowView, report: Report): void {
  const { platform } = view.facts;
  const { dir, rule, files } = view.runtime();
  const how = HOW[rule];
  const reason = refusalReason(platform, files);
  if (reason !== null) {
    report('problem', `runtime directory ${dir} (${how}) cannot be used: ${reason}`);
  } else if (platform.files.lstat(dir) === null) {
    report('ok', `runtime directory ${dir} (${how}): the window's server creates it`);
  } else {
    report('ok', `runtime directory ${dir} (${how})`);
  }
  const xdg = platform.env.XDG_RUNTIME_DIR;
  const user = platform.userName;
  if (rule !== 'state-dir' || xdg === undefined || xdg === '' || !isAbsolute(xdg)) return;
  if (user === '' || user.includes('/') || user === '.' || user === '..') return;
  let lingers: boolean;
  try {
    lingers = platform.files.stat(join(LINGER_DIR, user)) !== null;
  } catch {
    return;
  }
  if (!lingers) {
    report(
      'info',
      `XDG_RUNTIME_DIR (${xdg}) is passed over: ${user} does not linger, so systemd would remove it when the last terminal closes (loginctl enable-linger ${user} makes it usable)`,
    );
  }
}

/**
 * Why `serve` would refuse the runtime directory, as prepareRuntimeDir judges it, with nothing
 * created: where it would create the directory or terms/, that part is not judged (null).
 */
function refusalReason(platform: Platform, files: RuntimeFiles): string | null {
  let wouldCreate = false;
  const refuse = (): never => {
    wouldCreate = true;
    throw new Error('doctor creates no runtime directory');
  };
  try {
    prepareRuntimeDir(
      { ...platform, files: { ...platform.files, mkdirp: refuse, chmod: refuse } },
      files,
    );
  } catch (error) {
    if (error instanceof RuntimeDirError && !wouldCreate) return error.reason;
    if (!(error instanceof RuntimeDirError)) throw error;
  }
  return null;
}

/** S2 16.3 vendored files (16.6): every file of vendor/MANIFEST.json there with its hash. */
function checkVendored({ facts }: WindowView, report: Report): void {
  const problems = verifyVendored(facts.platform.files, facts.platform.appRoot);
  if (problems.length === 0) {
    report('ok', 'vendored files match vendor/MANIFEST.json');
    return;
  }
  for (const problem of problems.slice(0, VENDOR_LINES)) {
    report('problem', `vendored files: ${problem} (a broken checkout, S2 16.6)`);
  }
  if (problems.length > VENDOR_LINES) {
    report('problem', `vendored files: and ${problems.length - VENDOR_LINES} more`);
  }
}

/**
 * S2 16.3 keepers: never a problem; counted from their `.pid` lines by design 5.5's rule, with
 * their versions and whether each program was started, and what GET /status adds when a server
 * answers. A `.pid` file that cannot be read is reported on its own (ruled, task 15).
 */
async function checkKeepers(view: WindowView, report: Report): Promise<void> {
  const keepers = view.keepers();
  if (keepers.length === 0) {
    report('info', 'keepers: no terminals in the window');
    return;
  }
  const server = await view.server();
  const shown = new Map(
    answered(server) && server.status !== null
      ? server.status.terminals.map((terminal) => [terminal.id, terminal])
      : [],
  );
  const alive = keepers.filter((k) => k.state === 'alive').length;
  const dead = keepers.filter((k) => k.state === 'dead').length;
  const unknown = keepers.length - alive - dead;
  report(
    'info',
    `keepers: ${alive} running${dead > 0 ? `, ${dead} ended` : ''}${unknown > 0 ? `, ${unknown} cannot be told` : ''}`,
  );
  const { files } = view.runtime();
  for (const { id, line, state } of keepers) {
    if (line === null) {
      report(
        'info',
        `keeper ${id}: ${files.termPid(id)} cannot be read, so whether it runs cannot be told; uninstall --purge refuses while it is there`,
      );
    } else if (state === 'dead') {
      report(
        'info',
        `keeper ${id}: not running; its .pid line is removed at the next server start`,
      );
    } else if (state === 'unknown') {
      report(
        'info',
        `keeper ${id}: whether it runs cannot be told (pid ${line.pid}; the boot id or its /proc entry cannot be read)`,
      );
    } else {
      const keeper = line.keeper;
      const program =
        keeper === undefined
          ? ''
          : `, keeper version ${keeper.version}, its program ${keeper.started ? 'started' : 'not started yet'}`;
      const terminal = shown.get(id);
      const known =
        terminal === undefined
          ? ''
          : `; the server shows it ${terminal.slot === null ? 'without a slot' : `in slot ${terminal.slot}`}, ${terminal.state}${terminal.sessionId === null ? '' : `, session ${terminal.sessionId}`}`;
      report('info', `keeper ${id}: running (pid ${line.pid}${program})${known}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------

function bootIdOf(platform: Platform): string | null {
  try {
    return platform.proc.bootId();
  } catch {
    return null;
  }
}

/** A time in ns as text (a decimal string) as an ISO time; the text itself when it is not one. */
function timeOf(ns: string): string {
  try {
    return /^[0-9]+$/.test(ns) ? isoFromNs(BigInt(ns)) : ns;
  } catch {
    return ns;
  }
}

function nsOf(text: string, fallback: Ns): Ns {
  return /^[0-9]+$/.test(text) ? BigInt(text) : fallback;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A check's `needs` keeps it from running without what it uses. */
function unreachable(): never {
  throw new Error('a window check ran without what it needs');
}
