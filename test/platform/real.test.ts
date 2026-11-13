import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { on, once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { realPlatform } from '../../src/platform/real.ts';
import type { Detached, Platform, RunResult } from '../../src/platform/types.ts';
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

  test('every calls back every that many milliseconds until it is stopped', async () => {
    const { clock } = realPlatform();
    let calls = 0;

    const stop = clock.every(10, () => {
      calls++;
    });
    // Until it was called twice; a loaded machine may take its time, so the deadline is generous.
    const deadline = Date.now() + 10_000;
    while (calls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();
    const atStop = calls;
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(atStop >= 2, String(atStop));
    assert.equal(calls, atStop, 'nothing after it was stopped');
  });

  test('every refuses a period that is not a positive whole number of milliseconds', () => {
    const { clock } = realPlatform();

    for (const ms of [0, -5, 1.5, Number.NaN]) {
      assert.throws(() => clock.every(ms, () => {}), RangeError, String(ms));
    }
  });

  test('a timer of every does not keep the process alive', async (t) => {
    const s = sandbox(t);
    const script = [
      `const { realPlatform } = await import(${JSON.stringify(REAL_MODULE)});`,
      'realPlatform().clock.every(60_000, () => {});',
    ].join('\n');

    const result = await realPlatform().runner.run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: s.root, env: s.env(), timeoutMs: 20_000 },
    );

    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
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

/** Field `n` (1-based, as in proc(5)) of a /proc/<pid>/stat line. */
function statField(line: string, n: number): string | undefined {
  return line
    .slice(line.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)[n - 3];
}

/** Waits until `check()` is true, at most `ms`. */
async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** Ends a detached child the test started itself, unless it already ended. */
function endAfter(t: TestContext, platform: Platform, child: Detached): void {
  let ended = false;
  void child.exited.then(() => {
    ended = true;
  });
  t.after(async () => {
    if (!ended) {
      platform.processes.signal(child.pid, 'SIGKILL');
      await child.exited;
    }
  });
}

describe('real clock: after', () => {
  test('calls back once after that many milliseconds', async () => {
    const { clock } = realPlatform();
    let calls = 0;
    const started = Date.now();

    clock.after(20, () => {
      calls++;
    });
    assert.ok(await until(() => calls === 1));
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(calls, 1);
    assert.ok(Date.now() - started >= 15, `after ${Date.now() - started} ms`);
  });

  test('the returned function cancels it, and calling it again does nothing', async () => {
    const { clock } = realPlatform();
    let calls = 0;

    const cancel = clock.after(10, () => {
      calls++;
    });
    cancel();
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(calls, 0);
  });

  test('refuses a time that is not a whole number of milliseconds a timer can wait', () => {
    const { clock } = realPlatform();

    for (const ms of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      assert.throws(() => clock.after(ms, () => {}), RangeError, String(ms));
    }
  });

  test('a timer of after does not keep the process alive', async (t) => {
    const s = sandbox(t);
    const script = [
      `const { realPlatform } = await import(${JSON.stringify(REAL_MODULE)});`,
      'realPlatform().clock.after(60_000, () => {});',
    ].join('\n');

    const result = await realPlatform().runner.run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: s.root, env: s.env(), timeoutMs: 20_000 },
    );

    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
  });
});

describe('real files: mode and owner', () => {
  test('stat and lstat report the permission bits and the owner', (t) => {
    const dir = tmp(t);
    const file = join(dir, 'f');
    writeFileSync(file, 'x');
    chmodSync(file, 0o640);
    mkdirSync(join(dir, 'd'), { mode: 0o700 });
    chmodSync(join(dir, 'd'), 0o2750);
    const { files } = realPlatform();

    const info = files.stat(file);

    assert.equal(info?.mode, 0o640);
    assert.equal(info.uid, process.getuid?.());
    assert.equal(files.lstat(file)?.mode, 0o640);
    assert.equal(files.stat(join(dir, 'd'))?.mode, 0o2750, 'the set-group-id bit is kept');
  });
});

