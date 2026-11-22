// `skydeck update --from-window <commit>` (F38; S2 16.5 "Update now"): the command the window's
// server starts, detached, to apply the update its dialog listed. It looks without the network,
// applies only that commit, and leaves the outcome of the merge in `kv window_update_run` for the
// server that comes back. The server is the fake `serve` of test/fixtures/fake-serve (a real
// process this file starts); git is the scripted one of test/helpers/update.ts, and the new
// checkout's launcher is recorded, never run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Files, Net, Platform, Processes, Runner } from '../../../src/platform/types.ts';
import { checkoutRoot, readRunEntry, RUN_KEY, writeRun } from '../../../src/update/record.ts';
import type { RunRecord } from '../../../src/update/record.ts';
import { SCHEMA_VERSION } from '../../../src/store/migrations.ts';
import { computeBuild } from '../../../src/window/build.ts';
import { gitTestEnv } from '../../helpers/git-checkout.ts';
import type { Run } from '../../helpers/install.ts';
import { withStore } from '../../helpers/install.ts';
import { procStartOf, stillRuns } from '../../helpers/keeper.ts';
import { realTestPlatform } from '../../helpers/platform.ts';
import type { RealTestPlatform, RunCall } from '../../helpers/platform.ts';
import type { Sandbox } from '../../helpers/sandbox.ts';
import { capture } from '../../helpers/capture.ts';
import {
  NEW,
  OLD,
  runUpdate,
  runUpdateOn,
  scriptedGit,
  scriptedRepo,
  subCommand,
} from '../../helpers/update.ts';
import type { ScriptedRepo } from '../../helpers/update.ts';

const FAKE_SERVE = fileURLToPath(new URL('../../fixtures/fake-serve/bin/skydeck', import.meta.url));

const ONE_COMMIT = '1 new commit on origin/main (0123456..fedcba9):\n  fedcba9  the new commit\n';
const STOPPED =
  "skydeck: stopped skydeck's window server; 0 terminals in the window keep running\n";
const FLAG = ['--from-window', NEW];

interface Harness {
  tp: RealTestPlatform;
  s: Sandbox;
  root: string;
  /** What happened, in order: `git <sub>`, `launch <path> <args>`, `<METHOD> <path>` of server.sock. */
  events: string[];
  launches: RunCall[];
  /** Called at every request on server.sock, before it is sent. */
  onRequest: (method: string, path: string) => void;
  platform(runner: Runner): Platform;
  serve(env?: Record<string, string>): Promise<{ running(): boolean }>;
  update(runner: Runner, args?: string[]): Promise<Run>;
  /** The stored run entry, whatever checkout it names; null: none (or no database yet). */
  entry(): RunRecord | null;
}

/** As update-server.test.ts's harness: a checkout inside the sandbox, the fake serve on demand. */
function harness(t: TestContext, env: Record<string, string> = {}): Harness {
  const tp = realTestPlatform(t, {
    env: (s) => ({
      ...gitTestEnv(s),
      SKYDECK_NODE: process.execPath,
      SKYDECK_TEST_WINDOW_TIMES: 'pingMs=1500',
      ...env,
    }),
  });
  const s = tp.sandbox;
  const root = join(s.root, 'checkout');
  mkdirSync(root);
  const owned: ChildProcess[] = [];
  t.after(() => {
    for (const child of owned) child.kill('SIGKILL');
  });
  const events: string[] = [];
  const processes: Processes = {
    startDetached: () => Promise.reject(new Error('skydeck update starts nothing detached')),
    signal(pid) {
      throw new Error(`this test signals nothing, not ${pid}`);
    },
  };
  const net: Net = {
    ...tp.platform.net,
    requestUnix(path, request) {
      events.push(`${request.method} ${request.path}`);
      h.onRequest(request.method, request.path);
      return tp.platform.net.requestUnix(path, request);
    },
  };
  const h: Harness = {
    tp,
    s,
    root,
    events,
    launches: [],
    onRequest: () => {},
    platform: (runner) => ({
      ...tp.platform,
      appRoot: root,
      cwd: s.home,
      processes,
      net,
      runner,
    }),
    async serve(over = {}) {
      const child = spawn(FAKE_SERVE, ['serve'], {
        env: s.env({
          SKYDECK_NODE: process.execPath,
          FAKE_SERVE_CHECKOUT: root,
          FAKE_SERVE_BUILD: computeBuild(tp.platform.files, root),
          ...over,
        }),
        cwd: '/',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      owned.push(child);
      let out = '';
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      const exited = once(child, 'exit');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`fake serve not ready: ${err}`)), 30_000);
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.split('\n').includes('ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        void exited.then(() => {
          clearTimeout(timer);
          reject(new Error(`fake serve ended before it was ready: ${err}`));
        });
      });
      const pid = child.pid;
      assert.ok(pid !== undefined);
      const procStart = procStartOf(pid);
      assert.ok(procStart !== null);
      return { running: () => stillRuns(pid, procStart) };
    },
    update: (runner, args = FLAG) => runUpdate(h.platform(runner), s, args),
    entry: () =>
      existsSync(tp.places.dbPath) ? withStore(tp.places, (store) => readRunEntry(store)) : null,
  };
  return h;
}

