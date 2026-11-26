// A shell belongs to its session's terminal (issue #199, S2 7.10): the end rule — the shell is
// hung up when its session's program ends, whichever way — the end between G and T, a restart
// that moves the shell to the session's next terminal, and the owner of a shell found after a
// server restart, which is never ended on a doubt. Real keepers: the session terminal runs the
// stand-in `claude`, the shell the stand-in shell.
//
// What the ends prove: the stand-in shell is a non-interactive `sh` without job control, so the
// jobs it starts stay in its process group, and the kernel hangs them up when the group's leader
// (the shell) ends on the keeper's `E`. That proves the keeper's `E` and the kernel; what bash or
// zsh do with their own job groups is the manual check's.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import type { KeeperExit, ShellSpec } from '../../src/window/frames.ts';
import { PROMPT, procStartOf, sleep, stillRuns, until } from '../helpers/keeper.ts';
import { attachMirror, framesSpy, info, registrySandbox } from '../helpers/registry.ts';
import type { Mirror, RegistryBox, TestRegistry } from '../helpers/registry.ts';
import { SHELL_PROMPT } from '../helpers/shell-standin.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const count = (m: Mirror, needle: string): number => m.text().split(needle).length - 1;
const hungUpLine = (id: string): string =>
  `terminal ${id}: its session's terminal is over; the shell is hung up`;
const notFoundLine = (id: string): string =>
  `terminal ${id}: its session's terminal is not found; the shell is left running`;

interface Program {
  pid: number;
  procStart: number;
}

