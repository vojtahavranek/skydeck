// The runtime directory, its files, server.json and the window_server lock (S2 4.2, 5.2, 7.8,
// 16.5). Tests that judge a real process alive run on realTestPlatform (testDeck real: true); the
// rule's checks run on testPlatform.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import { storeId } from '../../src/platform/paths.ts';
import type { FileInfo, Platform, Proc } from '../../src/platform/types.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { formatPidLine } from '../../src/window/pidline.ts';
import type { PidLine } from '../../src/window/pidline.ts';
import {
  listKeeperLines,
  prepareRuntimeDir,
  readServerJson,
  releaseServerLock,
  removeDeadKeeperFiles,
  resolveRuntimeDir,
  RuntimeDirError,
  runtimeFiles,
  takeServerLock,
  writeKeeperFile,
  writeServerJson,
} from '../../src/window/runtime.ts';
import type { RuntimeFiles, ServerJson } from '../../src/window/runtime.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import { BOOT_A, BOOT_B } from '../helpers/platform.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const ID_A = '0123456789ab';
const ID_B = 'abcdef012345';
const ID_C = 'feedfacecafe';
const BUILD = '0123456789abcdef';
const OTHER_BUILD = 'fedcba9876543210';
const LINGER = '/var/lib/systemd/linger/tester';

// ---------------------------------------------------------------------------------------------
// Helpers

interface Live {
  pid: number;
  procStart: number;
  /** Kills it and waits until Node has reaped it, so that its /proc entry is gone. */
  end: () => Promise<void>;
}

/** The process start (field 22) of a real process, from its /proc/<pid>/stat. */
function procStartOf(proc: Proc, pid: number): number {
  const stat = proc.stat(pid);
  assert.ok(stat !== null, `no /proc/${pid}/stat`);
  const start = procStartFromStat(stat);
  assert.ok(start !== null);
  return start;
}

/** A real `sleep 60` for a pid line or a lock to name; killed through its own handle. */
async function liveSleep(t: TestContext, s: Sandbox, proc: Proc): Promise<Live> {
  s.link('sleep');
  const child: ChildProcess = spawn(join(s.bin, 'sleep'), ['60'], {
    env: s.env(),
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid !== undefined);
  return {
    pid,
    procStart: procStartOf(proc, pid),
    end: async () => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}

function keeperLine(pid: number, procStart: number, bootId: string): PidLine {
  return { pid, procStart, bootId, keeper: { version: '1', started: true } };
}

/** Writes terms/<id>.pid as a keeper would (the test plays the keeper). */
function writePidLine(files: RuntimeFiles, id: string, line: PidLine): void {
  mkdirSync(files.termsDir, { recursive: true, mode: 0o700 });
  writeFileSync(files.termPid(id), formatPidLine(line));
}

/** A socket file whose connect is refused: a second name of a socket whose listener has gone. */
async function refusingSocket(platform: Platform, path: string): Promise<void> {
  const live = `${path}.live`;
  const listener = await platform.net.listenHttp({ path: live }, { request: (_q, r) => r.end() });
  linkSync(live, path);
  await listener.close();
  assert.ok(existsSync(path));
}

/** A socket that accepts connections, closed when the test ends. */
async function listeningSocket(t: TestContext, platform: Platform, path: string): Promise<void> {
  const listener = await platform.net.listenHttp({ path }, { request: (_q, r) => r.end() });
  t.after(() => listener.close());
}

/** `platform` whose files cannot read `unreadable` (EACCES), as a .pid file of another owner. */
function cannotRead(platform: Platform, unreadable: string): Platform {
  const realRead = platform.files.readText.bind(platform.files);
  return {
    ...platform,
    files: {
      ...platform.files,
      readText: (path) => {
        if (path === unreadable) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
            code: 'EACCES',
          });
        }
        return realRead(path);
      },
    },
  };
}

/** The current boot id, which the tests' pid lines carry to be alive. */
function bootOf(proc: Proc): string {
  const id = proc.bootId();
  assert.ok(id !== null);
  return id;
}

/** Every path under `root` (relative), sorted, leaving out `skip` and what is below it. */
function listTree(root: string, skip: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path === skip) {
        continue;
      }
      found.push(relative(root, path));
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) {
        walk(path);
      }
    }
  };
  walk(root);
  return found.sort();
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o7777;
}

function sampleServerJson(): ServerJson {
  return {
    pid: 4242,
    procStart: 51234567,
    bootId: BOOT_A,
    port: 47613,
    serverId: '0011223344556677',
    build: BUILD,
    checkout: '/home/dev/skydeck',
    startedAt: '1794474000000000000',
    envOrigin: { dir: '/home/dev/projects/api', atNs: '1794473990000000000' },
  };
}

// ---------------------------------------------------------------------------------------------
// runtimeFiles

test('runtimeFiles names every place of S2 4.2 inside the directory', () => {
  const files = runtimeFiles('/run/user/1000/skydeck-0a1b2c3d');
  const dir = '/run/user/1000/skydeck-0a1b2c3d';
  assert.equal(files.dir, dir);
  assert.equal(files.serverJson, `${dir}/server.json`);
  assert.equal(files.serverSock, `${dir}/server.sock`);
  assert.equal(files.serverPid, `${dir}/server.pid`);
  assert.equal(files.keepalivePid, `${dir}/keepalive.pid`);
  assert.equal(files.keepaliveInterop, `${dir}/keepalive.interop`);
  assert.equal(files.interop, `${dir}/interop`);
  assert.equal(files.termsDir, `${dir}/terms`);
  assert.equal(files.keeperFile(BUILD), `${dir}/keeper-${BUILD}.py`);
  assert.equal(files.termSock(ID_A), `${dir}/terms/${ID_A}.sock`);
  assert.equal(files.termPid(ID_A), `${dir}/terms/${ID_A}.pid`);
});

