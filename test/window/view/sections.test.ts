import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type { RowPayload } from '../../../src/window/protocol.ts';
import { windowChip } from '../../../src/window/view/chip.ts';
import { projectDirs, rowPayload, sectionOf } from '../../../src/window/view/sections.ts';
import { attached, ds, meta, prRow, rowOf, rows } from '../../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

const NOW = T0;
const TERM = '0123456789ab';

/** A terminal of the window showing `sessionId` (a resume, slot 1, running). */
function term(over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: TERM,
    slot: 1,
    state: 'running',
    expectedSessionId: S1,
    sessionId: S1,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 4242, procStart: 100 },
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

const NONE = { terminal: null, elsewhere: null } as const;

// --- sectionOf ---------------------------------------------------------------------------------

test('sectionOf: an open row is in Open, however old its last activity', () => {
  const row = rowOf(ds({ id: S1, lastActivityNs: NOW - 400n * NS_PER_DAY }));
  assert.equal(sectionOf(row, NOW, true), 'open');
});

test('sectionOf: a row that is not open and was active within 7 days is in Recent', () => {
  assert.equal(sectionOf(rowOf(ds({ id: S1, lastActivityNs: NOW })), NOW, false), 'week');
  assert.equal(
    sectionOf(rowOf(ds({ id: S1, lastActivityNs: NOW - 3n * NS_PER_DAY })), NOW, false),
    'week',
  );
});

test('sectionOf: exactly 7 days ago is still Recent; a nanosecond more is Earlier', () => {
  const week = rowOf(ds({ id: S1, lastActivityNs: NOW - 7n * NS_PER_DAY }));
  const older = rowOf(ds({ id: S1, lastActivityNs: NOW - 7n * NS_PER_DAY - 1n }));
  assert.equal(sectionOf(week, NOW, false), 'week');
  assert.equal(sectionOf(older, NOW, false), 'earlier');
});

test('sectionOf: a last activity after now (the clock stepped back) is Recent', () => {
  const row = rowOf(ds({ id: S1, lastActivityNs: NOW + 60n * SEC }));
  assert.equal(sectionOf(row, NOW, false), 'week');
});

// --- rowPayload --------------------------------------------------------------------------------

test("rowPayload: carries the list row's display fields, times as decimal strings", () => {
  const session = ds({
    id: S1,
    state: 'waiting',
    stateDetail: 'permission',
    sinceNs: T0 - 5n * SEC,
    lastActivityNs: T0 - 2n * SEC,
    marks: ['duplicate'],
    transcript: { aiTitle: 'ABC-12 make it work' },
  });
  const payload = rowPayload(rowOf(session), NONE);
  assert.equal(payload.id, S1);
  assert.equal(payload.shortId, S1.slice(0, 8));
  assert.equal(payload.title, 'ABC-12 make it work');
  assert.equal(payload.titleSource, 'generated');
  assert.equal(payload.group, 'ABC-12');
  assert.equal(payload.groupSource, 'title');
  assert.equal(payload.state, 'waiting');
  assert.equal(payload.stateDetail, 'permission');
  assert.equal(payload.sinceNs, String(T0 - 5n * SEC));
  assert.equal(payload.lastActivityNs, String(T0 - 2n * SEC));
  assert.equal(payload.dir, '/home/dev/projects/demo');
  assert.deepEqual(payload.marks, ['duplicate']);
  assert.equal(payload.done, false);
  assert.equal(payload.hasNote, false);
  assert.deepEqual(payload.noteHead, []);
});

test('rowPayload: has exactly the fields of RowPayload — no note text, no session, no label', () => {
  const row = rowOf(ds({ id: S1 }), { metas: [meta(S1, { label: 'x', note: 'secret\nmore' })] });
  const keys: (keyof RowPayload)[] = [
    'id',
    'shortId',
    'title',
    'titleSource',
    'group',
    'groupSource',
    'state',
    'stateDetail',
    'sinceNs',
    'lastActivityNs',
    'dir',
    'marks',
    'hasNote',
    'noteHead',
    'done',
    'prs',
    'chip',
    'terminal',
    'slot',
    'elsewhere',
    'starting',
    'attention',
    'stack',
    'ticketStatus', // F19: the ticket's status while one is known, else null
  ];
  assert.deepEqual(Object.keys(rowPayload(row, NONE)).sort(), [...keys].sort());
});

