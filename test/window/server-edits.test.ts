// Editing in the window, end to end on the server (S2 12.5, 12.10, 10.1; plan D, task 36): two
// pages of one server, the edits through `act`, what every page's `list` shows within a second
// (D7), the note refused by its base (D9), a pull request attached and fetched in the background
// (D8) with test/helpers/gh.ts answering `gh`, the server's stop not waiting for a fetch, a running
// session marked done, the ticket address in `selected`. In the test process (A19) on
// realTestPlatform, with real keepers running the stand-in.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ListMessage, RowPayload } from '../../src/window/protocol.ts';
import { APPROVED_GREEN, ghRunner } from '../helpers/gh.ts';
import type { GhOptions, GhRunner } from '../helpers/gh.ts';
import { S1 } from '../helpers/platform.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

const PR7 = 'https://github.com/acme/web/pull/7';
const NOTE_CHANGED =
  'the note was changed elsewhere while you edited it; your text is still in the box';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return rowsOf(list).find((row) => row.id === sessionId);
}

/** A server on a sandbox where S1 is resumable, its runner answering `gh` as `options` says. */
async function serverWithGh(
  t: Parameters<typeof serverSandbox>[0],
  options: GhOptions = {},
  config: Record<string, unknown> = {},
): Promise<{ d: ServerSandbox; test: TestServer; gh: GhRunner }> {
  const d = serverSandbox(t, { config });
  d.resumable(S1);
  let gh: GhRunner | null = null;
  const test = await d.start({
    platform: (platform) => {
      gh = ghRunner(platform.runner, options);
      return { ...platform, runner: gh };
    },
  });
  assert.ok(gh !== null);
  return { d, test, gh };
}

/** A page of `test` that lists S1 (selected when `selected`), once the server has read it; and that list. */
async function pageWithS1(
  t: Parameters<typeof serverSandbox>[0],
  d: ServerSandbox,
  test: TestServer,
  selected = false,
): Promise<{ page: TestPage; list: ListMessage }> {
  const page = await connectTestPage(t, d, test.server, {
    view: selected ? { selected: S1 } : {},
  });
  const list = await page.list(
    (candidate) =>
      rowOf(candidate, S1) !== undefined && (!selected || candidate.selected?.sessionId === S1),
    'S1 listed',
  );
  return { page, list };
}

describe('editing in the window (S2 12.5; plan D7, D9)', () => {
  test("a label set from page A is in page B's list within 1.5 s, and in the store", async (t) => {
    const { d, test } = await serverWithGh(t);
    const { page: a } = await pageWithS1(t, d, test);
    const { page: b } = await pageWithS1(t, d, test);
    const sent = performance.now();
    const result = await a.act({ kind: 'label', sessionId: S1, text: 'fix the retry' });
    assert.equal(result.ok, true, JSON.stringify(result));
    await b.list((list) => rowOf(list, S1)?.title === 'fix the retry', 'the label in B', 1500);
    assert.ok(performance.now() - sent < 1500, `${Math.round(performance.now() - sent)} ms`);
    assert.equal(d.deck.store.meta(S1)?.label, 'fix the retry');
  });

  test("a note saved from page A, then from page B with the old base: B is refused with S2 12.5's message; the store holds A's", async (t) => {
    const { d, test } = await serverWithGh(t);
    const { page: a } = await pageWithS1(t, d, test, true);
    const { page: b, list } = await pageWithS1(t, d, test, true);
    assert.equal(list.selected?.note, null, 'no note yet: the dialog starts from base ""');
    const fromA = await a.act({ kind: 'note', sessionId: S1, text: 'from A', base: '' });
    assert.equal(fromA.ok, true, JSON.stringify(fromA));
    const fromB = await b.act({ kind: 'note', sessionId: S1, text: 'from B', base: '' });
    assert.deepEqual([fromB.ok, fromB.lines, fromB.error], [false, [NOTE_CHANGED], NOTE_CHANGED]);
    assert.equal(d.deck.store.meta(S1)?.note, 'from A');
    await b.list((list) => list.selected?.note === 'from A', "A's note in B's selected");
  });

  test('a running session marked done stays in Open with its done mark (S2 12.10)', async (t) => {
    const { d, test } = await serverWithGh(t);
    const { page } = await pageWithS1(t, d, test);
    const resumed = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    const open = (list: ListMessage): RowPayload | undefined =>
      list.sections.find((section) => section.name === 'open')?.rows.find((row) => row.id === S1);
    await page.list((list) => {
      const row = open(list);
      return row !== undefined && !row.starting && row.state !== 'not-running';
    }, 'S1 running in Open');
    const done = await page.act({ kind: 'done', sessionId: S1 });
    assert.equal(done.ok, true, JSON.stringify(done));
    await page.list((list) => open(list)?.done === true, 'S1 in Open, marked done');
    assert.notEqual(d.deck.store.meta(S1)?.doneAtNs, null);
  });

  test("with ticketUrl configured, a label 'ABC-12 try' makes selected.ticketUrl the ticket's address", async (t) => {
    const { d, test } = await serverWithGh(
      t,
      {},
      { ticketUrl: 'https://example.atlassian.net/browse/{key}' },
    );
    const { page } = await pageWithS1(t, d, test, true);
    const result = await page.act({ kind: 'label', sessionId: S1, text: 'ABC-12 try' });
    assert.equal(result.ok, true, JSON.stringify(result));
    await page.list(
      (list) => list.selected?.ticketUrl === 'https://example.atlassian.net/browse/ABC-12',
      'the ticket address',
    );
  });

  test('a label holding an escape sequence is refused, and no line of the refusal holds a control character', async (t) => {
    const { d, test } = await serverWithGh(t);
    const { page } = await pageWithS1(t, d, test);
    const result = await page.act({ kind: 'label', sessionId: S1, text: 'red \x1b[31mtext\x07' });
    assert.equal(result.ok, false);
    assert.ok(result.lines.length > 0);
    for (const line of [...result.lines, result.error ?? '']) {
      assert.ok(!CONTROL.test(line), JSON.stringify(line));
    }
    assert.equal(d.deck.store.meta(S1), null, 'nothing written');
  });
});

