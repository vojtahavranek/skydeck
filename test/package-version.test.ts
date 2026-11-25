// The version written in package.json is not skydeck's (design.md 8, the version line): a version
// is a git tag made by the workflow Version. package.json says 0.0.0, as the lock file does, and
// nothing shown reads it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import pkg from '../package.json' with { type: 'json' };
import lock from '../package-lock.json' with { type: 'json' };

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test("package.json's version is 0.0.0, as the lock file says", () => {
  assert.equal(pkg.version, '0.0.0');
  assert.equal(lock.version, '0.0.0');
  assert.equal(lock.packages[''].version, '0.0.0');
});

// The one reader left: the window's welcome message carries it as a field (protocol.ts's
// WelcomeMessage.version), which no page reads or shows.
test("no module of the product or the page reads package.json's version but the welcome's unused field", () => {
  const files = ['src', 'web', 'bin'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true })
      .map(String)
      .filter((path) => /\.(ts|js|mjs)$/.test(path))
      .map((path) => join(dir, path)),
  );
  const readers = files.filter((path) => {
    const text = readFileSync(join(ROOT, path), 'utf8');
    return /package\.json['"] with/.test(text) && /\bpkg\.version\b|\.version\b/.test(text);
  });
  assert.deepEqual(readers, ['src/window/server.ts']);
  const page = readdirSync(join(ROOT, 'web'), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith('.js'))
    .map((path) => readFileSync(join(ROOT, 'web', path), 'utf8'));
  assert.ok(!page.some((text) => /welcome\??\.version|\.version\b.*welcome/.test(text)));
});
