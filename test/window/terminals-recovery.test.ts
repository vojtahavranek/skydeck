// The registry across server restarts and failures (S2 7.3, 7.7, 7.8, 14; plan task 16):
// rebuilding every screen exactly from snapshot and tail, parking, reconnecting to a keeper that is
// slow, gap and newer keepers. Platform: realTestPlatform; real keepers running the stand-in.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import {
  decodeSnapshot,
  encodeFrame,
  encodeSnapshot,
  frameReader,
} from '../../src/window/frames.ts';
import type { Frame, FrameType, KeeperSpec } from '../../src/window/frames.ts';
import type { Platform } from '../../src/platform/types.ts';
import { PROMPT, SESSION, sleep, until } from '../helpers/keeper.ts';
import {
  assertSameScreen,
  attachMirror,
  info,
  mirror,
  registrySandbox,
  settledTerm,
} from '../helpers/registry.ts';
import type { Mirror, RegistryBox, TestRegistry } from '../helpers/registry.ts';
import { readRecords } from '../helpers/standin.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const prompts = (m: Mirror): number => m.text().split(PROMPT).length - 1;

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

async function typeLine(r: TestRegistry, id: string, m: Mirror, line: string): Promise<void> {
  const before = prompts(m);
  assert.equal(r.registry.input(id, utf8(`${line}\r`)), 'ok');
  await until(() => prompts(m) > before, `a prompt after ${line}`, 15_000);
}

/** The last screen-side terminal a registry made, settled. */
async function screenOf(r: TestRegistry): Promise<NonNullable<TestRegistry['terminals'][0]>> {
  const term = r.terminals.at(-1);
  assert.ok(term, 'the registry made no screen side');
  await settledTerm(term);
  return term;
}

function inputHex(spec: KeeperSpec): string[] {
  return readRecords(spec.env['STANDIN_RECORD'] ?? '').flatMap((x) =>
    x.ev === 'input' ? [x.hex] : [],
  );
}

