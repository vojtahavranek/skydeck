// The keeper (S2 7.1 steps 1–2, 8.1, 17.2): nothing starts the program but G before the start
// deadline; T before any output; the pid line; not dumpable; the program's directory, environment
// and core limit. Real python3, the stand-in as the program, in a sandbox (realTestPlatform).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  answerStart,
  CPR_ANSWER,
  DA1,
  DA1_ANSWER,
  exit,
  isRecord,
  keeperSandbox,
  procStartOf,
  sleep,
  started,
  startProgram,
  stillRuns,
  typeLine,
  until,
} from '../helpers/keeper.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import type { StandinRecord } from '../helpers/standin.ts';

type StartRecord = Extract<StandinRecord, { ev: 'start' }>;

/** The soft and hard "Max core file size" of /proc/<pid>/limits, as written there. */
function coreLimits(pid: number | 'self'): { soft: string; hard: string } {
  const line = readFileSync(`/proc/${pid}/limits`, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('Max core file size'));
  assert.ok(line);
  const [soft, hard] = line.slice('Max core file size'.length).trim().split(/\s+/);
  assert.ok(soft !== undefined && hard !== undefined);
  return { soft, hard };
}

describe('keeper: what starts the program', { concurrency: true }, () => {
  test('a connection alone, and a claim alone, start nothing', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    assert.deepEqual(k.pidLine()?.keeper, { version: '3', started: false });
    assert.equal(statSync(k.spec.socket).mode & 0o777, 0o600, 'the socket is the user’s only');
    assert.equal(statSync(k.pidFile).mode & 0o777, 0o600);

    const idle = await k.connect();
    await sleep(300);
    assert.equal(idle.frames.length, 0, 'a connection is passive until its claim');

    const { client, hello } = await k.claim();
    assert.equal(hello.started, false);
    assert.equal(hello.pid, null);
    assert.equal(hello.procStart, null);
    assert.equal(hello.exited, null);
    assert.equal(hello.protocol, 1);
    assert.equal(hello.keeper, '3');
    assert.equal(hello.id, k.spec.id);
    assert.equal(hello.startBy, k.spec.startBy);
    assert.equal(hello.lock, k.spec.lock);
    assert.deepEqual(hello.meta, k.spec.meta);
    assert.equal(hello.cols, 80);
    assert.equal(hello.rows, 24);
    assert.equal(hello.seq, 0);
    assert.equal(hello.snapSeq, 0);
    assert.equal(hello.gap, false);
    await sleep(500);
    assert.deepEqual(
      client.frames.map((f) => f.type),
      ['H'],
    );
    assert.equal(existsSync(k.record), false, 'the program never ran');
    assert.deepEqual(k.pidLine()?.keeper, { version: '3', started: false });
  });

  test('G before the deadline starts the program once: T first, then its output', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await k.claim();
    client.send('G');
    const t1 = started(await client.next('T'));
    const start = await waitForRecord(k.record, (r): r is StartRecord => r.ev === 'start', 5000);
    assert.equal(t1.pid, start.pid);
    assert.equal(t1.procStart, procStartOf(start.pid));
    assert.match(t1.atNs, /^[1-9][0-9]*$/);
    const at = client.frames.findIndex((f) => f.type === 'T');
    assert.equal(
      client.frames.slice(0, at).some((f) => f.type === 'D'),
      false,
      'no output before T',
    );
    await until(() => k.pidLine()?.keeper?.started === true, 'the pid line says started 1');
    assert.equal(k.pidLine()?.pid, k.pid);

    // A second G does nothing: no second T, no second program.
    client.send('G');
    await client.waitForOutput(DA1);
    client.send('I', DA1_ANSWER);
    client.send('I', CPR_ANSWER);
    await client.waitForOutput('standin ');
    await sleep(300);
    assert.equal(client.frames.filter((f) => f.type === 'T').length, 1);
    assert.equal(readRecords(k.record).filter((r) => r.ev === 'start').length, 1);

    // A later claim finds the same in its hello.
    const again = await k.claim();
    assert.equal(again.hello.started, true);
    assert.equal(again.hello.pid, t1.pid);
    assert.equal(again.hello.procStart, t1.procStart);
    assert.equal(again.hello.exited, null);
  });

  test('a deadline that passes with no G ends the terminal not started', async (t) => {
    const box = keeperSandbox(t);
    const now = box.tp.platform.clock.nowNs();
    const k = await box.start({ spec: { startBy: String(now + 1_500_000_000n) } });
    const { client, hello } = await k.claim();
    assert.equal(hello.started, false);
    const x = exit(await client.next('X', 6000));
    assert.equal(x.code, null);
    assert.equal(x.signal, null);
    assert.equal(typeof x.notStarted, 'string');
    assert.notEqual(x.notStarted, '');
    // G after that starts nothing; the next claim says so too.
    client.send('G');
    const later = await k.claim();
    assert.equal(later.hello.started, false);
    assert.deepEqual(later.hello.exited, x);
    assert.equal(exit(await later.client.next('X')).notStarted, x.notStarted);
    await sleep(300);
    assert.equal(existsSync(k.record), false, 'the program never ran');
    assert.equal(k.pidLine()?.keeper?.started, false);
  });

  test('G after the deadline starts nothing', async (t) => {
    const box = keeperSandbox(t);
    const now = box.tp.platform.clock.nowNs();
    const startBy = now + 1_000_000_000n;
    const k = await box.start({ spec: { startBy: String(startBy) } });
    const { client } = await k.claim();
    // Stopped across the deadline, so that the G is read after it, before any timer fires. The
    // deadline is wall-clock time, which steps on this machine: wait on that clock itself.
    k.pause(true);
    try {
      const clock = box.tp.platform.clock;
      await until(() => clock.nowNs() > startBy + 1_000_000_000n, 'the deadline long past', 10_000);
      client.send('G');
      await sleep(100);
    } finally {
      k.pause(false);
    }
    const x = exit(await client.next('X'));
    assert.notEqual(x.notStarted, null);
    await sleep(300);
    assert.equal(client.frames.filter((f) => f.type === 'T').length, 0);
    assert.equal(existsSync(k.record), false, 'the program never ran');
  });

  test('N ends the terminal not started, with its reason', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await k.claim();
    client.send('N', 'the session runs elsewhere');
    const x = exit(await client.next('X'));
    assert.deepEqual(
      { code: x.code, signal: x.signal, notStarted: x.notStarted },
      { code: null, signal: null, notStarted: 'the session runs elsewhere' },
    );
    client.send('G');
    await sleep(500);
    assert.equal(client.frames.filter((f) => f.type === 'T').length, 0);
    assert.equal(existsSync(k.record), false, 'the program never ran');
    const later = await k.claim();
    assert.equal(later.hello.started, false);
    assert.equal(later.hello.exited?.notStarted, 'the session runs elsewhere');
  });

  test('input before G is dropped, never given to the program later', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await k.claim();
    client.send('I', 'early\r');
    await sleep(200);
    client.send('G');
    await client.next('T');
    await answerStart(client);
    await typeLine(client, 'late');
    const typed = readRecords(k.record)
      .flatMap((r) => (r.ev === 'input' ? [r.hex] : []))
      .join('');
    assert.equal(typed, Buffer.from('late\r').toString('hex'));
  });

  test('N after the start does nothing: no X, the program and the keeper go on', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client, started: program } = await startProgram(k);
    client.send('N', 'too late');
    client.send('A');
    await sleep(500);
    assert.equal(client.frames.filter((f) => f.type === 'X').length, 0);
    assert.equal(k.hasExited(), false);
    assert.ok(stillRuns(program.pid, program.procStart), 'the program runs');
    const later = await k.claim();
    assert.equal(later.hello.started, true);
    assert.equal(later.hello.exited, null);
  });

  test('the program does not inherit python3’s ignored SIGPIPE and SIGXFSZ', async (t) => {
    const box = keeperSandbox(t);
    box.s.link('grep');
    const k = await box.start({ spec: { argv: ['sh', '-c', 'grep SigIgn /proc/$$/status'] } });
    const { client } = await k.claim();
    client.send('G');
    await client.next('X');
    const match = /SigIgn:\s*([0-9a-f]{16})/.exec(client.output());
    assert.ok(match?.[1], `no SigIgn line in ${JSON.stringify(client.output())}`);
    // Bits 13 (SIGPIPE) and 25 (SIGXFSZ); other ignored signals may come from the test runner.
    assert.equal(BigInt(`0x${match[1]}`) & 0x1001000n, 0n);
  });
});

