// The favourite flags of the new form, kept by skydeck (S2 12.6, 10.2; follow-up F15): the
// server's rule of what may be a favourite (prepareNew's refusal of the flags `skydeck new`
// refuses included, in its words), the list in kv `window_favourites` (read, added to, taken
// from), the actions `favourite-add` and `favourite-remove` (Undo's put-back at the old place,
// every refusal, the limit, `changed()` after a write and never after a refusal), and every wrong
// shape of the two messages refused by the parser. Pages and restarts: server-favourites.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { UsageError } from '../../src/platform/errors.ts';
import { prepareNew } from '../../src/sessions/resume.ts';
import { createActions } from '../../src/window/actions.ts';
import {
  addFavourite,
  FAVOURITE_LENGTH,
  FAVOURITE_REFUSALS,
  FAVOURITES_KEY,
  favouriteRefusal,
  readFavourites,
  removeFavourite,
} from '../../src/window/favourites.ts';
import { splitFlags } from '../../src/window/flags.ts';
import type { PageInfo, TerminalHub } from '../../src/window/hub.ts';
import { MAX_FAVOURITES, parsePageMessage } from '../../src/window/protocol.ts';
import type { ActMessage, ResultMessage } from '../../src/window/protocol.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';

const PAGE: PageInfo = {
  windowId: '0123456789abcdef',
  focused: true,
  area: { cols: 80, rows: 24 },
};
const NOT_AN_ACTION = 'skydeck cannot do that action';

/** prepareNew's refusal of these flags (the words Start shows), null when it takes them. */
function prepareNewRefusal(d: TestDeck, text: string): string | null {
  const split = splitFlags(text);
  assert.ok(split.ok, text);
  try {
    prepareNew(d.deck, { dir: d.platform.cwd, label: null, group: null, extra: split.flags });
    return null;
  } catch (error) {
    assert.ok(error instanceof UsageError, String(error));
    return error.message;
  }
}

const twelve = (): string[] => Array.from({ length: MAX_FAVOURITES }, (_, i) => `--f${i}`);

describe("favouriteRefusal: the server's rule (S2 12.6, F15)", () => {
  test('a good text: null', () => {
    assert.equal(favouriteRefusal('--model opus', []), null);
    assert.equal(favouriteRefusal('  --worktree  ', ['--model opus']), null);
  });

  test("a flag `skydeck new` refuses: refused with prepareNew's own words", (t) => {
    const d = testDeck(t);
    for (const text of [
      '--resume',
      '-r x',
      '-c',
      '--continue',
      '-cp',
      '--session-id 0',
      '--fork-session',
      '--from-pr 7',
      '--model opus --name x',
      '-n x',
      '--name=x',
    ]) {
      const words = prepareNewRefusal(d, text);
      assert.notEqual(words, null, text);
      assert.equal(favouriteRefusal(text, []), words, text);
    }
  });

  test('flags prepareNew takes are taken', (t) => {
    const d = testDeck(t);
    for (const text of ['--worktree', '--tmux', '--model opus', '-p', '--add-dir /x', 'a prompt']) {
      assert.equal(prepareNewRefusal(d, text), null, text);
      assert.equal(favouriteRefusal(text, []), null, text);
    }
  });

  test('each other refusal with its words, in the order empty, split, control, too long, known, full, flags', () => {
    assert.equal(favouriteRefusal(' ', []), FAVOURITE_REFUSALS.empty);
    assert.equal(favouriteRefusal("--resume 'x", []), "the flags have an unclosed '");
    assert.equal(favouriteRefusal('--x\0', []), 'the flags contain a NUL character');
    assert.equal(favouriteRefusal(`--resume\n${'a'.repeat(200)}`, []), FAVOURITE_REFUSALS.control);
    assert.equal(favouriteRefusal('--model\topus', []), FAVOURITE_REFUSALS.control);
    assert.equal(favouriteRefusal('--x\u202e', []), FAVOURITE_REFUSALS.control);
    assert.equal(favouriteRefusal('--x\u2028y', []), FAVOURITE_REFUSALS.control);
    assert.equal(favouriteRefusal(`--resume ${'a'.repeat(200)}`, []), FAVOURITE_REFUSALS.tooLong);
    assert.equal(favouriteRefusal('--model   opus', ['--model opus']), FAVOURITE_REFUSALS.known);
    assert.equal(favouriteRefusal('--resume', twelve()), FAVOURITE_REFUSALS.full);
    assert.equal(FAVOURITE_LENGTH, 200);
  });
});

