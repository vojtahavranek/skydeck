// The carry over after `/clear`, end to end on the server (follow-up F40, design 7.1, S2 12.6,
// 8.2.3, 10.2): a session resumed into a window terminal running the stand-in, `/clear` typed
// into it, the new session's `selected.carryOver` on every page, the two acts, the answers across a
// restart of the server, and the mark of the first start, which keeps a `/clear` recorded before
// it from making an offer. In the test process (A19) on realTestPlatform, with real keepers; these
// servers run on the real clock, as the stand-in's hook does.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Ns } from '../../src/platform/types.ts';
import { attachManualPr } from '../../src/sessions/meta.ts';
import { CHANGED, NO_OFFER_TO_DISMISS, SINCE_KEY } from '../../src/window/carry-over.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { ghRunner } from '../helpers/gh.ts';
import { until } from '../helpers/keeper.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

const PR7 = 'https://github.com/acme/web/pull/7';
const TICKET = 'https://example.com/browse/TRY-1';

/** Starts a server on `d` whose runner answers `gh` from the test (no network). */
function start(d: ServerSandbox): Promise<TestServer> {
  return d.start({ platform: (platform) => ({ ...platform, runner: ghRunner(platform.runner) }) });
}

/** S1 with all five fields set. */
function fiveFields(d: ServerSandbox): void {
  const now = d.platform.clock.nowNs();
  d.deck.store.updateMeta(
    S1,
    { label: 'fix the retry', group: 'backend', ticket: TICKET, note: 'the plan' },
    now,
  );
  attachManualPr(d.deck, S1, PR7);
}

/** The terminal of `sessionId` in `list`, or undefined. */
function termOf(list: ListMessage, sessionId: string): string | undefined {
  return list.terminals.find((term) => term.sessionId === sessionId)?.id;
}

/** S1 resumed into a window terminal of `page`, running; its terminal's id. */
async function resumeS1(page: TestPage): Promise<string> {
  const resumed = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const list = await page.list(
    (candidate) =>
      termOf(candidate, S1) !== undefined &&
      rowsOf(candidate).some((row) => row.id === S1 && row.state !== 'not-running'),
    'S1 running in a window terminal',
  );
  const term = termOf(list, S1);
  assert.ok(term !== undefined);
  return term;
}

/** `/clear` typed into `term`, whose session is `from`: the new session's id, once its row is listed. */
async function clear(page: TestPage, term: string, from: string): Promise<string> {
  page.send({ t: 'input', term, data: '/clear\r' });
  const list = await page.list((candidate) => {
    const now = candidate.terminals.find((one) => one.id === term)?.sessionId;
    return now != null && now !== from && rowsOf(candidate).some((row) => row.id === now);
  }, 'the terminal on the new session');
  const id = list.terminals.find((one) => one.id === term)?.sessionId;
  assert.ok(typeof id === 'string');
  return id;
}

/** A page of `server` selecting `sessionId`; the first list that has it selected. */
async function selecting(
  t: TestContext,
  d: ServerSandbox,
  server: TestServer,
  sessionId: string,
  test: (list: ListMessage) => boolean = () => true,
): Promise<{ page: TestPage; list: ListMessage }> {
  const page = await connectTestPage(t, d, server.server, { view: { selected: sessionId } });
  const list = await page.list(
    (candidate) => candidate.selected?.sessionId === sessionId && test(candidate),
    `${sessionId} selected`,
  );
  return { page, list };
}

/** A server on a sandbox with S1 resumable (fields as `fields` sets them), S1 resumed and cleared. */
async function clearedInWindow(
  t: TestContext,
  fields: (d: ServerSandbox) => void = fiveFields,
): Promise<{ d: ServerSandbox; server: TestServer; page: TestPage; term: string; n: string }> {
  const d = serverSandbox(t);
  d.resumable(S1);
  fields(d);
  const server = await start(d);
  const page = await connectTestPage(t, d, server.server);
  const term = await resumeS1(page);
  const n = await clear(page, term, S1);
  return { d, server, page, term, n };
}

