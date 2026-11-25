// What an update brings (S2 16.5; src/update/look.ts, src/update/news.ts): the notes of what is
// new that the fetched commit has and HEAD's does not, newest first, read from git's objects, and
// the other changes — on the real git with throwaway repositories in the sandbox (a checkout, its
// bare remote, a second clone that pushes), and on the scripted git for the limits.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import { gitOn } from '../../src/update/git.ts';
import { lookForUpdate, NEWS_TREE_BYTES, NOTES_READ, report } from '../../src/update/look.ts';
import type { Looked, Update } from '../../src/update/look.ts';
import { NOTE_BYTES } from '../../src/update/news.ts';
import { gitCheckout, gitTestEnv } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { realTestPlatform, testPlatform } from '../helpers/platform.ts';
import type { RunCall } from '../helpers/platform.ts';
import {
  commitId,
  gitArgs,
  NEW,
  noteEntry,
  OLD,
  scriptedGit,
  scriptedRepo,
} from '../helpers/update.ts';
import type { ScriptedRepo } from '../helpers/update.ts';

function known(looked: Looked): Update {
  assert.equal(looked.kind, 'known', JSON.stringify(looked));
  assert.ok(looked.kind === 'known');
  return looked.update;
}

const note = (title: string, text: string): string => `# ${title}\n\n${text}\n`;

