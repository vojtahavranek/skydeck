import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { chipFor, prLevel } from '../../src/github.ts';
import { NS_PER_DAY, NS_PER_MINUTE } from '../../src/platform/time.ts';
import {
  buildList,
  buildRows,
  flatRows,
  isListed,
  matchesFilter,
} from '../../src/sessions/list.ts';
import type { ListModel, ListRow } from '../../src/sessions/list.ts';
import type { DerivedSession } from '../../src/sessions/types.ts';
import type { SessionMeta, TranscriptRow } from '../../src/store/types.ts';
import { attached, ds, meta, prRow, rowOf, rows } from '../helpers/derived.ts';
import { S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';

const MIN = NS_PER_MINUTE;

// --- titles ----------------------------------------------------------------------------------------

const titleOf = (session: DerivedSession, m?: SessionMeta): [string, string] => {
  const row = rowOf(session, m === undefined ? {} : { metas: [m] });
  return [row.title, row.titleSource];
};

test('title: the label comes first', () => {
  const session = ds({
    id: S1,
    transcript: { customTitle: 'C', aiTitle: 'A' },
  });
  assert.deepEqual(titleOf(session, meta(S1, { label: 'L' })), ['L', 'label']);
});

test('title: the name set in Claude Code comes before the generated title', () => {
  assert.deepEqual(titleOf(ds({ id: S1, transcript: { customTitle: 'C', aiTitle: 'A' } })), [
    'C',
    'name',
  ]);
});

test('title: the generated title', () => {
  assert.deepEqual(titleOf(ds({ id: S1, transcript: { aiTitle: 'A' } })), ['A', 'generated']);
});

test('title: a cleared name (empty) is not a name', () => {
  // The transcript reader keeps an empty customTitle as found: that is how a cleared name looks.
  assert.deepEqual(titleOf(ds({ id: S1, transcript: { customTitle: '', aiTitle: 'A' } })), [
    'A',
    'generated',
  ]);
  assert.deepEqual(titleOf(ds({ id: S1, transcript: { aiTitle: '' } })), [
    '2026-11-12 09:00 demo',
    'fallback',
  ]);
});

test('title: a title that is nothing once sanitised is not a title', () => {
  const session = ds({ id: S1, transcript: { customTitle: '\x1b[2J \x07', aiTitle: 'A' } });
  assert.deepEqual(titleOf(session), ['A', 'generated']);
});

test('title: with no title the fallback is the first-seen time and the directory name, in UTC', () => {
  assert.deepEqual(titleOf(ds({ id: S1, dir: '/home/dev/projects/demo' })), [
    '2026-11-12 09:00 demo',
    'fallback',
  ]);
  assert.deepEqual(titleOf(ds({ id: S1, dir: null })), ['2026-11-12 09:00 ?', 'fallback']);
});

test('title: the fallback uses firstSeenNs, truncated to the minute', () => {
  const session = ds({ id: S1, firstSeenNs: T0 + 14n * MIN + 59n * SEC + 999_999_999n });
  assert.equal(rowOf(session).title, '2026-11-12 09:14 demo');
});

test('title: the fallback of a directory with a trailing slash, of the root and of a bare name', () => {
  assert.equal(rowOf(ds({ id: S1, dir: '/home/dev/demo/' })).title, '2026-11-12 09:00 demo');
  assert.equal(rowOf(ds({ id: S1, dir: '/' })).title, '2026-11-12 09:00 ?');
  assert.equal(rowOf(ds({ id: S1, dir: 'demo' })).title, '2026-11-12 09:00 demo');
});

test('title: the fallback is sanitised too (the directory name is foreign text)', () => {
  const row = rowOf(ds({ id: S1, dir: '/home/dev/\x1b]0;pwn\x07demo' }));
  assert.equal(row.title, '2026-11-12 09:00 demo');
  assert.equal(row.dir, '/home/dev/demo');
});

test('title: the fallback is in UTC whatever the time zone of the machine', (t) => {
  // In a child process, because the zone is read once at start; an hour and a minute that differ
  // from UTC in both (Kolkata is +05:30) make local time show.
  const helpers = new URL('../helpers/derived.ts', import.meta.url).href;
  const script = `
    import { ds, rowOf } from ${JSON.stringify(helpers)};
    process.stdout.write(rowOf(ds({ id: 'x', firstSeenNs: ${T0}n })).title);
  `;
  const env = sandbox(t).env({ TZ: 'Asia/Kolkata' });
  const title = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
  });
  assert.equal(title, '2026-11-12 09:00 demo');
});

