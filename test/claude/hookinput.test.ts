import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  END_DETAILS,
  START_DETAILS,
  SpoolParseError,
  parseSpoolFile,
} from '../../src/claude/hookinput.ts';
import type { SpoolEvent } from '../../src/claude/hookinput.ts';
import { procStartFromStat } from '../../src/claude/procstat.ts';
import { realPlatform } from '../../src/platform/real.ts';
import { BOOT_A, S1, S2, T0, statLine } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import type { SpoolFields } from '../helpers/spool.ts';

const fixtures = fileURLToPath(new URL('../fixtures/claude/', import.meta.url));
const hook = fileURLToPath(new URL('../../bin/skydeck-hook', import.meta.url));

const START: SpoolFields = {
  event: 'SessionStart',
  timeNs: T0,
  pid: 4242,
  input: hookInput('SessionStart', S1, { source: 'startup' }),
};
const END: SpoolFields = {
  event: 'SessionEnd',
  timeNs: T0,
  pid: 4242,
  input: hookInput('SessionEnd', S1, { reason: 'clear' }),
};

const never = (): boolean => false;

/** The `parse(fields)` of the plan: a spool file built from `fields`, parsed. */
function parse(fields: SpoolFields, exists: (path: string) => boolean = never): SpoolEvent {
  return parseSpoolFile(spoolName(fields, 1), spoolText(fields), exists);
}

function start(over: Partial<SpoolFields>): SpoolFields {
  return { ...START, ...over };
}

function end(over: Partial<SpoolFields>): SpoolFields {
  return { ...END, ...over };
}

function startWith(extra: Record<string, unknown>): SpoolFields {
  return start({ input: hookInput('SessionStart', S1, extra) });
}

function endWith(extra: Record<string, unknown>): SpoolFields {
  return end({ input: hookInput('SessionEnd', S1, extra) });
}

function fixture(...parts: string[]): string {
  return readFileSync(join(fixtures, ...parts), 'utf8');
}

/** Removes the line `<key>=...` from a spool text. */
function withoutKey(text: string, key: string): string {
  const lines = text.split('\n');
  const kept = lines.filter((line, index) => {
    const marker = lines.indexOf('--');
    return !(index < marker && line.startsWith(`${key}=`));
  });
  assert.notEqual(kept.length, lines.length, `no ${key} line to remove`);
  return kept.join('\n');
}

/** Puts a line just before the `--` line. */
function withLine(text: string, line: string): string {
  assert.ok(text.includes('\n--\n'));
  return text.replace('\n--\n', `\n${line}\n--\n`);
}

/** Replaces the whole line `<key>=...` of a spool text by `<line>`. */
function withReplacedLine(text: string, key: string, line: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((l) => l.startsWith(`${key}=`));
  assert.notEqual(index, -1, `no ${key} line`);
  lines[index] = line;
  return lines.join('\n');
}

