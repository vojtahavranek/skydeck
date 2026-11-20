import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isAlive, isLiveFileTrusted, isSessionId, readLiveFiles } from '../../src/claude/live.ts';
import type { LiveFile, ProcessKey } from '../../src/claude/live.ts';
import type { Files } from '../../src/platform/types.ts';
import {
  BOOT_A,
  BOOT_B,
  fakeProc,
  S1,
  S2,
  SEC,
  statLine,
  T0,
  testPlatform,
} from '../helpers/platform.ts';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/claude/sessions/${name}`, import.meta.url));

const START = 51234567;
const running = () =>
  fakeProc({
    bootId: BOOT_A,
    processes: { 4242: { stat: statLine(4242, START), cmdline: ['claude'] } },
  });

/** `C/sessions/<pid>.json` with the fixture `name` as its content. */
function putFixture(claudeHome: string, name: string, pid = 4242): string {
  const dir = join(claudeHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${pid}.json`);
  copyFileSync(fixture(name), path);
  return path;
}

/**
 * `C/sessions/<file>` with the fields of fixture `base`, `changes` applied (undefined removes one).
 * The pid is the number in the file name unless `changes` says otherwise.
 */
function putVariant(
  claudeHome: string,
  file: string,
  changes: Record<string, unknown>,
  base = 'busy.json',
): string {
  const record = JSON.parse(readFileSync(fixture(base), 'utf8')) as Record<string, unknown>;
  if (/^[0-9]+\.json$/.test(file)) {
    record.pid = Number(file.slice(0, -'.json'.length));
  }
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete record[name];
    } else {
      record[name] = value;
    }
  }
  const dir = join(claudeHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(record));
  return path;
}

const mtimeOf = (path: string): bigint => statSync(path, { bigint: true }).mtimeNs;

// --- readLiveFiles -------------------------------------------------------------------------------

test('readLiveFiles normalises a busy live-session file', (t) => {
  const { platform, places } = testPlatform(t);
  const path = putFixture(places.claudeHome, 'busy.json');
  assert.deepEqual(readLiveFiles(platform.files, places.claudeHome), [
    {
      pid: 4242,
      sessionId: S1,
      cwd: '/home/dev/projects/demo',
      procStart: 51234567,
      entrypoint: 'cli',
      name: 'demo name',
      status: 'busy',
      waitingFor: null,
      updatedAtNs: T0 + 30n * SEC,
      statusUpdatedAtNs: T0 + 30n * SEC,
      background: false,
      mtimeNs: mtimeOf(path),
    },
  ]);
});

test('F34: readLiveFiles says the session runs in Claude Code’s background only for `kind` `bg`', (t) => {
  const { platform, places } = testPlatform(t);
  // The fixture's own `kind` is `interactive`, the value of every session started in a terminal.
  putVariant(places.claudeHome, '1.json', { kind: 'bg' });
  putVariant(places.claudeHome, '2.json', {});
  putVariant(places.claudeHome, '3.json', { kind: undefined });
  const others: unknown[] = ['BG', ' bg', 'bg ', 'background', '', true, 1, null, ['bg'], {}];
  others.forEach((kind, i) => {
    putVariant(places.claudeHome, `${i + 10}.json`, { kind });
  });
  const read = readLiveFiles(platform.files, places.claudeHome);
  assert.equal(read.length, 3 + others.length, 'the field never makes a file unreadable');
  assert.deepEqual(
    read.map((f) => [f.pid, f.background]),
    [[1, true], [2, false], [3, false], ...others.map((_kind, i) => [i + 10, false])],
  );
});

test('F34: a file that says `kind` `bg` but is broken or names no session is skipped as before', (t) => {
  const { platform, places } = testPlatform(t);
  const dir = join(places.claudeHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '4244.json'), `{"kind":"bg","pid":4244,"sessionId":"${S1}"`);
  writeFileSync(join(dir, '4250.json'), '["bg"]');
  putVariant(places.claudeHome, '4245.json', { kind: 'bg', sessionId: undefined });
  putVariant(places.claudeHome, '4246.json', { kind: 'bg', pid: 4247 });
  assert.deepEqual(readLiveFiles(platform.files, places.claudeHome), []);
});