/** Spool files of one process: a start of `first`, then a start of `second` with `source`. */
function spoolMove(
  d: ServerSandbox,
  first: string,
  second: string,
  source: 'clear' | 'resume' | 'fork',
  atNs: Ns,
  pid: number,
): void {
  const dir = d.deck.places.spoolDir;
  const one = {
    event: 'SessionStart' as const,
    timeNs: atNs,
    pid,
    input: hookInput('SessionStart', first, { source: 'startup' }),
  };
  const two = {
    event: 'SessionStart' as const,
    timeNs: atNs + 1_000_000_000n,
    pid,
    input: hookInput('SessionStart', second, { source }),
  };
  writeFileSync(join(dir, spoolName(one, 1)), spoolText(one));
  writeFileSync(join(dir, spoolName(two, 2)), spoolText(two));
}

describe('the offer after /clear in a window terminal (F40)', () => {
  test('the new session gets the five fields, three ticked and done; Carry over from A writes exactly that, and B follows within 1.5 s', async (t) => {
    const { d, server, n } = await clearedInWindow(t);
    const { page: a, list } = await selecting(
      t,
      d,
      server,
      n,
      (l) => l.selected?.carryOver !== undefined,
    );
    const offer = list.selected?.carryOver;
    assert.ok(offer !== undefined);
    assert.equal(offer.from.id, S1);
    assert.equal(offer.from.title, 'fix the retry');
    assert.equal(offer.from.ticket, 'TRY-1');
    assert.deepEqual(
      offer.fields.map((field) => [field.name, field.ticked]),
      [
        ['label', true],
        ['group', true],
        ['ticket', true],
        ['note', false],
        ['prs', false],
      ],
    );
    assert.equal(offer.prs, 1);
    assert.deepEqual(offer.done, { ticked: true });
    const { page: b } = await selecting(
      t,
      d,
      server,
      n,
      (l) => l.selected?.carryOver !== undefined,
    );
    const before = d.deck.store.meta(S1);
    const sent = performance.now();
    const result = await a.act({
      kind: 'carry-over',
      sessionId: n,
      rev: offer.rev,
      fields: ['label'],
      done: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await b.list(
      (l) =>
        rowsOf(l).some((row) => row.id === n && row.title === 'fix the retry') &&
        l.selected?.carryOver === undefined,
      "the label on B's new row, and no offer",
      1500,
    );
    assert.ok(performance.now() - sent < 1500, `${Math.round(performance.now() - sent)} ms`);
    const meta = d.deck.store.meta(n);
    assert.deepEqual(
      [meta?.label, meta?.group, meta?.ticket, meta?.note],
      ['fix the retry', null, null, null],
    );
    assert.deepEqual(
      d.deck.store.sessionPrs().filter((row) => row.sessionId === n),
      [],
    );
    const old = d.deck.store.meta(S1);
    assert.notEqual(old?.doneAtNs, null);
    assert.deepEqual(
      [old?.label, old?.group, old?.ticket, old?.note],
      [before?.label, before?.group, before?.ticket, before?.note],
    );
    assert.equal(d.deck.store.getKv(`window_carry_over:${n}`), 'carried');
  });

  test('with no field on the old session no offer', async (t) => {
    const { d, server, n } = await clearedInWindow(t, () => undefined);
    const { list } = await selecting(t, d, server, n);
    assert.equal(list.selected?.carryOver, undefined);
  });

  test("a resume's and a fork's move out of a labelled session make no offer", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    d.resumable(S3);
    d.deck.store.updateMeta(S1, { label: 'work' }, d.platform.clock.nowNs());
    const server = await start(d);
    const now = d.platform.clock.nowNs();
    spoolMove(d, S1, S2, 'resume', now, 61001);
    spoolMove(d, S1, S3, 'fork', now + 3_000_000_000n, 61002);
    await until(
      () => d.deck.store.linksTo(S2).length > 0 && d.deck.store.linksTo(S3).length > 0,
      'both links ingested',
      10_000,
    );
    assert.deepEqual(
      [d.deck.store.linksTo(S2)[0]?.kind, d.deck.store.linksTo(S3)[0]?.kind],
      ['switch', 'fork'],
    );
    for (const id of [S2, S3]) {
      const { list } = await selecting(t, d, server, id);
      assert.equal(list.selected?.carryOver, undefined, id);
    }
  });

  test('a stale rev after the old label was changed from page B is refused, nothing written', async (t) => {
    const { d, server, n } = await clearedInWindow(t);
    const { page: a, list } = await selecting(
      t,
      d,
      server,
      n,
      (l) => l.selected?.carryOver !== undefined,
    );
    const offer = list.selected?.carryOver;
    assert.ok(offer !== undefined);
    const b = await connectTestPage(t, d, server.server);
    const changed = await b.act({ kind: 'label', sessionId: S1, text: 'another label' });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const result = await a.act({
      kind: 'carry-over',
      sessionId: n,
      rev: offer.rev,
      fields: ['label', 'group'],
      done: true,
    });
    assert.deepEqual([result.ok, result.error], [false, CHANGED]);
    assert.equal(d.deck.store.meta(n), null);
    assert.equal(d.deck.store.meta(S1)?.doneAtNs, null);
    assert.equal(d.deck.store.getKv(`window_carry_over:${n}`), null);
  });

  test('× ends the offer on both pages and after a restart; a second clear names S1 and its offer survives the restart (A4, A7)', async (t) => {
    const { d, server, page, term, n } = await clearedInWindow(t);
    const { page: a } = await selecting(
      t,
      d,
      server,
      n,
      (l) => l.selected?.carryOver !== undefined,
    );
    const { page: b } = await selecting(
      t,
      d,
      server,
      n,
      (l) => l.selected?.carryOver !== undefined,
    );
    const dismissed = await a.act({ kind: 'dismiss-carry-over', sessionId: n });
    assert.equal(dismissed.ok, true, JSON.stringify(dismissed));
    for (const one of [a, b]) {
      await one.list(
        (l) => l.selected?.sessionId === n && l.selected.carryOver === undefined,
        'no offer',
      );
    }
    const n2 = await clear(page, term, n);
    const { list: second } = await selecting(
      t,
      d,
      server,
      n2,
      (l) => l.selected?.carryOver !== undefined,
    );
    assert.equal(second.selected?.carryOver?.from.id, S1);

    // The stand-in writes no transcript: N gets one, so that it stays a session the list can show
    // (an answer of a session that can never be shown is swept at the start, S2 10.2).
    d.resumable(n);
    await server.server.stop('the test restarts it');
    const again = await start(d);
    assert.equal(d.deck.store.getKv(`window_carry_over:${n}`), 'dismissed');
    const { list: afterN } = await selecting(t, d, again, n);
    assert.equal(afterN.selected?.carryOver, undefined);
    assert.equal(d.deck.store.meta(n), null, 'nothing copied');
    const { list: afterN2 } = await selecting(
      t,
      d,
      again,
      n2,
      (l) => l.selected?.carryOver !== undefined,
    );
    assert.equal(afterN2.selected?.carryOver?.from.id, S1);
  });
});

describe('the mark of the first start (F40)', () => {
  test('a /clear recorded before the first start makes no offer; one typed after it does; a restart keeps the mark', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    d.deck.store.updateMeta(S1, { label: 'old work' }, d.platform.clock.nowNs());
    const minuteAgo = d.platform.clock.nowNs() - 60_000_000_000n;
    spoolMove(d, S1, S2, 'clear', minuteAgo, 61003);
    const server = await start(d);
    await until(() => d.deck.store.linksTo(S2).length > 0, 'the old link ingested', 10_000);
    assert.equal(d.deck.store.linksTo(S2)[0]?.kind, 'clear');
    const mark = d.deck.store.getKv(SINCE_KEY);
    assert.match(mark ?? '', /^[1-9][0-9]*$/);
    const { page, list } = await selecting(t, d, server, S2);
    assert.equal(list.selected?.carryOver, undefined);
    const refused = await page.act({ kind: 'dismiss-carry-over', sessionId: S2 });
    assert.deepEqual([refused.ok, refused.error], [false, NO_OFFER_TO_DISMISS]);

    const term = await resumeS1(page);
    const n = await clear(page, term, S1);
    const { list: fresh } = await selecting(
      t,
      d,
      server,
      n,
      (l) => l.selected?.carryOver !== undefined,
    );
    assert.equal(fresh.selected?.carryOver?.from.id, S1);

    await server.server.stop('the test restarts it');
    const again = await start(d);
    assert.equal(d.deck.store.getKv(SINCE_KEY), mark);
    const { list: oldAgain } = await selecting(t, d, again, S2);
    assert.equal(oldAgain.selected?.carryOver, undefined);
    const { list: newAgain } = await selecting(
      t,
      d,
      again,
      n,
      (l) => l.selected?.carryOver !== undefined,
    );
    assert.equal(newAgain.selected?.carryOver?.from.id, S1);
  });
});
