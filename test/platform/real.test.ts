import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { on } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { realPlatform } from '../../src/platform/real.ts';
import type { RunResult } from '../../src/platform/types.ts';
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A temporary directory, removed when the test ends. */
function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'skydeck-real-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const REAL_MODULE = pathToFileURL(
  new URL('../../src/platform/real.ts', import.meta.url).pathname,
).href;

/** Runs this Node.js with `nodeArgs` in a directory that was removed after the shell entered it. */
function inRemovedDirectory(s: Sandbox, nodeArgs: string[]): Promise<RunResult> {
  s.link('sh', 'mkdir', 'rmdir');
  return realPlatform().runner.run(
    'sh',
    ['-c', 'mkdir gone && cd gone && rmdir ../gone && exec "$NODE" "$@"', 'sh', ...nodeArgs],
    { cwd: s.root, env: s.env({ NODE: process.execPath }), timeoutMs: 20_000 },
  );
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const mode = (path: string): number => statSync(path).mode & 0o777;

describe('real clock', () => {
  test('nowNs is the wall clock, to within 5 seconds', () => {
    const { clock } = realPlatform();

    const diff = clock.nowNs() - BigInt(Date.now()) * 1_000_000n;

    assert.ok(diff > -5_000_000_000n && diff < 5_000_000_000n, `off by ${diff} ns`);
  });

  test('1000 successive calls never decrease', () => {
    const { clock } = realPlatform();
    let previous = clock.nowNs();

    for (let i = 0; i < 1000; i++) {
      const now = clock.nowNs();
      assert.ok(now >= previous, `call ${i}: ${now} < ${previous}`);
      previous = now;
    }
  });

  test('sleep resolves after about that many milliseconds', async () => {
    const { clock } = realPlatform();
    const before = clock.nowNs();

    await clock.sleep(30);

    assert.ok(clock.nowNs() - before >= 20_000_000n);
  });
});

describe('real files', () => {
  test('writeText then readText round-trips and leaves no temporary file behind', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    const p = join(dir, 'f');

    files.writeText(p, 'a');

    assert.equal(files.readText(p), 'a');
    assert.deepEqual(files.list(dir), [basename(p)]);
  });

  test('writeText replaces an existing file', (t) => {
    const { files } = realPlatform();
    const p = join(tmp(t), 'f');
    files.writeText(p, 'a');

    files.writeText(p, 'b');

    assert.equal(files.readText(p), 'b');
  });

  test('writeText leaves a hard link to the old file with the old content', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    const [p, h] = [join(dir, 'p'), join(dir, 'h')];
    writeFileSync(p, 'a');
    linkSync(p, h);

    files.writeText(p, 'b');

    assert.equal(files.readText(p), 'b');
    assert.equal(files.readText(h), 'a');
  });

  test('writeText onto a directory throws and leaves no temporary file', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    mkdirSync(join(dir, 'p'));

    assert.throws(() => {
      files.writeText(join(dir, 'p'), 'x');
    });

    assert.deepEqual(files.list(dir), ['p']);
  });

  test('writeText without a mode keeps the mode of the file it replaces', (t) => {
    const { files } = realPlatform();
    const p = join(tmp(t), 'f');
    writeFileSync(p, 'a', { mode: 0o600 });

    files.writeText(p, 'b');

    assert.equal(files.readText(p), 'b');
    assert.equal(mode(p), 0o600);
  });

  test('writeText with a mode overrides the mode of the file it replaces', (t) => {
    const { files } = realPlatform();
    const p = join(tmp(t), 'f');
    writeFileSync(p, 'a', { mode: 0o600 });

    files.writeText(p, 'b', 0o640);

    assert.equal(mode(p), 0o640);
  });

  test('writeText through a symlink replaces the file it points to and keeps the link', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    mkdirSync(join(dir, 'dotfiles'));
    const [real, l] = [join(dir, 'dotfiles', 'settings.json'), join(dir, 'settings.json')];
    writeFileSync(real, 'a', { mode: 0o600 });
    symlinkSync(real, l);

    files.writeText(l, 'b');

    assert.equal(files.lstat(l)?.kind, 'symlink');
    assert.equal(files.readlink(l), real);
    assert.equal(files.readText(real), 'b');
    assert.equal(mode(real), 0o600);
    assert.deepEqual(files.list(dir), ['dotfiles', 'settings.json']);
    assert.deepEqual(files.list(join(dir, 'dotfiles')), ['settings.json']);
  });

  test('writeText through a relative symlink in another directory follows it', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b', 'real'), 'old');
    symlinkSync('../b/real', join(dir, 'a', 'l'));

    files.writeText(join(dir, 'a', 'l'), 'new');

    assert.equal(files.readText(join(dir, 'b', 'real')), 'new');
    assert.equal(files.readlink(join(dir, 'a', 'l')), '../b/real');
  });

  test('writeText onto a dangling symlink replaces the link with a regular file', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    symlinkSync(join(dir, 'missing'), join(dir, 'l'));

    files.writeText(join(dir, 'l'), 'x');

    assert.equal(files.lstat(join(dir, 'l'))?.kind, 'file');
    assert.equal(files.readText(join(dir, 'l')), 'x');
    assert.equal(files.stat(join(dir, 'missing')), null);
  });

  test('writeText with a mode sets exactly that mode', (t) => {
    const { files } = realPlatform();
    const p = join(tmp(t), 'f');

    files.writeText(p, 'b', 0o600);

    assert.equal(mode(p), 0o600);
  });

  test('writeText into a directory that does not exist throws', (t) => {
    const { files } = realPlatform();

    assert.throws(() => {
      files.writeText(join(tmp(t), 'no', 'f'), 'x');
    });
  });

  test('createExclusive creates once, then says false and keeps the content', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    const q = join(dir, 'q');

    assert.equal(files.createExclusive(q, 'x'), true);
    assert.equal(files.createExclusive(q, 'y'), false);
    assert.equal(files.readText(q), 'x');
    assert.deepEqual(files.list(dir), ['q']); // no temporary file, after either call
  });

  test('createExclusive with a mode: the file has exactly that mode', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    const q = join(dir, 'q');
    // With no umask, a file made without the mode would come out 0666 on any machine.
    const umask = process.umask(0);
    try {
      assert.equal(files.createExclusive(q, 'x', 0o600), true);
    } finally {
      process.umask(umask);
    }

    assert.equal(mode(q), 0o600);
    assert.equal(files.readText(q), 'x');
    assert.deepEqual(files.list(dir), ['q']);
  });

  test('createExclusive fails on an existing directory or empty file without touching it', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'empty'), '');

    assert.equal(files.createExclusive(join(dir, 'd'), 'x'), false);
    assert.equal(files.createExclusive(join(dir, 'empty'), 'x'), false);
    assert.equal(files.readText(join(dir, 'empty')), '');
    assert.deepEqual(files.list(dir), ['d', 'empty']);
  });

  test('createExclusive into a directory that does not exist throws and leaves nothing', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);

    assert.throws(() => files.createExclusive(join(dir, 'no', 'q'), 'x'));

    assert.deepEqual(files.list(dir), []);
  });

  test('a reader that sees the file created by createExclusive always sees all of it', async (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    const content = 'x'.repeat(2_000_000);
    const paths = Array.from({ length: 25 }, (_, i) => join(dir, `lock-${i}`));
    // The reader spins on each path in turn and reports how many bytes it found as soon as it can
    // see the file; the main thread creates the files while it spins.
    const reader = new Worker(
      `
      const { workerData, parentPort } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      parentPort.postMessage('ready');
      for (const path of workerData) {
        for (;;) {
          try { parentPort.postMessage(readFileSync(path, 'utf8').length); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      `,
      { eval: true, workerData: paths },
    );
    t.after(() => reader.terminate());
    const messages = on(reader, 'message');
    await messages.next(); // ready

    const seen: unknown[] = [];
    for (const path of paths) {
      assert.equal(files.createExclusive(path, content), true);
      seen.push((await messages.next()).value?.[0]);
    }

    assert.deepEqual(
      seen,
      paths.map(() => content.length),
    );
  });

  test('a path that does not exist reads as null, [] and null', (t) => {
    const { files } = realPlatform();
    const missing = join(tmp(t), 'missing');

    assert.equal(files.readText(missing), null);
    assert.equal(files.stat(missing), null);
    assert.equal(files.lstat(missing), null);
    assert.deepEqual(files.list(missing), []);
    assert.equal(files.readlink(missing), null);
    assert.equal(files.realpath(missing), null);
  });

  test('a path below a regular file counts as missing too', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    writeFileSync(join(dir, 'f'), 'x');

    assert.equal(files.stat(join(dir, 'f', 'child')), null);
    assert.equal(files.readText(join(dir, 'f', 'child')), null);
    assert.deepEqual(files.list(join(dir, 'f')), []);
  });

  test('stat reports size, kind and a nanosecond modification time', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    writeFileSync(join(dir, 'f'), 'abc');

    const file = files.stat(join(dir, 'f'));
    const folder = files.stat(dir);

    assert.equal(file?.kind, 'file');
    assert.equal(file?.size, 3);
    assert.equal(typeof file?.mtimeNs, 'bigint');
    assert.ok(file !== null && file.mtimeNs > 1_000_000_000_000_000_000n);
    assert.equal(folder?.kind, 'dir');
  });

  test('list gives the sorted entry names', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    for (const name of ['c', 'a', 'b']) {
      writeFileSync(join(dir, name), '');
    }

    assert.deepEqual(files.list(dir), ['a', 'b', 'c']);
  });

  test('list sorts by UTF-16 code unit, not by locale', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    for (const name of ['b', 'B', 'a', '_', 'é']) {
      writeFileSync(join(dir, name), '');
    }

    assert.deepEqual(files.list(dir), ['B', '_', 'a', 'b', 'é']);
  });

  test('readBytes returns the half-open range', (t) => {
    const { files } = realPlatform();
    const p = join(tmp(t), 'f');
    writeFileSync(p, 'abcdefg');

    assert.equal(text(files.readBytes(p, 2, 5)), 'cde');
    assert.equal(text(files.readBytes(p, 0, 0)), '');
    assert.equal(text(files.readBytes(p, 5, 100)), 'fg');
  });

  test('readBytes of a file that does not exist throws', (t) => {
    const { files } = realPlatform();

    assert.throws(() => files.readBytes(join(tmp(t), 'missing'), 0, 1));
  });

  test('symlink replaces an existing link and readlink, lstat, stat, realpath follow it', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    const [t1, t2, l] = [join(dir, 't1'), join(dir, 't2'), join(dir, 'l')];
    writeFileSync(t1, '1');
    writeFileSync(t2, '2');

    files.symlink(t1, l);
    files.symlink(t2, l);

    assert.equal(files.readlink(l), t2);
    assert.equal(files.lstat(l)?.kind, 'symlink');
    assert.equal(files.stat(l)?.kind, 'file');
    assert.equal(files.realpath(l), files.realpath(t2));
    assert.equal(files.readText(l), '2');
    assert.deepEqual(files.list(dir), ['l', 't1', 't2']);
  });

  test('symlink replaces a regular file', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    const target = join(dir, 'target');
    writeFileSync(join(dir, 'l'), 'old');

    files.symlink(target, join(dir, 'l'));

    assert.equal(files.readlink(join(dir, 'l')), target);
  });

  test('a dangling symlink has an lstat but no stat', (t) => {
    const { files } = realPlatform();
    const l = join(tmp(t), 'l');

    files.symlink('/no/such/target', l);

    assert.equal(files.lstat(l)?.kind, 'symlink');
    assert.equal(files.stat(l), null);
    assert.equal(files.realpath(l), null);
  });

  test('readlink of a regular file is null', (t) => {
    const { files } = realPlatform();
    const p = join(tmp(t), 'f');
    writeFileSync(p, 'x');

    assert.equal(files.readlink(p), null);
  });

  test('mkdirp creates every level with the given mode', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);

    files.mkdirp(join(dir, 'a', 'b', 'c'), 0o700);
    files.mkdirp(join(dir, 'a', 'b', 'c'), 0o700);

    assert.equal(mode(join(dir, 'a', 'b', 'c')), 0o700);
    assert.equal(files.stat(join(dir, 'a', 'b', 'c'))?.kind, 'dir');
  });

  test('rename moves a file', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    writeFileSync(join(dir, 'from'), 'x');

    files.rename(join(dir, 'from'), join(dir, 'to'));

    assert.equal(files.readText(join(dir, 'from')), null);
    assert.equal(files.readText(join(dir, 'to')), 'x');
  });

  test('remove takes a file and a symlink away and does not mind a missing path', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    writeFileSync(join(dir, 'f'), 'x');
    symlinkSync(join(dir, 'f'), join(dir, 'l'));

    files.remove(join(dir, 'l'));
    files.remove(join(dir, 'f'));
    files.remove(join(dir, 'missing'));

    assert.deepEqual(files.list(dir), []);
  });

  test('removeTree removes a directory with contents and does not mind a missing path', (t) => {
    const { files } = realPlatform();
    const dir = tmp(t);
    mkdirSync(join(dir, 'd', 'e'), { recursive: true });
    writeFileSync(join(dir, 'd', 'e', 'f'), 'x');

    files.removeTree(join(dir, 'd'));
    files.removeTree(join(dir, 'd'));

    assert.equal(files.stat(join(dir, 'd')), null);
  });

  test('chmod changes the mode', (t) => {
    const { files } = realPlatform();
    const p = join(tmp(t), 'f');
    writeFileSync(p, 'x');

    files.chmod(p, 0o640);

    assert.equal(mode(p), 0o640);
  });
});

