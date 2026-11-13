import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EMPTY_FACTS,
  foldLines,
  listTranscriptFiles,
  readTranscript,
} from '../../src/claude/transcripts.ts';
import type { TranscriptFacts, TranscriptFile } from '../../src/claude/transcripts.ts';
import { isoFromNs, nsFromIso } from '../../src/platform/time.ts';
import type { Files, Ns } from '../../src/platform/types.ts';
import { S1, S2, S3, SEC, T0, testPlatform } from '../helpers/platform.ts';

const recordsFixture = (): string[] =>
  readFileSync(
    fileURLToPath(new URL('../fixtures/claude/transcripts/records.jsonl', import.meta.url)),
    'utf8',
  )
    .split('\n')
    .filter((line) => line !== '');

// --- building lines ------------------------------------------------------------------------------

const rec = (type: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, sessionId: S1, ...fields });
const stamp = (ns: Ns): string => isoFromNs(ns);
const user = (ns: Ns, fields: Record<string, unknown> = {}): string =>
  rec('user', {
    timestamp: stamp(ns),
    cwd: '/w',
    entrypoint: 'cli',
    message: { role: 'user', content: '<redacted>' },
    ...fields,
  });
const assistant = (ns: Ns, fields: Record<string, unknown> = {}): string =>
  rec('assistant', {
    timestamp: stamp(ns),
    cwd: '/w',
    entrypoint: 'cli',
    message: { role: 'assistant', content: '<redacted>' },
    ...fields,
  });
const prLink = (url: string, ns: Ns): string =>
  rec('pr-link', { prUrl: url, prNumber: 7, prRepository: 'o/r', timestamp: stamp(ns) });

const fold = (...lines: string[]) => foldLines(EMPTY_FACTS, lines);
const foldMore = (facts: TranscriptFacts, ...lines: string[]) => foldLines(facts, lines).facts;

const ALL_NULL: TranscriptFacts = {
  firstCwd: null,
  entrypoint: null,
  aiTitle: null,
  customTitle: null,
  firstRecordNs: null,
  lastRecordNs: null,
  lastUserNs: null,
  lastTurnRole: null,
};

// --- listTranscriptFiles -------------------------------------------------------------------------

test('listTranscriptFiles returns the uuid.jsonl files two levels deep, sorted by path', (t) => {
  const { platform, places } = testPlatform(t);
  const c = places.claudeHome;
  const demo = join(c, 'projects', '-home-dev-projects-demo');
  const other = join(c, 'projects', 'other');
  mkdirSync(join(demo, S1, 'subagents'), { recursive: true });
  mkdirSync(join(demo, `${S3}.jsonl`), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, `${S2}.jsonl`), 'xy\n');
  writeFileSync(join(demo, `${S1}.jsonl`), 'abc\n');
  writeFileSync(join(demo, S1, 'subagents', 'agent-1.jsonl'), 'nested\n');
  writeFileSync(join(demo, `${S1}.jsonl.bak`), 'bak\n');
  writeFileSync(join(demo, `${S1} (copy).jsonl`), 'copy\n');
  writeFileSync(join(demo, `${S1.toUpperCase()}.jsonl`), 'upper\n');
  writeFileSync(join(demo, 'notes.txt'), 'notes\n');
  writeFileSync(join(c, 'projects', `${S3}.jsonl`), 'one level deep\n');
  writeFileSync(join(demo, S1, 'subagents', `${S3}.jsonl`), 'three levels\n');
  writeFileSync(join(c, 'projects', 'README.md'), 'text\n');

  const { files: listed, unreadable } = listTranscriptFiles(platform.files, c);
  assert.deepEqual(
    listed.map((f) => [f.path, f.sessionId, f.size]),
    [
      [join(demo, `${S1}.jsonl`), S1, 4],
      [join(other, `${S2}.jsonl`), S2, 3],
    ],
  );
  assert.equal(listed[0]?.mtimeNs, statSync(join(demo, `${S1}.jsonl`), { bigint: true }).mtimeNs);
  assert.equal(listed[1]?.mtimeNs, statSync(join(other, `${S2}.jsonl`), { bigint: true }).mtimeNs);
  assert.deepEqual(unreadable, []);
});

test('listTranscriptFiles sorts by the whole path, not by folder name then file name', (t) => {
  const { platform, places } = testPlatform(t);
  const projects = join(places.claudeHome, 'projects');
  // 'a' sorts before 'a-b' as a name, but 'a-b/…' sorts before 'a/…' as a path ('-' < '/').
  mkdirSync(join(projects, 'a'), { recursive: true });
  mkdirSync(join(projects, 'a-b'), { recursive: true });
  writeFileSync(join(projects, 'a', `${S1}.jsonl`), '\n');
  writeFileSync(join(projects, 'a-b', `${S1}.jsonl`), '\n');
  const paths = listTranscriptFiles(platform.files, places.claudeHome).files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.deepEqual(paths, [
    join(projects, 'a-b', `${S1}.jsonl`),
    join(projects, 'a', `${S1}.jsonl`),
  ]);
});

test('listTranscriptFiles ignores symbolic links to files, follows a symbolic link to a folder', (t) => {
  const { platform, places, sandbox } = testPlatform(t);
  const projects = join(places.claudeHome, 'projects');
  const real = join(sandbox.root, 'relocated');
  mkdirSync(join(projects, 'plain'), { recursive: true });
  mkdirSync(real);
  writeFileSync(join(real, `${S2}.jsonl`), 'x\n');
  writeFileSync(join(sandbox.root, 'outside.jsonl'), 'x\n');
  symlinkSync(real, join(projects, 'moved'));
  symlinkSync(join(sandbox.root, 'outside.jsonl'), join(projects, 'plain', `${S1}.jsonl`));
  symlinkSync(join(projects, 'nowhere'), join(projects, 'plain', `${S3}.jsonl`));
  const { files, unreadable } = listTranscriptFiles(platform.files, places.claudeHome);
  assert.deepEqual(
    files.map((f) => f.path),
    [join(projects, 'moved', `${S2}.jsonl`)],
  );
  // A link that is not a transcript, or points nowhere, is not something skydeck failed to read.
  assert.deepEqual(unreadable, []);
});

