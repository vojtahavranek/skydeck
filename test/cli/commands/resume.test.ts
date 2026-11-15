import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Context } from '../../../src/cli/context.ts';
import { main } from '../../../src/cli/main.ts';
import { isoFromNs } from '../../../src/platform/time.ts';
import { lockKey } from '../../../src/sessions/resume.ts';
import type { Net, RunResult } from '../../../src/platform/types.ts';
import type { LaunchAnswer } from '../../../src/window/protocol.ts';
import { handoffScript } from '../../../src/terminals/here.ts';
import { shellQuote } from '../../../src/text/shell.ts';
import { testDeck } from '../../helpers/deck.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { fakeRunner, runResult, S1, SEC, T0, statLine } from '../../helpers/platform.ts';
import type { FakeRunner } from '../../helpers/platform.ts';
import { until } from '../../helpers/keeper.ts';
import { hookInput, spoolName, spoolText } from '../../helpers/spool.ts';
import { runOn, startFakeServe, windowMachine } from '../../helpers/window-machine.ts';
import type { Lines, WindowMachine } from '../../helpers/window-machine.ts';
import { writeWindowConfig } from '../../helpers/window-config.ts';

const USAGE_FIRST_LINE = 'skydeck resume <ref> [--here | --tab | --window]\n';

type Options = Parameters<typeof testDeck>[1];

/** A deck whose context has a handoff file, as bin/skydeck gives it. */
function deck(t: Parameters<typeof testDeck>[0], options: Options = {}): TestDeck {
  return testDeck(t, {
    env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }),
    ...options,
  });
}

const handoffPath = (d: TestDeck): string => join(d.sandbox.root, 'handoff');
const handoff = (d: TestDeck): string => readFileSync(handoffPath(d), 'utf8');

/**
 * Session S1, not running, with a transcript whose first record is in `<root>/project` (created).
 * `argv` undefined: no start event at all (no recorded launch command); otherwise a start event by
 * pid 4242 with that launch command. `running`: pid 4242 is alive. Returns the directory.
 */
function session(
  d: TestDeck,
  options: { argv?: readonly string[]; running?: boolean; dir?: string } = {},
): string {
  const dir = options.dir ?? join(d.sandbox.root, 'project');
  mkdirSync(dir, { recursive: true });
  const folder = join(d.deck.places.claudeHome, 'projects', 'demo');
  mkdirSync(folder, { recursive: true });
  const record = {
    type: 'user',
    sessionId: S1,
    timestamp: isoFromNs(T0 - 30n * SEC),
    cwd: dir,
    entrypoint: 'cli',
  };
  writeFileSync(join(folder, `${S1}.jsonl`), `${JSON.stringify(record)}\n`);
  if (options.argv !== undefined) {
    const fields = {
      event: 'SessionStart' as const,
      timeNs: T0 - 20n * SEC,
      pid: 4242,
      pwd: dir,
      argv: options.argv,
      input: hookInput('SessionStart', S1, { source: 'startup', cwd: dir }),
    };
    writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
  }
  if (options.running === true) {
    d.proc.setProcess(4242, { stat: statLine(4242, 51234567), cmdline: ['claude'] });
  }
  return dir;
}

/** The context of `d` with another runner. */
function withRunner(
  d: TestDeck,
  answer: (args: readonly string[]) => RunResult,
): {
  ctx: Context;
  runner: FakeRunner;
} {
  const runner = fakeRunner((call) => answer(call.args));
  return { ctx: { ...d.ctx, platform: { ...d.platform, runner } }, runner };
}

/** The value of S1's lock taken at T0: the time and S1's latest event id. */
const takenAtT0 = (d: TestDeck): string => `${T0}:${d.deck.store.latestEventIdOfSession(S1)}`;

const fallback = (dir: string, argv: readonly string[]): string =>
  `cd -- ${shellQuote(dir)} && ${argv.map(shellQuote).join(' ')}`;

test('resume --help prints the usage and exits 0', async (t) => {
  const d = deck(t);
  assert.equal(await main(['resume', '--help'], d.ctx), 0);
  assert.ok(d.stdout().startsWith(USAGE_FIRST_LINE), d.stdout());
  assert.equal(d.stderr(), '');
});

test('resume without a reference is a usage error', async (t) => {
  const d = deck(t);
  assert.equal(await main(['resume'], d.ctx), 2);
  assert.ok(d.stderr().includes(USAGE_FIRST_LINE), d.stderr());
});

