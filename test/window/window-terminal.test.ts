// The window terminal (S2 11.2, 7.1, 7.4; plan task 21): step 1's launchPrepared starting sessions
// in keepers, the program's environment, what an exit means for the lock and for a new session's
// label and group, and starts that fail or time out. Platform: realTestPlatform with a deck (the
// window-deck helper); real keepers through a registry; the stand-in as claudeCommand.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { buildNewCommand, buildResumeCommand } from '../../src/claude/launch.ts';
import { CLAUDE_CHILD_VARIABLES } from '../../src/claude/terminal.ts';
import { launchPrepared, launchSpec, startDeadline } from '../../src/sessions/launch.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { runRestore } from '../../src/sessions/restore.ts';
import { lockKey, prepareNew, readLock } from '../../src/sessions/resume.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import type { KeeperHello } from '../../src/window/frames.ts';
import type { Terminal } from '../../src/terminals/types.ts';
import type { Registry } from '../../src/window/terminals.ts';
import { decideFoundKeeper, settleEndedTerminal } from '../../src/window/starts.ts';
import { windowTerminal } from '../../src/window/window-terminal.ts';
import { sleep, startProgram, until, within } from '../helpers/keeper.ts';
import { info } from '../helpers/registry.ts';
import type { TestRegistry } from '../helpers/registry.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import type { StandinRecord } from '../helpers/standin.ts';
import { windowDeck } from '../helpers/window-deck.ts';
import type { WindowDeck } from '../helpers/window-deck.ts';

type StartRecord = Extract<StandinRecord, { ev: 'start' }>;
const isStart = (r: StandinRecord): r is StartRecord => r.ev === 'start';

const PYTHON_MISSING =
  'python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)';
const SIZE = { cols: 100, rows: 30 };

/** The terminal a launch opened: the only one of the registry, or the one of `sessionId`. */
function opened(r: TestRegistry, sessionId?: string): string {
  const all = r.registry
    .list()
    .filter((x) => sessionId === undefined || x.expectedSessionId === sessionId);
  assert.equal(all.length, 1, `one terminal (${r.registry.list().length} listed)`);
  return (all[0] as { id: string }).id;
}

/** The latest hello the registry reported for the terminal (what task 23 keeps per terminal). */
function helloOf(r: TestRegistry, termId: string): KeeperHello {
  const found = r.events.hello.filter((e) => e.hello.id === termId).at(-1);
  assert.ok(found, `a hello of ${termId}`);
  return found.hello;
}

/** The soft and hard core limits of a process as /proc/<pid>/limits writes them. */
function coreLimits(pid: number | 'self'): { soft: string; hard: string } {
  const line = readFileSync(`/proc/${pid}/limits`, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('Max core file size'));
  const fields = (line ?? '').slice('Max core file size'.length).trim().split(/\s+/);
  return { soft: fields[0] ?? '', hard: fields[1] ?? '' };
}

