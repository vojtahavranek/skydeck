import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LiveFile, ProcessKey } from '../../src/claude/live.ts';
import { NS_PER_DAY, NS_PER_MS } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { deriveSessions } from '../../src/sessions/derive.ts';
import type { DeriveInput } from '../../src/sessions/derive.ts';
import { MARK_ORDER } from '../../src/sessions/types.ts';
import type { DerivedSession } from '../../src/sessions/types.ts';
import type {
  EndDetail,
  EventRow,
  LinkKind,
  LinkRow,
  SessionMeta,
  StartDetail,
  TranscriptRow,
} from '../../src/store/types.ts';
import { BOOT_A, BOOT_B, S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';

const P1: ProcessKey = { bootId: BOOT_A, pid: 4242, procStart: 100 };
const P2: ProcessKey = { bootId: BOOT_A, pid: 4343, procStart: 200 };
const P4: ProcessKey = { bootId: BOOT_A, pid: 4242, procStart: 300 }; // P1's pid, reused
const NOW: Ns = T0 + 600n * SEC;
const DAY = NS_PER_DAY;

let nextId = 1;

function event(
  p: ProcessKey | null,
  sessionId: string,
  timeNs: Ns,
  kind: EventRow['kind'],
  detail: EventRow['detail'],
  over: Partial<EventRow> = {},
): EventRow {
  return {
    id: nextId++,
    spoolName: kind === 'observed' ? null : `${nextId}.ev`,
    timeNs,
    kind,
    detail,
    rawDetail: null,
    sessionId,
    bootId: p === null ? BOOT_A : p.bootId,
    pid: p === null ? 0 : p.pid,
    procStart: p === null ? null : p.procStart,
    cwd: null,
    argv: null,
    name: null,
    payload: null,
    ...over,
  };
}

const start = (
  p: ProcessKey | null,
  s: string,
  t: Ns,
  detail: StartDetail,
  argv?: string[],
  over: Partial<EventRow> = {},
): EventRow => event(p, s, t, 'start', detail, { argv: argv ?? null, ...over });
const end = (p: ProcessKey | null, s: string, t: Ns, detail: EndDetail): EventRow =>
  event(p, s, t, 'end', detail);
const observed = (p: ProcessKey, s: string, t: Ns, argv?: string[]): EventRow =>
  event(p, s, t, 'observed', '', { argv: argv ?? null });

function link(from: string, to: string, kind: LinkKind, timeNs: Ns, eventId = nextId++): LinkRow {
  return { eventId, fromSession: from, toSession: to, kind, timeNs };
}

function live(
  p: ProcessKey,
  sessionId: string,
  status: string | null,
  extra: Partial<LiveFile> = {},
): LiveFile {
  return {
    pid: p.pid,
    sessionId,
    cwd: null,
    procStart: p.procStart,
    entrypoint: 'cli',
    name: null,
    status,
    waitingFor: null,
    updatedAtNs: null,
    statusUpdatedAtNs: null,
    mtimeNs: T0,
    ...extra,
  };
}

function tr(sessionId: string, over: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    path: `/claude/projects/p/${sessionId}.jsonl`,
    sessionId,
    sizeRead: 100,
    fileSize: 100,
    mtimeNs: T0,
    firstCwd: null,
    entrypoint: 'cli',
    aiTitle: null,
    customTitle: null,
    firstRecordNs: null,
    lastRecordNs: null,
    lastUserNs: null,
    lastTurnRole: null,
    missingSinceNs: null,
    ...over,
  };
}

function meta(sessionId: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    label: null,
    group: null,
    note: null,
    doneAtNs: null,
    createdNs: T0,
    updatedNs: T0,
    ...over,
  };
}

const keyOf = (p: ProcessKey): string => `${p.bootId}/${p.pid}/${p.procStart}`;

/** `isAlive` for exactly these processes. */
function alive(...ps: ProcessKey[]): (p: ProcessKey) => boolean {
  const keys = new Set(ps.map(keyOf));
  return (p) => keys.has(keyOf(p));
}

type Given = Partial<
  Omit<DeriveInput, 'events' | 'links' | 'transcripts' | 'metas' | 'liveFiles'>
> & {
  events?: EventRow[];
  links?: LinkRow[];
  transcripts?: TranscriptRow[];
  metas?: SessionMeta[];
  liveFiles?: LiveFile[];
};

function derive(given: Given = {}): DerivedSession[] {
  return deriveSessions({
    events: [],
    links: [],
    transcripts: [],
    metas: [],
    liveFiles: [],
    bootId: BOOT_A,
    isAlive: () => false,
    isTrusted: () => true,
    nowNs: NOW,
    retentionDays: 30,
    ...given,
  });
}

/** The derived session `id` of a run; fails the test when there is none. */
function session(given: Given, id: string): DerivedSession {
  const found = derive(given).find((s) => s.id === id);
  assert.ok(found, `no derived session ${id}`);
  return found;
}

// ---- the latest event (what a resume decided on) ------------------------------------------------

test('lastEventId is the highest id among the events of the session, whatever their times', () => {
  const first = start(P1, S1, T0 + 9n * SEC, 'startup');
  const second = end(P1, S1, T0, 'exit'); // a later id, an earlier time
  const other = start(P2, S2, T0 + 20n * SEC, 'startup');
  const events = [first, other, second];
  assert.equal(session({ events }, S1).lastEventId, second.id);
  assert.equal(session({ events }, S2).lastEventId, other.id);
});

test('every session carries the boot id its holders were judged against, null when there was none', () => {
  const events = [start(P1, S1, T0, 'startup')];
  assert.equal(session({ events }, S1).bootId, BOOT_A);
  assert.equal(session({ events, bootId: BOOT_B }, S1).bootId, BOOT_B);
  assert.equal(session({ events, bootId: null }, S1).bootId, null);
  assert.equal(session({ transcripts: [tr(S2)], bootId: null }, S2).bootId, null);
});

test('lastEventId is null for a session known only from its transcript', () => {
  assert.equal(session({ transcripts: [tr(S1)] }, S1).lastEventId, null);
});

// ---- states (cases 1-5) -----------------------------------------------------------------------

test('1: a holder whose live file is busy is working, since its status time', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'busy', { statusUpdatedAtNs: T0 + 5n * SEC })],
    },
    S1,
  );
  assert.equal(s.state, 'working');
  assert.equal(s.sinceNs, T0 + 5n * SEC);
  assert.deepEqual(
    s.holders.map((h) => h.process),
    [P1],
  );
  assert.deepEqual(s.marks, []);
});

