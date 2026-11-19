// Follow-up F19: the status programs the documents give, and the real runner's words, run for real
// in a test sandbox (never the network, never a real tracker). A program named by a relative path
// is found relative to the home directory (the command's working directory, T2); one that is not
// executable fails in exactly the words W38 quotes; W38's three-line stand-in, made by the very
// commands docs/manual-checks.md gives, answers `In Progress` / `doing` through a rule; and the
// example program of docs/install.md is valid Python whose failure path — no token file, which it
// reads before it would ask anything — prints one line on stderr and exits 1.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { TicketStatusRule } from '../src/platform/config.ts';
import { realPlatform } from '../src/platform/real.ts';
import { openStore } from '../src/store/store.ts';
import { NO_KEY, fetchTicketStatuses } from '../src/ticket-status.ts';
import { sandbox } from './helpers/sandbox.ts';
import type { Sandbox } from './helpers/sandbox.ts';

const TICKET = 'https://example.com/try/TRY-1';
const DOCS = join(import.meta.dirname, '..', 'docs');

/** Reads `TICKET`'s status with `rule` through the real runner, in `s`; the row saved. */
async function readWith(t: TestContext, s: Sandbox, rule: TicketStatusRule) {
  const store = openStore(join(s.root, 'skydeck.db'));
  t.after(() => {
    store.close();
  });
  const { runner, clock } = realPlatform();
  await fetchTicketStatuses(
    { runner, clock, env: s.env(), store, homeDir: s.home, rules: [rule], ticketUrl: null },
    [TICKET],
  );
  const [row] = store.ticketStatuses();
  assert.ok(row !== undefined, 'a row was saved');
  return row;
}

/** The code block of `language` that follows `marker` in `file` of docs/. */
function block(file: string, marker: string, language: string): string {
  const text = readFileSync(join(DOCS, file), 'utf8');
  const at = text.indexOf(marker);
  assert.ok(at !== -1, `${file} has ${marker}`);
  const start = text.indexOf(`\`\`\`${language}\n`, at);
  assert.ok(start !== -1, `a ${language} block after ${marker}`);
  const body = start + language.length + 4;
  return text.slice(body, text.indexOf('\n```', body) + 1);
}

test('a program named by a relative path runs from the home directory', async (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.home, 'bin'));
  writeFileSync(join(s.home, 'bin', 'status'), '#!/bin/sh\nprintf "In Review\\nreview\\n"\n');
  chmodSync(join(s.home, 'bin', 'status'), 0o755);

  const row = await readWith(t, s, { match: 'https://example.com/try/', command: ['bin/status'] });

  assert.deepEqual([row.status, row.category, row.error], ['In Review', 'review', null]);
});