describe('pull requests in the window (S2 12.5, design 7.3; plan D8)', () => {
  test('pr-add: a list with the pull request not fetched, then one with approved-green and its last read', async (t) => {
    const { d, test, gh } = await serverWithGh(t, { hold: 'held' });
    const { page } = await pageWithS1(t, d, test);
    const result = await page.act({ kind: 'pr-add', sessionId: S1, url: PR7 });
    assert.deepEqual([result.ok, result.lines], [true, [`attached ${PR7}`]], 'answered first');
    const pending = await page.list(
      (list) => rowOf(list, S1)?.prs.some((pr) => pr.url === PR7) === true,
      'the pull request attached',
    );
    const before = rowOf(pending, S1)?.prs.find((pr) => pr.url === PR7);
    assert.deepEqual([before?.level, before?.okAtNs], ['unfetched', null]);
    await gh.started(1);
    gh.release();
    const read = await page.list(
      (list) => rowOf(list, S1)?.prs.find((pr) => pr.url === PR7)?.level === 'approved-green',
      'the pull request read',
    );
    const after = rowOf(read, S1)?.prs.find((pr) => pr.url === PR7);
    assert.match(after?.okAtNs ?? '', /^[1-9][0-9]*$/);
    assert.ok(
      gh.runs.every((run) => run.prs.join() === 'acme/web#7'),
      JSON.stringify(gh.runs),
    );
  });

  test('pr-refresh of a pull request read before: the list follows the fetch, although no refresh owes a reload', async (t) => {
    const { d, test, gh } = await serverWithGh(t);
    const { page } = await pageWithS1(t, d, test);
    const levelOf = (list: ListMessage): string | undefined =>
      rowOf(list, S1)?.prs.find((pr) => pr.url === PR7)?.level;
    assert.equal((await page.act({ kind: 'pr-add', sessionId: S1, url: PR7 })).ok, true);
    await page.list((list) => levelOf(list) === 'approved-green', 'read once');
    gh.set({ hold: 'held', answer: { ...APPROVED_GREEN, reviewDecision: 'CHANGES_REQUESTED' } });
    const runs = gh.runs.length;
    assert.equal((await page.act({ kind: 'pr-refresh', sessionId: S1 })).ok, true);
    await gh.started(runs + 1);
    // A refresh of the tick passes meanwhile: the reload the act left owed is made, and the pull
    // request was read a moment ago, so the tick's own refresh does not ask about it.
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const released = performance.now();
    gh.release();
    await page.list((list) => levelOf(list) === 'changes-requested', 'the state refreshed', 1500);
    assert.ok(performance.now() - released < 1500);
    assert.equal(gh.runs.length, runs + 1, "the window's refresh, and no run of the tick's");
  });

  test('the server stopped while a fetch waits for gh: the stop does not wait for it', async (t) => {
    // Held until its signal fires (gh's own 10 s never come); release() only frees a stop that
    // would otherwise hang, so that a regression fails this case instead of the whole file.
    const { d, test, gh } = await serverWithGh(t, { hold: 'held' });
    // The page lists nothing: the tick's own pull-request refresh asks about nothing.
    const page = await connectTestPage(t, d, test.server, { view: { filter: 'nothing-matches' } });
    await page.next('list', 'the first list');
    const result = await page.act({ kind: 'pr-add', sessionId: S1, url: PR7 });
    assert.equal(result.ok, true, JSON.stringify(result));
    await gh.started(1);
    const stopping = performance.now();
    const stopped = test.server.stop('the test stops it').then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    });
    const inTime = await Promise.race([stopped, late]);
    clearTimeout(timer); // the file's process does not wait for it
    const took = performance.now() - stopping;
    if (!inTime) gh.release();
    await stopped;
    assert.ok(inTime, `the stop waited for gh: ${Math.round(took)} ms`);
    assert.equal(gh.runs.length, 1);
    assert.equal(d.deck.store.prs()[0]?.triedAtNs, null, 'nothing saved after the abort');
  });
});
