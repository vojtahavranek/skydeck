import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatList, formatShow, listJson, sessionJson, showJson } from '../../src/cli/output.ts';
import type { SessionJson } from '../../src/cli/output.ts';
import { formatPrLine, formatRow } from '../../src/cli/row.ts';
import { NS_PER_MINUTE, NS_PER_SECOND, isoFromNs } from '../../src/platform/time.ts';
import type { ListModel, ListRow, PrView } from '../../src/sessions/list.ts';
import type { Holder } from '../../src/sessions/types.ts';
import type { LinkRow } from '../../src/store/types.ts';
import { BOOT_A, S1, S2, S3, T0 } from '../helpers/platform.ts';
import { ds } from '../helpers/derived.ts';
import { listRow } from '../helpers/rows.ts';

const MIN = NS_PER_MINUTE;
const SEC = NS_PER_SECOND;
const PR1 = 'https://github.com/o/r/pull/1';

function pr(over: Partial<PrView> = {}): PrView {
  return {
    url: PR1,
    repo: 'o/r',
    number: 1,
    title: 'A pull request',
    state: 'open',
    review: null,
    checks: null,
    okAtNs: T0,
    error: null,
    level: 'approved-green',
    ...over,
  };
}

const UNFETCHED = pr({
  state: null,
  title: null,
  okAtNs: null,
  level: 'unfetched',
});

function link(over: Partial<LinkRow> & Pick<LinkRow, 'fromSession' | 'toSession'>): LinkRow {
  return { eventId: 1, kind: 'clear', timeNs: T0, ...over };
}

function holder(pid: number, sinceNs: bigint, procStart: number | null = 777): Holder {
  return { process: { bootId: BOOT_A, pid, procStart }, sinceNs, live: null };
}

/** A row with every field of the session object set. */
function fullRow(): ListRow {
  return listRow({
    id: S1,
    title: 'ABC-123 add retries',
    titleSource: 'label',
    label: 'ABC-123 add retries',
    group: 'ABC-123',
    state: 'waiting',
    stateDetail: 'a permission',
    sinceNs: T0 - 5n * MIN,
    lastActivityNs: T0 - 2n * MIN,
    dir: '/home/dev/projects/api',
    marks: ['ended-unexpectedly', 'continued'],
    hasNote: true,
    note: 'a note',
    continuedFrom: S2,
    done: true,
    prs: [
      pr({
        review: 'approved',
        checks: 'passing',
        okAtNs: T0 - MIN,
        error: 'gh timed out after 10 s',
        level: 'cant-read',
      }),
      UNFETCHED,
    ],
  });
}

const SESSION_KEYS = [
  'id',
  'shortId',
  'title',
  'titleSource',
  'label',
  'group',
  'state',
  'stateDetail',
  'since',
  'lastActivity',
  'dir',
  'marks',
  'hasNote',
  'continuedFrom',
  'done',
  'prs',
];

// --- sessionJson -----------------------------------------------------------------------------------

test('sessionJson of a row with every field set is the object of 2.10.5, keys in that order', () => {
  const json = sessionJson(fullRow());
  assert.deepEqual(Object.keys(json), SESSION_KEYS);
  assert.deepEqual(json, {
    id: S1,
    shortId: '0b5f3c1e',
    title: 'ABC-123 add retries',
    titleSource: 'label',
    label: 'ABC-123 add retries',
    group: 'ABC-123',
    state: 'waiting',
    stateDetail: 'a permission',
    since: '2026-11-12T08:55:00.000Z',
    lastActivity: '2026-11-12T08:58:00.000Z',
    dir: '/home/dev/projects/api',
    marks: ['ended-unexpectedly', 'continued'],
    hasNote: true,
    continuedFrom: S2,
    done: true,
    prs: [
      {
        url: PR1,
        repo: 'o/r',
        number: 1,
        state: 'open',
        review: 'approved',
        checks: 'passing',
        okAt: '2026-11-12T08:59:00.000Z',
        error: 'gh timed out after 10 s',
      },
      {
        url: PR1,
        repo: 'o/r',
        number: 1,
        state: null,
        review: null,
        checks: null,
        okAt: null,
        error: null,
      },
    ],
  });
});