/** The scripted git on the harness's checkout, recording into its events and launches. */
function scripted(h: Harness, over: Partial<ScriptedRepo> = {}): ReturnType<typeof scriptedGit> {
  return scriptedGit(
    scriptedRepo(over.root ?? h.root, {
      ...over,
      onCall: (call, interactive) => {
        if (call.command === 'git') {
          h.events.push(
            `git ${subCommand(call, over.root ?? h.root)}${interactive ? ' (interactive)' : ''}`,
          );
        } else {
          h.events.push(`launch ${call.command} ${call.args.join(' ')}`);
          h.launches.push(call);
        }
        over.onCall?.(call, interactive);
      },
    }),
  );
}

/** The entry the harness's checkout would hold; `atNs` is checked to be a time and left out. */
function withoutTime(entry: RunRecord | null): Omit<RunRecord, 'atNs'> | null {
  if (entry === null) return null;
  assert.match(entry.atNs, /^[1-9][0-9]*$/);
  const { atNs: _atNs, ...rest } = entry;
  return rest;
}

describe('skydeck update --from-window: the flag (S2 16.5)', () => {
  test('not in the usage text; a value that is not a full commit id, a missing value, or --check beside it: a usage error, nothing looked at', async (t) => {
    const h = harness(t);
    const help = await h.update(scripted(h), ['--help']);
    assert.equal(help.code, 0);
    assert.ok(!help.stdout.includes('from-window'), help.stdout);
    for (const args of [
      ['--from-window', NEW.slice(0, 7)],
      ['--from-window', NEW.toUpperCase()],
      ['--from-window', `${NEW}0`],
      ['--from-window', ''],
      ['--from-window'],
      ['--check', '--from-window', NEW],
    ]) {
      const r = await h.update(scripted(h), args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    }
    assert.deepEqual(h.events, []);
    assert.equal(h.entry(), null);
  });

  test('a 64-digit id (a SHA-256 repository) is a commit id', async (t) => {
    const h = harness(t);
    const r = await h.update(scripted(h), ['--from-window', 'a'.repeat(64)]);
    assert.equal(r.code, 1, 'refused by the look: the upstream is not at it');
  });

  test('inside Claude Code: refused as the command is, and the refusal recorded', async (t) => {
    const h = harness(t, { CLAUDECODE: '1' });
    const r = await h.update(scripted(h));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^skydeck: skydeck update is not run from inside a Claude Code session/);
    assert.deepEqual(h.events, []);
    assert.deepEqual(withoutTime(h.entry()), {
      v: 1,
      root: h.root,
      state: 'failed',
      to: NEW,
      line: r.stderr.slice('skydeck: '.length, -1),
    });
  });
});

describe('skydeck update --from-window: the look, without the network', () => {
  test('no fetch of either kind is made: the look is what the remote-tracking ref says', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const r = await h.update(scripted(h));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.ok(!h.events.some((e) => e.startsWith('git fetch')), h.events.join(', '));
    assert.ok(h.events.includes('git merge'));
  });

  test('the upstream at another commit: the refusal, exit 1, the entry failed with it, no server touched', async (t) => {
    const h = harness(t);
    const server = await h.serve({ FAKE_SERVE_PAGES: '1' });
    const other = 'abcdef0123456789abcdef0123456789abcdef01';
    const r = await h.update(scripted(h), ['--from-window', other]);
    const line =
      'origin/main is at fedcba9, not at abcdef0, the commit the window listed; check again in the window; nothing was changed';
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `skydeck: ${line}\n`);
    assert.deepEqual(withoutTime(h.entry()), {
      v: 1,
      root: h.root,
      state: 'failed',
      to: other,
      line,
    });
    assert.deepEqual(
      h.events.filter((e) => !e.startsWith('git ')),
      [],
      'the server was not looked at',
    );
    assert.ok(server.running());
  });

  test('the checkout already at the commit: the command\'s line and exit 0, the entry failed with "nothing was applied"', async (t) => {
    const h = harness(t);
    const r = await h.update(scripted(h, { fetched: OLD }), ['--from-window', OLD]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'skydeck is up to date (main at 0123456, as origin/main)\n');
    assert.deepEqual(withoutTime(h.entry()), {
      v: 1,
      root: h.root,
      state: 'failed',
      to: OLD,
      line: 'nothing was applied: this checkout is already at 0123456; run skydeck window in a terminal of your own to restart the window for it',
    });
  });
});

