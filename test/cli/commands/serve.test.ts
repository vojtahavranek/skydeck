// `skydeck serve` as a process of its own (S2 5.2, 5.5; plan task 23, A19, A31, A32): through the
// launcher `bin/skydeck serve` as a child, with SKYDECK_TEST_PORT=0 and the first interop candidate
// in the sandbox. Its refusal under Claude Code, its core limit and the one its programs get back,
// what a page's data never leaves in its log, and its stop on SIGTERM.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { parentPidFromStat, procStartFromStat } from '../../../src/claude/procstat.ts';
import { uncaughtLine } from '../../../src/cli/commands/serve.ts';
import { ensureSecret, pageProof } from '../../../src/window/auth.ts';
import { readServerJson } from '../../../src/window/runtime.ts';
import type { ServerJson } from '../../../src/window/runtime.ts';
import { procStartOf, stillRuns, until } from '../../helpers/keeper.ts';
import { killKeepersIn } from '../../helpers/kill.ts';
import { freshNonce } from '../../helpers/pages.ts';
import { readRecords, waitForRecord } from '../../helpers/standin.ts';
import { connectTestPage, serverSandbox, WAIT_MS } from '../../helpers/window.ts';
import type { ServerSandbox } from '../../helpers/window.ts';

const LAUNCHER = fileURLToPath(new URL('../../../bin/skydeck', import.meta.url));
const MARKER = 'marker-7f3a9c';

/** A line of /proc/<pid>/limits: "Max core file size" with its soft and hard value. */
function coreLimits(pid: number | 'self'): { soft: string; hard: string } {
  const line = readFileSync(`/proc/${pid}/limits`, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('Max core file size'));
  assert.ok(line !== undefined);
  const [soft = '', hard = ''] = line.slice('Max core file size'.length).trim().split(/\s+/);
  return { soft, hard };
}

interface Serve {
  child: ChildProcess;
  exited: Promise<number | null>;
  stderr(): string;
  /** server.json once the server wrote it, checked to be the child's own process. */
  json: ServerJson;
}

/**
 * The sandbox for `bin/skydeck serve` children (serverSandbox's), and a starter. Call first: the
 * cleanup, registered before the sandbox's, ends every child's server (SIGTERM, only to a process
 * confirmed to be the child's), then the keepers it started and their programs.
 */
function serveSandbox(t: TestContext): {
  d: ServerSandbox;
  serve(options?: { foreground?: boolean; env?: Record<string, string | undefined> }): Serve;
  started(serve: Omit<Serve, 'json'>): Promise<Serve>;
} {
  const children: Omit<Serve, 'json'>[] = [];
  let sandboxed: ServerSandbox | null = null;
  t.after(async () => {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) {
        const server = sandboxed === null ? null : ownServer(sandboxed, child.child);
        if (server !== null) process.kill(server.pid, 'SIGTERM');
        await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      }
    }
    if (sandboxed === null) return;
    killKeepersIn(sandboxed.s, sandboxed.box.runtimeDir);
    for (const record of readRecords(sandboxed.record)) {
      if (record.ev !== 'start') continue;
      const start = procStartOf(record.pid);
      if (start !== null)
        await until(() => !stillRuns(record.pid, start), 'a program ended', WAIT_MS);
    }
  });
  const d = serverSandbox(t);
  sandboxed = d;
  d.s.link('dirname', 'readlink', 'mktemp', 'cat', 'rm', 'date');
  const tmp = join(d.s.root, 'tmp');
  mkdirSync(tmp);
  const log = join(d.s.skydeckHome, 'state', 'server.log');
  const serve = (
    options: { foreground?: boolean; env?: Record<string, string | undefined> } = {},
  ) => {
    const foreground = options.foreground ?? true;
    const env = d.s.env({
      STANDIN_RECORD: d.record,
      SKYDECK_NODE: process.execPath,
      SKYDECK_TEST_PORT: '0',
      SKYDECK_TEST_INTEROP_FIRST: d.interopFirst,
      TMPDIR: tmp,
      ...options.env,
    });
    mkdirSync(join(d.s.skydeckHome, 'state'), { recursive: true });
    // As skydeck window starts it (S2 5.2): without --foreground its output goes to server.log.
    const out = foreground ? 'pipe' : openSync(log, 'a', 0o600);
    const child = spawn(LAUNCHER, foreground ? ['serve', '--foreground'] : ['serve'], {
      cwd: '/',
      env,
      stdio: ['ignore', out, out],
    });
    if (typeof out === 'number') closeSync(out);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });
    const entry = { child, exited, stderr: () => stderr };
    children.push(entry);
    return entry as Serve;
  };
  const started = async (entry: Omit<Serve, 'json'>): Promise<Serve> => {
    let json: ServerJson | null = null;
    await until(
      () => {
        if (entry.child.exitCode !== null) {
          assert.fail(`serve exited ${entry.child.exitCode}: ${entry.stderr()}`);
        }
        json = ownServer(d, entry.child);
        return json !== null;
      },
      'server.json of the child',
      WAIT_MS,
    );
    return { ...entry, json: json as unknown as ServerJson };
  };
  return { d, serve, started };
}

/**
 * server.json when it names the child's server: alive with its process start, and a child of the
 * launcher the test started (node runs in the launcher's subshell). Never anything else.
 */