test('a pull request object has its keys in the order of 2.10.5', () => {
  const [first] = sessionJson(fullRow()).prs;
  assert.deepEqual(Object.keys(first ?? {}), [
    'url',
    'repo',
    'number',
    'state',
    'review',
    'checks',
    'okAt',
    'error',
  ]);
});

test('sessionJson: dir is the empty string when the directory is not known; label and group stay null', () => {
  const json = sessionJson(listRow({ id: S1, dir: null }));
  assert.equal(json.dir, '');
  assert.equal(json.label, null);
  assert.equal(json.group, null);
  assert.equal(json.stateDetail, null);
  assert.deepEqual(json.prs, []);
});

test('sessionJson does not hand out the row own marks array', () => {
  const row = listRow({ id: S1, marks: ['was-working'] });
  const json = sessionJson(row);
  json.marks.push('expired');
  assert.deepEqual(row.marks, ['was-working']);
});

// --- listJson --------------------------------------------------------------------------------------

test('listJson: version 1, generatedAt from the model, sessions in display order', () => {
  const a = listRow({ id: S1, group: 'ABC-123' });
  const b = listRow({ id: S2 });
  const c = listRow({ id: S3 });
  const model: ListModel = {
    generatedAtNs: T0 + 5n * MIN,
    groups: [
      { name: 'ABC-123', rows: [a] },
      { name: null, rows: [b, c] },
    ],
  };
  const json = listJson(model);
  assert.deepEqual(Object.keys(json), ['version', 'generatedAt', 'sessions']);
  assert.equal(json.version, 1);
  assert.equal(json.generatedAt, '2026-11-12T09:05:00.000Z');
  assert.deepEqual(
    json.sessions.map((session) => session.id),
    [S1, S2, S3],
  );
  assert.deepEqual(json.sessions[0], sessionJson(a));
});

test('listJson of an empty model has no sessions', () => {
  assert.deepEqual(listJson({ generatedAtNs: T0, groups: [] }), {
    version: 1,
    generatedAt: isoFromNs(T0),
    sessions: [],
  });
});

// --- showJson --------------------------------------------------------------------------------------

test('showJson: the session object, then note, launch, unknownFlags, links and holders', () => {
  const row = listRow({
    id: S1,
    note: 'a\nb',
    hasNote: true,
    session: ds({
      id: S1,
      launch: ['claude', '--model', 'opus'],
      holders: [holder(4242, T0 - 3n * MIN, 100)],
    }),
  });
  const json = showJson(row, []);
  assert.deepEqual(Object.keys(json), [
    ...SESSION_KEYS,
    'doneAt',
    'note',
    'launch',
    'unknownFlags',
    'links',
    'holders',
  ]);
  const session = sessionJson(row);
  for (const key of SESSION_KEYS) {
    assert.deepEqual(json[key as keyof SessionJson], session[key as keyof SessionJson], key);
  }
  assert.equal(json.note, 'a\nb');
  assert.deepEqual(json.launch, ['claude', '--model', 'opus']);
  assert.deepEqual(json.unknownFlags, []);
  assert.deepEqual(json.holders, [
    { pid: 4242, bootId: BOOT_A, procStart: 100, since: '2026-11-12T08:57:00.000Z' },
  ]);
});

test('showJson: doneAt is the time the session was marked done, null when it is not done', () => {
  const done = listRow({
    id: S1,
    done: true,
    session: ds({ id: S1, hidden: true, doneAtNs: T0 - 2n * MIN }),
  });
  assert.equal(showJson(done, []).doneAt, '2026-11-12T08:58:00.000Z');
  assert.equal(showJson(done, []).done, true);
  assert.equal(showJson(listRow({ id: S1 }), []).doneAt, null);
  const active = listRow({
    id: S1,
    done: false,
    session: ds({ id: S1, hidden: false, doneAtNs: T0 - 2n * MIN }),
  });
  assert.equal(showJson(active, []).doneAt, null, 'done and active again: not done');
  assert.equal(
    showJson(listRow({ id: S1, done: true }), []).doneAt,
    null,
    'no time is known: null, as the text says "yes"',
  );
});