describe('registry: rebuilding after a restart', () => {
  test('dropped without parking → a new registry rebuilds the screen cell by cell; after stopAll, from the parked snapshot', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const { spec, mirror } = await startStandin(box, r1);
    await typeLine(r1, spec.id, mirror, '/red red text');
    await typeLine(r1, spec.id, mirror, '/lines 150');
    r1.registry.resize(spec.id, 100, 30);
    await until(() => mirror.term.cols === 100, 'the first resize');
    await typeLine(r1, spec.id, mirror, '/wide');
    r1.registry.resize(spec.id, 70, 20);
    await until(() => mirror.term.cols === 70, 'the second resize');
    await typeLine(r1, spec.id, mirror, '/lines 30');
    await typeLine(r1, spec.id, mirror, '/alt');
    await typeLine(r1, spec.id, mirror, '/hide-cursor');
    const typedBefore = inputHex(spec).length;

    // The server crashes: nothing parked, the connection gone.
    r1.drop();
    const old = await screenOf(r1);
    const r2 = box.registry();
    const found = await r2.registry.rediscover();
    assert.deepEqual(
      found.map((x) => x.id),
      [spec.id],
    );
    assert.equal(r2.events.hello[0]?.origin, 'found');
    assert.equal(r2.events.hello[0]?.hello.snapSeq, 0, 'nothing but the start was parked');
    assert.equal(found[0]?.state, 'running');
    assertSameScreen(old, await screenOf(r2));
    const page = await attachMirror(r2.registry, box.modules, spec.id);
    await page.settled();
    assertSameScreen(old, page.term);
    // The replayed start queries were not answered a second time.
    await sleep(500);
    assert.equal(inputHex(spec).length, typedBefore, 'no answer while replaying');

    // A clean stop parks; the next registry starts from the parked snapshot.
    await typeLine(r2, spec.id, page, '/main');
    const before = await screenOf(r2);
    await r2.registry.stopAll();
    const r3 = box.registry();
    await r3.registry.rediscover();
    assert.ok((r3.events.hello[0]?.hello.snapSeq ?? 0) > 0, 'a parked snapshot');
    assertSameScreen(before, await screenOf(r3));
    await typeLine(r3, spec.id, await attachMirror(r3.registry, box.modules, spec.id), '/idle');
  });

  test('parks: 30 s after output (shortened for the test) with /lines 30000, and past 1 MiB of tail', async (t) => {
    const box = await registrySandbox(t);
    const timed: Platform = {
      ...box.tp.platform,
      env: { ...box.tp.platform.env, SKYDECK_TEST_PARK_MS: '300' },
    };
    const r1 = box.registry({ platform: timed });
    const a = await startStandin(box, r1);
    await typeLine(r1, a.spec.id, a.mirror, '/lines 30000');
    await sleep(1000);
    r1.drop();
    const r2 = box.registry();
    await r2.registry.rediscover();
    assert.ok((r2.events.hello[0]?.hello.snapSeq ?? 0) > 0, 'the time rule parked');

    // The size rule, with the design's values.
    const b = await startStandin(box, r2);
    await typeLine(r2, b.spec.id, b.mirror, '/flood 1300000');
    await sleep(1000);
    r2.drop();
    const r3 = box.registry();
    await r3.registry.rediscover();
    const hello = r3.events.hello.find((e) => e.hello.id === b.spec.id)?.hello;
    assert.ok((hello?.snapSeq ?? 0) > 0, 'the 1 MiB rule parked');
  });

  test('a keeper stopped for 3 s → reconnecting, then running again, never lost', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { spec, mirror } = await startStandin(box, r);
    const keeper = box.keeperOf(spec.id);
    const hellos = r.events.hello.length;
    const outputs = mirror.outputs.length;
    box.signalKeeper(keeper, 'SIGSTOP');
    try {
      // A stopped keeper keeps its connection open: the registry notices only when it ends.
      r.sockets.at(-1)?.destroy();
      await until(() => info(r.registry, spec.id).state === 'reconnecting', 'reconnecting');
      await sleep(3000);
      assert.equal(info(r.registry, spec.id).state, 'reconnecting');
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await until(() => info(r.registry, spec.id).state === 'running', 'running again', 10_000);
    await sleep(300);
    assert.equal(mirror.outputs.length, outputs, 'the reconnect forwarded no record again');
    assert.equal(r.states.get(spec.id)?.includes('lost'), false);
    assert.equal(r.events.hello.length, hellos + 1, 'one hello for the reconnect');
    assert.equal(r.events.hello.at(-1)?.origin, 'found', 'a reconnect hello is found');
    await typeLine(r, spec.id, mirror, '/idle');
    assert.deepEqual(r.events.exited, []);
    // The screen went on from where it was: the sink got no record twice.
    await mirror.settled();
    assertSameScreen(await screenOf(r), mirror.term);
    assert.equal(r.terminals.length, 1, 'the screen side was not rebuilt');
  });

  test("a spawned keeper's first size is parked at once (record 0): a later claim gets it in S", async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const spec = box.spec({ cols: 91, rows: 33 });
    await r.registry.spawn(spec);
    r.registry.resize(spec.id, 60, 20);
    await until(() => info(r.registry, spec.id).cols === 60, 'the resize came back');
    r.drop();
    const socket = await box.tp.platform.net.connectUnix(spec.socket);
    t.after(() => socket.destroy());
    const reader = frameReader();
    const frames: Frame[] = [];
    socket.on('data', (chunk) => {
      const got = reader.push(chunk);
      if (!('error' in got)) frames.push(...got);
    });
    socket.write(encodeFrame('C'));
    await until(() => frames.length >= 3, 'hello, snapshot and the resize record');
    assert.deepEqual(
      frames.map((f) => f.type),
      ['H', 'S', 'R'],
    );
    const snap = decodeSnapshot(frames[1]?.payload ?? new Uint8Array(0));
    assert.deepEqual(snap && [snap.seq, snap.cols, snap.rows], [0, 91, 33]);
  });

  test('a gap → notice gap on the terminal and the width changed by one column and back', async (t) => {
    const box = await registrySandbox(t);
    const small: Platform = {
      ...box.tp.platform,
      env: { ...box.tp.platform.env, SKYDECK_TEST_KEEPER_TAIL_BYTES: '20000' },
    };
    const r1 = box.registry({ platform: small });
    const { spec, mirror } = await startStandin(box, r1);
    await typeLine(r1, spec.id, mirror, '/lines 4000');
    // A reconnect of a registry that has every record: the keeper's gap lost nothing for it.
    const outputs = mirror.outputs.length;
    r1.sockets.at(-1)?.destroy();
    await until(() => r1.events.hello.length === 2, 'the reconnect');
    assert.equal(r1.events.hello[1]?.hello.gap, true);
    assert.ok((r1.events.hello[1]?.hello.tailFrom ?? 0) > 1, 'the tail starts after the dropped');
    await until(() => info(r1.registry, spec.id).state === 'running', 'running again');
    await sleep(300);
    assert.equal(mirror.outputs.length, outputs, 'the reconnect forwarded no record again');
    await typeLine(r1, spec.id, mirror, '/idle');
    assert.deepEqual(mirror.notices, [], 'no gap notice for a screen that lost nothing');
    assert.equal(r1.terminals.length, 1, 'not rebuilt');
    r1.drop();
    const r2 = box.registry();
    await r2.registry.rediscover();
    assert.equal(r2.events.hello[0]?.hello.gap, true);
    const page = await attachMirror(r2.registry, box.modules, spec.id);
    await until(() => page.notices.length === 1, 'the gap notice');
    assert.deepEqual(page.notices, [
      {
        kind: 'gap',
        text: "part of this terminal's output was lost while skydeck's server was not running",
      },
    ]);
    await until(
      () =>
        readRecords(spec.env['STANDIN_RECORD'] ?? '').filter((x) => x.ev === 'resize').length >= 2,
      'two resizes',
    );
    const sizes = readRecords(spec.env['STANDIN_RECORD'] ?? '').flatMap((x) =>
      x.ev === 'resize' ? [[x.cols, x.rows]] : [],
    );
    assert.deepEqual(sizes, [
      [79, 24],
      [80, 24],
    ]);
    assert.ok(r2.log.some((line) => line.includes('gap')));
    assert.deepEqual(
      readRecords(spec.env['STANDIN_RECORD'] ?? '').filter((x) => x.ev === 'resize').length,
      2,
      'the first registry made no redraw',
    );
    // The count is exact after a gap (tailFrom): a park clears it for the next server.
    await r2.registry.stopAll();
    const r3 = box.registry();
    await r3.registry.rediscover();
    assert.equal(r3.events.hello[0]?.hello.gap, false);
    assert.ok((r3.events.hello[0]?.hello.snapSeq ?? 0) > 0);
  });
});

