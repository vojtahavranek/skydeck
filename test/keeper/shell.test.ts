// The keeper's second kind of terminal, a session's shell (keeper version 4, S2 7.10, 7.1): the
// shell meta and its hello, the sixth field of its pid line, the spec's `file` run with the spec's
// argv, the hang-up, and what is refused. A session spec is unchanged but for an optional `shell`
// in its meta. And A13 (S2 7.7), the build before meeting this keeper: a version 4 session
// keeper's hello read by the frames codec of that build, kept as a fixture. Real python3 in a
// sandbox (realTestPlatform); the program is the stand-in shell or the test's Node.js.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import * as before from '../fixtures/frames-before-shell/frames.ts';
import {
  exit,
  keeperSandbox,
  SESSION,
  shellHello,
  started,
  stillRuns,
  until,
  within,
} from '../helpers/keeper.ts';
import type { Keeper } from '../helpers/keeper.ts';
import type { KeeperSpec, ShellSpec } from '../../src/window/frames.ts';
import { SHELL_PROMPT } from '../helpers/shell-standin.ts';

const OF = 'a1b2c3d4e5f6';

/** The keeper ended by itself (status 0) and removed its socket and pid file. */
async function gone(k: Keeper<KeeperSpec | ShellSpec>): Promise<void> {
  const end = await within(k.exited, 'the keeper ended', 10_000);
  assert.deepEqual(end, { code: 0, signal: null });
  assert.equal(existsSync(k.spec.socket), false, 'its socket is removed');
  assert.equal(existsSync(k.pidFile), false, 'its pid line is removed');
}

describe("keeper version 4: a session's shell", { concurrency: true }, () => {
  test("a shell spec's hello says keeper 4, lock null and exactly the shell meta's five fields; its pid line ends with shell", async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ shell: { meta: { ...box.shellSpec().meta, of: OF } } });

    assert.equal(readFileSync(k.pidFile, 'utf8').endsWith(' 4 0 shell\n'), true);
    assert.deepEqual(k.pidLine()?.keeper, { version: '4', started: false, shell: true });

    const { client, hello } = await k.claim();
    assert.equal(hello.keeper, '4');
    assert.equal(hello.protocol, 1);
    assert.equal(hello.lock, null);
    assert.deepEqual(hello.meta, k.spec.meta);
    assert.deepEqual(Object.keys(hello.meta).sort(), ['build', 'dir', 'kind', 'of', 'openedNs']);
    const raw = JSON.parse(
      Buffer.from(
        (client.frames.find((f) => f.type === 'H') ?? { payload: [] }).payload,
      ).toString(),
    ) as { meta: Record<string, unknown> };
    assert.deepEqual(Object.keys(raw.meta).sort(), ['build', 'dir', 'kind', 'of', 'openedNs']);

    client.send('G');
    const { pid, procStart } = started(await client.next('T'));
    await client.waitForOutput(SHELL_PROMPT, 15_000);
    await until(() => k.pidLine()?.keeper?.started === true, 'the pid line says started');
    assert.equal(readFileSync(k.pidFile, 'utf8').endsWith(' 4 1 shell\n'), true);

    client.send('I', 'exit 0\r');
    const x = exit(await client.next('X', 10_000));
    assert.deepEqual([x.code, x.signal], [0, null]);
    assert.equal(stillRuns(pid, procStart), false);
    client.send('A');
    await gone(k);
  });

  test("`file` runs with the spec's argv as given (argv[0] `-<name>`), in the spec's cwd, with exactly the spec's environment", async (t) => {
    const box = keeperSandbox(t);
    const cwd = join(box.s.home, 'project');
    mkdirSync(cwd);
    const out = join(box.s.root, 'argv0.json');
    const script = [
      "const fs = require('node:fs');",
      'fs.writeFileSync(process.argv[1], JSON.stringify({',
      '  argv0: process.argv0, cwd: process.cwd(), env: Object.keys(process.env).sort() }));',
    ].join('\n');
    const k = await box.start({
      shell: { file: process.execPath, argv: ['-argv0-standin', '-e', script, out], cwd },
    });
    const { client } = await k.claim();
    client.send('G');
    started(await client.next('T'));
    const x = exit(await client.next('X', 15_000));
    assert.deepEqual([x.code, x.signal], [0, null], client.output());

    const got = JSON.parse(readFileSync(out, 'utf8')) as {
      argv0: string;
      cwd: string;
      env: string[];
    };
    assert.equal(got.argv0, '-argv0-standin');
    assert.equal(got.cwd, cwd);
    assert.deepEqual(got.env, Object.keys(k.spec.env).sort());
  });

  test('a `file` that is not there: T, then X 127, and the pty line names the file', async (t) => {
    const box = keeperSandbox(t);
    const file = join(box.s.root, 'no-such-shell');
    const k = await box.start({ shell: { file } });
    const { client } = await k.claim();
    client.send('G');
    started(await client.next('T'));
    const x = exit(await client.next('X', 10_000));
    assert.deepEqual([x.code, x.signal, x.notStarted], [127, null, null]);
    assert.match(client.output(), new RegExp(`skydeck: cannot run ${file}: No such file`));
  });

  test('E hangs the shell up: its program ends on SIGHUP', async (t) => {
    const box = keeperSandbox(t);
    const k = await box.start({ shell: {} });
    const { client } = await k.claim();
    client.send('G');
    const { pid, procStart } = started(await client.next('T'));
    await client.waitForOutput(SHELL_PROMPT, 15_000);

    client.send('E');
    const x = exit(await client.next('X', 10_000));
    assert.deepEqual([x.code, x.signal], [null, 1]);
    assert.equal(stillRuns(pid, procStart), false);
  });
});

