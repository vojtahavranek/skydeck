/**
 * The runtime directory and what the server keeps in it (S2 4.2): its place (the store's record
 * first, then the rule), its files, the keeper code file (16.5), the removal of dead keepers' files
 * (7.8), `server.json`, the keepers' `.pid` lines, and the `window_server` lock (5.2).
 *
 * Every judgement of a `.pid` line or of the lock's holder is design 5.5's three-valued rule
 * (`pidLineState`): nothing is removed, given up or taken over on 'unknown', only on 'dead'.
 */

import { isAbsolute, join } from 'node:path';

import { SkydeckError } from '../platform/errors.ts';
import { runtimeDirByRule, storeId } from '../platform/paths.ts';
import type { RuntimeRule } from '../platform/paths.ts';
import type { Files, Platform, Proc } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import type { Store } from '../store/store.ts';
import { describeError } from '../sessions/problems.ts';
import { parsePidLine, pidLineState } from './pidline.ts';
import type { PidLine, PidLineState } from './pidline.ts';
import type { NsText } from './protocol.ts';

/** A unix socket path must be shorter than this many bytes (S2 4.2). */
const SOCKET_PATH_LIMIT = 108;
/** A terminal id (contract 2.3, A21): 12 lowercase hex characters. */
const TERMINAL_ID = /^[0-9a-f]{12}$/;
/** A build (S2 16.5, `computeBuild`): one plain name segment, never `.`-led or holding a `/`. */
const BUILD = /^[A-Za-z0-9_-]+$/;
/** A keeper's `.pid` file in `terms/`; temporaries (`.<name>.<random>.tmp`) never match. */
const PID_FILE = /^([0-9a-f]{12})\.pid$/;
/** A keeper's socket in `terms/`. */
const SOCK_FILE = /^([0-9a-f]{12})\.sock$/;
/**
 * A keeper code file as `keeperFile` names it, and the temporary `Files.writeText` writes it
 * through (`.<name>.<12 hex>.tmp`, then renamed) that a write cut short leaves behind: the only
 * names writeKeeperFile creates.
 */
const KEEPER_FILE = /^keeper-[A-Za-z0-9_-]+\.py$/;
const KEEPER_TEMP = /^\.keeper-[A-Za-z0-9_-]+\.py\.[0-9a-f]{12}\.tmp$/;
/** Where systemd marks a user whose runtime directory outlives their last login session. */
const LINGER_DIR = '/var/lib/systemd/linger';

