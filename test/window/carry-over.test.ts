// Follow-up F40 (design 7.1, S2 10.2): the server's side of the carry over after `/clear` — the
// mark of the first start, the lookups from the store, `rev`, the two acts in one transaction
// each, and the removal of answers.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { UsageError } from '../../src/platform/errors.ts';
import type { Ns } from '../../src/platform/types.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { attachManualPr, detachSessionPr, keptNotePath } from '../../src/sessions/meta.ts';
import { acquireLock } from '../../src/sessions/resume.ts';
import type { Store } from '../../src/store/store.ts';
import type { LinkKind } from '../../src/store/types.ts';
import {
  ANSWERED,
  CHANGED,
  NOTHING_LEFT,
  NOTHING_TICKED,
  NO_OFFER_TO_DISMISS,
  SINCE_GRACE_NS,
  SINCE_KEY,
  TICKS_KEY,
  createCarryOver,
  readSince,
} from '../../src/window/carry-over.ts';
import type { CarryAct } from '../../src/window/carry-over.ts';
import type { CarryOverPayload } from '../../src/window/protocol.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { transcriptRow } from '../helpers/derived.ts';
import { BOOT_A, SEC, T0 } from '../helpers/platform.ts';
import { sid } from '../helpers/restore.ts';

const O = sid(1);
const N = sid(2);
const N2 = sid(3);
const X = sid(4);
const Y = sid(5);
const PR1 = 'https://github.com/acme/app/pull/1';
const PR2 = 'https://github.com/acme/app/pull/2';
const TICKET = 'https://example.com/browse/TRY-1';

interface World extends TestDeck {
  lines: string[];
  carry: ReturnType<typeof createCarryOver>;
  /** A module over `deck` (default the world's own). */
  module(deck?: Deck): ReturnType<typeof createCarryOver>;
}

/** A deck at T0 with sessions known from transcripts; the mark written at T0 unless `noMark`. */
function world(t: TestContext, options: { noMark?: boolean } = {}): World {
  const d = testDeck(t);
  const lines: string[] = [];
  const module = (deck: Deck = d.deck) =>
    createCarryOver({ deck, log: (line) => lines.push(line) });
  const carry = module();
  if (options.noMark !== true) carry.begin();
  return { ...d, lines, carry, module };
}

/** A session known from its transcript (not running). */
function session(d: TestDeck, id: string, over: Parameters<typeof transcriptRow>[1] = {}): void {
  d.deck.store.saveTranscript(transcriptRow(id, over));
}

let spoolSeq = 0;

/** A start event of `to` at `atNs` and the link `from` → `to` of `kind` that it made. */
function link(d: TestDeck, from: string, to: string, atNs: Ns, kind: LinkKind = 'clear'): void {
  const detail = kind === 'clear' ? 'clear' : kind === 'switch' ? 'resume' : 'fork';
  const eventId = d.deck.store.insertEvent({
    spoolName: `${atNs}-${(spoolSeq += 1)}.ev`,
    timeNs: atNs,
    kind: 'start',
    detail,
    rawDetail: detail,
    sessionId: to,
    bootId: BOOT_A,
    pid: 4242,
    procStart: 51234567,
    cwd: '/home/dev/projects/demo',
    argv: ['claude'],
    name: null,
    payload: null,
  });
  assert.ok(eventId !== null);
  d.deck.store.insertLink({ eventId, fromSession: from, toSession: to, kind, timeNs: atNs });
}

/** O → N cleared one second after T0, both known; O's meta as given. */
function cleared(d: TestDeck, oldMeta: Parameters<Store['updateMeta']>[1] = {}): void {
  session(d, O);
  session(d, N);
  if (Object.keys(oldMeta).length > 0) d.deck.store.updateMeta(O, oldMeta, T0);
  link(d, O, N, T0 + SEC);
}

