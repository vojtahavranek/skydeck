// Follow-up F19 (T2, T4; S2 16.4): the two config keys of a ticket's status. `ticketStatus` is a
// list of at most 8 rules `{ "match": "<the start of an address>", "command": ["<program>", …] }`,
// kept in their order; `ticketRefreshMinutes` a whole number from 1 to 1440, 10 unless set. Every
// wrong shape is refused at the start with words that name the file and the key, as every key.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { DEFAULT_CONFIG, loadConfig, parseConfig } from '../../src/platform/config.ts';
import { ConfigError } from '../../src/platform/errors.ts';
import { testPlatform } from '../helpers/platform.ts';

/** Writes `value` as config.json in a fresh sandbox and loads it. */
function load(t: TestContext, value: unknown): { path: string; run: () => unknown } {
  const { platform, sandbox } = testPlatform(t);
  const path = join(sandbox.root, 'config.json');
  platform.files.writeText(path, JSON.stringify(value));
  return { path, run: () => loadConfig(platform.files, path) };
}

/** Asserts that `value` as config.json is refused with exactly `<path>: <words>`. */
function refused(t: TestContext, value: unknown, words: string): void {
  const { path, run } = load(t, value);
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ConfigError, String(error));
    assert.equal(error.message, `${path}: ${words}`, JSON.stringify(value));
    return true;
  });
}

const RULE = {
  match: 'https://tickets.example.com/browse/',
  command: ['/home/u/bin/ticket-status', '{key}'],
};