test('an address with spaces, quotes, `;` and `$(…)` reaches the program as one argument, unchanged; nothing in it runs', async (t) => {
  const s = sandbox(t);
  const program = join(s.home, 'record-args');
  // Writes each argument it gets on a line of its own, then answers a status.
  writeFileSync(
    program,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('ok\\n');\n`,
  );
  chmodSync(program, 0o755);
  const address = `https://example.com/try/a b "c" 'd';$(touch made-by-the-address)\`touch made-too\`|&>x`;
  const store = openStore(join(s.root, 'skydeck.db'));
  t.after(() => {
    store.close();
  });
  const { runner, clock } = realPlatform();

  await fetchTicketStatuses(
    {
      runner,
      clock,
      env: s.env(),
      store,
      homeDir: s.home,
      rules: [{ match: 'https://example.com/try/', command: [program, '{url}', 'plain'] }],
      ticketUrl: null,
    },
    [address],
  );

  const args = JSON.parse(readFileSync(join(s.home, 'args.json'), 'utf8')) as string[];
  assert.deepEqual(args, [address, 'plain'], 'byte for byte, one argument each');
  assert.equal(store.ticketStatuses()[0]?.status, 'ok');
  for (const made of ['made-by-the-address', 'made-too', 'x']) {
    assert.ok(!readdirSync(s.home).includes(made), `${made} was not made`);
  }
});

test("{key} is the ticket's key, whole and as written; an address that gives none is not run and fails in words, keeping the old status", async (t) => {
  const s = sandbox(t);
  const program = join(s.home, 'record-key');
  writeFileSync(
    program,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync('keys.txt', process.argv[2] + '\\n');\nprocess.stdout.write('Open\\ndoing\\n');\n`,
  );
  chmodSync(program, 0o755);
  const store = openStore(join(s.root, 'skydeck.db'));
  t.after(() => {
    store.close();
  });
  const { runner, clock } = realPlatform();
  const T = 'https://tickets.example.com';
  const uuid = '3f2b9c1e-8d4a-4b6e-9f0c-1a2b3c4d5e6f';
  const read = (urls: string[], ticketUrl: string | null = null) =>
    fetchTicketStatuses(
      {
        runner,
        clock,
        env: s.env(),
        store,
        homeDir: s.home,
        rules: [{ match: `${T}/`, command: [program, '{key}'] }],
        ticketUrl,
      },
      urls,
    );
  const keysRead = (): string[] => {
    try {
      return readFileSync(join(s.home, 'keys.txt'), 'utf8').split('\n').slice(0, -1);
    } catch {
      return [];
    }
  };

  await read([
    `${T}/browse/ABC-123`,
    `${T}/t/a-very-long-slug-of-the-ticket`,
    `${T}/tickets/${uuid}`,
  ]);
  await read([`${T}/t/XYZ-7/view`], `${T}/t/{key}/view`);
  assert.deepEqual(
    keysRead().sort(),
    ['ABC-123', 'XYZ-7', 'a-very-long-slug-of-the-ticket', uuid].sort(),
  );

  // Saved once with a status: a later read of an address without a key keeps it.
  store.saveTicketStatus(`${T}/browse/--help`, {
    ok: true,
    atNs: 1n,
    status: 'Done',
    category: 'done',
  });
  await read([`${T}/browse/--help`, `${T}/t/-x`, `${T}/t/%2D%2Dconfig%3D%2Ftmp%2Fx`]);
  assert.equal(keysRead().length, 4, 'none of the three was run');
  const byUrl = new Map(store.ticketStatuses().map((row) => [row.url, row]));
  for (const url of [`${T}/browse/--help`, `${T}/t/-x`, `${T}/t/%2D%2Dconfig%3D%2Ftmp%2Fx`]) {
    assert.equal(byUrl.get(url)?.error, NO_KEY, url);
  }
  assert.equal(NO_KEY, "the ticket's address gives no key for {key}; use {url} in the rule");
  assert.deepEqual([byUrl.get(`${T}/browse/--help`)?.status], ['Done'], 'the old status kept');

  // A rule with {url} only runs for any address.
  await fetchTicketStatuses(
    {
      runner,
      clock,
      env: s.env(),
      store,
      homeDir: s.home,
      rules: [{ match: `${T}/`, command: [program, '{url}'] }],
      ticketUrl: null,
    },
    [`${T}/t/-x`],
  );
  assert.equal(keysRead().at(-1), `${T}/t/-x`);
});

test('a program that is not executable fails in the words W38 quotes', async (t) => {
  const s = sandbox(t);
  const program = join(s.home, 'status');
  writeFileSync(program, '#!/bin/sh\necho x\n');
  chmodSync(program, 0o644);

  const row = await readWith(t, s, { match: 'https://example.com/try/', command: [program] });

  assert.equal(row.error, `the status command could not be run: spawn ${program} EACCES`);
  assert.equal(row.status, null);
  const w38 = readFileSync(join(DOCS, 'manual-checks.md'), 'utf8');
  assert.ok(w38.includes('the status command could not be run: spawn'), 'W38 names the words');
});

test("W38's stand-in, made by its own commands, answers In Progress / doing through a rule", async (t) => {
  const s = sandbox(t);
  s.link('sh', 'mkdir', 'chmod', 'cat');
  mkdirSync(join(s.home, 'skydeck-try'));
  const commands = block('manual-checks.md', '**The stand-in program.**', 'sh');
  const { runner } = realPlatform();

  const made = await runner.run('sh', ['-c', commands], { env: s.env(), cwd: s.home });

  assert.deepEqual([made.code, made.stdout, made.stderr], [0, 'In Progress\ndoing\n', '']);
  const program = join(s.home, 'skydeck-try', 'status', 'status');
  assert.equal(
    readFileSync(program, 'utf8')
      .split('\n')
      .filter((line) => line !== '').length,
    3,
  );
  const row = await readWith(t, s, { match: 'https://example.com/try/', command: [program] });
  assert.deepEqual([row.status, row.category, row.error], ['In Progress', 'doing', null]);
});

test("install.md's example program is valid Python; without its token file it says why on one line and exits 1", async (t) => {
  const s = sandbox(t);
  s.link('python3');
  const script = join(s.root, 'tickets-status');
  writeFileSync(script, block('install.md', '**An example**', 'python'));
  const { runner } = realPlatform();

  const compiled = await runner.run(
    'python3',
    ['-I', '-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', script],
    { env: s.env() },
  );
  assert.equal(compiled.code, 0, compiled.stderr);
  // No ~/.config/tickets-token in the sandbox's home: it fails at reading it, before any request.
  const failed = await runner.run('python3', ['-I', script, 'ABC-123'], {
    env: s.env(),
    timeoutMs: 10_000,
  });
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  const lines = failed.stderr.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, failed.stderr);
  assert.match(lines[0] ?? '', /^tickets\.example\.com: \[Errno 2\] No such file or directory: /);
});

test('every command line W38 gives is valid sh (sh -n), the six answers and the stand-in included', async (t) => {
  const s = sandbox(t);
  s.link('sh');
  const text = readFileSync(join(DOCS, 'manual-checks.md'), 'utf8');
  const start = text.indexOf('## W38.');
  assert.ok(start !== -1, 'W38 is there');
  const end = text.indexOf('\n## ', start + 1);
  const w38 = text.slice(start, end === -1 ? undefined : end);
  const commands: string[] = [];
  // The lines of its sh blocks.
  for (const [, body] of w38.matchAll(/```sh\n([^]*?)\n\s*```/g)) {
    for (const line of (body ?? '').split('\n')) {
      if (line.trim() !== '') commands.push(line.trim());
    }
  }
  // Its inline commands (a span may be wrapped over two lines of the text).
  const words = /^(?:printf|chmod|cp|diff|cmp|rm|mkdir|ls|cat|test|skydeck|echo)\b/;
  const outside = w38.replaceAll(/```[^]*?```/g, '');
  for (const [, span] of outside.matchAll(/`([^`]+)`/g)) {
    const command = (span ?? '').replaceAll(/\s*\n\s*/g, ' ').trim();
    if (words.test(command)) commands.push(command);
  }
  assert.ok(commands.length >= 20, `${commands.length} commands found`);
  assert.ok(commands.some((command) => command.includes("'Rejected' 'closed'")));
  const { runner } = realPlatform();
  for (const command of commands) {
    // A placeholder such as <short id> stands for one word.
    const line = command.replaceAll(/<[^<>]+>/g, 'X');
    const checked = await runner.run('sh', ['-n', '-c', line], { env: s.env() });
    assert.equal(checked.code, 0, `${command}: ${checked.stderr}`);
  }
});
