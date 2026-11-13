import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EXIT } from '../../src/cli/exit.ts';
import { dispatch } from '../../src/cli/main.ts';
import {
  ConfigError,
  RefError,
  RestoreStoppedError,
  ResumeRefusedError,
  SkydeckError,
  UsageError,
} from '../../src/platform/errors.ts';
import { testContext } from '../helpers/context.ts';

const throwingDir = new URL('../fixtures/commands-throwing/', import.meta.url);

async function run(name: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const c = testContext();
  const code = await dispatch([name], c.ctx, throwingDir);
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

describe('dispatch maps what a command throws', () => {
  test('a UsageError is exit 2 with its message on stderr', async () => {
    assert.deepEqual(await run('usage'), {
      code: EXIT.usage,
      stdout: '',
      stderr: 'skydeck: bad\n',
    });
  });

  test('a RefError lists its candidates, one per line, by short id', async () => {
    assert.deepEqual(await run('ref'), {
      code: EXIT.ref,
      stdout: '',
      stderr: "skydeck: 'x' matches 2 sessions\n  0b5f3c1e  alpha\n  1c6a4d2f  beta\n",
    });
  });

  for (const [name, code] of [
    ['refused', EXIT.refused],
    ['stopped', EXIT.stopped],
    ['failure', EXIT.failure],
  ] as const) {
    test(`${name} is exit ${code}`, async () => {
      const result = await run(name);
      assert.equal(result.code, code);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^skydeck: .+\n$/);
    });
  }

  test('an error that is not a SkydeckError is an internal error, exit 1', async () => {
    assert.deepEqual(await run('internal'), {
      code: EXIT.failure,
      stdout: '',
      stderr: 'skydeck: internal error: boom\n',
    });
  });

  test('something thrown that is not an Error is an internal error too', async () => {
    assert.deepEqual(await run('internal-text'), {
      code: EXIT.failure,
      stdout: '',
      stderr: 'skydeck: internal error: plain text\n',
    });
  });

  test('a thrown value that cannot be printed is still an internal error', async () => {
    assert.deepEqual(await run('unprintable'), {
      code: EXIT.failure,
      stdout: '',
      stderr: 'skydeck: internal error: unprintable value\n',
    });
  });

  test('a command that returns its exit code writes nothing to stderr', async () => {
    assert.deepEqual(await run('ok'), { code: EXIT.ok, stdout: '', stderr: '' });
  });

  test('a message that ends with a newline (a usage text) is not followed by a blank line', async () => {
    const result = await run('usage-text');
    assert.equal(result.code, EXIT.usage);
    assert.equal(result.stderr, "skydeck: unknown option '--nope'\nskydeck x [--all]\n");
  });

  test('escape sequences and control characters never reach the terminal', async () => {
    const refError = await run('escapes');
    assert.equal(refError.code, EXIT.ref);
    assert.equal(refError.stderr, 'skydeck: ab\nsec ond line\n  0b5f3c1e  cd e\n');
    const internal = await run('internal-escapes');
    assert.equal(internal.code, EXIT.failure);
    assert.equal(internal.stderr, 'skydeck: internal error: open /tmp/x failed second line\n');
  });
});

describe('the exit code of each error class is the EXIT value of its name', () => {
  const cases: [string, SkydeckError, number][] = [
    ['SkydeckError', new SkydeckError('x'), EXIT.failure],
    ['ConfigError', new ConfigError('x'), EXIT.failure],
    ['UsageError', new UsageError('x'), EXIT.usage],
    ['RefError', new RefError('x', []), EXIT.ref],
    ['ResumeRefusedError', new ResumeRefusedError('x'), EXIT.refused],
    ['RestoreStoppedError', new RestoreStoppedError('x'), EXIT.stopped],
  ];
  for (const [name, error, code] of cases) {
    test(name, () => {
      assert.equal(error.exitCode, code);
    });
  }
});