test('readLiveFiles reads idle, waiting and shell files as found', (t) => {
  const { platform, places } = testPlatform(t);
  putVariant(places.claudeHome, '1.json', { pid: 1 }, 'idle.json');
  putVariant(places.claudeHome, '2.json', { pid: 2 }, 'waiting.json');
  putVariant(places.claudeHome, '3.json', { pid: 3 }, 'shell.json');
  assert.deepEqual(
    readLiveFiles(platform.files, places.claudeHome).map((f) => [f.pid, f.status, f.waitingFor]),
    [
      [1, 'idle', null],
      [2, 'waiting', 'permission prompt'],
      [3, 'shell', null],
    ],
  );
});

test('readLiveFiles takes the pid from the file content and sorts by it, numerically', (t) => {
  const { platform, places } = testPlatform(t);
  for (const [file, pid] of [
    ['10000.json', 10000],
    ['99.json', 99],
    ['4300.json', 4300],
    ['4242.json', 4242],
  ] as const) {
    putVariant(places.claudeHome, file, { pid });
  }
  assert.deepEqual(
    readLiveFiles(platform.files, places.claudeHome).map((f) => f.pid),
    [99, 4242, 4300, 10000],
  );
});

test('readLiveFiles accepts procStart as the number 77 and as a decimal string', (t) => {
  const { platform, places } = testPlatform(t);
  putVariant(places.claudeHome, '1.json', { pid: 1, procStart: 77 });
  putVariant(places.claudeHome, '2.json', { pid: 2, procStart: '0077' });
  assert.deepEqual(
    readLiveFiles(platform.files, places.claudeHome).map((f) => f.procStart),
    [77, 77],
  );
});

test('readLiveFiles gives null for a procStart that is not a safe non-negative integer', (t) => {
  const { platform, places } = testPlatform(t);
  const bad: unknown[] = [
    '12x',
    '',
    ' 5',
    '-5',
    '1.5',
    '9007199254740992',
    -1,
    1.5,
    null,
    true,
    {},
  ];
  bad.forEach((procStart, i) => {
    putVariant(places.claudeHome, `${i + 1}.json`, { pid: i + 1, procStart });
  });
  putVariant(places.claudeHome, '100.json', { pid: 100 });
  putVariant(places.claudeHome, '101.json', { pid: 101, procStart: undefined });
  const read = readLiveFiles(platform.files, places.claudeHome);
  assert.equal(read.length, bad.length + 2);
  assert.deepEqual(
    read.filter((f) => f.pid <= bad.length || f.pid === 101).map((f) => f.procStart),
    Array(bad.length + 1).fill(null),
  );
  assert.equal(read.find((f) => f.pid === 100)?.procStart, 51234567);
});

test('readLiveFiles gives null for a time that is absent, not a number or out of range', (t) => {
  const { platform, places } = testPlatform(t);
  putVariant(places.claudeHome, '1.json', { pid: 1, statusUpdatedAt: undefined });
  putVariant(places.claudeHome, '2.json', { pid: 2, updatedAt: '1794474030000' });
  putVariant(places.claudeHome, '3.json', { pid: 3, updatedAt: -1, statusUpdatedAt: 1e300 });
  putVariant(places.claudeHome, '4.json', { pid: 4, updatedAt: 8.64e15 + 1 });
  putVariant(places.claudeHome, '5.json', { pid: 5, updatedAt: null, statusUpdatedAt: NaN });
  const times = readLiveFiles(platform.files, places.claudeHome).map((f) => [
    f.updatedAtNs,
    f.statusUpdatedAtNs,
  ]);
  assert.deepEqual(times, [
    [T0 + 30n * SEC, null],
    [null, T0 + 30n * SEC],
    [null, null],
    [null, T0 + 30n * SEC],
    [null, null],
  ]);
});

test('readLiveFiles keeps a time that has a fraction of a millisecond, truncated', (t) => {
  const { platform, places } = testPlatform(t);
  putVariant(places.claudeHome, '1.json', { pid: 1, updatedAt: 1794474030000.9 });
  assert.equal(readLiveFiles(platform.files, places.claudeHome)[0]?.updatedAtNs, T0 + 30n * SEC);
});

