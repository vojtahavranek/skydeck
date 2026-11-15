// The window's server starts sessions for the command line (plan C task 74; S2 8.3, 11.1, 11.4;
// C2, C3, C4): `POST /resume` and `POST /new` over `server.sock`, through the one way the window
// starts a session (launches.ts) — the guard, the lock, `prepareNew`'s checks, the command
// builders with `claudeCommand`, and the first size of the page that had focus last. In the test
// process (A19) on realTestPlatform, with real keepers running the stand-in.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import { buildNewCommand, buildResumeCommand } from '../../src/claude/launch.ts';
import { main } from '../../src/cli/main.ts';
import { NS_PER_MS, NS_PER_SECOND } from '../../src/platform/time.ts';
import type { Platform } from '../../src/platform/types.ts';
import { readLock } from '../../src/sessions/resume.ts';
import type { LaunchAnswer, ListMessage } from '../../src/window/protocol.ts';
import { testContextOn } from '../helpers/context.ts';
import { sleep, startProgram, until } from '../helpers/keeper.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import type { StandinRecord } from '../helpers/standin.ts';
import { connectTestPage, rowsOf, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox } from '../helpers/window.ts';
import { earlierId, post, postRestore, restoreSandbox } from '../helpers/window-restore.ts';

type StartRecord = Extract<StandinRecord, { ev: 'start' }>;

function startsOf(d: ServerSandbox, sessionId: string): StartRecord[] {
  return readRecords(d.record).filter(
    (record): record is StartRecord => record.ev === 'start' && record.argv.includes(sessionId),
  );
}

function startOf(d: ServerSandbox, sessionId: string): Promise<StartRecord> {
  return waitForRecord(
    d.record,
    (record): record is StartRecord => record.ev === 'start' && record.argv.includes(sessionId),
    WAIT_MS,
  );
}

/** The answer of a launch route, checked to be one (C2). */
async function launch(d: ServerSandbox, path: '/resume' | '/new', body: unknown) {
  const answer = await post(d, path, body);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as LaunchAnswer;
}

function openIds(list: ListMessage): string[] {
  return (list.sections.find((section) => section.name === 'open')?.rows ?? []).map(
    (row) => row.id,
  );
}

/** What `skydeck new <args>` prints on stderr and exits with, run in `cwd` on the sandbox's deck. */
async function skydeckNew(
  d: ServerSandbox,
  cwd: string,
  args: string[],
): Promise<{ code: number; lines: string[] }> {
  // A handoff file: a `new` that were not refused would write its command there and run nothing.
  const handoff = join(d.s.root, 'handoff');
  const platform: Platform = {
    ...d.platform,
    cwd,
    env: { ...d.platform.env, SKYDECK_HANDOFF: handoff },
  };
  const run = testContextOn({ platform });
  const code = await main(['new', ...args], run.ctx);
  assert.equal(existsSync(handoff), false, `skydeck new ${args.join(' ')} started nothing`);
  return { code, lines: run.stderr().replace(/\n$/, '').split('\n') };
}

