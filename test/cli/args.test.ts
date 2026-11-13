import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseCommandArgs } from '../../src/cli/args.ts';
import type { ArgSpec } from '../../src/cli/args.ts';
import { UsageError } from '../../src/platform/errors.ts';

const SPEC: ArgSpec = {
  usage: 'U\n',
  flags: { all: { type: 'boolean' }, json: { type: 'boolean' }, set: { type: 'string' } },
  min: 0,
  max: 1,
};

const REST_SPEC: ArgSpec = {
  usage: 'U\n',
  flags: { label: { type: 'string' } },
  min: 0,
  max: 0,
  allowRest: true,
};

/** The UsageError `parseCommandArgs` throws, for the checks of its message. */
function usageError(args: string[], spec: ArgSpec = SPEC): UsageError {
  try {
    parseCommandArgs(args, spec);
  } catch (error) {
    assert.ok(error instanceof UsageError, `expected a UsageError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `${JSON.stringify(args)} did not throw` });
}

describe('parseCommandArgs', () => {
  test('boolean flags', () => {
    assert.deepEqual(parseCommandArgs(['--all', '--json'], SPEC), {
      help: false,
      flags: { all: true, json: true },
      positionals: [],
      rest: [],
    });
  });

  test('a positional and a string flag, in any order', () => {
    for (const args of [
      ['x', '--set', 'text'],
      ['--set', 'text', 'x'],
    ]) {
      const parsed = parseCommandArgs(args, SPEC);
      assert.deepEqual(parsed.positionals, ['x']);
      assert.equal(parsed.flags['set'], 'text');
    }
  });

  test('--flag=value and a lone "-" as a value', () => {
    assert.equal(parseCommandArgs(['--set=a b'], SPEC).flags['set'], 'a b');
    assert.equal(parseCommandArgs(['--set', '-'], SPEC).flags['set'], '-');
  });

  test('a short flag from the spec', () => {
    const spec: ArgSpec = { ...SPEC, flags: { all: { type: 'boolean', short: 'a' } } };
    assert.deepEqual(parseCommandArgs(['-a'], spec).flags, { all: true });
  });

  test('flags that were not given are absent', () => {
    assert.deepEqual(parseCommandArgs([], SPEC).flags, {});
  });

  for (const args of [['--help'], ['x', '-h'], ['--nope', '--help'], ['a', 'b', '-h']]) {
    test(`${JSON.stringify(args)} asks for help and nothing else is checked`, () => {
      assert.deepEqual(parseCommandArgs(args, SPEC), {
        help: true,
        flags: {},
        positionals: [],
        rest: [],
      });
    });
  }

  test('an unknown flag is a usage error that names it and ends with the usage text', () => {
    const error = usageError(['--nope']);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /^unknown option '--nope'\n/);
    assert.ok(error.message.endsWith('\nU\n'));
    assert.ok(!error.message.includes("'--'"), 'node:util hint about "--" is not repeated');
  });

  test('an unknown short flag is a usage error', () => {
    assert.ok(usageError(['-x']).message.includes('-x'));
  });

  test('a string flag without its value is a usage error', () => {
    const error = usageError(['--set']);
    assert.ok(error.message.includes('--set'));
    assert.ok(error.message.endsWith('\nU\n'));
  });

  test('a string flag followed by another flag is a usage error, not that flag swallowed as a value', () => {
    assert.ok(usageError(['--set', '--all']).message.includes('--set'));
  });

  test('a value given to a boolean flag is a usage error', () => {
    assert.ok(usageError(['--all=1']).message.includes('--all'));
  });

  test('more positionals than max is "too many arguments"', () => {
    const error = usageError(['a', 'b']);
    assert.ok(error.message.includes('too many arguments'));
    assert.ok(error.message.endsWith('\nU\n'));
  });

  test('fewer positionals than min is "missing argument"', () => {
    const error = usageError([], { ...SPEC, min: 1 });
    assert.ok(error.message.includes('missing argument'));
    assert.ok(error.message.endsWith('\nU\n'));
  });

  test('a spec with max 0 refuses any positional', () => {
    assert.ok(usageError(['x'], { ...SPEC, max: 0 }).message.includes('too many arguments'));
  });

  test('allowRest keeps everything after "--" untouched, flags of the spec included', () => {
    assert.deepEqual(parseCommandArgs(['--label', 'x', '--', '--model', 'opus'], REST_SPEC), {
      help: false,
      flags: { label: 'x' },
      positionals: [],
      rest: ['--model', 'opus'],
    });
    assert.deepEqual(parseCommandArgs(['--', '--label', 'y'], REST_SPEC).rest, ['--label', 'y']);
  });

  test('allowRest: "--help" after "--" is not a request for help', () => {
    assert.deepEqual(parseCommandArgs(['--', '--help'], REST_SPEC), {
      help: false,
      flags: {},
      positionals: [],
      rest: ['--help'],
    });
  });

  test('allowRest: only the first "--" ends the flags', () => {
    assert.deepEqual(parseCommandArgs(['--', 'a', '--', 'b'], REST_SPEC).rest, ['a', '--', 'b']);
  });

  test('allowRest: positionals before "--" still count against max', () => {
    assert.ok(usageError(['x', '--', 'y'], REST_SPEC).message.includes('too many arguments'));
  });

  test('without allowRest, "--" makes what follows positional', () => {
    assert.deepEqual(parseCommandArgs(['--', 'x'], SPEC), {
      help: false,
      flags: {},
      positionals: ['x'],
      rest: [],
    });
    assert.deepEqual(parseCommandArgs(['--', '--all'], SPEC).positionals, ['--all']);
  });

  test('without allowRest, "--help" after "--" is a positional', () => {
    const parsed = parseCommandArgs(['--', '--help'], SPEC);
    assert.equal(parsed.help, false);
    assert.deepEqual(parsed.positionals, ['--help']);
  });
});
