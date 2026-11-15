import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { fakeRunner, runResult } from '../../helpers/platform.ts';
import { shellQuote } from '../../../src/text/shell.ts';
import { testDeck } from '../../helpers/deck.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { runOn, startFakeServe, windowMachine } from '../../helpers/window-machine.ts';
import type { Lines, WindowMachine } from '../../helpers/window-machine.ts';
import { writeWindowConfig } from '../../helpers/window-config.ts';

const USAGE_FIRST_LINE =
  'skydeck new [--label <text>] [--group <text>] [--here | --tab | --window] [-- <claude flags>]\n';
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

// ---------------------------------------------------------------------------------------------
// new --window (S2 11.4; plan C3, C11; task 76): the command sends its current directory,
// --label, --group and the words after -- to the window's server (the fake serve of
// test/fixtures/fake-serve, whose parser is the server's) and prepares nothing itself.

const ANSWER = { code: 0, lines: ['skydeck: started a new session'], sessionId: UUID1 };

interface WindowNew {
  m: WindowMachine;
  project: string;
  /** What reached the fake serve's launch (FAKE_SERVE_REQUESTS). */
  requests(): unknown[];
  edgeCalls(): string[][];
  /** `skydeck <argv>` in `project`; the control requests' paths. */
  run(argv: string[]): Promise<Lines & { asked: string[] }>;
}

/** A window machine, the Edge stub, and the fake serve with `env` answering ANSWER. */
async function windowNew(t: TestContext, env: Record<string, string> = {}): Promise<WindowNew> {
  const m = windowMachine(t, {
    env: (s) => ({
      SKYDECK_HANDOFF: join(s.root, 'handoff'),
      SKYDECK_TEST_WINDOW_TIMES: 'pingMs=5000,pageMs=300,reuseMs=100,answerMs=20000',
    }),
  });
  const stub = writeWindowConfig(m.s, {});
  const project = join(m.s.root, 'project');
  mkdirSync(project);
  const requests = join(m.s.root, 'requests.jsonl');
  await startFakeServe(t, m, {
    FAKE_SERVE_REQUESTS: requests,
    FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}`,
    FAKE_SERVE_PAGES: '1',
    ...env,
  });
  return {
    m,
    project,
    edgeCalls: () => stub.edgeCalls(),
    requests: () =>
      existsSync(requests)
        ? readFileSync(requests, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as unknown)
        : [],
    async run(argv) {
      const asked: string[] = [];
      const r = await runOn(m, argv, {
        cwd: project,
        net: {
          ...m.platform.net,
          requestUnix(path, request) {
            asked.push(`${request.method} ${request.path}`);
            return m.platform.net.requestUnix(path, request);
          },
        },
      });
      return { ...r, asked };
    },
  };
}

describe('new --window (S2 11.4; plan C3)', () => {
  test('--label, --group and the flags after -- as the request; the answer’s lines and code; nothing prepared here', async (t) => {
    const w = await windowNew(t);

    const r = await w.run([
      'new',
      '--window',
      '--label',
      'x',
      '--group',
      'y',
      '--',
      '--model',
      'opus',
    ]);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, 'skydeck: started a new session\n');
    assert.deepEqual(w.requests(), [
      { route: 'new', dir: w.project, label: 'x', group: 'y', flags: ['--model', 'opus'] },
    ]);
    assert.equal(existsSync(join(w.m.s.root, 'handoff')), false, 'no handoff file');
    assert.deepEqual(w.m.deck.store.allMeta(), [], 'no label or group stored here');
    assert.deepEqual(w.edgeCalls(), [], 'a page is connected');
  });

  test('without --label and --group: null; the flags as given, a prompt with spaces one word', async (t) => {
    const w = await windowNew(t);

    const r = await w.run(['new', '--window', '--', '-p', 'two words', '--model=x']);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.requests(), [
      {
        route: 'new',
        dir: w.project,
        label: null,
        group: null,
        flags: ['-p', 'two words', '--model=x'],
      },
    ]);
  });

  test('a label of 1,025 bytes is refused by the server’s parser (400): the refused-request line, exit 1, no window', async (t) => {
    const w = await windowNew(t, { FAKE_SERVE_PAGES: '0' });

    const r = await w.run(['new', '--window', '--label', 'x'.repeat(1025)]);

    assert.equal(r.code, 1, r.stderr);
    assert.equal(
      r.stderr,
      "skydeck: the window's server refused the request (body.label: too long); use --here\n",
    );
    assert.deepEqual(w.requests(), []);
    assert.ok(!r.asked.includes('POST /token'), JSON.stringify(r.asked));
    assert.deepEqual(w.edgeCalls(), []);
  });

  test('a prompt after -- over the server’s 64 KiB: the 413 row’s line, exit 1, and nothing is sent (ruled, task 76)', async (t) => {
    const w = await windowNew(t);

    const r = await w.run(['new', '--window', '--', '-p', 'p'.repeat(70 * 1024)]);

    assert.equal(r.code, 1, r.stderr);
    assert.equal(
      r.stderr,
      "skydeck: the window's server refused the request (body: too large); use --here\n",
    );
    assert.ok(!r.asked.includes('POST /new'), `not sent: ${JSON.stringify(r.asked)}`);
    assert.ok(!r.stderr.includes('may have started'), r.stderr);
    assert.deepEqual(w.requests(), []);
  });

  test('--here --window and --tab --window are usage errors: exit 2, nothing sent', async (t) => {
    const w = await windowNew(t);
    for (const other of ['--here', '--tab']) {
      const r = await w.run(['new', other, '--window']);
      assert.equal(r.code, 2, other);
      assert.ok(
        r.stderr.startsWith(`skydeck: ${other} and --window cannot be used together\n`),
        r.stderr,
      );
      assert.ok(r.stderr.includes(USAGE_FIRST_LINE), r.stderr);
      assert.deepEqual(r.asked, [], other);
    }
    assert.deepEqual(w.requests(), []);
  });
});

// ---------------------------------------------------------------------------------------------
// "terminal": "window" (S2 11.4, 16.4; plan C13; task 77): no option and --tab go to the window's
// server, --here stays here.

/** config.json of `m` with `"terminal": terminal`, its other keys kept. */
function withTerminal(m: WindowMachine, terminal: string): void {
  const path = m.deck.places.configPath;
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...config, terminal }, null, 2)}\n`);
}

