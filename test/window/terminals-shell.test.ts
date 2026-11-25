// The registry holds a session's shell beside the session terminals (issue #199, S2 7.10): a
// second kind of terminal served by id as any terminal is, never in `list()`, with no slot, no
// session and no event; forgotten at its exit and at the loss of its keeper; found again after a
// restart; and no shell is opened while a shell's keeper may live that the registry does not hold.
// Real keepers: the session terminal runs the stand-in `claude`, the shell the stand-in shell.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import type { KeeperExit, ShellSpec } from '../../src/window/frames.ts';
import { KeeperStartError } from '../../src/window/terminals.ts';
import { PROMPT, SESSION, procStartOf, sleep, stillRuns, until } from '../helpers/keeper.ts';
import { attachMirror, info, registrySandbox } from '../helpers/registry.ts';
import type { Mirror, RegistryBox, TestRegistry } from '../helpers/registry.ts';
import { SHELL_PROMPT } from '../helpers/shell-standin.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const count = (m: Mirror, needle: string): number => m.text().split(needle).length - 1;

/** What the screen shows, line by line, trailing blanks cut. */
function screenText(m: Mirror): string {
  const buffer = m.term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++)
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
  return lines.join('\n');
}

/** The .pid files of terms/, sorted. */
function pidFiles(box: RegistryBox): string[] {
  return readdirSync(box.termsDir)
    .filter((name) => name.endsWith('.pid'))
    .sort();
}

/** Spawns the stand-in `claude` as a session terminal, starts it and waits for its prompt. */
async function startSession(
  box: RegistryBox,
  r: TestRegistry,
  slot: number | null = 3,
): Promise<string> {
  const spec = box.spec({ meta: { ...box.spec().meta, slot } });
  await r.registry.spawn(spec);
  const m = await attachMirror(r.registry, box.modules, spec.id);
  r.registry.start(spec.id);
  await until(() => count(m, PROMPT) >= 1, 'the session prompt', 15_000);
  m.detach();
  return spec.id;
}

interface OpenShell {
  spec: ShellSpec;
  mirror: Mirror & { detach(): void };
  ended: KeeperExit[];
}

/** Spawns a shell under `of`, attaches a mirror, sends G and waits for the stand-in's prompt. */
async function openShell(
  box: RegistryBox,
  r: TestRegistry,
  of: string,
  overrides: Partial<ShellSpec> = {},
): Promise<OpenShell> {
  const spec = box.shellSpec(r, of, overrides);
  const ended: KeeperExit[] = [];
  await r.registry.spawnShell(spec, (exit) => {
    ended.push(exit);
  });
  const mirror = await attachMirror(r.registry, box.modules, spec.id);
  r.registry.start(spec.id);
  await until(() => count(mirror, SHELL_PROMPT) >= 1, 'the shell prompt', 15_000);
  return { spec, mirror, ended };
}

/** Types a line into the shell and waits for one more prompt. */
async function typeIn(r: TestRegistry, shell: OpenShell, line: string): Promise<void> {
  const before = count(shell.mirror, SHELL_PROMPT);
  assert.equal(r.registry.input(shell.spec.id, utf8(`${line}\r`)), 'ok');
  await until(() => count(shell.mirror, SHELL_PROMPT) > before, `a prompt after ${line}`, 10_000);
}

/** A rejection of spawnShell with kind 'unseen'. */
async function refusedUnseen(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof KeeperStartError);
    assert.equal(error.kind, 'unseen');
    assert.equal(
      error.message,
      'a terminal of this window does not answer; a shell cannot be opened until it does',
    );
    return true;
  });
}