describe('POST /resume (S2 8.3, plan C2)', () => {
  test("POST /resume runs buildResumeCommand's argv with claudeCommand in the session's directory", async (t) => {
    const r = restoreSandbox(t);
    const { d } = r;
    const X = earlierId(1);
    r.earlierBoot([{ sessionId: X }]);
    r.open(X); // its program goes straight to the stand-in
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);

    const answer = await launch(d, '/resume', { sessionId: X });
    assert.deepEqual(answer, { code: 0, lines: [], sessionId: X });
    const start = await startOf(d, X);
    assert.deepEqual(
      start.argv,
      buildResumeCommand({
        claudeCommand: r.command,
        launch: ['claude'],
        sessionId: X,
        label: null,
      }).argv.slice(1),
    );
    assert.equal(start.cwd, join(d.s.home, 'projects', X.slice(0, 8)));
    await page.list((l) => openIds(l).includes(X), 'the session listed under Open');
    assert.deepEqual(
      test.server.hub.list().map((term) => term.expectedSessionId),
      [X],
    );
  });

  test('refusals answer the command line\'s code and its lines with "skydeck: " (C2): the guard 4, an unknown id 3, the window\'s own "already open" 4', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1); // the keeper sandbox's own spec runs the stand-in for S1
    d.resumable(S2);
    const test = await d.start();
    // S1 held by a stand-in in a terminal of the test's own, which the server does not know.
    const own = await d.box.start();
    const { started } = await startProgram(own);
    const page = await connectTestPage(t, d, test.server);
    await page.list(
      (l) => rowsOf(l).find((row) => row.id === S1)?.elsewhere?.pid === started.pid,
      'the session running elsewhere',
    );
    assert.deepEqual(await launch(d, '/resume', { sessionId: S1 }), {
      code: 4,
      lines: [`skydeck: ${S1.slice(0, 8)} is running (pid ${started.pid})`],
      sessionId: null,
    });

    const unknown = '9f9f9f9f-0000-4000-8000-000000000000';
    assert.deepEqual(await launch(d, '/resume', { sessionId: unknown }), {
      code: 3,
      lines: [`skydeck: no session matches '${unknown}'`],
      sessionId: null,
    });

    const first = await launch(d, '/resume', { sessionId: S2 });
    assert.equal(first.code, 0, JSON.stringify(first));
    assert.deepEqual(await launch(d, '/resume', { sessionId: S2 }), {
      code: 4,
      lines: ['skydeck: this session is already open in the window'],
      sessionId: null,
    });
    assert.equal(test.server.hub.list().length, 1, 'only the first resume opened a terminal');
  });

  test('two POST /resume of one session at once start one keeper (one code 0, the other code 4)', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S2);
    const test = await d.start();
    const answers = await Promise.all([
      launch(d, '/resume', { sessionId: S2 }),
      launch(d, '/resume', { sessionId: S2 }),
    ]);
    assert.deepEqual(answers.map((answer) => answer.code).sort(), [0, 4], JSON.stringify(answers));
    const refused = answers.find((answer) => answer.code === 4);
    assert.match(
      refused?.lines.join('\n') ?? '',
      /^skydeck: (this session is already open in the window|.* is being resumed by another skydeck)$/,
    );
    assert.equal(test.server.hub.list().length, 1);
    await startOf(d, S2);
    assert.equal(startsOf(d, S2).length, 1, 'one program');
  });
});

describe('POST /new (S2 8.3, plan C2, C3)', () => {
  test("POST /new runs buildNewCommand's argv: dir, label, group, flags; the meta stored; sessionId the new one", async (t) => {
    const d = serverSandbox(t);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const test = await d.start();
    const answer = await launch(d, '/new', {
      dir,
      label: 'fix it',
      group: 'ABC-1',
      flags: ['--model', 'opus', 'a prompt with  spaces'],
    });
    assert.equal(answer.code, 0, JSON.stringify(answer));
    assert.deepEqual(answer.lines, []);
    const sessionId = answer.sessionId;
    assert.ok(sessionId !== null);
    const start = await startOf(d, sessionId);
    assert.deepEqual(
      start.argv,
      buildNewCommand({
        claudeCommand: d.standin,
        sessionId,
        label: 'fix it',
        extra: ['--model', 'opus', 'a prompt with  spaces'],
      }).slice(1),
    );
    assert.equal(start.cwd, dir);
    const meta = d.deck.store.meta(sessionId);
    assert.equal(meta?.label, 'fix it');
    assert.equal(meta?.group, 'ABC-1');
    assert.deepEqual(
      test.server.hub.list().map((term) => term.expectedSessionId),
      [sessionId],
    );
  });

  test('POST /new refuses what skydeck new refuses, with the same lines and code', async (t) => {
    const d = serverSandbox(t);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const missing = join(d.s.home, 'gone');
    const test = await d.start();
    // Each body (plan C3: label, group, dir and flags reach prepareNew as they are) beside the
    // command line that says the same: the directory is the command's own.
    const cases: { body: Record<string, unknown>; cwd: string; args: string[] }[] = [
      { body: { flags: ['-r', 'x'] }, cwd: dir, args: ['--', '-r', 'x'] },
      { body: { flags: ['--name', 'y'] }, cwd: dir, args: ['--', '--name', 'y'] },
      { body: { flags: ['--resume', S1] }, cwd: dir, args: ['--', '--resume', S1] },
      { body: { dir: 'relative/dir' }, cwd: 'relative/dir', args: [] },
      { body: { dir: '' }, cwd: '', args: [] },
      { body: { dir: missing }, cwd: missing, args: [] },
      { body: { dir: `${dir}/line\nbreak` }, cwd: `${dir}/line\nbreak`, args: [] },
      { body: { label: ' ' }, cwd: dir, args: ['--label', ' '] },
      {
        body: { label: '--dangerously-skip-permissions' },
        cwd: dir,
        args: ['--label=--dangerously-skip-permissions'],
      },
      { body: { label: 'red\x1b[31m' }, cwd: dir, args: ['--label', 'red\x1b[31m'] },
      { body: { label: 'two\nlines' }, cwd: dir, args: ['--label', 'two\nlines'] },
      { body: { group: 'two\nlines' }, cwd: dir, args: ['--group', 'two\nlines'] },
    ];
    for (const { body, cwd, args } of cases) {
      const expected = await skydeckNew(d, cwd, args);
      assert.notEqual(expected.code, 0, `skydeck new ${JSON.stringify(args)} refuses`);
      const answer = await launch(d, '/new', { dir, label: null, group: null, flags: [], ...body });
      assert.deepEqual(
        answer,
        { code: expected.code, lines: expected.lines, sessionId: null },
        JSON.stringify(body),
      );
    }
    assert.deepEqual(test.server.hub.list(), [], 'no terminal');
    assert.deepEqual(readRecords(d.record), [], 'no program');
    assert.deepEqual(d.deck.store.allMeta(), [], 'no label or group stored');
  });
});

