// `skydeck restore` with `"terminal": "window"` (S2 11.4; plan C14, 2.5; task 77): the command asks
// the window's server for its ping before it plans or prompts, plans and asks as in design 7.8,
// then sends the chosen ids and `--all` to `POST /restore` and prints the run's lines as they
// arrive. Against the fake serve of test/fixtures/fake-serve (task 76), which answers `/restore`
// with the lines a test gives and records each request; a page is connected (FAKE_SERVE_PAGES), so
// no window is opened. On realTestPlatform (A36), whose boot id is the machine's: the sessions
// here ran in another boot, so they are design 7.8's set.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { isoFromNs, NS_PER_MINUTE, NS_PER_SECOND } from '../../../src/platform/time.ts';
import type { Net } from '../../../src/platform/types.ts';
import type { RestoreStreamLine } from '../../../src/window/protocol.ts';
import { testContextOn } from '../../helpers/context.ts';
import { BOOT_C, sid } from '../../helpers/restore.ts';
import { startFakeServe, windowMachine } from '../../helpers/window-machine.ts';
import type { WindowMachine } from '../../helpers/window-machine.ts';
import { writeWindowConfig } from '../../helpers/window-config.ts';

/** The waits of these cases (A31): ping and answer waits no load runs out where a case expects
 *  none to (as in resume.test.ts); SHORT_ANSWER for the case that waits for the silence. */
const WINDOW_TIMES = 'pingMs=5000,pageMs=300,reuseMs=100,answerMs=20000';
const SHORT_ANSWER = 'pingMs=5000,pageMs=300,reuseMs=100,answerMs=1000';
const PROMPT = 'Toggle numbers, Enter to start, q to cancel: ';
const STOPPED_ANSWERING =
  "skydeck: the window's server stopped answering; run skydeck to see what started\n";
const STOPPED_BEFORE_FINISHED = 'skydeck: restore stopped before it finished; see above\n';

/** A process start no live process of this machine has with the pids below. */
const DEAD_PROC_START = 4242;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  prompts: string[];
  /** The control requests' paths, in order. */
  asked: string[];
}

interface RestoreCase {
  m: WindowMachine;
  /** What reached the fake serve's launch (FAKE_SERVE_REQUESTS). */
  requests(): unknown[];
  edgeCalls(): string[][];
  /** `skydeck <argv>` with stdin a terminal (unless `stdinTTY` false), answering `lines`. */
  run(argv: string[], options?: { lines?: string[]; stdinTTY?: boolean }): Promise<Run>;
}

/**
 * A window machine with `"terminal": "window"` and sessions 1–3 of an earlier boot (BOOT_C), each
 * with a transcript in a directory that exists and a start event of a process of that boot; 1 and
 * 2 have no end (preselected), 3 ended with the reason `other` (offered, not preselected).
 * `sessions` false: none. `times`: SKYDECK_TEST_WINDOW_TIMES (default WINDOW_TIMES).
 */
