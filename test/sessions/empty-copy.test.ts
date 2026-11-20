// Follow-up F33 (design 6.3, 7.2, 7.8): a session with a copy link whose transcript has no turn and
// no input is an EMPTY COPY — marked `empty-copy` besides `continued`, not listed but where done
// sessions are (`--all`), never offered by restore; at its first turn or input it is an ordinary
// continued session. An ordinary session with such a transcript (no copy link) is listed as before.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { LiveFile, ProcessKey } from '../../src/claude/live.ts';
import type { Ns } from '../../src/platform/types.ts';
import { deriveSessions } from '../../src/sessions/derive.ts';
import type { DeriveInput } from '../../src/sessions/derive.ts';
import { buildList, flatRows, isHiddenCopy, isListed } from '../../src/sessions/list.ts';
import { planRestore } from '../../src/sessions/restore.ts';
import type { DerivedSession } from '../../src/sessions/types.ts';
import type { EventRow, LinkRow, TranscriptRow } from '../../src/store/types.ts';
import { attached, ds, meta, prRow, rows, transcriptRow } from '../helpers/derived.ts';
import { BOOT_A, BOOT_B, S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';

const ORIGINAL = S2;
const COPY = S1;
const P1: ProcessKey = { bootId: BOOT_A, pid: 4242, procStart: 100 };
const NOW: Ns = T0 + 600n * SEC;

/** A transcript that holds only a title: no turn, no input. */
const TITLE_ONLY: Partial<TranscriptRow> = {
  aiTitle: 'made-up title',
  lastUserNs: null,
  lastTurnRole: null,
};

function startOf(sessionId: string, timeNs: Ns, id: number, p: ProcessKey = P1): EventRow {
  return {
    id,
    spoolName: `${id}.ev`,
    timeNs,
    kind: 'start',
    detail: 'startup',
    rawDetail: 'startup',
    sessionId,
    bootId: p.bootId,
    pid: p.pid,
    procStart: p.procStart,
    cwd: '/home/dev/projects/demo',
    argv: ['claude', '--permission-mode', 'auto'],
    name: null,
    payload: null,
  };
}

/** The deliberate exit of `p`'s holding of the session: no `ended-unexpectedly` mark. */
function exitOf(sessionId: string, timeNs: Ns, id: number, p: ProcessKey = P1): EventRow {
  return {
    ...startOf(sessionId, timeNs, id, p),
    spoolName: `${id}.ev`,
    kind: 'end',
    detail: 'exit',
    rawDetail: 'prompt_input_exit',
    argv: null,
  };
}

function link(kind: LinkRow['kind'], from: string, to: string, eventId: number): LinkRow {
  return { eventId, fromSession: from, toSession: to, kind, timeNs: T0 };
}

function derive(over: Partial<DeriveInput>): DerivedSession[] {
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
    ...over,
  });
}

function one(sessions: DerivedSession[], id: string): DerivedSession {
  const found = sessions.find((session) => session.id === id);
  assert.ok(found, `no session ${id}`);
  return found;
}

/** The copy S1 of S2 (its start, the copy link, `copy` its transcript), and S2 itself. */
function copyOf(transcript: Partial<TranscriptRow> | null, alive = false): DerivedSession[] {
  const other = { ...P1, pid: 99 };
  return derive({
    events: [
      startOf(ORIGINAL, T0 - 100n * SEC, 1, other),
      exitOf(ORIGINAL, T0 - 90n * SEC, 3, other),
      startOf(COPY, T0, 2),
      ...(alive ? [] : [exitOf(COPY, T0 + 2n * SEC, 4)]),
    ],
    links: [link('copy', ORIGINAL, COPY, 2)],
    transcripts: [
      transcriptRow(ORIGINAL, { aiTitle: 'made-up title' }),
      ...(transcript === null ? [] : [transcriptRow(COPY, transcript)]),
    ],
    isAlive: (p) => alive && p.pid === P1.pid,
  });
}

