// The keeper's end (S2 2, 7.1, 7.8, 8.1, 17.2): the exit status after the last output, A and the
// linger, a killed keeper ending its program, and errors logged by kind only. Real python3, the
// stand-in as the program, in a sandbox (realTestPlatform).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { encodeFrame, encodeSnapshot } from '../../src/window/frames.ts';
import {
  exit,
  keeperSandbox,
  sleep,
  spoolEvents,
  startProgram,
  started,
  stillRuns,
  until,
  within,
} from '../helpers/keeper.ts';
import type { Keeper } from '../helpers/keeper.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';

async function gone(k: Keeper): Promise<void> {
  const end = await within(k.exited, 'the keeper ended', 10_000);
  assert.deepEqual(end, { code: 0, signal: null });
  assert.equal(existsSync(k.spec.socket), false, 'its socket is removed');
  assert.equal(existsSync(k.pidFile), false, 'its pid line is removed');
}

describe('keeper: the exit status', { concurrency: true }, () => {
  for (const tail of [undefined, '4096']) {
    test(`what the pty still holds when the program is reaped comes before X${tail === undefined ? '' : ', whatever the tail cap'}`, async (t) => {
      const box = keeperSandbox(t);
      box.s.link('stty', 'head', 'tr');
      // 10,000 bytes fit in the pty's buffer (11,776 here), so the program can end while the
      // keeper is stopped; on its return the keeper reaps it with all of that still unread.
      const program = 'stty raw -echo; sleep 0.5; head -c 10000 /dev/zero | tr "\\0" a';
      const k = await box.start({
        spec: { argv: ['sh', '-c', program] },
        env: { SKYDECK_TEST_KEEPER_TAIL_BYTES: tail },
      });
      const { client } = await k.claim();
      client.send('G');
      await client.next('T');
      k.pause(true);
      try {
        await sleep(1500);
      } finally {
        k.pause(false);
      }
      const x = exit(await client.next('X'));
      assert.deepEqual([x.code, x.signal], [0, null]);
      const output = client.frames.filter((f) => f.type === 'D').map((f) => Buffer.from(f.payload));
      assert.equal(Buffer.concat(output).toString(), 'a'.repeat(10_000));
    });
  }

  test('/exit: X { code 0 } after the last output', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    client.send('I', '/exit\r');
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal, x.notStarted], [0, null, null]);
    assert.match(x.atNs, /^[1-9][0-9]*$/);
    // The stand-in turns bracketed paste off as it leaves: that output came before X.
    assert.match(client.output(), /\x1b\[\?2004l/);
    await sleep(300);
    assert.equal(client.frames.at(-1)?.type, 'X', 'nothing after X');
    const later = await k.claim();
    assert.equal(later.hello.started, true);
    assert.deepEqual(later.hello.exited, x);
    assert.deepEqual(exit(await later.client.next('X')), x, 'X again after the tail');
  });

  test('/fail 3: X { code 3 }', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    client.send('I', '/fail 3\r');
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal, x.notStarted], [3, null, null]);
  });

  test('a program killed by SIGKILL: X { signal 9 }, never a negative code', async (t) => {
    const box = keeperSandbox(t);
    // The program kills itself: a test signals only processes it started itself (A34).
    const k = await box.start({ spec: { argv: ['sh', '-c', 'printf "dying\\n"; kill -KILL $$'] } });
    const { client } = await k.claim();
    client.send('G');
    started(await client.next('T'));
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal, x.notStarted], [null, 9, null]);
    assert.match(client.output(), /dying/);
  });

  test('I after the exit is dropped; the connection stays', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    client.send('I', '/exit\r');
    await client.next('X');
    const count = client.frames.length;
    client.send('I', 'late\r');
    client.send('Z', '100 30');
    await sleep(500);
    assert.equal(client.frames.length, count, 'no record after X');
    assert.equal(client.isClosed(), false);
    assert.equal(
      readRecords(k.record).some((r) => r.ev === 'input' && r.hex.includes('6c617465')),
      false,
    );
    client.send('A');
    await gone(k);
  });
});

