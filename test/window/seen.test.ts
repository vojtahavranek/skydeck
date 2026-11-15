// S2 12.4's seen, a condition that holds (B9): the pure test of typing, and the per-page hold on
// testPlatform's fake clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEEN_AFTER_MS, createSeen, isTyping } from '../../src/window/seen.ts';
import { S1, S2, S3, testPlatform } from '../helpers/platform.ts';

const ESC = '\x1b';

test("SEEN_AFTER_MS is S2 12.4's 1.5 seconds", () => {
  assert.equal(SEEN_AFTER_MS, 1500);
});

test('isTyping: keys, a return, a paste and text after a focus report are typing', () => {
  const typing = [
    'a',
    '\r',
    `${ESC}[200~some pasted text${ESC}[201~`,
    `${ESC}[Ia`,
    `a${ESC}[O`,
    `${ESC}[I${ESC}[<0;10;5Mx`,
    ESC, // the Esc key alone
    `${ESC}[A`, // an arrow key
    `${ESC}[<0;10;5`, // not a whole mouse report
    'žluťoučký kůň',
  ];
  for (const data of typing) {
    assert.equal(isTyping(data, false), true, JSON.stringify(data));
  }
});

test('isTyping (F1 of review A): focus reports and SGR mouse reports are not typing', () => {
  const reports = [
    `${ESC}[I`,
    `${ESC}[O`,
    `${ESC}[<0;10;5M`,
    `${ESC}[<0;10;5m`,
    `${ESC}[<35;640;320M`, // a pointer motion in SGR pixels (1016)
    `${ESC}[<64;1;1M`, // the wheel
    `${ESC}[I${ESC}[<0;10;5M${ESC}[<0;10;5m${ESC}[O`,
    `${ESC}[O${ESC}[I`,
    '',
  ];
  for (const data of reports) {
    assert.equal(isTyping(data, false), false, JSON.stringify(data));
  }
});

test('isTyping: nothing binary is typing (the X10 mouse encoding)', () => {
  assert.equal(isTyping('a', true), false);
  assert.equal(isTyping(`${ESC}[M !!`, true), false);
  assert.equal(isTyping('', true), false);
});

/** A page as the server knows it: any object. */
function page(): object {
  return {};
}

test('a focused page with S selected sees S from 1,500 ms on, not at 1,499', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const p = page();
  seen.focus(p, true, S1);
  assert.deepEqual(seen.take(), new Set());
  clock.advanceMs(1499);
  assert.deepEqual(seen.take(), new Set());
  clock.advanceMs(1);
  assert.deepEqual(seen.take(), new Set([S1]));
  clock.advanceMs(60_000);
  assert.deepEqual(seen.take(), new Set([S1]), 'it holds');
  assert.equal(clock.timers(), 0);
});

test('unfocused first: the 1.5 s start when the page gets focus', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const p = page();
  seen.focus(p, false, S1);
  clock.advanceMs(5000);
  assert.deepEqual(seen.take(), new Set());
  seen.focus(p, true, S1);
  clock.advanceMs(1499);
  assert.deepEqual(seen.take(), new Set());
  clock.advanceMs(1);
  assert.deepEqual(seen.take(), new Set([S1]));
});

test('the selection changed at 1,000 ms: the 1.5 s start again, for the new one', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const p = page();
  seen.focus(p, true, S1);
  clock.advanceMs(1000);
  seen.focus(p, true, S2);
  clock.advanceMs(500);
  assert.deepEqual(seen.take(), new Set(), 'S1 was not held long enough');
  clock.advanceMs(999);
  assert.deepEqual(seen.take(), new Set());
  clock.advanceMs(1);
  assert.deepEqual(seen.take(), new Set([S2]));
});

test('the same focus and selection again (a new area) does not start the 1.5 s again', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const p = page();
  seen.focus(p, true, S1);
  clock.advanceMs(1000);
  seen.focus(p, true, S1);
  clock.advanceMs(500);
  assert.deepEqual(seen.take(), new Set([S1]));
  seen.focus(p, true, S1);
  assert.deepEqual(seen.take(), new Set([S1]), 'a hold that completed stays');
});

test('focus lost: S is out at once; back at the front, the 1.5 s start again', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const p = page();
  seen.focus(p, true, S1);
  clock.advanceMs(2000);
  assert.deepEqual(seen.take(), new Set([S1]));
  seen.focus(p, false, S1);
  assert.deepEqual(seen.take(), new Set());
  seen.focus(p, true, S1);
  clock.advanceMs(1499);
  assert.deepEqual(seen.take(), new Set());
  clock.advanceMs(1);
  assert.deepEqual(seen.take(), new Set([S1]));

  // Focus lost before the hold completed: nothing, and no timer is left running.
  seen.focus(p, true, S2);
  clock.advanceMs(1000);
  seen.focus(p, false, S2);
  assert.equal(clock.timers(), 0);
  clock.advanceMs(5000);
  assert.deepEqual(seen.take(), new Set());
});

test('a focused page with nothing selected sees nothing', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const p = page();
  seen.focus(p, true, null);
  assert.equal(clock.timers(), 0);
  clock.advanceMs(5000);
  assert.deepEqual(seen.take(), new Set());
});