describe('the list in kv window_favourites', () => {
  test('none stored: no favourite', (t) => {
    const d = testDeck(t);
    assert.deepEqual(readFavourites(d.deck.store), []);
    assert.equal(FAVOURITES_KEY, 'window_favourites');
  });

  test('added in the order of adding, trimmed, otherwise as typed; stored as a JSON array', (t) => {
    const d = testDeck(t);
    assert.equal(addFavourite(d.deck.store, '  --model opus\t'), null);
    assert.equal(addFavourite(d.deck.store, `--append-system-prompt "be  brief"`), null);
    assert.deepEqual(readFavourites(d.deck.store), [
      '--model opus',
      '--append-system-prompt "be  brief"',
    ]);
    assert.equal(
      d.deck.store.getKv('window_favourites'),
      JSON.stringify(['--model opus', '--append-system-prompt "be  brief"']),
    );
  });

  test('a refused text is answered with its words and nothing is written', (t) => {
    const d = testDeck(t);
    assert.equal(addFavourite(d.deck.store, '--model opus'), null);
    const before = d.deck.store.getKv('window_favourites');
    assert.equal(addFavourite(d.deck.store, '--model opus'), FAVOURITE_REFUSALS.known);
    assert.equal(addFavourite(d.deck.store, ''), FAVOURITE_REFUSALS.empty);
    assert.match(addFavourite(d.deck.store, '-c') ?? '', /^cannot pass -c to claude: /);
    assert.equal(d.deck.store.getKv('window_favourites'), before);
  });

  test('at most 12: the thirteenth is refused', (t) => {
    const d = testDeck(t);
    for (const one of twelve()) assert.equal(addFavourite(d.deck.store, one), null, one);
    assert.equal(addFavourite(d.deck.store, '--more'), FAVOURITE_REFUSALS.full);
    assert.deepEqual(readFavourites(d.deck.store), twelve());
  });

  test('`at` puts it at that place (Undo); a place past the end puts it last', (t) => {
    const d = testDeck(t);
    for (const one of ['--a', '--b', '--c']) addFavourite(d.deck.store, one);
    assert.equal(addFavourite(d.deck.store, '--x', 1), null);
    assert.deepEqual(readFavourites(d.deck.store), ['--a', '--x', '--b', '--c']);
    assert.equal(addFavourite(d.deck.store, '--y', 0), null);
    assert.equal(addFavourite(d.deck.store, '--z', 11), null);
    assert.deepEqual(readFavourites(d.deck.store), ['--y', '--a', '--x', '--b', '--c', '--z']);
  });

  test('an add with `at` (Undo) passes the same rule: each refusal at a place is refused', (t) => {
    const d = testDeck(t);
    for (const one of ['--a', '--b']) addFavourite(d.deck.store, one);
    const before = d.deck.store.getKv('window_favourites');
    assert.match(addFavourite(d.deck.store, '-c', 0) ?? '', /^cannot pass -c to claude: /);
    assert.equal(addFavourite(d.deck.store, ' "--a" ', 0), FAVOURITE_REFUSALS.known);
    assert.equal(addFavourite(d.deck.store, '', 1), FAVOURITE_REFUSALS.empty);
    assert.equal(addFavourite(d.deck.store, "--x 'y", 1), "the flags have an unclosed '");
    assert.equal(addFavourite(d.deck.store, 'a'.repeat(201), 0), FAVOURITE_REFUSALS.tooLong);
    assert.equal(d.deck.store.getKv('window_favourites'), before);
    for (const one of twelve().slice(2)) addFavourite(d.deck.store, one);
    assert.equal(readFavourites(d.deck.store).length, 12);
    assert.equal(addFavourite(d.deck.store, '--more', 3), FAVOURITE_REFUSALS.full);
  });

  test('removed by its text: true; a text that is no favourite: false, nothing written', (t) => {
    const d = testDeck(t);
    for (const one of ['--a', '--b', '--c']) addFavourite(d.deck.store, one);
    assert.equal(removeFavourite(d.deck.store, '--b'), true);
    assert.deepEqual(readFavourites(d.deck.store), ['--a', '--c']);
    const before = d.deck.store.getKv('window_favourites');
    assert.equal(removeFavourite(d.deck.store, '--b'), false);
    assert.equal(removeFavourite(d.deck.store, ' --a'), false, 'the text exactly, as stored');
    assert.equal(d.deck.store.getKv('window_favourites'), before);
  });

  test('the last one removed: the key is gone, as before the first', (t) => {
    const d = testDeck(t);
    addFavourite(d.deck.store, '--a');
    assert.equal(removeFavourite(d.deck.store, '--a'), true);
    assert.equal(d.deck.store.getKv('window_favourites'), null);
  });

  test('a stored value that is not a JSON array of strings is no favourite; an add starts afresh', (t) => {
    const d = testDeck(t);
    for (const value of ['', 'nope', '{}', '"--a"', '7', 'null', '[1, 2]']) {
      d.deck.store.setKv('window_favourites', value);
      assert.deepEqual(readFavourites(d.deck.store), [], value);
    }
    assert.equal(addFavourite(d.deck.store, '--a'), null);
    assert.deepEqual(readFavourites(d.deck.store), ['--a']);
  });

  test('of a stored list, only the entries the rule takes are read, at most 12', (t) => {
    const d = testDeck(t);
    const stored = [
      '--a',
      '--x\ny',
      '--x\u001b[31m',
      ' --b',
      '',
      7,
      "--x 'y",
      '-c',
      'a'.repeat(201),
      '--a',
      '  --a  ',
      '\ud800',
      ...twelve(),
    ];
    d.deck.store.setKv('window_favourites', JSON.stringify(stored));
    assert.deepEqual(readFavourites(d.deck.store), ['--a', ...twelve().slice(0, 11)]);
  });

  test('a read and its write are one transaction', (t) => {
    const d = testDeck(t);
    let transactions = 0;
    const store = deckWith(d.deck, {
      store: {
        transaction: <T>(fn: () => T): T => {
          transactions++;
          return d.deck.store.transaction(fn);
        },
      },
    }).store;
    addFavourite(store, '--a');
    removeFavourite(store, '--a');
    assert.equal(transactions, 2);
  });
});

