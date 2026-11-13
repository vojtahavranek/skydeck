/**
 * The three cases every command that takes a `<ref>` shares: `--help`, a missing `<ref>` and a
 * `<ref>` that names nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../src/cli/main.ts';
import { testContext } from './context.ts';
import { twoSessions } from './session-files.ts';

/** `tail` is what a valid command line may carry after the reference (label text, `--set x`). */
export function refCases(name: string, firstUsageLine: string, tail: readonly string[] = []): void {
  test(`${name} --help prints its usage and exits 0`, async () => {
    const c = testContext();
    assert.equal(await main([name, '--help'], c.ctx), 0);
    assert.ok(c.stdout().startsWith(firstUsageLine), c.stdout());
    assert.equal(c.stderr(), '');
  });

  test(`${name} without a reference is a usage error (exit 2) that shows the usage`, async (t) => {
    const d = twoSessions(t);
    assert.equal(await main([name], d.ctx), 2);
    assert.ok(d.stderr().startsWith('skydeck: missing argument\n'), d.stderr());
    assert.ok(d.stderr().includes(firstUsageLine), d.stderr());
    assert.equal(d.stdout(), '');
  });

  test(`${name} with a reference that matches nothing exits 3 and changes nothing`, async (t) => {
    const d = twoSessions(t);
    assert.equal(await main([name, 'nope1234', ...tail], d.ctx), 3);
    assert.equal(d.stderr(), "skydeck: no session matches 'nope1234'\n");
    assert.equal(d.stdout(), '');
    assert.deepEqual(d.deck.store.allMeta(), []);
  });
}
