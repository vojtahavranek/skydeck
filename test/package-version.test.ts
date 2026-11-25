// The version written in package.json (src/update/version.ts): its first two numbers are the
// version's pair, set by hand in a pull request; its third number means nothing (git counts the
// third number of the version) and is always 0.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import pkg from '../package.json' with { type: 'json' };
import lock from '../package-lock.json' with { type: 'json' };
import { PACKAGE_VERSION, pairOf } from '../src/update/version.ts';

test("package.json's version: a well-formed pair and a third number of 0, as the lock file says", () => {
  assert.match(pkg.version, PACKAGE_VERSION);
  assert.notEqual(pairOf(pkg.version), null);
  assert.equal(pkg.version.split('.')[2], '0', 'the third number is counted by git, never written');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});
