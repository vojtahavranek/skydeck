// What the pages tell Seen and how a `notify` goes out (S2 12.4, 13; plan B task 54, contract 2.7,
// B9, B12, F1): a page's focus and selection from its `start` and each `focus`, its typing into a
// terminal (an `input` for which isTyping is true — never a focus or mouse report, never binary),
// its end; `notify` to the page that had focus last while no page has it. Against startPages' fake
// hub, with a recording Seen.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { PagesDeps } from '../../src/window/pages.ts';
import type { NotifyMessage, ServerMessage } from '../../src/window/protocol.ts';
import { connectPage, openPage, roundTrip, startPages, until } from '../helpers/pages.ts';
import type { PageClient, PagesFixture } from '../helpers/pages.ts';
import { S1, S2 } from '../helpers/platform.ts';

const T1 = '0123456789ab';
const T2 = 'ba9876543210';
const T3 = 'aaaaaaaaaaaa';

type SeenCall =
  | { kind: 'focus'; page: object; focused: boolean; selected: string | null }
  | { kind: 'typed'; page: object; sessionId: string }
  | { kind: 'gone'; page: object };

/** startPages with a Seen that records every call. */
async function withSeen(t: TestContext): Promise<{ f: PagesFixture; calls: SeenCall[] }> {
  const calls: SeenCall[] = [];
  const seen: NonNullable<PagesDeps['seen']> = {
    focus(page, focused, selected) {
      calls.push({ kind: 'focus', page, focused, selected });
    },
    typed(page, sessionId) {
      calls.push({ kind: 'typed', page, sessionId });
    },
    gone(page) {
      calls.push({ kind: 'gone', page });
    },
  };
  const f = await startPages(t, { seen });
  return { f, calls };
}

/** The calls without the page object, for comparing. */
function plain(calls: readonly SeenCall[]): Omit<SeenCall, 'page'>[] {
  return calls.map(({ page: _page, ...rest }) => rest);
}

function focus(client: PageClient, focused: boolean, selected: string | null): void {
  client.send({ t: 'focus', focused, selected, area: { cols: 80, rows: 24 } });
}

const NOTIFY: NotifyMessage = {
  t: 'notify',
  sessionId: S1,
  title: 'fix the parser',
  reason: 'finished',
  detail: null,
};

/** Every notify `client` got, once the pong of a ping sent now is there. */
async function notifiesOf(client: PageClient): Promise<ServerMessage[]> {
  await roundTrip(client);
  return client.all
    .filter((item): item is { text: ServerMessage } => 'text' in item)
    .map((item) => item.text)
    .filter((message) => message.t === 'notify');
}

