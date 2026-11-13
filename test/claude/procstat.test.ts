import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  argvFromCmdline,
  parentPidFromStat,
  procStartFromStat,
} from '../../src/claude/procstat.ts';
import { statLine } from '../helpers/platform.ts';

const TAIL = '4194304 1 0 0 0 1 0 0 0 20 0 11 0';

test('procStartFromStat reads field 22 of an ordinary stat line', () => {
  const line = `4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} 51234567 1048576 4096`;
  assert.equal(procStartFromStat(line), 51234567);
});

test('procStartFromStat counts after the LAST closing parenthesis', () => {
  const line = `4242 (a) b) S 4100 4242 4100 34816 4242 ${TAIL} 51234567 1048576 4096`;
  assert.equal(procStartFromStat(line), 51234567);
});

test('procStartFromStat survives spaces in the command name', () => {
  assert.equal(procStartFromStat(`4242 (my prog) S 4100 4242 4100 34816 4242 ${TAIL} 7 0 0`), 7);
});

test('procStartFromStat ignores the trailing newline of a real /proc read', () => {
  assert.equal(
    procStartFromStat(`4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} 51234567 1 2\n`),
    51234567,
  );
});

test('procStartFromStat accepts a line that ends exactly at field 22', () => {
  assert.equal(procStartFromStat(`4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} 9`), 9);
});

test('procStartFromStat gives null for empty and malformed input', () => {
  assert.equal(procStartFromStat(''), null);
  assert.equal(procStartFromStat('garbage'), null);
  assert.equal(procStartFromStat('4242 (claude) S 1 2 3'), null);
  assert.equal(procStartFromStat('4242 (claude)'), null);
});

test('procStartFromStat gives null when field 22 is not digits', () => {
  assert.equal(procStartFromStat(`4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} x 0 0`), null);
  assert.equal(procStartFromStat(`4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} -5 0 0`), null);
  assert.equal(
    procStartFromStat(`4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} 12x 0 0`),
    null,
  );
});

test('procStartFromStat gives null for a start time that is not a safe integer', () => {
  assert.equal(
    procStartFromStat(`4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} 9007199254740991 0 0`),
    9007199254740991,
  );
  assert.equal(
    procStartFromStat(`4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} 9007199254740992 0 0`),
    null,
  );
  assert.equal(
    procStartFromStat(
      `4242 (claude) S 4100 4242 4100 34816 4242 ${TAIL} 100000000000000000000 0 0`,
    ),
    null,
  );
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('argvFromCmdline splits on NUL and drops the final empty element', () => {
  assert.deepEqual(argvFromCmdline(bytes('claude\0--model\0opus\0')), [
    'claude',
    '--model',
    'opus',
  ]);
});

test('argvFromCmdline keeps a last argument that has no terminating NUL', () => {
  assert.deepEqual(argvFromCmdline(bytes('claude\0x')), ['claude', 'x']);
});

test('argvFromCmdline keeps empty arguments in the middle', () => {
  assert.deepEqual(argvFromCmdline(bytes('claude\0\0x\0')), ['claude', '', 'x']);
});

test('argvFromCmdline keeps an empty last argument', () => {
  assert.deepEqual(argvFromCmdline(bytes('claude\0--system-prompt\0\0')), [
    'claude',
    '--system-prompt',
    '',
  ]);
});

test('argvFromCmdline gives [""] for a single NUL (one empty argument)', () => {
  assert.deepEqual(argvFromCmdline(bytes('\0')), ['']);
});

test('argvFromCmdline gives [] for empty input', () => {
  assert.deepEqual(argvFromCmdline(bytes('')), []);
});

test('argvFromCmdline decodes UTF-8', () => {
  assert.deepEqual(argvFromCmdline(bytes('claude\0-n\0čeština\0')), ['claude', '-n', 'čeština']);
});

test('argvFromCmdline keeps a leading byte-order mark as part of the first argument', () => {
  assert.deepEqual(argvFromCmdline(bytes('\uFEFFclaude\0')), ['\uFEFFclaude']);
});

test('argvFromCmdline replaces invalid UTF-8 instead of throwing', () => {
  assert.deepEqual(argvFromCmdline(Uint8Array.from([0x61, 0xff, 0x62, 0])), ['a\uFFFDb']);
});

test('parentPidFromStat reads field 4 after the LAST closing parenthesis', () => {
  // statLine writes 1 as the parent; the name holds ") " to defeat a split at the first ')'.
  assert.equal(parentPidFromStat(statLine(4242, 99, 'we) ird')), 1);
});

test('parentPidFromStat reads a parent other than init', () => {
  assert.equal(parentPidFromStat(`4242 (a) b (c) S 4100 4242 4100 34816 4242 ${TAIL} 7 0 0`), 4100);
});

test('parentPidFromStat gives 0 for a process without a parent (pid 1, kernel threads)', () => {
  assert.equal(parentPidFromStat(`1 (init) S 0 1 1 0 -1 ${TAIL} 7 0 0`), 0);
});

test('parentPidFromStat ignores the trailing newline of a real /proc read', () => {
  assert.equal(parentPidFromStat(`4242 (claude) S 4100 4242\n`), 4100);
});

test('parentPidFromStat gives null for empty and malformed input', () => {
  assert.equal(parentPidFromStat(''), null);
  assert.equal(parentPidFromStat('garbage 4100'), null);
  assert.equal(parentPidFromStat('4242 (claude)'), null);
  assert.equal(parentPidFromStat('4242 (claude) S'), null);
});

test('parentPidFromStat gives null when field 4 is not a non-negative safe integer', () => {
  assert.equal(parentPidFromStat('4242 (claude) S x 4242'), null);
  assert.equal(parentPidFromStat('4242 (claude) S -1 4242'), null);
  assert.equal(parentPidFromStat('4242 (claude) S 41x 4242'), null);
  assert.equal(parentPidFromStat('4242 (claude) S 9007199254740992 4242'), null);
});