// --- sanitising -------------------------------------------------------------------------------------

test('sanitised: a generated title', () => {
  const row = rowOf(ds({ id: S1, transcript: { aiTitle: 'x\x1b]0;pwn\x07y' } }));
  assert.equal(row.title, 'xy');
});

test('sanitised: a name set in Claude Code', () => {
  assert.equal(rowOf(ds({ id: S1, transcript: { customTitle: 'a\x1b[2Jb' } })).title, 'ab');
});

test('sanitised: the detail of the state', () => {
  assert.equal(rowOf(ds({ id: S1, stateDetail: 'a\nb' })).stateDetail, 'a b');
  assert.equal(rowOf(ds({ id: S1, stateDetail: null })).stateDetail, null);
});

test('sanitised: the project directory, for display; the path itself stays in the session', () => {
  assert.equal(rowOf(ds({ id: S1, dir: '/w/\x1b[31mred' })).dir, '/w/red');
  assert.equal(rowOf(ds({ id: S1, dir: null })).dir, null);
  const row = rowOf(ds({ id: S1, dir: '/home/dev/a\tb' }));
  assert.equal(row.dir, '/home/dev/a b');
  assert.equal(row.session.dir, '/home/dev/a\tb');
});

test('sanitised: the title and the error of a pull request', () => {
  const pr = prRow('o/r', 1, {
    title: 't\x1b[2Jt',
    state: null,
    error: 'e\x1b]8;;http://x\x07rr\nor',
    okAtNs: null,
  });
  const row = rowOf(ds({ id: S1 }), { prs: [pr], sessionPrs: [attached(S1, pr)] });
  assert.equal(row.prs[0]?.title, 'tt');
  assert.equal(row.prs[0]?.error, 'err or');
  // The level comes from the pull request as stored: an error, however it reads, is "can't read".
  assert.equal(row.prs[0]?.level, 'cant-read');
});

test('sanitised: a label and a group (the database can be changed by other means)', () => {
  const row = rowOf(ds({ id: S1 }), {
    metas: [meta(S1, { label: 'x\x1b]0;pwn\x07y', group: 'g\x1b[2Jr' })],
  });
  assert.equal(row.title, 'xy');
  assert.equal(row.titleSource, 'label');
  assert.equal(row.label, 'xy');
  assert.equal(row.group, 'gr');
  assert.equal(rowOf(ds({ id: S1 }), { metas: [meta(S1, { label: 'L' })] }).title, 'L');
});

test('sanitised: a label or a group that is nothing once sanitised is not set', () => {
  const session = ds({ id: S1, transcript: { aiTitle: 'ABC-1 fix' } });
  const row = rowOf(session, { metas: [meta(S1, { label: '\x1b[2J ', group: '\x07' })] });
  assert.equal(row.label, null);
  assert.equal(row.title, 'ABC-1 fix');
  assert.equal(row.titleSource, 'generated');
  assert.equal(row.group, 'ABC-1'); // the pattern, since no group is set
  assert.equal(row.groupSource, 'title');
});

test('sanitised: a name or title is shown trimmed', () => {
  assert.equal(rowOf(ds({ id: S1, transcript: { aiTitle: '  A  ' } })).title, 'A');
  assert.equal(rowOf(ds({ id: S1, transcript: { customTitle: '\x1b[2J B\n' } })).title, 'B');
});

