// Which version tag the workflow Version makes (scripts/version-tag.ts, R-C of the plan): on real
// repositories in the sandbox, every rule — the start, the next patch, the next minor for a note
// added, a note changed or removed, several commits in one push, a commit tagged already, a tag
// made by hand, a bump by hand (also on a tagged head), and names that are not version tags — and
// the entry the workflow runs (scripts/next-version-tag.ts), on a repository of the sandbox.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bumpOf, nextVersionTag, START } from '../../scripts/version-tag.ts';
import type { Bump } from '../../scripts/version-tag.ts';
import { gitCheckout, insideSandbox } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const ENTRY = fileURLToPath(new URL('../../scripts/next-version-tag.ts', import.meta.url));
const IDENTITY = ['-c', 'user.name=skydeck test', '-c', 'user.email=test@skydeck.invalid'];
const note = (title: string): string => `# ${title}\n\nIt says so.\n`;

interface Repo {
  s: Sandbox;
  c: GitCheckout;
  /** The tag the script names for HEAD with `bump`. */
  next(bump?: Bump): Promise<string | null>;
  /** A plain commit (no note); its id. */
  plain(name: string): string;
  tag(name: string, rev?: string): void;
}

function repo(t: TestContext): Repo {
  const s = sandbox(t);
  const c = gitCheckout(s);
  return {
    s,
    c,
    next: (bump = '') => nextVersionTag(async (args) => c.git(c.root, ...args), 'HEAD', bump),
    plain: (name) => c.commit(c.root, name, { [`${name}.txt`]: `${name}\n` }),
    tag: (name, rev = 'HEAD') => {
      c.git(c.root, 'tag', name, rev);
    },
  };
}

describe("the tag a push makes (D1')", () => {
  test('no version tag on the history: the start, v0.9.0', async (t) => {
    const r = repo(t);
    r.plain('a');
    assert.equal(await r.next(), 'v0.9.0');
    assert.deepEqual(START, { major: 0, minor: 9, patch: 0 });
  });

  test('commits without a note: the next patch; the pushed commit tagged already: none', async (t) => {
    const r = repo(t);
    r.tag('v0.9.0');
    assert.equal(await r.next(), null, 'H carries a version tag');
    r.plain('a');
    assert.equal(await r.next(), 'v0.9.1');
    r.tag('v0.9.1');
    r.plain('b');
    r.plain('c');
    assert.equal(await r.next(), 'v0.9.2', 'several commits in one push: one tag, the next patch');
  });

  test('a note added in T..H: the next minor, patch 0; also when other commits come after it', async (t) => {
    const r = repo(t);
    r.tag('v0.9.4');
    r.c.commit(r.c.root, 'a note', { 'docs/news/2026-11-25-thing.md': note('A thing') });
    r.plain('after');
    assert.equal(await r.next(), 'v0.10.0');
  });

  test('a note changed or removed, a file of another name, a note in a folder below: no minor', async (t) => {
    const r = repo(t);
    r.c.commit(r.c.root, 'notes', {
      'docs/news/2026-11-20-old.md': note('Old'),
      'docs/news/2026-11-21-gone.md': note('Gone'),
    });
    r.tag('v0.9.0');
    r.c.commit(r.c.root, 'change one', { 'docs/news/2026-11-20-old.md': note('Old, changed') });
    r.c.commit(r.c.root, 'remove one', { 'docs/news/2026-11-21-gone.md': null });
    r.c.commit(r.c.root, 'not notes', {
      'docs/news/README.md': 'the format\n',
      'docs/news/drafts/2026-11-25-later.md': note('Later'),
      'docs/news/Not-A-Note.md': note('No'),
      'docs/2026-11-25-elsewhere.md': note('Elsewhere'),
    });
    assert.equal(await r.next(), 'v0.9.1');
  });

  test('a note added before T does not count; one added by a merge counts, compared with its first parent', async (t) => {
    const r = repo(t);
    r.c.commit(r.c.root, 'a note', { 'docs/news/2026-11-20-old.md': note('Old') });
    r.tag('v0.9.0');
    r.plain('a');
    assert.equal(await r.next(), 'v0.9.1');

    r.c.git(r.c.root, 'checkout', '--quiet', '-b', 'side');
    r.c.commit(r.c.root, 'a note on a branch', { 'docs/news/2026-11-25-side.md': note('Side') });
    r.c.git(r.c.root, 'checkout', '--quiet', 'main');
    r.c.git(r.c.root, ...IDENTITY, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'side');
    assert.equal(await r.next(), 'v0.10.0');
  });

  test('a tag made by hand is a version tag like any other: the script goes on from it', async (t) => {
    const r = repo(t);
    r.tag('v0.9.7');
    r.plain('a');
    r.tag('v1.0.0');
    r.plain('b');
    assert.equal(await r.next(), 'v1.0.1');
    r.c.git(r.c.root, ...IDENTITY, 'tag', '-a', '-m', 'annotated', 'v1.2.0');
    r.plain('c');
    assert.equal(await r.next(), 'v1.2.1', 'an annotated tag counts too');
  });

  test('names that are not version tags are none: v1.2, v01.2.3, version-1, v1.2.3-rc1, 1.2.3', async (t) => {
    const r = repo(t);
    r.tag('v0.9.3');
    r.plain('a');
    for (const name of ['v1.2', 'v01.2.3', 'version-1', 'v1.2.3-rc1', '1.2.3', 'v1.2.3.4']) {
      r.tag(name);
    }
    assert.equal(await r.next(), 'v0.9.4', 'H carries no version tag; T is v0.9.3');
  });

  test('several version tags on one commit: the highest counts', async (t) => {
    const r = repo(t);
    r.tag('v0.9.3');
    r.tag('v0.11.0');
    r.tag('v0.10.5');
    r.plain('a');
    assert.equal(await r.next(), 'v0.11.1');
  });

  test('only the first-parent history: a tag on a merged branch is not T', async (t) => {
    const r = repo(t);
    r.tag('v0.9.2');
    r.c.git(r.c.root, 'checkout', '--quiet', '-b', 'side');
    r.plain('side');
    r.tag('v5.0.0');
    r.c.git(r.c.root, 'checkout', '--quiet', 'main');
    r.plain('main');
    r.c.git(r.c.root, ...IDENTITY, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'side');
    assert.equal(await r.next(), 'v0.9.3');
  });

  test('the tag it would make exists already (on another commit): none, nothing moved', async (t) => {
    const r = repo(t);
    r.tag('v0.9.0');
    const a = r.plain('a');
    r.c.git(r.c.root, 'checkout', '--quiet', '-b', 'elsewhere');
    r.plain('x');
    r.tag('v0.9.1');
    r.c.git(r.c.root, 'checkout', '--quiet', 'main');
    assert.equal(r.c.id(), a);
    assert.equal(await r.next(), null);
  });
});

