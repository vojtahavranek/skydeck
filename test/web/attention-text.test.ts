// The page's words of attention (S2 12.1, 12.2, 12.4, 13; plan B13, B14, contract 2.8): a row's
// second line, the title bar's count, the window title, a notification's title and body, and
// Ctrl+Shift+J's next session. node:test on web/attention-text.js, which uses no DOM.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AttentionPayload, NotifyMessage } from '../../src/window/protocol.ts';
import {
  attentionLine,
  needYouText,
  nextNeeding,
  notificationText,
  windowTitle,
} from '../../web/attention-text.js';
import { ageBetween } from '../../web/format.js';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;
const DAY = 24n * HOUR;
/** The server's clock at the list (S2 8.2.3: times are nanoseconds as decimal strings). */
const NOW = 1_794_474_000_000_000_000n;
const now = String(NOW);
const ago = (ns: bigint): string => String(NOW - ns);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

function attention(over: Partial<AttentionPayload> = {}): AttentionPayload {
  return { reason: 'asks', detail: null, sinceNs: ago(3n * MIN), ...over };
}

function notify(over: Partial<NotifyMessage> = {}): NotifyMessage {
  return {
    t: 'notify',
    sessionId: A,
    title: 'Fix the login page',
    reason: 'asks',
    detail: null,
    ...over,
  };
}

describe("attentionLine: the second line of a row that needs you (B13, S2 12.2's words)", () => {
  test('asks with a detail: "needs you · <detail> · 3m"', () => {
    assert.equal(
      attentionLine(attention({ detail: 'permission · Bash' }), now),
      'needs you · permission · Bash · 3m',
    );
  });

  test('asks without a detail: "needs you · 3m"', () => {
    assert.equal(attentionLine(attention(), now), 'needs you · 3m');
  });

  test('finished: "finished · not seen · 2m"; ended: "ended unexpectedly · not seen · 2m"', () => {
    assert.equal(
      attentionLine(attention({ reason: 'finished', sinceNs: ago(2n * MIN) }), now),
      'finished · not seen · 2m',
    );
    assert.equal(
      attentionLine(attention({ reason: 'ended', sinceNs: ago(2n * MIN) }), now),
      'ended unexpectedly · not seen · 2m',
    );
  });

  test("the age is format.js's, of the payload's sinceNs: seconds, minutes, hours, days", () => {
    for (const since of [0n, 59n * SEC, 61n * SEC, 59n * MIN, 3n * HOUR, 47n * HOUR, 3n * DAY]) {
      const age = ageBetween(now, ago(since));
      assert.notEqual(age, '');
      assert.equal(
        attentionLine(attention({ reason: 'finished', sinceNs: ago(since) }), now),
        `finished · not seen · ${age}`,
      );
    }
    assert.equal(
      attentionLine(attention({ detail: 'question', sinceNs: ago(3n * DAY) }), now),
      'needs you · question · 3d',
    );
  });

  test('a time that is not known gives no age, and nothing throws', () => {
    assert.equal(attentionLine(attention({ sinceNs: null }), now), 'needs you');
    assert.equal(
      attentionLine(attention({ detail: 'question', sinceNs: null }), now),
      'needs you · question',
    );
    assert.equal(
      attentionLine(attention({ reason: 'finished', sinceNs: null }), now),
      'finished · not seen',
    );
    assert.equal(
      attentionLine(attention({ reason: 'ended', sinceNs: 'soon' }), now),
      'ended unexpectedly · not seen',
    );
    assert.equal(attentionLine(attention({ reason: 'finished' }), ''), 'finished · not seen');
  });

  test('a detail with an escape sequence or markup is sanitised and kept as text', () => {
    assert.equal(
      attentionLine(attention({ detail: '\x1b[31mBash\x1b[0m <img src=x onerror=alert(1)>' }), now),
      'needs you · Bash <img src=x onerror=alert(1)> · 3m',
    );
    assert.equal(
      attentionLine(attention({ detail: 'rm\n-rf\t/\u202e' }), now),
      'needs you · rm -rf / · 3m',
    );
  });

  test('a detail that is nothing once sanitised is no detail', () => {
    assert.equal(attentionLine(attention({ detail: ' \x1b[0m\t' }), now), 'needs you · 3m');
  });

  test('a reason the page does not know is shown as the server named it, sanitised', () => {
    const unknown = { ...attention(), reason: 'pinged\x1b[2J' } as unknown as AttentionPayload;
    assert.equal(attentionLine(unknown, now), 'pinged · 3m');
  });

  test('no attention: null; an attention that is no object: null; nothing throws', () => {
    assert.equal(attentionLine(null, now), null);
    for (const odd of [undefined, 'asks', 3, []]) {
      assert.equal(attentionLine(odd as unknown as AttentionPayload | null, now), null);
    }
  });
});

describe("needYouText: the title bar's count (B13: the text only, the dot is the style sheet's)", () => {
  test('0 → null, 1 → "1 needs you", 3 → "3 need you"', () => {
    assert.equal(needYouText(0), null);
    assert.equal(needYouText(1), '1 needs you');
    assert.equal(needYouText(3), '3 need you');
  });

  test('a count that is no whole number from 1 up is no count (a list without needYou)', () => {
    for (const odd of [undefined, null, -1, 2.5, Number.NaN, Infinity, '3']) {
      assert.equal(needYouText(odd as unknown as number), null, String(odd));
    }
  });
});

