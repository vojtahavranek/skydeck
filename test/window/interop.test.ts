import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Files, Net, Platform } from '../../src/platform/types.ts';
import { createInterop, createInteropFrom, probeSocket } from '../../src/window/interop.ts';
import { runtimeFiles } from '../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../src/window/runtime.ts';
import { testPlatform } from '../helpers/platform.ts';
import type { FakeClock } from '../helpers/platform.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

// The candidates are unix sockets in the sandbox; the first one (S2 6.4's /run/WSL/1_interop) is
// always pointed into it, and the one test of the default reaches no socket at all. No test links
// or connects to the real /run/WSL/1_interop (A32).

interface Setup {
  platform: Platform;
  clock: FakeClock;
  sandbox: Sandbox;
  files: RuntimeFiles;
  /** A path in the sandbox for a candidate socket. */
  path(name: string): string;
  /** A unix socket that accepts connections, closed when the test ends (or by `close`). */
  listen(name: string): Promise<{ path: string; close(): Promise<void> }>;
  /** Where the link points; null when there is no link. */
  linkTarget(): string | null;
}

function setup(t: TestContext, env: Record<string, string | undefined> = {}): Setup {
  const tp = testPlatform(t, { env: { WSL_INTEROP: undefined, ...env } });
  const sockets = join(tp.sandbox.root, 's');
  mkdirSync(sockets);
  const dir = join(tp.sandbox.root, 'run');
  mkdirSync(join(dir, 'terms'), { recursive: true, mode: 0o700 });
  const files = runtimeFiles(dir);
  return {
    platform: tp.platform,
    clock: tp.clock,
    sandbox: tp.sandbox,
    files,
    path: (name) => join(sockets, name),
    async listen(name) {
      const path = join(sockets, name);
      const listener = await tp.platform.net.listenHttp(
        { path },
        {
          request: (_req, res) => {
            res.end();
          },
        },
      );
      let closed = false;
      const close = async (): Promise<void> => {
        if (!closed) {
          closed = true;
          await listener.close();
        }
      };
      t.after(close);
      return { path, close };
    },
    linkTarget() {
      try {
        return lstatSync(files.interop).isSymbolicLink() ? readlinkSync(files.interop) : null;
      } catch {
        return null;
      }
    },
  };
}

/** A file that is not a socket: connecting to it is refused. */
function notASocket(s: Setup, name: string): string {
  const path = s.path(name);
  writeFileSync(path, '');
  return path;
}

function keepAliveSays(s: Setup, text: string): void {
  writeFileSync(s.files.keepaliveInterop, text);
}

test('probeSocket closes the connection it made and leaves no timer', async (t) => {
  const s = setup(t);
  const a = await s.listen('first');
  const made: import('node:net').Socket[] = [];
  const platform: Platform = {
    ...s.platform,
    net: {
      ...s.platform.net,
      connectUnix: async (path) => {
        const socket = await s.platform.net.connectUnix(path);
        made.push(socket);
        return socket;
      },
    },
  };
  assert.equal(await probeSocket(platform, a.path), 'accepts');
  assert.equal(made.length, 1);
  assert.equal(made[0]?.destroyed, true);
  assert.equal(s.clock.timers(), 0);
});

test('probeSocket: refused for ECONNREFUSED and ENOENT, unknown for anything else', async (t) => {
  const s = setup(t);
  assert.equal(await probeSocket(s.platform, notASocket(s, 'file')), 'refused');
  assert.equal(await probeSocket(s.platform, s.path('missing')), 'refused');
  assert.equal(await probeSocket(s.platform, join(notASocket(s, 'f2'), 'below')), 'unknown');
  for (const path of [null, '', 'relative', '/a\n/b']) {
    assert.equal(await probeSocket(s.platform, path), 'unknown', JSON.stringify(path));
  }
  assert.equal(s.clock.timers(), 0);
});

test('current() is null before the first refresh', (t) => {
  const s = setup(t);
  const interop = createInteropFrom(s.platform, s.files, s.path('first'));
  assert.equal(interop.current(), null);
});

