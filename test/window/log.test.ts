// server.log and keepers.log (S2 4.2, 5.2): one line per event with an ISO time, rotated to .1 at
// 1 MiB. server.log also holds lines it did not write (the launcher's, Node.js's own warnings).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { isoFromNs } from '../../src/platform/time.ts';
import type { Platform } from '../../src/platform/types.ts';
import { rotateLog, serverLog } from '../../src/window/log.ts';
import { T0, testPlatform } from '../helpers/platform.ts';
import type { TestPlatform } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';

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

const LOG_MODULE = new URL('../../src/window/log.ts', import.meta.url).href;
const REAL_MODULE = new URL('../../src/platform/real.ts', import.meta.url).href;
/** What a server does with serverLog, in a child process of its own: one line, then it lives on. */
const LOG_CHILD = `
import { serverLog } from ${JSON.stringify(LOG_MODULE)};
import { realPlatform } from ${JSON.stringify(REAL_MODULE)};
const log = serverLog(realPlatform({ refuseWindows: true }), process.env.LOG_PATH, process.env.LOG_FOREGROUND === '1');
log('a line\\nof the server');
await new Promise((resolve) => setTimeout(resolve, 200));
process.stdout.write('alive\\n');
`;

/**
 * Runs LOG_CHILD in the sandbox with stderr a pipe, or `/dev/full` (every write fails with ENOSPC).
 * Its exit code, stdout and (with a pipe) stderr.
 */