describe('real proc: fdTarget and tcpListening', () => {
  test('fdTarget reads the link of an open descriptor; null when there is none', () => {
    const { proc } = realPlatform();

    assert.equal(typeof proc.fdTarget(process.pid, 0), 'string');
    assert.equal(proc.fdTarget(process.pid, 999_999), null);
    assert.equal(proc.fdTarget(999_999_999, 0), null);
    assert.equal(proc.fdTarget(-1, 0), null);
    assert.equal(proc.fdTarget(process.pid, -1), null);
    assert.equal(proc.fdTarget(process.pid, 1.5), null);
  });

  test('fdTarget names the file a descriptor holds open', (t) => {
    const file = join(tmp(t), 'held');
    writeFileSync(file, '');
    const fd = openSync(file, 'r');
    t.after(() => {
      closeSync(fd);
    });

    assert.equal(realPlatform().proc.fdTarget(process.pid, fd), realpathSync(file));
  });

  test('tcpListening is true for a port this process listens on and false once it closed', async () => {
    const { proc, net } = realPlatform();
    const listener = await net.listenHttp(
      { host: '127.0.0.1', port: 0 },
      { request: (_req, res) => res.end() },
    );

    assert.equal(proc.tcpListening(listener.port), true);
    await listener.close();
    assert.equal(proc.tcpListening(listener.port), false);
  });

  test('tcpListening is false for a port nothing can listen on', () => {
    const { proc } = realPlatform();

    for (const port of [0, -1, 65_536, 1.5]) {
      assert.equal(proc.tcpListening(port), false, String(port));
    }
  });
});

describe('real platform: randomness and identity', () => {
  test('randomBytes gives that many bytes, different each time', () => {
    const { randomBytes } = realPlatform();

    const [a, b] = [randomBytes(4), randomBytes(4)];

    assert.ok(a instanceof Uint8Array);
    assert.equal(a.length, 4);
    assert.equal(b.length, 4);
    assert.notDeepEqual([...a], [...b]);
    assert.equal(randomBytes(0).length, 0);
  });

  test('pid, uid and userName are those of this process', () => {
    const platform = realPlatform();

    assert.equal(platform.pid, process.pid);
    assert.equal(platform.uid, process.getuid?.());
    assert.equal(platform.userName, userInfo().username);
  });
});