test('sanitised: a title that starts with a line break still gives its ticket group', () => {
  const row = rowOf(ds({ id: S1, transcript: { aiTitle: '\nDE-1 fix' } }));
  assert.equal(row.title, 'DE-1 fix');
  assert.equal(row.group, 'DE-1');
});

// --- groups -----------------------------------------------------------------------------------------

const groupOf = (session: DerivedSession, m?: SessionMeta, groupPattern?: string): string | null =>
  rowOf(session, {
    ...(m === undefined ? {} : { metas: [m] }),
    ...(groupPattern === undefined ? {} : { groupPattern }),
  }).group;

test('group: the one set in meta', () => {
  assert.equal(groupOf(ds({ id: S1 }), meta(S1, { group: 'G' })), 'G');
});

test('group: the meta group wins over a ticket key in the title', () => {
  const session = ds({ id: S1, transcript: { aiTitle: 'ABC-123 fix' } });
  assert.equal(groupOf(session, meta(S1, { group: 'G' })), 'G');
});

test('group: a ticket key at the start of the title', () => {
  assert.equal(groupOf(ds({ id: S1, transcript: { aiTitle: 'ABC-123 fix' } })), 'ABC-123');
});

test('group: a ticket key that is not at the start gives none', () => {
  assert.equal(groupOf(ds({ id: S1, transcript: { aiTitle: 'fix ABC-123' } })), null);
});

test('group: the title can be the label', () => {
  assert.equal(groupOf(ds({ id: S1 }), meta(S1, { label: 'ABC-9: x' })), 'ABC-9');
});

test('group: a pattern from the configuration', () => {
  const session = ds({ id: S1, transcript: { aiTitle: '[ops] rotate' } });
  assert.equal(groupOf(session, undefined, '^\\[\\w+\\]'), '[ops]');
});

test('group: where it came from is recorded', () => {
  const titled = ds({ id: S1, transcript: { aiTitle: 'ABC-123 fix' } });
  assert.equal(rowOf(titled, { metas: [meta(S1, { group: 'G' })] }).groupSource, 'meta');
  assert.equal(rowOf(titled).groupSource, 'title');
  const plain = rowOf(ds({ id: S1, transcript: { aiTitle: 'fix' } }));
  assert.equal(plain.group, null);
  assert.equal(plain.groupSource, null);
});

test('group: a match of nothing is no group', () => {
  assert.equal(groupOf(ds({ id: S1, transcript: { aiTitle: 'abc' } }), undefined, 'x*'), null);
});

test('group: the pattern is matched against the sanitised title', () => {
  const session = ds({ id: S1, transcript: { aiTitle: '\x1b[2JABC-1 fix' } });
  assert.equal(groupOf(session), 'ABC-1');
});

// --- pull requests ----------------------------------------------------------------------------------

test('prs: attached ones, sorted by url, with repo, level and the chip', () => {
  const p1 = prRow('o/r', 1, { checks: 'failing' });
  const p2 = prRow('o/r', 2);
  const p3 = prRow('o/r', 3);
  const row = rowOf(ds({ id: S1 }), {
    // the store gives no order: neither the rows nor the attachments are in url order
    prs: [p3, p2, p1],
    sessionPrs: [
      attached(S1, p2),
      attached(S1, p3, { detachedAtNs: T0 }),
      attached(S1, p1, { origin: 'manual' }),
    ],
  });
  assert.deepEqual(
    row.prs.map((pr) => pr.url),
    [p1.url, p2.url],
  );
  assert.equal(row.prs[0]?.repo, 'o/r');
  assert.equal(row.prs[0]?.number, 1);
  assert.equal(row.prs[0]?.title, 'A pull request');
  assert.equal(row.prs[0]?.state, 'open');
  assert.equal(row.prs[0]?.level, prLevel(p1));
  assert.equal(row.prs[1]?.level, prLevel(p2));
  assert.deepEqual(row.chip, chipFor([p1, p2]));
  assert.deepEqual(row.chip, { level: 'checks-failing', count: 2 });
});

