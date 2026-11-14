// The terminal registry (S2 7.1–7.8, 8.1, 8.2.4; plan task 16): spawning keepers, claiming them,
// streams to sinks in order, the slot rule, input and its limit, the end of a program, starts that
// fail. Platform: realTestPlatform; real keepers running the stand-in; G is sent by the test.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { KeeperSpec } from '../../src/window/frames.ts';
import { KeeperStartError } from '../../src/window/terminals.ts';
import { CPR, DA1, PROMPT, SESSION, sleep, until, within } from '../helpers/keeper.ts';
import {
  assertSameScreen,
  attachMirror,
  info,
  mirror,
  registrySandbox,
  settledTerm,
} from '../helpers/registry.ts';
import type { Mirror, RegistryBox, TestRegistry } from '../helpers/registry.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const prompts = (m: Mirror): number => m.text().split(PROMPT).length - 1;

/** Spawns the stand-in, attaches a mirror, sends G and waits for its first prompt. */
async function startStandin(
  box: RegistryBox,
  r: TestRegistry,
  overrides: Partial<KeeperSpec> = {},
): Promise<{ spec: KeeperSpec; mirror: Mirror & { detach(): void } }> {
  const spec = box.spec(overrides);
  await r.registry.spawn(spec);
  const m = await attachMirror(r.registry, box.modules, spec.id);
  r.registry.start(spec.id);
  await until(
    () => prompts(m) >= 1,
    () => `the prompt in ${JSON.stringify(m.text())}`,
    15_000,
  );
  return { spec, mirror: m };
}

/** Types a line and waits until one more prompt than before is on the mirror. */
async function typeLine(r: TestRegistry, id: string, m: Mirror, line: string): Promise<void> {
  const before = prompts(m);
  assert.equal(r.registry.input(id, utf8(`${line}\r`)), 'ok');
  await until(() => prompts(m) > before, `a prompt after ${line}`, 10_000);
}

