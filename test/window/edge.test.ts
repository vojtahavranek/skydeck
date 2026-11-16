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

/** S2 9.6: the program that opens a link in the Windows default browser (window.links "default"). */
const RUNDLL32 = '/mnt/c/Windows/System32/rundll32.exe';
/** Its first argument: the entry point that hands the rest of the command line to the shell. */
const HANDLER = 'url.dll,FileProtocolHandler';

test('openLink with window.links "default" starts rundll32.exe with exactly the handler and the URL', async (t) => {
  const { platform, processes } = setup(t);
  const url = 'https://github.com/search?q=skydeck&type=repositories#a,b';
  assert.equal(await openLink(platform, windowConfig({ links: 'default' }), url, LINK), true);
  const call = onlyCall(processes);
  assert.equal(call.command, RUNDLL32);
  assert.deepEqual(call.args, [HANDLER, url]);
  assert.deepEqual(Object.keys(call.options).sort(), ['cwd', 'env']);
  assert.equal(call.options.cwd, C_DRIVE);
  assert.equal(call.options.env.WSL_INTEROP, LINK);
});

test('openLink with the default configuration opens the link in the default browser, not in Edge', async (t) => {
  const { platform, processes } = setup(t);
  assert.equal(DEFAULT_CONFIG.window.links, 'default');
  const url = 'https://github.com/a/b/pull/1';
  assert.equal(await openLink(platform, windowConfig(), url, LINK), true);
  assert.equal(onlyCall(processes).command, RUNDLL32);
  assert.deepEqual(onlyCall(processes).args, [HANDLER, url]);
});

test('openLink with window.links "edge" opens an allowed URL with window.edge, the URL its only argument', async (t) => {
  const { platform, processes } = setup(t);
  const url = 'https://github.com/a/b/pull/1';
  assert.equal(await openLink(platform, windowConfig({ links: 'edge' }), url, LINK), true);
  const call = onlyCall(processes);
  assert.equal(call.command, DEFAULT_CONFIG.window.edge);
  assert.deepEqual(call.args, [url]); // no profile folder: the user's own Edge profile (S2 9.6)
  assert.deepEqual(Object.keys(call.options).sort(), ['cwd', 'env']);
  assert.equal(call.options.cwd, C_DRIVE);
  assert.equal(call.options.env.WSL_INTEROP, LINK);
});

test('openLink with window.links "edge" starts the configured window.edge', async (t) => {
  const { platform, processes } = setup(t);
  const edge = '/mnt/d/Edge/msedge.exe';
  assert.equal(
    await openLink(platform, windowConfig({ links: 'edge', edge }), 'https://x/', LINK),
    true,
  );
  assert.equal(onlyCall(processes).command, edge);
});

