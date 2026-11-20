// Follow-up F36's words and rules for the settings screen (web/settings-text.js): what the screen
// says of when a change applies, of the default and the file, of a value the running server does
// not use yet, of a shown-only setting; what a field's text becomes in the request (the server
// decides whether it is good); and what a control shows of a value.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SettingApplies, SettingPayload } from '../../src/window/protocol.ts';
import {
  appliesText,
  controlText,
  factsText,
  pendingText,
  savedText,
  SETTINGS_TEXTS,
  shownOnlyText,
  valueToSend,
} from '../../web/settings-text.js';

function setting(more: Partial<SettingPayload> = {}): SettingPayload {
  return {
    key: 'prRefreshMinutes',
    group: 'Pull requests',
    meaning: 'The least time, in minutes, between two automatic reads of a pull request’s status.',
    kind: 'change',
    names: null,
    control: 'number',
    choices: [],
    nullable: false,
    applies: 'now',
    default: 5,
    defaultText: '5',
    inFile: false,
    value: 5,
    valueText: '5',
    pending: false,
    runningText: null,
    ...more,
  };
}

test('when a change applies, in plain words, for each of the four', () => {
  const cases: [SettingApplies, string][] = [
    ['now', 'applies at once'],
    ['restart', 'applies after the window restarts'],
    ['commands', 'used by the commands at their next run; the window does not use it'],
    ['install', 'used only by skydeck install'],
  ];
  for (const [applies, text] of cases) assert.equal(appliesText(applies), text);
});

test('a saved change and one put back say so, and when they apply', () => {
  assert.equal(savedText('now', false), 'Saved: it applies at once.');
  assert.equal(savedText('restart', false), 'Saved: it applies after the window restarts.');
  assert.equal(
    savedText('commands', true),
    'Put back to its default: the commands use it at their next run.',
  );
  assert.equal(savedText('install', false), 'Saved: skydeck install uses it.');
});

test('the default and whether the file sets it', () => {
  assert.equal(factsText(setting({ inFile: true }), true), 'default 5 · set in the file');
  assert.equal(factsText(setting(), true), 'default 5 · not in the file: the default is used');
  assert.equal(factsText(setting({ defaultText: '"here"' }), false), 'default "here"');
});

test('"applies after the window restarts" beside a value the running server does not use, with the one it uses', () => {
  assert.equal(pendingText(setting()), null);
  assert.equal(
    pendingText(setting({ pending: true, runningText: '7' })),
    'applies after the window restarts: the window uses 7 until then',
  );
});

test('a shown-only setting says what it names and that it is changed in the file', () => {
  assert.equal(
    shownOnlyText(setting({ kind: 'show', names: 'program' })),
    'names a program: it is changed in the file only',
  );
  assert.equal(
    shownOnlyText(setting({ kind: 'show', names: 'folder' })),
    'names a folder: it is changed in the file only',
  );
  assert.equal(
    shownOnlyText(setting({ kind: 'show', names: 'port' })),
    "is the window's port: it is changed in the file only",
  );
  assert.equal(shownOnlyText(setting()), null);
  assert.ok(SETTINGS_TEXTS.mend.includes('by hand'));
});

test('a field becomes the request: a number field a number when it reads as one, else its text (the server says why); an empty nullable text null; a choice its value', () => {
  const number = setting();
  assert.equal(valueToSend(number, '9'), 9);
  assert.equal(valueToSend(number, ' 12 '), 12);
  assert.equal(valueToSend(number, '1.5'), 1.5);
  assert.equal(valueToSend(number, 'abc'), 'abc');
  assert.equal(valueToSend(number, ''), '');
  const url = setting({ key: 'ticketUrl', control: 'text', nullable: true, value: null });
  assert.equal(valueToSend(url, ''), null);
  assert.equal(valueToSend(url, ' '), ' ');
  assert.equal(valueToSend(url, 'https://example.com/{key}'), 'https://example.com/{key}');
  const pattern = setting({ key: 'groupPattern', control: 'text', value: '^x' });
  assert.equal(valueToSend(pattern, ''), '');
  const links = setting({ key: 'window.links', control: 'choice', choices: ['default', 'edge'] });
  assert.equal(valueToSend(links, 'edge'), 'edge');
});

test('what a control shows of a value: a number as its digits, null as an empty field, a text as it is', () => {
  assert.equal(controlText(setting({ value: 7 })), '7');
  assert.equal(controlText(setting({ control: 'text', value: null, nullable: true })), '');
  assert.equal(
    controlText(setting({ control: 'text', value: '<b>x</b> \u200f\u05e9\u05dc\u05d5\u05dd' })),
    '<b>x</b> \u200f\u05e9\u05dc\u05d5\u05dd',
  );
});
