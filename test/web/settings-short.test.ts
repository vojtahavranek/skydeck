// Follow-up F39's short settings screen (web/settings-short.js), held against the server's table
// (src/window/settings.ts): its three groups and six controls in order, under plain labels; every
// key it names is a changeable one of the server's table, a choice's words name exactly the values
// the server takes and a switch's two sides the two it takes, so the page decides no rule (S2 4.3);
// the screen's Advanced holds every other key, and its button counts them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SETTINGS } from '../../src/window/settings.ts';
import type { SettingKey } from '../../src/window/settings.ts';
import { SHORT, SHORT_KEYS } from '../../web/settings-short.js';
import { advancedText } from '../../web/settings-text.js';

const isKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);

test('three groups, six controls, in this order, under plain labels', () => {
  assert.deepEqual(
    SHORT.map((group) => [group.title, group.entries.map((entry) => entry.label)]),
    [
      ['Appearance', ['Mode', 'Colour theme']],
      ['Links', ['Open links in', 'Ticket address']],
      ['The window', ['Keep WSL running', 'Typed commands start sessions in']],
    ],
  );
  assert.deepEqual(
    SHORT.flatMap((group) =>
      group.entries.map((entry) => ('key' in entry ? entry.key : entry.local)),
    ),
    ['mode', 'palette', 'window.links', 'ticketUrl', 'window.keepAlive', 'terminal'],
  );
  assert.deepEqual(
    SHORT.map((group) => group.id),
    ['appearance', 'links', 'window'],
  );
});

test('no label is a key name, and a hint is one short line', () => {
  for (const group of SHORT) {
    for (const entry of group.entries) {
      assert.ok(!isKey(entry.label), entry.label);
      assert.ok(!/[.{}]/.test(entry.label), `${entry.label}: plain words`);
      if (entry.hint !== null) {
        assert.ok(entry.hint.length <= 60, `${entry.label}: ${entry.hint.length} characters`);
        assert.doesNotMatch(entry.hint, /\n/);
      }
    }
  }
  // A hint only where the label alone would mislead.
  assert.deepEqual(
    SHORT.flatMap((group) => group.entries.filter((entry) => entry.hint !== null)).map(
      (entry) => entry.label,
    ),
    ['Colour theme', 'Ticket address', 'Typed commands start sessions in'],
  );
});

test('every key is a changeable one of the server’s table, named once, its control the server’s', () => {
  const keys = SHORT.flatMap((group) =>
    group.entries.flatMap((entry) => ('key' in entry ? [entry] : [])),
  );
  assert.equal(new Set(keys.map((entry) => entry.key)).size, keys.length, 'each once');
  assert.deepEqual(
    [...SHORT_KEYS],
    keys.map((entry) => entry.key),
  );
  for (const entry of keys) {
    assert.ok(isKey(entry.key), `${entry.key} is a key of the server's table`);
    const row = SETTINGS[entry.key];
    assert.equal(row.kind, 'change', `${entry.key} is changed in the window`);
    if (entry.control === 'choice') {
      assert.equal(row.control, 'choice', entry.key);
      assert.deepEqual(
        Object.keys(entry.words),
        [...row.choices],
        `${entry.key}: every value, in order`,
      );
      for (const word of Object.values(entry.words)) assert.notEqual(word, '');
    } else if (entry.control === 'switch') {
      assert.equal(row.control, 'choice', entry.key);
      assert.deepEqual(
        [entry.on, entry.off].sort(),
        [...row.choices].sort(),
        `${entry.key}: the two sides are the two values`,
      );
    } else {
      assert.equal(row.control, 'text', entry.key);
    }
  }
  assert.deepEqual(
    keys.map((entry) => [entry.key, entry.control]),
    [
      ['window.links', 'choice'],
      ['ticketUrl', 'text'],
      ['window.keepAlive', 'switch'],
      ['terminal', 'choice'],
    ],
  );
  const keepAlive = keys.find((entry) => entry.key === 'window.keepAlive');
  assert.ok(keepAlive?.control === 'switch');
  assert.deepEqual([keepAlive.on, keepAlive.off], ['wsl', 'off'], 'on keeps WSL running');
});

test('Advanced holds every other key of the server’s table: 14 today, counted on its button', () => {
  const rest = Object.keys(SETTINGS).filter((key) => !SHORT_KEYS.has(key));
  assert.equal(rest.length, 14);
  assert.ok(rest.includes('groupPattern'), 'the group pattern went to Advanced');
  assert.equal(advancedText(14), 'Advanced (14 more settings)');
  assert.equal(advancedText(1), 'Advanced (1 more setting)');
});
