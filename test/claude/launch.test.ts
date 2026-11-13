import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  absolutizePathFlags,
  buildNewCommand,
  buildResumeCommand,
  FLAGS,
  isPrintRun,
  parseLaunchArgs,
  storableArgv,
  unknownFlags,
} from '../../src/claude/launch.ts';
import type { ParsedArg } from '../../src/claude/launch.ts';

const allNames = FLAGS.flatMap((spec) => spec.names);
const namesWhere = (predicate: (spec: (typeof FLAGS)[number]) => boolean): string[] =>
  FLAGS.filter(predicate)
    .flatMap((spec) => spec.names)
    .sort();

// --- the flag table ------------------------------------------------------------------------------

test('every flag name starts with - and appears once in the table', () => {
  for (const name of allNames) {
    assert.ok(name.startsWith('-'), name);
  }
  assert.equal(new Set(allNames).size, allNames.length);
});

/** Claude Code 2.1.323's own option table: every spelling of every root flag, with its shape. */
const claudeFlags = JSON.parse(
  readFileSync(new URL('../fixtures/claude/flags-2.1.323.json', import.meta.url), 'utf8'),
) as Record<string, string>;

test('FLAGS covers every flag Claude Code 2.1.323 declares, with the same shape', () => {
  const shapeOf = new Map(FLAGS.flatMap((spec) => spec.names.map((name) => [name, spec.shape])));
  const missing = Object.keys(claudeFlags).filter((name) => !shapeOf.has(name));
  assert.deepEqual(missing, []);
  const differ = Object.entries(claudeFlags).filter(([name, shape]) => shapeOf.get(name) !== shape);
  assert.deepEqual(differ, []);
});

test('FLAGS names no flag that Claude Code 2.1.323 does not declare', () => {
  assert.deepEqual(
    allNames.filter((name) => !(name in claudeFlags)),
    [],
  );
});

test('the fixture holds only names and the four shapes', () => {
  assert.ok(Object.keys(claudeFlags).length > 150);
  for (const [name, shape] of Object.entries(claudeFlags)) {
    assert.ok(name.startsWith('-'), name);
    assert.ok(['none', 'one', 'optional', 'many'].includes(shape), `${name}: ${shape}`);
  }
});

test('every spec has at least one name and a known shape', () => {
  for (const spec of FLAGS) {
    assert.ok(spec.names.length > 0);
    assert.ok(['none', 'one', 'optional', 'many'].includes(spec.shape), spec.names.join());
  }
});

test('the path flags are exactly the ones that take a file or a directory', () => {
  assert.deepEqual(
    namesWhere((spec) => spec.path),
    [
      '--add-dir',
      '--append-subagent-system-prompt-file',
      '--append-system-prompt-file',
      '--mcp-config',
      '--plugin-dir',
      '--plugin-dir-no-mcp',
      '--settings',
      '--system-prompt-file',
    ],
  );
});

test('the flags removed at resume are exactly the ones in the design (7.6, D28)', () => {
  assert.deepEqual(
    namesWhere((spec) => spec.remove),
    [
      // which session is opened, and its name
      '-r',
      '--resume',
      '-c',
      '--continue',
      '--session-id',
      '--fork-session',
      '-n',
      '--name',
      '-w',
      '--worktree',
      '--tmux',
      '--bg',
      '--background',
      '--from-pr',
      // where it runs
      '--teleport',
      '--cloud',
      '--remote',
      '--desktop',
      '--environment',
      '--pool',
      // deep-link launches carry prompt text (principle 4)
      '--deep-link-origin',
      '--deep-link-repo',
      '--deep-link-last-fetch',
      '--deep-link-cwd-b64',
      '--prefill',
      '--prefill-b64',
      // they choose a session or act once
      '--rewind-files',
      '--resume-session-at',
      '--resume-drops-turn',
      '--reply-on-resume',
      '--attach-serve',
      '--session-began-as-copy',
      '--init-only',
      '--handle-uri',
      // they only work with the cloud flags above, which are removed
      '--ref',
      '--on-branch',
      '--correlation-id',
      '--forward-home-settings',
      // one-time actions
      '--init',
      '--maintenance',
    ].sort(),
  );
});

test('the removed flags that Claude Code hides (deep link, aliases) have the shapes its parser gives them', () => {
  const shapeOf = (name: string) => FLAGS.find((spec) => spec.names.includes(name))?.shape;
  const expected: [string, string][] = [
    ['--deep-link-origin', 'none'],
    ['--deep-link-repo', 'one'],
    ['--deep-link-last-fetch', 'one'],
    ['--deep-link-cwd-b64', 'one'],
    ['--prefill', 'one'],
    ['--prefill-b64', 'one'],
    ['--remote', 'optional'],
    ['--environment', 'one'],
    ['--pool', 'one'],
    ['--tmux', 'none'],
    ['--rewind-files', 'one'],
    ['--resume-session-at', 'one'],
    ['--resume-drops-turn', 'one'],
    ['--reply-on-resume', 'none'],
    ['--attach-serve', 'one'],
    ['--session-began-as-copy', 'one'],
    ['--init-only', 'none'],
    ['--handle-uri', 'one'],
    ['--ref', 'one'],
    ['--on-branch', 'one'],
    ['--correlation-id', 'one'],
    ['--forward-home-settings', 'one'],
    ['--init', 'none'],
    ['--maintenance', 'none'],
    ['--channels', 'many'],
    ['--dangerously-load-development-channels', 'many'],
    ['--enable-auto-mode', 'none'],
    ['-d2e', 'none'],
  ];
  for (const [name, shape] of expected) {
    assert.equal(shapeOf(name), shape, name);
  }
});

test('--remote and --pool are the same flags as --cloud and --environment', () => {
  const specOf = (name: string) => FLAGS.find((spec) => spec.names.includes(name));
  assert.equal(specOf('--remote'), specOf('--cloud'));
  assert.equal(specOf('--pool'), specOf('--environment'));
});

test('the flags kept at resume include --remote-control and the permission flags', () => {
  const kept = new Set(namesWhere((spec) => !spec.remove));
  for (const name of [
    '--remote-control',
    '--permission-mode',
    '--dangerously-skip-permissions',
    '--model',
  ]) {
    assert.ok(kept.has(name), name);
  }
});

// --- parseLaunchArgs -----------------------------------------------------------------------------

/** Compact view of a parse: F = known flag, U = unknown flag, P = positional. */
function view(items: ParsedArg[]): string[] {
  return items.map((item) => {
    if (item.kind === 'positional') return `P${JSON.stringify(item.tokens)}`;
    const values = JSON.stringify(item.values);
    return `${item.spec === null ? 'U' : 'F'}${JSON.stringify(item.tokens)} values ${values}`;
  });
}

