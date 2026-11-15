import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Ns } from '../../../src/platform/types.ts';
import type { ListRow } from '../../../src/sessions/list.ts';
import type { AttentionPayload } from '../../../src/window/protocol.ts';
import {
  attentionOf,
  attentionOrder,
  liveStatuses,
  NO_ATTENTION,
  startsToNeed,
} from '../../../src/window/view/attention.ts';
import type {
  AttentionFacts,
  AttentionMarks,
  LiveStatus,
} from '../../../src/window/view/attention.ts';
import { ds, rowOf } from '../../helpers/derived.ts';
import { S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';
const S7 = '6b1f9c7e-4d8a-4fca-9c9d-8e7f6a5b4c3d';
const DAY_NS: Ns = 86_400n * SEC;

/** A row whose session runs (step 1's state `running`: a holder, no live file needed here). */
function runningRow(id: string): ListRow {
  return rowOf(ds({ id, state: 'running' }));
}

/** A row whose session does not run. */
function stoppedRow(id: string): ListRow {
  return rowOf(ds({ id }));
}

function marks(over: Partial<AttentionMarks> = {}): AttentionMarks {
  return {
    turnEndedSeq: null,
    turnEndedNs: null,
    seenSeq: null,
    windowEndSeq: null,
    windowEndNs: null,
    ...over,
  };
}

function live(status: string | null, over: Partial<LiveStatus> = {}): LiveStatus {
  return { status, waitingFor: null, sinceNs: null, ...over };
}

function facts(
  over: { marks?: [string, AttentionMarks][]; live?: [string, LiveStatus][] } = {},
): AttentionFacts {
  return { marks: new Map(over.marks ?? []), live: new Map(over.live ?? []) };
}

/** The live file's waitingFor of a session that asks, and what the row says of it. */
function detailOf(waitingFor: string): string | null {
  const payload = attentionOf(
    runningRow(S1),
    facts({ live: [[S1, live('waiting', { waitingFor })]] }),
  );
  assert.ok(payload);
  assert.equal(payload.reason, 'asks');
  return payload.detail;
}

// --- attentionOf: asks ------------------------------------------------------------------------

test('attentionOf: asks for a running row whose status is waiting, with its detail and time', () => {
  const payload = attentionOf(
    runningRow(S1),
    facts({
      live: [[S1, live('waiting', { waitingFor: 'permission · Bash', sinceNs: T0 - SEC })]],
    }),
  );
  assert.deepEqual(payload, {
    reason: 'asks',
    detail: 'permission · Bash',
    sinceNs: String(T0 - SEC),
  } satisfies AttentionPayload);
});

test('attentionOf: asks for every running state of step 1 (working, waiting, running)', () => {
  for (const state of ['working', 'waiting', 'running'] as const) {
    const row = rowOf(ds({ id: S1, state }));
    const payload = attentionOf(row, facts({ live: [[S1, live('waiting')]] }));
    assert.equal(payload?.reason, 'asks', state);
  }
});

test("attentionOf: an ask's detail is sanitised; markup comes back as text", () => {
  assert.equal(
    detailOf('\x1b[31mBash\x1b[0m: <img src=x onerror=alert(1)>\x1b]0;title\x07'),
    'Bash: <img src=x onerror=alert(1)>',
  );
  assert.equal(detailOf('two\nlines'), 'two lines');
});

test('attentionOf: an ask without a waitingFor, or one that is blank once sanitised, has no detail', () => {
  const payload = attentionOf(runningRow(S1), facts({ live: [[S1, live('waiting')]] }));
  assert.deepEqual(payload, { reason: 'asks', detail: null, sinceNs: null });
  assert.equal(detailOf(''), null);
  assert.equal(detailOf(' \x1b[0m\t '), null);
});

test('attentionOf: a waitingFor longer than 120 units is cut to 119 and …; up to 120 it is whole', () => {
  const long = detailOf('x'.repeat(300));
  assert.equal(long, `${'x'.repeat(119)}…`);
  assert.equal(long?.length, 120);
  assert.equal(detailOf('y'.repeat(120)), 'y'.repeat(120));
  assert.equal(detailOf('z'.repeat(121)), `${'z'.repeat(119)}…`);
});

test('attentionOf: the cut never splits a surrogate pair: one across it is cut before the pair', () => {
  // Units 0–117 'a', 118–119 the pair: a cut at 119 would keep the high half alone.
  const across = detailOf(`${'a'.repeat(118)}😀${'b'.repeat(50)}`);
  assert.equal(across, `${'a'.repeat(118)}…`);
  assert.ok(across?.isWellFormed());
  // A pair that ends right at the cut is kept whole.
  assert.equal(detailOf(`${'a'.repeat(117)}😀${'b'.repeat(50)}`), `${'a'.repeat(117)}😀…`);
});

test('attentionOf: the cut is measured on the sanitised text', () => {
  const text = `${'q'.repeat(120)}\x1b[0m\x1b[1m`;
  assert.equal(detailOf(text), 'q'.repeat(120));
});

test('attentionOf: the detail is trimmed once sanitised, and the cut is measured on the trimmed text', () => {
  assert.equal(detailOf('  permission · Bash \n'), 'permission · Bash');
  // Sanitised first, then trimmed: spaces inside escape sequences go too.
  assert.equal(detailOf('\x1b[1m  Bash \x1b[0m'), 'Bash');
  assert.equal(detailOf(`${' '.repeat(130)}text`), 'text');
  assert.equal(detailOf(`\t\n${' '.repeat(10)}${'x'.repeat(120)}  `), 'x'.repeat(120));
  assert.equal(detailOf(`${' '.repeat(5)}${'y'.repeat(200)}`), `${'y'.repeat(119)}…`);
});

test('attentionOf: no ask for a row that is not running, whatever its last status', () => {
  const payload = attentionOf(
    stoppedRow(S1),
    facts({ live: [[S1, live('waiting', { waitingFor: 'permission' })]] }),
  );
  assert.equal(payload, null);
});

test('attentionOf: no ask while busy, idle, without a status or without a LiveStatus', () => {
  for (const status of ['busy', 'idle', null, 'something new']) {
    assert.equal(attentionOf(runningRow(S1), facts({ live: [[S1, live(status)]] })), null);
  }
  assert.equal(attentionOf(runningRow(S1), facts()), null);
});

// --- attentionOf: ended -----------------------------------------------------------------------

test('attentionOf: ended when windowEndSeq is greater than seenSeq, with the window end time', () => {
  const payload = attentionOf(
    stoppedRow(S1),
    facts({ marks: [[S1, marks({ seenSeq: 3, windowEndSeq: 4, windowEndNs: T0 - 2n * SEC })]] }),
  );
  assert.deepEqual(payload, {
    reason: 'ended',
    detail: null,
    sinceNs: String(T0 - 2n * SEC),
  } satisfies AttentionPayload);
});

test('attentionOf: ended when seenSeq is null; for a running row too', () => {
  const ended = facts({ marks: [[S1, marks({ windowEndSeq: 1, windowEndNs: T0 })]] });
  assert.equal(attentionOf(stoppedRow(S1), ended)?.reason, 'ended');
  assert.equal(attentionOf(runningRow(S1), ended)?.reason, 'ended');
});

test('attentionOf: not ended once seenSeq is greater, nor when the two are equal', () => {
  const at = (seenSeq: number) =>
    attentionOf(
      stoppedRow(S1),
      facts({ marks: [[S1, marks({ seenSeq, windowEndSeq: 5, windowEndNs: T0 })]] }),
    );
  assert.equal(at(6), null);
  assert.equal(at(5), null);
  assert.equal(at(4)?.reason, 'ended');
});

test('attentionOf: an ended row without a known time has sinceNs null', () => {
  const payload = attentionOf(stoppedRow(S1), facts({ marks: [[S1, marks({ windowEndSeq: 1 })]] }));
  assert.deepEqual(payload, { reason: 'ended', detail: null, sinceNs: null });
});

// --- attentionOf: finished --------------------------------------------------------------------

/** Facts of a session whose turn ended (seq 4, at T0 - 3 s), seen at `seenSeq`, at `status`. */
function turnEnded(status: string | null, seenSeq: number | null = 2): AttentionFacts {
  return facts({
    marks: [[S1, marks({ turnEndedSeq: 4, turnEndedNs: T0 - 3n * SEC, seenSeq })]],
    live: [[S1, live(status)]],
  });
}

test('attentionOf: finished for a running idle row whose turn ended after it was seen', () => {
  assert.deepEqual(attentionOf(runningRow(S1), turnEnded('idle')), {
    reason: 'finished',
    detail: null,
    sinceNs: String(T0 - 3n * SEC),
  } satisfies AttentionPayload);
  assert.equal(attentionOf(runningRow(S1), turnEnded('idle', null))?.reason, 'finished');
});

test('attentionOf: not finished when busy, without a status or a LiveStatus, or not running', () => {
  assert.equal(attentionOf(runningRow(S1), turnEnded('busy')), null);
  assert.equal(attentionOf(runningRow(S1), turnEnded(null)), null);
  assert.equal(
    attentionOf(
      runningRow(S1),
      facts({ marks: [[S1, marks({ turnEndedSeq: 4, turnEndedNs: T0 })]] }),
    ),
    null,
  );
  assert.equal(attentionOf(stoppedRow(S1), turnEnded('idle')), null);
});

test('attentionOf: a finished row has no detail although its idle file still holds a waitingFor', () => {
  const f = facts({
    marks: [[S1, marks({ turnEndedSeq: 4, turnEndedNs: T0 })]],
    live: [[S1, live('idle', { waitingFor: 'left over', sinceNs: T0 })]],
  });
  assert.deepEqual(attentionOf(runningRow(S1), f), {
    reason: 'finished',
    detail: null,
    sinceNs: String(T0),
  });
});

/** Facts of a running session whose turn ended at `turnEndedNs` (seq 4, never seen) and whose
 *  file has been idle since `sinceNs`. */
function idleSince(turnEndedNs: Ns | null, sinceNs: Ns | null): AttentionFacts {
  return facts({
    marks: [[S1, marks({ turnEndedSeq: 4, turnEndedNs })]],
    live: [[S1, live('idle', { sinceNs })]],
  });
}

test('attentionOf: a turn end of an earlier run is not finished: the idle status began after it', () => {
  // Resumed elsewhere days later: idle since a second ago, its last turn end 3 days old.
  assert.equal(attentionOf(runningRow(S1), idleSince(T0 - 3n * DAY_NS, T0 - SEC)), null);
  assert.equal(attentionOf(runningRow(S1), idleSince(T0, T0 + 1n)), null);
});

test('attentionOf: finished while the idle status began at the turn end, or before it', () => {
  assert.deepEqual(attentionOf(runningRow(S1), idleSince(T0, T0)), {
    reason: 'finished',
    detail: null,
    sinceNs: String(T0),
  });
  assert.equal(attentionOf(runningRow(S1), idleSince(T0, T0 - SEC))?.reason, 'finished');
});

test('attentionOf: finished when the turn end time or the status time is not known', () => {
  assert.equal(attentionOf(runningRow(S1), idleSince(null, T0))?.reason, 'finished');
  assert.equal(attentionOf(runningRow(S1), idleSince(T0, null))?.reason, 'finished');
  assert.equal(attentionOf(runningRow(S1), idleSince(null, null))?.reason, 'finished');
});

test('attentionOf: a window end is ended whatever the times of an earlier turn end', () => {
  const f = facts({
    marks: [[S1, marks({ turnEndedSeq: 4, turnEndedNs: T0 - DAY_NS, windowEndSeq: 5 })]],
    live: [[S1, live('idle', { sinceNs: T0 })]],
  });
  assert.equal(attentionOf(runningRow(S1), f)?.reason, 'ended');
});

test('attentionOf: a waiting row whose turn ended asks instead of finishing', () => {
  assert.equal(attentionOf(runningRow(S1), turnEnded('waiting'))?.reason, 'asks');
});

test('attentionOf: not finished once seen later, nor when the two seqs are equal', () => {
  assert.equal(attentionOf(runningRow(S1), turnEnded('idle', 5)), null);
  assert.equal(attentionOf(runningRow(S1), turnEnded('idle', 4)), null);
  assert.equal(attentionOf(runningRow(S1), turnEnded('idle', 3))?.reason, 'finished');
});

// --- attentionOf: the order of the reasons ----------------------------------------------------

test('attentionOf: asks before ended before finished when several hold', () => {
  const all = (status: string): AttentionFacts =>
    facts({
      marks: [
        [
          S1,
          marks({
            turnEndedSeq: 6,
            turnEndedNs: T0, // the status time: a turn end of this run, so finished holds too
            windowEndSeq: 5,
            windowEndNs: T0 - 2n * SEC,
          }),
        ],
      ],
      live: [[S1, live(status, { waitingFor: 'a question', sinceNs: T0 })]],
    });
  assert.deepEqual(attentionOf(runningRow(S1), all('waiting')), {
    reason: 'asks',
    detail: 'a question',
    sinceNs: String(T0),
  });
  assert.deepEqual(attentionOf(runningRow(S1), all('idle')), {
    reason: 'ended',
    detail: null,
    sinceNs: String(T0 - 2n * SEC),
  });
});

test('attentionOf: NO_ATTENTION gives no attention to any row', () => {
  assert.equal(attentionOf(runningRow(S1), NO_ATTENTION), null);
  assert.equal(attentionOf(stoppedRow(S1), NO_ATTENTION), null);
  assert.equal(NO_ATTENTION.marks.size, 0);
  assert.equal(NO_ATTENTION.live.size, 0);
});

test("attentionOf: another session's facts are not this row's", () => {
  const other = facts({
    marks: [[S2, marks({ windowEndSeq: 1, windowEndNs: T0 })]],
    live: [[S2, live('waiting')]],
  });
  assert.equal(attentionOf(runningRow(S1), other), null);
});

// --- liveStatuses -----------------------------------------------------------------------------

function file(
  sessionId: string,
  status: string | null,
  over: { waitingFor?: string | null; sinceNs?: Ns | null } = {},
) {
  return { sessionId, status, waitingFor: over.waitingFor ?? null, sinceNs: over.sinceNs ?? null };
}

test('liveStatuses: B5 — a holder that waits wins over one that is idle, in either order', () => {
  const waiting = file(S1, 'waiting', { waitingFor: 'permission', sinceNs: T0 - SEC });
  const idle = file(S1, 'idle', { sinceNs: T0 });
  const expected = { status: 'waiting', waitingFor: 'permission', sinceNs: T0 - SEC };
  assert.deepEqual(liveStatuses([idle, waiting]).get(S1), expected);
  assert.deepEqual(liveStatuses([waiting, idle]).get(S1), expected);
});

test('liveStatuses: B5 — a holder that waits wins over one that is busy, in either order', () => {
  const waiting = file(S1, 'waiting', { waitingFor: 'permission', sinceNs: T0 - SEC });
  const busy = file(S1, 'busy', { sinceNs: T0 });
  const expected = { status: 'waiting', waitingFor: 'permission', sinceNs: T0 - SEC };
  assert.deepEqual(liveStatuses([busy, waiting]).get(S1), expected);
  assert.deepEqual(liveStatuses([waiting, busy]).get(S1), expected);
});

test('liveStatuses: B5 — busy wins over idle; idle over any other status', () => {
  const busy = file(S1, 'busy', { sinceNs: T0 - SEC });
  const idle = file(S1, 'idle', { sinceNs: T0 });
  assert.deepEqual(liveStatuses([idle, busy]).get(S1), {
    status: 'busy',
    waitingFor: null,
    sinceNs: T0 - SEC,
  });
  const odd = file(S1, 'compacting', { sinceNs: T0 - 2n * SEC });
  assert.deepEqual(liveStatuses([odd, idle]).get(S1)?.status, 'idle');
});

test("liveStatuses: B5 — with none of the three, the first holder's", () => {
  const first = file(S1, 'compacting', { sinceNs: T0 });
  const second = file(S1, null);
  assert.deepEqual(liveStatuses([first, second]).get(S1), {
    status: 'compacting',
    waitingFor: null,
    sinceNs: T0,
  });
  assert.deepEqual(liveStatuses([second, first]).get(S1)?.status, null);
});

test('liveStatuses: of two holders that wait, the first one in the input', () => {
  const a = file(S1, 'waiting', { waitingFor: 'first', sinceNs: T0 });
  const b = file(S1, 'waiting', { waitingFor: 'second', sinceNs: T0 - SEC });
  assert.equal(liveStatuses([a, b]).get(S1)?.waitingFor, 'first');
});

test('liveStatuses: one status per session; nothing for a session with no file', () => {
  const statuses = liveStatuses([file(S1, 'idle'), file(S2, 'busy'), file(S1, 'busy')]);
  assert.deepEqual([...statuses.keys()].sort(), [S1, S2].sort());
  assert.equal(statuses.get(S1)?.status, 'busy');
  assert.equal(statuses.get(S2)?.status, 'busy');
  assert.equal(statuses.has(S3), false);
  assert.equal(liveStatuses([]).size, 0);
});

// --- attentionOrder ---------------------------------------------------------------------------

test('attentionOrder: B6 — asks by status time (unknown last), then ended, then finished', () => {
  const f = facts({
    marks: [
      [S4, marks({ windowEndSeq: 7, windowEndNs: T0 })],
      [S5, marks({ windowEndSeq: 3, windowEndNs: T0 })],
      [S6, marks({ turnEndedSeq: 9, turnEndedNs: T0 - 9n * SEC })],
      [S7, marks({ turnEndedSeq: 2, turnEndedNs: T0 })],
    ],
    live: [
      [S1, live('waiting', { sinceNs: T0 - 10n * SEC })],
      [S2, live('waiting', { sinceNs: T0 - 20n * SEC })],
      [S3, live('waiting')],
      [S6, live('idle')],
      [S7, live('idle')],
    ],
  });
  const entries = [S7, S3, S6, S5, S1, S4, S2].map((id) => {
    const attention = attentionOf(runningRow(id), f);
    assert.ok(attention, id);
    return { id, attention };
  });
  assert.deepEqual(attentionOrder(entries, f), [S2, S1, S3, S5, S4, S7, S6]);
});

test('attentionOrder: ties by session id, unknown times too', () => {
  const f = facts({
    marks: [
      [S4, marks({ windowEndSeq: 3 })],
      [S3, marks({ windowEndSeq: 3 })],
    ],
    live: [
      [S2, live('waiting', { sinceNs: T0 })],
      [S1, live('waiting', { sinceNs: T0 })],
      [S6, live('waiting')],
      [S5, live('waiting')],
    ],
  });
  const entries = [S6, S4, S2, S5, S3, S1].map((id) => {
    const attention = attentionOf(runningRow(id), f);
    assert.ok(attention, id);
    return { id, attention };
  });
  assert.deepEqual(attentionOrder(entries, f), [S1, S2, S5, S6, S3, S4]);
});

test('attentionOrder: each reason is ordered by its own counter when the marks hold both', () => {
  const f = facts({
    marks: [
      // finished at turns 20 and 10; their window ends, seen, say the opposite order
      [S1, marks({ turnEndedSeq: 20, seenSeq: 5, windowEndSeq: 1 })],
      [S2, marks({ turnEndedSeq: 10, seenSeq: 5, windowEndSeq: 2 })],
      // ended at window ends 40 and 30; their turn ends say the opposite order
      [S3, marks({ windowEndSeq: 40, turnEndedSeq: 6 })],
      [S4, marks({ windowEndSeq: 30, turnEndedSeq: 7 })],
    ],
    live: [
      [S1, live('idle')],
      [S2, live('idle')],
    ],
  });
  const entries = [S1, S2, S3, S4].map((id) => {
    const attention = attentionOf(runningRow(id), f);
    assert.ok(attention, id);
    return { id, attention };
  });
  assert.deepEqual(
    entries.map((e) => e.attention.reason),
    ['finished', 'finished', 'ended', 'ended'],
  );
  assert.deepEqual(attentionOrder(entries, f), [S4, S3, S2, S1]);
});

test('attentionOrder: empty in, empty out; the input is not changed', () => {
  assert.deepEqual(attentionOrder([], NO_ATTENTION), []);
  const f = facts({
    live: [
      [S2, live('waiting', { sinceNs: T0 })],
      [S1, live('waiting', { sinceNs: T0 + SEC })],
    ],
  });
  const entries = [S1, S2].map((id) => ({
    id,
    attention: attentionOf(runningRow(id), f) as AttentionPayload,
  }));
  assert.deepEqual(attentionOrder(entries, f), [S2, S1]);
  assert.deepEqual(
    entries.map((e) => e.id),
    [S1, S2],
  );
});

// --- startsToNeed -----------------------------------------------------------------------------

test("startsToNeed: the ids of after that are not in before, in after's order", () => {
  const before = new Map([[S1, 'asks']]);
  const after = new Map([
    [S3, 'finished'],
    [S1, 'asks'],
    [S2, 'ended'],
  ]);
  assert.deepEqual(startsToNeed(before, after), [S3, S2]);
});

test('startsToNeed: a changed reason is not new; one that no longer needs you is not listed', () => {
  assert.deepEqual(startsToNeed(new Map([[S1, 'asks']]), new Map([[S1, 'finished']])), []);
  assert.deepEqual(
    startsToNeed(
      new Map([
        [S1, 'asks'],
        [S2, 'ended'],
      ]),
      new Map([[S2, 'ended']]),
    ),
    [],
  );
  assert.deepEqual(startsToNeed(new Map(), new Map()), []);
});