test('2: an idle live file is waiting, without detail', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'idle', { statusUpdatedAtNs: T0 + 5n * SEC })],
    },
    S1,
  );
  assert.equal(s.state, 'waiting');
  assert.equal(s.stateDetail, null);
});

test('3: a waiting live file is waiting for what it says, since updatedAt without statusUpdatedAt', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [
        live(P1, S1, 'waiting', {
          waitingFor: 'permission prompt',
          statusUpdatedAtNs: null,
          updatedAtNs: T0 + 7n * SEC,
        }),
      ],
    },
    S1,
  );
  assert.equal(s.state, 'waiting');
  assert.equal(s.stateDetail, 'permission prompt');
  assert.equal(s.sinceNs, T0 + 7n * SEC);
});

test('4: a holder without a live file is running, since its latest event', () => {
  const s = session({ events: [start(P1, S1, T0, 'startup')], isAlive: alive(P1) }, S1);
  assert.equal(s.state, 'running');
  assert.equal(s.sinceNs, T0);
  assert.equal(s.stateDetail, null);
});

test('4: a running session is since its holder’s latest event, not since its last record', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      transcripts: [tr(S1, { lastRecordNs: T0 + 30n * SEC })],
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.equal(s.sinceNs, T0);
  assert.equal(s.lastActivityNs, T0 + 30n * SEC);
});

test('5a: a live file with the status shell is running', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'shell', { statusUpdatedAtNs: T0 + 5n * SEC })],
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.equal(s.sinceNs, T0);
  assert.equal(s.holders[0]?.live?.status, 'shell');
});

test('5b: a live file naming another session is not the holder’s file: running', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P1, S2, 'busy')],
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.equal(s.holders[0]?.live, null);
});

test('5c: a live file that is not trusted is ignored: running', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'busy')],
      isTrusted: () => false,
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.equal(s.holders[0]?.live, null);
});

test('a live file of another process (same pid, other process start) is not the holder’s', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P4, S1, 'busy')],
    },
    S1,
  );
  assert.equal(s.state, 'running');
});

test('a live file without a process start never matches a process without one', () => {
  const unknown: ProcessKey = { bootId: BOOT_A, pid: 4242, procStart: null };
  const s = session(
    {
      events: [start(unknown, S1, T0, 'startup')],
      isAlive: alive(unknown),
      liveFiles: [live(unknown, S1, 'busy')],
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.equal(s.holders[0]?.live, null);
});

test('stateDetail is the waitingFor of an idle file too, and null for a busy one', () => {
  const given = (status: string): Given => ({
    events: [start(P1, S1, T0, 'startup')],
    isAlive: alive(P1),
    liveFiles: [live(P1, S1, status, { waitingFor: 'input' })],
  });
  assert.equal(session(given('idle'), S1).stateDetail, 'input');
  assert.equal(session(given('busy'), S1).stateDetail, null);
});

test('the status time wins over the update time when a file has both', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [
        live(P1, S1, 'idle', { statusUpdatedAtNs: T0 + 5n * SEC, updatedAtNs: T0 + 9n * SEC }),
      ],
    },
    S1,
  );
  assert.equal(s.state, 'waiting');
  assert.equal(s.sinceNs, T0 + 5n * SEC);
});

test('a session created by /clear is not since the idle time of the session before it', () => {
  // The same process, idle since T0, clears at T0+10 min: the file still says "idle since T0".
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        end(P1, S1, T0 + 600n * SEC - 200n * NS_PER_MS, 'clear'),
        start(P1, S2, T0 + 600n * SEC, 'clear'),
      ],
      isAlive: alive(P1),
      liveFiles: [live(P1, S2, 'idle', { statusUpdatedAtNs: T0, updatedAtNs: T0 + 5n * SEC })],
    },
    S2,
  );
  assert.equal(s.state, 'waiting');
  assert.equal(s.sinceNs, T0 + 600n * SEC);
});

test('an auto-compaction in the middle of a turn does not restart working-since', () => {
  // Busy since T0+20s; Claude Code compacts at T0+60s and fires SessionStart(compact).
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), start(P1, S1, T0 + 60n * SEC, 'compact')],
      isAlive: alive(P1),
      liveFiles: [
        live(P1, S1, 'busy', { statusUpdatedAtNs: T0 + 20n * SEC, updatedAtNs: T0 + 61n * SEC }),
      ],
    },
    S1,
  );
  assert.equal(s.state, 'working');
  assert.equal(s.sinceNs, T0 + 20n * SEC);
});

test('a session found by reconcile keeps its file status time', () => {
  // Idle since T0+20s; skydeck's first run at T0+300s inserts the observed event (design 5.4).
  const s = session(
    {
      events: [observed(P1, S1, T0 + 300n * SEC, ['claude'])],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'idle', { statusUpdatedAtNs: T0 + 20n * SEC })],
    },
    S1,
  );
  assert.equal(s.state, 'waiting');
  assert.equal(s.sinceNs, T0 + 20n * SEC);
});

test('a /resume of the session in the same process is a new holding', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        end(P1, S1, T0 + 100n * SEC, 'switch'),
        start(P1, S1, T0 + 100n * SEC + 200n * NS_PER_MS, 'resume'),
      ],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'idle', { statusUpdatedAtNs: T0 + 20n * SEC })],
    },
    S1,
  );
  assert.equal(s.sinceNs, T0 + 100n * SEC + 200n * NS_PER_MS);
});

test('only the holder’s own starts say when it began: another process’s do not', () => {
  const otherBoot: ProcessKey = { bootId: BOOT_B, pid: P1.pid, procStart: P1.procStart };
  const otherPid: ProcessKey = { bootId: BOOT_A, pid: 4999, procStart: P1.procStart };
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        start(P2, S1, T0 + 40n * SEC, 'resume'), // another pid and start
        start(otherPid, S1, T0 + 45n * SEC, 'resume'), // another pid, the same start
        start(P4, S1, T0 + 50n * SEC, 'resume'), // the same pid, another process start
        start(otherBoot, S1, T0 + 60n * SEC, 'resume'), // the same pid and start, another boot
      ],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'idle', { statusUpdatedAtNs: T0 + 20n * SEC })],
    },
    S1,
  );
  assert.deepEqual(
    s.holders.map((h) => h.process),
    [P1],
  );
  assert.equal(s.sinceNs, T0 + 20n * SEC);
});

test('a status time after the holder’s latest event is kept', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'busy', { statusUpdatedAtNs: T0 + 5n * SEC })],
    },
    S1,
  );
  assert.equal(s.sinceNs, T0 + 5n * SEC);
});

