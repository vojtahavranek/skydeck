// The settings screen's server side (follow-up F36, issue #164; S2 12.13): the one table of every
// key of config.json (its kind, meaning, default, when a change applies) against `Config`; every
// refusal of what a page may send (a shown-only key, an unknown key, a wrong type, a value
// config.json's own rules refuse, with their messages), each changing nothing; the file re-read
// for every change and written back whole with everything else kept, a key put back to its default
// removed, a file created with the one key, a broken file never written, the copy kept before a
// server's first change, the file's mode, a symbolic link followed and a path that is not a regular
// file refused; and what the running server uses from then on (AT ONCE keys only). On the test
// platform of test/helpers/deck.ts: its sandbox, never a real home.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { DEFAULT_CONFIG, parseConfig } from '../../src/platform/config.ts';
import type { Config } from '../../src/platform/config.ts';
import { ConfigError } from '../../src/platform/errors.ts';
import { BACKUP_SUFFIX, createSettings, SETTINGS } from '../../src/window/settings.ts';
import type { Settings, SettingKey } from '../../src/window/settings.ts';
import type { SettingPayload, SettingsPayload } from '../../src/window/protocol.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';

/** The two lists the owner decided ("plain values only", 2026-11-20). */
const CHANGEABLE = [
  'groupPattern',
  'ticketUrl',
  'prRefreshMinutes',
  'ticketRefreshMinutes',
  'restoreBatch',
  'restoreMinFreeMb',
  'restoreStartTimeoutSeconds',
  'firstRunDoneAfterDays',
  'terminal',
  'wezterm.domain',
  'window.links',
  'window.keepAlive',
];
const SHOWN_ONLY = [
  'claudeCommand',
  'claudeHome',
  'ticketStatus',
  'window.edge',
  'window.profileDir',
  'window.port',
];
/** The keys the running server uses from their next use after a change (G4). */
const AT_ONCE = [
  'groupPattern',
  'ticketUrl',
  'prRefreshMinutes',
  'ticketRefreshMinutes',
  'restoreBatch',
  'restoreMinFreeMb',
  'restoreStartTimeoutSeconds',
  'window.links',
];

/** Every key of a Config as config.json names it: `<key>`, or `<object>.<key>` one level down. */
function keysOf(config: object, prefix = ''): string[] {
  return Object.entries(config).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? keysOf(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

/** The value at `key` (`window.links`) of a configuration or a parsed file. */
function at(object: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)[part]
          : undefined,
      object,
    );
}

interface World {
  d: TestDeck;
  settings: Settings;
  path: string;
  backup: string;
  /** The file's bytes now, or null. */
  text(): string | null;
  /** The file parsed. */
  json(): Record<string, unknown>;
  logs: string[];
}

/** A deck whose config.json holds `text` (a string as it is, an object as JSON; null: no file). */
function world(
  t: Parameters<typeof testDeck>[0],
  file: string | Record<string, unknown> | null = {},
): World {
  const d = testDeck(t);
  const path = d.places.configPath;
  mkdirSync(dirname(path), { recursive: true });
  if (file !== null) writeFileSync(path, typeof file === 'string' ? file : JSON.stringify(file));
  // The deck read the file it was opened with (none): this one is read as the server reads it.
  const deck = { ...d.deck, config: file === null ? d.deck.config : loadOrDefaults(path) };
  const logs: string[] = [];
  const settings = createSettings({ deck, log: (line) => logs.push(line) });
  const text = (): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);
  return {
    d: { ...d, deck },
    settings,
    path,
    backup: `${path}${BACKUP_SUFFIX}`,
    text,
    json: () => JSON.parse(text() ?? 'null') as Record<string, unknown>,
    logs,
  };
}

