import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatPidLine,
  isPidLineAlive,
  parsePidLine,
  pidLineState,
} from '../../src/window/pidline.ts';
import type { PidLine } from '../../src/window/pidline.ts';
import type { Proc } from '../../src/platform/types.ts';
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

test('parsePidLine takes any token without whitespace as the boot id (tests invent their own)', () => {
  for (const bootId of ['test-boot', 'BOOT-A', BOOT_A.toUpperCase(), 'x', 'é']) {
    assert.deepEqual(parsePidLine(`4242 51234567 ${bootId}\n`), { ...SERVER, bootId }, bootId);
  }
});

test('parsePidLine takes any token without whitespace as the keeper version', () => {
  for (const version of ['1', '2.1-rc', 'v10', 'é']) {
    assert.deepEqual(
      parsePidLine(`4242 51234567 ${BOOT_A} ${version} 1\n`),
      { ...SERVER, keeper: { version, started: true } },
      version,
    );
  }
});

test('parsePidLine reads pid and process start as decimal integers, leading zeros included', () => {
  assert.deepEqual(parsePidLine(`04242 051234567 ${BOOT_A}\n`), SERVER);
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
    `0 51234567 ${BOOT_A}\n`, // pid 0: a signal to it would reach the caller's own group
    `00 51234567 ${BOOT_A}\n`,
    `-1 51234567 ${BOOT_A}\n`,
    `+4242 51234567 ${BOOT_A}\n`,
    `42x 51234567 ${BOOT_A}\n`,
    `4242.0 51234567 ${BOOT_A}\n`,
    `0x10 51234567 ${BOOT_A}\n`,
    `9007199254740992 51234567 ${BOOT_A}\n`, // not a safe integer
    `4242 x ${BOOT_A}\n`,
    `4242 -5 ${BOOT_A}\n`,
    `4242 1e3 ${BOOT_A}\n`,
    `4242 9007199254740992 ${BOOT_A}\n`,
    `4242 51234567 ${BOOT_A} x\n`, // whitespace inside the boot id
    `4242 51234567 ${BOOT_A} 1 2\n`, // started is 0 or 1
    `4242 51234567 ${BOOT_A} 1 true\n`,
  ];
  for (const text of garbled) {
    assert.equal(parsePidLine(text), null, JSON.stringify(text));
  }
});

test('formatPidLine writes an invented boot id as it is, and it reads back', () => {
  const line: PidLine = { pid: 7, procStart: 1, bootId: 'test-boot' };
  assert.equal(formatPidLine(line), '7 1 test-boot\n');
  assert.deepEqual(parsePidLine(formatPidLine(line)), line);
});

test('formatPidLine refuses a field that would break the line: empty or holding whitespace', () => {
  const bad: PidLine[] = [
    { ...SERVER, bootId: '' },
    { ...SERVER, bootId: 'a b' },
    { ...SERVER, bootId: `${BOOT_A}\n` },
    { ...SERVER, bootId: 'a\tb' },
    { ...KEEPER, keeper: { version: '', started: false } },
    { ...KEEPER, keeper: { version: '1 0', started: false } },
    { ...KEEPER, keeper: { version: '1\n', started: false } },
  ];
  for (const line of bad) {
    assert.throws(() => formatPidLine(line), /pid line/, JSON.stringify(line));
  }
});

test('formatPidLine refuses a pid that is not a positive whole number', () => {
  for (const pid of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => formatPidLine({ ...SERVER, pid }), /pid line/, String(pid));
  }
});

test('formatPidLine refuses a process start that is not a non-negative whole number', () => {
  for (const procStart of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => formatPidLine({ ...SERVER, procStart }), /pid line/, String(procStart));
  }
});

// ---------------------------------------------------------------------------------------------
// Liveness: design 5.5's rule (boot id, pid, process start), with "cannot tell" kept apart.

function procWith(stat: string | null, bootId: string | null = BOOT_A): Proc {
  return fakeProc({
    bootId,
    processes: stat === null ? {} : { 4242: { stat, cmdline: [] } },
  });
}

test('pidLineState: alive when the boot, the pid and its process start all match', () => {
  const proc = procWith(statLine(4242, 51234567));
  assert.equal(pidLineState(SERVER, proc, BOOT_A), 'alive');
  assert.equal(pidLineState(KEEPER, proc, BOOT_A), 'alive');
});

test('pidLineState: dead when the line is from another boot, even when the pid and start match', () => {
  assert.equal(pidLineState(SERVER, procWith(statLine(4242, 51234567), BOOT_B), BOOT_B), 'dead');
});

test('pidLineState: dead when the pid was reused (another process start)', () => {
  assert.equal(pidLineState(SERVER, procWith(statLine(4242, 51234568)), BOOT_A), 'dead');
});

test('pidLineState: dead when no process has the pid', () => {
  assert.equal(pidLineState(SERVER, procWith(null), BOOT_A), 'dead');
});

test('pidLineState: unknown without a current boot id, even when the process matches', () => {
  assert.equal(pidLineState(SERVER, procWith(statLine(4242, 51234567), null), null), 'unknown');
});

test('pidLineState: unknown when reading /proc fails', () => {
  const proc: Proc = {
    ...procWith(statLine(4242, 51234567)),
    stat() {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    },
  };
  assert.equal(pidLineState(SERVER, proc, BOOT_A), 'unknown');
});

test('pidLineState: unknown when the stat line exists but its process start cannot be read', () => {
  assert.equal(pidLineState(SERVER, procWith('4242 (claude) S 1'), BOOT_A), 'unknown');
});

test('pidLineState judges by the boot id it is given, not by asking proc', () => {
  // The caller reads the boot id once for many lines; a proc whose own answer differs is ignored.
  assert.equal(pidLineState(SERVER, procWith(statLine(4242, 51234567), BOOT_B), BOOT_A), 'alive');
});

test('isPidLineAlive is true only for a line known to be alive', () => {
  const cases: [Proc, string | null, boolean][] = [
    [procWith(statLine(4242, 51234567)), BOOT_A, true],
    [procWith(statLine(4242, 51234567), BOOT_B), BOOT_B, false], // other boot: dead
    [procWith(statLine(4242, 51234568)), BOOT_A, false], // reused pid: dead
    [procWith(null), BOOT_A, false], // no process: dead
    [procWith(statLine(4242, 51234567), null), null, false], // no boot id: unknown
    [procWith('4242 (claude) S 1'), BOOT_A, false], // unreadable start: unknown
  ];
  for (const [proc, bootId, alive] of cases) {
    assert.equal(isPidLineAlive(SERVER, proc, bootId), alive);
  }
});