test('a working file without any time falls back to the holder’s latest event', () => {
  const s = session(
    {
      events: [start(P1, S1, T0 + 3n * SEC, 'startup')],
      isAlive: alive(P1),
      liveFiles: [live(P1, S1, 'busy')],
    },
    S1,
  );
  assert.equal(s.state, 'working');
  assert.equal(s.sinceNs, T0 + 3n * SEC);
});

test('a session that is not running is since its last activity', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'exit')],
      transcripts: [tr(S1, { lastRecordNs: T0 + 30n * SEC })],
    },
    S1,
  );
  assert.equal(s.state, 'not-running');
  assert.equal(s.sinceNs, T0 + 30n * SEC);
});

// ---- holding, links, marks (cases 6-18) -------------------------------------------------------

function clearPair(endDetail: EndDetail, startDetail: StartDetail): EventRow[] {
  return [
    start(P1, S1, T0, 'startup'),
    end(P1, S1, T0 + 60n * SEC, endDetail),
    start(P1, S2, T0 + 60n * SEC + 200n * NS_PER_MS, startDetail),
  ];
}

test('6: /clear ends one holding and starts another; only the new session is continued', () => {
  const given: Given = {
    events: clearPair('clear', 'clear'),
    links: [link(S1, S2, 'clear', T0 + 60n * SEC)],
    isAlive: alive(P1),
  };
  const first = session(given, S1);
  assert.equal(first.state, 'not-running');
  assert.deepEqual(first.marks, []);
  assert.deepEqual(first.lastHolding, {
    process: P1,
    endDetail: 'clear',
    endedAtNs: T0 + 60n * SEC,
    alive: true,
  });
  const second = session(given, S2);
  assert.equal(second.state, 'running');
  assert.deepEqual(second.marks, ['continued']);
  assert.equal(second.continuedFrom, S1);
});

test('7: a switch (/resume in a session) marks neither session', () => {
  const given: Given = {
    events: clearPair('switch', 'resume'),
    links: [link(S1, S2, 'switch', T0 + 60n * SEC)],
    isAlive: alive(P1),
  };
  assert.deepEqual(session(given, S1).marks, []);
  const second = session(given, S2);
  assert.deepEqual(second.marks, []);
  assert.equal(second.continuedFrom, null);
});

test('8: a fork link makes the new session continued', () => {
  const given: Given = {
    events: [start(P1, S1, T0, 'startup'), start(P1, S3, T0 + 5n * SEC, 'fork')],
    links: [link(S1, S3, 'fork', T0 + 5n * SEC)],
    isAlive: alive(P1),
  };
  const forked = session(given, S3);
  assert.ok(forked.marks.includes('continued'));
  assert.equal(forked.continuedFrom, S1);
});

test('continuedFrom is the latest clear or fork link, whatever order the links come in', () => {
  // The event ids disagree with the times on purpose: the time decides, the event id breaks ties.
  const links = [
    link(S1, S3, 'clear', T0 + 20n * SEC, 11),
    link(S2, S3, 'fork', T0 + 30n * SEC, 7),
    link(S1, S3, 'switch', T0 + 40n * SEC, 12),
  ];
  const events = [start(P1, S3, T0 + 50n * SEC, 'clear')];
  assert.equal(session({ events, links, isAlive: alive(P1) }, S3).continuedFrom, S2);
  assert.equal(
    session({ events, links: [...links].reverse(), isAlive: alive(P1) }, S3).continuedFrom,
    S2,
  );
});

test('continuedFrom: links at the same time are told apart by event id', () => {
  const t = T0 + 20n * SEC;
  const links = [link(S1, S3, 'clear', t, 7), link(S2, S3, 'clear', t, 9)];
  const events = [start(P1, S3, T0 + 50n * SEC, 'clear')];
  assert.equal(session({ events, links, isAlive: alive(P1) }, S3).continuedFrom, S2);
  assert.equal(
    session({ events, links: [...links].reverse(), isAlive: alive(P1) }, S3).continuedFrom,
    S2,
  );
});

test('9: a deliberate exit leaves no mark', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'exit')],
    },
    S1,
  );
  assert.equal(s.state, 'not-running');
  assert.deepEqual(s.marks, []);
  assert.deepEqual(s.lastHolding, {
    process: P1,
    endDetail: 'exit',
    endedAtNs: T0 + 10n * SEC,
    alive: false,
  });
});

test('10: an end with detail other is an unexpected end', () => {
  const s = session(
    { events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'other')] },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
  assert.equal(s.lastHolding?.endDetail, 'other');
});

test('an end by /clear or a switch of a dead process is not unexpected either', () => {
  for (const detail of ['clear', 'switch'] as const) {
    const s = session(
      { events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, detail)] },
      S1,
    );
    assert.deepEqual(s.marks, [], detail);
  }
});

test('an end row whose detail is none of the four reads as other', () => {
  const odd = event(P1, S1, T0 + 10n * SEC, 'end', 'startup');
  const s = session({ events: [start(P1, S1, T0, 'startup'), odd] }, S1);
  assert.equal(s.lastHolding?.endDetail, 'other');
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
});

test('an end by other whose process is alive is not marked', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'other')],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.equal(s.state, 'not-running');
  assert.deepEqual(s.marks, []);
  assert.equal(s.lastHolding?.alive, true);
});

test('11: no end and a dead process (crash, or a reboot) is an unexpected end', () => {
  const s = session({ events: [start(P1, S1, T0, 'startup')] }, S1);
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
  assert.deepEqual(s.lastHolding, { process: P1, endedAtNs: null, endDetail: null, alive: false });
});

test('11: a process of another boot is dead however its pid looks now', () => {
  const otherBoot: ProcessKey = { bootId: BOOT_B, pid: 4242, procStart: 100 };
  const s = session(
    {
      events: [start(otherBoot, S1, T0, 'startup')],
      isAlive: alive(P1), // same pid and start, other boot
    },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
});

test('12: a leftover busy live file of the dead process says a turn was in progress', () => {
  const s = session(
    { events: [start(P1, S1, T0, 'startup')], liveFiles: [live(P1, S1, 'busy')] },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly', 'was-working']);
});

test('12: the leftover file of a dead process counts although it cannot be trusted', () => {
  // In use `isTrusted` is false for every file of a dead process: its /proc entry is gone.
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      liveFiles: [live(P1, S1, 'busy')],
      isTrusted: () => false,
    },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly', 'was-working']);
});

test('12: the leftover busy file is the dead process’s, whichever session it names (plan 2.8.3)', () => {
  const s = session(
    { events: [start(P1, S1, T0, 'startup')], liveFiles: [live(P1, S2, 'busy')] },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly', 'was-working']);
});

test('13: an idle leftover file, or a busy file of another process start, is no evidence', () => {
  const events = [start(P1, S1, T0, 'startup')];
  for (const file of [live(P1, S1, 'idle'), live({ ...P1, procStart: 999 }, S1, 'busy')]) {
    assert.deepEqual(session({ events, liveFiles: [file] }, S1).marks, ['ended-unexpectedly']);
  }
});

test('13a: a transcript whose last turn is the user’s says a turn was in progress', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      transcripts: [tr(S1, { lastTurnRole: 'user' })],
    },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly', 'was-working']);
});