describe('the notes an update brings, on the real git', () => {
  interface Real {
    c: GitCheckout;
    /** The sandbox's real platform with git's test settings. */
    platform: Platform;
    look(): Promise<Update>;
  }

  /** A checkout whose first commit holds `content`; the look is the window's (quiet fetch). */
  function real(t: TestContext, content: Record<string, string>): Real {
    const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
    const c = gitCheckout(tp.sandbox, { content });
    const platform: Platform = { ...tp.platform, appRoot: c.root };
    return {
      c,
      platform,
      look: async () =>
        known(
          await lookForUpdate(gitOn(platform, c.root), platform.files, {
            fetch: { quiet: {} },
            tolerant: true,
          }),
        ),
    };
  }

  test('only the notes the new commit adds, newest first; not one both have, one changed, one removed, a file of another name; the commits that add them are not other changes', async (t) => {
    const r = real(t, {
      'README.md': 'one\n',
      'docs/news/README.md': 'the format\n',
      'docs/news/2026-01-01-both.md': note('Both have it', 'Old news.'),
      'docs/news/2026-01-02-changed.md': note('Changed', 'Before.'),
      'docs/news/2026-01-03-removed.md': note('Removed', 'Gone.'),
    });
    const plain = r.c.push('a plain change', { 'a.txt': 'a\n' });
    const alpha = r.c.push('add alpha', {
      'docs/news/2026-02-01-alpha.md': note('Alpha', 'The first `new` thing.\nIt goes on.'),
    });
    const changed = r.c.push('change a note', {
      'docs/news/2026-01-02-changed.md': note('Changed', 'After.'),
    });
    const removed = r.c.push('remove a note', { 'docs/news/2026-01-03-removed.md': null });
    const other = r.c.push('files of other names', {
      'docs/news/notes.txt': note('Not a note', 'x'),
      'docs/news/2026-02-05-Upper.md': note('Upper', 'x'),
      'docs/news/sub/2026-02-06-deeper.md': note('Deeper', 'x'),
      'docs/2026-02-07-beside.md': note('Beside', 'x'),
      'docs/news/README.md': 'the format, changed\n',
    });
    const beta = r.c.push('add beta with code', {
      'src/thing.ts': 'export {};\n',
      'docs/news/2026-02-02-beta.md': note('Beta', 'One.\n\nTwo.'),
    });

    const update = await r.look();

    assert.equal(update.count, 6);
    assert.deepEqual(update.notes, [
      { title: 'Beta', paragraphs: ['One.', 'Two.'] },
      { title: 'Alpha', paragraphs: ['The first `new` thing. It goes on.'] },
    ]);
    assert.equal(update.moreNotes, 0);
    assert.deepEqual(update.others, [
      { id: other, subject: 'files of other names' },
      { id: removed, subject: 'remove a note' },
      { id: changed, subject: 'change a note' },
      { id: plain, subject: 'a plain change' },
    ]);
    assert.equal(update.otherCount, 4);
    // The command's list keeps every commit.
    assert.deepEqual(
      update.commits.map((c) => c.id),
      [beta, other, removed, changed, alpha, plain],
    );
  });

  test('read from the commits, never the work tree: a note written into the checkout by hand is no news, one the remote has is', async (t) => {
    const r = real(t, { 'README.md': 'one\n' });
    mkdirSync(join(r.c.root, 'docs', 'news'), { recursive: true });
    writeFileSync(join(r.c.root, 'docs', 'news', '2026-03-01-local.md'), note('Local', 'Mine.'));
    r.c.push('add remote', {
      'docs/news/2026-03-02-remote.md': note('Remote', 'Theirs.'),
    });

    const update = await r.look();

    assert.deepEqual(
      update.notes.map((n) => n.title),
      ['Remote'],
    );
    assert.equal(update.otherCount, 0);
    assert.deepEqual(update.others, []);
  });

  test('a malformed note, a binary one, one with control characters and HTML, and one over the size: the good ones shown, nothing broken', async (t) => {
    const r = real(t, { 'README.md': 'one\n' });
    r.c.push('notes of every kind', {
      'docs/news/2026-04-01-good.md': note('Good', 'Fine.'),
      'docs/news/2026-04-02-no-title.md': 'Just text.\n',
      'docs/news/2026-04-03-empty.md': '',
      'docs/news/2026-04-04-binary.md': '# Binary\n\n\u0000\u0001\u0002\n',
      'docs/news/2026-04-05-controls.md': note(
        '<b>Bold</b> \u001b[31mred\u001b[0m',
        '<img src=x onerror="window.hit=1"> \u001b]8;;http://x\u0007link\u001b]8;;\u0007',
      ),
      'docs/news/2026-04-06-huge.md': note('Huge', 'a'.repeat(NOTE_BYTES)),
      'docs/news/2026-04-07-long.md': note('Long', 'b'.repeat(700)),
    });

    const update = await r.look();

    assert.deepEqual(
      update.notes.map((n) => n.title),
      ['Long', '<b>Bold</b> red', 'Good'],
    );
    assert.deepEqual(update.notes[1]?.paragraphs, ['<img src=x onerror="window.hit=1"> link']);
    assert.equal(update.notes[0]?.paragraphs[0], `${'b'.repeat(599)}…`);
    assert.equal(update.moreNotes, 0);
    // The commit added notes that are shown: it is not one of the other changes.
    assert.equal(update.otherCount, 0);
  });

  test("a commit that adds a file of a note's name is a note's commit, also when the note is not well formed", async (t) => {
    const r = real(t, { 'README.md': 'one\n' });
    r.c.push('a broken note', { 'docs/news/2026-05-01-bad.md': 'no title\n' });
    const plain = r.c.push('a plain change', { 'a.txt': 'a\n' });

    const update = await r.look();

    assert.deepEqual(update.notes, []);
    assert.deepEqual(update.others, [{ id: plain, subject: 'a plain change' }]);
    assert.equal(update.otherCount, 1);
    assert.equal(update.count, 2);
  });

  test('45 notes, each in its commit, and 3 plain commits: 20 shown, 25 more, 3 other changes — the commits of notes not read are no other changes', async (t) => {
    const r = real(t, { 'README.md': 'one\n' });
    const plain = [r.c.commit(r.c.other, 'plain 1', { 'p1.txt': '1\n' })];
    for (let i = 1; i <= 45; i += 1) {
      const day = String(i).padStart(2, '0');
      r.c.commit(r.c.other, `note ${i}`, {
        [`docs/news/2026-08-${day}-n${i}.md`]: note(`Note ${i}`, `Text ${i}.`),
      });
      if (i === 20) plain.push(r.c.commit(r.c.other, 'plain 2', { 'p2.txt': '2\n' }));
    }
    plain.push(r.c.commit(r.c.other, 'plain 3', { 'p3.txt': '3\n' }));
    r.c.git(r.c.other, 'push', '--quiet', 'origin', 'main');

    const update = await r.look();

    assert.equal(update.count, 48);
    assert.equal(update.notes.length, 20);
    assert.equal(update.notes[0]?.title, 'Note 45');
    assert.equal(update.moreNotes, 25);
    assert.equal(update.otherCount, 3);
    assert.deepEqual(
      update.others.map((c) => c.subject),
      ['plain 3', 'plain 2', 'plain 1'],
    );
    assert.match(report(update).join('\n'), /\n {2}Note 26\n {2}… and 25 more$/);
  });

  test('a note moved to a new name is added by the commit that moves it (no rename is followed)', async (t) => {
    const r = real(t, {
      'README.md': 'one\n',
      'docs/news/2026-01-01-old.md': note('Moved', 'The same text, long enough to be a rename.'),
    });
    r.c.push('move the note', {
      'docs/news/2026-01-01-old.md': null,
      'docs/news/2026-09-01-new.md': note('Moved', 'The same text, long enough to be a rename.'),
    });

    const update = await r.look();

    assert.deepEqual(
      update.notes.map((n) => n.title),
      ['Moved'],
    );
    assert.equal(update.otherCount, 0, "the commit that moves it is the note's commit");
  });

  test('a partial clone without the blobs: no notes, nothing fetched, the update known as before', async (t) => {
    const r = real(t, { 'README.md': 'one\n' });
    r.c.git(r.c.remote, 'config', 'uploadpack.allowFilter', 'true');
    const partial = join(r.c.root, '..', 'partial');
    mkdirSync(partial);
    r.c.git(partial, 'clone', '--quiet', '--filter=blob:none', `file://${r.c.remote}`, '.');
    r.c.push('a note', { 'docs/news/2026-10-01-p.md': note('Partial', 'Not fetched.') });
    r.c.git(partial, 'fetch', '--quiet', 'origin');
    const missing = (): string =>
      r.c.git(partial, 'rev-list', '--objects', '--missing=print', 'origin/main');
    assert.match(missing(), /^\?[0-9a-f]+$/m, 'the note blob is missing');
    const before = missing();

    const platform: Platform = { ...r.platform, appRoot: partial };
    const looked = await lookForUpdate(gitOn(platform, partial), platform.files, {
      fetch: 'none',
      tolerant: true,
    });

    const update = known(looked);
    assert.equal(update.count, 1);
    assert.deepEqual(update.notes, []);
    assert.equal(update.otherCount, 1);
    assert.equal(missing(), before, 'no object was fetched');
  });
});