/** Spawns the stand-in `claude` as a session terminal, starts it and waits for its prompt. */
async function startSession(
  box: RegistryBox,
  r: TestRegistry,
  slot: number | null,
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

/** The program of terminal `id` as the registry heard of it. */
function programOf(r: TestRegistry, id: string): Program {
  const program = r.programs.get(id);
  assert.ok(program !== undefined, `no program of ${id}`);
  return program;
}

/**
 * Types `line` into the shell and reads `<word> <pid>` from its output (not from the echo of the
 * line, which shows `$!` or `$$`). The process is killed when the test ends if it still runs.
 */
async function startedInShell(
  t: TestContext,
  r: TestRegistry,
  shell: OpenShell,
  line: string,
  word: 'job' | 'child',
): Promise<Program> {
  assert.equal(r.registry.input(shell.spec.id, utf8(`${line}\r`)), 'ok');
  const pattern = new RegExp(`${word} (\\d+)\\r?\\n`);
  await until(() => pattern.test(shell.mirror.text()), `${word}'s pid on the screen`, 10_000);
  const pid = Number(pattern.exec(shell.mirror.text())?.[1]);
  const procStart = procStartOf(pid);
  assert.ok(procStart !== null, `${word} ${pid} runs`);
  t.after(() => {
    if (stillRuns(pid, procStart)) process.kill(pid, 'SIGKILL');
  });
  return { pid, procStart };
}

/** Every change, whether the shell `id` was listed while its owner `of` was over. */
function watchListing(r: TestRegistry, id: string, of: string): () => boolean {
  let listedOver = false;
  r.registry.onChange(() => {
    const owner = r.registry.list().find((term) => term.id === of);
    const over = owner === undefined || ['ended', 'lost', 'not-started'].includes(owner.state);
    if (over && r.registry.shells().some((one) => one.id === id)) listedOver = true;
  });
  return () => listedOver;
}

type EndWay = 'end' | '/exit' | 'crash' | 'lost';

/** Ends the session terminal's program the way `how` says. */
async function endOwner(box: RegistryBox, r: TestRegistry, of: string, how: EndWay): Promise<void> {
  if (how === 'end') {
    await until(() => info(r.registry, of).endable === true, 'endable');
    assert.equal(r.registry.end(of), 'ok');
  } else if (how === '/exit') {
    assert.equal(r.registry.input(of, utf8('/exit\r')), 'ok');
  } else if (how === 'crash') {
    const program = info(r.registry, of).program;
    assert.ok(program !== null && stillRuns(program.pid, program.procStart));
    process.kill(program.pid, 'SIGKILL');
  } else {
    box.signalKeeper(box.keeperOf(of), 'SIGKILL');
  }
}

describe("registry: a shell ends with its session's program (S2 7.10)", { concurrency: 2 }, () => {
  const cases: [EndWay, 'job' | 'child'][] = [
    ['end', 'job'],
    ['end', 'child'],
    ['/exit', 'job'],
    ['/exit', 'child'],
    ['crash', 'job'],
    ['crash', 'child'],
    ['lost', 'job'],
  ];
  for (const [how, what] of cases) {
    test(`the owner's program ended by ${how}: the shell leaves shells() at once and is hung up, with ${what === 'job' ? 'a background job' : 'a foreground child'} it ran`, async (t) => {
      const box = await registrySandbox(t);
      const r = box.registry();
      const of = await startSession(box, r, 3);
      const shell = await openShell(box, r, of);
      const id = shell.spec.id;
      const program = programOf(r, id);
      const keeper = box.keeperOf(id);
      const ran =
        what === 'job'
          ? await startedInShell(t, r, shell, 'sleep 300 & echo job $!', 'job')
          : await startedInShell(t, r, shell, `sh -c 'echo child $$; exec sleep 300'`, 'child');
      const listedOver = watchListing(r, id, of);

      await endOwner(box, r, of, how);

      await until(
        () => ['ended', 'lost'].includes(info(r.registry, of).state),
        "the owner's program is over",
        10_000,
      );
      assert.deepEqual(r.registry.shells(), [], 'out of shells() at once');
      for (const [name, one] of [
        ['the shell', program],
        [what, ran],
      ] as const) {
        await until(() => !stillRuns(one.pid, one.procStart), `${name} ended`, 10_000);
      }
      await until(() => !stillRuns(keeper.pid, keeper.procStart), 'its keeper ended', 10_000);
      assert.equal(listedOver(), false, 'never listed while its owner was over');
      assert.ok(r.log.includes(hungUpLine(id)), r.log.join('\n'));
      assert.deepEqual(
        shell.ended.map((exit) => exit.signal),
        [1],
        'it ended on SIGHUP',
      );
    });
  }
});

describe('registry: the end between G and T', () => {
  test('the G waits unread when the owner ends: the keeper starts the program all the same, the registry sends E on its T, and it ends', async (t) => {
    const box = await registrySandbox(t);
    const spy = framesSpy(box.tp.platform);
    const r = box.registry({ platform: spy.platform });
    const of = await startSession(box, r, 3);
    const spec = box.shellSpec(r, of);
    await r.registry.spawnShell(spec); // its hello came
    const keeper = box.keeperOf(spec.id);
    const listedOver = watchListing(r, spec.id, of);
    box.signalKeeper(keeper, 'SIGSTOP');
    let continued = false;
    try {
      r.registry.start(spec.id); // the G waits unread
      await endOwner(box, r, of, 'end');
      await until(() => info(r.registry, of).state === 'ended', 'the owner ended', 10_000);
      assert.deepEqual(r.registry.shells(), []);
      assert.equal(spy.sent(spec.socket), 'CPGN', 'claim, park, G, and the N of the ending step');
      box.signalKeeper(keeper, 'SIGCONT');
      continued = true;
    } finally {
      if (!continued) box.signalKeeper(keeper, 'SIGCONT');
    }
    await until(() => r.programs.has(spec.id), 'the program started (T)', 10_000);
    const program = programOf(r, spec.id);
    await until(() => spy.sent(spec.socket).includes('E'), 'E sent on the T', 10_000);
    await until(() => !stillRuns(program.pid, program.procStart), 'the program ended', 10_000);
    await until(() => !stillRuns(keeper.pid, keeper.procStart), 'its keeper ended', 10_000);
    assert.equal(spy.sent(spec.socket), 'CPGNEA');
    assert.deepEqual(r.registry.shells(), []);
    assert.equal(listedOver(), false);
  });

  test('a shell never sent G when its owner ends is refused (N), starts nothing, and a later start sends nothing', async (t) => {
    const box = await registrySandbox(t);
    const spy = framesSpy(box.tp.platform);
    const r = box.registry({ platform: spy.platform });
    const of = await startSession(box, r, 3);
    const spec = box.shellSpec(r, of);
    const ended: KeeperExit[] = [];
    await r.registry.spawnShell(spec, (exit) => {
      ended.push(exit);
    });
    const keeper = box.keeperOf(spec.id);

    await endOwner(box, r, of, 'end');
    await until(() => info(r.registry, of).state === 'ended', 'the owner ended', 10_000);
    r.registry.start(spec.id);

    await until(() => !stillRuns(keeper.pid, keeper.procStart), 'its keeper ended', 10_000);
    assert.equal(spy.sent(spec.socket), 'CPNA', 'no G');
    assert.equal(r.programs.has(spec.id), false, 'nothing was started');
    assert.deepEqual(
      ended.map((exit) => exit.notStarted !== null),
      [true],
    );
  });
});

describe('registry: a restart keeps the shell, under the new terminal', () => {
  test('held, its program ended: kept; take and moveShell, then the spawn: the new owner, the same program; release keeps it', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const of = await startSession(box, r, 3);
    const shell = await openShell(box, r, of);
    const program = programOf(r, shell.spec.id);
    const hold = r.registry.holdSlot(of);
    assert.ok(hold !== null && hold.moveShell !== undefined);
    await endOwner(box, r, of, 'end');
    await until(() => info(r.registry, of).state === 'ended', 'the owner ended', 10_000);
    await sleep(300);
    assert.deepEqual(
      r.registry.shells().map((one) => [one.id, one.of]),
      [[shell.spec.id, of]],
      'kept while a restart holds its owner',
    );
    let changes = 0;
    r.registry.onChange(() => {
      changes += 1;
    });

    const next = box.spec({ meta: { ...box.spec().meta, slot: null } });
    const slot = hold.take(next.id);
    const moved = hold.moveShell(next.id);
    assert.equal(changes, 0, 'no listener called by take and moveShell');
    assert.equal(moved, shell.spec.id);
    assert.equal(hold.moveShell(next.id), null, 'the shell is no longer the held one');
    const spawning = r.registry.spawn({ ...next, meta: { ...next.meta, slot, shell: moved } });
    assert.deepEqual(
      r.registry.shells().map((one) => [one.id, one.of]),
      [[shell.spec.id, next.id]],
      'the new owner, listed with the spawn',
    );
    await spawning;
    r.registry.start(next.id);
    hold.release();
    await sleep(300);
    assert.deepEqual(
      r.registry.shells().map((one) => [one.id, one.of, one.program?.pid]),
      [[shell.spec.id, next.id, program.pid]],
    );
    assert.ok(stillRuns(program.pid, program.procStart));
    assert.deepEqual(shell.ended, []);
  });

  test('a release without a take (the resume was refused) ends it', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const of = await startSession(box, r, 3);
    const shell = await openShell(box, r, of);
    const program = programOf(r, shell.spec.id);
    const hold = r.registry.holdSlot(of);
    assert.ok(hold !== null);
    await endOwner(box, r, of, 'end');
    await until(() => info(r.registry, of).state === 'ended', 'the owner ended', 10_000);
    assert.equal(r.registry.shells().length, 1);

    hold.release();

    assert.deepEqual(r.registry.shells(), []);
    await until(() => !stillRuns(program.pid, program.procStart), 'the shell ended', 10_000);
  });

  test('a new terminal that could not be spawned ends it', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const of = await startSession(box, r, 3);
    const shell = await openShell(box, r, of);
    const program = programOf(r, shell.spec.id);
    const hold = r.registry.holdSlot(of);
    assert.ok(hold !== null && hold.moveShell !== undefined);
    await endOwner(box, r, of, 'end');
    await until(() => info(r.registry, of).state === 'ended', 'the owner ended', 10_000);

    const next = box.spec({ argv: [] }); // a spec the keeper refuses: it ends at start
    hold.take(next.id);
    assert.equal(hold.moveShell(next.id), shell.spec.id);
    await assert.rejects(
      r.registry.spawn({ ...next, meta: { ...next.meta, shell: shell.spec.id } }),
    );

    assert.deepEqual(r.registry.shells(), []);
    await until(() => !stillRuns(program.pid, program.procStart), 'the shell ended', 10_000);
    hold.release();
  });
});

