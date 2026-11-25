// The mark unread end to end on the window's server (S2 12.4, 10.2, 13; E2 of its brief): `act
// unread` on the session a focused page has selected, and the mark's life — it stays while that
// page stays on it past 1.5 s, while its window loses and regains the focus, while a second page
// has it selected, after a page reloads or reconnects with it selected and after a server restart;
// it goes when a selection moves away and back and holds 1.5 s (not sooner), at a typing into its
// terminal (not at a report the terminal sends by itself), and at `act read`. It sends no
// notification and counts in `needYou`. In the test process on realTestPlatform, with a real keeper
// running the stand-in; every wait is for a fact (a list, a stored value, a round trip), and the
// 1.5 s are waited on a timer set after the server's own.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AttentionRow } from '../../src/store/types.ts';
import type { ListMessage, NotifyMessage, RowPayload } from '../../src/window/protocol.ts';
import { SEEN_AFTER_MS } from '../../src/window/seen.ts';
import { sleep, until } from '../helpers/keeper.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { connectTestPage, rowsOf, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return rowsOf(list).find((row) => row.id === sessionId);
}

function reasonOf(list: ListMessage, sessionId: string): string | null {
  return rowOf(list, sessionId)?.attention?.reason ?? null;
}

function stored(d: ServerSandbox, sessionId: string): AttentionRow | undefined {
  return d.deck.store.attention().find((row) => row.sessionId === sessionId);
}

/** Whether the store holds `sessionId` unread (S2 10.2: by the counter). */
function unread(d: ServerSandbox, sessionId: string): boolean {
  const row = stored(d, sessionId);
  return (
    row !== undefined &&
    row.unreadSeq !== null &&
    (row.seenSeq === null || row.unreadSeq > row.seenSeq)
  );
}

/** The page's selection and focus as the page sends them: `view` with the selection, then `focus`. */
function show(page: TestPage, focused: boolean, selected: string | null): void {
  page.view({ selected });
  page.send({ t: 'focus', focused, selected, area: { cols: 80, rows: 24 } });
}

let pings = 9000;

/** A ping and its pong: everything the server sent before it is in `page.all` afterwards. */
async function roundTrip(page: TestPage): Promise<void> {
  const n = ++pings;
  page.send({ t: 'ping', n });
  for (;;) {
    const pong = await page.next('pong', `the pong ${n}`);
    if (pong.n === n) return;
  }
}

/** Longer than a hold the server began before the last round trip (its timer set first). */
async function pastAHold(page: TestPage): Promise<void> {
  await roundTrip(page);
  await sleep(SEEN_AFTER_MS + 100);
  await roundTrip(page);
}

function notifies(page: TestPage): NotifyMessage[] {
  return page.all.flatMap((item) =>
    'text' in item && item.text.t === 'notify' ? [item.text] : [],
  );
}

/** Resumes `sessionId` in a window terminal from `page` and waits for the stand-in's prompt. */
async function resumed(page: TestPage, test: TestServer, sessionId: string): Promise<string> {
  const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const term = test.server.hub.list().find((info) => info.expectedSessionId === sessionId)?.id;
  assert.ok(term !== undefined, 'its terminal');
  page.send({ t: 'attach', term, cols: 80, rows: 24 });
  let snap = await page.next('snap', 'the snap');
  while (snap.term !== term) snap = await page.next('snap', 'the snap');
  const prompt = `standin ${sessionId.slice(0, 8)}> `;
  const { ch, data } = snap;
  await until(
    () => (data + page.output(ch)).includes(prompt),
    () => `${JSON.stringify(prompt)} in ${JSON.stringify(page.output(ch).slice(-300))}`,
    WAIT_MS,
  );
  return term;
}

/** A page that comes as a loaded or reconnected one does: `start`, then its view and focus. */
async function arrive(
  t: Parameters<typeof connectTestPage>[0],
  d: ServerSandbox,
  test: TestServer,
  selected: string,
): Promise<TestPage> {
  const page = await connectTestPage(t, d, test.server, { view: { selected } });
  show(page, true, selected);
  return page;
}