describe('real processes: startDetached', () => {
  test('the child gets the input, and exited resolves with its exit code', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const { processes } = realPlatform();

    const child = await processes.startDetached(
      'sh',
      ['-c', 'echo $$ > f; read x; echo "$x" >> f; exit 3'],
      { cwd: s.root, env: s.env(), input: 'spec' },
    );

    assert.deepEqual(await child.exited, { code: 3, signal: null });
    assert.equal(readFileSync(join(s.root, 'f'), 'utf8'), `${child.pid}\nspec\n`);
  });

  test('the child runs in a session of its own, and signal ends it', async (t) => {
    const s = sandbox(t);
    s.link('sleep');
    const platform = realPlatform();
    const child = await platform.processes.startDetached('sleep', ['30'], {
      cwd: s.root,
      env: s.env(),
    });
    endAfter(t, platform, child);

    const stat = platform.proc.stat(child.pid);

    assert.ok(stat !== null, 'the child is running');
    assert.equal(statField(stat, 6), String(child.pid), 'session id = its own pid (setsid)');
    assert.notEqual(statField(stat, 6), statField(platform.proc.stat(process.pid) ?? '', 6));
    assert.equal(platform.processes.signal(child.pid, 'SIGTERM'), true);
    assert.deepEqual(await child.exited, { code: null, signal: 'SIGTERM' });
    assert.ok(await until(() => platform.proc.stat(child.pid) === null), 'reaped');
  });

  test('stdout and stderr are appended to their files, created with mode 0o600', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const { processes } = realPlatform();
    const out = join(s.root, 'out.log');
    const err = join(s.root, 'err.log');
    const options = { cwd: s.root, env: s.env(), stdoutTo: out, stderrTo: err };

    for (let i = 0; i < 2; i++) {
      const child = await processes.startDetached(
        'sh',
        ['-c', 'printf out; printf err >&2'],
        options,
      );
      await child.exited;
    }

    assert.equal(readFileSync(out, 'utf8'), 'outout');
    assert.equal(readFileSync(err, 'utf8'), 'errerr');
    assert.equal(mode(out), 0o600);
    assert.equal(mode(err), 0o600);
  });

  test('without files the output goes nowhere and without input stdin is empty', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'cat');
    const { processes } = realPlatform();

    const child = await processes.startDetached('sh', ['-c', 'cat > got; printf ignored'], {
      cwd: s.root,
      env: s.env(),
    });

    assert.deepEqual(await child.exited, { code: 0, signal: null });
    assert.equal(readFileSync(join(s.root, 'got'), 'utf8'), '');
  });

  test('the child sees only the environment it was given, in its working directory', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const { processes } = realPlatform();
    const dir = join(s.root, 'work');
    mkdirSync(dir);

    const child = await processes.startDetached('sh', ['-c', 'echo "$X|$HOME|$(pwd)" > seen'], {
      cwd: dir,
      env: { PATH: s.bin, X: 'x' },
    });
    await child.exited;

    assert.equal(readFileSync(join(dir, 'seen'), 'utf8'), `x||${dir}\n`);
  });

  test('a program or a working directory that does not exist rejects with ENOENT', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const { processes } = realPlatform();

    await assert.rejects(
      processes.startDetached('no-such-program', [], { cwd: s.root, env: s.env() }),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      processes.startDetached('sh', ['-c', 'exit 0'], {
        cwd: join(s.root, 'missing'),
        env: s.env(),
      }),
      { code: 'ENOENT' },
    );
  });

  test('the child does not keep this process alive', async (t) => {
    const s = sandbox(t);
    s.link('sleep');
    const script = [
      `const { realPlatform } = await import(${JSON.stringify(REAL_MODULE)});`,
      `const child = await realPlatform().processes.startDetached('sleep', ['30'], { cwd: ${JSON.stringify(s.root)}, env: { PATH: ${JSON.stringify(s.bin)} }, input: 'x' });`,
      'process.stdout.write(String(child.pid));',
    ].join('\n');
    const platform = realPlatform();
    const started = Date.now();

    const result = await platform.runner.run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: s.root, env: s.env(), timeoutMs: 20_000 },
    );
    const pid = Number(result.stdout);
    const cmdline = text(platform.proc.cmdline(pid) ?? new Uint8Array());
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // gone already
    }
    // Only the sleep our own child started: its command line, and its working directory in the sandbox.
    if (cmdline === 'sleep\x0030\x00' && cwd === s.root) {
      platform.processes.signal(pid, 'SIGKILL');
    }

    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
    assert.match(cmdline, /sleep\x0030\x00$/, 'the sleep was still running after its parent ended');
  });
});

describe('real processes: signal', () => {
  test('refuses a pid that would signal a group or every process, without sending anything', (t) => {
    // If the refusal ever regressed, this test must not end every process of the user: kill is a stub.
    const kill = t.mock.method(process, 'kill', () => true);
    const { processes } = realPlatform();

    for (const pid of [0, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => processes.signal(pid, 'SIGTERM'), RangeError, String(pid));
    }

    assert.equal(kill.mock.callCount(), 0);
  });

  test('a pid above any the kernel gives is false, and nothing is sent', (t) => {
    const kill = t.mock.method(process, 'kill', () => true);
    const { processes } = realPlatform();

    assert.equal(processes.signal(2 ** 31, 'SIGKILL'), false);
    assert.equal(processes.signal(Number.MAX_SAFE_INTEGER, 'SIGKILL'), false);
    assert.equal(kill.mock.callCount(), 0);
  });

  test('a pid that does not exist is false', () => {
    assert.equal(realPlatform().processes.signal(999_999_999, 'SIGKILL'), false);
  });
});