/**
 * `files`, except that `method` throws on a path containing `needle`, with an error that has `code`
 * (as the real ones do for ELOOP or EACCES), or none when `code` is ''.
 */
function failingOn(
  files: Files,
  method: 'stat' | 'lstat' | 'list',
  needle: string,
  code: string,
): Files {
  return new Proxy(files, {
    get(target, prop, receiver) {
      if (prop !== method) return Reflect.get(target, prop, receiver) as unknown;
      return (path: string) => {
        if (path.includes(needle)) {
          throw code === ''
            ? new Error(`failed: ${path}`)
            : Object.assign(new Error(`${code}: ${path}`), { code });
        }
        return target[method](path);
      };
    },
  });
}

/** `files`, except that `stat` says a path is gone (null) when it contains `needle`. */
function vanishing(files: Files, needle: string): Files {
  return new Proxy(files, {
    get(target, prop, receiver) {
      if (prop !== 'stat') return Reflect.get(target, prop, receiver) as unknown;
      return (path: string) => (path.includes(needle) ? null : target.stat(path));
    },
  });
}

test('listTranscriptFiles reports an entry whose stat, list or lstat fails, and lists the rest', (t) => {
  const { platform, places } = testPlatform(t);
  const projects = join(places.claudeHome, 'projects');
  for (const folder of ['denied', 'half', 'looping']) {
    mkdirSync(join(projects, folder), { recursive: true });
    writeFileSync(join(projects, folder, `${S1}.jsonl`), 'x\n');
  }
  writeFileSync(join(projects, 'half', `${S2}.jsonl`), 'x\n');
  const at = (folder: string, id = S1): string => join(projects, folder, `${id}.jsonl`);
  const listed = (files: Files) => {
    const { files: found, unreadable } = listTranscriptFiles(files, places.claudeHome);
    return { paths: found.map((f) => f.path), unreadable };
  };

  // stat of a folder fails (a symbolic link loop): that folder is reported and skipped
  assert.deepEqual(listed(failingOn(platform.files, 'stat', 'looping', 'ELOOP')), {
    paths: [at('denied'), at('half'), at('half', S2)],
    unreadable: [{ path: join(projects, 'looping'), reason: 'ELOOP' }],
  });
  // list of a folder fails (permissions): the same
  assert.deepEqual(listed(failingOn(platform.files, 'list', 'denied', 'EACCES')), {
    paths: [at('half'), at('half', S2), at('looping')],
    unreadable: [{ path: join(projects, 'denied'), reason: 'EACCES' }],
  });
  // lstat of one file fails: that file is reported and skipped
  assert.deepEqual(listed(failingOn(platform.files, 'lstat', `half/${S2}`, 'EACCES')), {
    paths: [at('denied'), at('half'), at('looping')],
    unreadable: [{ path: at('half', S2), reason: 'EACCES' }],
  });
});

test('listTranscriptFiles gives a reason even for an error without a code, and sorts what it reports', (t) => {
  const { platform, places } = testPlatform(t);
  const projects = join(places.claudeHome, 'projects');
  for (const folder of ['a', 'a-b', 'b']) {
    mkdirSync(join(projects, folder), { recursive: true });
    writeFileSync(join(projects, folder, `${S1}.jsonl`), 'x\n');
  }
  // Found in the order a/<id>, then a-b; by path 'a-b' sorts before 'a/…' ('-' < '/').
  const failing = failingOn(
    failingOn(platform.files, 'list', join(projects, 'a-b'), ''),
    'lstat',
    join(projects, 'a', S1),
    'EACCES',
  );
  const { files, unreadable } = listTranscriptFiles(failing, places.claudeHome);
  assert.deepEqual(
    files.map((f) => f.path),
    [join(projects, 'b', `${S1}.jsonl`)],
  );
  assert.deepEqual(unreadable, [
    { path: join(projects, 'a-b'), reason: 'unknown error' },
    { path: join(projects, 'a', `${S1}.jsonl`), reason: 'EACCES' },
  ]);
});

test('listTranscriptFiles does not report a folder or file that is gone by the time it is looked at', (t) => {
  const { platform, places } = testPlatform(t);
  const projects = join(places.claudeHome, 'projects');
  mkdirSync(join(projects, 'gone'), { recursive: true });
  mkdirSync(join(projects, 'here'), { recursive: true });
  writeFileSync(join(projects, 'gone', `${S1}.jsonl`), 'x\n');
  writeFileSync(join(projects, 'here', `${S1}.jsonl`), 'x\n');
  const { files, unreadable } = listTranscriptFiles(
    vanishing(platform.files, 'gone'),
    places.claudeHome,
  );
  assert.deepEqual(
    files.map((f) => f.path),
    [join(projects, 'here', `${S1}.jsonl`)],
  );
  assert.deepEqual(unreadable, []);
});

test('listTranscriptFiles reports the projects directory when it cannot be listed', (t) => {
  const { platform, places } = testPlatform(t);
  const projects = join(places.claudeHome, 'projects');
  mkdirSync(join(projects, 'p'), { recursive: true });
  writeFileSync(join(projects, 'p', `${S1}.jsonl`), 'x\n');
  const denied = failingOn(platform.files, 'list', projects, 'EACCES');
  assert.deepEqual(listTranscriptFiles(denied, places.claudeHome), {
    files: [],
    unreadable: [{ path: projects, reason: 'EACCES' }],
  });
});