function parse(args: string[]): string[] {
  const items = parseLaunchArgs(args);
  assert.deepEqual(
    items.flatMap((item) => item.tokens),
    args,
    'the tokens give back the input',
  );
  return view(items);
}

test('parseLaunchArgs: a one-value flag takes the next token', () => {
  assert.deepEqual(parse(['--model', 'opus']), ['F["--model","opus"] values ["opus"]']);
});

test('parseLaunchArgs: --flag=value is one token and consumes nothing more', () => {
  assert.deepEqual(parse(['--model=opus']), ['F["--model=opus"] values ["opus"]']);
  assert.deepEqual(parse(['--model=opus', 'x']), ['F["--model=opus"] values ["opus"]', 'P["x"]']);
  assert.deepEqual(parse(['--add-dir=a', 'b']), ['F["--add-dir=a"] values ["a"]', 'P["b"]']);
});

test('parseLaunchArgs: --flag=value keeps everything after the first =', () => {
  assert.deepEqual(parse(['--system-prompt=a=b']), ['F["--system-prompt=a=b"] values ["a=b"]']);
  assert.deepEqual(parse(['--system-prompt=']), ['F["--system-prompt="] values [""]']);
});

test('parseLaunchArgs: --flag=value names the flag, known or not', () => {
  const [known] = parseLaunchArgs(['--model=opus']);
  assert.ok(known && known.kind === 'flag');
  assert.equal(known.name, '--model');
  assert.notEqual(known.spec, null);
  const [unknown] = parseLaunchArgs(['--frob=1']);
  assert.ok(unknown && unknown.kind === 'flag');
  assert.equal(unknown.name, '--frob');
  assert.equal(unknown.spec, null);
  assert.deepEqual(unknown.values, ['1']);
});

// A short flag is read letter by letter, as Claude Code's own parser (commander) reads it.

test('parseLaunchArgs: a value-taking short flag takes the rest of its token as its value', () => {
  assert.deepEqual(parse(['-rabc']), ['F["-rabc"] values ["abc"]']);
  assert.deepEqual(parse(['-nfoo']), ['F["-nfoo"] values ["foo"]']);
  assert.deepEqual(parse(['-dv']), ['F["-dv"] values ["v"]']);
});

test('parseLaunchArgs: a short flag glued to its value takes nothing more', () => {
  assert.deepEqual(parse(['-wfeat', 'fix the bug']), [
    'F["-wfeat"] values ["feat"]',
    'P["fix the bug"]',
  ]);
  assert.deepEqual(parse(['-nfoo', 'bar']), ['F["-nfoo"] values ["foo"]', 'P["bar"]']);
});

test('parseLaunchArgs: the glued value of a short flag includes an =', () => {
  assert.deepEqual(parse(['-n=x', 'y']), ['F["-n=x"] values ["=x"]', 'P["y"]']);
});

test('parseLaunchArgs: a cluster of no-value short flags is one flag token', () => {
  assert.deepEqual(parse(['-cp', 'x']), ['F["-cp"] values []', 'P["x"]']);
  assert.deepEqual(parse(['-hv']), ['F["-hv"] values []']);
});

test('parseLaunchArgs: a cluster ending in a value flag takes the value as the flag would', () => {
  assert.deepEqual(parse(['-cn', 'foo']), ['F["-cn","foo"] values ["foo"]']);
  assert.deepEqual(parse(['-cnfoo', 'x']), ['F["-cnfoo"] values ["foo"]', 'P["x"]']);
  assert.deepEqual(parse(['-cd', 'x']), ['F["-cd","x"] values ["x"]']);
  assert.deepEqual(parse(['-cd', '--model', 'm']), [
    'F["-cd"] values []',
    'F["--model","m"] values ["m"]',
  ]);
});

test('parseLaunchArgs: a short token with an unknown letter is an unknown flag as a whole', () => {
  assert.deepEqual(parse(['-cZ', 'x']), ['U["-cZ","x"] values ["x"]']);
  assert.deepEqual(parse(['-Zabc', 'x']), ['U["-Zabc","x"] values ["x"]']);
  assert.deepEqual(parse(['-Z']), ['U["-Z"] values []']);
});

test('parseLaunchArgs: a token with an unknown letter is named by that letter alone', () => {
  const name = (arg: string) => {
    const [item] = parseLaunchArgs([arg]);
    assert.ok(item && item.kind === 'flag', arg);
    assert.equal(item.spec, null, arg);
    return item.name;
  };
  assert.equal(name('-Z'), '-Z');
  assert.equal(name('-Zabc'), '-Z');
  assert.equal(name('-cZ'), '-Z');
  assert.equal(name('-cZfix it'), '-Z');
  assert.equal(name('-pvQ'), '-Q');
  assert.equal(name('--frob'), '--frob');
  assert.equal(name('--frob=x'), '--frob');
});

test('parseLaunchArgs: a short flag cluster is named without its glued value', () => {
  const name = (arg: string) => {
    const [item] = parseLaunchArgs([arg]);
    assert.ok(item && item.kind === 'flag', arg);
    return item.name;
  };
  assert.equal(name('-rabc'), '-r');
  assert.equal(name('-cnfoo'), '-cn');
  assert.equal(name('-cp'), '-cp');
  assert.equal(name('-n=x'), '-n');
});

test('parseLaunchArgs: a cluster counts as removable when any letter in it is', () => {
  const removable = (arg: string) => {
    const [item] = parseLaunchArgs([arg]);
    assert.ok(item && item.kind === 'flag', arg);
    return item.spec?.remove;
  };
  assert.equal(removable('-pc'), true);
  assert.equal(removable('-cp'), true);
  assert.equal(removable('-rabc'), true);
  assert.equal(removable('-pv'), false);
  assert.equal(removable('-dv'), false);
});

// After a short flag that takes no value, Claude Code's parser reads the rest of the token as a new
// token, prefixed with one more '-': `-c-model` is `-c --model`, `-c-` is `-c --`.

test('parseLaunchArgs: a - after a no-value short flag starts a long flag in the same token', () => {
  assert.deepEqual(parse(['-c-model', 'opus']), ['F["-c-model","opus"] values ["opus"]']);
  assert.deepEqual(parse(['-c-model=opus', 'x']), ['F["-c-model=opus"] values ["opus"]', 'P["x"]']);
  assert.deepEqual(parse(['-cp-model', 'opus']), ['F["-cp-model","opus"] values ["opus"]']);
  assert.deepEqual(parse(['-c-verbose', 'x']), ['F["-c-verbose"] values []', 'P["x"]']);
});