for (const links of ['default', 'edge'] as const) {
  const program = links === 'default' ? 'rundll32.exe' : 'Edge';
  const argsOf = (url: string): string[] => (links === 'default' ? [HANDLER, url] : [url]);

  test(`openLink (${links}) passes the URL as the WHATWG parser re-serialised it`, async (t) => {
    const { platform, processes } = setup(t);
    assert.equal(await openLink(platform, windowConfig({ links }), 'http://x', null), true);
    assert.deepEqual(onlyCall(processes).args, argsOf('http://x/'));
    assert.equal(onlyCall(processes).options.env.WSL_INTEROP, OWN_INTEROP);
  });

  test(`openLink (${links}) starts nothing for a URL linkToOpen refuses, and answers false`, async (t) => {
    const { platform, processes } = setup(t);
    const refused = [
      'javascript:alert(1)',
      'file:///etc',
      'not a url',
      '-https://x',
      'https://x/?a=\\b', // the parser keeps a backslash in the query
      'https://x/#\\b',
      'https://a"b/', // the parser keeps a '"' in the host
      `https://x/${'a'.repeat(2049 - 'https://x/'.length)}`,
    ];
    for (const url of refused) {
      assert.equal(await openLink(platform, windowConfig({ links }), url, LINK), false, url);
    }
    assert.deepEqual(processes.calls, []);
  });

  test(`openLink (${links}) refuses an address the parser would give back with anything but printable ASCII, and starts nothing: the one-word rule does not rest on the parser`, async (t) => {
    const { platform, processes } = setup(t);
    /** URL.parse answering `href` for any input: a parser that would serialise otherwise. */
    const parserGiving = (href: string): { mock: { restore(): void } } =>
      t.mock.method(URL, 'parse', () => ({ protocol: 'https:', href }) as unknown as URL);
    const unprintable = [
      'https://a b/',
      'https://a/b\tc',
      'https://a/b\nc',
      'https://a/b\x00c',
      'https://a/b\x7fc',
      'https://a/b\x85c',
      'https://a/b\u00a0c',
      'https://a/b\u3000c',
      'https://a/b\u00e9c',
      'https://a/b\uff02c',
      'https://a/b\uff3cc',
    ];
    for (const href of unprintable) {
      const parse = parserGiving(href);
      const opened = await openLink(platform, windowConfig({ links }), 'https://a/', LINK);
      parse.mock.restore();
      assert.equal(opened, false, JSON.stringify(href));
    }
    assert.deepEqual(processes.calls, []);
    // Not vacuous: the same stand-in with a printable address is what is opened.
    const parse = parserGiving('https://a/b');
    const opened = await openLink(platform, windowConfig({ links }), 'https://a/', LINK);
    parse.mock.restore();
    assert.equal(opened, true);
    assert.deepEqual(onlyCall(processes).args, argsOf('https://a/b'));
  });

  test(`openLink (${links}) answers false when ${program} cannot be started`, async (t) => {
    for (const code of ['ENOENT', 'EACCES', 'EWINDOWS']) {
      const { platform, processes } = setup(t, { handler: failWith(code) });
      const config = windowConfig({ links });
      assert.equal(await openLink(platform, config, 'https://example.com/', LINK), false, code);
      assert.equal(onlyCall(processes).command, links === 'default' ? RUNDLL32 : config.edge);
    }
  });

  test(`openLink (${links}) in a sandbox without the C: drive stand-in starts nothing and answers false`, async (t) => {
    const { platform, processes } = setup(t, { env: { SKYDECK_TEST_MNT_C: undefined } });
    const config = windowConfig({ links });
    assert.equal(await openLink(platform, config, 'https://example.com/', LINK), false);
    assert.deepEqual(processes.calls, []);
  });
}

/**
 * D4 of follow-up F1: hostile addresses — white space, control characters, Unicode spaces and
 * characters beyond ASCII (among them ones that Windows' best-fit mapping turns into '"' or a
 * backslash) — in every part of a URL: scheme, user info, host (raw and percent-encoded), port,
 * path, query, fragment, around it. WSL's interop quotes an argument only when it must, and
 * FileProtocolHandler takes the rest of the command line raw (an ANSI one, perhaps, where best-fit
 * mapping applies), so the address handed to rundll32.exe must be one unquoted word: printable
 * ASCII (U+0021–U+007E) with no '"' and no backslash. The parser removes tab, LF and CR anywhere
 * and strips C0 controls and spaces around the address; it percent-encodes the others, and all
 * beyond ASCII, in the user info, path, query and fragment; it writes a host beyond ASCII as
 * punycode; a host (also once its escapes are decoded) or a port that keeps one fails.
 */
const HOSTILE_CHARACTERS: readonly string[] = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  '\0',
  '\x01',
  '\x1b',
  '\x1f',
  '\x7f',
  '\x85', // NEL
  '\x9b', // CSI
  '\u00a0', // no-break space
  '\u1680', // Ogham space mark
  '\u2002', // en space
  '\u200a', // hair space
  '\u200b', // zero width space
  '\u2028', // line separator
  '\u2029', // paragraph separator
  '\u202f', // narrow no-break space
  '\u205f', // medium mathematical space
  '\u3000', // ideographic space
  '\ufeff', // byte order mark
  '\u00fc', // beyond ASCII, not a space
  '\uff02', // fullwidth quotation mark: '"' after best-fit mapping
  '\uff3c', // fullwidth reverse solidus: a backslash after best-fit mapping
  '\u00a5', // yen sign: a backslash on a Japanese code page
];
const HOSTILE_PLACES: readonly ((c: string) => string)[] = [
  (c) => `${c}https://example.com/a${c}`,
  (c) => `ht${c}tps://example.com/`,
  (c) => `https:${c}//example.com/`,
  (c) => `https://us${c}er:pa${c}ss@example.com/`,
  (c) => `https://${c}example.com/`,
  (c) => `https://exa${c}mple.com/`,
  (c) => `https://exa${encodeURIComponent(c)}mple.com/`, // the host is the one part decoded
  (c) => `https://example.com${c}/`,
  (c) => `https://[::1${c}]/`,
  (c) => `https://1.2.3${c}.4/`,
  (c) => `https://example.com:4${c}43/`,
  (c) => `https://example.com/a${c}b/${c}`,
  (c) => `https://example.com/a?q=${c}b&r=${c}`,
  (c) => `https://example.com/a?${c}`,
  (c) => `https://example.com/a#f${c}g`,
  (c) => `https://example.com/a#${c}`,
  (c) => `https://example.com/%${c}20`,
  (c) => `HTTP://Example.COM/${c}${c}${c}?${c}${c}#${c}${c}`,
];
/** One word of the Windows command line: an http(s) address in printable ASCII, no space. */
const ONE_WORD = /^https?:\/\/[\x21-\x7e]+$/;

