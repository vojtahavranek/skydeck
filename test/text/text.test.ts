import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { formatAge } from '../../src/text/age.ts';
import { sanitize } from '../../src/text/sanitize.ts';
import { printableCommand, shellJoin, shellQuote } from '../../src/text/shell.ts';
import { S1, SEC } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';

describe('sanitize', () => {
  const cases: ReadonlyArray<readonly [name: string, input: string, output: string]> = [
    ['plain text is unchanged', 'plain title', 'plain title'],
    ['removes a CSI colour sequence', 'a\x1b[31mred\x1b[0m b', 'ared b'],
    ['removes an OSC terminated by BEL', 'x\x1b]0;evil title\x07y', 'xy'],
    [
      'removes OSC hyperlinks terminated by ESC backslash',
      'x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\y',
      'xlinky',
    ],
    ['removes a DCS up to ESC backslash', '\x1bPdcs data\x1b\\after', 'after'],
    ['removes a C1 CSI (U+009B)', '\u009b31mC1', 'C1'],
    ['removes ESC and the one character after it', '\x1b(Bx', 'Bx'],
    [
      'removes an unterminated OSC to the end of the string',
      'unterminated \x1b]0;rest',
      'unterminated ',
    ],
    ['removes an ESC at the end of the string', 'esc at end \x1b', 'esc at end '],
    ['turns TAB, LF and CR into one space each', 'tab\there\nnew\rline', 'tab here new line'],
    ['removes the other C0 controls and DEL', 'bell\x07 nul\x00 del\x7f', 'bell nul del'],
    ['removes bidirectional controls', 'abc\u202Eevil\u2066x', 'abcevilx'],
    ['leaves non-ASCII text alone', 'ünïcödé ✳ 日本', 'ünïcödé ✳ 日本'],
  ];
  for (const [name, input, output] of cases) {
    test(name, () => {
      assert.equal(sanitize(input), output);
    });
  }

  test('does not trim and does not collapse spaces', () => {
    assert.equal(sanitize('  a   b  '), '  a   b  ');
    assert.equal(sanitize('\n a \n'), '  a  ');
  });

  test('removes the C1 string introducers (DCS, SOS, PM, APC) up to their terminator', () => {
    assert.equal(sanitize('a\u0090data\u009cb'), 'ab');
    assert.equal(sanitize('a\u0098data\u009cb'), 'ab');
    assert.equal(sanitize('a\u009edata\u009cb'), 'ab');
    assert.equal(sanitize('a\u009fdata\u009cb'), 'ab');
    assert.equal(sanitize('a\u009ddata\u009cb'), 'ab');
  });

  test('removes ESC X, ESC ^ and ESC _ strings up to ESC backslash', () => {
    assert.equal(sanitize('a\x1bXdata\x1b\\b'), 'ab');
    assert.equal(sanitize('a\x1b^data\x1b\\b'), 'ab');
    assert.equal(sanitize('a\x1b_data\x1b\\b'), 'ab');
  });

  test('a CSI with intermediate bytes ends at its final byte', () => {
    assert.equal(sanitize('a\x1b[?25;1 qb'), 'ab');
  });

  test('a CSI without a final byte is not a CSI: only ESC and the next character go', () => {
    assert.equal(sanitize('a\x1b[31'), 'a31');
    assert.equal(sanitize('a\x1b[31\nb'), 'a31 b');
  });

  test('removes the remaining C1 controls', () => {
    assert.equal(sanitize('a\u0080b\u0085c\u0091d\u009ae'), 'abcde');
  });

  test('the empty string stays empty', () => {
    assert.equal(sanitize(''), '');
  });

  test('a lone ESC before a newline takes the newline with it', () => {
    // "any other ESC plus the one character after it" happens before the newline becomes a space.
    assert.equal(sanitize('a\x1b\nb'), 'ab');
  });
});

