// Opening a session's shell on the server (issue #199, S2 7.10): the program (the account's login
// shell, `/bin/sh` without one), the refusals and their words, the spec the server writes (its
// folder, its environment, no lock), one shell per terminal, and a shell that ends at once. The
// refusals against a scripted registry; the openings with a real registry and keepers, the
// session terminal running the stand-in `claude`, the shell the stand-in shell.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import { serverEnvironment } from '../../src/window/env.ts';
import type { ShellSpec } from '../../src/window/frames.ts';
import type { ShellInfo, TerminalInfo } from '../../src/window/hub.ts';
import {
  createShells,
  ENDED_AT_ONCE_MS,
  shellProgram,
  shellRefusal,
  SHELL_OPEN_TEXTS,
} from '../../src/window/shells.ts';
import type { ShellsDeps } from '../../src/window/shells.ts';
import { PROMPT, SESSION, until } from '../helpers/keeper.ts';
import { testPlatform } from '../helpers/platform.ts';
import { attachMirror, info, registrySandbox } from '../helpers/registry.ts';
import type { Mirror, RegistryBox, TestRegistry } from '../helpers/registry.ts';

const TERM = '0123456789ab';
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const count = (m: Mirror, needle: string): number => m.text().split(needle).length - 1;
const SIZE = { cols: 90, rows: 12 };

// ---------------------------------------------------------------------------------------------
// The program

