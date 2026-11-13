// `show` and the detail of the interactive list print the same note and the same state, whatever
// text they are given: the two used to split and trim by their own rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatShow } from '../../src/cli/output.ts';
import { initModel, reduce } from '../../src/cli/tui/model.ts';
import { render } from '../../src/cli/tui/render.ts';
import { S1, T0 } from '../helpers/platform.ts';
import { listRow } from '../helpers/rows.ts';
import type { ListRow } from '../../src/sessions/list.ts';

const NOTES = [
  'a\nb',
  'a\rb',
  'a\r\nb\r\n',
  'a\r\rb',
  '\n\nabove\n\n\nbelow\n\n',
  'one \x1b[31mred\x1b[0m\r\x1b]0;title\x07two\twith tab\x07\r\n\r\n  \nthree',
  '\x1b[2J\n\x07',
  'a\u009bb‮c\n d',
];

/** What `show` prints, as lines without the final line break. */
function shown(row: ListRow): string[] {
  const lines = formatShow(row, [], T0).split('\n');
  lines.pop(); // what follows the final line break
  return lines;
}

/** The detail view of the row on a screen tall enough for everything: its lines without the help line. */
function detail(row: ListRow): string[] {
  const { model } = reduce(initModel([row], T0), 'enter');
  const lines = render(model, { columns: 100, rows: 60 });
  lines.pop(); // the help line
  return lines;
}

/** The `note:` heading and the lines after it, none when there is no heading. */
function noteOf(lines: string[]): string[] {
  const at = lines.indexOf('note:');
  const note = at < 0 ? [] : lines.slice(at);
  while (note.at(-1) === '') {
    note.pop(); // the screen is padded below the body
  }
  return note;
}

for (const note of NOTES) {
  test(`the same note lines in show and in the detail: ${JSON.stringify(note)}`, () => {
    const row = listRow({ id: S1, hasNote: true, note });

    assert.deepEqual(noteOf(detail(row)), noteOf(shown(row)));
  });
}

for (const stateDetail of [null, '', ' ', 'tool: Bash']) {
  test(`the same state in show and in the detail: ${JSON.stringify(stateDetail)}`, () => {
    const row = listRow({ id: S1, state: 'waiting', stateDetail });

    const inDetail = detail(row).find((line) => line.startsWith('state: '));
    const inShow = shown(row).find((line) => line.startsWith('state:'));

    const brackets = (line: string | undefined): string | null =>
      /^state: +waiting(?: \((.*)\))?( since .*)?$/.exec(line ?? '')?.[1] ?? null;
    assert.equal(brackets(inDetail), brackets(inShow));
    assert.doesNotMatch(`${inDetail}\n${inShow}`, /\(\s*\)/);
  });
}
