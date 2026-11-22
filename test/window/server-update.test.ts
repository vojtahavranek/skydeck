// The window's check for a newer skydeck on a running server (F38; S2 16.5, 8.2.3): the real git on
// a small throwaway checkout inside the sandbox (test/helpers/git-checkout.ts), named to the server
// by the seam variable (updateSeam), its only remote a bare repository beside it (or an ssh
// address whose ssh is a sandbox stub that connects nowhere). The check at the start, Check now,
// the dialog's look, a known update kept through a fetch that failed, the server's stop during a
// check, and (milestone 2) Update now with a startDetached that records and never runs anything. In the test process (A19) on realTestPlatform; never a real home or the network.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { NS_PER_MINUTE } from '../../src/platform/time.ts';
import type { Platform } from '../../src/platform/types.ts';
import type { UpdatePayload } from '../../src/window/protocol.ts';
import { gitCheckout, gitTestEnv } from '../helpers/git-checkout.ts';
import type { GitCheckout } from '../helpers/git-checkout.ts';
import { sleep, until } from '../helpers/keeper.ts';
import { updateSeam } from '../helpers/update.ts';
import { earlierId, restoreSandbox } from '../helpers/window-restore.ts';
import { connectTestPage, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

interface Checked {
  d: ServerSandbox;
  c: GitCheckout;
  start(env?: Record<string, string>): Promise<TestServer>;
}

/** A server sandbox, a checkout inside it, and a start whose server looks at that checkout. */
function checked(t: TestContext, updateCheck: 'daily' | 'off'): Checked {
  const d = serverSandbox(t, { window: { updateCheck } });
  const c = gitCheckout(d.s);
  return {
    d,
    c,
    start: (env = {}) =>
      d.start({
        platform: (p) => ({
          ...p,
          env: { ...p.env, ...gitTestEnv(d.s), ...updateSeam(d.s, c), ...env },
        }),
      }),
  };
}

/** The next `update` message of `page` whose state passes `test`. */
async function updateWhere(
  page: TestPage,
  test: (update: UpdatePayload) => boolean,
  what: string,
): Promise<UpdatePayload> {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const message = await page.next('update', what, Math.max(1, until - Date.now()));
    if (test(message.update)) return message.update;
  }
}

/** The files under `dir` whose name ends with `.lock`. */
function locks(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.lock'));
}

describe('the check on a running server', () => {
  test('daily: checked at the start; Check now finds a pushed commit and every page is told; a changed file blocks; a remote gone keeps what is known', async (t) => {
    const k = checked(t, 'daily');
    const server = await k.start();
    const a = await connectTestPage(t, k.d, server.server);
    const current = await updateWhere(a, (u) => u.check !== null, 'the start check');
    assert.equal(current.check?.state, 'current', JSON.stringify(current));
    assert.match(
      current.check.summary,
      /^skydeck is up to date \(main at [0-9a-f]{7}, as origin\/main\)$/,
    );
    const b = await connectTestPage(t, k.d, server.server);

    const pushed = k.c.push('a commit the check brings', { 'README.md': 'two\n' });
    const result = await a.act({ kind: 'update-check' }, WAIT_MS);
    assert.equal(result.ok, true, JSON.stringify(result));
    const found = result.update?.check;
    assert.ok(found?.state === 'available', JSON.stringify(result));
    assert.equal(found.to, pushed);
    assert.ok(found.lines.some((line) => line.endsWith('a commit the check brings')));
    assert.equal(found.blocked, null);
    const told = await updateWhere(b, (u) => u.check?.state === 'available', 'B told');
    assert.deepEqual(told.check, found);

    writeFileSync(join(k.c.root, 'README.md'), 'changed by hand\n');
    const looked = await a.act({ kind: 'update-look' }, WAIT_MS);
    assert.ok(looked.update?.check?.state === 'available', JSON.stringify(looked));
    assert.equal(
      looked.update.check.blocked,
      'this checkout has changes that are not committed (1 file, the first: README.md); commit or undo them first',
    );

    renameSync(k.c.remote, `${k.c.remote}-moved`);
    const failed = await a.act({ kind: 'update-check' }, WAIT_MS);
    assert.ok(failed.update?.check?.state === 'available', JSON.stringify(failed));
    assert.equal(failed.update.check.to, pushed);
    assert.match(failed.update.failure?.line ?? '', /^git fetch from origin failed: /);
    assert.equal(failed.update.fetchedAtNs, result.update?.fetchedAtNs);
  });

  test('off: no fetch at the start; Check now still finds the commit', async (t) => {
    const k = checked(t, 'off');
    const before = k.c.id('origin/main');
    const pushed = k.c.push('pushed before the start', { 'README.md': 'two\n' });
    const server = await k.start();
    const a = await connectTestPage(t, k.d, server.server);
    const first = await a.next('update', 'the update after start', WAIT_MS);
    assert.equal(first.update.check, null);
    await sleep(2500); // a few ticks
    assert.equal(k.c.id('origin/main'), before, 'the remote-tracking ref has not moved');

    const result = await a.act({ kind: 'update-check' }, WAIT_MS);
    assert.ok(result.update?.check?.state === 'available', JSON.stringify(result));
    assert.equal(result.update.check.to, pushed);
    assert.equal(k.c.id('origin/main'), pushed);
  });
});

