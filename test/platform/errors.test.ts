import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ConfigError,
  RefError,
  RestoreStoppedError,
  ResumeRefusedError,
  SkydeckError,
  UsageError,
} from '../../src/platform/errors.ts';

describe('errors', () => {
  test('each class carries the exit code of design 7.5', () => {
    assert.equal(new SkydeckError('x').exitCode, 1);
    assert.equal(new ConfigError('x').exitCode, 1);
    assert.equal(new UsageError('x').exitCode, 2);
    assert.equal(new RefError('x', []).exitCode, 3);
    assert.equal(new ResumeRefusedError('x').exitCode, 4);
    assert.equal(new RestoreStoppedError('x').exitCode, 5);
  });

  test('a SkydeckError can be given another exit code', () => {
    assert.equal(new SkydeckError('x', 4).exitCode, 4);
  });

  test('a RefError keeps its candidates', () => {
    const candidates = [{ id: '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d', title: 'one' }];

    const error = new RefError('ambiguous', candidates);

    assert.deepEqual(error.candidates, candidates);
    assert.equal(error.message, 'ambiguous');
  });

  test('every class is a SkydeckError and an Error', () => {
    const errors = [
      new SkydeckError('x'),
      new ConfigError('x'),
      new UsageError('x'),
      new RefError('x', []),
      new ResumeRefusedError('x'),
      new RestoreStoppedError('x'),
    ];

    for (const error of errors) {
      assert.ok(error instanceof SkydeckError, error.name);
      assert.ok(error instanceof Error, error.name);
    }
  });

  test('the name is the name of the class that was constructed', () => {
    assert.equal(new SkydeckError('x').name, 'SkydeckError');
    assert.equal(new UsageError('x').name, 'UsageError');
    assert.equal(new RefError('x', []).name, 'RefError');
    assert.equal(new RestoreStoppedError('x').name, 'RestoreStoppedError');
  });
});