test('runtimeFiles refuses an id or a build that would name a file outside its place', () => {
  const files = runtimeFiles('/r');
  for (const bad of ['', '.', '..', '../x', 'a/b', '.hidden', 'a.b', 'a b', 'a\0b']) {
    assert.throws(() => files.termSock(bad), /not a terminal id/, JSON.stringify(bad));
    assert.throws(() => files.termPid(bad), /not a terminal id/, JSON.stringify(bad));
    assert.throws(() => files.keeperFile(bad), /not a build/, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------
// resolveRuntimeDir

test("resolveRuntimeDir 'take' with SKYDECK_HOME gives $SKYDECK_HOME/run and records it", (t) => {
  const d = testDeck(t, { env: { XDG_RUNTIME_DIR: '/run/user/1000' } });

  const got = resolveRuntimeDir(d.deck, 'take');

  const dir = join(d.sandbox.skydeckHome, 'run');
  assert.deepEqual(got, { dir, rule: 'skydeck-home' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), dir);
});

test("resolveRuntimeDir 'take' follows a record whose directory holds a live keeper, whatever the environment", async (t) => {
  const d = testDeck(t, { real: true, env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
  const recorded = join(d.sandbox.root, 'run-of-another-environment');
  const files = runtimeFiles(recorded);
  const keeper = await liveSleep(t, d.sandbox, d.proc);
  writePidLine(files, ID_A, keeperLine(keeper.pid, keeper.procStart, bootOf(d.proc)));
  d.deck.store.setKv('window_runtime_dir', recorded);

  const got = resolveRuntimeDir(d.deck, 'take');

  assert.deepEqual(got, { dir: recorded, rule: 'record' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), recorded);
});

test("resolveRuntimeDir 'take' replaces a record whose directory is missing", (t) => {
  const d = testDeck(t);
  d.deck.store.setKv('window_runtime_dir', join(d.sandbox.root, 'gone'));

  const got = resolveRuntimeDir(d.deck, 'take');

  const dir = join(d.sandbox.skydeckHome, 'run');
  assert.deepEqual(got, { dir, rule: 'skydeck-home' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), dir);
});

test("resolveRuntimeDir 'take' replaces a record whose directory holds only dead lines, or none", async (t) => {
  const d = testDeck(t, { real: true });
  const boot = bootOf(d.proc);
  const recorded = join(d.sandbox.root, 'old-run');
  const files = runtimeFiles(recorded);
  const ended = await liveSleep(t, d.sandbox, d.proc);
  await ended.end();
  const live = await liveSleep(t, d.sandbox, d.proc);
  writePidLine(files, ID_A, keeperLine(ended.pid, ended.procStart, boot)); // its process is gone
  writePidLine(files, ID_B, keeperLine(live.pid, live.procStart, `${boot}-earlier`)); // another boot
  writePidLine(files, ID_C, keeperLine(live.pid, live.procStart + 1, boot)); // the pid was reused
  writeFileSync(join(files.termsDir, 'garbled.pid'), 'not a pid line\n');
  d.deck.store.setKv('window_runtime_dir', recorded);

  const dir = join(d.sandbox.skydeckHome, 'run');
  assert.deepEqual(resolveRuntimeDir(d.deck, 'take'), { dir, rule: 'skydeck-home' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), dir);

  const empty = join(d.sandbox.root, 'empty-run');
  mkdirSync(empty);
  d.deck.store.setKv('window_runtime_dir', empty);
  assert.deepEqual(resolveRuntimeDir(d.deck, 'take'), { dir, rule: 'skydeck-home' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), dir);
});

test("resolveRuntimeDir 'take' keeps a record while a keeper line in it is unknown", async (t) => {
  const d = testDeck(t, { real: true });
  const recorded = join(d.sandbox.root, 'run-unknown');
  const files = runtimeFiles(recorded);
  const live = await liveSleep(t, d.sandbox, d.proc);
  writePidLine(files, ID_A, keeperLine(live.pid, live.procStart, bootOf(d.proc)));
  d.deck.store.setKv('window_runtime_dir', recorded);
  const failingStat = deckWith(d.deck, {
    proc: {
      stat: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    },
  });
  const noBootId = deckWith(d.deck, { proc: { bootId: () => null } });

  assert.deepEqual(resolveRuntimeDir(failingStat, 'take'), { dir: recorded, rule: 'record' });
  assert.deepEqual(resolveRuntimeDir(noBootId, 'take'), { dir: recorded, rule: 'record' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), recorded);
});

test("resolveRuntimeDir 'take' keeps a record while a keeper line in it cannot be read", async (t) => {
  const d = testDeck(t, { real: true });
  const recorded = join(d.sandbox.root, 'run-unreadable');
  const files = runtimeFiles(recorded);
  const ended = await liveSleep(t, d.sandbox, d.proc);
  await ended.end();
  writePidLine(files, ID_A, keeperLine(ended.pid, ended.procStart, bootOf(d.proc))); // dead
  writePidLine(files, ID_B, keeperLine(ended.pid, ended.procStart, bootOf(d.proc))); // unreadable
  d.deck.store.setKv('window_runtime_dir', recorded);
  const deck: Deck = { ...d.deck, platform: cannotRead(d.platform, files.termPid(ID_B)) };

  assert.deepEqual(resolveRuntimeDir(deck, 'take'), { dir: recorded, rule: 'record' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), recorded);
});

test("resolveRuntimeDir 'take' ignores a record that is not an absolute path", (t) => {
  const d = testDeck(t);
  d.deck.store.setKv('window_runtime_dir', 'relative/run');

  const dir = join(d.sandbox.skydeckHome, 'run');
  assert.deepEqual(resolveRuntimeDir(d.deck, 'take'), { dir, rule: 'skydeck-home' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), dir);
});

test("resolveRuntimeDir 'follow' takes a record that is not an absolute path for no record, writing nothing", (t) => {
  const d = testDeck(t);
  const dir = join(d.sandbox.skydeckHome, 'run');
  for (const record of ['relative/run', '']) {
    d.deck.store.setKv('window_runtime_dir', record);

    assert.deepEqual(resolveRuntimeDir(d.deck, 'follow'), { dir, rule: 'skydeck-home' });
    assert.equal(d.deck.store.getKv('window_runtime_dir'), record);
  }
});

test("resolveRuntimeDir 'follow' uses the record whenever there is one, writing nothing", (t) => {
  // No live keeper there (a server without terminals yet) and no XDG_RUNTIME_DIR: still the record.
  const d = testDeck(t, { env: { XDG_RUNTIME_DIR: undefined } });
  const recorded = join(d.sandbox.root, 'run-of-the-server');
  d.deck.store.setKv('window_runtime_dir', recorded);

  const got = resolveRuntimeDir(d.deck, 'follow');

  assert.deepEqual(got, { dir: recorded, rule: 'record' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), recorded);
  assert.equal(existsSync(recorded), false);
  assert.equal(existsSync(join(d.sandbox.skydeckHome, 'run')), false);
});

test("resolveRuntimeDir 'follow' without a record uses the rule and records nothing", (t) => {
  const d = testDeck(t);

  const got = resolveRuntimeDir(d.deck, 'follow');

  assert.deepEqual(got, { dir: join(d.sandbox.skydeckHome, 'run'), rule: 'skydeck-home' });
  assert.equal(d.deck.store.getKv('window_runtime_dir'), null);
  assert.equal(existsSync(got.dir), false);
});

// ---------------------------------------------------------------------------------------------
// The rule's XDG_RUNTIME_DIR check (testPlatform; SKYDECK_HOME unset)

/** A deck without SKYDECK_HOME whose XDG_RUNTIME_DIR is <root>/xdg (mode 0o700, the user's). */
function xdgDeck(t: TestContext): { d: ReturnType<typeof testDeck>; xdg: string } {
  const d = testDeck(t, {
    env: (s) => ({ SKYDECK_HOME: undefined, XDG_RUNTIME_DIR: join(s.root, 'xdg') }),
  });
  const xdg = join(d.sandbox.root, 'xdg');
  mkdirSync(xdg, { mode: 0o700 });
  chmodSync(xdg, 0o700);
  return { d, xdg };
}

/** The deck with `stat` answering `override` for one path and the real answer for the others. */
function statOverride(
  deck: Deck,
  path: string,
  override: (real: FileInfo | null) => FileInfo | null,
): Deck {
  const realStat = deck.platform.files.stat.bind(deck.platform.files);
  return deckWith(deck, {
    files: { stat: (p) => (p === path ? override(realStat(p)) : realStat(p)) },
  });
}

const LINGERING: FileInfo = { size: 0, mtimeNs: 0n, kind: 'file', mode: 0o644, uid: 0 };

test("the rule takes $XDG_RUNTIME_DIR/skydeck-<store id> when it is the user's, mode 700, and the user lingers", (t) => {
  const { d, xdg } = xdgDeck(t);
  const lingering = statOverride(d.deck, LINGER, () => LINGERING);

  const got = resolveRuntimeDir(lingering, 'follow');

  assert.deepEqual(got, {
    dir: join(xdg, `skydeck-${storeId(d.deck.places.dbPath)}`),
    rule: 'xdg-runtime',
  });
});

test('the rule passes over XDG_RUNTIME_DIR when the user does not linger', (t) => {
  const { d } = xdgDeck(t);
  const notLingering = statOverride(d.deck, LINGER, () => null);

  const got = resolveRuntimeDir(notLingering, 'follow');

  assert.deepEqual(got, {
    dir: join(d.deck.places.stateDir, `run-${storeId(d.deck.places.dbPath)}`),
    rule: 'state-dir',
  });
});

test('the rule passes over an XDG_RUNTIME_DIR with group or other bits, of another user, or missing', (t) => {
  const { d, xdg } = xdgDeck(t);
  const stateDir = join(d.deck.places.stateDir, `run-${storeId(d.deck.places.dbPath)}`);
  const lingering = statOverride(d.deck, LINGER, () => LINGERING);

  chmodSync(xdg, 0o750);
  assert.deepEqual(resolveRuntimeDir(lingering, 'follow'), { dir: stateDir, rule: 'state-dir' });
  chmodSync(xdg, 0o701);
  assert.deepEqual(resolveRuntimeDir(lingering, 'follow'), { dir: stateDir, rule: 'state-dir' });

  chmodSync(xdg, 0o700);
  const foreign = statOverride(lingering, xdg, (real) =>
    real === null ? null : { ...real, uid: real.uid + 1 },
  );
  assert.deepEqual(resolveRuntimeDir(foreign, 'follow'), { dir: stateDir, rule: 'state-dir' });

  rmSync(xdg, { recursive: true });
  writeFileSync(xdg, 'a file, not a directory');
  assert.deepEqual(resolveRuntimeDir(lingering, 'follow'), { dir: stateDir, rule: 'state-dir' });
  rmSync(xdg);
  assert.deepEqual(resolveRuntimeDir(lingering, 'follow'), { dir: stateDir, rule: 'state-dir' });
});

test('the rule passes over XDG_RUNTIME_DIR when its check cannot be made', (t) => {
  const { d } = xdgDeck(t);
  const failing = statOverride(d.deck, LINGER, () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  });

  const got = resolveRuntimeDir(failing, 'follow');

  assert.equal(got.rule, 'state-dir');
});

// ---------------------------------------------------------------------------------------------
// S2 4.2 / 17.3: with SKYDECK_HOME set, nothing is created outside it

test('with SKYDECK_HOME set, nothing is created outside it, whatever XDG_RUNTIME_DIR says', async (t) => {
  const xdg = mkdtempSync(join(tmpdir(), 'skydeck-test-xdg-'));
  t.after(() => {
    rmSync(xdg, { recursive: true, force: true });
  });
  chmodSync(xdg, 0o700);
  const d = testDeck(t, { real: true, env: { XDG_RUNTIME_DIR: xdg } });
  const before = listTree(d.sandbox.root, d.sandbox.skydeckHome);

  const { dir } = resolveRuntimeDir(d.deck, 'take');
  const files = runtimeFiles(dir);
  prepareRuntimeDir(d.platform, files);
  writeKeeperFile(d.platform.files, files, BUILD, '# keeper\n');
  writeServerJson(d.platform.files, files.serverJson, sampleServerJson());
  assert.deepEqual(
    takeServerLock(d.deck, {
      pid: process.pid,
      procStart: procStartOf(d.proc, process.pid),
      bootId: bootOf(d.proc),
      checkout: d.platform.appRoot,
    }),
    { taken: true },
  );
  listKeeperLines(d.platform, files);
  await removeDeadKeeperFiles(d.platform, files);
  releaseServerLock(d.deck);

  assert.ok(dir.startsWith(`${d.sandbox.skydeckHome}/`));
  assert.deepEqual(listTree(d.sandbox.root, d.sandbox.skydeckHome), before);
  assert.deepEqual(readdirSync(xdg), []);
});

// ---------------------------------------------------------------------------------------------
// prepareRuntimeDir

test('prepareRuntimeDir creates the directory and terms/ with mode 0o700', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));

  prepareRuntimeDir(d.platform, files);

  assert.equal(modeOf(files.dir), 0o700);
  assert.equal(modeOf(files.termsDir), 0o700);
  prepareRuntimeDir(d.platform, files); // again: nothing to do
  assert.equal(modeOf(files.dir), 0o700);
});

test('prepareRuntimeDir gives a directory it creates exactly 0o700 whatever the umask', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  const old = process.umask(0o277);
  try {
    prepareRuntimeDir(d.platform, files);
  } finally {
    process.umask(old);
  }

  assert.equal(modeOf(files.dir), 0o700);
  assert.equal(modeOf(files.termsDir), 0o700);
});

test('prepareRuntimeDir refuses an existing directory of mode 0o755, naming the mode', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  mkdirSync(files.dir);
  chmodSync(files.dir, 0o755);

  assert.throws(
    () => prepareRuntimeDir(d.platform, files),
    (error: unknown) =>
      error instanceof RuntimeDirError &&
      error.dir === files.dir &&
      /755/.test(error.reason) &&
      error.message === `the runtime directory ${files.dir} cannot be used: ${error.reason}`,
  );
  assert.equal(modeOf(files.dir), 0o755);
  assert.equal(existsSync(files.termsDir), false);
});

