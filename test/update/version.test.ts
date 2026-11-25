// The version of a commit (src/update/version.ts, R-D and D1'' of the plan): the nearest version tag
// on the commit's first-parent history and the distance — on the real git with throwaway
// repositories in the sandbox: at a tag, past it, none, several on one commit, names that are not
// version tags, a tag on a merged branch, a shallow clone, a partial clone (nothing fetched) — and
// no version whenever a call fails or does not answer, on a scripted git. R-F, the tags an
// installation gets by the fetches skydeck already makes, is test/update/version-fetch.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform, RunResult } from '../../src/platform/types.ts';
import { gitOn } from '../../src/update/git.ts';
import { CHAIN_READ, versionGitOf, versionName, versionOf } from '../../src/update/version.ts';
import type { VersionGit } from '../../src/update/version.ts';
import {
  compareVersions,
  parseVersionTag,
  TAGS_ARGS,
  versionTagsOf,
} from '../../src/update/version-tags.ts';
import { gitCheckout, gitTestEnv, insideSandbox } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { realTestPlatform, runResult } from '../helpers/platform.ts';
import type { RealTestPlatform } from '../helpers/platform.ts';

const MS = 10_000;
const IDENTITY = ['-c', 'user.name=skydeck test', '-c', 'user.email=test@skydeck.invalid'];

interface Repo {
  tp: RealTestPlatform;
  c: GitCheckout;
  /** The version of `rev` (HEAD by default) in `dir` (the checkout by default). */
  version(rev?: string, dir?: string): Promise<string | null>;
  /** `n` plain commits; the last one's id. */
  commits(n: number, tag: string): string;
  tag(name: string, rev?: string): void;
}

function repo(t: TestContext): Repo {
  const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
  const c = gitCheckout(tp.sandbox);
  const platform: Platform = { ...tp.platform, appRoot: c.root };
  return {
    tp,
    c,
    version: (rev = 'HEAD', dir = c.root) =>
      versionOf(versionGitOf(gitOn(platform, insideSandbox(tp.sandbox, dir))), rev, MS),
    commits(n, tag) {
      let id = '';
      for (let i = 1; i <= n; i += 1) {
        id = c.commit(c.root, `${tag} ${i}`, { [`${tag}-${i}.txt`]: `${i}\n` });
      }
      return id;
    },
    tag: (name, rev = 'HEAD') => {
      c.git(c.root, 'tag', name, rev);
    },
  };
}

