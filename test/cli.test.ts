import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { main } from '../src/cli/main.ts';
import type { Io } from '../src/cli/main.ts';
import pkg from '../package.json' with { type: 'json' };

interface Captured {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

function capture(): Captured {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

describe('main', () => {
  for (const flag of ['--version', '-V']) {
    test(`${flag} prints the package version and exits 0`, () => {
      const c = capture();

      const code = main([flag], c.io);

      assert.equal(code, 0);
      assert.equal(c.stdout(), `${pkg.version}\n`);
      assert.equal(c.stderr(), '');
    });
  }

  for (const argv of [[], ['--help'], ['-h']]) {
    test(`usage on stdout and exit 0 for ${JSON.stringify(argv)}`, () => {
      const c = capture();

      const code = main(argv, c.io);

      assert.equal(code, 0);
      assert.match(c.stdout(), /^Usage:/m);
      assert.equal(c.stderr(), '');
    });
  }

  for (const argv of [['frobnicate'], ['--nope'], ['--version', '--help'], ['--help', 'extra']]) {
    test(`usage on stderr and exit 2 for ${JSON.stringify(argv)}`, () => {
      const c = capture();

      const code = main(argv, c.io);

      assert.equal(code, 2);
      assert.equal(c.stdout(), '');
      assert.match(c.stderr(), /^Usage:/m);
    });
  }

  test('the usage text is the same on stdout and on stderr', () => {
    const ok = capture();
    const bad = capture();

    main(['--help'], ok.io);
    main(['frobnicate'], bad.io);

    assert.equal(bad.stderr(), ok.stdout());
  });
});