describe('new with "terminal": "window" (S2 11.4; plan C13)', () => {
  for (const option of [[], ['--tab']]) {
    test(`${option.length === 0 ? 'no option' : option.join(' ')}: the request to the window's server, its lines and code; nothing prepared here`, async (t) => {
      const w = await windowNew(t);
      withTerminal(w.m, 'window');

      const r = await w.run(['new', ...option, '--label', 'x', '--', '--model', 'opus']);

      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, 'skydeck: started a new session\n');
      assert.deepEqual(w.requests(), [
        { route: 'new', dir: w.project, label: 'x', group: null, flags: ['--model', 'opus'] },
      ]);
      assert.equal(existsSync(join(w.m.s.root, 'handoff')), false, 'no handoff file');
      assert.deepEqual(w.m.deck.store.allMeta(), [], 'no label stored here');
    });
  }

  test('--here: the handoff file as in step 1; the server is not asked', async (t) => {
    const w = await windowNew(t);
    withTerminal(w.m, 'window');

    const r = await w.run(['new', '--here', '--', '--model', 'opus']);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.asked, []);
    assert.deepEqual(w.requests(), []);
    assert.match(
      readFileSync(join(w.m.s.root, 'handoff'), 'utf8'),
      new RegExp(
        `^cd -- ${shellQuote(w.project)} \\|\\| exit 1\nexec claude --session-id [0-9a-f-]{36} --model opus\n$`,
      ),
    );
  });
});