describe('parseSpoolFile: the fixture files', () => {
  test('the first spool fixture gives the whole event', () => {
    const name = '1794474000000000000-4242-1.ev';
    const content = fixture('spool', name);
    const payload = content.slice(content.indexOf('\n--\n') + 4);
    assert.equal(payload, fixture('hook-input', 'start-startup.json'));

    assert.deepEqual(parseSpoolFile(name, content, never), {
      spoolName: name,
      timeNs: T0,
      kind: 'start',
      detail: 'startup',
      rawDetail: 'startup',
      sessionId: S1,
      bootId: BOOT_A,
      pid: 4242,
      procStart: 51234567,
      cwd: '/home/dev/projects/demo',
      argv: ['claude', '--model', 'opus'],
      name: null,
      payload,
      entrypointEnv: 'cli',
      scripted: false,
    });
  });

  test('the second spool fixture is the end of that session', () => {
    const name = '1794474060000000000-4242-2.ev';
    const event = parseSpoolFile(name, fixture('spool', name), never);
    assert.equal(event.timeNs, T0 + 60_000_000_000n);
    assert.equal(event.kind, 'end');
    assert.equal(event.detail, 'clear');
    assert.equal(event.rawDetail, 'clear');
    assert.equal(event.sessionId, S1);
    assert.equal(event.argv, null);
    assert.equal(event.scripted, false);
    assert.equal(event.payload, fixture('hook-input', 'end-clear.json'));
  });

  test('both spool fixtures are what the test helper writes (the helper mirrors the hook)', () => {
    const input = (file: string): string => fixture('hook-input', file);
    const first = {
      event: 'SessionStart',
      timeNs: T0,
      pid: 4242,
      sessionEnv: S1,
      argv: ['claude', '--model', 'opus'],
      input: input('start-startup.json'),
    } as const;
    const second = {
      event: 'SessionEnd',
      timeNs: T0 + 60_000_000_000n,
      pid: 4242,
      sessionEnv: S1,
      input: input('end-clear.json'),
    } as const;
    assert.equal(fixture('spool', spoolName(first, 1)), spoolText(first));
    assert.equal(fixture('spool', spoolName(second, 2)), spoolText(second));
    assert.deepEqual(readdirSync(join(fixtures, 'spool')).sort(), [
      spoolName(first, 1),
      spoolName(second, 2),
    ]);
  });

  // [file, event, kind, detail, rawDetail]
  const expected: Record<string, [string, SpoolEvent['detail'], string]> = {
    'start-startup.json': ['SessionStart', 'startup', 'startup'],
    'start-resume.json': ['SessionStart', 'resume', 'resume'],
    'start-clear.json': ['SessionStart', 'clear', 'clear'],
    'start-compact.json': ['SessionStart', 'compact', 'compact'],
    'start-fork.json': ['SessionStart', 'fork', 'fork'],
    'start-named.json': ['SessionStart', 'startup', 'startup'],
    'end-clear.json': ['SessionEnd', 'clear', 'clear'],
    'end-resume.json': ['SessionEnd', 'switch', 'resume'],
    'end-prompt_input_exit.json': ['SessionEnd', 'exit', 'prompt_input_exit'],
    'end-logout.json': ['SessionEnd', 'exit', 'logout'],
    'end-other.json': ['SessionEnd', 'other', 'other'],
  };

  test('there is a hook-input fixture for each event and detail, and no other', () => {
    assert.deepEqual(
      readdirSync(join(fixtures, 'hook-input')).sort(),
      Object.keys(expected).sort(),
    );
  });

  for (const [file, [event, detail, raw]] of Object.entries(expected)) {
    test(`hook-input/${file} parses inside a spool and gives ${detail}`, () => {
      const text = fixture('hook-input', file);
      const input = JSON.parse(text) as Record<string, unknown>;
      assert.equal(input['session_id'], S1, 'fixtures use the session id S1');
      assert.equal(input['cwd'], '/home/dev/projects/demo');
      assert.equal(input['hook_event_name'], event);
      assert.equal(typeof input['transcript_path'], 'string');

      const fields: SpoolFields = {
        event: event as SpoolFields['event'],
        timeNs: T0,
        pid: 4242,
        input: text,
      };
      const parsed = parse(fields);
      assert.equal(parsed.kind, event === 'SessionStart' ? 'start' : 'end');
      assert.equal(parsed.detail, detail);
      assert.equal(parsed.rawDetail, raw);
      assert.equal(parsed.sessionId, S1);
      assert.equal(parsed.payload, text);
      assert.equal(parsed.name, file === 'start-named.json' ? 'demo session' : null);
    });
  }

  test('no fixture carries conversation text or anything but the five documented keys', () => {
    for (const file of readdirSync(join(fixtures, 'hook-input'))) {
      const keys = Object.keys(JSON.parse(fixture('hook-input', file)) as object);
      for (const key of keys) {
        assert.ok(
          [
            'session_id',
            'transcript_path',
            'cwd',
            'hook_event_name',
            'source',
            'reason',
            'session_title',
          ].includes(key),
          `${file}: ${key}`,
        );
      }
    }
  });
});

