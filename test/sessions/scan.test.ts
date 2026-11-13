import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { isoFromNs } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { scanTranscripts } from '../../src/sessions/scan.ts';
import type { TranscriptRow } from '../../src/store/types.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';

// --- transcript lines (no conversation text, principle 4) ----------------------------------------

const record = (sessionId: string, type: string, fields: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ type, sessionId, ...fields })}\n`;
const user = (sessionId: string, ns: Ns, fields: Record<string, unknown> = {}): string =>
  record(sessionId, 'user', {
    timestamp: isoFromNs(ns),
    cwd: '/home/dev/projects/demo',
    entrypoint: 'cli',
    message: { role: 'user', content: '<redacted>' },
    ...fields,
  });
const assistant = (sessionId: string, ns: Ns): string =>
  record(sessionId, 'assistant', {
    timestamp: isoFromNs(ns),
    cwd: '/home/dev/projects/demo',
    entrypoint: 'cli',
    message: { role: 'assistant', content: '<redacted>' },
  });
const prLink = (sessionId: string, url: string): string =>
  record(sessionId, 'pr-link', { prUrl: url, timestamp: isoFromNs(T0) });

// --- the deck's Claude home ----------------------------------------------------------------------

const folder = (d: TestDeck, name = 'demo'): string => {
  const path = join(d.deck.places.claudeHome, 'projects', name);
  mkdirSync(path, { recursive: true });
  return path;
};
const transcript = (d: TestDeck, sessionId: string, text: string, name = 'demo'): string => {
  const path = join(folder(d, name), `${sessionId}.jsonl`);
  writeFileSync(path, text);
  return path;
};
const rowOf = (d: TestDeck, path: string): TranscriptRow | undefined =>
  d.deck.store.transcripts().find((r) => r.path === path);
const problems = (d: TestDeck): string[] | null => {
  const value = d.deck.store.getKv('scan_problems');
  return value === null ? null : (JSON.parse(value) as string[]);
};

/** Throws an error with `code` when called for `failingPath`, else calls `real`. */
function failing<A extends unknown[], R>(
  failingPath: string,
  code: string,
  real: (path: string, ...rest: A) => R,
): (path: string, ...rest: A) => R {
  return (path, ...rest) => {
    if (path === failingPath) throw Object.assign(new Error(`${code}: ${path}`), { code });
    return real(path, ...rest);
  };
}

/** Two transcripts in `demo`: S1 (user, assistant) and S2 (user). */
function two(d: TestDeck): { p1: string; p2: string } {
  return {
    p1: transcript(d, S1, user(S1, T0) + assistant(S1, T0 + 5n * SEC)),
    p2: transcript(d, S2, user(S2, T0 + 10n * SEC)),
  };
}

test('every transcript is read, its facts are saved, progress is reported, first_scan_done is set', (t) => {
  const d = testDeck(t);
  const { p1, p2 } = two(d);
  const calls: [number, number][] = [];
  assert.deepEqual(
    scanTranscripts(d.deck, (done, total) => calls.push([done, total])),
    { read: 2, skipped: 0, missing: 0, prsAttached: 0 },
  );
  assert.deepEqual(calls, [
    [1, 2],
    [2, 2],
  ]);
  const size1 = statSync(p1).size;
  assert.deepEqual(rowOf(d, p1), {
    path: p1,
    sessionId: S1,
    sizeRead: size1,
    fileSize: size1,
    mtimeNs: statSync(p1, { bigint: true }).mtimeNs,
    firstCwd: '/home/dev/projects/demo',
    entrypoint: 'cli',
    aiTitle: null,
    customTitle: null,
    firstRecordNs: T0,
    lastRecordNs: T0 + 5n * SEC,
    lastUserNs: T0,
    lastTurnRole: 'assistant',
    missingSinceNs: null,
  });
  assert.equal(rowOf(d, p2)?.lastTurnRole, 'user');
  assert.equal(d.deck.store.getKv('first_scan_done'), '1');
  assert.equal(problems(d), null);
});

test('an unchanged transcript is skipped and not opened', (t) => {
  const d = testDeck(t);
  two(d);
  scanTranscripts(d.deck);
  const calls: [number, number][] = [];
  const deck = deckWith(d.deck, {
    files: {
      readBytes: () => {
        throw new Error('opened');
      },
    },
  });
  assert.deepEqual(
    scanTranscripts(deck, (done, total) => calls.push([done, total])),
    { read: 0, skipped: 2, missing: 0, prsAttached: 0 },
  );
  assert.deepEqual(calls, []);
});

test('an appended complete line is read from the stored offset', (t) => {
  const d = testDeck(t);
  const { p1 } = two(d);
  scanTranscripts(d.deck);
  const before = rowOf(d, p1)?.sizeRead ?? 0;
  appendFileSync(p1, user(S1, T0 + 30n * SEC));
  assert.deepEqual(scanTranscripts(d.deck), { read: 1, skipped: 1, missing: 0, prsAttached: 0 });
  const row = rowOf(d, p1);
  assert.equal(row?.sizeRead, statSync(p1).size);
  assert.ok((row?.sizeRead ?? 0) > before);
  assert.equal(row?.lastRecordNs, T0 + 30n * SEC);
  assert.equal(row?.firstRecordNs, T0);
  assert.equal(row?.lastTurnRole, 'user');
});

test('a last line without its newline is left until the newline arrives', (t) => {
  const d = testDeck(t);
  const { p1 } = two(d);
  scanTranscripts(d.deck);
  const before = rowOf(d, p1)?.sizeRead;
  const line = user(S1, T0 + 30n * SEC);
  appendFileSync(p1, line.slice(0, -1));
  scanTranscripts(d.deck);
  assert.equal(rowOf(d, p1)?.sizeRead, before);
  assert.equal(rowOf(d, p1)?.lastRecordNs, T0 + 5n * SEC);
  appendFileSync(p1, '\n');
  scanTranscripts(d.deck);
  assert.equal(rowOf(d, p1)?.sizeRead, statSync(p1).size);
  assert.equal(rowOf(d, p1)?.lastRecordNs, T0 + 30n * SEC);
});

test('a transcript rewritten shorter is read again from the start', (t) => {
  const d = testDeck(t);
  const { p1 } = two(d);
  scanTranscripts(d.deck);
  writeFileSync(p1, user(S1, T0 + 60n * SEC, { cwd: '/elsewhere' }));
  assert.equal(scanTranscripts(d.deck).read, 1);
  const row = rowOf(d, p1);
  assert.equal(row?.firstRecordNs, T0 + 60n * SEC);
  assert.equal(row?.lastRecordNs, T0 + 60n * SEC);
  assert.equal(row?.firstCwd, '/elsewhere');
  assert.equal(row?.lastTurnRole, 'user');
});

test('a deleted transcript is marked missing once, and unmarked when it comes back', (t) => {
  const d = testDeck(t);
  const { p2 } = two(d);
  scanTranscripts(d.deck);
  const content = user(S2, T0 + 10n * SEC);
  unlinkSync(p2);
  d.clock.setNs(T0 + 60n * SEC);
  assert.deepEqual(scanTranscripts(d.deck), { read: 0, skipped: 1, missing: 1, prsAttached: 0 });
  assert.equal(rowOf(d, p2)?.missingSinceNs, T0 + 60n * SEC);

  d.clock.setNs(T0 + 120n * SEC);
  assert.equal(scanTranscripts(d.deck).missing, 0);
  assert.equal(rowOf(d, p2)?.missingSinceNs, T0 + 60n * SEC);

  writeFileSync(p2, content);
  assert.equal(scanTranscripts(d.deck).read, 1);
  assert.equal(rowOf(d, p2)?.missingSinceNs, null);
  assert.equal(rowOf(d, p2)?.lastRecordNs, T0 + 10n * SEC);
});

test('nothing at or under a folder that cannot be read is marked missing', async (t) => {
  await t.test('an unreadable project folder', (t) => {
    const d = testDeck(t);
    const { p1 } = two(d); // in demo
    const p3 = transcript(d, S3, user(S3, T0), 'other');
    const gone = transcript(d, S1, user(S1, T0), 'demo-b');
    scanTranscripts(d.deck);
    unlinkSync(gone);
    appendFileSync(p3, assistant(S3, T0 + SEC));
    const demo = join(d.deck.places.claudeHome, 'projects', 'demo');
    const deck = deckWith(d.deck, {
      files: { list: failing(demo, 'EACCES', d.deck.platform.files.list) },
    });

    // demo-b starts with the name of demo but is not under it: its deleted transcript IS missing
    assert.deepEqual(scanTranscripts(deck), { read: 1, skipped: 0, missing: 1, prsAttached: 0 });
    assert.equal(rowOf(d, p1)?.missingSinceNs, null);
    assert.equal(rowOf(d, gone)?.missingSinceNs, T0);
    assert.equal(rowOf(d, p3)?.lastRecordNs, T0 + SEC);
    assert.deepEqual(problems(d), [`cannot read ${demo} (EACCES)`]);
  });

  await t.test('a transcript file that cannot be looked at itself', (t) => {
    const d = testDeck(t);
    const { p1, p2 } = two(d);
    scanTranscripts(d.deck);
    unlinkSync(p2);
    const deck = deckWith(d.deck, {
      files: { lstat: failing(p1, 'EACCES', d.deck.platform.files.lstat) },
    });

    // p1 is not under an unreadable folder: its own path is the unreadable one. p2 really is gone.
    assert.deepEqual(scanTranscripts(deck), { read: 0, skipped: 0, missing: 1, prsAttached: 0 });
    assert.equal(rowOf(d, p1)?.missingSinceNs, null);
    assert.equal(rowOf(d, p2)?.missingSinceNs, T0);
    assert.deepEqual(problems(d), [`cannot read ${p1} (EACCES)`]);
  });

  await t.test('an unreadable projects directory', (t) => {
    const d = testDeck(t);
    const { p1, p2 } = two(d);
    scanTranscripts(d.deck);
    const projects = join(d.deck.places.claudeHome, 'projects');
    const deck = deckWith(d.deck, {
      files: {
        list: failing(projects, 'EACCES', d.deck.platform.files.list),
      },
    });
    assert.deepEqual(scanTranscripts(deck), { read: 0, skipped: 0, missing: 0, prsAttached: 0 });
    assert.equal(rowOf(d, p1)?.missingSinceNs, null);
    assert.equal(rowOf(d, p2)?.missingSinceNs, null);
  });
});

test('a transcript that disappears between listing and reading is marked missing', (t) => {
  const d = testDeck(t);
  const { p1, p2 } = two(d);
  scanTranscripts(d.deck);
  appendFileSync(p1, user(S1, T0 + 30n * SEC));
  appendFileSync(p2, user(S2, T0 + 30n * SEC));
  const files = d.deck.platform.files;
  const deck = deckWith(d.deck, {
    files: {
      readBytes: (path, from, to) => {
        if (path === p2) unlinkSync(path);
        return files.readBytes(path, from, to);
      },
    },
  });
  const calls: [number, number][] = [];
  assert.deepEqual(
    scanTranscripts(deck, (done, total) => calls.push([done, total])),
    { read: 1, skipped: 0, missing: 1, prsAttached: 0 },
  );
  assert.equal(rowOf(d, p2)?.missingSinceNs, T0);
  assert.equal(rowOf(d, p1)?.lastRecordNs, T0 + 30n * SEC);
  assert.deepEqual(calls, [
    [1, 2],
    [2, 2],
  ]);
  assert.equal(problems(d), null);
});

test('a transcript that cannot be read is recorded, kept as it was and not marked missing', (t) => {
  const d = testDeck(t);
  const { p1, p2 } = two(d);
  scanTranscripts(d.deck);
  const saved = rowOf(d, p2);
  appendFileSync(p1, user(S1, T0 + 30n * SEC));
  appendFileSync(p2, user(S2, T0 + 30n * SEC));
  const deck = deckWith(d.deck, {
    files: {
      readBytes: failing(p2, 'EACCES', d.deck.platform.files.readBytes),
    },
  });
  assert.deepEqual(scanTranscripts(deck), { read: 1, skipped: 0, missing: 0, prsAttached: 0 });
  assert.deepEqual(rowOf(d, p2), saved);
  assert.deepEqual(problems(d), [`cannot read ${p2} (EACCES)`]);

  // once it can be read again, it is read and the record is cleared
  assert.equal(scanTranscripts(d.deck).read, 1);
  assert.equal(rowOf(d, p2)?.lastRecordNs, T0 + 30n * SEC);
  assert.equal(problems(d), null);
});

test('a transcript with a time the database cannot hold is recorded and skipped; the others are read', (t) => {
  const d = testDeck(t);
  const p1 = transcript(d, S1, user(S1, T0, { timestamp: '9999-12-31T23:59:59Z' }));
  const p2 = transcript(d, S2, user(S2, T0));
  assert.deepEqual(scanTranscripts(d.deck), { read: 1, skipped: 0, missing: 0, prsAttached: 0 });
  assert.equal(rowOf(d, p1), undefined);
  assert.equal(rowOf(d, p2)?.lastRecordNs, T0);
  assert.deepEqual(problems(d), [`cannot record ${p1}: a time is out of range`]);
});

test('pull requests named in pr-link records are attached automatically, once each', (t) => {
  const d = testDeck(t);
  transcript(
    d,
    S1,
    user(S1, T0) +
      prLink(S1, 'https://github.com/O/R/pull/7/files') +
      prLink(S1, 'https://github.com/o/r/pull/8') +
      prLink(S1, 'https://github.com/o/r/pull/7') +
      prLink(S1, 'https://example.com/x'),
  );
  assert.equal(scanTranscripts(d.deck).prsAttached, 2);
  assert.deepEqual(
    d.deck.store.prs().map((p) => p.url),
    ['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/8'],
  );
  assert.deepEqual(
    d.deck.store
      .sessionPrs()
      .map((r) => [r.sessionId, r.url, r.origin, r.firstSeenNs, r.detachedAtNs])
      .sort(),
    [
      [S1, 'https://github.com/o/r/pull/7', 'auto', T0, null],
      [S1, 'https://github.com/o/r/pull/8', 'auto', T0, null],
    ],
  );
});

test('a detached pull request is not attached again by a re-read', (t) => {
  const d = testDeck(t);
  const url = 'https://github.com/o/r/pull/7';
  const path = transcript(d, S1, user(S1, T0) + assistant(S1, T0 + SEC) + prLink(S1, url));
  scanTranscripts(d.deck);
  assert.equal(d.deck.store.detachPr(S1, url, T0 + SEC), true);
  writeFileSync(path, user(S1, T0) + prLink(S1, url)); // shorter: a full re-read
  assert.deepEqual(scanTranscripts(d.deck), { read: 1, skipped: 0, missing: 0, prsAttached: 0 });
  assert.equal(d.deck.store.sessionPrs()[0]?.detachedAtNs, T0 + SEC);
});

test('a transcript of another entry point is recorded with it', (t) => {
  const d = testDeck(t);
  const path = transcript(d, S1, user(S1, T0, { entrypoint: 'sdk-ts' }));
  scanTranscripts(d.deck);
  assert.equal(rowOf(d, path)?.entrypoint, 'sdk-ts');
});

test('a projects directory that is gone (not unreadable) marks its transcripts missing', (t) => {
  const d = testDeck(t);
  const { p1 } = two(d);
  scanTranscripts(d.deck);
  rmSync(join(d.deck.places.claudeHome, 'projects'), { recursive: true });
  // projects is gone (not unreadable): its transcripts are gone too
  assert.equal(scanTranscripts(d.deck).missing, 2);
  assert.equal(rowOf(d, p1)?.missingSinceNs, T0);
});

test('a transcript whose modification time the database cannot hold is recorded and skipped', (t) => {
  const d = testDeck(t);
  const { p1, p2 } = two(d);
  const files = d.deck.platform.files;
  const deck = deckWith(d.deck, {
    files: {
      lstat: (path) => {
        const info = files.lstat(path);
        return path === p1 && info !== null ? { ...info, mtimeNs: 2n ** 64n } : info;
      },
    },
  });
  assert.deepEqual(scanTranscripts(deck), { read: 1, skipped: 0, missing: 0, prsAttached: 0 });
  assert.equal(rowOf(d, p1), undefined);
  assert.equal(rowOf(d, p2)?.lastRecordNs, T0 + 10n * SEC);
  assert.deepEqual(problems(d), [`cannot record ${p1}: a time is out of range`]);
});

test('a transcript whose row cannot be saved is recorded and skipped; the others are read', (t) => {
  const d = testDeck(t);
  const { p1, p2 } = two(d);
  const calls: [number, number][] = [];
  const deck = deckWith(d.deck, {
    store: {
      saveTranscript: (row) => {
        if (row.path === p1) throw new RangeError('cannot bind');
        d.deck.store.saveTranscript(row);
      },
    },
  });
  assert.deepEqual(
    scanTranscripts(deck, (done, total) => calls.push([done, total])),
    { read: 1, skipped: 0, missing: 0, prsAttached: 0 },
  );
  assert.equal(rowOf(d, p1), undefined);
  assert.equal(rowOf(d, p2)?.lastRecordNs, T0 + 10n * SEC);
  assert.deepEqual(problems(d), [`cannot record ${p1} (RangeError: cannot bind)`]);
  assert.deepEqual(calls, [
    [1, 2],
    [2, 2],
  ]);
});

test('a transcript row and its pull requests are saved together or not at all', (t) => {
  const d = testDeck(t);
  const url = 'https://github.com/o/r/pull/7';
  const p1 = transcript(d, S1, user(S1, T0) + prLink(S1, url));
  const p2 = transcript(d, S2, user(S2, T0) + prLink(S2, url));
  const deck = deckWith(d.deck, {
    store: {
      attachPr: (sessionId, prUrl, origin, nowNs) => {
        if (sessionId === S1) throw new Error('cannot attach');
        d.deck.store.attachPr(sessionId, prUrl, origin, nowNs);
      },
    },
  });
  assert.deepEqual(scanTranscripts(deck), { read: 1, skipped: 0, missing: 0, prsAttached: 1 });
  assert.equal(rowOf(d, p1), undefined, 'the row of S1 was rolled back with its attachment');
  assert.notEqual(rowOf(d, p2), undefined);
  assert.deepEqual(
    d.deck.store.sessionPrs().map((r) => r.sessionId),
    [S2],
  );
  assert.deepEqual(problems(d), [`cannot record ${p1} (Error: cannot attach)`]);

  // the next scan reads S1 again and attaches its pull request
  assert.deepEqual(scanTranscripts(d.deck), { read: 1, skipped: 1, missing: 0, prsAttached: 1 });
});

test('a transcript another refresh saved while this one was listing is not taken for deleted', (t) => {
  const d = testDeck(t);
  two(d);
  scanTranscripts(d.deck);
  const demo = join(d.deck.places.claudeHome, 'projects', 'demo');
  const p3 = join(demo, `${S3}.jsonl`);
  const files = d.deck.platform.files;
  let raced = false;
  const deck = deckWith(d.deck, {
    files: {
      list: (dir) => {
        const names = files.list(dir);
        if (dir === demo && !raced) {
          // After this folder was listed, a new transcript appears and another skydeck saves it.
          raced = true;
          writeFileSync(p3, user(S3, T0));
          scanTranscripts(d.deck);
        }
        return names;
      },
    },
  });
  assert.equal(scanTranscripts(deck).missing, 0);
  assert.equal(rowOf(d, p3)?.missingSinceNs, null);
});

/** What node:sqlite throws while another connection holds the write lock. */
const locked = (): Error =>
  Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

test('a failure of the database itself ends the scan at once', (t) => {
  const d = testDeck(t);
  two(d);
  let attempts = 0;
  const deck = deckWith(d.deck, {
    store: {
      saveTranscript: () => {
        attempts++;
        throw locked();
      },
    },
  });
  assert.throws(() => scanTranscripts(deck), /database is locked/);
  assert.equal(attempts, 1);
});

test('a failure of the database itself while marking rows missing ends the scan', (t) => {
  const d = testDeck(t);
  const { p1, p2 } = two(d);
  scanTranscripts(d.deck);
  unlinkSync(p1);
  unlinkSync(p2);
  const deck = deckWith(d.deck, {
    store: {
      saveTranscript: () => {
        throw locked();
      },
    },
  });
  assert.throws(() => scanTranscripts(deck), /database is locked/);
  assert.equal(rowOf(d, p1)?.missingSinceNs, null);
});
