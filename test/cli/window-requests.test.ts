// The command line's requests to the window's server (plan C 2.4, 2.5; task 76): `windowTimes`'
// answer time (C17), `windowServer` (C11), `requestResume` / `requestNew`, `resumeInWindow` /
// `newInWindow` with the window a command opens (C12), and `restoreInWindow` (C14's request).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { windowTimes } from '../../src/cli/window-open.ts';

describe('windowTimes: answerMs (plan C17)', () => {
  test('30 s by default; SKYDECK_TEST_WINDOW_TIMES sets it only in a test sandbox', () => {
    assert.equal(windowTimes({}).answerMs, 30_000);
    assert.equal(
      windowTimes({ SKYDECK_TEST_NO_WINDOWS: '1', SKYDECK_TEST_WINDOW_TIMES: 'answerMs=300' })
        .answerMs,
      300,
    );
    assert.equal(windowTimes({ SKYDECK_TEST_WINDOW_TIMES: 'answerMs=300' }).answerMs, 30_000);
    assert.deepEqual(
      windowTimes({ SKYDECK_TEST_NO_WINDOWS: '1', SKYDECK_TEST_WINDOW_TIMES: 'pageMs=5' }),
      { pageMs: 5, reuseMs: 2000, launchingMs: 45_000, reconnectMs: 7000, answerMs: 30_000 },
    );
  });
});