describe('registry: a keeper with a newer protocol', () => {
  test('state newer-keeper, the notice with S2 7.7’s text, never attached; its program is left alone', async (t) => {
    const box = await registrySandbox(t);
    const id = 'abcdef012345';
    const path = box.files.termSock(id);
    const received: string[] = [];
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      sockets.push(socket);
      const reader = frameReader();
      socket.on('data', (chunk) => {
        const frames = reader.push(chunk);
        if ('error' in frames) return;
        for (const frame of frames) {
          received.push(frame.type);
          if (frame.type === 'C') {
            const hello = {
              protocol: 2,
              keeper: '9',
              id,
              started: true,
              startBy: '1',
              lock: null,
              pid: process.pid,
              procStart: 1,
              cols: 90,
              rows: 30,
              seq: 3,
              snapSeq: 0,
              tailFrom: 1,
              gap: false,
              meta: {
                sessionId: SESSION,
                kind: 'resume',
                slot: 2,
                openedNs: '1',
                build: 'newer',
                label: null,
                dir: box.s.home,
              },
              exited: null,
              more: 'a field of protocol 2',
            };
            socket.write(encodeFrame('H', utf8(JSON.stringify(hello))));
          }
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    // A pid line that is alive: this test process (killKeepersIn never signals it).
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    box.tp.platform.files.writeText(
      box.files.termPid(id),
      `${process.pid} ${procStartFromStat(stat)} ${bootId} 9 1\n`,
    );

    const r = box.registry();
    const found = await r.registry.rediscover();
    assert.deepEqual(
      found.map((x) => [x.id, x.state, x.slot]),
      [[id, 'newer-keeper', 2]],
    );
    const page = await attachMirror(r.registry, box.modules, id);
    await until(() => page.notices.length === 1, 'the notice');
    assert.deepEqual(page.notices, [
      {
        kind: 'newer-keeper',
        text: 'this terminal was started by a newer skydeck; run skydeck window --restart',
      },
    ]);
    await sleep(300);
    assert.deepEqual(received, ['C'], 'nothing but the claim was sent');
    assert.equal(r.registry.input(id, utf8('x')), 'full');
    assert.equal(r.registry.close(id), 'running', 'its program keeps running');
  });
});

describe('registry: closing a lost terminal', () => {
  /**
   * A keeper played by this test: a socket in terms/ that answers C with a protocol-1 hello, and
   * a pid line naming this test process (alive; killKeepersIn never signals it).
   */
  async function fakeKeeper(
    t: TestContext,
    box: RegistryBox,
    id: string,
  ): Promise<{ stop(): Promise<void> }> {
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
      const reader = frameReader();
      socket.on('data', (chunk) => {
        const frames = reader.push(chunk);
        if ('error' in frames || !frames.some((f) => f.type === 'C')) return;
        const hello = {
          protocol: 1,
          keeper: '2',
          id,
          started: true,
          startBy: '1',
          lock: null,
          pid: process.pid,
          procStart: 1,
          cols: 80,
          rows: 24,
          seq: 0,
          snapSeq: 0,
          tailFrom: 1,
          gap: false,
          meta: {
            sessionId: SESSION,
            kind: 'resume',
            slot: 1,
            openedNs: '1',
            build: 'test',
            label: null,
            dir: box.s.home,
          },
          exited: null,
        };
        socket.write(encodeFrame('H', utf8(JSON.stringify(hello))));
      });
    });
    await new Promise<void>((resolve) => server.listen(box.files.termSock(id), resolve));
    const stop = async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    t.after(stop);
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    box.tp.platform.files.writeText(
      box.files.termPid(id),
      `${process.pid} ${procStartFromStat(stat)} ${bootId} 2 1\n`,
    );
    return { stop };
  }

  for (const line of ['alive', 'unknown'] as const) {
    test(`a lost terminal whose pid line is ${line}: close removes none of its keeper's files`, async (t) => {
      const box = await registrySandbox(t);
      const id = line === 'alive' ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb';
      const keeper = await fakeKeeper(t, box, id);
      // 'unknown': the boot id cannot be read, so no line can be judged.
      const platform: Platform =
        line === 'alive'
          ? box.tp.platform
          : {
              ...box.tp.platform,
              proc: {
                ...box.tp.platform.proc,
                bootId: () => {
                  throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
                },
              },
            };
      const r = box.registry({ platform });
      const found = await r.registry.rediscover();
      assert.deepEqual(
        found.map((x) => x.id),
        [id],
        `a ${line} line is connected to`,
      );
      // The keeper's socket now refuses: the terminal is lost (S2 7.8), its line still not dead.
      await keeper.stop();
      const sock = box.files.termSock(id);
      if (!existsSync(sock)) writeFileSync(sock, ''); // connecting to a file is refused too
      await until(() => info(r.registry, id).state === 'lost', 'lost', 10_000);
      assert.equal(r.registry.close(id), 'ok');
      assert.equal(existsSync(sock), true, 'the socket file stays');
      assert.equal(existsSync(box.files.termPid(id)), true, 'the pid line stays');
    });
  }
});

// ---------------------------------------------------------------------------------------------
// A keeper played by the test, frame by frame (review 2 of #52)

interface FakeConn {
  /** Frames the registry sent on this connection, after its C. */
  received: Frame[];
  send(type: FrameType, payload?: Uint8Array | string): void;
  /** Bytes as they are, for what the codec would refuse to build. */
  raw(bytes: Uint8Array): void;
  /** Ends the connection after what was written. */
  end(): void;
}

function helloOf(box: RegistryBox, id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol: 1,
    keeper: '2',
    id,
    started: true,
    startBy: '1',
    lock: null,
    pid: process.pid,
    procStart: 1,
    cols: 80,
    rows: 24,
    seq: 0,
    snapSeq: 0,
    tailFrom: 1,
    gap: false,
    meta: {
      sessionId: SESSION,
      kind: 'resume',
      slot: 1,
      openedNs: '1',
      build: 'test',
      label: null,
      dir: box.s.home,
    },
    exited: null,
    ...over,
  });
}

