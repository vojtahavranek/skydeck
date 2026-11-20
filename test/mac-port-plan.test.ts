// docs/plans/mac-port.md is followed literally by an AI agent on a person's Mac. Its part 4.2 holds
// one block of shell that starts Claude Code once, scripted, with a throwaway hook. This file runs
// that block, as the plan prints it, in the suite's sandbox with a stand-in `claude` (never the real
// one) and checks what the plan promises the person: the run's flags (with and without a
// `--max-turns` in `claude --help`), that `CLAUDECODE` reaches claude as it is (Claude Code's guard
// against a session inside a session looks at it) while the outer session's other three markers do
// not, that the hook's files hold only names, yes/no answers, words from fixed
// lists and one masked start time (no value, no free text), that nothing is written outside the
// plan's scratch folder at the clone's root (never under .git, a protected path), and that a
// second run refuses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { sandbox } from './helpers/sandbox.ts';

const PLAN = readFileSync(join(import.meta.dirname, '..', 'docs', 'plans', 'mac-port.md'), 'utf8');

/** The plan's fact-run block: the first `sh` block after the sentence that introduces it. */
function factRunBlock(): string {
  // The sentence may break over lines anywhere.
  const intro = PLAN.search(
    /make\s+the\s+folder,\s+the\s+hook,\s+the\s+settings\s+file\s+and\s+the\s+run\s+script/,
  );
  assert.notEqual(intro, -1, 'the plan no longer introduces its fact-run block');
  const start = PLAN.indexOf('```sh\n', intro);
  const end = PLAN.indexOf('\n```', start + 6);
  assert.ok(start !== -1 && end !== -1, 'no sh block after the introduction');
  return PLAN.slice(start + 6, end) + '\n';
}

// Made-up personal values; none of them may reach the hook's files.
const USER = 'jqdoe-private';
const OUTER_SESSION = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const INNER_SESSION = '5f0c2b1e-8d4a-4c3b-9a7e-1f2d3c4b5a69';
const SECRETS = [USER, 'jqdoe', 'acme', 'payroll', 'tok-', OUTER_SESSION, INNER_SESSION, '4242'];

/** The forms every line of the hook's files may take. */
const FORMS = [
  /^event: (SessionStart|SessionEnd)$/,
  /^(CLAUDE\* variable names|input field names):$/,
  /^ {2}[A-Za-z_][A-Za-z0-9_]*$/,
  /^(CLAUDE_CODE_SESSION_ID equals session_id|PATH holds \/usr\/sbin|PATH holds \/bin|CLAUDE_PID is a number): (yes|no)$/,
  /^CLAUDE_CODE_ENTRYPOINT: (cli|sdk-cli|sdk-ts|sdk-py|claude-vscode|claude-desktop|\(other\)|\(not set\))$/,
  /^command name of CLAUDE_PID: (claude|node|\(other\))$/,
  /^the hook's parent: (sh|bash|zsh|dash|\(other\))$/,
  /^ps lstart of CLAUDE_PID, masked: \[[a9 :]*\]$/,
];

function standIn(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Every path under `root` with its kind and size. */
function tree(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = lstatSync(path);
      found.set(path, `${stats.isDirectory() ? 'd' : 'f'} ${stats.isDirectory() ? 0 : stats.size}`);
      if (stats.isDirectory()) walk(path);
    }
  };
  walk(root);
  return found;
}