test('listTranscriptFiles reports a symbolic link loop in projects', (t) => {
  const { platform, places } = testPlatform(t);
  const projects = join(places.claudeHome, 'projects');
  mkdirSync(join(projects, 'good'), { recursive: true });
  writeFileSync(join(projects, 'good', `${S1}.jsonl`), 'x\n');
  symlinkSync(join(projects, 'loop'), join(projects, 'loop'));
  const { files, unreadable } = listTranscriptFiles(platform.files, places.claudeHome);
  assert.deepEqual(
    files.map((f) => f.path),
    [join(projects, 'good', `${S1}.jsonl`)],
  );
  assert.deepEqual(unreadable, [{ path: join(projects, 'loop'), reason: 'ELOOP' }]);
});

test(
  'listTranscriptFiles reports a project folder with mode 000',
  { skip: process.getuid?.() === 0 },
  (t) => {
    const { platform, places } = testPlatform(t);
    const projects = join(places.claudeHome, 'projects');
    mkdirSync(join(projects, 'good'), { recursive: true });
    mkdirSync(join(projects, 'closed'), { recursive: true });
    writeFileSync(join(projects, 'good', `${S1}.jsonl`), 'x\n');
    writeFileSync(join(projects, 'closed', `${S2}.jsonl`), 'x\n');
    chmodSync(join(projects, 'closed'), 0o000);
    try {
      const { files, unreadable } = listTranscriptFiles(platform.files, places.claudeHome);
      assert.deepEqual(
        files.map((f) => f.path),
        [join(projects, 'good', `${S1}.jsonl`)],
      );
      assert.deepEqual(unreadable, [{ path: join(projects, 'closed'), reason: 'EACCES' }]);
    } finally {
      chmodSync(join(projects, 'closed'), 0o700); // the sandbox cannot remove it otherwise
    }
  },
);

test(
  'listTranscriptFiles reports projects itself when it has mode 000',
  { skip: process.getuid?.() === 0 },
  (t) => {
    const { platform, places } = testPlatform(t);
    const projects = join(places.claudeHome, 'projects');
    mkdirSync(join(projects, 'p'), { recursive: true });
    chmodSync(projects, 0o000);
    try {
      assert.deepEqual(listTranscriptFiles(platform.files, places.claudeHome), {
        files: [],
        unreadable: [{ path: projects, reason: 'EACCES' }],
      });
    } finally {
      chmodSync(projects, 0o700);
    }
  },
);

test('listTranscriptFiles gives nothing, and reports nothing, when projects is missing or empty', (t) => {
  const { platform, places } = testPlatform(t);
  assert.deepEqual(listTranscriptFiles(platform.files, places.claudeHome), {
    files: [],
    unreadable: [],
  });
  mkdirSync(join(places.claudeHome, 'projects'));
  assert.deepEqual(listTranscriptFiles(platform.files, places.claudeHome), {
    files: [],
    unreadable: [],
  });
});

