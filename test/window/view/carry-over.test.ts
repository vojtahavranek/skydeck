// Follow-up F40 (design 7.1): the parts of the offer to carry fields over after `/clear`, the pure
// function over list rows and the three lookups the server gives it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ListRow } from '../../../src/sessions/list.ts';
import type { SessionMeta, SessionPrRow, PrRow } from '../../../src/store/types.ts';
import {
  DEFAULT_TICKS,
  MAX_HOPS,
  carryOffer,
  readTicks,
} from '../../../src/window/view/carry-over.ts';
import type { CarryInput, CarryTicks } from '../../../src/window/view/carry-over.ts';
import { attached, ds, meta, prRow, rows } from '../../helpers/derived.ts';
import { sid } from '../../helpers/restore.ts';

const O = sid(1);
const N = sid(2);
const N2 = sid(3);

interface World {
  sessions?: Parameters<typeof ds>[0][];
  metas?: SessionMeta[];
  prs?: PrRow[];
  sessionPrs?: SessionPrRow[];
  /** to → from */
  links?: Record<string, string>;
  byHand?: (id: string) => boolean;
  resuming?: (id: string) => boolean;
  ticks?: CarryTicks;
  to?: string;
}

/** The offer over a world of sessions (each not running, with a transcript, unless given). */
function offer(world: World) {
  const sessions = world.sessions ?? [{ id: O }, { id: N }];
  const built = rows(
    sessions.map((s) => ds(s)),
    {
      metas: world.metas ?? [],
      prs: world.prs ?? [],
      sessionPrs: world.sessionPrs ?? [],
    },
  );
  const byId = new Map(built.map((row) => [row.id, row]));
  const to = byId.get(world.to ?? N);
  assert.ok(to !== undefined);
  const asked: string[] = [];
  const input: CarryInput = {
    to,
    rowOf: (id) => byId.get(id),
    clearedFrom: (id) => world.links?.[id] ?? null,
    byHand: (id) => {
      asked.push(id);
      return world.byHand?.(id) ?? false;
    },
    resuming: (id) => world.resuming?.(id) ?? false,
    ticks: world.ticks ?? { ...DEFAULT_TICKS },
  };
  return { parts: carryOffer(input), asked };
}

const LINKED = { [N]: O };
const PR1 = prRow('acme/app', 1);
const PR2 = prRow('acme/app', 2);

test('no clear link: no offer', () => {
  const { parts } = offer({ metas: [meta(O, { label: 'work' })] });
  assert.equal(parts, null);
});

test('each single field the user set on the old session is offered alone, with its default tick and text', () => {
  const cases: [string, World, { name: string; text: string | null; ticked: boolean }][] = [
    [
      'label',
      { metas: [meta(O, { label: 'work' })] },
      { name: 'label', text: 'work', ticked: true },
    ],
    [
      'group',
      { metas: [meta(O, { group: 'backend' })] },
      { name: 'group', text: 'backend', ticked: true },
    ],
    [
      'ticket',
      { metas: [meta(O, { ticket: 'https://example.com/browse/TRY-1' })] },
      { name: 'ticket', text: 'TRY-1', ticked: true },
    ],
    ['note', { metas: [meta(O, { note: 'a note' })] }, { name: 'note', text: null, ticked: false }],
    [
      'prs',
      { prs: [PR1], sessionPrs: [attached(O, PR1, { origin: 'manual' })], byHand: () => true },
      { name: 'prs', text: null, ticked: false },
    ],
  ];
  for (const [what, world, field] of cases) {
    const { parts } = offer({ ...world, links: LINKED });
    assert.ok(parts !== null, what);
    assert.deepEqual(parts.payload.fields, [field], what);
    assert.deepEqual(parts.payload.kept, [], what);
    assert.equal(parts.fromId, O, what);
  }
});

test('the values are raw as the row has them, and only the offered ones', () => {
  const { parts } = offer({
    metas: [
      meta(O, {
        label: 'work',
        group: 'backend',
        ticket: 'https://example.com/browse/TRY-1',
        note: 'line 1\nline 2\n',
      }),
    ],
    prs: [PR1],
    sessionPrs: [attached(O, PR1)],
    links: LINKED,
  });
  assert.ok(parts !== null);
  assert.deepEqual(parts.values, {
    label: 'work',
    group: 'backend',
    ticket: 'https://example.com/browse/TRY-1',
    note: 'line 1\nline 2\n',
    prs: [PR1.url],
  });
  assert.equal(parts.payload.prs, 1);
  assert.deepEqual(
    parts.payload.fields.map((f) => [f.name, f.ticked]),
    [
      ['label', true],
      ['group', true],
      ['ticket', true],
      ['note', false],
      ['prs', false],
    ],
  );
});