describe('registry: spawn, claim and streams', () => {
  test('a sink gets the output records after its snapshot in order; a later sink rebuilds the same screen', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror: first } = await startStandin(box, r);
    assert.equal(info(r.registry, spec.id).state, 'running');
    await typeLine(r, spec.id, first, '/red hi');
    assert.ok(first.text().includes('\x1b[31mhi\x1b[0m'), 'the red text reached the sink');
    assert.ok(first.text().indexOf(DA1) < first.text().indexOf(PROMPT), 'the stream is in order');

    const second = await attachMirror(r.registry, box.modules, spec.id);
    await typeLine(r, spec.id, first, '/lines 40');
    await until(() => prompts(second) >= 1, 'the second sink saw the prompt');
    await Promise.all([first.settled(), second.settled()]);
    const screenSide = r.terminals[0];
    assert.ok(screenSide);
    await settledTerm(screenSide);
    assertSameScreen(screenSide, first.term);
    assertSameScreen(screenSide, second.term);
    assert.equal(first.calls[0], 'S', 'the snapshot first');
    assert.deepEqual(new Set(first.calls.slice(1)), new Set(['o']), 'then only output records');
    assert.equal(second.calls[0], 'S');
  });

  test("the stand-in's DA1 and CPR are answered once each", async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror } = await startStandin(box, r);
    const record = spec.env['STANDIN_RECORD'] ?? '';
    await typeLine(r, spec.id, mirror, '/idle');
    const records = readRecords(record);
    assert.deepEqual(
      records.filter((x) => x.ev === 'da1').map((x) => x.ev === 'da1' && x.answer !== null),
      [true],
    );
    assert.deepEqual(
      records.filter((x) => x.ev === 'cpr').map((x) => x.ev === 'cpr' && x.answer !== null),
      [true],
    );
    const typed = records.flatMap((x) => (x.ev === 'input' ? [x.hex] : []));
    assert.ok(
      typed.every((hex) => !hex.includes('1b5b')),
      `no answer arrived as input: ${typed.join(' ')}`,
    );
    assert.ok(mirror.text().includes(CPR));
  });

  test('a spawned keeper is listed as starting at once, with the meta of its spec, and the hello resolves spawn', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const spec = box.spec({
      meta: { ...box.spec().meta, kind: 'new', slot: 4, label: 'fix it', dir: box.s.home },
    });
    const spawning = r.registry.spawn(spec);
    const early = info(r.registry, spec.id);
    assert.equal(early.state, 'starting');
    assert.equal(early.slot, 4);
    const term = await spawning;
    assert.equal(term.id, spec.id);
    assert.equal(term.state, 'starting');
    assert.equal(term.kind, 'new');
    assert.equal(term.label, 'fix it');
    assert.equal(term.dir, box.s.home);
    assert.equal(term.expectedSessionId, SESSION);
    assert.equal(term.sessionId, null);
    assert.equal(term.program, null);
    assert.equal(term.openedNs, BigInt(spec.meta.openedNs));
    assert.deepEqual([term.cols, term.rows], [80, 24]);
    assert.deepEqual(
      r.events.hello.map((e) => e.origin),
      ['spawned'],
    );
    await sleep(500);
    assert.equal(existsSync(spec.env['STANDIN_RECORD'] ?? ''), false, 'the registry sent no G');

    r.registry.start(spec.id);
    await until(() => r.events.started.length === 1, 'started');
    const running = info(r.registry, spec.id);
    assert.equal(running.state, 'running');
    assert.deepEqual(running.program, {
      pid: r.events.started[0]?.started.pid,
      procStart: r.events.started[0]?.started.procStart,
    });
  });

  test('setSession and a resize reach list() and onChange; the size reaches sinks when R comes back', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror } = await startStandin(box, r);
    let changes = 0;
    const off = r.registry.onChange(() => {
      changes += 1;
    });
    r.registry.setSession(spec.id, SESSION, true);
    assert.equal(info(r.registry, spec.id).sessionId, SESSION);
    assert.equal(info(r.registry, spec.id).notReported, true);
    assert.ok(changes >= 1);
    // A size above the clamp (1000 x 500) is not an error: it is cut.
    r.registry.resize(spec.id, 5000, 900);
    await until(() => mirror.calls.includes('s'), 'a size record');
    assert.deepEqual([mirror.term.cols, mirror.term.rows], [1000, 500]);
    const resized = await waitForRecord(
      spec.env['STANDIN_RECORD'] ?? '',
      (x) => x.ev === 'resize',
      5000,
    );
    assert.deepEqual(resized, { ...resized, cols: 1000, rows: 500 });
    assert.deepEqual([info(r.registry, spec.id).cols, info(r.registry, spec.id).rows], [1000, 500]);
    off();
    const before = changes;
    r.registry.setSession(spec.id, null, false);
    assert.equal(changes, before, 'an unsubscribed listener is not called');
  });

  test('refuse sends N with the reason cut to 1,024 bytes: the keeper ends the terminal not started', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const spec = box.spec();
    await r.registry.spawn(spec);
    const reason = `the session runs elsewhere ${'é'.repeat(2000)}`;
    r.registry.refuse(spec.id, reason);
    await until(() => r.events.exited.length === 1, 'the exit of a refused start');
    const exit = r.events.exited[0];
    assert.ok(exit);
    assert.equal(exit.lost, false);
    assert.equal(exit.exit.code, null);
    const notStarted = exit.exit.notStarted ?? '';
    assert.ok(reason.startsWith(notStarted), 'the reason, cut');
    assert.ok(new TextEncoder().encode(notStarted).length <= 1024);
    assert.ok(notStarted.length > 500, 'cut at the limit, not dropped');
    assert.equal(info(r.registry, spec.id).state, 'not-started');
    await until(() => !existsSync(spec.socket), 'the keeper ended after A');
  });
  test('a sink detached before its snapshot, or of a terminal closed before it, gets no call', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror: first } = await startStandin(box, r);
    const early = mirror(box.modules);
    const handle = r.registry.attach(spec.id, early);
    assert.ok(handle);
    handle.detach();
    // A sink attached while output is queued: the snapshot first, then each later record once.
    assert.equal(r.registry.input(spec.id, utf8('/lines 300\r')), 'ok');
    await until(() => first.text().includes('line 10\r\n'), 'output under way');
    const during = await attachMirror(r.registry, box.modules, spec.id);
    await until(() => prompts(first) >= 2, 'the prompt after the lines');
    await typeLine(r, spec.id, first, '/idle');
    await until(() => prompts(during) >= 1, 'the late sink saw the next prompt');
    await Promise.all([first.settled(), during.settled()]);
    assertSameScreen(first.term, during.term);
    assert.deepEqual(early.calls, []);

    r.registry.refuse(spec.id, 'x'); // running: N is ignored by the keeper
    assert.equal(r.registry.input(spec.id, utf8('/exit\r')), 'ok');
    await until(() => info(r.registry, spec.id).state === 'ended', 'ended');
    const gone = mirror(box.modules);
    assert.ok(r.registry.attach(spec.id, gone));
    assert.equal(r.registry.close(spec.id), 'ok');
    await sleep(300);
    assert.deepEqual(gone.calls, [], 'closed before its snapshot was made');
  });
});

