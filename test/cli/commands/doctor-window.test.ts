// `skydeck doctor`'s lines for the window (S2 16.3; A30): one case per line, in its ok, info and
// problem forms. The machine is real (A36) but its Windows side is a folder of the sandbox
// (SKYDECK_TEST_MNT_C); the server is the fake serve of task 22, started by the test; keepers are
// `.pid` lines naming processes the test started. doctor starts nothing but gh and
// `python3 --version`, nothing on Windows, signals nothing and never connects to a keeper.
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { isoFromNs } from '../../../src/platform/time.ts';
import type { Files, Platform, RunResult } from '../../../src/platform/types.ts';
import { computeBuild } from '../../../src/window/build.ts';
import { formatPidLine } from '../../../src/window/pidline.ts';
import { writeServerJson } from '../../../src/window/runtime.ts';
import { claudeFolders, run, withStore } from '../../helpers/install.ts';
import { BOOT_A, fakeRunner, runResult, testPlatform } from '../../helpers/platform.ts';
import {
  WINDOWS_USER,
  countingSocket,
  endedLine,
  guardedProcesses,
  lineOf,
  liveProcess,
  noLine,
  runOn,
  startFakeServe,
  stillRuns,
  windowMachine,
  writeKeeperLine,
} from '../../helpers/window-machine.ts';
import type { Lines, MachineOptions, WindowMachine } from '../../helpers/window-machine.ts';

const ID_A = 'aaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbb';
const ID_C = 'cccccccccccc';

/** doctor on the machine; processes that start and signal nothing (recorded). */
async function doctor(m: WindowMachine, override: Partial<Platform> = {}): Promise<Lines> {
  const processes = guardedProcesses(m.processes);
  const r = await runOn(m, ['doctor'], { processes, ...override });
  assert.deepEqual(processes.started, [], 'doctor starts nothing detached');
  assert.deepEqual(processes.signalled, [], 'doctor signals nothing');
  return r;
}

function machine(t: TestContext, options: MachineOptions = {}): WindowMachine {
  return windowMachine(t, options);
}

/** A python3 in the sandbox's bin that answers `--version` with `answer`. */
function pythonStub(m: WindowMachine, answer: string): void {
  const path = join(m.s.bin, 'python3');
  unlinkSync(path);
  writeFileSync(path, `#!/bin/sh\necho '${answer}'\n`, { mode: 0o755 });
}

// ---------------------------------------------------------------------------------------------
// python3