test('parseLaunchArgs: -c- is -c followed by the end of the flags', () => {
  assert.deepEqual(parse(['-c-', '--model', 'opus']), [
    'F["-c-"] values []',
    'P["--model"]',
    'P["opus"]',
  ]);
  assert.deepEqual(parse(['-p-', 'x']), ['F["-p-"] values []', 'P["x"]']);
  assert.deepEqual(parse(['-cp-', '-x']), ['F["-cp-"] values []', 'P["-x"]']);
  assert.deepEqual(parse(['--model', 'opus', '-c-']), [
    'F["--model","opus"] values ["opus"]',
    'F["-c-"] values []',
  ]);
});

test('parseLaunchArgs: a long flag after a - that is in no table makes the token unknown, by that flag', () => {
  assert.deepEqual(parse(['-c-frob', 'x']), ['U["-c-frob","x"] values ["x"]']);
  assert.deepEqual(parse(['-c-frob=1', 'x']), ['U["-c-frob=1"] values ["1"]', 'P["x"]']);
  assert.deepEqual(parse(['-c-pv']), ['U["-c-pv"] values []']);
  const [item] = parseLaunchArgs(['-c-frob=1']);
  assert.ok(item && item.kind === 'flag');
  assert.equal(item.name, '--frob');
  assert.equal(item.spec, null);
});

test('parseLaunchArgs: a - inside the value of a value-taking short flag stays in the value', () => {
  assert.deepEqual(parse(['-n-foo', 'x']), ['F["-n-foo"] values ["-foo"]', 'P["x"]']);
});

test('parseLaunchArgs: a cluster with a long flag is removable when one of its flags is', () => {
  const spec = (arg: string) => {
    const [item] = parseLaunchArgs([arg]);
    assert.ok(item && item.kind === 'flag', arg);
    return item.spec;
  };
  assert.equal(spec('-c-model')?.remove, true);
  assert.equal(spec('-p-model')?.remove, false);
  assert.equal(spec('-p-')?.remove, false);
  assert.equal(spec('-c-')?.remove, true);
});

test('parseLaunchArgs: a lone - is a value, not a flag', () => {
  assert.deepEqual(parse(['-']), ['P["-"]']);
  assert.deepEqual(parse(['--add-dir', 'a', '-', '--verbose']), [
    'F["--add-dir","a","-"] values ["a","-"]',
    'F["--verbose"] values []',
  ]);
  assert.deepEqual(parse(['-r', '-']), ['F["-r","-"] values ["-"]']);
  assert.deepEqual(parse(['--frob', '-']), ['U["--frob","-"] values ["-"]']);
});

test('parseLaunchArgs: a no-value flag takes nothing', () => {
  assert.deepEqual(parse(['-c']), ['F["-c"] values []']);
  assert.deepEqual(parse(['-c', 'hello']), ['F["-c"] values []', 'P["hello"]']);
});

test('parseLaunchArgs: a several-value flag takes every token up to the next flag', () => {
  assert.deepEqual(parse(['--add-dir', 'a', 'b', '--verbose']), [
    'F["--add-dir","a","b"] values ["a","b"]',
    'F["--verbose"] values []',
  ]);
});

test('parseLaunchArgs: a several-value flag takes its first value whatever it is', () => {
  assert.deepEqual(parse(['--add-dir', '-x', 'b', '--verbose']), [
    'F["--add-dir","-x","b"] values ["-x","b"]',
    'F["--verbose"] values []',
  ]);
  assert.deepEqual(parse(['--add-dir', '--model', 'opus']), [
    'F["--add-dir","--model","opus"] values ["--model","opus"]',
  ]);
  assert.deepEqual(parse(['--tools', '--', 'x']), ['F["--tools","--","x"] values ["--","x"]']);
});

test('parseLaunchArgs: a several-value flag stops at a flag from its second value on', () => {
  assert.deepEqual(parse(['--add-dir', 'a', '-x', 'b']), [
    'F["--add-dir","a"] values ["a"]',
    'U["-x","b"] values ["b"]',
  ]);
});

test('parseLaunchArgs: a several-value flag at the end has no value', () => {
  assert.deepEqual(parse(['--add-dir']), ['F["--add-dir"] values []']);
});

test('parseLaunchArgs: a several-value flag also takes a trailing prompt (D18)', () => {
  assert.deepEqual(parse(['--add-dir', 'a', 'hello']), [
    'F["--add-dir","a","hello"] values ["a","hello"]',
  ]);
});

test('parseLaunchArgs: an optional-value flag takes the next token unless it starts with -', () => {
  assert.deepEqual(parse(['-r']), ['F["-r"] values []']);
  assert.deepEqual(parse(['-r', 'abc']), ['F["-r","abc"] values ["abc"]']);
  assert.deepEqual(parse(['-r', '--model', 'x']), [
    'F["-r"] values []',
    'F["--model","x"] values ["x"]',
  ]);
});

test('parseLaunchArgs: an unknown flag takes the next token unless it starts with -', () => {
  assert.deepEqual(parse(['--frob', 'x', 'y']), ['U["--frob","x"] values ["x"]', 'P["y"]']);
  assert.deepEqual(parse(['--frob', '--model', 'x']), [
    'U["--frob"] values []',
    'F["--model","x"] values ["x"]',
  ]);
  assert.deepEqual(parse(['-Z', 'x']), ['U["-Z","x"] values ["x"]']);
});

test('parseLaunchArgs: -- and everything after it are positionals', () => {
  assert.deepEqual(parse(['--', '-p', 'x']), ['P["--"]', 'P["-p"]', 'P["x"]']);
  assert.deepEqual(parse(['--model', 'opus', '--', '--model']), [
    'F["--model","opus"] values ["opus"]',
    'P["--"]',
    'P["--model"]',
  ]);
});

test('parseLaunchArgs: a bare token is a positional, spaces and all', () => {
  assert.deepEqual(parse(['hello world']), ['P["hello world"]']);
});

test('parseLaunchArgs: a one-value flag at the end has no value', () => {
  assert.deepEqual(parse(['--model']), ['F["--model"] values []']);
});

test('parseLaunchArgs: a one-value flag takes the next token whatever it is', () => {
  assert.deepEqual(parse(['--max-budget-usd', '-1']), ['F["--max-budget-usd","-1"] values ["-1"]']);
  assert.deepEqual(parse(['--system-prompt', '--', 'x']), [
    'F["--system-prompt","--"] values ["--"]',
    'P["x"]',
  ]);
});

test('parseLaunchArgs: an empty argument list gives nothing', () => {
  assert.deepEqual(parseLaunchArgs([]), []);
});

test('parseLaunchArgs: every spelling of every flag resolves to its own spec', () => {
  for (const spec of FLAGS) {
    for (const name of spec.names) {
      const [item] = parseLaunchArgs([name]);
      assert.ok(item && item.kind === 'flag', name);
      assert.equal(item.spec, spec, name);
      assert.equal(item.name, name);
    }
  }
});

// --- absolutizePathFlags -------------------------------------------------------------------------

const existing =
  (...paths: string[]) =>
  (path: string): boolean =>
    paths.includes(path);