function loadOrDefaults(path: string): Config {
  try {
    return parseConfig(readFileSync(path, 'utf8'), path);
  } catch (error) {
    if (error instanceof ConfigError) return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
}

function setting(payload: SettingsPayload, key: string): SettingPayload {
  const found = payload.settings.find((one) => one.key === key);
  assert.ok(found !== undefined, `the screen lists ${key}`);
  return found;
}

/** No temporary file of a write is left beside the file. */
function noTemporary(w: World): void {
  const left = readdirSync(dirname(w.path)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(left, []);
}

describe('the table (G1): one row for every key of Config', () => {
  test('every key of DEFAULT_CONFIG has exactly one row, and the table no other', () => {
    const keys = keysOf(DEFAULT_CONFIG);
    assert.deepEqual([...Object.keys(SETTINGS)].sort(), [...keys].sort());
    assert.equal(new Set(keys).size, keys.length);
  });

  test("the changeable keys are exactly the owner's plain values; the rest are shown only", () => {
    const kinds = Object.entries(SETTINGS).map(([key, row]) => [key, row.kind]);
    assert.deepEqual(
      kinds.filter(([, kind]) => kind === 'change').map(([key]) => key),
      Object.keys(SETTINGS).filter((key) => CHANGEABLE.includes(key)),
    );
    assert.deepEqual(
      kinds.filter(([, kind]) => kind === 'show').map(([key]) => key),
      Object.keys(SETTINGS).filter((key) => SHOWN_ONLY.includes(key)),
    );
    assert.equal(CHANGEABLE.length + SHOWN_ONLY.length, Object.keys(SETTINGS).length);
  });

  test('a shown-only row says what it names (a program, a folder, the port); a changeable one names nothing', () => {
    for (const [key, row] of Object.entries(SETTINGS)) {
      if (row.kind === 'show') {
        assert.ok(['program', 'folder', 'port'].includes(String(row.names)), key);
      } else {
        assert.equal(row.names, null, key);
      }
    }
    assert.equal(SETTINGS['window.port'].names, 'port');
    assert.equal(SETTINGS.claudeCommand.names, 'program');
    assert.equal(SETTINGS['window.edge'].names, 'program');
    assert.equal(SETTINGS.ticketStatus.names, 'program');
    assert.equal(SETTINGS.claudeHome.names, 'folder');
    assert.equal(SETTINGS['window.profileDir'].names, 'folder');
  });

  test('every row: a group, its meaning on one plain line, when a change applies; AT ONCE exactly for the keys the running server reads at each use', () => {
    for (const [key, row] of Object.entries(SETTINGS)) {
      assert.ok(row.group.length > 0, key);
      assert.ok(row.meaning.length > 0 && row.meaning.length <= 200, key);
      assert.ok(!/[\n\r]/.test(row.meaning), key);
      assert.ok(['now', 'restart', 'commands', 'install'].includes(row.applies), key);
    }
    assert.deepEqual(
      Object.keys(SETTINGS).filter((key) => SETTINGS[key as SettingKey].applies === 'now'),
      Object.keys(SETTINGS).filter((key) => AT_ONCE.includes(key)),
    );
    assert.equal(SETTINGS['window.keepAlive'].applies, 'restart');
    // Ruled: the pattern stays changeable, and its line says it runs on every title.
    assert.match(SETTINGS.groupPattern.meaning, /regular expression, run on every session’s title/);
    assert.equal(SETTINGS.terminal.applies, 'commands');
    assert.equal(SETTINGS['wezterm.domain'].applies, 'commands');
    assert.equal(SETTINGS.firstRunDoneAfterDays.applies, 'install');
  });

  test("a choice lists exactly the values config.json's rules take; a number control has a number default; a nullable text takes null", () => {
    for (const [key, row] of Object.entries(SETTINGS)) {
      const fileWith = (value: unknown): string => {
        const [head, tail] = key.split('.') as [string, string | undefined];
        return JSON.stringify(
          tail === undefined ? { [head]: value } : { [head]: { [tail]: value } },
        );
      };
      if (row.control === 'choice') {
        assert.ok(row.choices.length >= 2, key);
        for (const choice of row.choices) parseConfig(fileWith(choice), 'config.json');
        assert.throws(() => parseConfig(fileWith('nonsense'), 'config.json'), ConfigError);
      } else {
        assert.deepEqual(row.choices, [], key);
      }
      if (row.control === 'number') assert.equal(typeof at(DEFAULT_CONFIG, key), 'number', key);
      if (row.nullable) parseConfig(fileWith(null), 'config.json');
    }
    assert.deepEqual(SETTINGS.terminal.choices, ['here', 'wezterm', 'window']);
    assert.deepEqual(SETTINGS['window.links'].choices, ['default', 'edge']);
    assert.deepEqual(SETTINGS['window.keepAlive'].choices, ['wsl', 'off']);
    assert.equal(SETTINGS.ticketUrl.nullable, true);
    assert.equal(SETTINGS['wezterm.domain'].nullable, true);
  });
});

describe('what a page may send (G2): every refusal changes nothing', () => {
  /** A refusal: not ok, the words given, and the file, the copy and the running server as before. */
  function refusedWith(w: World, outcome: ReturnType<Settings['set']>, words: RegExp): void {
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.ok(!outcome.ok && words.test(outcome.error), !outcome.ok ? outcome.error : '');
    assert.ok(outcome.payload.settings.length > 0, 'the screen as it is comes with it');
  }

  test('a shown-only key, set or put back: refused with words that say it is changed in the file', (t) => {
    const w = world(t, { claudeCommand: '/usr/bin/claude', window: { port: 47614 } });
    const before = w.text();
    const running = structuredClone(w.d.deck.config);
    for (const key of SHOWN_ONLY) {
      refusedWith(w, w.settings.set(key, '/bin/sh'), /in the file/);
      refusedWith(w, w.settings.reset(key), /in the file/);
    }
    assert.equal(w.text(), before);
    assert.equal(existsSync(w.backup), false);
    assert.deepEqual(w.d.deck.config, running);
  });

  test('a key outside the table — unknown, a whole object, a part of a key, __proto__ — is refused', (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    const before = w.text();
    for (const key of [
      'nonsense',
      'window',
      'wezterm',
      'window.links.x',
      'window.',
      '.links',
      '__proto__',
      'constructor',
      'window.__proto__',
      'PRREFRESHMINUTES',
      '',
    ]) {
      refusedWith(w, w.settings.set(key, 1), /no setting/);
      refusedWith(w, w.settings.reset(key), /no setting/);
    }
    assert.equal(w.text(), before);
    assert.equal(existsSync(w.backup), false);
  });

  test('a value that is no string, number or null (a whole configuration, a list, a boolean) is refused', (t) => {
    const w = world(t);
    const before = w.text();
    for (const value of [{ prRefreshMinutes: 1 }, [1], true, undefined]) {
      refusedWith(w, w.settings.set('prRefreshMinutes', value as never), /cannot be/);
    }
    // JSON would write them as null, which ticketUrl and wezterm.domain take.
    for (const key of ['ticketUrl', 'wezterm.domain', 'prRefreshMinutes']) {
      for (const value of [Infinity, -Infinity, NaN]) {
        refusedWith(w, w.settings.set(key, value), /finite/);
      }
    }
    assert.equal(w.text(), before);
    assert.equal(w.d.deck.config.ticketUrl, null);
  });

  test("a wrong type, a bad pattern, a number out of its range, a ticket link with a user name or a password: config.json's own message, without the path", (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    const before = w.text();
    const running = structuredClone(w.d.deck.config);
    const cases: [string, unknown, string][] = [
      ['prRefreshMinutes', '5', '"prRefreshMinutes" must be a positive integer'],
      ['prRefreshMinutes', 0, '"prRefreshMinutes" must be a positive integer'],
      ['restoreBatch', -1, '"restoreBatch" must be a positive integer'],
      ['restoreMinFreeMb', 1.5, '"restoreMinFreeMb" must be a positive integer'],
      [
        'restoreStartTimeoutSeconds',
        2 ** 53,
        '"restoreStartTimeoutSeconds" must be a positive integer',
      ],
      ['firstRunDoneAfterDays', null, '"firstRunDoneAfterDays" must be a positive integer'],
      [
        'ticketRefreshMinutes',
        1441,
        '"ticketRefreshMinutes" must be a whole number from 1 to 1440',
      ],
      ['ticketRefreshMinutes', 0, '"ticketRefreshMinutes" must be a whole number from 1 to 1440'],
      ['groupPattern', 5, '"groupPattern" must be a string'],
      ['terminal', 'tab', '"terminal" must be "here", "wezterm" or "window"'],
      ['window.links', 'firefox', '"window.links" must be "default" or "edge"'],
      ['window.keepAlive', null, '"window.keepAlive" must be "wsl" or "off"'],
      ['wezterm.domain', '', '"wezterm.domain" must be a non-empty string or null'],
    ];
    for (const [key, value, message] of cases) {
      const outcome = w.settings.set(key, value as never);
      assert.deepEqual(
        [outcome.ok, outcome.ok ? null : outcome.error],
        [false, message],
        `${key} = ${JSON.stringify(value)}`,
      );
    }
    const pattern = w.settings.set('groupPattern', '(');
    assert.ok(
      !pattern.ok &&
        /^"groupPattern" is not a valid regular expression \(.+\)$/.test(pattern.error),
      JSON.stringify(pattern),
    );
    const TICKET =
      '"ticketUrl" must be null or an http or https address with {key} once, after its host';
    for (const link of [
      'https://user:secret@example.com/browse/{key}',
      'https://user@example.com/browse/{key}',
      'https://:secret@example.com/browse/{key}',
      `https://example.com/${'a'.repeat(2048)}{key}`,
      'file:///etc/{key}',
      'https://example.com/browse/',
    ]) {
      const outcome = w.settings.set('ticketUrl', link);
      assert.deepEqual([outcome.ok, outcome.ok ? null : outcome.error], [false, TICKET], link);
    }
    assert.equal(w.text(), before);
    assert.equal(existsSync(w.backup), false);
    assert.deepEqual(w.d.deck.config, running);
  });

  test('every refusal leaves the file, the copy and the running server as they were, also after a change was made', (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    assert.equal(w.settings.set('prRefreshMinutes', 8).ok, true);
    const copy = readFileSync(w.backup, 'utf8');
    const before = w.text();
    const running = structuredClone(w.d.deck.config);
    assert.equal(w.settings.set('prRefreshMinutes', 'x').ok, false);
    assert.equal(w.settings.set('claudeCommand', 'x').ok, false);
    assert.equal(w.settings.reset('nonsense').ok, false);
    assert.equal(w.text(), before);
    assert.equal(readFileSync(w.backup, 'utf8'), copy);
    assert.deepEqual(w.d.deck.config, running);
  });
});

describe('writing the file (G3)', () => {
  test('one key changed in place; every other key, the shown-only ones and the order of the keys stay', (t) => {
    const file = {
      claudeCommand: '/opt/claude/bin/claude',
      prRefreshMinutes: 7,
      ticketStatus: [{ match: 'https://tickets.example.com/', command: ['status', '{key}'] }],
      window: { port: 47614, links: 'default', edge: '/opt/edge' },
      groupPattern: '^[a-z]+-[0-9]+',
    };
    const w = world(t, file);
    assert.equal(w.settings.set('prRefreshMinutes', 9).ok, true);
    assert.deepEqual(w.json(), { ...file, prRefreshMinutes: 9 });
    assert.deepEqual(Object.keys(w.json()), Object.keys(file));
    assert.equal(w.settings.set('window.links', 'edge').ok, true);
    assert.deepEqual(Object.keys(w.json()['window'] as object), ['port', 'links', 'edge']);
    assert.deepEqual(w.json(), {
      ...file,
      prRefreshMinutes: 9,
      window: { port: 47614, links: 'edge', edge: '/opt/edge' },
    });
    // A key the file did not hold comes last; one inside `window` last in `window`.
    assert.equal(w.settings.set('restoreBatch', 2).ok, true);
    assert.equal(w.settings.set('window.keepAlive', 'off').ok, true);
    assert.deepEqual(Object.keys(w.json()), [...Object.keys(file), 'restoreBatch']);
    assert.deepEqual(Object.keys(w.json()['window'] as object), [
      'port',
      'links',
      'edge',
      'keepAlive',
    ]);
    noTemporary(w);
  });

  test('the file keeps its indentation (a tab, four spaces); a file on one line gets two spaces; it ends with a line break', (t) => {
    for (const [indent, written] of [
      ['\t', '{\n\t"prRefreshMinutes": 9\n}\n'],
      ['    ', '{\n    "prRefreshMinutes": 9\n}\n'],
      [null, '{\n  "prRefreshMinutes": 9\n}\n'],
    ] as const) {
      const w = world(
        t,
        indent === null ? '{"prRefreshMinutes":7}' : `{\n${indent}"prRefreshMinutes": 7\n}\n`,
      );
      assert.equal(w.settings.set('prRefreshMinutes', 9).ok, true);
      assert.equal(w.text(), written, JSON.stringify(indent));
    }
  });

  test('back to the default removes the key; a `window` or `wezterm` left empty goes too; a key the file does not hold changes nothing', (t) => {
    const w = world(t, {
      prRefreshMinutes: 7,
      window: { links: 'edge' },
      wezterm: { domain: 'WSL:Ubuntu' },
    });
    assert.equal(w.settings.reset('prRefreshMinutes').ok, true);
    assert.deepEqual(w.json(), { window: { links: 'edge' }, wezterm: { domain: 'WSL:Ubuntu' } });
    assert.equal(w.settings.reset('window.links').ok, true);
    assert.equal(w.settings.reset('wezterm.domain').ok, true);
    assert.deepEqual(w.json(), {});
    const before = w.text();
    assert.equal(w.settings.reset('restoreBatch').ok, true);
    assert.equal(w.text(), before);
  });

  test('no file yet: it is created with that one key, mode 600; back to the default creates none', (t) => {
    const w = world(t, null);
    assert.equal(w.settings.reset('prRefreshMinutes').ok, true);
    assert.equal(w.text(), null);
    assert.equal(w.settings.set('window.links', 'edge').ok, true);
    assert.deepEqual(w.json(), { window: { links: 'edge' } });
    assert.equal(statSync(w.path).mode & 0o777, 0o600);
    assert.equal(existsSync(w.backup), false, 'there was nothing to copy');
    noTemporary(w);
  });

  test("a file that cannot be parsed (not JSON, an unknown key, a wrong value): nothing written, doctor's words on the screen", (t) => {
    for (const broken of [
      '{ "prRefreshMinutes": 7, }',
      '{ "prRefreshMinutes": 7, "futureKey": true }',
      '{ "window": { "links": "firefox" } }',
      '[]',
      // A byte-order mark is kept in the text, so the file is not JSON, as for every command.
      '\ufeff{ "prRefreshMinutes": 7 }',
    ]) {
      const w = world(t, broken);
      let problem: string;
      try {
        parseConfig(broken, w.path);
        assert.fail('it parses');
      } catch (error) {
        assert.ok(error instanceof ConfigError);
        problem = error.message;
      }
      assert.equal(w.settings.payload().problem, problem);
      const outcome = w.settings.set('prRefreshMinutes', 9);
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok && outcome.error.startsWith(problem), !outcome.ok ? outcome.error : '');
      assert.ok(!outcome.ok && /by hand/.test(outcome.error));
      assert.equal(w.settings.reset('prRefreshMinutes').ok, false);
      assert.equal(w.text(), broken);
      assert.equal(existsSync(w.backup), false);
    }
  });

  test('a file that is not UTF-8 text (one Latin-1 byte in a shown-only value) is one to mend by hand: nothing written, no copy', (t) => {
    const w = world(t, { claudeCommand: '/opt/claude' });
    const bytes = Buffer.concat([
      Buffer.from('{ "claudeCommand": "/opt/cl'),
      Buffer.from([0xe9]),
      Buffer.from('ude" }'),
    ]);
    writeFileSync(w.path, bytes);
    const outcome = w.settings.set('prRefreshMinutes', 9);
    assert.ok(!outcome.ok && /is not UTF-8 text; mend the file by hand first/.test(outcome.error));
    assert.ok(/is not UTF-8 text/.test(w.settings.payload().problem ?? ''));
    assert.ok(readFileSync(w.path).equals(bytes), 'the bytes as they were');
    assert.equal(existsSync(w.backup), false);
  });

  test('the copy is the file as it was, byte for byte (UTF-8 beyond ASCII, a line break at the end)', (t) => {
    const text =
      '{\n  "groupPattern": "^[\u00e4\u00f6\u05e9]+-[0-9]+",\n  "claudeCommand": "/opt/\u00e9t\u00e9"\n}\n';
    const w = world(t, text);
    const before = readFileSync(w.path);
    assert.equal(w.settings.set('prRefreshMinutes', 9).ok, true);
    assert.ok(readFileSync(w.backup).equals(before), 'the copy holds the same bytes');
    assert.equal(at(w.json(), 'claudeCommand'), '/opt/\u00e9t\u00e9');
  });

  test('the file is read again for every change: a hand edit between two changes stays', (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    assert.equal(w.settings.set('restoreBatch', 2).ok, true);
    writeFileSync(w.path, JSON.stringify({ ...w.json(), groupPattern: '^X-[0-9]+' }));
    assert.equal(w.settings.set('restoreMinFreeMb', 1024).ok, true);
    assert.deepEqual(w.json(), {
      prRefreshMinutes: 7,
      restoreBatch: 2,
      groupPattern: '^X-[0-9]+',
      restoreMinFreeMb: 1024,
    });
    // Broken by hand in between: the next change is refused, the hand edit kept as it is.
    writeFileSync(w.path, '{ broken');
    assert.equal(w.settings.set('restoreBatch', 3).ok, false);
    assert.equal(w.text(), '{ broken');
  });

  test("the copy: the file as it was before the server's first change, mode 600, kept through its later changes, replaced by the next server's first change", (t) => {
    const first = '{ "prRefreshMinutes": 7 }';
    const w = world(t, first);
    chmodSync(w.path, 0o644);
    assert.equal(w.settings.set('prRefreshMinutes', 8).ok, true);
    assert.equal(readFileSync(w.backup, 'utf8'), first);
    assert.equal(statSync(w.backup).mode & 0o777, 0o600);
    assert.equal(w.settings.set('prRefreshMinutes', 9).ok, true);
    assert.equal(readFileSync(w.backup, 'utf8'), first, 'one copy, of the file before the first');
    // The next server's life: its first change replaces the copy.
    const before = w.text();
    const next = createSettings({ deck: w.d.deck, log: () => {} });
    assert.equal(next.set('prRefreshMinutes', 10).ok, true);
    assert.equal(readFileSync(w.backup, 'utf8'), before);
    // A change that writes nothing (the value it holds) makes no copy.
    const third = createSettings({ deck: w.d.deck, log: () => {} });
    const copy = readFileSync(w.backup, 'utf8');
    assert.equal(third.set('prRefreshMinutes', 10).ok, true);
    assert.equal(readFileSync(w.backup, 'utf8'), copy);
    noTemporary(w);
  });

  test('the copy counts as kept only once it was made and the write worked: a change that found no file makes none, the next one that finds a file does; after a failed write the next change copies the file as it is then', (t) => {
    const w = world(t, null);
    assert.equal(w.settings.set('restoreBatch', 2).ok, true);
    assert.equal(existsSync(w.backup), false, 'no file to copy');
    const created = w.text();
    assert.equal(w.settings.set('restoreBatch', 4).ok, true);
    assert.equal(readFileSync(w.backup, 'utf8'), created, 'the first change that found a file');

    const v = world(t, { prRefreshMinutes: 7 });
    const files = v.d.deck.platform.files;
    let failing = true;
    const settings = createSettings({
      deck: deckWith(v.d.deck, {
        files: {
          rename(from, to) {
            if (failing && to === v.path) {
              throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
            }
            files.rename(from, to);
          },
        },
      }),
      log: () => {},
    });
    assert.equal(settings.set('prRefreshMinutes', 8).ok, false);
    failing = false;
    writeFileSync(v.path, '{ "prRefreshMinutes": 7, "restoreBatch": 2 }');
    assert.equal(settings.set('prRefreshMinutes', 8).ok, true);
    assert.equal(
      readFileSync(v.backup, 'utf8'),
      '{ "prRefreshMinutes": 7, "restoreBatch": 2 }',
      'the file as it was before the write that worked, the hand edit in it',
    );
  });

  test("a file its owner may not write (mode 444), or another user's, is not written over: refused in plain words, nothing written, no copy", (t) => {
    const w = world(t, '{ "prRefreshMinutes": 7 }');
    chmodSync(w.path, 0o444);
    const outcome = w.settings.set('prRefreshMinutes', 8);
    assert.ok(
      !outcome.ok &&
        /is read-only \(mode 444\): the window does not write over it/.test(outcome.error),
      JSON.stringify(outcome),
    );
    assert.equal(w.text(), '{ "prRefreshMinutes": 7 }');
    assert.equal(statSync(w.path).mode & 0o777, 0o444);
    assert.equal(existsSync(w.backup), false);
    assert.equal(w.d.deck.config.prRefreshMinutes, 7);
    chmodSync(w.path, 0o644);
    const files = w.d.deck.platform.files;
    const other = createSettings({
      deck: deckWith(w.d.deck, {
        files: {
          lstat(path) {
            const info = files.lstat(path);
            return path === w.path && info !== null ? { ...info, uid: info.uid + 1 } : info;
          },
        },
      }),
      log: () => {},
    });
    const theirs = other.set('prRefreshMinutes', 8);
    assert.ok(!theirs.ok && /belongs to another user/.test(theirs.error), JSON.stringify(theirs));
    assert.equal(w.text(), '{ "prRefreshMinutes": 7 }');
  });

  test('line ends are kept as the indentation is: a file with CRLF throughout stays CRLF; one with LF, or mixed, is written with LF', (t) => {
    const crlf = world(t, '{\r\n  "prRefreshMinutes": 7\r\n}\r\n');
    assert.equal(crlf.settings.set('prRefreshMinutes', 9).ok, true);
    assert.equal(crlf.text(), '{\r\n  "prRefreshMinutes": 9\r\n}\r\n');
    const mixed = world(t, '{\r\n  "prRefreshMinutes": 7\n}\r\n');
    assert.equal(mixed.settings.set('prRefreshMinutes', 9).ok, true);
    assert.equal(mixed.text(), '{\n  "prRefreshMinutes": 9\n}\n');
  });

  test('the copy cannot be kept (a folder in its place): nothing is changed, and the screen says so', (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    mkdirSync(w.backup);
    const before = w.text();
    const outcome = w.settings.set('prRefreshMinutes', 8);
    assert.ok(!outcome.ok && /copy/.test(outcome.error), JSON.stringify(outcome));
    assert.equal(w.text(), before);
    assert.equal(w.d.deck.config.prRefreshMinutes, 7);
    noTemporary(w);
  });

  test("the file's mode is kept (640 stays 640)", (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    chmodSync(w.path, 0o640);
    assert.equal(w.settings.set('prRefreshMinutes', 8).ok, true);
    assert.equal(statSync(w.path).mode & 0o777, 0o640);
  });

  test('whole or not at all: a write that fails leaves the file as it was and no temporary file', (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    const before = w.text();
    const files = w.d.deck.platform.files;
    let renames = 0;
    const failing = createSettings({
      deck: deckWith(w.d.deck, {
        files: {
          rename(from, to) {
            renames++;
            if (to === w.path) {
              throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
            }
            files.rename(from, to);
          },
        },
      }),
      log: () => {},
    });
    const outcome = failing.set('prRefreshMinutes', 8);
    assert.ok(!outcome.ok && /cannot write/.test(outcome.error), JSON.stringify(outcome));
    assert.ok(renames > 0);
    assert.equal(w.text(), before);
    assert.equal(w.d.deck.config.prRefreshMinutes, 7, 'the running server keeps its value');
    noTemporary(w);
  });

  test("a symbolic link (a dotfiles folder): followed as install's settings file — its file changes, the link stays", (t) => {
    const w = world(t, null);
    const dotfiles = join(w.d.sandbox.root, 'dotfiles');
    mkdirSync(dotfiles);
    const real = join(dotfiles, 'skydeck.json');
    writeFileSync(real, '{ "prRefreshMinutes": 7 }');
    chmodSync(real, 0o640);
    rmSync(w.path, { force: true });
    symlinkSync(real, w.path);
    assert.equal(w.settings.set('prRefreshMinutes', 8).ok, true);
    assert.equal(JSON.parse(readFileSync(real, 'utf8')).prRefreshMinutes, 8);
    assert.equal(statSync(real).mode & 0o777, 0o640);
    assert.equal(readdirSync(dirname(w.path)).includes('config.json'), true);
    assert.equal(
      readFileSync(w.backup, 'utf8'),
      '{ "prRefreshMinutes": 7 }',
      'the copy beside the link',
    );
    assert.deepEqual(
      readdirSync(dotfiles).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  test('a symbolic link to nothing, a folder or a link to a folder at the path: refused and said so; nothing created', (t) => {
    const w = world(t, null);
    const elsewhere = join(w.d.sandbox.root, 'elsewhere');
    rmSync(w.path, { force: true });
    symlinkSync(join(elsewhere, 'missing.json'), w.path);
    let outcome = w.settings.set('prRefreshMinutes', 8);
    assert.ok(!outcome.ok && /symbolic link/.test(outcome.error), JSON.stringify(outcome));
    assert.ok(/symbolic link/.test(w.settings.payload().problem ?? ''));
    assert.equal(existsSync(elsewhere), false);
    unlinkSync(w.path); // the link itself (rmSync leaves a dangling link on Node 24.12)
    mkdirSync(w.path);
    outcome = w.settings.set('prRefreshMinutes', 8);
    assert.ok(!outcome.ok && /not a regular file/.test(outcome.error), JSON.stringify(outcome));
    assert.deepEqual(readdirSync(w.path), []);
    rmSync(w.path, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, w.path);
    outcome = w.settings.set('prRefreshMinutes', 8);
    assert.ok(!outcome.ok && /not a regular file/.test(outcome.error), JSON.stringify(outcome));
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.equal(existsSync(w.backup), false);
  });
});

describe('the screen (payload) and what the running server uses (G4)', () => {
  test('every key in the table’s order, with its default, whether the file sets it, its value, and the path and the copy', (t) => {
    const w = world(t, { prRefreshMinutes: 7, window: { links: 'edge' } });
    const payload = w.settings.payload();
    assert.deepEqual(
      payload.settings.map((one) => one.key),
      Object.keys(SETTINGS),
    );
    assert.equal(payload.path, w.path);
    assert.equal(payload.backup, w.backup);
    assert.equal(payload.exists, true);
    assert.equal(payload.problem, null);
    const pr = setting(payload, 'prRefreshMinutes');
    assert.deepEqual(
      [pr.value, pr.valueText, pr.default, pr.defaultText, pr.inFile, pr.pending, pr.kind],
      [7, '7', 5, '5', true, false, 'change'],
    );
    const links = setting(payload, 'window.links');
    assert.deepEqual(
      [links.value, links.inFile, links.choices],
      ['edge', true, ['default', 'edge']],
    );
    const batch = setting(payload, 'restoreBatch');
    assert.deepEqual([batch.value, batch.inFile], [3, false]);
    const status = setting(payload, 'ticketStatus');
    assert.deepEqual([status.kind, status.names, status.valueText], ['show', 'program', '[]']);
    const url = setting(payload, 'ticketUrl');
    assert.deepEqual([url.value, url.valueText, url.nullable], [null, 'null', true]);
    for (const one of payload.settings) {
      assert.equal(one.meaning, SETTINGS[one.key as SettingKey].meaning);
      assert.deepEqual(one.default, at(DEFAULT_CONFIG, one.key));
    }
  });

  test('every AT ONCE key: the running configuration has the new value at once; back to the default puts the default there', (t) => {
    const w = world(t, {});
    const values: Record<string, unknown> = {
      groupPattern: '^[a-z]+-[0-9]+',
      ticketUrl: 'https://tickets.example.com/browse/{key}',
      prRefreshMinutes: 11,
      ticketRefreshMinutes: 30,
      restoreBatch: 2,
      restoreMinFreeMb: 1024,
      restoreStartTimeoutSeconds: 60,
      'window.links': 'edge',
    };
    assert.deepEqual(Object.keys(values), AT_ONCE);
    for (const [key, value] of Object.entries(values)) {
      assert.equal(w.settings.set(key, value as never).ok, true, key);
      assert.deepEqual(at(w.d.deck.config, key), value, key);
      assert.equal(setting(w.settings.payload(), key).pending, false, key);
    }
    for (const key of AT_ONCE) {
      assert.equal(w.settings.reset(key).ok, true, key);
      assert.deepEqual(at(w.d.deck.config, key), at(DEFAULT_CONFIG, key), key);
    }
  });

  test('a key read at the start (window.keepAlive) is written to the file only: the running server keeps its value, and the screen says it applies after the window restarts', (t) => {
    const w = world(t, {});
    const window = w.d.deck.config.window;
    assert.equal(w.settings.set('window.keepAlive', 'off').ok, true);
    assert.equal(w.json()['window'] !== undefined, true);
    assert.equal(w.d.deck.config.window.keepAlive, 'wsl');
    assert.equal(w.d.deck.config.window, window, 'the object the keep-alive holds is the same');
    const keepAlive = setting(w.settings.payload(), 'window.keepAlive');
    assert.deepEqual(
      [keepAlive.value, keepAlive.pending, keepAlive.runningText],
      ['off', true, '"wsl"'],
    );
  });

  test('a key only the commands or install read: the running configuration is left; never "applies after the window restarts"', (t) => {
    const w = world(t, {});
    for (const [key, value] of [
      ['terminal', 'window'],
      ['wezterm.domain', 'WSL:Ubuntu'],
      ['firstRunDoneAfterDays', 30],
    ] as const) {
      const before = at(w.d.deck.config, key);
      assert.equal(w.settings.set(key, value).ok, true, key);
      assert.deepEqual(at(w.d.deck.config, key), before, key);
      const one = setting(w.settings.payload(), key);
      assert.deepEqual([one.value, one.pending, one.runningText], [value, false, null], key);
    }
  });

  test('a hand edit the running server does not use: "applies after the window restarts" beside it, with the value it uses', (t) => {
    const w = world(t, { prRefreshMinutes: 7, claudeCommand: '/opt/claude' });
    writeFileSync(
      w.path,
      JSON.stringify({ prRefreshMinutes: 12, claudeCommand: '/opt/other', terminal: 'window' }),
    );
    const payload = w.settings.payload();
    const pr = setting(payload, 'prRefreshMinutes');
    assert.deepEqual([pr.value, pr.pending, pr.runningText], [12, true, '7']);
    const command = setting(payload, 'claudeCommand');
    assert.deepEqual([command.value, command.pending], ['/opt/other', true]);
    assert.equal(setting(payload, 'terminal').pending, false, 'the server does not read it');
    // Saved from the screen, the AT ONCE key is the server's at once.
    assert.equal(w.settings.set('prRefreshMinutes', 12).ok, true);
    assert.equal(setting(w.settings.payload(), 'prRefreshMinutes').pending, false);
    assert.equal(w.d.deck.config.prRefreshMinutes, 12);
  });

  test('the file deleted by hand: every value is its default, and a key the server uses otherwise is pending', (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    rmSync(w.path);
    const payload = w.settings.payload();
    assert.equal(payload.exists, false);
    const pr = setting(payload, 'prRefreshMinutes');
    assert.deepEqual([pr.value, pr.inFile, pr.pending], [5, false, true]);
  });

  test('a broken file: the screen shows the running values, nothing pending, and the problem', (t) => {
    const w = world(t, { prRefreshMinutes: 7 });
    writeFileSync(w.path, '{ "prRefreshMinutes": "seven" }');
    const payload = w.settings.payload();
    assert.ok(payload.problem !== null && payload.problem.includes('"prRefreshMinutes"'));
    const pr = setting(payload, 'prRefreshMinutes');
    assert.deepEqual([pr.value, pr.inFile, pr.pending], [7, false, false]);
  });

  test('every text the screen shows is sanitised — the value, the value the server uses, the problem, the path —; a value for a control is sent exactly', (t) => {
    // Neither JSON nor the URL parser escapes these: DEL, a C1 control, the bidirectional controls.
    const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
    const running = '^\u007f[A-Z]+\u0085\u202e-[0-9]+\u2066';
    const w = world(t, { groupPattern: running });
    const pattern = '^\u001b[31m[a-z]\u202e+\u0090-[0-9]+\u2069';
    writeFileSync(w.path, JSON.stringify({ groupPattern: pattern }));
    const one = setting(w.settings.payload(), 'groupPattern');
    assert.equal(one.value, pattern, 'exact, for the field');
    assert.equal(one.pending, true);
    for (const text of [one.valueText, one.runningText ?? '', one.defaultText]) {
      assert.ok(!UNSAFE.test(text), JSON.stringify(text));
    }
    writeFileSync(w.path, JSON.stringify({ 'bad\u202ekey\u0085': 1 }));
    const payload = w.settings.payload();
    assert.ok(
      payload.problem !== null && payload.problem.includes('badkey'),
      payload.problem ?? '',
    );
    assert.ok(!UNSAFE.test(payload.problem), JSON.stringify(payload.problem));
    const refused = w.settings.set('prRefreshMinutes', 9);
    assert.ok(!refused.ok && !UNSAFE.test(refused.payload.problem ?? ''));
  });
});