test('prs: the fetch facts are carried over', () => {
  const pr = prRow('o/r', 5, {
    state: 'draft',
    review: 'approved',
    checks: 'passing',
    okAtNs: T0 - 5n * MIN,
  });
  const view = rowOf(ds({ id: S1 }), { prs: [pr], sessionPrs: [attached(S1, pr)] }).prs[0];
  assert.deepEqual(view, {
    url: pr.url,
    repo: 'o/r',
    number: 5,
    title: 'A pull request',
    state: 'draft',
    review: 'approved',
    checks: 'passing',
    okAtNs: T0 - 5n * MIN,
    error: null,
    level: 'draft',
  });
});

test('prs: none attached means no chip', () => {
  const row = rowOf(ds({ id: S1 }));
  assert.deepEqual(row.prs, []);
  assert.equal(row.chip, null);
});

test('prs: only detached ones means no chip', () => {
  const pr = prRow('o/r', 1);
  const row = rowOf(ds({ id: S1 }), {
    prs: [pr],
    sessionPrs: [attached(S1, pr, { detachedAtNs: T0 })],
  });
  assert.deepEqual(row.prs, []);
  assert.equal(row.chip, null);
});

test('prs: those of another session are not shown', () => {
  const pr = prRow('o/r', 1);
  const [a, b] = rows([ds({ id: S1 }), ds({ id: S2 })], {
    prs: [pr],
    sessionPrs: [attached(S2, pr)],
  });
  assert.deepEqual(a?.prs, []);
  assert.equal(b?.prs.length, 1);
});

test('prs: an attachment whose pull request row is missing is left out', () => {
  const pr = prRow('o/r', 1);
  const row = rowOf(ds({ id: S1 }), { prs: [], sessionPrs: [attached(S1, pr)] });
  assert.deepEqual(row.prs, []);
  assert.equal(row.chip, null);
});

// --- the other fields -------------------------------------------------------------------------------

test('shortId is the first 8 characters; hasNote is true iff there is a note; done is hidden', () => {
  const session = ds({ id: S1, hidden: true, doneAtNs: T0 });
  const row = rowOf(session, { metas: [meta(S1, { note: 'n' })] });
  assert.equal(row.shortId, '0b5f3c1e');
  assert.equal(row.hasNote, true);
  assert.equal(row.note, 'n');
  assert.equal(row.done, true);
  const plain = rowOf(ds({ id: S1 }));
  assert.equal(plain.hasNote, false);
  assert.equal(plain.note, null);
  assert.equal(plain.done, false);
});

test('a row carries the state, times, marks, continuation and the derived session itself', () => {
  const session = ds({
    id: S1,
    state: 'waiting',
    stateDetail: 'permission',
    sinceNs: T0 - MIN,
    lastActivityNs: T0 - SEC,
    marks: ['continued', 'expiring'],
    continuedFrom: S2,
  });
  const row = rowOf(session, { metas: [meta(S1, { label: 'L', group: 'G' })] });
  assert.equal(row.id, S1);
  assert.equal(row.state, 'waiting');
  assert.equal(row.stateDetail, 'permission');
  assert.equal(row.sinceNs, T0 - MIN);
  assert.equal(row.lastActivityNs, T0 - SEC);
  assert.deepEqual(row.marks, ['continued', 'expiring']);
  assert.equal(row.continuedFrom, S2);
  assert.equal(row.label, 'L');
  assert.equal(row.group, 'G');
  assert.equal(row.session, session);
});

