// The keeper's hang-up (follow-up F30; S2 7.1, 8.1): `E` sends SIGHUP to the program the keeper
// started, as a terminal's closed window would, and changes nothing else — the keeper reads the
// output, reaps the program and reports its exit as for any end. Real python3, the stand-in or a
// shell line as the program, in a sandbox (realTestPlatform). No test signals a process itself:
// every SIGHUP here is the keeper's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { encodeFrame } from '../../src/window/frames.ts';
import {
  exit,
  keeperSandbox,
  resize,
  sleep,
  spoolEvents,
  startProgram,
  started,
  stillRuns,
  until,
  within,
} from '../helpers/keeper.ts';
import type { Keeper, KeeperClient } from '../helpers/keeper.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';

/** A shell line's program, started, its T read: the program's pid and start. */
async function startShell(
  k: Keeper,
): Promise<{ client: KeeperClient; pid: number; procStart: number }> {
  const { client } = await k.claim();
  client.send('G');
  const { pid, procStart } = started(await client.next('T'));
  return { client, pid, procStart };
}

/** `text` as one word of sh. */
function word(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * A wait of a shell line that can never outlive its test: at most 30 s, and not past the
 * sandbox's root (a failed case leaves no process; the suite's other shell programs do the same).
 */
function bounded(root: string, more = 'true'): string {
  return `i=0; while ${more} && [ -d ${word(root)} ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i+1)); done`;
}

/** The state letter of /proc/<pid>/stat (`T` when stopped), '' when it cannot be read. */
function procState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  } catch {
    return '';
  }
}

async function gone(k: Keeper): Promise<void> {
  const end = await within(k.exited, 'the keeper ended', 10_000);
  assert.deepEqual(end, { code: 0, signal: null });
  assert.equal(existsSync(k.spec.socket), false, 'its socket is removed');
  assert.equal(existsSync(k.pidFile), false, 'its pid line is removed');
}

