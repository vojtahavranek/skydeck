// A stand-in for `skydeck serve` (S2 5.2) in a fixture app root: what `bin/skydeck serve` of this
// directory runs, for the tests of src/window/lifecycle.ts (task 22) and of doctor and uninstall
// (task 24). In mode `serve` it does what a server does that a command can see: it takes the
// runtime directory as a starting server does (resolveRuntimeDir 'take', prepareRuntimeDir),
// answers server.sock with the server's own handler (controlHandler: /ping, /status, /shutdown
// and the token routes) and writes server.json and server.pid. It holds no port, no lock, no
// keepers. Only inside a test sandbox (checked by bin/skydeck and again here).
//
// Its environment steers it:
//   FAKE_SERVE_MODE         serve (default); silent: as serve, but no request is ever answered;
//                           idle: starts nothing, only lives; exit: exits with FAKE_SERVE_EXIT at
//                           once; kill: ends itself by SIGKILL at once
//   FAKE_SERVE_EXIT         the exit code of mode exit
//   FAKE_SERVE_RECORD       an absolute path: written first, JSON { argv, cwd, env, stdin,
//                           sessionLeader }
//   FAKE_SERVE_DELAY_MS     waits this long before it takes the runtime directory
//   FAKE_SERVE_JSON_DELAY_MS  waits this long after server.sock answers before it writes
//                           server.json (a server that answers before it records itself: what
//                           the real server did before the follow-up "server-findable")
//   FAKE_SERVE_BUILD        the build /ping and server.json report (default: this app root's)
//   FAKE_SERVE_CHECKOUT     the checkout they report (default: this app root)
//   FAKE_SERVE_BOOT_ID      the boot id /ping reports (default: the current one; server.json
//                           always carries the current one, so that its line stays alive)
//   FAKE_SERVE_TERMINALS    how many terminals /status lists (default 0)
//   FAKE_SERVE_PAGES        the pages /status reports: a decimal number (default 0), or
//                           `json:<JSON value>` for a count that is not a whole number
//                           (`json:"3"`, `json:2.5`, `json:9007199254740993`)
//   FAKE_SERVE_PAGES_AFTER  `<ms>:<n>`: /status reports n pages once ms have passed since the
//                           first /status it answered (FAKE_SERVE_PAGES before then): a window
//                           that comes back, timed from the command's first look, not from its
//                           own start
//   FAKE_SERVE_STARTING_MS  /status says `starting: true` for this many ms after `ready`, then
//                           `false` (default: no `starting` at all, as a server before it)
//   FAKE_SERVE_WINDOW_EXPECTED_MS  plan C20: /status reports `windowExpectedMs`: this many ms while
//                           it starts (FAKE_SERVE_STARTING_MS), then counting down from the end of
//                           its start (`ready`, without a start), null once it is down to 0 or
//                           reports a page — as the server's page mark does (so 0 is null from the
//                           start, also while it starts); `json:<JSON value>` reports that value
//                           as it is, all the time (`json:0`, `json:"3000"`, `json:-1`, `json:null`).
//                           A value of these three of another form ends the fake at once (exit 2).
//                           Default: none (a server before stage C)
//   FAKE_SERVE_STATUS       pages-only: /status answers `{ pages }` and nothing else (an old
//                           server's answer the command line's client cannot read whole)
//   FAKE_SERVE_ON_SHUTDOWN  exit (default): after answering, removes server.json, server.pid and
//                           server.sock and exits 0; stay: answers and goes on
// Stage C's routes (plan C2–C5; task 76), answered through the server's own handler and parser
// (an unknown field, a label over 1,024 bytes: 400). Without FAKE_SERVE_LAUNCH and
// FAKE_SERVE_RESTORE there is no `launch`: `POST /resume`, `/new` and `/restore` are 404
// `route: unknown`, as a server before stage C answers them.
//   FAKE_SERVE_LAUNCH       `POST /resume` and `/new`: `answer:<JSON>` answers that value as it is
//                           (any JSON: a LaunchAnswer, or one of another shape); `silent` never
//                           answers them; `status:<code>` answers that HTTP status with
//                           `{ error: 'body: too long' }` before anything else, as for a body over
//                           64 KiB. Unset while FAKE_SERVE_RESTORE is set: they fail (500)
//   FAKE_SERVE_RESTORE      `POST /restore`: a JSON array of RestoreStreamLine, written 100 ms apart
//                           (the first at once), then the answer ends; `silent-after:<n>` writes n
//                           lines `{ "line": "line <i>" }` 100 ms apart and then nothing until the
//                           asker goes. Unset while FAKE_SERVE_LAUNCH is set: it fails (500)
//   FAKE_SERVE_STATE        the server's launch state (C4): `starting` or `stopping` — every stage C
//                           request is answered 503 { error } —, or `starting:<n>`: the first n
//                           requests 503 `starting`, then they act
//   FAKE_SERVE_REQUESTS     an absolute path: each stage C request that reaches `launch` is appended
//                           as one JSON line, `{ route, ...body }` (none for a 503, a 400, a 404 or
//                           FAKE_SERVE_LAUNCH's `status:`)
// A value of these of another form ends the fake at once (exit 2), as for the timed options.
// It writes one line to stdout and one to stderr at start (so that a test sees where they go)
// and prints `ready` on stdout once server.json is written (idle: at once). It ends itself when
// SKYDECK_HOME is gone (checked every 200 ms) or 120 s after it started.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { procStartFromStat } from '../../../src/claude/procstat.ts';
import { realPlatform } from '../../../src/platform/real.ts';
import { openDeck } from '../../../src/sessions/deck.ts';
import { createTokens } from '../../../src/window/auth.ts';
import { computeBuild } from '../../../src/window/build.ts';
import { controlHandler } from '../../../src/window/control.ts';
import type { ControlLaunch } from '../../../src/window/control.ts';
import { formatPidLine } from '../../../src/window/pidline.ts';
import type {
  LaunchAnswer,
  PingAnswer,
  RestoreStreamLine,
  StatusAnswer,
} from '../../../src/window/protocol.ts';
import {
  prepareRuntimeDir,
  resolveRuntimeDir,
  runtimeFiles,
  writeServerJson,
} from '../../../src/window/runtime.ts';

