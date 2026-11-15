// S2 13's judgement on the server (stage B's plan, task 52, B12): which sessions start to need you,
// the one `notify` each, and the first judgement that records without notifying. Pure: the needs,
// the readiness and the sending are the test's.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createNotifier } from '../../src/window/notify.ts';
import type { NotifierDeps } from '../../src/window/notify.ts';
import type { AttentionPayload, NotifyMessage } from '../../src/window/protocol.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';

type Needs = ReturnType<NotifierDeps['needs']>;

const ASKS: AttentionPayload = { reason: 'asks', detail: 'permission · Bash', sinceNs: '1' };
const FINISHED: AttentionPayload = { reason: 'finished', detail: null, sinceNs: '2' };
const ENDED: AttentionPayload = { reason: 'ended', detail: null, sinceNs: null };

function needs(...entries: [id: string, title: string, attention: AttentionPayload][]): Needs {
  return new Map(entries.map(([id, title, attention]) => [id, { title, attention }]));
}

/** A notifier over needs and readiness the test sets, recording what it sends and what it asks. */
function world(start: { ready?: boolean; needs?: Needs } = {}): {
  check(): void;
  set(next: { ready?: boolean; needs?: Needs }): void;
  sent: NotifyMessage[];
  asked: () => number;
} {
  let ready = start.ready ?? true;
  let current = start.needs ?? needs();
  let asked = 0;
  const sent: NotifyMessage[] = [];
  const notifier = createNotifier({
    needs: () => {
      asked += 1;
      return current;
    },
    ready: () => ready,
    send: (message) => {
      sent.push(message);
      return true;
    },
  });
  return {
    check: () => {
      notifier.check();
    },
    set(next) {
      ready = next.ready ?? ready;
      current = next.needs ?? current;
    },
    sent,
    asked: () => asked,
  };
}

test('while ready() is false nothing is judged: needs() is not asked, nothing is sent', () => {
  const w = world({ ready: false, needs: needs([S1, 'fix it', ASKS]) });
  w.check();
  w.set({ needs: needs([S1, 'fix it', ASKS], [S2, 'other', FINISHED]) });
  w.check();
  assert.equal(w.asked(), 0);
  assert.deepEqual(w.sent, []);
});

test('the first check once ready() is true records and sends nothing (B12)', () => {
  const w = world({ needs: needs([S1, 'fix it', ASKS], [S2, 'other', ENDED]) });
  w.check();
  assert.equal(w.asked(), 1);
  assert.deepEqual(w.sent, []);
  w.check();
  assert.deepEqual(w.sent, [], 'what needed you at the first judgement never notifies');
});

test('the first judgement is the first check made while ready(), also when needs() was empty before and is full then (review B, B1)', () => {
  const w = world({ ready: false, needs: needs() });
  w.check();
  w.set({ ready: true, needs: needs([S1, 'fix it', ASKS], [S2, 'other', FINISHED]) });
  w.check();
  assert.deepEqual(w.sent, []);
});

test('a session that comes to need you after that: one message with its title, reason and detail', () => {
  const w = world({ needs: needs([S1, 'fix it', FINISHED]) });
  w.check();
  w.set({ needs: needs([S1, 'fix it', FINISHED], [S2, 'the <b>other</b>', ASKS]) });
  w.check();
  assert.deepEqual(w.sent, [
    {
      t: 'notify',
      sessionId: S2,
      title: 'the <b>other</b>',
      reason: 'asks',
      detail: 'permission · Bash',
    },
  ]);
});

test('it again at the next check: nothing more', () => {
  const w = world();
  w.check();
  w.set({ needs: needs([S1, 'fix it', FINISHED]) });
  w.check();
  w.check();
  w.check();
  assert.deepEqual(
    w.sent.map((message) => [message.sessionId, message.reason, message.detail]),
    [[S1, 'finished', null]],
  );
});

test('a session whose reason changes does not start to need you: asks, then finished → nothing', () => {
  const w = world();
  w.check();
  w.set({ needs: needs([S1, 'fix it', ASKS]) });
  w.check();
  w.set({ needs: needs([S1, 'fix it', FINISHED]) });
  w.check();
  assert.deepEqual(
    w.sent.map((message) => message.reason),
    ['asks'],
  );
});

test('gone and back: one message each time it starts to need you', () => {
  const w = world({ needs: needs([S1, 'fix it', FINISHED]) });
  w.check();
  w.set({ needs: needs() });
  w.check();
  w.set({ needs: needs([S1, 'fix it', ENDED]) });
  w.check();
  assert.deepEqual(
    w.sent.map((message) => [message.sessionId, message.reason]),
    [[S1, 'ended']],
  );
});

test("several that start at one check: one message each, in needs()'s order", () => {
  const w = world({ needs: needs([S2, 'b', FINISHED]) });
  w.check();
  w.set({ needs: needs([S3, 'c', ENDED], [S2, 'b', FINISHED], [S1, 'a', ASKS]) });
  w.check();
  assert.deepEqual(
    w.sent.map((message) => message.sessionId),
    [S3, S1],
  );
});

test('a notify that no page took (send says false) is not sent again', () => {
  const sent: NotifyMessage[] = [];
  let current = needs();
  const notifier = createNotifier({
    needs: () => current,
    ready: () => true,
    send: (message) => {
      sent.push(message);
      return false;
    },
  });
  notifier.check();
  current = needs([S1, 'fix it', ASKS]);
  notifier.check();
  notifier.check();
  assert.equal(sent.length, 1);
});