describe('keeper: the process', { concurrency: true }, () => {
  test('the keeper is not dumpable; its program is', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    // Non-dumpable: the kernel gives its /proc files to root (there is no Dumpable line in
    // status on this kernel), so this process, the same user, cannot open its environ.
    assert.equal(statSync(`/proc/${k.pid}/status`).uid, 0);
    assert.throws(() => openSync(`/proc/${k.pid}/environ`, 'r'), { code: 'EACCES' });

    const { client } = await k.claim();
    client.send('G');
    const t1 = started(await client.next('T'));
    const start = await waitForRecord(k.record, (r): r is StartRecord => r.ev === 'start', 5000);
    assert.equal(start.pid, t1.pid);
    const uid = process.getuid?.();
    assert.equal(statSync(`/proc/${t1.pid}/status`).uid, uid);
    assert.ok(readFileSync(`/proc/${t1.pid}/environ`).length > 0);
  });

  test('the program gets the spec soft core limit, not the keeper’s', async (t) => {
    const box = keeperSandbox(t);
    if (coreLimits('self').hard === '0') {
      t.skip('the hard core limit is 0 here: no soft limit can be given to the program');
      return;
    }
    const k = await box.start();
    const { client } = await k.claim();
    client.send('G');
    await client.next('T');
    const start = await waitForRecord(k.record, (r): r is StartRecord => r.ev === 'start', 5000);
    assert.equal(start.coreSoft, k.spec.coreSoft);
    assert.notEqual(coreLimits(k.pid).soft, k.spec.coreSoft, 'the keeper has another limit');
  });

  test('the pid line goes through a temporary name that is never <id>.pid', async (t) => {
    // Task 15's listKeeperLines reads every file named <12 hex>.pid under terms/.
    const box = keeperSandbox(t);
    const seen = new Set<string>();
    const watcher = watch(box.termsDir, (_event, name) => {
      if (name !== null) {
        seen.add(String(name));
      }
    });
    try {
      const k = await box.start();
      const { client } = await k.claim();
      client.send('G'); // the line is written again, with started 1
      await client.next('T');
      await until(() => k.pidLine()?.keeper?.started === true, 'the line says started 1');
      await sleep(200);
      const own = [`${k.spec.id}.pid`, `${k.spec.id}.sock`];
      const temporaries = [...seen].filter((name) => !own.includes(name));
      assert.ok(temporaries.length > 0, `a temporary file was seen: ${[...seen].join(' ')}`);
      for (const name of temporaries) {
        assert.match(name, new RegExp(`^\\.${k.spec.id}\\.${k.pid}\\.tmp$`));
      }
    } finally {
      watcher.close();
    }
  });

  test('with coreSoft null the program keeps the keeper’s core limit', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ spec: { coreSoft: null } });
    const { client } = await k.claim();
    client.send('G');
    started(await client.next('T'));
    const start = await waitForRecord(k.record, (r): r is StartRecord => r.ev === 'start', 5000);
    assert.equal(start.coreSoft, coreLimits(k.pid).soft);
  });

  test('the program runs in the spec directory with exactly the spec environment', async (t) => {
    const box = keeperSandbox(t);
    const dir = join(box.s.home, 'project dir');
    mkdirSync(dir);
    const base = box.spec({ cwd: dir });
    const env = { ...base.env, KEEPER_TEST_VALUE: 'a b\tc', WSL_INTEROP: '/run/WSL/7_interop' };
    const k = await box.start({ spec: { ...base, env, argv: [...base.argv, '--model', 'opus'] } });
    const { client } = await k.claim();
    client.send('G');
    await client.next('T');
    const start = await waitForRecord(k.record, (r): r is StartRecord => r.ev === 'start', 5000);
    assert.equal(start.cwd, dir);
    assert.deepEqual(start.envNames, Object.keys(env).sort());
    assert.deepEqual(start.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PWD: dir,
      WSL_INTEROP: '/run/WSL/7_interop',
    });
    assert.deepEqual(start.argv.slice(-2), ['--model', 'opus']);
    assert.equal(start.cols, 80);
    assert.equal(start.rows, 24);
  });

  test('the program starts at the size the last Z gave before G', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ spec: { cols: 90, rows: 20 } });
    const { client, hello } = await k.claim();
    assert.deepEqual([hello.cols, hello.rows], [90, 20]);
    client.send('Z', '132 43');
    await client.next('R');
    client.send('G');
    await client.next('T');
    const start = await waitForRecord(k.record, (r): r is StartRecord => r.ev === 'start', 5000);
    assert.deepEqual([start.cols, start.rows], [132, 43]);
  });

  test('exec of a missing program: T, a line naming the reason, then X 127', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ spec: { argv: ['skydeck-no-such-program', '--resume', 'x'] } });
    const { client } = await k.claim();
    client.send('G');
    started(await client.next('T'));
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal, x.notStarted], [127, null, null]);
    assert.match(client.output(), /skydeck-no-such-program/);
    assert.match(client.output(), /No such file or directory/);
    const last = client.frames.at(-1);
    assert.equal(last?.type, 'X');
    assert.ok(client.frames.slice(0, -1).some(isRecord));
  });

  test('a directory it cannot change to: a line naming the reason, then X 127', async (t) => {
    const box = keeperSandbox(t);
    const missing = join(box.s.root, 'no-such-dir');
    const k = await box.start({ spec: { cwd: missing } });
    const { client } = await k.claim();
    client.send('G');
    started(await client.next('T'));
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal], [127, null]);
    assert.match(client.output(), /no-such-dir/);
    assert.match(client.output(), /No such file or directory/);
    assert.equal(existsSync(k.record), false, 'the program never ran');
  });
});
