// `.wslconfig`'s `[general] instanceIdleTimeout` (S2 6.1, 16.3): the protection doctor reports
// when it is -1. Pure: text in, a number or null out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { instanceIdleTimeout } from '../../src/window/wslconfig.ts';

test('instanceIdleTimeout=-1 under [general] is -1', () => {
  assert.equal(instanceIdleTimeout('[general]\ninstanceIdleTimeout=-1\n'), -1);
});

test('another whole number is that number, 0 included', () => {
  assert.equal(instanceIdleTimeout('[general]\ninstanceIdleTimeout=60000\n'), 60000);
  assert.equal(instanceIdleTimeout('[general]\ninstanceIdleTimeout=0'), 0);
});

test('spaces and tabs around the section, the key, the = and the value; CRLF line ends', () => {
  assert.equal(instanceIdleTimeout('  [ general ]  \r\n\t instanceIdleTimeout \t=  -1 \r\n'), -1);
});

test('a UTF-8 byte order mark before the first line is ignored', () => {
  assert.equal(instanceIdleTimeout('﻿[general]\ninstanceIdleTimeout=-1\n'), -1);
});

test('the key in another section, or before any section, is not read', () => {
  assert.equal(instanceIdleTimeout('[wsl2]\ninstanceIdleTimeout=-1\n'), null);
  assert.equal(instanceIdleTimeout('instanceIdleTimeout=-1\n[general]\n'), null);
  assert.equal(
    instanceIdleTimeout('[general]\nautoProxy=true\n[wsl2]\ninstanceIdleTimeout=-1\n'),
    null,
  );
});

test('a [general] section after another one is read', () => {
  assert.equal(
    instanceIdleTimeout(
      '[wsl2]\nmemory=8GB\nvmIdleTimeout=-1\n[general]\ninstanceIdleTimeout=-1\n',
    ),
    -1,
  );
});

test('no [general] section, no key, an empty text: null', () => {
  assert.equal(instanceIdleTimeout(''), null);
  assert.equal(instanceIdleTimeout('[wsl2]\nmemory=8GB\n'), null);
  assert.equal(instanceIdleTimeout('[general]\n'), null);
});

test('comment lines (# and ;) and blank lines are skipped', () => {
  assert.equal(
    instanceIdleTimeout(
      '# keep WSL up\n[general]\n; instanceIdleTimeout=60000\n\n# instanceIdleTimeout=5\ninstanceIdleTimeout=-1\n',
    ),
    -1,
  );
  assert.equal(instanceIdleTimeout('[general]\n#instanceIdleTimeout=-1\n'), null);
});

test('a value that is not exactly a whole number is no value: null', () => {
  for (const value of ['', 'abc', '-1 # forever', '"-1"', '-1s', '1.5', '- 1', '0x10', '+1']) {
    assert.equal(
      instanceIdleTimeout(`[general]\ninstanceIdleTimeout=${value}\n`),
      null,
      JSON.stringify(value),
    );
  }
});

test('a number beyond what a number holds exactly is no value', () => {
  assert.equal(instanceIdleTimeout('[general]\ninstanceIdleTimeout=99999999999999999999\n'), null);
});

test('the names are matched exactly as WSL documents them: another spelling is not read', () => {
  // The safe side: a spelling WSL might not accept is never reported as a protection in effect.
  assert.equal(instanceIdleTimeout('[General]\ninstanceIdleTimeout=-1\n'), null);
  assert.equal(instanceIdleTimeout('[general]\nInstanceIdleTimeout=-1\n'), null);
  assert.equal(instanceIdleTimeout('[general]\ninstanceidletimeout=-1\n'), null);
});

test('the last occurrence in [general] wins, as WSL reads the file from the top', () => {
  assert.equal(
    instanceIdleTimeout('[general]\ninstanceIdleTimeout=-1\ninstanceIdleTimeout=60000\n'),
    60000,
  );
  assert.equal(
    instanceIdleTimeout(
      '[general]\ninstanceIdleTimeout=60000\n[wsl2]\n[general]\ninstanceIdleTimeout=-1\n',
    ),
    -1,
  );
  assert.equal(
    instanceIdleTimeout('[general]\ninstanceIdleTimeout=-1\ninstanceIdleTimeout=x\n'),
    null,
  );
});

test('a line without = and a malformed section header change nothing', () => {
  assert.equal(instanceIdleTimeout('[general]\njunk\ninstanceIdleTimeout=-1\n'), -1);
  assert.equal(instanceIdleTimeout('[general\ninstanceIdleTimeout=-1\n'), null);
});