/**
 * A socket in terms/ whose every claim runs `script` (with the claim's number from 0), and a pid
 * line naming this test process: alive, and never signalled by killKeepersIn.
 */
async function scriptedKeeper(
  t: TestContext,
  box: RegistryBox,
  id: string,
  script: (conn: FakeConn, n: number) => void,
): Promise<{ conns: FakeConn[]; stop(): Promise<void> }> {
  const conns: FakeConn[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    const reader = frameReader();
    let conn: FakeConn | null = null;
    socket.on('data', (chunk) => {
      const frames = reader.push(chunk);
      if ('error' in frames) return;
      for (const frame of frames) {
        if (conn === null && frame.type === 'C') {
          conn = {
            received: [],
            send(type, payload) {
              if (!socket.destroyed) {
                socket.write(
                  encodeFrame(type, typeof payload === 'string' ? utf8(payload) : payload),
                );
              }
            },
            raw(bytes) {
              if (!socket.destroyed) socket.write(bytes);
            },
            end() {
              socket.end(); // what was written still arrives, then the connection ends
            },
          };
          conns.push(conn);
          script(conn, conns.length - 1);
        } else {
          conn?.received.push(frame);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(box.files.termSock(id), resolve));
  const stop = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(stop);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  box.tp.platform.files.writeText(
    box.files.termPid(id),
    `${process.pid} ${procStartFromStat(stat)} ${bootId} 2 1\n`,
  );
  return { conns, stop };
}

/** Every line of a headless terminal's active buffer, trimmed, without the empty ones. */
function screenLines(term: TestRegistry['terminals'][0]): string[] {
  const lines: string[] = [];
  const buffer = term.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const text = buffer.getLine(y)?.translateToString(true) ?? '';
    if (text !== '') lines.push(text);
  }
  return lines;
}

describe('registry: a keeper that misbehaves, and claims that break', () => {
  test('an attach while a found screen is being rebuilt gets the rebuilt screen, never an empty one', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c00000000001';
    await scriptedKeeper(t, box, id, (conn) => {
      conn.send('H', helloOf(box, id, { seq: 7, snapSeq: 5, tailFrom: 6 }));
      setTimeout(() => {
        conn.send('S', encodeSnapshot(5, 90, 30, 'PARKED-SCREEN\r\n'));
        conn.send('D', 'six\r\n');
        conn.send('D', 'seven\r\n');
      }, 200);
    });
    const r = box.registry();
    let page: Mirror | null = null;
    r.registry.onChange(() => {
      if (page === null && r.registry.list().some((x) => x.id === id)) {
        page = mirror(box.modules);
        assert.ok(r.registry.attach(id, page)); // the hub contract allows it inside onChange
        assert.notDeepEqual([info(r.registry, id).cols, info(r.registry, id).rows], [1, 1]);
      }
    });
    await r.registry.rediscover();
    const m = page as Mirror | null;
    assert.ok(m);
    await until(() => m.calls.length > 0, 'the snapshot');
    await m.settled();
    assert.deepEqual([m.term.cols, m.term.rows], [90, 30]);
    assert.deepEqual(screenLines(m.term), ['PARKED-SCREEN', 'six', 'seven']);
    // The snapshot is the screen where the stream was rebuilt; the tail follows it, once.
    assert.deepEqual(m.calls, ['S', 'o', 'o']);
  });

  test('one exit per terminal: X and then a broken connection, or X twice, give one exit', async (t) => {
    const box = await registrySandbox(t);
    const a = 'c00000000002';
    const big = 'x'.repeat(60_000);
    const fa = await scriptedKeeper(t, box, a, (conn, n) => {
      if (n === 0) {
        conn.send('H', helloOf(box, a));
        for (let i = 0; i < 50; i++) conn.send('D', big); // the screen side falls behind
        conn.send('X', JSON.stringify({ code: 0, signal: null, atNs: '5', notStarted: null }));
        conn.end();
      } else {
        conn.send(
          'H',
          helloOf(box, a, {
            seq: 50,
            tailFrom: 51,
            gap: true,
            exited: { code: 9, signal: null, atNs: '6', notStarted: null },
          }),
        );
        conn.send('X', JSON.stringify({ code: 9, signal: null, atNs: '6', notStarted: null }));
      }
    });
    const b = 'c00000000003';
    await scriptedKeeper(t, box, b, (conn) => {
      conn.send('H', helloOf(box, b));
      conn.send('X', JSON.stringify({ code: 1, signal: null, atNs: '5', notStarted: null }));
      conn.send('X', JSON.stringify({ code: 2, signal: null, atNs: '6', notStarted: null }));
    });
    const r = box.registry();
    await r.registry.rediscover();
    await until(() => r.events.exited.length >= 2, 'both exits', 10_000);
    await sleep(1500);
    assert.deepEqual(r.events.exited.map((e) => [e.term.id, e.exit.code, e.lost]).sort(), [
      [a, 0, false],
      [b, 1, false],
    ]);
    assert.equal(fa.conns.length, 1, 'no reconnect after the exit');
    assert.equal(info(r.registry, a).state, 'ended');
    assert.equal(info(r.registry, a).exit?.code, 0);
  });

  test('a claim that ends between its hello and its snapshot does not leave the old screen to go on with', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c00000000004';
    await scriptedKeeper(t, box, id, (conn, n) => {
      if (n === 0) {
        conn.send('H', helloOf(box, id, { seq: 3 }));
        for (const word of ['old1', 'old2', 'old3']) conn.send('D', `${word}\r\n`);
        setTimeout(() => conn.end(), 200);
        return;
      }
      conn.send('H', helloOf(box, id, { seq: 12, snapSeq: 10, tailFrom: 11 }));
      if (n === 1) {
        conn.end(); // right after the hello
        return;
      }
      conn.send('S', encodeSnapshot(10, 80, 24, 'SNAP\r\n'));
      conn.send('D', 'eleven\r\n');
      conn.send('D', 'twelve\r\n');
    });
    const r = box.registry();
    await r.registry.rediscover();
    await until(
      () => r.events.hello.length === 3,
      () =>
        `the third claim; log ${r.log.join(' | ')}; hellos ${r.events.hello.length}; states ${JSON.stringify([...r.states])}`,
      10_000,
    );
    await until(() => info(r.registry, id).state === 'running', 'running');
    const screen = r.terminals.at(-1);
    assert.ok(screen);
    await until(() => screenLines(screen).includes('twelve'), 'the tail on the screen');
    assert.deepEqual(screenLines(screen), ['SNAP', 'eleven', 'twelve']);
  });

  test('a keeper whose stream fails after its hello is claimed again once a second, and logged once', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c00000000005';
    const fake = await scriptedKeeper(t, box, id, (conn) => {
      conn.send('H', helloOf(box, id, { seq: 3, snapSeq: 2, tailFrom: 3 }));
      conn.send('D', 'not a snapshot'); // S must come first
    });
    const r = box.registry();
    await r.registry.rediscover();
    await sleep(2500);
    assert.ok(fake.conns.length <= 5, `${fake.conns.length} claims in 2.5 s`);
    assert.ok(fake.conns.length >= 2, 'it is claimed again');
    assert.equal(r.log.filter((line) => line.endsWith('snapshot missing')).length, 1);
  });

  test('a tail that stops coming: rediscover still resolves, and the terminal reconnects', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c00000000006';
    await scriptedKeeper(t, box, id, (conn) => {
      conn.send('H', helloOf(box, id, { seq: 5 }));
      conn.send('D', 'one\r\n'); // four records promised are never sent
    });
    const r = box.registry();
    const began = performance.now();
    const found = await r.registry.rediscover();
    const waited = performance.now() - began;
    assert.ok(
      waited >= 9500 && waited < 14_000,
      `given up after ${Math.round(waited)} ms (ruled: 10 s)`,
    );
    assert.deepEqual(
      found.map((x) => x.id),
      [id],
    );
    assert.ok(r.log.some((line) => line.endsWith('the tail stopped coming')));
    await until(() => (r.states.get(id) ?? []).includes('reconnecting'), 'reconnecting');
  });

  test('no answer while a reconnect replays the tail; a live query after it is answered once', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c00000000007';
    const fake = await scriptedKeeper(t, box, id, (conn, n) => {
      if (n === 0) {
        conn.send('H', helloOf(box, id));
        conn.send('D', '\x1b[c'); // live: answered
        setTimeout(() => conn.end(), 300);
        return;
      }
      conn.send('H', helloOf(box, id, { seq: 2 }));
      conn.send('D', '\x1b[c'); // record 1, on the screen already
      conn.send('D', '\x1b[c'); // record 2, written while no server was there: not answered
      setTimeout(() => conn.send('D', '\x1b[c'), 500); // live again
    });
    const r = box.registry();
    await r.registry.rediscover();
    const answers = (conn: FakeConn | undefined): number =>
      conn?.received.filter((f) => f.type === 'I').length ?? 0;
    await until(() => answers(fake.conns[0]) === 1, 'the live query answered');
    await until(() => fake.conns.length === 2, 'the reconnect');
    await sleep(300);
    assert.equal(answers(fake.conns[1]), 0, 'nothing answered while the tail is replayed');
    await until(() => answers(fake.conns[1]) === 1, 'the live query after it');
    await sleep(300);
    assert.equal(answers(fake.conns[0]), 1);
    assert.equal(answers(fake.conns[1]), 1);
  });

  test('keepers that answer wrongly are not listed, and each is logged by kind once', async (t) => {
    const box = await registrySandbox(t);
    const cases: [string, string, (conn: FakeConn) => void][] = [
      ['c0000000000a', 'first frame not a hello', (conn) => conn.send('D', 'x')],
      [
        'c0000000000b',
        'bad hello (hello.tailFrom: missing)',
        (conn) => conn.send('H', helloOf(box, 'c0000000000b', { tailFrom: undefined })),
      ],
      [
        'c0000000000c',
        'hello of another terminal',
        (conn) => conn.send('H', helloOf(box, 'c0000000000f')),
      ],
      [
        'c0000000000d',
        'hello with a size above 1000 x 500',
        (conn) => conn.send('H', helloOf(box, 'c0000000000d', { cols: 2000 })),
      ],
      [
        'c0000000000e',
        'keeper sent a frame the codec refuses (unknown-type)',
        (conn) => conn.raw(Uint8Array.of(0x51, 0, 0, 0, 0)),
      ], // 'Q': a type byte the codec does not know
    ];
    for (const [id, , script] of cases) {
      await scriptedKeeper(t, box, id, script);
    }
    const r = box.registry();
    const found = await r.registry.rediscover();
    assert.deepEqual(found, []);
    await sleep(2200); // the background claims go on, once a second
    for (const [id, kind] of cases) {
      assert.equal(
        r.log.filter((line) => line === `terminal ${id}: ${kind}`).length,
        1,
        `${kind}: ${r.log.join(' | ')}`,
      );
    }
    assert.deepEqual(r.registry.list(), []);
  });
});

