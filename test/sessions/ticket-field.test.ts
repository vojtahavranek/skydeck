// Follow-up F18: the ticket a user sets on a session (S2 12.5, design 7.1). K1: what text sets it,
// and the words of each refusal; K2: the chip's short name worked out from the address.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { UsageError } from '../../src/platform/errors.ts';
import { requireTicket } from '../../src/sessions/meta.ts';
import {
  TICKET_REFUSALS,
  TICKET_TEXT_LENGTH,
  readTicket,
  ticketText,
} from '../../src/sessions/ticket.ts';

const TICKET_URL = 'https://example.com/browse/{key}';

/** The refusal of `text`, or a failure when it is accepted. */
function refusal(text: string, ticketUrl: string | null = TICKET_URL): string {
  const read = readTicket(text, ticketUrl);
  assert.equal(read.ok, false, `accepted: ${JSON.stringify(text)}`);
  return read.ok ? '' : read.error;
}

/** The address `text` sets, or a failure when it is refused. */
function address(text: string, ticketUrl: string | null = TICKET_URL): string | null {
  const read = readTicket(text, ticketUrl);
  assert.equal(read.ok, true, read.ok ? '' : read.error);
  return read.ok ? read.address : null;
}

describe('readTicket (K1): a whole link', () => {
  test('an https link is taken as linkToOpen gives it back, with or without ticketUrl', () => {
    for (const ticketUrl of [TICKET_URL, null]) {
      assert.equal(
        address('https://example.com/tickets/42', ticketUrl),
        'https://example.com/tickets/42',
      );
      assert.equal(
        address('https://github.com/owner/repo/issues/5', ticketUrl),
        'https://github.com/owner/repo/issues/5',
      );
    }
  });

  test('an http link; the host lower-cased and the default port dropped, as the window opens it', () => {
    assert.equal(address('http://Example.COM:80/a?b=c#d', null), 'http://example.com/a?b=c#d');
  });

  test('white space at either end is no part of it', () => {
    assert.equal(address('  https://example.com/x  ', null), 'https://example.com/x');
  });

  test('a link of exactly 2,048 characters is taken; one of 2,049 is refused with its words', () => {
    const start = 'https://example.com/';
    const exact = start + 'a'.repeat(2048 - start.length);
    assert.equal(exact.length, 2048);
    assert.equal(address(exact, null), exact);
    assert.equal(refusal(`${exact}a`, null), TICKET_REFUSALS.tooLong);
    assert.equal(TICKET_REFUSALS.tooLong, 'a ticket link is at most 2,048 characters');
  });

  test('a link that is not http or https: javascript:, file:, mailto:, data:', () => {
    for (const text of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'file:///etc/passwd',
      'mailto:someone@example.com',
      'data:text/html,<b>x</b>',
    ]) {
      assert.equal(refusal(text), TICKET_REFUSALS.notHttp, text);
    }
    assert.equal(TICKET_REFUSALS.notHttp, 'a ticket link must start with http:// or https://');
  });

  test('an http link the window does not open: a quote or a backslash in what is opened', () => {
    for (const text of ['https://exa"mple.com/x', 'https://example.com/a?b=\\c']) {
      assert.equal(refusal(text, null), TICKET_REFUSALS.notOpenable, text);
    }
    assert.equal(
      TICKET_REFUSALS.notOpenable,
      'the window does not open this link: it must hold no " or \\ and be at most 2,048 characters once encoded',
    );
  });

  test('a link that is 2,048 characters as typed but longer once encoded', () => {
    const start = 'https://example.com/';
    const text = start + 'é'.repeat(2048 - start.length);
    assert.equal(text.length, 2048);
    assert.equal(refusal(text, null), TICKET_REFUSALS.notOpenable);
  });

  test('a link with a user name or a password', () => {
    for (const text of ['https://someone@example.com/x', 'https://someone:secret@example.com/x']) {
      assert.equal(refusal(text, null), TICKET_REFUSALS.credentials, text);
    }
    assert.equal(
      TICKET_REFUSALS.credentials,
      'a ticket link cannot hold a user name or a password',
    );
  });
});

