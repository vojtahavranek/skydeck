import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Context } from '../../../src/cli/context.ts';
import { main } from '../../../src/cli/main.ts';
import { isoFromNs } from '../../../src/platform/time.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { acquireLock } from '../../../src/sessions/resume.ts';
import { handoffScript } from '../../../src/terminals/here.ts';
import { shellQuote } from '../../../src/text/shell.ts';
import { testContext } from '../../helpers/context.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import {
  BOOT_A,
  BOOT_B,
  SEC,
  T0,
  fakeRunner,
  runResult,
  statLine,
} from '../../helpers/platform.ts';
import {
  BOOT_C,
  DAY,
  HOUR,
  MINUTE,
  NOW,
  PROC_START,
  addSession,
  projectDir,
  restoreDeck,
  resumedId,
  sid,
  startClaude,
} from '../../helpers/restore.ts';

const USAGE_FIRST_LINE = 'skydeck restore [--all] [--dry-run] [--yes]\n';
const PROMPT = 'Toggle numbers, Enter to start, q to cancel: ';

type Options = Parameters<typeof restoreDeck>[1];

/**
 * After a restart (current boot BOOT_B): in BOOT_A, sid(1) still held at the last event, sid(2)
 * ended 30 s before BOOT_A's last event, sid(3) ten minutes before, sid(4) exited deliberately at
 * T0 (BOOT_A's last event); sid(5) held in the older BOOT_C; sid(6) died in the current boot. The
 * default list order is sid(1), sid(2), sid(3).
 */
function machine(t: Parameters<typeof restoreDeck>[0], options: Options = {}): TestDeck {
  const d = restoreDeck(t, options);
  const startNs = T0 - HOUR;
  addSession(d, sid(1), { boot: BOOT_A, pid: 101, startNs, activityNs: T0 - 10n * SEC });
  addSession(d, sid(2), {
    boot: BOOT_A,
    pid: 102,
    startNs,
    activityNs: T0 - 2n * MINUTE,
    end: { detail: 'other', atNs: T0 - 30n * SEC },
  });
  addSession(d, sid(3), {
    boot: BOOT_A,
    pid: 103,
    startNs,
    activityNs: T0 - 15n * MINUTE,
    end: { detail: 'other', atNs: T0 - 10n * MINUTE },
  });
  addSession(d, sid(4), {
    boot: BOOT_A,
    pid: 104,
    startNs,
    activityNs: T0 - 20n * MINUTE,
    end: { detail: 'exit', atNs: T0 },
  });
  addSession(d, sid(5), { boot: BOOT_C, pid: 105, startNs: T0 - DAY });
  addSession(d, sid(6), { boot: BOOT_B, pid: 106, startNs: NOW - HOUR });
  return d;
}

const handoffPath = (d: TestDeck): string => join(d.sandbox.root, 'handoff');

function titleOf(d: TestDeck, id: string): string {
  return loadRows(d.deck).find((row) => row.id === id)?.title ?? '?';
}

function command(d: TestDeck, id: string): string {
  return `cd -- ${projectDir(d)} && claude --resume ${id}`;
}

/** What restore prints for a session it does not start itself. */
function resumeLine(id: string): string {
  return `skydeck resume ${id} --here`;
}

/** The context of `d` with a runner whose WezTerm tabs start claude for the sessions in `starting`. */
function withTabs(d: TestDeck, starting: readonly string[]): Context {
  const runner = fakeRunner((call) => {
    const id = resumedId(call.args);
    if (starting.includes(id)) {
      startClaude(d, id);
    }
    return runResult({});
  });
  return { ...d.ctx, platform: { ...d.platform, runner } };
}

test('restore --help prints the usage and exits 0', async () => {
  const c = testContext();
  assert.equal(await main(['restore', '--help'], c.ctx), 0);
  assert.ok(c.stdout().startsWith(USAGE_FIRST_LINE), c.stdout());
  // What it prints without a tab terminal: a resume line per session it does not start itself.
  assert.ok(c.stdout().includes('"skydeck resume <id> --here"'), c.stdout());
  assert.equal(c.stderr(), '');
});