describe('registry: the end of a program', () => {
  test('/exit → exited with code 0, A sent, the socket and pid line gone; close forgets it; close of a running one → running', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const a = await startStandin(box, r);
    const b = await startStandin(box, r);
    assert.equal(r.registry.close(b.spec.id), 'running');
    assert.equal(r.registry.close('0123456789ab'), 'unknown');

    assert.equal(r.registry.input(a.spec.id, utf8('/exit\r')), 'ok');
    await until(() => r.events.exited.length === 1, 'the exit', 10_000);
    const ended = r.events.exited[0];
    assert.ok(ended);
    assert.deepEqual([ended.exit.code, ended.exit.signal, ended.lost], [0, null, false]);
    assert.equal(info(r.registry, a.spec.id).state, 'ended');
    assert.deepEqual(info(r.registry, a.spec.id).exit, ended.exit);
    await until(() => a.mirror.exits.length === 1, 'the sink got the exit');
    assert.equal(a.mirror.calls.at(-1), 'x', 'the exit comes after every record');
    const pidFile = box.files.termPid(a.spec.id);
    await until(
      () => !existsSync(a.spec.socket) && !existsSync(pidFile),
      'the keeper ended (A was sent)',
    );
    assert.equal(r.registry.input(a.spec.id, utf8('x')), 'ended');
    // The last screen stays until close.
    const late = await attachMirror(r.registry, box.modules, a.spec.id);
    await late.settled();
    assert.deepEqual(late.calls, ['S', 'x'], 'the state at the attach point follows the snapshot');
    assert.deepEqual(late.exits, [{ exit: ended.exit, lost: false }]);
    assert.equal(r.registry.close(a.spec.id), 'ok');
    assert.equal(
      r.registry.list().some((x) => x.id === a.spec.id),
      false,
    );
    assert.equal(r.registry.close(a.spec.id), 'unknown');
    assert.equal(r.registry.attach(a.spec.id, late), null);
  });

  test('the keeper killed → exited with lost true, and the stand-in ended', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror } = await startStandin(box, r);
    const keeper = box.keeperOf(spec.id);
    const program = info(r.registry, spec.id).program;
    assert.ok(program);
    box.signalKeeper(keeper, 'SIGKILL');
    await until(() => r.events.exited.length === 1, 'the loss', 10_000);
    assert.equal(r.events.exited[0]?.lost, true);
    assert.equal(info(r.registry, spec.id).state, 'lost');
    await until(() => mirror.exits.length === 1, 'the sink got the loss');
    assert.equal(mirror.exits[0]?.lost, true);
    await waitForRecord(spec.env['STANDIN_RECORD'] ?? '', (x) => x.ev === 'hup', 10_000);
    // A late sink gets the snapshot, then the loss.
    const late = await attachMirror(r.registry, box.modules, spec.id);
    await until(() => late.calls.length === 2, 'the loss after the snapshot');
    assert.deepEqual(late.calls, ['S', 'x']);
    assert.equal(late.exits[0]?.lost, true);
    // Its files go with it: the keeper's line is dead (ruled, review 1).
    assert.ok(existsSync(spec.socket) && existsSync(box.files.termPid(spec.id)), 'left by SIGKILL');
    assert.equal(r.registry.close(spec.id), 'ok');
    assert.equal(existsSync(spec.socket), false);
    assert.equal(existsSync(box.files.termPid(spec.id)), false);
  });
});

describe('registry: starts that fail', () => {
  test('python3 missing → KeeperStartError python-missing with S2 14’s message; nothing is kept', async (t) => {
    const box = await registrySandbox(t);
    const bare = join(box.s.root, 'bare-bin');
    const platform = { ...box.tp.platform, env: { ...box.tp.platform.env, PATH: bare } };
    const r = box.registry({ platform });
    const spec = box.spec();
    const error = await r.registry.spawn(spec).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof KeeperStartError, String(error));
    assert.equal(error.kind, 'python-missing');
    assert.equal(
      error.message,
      'python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)',
    );
    assert.deepEqual(r.registry.list(), []);
  });

  test('a keeper that ends at start (it refused its spec) → spawn-failed; nothing is kept', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const error = await r.registry.spawn({ ...box.spec(), argv: [] }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof KeeperStartError, String(error));
    assert.equal(error.kind, 'spawn-failed');
    assert.deepEqual(r.registry.list(), []);
    assert.ok(box.logLines().some((line) => line.endsWith(': bad-spec')));
  });

  test('a socket path of 108 bytes → path-too-long, refused before spawning', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const spec = box.spec();
    const long = `/${'d'.repeat(108 - '/'.length - '/0123456789ab.sock'.length)}/0123456789ab.sock`;
    assert.equal(Buffer.byteLength(long), 108);
    const error = await r.registry.spawn({ ...spec, socket: long }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof KeeperStartError);
    assert.equal(error.kind, 'path-too-long');
    assert.deepEqual(r.registry.list(), []);
    assert.deepEqual(r.spawned, [], 'refused before spawning: no keeper was started');
  });

  test('a keeper whose hello comes late → no-hello after 5 s, the terminal kept, its hello reported as late; no G', async (t) => {
    const box = await registrySandbox(t);
    // python3 replaced by a script that sleeps 7 s, then runs the real one.
    const slow = join(box.s.root, 'slow-bin');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(slow);
    const script = join(slow, 'python3');
    writeFileSync(script, `#!/bin/sh\nsleep 7\nexec ${join(box.s.bin, 'python3')} "$@"\n`);
    chmodSync(script, 0o755);
    const platform = {
      ...box.tp.platform,
      env: { ...box.tp.platform.env, PATH: `${slow}:${box.s.bin}` },
    };
    const r = box.registry({ platform });
    const spec = box.spec();
    const began = performance.now();
    const error = await r.registry.spawn(spec).then(
      () => null,
      (e: unknown) => e,
    );
    const waited = performance.now() - began;
    assert.ok(error instanceof KeeperStartError, String(error));
    assert.equal(error.kind, 'no-hello');
    assert.ok(waited >= 4900 && waited < 6900, `rejected after ${Math.round(waited)} ms`);
    assert.equal(info(r.registry, spec.id).state, 'starting', 'the terminal is kept');
    await within(
      until(() => r.events.hello.length === 1, 'the late hello', 10_000),
      'the late hello',
      11_000,
    );
    assert.equal(r.events.hello[0]?.origin, 'late');
    assert.equal(r.events.hello[0]?.hello.started, false);
    await sleep(500);
    assert.equal(existsSync(spec.env['STANDIN_RECORD'] ?? ''), false, 'no G was sent');
  });
});