describe('real proc', () => {
  test('bootId is a UUID-shaped string', () => {
    assert.match(realPlatform().proc.bootId() ?? '', /^[0-9a-f-]{36}$/);
  });

  test('stat of this process starts with its pid and a parenthesised name', () => {
    const line = realPlatform().proc.stat(process.pid);

    assert.ok(line !== null && line.startsWith(`${process.pid} (`), String(line));
    assert.ok(!line.endsWith('\n'));
  });

  test('cmdline of this process contains the path of the Node.js binary', () => {
    const bytes = realPlatform().proc.cmdline(process.pid);

    assert.ok(bytes !== null);
    assert.ok(text(bytes).includes(process.execPath));
    assert.equal(bytes.at(-1), 0);
  });

  test('a process that does not exist reads as null', () => {
    const { proc } = realPlatform();

    assert.equal(proc.stat(999_999_999), null);
    assert.equal(proc.cmdline(999_999_999), null);
    assert.equal(proc.stat(-1), null);
    assert.equal(proc.stat(Number.NaN), null);
  });

  test('memAvailableMb is a positive whole number', () => {
    const mb = realPlatform().proc.memAvailableMb();

    assert.ok(mb !== null && mb > 0 && Number.isInteger(mb), String(mb));
  });
});

describe('real runner', () => {
  test('run reports exit code, both streams, and no timeout', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const result = await realPlatform().runner.run(
      'sh',
      ['-c', 'printf out; printf err >&2; exit 3'],
      {
        env: s.env(),
      },
    );

    assert.deepEqual(result, {
      code: 3,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
      notFound: false,
    });
  });

  test('run writes input to stdin', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'cat');

    const result = await realPlatform().runner.run('sh', ['-c', 'cat'], {
      input: 'x',
      env: s.env(),
    });

    assert.equal(result.stdout, 'x');
  });

  test('without input the child reads an empty stdin and does not wait', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'cat');

    const result = await realPlatform().runner.run('sh', ['-c', 'cat'], { env: s.env() });

    assert.equal(result.stdout, '');
    assert.equal(result.code, 0);
  });

  test('input is delivered whole even when the child does not read it', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const result = await realPlatform().runner.run('sh', ['-c', 'exit 0'], {
      input: 'x'.repeat(1_000_000),
      env: s.env(),
    });

    assert.equal(result.code, 0);
  });

  test('a child that outlives timeoutMs is killed', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'sleep');
    const started = Date.now();

    const result = await realPlatform().runner.run('sh', ['-c', 'sleep 5'], {
      timeoutMs: 100,
      env: s.env(),
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
    assert.equal(result.notFound, false);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  test('a grandchild that keeps the pipes open does not hold run past timeoutMs', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'sleep');
    const started = Date.now();

    const result = await realPlatform().runner.run('sh', ['-c', 'sleep 3 & printf x'], {
      timeoutMs: 200,
      env: s.env(),
    });

    assert.equal(result.stdout, 'x');
    assert.equal(result.code, 0);
    assert.equal(result.notFound, false);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  test('a signal that fires kills the child at once and run rejects with an AbortError', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'sleep');
    const controller = new AbortController();
    const started = Date.now();

    // The child's own child holds the pipes too: run must not wait for it either.
    const running = realPlatform().runner.run('sh', ['-c', 'sleep 5 & sleep 5'], {
      timeoutMs: 10_000,
      env: s.env(),
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 100);

    await assert.rejects(running, { name: 'AbortError' });
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  test('a signal that is already aborted starts nothing', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'touch');
    const controller = new AbortController();
    controller.abort();
    const marker = join(s.root, 'started');

    await assert.rejects(
      realPlatform().runner.run('sh', ['-c', `touch '${marker}'`], {
        env: s.env(),
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(marker), false);
  });

  test('a signal that fires after the child finished changes nothing', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const controller = new AbortController();

    const result = await realPlatform().runner.run('sh', ['-c', 'printf ok'], {
      env: s.env(),
      signal: controller.signal,
    });
    controller.abort();

    assert.equal(result.stdout, 'ok');
    assert.equal(result.code, 0);
  });

  test('a child that finishes before timeoutMs is not timed out', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const result = await realPlatform().runner.run('sh', ['-c', 'printf ok'], {
      timeoutMs: 5000,
      env: s.env(),
    });

    assert.deepEqual(result, {
      code: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      notFound: false,
    });
  });

  test('a program that does not exist is notFound, not an exception', async (t) => {
    const s = sandbox(t);

    const result = await realPlatform().runner.run('skydeck-no-such-program', [], { env: s.env() });

    assert.deepEqual(result, {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      notFound: true,
    });
  });

  test('the child sees only the environment it was given', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const result = await realPlatform().runner.run('sh', ['-c', 'printf %s "$HOME"'], {
      env: s.env(),
    });
    const none = await realPlatform().runner.run(
      'sh',
      ['-c', 'printf %s "${SKYDECK_ONLY_HERE-unset}"'],
      {
        env: s.env(),
      },
    );

    assert.equal(result.stdout, s.home);
    assert.equal(none.stdout, 'unset');
  });

  test('cwd is the child working directory', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const result = await realPlatform().runner.run('sh', ['-c', 'pwd'], {
      cwd: s.home,
      env: s.env(),
    });

    assert.equal(result.stdout, `${s.home}\n`);
  });

  test('arguments are passed as they are, never through a shell', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const result = await realPlatform().runner.run('sh', ['-c', 'printf %s "$0"', '$(echo x); *'], {
      env: s.env(),
    });

    assert.equal(result.stdout, '$(echo x); *');
  });

  test('runInteractive resolves with the exit code', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const code = await realPlatform().runner.runInteractive('sh', ['-c', 'exit 4'], {
      env: s.env(),
    });

    assert.equal(code, 4);
  });

  test('runInteractive of a program that does not exist resolves null', async (t) => {
    const s = sandbox(t);

    const code = await realPlatform().runner.runInteractive('skydeck-no-such-program', [], {
      env: s.env(),
    });

    assert.equal(code, null);
  });

  test('runInteractive of a child killed by a signal resolves null', async (t) => {
    const s = sandbox(t);
    s.link('sh');

    const code = await realPlatform().runner.runInteractive('sh', ['-c', 'kill -9 $$'], {
      env: s.env(),
    });

    assert.equal(code, null);
  });
});

