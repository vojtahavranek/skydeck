// The window's server put together (S2 4.1, 5.2, 5.5, 6.2, 10.1, 11.3, 16.5; plan task 23): its
// start and its refusals, a page's list, resume and new end to end, a keeper found unstarted, the
// Windows programs it does not start, a session running in a terminal of the test's own, and the
// places it uses. In the test process (A19) on realTestPlatform, with real keepers running the
// stand-in.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildNewCommand } from '../../src/claude/launch.ts';
import type { Detached, Platform } from '../../src/platform/types.ts';
import { launchSpec } from '../../src/sessions/launch.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import { lockKey, readLock } from '../../src/sessions/resume.ts';
import { controlClient } from '../../src/window/client.ts';
import { parsePidLine } from '../../src/window/pidline.ts';
import type { ListMessage, RowPayload } from '../../src/window/protocol.ts';
import { readServerJson } from '../../src/window/runtime.ts';
import { ServeExit } from '../../src/window/server.ts';
import { procStartOf, sleep, startProgram, stillRuns, until } from '../helpers/keeper.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import {
  connectTestPage,
  rowsOf,
  serverSandbox,
  startTestServer,
  WAIT_MS,
} from '../helpers/window.ts';
import type { TestPage } from '../helpers/window.ts';

/** S2 6.1: the Windows client the keep-alive is. */
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe';
/** S2 9.6: what opens a link in the Windows default browser (window.links "default"). */
const RUNDLL32_EXE = '/mnt/c/Windows/System32/rundll32.exe';
const KEEPER_CODE = readFileSync(new URL('../../bin/skydeck-keeper', import.meta.url), 'utf8');
const NS_TEXT = /^[1-9][0-9]*$/;

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return rowsOf(list).find((row) => row.id === sessionId);
}