test('buildRows keeps one row per session, in the order given, and uses only the meta of its own', () => {
  const result = rows([ds({ id: S3 }), ds({ id: S1 }), ds({ id: S2 })], {
    metas: [
      meta(S2, { label: 'two' }),
      meta('ffffffff-0000-4000-8000-000000000000', { label: 'x' }),
    ],
  });
  assert.deepEqual(
    result.map((r) => r.id),
    [S3, S1, S2],
  );
  assert.deepEqual(
    result.map((r) => r.label),
    [null, null, 'two'],
  );
});

// --- isListed ---------------------------------------------------------------------------------------

test('isListed: a session of another entrypoint is never listed', () => {
  const row = rowOf(ds({ id: S1, transcript: { entrypoint: 'sdk-ts' } }));
  assert.equal(isListed(row, false), false);
  assert.equal(isListed(row, true), false);
});

test('isListed: a transcript without an entrypoint, or with cli, is listed', () => {
  assert.equal(isListed(rowOf(ds({ id: S1, transcript: { entrypoint: null } })), false), true);
  assert.equal(isListed(rowOf(ds({ id: S1, transcript: { entrypoint: 'cli' } })), false), true);
});

test('isListed: not running with no transcript is not listed, with --all neither (D27)', () => {
  const row = rowOf(ds({ id: S1, transcript: null }));
  assert.equal(isListed(row, false), false);
  assert.equal(isListed(row, true), false);
});

test('isListed: running with no transcript is listed', () => {
  for (const state of ['running', 'working', 'waiting'] as const) {
    assert.equal(isListed(rowOf(ds({ id: S1, state, transcript: null })), false), true, state);
  }
});

test('isListed: a done session only with --all', () => {
  const row = rowOf(ds({ id: S1, hidden: true, doneAtNs: T0 }));
  assert.equal(isListed(row, false), false);
  assert.equal(isListed(row, true), true);
});

test('isListed: an expired session with nothing attached is not listed, with --all neither', () => {
  const row = rowOf(ds({ id: S1, marks: ['expired'], transcript: { missingSinceNs: T0 } }));
  assert.equal(isListed(row, false), false);
  assert.equal(isListed(row, true), false);
});

test('isListed: an expired session with a note, a label, a group or an attached pull request is listed', () => {
  const expired = ds({ id: S1, marks: ['expired'], transcript: { missingSinceNs: T0 } });
  const pr = prRow('o/r', 1);
  const cases: [string, ListRow][] = [
    ['note', rowOf(expired, { metas: [meta(S1, { note: 'n' })] })],
    ['label', rowOf(expired, { metas: [meta(S1, { label: 'L' })] })],
    ['group', rowOf(expired, { metas: [meta(S1, { group: 'G' })] })],
    ['pull request', rowOf(expired, { prs: [pr], sessionPrs: [attached(S1, pr)] })],
  ];
  for (const [what, row] of cases) {
    assert.equal(isListed(row, false), true, what);
    assert.equal(isListed(row, true), true, what);
  }
});

test('isListed: a group taken from the title is not something the user attached', () => {
  const expired = ds({
    id: S1,
    marks: ['expired'],
    transcript: { missingSinceNs: T0, aiTitle: 'ABC-123 fix retry' },
  });
  const row = rowOf(expired);
  assert.equal(row.group, 'ABC-123');
  assert.equal(isListed(row, false), false);
  assert.equal(isListed(row, true), false);
  // the same session with a group the user set is listed
  assert.equal(isListed(rowOf(expired, { metas: [meta(S1, { group: 'ABC-123' })] }), false), true);
});

test('isListed: an expired session with only a detached pull request is not listed', () => {
  const pr = prRow('o/r', 1);
  const row = rowOf(ds({ id: S1, marks: ['expired'], transcript: { missingSinceNs: T0 } }), {
    prs: [pr],
    sessionPrs: [attached(S1, pr, { detachedAtNs: T0 })],
  });
  assert.equal(isListed(row, true), false);
});

test('isListed: a session that is not expired is listed whatever it has', () => {
  assert.equal(isListed(rowOf(ds({ id: S1 })), false), true);
});

// --- buildList --------------------------------------------------------------------------------------

