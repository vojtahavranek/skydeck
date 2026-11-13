import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { fakeRunner, runResult } from '../../helpers/platform.ts';
import { shellQuote } from '../../../src/text/shell.ts';
import { testDeck } from '../../helpers/deck.ts';
import type { TestDeck } from '../../helpers/deck.ts';

const USAGE_FIRST_LINE =
  'skydeck new [--label <text>] [--group <text>] [--here | --tab] [-- <claude flags>]\n';
const UUID1 = '00000000-0000-4000-8000-000000000001';

type Options = Parameters<typeof testDeck>[1];

function deck(t: Parameters<typeof testDeck>[0], options: Options = {}): TestDeck {
  return testDeck(t, {
    env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }),
    ...options,
  });
}

const handoffPath = (d: TestDeck): string => join(d.sandbox.root, 'handoff');
const handoff = (d: TestDeck): string => readFileSync(handoffPath(d), 'utf8');

test('new --help prints the usage and exits 0', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--help'], d.ctx), 0);
  assert.ok(d.stdout().startsWith(USAGE_FIRST_LINE), d.stdout());
});

test('new with a label, a group and claude flags hands the command to the launcher', async (t) => {
  const d = deck(t);
  assert.equal(
    await main(['new', '--label', 'fix it', '--group', 'ABC-1', '--', '--model', 'opus'], d.ctx),
    0,
  );
  assert.equal(
    handoff(d),
    `cd -- ${shellQuote(d.platform.cwd)} || exit 1\nexec claude --session-id ${UUID1} -n 'fix it' --model opus\n`,
  );
  const stored = d.deck.store.meta(UUID1);
  assert.equal(stored?.label, 'fix it');
  assert.equal(stored?.group, 'ABC-1');
  assert.equal(d.stderr(), '');
});

test('new without options starts claude with only the new session id', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new'], d.ctx), 0);
  assert.equal(
    handoff(d),
    `cd -- ${shellQuote(d.platform.cwd)} || exit 1\nexec claude --session-id ${UUID1}\n`,
  );
  assert.deepEqual(d.deck.store.allMeta(), []);
});

test('new --label -x is a usage error', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--label', '-x'], d.ctx), 2);
  assert.ok(d.stderr().includes(USAGE_FIRST_LINE), d.stderr());
  assert.equal(existsSync(handoffPath(d)), false);
});

test('new --label=-x is refused and stores nothing', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--label=-x'], d.ctx), 2);
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.equal(existsSync(handoffPath(d)), false);
});

test('new --here --tab is a usage error', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--here', '--tab'], d.ctx), 2);
});

test('new with a positional argument is a usage error', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', 'prompt'], d.ctx), 2);
});

test('new --tab opens a WezTerm tab in the current directory', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  assert.equal(await main(['new', '--tab', '--', '--model', 'opus'], d.ctx), 0);
  assert.deepEqual(
    d.runner.calls.map((call) => [call.command, ...call.args]),
    [
      [
        'wezterm',
        'cli',
        '--no-auto-start',
        'spawn',
        '--cwd',
        d.platform.cwd,
        '--',
        'claude',
        '--session-id',
        UUID1,
        '--model',
        'opus',
      ],
    ],
  );
});

test('new --tab without a tab adapter prints the command and exits 1', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--tab', '--label', 'fix it'], d.ctx), 1);
  assert.ok(d.stderr().includes('no terminal adapter that opens tabs'), d.stderr());
  assert.ok(
    d
      .stderr()
      .includes(
        `cd -- ${shellQuote(d.platform.cwd)} && claude --session-id ${UUID1} -n 'fix it'\n`,
      ),
    d.stderr(),
  );
});

test('new --tab without a tab adapter keeps the label and group: the printed command may be run', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--tab', '--label', 'fix it', '--group', 'ABC-1'], d.ctx), 1);
  assert.equal(d.deck.store.meta(UUID1)?.label, 'fix it');
  assert.equal(d.deck.store.meta(UUID1)?.group, 'ABC-1');
});

