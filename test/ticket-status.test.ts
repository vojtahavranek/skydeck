// Follow-up F19 (T1–T4): which provider reads a ticket's status, the configured command and its
// answer, when a status is due, and the fetch that saves the results. The command is a list of
// words run without a shell: `{url}` and `{key}` in an argument are replaced, each argument stays
// ONE argument whatever the address holds. Only fake runners here: no program, no network.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { statusProvider } from '../src/github.ts';
import type { TicketStatusRule } from '../src/platform/config.ts';
import { NS_PER_MINUTE } from '../src/platform/time.ts';
import type { RunResult } from '../src/platform/types.ts';
import { openStore } from '../src/store/store.ts';
import type { Store } from '../src/store/store.ts';
import type { TicketStatusRow } from '../src/store/types.ts';
import {
  COMMANDS_PER_ROUND,
  FINISHED_REFRESH_HOURS,
  STATUS_OUTPUT_BYTES,
  STATUS_TIMEOUT_MS,
  fetchTicketStatuses,
  readStatusAnswer,
  statusCommand,
  statusesDue,
} from '../src/ticket-status.ts';
import { T0, fakeClock, fakeRunner, runResult } from './helpers/platform.ts';
import type { RunCall } from './helpers/platform.ts';
import { sandbox } from './helpers/sandbox.ts';

const MIN = NS_PER_MINUTE;
const HOUR = 60n * MIN;
const JIRA: TicketStatusRule = {
  match: 'https://tickets.example.com/browse/',
  command: ['/home/u/bin/status', '--key', '{key}', '--url={url}'],
};
const ANY: TicketStatusRule = {
  match: 'https://tickets.example.com/',
  command: ['/home/u/bin/other', '{url}'],
};
const TICKET = 'https://tickets.example.com/browse/ABC-123';
const ISSUE = 'https://github.com/owner/repo/issues/5';

describe('statusProvider (T1, T2)', () => {
  test('the first rule whose match starts the address takes it; rules come before GitHub', () => {
    assert.deepEqual(statusProvider(TICKET, [JIRA, ANY]), { kind: 'command', rule: JIRA });
    assert.deepEqual(statusProvider(TICKET, [ANY, JIRA]), { kind: 'command', rule: ANY });
    assert.deepEqual(statusProvider('https://tickets.example.com/x/1', [JIRA, ANY]), {
      kind: 'command',
      rule: ANY,
    });
    const github: TicketStatusRule = { match: 'https://github.com/owner/', command: ['g'] };
    assert.deepEqual(statusProvider(ISSUE, [github]), { kind: 'command', rule: github });
  });

  test('a GitHub issue without a rule is GitHub’s, by its key', () => {
    assert.deepEqual(statusProvider(ISSUE, []), {
      kind: 'github',
      key: { url: ISSUE, owner: 'owner', repo: 'repo', number: 5 },
    });
    assert.deepEqual(statusProvider(`${ISSUE}#issuecomment-7`, [JIRA]), {
      kind: 'github',
      key: { url: ISSUE, owner: 'owner', repo: 'repo', number: 5 },
    });
  });

  test('a pull request gets no status, also when a rule would take it; nothing else either', () => {
    const github: TicketStatusRule = { match: 'https://github.com/', command: ['g'] };
    assert.equal(statusProvider('https://github.com/owner/repo/pull/5', []), null);
    assert.equal(statusProvider('https://github.com/owner/repo/pull/5', [github]), null);
    assert.equal(statusProvider('https://example.com/browse/ABC-1', [JIRA]), null);
    assert.equal(statusProvider('https://tickets.example.com.other.net/browse/X-1', [ANY]), null);
    assert.equal(statusProvider(TICKET, []), null);
    // Only at the START of the address: one that holds the match further on is not the rule's.
    assert.equal(
      statusProvider('https://other.example/go?to=https://tickets.example.com/browse/ABC-1', [
        JIRA,
      ]),
      null,
    );
    // An issue's path on another host is no GitHub issue.
    assert.equal(statusProvider('https://example.com/owner/repo/issues/5', []), null);
  });
});