describe('parseSpoolFile: kind and detail', () => {
  test('START_DETAILS and END_DETAILS are the tables of the plan', () => {
    assert.deepEqual(START_DETAILS, {
      startup: 'startup',
      resume: 'resume',
      clear: 'clear',
      compact: 'compact',
      fork: 'fork',
    });
    assert.deepEqual(END_DETAILS, {
      clear: 'clear',
      resume: 'switch',
      prompt_input_exit: 'exit',
      logout: 'exit',
    });
  });

  for (const source of ['resume', 'clear', 'compact', 'fork', 'startup'] as const) {
    test(`source ${source} gives detail ${source}`, () => {
      const event = parse(startWith({ source }));
      assert.equal(event.kind, 'start');
      assert.equal(event.detail, source);
      assert.equal(event.rawDetail, source);
    });
  }

  test('an unknown source gives unknown and keeps what was received', () => {
    const event = parse(startWith({ source: 'weird' }));
    assert.equal(event.detail, 'unknown');
    assert.equal(event.rawDetail, 'weird');
  });

  test('no source gives unknown with rawDetail null', () => {
    const event = parse(startWith({}));
    assert.equal(event.detail, 'unknown');
    assert.equal(event.rawDetail, null);
  });

  test('a source that is not a string gives unknown with rawDetail null', () => {
    const event = parse(startWith({ source: 5 }));
    assert.equal(event.detail, 'unknown');
    assert.equal(event.rawDetail, null);
  });

  test('an empty source or reason is kept as received, not taken for absent', () => {
    const started = parse(startWith({ source: '' }));
    assert.equal(started.detail, 'unknown');
    assert.equal(started.rawDetail, '');
    const ended = parse(endWith({ reason: '' }));
    assert.equal(ended.detail, 'other');
    assert.equal(ended.rawDetail, '');
  });

  test('a source that is the name of an inherited property is unknown, not a function', () => {
    for (const source of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const event = parse(startWith({ source }));
      assert.equal(event.detail, 'unknown', source);
      assert.equal(event.rawDetail, source);
    }
  });

  const reasons: Array<[string, SpoolEvent['detail']]> = [
    ['clear', 'clear'],
    ['resume', 'switch'],
    ['prompt_input_exit', 'exit'],
    ['logout', 'exit'],
    ['other', 'other'],
    ['terminal_closed', 'other'],
    ['constructor', 'other'],
    ['__proto__', 'other'],
  ];
  for (const [reason, detail] of reasons) {
    test(`reason ${reason} gives detail ${detail} and keeps ${reason}`, () => {
      const event = parse(endWith({ reason }));
      assert.equal(event.kind, 'end');
      assert.equal(event.detail, detail);
      assert.equal(event.rawDetail, reason);
    });
  }

  test('an end without a reason is other with rawDetail null', () => {
    const event = parse(endWith({}));
    assert.equal(event.detail, 'other');
    assert.equal(event.rawDetail, null);
  });
});

describe('parseSpoolFile: name and session id', () => {
  test('session_title is the name of a start; absent is null', () => {
    assert.equal(parse(startWith({ session_title: 'my name' })).name, 'my name');
    assert.equal(parse(START).name, null);
  });

  test('an empty or non-string session_title is no name, and an end has no name', () => {
    assert.equal(parse(startWith({ session_title: '' })).name, null);
    assert.equal(parse(startWith({ session_title: 5 })).name, null);
    assert.equal(parse(endWith({ session_title: 'my name' })).name, null);
  });

  test('the session id of the input wins over session_env', () => {
    const fields = start({ sessionEnv: S2 });
    assert.equal(parse(fields).sessionId, S1);
  });

  test('without a session_id in the input, session_env is used', () => {
    const input = hookInput('SessionStart', S1, { source: 'startup' });
    delete input['session_id'];
    assert.equal(parse(start({ input, sessionEnv: S2 })).sessionId, S2);
  });

  test('a session_id that is not a UUID falls back to session_env', () => {
    const input = hookInput('SessionStart', 'nope', { source: 'startup' });
    assert.equal(parse(start({ input, sessionEnv: S2 })).sessionId, S2);
  });

  test('a session_id that is not a string falls back to session_env', () => {
    const input = hookInput('SessionStart', S1, { session_id: 7 });
    assert.equal(parse(start({ input, sessionEnv: S2 })).sessionId, S2);
  });

  test('an upper-case id is written in lower case', () => {
    const upper = hookInput('SessionStart', S1.toUpperCase(), { source: 'startup' });
    assert.equal(parse(start({ input: upper, sessionEnv: '' })).sessionId, S1);
    const noId = hookInput('SessionStart', 'nope', { source: 'startup' });
    assert.equal(parse(start({ input: noId, sessionEnv: S2.toUpperCase() })).sessionId, S2);
  });

  test('no valid session id anywhere is a parse error', () => {
    const nope = hookInput('SessionStart', 'nope', { source: 'startup' });
    assert.throws(() => parse(start({ input: nope, sessionEnv: '' })), SpoolParseError);
    assert.throws(() => parse(start({ input: nope, sessionEnv: 'nope' })), SpoolParseError);
    const bare = hookInput('SessionStart', S1, {});
    delete bare['session_id'];
    assert.throws(() => parse(start({ input: bare, sessionEnv: '' })), SpoolParseError);
  });

  test('a session id that would be read as a flag is never the id', () => {
    // The id ends up after `--resume` on a command line.
    const flag = '--dangerously-skip-permissions';
    const input = hookInput('SessionStart', flag, { source: 'startup' });
    assert.equal(parse(start({ input, sessionEnv: S2 })).sessionId, S2);
    assert.throws(() => parse(start({ input, sessionEnv: flag })), SpoolParseError);
    assert.throws(() => parse(start({ input, sessionEnv: '' })), SpoolParseError);
  });

  test('whatever the file holds, the session id is a lowercase UUID', () => {
    const ids = [S1, S1.toUpperCase(), 'nope', '', 7, null, `${S1}\n`, '--resume'];
    for (const fromInput of ids) {
      for (const fromEnv of ids) {
        const input = hookInput('SessionStart', S1, { source: 'startup', session_id: fromInput });
        try {
          const id = parse(start({ input, sessionEnv: String(fromEnv ?? '') })).sessionId;
          assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
        } catch (error) {
          assert.ok(error instanceof SpoolParseError);
        }
      }
    }
  });

  test('an id with anything around it is not a UUID', () => {
    for (const id of [`${S1}\n`, ` ${S1}`, `${S1}0`, S1.slice(1), S1.replaceAll('-', '')]) {
      const input = hookInput('SessionStart', id, {});
      assert.throws(
        () => parse(start({ input, sessionEnv: '' })),
        SpoolParseError,
        JSON.stringify(id),
      );
    }
  });
});

