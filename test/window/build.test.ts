import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeBuild, readBuild } from '../../src/window/build.ts';
import { testPlatform } from '../helpers/platform.ts';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

/** Writes `text` at `path` under `root`, creating the directories on the way. */
function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** An app root in the sandbox with a few files in every directory the build covers, and outside. */
function fixture(t: TestContext): { root: string; build: () => string } {
  const { platform, sandbox } = testPlatform(t);
  const root = join(sandbox.root, 'app');
  put(root, 'bin/skydeck', '#!/bin/sh\n');
  put(root, 'bin/skydeck-keeper', 'print("keeper")\n');
  put(root, 'src/window/server.ts', 'export const a = 1;\n');
  put(root, 'web/index.html', '<!doctype html>\n');
  put(root, 'web/app.js', 'export {};\n');
  put(root, 'vendor/MANIFEST.json', '{"files":[]}\n');
  put(root, 'vendor/xterm/xterm/lib/xterm.mjs', 'export class Terminal {}\n');
  put(root, 'docs/design.md', '# design\n');
  put(root, 'test/a.test.ts', '\n');
  put(root, 'README.md', '# skydeck\n');
  return { root, build: () => computeBuild(platform.files, root) };
}

test('computeBuild: 16 lowercase hex characters, the same for the same tree', (t) => {
  const { build } = fixture(t);

  const first = build();

  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(build(), first);
});

test('computeBuild: two app roots with the same files give the same build', (t) => {
  const a = fixture(t);
  const b = fixture(t);

  assert.equal(a.build(), b.build());
});

for (const path of [
  'bin/skydeck-keeper',
  'src/window/server.ts',
  'web/app.js',
  'vendor/xterm/xterm/lib/xterm.mjs',
]) {
  test(`computeBuild changes when ${path} changes`, (t) => {
    const { root, build } = fixture(t);
    const before = build();

    put(root, path, 'changed\n');

    assert.notEqual(build(), before);
  });

  test(`computeBuild changes when ${path} is removed`, (t) => {
    const { root, build } = fixture(t);
    const before = build();

    rmSync(join(root, path));

    assert.notEqual(build(), before);
  });
}

for (const path of ['bin/new', 'src/new/deep/file.ts', 'web/new.css', 'vendor/xterm/new.mjs']) {
  test(`computeBuild changes when ${path} is added`, (t) => {
    const { root, build } = fixture(t);
    const before = build();

    put(root, path, 'new\n');

    assert.notEqual(build(), before);
  });
}

test('computeBuild changes when a file is renamed, its content kept', (t) => {
  const { root, build } = fixture(t);
  const before = build();

  renameSync(join(root, 'web/app.js'), join(root, 'web/app2.js'));

  assert.notEqual(build(), before);
});

test('computeBuild: moving a byte from a name into the content changes the build', (t) => {
  const a = fixture(t);
  const b = fixture(t);
  put(a.root, 'web/ab', 'c');
  put(b.root, 'web/a', 'bc');

  assert.notEqual(a.build(), b.build());
});

test('computeBuild: two files are not the same as one file holding both', (t) => {
  const a = fixture(t);
  const b = fixture(t);
  put(a.root, 'web/x', 'one');
  put(a.root, 'web/y', 'two');
  put(b.root, 'web/x', 'oneweb/y\u0000two'); // the same bytes, were the lengths not hashed

  assert.notEqual(a.build(), b.build());
});

for (const path of [
  'docs/design.md',
  'docs/new.md',
  'test/a.test.ts',
  'test/new.test.ts',
  'README.md',
  'package.json',
  'bin/__pycache__/skydeck-keeper.cpython-312.pyc',
  'src/x/__pycache__/m.pyc',
  'bin/.skydeck.swp',
  'web/.eslintrc',
  'src/.DS_Store',
  'vendor/.cache/anything.mjs',
  '.git/HEAD',
]) {
  test(`computeBuild does not change for ${path}`, (t) => {
    const { root, build } = fixture(t);
    const before = build();

    put(root, path, 'whatever\n');

    assert.equal(build(), before);
  });
}

test('computeBuild does not change for an empty directory', (t) => {
  const { root, build } = fixture(t);
  const before = build();

  mkdirSync(join(root, 'web/empty'));

  assert.equal(build(), before);
});

test('computeBuild: a missing directory is no error', (t) => {
  const { root, build } = fixture(t);
  rmSync(join(root, 'web'), { recursive: true });

  assert.match(build(), /^[0-9a-f]{16}$/);
});

test('computeBuild follows a link to a file, by the link name and the target content', (t) => {
  const { root, build } = fixture(t);
  put(root, 'shared/lib.js', 'one\n');
  symlinkSync(join(root, 'shared/lib.js'), join(root, 'web/lib.js'));
  const before = build();

  put(root, 'shared/lib.js', 'two\n');

  assert.notEqual(build(), before);
});

test('computeBuild follows a linked directory and stops at a link loop', (t) => {
  const plain = fixture(t);
  const linked = fixture(t);
  rmSync(join(linked.root, 'web'), { recursive: true });
  put(linked.root, 'elsewhere/web/index.html', '<!doctype html>\n');
  put(linked.root, 'elsewhere/web/app.js', 'export {};\n');
  symlinkSync(join(linked.root, 'elsewhere/web'), join(linked.root, 'web'));
  symlinkSync('.', join(linked.root, 'elsewhere/web/loop')); // web/loop is web itself

  assert.equal(linked.build(), plain.build());
});

test('computeBuild skips a dangling link', (t) => {
  const { root, build } = fixture(t);
  const before = build();

  symlinkSync(join(root, 'nowhere'), join(root, 'web/dangling.js'));

  assert.equal(build(), before);
});

test('readBuild: the files read, by path relative to the app root, and the same build', (t) => {
  const { platform } = testPlatform(t);
  const { root, build } = fixture(t);

  const read = readBuild(platform.files, root);

  assert.equal(read.build, build());
  assert.deepEqual(
    [...read.files.keys()],
    [
      'bin/skydeck',
      'bin/skydeck-keeper',
      'src/window/server.ts',
      'vendor/MANIFEST.json',
      'vendor/xterm/xterm/lib/xterm.mjs',
      'web/app.js',
      'web/index.html',
    ],
  );
  assert.equal(Buffer.from(read.files.get('web/app.js') ?? []).toString(), 'export {};\n');
});

test('computeBuild of this checkout', (t) => {
  const { platform } = testPlatform(t);

  assert.match(computeBuild(platform.files, checkout), /^[0-9a-f]{16}$/);
});
