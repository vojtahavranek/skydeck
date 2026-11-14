// `skydeck uninstall --purge` and step 1's three directories (docs/design.md 8, 9.1; principle 6):
// from the data, state and configuration directories it removes only what skydeck writes there,
// each entry of its kind, then the directory; a directory that is a symbolic link, another user's,
// cannot be looked at or holds anything else is left alone, the others are still purged, and the
// command ends with a truthful line and exit 1. A SKYDECK_HOME or XDG_* variable that is set but
// ignored (empty, relative) refuses the purge before anything is undone. Sandbox only.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { settingsPath } from '../../../src/claude/settings.ts';
import { storeId } from '../../../src/platform/paths.ts';
import type { Files, Platform } from '../../../src/platform/types.ts';
import { claudeFolders, run } from '../../helpers/install.ts';
import type { Run } from '../../helpers/install.ts';
import { T0, testPlatform } from '../../helpers/platform.ts';
import type { TestPlatform, TestPlatformOptions } from '../../helpers/platform.ts';
import type { Sandbox } from '../../helpers/sandbox.ts';
import { spoolName } from '../../helpers/spool.ts';

const isRoot = process.getuid?.() === 0; // root reads anything, so a mode proves nothing

/** An installation (install answered y) on a test platform with `options`. */
async function installed(t: TestContext, options: TestPlatformOptions = {}): Promise<TestPlatform> {
  const d = testPlatform(t, options);
  claudeFolders(d.places);
  const r = await run(d.platform, ['install'], { lines: ['y'] });
  assert.equal(r.code, 0, r.stderr);
  return d;
}

/**
 * Everything skydeck itself writes into the three directories, beside what install made: config,
 * spool files and their temporaries, a file in spool/bad, a note, the logs and their rotations,
 * the temporaries of their writers, and a runtime directory under the state directory.
 */
function everythingSkydeckWrites(d: TestPlatform): void {
  const { places } = d;
  writeFileSync(places.configPath, '{}\n');
  const ev = spoolName({ timeNs: T0, pid: 4242 } as Parameters<typeof spoolName>[0], 7);
  writeFileSync(join(places.spoolDir, ev), 'v=1\n');
  writeFileSync(join(places.spoolDir, `.${ev}.tmp`), 'v=1\n');
  mkdirSync(places.badDir, { recursive: true });
  writeFileSync(join(places.badDir, spoolName({ timeNs: T0 - 1n, pid: 1 } as never, 2)), 'x');
  writeFileSync(places.hookLog, 'a line\n');
  const note = `note-0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d.md`;
  writeFileSync(join(places.stateDir, note), 'my note');
  writeFileSync(join(places.stateDir, `.${note}.0123456789ab.tmp`), '');
  for (const name of [
    'server.log',
    'server.log.1',
    'keepers.log',
    'keepers.log.1',
    '.server.log.1.tmp',
    '.keepers.log.1.tmp',
  ]) {
    writeFileSync(join(places.stateDir, name), '');
  }
  const runtimeDir = join(places.stateDir, `run-${storeId(places.dbPath)}`);
  mkdirSync(join(runtimeDir, 'terms'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeDir, 'server.json'), '{}');
}

const purge = (platform: Platform): Promise<Run> => run(platform, ['uninstall', '--purge']);