describe('parseSpoolFile: cwd, process and entry point', () => {
  test('cwd comes from the input, else from pwd, else it is null', () => {
    assert.equal(parse(START).cwd, '/home/dev/projects/demo');
    const noCwd = hookInput('SessionStart', S1, { source: 'startup' });
    delete noCwd['cwd'];
    assert.equal(parse(start({ input: noCwd, pwd: '/p' })).cwd, '/p');
    assert.equal(parse(start({ input: noCwd, pwd: '' })).cwd, null);
  });

  test('the cwd of the input wins over pwd', () => {
    const input = hookInput('SessionStart', S1, { source: 'startup', cwd: '/w' });
    assert.equal(parse(start({ input, pwd: '/p' })).cwd, '/w');
  });

  test('a cwd of the input that is empty or not a string is passed over', () => {
    assert.equal(parse(startWith({ cwd: '' })).cwd, '/home/dev/projects/demo');
    assert.equal(parse(startWith({ cwd: 5 })).cwd, '/home/dev/projects/demo');
  });

  test('no claude_pid gives pid 0 and no process start, whatever stat says', () => {
    const fields = start({ pid: null });
    const event = parse(fields);
    assert.equal(event.pid, 0);
    assert.equal(event.procStart, null);
    // The hook writes stat empty then; a stat line anyway is not about a process skydeck knows.
    const text = withReplacedLine(spoolText(fields), 'stat', `stat=${statLine(5, 99)}`);
    assert.equal(parseSpoolFile(spoolName(fields, 1), text, never).procStart, null);
  });

  test('an unreadable stat gives no process start', () => {
    assert.equal(parse(start({ procStart: null })).procStart, null);
    assert.equal(parse(start({ procStart: null })).pid, 4242);
  });

  test('a stat whose command name is "a) b" still gives field 22', () => {
    const fields = start({});
    const text = withReplacedLine(spoolText(fields), 'stat', `stat=${statLine(4242, 777, 'a) b')}`);
    assert.equal(parseSpoolFile(spoolName(fields, 1), text, never).procStart, 777);
  });

  test('entrypoint_env is the value, and empty is null', () => {
    assert.equal(parse(START).entrypointEnv, 'cli');
    assert.equal(parse(start({ entrypointEnv: 'sdk-cli' })).entrypointEnv, 'sdk-cli');
    assert.equal(parse(start({ entrypointEnv: '' })).entrypointEnv, null);
  });

  test('time and boot id are read as written', () => {
    const event = parse(start({ timeNs: 1_762_988_000_123_456_789n, bootId: 'some-boot' }));
    assert.equal(event.timeNs, 1_762_988_000_123_456_789n);
    assert.equal(event.bootId, 'some-boot');
  });
});