function restoreCase(
  t: TestContext,
  options: { sessions?: boolean; times?: string } = {},
): RestoreCase {
  const m = windowMachine(t, {
    env: (s) => ({
      SKYDECK_HANDOFF: join(s.root, 'handoff'),
      SKYDECK_TEST_WINDOW_TIMES: options.times ?? WINDOW_TIMES,
    }),
  });
  const stub = writeWindowConfig(m.s, {});
  const configPath = m.deck.places.configPath;
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, `${JSON.stringify({ ...config, terminal: 'window' }, null, 2)}\n`);
  const nowNs = m.platform.clock.nowNs();
  (options.sessions === false ? [] : [1, 2, 3]).forEach((n, index) => {
    const id = sid(n);
    const dir = join(m.s.root, 'projects', String(n));
    mkdirSync(dir, { recursive: true });
    // Session 1 is the most recent: the list's (and so the plan's) first.
    const startNs = nowNs - BigInt(60 + 10 * index) * NS_PER_MINUTE;
    const activityNs = startNs + NS_PER_MINUTE;
    const folder = join(m.deck.places.claudeHome, 'projects', 'demo');
    mkdirSync(folder, { recursive: true });
    const record = (type: string, atNs: bigint): string =>
      `${JSON.stringify({ type, sessionId: id, timestamp: isoFromNs(atNs), cwd: dir, entrypoint: 'cli' })}\n`;
    writeFileSync(
      join(folder, `${id}.jsonl`),
      record('user', activityNs - 5n * NS_PER_SECOND) + record('assistant', activityNs),
    );
    const pid = 4_100_000 + n;
    const event = (kind: 'start' | 'end', timeNs: bigint, detail: string) => ({
      spoolName: `${timeNs}-${pid}-${kind}-${id}.ev`,
      timeNs,
      kind,
      detail: detail as never,
      rawDetail: detail,
      sessionId: id,
      bootId: BOOT_C,
      pid,
      procStart: DEAD_PROC_START,
      cwd: dir,
      argv: kind === 'start' ? ['claude'] : null,
      name: null,
      payload: null,
    });
    m.deck.store.insertEvent(event('start', startNs, 'startup'));
    if (n === 3) m.deck.store.insertEvent(event('end', activityNs, 'other'));
  });
  const requests = join(m.s.root, 'requests.jsonl');
  return {
    m,
    requests: () =>
      existsSync(requests)
        ? readFileSync(requests, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as unknown)
        : [],
    edgeCalls: () => stub.edgeCalls(),
    async run(argv, options = {}) {
      const asked: string[] = [];
      const net: Net = {
        ...m.platform.net,
        requestUnix(path, request) {
          asked.push(`${request.method} ${request.path}`);
          return m.platform.net.requestUnix(path, request);
        },
      };
      const c = testContextOn(
        { platform: { ...m.platform, net } },
        { stdinTTY: options.stdinTTY ?? true, lines: options.lines ?? [] },
      );
      const code = await main(argv, c.ctx);
      return { code, stdout: c.stdout(), stderr: c.stderr(), prompts: c.prompts, asked };
    },
  };
}

/** The fake serve of `r`, a page connected, recording the requests, `/restore` answering `lines`. */
async function serving(
  t: TestContext,
  r: RestoreCase,
  restore: readonly RestoreStreamLine[] | string,
): Promise<void> {
  await startFakeServe(t, r.m, {
    FAKE_SERVE_PAGES: '1',
    FAKE_SERVE_REQUESTS: join(r.m.s.root, 'requests.jsonl'),
    FAKE_SERVE_RESTORE: typeof restore === 'string' ? restore : JSON.stringify(restore),
  });
}

const short = (n: number): string => sid(n).slice(0, 8);

/** A run that started the two preselected sessions. */
const TWO_STARTED: RestoreStreamLine[] = [
  { line: `started ${short(1)} one` },
  { line: `started ${short(2)} two` },
  { line: 'restore finished: 2 started' },
  { outcome: { code: 0, started: 2, timedOut: 0, failed: 0, notStarted: 0 } },
];