describe('pages tell Seen (S2 12.4, B9; contract 2.7)', () => {
  test("a page's start is focus(page, focused, null); each focus message is focus(page, focused, selected); all on the one page object", async (t) => {
    const { f, calls } = await withSeen(t);
    const a = await openPage(t, f, { focused: true });
    const b = await openPage(t, f, { focused: false });
    // One page at a time: two sockets keep no order between them.
    focus(a.client, true, S1);
    await roundTrip(a.client);
    focus(b.client, false, S2);
    await roundTrip(b.client);
    focus(a.client, false, S1);
    await roundTrip(a.client);
    assert.deepEqual(plain(calls), [
      { kind: 'focus', focused: true, selected: null },
      { kind: 'focus', focused: false, selected: null },
      { kind: 'focus', focused: true, selected: S1 },
      { kind: 'focus', focused: false, selected: S2 },
      { kind: 'focus', focused: false, selected: S1 },
    ]);
    const [first, second, third, fourth, fifth] = calls;
    assert.ok(first && second && third && fourth && fifth);
    assert.equal(third.page, first.page, "a's calls name one page");
    assert.equal(fifth.page, first.page);
    assert.equal(fourth.page, second.page, "b's calls name another");
    assert.notEqual(first.page, second.page);
  });

  test('typing into a terminal is typed(page, the session the hub says it shows); binary input, focus reports, SGR mouse reports and a terminal without a session are not', async (t) => {
    const { f, calls } = await withSeen(t);
    f.hub.add(T1, { sessionId: S1 });
    f.hub.add(T2, { sessionId: S2, expectedSessionId: S2 });
    f.hub.add(T3, { sessionId: null });
    const { client } = await openPage(t, f);
    const inputs: [string, string, boolean][] = [
      [T1, 'ls -l\r', false],
      [T1, '\x1b[M #!', true], // X10 mouse, binary
      [T1, '\x1b[I', false], // focus in
      [T1, '\x1b[O', false], // focus out
      [T1, '\x1b[<0;10;5M\x1b[<0;10;5m', false], // SGR mouse press and release
      [T2, 'y', false],
      [T3, 'n', false], // starting: it shows no session yet
      ['0123456789ff', 'x', false], // a terminal the hub does not know
    ];
    for (const [term, data, binary] of inputs) {
      client.send({ t: 'input', term, data, ...(binary ? { binary: true } : {}) });
    }
    await roundTrip(client);
    const typed = calls.filter((call) => call.kind === 'typed');
    assert.deepEqual(plain(typed), [
      { kind: 'typed', sessionId: S1 },
      { kind: 'typed', sessionId: S2 },
    ]);
    assert.equal(typed[0]?.page, calls[0]?.page, 'the page that typed');
    assert.equal(
      f.hub.calls.filter((call) => call.kind === 'input').length,
      inputs.length,
      'every input still reaches the hub',
    );
  });

  test('a page that closes is gone(page) once, and nothing is told for it after that', async (t) => {
    const { f, calls } = await withSeen(t);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    focus(a.client, true, S1);
    await roundTrip(a.client);
    const page = calls[0]?.page;
    a.client.ws.close();
    await a.client.closed;
    await until('the gone', () => calls.some((call) => call.kind === 'gone'));
    await roundTrip(b.client); // b's connection goes on
    assert.deepEqual(
      calls.filter((call) => call.kind === 'gone').map((call) => call.page),
      [page],
    );
    assert.equal(calls.at(-1)?.kind, 'gone', 'nothing after it');
  });

  test('a connection that ends before its start is gone too, and was never told a focus', async (t) => {
    const { f, calls } = await withSeen(t);
    const client = await connectPage(t, f);
    client.ws.close();
    await client.closed;
    await until('the gone', () => calls.length > 0);
    assert.deepEqual(plain(calls), [{ kind: 'gone' }]);
  });
});

describe('notify (S2 13, B12; contract 2.7)', () => {
  test('while no page has focus it goes to the page that had focus last, and only to it: true', async (t) => {
    const f = await startPages(t);
    const a = await openPage(t, f, { focused: true });
    const b = await openPage(t, f, { focused: true }); // b had focus after a
    focus(a.client, false, null);
    focus(b.client, false, null);
    await roundTrip(a.client);
    await roundTrip(b.client);
    assert.equal(f.pages.notify(NOTIFY), true);
    assert.deepEqual(await notifiesOf(b.client), [NOTIFY]);
    assert.deepEqual(await notifiesOf(a.client), []);

    // a gets the focus and loses it again: now a had it last.
    focus(a.client, true, null);
    focus(a.client, false, null);
    await roundTrip(a.client);
    const second = { ...NOTIFY, sessionId: S2 };
    assert.equal(f.pages.notify(second), true);
    assert.deepEqual(await notifiesOf(a.client), [second]);
    assert.deepEqual(await notifiesOf(b.client), [NOTIFY]);
  });

  test('while a page has focus nothing is sent: false', async (t) => {
    const f = await startPages(t);
    const a = await openPage(t, f, { focused: true });
    const b = await openPage(t, f, { focused: false });
    assert.equal(f.pages.notify(NOTIFY), false, 'a has focus since its start');
    focus(a.client, false, null);
    focus(b.client, true, null);
    await roundTrip(a.client);
    await roundTrip(b.client);
    assert.equal(f.pages.notify(NOTIFY), false, 'b has focus');
    assert.deepEqual(await notifiesOf(a.client), []);
    assert.deepEqual(await notifiesOf(b.client), []);
  });

  test('with no page open, or only one that closed: false', async (t) => {
    const f = await startPages(t);
    assert.equal(f.pages.notify(NOTIFY), false, 'none open');
    const a = await openPage(t, f, { focused: false });
    a.client.ws.close();
    await a.client.closed;
    await until('the page gone', () => f.pages.count() === 0);
    assert.equal(f.pages.notify(NOTIFY), false, 'the page that had focus last is closed');
  });

  test('after bye nothing is sent: false', async (t) => {
    const f = await startPages(t);
    const a = await openPage(t, f, { focused: false });
    const bye = f.pages.bye('the test');
    assert.equal(f.pages.notify(NOTIFY), false);
    await bye;
    assert.equal(
      a.client.all.some((item) => 'text' in item && item.text.t === 'notify'),
      false,
    );
  });
});