test('resume --here --tab is a usage error', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f', '--here', '--tab'], d.ctx), 2);
  assert.ok(d.stderr().includes(USAGE_FIRST_LINE), d.stderr());
  assert.equal(existsSync(handoffPath(d)), false);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('resume refuses a session whose start event reaches the spool after the command looked at it', async (t) => {
  const d = deck(t);
  const dir = session(d, { argv: ['claude', '--model', 'opus'] });
  // The command's first refresh (before it looks) lists the spool once; the one that
  // prepareResumeById runs right before the guard lists it again, and another skydeck's
  // `claude` (pid 4343) has written its start event by then.
  const spool = d.deck.places.spoolDir;
  const real = d.platform.files;
  let listings = 0;
  const files = {
    ...real,
    list(path: string): string[] {
      if (path === spool && ++listings === 2) {
        d.proc.setProcess(4343, { stat: statLine(4343, 51234567), cmdline: ['claude'] });
        const fields = {
          event: 'SessionStart' as const,
          timeNs: T0 - SEC,
          pid: 4343,
          pwd: dir,
          argv: ['claude'],
          input: hookInput('SessionStart', S1, { source: 'resume', cwd: dir }),
        };
        writeFileSync(join(spool, spoolName(fields, 2)), spoolText(fields));
      }
      return real.list(path);
    },
  };
  const ctx = { ...d.ctx, platform: { ...d.platform, files } };
  assert.equal(await main(['resume', '0b5f'], ctx), 4);
  assert.equal(d.stderr(), 'skydeck: 0b5f3c1e is running (pid 4343)\n');
  assert.ok(listings >= 2, String(listings));
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  assert.equal(existsSync(handoffPath(d)), false);
});

test('resume with an unknown boot id is refused, takes no lock and starts nothing', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  session(d, { argv: ['claude', '--model', 'opus'], running: true });
  d.proc.setBootId(null); // without it every recorded process looks dead, a running session too
  for (const args of [
    ['resume', '0b5f'],
    ['resume', '0b5f', '--tab'],
    ['resume', '0b5f', '--here'],
  ]) {
    assert.equal(await main(args, d.ctx), 4, args.join(' '));
  }
  assert.equal(
    d.stderr(),
    'skydeck: cannot tell which sessions are running: the boot id could not be read\n'.repeat(3),
  );
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
  assert.equal(existsSync(handoffPath(d)), false);
  assert.deepEqual(d.runner.calls, []);
});

test('resume <prefix> with the default terminal hands the command to the launcher', async (t) => {
  const d = deck(t);
  const dir = session(d, { argv: ['claude', '--model', 'opus'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  assert.equal(
    handoff(d),
    handoffScript({ cwd: dir, argv: ['claude', '--resume', S1, '--model', 'opus'] }),
  );
  assert.equal(d.stderr(), '');
});

test('resume --here hands off even when the configured terminal opens tabs', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  const dir = session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f', '--here'], d.ctx), 0);
  assert.equal(handoff(d), handoffScript({ cwd: dir, argv: ['claude', '--resume', S1] }));
  assert.deepEqual(d.runner.calls, []);
});

test('resume names the label it passes as the session name', async (t) => {
  const d = deck(t);
  const dir = session(d, { argv: ['claude'] });
  d.deck.store.updateMeta(S1, { label: 'my label' }, T0);
  assert.equal(await main(['resume', 'my label'], d.ctx), 0);
  assert.equal(
    handoff(d),
    handoffScript({ cwd: dir, argv: ['claude', '--resume', S1, '-n', 'my label'] }),
  );
});

test('resume not started through bin/skydeck prints the command and exits 1', async (t) => {
  const d = deck(t, { env: { SKYDECK_HANDOFF: undefined } });
  const dir = session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 1);
  assert.ok(d.stderr().includes('not started through bin/skydeck'), d.stderr());
  assert.ok(d.stderr().includes(`cd -- ${dir} && claude --resume ${S1}\n`), d.stderr());
});

test('resume --tab opens a WezTerm tab in the session directory', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  const dir = session(d, { argv: ['claude', '--model', 'opus'] });
  assert.equal(await main(['resume', '0b5f', '--tab'], d.ctx), 0);
  assert.deepEqual(
    d.runner.calls.map((call) => [call.command, ...call.args]),
    [
      [
        'wezterm',
        'cli',
        '--no-auto-start',
        'spawn',
        '--cwd',
        dir,
        '--',
        'claude',
        '--resume',
        S1,
        '--model',
        'opus',
      ],
    ],
  );
  assert.equal(existsSync(handoffPath(d)), false);
  assert.equal(d.stderr(), '');
});