test('new whose tab definitely did not open, with no command printed, removes the label and group it stored', async (t) => {
  const answers = [
    runResult({ code: 1, stderr: 'no window\n' }), // refused
    runResult({ code: null, notFound: true }), // not installed
  ];
  for (const answer of answers) {
    const d = deck(t, { config: { terminal: 'wezterm' } });
    d.platform.runner = fakeRunner(() => answer);
    const args = ['new', '--tab', '--label', 'fix it', '--group', 'ABC-1'];
    assert.equal(await main([...args, '--', '--model', 'op\x1b[31mus'], d.ctx), 1);
    assert.ok(d.stderr().includes('cannot be printed safely'), d.stderr());
    assert.equal(d.deck.store.meta(UUID1), null, d.stderr()); // a session that never existed
    assert.deepEqual(d.deck.store.allMeta(), []);
  }
});

test('new whose tab timed out keeps the label and group even when no command can be printed', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  const args = ['new', '--tab', '--label', 'fix it', '--', '--model', 'op\x1b[31mus'];
  assert.equal(await main(args, d.ctx), 1);
  assert.equal(d.deck.store.meta(UUID1)?.label, 'fix it'); // the tab may have opened
});

test('new -- -r <id> is refused: it would resume a session past the guard', async (t) => {
  const d = deck(t);
  const id = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';
  assert.equal(await main(['new', '--label', 'x', '--', '-r', id], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: cannot pass -r to claude:'), d.stderr());
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.equal(existsSync(handoffPath(d)), false);
});

test('new -- -c, a cluster with -c, and --session-id=<uuid> are refused', async (t) => {
  const d = deck(t);
  for (const extra of [['-c'], ['-pc'], [`--session-id=${UUID1}`]]) {
    assert.equal(await main(['new', '--', ...extra], d.ctx), 2, extra.join(' '));
  }
  assert.equal(existsSync(handoffPath(d)), false);
});

test('new -- --from-pr, --fork-session, --prefill-b64=<text> and --teleport are refused too', async (t) => {
  const d = deck(t);
  for (const extra of [
    ['--from-pr', '12'],
    ['--fork-session'],
    ['--prefill-b64=Zml4'],
    ['--teleport'],
  ]) {
    assert.equal(await main(['new', '--', ...extra], d.ctx), 2, extra.join(' '));
    assert.ok(d.stderr().includes('it picks an existing session'), d.stderr());
  }
  assert.equal(existsSync(handoffPath(d)), false);
  assert.deepEqual(d.deck.store.allMeta(), []);
});

test('new -- -n <name> is refused and points to --label', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--', '-n', 'x'], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: cannot pass -n to claude:'), d.stderr());
  assert.ok(d.stderr().includes('--label'), d.stderr());
  assert.equal(await main(['new', '--label', 'x', '--', '--name=other'], d.ctx), 2);
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.equal(existsSync(handoffPath(d)), false);
});

test('new -- --worktree starts a session in a new worktree', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--', '--worktree'], d.ctx), 0);
  assert.equal(
    handoff(d),
    `cd -- ${shellQuote(d.platform.cwd)} || exit 1\nexec claude --session-id ${UUID1} --worktree\n`,
  );
  assert.equal(d.stderr(), '');
});

test('new -- -w feat --model x "prompt" passes the flags and the prompt on', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--', '-w', 'feat', '--model', 'x', 'fix the bug'], d.ctx), 0);
  assert.equal(
    handoff(d),
    `cd -- ${shellQuote(d.platform.cwd)} || exit 1\nexec claude --session-id ${UUID1} -w feat --model x 'fix the bug'\n`,
  );
});

test('new -- --model x "prompt" passes the flags and the prompt on', async (t) => {
  const d = deck(t);
  assert.equal(await main(['new', '--', '--model', 'x', 'fix the bug'], d.ctx), 0);
  assert.equal(
    handoff(d),
    `cd -- ${shellQuote(d.platform.cwd)} || exit 1\nexec claude --session-id ${UUID1} --model x 'fix the bug'\n`,
  );
});

test('new --tab that timed out names the new session and prints no command', async (t) => {
  const d = deck(t, { config: { terminal: 'wezterm' } });
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  assert.equal(await main(['new', '--tab', '--label', 'fix it'], d.ctx), 1);
  assert.equal(
    d.stderr(),
    'skydeck: wezterm timed out; a tab may have opened\n' +
      `skydeck: the new session's id is ${UUID1}; running skydeck shows whether it started\n`,
  );
  assert.equal(d.deck.store.meta(UUID1)?.label, 'fix it');
});
