/**
 * Restore in the window's server under test (plan C task 74): a server sandbox (window.ts) whose
 * sessions ran in an earlier boot, programs held at a gate the test opens, and the requests of
 * `server.sock`'s stage C routes.
 *
 * An earlier boot is never caused (plan C section 0): a session of one is a transcript in the
 * sandbox and spool files of `bin/skydeck-hook`'s form (spool.ts) whose boot id is invented, whose
 * process is not alive and which has no end (or an end with the reason `other`) — so its row is
 * `ended-unexpectedly` and design 7.8's default set holds it.
 *
 * A gate is what a case waits on instead of a time: every program a server's keeper starts is a
 * `sh` script (the sandbox's `claudeCommand`) that notes its session at `<gates>/<id>.waiting` and
 * waits until the test opens `<gates>/<id>.open`; then it `exec`s the stand-in, or exits with the
 * status the test gave. At the test's end every gate still shut is opened with `exit 0`, before
 * the servers are stopped and the keepers killed (the hook is registered before the sandbox's).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { isoFromNs, NS_PER_MINUTE, NS_PER_SECOND } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import type { RestoreStreamLine } from '../../src/window/protocol.ts';
import { hookInput, spoolName, spoolText } from './spool.ts';
import type { SpoolFields } from './spool.ts';
import { serverSandbox } from './window.ts';
import type { ServerSandbox, ServerSandboxOptions } from './window.ts';

/** The boot the sessions of `earlierBoot` ran in: a lower-case UUID that is not this machine's. */
export const EARLIER_BOOT = '3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b';
/** A process start no live process of the machine has with the pids below. */
const DEAD_PROC_START = 4242;
/** Pids for the sessions' processes; what makes each process dead is DEAD_PROC_START (and the
 *  invented boot): a live process may have such a pid, never with that start. */
let nextPid = 4_100_000;