describe('skydeck update --from-window: the outcome of the merge, recorded before the bring-back', () => {
  test('applied: the entry is `applied` before the launcher runs; the lines those of the typed command; not written again after the launcher, whatever its exit code', async (t) => {
    for (const launcher of [0, 1] as const) {
      const h = harness(t);
      await h.serve({ FAKE_SERVE_PAGES: '1' });
      let atLaunch: RunRecord | null = null;
      const runner = scripted(h, {
        launcher,
        onCall: (call) => {
          if (call.command !== 'git') atLaunch = h.entry();
        },
      });

      const r = await h.update(runner);

      assert.deepEqual(withoutTime(atLaunch), { v: 1, root: h.root, state: 'applied', to: NEW });
      assert.deepEqual(h.entry(), atLaunch, 'not written again after the launcher');
      if (launcher === 0) {
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
        assert.equal(r.stderr, STOPPED);
      } else {
        assert.equal(r.code, 1);
        assert.equal(r.stdout, ONE_COMMIT);
        assert.equal(
          r.stderr,
          `${STOPPED}skydeck: updated to fedcba9, but skydeck window ended with exit 1; run skydeck window\n`,
        );
      }
      assert.deepEqual(
        h.launches.map((l) => [l.command, ...l.args]),
        [[join(h.root, 'bin', 'skydeck'), 'window']],
      );
    }
  });

  test("a merge git refused, the checkout as it was: `failed` with the line WITHOUT the bring-back's tail, also when the launcher then fails; the launcher after it", async (t) => {
    for (const launcher of [0, 3] as const) {
      const h = harness(t);
      await h.serve({ FAKE_SERVE_PAGES: '1' });
      let atLaunch: RunRecord | null = null;
      const r = await h.update(
        scripted(h, {
          launcher,
          merge: { code: 1, stderr: 'fatal: a lock\n' },
          onCall: (call) => {
            if (call.command !== 'git') atLaunch = h.entry();
          },
        }),
      );
      const line = 'the update could not be applied: fatal: a lock; the checkout is as it was';
      assert.equal(r.code, 1);
      assert.equal(
        r.stderr,
        `${STOPPED}skydeck: ${line}${launcher === 0 ? '' : ', but skydeck window ended with exit 3; run skydeck window'}\n`,
      );
      const expected = { v: 1, root: h.root, state: 'failed', to: NEW, line };
      assert.deepEqual(withoutTime(atLaunch), expected, 'recorded before the launcher');
      assert.deepEqual(withoutTime(h.entry()), expected);
      assert.equal(h.launches.length, 1);
    }
  });

  test('a merge that left the checkout not as it was: `failed` with the whole line, no launcher', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const r = await h.update(
      scripted(h, {
        merge: { code: 128, stderr: 'error: unable to write file src/a.ts\n' },
        afterFailedMerge: { head: OLD, status: ' M src/a.ts\0' },
      }),
    );
    const line =
      'the update could not be applied: error: unable to write file src/a.ts; the checkout may not be as it was: set it right as docs/install.md says ("Updating"), then run skydeck window';
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `${STOPPED}skydeck: ${line}\n`);
    assert.deepEqual(withoutTime(h.entry()), {
      v: 1,
      root: h.root,
      state: 'failed',
      to: NEW,
      line,
    });
    assert.deepEqual(h.launches, []);
  });

  test('a refusal before the stop (the index lock, a changed file): `failed` with its line, the server still runs', async (t) => {
    const lock = await (async () => {
      const h = harness(t);
      const server = await h.serve({ FAKE_SERVE_PAGES: '1' });
      mkdirSync(join(h.root, '.git'));
      writeFileSync(join(h.root, '.git', 'index.lock'), '');
      const r = await h.update(scripted(h));
      return { h, server, r };
    })();
    const changed = await (async () => {
      const h = harness(t);
      const server = await h.serve({ FAKE_SERVE_PAGES: '1' });
      const r = await h.update(scripted(h, { status: ' M src/a.ts\0' }));
      return { h, server, r };
    })();
    for (const { h, server, r } of [lock, changed]) {
      assert.equal(r.code, 1);
      const line = r.stderr.slice('skydeck: '.length, -1);
      assert.match(line, /nothing was changed|commit or undo them first/);
      assert.deepEqual(withoutTime(h.entry()), {
        v: 1,
        root: h.root,
        state: 'failed',
        to: NEW,
        line,
      });
      assert.ok(server.running(), 'the server still runs');
      assert.ok(!h.events.includes('POST /shutdown'));
    }
    assert.match(lock.r.stderr, /git index is locked/);
    assert.match(changed.r.stderr, /changes that are not committed/);
  });

  test('a signal during the stop: `failed` with "interrupted …", without the tail of a bring-back that failed', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const captured = capture();
    h.onRequest = (method, path) => {
      if (path === '/shutdown') captured.signal('SIGINT');
    };
    let atLaunch: RunRecord | null = null;
    const runner = scripted(h, {
      launcher: 3,
      onCall: (call) => {
        if (call.command !== 'git') atLaunch = h.entry();
      },
    });
    const r = await runUpdateOn(h.platform(runner), h.s, captured, FLAG);
    const line = 'interrupted before the update was applied; the checkout was not changed';
    assert.deepEqual(
      withoutTime(atLaunch),
      { v: 1, root: h.root, state: 'failed', to: NEW, line },
      'recorded before the launcher (the bring-back) runs',
    );
    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      `${STOPPED}skydeck: ${line}, but skydeck window ended with exit 3; run skydeck window\n`,
    );
    assert.deepEqual(withoutTime(h.entry()), {
      v: 1,
      root: h.root,
      state: 'failed',
      to: NEW,
      line,
    });
  });

  test("a store that cannot be written at the record: one stderr line; the update's outcome and exit code unchanged; the entry left as the server wrote it", async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const applying: RunRecord = { v: 1, root: h.root, state: 'applying', to: NEW, atNs: '1' };
    withStore(h.tp.places, (store) => writeRun(store, applying));
    const runner = scripted(h, {
      onCall: (call) => {
        if (call.command === 'git' && subCommand(call, h.root) === 'merge') {
          chmodSync(h.tp.places.dbPath, 0o400);
        }
      },
    });

    const r = await h.update(runner);

    chmodSync(h.tp.places.dbPath, 0o600);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    const lines = r.stderr.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2, r.stderr);
    assert.equal(`${lines[0]}\n`, STOPPED);
    assert.match(
      lines[1] ?? '',
      /^skydeck: the window could not be told how the update ended \(.+\)$/,
    );
    assert.deepEqual(h.entry(), applying);
  });

  test('without the flag no entry is ever written', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const applied = await h.update(scripted(h), []);
    const refused = await h.update(scripted(h, { merge: { code: 1, stderr: 'fatal: x\n' } }), []);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(refused.code, 1);
    assert.equal(
      withStore(h.tp.places, (store) => store.getKv(RUN_KEY)),
      null,
    );
  });

  test("an app root given through a symbolic link: the entry's root is the real path, checkoutRoot of the link", async (t) => {
    const h = harness(t);
    const link = join(h.s.root, 'link');
    symlinkSync(h.root, link);
    await h.serve({
      FAKE_SERVE_PAGES: '1',
      FAKE_SERVE_CHECKOUT: link,
      FAKE_SERVE_BUILD: computeBuild(h.tp.platform.files, link),
    });
    const r = await runUpdate(
      { ...h.platform(scripted(h, { root: link })), appRoot: link },
      h.s,
      FLAG,
    );
    assert.equal(r.code, 0, r.stderr);
    const entry = h.entry();
    assert.equal(entry?.root, h.root);
    assert.equal(entry?.root, checkoutRoot(h.tp.platform.files, link));
    assert.notEqual(link, h.root);
  });
});