describe('the limits of the notes, on the scripted git', () => {
  interface Looker {
    /** The `cat-file blob` calls: their arguments. */
    calls: string[][];
    /** Every call: its arguments and options. */
    all: RunCall[];
    look(): Promise<Update>;
  }

  function looker(t: TestContext, over: Partial<ScriptedRepo>): Looker {
    const tp = testPlatform(t);
    const root = join(tp.sandbox.root, 'checkout');
    mkdirSync(root);
    const calls: string[][] = [];
    const all: RunCall[] = [];
    const repo = scriptedRepo(root, {
      ...over,
      onCall: (call) => {
        all.push(call);
        const args = gitArgs(call, root);
        if (args[0] === 'cat-file' && args[1] === 'blob') calls.push([...args]);
      },
    });
    const platform: Platform = { ...tp.platform, runner: scriptedGit(repo), appRoot: root };
    return {
      calls,
      all,
      look: async () =>
        known(
          await lookForUpdate(gitOn(platform, root), platform.files, {
            fetch: 'none',
            tolerant: true,
          }),
        ),
    };
  }

  /** `n` well-formed notes on NEW, named by day of 2026-06 (`2026-06-01-n1.md` …), blobs `b<i>`. */
  function notes(n: number): Pick<ScriptedRepo, 'news' | 'blobs'> {
    let entries = '';
    const blobs: Record<string, string> = {};
    for (let i = 1; i <= n; i += 1) {
      const blob = `${i.toString(16).padStart(40, 'b')}`;
      entries += noteEntry(`2026-06-${String(i).padStart(2, '0')}-n${i}.md`, blob);
      blobs[blob] = note(`Note ${i}`, `Text ${i}.`);
    }
    return { news: { [NEW]: entries }, blobs };
  }

  test('21 notes: the 20 newest by file name, then one more', async (t) => {
    const l = looker(t, { ...notes(21), behind: 21 });

    const update = await l.look();

    assert.equal(update.notes.length, 20);
    assert.equal(update.notes[0]?.title, 'Note 21');
    assert.equal(update.notes[19]?.title, 'Note 2');
    assert.equal(update.moreNotes, 1);
    assert.match(
      report(update).join('\n'),
      /\nwhat is new:\n {2}Note 21\n[^]* {2}Note 2\n {2}… and 1 more$/,
    );
  });

  test(`no more than ${NOTES_READ} files are read; the rest count as more`, async (t) => {
    const l = looker(t, { ...notes(NOTES_READ + 5), behind: 50 });

    const update = await l.look();

    assert.equal(l.calls.length, NOTES_READ);
    assert.equal(update.notes.length, 20);
    assert.equal(update.moreNotes, NOTES_READ - 20 + 5);
  });

  test('a file larger than the bound is not read; each read keeps no more than the bound', async (t) => {
    const blob = 'c'.repeat(40);
    const l = looker(t, {
      news: {
        [NEW]:
          noteEntry('2026-07-01-big.md', blob, NOTE_BYTES + 1) +
          noteEntry('2026-07-02-small.md', 'd'.repeat(40), 40),
      },
      blobs: { [blob]: note('Big', 'x'), ['d'.repeat(40)]: note('Small', 'y') },
    });

    const update = await l.look();

    assert.deepEqual(
      update.notes.map((n) => n.title),
      ['Small'],
    );
    assert.deepEqual(l.calls, [['cat-file', 'blob', 'd'.repeat(40)]]);
    const read = l.all.find((call) => call.args.includes('blob'));
    assert.equal(
      read?.options?.maxOutputBytes,
      NOTE_BYTES,
      'the read keeps no more than the bound',
    );
  });

  test("the notes' git calls fetch nothing (GIT_NO_LAZY_FETCH); the look's others are as before", async (t) => {
    const l = looker(t, { ...notes(1), noteAdders: [NEW] });

    await l.look();

    const sub = (call: RunCall): string =>
      call.args.slice(2).filter((a) => !a.startsWith('-'))[0] ?? '';
    const offline = l.all.filter((call) => call.options?.env?.['GIT_NO_LAZY_FETCH'] === '1');
    assert.deepEqual(
      offline.map((call) => `${sub(call)} ${call.args.includes('blob') ? 'blob' : ''}`.trim()),
      ['cat-file', 'ls-tree', 'cat-file blob', 'log'],
      'the old commit has no tree of notes: one listing',
    );
    assert.ok(
      l.all
        .filter((call) => !offline.includes(call))
        .every((call) => call.options?.env?.['GIT_NO_LAZY_FETCH'] === undefined),
    );
  });

  /** A look whose notes cannot be read: known, every commit one of the other changes. */
  function noNotes(update: Update): void {
    assert.equal(update.count, 1);
    assert.deepEqual(update.notes, []);
    assert.equal(update.moreNotes, 0);
    assert.deepEqual(update.others, [{ id: NEW, subject: 'the new commit' }]);
    assert.equal(update.otherCount, 1);
  }

  test('a tree of notes larger than the bound: no notes, no listing read', async (t) => {
    const l = looker(t, { ...notes(2), newsTreeSize: NEWS_TREE_BYTES + 1, noteAdders: [NEW] });

    noNotes(await l.look());
    assert.ok(!l.all.some((call) => call.args.includes('ls-tree') && call.args.includes('-l')));
  });

  test('a listing past its cap: no notes; it is read with the cap', async (t) => {
    const big = noteEntry('2026-06-01-a.md', 'b'.repeat(40)).repeat(30_000);
    const l = looker(t, { news: { [NEW]: big }, blobs: notes(1).blobs, noteAdders: [NEW] });

    noNotes(await l.look());
    const listing = l.all.find((call) => call.args.includes('-l'));
    assert.equal(listing?.options?.maxOutputBytes, 4 * NEWS_TREE_BYTES);
    assert.deepEqual(l.calls, []);
  });

  test('a git call of the notes that fails or times out, a missing blob: no notes, the update as before', async (t) => {
    const blob = '1'.padStart(40, 'b');
    const failures: Partial<ScriptedRepo>[] = [
      {
        answers: {
          [`cat-file blob ${blob}`]: { code: 128, stderr: `fatal: missing blob ${blob}\n` },
        },
      },
      { answers: { 'cat-file --batch-check': { code: null, timedOut: true } } },
      {
        answers: {
          [`ls-tree -l -z --full-tree ${NEW} -- docs/news/`]: {
            code: 128,
            stderr: 'fatal: bad tree\n',
          },
        },
      },
      {
        answers: {
          [`config -z --get-regexp ^(extensions\\.partialclone|remote\\..*\\.promisor)$`]: {
            code: 3,
          },
        },
      },
    ];
    for (const over of failures) {
      const l = looker(t, { ...notes(1), noteAdders: [NEW], ...over });
      noNotes(await l.look());
    }
    const logFails = looker(t, { ...notes(1), noteAdders: [NEW] });
    // The adders' log is the last call of the notes: its failure drops the notes read too.
    const withLog = looker(t, {
      ...notes(1),
      answers: {
        [`log --diff-filter=A --no-renames --no-show-signature --no-color -z --format=%H ${OLD}..${NEW} -- docs/news/2026-06-01-n1.md`]:
          { code: 128, stderr: 'fatal: x\n' },
      },
    });
    noNotes(await withLog.look());
    assert.equal((await logFails.look()).notes.length, 1, 'without a failure the note is there');
  });

  test('a partial clone (its settings): no notes, nothing of them read', async (t) => {
    for (const setting of ['extensions.partialclone\norigin\0', 'remote.origin.promisor\ntrue\0']) {
      const l = looker(t, { ...notes(1), noteAdders: [NEW], partialClone: setting });
      noNotes(await l.look());
      assert.ok(!l.all.some((call) => call.args.includes('cat-file')));
    }
    const off = looker(t, {
      ...notes(1),
      noteAdders: [NEW],
      partialClone: 'remote.origin.promisor\nfalse\0',
    });
    assert.equal((await off.look()).notes.length, 1);
  });

  test('a symbolic link, a directory and an entry of another folder are no notes', async (t) => {
    const blob = 'e'.repeat(40);
    const l = looker(t, {
      news: {
        [NEW]:
          `120000 blob ${blob}      10\tdocs/news/2026-07-03-link.md\0` +
          `040000 tree ${blob}       -\tdocs/news/2026-07-04-dir.md\0` +
          `100644 blob ${blob}      10\tdocs/other/2026-07-05-x.md\0`,
      },
      blobs: { [blob]: note('X', 'x') },
    });

    const update = await l.look();

    assert.deepEqual(update.notes, []);
    assert.deepEqual(l.calls, []);
  });

  test('unread notes are counted: with no note read the update still brings notes (moreNotes)', async (t) => {
    const l = looker(t, { ...notes(NOTES_READ + 2), behind: 50 });
    assert.equal((await l.look()).moreNotes, NOTES_READ - 20 + 2);
  });

  test('the other changes: the commits that add no note, newest first, at most 20, and their count', async (t) => {
    const commits = Array.from({ length: 25 }, (_, i) => ({
      id: commitId(25 - i),
      subject: `commit ${25 - i}`,
    }));
    const l = looker(t, {
      ...notes(2),
      behind: 30,
      commits,
      noteAdders: [commitId(25), commitId(23)],
    });

    const update = await l.look();

    assert.equal(update.otherCount, 28);
    assert.equal(update.others.length, 20);
    assert.deepEqual(
      update.others.slice(0, 3).map((c) => c.subject),
      ['commit 24', 'commit 22', 'commit 21'],
    );
    assert.equal(update.others.at(-1)?.subject, 'commit 4');
    assert.equal(update.commits.length, 20);
    assert.equal(update.commits[0]?.subject, 'commit 25');
  });

  test('an update without notes: no note read, no log of the adders; every commit is another change', async (t) => {
    const l = looker(t, {});

    const update = await l.look();

    assert.deepEqual(update.notes, []);
    assert.deepEqual(update.others, [{ id: NEW, subject: 'the new commit' }]);
    assert.equal(update.otherCount, 1);
    assert.deepEqual(report(update), [
      `1 new commit on origin/main (${OLD.slice(0, 7)}..${NEW.slice(0, 7)}):`,
      `  ${NEW.slice(0, 7)}  the new commit`,
    ]);
  });
});