/** python3 that sleeps `seconds` (7: a hello after the 5 s wait) before it runs the real one. */
function slowPython(w: WindowDeck, seconds = 7): string {
  const slow = join(w.s.root, 'slow-bin');
  mkdirSync(slow, { recursive: true });
  const script = join(slow, 'python3');
  writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\nexec ${join(w.s.bin, 'python3')} "$@"\n`);
  chmodSync(script, 0o755);
  return `${slow}:${w.s.bin}`;
}

describe('window terminal: sessions start through step 1’s launch', () => {
  test('a resume: code 0, the stand-in runs buildResumeCommand’s arguments in the session’s directory at the first size; the meta', async (t) => {
    const w = await windowDeck(t);
    const dir = w.resumable(S1);
    w.deck.store.updateMeta(S1, { label: 'fix it' }, w.tp.platform.clock.nowNs());
    const r = w.registry();
    const { deps, record } = w.deps(r);
    const prepared = prepareResumeById(w.deck, S1);
    const lock = readLock(w.deck, S1);
    assert.ok(lock !== null);
    const outcome = await launchPrepared(w.deck, prepared, windowTerminal(deps, SIZE));
    assert.deepEqual(outcome, {
      code: 0,
      lines: ['skydeck: original flags unknown; resuming with defaults'],
    });
    const start = await waitForRecord(record, isStart, 15_000);
    const command = buildResumeCommand({
      claudeCommand: w.standin,
      launch: null,
      sessionId: S1,
      label: 'fix it',
    });
    assert.deepEqual(start.argv, command.argv.slice(1));
    assert.equal(start.cwd, dir);
    assert.deepEqual([start.cols, start.rows], [100, 30]);
    const id = opened(r);
    const term = info(r.registry, id);
    assert.equal(term.state, 'running');
    assert.equal(term.program?.pid, start.pid, 'open resolved on T: the program is known');
    assert.match(id, /^[0-9a-f]{12}$/);
    const hello = helloOf(r, id);
    assert.deepEqual(hello.meta, {
      sessionId: S1,
      kind: 'resume',
      slot: 1,
      openedNs: hello.meta.openedNs,
      build: 'test-build',
      label: 'fix it',
      dir,
    });
    assert.equal(hello.lock, lock);
    assert.equal(hello.startBy, String(startDeadline(prepared, lock)));
  });

  test('a new session: buildNewCommand’s arguments; the meta carries kind, label, directory and the next slot', async (t) => {
    const w = await windowDeck(t);
    const r = w.registry();
    w.resumable(S1);
    const first = w.deps(r);
    assert.equal(
      (
        await launchPrepared(
          w.deck,
          prepareResumeById(w.deck, S1),
          windowTerminal(first.deps, SIZE),
        )
      ).code,
      0,
    );
    const dir = join(w.s.home, 'new project');
    mkdirSync(dir);
    const { deps, record } = w.deps(r);
    const prepared = prepareNew(w.deck, {
      dir,
      label: 'fix the build',
      group: 'ops',
      extra: ['--model', 'opus'],
    });
    const outcome = await launchPrepared(
      w.deck,
      prepared,
      windowTerminal(deps, { cols: 90, rows: 20 }),
    );
    assert.deepEqual(outcome, { code: 0, lines: [] });
    const start = await waitForRecord(record, isStart, 15_000);
    const argv = buildNewCommand({
      claudeCommand: w.standin,
      sessionId: prepared.sessionId,
      label: 'fix the build',
      extra: ['--model', 'opus'],
    });
    assert.deepEqual(start.argv, argv.slice(1));
    assert.equal(start.cwd, dir);
    assert.deepEqual([start.cols, start.rows], [90, 20]);
    const hello = helloOf(r, opened(r, prepared.sessionId));
    assert.deepEqual(
      { ...hello.meta, openedNs: '' },
      {
        sessionId: prepared.sessionId,
        kind: 'new',
        slot: 2,
        openedNs: '',
        build: 'test-build',
        label: 'fix the build',
        dir,
      },
    );
    assert.equal(hello.lock, null);
  });

  test('the program’s environment: S2 7.4’s names removed, PWD, TERM, COLORTERM, WSL_INTEROP the link; the core limit', async (t) => {
    if (coreLimits('self').hard === '0') {
      t.skip('the hard core limit is 0 here: no soft limit can be given to the program');
      return;
    }
    const w = await windowDeck(t);
    const dir = w.resumable(S1);
    const r = w.registry();
    const removed: Record<string, string> = {
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.0',
      WT_SESSION: 'w',
      WT_PROFILE_ID: 'p',
      WEZTERM_PANE: '3',
      WEZTERM_UNIX_SOCKET: '/x',
      TMUX: '/tmp/tmux',
      TMUX_PANE: '%1',
      STY: 'screen',
      VTE_VERSION: '7000',
      KITTY_WINDOW_ID: '1',
      ITERM_SESSION_ID: 'i',
      KONSOLE_VERSION: '23',
      KONSOLE_DBUS_SESSION: 's',
      VSCODE_IPC_HOOK_CLI: '/v',
      VSCODE_GIT_ASKPASS_MAIN: '/askpass-main',
      GIT_ASKPASS: '/askpass.sh',
      GPG_TTY: '/dev/pts/9',
      SSH_TTY: '/dev/pts/8',
      CLAUDE_CODE_SSE_PORT: '1234',
      ENABLE_IDE_INTEGRATION: 'true',
      SKYDECK_HANDOFF: '/h',
      SKYDECK_LAUNCHER_CACHE: '/cache',
      NODE_COMPILE_CACHE: '/cache',
      SKYDECK_CORE_SOFT: '1',
      SKYDECK_ENV_ORIGIN: '/origin',
      ...Object.fromEntries(CLAUDE_CHILD_VARIABLES.map((name) => [name, 'x'])),
    };
    const { deps, record } = w.deps(r, {
      env: { WSL_INTEROP: '/run/WSL/99_interop', MY_OWN: 'kept' },
    });
    // Every removed name in the server environment as given, even those serverEnvironment drops.
    const link = w.files.interop;
    const terminal = windowTerminal(
      { ...deps, serverEnv: { ...deps.serverEnv, ...removed }, interop: () => link },
      SIZE,
    );
    assert.equal((await launchPrepared(w.deck, prepareResumeById(w.deck, S1), terminal)).code, 0);
    const start = await waitForRecord(record, isStart, 15_000);
    const leaked = Object.keys(removed).filter((name) => start.envNames.includes(name));
    assert.deepEqual(leaked, []);
    assert.ok(start.envNames.includes('MY_OWN'));
    assert.ok(start.envNames.includes('SKYDECK_HOME'));
    assert.deepEqual(start.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PWD: dir,
      WSL_INTEROP: link,
    });
    assert.equal(deps.coreSoft, '1');
    assert.equal(start.coreSoft, '1');
    assert.notEqual(coreLimits('self').soft, '1', 'the test process has another limit');
  });

  test('without a live interop link WSL_INTEROP stays as the server has it; coreSoft null keeps the keeper’s limit', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const r = w.registry();
    const { deps, record } = w.deps(r, {
      env: { WSL_INTEROP: '/run/WSL/99_interop', SKYDECK_CORE_SOFT: undefined },
    });
    assert.equal(deps.coreSoft, null);
    assert.equal(
      (await launchPrepared(w.deck, prepareResumeById(w.deck, S1), windowTerminal(deps, SIZE)))
        .code,
      0,
    );
    const start = await waitForRecord(record, isStart, 15_000);
    assert.equal(start.env.WSL_INTEROP, '/run/WSL/99_interop');
    assert.equal(start.coreSoft, coreLimits('self').soft);
  });
});

describe('window terminal: a program that ends before its session started', () => {
  test('claudeCommand that does not exist → ok on T, then X 127; settling releases the lock and a new session’s label and group', async (t) => {
    const w = await windowDeck(t, { claudeCommand: (s) => join(s.root, 'no-such-claude') });
    w.resumable(S1);
    const r = w.registry();
    const { deps } = w.deps(r);
    const outcome = await launchPrepared(
      w.deck,
      prepareResumeById(w.deck, S1),
      windowTerminal(deps, SIZE),
    );
    assert.equal(outcome.code, 0, 'open resolved ok on T: the fork happened');
    await until(() => r.events.exited.length === 1, 'the exit', 15_000);
    assert.equal(r.events.exited[0]?.exit.code, 127);
    const id = opened(r);
    assert.notEqual(readLock(w.deck, S1), null, 'launchPrepared kept the lock (it succeeded)');
    settleEndedTerminal(w.deck, helloOf(r, id));
    assert.equal(readLock(w.deck, S1), null);
    // A second resume is accepted at once, not "being resumed".
    prepareResumeById(w.deck, S1);

    const dir = join(w.s.home, 'elsewhere');
    mkdirSync(dir);
    const prepared = prepareNew(w.deck, { dir, label: 'try', group: 'ops', extra: [] });
    assert.equal((await launchPrepared(w.deck, prepared, windowTerminal(deps, SIZE))).code, 0);
    await until(() => r.events.exited.length === 2, 'the second exit', 15_000);
    assert.ok(w.deck.store.meta(prepared.sessionId));
    settleEndedTerminal(w.deck, helloOf(r, opened(r, prepared.sessionId)));
    assert.equal(w.deck.store.meta(prepared.sessionId), null);
  });

  test('a program that ends after its SessionStart was ingested: settling releases nothing (design 7.6’s rule)', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const r = w.registry();
    const { deps } = w.deps(r);
    assert.equal(
      (await launchPrepared(w.deck, prepareResumeById(w.deck, S1), windowTerminal(deps, SIZE)))
        .code,
      0,
    );
    const lock = readLock(w.deck, S1);
    const id = opened(r);
    await w.prompt(r, id, S1); // its SessionStart hook has run
    assert.equal(r.registry.input(id, new TextEncoder().encode('/fail 3\r')), 'ok');
    await until(() => r.events.exited.length === 1, 'the exit', 15_000);
    assert.equal(r.events.exited[0]?.exit.code, 3);
    settleEndedTerminal(w.deck, helloOf(r, id));
    assert.equal(readLock(w.deck, S1), lock, 'the start released it by 7.6; settling took nothing');
  });
});

describe('window terminal: starts that fail', () => {
  test('python3 missing → { ok: false, timedOut: false } with S2 14’s message; the lines end with the command', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const bare = join(w.s.root, 'bare-bin');
    mkdirSync(bare);
    const r = w.registry({
      platform: { ...w.tp.platform, env: { ...w.tp.platform.env, PATH: bare } },
    });
    const { deps } = w.deps(r);
    const prepared = prepareResumeById(w.deck, S1);
    const lock = readLock(w.deck, S1);
    const result = await windowTerminal(deps, SIZE).open(launchSpec(prepared, lock));
    assert.deepEqual(result, { ok: false, timedOut: false, error: PYTHON_MISSING });

    const outcome = await launchPrepared(w.deck, prepared, windowTerminal(deps, SIZE));
    assert.equal(outcome.code, 1);
    assert.ok(outcome.lines.includes(`skydeck: ${PYTHON_MISSING}`), outcome.lines.join('\n'));
    assert.equal(outcome.lines.at(-2), 'skydeck: to start it yourself, run:');
    assert.match(outcome.lines.at(-1) ?? '', /--resume/);
    assert.deepEqual(r.registry.list(), []);
  });

  test('windowTerminal only builds the adapter: nothing is spawned and no slot taken before open() (task 32’s terminalFor)', async (t) => {
    const w = await windowDeck(t);
    const r = w.registry();
    const { deps } = w.deps(r);
    const terminal = windowTerminal(deps, SIZE);
    assert.equal(terminal.name, 'window');
    assert.equal(terminal.opensTabs, true);
    assert.deepEqual(r.spawned, []);
    assert.deepEqual(r.registry.list(), []);
    assert.equal(r.registry.nextSlot(), 1);
  });

  test('a resume whose lock is null or not skydeck’s is not started: no keeper is spawned', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const r = w.registry();
    const { deps } = w.deps(r);
    const prepared = prepareResumeById(w.deck, S1);
    for (const lock of [null, 'not a lock']) {
      const spec = { ...launchSpec(prepared, readLock(w.deck, S1)), lock };
      const result = await windowTerminal(deps, SIZE).open(spec);
      assert.equal(result.ok, false, String(lock));
      assert.equal(result.ok ? null : result.timedOut, false);
    }
    assert.deepEqual(r.spawned, []);
    assert.deepEqual(r.registry.list(), []);
  });

  test('a deadline already passed → the keeper refuses G: “not started: …” as a timeout (ruled, S2): no command', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const r = w.registry();
    const { deps, record } = w.deps(r);
    const prepared = prepareResumeById(w.deck, S1);
    const spec = {
      ...launchSpec(prepared, readLock(w.deck, S1)),
      startByNs: w.tp.platform.clock.nowNs() - 1_000_000_000n,
    };
    const result = await windowTerminal(deps, SIZE).open(spec);
    assert.deepEqual(result, {
      ok: false,
      timedOut: true,
      error: 'not started: the start deadline passed',
    });
    assert.deepEqual(readRecords(record), [], 'nothing ran');
  });

  test('not started (the deadline passed): no by-hand command for a resume or a new session; settling the exit then gives back the lock, the label and the group', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const r = w.registry();
    const { deps, record } = w.deps(r);
    const past = w.tp.platform.clock.nowNs() - 1_000_000_000n;
    const window = windowTerminal(deps, SIZE);
    const tooLate: Terminal = {
      ...window,
      open: (spec) => window.open({ ...spec, startByNs: past }),
    };

    const outcome = await launchPrepared(w.deck, prepareResumeById(w.deck, S1), tooLate);
    assert.equal(outcome.code, 1);
    assert.ok(
      outcome.lines.includes('skydeck: not started: the start deadline passed'),
      outcome.lines.join('\n'),
    );
    assert.equal(
      outcome.lines.some((line) => line.includes('to start it yourself')),
      false,
    );
    assert.notEqual(readLock(w.deck, S1), null, 'kept until the exit is settled');
    const id = opened(r, S1);
    await until(() => info(r.registry, id).state === 'not-started', 'not started', 10_000);
    settleEndedTerminal(w.deck, helloOf(r, id));
    assert.equal(readLock(w.deck, S1), null);

    const dir = join(w.s.home, 'new one');
    mkdirSync(dir);
    const prepared = prepareNew(w.deck, { dir, label: 'try', group: 'ops', extra: [] });
    const fresh = await launchPrepared(w.deck, prepared, tooLate);
    assert.equal(fresh.code, 1);
    assert.equal(
      fresh.lines.some((line) => line.includes('to start it yourself')),
      false,
    );
    assert.ok(w.deck.store.meta(prepared.sessionId), 'kept until the exit is settled');
    const newId = opened(r, prepared.sessionId);
    await until(() => info(r.registry, newId).state === 'not-started', 'not started', 10_000);
    settleEndedTerminal(w.deck, helloOf(r, newId));
    assert.equal(w.deck.store.meta(prepared.sessionId), null);
    assert.deepEqual(readRecords(record), [], 'nothing ran');
  });

  test('a keeper that ends after its hello, before T → “not started” as a timeout: no command; settling gives the lock back', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const r = w.registry();
    const { deps, record } = w.deps(r);
    // G never reaches the keeper: the keeper is killed instead.
    const registry: Registry = {
      ...r.registry,
      start(termId) {
        w.signalKeeper(w.keeperOf(termId), 'SIGKILL');
      },
    };
    const outcome = await launchPrepared(
      w.deck,
      prepareResumeById(w.deck, S1),
      windowTerminal({ ...deps, registry }, SIZE),
    );
    assert.equal(outcome.code, 1);
    assert.ok(
      outcome.lines.includes('skydeck: not started: the keeper ended before the program started'),
      outcome.lines.join('\n'),
    );
    assert.equal(
      outcome.lines.some((line) => line.includes('to start it yourself')),
      false,
    );
    const id = opened(r);
    assert.equal(info(r.registry, id).state, 'lost');
    settleEndedTerminal(w.deck, helloOf(r, id));
    assert.equal(readLock(w.deck, S1), null);
    assert.deepEqual(readRecords(record), []);
  });

  test('the server stopping while the keeper starts → timedOut: true, no command, the lock kept; a later server finds the keeper (ruled, M1)', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const path = slowPython(w, 2);
    const r = w.registry({
      platform: { ...w.tp.platform, env: { ...w.tp.platform.env, PATH: path } },
    });
    const { deps, record } = w.deps(r);
    const prepared = prepareResumeById(w.deck, S1);
    const lock = readLock(w.deck, S1);
    const launching = launchPrepared(w.deck, prepared, windowTerminal(deps, SIZE));
    await sleep(300);
    await r.registry.stopAll(); // skydeck window --restart while the keeper's python3 starts
    const outcome = await launching;
    assert.equal(outcome.code, 1);
    assert.equal(
      outcome.lines.at(-1),
      `skydeck: run skydeck again to see whether session ${S1} is running`,
    );
    assert.equal(
      outcome.lines.some((line) => line.includes('to start it yourself')),
      false,
    );
    assert.equal(readLock(w.deck, S1), lock);
    // The keeper it spawned lives on, unstarted: the next server finds it (and runs the guard).
    await until(
      () => readdirSync(w.termsDir).some((name) => name.endsWith('.pid')),
      'the keeper came up',
      10_000,
    );
    const later = w.registry();
    await later.registry.rediscover();
    const found = later.events.hello.find((e) => e.origin === 'found');
    assert.ok(found, 'found by the next server');
    assert.equal(found.hello.started, false);
    assert.equal(found.hello.lock, lock);
    assert.deepEqual(readRecords(record), []);
  });

  test('no T within 5 s after G (G lost) → timedOut: true; no command printed, the lock kept', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    const r = w.registry();
    const { deps, record } = w.deps(r);
    const registry: Registry = { ...r.registry, start() {} };
    const prepared = prepareResumeById(w.deck, S1);
    const lock = readLock(w.deck, S1);
    const began = performance.now();
    const outcome = await launchPrepared(
      w.deck,
      prepared,
      windowTerminal({ ...deps, registry }, SIZE),
    );
    const waited = performance.now() - began;
    assert.ok(waited >= 4900, `answered after ${Math.round(waited)} ms`);
    assert.equal(outcome.code, 1);
    assert.equal(
      outcome.lines.at(-1),
      `skydeck: run skydeck again to see whether session ${S1} is running`,
    );
    assert.equal(
      outcome.lines.some((line) => line.includes('to start it yourself')),
      false,
    );
    assert.equal(readLock(w.deck, S1), lock);
    assert.deepEqual(readRecords(record), []);
    assert.equal(info(r.registry, opened(r)).state, 'starting', 'the terminal is kept');
  });
});

describe('window terminal: a keeper that answers after 5 s', { concurrency: true }, () => {
  /** A resume whose keeper's hello comes after open() answered; its late hello, undecided. */
  async function lateKeeper(t: TestContext): Promise<{
    w: WindowDeck;
    r: TestRegistry;
    record: string;
    id: string;
    hello: KeeperHello;
    lock: string | null;
  }> {
    const w = await windowDeck(t);
    w.resumable(S1);
    const path = slowPython(w);
    const r = w.registry({
      platform: { ...w.tp.platform, env: { ...w.tp.platform.env, PATH: path } },
    });
    const { deps, record } = w.deps(r);
    const prepared = prepareResumeById(w.deck, S1);
    const lock = readLock(w.deck, S1);
    const outcome = await launchPrepared(w.deck, prepared, windowTerminal(deps, SIZE));
    assert.equal(outcome.code, 1);
    assert.equal(
      outcome.lines.at(-1),
      `skydeck: run skydeck again to see whether session ${S1} is running`,
    );
    assert.equal(readLock(w.deck, S1), lock, 'the lock is kept after a timeout');
    const id = opened(r);
    await within(
      until(
        () => r.events.hello.some((e) => e.hello.id === id && e.origin === 'late'),
        'the late hello',
        12_000,
      ),
      'the late hello',
      13_000,
    );
    await sleep(500);
    assert.deepEqual(readRecords(record), [], 'open() sent no G after it answered');
    return { w, r, record, id, hello: helloOf(r, id), lock };
  }

  test('guard and lock still hold → decideFoundKeeper starts it, the stand-in runs', async (t) => {
    const { w, r, record, id, hello } = await lateKeeper(t);
    assert.deepEqual(decideFoundKeeper(w.deck, hello), { start: true });
    r.registry.start(id);
    await waitForRecord(record, isStart, 15_000);
  });

  test('the lock taken over meanwhile → N, nothing runs', async (t) => {
    const { w, r, record, id, hello } = await lateKeeper(t);
    w.deck.store.setKv(lockKey(S1), `${w.tp.platform.clock.nowNs()}:999`);
    const decision = decideFoundKeeper(w.deck, hello);
    assert.equal(decision.start, false);
    r.registry.refuse(id, decision.start ? '' : decision.reason);
    await until(() => info(r.registry, id).state === 'not-started', 'not started', 10_000);
    assert.deepEqual(readRecords(record), []);
  });

  test('the session started elsewhere meanwhile → N with the guard’s message, nothing runs', async (t) => {
    const { w, r, record, id, hello } = await lateKeeper(t);
    // Another terminal resumed S1: a stand-in in a pty of its own (a keeper the test drives).
    const other = await w.start({ spec: { argv: [w.standin, '--resume', S1] } });
    const { started } = await startProgram(other);
    const decision = decideFoundKeeper(w.deck, hello);
    assert.deepEqual(decision, {
      start: false,
      reason: `${S1.slice(0, 8)} is running (pid ${started.pid})`,
    });
    r.registry.refuse(id, decision.start ? '' : decision.reason);
    await until(() => info(r.registry, id).state === 'not-started', 'not started', 10_000);
    assert.equal(info(r.registry, id).exit?.notStarted, decision.start ? '' : decision.reason);
    assert.deepEqual(readRecords(record), []);
  });
});

describe('window terminal: restore', () => {
  test('runRestore with the window terminal: each session in a keeper of its own, its start seen', async (t) => {
    const w = await windowDeck(t, { config: { restoreMinFreeMb: 1 } });
    w.resumable(S1);
    w.resumable(S2, join(w.s.home, 'other project'));
    const r = w.registry();
    const { deps, record } = w.deps(r);
    refresh(w.deck);
    const bootId = w.tp.platform.proc.bootId() ?? '';
    const entries = loadRows(w.deck)
      .filter((row) => row.id === S1 || row.id === S2)
      .map((row) => ({ row, bootId, endedAtNs: null, wasWorking: false, preselected: true }));
    assert.equal(entries.length, 2);
    const lines: string[] = [];
    const outcome = await runRestore(
      { deck: w.deck, terminal: windowTerminal(deps, SIZE), report: (line) => lines.push(line) },
      entries,
    );
    assert.deepEqual([...outcome.started].sort(), [S1, S2].sort(), lines.join('\n'));
    assert.deepEqual(outcome.failed, []);
    assert.deepEqual(outcome.timedOut, []);
    assert.deepEqual(
      r.registry
        .list()
        .map((x) => [x.expectedSessionId, x.state])
        .sort(),
      [
        [S1, 'running'],
        [S2, 'running'],
      ].sort(),
    );
    const starts = readRecords(record).filter(isStart);
    assert.deepEqual(
      starts.map((x) => x.argv[1]).sort(),
      [S1, S2].sort(),
      'each stand-in resumed its own session',
    );
  });
});