function pr(d: TestDeck, url: string): void {
  const number = Number(url.split('/').at(-1));
  d.deck.store.ensurePr({ url, owner: 'acme', repo: 'app', number });
}

function offerOf(w: World, sessionId = N): CarryOverPayload | null {
  return w.carry.offer(loadRows(w.deck), sessionId);
}

function act(w: World, over: Partial<CarryAct> = {}): CarryAct {
  const offer = offerOf(w, over.sessionId ?? N);
  return {
    sessionId: N,
    rev: offer?.rev ?? '0000000000000000',
    fields: (offer?.fields ?? []).filter((field) => field.ticked).map((field) => field.name),
    done: offer?.done?.ticked ?? false,
    ...over,
  };
}

/** What a carry over can write, to compare before and after. */
function snapshot(d: TestDeck) {
  return {
    meta: d.deck.store.allMeta(),
    prs: d.deck.store.sessionPrs(),
    kv: d.deck.store.kvEntries('window_carry_over'),
  };
}

const LABELLED = { label: 'work', group: 'backend', ticket: TICKET };

describe('the mark of the first start', () => {
  test('on a store that never ran the feature no link makes an offer, and both acts are refused writing nothing', (t) => {
    const w = world(t, { noMark: true });
    cleared(w, LABELLED);
    const before = snapshot(w);

    assert.equal(offerOf(w), null);
    assert.deepEqual(
      w.carry.carry({ sessionId: N, rev: '0123456789abcdef', fields: ['label'], done: false }),
      { ok: false, error: NOTHING_LEFT },
    );
    assert.deepEqual(w.carry.dismiss(N), { ok: false, error: NO_OFFER_TO_DISMISS });
    assert.deepEqual(snapshot(w), before);
  });

  test("begin() writes the clock's time as a decimal; a later begin() and a new module over the same store leave it", (t) => {
    const w = world(t, { noMark: true });
    w.carry.begin();
    assert.equal(w.deck.store.getKv(SINCE_KEY), String(T0));
    w.clock.setNs(T0 + 60n * SEC);
    w.carry.begin();
    w.module().begin();
    assert.equal(w.deck.store.getKv(SINCE_KEY), String(T0));
  });

  test('a link dated more than 5 s before the mark makes no offer, and its dismissal is refused', (t) => {
    const w = world(t);
    session(w, O);
    session(w, N);
    w.deck.store.updateMeta(O, LABELLED, T0);
    link(w, O, N, T0 - SINCE_GRACE_NS - 1n);

    assert.equal(offerOf(w), null);
    assert.deepEqual(w.carry.dismiss(N), { ok: false, error: NO_OFFER_TO_DISMISS });
    assert.equal(w.deck.store.getKv(`window_carry_over:${N}`), null);
  });

  test('a link dated exactly 5 s before the mark, one at it and one after it make the offer', (t) => {
    for (const at of [T0 - SINCE_GRACE_NS, T0, T0 + SEC]) {
      const w = world(t);
      session(w, O);
      session(w, N);
      w.deck.store.updateMeta(O, LABELLED, T0);
      link(w, O, N, at);
      assert.equal(offerOf(w)?.from.id, O, String(at - T0));
    }
  });

  test("a chain that crosses the mark: no offer while the middle one has no field, and then its fields, never O's", (t) => {
    const w = world(t);
    session(w, O);
    session(w, N);
    session(w, N2);
    w.deck.store.updateMeta(O, LABELLED, T0);
    link(w, O, N, T0 - 60n * SEC);
    link(w, N, N2, T0 + SEC);

    assert.equal(offerOf(w, N2), null);
    w.deck.store.updateMeta(N, { note: 'middle' }, T0);
    const offer = offerOf(w, N2);
    assert.equal(offer?.from.id, N);
    assert.deepEqual(
      offer?.fields.map((field) => field.name),
      ['note'],
    );
  });

  test('a damaged mark makes no offer for any link; begin() replaces it by the time of that call', (t) => {
    for (const damaged of ['abc', '', '-5', '1e3', '007']) {
      const w = world(t, { noMark: true });
      cleared(w, LABELLED);
      w.deck.store.setKv(SINCE_KEY, damaged);
      assert.equal(offerOf(w), null, damaged);
      w.clock.setNs(T0 + 10n * SEC);
      w.carry.begin();
      assert.equal(w.deck.store.getKv(SINCE_KEY), String(T0 + 10n * SEC), damaged);
      // The link at T0 + 1 s is older than the new mark less 5 s.
      assert.equal(offerOf(w), null, damaged);
    }
  });

  test('readSince', () => {
    for (const damaged of ['abc', '', '-5', '1e3', '007', '0', ' 1', '1 ']) {
      assert.equal(readSince(damaged), null, JSON.stringify(damaged));
    }
    assert.equal(readSince(null), null);
    assert.equal(readSince(String(T0)), T0);
  });

  test('tick(): a failing write is logged once and tried again; the next tick writes the time of THAT call, and then nothing more is read or written', (t) => {
    const w = world(t, { noMark: true });
    let fail = 2;
    let calls = 0;
    const real = w.deck.store;
    const deck = deckWith(w.deck, {
      store: {
        transaction: <T>(fn: () => T): T => {
          calls++;
          if (fail > 0) {
            fail--;
            throw new Error('boom');
          }
          return real.transaction(fn);
        },
        getKv: (key) => {
          calls++;
          return real.getKv(key);
        },
        setKv: (key, value) => {
          calls++;
          real.setKv(key, value);
        },
      },
    });
    const carry = w.module(deck);

    assert.doesNotThrow(() => carry.tick());
    assert.doesNotThrow(() => carry.tick());
    assert.deepEqual(w.lines, ['carry-over: the first start was not recorded (Error)']);
    assert.equal(real.getKv(SINCE_KEY), null);
    w.clock.setNs(T0 + 7n * SEC);
    carry.tick();
    assert.equal(real.getKv(SINCE_KEY), String(T0 + 7n * SEC));
    const counted = calls;
    w.clock.setNs(T0 + 9n * SEC);
    carry.tick();
    carry.tick();
    assert.equal(calls, counted);
    assert.equal(real.getKv(SINCE_KEY), String(T0 + 7n * SEC));
  });
});