describe('ticketStatus (F19 T2 b)', () => {
  test('the default is no rule, and ticketRefreshMinutes 10', () => {
    assert.deepEqual(DEFAULT_CONFIG.ticketStatus, []);
    assert.equal(DEFAULT_CONFIG.ticketRefreshMinutes, 10);
    assert.deepEqual(parseConfig('{}', 'x').ticketStatus, []);
  });

  test('rules are kept as written, in their order; a copy, not the defaults', (t) => {
    const second = {
      match: 'http://localhost:8080/t/',
      command: ['python3', '/home/u/s.py', '--url', '{url}', 'key={key}'],
    };
    const config = load(t, { ticketStatus: [RULE, second] }).run() as typeof DEFAULT_CONFIG;
    assert.deepEqual(config.ticketStatus, [RULE, second]);
    assert.deepEqual(DEFAULT_CONFIG.ticketStatus, []);
    assert.deepEqual(parseConfig('{"ticketStatus":[]}', 'x').ticketStatus, []);
  });

  test('eight rules and sixteen words are the most; a match of 2,048 characters is taken', (t) => {
    const match = `https://example.com/${'a'.repeat(2048 - 20)}`;
    assert.equal(match.length, 2048);
    const rules = Array.from({ length: 8 }, (_, i) => ({
      match: `https://example.com/${i}/`,
      command: ['p', ...Array.from({ length: 15 }, (_, j) => `a${j}`)],
    }));
    rules[0] = { match, command: ['p'] };
    const config = load(t, { ticketStatus: rules }).run() as typeof DEFAULT_CONFIG;
    assert.equal(config.ticketStatus.length, 8);
    assert.equal(config.ticketStatus[1]?.command.length, 16);
  });

  const LIST = '"ticketStatus" must be a list of at most 8 rules';
  for (const value of [{}, 'x', null, 3, Array.from({ length: 9 }, () => RULE)]) {
    test(`ticketStatus ${JSON.stringify(value).slice(0, 40)} is refused: ${LIST}`, (t) => {
      refused(t, { ticketStatus: value }, LIST);
    });
  }

  const RULE_SHAPE = '"ticketStatus[1]" must be an object with "match" and "command"';
  for (const value of [null, 'x', [], { match: RULE.match }, { command: RULE.command }]) {
    test(`a rule ${JSON.stringify(value)} is refused: ${RULE_SHAPE}`, (t) => {
      refused(t, { ticketStatus: [RULE, value] }, RULE_SHAPE);
    });
  }

  test('a key a rule does not know is refused by its name', (t) => {
    refused(t, { ticketStatus: [{ ...RULE, shell: true }] }, 'unknown key "ticketStatus[0].shell"');
  });

  const MATCH =
    '"ticketStatus[0].match" must be the start of an http or https address, its scheme and host in lower case and followed by "/", at most 2,048 characters';
  for (const [name, value] of [
    ['no scheme', 'tickets.example.com/browse/'],
    ['not http', 'ftp://tickets.example.com/'],
    ['javascript:', 'javascript:alert(1)//'],
    ['the host not ended by a slash', 'https://tickets.example.com'],
    ['a host that a longer host would start with', 'https://tickets.example'],
    ['an upper-case host', 'https://Tickets.example.com/'],
    ['an upper-case scheme', 'HTTPS://tickets.example.com/'],
    ['a user name', 'https://me@tickets.example.com/'],
    ['a password', 'https://me:secret@tickets.example.com/'],
    ['a space', 'https://tickets.example.com/a b/'],
    ['a control character', 'https://tickets.example.com/\u001b[31m/'],
    ['a non-ASCII character', 'https://tickets.example.com/é/'],
    ['empty', ''],
    ['2,049 characters', `https://example.com/${'a'.repeat(2049 - 20)}`],
    ['a number', 3],
    ['null', null],
  ] as const) {
    test(`a match with ${name} is refused`, (t) => {
      refused(t, { ticketStatus: [{ ...RULE, match: value }] }, MATCH);
    });
  }

  test('a match with a port, a default port left out, a query part', (t) => {
    for (const match of [
      'http://localhost:8080/',
      'https://tickets.example.com/',
      'https://tickets.example.com/browse/ABC-',
      'https://tickets.example.com/t?id=',
    ]) {
      const config = load(t, { ticketStatus: [{ ...RULE, match }] }).run() as typeof DEFAULT_CONFIG;
      assert.equal(config.ticketStatus[0]?.match, match);
    }
    // The address as skydeck stores it leaves out a default port: a rule that writes it would
    // never match, so it is refused.
    refused(t, { ticketStatus: [{ ...RULE, match: 'https://tickets.example.com:443/' }] }, MATCH);
  });

  const COMMAND =
    '"ticketStatus[0].command" must be a list of 1 to 16 non-empty strings without control characters';
  for (const [name, value] of [
    ['an empty list', []],
    ['a string', '/home/u/bin/ticket-status {key}'],
    ['seventeen words', Array.from({ length: 17 }, () => 'a')],
    ['an empty program', ['']],
    ['an empty argument', ['p', '']],
    ['a number', ['p', 3]],
    ['null', null],
    ['a line break', ['p', 'a\nb']],
    ['a tab', ['p', 'a\tb']],
    ['an escape character', ['p\u001b[31m']],
    ['a DEL', ['p', 'a\u007f']],
    ['a C1 control', ['p', 'a\u009b']],
  ] as const) {
    test(`a command with ${name} is refused`, (t) => {
      refused(t, { ticketStatus: [{ ...RULE, command: value }] }, COMMAND);
    });
  }

  test('a command with spaces, quotes and shell characters is taken word for word', (t) => {
    const command = ['/opt/my tools/status', '$(id)', '"; rm -rf ~"', '{url}', "it's"];
    const config = load(t, { ticketStatus: [{ ...RULE, command }] }).run() as typeof DEFAULT_CONFIG;
    assert.deepEqual(config.ticketStatus[0]?.command, command);
  });
});

describe('ticketRefreshMinutes (F19 T4)', () => {
  test('1 and 1440 are taken', (t) => {
    for (const minutes of [1, 10, 1440]) {
      const config = load(t, { ticketRefreshMinutes: minutes }).run() as typeof DEFAULT_CONFIG;
      assert.equal(config.ticketRefreshMinutes, minutes);
    }
  });

  const WORDS = '"ticketRefreshMinutes" must be a whole number from 1 to 1440';
  for (const value of [0, -1, 1441, 1.5, '10', null, true]) {
    test(`${JSON.stringify(value)} is refused: ${WORDS}`, (t) => {
      refused(t, { ticketRefreshMinutes: value }, WORDS);
    });
  }
});
