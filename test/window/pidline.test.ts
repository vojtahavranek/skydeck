import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatPidLine, isPidLineAlive, parsePidLine } from '../../src/window/pidline.ts';
import type { PidLine } from '../../src/window/pidline.ts';
import { BOOT_A, BOOT_B, fakeProc, statLine } from '../helpers/platform.ts';

const SERVER: PidLine = { pid: 4242, procStart: 51234567, bootId: BOOT_A };
const KEEPER: PidLine = {
  pid: 4242,
  procStart: 51234567,
  bootId: BOOT_A,
  keeper: { version: '1', started: false },
};

// ---------------------------------------------------------------------------------------------
// The exact form (contract 2.8): tasks 7 (sh) and 9 (python) write and read the same bytes.

test('formatPidLine writes a server or keep-alive line exactly', () => {
  assert.equal(formatPidLine(SERVER), `4242 51234567 ${BOOT_A}\n`);
});

test('formatPidLine writes a keeper line exactly', () => {
  assert.equal(formatPidLine(KEEPER), `4242 51234567 ${BOOT_A} 1 0\n`);
  assert.equal(
    formatPidLine({ ...KEEPER, keeper: { version: '1', started: true } }),
    `4242 51234567 ${BOOT_A} 1 1\n`,
  );
});

test('parsePidLine reads the contract example lines', () => {
  assert.deepEqual(parsePidLine('4242 51234567 6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f\n'), {
    pid: 4242,
    procStart: 51234567,
    bootId: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  });
  assert.deepEqual(parsePidLine('4242 51234567 6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f 1 0\n'), {
    pid: 4242,
    procStart: 51234567,
    bootId: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    keeper: { version: '1', started: false },
  });
});

test('a pid line without the keeper fields round-trips', () => {
  assert.deepEqual(parsePidLine(formatPidLine(SERVER)), SERVER);
});

test('a pid line with the keeper fields round-trips', () => {
  assert.deepEqual(parsePidLine(formatPidLine(KEEPER)), KEEPER);
  const started: PidLine = { ...KEEPER, keeper: { version: '2.1-rc', started: true } };
  assert.deepEqual(parsePidLine(formatPidLine(started)), started);
});

test('a pid line with process start 0 and the largest safe numbers round-trips', () => {
  for (const line of [
    { pid: 1, procStart: 0, bootId: BOOT_B },
    { pid: Number.MAX_SAFE_INTEGER, procStart: Number.MAX_SAFE_INTEGER, bootId: BOOT_B },
  ]) {
    assert.deepEqual(parsePidLine(formatPidLine(line)), line);
  }
});

test('parsePidLine accepts a line whose final newline is missing', () => {
  assert.deepEqual(parsePidLine(`4242 51234567 ${BOOT_A}`), SERVER);
  assert.deepEqual(parsePidLine(`4242 51234567 ${BOOT_A} 1 0`), KEEPER);
});

test('parsePidLine gives null for garbled lines', () => {
  const garbled = [
    '',
    '\n',
    'garbage\n',
    `4242 51234567\n`, // two fields
    `4242 51234567 ${BOOT_A} 1\n`, // four fields
    `4242 51234567 ${BOOT_A} 1 0 x\n`, // six fields
    `4242  51234567 ${BOOT_A}\n`, // two spaces
    ` 4242 51234567 ${BOOT_A}\n`, // leading space
    `4242 51234567 ${BOOT_A} \n`, // trailing space
    `4242\t51234567\t${BOOT_A}\n`, // tabs
    `4242 51234567 ${BOOT_A}\r\n`, // CRLF
    `4242 51234567 ${BOOT_A}\n\n`, // two newlines
    `4242 51234567 ${BOOT_A}\n4243 1 ${BOOT_A}\n`, // two lines
    `0 51234567 ${BOOT_A}\n`, // pid 0
    `-1 51234567 ${BOOT_A}\n`,
    `04242 51234567 ${BOOT_A}\n`, // leading zero
    `42x 51234567 ${BOOT_A}\n`,
    `4242.0 51234567 ${BOOT_A}\n`,
    `9007199254740992 51234567 ${BOOT_A}\n`, // not a safe integer
    `4242 x ${BOOT_A}\n`,
    `4242 -5 ${BOOT_A}\n`,
    `4242 0123 ${BOOT_A}\n`,
    `4242 9007199254740992 ${BOOT_A}\n`,
    `4242 51234567 ${BOOT_A.toUpperCase()}\n`, // boot ids are lowercase
    '4242 51234567 not-a-boot-id\n',
    `4242 51234567 ${BOOT_A.slice(1)}\n`,
    `4242 51234567 ${BOOT_A} 1 2\n`, // started is 0 or 1
    `4242 51234567 ${BOOT_A} 1 true\n`,
    `4242 51234567 ${BOOT_A} é 0\n`, // a version is printable ASCII without spaces
    `4242 51234567 ${BOOT_A} \u0007 0\n`,
  ];
  for (const text of garbled) {
    assert.equal(parsePidLine(text), null, JSON.stringify(text));
  }
});

