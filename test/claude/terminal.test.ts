import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLAUDE_CHILD_VARIABLES, isTurnEnd, lookAt } from '../../src/claude/terminal.ts';
import type { LookedFile } from '../../src/claude/terminal.ts';
import { S1, S2, SEC, T0 } from '../helpers/platform.ts';

// S2 7.4: known today, and seen in the environment of a Claude Code session's command.
const KNOWN = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_EFFORT',
];

test('CLAUDE_CHILD_VARIABLES holds every name S2 7.4 lists, and nothing else', () => {
  assert.deepEqual([...CLAUDE_CHILD_VARIABLES].sort(), [...KNOWN].sort());
});

test('CLAUDE_CHILD_VARIABLES are whole variable names, never prefixes', () => {
  for (const name of CLAUDE_CHILD_VARIABLES) {
    assert.match(name, /^[A-Z][A-Z0-9_]*[A-Z0-9]$/, name);
  }
  assert.equal(new Set(CLAUDE_CHILD_VARIABLES).size, CLAUDE_CHILD_VARIABLES.length);
});

test("CLAUDE_CHILD_VARIABLES leaves the user's own Claude Code settings alone", () => {
  assert.equal(CLAUDE_CHILD_VARIABLES.includes('CLAUDE_CODE_USE_BEDROCK'), false);
  assert.equal(CLAUDE_CHILD_VARIABLES.includes('CLAUDE_CONFIG_DIR'), false);
});

test('CLAUDE_CHILD_VARIABLES cannot be changed by a caller', () => {
  assert.equal(Object.isFrozen(CLAUDE_CHILD_VARIABLES), true);
});

// S2 10.3: what a change of a live-session file means for a turn end.

/** A file as a look takes it: pid 100 of process start 5000, holding S1, busy since T0. */
function looked(fields: Partial<LookedFile> = {}): LookedFile {
  return {
    pid: 100,
    procStart: 5000,
    sessionId: S1,
    status: 'busy',
    waitingFor: null,
    sinceNs: T0,
    ...fields,
  };
}

function baselinesOf(...files: LookedFile[]): Map<number, LookedFile> {
  return new Map(files.map((file) => [file.pid, file]));
}

const NONE: ReadonlySet<number> = new Set();

test('isTurnEnd: busy to idle and waiting to idle are turn ends', () => {
  assert.equal(isTurnEnd(looked({ status: 'busy' }), looked({ status: 'idle' })), true);
  assert.equal(
    isTurnEnd(
      looked({ status: 'waiting', waitingFor: 'permission' }),
      looked({ status: 'idle', sinceNs: T0 + SEC }),
    ),
    true,
  );
});

test('isTurnEnd: no other status change is a turn end', () => {
  const changes: [string | null, string | null][] = [
    ['busy', 'waiting'], // a dialog opened inside the turn
    ['idle', 'idle'],
    ['idle', 'busy'],
    ['waiting', 'busy'],
    ['busy', 'busy'],
    ['shell', 'idle'],
    [null, 'idle'],
    ['busy', null],
    ['busy', 'shell'],
    ['Busy', 'idle'],
    ['busy', 'IDLE'],
  ];
  for (const [before, after] of changes) {
    assert.equal(
      isTurnEnd(looked({ status: before }), looked({ status: after })),
      false,
      `${before} → ${after}`,
    );
  }
});

test('isTurnEnd: another session, process start or pid starts over: no turn end', () => {
  const busy = looked({ status: 'busy' });
  assert.equal(isTurnEnd(busy, looked({ status: 'idle', sessionId: S2 })), false, '/clear');
  assert.equal(isTurnEnd(busy, looked({ status: 'idle', procStart: 5001 })), false, 'start');
  assert.equal(isTurnEnd(busy, looked({ status: 'idle', pid: 101 })), false, 'pid');
});

test('lookAt: the first look sets the baselines and gives no turn end', () => {
  const busy = looked({ pid: 100, status: 'busy' });
  const idle = looked({ pid: 200, sessionId: S2, status: 'idle' });
  const result = lookAt(new Map(), [busy, idle], NONE, true);
  assert.deepEqual(result.baselines, baselinesOf(busy, idle));
  assert.deepEqual(result.ends, []);

  // Also over baselines it was given: a turn that ended while no server ran is not recorded.
  const again = lookAt(baselinesOf(busy), [looked({ status: 'idle' })], NONE, true);
  assert.deepEqual(again.ends, []);
  assert.equal(again.baselines.get(100)?.status, 'idle');
});

test("lookAt: busy at one look and idle at the next is one turn end, at the file's time", () => {
  const first = lookAt(new Map(), [looked({ status: 'busy' })], NONE, true);
  const idle = looked({ status: 'idle', sinceNs: T0 + 7n * SEC });
  const second = lookAt(first.baselines, [idle], NONE, false);
  assert.deepEqual(second.ends, [{ pid: 100, sessionId: S1, atNs: T0 + 7n * SEC }]);
  assert.deepEqual(second.baselines, baselinesOf(idle));

  // The next look with the same file is no second end.
  const third = lookAt(second.baselines, [idle], NONE, false);
  assert.deepEqual(third.ends, []);
});

