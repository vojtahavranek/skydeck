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
    `${ESC}[<0;10;5xM`, // nor this: only digits and ';' between '<' and the final M
    `${ESC}[200~${ESC}[201~`, // an empty paste, which the page sends
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

/** Review 2's 31 keys and pastes as xterm.js 6.0.0 gives them (C1, ruled): every one is typing. */
const REVIEW_KEYS = [
  'a', // a
  '\r', // Enter
  '\n', // Shift+Enter
  '\x1b', // Esc
  '\t', // Tab
  '\x1b[Z', // Shift+Tab
  '\x7f', // Backspace
  '\x1b[A', // Up
  '\x1bOA', // Up, application cursor keys
  '\x1b[1;5A', // Ctrl+Up
  '\x1b[H', // Home
  '\x1b[F', // End
  '\x1b[5~', // PgUp
  '\x1b[3~', // Del
  '\x1b[2~', // Ins
  '\x1bOP', // F1
  '\x1bOR', // F3
  '\x1b[15~', // F5
  '\x1b[15;2~', // Shift+F5
  '\x1b[1;2P', // Shift+F1
  '\x1b[24~', // F12
  '\x1ba', // Alt+a
  '\x1b[', // Alt+[
  '\x1b]', // Alt+]
  '\x1bP', // Alt+Shift+P
  '\x03', // Ctrl+C
  '\x16', // Ctrl+Shift+V
  '\x1b[200~hi\x1b[201~', // a paste
  '\x1b[200~\x1b[201~', // an empty paste
  'žluťoučký kůň', // text
  '\x1b[Ia', // a focus report and a key
];

/** Review 2's 22 reports (C1, ruled): what a terminal sends by itself; none is typing. */
const REVIEW_REPORTS = [
  '\x1b[I', // focus in
  '\x1b[O', // focus out
  '\x1b[<0;10;5M', // SGR mouse
  '\x1b[<0;10;5m', // SGR mouse, release
  '\x1b[?1;2c', // DA1
  '\x1b[>0;276;0c', // DA2
  '\x1b[12;40R', // CPR
  '\x1b[?12;40R', // DECXCPR
  '\x1b[0n', // DSR
  '\x1b[?2026;2$y', // DECRQM, DEC mode
  '\x1b[4;1$y', // DECRQM, ANSI mode
  '\x1b[8;24;80t', // CSI 18 t
  '\x1b[4;600;800t', // CSI 14 t
  '\x1b]11;rgb:0000/0000/0000\x1b\\', // OSC 11, ended by ST
  '\x1b]10;rgb:ffff/ffff/ffff\x07', // OSC 10, ended by BEL
  '\x1b]4;1;rgb:cd00/0000/0000\x1b\\', // OSC 4
  '\x1bP1$r0m\x1b\\', // DECRQSS
  '\x1bP>|xterm.js(6.1.0)\x1b\\', // XTVERSION
  '\x1b[?0u', // kitty keyboard
  '\x1b[?997;1n', // mode 2031's colour-scheme report
  '\x1b[48;24;80;600;800t', // mode 2048's size report
  '\x1b[I\x1b[?1;2c\x1b]11;rgb:0/0/0\x07\x1b[<0;1;1M\x1b[O', // five in one message
];

/** More of each, beside review 2's. */
const MORE_KEYS = [
  `${ESC}[B`,
  `${ESC}[1;5C`, // Ctrl+Right
  `${ESC}[1;2S`, // Shift+F4
  `${ESC}b`, // Alt+b
  `${ESC}c`, // Alt+c
  `${ESC}[200~a paste that says ESC[0n and 12;40R${ESC}[201~`, // a paste holds no ESC (S2 9.1)
  '😀',
];
const MORE_REPORTS = [
  `${ESC}P!|00000000${ESC}\\`, // DA3
  `${ESC}[4;2$y`, // DECRQM, an ANSI mode reset
  `${ESC}]11;rgb:0000/0000/0000\x07`, // OSC 11, ended by BEL
];

test('isTyping (C1 of review 2, ruled): every key input and paste is typing', () => {
  for (const data of [...REVIEW_KEYS, ...MORE_KEYS]) {
    assert.equal(isTyping(data, false), true, JSON.stringify(data));
  }
});

