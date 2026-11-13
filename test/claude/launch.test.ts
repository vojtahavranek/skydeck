import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  absolutizePathFlags,
  buildNewCommand,
  buildResumeCommand,
  FLAGS,
  parseLaunchArgs,
  storableArgv,
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

test('buildResumeCommand keeps a token with an unknown letter, with its value', () => {
  assert.deepEqual(resume(['claude', '-cZ', 'x']).argv, [...R, '-cZ', 'x']);
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

test('storableArgv keeps the argument that follows an unknown flag, and drops the next', () => {
  assert.deepEqual(storableArgv(['claude', '--frobnicate', 'v', 'prompt']), [
    'claude',
    '--frobnicate',
    'v',
  ]);
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

test('what is stored is exactly the program and the tokens a resume keeps', () => {
  for (const launch of LAUNCHES) {
    const stored = storableArgv(launch);
    assert.equal(stored[0], launch[0]);
    assert.deepEqual(stored.slice(1), resume(launch).argv.slice(3), launch.join(' '));
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