test('lookAt: a file without a time gives the end with a null time (the caller uses its clock)', () => {
  const result = lookAt(
    baselinesOf(looked({ status: 'waiting' })),
    [looked({ status: 'idle', sinceNs: null })],
    NONE,
    false,
  );
  assert.deepEqual(result.ends, [{ pid: 100, sessionId: S1, atNs: null }]);
});

test('lookAt: a pid with no file at a look keeps its baseline; idle at the look after is still an end', () => {
  const busy = looked({ status: 'busy' });
  const missing = lookAt(baselinesOf(busy), [], NONE, false);
  assert.deepEqual(missing.ends, []);
  assert.deepEqual(missing.baselines, baselinesOf(busy));

  const idle = looked({ status: 'idle', sinceNs: T0 + 3n * SEC });
  const after = lookAt(missing.baselines, [idle], NONE, false);
  assert.deepEqual(after.ends, [{ pid: 100, sessionId: S1, atNs: T0 + 3n * SEC }]);
});

test('lookAt: a pid in gone is dropped, and its next file starts over', () => {
  const other = looked({ pid: 200, sessionId: S2, status: 'busy' });
  const dropped = lookAt(baselinesOf(looked({ status: 'busy' }), other), [], new Set([100]), false);
  assert.deepEqual(dropped.baselines, baselinesOf(other));
  assert.deepEqual(dropped.ends, []);

  // The pid taken by another program, whose file shows up later: no end from a dead holder's busy.
  const later = lookAt(dropped.baselines, [looked({ status: 'idle' })], NONE, false);
  assert.deepEqual(later.ends, []);
  assert.equal(later.baselines.get(100)?.status, 'idle');
});

test('lookAt: gone speaks of pids without a file; a pid with a file is judged by it', () => {
  const idle = looked({ status: 'idle' });
  const result = lookAt(baselinesOf(looked({ status: 'busy' })), [idle], new Set([100]), false);
  assert.deepEqual(result.ends, [{ pid: 100, sessionId: S1, atNs: T0 }]);
  assert.deepEqual(result.baselines, baselinesOf(idle));
});

test('lookAt: a file naming another session, or another process start, starts over', () => {
  const cleared = looked({ sessionId: S2, status: 'idle' });
  const afterClear = lookAt(baselinesOf(looked({ status: 'busy' })), [cleared], NONE, false);
  assert.deepEqual(afterClear.ends, [], '/clear');
  assert.deepEqual(afterClear.baselines, baselinesOf(cleared));

  const restarted = looked({ procStart: 6000, status: 'idle' });
  const afterStart = lookAt(baselinesOf(looked({ status: 'busy' })), [restarted], NONE, false);
  assert.deepEqual(afterStart.ends, [], 'another process start');
  assert.deepEqual(afterStart.baselines, baselinesOf(restarted));

  // From the new baseline on, its own turns count.
  const busy = looked({ sessionId: S2, status: 'busy' });
  const turn = lookAt(
    lookAt(afterClear.baselines, [busy], NONE, false).baselines,
    [cleared],
    NONE,
    false,
  );
  assert.deepEqual(turn.ends, [{ pid: 100, sessionId: S2, atNs: T0 }]);
});

test('lookAt: a pid seen for the first time at a later look gives no end', () => {
  const result = lookAt(new Map(), [looked({ status: 'idle' })], NONE, false);
  assert.deepEqual(result.ends, []);
  assert.deepEqual(result.baselines, baselinesOf(looked({ status: 'idle' })));
});

test("lookAt: several pids' ends in one look, in the files' order; the input is left as it was", () => {
  const before = baselinesOf(
    looked({ pid: 300, sessionId: S2, status: 'busy' }),
    looked({ pid: 100, status: 'waiting' }),
  );
  const copy = new Map(before);
  const result = lookAt(
    before,
    [
      looked({ pid: 100, status: 'idle', sinceNs: T0 + SEC }),
      looked({ pid: 300, sessionId: S2, status: 'idle', sinceNs: T0 + 2n * SEC }),
    ],
    NONE,
    false,
  );
  assert.deepEqual(result.ends, [
    { pid: 100, sessionId: S1, atNs: T0 + SEC },
    { pid: 300, sessionId: S2, atNs: T0 + 2n * SEC },
  ]);
  assert.deepEqual(before, copy);
  assert.notEqual(result.baselines, before);
});

test('lookAt: a file read is the new baseline also when its status did not change', () => {
  // Another dialog of the same turn: the new detail and time.
  const asks = looked({ status: 'waiting', waitingFor: 'permission' });
  const asksAgain = looked({ status: 'waiting', waitingFor: 'a question', sinceNs: T0 + SEC });
  const dialog = lookAt(baselinesOf(asks), [asksAgain], NONE, false);
  assert.deepEqual(dialog.ends, []);
  assert.equal(dialog.baselines.get(100), asksAgain);
  // A turn shorter than a look: idle before and after, with a later time. No end; the new time.
  const idleLater = looked({ status: 'idle', sinceNs: T0 + 5n * SEC });
  const short = lookAt(baselinesOf(looked({ status: 'idle' })), [idleLater], NONE, false);
  assert.deepEqual(short.ends, []);
  assert.equal(short.baselines.get(100), idleLater);
});