/** The runtime directory cannot be used (S2 5.2: `serve` exits 12). */
export class RuntimeDirError extends SkydeckError {
  readonly dir: string;
  readonly reason: string;
  constructor(dir: string, reason: string) {
    super(`the runtime directory ${dir} cannot be used: ${reason}`);
    this.dir = dir;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------
// The places

export interface RuntimeFiles {
  dir: string;
  serverJson: string;
  serverSock: string;
  serverPid: string;
  keepalivePid: string;
  keepaliveInterop: string;
  interop: string;
  termsDir: string;
  keeperFile(build: string): string;
  termSock(id: string): string;
  termPid(id: string): string;
}

/**
 * Every place of S2 4.2 inside `dir`. `keeperFile`, `termSock` and `termPid` throw for a build or
 * terminal id that is not one, so that no name can lead outside the directory.
 */
export function runtimeFiles(dir: string): RuntimeFiles {
  const termsDir = join(dir, 'terms');
  const term = (id: string, suffix: string): string => {
    if (!TERMINAL_ID.test(id)) {
      throw new Error(`not a terminal id: ${JSON.stringify(id)}`);
    }
    return join(termsDir, `${id}${suffix}`);
  };
  return {
    dir,
    serverJson: join(dir, 'server.json'),
    serverSock: join(dir, 'server.sock'),
    serverPid: join(dir, 'server.pid'),
    keepalivePid: join(dir, 'keepalive.pid'),
    keepaliveInterop: join(dir, 'keepalive.interop'),
    interop: join(dir, 'interop'),
    termsDir,
    keeperFile(build) {
      if (!BUILD.test(build)) {
        throw new Error(`not a build: ${JSON.stringify(build)}`);
      }
      return join(dir, `keeper-${build}.py`);
    },
    termSock: (id) => term(id, '.sock'),
    termPid: (id) => term(id, '.pid'),
  };
}

// ---------------------------------------------------------------------------------------------
// Which directory

/**
 * S2 4.2's check of XDG_RUNTIME_DIR: a directory of the user's, with no group or other bits, and
 * the user lingers (`/var/lib/systemd/linger/<userName>` exists; without it systemd removes the
 * directory, keeper sockets and all, when the last login session ends). A check that cannot be
 * made passes the directory over.
 */
function xdgUsable(platform: Platform, xdgDir: string): boolean {
  try {
    const info = platform.files.stat(xdgDir);
    if (info === null || info.kind !== 'dir' || info.uid !== platform.uid) return false;
    if ((info.mode & 0o077) !== 0) return false;
    const user = platform.userName;
    if (user === '' || user.includes('/') || user === '.' || user === '..') return false;
    return platform.files.stat(join(LINGER_DIR, user)) !== null;
  } catch {
    return false;
  }
}

/** The current boot id; null when it cannot be read (every line is then 'unknown'). */
function currentBootId(proc: Proc): string | null {
  try {
    return proc.bootId();
  } catch {
    return null;
  }
}

/**
 * S2 4.2. 'follow' (commands): the store's record whenever there is one, whatever it holds;
 * runtimeDirByRule only without a record. 'take' (a starting server): the record only when its
 * directory exists and holds a keeper alive by its .pid line, else runtimeDirByRule; then writes
 * kv window_runtime_dir. A record is given up only when every keeper line in it is 'dead': one
 * that cannot be judged ('unknown') keeps it. A record that is not an absolute path is no record.
 */
export function resolveRuntimeDir(
  deck: Deck,
  mode: 'follow' | 'take',
): { dir: string; rule: RuntimeRule | 'record' } {
  const { platform, places, store } = deck;
  const value = store.getKv('window_runtime_dir');
  const record = value !== null && isAbsolute(value) ? value : null;
  if (mode === 'follow' && record !== null) {
    return { dir: record, rule: 'record' };
  }
  if (mode === 'take' && record !== null && holdsKeepers(platform, record)) {
    store.setKv('window_runtime_dir', record);
    return { dir: record, rule: 'record' };
  }
  const chosen = runtimeDirByRule({
    env: platform.env,
    stateDir: places.stateDir,
    storeId: storeId(places.dbPath),
    xdgUsable: (xdgDir) => xdgUsable(platform, xdgDir),
  });
  if (mode === 'take') {
    store.setKv('window_runtime_dir', chosen.dir);
  }
  return chosen;
}

/** Whether `dir` is a directory holding a keeper line that is not known dead. */
function holdsKeepers(platform: Platform, dir: string): boolean {
  if (platform.files.stat(dir)?.kind !== 'dir') return false;
  return listKeeperLines(platform, runtimeFiles(dir)).some((keeper) => keeper.state !== 'dead');
}

// ---------------------------------------------------------------------------------------------
// Preparing it

/**
 * Creates the directory (0o700) and terms/ (0o700); refuses (RuntimeDirError, reason) when it is
 * not the user's, not 0o700, or a socket path would be 108 bytes or more. The socket paths are
 * checked first, so a refused directory is not created. A directory it creates gets exactly
 * 0o700 whatever the umask; an existing one is never changed.
 */
export function prepareRuntimeDir(platform: Platform, files: RuntimeFiles): void {
  // The longest socket path in it is a keeper's: terms/<12 hex>.sock.
  const longest = files.termSock('0'.repeat(12));
  const bytes = Buffer.byteLength(longest);
  if (bytes >= SOCKET_PATH_LIMIT) {
    throw new RuntimeDirError(
      files.dir,
      `a socket path in it would be ${bytes} bytes (terms/<id>.sock); a unix socket path must be shorter than ${SOCKET_PATH_LIMIT} bytes`,
    );
  }
  privateDir(platform, files.dir, files.dir, 'it');
  privateDir(platform, files.dir, files.termsDir, 'terms/');
}

/**
 * Creates `path` with exactly mode 0o700 when it is missing, then checks that it is a directory
 * (not a symbolic link) of the user's with mode 0o700. `subject` names it in the reason.
 */
function privateDir(platform: Platform, runtimeDir: string, path: string, subject: string): void {
  const { files } = platform;
  if (files.lstat(path) === null) {
    try {
      files.mkdirp(path, 0o700);
      files.chmod(path, 0o700);
    } catch (error) {
      throw new RuntimeDirError(
        runtimeDir,
        `${subject} cannot be created (${describeError(error)})`,
      );
    }
  }
  const info = files.lstat(path);
  let reason: string | null = null;
  if (info === null) {
    reason = `${subject} vanished while it was being created`;
  } else if (info.kind === 'symlink') {
    reason = `${subject} is a symbolic link`;
  } else if (info.kind !== 'dir') {
    reason = `${subject} is not a directory`;
  } else if (info.uid !== platform.uid) {
    reason = `${subject} belongs to uid ${info.uid}, not to ${platform.userName} (uid ${platform.uid})`;
  } else if (info.mode !== 0o700) {
    reason = `${subject} has mode ${info.mode.toString(8)}; it must be 700`;
  }
  if (reason !== null) {
    throw new RuntimeDirError(runtimeDir, reason);
  }
}

/**
 * S2 16.5: writes <dir>/keeper-<build>.py (0o600, through a temporary name) and removes the
 * keeper files of other builds, and the temporaries a write of one left behind. A running keeper
 * read its code when it started, so nothing needs those files. Only regular files directly in the
 * runtime directory whose names are of those two forms are removed; anything else stays.
 */
export function writeKeeperFile(
  files: Files,
  runtime: RuntimeFiles,
  build: string,
  code: string,
): void {
  const path = runtime.keeperFile(build);
  files.writeText(path, code, 0o600);
  const own = `keeper-${build}.py`;
  for (const name of files.list(runtime.dir)) {
    const ours = (KEEPER_FILE.test(name) && name !== own) || KEEPER_TEMP.test(name);
    const entry = join(runtime.dir, name);
    if (ours && files.lstat(entry)?.kind === 'file') {
      files.remove(entry);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Keepers by their .pid lines

/**
 * Keepers by their .pid lines (S2 4.2), whatever their state (pidLineState, 2.8), for doctor,
 * uninstall and the server's rediscovery. doctor counts state 'alive'; removeDeadKeeperFiles, the
 * server's rediscovery and `uninstall --purge` act only on 'dead' (purge refuses while any line
 * is 'alive' or 'unknown'). Only regular files `terms/<terminal id>.pid` are read: temporaries,
 * sockets and other names are not lines; a file that does not hold a pid line, or that was removed
 * meanwhile, is skipped. A file that cannot be read (EACCES, EIO …) is a keeper that cannot be
 * judged: `line` null, state 'unknown' (ruled, task 15), and the others are still read. The boot id
 * is read once; when it cannot be read every line is 'unknown'.
 */
export function listKeeperLines(
  platform: Platform,
  files: RuntimeFiles,
): { id: string; line: PidLine | null; state: PidLineState }[] {
  const bootId = currentBootId(platform.proc);
  const found: { id: string; line: PidLine | null; state: PidLineState }[] = [];
  for (const name of platform.files.list(files.termsDir)) {
    const id = PID_FILE.exec(name)?.[1];
    if (id === undefined) continue;
    const path = join(files.termsDir, name);
    if (platform.files.lstat(path)?.kind !== 'file') continue;
    let text: string | null;
    try {
      text = platform.files.readText(path);
    } catch {
      found.push({ id, line: null, state: 'unknown' });
      continue;
    }
    const line = text === null ? null : parsePidLine(text);
    if (line === null) continue;
    found.push({ id, line, state: pidLineState(line, platform.proc, bootId) });
  }
  return found;
}

/**
 * S2 7.8: removes terms/<id>.sock and .pid of keepers whose line is 'dead' (pidLineState, 2.8) or
 * whose socket refuses connections; a line that is 'unknown' never removes anything by itself.
 * A socket is tried only when its line is not 'dead' (a socket without a line, or beside a line
 * that is not a pid line, too), never for a keeper whose .pid file cannot be read (nothing of it
 * is removed), and only ECONNREFUSED is a refusal: a socket whose queue is full
 * (EAGAIN) or that cannot be reached for another reason belongs to a keeper that may live. A
 * directory with such a name is neither tried nor removed. Resolves to the terminal ids whose
 * files it removed, in order.
 */
export async function removeDeadKeeperFiles(
  platform: Platform,
  runtime: RuntimeFiles,
): Promise<string[]> {
  const listed = listKeeperLines(platform, runtime);
  const states = new Map(listed.map((k) => [k.id, k.state]));
  // A keeper whose line cannot be read is never removed, whatever its socket says (ruled).
  const unreadable = new Set(listed.filter((k) => k.line === null).map((k) => k.id));
  const ids = new Set<string>();
  for (const name of platform.files.list(runtime.termsDir)) {
    const id = PID_FILE.exec(name)?.[1] ?? SOCK_FILE.exec(name)?.[1];
    if (id !== undefined) ids.add(id);
  }
  const removed: string[] = [];
  for (const id of [...ids].sort()) {
    if (unreadable.has(id)) continue;
    const sock = runtime.termSock(id);
    const dead =
      states.get(id) === 'dead' ||
      (isNotDir(platform.files, sock) && (await refusesConnections(platform, sock)));
    if (dead) {
      const gone = [sock, runtime.termPid(id)].filter((path) => removeNotDir(platform.files, path));
      if (gone.length > 0) removed.push(id);
    }
  }
  return removed;
}

/** Whether something other than a directory is at `path`. */
function isNotDir(files: Files, path: string): boolean {
  const kind = files.lstat(path)?.kind;
  return kind !== undefined && kind !== 'dir';
}

/** Removes what is at `path` unless it is a directory; whether something was removed. */
function removeNotDir(files: Files, path: string): boolean {
  if (!isNotDir(files, path)) return false;
  files.remove(path);
  return true;
}

/** Whether connecting to the socket at `path` is refused: nothing listens there any more. */
async function refusesConnections(platform: Platform, path: string): Promise<boolean> {
  try {
    const socket = await platform.net.connectUnix(path);
    socket.destroy();
    return false;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'ECONNREFUSED';
  }
}

// ---------------------------------------------------------------------------------------------
// server.json

export interface ServerJson {
  pid: number;
  procStart: number;
  bootId: string;
  port: number;
  serverId: string;
  build: string;
  checkout: string;
  startedAt: NsText;
  envOrigin: { dir: string; atNs: NsText };
}

/** A time in ns as decimal text that fits int64 (the messages' NsText). */
const NS_TEXT = /^(?:0|[1-9][0-9]{0,18})$/;
const INT64_MAX = 9_223_372_036_854_775_807n;

function isNsText(value: unknown): value is string {
  return typeof value === 'string' && NS_TEXT.test(value) && BigInt(value) <= INT64_MAX;
}

function isWhole(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** A token as a pid line holds it: not empty, no whitespace. */
function isToken(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !/\s/.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
}

/** The known fields of `value` when every one is as ServerJson says, else null. */
function asServerJson(value: unknown): ServerJson | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const origin = v.envOrigin;
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) return null;
  const o = origin as Record<string, unknown>;
  if (
    !isWhole(v.pid, 1) ||
    !isWhole(v.procStart, 0) ||
    !isToken(v.bootId) ||
    !isWhole(v.port, 1, 65_535) ||
    !isToken(v.serverId) ||
    !isToken(v.build) ||
    !isAbsolutePath(v.checkout) ||
    !isNsText(v.startedAt) ||
    !isAbsolutePath(o.dir) ||
    !isNsText(o.atNs)
  ) {
    return null;
  }
  return {
    pid: v.pid,
    procStart: v.procStart,
    bootId: v.bootId,
    port: v.port,
    serverId: v.serverId,
    build: v.build,
    checkout: v.checkout,
    startedAt: v.startedAt,
    envOrigin: { dir: o.dir, atNs: o.atNs },
  };
}

/**
 * The running server's record (S2 4.2), or null when the file is missing or does not hold one
 * (not JSON, a field missing or of the wrong form). Fields a newer skydeck adds are ignored. A
 * read error other than "missing" is thrown.
 */
export function readServerJson(files: Files, path: string): ServerJson | null {
  const text = files.readText(path);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return asServerJson(parsed);
}

/** 0o600, atomic (a temporary name, then a rename). Throws for a value readServerJson would refuse. */
export function writeServerJson(files: Files, path: string, value: ServerJson): void {
  const checked = asServerJson(value);
  if (checked === null) {
    throw new Error('not a server.json value');
  }
  files.writeText(path, `${JSON.stringify(checked, null, 2)}\n`, 0o600);
}

// ---------------------------------------------------------------------------------------------
// The window_server lock (S2 5.2): `<pid>:<process start>:<boot id>:<checkout>`

/** The lock's value; the checkout is the rest, so it may hold `:`. */
const LOCK = /^([0-9]+):([0-9]+):([^:\s]+):(\/[^]*)$/;

function parseLock(text: string): { line: PidLine; checkout: string } | null {
  const match = LOCK.exec(text);
  if (match === null) return null;
  const [, pidText = '', startText = '', bootId = '', checkout = ''] = match;
  const pid = Number(pidText);
  const procStart = Number(startText);
  if (!isWhole(pid, 1) || !isWhole(procStart, 0)) return null;
  return { line: { pid, procStart, bootId }, checkout };
}

/**
 * The holder the window_server lock names: its pid line and its checkout; null when the lock is
 * free or holds a value skydeck does not write (it names no server: takeServerLock takes it). The
 * holder is not judged here. A command finds a server that is starting by it (ruled,
 * server-findable): the server takes the lock first and writes server.json only later (S2 5.2).
 */
export function readServerLock(store: Store): { line: PidLine; checkout: string } | null {
  const held = store.getKv('window_server');
  return held === null ? null : parseLock(held);
}

/**
 * S2 5.2: kv window_server in one transaction, taken when the server it names is dead by design
 * 5.5's rule. A holder that cannot be judged ('unknown': the boot id or its /proc entry cannot be
 * read) keeps the lock. A value skydeck does not write (unparseable) names no server and is taken.
 * Throws for a `value` that is not a lock (a pid or process start that is not a whole number, a
 * boot id that is empty or holds `:` or whitespace, a checkout that is not an absolute path).
 */
export function takeServerLock(
  deck: Deck,
  value: { pid: number; procStart: number; bootId: string; checkout: string },
): { taken: true } | { taken: false; holder: { pid: number; checkout: string } } {
  const text = `${value.pid}:${value.procStart}:${value.bootId}:${value.checkout}`;
  const own = parseLock(text);
  if (
    own === null ||
    own.line.pid !== value.pid ||
    own.line.procStart !== value.procStart ||
    own.line.bootId !== value.bootId ||
    own.checkout !== value.checkout ||
    value.checkout.includes('\0')
  ) {
    throw new Error(`not a server lock: ${JSON.stringify(text)}`);
  }
  const { platform, store } = deck;
  return store.transaction(() => {
    const held = store.getKv('window_server');
    const holder = held === null ? null : parseLock(held);
    if (
      holder !== null &&
      pidLineState(holder.line, platform.proc, currentBootId(platform.proc)) !== 'dead'
    ) {
      return { taken: false, holder: { pid: holder.line.pid, checkout: holder.checkout } };
    }
    store.setKv('window_server', text);
    return { taken: true };
  });
}

/**
 * Removes the lock when it names this process (S2 5.5: a server releases its own lock when it
 * stops); a lock another process holds is left as it is.
 */
export function releaseServerLock(deck: Deck): void {
  const { platform, store } = deck;
  store.transaction(() => {
    const held = store.getKv('window_server');
    if (held !== null && parseLock(held)?.line.pid === platform.pid) {
      store.deleteKv('window_server');
    }
  });
}