describe('shellProgram: the login shell, or /bin/sh', () => {
  test('an executable login shell is the program, started as `-<name>`', (t) => {
    const tp = testPlatform(t);
    const shell = join(tp.sandbox.bin, 'zsh');
    writeFileSync(shell, '#!/bin/sh\n', { mode: 0o755 });

    assert.deepEqual(shellProgram(shell, tp.platform.files), { file: shell, argv: ['-zsh'] });
  });

  test('none, a relative path, one that is no file, one that is not there, one without an execute bit: /bin/sh as `-sh`', (t) => {
    const tp = testPlatform(t);
    const plain = join(tp.sandbox.bin, 'plain');
    writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
    const dir = join(tp.sandbox.root, 'a-dir');
    mkdirSync(dir);
    for (const loginShell of [null, 'bin/zsh', dir, join(tp.sandbox.root, 'gone'), plain]) {
      assert.deepEqual(
        shellProgram(loginShell, tp.platform.files),
        { file: '/bin/sh', argv: ['-sh'] },
        String(loginShell),
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The refusals, against a scripted registry

function terminal(over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: TERM,
    slot: 1,
    state: 'running',
    expectedSessionId: SESSION,
    sessionId: SESSION,
    kind: 'resume',
    label: null,
    dir: '/',
    program: { pid: 4242, procStart: 51234567 },
    openedNs: 1n,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

/** createShells over a registry that lists `terminals` and records every spawn. */
function scripted(
  t: Parameters<typeof testPlatform>[0],
  terminals: TerminalInfo[],
  options: { stopping?: boolean; shells?: ShellInfo[] } = {},
): { shells: ReturnType<typeof createShells>; spawned: ShellSpec[] } {
  const tp = testPlatform(t);
  const spawned: ShellSpec[] = [];
  const deps: ShellsDeps = {
    registry: {
      list: () => terminals,
      shells: () => options.shells ?? [],
      spawnShell: async (spec) => {
        spawned.push(spec);
        throw new Error('not in this test');
      },
      start: () => {},
      nextOpenedNs: () => 1n,
      onChange: () => () => {},
    },
    files: {} as ShellsDeps['files'],
    platform: tp.platform,
    serverEnv: {},
    coreSoft: null,
    interop: () => null,
    refreshInterop: async () => {},
    build: 'test-build',
    log: () => {},
    stopping: () => options.stopping ?? false,
    endedAtOnceMs: ENDED_AT_ONCE_MS,
  };
  return { shells: createShells(deps), spawned };
}

describe('the refusals (S2 7.10): each with its words, and nothing spawned', () => {
  const ended = { code: 0, signal: null, atNs: '1', notStarted: null };
  const cases: [string, TerminalInfo[], string, { stopping?: boolean }?][] = [
    ['the server is stopping', [terminal()], SHELL_OPEN_TEXTS.stopping, { stopping: true }],
    ['no such terminal', [terminal({ id: 'ba9876543210' })], SHELL_OPEN_TEXTS.noTerminal],
    [
      'a terminal a restart holds',
      [terminal({ restarting: true })],
      'skydeck is restarting this session',
    ],
    ['an ended terminal', [terminal({ state: 'ended', exit: ended })], SHELL_OPEN_TEXTS.ended],
    ['a lost one', [terminal({ state: 'lost', exit: ended })], SHELL_OPEN_TEXTS.ended],
    ['one never started', [terminal({ state: 'not-started' })], SHELL_OPEN_TEXTS.ended],
    ['an exit not applied yet', [terminal({ exit: ended })], SHELL_OPEN_TEXTS.ended],
    ['a newer keeper', [terminal({ state: 'newer-keeper' })], SHELL_OPEN_TEXTS.newer],
    ['no session shown yet', [terminal({ sessionId: null })], SHELL_OPEN_TEXTS.notStarted],
    [
      'no program yet',
      [terminal({ state: 'starting', program: null })],
      SHELL_OPEN_TEXTS.notStarted,
    ],
    [
      'a folder that is gone',
      [terminal({ dir: '/no/such/folder/of/skydeck' })],
      SHELL_OPEN_TEXTS.noFolder,
    ],
  ];
  for (const [what, terminals, error, options] of cases) {
    test(what, async (t) => {
      const { shells, spawned } = scripted(t, terminals, options);
      assert.deepEqual(await shells.open(TERM, SIZE), { ok: false, error });
      assert.deepEqual(spawned, []);
    });
  }

  test('shellRefusal says nothing for a running terminal that shows its session', () => {
    assert.equal(shellRefusal(terminal()), null);
    assert.equal(shellRefusal(terminal({ state: 'reconnecting' })), null);
  });

  test('a terminal that has a shell already: ok, and nothing is spawned', async (t) => {
    const shell: ShellInfo = {
      id: 'ba9876543210',
      of: TERM,
      state: 'running',
      dir: '/',
      program: null,
      openedNs: 2n,
      cols: 80,
      rows: 24,
    };
    const { shells, spawned } = scripted(t, [terminal()], { shells: [shell] });
    assert.deepEqual(await shells.open(TERM, SIZE), { ok: true });
    assert.deepEqual(spawned, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Opening, with a real registry

interface Opening {
  box: RegistryBox;
  r: TestRegistry;
  of: string;
  dir: string;
  /** The specs the registry wrote to its keepers' stdin, in order. */
  specs: Record<string, unknown>[];
  /** `endedAtOnceMs`: the product's 400 ms unless a test names its own. */
  deps(platform?: Platform, endedAtOnceMs?: number): ShellsDeps;
  pidFiles(): string[];
}

/** A registry whose keepers' specs are read back, and a session terminal running in `dir`. */
async function opening(t: Parameters<typeof registrySandbox>[0]): Promise<Opening> {
  const box = await registrySandbox(t);
  const specs: Record<string, unknown>[] = [];
  const base = box.tp.platform;
  const platform: Platform = {
    ...base,
    processes: {
      ...base.processes,
      async startDetached(command, args, options) {
        if (typeof options.input === 'string') specs.push(JSON.parse(options.input));
        return base.processes.startDetached(command, args, options);
      },
    },
  };
  const r = box.registry({ platform });
  const dir = join(box.s.home, 'project');
  mkdirSync(dir);
  const spec = box.spec({ cwd: dir, meta: { ...box.spec().meta, dir } });
  await r.registry.spawn(spec);
  const m = await attachMirror(r.registry, box.modules, spec.id);
  r.registry.start(spec.id);
  await until(() => count(m, PROMPT) >= 1, 'the session prompt', 15_000);
  r.registry.setSession(spec.id, SESSION, false); // what the mapping says once it is reported
  const { env } = serverEnvironment(box.s.env());
  return {
    box,
    r,
    of: spec.id,
    dir,
    specs,
    deps: (shellPlatform = box.tp.platform, endedAtOnceMs = ENDED_AT_ONCE_MS) => ({
      registry: r.registry,
      files: box.files,
      platform: shellPlatform,
      serverEnv: env,
      coreSoft: null,
      interop: () => null,
      refreshInterop: async () => {},
      build: 'test-build',
      log: () => {},
      stopping: () => false,
      endedAtOnceMs,
    }),
    pidFiles: () => readdirSync(box.termsDir).filter((name) => name.endsWith('.pid')),
  };
}

describe('opening a shell (a real registry)', () => {
  test("one login shell in the terminal's folder; the server's spec: no lock, the stand-in's file, `-shell-standin`; a second open opens none", async (t) => {
    const o = await opening(t);
    const shells = createShells(o.deps());
    const before = o.pidFiles().length;
    const stampBefore = o.r.registry.nextOpenedNs();

    assert.deepEqual(await shells.open(o.of, SIZE), { ok: true });

    const [shell, ...more] = o.r.registry.shells();
    assert.ok(shell !== undefined);
    assert.deepEqual(more, []);
    assert.equal(shell.of, o.of);
    assert.equal(shell.dir, o.dir);
    assert.deepEqual([shell.cols, shell.rows], [SIZE.cols, SIZE.rows]);
    assert.ok(shell.openedNs > stampBefore && o.r.registry.nextOpenedNs() > shell.openedNs);
    const spec = o.specs.find((one) => one['id'] === shell.id);
    assert.ok(spec !== undefined);
    assert.equal(spec['lock'], null);
    assert.equal(spec['file'], o.box.tp.platform.loginShell);
    assert.deepEqual(spec['argv'], ['-shell-standin']);
    assert.equal(spec['cwd'], o.dir);
    assert.equal((spec['env'] as Record<string, string>)['PWD'], o.dir);
    assert.deepEqual(spec['meta'], {
      kind: 'shell',
      of: o.of,
      openedNs: String(shell.openedNs),
      build: 'test-build',
      dir: o.dir,
    });

    // The program runs (the open waited for its start): what is typed waits in its terminal.
    assert.equal(o.r.registry.input(shell.id, utf8('pwd >"$HOME/pwd.txt"\r')), 'ok');
    const written = join(o.box.s.home, 'pwd.txt');
    await until(
      () => existsSync(written) && readFileSync(written, 'utf8').endsWith('\n'),
      'pwd.txt',
    );
    assert.equal(readFileSync(written, 'utf8'), `${o.dir}\n`);

    assert.deepEqual(await shells.open(o.of, SIZE), { ok: true }, 'a second open');
    assert.equal(o.r.registry.shells().length, 1);
    assert.equal(o.pidFiles().length, before + 1, 'one keeper line more than before the first');
  });

  test('two opens started in the same tick open one', async (t) => {
    const o = await opening(t);
    const shells = createShells(o.deps());
    const before = o.pidFiles().length;

    const answers = await Promise.all([shells.open(o.of, SIZE), shells.open(o.of, SIZE)]);

    assert.deepEqual(answers, [{ ok: true }, { ok: true }]);
    assert.equal(o.r.registry.shells().length, 1);
    assert.equal(o.pidFiles().length, before + 1);
  });

  test("the terminal's folder gone: refused, nothing spawned", async (t) => {
    const o = await opening(t);
    const shells = createShells(o.deps());
    const before = o.pidFiles();
    rmSync(o.dir, { recursive: true });

    assert.deepEqual(await shells.open(o.of, SIZE), {
      ok: false,
      error: SHELL_OPEN_TEXTS.noFolder,
    });
    assert.deepEqual(o.pidFiles(), before);
  });

  test("the registry's refusal (unseen) is the answer, in its words; nothing spawned", async (t) => {
    const o = await opening(t);
    const shells = createShells(o.deps());
    writeFileSync(o.box.files.termPid('c0ffee00beef'), 'not a line of any form\n');
    const before = o.pidFiles();

    assert.deepEqual(await shells.open(o.of, SIZE), {
      ok: false,
      error: 'a terminal of this window does not answer; a shell cannot be opened until it does',
    });
    assert.deepEqual(o.pidFiles(), before);
    assert.deepEqual(o.r.registry.shells(), []);
  });

  test('a shell that ends at once: the answer says so with its status, and no shell is left', async (t) => {
    const o = await opening(t);
    const quits = join(o.box.s.bin, 'quits-at-once');
    writeFileSync(quits, '#!/bin/sh\necho bye\nexit 3\n');
    chmodSync(quits, 0o755);
    // A wait no machine's load can outlast: the exit ends it as soon as it comes.
    const shells = createShells(o.deps({ ...o.box.tp.platform, loginShell: quits }, 30_000));

    assert.deepEqual(await shells.open(o.of, SIZE), {
      ok: false,
      error: 'the shell ended at once (status 3)',
    });
    await until(() => o.r.registry.shells().length === 0, 'no shell left');
    assert.equal(info(o.r.registry, o.of).state, 'running');
  });

  test('a shell that runs longer than the wait and then ends: the open answered ok', async (t) => {
    const o = await opening(t);
    const later = join(o.box.s.bin, 'ends-later');
    // It ends only once the test lets it, after the open answered: no race with the wait.
    const go = join(o.box.s.home, 'go');
    writeFileSync(later, `#!/bin/sh\nwhile [ ! -e '${go}' ]; do sleep 0.1; done\nexit 0\n`);
    chmodSync(later, 0o755);
    const shells = createShells(o.deps({ ...o.box.tp.platform, loginShell: later }, 50));

    assert.deepEqual(await shells.open(o.of, SIZE), { ok: true });
    writeFileSync(go, '');
    await until(() => o.r.registry.shells().length === 0, 'it ended later', 10_000);
  });
});