describe('real net', () => {
  test('listenHttp on 127.0.0.1 port 0 answers a request on the port the system picked', async (t) => {
    const { net } = realPlatform();
    const listener = await net.listenHttp(
      { host: '127.0.0.1', port: 0 },
      { request: (req, res) => res.end(`hello ${req.url}`) },
    );
    t.after(() => listener.close());

    const answer = await fetch(`http://127.0.0.1:${listener.port}/x`);

    assert.ok(listener.port > 0);
    assert.equal(await answer.text(), 'hello /x');
  });

  test('a second listen on a port that is taken rejects with EADDRINUSE', async (t) => {
    const { net } = realPlatform();
    const handlers = { request: (_req: IncomingMessage, res: ServerResponse) => res.end() };
    const first = await net.listenHttp({ host: '127.0.0.1', port: 0 }, handlers);
    t.after(() => first.close());

    await assert.rejects(net.listenHttp({ host: '127.0.0.1', port: first.port }, handlers), {
      code: 'EADDRINUSE',
    });
  });

  test('a unix socket has mode 0o600, port 0, and requestUnix reaches it with a JSON body', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp(
      { path },
      {
        request(req, res) {
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk: string) => {
            body += chunk;
          });
          req.on('end', () => {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                method: req.method,
                url: req.url,
                type: req.headers['content-type'] ?? null,
                body: body === '' ? null : JSON.parse(body),
              }),
            );
          });
        },
      },
    );
    t.after(() => listener.close());

    const posted = await net.requestUnix(path, {
      method: 'POST',
      path: '/new',
      body: { dir: '/x', flags: ['-a'] },
      timeoutMs: 5000,
    });
    const got = await net.requestUnix(path, { method: 'GET', path: '/ping', timeoutMs: 5000 });

    assert.equal(lstatSync(path).isSocket(), true);
    assert.equal(mode(path), 0o600);
    assert.equal(listener.port, 0);
    assert.deepEqual(posted, {
      status: 201,
      body: {
        method: 'POST',
        url: '/new',
        type: 'application/json',
        body: { dir: '/x', flags: ['-a'] },
      },
    });
    assert.deepEqual(got.body, { method: 'GET', url: '/ping', type: null, body: null });
  });

  test('requestUnix gives a body that is not JSON as text, and an empty one as null', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp(
      { path },
      { request: (req, res) => res.end(req.url === '/text' ? 'not json' : '') },
    );
    t.after(() => listener.close());

    const textAnswer = await net.requestUnix(path, {
      method: 'GET',
      path: '/text',
      timeoutMs: 5000,
    });
    const empty = await net.requestUnix(path, { method: 'GET', path: '/empty', timeoutMs: 5000 });

    assert.deepEqual(textAnswer, { status: 200, body: 'not json' });
    assert.deepEqual(empty, { status: 200, body: null });
  });

  test('requestUnix rejects with ENOENT for a missing socket and ECONNREFUSED for a stale one', async (t) => {
    const s = sandbox(t);
    const { net } = realPlatform();
    const live = join(s.root, 'live.sock');
    const stale = join(s.root, 'stale.sock');
    const listener = await net.listenHttp({ path: live }, { request: (_req, res) => res.end() });
    linkSync(live, stale); // a second name for the socket, left behind when the server goes
    await listener.close();
    const request = { method: 'GET', path: '/ping', timeoutMs: 5000 } as const;

    await assert.rejects(net.requestUnix(join(s.root, 'missing.sock'), request), {
      code: 'ENOENT',
    });
    await assert.rejects(net.requestUnix(stale, request), { code: 'ECONNREFUSED' });
    await assert.rejects(net.connectUnix(join(s.root, 'missing.sock')), { code: 'ENOENT' });
    await assert.rejects(net.connectUnix(stale), { code: 'ECONNREFUSED' });
  });

  test('requestUnix to a server that never answers rejects with ETIMEDOUT after the timeout', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp({ path }, { request: () => {} });
    t.after(() => listener.close());
    const started = Date.now();

    await assert.rejects(net.requestUnix(path, { method: 'GET', path: '/', timeoutMs: 200 }), {
      code: 'ETIMEDOUT',
    });
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });

  test('onLine gets each line of a streamed body as it comes, and the body is then null', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    let more: (() => void) | undefined;
    const listener = await net.listenHttp(
      { path },
      {
        request(_req, res) {
          res.write('{"a":1}\n');
          more = () => {
            res.end('{"b":2}\n\n{"c":3}');
          };
        },
      },
    );
    t.after(() => listener.close());
    const lines: string[] = [];

    const answer = net.requestUnix(path, {
      method: 'POST',
      path: '/restore',
      body: { all: true },
      timeoutMs: 5000,
      onLine: (line) => {
        lines.push(line);
        if (lines.length === 1) {
          more?.();
        }
      },
    });

    assert.deepEqual(await answer, { status: 200, body: null });
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '', '{"c":3}']);
  });

  test('a streamed answer that keeps coming is not cut off by the timeout', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp(
      { path },
      {
        request(_req, res) {
          let n = 0;
          const timer = setInterval(() => {
            n++;
            if (n === 40) {
              clearInterval(timer);
              res.end('end\n');
            } else {
              res.write(`${n}\n`);
            }
          }, 20);
        },
      },
    );
    t.after(() => listener.close());
    const lines: string[] = [];

    const started = Date.now();

    await net.requestUnix(path, {
      method: 'GET',
      path: '/',
      timeoutMs: 500,
      onLine: (line) => lines.push(line),
    });

    assert.ok(Date.now() - started > 500, 'the stream outlasted the timeout');
    assert.deepEqual(lines, [...Array.from({ length: 39 }, (_, i) => String(i + 1)), 'end']);
  });

  test('connectUnix gives a connected socket', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp({ path }, { request: (_req, res) => res.end('ok') });
    t.after(() => listener.close());

    const socket = await net.connectUnix(path);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    let answer = '';
    socket.setEncoding('utf8');
    for await (const chunk of socket) {
      answer += String(chunk);
    }

    assert.match(answer, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nok$/);
  });

  test('an upgrade request reaches the upgrade handler with its socket', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp(
      { path },
      {
        request: (_req, res) => res.end('no upgrade'),
        upgrade(req, socket) {
          socket.end(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\nX-Url: ${req.url}\r\n\r\n`,
          );
        },
      },
    );
    t.after(() => listener.close());

    const socket = await net.connectUnix(path);
    socket.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
    let answer = '';
    socket.setEncoding('utf8');
    for await (const chunk of socket) {
      answer += String(chunk);
    }

    assert.match(answer, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(answer, /X-Url: \/ws\r\n/);
  });

  test('close ends open connections instead of waiting for them, and removes the socket file', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp(
      { path },
      {
        request: () => {},
        upgrade: () => {},
      },
    );
    const idle = await net.connectUnix(path);
    const upgraded = await net.connectUnix(path);
    upgraded.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
    const pending = net.requestUnix(path, { method: 'GET', path: '/', timeoutMs: 10_000 });
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = [idle, upgraded].map((socket) => once(socket, 'close'));

    await listener.close();
    await Promise.all(closed);

    await assert.rejects(pending);
    assert.equal(existsSync(path), false);
    t.after(() => {
      idle.destroy();
      upgraded.destroy();
    });
  });
});

describe('the Windows guard (A32)', () => {
  /** Programs that write `ran:<name>` into `marker` if they are ever started. */
  function stubs(s: Sandbox): { marker: string; write: (path: string) => void } {
    const marker = join(s.root, 'marker');
    const write = (path: string): void => {
      writeFileSync(path, `#!/bin/sh\necho "ran:$0" >> ${JSON.stringify(marker)}\n`, {
        mode: 0o755,
      });
    };
    for (const name of ['cmd.exe', 'X.EXE', 'stub.exe']) {
      write(join(s.bin, name));
    }
    return { marker, write };
  }

  /** realPlatform() built while this process's environment has SKYDECK_TEST_NO_WINDOWS = `value`. */
  function realPlatformWith(value: string | undefined): Platform {
    const saved = process.env['SKYDECK_TEST_NO_WINDOWS'];
    if (value === undefined) {
      delete process.env['SKYDECK_TEST_NO_WINDOWS'];
    } else {
      process.env['SKYDECK_TEST_NO_WINDOWS'] = value;
    }
    try {
      return realPlatform();
    } finally {
      if (saved === undefined) {
        delete process.env['SKYDECK_TEST_NO_WINDOWS'];
      } else {
        process.env['SKYDECK_TEST_NO_WINDOWS'] = saved;
      }
    }
  }

  /** Every way the platform starts a program, each expected to refuse `command`. */
  async function assertRefused(
    platform: Platform,
    s: Sandbox,
    command: string,
    env: Record<string, string>,
  ): Promise<void> {
    const options = { cwd: s.root, env };
    await assert.rejects(
      platform.processes.startDetached(command, ['--version'], options),
      {
        code: 'EWINDOWS',
      },
      `startDetached ${command}`,
    );
    await assert.rejects(
      platform.runner.run(command, ['--version'], options),
      {
        code: 'EWINDOWS',
      },
      `run ${command}`,
    );
    await assert.rejects(
      platform.runner.runInteractive(command, ['--version'], options),
      {
        code: 'EWINDOWS',
      },
      `runInteractive ${command}`,
    );
  }

  // A sandbox stub first: if the guard were broken, the real wsl.exe that comes after would run.
  const WINDOWS = [
    'cmd.exe',
    'X.EXE',
    '/mnt/skydeck-test-none/program',
    '/mnt/c/x/msedge.exe',
    '/mnt/c/Windows/System32/wsl.exe',
  ];

  test('with SKYDECK_TEST_NO_WINDOWS=1 nothing under /mnt/ or ending in .exe is started', async (t) => {
    const s = sandbox(t);
    const { marker } = stubs(s);
    const platform = realPlatformWith('1');

    for (const command of WINDOWS) {
      await assertRefused(platform, s, command, { PATH: s.bin });
    }

    assert.equal(existsSync(marker), false, 'no stub ran');
  });

  test('the variable in the environment given to the child is enough', async (t) => {
    const s = sandbox(t);
    const { marker } = stubs(s);
    const platform = realPlatformWith(undefined);

    for (const command of ['cmd.exe', 'X.EXE', '/mnt/skydeck-test-none/program']) {
      await assertRefused(platform, s, command, s.env());
    }

    assert.equal(existsSync(marker), false, 'no stub ran');
  });

  test('a name that leads to a program ending in .exe through a link is refused too', async (t) => {
    const s = sandbox(t);
    const { marker, write } = stubs(s);
    mkdirSync(join(s.root, 'win'));
    write(join(s.root, 'win', 'edge.exe'));
    symlinkSync(join(s.root, 'win', 'edge.exe'), join(s.bin, 'edge'));
    symlinkSync(join(s.root, 'win', 'edge.exe'), join(s.root, 'edge-link'));
    const platform = realPlatformWith('1');

    await assertRefused(platform, s, 'edge', { PATH: s.bin });
    await assertRefused(platform, s, join(s.root, 'edge-link'), { PATH: s.bin });
    await assertRefused(platform, s, './edge-link', { PATH: s.bin });

    assert.equal(existsSync(marker), false, 'no stub ran');
  });

  test('nothing a caller passes turns the refusal off while the variable is set', async (t) => {
    const s = sandbox(t);
    const { marker } = stubs(s);
    const saved = process.env['SKYDECK_TEST_NO_WINDOWS'];
    process.env['SKYDECK_TEST_NO_WINDOWS'] = '1';
    let platforms: Platform[];
    try {
      platforms = [
        realPlatform({ refuseWindows: false }),
        realPlatform({}),
        realPlatform({ refuseWindows: undefined }),
      ];
    } finally {
      if (saved === undefined) {
        delete process.env['SKYDECK_TEST_NO_WINDOWS'];
      } else {
        process.env['SKYDECK_TEST_NO_WINDOWS'] = saved;
      }
    }

    for (const platform of platforms) {
      await assertRefused(platform, s, 'cmd.exe', { PATH: s.bin });
    }

    assert.equal(existsSync(marker), false, 'no stub ran');
  });

  test('refuseWindows refuses always, whatever the environment says', async (t) => {
    const s = sandbox(t);
    const { marker } = stubs(s);
    const saved = process.env['SKYDECK_TEST_NO_WINDOWS'];
    delete process.env['SKYDECK_TEST_NO_WINDOWS'];
    let platform: Platform;
    try {
      platform = realPlatform({ refuseWindows: true });
    } finally {
      if (saved !== undefined) {
        process.env['SKYDECK_TEST_NO_WINDOWS'] = saved;
      }
    }

    for (const command of ['cmd.exe', 'X.EXE', '/mnt/skydeck-test-none/program']) {
      await assertRefused(platform, s, command, s.env({ SKYDECK_TEST_NO_WINDOWS: undefined }));
    }

    assert.equal(existsSync(marker), false, 'no stub ran');
  });

  test('a path is judged as the kernel follows it: a link to a directory, then ..', async (t) => {
    const s = sandbox(t);
    const { marker, write } = stubs(s);
    mkdirSync(join(s.root, 'win'));
    write(join(s.root, 'win', 'tool.exe'));
    mkdirSync(join(s.root, 'x', 'y'), { recursive: true });
    symlinkSync(join(s.root, 'win', 'tool.exe'), join(s.root, 'x', 'alias'));
    mkdirSync(join(s.root, 'a'));
    symlinkSync(join(s.root, 'x', 'y'), join(s.root, 'a', 'link'));
    const platform = realPlatformWith('1');

    // The text a/link/../alias normalises to a/alias, which does not exist; the kernel reaches tool.exe.
    await assertRefused(platform, s, join(s.root, 'a', 'link') + '/../alias', { PATH: s.bin });
    await assertRefused(platform, s, 'a/link/../alias', { PATH: s.bin });

    assert.equal(existsSync(marker), false, 'no stub ran');
  });

  test('every directory of PATH is judged, not only the first that has the name', async (t) => {
    const s = sandbox(t);
    const { marker, write } = stubs(s);
    for (const dir of ['p1', 'p2', 'win']) {
      mkdirSync(join(s.root, dir));
    }
    // p1/prog cannot be run (its interpreter does not exist), so execvp goes on to p2/prog.
    writeFileSync(join(s.root, 'p1', 'prog'), '#!/skydeck-test-none/interpreter\n', {
      mode: 0o755,
    });
    write(join(s.root, 'win', 'prog.exe'));
    symlinkSync(join(s.root, 'win', 'prog.exe'), join(s.root, 'p2', 'prog'));
    const platform = realPlatformWith('1');

    await assertRefused(platform, s, 'prog', {
      PATH: `${join(s.root, 'p1')}:${join(s.root, 'p2')}`,
    });

    assert.equal(existsSync(marker), false, 'no stub ran');
  });

  test('a PATH directory under /mnt/ that does not hold the program refuses nothing', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const platform = realPlatformWith('1');

    const result = await platform.runner.run('sh', ['-c', 'printf ran'], {
      env: { PATH: `${s.bin}:/mnt/skydeck-test-none/bin` },
    });

    assert.equal(result.stdout, 'ran');
  });

  test('a program that is a FIFO does not block the guard: it is judged without being opened', async (t) => {
    const s = sandbox(t);
    s.link('sh', 'mkfifo');
    const fifo = join(s.root, 'tool');
    const made = await realPlatform().runner.run('mkfifo', ['-m', '644', fifo], { env: s.env() });
    assert.equal(made.code, 0, made.stderr);
    // In a child: were the guard to open the FIFO, it would block that process, not this one.
    const script = [
      `const { realPlatform } = await import(${JSON.stringify(REAL_MODULE)});`,
      'const platform = realPlatform({ refuseWindows: true });',
      `const outcome = await platform.processes.startDetached(${JSON.stringify(fifo)}, [], { cwd: ${JSON.stringify(s.root)}, env: { PATH: ${JSON.stringify(s.bin)} } }).then(() => 'started', (error) => error.code);`,
      'process.stdout.write(String(outcome));',
    ].join('\n');

    const result = await realPlatform().runner.run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: s.root, env: s.env(), timeoutMs: 10_000 },
    );

    assert.equal(result.timedOut, false, 'the guard blocked on the FIFO');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'EACCES', 'not refused as Windows, and a FIFO cannot be run');
  });

  test('a file that starts with MZ (what WSL interop runs) is refused whatever its name', async (t) => {
    const s = sandbox(t);
    stubs(s);
    // The two bytes only, and not executable: should the guard ever fail, the start fails with
    // EACCES and nothing runs.
    writeFileSync(join(s.root, 'tool'), 'MZ', { mode: 0o644 });
    const platform = realPlatformWith('1');

    await assertRefused(platform, s, join(s.root, 'tool'), { PATH: s.bin });
    await assertRefused(platform, s, './tool', { PATH: s.bin });
  });

  test('without the variable a sandbox script named stub.exe runs: the rule is the variable, not a ban', async (t) => {
    const s = sandbox(t);
    const { marker } = stubs(s);
    const platform = realPlatformWith(undefined);
    const env = s.env({ SKYDECK_TEST_NO_WINDOWS: undefined });

    const child = await platform.processes.startDetached('stub.exe', [], { cwd: s.root, env });
    await child.exited;
    const result = await platform.runner.run('stub.exe', [], { cwd: s.root, env });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), `ran:${s.bin}/stub.exe\n`.repeat(2));
  });

  test('a program that is not a Windows one still runs with the variable set', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const platform = realPlatformWith('1');

    const result = await platform.runner.run('sh', ['-c', 'printf ok'], { env: s.env() });

    assert.equal(result.stdout, 'ok');
  });
});