describe("the version of a commit, on the real git (D1'')", () => {
  test('no version tag reachable: no version', async (t) => {
    const r = repo(t);
    r.commits(2, 'a');
    assert.equal(await r.version(), null);
  });

  test('at a tag: its version; n commits past it: +n; a later tag: its own', async (t) => {
    const r = repo(t);
    r.tag('v0.9.0');
    assert.equal(await r.version(), '0.9.0');
    r.commits(3, 'a');
    assert.equal(await r.version(), '0.9.0+3');
    r.tag('v0.9.1');
    assert.equal(await r.version(), '0.9.1');
    r.commits(1, 'b');
    assert.equal(await r.version(), '0.9.1+1');
    assert.equal(await r.version('HEAD~2'), '0.9.0+2', 'an older commit keeps its own');
  });

  test('several version tags on one commit: the highest; names that are not version tags: none', async (t) => {
    const r = repo(t);
    r.tag('v0.9.3');
    r.tag('v0.10.0');
    r.tag('v0.9.12');
    assert.equal(await r.version(), '0.10.0');
    r.commits(1, 'a');
    for (const name of ['v1.2', 'v01.2.3', 'version-1', 'v1.2.3-rc1', '1.2.3', 'v2.0.0.1']) {
      r.tag(name);
    }
    assert.equal(await r.version(), '0.10.0+1');
  });

  test('an annotated version tag counts; one that names no commit does not', async (t) => {
    const r = repo(t);
    r.c.git(r.c.root, ...IDENTITY, 'tag', '-a', '-m', 'by hand', 'v1.0.0');
    assert.equal(await r.version(), '1.0.0');
    const tree = r.c.git(r.c.root, 'rev-parse', 'HEAD^{tree}').trim();
    r.tag('v2.0.0', tree);
    assert.equal(await r.version(), '1.0.0');
  });

  test('only the first-parent history: a tag on a merged branch is not reached; the merge is one commit', async (t) => {
    const r = repo(t);
    r.tag('v0.9.2');
    r.c.git(r.c.root, 'checkout', '--quiet', '-b', 'side');
    r.commits(3, 'side');
    r.tag('v5.0.0');
    r.c.git(r.c.root, 'checkout', '--quiet', 'main');
    r.c.git(r.c.root, ...IDENTITY, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'side');
    assert.equal(await r.version(), '0.9.2+1');
  });

  test('a shallow clone that does not reach the tag: no version; one that does: the version', async (t) => {
    const r = repo(t);
    r.tag('v0.9.0');
    r.commits(5, 'a');
    r.c.git(r.c.root, 'push', '--quiet', 'origin', 'main', 'v0.9.0');
    const shallow = insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, 'shallow'));
    mkdirSync(shallow);
    r.c.git(shallow, 'clone', '--quiet', '--depth', '2', `file://${r.c.remote}`, '.');
    assert.equal(await r.version('HEAD', shallow), null);
    const deep = insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, 'deep'));
    mkdirSync(deep);
    r.c.git(deep, 'clone', '--quiet', '--depth', '6', `file://${r.c.remote}`, '.');
    assert.equal(await r.version('HEAD', deep), '0.9.0+5');
  });

  test('a partial clone without blobs or trees: the version, and nothing is fetched', async (t) => {
    const r = repo(t);
    r.tag('v0.9.0');
    r.commits(2, 'a');
    r.c.git(r.c.root, 'push', '--quiet', 'origin', 'main', 'v0.9.0');
    r.c.git(r.c.remote, 'config', 'uploadpack.allowFilter', 'true');
    for (const filter of ['blob:none', 'tree:0']) {
      const partial = insideSandbox(
        r.tp.sandbox,
        join(r.tp.sandbox.root, filter.replace(':', '-')),
      );
      mkdirSync(partial);
      r.c.git(
        partial,
        'clone',
        '--quiet',
        '--no-checkout',
        `--filter=${filter}`,
        `file://${r.c.remote}`,
        '.',
      );
      const missing = (): string =>
        r.c.git(partial, 'rev-list', '--objects', '--missing=print', '--all');
      const before = missing();
      assert.match(before, /^\?[0-9a-f]+$/m, `${filter}: objects are missing`);
      assert.equal(await r.version('HEAD', partial), '0.9.0+2', filter);
      assert.equal(missing(), before, `${filter}: no object was fetched`);
    }
  });

  test('only tags whose name starts with v are read: others neither count nor use up the cap', async (t) => {
    const r = repo(t);
    r.tag('v0.9.0');
    for (const name of ['nightly', 'release-1', '1.0.0', 'x/v9.9.9']) r.tag(name);
    assert.equal(TAGS_ARGS.at(-1), 'refs/tags/v*');
    const listed = r.c.git(r.c.root, ...TAGS_ARGS);
    assert.deepEqual(
      listed
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('\0')[0]),
      ['refs/tags/v0.9.0'],
    );
    assert.equal(await r.version(), '0.9.0');
  });

  test('not a checkout, or a commit that is not there: no version', async (t) => {
    const r = repo(t);
    r.tag('v0.9.0');
    const plain = insideSandbox(r.tp.sandbox, join(r.tp.sandbox.root, 'plain'));
    mkdirSync(plain);
    const platform: Platform = { ...r.tp.platform, appRoot: plain };
    assert.equal(await versionOf(versionGitOf(gitOn(platform, plain)), 'HEAD', MS), null);
    assert.equal(await r.version('f'.repeat(40)), null);
  });
});