test('listTranscriptFiles lists an empty file, and reads folder names as opaque text', (t) => {
  const { platform, places } = testPlatform(t);
  const folder = join(places.claudeHome, 'projects', '-weird (folder) – ünï.jsonl');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${S1}.jsonl`), '');
  const [file] = listTranscriptFiles(platform.files, places.claudeHome).files;
  assert.equal(file?.size, 0);
  assert.equal(file?.sessionId, S1);
});

// --- foldLines -----------------------------------------------------------------------------------

test('foldLines reads the first user line', () => {
  const { facts, prUrls } = fold(user(T0, { cwd: '/w', entrypoint: 'cli' }));
  assert.deepEqual(facts, {
    ...ALL_NULL,
    firstCwd: '/w',
    entrypoint: 'cli',
    firstRecordNs: T0,
    lastRecordNs: T0,
    lastUserNs: T0,
    lastTurnRole: 'user',
  });
  assert.deepEqual(prUrls, []);
});

test('foldLines: an assistant line moves the last record and the last turn, not the first cwd', () => {
  const first = fold(user(T0)).facts;
  const facts = foldMore(first, assistant(T0 + 5n * SEC, { cwd: '/other' }));
  assert.equal(facts.firstCwd, '/w');
  assert.equal(facts.firstRecordNs, T0);
  assert.equal(facts.lastRecordNs, T0 + 5n * SEC);
  assert.equal(facts.lastUserNs, T0);
  assert.equal(facts.lastTurnRole, 'assistant');
});

test('foldLines: a later user line (a tool result) makes the last turn a user turn again, but is not user input', () => {
  let facts = fold(user(T0), assistant(T0 + 5n * SEC)).facts;
  facts = foldMore(facts, user(T0 + 6n * SEC, { toolUseResult: { content: '<redacted>' } }));
  assert.equal(facts.lastTurnRole, 'user');
  assert.equal(facts.lastUserNs, T0);
});

test('foldLines: system, ai-title and pr-link lines leave the last turn alone', () => {
  let facts = fold(user(T0)).facts;
  facts = foldMore(
    facts,
    rec('system', { timestamp: stamp(T0 + SEC), subtype: 'x', content: '<redacted>' }),
    rec('ai-title', { aiTitle: 'T' }),
    prLink('https://github.com/o/r/pull/7', T0 + 2n * SEC),
  );
  assert.equal(facts.lastTurnRole, 'user');
  assert.equal(facts.lastUserNs, T0);
  assert.equal(facts.lastRecordNs, T0 + 2n * SEC);
});

test('foldLines: the last turn follows file order, not timestamps', () => {
  const { facts } = fold(user(T0 + 20n * SEC), assistant(T0 + 10n * SEC));
  assert.equal(facts.lastTurnRole, 'assistant');
  assert.equal(facts.lastUserNs, T0 + 20n * SEC);
  assert.equal(facts.lastRecordNs, T0 + 20n * SEC);
  assert.equal(facts.firstRecordNs, T0 + 10n * SEC);
});

test('foldLines: lastUserNs is the largest user timestamp, whatever the order', () => {
  const { facts } = fold(user(T0 + 20n * SEC), user(T0 + 10n * SEC));
  assert.equal(facts.lastUserNs, T0 + 20n * SEC);
});

test('foldLines: a user or assistant line without a usable timestamp still sets the last turn', () => {
  const noTime = rec('assistant', { cwd: '/w' });
  const badTime = rec('user', { timestamp: 'bad' });
  assert.deepEqual(fold(noTime).facts, { ...ALL_NULL, firstCwd: '/w', lastTurnRole: 'assistant' });
  assert.deepEqual(fold(badTime).facts, { ...ALL_NULL, lastTurnRole: 'user' });
});

test('foldLines: the latest ai-title and the latest custom-title win', () => {
  const { facts } = fold(
    rec('ai-title', { aiTitle: 'First' }),
    rec('custom-title', { customTitle: 'Mine' }),
    rec('ai-title', { aiTitle: 'Second' }),
    rec('custom-title', { customTitle: 'Mine, renamed' }),
  );
  assert.equal(facts.aiTitle, 'Second');
  assert.equal(facts.customTitle, 'Mine, renamed');
});

test('foldLines: a title that is not a string, and a title record of another kind, are ignored', () => {
  const { facts } = fold(
    rec('ai-title', { aiTitle: 'Kept' }),
    rec('ai-title', { aiTitle: 5 }),
    rec('ai-title', {}),
    rec('custom-title', { aiTitle: 'Wrong field' }),
    rec('agent-name', { agentName: 'Not a title' }),
    rec('user', { aiTitle: 'In a user record', customTitle: 'Here too' }),
  );
  assert.equal(facts.aiTitle, 'Kept');
  assert.equal(facts.customTitle, null);
});

test('foldLines: a title the user cleared (an empty string) replaces the earlier one', () => {
  const { facts } = fold(
    rec('custom-title', { customTitle: 'Mine' }),
    rec('custom-title', { customTitle: '' }),
  );
  assert.equal(facts.customTitle, '');
});

test('foldLines returns the prUrl of a pr-link and counts its timestamp', () => {
  const { facts, prUrls } = fold(prLink('https://github.com/o/r/pull/7', T0 + 9n * SEC));
  assert.deepEqual(prUrls, ['https://github.com/o/r/pull/7']);
  assert.equal(facts.firstRecordNs, T0 + 9n * SEC);
  assert.equal(facts.lastRecordNs, T0 + 9n * SEC);
});

test('foldLines returns every pr-link url in order, repeats included', () => {
  const { prUrls } = fold(
    prLink('https://github.com/o/r/pull/7', T0),
    prLink('https://github.com/o/r/pull/8', T0 + SEC),
    prLink('https://github.com/o/r/pull/7', T0 + 2n * SEC),
  );
  assert.deepEqual(prUrls, [
    'https://github.com/o/r/pull/7',
    'https://github.com/o/r/pull/8',
    'https://github.com/o/r/pull/7',
  ]);
});

test('foldLines skips a pr-link without a string prUrl, and only a pr-link counts', () => {
  const { prUrls } = fold(
    rec('pr-link', { prNumber: 7 }),
    rec('pr-link', { prUrl: 7 }),
    rec('user', { prUrl: 'https://github.com/o/r/pull/9' }),
    prLink('https://github.com/o/r/pull/10', T0),
  );
  assert.deepEqual(prUrls, ['https://github.com/o/r/pull/10']);
});

test('foldLines changes nothing for lines that are not JSON objects', () => {
  const before = fold(user(T0)).facts;
  const junk = ['not json', '[1,2]', 'null', '"text"', '42', 'true', '', '   ', '{', '{"type":'];
  const after = foldLines(before, junk);
  assert.deepEqual(after.facts, before);
  assert.deepEqual(after.prUrls, []);
});

test('foldLines changes nothing for a record with an unusable timestamp', () => {
  const before = fold(user(T0)).facts;
  const lines = [
    rec('system', { timestamp: 'bad' }),
    rec('system', { timestamp: '2026-11-12' }),
    rec('system', { timestamp: '2026-11-12T09:00:00' }),
    rec('system', { timestamp: 1794474000000 }),
    rec('system', { timestamp: null }),
    rec('system', { timestamp: {} }),
    rec('system'),
  ];
  assert.deepEqual(foldLines(before, lines).facts, before);
});

test('foldLines: a later line with an earlier timestamp makes firstRecordNs the minimum', () => {
  const { facts } = fold(user(T0 + 10n * SEC), assistant(T0 + 5n * SEC), user(T0 + 8n * SEC));
  assert.equal(facts.firstRecordNs, T0 + 5n * SEC);
  assert.equal(facts.lastRecordNs, T0 + 10n * SEC);
});

test('foldLines takes timestamps with an offset and milliseconds', () => {
  const { facts } = fold(
    rec('system', { timestamp: '2026-11-12T10:00:00.500+01:00' }),
    rec('system', { timestamp: '2026-11-12T09:00:01Z' }),
  );
  assert.equal(facts.firstRecordNs, T0 + 500_000_000n);
  assert.equal(facts.lastRecordNs, T0 + SEC);
});

test('foldLines: the first entrypoint wins, whatever it is', () => {
  assert.equal(fold(user(T0, { entrypoint: 'sdk-ts' })).facts.entrypoint, 'sdk-ts');
  const { facts } = fold(
    user(T0, { entrypoint: 'sdk-ts' }),
    assistant(T0 + SEC, { entrypoint: 'cli' }),
  );
  assert.equal(facts.entrypoint, 'sdk-ts');
});

test('foldLines: the first cwd and entrypoint come from the first record that carries one', () => {
  const { facts } = fold(
    rec('ai-title', { aiTitle: 'T' }),
    rec('user', { cwd: 7, entrypoint: ['cli'] }),
    rec('user', { cwd: '', entrypoint: '' }),
    rec('user', { cwd: '/second', entrypoint: 'cli' }),
    rec('user', { cwd: '/third', entrypoint: 'sdk-ts' }),
  );
  assert.equal(facts.firstCwd, '/second');
  assert.equal(facts.entrypoint, 'cli');
});

test('foldLines takes cwd and entrypoint from a record of any type', () => {
  const { facts } = fold(rec('system', { cwd: '/from-system', entrypoint: 'cli' }));
  assert.equal(facts.firstCwd, '/from-system');
  assert.equal(facts.entrypoint, 'cli');
});

test('foldLines folds the recorded fixture, and keeps no message text', () => {
  const { facts, prUrls } = foldLines(EMPTY_FACTS, recordsFixture());
  assert.deepEqual(facts, {
    firstCwd: '/home/dev/projects/demo',
    entrypoint: 'cli',
    aiTitle: 'Demo title',
    customTitle: 'demo name',
    firstRecordNs: T0,
    lastRecordNs: T0 + 10n * SEC,
    lastUserNs: T0,
    lastTurnRole: 'assistant',
  });
  assert.deepEqual(prUrls, ['https://github.com/o/r/pull/7']);
  assert.ok(
    !JSON.stringify(facts, (_key, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    ).includes('<redacted>'),
  );
  assert.deepEqual(Object.keys(facts).sort(), Object.keys(ALL_NULL).sort());
});

test('the recorded fixture has one line of each record type and holds only placeholders for text', () => {
  const lines = recordsFixture();
  const types = lines.map((line) => (JSON.parse(line) as { type: string }).type);
  assert.deepEqual(types, ['user', 'assistant', 'ai-title', 'custom-title', 'pr-link', 'system']);
  for (const line of lines) {
    const record = JSON.parse(line) as { message?: { content: unknown }; content?: unknown };
    for (const text of [record.message?.content, record.content]) {
      assert.ok(text === undefined || text === '<redacted>');
    }
  }
});

const nonTurnFixture = (): string[] =>
  readFileSync(
    fileURLToPath(
      new URL('../fixtures/claude/transcripts/non-turn-user-records.jsonl', import.meta.url),
    ),
    'utf8',
  )
    .split('\n')
    .filter((line) => line !== '');

/** One per line of non-turn-user-records.jsonl, in order. */
const NON_TURN_KINDS = [
  'marked meta',
  'a compaction summary',
  'a sidechain record',
  'a slash command',
  'local command output (stdout)',
  'local command output (stderr)',
  'a local command caveat',
  'bash input',
  'bash output',
  'an interrupt marker with an interruptedMessageId',
  'an interrupt marker without one (string content)',
  'a slash command in a text block',
  'a slash command that opens with its message',
  'bash error output',
] as const;

test('the non-turn fixture has one user line for each kind, with invented content only', () => {
  const lines = nonTurnFixture();
  assert.equal(lines.length, NON_TURN_KINDS.length);
  for (const line of lines) {
    assert.equal((JSON.parse(line) as { type: string }).type, 'user');
  }
});

NON_TURN_KINDS.forEach((kind, i) => {
  test(`foldLines: a user record that is ${kind} is not a turn`, () => {
    const line = nonTurnFixture()[i] ?? '';
    const at = nsFromIso((JSON.parse(line) as { timestamp: string }).timestamp);
    assert.ok(at !== null && at > T0 + 10n * SEC);
    // After an assistant turn: still the assistant's turn, and the last user time stays.
    const afterAssistant = foldMore(fold(user(T0), assistant(T0 + 5n * SEC)).facts, line);
    assert.equal(afterAssistant.lastTurnRole, 'assistant');
    assert.equal(afterAssistant.lastUserNs, T0);
    assert.equal(afterAssistant.lastRecordNs, at);
    // After a real prompt: still the prompt's turn, at the prompt's time.
    const afterUser = foldMore(fold(user(T0)).facts, line);
    assert.equal(afterUser.lastTurnRole, 'user');
    assert.equal(afterUser.lastUserNs, T0);
  });
});

test('foldLines: a user record that is not a turn still gives cwd, entrypoint and the record times', () => {
  const [line] = nonTurnFixture();
  const { facts } = fold(line ?? '');
  assert.equal(facts.firstCwd, '/home/dev/projects/demo');
  assert.equal(facts.entrypoint, 'cli');
  assert.equal(facts.firstRecordNs, facts.lastRecordNs);
  assert.notEqual(facts.firstRecordNs, null);
  assert.equal(facts.lastTurnRole, null);
  assert.equal(facts.lastUserNs, null);
});

const toolResult = {
  message: { role: 'user', content: [{ type: 'tool_result', content: '<redacted>' }] },
  toolUseResult: { stdout: '<redacted>' },
};

/** `user` records that are turns and the user's own input (no turnOrigin: the fallback rules). */
const PROMPTS: Record<string, unknown>[] = [
  { message: { role: 'user', content: '<redacted>' } },
  {
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', data: '<redacted>' } },
        { type: 'text', text: '<redacted>' },
      ],
    },
  },
  // A marker counts only at the start; flags count only when exactly true.
  { message: { role: 'user', content: 'a prompt that mentions <command-name> in passing' } },
  { message: { role: 'user', content: 'x' }, isMeta: false, isSidechain: false },
  { message: { role: 'user', content: 'x' }, isMeta: 'true', isCompactSummary: 1 },
  // A shape that is not known is a turn: the safe reading of an unknown record is "in progress".
  { message: null },
  { message: { role: 'user' } },
  { message: { role: 'user', content: [] } },
  { message: { role: 'user', content: [{ type: 'image' }] } },
  // Claude Code 2.1.323 marks the origin of every prompt typed by the user.
  { turnOrigin: 'human' },
  // Older versions: a prompt the user typed or queued names its source; only 'system' is not theirs.
  { promptSource: 'typed' },
  { promptSource: 'queued' },
  { promptSource: 'suggestion_accepted' },
];

test('foldLines: a prompt and an unknown shape are turns and user input', () => {
  for (const fields of PROMPTS) {
    const { facts } = fold(assistant(T0), user(T0 + SEC, fields));
    assert.equal(facts.lastTurnRole, 'user', JSON.stringify(fields));
    assert.equal(facts.lastUserNs, T0 + SEC, JSON.stringify(fields));
  }
});

/** Turns that are not the user's own input. */
const TURNS_NOT_INPUT: Record<string, unknown>[] = [
  toolResult,
  {
    message: { role: 'user', content: '<task-notification>invented</task-notification>' },
    turnOrigin: 'task_notification',
  },
  { turnOrigin: 'sdk' },
  { turnOrigin: 'peer' },
  { turnOrigin: 'scheduled' },
  { turnOrigin: 'an origin this version does not know' },
  // Without an origin (older versions): a record the system wrote is a turn, not the user's input.
  { promptSource: 'system' },
  // An origin is a turn whatever else the record says: the model answers it.
  { isMeta: true, turnOrigin: 'peer' },
  { isMeta: true, isSidechain: true, isCompactSummary: true, turnOrigin: 'scheduled' },
  { message: { role: 'user', content: '<command-name>/demo</command-name>' }, turnOrigin: 'peer' },
];

test('foldLines: a tool result, and a record whose turnOrigin is not human, are turns but not user input', () => {
  for (const fields of TURNS_NOT_INPUT) {
    const { facts } = fold(assistant(T0), user(T0 + SEC, fields));
    assert.equal(facts.lastTurnRole, 'user', JSON.stringify(fields));
    assert.equal(facts.lastUserNs, null, JSON.stringify(fields));
    // After a real prompt, the prompt stays the last user input.
    assert.equal(foldMore(fold(user(T0)).facts, user(T0 + SEC, fields)).lastUserNs, T0);
  }
});

test('foldLines: a tool result is recognised by its content block as well as by toolUseResult', () => {
  const byBlock = { message: toolResult.message };
  const byKey = { toolUseResult: { stdout: '<redacted>' } };
  for (const fields of [byBlock, byKey]) {
    const { facts } = fold(assistant(T0), user(T0 + SEC, fields));
    assert.equal(facts.lastTurnRole, 'user');
    assert.equal(facts.lastUserNs, null);
  }
});

test('foldLines: a background-task notification without a turnOrigin (promptSource system) is a turn, not user input', () => {
  const line = readFileSync(
    fileURLToPath(
      new URL('../fixtures/claude/transcripts/system-sourced-user-record.jsonl', import.meta.url),
    ),
    'utf8',
  ).trim();
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record.type, 'user');
  assert.equal('turnOrigin' in record, false);
  assert.equal(record.promptSource, 'system');
  const { facts } = fold(user(T0), assistant(T0 + 5n * SEC), line);
  assert.equal(facts.lastTurnRole, 'user');
  assert.equal(facts.lastUserNs, T0);
  // The record is the last one in the file, and still the typed prompt is the last user input:
  // a done session must not come back because a background task ended.
  assert.equal(facts.lastRecordNs, nsFromIso(String(record.timestamp)));
});

const originFixture = (): string[] =>
  readFileSync(
    fileURLToPath(
      new URL('../fixtures/claude/transcripts/turn-origin-user-records.jsonl', import.meta.url),
    ),
    'utf8',
  )
    .split('\n')
    .filter((line) => line !== '');

/** One per line of turn-origin-user-records.jsonl: what the model answers, and whether the user did it. */
const ORIGIN_KINDS = [
  ['a message from another agent (meta, peer)', false],
  ['a scheduled wakeup (meta, scheduled)', false],
  ['a command typed by the user, with its output (bash output, human)', true],
] as const;

test('the turn-origin fixture has one user line for each kind, with invented content only', () => {
  const lines = originFixture();
  assert.equal(lines.length, ORIGIN_KINDS.length);
  for (const line of lines) {
    assert.equal((JSON.parse(line) as { type: string }).type, 'user');
  }
});

ORIGIN_KINDS.forEach(([kind, isInput], i) => {
  test(`foldLines: ${kind} is a turn${isInput ? ' and user input' : ', not user input'}`, () => {
    const line = originFixture()[i] ?? '';
    const at = nsFromIso((JSON.parse(line) as { timestamp: string }).timestamp);
    const { facts } = fold(user(T0), assistant(T0 + 5n * SEC), line);
    assert.equal(facts.lastTurnRole, 'user');
    assert.equal(facts.lastUserNs, isInput ? at : T0);
    // The same record without its turnOrigin falls back to the exclusions: meta and command output are no turn.
    const stripped = JSON.stringify({ ...(JSON.parse(line) as object), turnOrigin: undefined });
    const without = fold(user(T0), assistant(T0 + 5n * SEC), stripped).facts;
    assert.equal(without.lastTurnRole, 'assistant');
    assert.equal(without.lastUserNs, T0);
  });
});

test('foldLines keeps a hostile title raw (sanitising is the list model’s job)', () => {
  const hostile = '\x1b]0;pwn\x07Title';
  assert.equal(fold(rec('ai-title', { aiTitle: hostile })).facts.aiTitle, hostile);
});

test('foldLines neither changes its input nor EMPTY_FACTS', () => {
  const before = fold(user(T0)).facts;
  const snapshot = { ...before };
  foldLines(before, [assistant(T0 + SEC), rec('ai-title', { aiTitle: 'T' })]);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(EMPTY_FACTS, ALL_NULL);
  assert.ok(Object.isFrozen(EMPTY_FACTS));
});

test('foldLines with no lines returns the same facts and no urls', () => {
  assert.deepEqual(foldLines(EMPTY_FACTS, []), { facts: ALL_NULL, prUrls: [] });
});

test('foldLines treats a line that is an object with a numeric type or no type as a record of no kind', () => {
  const { facts } = fold(JSON.stringify({ type: 5, timestamp: stamp(T0) }), '{}');
  assert.deepEqual(facts, { ...ALL_NULL, firstRecordNs: T0, lastRecordNs: T0 });
});

// --- readTranscript ------------------------------------------------------------------------------

function transcriptAt(
  t: TestContext,
  name = S1,
): { file: () => TranscriptFile; path: string; files: Files } {
  const { platform, places } = testPlatform(t);
  const dir = join(places.claudeHome, 'projects', 'p');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  return {
    path,
    files: platform.files,
    file: () => ({ path, sessionId: name, size: statSync(path).size, mtimeNs: 0n }),
  };
}

const text = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('');

test('readTranscript without a previous read folds the whole file', (t) => {
  const { path, file, files } = transcriptAt(t);
  const content = text(user(T0), assistant(T0 + 5n * SEC), rec('ai-title', { aiTitle: 'T' }));
  writeFileSync(path, content);
  const read = readTranscript(files, file(), null);
  assert.equal(read.sizeRead, Buffer.byteLength(content));
  assert.deepEqual(read.facts, foldLines(EMPTY_FACTS, content.split('\n').slice(0, 3)).facts);
  assert.equal(read.facts.aiTitle, 'T');
  assert.equal(read.facts.lastTurnRole, 'assistant');
  assert.deepEqual(read.prUrls, []);
});

test('readTranscript leaves a half-written last line for the next read', (t) => {
  const { path, file, files } = transcriptAt(t);
  const complete = text(user(T0), assistant(T0 + SEC));
  const partial = '{"type":"user","timest';
  writeFileSync(path, complete + partial);
  const first = readTranscript(files, file(), null);
  assert.equal(first.sizeRead, Buffer.byteLength(complete));
  assert.deepEqual(first.facts, foldLines(EMPTY_FACTS, [user(T0), assistant(T0 + SEC)]).facts);

  appendFileSync(path, `amp":"${stamp(T0 + 9n * SEC)}","cwd":"/late"}\n`);
  const second = readTranscript(files, file(), first);
  assert.equal(second.sizeRead, file().size);
  assert.equal(second.facts.lastRecordNs, T0 + 9n * SEC);
  assert.equal(second.facts.lastTurnRole, 'user');
  assert.equal(second.facts.firstCwd, '/w');
});