test('absolutizePathFlags makes an existing relative value absolute', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--mcp-config', 'mcp.json'], '/p', existing('/p/mcp.json')),
    ['claude', '--mcp-config', '/p/mcp.json'],
  );
});

test('absolutizePathFlags leaves a value that does not exist', () => {
  assert.deepEqual(absolutizePathFlags(['claude', '--mcp-config', 'mcp.json'], '/p', existing()), [
    'claude',
    '--mcp-config',
    'mcp.json',
  ]);
});

test('absolutizePathFlags leaves an absolute value', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--mcp-config', '/abs.json'], '/p', existing('/abs.json')),
    ['claude', '--mcp-config', '/abs.json'],
  );
});

test('absolutizePathFlags rewrites the = form to --flag=<absolute>', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--settings=s.json'], '/p', existing('/p/s.json')),
    ['claude', '--settings=/p/s.json'],
  );
  assert.deepEqual(absolutizePathFlags(['claude', '--settings=s.json'], '/p', existing()), [
    'claude',
    '--settings=s.json',
  ]);
});

test('absolutizePathFlags resolves .. and . segments against the working directory', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--add-dir', '../lib', 'x'], '/p/q', existing('/p/lib')),
    ['claude', '--add-dir', '/p/lib', 'x'],
  );
  assert.deepEqual(
    absolutizePathFlags(['claude', '--plugin-dir', './plug'], '/p', existing('/p/plug')),
    ['claude', '--plugin-dir', '/p/plug'],
  );
});

test('absolutizePathFlags rewrites the file-valued flags Claude Code hides from --help', () => {
  const argv = [
    'claude',
    '--system-prompt-file',
    'sys.md',
    '--append-system-prompt-file=app.md',
    '--plugin-dir-no-mcp',
    'plug',
    '--append-subagent-system-prompt-file',
    'sub.md',
  ];
  assert.deepEqual(
    absolutizePathFlags(argv, '/p', () => true),
    [
      'claude',
      '--system-prompt-file',
      '/p/sys.md',
      '--append-system-prompt-file=/p/app.md',
      '--plugin-dir-no-mcp',
      '/p/plug',
      '--append-subagent-system-prompt-file',
      '/p/sub.md',
    ],
  );
});

test('absolutizePathFlags decides each value of a several-value flag on its own', () => {
  assert.deepEqual(
    absolutizePathFlags(
      ['claude', '--add-dir', 'a', 'missing', 'b', '--model', 'opus'],
      '/p',
      existing('/p/a', '/p/b'),
    ),
    ['claude', '--add-dir', '/p/a', 'missing', '/p/b', '--model', 'opus'],
  );
});

test('absolutizePathFlags does not touch the values of other flags', () => {
  assert.deepEqual(absolutizePathFlags(['claude', '--model', 'opus'], '/p', existing('/p/opus')), [
    'claude',
    '--model',
    'opus',
  ]);
  assert.deepEqual(
    absolutizePathFlags(['claude', '--frob', 'opus', 'opus'], '/p', existing('/p/opus')),
    ['claude', '--frob', 'opus', 'opus'],
  );
});

test('absolutizePathFlags does not touch positionals after --', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--', '--add-dir', 'a'], '/p', existing('/p/a')),
    ['claude', '--', '--add-dir', 'a'],
  );
});

test('absolutizePathFlags never treats the program name as a flag value', () => {
  assert.deepEqual(
    absolutizePathFlags(['bin/claude', '--verbose'], '/p', existing('/p/bin/claude')),
    ['bin/claude', '--verbose'],
  );
});

test('absolutizePathFlags leaves everything alone when cwd is null', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--mcp-config', 'm.json'], null, existing('/p/m.json')),
    ['claude', '--mcp-config', 'm.json'],
  );
});

test('absolutizePathFlags leaves everything alone when cwd is not absolute', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--add-dir', 'a'], 'p', () => true),
    ['claude', '--add-dir', 'a'],
  );
});

test('absolutizePathFlags leaves an empty value alone', () => {
  assert.deepEqual(
    absolutizePathFlags(['claude', '--add-dir', ''], '/p', () => true),
    ['claude', '--add-dir', ''],
  );
  assert.deepEqual(
    absolutizePathFlags(['claude', '--add-dir='], '/p', () => true),
    ['claude', '--add-dir='],
  );
});

test('absolutizePathFlags asks about the resolved path and returns a new array', () => {
  const asked: string[] = [];
  const argv = ['claude', '--add-dir', 'a'];
  const result = absolutizePathFlags(argv, '/p', (path) => {
    asked.push(path);
    return false;
  });
  assert.deepEqual(asked, ['/p/a']);
  assert.deepEqual(result, argv);
  assert.notEqual(result, argv);
});

// --- buildResumeCommand --------------------------------------------------------------------------

const S1 = '11111111-2222-3333-4444-555555555555';
const R = ['claude', '--resume', S1];

function resume(launch: string[] | null, label: string | null = null, claudeCommand = 'claude') {
  return buildResumeCommand({ claudeCommand, launch, sessionId: S1, label });
}

test('buildResumeCommand keeps the other flags, drops the program name', () => {
  assert.deepEqual(resume(['/usr/local/bin/claude', '--model', 'opus']), {
    argv: [...R, '--model', 'opus'],
    flagsKnown: true,
  });
});

test('buildResumeCommand passes a label as -n right after the session id', () => {
  assert.deepEqual(resume(['/usr/local/bin/claude', '--model', 'opus'], 'fix retry').argv, [
    ...R,
    '-n',
    'fix retry',
    '--model',
    'opus',
  ]);
});

test('buildResumeCommand takes the program from claudeCommand', () => {
  assert.deepEqual(resume(['claude'], null, '/opt/claude').argv, ['/opt/claude', '--resume', S1]);
});

test('buildResumeCommand treats an empty label as no label', () => {
  assert.deepEqual(resume(['claude', '--model', 'opus'], '').argv, [...R, '--model', 'opus']);
});

test('buildResumeCommand removes the flags that choose or name the session', () => {
  const cases: [string[], string[]][] = [
    [
      ['claude', '--resume', 'old', '--model', 'opus'],
      [...R, '--model', 'opus'],
    ],
    [['claude', '-r'], R],
    [
      ['claude', '-c', '--verbose'],
      [...R, '--verbose'],
    ],
    [['claude', '--session-id', 'x', '--fork-session'], R],
    [['claude', '-n', 'old name', '--name=other'], R],
    [['claude', '-w', 'feature', '--bg', '--from-pr', '123'], R],
    [
      ['claude', '-w', '--model', 'opus'],
      [...R, '--model', 'opus'],
    ],
    [
      ['claude', '--model=opus', '--resume=abc'],
      [...R, '--model=opus'],
    ],
    [['claude', '--continue', '--worktree', 'w', '--background', '--resume=x', '--name', 'n'], R],
  ];
  for (const [launch, expected] of cases) {
    assert.deepEqual(resume(launch).argv, expected, launch.join(' '));
  }
});