describe('skydeck update --from-window: a page asked, so its server must be stopped and brought back (review 2)', () => {
  test('a stopped server whose page count said 0: the window is brought back all the same', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '0' });
    const r = await h.update(scripted(h));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.equal(r.stderr, STOPPED);
    assert.deepEqual(
      h.launches.map((l) => [l.command, ...l.args]),
      [[join(h.root, 'bin', 'skydeck'), 'window']],
    );
  });

  test("no server of this checkout runs, or another checkout's: refused before the merge, recorded `failed` with why, nothing changed", async (t) => {
    const none = harness(t);
    const r1 = await none.update(scripted(none));
    const line1 =
      'no window server of this checkout runs, so the update started from the window was not applied; nothing was changed';
    assert.equal(r1.code, 1);
    assert.equal(r1.stderr, `skydeck: ${line1}\n`);
    assert.deepEqual(withoutTime(none.entry()), {
      v: 1,
      root: none.root,
      state: 'failed',
      to: NEW,
      line: line1,
    });
    assert.ok(!none.events.includes('git merge'));
    assert.deepEqual(none.launches, []);

    const other = harness(t);
    const server = await other.serve({
      FAKE_SERVE_CHECKOUT: '/elsewhere/skydeck',
      FAKE_SERVE_PAGES: '1',
    });
    const r2 = await other.update(scripted(other));
    const why = "the window's server runs from another checkout (/elsewhere/skydeck)";
    const line2 = `${why}, so the update started from the window was not applied; nothing was changed`;
    assert.equal(r2.code, 1);
    assert.equal(r2.stderr, `skydeck: ${why}; it is left as it is\nskydeck: ${line2}\n`);
    assert.deepEqual(withoutTime(other.entry()), {
      v: 1,
      root: other.root,
      state: 'failed',
      to: NEW,
      line: line2,
    });
    assert.ok(!other.events.includes('git merge'));
    assert.ok(server.running());
  });

  test('a database written by a newer skydeck: refused before the merge, nothing changed (the entry cannot be written there)', async (t) => {
    const h = harness(t);
    mkdirSync(h.tp.places.dataDir, { recursive: true });
    withStore(h.tp.places, (store) => store.setKv('schema_version', String(SCHEMA_VERSION + 1)));
    const r = await h.update(scripted(h));
    const line =
      "the database was written by a newer skydeck and the window's server was not looked at, so the update started from the window was not applied; nothing was changed";
    assert.equal(r.code, 1);
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    assert.equal(
      lines[0],
      "skydeck: the database was written by a newer skydeck, so the window's server is not looked at; it is left as it is",
    );
    assert.match(
      lines[1] ?? '',
      /^skydeck: the window could not be told how the update ended \(.+\)$/,
    );
    assert.equal(lines[2], `skydeck: ${line}`);
    assert.ok(!h.events.includes('git merge'));
    assert.deepEqual(h.launches, []);
  });
});

