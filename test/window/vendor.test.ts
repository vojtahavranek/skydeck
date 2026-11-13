import assert from 'node:assert/strict';
import { chmodSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { realPlatform } from '../../src/platform/real.ts';
import { readManifest, verifyVendored } from '../../src/window/vendor.ts';
import { sandbox } from '../helpers/sandbox.ts';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const { files } = realPlatform();

const XTERM = 'vendor/xterm/xterm/lib/xterm.mjs';
const SHA = 'a'.repeat(64);

/** A copy of the checkout's `vendor/` in a sandbox; returns the copy's app root. */
function copyOfVendor(t: TestContext): string {
  const root = sandbox(t).root;
  cpSync(join(checkout, 'vendor'), join(root, 'vendor'), { recursive: true });
  return root;
}

/** An app root in a sandbox whose `vendor/MANIFEST.json` is `text`. */
function withManifest(t: TestContext, text: string): string {
  const root = copyOfVendor(t);
  writeFileSync(join(root, 'vendor/MANIFEST.json'), text);
  return root;
}

const entry = (path: string): Record<string, string> => ({
  path,
  package: '@xterm/xterm',
  version: '6.0.0',
  sha256: SHA,
});

describe('readManifest', () => {
  test('the checkout: every vendored file, sorted by path, with its package and version', () => {
    const entries = readManifest(files, checkout);

    assert.ok(entries);
    const paths = entries.map((e) => e.path);
    assert.deepEqual(paths, [...paths].sort());
    const xterm = entries.find((e) => e.path === XTERM);
    assert.ok(xterm);
    assert.deepEqual(Object.keys(xterm), ['path', 'package', 'version', 'sha256']);
    assert.equal(xterm.package, '@xterm/xterm');
    assert.equal(xterm.version, '6.0.0');
    assert.ok(entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
  });

  test('keeps licenseFrom and licenseReason', () => {
    const entries = readManifest(files, checkout);

    const license = entries?.find((e) => e.path === 'vendor/xterm/headless/LICENSE');
    assert.equal(license?.licenseFrom, '@xterm/xterm');
    assert.match(license?.licenseReason ?? '', /no LICENSE in the package/);
  });

  test('no manifest → null', (t) => {
    const root = copyOfVendor(t);
    rmSync(join(root, 'vendor/MANIFEST.json'));

    assert.equal(readManifest(files, root), null);
  });

  const invalid: Array<[string, string]> = [
    ['not JSON', '{ files: '],
    ['an array', '[]'],
    ['a number', '5'],
    ['null', 'null'],
    ['no files array', '{"entries": []}'],
    [
      'an entry without sha256',
      JSON.stringify({ files: [{ ...entry(XTERM), sha256: undefined }] }),
    ],
    [
      'a sha256 that is not 64 hex',
      JSON.stringify({ files: [{ ...entry(XTERM), sha256: 'abc' }] }),
    ],
    ['a number for a version', JSON.stringify({ files: [{ ...entry(XTERM), version: 6 }] })],
    [
      'a licenseFrom that is not a string',
      JSON.stringify({ files: [{ ...entry(XTERM), licenseFrom: 1 }] }),
    ],
    ['a path outside vendor/xterm/', JSON.stringify({ files: [entry('bin/skydeck')] })],
    ['a path with ..', JSON.stringify({ files: [entry('vendor/xterm/../../bin/skydeck')] })],
    ['an absolute path', JSON.stringify({ files: [entry('/etc/passwd')] })],
    ['a path with an empty segment', JSON.stringify({ files: [entry('vendor/xterm//a.mjs')] })],
    ['a path with a backslash', JSON.stringify({ files: [entry('vendor/xterm/a\\..\\b')] })],
    ['a path with a newline', JSON.stringify({ files: [entry('vendor/xterm/a\nb.mjs')] })],
    ['a path with a . segment', JSON.stringify({ files: [entry('vendor/xterm/./a.mjs')] })],
    ['a path with NEL (U+0085)', JSON.stringify({ files: [entry('vendor/xterm/a\u0085b.mjs')] })],
    ['a path with CSI (U+009B)', JSON.stringify({ files: [entry('vendor/xterm/a\u009b2Jb.mjs')] })],
    ['a path with RLO (U+202E)', JSON.stringify({ files: [entry('vendor/xterm/a\u202eb.mjs')] })],
    ['a path with U+2028', JSON.stringify({ files: [entry('vendor/xterm/a\u2028b.mjs')] })],
    ['a path with a space', JSON.stringify({ files: [entry('vendor/xterm/a b.mjs')] })],
    ['the same path twice', JSON.stringify({ files: [entry(XTERM), entry(XTERM)] })],
  ];
  for (const [name, text] of invalid) {
    test(`${name} → null`, (t) => {
      assert.equal(readManifest(files, withManifest(t, text)), null);
    });
  }
});

describe('verifyVendored', () => {
  test('the checkout → []', () => {
    assert.deepEqual(verifyVendored(files, checkout), []);
  });

  test('a copy with one file changed → one line naming it', (t) => {
    const root = copyOfVendor(t);
    writeFileSync(join(root, XTERM), 'export const x = 1;\n');

    const problems = verifyVendored(files, root);

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes(XTERM), problems[0]);
  });

  test('a copy with one file removed → one line naming it', (t) => {
    const root = copyOfVendor(t);
    rmSync(join(root, 'vendor/xterm/addon-fit/LICENSE'));

    const problems = verifyVendored(files, root);

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('vendor/xterm/addon-fit/LICENSE'), problems[0]);
  });

  test('a directory where a file belongs → one line naming it', (t) => {
    const root = copyOfVendor(t);
    rmSync(join(root, XTERM));
    cpSync(join(root, 'vendor/xterm/xterm/css'), join(root, XTERM), { recursive: true });

    const problems = verifyVendored(files, root);

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes(XTERM), problems[0]);
  });

  test('two files changed → two lines', (t) => {
    const root = copyOfVendor(t);
    writeFileSync(join(root, XTERM), '');
    rmSync(join(root, 'vendor/xterm/xterm/css/xterm.css'));

    assert.equal(verifyVendored(files, root).length, 2);
  });

  test('no manifest → one line', (t) => {
    const root = copyOfVendor(t);
    rmSync(join(root, 'vendor/MANIFEST.json'));

    const problems = verifyVendored(files, root);

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('vendor/MANIFEST.json'), problems[0]);
  });

  test('no vendor/ at all → one line', (t) => {
    assert.equal(verifyVendored(files, sandbox(t).root).length, 1);
  });

  test('a manifest that is not valid → one line naming it', (t) => {
    const problems = verifyVendored(files, withManifest(t, '{ files: '));

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('vendor/MANIFEST.json'), problems[0]);
  });

  test('a manifest that lists no files → one line', (t) => {
    const problems = verifyVendored(files, withManifest(t, '{"files": []}'));

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('vendor/MANIFEST.json'), problems[0]);
  });

  test('a file it cannot read → one line naming it, no exception', (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root reads every file');
      return;
    }
    const root = copyOfVendor(t);
    chmodSync(join(root, XTERM), 0o000);

    const problems = verifyVendored(files, root);

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes(XTERM), problems[0]);
  });

  test('every line is a single line', (t) => {
    const root = copyOfVendor(t);
    writeFileSync(join(root, XTERM), '');
    rmSync(join(root, 'vendor/xterm/addon-fit/LICENSE'));

    for (const line of verifyVendored(files, root)) {
      assert.ok(!line.includes('\n'), line);
    }
  });
});