test('13b: a transcript whose last turn is the assistant’s does not', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      transcripts: [tr(S1, { lastTurnRole: 'assistant' })],
    },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
});

test('13c: a closed terminal (end other) in the middle of a turn was working', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'other')],
      transcripts: [tr(S1, { lastTurnRole: 'user' })],
    },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly', 'was-working']);
});

test('13d: a deliberate exit in the middle of a turn is not marked', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'exit')],
      transcripts: [tr(S1, { lastTurnRole: 'user' })],
    },
    S1,
  );
  assert.deepEqual(s.marks, []);
});

test('a running session is never marked unexpected, whatever its transcript says', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      isAlive: alive(P1),
      transcripts: [tr(S1, { lastTurnRole: 'user' })],
      liveFiles: [live(P1, S1, 'busy')],
    },
    S1,
  );
  assert.deepEqual(s.marks, []);
});

test('14: a reused pid is another process: the old session ended unexpectedly, the new one runs', () => {
  const given: Given = {
    events: [start(P1, S1, T0, 'startup'), start(P4, S2, T0 + 60n * SEC, 'startup')],
    isAlive: alive(P4),
  };
  const first = session(given, S1);
  assert.equal(first.state, 'not-running');
  assert.deepEqual(first.marks, ['ended-unexpectedly']);
  assert.equal(session(given, S2).state, 'running');
});

test('15: two live holders: running, latest first, marked duplicate', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), start(P2, S1, T0 + 30n * SEC, 'resume')],
      isAlive: alive(P1, P2),
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.deepEqual(
    s.holders.map((h) => [h.process, h.sinceNs]),
    [
      [P2, T0 + 30n * SEC],
      [P1, T0],
    ],
  );
  assert.deepEqual(s.marks, ['duplicate']);
});

test('15: only the live holders are listed; one dead one leaves no duplicate', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), start(P2, S1, T0 + 30n * SEC, 'resume')],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.deepEqual(
    s.holders.map((h) => h.process),
    [P1],
  );
  assert.deepEqual(s.marks, []);
});

test('with two holders the state comes from the latest one’s live file', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), start(P2, S1, T0 + 30n * SEC, 'resume')],
      isAlive: alive(P1, P2),
      liveFiles: [live(P1, S1, 'busy'), live(P2, S1, 'idle')],
    },
    S1,
  );
  assert.equal(s.state, 'waiting');
  assert.equal(s.holders[0]?.live?.status, 'idle');
  assert.equal(s.holders[1]?.live?.status, 'busy');
});

test('16: a process that moved on to another session without an end has moved on', () => {
  const given: Given = {
    events: [start(P1, S1, T0, 'startup'), observed(P1, S2, T0 + 5n * SEC)],
  };
  const first = session(given, S1);
  assert.deepEqual(first.lastHolding, {
    process: P1,
    endedAtNs: T0 + 5n * SEC,
    endDetail: 'moved-on',
    alive: false,
  });
  assert.deepEqual(first.marks, []);
  assert.deepEqual(session(given, S2).marks, ['ended-unexpectedly']);
});

test('17: a transcript that is missing and nothing else: expired', () => {
  const s = session({ transcripts: [tr(S1, { missingSinceNs: T0 })] }, S1);
  assert.deepEqual(s.marks, ['expired']);
  assert.deepEqual(s.holders, []);
  assert.equal(s.lastHolding, null);
  assert.equal(s.state, 'not-running');
});

test('18: expiring is more than (retention − 5) days since the last change of the transcript', () => {
  assert.deepEqual(session({ transcripts: [tr(S1, { mtimeNs: NOW - 26n * DAY })] }, S1).marks, [
    'expiring',
  ]);
  assert.deepEqual(session({ transcripts: [tr(S1, { mtimeNs: NOW - 24n * DAY })] }, S1).marks, []);
  assert.deepEqual(
    session({ transcripts: [tr(S1, { mtimeNs: NOW - SEC })], retentionDays: 3 }, S1).marks,
    ['expiring'],
  );
});

test('18: the boundary is exact: at the limit is not expiring, a nanosecond older is', () => {
  const limit = NOW - 25n * DAY;
  assert.deepEqual(session({ transcripts: [tr(S1, { mtimeNs: limit })] }, S1).marks, []);
  assert.deepEqual(session({ transcripts: [tr(S1, { mtimeNs: limit - 1n })] }, S1).marks, [
    'expiring',
  ]);
});

test('18: with retention of 5 days or less only a transcript changed right now escapes expiring', () => {
  assert.deepEqual(
    session({ transcripts: [tr(S1, { mtimeNs: NOW })], retentionDays: 5 }, S1).marks,
    [],
  );
  assert.deepEqual(
    session({ transcripts: [tr(S1, { mtimeNs: NOW - 1n })], retentionDays: 1 }, S1).marks,
    ['expiring'],
  );
});

test('18: the warning period never reaches into the future, however short the retention', () => {
  const s = session({ transcripts: [tr(S1, { mtimeNs: NOW + 1n * DAY })], retentionDays: 1 }, S1);
  assert.deepEqual(s.marks, []);
});

test('a missing transcript is expired, not expiring, however old', () => {
  const s = session(
    { transcripts: [tr(S1, { missingSinceNs: T0, mtimeNs: NOW - 100n * DAY })] },
    S1,
  );
  assert.deepEqual(s.marks, ['expired']);
});

// ---- done, hidden (cases 19-21) ---------------------------------------------------------------

const DONE = T0 + 100n * SEC;

test('19: done with no user input since is hidden', () => {
  const s = session(
    {
      metas: [meta(S1, { doneAtNs: DONE })],
      transcripts: [tr(S1, { lastUserNs: T0 + 50n * SEC })],
    },
    S1,
  );
  assert.equal(s.hidden, true);
  assert.equal(s.doneAtNs, DONE);
});