test('readTranscript with only a partial line reads nothing and keeps the previous facts', (t) => {
  const { path, file, files } = transcriptAt(t);
  writeFileSync(path, '{"type":"us');
  const read = readTranscript(files, file(), null);
  assert.deepEqual(read, { facts: ALL_NULL, sizeRead: 0, prUrls: [] });
  const previous = { facts: fold(user(T0)).facts, sizeRead: 0 };
  writeFileSync(path, 'x'.repeat(50));
  assert.deepEqual(readTranscript(files, file(), previous), {
    facts: previous.facts,
    sizeRead: 0,
    prUrls: [],
  });
});

test('readTranscript with a previous read reads only the bytes after it', (t) => {
  const { path, file, files } = transcriptAt(t);
  const head = text(user(T0), prLink('https://github.com/o/r/pull/7', T0 + SEC));
  writeFileSync(path, head);
  const first = readTranscript(files, file(), null);
  assert.deepEqual(first.prUrls, ['https://github.com/o/r/pull/7']);

  appendFileSync(
    path,
    text(assistant(T0 + 3n * SEC), prLink('https://github.com/o/r/pull/8', T0 + 4n * SEC)),
  );
  const ranges: [number, number][] = [];
  const watched = new Proxy(files, {
    get(target, prop, receiver) {
      if (prop !== 'readBytes') return Reflect.get(target, prop, receiver) as unknown;
      return (p: string, start: number, end: number) => {
        ranges.push([start, end]);
        return target.readBytes(p, start, end);
      };
    },
  });
  const second = readTranscript(watched, file(), first);
  assert.deepEqual(second.prUrls, ['https://github.com/o/r/pull/8']);
  assert.equal(second.sizeRead, file().size);
  assert.equal(second.facts.lastTurnRole, 'assistant');
  assert.equal(second.facts.lastRecordNs, T0 + 4n * SEC);
  assert.equal(second.facts.firstRecordNs, T0);
  // One byte before the offset is looked at (is it a newline?); everything else starts at the offset.
  const at = Buffer.byteLength(head);
  assert.deepEqual(ranges[0], [at - 1, at]);
  assert.equal(ranges[1]?.[0], at);
  assert.ok(ranges.every(([start, end]) => start >= at - 1 && end <= file().size));
});