describe('registry: the forced redraw', () => {
  test('a redraw whose connection breaks inside its pause is finished on the next connection', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c00000000008';
    const gapHello = (): string => helloOf(box, id, { seq: 3, snapSeq: 0, tailFrom: 3, gap: true });
    let onFirstZ = (): void => {};
    const fake = await scriptedKeeper(t, box, id, (conn, n) => {
      conn.send('H', gapHello());
      conn.send('D', 'three\r\n');
      if (n === 0) {
        const check = setInterval(() => {
          if (conn.received.some((f) => f.type === 'Z')) {
            clearInterval(check);
            conn.end(); // inside the 100 ms between the two resizes
            onFirstZ();
          }
        }, 5);
        t.after(() => clearInterval(check));
      }
    });
    const r = box.registry();
    // A page's resize that sends nothing (here a size that is no size) does not cancel the way back.
    onFirstZ = () => {
      r.registry.resize(id, Number.NaN, 24);
    };
    await r.registry.rediscover();
    await until(() => fake.conns.length === 2, 'the reconnect', 5000);
    const sizes = (conn: FakeConn | undefined): string[] =>
      (conn?.received ?? [])
        .filter((f) => f.type === 'Z')
        .map((f) => new TextDecoder().decode(f.payload));
    await until(() => sizes(fake.conns[1]).length > 0, 'the second resize', 5000);
    assert.deepEqual(sizes(fake.conns[0]), ['79 24']);
    assert.deepEqual(sizes(fake.conns[1]), ['80 24'], 'back to the width, not a new redraw');
  });
});

