// A page's connection after the handshake (S2 8.2.3–8.2.8), task 17: streams, sizes, several
// pages, backpressure, the list, actions and bye, against a fake hub and a fake action handler.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { KeeperExit } from '../../src/window/frames.ts';
import type { ListMessage, ServerMessage } from '../../src/window/protocol.ts';
import { sizeAfter } from '../../src/window/size.ts';
import type { SizeState } from '../../src/window/size.ts';
import {
  challengeOf,
  connectPage,
  fakeActions,
  openPage,
  roundTrip,
  startPages,
  until,
  within,
} from '../helpers/pages.ts';
import type { HubCall, PageClient, PagesFixture } from '../helpers/pages.ts';
import { BOOT_A } from '../helpers/platform.ts';

const T1 = '0123456789ab';
const T2 = 'ba9876543210';
const MiB = 1024 * 1024;
const EXIT: KeeperExit = { code: 0, signal: null, atNs: '1794474000000000005', notStarted: null };

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Attaches `client` to `term` and returns the snap's channel. */
async function attach(client: PageClient, term: string, cols = 80, rows = 24): Promise<number> {
  client.send({ t: 'attach', term, cols, rows });
  const snap = await client.nextText(`the snap of ${term}`);
  assert.equal(snap.t, 'snap');
  assert.ok(snap.t === 'snap');
  assert.equal(snap.term, term);
  return snap.ch;
}

function resizes(f: PagesFixture): { term: string; cols: number; rows: number }[] {
  return f.hub.calls
    .filter((call): call is Extract<HubCall, { kind: 'resize' }> => call.kind === 'resize')
    .map(({ term, cols, rows }) => ({ term, cols, rows }));
}

function view(client: PageClient, filter = ''): void {
  client.send({ t: 'view', filter, unfolded: [], showDone: false, selected: null });
}

/** Everything that arrives until the pong of a ping sent now, as text messages. */
async function textsUntilPong(client: PageClient): Promise<ServerMessage[]> {
  const items = await roundTrip(client);
  return items.map((item) => {
    assert.ok('text' in item, 'a binary message');
    return item.text;
  });
}

