// `skydeck update` and the window's server (F8: U2 9, U5, U6, U8). The server is the fake `serve`
// of test/fixtures/fake-serve (a real process this file starts: it answers server.sock as a server
// does and ends at POST /shutdown); git is the scripted one of test/helpers/update.ts — or, in the
// last case, the real git on a throwaway checkout —, and the new checkout's launcher is recorded,
// never run (update-window.test.ts runs it with a real server). Nothing here signals a process:
// the command's processes refuse every signal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Files, Net, Platform, Processes, Runner } from '../../../src/platform/types.ts';
import { computeBuild } from '../../../src/window/build.ts';
import { gitCheckout, gitTestEnv } from '../../helpers/git-checkout.ts';
import type { Run } from '../../helpers/install.ts';
import { procStartOf, stillRuns } from '../../helpers/keeper.ts';
import { realTestPlatform } from '../../helpers/platform.ts';
import type { RealTestPlatform, RunCall } from '../../helpers/platform.ts';
import type { Sandbox } from '../../helpers/sandbox.ts';
import { capture } from '../../helpers/capture.ts';
import {
  OLD,
  runUpdate,
  runUpdateOn,
  scriptedGit,
  scriptedRepo,
  subCommand,
} from '../../helpers/update.ts';
import type { ScriptedRepo } from '../../helpers/update.ts';

const FAKE_SERVE = fileURLToPath(new URL('../../fixtures/fake-serve/bin/skydeck', import.meta.url));

/** The report of the scripted repository's one new commit (U4). */
const ONE_COMMIT = '1 new commit on origin/main (0123456..fedcba9):\n  fedcba9  the new commit\n';
const STOPPED =
  "skydeck: stopped skydeck's window server; 0 terminals in the window keep running\n";

interface FakeServer {
  child: ChildProcess;
  pid: number;
  procStart: number;
  running(): boolean;
}

interface Harness {
  tp: RealTestPlatform;
  s: Sandbox;
  root: string;
  /** What happened, in order: `git <sub>`, `launch <path> <args>`, `<METHOD> <path>` of server.sock. */
  events: string[];
  /** The launcher calls (runInteractive of a program that is not git). */
  launches: RunCall[];
  /** Every signal the command asked for (it is refused). */
  signals: number[];
  /** Called at every request on server.sock, before it is sent (a test acts during the stop). */
  onRequest: (method: string, path: string) => void;
  platform(runner: Runner): Platform;
  /** The fake serve with `env` over its defaults (this checkout and its build, no page). */
  serve(env?: Record<string, string>): Promise<FakeServer>;
  update(runner: Runner, args?: string[]): Promise<Run>;
}