test('prepareRuntimeDir refuses an existing terms/ that is not 0o700', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  mkdirSync(files.termsDir, { recursive: true, mode: 0o700 });
  chmodSync(files.dir, 0o700);
  chmodSync(files.termsDir, 0o711);

  assert.throws(
    () => prepareRuntimeDir(d.platform, files),
    (error: unknown) =>
      error instanceof RuntimeDirError && /terms/.test(error.reason) && /711/.test(error.reason),
  );
});

test("prepareRuntimeDir refuses a directory that is not the user's, or not a directory", (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  mkdirSync(files.dir, { mode: 0o700 });
  chmodSync(files.dir, 0o700);
  const realLstat = d.platform.files.lstat.bind(d.platform.files);
  const foreign: Platform = {
    ...d.platform,
    files: {
      ...d.platform.files,
      lstat: (p) => {
        const info = realLstat(p);
        return p === files.dir && info !== null ? { ...info, uid: info.uid + 1 } : info;
      },
    },
  };

  assert.throws(
    () => prepareRuntimeDir(foreign, files),
    (error: unknown) =>
      error instanceof RuntimeDirError &&
      new RegExp(`uid ${d.platform.uid + 1}`).test(error.reason),
  );

  const asFile = runtimeFiles(join(d.sandbox.skydeckHome, 'a-file'));
  writeFileSync(asFile.dir, 'not a directory');
  assert.throws(() => prepareRuntimeDir(d.platform, asFile), RuntimeDirError);

  const asLink = runtimeFiles(join(d.sandbox.skydeckHome, 'a-link'));
  mkdirSync(join(d.sandbox.root, 'elsewhere'), { mode: 0o700 });
  chmodSync(join(d.sandbox.root, 'elsewhere'), 0o700);
  d.platform.files.symlink(join(d.sandbox.root, 'elsewhere'), asLink.dir);
  assert.throws(
    () => prepareRuntimeDir(d.platform, asLink),
    (error: unknown) => error instanceof RuntimeDirError && /symbolic link/.test(error.reason),
  );
});