test('no field on the old session, or a note of white space only: no offer', () => {
  assert.equal(offer({ links: LINKED }).parts, null);
  assert.equal(offer({ links: LINKED, metas: [meta(O, { note: '  \n ' })] }).parts, null);
});

test("a title's group on the old session is no field", () => {
  const { parts } = offer({
    sessions: [{ id: O, transcript: { customTitle: 'ABC-12 fix the thing' } }, { id: N }],
    links: LINKED,
  });
  assert.equal(parts, null);
});

test("a title's group on the new session does not keep a carried group away", () => {
  const { parts } = offer({
    sessions: [{ id: O }, { id: N, transcript: { customTitle: 'ABC-12 fix the thing' } }],
    metas: [meta(O, { group: 'backend' })],
    links: LINKED,
  });
  assert.ok(parts !== null);
  assert.deepEqual(
    parts.payload.fields.map((f) => f.name),
    ['group'],
  );
  assert.equal(parts.values.group, 'backend');
});

test('a field the new session has already is kept, not offered; all kept is no offer', () => {
  const old = meta(O, {
    label: 'work',
    group: 'backend',
    ticket: 'https://example.com/browse/TRY-1',
    note: 'old note',
  });
  const { parts } = offer({
    metas: [old, meta(N, { label: 'mine', note: 'new note' })],
    links: LINKED,
  });
  assert.ok(parts !== null);
  assert.deepEqual(
    parts.payload.fields.map((f) => f.name),
    ['group', 'ticket'],
  );
  assert.deepEqual(parts.payload.kept, ['label', 'note']);
  assert.deepEqual(Object.keys(parts.values).sort(), ['group', 'ticket']);
  const all = offer({
    metas: [
      old,
      meta(N, {
        label: 'mine',
        group: 'g',
        ticket: 'https://example.com/browse/TRY-2',
        note: 'n',
      }),
    ],
    links: LINKED,
  });
  assert.equal(all.parts, null);
});

test('pull requests: the count is of those the new session lacks; all present is kept', () => {
  const some = offer({
    metas: [meta(O, { label: 'work' })],
    prs: [PR1, PR2],
    sessionPrs: [attached(O, PR1), attached(O, PR2), attached(N, PR1)],
    links: LINKED,
  });
  assert.ok(some.parts !== null);
  assert.equal(some.parts.payload.prs, 1);
  assert.deepEqual(some.parts.values.prs, [PR2.url]);
  const all = offer({
    metas: [meta(O, { label: 'work' })],
    prs: [PR1],
    sessionPrs: [attached(O, PR1), attached(N, PR1)],
    links: LINKED,
  });
  assert.ok(all.parts !== null);
  assert.deepEqual(all.parts.payload.kept, ['prs']);
  assert.equal(all.parts.payload.prs, 0);
  assert.equal(all.parts.values.prs, undefined);
});

test('done: offered for a stopped old session that is not done; not for a running, a done or a resuming one', () => {
  const base = { metas: [meta(O, { label: 'work' })], links: LINKED };
  assert.deepEqual(offer(base).parts?.payload.done, { ticked: true });
  const running = offer({ ...base, sessions: [{ id: O, state: 'running' }, { id: N }] });
  assert.equal(running.parts?.payload.done, null);
  const done = offer({ ...base, sessions: [{ id: O, hidden: true }, { id: N }] });
  assert.equal(done.parts?.payload.done, null);
  const resuming = offer({ ...base, resuming: (id) => id === O });
  assert.equal(resuming.parts?.payload.done, null);
});

test('the chain: O with fields → N without → N2 names O; N with a field names N', () => {
  const sessions = [{ id: O }, { id: N }, { id: N2 }];
  const links = { [N2]: N, [N]: O };
  const far = offer({ sessions, links, to: N2, metas: [meta(O, { label: 'work' })] });
  assert.equal(far.parts?.fromId, O);
  assert.equal(far.parts?.payload.from.id, O);
  const near = offer({
    sessions,
    links,
    to: N2,
    metas: [meta(O, { label: 'work' }), meta(N, { label: 'near' })],
  });
  assert.equal(near.parts?.fromId, N);
  assert.equal(near.parts?.values.label, 'near');
});

test('a session without a row is stepped over', () => {
  const { parts } = offer({
    sessions: [{ id: O }, { id: N2 }],
    links: { [N2]: N, [N]: O },
    to: N2,
    metas: [meta(O, { label: 'work' })],
  });
  assert.equal(parts?.fromId, O);
});

