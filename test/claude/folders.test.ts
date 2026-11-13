import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { lookAtClaudeFolders } from '../../src/claude/folders.ts';
import type { Files } from '../../src/platform/types.ts';
import { S1, S2, testPlatform } from '../helpers/platform.ts';

/** The real files of a sandbox, and the Claude home in it. */
function claudeHome(t: TestContext): { files: Files; home: string } {
  const { platform, sandbox } = testPlatform(t);
  return { files: platform.files, home: sandbox.claudeHome };
}

/** `files` with `method` throwing an error of `code` for `path`. */
function failing(
  files: Files,
  method: 'list' | 'stat' | 'lstat',
  path: string,
  code: string,
): Files {
  return {
    ...files,
    [method]: (p: string) => {
      if (p === path) {
        throw Object.assign(new Error(`${code}: on purpose`), { code });
      }
      return (files[method] as (p: string) => unknown)(p);
    },
  } as Files;
}

test('neither folder exists yet: both missing, nothing unreadable', (t) => {
  const { files, home } = claudeHome(t);
  assert.deepEqual(lookAtClaudeFolders(files, home), {
    sessions: { path: join(home, 'sessions'), missing: true, unreadable: [] },
    projects: { path: join(home, 'projects'), missing: true, unreadable: [], transcripts: 0 },
  });
});

test('both readable: the transcripts under projects are counted', (t) => {
  const { files, home } = claudeHome(t);
  mkdirSync(join(home, 'sessions'));
  mkdirSync(join(home, 'projects', 'demo'), { recursive: true });
  writeFileSync(join(home, 'projects', 'demo', `${S1}.jsonl`), '');
  writeFileSync(join(home, 'projects', 'demo', `${S2}.jsonl`), '');
  writeFileSync(join(home, 'projects', 'demo', 'notes.txt'), '');

  assert.deepEqual(lookAtClaudeFolders(files, home), {
    sessions: { path: join(home, 'sessions'), missing: false, unreadable: [] },
    projects: { path: join(home, 'projects'), missing: false, unreadable: [], transcripts: 2 },
  });
});

test('a sessions folder that cannot be listed is unreadable, with the reason', (t) => {
  const { files, home } = claudeHome(t);
  const sessions = join(home, 'sessions');
  mkdirSync(sessions);
  const look = lookAtClaudeFolders(failing(files, 'list', sessions, 'EACCES'), home);
  assert.deepEqual(look.sessions, {
    path: sessions,
    missing: false,
    unreadable: [{ path: sessions, reason: 'EACCES' }],
  });
});

test('a sessions folder that cannot be looked at is unreadable, not missing', (t) => {
  const { files, home } = claudeHome(t);
  const sessions = join(home, 'sessions');
  const look = lookAtClaudeFolders(failing(files, 'lstat', sessions, 'EACCES'), home);
  assert.deepEqual(look.sessions, {
    path: sessions,
    missing: false,
    unreadable: [{ path: sessions, reason: 'EACCES' }],
  });
});

test('a sessions "folder" that is a file is unreadable: ENOTDIR', (t) => {
  const { files, home } = claudeHome(t);
  const sessions = join(home, 'sessions');
  writeFileSync(sessions, '');
  assert.deepEqual(lookAtClaudeFolders(files, home).sessions.unreadable, [
    { path: sessions, reason: 'ENOTDIR' },
  ]);
});

test('a projects "folder" that is a file is unreadable: ENOTDIR', (t) => {
  const { files, home } = claudeHome(t);
  const projects = join(home, 'projects');
  writeFileSync(projects, '');
  assert.deepEqual(lookAtClaudeFolders(files, home).projects, {
    path: projects,
    missing: false,
    unreadable: [{ path: projects, reason: 'ENOTDIR' }],
    transcripts: 0,
  });
});

test('a dangling symbolic link (a moved folder on a disk that is not there) is unreadable, not missing', (t) => {
  const { files, home } = claudeHome(t);
  const sessions = join(home, 'sessions');
  const projects = join(home, 'projects');
  symlinkSync('/mnt/not-mounted/claude-sessions', sessions);
  symlinkSync('/mnt/not-mounted/claude-projects', projects);

  const look = lookAtClaudeFolders(files, home);

  assert.deepEqual(look.sessions, {
    path: sessions,
    missing: false,
    unreadable: [{ path: sessions, reason: 'ENOENT' }],
  });
  assert.deepEqual(look.projects, {
    path: projects,
    missing: false,
    unreadable: [{ path: projects, reason: 'ENOENT' }],
    transcripts: 0,
  });
});

test('a symbolic link to a folder is followed', (t) => {
  const { files, home } = claudeHome(t);
  const elsewhere = join(home, '..', 'moved-projects');
  mkdirSync(join(elsewhere, 'demo'), { recursive: true });
  writeFileSync(join(elsewhere, 'demo', `${S1}.jsonl`), '');
  symlinkSync(elsewhere, join(home, 'projects'));

  const { projects } = lookAtClaudeFolders(files, home);

  assert.deepEqual(projects.unreadable, []);
  assert.equal(projects.transcripts, 1);
});

test('a loop under projects is named; the rest is still counted', (t) => {
  const { files, home } = claudeHome(t);
  mkdirSync(join(home, 'projects', 'demo'), { recursive: true });
  writeFileSync(join(home, 'projects', 'demo', `${S1}.jsonl`), '');
  const loop = join(home, 'projects', 'loop');
  symlinkSync(loop, loop);

  const { projects } = lookAtClaudeFolders(files, home);

  assert.deepEqual(projects.unreadable, [{ path: loop, reason: 'ELOOP' }]);
  assert.equal(projects.transcripts, 1);
  assert.equal(projects.missing, false);
});

test('a projects folder that cannot be listed is unreadable', (t) => {
  const { files, home } = claudeHome(t);
  const projects = join(home, 'projects');
  mkdirSync(projects);
  assert.deepEqual(
    lookAtClaudeFolders(failing(files, 'list', projects, 'EACCES'), home).projects.unreadable,
    [{ path: projects, reason: 'EACCES' }],
  );
});