describe('keeper: ending', { concurrency: true }, () => {
  test('A ends the keeper; it removes its socket and pid line', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    client.send('I', '/exit\r');
    await client.next('X');
    client.send('A');
    await gone(k);
  });

  test('A before the end does nothing', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    client.send('A');
    await sleep(500);
    assert.equal(k.hasExited(), false);
    client.send('I', '/exit\r');
    await client.next('X');
    client.send('A');
    await gone(k);
  });

  test('a terminal that was not started ends after A the same way', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await k.claim();
    client.send('N', 'refused');
    await client.next('X');
    client.send('A');
    await gone(k);
  });

  test('without A it ends once no server has been connected for the linger', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ env: { SKYDECK_TEST_KEEPER_LINGER_SECONDS: '1' } });
    const { client } = await startProgram(k);
    client.send('I', '/exit\r');
    await client.next('X');
    // While a server is connected it stays, however long.
    await sleep(2000);
    assert.equal(k.hasExited(), false);
    client.socket.end();
    await gone(k);
  });

  test('never started and never connected to: it ends after the linger from the deadline', async (t) => {
    const box = keeperSandbox(t);
    const clock = box.tp.platform.clock;
    const startBy = clock.nowNs() + 1_000_000_000n;
    const k = await box.start({
      spec: { startBy: String(startBy) },
      env: { SKYDECK_TEST_KEEPER_LINGER_SECONDS: '2' },
    });
    // The deadline is wall-clock time, which steps on this machine: wait on that clock itself.
    await until(() => clock.nowNs() > startBy + 300_000_000n, 'the deadline passed', 10_000);
    assert.equal(k.hasExited(), false, 'the linger starts at the deadline');
    await gone(k);
  });

  test('a program that ends while no server is connected: it ends after the linger', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({
      spec: { argv: ['sh', '-c', 'sleep 0.5'] },
      env: { SKYDECK_TEST_KEEPER_LINGER_SECONDS: '1' },
    });
    const { client } = await k.claim();
    client.send('G');
    await client.next('T');
    client.socket.end();
    await gone(k);
  });

  test('a claim during the linger holds it; it ends after the linger once that one is gone', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ env: { SKYDECK_TEST_KEEPER_LINGER_SECONDS: '2' } });
    const { client } = await startProgram(k);
    client.send('I', '/exit\r');
    await client.next('X');
    client.socket.end();
    await sleep(1000);
    const { client: again } = await k.claim();
    await sleep(2500);
    assert.equal(k.hasExited(), false);
    again.socket.end();
    await gone(k);
  });

  test('killing the keeper ends its program: SIGHUP, and SessionEnd other in the spool', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { started: program } = await startProgram(k);
    k.kill();
    await waitForRecord(k.record, (r) => r.ev === 'hup', 5000);
    await waitForRecord(k.record, (r) => r.ev === 'exit', 10_000);
    await until(() => !stillRuns(program.pid, program.procStart), 'the program ended');
    assert.ok(
      spoolEvents(box.s).some((e) => e.event === 'SessionEnd' && e.reason === 'other'),
      'SessionEnd with reason other',
    );
  });
});