describe('which link, and the answers', () => {
  test('a clear link gives the offer; a switch, a fork and a copy link none', (t) => {
    const w = world(t);
    cleared(w, LABELLED);
    assert.equal(offerOf(w)?.from.id, O);
    for (const kind of ['switch', 'fork', 'copy'] as const) {
      session(w, X);
      link(w, O, X, T0 + SEC, kind);
      assert.equal(offerOf(w, X), null, kind);
      w.deck.store.transaction(() => undefined);
    }
  });

  test('an entry, carried, dismissed or damaged, gives no offer', (t) => {
    for (const value of ['carried', 'dismissed', '???']) {
      const w = world(t);
      cleared(w, LABELLED);
      w.deck.store.setKv(`window_carry_over:${N}`, value);
      assert.equal(offerOf(w), null, value);
    }
  });

  test('the payload: the from part, the default ticks, done offered, a rev of 16 hex digits', (t) => {
    const w = world(t);
    cleared(w, { ...LABELLED, note: 'a note' });
    const offer = offerOf(w);
    assert.ok(offer !== null);
    assert.deepEqual(offer.from, { id: O, title: 'work', ticket: 'TRY-1' });
    assert.deepEqual(
      offer.fields.map((field) => [field.name, field.text, field.ticked]),
      [
        ['label', 'work', true],
        ['group', 'backend', true],
        ['ticket', 'TRY-1', true],
        ['note', null, false],
      ],
    );
    assert.deepEqual(offer.done, { ticked: true });
    assert.match(offer.rev, /^[0-9a-f]{16}$/);
  });
});