describe("registry: a found shell's owner (S2 7.10)", () => {
  test('found under the terminal that names it (a restart), and under its opener; each listed at its owner hello, while another keeper is still being found', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const b = await startSession(box, r1, 4);
    const c = await startSession(box, r1, 5);
    const moved = await openShell(box, r1, a);
    const plain = await openShell(box, r1, b);
    const hold = r1.registry.holdSlot(a);
    assert.ok(hold !== null && hold.moveShell !== undefined);
    await endOwner(box, r1, a, 'end');
    await until(() => info(r1.registry, a).state === 'ended', 'a ended', 10_000);
    const next = box.spec({ meta: { ...box.spec().meta, slot: null } });
    const slot = hold.take(next.id);
    const shell = hold.moveShell(next.id);
    await r1.registry.spawn({
      ...next,
      meta: { ...next.meta, slot, ...(shell === null ? {} : { shell }) },
    });
    r1.registry.start(next.id);
    hold.release();
    await until(() => info(r1.registry, next.id).state === 'running', 'the next terminal runs');
    await r1.registry.stopAll();
    const slow = box.keeperOf(c);
    box.signalKeeper(slow, 'SIGSTOP');
    try {
      const r2 = box.registry();
      await r2.registry.rediscover();
      assert.equal(
        r2.registry.giveSlots([], () => {}),
        'finding',
        'c is still being found',
      );

      assert.deepEqual(
        r2.registry
          .shells()
          .map((one) => [one.id, one.of])
          .sort(),
        [
          [moved.spec.id, next.id],
          [plain.spec.id, b],
        ].sort(),
      );
      assert.deepEqual(
        r2.log.filter((line) => line.includes('shell')),
        [],
      );
    } finally {
      box.signalKeeper(slow, 'SIGCONT');
    }
  });

  test("its owner's keeper killed while no registry ran: hung up once rediscover is done", async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const shell = await openShell(box, r1, a);
    const program = programOf(r1, shell.spec.id);
    await r1.registry.stopAll();
    const owner = box.keeperOf(a);
    box.signalKeeper(owner, 'SIGKILL');
    await until(() => !stillRuns(owner.pid, owner.procStart), "a's keeper is gone");

    const r2 = box.registry();
    await r2.registry.rediscover();

    assert.deepEqual(r2.registry.shells(), []);
    await until(() => !stillRuns(program.pid, program.procStart), 'the shell ended', 10_000);
    assert.ok(r2.log.includes(hungUpLine(shell.spec.id)), r2.log.join('\n'));
  });

  test("an orphan beside another session's shell: the orphan is hung up, the other runs on (the shells' own .pid files are no doubt)", async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const b = await startSession(box, r1, 4);
    const orphan = await openShell(box, r1, a);
    const other = await openShell(box, r1, b);
    const orphanProgram = programOf(r1, orphan.spec.id);
    const otherProgram = programOf(r1, other.spec.id);
    await r1.registry.stopAll();
    box.signalKeeper(box.keeperOf(a), 'SIGKILL');

    const r2 = box.registry();
    await r2.registry.rediscover();

    await until(
      () => !stillRuns(orphanProgram.pid, orphanProgram.procStart),
      'the orphan ended',
      10_000,
    );
    assert.ok(r2.log.includes(hungUpLine(orphan.spec.id)), r2.log.join('\n'));
    assert.deepEqual(
      r2.registry.shells().map((one) => [one.id, one.of]),
      [[other.spec.id, b]],
    );
    await sleep(1500);
    assert.ok(stillRuns(otherProgram.pid, otherProgram.procStart), 'the other shell runs on');
  });

  test('a found owner whose hello says exited is not the owner while a keeper may live unheld; once none may, the shell is hung up', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const c = await startSession(box, r1, 4);
    const shell = await openShell(box, r1, a);
    const program = programOf(r1, shell.spec.id);
    const owner = info(r1.registry, a).program;
    assert.ok(owner !== null);
    r1.drop(); // its keepers are kept without their A
    process.kill(owner.pid, 'SIGKILL'); // a's program ends: its keeper keeps the exit
    await until(() => !stillRuns(owner.pid, owner.procStart), "a's program ended");
    const slow = box.keeperOf(c);
    box.signalKeeper(slow, 'SIGSTOP');
    let continued = false;
    try {
      const r2 = box.registry();
      await r2.registry.rediscover();
      assert.equal(info(r2.registry, a).state, 'ended');
      await sleep(1500);
      assert.deepEqual(r2.registry.shells(), [], 'no owner: not listed');
      assert.ok(stillRuns(program.pid, program.procStart), 'not hung up on the doubt');

      box.signalKeeper(slow, 'SIGCONT');
      continued = true;
      await until(() => !stillRuns(program.pid, program.procStart), 'hung up', 15_000);
      assert.ok(r2.log.includes(hungUpLine(shell.spec.id)), r2.log.join('\n'));
    } finally {
      if (!continued) box.signalKeeper(slow, 'SIGCONT');
    }
  });

  test('an owner once resolved is kept: a .pid file of no readable form put in later does not keep its shell once the owner ended', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const shell = await openShell(box, r1, a);
    const program = programOf(r1, shell.spec.id);
    await r1.registry.stopAll();
    const r2 = box.registry();
    await r2.registry.rediscover();
    await until(() => r2.registry.shells().length === 1, 'resolved to a');
    writeFileSync(box.files.termPid('c0ffee00beef'), 'not a line of any form\n');

    await endOwner(box, r2, a, 'end');

    await until(() => !stillRuns(program.pid, program.procStart), 'hung up', 10_000);
    assert.deepEqual(r2.registry.shells(), []);
  });

  test("nothing on a doubt: every connect to the owner's socket fails (EAGAIN): not listed, not hung up, logged once; the next registry lists both", async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const shell = await openShell(box, r1, a);
    const program = programOf(r1, shell.spec.id);
    await r1.registry.stopAll();
    const ownerSocket = box.files.termSock(a);
    const base = box.tp.platform;
    const faulty: Platform = {
      ...base,
      net: {
        ...base.net,
        async connectUnix(path) {
          if (path === ownerSocket) {
            throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
          }
          return base.net.connectUnix(path);
        },
      },
    };

    const r2 = box.registry({ platform: faulty });
    await r2.registry.rediscover();
    await sleep(2500); // the watch settles once a second

    assert.deepEqual(
      r2.registry.list().map((term) => term.id),
      [],
      'the owner is not listed',
    );
    assert.deepEqual(r2.registry.shells(), []);
    assert.ok(stillRuns(program.pid, program.procStart), 'not hung up');
    assert.equal(r2.log.filter((line) => line === notFoundLine(shell.spec.id)).length, 1);
    assert.equal(r2.log.includes(hungUpLine(shell.spec.id)), false);
    await r2.registry.stopAll();

    const r3 = box.registry();
    await r3.registry.rediscover();
    await until(() => r3.registry.shells().length === 1, 'the shell is listed');
    assert.deepEqual(
      r3.registry.list().map((term) => term.id),
      [a],
    );
    assert.equal(r3.registry.shells()[0]?.of, a);
  });

  test('nothing on a doubt: a .pid file of no form this build reads, naming a live process, keeps an orphan running; without it the orphan is hung up', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const shell = await openShell(box, r1, a);
    const program = programOf(r1, shell.spec.id);
    await r1.registry.stopAll();
    box.signalKeeper(box.keeperOf(a), 'SIGKILL');
    const bootId = box.tp.platform.proc.bootId();
    const start = procStartOf(process.pid);
    assert.ok(bootId !== null && start !== null);
    const odd = box.files.termPid('c0ffee00beef');
    writeFileSync(odd, `${process.pid} ${start} ${bootId} 5 1 shell later\n`);

    const r2 = box.registry();
    await r2.registry.rediscover();
    await sleep(2500);

    assert.deepEqual(r2.registry.shells(), []);
    assert.ok(stillRuns(program.pid, program.procStart), 'not hung up');
    assert.equal(r2.log.filter((line) => line === notFoundLine(shell.spec.id)).length, 1);

    box.tp.platform.files.remove(odd);
    await until(() => !stillRuns(program.pid, program.procStart), 'hung up', 10_000);
    assert.ok(r2.log.includes(hungUpLine(shell.spec.id)), r2.log.join('\n'));
  });

  test('two shells that claim one terminal: the one opened later is its, the earlier one is hung up', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await startSession(box, r1, 3);
    const first = await openShell(box, r1, a);
    const firstProgram = programOf(r1, first.spec.id);
    // A second shell of `a`, past the registry's gate: a keeper the test starts itself.
    const second = await box.start({ shell: box.shellSpec(r1, a) });
    const { client } = await second.claim();
    client.send('G');
    await client.next('T', 15_000);
    client.socket.destroy();
    await r1.registry.stopAll();

    const r2 = box.registry();
    await r2.registry.rediscover();

    await until(
      () => !stillRuns(firstProgram.pid, firstProgram.procStart),
      'the earlier one is hung up',
      10_000,
    );
    assert.deepEqual(
      r2.registry.shells().map((one) => [one.id, one.of]),
      [[second.spec.id, a]],
    );
    assert.ok(
      r2.log.includes(
        `terminal ${first.spec.id}: another shell belongs to its session's terminal; the shell is hung up`,
      ),
      r2.log.join('\n'),
    );
  });
});

