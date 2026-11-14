// A page's connection after the handshake (S2 8.2.3–8.2.8), task 17: streams, sizes, several
// pages, backpressure, the list, actions and bye, against a fake hub and a fake action handler.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
import type { HubCall, PageClient, PagesFixture, Received } from '../helpers/pages.ts';
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

  test('attaching a terminal that has ended gives its snap, then its exit, once', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1, {
      state: 'not-started',
      exit: { code: null, signal: null, atNs: '9', notStarted: 'the session runs elsewhere' },
    });
    const { client } = await openPage(t, f);
    await attach(client, T1);
    // A hub that also forwards the exit to a sink attached after it must not double it.
    f.hub.exit(
      T1,
      { code: null, signal: null, atNs: '9', notStarted: 'the session runs elsewhere' },
      false,
    );
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

  test('an exit between the attach and the snapshot comes after the snap, once', async (t) => {
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

describe('pages: backpressure', () => {
  test('a page that does not read gets no output while more than 1 MiB is queued, then a fresh snap per attached terminal; the hub is never paused', async (t) => {
    const f = await startPages(t);
    f.hub.add(T1);
    f.hub.add(T2);
    const { client } = await openPage(t, f);
    const old1 = await attach(client, T1);
    const old2 = await attach(client, T2);
    const callsBefore = f.hub.calls.length;
    client.ws.pause();

    const RECORDS = 400;
    const record = (i: number): Uint8Array => {
      const bytes = new Uint8Array(64 * 1024);
      new DataView(bytes.buffer).setUint32(0, i);
      return bytes;
    };
    for (let i = 0; i < RECORDS; i++) {
      f.hub.output(T1, record(i)); // the hub's call returns at once: nothing waits for the page
    }
    // While behind: a resize and an exit; the fresh snaps carry the size, the exit follows its snap.
    f.hub.size(T1, 90, 30);
    f.hub.exit(T2, EXIT, false);
    f.hub.setScreen(T1, 'fresh screen of T1');
    await delay(100);
    assert.deepEqual(f.hub.calls.slice(callsBefore), [], 'nothing was asked of the hub');
    client.ws.resume();

    const before: number[] = [];
    const after: Received[] = [];
    let snaps = 0;
    while (snaps < 2) {
      const item = await client.next('the fresh snaps');
      if ('binary' in item) {
        const view = new DataView(item.binary.buffer, item.binary.byteOffset);
        assert.equal(view.getUint32(1), old1, 'output before the snaps is the old stream');
        before.push(view.getUint32(5));
      } else {
        after.push(item);
        if (item.text.t === 'snap') snaps++;
      }
    }
    assert.ok(before.length > 0, 'some output went out before the queue grew');
    assert.ok(before.length < RECORDS, `output was dropped (${before.length} of ${RECORDS} came)`);
    assert.deepEqual(before, [...before.keys()], 'what came is the stream up to a point, in order');
    assert.ok(
      before.length * 64 * 1024 > MiB,
      'no output was dropped before more than 1 MiB was queued',
    );

    const texts = after.map((item) => ('text' in item ? item.text : null));
    const snap1 = texts.find((m) => m?.t === 'snap' && m.term === T1);
    const snap2 = texts.find((m) => m?.t === 'snap' && m.term === T2);
    assert.ok(snap1?.t === 'snap' && snap2?.t === 'snap');
    assert.equal(snap1.data, 'fresh screen of T1');
    assert.deepEqual([snap1.cols, snap1.rows], [90, 30]);
    assert.ok(![old1, old2].includes(snap1.ch) && ![old1, old2].includes(snap2.ch));
    assert.notEqual(snap1.ch, snap2.ch);
    assert.ok(!texts.some((m) => m?.t === 'size'), 'no size while behind: the snap has it');
    assert.deepEqual(f.hub.calls.slice(callsBefore), [
      { kind: 'detach', term: T1 },
      { kind: 'attach', term: T1 },
      { kind: 'detach', term: T2 },
      { kind: 'attach', term: T2 },
    ]);

    // T2's exit follows its fresh snap; then output flows again on the new channel.
    const rest = await textsUntilPong(client);
    assert.deepEqual(
      rest.length <= 1 ? [...texts.slice(texts.indexOf(snap2) + 1), ...rest] : rest,
      [
        {
          t: 'exit',
          term: T2,
          code: 0,
          signal: null,
          atNs: EXIT.atNs,
          lost: false,
          notStarted: null,
        },
      ],
    );
    f.hub.output(T1, 'again');
    assert.deepEqual(await client.nextOutput(), {
      channel: snap1.ch,
      bytes: new TextEncoder().encode('again'),
    });
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
