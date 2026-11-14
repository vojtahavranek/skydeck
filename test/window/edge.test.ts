import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { DEFAULT_CONFIG } from '../../src/platform/config.ts';
import type { WindowConfig } from '../../src/platform/config.ts';
import type { Detached, Files, Platform } from '../../src/platform/types.ts';
import { openLink, startEdge, startWindowsProgram } from '../../src/window/edge.ts';
import { edgeArgs } from '../../src/window/windows.ts';
import { fakeProcesses, testPlatform } from '../helpers/platform.ts';
import type { DetachedCall, FakeProcesses } from '../helpers/platform.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

// Every test here runs on the pure fake processes: they record a start and start nothing, so no
// test can reach msedge.exe, whatever the code under test does (A32). Their files refuse any path
// under /mnt/ that a test did not map into its sandbox.

const LINK = '/run/user/1000/skydeck-0a1b2c3d/interop';
const OWN_INTEROP = '/run/WSL/77_interop';
const CONFIG_PATH = '/home/me/.config/skydeck/config.json';
const PROFILE = 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile';
/** A launch token as task 11 mints it: 32 bytes in base64url. */
const TOKEN = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA';
/**
 * Where these tests' C: drive (C_DRIVE, task 24's stand-in, SKYDECK_TEST_MNT_C) shows the Windows
 * users' folders: in a sandbox startEdge derives the profile folder there, never under /mnt.
 */
const USERS = '/stand-in/c/Users';

function windowConfig(overrides: Partial<WindowConfig> = {}): WindowConfig {
  return { ...DEFAULT_CONFIG.window, profileDir: PROFILE, ...overrides };
}

/**
 * `files` with the stand-in drive's Users folder shown from `usersRoot` (a sandbox folder), and
 * every path under /mnt/ refused (and recorded in `mntAsked`), so that no test reads the
 * developer's Windows folders.
 */
function windowsFoldersIn(
  files: Files,
  usersRoot: string | undefined,
  mntAsked: string[] = [],
): Files {
  const mapPath = (path: string): string => {
    if (path === '/mnt' || path.startsWith('/mnt/')) mntAsked.push(path);
    if (usersRoot !== undefined && (path === USERS || path.startsWith(`${USERS}/`))) {
      return `${usersRoot}${path.slice(USERS.length)}`;
    }
    if (path.startsWith('/mnt/')) {
      throw new Error(`the test reached ${path}`);
    }
    return path;
  };
  const methods = files as unknown as Record<string, (...args: unknown[]) => unknown>;
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...args: unknown[]) =>
        method(...args.map((arg) => (typeof arg === 'string' ? mapPath(arg) : arg))),
    ]),
  ) as unknown as Files;
}

interface Setup {
  platform: Platform;
  processes: FakeProcesses;
  sandbox: Sandbox;
  /** Every path under /mnt/ the code under test asked its files for. */
  mntAsked: string[];
}

/** The C: drive in these tests: task 24's stand-in for /mnt/c (only a path: the processes are fakes). */
const C_DRIVE = '/stand-in/c';

function setup(
  t: TestContext,
  options: {
    handler?: (call: DetachedCall) => Detached | Promise<Detached>;
    /** The sandbox folder that stands for /mnt/c/Users; without, /mnt/c/Users is refused too. */
    usersRoot?: (s: Sandbox) => string;
    env?: Record<string, string | undefined>;
  } = {},
): Setup {
  const tp = testPlatform(t, {
    env: { WSL_INTEROP: OWN_INTEROP, SKYDECK_TEST_MNT_C: C_DRIVE, ...options.env },
  });
  const processes = fakeProcesses(options.handler);
  const usersRoot = options.usersRoot?.(tp.sandbox);
  const mntAsked: string[] = [];
  const platform: Platform = {
    ...tp.platform,
    processes,
    files: windowsFoldersIn(tp.platform.files, usersRoot, mntAsked),
  };
  return { platform, processes, sandbox: tp.sandbox, mntAsked };
}

function failWith(code: string): () => never {
  return () => {
    throw Object.assign(new Error(`spawn failed ${code}`), { code });
  };
}

/** A users folder in the sandbox with an Edge folder for each name. */
function usersWithEdge(s: Sandbox, ...names: string[]): string {
  const root = join(s.root, 'Users');
  mkdirSync(root);
  for (const name of names) {
    mkdirSync(join(root, name, 'AppData', 'Local', 'Microsoft', 'Edge'), { recursive: true });
  }
  return root;
}