function setUp(
  t: TestContext,
  options: { maxTurns?: boolean; claude?: boolean; badInput?: boolean } = {},
) {
  const s = sandbox(t);
  s.link('sh', 'cat', 'mkdir', 'awk', 'sort', 'perl', 'sed', 'ps', 'env', 'dirname', 'grep');
  const home = join(s.root, 'Users', USER);
  const clone = join(home, 'skydeck');
  const marks = join(s.root, 'marks');
  mkdirSync(join(clone, '.git'), { recursive: true });
  writeFileSync(join(clone, '.git', 'HEAD'), 'ref: refs/heads/mac-m1\n');
  mkdirSync(marks);
  // `git rev-parse --show-toplevel` as git answers it in the clone.
  standIn(
    s.bin,
    'git',
    `if [ "$1 $2" = "rev-parse --show-toplevel" ]; then echo '${clone}'; else exit 1; fi`,
  );
  // A stand-in `claude`: `--help` lists its flags (`--max-turns` only when asked to); a run records
  // its arguments and which outer markers reached it, then runs the hooks of its --settings file as
  // Claude Code would, with personal values in their input.
  const help = [
    '-p, --print',
    '--settings <file-or-json>',
    '--tools <tools...>',
    '--disallowedTools <tools...>',
    '--strict-mcp-config',
    '--mcp-config <configs...>',
    ...(options.maxTurns === false ? [] : ['--max-turns <turns>']),
    '--max-budget-usd <amount>',
    '--no-session-persistence',
    '--model <model>',
  ];
  if (options.claude !== false)
    standIn(
      s.bin,
      'claude',
      [
        `if [ "$1" = --help ]; then printf '  %s\\n' ${help.map((h) => `'${h}'`).join(' ')}; exit 0; fi`,
        `printf '%s\\n' "$@" > '${join(marks, 'args')}'`,
        `for v in CLAUDECODE CLAUDE_PID CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT; do`,
        `  eval "set_=\\\${$v+set}"; echo "$v $set_" >> '${join(marks, 'inherited')}'`,
        'done',
        'settings=',
        'for a in "$@"; do if [ "$prev" = --settings ]; then settings=$a; fi; prev=$a; done',
        'for ev in SessionStart SessionEnd; do',
        `  cmd=$(perl -MJSON::PP -e 'local $/; my $j = decode_json(<STDIN>); print $j->{hooks}{$ARGV[0]}[0]{hooks}[0]{command}' "$ev" < "$settings")`,
        options.badInput === true
          ? `  printf 'not json from ${USER} %s' "$ev" |`
          : `  printf '{"session_id":"${INNER_SESSION}","transcript_path":"/Users/${USER}/.claude/projects/acme/${INNER_SESSION}.jsonl","cwd":"/Users/${USER}/acme-payroll","hook_event_name":"%s","source":"startup"}' "$ev" |`,
        `    CLAUDE_PID=$$ CLAUDE_CODE_SESSION_ID=${INNER_SESSION} CLAUDE_CODE_ENTRYPOINT=sdk-cli sh -c "$cmd"`,
        'done',
        'echo ok',
      ].join('\n'),
    );
  const env = s.env({
    HOME: home,
    CLAUDE_CONFIG_DIR: undefined,
    CLAUDECODE: '1',
    CLAUDE_PID: '4242',
    CLAUDE_CODE_SESSION_ID: OUTER_SESSION,
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_OAUTH_TOKEN: `tok-${USER}`,
  });
  return { s, clone, marks, env };
}