describe('carry', () => {
  test('copies exactly the ticked fields; the old session keeps its own; done marks it done; the entry and the ticks are stored', (t) => {
    const w = world(t);
    cleared(w, { ...LABELLED, note: 'old note' });
    pr(w, PR1);
    w.deck.store.attachPr(O, PR1, 'auto', T0);
    const oldMeta = w.deck.store.meta(O);
    const oldPrs = w.deck.store.sessionPrs().filter((row) => row.sessionId === O);
    w.deck.store.setKv(TICKS_KEY, JSON.stringify({ label: true, note: false, prs: true }));
    w.clock.setNs(T0 + 30n * SEC);

    const outcome = w.carry.carry(act(w, { fields: ['label', 'ticket', 'prs'], done: true }));

    assert.deepEqual(outcome, { ok: true });
    const meta = w.deck.store.meta(N);
    assert.equal(meta?.label, 'work');
    assert.equal(meta?.ticket, TICKET);
    assert.equal(meta?.group, null);
    assert.equal(meta?.note, null);
    assert.deepEqual(
      w.deck.store
        .sessionPrs()
        .filter((row) => row.sessionId === N)
        .map((row) => [row.url, row.origin]),
      [[PR1, 'manual']],
    );
    const old = w.deck.store.meta(O);
    assert.equal(old?.doneAtNs, T0 + 30n * SEC);
    assert.deepEqual(
      { ...old, doneAtNs: null, updatedNs: null },
      {
        ...oldMeta,
        doneAtNs: null,
        updatedNs: null,
      },
    );
    assert.deepEqual(
      w.deck.store.sessionPrs().filter((row) => row.sessionId === O),
      oldPrs,
    );
    assert.equal(w.deck.store.getKv(`window_carry_over:${N}`), 'carried');
    assert.deepEqual(JSON.parse(w.deck.store.getKv(TICKS_KEY) ?? 'null'), {
      label: true,
      group: false,
      ticket: true,
      note: false,
      prs: true,
      done: true,
    });
    assert.equal(offerOf(w), null);
  });

  test('without done the old session is not marked done; a not offered checkbox keeps its stored tick', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    w.deck.store.setKv(TICKS_KEY, JSON.stringify({ note: true, group: false }));

    assert.deepEqual(w.carry.carry(act(w, { fields: ['label'], done: false })), { ok: true });

    assert.equal(w.deck.store.meta(O)?.doneAtNs, null);
    assert.deepEqual(JSON.parse(w.deck.store.getKv(TICKS_KEY) ?? 'null'), {
      label: true,
      group: false,
      ticket: true,
      note: true,
      prs: false,
      done: false,
    });
  });

  test('a group taken from the title is replaced by a carried group', (t) => {
    const w = world(t);
    session(w, O);
    session(w, N, { customTitle: 'ABC-12 fix the thing' });
    w.deck.store.updateMeta(O, { group: 'backend' }, T0);
    link(w, O, N, T0 + SEC);

    assert.deepEqual(w.carry.carry(act(w, { fields: ['group'] })), { ok: true });

    assert.equal(w.deck.store.meta(N)?.group, 'backend');
  });

  test('every refusal says why and writes nothing', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    const good = act(w);
    const before = snapshot(w);
    const cases: [string, CarryAct, string][] = [
      ['a wrong rev', { ...good, rev: '0123456789abcdef' }, CHANGED],
      ['a field that is not offered', { ...good, fields: ['label', 'note'] }, CHANGED],
      ['nothing ticked', { ...good, fields: [], done: false }, NOTHING_TICKED],
    ];
    for (const [what, given, error] of cases) {
      assert.deepEqual(w.carry.carry(given), { ok: false, error }, what);
      assert.deepEqual(snapshot(w), before, what);
    }
    // done is offered here (O stopped, not done); a running old session offers none.
    assert.deepEqual(offerOf(w)?.done, { ticked: true });
    w.deck.store.setKv(`window_carry_over:${N}`, 'dismissed');
    const answered = snapshot(w);
    assert.deepEqual(w.carry.carry(good), { ok: false, error: ANSWERED });
    assert.deepEqual(snapshot(w), answered);
  });

  test('done while it is not offered (the old session is done) is refused with the changed words', (t) => {
    const w = world(t);
    cleared(w, { label: 'work', doneAtNs: T0 });
    const offer = offerOf(w);
    assert.equal(offer?.done, null);
    const before = snapshot(w);
    assert.deepEqual(
      w.carry.carry({ sessionId: N, rev: offer?.rev ?? '', fields: ['label'], done: true }),
      { ok: false, error: CHANGED },
    );
    assert.deepEqual(snapshot(w), before);
  });

  test('a label changed between the offer and the act: the rev refusal', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    const given = act(w);
    w.deck.store.updateMeta(O, { label: 'other' }, T0);
    const before = snapshot(w);
    assert.deepEqual(w.carry.carry(given), { ok: false, error: CHANGED });
    assert.deepEqual(snapshot(w), before);
  });

  test('rev: equal for an unchanged store, different after a change of a value, the kept set or the done offer, the same for other ticks', (t) => {
    const w = world(t);
    cleared(w, { label: 'work', group: 'backend' });
    const first = offerOf(w)?.rev;
    assert.equal(offerOf(w)?.rev, first);
    w.deck.store.setKv(TICKS_KEY, JSON.stringify({ label: false, done: false }));
    assert.equal(offerOf(w)?.rev, first);
    w.deck.store.updateMeta(O, { group: 'frontend' }, T0);
    const value = offerOf(w)?.rev;
    assert.notEqual(value, first);
    w.deck.store.updateMeta(N, { group: 'mine' }, T0);
    const kept = offerOf(w)?.rev;
    assert.notEqual(kept, value);
    w.deck.store.updateMeta(O, { doneAtNs: T0 }, T0);
    assert.notEqual(offerOf(w)?.rev, kept);
  });

  test("an old label starting with '-': the offer is computed, and carrying it throws cleanLabel's refusal and writes nothing", (t) => {
    const w = world(t);
    cleared(w, { label: '-dash' });
    const offer = offerOf(w);
    assert.equal(offer?.fields[0]?.text, '-dash');
    const before = snapshot(w);
    assert.throws(() => w.carry.carry(act(w)), UsageError);
    assert.deepEqual(snapshot(w), before);
  });

  test('a last write that throws rolls the copy, the done mark and the entry back', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    const real = w.deck.store;
    const deck = deckWith(w.deck, {
      store: {
        setKv: (key, value) => {
          if (key === TICKS_KEY) throw new Error('disk full');
          real.setKv(key, value);
        },
      },
    });
    const carry = w.module(deck);
    const given = act(w);
    const before = snapshot(w);
    assert.throws(() => carry.carry(given), /disk full/);
    assert.deepEqual(snapshot(w), before);
  });

  test('the next offer of another pair starts from the ticks of the last carry over; the first ever from the defaults (A5)', (t) => {
    const w = world(t);
    cleared(w, { label: 'work', group: 'g' });
    assert.deepEqual(
      offerOf(w)?.fields.map((field) => field.ticked),
      [true, true],
    );
    assert.deepEqual(w.carry.carry(act(w, { fields: ['group'], done: false })), { ok: true });
    session(w, X);
    session(w, Y);
    w.deck.store.updateMeta(X, { label: 'x', group: 'xg', note: 'n' }, T0);
    link(w, X, Y, T0 + 2n * SEC);
    const next = offerOf(w, Y);
    assert.deepEqual(
      next?.fields.map((field) => [field.name, field.ticked]),
      [
        ['label', false],
        ['group', true],
        ['note', false],
      ],
    );
    assert.deepEqual(next?.done, { ticked: false });
  });

  test('two clears: the offer names O, and after N carried it names N', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    session(w, N2);
    link(w, N, N2, T0 + 2n * SEC);
    assert.equal(offerOf(w, N2)?.from.id, O);
    assert.deepEqual(w.carry.carry(act(w)), { ok: true });
    assert.equal(offerOf(w, N2)?.from.id, N);
  });

  test('the chain passes a pull request attached by itself; it stops at one attached by hand, not at one detached again', (t) => {
    for (const how of ['auto', 'manual', 'detached'] as const) {
      const w = world(t);
      cleared(w, { label: 'work' });
      session(w, N2);
      link(w, N, N2, T0 + 2n * SEC);
      pr(w, PR1);
      if (how === 'auto') w.deck.store.attachPr(N, PR1, 'auto', T0);
      else attachManualPr(w.deck, N, PR1);
      if (how === 'detached') {
        detachSessionPr(w.deck, N, PR1);
        // a pull request the scan attached is there too: it does not stop the walk
        pr(w, PR2);
        w.deck.store.attachPr(N, PR2, 'auto', T0);
      }
      const offer = offerOf(w, N2);
      assert.equal(offer?.from.id, how === 'manual' ? N : O, how);
      if (how === 'manual') continue;
      const nMeta = w.deck.store.meta(N);
      const nPrs = w.deck.store.sessionPrs().filter((row) => row.sessionId === N);
      assert.deepEqual(
        w.carry.carry(act(w, { sessionId: N2, done: true, fields: ['label'] })),
        { ok: true },
        how,
      );
      assert.notEqual(w.deck.store.meta(O)?.doneAtNs, null, how);
      assert.deepEqual(w.deck.store.meta(N), nMeta, how);
      assert.deepEqual(
        w.deck.store.sessionPrs().filter((row) => row.sessionId === N),
        nPrs,
        how,
      );
      assert.equal(w.deck.store.meta(N2)?.label, 'work', how);
    }
  });

  test('the resume lock: no done offered while it is held; an act drawn before it is refused; offered again once released', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    const drawn = act(w);
    assert.equal(drawn.done, true);
    acquireLock(w.deck, O, { latestEventId: w.deck.store.latestEventIdOfSession(O) });
    assert.equal(offerOf(w)?.done, null);
    const before = snapshot(w);
    assert.deepEqual(w.carry.carry(drawn), { ok: false, error: CHANGED });
    assert.deepEqual(snapshot(w), before);
    assert.equal(w.deck.store.meta(O)?.doneAtNs, null);
    w.deck.store.deleteKv(`resume_lock:${O}`);
    assert.deepEqual(offerOf(w)?.done, { ticked: true });
  });
});