function onlyCall(processes: FakeProcesses): DetachedCall {
  assert.equal(processes.calls.length, 1, 'exactly one program started');
  const [call] = processes.calls;
  assert.ok(call !== undefined);
  return call;
}

// ---------------------------------------------------------------------------------------------
// startEdge

test('startEdge starts window.edge detached with exactly edgeArgs, in /mnt/c, stdio ignored', async (t) => {
  const { platform, processes } = setup(t);
  const result = await startEdge(platform, windowConfig(), CONFIG_PATH, 47613, TOKEN, LINK);
  assert.deepEqual(result, { ok: true });
  const call = onlyCall(processes);
  assert.equal(call.command, DEFAULT_CONFIG.window.edge);
  assert.deepEqual(call.args, edgeArgs(47613, TOKEN, PROFILE));
  // No input, stdoutTo or stderrTo: stdin, stdout and stderr are /dev/null.
  assert.deepEqual(Object.keys(call.options).sort(), ['cwd', 'env']);
  assert.equal(call.options.cwd, C_DRIVE);
});

test('startEdge gives Edge the platform environment with WSL_INTEROP pointing at the link', async (t) => {
  const { platform, processes, sandbox } = setup(t);
  await startEdge(platform, windowConfig(), CONFIG_PATH, 47613, TOKEN, LINK);
  const { env } = onlyCall(processes).options;
  assert.equal(env.WSL_INTEROP, LINK);
  assert.equal(env.HOME, sandbox.home);
  assert.equal(env.SKYDECK_TEST_NO_WINDOWS, '1'); // the sandbox's mark stays for whatever runs next
});

test("startEdge without a link leaves the environment's WSL_INTEROP as it is", async (t) => {
  const own = setup(t);
  await startEdge(own.platform, windowConfig(), CONFIG_PATH, 47613, TOKEN, null);
  assert.equal(onlyCall(own.processes).options.env.WSL_INTEROP, OWN_INTEROP);

  const none = setup(t, { env: { WSL_INTEROP: undefined } });
  await startEdge(none.platform, windowConfig(), CONFIG_PATH, 47613, TOKEN, null);
  assert.equal('WSL_INTEROP' in onlyCall(none.processes).options.env, false);
});

test("startEdge: a missing program gives S2 5.3's line naming window.edge, the config and --print-url", async (t) => {
  const { platform } = setup(t, { handler: failWith('ENOENT') });
  const edge = '/mnt/d/Edge/msedge.exe';
  const result = await startEdge(platform, windowConfig({ edge }), CONFIG_PATH, 47613, TOKEN, LINK);
  assert.deepEqual(result, {
    ok: false,
    line: `Edge was not found at ${edge}; set window.edge in ${CONFIG_PATH}, or open the window in any browser with skydeck window --print-url`,
  });
});

test('startEdge: another start failure gives a line with the program, the reason and --print-url', async (t) => {
  const { platform } = setup(t, { handler: failWith('EACCES') });
  const result = await startEdge(platform, windowConfig(), CONFIG_PATH, 47613, TOKEN, LINK);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.line, /^Edge could not be started from /);
  assert.ok(result.line.includes(DEFAULT_CONFIG.window.edge), result.line);
  assert.ok(result.line.includes('EACCES'), result.line);
  assert.ok(result.line.includes('skydeck window --print-url'), result.line);
});

test('startEdge uses window.profileDir as configured and derives nothing', async (t) => {
  // No users folder is mapped: a derivation would find no Windows user.
  const { platform, processes } = setup(t);
  const profileDir = 'D:\\Profiles\\skydeck window';
  await startEdge(platform, windowConfig({ profileDir }), CONFIG_PATH, 47613, TOKEN, LINK);
  assert.deepEqual(onlyCall(processes).args, edgeArgs(47613, TOKEN, profileDir));
});