test('buildResumeCommand removes the flags that say where a session runs (D28)', () => {
  assert.deepEqual(
    resume(['claude', '--teleport', 'abc', '--cloud', '--desktop', '--remote-control', 'rc']).argv,
    [...R, '--remote-control', 'rc'],
  );
  assert.deepEqual(resume(['claude', '--cloud', 'env1', '--model', 'opus']).argv, [
    ...R,
    '--model',
    'opus',
  ]);
});

test('buildResumeCommand keeps permission flags as recorded and never adds one', () => {
  assert.deepEqual(
    resume(['claude', '--dangerously-skip-permissions', '--permission-mode', 'plan']).argv,
    [...R, '--dangerously-skip-permissions', '--permission-mode', 'plan'],
  );
  assert.deepEqual(resume(['claude']).argv, R);
  assert.deepEqual(resume(null).argv, R);
  assert.deepEqual(
    resume(['claude', '--model', 'opus'], 'x').argv.filter((t) => /permission/.test(t)),
    [],
  );
});

test('buildResumeCommand keeps the path flags and their values', () => {
  const kept = ['--mcp-config', '/a.json', '/b.json', '--add-dir', '/x', '--settings', '/s.json'];
  assert.deepEqual(resume(['claude', ...kept]).argv, [...R, ...kept]);
});

test('buildResumeCommand drops positionals (an initial prompt)', () => {
  assert.deepEqual(resume(['claude', 'fix the bug']).argv, R);
  assert.deepEqual(resume(['claude', '--add-dir', '/x', '--model', 'opus', 'fix it']).argv, [
    ...R,
    '--add-dir',
    '/x',
    '--model',
    'opus',
  ]);
  assert.deepEqual(resume(['claude', '--', '-p']).argv, R);
});

test('buildResumeCommand keeps what a several-value flag takes, a first value starting with - included', () => {
  assert.deepEqual(resume(['claude', '--add-dir', '-scratch', 'b', '--model', 'opus']).argv, [
    ...R,
    '--add-dir',
    '-scratch',
    'b',
    '--model',
    'opus',
  ]);
  // Claude Code reads --resume here as a directory, and so does skydeck
  assert.deepEqual(resume(['claude', '--add-dir', '--resume', 'abc']).argv, [
    ...R,
    '--add-dir',
    '--resume',
    'abc',
  ]);
});

test('buildResumeCommand lets a several-value flag swallow a trailing prompt (D18)', () => {
  assert.deepEqual(resume(['claude', '--add-dir', '/x', 'fix it']).argv, [
    ...R,
    '--add-dir',
    '/x',
    'fix it',
  ]);
});

test('buildResumeCommand does not pass on a flag it does not know, nor what follows it', () => {
  assert.deepEqual(resume(['claude', '--frobnicate', 'v', 'prompt']).argv, R);
  assert.deepEqual(resume(['claude', '--frobnicate=v', '--model', 'opus']).argv, [
    ...R,
    '--model',
    'opus',
  ]);
  assert.deepEqual(resume(['claude', '--model', 'opus', '--frobnicate', '--verbose']).argv, [
    ...R,
    '--model',
    'opus',
    '--verbose',
  ]);
});

test('buildResumeCommand says the flags are unknown when nothing was recorded', () => {
  assert.deepEqual(resume(null), { argv: R, flagsKnown: false });
  assert.deepEqual(resume(null, 'x'), { argv: [...R, '-n', 'x'], flagsKnown: false });
});

test('buildResumeCommand handles a recorded launch with no arguments', () => {
  assert.deepEqual(resume(['claude']), { argv: R, flagsKnown: true });
  assert.deepEqual(resume([]), { argv: R, flagsKnown: true });
});

test('buildResumeCommand does not modify the recorded launch command', () => {
  const launch = ['claude', '--resume', 'old', '--model', 'opus'];
  const copy = [...launch];
  resume(launch, 'x');
  assert.deepEqual(launch, copy);
});

test('buildResumeCommand removes short flags glued to their values (-rabc, -nfoo, -wfeat)', () => {
  const cases: [string[], string[]][] = [
    [['claude', '-rabc', '--fork-session'], R],
    [
      ['claude', '-nfoo', '--model', 'opus'],
      [...R, '--model', 'opus'],
    ],
    [['claude', '-wfeat', 'fix the bug'], R],
    [
      ['claude', '--model', 'opus', '-r' + 'abc'],
      [...R, '--model', 'opus'],
    ],
    [['claude', '-n=x', 'y'], R],
  ];
  for (const [launch, expected] of cases) {
    assert.deepEqual(resume(launch).argv, expected, launch.join(' '));
  }
});

test('buildResumeCommand removes a cluster of short flags when one of them is removable', () => {
  assert.deepEqual(resume(['claude', '-cp', 'fix it']).argv, R);
  assert.deepEqual(resume(['claude', '-pc']).argv, R);
  assert.deepEqual(resume(['claude', '-cn', 'foo', '--model', 'opus']).argv, [
    ...R,
    '--model',
    'opus',
  ]);
});

test('buildResumeCommand keeps a cluster of short flags that none of the removed ones is in', () => {
  assert.deepEqual(resume(['claude', '-pv']).argv, [...R, '-pv']);
  assert.deepEqual(resume(['claude', '-dv', 'x']).argv, [...R, '-dv']);
});

test('buildResumeCommand reads a - after a no-value short flag as a new long flag', () => {
  assert.deepEqual(resume(['claude', '-c-model', 'opus', '--verbose']).argv, [...R, '--verbose']);
  assert.deepEqual(resume(['claude', '-c-', '--model', 'opus']).argv, R);
  assert.deepEqual(resume(['claude', '-p-model', 'opus']).argv, [...R, '-p-model', 'opus']);
  assert.deepEqual(resume(['claude', '-p-', 'prompt']).argv, [...R, '-p-']);
});

test('buildResumeCommand does not pass on a token with an unknown letter', () => {
  assert.deepEqual(resume(['claude', '-cZ', 'x']).argv, R);
  assert.deepEqual(resume(['claude', '-Zabc', '--verbose']).argv, [...R, '--verbose']);
});

test('buildResumeCommand treats a lone - as a value or a positional', () => {
  assert.deepEqual(resume(['claude', '--add-dir', '/x', '-']).argv, [...R, '--add-dir', '/x', '-']);
  assert.deepEqual(resume(['claude', '-']).argv, R);
});