/** A directory under the sandbox whose longest socket path (terms/<id>.sock) is `bytes` long. */
function dirForSocketPath(s: Sandbox, bytes: number): string {
  // terms/<12 hex>.sock adds 24 bytes; 'é' is two bytes in UTF-8, so bytes are counted, not characters.
  const base = join(s.skydeckHome, 'é');
  const pad = bytes - 24 - Buffer.byteLength(base) - 1;
  assert.ok(pad > 0);
  return join(base, 'x'.repeat(pad));
}

test('prepareRuntimeDir refuses a socket path of 108 bytes, naming the length, and creates nothing', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(dirForSocketPath(d.sandbox, 108));
  assert.equal(Buffer.byteLength(files.termSock(ID_A)), 108);

  assert.throws(
    () => prepareRuntimeDir(d.platform, files),
    (error: unknown) => error instanceof RuntimeDirError && /108 bytes/.test(error.reason),
  );
  assert.equal(existsSync(join(d.sandbox.skydeckHome, 'é')), false);
});

test('prepareRuntimeDir accepts a socket path of 107 bytes', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(dirForSocketPath(d.sandbox, 107));

  prepareRuntimeDir(d.platform, files);

  assert.equal(modeOf(files.termsDir), 0o700);
});

// ---------------------------------------------------------------------------------------------
// writeKeeperFile (S2 16.5)

test("writeKeeperFile writes keeper-<build>.py with mode 0o600 and removes other builds' files", (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  writeFileSync(files.keeperFile(OTHER_BUILD), '# old keeper\n');
  // A temporary a write of Files.writeText left behind: `.<name>.<12 hex>.tmp`.
  writeFileSync(join(files.dir, `.keeper-${OTHER_BUILD}.py.a1b2c3d4e5f6.tmp`), '# half written\n');
  writeFileSync(files.serverJson, '{}');
  writeFileSync(join(files.dir, 'keeper-notes.txt'), 'not a keeper file');

  writeKeeperFile(d.platform.files, files, BUILD, '# keeper v1\n');

  assert.equal(readFileSync(files.keeperFile(BUILD), 'utf8'), '# keeper v1\n');
  assert.equal(modeOf(files.keeperFile(BUILD)), 0o600);
  assert.deepEqual(readdirSync(files.dir).sort(), [
    `keeper-${BUILD}.py`,
    'keeper-notes.txt',
    'server.json',
    'terms',
  ]);
});