describe('doctor: python3', () => {
  test('python3 3.12 on PATH: ok, with its version', async (t) => {
    const m = machine(t);
    pythonStub(m, 'Python 3.12.3');

    const r = await doctor(m);

    lineOf(r, 'ok', /^ok {7}python3 3\.12\.3 for the window's terminals$/);
  });

  test('python3 missing: a problem naming the window and 3.9', async (t) => {
    const m = machine(t);
    unlinkSync(join(m.s.bin, 'python3'));

    const r = await doctor(m);

    lineOf(
      r,
      'problem',
      /^problem {2}python3 is not found: the window \(skydeck window\) needs python3 3\.9 or newer/,
    );
  });

  test('python3 3.8: a problem naming its version', async (t) => {
    const m = machine(t);
    pythonStub(m, 'Python 3.8.10');

    const r = await doctor(m);

    lineOf(r, 'problem', /^problem {2}python3 3\.8\.10 is older than 3\.9/);
  });

  test('python3 missing while the window was never used (no window_secret): info', async (t) => {
    const m = machine(t, { used: false });
    unlinkSync(join(m.s.bin, 'python3'));

    const r = await doctor(m);

    lineOf(r, 'info', /python3 is not found/);
    noLine(r, /^problem {2}python3/);
  });

  test('the core limit: /usr/bin/python3, or SKYDECK_TEST_PYTHON3 in a sandbox as the launcher reads it', async (t) => {
    const present = machine(t, {
      env: (s) => ({ SKYDECK_TEST_PYTHON3: join(s.bin, 'python3') }),
    });
    lineOf(
      await doctor(present),
      'ok',
      /python3 keeps the window's server from writing crash dumps/,
    );

    const missing = machine(t, {
      env: (s) => ({ SKYDECK_TEST_PYTHON3: join(s.root, 'no-python3') }),
    });
    lineOf(
      await doctor(missing),
      'problem',
      /no-python3 is missing or not executable: the window's server would run without the core limit/,
    );

    const notExecutable = machine(t, {
      env: (s) => ({ SKYDECK_TEST_PYTHON3: join(s.root, 'python3.txt') }),
    });
    writeFileSync(join(notExecutable.s.root, 'python3.txt'), '', { mode: 0o644 });
    lineOf(await doctor(notExecutable), 'problem', /python3\.txt is missing or not executable/);
  });
});

// ---------------------------------------------------------------------------------------------
// The server

describe('doctor: the server', () => {
  test('no server: info', async (t) => {
    const m = machine(t);

    const r = await doctor(m);

    lineOf(r, 'info', /^info {5}no window server runs$/);
  });

  test('a server of this checkout and build: info with pid, checkout, build, uptime, pages, terminals and where its environment came from', async (t) => {
    const m = machine(t);
    const project = join(m.s.root, 'project');
    mkdirSync(project);
    const fake = await startFakeServe(t, m, {
      FAKE_SERVE_TERMINALS: '2',
      SKYDECK_ENV_ORIGIN: project,
    });

    const r = await doctor(m);

    const build = computeBuild(m.platform.files, m.platform.appRoot);
    const line = lineOf(r, 'info', /the window's server runs:/);
    assert.ok(line.includes(`pid ${fake.pid}`), line);
    assert.ok(line.includes(`from ${m.platform.appRoot}`), line);
    assert.ok(line.includes(`build ${build}`), line);
    assert.match(line, /up \d+s/);
    assert.ok(line.includes('0 pages, 2 terminals'), line);
    assert.match(
      line,
      new RegExp(`environment of skydeck window run in ${project} at \\d{4}-\\d\\d-\\d\\dT`),
    );
    noLine(r, /^problem {2}the window's server/);
    assert.ok(stillRuns(m, fake), 'doctor does not stop it');
  });

  test('a server of another build of this checkout: a problem naming --restart', async (t) => {
    const m = machine(t);
    await startFakeServe(t, m, { FAKE_SERVE_BUILD: 'ffffffffffffffff' });

    const r = await doctor(m);

    lineOf(
      r,
      'problem',
      /runs another build of this checkout \(ffffffffffffffff, .*run skydeck window --restart$/,
    );
  });

  test('a server of another checkout: a problem naming that checkout', async (t) => {
    const m = machine(t);
    await startFakeServe(t, m, { FAKE_SERVE_CHECKOUT: '/elsewhere/skydeck' });

    const r = await doctor(m);

    lineOf(
      r,
      'problem',
      /the window's server runs from \/elsewhere\/skydeck, not from this checkout/,
    );
  });

  test('a server that is alive but does not answer: a problem naming --restart', async (t) => {
    const m = machine(t);
    const fake = await startFakeServe(t, m, { FAKE_SERVE_MODE: 'silent' });

    const r = await doctor(m);

    lineOf(
      r,
      'problem',
      new RegExp(
        `the window's server \\(pid ${fake.pid}\\) is alive but does not answer; skydeck window --restart stops it`,
      ),
    );
    assert.ok(stillRuns(m, fake));
  });

  test('a server that answers /ping but fails GET /status: a problem saying so', async (t) => {
    const m = machine(t);
    const fake = await startFakeServe(t, m);
    // The fake serve answers every route; the platform's net answers this one 500, as a server
    // whose status throws does (S2 8.3).
    const net = {
      ...m.platform.net,
      requestUnix: (...args: Parameters<Platform['net']['requestUnix']>) =>
        args[1].path === '/status'
          ? Promise.resolve({ status: 500, body: { error: 'failed' } })
          : m.platform.net.requestUnix(...args),
    };

    const r = await doctor(m, { net });

    lineOf(
      r,
      'problem',
      new RegExp(
        `^problem {2}the window's server \\(pid ${fake.pid}\\) answers, but GET /status failed \\(`,
      ),
    );
    noLine(r, /^info {5}the window's server runs:/);
  });

  test('a server.json whose process cannot be judged (no boot id): a problem saying so, nothing given up', async (t) => {
    const d = testPlatform(t);
    claudeFolders(d.places);
    assert.equal((await run(d.platform, ['install'], { lines: ['y'] })).code, 0);
    const runDir = join(d.sandbox.skydeckHome, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    writeServerJson(d.platform.files, join(runDir, 'server.json'), {
      pid: 4242,
      procStart: 7,
      bootId: BOOT_A,
      port: 47613,
      serverId: '0011223344556677',
      build: 'b',
      checkout: d.platform.appRoot,
      startedAt: '1',
      envOrigin: { dir: '/', atNs: '1' },
    });
    withStore(d.places, (store) => store.setKv('window_secret', 'A'.repeat(43)));
    d.proc.setBootId(null);

    const r = await run(d.platform, ['doctor']);

    assert.match(
      r.stdout,
      /^problem {2}cannot tell whether the window's server \(pid 4242\) still runs/m,
    );
    assert.deepEqual(d.processes.signals, []);
  });
});

// ---------------------------------------------------------------------------------------------
// The port (A30)

describe('doctor: the port', () => {
  test('a foreign listener on window.port, seen in /proc/net/tcp: a problem; doctor binds nothing', async (t) => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    t.after(() => listener.close());
    const address = listener.address();
    assert.ok(typeof address === 'object' && address !== null);
    const m = machine(t, { window: { port: address.port } });
    let connections = 0;
    listener.on('connection', (socket) => {
      connections++;
      socket.destroy();
    });

    // Every listen doctor would make goes through the platform's net: record them all.
    const listens: unknown[] = [];
    const net = {
      ...m.platform.net,
      listenHttp: (...args: Parameters<Platform['net']['listenHttp']>) => {
        listens.push(args[0]);
        return m.platform.net.listenHttp(...args);
      },
    };

    const r = await doctor(m, { net });

    lineOf(
      r,
      'problem',
      new RegExp(
        `something that is not this installation's window server listens on 127\\.0\\.0\\.1:${address.port}`,
      ),
    );
    assert.deepEqual(listens, [], 'doctor binds nothing, not even for an instant (A30)');
    assert.equal(connections, 0, 'no request is sent to a foreign program');
  });

  test('nothing listens: ok', async (t) => {
    const m = machine(t);

    const r = await doctor(m, { proc: { ...m.platform.proc, tcpListening: () => false } });

    lineOf(r, 'ok', /^ok {7}port 47613 on 127\.0\.0\.1 is free/);
  });

  test('the listener is the window server of this installation: ok', async (t) => {
    const m = machine(t);
    await startFakeServe(t, m); // its ping says port 47613

    const r = await doctor(m, {
      proc: { ...m.platform.proc, tcpListening: (port) => port === 47613 },
    });

    lineOf(r, 'ok', /port 47613 on 127\.0\.0\.1: the window's server listens there/);
  });

  test("held while this installation's server is alive but does not answer: info; the server's own line is the problem", async (t) => {
    const m = machine(t);
    const fake = await startFakeServe(t, m, { FAKE_SERVE_MODE: 'silent' });

    const r = await doctor(m, {
      proc: { ...m.platform.proc, tcpListening: (port) => port === 47613 },
    });

    lineOf(
      r,
      'info',
      /^info {5}port 47613 on 127\.0\.0\.1 is held; the window's server does not answer, so whether it holds it is not known$/,
    );
    lineOf(
      r,
      'problem',
      new RegExp(`the window's server \\(pid ${fake.pid}\\) is alive but does not answer`),
    );
    noLine(r, /something that is not this installation's window server/);
  });

  test("held while server.json names a process that cannot be judged: info; the server's own line is the problem", async (t) => {
    const d = testPlatform(t);
    claudeFolders(d.places);
    assert.equal((await run(d.platform, ['install'], { lines: ['y'] })).code, 0);
    withStore(d.places, (store) => store.setKv('window_secret', 'A'.repeat(43)));
    const runDir = join(d.sandbox.skydeckHome, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    writeServerJson(d.platform.files, join(runDir, 'server.json'), {
      pid: 4242,
      procStart: 7,
      bootId: BOOT_A,
      port: 47613,
      serverId: '0011223344556677',
      build: 'b',
      checkout: d.platform.appRoot,
      startedAt: '1',
      envOrigin: { dir: '/', atNs: '1' },
    });
    d.proc.setBootId(null);
    d.proc.setTcpListening([47613]);

    const r = await run(d.platform, ['doctor']);

    assert.match(
      r.stdout,
      /^info {5}port 47613 on 127\.0\.0\.1 is held; the window's server does not answer, so whether it holds it is not known$/m,
    );
    assert.match(
      r.stdout,
      /^problem {2}cannot tell whether the window's server \(pid 4242\) still runs/m,
    );
    assert.doesNotMatch(r.stdout, /something that is not this installation's window server/);
    assert.deepEqual(d.processes.signals, []);
  });

  test('/proc/net/tcp cannot be read: info', async (t) => {
    const m = machine(t);

    const r = await doctor(m, { proc: { ...m.platform.proc, tcpListening: () => null } });

    lineOf(r, 'info', /port 47613 on 127\.0\.0\.1: \/proc\/net\/tcp cannot be read/);
  });
});

// ---------------------------------------------------------------------------------------------
// The launch alarm

describe('doctor: the launch alarm', () => {
  test('window_alarm set: a problem with its time, naming --new-secret', async (t) => {
    const m = machine(t);
    const at = 1_794_474_000_000_000_000n;
    m.deck.store.setKv('window_alarm', String(at));

    const r = await doctor(m);

    lineOf(
      r,
      'problem',
      new RegExp(
        `a launch token was presented twice at ${isoFromNs(at).replaceAll('.', '\\.')}, so another program may have skydeck's key; run skydeck window --new-secret$`,
      ),
    );
  });

  test('no alarm: ok', async (t) => {
    const m = machine(t);

    lineOf(await doctor(m), 'ok', /^ok {7}no launch alarm$/);
  });
});

// ---------------------------------------------------------------------------------------------
// The keep-alive (S2 6.1)

describe('doctor: the keep-alive', () => {
  const wslconfig = (m: WindowMachine): string => {
    assert.ok(m.drive !== null);
    return join(m.drive, 'Users', WINDOWS_USER, '.wslconfig');
  };

  test('.wslconfig with instanceIdleTimeout=-1 in the Windows profile folder: ok naming it', async (t) => {
    const m = machine(t);
    writeFileSync(wslconfig(m), '[general]\r\ninstanceIdleTimeout=-1\r\n');
    writeKeeperLine(m.makeRuntime(), ID_A, (await liveProcess(t, m)).line);

    const r = await doctor(m);

    lineOf(
      r,
      'ok',
      /^ok {7}\.wslconfig has instanceIdleTimeout=-1 \(WSL does not stop by itself\)$/,
    );
  });

  test('a .wslconfig in UTF-16 (as some Windows editors save it) is read too', async (t) => {
    const m = machine(t);
    const text = '[general]\r\ninstanceIdleTimeout=-1\r\n';
    writeFileSync(
      wslconfig(m),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    );

    lineOf(await doctor(m), 'ok', /\.wslconfig has instanceIdleTimeout=-1/);
  });

  test('a keep-alive running: its pid and since when, and nothing that calls it unverified', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    const script = await liveProcess(t, m);
    writeFileSync(files.keepalivePid, formatPidLine(script.line));

    const r = await doctor(m);

    lineOf(
      r,
      'info',
      new RegExp(
        `^info {5}keep-alive wsl\\.exe running \\(pid ${script.pid}, since \\d{4}-\\d\\d-\\d\\dT[^)]*\\)$`,
      ),
    );
    assert.doesNotMatch(r.stdout, /unverified|not verified|manual check/i);
    const keepAliveLines = r.lines.filter((line) => line.includes('keep-alive'));
    assert.ok(!keepAliveLines.some((line) => /\bW\d+\b/.test(line)), r.stdout);
  });

  test('neither protection while a keeper lives: a problem', async (t) => {
    const m = machine(t);
    writeKeeperLine(m.makeRuntime(), ID_A, (await liveProcess(t, m)).line);

    const r = await doctor(m);

    lineOf(
      r,
      'problem',
      /^problem {2}WSL is not kept running while the window has terminals .*instanceIdleTimeout=-1/,
    );
  });

  test('neither protection while a server runs, the keep-alive off: a problem that says so', async (t) => {
    const m = machine(t);
    writeFileSync(wslconfig(m), '[general]\ninstanceIdleTimeout=60000\n');
    await startFakeServe(t, m);

    const r = await doctor(m);

    const line = lineOf(r, 'problem', /WSL is not kept running while the window has a server/);
    assert.match(line, /window\.keepAlive is off/);
    assert.match(line, /\.wslconfig does not set instanceIdleTimeout=-1/);
  });

  test('a dead keep-alive line and nothing else running: info, nothing to keep', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    writeFileSync(files.keepalivePid, formatPidLine(await endedLine(t, m)));

    const r = await doctor(m);

    lineOf(r, 'info', /^info {5}keep-alive: nothing to keep running/);
  });
});

// ---------------------------------------------------------------------------------------------
// The interop link (S2 6.4)

describe('doctor: interop', () => {
  test('the link points at a socket that accepts: ok', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    const socket = join(m.s.root, 'interop.sock');
    await countingSocket(t, socket);
    symlinkSync(socket, files.interop);

    lineOf(await doctor(m), 'ok', /interop -> .*interop\.sock answers$/);
  });

  test('a dangling link: a problem', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    symlinkSync(join(m.s.root, 'gone.sock'), files.interop);

    const r = await doctor(m);

    lineOf(r, 'problem', /interop -> .*gone\.sock points at nothing that answers/);
  });

  test('WSL_INTEROP not set: a problem', async (t) => {
    const m = machine(t, { env: () => ({ WSL_INTEROP: undefined }) });

    lineOf(await doctor(m), 'problem', /^problem {2}WSL_INTEROP is not set/);
  });

  test('no link while no server runs: info', async (t) => {
    const m = machine(t);

    lineOf(await doctor(m), 'info', /interop does not exist yet: the window's server makes it/);
  });

  test('a link into the runtime directory (a keeper socket) is never connected to', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    const keeper = await countingSocket(t, files.termSock(ID_A));
    symlinkSync(files.termSock(ID_A), files.interop);

    const r = await doctor(m);

    lineOf(r, 'problem', /interop points at .* inside the runtime directory/);
    assert.equal(keeper.connections(), 0);
  });
});

// ---------------------------------------------------------------------------------------------
// The Windows side: the C: drive, Edge, the profile folder

describe('doctor: the C: drive, Edge and the profile folder', () => {
  test('the C: drive stand-in mounted: ok; missing: a problem (info before first use)', async (t) => {
    lineOf(await doctor(machine(t)), 'ok', /^ok {7}the C: drive is mounted at /);
    lineOf(
      await doctor(machine(t, { drive: false })),
      'problem',
      /^problem {2}the C: drive is not mounted at \/mnt\/c: the window needs it/,
    );
    lineOf(
      await doctor(machine(t, { drive: false, used: false })),
      'info',
      /^info {5}the C: drive is not mounted/,
    );
  });

  test('window.edge that exists but is not a file: a problem; before the window was used: info', async (t) => {
    const used = machine(t);
    const dir = join(used.s.root, 'edge-dir');
    mkdirSync(dir);
    writeFileSync(
      used.places.configPath,
      JSON.stringify({ window: { edge: dir, keepAlive: 'off' } }),
    );
    lineOf(
      await doctor(used),
      'problem',
      new RegExp(`^problem {2}window\\.edge ${dir} is not a file; set window\\.edge in `),
    );

    const never = machine(t, { used: false });
    const other = join(never.s.root, 'edge-dir');
    mkdirSync(other);
    writeFileSync(
      never.places.configPath,
      JSON.stringify({ window: { edge: other, keepAlive: 'off' } }),
    );
    lineOf(
      await doctor(never),
      'info',
      new RegExp(`^info {5}window\\.edge ${other} is not a file`),
    );
  });

  test('Edge present: ok; missing: a problem; missing before the window was used: info', async (t) => {
    lineOf(await doctor(machine(t)), 'ok', /^ok {7}Edge: .*msedge$/);

    const missing = { window: { edge: '/nowhere/msedge.exe' } };
    lineOf(
      await doctor(machine(t, missing)),
      'problem',
      /^problem {2}Edge was not found at \/nowhere\/msedge\.exe; set window\.edge in /,
    );
    lineOf(await doctor(machine(t, { ...missing, used: false })), 'info', /Edge was not found/);
  });

  test('the default window.edge is read on the stand-in drive', async (t) => {
    const m = machine(t);
    assert.ok(m.drive !== null);
    const dir = join(m.drive, 'Program Files (x86)', 'Microsoft', 'Edge', 'Application');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'msedge.exe'), 'MZ');

    // The configuration names /mnt/c/…; doctor finds the file under the stand-in.
    writeFileSync(m.places.configPath, JSON.stringify({ window: { keepAlive: 'off' } }));
    const r = await doctor(m);

    lineOf(
      r,
      'ok',
      /^ok {7}Edge: \/mnt\/c\/Program Files \(x86\)\/Microsoft\/Edge\/Application\/msedge\.exe$/,
    );
  });

  test('the profile folder derived; configured; underivable (a problem naming window.profileDir)', async (t) => {
    lineOf(
      await doctor(machine(t)),
      'ok',
      /the window's Edge profile folder: C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile \(derived\)$/,
    );
    lineOf(
      await doctor(machine(t, { window: { profileDir: 'C:\\Users\\x\\p' } })),
      'ok',
      /profile folder: C:\\Users\\x\\p \(window\.profileDir\)$/,
    );
    const none = machine(t);
    assert.ok(none.drive !== null);
    rmSync(join(none.drive, 'Users'), { recursive: true });
    mkdirSync(join(none.drive, 'Users'));
    lineOf(
      await doctor(none),
      'problem',
      /no readable Edge folder found .*window\.profileDir .* in /,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The runtime directory (S2 4.2)

describe('doctor: the runtime directory', () => {
  test('not there yet: ok, naming the rule that chose it', async (t) => {
    const m = machine(t);

    lineOf(
      await doctor(m),
      'ok',
      /runtime directory .*\/run \(\$SKYDECK_HOME\/run\): the window's server creates it$/,
    );
  });

  test('the one the store records is named as recorded', async (t) => {
    const m = machine(t);
    const recorded = join(m.s.root, 'recorded-run');
    m.deck.store.setKv('window_runtime_dir', recorded);
    m.makeRuntime();

    lineOf(
      await doctor(m),
      'ok',
      new RegExp(`runtime directory ${recorded} \\(recorded in the store\\)$`),
    );
  });

  test('a mode other than 700: a problem', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    chmodSync(files.dir, 0o755);

    lineOf(
      await doctor(m),
      'problem',
      /runtime directory .* cannot be used: it has mode 755; it must be 700$/,
    );
  });

  test('a socket path of 108 bytes or more: a problem', async (t) => {
    const m = machine(t, { env: (s) => ({ SKYDECK_HOME: join(s.root, 'h'.repeat(80)) }) });

    lineOf(await doctor(m), 'problem', /cannot be used: a socket path in it would be \d+ bytes/);
  });

  test('XDG_RUNTIME_DIR passed over because the user does not linger: info', async (t) => {
    const m = machine(t, {
      env: (s) => ({ SKYDECK_HOME: undefined, XDG_RUNTIME_DIR: join(s.root, 'xdg') }),
    });
    mkdirSync(join(m.s.root, 'xdg'), { mode: 0o700 });

    const r = await doctor(m, { userName: 'skydeck-test-no-linger' });

    lineOf(r, 'ok', /runtime directory .*\/run-[0-9a-f]{8} \(in the state directory\)/);
    lineOf(
      r,
      'info',
      /XDG_RUNTIME_DIR \(.*\/xdg\) is passed over: skydeck-test-no-linger does not linger, so systemd would remove it when the last terminal closes/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The vendored files (S2 16.6)

describe('doctor: the vendored files', () => {
  test('the checkout as it is: ok', async (t) => {
    lineOf(await doctor(machine(t)), 'ok', /^ok {7}vendored files match vendor\/MANIFEST\.json$/);
  });

  test('a vendored file altered: a problem naming it', async (t) => {
    const m = machine(t);
    const root = join(m.s.root, 'checkout');
    mkdirSync(join(root, 'vendor', 'xterm', 'xterm'), { recursive: true });
    const original = join(m.platform.appRoot, 'vendor', 'MANIFEST.json');
    copyFileSync(original, join(root, 'vendor', 'MANIFEST.json'));
    const manifest = JSON.parse(readFileSync(original, 'utf8')) as { files: { path: string }[] };
    for (const { path } of manifest.files) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      copyFileSync(join(m.platform.appRoot, path), join(root, path));
    }
    writeFileSync(join(root, 'vendor', 'xterm', 'xterm', 'LICENSE'), 'changed');

    const r = await doctor(m, { appRoot: root });

    lineOf(
      r,
      'problem',
      /^problem {2}vendored files: vendor\/xterm\/xterm\/LICENSE differs from vendor\/MANIFEST\.json/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Keepers (S2 4.2, 7.1)

describe('doctor: keepers', () => {
  test('counted from their .pid lines with versions and started; a dead one is info', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line, true);
    writeKeeperLine(files, ID_B, (await liveProcess(t, m)).line, false);
    writeKeeperLine(files, ID_C, await endedLine(t, m));

    const r = await doctor(m);

    lineOf(r, 'info', /^info {5}keepers: 2 running, 1 ended$/);
    lineOf(
      r,
      'info',
      new RegExp(
        `^info {5}keeper ${ID_A}: running \\(pid \\d+, keeper version 2, its program started\\)$`,
      ),
    );
    lineOf(
      r,
      'info',
      new RegExp(
        `^info {5}keeper ${ID_B}: running \\(pid \\d+, keeper version 2, its program not started yet\\)$`,
      ),
    );
    lineOf(
      r,
      'info',
      new RegExp(
        `^info {5}keeper ${ID_C}: not running; its \\.pid line is removed at the next server start$`,
      ),
    );
    noLine(r, /^problem {2}keeper/);
  });

  test('a .pid file that cannot be read is reported on its own, not as not running', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads anything');
    const m = machine(t);
    const files = m.makeRuntime();
    const path = writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line);
    chmodSync(path, 0o000);

    const r = await doctor(m);

    lineOf(
      r,
      'info',
      new RegExp(
        `keeper ${ID_A}: .*${ID_A}\\.pid cannot be read, so whether it runs cannot be told`,
      ),
    );
    noLine(r, new RegExp(`keeper ${ID_A}: not running`));
  });

  test('with a server: what GET /status knows is added', async (t) => {
    const m = machine(t);
    await startFakeServe(t, m, { FAKE_SERVE_TERMINALS: '1' }); // terminal 000000000000, slot 1
    writeKeeperLine(m.runtime(), '000000000000', (await liveProcess(t, m)).line);

    const r = await doctor(m);

    lineOf(
      r,
      'info',
      /keeper 000000000000: running \(.*\); the server shows it in slot 1, running$/,
    );
  });

  test('none: info', async (t) => {
    lineOf(await doctor(machine(t)), 'info', /^info {5}keepers: no terminals in the window$/);
  });

  test('doctor never connects to a keeper, and one not started stays not started (S2 17.3)', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    const path = writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line, false);
    const before = readFileSync(path, 'utf8');
    const socket = await countingSocket(t, files.termSock(ID_A));
    const dead = await countingSocket(t, files.termSock(ID_B));
    writeKeeperLine(files, ID_B, await endedLine(t, m));
    await startFakeServe(t, m);

    await doctor(m);

    assert.equal(socket.connections(), 0);
    assert.equal(dead.connections(), 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

// ---------------------------------------------------------------------------------------------
// What doctor starts

describe('doctor: what it starts', () => {
  test('nothing on Windows: only gh and python3 --version run, nothing is started detached', async (t) => {
    const m = machine(t, { window: { keepAlive: 'wsl' } });
    writeKeeperLine(m.makeRuntime(), ID_A, (await liveProcess(t, m)).line);
    const commands: string[] = [];
    const runner = {
      ...m.platform.runner,
      run: (
        command: string,
        args: readonly string[],
        options?: Parameters<Platform['runner']['run']>[2],
      ) => {
        commands.push([command, ...args].join(' '));
        return m.platform.runner.run(command, args, options);
      },
    };

    await doctor(m, { runner });

    assert.deepEqual(commands, ['gh --version', 'python3 --version']);
  });
});

// ---------------------------------------------------------------------------------------------
// Never used, then used (ruled by the plan owner, task 24)

describe('doctor: before and after the window was first used', () => {
  /**
   * Step 1's machine (fake runner, fake /proc), with everything wrong for the window that can be:
   * no python3, no C: drive, no WSL_INTEROP, Edge and the profile folder not found, a foreign
   * listener on the port, a runtime directory of the wrong mode with a dangling interop link.
   */
  async function brokenForTheWindow(t: TestContext) {
    const d = testPlatform(t, { env: { WSL_INTEROP: undefined } });
    claudeFolders(d.places);
    assert.equal((await run(d.platform, ['install'], { lines: ['y'] })).code, 0);
    const runDir = join(d.sandbox.skydeckHome, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    chmodSync(runDir, 0o755);
    symlinkSync(join(d.sandbox.root, 'gone.sock'), join(runDir, 'interop'));
    d.proc.setTcpListening([47613]);
    const runner = fakeRunner((call) =>
      runResult(
        (call.command === 'python3'
          ? { code: null, notFound: true }
          : {}) satisfies Partial<RunResult>,
      ),
    );
    return { d, platform: { ...d.platform, runner } };
  }

  const texts = (lines: string[]): string[] => lines.map((line) => line.slice(9));

  test('never used: doctor exits 0 as step 1 did; each finding is info. Used: the same findings are problems', async (t) => {
    const { d, platform } = await brokenForTheWindow(t);

    const before = await run(platform, ['doctor']);
    const beforeLines = before.stdout.split('\n').filter((line) => line !== '');

    assert.equal(before.code, 0, before.stdout);
    assert.ok(!beforeLines.some((line) => line.startsWith('problem')), before.stdout);

    withStore(d.places, (store) => store.setKv('window_secret', 'A'.repeat(43)));
    const after = await run(platform, ['doctor']);
    const afterLines = after.stdout.split('\n').filter((line) => line !== '');
    const problems = afterLines.filter((line) => line.startsWith('problem'));

    assert.equal(after.code, 1);
    for (const pattern of [
      /^python3 is not found/,
      /^the C: drive is not mounted/,
      /^WSL_INTEROP is not set/,
      /^Edge at .* cannot be checked/,
      /^the window's Edge profile folder cannot be derived/,
      /^something that is not this installation's window server listens/,
      /^runtime directory .* it has mode 755/,
      /interop -> .*gone\.sock points at nothing that answers/,
    ]) {
      assert.ok(
        texts(problems).some((text) => pattern.test(text)),
        `${pattern}\n${after.stdout}`,
      );
      assert.ok(
        texts(beforeLines.filter((line) => line.startsWith('info'))).some((text) =>
          pattern.test(text),
        ),
        `${pattern} as info before\n${before.stdout}`,
      );
    }
    // Every problem after first use was an info line before: the rule changes kinds, not findings.
    const infoBefore = new Set(texts(beforeLines.filter((line) => line.startsWith('info'))));
    for (const text of texts(problems)) {
      assert.ok(infoBefore.has(text), text);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Nothing under /mnt/ in a test sandbox (ruled by the plan owner, task 24)

describe('doctor and uninstall read nothing under /mnt/ in a test sandbox', () => {
  /** The platform's Files with every path under /mnt refused and recorded. */
  function noMnt(files: Files): { files: Files; touched: string[] } {
    const touched: string[] = [];
    const guard = (...paths: string[]): void => {
      for (const path of paths) {
        if (path === '/mnt' || path.startsWith('/mnt/')) {
          touched.push(path);
          throw new Error(`a test touched ${path}`);
        }
      }
    };
    const wrapped = Object.fromEntries(
      Object.entries(files).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          guard(...args.filter((arg): arg is string => typeof arg === 'string'));
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as Files;
    return { files: wrapped, touched };
  }

  for (const window of [
    {},
    { profileDir: 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile' },
  ]) {
    test(`with the default window.edge and ${JSON.stringify(window)}: nothing touched`, async (t) => {
      const d = testPlatform(t);
      claudeFolders(d.places);
      mkdirSync(d.places.configDir, { recursive: true });
      writeFileSync(d.places.configPath, JSON.stringify({ window }));
      const guard = noMnt(d.platform.files);
      const platform = { ...d.platform, files: guard.files };
      assert.equal((await run(platform, ['install'], { lines: ['y'] })).code, 0);
      withStore(d.places, (store) => store.setKv('window_secret', 'A'.repeat(43)));

      await run(platform, ['doctor']);
      await run(platform, ['uninstall']);
      await run(platform, ['uninstall', '--purge']);

      assert.deepEqual(guard.touched, []);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// From review 2

describe('doctor: from review 2', () => {
  test('a python3 that cannot be started (EACCES): python3 --version failed, and the checks go on', async (t) => {
    const m = machine(t);
    const runner = {
      ...m.platform.runner,
      run: (
        command: string,
        args: readonly string[],
        options?: Parameters<Platform['runner']['run']>[2],
      ) =>
        command === 'python3'
          ? Promise.reject(Object.assign(new Error('spawn python3 EACCES'), { code: 'EACCES' }))
          : m.platform.runner.run(command, args, options),
    };

    const r = await doctor(m, { runner });

    lineOf(
      r,
      'problem',
      /^problem {2}python3 --version failed \(EACCES\): the window \(skydeck window\) needs python3 3\.9 or newer/,
    );
    noLine(r, /python3: could not be checked/);
  });

  test('a keepalive.pid that cannot be read is "cannot be told", never "no keep-alive"', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads anything');
    const m = machine(t);
    const files = m.makeRuntime();
    writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line);
    writeFileSync(files.keepalivePid, formatPidLine((await liveProcess(t, m)).line));
    chmodSync(files.keepalivePid, 0o000);

    const r = await doctor(m);

    lineOf(
      r,
      'info',
      /^info {5}keep-alive: keepalive\.pid cannot be read, so whether it runs cannot be told$/,
    );
    noLine(r, /WSL is not kept running/);
  });

  test('lines that cannot be judged (no boot id) are never counted dead: keepers and the keep-alive', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    const keeper = await liveProcess(t, m);
    writeKeeperLine(files, ID_A, keeper.line);
    const script = await liveProcess(t, m);
    writeFileSync(files.keepalivePid, formatPidLine(script.line));

    const r = await doctor(m, { proc: { ...m.platform.proc, bootId: () => null } });

    lineOf(r, 'info', /^info {5}keepers: 0 running, 1 cannot be told$/);
    lineOf(
      r,
      'info',
      new RegExp(`^info {5}keeper ${ID_A}: whether it runs cannot be told \\(pid ${keeper.pid};`),
    );
    lineOf(
      r,
      'info',
      new RegExp(`^info {5}keep-alive: whether it runs cannot be told \\(pid ${script.pid};`),
    );
    noLine(r, /not running; its \.pid line is removed/);
    noLine(r, /WSL is not kept running/);
  });

  test('a keep-alive whose wsl.exe is gone (keepalive.interop refused) is not running: the problem while a keeper lives', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line);
    writeFileSync(files.keepalivePid, formatPidLine((await liveProcess(t, m)).line));
    writeFileSync(files.keepaliveInterop, join(m.s.root, 'gone-interop.sock'));

    const r = await doctor(m);

    const line = lineOf(
      r,
      'problem',
      /^problem {2}WSL is not kept running while the window has terminals/,
    );
    assert.match(line, /the keep-alive's wsl\.exe is gone/);
    noLine(r, /keep-alive wsl\.exe running/);
  });

  test('a keep-alive whose keepalive.interop names a path that is there and refuses: not running', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line);
    writeFileSync(files.keepalivePid, formatPidLine((await liveProcess(t, m)).line));
    const stale = join(m.s.root, 'stale.sock'); // there, but nothing listens: a refusal
    writeFileSync(stale, '');
    writeFileSync(files.keepaliveInterop, stale);

    const r = await doctor(m);

    const line = lineOf(
      r,
      'problem',
      /^problem {2}WSL is not kept running while the window has terminals/,
    );
    assert.match(
      line,
      /the keep-alive's wsl\.exe is gone \(its keepalive\.interop socket refuses\)/,
    );
  });

  test('a keep-alive whose keepalive.interop socket accepts, or gives no judgement, is running', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line);
    writeFileSync(files.keepalivePid, formatPidLine((await liveProcess(t, m)).line));
    const socket = join(m.s.root, 'live-interop.sock');
    const listening = await countingSocket(t, socket);
    writeFileSync(files.keepaliveInterop, socket);

    lineOf(await doctor(m), 'info', /keep-alive wsl\.exe running/);
    assert.equal(listening.connections(), 1, 'one connection, nothing sent');

    writeFileSync(files.keepaliveInterop, '');
    lineOf(await doctor(m), 'info', /keep-alive wsl\.exe running/);
  });

  test('keepalive.interop naming a socket in the runtime directory is never connected to', async (t) => {
    const m = machine(t);
    const files = m.makeRuntime();
    const keeper = await countingSocket(t, files.termSock(ID_A));
    writeKeeperLine(files, ID_A, (await liveProcess(t, m)).line);
    writeFileSync(files.keepalivePid, formatPidLine((await liveProcess(t, m)).line));
    writeFileSync(files.keepaliveInterop, files.termSock(ID_A));

    await doctor(m);

    assert.equal(keeper.connections(), 0);
  });

  test('the keep-alive problem line never advises wsl --shutdown bare (ruled by the plan owner, task 24)', async (t) => {
    const m = machine(t);
    writeKeeperLine(m.makeRuntime(), ID_A, (await liveProcess(t, m)).line);

    const line = lineOf(await doctor(m), 'problem', /WSL is not kept running/);

    assert.match(
      line,
      /set instanceIdleTimeout=-1 under \[general\] in C:\\Users\\me\\\.wslconfig; it takes effect at the next WSL restart by itself — wsl --shutdown restarts WSL at once but ends EVERY session and terminal in WSL, so run it only when nothing is running that you want to keep$/,
    );
  });

  test('a server that answers on another port than window.port, which a foreign listener holds: a problem', async (t) => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    t.after(() => listener.close());
    const address = listener.address();
    assert.ok(typeof address === 'object' && address !== null);
    const m = machine(t, { window: { port: address.port } });
    await startFakeServe(t, m); // its ping says port 47613

    const r = await doctor(m);

    lineOf(
      r,
      'problem',
      new RegExp(
        `something that is not this installation's window server listens on 127\\.0\\.0\\.1:${address.port}`,
      ),
    );
  });

  test('text from the server is shown sanitised: no escape, no bidi control, no forged line', async (t) => {
    const m = machine(t);
    const hostile = '/x\u001b[31m\nproblem  forged‮\u001b]8;;http://e\u0007y';
    await startFakeServe(t, m, {
      FAKE_SERVE_CHECKOUT: hostile,
      FAKE_SERVE_TERMINALS: '1',
      SKYDECK_ENV_ORIGIN: hostile,
    });

    const r = await doctor(m);

    assert.doesNotMatch(r.stdout, /[\u001b\u009b‪-‮⁦-⁩]/);
    assert.ok(!r.lines.some((line) => line.startsWith('problem  forged')), r.stdout);
    lineOf(r, 'problem', /the window's server runs from \/x problem {2}forged/);
  });
});