type Spec = Partial<Omit<DerivedSession, 'transcript'>> & {
  id: string;
  group?: string | null;
  transcript?: Partial<TranscriptRow> | null;
};

/** Rows of the given sessions; `group` of a spec is set as the group in meta. */
function built(specs: readonly Spec[]): ListRow[] {
  const sessions: DerivedSession[] = [];
  const metas: SessionMeta[] = [];
  for (const { group, ...session } of specs) {
    sessions.push(ds(session));
    if (group !== undefined && group !== null) {
      metas.push(meta(session.id, { group }));
    }
  }
  return rows(sessions, { metas });
}

const layout = (model: ListModel): [string | null, string[]][] =>
  model.groups.map((g) => [g.name, g.rows.map((r) => r.id)]);

const list = (rowList: readonly ListRow[], over: { showAll?: boolean; filter?: string } = {}) =>
  buildList(rowList, { showAll: false, filter: '', nowNs: T0, ...over });

test('buildList: rows of a group are ordered waiting, working, running, ended unexpectedly, not running', () => {
  const model = list(
    built([
      { id: 'a1', group: 'A', state: 'waiting', lastActivityNs: T0 - 5n * MIN },
      {
        id: 'a2',
        group: 'A',
        state: 'not-running',
        marks: ['ended-unexpectedly'],
        lastActivityNs: T0 - MIN,
      },
      { id: 'a3', group: 'A', state: 'not-running', lastActivityNs: T0 - 30n * SEC },
      { id: 'a4', group: 'A', state: 'working', lastActivityNs: T0 - 10n * MIN },
      { id: 'a5', group: 'A', state: 'running', lastActivityNs: T0 - 20n * MIN },
    ]),
  );
  assert.deepEqual(layout(model), [['A', ['a1', 'a4', 'a5', 'a2', 'a3']]]);
});

test('buildList: inside a rank the most recent activity comes first', () => {
  const model = list(
    built([
      { id: 'w1', group: 'A', state: 'working', lastActivityNs: T0 - 3n * MIN },
      { id: 'w2', group: 'A', state: 'working', lastActivityNs: T0 - MIN },
      { id: 'w3', group: 'A', state: 'working', lastActivityNs: T0 - 2n * MIN },
    ]),
  );
  assert.deepEqual(layout(model), [['A', ['w2', 'w3', 'w1']]]);
});

test('buildList: other marks do not change the rank of a not-running session', () => {
  const model = list(
    built([
      { id: 'n1', state: 'not-running', marks: ['expiring'], lastActivityNs: T0 - MIN },
      { id: 'n2', state: 'not-running', marks: ['was-working', 'ended-unexpectedly'] },
      { id: 'n3', state: 'not-running', marks: ['continued'], lastActivityNs: T0 - 2n * MIN },
    ]),
  );
  assert.deepEqual(layout(model), [[null, ['n2', 'n1', 'n3']]]);
});

test('buildList: groups are ordered by the latest activity of a member; the null group is last', () => {
  const model = list(
    built([
      { id: 'b1', group: 'B', lastActivityNs: T0 - 2n * MIN },
      { id: 'a1', group: 'A', lastActivityNs: T0 - 30n * SEC },
      { id: 'a2', group: 'A', lastActivityNs: T0 - 9n * MIN },
      { id: 'n1', group: null, lastActivityNs: T0 },
    ]),
  );
  assert.deepEqual(layout(model), [
    ['A', ['a1', 'a2']],
    ['B', ['b1']],
    [null, ['n1']],
  ]);
});

test('buildList: the activity of a group is its most recent member, not the first of its rows', () => {
  // `y` ranks first in group B (waiting) but is old; `z` is recent: B still beats A.
  const model = list(
    built([
      { id: 'a1', group: 'A', state: 'working', lastActivityNs: T0 - MIN },
      { id: 'y', group: 'B', state: 'waiting', lastActivityNs: T0 - 9n * MIN },
      { id: 'z', group: 'B', state: 'not-running', lastActivityNs: T0 - SEC },
    ]),
  );
  assert.deepEqual(layout(model), [
    ['B', ['y', 'z']],
    ['A', ['a1']],
  ]);
});

