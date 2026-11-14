// `skydeck uninstall [--purge]` as the window changes it (S2 16.2): a running server is stopped
// as `skydeck window --stop` stops it, the line says how many terminals keep running, keepers are
// never stopped or connected to; the Edge profile folder is named when it exists (ruled by the plan
// owner, task 24); `--purge` refuses while a keeper may live in any directory that can be the
// runtime directory, and otherwise removes those directories too. The server is the fake serve
// of task 22, started by the test; keepers are `.pid` lines naming processes the test started.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { storeId } from '../../../src/platform/paths.ts';
import type { Platform } from '../../../src/platform/types.ts';
import { runtimeFiles } from '../../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../../src/window/runtime.ts';
import { claudeFolders, run, settingsFile } from '../../helpers/install.ts';
import {
  WINDOWS_USER,
  countingSocket,
  endedLine,
  guardedProcesses,
  liveProcess,
  noLine,
  runOn,
  startFakeServe,
  stillRuns,
  windowMachine,
  writeKeeperLine,
} from '../../helpers/window-machine.ts';
import type { Lines, MachineOptions, Owned, WindowMachine } from '../../helpers/window-machine.ts';

const ID_A = 'aaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbb';
const ID_C = 'cccccccccccc';
/** Long enough for the fake serve to end after POST /shutdown on a loaded machine. */
const EXIT_MS = 30_000;

/** An installed machine (the hook entries and links of step 1). */
async function installed(t: TestContext, options: MachineOptions = {}): Promise<WindowMachine> {
  const m = windowMachine(t, options);
  claudeFolders(m.places);
  const r = await run(m.platform, ['install'], { lines: ['y'] });
  assert.equal(r.code, 0, r.stderr);
  return m;
}

/** `skydeck uninstall` with `args`; it may signal only `allowed` (processes the test started). */
async function uninstall(
  m: WindowMachine,
  args: string[] = [],
  allowed: () => readonly number[] = () => [],
  override: Partial<Platform> = {},
): Promise<Lines & { signalled: number[] }> {
  const processes = guardedProcesses(m.processes, allowed);
  const r = await runOn(m, ['uninstall', ...args], { processes, ...override });
  assert.deepEqual(processes.started, [], 'uninstall starts nothing');
  return { ...r, signalled: processes.signalled };
}

async function ended(owned: Owned): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    owned.exited,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the server did not end')), EXIT_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** The settings file still holds the hook entries install wrote. */
function stillInstalled(m: WindowMachine): void {
  assert.match(readFileSync(settingsFile(m.places), 'utf8'), /skydeck-hook/);
  assert.ok(existsSync(m.places.hookPath));
  for (const dir of [m.places.dataDir, m.places.stateDir, m.places.configDir]) {
    assert.ok(existsSync(dir), dir);
  }
}