test('showJson: no note and no launch command are null; unknownFlags is [] without a launch command', () => {
  const json = showJson(listRow({ id: S1 }), []);
  assert.equal(json.note, null);
  assert.equal(json.launch, null);
  assert.deepEqual(json.unknownFlags, []);
  assert.deepEqual(json.links, []);
  assert.deepEqual(json.holders, []);
});

test('showJson: unknownFlags names the flags no table knows', () => {
  const row = listRow({
    id: S1,
    session: ds({ id: S1, launch: ['claude', '--frob', 'x', '--other=1'] }),
  });
  assert.deepEqual(showJson(row, []).unknownFlags, ['--frob', '--other']);
});

test('showJson: a holder without a process start has procStart null', () => {
  const row = listRow({ id: S1, session: ds({ id: S1, holders: [holder(5000, T0, null)] }) });
  assert.equal(showJson(row, []).holders[0]?.procStart, null);
});

test('showJson: links are only those from or to the row, ordered by time, with `at` as ISO', () => {
  const later = link({
    eventId: 4,
    fromSession: S1,
    toSession: S3,
    kind: 'fork',
    timeNs: T0 + MIN,
  });
  const earlier = link({ eventId: 2, fromSession: S2, toSession: S1, kind: 'clear', timeNs: T0 });
  const foreign = link({ eventId: 3, fromSession: S2, toSession: S3, timeNs: T0 + SEC });
  const json = showJson(listRow({ id: S1 }), [later, foreign, earlier]);
  assert.deepEqual(json.links, [
    { kind: 'clear', from: S2, to: S1, at: '2026-11-12T09:00:00.000Z' },
    { kind: 'fork', from: S1, to: S3, at: '2026-11-12T09:01:00.000Z' },
  ]);
  assert.deepEqual(Object.keys(json.links[0] ?? {}), ['kind', 'from', 'to', 'at']);
});

test('showJson: links of the same time are ordered by event id', () => {
  const second = link({ eventId: 9, fromSession: S1, toSession: S3, kind: 'switch' });
  const first = link({ eventId: 8, fromSession: S2, toSession: S1 });
  const json = showJson(listRow({ id: S1 }), [second, first]);
  assert.deepEqual(
    json.links.map((entry) => entry.kind),
    ['clear', 'switch'],
  );
});

// --- formatList ------------------------------------------------------------------------------------

test('formatList of two groups: a name line, the rows indented by two, an empty line between', () => {
  const a = listRow({ id: S1, group: 'ABC-123', title: 'first' });
  const b = listRow({ id: S2, title: 'second' });
  const model: ListModel = {
    generatedAtNs: T0,
    groups: [
      { name: 'ABC-123', rows: [a] },
      { name: null, rows: [b] },
    ],
  };
  assert.equal(
    formatList(model, T0, 80),
    `ABC-123\n  ${formatRow(a, T0, 78)}\n\nno group\n  ${formatRow(b, T0, 78)}\n`,
  );
});

test('formatList: every row of a group is its own line', () => {
  const a = listRow({ id: S1, title: 'first' });
  const b = listRow({ id: S2, title: 'second' });
  const text = formatList({ generatedAtNs: T0, groups: [{ name: null, rows: [a, b] }] }, T0, 60);
  assert.equal(text, `no group\n  ${formatRow(a, T0, 58)}\n  ${formatRow(b, T0, 58)}\n`);
});

test('formatList of a model with no group says "no sessions"', () => {
  assert.equal(formatList({ generatedAtNs: T0, groups: [] }, T0, 80), 'no sessions\n');
});

test('formatList gives each row the width less its indent', () => {
  const row = listRow({
    id: S1,
    title: 'a title that is much too long to fit in sixty columns, really',
  });
  const text = formatList({ generatedAtNs: T0, groups: [{ name: null, rows: [row] }] }, T0, 60);
  assert.equal(text, `no group\n  ${formatRow(row, T0, 58)}\n`);
  assert.ok(text.includes('…'), text);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 60, `"${line}" is ${line.length} long`);
  }
});

// --- formatShow ------------------------------------------------------------------------------------

