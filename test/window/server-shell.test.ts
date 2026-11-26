// A session's shell through the window's server (issue #199, S2 7.10, 15.1): a page's `act shell`
// on a session resumed into the window, with real keepers — the session terminal runs the
// stand-in `claude`, the shell the stand-in shell (test/helpers/shell-standin.ts). The act opens
// one shell in the session's folder and lists it in `list.shells`, never as a row, a number or a
// terminal of the list; each refusal is answered in its words with nothing started; nothing of the
// shell reaches the store; and the act names only the terminal: the program, its folder and its
// environment are the server's. A shell's life (step 2.2): its own `exit`; the end of its session's
// program (End session with each mark, `/exit`, a crash) ends it and what runs in it; closing the
// ended terminal leaves no keeper of it; a restart of the server finds it again with its screen,
// also after a restart of the session; a `claude` started in it runs elsewhere, never as a terminal
// of the window. In the test process (A19) on realTestPlatform.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Holder } from '../../src/sessions/types.ts';
import { serverEnvironment, shellEnvironment } from '../../src/window/env.ts';
import { holdersInWindow } from '../../src/window/in-window.ts';
import type { ListMessage, RowPayload, SnapMessage } from '../../src/window/protocol.ts';
import { SHELL_OPEN_TEXTS } from '../../src/window/shells.ts';
import { procStartOf, stillRuns } from '../helpers/keeper.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { SHELL_PROMPT } from '../helpers/shell-standin.ts';
import { readRecords } from '../helpers/standin.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type {
  ServerSandbox,
  ServerSandboxOptions,
  TestPage,
  TestServer,
} from '../helpers/window.ts';

const WAIT_MS = 15_000;
const RESTARTING = 'skydeck is restarting this session';

async function until(condition: () => boolean, what: string, ms = WAIT_MS): Promise<void> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function rowOf(list: ListMessage, sessionId: string): RowPayload | undefined {
  return rowsOf(list).find((row) => row.id === sessionId);
}

/** What the keepers' stdin carried: each spec the server wrote, by terminal id. */
type Specs = Map<string, Record<string, unknown>>;

interface InWindow {
  d: ServerSandbox;
  server: TestServer;
  page: TestPage;
  /** S1's terminal in the window. */
  term: string;
  /** Its folder (the launch's working directory). */
  dir: string;
  specs: Specs;
  list: ListMessage;
}

/**
 * S1 resumed into a terminal of the window from a page that selects it, running and showing its
 * session; every keeper spec the server writes is kept.
 */
async function inWindow(t: TestContext, options: ServerSandboxOptions = {}): Promise<InWindow> {
  const d = serverSandbox(t, options);
  d.resumable(S1);
  d.resumable(S2);
  const specs: Specs = new Map();
  const server = await d.start({
    platform: (p) => ({
      ...p,
      processes: {
        ...p.processes,
        async startDetached(command, args, opts) {
          if (typeof opts.input === 'string') {
            const spec = JSON.parse(opts.input) as Record<string, unknown>;
            specs.set(spec['id'] as string, spec);
          }
          return p.processes.startDetached(command, args, opts);
        },
      },
    }),
  });
  const page = await connectTestPage(t, d, server.server, { view: { selected: S1 } });
  const resumed = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const list = await page.list(
    (candidate) =>
      candidate.terminals.some((term) => term.sessionId === S1 && term.state === 'running') &&
      rowOf(candidate, S1)?.state !== 'not-running',
    'S1 running in a terminal of the window',
  );
  const term = list.terminals.find((one) => one.sessionId === S1)?.id;
  assert.ok(term !== undefined);
  const info = server.server.hub.list().find((one) => one.id === term);
  assert.ok(info !== undefined && info.program !== null);
  return { d, server, page, term, dir: info.dir, specs, list };
}

/** The `.pid` files of the sandbox's keepers. */
function pidFiles(d: ServerSandbox): string[] {
  return readdirSync(d.box.termsDir).filter((name) => name.endsWith('.pid'));
}