describe('carry: the review of 4035aed', () => {
  test('a stored done tick is kept when done is not offered', (t) => {
    const w = world(t);
    cleared(w, { label: 'work', doneAtNs: T0 });
    w.deck.store.setKv(TICKS_KEY, JSON.stringify({ done: true }));
    assert.equal(offerOf(w)?.done, null);

    assert.deepEqual(w.carry.carry(act(w, { fields: ['label'], done: false })), { ok: true });

    // The act sends done false (it is not offered); the stored tick stays the one of the last
    // carry over that offered it.
    assert.equal(JSON.parse(w.deck.store.getKv(TICKS_KEY) ?? 'null').done, true);
  });

  test('a carried note removes the note file a failed editor kept for the new session', (t) => {
    const w = world(t);
    cleared(w, { note: 'the plan' });
    const kept = keptNotePath(w.deck, N);
    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, 'unsaved text');

    assert.deepEqual(w.carry.carry(act(w, { fields: ['note'], done: false })), { ok: true });

    assert.equal(w.deck.store.meta(N)?.note, 'the plan');
    assert.equal(existsSync(kept), false);
  });

  test('a stored group that cleanGroup refuses (a line separator): the carry throws its refusal and writes nothing', (t) => {
    const w = world(t);
    cleared(w, { group: 'a\u2028b' });
    assert.equal(offerOf(w)?.fields[0]?.name, 'group');
    const before = snapshot(w);
    assert.throws(() => w.carry.carry(act(w, { fields: ['group'], done: false })), UsageError);
    assert.deepEqual(snapshot(w), before);
  });
});