test('buildResumeCommand removes the deep-link launch flags and what they prefill', () => {
  assert.deepEqual(
    resume([
      'claude',
      '--deep-link-origin',
      '--deep-link-repo=o/r',
      '--deep-link-last-fetch',
      '1794474000000',
      '--deep-link-cwd-b64',
      'L3A',
      '--prefill',
      'fix the bug',
      '--prefill-b64=Zml4IHRoZSBidWc',
      '--model',
      'opus',
    ]).argv,
    [...R, '--model', 'opus'],
  );
});

test('buildResumeCommand removes the flags that choose a session or act once', () => {
  assert.deepEqual(
    resume([
      'claude',
      '--rewind-files',
      'm1',
      '--resume-session-at',
      'm2',
      '--resume-drops-turn',
      'x',
      '--reply-on-resume',
      '--attach-serve',
      'a',
      '--session-began-as-copy',
      'b',
      '--init-only',
      '--handle-uri',
      'claude-cli://x',
      '--model',
      'opus',
    ]).argv,
    [...R, '--model', 'opus'],
  );
});

test('buildResumeCommand removes the flags that only work with a cloud session, and one-time actions', () => {
  assert.deepEqual(
    resume([
      'claude',
      '--cloud',
      '--ref',
      'main',
      '--on-branch',
      'b',
      '--correlation-id',
      'c',
      '--forward-home-settings',
      'h',
      '--init',
      '--maintenance',
      '--model',
      'opus',
    ]).argv,
    [...R, '--model', 'opus'],
  );
});

test('buildResumeCommand keeps the hidden flags that only configure the run, with their values', () => {
  const kept = [
    '--enable-auto-mode',
    '--channels',
    'plugin:a@x',
    'plugin:b@y',
    '--max-turns',
    '5',
    '--thinking',
    'enabled',
    '-d2e',
  ];
  assert.deepEqual(resume(['claude', ...kept, 'fix it']).argv, [...R, ...kept]);
});

test('buildResumeCommand removes the flags that move a session elsewhere, aliases included', () => {
  assert.deepEqual(
    resume([
      'claude',
      '--remote',
      'desc',
      '--environment',
      'ccpool_1',
      '--pool',
      'ccpool_2',
      '--tmux',
      '-w',
      'feat',
      '--model',
      'opus',
    ]).argv,
    [...R, '--model', 'opus'],
  );
  assert.deepEqual(resume(['claude', '--tmux=classic', '--remote=x']).argv, R);
  // --remote-control is a different flag and stays
  assert.deepEqual(resume(['claude', '--remote-control', 'rc']).argv, [
    ...R,
    '--remote-control',
    'rc',
  ]);
});

test('buildResumeCommand handles every flag of the table, in every spelling', () => {
  for (const spec of FLAGS) {
    const values: string[][] =
      spec.shape === 'none' ? [[]] : spec.shape === 'many' ? [['v'], ['v1', 'v2']] : [['v']];
    for (const name of spec.names) {
      for (const v of values) {
        const label = `${name} ${v.join(' ')}`;
        const expected = spec.remove ? R : [...R, name, ...v];
        assert.deepEqual(resume(['claude', name, ...v]).argv, expected, label);
      }
    }
  }
});

test('buildResumeCommand keeps a flag that follows a removed flag with an optional value', () => {
  for (const spec of FLAGS.filter((s) => s.remove && s.shape === 'optional')) {
    for (const name of spec.names) {
      assert.deepEqual(
        resume(['claude', name, '--model', 'opus']).argv,
        [...R, '--model', 'opus'],
        name,
      );
    }
  }
});

// --- storableArgv --------------------------------------------------------------------------------

test('storableArgv drops a positional prompt and keeps the program', () => {
  assert.deepEqual(storableArgv(['claude', 'fix the bug']), ['claude']);
  assert.deepEqual(storableArgv(['/usr/bin/claude', '--model', 'opus', 'fix the bug']), [
    '/usr/bin/claude',
    '--model',
    'opus',
  ]);
});

test('storableArgv keeps the values of one-value, optional-value and several-value flags', () => {
  const argv = ['claude', '--model', 'opus', '-d', 'api', '--add-dir', '/x', '/y', '--verbose'];
  assert.deepEqual(storableArgv(argv), argv);
});

test('storableArgv keeps --flag=value and a short flag glued to its value', () => {
  assert.deepEqual(storableArgv(['claude', '--model=opus', '-dapi', 'prompt']), [
    'claude',
    '--model=opus',
    '-dapi',
  ]);
});

test('storableArgv keeps a prompt that follows a several-value flag, as the flag value (D18)', () => {
  assert.deepEqual(storableArgv(['claude', '--add-dir', '/x', 'fix it']), [
    'claude',
    '--add-dir',
    '/x',
    'fix it',
  ]);
});

test('storableArgv keeps an unknown flag as its bare name and drops what follows it', () => {
  assert.deepEqual(storableArgv(['claude', '--frobnicate', 'v', 'prompt']), [
    'claude',
    '--frobnicate',
  ]);
  assert.deepEqual(storableArgv(['claude', '--enable-new', 'fix it and push', '--model', 'opus']), [
    'claude',
    '--enable-new',
    '--model',
    'opus',
  ]);
});

test('storableArgv reads a - after a no-value short flag as a new long flag', () => {
  // -c is removed, so the whole token goes, and what it carries with it
  assert.deepEqual(storableArgv(['claude', '-c-model', 'opus', '--verbose']), [
    'claude',
    '--verbose',
  ]);
  assert.deepEqual(storableArgv(['claude', '-c-', '--model', 'opus']), ['claude']);
  // -p is kept, with its long flag and the value that long flag takes
  assert.deepEqual(storableArgv(['claude', '-p-model', 'opus', 'prompt']), [
    'claude',
    '-p-model',
    'opus',
  ]);
  // -p- ends the flags: what follows is positional
  assert.deepEqual(storableArgv(['claude', '-p-', '--model', 'opus']), ['claude', '-p-']);
});

test('storableArgv stores a long flag that is in no table, after a -, as its bare name', () => {
  assert.deepEqual(storableArgv(['claude', '-c-frob', 'x', '--model', 'opus']), [
    'claude',
    '--frob',
    '--model',
    'opus',
  ]);
  assert.deepEqual(storableArgv(['claude', '-c-frob=secret']), ['claude', '--frob']);
});

test('storableArgv never stores the end-of-flags marker as a flag', () => {
  for (const argv of [
    ['claude', '-c-model', 'opus'],
    ['claude', '-c-', '--model', 'opus'],
    ['claude', '-p-'],
    ['claude', '-cp-'],
    ['claude', '-c-frob'],
  ]) {
    const stored = storableArgv(argv);
    assert.ok(!stored.includes('--'), argv.join(' '));
    assert.deepEqual(storableArgv(stored), stored, `stored twice: ${argv.join(' ')}`);
    assert.deepEqual(unknownFlags(stored), unknownFlags(argv), `unknown: ${argv.join(' ')}`);
    assert.deepEqual(resume(stored), resume(argv), `resume: ${argv.join(' ')}`);
  }
});

