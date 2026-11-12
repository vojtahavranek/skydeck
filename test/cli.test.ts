import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MINIMUM_NODE, checkNodeVersion } from '../bin/node-version.mjs';
import { main } from '../src/cli/main.ts';
import type { Io } from '../src/cli/main.ts';
import pkg from '../package.json' with { type: 'json' };

interface Captured {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

function capture(): Captured {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

describe('main', () => {
  for (const flag of ['--version', '-V']) {
    test(`${flag} prints the package version and exits 0`, () => {
      const c = capture();

      const code = main([flag], c.io);

      assert.equal(code, 0);
      assert.equal(c.stdout(), `${pkg.version}\n`);
      assert.equal(c.stderr(), '');
    });
  }

  for (const argv of [[], ['--help'], ['-h']]) {
    test(`usage on stdout and exit 0 for ${JSON.stringify(argv)}`, () => {
      const c = capture();

      const code = main(argv, c.io);

      assert.equal(code, 0);
      assert.match(c.stdout(), /^Usage:/m);
      assert.equal(c.stderr(), '');
    });
  }

  for (const argv of [['frobnicate'], ['--nope'], ['--version', '--help'], ['--help', 'extra']]) {
    test(`usage on stderr and exit 2 for ${JSON.stringify(argv)}`, () => {
      const c = capture();

      const code = main(argv, c.io);

      assert.equal(code, 2);
      assert.equal(c.stdout(), '');
      assert.match(c.stderr(), /^Usage:/m);
    });
  }

  test('the usage text is the same on stdout and on stderr', () => {
    const ok = capture();
    const bad = capture();

    main(['--help'], ok.io);
    main(['frobnicate'], bad.io);

    assert.equal(bad.stderr(), ok.stdout());
  });
});

describe('bin/bootstrap.mjs: Node version check', () => {
  test('the minimum matches engines in package.json', () => {
    assert.equal(pkg.engines.node, `>=${MINIMUM_NODE}`);
  });

  for (const version of ['24.12.0', '24.19.0', '25.0.0', '100.1.2']) {
    test(`accepts ${version}`, () => {
      assert.equal(checkNodeVersion(version), undefined);
    });
  }

  // 24.2 and 24.9 are older than 24.12 although they sort after it as text.
  for (const version of ['20.20.2', '22.12.0', '24.11.9', '24.9.0', '24.2.0', '23.99.0']) {
    test(`refuses ${version}`, () => {
      assert.match(checkNodeVersion(version) ?? '', /./);
    });
  }

  test('refuses a version it cannot read', () => {
    assert.match(checkNodeVersion('banana') ?? '', /banana/);
  });

  test('the message is one line naming the found and the needed version and SKYDECK_NODE', () => {
    const message = checkNodeVersion('20.20.2');

    assert.ok(message);
    assert.ok(!message.includes('\n'));
    assert.ok(message.includes('20.20.2'));
    assert.ok(message.includes(MINIMUM_NODE));
    assert.ok(message.includes('SKYDECK_NODE'));
  });
});

describe('bin/bootstrap.mjs process-level behaviour', () => {
  const bootstrap = fileURLToPath(new URL('../bin/bootstrap.mjs', import.meta.url));

  /** Runs the bootstrap on the running Node after a data: module has run, with an empty environment. */
  function bootstrapAfter(preload: string, env: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bootstrap, '--version'],
      { encoding: 'utf8', env },
    );
  }

  test('on a Node that is too old: one line on stderr, nothing on stdout, exit 1, CLI not loaded', () => {
    // Pretend to be Node 20 by overriding process.versions.node before the bootstrap runs.
    const r = bootstrapAfter(
      'Object.defineProperty(process.versions, "node", { value: "20.0.0" })',
    );

    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${checkNodeVersion('20.0.0')}\n`);
  });

  // The failure must not depend on how Node treats unhandled rejections: with "none" or "warn" a
  // bare promise chain would exit 0 here, and a broken install would look like success.
  for (const mode of ['strict', 'throw', 'warn', 'none']) {
    test(`a CLI that fails to load exits 1 and shows the error (--unhandled-rejections=${mode})`, () => {
      const r = bootstrapAfter(
        `import { registerHooks } from 'node:module';
         registerHooks({ resolve(specifier, context, next) {
           if (specifier.endsWith('/cli/main.ts')) throw new Error('boom: cannot load the CLI');
           return next(specifier, context);
         } });`,
        { NODE_OPTIONS: `--unhandled-rejections=${mode}` },
      );

      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /boom: cannot load the CLI/);
    });
  }
});

describe('bin/skydeck as a child process', () => {
  const launcher = fileURLToPath(new URL('../bin/skydeck', import.meta.url));

  function run(args: string[], t: { after: (fn: () => void) => void }) {
    const cache = mkdtempSync(join(tmpdir(), 'skydeck-cache-'));
    t.after(() => {
      rmSync(cache, { recursive: true, force: true });
    });
    return spawnSync(launcher, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', SKYDECK_NODE: process.execPath, XDG_CACHE_HOME: cache },
    });
  }

  test('--version prints the package version', (t) => {
    const r = run(['--version'], t);

    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${pkg.version}\n`);
    assert.equal(r.stderr, '');
  });

  test('an unknown command prints the usage on stderr and exits 2', (t) => {
    const r = run(['frobnicate'], t);

    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage:/m);
  });
});
