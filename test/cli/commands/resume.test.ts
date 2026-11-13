import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Context } from '../../../src/cli/context.ts';
import { main } from '../../../src/cli/main.ts';
import { isoFromNs } from '../../../src/platform/time.ts';
import { lockKey } from '../../../src/sessions/resume.ts';
import type { RunResult } from '../../../src/platform/types.ts';
import { handoffScript } from '../../../src/terminals/here.ts';
import { shellQuote } from '../../../src/text/shell.ts';
import { testDeck } from '../../helpers/deck.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { fakeRunner, runResult, S1, SEC, T0, statLine } from '../../helpers/platform.ts';
import type { FakeRunner } from '../../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../../helpers/spool.ts';

const USAGE_FIRST_LINE = 'skydeck resume <ref> [--here | --tab]\n';

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