function ownServer(d: ServerSandbox, child: ChildProcess): ServerJson | null {
  const json = readServerJson(d.platform.files, d.files.serverJson);
  if (json === null || child.pid === undefined) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${json.pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const ok =
    json.pid > 1 &&
    json.pid !== process.pid &&
    procStartFromStat(stat) === json.procStart &&
    parentPidFromStat(stat) === child.pid;
  return ok ? json : null;
}

describe('skydeck serve (S2 5.2)', () => {
  test('CLAUDECODE set → exit 13 and the line, nothing started', (t) => {
    const { d } = serveSandbox(t);
    const tmp = join(d.s.root, 'tmp-13');
    mkdirSync(tmp);
    const result = spawnSync(LAUNCHER, ['serve', '--foreground'], {
      cwd: '/',
      encoding: 'utf8',
      env: d.s.env({
        CLAUDECODE: '1',
        SKYDECK_NODE: process.execPath,
        SKYDECK_TEST_PORT: '0',
        SKYDECK_TEST_INTEROP_FIRST: d.interopFirst,
        TMPDIR: tmp,
      }),
    });
    assert.equal(result.status, 13, result.stderr);
    // Node.js 24.12 warns that SQLite is experimental: its own lines (S2 5.2) are left out.
    assert.deepEqual(
      result.stderr
        .split('\n')
        .filter((line) => line !== '' && !/ExperimentalWarning|--trace-warnings/.test(line)),
      [
        "skydeck: the window's server is not started from inside a Claude Code session: every session in the window would inherit that session's environment; run skydeck window in a terminal of your own",
      ],
    );
    assert.equal(existsSync(d.files.serverJson), false);
    assert.equal(d.deck.store.getKv('window_server'), null);
  });

  test("the server's soft core limit is 1 byte with the old hard limit; a keeper's program gets the soft limit back", async (t) => {
    const { d, serve, started } = serveSandbox(t);
    const own = coreLimits('self');
    const server = await started(serve());
    assert.deepEqual(coreLimits(server.json.pid), { soft: '1', hard: own.hard });

    const dir = join(d.s.home, 'fresh');
    mkdirSync(dir);
    const page = await connectTestPage(t, d, server.json);
    const result = await page.act({
      kind: 'new',
      dir,
      label: '',
      group: '',
      flags: '',
      cols: 80,
      rows: 24,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const start = await waitForRecord(d.record, (record) => record.ev === 'start', WAIT_MS);
    assert.ok(start.ev === 'start');
    assert.equal(start.coreSoft, own.soft);
  });

  test('a malformed hello, start and input carrying a marker leave it in no line of server.log', async (t) => {
    const { d, serve, started } = serveSandbox(t);
    const server = await started(serve({ foreground: false }));
    const origin = `http://127.0.0.1:${server.json.port}`;
    const secret = ensureSecret(d.deck.store, d.platform.randomBytes);

    /** A connection that has the challenge; `hello` true: proven, too (start not sent). */
    const connect = async (hello: boolean) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.json.port}/ws`, { origin });
      t.after(() => {
        ws.terminate();
      });
      ws.on('error', () => {});
      const messages: string[] = [];
      ws.on('message', (data) => {
        messages.push((data as Buffer).toString('utf8'));
      });
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      await until(() => messages.length > 0, 'the challenge', WAIT_MS);
      const sN = (JSON.parse(messages[0] ?? '{}') as { nonce: string }).nonce;
      if (hello) {
        const cN = freshNonce();
        ws.send(
          JSON.stringify({
            t: 'hello',
            protocol: 1,
            mode: 'key',
            nonce: cN,
            proof: pageProof(secret, 'key', sN, cN, origin),
          }),
        );
        await until(() => messages.length > 1, 'the welcome', WAIT_MS);
      }
      return { ws, closed };
    };

    const one = await connect(false);
    one.ws.send(`{"t":"hello","protocol":1,"mode":"key","nonce":"${MARKER}","proof":"${MARKER}`);
    await one.closed;
    const two = await connect(true);
    two.ws.send(
      JSON.stringify({
        t: 'start',
        assetVersion: MARKER,
        windowId: MARKER,
        focused: true,
        theme: { fg: MARKER, bg: MARKER },
      }),
    );
    await two.closed;
    const page = await connectTestPage(t, d, server.json);
    page.sendRaw(JSON.stringify({ t: 'input', term: MARKER, data: MARKER }));
    await page.closed;

    const log = readFileSync(join(d.s.skydeckHome, 'state', 'server.log'), 'utf8');
    assert.ok(log.includes('hello refused'), log);
    assert.equal(log.includes(MARKER), false, log);
  });

  test('SIGTERM: every page gets bye, then exit 0 after S2 5.5', async (t) => {
    const { d, serve, started } = serveSandbox(t);
    const server = await started(serve());
    const page = await connectTestPage(t, d, server.json);
    assert.ok(ownServer(d, server.child) !== null, 'still the child’s own server');
    process.kill(server.json.pid, 'SIGTERM');
    const bye = await page.next('bye', 'the bye', WAIT_MS);
    assert.match(bye.reason, /stopped/);
    assert.equal(await server.exited, 0, server.stderr());
    for (const path of [d.files.serverJson, d.files.serverPid, d.files.serverSock]) {
      assert.equal(existsSync(path), false, `${path} is gone`);
    }
    assert.equal(d.deck.store.getKv('window_server'), null);
  });
});

describe('uncaughtLine (S2 5.2)', () => {
  test("an error's name and stack frames, never its message, also one of several lines", () => {
    const error = new SyntaxError(`Unexpected token in JSON\n  "${MARKER}"\nat position 3`);
    const line = uncaughtLine(error);
    assert.match(line, /^SyntaxError/);
    assert.match(line, / at /, 'the frames');
    assert.equal(line.includes(MARKER), false, line);
    assert.equal(line.includes('position 3'), false, line);
  });

  test('something thrown that is not an Error', () => {
    assert.equal(uncaughtLine(`${MARKER}`), 'a value that is not an Error (string)');
  });
});
