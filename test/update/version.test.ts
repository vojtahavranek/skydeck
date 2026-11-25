// The version of a commit (src/update/version.ts): `<major>.<minor>.<patch>`, the pair from
// package.json, the third number counted by git on the first-parent history after the commit that
// last changed the pair — on the real git with throwaway repositories in the sandbox, and the pair
// alone whenever git cannot count (a shallow clone, a partial clone, a failure, the budget, the
// search's limit, a package.json that is not one), with nothing fetched.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import { gitOn } from '../../src/update/git.ts';
import {
  pairOf,
  PAIR_CHANGES_READ,
  versionGitOf,
  versionName,
  versionOf,
} from '../../src/update/version.ts';
import type { VersionGit } from '../../src/update/version.ts';
import { gitCheckout, gitTestEnv, insideSandbox } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { realTestPlatform, runResult } from '../helpers/platform.ts';
import type { RealTestPlatform } from '../helpers/platform.ts';

const BUDGET = 10_000;
const IDENTITY = ['-c', 'user.name=skydeck test', '-c', 'user.email=test@skydeck.invalid'];

/** package.json with `version` and one more line, as the repository's own has. */
function pkg(version: string, extra = 'a'): string {
  return `${JSON.stringify({ name: 'skydeck', version, extra }, null, 2)}\n`;
}

interface Repo {
  tp: RealTestPlatform;
  c: GitCheckout;
  /** The version of `rev` (HEAD by default) in `dir` (the checkout by default). */
  version(rev?: string, dir?: string): Promise<string | null>;
  /** `n` commits that do not touch package.json; the last one's id. */
  commits(n: number, tag: string): string;
}

function repo(
  t: TestContext,
  first: Record<string, string> = { 'package.json': pkg('0.9.0') },
): Repo {
  const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
  const c = gitCheckout(tp.sandbox, { content: first });
  const platform: Platform = { ...tp.platform, appRoot: c.root };
  return {
    tp,
    c,
    version: (rev = 'HEAD', dir = c.root) =>
      versionOf(versionGitOf(gitOn(platform, insideSandbox(tp.sandbox, dir))), rev, BUDGET),
    commits(n, tag) {
      let id = '';
      for (let i = 1; i <= n; i += 1) {
        id = c.commit(c.root, `${tag} ${i}`, { [`${tag}-${i}.txt`]: `${i}\n` });
      }
      return id;
    },
  };
}