describe('keeper: the hang-up (E)', { concurrency: true }, () => {
  test('E ends the stand-in as a closed terminal does: its hang-up, its SessionEnd, X after the last output', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client, started: program } = await startProgram(k);
    client.send('E');
    const x = exit(await client.next('X', 10_000));
    // The stand-in ends on SIGHUP with 129 (128 + 1), after its SessionEnd `other`.
    assert.deepEqual([x.code, x.signal, x.notStarted], [129, null, null]);
    const records = readRecords(k.record).map((record) => record.ev);
    assert.deepEqual(records.slice(-2), ['hup', 'exit']);
    assert.equal(records.filter((ev) => ev === 'hup').length, 1, 'one SIGHUP');
    assert.deepEqual(spoolEvents(box.s).at(-1), { event: 'SessionEnd', reason: 'other' });
    assert.equal(stillRuns(program.pid, program.procStart), false);
    assert.equal(client.isClosed(), false, 'the connection stays');
    assert.deepEqual(box.logLines(), [], 'nothing logged');
    client.send('A');
    await gone(k);
  });

  test('a program that ignores the hang-up is not ended: the keeper stays healthy and serves it', async (t) => {
    const box = keeperSandbox(t);
    const program = 'trap "" HUP; printf "ready\\n"; read line; printf "got %s\\n" "$line"';
    const k = await box.start({ spec: { argv: ['sh', '-c', program] } });
    const { client, pid, procStart } = await startShell(k);
    await client.waitForOutput('ready');
    client.send('E');
    await sleep(1000);
    assert.equal(stillRuns(pid, procStart), true, 'the program runs on');
    assert.equal(
      client.frames.some((frame) => frame.type === 'X'),
      false,
      'no exit',
    );
    // The keeper still serves it: a resize comes back, input reaches it, its output is read.
    client.send('Z', '100 30');
    assert.deepEqual(resize(await client.next('R')), { cols: 100, rows: 30 });
    client.send('I', 'bye\r');
    await client.waitForOutput('got bye');
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal], [0, null]);
    assert.deepEqual(box.logLines(), []);
  });

  test('E twice: one hang-up for each while the program runs, one exit', async (t) => {
    const box = keeperSandbox(t);
    // It counts the hang-ups it gets and ends at the second, with 7.
    const program = `n=0; trap 'n=$((n+1)); echo "hup $n"; [ "$n" -ge 2 ] && exit 7' HUP; echo ready; ${bounded(box.s.root)}; exit 9`;
    const k = await box.start({ spec: { argv: ['sh', '-c', program] } });
    const { client } = await startShell(k);
    await client.waitForOutput('ready');
    client.send('E');
    await client.waitForOutput('hup 1');
    client.send('E');
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal], [7, null]);
    assert.match(client.output(), /hup 2/);
    await sleep(300);
    assert.equal(client.frames.filter((frame) => frame.type === 'X').length, 1, 'one exit');
    client.send('A');
    await gone(k);
  });

  test('E after the program ended: nothing happens; the connection stays and A ends the keeper', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ spec: { argv: ['sh', '-c', 'exit 3'] } });
    const { client } = await startShell(k);
    const x = exit(await client.next('X'));
    assert.equal(x.code, 3);
    const count = client.frames.length;
    client.send('E');
    client.send('E', 'ignored payload');
    await sleep(500);
    assert.equal(client.frames.length, count, 'nothing after X');
    assert.equal(client.isClosed(), false);
    assert.deepEqual(box.logLines(), []);
    // A later claim finds the same exit.
    const later = await k.claim();
    assert.deepEqual(later.hello.exited, x);
    later.client.send('A');
    await gone(k);
  });

  test('E before the start does nothing: the program starts and runs after it', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client } = await k.claim();
    client.send('E');
    await sleep(300);
    assert.equal(client.isClosed(), false);
    client.send('G');
    started(await client.next('T'));
    await waitForRecord(k.record, (record) => record.ev === 'start', 10_000);
    await sleep(500);
    assert.equal(
      readRecords(k.record).some((record) => record.ev === 'hup'),
      false,
      'no hang-up reached the program',
    );
    assert.equal(
      client.frames.some((frame) => frame.type === 'X'),
      false,
    );
  });

  test('E from a connection that has not claimed closes it, as any frame but C', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start();
    const { client: screen } = await startProgram(k);
    const rude = await k.connect();
    rude.socket.write(encodeFrame('E'));
    await within(rude.closed, 'the connection closed');
    await sleep(300);
    assert.equal(screen.isClosed(), false, 'the screen side stays');
    assert.equal(
      readRecords(k.record).some((record) => record.ev === 'hup'),
      false,
      'no hang-up reached the program',
    );
    await until(() => box.logLines().length > 0, 'a log line');
    assert.deepEqual(box.logLines(), [`keeper ${k.spec.id}: not-claimed`]);
  });

  test('E signals the program, not its group: a child in its group that traps the hang-up gets none while the program ignores it', async (t) => {
    const box = keeperSandbox(t);
    const stop = join(box.s.home, 'stop-the-child');
    // The child is in the program's process group (no job control); the program ignores SIGHUP
    // after it started the child, so only a signal sent to the group would reach the child.
    const program = `(trap 'echo child-hup' HUP; echo child-ready; ${bounded(box.s.root, `[ ! -e ${word(stop)} ]`)}) & trap '' HUP; echo ready; wait`;
    const k = await box.start({ spec: { argv: ['sh', '-c', program] } });
    const { client, pid, procStart } = await startShell(k);
    await client.waitForOutput('child-ready');
    await client.waitForOutput('ready\r\n');
    client.send('E');
    await sleep(1000);
    assert.doesNotMatch(client.output(), /child-hup/, 'the group got no SIGHUP');
    assert.equal(stillRuns(pid, procStart), true);
    writeFileSync(stop, '');
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal], [0, null]);
    assert.doesNotMatch(client.output(), /child-hup/);
  });

  test('E continues a stopped program, as a closed terminal does: SIGHUP, then SIGCONT', async (t) => {
    const box = keeperSandbox(t);
    // It stops itself; continued, its pending hang-up's trap ends it with 5 (6: continued without).
    const program = `trap 'echo hup; exit 5' HUP; echo ready; kill -STOP $$; echo continued-without-hup; exit 6`;
    const k = await box.start({ spec: { argv: ['sh', '-c', program] } });
    const { client, pid } = await startShell(k);
    await client.waitForOutput('ready');
    await until(() => procState(pid) === 'T', 'the program stopped');
    client.send('E');
    const x = exit(await client.next('X'));
    assert.deepEqual([x.code, x.signal], [5, null]);
    assert.match(client.output(), /hup/);
    assert.doesNotMatch(client.output(), /continued-without-hup/);
  });

  test('a hello after E names the program as before (a server that claims it again)', async (t) => {
    const box = keeperSandbox(t);
    const program = 'trap "" HUP; echo ready; read line';
    const k = await box.start({ spec: { argv: ['sh', '-c', program] } });
    const { client, pid, procStart } = await startShell(k);
    await client.waitForOutput('ready');
    client.send('E');
    await sleep(300);
    const again = await k.claim();
    const hello = again.hello;
    assert.equal(hello.started, true);
    assert.deepEqual([hello.pid, hello.procStart, hello.exited], [pid, procStart, null]);
    assert.equal(hello.keeper, '3');
    again.client.send('I', 'x\r');
    const x = exit(await again.client.next('X'));
    assert.equal(x.code, 0);
  });
});
