// The keeper's limits (S2 7.1 steps 5–7, 17.2): a large paste into a program that does not read,
// the 4 MiB input queue, the tail cap and gap, the send-queue cap. The tail and send caps are made
// small through SKYDECK_TEST_KEEPER_TAIL_BYTES / SKYDECK_TEST_KEEPER_SEND_BYTES (plan task 9).
// Real python3, the stand-in as the program, in a sandbox (realTestPlatform).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { encodeSnapshot } from '../../src/window/frames.ts';
import {
  isRecord,
  keeperSandbox,
  PROMPT,
  frameKey,
  sleep,
  snapshot,
  startProgram,
  typeLine,
  until,
  within,
} from '../helpers/keeper.ts';
import type { KeeperClient } from '../helpers/keeper.ts';
import { readRecords } from '../helpers/standin.ts';

const MiB = 1024 * 1024;

/** `size` printable bytes, numbered so that a reordering or a loss shows: "00000000.00000001.…" */
function pasteText(size: number): Buffer {
  const parts: string[] = [];
  let length = 0;
  for (let n = 0; length < size; n++) {
    const part = `${String(n).padStart(8, '0')}.`;
    parts.push(part);
    length += part.length;
  }
  return Buffer.from(parts.join('').slice(0, size), 'latin1');
}

/** Writes `data` as I frames of 64 KiB (what the server sends: a page's input is ≤ 64 KiB). */
function paste(client: KeeperClient, data: Buffer): void {
  for (let at = 0; at < data.length; at += 64 * 1024) {
    client.send('I', data.subarray(at, at + 64 * 1024));
  }
}

function inputBytes(record: string): number {
  return readRecords(record).reduce((sum, r) => sum + (r.ev === 'input' ? r.hex.length / 2 : 0), 0);
}

function records(client: KeeperClient): string[] {
  return client.frames.filter(isRecord).map(frameKey);
}

async function quiet(client: KeeperClient, quietMs = 300): Promise<void> {
  let count = -1;
  let since = performance.now();
  await until(
    () => {
      if (client.frames.length !== count) {
        count = client.frames.length;
        since = performance.now();
      }
      return performance.now() - since >= quietMs;
    },
    'the stream went quiet',
    15_000,
  );
}

describe('keeper: input', { concurrency: true }, () => {
  test('an 8 MiB paste into a stalled program: output flows meanwhile, every byte arrives in order', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    const data = pasteText(8 * MiB); // built before the stall, which it would otherwise shorten
    client.send('I', '/stall 3\r');
    await client.waitForOutput('stalling 3 s');
    const head = data.subarray(0, 64).toString('latin1');
    paste(client, data);

    // The program reads again after its stall and echoes what it reads: that output reaches this
    // client while most of the paste still waits to be written.
    await client.waitForOutput(head, 15_000);
    assert.ok(
      client.socket.writableLength > 0,
      'output came while the paste was still being written',
    );
    await until(() => client.socket.writableLength === 0, 'the whole paste written', 60_000);
    await until(
      () => client.output().includes(data.toString('latin1')),
      'the whole paste echoed',
      60_000,
    );
    const hex = readRecords(k.record)
      .flatMap((r) => (r.ev === 'input' ? [r.hex] : []))
      .join('');
    const typed = Buffer.from('/stall 3\r').toString('hex');
    assert.equal(hex.length, typed.length + data.length * 2, 'every byte reached the program');
    assert.ok(hex === typed + data.toString('hex'), 'in order');
  });

  test('the input queue over its cap: the keeper stops reading the connection until the program reads', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    const data = pasteText(8 * MiB); // built before the stall, which it would otherwise shorten
    client.send('I', '/stall 6\r');
    await client.waitForOutput('stalling 6 s');
    paste(client, data);
    await sleep(1500);
    // At most the 4 MiB queue, the pty's buffer and the socket's buffers left this process.
    const waiting = client.socket.writableLength;
    assert.ok(waiting > 2 * MiB, `the writes wait (${waiting} bytes still here)`);
    await sleep(1000);
    assert.equal(client.socket.writableLength, waiting, 'nothing more is read while it stalls');
    const typed = '/stall 6\r'.length;
    assert.equal(inputBytes(k.record), typed, 'the program read nothing of the paste yet');
    // The program reads again: so does the keeper.
    await until(() => client.socket.writableLength === 0, 'the rest of the paste written', 60_000);
    await until(() => inputBytes(k.record) === typed + data.length, 'every byte read', 60_000);
  });
});