describe('windowTitle (S2 12.1: the taskbar shows the count)', () => {
  test('0 → "skydeck", 1 → "(1) skydeck", 3 → "(3) skydeck"', () => {
    assert.equal(windowTitle(0), 'skydeck');
    assert.equal(windowTitle(1), '(1) skydeck');
    assert.equal(windowTitle(3), '(3) skydeck');
  });

  test('a count that is no whole number from 1 up gives "skydeck"', () => {
    for (const odd of [undefined, null, -1, 2.5, Number.NaN, '3']) {
      assert.equal(windowTitle(odd as unknown as number), 'skydeck', String(odd));
    }
  });
});

describe("notificationText: a notification's title and body (S2 13, B13)", () => {
  test('asks with a detail: "asks: <detail>"; without: "asks"; finished; ended unexpectedly', () => {
    assert.deepEqual(notificationText(notify({ detail: 'permission · Bash' })), {
      title: 'Fix the login page',
      body: 'asks: permission · Bash',
    });
    assert.deepEqual(notificationText(notify()), { title: 'Fix the login page', body: 'asks' });
    assert.deepEqual(notificationText(notify({ reason: 'finished' })), {
      title: 'Fix the login page',
      body: 'finished',
    });
    assert.deepEqual(notificationText(notify({ reason: 'ended' })), {
      title: 'Fix the login page',
      body: 'ended unexpectedly',
    });
  });

  test('the detail only for asks: a finished or ended one shows none', () => {
    assert.equal(notificationText(notify({ reason: 'finished', detail: 'x' })).body, 'finished');
  });

  test('the title and the detail sanitised, markup kept as text; nothing added to them', () => {
    assert.deepEqual(
      notificationText(
        notify({
          title: '<b>\x1b]0;owned\x07Fix</b>\nit\u2066',
          detail: '\x1b[1m<script>alert(1)</script>\x1b[0m',
        }),
      ),
      { title: '<b>Fix</b> it', body: 'asks: <script>alert(1)</script>' },
    );
  });

  test('a detail that is nothing once sanitised is no detail', () => {
    assert.equal(notificationText(notify({ detail: '\t\x1b[0m ' })).body, 'asks');
  });

  test('a reason the page does not know is shown as the server named it, sanitised', () => {
    const unknown = { ...notify(), reason: 'pinged\x07' } as unknown as NotifyMessage;
    assert.equal(notificationText(unknown).body, 'pinged');
  });

  test('a title that is no string is empty; nothing throws', () => {
    const odd = { ...notify(), title: 7, detail: 9 } as unknown as NotifyMessage;
    assert.deepEqual(notificationText(odd), { title: '', body: 'asks' });
  });
});

describe('nextNeeding: Ctrl+Shift+J (B14)', () => {
  test('none needs you: nothing to select, "no session needs you"', () => {
    assert.deepEqual(nextNeeding([], A, 0), { id: null, say: 'no session needs you' });
    assert.deepEqual(nextNeeding([], null, 0), { id: null, say: 'no session needs you' });
  });

  test('only the selected one: it stays selected, "no other session needs you"', () => {
    assert.deepEqual(nextNeeding([A], A, 1), { id: null, say: 'no other session needs you' });
  });

  test('the selected one first: the next; in the middle: the next; the last: the first again', () => {
    assert.deepEqual(nextNeeding([A, B, C], A, 3), { id: B, say: null });
    assert.deepEqual(nextNeeding([A, B, C], B, 3), { id: C, say: null });
    assert.deepEqual(nextNeeding([A, B, C], C, 3), { id: A, say: null });
  });

  test('a selection not in the order, or none: the first', () => {
    assert.deepEqual(nextNeeding([A, B, C], D, 3), { id: A, say: null });
    assert.deepEqual(nextNeeding([A, B, C], null, 3), { id: A, say: null });
    assert.deepEqual(nextNeeding([B], A, 1), { id: B, say: null });
  });

  test('a count above the order: how many the filter or the fold hides, with some shown', () => {
    assert.deepEqual(nextNeeding([A, B], A, 4), {
      id: B,
      say: '2 more that need you are hidden by the filter or the fold',
    });
    assert.deepEqual(nextNeeding([A, B], B, 3), {
      id: A,
      say: '1 more that needs you is hidden by the filter or the fold',
    });
    assert.deepEqual(nextNeeding([A], A, 3), {
      id: null,
      say: '2 more that need you are hidden by the filter or the fold',
    });
  });

  test('a count above the order with none shown', () => {
    assert.deepEqual(nextNeeding([], A, 3), {
      id: null,
      say: '3 that need you are hidden by the filter or the fold',
    });
    assert.deepEqual(nextNeeding([], null, 1), {
      id: null,
      say: '1 that needs you is hidden by the filter or the fold',
    });
  });

  test('the order as the server sends it: an id twice counts at its first place', () => {
    assert.deepEqual(nextNeeding([A, B, A, C], A, 3), { id: B, say: null });
    assert.deepEqual(nextNeeding([C, A, C], C, 2), { id: A, say: null });
  });

  test('what is no order or no count is none; nothing throws', () => {
    for (const odd of [undefined, null, 'A', 3, {}]) {
      assert.deepEqual(nextNeeding(odd as unknown as string[], A, 0), {
        id: null,
        say: 'no session needs you',
      });
    }
    assert.deepEqual(nextNeeding([7, A] as unknown as string[], null, 1), { id: A, say: null });
    for (const odd of [undefined, -1, 2.5, Number.NaN, '9']) {
      assert.deepEqual(nextNeeding([A, B], A, odd as unknown as number), { id: B, say: null });
    }
  });
});
