import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { DEFAULT_CONFIG } from '../../src/platform/config.ts';
import { ticketAddress } from '../../src/sessions/ticket.ts';
import { linkToOpen } from '../../src/text/link.ts';
import { linkToOpen as linkToOpenOfWindows } from '../../src/window/windows.ts';

const JIRA = 'https://example.atlassian.net/browse/{key}';
const DEFAULT_PATTERN = DEFAULT_CONFIG.groupPattern;
/** A pattern that takes the group's whole first word: a wide pattern a user might set. */
const WORD = '^\\S+';
/** A pattern that takes the whole group, whatever it holds. */
const ANYTHING = '^[\\s\\S]+';

describe('ticketAddress (S2 12.5): a group that holds a ticket key', () => {
  test('the default pattern on the group of a title "ABC-12 fix" gives the ticket', () => {
    const group = new RegExp(DEFAULT_PATTERN).exec('ABC-12 fix')?.[0] ?? null;
    assert.equal(group, 'ABC-12', 'the group list.ts takes from that title');

    assert.equal(
      ticketAddress(group, DEFAULT_PATTERN, JIRA),
      'https://example.atlassian.net/browse/ABC-12',
    );
  });

  test('a group set by the user: the key alone, and the key with more text after it', () => {
    for (const group of ['ABC-12', 'ABC-12 cleanup']) {
      assert.equal(
        ticketAddress(group, DEFAULT_PATTERN, JIRA),
        'https://example.atlassian.net/browse/ABC-12',
        group,
      );
    }
  });

  test('the address is what linkToOpen gives: the host lowercased, the default port dropped', () => {
    assert.equal(
      ticketAddress('ABC-12', DEFAULT_PATTERN, 'https://Example.net:443/{key}'),
      'https://example.net/ABC-12',
    );
  });

  test('the key goes into a query or a fragment as it does into a path', () => {
    assert.equal(
      ticketAddress('ABC-12', DEFAULT_PATTERN, 'http://host:8080/t?id={key}'),
      'http://host:8080/t?id=ABC-12',
    );
    assert.equal(
      ticketAddress('ABC-12', DEFAULT_PATTERN, 'https://host/#/{key}'),
      'https://host/#/ABC-12',
    );
  });

  test('a key with dots, underscores and a hyphen stays after the host', () => {
    assert.equal(
      ticketAddress('evil.example.com', WORD, JIRA),
      'https://example.atlassian.net/browse/evil.example.com',
    );
    assert.equal(
      ticketAddress('a_b-1.2', WORD, JIRA),
      'https://example.atlassian.net/browse/a_b-1.2',
    );
  });
});

