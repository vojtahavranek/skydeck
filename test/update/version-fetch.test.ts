// The version tags reach an installation by the fetches skydeck already makes (R-F of the plan):
// git brings the tags that point at commits it has or fetches. On two real repositories in the
// sandbox (a checkout and its remote, plus a second clone that pushes, as the workflow's tag does):
// a tag made on the remote after its commit was fetched arrives with the look's next plain fetch;
// with `remote.<name>.tagOpt=--no-tags` none arrives (no version: the ids, as before versions);
// with `fetch.pruneTags` and `fetch.prune` they arrive and a tag only the checkout has is removed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import { gitOn } from '../../src/update/git.ts';
import { lookForUpdate, report } from '../../src/update/look.ts';
import type { Update } from '../../src/update/look.ts';
import { gitCheckout, gitTestEnv } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { realTestPlatform } from '../helpers/platform.ts';

interface Two {
  c: GitCheckout;
  /** The window's look: the quiet fetch, then what is known. */
  look(): Promise<Update>;
  /** A tag made in the second clone and pushed to the remote, as the workflow makes one. */
  remoteTag(name: string, rev?: string): void;
}

function two(t: TestContext): Two {
  const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
  const c = gitCheckout(tp.sandbox);
  const platform: Platform = { ...tp.platform, appRoot: c.root };
  return {
    c,
    look: async () => {
      const looked = await lookForUpdate(gitOn(platform, c.root), platform.files, {
        fetch: { quiet: {} },
        tolerant: true,
      });
      assert.ok(looked.kind === 'known', JSON.stringify(looked));
      return looked.update;
    },
    remoteTag: (name, rev = 'HEAD') => {
      c.git(c.other, 'tag', name, rev);
      c.git(c.other, 'push', '--quiet', 'origin', `refs/tags/${name}`);
    },
  };
}

describe('the version tags come with the fetches skydeck makes (R-F)', () => {
  test('a tag made on the remote after its commit was fetched arrives with the next plain fetch', async (t) => {
    const r = two(t);
    const made = r.c.push('a change', { 'a.txt': 'a\n' });

    const first = await r.look();
    assert.equal(first.newId, made);
    assert.equal(first.newVersion, null, 'no tag yet: no version');
    assert.equal(
      report(first)[0]?.endsWith(`(${first.oldId.slice(0, 7)}..${made.slice(0, 7)}):`),
      true,
    );

    r.remoteTag('v0.9.0'); // on the commit the checkout has fetched already
    const second = await r.look();
    assert.equal(second.newVersion, '0.9.0');
    assert.equal(second.oldVersion, null, 'HEAD is before the tag');
    assert.deepEqual(r.c.git(r.c.root, 'tag', '--list').trim().split('\n'), ['v0.9.0']);

    r.remoteTag('v0.9.1', 'HEAD~1'); // the commit HEAD is at
    assert.equal((await r.look()).oldVersion, '0.9.1');
  });

  test('remote.<name>.tagOpt=--no-tags: no tag arrives, so no version — the ids as before versions', async (t) => {
    const r = two(t);
    r.c.git(r.c.root, 'config', 'remote.origin.tagOpt', '--no-tags');
    r.remoteTag('v0.9.0');
    const made = r.c.push('a change', { 'a.txt': 'a\n' });

    const update = await r.look();

    assert.equal(update.newId, made);
    assert.equal(update.oldVersion, null);
    assert.equal(update.newVersion, null);
    assert.equal(r.c.git(r.c.root, 'tag', '--list'), '');
    assert.equal(
      report(update)[0],
      `1 new commit on origin/main (${update.oldId.slice(0, 7)}..${made.slice(0, 7)}):`,
    );
  });

  test("fetch.pruneTags with fetch.prune: the remote's tags arrive, and a tag only the checkout has is removed", async (t) => {
    const r = two(t);
    r.c.git(r.c.root, 'config', 'fetch.prune', 'true');
    r.c.git(r.c.root, 'config', 'fetch.pruneTags', 'true');
    r.c.git(r.c.root, 'tag', 'v5.0.0'); // made by hand in the checkout, never pushed
    r.remoteTag('v0.9.0');
    r.c.push('a change', { 'a.txt': 'a\n' });

    const update = await r.look();

    assert.equal(update.oldVersion, '0.9.0', "the remote's tag; the checkout's own was pruned");
    assert.equal(update.newVersion, '0.9.0+1');
    assert.deepEqual(r.c.git(r.c.root, 'tag', '--list').trim().split('\n'), ['v0.9.0']);
  });

  test('fetch.pruneTags alone (no fetch.prune): the tags arrive, nothing is removed', async (t) => {
    const r = two(t);
    r.c.git(r.c.root, 'config', 'fetch.pruneTags', 'true');
    r.c.git(r.c.root, 'tag', 'v5.0.0');
    r.remoteTag('v0.9.0');

    const update = await r.look();

    assert.equal(update.oldVersion, '5.0.0', "the highest of the commit's tags");
    assert.deepEqual(r.c.git(r.c.root, 'tag', '--list').trim().split('\n'), ['v0.9.0', 'v5.0.0']);
  });
});