test('resume with a tab terminal configured opens a tab by default', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  assert.equal(d.runner.calls.length, 1);
});

test('resume --tab that WezTerm refuses prints the reason and the quoted command', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  const dir = session(d, { argv: ['claude', '--append-system-prompt', "it's"] });
  const { ctx } = withRunner(d, () => runResult({ code: 1, stderr: 'no window\n' }));
  assert.equal(await main(['resume', '0b5f', '--tab'], ctx), 1);
  assert.equal(d.deck.store.getKv(lockKey(S1)), takenAtT0(d)); // the printed command may be run now
  d.clock.setNs(T0 + 5n * SEC);
  assert.equal(await main(['resume', '0b5f', '--tab'], d.ctx), 4);
  d.clock.setNs(T0);
  assert.ok(d.stderr().includes('no window'), d.stderr());
  assert.ok(
    d
      .stderr()
      .includes(`${fallback(dir, ['claude', '--resume', S1, '--append-system-prompt', "it's"])}\n`),
    d.stderr(),
  );
});

test('resume --tab when WezTerm is not installed prints the command', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  const dir = session(d, { argv: ['claude'] });
  const { ctx } = withRunner(d, () => runResult({ code: null, notFound: true }));
  assert.equal(await main(['resume', '0b5f', '--tab'], ctx), 1);
  assert.ok(d.stderr().includes('wezterm is not installed'), d.stderr());
  assert.ok(d.stderr().includes(`${fallback(dir, ['claude', '--resume', S1])}\n`), d.stderr());
});

test('resume --tab that timed out prints no command and keeps the lock: the tab may have opened', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  session(d, { argv: ['claude'] });
  const { ctx } = withRunner(d, () => runResult({ code: null, timedOut: true }));
  assert.equal(await main(['resume', '0b5f', '--tab'], ctx), 1);
  const err = d.stderr();
  assert.equal(
    err,
    'skydeck: wezterm timed out; a tab may have opened\n' +
      `skydeck: run skydeck again to see whether session ${S1} is running\n`,
  );
  assert.equal(d.deck.store.getKv(lockKey(S1)), takenAtT0(d));
  d.clock.setNs(T0 + 5n * SEC);
  assert.equal(await main(['resume', '0b5f', '--tab'], ctx), 4);
});

test('a timeout is told apart by the terminal, not by the words of its message', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  session(d, { argv: ['claude'] });
  // Not a timeout, though its first stderr line reads like the adapter's timeout message.
  const { ctx } = withRunner(d, () =>
    runResult({ code: 1, stderr: 'wezterm timed out; a tab may have opened\n' }),
  );
  assert.equal(await main(['resume', '0b5f', '--tab'], ctx), 1);
  assert.ok(d.stderr().includes(`--resume ${S1}\n`), d.stderr());
});

test('resume whose terminal fails to open (a rejected open) prints the command', async (t) => {
  const d = deck(t, {
    env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'no-such-dir', 'handoff') }),
  });
  const dir = session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 1);
  assert.ok(d.stderr().includes('cannot open the terminal'), d.stderr());
  assert.ok(d.stderr().includes(`${fallback(dir, ['claude', '--resume', S1])}\n`), d.stderr());
  assert.equal(d.stderr().includes('internal error'), false, d.stderr());
});

test('resume --tab without a tab adapter names the missing adapter and prints the command', async (t) => {
  const d = deck(t);
  const dir = session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f', '--tab'], d.ctx), 1);
  assert.ok(d.stderr().includes('no terminal adapter that opens tabs'), d.stderr());
  assert.ok(d.stderr().includes(`${fallback(dir, ['claude', '--resume', S1])}\n`), d.stderr());
  assert.equal(existsSync(handoffPath(d)), false);
});

