// The terminal registry (S2 7.1–7.8, 8.1, 8.2.4; plan task 16): spawning keepers, claiming them,
// streams to sinks in order, the slot rule, input and its limit, the end of a program, starts that
// fail. Platform: realTestPlatform; real keepers running the stand-in; G is sent by the test.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

/** The state letter of /proc/<pid>/stat (field 3, after the command name in parentheses). */
function procState(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
}

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

  test('the server stopping while a spawned keeper starts → stopping (ruled, task 21): forgotten, the keeper lives on', async (t) => {
    const box = await registrySandbox(t);
    const slow = join(box.s.root, 'slow-bin');
    mkdirSync(slow);
    const script = join(slow, 'python3');
    writeFileSync(script, `#!/bin/sh\nsleep 2\nexec ${join(box.s.bin, 'python3')} "$@"\n`);
    chmodSync(script, 0o755);
    const platform = {
      ...box.tp.platform,
      env: { ...box.tp.platform.env, PATH: `${slow}:${box.s.bin}` },
    };
    const r = box.registry({ platform });
    const spec = box.spec();
    const spawning = r.registry.spawn(spec).then(
      () => null,
      (e: unknown) => e,
    );
    await sleep(300);
    await r.registry.stopAll();
    const error = await spawning;
    assert.ok(error instanceof KeeperStartError, String(error));
    assert.equal(error.kind, 'stopping');
    assert.deepEqual(r.registry.list(), []);
    assert.equal(r.spawned.length, 1, 'its keeper was started');
    // Its pid line, not only its socket (bound first): the cleanup's killKeepersIn finds keepers
    // by their pid lines, and must not miss this one.
    await until(
      () => existsSync(box.files.termPid(spec.id)),
      'the keeper came up after all (its pid line)',
      10_000,
    );
    // Before anything is spawned, a stopped registry still answers spawn-failed.
    const late = await r.registry.spawn(box.spec()).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(late instanceof KeeperStartError);
    assert.equal(late.kind, 'spawn-failed');
    assert.equal(r.spawned.length, 1, 'nothing more was started');
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

  test('input while the program does not read: full once more than 4 MiB waits, ok again as soon as no more than 4 MiB wait; no byte lost', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror } = await startStandin(box, r);
    const MiB = 1024 * 1024;
    const CHUNK = 64 * 1024; // one I frame of 64 KiB and 5 bytes each (the server's INPUT_CHUNK)
    // `full` comes once more than 4 MiB of frames wait at the server (INPUT_UNWRITTEN,
    // src/window/terminals.ts): 63 frames are under the mark, so a 64th is still sent, and 64 are
    // over it. A frame the kernel takes at once no longer waits at the server, so how much is
    // answered `ok` first depends on what takes frames outside it while the loop below runs. A
    // running keeper takes, while the program does not read, its input queue (INPUT_CAP, 4 MiB,
    // bin/skydeck-keeper) and its buffers besides: 4 MiB and 256 KiB measured, or as little as
    // three frames when this loop beats it. (This test sent 6 MiB and failed when a loaded test
    // process let the keeper fill its queue first.) So the keeper is stopped while the loop runs:
    // then only the socket's kernel buffer takes frames, up to its size (net.core.wmem_default)
    // and one frame more, and the amount pins the mark whatever the speeds.
    const AT_SERVER = 4 * MiB; // 64 chunks
    const OUTSIDE = Number(readFileSync('/proc/sys/net/core/wmem_default', 'utf8')) + CHUNK;
    const SEND = AT_SERVER + OUTSIDE + MiB; // clearly more
    const STALL_S = 5;
    // Chunk n begins with its number and is otherwise one letter, 'a' to 'z' in turn: a lost,
    // repeated or reordered chunk shows.
    const chunks = Array.from({ length: Math.ceil(SEND / CHUNK) }, (_, n) => {
      const chunk = new Uint8Array(CHUNK).fill(0x61 + (n % 26));
      chunk.set(utf8(`${String(n).padStart(5, '0')}.`));
      return chunk;
    });
    const stallAsked = performance.now();
    assert.equal(r.registry.input(spec.id, utf8(`/stall ${STALL_S}\r`)), 'ok');
    await until(() => mirror.text().includes(`stalling ${STALL_S} s`), 'the stall began');
    const keeper = box.keeperOf(spec.id);
    const taken: Uint8Array[] = [];
    let full = false;
    box.signalKeeper(keeper, 'SIGSTOP');
    try {
      // SIGSTOP takes effect asynchronously: the loop starts once the keeper is stopped (state T).
      // A keeper still stopped at the teardown is ended too: killKeepersIn sends SIGKILL.
      await until(() => procState(keeper.pid) === 'T', 'the keeper stopped');
      for (const chunk of chunks) {
        const answer = r.registry.input(spec.id, chunk);
        if (answer === 'full') {
          full = true;
        } else {
          assert.equal(answer, 'ok');
          taken.push(chunk);
        }
      }
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    assert.equal(full, true, 'more than 4 MiB unwritten is full');
    // The 64 chunks waiting at the server and the ones the kernel took whole: at least the first
    // (the socket's buffer is empty and larger than a frame), at most OUTSIDE.
    const accepted = taken.length * CHUNK;
    assert.ok(
      accepted > AT_SERVER && accepted <= AT_SERVER + OUTSIDE,
      `accepted ${accepted}: more than ${AT_SERVER} and at most ${AT_SERVER + OUTSIDE} expected`,
    );
    const record = spec.env['STANDIN_RECORD'] ?? '';
    const typed = Buffer.from(`/stall ${STALL_S}\r`).toString('hex');
    const read = (): string =>
      readRecords(record)
        .flatMap((x) => (x.ev === 'input' ? [x.hex] : []))
        .join('');
    // `ok` is back as soon as no more than 4 MiB wait at the server: once the keeper, running
    // again, has taken the frame in flight (63 frames may still wait then) — not once it has taken
    // everything, and not once the program reads. So at that moment the stalled program has read
    // nothing of what was sent, only its /stall line.
    await until(() => r.registry.input(spec.id, new Uint8Array(0)) === 'ok', 'ok again', 15_000);
    const okAt = Math.round(performance.now() - stallAsked);
    const atOk = read();
    assert.ok(
      atOk === typed,
      `ok was back ${okAt} ms after the ${STALL_S} s stall was asked for, and the program had ` +
        `read ${atOk.length / 2} bytes, not only its /stall line (${typed.length / 2})`,
    );
    // After the stall, everything accepted reaches the program, in order, and nothing else (it
    // records each chunk it reads; a refused chunk was never sent).
    const expected = typed + Buffer.concat(taken).toString('hex');
    await until(
      // The file's size first: it is cheap, and it holds at least the hex of what was read.
      () => statSync(record).size >= expected.length && read().length >= expected.length,
      () => `every accepted byte was read (${read().length / 2} of ${expected.length / 2} bytes)`,
      60_000,
    );
    const hex = read();
    assert.equal(hex.length, expected.length, 'nothing but the accepted input was read');
    if (hex !== expected) {
      let at = 0;
      while (hex[at] === expected[at]) at++;
      const where =
        at < typed.length
          ? 'the /stall line'
          : `chunk ${Math.floor((at - typed.length) / 2 / CHUNK)}`;
      assert.fail(
        `the input read differs from what was accepted at byte ${Math.floor(at / 2)}, in ${where}`,
      );
    }
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