/** A page attached to terminal `id`: what its screen has shown so far (the snap and the output). */
async function attached(page: TestPage, id: string): Promise<() => string> {
  page.send({ t: 'attach', term: id, cols: 80, rows: 12 });
  const snap: SnapMessage = await page.next('snap', `the snap of ${id}`);
  assert.equal(snap.term, id);
  return () => snap.data + page.output(snap.ch);
}

const prompts = (screen: string): number => screen.split(SHELL_PROMPT).length - 1;

/** `line` typed into the shell `id`, then the file `name` of the sandbox's home as it wrote it. */
async function written(w: InWindow, id: string, line: string, name: string): Promise<string> {
  const path = join(w.d.s.home, name);
  w.page.send({ t: 'input', term: id, data: `${line}\r` });
  await until(() => existsSync(path) && readFileSync(path, 'utf8').endsWith('\n'), name);
  return readFileSync(path, 'utf8');
}

/** `act shell` for S1's terminal: its answer, and the shell the next list brings when it is ok. */
async function opened(w: InWindow): Promise<{ id: string; list: ListMessage }> {
  const result = await w.page.act({ kind: 'shell', term: w.term, cols: 80, rows: 12 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const list = await w.page.list(
    (candidate) => (candidate.shells ?? []).some((shell) => shell.of === w.term),
    'the shell in list.shells',
  );
  const shell = (list.shells ?? []).find((one) => one.of === w.term);
  assert.ok(shell !== undefined);
  return { id: shell.id, list };
}

/** A list as the server makes it now: the view filtered to nothing, then back (S1 selected). */
async function fresh(page: TestPage): Promise<ListMessage> {
  page.view({ selected: S1, filter: 'no-such-session' });
  await page.list((list) => rowsOf(list).length === 0, 'the list filtered to nothing');
  page.view({ selected: S1 });
  return page.list((list) => rowsOf(list).length > 0, 'the list again');
}

describe('act shell through the server (issue #199, S2 7.10)', () => {
  test("A1: the act opens one login shell in the session's folder, listed in list.shells under the terminal; a second act opens none", async (t) => {
    const w = await inWindow(t);
    const before = pidFiles(w.d).length;

    const { id, list } = await opened(w);

    assert.deepEqual(
      (list.shells ?? []).map((shell) => [shell.of, shell.state, shell.cols, shell.rows]),
      [[w.term, 'running', 80, 12]],
    );
    const screen = await attached(w.page, id);
    await until(() => prompts(screen()) >= 1, "the stand-in shell's prompt");
    assert.equal(await written(w, id, 'pwd >"$HOME/pwd.txt"', 'pwd.txt'), `${w.dir}\n`);

    const again = await w.page.act({ kind: 'shell', term: w.term, cols: 80, rows: 12 });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(
      (w.server.server.hub.shells?.() ?? []).map((shell) => shell.id),
      [id],
      'still one shell',
    );
    assert.equal(pidFiles(w.d).length, before + 1, 'one keeper more than before the first act');
  });

  test('A2: an unknown terminal, an ended one and one a restart holds are refused in their words; nothing is started', async (t) => {
    const w = await inWindow(t);
    const before = pidFiles(w.d).length;
    const refusedWith = async (term: string, words: string): Promise<void> => {
      const result = await w.page.act({ kind: 'shell', term, cols: 80, rows: 12 });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.error, words);
      assert.deepEqual(w.server.server.hub.shells?.() ?? [], [], 'no shell');
      assert.equal(pidFiles(w.d).length, before, 'no keeper more');
    };

    // A session that does not run in the window: no terminal of it is named.
    await refusedWith('ffffffffffff', SHELL_OPEN_TEXTS.noTerminal);

    // A terminal a restart holds: the stand-in ends 3 s after its hang-up.
    const hupLates = (): number =>
      readRecords(w.d.record).filter((one) => one.ev === 'hup-late').length;
    w.page.send({ t: 'input', term: w.term, data: '/hup-late 3\r' });
    await until(() => hupLates() === 1, '/hup-late read');
    const other = await connectTestPage(t, w.d, w.server.server);
    const restart = other.act({ kind: 'restart', term: w.term, sessionId: S1 }, 30_000);
    await w.page.list(
      (list) => list.terminals.some((term) => term.id === w.term && term.restarting === true),
      'the terminal held by the restart',
    );
    await refusedWith(w.term, RESTARTING);
    const restarted = await restart;
    assert.equal(restarted.ok, true, JSON.stringify(restarted));

    // An ended terminal: the resumed session's program ends by /exit.
    const list = await w.page.list(
      (candidate) =>
        candidate.terminals.some(
          (term) => term.sessionId === S1 && term.id !== w.term && term.state === 'running',
        ),
      'S1 running in its new terminal',
    );
    const next = list.terminals.find((term) => term.sessionId === S1 && term.state === 'running');
    assert.ok(next !== undefined);
    w.page.send({ t: 'input', term: next.id, data: '/exit\r' });
    await w.page.list(
      (candidate) =>
        candidate.terminals.some((term) => term.id === next.id && term.state === 'ended'),
      'the new terminal ended',
    );
    const keepers = pidFiles(w.d).length;
    const result = await w.page.act({ kind: 'shell', term: next.id, cols: 80, rows: 12 });
    assert.equal(result.error, SHELL_OPEN_TEXTS.ended);
    assert.equal(pidFiles(w.d).length, keepers, 'no keeper more');
  });

  test('A2: a `new` terminal whose session has not started yet is refused in its words; nothing is started', async (t) => {
    // A program that never reports a session: the terminal runs it and shows no session.
    const probe = serverSandbox(t);
    probe.s.link('sleep');
    const silent = join(probe.s.bin, 'silent-claude');
    writeFileSync(silent, '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
    const config = join(probe.s.skydeckHome, 'config', 'config.json');
    const configured = JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown>;
    writeFileSync(config, JSON.stringify({ ...configured, claudeCommand: silent }));
    const server = await probe.start();
    const page = await connectTestPage(t, probe, server.server);
    const started = await page.act({
      kind: 'new',
      dir: probe.s.home,
      label: '',
      group: '',
      flags: '',
      cols: 80,
      rows: 24,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const [term] = server.server.hub.list();
    assert.ok(term !== undefined && term.sessionId === null && term.kind === 'new');
    const before = pidFiles(probe).length;

    const result = await page.act({ kind: 'shell', term: term.id, cols: 80, rows: 12 });

    assert.equal(result.error, SHELL_OPEN_TEXTS.notStarted);
    assert.deepEqual(server.server.hub.shells?.() ?? [], []);
    assert.equal(pidFiles(probe).length, before, 'no keeper more');
  });

  test("A3: with a shell open and output in it, the rows, counts, need-you, terminals and numbers are as before, no notification came, and the store's events, metas and keys are unchanged", async (t) => {
    const w = await inWindow(t);
    // A second session in the window, so that numbers are in play.
    const second = await w.page.act({ kind: 'resume', sessionId: S2, cols: 80, rows: 24 });
    assert.equal(second.ok, true, JSON.stringify(second));
    await w.page.list(
      (list) => rowOf(list, S2)?.state !== undefined && rowOf(list, S2)?.state !== 'not-running',
      'S2 running',
    );
    await new Promise((resolve) => setTimeout(resolve, 2500)); // the ticks settle
    const settled = await fresh(w.page);
    const store = w.d.deck.store;
    const facts = (): string =>
      JSON.stringify(
        {
          events: store.events(),
          metas: store.allMeta(),
          kv: store.kvEntries(''),
        },
        (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
      );
    const before = facts();
    const notifies = (): number =>
      w.page.all.filter((item) => 'text' in item && item.text.t === 'notify').length;
    const notifiesBefore = notifies();
    const shape = (list: ListMessage): string =>
      JSON.stringify({
        sections: list.sections,
        counts: list.counts,
        needYou: list.needYou,
        terminals: list.terminals,
        doneHidden: list.doneHidden,
      });

    const { id } = await opened(w);
    const screen = await attached(w.page, id);
    await until(() => prompts(screen()) >= 1, 'the prompt');
    w.page.send({ t: 'input', term: id, data: 'printf "out %s\\n" put; printf "\\a"\r' });
    await until(() => screen().includes('out put'), 'the output');
    await new Promise((resolve) => setTimeout(resolve, 2500)); // two ticks with the shell open
    const after = await fresh(w.page);

    assert.equal((after.shells ?? []).length, 1, 'the shell is open');
    assert.equal(shape(after), shape(settled));
    assert.ok(
      rowsOf(after).every((row) => row.id === S1 || row.id === S2),
      'no row of the shell',
    );
    assert.deepEqual(
      after.terminals.map((term) => term.slot).sort(),
      [1, 2],
      'no number for the shell',
    );
    assert.equal(notifies(), notifiesBefore, 'no notification');
    assert.equal(facts(), before, 'the store unchanged');
  });

  test("A12: the shell's program, argument, folder and environment are the server's; an act that carries one more field is refused and its page's connection closed (1008)", async (t) => {
    const w = await inWindow(t);
    for (const field of ['program', 'argv', 'file', 'cwd', 'dir', 'env', 'flags', 'sessionId']) {
      const page = await connectTestPage(t, w.d, w.server.server);
      page.send({
        t: 'act',
        id: 1,
        kind: 'shell',
        term: w.term,
        cols: 80,
        rows: 12,
        [field]: field === 'env' ? { PATH: '/usr/bin' } : '/usr/bin/env',
      });
      const closed = await Promise.race([
        page.closed,
        new Promise<{ code: number }>((resolve) => setTimeout(() => resolve({ code: 0 }), WAIT_MS)),
      ]);
      assert.equal(closed.code, 1008, field);
    }
    assert.deepEqual(w.server.server.hub.shells?.() ?? [], [], 'none was opened');

    const { id } = await opened(w);

    const spec = w.specs.get(id);
    assert.ok(spec !== undefined, "the shell's keeper spec");
    const session = w.specs.get(w.term);
    assert.ok(session !== undefined, "the session terminal's keeper spec");
    assert.equal(spec['file'], w.d.platform.loginShell, "the account's login shell (the stand-in)");
    assert.deepEqual(spec['argv'], ['-shell-standin'], 'a login shell, by its name');
    assert.equal(spec['cwd'], w.dir, "the session terminal's folder");
    const { env: serverEnv } = serverEnvironment(w.d.platform.env);
    assert.deepEqual(
      spec['env'],
      shellEnvironment(serverEnv, { cwd: w.dir, interop: null }),
      "the server's environment, cleaned",
    );
    assert.deepEqual(spec['env'], session['env'], "what the session terminal's program got");
    const screen = await attached(w.page, id);
    await until(() => prompts(screen()) >= 1, 'the prompt');
    assert.equal(
      await written(w, id, `printf '%s\\n' "$PWD" "$TERM" >"$HOME/env.txt"`, 'env.txt'),
      `${w.dir}\nxterm-256color\n`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Step 2.2: a shell's life through the server

interface Program {
  pid: number;
  procStart: number;
}

/** A shell opened under S1's terminal, attached by the page, at its prompt. */
interface Shell {
  id: string;
  screen: () => string;
  program: Program;
}

async function openShell(w: InWindow): Promise<Shell> {
  const { id } = await opened(w);
  const screen = await attached(w.page, id);
  await until(() => prompts(screen()) >= 1, "the stand-in shell's prompt");
  const program = (w.server.server.hub.shells?.() ?? []).find((one) => one.id === id)?.program;
  assert.ok(program !== null && program !== undefined, "the shell's program");
  return { id, screen, program };
}

/**
 * `line` typed into the shell, and the process whose pid it printed as `<word> <pid>` (read from
 * the output, not from the echo of the line). Killed at the test's end if it still runs.
 */
async function startedIn(
  t: TestContext,
  w: InWindow,
  shell: Shell,
  line: string,
  word: string,
): Promise<Program> {
  w.page.send({ t: 'input', term: shell.id, data: `${line}\r` });
  const pattern = new RegExp(`${word} (\\d+)\\r?\\n`);
  await until(() => pattern.test(shell.screen()), `${word}'s pid on the screen`);
  const pid = Number(pattern.exec(shell.screen())?.[1]);
  const procStart = procStartOf(pid);
  assert.ok(procStart !== null, `${word} ${pid} runs`);
  t.after(() => {
    if (stillRuns(pid, procStart)) process.kill(pid, 'SIGKILL');
  });
  return { pid, procStart };
}

const runs = (program: Program): boolean => stillRuns(program.pid, program.procStart);

async function untilGone(programs: Program[], what: string): Promise<void> {
  await until(() => programs.every((program) => !runs(program)), what);
}

/** The next list without the shell `id` (the server sends one when it changed). */
async function shellLeft(w: InWindow, id: string): Promise<ListMessage> {
  return w.page.list(
    (list) => !(list.shells ?? []).some((shell) => shell.id === id),
    'a list without the shell',
  );
}

describe("a shell's life through the server (issue #199, S2 7.10)", () => {
  test("A5: `exit` typed in the shell closes it; the session's terminal runs on", async (t) => {
    const w = await inWindow(t);
    const shell = await openShell(w);

    w.page.send({ t: 'input', term: shell.id, data: 'exit\r' });

    const list = await shellLeft(w, shell.id);
    assert.ok(
      list.terminals.some((term) => term.id === w.term && term.state === 'running'),
      "the session's terminal still runs",
    );
    await untilGone([shell.program], "the shell's program gone");
    await until(() => !pidFiles(w.d).includes(`${shell.id}.pid`), "the shell's keeper gone");
  });

  const ends: [string, (w: InWindow) => Promise<void>][] = [
    [
      'End session and mark done',
      async (w) => {
        await w.page.list((list) => rowOf(list, S1)?.endable === true, 'S1 endable');
        const result = await w.page.act({ kind: 'end-session', term: w.term, sessionId: S1 });
        assert.equal(result.ok, true, JSON.stringify(result));
      },
    ],
    [
      'End session and park',
      async (w) => {
        await w.page.list((list) => rowOf(list, S1)?.endable === true, 'S1 endable');
        const result = await w.page.act({
          kind: 'end-session',
          term: w.term,
          sessionId: S1,
          mark: 'park',
        });
        assert.equal(result.ok, true, JSON.stringify(result));
      },
    ],
    [
      '/exit typed into the session',
      async (w) => {
        w.page.send({ t: 'input', term: w.term, data: '/exit\r' });
      },
    ],
    [
      'a crash of the session (SIGKILL)',
      async (w) => {
        const program = w.server.server.hub.list().find((one) => one.id === w.term)?.program;
        assert.ok(program !== null && program !== undefined);
        process.kill(program.pid, 'SIGKILL');
      },
    ],
  ];
  for (const [name, end] of ends) {
    test(`A5: ${name} ends the shell, a background job and a foreground child of it`, async (t) => {
      const w = await inWindow(t);
      const shell = await openShell(w);
      const job = await startedIn(t, w, shell, 'sleep 300 & echo job $!', 'job');
      const child = await startedIn(t, w, shell, "sh -c 'echo child $$; exec sleep 300'", 'child');

      await end(w);

      await shellLeft(w, shell.id);
      await untilGone([shell.program, job, child], 'the shell, its job and its child gone');
      await until(() => !pidFiles(w.d).includes(`${shell.id}.pid`), "the shell's keeper gone");
    });
  }

  test('A5: closing the ended terminal leaves no keeper of its shell', async (t) => {
    const w = await inWindow(t);
    const shell = await openShell(w);
    w.page.send({ t: 'input', term: w.term, data: '/exit\r' });
    await w.page.list(
      (list) => list.terminals.some((term) => term.id === w.term && term.state === 'ended'),
      'the terminal ended',
    );

    const closed = await w.page.act({ kind: 'close-terminal', term: w.term });

    assert.equal(closed.ok, true, JSON.stringify(closed));
    await untilGone([shell.program], "the shell's program gone");
    await until(() => !pidFiles(w.d).includes(`${shell.id}.pid`), "the shell's keeper gone");
    assert.deepEqual(w.server.server.hub.shells?.() ?? [], []);
  });

  test('A7: a restart of the server finds the same shell process under the same terminal, with its screen; and after a restart of the session followed by one of the server', async (t) => {
    const w = await inWindow(t);
    const shell = await openShell(w);
    w.page.send({ t: 'input', term: shell.id, data: 'printf "marker %s\\n" before-restart\r' });
    await until(() => shell.screen().includes('marker before-restart'), 'the marker');

    await w.server.server.stop('the test restarts the server');
    const again = await w.d.start();
    await until(
      () => (again.server.hub.shells?.() ?? []).some((one) => one.id === shell.id),
      'the shell found again',
    );
    const found = (again.server.hub.shells?.() ?? []).find((one) => one.id === shell.id);
    assert.equal(found?.of, w.term, 'under the same terminal');
    assert.deepEqual(found?.program, shell.program, 'the same process');
    const page = await connectTestPage(t, w.d, again.server, { view: { selected: S1 } });
    await page.list(
      (list) => (list.shells ?? []).some((one) => one.id === shell.id && one.of === w.term),
      'list.shells has it',
    );
    page.send({ t: 'attach', term: shell.id, cols: 80, rows: 12 });
    const snap = await page.next('snap', "the shell's snap");
    assert.ok(snap.data.includes('marker before-restart'), 'the screen from before');

    // A restart of the session, then of the server: the shell is the new terminal's.
    await until(
      () => again.server.hub.list().find((one) => one.id === w.term)?.endable === true,
      'the terminal endable',
    );
    const restarted = await page.act({ kind: 'restart', term: w.term, sessionId: S1 }, 30_000);
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    const next = again.server.hub
      .list()
      .find((one) => one.sessionId === S1 || one.expectedSessionId === S1);
    assert.ok(next !== undefined && next.id !== w.term, "the session's new terminal");
    await until(
      () => (again.server.hub.shells?.() ?? []).some((one) => one.of === next.id),
      'the shell under the new terminal',
    );
    await again.server.stop('the test restarts the server again');
    const third = await w.d.start();
    await until(
      () => (third.server.hub.shells?.() ?? []).some((one) => one.id === shell.id),
      'the shell found after both restarts',
    );
    const last = (third.server.hub.shells?.() ?? []).find((one) => one.id === shell.id);
    assert.equal(last?.of, next.id, "under the session's new terminal");
    assert.deepEqual(last?.program, shell.program, 'the same process');
  });

  test("A11: a `claude` started in the shell runs elsewhere: its row is not the window's, no terminal shows it, the owner shows its own session, and it is not held in the window", async (t) => {
    const w = await inWindow(t);
    const shell = await openShell(w);
    w.page.send({ t: 'input', term: shell.id, data: `${w.d.standin} --session-id ${S3}\r` });
    const startOf = (): { pid: number } | undefined =>
      readRecords(w.d.record).find(
        (one): one is Extract<typeof one, { ev: 'start' }> =>
          one.ev === 'start' && one.argv.includes(S3),
      );
    await until(() => startOf() !== undefined, 'the stand-in started in the shell');

    const list = await w.page.list((candidate) => {
      const row = rowOf(candidate, S3);
      return row !== undefined && row.elsewhere !== null;
    }, 'a row of the session started in the shell, running elsewhere');

    const row = rowOf(list, S3);
    assert.equal(row?.terminal, null, 'no terminal of the window');
    assert.ok(
      list.terminals.every((term) => term.sessionId !== S3),
      'no terminal of the list shows it',
    );
    assert.equal(
      list.terminals.find((term) => term.id === w.term)?.sessionId,
      S1,
      'the owner shows its own session',
    );
    assert.equal(rowOf(list, S1)?.terminal, w.term);
    const pid = startOf()?.pid;
    assert.ok(pid !== undefined);
    const procStart = procStartOf(pid);
    const bootId = w.d.platform.proc.bootId();
    assert.ok(procStart !== null && bootId !== null);
    const holder = {
      process: { bootId, pid, procStart },
      sinceNs: 0n,
      live: null,
      scripted: false,
    } as unknown as Holder;
    assert.equal(holdersInWindow(w.d.deck, [holder]).has(pid), false, 'not held in the window');
  });
});