describe('pages: streams', () => {
  test('attach → snap with a fresh channel, then output frames 1, ch, bytes in order and size in stream order', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1, { cols: 81, rows: 25 });
    f.hub.setScreen(T1, '\x1b[Hthe screen');
    const { client } = await openPage(t, f);
    client.send({ t: 'attach', term: T1, cols: 100, rows: 30 });
    const snap = await client.nextText('the snap');
    assert.ok(snap.t === 'snap', snap.t);
    assert.deepEqual(
      { ...snap, ch: 0 },
      { t: 'snap', term: T1, ch: 0, cols: 81, rows: 25, data: '\x1b[Hthe screen' },
    );

    f.hub.output(T1, 'one');
    f.hub.size(T1, 100, 30);
    f.hub.output(T1, Uint8Array.of(0, 0xff, 0x1b));
    const first = await client.next();
    assert.ok('binary' in first);
    assert.equal(first.binary[0], 1);
    assert.equal(new DataView(first.binary.buffer, first.binary.byteOffset).getUint32(1), snap.ch);
    assert.equal(text(first.binary.subarray(5)), 'one');
    assert.deepEqual(await client.nextText(), {
      t: 'size',
      term: T1,
      cols: 100,
      rows: 30,
      owner: true,
    });
    const third = await client.nextOutput();
    assert.deepEqual(third, { channel: snap.ch, bytes: Uint8Array.of(0, 0xff, 0x1b) });
  });

  test('each attach gets a channel of its own, and attaching again replaces the stream', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.add(T2);
    const { client } = await openPage(t, f);
    const one = await attach(client, T1);
    const two = await attach(client, T2);
    const again = await attach(client, T1);
    assert.equal(new Set([one, two, again]).size, 3);
    assert.equal(f.hub.sinks(T1).length, 1, 'the earlier stream was detached');
    f.hub.output(T1, 'x');
    assert.deepEqual(await client.nextOutput(), {
      channel: again,
      bytes: new TextEncoder().encode('x'),
    });
    assert.deepEqual(await textsUntilPong(client), []);
  });

  test('two pages attached to one terminal share one order', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    const chA = await attach(a.client, T1);
    const chB = await attach(b.client, T1);
    for (let i = 0; i < 20; i++) {
      if (i % 5 === 4) f.hub.size(T1, 80 + i, 24);
      else f.hub.output(T1, `record ${i}`);
    }
    const order = async (client: PageClient, ch: number): Promise<string[]> => {
      const got: string[] = [];
      while (got.length < 20) {
        const item = await client.next();
        if ('binary' in item) {
          const view = new DataView(item.binary.buffer, item.binary.byteOffset);
          assert.equal(view.getUint32(1), ch);
          got.push(text(item.binary.subarray(5)));
        } else {
          assert.ok(item.text.t === 'size', item.text.t);
          got.push(`size ${item.text.cols}`);
        }
      }
      return got;
    };
    const seenA = await order(a.client, chA);
    const seenB = await order(b.client, chB);
    assert.deepEqual(seenA, seenB);
    assert.deepEqual(seenA.slice(0, 5), [
      'record 0',
      'record 1',
      'record 2',
      'record 3',
      'size 84',
    ]);
  });

  test('detach stops the stream', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const { client } = await openPage(t, f);
    await attach(client, T1);
    client.send({ t: 'detach', term: T1 });
    await roundTrip(client);
    assert.equal(f.hub.sinks(T1).length, 0);
    f.hub.output(T1, 'after');
    f.hub.size(T1, 90, 30);
    f.hub.exit(T1, EXIT, false);
    assert.deepEqual(await roundTrip(client), []);
  });

  test('an attach to a terminal the hub does not know sends nothing and leaves nothing attached', async (t) => {
    const f = await startPages(t);
    const { client } = await openPage(t, f);
    client.send({ t: 'attach', term: T1, cols: 80, rows: 24 });
    assert.deepEqual(await roundTrip(client), []);
    assert.deepEqual(resizes(f), []);
  });

  test('input passes UTF-8, and with binary: true the bytes as given', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const { client } = await openPage(t, f);
    await attach(client, T1);
    client.send({ t: 'input', term: T1, data: 'héllo ✓ 😀\r' });
    client.send({ t: 'input', term: T1, data: '\x1b[<0;1;2Méÿ\u0000', binary: true });
    await roundTrip(client);
    const inputs = f.hub.calls.filter((call) => call.kind === 'input');
    assert.deepEqual(
      inputs.map((call) => call.kind === 'input' && [...call.data]),
      [
        [...new TextEncoder().encode('héllo ✓ 😀\r')],
        [...Buffer.from('\x1b[<0;1;2M', 'latin1'), 0xe9, 0xff, 0x00],
      ],
    );
  });

  test("input the hub cannot take ('full') → notice input-full with that terminal's term", async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.add(T2);
    const { client } = await openPage(t, f);
    await attach(client, T1);
    await attach(client, T2);
    f.hub.setInputAnswer(T2, 'full');
    client.send({ t: 'input', term: T1, data: 'a' });
    client.send({ t: 'input', term: T2, data: 'b' });
    assert.deepEqual(await textsUntilPong(client), [
      {
        t: 'notice',
        kind: 'input-full',
        term: T2,
        text: 'the program is not reading its input',
      },
    ]);
  });

  test("a sink's gap and newer-keeper reach each attached page with the terminal's term", async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    const other = await openPage(t, f);
    await attach(a.client, T1);
    await attach(b.client, T1);
    f.hub.notice(T1, 'gap', 'the gap text');
    f.hub.notice(T1, 'newer-keeper', 'the newer text');
    for (const page of [a, b]) {
      assert.deepEqual(await textsUntilPong(page.client), [
        { t: 'notice', kind: 'gap', term: T1, text: 'the gap text' },
        { t: 'notice', kind: 'newer-keeper', term: T1, text: 'the newer text' },
      ]);
    }
    assert.deepEqual(await textsUntilPong(other.client), []);
  });

  test('pages.notice (keep-alive, tick) reaches every page with term null', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    await attach(a.client, T1);
    f.pages.notice('keepalive-lost', 'WSL is not kept running');
    f.pages.notice('tick-failed', 'skydeck could not refresh the list: x; it tries again');
    for (const page of [a, b]) {
      assert.deepEqual(await textsUntilPong(page.client), [
        { t: 'notice', kind: 'keepalive-lost', term: null, text: 'WSL is not kept running' },
        {
          t: 'notice',
          kind: 'tick-failed',
          term: null,
          text: 'skydeck could not refresh the list: x; it tries again',
        },
      ]);
    }
  });

  test('exit reaches every attached page', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    await attach(a.client, T1);
    await attach(b.client, T1);
    f.hub.exit(T1, { code: null, signal: 9, atNs: '77', notStarted: null }, true);
    for (const page of [a, b]) {
      assert.deepEqual(await textsUntilPong(page.client), [
        { t: 'exit', term: T1, code: null, signal: 9, atNs: '77', lost: true, notStarted: null },
      ]);
    }
  });

  test('attaching a terminal that has ended gives its snap, then the exit the hub gives', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1, {
      state: 'not-started',
      exit: { code: null, signal: null, atNs: '9', notStarted: 'the session runs elsewhere' },
    });
    const { client } = await openPage(t, f);
    await attach(client, T1);
    assert.deepEqual(await textsUntilPong(client), [
      {
        t: 'exit',
        term: T1,
        code: null,
        signal: null,
        atNs: '9',
        lost: false,
        notStarted: 'the session runs elsewhere',
      },
    ]);
  });

  test('a lost terminal attached later gives an exit with lost: true', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1, { state: 'lost', exit: EXIT });
    const { client } = await openPage(t, f);
    await attach(client, T1);
    const [exit] = await textsUntilPong(client);
    assert.ok(exit?.t === 'exit');
    assert.equal(exit.lost, true);
  });

  test('the snap goes out when the hub gives the snapshot, never before, then the records', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.holdSnapshots();
    const { client } = await openPage(t, f);
    client.send({ t: 'attach', term: T1, cols: 80, rows: 24 });
    assert.deepEqual(await roundTrip(client), [], 'no snap before the snapshot');
    f.hub.output(T1, 'after the attach point');
    f.hub.releaseSnapshots();
    const snap = await client.nextText('the snap');
    assert.ok(snap.t === 'snap', snap.t);
    assert.deepEqual(await client.nextOutput(), {
      channel: snap.ch,
      bytes: new TextEncoder().encode('after the attach point'),
    });
  });

  test('a page that detaches before the snapshot is sent nothing', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.holdSnapshots();
    const { client } = await openPage(t, f);
    client.send({ t: 'attach', term: T1, cols: 80, rows: 24 });
    client.send({ t: 'detach', term: T1 });
    await roundTrip(client);
    f.hub.releaseSnapshots();
    f.hub.output(T1, 'x');
    assert.deepEqual(await roundTrip(client), []);
  });

  test('an exit between the attach and the snapshot comes after the snap', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.holdSnapshots();
    const { client } = await openPage(t, f);
    client.send({ t: 'attach', term: T1, cols: 80, rows: 24 });
    await roundTrip(client);
    f.hub.exit(T1, EXIT, false);
    f.hub.releaseSnapshots();
    const messages = await textsUntilPong(client);
    assert.deepEqual(
      messages.map((m) => m.t),
      ['snap', 'exit'],
    );
  });
});