test('20: user input after done shows the session again', () => {
  const s = session(
    {
      metas: [meta(S1, { doneAtNs: DONE })],
      transcripts: [tr(S1, { lastUserNs: T0 + 150n * SEC })],
    },
    S1,
  );
  assert.equal(s.hidden, false);
  assert.equal(s.doneAtNs, DONE);
});

test('20: so does a start by startup or resume after done', () => {
  for (const detail of ['startup', 'resume'] as const) {
    const s = session(
      {
        metas: [meta(S1, { doneAtNs: DONE })],
        transcripts: [tr(S1, { lastUserNs: T0 + 50n * SEC })],
        events: [start(P1, S1, T0 + 150n * SEC, detail)],
      },
      S1,
    );
    assert.equal(s.hidden, false, detail);
  }
});

test('21: clear, compact, fork, an end or an observed event after done is not activity', () => {
  const at = T0 + 150n * SEC;
  const others: EventRow[] = [
    start(P1, S1, at, 'clear'),
    start(P1, S1, at, 'compact'),
    start(P1, S1, at, 'fork'),
    start(P1, S1, at, 'unknown'),
    end(P1, S1, at, 'exit'),
    observed(P1, S1, at),
  ];
  for (const other of others) {
    const s = session(
      {
        metas: [meta(S1, { doneAtNs: DONE })],
        transcripts: [tr(S1, { lastUserNs: T0 + 50n * SEC })],
        events: [other],
      },
      S1,
    );
    assert.equal(s.hidden, true, `${other.kind} ${other.detail}`);
  }
});

test('activity needs to be strictly after done, and to name the session', () => {
  const given = (events: EventRow[], lastUserNs: Ns): Given => ({
    metas: [meta(S1, { doneAtNs: DONE })],
    transcripts: [tr(S1, { lastUserNs })],
    events,
  });
  assert.equal(session(given([], DONE), S1).hidden, true);
  assert.equal(session(given([start(P1, S1, DONE, 'startup')], T0), S1).hidden, true);
  assert.equal(session(given([start(P1, S2, DONE + SEC, 'startup')], T0), S1).hidden, true);
  assert.equal(session(given([], DONE + 1n), S1).hidden, false);
});

test('a session that is not done is not hidden, and has no doneAtNs', () => {
  const s = session({ metas: [meta(S1)], transcripts: [tr(S1)] }, S1);
  assert.equal(s.hidden, false);
  assert.equal(s.doneAtNs, null);
});

test('done after the session’s only event, with no transcript, is hidden', () => {
  const s = session(
    { metas: [meta(S1, { doneAtNs: DONE })], events: [start(P1, S1, T0, 'startup')] },
    S1,
  );
  assert.equal(s.hidden, true);
});

// ---- dir, launch, times (cases 22-24) ---------------------------------------------------------

test('22: dir is the transcript’s first cwd, else the earliest event’s cwd, else null', () => {
  const events = [
    start(P1, S1, T0, 'startup'), // no cwd: skipped
    start(P1, S1, T0 + 1n * SEC, 'startup', undefined, { cwd: '/e' }),
    start(P1, S1, T0 + 5n * SEC, 'startup', undefined, { cwd: '/later' }),
  ];
  assert.equal(session({ events, transcripts: [tr(S1, { firstCwd: '/t' })] }, S1).dir, '/t');
  assert.equal(session({ events }, S1).dir, '/e');
  assert.equal(session({ events: [start(P1, S1, T0, 'startup')] }, S1).dir, null);
});

test('22: a transcript without a cwd falls back to the events', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup', undefined, { cwd: '/e' })],
      transcripts: [tr(S1)],
    },
    S1,
  );
  assert.equal(s.dir, '/e');
});

test('23: launch is the argv of the latest start or observed event that has one', () => {
  const a = ['claude', '--model', 'a'];
  const b = ['claude', '--model', 'b'];
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup', a),
        observed(P1, S1, T0 + 5n * SEC, b),
        end(P1, S1, T0 + 9n * SEC, 'exit'),
      ],
    },
    S1,
  );
  assert.deepEqual(s.launch, b);
});

test('23: a later event without a command does not hide an earlier one; none gives null', () => {
  const a = ['claude'];
  assert.deepEqual(
    session({ events: [start(P1, S1, T0, 'startup', a), start(P1, S1, T0 + SEC, 'resume')] }, S1)
      .launch,
    a,
  );
  assert.equal(session({ events: [start(P1, S1, T0, 'startup')] }, S1).launch, null);
});

test('23: only events naming the session count', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup', ['claude']), start(P2, S2, T0 + SEC, 'startup', ['x'])],
    },
    S1,
  );
  assert.deepEqual(s.launch, ['claude']);
});

test('24: last activity is the later of transcript and events, first seen the earlier', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'exit')],
      transcripts: [tr(S1, { lastRecordNs: T0 + 30n * SEC, firstRecordNs: T0 - 60n * SEC })],
    },
    S1,
  );
  assert.equal(s.lastActivityNs, T0 + 30n * SEC);
  assert.equal(s.firstSeenNs, T0 - 60n * SEC);
});

test('24: events later than the transcript’s last record win for last activity; earlier for first seen', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 90n * SEC, 'exit')],
      transcripts: [tr(S1, { lastRecordNs: T0 + 30n * SEC, firstRecordNs: T0 + 5n * SEC })],
    },
    S1,
  );
  assert.equal(s.lastActivityNs, T0 + 90n * SEC);
  assert.equal(s.firstSeenNs, T0);
});

test('24: a transcript without record times falls back to its mtime, an event counts first', () => {
  const bare = tr(S1, { mtimeNs: T0 + 40n * SEC });
  const alone = session({ transcripts: [bare] }, S1);
  assert.equal(alone.lastActivityNs, T0 + 40n * SEC);
  assert.equal(alone.firstSeenNs, T0 + 40n * SEC);
  const withEvent = session({ transcripts: [bare], events: [start(P1, S1, T0, 'startup')] }, S1);
  assert.equal(withEvent.lastActivityNs, T0);
  assert.equal(withEvent.firstSeenNs, T0);
});

test('events alone give last activity and first seen', () => {
  const s = session(
    { events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + 10n * SEC, 'exit')] },
    S1,
  );
  assert.equal(s.lastActivityNs, T0 + 10n * SEC);
  assert.equal(s.firstSeenNs, T0);
});

// ---- processes, transcripts, ordering (cases 25-28) -------------------------------------------

test('25: events without a pid belong to no process', () => {
  const s = session({ events: [start(null, S1, T0, 'startup')], isAlive: () => true }, S1);
  assert.equal(s.state, 'not-running');
  assert.equal(s.lastHolding, null);
  assert.deepEqual(s.marks, []);
  assert.deepEqual(s.holders, []);
});

