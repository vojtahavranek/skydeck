// The notes of what is new in this checkout (docs/news/, its README.md; AGENTS.md part 2): every
// note is well formed and within the limits the update dialog shows, and every other file there is
// the README, so that a note with a wrong name is not skipped silently. A failure names the file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { NEWS_DIR, NOTE_FILE, noteProblem } from '../src/update/news.ts';

const DIR = join(import.meta.dirname, '..', NEWS_DIR);

test('every note of docs/news is well formed, and every other file there is its README', () => {
  const names = readdirSync(DIR);
  assert.ok(names.includes('README.md'), `${NEWS_DIR}/README.md says the format`);
  const problems: string[] = [];
  for (const name of names) {
    const path = join(DIR, name);
    if (name === 'README.md') continue;
    if (!NOTE_FILE.test(name) || !statSync(path).isFile()) {
      problems.push(
        `${NEWS_DIR}/${name}: not a note's name (<yyyy-mm-dd>-<name>.md, lower-case letters, digits and hyphens)`,
      );
      continue;
    }
    const problem = noteProblem(readFileSync(path));
    if (problem !== null) problems.push(`${NEWS_DIR}/${name}: ${problem}`);
  }
  assert.deepEqual(problems, []);
});