/** `times`: SKYDECK_TEST_WINDOW_TIMES of the command (default a ping wait of 1.5 s). */
function harness(t: TestContext, times = 'pingMs=1500'): Harness {
  const tp = realTestPlatform(t, {
    env: (s) => ({
      ...gitTestEnv(s),
      SKYDECK_NODE: process.execPath,
      SKYDECK_TEST_WINDOW_TIMES: times,
    }),
  });
  const s = tp.sandbox;
  const root = join(s.root, 'checkout');
  mkdirSync(root);
  const owned: ChildProcess[] = [];
  t.after(() => {
    for (const child of owned) child.kill('SIGKILL'); // nothing once it has exited
  });
  const events: string[] = [];
  const signals: number[] = [];
  const processes: Processes = {
    startDetached: () => Promise.reject(new Error('skydeck update starts nothing detached')),
    signal(pid) {
      signals.push(pid);
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
    signals,
    onRequest: () => {},
    platform: (runner) => ({
      ...tp.platform,
      appRoot: root,
      cwd: s.home,
      processes,
      net,
      runner,
    }),
    async serve(env = {}) {
      const child = spawn(FAKE_SERVE, ['serve'], {
        env: s.env({
          SKYDECK_NODE: process.execPath,
          FAKE_SERVE_CHECKOUT: root,
          FAKE_SERVE_BUILD: computeBuild(tp.platform.files, root),
          ...env,
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
      return { child, pid, procStart, running: () => stillRuns(pid, procStart) };
    },
    update: (runner, args = []) => runUpdate(h.platform(runner), s, args),
  };
  return h;
}

/** The scripted git on the harness's checkout, recording into its events and launches. */
function scripted(h: Harness, over: Partial<ScriptedRepo> = {}): ReturnType<typeof scriptedGit> {
  return scriptedGit(
    scriptedRepo(h.root, {
      ...over,
      onCall: (call, interactive) => {
        if (call.command === 'git') {
          h.events.push(`git ${subCommand(call, h.root)}`);
        } else {
          h.events.push(`launch ${call.command} ${call.args.join(' ')}`);
          h.launches.push(call);
        }
        over.onCall?.(call, interactive);
      },
    }),
  );
}

/** Asserts that `first` happened, then `second`, each once. */
function inOrder(events: string[], ...names: string[]): void {
  const at = names.map((name) => {
    assert.equal(
      events.filter((e) => e === name).length,
      1,
      `${name} once in ${events.join(', ')}`,
    );
    return events.indexOf(name);
  });
  for (let i = 1; i < at.length; i += 1) {
    assert.ok((at[i - 1] ?? 0) < (at[i] ?? 0), `${names.join(' < ')}: ${events.join(', ')}`);
  }
}

describe('skydeck update with a window server of this checkout (U5)', () => {
  for (const kind of ['ours', 'other-build'] as const) {
    test(`${kind}, a page open: its pages read, then stopped, BEFORE the merge; after it, the checkout's own launcher as a new process with the command's environment, working directory and terminal`, async (t) => {
      const h = harness(t);
      const server = await h.serve({
        FAKE_SERVE_PAGES: '1',
        ...(kind === 'other-build' ? { FAKE_SERVE_BUILD: 'another-build' } : {}),
      });
      let runningAtMerge: boolean | null = null;
      const runner = scripted(h, {
        onCall: (call) => {
          if (call.command === 'git' && subCommand(call, h.root) === 'merge') {
            runningAtMerge = server.running();
          }
        },
      });

      const r = await h.update(runner);

      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
      assert.equal(r.stderr, STOPPED);
      // The untracked files are listed before the stop (the re-check's K4): a listing that fails
      // then ends the command with nothing changed.
      inOrder(
        h.events,
        'git ls-files',
        'GET /status',
        'POST /shutdown',
        'git merge',
        `launch ${h.root}/bin/skydeck window`,
      );
      assert.equal(runningAtMerge, false, 'the server had ended before the merge');
      const [launch] = h.launches;
      assert.deepEqual(launch?.args, ['window']);
      assert.equal(launch?.options?.cwd, h.s.home, "the command's working directory");
      const env = launch?.options?.env;
      assert.deepEqual(
        env,
        Object.fromEntries(Object.entries(h.tp.platform.env).filter(([, v]) => v !== undefined)),
        "the command's own environment, unchanged",
      );
      assert.deepEqual(h.signals, []);
    });
  }

  test('no page open: stopped, nothing started, the line saying how it comes back', async (t) => {
    const h = harness(t);
    const server = await h.serve({ FAKE_SERVE_PAGES: '0' });

    const r = await h.update(scripted(h));

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.equal(
      r.stderr,
      `${STOPPED}skydeck: the window's server was stopped for the update; skydeck window starts it again\n`,
    );
    inOrder(h.events, 'POST /shutdown', 'git merge');
    assert.deepEqual(h.launches, []);
    assert.equal(server.running(), false);
  });

  test('the launcher ends with another exit code, or cannot be started: exit 1 and the line naming skydeck window', async (t) => {
    for (const [launcher, line] of [
      [
        3,
        'skydeck: updated to fedcba9, but skydeck window ended with exit 3; run skydeck window\n',
      ],
      [
        null,
        'skydeck: updated to fedcba9, but skydeck window could not be started or was ended by a signal; run skydeck window\n',
      ],
    ] as const) {
      const h = harness(t);
      await h.serve({ FAKE_SERVE_PAGES: '2' });
      const r = await h.update(scripted(h, { launcher }));
      assert.equal(r.code, 1);
      assert.equal(r.stdout, ONE_COMMIT);
      assert.equal(r.stderr, `${STOPPED}${line}`);
    }
  });

  test('the merge fails: the window is brought back all the same (the launcher after the merge), exit 1, "the checkout is as it was"', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });

    const r = await h.update(scripted(h, { merge: { code: 1, stderr: 'fatal: a lock\n' } }));

    assert.equal(r.code, 1);
    assert.equal(r.stdout, ONE_COMMIT);
    assert.equal(
      r.stderr,
      `${STOPPED}skydeck: the update could not be applied: fatal: a lock; the checkout is as it was\n`,
    );
    inOrder(h.events, 'POST /shutdown', 'git merge', `launch ${h.root}/bin/skydeck window`);
    assert.deepEqual(h.events.slice(h.events.indexOf('git merge') + 1), [
      'git rev-parse',
      'git status',
      'git ls-files',
      `launch ${h.root}/bin/skydeck window`,
    ]);
  });

  test('the merge fails and the checkout is not as it was: no window started on what is on disk', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });

    const r = await h.update(
      scripted(h, {
        merge: { code: 128, stderr: 'error: unable to write file src/a.ts\n' },
        afterFailedMerge: { head: OLD, status: ' M src/a.ts\0' },
      }),
    );

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      `${STOPPED}skydeck: the update could not be applied: error: unable to write file src/a.ts; the checkout may not be as it was: set it right as docs/install.md says ("Updating"), then run skydeck window\n`,
    );
    assert.deepEqual(h.launches, []);
  });
});