test('rowPayload: survives JSON unchanged (no bigint, nothing shared with the row)', () => {
  const pr = prRow('acme/web', 7);
  const row = rowOf(ds({ id: S1 }), { prs: [pr], sessionPrs: [attached(S1, pr)] });
  const payload = rowPayload(row, { terminal: term(), elsewhere: null });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  payload.marks.push('expired');
  assert.deepEqual(row.marks, []);
});

test('rowPayload: done is the row’s done', () => {
  const row = rowOf(ds({ id: S1, hidden: true, doneAtNs: T0 }));
  assert.equal(rowPayload(row, NONE).done, true);
});

test('rowPayload: noteHead is at most the first three lines, each sanitised', () => {
  const note = 'first\nsecond \x1b[31mred\x1b[0m\r\nthird\rfourth\nfifth';
  const row = rowOf(ds({ id: S1 }), { metas: [meta(S1, { note })] });
  const payload = rowPayload(row, NONE);
  assert.equal(payload.hasNote, true);
  assert.deepEqual(payload.noteHead, ['first', 'second red', 'third']);
});

test('rowPayload: noteHead skips empty lines at the start, as show prints a note', () => {
  const note = '\n  \n\x07\nreal start\n\nafter a gap\nthird\nfourth';
  const row = rowOf(ds({ id: S1 }), { metas: [meta(S1, { note })] });
  assert.deepEqual(rowPayload(row, NONE).noteHead, ['real start', '', 'after a gap']);
});

test('rowPayload: a note line longer than 1,024 UTF-16 units is cut, the cut marked with …', () => {
  const long = 'x'.repeat(5000);
  const exact = 'y'.repeat(1024);
  const row = rowOf(ds({ id: S1 }), { metas: [meta(S1, { note: `${long}\n${exact}\nshort` })] });
  const [first, second, third] = rowPayload(row, NONE).noteHead;
  assert.equal(first, `${'x'.repeat(1023)}…`);
  assert.equal(first?.length, 1024);
  assert.equal(second, exact);
  assert.equal(third, 'short');
});

test('rowPayload: a cut note line never splits a surrogate pair', () => {
  // 1,022 units, then an emoji (two units) that would straddle the cut at 1,023.
  const note = `${'a'.repeat(1022)}😀😀😀`;
  const row = rowOf(ds({ id: S1 }), { metas: [meta(S1, { note })] });
  const [line] = rowPayload(row, NONE).noteHead;
  assert.equal(line, `${'a'.repeat(1022)}…`);
  assert.equal(line?.isWellFormed(), true);
});

test('rowPayload: the cap counts what is left once a line is sanitised', () => {
  const note = `${'\x1b[31m'.repeat(400)}${'z'.repeat(1000)}`;
  const row = rowOf(ds({ id: S1 }), { metas: [meta(S1, { note })] });
  assert.deepEqual(rowPayload(row, NONE).noteHead, ['z'.repeat(1000)]);
});

test('rowPayload: a note of one line gives one line; no note gives none', () => {
  const one = rowOf(ds({ id: S1 }), { metas: [meta(S1, { note: 'only\n\n' })] });
  assert.deepEqual(rowPayload(one, NONE).noteHead, ['only']);
  const none = rowOf(ds({ id: S2 }));
  assert.equal(rowPayload(none, NONE).hasNote, false);
  assert.deepEqual(rowPayload(none, NONE).noteHead, []);
});

test("rowPayload: pull requests with their level and last read; the chip is S2 12.3's (windowChip)", () => {
  const failing = prRow('acme/web', 7, { checks: 'failing', title: 'Fix it' });
  const merged = prRow('acme/api', 30, { state: 'merged', okAtNs: T0 - 5n * SEC });
  const unreadable = prRow('acme/db', 3, { error: 'HTTP 502', okAtNs: null });
  const prs = [failing, merged, unreadable];
  const row = rowOf(ds({ id: S1 }), {
    prs,
    sessionPrs: prs.map((pr) => attached(S1, pr)),
  });
  const payload = rowPayload(row, NONE);
  assert.deepEqual(payload.prs, [
    {
      url: 'https://github.com/acme/api/pull/30',
      repo: 'acme/api',
      number: 30,
      title: 'A pull request',
      level: 'merged',
      error: null,
      okAtNs: String(T0 - 5n * SEC),
    },
    {
      url: 'https://github.com/acme/db/pull/3',
      repo: 'acme/db',
      number: 3,
      title: 'A pull request',
      level: 'cant-read',
      error: 'HTTP 502',
      okAtNs: null,
    },
    {
      url: 'https://github.com/acme/web/pull/7',
      repo: 'acme/web',
      number: 7,
      title: 'Fix it',
      level: 'checks-failing',
      error: null,
      okAtNs: String(T0),
    },
  ]);
  assert.deepEqual(payload.chip, windowChip(payload.prs));
  assert.deepEqual(payload.chip, { level: 'cant-read', open: 2, merged: 1 });
  // Not design 7.3's chip of `ls` (the worst of all, all counted), which the row also has.
  assert.deepEqual(row.chip, { level: 'cant-read', count: 3 });
});