describe('the bodies (plan C3; S2 8.3: no program, no argument list)', () => {
  test('a body with argv, program, cwd, command or env is 400 and no keeper is spawned', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const test = await d.start();
    const bodies: [string, Record<string, unknown>][] = [
      ['/resume', { sessionId: S1 }],
      ['/new', { dir, label: null, group: null, flags: [] }],
      ['/restore', { sessionIds: [S1], all: false }],
    ];
    const extras: Record<string, unknown> = {
      argv: ['/bin/sh', '-c', 'touch pwned'],
      program: '/bin/sh',
      cwd: '/',
      command: 'touch pwned',
      env: { PATH: '/tmp' },
    };
    for (const [path, body] of bodies) {
      for (const [field, value] of Object.entries(extras)) {
        const answer = await post(d, path, { ...body, [field]: value });
        assert.equal(answer.status, 400, `${path} with ${field}: ${JSON.stringify(answer.body)}`);
      }
    }
    assert.deepEqual(test.server.hub.list(), [], 'no terminal');
    assert.deepEqual(readRecords(d.record), [], 'no program');
    assert.equal(existsSync(join(d.s.home, 'pwned')), false);
  });

  test('server.log holds kinds only after hostile /new and /restore bodies', async (t) => {
    const d = serverSandbox(t);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const test = await d.start();
    const forged = '2026-11-15T00:00:00.000Z server: forged';
    const hostile = `\x1b]0;evil\x07\x1b[31m\n${forged}`;
    // Refused by prepareNew (a label, a group, a directory), accepted (a flag: claude's own).
    const refused = [
      { dir, label: hostile, group: null, flags: [] },
      { dir, label: null, group: hostile, flags: [] },
      { dir: `${dir}${hostile}`, label: null, group: null, flags: [] },
    ];
    for (const body of refused) {
      const answer = await launch(d, '/new', body);
      assert.equal(answer.code, 2, JSON.stringify(answer));
    }
    const accepted = await launch(d, '/new', {
      dir,
      label: null,
      group: null,
      flags: ['--append-system-prompt', hostile],
    });
    assert.equal(accepted.code, 0, JSON.stringify(accepted));
    // Refused by the parser (not session ids), and a run whose id is not offered.
    assert.equal((await post(d, '/restore', { sessionIds: [hostile], all: false })).status, 400);
    const run = postRestore(d, { sessionIds: [S2], all: true });
    assert.equal((await run.ended).status, 200);
    assert.ok(
      run.texts().some((line) => line.startsWith('failed ')),
      run.texts().join('\n'),
    );

    const log = test.logs().join('\n');
    assert.ok(log.length > 0, 'the server logged');
    for (const part of ['evil', 'forged', '\x1b', '\x07', dir]) {
      assert.equal(log.includes(part), false, `${JSON.stringify(part)} in the log:\n${log}`);
    }
  });
});