test('readTranscript reads again from the start when the file was replaced by a larger one', (t) => {
  const { path, file, files } = transcriptAt(t);
  writeFileSync(path, text(rec('ai-title', { aiTitle: 'Old' }), user(T0)));
  const first = readTranscript(files, file(), null);
  assert.equal(first.facts.aiTitle, 'Old');

  const replacement = text(
    rec('ai-title', { aiTitle: 'New' }),
    user(T0 + SEC, { cwd: '/new' }),
    prLink('https://github.com/o/r/pull/9', T0 + 2n * SEC),
    assistant(T0 + 3n * SEC),
  );
  // The byte before the stored offset is not a newline in the replacement.
  assert.notEqual(replacement[first.sizeRead - 1], '\n');
  assert.ok(replacement.length > first.sizeRead);
  writeFileSync(path, replacement);

  const second = readTranscript(files, file(), first);
  assert.equal(second.facts.aiTitle, 'New');
  assert.equal(second.facts.firstCwd, '/new');
  assert.equal(second.facts.firstRecordNs, T0 + SEC);
  assert.equal(second.facts.lastTurnRole, 'assistant');
  assert.equal(second.sizeRead, Buffer.byteLength(replacement));
  assert.deepEqual(second.prUrls, ['https://github.com/o/r/pull/9']);
});