describe('statusCommand (T2 b, hazard 1)', () => {
  test('{url} and {key} are replaced in the arguments, everywhere in one, never in the program', () => {
    const rule: TicketStatusRule = {
      match: 'https://tickets.example.com/',
      command: ['/opt/{key}/status', '{key}', 'x{url}y', '{url}{key}', 'plain'],
    };
    assert.deepEqual(statusCommand(rule, TICKET, 'ABC-123'), {
      program: '/opt/{key}/status',
      args: ['ABC-123', `x${TICKET}y`, `${TICKET}ABC-123`, 'plain'],
    });
  });

  test('an address with spaces, quotes, `;` and `$(…)` arrives as ONE argument, unchanged', () => {
    const address = `https://tickets.example.com/a b/"q" 'r';$(touch /tmp/x)\`id\`|&>`;
    const { args } = statusCommand(
      { match: 'https://tickets.example.com/', command: ['p', '{url}'] },
      address,
      'k',
    );
    assert.deepEqual(args, [address]);
  });

  test('the replaced text is not read again: a key or address holding `{url}` stays as it is', () => {
    const address = 'https://tickets.example.com/t?q={key}';
    assert.deepEqual(
      statusCommand(
        { match: 'https://tickets.example.com/', command: ['p', '{url}', '{key}'] },
        address,
        '{url}',
      ).args,
      [address, '{url}'],
    );
  });
});

/** A finished run of the command with `stdout`, exit 0, unless `more` says otherwise. */
function ran(stdout: string, more: Partial<RunResult> = {}): RunResult {
  return runResult({ stdout, ...more });
}

describe('readStatusAnswer (T2 b, T3)', () => {
  const read = (result: RunResult) => readStatusAnswer(result, '/home/u/bin/jira-status', T0);

  test('two lines: the status, then the category', () => {
    assert.deepEqual(read(ran('In Progress\ndoing\n')), {
      ok: true,
      atNs: T0,
      status: 'In Progress',
      category: 'doing',
    });
    for (const category of ['todo', 'doing', 'review', 'blocked', 'done', 'closed'] as const) {
      const answer = read(ran(`x\n${category}`));
      assert.equal(answer.ok && answer.category, category);
    }
  });

  test('one line: no category; extra lines are ignored; the category is trimmed and its case left aside', () => {
    assert.deepEqual(read(ran('New')), { ok: true, atNs: T0, status: 'New', category: null });
    assert.deepEqual(read(ran('New\n  Review  \nthird\nfourth')), {
      ok: true,
      atNs: T0,
      status: 'New',
      category: 'review',
    });
    assert.deepEqual(read(ran('Waiting\nwaiting-for-customer')), {
      ok: true,
      atNs: T0,
      status: 'Waiting',
      category: null,
    });
    assert.deepEqual(read(ran('Waiting\n\ndone')), {
      ok: true,
      atNs: T0,
      status: 'Waiting',
      category: null,
    });
  });

  test('CRLF, white space at both ends, control characters and escape sequences are dropped', () => {
    assert.deepEqual(read(ran('  In Review \r\nreview\r\n')), {
      ok: true,
      atNs: T0,
      status: 'In Review',
      category: 'review',
    });
    assert.deepEqual(read(ran('\u001b[31mBlocked\u001b[0m\u0007 by\u0000 QA\u202e\ndone')), {
      ok: true,
      atNs: T0,
      status: 'Blocked by QA',
      category: 'done',
    });
  });

  test('a long first line keeps its first 40 characters', () => {
    const answer = read(ran(`${'é'.repeat(39)}xyz\ntodo`));
    assert.ok(answer.ok);
    assert.equal(answer.status, `${'é'.repeat(39)}x`);
    assert.equal([...answer.status].length, 40);
  });

  test('no output, or an empty first line, is a failure', () => {
    for (const stdout of ['', '\n', '   \ndone', '\u001b[0m\nx']) {
      assert.deepEqual(
        read(ran(stdout)),
        {
          ok: false,
          atNs: T0,
          error: 'the status command printed no status',
        },
        JSON.stringify(stdout),
      );
    }
  });

  test('exit 1 with stderr is its first cleaned line; without stderr the exit code', () => {
    assert.deepEqual(
      read(
        ran('Done\n', {
          code: 1,
          stderr: '\n  \u001b[31merror:\u001b[0m ABC-123 not found \nmore\n',
        }),
      ),
      { ok: false, atNs: T0, error: 'error: ABC-123 not found' },
    );
    assert.deepEqual(read(ran('', { code: 3 })), {
      ok: false,
      atNs: T0,
      error: 'the status command exited 3',
    });
    assert.deepEqual(read(ran('', { code: null })), {
      ok: false,
      atNs: T0,
      error: 'the status command was killed by a signal',
    });
    const long = read(ran('', { code: 1, stderr: 'x'.repeat(500) }));
    assert.equal(long.ok ? '' : long.error, `${'x'.repeat(199)}…`);
  });

  test('a timeout and a missing program have their own words', () => {
    assert.deepEqual(read(ran('Done', { code: null, timedOut: true })), {
      ok: false,
      atNs: T0,
      error: 'the status command timed out after 10 s',
    });
    assert.deepEqual(read(ran('', { code: null, notFound: true })), {
      ok: false,
      atNs: T0,
      error: 'the status command jira-status is not installed',
    });
  });
});