describe('the first size (S2 8.2.6, plan C7)', () => {
  test('with a page focused at 132 × 41 a terminal the server opens — POST /new, POST /resume, a restore — starts at 132 × 41; with no page at 120 × 40', async (t) => {
    // Every gate open: the programs go straight to the stand-in, whose record has its size.
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const { d } = r;
    r.openAll();
    const [E1, E2] = [earlierId(1), earlierId(2)];
    r.earlierBoot([{ sessionId: E1 }, { sessionId: E2 }]);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const test = await d.start();
    const body = { dir, label: null, group: null, flags: [] };
    const sizeOf = async (sessionId: string): Promise<{ cols: unknown; rows: unknown }> => {
      const start = await startOf(d, sessionId);
      return { cols: start.cols, rows: start.rows };
    };

    const alone = await launch(d, '/new', body);
    assert.equal(alone.code, 0, JSON.stringify(alone));
    assert.ok(alone.sessionId !== null);
    assert.deepEqual(await sizeOf(alone.sessionId), { cols: 120, rows: 40 });

    const page = await connectTestPage(t, d, test.server);
    page.send({ t: 'focus', focused: true, selected: null, area: { cols: 132, rows: 41 } });
    page.send({ t: 'ping', n: 7 });
    await page.next('pong', 'the pong after the focus'); // the focus has been read
    const focused = await launch(d, '/new', body);
    assert.equal(focused.code, 0, JSON.stringify(focused));
    assert.ok(focused.sessionId !== null);
    assert.deepEqual(await sizeOf(focused.sessionId), { cols: 132, rows: 41 });
    const resumed = await launch(d, '/resume', { sessionId: E1 });
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.deepEqual(await sizeOf(E1), { cols: 132, rows: 41 });
    const restored = postRestore(d, { sessionIds: [E2], all: false });
    assert.equal((await restored.ended).status, 200);
    assert.deepEqual(await sizeOf(E2), { cols: 132, rows: 41 });
  });
});