describe("a bump by hand (D1')", () => {
  test('minor and major from the nearest tag; also on a tagged head (the higher one counts); none at all: the start', async (t) => {
    const r = repo(t);
    assert.equal(await r.next('minor'), 'v0.9.0');
    assert.equal(await r.next('major'), 'v0.9.0');
    r.tag('v0.9.5');
    r.plain('a');
    assert.equal(await r.next('minor'), 'v0.10.0');
    assert.equal(await r.next('major'), 'v1.0.0');
    r.tag('v0.9.6');
    assert.equal(await r.next(), null, 'a push: tagged already');
    assert.equal(await r.next('minor'), 'v0.10.0', 'by hand on a tagged head');
    r.tag('v0.10.0');
    assert.equal(await r.next('minor'), 'v0.11.0', 'the higher of the head');
    assert.equal(await r.next('major'), 'v1.0.0');
  });

  test('bumpOf: empty, minor or major; anything else is none', () => {
    assert.equal(bumpOf(undefined), '');
    assert.equal(bumpOf(''), '');
    assert.equal(bumpOf('minor'), 'minor');
    assert.equal(bumpOf('major'), 'major');
    for (const text of ['patch', 'Minor', 'minor ', '$(id)', 'v1.0.0'])
      assert.equal(bumpOf(text), null);
  });
});

describe('the entry the workflow runs', () => {
  /** `node scripts/next-version-tag.ts` in the checkout, with BUMP. */
  function entry(c: GitCheckout, s: Sandbox, bump?: string) {
    const r = spawnSync(process.execPath, [ENTRY], {
      cwd: insideSandbox(s, c.root),
      env: { ...c.env, ...(bump === undefined ? {} : { BUMP: bump }) },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test('prints the tag and a line break; nothing for none; exit 2 for a bump that is not one; exit 1 out of a repository', (t) => {
    const s = sandbox(t);
    const c = gitCheckout(s);
    assert.deepEqual(entry(c, s), {
      status: 0,
      stdout: 'v0.9.0\n',
      stderr: '',
    });
    c.git(c.root, 'tag', 'v0.9.0');
    const none = entry(c, s);
    assert.equal(none.status, 0);
    assert.equal(none.stdout, '');
    assert.equal(entry(c, s, 'major').stdout, 'v1.0.0\n');
    const bad = entry(c, s, 'patch');
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');

    // Not a repository (git's search stops at the sandbox's root): a git that fails, exit 1.
    const plain = { ...c, root: join(s.root, 'plain') };
    mkdirSync(insideSandbox(s, plain.root));
    const outside = entry(plain, s);
    assert.equal(outside.status, 1);
    assert.equal(outside.stdout, '');
    assert.match(outside.stderr, /^next-version-tag: git /);
  });
});