test('25: an event without a pid still counts as activity of its session', () => {
  const s = session(
    { events: [start(P1, S1, T0, 'startup'), end(null, S1, T0 + 10n * SEC, 'exit')] },
    S1,
  );
  assert.equal(s.lastActivityNs, T0 + 10n * SEC);
});

test('25: an event without a pid does not become the latest of a process, nor its E', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(null, S1, T0 + 10n * SEC, 'exit')],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.equal(s.lastHolding?.endDetail, null);
});

test('26: of two transcripts the one that is not missing is used, though the other is newer', () => {
  const missing = tr(S1, {
    path: '/claude/projects/a/missing.jsonl',
    missingSinceNs: T0,
    mtimeNs: T0 + 50n * SEC,
    firstCwd: '/missing',
  });
  const present = tr(S1, {
    path: '/claude/projects/b/present.jsonl',
    mtimeNs: T0,
    firstCwd: '/ok',
  });
  for (const transcripts of [
    [missing, present],
    [present, missing],
  ]) {
    const s = session({ transcripts }, S1);
    assert.equal(s.transcript?.path, present.path);
    assert.equal(s.dir, '/ok');
    assert.ok(!s.marks.includes('expired'));
  }
});

test('26: of two present transcripts the newest is used, a tie goes to the smaller path', () => {
  const older = tr(S1, { path: '/a.jsonl', mtimeNs: T0 });
  const newer = tr(S1, { path: '/b.jsonl', mtimeNs: T0 + SEC });
  assert.equal(session({ transcripts: [older, newer] }, S1).transcript?.path, '/b.jsonl');
  assert.equal(session({ transcripts: [newer, older] }, S1).transcript?.path, '/b.jsonl');
  const x = tr(S1, { path: '/x.jsonl' });
  const y = tr(S1, { path: '/y.jsonl' });
  assert.equal(session({ transcripts: [y, x] }, S1).transcript?.path, '/x.jsonl');
  assert.equal(session({ transcripts: [x, y] }, S1).transcript?.path, '/x.jsonl');
});

test('26: of two missing transcripts the newest is used, and the session is expired', () => {
  const a = tr(S1, { path: '/a.jsonl', missingSinceNs: T0, mtimeNs: T0 });
  const b = tr(S1, { path: '/b.jsonl', missingSinceNs: T0, mtimeNs: T0 + SEC });
  const s = session({ transcripts: [a, b] }, S1);
  assert.equal(s.transcript?.path, '/b.jsonl');
  assert.deepEqual(s.marks, ['expired']);
});

test('27: the sessions are those of the events and of the transcripts, sorted by id', () => {
  const result = derive({
    events: [start(P1, S2, T0, 'startup')],
    transcripts: [tr(S1)],
  });
  assert.deepEqual(
    result.map((s) => s.id),
    [S1, S2],
  );
});

test('27: a session of both, or of several events, appears once; metas alone make none', () => {
  const result = derive({
    events: [start(P1, S2, T0, 'startup'), end(P1, S2, T0 + SEC, 'exit')],
    transcripts: [tr(S2)],
    metas: [meta(S3, { label: 'orphan' }), meta(S2)],
  });
  assert.deepEqual(
    result.map((s) => s.id),
    [S2],
  );
  assert.deepEqual(derive(), []);
});

test('28: marks come in the fixed order', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      liveFiles: [live(P1, S1, 'busy')],
      links: [link(S2, S1, 'clear', T0)],
      transcripts: [tr(S1, { mtimeNs: NOW - 26n * DAY })],
    },
    S1,
  );
  assert.deepEqual(s.marks, ['ended-unexpectedly', 'was-working', 'continued', 'expiring']);
  assert.deepEqual(
    s.marks,
    MARK_ORDER.filter((m) => s.marks.includes(m)),
  );
});

test('MARK_ORDER is the order of the table in design 6.3', () => {
  assert.deepEqual(
    [...MARK_ORDER],
    ['ended-unexpectedly', 'was-working', 'continued', 'expired', 'expiring', 'duplicate'],
  );
});

test('an expired session that also continued and had two holders has marks in order', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), start(P2, S1, T0 + SEC, 'resume')],
      isAlive: alive(P1, P2),
      links: [link(S3, S1, 'fork', T0)],
      transcripts: [tr(S1, { missingSinceNs: T0 })],
    },
    S1,
  );
  assert.deepEqual(s.marks, ['continued', 'expired', 'duplicate']);
});

// ---- the holding rules in the corners ---------------------------------------------------------

test('a process holds only the session of its latest event, not of an earlier one', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), start(P1, S2, T0 + SEC, 'resume')],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.equal(s.state, 'not-running');
  assert.deepEqual(s.holders, []);
});

test('a process whose latest event is an end holds nothing, alive or not', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), end(P1, S1, T0 + SEC, 'exit')],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.deepEqual(s.holders, []);
  assert.equal(s.state, 'not-running');
});

test('a session resumed in a new process after the old one ended: the old end is not the last holding', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        end(P1, S1, T0 + 10n * SEC, 'exit'),
        start(P2, S1, T0 + 20n * SEC, 'resume'),
      ],
      isAlive: alive(P2),
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.deepEqual(s.lastHolding, { process: P2, endedAtNs: null, endDetail: null, alive: true });
  assert.deepEqual(s.marks, []);
});

test('events are ordered by time first: a later event with a smaller id is still the latest', () => {
  const late = start(P1, S1, T0 + 10n * SEC, 'startup');
  const early = start(P2, S1, T0, 'resume');
  assert.ok(late.id < early.id);
  const s = session({ events: [late, early], isAlive: alive(P1, P2) }, S1);
  assert.deepEqual(
    s.holders.map((h) => h.process),
    [P1, P2],
  );
  assert.deepEqual(s.lastHolding?.process, P1);
});

test('the last holding is the process of the latest event, ties broken by id', () => {
  const t = T0 + 5n * SEC;
  const first = start(P1, S1, t, 'startup');
  const second = start(P2, S1, t, 'resume');
  assert.ok(first.id < second.id);
  const s = session({ events: [second, first] }, S1);
  assert.deepEqual(s.lastHolding?.process, P2);
});

// ---- the last holding across several processes: the one that ended last -----------------------