describe('registry: a shell beside the session terminals (S2 7.10)', () => {
  test('listed by shells() only, with no slot, no session and no event; served by id as a terminal is', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const of = await startSession(box, r);
    const nextSlot = r.registry.nextSlot();
    const future = box.tp.platform.clock.nowNs() + 30_000_000_000n;
    const shell = await openShell(box, r, of, {
      meta: { ...box.shellSpec(r, of).meta, openedNs: String(future) },
    });
    const id = shell.spec.id;

    await until(() => r.registry.shells()[0]?.state === 'running', 'the shell runs');
    const [listed, ...more] = r.registry.shells();
    assert.deepEqual(more, []);
    assert.ok(listed !== undefined);
    assert.equal(listed.id, id);
    assert.equal(listed.of, of);
    assert.equal(listed.dir, shell.spec.cwd);
    assert.deepEqual([listed.cols, listed.rows], [80, 24]);
    assert.equal(listed.openedNs, future);
    assert.deepEqual(listed.program, r.programs.get(id));
    assert.ok(listed.program !== null && stillRuns(listed.program.pid, listed.program.procStart));
    assert.deepEqual(
      r.registry.list().map((term) => term.id),
      [of],
    );
    for (const [name, all] of Object.entries(r.events)) {
      assert.ok(
        (all as { term: { id: string } }[]).every((one) => one.term.id !== id),
        `no ${name} event for the shell`,
      );
    }

    // No number, no move, no withholding.
    assert.equal(r.registry.nextSlot(), nextSlot);
    assert.equal(
      r.registry.giveSlots([id], () => {
        assert.fail('nothing to give a shell');
      }),
      'ok',
    );
    assert.equal(r.registry.withholdSlots(new Set([id])), 'unchanged');
    assert.equal(r.registry.setSlots(new Map([[id, 5]])), 'changed');
    assert.ok(r.registry.nextOpenedNs() > future, 'its stamp is known: the next one is later');

    // Its screen, input and size, by id.
    assert.ok(screenText(shell.mirror).includes(SHELL_PROMPT.trimEnd()));
    await typeIn(r, shell, "printf 'do%s' ne");
    assert.ok(shell.mirror.text().includes('done'), 'the output of the typed line');
    r.registry.resize(id, 100, 30);
    await until(() => r.registry.shells()[0]?.cols === 100, 'its new size in shells()');
    assert.equal(r.registry.shells()[0]?.rows, 30);

    // Not a session terminal's member.
    assert.equal(r.registry.close(id), 'unknown');
    assert.equal(r.registry.end(id), 'unknown');
    assert.equal(r.registry.holdSlot(id), null);
    const before = [r.registry.list(), r.registry.shells()];
    r.registry.setSession(id, SESSION, true);
    assert.deepEqual([r.registry.list(), r.registry.shells()], before);
    assert.deepEqual(shell.ended, []);
  });

  test('`exit` typed: forgotten, the sink got the exit, ended told once with status 0, its keeper ends and its files go', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const of = await startSession(box, r);
    const shell = await openShell(box, r, of);
    const keeper = box.keeperOf(shell.spec.id);

    assert.equal(r.registry.input(shell.spec.id, utf8('exit\r')), 'ok');

    await until(() => r.registry.shells().length === 0, 'the shell is no longer listed', 10_000);
    await until(() => shell.ended.length === 1, 'ended told');
    assert.deepEqual(
      shell.ended.map((exit) => [exit.code, exit.signal]),
      [[0, null]],
    );
    assert.deepEqual(
      shell.mirror.exits.map((one) => [one.exit.code, one.lost]),
      [[0, false]],
    );
    await until(() => !stillRuns(keeper.pid, keeper.procStart), 'its keeper ended', 10_000);
    await until(
      () => !existsSync(box.files.termPid(shell.spec.id)) && !existsSync(shell.spec.socket),
      'its files are gone',
    );
    assert.equal(r.registry.input(shell.spec.id, utf8('x')), 'unknown', 'forgotten');
    await sleep(300);
    assert.equal(shell.ended.length, 1, 'told once');
    assert.deepEqual(
      r.registry.list().map((term) => [term.id, term.state]),
      [[of, 'running']],
      'its session terminal runs on',
    );
  });

  test('its keeper killed: forgotten, its files removed, ended told of the loss', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const of = await startSession(box, r);
    const shell = await openShell(box, r, of);
    const keeper = box.keeperOf(shell.spec.id);

    box.signalKeeper(keeper, 'SIGKILL');

    await until(() => shell.ended.length === 1, 'ended told', 10_000);
    assert.deepEqual(r.registry.shells(), []);
    assert.deepEqual(
      shell.mirror.exits.map((one) => one.lost),
      [true],
    );
    assert.equal(existsSync(box.files.termPid(shell.spec.id)), false, 'the .pid file');
    assert.equal(existsSync(shell.spec.socket), false, 'the socket');
  });

  test('found again by the next registry: not in its answer, in shells() with the same program, its stamp known, its screen kept', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const of = await startSession(box, r1);
    const future = box.tp.platform.clock.nowNs() + 30_000_000_000n;
    const shell = await openShell(box, r1, of, {
      meta: { ...box.shellSpec(r1, of).meta, openedNs: String(future) },
    });
    await typeIn(r1, shell, "printf 'mark%s' er-before");
    const program = r1.programs.get(shell.spec.id);
    await r1.registry.stopAll();

    const r2 = box.registry();
    const found = await r2.registry.rediscover();

    assert.deepEqual(
      found.map((term) => term.id),
      [of],
    );
    await until(() => r2.registry.shells().length === 1, 'the shell is listed');
    const [again] = r2.registry.shells();
    assert.equal(again?.id, shell.spec.id);
    assert.equal(again?.of, of);
    assert.deepEqual(again?.program, program);
    assert.ok(r2.registry.nextOpenedNs() > future, "a found shell's stamp is known from its hello");
    const m = await attachMirror(r2.registry, box.modules, shell.spec.id);
    await m.settled();
    assert.ok(screenText(m).includes('marker-before'), screenText(m));
    assert.deepEqual(
      r2.events.hello.map((one) => one.term.id),
      [of],
      'no hello event for the shell',
    );
  });

  test('a shell found before it was started is refused (N) and forgotten at its X', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const of = await startSession(box, r1);
    const spec = box.shellSpec(r1, of);
    await r1.registry.spawnShell(spec); // no G
    await r1.registry.stopAll();

    const r2 = box.registry();
    await r2.registry.rediscover();

    await until(() => !existsSync(box.files.termPid(spec.id)), 'its keeper ended', 10_000);
    assert.deepEqual(r2.registry.shells(), []);
    assert.ok(
      r2.log.includes(`terminal ${spec.id}: a shell not started is refused`),
      r2.log.join('\n'),
    );
    assert.equal(r2.programs.get(spec.id), undefined, 'nothing was started');
  });
});