function row(url: string, over: Partial<TicketStatusRow> = {}): TicketStatusRow {
  return {
    url,
    status: 'In Progress',
    category: 'doing',
    okAtNs: T0,
    triedAtNs: T0,
    error: null,
    ...over,
  };
}

describe('statusesDue (T4)', () => {
  const now = T0 + 11n * MIN;

  test('never tried is due; an attempt older than ticketRefreshMinutes is due, one as old is not', () => {
    const rows = new Map([
      ['a', row('a', { triedAtNs: now - 10n * MIN })],
      ['b', row('b', { triedAtNs: now - 10n * MIN - 1n })],
      ['c', row('c', { triedAtNs: now - MIN })],
    ]);
    assert.deepEqual(statusesDue(['never', 'a', 'b', 'c'], rows, now, 10), ['never', 'b']);
  });

  test('the last attempt counts, not the last success: a recent failure is not due', () => {
    const rows = new Map([
      ['a', row('a', { okAtNs: now - 5n * HOUR, triedAtNs: now - MIN, error: 'x' })],
    ]);
    assert.deepEqual(statusesDue(['a'], rows, now, 10), []);
  });

  test('done and closed are due after 12 hours, whatever ticketRefreshMinutes says', () => {
    assert.equal(FINISHED_REFRESH_HOURS, 12);
    const rows = new Map([
      ['done', row('done', { category: 'done', triedAtNs: now - 11n * HOUR })],
      ['closed', row('closed', { category: 'closed', triedAtNs: now - 12n * HOUR - 1n })],
      ['old-done', row('old-done', { category: 'done', triedAtNs: now - 13n * HOUR })],
      ['todo', row('todo', { category: 'todo', triedAtNs: now - 11n * HOUR })],
    ]);
    assert.deepEqual(statusesDue(['done', 'closed', 'old-done', 'todo'], rows, now, 10), [
      'closed',
      'old-done',
      'todo',
    ]);
    assert.deepEqual(statusesDue(['done', 'todo'], rows, now, 1440), []);
  });

  test('an address given twice is due once; the order is kept', () => {
    assert.deepEqual(statusesDue(['b', 'a', 'b'], new Map(), now, 10), ['b', 'a']);
  });
});

interface World {
  store: Store;
  runner: ReturnType<typeof fakeRunner>;
  deps: Parameters<typeof fetchTicketStatuses>[0];
}