test('formatPidLine refuses a line that would not read back', () => {
  const bad: PidLine[] = [
    { ...SERVER, pid: 0 },
    { ...SERVER, pid: 1.5 },
    { ...SERVER, procStart: -1 },
    { ...SERVER, procStart: Number.MAX_SAFE_INTEGER + 1 },
    { ...SERVER, bootId: 'x' },
    { ...SERVER, bootId: `${BOOT_A}\n` },
    { ...KEEPER, keeper: { version: '1 0', started: false } },
    { ...KEEPER, keeper: { version: '', started: false } },
    { ...KEEPER, keeper: { version: '1\n', started: false } },
  ];
  for (const line of bad) {
    assert.throws(() => formatPidLine(line), /pid line/, JSON.stringify(line));
  }
});

// ---------------------------------------------------------------------------------------------
// Liveness: design 5.5's rule (boot id, pid, process start).

test('isPidLineAlive: the same boot, the pid exists and its process start matches', () => {
  const proc = fakeProc({
    bootId: BOOT_A,
    processes: { 4242: { stat: statLine(4242, 51234567), cmdline: [] } },
  });
  assert.equal(isPidLineAlive(SERVER, proc, BOOT_A), true);
  assert.equal(isPidLineAlive(KEEPER, proc, BOOT_A), true);
});

test('isPidLineAlive: a line from another boot is dead, even when the pid and start match', () => {
  const proc = fakeProc({
    bootId: BOOT_B,
    processes: { 4242: { stat: statLine(4242, 51234567), cmdline: [] } },
  });
  assert.equal(isPidLineAlive(SERVER, proc, BOOT_B), false);
});

test('isPidLineAlive: a reused pid (another process start) is dead', () => {
  const proc = fakeProc({
    bootId: BOOT_A,
    processes: { 4242: { stat: statLine(4242, 51234568), cmdline: [] } },
  });
  assert.equal(isPidLineAlive(SERVER, proc, BOOT_A), false);
});

test('isPidLineAlive: without a current boot id nothing counts as alive', () => {
  const proc = fakeProc({
    bootId: null,
    processes: { 4242: { stat: statLine(4242, 51234567), cmdline: [] } },
  });
  assert.equal(isPidLineAlive(SERVER, proc, null), false);
});

test('isPidLineAlive: a pid with no process is dead', () => {
  assert.equal(isPidLineAlive(SERVER, fakeProc({ bootId: BOOT_A }), BOOT_A), false);
});

test('isPidLineAlive: a stat line whose start cannot be read is dead', () => {
  const proc = fakeProc({
    bootId: BOOT_A,
    processes: { 4242: { stat: '4242 (claude) S 1', cmdline: [] } },
  });
  assert.equal(isPidLineAlive(SERVER, proc, BOOT_A), false);
});

test('isPidLineAlive judges by the boot id it is given, not by asking proc', () => {
  // The caller reads the boot id once for many lines; a proc whose own answer differs is ignored.
  const proc = fakeProc({
    bootId: BOOT_B,
    processes: { 4242: { stat: statLine(4242, 51234567), cmdline: [] } },
  });
  assert.equal(isPidLineAlive(SERVER, proc, BOOT_A), true);
});