test("isTyping (C1 of review 2, ruled): a terminal's own reports are not typing, by their shape", () => {
  for (const data of [...REVIEW_REPORTS, ...MORE_REPORTS]) {
    assert.equal(isTyping(data, false), false, JSON.stringify(data));
  }
  assert.equal(isTyping(`${ESC}[12;40Rx`, false), true, 'a key after a report');
});

test('isTyping: an OSC or DCS is a report only when it is whole in one message', () => {
  assert.equal(isTyping(`${ESC}]11;rgb:0000/0000/0000`, false), true);
  assert.equal(isTyping(`${ESC}P1$r0m`, false), true);
});

test('isTyping: F3 with any modifier has the bytes of a cursor report and is not typing (ruled)', () => {
  for (let modifier = 2; modifier <= 8; modifier += 1) {
    assert.equal(isTyping(`${ESC}[1;${modifier}R`, false), false, `modifier ${modifier}`);
  }
});

test('isTyping: every other key xterm.js sends with a modifier is typing', () => {
  for (let modifier = 2; modifier <= 8; modifier += 1) {
    for (const final of ['A', 'B', 'C', 'D', 'H', 'F', 'P', 'Q', 'S']) {
      const data = `${ESC}[1;${modifier}${final}`;
      assert.equal(isTyping(data, false), true, JSON.stringify(data));
    }
    for (const code of [2, 3, 5, 6, 15, 17, 18, 19, 20, 21, 23, 24]) {
      const data = `${ESC}[${code};${modifier}~`;
      assert.equal(isTyping(data, false), true, JSON.stringify(data));
    }
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

test('onChange: once per completed hold and once per typing that begins a seen; off() ends it', (t) => {
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
  assert.equal(calls.length, 2, 'a typing into a session already being seen begins nothing');
  seen.typed(p, S2);
  assert.equal(calls.length, 4, 'a typing that begins a seen');
  off();
  off();
  seen.focus(p, true, S2);
  clock.advanceMs(1500);
  assert.deepEqual(calls.slice(4), ['b']);
});

test('200 keys into a session: one call, for the key that began its seen (C4 of review 2)', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  let changes = 0;
  seen.onChange(() => {
    changes += 1;
  });
  const p = page();
  seen.focus(p, true, S1);
  clock.advanceMs(200);
  for (let key = 0; key < 200; key += 1) seen.typed(p, S1);
  assert.equal(changes, 1, 'the first key completed the hold');
  assert.equal(clock.timers(), 0);

  // A hold that completed by itself: no key calls a listener.
  seen.focus(p, true, S2);
  clock.advanceMs(1500);
  assert.equal(changes, 2);
  for (let key = 0; key < 200; key += 1) seen.typed(p, S2);
  assert.equal(changes, 2);

  // Typed into another terminal: the first key until the next take().
  for (let key = 0; key < 200; key += 1) seen.typed(p, S3);
  assert.equal(changes, 3);
  assert.deepEqual(seen.take(), new Set([S2, S3]));
  seen.typed(p, S3);
  assert.equal(changes, 4, 'given by take(), it is not being seen: a key begins it again');

  // Typed into a session another page holds: already being seen, and still in take().
  const q = page();
  seen.typed(q, S2);
  assert.equal(changes, 4);
  seen.focus(p, false, S2);
  assert.deepEqual(seen.take(), new Set([S2, S3]));
});

test("a listener that throws out of a completed hold does not throw out of the clock's timer", (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  seen.onChange(() => {
    throw new Error('a listener broke its contract');
  });
  const p = page();
  seen.focus(p, true, S1);
  assert.doesNotThrow(() => clock.advanceMs(1500));
  assert.deepEqual(seen.take(), new Set([S1]), 'the hold completed');
  assert.equal(clock.timers(), 0);
});

test('a page told gone stays gone: a later focus or typing for it holds nothing', (t) => {
  const { clock } = testPlatform(t);
  const seen = createSeen(clock);
  let changes = 0;
  seen.onChange(() => {
    changes += 1;
  });
  const p = page();
  seen.focus(p, true, S1);
  seen.gone(p);
  seen.focus(p, true, S2);
  seen.typed(p, S2);
  seen.typed(p, S3);
  assert.equal(clock.timers(), 0);
  clock.advanceMs(5000);
  assert.deepEqual(seen.take(), new Set());
  assert.equal(changes, 0);
});