describe('ticketAddress: no link', () => {
  test('a group the pattern matches nothing in', () => {
    assert.equal(ticketAddress('cleanup', DEFAULT_PATTERN, JIRA), null);
  });

  test('no ticketUrl', () => {
    assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, null), null);
  });

  test('no group', () => {
    assert.equal(ticketAddress(null, DEFAULT_PATTERN, JIRA), null);
  });

  test('a pattern that matches the empty string', () => {
    assert.equal(ticketAddress('ABC-12', 'x*', JIRA), null);
  });

  test('a pattern that is not a regular expression', () => {
    assert.equal(ticketAddress('ABC-12', '(', JIRA), null);
  });

  // With a wide pattern the group a program wrote into a title is the key, whole: only a text
  // that cannot add a host, a path, a query, a user name or an escape is one.
  for (const group of [
    'evil.com/x',
    'a?b=1',
    'a#b',
    'u@h',
    'a:b',
    '..',
    '.x',
    '-x',
    '%2e%2e',
    'ÄBC-1',
    'a\\b',
    'a&b',
    'a+b',
    'a~b',
    "a'b",
    '_key_',
  ]) {
    test(`with the pattern ${WORD}, the group ${JSON.stringify(group)} is no key`, () => {
      assert.equal(ticketAddress(group, WORD, JIRA), null);
    });
  }

  test('a key holds only letters, digits, ".", "_" and "-": every other character inside is none', () => {
    const allowed = /[A-Za-z0-9._-]/;
    const others = [...Array(0x7f - 0x20).keys()]
      .map((i) => String.fromCharCode(0x20 + i))
      .filter((c) => !allowed.test(c));
    assert.equal(others.length, 95 - 65, 'every printable ASCII character but the 65 of a key');
    for (const c of [...others, '\u00e4', '\u00a0', '\u2028']) {
      assert.equal(ticketAddress(`a${c}b`, ANYTHING, JIRA), null, JSON.stringify(c));
    }
    assert.equal(
      ticketAddress('a._-b', ANYTHING, JIRA),
      'https://example.atlassian.net/browse/a._-b',
    );
  });

  test('an address that would be over 2,048 characters; one of exactly 2,048 is given', () => {
    const base = 'https://example.net/';
    const key = 'K';
    const url = `${base}${'a'.repeat(2048 - base.length - key.length)}{key}`;
    const at = ticketAddress(key, WORD, url);
    assert.equal(at?.length, 2048);
    assert.equal(ticketAddress(`${key}K`, WORD, url), null);
  });

  test('a group taken from the title that a look-ahead of the pattern no longer matches alone', () => {
    const pattern = '^[A-Z]+-[0-9]+(?= )';
    const group = new RegExp(pattern).exec('ABC-12 fix')?.[0] ?? null;
    assert.equal(group, 'ABC-12');

    assert.equal(ticketAddress(group, pattern, JIRA), null);
  });

  for (const url of ['javascript:{key}', 'file:///{key}', 'ftp://host/{key}']) {
    test(`a ticketUrl that linkToOpen refuses: ${url}`, () => {
      assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, url), null);
    });
  }

  test('a ticketUrl without {key}, or with it twice', () => {
    assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, 'https://host/browse/'), null);
    assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, 'https://host/{key}/{key}'), null);
  });
});

// The configuration refuses each of these (S2 16.4); ticketAddress refuses them again on its own,
// so that a key can choose no host and no login whatever ticketUrl it is given. The keys are
// those a title could give under a wide pattern: upper and lower case, dotted, a digit, a hex
// digit, an underscore, the configuration's own sample keys, and the short ones a stand-in could
// be mistaken for.
const KEYS = [
  'KEY-1',
  'OTHER-2',
  'abc-12',
  'evil.com',
  'x',
  'a',
  'e',
  's',
  '1',
  '0',
  '8443',
  'a_b',
];
describe('ticketAddress: a ticketUrl that puts the key before its path gives no link', () => {
  for (const url of [
    'https:///{key}/x',
    'https:////{key}',
    'https:/{key}/x',
    'https:{key}',
    'https:///{key}@h/x',
    'https://{key}.example.net/',
    'https://user@{key}/',
    'https://host{key}/',
    'https://{key}@host/x',
    'https://u:{key}@host/x',
    'https://{key}/',
    'https://host:{key}/x',
    'https://[::{key}]/x',
    'http{key}://host/x',
  ]) {
    test(url, () => {
      assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, url), null);
      for (const key of KEYS) {
        assert.equal(ticketAddress(key, WORD, url), null, key);
      }
    });
  }

  test('a ticketUrl with a user name or a password of its own', () => {
    for (const url of [
      'https://user@host/{key}',
      'https://user:secret@host/{key}',
      'https://:secret@host/{key}',
    ]) {
      assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, url), null, url);
    }
  });
});

