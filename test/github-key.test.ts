import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prKey } from '../src/github.ts';

test('prKey lowercases the url, owner and repo', () => {
  assert.deepEqual(prKey('https://github.com/Owner/Repo/pull/12'), {
    url: 'https://github.com/owner/repo/pull/12',
    owner: 'owner',
    repo: 'repo',
    number: 12,
  });
});

test('prKey strips whatever follows the number', () => {
  assert.equal(
    prKey('https://github.com/o/r/pull/12/files#diff-1')?.url,
    'https://github.com/o/r/pull/12',
  );
  assert.equal(prKey('https://github.com/o/r/pull/12?w=1')?.url, 'https://github.com/o/r/pull/12');
  assert.equal(
    prKey('https://github.com/o/r/pull/12#issuecomment-5')?.url,
    'https://github.com/o/r/pull/12',
  );
  assert.equal(prKey('https://github.com/o/r/pull/12/')?.url, 'https://github.com/o/r/pull/12');
});

test('prKey accepts http, www and any host case, and returns https without www', () => {
  assert.equal(
    prKey('http://www.GitHub.com/o/r.js/pull/3')?.url,
    'https://github.com/o/r.js/pull/3',
  );
  assert.equal(prKey('HTTPS://GITHUB.COM/o/r/pull/3')?.url, 'https://github.com/o/r/pull/3');
});

test('prKey returns the number as a number', () => {
  assert.equal(prKey('https://github.com/o/r/pull/2147483647')?.number, 2147483647);
  assert.equal(prKey('https://github.com/o/r/pull/1')?.number, 1);
});

test('prKey accepts the characters GitHub allows in an owner and a repository', () => {
  assert.equal(
    prKey('https://github.com/a-b/c_d.e-f/pull/1')?.url,
    'https://github.com/a-b/c_d.e-f/pull/1',
  );
  assert.equal(
    prKey('https://github.com/9/.github/pull/1')?.url,
    'https://github.com/9/.github/pull/1',
  );
  const owner39 = 'a'.repeat(39);
  assert.equal(prKey(`https://github.com/${owner39}/r/pull/1`)?.owner, owner39);
  const repo100 = 'r'.repeat(100);
  assert.equal(prKey(`https://github.com/o/${repo100}/pull/1`)?.repo, repo100);
});

test('prKey gives null for anything that is not a GitHub pull-request URL', () => {
  const invalid = [
    'https://gitlab.com/o/r/pull/1',
    'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/01',
    'https://github.com/-o/r/pull/1',
    'https://github.com/o/../pull/1',
    'https://github.com/o/r/pull/2147483648',
    'github.com/o/r/pull/1',
    'https://github.com/o/r/pull/12abc',
  ];
  for (const text of invalid) {
    assert.equal(prKey(text), null, text);
  }
});

test('prKey rejects the remaining invalid shapes', () => {
  const invalid = [
    '',
    'not a url',
    'https://github.com/o/r/pull/',
    'https://github.com/o/r/pull',
    'https://github.com/o/r/pull/-1',
    'https://github.com/o/r/pull/1.5',
    'https://github.com/o/r/pull/12.diff',
    'https://github.com/o/r/pull/99999999999999999999',
    'https://github.com/o/./pull/1',
    'https://github.com//r/pull/1',
    'https://github.com/o//pull/1',
    'https://github.com/o/r/extra/pull/1',
    `https://github.com/${'a'.repeat(40)}/r/pull/1`,
    `https://github.com/o/${'r'.repeat(101)}/pull/1`,
    'https://github.com/o_x/r/pull/1',
    'https://github.com/o/r s/pull/1',
    'https://github.com/o/r?x/pull/1',
    'https://github.com/o/r#x/pull/1',
    'https://github.com:443/o/r/pull/1',
    'https://user@github.com/o/r/pull/1',
    'https://github.com.evil.example/o/r/pull/1',
    'https://notgithub.com/o/r/pull/1',
    'https://api.github.com/o/r/pull/1',
    'ftp://github.com/o/r/pull/1',
    ' https://github.com/o/r/pull/1',
    'https://github.com/o/r/PULL/1',
  ];
  for (const text of invalid) {
    assert.equal(prKey(text), null, text);
  }
});