const env = process.env;
const home = env.SKYDECK_HOME;
if (env.SKYDECK_TEST_NO_WINDOWS !== '1' || home === undefined || !home.startsWith('/')) {
  process.stderr.write('fake-serve: runs only inside a test sandbox\n');
  process.exit(2);
}

const record = env.FAKE_SERVE_RECORD;
if (record !== undefined) {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const session = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3];
  writeFileSync(
    record,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env,
      stdin: readlinkSync('/proc/self/fd/0'),
      sessionLeader: session === String(process.pid),
    }),
  );
}
process.stdout.write('fake-serve: a line on stdout\n');
process.stderr.write('fake-serve: a line on stderr\n');

// A test that crashed must not leave it running.
setInterval(() => {
  if (!existsSync(home)) process.exit(0);
}, 200);
setTimeout(() => process.exit(0), 120_000);

// The timed /status options: a value of another form ends the fake at once (exit 2).
refuseMalformed('FAKE_SERVE_PAGES_AFTER', /^[0-9]+:[0-9]+$/);
refuseMalformed('FAKE_SERVE_STARTING_MS', /^(0|[1-9][0-9]*)$/);
refuseMalformed('FAKE_SERVE_WINDOW_EXPECTED_MS', /^((0|[1-9][0-9]*)|json:.*)$/s, (text) =>
  text.startsWith('json:') ? isJson(text.slice('json:'.length)) : true,
);
// Stage C's options, likewise.
refuseMalformed('FAKE_SERVE_LAUNCH', /^(answer:.*|silent|status:[1-5][0-9][0-9])$/s, (text) =>
  text.startsWith('answer:') ? isJson(text.slice('answer:'.length)) : true,
);
refuseMalformed('FAKE_SERVE_RESTORE', /^(\[.*\]|silent-after:(0|[1-9][0-9]*))$/s, (text) =>
  text.startsWith('[') ? isJson(text) && Array.isArray(JSON.parse(text)) : true,
);
refuseMalformed('FAKE_SERVE_STATE', /^(starting(:(0|[1-9][0-9]*))?|stopping)$/);
refuseMalformed('FAKE_SERVE_REQUESTS', /^\/./);

const mode = env.FAKE_SERVE_MODE ?? 'serve';
if (mode === 'exit') {
  process.exit(Number(env.FAKE_SERVE_EXIT));
}
if (mode === 'kill') {
  process.kill(process.pid, 'SIGKILL');
}
if (mode === 'idle') {
  process.stdout.write('ready\n');
} else {
  await serve(mode === 'silent');
}