describe('pages: size', () => {
  test('the hub receives resize exactly when sizeAfter says so', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    const steps: [PageClient, 'A' | 'B', object][] = [
      [a.client, 'A', { t: 'attach', term: T1, cols: 80, rows: 24 }],
      [b.client, 'B', { t: 'attach', term: T1, cols: 100, rows: 30 }],
      [b.client, 'B', { t: 'resize', term: T1, cols: 90, rows: 31 }],
      [a.client, 'A', { t: 'resize', term: T1, cols: 82, rows: 25 }],
      [b.client, 'B', { t: 'input', term: T1, data: 'x' }],
      [b.client, 'B', { t: 'input', term: T1, data: 'y' }],
      [a.client, 'A', { t: 'resize', term: T1, cols: 83, rows: 26 }],
      [a.client, 'A', { t: 'input', term: T1, data: 'z' }],
      [b.client, 'B', { t: 'detach', term: T1 }],
      [a.client, 'A', { t: 'detach', term: T1 }],
      [b.client, 'B', { t: 'attach', term: T1, cols: 70, rows: 20 }],
    ];
    let state: SizeState = { owner: null, proposals: new Map() };
    const expected: { term: string; cols: number; rows: number }[] = [];
    for (const [i, [client, page, message]] of steps.entries()) {
      client.send(message);
      if ((message as { t: string }).t === 'attach') {
        assert.equal((await client.nextText(`the snap of step ${i}`)).t, 'snap');
      }
      assert.deepEqual(await roundTrip(client), [], `step ${i}`);
      const m = message as {
        t: 'attach' | 'resize' | 'input' | 'detach';
        cols?: number;
        rows?: number;
      };
      const next = sizeAfter(state, { kind: m.t, page, cols: m.cols, rows: m.rows, at: i });
      state = next.state;
      if (next.apply !== null) expected.push({ term: T1, ...next.apply });
      assert.deepEqual(resizes(f), expected, `after step ${i}`);
    }
    assert.deepEqual(
      expected.map((r) => `${r.cols}x${r.rows}`),
      ['80x24', '82x25', '90x31', '83x26', '70x20'],
    );
  });

  test("each page's size.owner and list.terminals[].ownsSize are true for the owner only", async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.add(T2);
    const a = await openPage(t, f, { view: true });
    const b = await openPage(t, f, { view: true });
    await attach(a.client, T1);
    await attach(b.client, T1, 100, 30);
    f.hub.size(T1, 80, 24);
    assert.deepEqual(await textsUntilPong(a.client), [
      { t: 'size', term: T1, cols: 80, rows: 24, owner: true },
    ]);
    assert.deepEqual(await textsUntilPong(b.client), [
      { t: 'size', term: T1, cols: 80, rows: 24, owner: false },
    ]);

    const owns = (list: ServerMessage | undefined): Record<string, boolean> => {
      assert.ok(list?.t === 'list', list?.t);
      return Object.fromEntries(list.terminals.map((term) => [term.id, term.ownsSize]));
    };
    view(a.client, 'again');
    view(b.client, 'again');
    assert.deepEqual(owns((await textsUntilPong(a.client))[0]), { [T1]: true, [T2]: false });
    assert.deepEqual(owns((await textsUntilPong(b.client))[0]), { [T1]: false, [T2]: false });

    // b types: it owns the size now; both pages are sent a list that says so, within a second.
    b.client.send({ t: 'input', term: T1, data: 'x' });
    await roundTrip(b.client);
    f.clock.advanceMs(1_000);
    assert.deepEqual(owns((await textsUntilPong(a.client))[0]), { [T1]: false, [T2]: false });
    assert.deepEqual(owns((await textsUntilPong(b.client))[0]), { [T1]: true, [T2]: false });
    f.hub.size(T1, 100, 30);
    assert.deepEqual(await textsUntilPong(a.client), [
      { t: 'size', term: T1, cols: 100, rows: 30, owner: false },
    ]);
    assert.deepEqual(await textsUntilPong(b.client), [
      { t: 'size', term: T1, cols: 100, rows: 30, owner: true },
    ]);
  });

  test('a page that disconnects gives up the size as a detach does', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    await attach(a.client, T1, 80, 24);
    await attach(b.client, T1, 100, 30);
    a.client.ws.close();
    await until('the resize to b', () => resizes(f).length === 2);
    assert.deepEqual(resizes(f).at(-1), { term: T1, cols: 100, rows: 30 });
    assert.equal(f.hub.sinks(T1).length, 1);
  });
});