describe('registry: reading a keeper no faster than its screen side applies', () => {
  test('a flood into a slow screen side: the backlog stays at the mark, the keeper closes the claim, the screen is right after the reconnect', async (t) => {
    const box = await registrySandbox(t);
    const high = 256 * 1024;
    const platform: Platform = {
      ...box.tp.platform,
      env: {
        ...box.tp.platform.env,
        SKYDECK_TEST_BACKLOG_BYTES: String(high),
        SKYDECK_TEST_KEEPER_SEND_BYTES: String(512 * 1024),
      },
    };
    const r = box.registry({ platform, slowWriteMs: 3 });
    const { spec, mirror: page } = await startStandin(box, r);
    const before = prompts(page);
    assert.equal(r.registry.input(spec.id, utf8('/flood 3000000\r')), 'ok');
    await until(() => prompts(page) > before, 'the prompt after the flood', 120_000);
    // The server stopped reading: the keeper closed the claim that fell behind (S2 7.1 step 7).
    assert.ok(
      box.logLines().some((line) => line.endsWith(': send-queue-full')),
      'send-queue-full',
    );
    assert.ok(r.events.hello.length >= 2, 'the registry claimed it again');
    assert.ok(
      r.maxBacklog() <= high + 64 * 1024 + 8 * 1024,
      `at most one read above the mark: ${r.maxBacklog()} bytes waited`,
    );
    // Nothing doubled or lost: the flood's numbered lines on the screen side follow each other.
    const screen = await screenOf(r);
    const numbers = screenLines(screen).flatMap((line) => {
      const match = /^flood ([0-9]{8}) /.exec(line);
      return match === null ? [] : [Number(match[1])];
    });
    assert.ok(numbers.length > 1000, `${numbers.length} flood lines kept`);
    numbers.forEach((n, i) => {
      if (i > 0) assert.equal(n, (numbers[i - 1] ?? 0) + 1, `line after ${numbers[i - 1]}`);
    });
    await page.settled();
    assertSameScreen(screen, page.term);
  });
});

