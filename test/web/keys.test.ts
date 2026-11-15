import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cancels, listKey, switcherKey, terminalKey, windowChord } from '../../web/keys.js';

type Zone = 'list' | 'terminal';
type Mod = 'ctrl' | 'shift' | 'alt' | 'meta';
type KeyLike = {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

/** A `KeyboardEvent`-like object: the character typed (`key`), the physical key (`code`). */
function ev(key: string, code: string, ...mods: Mod[]): KeyLike {
  return {
    key,
    code,
    ctrlKey: mods.includes('ctrl'),
    shiftKey: mods.includes('shift'),
    altKey: mods.includes('alt'),
    metaKey: mods.includes('meta'),
  };
}

/** Ctrl+Shift with a key: on Windows a page sees the shifted character in `key`. */
function cs(key: string, code: string): KeyLike {
  return ev(key, code, 'ctrl', 'shift');
}

const ZONES: readonly Zone[] = ['list', 'terminal'];

/** The list keys of stage D (S2 12.9, plan D 2.4): `l`, `g`, `n`, `p`, `d` and F2. */
const STAGE_D_KEYS: readonly KeyLike[] = [
  ...['l', 'g', 'n', 'p', 'd'].map((c) => ev(c, `Key${c.toUpperCase()}`)),
  ev('F2', 'F2'),
];

// What a US and a Czech (QWERTZ) layout type with Shift on the number row: on a US layout the
// symbols, on a Czech one the digits.
const US_SHIFTED_DIGITS = ['!', '@', '#', '$', '%', '^', '&', '*', '('];
const CZ_SHIFTED_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

type Chord = ReturnType<typeof windowChord>;

/** Every chord of S2 12.9 (stage A, A11) as one layout types it. */
function chordTable(shiftedDigits: readonly string[]): Array<[string, KeyLike, Chord]> {
  const rows: Array<[string, KeyLike, Chord]> = [
    ['Ctrl+Shift+P', cs('P', 'KeyP'), { kind: 'switcher' }],
    ['Ctrl+Shift+J', cs('J', 'KeyJ'), { kind: 'next-attention' }],
    ['Ctrl+Tab', ev('Tab', 'Tab', 'ctrl'), { kind: 'previous' }],
    ['Ctrl+Shift+O', cs('O', 'KeyO'), { kind: 'previous' }],
    ['Ctrl+Shift+L', cs('L', 'KeyL'), { kind: 'toggle-zone' }],
    ['Ctrl+Shift+N', cs('N', 'KeyN'), { kind: 'new' }],
    ['Ctrl+Shift+F', cs('F', 'KeyF'), { kind: 'find' }],
    ['Ctrl+Shift+C', cs('C', 'KeyC'), { kind: 'copy' }],
    ['Ctrl+Shift+V', cs('V', 'KeyV'), { kind: 'paste-raw' }],
    ['Ctrl+Shift+H', cs('H', 'KeyH'), { kind: 'help' }],
    ['Ctrl+Shift+R', cs('R', 'KeyR'), { kind: 'reload' }],
  ];
  shiftedDigits.forEach((typed, index) => {
    const slot = index + 1;
    rows.push([`Ctrl+Shift+${slot}`, cs(typed, `Digit${slot}`), { kind: 'slot', slot }]);
  });
  return rows;
}

const LAYOUTS: ReadonlyArray<readonly [name: string, table: Array<[string, KeyLike, Chord]>]> = [
  ['US', chordTable(US_SHIFTED_DIGITS)],
  // Czech QWERTZ: the letters of the table sit where they do on a US layout (only Y and Z swap),
  // and Shift on the number row types the digits.
  ['Czech', chordTable(CZ_SHIFTED_DIGITS)],
];

describe('windowChord: every chord of S2 12.9, on both layouts, in both zones', () => {
  for (const [layout, table] of LAYOUTS) {
    for (const zone of ZONES) {
      for (const [name, e, expected] of table) {
        test(`${layout}, ${zone} zone: ${name}`, () => {
          assert.deepEqual(windowChord(e, zone), expected);
        });
      }
    }
  }
});

describe('windowChord: matching', () => {
  for (const zone of ZONES) {
    test(`${zone} zone: Ctrl+Shift+- stays with Claude Code (undo), on both layouts`, () => {
      assert.equal(windowChord(cs('_', 'Minus'), zone), null); // US
      assert.equal(windowChord(cs('_', 'Slash'), zone), null); // Czech: '-' is on the Slash key
      assert.equal(windowChord(cs('%', 'Minus'), zone), null); // Czech: the Minus key
    });

    test(`${zone} zone: Ctrl+Shift+/ is not the help`, () => {
      assert.equal(windowChord(cs('?', 'Slash'), zone), null);
    });

    test(`${zone} zone: Ctrl+Shift+0 is no slot, on both layouts`, () => {
      assert.equal(windowChord(cs(')', 'Digit0'), zone), null);
      assert.equal(windowChord(cs('0', 'Digit0'), zone), null);
    });

    test(`${zone} zone: a lower-case letter (Caps Lock) still matches`, () => {
      assert.deepEqual(windowChord(cs('h', 'KeyH'), zone), { kind: 'help' });
      assert.deepEqual(windowChord(cs('p', 'KeyP'), zone), { kind: 'switcher' });
      assert.deepEqual(windowChord(cs('j', 'KeyJ'), zone), { kind: 'next-attention' });
    });
  }

  test('letters are matched by the character typed, not by the physical key', () => {
    // Dvorak: the physical J key types H, the physical C key types J.
    assert.deepEqual(windowChord(cs('H', 'KeyJ'), 'terminal'), { kind: 'help' });
    assert.deepEqual(windowChord(cs('J', 'KeyC'), 'terminal'), { kind: 'next-attention' });
    // A layout whose H key types another letter: no chord.
    assert.equal(windowChord(cs('Р', 'KeyH'), 'terminal'), null);
  });

  test('a digit typed wins over the physical key', () => {
    // Programmer Dvorak: Shift on the physical 2 types 7, on the physical 7 types 0.
    assert.deepEqual(windowChord(cs('7', 'Digit2'), 'terminal'), { kind: 'slot', slot: 7 });
    assert.equal(windowChord(cs('0', 'Digit7'), 'terminal'), null);
  });

  test('a number-row key that types no digit falls back to the physical key', () => {
    // Lithuanian: Shift on the number row types letters.
    assert.deepEqual(windowChord(cs('Ą', 'Digit1'), 'terminal'), { kind: 'slot', slot: 1 });
  });

  test('a key off the number row that types no digit is no slot', () => {
    // Shift with Ctrl on the numeric keypad types a navigation key.
    assert.equal(windowChord(cs('End', 'Numpad1'), 'terminal'), null);
  });

  test('only Ctrl together with Shift makes a chord', () => {
    assert.equal(windowChord(ev('p', 'KeyP', 'ctrl'), 'terminal'), null);
    assert.equal(windowChord(ev('P', 'KeyP', 'shift'), 'terminal'), null);
    assert.equal(windowChord(ev('1', 'Digit1', 'ctrl'), 'terminal'), null);
    assert.equal(windowChord(ev('!', 'Digit1', 'shift'), 'terminal'), null);
  });

  test('Alt or Meta with a chord is no chord (AltGr is Ctrl+Alt on Windows)', () => {
    assert.equal(windowChord(ev('P', 'KeyP', 'ctrl', 'shift', 'alt'), 'terminal'), null);
    assert.equal(windowChord(ev('P', 'KeyP', 'ctrl', 'shift', 'meta'), 'terminal'), null);
    assert.equal(windowChord(ev('1', 'Digit1', 'ctrl', 'shift', 'alt'), 'terminal'), null);
    assert.equal(windowChord(ev('Tab', 'Tab', 'ctrl', 'alt'), 'terminal'), null);
  });

  test('Czech AltGr characters are no chord', () => {
    for (const zone of ZONES) {
      assert.equal(windowChord(ev('@', 'KeyV', 'ctrl', 'alt'), zone), null);
      assert.equal(windowChord(ev('\\', 'KeyQ', 'ctrl', 'alt'), zone), null);
      assert.equal(windowChord(ev('{', 'KeyB', 'ctrl', 'alt'), zone), null);
    }
  });

  test('Ctrl+Shift+Tab and a bare Tab are not the window’s', () => {
    assert.equal(windowChord(cs('Tab', 'Tab'), 'terminal'), null);
    assert.equal(windowChord(ev('Tab', 'Tab'), 'terminal'), null);
  });

  test('a Ctrl+Shift chord the window does not use keeps Edge’s default', () => {
    for (const zone of ZONES) {
      assert.equal(windowChord(cs('W', 'KeyW'), zone), null);
      assert.equal(windowChord(cs('I', 'KeyI'), zone), null);
      assert.equal(windowChord(cs('T', 'KeyT'), zone), null);
    }
  });

  test('function keys, Esc and plain keys are never the window’s', () => {
    for (const zone of ZONES) {
      assert.equal(windowChord(ev('F5', 'F5'), zone), null);
      assert.equal(windowChord(ev('Escape', 'Escape'), zone), null);
      assert.equal(windowChord(ev('r', 'KeyR', 'ctrl'), zone), null);
      assert.equal(windowChord(ev('a', 'KeyA'), zone), null);
      assert.equal(windowChord(ev('F4', 'F4', 'alt'), zone), null);
    }
  });

  test('a dead key is no chord', () => {
    assert.equal(windowChord(ev('Dead', 'Equal'), 'terminal'), null);
    assert.equal(windowChord(cs('Dead', 'Equal'), 'terminal'), null);
  });

  // Ruled 2026-11-13: Chromium reloads on the BrowserRefresh key too (from memory, unverified),
  // and xterm.js sends nothing for it, so it is the page's reload in both zones.
  test('the BrowserRefresh key, alone, with Shift or with Ctrl, is the reload in both zones', () => {
    for (const zone of ZONES) {
      for (const mods of [[], ['shift'], ['ctrl']] as Mod[][]) {
        const e = ev('BrowserRefresh', 'BrowserRefresh', ...mods);
        assert.deepEqual(windowChord(e, zone), { kind: 'reload' }, `${mods} in ${zone}`);
      }
    }
  });

  test('BrowserRefresh with Alt or with Ctrl+Shift is no chord', () => {
    assert.equal(windowChord(ev('BrowserRefresh', 'BrowserRefresh', 'alt'), 'list'), null);
    assert.equal(windowChord(cs('BrowserRefresh', 'BrowserRefresh'), 'list'), null);
  });

  test('Shift+F5 is not the window’s (in the terminal zone it goes to the program)', () => {
    for (const zone of ZONES) {
      assert.equal(windowChord(ev('F5', 'F5', 'shift'), zone), null);
    }
  });
});

describe('terminalKey (S2 9.1)', () => {
  test('Shift+Enter sends a newline', () => {
    assert.deepEqual(terminalKey(ev('Enter', 'Enter', 'shift')), { send: '\n' });
    assert.deepEqual(terminalKey(ev('Enter', 'NumpadEnter', 'shift')), { send: '\n' });
  });

  test('Enter alone, and Enter with other modifiers, are xterm.js’s', () => {
    assert.equal(terminalKey(ev('Enter', 'Enter')), null);
    assert.equal(terminalKey(ev('Enter', 'Enter', 'ctrl')), null);
    assert.equal(terminalKey(ev('Enter', 'Enter', 'alt', 'shift')), null);
    assert.equal(terminalKey(ev('Enter', 'Enter', 'ctrl', 'shift')), null);
  });

  test('Ctrl+V is left to the browser, which pastes', () => {
    assert.equal(terminalKey(ev('v', 'KeyV', 'ctrl')), 'browser');
    assert.equal(terminalKey(ev('V', 'KeyV', 'ctrl')), 'browser'); // Caps Lock
    assert.equal(terminalKey(ev('v', 'Period', 'ctrl')), 'browser'); // Dvorak: by the character
  });

  test('Ctrl+Shift+V sends a raw Ctrl+V, on both layouts', () => {
    assert.deepEqual(terminalKey(cs('V', 'KeyV')), { send: '\x16' });
    assert.deepEqual(terminalKey(cs('v', 'KeyV')), { send: '\x16' });
  });

  test('Czech AltGr+V types @ and is xterm.js’s, never a paste', () => {
    assert.equal(terminalKey(ev('@', 'KeyV', 'ctrl', 'alt')), null);
    assert.equal(terminalKey(ev('V', 'KeyV', 'ctrl', 'alt')), null);
  });

  test('Alt+F4 is left to the browser (the window closes)', () => {
    assert.equal(terminalKey(ev('F4', 'F4', 'alt')), 'browser');
    assert.equal(terminalKey(ev('F4', 'F4', 'alt', 'shift')), 'browser');
  });

  test('other keys are xterm.js’s', () => {
    assert.equal(terminalKey(ev('a', 'KeyA')), null);
    assert.equal(terminalKey(ev('c', 'KeyC', 'ctrl')), null);
    assert.equal(terminalKey(ev('r', 'KeyR', 'ctrl')), null);
    assert.equal(terminalKey(ev('F5', 'F5')), null);
    assert.equal(terminalKey(ev('F5', 'F5', 'shift')), null);
    assert.equal(terminalKey(ev('F4', 'F4')), null);
    assert.equal(terminalKey(ev('F4', 'F4', 'ctrl', 'alt')), null);
    assert.equal(terminalKey(ev('Escape', 'Escape')), null);
    assert.equal(terminalKey(ev('_', 'Minus', 'ctrl', 'shift')), null);
    assert.equal(terminalKey(ev('Dead', 'Equal')), null);
  });
});

type ListAction = ReturnType<typeof listKey>;

describe('listKey (S2 12.9)', () => {
  const table: ReadonlyArray<readonly [name: string, e: KeyLike, action: ListAction]> = [
    ['↓', ev('ArrowDown', 'ArrowDown'), { kind: 'move', by: 1 }],
    ['↑', ev('ArrowUp', 'ArrowUp'), { kind: 'move', by: -1 }],
    ['j', ev('j', 'KeyJ'), { kind: 'move', by: 1 }],
    ['k', ev('k', 'KeyK'), { kind: 'move', by: -1 }],
    ['Home', ev('Home', 'Home'), { kind: 'move', by: 'home' }],
    ['End', ev('End', 'End'), { kind: 'move', by: 'end' }],
    ['PgUp', ev('PageUp', 'PageUp'), { kind: 'move', by: 'page-up' }],
    ['PgDn', ev('PageDown', 'PageDown'), { kind: 'move', by: 'page-down' }],
    ['←', ev('ArrowLeft', 'ArrowLeft'), { kind: 'fold' }],
    ['→', ev('ArrowRight', 'ArrowRight'), { kind: 'unfold' }],
    ['Enter', ev('Enter', 'Enter'), { kind: 'enter' }],
    ['/ (US)', ev('/', 'Slash'), { kind: 'filter' }],
    ['/ (Czech: Shift on the ú key)', ev('/', 'BracketLeft', 'shift'), { kind: 'filter' }],
    ['a', ev('a', 'KeyA'), { kind: 'show-done' }],
    ['Esc', ev('Escape', 'Escape'), { kind: 'escape' }],
    ['F5', ev('F5', 'F5'), { kind: 'reload' }],
    ['Ctrl+R', ev('r', 'KeyR', 'ctrl'), { kind: 'reload' }],
    ['Ctrl+Shift+R', cs('R', 'KeyR'), { kind: 'reload' }],
    ['Ctrl+F5', ev('F5', 'F5', 'ctrl'), { kind: 'reload' }],
    ['Shift+F5 (ruled 2026-11-13)', ev('F5', 'F5', 'shift'), { kind: 'reload' }],
    ['BrowserRefresh', ev('BrowserRefresh', 'BrowserRefresh'), { kind: 'reload' }],
    ['Shift+BrowserRefresh', ev('BrowserRefresh', 'BrowserRefresh', 'shift'), { kind: 'reload' }],
    ['Ctrl+BrowserRefresh', ev('BrowserRefresh', 'BrowserRefresh', 'ctrl'), { kind: 'reload' }],
    // Stage D (plan D 2.4): the label (also F2), the group, the note, the pull requests, done.
    ['l', ev('l', 'KeyL'), { kind: 'edit', what: 'label' }],
    ['F2', ev('F2', 'F2'), { kind: 'edit', what: 'label' }],
    ['g', ev('g', 'KeyG'), { kind: 'edit', what: 'group' }],
    ['n', ev('n', 'KeyN'), { kind: 'edit', what: 'note' }],
    ['p', ev('p', 'KeyP'), { kind: 'edit', what: 'pr' }],
    ['d', ev('d', 'KeyD'), { kind: 'done' }],
  ];
  for (const [name, e, action] of table) {
    test(name, () => {
      assert.deepEqual(listKey(e), action);
    });
  }

  test('letters are matched by the character typed', () => {
    // Dvorak: the physical C key types j, the physical V key types k.
    assert.deepEqual(listKey(ev('j', 'KeyC')), { kind: 'move', by: 1 });
    assert.deepEqual(listKey(ev('k', 'KeyV')), { kind: 'move', by: -1 });
    assert.equal(listKey(ev('ů', 'Semicolon')), null);
  });

  test('upper-case letters are not the list keys (as in step 1)', () => {
    assert.equal(listKey(ev('J', 'KeyJ', 'shift')), null);
    assert.equal(listKey(ev('A', 'KeyA', 'shift')), null);
    assert.equal(listKey(ev('L', 'KeyL', 'shift')), null);
  });

  test('Ctrl, Alt or Meta with a list key is no list key', () => {
    for (const mod of ['ctrl', 'alt', 'meta'] as const) {
      for (const c of ['l', 'g', 'n', 'p', 'd']) {
        assert.equal(listKey(ev(c, `Key${c.toUpperCase()}`, mod)), null, `${mod}+${c}`);
      }
      assert.equal(listKey(ev('j', 'KeyJ', mod)), null);
      assert.equal(listKey(ev('/', 'Slash', mod)), null);
      assert.equal(listKey(ev('ArrowDown', 'ArrowDown', mod)), null);
      assert.equal(listKey(ev('Enter', 'Enter', mod)), null);
      assert.equal(listKey(ev('F2', 'F2', mod)), null);
    }
  });

  test('Shift with a named key is no list key', () => {
    assert.equal(listKey(ev('ArrowDown', 'ArrowDown', 'shift')), null);
    assert.equal(listKey(ev('Enter', 'Enter', 'shift')), null);
    assert.equal(listKey(ev('Escape', 'Escape', 'shift')), null);
    assert.equal(listKey(ev('F2', 'F2', 'shift')), null);
  });

  test('other reload-looking keys are not the list’s', () => {
    assert.equal(listKey(ev('F5', 'F5', 'alt')), null);
    assert.equal(listKey(ev('F5', 'F5', 'ctrl', 'shift')), null);
    assert.equal(listKey(ev('BrowserRefresh', 'BrowserRefresh', 'alt')), null);
    assert.equal(listKey(ev('r', 'KeyR')), null);
    assert.equal(listKey(ev('r', 'KeyR', 'ctrl', 'alt')), null);
  });

  test('Czech AltGr characters are no list key', () => {
    assert.equal(listKey(ev('/', 'Slash', 'ctrl', 'alt')), null);
    assert.equal(listKey(ev('@', 'KeyV', 'ctrl', 'alt')), null);
  });

  test('keys the list does not use', () => {
    assert.equal(listKey(ev('x', 'KeyX')), null);
    assert.equal(listKey(ev('q', 'KeyQ')), null); // step 1's quit
    assert.equal(listKey(ev('R', 'KeyR', 'shift')), null); // step 1's refresh
    assert.equal(listKey(ev('Tab', 'Tab')), null);
    assert.equal(listKey(ev(' ', 'Space')), null);
    assert.equal(listKey(ev('w', 'KeyW', 'ctrl')), null);
    assert.equal(listKey(ev('F4', 'F4', 'alt')), null);
    assert.equal(listKey(ev('Dead', 'Equal')), null);
  });
});

describe('an event without a key (Chromium sends a keydown with no `key` for autofill)', () => {
  const keyless = { ...ev('', 'KeyA'), key: undefined } as unknown as KeyLike;
  const keylessCtrlShift = { ...cs('', 'Digit1'), key: undefined } as unknown as KeyLike;

  test('is nothing of the window’s, the terminal’s or the list’s, and never throws', () => {
    for (const zone of ZONES) {
      assert.equal(windowChord(keyless, zone), null);
      assert.equal(windowChord(keylessCtrlShift, zone), null);
    }
    assert.equal(terminalKey(keyless), null);
    assert.equal(listKey(keyless), null);
  });

  test('is cancelled exactly when the page acted on it', () => {
    for (const zone of ZONES) {
      assert.equal(cancels(keyless, zone, false), false);
      assert.equal(cancels(keyless, zone, true), true);
    }
  });
});

describe('cancels (S2 12.9, what the page cancels)', () => {
  const altF4 = ev('F4', 'F4', 'alt');

  test('Alt+F4 never, in either zone, whatever the page did', () => {
    for (const zone of ZONES) {
      assert.equal(cancels(altF4, zone, false), false);
      assert.equal(cancels(altF4, zone, true), false);
      assert.equal(cancels(ev('F4', 'F4', 'alt', 'shift'), zone, true), false);
    }
  });

  test('a key neither zone uses never', () => {
    for (const zone of ZONES) {
      assert.equal(cancels(cs('W', 'KeyW'), zone, false), false); // Edge closes the window
      assert.equal(cancels(cs('I', 'KeyI'), zone, false), false);
      assert.equal(cancels(cs('_', 'Minus'), zone, false), false); // Claude Code's undo
    }
    assert.equal(cancels(ev('w', 'KeyW', 'ctrl'), 'list', false), false); // closes the window
  });

  test('F5 and Ctrl+R: yes in the list zone, no in the terminal zone (they go to the program)', () => {
    for (const handled of [false, true]) {
      assert.equal(cancels(ev('F5', 'F5'), 'list', handled), true);
      assert.equal(cancels(ev('r', 'KeyR', 'ctrl'), 'list', handled), true);
      assert.equal(cancels(ev('F5', 'F5', 'ctrl'), 'list', handled), true);
    }
    assert.equal(cancels(ev('F5', 'F5'), 'terminal', false), false);
    assert.equal(cancels(ev('r', 'KeyR', 'ctrl'), 'terminal', false), false);
    assert.equal(cancels(ev('F5', 'F5', 'ctrl'), 'terminal', false), false);
  });

  test('Shift+F5: yes in the list zone, no in the terminal zone (it goes to the program)', () => {
    for (const handled of [false, true]) {
      assert.equal(cancels(ev('F5', 'F5', 'shift'), 'list', handled), true);
    }
    assert.equal(cancels(ev('F5', 'F5', 'shift'), 'terminal', false), false);
  });

  // Ruled 2026-11-13: in the terminal zone the reload keys go to the program only while xterm.js
  // has the keyboard; while something of the page has it (the find bar, the New form, a card, the
  // ended bar) app.js takes them as the page's reload — listKey classifies them in any zone — and
  // passes handled = true.
  test('terminal zone, the keyboard not with xterm.js: the reload keys are the page’s', () => {
    for (const e of [
      ev('F5', 'F5'),
      ev('F5', 'F5', 'shift'),
      ev('F5', 'F5', 'ctrl'),
      ev('r', 'KeyR', 'ctrl'),
    ]) {
      const name = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`;
      assert.deepEqual(listKey(e), { kind: 'reload' }, name);
      assert.equal(cancels(e, 'terminal', true), true, name);
    }
  });

  test('BrowserRefresh, alone, with Shift or with Ctrl, in both zones', () => {
    for (const zone of ZONES) {
      for (const mods of [[], ['shift'], ['ctrl']] as Mod[][]) {
        const e = ev('BrowserRefresh', 'BrowserRefresh', ...mods);
        assert.equal(cancels(e, zone, false), true, `${mods} in ${zone}`);
      }
    }
  });

  test('Ctrl+Shift+R in both zones', () => {
    for (const zone of ZONES) {
      for (const handled of [false, true]) {
        assert.equal(cancels(cs('R', 'KeyR'), zone, handled), true);
      }
    }
  });

  test('every chord of the window, later stages included, in both zones', () => {
    for (const [, table] of LAYOUTS) {
      for (const [name, e] of table) {
        for (const zone of ZONES) {
          assert.equal(cancels(e, zone, false), true, `${name} in the ${zone} zone`);
        }
      }
    }
  });

  test('Ctrl+Shift+P is cancelled in both zones', () => {
    for (const zone of ZONES) {
      assert.equal(cancels(cs('P', 'KeyP'), zone, false), true);
    }
  });

  test('Ctrl+Shift+J (stage B: the next session that needs you) in both zones, on both layouts', () => {
    for (const zone of ZONES) {
      for (const e of [cs('J', 'KeyJ'), cs('j', 'KeyJ')]) {
        for (const handled of [false, true]) {
          assert.equal(cancels(e, zone, handled), true, `${e.key} in the ${zone} zone`);
        }
      }
    }
  });

  test('the stage D keys l g n p d F2 are cancelled in the list zone, where the page acts on them', () => {
    for (const e of STAGE_D_KEYS) {
      assert.equal(cancels(e, 'list', true), true, e.key);
    }
  });

  test('every list key the page acted on, in the list zone', () => {
    for (const e of [
      ev('ArrowDown', 'ArrowDown'),
      ev('j', 'KeyJ'),
      ev('Home', 'Home'),
      ev('ArrowLeft', 'ArrowLeft'),
      ev('Enter', 'Enter'),
      ev('/', 'Slash'),
      ev('a', 'KeyA'),
      ev('Escape', 'Escape'),
    ]) {
      assert.equal(cancels(e, 'list', true), true, e.key);
    }
  });

  test('a text field of the page keeps the characters it is given (handled false)', () => {
    // While the filter's text box has the keyboard, `j`, `l` and `/` type into it.
    assert.equal(cancels(ev('j', 'KeyJ'), 'list', false), false);
    assert.equal(cancels(ev('l', 'KeyL'), 'list', false), false);
    assert.equal(cancels(ev('/', 'Slash'), 'list', false), false);
    assert.equal(cancels(ev('v', 'KeyV', 'ctrl'), 'list', false), false); // a paste into it
  });

  test('in the terminal zone the list keys, the stage D keys too, go to the program', () => {
    for (const e of [ev('l', 'KeyL'), ev('F2', 'F2'), ev('j', 'KeyJ'), ev('Escape', 'Escape')]) {
      assert.notEqual(listKey(e), null);
      assert.equal(cancels(e, 'terminal', false), false, e.key);
    }
  });

  test('the stage D keys l g n p d F2 are nothing of the window’s or the terminal mapping', () => {
    for (const e of STAGE_D_KEYS) {
      assert.notEqual(listKey(e), null, e.key);
      assert.equal(windowChord(e, 'terminal'), null, e.key);
      assert.equal(terminalKey(e), null, e.key);
      assert.equal(cancels(e, 'terminal', false), false, e.key);
    }
  });

  test('keys the page sends to the terminal itself are cancelled', () => {
    assert.equal(cancels(ev('Enter', 'Enter', 'shift'), 'terminal', false), true);
    assert.equal(cancels(cs('V', 'KeyV'), 'terminal', false), true);
  });

  test('Ctrl+V in the terminal zone never: the browser pastes', () => {
    assert.equal(cancels(ev('v', 'KeyV', 'ctrl'), 'terminal', false), false);
    assert.equal(cancels(ev('v', 'KeyV', 'ctrl'), 'terminal', true), false);
  });

  test('keys xterm.js handles are not cancelled by the page (xterm.js cancels what it sends)', () => {
    for (const e of [ev('a', 'KeyA'), ev('c', 'KeyC', 'ctrl'), ev('Enter', 'Enter')]) {
      assert.equal(cancels(e, 'terminal', false), false, e.key);
    }
  });

  test('a key the page used outside the table is cancelled when it says so', () => {
    // For example Enter in the find bar over the terminal.
    assert.equal(cancels(ev('Enter', 'Enter'), 'terminal', true), true);
    assert.equal(cancels(ev('Tab', 'Tab'), 'list', true), true);
  });
});

describe('`later` (A11) is gone after stage E', () => {
  /** Every character and named key a test here can name, with each of the 16 sets of modifiers. */
  const everyEvent = (): KeyLike[] => {
    const keys = [
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      ...'`-=[]\\;\',./~!@#$%^&*()_+{}|:"<>? ěščřžýáíéúů',
      ...['Enter', 'Escape', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'BrowserRefresh'],
      ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
    ];
    const events: KeyLike[] = [];
    for (const key of keys) {
      const code = /^[a-z]$/i.test(key)
        ? `Key${key.toUpperCase()}`
        : /^[0-9]$/.test(key)
          ? `Digit${key}`
          : key;
      for (let bits = 0; bits < 16; bits++) {
        events.push({
          key,
          code,
          ctrlKey: (bits & 1) !== 0,
          shiftKey: (bits & 2) !== 0,
          altKey: (bits & 4) !== 0,
          metaKey: (bits & 8) !== 0,
        });
      }
    }
    return events;
  };

  test('no key gives `later` any more: Ctrl+Shift+P, the last one, is the switcher (stage E)', () => {
    const later: string[] = [];
    for (const e of everyEvent()) {
      const name = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${e.metaKey ? 'Meta+' : ''}${e.key}`;
      const kinds: (string | undefined)[] = [listKey(e)?.kind, switcherKey(e)?.kind];
      for (const zone of ZONES) kinds.push(windowChord(e, zone)?.kind);
      if (kinds.includes('later')) later.push(name);
    }
    assert.deepEqual(later, []);
  });
});

describe('switcherKey (E11: the switcher’s field)', () => {
  test('Ctrl+Shift+P on a US and a Czech layout, both zones: the switcher, cancelled', () => {
    // A Czech layout types the same letters as a US one; Caps Lock gives the lower case.
    for (const e of [cs('P', 'KeyP'), cs('p', 'KeyP')]) {
      for (const zone of ZONES) {
        assert.deepEqual(windowChord(e, zone), { kind: 'switcher' });
        for (const handled of [false, true]) {
          assert.equal(cancels(e, zone, handled), true);
        }
      }
    }
  });

  test('↑ ↓ PgUp PgDn move, Enter picks, Esc closes, Tab and Shift+Tab stay', () => {
    assert.deepEqual(switcherKey(ev('ArrowDown', 'ArrowDown')), { kind: 'move', by: 1 });
    assert.deepEqual(switcherKey(ev('ArrowUp', 'ArrowUp')), { kind: 'move', by: -1 });
    assert.deepEqual(switcherKey(ev('PageUp', 'PageUp')), { kind: 'move', by: 'page-up' });
    assert.deepEqual(switcherKey(ev('PageDown', 'PageDown')), { kind: 'move', by: 'page-down' });
    assert.deepEqual(switcherKey(ev('Enter', 'Enter')), { kind: 'pick' });
    assert.deepEqual(switcherKey(ev('Enter', 'NumpadEnter')), { kind: 'pick' });
    assert.deepEqual(switcherKey(ev('Escape', 'Escape')), { kind: 'close' });
    assert.deepEqual(switcherKey(ev('Tab', 'Tab')), { kind: 'stay' });
    assert.deepEqual(switcherKey(ev('Tab', 'Tab', 'shift')), { kind: 'stay' });
  });

  test('null with Ctrl, Alt or Meta; Shift only for Tab', () => {
    const named = ['ArrowDown', 'ArrowUp', 'PageUp', 'PageDown', 'Enter', 'Escape', 'Tab'];
    for (const key of named) {
      for (const mod of ['ctrl', 'alt', 'meta'] as const) {
        assert.equal(switcherKey(ev(key, key, mod)), null, `${mod}+${key}`);
        assert.equal(switcherKey(ev(key, key, mod, 'shift')), null, `${mod}+Shift+${key}`);
      }
      if (key !== 'Tab') {
        assert.equal(switcherKey(ev(key, key, 'shift')), null, `Shift+${key}`);
      }
    }
  });

  test('null for a letter, a digit, a character and the keys it does not use', () => {
    for (const [key, code] of [
      ['j', 'KeyJ'],
      ['d', 'KeyD'],
      ['/', 'Slash'],
      ['>', 'Period'],
      ['1', 'Digit1'],
      [' ', 'Space'],
      ['ArrowLeft', 'ArrowLeft'],
      ['ArrowRight', 'ArrowRight'],
      ['Home', 'Home'],
      ['End', 'End'],
      ['Backspace', 'Backspace'],
      ['F2', 'F2'],
      ['F5', 'F5'],
    ] as const) {
      assert.equal(switcherKey(ev(key, code)), null, key);
    }
    assert.equal(switcherKey(ev('P', 'KeyP', 'shift')), null, 'Shift+P');
    assert.equal(switcherKey(cs('P', 'KeyP')), null, 'Ctrl+Shift+P is the chord, not a field key');
  });

  test('an event without a `key` (an autofill pick) is no key of the field', () => {
    assert.equal(switcherKey({ ...ev('', ''), key: undefined as unknown as string }), null);
  });
});
