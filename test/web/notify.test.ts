// The page's desktop notifications (S2 13; web/notify.js), its one reader of a list: `update`
// closes the notification of a session that no longer needs you. F44: "needs you" is the server's
// per row (`needsYou`), so a notification shown before a session was parked closes at the list
// that carries the parking. node:test with a stand-in item, a recording `globalThis.Notification`
// and a stand-in `addEventListener` (the module's one use of the window at its making).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { ListMessage, NotifyMessage, RowPayload } from '../../src/window/protocol.ts';
import { createNotifications } from '../../web/notify.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

/** Each notification made, with whether its `close()` was called. */
let made: { tag: string; closed: boolean }[] = [];

class RecordingNotification extends EventTarget {
  static get permission(): string {
    return 'granted';
  }
  static requestPermission(): Promise<string> {
    return Promise.resolve('granted');
  }
  readonly entry: { tag: string; closed: boolean };
  constructor(_title: string, options: { tag: string }) {
    super();
    this.entry = { tag: options.tag, closed: false };
    made.push(this.entry);
  }
  close(): void {
    this.entry.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

const saved = {
  Notification: Reflect.get(globalThis, 'Notification') as unknown,
  addEventListener: Reflect.get(globalThis, 'addEventListener') as unknown,
};

beforeEach(() => {
  made = [];
  Reflect.set(globalThis, 'Notification', RecordingNotification);
  Reflect.set(globalThis, 'addEventListener', () => {});
});

afterEach(() => {
  Reflect.set(globalThis, 'Notification', saved.Notification);
  Reflect.set(globalThis, 'addEventListener', saved.addEventListener);
});

function notifications(): ReturnType<typeof createNotifications> {
  const item = { hidden: false, addEventListener: () => {} } as unknown as HTMLButtonElement;
  return createNotifications(item, { select: () => {} });
}

function notify(sessionId: string): NotifyMessage {
  return { t: 'notify', sessionId, title: 'a title', reason: 'asks', detail: null };
}

const asks = { reason: 'asks' as const, detail: null, sinceNs: '1' };

/** A list whose rows are `rows` (only what `update` reads), `count` needing you. */
function list(rows: Partial<RowPayload>[], count: number): ListMessage {
  return {
    t: 'list',
    needYou: { count, order: [] },
    sections: [{ name: 'open', rows }],
  } as unknown as ListMessage;
}

const UNFOCUSED = { focused: false, selected: null };

test('update (F44): a session whose row comes with `attention` set and `needsYou` false (parked) has its notification closed while another still needs you', () => {
  const shown = notifications();
  shown.show(notify(A), UNFOCUSED);
  shown.show(notify(B), UNFOCUSED);
  assert.deepEqual(
    made.map((one) => one.tag),
    [A, B],
  );
  shown.update(
    list(
      [
        { id: A, attention: asks, needsYou: false, parked: true },
        { id: B, attention: asks, needsYou: true },
      ],
      1,
    ),
  );
  assert.deepEqual(
    made.map((one) => [one.tag, one.closed]),
    [
      [A, true],
      [B, false],
    ],
  );
});

test('update: a notification whose session is not in the list is kept; one whose row needs you is kept; absent `needsYou` is by `attention`', () => {
  const shown = notifications();
  shown.show(notify(A), UNFOCUSED);
  shown.show(notify(B), UNFOCUSED);
  shown.show(notify(C), UNFOCUSED);
  shown.update(
    list(
      [
        { id: B, attention: asks }, // a scripted row: needs you by its attention
        { id: C, attention: null }, // needs nothing: closed
      ],
      1,
    ),
  );
  assert.deepEqual(
    made.map((one) => [one.tag, one.closed]),
    [
      [A, false],
      [B, false],
      [C, true],
    ],
  );
  // Nothing needs you at all: every one closes.
  shown.update(list([], 0));
  assert.deepEqual(
    made.map((one) => one.closed),
    [true, true, true],
  );
});