describe('keeper: what reaches its log', { concurrency: true }, () => {
  const MARKER = 'MARKER-6d1f2a90';
  const LINE = /^keeper (?:[0-9a-f]{12}|-): [A-Za-z][A-Za-z-]*$/;

  function checkLog(path: string): string[] {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    assert.equal(text.includes(MARKER), false, 'the data never reaches the log');
    const lines = text.split('\n').slice(0, -1);
    for (const line of lines) {
      assert.match(line, LINE);
    }
    return lines;
  }

  test('a spec with a wrong type: one line by kind, and the keeper ends', async (t) => {
    const box = keeperSandbox(t);
    const spec = { ...box.spec(), cols: MARKER, argv: [MARKER] };
    const k = await box.start({ rawSpec: JSON.stringify(spec), waitReady: false });
    const end = await within(k.exited, 'the keeper ended');
    assert.equal(end.code, 2, 'a refused spec exits 2');
    assert.deepEqual(checkLog(box.keepersLog), [`keeper ${spec.id}: bad-spec`]);
    assert.equal(existsSync(spec.socket), false);
  });

  test('a spec that is not JSON: one line by kind', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ rawSpec: `{"id": "${MARKER}`, waitReady: false });
    assert.equal((await within(k.exited, 'the keeper ended')).code, 2);
    assert.deepEqual(checkLog(box.keepersLog), ['keeper -: bad-spec']);
  });

  test('a spec with an id that is not a terminal id is logged without it', async (t) => {
    const box = keeperSandbox(t);
    const spec = { ...box.spec(), id: MARKER };
    const k = await box.start({ rawSpec: JSON.stringify(spec), waitReady: false });
    assert.equal((await within(k.exited, 'the keeper ended')).code, 2);
    assert.deepEqual(checkLog(box.keepersLog), ['keeper -: bad-spec']);
  });

  test('a park that cannot be decoded: one line by kind; the keeper lives on', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await startProgram(k);
    const park = encodeSnapshot(0, 80, 24, MARKER);
    const bad = new Uint8Array(park.length + 1);
    bad.set(park);
    bad[park.length] = 0xff; // not UTF-8
    client.sendRaw(encodeFrame('P', bad));
    await within(client.closed, 'the connection closed');
    assert.deepEqual(checkLog(box.keepersLog), [`keeper ${k.spec.id}: bad-park`]);
    const { client: again } = await k.claim();
    again.send('I', `${MARKER}\r`);
    await again.waitForOutput(MARKER);
    assert.equal(checkLog(box.keepersLog).length, 1, 'input is never logged');
  });

  const badMeta: [string, Record<string, unknown>][] = [
    ['a session id that is not one', { sessionId: MARKER }],
    ['a kind that is neither resume nor new', { kind: MARKER }],
    ['a slot above 9', { slot: 10 }],
    ['a slot that is not a whole number', { slot: '3' }],
    ['no slot', { slot: undefined }],
    ['no label', { label: undefined }],
    ['a label that is not text', { label: 7 }],
    ['an openedNs with a leading zero', { openedNs: '01' }],
    ['a build that is not text', { build: null }],
    ['no dir', { dir: undefined }],
  ];
  for (const [what, change] of badMeta) {
    test(`meta with ${what}: refused as a bad spec, so no hello the codec refuses`, async (t) => {
      const box = keeperSandbox(t);
      const spec = box.spec();
      const meta = { ...spec.meta, ...change };
      const k = await box.start({ rawSpec: JSON.stringify({ ...spec, meta }), waitReady: false });
      const end = await within(k.exited, 'the keeper ended');
      assert.equal(end.code, 2, 'a refused spec exits 2');
      assert.deepEqual(checkLog(box.keepersLog), [`keeper ${spec.id}: bad-spec`]);
      assert.equal(existsSync(spec.socket), false);
    });
  }

  for (const [what, name] of [
    ['a NUL', `x\u0000${MARKER}`],
    ['a lone surrogate', `x\ud800${MARKER}`],
  ] as const) {
    test(`a socket path with ${what}: refused as a bad spec`, async (t) => {
      const box = keeperSandbox(t);
      const spec = box.spec();
      const socket = join(box.termsDir, name);
      const k = await box.start({ rawSpec: JSON.stringify({ ...spec, socket }), waitReady: false });
      assert.equal((await within(k.exited, 'the keeper ended')).code, 2);
      assert.deepEqual(checkLog(box.keepersLog), [`keeper ${spec.id}: bad-spec`]);
      assert.deepEqual(readdirSync(box.termsDir), [], 'no socket under a shortened name');
    });
  }

  for (const [what, change] of [
    ['a startBy of 5,000 digits', { startBy: '9'.repeat(5000) }],
    ['a coreSoft of 5,000 digits', { coreSoft: '9'.repeat(5000) }],
    ['a coreSoft of 21 digits', { coreSoft: '1'.repeat(21) }],
  ] as const) {
    test(`${what}: refused as a bad spec, exit 2`, async (t) => {
      const box = keeperSandbox(t);
      const spec = { ...box.spec(), ...change };
      const k = await box.start({ rawSpec: JSON.stringify(spec), waitReady: false });
      assert.equal((await within(k.exited, 'the keeper ended')).code, 2);
      assert.deepEqual(checkLog(box.keepersLog), [`keeper ${spec.id}: bad-spec`]);
    });
  }

  test('meta is echoed by its checked fields only, so its hello is one the codec takes', async (t) => {
    const box = keeperSandbox(t);
    const spec = box.spec();
    // python's json reads NaN, which JSON.parse refuses: an unknown field must not come back.
    const raw = JSON.stringify(spec).replace('"meta":{', '"meta":{"extra":NaN,');
    assert.ok(raw.includes('NaN'));
    const k = await box.start({ spec, rawSpec: raw });
    const { hello } = await k.claim();
    assert.deepEqual(hello.meta, spec.meta);
  });

  test('an error no check foresaw, quoting the spec: only its class name', async (t) => {
    const box = keeperSandbox(t);
    // A json module that fails with the spec in its message, as a parser's error can.
    const json = [
      'def loads(data):',
      '    raise TypeError("cannot read %r" % (data,))',
      'def dumps(value, **options):',
      '    raise TypeError("cannot write %r" % (value,))',
      '',
    ].join('\n');
    const spec = box.spec({ argv: [MARKER] });
    const k = await box.start({ spec, faults: { json }, waitReady: false });
    const end = await within(k.exited, 'the keeper ended');
    assert.equal(end.code, 1, 'an uncaught exception ends python3 with 1');
    assert.deepEqual(checkLog(box.keepersLog), ['keeper -: TypeError']);
  });

  test('an error no check foresaw, quoting a frame: only its class name', async (t) => {
    const box = keeperSandbox(t);
    // The real struct module, but unpacking bytes that hold the marker fails with them in the message.
    const struct = [
      'from _struct import *',
      'from _struct import unpack as _unpack',
      'def unpack(fmt, data):',
      `    if b"${MARKER}"[:6] in bytes(data):`,
      '        raise TypeError("cannot unpack %r" % (bytes(data),))',
      '    return _unpack(fmt, data)',
      '',
    ].join('\n');
    const k = await box.start({ faults: { struct } });
    const { client } = await k.claim();
    client.send('P', new TextEncoder().encode(`${MARKER}${MARKER}`));
    const end = await within(k.exited, 'the keeper ended');
    assert.equal(end.code, 1, 'an uncaught exception ends python3 with 1');
    assert.deepEqual(checkLog(box.keepersLog), [`keeper ${k.spec.id}: TypeError`]);
  });
});
