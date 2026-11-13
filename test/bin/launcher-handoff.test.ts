// The launcher hands the terminal over to a program that skydeck chose: node writes a shell
// fragment to $SKYDECK_HANDOFF and exits, and the launcher runs it. A stub stands in for node and
// copies a prepared fragment (made by the real handoffScript) into the handoff file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { handoffScript } from '../../src/terminals/here.ts';
import type { LaunchSpec } from '../../src/terminals/types.ts';
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const launcher = fileURLToPath(new URL('../../bin/skydeck', import.meta.url));

const STUB = `#!/bin/sh
echo "$SKYDECK_HANDOFF" > "$STUB_SEEN"
[ -n "$STUB_SOURCE" ] && cat "$STUB_SOURCE" > "$SKYDECK_HANDOFF"
exit "\${STUB_STATUS:-0}"
`;

interface Rig {
  s: Sandbox;
  tmp: string;
  stub: string;
  seen: string;
  source: string;
}

function rig(t: TestContext): Rig {
  const s = sandbox(t);
  s.link('dirname', 'readlink', 'mktemp', 'cat', 'rm');
  const tmp = join(s.root, 'tmp');
  mkdirSync(tmp);
  const stub = join(s.root, 'stub-node');
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  return { s, tmp, stub, seen: join(s.root, 'seen'), source: join(s.root, 'source') };
}

function run(r: Rig, extra: Record<string, string | undefined> = {}) {
  return spawnSync(launcher, [], {
    encoding: 'utf8',
    cwd: r.s.root,
    env: r.s.env({
      SKYDECK_NODE: r.stub,
      TMPDIR: r.tmp,
      STUB_SEEN: r.seen,
      ...extra,
    }),
  });
}

function leftovers(r: Rig): string[] {
  return readdirSync(r.tmp);
}

function handoff(r: Rig, spec: LaunchSpec): void {
  writeFileSync(r.source, handoffScript(spec));
}