test('writeKeeperFile removes only files of the forms it creates: no look-alike, no directory', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const kept = [
    `.keeper-${OTHER_BUILD}.py.a1b2c3.tmp`, // not 12 hex
    `.keeper-${OTHER_BUILD}.py.A1B2C3D4E5F6.tmp`, // not lowercase
    `.keeper-${OTHER_BUILD}.py.a1b2c3d4e5f6.tmp.x`,
    `.keeper-${OTHER_BUILD}.pyc.a1b2c3d4e5f6.tmp`,
    `keeper-${OTHER_BUILD}.py.bak`,
    `xkeeper-${OTHER_BUILD}.py`,
  ];
  for (const name of kept) {
    writeFileSync(join(files.dir, name), 'not one of its files');
  }
  mkdirSync(join(files.dir, `keeper-${OTHER_BUILD}.py`)); // a directory, not a file it wrote
  mkdirSync(join(files.dir, `.keeper-${OTHER_BUILD}.py.0123456789ab.tmp`));
  d.platform.files.symlink(join(d.sandbox.root, 'elsewhere'), files.keeperFile('linkbuild'));

  writeKeeperFile(d.platform.files, files, BUILD, '# keeper v1\n');

  assert.deepEqual(
    readdirSync(files.dir).sort(),
    [
      ...kept,
      `.keeper-${OTHER_BUILD}.py.0123456789ab.tmp`,
      `keeper-${BUILD}.py`,
      `keeper-${OTHER_BUILD}.py`,
      'keeper-linkbuild.py',
      'terms',
    ].sort(),
  );
});

test("writeKeeperFile keeps the current build's file, replacing its content", (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  writeFileSync(files.keeperFile(BUILD), '# before\n', { mode: 0o644 });

  writeKeeperFile(d.platform.files, files, BUILD, '# after\n');

  assert.equal(readFileSync(files.keeperFile(BUILD), 'utf8'), '# after\n');
  assert.equal(modeOf(files.keeperFile(BUILD)), 0o600);
  assert.deepEqual(readdirSync(files.dir).sort(), [`keeper-${BUILD}.py`, 'terms']);
});

// ---------------------------------------------------------------------------------------------
// listKeeperLines

test('listKeeperLines reads every terms/<id>.pid with its state, ignoring other files and temporaries', async (t) => {
  const d = testDeck(t, { real: true });
  const boot = bootOf(d.proc);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const live = await liveSleep(t, d.sandbox, d.proc);
  const alive = keeperLine(live.pid, live.procStart, boot);
  const dead = keeperLine(live.pid, live.procStart, `${boot}-earlier`);
  writePidLine(files, ID_A, alive);
  writePidLine(files, ID_B, dead);
  writeFileSync(join(files.termsDir, `.${ID_C}.pid.4f2a.tmp`), formatPidLine(alive));
  writeFileSync(join(files.termsDir, `${ID_C}.pid.tmp`), formatPidLine(alive));
  writeFileSync(join(files.termsDir, `${ID_C}.sock`), '');
  writeFileSync(join(files.termsDir, 'notes.txt'), formatPidLine(alive));
  writeFileSync(join(files.termsDir, 'notanid.pid'), formatPidLine(alive)); // not a terminal id
  writeFileSync(files.termPid('c0ffee000000'), 'not a pid line\n');
  writeFileSync(files.termPid('c0ffee000001'), '');
  mkdirSync(files.termPid('c0ffee000002'));
  d.platform.files.symlink(files.termPid(ID_A), files.termPid('c0ffee000003'));

  const lines = listKeeperLines(d.platform, files);

  assert.deepEqual(lines, [
    { id: ID_A, line: alive, state: 'alive' },
    { id: ID_B, line: dead, state: 'dead' },
  ]);
});

test('listKeeperLines gives a .pid file it cannot read as a line it cannot judge, and goes on', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const line = keeperLine(4242, 51234567, BOOT_A);
  writePidLine(files, ID_A, line);
  writePidLine(files, ID_B, line);

  const got = listKeeperLines(cannotRead(d.platform, files.termPid(ID_A)), files);

  assert.deepEqual(got, [
    { id: ID_A, line: null, state: 'unknown' },
    { id: ID_B, line, state: 'dead' }, // no process 4242 on the fake /proc
  ]);
});

test('listKeeperLines gives unknown when the boot id or /proc cannot be read, and [] without terms/', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  assert.deepEqual(listKeeperLines(d.platform, files), []);
  prepareRuntimeDir(d.platform, files);
  const line = keeperLine(4242, 51234567, BOOT_A);
  writePidLine(files, ID_A, line);

  d.proc.setBootId(null);
  assert.deepEqual(listKeeperLines(d.platform, files), [{ id: ID_A, line, state: 'unknown' }]);
  const throwing = deckWith(d.deck, {
    proc: {
      bootId: () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    },
  });
  assert.deepEqual(listKeeperLines(throwing.platform, files), [
    { id: ID_A, line, state: 'unknown' },
  ]);
});

// ---------------------------------------------------------------------------------------------
// removeDeadKeeperFiles (S2 7.8)

test('removeDeadKeeperFiles removes the socket and pid line of dead keepers and keeps live ones', async (t) => {
  const d = testDeck(t, { real: true });
  const boot = bootOf(d.proc);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const live = await liveSleep(t, d.sandbox, d.proc);
  const ended = await liveSleep(t, d.sandbox, d.proc);
  await ended.end();
  writePidLine(files, ID_A, keeperLine(live.pid, live.procStart, boot));
  await listeningSocket(t, d.platform, files.termSock(ID_A));
  writePidLine(files, ID_B, keeperLine(ended.pid, ended.procStart, boot));
  writeFileSync(files.termSock(ID_B), ''); // its socket file, left behind
  writePidLine(files, ID_C, keeperLine(live.pid, live.procStart, `${boot}-earlier`));

  const removed = await removeDeadKeeperFiles(d.platform, files);

  assert.deepEqual(removed, [ID_B, ID_C]);
  assert.deepEqual(readdirSync(files.termsDir).sort(), [`${ID_A}.pid`, `${ID_A}.sock`]);
});