async function serve(silent: boolean): Promise<void> {
  const delay = Number(env.FAKE_SERVE_DELAY_MS ?? '0');
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const platform = realPlatform();
  const deck = openDeck(platform);
  const appRoot = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const bootId = platform.proc.bootId() ?? 'no-boot-id';
  const procStart = procStartFromStat(platform.proc.stat(platform.pid) ?? '') ?? 0;
  const build = env.FAKE_SERVE_BUILD ?? computeBuild(platform.files, appRoot);
  const checkout = env.FAKE_SERVE_CHECKOUT ?? appRoot;
  const startedAt = String(platform.clock.nowNs());
  const origin = env.SKYDECK_ENV_ORIGIN;
  const envOrigin = {
    dir: origin !== undefined && origin.startsWith('/') ? origin : process.cwd(),
    atNs: startedAt,
  };
  const port = 47613;

  const files = runtimeFiles(resolveRuntimeDir(deck, 'take').dir);
  prepareRuntimeDir(platform, files);
  const ping: PingAnswer = {
    serverId: Buffer.from(platform.randomBytes(8)).toString('hex'),
    bootId: env.FAKE_SERVE_BOOT_ID ?? bootId,
    build,
    protocol: 1,
    pid: platform.pid,
    port,
    checkout,
  };
  const terminals = Number(env.FAKE_SERVE_TERMINALS ?? '0');
  const pagesText = env.FAKE_SERVE_PAGES ?? '0';
  const pages = pagesText.startsWith('json:')
    ? (JSON.parse(pagesText.slice('json:'.length)) as number)
    : Number(pagesText);
  const status: StatusAnswer = {
    pages,
    terminals: Array.from({ length: terminals }, (_, i) => ({
      id: String(i).padStart(12, '0'),
      slot: i + 1,
      state: 'running',
      sessionId: null,
      pid: null,
    })),
    keepAlive: { mode: 'off', state: 'off', since: null, error: null },
    python: { found: true, version: '3.12.3' },
    build,
    checkout,
    startedAtNs: startedAt,
    envOrigin,
  };

  // A server removes the server.sock a dead server left (S2 5.2); a test's fakes are all its own.
  platform.files.remove(files.serverSock);
  let stop = async (): Promise<void> => {};
  const timed = timedStatus(pages);
  const handler = controlHandler({
    ping: () => ping,
    status: () =>
      env.FAKE_SERVE_STATUS === 'pages-only'
        ? ({ pages: status.pages } as unknown as StatusAnswer)
        : { ...status, ...timed.now() },
    tokens: createTokens(platform.clock, platform.randomBytes, () => {}),
    shutdown: () => {
      if (env.FAKE_SERVE_ON_SHUTDOWN !== 'stay') {
        void stop().then(() => process.exit(0));
      }
    },
    log: (line) => {
      process.stderr.write(`fake-serve: ${line}\n`);
    },
    ...stageC(),
  });
  const listener = await platform.net.listenHttp(
    { path: files.serverSock },
    { request: silent ? () => {} : withLaunchStatus(handler) },
  );
  stop = async () => {
    platform.files.remove(files.serverJson);
    platform.files.remove(files.serverPid);
    await listener.close();
  };
  const jsonDelay = Number(env.FAKE_SERVE_JSON_DELAY_MS ?? '0');
  if (jsonDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, jsonDelay));
  }
  writeServerJson(platform.files, files.serverJson, {
    pid: platform.pid,
    procStart,
    bootId,
    port,
    serverId: ping.serverId,
    build,
    checkout,
    startedAt,
    envOrigin,
  });
  platform.files.writeText(
    files.serverPid,
    formatPidLine({ pid: platform.pid, procStart, bootId }),
    0o600,
  );
  timed.ready();
  process.stdout.write('ready\n');
}