test("rowPayload: the chip of finished pull requests only is S2 12.3's, not design 7.3's", () => {
  const prs = [
    prRow('acme/api', 30, { state: 'merged' }),
    prRow('acme/api', 31, { state: 'merged' }),
    prRow('acme/api', 32, { state: 'closed' }),
  ];
  const row = rowOf(ds({ id: S1 }), { prs, sessionPrs: prs.map((pr) => attached(S1, pr)) });
  assert.deepEqual(rowPayload(row, NONE).chip, { level: 'merged', open: 0, merged: 2 });
  const closed = [prRow('acme/api', 33, { state: 'closed' })];
  const only = rowOf(ds({ id: S1 }), { prs: closed, sessionPrs: [attached(S1, closed[0]!)] });
  assert.deepEqual(rowPayload(only, NONE).chip, { level: 'closed', open: 0, merged: 0 });
});

test('rowPayload: a detached pull request is neither listed nor counted in the chip', () => {
  const kept = prRow('acme/web', 7);
  const gone = prRow('acme/web', 8, { checks: 'failing' });
  const row = rowOf(ds({ id: S1 }), {
    prs: [kept, gone],
    sessionPrs: [attached(S1, kept), attached(S1, gone, { detachedAtNs: T0 })],
  });
  const payload = rowPayload(row, NONE);
  assert.deepEqual(
    payload.prs.map((pr) => pr.number),
    [7],
  );
  assert.deepEqual(payload.chip, { level: 'approved-green', open: 1, merged: 0 });
});

test('rowPayload: no pull request, no chip', () => {
  const payload = rowPayload(rowOf(ds({ id: S1 })), NONE);
  assert.deepEqual(payload.prs, []);
  assert.equal(payload.chip, null);
});

test('rowPayload: terminal and slot come from the terminal', () => {
  const running = ds({ id: S1, state: 'working' });
  const payload = rowPayload(rowOf(running), { terminal: term({ slot: 3 }), elsewhere: null });
  assert.equal(payload.terminal, TERM);
  assert.equal(payload.slot, 3);
  assert.equal(payload.starting, false);
  const noSlot = rowPayload(rowOf(running), { terminal: term({ slot: null }), elsewhere: null });
  assert.equal(noSlot.terminal, TERM);
  assert.equal(noSlot.slot, null);
});

test('rowPayload: without a terminal, no terminal and no slot', () => {
  const payload = rowPayload(rowOf(ds({ id: S1 })), NONE);
  assert.equal(payload.terminal, null);
  assert.equal(payload.slot, null);
  assert.equal(payload.starting, false);
});

test("rowPayload: elsewhere carries the holder's pid and tty and the row's directory", () => {
  const row = rowOf(ds({ id: S1, state: 'running' }));
  const payload = rowPayload(row, { terminal: null, elsewhere: { pid: 777, tty: '/dev/pts/4' } });
  assert.deepEqual(payload.elsewhere, {
    pid: 777,
    tty: '/dev/pts/4',
    dir: '/home/dev/projects/demo',
  });
  const noTty = rowPayload(row, { terminal: null, elsewhere: { pid: 777, tty: null } });
  assert.deepEqual(noTty.elsewhere, { pid: 777, tty: null, dir: '/home/dev/projects/demo' });
  assert.equal(rowPayload(row, NONE).elsewhere, null);
});

test("rowPayload: the elsewhere holder's terminal device is sanitised", () => {
  const row = rowOf(ds({ id: S1, state: 'running' }));
  const payload = rowPayload(row, {
    terminal: null,
    elsewhere: { pid: 777, tty: '/dev/pts/4\x1b]0;x\x07\x1b[2J' },
  });
  assert.equal(payload.elsewhere?.tty, '/dev/pts/4');
});