test('startEdge without window.profileDir derives the folder of the one Windows user with Edge', async (t) => {
  const { platform, processes } = setup(t, { usersRoot: (s) => usersWithEdge(s, 'me') });
  const result = await startEdge(
    platform,
    windowConfig({ profileDir: null }),
    CONFIG_PATH,
    47613,
    TOKEN,
    LINK,
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(onlyCall(processes).args, edgeArgs(47613, TOKEN, PROFILE));
});

test('startEdge in a sandbox derives the profile folder from the stand-in drive only: nothing under /mnt is read (review 2 of task 25)', async (t) => {
  const { platform, mntAsked } = setup(t, { usersRoot: (s) => usersWithEdge(s, 'me') });
  await startEdge(platform, windowConfig({ profileDir: null }), CONFIG_PATH, 47613, TOKEN, LINK);
  assert.deepEqual(mntAsked, []);
});

test('startEdge in a sandbox without a stand-in drive: the C: drive is not mounted, nothing under /mnt is read, nothing started', async (t) => {
  const { platform, processes, mntAsked } = setup(t, { env: { SKYDECK_TEST_MNT_C: undefined } });
  const result = await startEdge(
    platform,
    windowConfig({ profileDir: null }),
    CONFIG_PATH,
    47613,
    TOKEN,
    LINK,
  );
  assert.deepEqual(result, {
    ok: false,
    line: `the C: drive is not mounted, so the Edge profile folder cannot be derived; set window.profileDir to the folder for the window's Edge profile (an absolute Windows path) in ${CONFIG_PATH}`,
  });
  assert.deepEqual(mntAsked, []);
  assert.deepEqual(processes.calls, []);
});

for (const [name, users] of [
  ['no Windows user', []],
  ['two Windows users', ['me', 'you']],
] as const) {
  test(`startEdge: a profile folder that cannot be derived (${name}) gives the error naming window.profileDir, and starts nothing`, async (t) => {
    const { platform, processes } = setup(t, { usersRoot: (s) => usersWithEdge(s, ...users) });
    const result = await startEdge(
      platform,
      windowConfig({ profileDir: null }),
      CONFIG_PATH,
      47613,
      TOKEN,
      LINK,
    );
    assert.ok(!result.ok);
    assert.ok(result.line.includes('window.profileDir'), result.line);
    assert.ok(result.line.includes(CONFIG_PATH), result.line);
    assert.deepEqual(processes.calls, []);
  });
}

for (const [name, profileDir] of [
  ['ends with a backslash', 'C:\\Users\\Me Name\\skydeck\\'],
  ['holds a double quote', 'C:\\Users\\a"b'],
  ['holds a tab', 'C:\\Users\\a\tb'],
  ['holds a newline', 'C:\\Users\\a\nb'],
] as const) {
  test(`startEdge refuses a window.profileDir that ${name} (it would change how Edge splits its command line)`, async (t) => {
    const { platform, processes } = setup(t);
    const result = await startEdge(
      platform,
      windowConfig({ profileDir }),
      CONFIG_PATH,
      47613,
      TOKEN,
      LINK,
    );
    assert.ok(!result.ok);
    assert.ok(result.line.includes('window.profileDir'), result.line);
    assert.ok(result.line.includes(CONFIG_PATH), result.line);
    assert.deepEqual(processes.calls, []);
  });
}

test('the line for an unsafe window.profileDir shows it as its JSON string, with no control character', async (t) => {
  const { platform } = setup(t);
  const cases: [string, string][] = [
    ['C:\\Users\\Me Name\\x\\', '"C:\\\\Users\\\\Me Name\\\\x\\\\"'],
    ['C:\\x\u009b2J\\', '"C:\\\\x\\u009b2J\\\\"'], // CSI, a C1 control
    ['C:\\a\u0085b', '"C:\\\\a\\u0085b"'], // NEL, a C1 control: refused by itself
    ['C:\\a\u007fb', '"C:\\\\a\\u007fb"'], // DEL
    ['C:\\a\u001b[2Jb', '"C:\\\\a\\u001b[2Jb"'], // ESC
  ];
  for (const [profileDir, shown] of cases) {
    const result = await startEdge(
      platform,
      windowConfig({ profileDir }),
      CONFIG_PATH,
      47613,
      TOKEN,
      LINK,
    );
    assert.ok(!result.ok);
    assert.ok(result.line.startsWith(`the Edge profile folder ${shown} cannot`), result.line);
    assert.doesNotMatch(result.line, /[\x00-\x1f\x7f-\x9f]/);
  }
});

test('startEdge throws a RangeError for a port or a token that cannot be part of the address, and starts nothing', async (t) => {
  const { platform, processes } = setup(t);
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    await assert.rejects(
      startEdge(platform, windowConfig(), CONFIG_PATH, port, TOKEN, LINK),
      RangeError,
    );
  }
  for (const token of ['', 'a b', 'a"b', 'a&b', 'a/b', 'a=']) {
    await assert.rejects(
      startEdge(platform, windowConfig(), CONFIG_PATH, 47613, token, LINK),
      RangeError,
    );
  }
  assert.deepEqual(processes.calls, []);
});

// ---------------------------------------------------------------------------------------------
// openLink