describe('after the merge --from-window loads nothing from the checkout (U6)', () => {
  test('applied, and a merge that failed: no module resolved, no file of the checkout touched after the merge, the entry written all the same', async (t) => {
    for (const over of [{}, { merge: { code: 1, stderr: 'fatal: a lock\n' } }]) {
      const h = harness(t);
      await h.serve({ FAKE_SERVE_PAGES: '1' });
      const resolved: string[] = [];
      const touched: string[] = [];
      let hooks: ReturnType<typeof registerHooks> | null = null;
      let merged = false;
      const runner = scripted(h, {
        ...over,
        onCall: (call) => {
          if (call.command === 'git' && subCommand(call, h.root) === 'merge' && !merged) {
            merged = true;
            hooks = registerHooks({
              resolve(specifier, context, next) {
                resolved.push(specifier);
                return next(specifier, context);
              },
            });
          }
        },
      });
      const base = h.platform(runner);
      const files = Object.fromEntries(
        Object.entries(base.files).map(([name, method]: [string, (...a: unknown[]) => unknown]) => [
          name,
          (...args: unknown[]) => {
            if (merged && args.some((a) => typeof a === 'string' && a.startsWith(h.root))) {
              touched.push(`${name} ${String(args[0])}`);
            }
            return method(...args);
          },
        ]),
      ) as unknown as Files;
      try {
        await runUpdate({ ...base, files }, h.s, FLAG);
      } finally {
        (hooks as ReturnType<typeof registerHooks> | null)?.deregister();
      }
      assert.ok(h.events.includes('git merge'));
      assert.equal(h.launches.length, 1);
      assert.deepEqual(resolved, []);
      assert.deepEqual(touched, []);
      assert.notEqual(h.entry(), null);
    }
  });
});