describe('derive: the empty-copy mark and copyOf', () => {
  test('a copy with a title-only transcript: continued from the original, marked empty-copy', () => {
    const copy = one(copyOf(TITLE_ONLY), COPY);
    assert.deepEqual(copy.marks, ['continued', 'empty-copy']);
    assert.equal(copy.continuedFrom, ORIGINAL);
    assert.equal(copy.copyOf, ORIGINAL);
  });

  test('a running copy with no transcript yet is empty too; it stays running (its holder is untouched)', () => {
    const copy = one(copyOf(null, true), COPY);
    assert.deepEqual(copy.marks, ['continued', 'empty-copy']);
    assert.equal(copy.state, 'running');
    assert.deepEqual(
      copy.holders.map((holder) => holder.process.pid),
      [P1.pid],
    );
  });

  test('after its first turn, or its first input, it is an ordinary continued session', () => {
    for (const used of [
      { lastTurnRole: 'user' as const },
      { lastTurnRole: 'assistant' as const },
      { lastUserNs: T0 + SEC },
    ]) {
      const copy = one(copyOf({ ...TITLE_ONLY, ...used }), COPY);
      assert.deepEqual(copy.marks, ['continued'], JSON.stringify(Object.keys(used)));
      assert.equal(copy.continuedFrom, ORIGINAL);
      assert.equal(copy.copyOf, ORIGINAL);
    }
  });

  test('the original is unchanged: no mark, no copyOf', () => {
    const original = one(copyOf(TITLE_ONLY), ORIGINAL);
    assert.deepEqual(original.marks, []);
    assert.equal(original.continuedFrom, null);
    assert.equal(Object.hasOwn(original, 'copyOf'), false);
  });

  test('an ORDINARY session with a title-only transcript (no copy link): no mark, no copyOf', () => {
    const plain = one(
      derive({
        events: [startOf(COPY, T0, 1), exitOf(COPY, T0 + SEC, 2)],
        transcripts: [transcriptRow(COPY, TITLE_ONLY)],
      }),
      COPY,
    );
    assert.deepEqual(plain.marks, []);
    assert.equal(Object.hasOwn(plain, 'copyOf'), false);
  });

  test('a clear or fork link with a title-only transcript is no copy: continued only', () => {
    for (const kind of ['clear', 'fork'] as const) {
      const s = one(
        derive({
          events: [startOf(ORIGINAL, T0 - SEC, 1), startOf(COPY, T0, 2), exitOf(COPY, T0 + SEC, 3)],
          links: [link(kind, ORIGINAL, COPY, 2)],
          transcripts: [transcriptRow(COPY, TITLE_ONLY)],
        }),
        COPY,
      );
      assert.deepEqual(s.marks, ['continued'], kind);
      assert.equal(Object.hasOwn(s, 'copyOf'), false, kind);
    }
  });

  test('a copy of a session skydeck does not know is a copy all the same', () => {
    const copy = one(
      derive({
        events: [startOf(COPY, T0, 1), exitOf(COPY, T0 + SEC, 2)],
        links: [link('copy', S3, COPY, 1)],
        transcripts: [transcriptRow(COPY, TITLE_ONLY)],
      }),
      COPY,
    );
    assert.deepEqual(copy.marks, ['continued', 'empty-copy']);
    assert.equal(copy.copyOf, S3);
  });
});

/** The copy's process P1 alive, its trusted live file saying `status` (null: no live file at all). */
function runningCopy(status: string | null): DerivedSession {
  const file: LiveFile = {
    pid: P1.pid,
    sessionId: COPY,
    cwd: '/home/dev/projects/demo',
    procStart: P1.procStart,
    entrypoint: 'cli',
    name: null,
    status,
    waitingFor: status === 'waiting' ? 'a permission' : null,
    updatedAtNs: T0,
    statusUpdatedAtNs: T0,
    mtimeNs: T0,
  };
  return one(
    derive({
      events: [startOf(COPY, T0, 1)],
      links: [link('copy', ORIGINAL, COPY, 1)],
      transcripts: [transcriptRow(COPY, TITLE_ONLY)],
      liveFiles: status === null ? [] : [file],
      isAlive: (p) => p.pid === P1.pid,
    }),
    COPY,
  );
}