test('removeDeadKeeperFiles removes a socket that refuses connections and its pid line', async (t) => {
  const d = testDeck(t, { real: true });
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const live = await liveSleep(t, d.sandbox, d.proc);
  writePidLine(files, ID_A, keeperLine(live.pid, live.procStart, bootOf(d.proc)));
  await refusingSocket(d.platform, files.termSock(ID_A));
  await refusingSocket(d.platform, files.termSock(ID_B)); // no pid line at all
  writeFileSync(files.termPid(ID_C), 'garbled\n');
  await refusingSocket(d.platform, files.termSock(ID_C));

  const removed = await removeDeadKeeperFiles(d.platform, files);

  assert.deepEqual(removed, [ID_A, ID_B, ID_C]);
  assert.deepEqual(
    readdirSync(files.termsDir).filter((name) => !name.endsWith('.live')),
    [],
  );
});

test('removeDeadKeeperFiles removes nothing for a line it cannot judge whose socket does not refuse', async (t) => {
  const d = testDeck(t, { real: true });
  const boot = bootOf(d.proc);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const live = await liveSleep(t, d.sandbox, d.proc);
  writePidLine(files, ID_A, keeperLine(live.pid, live.procStart, boot)); // no socket yet
  writePidLine(files, ID_B, keeperLine(live.pid, live.procStart, boot));
  await listeningSocket(t, d.platform, files.termSock(ID_B));
  writeFileSync(files.termPid(ID_C), 'garbled\n'); // no socket
  const unreadable: Platform = {
    ...d.platform,
    proc: {
      ...d.platform.proc,
      stat: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    },
  };
  const noBoot: Platform = { ...d.platform, proc: { ...d.platform.proc, bootId: () => null } };

  assert.deepEqual(await removeDeadKeeperFiles(unreadable, files), []);
  assert.deepEqual(await removeDeadKeeperFiles(noBoot, files), []);
  assert.deepEqual(await removeDeadKeeperFiles(d.platform, files), []);
  assert.deepEqual(readdirSync(files.termsDir).sort(), [
    `${ID_A}.pid`,
    `${ID_B}.pid`,
    `${ID_B}.sock`,
    `${ID_C}.pid`,
  ]);
});

test('removeDeadKeeperFiles removes the files of an unknown line whose socket refuses', async (t) => {
  const d = testDeck(t, { real: true });
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  writePidLine(files, ID_A, keeperLine(4242, 51234567, BOOT_A));
  await refusingSocket(d.platform, files.termSock(ID_A));
  const noBoot: Platform = { ...d.platform, proc: { ...d.platform.proc, bootId: () => null } };

  assert.deepEqual(await removeDeadKeeperFiles(noBoot, files), [ID_A]);
  assert.equal(existsSync(files.termPid(ID_A)), false);
  assert.equal(existsSync(files.termSock(ID_A)), false);
});

test('removeDeadKeeperFiles counts only ECONNREFUSED as a refusal: a full or unreachable socket removes nothing', async (t) => {
  const d = testDeck(t, { real: true });
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const live = await liveSleep(t, d.sandbox, d.proc);
  writePidLine(files, ID_A, keeperLine(live.pid, live.procStart, bootOf(d.proc)));
  writeFileSync(files.termSock(ID_A), ''); // its socket file
  writeFileSync(files.termSock(ID_B), ''); // a socket without a line
  const all = readdirSync(files.termsDir).sort();

  for (const code of ['EAGAIN', 'EACCES', 'ETIMEDOUT', 'ENOENT', 'EMFILE']) {
    const connectUnix = (): Promise<never> =>
      Promise.reject(Object.assign(new Error(code), { code }));
    const failing: Platform = { ...d.platform, net: { ...d.platform.net, connectUnix } };
    const failingUnknown: Platform = { ...failing, proc: { ...failing.proc, bootId: () => null } };

    assert.deepEqual(await removeDeadKeeperFiles(failing, files), [], code); // alive line
    assert.deepEqual(await removeDeadKeeperFiles(failingUnknown, files), [], code); // unknown line
    assert.deepEqual(readdirSync(files.termsDir).sort(), all, code);
  }
});

test('removeDeadKeeperFiles leaves a directory named like a socket or a pid line, and goes on', async (t) => {
  const d = testDeck(t, { real: true });
  const boot = bootOf(d.proc);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const ended = await liveSleep(t, d.sandbox, d.proc);
  await ended.end();
  writePidLine(files, ID_A, keeperLine(ended.pid, ended.procStart, boot)); // dead
  mkdirSync(files.termSock(ID_A));
  mkdirSync(files.termSock(ID_B)); // a directory alone
  mkdirSync(files.termPid(ID_C));
  await refusingSocket(d.platform, files.termSock(ID_C));

  const removed = await removeDeadKeeperFiles(d.platform, files);

  assert.deepEqual(removed, [ID_A, ID_C]);
  assert.deepEqual(readdirSync(files.termsDir).sort(), [
    `${ID_A}.sock`,
    `${ID_B}.sock`,
    `${ID_C}.pid`,
  ]);
});

test('an unreadable .pid beside a live and a dead keeper: the dead removed, the live found, the unreadable unknown and kept', async (t) => {
  const d = testDeck(t, { real: true });
  const boot = bootOf(d.proc);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const live = await liveSleep(t, d.sandbox, d.proc);
  const ended = await liveSleep(t, d.sandbox, d.proc);
  await ended.end();
  const alive = keeperLine(live.pid, live.procStart, boot);
  writePidLine(files, ID_A, alive);
  await listeningSocket(t, d.platform, files.termSock(ID_A));
  writePidLine(files, ID_B, keeperLine(ended.pid, ended.procStart, boot));
  writeFileSync(files.termSock(ID_B), '');
  writePidLine(files, ID_C, alive);
  writeFileSync(files.termSock(ID_C), '');
  const platform = cannotRead(d.platform, files.termPid(ID_C));

  const before = listKeeperLines(platform, files);
  const removed = await removeDeadKeeperFiles(platform, files);

  assert.deepEqual(
    before.map((k) => [k.id, k.state, k.line === null]),
    [
      [ID_A, 'alive', false],
      [ID_B, 'dead', false],
      [ID_C, 'unknown', true],
    ],
  );
  assert.deepEqual(removed, [ID_B]);
  assert.deepEqual(readdirSync(files.termsDir).sort(), [
    `${ID_A}.pid`,
    `${ID_A}.sock`,
    `${ID_C}.pid`,
    `${ID_C}.sock`,
  ]);
  assert.deepEqual(listKeeperLines(platform, files), [
    { id: ID_A, line: alive, state: 'alive' },
    { id: ID_C, line: null, state: 'unknown' },
  ]);
});

