// The launcher is exercised with fake "node" executables that print what they were given, so these
// tests check which binary is chosen and how it is called without depending on the machine's Node.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../bin/skydeck', import.meta.url));
const bootstrap = realpathSync(fileURLToPath(new URL('../bin/bootstrap.mjs', import.meta.url)));

interface Sandbox {
  home: string;
  bin: string;
  root: string;
  env: (extra?: Record<string, string>) => Record<string, string>;
}

/** The utilities the launcher itself needs, linked into the sandbox so PATH holds nothing else. */
const LAUNCHER_TOOLS = ['dirname', 'readlink'];

/**
 * A throwaway HOME and a PATH of one directory holding only the tools the launcher needs, so a
 * `node` on the machine can never be picked up by accident. Nothing else is inherited.
 */
function sandbox(t: TestContext): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skydeck-launcher-')));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  for (const tool of LAUNCHER_TOOLS) {
    const real = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((p) => existsSync(p));
    assert.ok(real, `${tool} not found on this machine`);
    symlinkSync(real, join(bin, tool));
  }
  return {
    home,
    bin,
    root,
    env: (extra = {}) => ({ PATH: bin, HOME: home, ...extra }),
  };
}

function writeFakeNode(path: string, name: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\necho "node=${name}"\necho "cache=$NODE_COMPILE_CACHE"\nfor a in "$@"; do echo "arg=$a"; done\n`,
  );
  chmodSync(path, 0o755);
}

interface Launched {
  status: number | null;
  stderr: string;
  node: string | undefined;
  cache: string | undefined;
  args: string[];
}

function launch(command: string, args: string[], env: Record<string, string>): Launched {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
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
  test('SKYDECK_NODE wins over the data-dir link and over node on PATH', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    writeFakeNode(join(s.root, 'elsewhere', 'node'), 'data-dir');
    mkdirSync(join(s.home, '.local/share/skydeck'), { recursive: true });
    symlinkSync(join(s.root, 'elsewhere', 'node'), join(s.home, '.local/share/skydeck/node'));
    writeFakeNode(join(s.root, 'explicit', 'my-node'), 'explicit');

    const r = launch(launcher, [], s.env({ SKYDECK_NODE: join(s.root, 'explicit', 'my-node') }));

    assert.equal(r.node, 'explicit');
  });

  test('$XDG_DATA_HOME/skydeck/node is used when SKYDECK_NODE is unset, ahead of node on PATH', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    writeFakeNode(join(s.root, 'pinned', 'node'), 'data-dir');
    const data = join(s.root, 'xdg-data');
    mkdirSync(join(data, 'skydeck'), { recursive: true });
    symlinkSync(join(s.root, 'pinned', 'node'), join(data, 'skydeck/node'));

    const r = launch(launcher, [], s.env({ XDG_DATA_HOME: data }));

    assert.equal(r.node, 'data-dir');
  });

  test('without XDG_DATA_HOME the link is looked up under $HOME/.local/share', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    writeFakeNode(join(s.root, 'pinned', 'node'), 'data-dir');
    mkdirSync(join(s.home, '.local/share/skydeck'), { recursive: true });
    symlinkSync(join(s.root, 'pinned', 'node'), join(s.home, '.local/share/skydeck/node'));

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'data-dir');
  });

  test('falls back to node on PATH when there is no link', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('falls back to node on PATH when the link is dangling', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.home, '.local/share/skydeck'), { recursive: true });
    symlinkSync(join(s.root, 'gone', 'node'), join(s.home, '.local/share/skydeck/node'));

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('says what is wrong and exits 127 when there is no node to run', (t) => {
    const s = sandbox(t);

    const r = launch(launcher, [], s.env({ SKYDECK_NODE: join(s.root, 'no-such-node') }));

    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot run '.*no-such-node'.*SKYDECK_NODE/);
  });

  test('says the same when node is missing from PATH', (t) => {
    const s = sandbox(t);

    const r = launch(launcher, [], s.env());

    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot run 'node'/);
  });
});

describe('bin/skydeck: how it calls node', () => {
  test('runs bootstrap.mjs with every argument passed through untouched', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, ['--flag', 'two words', '', '$HOME', '*'], s.env());

    assert.deepEqual(r.args, [bootstrap, '--flag', 'two words', '', '$HOME', '*']);
  });

  test('runs the real bootstrap.mjs when reached through a chain of symlinks', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.root, 'a'));
    mkdirSync(join(s.root, 'b'));
    symlinkSync(launcher, join(s.root, 'a', 'skydeck'));
    symlinkSync('../a/skydeck', join(s.root, 'b', 'skydeck')); // relative link to a link

    const r = launch(join(s.root, 'b', 'skydeck'), ['x'], s.env());

    assert.deepEqual(r.args, [bootstrap, 'x']);
  });

  test('NODE_COMPILE_CACHE defaults to $XDG_CACHE_HOME/skydeck/compile-cache', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ XDG_CACHE_HOME: '/xdg/cache' }));

    assert.equal(r.cache, '/xdg/cache/skydeck/compile-cache');
  });

  test('NODE_COMPILE_CACHE defaults to $HOME/.cache/skydeck/compile-cache without XDG_CACHE_HOME', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env());

    assert.equal(r.cache, join(s.home, '.cache/skydeck/compile-cache'));
  });

  test('an NODE_COMPILE_CACHE that is already set is left alone', (t) => {
    const s = sandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ NODE_COMPILE_CACHE: '/my/cache', XDG_CACHE_HOME: '/xdg/cache' }));

    assert.equal(r.cache, '/my/cache');
  });

  test('the exit code of node is the exit code of the launcher', (t) => {
    const s = sandbox(t);
    const failing = join(s.bin, 'node');
    writeFileSync(failing, '#!/bin/sh\nexit 7\n');
    chmodSync(failing, 0o755);

    const r = launch(launcher, [], s.env());

    assert.equal(r.status, 7);
  });
});