describe('derive (ruled): a copy that works or asks is in use, whatever its transcript says yet', () => {
  test('its live file says busy: working, continued, not empty', () => {
    const copy = runningCopy('busy');
    assert.equal(copy.state, 'working');
    assert.deepEqual(copy.marks, ['continued']);
  });

  test('its live file says waiting (a question: a permission, a choice): not empty', () => {
    const copy = runningCopy('waiting');
    assert.equal(copy.state, 'waiting');
    assert.equal(copy.stateDetail, 'a permission');
    assert.deepEqual(copy.marks, ['continued']);
  });

  test('idle at its first prompt, or no live file that says more: empty', () => {
    assert.deepEqual(runningCopy('idle').marks, ['continued', 'empty-copy']);
    const unknown = runningCopy(null);
    assert.equal(unknown.state, 'running');
    assert.deepEqual(unknown.marks, ['continued', 'empty-copy']);
  });

  test('once its process has stopped working, an empty transcript makes it empty again', () => {
    assert.deepEqual(one(copyOf(TITLE_ONLY), COPY).marks, ['continued', 'empty-copy']);
  });
});

describe('list (ruled): an empty copy that carries what only the user can set is listed as any', () => {
  const copy = (): DerivedSession => one(copyOf(TITLE_ONLY), COPY);
  const pr = prRow('acme/web', 7);
  const cases: [string, Parameters<typeof rows>[1]][] = [
    ['a label', { metas: [meta(COPY, { label: 'mine' })] }],
    ['a group the user set', { metas: [meta(COPY, { group: 'mine' })] }],
    ['a note', { metas: [meta(COPY, { note: 'remember this' })] }],
    ['a ticket', { metas: [meta(COPY, { ticket: 'https://example.com/browse/ABC-123' })] }],
    [
      'a pull request attached by hand',
      { prs: [pr], sessionPrs: [attached(COPY, pr, { origin: 'manual' })] },
    ],
  ];
  for (const [what, extra] of cases) {
    test(`${what}: listed without showAll, its marks kept`, () => {
      const [row] = rows([copy()], extra);
      assert.ok(row);
      assert.equal(row.copyOf?.keptByUser, true);
      assert.equal(isHiddenCopy(row), false);
      assert.equal(isListed(row, false), true);
      assert.deepEqual(row.marks, ['continued', 'empty-copy']);
    });
  }

  test('a pull request skydeck attached by itself from a pr-link record (maybe copied with the title): hidden', () => {
    const [row] = rows([copy()], { prs: [pr], sessionPrs: [attached(COPY, pr)] });
    assert.ok(row);
    assert.equal(row.prs.length, 1, 'attached, with its chip');
    assert.equal(row.copyOf?.keptByUser, false);
    assert.equal(isHiddenCopy(row), true);
    assert.equal(isListed(row, false), false);
    assert.equal(isListed(row, true), true);
  });

  test('a pull request attached by hand and detached again keeps nothing: hidden', () => {
    const [row] = rows([copy()], {
      prs: [pr],
      sessionPrs: [attached(COPY, pr, { origin: 'manual', detachedAtNs: T0 })],
    });
    assert.equal(row === undefined ? null : isListed(row, false), false);
  });

  test('an expired session keeps its rule: an auto pull request still keeps it listed', () => {
    const [row] = rows([ds({ id: S3, marks: ['expired'], transcript: { missingSinceNs: T0 } })], {
      prs: [pr],
      sessionPrs: [attached(S3, pr)],
    });
    assert.equal(row === undefined ? null : isListed(row, false), true);
  });

  test('a group the title gives (a ticket key copied with the title) is not the user’s: hidden', () => {
    const [row] = rows([
      one(
        derive({
          events: [startOf(COPY, T0, 1), exitOf(COPY, T0 + SEC, 2)],
          links: [link('copy', ORIGINAL, COPY, 1)],
          transcripts: [transcriptRow(COPY, { ...TITLE_ONLY, aiTitle: 'ABC-123 made-up title' })],
        }),
        COPY,
      ),
    ]);
    assert.equal(row?.group, 'ABC-123');
    assert.equal(row?.groupSource, 'title');
    assert.equal(row === undefined ? null : isListed(row, false), false);
  });
});