const T3 = '00000000000c';

/** 64 KiB whose first 4 bytes are `i`. */
function record(i: number): Uint8Array {
  const bytes = new Uint8Array(64 * 1024);
  new DataView(bytes.buffer).setUint32(0, i);
  return bytes;
}

function snapsIn(client: PageClient): ServerMessage[] {
  return client.all.flatMap((item) =>
    'text' in item && item.text.t === 'snap' ? [item.text] : [],
  );
}

function attachCalls(f: PagesFixture): number {
  return f.hub.calls.filter((call) => call.kind === 'attach').length;
}

describe('pages: a page that goes', () => {
  test('every stream of a closed page is detached even when a size hand-over throws', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.add(T2);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    for (const term of [T1, T2]) {
      await attach(a.client, term);
      await attach(b.client, term, 100, 30);
    }
    const resize = f.hub.resize.bind(f.hub);
    f.hub.resize = (term, cols, rows) => {
      resize(term, cols, rows);
      throw new Error('the hub failed');
    };
    a.client.ws.close();
    await until('a gone', () => f.pages.count() === 1);
    assert.equal(f.hub.sinks(T1).length, 1, 'T1: only b');
    assert.equal(f.hub.sinks(T2).length, 1, 'T2: only b');
    assert.deepEqual(resizes(f).slice(-2), [
      { term: T1, cols: 100, rows: 30 },
      { term: T2, cols: 100, rows: 30 },
    ]);
  });

  test('bye hands the size to no page', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f, { view: true });
    const b = await openPage(t, f, { view: true });
    await attach(a.client, T1);
    await attach(b.client, T1, 100, 30);
    f.clock.advanceMs(1_000); // the lists' second is over: a hand-over would send one at once
    await textsUntilPong(a.client);
    await textsUntilPong(b.client);
    const before = resizes(f).length;
    const lists = (page: { client: PageClient }): number =>
      page.client.all.filter((item) => 'text' in item && item.text.t === 'list').length;
    const listsBefore = [lists(a), lists(b)];
    await f.pages.bye('stopping');
    assert.equal(resizes(f).length, before, 'no resize');
    assert.deepEqual([lists(a), lists(b)], listsBefore, 'no list');
    for (const page of [a, b]) {
      const last = page.client.all.at(-1);
      assert.ok(last !== undefined && 'text' in last && last.text.t === 'bye', 'bye comes last');
    }
  });
});