test('resume never prints a command that holds control characters', async (t) => {
  const d = deck(t, { env: { SKYDECK_HANDOFF: undefined } });
  session(d, { argv: ['claude', '--model', 'op\x1b]0;x\x07us'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 1);
  const err = d.stderr();
  assert.ok(err.includes('not started through bin/skydeck'), err);
  assert.ok(err.includes('control characters'), err);
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(err), false, JSON.stringify(err));
  assert.equal(err.includes('cd --'), false, err);
  // Nothing was started and no command was printed: the lock does not keep the user waiting.
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
});

test('resume of an unknown reference exits 3', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', 'nope1234'], d.ctx), 3);
  assert.ok(d.stderr().includes("no session matches 'nope1234'"), d.stderr());
});

test('resume of a running session exits 4 naming the pid, and hands nothing off', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude'], running: true });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 4);
  assert.equal(d.stderr(), 'skydeck: 0b5f3c1e is running (pid 4242)\n');
  assert.equal(existsSync(handoffPath(d)), false);
});

test('resume twice within 60 s: the second is refused', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  d.clock.setNs(T0 + 20n * SEC);
  assert.equal(await main(['resume', '0b5f'], d.ctx), 4);
  assert.equal(d.stderr(), 'skydeck: 0b5f3c1e is being resumed (20 s ago); try again in 40 s\n');
});

test('a start dated in the future does not release the lock: of three resumes in a row only the first goes through', async (t) => {
  const d = deck(t);
  const dir = session(d, { argv: ['claude'] });
  // The clock was ten minutes ahead when this claude (pid 5151, dead now) started, then stepped back.
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 + 600n * SEC,
    pid: 5151,
    pwd: dir,
    argv: ['claude'],
    input: hookInput('SessionStart', S1, { source: 'resume', cwd: dir }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 3)), spoolText(fields));
  assert.equal(await main(['resume', '0b5f', '--here'], d.ctx), 0);
  assert.equal(await main(['resume', '0b5f', '--here'], d.ctx), 4);
  assert.equal(await main(['resume', '0b5f', '--here'], d.ctx), 4);
  assert.equal(
    d.stderr(),
    'skydeck: 0b5f3c1e is being resumed (0 s ago); try again in 60 s\n'.repeat(2),
  );
});

test('resume twice, 61 s apart: both go through', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  d.clock.setNs(T0 + 61n * SEC);
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
});

test('resume of a session without a recorded launch command says the flags are unknown', async (t) => {
  const d = deck(t);
  const dir = session(d);
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  assert.equal(d.stderr(), 'skydeck: original flags unknown; resuming with defaults\n');
  assert.equal(handoff(d), handoffScript({ cwd: dir, argv: ['claude', '--resume', S1] }));
});