describe('signals once the stop has begun (ruled by the plan owner, review 2 S2)', () => {
  const INTERRUPTED =
    'skydeck: interrupted before the update was applied; the checkout was not changed\n';

  test('a signal during the stop: the stop ends, no merge, the window back on the old code (a page was open), the line, exit 1', async (t) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const h = harness(t);
      await h.serve({ FAKE_SERVE_PAGES: '1' });
      const captured = capture();
      const held: boolean[] = [];
      h.onRequest = (method, path) => {
        if (path === '/shutdown') held.push(captured.signal(signal));
      };

      const r = await runUpdateOn(h.platform(scripted(h)), h.s, captured);

      assert.deepEqual(held, [true], `${signal} held during the stop`);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, ONE_COMMIT);
      assert.equal(r.stderr, `${STOPPED}${INTERRUPTED}`);
      assert.ok(!h.events.includes('git merge'), 'no merge');
      inOrder(h.events, 'POST /shutdown', `launch ${h.root}/bin/skydeck window`);
      assert.equal(captured.signal(signal), false, 'released at the end');
    }
  });

  test('a signal during the stop of a server with no page: no merge, nothing started, the lines, exit 1', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '0' });
    const captured = capture();
    h.onRequest = (method, path) => {
      if (path === '/shutdown') captured.signal('SIGINT');
    };

    const r = await runUpdateOn(h.platform(scripted(h)), h.s, captured);

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      `${STOPPED}skydeck: the window's server was stopped for the update; skydeck window starts it again\n${INTERRUPTED}`,
    );
    assert.ok(!h.events.includes('git merge'));
    assert.deepEqual(h.launches, []);
  });

  test('SIGHUP is not held (ruled): during the stop it would end the command as it always did', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const captured = capture();
    const held: boolean[] = [];
    h.onRequest = (method, path) => {
      if (path === '/shutdown') held.push(captured.signal('SIGHUP'), captured.signal('SIGINT'));
    };

    await runUpdateOn(h.platform(scripted(h)), h.s, captured);

    assert.deepEqual(held, [false, true], 'SIGHUP not held, SIGINT held at the same moment');
  });

  test('a signal during the merge abandons nothing: the merge’s result is used, the window brought back, "updated to", exit 0', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const captured = capture();
    const held: boolean[] = [];
    const runner = scripted(h, {
      onCall: (call) => {
        if (call.command === 'git' && subCommand(call, h.root) === 'merge') {
          held.push(captured.signal('SIGINT'), captured.signal('SIGTERM'));
        }
      },
    });

    const r = await runUpdateOn(h.platform(runner), h.s, captured);

    assert.deepEqual(held, [true, true]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.equal(r.stderr, STOPPED);
    inOrder(h.events, 'git merge', `launch ${h.root}/bin/skydeck window`);
  });

  test('the hold lasts to the last line: a signal while the new checkout’s launcher runs is held, and the result line comes', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const captured = capture();
    const held: boolean[] = [];
    const runner = scripted(h, {
      onCall: (call) => {
        if (call.command !== 'git') held.push(captured.signal('SIGINT'));
      },
    });

    const r = await runUpdateOn(h.platform(runner), h.s, captured);

    assert.deepEqual(held, [true], 'held while the launcher ran');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.equal(captured.signal('SIGINT'), false, 'released after the last line');
  });

  test('a bring-back that does not go well is said, and named, after an interrupted update and after a refused merge (ruled, the re-check’s R2)', async (t) => {
    const tails = [
      [3, ', but skydeck window ended with exit 3; run skydeck window'],
      [
        null,
        ', but skydeck window could not be started or was ended by a signal; run skydeck window',
      ],
    ] as const;
    for (const [launcher, tail] of tails) {
      // Interrupted during the stop.
      const h = harness(t);
      await h.serve({ FAKE_SERVE_PAGES: '1' });
      const captured = capture();
      h.onRequest = (method, path) => {
        if (path === '/shutdown') captured.signal('SIGINT');
      };
      const r = await runUpdateOn(h.platform(scripted(h, { launcher })), h.s, captured);
      assert.equal(r.code, 1);
      assert.equal(
        r.stderr,
        `${STOPPED}skydeck: interrupted before the update was applied; the checkout was not changed${tail}\n`,
      );
      // A merge git refused, the checkout as it was.
      const h2 = harness(t);
      await h2.serve({ FAKE_SERVE_PAGES: '1' });
      const r2 = await h2.update(
        scripted(h2, { launcher, merge: { code: 1, stderr: 'error: a refusal\n' } }),
      );
      assert.equal(r2.code, 1);
      assert.equal(
        r2.stderr,
        `${STOPPED}skydeck: the update could not be applied: error: a refusal; the checkout is as it was${tail}\n`,
      );
    }
  });

  test('before the stop nothing is held: a signal during the fetch would end the command as it always did', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_PAGES: '1' });
    const captured = capture();
    const held: boolean[] = [];
    const runner = scripted(h, {
      onCall: (call) => {
        if (call.command === 'git' && call.args.includes('fetch')) {
          held.push(captured.signal('SIGINT'));
        }
      },
    });

    const r = await runUpdateOn(h.platform(runner), h.s, captured);

    assert.deepEqual(held, [false], 'not held: the real process would have ended');
    assert.equal(r.code, 0, r.stderr);
  });
});