describe('the version of a commit, on the real git (D1)', () => {
  test('the commit that sets the pair is .0; n commits later .n', async (t) => {
    const r = repo(t);
    assert.equal(await r.version(), '0.9.0');
    r.commits(1, 'one');
    assert.equal(await r.version(), '0.9.1');
    r.commits(15, 'more');
    assert.equal(await r.version(), '0.9.16');
  });

  test('a second bump starts again at .0, also when it is a change of the third number too', async (t) => {
    const r = repo(t);
    r.commits(3, 'a');
    const before = r.c.id();
    r.c.commit(r.c.root, 'bump', { 'package.json': pkg('0.10.0') });
    assert.equal(await r.version(), '0.10.0');
    r.commits(2, 'b');
    assert.equal(await r.version(), '0.10.2');
    assert.equal(await r.version(before), '0.9.3', 'an older commit keeps its own version');
    r.c.commit(r.c.root, 'one', { 'package.json': pkg('1.0.0') });
    assert.equal(await r.version(), '1.0.0');
  });

  test('a change of the third number alone, or of another line of package.json, is no bump', async (t) => {
    const r = repo(t);
    r.commits(2, 'a');
    r.c.commit(r.c.root, 'the third number', { 'package.json': pkg('0.9.7') });
    assert.equal(await r.version(), '0.9.3');
    r.c.commit(r.c.root, 'another line', { 'package.json': pkg('0.9.7', 'b') });
    assert.equal(await r.version(), '0.9.4');
    r.commits(1, 'c');
    assert.equal(await r.version(), '0.9.5');
  });

  test('a pair that goes back to an earlier one is a bump too: the last change of the pair counts', async (t) => {
    const r = repo(t);
    r.c.commit(r.c.root, 'up', { 'package.json': pkg('0.10.0') });
    r.c.commit(r.c.root, 'back', { 'package.json': pkg('0.9.0') });
    r.commits(1, 'a');
    assert.equal(await r.version(), '0.9.1');
  });

  test('a merge commit counts as one: the commits of the merged branch do not count (first parent)', async (t) => {
    const r = repo(t);
    r.commits(2, 'main');
    r.c.git(r.c.root, 'checkout', '--quiet', '-b', 'side');
    r.commits(5, 'side');
    r.c.git(r.c.root, 'checkout', '--quiet', 'main');
    r.c.git(r.c.root, ...IDENTITY, 'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
    assert.equal(await r.version(), '0.9.3');
    // A bump made on the merged branch counts from the merge, which brings it to the first parent.
    r.c.git(r.c.root, 'checkout', '--quiet', '-b', 'bumped');
    r.c.commit(r.c.root, 'bump on a branch', { 'package.json': pkg('0.11.0') });
    r.commits(4, 'bumped');
    r.c.git(r.c.root, 'checkout', '--quiet', 'main');
    r.c.git(r.c.root, ...IDENTITY, 'merge', '--quiet', '--no-ff', '-m', 'merge bump', 'bumped');
    assert.equal(await r.version(), '0.11.0');
    r.commits(1, 'after');
    assert.equal(await r.version(), '0.11.1');
  });

  test('package.json added later than the first commit: the commit that adds it is .0', async (t) => {
    const r = repo(t, { 'README.md': 'one\n' });
    assert.equal(await r.version(), null, 'no package.json: no pair, no fallback');
    r.c.commit(r.c.root, 'add it', { 'package.json': pkg('0.9.0') });
    r.commits(2, 'a');
    assert.equal(await r.version(), '0.9.2');
  });

  test('the version is read from the commit, never the work tree', async (t) => {
    const r = repo(t);
    r.commits(1, 'a');
    writeFileSync(join(r.c.root, 'package.json'), pkg('3.4.0'));
    assert.equal(await r.version(), '0.9.1');
  });
});

describe('when git cannot count: the pair alone (D4)', () => {
  test('a shallow clone whose history does not reach the bump: the pair alone; one that does: counted', async (t) => {
    const r = repo(t);
    r.commits(5, 'a');
    const shallow = insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, 'shallow'));
    mkdirSync(shallow);
    r.c.git(r.c.root, 'push', '--quiet', 'origin', 'main');
    r.c.git(shallow, 'clone', '--quiet', '--depth', '2', `file://${r.c.remote}`, '.');
    assert.equal(await r.version('HEAD', shallow), '0.9');

    r.c.commit(r.c.root, 'bump', { 'package.json': pkg('0.10.0') });
    r.commits(2, 'b');
    r.c.git(r.c.root, 'push', '--quiet', 'origin', 'main');
    const deeper = insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, 'deeper'));
    mkdirSync(deeper);
    r.c.git(deeper, 'clone', '--quiet', '--depth', '4', `file://${r.c.remote}`, '.');
    assert.equal(await r.version('HEAD', deeper), '0.10.2', 'the bump is inside the history');
  });

  test('a partial clone without blobs: the pair alone (no fallback: null), and nothing is fetched', async (t) => {
    const r = repo(t);
    r.commits(3, 'a');
    r.c.git(r.c.root, 'push', '--quiet', 'origin', 'main');
    r.c.git(r.c.remote, 'config', 'uploadpack.allowFilter', 'true');
    const partial = insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, 'partial'));
    mkdirSync(partial);
    r.c.git(
      partial,
      'clone',
      '--quiet',
      '--no-checkout',
      '--filter=blob:none',
      `file://${r.c.remote}`,
      '.',
    );
    const missing = (): string =>
      r.c.git(partial, 'rev-list', '--objects', '--missing=print', '--all');
    const before = missing();
    assert.match(before, /^\?[0-9a-f]+$/m, 'blobs are missing');

    const platform: Platform = { ...r.tp.platform, appRoot: partial };
    const git = versionGitOf(gitOn(platform, partial));
    assert.equal(await versionOf(git, 'HEAD', BUDGET), null);
    assert.equal(await versionOf(git, 'HEAD', BUDGET, '0.9'), '0.9');
    assert.equal(missing(), before, 'no object was fetched');
  });

  test('a package.json in the history that is not JSON: the pair alone, never a guess', async (t) => {
    const r = repo(t);
    r.c.commit(r.c.root, 'broken', { 'package.json': '{ "version": "0.9.0",\n' });
    r.c.commit(r.c.root, 'mended', { 'package.json': pkg('0.9.0') });
    r.commits(1, 'a');
    assert.equal(await r.version(), '0.9');
    r.c.commit(r.c.root, 'no version', { 'package.json': '{}\n' });
    assert.equal(await r.version(), null, "the commit's own has no pair");
  });

  test('more changes of package.json than the search reads, without a bump: the pair alone', async (t) => {
    const r = repo(t);
    for (let i = 1; i <= PAIR_CHANGES_READ; i += 1) {
      r.c.commit(r.c.root, `deps ${i}`, { 'package.json': pkg('0.9.0', `x${i}`) });
    }
    assert.equal(await r.version(), '0.9');
    r.c.commit(r.c.root, 'bump', { 'package.json': pkg('0.10.0') });
    assert.equal(await r.version(), '0.10.0', 'a bump within the limit is found');
  });

  test('not a checkout, or a commit that is not there: the fallback, or null', async (t) => {
    const r = repo(t);
    const plain = insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, 'plain'));
    mkdirSync(plain);
    const platform: Platform = { ...r.tp.platform, appRoot: plain };
    assert.equal(
      await versionOf(versionGitOf(gitOn(platform, plain)), 'HEAD', BUDGET, '0.9'),
      '0.9',
    );
    assert.equal(await r.version('f'.repeat(40)), null);
  });
});

