// Most tests use fake "node" executables that print what they were given, so they check which
// binary is chosen and how it is called without depending on the machine's Node. The last block
// runs the real thing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import pkg from '../../package.json' with { type: 'json' };
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const launcher = fileURLToPath(new URL('../../bin/skydeck', import.meta.url));
const bootstrap = realpathSync(fileURLToPath(new URL('../../bin/bootstrap.mjs', import.meta.url)));

/** A sandbox whose PATH holds only the programs the launcher itself uses. */
function launcherSandbox(t: TestContext): Sandbox {
  const s = sandbox(t);
  s.link('dirname', 'readlink', 'mktemp', 'cat', 'rm');
  // The launcher creates its handoff file in TMPDIR: keep it inside the sandbox.
  const tmp = join(s.root, 'tmp');
  mkdirSync(tmp);
  return { ...s, env: (extra) => s.env({ TMPDIR: tmp, ...extra }) };
}

function writeFakeNode(path: string, name: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\necho "node=${name}"\necho "cache=$NODE_COMPILE_CACHE"\nfor a in "$@"; do echo "arg=$a"; done\n`,
  );
  chmodSync(path, 0o755);
}

/** Makes `<dir>/node` a symlink to a fake node that reports itself as `name`. */
function pin(s: Sandbox, dir: string, name: string): void {
  const target = join(s.root, 'pinned', name, 'node');
  writeFakeNode(target, name);
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, join(dir, 'node'));
}

interface Launched {
  status: number | null;
  stderr: string;
  node: string | undefined;
  cache: string | undefined;
  args: string[];
}

function launch(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Launched {
  const result = spawnSync(command, args, { env, cwd, encoding: 'utf8' });
  const lines = result.stdout.split('\n');
  const field = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
  return {
    status: result.status,
    stderr: result.stderr,
    node: field('node'),
    cache: field('cache'),
    args: lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice('arg='.length)),
  };
}

describe('bin/skydeck: which node it runs', () => {
  test('SKYDECK_NODE wins over the pinned link and over node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.skydeckHome, 'data'), 'pinned');
    writeFakeNode(join(s.root, 'explicit', 'my-node'), 'explicit');

    const r = launch(launcher, [], s.env({ SKYDECK_NODE: join(s.root, 'explicit', 'my-node') }));

    assert.equal(r.node, 'explicit');
  });

  test('$SKYDECK_HOME/data/node is used when SKYDECK_NODE is unset, ahead of node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.skydeckHome, 'data'), 'pinned');

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'pinned');
  });

  test('SKYDECK_HOME replaces the XDG and HOME locations instead of adding to them', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const xdgData = join(s.root, 'xdg-data');
    pin(s, join(xdgData, 'skydeck'), 'xdg');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(launcher, [], s.env({ XDG_DATA_HOME: xdgData }));

    assert.equal(r.node, 'path');
  });

  test('an empty SKYDECK_HOME counts as unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const xdgData = join(s.root, 'xdg-data');
    pin(s, join(xdgData, 'skydeck'), 'xdg');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: '', XDG_DATA_HOME: xdgData }));

    assert.equal(r.node, 'xdg');
  });

  test('without SKYDECK_HOME, $XDG_DATA_HOME/skydeck/node is used ahead of node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const xdgData = join(s.root, 'xdg-data');
    pin(s, join(xdgData, 'skydeck'), 'xdg');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: undefined, XDG_DATA_HOME: xdgData }));

    assert.equal(r.node, 'xdg');
  });

  test('without SKYDECK_HOME and XDG_DATA_HOME the link is under $HOME/.local/share', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: undefined }));

    assert.equal(r.node, 'home');
  });

  test('a relative SKYDECK_HOME is ignored, as if it were unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    // Started from s.root, a relative SKYDECK_HOME would find this link, so it must be refused.
    pin(s, join(s.root, 'rel-home', 'data'), 'relative');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: 'rel-home' }), s.root);

    assert.equal(r.node, 'home');
  });

  test('a relative XDG_DATA_HOME is ignored, as if it were unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.root, 'rel-xdg', 'skydeck'), 'relative');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(
      launcher,
      [],
      s.env({ SKYDECK_HOME: undefined, XDG_DATA_HOME: 'rel-xdg' }),
      s.root,
    );

    assert.equal(r.node, 'home');
  });

  test('falls back to node on PATH when there is no link', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('falls back to node on PATH when the link is dangling', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.skydeckHome, 'data'));
    symlinkSync(join(s.root, 'gone', 'node'), join(s.skydeckHome, 'data', 'node'));

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('a link that points at a directory is skipped in favour of node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.skydeckHome, 'data'));
    symlinkSync(s.root, join(s.skydeckHome, 'data', 'node'));

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('says what is wrong and exits 127 when there is no node to run', (t) => {
    const s = launcherSandbox(t);

    const r = launch(launcher, [], s.env({ SKYDECK_NODE: join(s.root, 'no-such-node') }));

    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot run '.*no-such-node'.*SKYDECK_NODE/);
  });

  test('refuses a directory or a file that is not executable as SKYDECK_NODE', (t) => {
    const s = launcherSandbox(t);
    const notExecutable = join(s.root, 'not-executable');
    writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
    chmodSync(notExecutable, 0o644);

    for (const bad of [s.root, notExecutable]) {
      const r = launch(launcher, [], s.env({ SKYDECK_NODE: bad }));

      assert.equal(r.status, 127, bad);
      assert.match(r.stderr, /cannot run '.*'.*SKYDECK_NODE/, bad);
    }
  });

  test('says the same when node is missing from PATH', (t) => {
    const s = launcherSandbox(t);

    const r = launch(launcher, [], s.env());

    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot run 'node'/);
  });
});

describe('bin/skydeck: how it calls node', () => {
  test('runs bootstrap.mjs with every argument passed through untouched', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, ['--flag', 'two words', '', '$HOME', '*'], s.env());

    assert.deepEqual(r.args, [bootstrap, '--flag', 'two words', '', '$HOME', '*']);
  });

  test('runs the real bootstrap.mjs when reached through a chain of symlinks', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.root, 'a'));
    mkdirSync(join(s.root, 'b'));
    symlinkSync(launcher, join(s.root, 'a', 'skydeck'));
    symlinkSync('../a/skydeck', join(s.root, 'b', 'skydeck')); // relative link to a link

    const r = launch(join(s.root, 'b', 'skydeck'), ['x'], s.env());

    assert.deepEqual(r.args, [bootstrap, 'x']);
  });

  test('resolves its own location physically, through a symlinked directory', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    symlinkSync(dirname(launcher), join(s.root, 'linked-bin'));

    const r = launch(join(s.root, 'linked-bin', 'skydeck'), [], s.env());

    assert.deepEqual(r.args, [bootstrap]);
  });

  test('is not misled by CDPATH when started by a relative path', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const checkout = dirname(dirname(launcher));
    // With CDPATH=<s.root>, a plain `cd bin` would land in <s.root>/bin instead of <checkout>/bin.
    const r = launch('bin/skydeck', [], s.env({ CDPATH: s.root }), checkout);

    assert.deepEqual(r.args, [bootstrap]);
  });

  test('NODE_COMPILE_CACHE defaults to $XDG_CACHE_HOME/skydeck/compile-cache', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ XDG_CACHE_HOME: '/xdg/cache' }));

    assert.equal(r.cache, '/xdg/cache/skydeck/compile-cache');
  });

  test('NODE_COMPILE_CACHE defaults to $HOME/.cache/skydeck/compile-cache without XDG_CACHE_HOME', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env());

    assert.equal(r.cache, join(s.home, '.cache/skydeck/compile-cache'));
  });

  test('a relative XDG_CACHE_HOME is ignored', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ XDG_CACHE_HOME: 'rel-cache' }), s.root);

    assert.equal(r.cache, join(s.home, '.cache/skydeck/compile-cache'));
  });

  test('an empty NODE_COMPILE_CACHE counts as unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ NODE_COMPILE_CACHE: '' }));

    assert.equal(r.cache, join(s.home, '.cache/skydeck/compile-cache'));
  });

  test('a NODE_COMPILE_CACHE that is already set is left alone', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(
      launcher,
      [],
      s.env({ NODE_COMPILE_CACHE: '/my/cache', XDG_CACHE_HOME: '/xdg/cache' }),
    );

    assert.equal(r.cache, '/my/cache');
  });

  test('the exit code of node is the exit code of the launcher', (t) => {
    const s = launcherSandbox(t);
    const failing = join(s.bin, 'node');
    writeFileSync(failing, '#!/bin/sh\nexit 7\n');
    chmodSync(failing, 0o755);

    const r = launch(launcher, [], s.env());

    assert.equal(r.status, 7);
  });
});

describe('bin/skydeck with the real node', () => {
  function run(t: TestContext, args: string[]) {
    const s = launcherSandbox(t);
    return spawnSync(launcher, args, {
      encoding: 'utf8',
      env: s.env({ SKYDECK_NODE: process.execPath }),
    });
  }

  test('--version prints the package version and nothing on stderr', (t) => {
    const r = run(t, ['--version']);

    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${pkg.version}\n`);
    assert.equal(r.stderr, '');
  });

  test('an unknown command prints the usage on stderr and exits 2', (t) => {
    const r = run(t, ['frobnicate']);

    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage:/m);
  });
});