// S2 12.5 and 16.4: a key may not finish a percent-escape that the pattern began, so a pattern
// whose text right before `{key}` ends in `%`, or in `%` and one hex digit, gives no link.
describe('ticketAddress: an escape left unfinished right before {key} gives no link', () => {
  test('a title "e. retry the upload" that would finish %2 into a dot segment', () => {
    const group = new RegExp(WORD).exec('e. retry the upload')?.[0] ?? null;
    assert.equal(group, 'e.');
    const url = 'https://tickets.example.net/team/browse/%2{key}';
    assert.equal(linkToOpen(url.replace('{key}', 'e.')), 'https://tickets.example.net/team/');

    assert.equal(ticketAddress(group, WORD, url), null);
  });

  for (const [url, keys] of [
    ['https://host/b/%2{key}', ['e', 'E', 'e.', 'FOO-1']],
    ['https://host/b/%{key}', ['2e', '2E', '2e.', '41']],
    ['https://host/b/.%2{key}', ['e']],
    ['https://host/b/.%{key}', ['2e']],
    ['https://host/b/%2e%{key}', ['2e']],
    ['https://host/t?id=%2{key}', ['6x']],
    ['https://host/#%2{key}', ['3x']],
    ['https://host/b/%a{key}', ['b']],
    ['https://host/b/%A{key}', ['B']],
  ] as const) {
    test(url, () => {
      for (const key of [...keys, 'ABC-12']) {
        assert.equal(ticketAddress(key, WORD, url), null, key);
      }
    });
  }

  test('a whole escape right before {key} is a link', () => {
    for (const [url, address] of [
      ['https://host/issues/?jql=key%3D{key}', 'https://host/issues/?jql=key%3DABC-12'],
      ['https://host/b/%25{key}', 'https://host/b/%25ABC-12'],
      ['https://host/b/%7E{key}', 'https://host/b/%7EABC-12'],
    ] as const) {
      assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, url), address, url);
    }
    assert.equal(ticketAddress('2e', WORD, 'https://host/b/%25{key}'), 'https://host/b/%252e');
  });

  test('a key "." or ".." in a path', () => {
    for (const key of ['.', '..']) {
      assert.equal(ticketAddress(key, ANYTHING, 'https://host/b/{key}/x'), null, key);
    }
  });

  test('an ordinary key in a path, a query and a fragment is a link', () => {
    for (const [url, address] of [
      ['https://host/b/{key}/x', 'https://host/b/ABC-12/x'],
      ['https://host/b?k={key}&x=1', 'https://host/b?k=ABC-12&x=1'],
      ['https://host/#/b/{key}', 'https://host/#/b/ABC-12'],
      [
        'https://jira.example.net/browse/{key}?src=my_key_tool',
        'https://jira.example.net/browse/ABC-12?src=my_key_tool',
      ],
    ] as const) {
      assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, url), address, url);
    }
  });
});

// The parser removes tabs and line breaks before it reads, so the rule on the text before `{key}`
// would not see what they hide; the configuration refuses such a pattern, and so does this.
describe('ticketAddress: a ticketUrl that holds white space or a control character gives no link', () => {
  test('a tab or a line break inside an unfinished escape', () => {
    assert.equal(ticketAddress('e.', WORD, 'https://host/a/b/%2\t{key}'), null);
    assert.equal(ticketAddress('2e.', WORD, 'https://host/a/b/%\n{key}'), null);
    assert.equal(ticketAddress('6x', WORD, 'https://host/t?id=%2\t{key}'), null);
  });

  for (const [name, url] of [
    ['a space', 'https://host/a b/{key}'],
    ['a leading space', ' https://host/{key}'],
    ['a trailing line break', 'https://host/{key}\n'],
    ['an escape character', 'https://host/\x1b/{key}'],
    ['a DEL', 'https://host/\x7f/{key}'],
    ['a C1 control', 'https://host/\u009b/{key}'],
    ['a no-break space', 'https://host/a\u00a0b/{key}'],
    ['a tab in the host', 'https://ho\tst/{key}'],
  ] as const) {
    test(name, () => {
      assert.equal(ticketAddress('ABC-12', DEFAULT_PATTERN, url), null);
    });
  }
});

describe('the modules of the ticket link (D18, design 11)', () => {
  test('linkToOpen of src/text/link.ts is the one src/window/windows.ts gives', () => {
    assert.equal(linkToOpenOfWindows, linkToOpen);
  });

  test('src/text/link.ts imports nothing; src/sessions/ticket.ts imports only from src/text/', () => {
    const src = join(import.meta.dirname, '../../src');
    const importsOf = (path: string) =>
      [
        ...readFileSync(join(src, path), 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms),
      ].map((match) => match[1]);

    assert.deepEqual(importsOf('text/link.ts'), []);
    assert.deepEqual(importsOf('sessions/ticket.ts'), ['../text/link.ts']);
  });
});