test('storableArgv does not store text written after an unknown letter', () => {
  assert.deepEqual(
    storableArgv(['claude', '-cZfix the login bug', '--model', 'opus', '-Zsecret']),
    ['claude', '-Z', '--model', 'opus', '-Z'],
  );
});

test('storableArgv drops the value of an unknown --flag=value', () => {
  assert.deepEqual(storableArgv(['claude', '--frobnicate=fix it', '--model=opus']), [
    'claude',
    '--frobnicate',
    '--model=opus',
  ]);
});

test('storableArgv keeps a token with an unknown letter as that letter alone', () => {
  assert.deepEqual(storableArgv(['claude', '-cZ', 'x', '-Zabc', 'y']), ['claude', '-Z', '-Z']);
});

test('storableArgv drops -- and everything after it', () => {
  assert.deepEqual(storableArgv(['claude', '--model', 'opus', '--', '-p', 'text']), [
    'claude',
    '--model',
    'opus',
  ]);
  assert.deepEqual(storableArgv(['claude', '--']), ['claude']);
});

test('storableArgv drops the flags a resume removes, with their values', () => {
  assert.deepEqual(
    storableArgv([
      'claude',
      '--resume',
      'abc',
      '-n',
      'my name',
      '--prefill-b64=Zml4',
      '--prefill',
      'fix the bug',
      '--deep-link-repo',
      'o/r',
      '-wfeat',
      '--model',
      'opus',
      '--cloud',
    ]),
    ['claude', '--model', 'opus'],
  );
});

test('storableArgv keeps a command that has nothing to drop as it is', () => {
  const argv = ['claude', '--model', 'opus', '--mcp-config', '/a.json', '--verbose'];
  assert.deepEqual(storableArgv(argv), argv);
  assert.deepEqual(storableArgv(['claude']), ['claude']);
});

test('storableArgv gives [] for an empty command', () => {
  assert.deepEqual(storableArgv([]), []);
});

test('storableArgv returns a new array and leaves its input alone', () => {
  const argv = ['claude', '--model', 'opus'];
  const copy = [...argv];
  const result = storableArgv(argv);
  assert.notEqual(result, argv);
  assert.deepEqual(argv, copy);
});

test('storableArgv handles every flag of the table, in every spelling', () => {
  for (const spec of FLAGS) {
    const values: string[][] =
      spec.shape === 'none' ? [[]] : spec.shape === 'many' ? [['v'], ['v1', 'v2']] : [['v']];
    for (const name of spec.names) {
      for (const v of values) {
        const argv = ['claude', name, ...v];
        assert.deepEqual(storableArgv(argv), spec.remove ? ['claude'] : argv, argv.join(' '));
      }
    }
  }
});

const LAUNCHES: string[][] = [
  ['claude'],
  ['/usr/local/bin/claude', '--model', 'opus', 'fix the bug'],
  ['claude', '--resume', 'old', '--model', 'opus'],
  ['claude', '-rabc', '--fork-session', '--verbose'],
  ['claude', '-w', 'feature', '--bg', '--from-pr', '123', 'prompt'],
  ['claude', '--teleport', 'abc', '--cloud', '--desktop', '--remote-control', 'rc'],
  ['claude', '--add-dir', '/x', '--model', 'opus', 'fix it'],
  ['claude', '--add-dir', '/x', 'fix it'],
  ['claude', '--frobnicate', 'v', 'prompt'],
  ['claude', '--model=opus', '--resume=abc', '--', '-p', 'text'],
  ['claude', '-cp', 'x', '-pv', '-dv', 'y', '-cZ', 'z'],
  ['claude', '-', '--add-dir', '/x', '-'],
  ['claude', '--prefill-b64=Zml4', '--deep-link-origin', '--prefill', 'fix', '--tmux=classic'],
  ['claude', '--mcp-config', '/a.json', '/b.json', '--settings', '/s.json', 'prompt'],
];

test('a resume command is the same from the recorded command and from the stored one', () => {
  for (const launch of LAUNCHES) {
    for (const label of [null, 'fix retry']) {
      assert.deepEqual(
        resume(storableArgv(launch), label),
        resume(launch, label),
        `${launch.join(' ')} / ${label}`,
      );
    }
  }
});

test('storing twice changes nothing', () => {
  for (const launch of LAUNCHES) {
    assert.deepEqual(storableArgv(storableArgv(launch)), storableArgv(launch), launch.join(' '));
  }
});

/** The tokens of the flags skydeck knows, as a resume would pass them (no program, no `--resume`). */
const passedOn = (launch: string[]): string[] =>
  parseLaunchArgs(launch.slice(1)).flatMap((item) =>
    item.kind === 'flag' && item.spec !== null && !item.spec.remove ? item.tokens : [],
  );

test('what is stored is the program, the tokens a resume keeps and the names of unknown flags', () => {
  for (const launch of LAUNCHES) {
    const stored = storableArgv(launch);
    assert.equal(stored[0], launch[0]);
    assert.deepEqual(passedOn(stored), resume(launch).argv.slice(3), launch.join(' '));
    assert.deepEqual(unknownFlags(stored), unknownFlags(launch), launch.join(' '));
  }
});

// --- unknownFlags --------------------------------------------------------------------------------

test('unknownFlags names the flags that are in no table, in order, once each', () => {
  assert.deepEqual(
    unknownFlags(['claude', '--frob', 'x', '--model', 'opus', '--other=1', '--frob', '-Z', 'y']),
    ['--frob', '--other', '-Z'],
  );
});

test('unknownFlags names a short token with an unknown letter by that letter alone', () => {
  assert.deepEqual(unknownFlags(['claude', '-cZ', 'x']), ['-Z']);
  assert.deepEqual(unknownFlags(['claude', '-cZfix the login bug', '-Zabc', '-Z', '-pvQ']), [
    '-Z',
    '-Q',
  ]);
});

test('unknownFlags is empty when every flag is known, and for no flags or no command', () => {
  assert.deepEqual(unknownFlags(['claude', '--model', 'opus', '-rabc', '-cp', 'prompt']), []);
  assert.deepEqual(unknownFlags(['claude']), []);
  assert.deepEqual(unknownFlags([]), []);
});

test('unknownFlags names a long flag that is in no table, after a -, and not the end-of-flags marker', () => {
  assert.deepEqual(unknownFlags(['claude', '-c-frob', 'x', '-c-frob=1']), ['--frob']);
  assert.deepEqual(unknownFlags(['claude', '-c-model', 'opus', '-c-', '-p-']), []);
});

test('unknownFlags skips the program and what follows --', () => {
  assert.deepEqual(unknownFlags(['--weird-program', '--', '--frob']), []);
  assert.deepEqual(unknownFlags(['claude', '--add-dir', '/x', '--', '--frob']), []);
});