test('restore with an argument is a usage error', async (t) => {
  const d = machine(t);
  assert.equal(await main(['restore', 'extra'], d.ctx), 2);
  assert.ok(d.stderr().includes(USAGE_FIRST_LINE), d.stderr());
});

test('restore --dry-run prints the default entries and their commands, and opens nothing', async (t) => {
  const d = machine(t);
  assert.equal(await main(['restore', '--dry-run'], d.ctx), 0);
  assert.equal(
    d.stdout(),
    `1. [x] 00000001  ${titleOf(d, sid(1))}  no exit recorded\n` +
      `    ${command(d, sid(1))}\n` +
      `2. [x] 00000002  ${titleOf(d, sid(2))}  ended ${isoFromNs(T0 - 30n * SEC)}\n` +
      `    ${command(d, sid(2))}\n` +
      `3. [ ] 00000003  ${titleOf(d, sid(3))}  ended ${isoFromNs(T0 - 10n * MINUTE)}\n` +
      `    ${command(d, sid(3))}\n`,
  );
  assert.equal(d.stderr(), '');
  assert.equal(existsSync(handoffPath(d)), false);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('restore --all --dry-run lists what ended unexpectedly in the older and the current boot too', async (t) => {
  const d = machine(t);
  assert.equal(await main(['restore', '--all', '--dry-run'], d.ctx), 0);
  const listed = [...d.stdout().matchAll(/^\d+\. \[[x ]\] (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(listed.toSorted(), ['00000001', '00000002', '00000003', '00000005', '00000006']);
});

test('restore --dry-run says when a session was working', async (t) => {
  const d = machine(t);
  // A user record after the assistant's: a turn was in progress.
  addSession(d, sid(7), {
    boot: BOOT_A,
    pid: 107,
    startNs: T0 - HOUR,
    activityNs: T0 - 5n * MINUTE,
  });
  const path = join(d.deck.places.claudeHome, 'projects', 'demo', `${sid(7)}.jsonl`);
  const lines = readFileSync(path, 'utf8').split('\n');
  const [user = '', assistant = ''] = lines;
  writeFileSync(path, `${assistant}\n${user}\n`);
  assert.equal(await main(['restore', '--dry-run'], d.ctx), 0);
  assert.ok(
    d.stdout().includes(`[x] 00000007  ${titleOf(d, sid(7))}  no exit recorded  was working\n`),
    d.stdout(),
  );
});

test('restore without --yes when stdin is not a terminal is a usage error', async (t) => {
  const d = machine(t);
  assert.equal(await main(['restore'], d.ctx), 2);
  assert.ok(d.stderr().includes('--yes'), d.stderr());
  assert.equal(existsSync(handoffPath(d)), false);
});

test('restore --yes hands off the first preselected session and prints a skydeck resume of the next', async (t) => {
  const d = machine(t);
  assert.equal(await main(['restore', '--yes'], d.ctx), 0);
  assert.equal(
    readFileSync(handoffPath(d), 'utf8'),
    handoffScript({ cwd: projectDir(d), argv: ['claude', '--resume', sid(1)] }),
  );
  const out = d.stdout();
  assert.ok(
    out.includes(
      `to resume these yourself, run:\n00000002 ${shellQuote(titleOf(d, sid(2)))} in ${shellQuote(projectDir(d))}:\n${resumeLine(sid(2))}\n`,
    ),
    out,
  );
  assert.equal(out.includes('cd --'), false, out);
  assert.equal(out.includes(sid(3)), false, out);
  assert.deepEqual(
    d.deck.store.kvEntries('resume_lock:').map((entry) => entry.key),
    [`resume_lock:${sid(1)}`],
  );
  assert.equal(d.stderr(), ''); // nothing failed: no summary before the hand-off
});

test('before a hand-off restore says on stderr how many sessions failed: the exit status will be claude’s', async (t) => {
  const d = machine(t, { stdinTTY: true, lines: ['3', ''] });
  // Another skydeck is resuming sid(2): it fails; sid(1) is handed off, sid(3) printed.
  acquireLock(d.deck, sid(2), { latestEventId: d.deck.store.latestEventIdOfSession(sid(2)) });
  assert.equal(await main(['restore'], d.ctx), 1);
  assert.ok(existsSync(handoffPath(d)));
  assert.ok(d.stdout().includes('failed 00000002: 00000002 is being resumed by another skydeck\n'));
  assert.ok(d.stdout().includes(`${resumeLine(sid(3))}\n`), d.stdout());
  // After the prompts (stderr too); the printed sid(3) is not counted: its line is the user's to run.
  assert.equal(
    d.stderr(),
    `${PROMPT}${PROMPT}skydeck: 1 of 3 selected sessions could not be resumed; see above\n`,
  );
});

test('the line restore prints runs the guard when the user runs it: a session resumed meanwhile is refused', async (t) => {
  const d = machine(t);
  assert.equal(await main(['restore', '--yes'], d.ctx), 0);
  assert.ok(d.stdout().includes(`${resumeLine(sid(2))}\n`), d.stdout());
  // Minutes later, before the user pastes the line, sid(2) has been resumed in another terminal.
  d.clock.setNs(NOW + 5n * MINUTE);
  startClaude(d, sid(2), 4242);
  const [program, ...args] = resumeLine(sid(2)).split(' ');
  assert.equal(program, 'skydeck');
  assert.equal(await main(args, d.ctx), 4);
  assert.ok(d.stderr().endsWith('skydeck: 00000002 is running (pid 4242)\n'), d.stderr());
});

test('restore at a terminal: the user toggles entry 3 on, and the run includes it', async (t) => {
  const d = machine(t, { stdinTTY: true, lines: ['3', ''] });
  assert.equal(await main(['restore'], d.ctx), 0);
  assert.deepEqual(d.prompts, [PROMPT, PROMPT]);
  const out = d.stdout();
  assert.ok(out.includes(`3. [ ] 00000003`), out);
  assert.ok(out.includes(`3. [x] 00000003`), out);
  assert.ok(out.includes(`${resumeLine(sid(2))}\n`), out);
  assert.ok(out.includes(`${resumeLine(sid(3))}\n`), out);
  assert.equal(
    readFileSync(handoffPath(d), 'utf8'),
    handoffScript({ cwd: projectDir(d), argv: ['claude', '--resume', sid(1)] }),
  );
});

test('restore at a terminal: q cancels with exit 5 and starts nothing', async (t) => {
  const d = machine(t, { stdinTTY: true, lines: ['q'] });
  assert.equal(await main(['restore'], d.ctx), 5);
  assert.equal(existsSync(handoffPath(d)), false);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('restore at a terminal: the end of input cancels like q', async (t) => {
  const d = machine(t, { stdinTTY: true, lines: [] });
  assert.equal(await main(['restore'], d.ctx), 5);
  assert.equal(existsSync(handoffPath(d)), false);
});

test('restore at a terminal: a number not in the list is refused and asked again', async (t) => {
  const d = machine(t, { stdinTTY: true, lines: ['2 7', 'x', ''] });
  assert.equal(await main(['restore'], d.ctx), 0);
  assert.equal(d.prompts.length, 3);
  assert.ok(d.stderr().includes("'7' is not a number from 1 to 3"), d.stderr());
  assert.ok(d.stderr().includes("'x' is not a number from 1 to 3"), d.stderr());
  // Nothing of a refused line is toggled: entry 2 is still selected.
  assert.ok(d.stdout().includes(`${resumeLine(sid(2))}\n`), d.stdout());
});

test('restore at a terminal with everything toggled off starts nothing and exits 0', async (t) => {
  const d = machine(t, { stdinTTY: true, lines: ['1 2', ''] });
  assert.equal(await main(['restore'], d.ctx), 0);
  assert.ok(d.stdout().endsWith('nothing selected\n'), d.stdout());
  assert.equal(existsSync(handoffPath(d)), false);
});

test('restore with nothing to restore says so and exits 0', async (t) => {
  const d = restoreDeck(t);
  assert.equal(await main(['restore', '--yes'], d.ctx), 0);
  assert.equal(d.stdout(), 'nothing to restore\n');
  assert.equal(d.stderr(), '');
});

test('restore exits 1 when one session did not start in time', async (t) => {
  const d = machine(t, { config: { terminal: 'wezterm', restoreStartTimeoutSeconds: 3 } });
  const ctx = withTabs(d, [sid(1)]);
  assert.equal(await main(['restore', '--yes'], ctx), 1);
  const out = d.stdout();
  assert.ok(out.includes(`started 00000001 ${titleOf(d, sid(1))}\n`), out);
  assert.ok(out.includes(`timed out 00000002 ${titleOf(d, sid(2))}\n`), out);
});

test('restore exits 0 when every selected session started in its tab', async (t) => {
  const d = machine(t, { config: { terminal: 'wezterm' } });
  assert.equal(await main(['restore', '--yes'], withTabs(d, [sid(1), sid(2)])), 0);
  assert.equal(d.stderr(), '');
});

test('restore exits 1 when a selected session was refused', async (t) => {
  const d = machine(t, { config: { terminal: 'wezterm' } });
  // While the first tab opens, sid(2) is resumed somewhere else.
  const runner = fakeRunner((call) => {
    if (resumedId(call.args) === sid(1)) {
      startClaude(d, sid(1));
      startClaude(d, sid(2), 4242);
    }
    return runResult({});
  });
  assert.equal(
    await main(['restore', '--yes'], { ...d.ctx, platform: { ...d.platform, runner } }),
    1,
  );
  assert.ok(d.stdout().includes('failed 00000002: 00000002 is running (pid 4242)\n'), d.stdout());
  assert.equal(d.stderr(), ''); // no hand-off: the exit status says it
});

test('restore exits 5 when memory is short, listing what was not started', async (t) => {
  const d = machine(t, { config: { terminal: 'wezterm' }, memAvailableMb: 3000 });
  const ctx = withTabs(d, [sid(1), sid(2)]);
  assert.equal(await main(['restore', '--yes'], ctx), 5);
  const out = d.stdout();
  assert.ok(out.includes(`not started 00000001 ${titleOf(d, sid(1))}\n`), out);
  assert.ok(out.includes(`not started 00000002 ${titleOf(d, sid(2))}\n`), out);
  assert.ok(d.stderr().startsWith('skydeck: restore stopped'), d.stderr());
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('restore with no session at all says there is nothing to restore, even without a boot id', async (t) => {
  // No rows carry a boot id, and there is nothing that could be offered by mistake.
  const d = restoreDeck(t);
  d.proc.setBootId(null);
  assert.equal(await main(['restore', '--yes'], d.ctx), 0);
  assert.equal(d.stdout(), 'nothing to restore\n');
  assert.equal(d.stderr(), '');
});

test('restore refuses to run when the boot id cannot be read', async (t) => {
  const d = machine(t);
  d.proc.setBootId(null);
  assert.equal(await main(['restore', '--yes'], d.ctx), 1);
  assert.ok(d.stderr().includes('boot id'), d.stderr());
  assert.equal(existsSync(handoffPath(d)), false);
});

test('restore decides on the boot id its rows were loaded with: a read that failed there is never mixed with one that worked', async (t) => {
  // Whichever read of the boot id fails, a session running now is never offered: without the boot
  // id every process looks dead, and its session would look as if it had ended unexpectedly.
  for (let failing = 1; failing <= 6; failing++) {
    const d = machine(t);
    addSession(d, sid(7), { boot: BOOT_B, pid: 107, startNs: NOW - HOUR });
    d.proc.setProcess(107, { stat: statLine(107, PROC_START), cmdline: ['claude'] });
    const real = d.proc.bootId;
    let reads = 0;
    d.proc.bootId = () => (++reads === failing ? null : real());
    const code = await main(['restore', '--all', '--dry-run'], d.ctx);
    const out = d.stdout();
    assert.equal(out.includes('00000007'), false, `read ${failing} failed:\n${out}`);
    assert.equal(code, out === '' ? 1 : 0, `read ${failing} failed: ${d.stderr()}`);
  }
});

test('restore --dry-run never prints a command that holds control characters', async (t) => {
  const d = restoreDeck(t);
  addSession(d, sid(1), {
    boot: BOOT_A,
    pid: 101,
    startNs: T0 - HOUR,
    argv: ['claude', '--model', 'op\x1b]0;x\x07us'],
  });
  assert.equal(await main(['restore', '--dry-run'], d.ctx), 0);
  const out = d.stdout();
  assert.ok(out.includes('control characters'), out);
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(out), false, JSON.stringify(out));
  assert.equal(out.includes('cd --'), false, out);
});