describe('registry: no shell is opened while a keeper may live unheld that is a shell or cannot be told', () => {
  test("a shell's keeper stopped, so still being found: refused (unseen), nothing started; after SIGCONT it opens", async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const b = await startSession(box, r1, 4);
    const shell = await openShell(box, r1, a);
    await r1.registry.stopAll();
    const keeper = box.keeperOf(shell.spec.id);
    box.signalKeeper(keeper, 'SIGSTOP');
    let continued = false;
    try {
      const r2 = box.registry();
      await r2.registry.rediscover();
      assert.equal(
        r2.registry.giveSlots([], () => {}),
        'finding',
        'still being found',
      );
      const before = pidFiles(box);

      await refusedUnseen(r2.registry.spawnShell(box.shellSpec(r2, b)));

      assert.deepEqual(pidFiles(box), before, 'no keeper line more');
      box.signalKeeper(keeper, 'SIGCONT');
      continued = true;
      await until(() => r2.registry.shells().length === 1, 'the stopped shell is found', 15_000);
      const opened = await openShell(box, r2, b);
      assert.deepEqual(
        r2.registry
          .shells()
          .map((one) => [one.id, one.of])
          .sort(),
        [
          [shell.spec.id, a],
          [opened.spec.id, b],
        ].sort(),
      );
    } finally {
      if (!continued) box.signalKeeper(keeper, 'SIGCONT');
    }
  });

  test("every connect to a shell's keeper fails with EAGAIN (find gave it up, nothing is being found): refused", async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const b = await startSession(box, r1, 4);
    const shell = await openShell(box, r1, a);
    await r1.registry.stopAll();
    const base = box.tp.platform;
    let faults = 0;
    const platform: Platform = {
      ...base,
      net: {
        ...base.net,
        async connectUnix(path) {
          if (path === shell.spec.socket) {
            faults += 1;
            throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
          }
          return base.net.connectUnix(path);
        },
      },
    };
    const r2 = box.registry({ platform });
    await r2.registry.rediscover();
    assert.ok(faults >= 2, 'the probe and the find both failed');
    assert.equal(
      r2.registry.giveSlots([], () => {}),
      'ok',
      'nothing is being found',
    );
    assert.deepEqual(r2.registry.shells(), []);
    const before = pidFiles(box);

    await refusedUnseen(r2.registry.spawnShell(box.shellSpec(r2, b)));

    assert.deepEqual(pidFiles(box), before, 'no keeper line more');
  });

  test('a terms/<id>.pid that holds no line this build reads, naming a live process: refused; without it the shell opens', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const of = await startSession(box, r);
    const bootId = box.tp.platform.proc.bootId();
    const start = procStartOf(process.pid);
    assert.ok(bootId !== null && start !== null);
    const odd = box.files.termPid('c0ffee00beef');
    writeFileSync(odd, `${process.pid} ${start} ${bootId} 5 1 shell later\n`);
    const before = pidFiles(box);

    await refusedUnseen(r.registry.spawnShell(box.shellSpec(r, of)));

    assert.deepEqual(pidFiles(box), before, 'no keeper line more');
    box.tp.platform.files.remove(odd);
    const shell = await openShell(box, r, of);
    assert.deepEqual(
      r.registry.shells().map((one) => one.id),
      [shell.spec.id],
    );
  });

  test("a session's keeper stopped, still being found: a shell under another terminal opens", async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const b = await startSession(box, r1, 4);
    await r1.registry.stopAll();
    const keeper = box.keeperOf(a);
    box.signalKeeper(keeper, 'SIGSTOP');
    try {
      const r2 = box.registry();
      await r2.registry.rediscover();
      assert.equal(
        r2.registry.giveSlots([], () => {}),
        'finding',
        'still being found',
      );
      assert.equal(info(r2.registry, b).state, 'running');

      const shell = await openShell(box, r2, b);

      assert.deepEqual(
        r2.registry.shells().map((one) => [one.id, one.of]),
        [[shell.spec.id, b]],
      );
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
  });
});