describe('bin/skydeck: the handoff', () => {
  test('runs the program node asked for, in the directory it asked for, with every word intact', (t) => {
    const r = rig(t);
    mkdirSync(join(r.s.root, 'dir'));
    handoff(r, {
      cwd: join(r.s.root, 'dir'),
      argv: [
        '/bin/sh',
        '-c',
        'pwd; for a; do printf "[%s]\\n" "$a"; done',
        'sh',
        'a b',
        "it's",
        '',
      ],
    });

    const result = run(r, { STUB_SOURCE: r.source });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${join(r.s.root, 'dir')}\n[a b]\n[it's]\n[]\n`);
    assert.deepEqual(leftovers(r), []);
  });

  test('without a handoff the exit status of node is the exit status of the launcher', (t) => {
    const r = rig(t);

    const result = run(r, { STUB_STATUS: '7' });

    assert.equal(result.status, 7);
    assert.equal(result.stdout, '');
    assert.deepEqual(leftovers(r), []);
  });

  test('a handoff to a directory that does not exist exits 1', (t) => {
    const r = rig(t);
    handoff(r, { cwd: join(r.s.root, 'no-such-dir'), argv: ['/bin/sh', '-c', 'echo ran'] });

    const result = run(r, { STUB_SOURCE: r.source });

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /ran/);
    assert.deepEqual(leftovers(r), []);
  });

  test('node is given a handoff file named skydeck-handoff.* in TMPDIR', (t) => {
    const r = rig(t);

    run(r);

    const path = readFileSync(r.seen, 'utf8').trim();
    assert.ok(path.startsWith(`${r.tmp}/skydeck-handoff.`), path);
  });

  test('the program that replaces skydeck does not see SKYDECK_HANDOFF', (t) => {
    const r = rig(t);
    handoff(r, {
      cwd: r.s.root,
      argv: ['/bin/sh', '-c', 'echo "[${SKYDECK_HANDOFF-unset}]"'],
    });

    const result = run(r, { STUB_SOURCE: r.source });

    assert.equal(result.stdout, '[unset]\n');
  });

  test('a SKYDECK_HANDOFF inherited from the caller is replaced, not trusted', (t) => {
    const r = rig(t);
    const stale = join(r.s.root, 'stale');
    writeFileSync(stale, 'echo should-not-run\n');

    const result = run(r, { SKYDECK_HANDOFF: stale });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.notEqual(readFileSync(r.seen, 'utf8').trim(), stale);
    assert.equal(readFileSync(stale, 'utf8'), 'echo should-not-run\n');
  });

  test('the program replaces the launcher: no wrapper process stays behind', (t) => {
    const r = rig(t);
    handoff(r, { cwd: r.s.root, argv: ['/bin/sh', '-c', 'echo $$'] });

    const result = run(r, { STUB_SOURCE: r.source });

    assert.equal(result.stdout, `${result.pid}\n`);
  });

  test("the program does not inherit the launcher's compile cache setting", (t) => {
    const r = rig(t);
    handoff(r, {
      cwd: r.s.root,
      argv: ['/bin/sh', '-c', 'echo "[${NODE_COMPILE_CACHE-unset}]"'],
    });

    const result = run(r, { STUB_SOURCE: r.source });

    assert.equal(result.stdout, '[unset]\n');
  });

  test("a NODE_COMPILE_CACHE the caller set is still the caller's for the program", (t) => {
    const r = rig(t);
    handoff(r, {
      cwd: r.s.root,
      argv: ['/bin/sh', '-c', 'echo "[${NODE_COMPILE_CACHE-unset}]"'],
    });

    const result = run(r, { STUB_SOURCE: r.source, NODE_COMPILE_CACHE: '/my/cache' });

    assert.equal(result.stdout, '[/my/cache]\n');
  });

  test('an empty NODE_COMPILE_CACHE of the caller stays empty for the program', (t) => {
    const r = rig(t);
    handoff(r, {
      cwd: r.s.root,
      argv: ['/bin/sh', '-c', 'echo "[${NODE_COMPILE_CACHE-unset}]"'],
    });

    const result = run(r, { STUB_SOURCE: r.source, NODE_COMPILE_CACHE: '' });

    assert.equal(result.stdout, '[]\n');
  });

  test("the program sees the caller's CDPATH, and none when the caller had none", (t) => {
    const r = rig(t);
    handoff(r, {
      cwd: r.s.root,
      argv: ['/bin/sh', '-c', 'echo "[${CDPATH-unset}]"'],
    });

    const withIt = run(r, { STUB_SOURCE: r.source, CDPATH: '.:/usr' });
    const without = run(r, { STUB_SOURCE: r.source });

    assert.equal(withIt.stdout, '[.:/usr]\n');
    assert.equal(without.stdout, '[unset]\n');
  });

  test("variables the caller exported under the launcher's own plain names reach the program unchanged", (t) => {
    const r = rig(t);
    const names = [
      'self',
      'dir',
      'target',
      'root',
      'linked_node',
      'node',
      'cache',
      'tmp',
      'handoff',
      'status',
      'script',
    ];
    handoff(r, {
      cwd: r.s.root,
      argv: ['/bin/sh', '-c', names.map((n) => `echo "${n}=$${n}"`).join('; ')],
    });

    const result = run(r, {
      STUB_SOURCE: r.source,
      ...Object.fromEntries(names.map((n) => [n, `mine-${n}`])),
    });

    assert.equal(result.stdout, names.map((n) => `${n}=mine-${n}\n`).join(''));
  });

  const signals: ReadonlyArray<readonly [name: string, status: number]> = [
    ['TERM', 130],
    ['INT', 130],
    ['HUP', 130],
    ['QUIT', 131],
  ];
  for (const [signal, status] of signals) {
    test(`${signal} while node runs: exit ${status} and no handoff file left`, (t) => {
      const r = rig(t);
      const stub = join(r.s.root, 'signalling-node');
      writeFileSync(
        stub,
        `#!/bin/sh\necho "$SKYDECK_HANDOFF" > "$STUB_SEEN"\nkill -${signal} "$PPID"\nexit 0\n`,
      );
      chmodSync(stub, 0o755);

      const result = run(r, { SKYDECK_NODE: stub });

      assert.equal(result.status, status);
      assert.ok(readFileSync(r.seen, 'utf8').trim().startsWith(r.tmp));
      assert.deepEqual(leftovers(r), []);
    });
  }

  test('an empty handoff file is no handoff', (t) => {
    const r = rig(t);
    writeFileSync(r.source, '');

    const result = run(r, { STUB_SOURCE: r.source, STUB_STATUS: '3' });

    assert.equal(result.status, 3);
    assert.deepEqual(leftovers(r), []);
  });

  describe('a TMPDIR that cannot hold the handoff file falls back to /tmp', () => {
    const cases: ReadonlyArray<readonly [name: string, tmpdir: (r: Rig) => string | undefined]> = [
      ['unset', () => undefined],
      ['empty', () => ''],
      ['relative (an existing directory, reached relative to the working directory)', () => 'tmp'],
      ['a directory that does not exist', (r) => join(r.s.root, 'no-such-tmp')],
      ['a file, not a directory', (r) => r.stub],
      [
        'a directory that cannot be written',
        (r) => {
          const dir = join(r.s.root, 'read-only-tmp');
          mkdirSync(dir);
          chmodSync(dir, 0o555);
          return dir;
        },
      ],
    ];
    const isRoot = process.getuid?.() === 0; // root writes anywhere, so the case proves nothing
    for (const [name, tmpdir] of cases) {
      test(name, { skip: isRoot && name.includes('cannot be written') }, (t) => {
        const r = rig(t);
        handoff(r, { cwd: r.s.root, argv: ['/bin/sh', '-c', 'echo ran'] });

        const result = run(r, { STUB_SOURCE: r.source, TMPDIR: tmpdir(r) });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'ran\n');
        const path = readFileSync(r.seen, 'utf8').trim();
        assert.ok(path.startsWith('/tmp/skydeck-handoff.'), path);
        assert.equal(existsSync(path), false);
        assert.deepEqual(leftovers(r), []);
      });
    }
  });
});
