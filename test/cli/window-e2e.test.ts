// `"terminal": "window"` end to end (S2 11.4; plan C12, C13, C14; task 77): `resume`, `new`,
// `restore` and the interactive list's `R`, run in the test process (A19) against a real test
// server of the sandbox (startTestServer's serverSandbox, with real keepers) and the stand-in as
// every program (A31–A36). Every case connects a test page first, so that no window is opened —
// except the cases "no page", where the Edge stub of the sandbox (A32) stands for Edge. Programs a
// restore starts wait at a gate the test opens (window-restore.ts), so that a case waits on facts,
// not on times.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { buildNewCommand, buildResumeCommand } from '../../src/claude/launch.ts';
import { main } from '../../src/cli/main.ts';
import { NS_PER_MINUTE } from '../../src/platform/time.ts';
import type { Net, Platform, Processes } from '../../src/platform/types.ts';
import { handoffScript } from '../../src/terminals/here.ts';
import { testContextOn } from '../helpers/context.ts';
import { until } from '../helpers/keeper.ts';
import { S1 } from '../helpers/platform.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import type { StandinRecord } from '../helpers/standin.ts';
import { connectTestPage, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestServer } from '../helpers/window.ts';
import { earlierId, restoreSandbox } from '../helpers/window-restore.ts';
import type { RestoreSandbox } from '../helpers/window-restore.ts';

type StartRecord = Extract<StandinRecord, { ev: 'start' }>;

/** The waits of the command line (A31): a window that no page uses is given up after 0.5 s. */
const WINDOW_TIMES = 'pageMs=500,reuseMs=100';
const FLAGS_LINE = 'skydeck: original flags unknown; resuming with defaults';
const CLEAR = '\x1b[H\x1b[2J';
/** The restorer's heartbeat (plan C5): a line of its own, whenever nothing else happened. */
const HEARTBEAT = /^waiting for [0-9]+ sessions?$/;

/** window.profileDir: nothing is derived from a Windows folder (as in window.test.ts). */
const PROFILE = 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile';

const X1 = earlierId(1);
const X2 = earlierId(2);
const X3 = earlierId(3);
const short = (id: string): string => id.slice(0, 8);

interface Command {
  /** The exit code, once the command has ended. */
  done: Promise<number>;
  stdout(): string;
  stderr(): string;
  /** The control requests' paths, in order. */
  asked: string[];
  /** What happened, in order: `stdout <text>`, `stderr <text>`, `detached <program>`. */
  events: string[];
}

/**
 * `skydeck <argv>` on the sandbox's platform in the test process: a handoff file as bin/skydeck
 * gives one, WINDOW_TIMES, `cwd` (default the sandbox's home); with `keys`, both streams are
 * terminals and the keys are typed (the interactive list).
 */
function command(
  d: ServerSandbox,
  argv: string[],
  options: { cwd?: string; keys?: readonly string[] } = {},
): Command {
  const asked: string[] = [];
  const events: string[] = [];
  const base = d.platform;
  const net: Net = {
    ...base.net,
    requestUnix(path, request) {
      asked.push(`${request.method} ${request.path}`);
      return base.net.requestUnix(path, request);
    },
  };
  const processes: Processes = {
    ...base.processes,
    startDetached(program, ...rest) {
      events.push(`detached ${program}`);
      return base.processes.startDetached(program, ...rest);
    },
  };
  const platform: Platform = {
    ...base,
    net,
    processes,
    cwd: options.cwd ?? d.s.home,
    env: {
      ...base.env,
      SKYDECK_HANDOFF: join(d.s.root, 'handoff'),
      SKYDECK_TEST_WINDOW_TIMES: WINDOW_TIMES,
    },
  };
  const tty = options.keys !== undefined;
  const c = testContextOn(
    { platform },
    {
      stdinTTY: tty,
      stdoutTTY: tty,
      ...(options.keys === undefined ? {} : { keys: options.keys }),
      size: { columns: 160, rows: 24 },
    },
  );
  const io = c.ctx.io;
  c.ctx.io = {
    ...io,
    stdout: (text) => {
      events.push(`stdout ${text}`);
      io.stdout(text);
    },
    stderr: (text) => {
      events.push(`stderr ${text}`);
      io.stderr(text);
    },
  };
  return { done: main(argv, c.ctx), stdout: c.stdout, stderr: c.stderr, asked, events };
}

