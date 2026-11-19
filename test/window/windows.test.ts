import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Files } from '../../src/platform/types.ts';
import {
  deriveProfileDirUnder,
  edgeArgs,
  linkToOpen,
  windowsPath,
} from '../../src/window/windows.ts';
import { testPlatform } from '../helpers/platform.ts';

const isRoot = process.getuid?.() === 0; // root reads anything, so mode 000 proves nothing

// ---------------------------------------------------------------------------------------------
// windowsPath

test('windowsPath maps a path under /mnt/<letter>/ to that drive', () => {
  assert.equal(windowsPath('/mnt/c/Users/me/x'), 'C:\\Users\\me\\x');
  assert.equal(windowsPath('/mnt/d/a'), 'D:\\a');
  assert.equal(windowsPath('/mnt/z/a/b/c'), 'Z:\\a\\b\\c');
});

test('windowsPath keeps spaces, parentheses and non-ASCII names', () => {
  assert.equal(
    windowsPath('/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  );
  assert.equal(windowsPath('/mnt/c/Users/me/Łódź café'), 'C:\\Users\\me\\Łódź café');
});

test('windowsPath maps the root of a drive to its root', () => {
  assert.equal(windowsPath('/mnt/c'), 'C:\\');
  assert.equal(windowsPath('/mnt/c/'), 'C:\\');
});

test('windowsPath ignores repeated and trailing slashes', () => {
  assert.equal(windowsPath('/mnt/c//Users///me/'), 'C:\\Users\\me');
});

test('windowsPath gives null for a path not under /mnt/<letter>/', () => {
  const outside = [
    '',
    '/',
    '/home/me',
    '/mnt',
    '/mnt/',
    '/mnt/cd/x', // not one letter
    '/mnt/1/x',
    '/mnt/C/x', // WSL mounts drives under lowercase letters
    '/mntx/c/x',
    'mnt/c/x', // relative
    'C:\\Users',
    '//mnt/c/x',
  ];
  for (const path of outside) {
    assert.equal(windowsPath(path), null, JSON.stringify(path));
  }
});

test('windowsPath gives null for a path that leaves its drive or cannot be written for Windows', () => {
  for (const path of ['/mnt/c/../etc', '/mnt/c/Users/..', '/mnt/c/./x', '/mnt/c/a\\b']) {
    assert.equal(windowsPath(path), null, JSON.stringify(path));
  }
});

test('windowsPath gives null for a name Windows cannot have', () => {
  const names = [
    'a\nb', // a line break
    'a\tb',
    'a\u0000b',
    'a\u001fb', // any control character
    'a"b', // the one that matters inside --user-data-dir=
    'a:b', // on Windows: the stream b of a
    'a<b',
    'a>b',
    'a|b',
    'a?b',
    'a*b',
    'name ', // Windows drops a trailing space or dot: it would name another folder
    'name.',
  ];
  for (const name of names) {
    assert.equal(windowsPath(`/mnt/c/Users/${name}/x`), null, JSON.stringify(name));
    assert.equal(windowsPath(`/mnt/c/Users/${name}`), null, JSON.stringify(name));
  }
});

test('windowsPath keeps names Windows allows: inner dots and spaces, a leading space, # and %', () => {
  assert.equal(windowsPath('/mnt/c/a.b/c d/ e/#1%/x.y.z'), 'C:\\a.b\\c d\\ e\\#1%\\x.y.z');
});

// ---------------------------------------------------------------------------------------------
// deriveProfileDirUnder (S2 5.4), with a sandbox folder standing for /mnt/c/Users

const EDGE = ['AppData', 'Local', 'Microsoft', 'Edge'];

function usersRoot(t: TestContext): { files: Files; root: string } {
  const { platform, sandbox } = testPlatform(t);
  const root = join(sandbox.root, 'Users');
  mkdirSync(root);
  return { files: platform.files, root };
}

function withEdge(root: string, name: string): string {
  const dir = join(root, name, ...EDGE);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('deriveProfileDirUnder: the one user with an Edge folder gives the profile folder', (t) => {
  const { files, root } = usersRoot(t);
  withEdge(root, 'me');
  mkdirSync(join(root, 'Public'));
  mkdirSync(join(root, 'Default', 'AppData', 'Local', 'Microsoft'), { recursive: true });
  writeFileSync(join(root, 'desktop.ini'), '[.ShellClassInfo]\n');
  assert.deepEqual(deriveProfileDirUnder(files, root), {
    ok: true,
    dir: 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile',
  });
});

test('deriveProfileDirUnder: a user name with spaces and non-ASCII letters is kept', (t) => {
  const { files, root } = usersRoot(t);
  withEdge(root, 'Jana Nováková');
  assert.deepEqual(deriveProfileDirUnder(files, root), {
    ok: true,
    dir: 'C:\\Users\\Jana Nováková\\AppData\\Local\\skydeck\\edge-profile',
  });
});

test('deriveProfileDirUnder: no user with an Edge folder is an error naming window.profileDir', (t) => {
  const { files, root } = usersRoot(t);
  mkdirSync(join(root, 'me', 'AppData', 'Local'), { recursive: true });
  const result = deriveProfileDirUnder(files, root);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /window\.profileDir/);
});

test('deriveProfileDirUnder: an Edge path that is a file does not count', (t) => {
  const { files, root } = usersRoot(t);
  mkdirSync(join(root, 'me', 'AppData', 'Local', 'Microsoft'), { recursive: true });
  writeFileSync(join(root, 'me', ...EDGE), 'not a folder');
  const result = deriveProfileDirUnder(files, root);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /window\.profileDir/);
});

test('deriveProfileDirUnder: a users folder that does not exist is an error naming window.profileDir', (t) => {
  const { files, root } = usersRoot(t);
  const result = deriveProfileDirUnder(files, join(root, 'absent'));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /window\.profileDir/);
});

