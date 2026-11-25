// The notes of what is new (src/update/news.ts; S2 16.5): a note's name, its parse for the look
// (sanitised, clipped), the strict check the repository's notes are held to, and code runs.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  clipText,
  NOTE_BYTES,
  NOTE_FILE,
  noteProblem,
  parseNote,
  runsOf,
  TEXT_MAX,
  TITLE_MAX,
} from '../../src/update/news.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("a note's file name", () => {
  test('a date, a name of lower-case letters, digits and hyphens, .md', () => {
    for (const name of ['2026-11-25-update-news.md', '2026-01-02-f44.md', '2026-01-02-a-b-c.md']) {
      assert.ok(NOTE_FILE.test(name), name);
    }
    for (const name of [
      'README.md',
      '2026-11-25-Update.md',
      '2026-11-25-update news.md',
      '2026-11-25-.md',
      '2026-11-25.md',
      '26-11-25-a.md',
      '2026-11-25-a.txt',
      '2026-11-25-a.md.orig',
      'x2026-11-25-a.md',
    ]) {
      assert.ok(!NOTE_FILE.test(name), name);
    }
  });
});

describe('parseNote, for the look', () => {
  test("the owner's example: a title, one paragraph, its line breaks spaces", () => {
    const note = parseNote(
      '# Parked: set a session aside\n\nPress w on a session that waits for someone\nelse. It moves to its own section after Open,\nkeeps running, and comes back by itself when\nyou send it a prompt.\n',
    );
    assert.deepEqual(note, {
      title: 'Parked: set a session aside',
      paragraphs: [
        'Press w on a session that waits for someone else. It moves to its own section after Open, keeps running, and comes back by itself when you send it a prompt.',
      ],
    });
  });

  test('paragraphs split by blank lines (several, or with spaces); CRLF, a BOM and trailing space dropped', () => {
    const note = parseNote('\ufeff# Two  \r\n\r\none\r\ntwo  \r\n\r\n \r\n\r\n  three\r\n\n\n');
    assert.deepEqual(note, { title: 'Two', paragraphs: ['one two', 'three'] });
  });

  test('Markdown other than a code run is text as written', () => {
    const note = parseNote('# **Bold** <b>x</b>\n\n## not a heading\n- not a list\n[a](b)\n');
    assert.deepEqual(note, {
      title: '**Bold** <b>x</b>',
      paragraphs: ['## not a heading - not a list [a](b)'],
    });
  });

  test('not a note: no title line, an empty title, no blank line after it, no text, binary', () => {
    for (const text of [
      '',
      'Title\n\ntext\n',
      '#Title\n\ntext\n',
      '## Title\n\ntext\n',
      '# \n\ntext\n',
      '#   \n\ntext\n',
      '# \u0007\u001b[31m\n\ntext\n',
      '# Title\ntext\n',
      '# Title\n',
      '# Title\n\n\n  \n',
      '# Title\n\ntext\0more\n',
      '# Title\n\ntext \ufffd\n',
    ]) {
      assert.equal(parseNote(text), null, JSON.stringify(text));
    }
  });

  test('the title line must be followed by a blank line, also when a text with a paragraph follows', () => {
    assert.equal(parseNote('# Title\ntext\n\nmore text\n'), null);
    assert.deepEqual(parseNote('# Title\n\ntext\n\nmore text\n'), {
      title: 'Title',
      paragraphs: ['text', 'more text'],
    });
  });

  test('a paragraph that sanitises to nothing is dropped; a title or a whole text that shows nothing is no note', () => {
    assert.deepEqual(parseNote('# Title\n\n\u0007\u001b[31m\u0001\n\nkept\n\n\u200b \u2060\n'), {
      title: 'Title',
      paragraphs: ['kept'],
    });
    assert.equal(parseNote('# \u200b\u200b\n\ntext\n'), null, 'a zero-width title');
    assert.equal(
      parseNote('# \u2060 \u00a0\n\ntext\n'),
      null,
      'a title of a word joiner and a space',
    );
    assert.equal(parseNote('# Title\n\n\u0007\u0008\n\n\u200b\n'), null, 'no text that shows');
    assert.equal(noteProblem(bytes('# \u200b\n\ntext\n')), 'its title is empty');
    assert.equal(noteProblem(bytes('# Title\n\n\u200b\n')), 'its text is empty');
  });

  test('control characters, escape sequences and bidirectional controls are removed', () => {
    const note = parseNote(
      '# A\u001b]8;;http://x\u0007link\u001b]8;;\u0007\n\nred \u001b[31mtext‮\tend\n',
    );
    assert.deepEqual(note, { title: 'Alink', paragraphs: ['red text end'] });
  });

  test('a title over 120 and a text over 600 are clipped with …, a later paragraph dropped', () => {
    const note = parseNote(
      `# ${'t'.repeat(200)}\n\n${'a'.repeat(400)}\n\n${'b'.repeat(400)}\n\nc\n`,
    );
    assert.ok(note !== null);
    assert.equal(note.title, `${'t'.repeat(TITLE_MAX - 1)}…`);
    assert.equal(note.title.length, TITLE_MAX);
    assert.deepEqual(note.paragraphs, ['a'.repeat(400), `${'b'.repeat(199)}…`]);
    assert.equal(note.paragraphs.join('').length, TEXT_MAX);
  });

  test('clipText: a text that ends just at the limit keeps all; one character over ends the last with …', () => {
    assert.deepEqual(clipText(['aaaa', 'bb'], 6), ['aaaa', 'bb']);
    assert.deepEqual(clipText(['aaaa', 'bb', 'c'], 6), ['aaaa', 'b…']);
    assert.deepEqual(clipText(['aaaaa', 'bb'], 6), ['aaaaa…']);
    assert.deepEqual(clipText(['aaaaaa', 'bb'], 6), ['aaaaa…']);
    assert.deepEqual(clipText(['aaaaaaaa'], 6), ['aaaaa…']);
  });

  test('a clip never splits a surrogate pair', () => {
    const note = parseNote(`# x\n\n${'a'.repeat(TEXT_MAX - 2)}😀😀\n`);
    assert.ok(note !== null);
    assert.equal(note.paragraphs[0], `${'a'.repeat(TEXT_MAX - 2)}…`);
  });
});