test('a cycle, and a walk of more than 64 steps: no offer', () => {
  const cycle = offer({
    sessions: [{ id: O }, { id: N }, { id: N2 }],
    links: { [N2]: N, [N]: O, [O]: N2 },
    to: N2,
  });
  assert.equal(cycle.parts, null);
  // A chain of MAX_HOPS + 1 sessions above the new one, the labelled one at its top.
  const ids = Array.from({ length: MAX_HOPS + 2 }, (_, i) => sid(100 + i));
  const links: Record<string, string> = {};
  for (let i = 0; i + 1 < ids.length; i++) links[ids[i] as string] = ids[i + 1] as string;
  const top = ids[ids.length - 1] as string;
  const long = offer({
    sessions: ids.map((id) => ({ id })),
    links,
    to: ids[0] as string,
    metas: [meta(top, { label: 'far' })],
  });
  assert.equal(long.parts, null);
  // MAX_HOPS links still reach it.
  const reach = ids[MAX_HOPS] as string;
  const within = offer({
    sessions: ids.map((id) => ({ id })),
    links,
    to: ids[0] as string,
    metas: [meta(reach, { label: 'far' })],
  });
  assert.equal(within.parts?.fromId, reach);
});

test("the ruling's case: a pull request attached by itself does not stop the walk", () => {
  const sessions = [{ id: O }, { id: N }, { id: N2 }];
  const links = { [N2]: N, [N]: O };
  const metas = [
    meta(O, { label: 'work', group: 'backend', ticket: 'https://example.com/browse/TRY-1' }),
  ];
  const world = { sessions, links, to: N2, metas, prs: [PR1], sessionPrs: [attached(N, PR1)] };
  const auto = offer({ ...world, byHand: () => false });
  assert.ok(auto.parts !== null);
  assert.equal(auto.parts.fromId, O);
  assert.deepEqual(
    auto.parts.payload.fields.map((f) => f.name),
    ['label', 'group', 'ticket'],
  );
  assert.deepEqual(auto.asked, [N]);
  const manual = offer({ ...world, byHand: (id) => id === N });
  assert.ok(manual.parts !== null);
  assert.equal(manual.parts.fromId, N);
  assert.deepEqual(
    manual.parts.payload.fields.map((f) => f.name),
    ['prs'],
  );
});

test('an old session whose only field is a pull request attached by itself, with no link above it: no offer', () => {
  const { parts } = offer({
    prs: [PR1],
    sessionPrs: [attached(O, PR1)],
    links: LINKED,
    byHand: () => false,
  });
  assert.equal(parts, null);
});

test('a session found by its label offers its pull requests attached by themselves too; byHand is not asked', () => {
  const { parts, asked } = offer({
    metas: [meta(O, { label: 'work' })],
    prs: [PR1],
    sessionPrs: [attached(O, PR1)],
    links: LINKED,
  });
  assert.ok(parts !== null);
  assert.deepEqual(
    parts.payload.fields.map((f) => f.name),
    ['label', 'prs'],
  );
  assert.deepEqual(asked, []);
});

test('stored ticks replace the defaults member by member', () => {
  const ticks = { ...DEFAULT_TICKS, label: false, note: true, done: false };
  const { parts } = offer({
    metas: [meta(O, { label: 'work', group: 'backend', note: 'n' })],
    links: LINKED,
    ticks,
  });
  assert.ok(parts !== null);
  assert.deepEqual(
    parts.payload.fields.map((f) => [f.name, f.ticked]),
    [
      ['label', false],
      ['group', true],
      ['note', true],
    ],
  );
  assert.deepEqual(parts.payload.done, { ticked: false });
});

test('readTicks: no entry, no JSON, an array, a number in a member', () => {
  assert.deepEqual(readTicks(null), DEFAULT_TICKS);
  assert.deepEqual(readTicks('not json'), DEFAULT_TICKS);
  assert.deepEqual(readTicks('[true,false]'), DEFAULT_TICKS);
  assert.deepEqual(readTicks('null'), DEFAULT_TICKS);
  assert.deepEqual(readTicks('{"label":1,"note":true,"done":false,"other":true}'), {
    ...DEFAULT_TICKS,
    note: true,
    done: false,
  });
});

test("from.title and from.ticket are the old session's row's", () => {
  const { parts } = offer({
    metas: [meta(O, { label: 'work', ticket: 'https://github.com/acme/app/issues/7' })],
    links: LINKED,
  });
  assert.ok(parts !== null);
  assert.deepEqual(parts.payload.from, { id: O, title: 'work', ticket: 'app #7' });
});

test('rows with odd data give parts and never throw', () => {
  const odd: ListRow[] = rows([ds({ id: O }), ds({ id: N })], {
    metas: [meta(O, { label: '-dash', group: 'a\u0007b' })],
  });
  const [o, n] = odd;
  assert.ok(o !== undefined && n !== undefined);
  const parts = carryOffer({
    to: { ...n, prs: [] },
    rowOf: (id) => (id === O ? { ...o, prs: [] } : undefined),
    clearedFrom: (id) => (id === N ? O : null),
    byHand: () => false,
    resuming: () => false,
    ticks: { ...DEFAULT_TICKS },
  });
  assert.ok(parts !== null);
  assert.equal(parts.values.label, '-dash');
  assert.equal(typeof parts.values.group, 'string');
});