describe('the mark unread on the server (S2 12.4)', () => {
  test('marked on the selected session it stays: past 1.5 s, focus lost and regained, a second page on it, a reload, a reconnect; no notify, counted; a move away and back held 1.5 s reads it, not sooner', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const page = await arrive(t, d, test, S2);
    show(page, true, S1); // the user came to S1 and read it
    await pastAHold(page);
    const other = await arrive(t, d, test, S1);
    await pastAHold(other);

    const answer = await page.act({ kind: 'unread', sessionId: S1 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const marked = await page.list((list) => reasonOf(list, S1) === 'unread', 'S1 unread');
    assert.equal(marked.needYou.count, 1);
    assert.deepEqual(marked.needYou.order, [S1]);
    assert.ok(unread(d, S1));

    // The page that marked it and the second one stay on it.
    await pastAHold(page);
    await pastAHold(other);
    assert.ok(unread(d, S1), 'staying on it reads nothing');
    // Its window loses the focus and gets it back.
    show(page, false, S1);
    show(page, true, S1);
    await pastAHold(page);
    assert.ok(unread(d, S1), 'focus lost and regained reads nothing');
    // A page that reloads, or reconnects, with it selected.
    await other.close();
    const reloaded = await arrive(t, d, test, S1);
    await pastAHold(reloaded);
    assert.ok(unread(d, S1), 'a page that comes with it selected reads nothing');
    assert.deepEqual(
      [...notifies(page), ...notifies(reloaded)],
      [],
      'the mark sends no notification',
    );

    // A selection that moves away and back: read after 1.5 s, not sooner.
    show(page, true, S2);
    show(page, true, S1);
    await roundTrip(page);
    const from = performance.now();
    await sleep(SEEN_AFTER_MS - 500);
    assert.ok(unread(d, S1), 'not before the 1.5 s');
    await page.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'S1 read by the coming back',
    );
    assert.ok(performance.now() - from >= SEEN_AFTER_MS - 500);
    assert.equal(unread(d, S1), false);
  });

  test('a server restart keeps the mark, also with the pages coming back with it selected; `read` clears it', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const first = await d.start();
    const page = await arrive(t, d, first, S1);
    await pastAHold(page);
    assert.equal((await page.act({ kind: 'unread', sessionId: S1 })).ok, true);
    await page.list((list) => reasonOf(list, S1) === 'unread', 'S1 unread');
    await first.server.stop('the test restarts the server');

    const second = await d.start();
    const back = await arrive(t, d, second, S1);
    await back.list((list) => reasonOf(list, S1) === 'unread', 'S1 still unread');
    await pastAHold(back);
    assert.ok(unread(d, S1), 'the page that came back with it selected reads nothing');

    const answer = await back.act({ kind: 'read', sessionId: S1 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    await back.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'S1 read by `read`',
    );
    assert.equal(unread(d, S1), false);
  });

  test('typing into its terminal reads it at once; a focus report the terminal sends by itself does not', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2);
    const test = await d.start();
    const page = await arrive(t, d, test, S1);
    const term = await resumed(page, test, S1);
    await pastAHold(page);
    assert.equal((await page.act({ kind: 'unread', sessionId: S1 })).ok, true);
    await page.list((list) => reasonOf(list, S1) === 'unread', 'S1 unread');

    page.send({ t: 'input', term, data: '\x1b[I' });
    page.send({ t: 'input', term, data: '\x1b[O' });
    await pastAHold(page);
    assert.ok(unread(d, S1), 'a focus report is no typing');

    page.send({ t: 'input', term, data: 'x' });
    await roundTrip(page);
    assert.equal(unread(d, S1), false, 'written on the input path itself');
    await page.list(
      (list) => rowOf(list, S1) !== undefined && reasonOf(list, S1) === null,
      'read by the typing',
    );
  });

  test('refused for a session marked done, in the words the page shows; nothing stored', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const page = await arrive(t, d, test, S1);
    assert.equal((await page.act({ kind: 'done', sessionId: S1 })).ok, true);
    const answer = await page.act({ kind: 'unread', sessionId: S1 });
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'it is marked done: a done session needs nothing');
    assert.equal(stored(d, S1)?.unreadSeq ?? null, null);
  });
});