describe('shellQuote and shellJoin', () => {
  const cases: ReadonlyArray<readonly [word: string, quoted: string]> = [
    ['claude', 'claude'],
    ['--model', '--model'],
    ['/home/u/p-1/x.json', '/home/u/p-1/x.json'],
    ['a=b,c:d@e%f+g', 'a=b,c:d@e%f+g'],
    ['-n', '-n'],
    ['', "''"],
    ['my label', "'my label'"],
    ["it's", "'it'\\''s'"],
    ['$HOME', "'$HOME'"],
    ['a*b', "'a*b'"],
    ['ü', "'ü'"],
    ['~', "'~'"],
  ];
  for (const [word, quoted] of cases) {
    test(`shellQuote(${JSON.stringify(word)}) is ${quoted}`, () => {
      assert.equal(shellQuote(word), quoted);
    });
  }

  test('a word that starts with = is quoted, so that zsh does not expand it as a command path', () => {
    assert.equal(shellQuote('=ls'), "'=ls'");
    assert.equal(shellQuote('='), "'='");
    assert.equal(shellQuote('a=b'), 'a=b');
    assert.equal(shellQuote('--x=y'), '--x=y');
  });

  test('shellJoin quotes each word and joins with one space', () => {
    assert.equal(
      shellJoin(['claude', '--resume', S1, '-n', 'my label']),
      `claude --resume ${S1} -n 'my label'`,
    );
  });

  test('shellJoin of no words is the empty string', () => {
    assert.equal(shellJoin([]), '');
  });

  test('sh reads every word back unchanged', (t) => {
    const s = sandbox(t);
    const words = [
      '',
      'a b',
      "it's",
      '$(touch x)',
      '`x`',
      '"q"',
      '\\',
      'new\nline',
      '*',
      '~user',
      '-n',
    ];

    const r = spawnSync('/bin/sh', ['-c', `printf '[%s]\\n' ${shellJoin(words)}`], {
      env: s.env(),
      cwd: s.root,
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, words.map((w) => `[${w}]\n`).join(''));
    assert.equal(r.stderr, '');
  });
});

describe('printableCommand', () => {
  test('is "cd -- <dir> && <command>", every word quoted', () => {
    assert.equal(
      printableCommand('/home/u/my project', ['claude', '--resume', S1, '-n', "it's"]),
      `cd -- '/home/u/my project' && claude --resume ${S1} -n 'it'\\''s'`,
    );
  });

  test('is null when the directory or a word holds anything sanitize() would change', () => {
    assert.equal(printableCommand('/w\x1b]0;x\x07', ['claude']), null);
    assert.equal(printableCommand('/w', ['claude', '--model', 'op\x1b[31mus']), null);
    assert.equal(printableCommand('/w', ['claude', 'a\nb']), null);
    assert.equal(printableCommand('/w', ['claude', 'a\tb']), null);
    assert.equal(printableCommand('/w', ['claude', 'a\u202eb']), null);
  });
});

describe('formatAge', () => {
  const cases: ReadonlyArray<readonly [name: string, ns: bigint, age: string]> = [
    ['zero', 0n, '0s'],
    ['just under a minute rounds down', 59n * SEC + 999_999_999n, '59s'],
    ['a minute', 60n * SEC, '1m'],
    ['just under an hour', 3599n * SEC, '59m'],
    ['an hour', 3600n * SEC, '1h'],
    ['just under 48 hours', (48n * 3600n - 1n) * SEC, '47h'],
    ['48 hours', 48n * 3600n * SEC, '2d'],
    ['ten days', 10n * 86400n * SEC, '10d'],
    ['a negative duration counts as zero', -5n * SEC, '0s'],
  ];
  for (const [name, ns, age] of cases) {
    test(`${name}: ${age}`, () => {
      assert.equal(formatAge(ns), age);
    });
  }

  test('a duration of less than a second is 0s', () => {
    assert.equal(formatAge(999_999_999n), '0s');
  });

  test('a very large duration does not overflow', () => {
    assert.equal(formatAge(10_000n * 86400n * SEC), '10000d');
  });
});