describe('readTicket (K1): a bare key', () => {
  test('with ticketUrl: the address is ticketUrl with the key filled in', () => {
    assert.equal(address('ABC-123'), 'https://example.com/browse/ABC-123');
    assert.equal(address(' ABC-123 '), 'https://example.com/browse/ABC-123');
    assert.equal(
      address('abc_1.2', 'https://example.com/t?id={key}'),
      'https://example.com/t?id=abc_1.2',
    );
  });

  test('a key never gives an address with a user name or a password: a ticketUrl holding one (the configuration refuses it) makes no link', () => {
    for (const ticketUrl of [
      'https://someone@example.com/browse/{key}',
      'https://someone:secret@example.com/browse/{key}',
    ]) {
      assert.equal(refusal('ABC-123', ticketUrl), TICKET_REFUSALS.keyMakesNoLink, ticketUrl);
    }
  });

  test('without ticketUrl: refused with words that say what to do', () => {
    assert.equal(refusal('ABC-123', null), TICKET_REFUSALS.keyWithoutTicketUrl);
    assert.equal(
      TICKET_REFUSALS.keyWithoutTicketUrl,
      'a ticket key needs ticketUrl in config.json: set ticketUrl, or give the whole link',
    );
  });

  test('a key ticketUrl makes no link from (a dot segment after an unfinished escape)', () => {
    // A ticketUrl the configuration would refuse; the rule holds by itself (ticketAddress's).
    assert.equal(refusal('ABC-123', 'https://example.com/%{key}'), TICKET_REFUSALS.keyMakesNoLink);
    assert.equal(
      TICKET_REFUSALS.keyMakesNoLink,
      'ticketUrl makes no link the window may open from this key; give the whole link',
    );
  });

  test('a text that breaks the key rule and is no link either', () => {
    for (const text of [
      'ABC 123',
      '-ABC-1',
      '_x',
      'ABC/123',
      'ABC%20',
      'ABČ-1',
      'example.com/browse/ABC-1',
    ]) {
      assert.equal(refusal(text), TICKET_REFUSALS.notATicket, text);
      assert.equal(refusal(text, null), TICKET_REFUSALS.notATicket, text);
    }
    assert.equal(
      TICKET_REFUSALS.notATicket,
      'not a ticket: give an http or https link, or a key like ABC-123',
    );
  });
});

describe('readTicket (K1): empty text and control characters', () => {
  test('empty text, or only white space, removes the ticket', () => {
    for (const text of ['', '   ', '\t ']) {
      assert.equal(address(text), null, JSON.stringify(text));
      assert.equal(address(text, null), null, JSON.stringify(text));
    }
  });

  test('a line break inside', () => {
    for (const text of ['https://example.com/a\nb', 'ABC-1\r\nx', 'https://example.com/a\u2028b']) {
      assert.equal(refusal(text), TICKET_REFUSALS.lineBreak, JSON.stringify(text));
    }
    assert.equal(TICKET_REFUSALS.lineBreak, 'a ticket must be one line');
  });

  test('a control character, an escape sequence or a bidirectional control inside', () => {
    for (const text of [
      'https://example.com/a\u0000b',
      'https://example.com/a\tb',
      'https://example.com/\u001b[31mred',
      'https://example.com/a\u007fb',
      'https://example.com/a\u009bb',
      'https://example.com/\u202eab',
      'ABC-1\u0007',
    ]) {
      assert.equal(refusal(text), TICKET_REFUSALS.control, JSON.stringify(text));
    }
    assert.equal(TICKET_REFUSALS.control, 'a ticket cannot contain control characters');
  });

  test('no refusal repeats the text it was given', () => {
    const texts = ['javascript:SECRET', 'https://SECRET@example.com/', 'SECRET OTHER', 'SECRET'];
    for (const text of texts) {
      const error = refusal(text, null);
      assert.ok(!error.includes('SECRET'), error);
    }
  });
});

describe('requireTicket: the commands and the window take K1 through it', () => {
  test('the address, or null for empty text', () => {
    assert.equal(requireTicket('ABC-123', TICKET_URL), 'https://example.com/browse/ABC-123');
    assert.equal(requireTicket('', TICKET_URL), null);
  });

  test('a refusal is a UsageError with its words', () => {
    assert.throws(
      () => requireTicket('ABC-123', null),
      (error) =>
        error instanceof UsageError && error.message === TICKET_REFUSALS.keyWithoutTicketUrl,
    );
  });
});