function showText(row: ListRow, links: readonly LinkRow[] = []): string {
  return formatShow(row, links, T0);
}

test('formatShow starts with the title, then one line per field, the label padded to 11', () => {
  const row = listRow({
    id: S1,
    title: 'Fix retry loop',
    state: 'working',
    sinceNs: T0 - MIN,
    marks: ['was-working'],
    label: 'mine',
    group: 'ABC-123',
    dir: '/home/dev/projects/api',
  });
  const lines = showText(row).split('\n');
  assert.equal(lines[0], 'Fix retry loop');
  assert.equal(lines[1], `id:        ${S1}`);
  assert.equal(lines[2], 'state:     working since 2026-11-12T08:59:00.000Z');
  assert.equal(lines[3], 'marks:     was-working');
  assert.equal(lines[4], 'label:     mine');
  assert.equal(lines[5], 'group:     ABC-123');
  assert.equal(lines[6], 'dir:       /home/dev/projects/api');
  assert.equal(lines[7], 'launch:    unknown');
  assert.equal(lines[8], '');
  assert.equal(lines.length, 9, 'the text ends with one newline');
});

test('formatShow: the state detail is shown in brackets after the state', () => {
  const row = listRow({ id: S1, state: 'waiting', stateDetail: 'a permission' });
  assert.match(
    showText(row),
    /^state: {5}waiting \(a permission\) since 2026-11-12T09:00:00.000Z$/m,
  );
});

test('formatShow: a session that is done says since when, on the line after its state', () => {
  const row = listRow({
    id: S1,
    done: true,
    session: ds({ id: S1, hidden: true, doneAtNs: T0 - 2n * MIN }),
  });
  const lines = showText(row).split('\n');
  assert.equal(lines[2]?.startsWith('state:'), true);
  assert.equal(lines[3], 'done:      since 2026-11-12T08:58:00.000Z');
});

test('formatShow: a done session whose done time is not known says "yes"; one that is not done has no line', () => {
  assert.ok(showText(listRow({ id: S1, done: true })).includes('\ndone:      yes\n'));
  assert.ok(!showText(listRow({ id: S1 })).includes('done:'));
});

test('formatShow: a session marked done and active again is not done, and says nothing about it', () => {
  const row = listRow({
    id: S1,
    done: false,
    session: ds({ id: S1, hidden: false, doneAtNs: T0 - 2n * MIN }),
  });
  assert.ok(!showText(row).includes('done:'));
});

test('formatShow: several marks are joined by a comma; none, no label and no group show as "-"', () => {
  const some = showText(listRow({ id: S1, marks: ['ended-unexpectedly', 'was-working'] }));
  assert.match(some, /^marks: {5}ended-unexpectedly,was-working$/m);
  const none = showText(listRow({ id: S1 }));
  assert.match(none, /^marks: {5}-$/m);
  assert.match(none, /^label: {5}-$/m);
  assert.match(none, /^group: {5}-$/m);
});

test('formatShow: dir is "-" when it is null or empty', () => {
  assert.match(showText(listRow({ id: S1, dir: null })), /^dir: {7}-$/m);
  assert.match(showText(listRow({ id: S1, dir: '' })), /^dir: {7}-$/m);
});

test('formatShow: the id line, and the recorded launch command as shellJoin', () => {
  const row = listRow({
    id: S1,
    session: ds({ id: S1, launch: ['claude', '--model', 'opus'] }),
  });
  const text = showText(row);
  assert.ok(text.includes(`id:        ${S1}`), text);
  assert.ok(text.includes('launch:    claude --model opus'), text);
  assert.ok(!text.includes('unknown:'), text);
});

test('formatShow: a launch command with a word that needs quoting is quoted', () => {
  const row = listRow({
    id: S1,
    session: ds({ id: S1, launch: ['claude', '--append-system-prompt', 'two words'] }),
  });
  assert.ok(showText(row).includes("launch:    claude --append-system-prompt 'two words'"));
});

test('formatShow: an empty launch command reads "unknown" like none', () => {
  const text = showText(listRow({ id: S1, session: ds({ id: S1, launch: [] }) }));
  assert.ok(text.includes('\nlaunch:    unknown\n'), text);
  assert.ok(!text.includes('unknown:'), text);
});