describe('keeper version 4: a session terminal', { concurrency: true }, () => {
  test("a session spec is unchanged: seven meta fields, a five-field pid line, and its meta's shell echoed when it has one", async (t) => {
    const box = keeperSandbox(t);
    const plain = await box.start();
    const { hello: first } = await plain.claim();
    assert.deepEqual(Object.keys(first.meta).sort(), [
      'build',
      'dir',
      'kind',
      'label',
      'openedNs',
      'sessionId',
      'slot',
    ]);
    assert.equal(first.keeper, '4');
    assert.match(readFileSync(plain.pidFile, 'utf8'), /^\d+ \d+ \S+ 4 0\n$/);

    const withShell = await box.start({ spec: { meta: { ...box.spec().meta, shell: OF } } });
    const { hello } = await withShell.claim();
    assert.equal(hello.meta.shell, OF);
    assert.deepEqual(hello.meta, withShell.spec.meta);
    assert.match(readFileSync(withShell.pidFile, 'utf8'), /^\d+ \d+ \S+ 4 0\n$/);
  });
});

describe('keeper version 4: what is refused (bad-spec, exit 2)', { concurrency: true }, () => {
  /** Starts a keeper on `spec` as written, and checks that it ends as a bad spec. */
  async function refused(
    box: ReturnType<typeof keeperSandbox>,
    spec: Record<string, unknown> & { id: string; socket: string },
  ): Promise<void> {
    const k = await box.start({ rawSpec: JSON.stringify(spec), waitReady: false });
    const end = await within(k.exited, 'the keeper ended');
    assert.equal(end.code, 2, 'a refused spec exits 2');
    assert.deepEqual(box.logLines(), [`keeper ${spec.id}: bad-spec`]);
    assert.equal(existsSync(spec.socket), false);
  }

  const shellCases: [string, (spec: ShellSpec) => Record<string, unknown>][] = [
    ['a shell meta without of', (spec) => ({ ...spec, meta: { ...spec.meta, of: undefined } })],
    [
      'an of that is not 12 hex',
      (spec) => ({ ...spec, meta: { ...spec.meta, of: 'A1B2C3D4E5F6' } }),
    ],
    ['an of of 11 hex', (spec) => ({ ...spec, meta: { ...spec.meta, of: 'a1b2c3d4e5f' } })],
    ['no file', (spec) => ({ ...spec, file: undefined })],
    ['a relative file', (spec) => ({ ...spec, file: 'bin/sh' })],
    ['a file with NUL', (spec) => ({ ...spec, file: '/bin/sh\u0000x' })],
    ['a file that is not text', (spec) => ({ ...spec, file: 7 })],
    ['a lock', (spec) => ({ ...spec, lock: '1 2 3' })],
    ['a kind other', (spec) => ({ ...spec, meta: { ...spec.meta, kind: 'other' } })],
    [
      "a shell meta with a key outside its form (a session's)",
      (spec) => ({ ...spec, meta: { ...spec.meta, sessionId: SESSION } }),
    ],
  ];
  for (const [what, change] of shellCases) {
    test(`a shell spec with ${what}`, async (t) => {
      const box = keeperSandbox(t);
      const spec = box.shellSpec();
      await refused(box, {
        ...JSON.parse(JSON.stringify(change(spec))),
        id: spec.id,
        socket: spec.socket,
      });
    });
  }

  const sessionCases: [string, (spec: KeeperSpec) => Record<string, unknown>][] = [
    ['a file', (spec) => ({ ...spec, file: '/bin/sh' })],
    [
      'a meta shell that is not 12 hex',
      (spec) => ({ ...spec, meta: { ...spec.meta, shell: 'x' } }),
    ],
    ['a meta shell of null', (spec) => ({ ...spec, meta: { ...spec.meta, shell: null } })],
  ];
  for (const [what, change] of sessionCases) {
    test(`a session spec with ${what}`, async (t) => {
      const box = keeperSandbox(t);
      const spec = box.spec();
      await refused(box, { ...change(spec), id: spec.id, socket: spec.socket });
    });
  }
});

describe(
  'A13: the build before (its frames codec, kept as a fixture) and a version 4 keeper',
  { concurrency: true },
  () => {
    test("a version 4 session keeper's hello, its meta carrying shell, reads in the codec of the build before, which can end it", async (t) => {
      const box = keeperSandbox(t);
      const k = await box.start({ spec: { meta: { ...box.spec().meta, shell: OF } } });
      const { client } = await k.claim();
      const frame = client.frames.find((f) => f.type === 'H');
      assert.ok(frame !== undefined);

      const parsed = before.parseHello(frame.payload);
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.kind);
      const { shell: _shell, ...seven } = k.spec.meta;
      assert.deepEqual(parsed.value.meta, seven, 'the seven fields as the spec has them');
      assert.equal(parsed.value.keeper, '4');
      assert.equal(
        parsed.value.protocol,
        before.KEEPER_PROTOCOL,
        'no newer protocol: it is served',
      );
      assert.equal(before.keeperEnds(parsed.value.keeper), true, 'it is sent E');
    });

    test("a shell's keeper's hello is refused by the codec of the build before: an older server would list nothing for it", async (t) => {
      const box = keeperSandbox(t);
      const k = await box.start({ shell: {} });
      const { client, hello } = await k.claim();
      assert.equal(shellHello(client.frames[0] ?? assert.fail('no frame')).meta.kind, 'shell');
      assert.equal(hello.meta.kind, 'shell');
      const frame = client.frames.find((f) => f.type === 'H');
      assert.ok(frame !== undefined);

      assert.deepEqual(before.parseHello(frame.payload), {
        ok: false,
        kind: 'hello.meta.sessionId: missing',
      });
    });
  },
);