/** `base` whose 10-second timers fire after `ms` (the shell's "has not ended" line), nothing else. */
function fastTenSeconds(base: Platform, ms: number): Platform {
  return {
    ...base,
    clock: {
      ...base.clock,
      after: (delay, run) => base.clock.after(delay === 10_000 ? ms : delay, run),
    },
  };
}

/** Types `line` into the shell and waits for one more prompt. */
async function typeIn(r: TestRegistry, shell: OpenShell, line: string): Promise<void> {
  const before = count(shell.mirror, SHELL_PROMPT);
  assert.equal(r.registry.input(shell.spec.id, utf8(`${line}\r`)), 'ok');
  await until(() => count(shell.mirror, SHELL_PROMPT) > before, `a prompt after ${line}`, 10_000);
}

const typesOf = (sent: string, type: string): number => sent.split(type).length - 1;

describe('registry: the ending step without a connection, and once only (S2 7.10)', () => {
  test('the owner ends while the shell has no usable connection: the shell is hung up at its next hello', async (t) => {
    const box = await registrySandbox(t);
    const spy = framesSpy(box.tp.platform);
    const r = box.registry({ platform: spy.platform });
    const of = await startSession(box, r, 3);
    const shell = await openShell(box, r, of);
    const program = programOf(r, shell.spec.id);
    const keeper = box.keeperOf(shell.spec.id);
    box.signalKeeper(keeper, 'SIGSTOP');
    let continued = false;
    try {
      for (const socket of spy.sockets(shell.spec.socket)) socket.destroy();
      await until(
        () => r.registry.shells()[0]?.state === 'reconnecting',
        'the shell is being reconnected to',
        10_000,
      );
      await endOwner(box, r, of, 'crash');
      await until(() => info(r.registry, of).state === 'ended', 'the owner ended', 10_000);
      assert.deepEqual(r.registry.shells(), [], 'out of shells() at once');
      assert.equal(typesOf(spy.sent(shell.spec.socket), 'E'), 0, 'no connection: no E yet');
      assert.ok(stillRuns(program.pid, program.procStart));
      box.signalKeeper(keeper, 'SIGCONT');
      continued = true;
    } finally {
      if (!continued) box.signalKeeper(keeper, 'SIGCONT');
    }
    await until(() => !stillRuns(program.pid, program.procStart), 'hung up at its hello', 15_000);
    await until(() => !stillRuns(keeper.pid, keeper.procStart), 'its keeper ended', 10_000);
    const sent = spy.sent(shell.spec.socket);
    assert.equal(typesOf(sent, 'E'), 1, sent);
    assert.ok(sent.indexOf('E') > sent.lastIndexOf('C'), `E on the claim after the cut: ${sent}`);
    assert.deepEqual(
      shell.ended.map((exit) => exit.signal),
      [1],
    );
  });

  test('a shell being ended takes no input (ended) and is sent no G by start', async (t) => {
    const box = await registrySandbox(t);
    const spy = framesSpy(box.tp.platform);
    const r = box.registry({ platform: spy.platform });
    const of = await startSession(box, r, 3);
    const spec = box.shellSpec(r, of);
    await r.registry.spawnShell(spec); // its hello came; no G
    const keeper = box.keeperOf(spec.id);
    box.signalKeeper(keeper, 'SIGSTOP'); // it stays in the registry, being ended
    let continued = false;
    try {
      await endOwner(box, r, of, 'crash');
      await until(() => info(r.registry, of).state === 'ended', 'the owner ended', 10_000);
      assert.deepEqual(r.registry.shells(), []);
      assert.equal(spy.sent(spec.socket), 'CPN', 'the N of the ending step');

      assert.equal(r.registry.input(spec.id, utf8('typed\r')), 'ended');
      r.registry.start(spec.id);

      assert.equal(spy.sent(spec.socket), 'CPN', 'no I, no G');
      box.signalKeeper(keeper, 'SIGCONT');
      continued = true;
    } finally {
      if (!continued) box.signalKeeper(keeper, 'SIGCONT');
    }
    await until(() => !stillRuns(keeper.pid, keeper.procStart), 'its keeper ended', 10_000);
    assert.equal(r.programs.has(spec.id), false, 'nothing was started');
  });

  test('a shell that ignores the hang-up: E once, also after a reconnect, and "the shell has not ended" once, 10 s after the E', async (t) => {
    const box = await registrySandbox(t);
    const spy = framesSpy(fastTenSeconds(box.tp.platform, 300));
    const r = box.registry({ platform: spy.platform });
    const of = await startSession(box, r, 3);
    const shell = await openShell(box, r, of);
    const program = programOf(r, shell.spec.id);
    t.after(() => {
      if (stillRuns(program.pid, program.procStart)) process.kill(program.pid, 'SIGKILL');
    });
    await typeIn(r, shell, "trap '' HUP");
    const notEnded = `terminal ${shell.spec.id}: the shell has not ended`;

    await endOwner(box, r, of, 'crash');

    await until(() => spy.sent(shell.spec.socket).includes('E'), 'E sent', 10_000);
    await until(() => r.log.includes(notEnded), 'the line 10 s after the E', 5000);
    assert.ok(stillRuns(program.pid, program.procStart), 'it ignores the hang-up');
    assert.deepEqual(r.registry.shells(), []);
    const claims = typesOf(spy.sent(shell.spec.socket), 'C');
    for (const socket of spy.sockets(shell.spec.socket)) socket.destroy();
    await until(() => typesOf(spy.sent(shell.spec.socket), 'C') > claims, 'claimed again', 10_000);
    await sleep(1000); // its hello, and more than the line's time again
    assert.equal(typesOf(spy.sent(shell.spec.socket), 'E'), 1, spy.sent(shell.spec.socket));
    assert.equal(r.log.filter((line) => line === notEnded).length, 1);
    assert.deepEqual(r.registry.shells(), []);
  });

  test('nothing is logged of a shell that has not ended once the registry is stopped', async (t) => {
    const box = await registrySandbox(t);
    const spy = framesSpy(fastTenSeconds(box.tp.platform, 300));
    const r = box.registry({ platform: spy.platform });
    const of = await startSession(box, r, 3);
    const shell = await openShell(box, r, of);
    const program = programOf(r, shell.spec.id);
    t.after(() => {
      if (stillRuns(program.pid, program.procStart)) process.kill(program.pid, 'SIGKILL');
    });
    await typeIn(r, shell, "trap '' HUP");

    await endOwner(box, r, of, 'crash');
    await until(() => spy.sent(shell.spec.socket).includes('E'), 'E sent', 10_000);
    await r.registry.stopAll();
    await sleep(800);

    assert.equal(r.log.includes(`terminal ${shell.spec.id}: the shell has not ended`), false);
  });

  test('a found shell whose hello says exited: not being found any more, forgotten, its keeper ends and its files go', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const of = await startSession(box, r1, 3);
    const shell = await openShell(box, r1, of);
    const program = programOf(r1, shell.spec.id);
    const keeper = box.keeperOf(shell.spec.id);
    r1.drop(); // its keepers are kept without their A
    process.kill(program.pid, 'SIGKILL'); // the shell's keeper keeps its exit
    await until(() => !stillRuns(program.pid, program.procStart), 'the shell ended');

    const r2 = box.registry();
    const found = await r2.registry.rediscover();

    assert.deepEqual(
      found.map((term) => term.id),
      [of],
    );
    assert.equal(
      r2.registry.giveSlots([], () => {}),
      'ok',
      'nothing is being found',
    );
    assert.deepEqual(r2.registry.shells(), []);
    await until(() => !stillRuns(keeper.pid, keeper.procStart), 'its keeper ended', 10_000);
    assert.equal(existsSync(box.files.termPid(shell.spec.id)), false, 'its .pid file');
    assert.equal(existsSync(shell.spec.socket), false, 'its socket');
    assert.equal(r2.registry.input(shell.spec.id, utf8('x')), 'unknown', 'forgotten');
    assert.equal(info(r2.registry, of).state, 'running', 'its session terminal runs on');
  });
});