test('buildList: groups with equal activity are ordered by name', () => {
  const model = list(
    built([
      { id: 'd1', group: 'D', lastActivityNs: T0 - MIN },
      { id: 'c1', group: 'C', lastActivityNs: T0 - MIN },
    ]),
  );
  assert.deepEqual(
    model.groups.map((g) => g.name),
    ['C', 'D'],
  );
});

test('buildList: group names are compared by code unit, not by locale', () => {
  const model = list(
    built([
      { id: 'a1', group: 'a', lastActivityNs: T0 - MIN },
      { id: 'b1', group: 'B', lastActivityNs: T0 - MIN },
    ]),
  );
  assert.deepEqual(
    model.groups.map((g) => g.name),
    ['B', 'a'],
  );
});

test('buildList: equal rank and activity are ordered by id', () => {
  const model = list(
    built([
      { id: 'b', state: 'running' },
      { id: 'a', state: 'running' },
      { id: 'c', state: 'running' },
    ]),
  );
  assert.deepEqual(layout(model), [[null, ['a', 'b', 'c']]]);
});

test('buildList: times a nanosecond apart are told apart (they are bigint, beyond 2^53)', () => {
  const model = list(
    built([
      { id: 'a', group: 'A', lastActivityNs: T0 },
      { id: 'b', group: 'B', lastActivityNs: T0 + 1n },
      { id: 'c', group: 'B', lastActivityNs: T0 },
      { id: 'x', group: 'C', lastActivityNs: T0 - 1n },
      { id: 'y', group: 'C', lastActivityNs: T0 - 2n },
      { id: 'z', group: 'C', lastActivityNs: T0 - 1n + 1n - 2n },
    ]),
  );
  // within B: b is a nanosecond newer than c; within C: x is newer than y, and z ties with y (id order)
  assert.deepEqual(layout(model), [
    ['B', ['b', 'c']],
    ['A', ['a']],
    ['C', ['x', 'y', 'z']],
  ]);
});

test('buildList: rows of one rank a nanosecond apart are told apart', () => {
  const model = list(
    built([
      { id: 'x', state: 'running', lastActivityNs: T0 },
      { id: 'y', state: 'running', lastActivityNs: T0 + 1n },
    ]),
  );
  assert.deepEqual(layout(model), [[null, ['y', 'x']]]);
});

test('buildList: unlisted rows are left out, and a group with none is not shown', () => {
  const model = list(
    built([
      { id: 'a1', group: 'A', hidden: true, doneAtNs: T0 },
      { id: 'b1', group: 'B' },
      { id: 'c1', group: 'C', transcript: null },
    ]),
  );
  assert.deepEqual(layout(model), [['B', ['b1']]]);
});

test('buildList: showAll includes done rows', () => {
  const rowList = built([
    { id: 'a1', group: 'A', hidden: true, doneAtNs: T0 },
    { id: 'b1', group: 'B' },
  ]);
  assert.deepEqual(layout(list(rowList, { showAll: true })), [
    ['A', ['a1']],
    ['B', ['b1']],
  ]);
});

test('buildList: a filter drops the rows that do not match and the groups left empty', () => {
  const rowList = built([
    { id: 'a1', group: 'A', transcript: { aiTitle: 'Fix retry' } },
    { id: 'a2', group: 'A', transcript: { aiTitle: 'Other' } },
    { id: 'b1', group: 'B', transcript: { aiTitle: 'Other' } },
  ]);
  assert.deepEqual(layout(list(rowList, { filter: 'retry' })), [['A', ['a1']]]);
  assert.deepEqual(layout(list(rowList, { filter: 'nothing like it' })), []);
});