describe('keeper: caps', { concurrency: true }, () => {
  test('the tail cap counts each record, so many small records cannot outgrow it', async (t) => {
    const box = keeperSandbox(t);
    const cap = 64 * 1024;
    const k = await box.start({ env: { SKYDECK_TEST_KEEPER_TAIL_BYTES: String(cap) } });
    const { client } = await k.claim();
    for (let i = 0; i < 3000; i++) {
      client.send('Z', `${100 + (i % 2)} 30`); // an R record of 23 bytes each
    }
    await until(() => client.frames.filter((f) => f.type === 'R').length === 3000, 'every R');
    const { client: second, hello } = await k.claim();
    assert.equal(hello.gap, true);
    await quiet(second);
    const kept = second.frames.filter((f) => f.type === 'R').length;
    assert.ok(kept > 0 && kept <= cap / 64, `${kept} records kept for a cap of ${cap} bytes`);
  });

  test('the tail cap drops the oldest records and sets gap until a park covers them', async (t) => {
    const box = keeperSandbox(t);
    const cap = 64 * 1024;
    const k = await box.start({ env: { SKYDECK_TEST_KEEPER_TAIL_BYTES: String(cap) } });
    const { client } = await startProgram(k);
    await typeLine(client, '/flood 300000', 15_000);
    await quiet(client);
    const all = records(client);

    const { client: second, hello } = await k.claim();
    assert.equal(hello.gap, true);
    assert.equal(hello.seq, all.length);
    assert.equal(hello.snapSeq, 0);
    await quiet(second);
    const tail = second.frames.filter(isRecord);
    assert.ok(tail.length > 0 && tail.length < all.length, 'the oldest records were dropped');
    assert.deepEqual(tail.map(frameKey), all.slice(all.length - tail.length), 'the newest stay');
    const size = tail.reduce((sum, f) => sum + f.payload.length, 0);
    assert.ok(size <= cap, `the tail holds ${size} bytes, at most ${cap}`);

    // A park that covers the lost records: the snapshot leads to the screen again.
    second.send('P', encodeSnapshot(all.length, 80, 24, 'screen'));
    const third = await k.claim();
    assert.equal(third.hello.gap, false);
    assert.equal(third.hello.snapSeq, all.length);
  });

  test('a claim’s snapshot and tail are not held to the send cap; its live records are', async (t) => {
    const box = keeperSandbox(t);
    box.s.link('stty', 'head', 'tr');
    // 3 MB of output while no server is connected, then whatever comes in is echoed (a live record).
    const program = 'stty raw -echo; head -c 3000000 /dev/zero | tr "\\0" a; exec cat';
    const k = await box.start({
      spec: { argv: ['sh', '-c', program] },
      env: { SKYDECK_TEST_KEEPER_SEND_BYTES: String(64 * 1024) },
    });
    const { client } = await k.claim();
    client.send('G');
    await client.next('T');
    client.socket.destroy();
    // Until the output is all in the tail: the record count stops growing.
    let seq = -1;
    for (let tries = 0; ; tries++) {
      assert.ok(tries < 40, 'the program kept writing');
      await sleep(500);
      const probe = await k.claim();
      probe.client.socket.destroy();
      if (probe.hello.seq === seq) {
        break;
      }
      seq = probe.hello.seq;
    }

    // A server slow to read the claim's 3 MB tail is not closed for it when a live record comes.
    const { client: second } = await k.claim();
    second.socket.pause();
    second.send('I', 'x');
    await sleep(500);
    second.socket.resume();
    const bytes = (): number =>
      second.frames.filter((f) => f.type === 'D').reduce((n, f) => n + f.payload.length, 0);
    await until(
      () => bytes() === 3_000_001,
      () => `the tail and the echo (${bytes()} bytes)`,
      15_000,
    );
    assert.equal(second.output().endsWith('ax'), true);
    assert.equal(second.isClosed(), false);
    assert.equal(box.logLines().length, 0, 'nothing closed for the send cap');
  });

  test('the send-queue cap closes a connection that does not read; the pty is still read', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ env: { SKYDECK_TEST_KEEPER_SEND_BYTES: String(256 * 1024) } });
    const { client } = await startProgram(k);
    await quiet(client);
    const parked = records(client).length;
    client.send('P', encodeSnapshot(parked, 80, 24, 'before the flood'));
    client.socket.pause();
    client.send('I', '/flood 4000000\r');
    await until(
      () => box.logLines().includes(`keeper ${k.spec.id}: send-queue-full`),
      'the keeper closed the connection that does not read',
      15_000,
    );

    // The program was never held up: a new claim gets the snapshot, the tail and the prompt the
    // program drew after its flood (50,000 lines of 80 bytes).
    const { client: second, hello } = await k.claim();
    assert.equal(hello.snapSeq, parked);
    assert.equal(hello.gap, false);
    assert.equal(snapshot(await second.next('S')).data, 'before the flood');
    const end = await second.waitForOutput('flood 00050000', 15_000);
    await second.waitForOutput(PROMPT, 15_000, end);
    assert.match(second.output(), /^\/flood 4000000/, 'the tail starts right after the park');

    // What the first connection got stops short of that.
    client.socket.resume();
    await within(client.closed, 'the connection closed');
    assert.equal(client.output().includes('flood 00050000'), false);
  });
});