test('openLink hands rundll32.exe an address with no white space and no control character, whatever the page sent (D4)', async (t) => {
  const { platform, processes } = setup(t);
  let opened = 0;
  for (const place of HOSTILE_PLACES) {
    for (const c of HOSTILE_CHARACTERS) {
      const url = place(c);
      const before = processes.calls.length;
      const result = await openLink(platform, windowConfig({ links: 'default' }), url, LINK);
      const calls = processes.calls.slice(before);
      assert.equal(calls.length, result ? 1 : 0, JSON.stringify(url));
      const [call] = calls;
      if (call === undefined) continue;
      opened += 1;
      const [handler, address, ...more] = call.args;
      assert.equal(handler, HANDLER);
      assert.deepEqual(more, []);
      const shown = `${JSON.stringify(url)} → ${JSON.stringify(address)}`;
      assert.match(address ?? '', ONE_WORD, shown);
      assert.doesNotMatch(address ?? '', /["\\]/, shown);
    }
  }
  // Not vacuous: more than half of the table is opened (encoded, removed, or as punycode).
  const all = HOSTILE_PLACES.length * HOSTILE_CHARACTERS.length;
  assert.ok(opened > all / 2, `${opened} of ${all} opened`);
});

test('the parser percent-encodes white space, controls and what is beyond ASCII in the user info, path, query and fragment, removes tab and line breaks, and fails a host (also percent-encoded) or port that keeps one (D4)', async (t) => {
  const { platform, processes } = setup(t);
  const cases: [url: string, opened: string | null][] = [
    ['https://example.com/a b', 'https://example.com/a%20b'],
    ['https://example.com/a\tb\nc\rd', 'https://example.com/abcd'],
    ['https://example.com/?q=a b\u3000c', 'https://example.com/?q=a%20b%E3%80%80c'],
    ['https://example.com/#a\x1bb\x7fc\x85d', 'https://example.com/#a%1Bb%7Fc%C2%85d'],
    ['https://a b:c\u00a0d@example.com/', 'https://a%20b:c%C2%A0d@example.com/'],
    ['  https://example.com/\x00\x1f ', 'https://example.com/'],
    ['https://exa\tmple.com/', 'https://example.com/'],
    ['https://exa mple.com/', null],
    ['https://exa\u00a0mple.com/', null], // IDNA maps it to a space
    ['https://exa\u2028mple.com/', null],
    ['https://exa\x1fmple.com/', null],
    ['https://example.com:4 43/', null],
    ['https://example.com:4\u3000/', null],
    ['https://exa%20mple.com/', null], // the host's escapes are decoded first
    ['https://exa%0Ample.com/', null],
    ['https://exa%C2%A0mple.com/', null],
    ['https://exa%22mple.com/', null],
    ['https://exa%5Cmple.com/', null],
    ['https://exa%EF%BC%82mple.com/', null], // IDNA maps U+FF02 to '"'
    ['https://exa\uff02mple.com/', null],
    ['https://exa\uff3cmple.com/', null],
    ['https://exa\u00fcmple.com/', 'https://xn--example-p2a.com/'],
    [
      'https://example.com/\uff02\uff3c?\u00a5#\u00fc',
      'https://example.com/%EF%BC%82%EF%BC%BC?%C2%A5#%C3%BC',
    ],
  ];
  for (const [url, address] of cases) {
    const before = processes.calls.length;
    const result = await openLink(platform, windowConfig({ links: 'default' }), url, LINK);
    assert.equal(result, address !== null, JSON.stringify(url));
    assert.deepEqual(
      processes.calls.slice(before).map((call) => call.args),
      address === null ? [] : [[HANDLER, address]],
      JSON.stringify(url),
    );
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