describe('registry: slots and input', () => {
  test('nextSlot: 1, 2, 3 in order; after the second ends and is closed, 2 again; the tenth gets null', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const ids: string[] = [];
    const open = async (): Promise<string> => {
      const slot = r.registry.nextSlot();
      const spec = box.spec({ meta: { ...box.spec().meta, slot } });
      await r.registry.spawn(spec);
      ids.push(spec.id);
      return spec.id;
    };
    assert.equal(r.registry.nextSlot(), 1);
    await open();
    assert.equal(r.registry.nextSlot(), 2);
    const second = await open();
    assert.equal(r.registry.nextSlot(), 3);
    await open();
    r.registry.refuse(second, 'closing it');
    await until(() => info(r.registry, second).state === 'not-started', 'the second ended');
    assert.equal(r.registry.nextSlot(), 4, 'an ended terminal keeps its slot until it is closed');
    assert.equal(r.registry.close(second), 'ok');
    assert.equal(r.registry.nextSlot(), 2);
    await open();
    for (let i = 0; i < 6; i++) {
      await open();
    }
    assert.equal(r.registry.list().length, 9);
    assert.equal(r.registry.nextSlot(), null, 'the tenth gets no slot');
  });

  test('input while the program does not read: full once more than 4 MiB waits, ok again after; no byte lost', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror } = await startStandin(box, r);
    assert.equal(r.registry.input(spec.id, utf8('/stall 5\r')), 'ok');
    await until(() => mirror.text().includes('stalling 5 s'), 'the stall began');
    const chunk = new Uint8Array(64 * 1024).fill(0x61); // 'a', echoed when read
    let accepted = 0;
    let full = false;
    for (let sent = 0; sent < 6 * 1024 * 1024; sent += chunk.length) {
      const answer = r.registry.input(spec.id, chunk);
      if (answer === 'full') {
        full = true;
      } else {
        assert.equal(answer, 'ok');
        accepted += chunk.length;
      }
    }
    assert.equal(full, true, 'more than 4 MiB unwritten is full');
    assert.ok(accepted > 4 * 1024 * 1024 && accepted < 6 * 1024 * 1024, `accepted ${accepted}`);
    await until(() => r.registry.input(spec.id, new Uint8Array(0)) === 'ok', 'ok again', 15_000);
    // Everything accepted reaches the program, in order (it records each chunk it reads).
    await until(
      () => {
        const read = readRecords(spec.env['STANDIN_RECORD'] ?? '')
          .flatMap((x) => (x.ev === 'input' ? [x.hex] : []))
          .join('');
        return read.split('61').length - 1 >= accepted;
      },
      'every accepted byte was read',
      30_000,
    );
  });

  test('unknown terminals: input unknown, attach null; resize, start and refuse do nothing', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    assert.equal(r.registry.input('0123456789ab', utf8('x')), 'unknown');
    assert.equal(r.registry.attach('0123456789ab', mirror(box.modules)), null);
    r.registry.resize('0123456789ab', 80, 24);
    r.registry.start('0123456789ab');
    r.registry.refuse('0123456789ab', 'no');
    assert.deepEqual(r.registry.list(), []);
  });
});