function runBlock(clone: string, env: Record<string, string>) {
  return spawnSync('/bin/sh', ['-c', factRunBlock()], {
    cwd: clone,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe("the plan's scripted Claude Code run (part 4.2), with a stand-in claude", () => {
  test('starts claude once with the plan’s flags, CLAUDECODE as it is and none of the other outer markers', (t) => {
    const { clone, marks, env } = setUp(t);
    const ran = runBlock(clone, env);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /^claude ended with 0$/m);
    const args = readFileSync(join(marks, 'args'), 'utf8').split('\n');
    const facts = join(clone, '.mac-port-scratch', 'facts');
    assert.deepEqual(args.slice(0, 3), ['-p', 'Reply with the single word ok.', '--settings']);
    assert.equal(args[3], join(facts, 'settings.json'));
    for (const [flag, value] of [
      ['--tools', ''],
      ['--disallowedTools', 'mcp__*'],
      ['--mcp-config', '{"mcpServers":{}}'],
      ['--max-turns', '1'],
      ['--max-budget-usd', '0.05'],
      ['--model', 'haiku'],
    ]) {
      const at = args.indexOf(flag as string);
      assert.ok(at !== -1, `${flag} is missing`);
      assert.equal(args[at + 1], value, `${flag} has another value`);
    }
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--no-session-persistence'));
    for (const banned of ['--restricted', '--bare']) {
      assert.equal(args.includes(banned), false, `${banned} is used`);
    }
    assert.equal(
      readFileSync(join(marks, 'inherited'), 'utf8'),
      'CLAUDECODE set\nCLAUDE_PID \nCLAUDE_CODE_SESSION_ID \nCLAUDE_CODE_ENTRYPOINT \n',
      'CLAUDECODE did not reach claude, or another outer marker did',
    );
    assert.match(readFileSync(join(facts, 'pid.txt'), 'utf8'), /^[0-9]+\n$/);
  });

  test('where claude --help does not list --max-turns, the run goes without it', (t) => {
    const { clone, marks, env } = setUp(t, { maxTurns: false });
    const ran = runBlock(clone, env);
    assert.equal(ran.status, 0, ran.stderr);
    const args = readFileSync(join(marks, 'args'), 'utf8').split('\n');
    assert.equal(args.includes('--max-turns'), false);
    assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.05');
  });

  test('a claude that cannot be started ends the run with 127', (t) => {
    const { clone, env } = setUp(t, { claude: false });
    const ran = runBlock(clone, env);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /^claude ended with 127$/m);
  });

  test('the hook’s files hold only names, yes/no, words from fixed lists and a masked start; nothing is written elsewhere', (t) => {
    const { s, clone, env } = setUp(t);
    const before = tree(s.root);
    const ran = runBlock(clone, env);
    assert.equal(ran.status, 0, ran.stderr);
    const facts = join(clone, '.mac-port-scratch', 'facts');
    const after = tree(s.root);
    for (const path of after.keys()) {
      if (!before.has(path)) {
        assert.ok(
          path.startsWith(join(clone, '.mac-port-scratch')) ||
            path.startsWith(join(s.root, 'marks')),
          `the block wrote ${path}`,
        );
      }
    }
    for (const event of ['SessionStart', 'SessionEnd']) {
      const text = readFileSync(join(facts, `${event}.txt`), 'utf8');
      for (const line of text.replace(/\n$/, '').split('\n')) {
        assert.ok(
          FORMS.some((form) => form.test(line)),
          `${event}.txt holds a line of no allowed form: ${JSON.stringify(line)}`,
        );
      }
      for (const secret of SECRETS) {
        assert.equal(
          text.toLowerCase().includes(secret.toLowerCase()),
          false,
          `"${secret}" in ${event}.txt`,
        );
      }
      assert.match(text, /^event: /m);
      assert.match(text, /^ {2}CLAUDE_PID$/m);
      assert.match(text, /^ {2}CLAUDE_CODE_OAUTH_TOKEN$/m);
      assert.match(text, /^ {2}CLAUDECODE$/m);
      assert.match(text, /^ {2}session_id$/m);
      assert.match(text, /^CLAUDE_CODE_SESSION_ID equals session_id: yes$/m);
      assert.match(text, /^CLAUDE_CODE_ENTRYPOINT: sdk-cli$/m);
      assert.match(text, /^CLAUDE_PID is a number: yes$/m);
    }
  });

  test('the scratch folder the plan writes into is one the repository’s .gitignore names', () => {
    const ignore = readFileSync(join(import.meta.dirname, '..', '.gitignore'), 'utf8').split('\n');
    assert.ok(
      ignore.includes('/.mac-port-scratch/'),
      '.gitignore does not name /.mac-port-scratch/',
    );
    assert.match(PLAN, /`\.mac-port-scratch\/`/);
  });

  test('what a program of the hook prints on stderr never reaches its files', (t) => {
    // An input that is no JSON makes perl complain; the hook drops that text.
    const { clone, env } = setUp(t, { badInput: true });
    assert.equal(runBlock(clone, env).status, 0);
    const facts = join(clone, '.mac-port-scratch', 'facts');
    for (const event of ['SessionStart', 'SessionEnd']) {
      const text = readFileSync(join(facts, `${event}.txt`), 'utf8');
      for (const line of text.replace(/\n$/, '').split('\n')) {
        assert.ok(
          FORMS.some((form) => form.test(line)),
          `${event}.txt holds a line of no allowed form: ${JSON.stringify(line)}`,
        );
      }
      assert.equal(text.includes('jqdoe'), false);
    }
  });

  test('a second run refuses while the first one’s folder is there', (t) => {
    const { clone, marks, env } = setUp(t);
    assert.equal(runBlock(clone, env).status, 0);
    const again = runBlock(clone, env);
    assert.equal(again.status, 1);
    assert.match(again.stdout, /\.mac-port-scratch\/facts is there already: stop$/m);
    assert.equal(existsSync(join(marks, 'args')), true);
  });
});