describe('parseSpoolFile: the launch command', () => {
  test('argv null stays null', () => {
    assert.equal(parse(start({ argv: null })).argv, null);
  });

  test('a SessionEnd has no argv even when an argv_b64 line is there', () => {
    const text = withLine(
      spoolText(END),
      `argv_b64=${Buffer.from('claude\0--model\0opus\0').toString('base64')}`,
    );
    assert.equal(parseSpoolFile(spoolName(END, 1), text, never).argv, null);
  });

  test('positional arguments are dropped: a prompt is conversation text', () => {
    assert.deepEqual(parse(start({ argv: ['claude', '--model', 'opus', 'fix the bug'] })).argv, [
      'claude',
      '--model',
      'opus',
    ]);
    assert.deepEqual(parse(start({ argv: ['claude', '--', 'fix the bug'] })).argv, ['claude']);
  });

  test('the flags a resume drops are not stored, with their values', () => {
    const argv = ['claude', '--prefill-b64=Zml4', '--resume', 'abc', '--model', 'opus'];
    assert.deepEqual(parse(start({ argv })).argv, ['claude', '--model', 'opus']);
  });

  test('a flag the table does not know is stored as its bare name', () => {
    assert.deepEqual(parse(start({ argv: ['claude', '--new-flag', 'fix the bug'] })).argv, [
      'claude',
      '--new-flag',
    ]);
    assert.deepEqual(parse(start({ argv: ['claude', '--new-flag=fix the bug'] })).argv, [
      'claude',
      '--new-flag',
    ]);
  });

  test('no text of a prompt reaches the event except in the payload', () => {
    const argv = [
      'claude',
      '--model',
      'opus',
      '--prefill',
      'secret words',
      '--future',
      'secret words',
      '--',
      'secret words',
    ];
    const event = parse(start({ argv }));
    assert.deepEqual(event.argv, ['claude', '--model', 'opus', '--future']);
    assert.ok(!JSON.stringify({ ...event, payload: '', timeNs: 0 }).includes('secret'));
  });

  test('relative path flags are made absolute against the input cwd when the path exists', () => {
    const argv = ['claude', '--mcp-config', 'mcp.json'];
    const input = hookInput('SessionStart', S1, { source: 'startup', cwd: '/w' });
    const asked: string[] = [];
    const event = parse(start({ argv, input }), (path) => {
      asked.push(path);
      return path === '/w/mcp.json';
    });
    assert.deepEqual(event.argv, ['claude', '--mcp-config', '/w/mcp.json']);
    assert.deepEqual(asked, ['/w/mcp.json']);
  });

  test('a path that does not exist is left as written', () => {
    const argv = ['claude', '--mcp-config', 'mcp.json'];
    const input = hookInput('SessionStart', S1, { source: 'startup', cwd: '/w' });
    assert.deepEqual(parse(start({ argv, input })).argv, argv);
  });

  test('a path-flag value that makes the existence check throw is kept as written', () => {
    // Claude Code takes inline JSON for --settings and --mcp-config. Resolved against a directory
    // it is a path with a component longer than a file name may be, and stat fails with
    // ENAMETOOLONG instead of "not found".
    const json = JSON.stringify({ permissions: { allow: ['Bash(npm run lint)'.repeat(15)] } });
    assert.ok(json.length > 255 && !json.includes('/'));
    const argv = ['claude', '--settings', json, '--mcp-config', 'mcp.json'];
    const input = hookInput('SessionStart', S1, { source: 'startup', cwd: '/w' });
    const throwing = (path: string): boolean => {
      if (path === `/w/${json}`) throw new Error('ENAMETOOLONG');
      return path === '/w/mcp.json';
    };
    assert.deepEqual(parse(start({ argv, input }), throwing).argv, [
      'claude',
      '--settings',
      json,
      '--mcp-config',
      '/w/mcp.json',
    ]);
  });

  test('with the real stat as the existence check, inline JSON and a NUL in the cwd cannot throw', (t) => {
    const s = sandbox(t);
    const { files } = realPlatform();
    const exists = (path: string): boolean => files.stat(path) !== null;
    const json = JSON.stringify({ permissions: { allow: ['Bash(npm run lint)'.repeat(15)] } });
    const long = hookInput('SessionStart', S1, { source: 'startup', cwd: s.root });
    assert.deepEqual(
      parse(start({ argv: ['claude', '--settings', json], input: long }), exists).argv,
      ['claude', '--settings', json],
    );
    const nul = hookInput('SessionStart', S1, { source: 'startup', cwd: `${s.root}/a\u0000b` });
    assert.deepEqual(
      parse(start({ argv: ['claude', '--mcp-config', 'm.json'], input: nul }), exists).argv,
      ['claude', '--mcp-config', 'm.json'],
    );
  });

  test('without a cwd in the input the pwd key is the base for relative paths', () => {
    const argv = ['claude', '--settings=s.json'];
    const input = hookInput('SessionStart', S1, { source: 'startup' });
    delete input['cwd'];
    const event = parse(start({ argv, input, pwd: '/p' }), (path) => path === '/p/s.json');
    assert.deepEqual(event.argv, ['claude', '--settings=/p/s.json']);
  });
});