/** Ends the fake with exit 2 when `name` is set but not of `form`: a typo in a test must not pass. */
function refuseMalformed(name: string, form: RegExp, valid = (_text: string) => true): void {
  const text = env[name];
  if (text !== undefined && (!form.test(text) || !valid(text))) {
    process.stderr.write(`fake-serve: ${name} is not ${String(form)}: ${JSON.stringify(text)}\n`);
    process.exit(2);
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The fields of /status that change with time (FAKE_SERVE_PAGES_AFTER, FAKE_SERVE_STARTING_MS,
 * FAKE_SERVE_WINDOW_EXPECTED_MS), on the monotonic clock. Before `ready` the start counts as not
 * begun: the full expectation, and `starting` true when a start is set.
 */
function timedStatus(pages: number): {
  ready(): void;
  now(): Pick<StatusAnswer, 'pages' | 'starting' | 'windowExpectedMs'>;
} {
  const after = /^([0-9]+):([0-9]+)$/.exec(env.FAKE_SERVE_PAGES_AFTER ?? '');
  const startingText = env.FAKE_SERVE_STARTING_MS;
  const startingMs = startingText === undefined ? null : Number(startingText);
  const expectedText = env.FAKE_SERVE_WINDOW_EXPECTED_MS;
  let readyAt: number | null = null;
  let firstAsked: number | null = null;
  return {
    ready() {
      readyAt = performance.now();
    },
    now() {
      const at = performance.now();
      firstAsked ??= at;
      const pagesNow = after !== null && at - firstAsked >= Number(after[1]) ? Number(after[2]) : pages;
      const sinceStartDone = readyAt === null ? null : at - readyAt - (startingMs ?? 0);
      const fields: Pick<StatusAnswer, 'pages' | 'starting' | 'windowExpectedMs'> = {
        pages: pagesNow,
      };
      if (startingMs !== null) fields.starting = sinceStartDone === null || sinceStartDone < 0;
      if (expectedText === undefined) return fields;
      if (expectedText.startsWith('json:')) {
        fields.windowExpectedMs = JSON.parse(expectedText.slice('json:'.length)) as number | null;
        return fields;
      }
      const expected = Number(expectedText);
      const left =
        sinceStartDone === null || sinceStartDone < 0 ? expected : expected - sinceStartDone;
      fields.windowExpectedMs = pagesNow > 0 || left <= 0 ? null : Math.ceil(left);
      return fields;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Stage C's routes (task 76)

const LAUNCH_PATHS: ReadonlySet<string> = new Set(['/resume', '/new']);

/** One stage C request in FAKE_SERVE_REQUESTS, as `launch` was given it. */
function recordRequest(request: Record<string, unknown>): void {
  const path = env.FAKE_SERVE_REQUESTS;
  if (path !== undefined) appendFileSync(path, `${JSON.stringify(request)}\n`);
}

/** `launch` and `launchState` of the server's handler, from FAKE_SERVE_LAUNCH, _RESTORE, _STATE. */
function stageC(): {
  launch?: ControlLaunch;
  launchState?: () => 'starting' | 'stopping' | null;
} {
  const launchText = env.FAKE_SERVE_LAUNCH;
  const restoreText = env.FAKE_SERVE_RESTORE;
  if (launchText === undefined && restoreText === undefined) return {};
  const answer = (): Promise<LaunchAnswer> => {
    if (launchText === undefined || launchText.startsWith('status:')) {
      return Promise.reject(new Error('FAKE_SERVE_LAUNCH gives no answer'));
    }
    if (launchText === 'silent') return new Promise(() => {});
    return Promise.resolve(JSON.parse(launchText.slice('answer:'.length)) as LaunchAnswer);
  };
  const launch: ControlLaunch = {
    resume(sessionId) {
      recordRequest({ route: 'resume', sessionId });
      return answer();
    },
    newSession(request) {
      recordRequest({ route: 'new', ...request });
      return answer();
    },
    async restore(request, write, closed) {
      recordRequest({ route: 'restore', ...request });
      if (restoreText === undefined) throw new Error('FAKE_SERVE_RESTORE gives no stream');
      const after = /^silent-after:([0-9]+)$/.exec(restoreText);
      const lines: unknown[] = after === null ? (JSON.parse(restoreText) as unknown[]) : [];
      const count = after === null ? lines.length : Number(after[1]);
      for (let i = 0; i < count && !closed.aborted; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 100));
        write((after === null ? lines[i] : { line: `line ${i + 1}` }) as RestoreStreamLine);
      }
      if (after !== null && !closed.aborted) {
        // Then nothing, until the asker goes.
        await new Promise((resolve) => closed.addEventListener('abort', resolve, { once: true }));
      }
    },
  };
  const stateText = env.FAKE_SERVE_STATE;
  if (stateText === undefined) return { launch };
  const counted = /^starting:([0-9]+)$/.exec(stateText);
  let left = counted === null ? Infinity : Number(counted[1]);
  return {
    launch,
    launchState: () => {
      if (stateText === 'stopping') return 'stopping';
      if (left <= 0) return null;
      left--;
      return 'starting';
    },
  };
}

/**
 * FAKE_SERVE_LAUNCH `status:<code>`: `POST /resume` and `/new` answered with that status and
 * `{ error: 'body: too long' }` before the server's handler sees them (as a body over 64 KiB is);
 * every other request goes to `handler`.
 */
function withLaunchStatus(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  const status = /^status:([0-9]+)$/.exec(env.FAKE_SERVE_LAUNCH ?? '');
  if (status === null) return handler;
  return (req, res) => {
    if (req.method !== 'POST' || !LAUNCH_PATHS.has(req.url ?? '')) {
      handler(req, res);
      return;
    }
    req.resume();
    req.on('end', () => {
      const body = JSON.stringify({ error: 'body: too long' });
      res.writeHead(Number(status[1]), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body)),
        Connection: 'close',
      });
      res.end(body);
    });
  };
}