test("typing into the terminal of a focused page's selection: seen at once, and held", (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  let changes = 0;
  seen.onChange(() => {
    changes += 1;
  });
  const p = page();
  seen.focus(p, true, S1);
  clock.advanceMs(200);
  seen.typed(p, S1);
  assert.equal(changes, 1);
  assert.deepEqual(seen.take(), new Set([S1]));
  assert.deepEqual(seen.take(), new Set([S1]), 'held, not given once');
  assert.equal(clock.timers(), 0, 'the 1.5 s are over');
  clock.advanceMs(5000);
  assert.equal(changes, 1, 'no second change for the same hold');
  assert.deepEqual(seen.take(), new Set([S1]));

  // The selection moves on: the typing's hold goes with it.
  seen.focus(p, true, S2);
  assert.deepEqual(seen.take(), new Set());
});

test('typing for another session, or into an unfocused page: in the next take() only', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  let changes = 0;
  seen.onChange(() => {
    changes += 1;
  });
  const p = page();
  seen.focus(p, true, S1);
  seen.typed(p, S2);
  assert.equal(changes, 1);
  assert.deepEqual(seen.take(), new Set([S2]));
  assert.deepEqual(seen.take(), new Set());

  const q = page();
  seen.focus(q, false, S3);
  seen.typed(q, S3);
  assert.equal(changes, 2);
  assert.deepEqual(seen.take(), new Set([S3]));
  assert.deepEqual(seen.take(), new Set());

  // A page that never told its focus.
  seen.typed(page(), S3);
  assert.deepEqual(seen.take(), new Set([S3]));
  assert.deepEqual(seen.take(), new Set());

  // The focused page's own hold is untouched.
  clock.advanceMs(1500);
  assert.deepEqual(seen.take(), new Set([S1]));
});

test('two pages: take() gives the union', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const p = page();
  const q = page();
  seen.focus(p, true, S1);
  clock.advanceMs(500);
  seen.focus(q, true, S2);
  clock.advanceMs(1000);
  assert.deepEqual(seen.take(), new Set([S1]));
  seen.typed(q, S3);
  clock.advanceMs(500);
  assert.deepEqual(seen.take(), new Set([S1, S2, S3]));
  assert.deepEqual(seen.take(), new Set([S1, S2]));

  // Both on one session: it is in once.
  seen.focus(q, true, S1);
  clock.advanceMs(1500);
  assert.deepEqual(seen.take(), new Set([S1]));
});

test('gone: that page sees nothing more and leaves no timer; the others go on', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  let changes = 0;
  seen.onChange(() => {
    changes += 1;
  });
  const p = page();
  const q = page();
  seen.focus(p, true, S1);
  clock.advanceMs(1500);
  seen.focus(q, true, S2);
  assert.equal(changes, 1);
  assert.equal(clock.timers(), 1);
  seen.gone(q);
  assert.equal(clock.timers(), 0);
  clock.advanceMs(5000);
  assert.equal(changes, 1);
  assert.deepEqual(seen.take(), new Set([S1]));
  seen.gone(p);
  assert.deepEqual(seen.take(), new Set());
  seen.gone(p);
  seen.gone(page());
  assert.deepEqual(seen.take(), new Set());
});

test('stop: every timer stopped, and nothing more is seen or told', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  let changes = 0;
  seen.onChange(() => {
    changes += 1;
  });
  const p = page();
  const q = page();
  seen.focus(p, true, S1);
  seen.focus(q, true, S2);
  seen.typed(page(), S3);
  assert.equal(clock.timers(), 2);
  assert.equal(changes, 1);
  seen.stop();
  assert.equal(clock.timers(), 0);
  assert.deepEqual(seen.take(), new Set(), 'nor the typing not yet taken');
  seen.focus(p, false, null);
  seen.focus(p, true, S3);
  seen.typed(p, S3);
  seen.typed(q, S2);
  assert.equal(clock.timers(), 0);
  clock.advanceMs(5000);
  assert.deepEqual(seen.take(), new Set());
  assert.equal(changes, 1);
  seen.stop();
});

test('onChange: once per completed hold and once per typing; off() ends it', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const calls: string[] = [];
  const off = seen.onChange(() => {
    calls.push('a');
  });
  seen.onChange(() => {
    calls.push('b');
  });
  const p = page();
  seen.focus(p, true, S1);
  clock.advanceMs(1499);
  assert.equal(calls.length, 0);
  clock.advanceMs(1);
  assert.equal(calls.length, 2, 'the hold completed: each listener once');
  clock.advanceMs(10_000);
  assert.equal(calls.length, 2, 'a hold is told once');
  seen.typed(p, S1);
  assert.equal(calls.length, 4, 'a typing');
  seen.typed(p, S2);
  assert.equal(calls.length, 6, 'another typing');
  off();
  off();
  seen.focus(p, true, S2);
  clock.advanceMs(1500);
  assert.deepEqual(calls.slice(6), ['b']);
});

test('the same listener twice is told twice, and each off() removes its own', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  let changes = 0;
  const listener = (): void => {
    changes += 1;
  };
  const off = seen.onChange(listener);
  seen.onChange(listener);
  seen.typed(page(), S1);
  assert.equal(changes, 2);
  off();
  seen.typed(page(), S1);
  assert.equal(changes, 3);
});

test('a listener that throws anyway: the others are told; a hold never throws out of its timer, a typing does', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  const failure = new Error('a listener broke its contract');
  let told = 0;
  seen.onChange(() => {
    throw failure;
  });
  seen.onChange(() => {
    told += 1;
  });
  const p = page();
  seen.focus(p, true, S1);
  assert.doesNotThrow(() => clock.advanceMs(1500));
  assert.equal(told, 1);
  assert.deepEqual(seen.take(), new Set([S1]));
  assert.throws(() => seen.typed(p, S2), failure);
  assert.equal(told, 2);
  assert.deepEqual(seen.take(), new Set([S1, S2]), 'the typing counted');
});