test('formatShow: "launch: unknown" when no command was recorded', () => {
  const text = showText(listRow({ id: S1 }));
  assert.ok(text.includes('launch:    unknown'), text);
  assert.ok(!text.includes('unknown:'), text);
});

test('formatShow: the flags skydeck does not know are listed on an "unknown:" line', () => {
  const row = listRow({
    id: S1,
    session: ds({ id: S1, launch: ['claude', '--frob', 'x', '--other=1'] }),
  });
  assert.ok(showText(row).includes('\nunknown:   --frob --other\n'), showText(row));
});

test('formatShow: the names of unknown flags are sanitised', () => {
  const row = listRow({
    id: S1,
    session: ds({ id: S1, launch: ['claude', '--bad\x1b[2Jflag'] }),
  });
  const text = showText(row);
  assert.ok(!text.includes('\x1b'), JSON.stringify(text));
  assert.ok(text.includes('\nunknown:   --badflag\n'), JSON.stringify(text));
});

test('formatShow: the launch command is sanitised', () => {
  const row = listRow({
    id: S1,
    session: ds({ id: S1, launch: ['claude', '--model', 'op\x1b]0;owned\x07us'] }),
  });
  const text = showText(row);
  assert.ok(!text.includes('\x1b') && !text.includes('\x07'), JSON.stringify(text));
  assert.ok(text.includes('launch:    claude --model opus\n'), JSON.stringify(text));
});

test('formatShow: "continues:" names the session a clear or fork continued, and only then', () => {
  assert.ok(showText(listRow({ id: S1, continuedFrom: S2 })).includes(`\ncontinues: ${S2}\n`));
  assert.ok(!showText(listRow({ id: S1 })).includes('continues:'));
});

test('formatShow: one "link:" line per link of the session, by short id, with the time', () => {
  const links = [
    link({ eventId: 5, fromSession: S1, toSession: S3, kind: 'fork', timeNs: T0 + MIN }),
    link({ eventId: 2, fromSession: S2, toSession: S1, kind: 'clear', timeNs: T0 }),
    link({ eventId: 3, fromSession: S2, toSession: S3, kind: 'switch', timeNs: T0 }),
  ];
  const text = showText(listRow({ id: S1 }), links);
  const lines = text.split('\n').filter((line) => line.startsWith('link:'));
  assert.deepEqual(lines, [
    'link:      clear 1c6a4d2f -> 0b5f3c1e at 2026-11-12T09:00:00.000Z',
    'link:      fork 0b5f3c1e -> 2d7b5e3a at 2026-11-12T09:01:00.000Z',
  ]);
});

test('formatShow: one "holder:" line per live holder', () => {
  const row = listRow({
    id: S1,
    session: ds({ id: S1, holders: [holder(4242, T0 - 2n * MIN), holder(5000, T0 - MIN)] }),
  });
  const lines = showText(row)
    .split('\n')
    .filter((line) => line.startsWith('holder:'));
  assert.deepEqual(lines, [
    'holder:    pid 4242 since 2026-11-12T08:58:00.000Z',
    'holder:    pid 5000 since 2026-11-12T08:59:00.000Z',
  ]);
});

test('formatShow: a never-fetched pull request is "not fetched", with no review or checks', () => {
  const text = showText(listRow({ id: S1, prs: [UNFETCHED] }));
  assert.ok(text.includes(`\npr:        ${PR1}  not fetched\n`), text);
});

test('formatShow: an open pull request adds its review and its checks', () => {
  const row = listRow({
    id: S1,
    prs: [pr({ review: 'approved', checks: 'passing', level: 'approved-green' })],
  });
  assert.ok(
    showText(row).includes(`\npr:        ${PR1}  approved-green review approved checks passing\n`),
    showText(row),
  );
});