test('deriveProfileDirUnder: two users with an Edge folder is an error naming both and window.profileDir', (t) => {
  const { files, root } = usersRoot(t);
  withEdge(root, 'anna');
  withEdge(root, 'bob');
  const result = deriveProfileDirUnder(files, root);
  assert.equal(result.ok, false);
  const error = result.ok ? '' : result.error;
  assert.match(error, /window\.profileDir/);
  assert.match(error, /anna/);
  assert.match(error, /bob/);
});

test('deriveProfileDirUnder: an Edge folder reached through a link to a folder counts', (t) => {
  const { files, root } = usersRoot(t);
  const target = join(root, '..', 'edge-target'); // outside the users folder
  mkdirSync(target);
  mkdirSync(join(root, 'me', 'AppData', 'Local', 'Microsoft'), { recursive: true });
  symlinkSync(target, join(root, 'me', ...EDGE));
  assert.deepEqual(deriveProfileDirUnder(files, root), {
    ok: true,
    dir: 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile',
  });
});

test('deriveProfileDirUnder: a link to nothing does not count', (t) => {
  const { files, root } = usersRoot(t);
  withEdge(root, 'me');
  mkdirSync(join(root, 'other', 'AppData', 'Local', 'Microsoft'), { recursive: true });
  symlinkSync(join(root, '..', 'nothing-here'), join(root, 'other', ...EDGE));
  assert.deepEqual(deriveProfileDirUnder(files, root), {
    ok: true,
    dir: 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile',
  });
});

test('deriveProfileDirUnder: an unreadable Edge folder does not count', { skip: isRoot }, (t) => {
  const { files, root } = usersRoot(t);
  withEdge(root, 'me');
  const closed = withEdge(root, 'other');
  chmodSync(closed, 0o000);
  try {
    assert.deepEqual(deriveProfileDirUnder(files, root), {
      ok: true,
      dir: 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile',
    });
  } finally {
    chmodSync(closed, 0o700); // the sandbox cannot remove it otherwise
  }
});

test(
  "deriveProfileDirUnder: another user's folder that cannot be entered does not count",
  { skip: isRoot },
  (t) => {
    const { files, root } = usersRoot(t);
    withEdge(root, 'me');
    withEdge(root, 'other');
    const closed = join(root, 'other');
    chmodSync(closed, 0o000);
    try {
      assert.deepEqual(deriveProfileDirUnder(files, root), {
        ok: true,
        dir: 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile',
      });
    } finally {
      chmodSync(closed, 0o700);
    }
  },
);

