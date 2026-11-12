import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dispatch, main } from '../../src/cli/main.ts';
import pkg from '../../package.json' with { type: 'json' };
import { testContext } from '../helpers/context.ts';

const commandsDir = new URL('../fixtures/commands/', import.meta.url);
const badCommandsDir = new URL('../fixtures/commands-bad/', import.meta.url);
const missingDir = new URL('../fixtures/no-such-directory/', import.meta.url);

describe('main', () => {
  for (const flag of ['--version', '-V']) {
    test(`${flag} prints the package version and exits 0`, async () => {
      const c = testContext();

      const code = await main([flag], c.ctx);

      assert.equal(code, 0);
      assert.equal(c.stdout(), `${pkg.version}\n`);
      assert.equal(c.stderr(), '');
    });
  }

  for (const argv of [['--help'], ['-h']]) {
    test(`usage on stdout and exit 0 for ${JSON.stringify(argv)}`, async () => {
      const c = testContext();

      const code = await main(argv, c.ctx);

      assert.equal(code, 0);
      assert.match(c.stdout(), /^Usage:/m);
      assert.equal(c.stderr(), '');
    });
  }

  test('bare skydeck prints the usage and exits 0 until the interactive list exists', async () => {
    const c = testContext();

    const code = await main([], c.ctx);

    assert.equal(code, 0);
    assert.match(c.stdout(), /^Usage:/m);
    assert.equal(c.stderr(), '');
  });

  const unknown = [
    ['frobnicate'],
    ['--nope'],
    ['-x'],
    ['--version', '--help'],
    ['--help', 'extra'],
    ['-V', 'extra'],
    [''],
    ['Frobnicate'],
    ['1abc'],
    ['a_b'],
    ['a/b'],
    ['../x'],
    ['.'],
  ];
  for (const argv of unknown) {
    test(`usage on stderr and exit 2 for ${JSON.stringify(argv)}`, async () => {
      const c = testContext();

      const code = await main(argv, c.ctx);

      assert.equal(code, 2);
      assert.equal(c.stdout(), '');
      assert.match(c.stderr(), /^Usage:/m);
    });
  }

  test('the usage text is the same on stdout and on stderr', async () => {
    const ok = testContext();
    const bad = testContext();

    await main(['--help'], ok.ctx);
    await main(['frobnicate'], bad.ctx);

    assert.equal(bad.stderr(), ok.stdout());
  });
});

describe('dispatch: commands are files in a directory', () => {
  test('runs <name>.ts with the remaining arguments', async () => {
    const c = testContext();

    const code = await dispatch(['alpha', 'one', '--two', 'three four'], c.ctx, commandsDir);

    assert.equal(code, 0);
    assert.equal(c.stdout(), 'alpha one,--two,three four\n');
    assert.equal(c.stderr(), '');
  });

  test('returns the exit code of the command', async () => {
    const c = testContext();

    const code = await dispatch(['beta-two'], c.ctx, commandsDir);

    assert.equal(code, 3);
    assert.equal(c.stderr(), 'beta-two failed\n');
  });

  test('--help after a command name belongs to the command, not to skydeck', async () => {
    const c = testContext();

    const code = await dispatch(['alpha', '--help'], c.ctx, commandsDir);

    assert.equal(code, 0);
    assert.equal(c.stdout(), 'alpha --help\n');
  });

  test('a name without a file is an unknown command: usage on stderr, exit 2', async () => {
    const c = testContext();

    const code = await dispatch(['gamma'], c.ctx, commandsDir);

    assert.equal(code, 2);
    assert.equal(c.stdout(), '');
    assert.match(c.stderr(), /^Usage:/m);
  });

  test('a name that would leave the directory is never loaded', async () => {
    const c = testContext();
    const nested = new URL('nested/', commandsDir);

    // ../alpha.ts exists relative to the nested directory; it must not run.
    const code = await dispatch(['../alpha'], c.ctx, nested);

    assert.equal(code, 2);
    assert.equal(c.stdout(), '');
  });

  test('a file whose name is not a command name is not a command', async () => {
    const c = testContext();

    const code = await dispatch(['_helper'], c.ctx, commandsDir);

    assert.equal(code, 2);
  });

  test('--help lists the commands by name with their summaries, skipping other files', async () => {
    const c = testContext();

    const code = await dispatch(['--help'], c.ctx, commandsDir);

    assert.equal(code, 0);
    const section = c.stdout().split('Commands:\n')[1]?.split('\n\n')[0];
    assert.equal(section, '  alpha     Say alpha with the arguments\n  beta-two  Always fail');
    assert.match(c.stdout(), /^Options:$/m);
  });

  test('the usage for an unknown command lists the commands too', async () => {
    const help = testContext();
    const unknown = testContext();

    await dispatch(['--help'], help.ctx, commandsDir);
    await dispatch(['gamma'], unknown.ctx, commandsDir);

    assert.equal(unknown.stderr(), help.stdout());
  });

  test('with no commands directory the usage has no Commands section', async () => {
    const c = testContext();

    const code = await dispatch(['--help'], c.ctx, missingDir);

    assert.equal(code, 0);
    assert.doesNotMatch(c.stdout(), /Commands:/);
    assert.match(c.stdout(), /^Options:$/m);
  });

  test('a command file that does not export a matching command fails loudly', async () => {
    for (const name of ['mismatch', 'no-export']) {
      const c = testContext();

      await assert.rejects(dispatch([name], c.ctx, badCommandsDir), new RegExp(`${name}\\.ts`));
    }
  });

  test('a command file that cannot load is not reported as an unknown command', async () => {
    const c = testContext();

    await assert.rejects(dispatch(['broken-import'], c.ctx, badCommandsDir), /does-not-exist/);
  });
});