describe('the upstream branch pruned away', () => {
  test("a cannot with git's line, a failed check (the hour), and the dialog's look offers nothing", async (t) => {
    const k = checked(t, 'off');
    const server = await k.start();
    const page = await connectTestPage(t, k.d, server.server);
    k.c.push('a commit the check brings', { 'README.md': 'two\n' });
    const found = await page.act({ kind: 'update-check' }, WAIT_MS);
    assert.equal(found.update?.check?.state, 'available', JSON.stringify(found));

    k.c.git(k.c.root, 'config', 'fetch.prune', 'true');
    k.c.git(k.c.remote, 'update-ref', '-d', `refs/heads/${k.c.branch}`);
    const pruned = await page.act({ kind: 'update-check' }, WAIT_MS);

    const line = 'git rev-parse failed: fatal: Needed a single revision; nothing was changed';
    assert.deepEqual(pruned.update?.check, { state: 'cannot', summary: line });
    // A failed check: its line is kept, and the next check comes after the hour (updates.ts).
    assert.equal(pruned.update?.failure?.line, line);
    const looked = await page.act({ kind: 'update-look' }, WAIT_MS);
    assert.deepEqual(looked.update?.check, { state: 'cannot', summary: line });
    assert.equal(k.d.deck.store.getKv('window_update_check')?.includes('"available"'), false);
  });
});