describe("ticketText (K2): the chip's short name", () => {
  test('the key, when the address fits the configured ticketUrl', () => {
    assert.equal(ticketText('https://example.com/browse/ABC-123', TICKET_URL), 'ABC-123');
    const query = 'https://example.com/t?id={key}&x=1';
    assert.equal(ticketText('https://example.com/t?id=ABC-9&x=1', query), 'ABC-9');
    // The parser's form of ticketUrl: its host lower-cased, its default port dropped.
    assert.equal(
      ticketText('https://example.com/issue/ABC-1', 'https://EXAMPLE.com:443/issue/{key}'),
      'ABC-1',
    );
  });

  test('ticketUrl is tried first: a GitHub issue that fits it is named by its key', () => {
    assert.equal(
      ticketText(
        'https://github.com/owner/repo/issues/5',
        'https://github.com/owner/repo/issues/{key}',
      ),
      '5',
    );
  });

  test('an address that does not fit ticketUrl falls through to the other rules', () => {
    // Around the place of the key, but what stands there is no key.
    assert.equal(
      ticketText('https://example.com/browse/ABC%201', 'https://example.com/browse/{key}'),
      'ABC 1',
    );
    // Another host.
    assert.equal(ticketText('https://other.example.com/x/y', TICKET_URL), 'y');
  });

  test('KEY for a path /browse/KEY, without ticketUrl or with another one', () => {
    for (const ticketUrl of [null, 'https://other.example.com/{key}']) {
      assert.equal(ticketText('https://example.com/browse/ABC-123', ticketUrl), 'ABC-123');
      assert.equal(
        ticketText('https://example.com/browse/ABC-123?focus=1#c', ticketUrl),
        'ABC-123',
      );
    }
  });

  test('repo #n for a GitHub issue or pull request', () => {
    assert.equal(ticketText('https://github.com/owner/repo/issues/5', null), 'repo #5');
    assert.equal(ticketText('https://github.com/owner/repo/pull/77', null), 'repo #77');
    assert.equal(ticketText('https://github.com/owner/repo/pull/77/files', null), 'repo #77');
    assert.equal(
      ticketText('https://github.com/owner/repo/issues/5#issuecomment-1', null),
      'repo #5',
    );
    // Not an issue's number: the last part of the path.
    assert.equal(ticketText('https://github.com/owner/repo/issues/new', null), 'new');
    assert.equal(ticketText('https://github.com/owner/repo/issues/05', null), '05');
    // Another host is no GitHub issue.
    assert.equal(ticketText('https://example.com/owner/repo/issues/5', null), '5');
  });

  test('else the last part of the path that is not empty, decoded', () => {
    assert.equal(ticketText('https://example.com/tickets/42', null), '42');
    assert.equal(ticketText('https://example.com/tickets/42/', null), '42');
    assert.equal(ticketText('https://example.com/a//', null), 'a');
    assert.equal(ticketText('https://example.com/t/fix%20the%20upload', null), 'fix the upload');
    assert.equal(ticketText('https://example.com/t/%C4%8Desk%C3%BD', null), 'český');
  });

  test('a part that does not decode is shown as it is', () => {
    assert.equal(ticketText('https://example.com/t/a%E0%A4%A', null), 'a%E0%A4%A');
  });

  test(`at most ${TICKET_TEXT_LENGTH} characters, the cut one ending in …`, () => {
    assert.equal(TICKET_TEXT_LENGTH, 24);
    const exact = 'a'.repeat(24);
    assert.equal(ticketText(`https://example.com/${exact}`, null), exact);
    const cut = ticketText(`https://example.com/${'b'.repeat(25)}`, null);
    assert.equal(cut, `${'b'.repeat(23)}…`);
    assert.equal([...cut].length, 24);
    // Counted in characters, not UTF-16 units: no surrogate pair is cut in two.
    const wide = ticketText(`https://example.com/${encodeURIComponent('😀'.repeat(30))}`, null);
    assert.equal(wide, `${'😀'.repeat(23)}…`);
  });

  test('else the host, with its port', () => {
    assert.equal(ticketText('https://example.com/', null), 'example.com');
    assert.equal(ticketText('https://example.com', null), 'example.com');
    assert.equal(ticketText('http://example.com:8080/?q=1', null), 'example.com:8080');
  });

  test('only ever text: a decoded control character, escape or bidirectional control is taken out', () => {
    assert.equal(ticketText('https://example.com/t/a%1B%5B31mred', null), 'ared');
    assert.equal(ticketText('https://example.com/t/a%0Ab', null), 'a b');
    assert.equal(ticketText('https://example.com/t/%E2%80%AEab', null), 'ab');
    // A part with nothing left once decoded counts as empty: the part before it, else the host.
    assert.equal(ticketText('https://example.com/t/%07', null), 't');
    assert.equal(ticketText('https://example.com/t/%20%20', null), 't');
    assert.equal(ticketText('https://example.com/%07/%20', null), 'example.com');
  });

  test('a markup-looking part stays text (the page puts it into textContent)', () => {
    assert.equal(ticketText('https://example.com/t/%3Cb%3Ex%3C%2Fb%3E', null), '<b>x</b>');
  });
});