describe('real proc: a read that fails is not a process that is gone (ruling)', () => {
  test('stat and bootId throw for EMFILE, naming the file; cmdline and the others still read as null', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const script = [
      `import { openSync } from 'node:fs';`,
      `const { realPlatform } = await import(${JSON.stringify(REAL_MODULE)});`,
      'const { proc } = realPlatform();',
      'const held = [];',
      'try { for (;;) held.push(openSync("/dev/null", "r")); } catch (error) { if (error.code !== "EMFILE") throw error; }',
      'const outcome = (read) => { try { return { value: read() }; } catch (error) { return { code: error.code, name: error.name, message: error.message }; } };',
      'process.stdout.write(JSON.stringify({',
      '  stat: outcome(() => proc.stat(process.pid)),',
      '  bootId: outcome(() => proc.bootId()),',
      '  cmdline: outcome(() => proc.cmdline(process.pid)),',
      '  memAvailableMb: outcome(() => proc.memAvailableMb()),',
      '}));',
    ].join('\n');

    const result = await realPlatform().runner.run(
      'sh',
      ['-c', 'ulimit -n 64 && exec "$NODE" --input-type=module -e "$1"', 'sh', script],
      { cwd: s.root, env: s.env({ NODE: process.execPath }), timeoutMs: 20_000 },
    );
    const got = JSON.parse(result.stdout) as Record<string, Record<string, unknown>>;

    assert.equal(result.code, 0, result.stderr);
    assert.equal(got['stat']?.['code'], 'EMFILE');
    assert.equal(got['stat']?.['name'], 'SkydeckError');
    assert.match(String(got['stat']?.['message']), /^cannot read \/proc\/\d+\/stat \(EMFILE\)$/);
    assert.equal(got['bootId']?.['code'], 'EMFILE');
    assert.match(String(got['bootId']?.['message']), /\/proc\/sys\/kernel\/random\/boot_id/);
    assert.deepEqual(got['cmdline'], { value: null });
    assert.deepEqual(got['memAvailableMb'], { value: null });
  });

  test('a pid that is not there is null, not an error', () => {
    const { proc } = realPlatform();

    assert.equal(proc.stat(999_999_999), null);
    assert.notEqual(proc.bootId(), null);
  });
});

