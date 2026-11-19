// Follow-up F19 (review 2, ruled): the ticket's KEY that a status command's `{key}` gets —
// ticketKeyOf, never the chip's display name. The configured ticketUrl's key, else `/browse/KEY`,
// else the last part of the path as written when it is a key (letters, digits, `.`, `_`, `-`, first
// a letter or a digit; at most 128 characters, whole); else none.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TICKET_KEY_LENGTH, ticketKeyOf, ticketText } from '../../src/sessions/ticket.ts';

const T = 'https://tickets.example.com';

test("the configured ticketUrl's key, else /browse/KEY, else the last part when it is a key", () => {
  assert.equal(ticketKeyOf(`${T}/t/ABC-9/view`, `${T}/t/{key}/view`), 'ABC-9');
  assert.equal(ticketKeyOf(`${T}/browse/ABC-123`, null), 'ABC-123');
  assert.equal(ticketKeyOf(`${T}/issues/4711`, null), '4711');
  assert.equal(ticketKeyOf('https://github.com/owner/repo/issues/5', null), '5');
  assert.equal(ticketKeyOf(`${T}/t/v1.2_rc-3/`, null), 'v1.2_rc-3');
});

test('an option, an escape, a space or another character is no key: none', () => {
  for (const url of [
    `${T}/browse/--help`,
    `${T}/t/-rf`,
    `${T}/t/%2D%2Dconfig%3D%2Ftmp%2Fx`,
    `${T}/t/a%20b%22c`,
    `${T}/t/_x`,
    `${T}/`,
    `${T}`,
    `${T}/t/ABC-1?x=1#y`.replace('ABC-1', 'a~b'),
  ]) {
    assert.equal(ticketKeyOf(url, null), null, url);
  }
});

test('a long part is whole, never cut as the chip’s name is; past 128 characters none', () => {
  const thirty = 'a-very-long-slug-of-the-ticket';
  assert.equal(thirty.length, 30);
  assert.equal(ticketKeyOf(`${T}/t/${thirty}`, null), thirty);
  assert.equal(ticketText(`${T}/t/${thirty}`, null), 'a-very-long-slug-of-the…', 'the name is cut');
  const uuid = '3f2b9c1e-8d4a-4b6e-9f0c-1a2b3c4d5e6f';
  assert.equal(ticketKeyOf(`${T}/tickets/${uuid}`, null), uuid);
  assert.equal(ticketKeyOf(`${T}/t/${'k'.repeat(TICKET_KEY_LENGTH)}`, null), 'k'.repeat(128));
  assert.equal(ticketKeyOf(`${T}/t/${'k'.repeat(TICKET_KEY_LENGTH + 1)}`, null), null);
});