test('the link points at the first candidate when it accepts a connection', async (t) => {
  const s = setup(t);
  const a = await s.listen('first');
  const b = await s.listen('keepalive');
  keepAliveSays(s, b.path);
  const own = await s.listen('own');
  const platform = { ...s.platform, env: { ...s.platform.env, WSL_INTEROP: own.path } };
  const interop = createInteropFrom(platform, s.files, a.path);
  assert.equal(await interop.refresh(), s.files.interop);
  assert.equal(interop.current(), s.files.interop);
  assert.equal(s.linkTarget(), a.path);
});

test("the keep-alive's socket from keepalive.interop when the first refuses", async (t) => {
  const s = setup(t);
  const b = await s.listen('keepalive');
  keepAliveSays(s, b.path);
  const own = await s.listen('own');
  const platform = { ...s.platform, env: { ...s.platform.env, WSL_INTEROP: own.path } };
  const interop = createInteropFrom(platform, s.files, notASocket(s, 'first'));
  assert.equal(await interop.refresh(), s.files.interop);
  assert.equal(s.linkTarget(), b.path);
});

test("the server's own WSL_INTEROP when neither of the others accepts", async (t) => {
  const s = setup(t);
  keepAliveSays(s, s.path('gone')); // no such socket
  const own = await s.listen('own');
  const platform = { ...s.platform, env: { ...s.platform.env, WSL_INTEROP: own.path } };
  const interop = createInteropFrom(platform, s.files, s.path('missing'));
  assert.equal(await interop.refresh(), s.files.interop);
  assert.equal(s.linkTarget(), own.path);
});

test('no candidate accepts: no link, and null', async (t) => {
  const s = setup(t, { WSL_INTEROP: undefined });
  const interop = createInteropFrom(s.platform, s.files, s.path('missing'));
  assert.equal(await interop.refresh(), null);
  assert.equal(interop.current(), null);
  assert.equal(s.linkTarget(), null);
});

test('a candidate whose connection fails with another error (EACCES) does not get the link', async (t) => {
  const s = setup(t);
  const a = await s.listen('first');
  const b = await s.listen('keepalive');
  keepAliveSays(s, b.path);
  const platform: Platform = {
    ...s.platform,
    net: {
      ...s.platform.net,
      connectUnix: (path) =>
        path === a.path
          ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
          : s.platform.net.connectUnix(path),
    },
  };
  const interop = createInteropFrom(platform, s.files, a.path);
  assert.equal(await interop.refresh(), s.files.interop);
  assert.equal(s.linkTarget(), b.path);
});

test('a later refresh moves the link when the first one dies, and removes it when none is left', async (t) => {
  const s = setup(t);
  const a = await s.listen('first');
  const b = await s.listen('keepalive');
  keepAliveSays(s, b.path);
  const interop = createInteropFrom(s.platform, s.files, a.path);
  await interop.refresh();
  assert.equal(s.linkTarget(), a.path);

  await a.close();
  assert.equal(await interop.refresh(), s.files.interop);
  assert.equal(s.linkTarget(), b.path);

  await b.close();
  assert.equal(await interop.refresh(), null);
  assert.equal(interop.current(), null);
  assert.equal(s.linkTarget(), null);
});

test('a link left by an earlier server that leads nowhere is removed', async (t) => {
  const s = setup(t);
  symlinkSync(s.path('long-gone'), s.files.interop);
  const interop = createInteropFrom(s.platform, s.files, s.path('missing'));
  assert.equal(await interop.refresh(), null);
  assert.equal(s.linkTarget(), null);
});

test('keepalive.interop that is empty, relative or not one path is no candidate', async (t) => {
  for (const content of ['', 'relative/sock', ' /x', '/x\n/y', '/x\0y']) {
    const s = setup(t);
    keepAliveSays(s, content);
    const own = await s.listen('own');
    const platform = { ...s.platform, env: { ...s.platform.env, WSL_INTEROP: own.path } };
    const interop = createInteropFrom(platform, s.files, s.path('missing'));
    await interop.refresh();
    assert.equal(s.linkTarget(), own.path, JSON.stringify(content));
  }
});

test('a server WSL_INTEROP that is not an absolute path is no candidate', async (t) => {
  const s = setup(t, { WSL_INTEROP: 'relative/sock' });
  const interop = createInteropFrom(s.platform, s.files, s.path('missing'));
  assert.equal(await interop.refresh(), null);
});