/** Every path below `dir` with its kind and size, sorted: what a test compares before and after. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const info = lstatSync(path);
      return `${path} ${info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : info.size}`;
    })
    .sort();
}

const dirsOf = (d: TestPlatform): string[] => [
  d.places.dataDir,
  d.places.stateDir,
  d.places.configDir,
];

function still(path: string): void {
  assert.ok(existsSync(path), `${path} is still there`);
}

function gone(path: string): void {
  assert.equal(existsSync(path), false, `${path} is gone`);
}

// ---------------------------------------------------------------------------------------------
// The plain case

describe('uninstall --purge: only what skydeck writes', () => {
  test('every entry skydeck writes, in all three directories: all three removed, exit 0', async (t) => {
    const d = await installed(t);
    everythingSkydeckWrites(d);

    const r = await purge(d.platform);

    assert.equal(r.code, 0, r.stderr);
    for (const dir of dirsOf(d)) {
      gone(dir);
      assert.ok(r.stdout.includes(`removed ${dir}\n`), r.stdout);
    }
  });

  test('a directory that is not there is no error', async (t) => {
    const d = await installed(t);

    const r = await purge(d.platform);

    assert.equal(r.code, 0, r.stderr);
    for (const dir of dirsOf(d)) gone(dir);
  });
});

// ---------------------------------------------------------------------------------------------
// Left alone: a foreign entry, the wrong kind, a link, another user's, one that cannot be looked at

describe('uninstall --purge: a directory that is not only skydeck’s is left alone', () => {
  const which = ['dataDir', 'stateDir', 'configDir'] as const;

  for (const name of which) {
    test(`a foreign file in ${name}: left alone and named, the other two purged, exit 1`, async (t) => {
      const d = await installed(t);
      everythingSkydeckWrites(d);
      const dir = d.places[name];
      writeFileSync(join(dir, 'notes.txt'), 'mine');

      const r = await purge(d.platform);

      assert.equal(r.code, 1, r.stdout);
      assert.match(
        r.stderr,
        new RegExp(
          `^skydeck: skydeck is uninstalled, but --purge did not remove ${dir}: it holds notes\\.txt, which skydeck did not write`,
        ),
      );
      assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
      for (const other of dirsOf(d).filter((o) => o !== dir)) gone(other);
      // Left alone means untouched: skydeck's own entries in it stay too.
      if (name === 'configDir') still(d.places.configPath);
      if (name === 'stateDir') still(d.places.spoolDir);
      if (name === 'dataDir') still(d.places.dbPath);
      // The uninstall itself is done: the settings file install made is gone again.
      gone(settingsPath(d.places.claudeHome));
    });
  }

  test('a foreign entry deeper down (spool/, spool/bad/, locks/, the runtime directory) is named by its path', async (t) => {
    for (const [where, rel] of [
      ['spool', 'spool/mine.txt'],
      ['spool/bad', 'spool/bad/mine.txt'],
      ['locks', 'locks/mine.txt'],
    ] as const) {
      const d = await installed(t);
      everythingSkydeckWrites(d);
      writeFileSync(join(d.places.stateDir, where, 'mine.txt'), 'mine');

      const r = await purge(d.platform);

      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stderr.includes(`it holds ${rel}, which skydeck did not write`), r.stderr);
      still(join(d.places.stateDir, rel));
    }
    const d = await installed(t);
    everythingSkydeckWrites(d);
    const runDir = `run-${storeId(d.places.dbPath)}`;
    writeFileSync(join(d.places.stateDir, runDir, 'mine.txt'), 'mine');
    const r = await purge(d.platform);
    assert.equal(r.code, 1);
    assert.ok(
      r.stderr.includes(`it holds ${runDir}/mine.txt, which skydeck did not write`),
      r.stderr,
    );
  });

  test('an entry of the wrong kind is not skydeck’s: left alone', async (t) => {
    // Never write at a link's path: the write would go through to what it points at.
    for (const make of [
      (d: TestPlatform) => {
        unlinkSync(d.places.hookPath); // the link, never what it points to (the checkout's hook)
        mkdirSync(d.places.hookPath); // a directory where skydeck keeps a link
      },
      (d: TestPlatform) => {
        if (existsSync(d.places.hookLog)) unlinkSync(d.places.hookLog);
        symlinkSync(join(d.sandbox.root, 'nowhere'), d.places.hookLog);
      },
      (d: TestPlatform) => mkdirSync(join(d.places.configDir, '.config.json.0123456789ab.tmp')),
      (d: TestPlatform) => {
        unlinkSync(d.places.nodeLink); // the link, never what it points to (node itself)
        mkdirSync(d.places.nodeLink); // a directory where skydeck keeps a link
      },
    ]) {
      const d = await installed(t);
      make(d);

      const r = await purge(d.platform);

      assert.equal(r.code, 1, `${make.toString()}\n${r.stdout}`);
      assert.match(r.stderr, /did not remove .*: it holds .*, which skydeck did not write/);
    }
  });

  test('a foreign file whose name looks like skydeck’s but is not its shape is left alone', async (t) => {
    for (const name of [
      'skydeck.db.bak',
      'note-x.md',
      '.note-x.md.swp',
      'hook.log.1',
      'config.json~',
    ]) {
      const d = await installed(t);
      const dir = name.startsWith('config')
        ? d.places.configDir
        : name.startsWith('skydeck')
          ? d.places.dataDir
          : d.places.stateDir;
      writeFileSync(join(dir, name), 'mine');

      const r = await purge(d.platform);

      assert.equal(r.code, 1, `${name}: ${r.stdout}`);
      assert.ok(r.stderr.includes(`it holds ${name}, which skydeck did not write`), r.stderr);
      still(join(dir, name));
    }
  });

  test('a directory that is a symbolic link is never followed: left alone, its target intact', async (t) => {
    const d = testPlatform(t, { env: (s) => ({ SKYDECK_HOME: `${s.skydeckHome}/` }) });
    claudeFolders(d.places);
    const target = join(d.sandbox.root, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, d.places.dataDir); // install puts the database there, through the link
    assert.equal((await run(d.platform, ['install'], { lines: ['y'] })).code, 0);

    const r = await purge(d.platform);

    assert.equal(r.code, 1, r.stdout);
    assert.ok(
      r.stderr.includes(`did not remove ${d.places.dataDir}: it is a symbolic link`),
      r.stderr,
    );
    still(join(target, 'skydeck.db'));
    assert.ok(lstatSync(d.places.dataDir).isSymbolicLink());
    gone(d.places.stateDir);
  });

  test('another user’s directory: left alone and named', async (t) => {
    const d = await installed(t);
    const files: Files = {
      ...d.platform.files,
      lstat(path) {
        const info = d.platform.files.lstat(path);
        return path === d.places.stateDir && info !== null ? { ...info, uid: info.uid + 1 } : info;
      },
    };

    const r = await purge({ ...d.platform, files });

    assert.equal(r.code, 1, r.stdout);
    assert.ok(
      r.stderr.includes(
        `did not remove ${d.places.stateDir}: it belongs to uid ${d.platform.uid + 1}`,
      ),
      r.stderr,
    );
    still(d.places.stateDir);
    gone(d.places.dataDir);
  });

  test('a directory that cannot be looked at: left alone, the others purged, never an internal error', async (t) => {
    if (isRoot) return t.skip('root reads anything');
    const d = await installed(t);
    writeFileSync(d.places.configPath, '{}');
    chmodSync(d.places.configDir, 0o300);
    try {
      const r = await purge(d.platform);

      assert.equal(r.code, 1, r.stdout);
      assert.ok(
        r.stderr.includes(`did not remove ${d.places.configDir}: it cannot be looked at (EACCES)`),
        r.stderr,
      );
      assert.doesNotMatch(r.stderr, /internal error/);
      gone(d.places.dataDir);
      gone(d.places.stateDir);
    } finally {
      chmodSync(d.places.configDir, 0o700);
    }
    still(d.places.configPath);
  });

  test('several left alone: one line names each', async (t) => {
    const d = await installed(t);
    writeFileSync(join(d.places.dataDir, 'a.txt'), '');
    writeFileSync(join(d.places.stateDir, 'b.txt'), '');

    const r = await purge(d.platform);

    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`${d.places.dataDir}: it holds a.txt`), r.stderr);
    assert.ok(r.stderr.includes(`${d.places.stateDir}: it holds b.txt`), r.stderr);
    gone(d.places.configDir);
  });
});

// ---------------------------------------------------------------------------------------------
// SKYDECK_HOME that is the user's own place

describe('uninstall --purge with SKYDECK_HOME at the user’s own places', () => {
  /** The user's own files around and inside the places skydeck would use. */
  function usersOwn(base: string): string[] {
    const own = [
      join(base, '.bashrc'),
      join(base, 'projects', 'x.txt'),
      join(base, 'run', 'mine.txt'),
    ];
    for (const path of own) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'mine');
    }
    return own;
  }

  test('SKYDECK_HOME = the stand-in for the home directory: nothing of the user’s is removed', async (t) => {
    const d = await installed(t, { env: (s) => ({ SKYDECK_HOME: s.home }) });
    const own = usersOwn(d.sandbox.home);
    writeFileSync(join(d.places.dataDir, 'my-data.csv'), 'mine'); // the user's own `data` folder

    const r = await purge(d.platform);

    assert.equal(r.code, 1, r.stdout);
    for (const path of [...own, join(d.places.dataDir, 'my-data.csv')]) still(path);
    assert.ok(
      r.stderr.includes(`${d.places.dataDir}: it holds my-data.csv, which skydeck did not write`),
      r.stderr,
    );
    assert.ok(
      r.stderr.includes(
        `${join(d.sandbox.home, 'run')}: it holds mine.txt, which skydeck did not write`,
      ),
      r.stderr,
    );
  });

  test('SKYDECK_HOME = the stand-in for / (the sandbox root): nothing of the user’s is removed', async (t) => {
    const d = await installed(t, { env: (s) => ({ SKYDECK_HOME: s.root }) });
    const own = usersOwn(d.sandbox.root);
    const before = readdirSync(d.sandbox.root).sort();

    const r = await purge(d.platform);

    for (const path of own) still(path);
    for (const name of ['home', 'skydeck-home', 'claude-home', 'bin'])
      still(join(d.sandbox.root, name));
    assert.equal(r.code, 1, r.stdout);
    assert.ok(
      r.stderr.includes(`did not remove ${join(d.sandbox.root, 'run')}: it holds`),
      r.stderr,
    );
    const after = readdirSync(d.sandbox.root).sort();
    assert.deepEqual(
      after,
      before.filter((name) => !['data', 'state', 'config'].includes(name)),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// A variable that is set but ignored (D26)

describe('uninstall --purge refuses on a HOME, SKYDECK_HOME or XDG_* that is set but empty or relative', () => {
  const VARIABLES = [
    'HOME', // ruled (review 2): os.homedir() gives HOME as it is, '' or relative too
    'SKYDECK_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
  ] as const;

  /** A real-looking installation: no SKYDECK_HOME, so the places are under the stand-in home. */
  async function realLooking(t: TestContext): Promise<TestPlatform> {
    return installed(t, { env: { SKYDECK_HOME: undefined } });
  }

  function intact(d: TestPlatform): void {
    assert.match(readFileSync(settingsPath(d.places.claudeHome), 'utf8'), /skydeck-hook/);
    still(d.places.dbPath);
    still(d.places.hookPath);
    for (const dir of dirsOf(d)) still(dir);
  }

  for (const name of VARIABLES) {
    for (const value of ['', 'sandbox/relative']) {
      test(`${name}=${JSON.stringify(value)}: --purge refuses, nothing changes; a plain uninstall works`, async (t) => {
        const d = await realLooking(t);
        assert.ok(d.places.dataDir.startsWith(join(d.sandbox.home, '.local')), d.places.dataDir);
        const platform = { ...d.platform, env: { ...d.platform.env, [name]: value } };
        const before = tree(d.sandbox.root);

        const r = await purge(platform);

        assert.equal(r.code, 1, r.stdout);
        assert.equal(r.stdout, '');
        // Nothing changed anywhere: the sandbox, its home (the working directory) included.
        assert.deepEqual(tree(d.sandbox.root), before);
        const shown = `${name} is set to ${JSON.stringify(value)}`;
        const why = value === '' ? 'empty' : 'not an absolute path';
        // HOME is not ignored but taken as it is (os.homedir()): its own clause says so.
        const clause =
          name === 'HOME'
            ? `${shown} (${why}), which skydeck takes as it is, so every place would be relative to the working directory`
            : `${shown} but ignored (${why}), so skydeck would find the installation it finds without it`;
        assert.ok(
          r.stderr.startsWith(`skydeck: uninstall --purge removed nothing: ${clause}; `),
          r.stderr,
        );
        assert.match(r.stderr, /it does not purge the installation it would then find/);
        intact(d);

        const plain = await run(platform, ['uninstall']);

        assert.equal(plain.code, 0, plain.stderr);
        gone(settingsPath(d.places.claudeHome)); // install made it, so uninstall removes it
        gone(d.places.hookPath);
        still(d.places.dbPath);
      });
    }
  }

  test('an unset variable and an absolute one are no refusal', async (t) => {
    const d = await realLooking(t);
    const platform = {
      ...d.platform,
      env: { ...d.platform.env, XDG_RUNTIME_DIR: join(d.sandbox.root, 'xdg'), XDG_CACHE_HOME: '' },
    };

    const r = await purge(platform);

    assert.equal(r.code, 0, r.stderr);
    for (const dir of dirsOf(d)) gone(dir);
  });

  test('HOME unset is no refusal (the home directory then comes from the password database)', async (t) => {
    const d = await realLooking(t);
    const platform = { ...d.platform, env: { ...d.platform.env, HOME: undefined } };

    const r = await purge(platform);

    assert.equal(r.code, 0, r.stderr);
    for (const dir of dirsOf(d)) gone(dir);
  });

  test('HOME and another variable together: each clause gives its own reason', async (t) => {
    const d = await realLooking(t);
    const platform = { ...d.platform, env: { ...d.platform.env, HOME: '', XDG_STATE_HOME: 'rel' } };

    const r = await purge(platform);

    assert.equal(r.code, 1);
    assert.ok(
      r.stderr.startsWith(
        'skydeck: uninstall --purge removed nothing: HOME is set to "" (empty), which skydeck takes as it is, so every place would be relative to the working directory; ' +
          'XDG_STATE_HOME is set to "rel" but ignored (not an absolute path), so skydeck would find the installation it finds without it; ' +
          'it does not purge the installation it would then find.',
      ),
      r.stderr,
    );
    intact(d);
  });
});

// ---------------------------------------------------------------------------------------------
// One directory for two or three places

describe('uninstall --purge when two places are one directory', () => {
  test('XDG_DATA_HOME = XDG_STATE_HOME = XDG_CONFIG_HOME: the one directory holds all three, and goes', async (t) => {
    const d = await installed(t, {
      env: (s) => ({
        SKYDECK_HOME: undefined,
        XDG_DATA_HOME: join(s.root, 'xdg'),
        XDG_STATE_HOME: join(s.root, 'xdg'),
        XDG_CONFIG_HOME: join(s.root, 'xdg'),
      }),
    });
    assert.equal(d.places.dataDir, d.places.stateDir);
    everythingSkydeckWrites(d);

    const r = await purge(d.platform);

    assert.equal(r.code, 0, r.stderr);
    gone(d.places.dataDir);
    assert.equal(
      r.stdout.split('\n').filter((line) => line === `removed ${d.places.dataDir}`).length,
      1,
    );
  });
});

describe('uninstall --purge when one place lies inside another', () => {
  test('XDG_STATE_HOME inside the data directory: the deeper one first, both go in one run', async (t) => {
    const d = await installed(t, {
      env: (s) => ({
        SKYDECK_HOME: undefined,
        XDG_DATA_HOME: join(s.root, 'x'),
        XDG_STATE_HOME: join(s.root, 'x', 'skydeck'),
      }),
    });
    assert.equal(d.places.stateDir, join(d.places.dataDir, 'skydeck'));
    everythingSkydeckWrites(d);

    const r = await purge(d.platform);

    assert.equal(r.code, 0, r.stderr);
    gone(d.places.stateDir);
    gone(d.places.dataDir);
  });
});

// ---------------------------------------------------------------------------------------------
// Nothing outside the sandbox

describe('uninstall --purge touches nothing outside the test’s sandbox', () => {
  /** The platform's Files with every path outside the sandbox refused and recorded. */
  function sandboxOnly(files: Files, s: Sandbox): { files: Files; touched: string[] } {
    const touched: string[] = [];
    const inside = (given: string): boolean => {
      const path = resolve(given); // `<root>/../x` is outside
      return path === s.root || path.startsWith(`${s.root}/`);
    };
    const wrapped = Object.fromEntries(
      Object.entries(files).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          // symlink(target, path): the target is only text in the link, never touched.
          const paths = (name === 'symlink' ? args.slice(1) : args).filter(
            (arg): arg is string => typeof arg === 'string',
          );
          for (const path of paths) {
            if (!inside(path)) {
              touched.push(`${name} ${path}`);
              throw new Error(`a test touched ${path}`);
            }
          }
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as Files;
    return { files: wrapped, touched };
  }

  for (const env of [
    {},
    { SKYDECK_HOME: undefined },
    { SKYDECK_HOME: undefined, XDG_DATA_HOME: 'd', XDG_STATE_HOME: 's', XDG_CONFIG_HOME: 'c' },
  ] as Record<string, string | undefined>[]) {
    test(`env ${JSON.stringify(env, (_key, value: unknown) => value ?? '(unset)')}: every path the purge touches is inside the sandbox`, async (t) => {
      // A letter stands for a directory of the sandbox.
      const d = await installed(t, {
        env: (s) =>
          Object.fromEntries(
            Object.entries(env).map(([k, v]) => [
              k,
              v === undefined ? v : join(s.root, `xdg-${v}`),
            ]),
          ),
      });
      everythingSkydeckWrites(d);
      const guard = sandboxOnly(d.platform.files, d.sandbox);

      const r = await purge({ ...d.platform, files: guard.files });

      assert.deepEqual(guard.touched, []);
      // And the purge went the whole way: it cannot pass by ending early.
      assert.equal(r.code, 0, r.stderr);
      for (const dir of dirsOf(d)) gone(dir);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Each condition on each directory (review 1)

describe('uninstall --purge: each of the three directories, each way it is left alone', () => {
  const which = ['dataDir', 'stateDir', 'configDir'] as const;

  for (const name of which) {
    test(`${name} is a symbolic link: left alone, its target whole, the other two purged`, async (t) => {
      const d = testPlatform(t);
      claudeFolders(d.places);
      const target = join(d.sandbox.root, 'elsewhere');
      mkdirSync(target);
      writeFileSync(join(target, 'mine.txt'), 'mine');
      mkdirSync(join(d.places[name], '..'), { recursive: true });
      symlinkSync(target, d.places[name]);
      assert.equal((await run(d.platform, ['install'], { lines: ['y'] })).code, 0);

      const r = await purge(d.platform);

      assert.equal(r.code, 1, r.stdout);
      assert.ok(
        r.stderr.includes(`did not remove ${d.places[name]}: it is a symbolic link`),
        r.stderr,
      );
      still(join(target, 'mine.txt'));
      for (const other of dirsOf(d).filter((dir) => dir !== d.places[name])) gone(other);
    });

    test(`${name} belongs to another user: left alone, the other two purged`, async (t) => {
      const d = await installed(t);
      const dir = d.places[name];
      const files: Files = {
        ...d.platform.files,
        lstat(path) {
          const info = d.platform.files.lstat(path);
          return path === dir && info !== null ? { ...info, uid: info.uid + 1 } : info;
        },
      };

      const r = await purge({ ...d.platform, files });

      assert.equal(r.code, 1, r.stdout);
      assert.ok(
        r.stderr.includes(`did not remove ${dir}: it belongs to uid ${d.platform.uid + 1}`),
        r.stderr,
      );
      still(dir);
      for (const other of dirsOf(d).filter((o) => o !== dir)) gone(other);
    });

    test(`${name} cannot be looked at: left alone, the other two purged, no internal error`, async (t) => {
      if (isRoot) return t.skip('root reads anything');
      const d = await installed(t);
      const dir = d.places[name];
      chmodSync(dir, 0o300);
      try {
        const r = await purge(d.platform);

        assert.equal(r.code, 1, r.stdout);
        assert.ok(
          r.stderr.includes(`did not remove ${dir}: it cannot be looked at (EACCES)`),
          r.stderr,
        );
        assert.doesNotMatch(r.stderr, /internal error/);
        for (const other of dirsOf(d).filter((o) => o !== dir)) gone(other);
      } finally {
        chmodSync(dir, 0o700);
      }
      still(dir);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The runtime directory under the shared purge (ruled, purge-care)

describe('uninstall --purge: the runtime directory under the shared purge', () => {
  /** `$SKYDECK_HOME/run` with a server.json and terms/, as a server leaves it. */
  function runtimeDir(d: TestPlatform): string {
    const dir = join(d.sandbox.skydeckHome, 'run');
    mkdirSync(join(dir, 'terms'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(join(dir, 'terms'), 0o700);
    writeFileSync(join(dir, 'server.json'), '{}');
    return dir;
  }

  test('its terms/ belongs to another user: left alone, named, exit 1; the rest purged', async (t) => {
    const d = await installed(t);
    const dir = runtimeDir(d);
    const files: Files = {
      ...d.platform.files,
      lstat(path) {
        const info = d.platform.files.lstat(path);
        return path === join(dir, 'terms') && info !== null ? { ...info, uid: info.uid + 1 } : info;
      },
    };

    const r = await purge({ ...d.platform, files });

    assert.equal(r.code, 1, r.stdout);
    assert.ok(
      r.stderr.includes(
        `did not remove ${dir}: it holds terms, which belongs to uid ${d.platform.uid + 1}`,
      ),
      r.stderr,
    );
    still(join(dir, 'server.json'));
    for (const other of dirsOf(d)) gone(other);
  });

  test('a removal that fails is named in the last line, never an abort; the rest purged', async (t) => {
    const d = await installed(t);
    const dir = runtimeDir(d);
    const files: Files = {
      ...d.platform.files,
      remove(path) {
        if (path === join(dir, 'server.json')) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        d.platform.files.remove(path);
      },
    };

    const r = await purge({ ...d.platform, files });

    assert.equal(r.code, 1, r.stdout);
    assert.ok(
      r.stderr.includes(`did not remove ${dir}: it cannot be removed: server.json (EACCES)`),
      r.stderr,
    );
    assert.doesNotMatch(r.stderr, /cannot remove|internal error/);
    for (const other of dirsOf(d)) gone(other);
  });

  test('an entry that appears while it is purged stays, named, and so does the directory', async (t) => {
    const d = await installed(t);
    const dir = runtimeDir(d);
    let looks = 0;
    const files: Files = {
      ...d.platform.files,
      list(path) {
        // The look lists it first, the removal next: the entry comes in between.
        if (path === dir && ++looks === 2) writeFileSync(join(dir, 'late.txt'), 'mine');
        return d.platform.files.list(path);
      },
    };

    const r = await purge({ ...d.platform, files });

    assert.equal(r.code, 1, r.stdout);
    assert.ok(
      r.stderr.includes(
        `did not remove ${dir}: it still holds late.txt: something came into it while it was purged`,
      ),
      r.stderr,
    );
    still(join(dir, 'late.txt'));
    gone(join(dir, 'server.json'));
  });
});

describe('uninstall --purge: from review 2', () => {
  test('a foreign name with a line break reaches the last line as one line', async (t) => {
    const d = await installed(t);
    writeFileSync(join(d.places.stateDir, 'x\nskydeck: removed everything'), 'mine');

    const r = await purge(d.platform);

    assert.equal(r.code, 1);
    assert.equal(r.stderr.split('\n').filter((line) => line !== '').length, 1, r.stderr);
    assert.ok(
      r.stderr.includes('it holds x skydeck: removed everything, which skydeck did not write'),
      r.stderr,
    );
  });
});