describe('list: an empty copy is listed where done sessions are', () => {
  test('not by default, with showAll yes, and whenever a terminal of the window shows it', () => {
    const [copy] = rows([one(copyOf(TITLE_ONLY), COPY)]);
    assert.ok(copy);
    assert.equal(isListed(copy, false), false);
    assert.equal(isListed(copy, true), true);
    assert.equal(isListed(copy, false, true), true, 'shown in the window: never hidden');
  });

  test('a running empty copy is hidden too: hiding is a matter of the list only', () => {
    const [copy] = rows([one(copyOf(null, true), COPY)]);
    assert.ok(copy);
    assert.equal(copy.state, 'running');
    assert.equal(isListed(copy, false), false);
    assert.equal(isListed(copy, true), true);
  });

  test('buildList (ls, the interactive list): hidden without showAll, shown with it, with its marks', () => {
    const listRows = rows(copyOf(TITLE_ONLY));
    const ids = (showAll: boolean) =>
      flatRows(buildList(listRows, { showAll, filter: '', nowNs: NOW })).map((row) => row.id);
    assert.deepEqual(ids(false), [ORIGINAL]);
    assert.deepEqual(ids(true).sort(), [ORIGINAL, COPY].sort());
  });

  test('once used, listed by the usual rules, marked continued', () => {
    const [copy] = rows([one(copyOf({ ...TITLE_ONLY, lastTurnRole: 'user' }), COPY)]);
    assert.ok(copy);
    assert.equal(isListed(copy, false), true);
    assert.deepEqual(copy.marks, ['continued']);
  });

  test('an ordinary session with a title-only transcript is listed as today', () => {
    const [plain] = rows([ds({ id: COPY, transcript: TITLE_ONLY })]);
    assert.ok(plain);
    assert.equal(isListed(plain, false), true);
  });

  test('done and undone: a done empty copy is hidden as a done one; undone, it stays hidden while empty', () => {
    const session = one(copyOf(TITLE_ONLY), COPY);
    const [done] = rows([{ ...session, doneAtNs: T0, hidden: true }], {
      metas: [meta(COPY, { doneAtNs: T0 })],
    });
    assert.ok(done);
    assert.equal(isListed(done, false), false);
    assert.equal(isListed(done, true), true);
    const [undone] = rows([session]);
    assert.ok(undone);
    assert.equal(isListed(undone, false), false, 'still empty: still hidden');
  });

  test('the row names its original: id and title; the title null for an original skydeck does not know', () => {
    const listRows = rows(copyOf(TITLE_ONLY));
    const copy = listRows.find((row) => row.id === COPY);
    assert.deepEqual(copy?.copyOf, { id: ORIGINAL, title: 'made-up title', keptByUser: false });
    assert.equal(Object.hasOwn(listRows.find((row) => row.id === ORIGINAL) ?? {}, 'copyOf'), false);

    const [orphan] = rows([
      one(
        derive({
          events: [startOf(COPY, T0, 1)],
          links: [link('copy', S3, COPY, 1)],
          transcripts: [transcriptRow(COPY, TITLE_ONLY)],
        }),
        COPY,
      ),
    ]);
    assert.deepEqual(orphan?.copyOf, { id: S3, title: null, keptByUser: false });
  });
});

describe('restore: an empty copy is never offered (it has nothing to restore)', () => {
  /** S1 and S3 ended unexpectedly in BOOT_A; S1 is an empty copy, S3 an ordinary session. */
  function crashed(copyTranscript: Partial<TranscriptRow>) {
    const events = [startOf(COPY, T0, 1), startOf(S3, T0, 2, { ...P1, pid: 77 })];
    const sessions = derive({
      events,
      links: [link('copy', ORIGINAL, COPY, 1)],
      transcripts: [transcriptRow(COPY, copyTranscript), transcriptRow(S3)],
      bootId: BOOT_B,
    });
    return { listRows: rows(sessions), events };
  }

  test('the default set and --all leave it out; the ordinary one is offered', () => {
    const { listRows, events } = crashed(TITLE_ONLY);
    const copy = listRows.find((row) => row.id === COPY);
    assert.deepEqual(copy?.marks, ['ended-unexpectedly', 'continued', 'empty-copy']);
    for (const all of [false, true]) {
      assert.deepEqual(
        planRestore(listRows, events, BOOT_B, all).map((entry) => entry.row.id),
        [S3],
        `all ${all}`,
      );
    }
  });

  test('a used copy that ended unexpectedly is offered as any session', () => {
    const { listRows, events } = crashed({ ...TITLE_ONLY, lastTurnRole: 'assistant' });
    assert.deepEqual(
      planRestore(listRows, events, BOOT_B, false)
        .map((entry) => entry.row.id)
        .sort(),
      [COPY, S3].sort(),
    );
  });
});