/** The runtime directory files of `dir`, with terms/ made as a server makes it. */
function runtimeAt(dir: string): RuntimeFiles {
  const files = runtimeFiles(dir);
  for (const path of [files.dir, files.termsDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// The server

describe('uninstall: the server', () => {
  test('a running server is stopped; the line counts the terminals that keep running; keepers live on', async (t) => {
    const m = await installed(t);
    const fake = await startFakeServe(t, m);
    const files = m.runtime();
    const a = await liveProcess(t, m);
    const b = await liveProcess(t, m);
    writeKeeperLine(files, ID_A, a.line);
    writeKeeperLine(files, ID_B, b.line, false);
    writeKeeperLine(files, ID_C, await endedLine(t, m));

    const r = await uninstall(m, [], () => [fake.pid]);

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.lines.includes("stopped skydeck's window server; 2 terminals in the window keep running"),
      r.stdout,
    );
    await ended(fake);
    assert.deepEqual(r.signalled, [], 'a server that answers is asked to stop, not signalled');
    assert.ok(stillRuns(m, a) && stillRuns(m, b), 'keepers are never stopped');
    assert.ok(existsSync(files.termPid(ID_A)) && existsSync(files.termPid(ID_B)));
    // And then step 1's uninstall: the settings file install made is gone again.
    assert.equal(existsSync(settingsFile(m.places)), false);
  });

  test('one terminal: the line says so in the singular', async (t) => {
    const m = await installed(t);
    const fake = await startFakeServe(t, m);
    writeKeeperLine(m.runtime(), ID_A, (await liveProcess(t, m)).line);

    const r = await uninstall(m, [], () => [fake.pid]);

    assert.ok(
      r.lines.includes("stopped skydeck's window server; 1 terminal in the window keeps running"),
      r.stdout,
    );
  });

  test('no server: no line, and nothing is signalled', async (t) => {
    const m = await installed(t);
    writeKeeperLine(m.makeRuntime(), ID_A, (await liveProcess(t, m)).line);

    const r = await uninstall(m);

    assert.equal(r.code, 0, r.stderr);
    noLine(r, /window server/);
    assert.deepEqual(r.signalled, []);
  });

  test('a server that cannot be stopped is an error, and step 1 undoes nothing', async (t) => {
    const m = await installed(t);
    // A server.json naming a process that cannot be judged: stopServer refuses (S2 5.5).
    const fake = await startFakeServe(t, m);

    const r = await uninstall(m, [], () => [], {
      proc: { ...m.platform.proc, bootId: () => null },
    });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot tell whether the window's server/);
    assert.ok(stillRuns(m, fake));
    stillInstalled(m);
  });
});

// ---------------------------------------------------------------------------------------------
// The Edge profile folder (S2 5.4)

describe('uninstall: the Edge profile folder', () => {
  const LINE = (folder: string): string =>
    `the window's Edge profile is in ${folder}; Edge wrote it and skydeck leaves it (delete it yourself)`;

  test('derived, and there: named; --purge leaves it', async (t) => {
    const m = await installed(t);
    assert.ok(m.drive !== null);
    const folder = join(
      m.drive,
      'Users',
      WINDOWS_USER,
      'AppData',
      'Local',
      'skydeck',
      'edge-profile',
    );
    mkdirSync(folder, { recursive: true });

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.lines.includes(LINE('C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile')),
      r.stdout,
    );
    assert.ok(existsSync(folder));
  });

  test('derived but never written by Edge: no line', async (t) => {
    const m = await installed(t);

    const r = await uninstall(m);

    noLine(r, /Edge profile/);
  });

  test('configured, and there: named as configured', async (t) => {
    const m = await installed(t, { window: { profileDir: 'C:\\Users\\other\\prof' } });
    assert.ok(m.drive !== null);
    mkdirSync(join(m.drive, 'Users', 'other', 'prof'), { recursive: true });

    const r = await uninstall(m);

    assert.ok(r.lines.includes(LINE('C:\\Users\\other\\prof')), r.stdout);
  });

  test('no C: drive: no line', async (t) => {
    const m = await installed(t, { drive: false });

    noLine(await uninstall(m), /Edge profile/);
  });
});

// ---------------------------------------------------------------------------------------------
// --purge

describe('uninstall --purge', () => {
  /** Every directory that can be the runtime directory of the machine (S2 16.2). */
  function candidates(m: WindowMachine): { name: string; dir: string; record?: boolean }[] {
    const id = storeId(m.places.dbPath);
    return [
      { name: 'recorded', dir: join(m.s.root, 'recorded-run'), record: true },
      { name: '$SKYDECK_HOME/run', dir: join(m.s.skydeckHome, 'run') },
      { name: '$XDG_RUNTIME_DIR', dir: join(m.s.root, 'xdg', `skydeck-${id}`) },
      { name: '<stateDir>/run-<id>', dir: join(m.places.stateDir, `run-${id}`) },
    ];
  }

  const xdg = { env: (s: { root: string }) => ({ XDG_RUNTIME_DIR: join(s.root, 'xdg') }) };

  for (const index of [0, 1, 2, 3]) {
    test(`a live keeper line in candidate ${index}: exit 1 naming the terminal, nothing removed`, async (t) => {
      const m = await installed(t, xdg);
      const where = candidates(m)[index];
      assert.ok(where !== undefined);
      if (where.record === true) m.deck.store.setKv('window_runtime_dir', where.dir);
      const keeper = await liveProcess(t, m);
      writeKeeperLine(runtimeAt(where.dir), ID_A, keeper.line);

      const r = await uninstall(m, ['--purge']);

      assert.equal(r.code, 1, `${where.name}: ${r.stdout}`);
      assert.match(r.stderr, new RegExp(`${ID_A} \\(pid ${keeper.pid}\\) in ${where.dir}`));
      assert.match(r.stderr, /end those sessions first/);
      stillInstalled(m);
      assert.ok(existsSync(where.dir));
      assert.ok(stillRuns(m, keeper));
    });
  }

  test('a keeper .pid file that cannot be read counts as alive: refused', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads anything');
    const m = await installed(t);
    const path = writeKeeperLine(m.makeRuntime(), ID_A, (await liveProcess(t, m)).line);
    chmodSync(path, 0o000);

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${ID_A} \\(its \\.pid file cannot be read\\)`));
    stillInstalled(m);
  });

  test('a keeper line that cannot be judged (no boot id) counts as alive: refused', async (t) => {
    const m = await installed(t);
    writeKeeperLine(m.makeRuntime(), ID_A, (await liveProcess(t, m)).line);

    const r = await uninstall(m, ['--purge'], () => [], {
      proc: { ...m.platform.proc, bootId: () => null },
    });

    assert.equal(r.code, 1);
    stillInstalled(m);
  });

  test('refused before anything is done: a running server is not stopped', async (t) => {
    const m = await installed(t);
    const fake = await startFakeServe(t, m);
    writeKeeperLine(m.runtime(), ID_A, (await liveProcess(t, m)).line);

    const r = await uninstall(m, ['--purge'], () => [fake.pid]);

    assert.equal(r.code, 1);
    assert.ok(stillRuns(m, fake));
    noLine(r, /stopped skydeck's window server/);
    stillInstalled(m);
  });

  test('a keeper that appears while the server stops: no directory is removed, and the message says what was done', async (t) => {
    const m = await installed(t);
    const fake = await startFakeServe(t, m);
    const files = m.runtime();
    const keeper = await liveProcess(t, m);
    // The keeper's line appears once the server has been asked to stop (a server that was
    // starting a keeper as the stop came).
    let looks = 0;
    const list = (dir: string): string[] => {
      if (dir === files.termsDir && ++looks === 2) {
        writeKeeperLine(files, ID_A, keeper.line);
      }
      return m.platform.files.list(dir);
    };

    const r = await uninstall(m, ['--purge'], () => [fake.pid], {
      files: { ...m.platform.files, list },
    });

    assert.equal(r.code, 1, r.stdout);
    assert.match(
      r.stderr,
      /skydeck is uninstalled, but --purge removed no directory: terminals of the window may still run: aaaaaaaaaaaa/,
    );
    assert.ok(existsSync(files.termPid(ID_A)));
    for (const dir of [m.places.dataDir, m.places.stateDir, m.places.configDir]) {
      assert.ok(existsSync(dir), dir);
    }
    assert.equal(existsSync(settingsFile(m.places)), false, 'the step 1 part was done');
  });

  test('without live keepers: every candidate directory and skydeck’s directories are removed', async (t) => {
    const m = await installed(t, xdg);
    const all = candidates(m);
    m.deck.store.setKv('window_runtime_dir', all[0]?.dir ?? '');
    for (const { dir } of all) {
      const files = runtimeAt(dir);
      writeKeeperLine(files, ID_A, await endedLine(t, m));
      writeFileSync(files.serverJson, '{}');
    }

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 0, r.stderr);
    for (const { name, dir } of all) {
      assert.equal(existsSync(dir), false, name);
    }
    for (const dir of [m.places.dataDir, m.places.stateDir, m.places.configDir]) {
      assert.equal(existsSync(dir), false, dir);
    }
    assert.ok(r.lines.includes(`removed ${all[0]?.dir ?? ''}`), r.stdout);
  });

  test('with a running server and no live keeper: the server is stopped first, then everything goes', async (t) => {
    const m = await installed(t);
    const fake = await startFakeServe(t, m);

    const r = await uninstall(m, ['--purge'], () => [fake.pid]);

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.lines.includes("stopped skydeck's window server; 0 terminals in the window keep running"),
      r.stdout,
    );
    await ended(fake);
    assert.equal(existsSync(join(m.s.skydeckHome, 'run')), false);
    assert.equal(existsSync(m.places.dataDir), false);
  });

  test('a recorded directory that holds something skydeck does not write is left alone', async (t) => {
    const m = await installed(t);
    const recorded = join(m.s.root, 'someones-dir');
    m.deck.store.setKv('window_runtime_dir', recorded);
    runtimeAt(recorded);
    writeFileSync(join(recorded, 'notes.txt'), 'mine');

    const r = await uninstall(m, ['--purge']);

    // Ruled (purge-care): any directory --purge leaves alone ends the command with the line, exit 1.
    assert.equal(r.code, 1, r.stdout);
    assert.ok(existsSync(join(recorded, 'notes.txt')));
    assert.ok(
      r.stderr.includes(
        `did not remove ${recorded}: it holds notes.txt, which skydeck did not write`,
      ),
      r.stderr,
    );
    assert.equal(existsSync(m.places.dataDir), false);
  });

  test('a candidate that is a symbolic link is never followed for removal', async (t) => {
    const m = await installed(t);
    const target = join(m.s.root, 'elsewhere');
    runtimeAt(target);
    symlinkSync(target, join(m.s.skydeckHome, 'run'));

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 1, r.stdout);
    assert.ok(existsSync(join(target, 'terms')), 'the link target stays');
    assert.ok(
      r.stderr.includes(`did not remove ${join(m.s.skydeckHome, 'run')}: it is a symbolic link`),
      r.stderr,
    );
  });

  test("a candidate that is another user's is left alone and named", async (t) => {
    const m = await installed(t);
    const files = m.makeRuntime();
    // The sandbox cannot make a directory another user owns: lstat says so for that one path.
    const lstat = (path: string): ReturnType<Platform['files']['lstat']> => {
      const info = m.platform.files.lstat(path);
      return path === files.dir && info !== null ? { ...info, uid: info.uid + 1 } : info;
    };

    const r = await uninstall(m, ['--purge'], () => [], { files: { ...m.platform.files, lstat } });

    assert.equal(r.code, 1, r.stdout);
    assert.ok(existsSync(files.termsDir));
    const uid = m.platform.uid + 1;
    assert.ok(r.stderr.includes(`did not remove ${files.dir}: it belongs to uid ${uid}`), r.stderr);
    assert.equal(existsSync(m.places.dataDir), false, 'the rest of the purge is done');
  });

  test('never connects to a keeper: not while refusing, not while removing (S2 7.1)', async (t) => {
    const m = await installed(t);
    const files = m.makeRuntime();
    const keeper = await liveProcess(t, m);
    writeKeeperLine(files, ID_A, keeper.line, false);
    writeKeeperLine(files, ID_B, await endedLine(t, m));
    const live = await countingSocket(t, files.termSock(ID_A));
    const dead = await countingSocket(t, files.termSock(ID_B));
    const before = readFileSync(files.termPid(ID_A), 'utf8');

    assert.equal((await uninstall(m)).code, 0);
    assert.equal((await uninstall(m, ['--purge'])).code, 1);
    assert.equal(
      readFileSync(files.termPid(ID_A), 'utf8'),
      before,
      'not started: stays not started',
    );

    keeper.child.kill('SIGKILL');
    await keeper.exited;
    assert.equal((await uninstall(m, ['--purge'])).code, 0);

    assert.equal(live.connections(), 0);
    assert.equal(dead.connections(), 0);
  });
});

// ---------------------------------------------------------------------------------------------
// From review 2

describe('uninstall --purge: from review 2', () => {
  test('without a database, a live keeper line in <stateDir>/run-<id> refuses before anything is undone', async (t) => {
    const m = await installed(t);
    const dir = join(m.places.stateDir, `run-${storeId(m.places.dbPath)}`);
    writeKeeperLine(runtimeAt(dir), ID_A, (await liveProcess(t, m)).line);
    rmSync(m.places.dbPath); // the test's own connection keeps its file open; the path is gone

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 1, r.stdout);
    assert.match(
      r.stderr,
      /uninstall --purge removed nothing: terminals of the window may still run: aaaaaaaaaaaa/,
    );
    stillInstalled(m);
  });

  test('a terms/ that cannot be listed refuses before anything is undone', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads anything');
    const m = await installed(t);
    const files = m.makeRuntime();
    chmodSync(files.termsDir, 0o000);
    try {
      const r = await uninstall(m, ['--purge']);

      assert.equal(r.code, 1, r.stdout);
      assert.match(
        r.stderr,
        /uninstall --purge removed nothing: the terminals in .*\/terms cannot be listed \(EACCES\)/,
      );
      stillInstalled(m);
    } finally {
      chmodSync(files.termsDir, 0o700);
    }
  });

  test('a runtime directory that cannot be looked at: its removal is refused, truthfully, never an internal error', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads anything');
    const m = await installed(t);
    const files = m.makeRuntime();
    chmodSync(files.dir, 0o300); // terms/ can still be listed, the directory itself cannot
    try {
      const r = await uninstall(m, ['--purge']);

      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.ok(
        r.stderr.startsWith(
          `skydeck: skydeck is uninstalled, but --purge did not remove ${files.dir}: it cannot be looked at (EACCES)`,
        ),
        r.stderr,
      );
      assert.doesNotMatch(r.stderr, /internal error/);
      assert.ok(existsSync(files.termsDir), 'that directory stays');
      assert.equal(existsSync(settingsFile(m.places)), false, 'the uninstall is done');
      assert.equal(existsSync(m.places.dataDir), false, 'the other directories are removed');
    } finally {
      chmodSync(files.dir, 0o700);
    }
  });

  test('a recorded directory with a trailing slash through a symbolic link: the target is never emptied', async (t) => {
    const m = await installed(t);
    const target = join(m.s.root, 'target');
    const files = runtimeAt(target);
    writeFileSync(files.serverJson, '{}');
    symlinkSync(target, join(m.s.root, 'link'));
    const recorded = `${join(m.s.root, 'link')}/`;
    m.deck.store.setKv('window_runtime_dir', recorded);

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 1, r.stdout);
    assert.ok(existsSync(files.serverJson) && existsSync(files.termsDir), 'the target stays whole');
    // The record is normalised (no trailing slash) before the link check: the link is seen.
    assert.ok(
      r.stderr.includes(`did not remove ${join(m.s.root, 'link')}: it is a symbolic link`),
      r.stderr,
    );
  });

  test('a recorded directory with . or .. in it is left alone and named', async (t) => {
    const m = await installed(t);
    const target = join(m.s.root, 'target');
    runtimeAt(target);
    mkdirSync(join(m.s.root, 'x'));
    const recorded = `${m.s.root}/x/../target`;
    m.deck.store.setKv('window_runtime_dir', recorded);

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 1, r.stdout);
    assert.ok(existsSync(join(target, 'terms')));
    assert.ok(
      r.stderr.includes(`did not remove ${recorded}: it is not a plain path (a . or .. in it)`),
      r.stderr,
    );
  });

  test('an entry of the wrong kind, an odd temporary or a foreign file inside terms/: left alone', async (t) => {
    for (const make of [
      (files: RuntimeFiles) => writeFileSync(join(files.termsDir, 'notes.txt'), 'mine'),
      (files: RuntimeFiles) => mkdirSync(files.termPid(ID_A)),
      (files: RuntimeFiles) => mkdirSync(join(files.dir, 'keeper-0123abcd.py')),
      (files: RuntimeFiles) => writeFileSync(join(files.dir, '.mine.tmp'), 'mine'),
      (files: RuntimeFiles) => writeFileSync(files.interop, 'not a link'),
    ]) {
      const m = await installed(t);
      const files = m.makeRuntime();
      make(files);

      const r = await uninstall(m, ['--purge']);

      assert.equal(r.code, 1, r.stdout);
      assert.ok(existsSync(files.termsDir), `${make.toString()}\n${r.stdout}`);
      assert.ok(r.stderr.includes(`did not remove ${files.dir}: it holds `), r.stderr);
    }
  });

  test('what a runtime directory holds, temporaries of its writers included, is removed', async (t) => {
    const m = await installed(t);
    const files = m.makeRuntime();
    for (const name of [
      'server.json',
      'server.pid',
      'keepalive.pid',
      'keepalive.interop',
      'keeper-0123abcd4567ef89.py',
      '.server.json.0123456789ab.tmp',
      '.keepalive.pid.4242.tmp',
    ]) {
      writeFileSync(join(files.dir, name), '');
    }
    symlinkSync(join(m.s.root, 'gone.sock'), files.interop);
    writeKeeperLine(files, ID_A, await endedLine(t, m));
    writeFileSync(join(files.termsDir, `.${ID_B}.4242.tmp`), '');
    await countingSocket(t, files.termSock(ID_C));
    // What a server ended by SIGTERM or SIGKILL leaves: its socket, a socket (not a file).
    const server = await countingSocket(t, files.serverSock);

    const r = await uninstall(m, ['--purge']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(files.dir), false, r.stdout);
    assert.equal(server.connections(), 0);
  });
});