test('buildList: generatedAtNs is nowNs', () => {
  assert.equal(list([], { filter: '' }).generatedAtNs, T0);
  assert.equal(
    buildList([], { showAll: false, filter: '', nowNs: T0 + 7n }).generatedAtNs,
    T0 + 7n,
  );
  assert.deepEqual(list([]).groups, []);
});

test('buildList: it does not reorder the rows it is given', () => {
  const rowList = built([{ id: 'b' }, { id: 'a' }]);
  const before = rowList.map((r) => r.id);
  list(rowList);
  assert.deepEqual(
    rowList.map((r) => r.id),
    before,
  );
});

test('flatRows returns the rows in group order, then row order', () => {
  const model = list(
    built([
      { id: 'b1', group: 'B', lastActivityNs: T0 - 2n * MIN },
      { id: 'a1', group: 'A', state: 'working', lastActivityNs: T0 },
      { id: 'a2', group: 'A', state: 'waiting', lastActivityNs: T0 - MIN },
      { id: 'n1', lastActivityNs: T0 - NS_PER_DAY },
    ]),
  );
  assert.deepEqual(
    flatRows(model).map((r) => r.id),
    ['a2', 'a1', 'b1', 'n1'],
  );
});

// --- matchesFilter ----------------------------------------------------------------------------------

function filterRow(): ListRow {
  const pr = prRow('o/r', 7);
  const gone = prRow('x/y', 99);
  return rowOf(
    ds({ id: S1, dir: '/home/dev/projects/demo', transcript: { aiTitle: 'Fix retry' } }),
    {
      metas: [meta(S1, { group: 'ABC-1', note: 'remember the milk' })],
      prs: [pr, gone],
      sessionPrs: [attached(S1, pr), attached(S1, gone, { detachedAtNs: T0 })],
    },
  );
}

test('matchesFilter: the title, without regard to case', () => {
  assert.equal(matchesFilter(filterRow(), 'RETRY'), true);
  assert.equal(matchesFilter(filterRow(), 'Fix R'), true);
});

test('matchesFilter: the repository, the number and both together', () => {
  for (const filter of ['o/r#7', 'o/r', '7', 'O/R#7']) {
    assert.equal(matchesFilter(filterRow(), filter), true, filter);
  }
  assert.equal(matchesFilter(filterRow(), 'o/r#8'), false);
});

test('matchesFilter: a detached pull request is not searched', () => {
  assert.equal(matchesFilter(filterRow(), 'x/y'), false);
  assert.equal(matchesFilter(filterRow(), '99'), false);
});

test('matchesFilter: the group, the note and the directory', () => {
  assert.equal(matchesFilter(filterRow(), 'abc-1'), true);
  assert.equal(matchesFilter(filterRow(), 'MILK'), true);
  assert.equal(matchesFilter(filterRow(), 'projects/demo'), true);
});

test('matchesFilter: an empty filter matches everything, even a row with nothing set', () => {
  assert.equal(matchesFilter(filterRow(), ''), true);
  assert.equal(matchesFilter(rowOf(ds({ id: S1, dir: null })), ''), true);
});

test('matchesFilter: what is nowhere matches nothing, and the id is not searched', () => {
  assert.equal(matchesFilter(filterRow(), 'zzz'), false);
  assert.equal(matchesFilter(filterRow(), '0b5f3c1e'), false);
  assert.equal(matchesFilter(rowOf(ds({ id: S1, dir: null })), 'null'), false);
});

test('matchesFilter: it matches the sanitised text the list shows', () => {
  const row = rowOf(ds({ id: S1, transcript: { aiTitle: 'ab\x1b[2Jcd' } }));
  assert.equal(matchesFilter(row, 'abcd'), true);
});

test('buildRows with nothing to build gives nothing', () => {
  assert.deepEqual(
    buildRows({ sessions: [], metas: [], prs: [], sessionPrs: [], groupPattern: '^x' }),
    [],
  );
});