test('readLiveFiles gives null for text fields that are not strings', (t) => {
  const { platform, places } = testPlatform(t);
  putVariant(places.claudeHome, '1.json', {
    pid: 1,
    cwd: 5,
    entrypoint: ['cli'],
    name: {},
    status: 7,
    waitingFor: false,
  });
  putVariant(places.claudeHome, '2.json', {
    pid: 2,
    cwd: undefined,
    entrypoint: undefined,
    name: undefined,
    status: undefined,
  });
  for (const f of readLiveFiles(platform.files, places.claudeHome)) {
    assert.deepEqual([f.cwd, f.entrypoint, f.name, f.status, f.waitingFor], Array(5).fill(null));
  }
});

test('readLiveFiles keeps a status it does not know, as found', (t) => {
  const { platform, places } = testPlatform(t);
  putVariant(places.claudeHome, '1.json', { pid: 1, status: 'compacting' });
  assert.equal(readLiveFiles(platform.files, places.claudeHome)[0]?.status, 'compacting');
});

test('readLiveFiles skips a file that is not JSON, not an object, or lacks a pid or a session id', (t) => {
  const { platform, places } = testPlatform(t);
  const dir = join(places.claudeHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '4244.json'), '{');
  writeFileSync(join(dir, '4249.json'), '');
  writeFileSync(join(dir, '4250.json'), '[1,2]');
  writeFileSync(join(dir, '4251.json'), 'null');
  writeFileSync(join(dir, '4252.json'), '"text"');
  putVariant(places.claudeHome, '4245.json', { sessionId: undefined });
  putVariant(places.claudeHome, '4253.json', { sessionId: 7 });
  putVariant(places.claudeHome, '4254.json', { sessionId: '' });
  putVariant(places.claudeHome, '4255.json', { pid: undefined });
  putVariant(places.claudeHome, '4256.json', { pid: '4256' });
  putVariant(places.claudeHome, '4257.json', { pid: 0 });
  putVariant(places.claudeHome, '4258.json', { pid: -4258 });
  putVariant(places.claudeHome, '4259.json', { pid: 42.5 });
  putVariant(places.claudeHome, '4260.json', { pid: 1e300 });
  assert.deepEqual(readLiveFiles(platform.files, places.claudeHome), []);
});

test('isSessionId accepts a lowercase UUID and nothing else', () => {
  assert.equal(isSessionId(S1), true);
  assert.equal(isSessionId(S2), true);
  assert.equal(isSessionId('00000000-0000-4000-8000-000000000001'), true);
  const rejected = [
    '',
    S1.toUpperCase(),
    `${S1}\n`,
    `\n${S1}`,
    ` ${S1}`,
    `${S1}x`,
    S1.replaceAll('-', ''),
    S1.slice(1),
    S1.replace('0', 'g'),
    '--dangerously-skip-permissions',
    '-r',
    'latest',
  ];
  for (const text of rejected) {
    assert.equal(isSessionId(text), false, JSON.stringify(text));
  }
});

test('readLiveFiles skips a file whose sessionId is not a lowercase UUID', (t) => {
  const { platform, places } = testPlatform(t);
  // The id ends up after `--resume` on a command line: a flag-like value must never get through.
  const rejected: unknown[] = [
    '',
    7,
    null,
    '--dangerously-skip-permissions',
    S1.toUpperCase(),
    `${S1}\n`,
    ` ${S1}`,
    S1.slice(0, -1),
    [S1],
  ];
  rejected.forEach((sessionId, i) => {
    putVariant(places.claudeHome, `${i + 1}.json`, { sessionId });
  });
  putVariant(places.claudeHome, '100.json', { sessionId: S2 });
  assert.deepEqual(
    readLiveFiles(platform.files, places.claudeHome).map((f) => [f.pid, f.sessionId]),
    [[100, S2]],
  );
});

test('readLiveFiles uses a file only when the pid inside is the number in its name', (t) => {
  const { platform, places } = testPlatform(t);
  putVariant(places.claudeHome, '4242.json', {});
  putVariant(places.claudeHome, '4244.json', { pid: 9999 });
  putVariant(places.claudeHome, '04245.json', { pid: 4245 });
  putVariant(places.claudeHome, '4246.json', { pid: 4247 });
  putVariant(places.claudeHome, '9999.json', { pid: 9999 });
  assert.deepEqual(
    readLiveFiles(platform.files, places.claudeHome).map((f) => f.pid),
    [4242, 9999],
  );
});