test('openLink opens an allowed URL with window.edge, the URL its only argument', async (t) => {
  const { platform, processes } = setup(t);
  const url = 'https://github.com/a/b/pull/1';
  assert.equal(await openLink(platform, windowConfig(), url, LINK), true);
  const call = onlyCall(processes);
  assert.equal(call.command, DEFAULT_CONFIG.window.edge);
  assert.deepEqual(call.args, [url]); // no profile folder: the user's own Edge profile (S2 9.6)
  assert.deepEqual(Object.keys(call.options).sort(), ['cwd', 'env']);
  assert.equal(call.options.cwd, C_DRIVE);
  assert.equal(call.options.env.WSL_INTEROP, LINK);
});

test('openLink passes the URL as the WHATWG parser re-serialised it', async (t) => {
  const { platform, processes } = setup(t);
  assert.equal(await openLink(platform, windowConfig(), 'http://x', null), true);
  assert.deepEqual(onlyCall(processes).args, ['http://x/']);
  assert.equal(onlyCall(processes).options.env.WSL_INTEROP, OWN_INTEROP);
});

test('openLink starts nothing for a URL linkToOpen refuses, and answers false', async (t) => {
  const { platform, processes } = setup(t);
  const refused = [
    'javascript:alert(1)',
    'file:///etc',
    'not a url',
    '-https://x',
    'https://x/?a=\\b', // the parser keeps a backslash in the query
    'https://x/#\\b',
    `https://x/${'a'.repeat(2049 - 'https://x/'.length)}`,
  ];
  for (const url of refused) {
    assert.equal(await openLink(platform, windowConfig(), url, LINK), false, url);
  }
  assert.deepEqual(processes.calls, []);
});

test('openLink answers false when Edge cannot be started', async (t) => {
  for (const code of ['ENOENT', 'EACCES']) {
    const { platform } = setup(t, { handler: failWith(code) });
    assert.equal(await openLink(platform, windowConfig(), 'https://example.com/', LINK), false);
  }
});

// ---------------------------------------------------------------------------------------------
// startWindowsProgram: the one way skydeck starts a Windows program (S2 2)

test('startWindowsProgram starts the program detached in /mnt/c with stdio ignored and the link', async (t) => {
  const { platform, processes } = setup(t);
  const child = await startWindowsProgram(platform, '/mnt/c/x.exe', ['a b', 'C:\\d'], LINK);
  assert.equal(child.pid, 5001);
  const call = onlyCall(processes);
  assert.equal(call.command, '/mnt/c/x.exe');
  assert.deepEqual(call.args, ['a b', 'C:\\d']);
  assert.deepEqual(Object.keys(call.options).sort(), ['cwd', 'env']);
  assert.equal(call.options.cwd, C_DRIVE);
  assert.equal(call.options.env.WSL_INTEROP, LINK);
});

test('startWindowsProgram refuses an argument that could change how a Windows program splits its command line', async (t) => {
  const { platform, processes } = setup(t);
  for (const arg of [
    '',
    'a"b',
    'a\\',
    'a\tb',
    'a\nb',
    'a\rb',
    'a\x00b',
    'a\x7fb',
    'a\u0085b',
    'a\u009bb',
  ]) {
    await assert.rejects(
      startWindowsProgram(platform, '/mnt/c/x.exe', ['ok', arg], LINK),
      /cannot be passed to a Windows program/,
      JSON.stringify(arg),
    );
  }
  assert.deepEqual(processes.calls, []);
});

test('startWindowsProgram passes a rejection of the start on', async (t) => {
  const { platform } = setup(t, { handler: failWith('ENOENT') });
  await assert.rejects(startWindowsProgram(platform, '/mnt/c/x.exe', [], LINK), {
    code: 'ENOENT',
  });
});

test('startWindowsProgram in a test sandbox without the C: drive stand-in starts nothing (ENOENT)', async (t) => {
  const { platform, processes } = setup(t, { env: { SKYDECK_TEST_MNT_C: undefined } });
  await assert.rejects(startWindowsProgram(platform, '/mnt/c/x.exe', [], LINK), { code: 'ENOENT' });
  assert.deepEqual(processes.calls, []);
});

test('startWindowsProgram outside a test sandbox starts in /mnt/c (S2 5.3)', async (t) => {
  const { platform, processes } = setup(t, { env: { SKYDECK_TEST_NO_WINDOWS: undefined } });
  await startWindowsProgram(platform, '/mnt/c/x.exe', [], LINK);
  assert.equal(onlyCall(processes).options.cwd, '/mnt/c');
});
