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
import { lookForUpdate, NOTES_READ, report } from '../../src/update/look.ts';
import type { Looked, Update } from '../../src/update/look.ts';
import { NOTE_BYTES } from '../../src/update/news.ts';
import { gitCheckout, gitTestEnv } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { realTestPlatform, testPlatform } from '../helpers/platform.ts';
import {
  commitId,
  gitArgs,
  NEW,
  noteEntry,
  OLD,
  scriptedGit,
  scriptedRepo,
  subCommand,
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
    look(): Promise<Update>;
  }

  /** A checkout whose first commit holds `content`; the look is the window's (quiet fetch). */
  function real(t: TestContext, content: Record<string, string>): Real {
    const tp = realTestPlatform(t, { env: (s) => gitTestEnv(s) });
    const c = gitCheckout(tp.sandbox, { content });
    const platform: Platform = { ...tp.platform, appRoot: c.root };
    return {
      c,
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

  test('a commit that only adds a note that is not well formed is one of the other changes', async (t) => {
    const r = real(t, { 'README.md': 'one\n' });
    const bad = r.c.push('a broken note', { 'docs/news/2026-05-01-bad.md': 'no title\n' });

    const update = await r.look();

    assert.deepEqual(update.notes, []);
    assert.deepEqual(update.others, [{ id: bad, subject: 'a broken note' }]);
    assert.equal(update.otherCount, 1);
    assert.equal(update.count, 1);
  });
});

describe('the limits of the notes, on the scripted git', () => {
  interface Looker {
    calls: string[][];
    look(): Promise<Update>;
  }

  function looker(t: TestContext, over: Partial<ScriptedRepo>): Looker {
    const tp = testPlatform(t);
    const root = join(tp.sandbox.root, 'checkout');
    mkdirSync(root);
    const calls: string[][] = [];
    const repo = scriptedRepo(root, {
      ...over,
      onCall: (call) => {
        if (subCommand(call, root) === 'cat-file') calls.push([...gitArgs(call, root)]);
      },
    });
    const platform: Platform = { ...tp.platform, runner: scriptedGit(repo), appRoot: root };
    return {
      calls,
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