describe('pages: backpressure', () => {
  test('a page that does not read gets no output while more than 1 MiB is queued, then a fresh snap for each stream that lost something; the hub is never paused', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.add(T2);
    f.hub.add(T3);
    const { client } = await openPage(t, f);
    const old1 = await attach(client, T1);
    const old2 = await attach(client, T2);
    const old3 = await attach(client, T3);
    const callsBefore = f.hub.calls.length;
    client.ws.pause();

    const RECORDS = 400;
    for (let i = 0; i < RECORDS; i++) {
      f.hub.output(T1, record(i)); // the hub's call returns at once: nothing waits for the page
    }
    // While behind: a resize of T1 and the exit of T2 are dropped too; the fresh snaps carry the
    // size, and the hub gives T2's exit after its snapshot. T3 has nothing: it keeps its stream.
    f.hub.size(T1, 90, 30);
    f.hub.exit(T2, EXIT, false);
    f.hub.setScreen(T1, 'fresh screen of T1');
    await delay(100);
    assert.deepEqual(f.hub.calls.slice(callsBefore), [], 'nothing was asked of the hub');
    client.ws.resume();

    const before: number[] = [];
    const after: ServerMessage[] = [];
    while (after.filter((m) => m.t === 'snap').length < 2) {
      const item = await client.next('the fresh snaps');
      if ('binary' in item) {
        const view = new DataView(item.binary.buffer, item.binary.byteOffset);
        assert.equal(view.getUint32(1), old1, 'output before the snaps is the old stream');
        before.push(view.getUint32(5));
      } else {
        after.push(item.text);
      }
    }
    assert.ok(before.length > 0, 'some output went out before the queue grew');
    assert.ok(before.length < RECORDS, `output was dropped (${before.length} of ${RECORDS} came)`);
    assert.deepEqual(before, [...before.keys()], 'what came is the stream up to a point, in order');
    assert.ok(before.length * 64 * 1024 > MiB, 'nothing was dropped before 1 MiB was queued');

    const snap1 = after.find((m) => m.t === 'snap' && m.term === T1);
    const snap2 = after.find((m) => m.t === 'snap' && m.term === T2);
    assert.ok(snap1?.t === 'snap' && snap2?.t === 'snap');
    assert.equal(snap1.data, 'fresh screen of T1');
    assert.deepEqual([snap1.cols, snap1.rows], [90, 30]);
    assert.ok(![old1, old2, old3].includes(snap1.ch) && ![old1, old2, old3].includes(snap2.ch));
    assert.notEqual(snap1.ch, snap2.ch);
    assert.ok(!after.some((m) => m.t === 'size'), 'no size while behind: the snap has it');
    assert.deepEqual(f.hub.calls.slice(callsBefore), [
      { kind: 'detach', term: T1 },
      { kind: 'attach', term: T1 },
      { kind: 'detach', term: T2 },
      { kind: 'attach', term: T2 },
    ]);

    // T2's exit follows its fresh snap; then output flows again on the new channel, and T3's on
    // the channel it had.
    const rest = [...after.slice(after.indexOf(snap2) + 1), ...(await textsUntilPong(client))];
    assert.deepEqual(rest, [
      {
        t: 'exit',
        term: T2,
        code: 0,
        signal: null,
        atNs: EXIT.atNs,
        lost: false,
        notStarted: null,
      },
    ]);
    f.hub.output(T1, 'again');
    f.hub.output(T3, 'three');
    assert.deepEqual(await client.nextOutput(), {
      channel: snap1.ch,
      bytes: new TextEncoder().encode('again'),
    });
    assert.deepEqual(await client.nextOutput(), {
      channel: old3,
      bytes: new TextEncoder().encode('three'),
    });
  });

  test('a second page that reads gets every record, in order, while the first is behind', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const slow = await openPage(t, f);
    const fast = await openPage(t, f);
    const slowCh = await attach(slow.client, T1);
    const ch = await attach(fast.client, T1);
    slow.client.ws.pause();
    const RECORDS = 300;
    const got: number[] = [];
    for (let i = 0; i < RECORDS; i++) {
      f.hub.output(T1, record(i));
      // In batches of 512 KiB that the fast page has read before the next: its queue stays small,
      // while the slow page's grows far past 1 MiB.
      while (i % 8 === 7 && got.length < i + 1) {
        const { channel, bytes } = await fast.client.nextOutput(`record ${got.length}`);
        assert.equal(channel, ch);
        got.push(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0));
      }
    }
    while (got.length < RECORDS) {
      const { channel, bytes } = await fast.client.nextOutput(`record ${got.length}`);
      assert.equal(channel, ch);
      got.push(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0));
    }
    assert.deepEqual(got, [...got.keys()]);
    assert.ok(
      !fast.client.all.some(
        (item) => 'text' in item && item.text.t === 'snap' && item.text.ch !== ch,
      ),
      'the fast page was never behind',
    );
    slow.client.ws.resume();
    await until('the slow page was behind: a fresh snap', () =>
      snapsIn(slow.client).some((m) => m.t === 'snap' && m.ch !== slowCh),
    );
  });

  test('an idle terminal whose snap is above 1 MiB gets one snap, and is attached once', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.setScreen(T1, 'x'.repeat(6 * MiB));
    const { client } = await openPage(t, f);
    const ch = await attach(client, T1);
    await delay(500);
    assert.equal(snapsIn(client).length, 1, 'one snap');
    assert.equal(attachCalls(f), 1, 'one attach');
    f.hub.output(T1, 'after');
    assert.deepEqual(await client.nextOutput(), {
      channel: ch,
      bytes: new TextEncoder().encode('after'),
    });
  });

  /**
   * Attaches `terms` at once (each screen `size` bytes); a busy test then has every terminal write
   * 100 small records, 5 ms apart, from the moment it was attached. Each terminal must get one
   * snap and one attach, and a busy one every record, in order, on its snap's channel.
   */
  async function attachedAtOnce(
    t: TestContext,
    terms: string[],
    size: number,
    busy: boolean,
  ): Promise<void> {
    const f = await startPages(t);
    for (const term of terms) {
      f.hub.add(term);
      f.hub.setScreen(term, term.repeat(Math.ceil(size / term.length)));
    }
    const { client } = await openPage(t, f);
    for (const term of terms) client.send({ t: 'attach', term, cols: 80, rows: 24 });
    await until('the attaches', () => attachCalls(f) === terms.length);
    const RECORDS = busy ? 100 : 0;
    for (let i = 0; i < RECORDS; i++) {
      for (const term of terms)
        f.hub.output(term, `${term} ${String(i).padStart(4, '0')} `.padEnd(100, '.'));
      await delay(5);
    }
    await until('every snap', () => snapsIn(client).length >= terms.length);
    const channels = new Map(
      snapsIn(client).map((m) => [m.t === 'snap' ? m.ch : -1, m.t === 'snap' ? m.term : '']),
    );
    const records = (): Map<string, number[]> => {
      const got = new Map<string, number[]>(terms.map((term) => [term, []]));
      for (const item of client.all) {
        if (!('binary' in item)) continue;
        const view = new DataView(item.binary.buffer, item.binary.byteOffset);
        const term = channels.get(view.getUint32(1));
        assert.ok(term !== undefined, 'output on a channel a snap gave');
        got.get(term)?.push(Number(text(item.binary.subarray(5)).slice(13, 17)));
      }
      return got;
    };
    await until('every record', () =>
      [...records().values()].every((list) => list.length === RECORDS),
    );
    await delay(300);
    assert.deepEqual(
      snapsIn(client).map((m) => m.t === 'snap' && m.term),
      terms,
      'one snap each',
    );
    assert.equal(attachCalls(f), terms.length, 'no terminal attached again');
    for (const [term, list] of records()) assert.deepEqual(list, [...list.keys()], term);
  }

  const FIVE = ['00000000000a', '00000000000b', '00000000000c', '00000000000d', '00000000000e'];
  for (const count of [4, 5]) {
    for (const busy of [false, true]) {
      test(`${count} ${busy ? 'busy' : 'idle'} terminals with snaps of 1.4 MiB, attached at once, get one snap each${busy ? ' and every record' : ''}`, async (t) => {
        await attachedAtOnce(t, FIVE.slice(0, count), 1.4 * MiB, busy);
      });
    }
  }

  test('a busy terminal whose snap is above 4 MiB gets one snap, and its records arrive', async (t) => {
    await attachedAtOnce(t, [T1], 6 * MiB, true);
  });
});