test('removeDeadKeeperFiles removes nothing of a keeper whose .pid file cannot be read, even when its socket refuses', async (t) => {
  const d = testDeck(t, { real: true });
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  writePidLine(files, ID_A, keeperLine(4242, 51234567, BOOT_A));
  await refusingSocket(d.platform, files.termSock(ID_A));
  writePidLine(files, ID_B, keeperLine(4242, 51234567, `${bootOf(d.proc)}-earlier`)); // dead

  const removed = await removeDeadKeeperFiles(cannotRead(d.platform, files.termPid(ID_A)), files);

  assert.deepEqual(removed, [ID_B]);
  assert.deepEqual(readdirSync(files.termsDir).sort(), [`${ID_A}.pid`, `${ID_A}.sock`]);
});

test('removeDeadKeeperFiles of a directory without terms/ removes nothing', async (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));

  assert.deepEqual(await removeDeadKeeperFiles(d.platform, files), []);
});

// ---------------------------------------------------------------------------------------------
// server.json

test('server.json: a round trip, mode 0o600, through a temporary name', (t) => {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const value = sampleServerJson();

  writeServerJson(d.platform.files, files.serverJson, value);

  assert.deepEqual(readServerJson(d.platform.files, files.serverJson), value);
  assert.equal(modeOf(files.serverJson), 0o600);
  assert.deepEqual(readdirSync(files.dir).sort(), ['server.json', 'terms']);
  writeServerJson(d.platform.files, files.serverJson, { ...value, port: 47614 });
  assert.equal(readServerJson(d.platform.files, files.serverJson)?.port, 47614);
});

test('readServerJson gives null for a missing file, garbage, and a value of the wrong shape', (t) => {
  const d = testDeck(t);
  const path = join(d.sandbox.root, 'server.json');
  const read = (text: string): ServerJson | null => {
    writeFileSync(path, text);
    return readServerJson(d.platform.files, path);
  };
  const good = sampleServerJson();

  assert.equal(readServerJson(d.platform.files, path), null);
  assert.equal(read(''), null);
  assert.equal(read('{"pid": 4242'), null);
  assert.equal(read('null'), null);
  assert.equal(read('[]'), null);
  assert.equal(read('"server"'), null);
  const broken: Record<string, unknown>[] = [
    { pid: 0 },
    { pid: 1.5 },
    { pid: '4242' },
    { procStart: -1 },
    { bootId: '' },
    { bootId: 'a b' },
    { port: 0 },
    { port: 65536 },
    { serverId: '' },
    { serverId: 7 },
    { build: '' },
    { checkout: 'relative' },
    { startedAt: 1794474000000000000 },
    { startedAt: '-1' },
    { startedAt: '01' },
    { startedAt: '99999999999999999999' },
    { envOrigin: null },
    { envOrigin: { dir: 'relative', atNs: '1' } },
    { envOrigin: { dir: '/x', atNs: 'soon' } },
  ];
  for (const change of broken) {
    assert.equal(read(JSON.stringify({ ...good, ...change })), null, JSON.stringify(change));
  }
  const { port: _port, ...withoutPort } = good;
  assert.equal(read(JSON.stringify(withoutPort)), null);
  assert.deepEqual(read(JSON.stringify({ ...good, later: 'a field of a newer skydeck' })), good);
});

test('writeServerJson refuses a value that readServerJson would not read back', (t) => {
  const d = testDeck(t);
  const path = join(d.sandbox.root, 'server.json');

  assert.throws(() => writeServerJson(d.platform.files, path, { ...sampleServerJson(), pid: 0 }));
  assert.equal(existsSync(path), false);
});

// ---------------------------------------------------------------------------------------------
// The window_server lock (S2 5.2)

function lockValue(pid: number, procStart: number, bootId: string, checkout: string) {
  return { pid, procStart, bootId, checkout };
}

test('takeServerLock takes a free lock and stores <pid>:<process start>:<boot id>:<checkout>', (t) => {
  const d = testDeck(t);

  const got = takeServerLock(d.deck, lockValue(4000, 123, BOOT_A, '/home/dev/skydeck'));

  assert.deepEqual(got, { taken: true });
  assert.equal(d.deck.store.getKv('window_server'), `4000:123:${BOOT_A}:/home/dev/skydeck`);
});

test('takeServerLock refuses while a live process holds the lock, naming it', async (t) => {
  const d = testDeck(t, { real: true });
  const holder = await liveSleep(t, d.sandbox, d.proc);
  const held = `${holder.pid}:${holder.procStart}:${bootOf(d.proc)}:/opt/other-checkout`;
  d.deck.store.setKv('window_server', held);

  const got = takeServerLock(
    d.deck,
    lockValue(process.pid, procStartOf(d.proc, process.pid), bootOf(d.proc), '/home/dev/skydeck'),
  );

  assert.deepEqual(got, {
    taken: false,
    holder: { pid: holder.pid, checkout: '/opt/other-checkout' },
  });
  assert.equal(d.deck.store.getKv('window_server'), held);
});

test('takeServerLock refuses while another connection holds the lock for a live process', (t) => {
  const d = testDeck(t, { real: true });
  const other = openDeck(d.platform);
  t.after(() => {
    other.store.close();
  });
  const mine = lockValue(process.pid, procStartOf(d.proc, process.pid), bootOf(d.proc), '/a/b');

  assert.deepEqual(takeServerLock(other, mine), { taken: true });
  assert.deepEqual(takeServerLock(d.deck, { ...mine, checkout: '/c/d' }), {
    taken: false,
    holder: { pid: process.pid, checkout: '/a/b' },
  });
});