describe("the server's stop during a check", () => {
  test("a stop during the dialog's look: the git call that runs gets SIGTERM, no further one starts, the stop ends in time", async (t) => {
    const k = checked(t, 'off');
    const started = join(k.d.s.root, 'status-started');
    const termed = join(k.d.s.root, 'status-termed');
    const calls = join(k.d.s.root, 'git-calls');
    // The sandbox's git: `status` traps TERM (a marker, exit 143) and would wait 30 s; every
    // other call is the real git's, and every call is counted.
    rmSync(join(k.d.s.bin, 'git'));
    writeFileSync(
      join(k.d.s.bin, 'git'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${calls}'`,
        'for a in "$@"; do',
        '  if [ "$a" = status ]; then',
        `    trap "echo termed > '${termed}'; exit 143" TERM`,
        `    echo started > '${started}'`,
        '    sleep 30 >/dev/null 2>&1 &',
        '    wait',
        '    exit 0',
        '  fi',
        'done',
        `exec '${k.c.gitPath}' "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(k.d.s.bin, 'git'), 0o755);
    const server = await k.start();
    const page = await connectTestPage(t, k.d, server.server);
    void page.act({ kind: 'update-look' }, WAIT_MS).catch(() => undefined);
    await until(() => existsSync(started), 'the look reached status', WAIT_MS);
    const before = readFileSync(calls, 'utf8').split('\n').length;

    const at = Date.now();
    await server.server.stop('the test stops it');
    const took = Date.now() - at;

    // Without the stop's signal the call would run until its own 10 s were over.
    assert.ok(took < 8_000, `the stop took ${took} ms`);
    assert.equal(readFileSync(termed, 'utf8'), 'termed\n');
    assert.equal(
      readFileSync(calls, 'utf8').split('\n').length,
      before,
      'no git call after the stop',
    );
    assert.equal(k.d.deck.store.getKv('window_update_check'), null);
  });

  test('SIGTERM first: a git that traps it ends within the grace, though a helper of its holds the pipe; nothing is stored', async (t) => {
    const k = checked(t, 'daily');
    const marker = join(k.d.s.root, 'git-termed');
    const helperPid = join(k.d.s.root, 'git-helper-pid');
    t.after(() => {
      if (existsSync(helperPid)) {
        try {
          process.kill(Number(readFileSync(helperPid, 'utf8').trim()), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
    // The sandbox's git: every call but the fetch goes to the real git; the fetch traps TERM
    // (writes the marker, exits 143) and starts a sleep of its own that keeps its stderr.
    rmSync(join(k.d.s.bin, 'git'));
    writeFileSync(
      join(k.d.s.bin, 'git'),
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = fetch ]; then',
        `    trap "echo termed > '${marker}'; exit 143" TERM`,
        '    sleep 30 &',
        `    echo $! > '${helperPid}'`,
        '    wait',
        '    exit 0',
        '  fi',
        'done',
        `exec '${k.c.gitPath}' "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(k.d.s.bin, 'git'), 0o755);
    const server = await k.start();
    await until(() => existsSync(helperPid), 'the fetch started', WAIT_MS);

    const started = Date.now();
    await server.server.stop('the test stops it');
    const took = Date.now() - started;

    assert.ok(took < 10_000, `the stop took ${took} ms`);
    assert.equal(readFileSync(marker, 'utf8'), 'termed\n');
    assert.ok(
      server.logs().some((line) => line.endsWith('server: stopped')),
      server.logs().join('\n'),
    );
    assert.equal(k.d.deck.store.getKv('window_update_check'), null, 'nothing stored');
    assert.deepEqual(
      server.logs().filter((line) => /update check|uncaught|unhandled/.test(line)),
      [],
    );
  });

  test('the real git with an ssh that never answers: the stop ends in time and no lock is left', async (t) => {
    const k = checked(t, 'daily');
    const s = k.d.s;
    const stubPid = join(s.root, 'ssh-pid');
    t.after(() => {
      if (existsSync(stubPid)) {
        try {
          process.kill(Number(readFileSync(stubPid, 'utf8').trim()), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
    writeFileSync(
      join(s.root, 'ssh-stub'),
      ['#!/bin/sh', `echo $$ > '${stubPid}'`, 'exec sleep 30', ''].join('\n'),
    );
    chmodSync(join(s.root, 'ssh-stub'), 0o755);
    k.c.git(k.c.root, 'remote', 'set-url', 'origin', 'ssh://stub.invalid/x');
    const server = await k.start({ GIT_SSH: join(s.root, 'ssh-stub'), GIT_SSH_VARIANT: 'simple' });
    await until(() => existsSync(stubPid), 'the ssh stub started', WAIT_MS);

    const started = Date.now();
    await server.server.stop('the test stops it');
    const took = Date.now() - started;

    assert.ok(took < 10_000, `the stop took ${took} ms`);
    assert.deepEqual(locks(join(k.c.root, '.git')), []);
    assert.equal(k.d.deck.store.getKv('window_update_check'), null);
  });
});

describe('Update now on a running server (milestone 2)', () => {
  /**
   * A startDetached that records each start of the updater (`update --from-window`) and never
   * ends it: no updater is ever run. Every other start (a keeper) is the platform's own.
   */
  function recording(): {
    calls: { command: string; args: readonly string[] }[];
    platform: (p: Platform) => Platform;
  } {
    const calls: { command: string; args: readonly string[] }[] = [];
    let pid = 7000;
    return {
      calls,
      platform: (p) => ({
        ...p,
        processes: {
          ...p.processes,
          startDetached(command, args, options) {
            if (!args.includes('--from-window')) {
              return p.processes.startDetached(command, args, options);
            }
            calls.push({ command, args });
            pid += 1;
            return Promise.resolve({ pid, exited: new Promise(() => {}) });
          },
        },
      }),
    };
  }

  test('two pages: the first update-apply answers ok and both pages get `applying`; the second page is refused; nothing real is started', async (t) => {
    const k = checked(t, 'off');
    const started = recording();
    const server = await k.d.start({
      platform: (p) =>
        started.platform({
          ...p,
          env: { ...p.env, ...gitTestEnv(k.d.s), ...updateSeam(k.d.s, k.c) },
        }),
    });
    const a = await connectTestPage(t, k.d, server.server);
    const b = await connectTestPage(t, k.d, server.server);
    const pushed = k.c.push('a commit to apply', { 'README.md': 'two\n' });
    const found = await a.act({ kind: 'update-check' }, WAIT_MS);
    assert.equal(found.update?.check?.state, 'available', JSON.stringify(found));

    const first = await a.act({ kind: 'update-apply', to: pushed }, WAIT_MS);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.update?.applying?.to, pushed);
    for (const page of [a, b]) {
      await updateWhere(page, (u) => u.applying?.to === pushed, 'told applying');
    }
    const second = await b.act({ kind: 'update-apply', to: pushed }, WAIT_MS);
    assert.deepEqual(
      { ok: second.ok, error: second.error },
      { ok: false, error: 'an update is already running' },
    );
    assert.deepEqual(started.calls, [
      { command: join(k.c.root, 'bin', 'skydeck'), args: ['update', '--from-window', pushed] },
    ]);
    const entry = k.d.deck.store.getKv('window_update_run');
    assert.match(entry ?? '', /"state":"applying"/);
    assert.match(
      readFileSync(join(k.d.deck.places.stateDir, 'update.log'), 'utf8'),
      / update to [0-9a-f]{7} started from the window\n$/,
    );
  });

  test('another commit id, a blocked checkout: refused, nothing started, the server keeps running', async (t) => {
    const k = checked(t, 'off');
    const started = recording();
    const server = await k.d.start({
      platform: (p) =>
        started.platform({
          ...p,
          env: { ...p.env, ...gitTestEnv(k.d.s), ...updateSeam(k.d.s, k.c) },
        }),
    });
    const page = await connectTestPage(t, k.d, server.server);
    const pushed = k.c.push('a commit to apply', { 'README.md': 'two\n' });
    await page.act({ kind: 'update-check' }, WAIT_MS);

    const other = await page.act({ kind: 'update-apply', to: 'e'.repeat(40) }, WAIT_MS);
    assert.deepEqual(
      { ok: other.ok, error: other.error },
      {
        ok: false,
        error: "the window's last check does not name that commit; open the dialog again",
      },
    );
    writeFileSync(join(k.c.root, 'README.md'), 'changed by hand\n');
    const blocked = await page.act({ kind: 'update-apply', to: pushed }, WAIT_MS);
    assert.deepEqual(
      { ok: blocked.ok, error: blocked.error },
      {
        ok: false,
        error:
          'this checkout has changes that are not committed (1 file, the first: README.md); commit or undo them first; open the dialog again once that is set right',
      },
    );
    assert.deepEqual(started.calls, []);
    assert.equal(k.d.deck.store.getKv('window_update_run'), null);
  });

  test('while a restore runs: refused with its words, nothing started', async (t) => {
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    const c = gitCheckout(r.d.s);
    const baseNs = r.d.platform.clock.nowNs() - 90n * NS_PER_MINUTE;
    r.earlierBoot([{ sessionId: earlierId(1), startNs: baseNs }]);
    const started = recording();
    const server = await r.d.start({
      platform: (p) =>
        started.platform({
          ...p,
          env: { ...p.env, ...gitTestEnv(r.d.s), ...updateSeam(r.d.s, c) },
        }),
    });
    const page = await connectTestPage(t, r.d, server.server);
    const pushed = c.push('a commit to apply', { 'README.md': 'two\n' });
    await page.act({ kind: 'update-check' }, WAIT_MS);
    await page.list((l) => l.banner !== null, 'the banner');
    const restore = await page.act({ kind: 'restore', sessionIds: [earlierId(1)] });
    assert.equal(restore.ok, true, JSON.stringify(restore));
    await until(() => r.waiting(earlierId(1)), 'the restore at its gate', WAIT_MS);

    const refused = await page.act({ kind: 'update-apply', to: pushed }, WAIT_MS);

    assert.deepEqual(
      { ok: refused.ok, error: refused.error },
      { ok: false, error: 'a restore is running; update once it has finished' },
    );
    assert.deepEqual(started.calls, []);
    r.open(earlierId(1));
  });
});
