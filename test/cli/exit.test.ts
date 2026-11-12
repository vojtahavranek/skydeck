import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXIT } from '../../src/cli/exit.ts';

test('the exit codes are the ones in the design (7.5)', () => {
  assert.deepEqual(EXIT, { ok: 0, failure: 1, usage: 2, ref: 3, refused: 4, stopped: 5 });
});
