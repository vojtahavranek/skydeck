// The workflow Version (.github/workflows/version.yml; design-step-2.md 17.5) writes tags to the
// public repository, so what makes it safe is held here, on the file as text (no YAML library: the
// repository has no runtime dependency, and the checks read lines): only its two triggers; the
// permission `contents: write` alone; one queue that cancels nothing; the same runner, actions and
// Node as ci.yml pins them, and no other action, cache or secret; no `${{ }}` in a `run:` line; the
// tag made and pushed by name only, never forced or deleted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const VERSION = readFileSync(new URL('../.github/workflows/version.yml', import.meta.url), 'utf8');
const CI = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** The lines that are not comments (a whole-line comment, or the comment after a value). */
function code(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .filter((line) => line.trim() !== '');
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The lines under the key `key` that starts a line at `indent` (the block's body, as written). */
function block(lines: readonly string[], key: string, indent = 0): string[] {
  const start = lines.findIndex(
    (line) => indentOf(line) === indent && line.trimStart().startsWith(`${key}:`),
  );
  assert.ok(start >= 0, `${key}: is in the file`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (indentOf(line) <= indent) break;
    body.push(line);
  }
  return body;
}

/** The keys a block holds right under it. */
function keys(body: readonly string[]): string[] {
  const indent = Math.min(...body.map(indentOf));
  return body
    .filter((line) => indentOf(line) === indent)
    .map((line) => line.trim().replace(/:.*$/, ''));
}

/** Every `run:` of the file: its one line, or the lines of its block. */
function runs(text: string): string[][] {
  const lines = text.split('\n');
  const found: string[][] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (m === null) return;
    const indent = (m[1] ?? '').length;
    const rest = m[2] ?? '';
    if (rest !== '|' && rest !== '>') {
      found.push([rest]);
      return;
    }
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() !== '' && indentOf(next) <= indent) break;
      body.push(next.trim());
    }
    found.push(body.filter((entry) => entry !== ''));
  });
  return found;
}

/** The actions a file uses, as written after `uses:` (with the pinned version's comment). */
function uses(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^\s*-?\s*uses:\s*(.*)$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
}

describe("the workflow Version (D4')", () => {
  const lines = code(VERSION);

  test('its name, and only its two triggers: a push to main and a run by hand with `bump` (minor or major)', () => {
    assert.match(VERSION, /^name: Version$/m);
    const on = block(lines, 'on');
    assert.deepEqual(keys(on), ['push', 'workflow_dispatch']);
    assert.deepEqual(
      block(on, 'push', 2).map((line) => line.trim()),
      ['branches: [main]'],
    );
    const dispatch = block(on, 'workflow_dispatch', 2);
    assert.deepEqual(keys(dispatch), ['inputs']);
    const inputs = block(dispatch, 'inputs', 4);
    assert.deepEqual(keys(inputs), ['bump']);
    const bump = block(inputs, 'bump', 6).map((line) => line.trim());
    assert.ok(bump.includes('type: choice'));
    assert.ok(bump.includes('options: [minor, major]'));
    for (const forbidden of ['pull_request', 'pull_request_target', 'workflow_run', 'schedule']) {
      assert.ok(!lines.some((line) => line.includes(forbidden)), forbidden);
    }
  });

  test('permissions: `contents: write` and no other, at the top only; no secret but the job’s own token; no cache', () => {
    assert.deepEqual(
      block(lines, 'permissions').map((line) => line.trim()),
      ['contents: write'],
    );
    assert.equal(lines.filter((line) => /^\s*permissions:/.test(line)).length, 1);
    assert.ok(!VERSION.includes('secrets.'), 'no secret');
    assert.ok(!lines.some((line) => /^\s*cache:/.test(line)), 'no cache');
    assert.ok(!lines.some((line) => /token:/.test(line)), 'no token given to a step');
  });

  test('one queue of its own that cancels nothing', () => {
    assert.deepEqual(
      block(lines, 'concurrency').map((line) => line.trim()),
      ['group: version', 'cancel-in-progress: false'],
    );
  });

  test('the runner, the actions and Node as ci.yml pins them: checkout (the whole history and the tags) and setup-node, by full commit id; no other action', () => {
    const own = uses(VERSION);
    assert.equal(own.length, 2);
    const ci = new Set(uses(CI));
    for (const action of own) {
      assert.match(action, /^actions\/(checkout|setup-node)@[0-9a-f]{40} # v[0-9.]+$/);
      assert.ok(ci.has(action), `${action} is pinned as ci.yml pins it`);
    }
    assert.match(own[0] ?? '', /^actions\/checkout@/);
    assert.match(own[1] ?? '', /^actions\/setup-node@/);
    assert.match(
      VERSION,
      /^ {6}- uses: actions\/checkout@.*\n {8}with:\n {10}fetch-depth: 0\n {10}fetch-tags: true\n/m,
    );
    assert.match(VERSION, /^ {10}node-version: '24'$/m);
    assert.match(CI, /^ {10}node-version: '24'$/m);
    assert.match(VERSION, /^ {4}runs-on: ubuntu-24\.04$/m);
    assert.match(CI, /^ {4}runs-on: ubuntu-24\.04$/m);
    assert.match(VERSION, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m, 'by hand: on main only');
  });

  test('no `${{ }}` in a `run:` line: the input and the tag reach them through `env:`', () => {
    const all = runs(VERSION);
    assert.equal(all.length, 2);
    for (const body of all) {
      for (const line of body) assert.ok(!line.includes('${{'), line);
    }
    assert.match(VERSION, /^ {10}BUMP: \$\{\{ inputs\.bump \}\}$/m);
    assert.match(VERSION, /^ {10}TAG: \$\{\{ steps\.next\.outputs\.tag \}\}$/m);
    assert.deepEqual(all[0], [
      'tag="$(node scripts/next-version-tag.ts)"',
      'echo "tag=$tag" >> "$GITHUB_OUTPUT"',
    ]);
  });

  test('a tag is only created and pushed by its name: never forced, never deleted, no branch written', () => {
    const all = runs(VERSION);
    assert.deepEqual(all[1], ['git tag "$TAG" HEAD', 'git push origin "refs/tags/$TAG"']);
    for (const forbidden of [
      '--force',
      ' -f',
      '--delete',
      ' -d',
      '--mirror',
      '--all',
      '--tags',
      '+refs',
      ':refs',
      'refs/heads',
    ]) {
      const inRuns = all.flat().some((line) => line.includes(forbidden));
      assert.ok(!inRuns, `${forbidden} in a run line`);
    }
    assert.ok(
      !/git (?!tag "\$TAG" HEAD$|push origin "refs\/tags\/\$TAG"$)/m.test(all.flat().join('\n')),
    );
    assert.match(
      VERSION,
      /^ {8}if: steps\.next\.outputs\.tag != ''$/m,
      'no tag named: nothing pushed',
    );
  });
});

describe('the reading of the file finds what it holds', () => {
  test('a `${{ }}` in a run block, and a forced push, are seen', () => {
    const bad = [
      'jobs:',
      '  tag:',
      '    steps:',
      '      - run: echo ${{ github.event.head_commit.message }}',
      '      - name: push',
      '        run: |',
      '          git tag "$TAG" HEAD',
      '          git push --force origin "refs/tags/$TAG"',
    ].join('\n');
    assert.deepEqual(runs(bad), [
      ['echo ${{ github.event.head_commit.message }}'],
      ['git tag "$TAG" HEAD', 'git push --force origin "refs/tags/$TAG"'],
    ]);
  });
});