// --- the actions --------------------------------------------------------------------------------

function harness(
  d: TestDeck,
  deck = d.deck,
): {
  act(action: ActMessage): Promise<ResultMessage>;
  told: string[];
  logs: string[];
} {
  const told: string[] = [];
  const logs: string[] = [];
  const unused = (): never => {
    throw new Error('not used by the favourites');
  };
  const hub: TerminalHub = {
    list: () => [],
    close: unused,
    attach: unused,
    input: unused,
    resize: unused,
    setTheme: unused,
    onChange: unused,
  };
  const actions = createActions({
    deck,
    hub,
    terminalFor: unused,
    openLink: unused,
    log: (line) => logs.push(line),
    changed: () => told.push(`changed ${JSON.stringify(readFavourites(d.deck.store))}`),
    prs: { fetch: unused, refresh: unused },
  });
  return { act: (action) => actions.act(PAGE, action), told, logs };
}

const add = (text: string, at?: number, id = 5): ActMessage =>
  at === undefined
    ? { t: 'act', id, kind: 'favourite-add', text }
    : { t: 'act', id, kind: 'favourite-add', text, at };
const remove = (text: string, id = 6): ActMessage => ({
  t: 'act',
  id,
  kind: 'favourite-remove',
  text,
});
const ok = (id: number): ResultMessage => ({
  t: 'result',
  id,
  ok: true,
  lines: [],
  error: null,
  sessionId: null,
});
const refused = (id: number, message: string): ResultMessage => ({
  t: 'result',
  id,
  ok: false,
  lines: [message],
  error: message,
  sessionId: null,
});

