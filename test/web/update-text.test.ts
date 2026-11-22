// Follow-up F38's words for the update notice (web/update-text.js): when the title bar's control
// shows, what the dialog says for each answer of the server's look, and the settings screen's
// block `Updates`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { UpdateCheckPayload, UpdatePayload } from '../../src/window/protocol.ts';
import { dialogLines, settingsLines, showsNotice, UPDATE_TEXTS } from '../../web/update-text.js';

const SEC = 1_000_000_000n;
const NOW = 1_794_474_000_000_000_000n;
const ago = (seconds: bigint): string => String(NOW - seconds * SEC);

const LINES = [
  '2 new commits on origin/main (0123456..fedcba9):',
  '  fedcba9  two',
  '  1234567  one',
];
const AVAILABLE: UpdateCheckPayload = {
  state: 'available',
  summary: '2 new commits on origin/main',
  to: 'fedcba9876543210fedcba9876543210fedcba98',
  lines: LINES,
  blocked: null,
};
const CURRENT: UpdateCheckPayload = {
  state: 'current',
  summary: 'skydeck is up to date (main at 0123456, as origin/main)',
};

function payload(over: Partial<UpdatePayload> = {}): UpdatePayload {
  return {
    checking: false,
    check: AVAILABLE,
    checkedAtNs: ago(90n),
    fetchedAtNs: ago(90n),
    failure: null,
    ...over,
  };
}

describe('showsNotice', () => {
  test('exactly while a newer version is known', () => {
    assert.equal(showsNotice(payload()), true);
    assert.equal(showsNotice(payload({ failure: { atNs: ago(1n), line: 'x' } })), true);
    assert.equal(showsNotice(payload({ check: CURRENT })), false);
    assert.equal(showsNotice(payload({ check: { state: 'cannot', summary: 'no' } })), false);
    assert.equal(showsNotice(payload({ check: null })), false);
    assert.equal(showsNotice(null), false);
  });
});

describe("the dialog's lines", () => {
  test('available: the lines of --check, then the command to run in a terminal', () => {
    assert.deepEqual(dialogLines(AVAILABLE), [
      ...LINES,
      'To apply it, in a WSL terminal of your own: skydeck update',
    ]);
  });

  test('blocked: the lines, the reason, then the command once that is set right', () => {
    const blocked =
      'this checkout has changes that are not committed (1 file, the first: a.txt); commit or undo them first';
    assert.deepEqual(dialogLines({ ...AVAILABLE, blocked }), [
      ...LINES,
      `This checkout cannot be updated as it is: ${blocked}`,
      'Once that is set right, in a WSL terminal of your own: skydeck update',
    ]);
  });

  test('current: its summary alone', () => {
    assert.deepEqual(dialogLines(CURRENT), [CURRENT.summary]);
  });

  test('cannot: why skydeck cannot tell, then the command once that is set right', () => {
    const line = 'the branch main follows no branch of a remote; update it with git yourself';
    assert.deepEqual(dialogLines({ state: 'cannot', summary: line }), [
      `skydeck cannot tell here whether there is an update: ${line}`,
      'Once that is set right, in a WSL terminal of your own: skydeck update',
    ]);
  });

  test('none yet', () => {
    assert.deepEqual(dialogLines(null), ['No check was made yet.']);
  });
});

describe("the settings screen's block", () => {
  test('the last check with its age and summary', () => {
    assert.deepEqual(settingsLines(payload(), String(NOW)), [
      'Last check: 1m ago — 2 new commits on origin/main',
    ]);
    assert.deepEqual(
      settingsLines(payload({ check: CURRENT, checkedAtNs: ago(0n) }), String(NOW)),
      [`Last check: 0s ago — ${CURRENT.summary}`],
    );
  });

  test("the age is the last check's end, whatever it found, not the last fetch that worked", () => {
    // A check that ended `cannot` a moment ago, after a fetch that worked three days before.
    const line = 'this checkout is not on a branch (detached HEAD); update it with git yourself';
    assert.deepEqual(
      settingsLines(
        payload({
          check: { state: 'cannot', summary: line },
          checkedAtNs: ago(2n),
          fetchedAtNs: ago(3n * 86_400n),
        }),
        String(NOW),
      ),
      [`Last check: 2s ago — ${line}`],
    );
  });

  test('a failure beside a known outcome: when and why first, then what is known and from when', () => {
    const failure = { atNs: ago(5n), line: 'git fetch from origin failed: fatal: gone' };
    assert.deepEqual(settingsLines(payload({ failure }), String(NOW)), [
      'The last check failed 5s ago: git fetch from origin failed: fatal: gone',
      'Known from 1m ago: 2 new commits on origin/main',
    ]);
  });

  test('a check that failed is its own cannot: its line once, with its age', () => {
    for (const line of [
      'skydeck could not check for an update (Error (EAGAIN))',
      'git symbolic-ref failed: no answer within 10 s; nothing was changed',
    ]) {
      const update = payload({
        check: { state: 'cannot', summary: line },
        checkedAtNs: ago(0n),
        failure: { atNs: ago(0n), line },
      });
      assert.deepEqual(settingsLines(update, String(NOW)), [
        `The last check failed 0s ago: ${line}`,
      ]);
    }
  });

  test('a failure with nothing fetched before', () => {
    const failure = { atNs: ago(5n), line: 'git fetch from origin failed: no answer within 60 s' };
    assert.deepEqual(
      settingsLines(payload({ check: CURRENT, fetchedAtNs: null, failure }), String(NOW)),
      [
        'The last check failed 5s ago: git fetch from origin failed: no answer within 60 s',
        'Nothing was fetched before.',
      ],
    );
  });

  test('a look that could not tell, with no fetch: its line', () => {
    const line = 'the branch main follows no branch of a remote; update it with git yourself';
    assert.deepEqual(
      settingsLines(
        payload({
          check: { state: 'cannot', summary: line },
          checkedAtNs: null,
          fetchedAtNs: null,
        }),
        String(NOW),
      ),
      [`Last check: ${line}`],
    );
  });

  test('no check yet; Checking… while one runs', () => {
    assert.deepEqual(settingsLines(null, String(NOW)), [UPDATE_TEXTS.never]);
    assert.deepEqual(settingsLines(payload({ check: null, fetchedAtNs: null }), ''), [
      'No check was made yet.',
    ]);
    assert.deepEqual(settingsLines(payload({ check: null, checking: true }), String(NOW)), [
      'No check was made yet.',
      'Checking…',
    ]);
  });
});