describe('skydeck update with another server, or none that answers (U2 9, U5 1)', () => {
  test('a server that answers its shutdown but does not end, and cannot be signalled: the stop’s error and "the checkout was not changed" — no merge', async (t) => {
    const h = harness(t, 'pingMs=1500,stopMs=300');
    const server = await h.serve({ FAKE_SERVE_PAGES: '1', FAKE_SERVE_ON_SHUTDOWN: 'stay' });

    const r = await h.update(scripted(h));

    assert.equal(r.code, 1);
    assert.equal(r.stdout, ONE_COMMIT);
    assert.equal(
      r.stderr,
      `skydeck: the window's server (pid ${server.pid}) cannot be sent SIGTERM (Error: this test signals nothing, not ${server.pid}); the checkout was not changed\n`,
    );
    inOrder(h.events, 'GET /status', 'POST /shutdown');
    assert.ok(!h.events.includes('git merge'));
    assert.deepEqual(h.signals, [server.pid]);
    assert.deepEqual(h.launches, []);
  });

  test('a server of another checkout: neither asked for its pages nor stopped; the line; merged; nothing started', async (t) => {
    const h = harness(t);
    const server = await h.serve({
      FAKE_SERVE_CHECKOUT: '/elsewhere/\x1b[31mskydeck\n',
      FAKE_SERVE_PAGES: '1',
    });

    const r = await h.update(scripted(h));

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${ONE_COMMIT}updated to fedcba9\n`);
    assert.equal(
      r.stderr,
      "skydeck: the window's server runs from another checkout (/elsewhere/skydeck ); it is left as it is\n",
    );
    assert.deepEqual(
      h.events.filter((e) => !e.startsWith('git ') && e !== 'GET /ping'),
      [],
      'only pinged',
    );
    assert.deepEqual(h.launches, []);
    assert.ok(server.running(), 'still running');
  });

  test('a server that does not answer: after the report, the window’s line and "nothing was changed" — no merge, no signal', async (t) => {
    const h = harness(t);
    const server = await h.serve({ FAKE_SERVE_MODE: 'silent' });

    const r = await h.update(scripted(h));

    assert.equal(r.code, 1);
    assert.equal(r.stdout, ONE_COMMIT);
    assert.equal(
      r.stderr,
      `skydeck: the window's server (pid ${server.pid}) does not answer; skydeck window --restart stops it; nothing was changed\n`,
    );
    assert.ok(!h.events.includes('git merge'));
    assert.ok(!h.events.includes('POST /shutdown'));
    assert.deepEqual(h.launches, []);
    assert.deepEqual(h.signals, []);
    assert.ok(server.running());
  });

  test('--check and an up-to-date checkout never look at the server, whatever it is', async (t) => {
    const h = harness(t);
    await h.serve({ FAKE_SERVE_MODE: 'silent' });

    const checked = await h.update(scripted(h), ['--check']);
    const up = await h.update(scripted(h, { fetched: OLD }));

    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(checked.stdout, `${ONE_COMMIT}run skydeck update to apply it\n`);
    assert.equal(up.code, 0, up.stderr);
    assert.deepEqual(
      h.events.filter((e) => !e.startsWith('git ')),
      [],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// U6: after the merge the old process loads nothing

describe('after the merge this process loads nothing from the checkout (U6)', () => {
  /**
   * Runs the update with a resolve hook registered at the merge (every module resolution of this
   * process from then on is recorded) and every file access below the checkout recorded from then
   * on; both are given back when the command ends.
   */
  async function watched(
    h: Harness,
    over: Partial<ScriptedRepo>,
  ): Promise<{ r: Run; resolved: string[]; touched: string[] }> {
    const resolved: string[] = [];
    const touched: string[] = [];
    let hooks: ReturnType<typeof registerHooks> | null = null;
    let merged = false;
    const runner = scripted(h, {
      ...over,
      onCall: (call, interactive) => {
        if (call.command === 'git' && subCommand(call, h.root) === 'merge' && !merged) {
          merged = true;
          hooks = registerHooks({
            resolve(specifier, context, next) {
              resolved.push(specifier);
              return next(specifier, context);
            },
          });
        }
        over.onCall?.(call, interactive);
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
      const r = await runUpdate({ ...base, files }, h.s);
      return { r, resolved, touched };
    } finally {
      (hooks as ReturnType<typeof registerHooks> | null)?.deregister();
    }
  }

  test('applied with the window brought back, and a merge that failed: no module resolved, no file of the checkout touched after the merge', async (t) => {
    for (const over of [{}, { merge: { code: 1, stderr: 'fatal: a lock\n' } }]) {
      const h = harness(t);
      await h.serve({ FAKE_SERVE_PAGES: '1' });
      const { r, resolved, touched } = await watched(h, over);
      assert.ok(h.events.includes('git merge'));
      assert.equal(h.launches.length, 1, r.stderr);
      assert.deepEqual(resolved, []);
      assert.deepEqual(touched, []);
    }
  });

  test('the watch itself sees a module loaded after the merge (its control)', async (t) => {
    const h = harness(t);
    const { resolved } = await watched(h, {
      onCall: (call) => {
        if (call.command === 'git' && subCommand(call, h.root) === 'merge') {
          void import('../../../src/cli/commands/doctor.ts');
        }
      },
    });
    assert.ok(
      resolved.some((specifier) => specifier.endsWith('doctor.ts')),
      resolved.join(', '),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The real git with the fake serve

describe('skydeck update with the real git and a window open (U8)', () => {
  test('an untracked file in the way of the merge: the checkout as it was, and the window brought back', async (t) => {
    const h = harness(t);
    const c = gitCheckout(h.s, { name: 'real' });
    const old = c.id();
    c.push('add new.txt', { 'new.txt': 'from the remote\n' });
    writeFileSync(join(c.root, 'new.txt'), 'my own\n');
    const launches: RunCall[] = [];
    const runner: Runner = {
      run: (command, args, options) => h.tp.platform.runner.run(command, args, options),
      runInteractive(command, args, options) {
        if (command === 'git') return h.tp.platform.runner.runInteractive(command, args, options);
        launches.push({ command, args, options });
        h.events.push(`launch ${command}`);
        return Promise.resolve(0);
      },
    };
    const realRoot = realpathSync(c.root);
    const server = await h.serve({
      FAKE_SERVE_CHECKOUT: realRoot,
      FAKE_SERVE_BUILD: computeBuild(h.tp.platform.files, realRoot),
      FAKE_SERVE_PAGES: '1',
    });

    const r = await runUpdate({ ...h.platform(runner), appRoot: realRoot }, h.s);

    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /^skydeck: stopped skydeck's window server; 0 terminals in the window keep running\nskydeck: the update could not be applied: error: .*would be overwritten by merge:; the checkout is as it was\n$/,
    );
    assert.equal(server.running(), false);
    assert.deepEqual(
      launches.map((l) => [l.command, ...l.args]),
      [[join(realRoot, 'bin', 'skydeck'), 'window']],
    );
    assert.equal(c.id(), old);
    assert.equal(c.git(c.root, 'status', '--porcelain'), '?? new.txt\n');
    assert.equal(readFileSync(join(c.root, 'new.txt'), 'utf8'), 'my own\n');
  });
});