test('readTranscript does not read when nothing was added', (t) => {
  const { path, file, files } = transcriptAt(t);
  writeFileSync(path, text(user(T0)));
  const first = readTranscript(files, file(), null);
  const reads: unknown[] = [];
  const watched = new Proxy(files, {
    get(target, prop, receiver) {
      if (prop === 'readBytes') {
        return (...args: unknown[]) => {
          reads.push(args);
          throw new Error('must not read');
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const again = readTranscript(watched, file(), first);
  assert.deepEqual(again, { facts: first.facts, sizeRead: first.sizeRead, prUrls: [] });
  assert.deepEqual(reads, []);
});

test('readTranscript on a file that shrank reads it again from the start', (t) => {
  const { path, file, files } = transcriptAt(t);
  const content = text(
    rec('ai-title', { aiTitle: 'New' }),
    prLink('https://github.com/o/r/pull/7', T0),
  );
  writeFileSync(path, content);
  assert.ok(file().size < 300);
  const old = fold(rec('ai-title', { aiTitle: 'Old' }), user(T0 - 100n * SEC)).facts;
  const read = readTranscript(files, file(), { facts: old, sizeRead: 10_000 });
  assert.equal(read.facts.aiTitle, 'New');
  assert.equal(read.facts.firstRecordNs, T0);
  assert.equal(read.facts.lastTurnRole, null);
  assert.equal(read.sizeRead, Buffer.byteLength(content));
  assert.deepEqual(read.prUrls, ['https://github.com/o/r/pull/7']);
});

test('readTranscript on a file emptied since the last read gives empty facts and sizeRead 0', (t) => {
  const { path, file, files } = transcriptAt(t);
  writeFileSync(path, '');
  const old = fold(user(T0)).facts;
  assert.deepEqual(readTranscript(files, file(), { facts: old, sizeRead: 500 }), {
    facts: ALL_NULL,
    sizeRead: 0,
    prUrls: [],
  });
});

test('readTranscript decodes multi-byte characters exactly', (t) => {
  const { path, file, files } = transcriptAt(t);
  const title = 'Opravit čeština ✳ 日本語 😀';
  writeFileSync(path, text(rec('ai-title', { aiTitle: title })));
  assert.equal(readTranscript(files, file(), null).facts.aiTitle, title);
});

test('readTranscript counts sizeRead in bytes, not characters', (t) => {
  const { path, file, files } = transcriptAt(t);
  const content = text(rec('ai-title', { aiTitle: 'čeština ✳' })) + '{"partial":"✳';
  writeFileSync(path, content);
  const read = readTranscript(files, file(), null);
  assert.equal(read.sizeRead, Buffer.byteLength(text(rec('ai-title', { aiTitle: 'čeština ✳' }))));
});

test('readTranscript reads no further than the size it was given', (t) => {
  const { path, files } = transcriptAt(t);
  const l1 = text(user(T0));
  const l2 = text(assistant(T0 + SEC));
  writeFileSync(path, l1 + l2);
  const stale = (size: number): TranscriptFile => ({ path, sessionId: S1, size, mtimeNs: 0n });
  const atBoundary = readTranscript(files, stale(Buffer.byteLength(l1)), null);
  assert.equal(atBoundary.sizeRead, Buffer.byteLength(l1));
  assert.equal(atBoundary.facts.lastTurnRole, 'user');
  const midLine = readTranscript(files, stale(Buffer.byteLength(l1) + 10), null);
  assert.equal(midLine.sizeRead, Buffer.byteLength(l1));
  assert.equal(midLine.facts.lastTurnRole, 'user');
});

test('readTranscript counts what it really got when the file is shorter than its size says', (t) => {
  const { path, files } = transcriptAt(t);
  const content = text(user(T0), assistant(T0 + SEC));
  writeFileSync(path, content);
  const read = readTranscript(files, { path, sessionId: S1, size: 10_000, mtimeNs: 0n }, null);
  assert.equal(read.sizeRead, Buffer.byteLength(content));
  assert.equal(read.facts.lastTurnRole, 'assistant');
});

test('readTranscript throws when the file cannot be read', (t) => {
  const { path, files } = transcriptAt(t);
  assert.throws(() => readTranscript(files, { path, sessionId: S1, size: 10, mtimeNs: 0n }, null));
});

test('readTranscript reads a file larger than one read, with a line longer than one read', (t) => {
  const { path, file, files } = transcriptAt(t);
  const parts: string[] = [];
  const urls: string[] = [];
  let size = 0;
  const add = (line: string): void => {
    parts.push(line);
    size += Buffer.byteLength(line) + 1;
  };
  const addLink = (): void => {
    const url = `https://github.com/o/r/pull/${urls.length + 1}`;
    urls.push(url);
    add(prLink(url, T0 + BigInt(urls.length) * SEC));
  };
  add(rec('ai-title', { aiTitle: 'Opravit čeština ✳' }));
  add(user(T0, { cwd: '/first' }));
  // Enough small lines to cross several reads, then one line larger than any read, then more.
  while (size < 20_000_000) addLink();
  add(user(T0 + 5n * SEC, { toolUseResult: { content: 'é'.repeat(9_000_000) } }));
  for (let i = 0; i < 1000; i++) addLink();
  add(assistant(T0 + 9_999_999n * SEC));
  const content = text(...parts);
  writeFileSync(path, content);

  const read = readTranscript(files, file(), null);
  assert.equal(read.sizeRead, Buffer.byteLength(content));
  assert.deepEqual(read.prUrls, urls);
  assert.deepEqual(read.facts, foldLines(EMPTY_FACTS, parts).facts);
  assert.equal(read.facts.aiTitle, 'Opravit čeština ✳');
  assert.equal(read.facts.firstCwd, '/first');
  assert.equal(read.facts.lastTurnRole, 'assistant');
});
