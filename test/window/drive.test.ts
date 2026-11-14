// Where the commands read the Windows side (S2 5.3, 5.4, 6.1, 16.2, 16.3): /mnt/c, or in a test
// sandbox the directory SKYDECK_TEST_MNT_C names — and nothing under /mnt/ at all without it
// (ruled by the plan owner, task 24). Pure: an environment and a path in, a path or null out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { driveC, readablePath, readableWindowsPath } from '../../src/window/drive.ts';

const REAL = { PATH: '/usr/bin' };
const MARKED = { SKYDECK_TEST_NO_WINDOWS: '1' };
const STAND_IN = { SKYDECK_TEST_NO_WINDOWS: '1', SKYDECK_TEST_MNT_C: '/sandbox/c' };

test('outside a test sandbox the C: drive is /mnt/c and every path is read as it is', () => {
  assert.equal(driveC(REAL), '/mnt/c');
  assert.equal(readablePath(REAL, '/mnt/c/Users/me'), '/mnt/c/Users/me');
  assert.equal(readablePath(REAL, '/mnt/d/x'), '/mnt/d/x');
  assert.equal(readablePath(REAL, '/home/me/x'), '/home/me/x');
});

test('SKYDECK_TEST_MNT_C without the sandbox mark is ignored', () => {
  const env = { SKYDECK_TEST_MNT_C: '/sandbox/c' };
  assert.equal(driveC(env), '/mnt/c');
  assert.equal(readablePath(env, '/mnt/c/x'), '/mnt/c/x');
  assert.equal(
    driveC({ SKYDECK_TEST_NO_WINDOWS: '0', SKYDECK_TEST_MNT_C: '/sandbox/c' }),
    '/mnt/c',
  );
});

test('in a test sandbox without SKYDECK_TEST_MNT_C nothing under /mnt/ is read: the drive is not mounted', () => {
  assert.equal(driveC(MARKED), null);
  for (const path of [
    '/mnt/c',
    '/mnt/c/',
    '/mnt/c/Users/me',
    '/mnt/d/x',
    '/mnt',
    '/mnt/',
    '//mnt/c/x',
  ]) {
    assert.equal(readablePath(MARKED, path), null, path);
  }
  assert.equal(readablePath(MARKED, '/home/me/x'), '/home/me/x');
});

test('in a test sandbox a path under /mnt/c moves under SKYDECK_TEST_MNT_C; another drive is never read', () => {
  assert.equal(driveC(STAND_IN), '/sandbox/c');
  assert.equal(readablePath(STAND_IN, '/mnt/c'), '/sandbox/c');
  assert.equal(
    readablePath(STAND_IN, '/mnt/c/Users/me/.wslconfig'),
    '/sandbox/c/Users/me/.wslconfig',
  );
  assert.equal(readablePath(STAND_IN, '/mnt/d/x'), null);
  assert.equal(readablePath(STAND_IN, '/mnt/cc/x'), null);
  assert.equal(readablePath(STAND_IN, '/mnt'), null);
});

test('in a test sandbox a path is judged after . and .. are resolved, so /mnt/ is never walked through', () => {
  assert.equal(readablePath(MARKED, '/mnt/c/../../etc/x'), '/etc/x');
  assert.equal(readablePath(MARKED, '/home/../mnt/c/x'), null);
  assert.equal(readablePath(STAND_IN, '/mnt/./c/./x'), '/sandbox/c/x');
  assert.equal(readablePath(STAND_IN, '/mnt/c/a/../../d/x'), null);
});

test('a SKYDECK_TEST_MNT_C that is not an absolute path is no drive', () => {
  for (const value of ['', 'sandbox/c', './c']) {
    const env = { SKYDECK_TEST_NO_WINDOWS: '1', SKYDECK_TEST_MNT_C: value };
    assert.equal(driveC(env), null, value);
    assert.equal(readablePath(env, '/mnt/c/x'), null, value);
  }
});

test('readableWindowsPath maps <letter>:\\… through /mnt/<letter>/', () => {
  assert.equal(readableWindowsPath(REAL, 'C:\\Users\\me\\x'), '/mnt/c/Users/me/x');
  assert.equal(readableWindowsPath(REAL, 'c:\\Users\\me'), '/mnt/c/Users/me');
  assert.equal(readableWindowsPath(REAL, 'D:\\data\\'), '/mnt/d/data');
  assert.equal(readableWindowsPath(REAL, 'C:\\'), '/mnt/c');
  assert.equal(readableWindowsPath(STAND_IN, 'C:\\Users\\me\\x'), '/sandbox/c/Users/me/x');
  assert.equal(readableWindowsPath(STAND_IN, 'D:\\data'), null);
  assert.equal(readableWindowsPath(MARKED, 'C:\\Users\\me'), null);
});

test('readableWindowsPath refuses what is not an absolute Windows path, and . or .. segments', () => {
  for (const path of [
    'Users\\me',
    '\\\\server\\share',
    'C:Users',
    '/mnt/c/x',
    'C:\\..\\x',
    'C:\\a\\.\\b',
    'C:\\a\\\\b',
    '',
  ]) {
    assert.equal(readableWindowsPath(REAL, path), null, path);
  }
});