/** A command's stdout as lines, the restorer's heartbeats left out. */
function reportLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line !== '' && !HEARTBEAT.test(line));
}

/** The message line of every frame the interactive list painted. */
function messages(stdout: string): string[] {
  return stdout
    .split(CLEAR)
    .slice(1)
    .map((part) => (part.split('\x1b')[0] ?? '').split('\r\n').at(-1) ?? '');
}

function startOf(d: ServerSandbox, sessionId: string): Promise<StartRecord> {
  return waitForRecord(
    d.record,
    (record): record is StartRecord => record.ev === 'start' && record.argv.includes(sessionId),
    WAIT_MS,
  );
}

function startsOf(d: ServerSandbox, sessionId: string): StartRecord[] {
  return readRecords(d.record).filter(
    (record): record is StartRecord => record.ev === 'start' && record.argv.includes(sessionId),
  );
}

/** The window terminals of `test`'s server, each its session. */
function terminals(test: TestServer): (string | null)[] {
  return test.server.hub.list().map((term) => term.expectedSessionId);
}

/** A server sandbox with `"terminal": "window"`, its server started, a page connected. */
async function windowServerWithPage(
  t: TestContext,
): Promise<{ d: ServerSandbox; test: TestServer }> {
  const d = serverSandbox(t, { config: { terminal: 'window' }, window: { profileDir: PROFILE } });
  const test = await d.start();
  await connectTestPage(t, d, test.server);
  return { d, test };
}

/**
 * A restore sandbox with `"terminal": "window"` (the gate script as `claudeCommand`,
 * restoreBatch 2) whose gates may stay shut while a case looks; its server started.
 */
async function restoreServer(
  t: TestContext,
): Promise<{ r: RestoreSandbox; d: ServerSandbox; test: TestServer }> {
  const r = restoreSandbox(t, {
    config: { terminal: 'window', restoreStartTimeoutSeconds: 120 },
    window: { profileDir: PROFILE },
  });
  return { r, d: r.d, test: await r.d.start() };
}

/** X1, X2, X3 of an earlier boot, in this list order, none with an end: all three preselected. */
function threeSessions(r: RestoreSandbox): void {
  const baseNs = r.d.platform.clock.nowNs() - 90n * NS_PER_MINUTE;
  r.earlierBoot([
    { sessionId: X1, startNs: baseNs + 20n * NS_PER_MINUTE },
    { sessionId: X2, startNs: baseNs + 10n * NS_PER_MINUTE },
    { sessionId: X3, startNs: baseNs },
  ]);
}