test('unknownFlags gives the same names for a command and for the stored command', () => {
  const launch = ['claude', '--frob', 'fix it', '--model', 'opus', '--other=secret', 'prompt'];
  assert.deepEqual(unknownFlags(storableArgv(launch)), ['--frob', '--other']);
  assert.deepEqual(unknownFlags(launch), unknownFlags(storableArgv(launch)));
});

// --- isPrintRun ----------------------------------------------------------------------------------

test('isPrintRun is true for -p and --print', () => {
  assert.equal(isPrintRun(['claude', '-p', 'hi']), true);
  assert.equal(isPrintRun(['claude', '--print']), true);
  assert.equal(isPrintRun(['claude', '--model', 'opus', '--print', 'hi']), true);
});

test('isPrintRun finds -p inside a cluster of short flags', () => {
  assert.equal(isPrintRun(['claude', '-cp', 'hi']), true);
  assert.equal(isPrintRun(['claude', '-pc']), true);
  assert.equal(isPrintRun(['claude', '-hp']), true);
});

test('isPrintRun is false without the print flag', () => {
  assert.equal(isPrintRun(['claude']), false);
  assert.equal(isPrintRun([]), false);
  assert.equal(isPrintRun(['claude', '--model', 'opus', '-c', '--verbose']), false);
  assert.equal(isPrintRun(['claude', '--prefill', 'text', '-dv']), false);
});

test('isPrintRun ignores a -p that is a value, a positional after --, or the program', () => {
  assert.equal(isPrintRun(['claude', '--system-prompt', '-p']), false);
  assert.equal(isPrintRun(['claude', '--', '-p']), false);
  assert.equal(isPrintRun(['claude', '--add-dir', '/x', '--', '--print']), false);
  assert.equal(isPrintRun(['-p']), false);
});

test('isPrintRun sees -p before a - that ends the flags or starts a long flag', () => {
  assert.equal(isPrintRun(['claude', '-p-']), true);
  assert.equal(isPrintRun(['claude', '-p-model', 'opus']), true);
  assert.equal(isPrintRun(['claude', '-cp-']), true);
  assert.equal(isPrintRun(['claude', '-c-', '-p']), false);
  assert.equal(isPrintRun(['claude', '-c-p']), false);
  assert.equal(isPrintRun(['claude', '-c-model', 'opus']), false);
});

test('isPrintRun does not read a letter after a value-taking flag as a flag', () => {
  // -n takes the rest of its token, so the p in -np is part of the name
  assert.equal(isPrintRun(['claude', '-np']), false);
  assert.equal(isPrintRun(['claude', '-cnp']), false);
});

test('isPrintRun does not count a token with an unknown letter', () => {
  assert.equal(isPrintRun(['claude', '-pZ']), false);
});

test('isPrintRun sees -p in the recorded command, which storableArgv drops from a removed cluster', () => {
  assert.equal(isPrintRun(['claude', '-cp', 'hi']), true);
  assert.equal(isPrintRun(storableArgv(['claude', '-cp', 'hi'])), false);
});

// --- properties over random commands -------------------------------------------------------------

/** A small deterministic generator (a fixed seed gives the same commands on every run). */
function random(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % below;
  };
}

const PIECES = [
  ...allNames,
  '--',
  '-',
  '',
  'x',
  'fix it',
  '-cp',
  '-pc',
  '-rabc',
  '-nfoo',
  '-n=x',
  '-c-',
  '-p-',
  '-cp-',
  '-c-model',
  '-p-model',
  '-c-frob',
  '-c-frob=1',
  '-cZ',
  '-cZfix it',
  '-pvQ',
  '-Zabc',
  '-Z',
  '-1',
  '--frob',
  '--frob=1',
  '--model=o',
  '--resume=a',
  '--add-dir=a',
  '-cn',
  '-dv',
  '-pv',
  '-wfeat',
  'rel',
  './a',
];

test('random commands keep the properties storableArgv promises (fixed seed)', () => {
  const next = random(20260101);
  for (let run = 0; run < 3000; run += 1) {
    const launch = ['claude'];
    const length = next(8);
    for (let i = 0; i < length; i += 1) launch.push(PIECES[next(PIECES.length)] as string);
    const text = JSON.stringify(launch);

    const parsed = parseLaunchArgs(launch.slice(1));
    assert.deepEqual(
      parsed.flatMap((item) => item.tokens),
      launch.slice(1),
      text,
    );

    const stored = storableArgv(launch);
    assert.deepEqual(storableArgv(stored), stored, `stored twice: ${text}`);
    assert.deepEqual(unknownFlags(stored), unknownFlags(launch), `unknown flags: ${text}`);
    assert.deepEqual(passedOn(stored), passedOn(launch), `passed on: ${text}`);
    for (const label of [null, 'l']) {
      assert.deepEqual(resume(stored, label), resume(launch, label), `resume: ${text}`);
    }
    // no positional argument, no removed flag and no value of an unknown flag is ever stored
    for (const item of parseLaunchArgs(stored.slice(1))) {
      assert.equal(item.kind, 'flag', `positional stored: ${text}`);
      if (item.kind === 'flag') {
        assert.ok(item.spec === null ? item.tokens.length === 1 : !item.spec.remove, text);
        // a flag that is in no table is stored as its bare name, with no text after it
        if (item.spec === null) {
          assert.equal(item.tokens[0], item.name, `bare name: ${text}`);
          const token = item.name;
          if (token.startsWith('-') && !token.startsWith('--')) {
            assert.equal([...token.slice(1)].length, 1, `one unknown letter: ${text}`);
            assert.ok(!allNames.includes(token), `unknown: ${text}`);
          }
        }
      }
    }
  }
});

// --- buildNewCommand -----------------------------------------------------------------------------

test('buildNewCommand starts a session with the given id', () => {
  assert.deepEqual(
    buildNewCommand({ claudeCommand: 'claude', sessionId: S1, label: null, extra: [] }),
    ['claude', '--session-id', S1],
  );
});

test('buildNewCommand adds the label and then the extra arguments', () => {
  assert.deepEqual(
    buildNewCommand({
      claudeCommand: 'claude',
      sessionId: S1,
      label: 'x y',
      extra: ['--model', 'opus'],
    }),
    ['claude', '--session-id', S1, '-n', 'x y', '--model', 'opus'],
  );
});

test('buildNewCommand passes the extra arguments through untouched, even ones that look like flags to remove', () => {
  assert.deepEqual(
    buildNewCommand({
      claudeCommand: '/opt/claude',
      sessionId: S1,
      label: '',
      extra: ['-c', 'hi'],
    }),
    ['/opt/claude', '--session-id', S1, '-c', 'hi'],
  );
});