describe('the calls, their failures and their limits, on a scripted git', () => {
  const HEAD = 'a'.repeat(40);
  const TAGGED = 'b'.repeat(40);
  const record = (name: string, id: string): string => `refs/tags/${name}\0commit\0${id}\0\0\0\n`;

  /** A VersionGit that answers `answer`; the calls with their options. */
  function scripted(answer: (args: readonly string[]) => Promise<RunResult>): {
    git: VersionGit;
    calls: { args: readonly string[]; timeoutMs: number; maxBytes: number }[];
  } {
    const calls: { args: readonly string[]; timeoutMs: number; maxBytes: number }[] = [];
    return {
      calls,
      git: {
        run(args, options) {
          calls.push({ args, ...options });
          return answer(args);
        },
      },
    };
  }

  const good = (args: readonly string[]): Promise<RunResult> =>
    Promise.resolve(
      runResult({
        stdout: args[0] === 'for-each-ref' ? record('v0.9.16', TAGGED) : `${HEAD}\n${TAGGED}\n`,
      }),
    );

  test('two calls, side by side, each with the whole bound: the tags and the first-parent history', async () => {
    const answers: (() => void)[] = [];
    const { git, calls } = scripted(
      (args) =>
        new Promise((resolve) => {
          answers.push(() => {
            void good(args).then(resolve);
          });
        }),
    );
    const version = versionOf(git, 'HEAD', 2_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, 'both before any answer');
    for (const answer of answers) answer();
    assert.equal(await version, '0.9.16+1');
    assert.deepEqual(
      calls.map((c) => [c.args, c.timeoutMs]),
      [
        [TAGS_ARGS, 2_000],
        [['rev-list', '--first-parent', `--max-count=${CHAIN_READ}`, 'HEAD'], 2_000],
      ],
    );
  });

  test('a call that fails, times out, is not found, throws or is cut at its cap: no version, nothing thrown', async () => {
    for (const bad of [
      runResult({ code: 128 }),
      runResult({ code: null, timedOut: true }),
      runResult({ code: null, notFound: true }),
    ]) {
      for (const which of ['for-each-ref', 'rev-list']) {
        const { git } = scripted((args) => (args[0] === which ? Promise.resolve(bad) : good(args)));
        assert.equal(await versionOf(git, 'HEAD', MS), null, which);
      }
    }
    const thrown = scripted(() => Promise.reject(new Error('EAGAIN')));
    assert.equal(await versionOf(thrown.git, 'HEAD', MS), null);
    const capped = scripted((args) =>
      args[0] === 'for-each-ref'
        ? Promise.resolve(runResult({ stdout: 'x'.repeat(1024 * 1024) }))
        : good(args),
    );
    assert.equal(await versionOf(capped.git, 'HEAD', MS), null, 'a list of tags past its cap');
    const odd = scripted((args) =>
      args[0] === 'rev-list' ? Promise.resolve(runResult({ stdout: 'not an id\n' })) : good(args),
    );
    assert.equal(await versionOf(odd.git, 'HEAD', MS), null, 'an answer that is not a history');
  });

  test("an AbortError (the caller's stop) is thrown on", async () => {
    const abort = Object.assign(new Error('stopped'), { name: 'AbortError' });
    const { git } = scripted(() => Promise.reject(abort));
    await assert.rejects(versionOf(git, 'HEAD', MS), { name: 'AbortError' });
  });

  test('more than CHAIN_READ commits past the nearest tag: no version', async () => {
    const chain = Array.from({ length: CHAIN_READ }, (_, i) => i.toString(16).padStart(40, '0'));
    const { git } = scripted((args) =>
      Promise.resolve(
        runResult({
          stdout: args[0] === 'for-each-ref' ? record('v0.9.0', TAGGED) : `${chain.join('\n')}\n`,
        }),
      ),
    );
    assert.equal(await versionOf(git, 'HEAD', MS), null);
  });
});

describe('the helpers', () => {
  test('parseVersionTag: v and three numbers without leading zeros; compareVersions orders them', () => {
    assert.deepEqual(parseVersionTag('v0.9.16'), { major: 0, minor: 9, patch: 16 });
    for (const name of [
      'v1.2',
      'v01.2.3',
      'version-1',
      'v1.2.3-rc1',
      '1.2.3',
      'V1.2.3',
      'v1.2.3 ',
    ]) {
      assert.equal(parseVersionTag(name), null, name);
    }
    assert.equal(parseVersionTag(`v${'9'.repeat(20)}.0.0`), null, 'not a safe number');
    const v = (name: string) => parseVersionTag(name) ?? assert.fail(name);
    assert.ok(compareVersions(v('v0.10.0'), v('v0.9.99')) > 0);
    assert.ok(compareVersions(v('v1.0.0'), v('v0.99.99')) > 0);
    assert.equal(compareVersions(v('v0.9.1'), v('v0.9.1')), 0);
  });

  test('versionTagsOf: by commit the highest; a peeled annotated tag; a tag of a tree is none', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out =
      `refs/tags/v0.9.1\0commit\0${a}\0\0\0\n` +
      `refs/tags/v0.9.10\0commit\0${a}\0\0\0\n` +
      `refs/tags/v1.0.0\0tag\0${'c'.repeat(40)}\0commit\0${b}\0\n` +
      `refs/tags/v2.0.0\0tree\0${'d'.repeat(40)}\0\0\0\n` +
      `refs/tags/nightly\0commit\0${b}\0\0\0\n`;
    const { byCommit, names } = versionTagsOf(out);
    assert.deepEqual(byCommit.get(a), { major: 0, minor: 9, patch: 10 });
    assert.deepEqual(byCommit.get(b), { major: 1, minor: 0, patch: 0 });
    assert.equal(byCommit.size, 2);
    assert.deepEqual([...names.keys()].sort(), ['v0.9.1', 'v0.9.10', 'v1.0.0', 'v2.0.0']);
    assert.equal(names.get('v1.0.0'), b, 'the commit an annotated tag names');
    assert.equal(names.get('v2.0.0'), null, 'a tag of a tree names no commit');
  });

  test('versionName: the version, else the short id', () => {
    const id = 'c75af0e'.padEnd(40, '0');
    assert.equal(versionName('0.9.16', id), '0.9.16');
    assert.equal(versionName('0.9.16+2', id), '0.9.16+2');
    assert.equal(versionName(null, id), 'c75af0e');
  });
});