/** The local address (hex, as /proc/net/tcp writes it) of the socket listening on `port`. */
function listeningAddress(port: number): string | null {
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
      const [, local, , state] = line.trim().split(/\s+/);
      if (
        state === '0A' &&
        local !== undefined &&
        Number.parseInt(local.split(':')[1] ?? '', 16) === port
      ) {
        return local.split(':')[0] ?? null;
      }
    }
  }
  return null;
}

describe('real net and processes: what the review asked to pin', () => {
  test('listenHttp listens on the loopback address whatever host it is handed', async (t) => {
    const { net } = realPlatform();
    const listener = await net.listenHttp(
      { host: '0.0.0.0' as '127.0.0.1', port: 0 },
      { request: (_req, res) => res.end() },
    );
    t.after(() => listener.close());

    assert.equal(listeningAddress(listener.port), '0100007F');
  });

  test('requestUnix refuses a timeout no timer can wait, with a RangeError', async (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'server.sock');
    const { net } = realPlatform();
    const listener = await net.listenHttp({ path }, { request: (_req, res) => res.end('{}') });
    t.after(() => listener.close());

    for (const timeoutMs of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await assert.rejects(
        net.requestUnix(path, { method: 'GET', path: '/', timeoutMs }),
        RangeError,
        String(timeoutMs),
      );
    }
  });

  test('a missing directory for stdoutTo or stderrTo rejects with ENOENT and starts nothing', async (t) => {
    const s = sandbox(t);
    s.link('sh');
    const { processes } = realPlatform();
    const ran = join(s.root, 'ran');

    for (const where of [
      { stdoutTo: join(s.root, 'missing', 'out') },
      { stderrTo: join(s.root, 'missing', 'err') },
    ]) {
      await assert.rejects(
        processes.startDetached('sh', ['-c', `echo x > ${ran}`], {
          cwd: s.root,
          env: s.env(),
          ...where,
        }),
        { code: 'ENOENT' },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(existsSync(ran), false);
  });
});