describe('act favourite-add and favourite-remove', () => {
  test('add: ok, stored, and every list told once, after the write', async (t) => {
    const d = testDeck(t);
    const h = harness(d);
    assert.deepEqual(await h.act(add(' --model opus ')), ok(5));
    assert.deepEqual(readFavourites(d.deck.store), ['--model opus']);
    assert.deepEqual(h.told, ['changed ["--model opus"]']);
  });

  test('remove, then Undo: the favourite back at its old place', async (t) => {
    const d = testDeck(t);
    const h = harness(d);
    for (const one of ['--a', '--b', '--c']) assert.equal((await h.act(add(one))).ok, true);
    assert.deepEqual(await h.act(remove('--b')), ok(6));
    assert.deepEqual(readFavourites(d.deck.store), ['--a', '--c']);
    assert.deepEqual(await h.act(add('--b', 1, 9)), ok(9));
    assert.deepEqual(readFavourites(d.deck.store), ['--a', '--b', '--c']);
    assert.deepEqual(h.told.slice(3), ['changed ["--a","--c"]', 'changed ["--a","--b","--c"]']);
  });

  test('every refusal of the rule is answered with its words; nothing written, no list told', async (t) => {
    const d = testDeck(t);
    const h = harness(d);
    await h.act(add('--model opus'));
    h.told.length = 0;
    const cases: [string, string][] = [
      ['', FAVOURITE_REFUSALS.empty],
      ["--x 'y", "the flags have an unclosed '"],
      ['--x\0', 'the flags contain a NUL character'],
      ['a'.repeat(201), FAVOURITE_REFUSALS.tooLong],
      ['--model  "opus"', FAVOURITE_REFUSALS.known],
      ['--resume x', prepareNewRefusal(d, '--resume x') ?? ''],
      ['-n x', prepareNewRefusal(d, '-n x') ?? ''],
    ];
    for (const [text, words] of cases) {
      assert.deepEqual(await h.act(add(text)), refused(5, words), JSON.stringify(text));
    }
    assert.deepEqual(readFavourites(d.deck.store), ['--model opus']);
    assert.deepEqual(h.told, []);
  });

  test('the limit: the thirteenth is refused; after a removal one more fits', async (t) => {
    const d = testDeck(t);
    const h = harness(d);
    for (const one of twelve()) assert.equal((await h.act(add(one))).ok, true, one);
    assert.deepEqual(await h.act(add('--more')), refused(5, FAVOURITE_REFUSALS.full));
    assert.equal((await h.act(remove('--f0'))).ok, true);
    assert.equal((await h.act(add('--more'))).ok, true);
    assert.deepEqual(readFavourites(d.deck.store), [...twelve().slice(1), '--more']);
  });

  test('remove of a text that is no favourite: ok, nothing written, no list told', async (t) => {
    const d = testDeck(t);
    const h = harness(d);
    assert.deepEqual(await h.act(remove('--nothing')), ok(6));
    assert.equal(d.deck.store.getKv('window_favourites'), null);
    assert.deepEqual(h.told, []);
  });

  test('what was typed reaches no refusal with a control character: it is refused before prepareNew quotes it', async (t) => {
    const d = testDeck(t);
    const h = harness(d);
    // prepareNew's words would quote the cluster as typed: `-c<ESC>[31m (--continue)`.
    const result = await h.act(add('-c\x1b[31m'));
    assert.deepEqual(result, refused(5, FAVOURITE_REFUSALS.control));
    const quoted = await h.act(add('-c<b>x</b>'));
    assert.equal(quoted.error, prepareNewRefusal(d, '-c<b>x</b>'), 'quoted as typed, as Start');
    for (const line of [...result.lines, result.error ?? '', ...quoted.lines]) {
      assert.ok(!/[\u0000-\u001f]/.test(line), JSON.stringify(line));
    }
  });

  test('a busy database: the usual answer, nothing written', async (t) => {
    const d = testDeck(t);
    const deck = deckWith(d.deck, {
      store: {
        transaction: () => {
          throw Object.assign(new Error('database is locked'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 5,
          });
        },
      },
    });
    const h = harness(d, deck);
    assert.deepEqual(await h.act(add('--a')), refused(5, "skydeck's database is busy; try again"));
    assert.deepEqual(
      await h.act(remove('--a')),
      refused(6, "skydeck's database is busy; try again"),
    );
    assert.deepEqual(h.told, []);
  });

  test('a write whose changed() throws still answers ok; one log line by kind', async (t) => {
    const d = testDeck(t);
    const unused = (): never => {
      throw new Error('not used');
    };
    const logs: string[] = [];
    const actions = createActions({
      deck: d.deck,
      hub: {
        list: () => [],
        close: unused,
        attach: unused,
        input: unused,
        resize: unused,
        setTheme: unused,
        onChange: unused,
      },
      terminalFor: unused,
      openLink: unused,
      log: (line) => logs.push(line),
      changed: () => {
        throw new Error('the lists are gone --secret-flag');
      },
      prs: { fetch: unused, refresh: unused },
    });
    assert.deepEqual(await actions.act(PAGE, add('--secret-flag')), ok(5));
    assert.deepEqual(readFavourites(d.deck.store), ['--secret-flag']);
    assert.equal(logs.length, 1, JSON.stringify(logs));
    assert.match(logs[0] ?? '', /^act favourite-add: the lists were not told \(/);
    assert.ok(!(logs[0] ?? '').includes('secret'));
  });
});

describe('the shapes of the two messages (parsePageMessage, checked again by the actions)', () => {
  const parse = (message: Record<string, unknown>) => parsePageMessage(JSON.stringify(message));

  test('the good shapes', () => {
    for (const message of [
      { t: 'act', id: 1, kind: 'favourite-add', text: '--model opus' },
      { t: 'act', id: 1, kind: 'favourite-add', text: '', at: 0 },
      { t: 'act', id: 1, kind: 'favourite-add', text: 'x', at: MAX_FAVOURITES - 1 },
      { t: 'act', id: 1, kind: 'favourite-remove', text: '--model opus' },
      { t: 'act', id: 1, kind: 'favourite-add', text: 'é'.repeat(512) },
    ]) {
      assert.equal(parse(message).ok, true, JSON.stringify(message));
    }
  });

  test('each wrong shape is refused, by the parser and by the actions, and nothing is written', async (t) => {
    const d = testDeck(t);
    const h = harness(d);
    const wrong: Record<string, unknown>[] = [
      { t: 'act', id: 1, kind: 'favourite-add' },
      { t: 'act', id: 1, kind: 'favourite-add', text: 7 },
      { t: 'act', id: 1, kind: 'favourite-add', text: null },
      { t: 'act', id: 1, kind: 'favourite-add', text: ['--a'] },
      { t: 'act', id: 1, kind: 'favourite-add', text: 'a'.repeat(1025) },
      { t: 'act', id: 1, kind: 'favourite-add', text: 'é'.repeat(513) },
      { t: 'act', id: 1, kind: 'favourite-add', text: '\ud800' },
      { t: 'act', id: 1, kind: 'favourite-add', text: '--a', at: -1 },
      { t: 'act', id: 1, kind: 'favourite-add', text: '--a', at: MAX_FAVOURITES },
      { t: 'act', id: 1, kind: 'favourite-add', text: '--a', at: 1.5 },
      { t: 'act', id: 1, kind: 'favourite-add', text: '--a', at: '1' },
      { t: 'act', id: 1, kind: 'favourite-add', text: '--a', at: null },
      { t: 'act', id: 1, kind: 'favourite-add', text: '--a', more: 1 },
      { t: 'act', kind: 'favourite-add', text: '--a' },
      { t: 'act', id: 1, kind: 'favourite-remove' },
      { t: 'act', id: 1, kind: 'favourite-remove', text: 7 },
      { t: 'act', id: 1, kind: 'favourite-remove', text: '--a', at: 0 },
      { t: 'act', id: 1, kind: 'favourite-remove', text: 'a'.repeat(1025) },
      { t: 'act', id: 1, kind: 'favourite-remove', text: '\udc00' },
      { t: 'act', id: 1, kind: 'favourites', text: '--a' },
    ];
    for (const message of wrong) {
      assert.equal(parse(message).ok, false, JSON.stringify(message));
      const result = await h.act(message as unknown as ActMessage);
      assert.deepEqual(
        [result.ok, result.error],
        [false, NOT_AN_ACTION],
        JSON.stringify(message).slice(0, 120),
      );
    }
    assert.equal(d.deck.store.getKv('window_favourites'), null);
    assert.deepEqual(h.told, []);
  });
});