test('rowPayload: attention and stack are null in stage A', () => {
  const payload = rowPayload(rowOf(ds({ id: S1 })), NONE);
  assert.equal(payload.attention, null);
  assert.equal(payload.stack, null);
});

test('rowPayload: a terminal whose program holds no session yet makes its row starting', () => {
  const row = rowOf(ds({ id: S1 }));
  for (const state of ['starting', 'running', 'reconnecting', 'newer-keeper'] as const) {
    const payload = rowPayload(row, {
      terminal: term({ sessionId: null, state }),
      elsewhere: null,
    });
    assert.equal(payload.starting, true, state);
    assert.equal(payload.terminal, TERM);
  }
});

test('rowPayload: a terminal that ended before its program held the session is not starting', () => {
  const row = rowOf(ds({ id: S1 }));
  for (const state of ['ended', 'lost', 'not-started'] as const) {
    const payload = rowPayload(row, {
      terminal: term({ sessionId: null, state }),
      elsewhere: null,
    });
    assert.equal(payload.starting, false, state);
    assert.equal(payload.terminal, TERM, state);
  }
});

test('rowPayload: a running row is never starting', () => {
  const row = rowOf(ds({ id: S1, state: 'running' }));
  const payload = rowPayload(row, { terminal: term({ sessionId: null }), elsewhere: null });
  assert.equal(payload.starting, false);
});

// --- projectDirs -------------------------------------------------------------------------------

test('projectDirs: unique, the most recently active first', () => {
  const list = rows([
    ds({ id: S1, dir: '/home/dev/a', lastActivityNs: T0 }),
    ds({ id: S2, dir: '/home/dev/b', lastActivityNs: T0 + 2n * SEC }),
    ds({ id: S3, dir: '/home/dev/a', lastActivityNs: T0 + 3n * SEC }),
  ]);
  assert.deepEqual(projectDirs(list), ['/home/dev/a', '/home/dev/b']);
});

test('projectDirs: directories active at the same time are ordered by name', () => {
  const list = rows([
    ds({ id: S1, dir: '/home/dev/zeta' }),
    ds({ id: S2, dir: '/home/dev/alpha' }),
  ]);
  assert.deepEqual(projectDirs(list), ['/home/dev/alpha', '/home/dev/zeta']);
});

test('projectDirs: a session without a directory offers none', () => {
  const list = rows([ds({ id: S1, dir: null }), ds({ id: S2, dir: '/home/dev/b' })]);
  assert.deepEqual(projectDirs(list), ['/home/dev/b']);
});

test('projectDirs: a directory the sanitiser changes is not offered', () => {
  const list = rows([
    ds({ id: S1, dir: '/home/dev/evil\x1b[2Jdir', lastActivityNs: T0 + SEC }),
    ds({ id: S2, dir: '/home/dev/tab\there' }),
    ds({ id: S3, dir: '/home/dev/fine' }),
  ]);
  assert.deepEqual(projectDirs(list), ['/home/dev/fine']);
});

test('projectDirs: a directory that is not absolute is not offered (the new form needs one)', () => {
  const list = rows([ds({ id: S1, dir: 'relative/dir' }), ds({ id: S2, dir: '' })]);
  assert.deepEqual(projectDirs(list), []);
});

test('projectDirs: only directories of rows step 1 lists (no scripted runs, no empty sessions)', () => {
  const list = rows([
    ds({ id: S1, dir: '/tmp/sdk-run', transcript: { entrypoint: 'sdk-ts' } }),
    ds({ id: S2, dir: '/home/dev/never-prompted', transcript: null }),
    ds({ id: S3, dir: '/home/dev/listed' }),
  ]);
  assert.deepEqual(projectDirs(list), ['/home/dev/listed']);
});

test('projectDirs: no rows, no directories', () => {
  assert.deepEqual(projectDirs([]), []);
});

test('projectDirs: does not depend on whether a session is running or done', () => {
  const list = rows([
    ds({
      id: S1,
      dir: '/home/dev/running',
      state: 'working',
      lastActivityNs: T0 + SEC,
      holders: [
        {
          process: { bootId: BOOT_A, pid: 10, procStart: 1 },
          sinceNs: T0,
          live: null,
          scripted: false,
        },
      ],
    }),
    ds({ id: S2, dir: '/home/dev/done', hidden: true, doneAtNs: T0 }),
  ]);
  assert.deepEqual(projectDirs(list), ['/home/dev/running', '/home/dev/done']);
});