test('readLiveFiles never opens a name other than <digits>.json', (t) => {
  const { platform, places } = testPlatform(t);
  const dir = join(places.claudeHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  const names = [
    '4246.json.tmp',
    '.4242.json.abc.tmp',
    'abc.json',
    'credentials.json',
    '4242.json.bak',
    '-4242.json',
    '+4242.json',
    ' 4242.json',
    '4242.JSON',
    '4242json',
    '.json',
    'x4242.json',
  ];
  for (const name of names) {
    putVariant(places.claudeHome, name, { pid: 4242 });
  }
  mkdirSync(join(dir, 'subdir.json'));
  const touched: string[] = [];
  const spy = new Proxy(platform.files, {
    get(target, prop, receiver) {
      const member: unknown = Reflect.get(target, prop, receiver);
      if (typeof member !== 'function' || prop === 'list') return member;
      return (path: string, ...rest: unknown[]) => {
        touched.push(path);
        return (member as (...args: unknown[]) => unknown).call(target, path, ...rest);
      };
    },
  }) as Files;
  assert.deepEqual(readLiveFiles(spy, places.claudeHome), []);
  assert.deepEqual(touched, []);
  // Dot-segments and the directory itself are never opened either.
  putFixture(places.claudeHome, 'busy.json');
  assert.equal(readLiveFiles(spy, places.claudeHome).length, 1);
  assert.deepEqual(
    touched.filter((path) => !/\/sessions\/[0-9]+\.json$/.test(path)),
    [],
  );
});

test('readLiveFiles does not open a file named abc.json whose mode is 000 (and does not throw)', (t) => {
  const { platform, places } = testPlatform(t);
  putFixture(places.claudeHome, 'busy.json', 4242);
  const secret = putVariant(places.claudeHome, 'abc.json', { pid: 1 });
  chmodSync(secret, 0o000);
  assert.deepEqual(
    readLiveFiles(platform.files, places.claudeHome).map((f) => f.pid),
    [4242],
  );
});

test('readLiveFiles skips a <digits>.json it cannot read, and a directory with such a name', (t) => {
  const { platform, places } = testPlatform(t);
  putFixture(places.claudeHome, 'busy.json', 4242);
  const unreadable = putVariant(places.claudeHome, '4247.json', { pid: 4247 });
  chmodSync(unreadable, 0o000);
  mkdirSync(join(places.claudeHome, 'sessions', '4248.json'));
  const pids = readLiveFiles(platform.files, places.claudeHome).map((f) => f.pid);
  // A process running as root can read a mode-000 file; the rest of the test holds either way.
  assert.deepEqual(
    pids.filter((pid) => pid !== 4247),
    [4242],
  );
});

test('readLiveFiles follows a symbolic link that is named <digits>.json', (t) => {
  const { platform, places } = testPlatform(t);
  const target = join(places.claudeHome, 'elsewhere.txt');
  copyFileSync(fixture('busy.json'), target);
  mkdirSync(join(places.claudeHome, 'sessions'));
  symlinkSync(target, join(places.claudeHome, 'sessions', '4242.json'));
  symlinkSync(join(places.claudeHome, 'missing'), join(places.claudeHome, 'sessions', '4243.json'));
  assert.deepEqual(
    readLiveFiles(platform.files, places.claudeHome).map((f) => f.pid),
    [4242],
  );
});

test('readLiveFiles gives [] when the sessions directory cannot be listed', (t) => {
  const { platform, places } = testPlatform(t);
  putFixture(places.claudeHome, 'busy.json');
  const denied = new Proxy(platform.files, {
    get(target, prop, receiver) {
      if (prop === 'list') {
        return () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  assert.deepEqual(readLiveFiles(denied, places.claudeHome), []);
});

test('readLiveFiles gives [] when the sessions directory is missing', (t) => {
  const { platform, places } = testPlatform(t);
  assert.deepEqual(readLiveFiles(platform.files, places.claudeHome), []);
});

// --- isAlive -------------------------------------------------------------------------------------

const key = (over: Partial<ProcessKey> = {}): ProcessKey => ({
  bootId: BOOT_A,
  pid: 4242,
  procStart: START,
  ...over,
});

test('isAlive is true for the same boot, an existing pid and an equal start time', () => {
  assert.equal(isAlive(key(), running(), BOOT_A), true);
});

test('isAlive is false after a reboot (another boot id)', () => {
  assert.equal(isAlive(key(), running(), BOOT_B), false);
  assert.equal(isAlive(key({ bootId: BOOT_B }), running(), BOOT_A), false);
});

test('isAlive is false when the pid now has another start time (reused pid)', () => {
  assert.equal(isAlive(key({ procStart: 999 }), running(), BOOT_A), false);
});

test('isAlive is false when the pid does not exist', () => {
  assert.equal(isAlive(key({ pid: 4243 }), running(), BOOT_A), false);
});

test('isAlive is false without a recorded process start', () => {
  assert.equal(isAlive(key({ procStart: null }), running(), BOOT_A), false);
});

test('isAlive is false without a recorded process start for a pid that does not exist either', () => {
  // Nothing known on both sides must not count as "equal": a hook event without a readable stat.
  assert.equal(isAlive(key({ pid: 9999, procStart: null }), running(), BOOT_A), false);
  const unreadable = fakeProc({
    bootId: BOOT_A,
    processes: { 9999: { stat: 'garbage', cmdline: ['claude'] } },
  });
  assert.equal(isAlive(key({ pid: 9999, procStart: null }), unreadable, BOOT_A), false);
});

test('isAlive is false when the current boot id is unknown', () => {
  assert.equal(isAlive(key(), running(), null), false);
});

test('isAlive is false when the stat line has no readable field 22', () => {
  const proc = fakeProc({
    bootId: BOOT_A,
    processes: { 4242: { stat: '4242 (claude) S 1', cmdline: ['claude'] } },
  });
  assert.equal(isAlive(key(), proc, BOOT_A), false);
});

test('isAlive does not read /proc when the boot differs', () => {
  const reads: number[] = [];
  const proc = running();
  const watched = {
    ...proc,
    stat: (pid: number) => {
      reads.push(pid);
      return proc.stat(pid);
    },
  };
  assert.equal(isAlive(key({ bootId: BOOT_B }), watched, BOOT_A), false);
  assert.deepEqual(reads, []);
});

// --- isLiveFileTrusted ---------------------------------------------------------------------------

function liveFile(t: Parameters<typeof testPlatform>[0], name: string): LiveFile {
  const { platform, places } = testPlatform(t);
  putFixture(places.claudeHome, name);
  const [file] = readLiveFiles(platform.files, places.claudeHome);
  assert.ok(file);
  return file;
}

test('isLiveFileTrusted is true when pid and procStart match a process', (t) => {
  assert.equal(isLiveFileTrusted(liveFile(t, 'busy.json'), running()), true);
});

test('isLiveFileTrusted is false without a procStart', (t) => {
  const file = { ...liveFile(t, 'busy.json'), procStart: null };
  assert.equal(isLiveFileTrusted(file, running()), false);
});

test('isLiveFileTrusted is false without a procStart for a pid that does not exist either', (t) => {
  // Nothing known on both sides must not count as "equal".
  const file = { ...liveFile(t, 'busy.json'), pid: 9999, procStart: null };
  assert.equal(isLiveFileTrusted(file, running()), false);
  const unreadable = fakeProc({
    bootId: BOOT_A,
    processes: { 9999: { stat: 'garbage', cmdline: ['claude'] } },
  });
  assert.equal(isLiveFileTrusted(file, unreadable), false);
});

test('isLiveFileTrusted is false for the stale fixture (the pid belongs to another process now)', (t) => {
  assert.equal(isLiveFileTrusted(liveFile(t, 'stale.json'), running()), false);
});

test('isLiveFileTrusted is false when the pid is absent from /proc', (t) => {
  const file = { ...liveFile(t, 'busy.json'), pid: 4243 };
  assert.equal(isLiveFileTrusted(file, running()), false);
});

test('isLiveFileTrusted does not look at the boot id', (t) => {
  const proc = fakeProc({
    bootId: BOOT_B,
    processes: { 4242: { stat: statLine(4242, START), cmdline: ['claude'] } },
  });
  assert.equal(isLiveFileTrusted(liveFile(t, 'busy.json'), proc), true);
});