describe('restore with "terminal": "window" (S2 11.4; plan C14)', () => {
  test('no server: the not-running line before anything else, without "--here"; no list, no prompt; exit 1', async (t) => {
    const r = restoreCase(t);

    const run = await r.run(['restore']);

    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.stderr, 'skydeck: the window is not running; run skydeck window first\n');
    assert.equal(run.stdout, '', 'no list');
    assert.deepEqual(run.prompts, [], 'stdin is a terminal, and the prompt was never shown');
  });

  test('--dry-run: the list and its commands printed as in step 1; the server is asked nothing', async (t) => {
    const r = restoreCase(t);
    await serving(t, r, TWO_STARTED);

    const run = await r.run(['restore', '--dry-run']);

    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout.split('\n');
    assert.match(lines[0] ?? '', new RegExp(`^1\\. \\[x\\] ${short(1)}  `));
    assert.match(lines[1] ?? '', new RegExp(`^ {4}cd -- .* && claude --resume ${sid(1)}$`));
    assert.match(lines[2] ?? '', new RegExp(`^2\\. \\[x\\] ${short(2)}  `));
    assert.match(lines[4] ?? '', new RegExp(`^3\\. \\[ \\] ${short(3)}  `));
    assert.deepEqual(run.asked, []);
    assert.deepEqual(r.requests(), []);
  });

  test('--yes: the preselection and all false in the request; the run’s lines on stdout; exit 0', async (t) => {
    const r = restoreCase(t);
    await serving(t, r, TWO_STARTED);

    const run = await r.run(['restore', '--yes']);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(r.requests(), [
      { route: 'restore', sessionIds: [sid(1), sid(2)], all: false },
    ]);
    assert.equal(
      run.stdout,
      `started ${short(1)} one\nstarted ${short(2)} two\nrestore finished: 2 started\n`,
    );
    assert.equal(run.stderr, '');
    assert.deepEqual(run.prompts, []);
    assert.deepEqual(run.asked.slice(0, 1), ['GET /ping'], 'the ping first');
  });

  test('the ids chosen at the prompt, in the list’s order, and --all, in the request; the list before the run’s lines', async (t) => {
    const r = restoreCase(t);
    await serving(t, r, TWO_STARTED);

    // Untick 1, tick 3: 2 and 3 are chosen.
    const run = await r.run(['restore', '--all'], { lines: ['3 1', ''] });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(r.requests(), [{ route: 'restore', sessionIds: [sid(2), sid(3)], all: true }]);
    assert.deepEqual(run.prompts, [PROMPT, PROMPT]);
    const run1 = `started ${short(1)} one\nstarted ${short(2)} two\nrestore finished: 2 started\n`;
    assert.ok(run.stdout.endsWith(run1), run.stdout);
    assert.ok(
      run.stdout.lastIndexOf(`3. [x] ${short(3)}  `) < run.stdout.indexOf(run1),
      'the list shown again after the toggle, before the run',
    );
    assert.deepEqual(r.edgeCalls(), [], 'a page is connected: no window opened');
  });

  test('q at the prompt: cancelled as in step 1, nothing sent', async (t) => {
    const r = restoreCase(t);
    await serving(t, r, TWO_STARTED);

    const run = await r.run(['restore'], { lines: ['q'] });

    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /restore cancelled; nothing was started/);
    assert.deepEqual(r.requests(), []);
  });

  test('a failed session: exit 1 (the outcome’s code), no line of the command’s own', async (t) => {
    const r = restoreCase(t);
    await serving(t, r, [
      { line: `failed ${short(1)}: claude ended before the session started (status 3)` },
      { line: `started ${short(2)} two` },
      { line: 'restore finished: 1 started, 1 failed' },
      { outcome: { code: 1, started: 1, timedOut: 0, failed: 1, notStarted: 0 } },
    ]);

    const run = await r.run(['restore', '--yes']);

    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.stderr, '');
    assert.ok(run.stdout.endsWith('restore finished: 1 started, 1 failed\n'), run.stdout);
  });

  test('silent-after:1: the line that came, then 11.4’s line ONCE on stderr; exit 1', async (t) => {
    const r = restoreCase(t, { times: SHORT_ANSWER });
    await serving(t, r, 'silent-after:1');

    const run = await r.run(['restore', '--yes']);

    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.stdout, 'line 1\n');
    assert.equal(run.stderr, STOPPED_ANSWERING);
  });

  test('an outcome with code 5: the run’s lines, then C14’s line ONCE on stderr; exit 5', async (t) => {
    const r = restoreCase(t);
    await serving(t, r, [
      { line: `started ${short(1)} one` },
      { line: "stopped: the window's server is stopping" },
      { line: `not started ${short(2)} two` },
      { line: 'restore finished: 1 started, 1 not started' },
      { outcome: { code: 5, started: 1, timedOut: 0, failed: 0, notStarted: 1 } },
    ]);

    const run = await r.run(['restore', '--yes']);

    assert.equal(run.code, 5, run.stderr);
    assert.equal(run.stderr, STOPPED_BEFORE_FINISHED);
    assert.ok(run.stdout.endsWith('restore finished: 1 started, 1 not started\n'), run.stdout);
  });

  test('an older server (no stage C routes): C11’s line without "--here"; exit 1', async (t) => {
    const r = restoreCase(t);
    await startFakeServe(t, r.m, { FAKE_SERVE_PAGES: '1' });

    const run = await r.run(['restore', '--yes']);

    assert.equal(run.code, 1, run.stderr);
    assert.equal(
      run.stderr,
      "skydeck: the window's server is older than this command and cannot start sessions for it; run skydeck window to restart it\n",
    );
    assert.equal(run.stdout, '');
  });

  test('nothing to restore: said after the ping; nothing sent', async (t) => {
    const r = restoreCase(t, { sessions: false });
    await serving(t, r, TWO_STARTED);

    const run = await r.run(['restore', '--yes']);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, 'nothing to restore\n');
    assert.deepEqual(run.asked, ['GET /ping']);
    assert.deepEqual(r.requests(), []);
  });

  test('no server and nothing to restore: the not-running line all the same (the ping comes first)', async (t) => {
    const r = restoreCase(t, { sessions: false });

    const run = await r.run(['restore', '--yes']);

    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.stderr, 'skydeck: the window is not running; run skydeck window first\n');
    assert.equal(run.stdout, '');
  });
});