test('takeServerLock takes over a lock whose holder is dead, reused or of another boot', async (t) => {
  const d = testDeck(t, { real: true });
  const boot = bootOf(d.proc);
  const ended = await liveSleep(t, d.sandbox, d.proc);
  await ended.end();
  const live = await liveSleep(t, d.sandbox, d.proc);
  const mine = lockValue(process.pid, procStartOf(d.proc, process.pid), boot, '/home/dev/skydeck');
  const mineText = `${mine.pid}:${mine.procStart}:${boot}:/home/dev/skydeck`;

  for (const stale of [
    `${ended.pid}:${ended.procStart}:${boot}:/x`, // gone
    `${live.pid}:${live.procStart + 1}:${boot}:/x`, // the pid was reused
    `${live.pid}:${live.procStart}:${boot}-earlier:/x`, // another boot
    'garbage', // no lock skydeck writes
    `0:1:${boot}:/x`,
  ]) {
    d.deck.store.setKv('window_server', stale);
    assert.deepEqual(takeServerLock(d.deck, mine), { taken: true }, stale);
    assert.equal(d.deck.store.getKv('window_server'), mineText);
  }
});

test('takeServerLock does not take over a lock whose holder it cannot judge', (t) => {
  const d = testDeck(t, { real: true });
  const held = `4242:51234567:${BOOT_B}:/opt/other`;
  const mine = lockValue(process.pid, procStartOf(d.proc, process.pid), bootOf(d.proc), '/a');
  const unreadable = deckWith(d.deck, {
    proc: {
      bootId: () => BOOT_B,
      stat: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    },
  });
  const noBoot = deckWith(d.deck, { proc: { bootId: () => null } });
  const bootThrows = deckWith(d.deck, {
    proc: {
      bootId: () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    },
  });

  for (const deck of [unreadable, noBoot, bootThrows]) {
    d.deck.store.setKv('window_server', held);
    assert.deepEqual(takeServerLock(deck, mine), {
      taken: false,
      holder: { pid: 4242, checkout: '/opt/other' },
    });
    assert.equal(d.deck.store.getKv('window_server'), held);
  }
});

test('takeServerLock refuses a value that is not a lock', (t) => {
  const d = testDeck(t);
  for (const bad of [
    lockValue(0, 1, BOOT_A, '/a'),
    lockValue(1, -1, BOOT_A, '/a'),
    lockValue(1, 1, 'a:b', '/a'),
    lockValue(1, 1, '', '/a'),
    lockValue(1, 1, BOOT_A, 'relative'),
  ]) {
    assert.throws(() => takeServerLock(d.deck, bad), JSON.stringify(bad));
  }
  assert.equal(d.deck.store.getKv('window_server'), null);
});

test("releaseServerLock removes the lock this process holds and leaves another's", (t) => {
  const d = testDeck(t);
  takeServerLock(d.deck, lockValue(d.platform.pid, 1, BOOT_A, '/a'));

  releaseServerLock(d.deck);
  assert.equal(d.deck.store.getKv('window_server'), null);

  releaseServerLock(d.deck); // nothing held: nothing to do
  const another = `${d.platform.pid + 1}:1:${BOOT_A}:/b`;
  d.deck.store.setKv('window_server', another);
  releaseServerLock(d.deck);
  assert.equal(d.deck.store.getKv('window_server'), another);
});

// Several servers taking the lock at the same moment against one database: exactly one wins.

const CHILD = fileURLToPath(new URL('../fixtures/server-lock-child.ts', import.meta.url));
const RACERS = 5;
const ROUNDS = 15;

function lineReader(child: ChildProcessWithoutNullStreams): () => Promise<string> {
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let closed = false;
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const waiter = waiting.shift();
    if (waiter === undefined) {
      queued.push(line);
    } else {
      waiter(line);
    }
  });
  reader.on('close', () => {
    closed = true;
    for (const waiter of waiting.splice(0)) {
      waiter('closed');
    }
  });
  return () =>
    new Promise((resolve) => {
      const line = queued.shift();
      if (line !== undefined) {
        resolve(line);
      } else if (closed) {
        resolve('closed');
      } else {
        waiting.push(resolve);
      }
    });
}

test('the lock fixture refuses to run outside a test sandbox, creating nothing', async (t) => {
  const d = testDeck(t, { real: true });
  const before = listTree(d.sandbox.root, '');

  for (const env of [
    d.sandbox.env({ SKYDECK_HOME: undefined }),
    d.sandbox.env({ SKYDECK_HOME: 'relative' }),
    d.sandbox.env({ SKYDECK_TEST_NO_WINDOWS: undefined }),
  ]) {
    const child = spawn(process.execPath, [CHILD], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const [code] = (await once(child, 'close')) as [number | null];
    assert.deepEqual({ code, stdout }, { code: 2, stdout: '' });
  }
  assert.deepEqual(listTree(d.sandbox.root, ''), before);
});

test('servers taking the lock at once: exactly one gets it, every round, free or stale', async (t) => {
  const d = testDeck(t, { real: true });
  const children: { process: ChildProcessWithoutNullStreams; next: () => Promise<string> }[] = [];
  t.after(() => {
    for (const child of children) {
      child.process.kill('SIGKILL');
    }
  });
  for (let i = 0; i < RACERS; i++) {
    const child = spawn(process.execPath, [CHILD], {
      env: d.sandbox.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const next = lineReader(child);
    children.push({ process: child, next });
    assert.equal(await next(), 'ready', stderr);
  }
  const childPids = children.map((child) => child.process.pid);

  for (let round = 1; round <= ROUNDS; round++) {
    if (round % 2 === 0) {
      // A lock a crashed server left in an earlier boot: every racer may take it over.
      d.deck.store.setKv('window_server', `4242:1:${bootOf(d.proc)}-earlier:/old`);
    } else {
      d.deck.store.deleteKv('window_server');
    }
    for (const child of children) {
      child.process.stdin.write(`/checkout/${round}\n`);
    }
    const answers = await Promise.all(children.map((child) => child.next()));
    const winners = answers.filter((answer) => answer === 'taken');
    assert.equal(winners.length, 1, `round ${round}: ${answers.join(', ')}`);
    const held = d.deck.store.getKv('window_server');
    const winner = childPids[answers.indexOf('taken')];
    assert.ok(held?.startsWith(`${winner}:`), `round ${round}: ${held}`);
    for (const answer of answers.filter((a) => a !== 'taken')) {
      assert.equal(answer, `refused ${winner} /checkout/${round}`, `round ${round}`);
    }
  }

  for (const child of children) {
    child.process.stdin.end();
  }
  assert.deepEqual(
    await Promise.all(children.map((child) => child.next())),
    Array<string>(RACERS).fill('closed'),
  );
});