describe('resume and new with "terminal": "window", end to end (S2 11.4; plan C13)', () => {
  for (const option of [[], ['--tab']]) {
    test(`resume <ref>${option.length === 0 ? '' : ` ${option.join(' ')}`}: the session runs in a window terminal, exit 0; nothing prepared here`, async (t) => {
      const { d, test } = await windowServerWithPage(t);
      const dir = d.resumable(S1);

      const run = command(d, ['resume', '0b5f', ...option]);

      assert.equal(await run.done, 0, run.stderr());
      assert.equal(run.stderr(), `${FLAGS_LINE}\n`);
      const start = await startOf(d, S1);
      assert.deepEqual(
        start.argv,
        buildResumeCommand({
          claudeCommand: d.standin,
          launch: null,
          sessionId: S1,
          label: null,
        }).argv.slice(1),
      );
      assert.equal(start.cwd, dir);
      assert.deepEqual(terminals(test), [S1], 'a terminal of the window');
      assert.ok(run.asked.includes('POST /resume'), JSON.stringify(run.asked));
      assert.ok(!run.asked.includes('POST /token'), 'a page is connected: no window opened');
      assert.equal(existsSync(join(d.s.root, 'handoff')), false, 'no handoff file');
      assert.deepEqual(d.edgeCalls(), []);
    });
  }

  test('resume <ref> --here: the handoff file as in step 1, no request', async (t) => {
    const { d, test } = await windowServerWithPage(t);
    const dir = d.resumable(S1);

    const run = command(d, ['resume', '0b5f', '--here']);

    assert.equal(await run.done, 0, run.stderr());
    assert.equal(
      readFileSync(join(d.s.root, 'handoff'), 'utf8'),
      handoffScript({ cwd: dir, argv: [d.standin, '--resume', S1] }),
    );
    assert.deepEqual(run.asked, []);
    assert.deepEqual(terminals(test), []);
  });

  test('new --window -- --model opus in a sandbox directory: a window terminal of the new session with buildNewCommand’s argv', async (t) => {
    const { d, test } = await windowServerWithPage(t);
    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);

    const run = command(d, ['new', '--window', '--', '--model', 'opus'], { cwd: dir });

    assert.equal(await run.done, 0, run.stderr());
    assert.equal(run.stderr(), '');
    await until(() => terminals(test).length === 1, 'a terminal of the window', WAIT_MS);
    const [sessionId = null] = terminals(test);
    assert.ok(sessionId !== null);
    const start = await startOf(d, sessionId);
    assert.deepEqual(
      start.argv,
      buildNewCommand({
        claudeCommand: d.standin,
        sessionId,
        label: null,
        extra: ['--model', 'opus'],
      }).slice(1),
    );
    assert.equal(start.cwd, dir);
    assert.ok(!run.asked.includes('POST /token'));
  });
});

describe('restore with "terminal": "window", end to end (S2 11.4; plan C14)', () => {
  test('restore --yes with three sessions of an earlier boot: the server’s lines on stdout as they come, `restore finished: 3 started`, exit 0', async (t) => {
    const { r, d, test } = await restoreServer(t);
    threeSessions(r);
    await connectTestPage(t, d, test.server);

    const run = command(d, ['restore', '--yes']);
    let ended = false;
    void run.done.finally(() => {
      ended = true;
    });

    await until(() => r.waiting(X1) && r.waiting(X2), 'the first batch at its gates', WAIT_MS);
    r.open(X1);
    r.open(X2);
    await until(
      () => reportLines(run.stdout()).length === 2,
      () => `the first batch's lines: ${JSON.stringify(run.stdout())}`,
      WAIT_MS,
    );
    // The second batch waits at its gate: the command is still running, and has printed them.
    await until(() => r.waiting(X3), 'the second batch opened', WAIT_MS);
    assert.equal(ended, false, 'the command waits for the rest of the run');
    assert.deepEqual(
      reportLines(run.stdout())
        .map((line) => line.split(' ').slice(0, 2).join(' '))
        .sort(),
      [`started ${short(X1)}`, `started ${short(X2)}`],
    );
    r.open(X3);

    assert.equal(await run.done, 0, run.stderr());
    const lines = reportLines(run.stdout());
    assert.match(lines[2] ?? '', new RegExp(`^started ${short(X3)} `));
    assert.equal(lines.at(-1), 'restore finished: 3 started');
    assert.equal(lines.length, 4, JSON.stringify(lines));
    assert.equal(run.stderr(), '');
    assert.deepEqual(terminals(test).sort(), [X1, X2, X3]);
    assert.ok(!run.asked.includes('POST /token'), 'a page is connected: no window opened');
  });

  test('restore --yes with one session failing: its line, the others started, exit 1', async (t) => {
    const { r, d, test } = await restoreServer(t);
    const baseNs = d.platform.clock.nowNs() - 90n * NS_PER_MINUTE;
    r.earlierBoot([
      { sessionId: X1, startNs: baseNs + 10n * NS_PER_MINUTE },
      { sessionId: X2, startNs: baseNs },
    ]);
    await connectTestPage(t, d, test.server);
    r.open(X1, 3); // its program exits at once
    r.open(X2);

    const run = command(d, ['restore', '--yes']);

    assert.equal(await run.done, 1, run.stderr());
    const lines = reportLines(run.stdout());
    assert.ok(
      lines.includes(`failed ${short(X1)}: claude ended before the session started (status 3)`),
      JSON.stringify(lines),
    );
    assert.ok(
      lines.some((line) => line.startsWith(`started ${short(X2)} `)),
      JSON.stringify(lines),
    );
    assert.equal(lines.at(-1), 'restore finished: 1 started, 1 failed');
    assert.equal(run.stderr(), '');
    assert.deepEqual(startsOf(d, X1), []);
  });

  test('restore --yes with no page: Edge (the stub) is started and C12’s line said before the restore’s first line; the run goes on', async (t) => {
    const { r, d } = await restoreServer(t);
    const baseNs = d.platform.clock.nowNs() - 90n * NS_PER_MINUTE;
    r.earlierBoot([{ sessionId: X1, startNs: baseNs }]);
    r.open(X1);

    const run = command(d, ['restore', '--yes']);

    assert.equal(await run.done, 0, run.stderr());
    const edge = run.events.findIndex((event) => event.startsWith('detached '));
    const c12 = run.events.findIndex((event) =>
      event.startsWith('stderr skydeck: the window could not be opened: '),
    );
    const first = run.events.findIndex((event) => event.startsWith('stdout started '));
    assert.ok(edge >= 0 && c12 > edge && first > c12, JSON.stringify(run.events));
    assert.equal(
      run.stderr(),
      'skydeck: the window could not be opened: Edge was started, but no window connected within 0.5 seconds; open the window in any browser with skydeck window --print-url; run skydeck window\n',
    );
    await until(() => d.edgeCalls().length === 1, 'the Edge stub ran', WAIT_MS);
    assert.ok(run.asked.indexOf('POST /token') < run.asked.indexOf('POST /restore'));
    assert.equal(reportLines(run.stdout()).at(-1), 'restore finished: 1 started');
  });
});