/** A store in a sandbox and a runner that answers `answer(call)`; `rules` as config. */
function world(
  t: TestContext,
  rules: TicketStatusRule[],
  answer: (call: RunCall) => RunResult | Promise<RunResult>,
): World {
  const root = sandbox(t).root;
  const store = openStore(join(root, 'skydeck.db'));
  t.after(() => {
    store.close();
  });
  const runner = fakeRunner(answer);
  return {
    store,
    runner,
    deps: {
      runner,
      clock: fakeClock(T0),
      env: { PATH: '/usr/bin', HOME: '/home/u', GH_HOST: 'x', SECRET_OF_THE_SERVER: 'kept' },
      store,
      homeDir: '/home/u',
      rules,
      ticketUrl: null,
    },
  };
}

/** gh's answer to an issue batch: every issue asked about open. */
function ghOpen(call: RunCall): RunResult {
  const count = call.args.filter((a) => a === '-F').length;
  const data = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `i${i}`,
      { issue: { state: 'OPEN', stateReason: null } },
    ]),
  );
  return runResult({ stdout: JSON.stringify({ data }) });
}

describe('fetchTicketStatuses (T2, T4)', () => {
  test('a command runs as a list of words: no shell, stdin closed, the home directory, the server’s environment, 10 s, 4 KiB', async (t) => {
    const w = world(t, [JIRA], () => ran('In Progress\ndoing\n'));

    const counts = await fetchTicketStatuses(w.deps, [TICKET]);

    assert.deepEqual(counts, { fetched: 1, failed: 0 });
    assert.equal(w.runner.calls.length, 1);
    const call = w.runner.calls[0] as RunCall;
    assert.equal(call.command, '/home/u/bin/status');
    assert.deepEqual(call.args, ['--key', 'ABC-123', `--url=${TICKET}`]);
    assert.equal(call.options?.cwd, '/home/u');
    assert.equal(call.options?.input, undefined, 'no input: stdin is /dev/null');
    assert.equal(call.options?.timeoutMs, STATUS_TIMEOUT_MS);
    assert.equal(STATUS_TIMEOUT_MS, 10_000);
    assert.equal(call.options?.maxOutputBytes, STATUS_OUTPUT_BYTES);
    assert.equal(STATUS_OUTPUT_BYTES, 4096);
    assert.deepEqual(call.options?.env, {
      PATH: '/usr/bin',
      HOME: '/home/u',
      GH_HOST: 'x',
      SECRET_OF_THE_SERVER: 'kept',
    });
    assert.deepEqual(w.store.ticketStatuses(), [
      {
        url: TICKET,
        status: 'In Progress',
        category: 'doing',
        okAtNs: T0,
        triedAtNs: T0,
        error: null,
      },
    ]);
  });

  test('{key} is the ticket’s short name (F18 K2): the configured ticketUrl’s key', async (t) => {
    const w = world(t, [{ match: 'https://tickets.example.com/', command: ['p', '{key}'] }], () =>
      ran('x'),
    );
    const deps = { ...w.deps, ticketUrl: 'https://tickets.example.com/t/{key}/view' };
    await fetchTicketStatuses(deps, ['https://tickets.example.com/t/ABC-9/view']);
    assert.deepEqual(w.runner.calls[0]?.args, ['ABC-9']);
  });

  test('GitHub issues go out in one gh batch; two addresses of one issue are asked once and both saved', async (t) => {
    const w = world(t, [], ghOpen);
    const other = `${ISSUE}#issuecomment-1`;

    const counts = await fetchTicketStatuses(w.deps, [
      ISSUE,
      other,
      'https://github.com/o/r/issues/9',
    ]);

    assert.deepEqual(counts, { fetched: 3, failed: 0 });
    assert.equal(w.runner.calls.length, 1);
    assert.equal(w.runner.calls[0]?.command, 'gh');
    assert.equal(w.runner.calls[0]?.args.filter((a) => a === '-F').length, 2);
    assert.deepEqual(
      w.store.ticketStatuses().map((saved) => [saved.url, saved.status, saved.category]),
      [
        ['https://github.com/o/r/issues/9', 'open', 'doing'],
        [ISSUE, 'open', 'doing'],
        [other, 'open', 'doing'],
      ],
    );
  });

  test('an address given twice is fetched once; one no provider takes is not fetched', async (t) => {
    const w = world(t, [JIRA], () => ran('New\ntodo'));
    await fetchTicketStatuses(w.deps, [
      TICKET,
      TICKET,
      'https://example.com/x',
      'https://github.com/o/r/pull/1',
    ]);
    assert.equal(w.runner.calls.length, 1);
    assert.deepEqual(
      w.store.ticketStatuses().map((saved) => saved.url),
      [TICKET],
    );
  });

  test('a failure keeps the old status and its age; it counts as failed', async (t) => {
    let answer = ran('In Review\nreview');
    const w = world(t, [JIRA], () => answer);
    await fetchTicketStatuses(w.deps, [TICKET]);
    answer = ran('', { code: null, timedOut: true });
    (w.deps.clock as ReturnType<typeof fakeClock>).advanceMs(60_000);

    const counts = await fetchTicketStatuses(w.deps, [TICKET]);

    assert.deepEqual(counts, { fetched: 0, failed: 1 });
    assert.deepEqual(w.store.ticketStatuses(), [
      {
        url: TICKET,
        status: 'In Review',
        category: 'review',
        okAtNs: T0,
        triedAtNs: T0 + 60n * 1_000_000_000n,
        error: 'the status command timed out after 10 s',
      },
    ]);
  });

  test('commands run one at a time, in order; maxCommands leaves the rest for later', async (t) => {
    let running = 0;
    let most = 0;
    const w = world(t, [ANY], async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return ran('x');
    });
    const urls = Array.from({ length: 7 }, (_, i) => `https://tickets.example.com/t/${i}`);

    const counts = await fetchTicketStatuses(w.deps, urls, { maxCommands: COMMANDS_PER_ROUND });

    assert.equal(COMMANDS_PER_ROUND, 5);
    assert.deepEqual(counts, { fetched: 5, failed: 0 });
    assert.equal(most, 1);
    assert.deepEqual(
      w.runner.calls.map((call) => call.args[0]),
      urls.slice(0, 5),
    );
  });

  test('`saved` is told after each saved result; a runner that throws is a failure saved', async (t) => {
    const w = world(t, [ANY], (call) => {
      if (call.args[0]?.endsWith('/1') === true) throw new Error('spawn /home/u/bin/other EACCES');
      return ran('x');
    });
    let told = 0;
    await fetchTicketStatuses(
      w.deps,
      ['https://tickets.example.com/t/0', 'https://tickets.example.com/t/1'],
      { saved: () => (told += 1) },
    );
    assert.equal(told, 2);
    assert.equal(
      w.store.ticketStatuses().find((saved) => saved.url.endsWith('/1'))?.error,
      'the status command could not be run: spawn /home/u/bin/other EACCES',
    );
  });

  test('once the signal fired nothing more is saved and no further command starts', async (t) => {
    const stop = new AbortController();
    const w = world(t, [ANY], () => {
      stop.abort();
      return ran('x');
    });
    const counts = await fetchTicketStatuses(
      w.deps,
      ['https://tickets.example.com/t/0', 'https://tickets.example.com/t/1'],
      { signal: stop.signal },
    );
    assert.deepEqual(counts, { fetched: 0, failed: 0 });
    assert.equal(w.runner.calls.length, 1);
    assert.deepEqual(w.store.ticketStatuses(), []);
  });
});

describe('the layering (design 11)', () => {
  test('nothing in src/sessions/ imports src/ticket-status.ts: the list model asks github.ts', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'sessions');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts'))) {
      const text = readFileSync(join(dir, name), 'utf8');
      const from = [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
      assert.ok(
        !from.some((path) => path?.includes('ticket-status')),
        `${name}: ${from.join(', ')}`,
      );
    }
  });
});