describe('the guard of offer()', () => {
  test('a store whose linksTo throws: null, no throw, one log line per kind until a read works', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    let broken = true;
    const real = w.deck.store;
    const deck = deckWith(w.deck, {
      store: {
        linksTo: (id) => {
          if (broken) throw new TypeError('gone');
          return real.linksTo(id);
        },
      },
    });
    const carry = w.module(deck);
    const rows = loadRows(w.deck);
    for (let i = 0; i < 3; i++) assert.equal(carry.offer(rows, N), null);
    assert.deepEqual(w.lines, ['carry-over: the offer was not read (TypeError)']);
    broken = false;
    assert.equal(carry.offer(rows, N)?.from.id, O);
    broken = true;
    assert.equal(carry.offer(rows, N), null);
    assert.equal(w.lines.length, 2);
    const before = snapshot(w);
    assert.throws(
      () => carry.carry({ sessionId: N, rev: '0123456789abcdef', fields: ['label'], done: false }),
      TypeError,
    );
    assert.deepEqual(snapshot(w), before);
  });
});

describe('dismiss', () => {
  test('writes dismissed; a second one writes nothing and is ok; one without a clear link is refused', (t) => {
    const w = world(t);
    cleared(w, { label: 'work' });
    assert.deepEqual(w.carry.dismiss(N), { ok: true, changed: true });
    assert.equal(w.deck.store.getKv(`window_carry_over:${N}`), 'dismissed');
    assert.deepEqual(w.carry.dismiss(N), { ok: true, changed: false });
    assert.equal(offerOf(w), null);
    session(w, X);
    assert.deepEqual(w.carry.dismiss(X), { ok: false, error: NO_OFFER_TO_DISMISS });
    assert.equal(w.deck.store.getKv(`window_carry_over:${X}`), null);
    assert.equal(w.deck.store.meta(N), null, 'nothing copied');
    assert.equal(w.deck.store.meta(X), null);
  });
});