describe('R in the interactive list with "terminal": "window", end to end (S2 4.4, 11.4; plan C13)', () => {
  test('R: `opened <short> in the window`, and the session runs in a window terminal; the list stays', async (t) => {
    const { r, d, test } = await restoreServer(t);
    r.earlierBoot([{ sessionId: X1 }]);
    r.open(X1);
    await connectTestPage(t, d, test.server);

    const run = command(d, [], { keys: ['R', 'q'] });

    assert.equal(await run.done, 0, run.stderr());
    assert.ok(
      messages(run.stdout()).includes(`opened ${short(X1)} in the window`),
      messages(run.stdout()).join('\n'),
    );
    await startOf(d, X1);
    assert.deepEqual(terminals(test), [X1]);
    assert.equal(run.stderr(), '');
    assert.ok(!run.events.some((event) => event.startsWith('detached ')), 'nothing started here');
  });

  test('R with no page: the message ends `no window is open; run skydeck window`; the Edge stub never runs', async (t) => {
    const { r, d, test } = await restoreServer(t);
    r.earlierBoot([{ sessionId: X1 }]);
    r.open(X1);

    const run = command(d, [], { keys: ['R', 'q'] });

    assert.equal(await run.done, 0, run.stderr());
    const message = messages(run.stdout()).find((line) => line.startsWith('opened')) ?? '';
    assert.ok(message.endsWith('no window is open; run skydeck window'), message);
    assert.equal(
      message,
      `opened ${short(X1)} in the window; no window is open; run skydeck window`,
    );
    await startOf(d, X1);
    assert.deepEqual(terminals(test), [X1]);
    assert.ok(!run.events.some((event) => event.startsWith('detached ')), 'Edge not started');
    assert.ok(!run.asked.includes('POST /token'), JSON.stringify(run.asked));
    assert.deepEqual(d.edgeCalls(), []);
  });
});