function isServeExit(code: number, message?: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ServeExit, `a ServeExit, not ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  };
}

/** Waits until the screen a page attached to shows the stand-in's prompt of `sessionId`. */
async function prompted(
  page: TestPage,
  snap: { ch: number; data: string },
  sessionId: string,
): Promise<void> {
  const prompt = `standin ${sessionId.slice(0, 8)}> `;
  await until(
    () => (snap.data + page.output(snap.ch)).includes(prompt),
    () => `${JSON.stringify(prompt)} in ${JSON.stringify(page.output(snap.ch).slice(-300))}`,
    WAIT_MS,
  );
}

describe('starting (S2 5.2)', () => {
  test('server.json (0o600, every field), server.pid, server.sock and the keeper file; ping and status answer', async (t) => {
    const { server, d } = await startTestServer(t);
    assert.equal(server.runtimeDir, d.box.runtimeDir);
    const bootId = d.platform.proc.bootId();
    assert.ok(bootId !== null);

    assert.equal(statSync(d.files.serverJson).mode & 0o777, 0o600);
    const raw = JSON.parse(readFileSync(d.files.serverJson, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), [
      'bootId',
      'build',
      'checkout',
      'envOrigin',
      'pid',
      'port',
      'procStart',
      'serverId',
      'startedAt',
    ]);
    const json = readServerJson(d.platform.files, d.files.serverJson);
    assert.ok(json !== null, 'server.json holds a valid value');
    assert.equal(json.pid, process.pid);
    assert.equal(json.procStart, procStartOf(process.pid));
    assert.equal(json.bootId, bootId);
    assert.equal(json.port, server.port);
    assert.ok(server.port > 0);
    assert.equal(json.serverId, server.serverId);
    assert.match(server.serverId, /^[0-9a-f]{16}$/);
    assert.equal(json.build, server.build);
    assert.equal(json.checkout, d.platform.appRoot);
    assert.match(json.startedAt, NS_TEXT);
    assert.deepEqual(json.envOrigin, { dir: d.s.home, atNs: json.startedAt });

    const pid = parsePidLine(readFileSync(d.files.serverPid, 'utf8'));
    assert.deepEqual(pid, { pid: process.pid, procStart: json.procStart, bootId });
    assert.ok(lstatSync(d.files.serverSock).isSocket());
    assert.equal(lstatSync(d.files.serverSock).mode & 0o777, 0o600);
    assert.equal(readFileSync(d.files.keeperFile(server.build), 'utf8'), KEEPER_CODE);

    const client = controlClient(d.platform.net, d.files.serverSock);
    assert.deepEqual(await client.ping(), {
      serverId: server.serverId,
      bootId,
      build: server.build,
      protocol: 1,
      pid: process.pid,
      port: server.port,
      checkout: d.platform.appRoot,
    });
    const status = await client.status();
    assert.equal(status.pages, 0);
    assert.deepEqual(status.terminals, []);
    assert.deepEqual(status.keepAlive, { mode: 'off', state: 'off', since: null, error: null });
    assert.equal(status.python.found, true);
    assert.match(status.python.version ?? '', /^3\.[0-9]+/);
    assert.equal(status.build, server.build);
    assert.equal(status.checkout, d.platform.appRoot);
    assert.equal(status.startedAtNs, json.startedAt);
    assert.deepEqual(status.envOrigin, json.envOrigin);
  });

  test('SKYDECK_ENV_ORIGIN is taken out of the environment and recorded as its origin (A29)', async (t) => {
    const origin = '/somewhere/the/window/ran';
    const { d } = await startTestServer(t, { env: { SKYDECK_ENV_ORIGIN: origin } });
    const json = readServerJson(d.platform.files, d.files.serverJson);
    assert.equal(json?.envOrigin.dir, origin);
  });

  test('a second server of the same checkout → ServeExit 0; of another checkout → 11', async (t) => {
    const { server, d } = await startTestServer(t);
    const holder = `\\(pid ${process.pid}, from ${d.platform.appRoot}\\)`;
    await assert.rejects(
      d.start(),
      isServeExit(0, new RegExp(`^a window server already runs ${holder}$`)),
    );
    const other = join(d.s.root, 'other-checkout');
    await assert.rejects(
      d.start({ platform: (p) => ({ ...p, appRoot: other }) }),
      isServeExit(11, new RegExp(`^a window server already runs ${holder}$`)),
    );
    // The running one goes on.
    const client = controlClient(d.platform.net, d.files.serverSock);
    const ping = await client.ping();
    assert.ok(ping !== 'refused' && ping !== 'timeout' && ping.serverId === server.serverId);
  });

  test('the port held by another program → ServeExit 10, the lock released, nothing left', async (t) => {
    const d = serverSandbox(t);
    const holder = await d.platform.net.listenHttp(
      { host: '127.0.0.1', port: 0 },
      { request: (_req, res) => res.end() },
    );
    t.after(() => holder.close());
    const configPath = join(d.s.skydeckHome, 'config', 'config.json');
    await assert.rejects(
      d.start({ port: holder.port }),
      isServeExit(
        10,
        new RegExp(
          `^port ${holder.port} on 127\\.0\\.0\\.1 is used by another program; set window\\.port in ${configPath.replaceAll('.', '\\.')}$`,
        ),
      ),
    );
    assert.equal(d.deck.store.getKv('window_server'), null, 'the lock is released');
    assert.equal(existsSync(d.files.serverJson), false);
    assert.equal(existsSync(d.files.serverSock), false);
  });

  test('a runtime directory of mode 0o755 → ServeExit 12 with the reason, the lock released', async (t) => {
    const d = serverSandbox(t);
    chmodSync(d.box.runtimeDir, 0o755);
    await assert.rejects(
      d.start(),
      isServeExit(
        12,
        /^the runtime directory .+\/run cannot be used: it has mode 755; it must be 700$/,
      ),
    );
    assert.equal(d.deck.store.getKv('window_server'), null);
  });

  test('server.json and server.pid are written before server.sock answers (ruled, server-findable): while the start still runs its python3 check, the ping names the server server.json names', async (t) => {
    const d = serverSandbox(t);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(release);
    let checking = false;
    const starting = d.start({
      platform: (p) => ({
        ...p,
        runner: {
          ...p.runner,
          async run(command, args, options) {
            if (command === 'python3' && args[1] === '-c') {
              checking = true;
              await held;
            }
            return p.runner.run(command, args, options);
          },
        },
      }),
    });
    await until(() => checking, 'the python3 check of the start', WAIT_MS);

    const ping = await controlClient(d.platform.net, d.files.serverSock).ping();
    assert.ok(typeof ping === 'object', `the ping is answered while the start runs: ${ping}`);
    const json = readServerJson(d.platform.files, d.files.serverJson);
    assert.ok(json !== null, 'server.json is there');
    assert.deepEqual(
      { pid: json.pid, serverId: json.serverId, port: json.port, bootId: json.bootId },
      { pid: ping.pid, serverId: ping.serverId, port: ping.port, bootId: ping.bootId },
    );
    assert.deepEqual(parsePidLine(readFileSync(d.files.serverPid, 'utf8')), {
      pid: json.pid,
      procStart: json.procStart,
      bootId: json.bootId,
    });
    const client = controlClient(d.platform.net, d.files.serverSock);
    assert.equal((await client.status()).starting, true, '/status says it is starting');
    release();
    const { server } = await starting;
    assert.equal(server.serverId, json.serverId);
    assert.equal((await client.status()).starting, false, 'and not once the start is done');
  });

  test('startDelayMs (SKYDECK_TEST_SERVE_START_DELAY_MS in serve, A31; ruled, server-findable): the lock held for it with nothing recorded and nothing on server.sock; then the server as always', async (t) => {
    const d = serverSandbox(t);
    const begun = performance.now();
    const starting = d.start({ startDelayMs: 1500 });
    await until(() => d.deck.store.getKv('window_server') !== null, 'the lock taken', WAIT_MS);
    await sleep(300);
    assert.equal(existsSync(d.files.serverJson), false);
    assert.equal(existsSync(d.files.serverPid), false);
    assert.equal(await controlClient(d.platform.net, d.files.serverSock).ping(500), 'refused');
    const { server } = await starting;
    assert.ok(performance.now() - begun >= 1500, `${performance.now() - begun} ms`);
    assert.equal(readServerJson(d.platform.files, d.files.serverJson)?.serverId, server.serverId);
  });

  test('server.sock held by a process that answers: the start fails before it writes server.json — what was there is left as it is — and gives the lock back (review 2)', async (t) => {
    const d = serverSandbox(t);
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(d.files.serverSock, resolve));
    t.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
    const theirs = '{"written": "by whatever answers on server.sock"}\n';
    writeFileSync(d.files.serverJson, theirs, { mode: 0o600 });
    await assert.rejects(d.start(), {
      name: 'SkydeckError',
      message: `${d.files.serverSock} is in use by a process that answers on it; see skydeck doctor`,
    });
    assert.equal(readFileSync(d.files.serverJson, 'utf8'), theirs, 'server.json left as it was');
    assert.equal(existsSync(d.files.serverPid), false, 'no server.pid written');
    assert.equal(d.deck.store.getKv('window_server'), null, 'the lock released');
  });

  test('a start that fails once server.json is written (server.sock cannot be listened on) removes server.json and server.pid and gives the lock back', async (t) => {
    const d = serverSandbox(t);
    let recorded = false;
    await assert.rejects(
      d.start({
        platform: (p) => ({
          ...p,
          net: {
            ...p.net,
            listenHttp(where, handlers) {
              if ('path' in where) {
                recorded = existsSync(d.files.serverJson) && existsSync(d.files.serverPid);
                return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
              }
              return p.net.listenHttp(where, handlers);
            },
          },
        }),
      }),
      /EACCES/,
    );
    assert.ok(recorded, 'server.json and server.pid were written before server.sock');
    assert.equal(existsSync(d.files.serverJson), false, 'server.json removed');
    assert.equal(existsSync(d.files.serverPid), false, 'server.pid removed');
    assert.equal(d.deck.store.getKv('window_server'), null, 'the lock released');
  });

  test('CLAUDECODE set → ServeExit 13, and nothing is taken', async (t) => {
    const d = serverSandbox(t, { env: { CLAUDECODE: '1' } });
    await assert.rejects(
      d.start(),
      isServeExit(13, /^the window's server is not started from inside a Claude Code session/),
    );
    assert.equal(d.deck.store.getKv('window_server'), null);
    assert.equal(existsSync(d.files.serverJson), false);
  });
});

describe('a page (S2 8.2, 12; A27)', () => {
  test('connects with the stored secret; its view gets the sandbox sessions in sections', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    assert.equal(page.welcome.serverId, test.server.serverId);
    assert.equal(page.welcome.assetVersion, test.server.build);
    const list = await page.list((l) => rowsOf(l).length === 2, 'both sessions in the list');
    assert.deepEqual(
      list.sections.map((section) => section.name),
      ['open', 'week', 'earlier'],
    );
    assert.deepEqual(
      rowsOf(list)
        .map((row) => row.id)
        .sort(),
      [S1, S2].sort(),
    );
    assert.deepEqual(list.terminals, []);
    assert.ok(
      list.dirs.includes(join(d.s.home, 'project')),
      'the project directory for the new form',
    );
  });

  test('the selected row carries its resume card (A27, selectedPayload)', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server, { view: { selected: S1 } });
    const list = await page.list((l) => l.selected !== null, 'the resume card');
    assert.equal(list.selected?.sessionId, S1);
    assert.match(list.selected?.command ?? '', /--resume 0b5f3c1e-/);
  });
});

describe('resume and new in the window (S2 11.3)', () => {
  test('act resume: ok with its session; the terminal in slot 1; attach gives snap; input reaches the program', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.list((l) => rowOf(l, S1) !== undefined, 'the session listed');

    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sessionId, S1);

    const list = await page.list(
      (l) => l.terminals.length === 1 && rowOf(l, S1)?.terminal === l.terminals[0]?.id,
      'the terminal in the list',
    );
    const term = list.terminals[0];
    assert.ok(term !== undefined);
    assert.equal(term.slot, 1);
    assert.equal(rowOf(list, S1)?.slot, 1);

    page.send({ t: 'attach', term: term.id, cols: 80, rows: 24 });
    const snap = await page.next('snap', 'the snap');
    assert.equal(snap.term, term.id);
    await prompted(page, snap, S1);

    page.send({ t: 'input', term: term.id, data: '/busy\r' });
    const started = performance.now();
    await page.list((l) => rowOf(l, S1)?.state === 'working', 'the row working', WAIT_MS);
    // Ruled (review 1): two ticks are 4 s; the bound asserted is 8 s, for a loaded machine.
    assert.ok(performance.now() - started < 8000, 'within 8 s');
  });

  test("act new: the stand-in gets buildNewCommand's arguments; the row titled with the label is starting, then running", async (t) => {
    const d = serverSandbox(t);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.next('list', 'the first list');

    const result = await page.act({
      kind: 'new',
      dir,
      label: 'fix',
      group: '',
      flags: '--model opus',
      cols: 80,
      rows: 24,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const sessionId = result.sessionId;
    assert.ok(sessionId !== null);

    const first = await page.list((l) => rowOf(l, sessionId) !== undefined, 'the new row');
    assert.equal(rowOf(first, sessionId)?.title, 'fix');
    assert.equal(rowOf(first, sessionId)?.starting, true, 'starting before it reports');

    const start = await waitForRecord(
      d.record,
      (record) => record.ev === 'start' && record.argv.includes(sessionId),
      WAIT_MS,
    );
    assert.ok(start.ev === 'start');
    assert.deepEqual(
      start.argv,
      buildNewCommand({
        claudeCommand: d.standin,
        sessionId,
        label: 'fix',
        extra: ['--model', 'opus'],
      }).slice(1),
    );
    assert.equal(start.cwd, dir);

    const running = await page.list((l) => {
      const row = rowOf(l, sessionId);
      return row !== undefined && !row.starting && row.state !== 'not-running';
    }, 'the row running');
    assert.equal(rowOf(running, sessionId)?.title, 'fix');
  });

  test('act new refused (a flag that picks a session, a relative directory, an unclosed quote): the message, nothing started', async (t) => {
    const d = serverSandbox(t);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    const base = { kind: 'new' as const, label: '', group: '', cols: 80, rows: 24 };
    const cases: [typeof base & { dir: string; flags: string }, RegExp][] = [
      [
        { ...base, dir, flags: '-r x' },
        /^cannot pass -r( \(--resume\))? to claude: it picks an existing session; use skydeck resume$/,
      ],
      [
        { ...base, dir: 'relative/dir', flags: '' },
        /^the directory relative\/dir is not absolute$/,
      ],
      [{ ...base, dir, flags: '--model "opus' }, /^the flags have an unclosed "$/],
    ];
    for (const [action, message] of cases) {
      const result = await page.act(action);
      assert.equal(result.ok, false, JSON.stringify(action));
      assert.match(result.error ?? '', message);
      assert.deepEqual(result.lines, [result.error]);
      assert.equal(result.sessionId, null);
    }
    assert.deepEqual(test.server.hub.list(), []);
    assert.deepEqual(readRecords(d.record), []);
  });

  test('two resumes of one session at the same moment from two pages: one terminal, one refused', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const one = await connectTestPage(t, d, test.server);
    const two = await connectTestPage(t, d, test.server);
    const action = { kind: 'resume' as const, sessionId: S1, cols: 80, rows: 24 };
    const results = await Promise.all([one.act(action), two.act(action)]);
    assert.deepEqual(
      results.map((result) => result.ok).sort(),
      [false, true],
      JSON.stringify(results),
    );
    const refused = results.find((result) => !result.ok);
    assert.match(
      refused?.error ?? '',
      /is being resumed|already open in the window|is running/,
      "the guard's or the lock's message",
    );
    assert.equal(test.server.hub.list().length, 1);
  });

  test("resume of a session running in a terminal of the test's own: the guard refuses; the row is elsewhere", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1); // the keeper sandbox's spec runs the stand-in for S1
    const test = await d.start();
    // A terminal the server does not know: started after its rediscovery.
    const own = await d.box.start();
    await startProgram(own);
    const page = await connectTestPage(t, d, test.server);
    const list = await page.list(
      (l) => rowOf(l, S1)?.elsewhere !== null && rowOf(l, S1) !== undefined,
      'the session running elsewhere',
    );
    const elsewhere = rowOf(list, S1)?.elsewhere;
    assert.ok(elsewhere);
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', new RegExp(`is running \\(pid ${elsewhere.pid}\\)`));
    assert.deepEqual(test.server.hub.list(), []);
  });
});

describe('a keeper found unstarted (S2 7.3; plan task 21)', () => {
  /** A keeper the test spawns for a resume of S1 as the window terminal would, and leaves unclaimed. */
  async function unstarted(d: ReturnType<typeof serverSandbox>) {
    d.resumable(S1);
    const prepared = prepareResumeById(d.deck, S1);
    const lock = readLock(d.deck, S1);
    assert.ok(lock !== null);
    const spec = launchSpec(prepared, lock);
    const keeper = await d.box.start({
      spec: {
        cwd: spec.cwd,
        argv: [...spec.argv],
        lock,
        startBy: String(spec.startByNs),
      },
    });
    return { keeper, lock };
  }

  test('its hello goes through decideFoundKeeper: the lock still its own → G, the program starts', async (t) => {
    const d = serverSandbox(t);
    const { keeper } = await unstarted(d);
    const test = await d.start();
    await until(
      () =>
        test.server.hub.list().some((term) => term.id === keeper.spec.id && term.program !== null),
      'the found keeper started its program',
      WAIT_MS,
    );
    const start = await waitForRecord(keeper.record, (record) => record.ev === 'start', WAIT_MS);
    assert.ok(start.ev === 'start' && start.argv.includes(S1));
  });

  test('its hello goes through decideFoundKeeper before any G: a lock taken over → N, nothing started', async (t) => {
    const d = serverSandbox(t);
    const { keeper, lock } = await unstarted(d);
    // Another skydeck took the session's lock over meanwhile (acquireLock: a later millisecond).
    d.deck.store.setKv(lockKey(S1), `${BigInt(lock.split(':')[0] ?? '0') + 1_000_000n}:0`);
    const test = await d.start();
    await until(
      () => test.server.hub.list().some((term) => term.id === keeper.spec.id && term.exit !== null),
      'the found keeper refused',
      WAIT_MS,
    );
    const term = test.server.hub.list().find((candidate) => candidate.id === keeper.spec.id);
    assert.equal(term?.state, 'not-started');
    assert.match(term?.exit?.notStarted ?? '', /its resume lock was taken over/);
    assert.equal(term?.program, null);
    assert.deepEqual(readRecords(keeper.record), [], 'the program never ran');
  });
});

describe('Windows programs (A32)', () => {
  test('open-link with window.links "edge" starts the Edge stub with the link; nothing is run under /mnt/', async (t) => {
    const d = serverSandbox(t, { window: { links: 'edge' } });
    const started: string[] = [];
    const asked: string[] = [];
    const recording = (p: Platform): Platform => ({
      ...p,
      processes: {
        ...p.processes,
        startDetached(command, args, options) {
          started.push(command);
          asked.push(options.cwd);
          return p.processes.startDetached(command, args, options);
        },
      },
      runner: {
        run(command, args, options) {
          started.push(command);
          return p.runner.run(command, args, options);
        },
        runInteractive(command, args, options) {
          started.push(command);
          return p.runner.runInteractive(command, args, options);
        },
      },
    });
    const test = await d.start({ platform: recording });
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'open-link', url: 'https://example.com/a?b=c' });
    assert.equal(result.ok, true, JSON.stringify(result));
    await until(() => d.edgeCalls().length === 1, 'the Edge stub ran', WAIT_MS);
    assert.deepEqual(d.edgeCalls(), [['https://example.com/a?b=c']]);
    // S2 5.3: in the C: drive — here task 24's stand-in for /mnt/c (no test runs in /mnt/c).
    assert.deepEqual(asked, [d.cDrive]);
    assert.ok(started.length > 0);
    for (const command of started) {
      assert.ok(!command.startsWith('/mnt/') && !/\.exe$/i.test(command), command);
    }
  });

  /**
   * The sandbox's platform with every start of rundll32.exe answered by `answer` and recorded,
   * never passed on: no test starts the real program (it would open a browser on the desktop). Any
   * other start is recorded in `others` and passed on to the real processes, which refuse Windows
   * programs (A32).
   */
  function fakeRundll32(answer: () => Promise<Detached>): {
    platform: (p: Platform) => Platform;
    calls: { args: readonly string[]; cwd: string }[];
    others: string[];
  } {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const others: string[] = [];
    return {
      calls,
      others,
      platform: (p) => ({
        ...p,
        processes: {
          ...p.processes,
          startDetached(command, args, options) {
            if (command === RUNDLL32_EXE) {
              calls.push({ args, cwd: options.cwd });
              return answer();
            }
            others.push(command);
            return p.processes.startDetached(command, args, options);
          },
        },
      }),
    };
  }

  test('open-link with window.links "default": a pull request\'s address reaches rundll32.exe as url.dll,FileProtocolHandler and the address; Edge is not run', async (t) => {
    const d = serverSandbox(t, { window: { links: 'default' } });
    assert.equal(d.deck.config.window.links, 'default');
    const rundll32 = fakeRundll32(async () => ({ pid: 4_000_001, exited: new Promise(() => {}) }));
    const test = await d.start({ platform: rundll32.platform });
    const page = await connectTestPage(t, d, test.server);
    const url = 'https://github.com/acme/web/pull/7';
    const result = await page.act({ kind: 'open-link', url });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(rundll32.calls, [
      { args: ['url.dll,FileProtocolHandler', url], cwd: d.cDrive },
    ]);
    assert.ok(
      !rundll32.others.includes(d.deck.config.window.edge),
      'the Edge stub was not started',
    );
    for (const command of rundll32.others) {
      assert.ok(!command.startsWith('/mnt/') && !/\.exe$/i.test(command), command);
    }
    await sleep(200);
    assert.deepEqual(d.edgeCalls(), []);
  });

  test('open-link with window.links "default" when rundll32.exe cannot be started: refused in words that name window.links "edge"', async (t) => {
    const d = serverSandbox(t, { window: { links: 'default' } });
    const rundll32 = fakeRundll32(() =>
      Promise.reject(Object.assign(new Error('spawn failed ENOENT'), { code: 'ENOENT' })),
    );
    const test = await d.start({ platform: rundll32.platform });
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'open-link', url: 'https://github.com/acme/web/pull/7' });
    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      'the link could not be opened: the default browser could not be started (window.links "edge" opens links in Edge)',
    );
    assert.equal(rundll32.calls.length, 1);
    assert.deepEqual(d.edgeCalls(), []);
  });

  test('open-link with window.links "default" and no stand-in for rundll32.exe: the A32 guard refuses the real one, so the link is refused (D5) and nothing is started', async (t) => {
    // The net under every test of links: a stand-in that is forgotten or falls through reaches
    // the real processes, which refuse rundll32.exe by its path before any process exists.
    const d = serverSandbox(t, { window: { links: 'default' } });
    const outcomes: { command: string; code: unknown }[] = [];
    const watching = (p: Platform): Platform => ({
      ...p,
      processes: {
        ...p.processes,
        async startDetached(command, args, options) {
          try {
            const child = await p.processes.startDetached(command, args, options);
            outcomes.push({ command, code: null });
            return child;
          } catch (error) {
            outcomes.push({ command, code: (error as { code?: unknown }).code });
            throw error;
          }
        },
      },
    });
    const test = await d.start({ platform: watching });
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'open-link', url: 'https://github.com/acme/web/pull/7' });
    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      'the link could not be opened: the default browser could not be started (window.links "edge" opens links in Edge)',
    );
    assert.deepEqual(
      outcomes.filter((outcome) => outcome.command === RUNDLL32_EXE),
      [{ command: RUNDLL32_EXE, code: 'EWINDOWS' }],
    );
    await sleep(200);
    assert.deepEqual(d.edgeCalls(), []);
  });
});

describe('places (S2 4.2, 17.3)', () => {
  test('with SKYDECK_HOME set the server, its keepers and the keep-alive script create nothing outside the sandbox', async (t) => {
    // The keep-alive (S2 6.1) is set to "wsl" on FAKE processes (ruled, review 1): wsl.exe is
    // never run; the script it would run (`--exec /bin/sh <checkout>/bin/skydeck-keepalive
    // <runtimeDir>`) runs here in its place, a process this test started and ends itself. The
    // server's signals are recorded and never sent (task 19's rule for such tests).
    let script: { child: Detached; procStart: number | null } | null = null;
    t.after(async () => {
      const own = script;
      if (own === null) return;
      if (own.procStart !== null && stillRuns(own.child.pid, own.procStart)) {
        process.kill(own.child.pid, 'SIGTERM'); // it traps TERM and removes its pid file
      }
      await Promise.race([own.child.exited, sleep(10_000)]);
    });
    // Every XDG directory points at an empty directory of the sandbox: none may be used.
    const xdg = [
      'XDG_RUNTIME_DIR',
      'XDG_STATE_HOME',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
    ];
    const d = serverSandbox(t, { env: { WSL_DISTRO_NAME: 'Test' }, window: { keepAlive: 'wsl' } });
    const dirs = xdg.map((name) => join(d.s.root, name.toLowerCase()));
    for (const dir of dirs) mkdirSync(dir, { mode: 0o700 });
    const written: string[] = [];
    const windows: string[][] = [];
    const signals: number[] = [];
    const recording = (p: Platform): Platform => {
      const record =
        <A extends unknown[], R>(call: (path: string, ...rest: A) => R) =>
        (path: string, ...rest: A): R => {
          written.push(path);
          return call(path, ...rest);
        };
      return {
        ...p,
        env: { ...p.env, ...Object.fromEntries(xdg.map((name, i) => [name, dirs[i]])) },
        files: {
          ...p.files,
          writeText: record(p.files.writeText),
          createExclusive: record(p.files.createExclusive),
          mkdirp: record(p.files.mkdirp),
          remove: record(p.files.remove),
          removeTree: record(p.files.removeTree),
          chmod: record(p.files.chmod),
          rename: (from, to) => {
            written.push(from, to);
            p.files.rename(from, to);
          },
          symlink: (target, path) => {
            written.push(path);
            p.files.symlink(target, path);
          },
        },
        processes: {
          async startDetached(command, args, options) {
            for (const path of [options.stdoutTo, options.stderrTo]) {
              if (path !== undefined) written.push(path);
            }
            if (command !== WSL_EXE) return p.processes.startDetached(command, args, options);
            windows.push([command, ...args]);
            const at = args.indexOf('--exec');
            const child = await p.processes.startDetached(
              args[at + 1] ?? '',
              args.slice(at + 2),
              options, // in the stand-in C: drive of the sandbox
            );
            script = { child, procStart: procStartOf(child.pid) };
            return child;
          },
          signal(pid) {
            signals.push(pid);
            return false;
          },
        },
        net: {
          ...p.net,
          listenHttp(where, handlers) {
            if ('path' in where) written.push(where.path);
            return p.net.listenHttp(where, handlers);
          },
        },
      };
    };
    d.resumable(S1);
    const test = await d.start({ platform: recording });
    assert.equal(test.server.runtimeDir, join(d.s.skydeckHome, 'run'));
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
    const client = controlClient(d.platform.net, d.files.serverSock);
    const deadline = performance.now() + WAIT_MS;
    let state = (await client.status()).keepAlive;
    while (state.state !== 'running') {
      assert.ok(performance.now() < deadline, `the keep-alive running: ${JSON.stringify(state)}`);
      await sleep(100);
      state = (await client.status()).keepAlive;
    }
    assert.deepEqual(windows, [
      [
        WSL_EXE,
        '-d',
        'Test',
        '-u',
        d.platform.userName,
        '--exec',
        '/bin/sh',
        join(d.platform.appRoot, 'bin', 'skydeck-keepalive'),
        d.box.runtimeDir,
      ],
    ]);
    await test.server.stop('done');

    assert.ok(written.length > 0);
    for (const path of written) {
      assert.ok(path.startsWith(`${d.s.root}/`), `${path} is outside the sandbox`);
    }
    // The script's own files are in the runtime directory, and it wrote nowhere else.
    assert.ok(existsSync(d.files.keepalivePid), 'keepalive.pid');
    assert.ok(existsSync(d.files.keepaliveInterop), 'keepalive.interop');
    for (const dir of dirs) {
      assert.deepEqual(readdirSync(dir), [], `${dir} stays empty`);
    }
    assert.deepEqual(signals, [], 'the server signalled nothing');
  });
});