test('two holders: the earlier exits deliberately, the later is killed afterwards: ended unexpectedly', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        start(P2, S1, T0 + 30n * SEC, 'resume'), // duplicate
        end(P1, S1, T0 + 60n * SEC, 'exit'),
      ],
      // P2 wrote its live file after P1's exit, then was killed: its file is left behind.
      liveFiles: [live(P2, S1, 'idle', { mtimeNs: T0 + 90n * SEC })],
    },
    S1,
  );
  assert.equal(s.state, 'not-running');
  assert.deepEqual(s.lastHolding, { process: P2, endedAtNs: null, endDetail: null, alive: false });
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
});

test('two holders: the later exits deliberately, the earlier is killed afterwards: ended unexpectedly', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        start(P2, S1, T0 + 30n * SEC, 'resume'),
        end(P2, S1, T0 + 60n * SEC, 'exit'),
      ],
      liveFiles: [live(P1, S1, 'busy', { mtimeNs: T0 + 90n * SEC })],
    },
    S1,
  );
  assert.deepEqual(s.lastHolding, { process: P1, endedAtNs: null, endDetail: null, alive: false });
  assert.deepEqual(s.marks, ['ended-unexpectedly', 'was-working']);
});

test('a holder killed before another holder exits deliberately: the exit ended last, no mark', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        start(P2, S1, T0 + 30n * SEC, 'resume'),
        end(P2, S1, T0 + 60n * SEC, 'exit'),
      ],
      liveFiles: [live(P1, S1, 'idle', { mtimeNs: T0 + 10n * SEC })], // last seen before the exit
    },
    S1,
  );
  assert.deepEqual(s.lastHolding, {
    process: P2,
    endedAtNs: T0 + 60n * SEC,
    endDetail: 'exit',
    alive: false,
  });
  assert.deepEqual(s.marks, []);
});

test('a crash, then a resume in a new process that exits deliberately: no mark', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        start(P2, S1, T0 + 100n * SEC, 'resume'),
        end(P2, S1, T0 + 200n * SEC, 'exit'),
      ],
      liveFiles: [live(P1, S1, 'busy', { mtimeNs: T0 + 5n * SEC })],
    },
    S1,
  );
  assert.deepEqual(s.lastHolding?.process, P2);
  assert.deepEqual(s.marks, []);
});

test('a process that moved on left the session at its first later event, not at its latest', () => {
  const s = session(
    {
      events: [
        start(P2, S1, T0, 'startup'),
        start(P1, S1, T0 + 1n * SEC, 'resume'),
        observed(P1, S2, T0 + 5n * SEC), // P1 left S1 here
        observed(P1, S3, T0 + 50n * SEC),
      ],
      liveFiles: [live(P2, S1, 'idle', { mtimeNs: T0 + 20n * SEC })], // P2 seen after P1 left
    },
    S1,
  );
  assert.deepEqual(s.lastHolding, { process: P2, endedAtNs: null, endDetail: null, alive: false });
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
});

test('a move that reconcile noticed later ranks at the process’s last event for the session', () => {
  // P1 (no hook) was observed on S1; `claude --resume S1` ran elsewhere (P2), and P2 was killed;
  // the next refresh observed P1 on S2. The observed event's time is that refresh, not the move.
  const s = session(
    {
      events: [
        observed(P1, S1, T0),
        start(P2, S1, T0 + 10n * SEC, 'resume'),
        observed(P1, S2, T0 + 100n * SEC),
      ],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.deepEqual(s.lastHolding, { process: P2, endedAtNs: null, endDetail: null, alive: false });
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
});

test('a moved-on holding ends at the first event of the process after it', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        observed(P1, S2, T0 + 5n * SEC),
        observed(P1, S3, T0 + 50n * SEC),
      ],
    },
    S1,
  );
  assert.deepEqual(s.lastHolding, {
    process: P1,
    endedAtNs: T0 + 5n * SEC,
    endDetail: 'moved-on',
    alive: false,
  });
});

test('a live holder is the last holding, whatever ended later before', () => {
  const s = session(
    {
      events: [
        start(P1, S1, T0, 'startup'),
        start(P2, S1, T0 + 30n * SEC, 'resume'),
        end(P2, S1, T0 + 60n * SEC, 'other'),
      ],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.equal(s.state, 'running');
  assert.deepEqual(s.lastHolding, { process: P1, endedAtNs: null, endDetail: null, alive: true });
  assert.deepEqual(s.marks, []);
});

// ---- scripted runs of a known session (`claude -p --resume`, SDK runs) ------------------------

const P5: ProcessKey = { bootId: BOOT_A, pid: 5555, procStart: 500 };
/** What ingest keeps of a scripted start of a known session: no launch command, no name. */
const scripted = (p: ProcessKey, s: string, t: Ns): EventRow =>
  event(p, s, t, 'scripted', '', { rawDetail: 'resume', cwd: '/elsewhere' });

/** S1: an interactive run by P1 that ended deliberately, then a scripted run by P5. */
function scriptedAfterExit(): EventRow[] {
  return [
    start(P1, S1, T0, 'startup', ['claude', '--model', 'opus'], { cwd: '/project' }),
    end(P1, S1, T0 + 10n * SEC, 'exit'),
    scripted(P5, S1, T0 + 100n * SEC),
  ];
}

test('a live scripted run holds the session: running since its start, the guard sees a holder', () => {
  const events = scriptedAfterExit();
  const s = session({ events, isAlive: alive(P5) }, S1);
  assert.equal(s.state, 'running');
  assert.equal(s.sinceNs, T0 + 100n * SEC);
  assert.deepEqual(
    s.holders.map((h) => [h.process, h.scripted]),
    [[P5, true]],
  );
  assert.equal(s.lastEventId, events[2]?.id);
  assert.equal(s.lastActivityNs, T0 + 100n * SEC);
  assert.deepEqual(s.marks, []);
});

test('a scripted run and an interactive holder at once are a duplicate', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup'), scripted(P5, S1, T0 + 100n * SEC)],
      isAlive: alive(P1, P5),
    },
    S1,
  );
  assert.deepEqual(s.marks, ['duplicate']);
  assert.deepEqual(
    s.holders.map((h) => [h.process, h.scripted]),
    [
      [P5, true],
      [P1, false],
    ],
  );
});

test('a scripted run supplies neither the launch command nor the directory', () => {
  const s = session({ events: scriptedAfterExit(), isAlive: alive(P5) }, S1);
  assert.deepEqual(s.launch, ['claude', '--model', 'opus']);
  assert.equal(s.dir, '/project');
});