describe("C2's answers to what is not a refusal", () => {
  test("a busy store: POST /resume and /new answer code 1 with `skydeck: skydeck's database is busy; try again`, logged by kind; nothing started, no lock or label left", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const test = await d.start();
    const lock = holdWriteLock(t, d);
    await lock.held;
    const busy = {
      code: 1,
      lines: ["skydeck: skydeck's database is busy; try again"],
      sessionId: null,
    };
    assert.deepEqual(await launch(d, '/resume', { sessionId: S1 }), busy);
    assert.deepEqual(
      await launch(d, '/new', { dir, label: 'fix it', group: null, flags: [] }),
      busy,
    );
    lock.release();
    assert.deepEqual(test.server.hub.list(), [], 'no terminal');
    assert.equal(readLock(d.deck, S1), null, 'no lock left');
    assert.deepEqual(d.deck.store.allMeta(), [], 'no label stored');
    const log = test.logs().join('\n');
    assert.match(log, /server\.sock resume: the database is busy \(/);
    assert.match(log, /server\.sock new: the database is busy \(/);
  });

  test("an unexpected failure: code 1 with `skydeck: the window's server could not start it (<kind>)`, logged by kind, never its message", async (t) => {
    const d = serverSandbox(t);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    let broken = false;
    const test = await d.start({
      platform: (p) => ({
        ...p,
        uuid: () => {
          if (broken) throw new Error('the uuid broke at /secret/place');
          return p.uuid();
        },
      }),
    });
    broken = true;
    const answer = await launch(d, '/new', { dir, label: null, group: null, flags: [] });
    broken = false;
    assert.deepEqual(answer, {
      code: 1,
      lines: ["skydeck: the window's server could not start it (Error)"],
      sessionId: null,
    });
    assert.deepEqual(test.server.hub.list(), [], 'no terminal');
    const log = test.logs().join('\n');
    assert.match(log, /server\.sock new: failed \(Error\)/);
    assert.equal(log.includes('/secret/place'), false, log);
  });
});

/**
 * Another skydeck holding the store's write lock (server-failures.test.ts's, copied): a worker in
 * the store's own transaction until `release()`.
 */
function holdWriteLock(t: TestContext, d: ServerSandbox): { held: Promise<void>; release(): void } {
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const holder = new Worker(new URL('../fixtures/hold-write-lock.ts', import.meta.url), {
    workerData: { path: join(d.s.skydeckHome, 'data', 'skydeck.db'), signal },
  });
  const release = (): void => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  t.after(async () => {
    release();
    await holder.terminate();
  });
  return {
    held: new Promise<void>((resolve) => holder.once('message', () => resolve())),
    release,
  };
}

/** `GET /status`'s page count as the server sends it. */
async function pagesOf(d: ServerSandbox): Promise<unknown> {
  const answer = await d.platform.net.requestUnix(d.files.serverSock, {
    method: 'GET',
    path: '/status',
    timeoutMs: 10_000,
  });
  return (answer.body as { pages?: unknown }).pages;
}

/** `GET /status`'s `windowExpectedMs` as the server sends it (C20; absent reads as undefined). */
async function expectedMs(d: ServerSandbox): Promise<unknown> {
  const answer = await d.platform.net.requestUnix(d.files.serverSock, {
    method: 'GET',
    path: '/status',
    timeoutMs: 10_000,
  });
  assert.equal(answer.status, 200);
  return (answer.body as { windowExpectedMs?: unknown }).windowExpectedMs;
}

/** The server's start held at its python3 check until `release()` (as server.test.ts does). */
function heldStart(): {
  platform: (p: Platform) => Platform;
  checking: () => boolean;
  release: () => void;
} {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checking = false;
  return {
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
    checking: () => checking,
    release: () => {
      release();
    },
  };
}

describe('the pages mark (plan C20, S2 5.1)', () => {
  test("window_pages_open: written by the server's first refresh after a page has started, removed by its first refresh after the last page closed, and still there after stop() with a page connected", async (t) => {
    const d = serverSandbox(t);
    const test = await d.start();
    const mark = (): string | null => d.deck.store.getKv('window_pages_open');
    const { spoolDir } = d.deck.places;
    mkdirSync(spoolDir, { recursive: true });
    let markers = 0;
    /**
     * Until one refresh of the server has run whole since now (held by order, not by a time: a
     * refresh every 2 s is the promptness C20 asks for). A file the hook could not have written is
     * moved to spool/bad by a refresh's ingest; the server runs in this process and a refresh step
     * — the ingest, then afterRefresh's update of the mark — runs without an await, so once the file
     * is gone that step is over.
     */
    const refreshed = async (): Promise<void> => {
      markers += 1;
      const path = join(spoolDir, `0-0-${markers}-task74-marker.ev`);
      writeFileSync(path, 'not a spool file\n');
      await until(() => !existsSync(path), `refresh ${markers} of the server`, WAIT_MS);
    };

    await refreshed();
    assert.equal(mark(), null, 'no page, no mark');
    const one = await connectTestPage(t, d, test.server);
    await one.next('list', 'the first list: the server has the page');
    await refreshed();
    assert.equal(mark(), '1', 'written by the first refresh after the page started');
    await one.close();
    const deadline = performance.now() + WAIT_MS;
    while ((await pagesOf(d)) !== 0) {
      assert.ok(performance.now() < deadline, 'the server saw the page go');
      await sleep(50);
    }
    await refreshed();
    assert.equal(mark(), null, 'removed by the first refresh after the last page closed');
    const two = await connectTestPage(t, d, test.server);
    await two.next('list', 'the first list of the second page');
    await refreshed();
    assert.equal(mark(), '1', 'written again');
    await test.server.stop('the test stops it');
    assert.equal(mark(), '1', 'the stop records the connected page: a window may come back');
  });

  test('an orderly stop writes the mark once more as its pages are (ruled 13:28Z): a page that connected after the last refresh is recorded, a page that went since is not', async (t) => {
    const d = serverSandbox(t);
    // The tick's one-second timer is the test's: no refresh runs but those the test lets run.
    const ticks: (() => void)[] = [];
    const server = async () =>
      d.start({
        platform: (p) => ({
          ...p,
          clock: {
            ...p.clock,
            every: (ms, callback) => {
              if (ms !== 1000) return p.clock.every(ms, callback);
              ticks.push(callback);
              return () => {};
            },
          },
        }),
      });
    const mark = (): string | null => d.deck.store.getKv('window_pages_open');
    const { spoolDir } = d.deck.places;
    mkdirSync(spoolDir, { recursive: true });
    let markers = 0;
    /** Ticks until one refresh has run whole: its ingest moved a file no hook writes to spool/bad. */
    const refreshed = async (): Promise<void> => {
      markers += 1;
      const path = join(spoolDir, `0-0-${markers}-task74-stop.ev`);
      writeFileSync(path, 'not a spool file\n');
      await until(
        () => {
          for (const tick of ticks) tick();
          return !existsSync(path);
        },
        `refresh ${markers}`,
        WAIT_MS,
      );
    };

    // A page that connected after the last refresh: no refresh has seen it; the stop records it.
    const first = await server();
    const page = await connectTestPage(t, d, first.server);
    await page.next('list', 'the first list: the server has the page');
    assert.equal(mark(), null, 'no refresh has seen the page');
    await first.server.stop('the test stops it');
    assert.equal(mark(), '1', 'written by the stop');

    // The last page gone just before the stop: recorded by a refresh, not any more by the stop.
    const second = await server();
    const again = await connectTestPage(t, d, second.server);
    await again.next('list', "the second server's first list");
    await refreshed();
    assert.equal(mark(), '1', 'a refresh recorded the page');
    await again.close();
    const deadline = performance.now() + WAIT_MS;
    while ((await pagesOf(d)) !== 0) {
      assert.ok(performance.now() < deadline, 'the server saw the page go');
      await sleep(50);
    }
    assert.equal(mark(), '1', 'no refresh since the page went');
    await second.server.stop('the test stops it');
    assert.equal(mark(), null, 'removed by the stop');
  });

  test("a dead server's mark: the next server removes it at its first refresh without a page, and expects a window from the end of its start for 7 s on a clock that cannot step", async (t) => {
    const start = heldStart();
    let starting: Promise<unknown> | null = null;
    // Before the sandbox's own hooks: a start still held is let go, and the server it gives is
    // then stopped by the sandbox.
    t.after(async () => {
      start.release();
      await starting?.catch(() => {});
    });
    const d = serverSandbox(t);
    d.deck.store.setKv('window_pages_open', '1');
    // The server's monotonic reading is the test's: it moves only when the test moves it.
    let mono = d.platform.clock.monotonicNs();
    starting = d.start({
      platform: (p) => {
        const held = start.platform(p);
        return { ...held, clock: { ...held.clock, monotonicNs: () => mono } };
      },
    });
    await until(start.checking, 'the python3 check of the start', WAIT_MS);
    assert.equal(await expectedMs(d), 7000, 'while it starts');
    // C4: before its keepers are found the server starts nothing for a command.
    assert.deepEqual(await post(d, '/resume', { sessionId: S1 }), {
      status: 503,
      body: { error: 'starting' },
    });
    mono += 60n * NS_PER_SECOND;
    assert.equal(await expectedMs(d), 7000, 'counted from the end of the start');
    start.release();
    await starting;
    assert.equal(d.deck.store.getKv('window_pages_open'), null, 'removed at the first refresh');
    assert.equal(await expectedMs(d), 7000, 'the start has just ended');
    mono += 2500n * NS_PER_MS;
    assert.equal(await expectedMs(d), 4500);
    mono += 4499n * NS_PER_MS;
    assert.equal(await expectedMs(d), 1);
    mono += NS_PER_MS;
    assert.equal(await expectedMs(d), null, '7 s after the end of the start');
  });

  test('a page that connects while the server expects a window ends the expectation at once', async (t) => {
    const d = serverSandbox(t);
    d.deck.store.setKv('window_pages_open', '1');
    const mono = d.platform.clock.monotonicNs();
    const test = await d.start({
      platform: (p) => ({ ...p, clock: { ...p.clock, monotonicNs: () => mono } }),
    });
    assert.equal(await expectedMs(d), 7000);
    const page = await connectTestPage(t, d, test.server);
    await page.next('list', 'the first list: the page has started');
    assert.equal(await expectedMs(d), null);
  });

  test("on the platform's own clock the expectation counts down to null", async (t) => {
    const d = serverSandbox(t);
    d.deck.store.setKv('window_pages_open', '1');
    await d.start();
    const readings: number[] = [];
    const deadline = performance.now() + WAIT_MS;
    for (;;) {
      const left = await expectedMs(d);
      if (left === null) break;
      assert.ok(performance.now() < deadline, `still expected after ${WAIT_MS} ms: ${left}`);
      assert.ok(typeof left === 'number' && Number.isInteger(left) && left >= 1 && left <= 7000);
      readings.push(left);
      await sleep(200);
    }
    assert.ok(readings.length > 0, 'a window was expected after the start');
    assert.deepEqual(
      readings,
      [...readings].sort((a, b) => b - a),
      'it only counts down',
    );
  });
});