describe("noteProblem, the repository's check", () => {
  test('a well-formed note: none', () => {
    assert.equal(noteProblem(bytes('# Title with `code`\n\nOne.\n\nTwo.\n')), null);
  });

  test('each problem in its words', () => {
    const cases: [string | Uint8Array, string][] = [
      ['Title\n\ntext\n', 'its first line is not `# <title>`'],
      ['# Title\ntext\n', 'its title line is not followed by a blank line'],
      ['#  \n\ntext\n', 'its title is empty'],
      ['# Title\n\n\n', 'its text is empty'],
      ['# Title\n\ntext\u001b[31m red\n', 'it holds a control character or an escape sequence'],
      ['# Title\n\ntab\there\n', 'it holds a control character or an escape sequence'],
      [`# ${'t'.repeat(TITLE_MAX + 1)}\n\ntext\n`, `its title is 121 characters long, over 120`],
      [
        `# t\n\n${'a'.repeat(300)}\n\n${'b'.repeat(301)}\n`,
        'its text is 601 characters long, over 600',
      ],
      [new Uint8Array([0x23, 0x20, 0x61, 0x0a, 0x0a, 0xff, 0x0a]), 'it is not UTF-8 text'],
      [`# t\n\n${'a'.repeat(NOTE_BYTES)}\n`, `it is larger than ${NOTE_BYTES} bytes`],
    ];
    for (const [text, problem] of cases) {
      assert.equal(noteProblem(typeof text === 'string' ? bytes(text) : text), problem);
    }
  });

  test('a CRLF note is no problem', () => {
    assert.equal(noteProblem(bytes('# Title\r\n\r\nOne.\r\n')), null);
  });
});

describe('runsOf: code runs between two backticks', () => {
  test('text, code, text', () => {
    assert.deepEqual(runsOf('Type `skydeck update` in a terminal.'), [
      { text: 'Type ', code: false },
      { text: 'skydeck update', code: true },
      { text: ' in a terminal.', code: false },
    ]);
  });

  test('code at both ends, two runs side by side', () => {
    assert.deepEqual(runsOf('`a``b` and `c`'), [
      { text: 'a', code: true },
      { text: 'b', code: true },
      { text: ' and ', code: false },
      { text: 'c', code: true },
    ]);
  });

  test('a backtick without a partner and an empty pair are text', () => {
    assert.deepEqual(runsOf('one ` two'), [{ text: 'one ` two', code: false }]);
    assert.deepEqual(runsOf('an `` empty pair'), [{ text: 'an `` empty pair', code: false }]);
    assert.deepEqual(runsOf('`a` then `b'), [
      { text: 'a', code: true },
      { text: ' then `b', code: false },
    ]);
    assert.deepEqual(runsOf(''), []);
  });
});