describe('the budget and the failures, on a scripted git', () => {
  /** A VersionGit whose every call answers `answer`; the calls' arguments and timeouts. */
  function scripted(
    answer: (args: readonly string[]) => ReturnType<VersionGit['run']>,
    clock = { ns: 0n },
  ): {
    git: VersionGit;
    calls: { args: readonly string[]; timeoutMs: number }[];
  } {
    const calls: { args: readonly string[]; timeoutMs: number }[] = [];
    return {
      calls,
      git: {
        run(args, options) {
          calls.push({ args, timeoutMs: options.timeoutMs });
          return answer(args);
        },
        monotonicNs: () => clock.ns,
      },
    };
  }

  test('a call that fails, times out or throws: the pair alone, nothing thrown', async () => {
    for (const fail of [
      runResult({ code: 128 }),
      runResult({ code: null, timedOut: true }),
      runResult({ code: null, notFound: true }),
    ]) {
      const { git } = scripted(() => Promise.resolve(fail));
      assert.equal(await versionOf(git, 'HEAD', BUDGET, '0.9'), '0.9');
    }
    const { git } = scripted(() => Promise.reject(new Error('EAGAIN')));
    assert.equal(await versionOf(git, 'HEAD', BUDGET, '0.9'), '0.9');
  });

  test("an AbortError (the caller's stop) is thrown on", async () => {
    const abort = Object.assign(new Error('stopped'), { name: 'AbortError' });
    const { git } = scripted(() => Promise.reject(abort));
    await assert.rejects(versionOf(git, 'HEAD', BUDGET), { name: 'AbortError' });
  });

  test('every call gets what is left of the budget; none starts once it is spent', async () => {
    const clock = { ns: 0n };
    const ID = 'a'.repeat(40);
    const { git, calls } = scripted(async (args) => {
      await Promise.resolve(); // every call takes 0.7 s, once all of its round have started
      clock.ns += 700_000_000n;
      if (args[0] === 'config') return runResult({ code: 1 });
      if (args[0] === 'rev-parse') return runResult({ stdout: 'false\n' });
      if (args.includes('--max-count=100')) return runResult({ stdout: `${ID}\n` });
      const file = pkg('0.9.0');
      return runResult({ stdout: `${ID} blob ${Buffer.byteLength(file)}\n${file}\n` });
    }, clock);

    assert.equal(await versionOf(git, 'HEAD', 2_000, '0.1'), '0.1');
    assert.deepEqual(
      calls.map((c) => [c.args[0], c.timeoutMs]),
      [
        ['config', 2_000],
        ['rev-parse', 2_000],
        ['rev-list', 600], // 1.4 s spent by the first round (the fake clock adds both)
      ],
      'the third round had no time left: the pair of no file was read, the fallback stays',
    );
  });
});

describe('the helpers', () => {
  test('pairOf: three numbers without leading zeros, the first two', () => {
    assert.equal(pairOf('0.9.0'), '0.9');
    assert.equal(pairOf('12.034.0'), null);
    assert.equal(pairOf('1.0'), null);
    assert.equal(pairOf('1.0.0-beta'), null);
    assert.equal(pairOf(1), null);
  });

  test('versionName: the version, else the short id', () => {
    assert.equal(versionName('0.9.16', 'c75af0e'.padEnd(40, '0')), '0.9.16');
    assert.equal(versionName('0.9', 'c75af0e'.padEnd(40, '0')), '0.9');
    assert.equal(versionName(null, 'c75af0e'.padEnd(40, '0')), 'c75af0e');
  });
});