test('formatShow: only the review, or only the checks, when only one is set', () => {
  const review = showText(
    listRow({ id: S1, prs: [pr({ review: 'changes-requested', level: 'changes-requested' })] }),
  );
  assert.ok(review.includes(`${PR1}  changes-requested review changes-requested\n`), review);
  const checks = showText(
    listRow({ id: S1, prs: [pr({ checks: 'pending', level: 'checks-pending' })] }),
  );
  assert.ok(checks.includes(`${PR1}  checks-pending checks pending\n`), checks);
});

test('formatShow: a pull request that cannot be read shows neither review nor checks, whatever it knew before', () => {
  const unreadable = pr({
    review: 'approved',
    checks: 'passing',
    level: 'cant-read',
    okAtNs: T0 - MIN,
    error: 'gh timed out after 10 s',
  });
  const text = showText(listRow({ id: S1, prs: [unreadable] }));
  assert.ok(
    text.includes(
      `\npr:        ${PR1}  can't read, last read 2026-11-12T08:59:00.000Z (gh timed out after 10 s)\n`,
    ),
    text,
  );
  assert.ok(!text.includes(' review approved'), text);
  assert.ok(!text.includes(' checks passing'), text);
});

test('formatShow: a pull request line starts with what formatPrLine prints', () => {
  const merged = pr({ state: 'merged', level: 'merged' });
  assert.ok(
    showText(listRow({ id: S1, prs: [merged] })).includes(`pr:        ${formatPrLine(merged)}\n`),
  );
});

test('formatShow: one "pr:" line per pull request, in the row order', () => {
  const other = pr({
    url: 'https://github.com/o/r/pull/2',
    number: 2,
    level: 'draft',
    state: 'draft',
  });
  const lines = showText(listRow({ id: S1, prs: [pr(), other] }))
    .split('\n')
    .filter((line) => line.startsWith('pr:'));
  assert.equal(lines.length, 2);
  assert.ok(lines[1]?.includes('/pull/2'), lines.join('\n'));
});

test('formatShow: a note follows "note:", its lines indented by two spaces', () => {
  const text = showText(listRow({ id: S1, hasNote: true, note: 'a\nb' }));
  assert.ok(text.endsWith('\nnote:\n  a\n  b\n'), JSON.stringify(text));
});

test('formatShow: a note that ends with a line break has no empty line after it', () => {
  const text = showText(listRow({ id: S1, hasNote: true, note: 'a\nb\n\n' }));
  assert.ok(text.endsWith('\nnote:\n  a\n  b\n'), JSON.stringify(text));
});

test('formatShow: lines that are nothing once sanitised leave no empty line before or after the note', () => {
  const after = showText(listRow({ id: S1, hasNote: true, note: 'a\n\x1b[0m' }));
  assert.ok(after.endsWith('\nnote:\n  a\n'), JSON.stringify(after));
  const before = showText(listRow({ id: S1, hasNote: true, note: '\x1b[0m\n\na' }));
  assert.ok(before.endsWith('\nnote:\n  a\n'), JSON.stringify(before));
});

test('formatShow: an empty line inside a note stays empty, without trailing spaces', () => {
  const text = showText(listRow({ id: S1, hasNote: true, note: 'a\n\nb' }));
  assert.ok(text.endsWith('\nnote:\n  a\n\n  b\n'), JSON.stringify(text));
});

test('formatShow: a note is sanitised line by line, and its line breaks are kept', () => {
  const note =
    'one \x1b[31mred\x1b[0m\ntwo\twith tab\x07\r\nthree \x1b]8;;http://x\x07link\x1b]8;;\x07';
  const text = showText(listRow({ id: S1, hasNote: true, note }));
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text), JSON.stringify(text));
  assert.ok(
    text.endsWith('\nnote:\n  one red\n  two with tab \n  three link\n'),
    JSON.stringify(text),
  );
});

test('formatShow: a note that is nothing once sanitised leaves no "note:" heading over nothing', () => {
  const text = showText(listRow({ id: S1, hasNote: true, note: '\x1b[2J\n\x07' }));
  assert.ok(!text.includes('note:'), JSON.stringify(text));
  assert.ok(text.endsWith('launch:    unknown\n'), JSON.stringify(text));
});

test('formatShow: no note, no "note:" line', () => {
  assert.ok(!showText(listRow({ id: S1 })).includes('note:'));
});
