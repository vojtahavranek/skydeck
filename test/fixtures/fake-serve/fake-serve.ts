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
//                           server.json (the real server's gap between the two, S2 5.2)
//   FAKE_SERVE_BUILD        the build /ping and server.json report (default: this app root's)
//   FAKE_SERVE_CHECKOUT     the checkout they report (default: this app root)
//   FAKE_SERVE_BOOT_ID      the boot id /ping reports (default: the current one; server.json
//                           always carries the current one, so that its line stays alive)
//   FAKE_SERVE_TERMINALS    how many terminals /status lists (default 0)
//   FAKE_SERVE_PAGES        the pages /status reports: a decimal number (default 0), or
//                           `json:<JSON value>` for a count that is not a whole number
//                           (`json:"3"`, `json:2.5`, `json:9007199254740993`)
//   FAKE_SERVE_STATUS       pages-only: /status answers `{ pages }` and nothing else (an old
//                           server's answer the command line's client cannot read whole)
//   FAKE_SERVE_ON_SHUTDOWN  exit (default): after answering, removes server.json, server.pid and
//                           server.sock and exits 0; stay: answers and goes on
// It writes one line to stdout and one to stderr at start (so that a test sees where they go)
// and prints `ready` on stdout once server.json is written (idle: at once). It ends itself when
// SKYDECK_HOME is gone (checked every 200 ms) or 120 s after it started.
import { existsSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { procStartFromStat } from '../../../src/claude/procstat.ts';
import { realPlatform } from '../../../src/platform/real.ts';
import { openDeck } from '../../../src/sessions/deck.ts';
import { createTokens } from '../../../src/window/auth.ts';
import { computeBuild } from '../../../src/window/build.ts';
import { controlHandler } from '../../../src/window/control.ts';
import { formatPidLine } from '../../../src/window/pidline.ts';
import type { PingAnswer, StatusAnswer } from '../../../src/window/protocol.ts';
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
  const status: StatusAnswer = {
    pages: pagesText.startsWith('json:')
      ? (JSON.parse(pagesText.slice('json:'.length)) as number)
      : Number(pagesText),
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
  const handler = controlHandler({
    ping: () => ping,
    status: () =>
      env.FAKE_SERVE_STATUS === 'pages-only'
        ? ({ pages: status.pages } as unknown as StatusAnswer)
        : status,
    tokens: createTokens(platform.clock, platform.randomBytes, () => {}),
    shutdown: () => {
      if (env.FAKE_SERVE_ON_SHUTDOWN !== 'stay') {
        void stop().then(() => process.exit(0));
      }
    },
    log: (line) => {
      process.stderr.write(`fake-serve: ${line}\n`);
    },
  });
  const listener = await platform.net.listenHttp(
    { path: files.serverSock },
    { request: silent ? () => {} : handler },
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
  process.stdout.write('ready\n');
}