async function logChild(
  t: TestContext,
  options: { path: string; foreground: boolean; stderr: 'pipe' | 'full' },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const s = sandbox(t);
  const full = options.stderr === 'full' ? openSync('/dev/full', 'w') : null;
  t.after(() => {
    if (full !== null) closeSync(full);
  });
  const child = spawn(process.execPath, ['--input-type=module', '--eval', LOG_CHILD], {
    cwd: s.home,
    env: s.env({ LOG_PATH: options.path, LOG_FOREGROUND: options.foreground ? '1' : '0' }),
    stdio: ['ignore', 'pipe', full ?? 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

/** A line serverLog writes with the real clock. */
const LOGGED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z a line of the server\n$/;

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

test('serverLog copies the file to .1 at 1 MiB and empties it, replacing an older .1', (t) => {
  const { tp, path } = logPlace(t);
  const full = `2026-11-13T09:00:00Z launcher: a foreign line\n${filler(MIB - 46)}`;
  assert.equal(Buffer.byteLength(full), MIB);
  writeFileSync(path, full, { mode: 0o600 });
  writeFileSync(`${path}.1`, 'the oldest log\n');
  const inode = statSync(path).ino;
  const log = serverLog(tp.platform, path, false);

  log('after the rotation');

  assert.equal(readFileSync(`${path}.1`, 'utf8'), full);
  assert.equal(readFileSync(path, 'utf8'), `${isoFromNs(T0)} after the rotation\n`);
  assert.equal(statSync(path).ino, inode); // the same file, emptied in place
  assert.equal(statSync(path).mode & 0o7777, 0o600);
  assert.deepEqual(readdirSync(tp.places.stateDir).sort(), ['server.log', 'server.log.1']);
});

test('a writer that holds server.log open still writes into server.log after rotations', (t) => {
  const { tp, path } = logPlace(t);
  writeFileSync(path, filler(MIB));
  const held = openSync(path, 'a'); // as the server's own stderr: appended to server.log (S2 5.2)
  t.after(() => closeSync(held));
  const log = serverLog(tp.platform, path, false);

  log('first rotation');
  writeSync(held, 'node: a warning after one rotation\n');
  writeFileSync(path, filler(MIB), { flag: 'a' });
  log('second rotation');
  writeSync(held, 'node: a fatal error after two\n');

  assert.equal(
    readFileSync(path, 'utf8'),
    `${isoFromNs(T0)} second rotation\nnode: a fatal error after two\n`,
  );
  assert.match(readFileSync(`${path}.1`, 'utf8'), /node: a warning after one rotation\n/);
});

test('serverLog does not rotate a file below 1 MiB', (t) => {
  const { tp, path } = logPlace(t);
  const almost = filler(MIB - 1);
  writeFileSync(path, almost);

  serverLog(tp.platform, path, false)('one more');

  assert.equal(readFileSync(path, 'utf8'), `${almost}${isoFromNs(T0)} one more\n`);
  assert.equal(existsSync(`${path}.1`), false);
});

test('serverLog in the foreground writes to stderr and leaves the file alone', async (t) => {
  const { path } = logPlace(t);

  const got = await logChild(t, { path, foreground: true, stderr: 'pipe' });

  assert.equal(got.stdout, 'alive\n');
  assert.match(got.stderr, LOGGED);
  assert.equal(existsSync(path), false);
});

test('serverLog never throws: a line it cannot write to the file goes to stderr', async (t) => {
  const { tp, path } = logPlace(t);
  rmSync(tp.places.stateDir, { recursive: true });

  const got = await logChild(t, { path, foreground: false, stderr: 'pipe' });

  assert.deepEqual({ code: got.code, stdout: got.stdout }, { code: 0, stdout: 'alive\n' });
  assert.match(got.stderr, LOGGED);
  assert.equal(existsSync(path), false);
});

test('serverLog never ends the server when stderr cannot be written either', async (t) => {
  if (!existsSync('/dev/full')) {
    t.skip('no /dev/full on this machine');
    return;
  }
  const { tp, path } = logPlace(t);
  rmSync(tp.places.stateDir, { recursive: true });

  const missingDir = await logChild(t, { path, foreground: false, stderr: 'full' });
  const fullDisk = await logChild(t, { path: '/dev/full', foreground: false, stderr: 'full' });
  const foreground = await logChild(t, { path, foreground: true, stderr: 'full' });

  assert.deepEqual(missingDir, { code: 0, stdout: 'alive\n', stderr: '' });
  assert.deepEqual(fullDisk, { code: 0, stdout: 'alive\n', stderr: '' });
  assert.deepEqual(foreground, { code: 0, stdout: 'alive\n', stderr: '' });
});

test('serverLog still appends the line when the rotation fails', (t) => {
  const { tp, path } = logPlace(t);
  const full = filler(MIB);
  writeFileSync(path, full);
  mkdirSync(`${path}.1`); // the rename cannot replace a directory

  serverLog(tp.platform, path, false)('after a failed rotation');

  assert.equal(readFileSync(path, 'utf8'), `${full}${isoFromNs(T0)} after a failed rotation\n`);
});

test('serverLog still writes the line when the clock gives a time it cannot show', (t) => {
  const { tp, path } = logPlace(t);
  const platform: Platform = {
    ...tp.platform,
    clock: { ...tp.platform.clock, nowNs: () => 10n ** 30n },
  };

  serverLog(platform, path, false)('a line');

  assert.equal(readFileSync(path, 'utf8'), '- a line\n');
});

// ---------------------------------------------------------------------------------------------
// rotateLog (keepers.log, which keepers append to)

test('rotateLog copies a file of 1 MiB or more to .1 and empties it in place, replacing an older .1', (t) => {
  const { tp } = logPlace(t);
  const path = join(tp.places.stateDir, 'keepers.log');
  const full = filler(MIB + 10);
  writeFileSync(path, full);
  chmodSync(path, 0o644); // a log another writer created wider: its copy is still 0o600
  writeFileSync(`${path}.1`, 'the oldest\n');
  const held = openSync(path, 'a'); // as a keeper's stderr (S2 7.1)
  t.after(() => closeSync(held));

  rotateLog(tp.platform.files, path);
  writeSync(held, 'keeper 0123456789ab: OSError\n');

  assert.equal(readFileSync(`${path}.1`, 'utf8'), full);
  assert.equal(statSync(`${path}.1`).mode & 0o7777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), 'keeper 0123456789ab: OSError\n');
  assert.deepEqual(readdirSync(tp.places.stateDir).sort(), ['keepers.log', 'keepers.log.1']);
});

test('rotateLog that cannot replace .1 leaves the file as it was and no temporary behind', (t) => {
  const { tp } = logPlace(t);
  const path = join(tp.places.stateDir, 'keepers.log');
  const full = filler(MIB);
  writeFileSync(path, full);
  mkdirSync(`${path}.1`);

  assert.throws(() => rotateLog(tp.platform.files, path));

  assert.equal(readFileSync(path, 'utf8'), full);
  assert.deepEqual(readdirSync(tp.places.stateDir).sort(), ['keepers.log', 'keepers.log.1']);
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
