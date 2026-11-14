// A stand-in for msedge.exe (S2 5.3), what `window.edge` names in the tests of `skydeck window`
// (plan task 25): it records how it was started and, when the test asks, plays the page Edge would
// open — it takes the launch token from the `--app` address and does the handshake of S2 8.2.2 in
// mode `launch`, once or twice. Only inside a test sandbox (checked by ./msedge and again here).
//
// Its environment (the command's, which startWindowsProgram passes on) steers it:
//   FAKE_EDGE_RECORD           an absolute path: one JSON line is appended per run when it starts,
//                              { run, argv, cwd, wslInterop }, and one per presentation,
//                              { run, presented: <1 or 2>, outcome: 'welcome' | 'closed <code>' |
//                              'refused <status>' }
//   FAKE_EDGE_PAGE             none (default): records only; once: presents the token once and
//                              keeps that page open; twice: as once, then presents the same token
//                              on a second connection
//   FAKE_EDGE_SECOND_DELAY_MS  how long `twice` waits after the first welcome (default 0)
// It never connects to port 47613, the default port of a real server (it records that and exits).
// It ends itself when SKYDECK_HOME is gone (checked every 200 ms) or 120 s after it started; the
// tests also kill it through the handle of the process their platform started.
import { appendFileSync, existsSync } from 'node:fs';

import { outcomeOf, present } from './page.ts';

const env = process.env;
const home = env.SKYDECK_HOME;
if (env.SKYDECK_TEST_NO_WINDOWS !== '1' || home === undefined || !home.startsWith('/')) {
  process.stderr.write('fake-edge: runs only inside a test sandbox\n');
  process.exit(2);
}

setInterval(() => {
  if (!existsSync(home)) process.exit(0);
}, 200);
setTimeout(() => process.exit(0), 120_000);

const argv = process.argv.slice(2);
const run = `${process.pid}`;
const record = (entry: Record<string, unknown>): void => {
  const path = env.FAKE_EDGE_RECORD;
  if (path !== undefined && path.startsWith('/')) {
    appendFileSync(path, `${JSON.stringify({ run, ...entry })}\n`);
  }
};
record({ argv, cwd: process.cwd(), wslInterop: env.WSL_INTEROP ?? null });

/** window.port's default (S2 5.2): never connected to. */
const DEFAULT_PORT = 47613;

const page = env.FAKE_EDGE_PAGE ?? 'none';
if (page === 'once' || page === 'twice') {
  const app = argv.find((arg) => arg.startsWith('--app='));
  const url = app === undefined ? null : new URL(app.slice('--app='.length));
  const token = url?.hash.startsWith('#t=') === true ? url.hash.slice('#t='.length) : null;
  if (url === null || token === null) {
    record({ presented: 1, outcome: 'no launch token in the address' });
  } else if (Number(url.port) === DEFAULT_PORT) {
    // Tests run their servers on ports the system picks: 47613 is where the user's own server
    // may listen, and nothing of a test may knock there.
    record({ presented: 1, outcome: `not connected: ${DEFAULT_PORT} is the default port of a real server` });
    process.exit(0);
  } else {
    const port = Number(url.port);
    const key = new Uint8Array(Buffer.from(token, 'base64url'));
    const first = await present(port, key, 'launch');
    record({ presented: 1, outcome: outcomeOf(first) });
    if (page === 'twice') {
      const delay = Number(env.FAKE_EDGE_SECOND_DELAY_MS ?? '0');
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const second = await present(port, key, 'launch');
      record({ presented: 2, outcome: outcomeOf(second) });
    }
  }
}