test('resume names flags skydeck does not know, and passes neither them nor what follows', async (t) => {
  const d = deck(t);
  const dir = session(d, { argv: ['claude', '--frob', 'x', '--model', 'opus'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  assert.equal(
    d.stderr(),
    'skydeck: started with flags skydeck does not know, not passed on resume: --frob\n',
  );
  assert.equal(
    handoff(d),
    handoffScript({ cwd: dir, argv: ['claude', '--resume', S1, '--model', 'opus'] }),
  );
});

test('resume names unknown flags before the reason a launch failed', async (t) => {
  const d = deck(t, { env: { SKYDECK_HANDOFF: undefined } });
  const dir = session(d, { argv: ['claude', '--frob'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 1);
  assert.equal(
    d.stderr(),
    'skydeck: started with flags skydeck does not know, not passed on resume: --frob\n' +
      'skydeck: not started through bin/skydeck\n' +
      'skydeck: to start it yourself, run:\n' +
      `${fallback(dir, ['claude', '--resume', S1])}\n`,
  );
});

test('resume names two unknown flags in order, separated by a space', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude', '--zeta', '--model', 'opus', '--alpha=1'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  assert.equal(
    d.stderr(),
    'skydeck: started with flags skydeck does not know, not passed on resume: --zeta --alpha\n',
  );
});

test('resume prints the name of an unknown flag sanitised', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude', '--fr\x1b[31mob'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  assert.equal(
    d.stderr(),
    'skydeck: started with flags skydeck does not know, not passed on resume: --frob\n',
  );
});

test('resume never adds a permission flag', async (t) => {
  const d = deck(t);
  session(d, { argv: ['claude', '--model', 'opus'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  const script = handoff(d);
  assert.equal(script.includes('--dangerously-skip-permissions'), false);
  assert.equal(script.includes('--permission-mode'), false);
  assert.equal(script.includes('--allow-dangerously-skip-permissions'), false);
});

test('resume keeps the permission flag the session was started with, once', async (t) => {
  const d = deck(t);
  const dir = session(d, { argv: ['claude', '--permission-mode', 'acceptEdits'] });
  assert.equal(await main(['resume', '0b5f'], d.ctx), 0);
  assert.equal(
    handoff(d),
    handoffScript({
      cwd: dir,
      argv: ['claude', '--resume', S1, '--permission-mode', 'acceptEdits'],
    }),
  );
});

for (const code of ['EACCES', 'EMFILE']) {
  test(`a holder whose /proc cannot be read (${code}) is never taken as gone: resume stops, starts nothing, takes no lock`, async (t) => {
    const d = deck(t);
    session(d, { argv: ['claude'], running: true });
    const realStat = d.proc.stat.bind(d.proc);
    d.proc.stat = (pid) => {
      if (pid === 4242) {
        throw Object.assign(new Error(`cannot read /proc/4242/stat (${code})`), { code });
      }
      return realStat(pid);
    };
    const { ctx, runner } = withRunner(d, () => runResult({}));

    assert.equal(await main(['resume', '0b5f', '--here'], ctx), 1);

    assert.ok(d.stderr().includes(code), d.stderr());
    assert.equal(existsSync(handoffPath(d)), false);
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
  });
}

// ---------------------------------------------------------------------------------------------
// resume --window (S2 11.4; plan C11, C12, 2.5; task 76): the command sends the session id its
// <ref> resolved to to the window's server — the fake serve of test/fixtures/fake-serve, which
// answers with the server's own handler — and prepares, locks and starts nothing itself. The fake
// serve listens on no port and the Edge stub opens no page, so a window the command opens is never
// used: with pages 0 it ends after `pageMs` with C12's line.

/** The waits of these cases (A31): a short page wait (no page ever uses the window), and ping and
 *  answer waits no load runs out where a case expects none. */
const WINDOW_TIMES = 'pingMs=5000,pageMs=300,reuseMs=100,answerMs=20000';
/** For the cases that wait for a ping or an answer to run out: 1 s and 2 s. */
const SHORT_TIMES = 'pingMs=1000,pageMs=300,reuseMs=100,answerMs=2000';
const NO_PAGE_CONNECTED =
  'skydeck: the window could not be opened: Edge was started, but no window connected within 0.3 seconds; open the window in any browser with skydeck window --print-url; run skydeck window\n';
const FLAGS_LINE = 'skydeck: original flags unknown; resuming with defaults';

interface WindowCase {
  m: WindowMachine;
  /** The Edge stub's runs, each its arguments. */
  edgeCalls(): string[][];
  /** What reached the fake serve's launch (FAKE_SERVE_REQUESTS). */
  requests(): unknown[];
  /** `skydeck <argv>` on the machine; `env` over its environment; the control requests' paths. */
  run(argv: string[], env?: Record<string, string>): Promise<Lines & { asked: string[] }>;
  handoff: string;
}

/** A window machine with session S1 (a transcript only: not running) and the Edge stub. */
function windowCase(t: TestContext, window: Record<string, unknown> = {}): WindowCase {
  const handoffFile = (root: string): string => join(root, 'handoff');
  const m = windowMachine(t, {
    env: (s) => ({ SKYDECK_HANDOFF: handoffFile(s.root), SKYDECK_TEST_WINDOW_TIMES: WINDOW_TIMES }),
  });
  const stub = writeWindowConfig(m.s, window);
  const folder = join(m.deck.places.claudeHome, 'projects', 'demo');
  mkdirSync(folder, { recursive: true });
  const record = {
    type: 'user',
    sessionId: S1,
    timestamp: isoFromNs(T0),
    cwd: m.s.home,
    entrypoint: 'cli',
  };
  writeFileSync(join(folder, `${S1}.jsonl`), `${JSON.stringify(record)}\n`);
  const requests = join(m.s.root, 'requests.jsonl');
  return {
    m,
    edgeCalls: () => stub.edgeCalls(),
    requests: () =>
      existsSync(requests)
        ? readFileSync(requests, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as unknown)
        : [],
    async run(argv, env = {}) {
      const asked: string[] = [];
      const net: Net = {
        ...m.platform.net,
        requestUnix(path, request) {
          asked.push(`${request.method} ${request.path}`);
          return m.platform.net.requestUnix(path, request);
        },
      };
      const r = await runOn(m, argv, { net, env: { ...m.platform.env, ...env } });
      return { ...r, asked };
    },
    handoff: handoffFile(m.s.root),
  };
}

/** The fake serve of `w`, recording the launch requests, answering `answer` to /resume and /new. */
async function serving(
  t: TestContext,
  w: WindowCase,
  answer: unknown,
  env: Record<string, string> = {},
): Promise<void> {
  await startFakeServe(t, w.m, {
    FAKE_SERVE_REQUESTS: join(w.m.s.root, 'requests.jsonl'),
    FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(answer)}`,
    ...env,
  });
}

const STARTED: LaunchAnswer = { code: 0, lines: [FLAGS_LINE], sessionId: S1 };

describe('resume --window (S2 11.4; plan C11, C12)', () => {
  test('a page connected: the answer’s lines on stderr, its code; the resolved id sent; no handoff, no lock, no window', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED, { FAKE_SERVE_PAGES: '1' });

    const r = await w.run(['resume', '0b5f', '--window']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, `${FLAGS_LINE}\n`);
    assert.equal(r.stdout, '');
    assert.deepEqual(w.requests(), [{ route: 'resume', sessionId: S1 }]);
    assert.equal(existsSync(w.handoff), false, 'no handoff file');
    assert.deepEqual(w.m.deck.store.kvEntries('resume_lock:'), [], 'the command took no lock');
    assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('no page connected: a window opened as skydeck window opens one — Edge once with a token, the token given up — and C12’s line; the exit code stays the answer’s', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED);

    const r = await w.run(['resume', '0b5f', '--window']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, `${FLAGS_LINE}\n${NO_PAGE_CONNECTED}`);
    await until(() => w.edgeCalls().length === 1, 'the Edge stub ran', 10_000);
    const app = w.edgeCalls()[0]?.find((arg) => arg.startsWith('--app='));
    assert.match(app ?? '', /^--app=http:\/\/127\.0\.0\.1:47613\/#t=[A-Za-z0-9_-]{43}$/);
    assert.ok(r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.ok(r.asked.includes('POST /token/drop'), 'the token given up');
    assert.equal(w.m.deck.store.getKv('window_launching'), null, 'the launching lock given up');
  });

  test('Edge missing: C12’s line with S2 5.3’s reason, exit 0', async (t) => {
    const w = windowCase(t, { edge: '/nowhere/msedge' });
    await serving(t, w, STARTED);

    const r = await w.run(['resume', '0b5f', '--window']);

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.stderr.startsWith(`${FLAGS_LINE}\nskydeck: the window could not be opened: `),
      r.stderr,
    );
    assert.ok(r.stderr.endsWith('; run skydeck window\n'), r.stderr);
    assert.ok(r.stderr.includes('/nowhere/msedge'), r.stderr);
    assert.ok(r.asked.includes('POST /token/drop'), 'the token given up');
  });

  test('an answer with code 4 (refused): exit 4, and a window is opened', async (t) => {
    const w = windowCase(t);
    const refused = {
      code: 4,
      lines: ['skydeck: 0b5f3c1e is running (pid 4242)'],
      sessionId: null,
    };
    await serving(t, w, refused);

    const r = await w.run(['resume', '0b5f', '--window']);

    assert.equal(r.code, 4, r.stderr);
    assert.equal(r.stderr, `skydeck: 0b5f3c1e is running (pid 4242)\n${NO_PAGE_CONNECTED}`);
    await until(() => w.edgeCalls().length === 1, 'the Edge stub ran', 10_000);
  });

  test('an answer with code 2 or 3: that exit, and no window (nothing was started)', async (t) => {
    for (const code of [2, 3]) {
      const w = windowCase(t);
      await serving(t, w, { code, lines: [`skydeck: refused ${code}`], sessionId: null });

      const r = await w.run(['resume', '0b5f', '--window']);

      assert.equal(r.code, code, r.stderr);
      assert.equal(r.stderr, `skydeck: refused ${code}\n`);
      assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
      assert.ok(!r.asked.includes('GET /status'), 'not even asked for its pages');
      assert.deepEqual(w.edgeCalls(), []);
    }
  });

  test('a code that is not 0–5 is exit 1', async (t) => {
    const w = windowCase(t);
    await serving(t, w, { code: 7, lines: [], sessionId: null }, { FAKE_SERVE_PAGES: '1' });
    assert.equal((await w.run(['resume', '0b5f', '--window'])).code, 1);
    const v = windowCase(t);
    await serving(t, v, { code: -1, lines: [], sessionId: null }, { FAKE_SERVE_PAGES: '1' });
    assert.equal((await v.run(['resume', '0b5f', '--window'])).code, 1);
  });

  test('under CLAUDECODE a command opens no window: the request sent, Edge never run, C12’s line, the answer’s code', async (t) => {
    const w = windowCase(t);
    await serving(t, w, { ...STARTED, code: 4 });

    const r = await w.run(['resume', '0b5f', '--window'], { CLAUDECODE: '1' });

    assert.equal(r.code, 4, r.stderr);
    assert.equal(
      r.stderr,
      `${FLAGS_LINE}\nskydeck: no window is open; run skydeck window in a terminal of your own\n`,
    );
    assert.deepEqual(w.requests(), [{ route: 'resume', sessionId: S1 }]);
    assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('CLAUDECODE set to the empty text is set: no window, C12’s line (as skydeck window refuses it)', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED);

    const r = await w.run(['resume', '0b5f', '--window'], { CLAUDECODE: '' });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      `${FLAGS_LINE}\nskydeck: no window is open; run skydeck window in a terminal of your own\n`,
    );
    assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('under CLAUDECODE with a page connected: nothing more is said', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED, { FAKE_SERVE_PAGES: '1' });

    const r = await w.run(['resume', '0b5f', '--window'], { CLAUDECODE: '1' });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, `${FLAGS_LINE}\n`);
  });

  test('the status look after the answer fails: C12’s line with the failure as its reason; the exit code stays the answer’s (ruled, task 76)', async (t) => {
    // An old server's /status the client cannot read whole: the look for a page fails.
    const w = windowCase(t);
    await serving(t, w, { ...STARTED, code: 4 }, { FAKE_SERVE_STATUS: 'pages-only' });

    const r = await w.run(['resume', '0b5f', '--window']);

    assert.equal(r.code, 4, r.stderr);
    assert.equal(
      r.stderr,
      `${FLAGS_LINE}\nskydeck: the window could not be opened: the window's server gave an answer to GET /status that cannot be read; run skydeck window\n`,
    );
    assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('the status look fails under CLAUDECODE: the same line, its advice ending "in a terminal of your own" (ruled, task 76)', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED, { FAKE_SERVE_STATUS: 'pages-only' });

    const r = await w.run(['resume', '0b5f', '--window'], { CLAUDECODE: '1' });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      `${FLAGS_LINE}\nskydeck: the window could not be opened: the window's server gave an answer to GET /status that cannot be read; run skydeck window in a terminal of your own\n`,
    );
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('the window a command opens keeps C20’s wait: a window the server expects back is waited for, not opened beside it', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED, {
      FAKE_SERVE_WINDOW_EXPECTED_MS: '5000',
      FAKE_SERVE_PAGES_AFTER: '600:1',
    });

    const r = await w.run(['resume', '0b5f', '--window']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      `${FLAGS_LINE}\nskydeck: waiting up to 7 s for the open window to come back; --new-window opens one now\n`,
    );
    assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('the store locked past its busy timeout while the window’s lock is taken: C12’s line with the failure, the answer’s code (review 2)', async (t) => {
    const w = windowCase(t);
    await serving(t, w, { ...STARTED, code: 4 });
    let other: DatabaseSync | null = null;
    t.after(() => {
      try {
        other?.exec('ROLLBACK');
      } catch {
        // nothing held
      }
      other?.close();
    });
    const net: Net = {
      ...w.m.platform.net,
      async requestUnix(path, request) {
        const answer = await w.m.platform.net.requestUnix(path, request);
        if (request.path === '/status' && other === null) {
          // Another process writes the store for longer than the command's busy timeout.
          other = new DatabaseSync(w.m.deck.places.dbPath);
          other.exec('BEGIN IMMEDIATE');
        }
        return answer;
      },
    };

    const r = await runOn(w.m, ['resume', '0b5f', '--window'], { net });

    assert.equal(r.code, 4, r.stderr);
    assert.equal(
      r.stderr,
      `${FLAGS_LINE}\nskydeck: the window could not be opened: the database ${w.m.deck.places.dbPath} failed: database is locked; run skydeck window\n`,
    );
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('the answer’s lines are printed sanitised: no escape sequence, no CR', async (t) => {
    const w = windowCase(t);
    await serving(
      t,
      w,
      {
        code: 1,
        lines: ['skydeck: \u001b[31mred\u001b[0m\rover', '\u001b]0;title\u0007x'],
        sessionId: null,
      },
      { FAKE_SERVE_PAGES: '1' },
    );

    const r = await w.run(['resume', '0b5f', '--window']);

    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stderr, 'skydeck: red over\nx\n');
  });

  test('--here --window and --tab --window are usage errors: exit 2, nothing sent', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED);
    for (const other of ['--here', '--tab']) {
      const r = await w.run(['resume', '0b5f', other, '--window']);
      assert.equal(r.code, 2, other);
      assert.ok(
        r.stderr.startsWith(`skydeck: ${other} and --window cannot be used together\n`),
        r.stderr,
      );
      assert.deepEqual(r.asked, [], other);
    }
    const three = await w.run(['resume', '0b5f', '--here', '--tab', '--window']);
    assert.equal(three.code, 2);
    assert.ok(
      three.stderr.startsWith('skydeck: --here, --tab and --window cannot be used together\n'),
      three.stderr,
    );
    assert.deepEqual(w.requests(), []);
  });

  test('an unknown <ref> is exit 3 as today, nothing sent', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED);

    const r = await w.run(['resume', 'nope-nope', '--window']);

    assert.equal(r.code, 3, r.stderr);
    assert.deepEqual(r.asked, []);
  });
});

