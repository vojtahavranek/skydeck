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
import { fetchTicketStatuses } from '../src/ticket-status.ts';
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
      rules: [{ match: 'https://example.com/try/', command: [program, '{url}', 'key={key}'] }],
      ticketUrl: null,
    },
    [address],
  );

  const args = JSON.parse(readFileSync(join(s.home, 'args.json'), 'utf8')) as string[];
  assert.equal(args.length, 2);
  assert.equal(args[0], address);
  assert.ok(args[1]?.startsWith('key='));
  assert.equal(store.ticketStatuses()[0]?.status, 'ok');
  for (const made of ['made-by-the-address', 'made-too', 'x']) {
    assert.ok(!readdirSync(s.home).includes(made), `${made} was not made`);
  }
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