describe('parseSpoolFile: the lines of the file', () => {
  test('an unknown key before -- is ignored', () => {
    const text = withLine(spoolText(START), 'future_key=1');
    assert.deepEqual(parseSpoolFile(spoolName(START, 1), text, never), parse(START));
  });

  test('a value may contain =', () => {
    const fields = start({ pwd: '/a=b' });
    const input = hookInput('SessionStart', S1, { source: 'startup' });
    delete input['cwd'];
    assert.equal(parse({ ...fields, input }).cwd, '/a=b');
  });

  test('lines are split on a newline only: a carriage return belongs to the value', () => {
    const input = hookInput('SessionStart', S1, { source: 'startup' });
    delete input['cwd'];
    const event = parse(start({ input, pwd: '/p\rentrypoint_env=sdk-cli' }));
    assert.equal(event.cwd, '/p\rentrypoint_env=sdk-cli');
    assert.equal(event.entrypointEnv, 'cli');
    assert.equal(event.scripted, false);
  });

  test('payload is exactly what follows the -- line, trailing newline included', () => {
    const event = parse(START);
    assert.equal(event.payload, `${JSON.stringify(START.input)}\n`);
    const spaced = `  ${JSON.stringify(START.input)}\n\n`;
    assert.equal(parse(start({ input: spaced })).payload, spaced);
  });

  test('a payload without a trailing newline is kept as it is', () => {
    const text = JSON.stringify(START.input);
    assert.equal(parse(start({ input: text })).payload, text);
  });

  test('keys missing from the file other than v, event, time_ns and boot_id mean unknown', () => {
    let text = spoolText(START);
    for (const key of ['claude_pid', 'session_env', 'entrypoint_env', 'stat', 'pwd', 'argv_b64']) {
      text = withoutKey(text, key);
    }
    const event = parseSpoolFile(spoolName(START, 1), text, never);
    assert.equal(event.pid, 0);
    assert.equal(event.procStart, null);
    assert.equal(event.entrypointEnv, null);
    assert.equal(event.argv, null);
    assert.equal(event.cwd, '/home/dev/projects/demo');
    assert.equal(event.sessionId, S1);
  });

  test('a file that has -- as its last line and nothing after it has no hook input', () => {
    const text = spoolText(START).split('\n--\n')[0] + '\n--';
    assert.throws(() => parseSpoolFile(spoolName(START, 1), text, never), SpoolParseError);
  });
});

