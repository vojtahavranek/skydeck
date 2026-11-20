// Follow-up F33: a launch command that starts a COPY of a session — `--fork-session` with
// `--resume <id>` or `--resume <path ending in <id>.jsonl>` (Claude Code's background feature) —
// names the session it copies (`copiedSessionOf`), and the hook's recorded command carries that id
// to ingest (`SpoolEvent.copyOf`); nothing of the value but the id is kept.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseSpoolFile } from '../../src/claude/hookinput.ts';
import { copiedSessionOf, storableArgv } from '../../src/claude/launch.ts';
import { S1, S2, T0 } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import type { SpoolFields } from '../helpers/spool.ts';

const PATH = `/home/dev/.claude/projects/-home-dev-projects-demo/${S2}.jsonl`;

describe('copiedSessionOf: the session a command starts a copy of', () => {
  const copies: [string, string[]][] = [
    ['--fork-session --resume <id>', ['claude', '--fork-session', '--resume', S2]],
    ['--resume <id> --fork-session', ['claude', '--resume', S2, '--fork-session']],
    ['-r <id>', ['claude', '-r', S2, '--fork-session']],
    ['--resume=<id>', ['claude', '--resume=' + S2, '--fork-session']],
    ['-r glued to its value', ['claude', `-r${S2}`, '--fork-session']],
    ['a path ending in <id>.jsonl', ['claude', '--fork-session', '--resume', PATH]],
    ['a relative path', ['claude', '--fork-session', '--resume', `${S2}.jsonl`]],
    [
      "the background feature's own command",
      ['claude', '--fork-session', '--resume', PATH, '--permission-mode', 'auto'],
    ],
    ['an id in capitals', ['claude', '--fork-session', '--resume', S2.toUpperCase()]],
    [
      'a path whose name is an id in capitals',
      ['claude', '--fork-session', '--resume', `/p/${S2.toUpperCase()}.jsonl`],
    ],
    ['inside a cluster (-c-resume)', ['claude', '-c-resume', S2, '--fork-session']],
    ['the last of two --resume', ['claude', '--resume', S1, '--resume', S2, '--fork-session']],
  ];
  for (const [what, argv] of copies) {
    test(`${what} → the id`, () => {
      assert.equal(copiedSessionOf(argv), S2);
    });
  }

  const none: [string, string[]][] = [
    ['--resume <id> alone (no copy)', ['claude', '--resume', S2]],
    ['--fork-session alone (no copy)', ['claude', '--fork-session']],
    ['--fork-session with --continue (no id)', ['claude', '--fork-session', '--continue']],
    ['--resume without a value (a picker)', ['claude', '--fork-session', '--resume']],
    ['--resume followed by a flag', ['claude', '--resume', '--fork-session']],
    ['a value that is a name, not an id', ['claude', '--fork-session', '--resume', 'my work']],
    ['a path not ending in .jsonl', ['claude', '--fork-session', '--resume', `/tmp/${S2}`]],
    [
      'a path ending in another suffix',
      ['claude', '--fork-session', '--resume', `/tmp/${S2}.other`],
    ],
    ['a .jsonl whose name is no id', ['claude', '--fork-session', '--resume', '/tmp/notes.jsonl']],
    ['an empty value', ['claude', '--fork-session', '--resume=']],
    ['the id after --, a positional', ['claude', '--fork-session', '--', '--resume', S2]],
    ['the id as the value of another flag', ['claude', '--fork-session', '--model', S2]],
    ['the last --resume has no value', ['claude', '--resume', S2, '--fork-session', '--resume']],
    ['a plain command', ['claude', '--model', 'opus']],
    ['the program alone', ['claude']],
    ['nothing', []],
  ];
  for (const [what, argv] of none) {
    test(`${what} → null`, () => {
      assert.equal(copiedSessionOf(argv), null);
    });
  }

  test('storableArgv still drops both flags and the value: only the id is ever kept', () => {
    assert.deepEqual(
      storableArgv(['claude', '--fork-session', '--resume', PATH, '--permission-mode', 'auto']),
      ['claude', '--permission-mode', 'auto'],
    );
  });
});

const START: SpoolFields = {
  event: 'SessionStart',
  timeNs: T0,
  pid: 4242,
  input: hookInput('SessionStart', S1, { source: 'startup' }),
};

function parse(fields: SpoolFields) {
  return parseSpoolFile(spoolName(fields, 1), spoolText(fields), () => false);
}

describe('parseSpoolFile: copyOf from the recorded command', () => {
  test('a start recorded with --fork-session --resume <path> names the original; argv keeps neither flag', () => {
    const event = parse({ ...START, argv: ['claude', '--fork-session', '--resume', PATH] });
    assert.equal(event.copyOf, S2);
    assert.deepEqual(event.argv, ['claude']);
  });

  test('… with -r <id>', () => {
    assert.equal(parse({ ...START, argv: ['claude', '-r', S2, '--fork-session'] }).copyOf, S2);
  });

  test('no copy: --resume alone, --fork-session alone, a value that is neither: no copyOf at all', () => {
    for (const argv of [
      ['claude', '--resume', S2],
      ['claude', '--fork-session'],
      ['claude', '--fork-session', '--resume', 'my work'],
      ['claude', '--model', 'opus'],
    ]) {
      const event = parse({ ...START, argv });
      assert.equal(Object.hasOwn(event, 'copyOf'), false, argv.join(' '));
    }
  });

  test('a command that names the event’s own session is no copy', () => {
    const event = parse({ ...START, argv: ['claude', '--fork-session', '--resume', S1] });
    assert.equal(Object.hasOwn(event, 'copyOf'), false);
  });

  test('a start without a recorded command, and an end, have no copyOf', () => {
    assert.equal(Object.hasOwn(parse({ ...START, argv: null }), 'copyOf'), false);
    const end: SpoolFields = {
      event: 'SessionEnd',
      timeNs: T0,
      pid: 4242,
      input: hookInput('SessionEnd', S1, { reason: 'prompt_input_exit' }),
    };
    assert.equal(Object.hasOwn(parse(end), 'copyOf'), false);
  });
});