describe('real platform', () => {
  test('uuid is a lowercase UUID and two calls differ', () => {
    const { uuid } = realPlatform();

    const [a, b] = [uuid(), uuid()];

    assert.match(a, UUID);
    assert.match(b, UUID);
    assert.notEqual(a, b);
  });

  test('home, cwd, node binary and version are those of this process', () => {
    const platform = realPlatform();

    assert.equal(platform.homeDir, homedir());
    assert.equal(platform.cwd, process.cwd());
    assert.equal(platform.nodePath, process.execPath);
    assert.equal(platform.nodeVersion, process.versions.node);
  });

  test('a working directory that no longer exists does not stop the platform being built', async (t) => {
    const s = sandbox(t);
    const script = join(s.root, 'check.mjs');
    writeFileSync(
      script,
      `
      import { realPlatform } from ${JSON.stringify(REAL_MODULE)};
      const platform = realPlatform();
      let cwd;
      try { cwd = platform.cwd; } catch (error) { cwd = error.message; }
      process.stdout.write(JSON.stringify({ home: typeof platform.homeDir, cwd }));
      `,
    );

    const result = await inRemovedDirectory(s, [script]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      home: 'string',
      cwd: 'the current directory no longer exists',
    });
  });

  test('the CLI still prints its version from a directory that no longer exists', async (t) => {
    const { appRoot } = realPlatform();

    const result = await inRemovedDirectory(sandbox(t), [
      `${appRoot}/bin/bootstrap.mjs`,
      '--version',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
  });

  test('appRoot is the checkout: no trailing slash, with bin/skydeck inside', () => {
    const { appRoot, files } = realPlatform();

    assert.ok(!appRoot.endsWith('/'), appRoot);
    assert.notEqual(files.stat(`${appRoot}/bin/skydeck`), null);
    assert.equal(JSON.parse(readFileSync(`${appRoot}/package.json`, 'utf8')).name, 'skydeck');
  });

  test('env holds the environment of this process', () => {
    process.env['SKYDECK_REAL_TEST'] = 'seen';
    try {
      assert.equal(realPlatform().env['SKYDECK_REAL_TEST'], 'seen');
    } finally {
      delete process.env['SKYDECK_REAL_TEST'];
    }
  });
});