describe('parseSpoolFile: files that cannot be parsed', () => {
  const good = spoolText(START);
  const parseText = (text: string, name: string = spoolName(START, 1)): SpoolEvent =>
    parseSpoolFile(name, text, never);

  const bad: Array<[string, () => unknown]> = [
    ['a file name that is not <digits>-<digits>-<digits>.ev', () => parseText(good, 'x.ev')],
    ['a name with a temporary prefix', () => parseText(good, `.${spoolName(START, 1)}.tmp`)],
    ['a name with two parts', () => parseText(good, '1-2.ev')],
    ['a name with a fourth part', () => parseText(good, '1-2-3-4.ev')],
    ['a name with another extension', () => parseText(good, '1-2-3.evx')],
    ['a name with a sign', () => parseText(good, '1--2-3.ev')],
    ['no -- line', () => parseText(good.replace('\n--\n', '\n'))],
    ['a -- line with a carriage return', () => parseText(good.replace('\n--\n', '\n--\r\n'))],
    ['an empty file', () => parseText('')],
    ['v=2', () => parseText(good.replace('v=1\n', 'v=2\n'))],
    ['v=1 with a carriage return', () => parseText(good.replace('v=1\n', 'v=1\r\n'))],
    ['event=Stop', () => parseText(good.replace('event=SessionStart', 'event=Stop'))],
    ['an empty event', () => parseText(good.replace('event=SessionStart', 'event='))],
    [
      'event=sessionstart',
      () => parseText(good.replace('event=SessionStart', 'event=sessionstart')),
    ],
    ['time_ns=abc', () => parseText(good.replace(/time_ns=\d+/, 'time_ns=abc'))],
    ['an empty time_ns', () => parseText(good.replace(/time_ns=\d+/, 'time_ns='))],
    ['a negative time_ns', () => parseText(good.replace(/time_ns=\d+/, 'time_ns=-5'))],
    [
      'a time_ns too large for the database',
      () => parseText(good.replace(/time_ns=\d+/, 'time_ns=9223372036854775808')),
    ],
    ['an empty boot_id', () => parseText(withReplacedLine(good, 'boot_id', 'boot_id='))],
    ['claude_pid=abc', () => parseText(withReplacedLine(good, 'claude_pid', 'claude_pid=abc'))],
    [
      'a negative claude_pid',
      () => parseText(withReplacedLine(good, 'claude_pid', 'claude_pid=-1')),
    ],
    [
      'a claude_pid that is not a safe integer',
      () => parseText(withReplacedLine(good, 'claude_pid', 'claude_pid=99999999999999999999')),
    ],
    [
      'argv_b64 that is not base64',
      () => parseText(withReplacedLine(good, 'argv_b64', 'argv_b64=not base64!')),
    ],
    [
      'argv_b64 of the wrong length',
      () => parseText(withReplacedLine(good, 'argv_b64', 'argv_b64=Y2xhdWRlAA')),
    ],
    [
      'input that is not JSON',
      () => parseSpoolFile(spoolName(START, 1), spoolText(start({ input: 'not json' })), never),
    ],
    [
      'input that is a JSON array',
      () => parseSpoolFile(spoolName(START, 1), spoolText(start({ input: '[1]' })), never),
    ],
    [
      'input that is JSON null',
      () => parseSpoolFile(spoolName(START, 1), spoolText(start({ input: 'null' })), never),
    ],
    [
      'input that is a JSON string',
      () => parseSpoolFile(spoolName(START, 1), spoolText(start({ input: '"x"' })), never),
    ],
    [
      'no input at all',
      () => parseSpoolFile(spoolName(START, 1), spoolText(start({ input: '' })), never),
    ],
    ['a line without = before --', () => parseText(withLine(good, 'garbage'))],
    ['an empty line before --', () => parseText(withLine(good, ''))],
    ['a missing v line', () => parseText(withoutKey(good, 'v'))],
    ['a missing event line', () => parseText(withoutKey(good, 'event'))],
    ['a missing time_ns line', () => parseText(withoutKey(good, 'time_ns'))],
    ['a missing boot_id line', () => parseText(withoutKey(good, 'boot_id'))],
    ['pwd twice', () => parseText(withLine(withLine(good, 'pwd=/a'), 'pwd=/b'))],
    [
      'pwd twice with the same value',
      () => parseText(withLine(good, 'pwd=/home/dev/projects/demo')),
    ],
    [
      'an unknown key twice',
      () => parseText(withLine(withLine(good, 'future_key=1'), 'future_key=1')),
    ],
    ['v twice', () => parseText(withLine(good, 'v=1'))],
    [
      'a key that is the name of an inherited property, twice',
      () => parseText(withLine(withLine(good, '__proto__=1'), '__proto__=2')),
    ],
  ];
  for (const [why, run] of bad) {
    test(`${why} is a SpoolParseError`, () => {
      assert.throws(run, (error: unknown) => error instanceof SpoolParseError);
    });
  }

  test('a key in the hook input is not a key of the file', () => {
    // A `pwd=/a` line AFTER the -- line is part of the payload, which is not JSON then.
    const text = `${good}pwd=/a\n`;
    assert.throws(() => parseText(text), SpoolParseError);
  });

  test('SpoolParseError can be made without a message, as `class … extends Error {}` can', () => {
    const error = new SpoolParseError();
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'SpoolParseError');
    assert.equal(error.message, '');
  });

  test('SpoolParseError is an Error with a message that says what is wrong', () => {
    try {
      parseText(good.replace('v=1\n', 'v=2\n'));
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof SpoolParseError);
      assert.ok(error instanceof Error);
      assert.match(error.message, /v/);
      assert.equal(error.name, 'SpoolParseError');
    }
  });
});

