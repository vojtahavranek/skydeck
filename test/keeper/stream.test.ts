// The keeper's stream (S2 7.1 steps 3–5, 7.3, 8.1, 17.2): records numbered from 1 in order,
// resizes echoed as R records, parking and the trimmed tail, claims, and the connections it closes
// without ending. Real python3, the stand-in as the program, in a sandbox (realTestPlatform).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { encodeFrame, encodeResize, encodeSnapshot } from '../../src/window/frames.ts';
import {
  frameKey,
  isRecord,
  keeperSandbox,
  PROMPT,
  resize,
  sleep,
  snapshot,
  startProgram,
  typeLine,
  until,
} from '../helpers/keeper.ts';
import type { KeeperClient } from '../helpers/keeper.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';

/** The records a client received, in order. */
function records(client: KeeperClient): string[] {
  return client.frames.filter(isRecord).map(frameKey);
}

/** Waits until no frame has arrived for `quietMs`. */
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
    10_000,
  );
}

function inputHex(record: string): string {
  return readRecords(record)
    .flatMap((r) => (r.ev === 'input' ? [r.hex] : []))
    .join('');
}

describe('keeper: records', { concurrency: true }, () => {
  test('output, input and resizes are records numbered from 1, in order', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    await typeLine(client, 'hello');
    client.send('Z', encodeResize(100, 30));
    assert.deepEqual(resize(await client.next('R')), { cols: 100, rows: 30 });
    await client.waitForOutput(PROMPT, 5000, await client.waitForOutput('size 100x30'));
    await typeLine(client, 'world');
    await quiet(client);

    // Input reached the program as typed (the answers to its start queries are not input).
    assert.equal(inputHex(k.record), Buffer.from('hello\rworld\r').toString('hex'));

    // A new claim gets every record from number 1 (nothing was parked), the same as were sent live.
    const first = records(client);
    const { client: second, hello } = await k.claim();
    assert.equal(hello.seq, first.length);
    assert.equal(hello.snapSeq, 0);
    assert.equal(hello.gap, false);
    await until(() => records(second).length === first.length, 'the whole tail');
    assert.deepEqual(records(second), first);
    assert.equal(second.frames[0]?.type, 'H');
    assert.notEqual(second.frames[1]?.type, 'S', 'no snapshot was parked');
  });

  test('Z sets the pty size; the R record comes back in its place in the stream', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    client.send('Z', encodeResize(100, 30));
    const r = await client.next('R');
    assert.deepEqual(resize(r), { cols: 100, rows: 30 });
    await waitForRecord(k.record, (rec) => rec.ev === 'resize', 5000);
    const resized = readRecords(k.record).find((rec) => rec.ev === 'resize');
    assert.deepEqual(resized, { ...resized, cols: 100, rows: 30 });
    // The redraw comes after the R record.
    await client.waitForOutput('size 100x30');
    const at = client.frames.indexOf(r);
    const redraw = client.frames.findIndex(
      (f, i) => i > at && f.type === 'D' && Buffer.from(f.payload).includes('size 100x30'),
    );
    assert.ok(redraw > at);
    const { hello } = await k.claim();
    assert.deepEqual([hello.cols, hello.rows], [100, 30]);
  });

  test('P parks a snapshot: a new claim gets H, S and exactly the records after it', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    await quiet(client);
    const before = records(client);
    const n = before.length;
    client.send('P', encodeSnapshot(n, 80, 24, 'parked screen ✓'));
    await typeLine(client, '/red hi');
    await quiet(client);
    const all = records(client);
    assert.ok(all.length > n);

    const { client: second, hello } = await k.claim();
    assert.equal(hello.snapSeq, n);
    assert.equal(hello.seq, all.length);
    assert.equal(hello.gap, false);
    const s = snapshot(await second.next('S'));
    assert.deepEqual(s, { seq: n, cols: 80, rows: 24, data: 'parked screen ✓' });
    assert.equal(second.frames[1]?.type, 'S', 'the snapshot right after the hello');
    await until(() => records(second).length === all.length - n, 'the tail after the park');
    assert.deepEqual(records(second), all.slice(n));

    // Then live records.
    await typeLine(second, 'live');
    assert.match(second.output(), /live/);
  });

  test('a later park replaces the snapshot and trims the tail further', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    await quiet(client);
    const n1 = records(client).length;
    client.send('P', encodeSnapshot(n1, 80, 24, 'one'));
    await typeLine(client, 'more');
    await quiet(client);
    const n2 = records(client).length;
    client.send('P', encodeSnapshot(n2, 80, 24, 'two'));
    await typeLine(client, 'again');
    await quiet(client);
    const all = records(client);
    const { client: second, hello } = await k.claim();
    assert.equal(hello.snapSeq, n2);
    assert.equal(snapshot(await second.next('S')).data, 'two');
    await until(() => records(second).length === all.length - n2, 'the tail after the park');
    assert.deepEqual(records(second), all.slice(n2));
  });
});