test('a candidate that leads through the link never makes the link point at itself', async (t) => {
  // The server's own WSL_INTEROP can be the link: a server started from a terminal of the window.
  const s = setup(t);
  const s2 = { ...s.platform, env: { ...s.platform.env, WSL_INTEROP: s.files.interop } };
  const a = await s.listen('first');
  const interop = createInteropFrom(s2, s.files, a.path);
  await interop.refresh();
  assert.equal(s.linkTarget(), a.path);

  // The first one no longer counts, but the link (the server's own) still leads to it.
  const later = createInteropFrom(s2, s.files, s.path('missing'));
  assert.equal(await later.refresh(), s.files.interop);
  assert.equal(s.linkTarget(), a.path);

  await a.close();
  assert.equal(await later.refresh(), null);
  assert.equal(s.linkTarget(), null);
});

test("a socket that is not skydeck's at the link's own path is never replaced by a link to itself", async (t) => {
  const s = setup(t);
  const stranger = await s.platform.net.listenHttp(
    { path: s.files.interop },
    {
      request: (_req, res) => {
        res.end();
      },
    },
  );
  t.after(() => stranger.close());
  const platform = { ...s.platform, env: { ...s.platform.env, WSL_INTEROP: s.files.interop } };
  const interop = createInteropFrom(platform, s.files, s.path('missing'));
  assert.equal(await interop.refresh(), null);
  assert.equal(lstatSync(s.files.interop).isSocket(), true); // left as it was: not a link of ours
});

test('the link is not written again while it points where it should', async (t) => {
  const s = setup(t);
  const a = await s.listen('first');
  let writes = 0;
  const files: Files = {
    ...s.platform.files,
    symlink: (target, path) => {
      writes++;
      s.platform.files.symlink(target, path);
    },
  };
  const interop = createInteropFrom({ ...s.platform, files }, s.files, a.path);
  await interop.refresh();
  await interop.refresh();
  await interop.refresh();
  assert.equal(writes, 1);
  assert.equal(s.linkTarget(), a.path);
});

test('two refreshes at once make one pass over the candidates', async (t) => {
  const s = setup(t);
  const a = await s.listen('first');
  let connects = 0;
  const net: Net = {
    ...s.platform.net,
    connectUnix: (path) => {
      connects++;
      return s.platform.net.connectUnix(path);
    },
  };
  const interop = createInteropFrom({ ...s.platform, net }, s.files, a.path);
  const [one, two] = await Promise.all([interop.refresh(), interop.refresh()]);
  assert.equal(one, s.files.interop);
  assert.equal(two, s.files.interop);
  assert.equal(connects, 1);
});

test("createInterop tries S2 6.4's order: /run/WSL/1_interop, keepalive.interop, the server's own", async (t) => {
  // Nothing real is reached: the sockets refuse every connection without trying one, realpath
  // answers a path under /run/WSL with itself, and every other use of such a path throws.
  const s = setup(t, { WSL_INTEROP: '/run/WSL/88_interop' });
  keepAliveSays(s, '/run/WSL/99_interop');
  const tried: string[] = [];
  const net: Net = {
    ...s.platform.net,
    connectUnix: (path) => {
      tried.push(path);
      return Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    },
  };
  const real = s.platform.files as unknown as Record<string, (...args: unknown[]) => unknown>;
  const files = Object.fromEntries(
    Object.entries(real).map(([name, method]) => [
      name,
      (...args: unknown[]) => {
        const wsl = args.find((arg) => typeof arg === 'string' && arg.startsWith('/run/WSL/'));
        if (wsl !== undefined) {
          if (name === 'realpath') return wsl;
          throw new Error(`the test reached ${String(wsl)} through ${name}`);
        }
        return method(...args);
      },
    ]),
  ) as unknown as Files;
  const interop = createInterop({ ...s.platform, net, files }, s.files);
  assert.equal(await interop.refresh(), null);
  assert.deepEqual(tried, ['/run/WSL/1_interop', '/run/WSL/99_interop', '/run/WSL/88_interop']);
});