describe('parseSpoolFile: scripted runs', () => {
  const scripted = (fields: SpoolFields): boolean => parse(fields).scripted;
  const withCommand = (argv: readonly string[] | null, entrypointEnv: string): SpoolFields =>
    start({ argv, entrypointEnv });

  const cases: Array<[string, readonly string[] | null, string, boolean]> = [
    ['-p with no entry point', ['claude', '-p', 'hi'], '', true],
    ['--print with cli', ['claude', '--print'], 'cli', true],
    ['-c -p with cli', ['claude', '-c', '-p'], 'cli', true],
    ['-cp (a cluster) with cli', ['claude', '-cp', 'hi'], 'cli', true],
    ['-p after -- (a positional)', ['claude', '--', '-p'], 'cli', false],
    ['-p as the value of another flag', ['claude', '--model', '-p'], 'cli', false],
    ['sdk-cli', ['claude'], 'sdk-cli', true],
    ['sdk-ts', ['claude'], 'sdk-ts', true],
    ['no command, sdk-py', null, 'sdk-py', true],
    ['a plain command with cli', ['claude'], 'cli', false],
    ['a plain command with no entry point', ['claude'], '', false],
    ['no command and no entry point', null, '', false],
    ['no command, cli', null, 'cli', false],
    ['an interactive command with flags, cli', ['claude', '--model', 'opus', '-c'], 'cli', false],
  ];
  for (const [why, argv, entrypointEnv, expected] of cases) {
    test(`${why}: scripted is ${expected}`, () => {
      assert.equal(scripted(withCommand(argv, entrypointEnv)), expected);
    });
  }

  test('the answer comes from the command as recorded, not from what is stored', () => {
    assert.deepEqual(parse(withCommand(['claude', '-c', '-p'], 'cli')).argv, ['claude', '-p']);
    assert.deepEqual(parse(withCommand(['claude', '-cp', 'hi'], 'cli')).argv, ['claude']);
    assert.equal(scripted(withCommand(['claude', '-cp', 'hi'], 'cli')), true);
  });

  test('an end has no command: only the entry point decides', () => {
    assert.equal(scripted(end({ entrypointEnv: 'sdk-cli' })), true);
    assert.equal(scripted(end({ entrypointEnv: 'cli' })), false);
    assert.equal(scripted(end({ entrypointEnv: '' })), false);
    const text = withLine(
      spoolText(end({ entrypointEnv: 'cli' })),
      `argv_b64=${Buffer.from('claude\0-p\0hi\0').toString('base64')}`,
    );
    assert.equal(parseSpoolFile(spoolName(END, 1), text, never).scripted, false);
  });
});

describe('parseSpoolFile: what the real hook writes', () => {
  /** Runs bin/skydeck-hook with a sandbox environment and returns its one spool file. */
  function runHook(
    t: Parameters<typeof sandbox>[0],
    event: 'SessionStart' | 'SessionEnd',
    pid: number | null,
    input: string,
  ): { name: string; content: string } {
    const s = sandbox(t);
    s.link('sh', 'date', 'cat', 'base64', 'mkdir', 'mv');
    const result = spawnSync(hook, [event], {
      input,
      env: s.env({
        CLAUDE_CODE_SESSION_ID: S1,
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_PID: pid === null ? undefined : String(pid),
      }),
      cwd: s.root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    const spool = join(s.skydeckHome, 'state', 'spool');
    const names = readdirSync(spool);
    assert.equal(names.length, 1, JSON.stringify(names));
    const name = names[0] as string;
    return { name, content: readFileSync(join(spool, name), 'utf8') };
  }

  const bootId = (): string => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

  test('a start without CLAUDE_PID: pid 0, no process start, no command', (t) => {
    const input = `${JSON.stringify(hookInput('SessionStart', S1, { source: 'startup' }))}\n`;
    const { name, content } = runHook(t, 'SessionStart', null, input);
    const event = parseSpoolFile(name, content, never);
    assert.equal(event.spoolName, name);
    assert.equal(event.kind, 'start');
    assert.equal(event.detail, 'startup');
    assert.equal(event.sessionId, S1);
    assert.equal(event.bootId, bootId());
    assert.equal(event.pid, 0);
    assert.equal(event.procStart, null);
    assert.equal(event.argv, null);
    assert.equal(event.entrypointEnv, 'cli');
    assert.equal(event.scripted, false);
    assert.equal(event.payload, input);
  });

  test('a start of a real process: its pid, field 22 of its stat and a command', (t) => {
    const input = `${JSON.stringify(hookInput('SessionStart', S1, { source: 'resume' }))}\n`;
    const { name, content } = runHook(t, 'SessionStart', process.pid, input);
    const event = parseSpoolFile(name, content, never);
    assert.equal(event.pid, process.pid);
    assert.equal(
      event.procStart,
      procStartFromStat(readFileSync(`/proc/${process.pid}/stat`, 'utf8')),
    );
    assert.notEqual(event.procStart, null);
    assert.ok(Array.isArray(event.argv));
    assert.equal(event.detail, 'resume');
    assert.equal(event.payload, input);
  });

  test('an end has no command and the input arrives unchanged', (t) => {
    const input = `${JSON.stringify(hookInput('SessionEnd', S1, { reason: 'logout' }))}\n`;
    const { name, content } = runHook(t, 'SessionEnd', process.pid, input);
    const event = parseSpoolFile(name, content, never);
    assert.equal(event.kind, 'end');
    assert.equal(event.detail, 'exit');
    assert.equal(event.argv, null);
    assert.equal(event.payload, input);
  });
});