describe('resume --window: the lines of plan 2.5 (exit 1, no window, no command printed)', () => {
  /** The case's run and its checks: `line` on stderr, exit 1, Edge never run, no command. */
  async function refused(
    w: WindowCase,
    line: string,
    env: Record<string, string> = {},
  ): Promise<void> {
    const r = await w.run(['resume', '0b5f', '--window'], env);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stderr, `skydeck: ${line}\n`);
    assert.equal(r.stdout, '');
    assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.deepEqual(w.edgeCalls(), []);
    assert.equal(existsSync(w.handoff), false);
  }

  test('no server', async (t) => {
    await refused(
      windowCase(t),
      'the window is not running; run skydeck window first, or use --here',
    );
  });

  test('a server that does not answer', async (t) => {
    const w = windowCase(t);
    const fake = await startFakeServe(t, w.m, { FAKE_SERVE_MODE: 'silent' });
    await refused(
      w,
      `the window's server (pid ${fake.pid}) does not answer; skydeck window --restart stops it`,
      { SKYDECK_TEST_WINDOW_TIMES: SHORT_TIMES },
    );
  });

  test('a server of another checkout', async (t) => {
    const w = windowCase(t);
    await startFakeServe(t, w.m, { FAKE_SERVE_CHECKOUT: '/elsewhere/skydeck' });
    await refused(
      w,
      "the window's server runs from /elsewhere/skydeck, not from this checkout; skydeck window --restart here replaces it, or use --here",
    );
  });

  test('an older server (no stage C routes)', async (t) => {
    const w = windowCase(t);
    await startFakeServe(t, w.m);
    await refused(
      w,
      "the window's server is older than this command and cannot start sessions for it; run skydeck window to restart it, or use --here",
    );
  });

  test('a server that is stopping', async (t) => {
    const w = windowCase(t);
    await serving(t, w, STARTED, { FAKE_SERVE_STATE: 'stopping' });
    await refused(w, "the window's server is stopping; run skydeck window, or use --here");
  });

  test('a refused body (413)', async (t) => {
    const w = windowCase(t);
    await startFakeServe(t, w.m, { FAKE_SERVE_LAUNCH: 'status:413' });
    await refused(w, "the window's server refused the request (body: too long); use --here");
  });

  test('no answer within answerMs: 11.4’s line, no command printed', async (t) => {
    const w = windowCase(t);
    await startFakeServe(t, w.m, { FAKE_SERVE_LAUNCH: 'silent' });
    await refused(
      w,
      "the window's server did not answer within 2 s; it may have started the session: run skydeck to see whether it runs",
      { SKYDECK_TEST_WINDOW_TIMES: SHORT_TIMES },
    );
  });
});
