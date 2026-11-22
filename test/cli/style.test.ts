import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { styleFor } from '../../src/cli/style.ts';
import { capture } from '../helpers/capture.ts';

const TTY = { stdoutTTY: true, stderrTTY: true };

describe('styleFor: colour only on a terminal, without NO_COLOR, with a TERM that is not dumb', () => {
  test('on a terminal: bold, dim, red and green, each closed by its own off', () => {
    const style = styleFor(capture(TTY).io, { TERM: 'xterm-256color' }, 'stdout');

    assert.equal(style.bold('Hooks'), '\x1b[1mHooks\x1b[22m');
    assert.equal(style.dim('backup'), '\x1b[2mbackup\x1b[22m');
    assert.equal(style.red('problem'), '\x1b[31mproblem\x1b[39m');
    assert.equal(style.green('ok'), '\x1b[32mok\x1b[39m');
  });

  test('TERM unset is no reason to leave colour out', () => {
    assert.equal(styleFor(capture(TTY).io, {}, 'stderr').bold('x'), '\x1b[1mx\x1b[22m');
  });

  const plain: [
    string,
    Parameters<typeof capture>[0],
    Record<string, string>,
    'stdout' | 'stderr',
  ][] = [
    ['stdout is not a terminal', { stderrTTY: true }, {}, 'stdout'],
    ['stderr is not a terminal', { stdoutTTY: true }, {}, 'stderr'],
    ['NO_COLOR is set', TTY, { NO_COLOR: '1' }, 'stdout'],
    ['NO_COLOR is set to anything', TTY, { NO_COLOR: 'false' }, 'stderr'],
    ['TERM is dumb', TTY, { TERM: 'dumb' }, 'stdout'],
  ];
  for (const [why, options, env, stream] of plain) {
    test(`${why}: every function gives its text back unchanged`, () => {
      const style = styleFor(capture(options).io, env, stream);
      for (const paint of [style.bold, style.dim, style.red, style.green]) {
        assert.equal(paint('text'), 'text');
      }
    });
  }

  test('NO_COLOR set but empty counts as not set (no-color.org)', () => {
    assert.equal(
      styleFor(capture(TTY).io, { NO_COLOR: '' }, 'stdout').green('ok'),
      '\x1b[32mok\x1b[39m',
    );
  });
});