describe('pages: a page that does not read', () => {
  test('while behind its lists are held; the current one goes out at the drain', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const { client } = await openPage(t, f, { view: true });
    await attach(client, T1);
    const listsBefore = client.all.filter((i) => 'text' in i && i.text.t === 'list').length;
    client.ws.pause();
    for (let i = 0; i < 400; i++) f.hub.output(T1, record(i));
    for (let i = 0; i < 10; i++) {
      f.clock.advanceMs(1_000);
      f.listData.dirs = [`/v${i}`];
      f.pages.pushList();
    }
    client.ws.resume();
    await until('the fresh snap', () => snapsIn(client).length === 2);
    await roundTrip(client);
    const lists = client.all.flatMap((i) => ('text' in i && i.text.t === 'list' ? [i.text] : []));
    assert.equal(lists.length, listsBefore + 1, 'one list for the time behind');
    assert.deepEqual(lists.at(-1)?.dirs, ['/v9', 'filter:']);
    // At the drain the held list goes out at once; the fresh snap follows when the hub gives it.
    const at = (wanted: (m: ServerMessage) => boolean): number =>
      client.all.findLastIndex((i) => 'text' in i && wanted(i.text));
    assert.ok(
      at((m) => m.t === 'list') < at((m) => m.t === 'snap'),
      'the list before the fresh snap',
    );
  });

  test('a page with no terminal whose lists pile up gets the current one at the drain', async (t) => {
    let version = 0;
    const big = 'd'.repeat(MiB);
    const f = await startPages(t, {
      listFor: () => ({
        t: 'list',
        nowNs: '1',
        counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
        needYou: { count: 0, order: [] },
        sections: [],
        doneHidden: 0,
        banner: null,
        terminals: [],
        selected: null,
        dirs: [`/v${version}`, big],
      }),
    });
    const { client } = await openPage(t, f, { view: true });
    client.ws.pause();
    const CHANGES = 40;
    for (let i = 1; i <= CHANGES; i++) {
      version = i;
      f.clock.advanceMs(1_000);
      f.pages.pushList();
    }
    client.ws.resume();
    await until('the current list', () =>
      client.all.some(
        (i) => 'text' in i && i.text.t === 'list' && i.text.dirs[0] === `/v${CHANGES}`,
      ),
    );
    await textsUntilPong(client);
    const lists = client.all.filter((i) => 'text' in i && i.text.t === 'list').length;
    assert.ok(
      lists < CHANGES / 2,
      `${lists} lists of 1 MiB for ${CHANGES} changes: they were held`,
    );
  });

  test('more than 64 MiB queued: the connection is dropped, logged, its streams detached', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.setScreen(T1, 's'.repeat(10 * MiB));
    const { client } = await openPage(t, f);
    client.ws.pause();
    // Snap after snap that the page does not read: only the latest one is not counted.
    for (let i = 0; i < 10; i++) {
      client.send({ t: 'attach', term: T1, cols: 80, rows: 24 });
      await delay(20);
    }
    await until('the page is dropped', () => f.pages.count() === 0);
    assert.equal(f.hub.sinks(T1).length, 0);
    assert.deepEqual(f.logs, ['page: more than 64 MiB queued; the connection is dropped']);
    client.ws.resume();
    await within('the close', client.closed);
  });

  test('a single snap above 64 MiB reaches a page that reads: the latest snap is not counted', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.setScreen(T1, 'i'.repeat(70 * MiB));
    const { client } = await openPage(t, f);
    const ch = await attach(client, T1);
    f.hub.output(T1, 'after');
    assert.deepEqual(await client.nextOutput(), {
      channel: ch,
      bytes: new TextEncoder().encode('after'),
    });
    assert.equal(f.pages.count(), 1);
    assert.deepEqual(f.logs, []);
  });

  test('a terminal attached while the page is behind gets its snap at the drain', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.add(T2);
    const { client } = await openPage(t, f);
    await attach(client, T1);
    client.ws.pause();
    for (let i = 0; i < 400; i++) f.hub.output(T1, record(i));
    client.send({ t: 'attach', term: T2, cols: 80, rows: 24 });
    await until('the attach of T2', () => attachCalls(f) === 2);
    await delay(50); // its snapshot came while the page was behind
    client.ws.resume();
    await until('a snap of T2', () => snapsIn(client).some((m) => m.t === 'snap' && m.term === T2));
    await roundTrip(client);
    const snaps2 = snapsIn(client).filter((m) => m.t === 'snap' && m.term === T2);
    assert.equal(snaps2.length, 1, 'one snap of T2');
    assert.deepEqual(
      f.hub.calls.filter((call) => call.kind === 'attach' && call.term === T2).length,
      2,
      'T2 attached again at the drain',
    );
    const snap2 = snaps2[0];
    assert.ok(snap2?.t === 'snap');
    f.hub.output(T2, 'two');
    assert.deepEqual(await client.nextOutput(), {
      channel: snap2.ch,
      bytes: new TextEncoder().encode('two'),
    });
  });

  test('a view that arrives while the page is behind is answered at the drain, even unchanged', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const { client } = await openPage(t, f, { view: true });
    await attach(client, T1);
    f.clock.advanceMs(1_000); // the list of the attach's ownership goes out now
    await roundTrip(client);
    const lists = (): number => client.all.filter((i) => 'text' in i && i.text.t === 'list').length;
    const before = lists();
    client.ws.pause();
    for (let i = 0; i < 400; i++) f.hub.output(T1, record(i));
    view(client); // the same view: its list equals the last one sent
    await delay(50);
    client.ws.resume();
    await until('the fresh snap', () => snapsIn(client).length === 2);
    await roundTrip(client);
    assert.equal(lists(), before + 1, 'the view got its answer');
  });
});

