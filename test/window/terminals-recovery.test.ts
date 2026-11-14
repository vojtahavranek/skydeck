// The registry across server restarts and failures (S2 7.3, 7.7, 7.8, 14; plan task 16):
// rebuilding every screen exactly from snapshot and tail, parking, reconnecting to a keeper that is
// slow, gap and newer keepers. Platform: realTestPlatform; real keepers running the stand-in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { describe, test } from 'node:test';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import { decodeSnapshot, encodeFrame, frameReader } from '../../src/window/frames.ts';
import type { Frame, KeeperSpec } from '../../src/window/frames.ts';
import type { Platform } from '../../src/platform/types.ts';
import { PROMPT, SESSION, sleep, until } from '../helpers/keeper.ts';
import {
  assertSameScreen,
  attachMirror,
  info,
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
    const keeperPid = Number(
      (box.tp.platform.files.readText(box.files.termPid(spec.id)) ?? '').split(' ')[0],
    );
    process.kill(keeperPid, 'SIGSTOP');
    try {
      r.sockets.at(-1)?.destroy();
      await until(() => info(r.registry, spec.id).state === 'reconnecting', 'reconnecting');
      await sleep(3000);
      assert.equal(info(r.registry, spec.id).state, 'reconnecting');
    } finally {
      process.kill(keeperPid, 'SIGCONT');
    }
    await until(() => info(r.registry, spec.id).state === 'running', 'running again', 10_000);
    assert.equal(r.states.get(spec.id)?.includes('lost'), false);
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
    r1.sockets.at(-1)?.destroy();
    await until(() => r1.events.hello.length === 2, 'the reconnect');
    assert.equal(r1.events.hello[1]?.hello.gap, true);
    assert.ok((r1.events.hello[1]?.hello.tailFrom ?? 0) > 1, 'the tail starts after the dropped');
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