describe('keeper: claims and connections', { concurrency: true }, () => {
  test('a second claim replaces the first connection, which is closed', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client: first } = await k.claim();
    const { client: second } = await k.claim();
    await first.closed;
    second.send('G');
    await second.next('T');
    assert.equal(first.frames.filter((f) => f.type === 'T').length, 0);
  });

  test('a first frame other than C closes that connection; the keeper serves the next', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const rude = await k.connect();
    rude.send('G');
    await rude.closed;
    assert.equal(rude.frames.length, 0);
    const { client, hello } = await k.claim();
    assert.equal(hello.started, false, 'the G of an unclaimed connection did nothing');
    client.send('G');
    await client.next('T');
  });

  const bad: [string, Uint8Array][] = [
    ['an unknown type (Q)', encodeRaw('Q', new Uint8Array(0))],
    ['a length above 16 MiB', lengthOnly('I', 16 * 1024 * 1024 + 1)],
    ['a frame the server never sends (D)', encodeFrame('D', new Uint8Array([0x61]))],
    ['a second claim on the same connection', encodeFrame('C')],
    ['a resize that is not "<cols> <rows>"', encodeRaw('Z', utf8('80x24'))],
    ['a resize of 0 columns', encodeRaw('Z', utf8('0 24'))],
    ['a resize above 65535', encodeRaw('Z', utf8('65536 24'))],
    ['a park shorter than its header', encodeRaw('P', new Uint8Array(11))],
    ['a park beyond the last record', encodeFrame('P', encodeSnapshot(99, 80, 24, 'x'))],
    ['a park of 0 rows', encodeRaw('P', parkBytes(0, 80, 0, utf8('x')))],
    ['a park that is not UTF-8', encodeRaw('P', parkBytes(0, 80, 24, new Uint8Array([0xff])))],
    ['a refusal that is not UTF-8', encodeRaw('N', new Uint8Array([0xc3, 0x28]))],
  ];
  for (const [what, bytes] of bad) {
    test(`${what} closes the connection; the keeper lives on`, async (t) => {
      const box = keeperSandbox(t);
      const k = await box.start();
      const { client } = await k.claim();
      client.sendRaw(bytes);
      await client.closed;
      const { client: next, hello } = await k.claim();
      assert.equal(hello.started, false);
      assert.equal(hello.exited, null, 'nothing was applied');
      next.send('G');
      await next.next('T');
      const lines = box.logLines();
      assert.ok(lines.length > 0, 'the keeper logged why it closed the connection');
      for (const line of lines) {
        assert.match(line, new RegExp(`^keeper ${k.spec.id}: [a-z][a-z-]*$`));
      }
    });
  }

  test('a frame split across writes is read whole', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await k.claim();
    const frame = encodeFrame('Z', encodeResize(120, 40));
    for (const byte of frame) {
      client.sendRaw(new Uint8Array([byte]));
      await sleep(5);
    }
    assert.deepEqual(resize(await client.next('R')), { cols: 120, rows: 40 });
  });

  test('only a peer with the keeper’s own user id is served', async (t) => {
    // Connecting as another user needs root (or another account's process); a test never uses sudo.
    if (process.getuid?.() !== 0) {
      t.skip('connecting as another user id needs root; this test runs as a normal user');
      return;
    }
    const box = keeperSandbox(t);
    const k = await box.start();
    const nobody = 65534;
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const s=require('node:net').createConnection(${JSON.stringify(k.spec.socket)});` +
          `s.on('connect',()=>s.write(Buffer.from([0x43,0,0,0,0])));` +
          `s.on('data',()=>{process.stdout.write('served');s.destroy()});` +
          `s.on('close',()=>process.exit(0));s.on('error',()=>process.exit(0));`,
      ],
      { uid: nobody, gid: nobody, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.stdout, '');
    const { hello } = await k.claim();
    assert.equal(hello.started, false);
  });
});

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A frame of any type byte, as the codec would never build it. */
function encodeRaw(type: string, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = type.charCodeAt(0);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

/** Only the header of a frame announcing `length` bytes. */
function lengthOnly(type: string, length: number): Uint8Array {
  const frame = new Uint8Array(5);
  frame[0] = type.charCodeAt(0);
  new DataView(frame.buffer).setUint32(1, length);
  return frame;
}

/** A park payload with any fields, as encodeSnapshot would refuse to build some. */
function parkBytes(seq: number, cols: number, rows: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(12 + data.length);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, BigInt(seq));
  view.setUint16(8, cols);
  view.setUint16(10, rows);
  payload.set(data, 12);
  return payload;
}