describe('registry: after the exit, and a keeper lost before its screen', () => {
  test('rediscover of a keeper whose program ended returns it ended, with its exit reported and its screen rebuilt', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c00000000009';
    const exit = { code: 0, signal: null, atNs: '5', notStarted: null };
    await scriptedKeeper(t, box, id, (conn) => {
      conn.send('H', helloOf(box, id, { seq: 1, exited: exit }));
      conn.send('D', 'bye\r\n');
      conn.send('X', JSON.stringify(exit));
      const check = setInterval(() => {
        if (conn.received.some((f) => f.type === 'A')) {
          clearInterval(check);
          conn.end(); // the keeper ends on A (S2 7.8)
        }
      }, 1);
      t.after(() => clearInterval(check));
    });
    // A slow screen side: the keeper's closing on A must not cut the rebuild short.
    const r = box.registry({ slowWriteMs: 50 });
    const found = await r.registry.rediscover();
    assert.deepEqual(
      found.map((x) => [x.id, x.state, x.exit?.code]),
      [[id, 'ended', 0]],
    );
    assert.equal(r.events.exited.length, 1, 'the exit was reported when rediscover resolved');
    assert.deepEqual(screenLines(await screenOf(r)), ['bye']);
  });

  test('a keeper lost between its hello and its snapshot: every attach gets an empty snapshot, then the loss', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c0000000000a';
    let fake: { stop(): Promise<void> } | null = null;
    fake = await scriptedKeeper(t, box, id, (conn) => {
      conn.send('H', helloOf(box, id, { seq: 7, snapSeq: 5, tailFrom: 6 }));
      setTimeout(() => void fake?.stop(), 200); // gone before its snapshot: the socket refuses
    });
    const r = box.registry();
    let early: Mirror | null = null;
    r.registry.onChange(() => {
      if (early === null && r.registry.list().some((x) => x.id === id)) {
        early = mirror(box.modules);
        assert.ok(r.registry.attach(id, early));
      }
    });
    await r.registry.rediscover();
    await until(() => info(r.registry, id).state === 'lost', 'lost', 10_000);
    const late = mirror(box.modules);
    assert.ok(r.registry.attach(id, late));
    const first = early as Mirror | null;
    assert.ok(first);
    await until(() => first.calls.length === 2 && late.calls.length === 2, 'both answered');
    assert.deepEqual(first.calls, ['S', 'x']);
    assert.deepEqual(late.calls, ['S', 'x']);
    assert.deepEqual([late.term.cols, late.term.rows], [80, 24], "the hello's size");
    assert.equal(late.exits[0]?.lost, true);
    assert.equal(r.events.exited.length, 1);
  });

  test('a keeper whose stream fails right after a settled claim is claimed at most once a second, and logged once', async (t) => {
    const box = await registrySandbox(t);
    const id = 'c0000000000b';
    const fake = await scriptedKeeper(t, box, id, (conn) => {
      conn.send('H', helloOf(box, id));
      setTimeout(() => conn.raw(Uint8Array.of(0x51, 0, 0, 0, 0)), 5); // settled, then garbage
    });
    const r = box.registry();
    await r.registry.rediscover();
    await sleep(2500);
    assert.ok(fake.conns.length <= 4, `${fake.conns.length} claims in 2.5 s`);
    assert.equal(r.log.filter((line) => line.endsWith('codec refuses (unknown-type)')).length, 1);
  });
});
