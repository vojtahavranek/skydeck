import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  absolutizePathFlags,
  buildNewCommand,
  buildResumeCommand,
  FLAGS,
  parseLaunchArgs,
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

test('every spec has at least one name and a known shape', () => {
  for (const spec of FLAGS) {
    assert.ok(spec.names.length > 0);
    assert.ok(['none', 'one', 'optional', 'many'].includes(spec.shape), spec.names.join());
  }
});

test('the path flags are exactly --mcp-config --add-dir --settings --plugin-dir', () => {
  assert.deepEqual(
    namesWhere((spec) => spec.path),
    ['--add-dir', '--mcp-config', '--plugin-dir', '--settings'],
  );
});

test('the flags removed at resume are exactly the ones in the design (7.6, D28)', () => {
  assert.deepEqual(
    namesWhere((spec) => spec.remove),
    [
      '--background',
      '--bg',
      '--cloud',
      '--continue',
      '--desktop',
      '--fork-session',
      '--from-pr',
      '--name',
      '--resume',
      '--session-id',
      '--teleport',
      '--worktree',
      '-c',
      '-n',
      '-r',
      '-w',
    ].sort(),
  );
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

test('parseLaunchArgs: the = form is for long flags only', () => {
  assert.deepEqual(parse(['-n=x', 'y']), ['U["-n=x","y"] values ["y"]']);
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

test('buildResumeCommand lets a several-value flag swallow a trailing prompt (D18)', () => {
  assert.deepEqual(resume(['claude', '--add-dir', '/x', 'fix it']).argv, [
    ...R,
    '--add-dir',
    '/x',
    'fix it',
  ]);
});

test('buildResumeCommand keeps an unknown flag with its value, and drops the next positional', () => {
  assert.deepEqual(resume(['claude', '--frobnicate', 'v', 'prompt']).argv, [
    ...R,
    '--frobnicate',
    'v',
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