describe('sweep', () => {
  test('removes the answers of sessions that cannot be shown, keeps the others and the two other keys', (t) => {
    const w = world(t);
    const noTranscript = sid(10);
    const expired = sid(11);
    const listed = sid(12);
    const done = sid(13);
    const unknown = sid(14);
    link(w, O, noTranscript, T0 + SEC);
    session(w, expired, { missingSinceNs: T0 });
    session(w, listed);
    session(w, done);
    w.deck.store.updateMeta(done, { doneAtNs: T0 }, T0);
    w.deck.store.setKv(TICKS_KEY, '{"label":false}');
    for (const id of [noTranscript, expired, listed, done, unknown]) {
      w.deck.store.setKv(`window_carry_over:${id}`, 'carried');
    }
    const since = w.deck.store.getKv(SINCE_KEY);

    assert.equal(w.carry.sweep([]), 0);
    assert.equal(w.carry.sweep(loadRows(w.deck)), 2);

    assert.deepEqual(
      w.deck.store.kvEntries('window_carry_over').map((entry) => entry.key),
      [
        `window_carry_over:${listed}`,
        `window_carry_over:${done}`,
        `window_carry_over:${unknown}`,
        'window_carry_over_since',
        'window_carry_over_ticks',
      ].sort(),
    );
    assert.equal(w.deck.store.getKv(SINCE_KEY), since);
    assert.equal(w.deck.store.getKv(TICKS_KEY), '{"label":false}');
  });
});
