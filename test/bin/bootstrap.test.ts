import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MINIMUM_NODE, checkNodeVersion } from '../../bin/node-version.mjs';
import { hideSqliteWarning } from '../../bin/warnings.mjs';
import pkg from '../../package.json' with { type: 'json' };
import { sandbox } from '../helpers/sandbox.ts';

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
  const bootstrap = fileURLToPath(new URL('../../bin/bootstrap.mjs', import.meta.url));

  /** Runs the bootstrap on the running Node after a data: module has run, in a sandbox. */
  function bootstrapAfter(t: TestContext, preload: string, env: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bootstrap, '--version'],
      { encoding: 'utf8', env: sandbox(t).env(env) },
    );
  }

  test('on a Node that is too old: one line on stderr, nothing on stdout, exit 1, CLI not loaded', (t) => {
    // Pretend to be Node 20 by overriding process.versions.node before the bootstrap runs.
    const r = bootstrapAfter(
      t,
      'Object.defineProperty(process.versions, "node", { value: "20.0.0" })',
    );

    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${checkNodeVersion('20.0.0')}\n`);
  });

  // The failure must not depend on how Node treats unhandled rejections: with "none" or "warn" a
  // bare promise chain would exit 0 here, and a broken install would look like success.
  for (const mode of ['strict', 'throw', 'warn', 'none']) {
    test(`a CLI that fails to load exits 1 and shows the error (--unhandled-rejections=${mode})`, (t) => {
      const r = bootstrapAfter(
        t,
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

describe("bin/warnings.mjs: Node.js's warning that node:sqlite is experimental is hidden", () => {
  /** A process whose emitWarning records its calls, wrapped by hideSqliteWarning. */
  function wrapped(): { proc: NodeJS.Process; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const proc = {
      emitWarning(...args: unknown[]) {
        calls.push(args);
      },
    } as unknown as NodeJS.Process;
    hideSqliteWarning(proc);
    return { proc, calls };
  }

  const SQLITE = 'SQLite is an experimental feature and might change at any time';

  test('as Node emits it (message, type), as an options object, as an Error: dropped', () => {
    const { proc, calls } = wrapped();
    proc.emitWarning(SQLITE, 'ExperimentalWarning');
    proc.emitWarning(SQLITE, { type: 'ExperimentalWarning' });
    const error = new Error(SQLITE);
    error.name = 'ExperimentalWarning';
    proc.emitWarning(error);

    assert.deepEqual(calls, []);
  });

  test('every other warning reaches Node with all its arguments', () => {
    const { proc, calls } = wrapped();
    proc.emitWarning('VM Modules is an experimental feature', 'ExperimentalWarning', 'X1');
    proc.emitWarning(SQLITE, 'DeprecationWarning');
    proc.emitWarning(SQLITE);
    proc.emitWarning('something else');

    assert.deepEqual(calls, [
      ['VM Modules is an experimental feature', 'ExperimentalWarning', 'X1'],
      [SQLITE, 'DeprecationWarning'],
      [SQLITE],
      ['something else'],
    ]);
  });

  test("on the real Node: node:sqlite loads without a word, another warning still prints with Node's hint", () => {
    const warnings = fileURLToPath(new URL('../../bin/warnings.mjs', import.meta.url));
    const script = [
      `import { hideSqliteWarning } from ${JSON.stringify(warnings)};`,
      'hideSqliteWarning(process);',
      "await import('node:sqlite');",
      "process.emitWarning('another warning');",
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /SQLite|ExperimentalWarning/);
    assert.match(r.stderr, /^\(node:\d+\) Warning: another warning\n\(Use `node --trace-warnings/);
  });

  test('bin/bootstrap.mjs hides it before the CLI loads; a warning while the CLI loads still prints', (t) => {
    const bootstrap = fileURLToPath(new URL('../../bin/bootstrap.mjs', import.meta.url));
    // The warning comes from a loader hook as the CLI's main module loads, after node:sqlite could.
    const preload = `import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/cli/main.ts')) process.emitWarning('another warning');
        return next(url, context);
      } });`;
    const r = spawnSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bootstrap, 'ls'],
      { encoding: 'utf8', env: sandbox(t).env() },
    );

    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /SQLite|ExperimentalWarning/);
    assert.match(r.stderr, /Warning: another warning/);
  });
});