test('a scripted run that ends or is killed leaves no mark: the last interactive holding decides', async (t) => {
  await t.test('after a deliberate exit', () => {
    const s = session({ events: scriptedAfterExit() }, S1); // P5 is gone, no end recorded
    assert.equal(s.state, 'not-running');
    assert.deepEqual(s.lastHolding, {
      process: P1,
      endedAtNs: T0 + 10n * SEC,
      endDetail: 'exit',
      alive: false,
    });
    assert.deepEqual(s.marks, []);
  });
  await t.test('after a crash', () => {
    const events = [start(P1, S1, T0, 'startup'), scripted(P5, S1, T0 + 100n * SEC)];
    const s = session({ events, liveFiles: [live(P5, S1, 'busy')] }, S1);
    assert.deepEqual(s.lastHolding, {
      process: P1,
      endedAtNs: null,
      endDetail: null,
      alive: false,
    });
    assert.deepEqual(s.marks, ['ended-unexpectedly']);
  });
  await t.test('a session that only scripted runs ever held has no last holding', () => {
    const s = session({ events: [scripted(P5, S1, T0 + 100n * SEC)], transcripts: [tr(S1)] }, S1);
    assert.equal(s.lastHolding, null);
    assert.deepEqual(s.marks, []);
  });
});

const scriptedEnd = (p: ProcessKey, s: string, t: Ns): EventRow =>
  event(p, s, t, 'scripted-end', '', { rawDetail: 'clear' });

test('a scripted process that cleared or switched no longer holds the session it left', () => {
  const events = [...scriptedAfterExit(), scriptedEnd(P5, S1, T0 + 200n * SEC)];
  const s = session({ events, isAlive: alive(P5) }, S1);
  assert.equal(s.state, 'not-running');
  assert.deepEqual(s.holders, []);
  assert.deepEqual(s.lastHolding, {
    process: P1,
    endedAtNs: T0 + 10n * SEC,
    endDetail: 'exit',
    alive: false,
  });
  assert.deepEqual(s.marks, []);
  assert.equal(s.lastEventId, events[3]?.id);
});

test('a scripted process holds the known session it switched to, not the one it left', () => {
  const events = [
    ...scriptedAfterExit(),
    scriptedEnd(P5, S1, T0 + 200n * SEC),
    start(P2, S2, T0, 'startup'),
    end(P2, S2, T0 + 5n * SEC, 'exit'),
    scripted(P5, S2, T0 + 201n * SEC),
  ];
  assert.equal(session({ events, isAlive: alive(P5) }, S1).state, 'not-running');
  const second = session({ events, isAlive: alive(P5) }, S2);
  assert.deepEqual(
    second.holders.map((h) => [h.process, h.scripted]),
    [[P5, true]],
  );
});

test('a scripted end is never a last holding: a crash before it still marks the session', () => {
  const events = [
    start(P1, S1, T0, 'startup'),
    scripted(P5, S1, T0 + 100n * SEC),
    scriptedEnd(P5, S1, T0 + 200n * SEC),
  ];
  const s = session({ events }, S1);
  assert.deepEqual(s.lastHolding, { process: P1, endedAtNs: null, endDetail: null, alive: false });
  assert.deepEqual(s.marks, ['ended-unexpectedly']);
});

test('a scripted run is no activity after done: the session stays hidden', () => {
  const s = session(
    {
      events: scriptedAfterExit(),
      metas: [meta(S1, { doneAtNs: T0 + 50n * SEC })],
      isAlive: alive(P5),
    },
    S1,
  );
  assert.equal(s.hidden, true);
});

test('the directory of a scripted run is not the session’s, even when nothing else names one', () => {
  const s = session(
    { events: [scripted(P5, S1, T0 + 100n * SEC)], transcripts: [tr(S1, { firstCwd: null })] },
    S1,
  );
  assert.equal(s.dir, null);
});

// ---- the contract around the function ---------------------------------------------------------

test('events in any order give the same result as events in (time, id) order', () => {
  const events = [
    start(P1, S1, T0, 'startup', ['claude']),
    end(P1, S1, T0 + 60n * SEC, 'clear'),
    start(P1, S2, T0 + 60n * SEC + 200n * NS_PER_MS, 'clear', ['claude', '-c']),
  ];
  const links = [link(S1, S2, 'clear', T0 + 60n * SEC)];
  const ordered = derive({ events, links, isAlive: alive(P1) });
  const shuffled = derive({
    events: [events[2]!, events[0]!, events[1]!],
    links,
    isAlive: alive(P1),
  });
  assert.deepEqual(shuffled, ordered);
});

test('the input is not changed, and a second run gives the same result', () => {
  const events = Object.freeze([
    start(P1, S1, T0, 'startup', ['claude']),
    end(P1, S1, T0 + 60n * SEC, 'clear'),
    start(P1, S2, T0 + 61n * SEC, 'clear'),
  ]);
  const links = Object.freeze([link(S1, S2, 'clear', T0 + 60n * SEC)]);
  const transcripts = Object.freeze([tr(S1), tr(S1, { path: '/other.jsonl' }), tr(S2)]);
  const metas = Object.freeze([meta(S1, { doneAtNs: DONE })]);
  const liveFiles = Object.freeze([live(P1, S2, 'busy')]);
  const input: DeriveInput = {
    events,
    links,
    transcripts,
    metas,
    liveFiles,
    bootId: BOOT_A,
    isAlive: alive(P1),
    isTrusted: () => true,
    nowNs: NOW,
    retentionDays: 30,
  };
  const before = structuredClone({ events, links, transcripts, metas, liveFiles });
  const first = deriveSessions(input);
  const second = deriveSessions(input);
  assert.deepEqual(second, first);
  assert.deepEqual({ events, links, transcripts, metas, liveFiles }, before);
});

test('the clock is the input: the same facts a day later expire', () => {
  const given: Given = { transcripts: [tr(S1, { mtimeNs: NOW - 24n * DAY })] };
  assert.deepEqual(session(given, S1).marks, []);
  assert.deepEqual(session({ ...given, nowNs: NOW + 2n * DAY }, S1).marks, ['expiring']);
});

test('every derived session carries the fields of the contract', () => {
  const s = session(
    {
      events: [start(P1, S1, T0, 'startup')],
      transcripts: [tr(S1, { lastRecordNs: T0 + SEC })],
      isAlive: alive(P1),
    },
    S1,
  );
  assert.deepEqual(Object.keys(s).sort(), [
    'bootId',
    'continuedFrom',
    'dir',
    'doneAtNs',
    'firstSeenNs',
    'hidden',
    'holders',
    'id',
    'lastActivityNs',
    'lastEventId',
    'lastHolding',
    'launch',
    'marks',
    'sinceNs',
    'state',
    'stateDetail',
    'transcript',
  ]);
  assert.equal(s.transcript?.sessionId, S1);
});