/** Session `n` (1–99) of an earlier boot: `e00000nn-…`, its short id `e00000nn`. */
export function earlierId(n: number): string {
  return `e${String(n).padStart(7, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
}

export interface EarlierSession {
  sessionId: string;
  /** Its start event's time; default an hour before the clock's now. */
  startNs?: Ns;
  /** An end event with the reason `other` (still "ended unexpectedly", design 6.3) at this time;
   *  none by default (no exit recorded). */
  endNs?: Ns;
  /** The time of the transcript's last record (its row's last activity, design 7.4's order);
   *  default a minute after the start. */
  activityNs?: Ns;
  /** The transcript's last turn is the user's: design 7.8's `was-working`; default false. */
  wasWorking?: boolean;
}

export interface RestoreSandbox {
  d: ServerSandbox;
  /** The gate script, the sandbox's `claudeCommand`. */
  command: string;
  /** Whether the program of `sessionId` waits at its gate (or went through it). */
  waiting(sessionId: string): boolean;
  /** Opens the gate of `sessionId`: the stand-in, or `exit` with that status. */
  open(sessionId: string, exit?: number): void;
  /** Opens every gate for the stand-in, also of sessions not known yet (`skydeck new`'s). */
  openAll(): void;
  /** Shuts the gate of `sessionId` again: its next program waits (and notes it) once more. */
  shut(sessionId: string): void;
  /**
   * Sessions of an earlier boot (`bootId`, default EARLIER_BOOT), each resumable (a transcript in
   * the sandbox, its directory `<home>/projects/<short id>`), with their events ingested on the
   * test's own connection; the last event of that boot.
   */
  earlierBoot(sessions: readonly EarlierSession[], bootId?: string): Ns;
}

function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Call first in a test: a server sandbox (serverSandbox, `options` passed on) whose config.json
 * has the gate script as `claudeCommand`, `restoreBatch` 2, `restoreStartTimeoutSeconds` 5 and
 * `restoreMinFreeMb` 1 (a loaded machine must not stop a restore for its memory), `config` over
 * them. No server is started.
 */
export function restoreSandbox(
  t: TestContext,
  options: ServerSandboxOptions & { config?: Record<string, unknown> } = {},
): RestoreSandbox {
  let gates: string | null = null;
  // Registered before the sandbox's hooks, so it runs first: a program at a closed gate ends.
  t.after(() => {
    if (gates === null || !existsSync(gates)) return;
    for (const name of readdirSync(gates)) {
      if (!name.endsWith('.waiting')) continue;
      const open = join(gates, `${name.slice(0, -'.waiting'.length)}.open`);
      if (!existsSync(open)) writeFileSync(open, 'exit 0\n');
    }
  });
  const d = serverSandbox(t, options);
  const dir = join(d.s.root, 'gates');
  mkdirSync(dir);
  gates = dir;
  const command = join(d.s.bin, 'claude-gated');
  writeFileSync(
    command,
    [
      '#!/bin/sh',
      // The session: the word after --resume or --session-id (buildResumeCommand, buildNewCommand).
      'id=',
      'prev=',
      'for a in "$@"; do',
      '  if [ "$prev" = --resume ] || [ "$prev" = --session-id ]; then id=$a; fi',
      '  prev=$a',
      'done',
      `gates=${shellWord(dir)}`,
      ': > "$gates/$id.waiting"',
      'while [ ! -e "$gates/$id.open" ] && [ ! -e "$gates/all.open" ]; do sleep 0.05; done',
      'how=',
      'if [ -e "$gates/$id.open" ]; then read -r how < "$gates/$id.open"; fi',
      'case "$how" in',
      '  exit\\ *) exit "${how#exit }" ;;',
      'esac',
      `exec ${shellWord(d.standin)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const configPath = join(d.s.skydeckHome, 'config', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        claudeCommand: command,
        restoreBatch: 2,
        restoreStartTimeoutSeconds: 5,
        restoreMinFreeMb: 1,
        ...options.config,
      },
      null,
      2,
    )}\n`,
  );

  const earlierBoot = (sessions: readonly EarlierSession[], bootId = EARLIER_BOOT): Ns => {
    const { spoolDir } = d.deck.places;
    mkdirSync(spoolDir, { recursive: true });
    const nowNs = d.platform.clock.nowNs();
    let lastNs: Ns | null = null;
    let seq = 0;
    for (const session of sessions) {
      const { sessionId } = session;
      const startNs = session.startNs ?? nowNs - 60n * NS_PER_MINUTE;
      // As `resumable` makes one, with records at the times asked for: the user's turn, then
      // (unless it was working) the answer.
      const projectDir = join(d.s.home, 'projects', sessionId.slice(0, 8));
      mkdirSync(projectDir, { recursive: true });
      const folder = join(d.s.claudeHome, 'projects', 'project');
      mkdirSync(folder, { recursive: true });
      const transcript = join(folder, `${sessionId}.jsonl`);
      const activityNs = session.activityNs ?? startNs + NS_PER_MINUTE;
      const record = (type: 'user' | 'assistant', atNs: Ns): string =>
        `${JSON.stringify({ type, sessionId, timestamp: isoFromNs(atNs), cwd: projectDir, entrypoint: 'cli' })}\n`;
      writeFileSync(
        transcript,
        session.wasWorking === true
          ? record('user', activityNs)
          : record('user', activityNs - 5n * NS_PER_SECOND) + record('assistant', activityNs),
      );
      const pid = nextPid++;
      const common = {
        pid,
        bootId,
        procStart: DEAD_PROC_START,
        pwd: projectDir,
      };
      const start: SpoolFields = {
        ...common,
        event: 'SessionStart',
        timeNs: startNs,
        argv: ['claude'],
        input: hookInput('SessionStart', sessionId, {
          source: 'startup',
          cwd: projectDir,
          transcript_path: transcript,
        }),
      };
      writeFileSync(join(spoolDir, spoolName(start, seq++)), spoolText(start));
      let endedNs = startNs;
      if (session.endNs !== undefined) {
        const end: SpoolFields = {
          ...common,
          event: 'SessionEnd',
          timeNs: session.endNs,
          input: hookInput('SessionEnd', sessionId, {
            reason: 'other',
            cwd: projectDir,
            transcript_path: transcript,
          }),
        };
        writeFileSync(join(spoolDir, spoolName(end, seq++)), spoolText(end));
        endedNs = session.endNs;
      }
      if (lastNs === null || endedNs > lastNs) lastNs = endedNs;
    }
    refresh(d.deck);
    if (lastNs === null) throw new RangeError('earlierBoot needs a session');
    return lastNs;
  };

  return {
    d,
    command,
    waiting: (sessionId) => existsSync(join(dir, `${sessionId}.waiting`)),
    open(sessionId, exit) {
      writeFileSync(join(dir, `${sessionId}.open`), exit === undefined ? '\n' : `exit ${exit}\n`);
    },
    openAll() {
      writeFileSync(join(dir, 'all.open'), '\n');
    },
    shut(sessionId) {
      rmSync(join(dir, `${sessionId}.open`), { force: true });
      rmSync(join(dir, `${sessionId}.waiting`), { force: true });
    },
    earlierBoot,
  };
}

/** A `POST` to the sandbox's `server.sock` with a JSON body: its status and answer. */
export function post(
  d: ServerSandbox,
  path: string,
  body: unknown,
  timeoutMs = 60_000,
): Promise<{ status: number; body: unknown }> {
  return d.platform.net.requestUnix(d.files.serverSock, {
    method: 'POST',
    path,
    body,
    timeoutMs,
  });
}

export interface RestoreAnswer {
  /** The lines received so far, each parsed (a line that is no JSON is kept as its text). */
  lines: (RestoreStreamLine | string)[];
  /** The `line` texts received so far. */
  texts(): string[];
  /** The status, once the answer has ended (or the request was aborted: then it rejects). */
  ended: Promise<{ status: number }>;
}

/**
 * `POST /restore` with `body`, read line by line as it arrives (plan C5). `onLine` sees each line
 * as it comes; `signal` ends the request (the asker going, C22).
 */
export function postRestore(
  d: ServerSandbox,
  body: unknown,
  options: { onLine?: (line: RestoreStreamLine | string) => void; signal?: AbortSignal } = {},
): RestoreAnswer {
  const lines: (RestoreStreamLine | string)[] = [];
  const ended = d.platform.net
    .requestUnix(d.files.serverSock, {
      method: 'POST',
      path: '/restore',
      body,
      timeoutMs: 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onLine: (text) => {
        if (text === '') return;
        let line: RestoreStreamLine | string;
        try {
          line = JSON.parse(text) as RestoreStreamLine;
        } catch {
          line = text;
        }
        lines.push(line);
        options.onLine?.(line);
      },
    })
    .then(({ status }) => ({ status }));
  return {
    lines,
    texts: () =>
      lines.flatMap((line) => (typeof line === 'object' && 'line' in line ? [line.line] : [])),
    ended,
  };
}
