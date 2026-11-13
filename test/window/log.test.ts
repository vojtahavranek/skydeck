// server.log and keepers.log (S2 4.2, 5.2): one line per event with an ISO time, rotated to .1 at
// 1 MiB. server.log also holds lines it did not write (the launcher's, Node.js's own warnings).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { isoFromNs } from '../../src/platform/time.ts';
import { rotateLog, serverLog } from '../../src/window/log.ts';
import { T0, testPlatform } from '../helpers/platform.ts';
import type { TestPlatform } from '../helpers/platform.ts';

const MIB = 1024 * 1024;

/** A test platform and its <stateDir>/server.log, the state directory created. */
function logPlace(t: TestContext): { tp: TestPlatform; path: string } {
  const tp = testPlatform(t);
  mkdirSync(tp.places.stateDir, { recursive: true, mode: 0o700 });
  return { tp, path: join(tp.places.stateDir, 'server.log') };
}

/** `bytes` bytes of whole lines, as a log that has grown that big. */
function filler(bytes: number): string {
  const line = `${'x'.repeat(99)}\n`;
  const whole = line.repeat(Math.floor(bytes / line.length));
  return whole + 'y'.repeat(bytes - whole.length - 1) + '\n';
}

function stderrWrites(t: TestContext): () => string[] {
  const write = t.mock.method(process.stderr, 'write', () => true);
  return () => write.mock.calls.map((call) => String(call.arguments[0]));
}

// ---------------------------------------------------------------------------------------------
// serverLog

test('serverLog appends one line per call with the ISO time, to a file of mode 0o600', (t) => {
  const { tp, path } = logPlace(t);
  const log = serverLog(tp.platform, path, false);

  log('server started on port 47613');
  tp.clock.advanceMs(1500);
  log('page 0011223344556677: malformed message');

  assert.equal(
    readFileSync(path, 'utf8'),
    `${isoFromNs(T0)} server started on port 47613\n` +
      `${isoFromNs(T0 + 1_500_000_000n)} page 0011223344556677: malformed message\n`,
  );
  assert.equal(statSync(path).mode & 0o7777, 0o600);
});

test('serverLog writes a line holding line breaks, tabs or escape sequences as one line', (t) => {
  const { tp, path } = logPlace(t);
  const log = serverLog(tp.platform, path, false);

  log('TypeError\n    at f (/x.ts:1:2)\r\n    at g\t(/y.ts:3:4)\x1b[2J\x1b]0;title\x07');

  assert.equal(
    readFileSync(path, 'utf8'),
    `${isoFromNs(T0)} TypeError     at f (/x.ts:1:2)      at g (/y.ts:3:4)\n`,
  );
});

test('serverLog keeps the lines other writers put in server.log', (t) => {
  const { tp, path } = logPlace(t);
  const launcher =
    '2026-11-13T09:00:00Z launcher: /usr/bin/python3 cannot be run; core dumps of the server are not prevented\n';
  const node = '(node:4242) ExperimentalWarning: SQLite is an experimental feature\n';
  writeFileSync(path, launcher + node);

  serverLog(tp.platform, path, false)('server started');

  assert.equal(readFileSync(path, 'utf8'), `${launcher}${node}${isoFromNs(T0)} server started\n`);
});

test('serverLog renames the file to .1 at 1 MiB and starts a new one, replacing an older .1', (t) => {
  const { tp, path } = logPlace(t);
  const full = `2026-11-13T09:00:00Z launcher: a foreign line\n${filler(MIB - 46)}`;
  assert.equal(Buffer.byteLength(full), MIB);
  writeFileSync(path, full);
  writeFileSync(`${path}.1`, 'the oldest log\n');
  const log = serverLog(tp.platform, path, false);

  log('after the rotation');

  assert.equal(readFileSync(`${path}.1`, 'utf8'), full);
  assert.equal(readFileSync(path, 'utf8'), `${isoFromNs(T0)} after the rotation\n`);
  assert.equal(statSync(path).mode & 0o7777, 0o600);
});

test('serverLog does not rotate a file below 1 MiB', (t) => {
  const { tp, path } = logPlace(t);
  const almost = filler(MIB - 1);
  writeFileSync(path, almost);

  serverLog(tp.platform, path, false)('one more');

  assert.equal(readFileSync(path, 'utf8'), `${almost}${isoFromNs(T0)} one more\n`);
  assert.equal(existsSync(`${path}.1`), false);
});

test('serverLog in the foreground writes to stderr and leaves the file alone', (t) => {
  const { tp, path } = logPlace(t);
  const writes = stderrWrites(t);

  serverLog(tp.platform, path, true)('server started');

  assert.deepEqual(writes(), [`${isoFromNs(T0)} server started\n`]);
  assert.equal(existsSync(path), false);
});

test('serverLog never throws: a line it cannot write to the file goes to stderr', (t) => {
  const { tp, path } = logPlace(t);
  const log = serverLog(tp.platform, path, false);
  rmSync(tp.places.stateDir, { recursive: true });
  const writes = stderrWrites(t);

  log('the state directory is gone');

  assert.deepEqual(writes(), [`${isoFromNs(T0)} the state directory is gone\n`]);
  assert.equal(existsSync(path), false);
});

// ---------------------------------------------------------------------------------------------
// rotateLog (keepers.log, which keepers append to)

test('rotateLog renames a file of 1 MiB or more to .1, replacing an older .1', (t) => {
  const { tp } = logPlace(t);
  const path = join(tp.places.stateDir, 'keepers.log');
  const full = filler(MIB + 10);
  writeFileSync(path, full);
  writeFileSync(`${path}.1`, 'the oldest\n');

  rotateLog(tp.platform.files, path);

  assert.equal(readFileSync(`${path}.1`, 'utf8'), full);
  assert.equal(existsSync(path), false);
});

test('rotateLog leaves a file below 1 MiB, and a missing one, alone', (t) => {
  const { tp } = logPlace(t);
  const path = join(tp.places.stateDir, 'keepers.log');

  rotateLog(tp.platform.files, path);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.1`), false);

  const almost = filler(MIB - 1);
  writeFileSync(path, almost);
  rotateLog(tp.platform.files, path);
  assert.equal(readFileSync(path, 'utf8'), almost);
  assert.equal(existsSync(`${path}.1`), false);
});