describe('pages: messages', () => {
  test('ping → pong with n, bootId, serverId', async (t) => {
    const f = await startPages(t);
    const { client } = await openPage(t, f);
    client.send({ t: 'ping', n: 42 });
    assert.deepEqual(await client.nextText(), {
      t: 'pong',
      n: 42,
      bootId: BOOT_A,
      serverId: f.welcome.serverId,
    });
  });

  test('view → a list at once, built for that page and view', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const { client } = await openPage(t, f);
    view(client, 'abc');
    const list = await client.nextText();
    assert.ok(list.t === 'list', list.t);
    assert.deepEqual(list.dirs, ['/work', 'filter:abc']);
    assert.equal(f.listCalls.at(-1)?.view.filter, 'abc');
    assert.equal(list.terminals[0]?.ownsSize, false, 'not attached: not the owner');
  });

  test('no list before the first view', async (t) => {
    const f = await startPages(t);
    const { client } = await openPage(t, f);
    f.pages.pushList();
    f.clock.advanceMs(2_000);
    assert.deepEqual(await textsUntilPong(client), []);
  });

  test('pushList sends only changed lists, at most once a second per page', async (t) => {
    const f = await startPages(t);
    const a = await openPage(t, f, { view: true });
    const dirsOf = (messages: ServerMessage[]): string[][] =>
      messages.map((m) => {
        assert.ok(m.t === 'list', m.t);
        return (m as ListMessage).dirs;
      });

    f.clock.advanceMs(5_000);
    f.pages.pushList();
    assert.deepEqual(await textsUntilPong(a.client), [], 'unchanged (only the time moved)');

    f.listData.dirs = ['/one'];
    f.pages.pushList();
    assert.deepEqual(dirsOf(await textsUntilPong(a.client)), [['/one', 'filter:']]);

    f.listData.dirs = ['/two'];
    f.pages.pushList();
    f.listData.dirs = ['/three'];
    f.pages.pushList();
    f.clock.advanceMs(999);
    assert.deepEqual(await textsUntilPong(a.client), [], 'not again within the second');
    f.clock.advanceMs(1);
    assert.deepEqual(dirsOf(await textsUntilPong(a.client)), [['/three', 'filter:']]);

    // A change that came and went within the second sends nothing.
    f.listData.dirs = ['/four'];
    f.pages.pushList();
    f.listData.dirs = ['/three'];
    f.clock.advanceMs(1_000);
    assert.deepEqual(await textsUntilPong(a.client), []);
  });

  test('each page has its own second', async (t) => {
    const f = await startPages(t);
    const a = await openPage(t, f, { view: true });
    f.clock.advanceMs(600);
    const b = await openPage(t, f, { view: true });
    f.clock.advanceMs(600);
    f.listData.dirs = ['/x'];
    f.pages.pushList();
    assert.equal((await textsUntilPong(a.client)).length, 1, 'a: its second has passed');
    assert.equal((await textsUntilPong(b.client)).length, 0, 'b: not yet');
    f.clock.advanceMs(400);
    assert.equal((await textsUntilPong(b.client)).length, 1);
  });

  test('a view answers at once, also within the second', async (t) => {
    const f = await startPages(t);
    const { client } = await openPage(t, f, { view: true });
    view(client, 'x');
    view(client, 'y');
    const lists = await textsUntilPong(client);
    assert.deepEqual(
      lists.map((m) => m.t === 'list' && m.dirs.at(-1)),
      ['filter:x', 'filter:y'],
    );
  });

  test('act → the handler result with the same id; the handler gets the page', async (t) => {
    const f = await startPages(t);
    const { client } = await openPage(t, f, { windowId: '00000000000000aa', focused: true });
    client.send({ t: 'focus', focused: true, selected: null, area: { cols: 120, rows: 40 } });
    client.send({ t: 'act', id: 7, kind: 'close-terminal', term: T1 });
    assert.deepEqual(await client.nextText(), {
      t: 'result',
      id: 7,
      ok: true,
      lines: ['did close-terminal'],
      error: null,
      sessionId: null,
    });
    assert.deepEqual(f.actions.calls, [
      {
        page: { windowId: '00000000000000aa', focused: true, area: { cols: 120, rows: 40 } },
        action: { t: 'act', id: 7, kind: 'close-terminal', term: T1 },
      },
    ]);
  });

  test('an action that rejects still gets a result, and its message is not logged', async (t) => {
    const f = await startPages(t, {
      actions: fakeActions(() => Promise.reject(new TypeError('boom MARKER-act'))),
    });
    const { client } = await openPage(t, f);
    client.send({ t: 'act', id: 3, kind: 'open-link', url: 'https://example.com/' });
    const result = await client.nextText();
    assert.ok(result.t === 'result', result.t);
    assert.equal(result.id, 3);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.sessionId, null);
    assert.ok(
      f.logs.some((line) => line.includes('TypeError')),
      JSON.stringify(f.logs),
    );
    assert.ok(!f.logs.some((line) => line.includes('MARKER-act')));
  });

  test('lastFocused is the page that had focus last, with the area it reported', async (t) => {
    const f = await startPages(t);
    assert.equal(f.pages.lastFocused(), null);
    const a = await openPage(t, f, { windowId: '000000000000000a', focused: true });
    assert.equal(f.pages.lastFocused()?.windowId, '000000000000000a');
    const b = await openPage(t, f, { windowId: '000000000000000b', focused: false });
    assert.equal(f.pages.lastFocused()?.windowId, '000000000000000a');
    b.client.send({ t: 'focus', focused: true, selected: null, area: { cols: 99, rows: 33 } });
    await roundTrip(b.client);
    assert.equal(f.pages.lastFocused()?.windowId, '000000000000000b');
    assert.deepEqual(f.pages.lastFocused()?.area, { cols: 99, rows: 33 });
    b.client.send({ t: 'focus', focused: false, selected: null, area: { cols: 99, rows: 33 } });
    await roundTrip(b.client);
    assert.equal(f.pages.lastFocused()?.windowId, '000000000000000b', 'had focus last');
    a.client.send({ t: 'focus', focused: true, selected: null, area: { cols: 10, rows: 5 } });
    await roundTrip(a.client);
    assert.equal(f.pages.lastFocused()?.windowId, '000000000000000a');
    a.client.ws.close();
    await until('a is gone', () => f.pages.count() === 1);
    assert.equal(f.pages.lastFocused()?.windowId, '000000000000000b');
  });

  test('the theme of the page that has focus goes to the hub (start, then focus)', async (t) => {
    const f = await startPages(t);
    await openPage(t, f, { focused: true, theme: { fg: '#111111', bg: '#222222' } });
    const b = await openPage(t, f, { focused: false, theme: { fg: '#333333', bg: '#444444' } });
    b.client.send({ t: 'focus', focused: true, selected: null, area: { cols: 80, rows: 24 } });
    await roundTrip(b.client);
    assert.deepEqual(
      f.hub.calls.filter((call) => call.kind === 'setTheme'),
      [
        { kind: 'setTheme', theme: { fg: '#111111', bg: '#222222' } },
        { kind: 'setTheme', theme: { fg: '#333333', bg: '#444444' } },
      ],
    );
  });

  test('a message that is not valid after start closes with 1008, logged by kind', async (t) => {
    const f = await startPages(t);
    for (const send of [
      (c: PageClient) => c.send({ t: 'attach', term: 'XYZ', cols: 80, rows: 24 }),
      (c: PageClient) => c.send({ t: 'hello', protocol: 1, mode: 'key', nonce: 'a', proof: 'b' }),
      (c: PageClient) => c.ws.send(Buffer.from('bytes')),
    ]) {
      const { client } = await openPage(t, f);
      send(client);
      assert.equal((await within('the close', client.closed)).code, 1008);
    }
    assert.equal(f.logs.length, 3, JSON.stringify(f.logs));
  });

  test('bye reaches every page before the sockets close, and resolves once they are closed', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    const a = await openPage(t, f);
    const b = await openPage(t, f);
    await attach(a.client, T1);
    const waiting = await connectPage(t, f);
    await challengeOf(waiting);
    await f.pages.bye('the server stops');
    for (const page of [a, b]) {
      const { code } = await within('the close', page.client.closed);
      assert.equal(code, 1001);
      assert.deepEqual(page.client.all.at(-1), { text: { t: 'bye', reason: 'the server stops' } });
    }
    assert.equal((await within('the close', waiting.closed)).code, 1001);
    assert.ok(
      !waiting.all.some((item) => 'text' in item && item.text.t === 'bye'),
      'no bye before proof',
    );
    assert.equal(f.pages.count(), 0);
    assert.equal(f.hub.sinks(T1).length, 0, 'every stream was detached');
  });

  test('bye resolves CLOSE_WAIT_MS after a page that does not read', async (t) => {
    const f = await startPages(t);
    const { client } = await openPage(t, f);
    client.ws.pause();
    let resolved = false;
    const done = f.pages.bye('stopping').then(() => {
      resolved = true;
    });
    await delay(100);
    assert.equal(resolved, false);
    f.clock.advanceMs(5_000);
    await within('bye', done);
  });
});