test(
  'deriveProfileDirUnder: a users folder that cannot be read is an error naming window.profileDir',
  { skip: isRoot },
  (t) => {
    const { files, root } = usersRoot(t);
    withEdge(root, 'me');
    chmodSync(root, 0o000);
    try {
      const result = deriveProfileDirUnder(files, root);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error, /window\.profileDir/);
    } finally {
      chmodSync(root, 0o700);
    }
  },
);

test('deriveProfileDirUnder: a folder name that has no Windows form is ignored', (t) => {
  const { files, root } = usersRoot(t);
  withEdge(root, 'me');
  withEdge(root, 'a\\b');
  assert.deepEqual(deriveProfileDirUnder(files, root), {
    ok: true,
    dir: 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile',
  });
});

// ---------------------------------------------------------------------------------------------
// edgeArgs (S2 5.3)

test('edgeArgs gives exactly the four arguments of S2 5.3, in order', () => {
  assert.deepEqual(edgeArgs(47613, 'abc', 'C:\\x'), [
    '--app=http://127.0.0.1:47613/#t=abc',
    '--user-data-dir=C:\\x',
    '--no-first-run',
    '--no-default-browser-check',
  ]);
});

test('edgeArgs keeps a profile folder with spaces as one argument', () => {
  const args = edgeArgs(1, 't', 'C:\\Users\\Jana Nováková\\AppData\\Local\\skydeck\\edge-profile');
  assert.equal(args.length, 4);
  assert.equal(
    args[1],
    '--user-data-dir=C:\\Users\\Jana Nováková\\AppData\\Local\\skydeck\\edge-profile',
  );
});

// ---------------------------------------------------------------------------------------------
// linkToOpen (S2 9.6)

test('linkToOpen gives an https URL back as it is', () => {
  assert.equal(linkToOpen('https://github.com/a/b/pull/1'), 'https://github.com/a/b/pull/1');
});

test('linkToOpen re-serialises what it opens', () => {
  assert.equal(linkToOpen('http://x'), 'http://x/');
  assert.equal(linkToOpen('HTTPS://GitHub.COM/a b'), 'https://github.com/a%20b');
});

test('linkToOpen refuses every scheme but http and https', () => {
  for (const url of [
    'file:///etc',
    'javascript:alert(1)',
    'data:text/html,<p>x</p>',
    'ftp://x/',
    'mailto:a@b.c',
    'vbscript:x',
    'ms-settings:',
    'edge://settings',
    // Schemes that merely start like http or https.
    'httpx://x/',
    'https-foo://x/',
    'http+unix://x/',
  ]) {
    assert.equal(linkToOpen(url), null, url);
  }
});

test('linkToOpen refuses a URL that keeps a " or a backslash once re-serialised', () => {
  // Either could change how a Windows program splits its command line.
  for (const url of ['https://a"b/', 'https:%22b', 'https://x/?a\\b', 'https://x/#a\\b']) {
    assert.equal(linkToOpen(url), null, url);
  }
});

test('linkToOpen opens a URL whose " or backslash the parser rewrites', () => {
  assert.equal(linkToOpen('https://x/a"b'), 'https://x/a%22b');
  assert.equal(linkToOpen('https://x/?q="a"'), 'https://x/?q=%22a%22');
  assert.equal(linkToOpen('https://x/a\\b'), 'https://x/a/b');
});

test('linkToOpen refuses what is not a URL, or could be read as an option', () => {
  for (const url of ['not a url', '-https://x', '--app=https://x', '', 'https://', '//x/y']) {
    assert.equal(linkToOpen(url), null, JSON.stringify(url));
  }
});

test('linkToOpen opens a URL of exactly 2,048 characters and refuses one of 2,049', () => {
  const base = 'https://github.com/';
  const at = `${base}${'a'.repeat(2048 - base.length)}`;
  assert.equal(at.length, 2048);
  assert.equal(linkToOpen(at), at);
  assert.equal(linkToOpen(`${at}b`), null);
  // The limit applies to what the page sent, too: 2,049 characters in, 2,048 once re-serialised.
  assert.equal(linkToOpen(` ${at}`), null);
});

test('linkToOpen refuses a URL that grows beyond 2,048 characters when re-serialised', () => {
  const url = `https://x/${'é'.repeat(1000)}`; // 1,010 characters; each é becomes %C3%A9
  assert.ok(url.length <= 2048);
  assert.equal(linkToOpen(url), null);
});
