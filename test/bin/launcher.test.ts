// Most tests use fake "node" executables that print what they were given, so they check which
// binary is chosen and how it is called without depending on the machine's Node. The last block
// runs the real thing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import pkg from '../../package.json' with { type: 'json' };
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const launcher = fileURLToPath(new URL('../../bin/skydeck', import.meta.url));
const bootstrap = realpathSync(fileURLToPath(new URL('../../bin/bootstrap.mjs', import.meta.url)));

/** A sandbox whose PATH holds only the programs the launcher itself uses. */
function launcherSandbox(t: TestContext): Sandbox {
  const s = sandbox(t);
  s.link('dirname', 'readlink', 'mktemp', 'cat', 'rm');
  // The launcher creates its handoff file in TMPDIR: keep it inside the sandbox.
  const tmp = join(s.root, 'tmp');
  mkdirSync(tmp);
  return { ...s, env: (extra) => s.env({ TMPDIR: tmp, ...extra }) };
}

function writeFakeNode(path: string, name: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\necho "node=${name}"\necho "cache=$NODE_COMPILE_CACHE"\nfor a in "$@"; do echo "arg=$a"; done\n`,
  );
  chmodSync(path, 0o755);
}

/** Makes `<dir>/node` a symlink to a fake node that reports itself as `name`. */
function pin(s: Sandbox, dir: string, name: string): void {
  const target = join(s.root, 'pinned', name, 'node');
  writeFakeNode(target, name);
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, join(dir, 'node'));
}

interface Launched {
  status: number | null;
  stderr: string;
  node: string | undefined;
  cache: string | undefined;
  args: string[];
}

function launch(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Launched {
  const result = spawnSync(command, args, { env, cwd, encoding: 'utf8' });
  const lines = result.stdout.split('\n');
  const field = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
  return {
    status: result.status,
    stderr: result.stderr,
    node: field('node'),
    cache: field('cache'),
    args: lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice('arg='.length)),
  };
}

describe('bin/skydeck: which node it runs', () => {
  test('SKYDECK_NODE wins over the pinned link and over node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.skydeckHome, 'data'), 'pinned');
    writeFakeNode(join(s.root, 'explicit', 'my-node'), 'explicit');

    const r = launch(launcher, [], s.env({ SKYDECK_NODE: join(s.root, 'explicit', 'my-node') }));

    assert.equal(r.node, 'explicit');
  });

  test('$SKYDECK_HOME/data/node is used when SKYDECK_NODE is unset, ahead of node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.skydeckHome, 'data'), 'pinned');

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'pinned');
  });

  test('SKYDECK_HOME replaces the XDG and HOME locations instead of adding to them', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const xdgData = join(s.root, 'xdg-data');
    pin(s, join(xdgData, 'skydeck'), 'xdg');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(launcher, [], s.env({ XDG_DATA_HOME: xdgData }));

    assert.equal(r.node, 'path');
  });

  test('an empty SKYDECK_HOME counts as unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const xdgData = join(s.root, 'xdg-data');
    pin(s, join(xdgData, 'skydeck'), 'xdg');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: '', XDG_DATA_HOME: xdgData }));

    assert.equal(r.node, 'xdg');
  });

  test('without SKYDECK_HOME, $XDG_DATA_HOME/skydeck/node is used ahead of node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const xdgData = join(s.root, 'xdg-data');
    pin(s, join(xdgData, 'skydeck'), 'xdg');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: undefined, XDG_DATA_HOME: xdgData }));

    assert.equal(r.node, 'xdg');
  });

  test('without SKYDECK_HOME and XDG_DATA_HOME the link is under $HOME/.local/share', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: undefined }));

    assert.equal(r.node, 'home');
  });

  test('a relative SKYDECK_HOME is ignored, as if it were unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    // Started from s.root, a relative SKYDECK_HOME would find this link, so it must be refused.
    pin(s, join(s.root, 'rel-home', 'data'), 'relative');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(launcher, [], s.env({ SKYDECK_HOME: 'rel-home' }), s.root);

    assert.equal(r.node, 'home');
  });

  test('a relative XDG_DATA_HOME is ignored, as if it were unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    pin(s, join(s.root, 'rel-xdg', 'skydeck'), 'relative');
    pin(s, join(s.home, '.local/share/skydeck'), 'home');

    const r = launch(
      launcher,
      [],
      s.env({ SKYDECK_HOME: undefined, XDG_DATA_HOME: 'rel-xdg' }),
      s.root,
    );

    assert.equal(r.node, 'home');
  });

  test('falls back to node on PATH when there is no link', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('falls back to node on PATH when the link is dangling', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.skydeckHome, 'data'));
    symlinkSync(join(s.root, 'gone', 'node'), join(s.skydeckHome, 'data', 'node'));

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('a link that points at a directory is skipped in favour of node on PATH', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.skydeckHome, 'data'));
    symlinkSync(s.root, join(s.skydeckHome, 'data', 'node'));

    const r = launch(launcher, [], s.env());

    assert.equal(r.node, 'path');
  });

  test('says what is wrong and exits 127 when there is no node to run', (t) => {
    const s = launcherSandbox(t);

    const r = launch(launcher, [], s.env({ SKYDECK_NODE: join(s.root, 'no-such-node') }));

    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot run '.*no-such-node'.*SKYDECK_NODE/);
  });

  test('refuses a directory or a file that is not executable as SKYDECK_NODE', (t) => {
    const s = launcherSandbox(t);
    const notExecutable = join(s.root, 'not-executable');
    writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
    chmodSync(notExecutable, 0o644);

    for (const bad of [s.root, notExecutable]) {
      const r = launch(launcher, [], s.env({ SKYDECK_NODE: bad }));

      assert.equal(r.status, 127, bad);
      assert.match(r.stderr, /cannot run '.*'.*SKYDECK_NODE/, bad);
    }
  });

  test('says the same when node is missing from PATH', (t) => {
    const s = launcherSandbox(t);

    const r = launch(launcher, [], s.env());

    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot run 'node'/);
  });
});

describe('bin/skydeck: how it calls node', () => {
  test('runs bootstrap.mjs with every argument passed through untouched', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, ['--flag', 'two words', '', '$HOME', '*'], s.env());

    assert.deepEqual(r.args, [bootstrap, '--flag', 'two words', '', '$HOME', '*']);
  });

  test('runs the real bootstrap.mjs when reached through a chain of symlinks', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    mkdirSync(join(s.root, 'a'));
    mkdirSync(join(s.root, 'b'));
    symlinkSync(launcher, join(s.root, 'a', 'skydeck'));
    symlinkSync('../a/skydeck', join(s.root, 'b', 'skydeck')); // relative link to a link

    const r = launch(join(s.root, 'b', 'skydeck'), ['x'], s.env());

    assert.deepEqual(r.args, [bootstrap, 'x']);
  });

  test('resolves its own location physically, through a symlinked directory', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    symlinkSync(dirname(launcher), join(s.root, 'linked-bin'));

    const r = launch(join(s.root, 'linked-bin', 'skydeck'), [], s.env());

    assert.deepEqual(r.args, [bootstrap]);
  });

  test('is not misled by CDPATH when started by a relative path', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');
    const checkout = dirname(dirname(launcher));
    // With CDPATH=<s.root>, a plain `cd bin` would land in <s.root>/bin instead of <checkout>/bin.
    const r = launch('bin/skydeck', [], s.env({ CDPATH: s.root }), checkout);

    assert.deepEqual(r.args, [bootstrap]);
  });

  test('NODE_COMPILE_CACHE defaults to $XDG_CACHE_HOME/skydeck/compile-cache', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ XDG_CACHE_HOME: '/xdg/cache' }));

    assert.equal(r.cache, '/xdg/cache/skydeck/compile-cache');
  });

  test('NODE_COMPILE_CACHE defaults to $HOME/.cache/skydeck/compile-cache without XDG_CACHE_HOME', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env());

    assert.equal(r.cache, join(s.home, '.cache/skydeck/compile-cache'));
  });

  test('a relative XDG_CACHE_HOME is ignored', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ XDG_CACHE_HOME: 'rel-cache' }), s.root);

    assert.equal(r.cache, join(s.home, '.cache/skydeck/compile-cache'));
  });

  test('an empty NODE_COMPILE_CACHE counts as unset', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(launcher, [], s.env({ NODE_COMPILE_CACHE: '' }));

    assert.equal(r.cache, join(s.home, '.cache/skydeck/compile-cache'));
  });

  test('a NODE_COMPILE_CACHE that is already set is left alone', (t) => {
    const s = launcherSandbox(t);
    writeFakeNode(join(s.bin, 'node'), 'path');

    const r = launch(
      launcher,
      [],
      s.env({ NODE_COMPILE_CACHE: '/my/cache', XDG_CACHE_HOME: '/xdg/cache' }),
    );

    assert.equal(r.cache, '/my/cache');
  });

  test('the exit code of node is the exit code of the launcher', (t) => {
    const s = launcherSandbox(t);
    const failing = join(s.bin, 'node');
    writeFileSync(failing, '#!/bin/sh\nexit 7\n');
    chmodSync(failing, 0o755);

    const r = launch(launcher, [], s.env());

    assert.equal(r.status, 7);
  });
});

/**
 * A shell function that prints the soft and hard core limit of the shell running it, as
 * `<prefix>-soft=` and `<prefix>-hard=` lines, read from /proc/self/limits (bytes, or `unlimited`)
 * with shell built-ins only. A function, so that its `set --` leaves the caller's arguments alone.
 */
const REPORT_CORE_LIMIT = [
  'report_core_limit() {',
  '  p=$1',
  '  while IFS= read -r line; do',
  '    case $line in',
  '      \'Max core file size\'*) set -- $line; echo "$p-soft=$5"; echo "$p-hard=$6" ;;',
  '    esac',
  '  done </proc/self/limits',
  '}',
].join('\n');

/**
 * A fake node that reports what S2 2 and 5.2 are about: the cache variables, SKYDECK_CORE_SOFT,
 * its core limit, the signals it ignores, its whole environment (`env:` lines) and its arguments.
 * It exits with $FAKE_NODE_STATUS.
 */
function writeReportingNode(path: string, name = 'reporting'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      REPORT_CORE_LIMIT,
      `echo "node=${name}"`,
      'echo "cache=${NODE_COMPILE_CACHE-unset}"',
      'echo "marker=${SKYDECK_LAUNCHER_CACHE-unset}"',
      'echo "core-soft=${SKYDECK_CORE_SOFT-unset}"',
      'echo "ctype=${LC_CTYPE-unset}"',
      'for a in "$@"; do echo "arg=$a"; done',
      'report_core_limit limit',
      'while IFS= read -r line; do',
      '  case $line in SigIgn:*) echo "ignored=${line#SigIgn:}" ;; esac',
      'done </proc/self/status',
      'export -p | while IFS= read -r line; do echo "env:$line"; done',
      'exit "${FAKE_NODE_STATUS:-0}"',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
}

interface Reported {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The value of a `key=value` line of the fake node (or of the wrapper, for `before-*`). */
  field: (key: string) => string | undefined;
  args: string[];
  /** The fake node's exported variables, as `export -p` printed them. */
  env: string[];
}

/**
 * Runs the launcher from a shell that first runs `setup` (typically `ulimit` calls) and reports
 * its own core limit as `before-soft` / `before-hard`, so that a test compares with the limit the
 * launcher really started with, whatever the machine's defaults are.
 */
function launchReported(
  setup: string,
  args: string[],
  env: Record<string, string>,
  command = launcher,
): Reported {
  const script = [REPORT_CORE_LIMIT, setup, 'report_core_limit before', 'exec "$@"'].join('\n');
  const r = spawnSync('/bin/sh', ['-c', script, 'sh', command, ...args], { env, encoding: 'utf8' });
  const lines = r.stdout.split('\n');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    field: (key) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1),
    args: lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice('arg='.length)),
    env: lines.filter((l) => l.startsWith('env:')).map((l) => l.slice('env:'.length)),
  };
}

/** The hard core limit of this test process: a number of bytes, or `unlimited`. */
function ownCoreHardLimit(): string {
  const line = readFileSync('/proc/self/limits', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('Max core file size'));
  assert.ok(line, 'no core limit line in /proc/self/limits');
  const hard = line.split(/\s+/)[5];
  assert.ok(hard, line);
  return hard;
}

const hardIsUnlimited = ownCoreHardLimit() === 'unlimited';
const needsUnlimitedHard = hardIsUnlimited
  ? false
  : 'the hard core limit of this machine is not unlimited';
/** For the cases where the launcher must be able to set the limit (a container may forbid dumps). */
const needsHardAboveZero =
  ownCoreHardLimit() === '0' ? 'the hard core limit of this machine is 0' : false;

/**
 * Shell lines that make the wrapper's stderr a pipe whose reader has already exited, as in
 * `skydeck serve 2>&1 | true`: a write to it fails (SIGPIPE, or EPIPE when that is ignored). The
 * reader is a `true` on a fifo that has exited before the launcher starts, so there is no timing.
 */
function stderrToAPipeNobodyReads(s: Sandbox): string {
  const fifo = join(s.root, 'stderr.fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return [`true <'${fifo}' &`, 'reader=$!', `exec 2>'${fifo}'`, 'wait "$reader"'].join('\n');
}

/** A launcher sandbox with the reporting node on PATH and, when `python` is true, python3. */
function serveSandbox(t: TestContext, python: boolean): Sandbox {
  const s = launcherSandbox(t);
  s.link('date'); // the time of the launcher's log line when there is no python3
  writeReportingNode(join(s.bin, 'node'));
  assert.ok(!python || machinePython3, 'no python3 in /usr/bin or /bin');
  // The launcher runs /usr/bin/python3 and nothing else; inside a test sandbox
  // (SKYDECK_TEST_NO_WINDOWS=1) SKYDECK_TEST_PYTHON3 names it instead (A31). Without python3 it
  // names a path where nothing is.
  const python3 = python ? machinePython3 : join(s.root, 'no-python3');
  return {
    ...s,
    env: (extra) =>
      s.env({ SKYDECK_TEST_NO_WINDOWS: '1', SKYDECK_TEST_PYTHON3: python3, ...extra }),
  };
}

/** The machine's own python3, which the cases that run the launcher's program use. */
const machinePython3 = ['/usr/bin/python3', '/bin/python3'].find((p) => existsSync(p));
const needsUsrBinPython3 = existsSync('/usr/bin/python3')
  ? false
  : 'this machine has no /usr/bin/python3';

/** A fake python3 at `path` that records its arguments in `<path>.called` and exits 99. */
function writeRecordingPython3(path: string): string {
  const called = `${path}.called`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done >> '${called}'\nexit 99\n`);
  chmodSync(path, 0o755);
  return called;
}

/** `<stateDir>/server.log` of the sandbox (SKYDECK_HOME set), with one earlier line in it. */
function serverLogWithOneLine(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'server.log');
  writeFileSync(log, '2026-11-13T00:00:00.000Z an earlier line\n');
  return log;
}

const NO_PYTHON3 =
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ launcher: \/usr\/bin\/python3 cannot be run; core dumps of the server are not prevented$/;

const LIMIT_NOT_SET =
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z launcher: the soft core limit could not be set to 1 byte \(.+\); core dumps of the server are not prevented$/;

describe('bin/skydeck serve: the core limit (S2 2)', () => {
  test(
    'with python3: node sees the soft limit it had in SKYDECK_CORE_SOFT, runs with a soft limit of 1 byte and the same hard limit',
    { skip: needsHardAboveZero },
    (t) => {
      const s = serveSandbox(t, true);

      const r = launchReported('ulimit -S -c 0', ['serve'], s.env());

      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.field('node'), 'reporting');
      assert.equal(r.field('before-soft'), '0');
      assert.equal(r.field('core-soft'), '0');
      assert.equal(r.field('limit-soft'), '1');
      assert.equal(r.field('limit-hard'), r.field('before-hard'));
    },
  );

  test(
    'a soft and a hard limit that are numbers: the soft one in bytes, the hard one kept',
    { skip: needsUnlimitedHard },
    (t) => {
      const s = serveSandbox(t, true);

      const r = launchReported('ulimit -S -c 8 && ulimit -H -c 64', ['serve'], s.env());

      assert.equal(r.status, 0, r.stderr);
      assert.match(r.field('before-soft') ?? '', /^[1-9]\d*$/);
      assert.match(r.field('before-hard') ?? '', /^[1-9]\d*$/);
      assert.equal(r.field('core-soft'), r.field('before-soft'));
      assert.equal(r.field('limit-soft'), '1');
      assert.equal(r.field('limit-hard'), r.field('before-hard'));
    },
  );

  test('an unlimited soft limit is recorded as unlimited', { skip: needsUnlimitedHard }, (t) => {
    const s = serveSandbox(t, true);

    const r = launchReported('ulimit -S -c unlimited', ['serve'], s.env());

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.field('core-soft'), 'unlimited');
    assert.equal(r.field('limit-soft'), '1');
    assert.equal(r.field('limit-hard'), 'unlimited');
  });

  test(
    'a SKYDECK_CORE_SOFT the caller had is replaced by the limit found',
    { skip: needsHardAboveZero },
    (t) => {
      const s = serveSandbox(t, true);

      const r = launchReported('ulimit -S -c 0', ['serve'], s.env({ SKYDECK_CORE_SOFT: '12345' }));

      assert.equal(r.field('core-soft'), '0');
    },
  );

  test('hard limit 0: node still runs, without SKYDECK_CORE_SOFT, and server.log gains one line', (t) => {
    const s = serveSandbox(t, true);
    const log = serverLogWithOneLine(join(s.skydeckHome, 'state'));

    const r = launchReported(
      'ulimit -S -c 0 && ulimit -H -c 0',
      ['serve'],
      s.env({ SKYDECK_CORE_SOFT: '12345' }),
    );

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.field('node'), 'reporting');
    assert.equal(r.field('core-soft'), 'unset');
    assert.equal(r.field('limit-soft'), '0');
    assert.equal(r.field('limit-hard'), '0');
    const lines = readFileSync(log, 'utf8').split('\n');
    assert.equal(lines.length, 3, lines.join('\n')); // the earlier line, the new one, ''
    assert.match(lines[1] ?? '', LIMIT_NOT_SET);
    assert.match(lines[1] ?? '', /hard limit is 0/);
    assert.equal(r.stderr, '');
  });

  test('hard limit 0 and no state directory yet: the line goes to stderr, nothing is created', (t) => {
    const s = serveSandbox(t, true);

    const r = launchReported('ulimit -S -c 0 && ulimit -H -c 0', ['serve'], s.env());

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.field('node'), 'reporting');
    assert.match(r.stderr.trimEnd(), LIMIT_NOT_SET);
    assert.equal(existsSync(join(s.skydeckHome, 'state')), false);
  });

  test('the state directory is found as the launcher finds the data directory (D26)', (t) => {
    const s = serveSandbox(t, true);
    const xdgState = join(s.root, 'xdg-state');
    const cases: ReadonlyArray<readonly [Record<string, string | undefined>, string]> = [
      [{ SKYDECK_HOME: undefined, XDG_STATE_HOME: xdgState }, join(xdgState, 'skydeck')],
      [{ SKYDECK_HOME: '', XDG_STATE_HOME: xdgState }, join(xdgState, 'skydeck')],
      [
        { SKYDECK_HOME: 'rel-home', XDG_STATE_HOME: 'rel-state' },
        join(s.home, '.local/state/skydeck'),
      ],
      [{ SKYDECK_HOME: undefined }, join(s.home, '.local/state/skydeck')],
    ];
    for (const [extra, stateDir] of cases) {
      const log = serverLogWithOneLine(stateDir);

      const r = launchReported('ulimit -S -c 0 && ulimit -H -c 0', ['serve'], s.env(extra));

      assert.equal(r.field('node'), 'reporting', JSON.stringify(extra));
      assert.equal(readFileSync(log, 'utf8').split('\n').length, 3, JSON.stringify(extra));
      assert.equal(r.stderr, '', JSON.stringify(extra));
    }
  });

  test('without python3: node runs directly, with its limits as they were and no SKYDECK_CORE_SOFT', (t) => {
    const s = serveSandbox(t, false);

    const r = launchReported('ulimit -S -c 0', ['serve'], s.env({ SKYDECK_CORE_SOFT: '12345' }));

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.field('node'), 'reporting');
    assert.equal(r.field('core-soft'), 'unset');
    assert.equal(r.field('limit-soft'), r.field('before-soft'));
    assert.equal(r.field('limit-hard'), r.field('before-hard'));
  });

  test('without python3: server.log gains one line saying the dumps are not prevented', (t) => {
    const s = serveSandbox(t, false);
    const log = serverLogWithOneLine(join(s.skydeckHome, 'state'));

    const r = launchReported('', ['serve'], s.env());

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.field('node'), 'reporting');
    const lines = readFileSync(log, 'utf8').split('\n');
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[1] ?? '', NO_PYTHON3);
    assert.equal(r.stderr, '');
  });

  test('without python3 and no state directory: the line goes to stderr, nothing is created', (t) => {
    const s = serveSandbox(t, false);

    const r = launchReported('', ['serve'], s.env());

    assert.equal(r.field('node'), 'reporting');
    assert.match(r.stderr.trimEnd(), NO_PYTHON3);
    assert.equal(existsSync(join(s.skydeckHome, 'state')), false);
  });

  test('without python3, no state directory and stderr a pipe nobody reads: node still runs', (t) => {
    const s = serveSandbox(t, false);

    const r = launchReported(stderrToAPipeNobodyReads(s), ['serve'], s.env());

    assert.equal(r.status, 0);
    assert.equal(r.field('node'), 'reporting');
  });

  test('with python3: every argument reaches node untouched', (t) => {
    const s = serveSandbox(t, true);
    const args = ['serve', '--foreground', 'two words', '', '$HOME', '*', '-c', 'x'];

    const r = launchReported('', args, s.env());

    assert.deepEqual(r.args, [bootstrap, ...args]);
  });

  test('with python3: the node SKYDECK_NODE names is the one that runs', (t) => {
    const s = serveSandbox(t, true);
    const explicit = join(s.root, 'explicit', 'my-node');
    writeReportingNode(explicit, 'explicit');

    const r = launchReported('', ['serve'], s.env({ SKYDECK_NODE: explicit }));

    assert.equal(r.field('node'), 'explicit');
  });

  test('with python3: a node that cannot be executed is one line on stderr and exit 127, as without', (t) => {
    const s = serveSandbox(t, true);
    // Where the limit cannot be set (a hard limit of 0), its line goes to server.log, not stderr.
    serverLogWithOneLine(join(s.skydeckHome, 'state'));
    // Executable, so the launcher's check passes, but its interpreter does not exist.
    const broken = join(s.root, 'broken-node');
    writeFileSync(broken, '#!/no/such/interpreter\n');
    chmodSync(broken, 0o755);

    const r = launchReported('', ['serve'], s.env({ SKYDECK_NODE: broken }));

    assert.equal(r.status, 127);
    assert.match(r.stderr, /^skydeck: cannot run '.*broken-node': .+\n$/);
  });

  test('with python3: hard limit 0, no state directory and stderr closed: node still runs', (t) => {
    const s = serveSandbox(t, true);

    const r = launchReported('ulimit -S -c 0 && ulimit -H -c 0 && exec 2>&-', ['serve'], s.env());

    assert.equal(r.status, 0);
    assert.equal(r.field('node'), 'reporting');
    assert.equal(r.field('core-soft'), 'unset');
  });

  test('with python3: hard limit 0, no state directory and stderr a pipe nobody reads: node still runs', (t) => {
    const s = serveSandbox(t, true);
    const setup = `ulimit -S -c 0 && ulimit -H -c 0\n${stderrToAPipeNobodyReads(s)}`;

    const r = launchReported(setup, ['serve'], s.env());

    assert.equal(r.status, 0);
    assert.equal(r.field('node'), 'reporting');
  });

  test('with python3: a node that cannot be executed, with stderr a pipe nobody reads, still exits 127', (t) => {
    const s = serveSandbox(t, true);
    const broken = join(s.root, 'broken-node');
    writeFileSync(broken, '#!/no/such/interpreter\n');
    chmodSync(broken, 0o755);

    const r = launchReported(
      stderrToAPipeNobodyReads(s),
      ['serve'],
      s.env({ SKYDECK_NODE: broken }),
    );

    assert.equal(r.status, 127);
  });

  test('with python3: a node that cannot be executed, with stderr closed, still exits 127', (t) => {
    const s = serveSandbox(t, true);
    const broken = join(s.root, 'broken-node');
    writeFileSync(broken, '#!/no/such/interpreter\n');
    chmodSync(broken, 0o755);

    const r = launchReported('exec 2>&-', ['serve'], s.env({ SKYDECK_NODE: broken }));

    assert.equal(r.status, 127);
  });

  test("with python3: node's exit code is the launcher's", (t) => {
    const s = serveSandbox(t, true);

    const r = launchReported('', ['serve'], s.env({ FAKE_NODE_STATUS: '7' }));

    assert.equal(r.status, 7);
  });

  test(
    'with python3: node gets the environment any command gets, plus SKYDECK_CORE_SOFT only',
    { skip: needsHardAboveZero },
    (t) => {
      const s = serveSandbox(t, true);
      // No LANG or LC_*: python3 would set LC_CTYPE=C.UTF-8 in its own environment (PEP 538).
      const plain = launchReported('ulimit -S -c 0', ['ls'], s.env());
      const serve = launchReported('ulimit -S -c 0', ['serve'], s.env());
      // The handoff file has a new name on every run.
      const comparable = (env: string[]) => env.filter((l) => !l.includes('SKYDECK_HANDOFF='));

      assert.deepEqual(
        comparable(serve.env).filter((l) => !l.includes('SKYDECK_CORE_SOFT=')),
        comparable(plain.env),
      );
      assert.ok(
        serve.env.some((l) => l.includes('SKYDECK_CORE_SOFT=')),
        serve.env.join('\n'),
      );
    },
  );

  test('with python3: node sees LC_CTYPE as the caller had it, also when it was unset or empty', (t) => {
    const s = serveSandbox(t, true);
    const cases: ReadonlyArray<readonly [given: string | undefined, seen: string]> = [
      [undefined, 'unset'], // python3 itself would set C.UTF-8 here
      ['', ''],
      ['C', 'C'], // python3 itself would change it to C.UTF-8
      ['POSIX', 'POSIX'],
      ['C.UTF-8', 'C.UTF-8'],
    ];
    for (const [given, seen] of cases) {
      const r = launchReported('', ['serve'], s.env({ LC_CTYPE: given }));

      assert.equal(r.field('ctype'), seen, String(given));
    }
  });

  describe('with python3: node ignores exactly the signals it ignores when started without python3', () => {
    // An ignored signal stays ignored across exec, so the caller's choice must reach node as it
    // was, while the two python3 ignores by itself (SIGPIPE, SIGXFSZ) must not.
    const callers: ReadonlyArray<readonly [name: string, setup: string]> = [
      ['the caller ignores nothing', ''],
      ['the caller ignores SIGPIPE', "trap '' PIPE"],
      ['the caller ignores SIGXFSZ', "trap '' XFSZ"],
      ['the caller ignores SIGPIPE, SIGXFSZ and SIGUSR1', "trap '' PIPE XFSZ USR1"],
    ];
    for (const [name, setup] of callers) {
      test(name, (t) => {
        const withPython = serveSandbox(t, true);
        const without = serveSandbox(t, false);

        const viaPython = launchReported(setup, ['serve'], withPython.env());
        const direct = launchReported(setup, ['serve'], without.env());
        const other = launchReported(setup, ['ls'], withPython.env());

        assert.match(direct.field('ignored') ?? '', /^\s*[0-9a-f]{16}$/);
        assert.equal(viaPython.field('ignored'), direct.field('ignored'));
        assert.equal(other.field('ignored'), direct.field('ignored'));
      });
    }
  });

  test('any other command: python3 is never started and the limits are unchanged', (t) => {
    const s = serveSandbox(t, false);
    const calledOnPath = writeRecordingPython3(join(s.bin, 'python3'));
    const stub = join(s.root, 'stub', 'python3');
    const called = writeRecordingPython3(stub);

    for (const args of [[], ['ls'], ['ls', 'serve'], ['--help'], ['Serve'], ['window']]) {
      const r = launchReported('ulimit -S -c 0', args, s.env({ SKYDECK_TEST_PYTHON3: stub }));

      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.field('node'), 'reporting', args.join(' '));
      assert.equal(r.field('limit-soft'), r.field('before-soft'), args.join(' '));
      assert.equal(r.field('limit-hard'), r.field('before-hard'), args.join(' '));
    }
    assert.equal(existsSync(called), false);
    assert.equal(existsSync(calledOnPath), false);
  });
});

describe('bin/skydeck serve: which python3 runs (S2 2)', () => {
  /** Hard limit 0 makes the program write its line to server.log: the proof that it ran. */
  function ranThePythonProgram(s: Sandbox, extra: Record<string, string | undefined>): Reported {
    const log = serverLogWithOneLine(join(s.skydeckHome, 'state'));
    const r = launchReported('ulimit -S -c 0 && ulimit -H -c 0', ['serve'], s.env(extra));
    assert.equal(r.field('node'), 'reporting', r.stderr);
    assert.match(readFileSync(log, 'utf8').split('\n')[1] ?? '', LIMIT_NOT_SET);
    return r;
  }

  test('/usr/bin/python3, never a python3 on PATH', { skip: needsUsrBinPython3 }, (t) => {
    const s = serveSandbox(t, false);
    const calledOnPath = writeRecordingPython3(join(s.bin, 'python3'));

    ranThePythonProgram(s, { SKYDECK_TEST_PYTHON3: undefined });

    assert.equal(existsSync(calledOnPath), false);
  });

  test(
    'SKYDECK_TEST_PYTHON3 without SKYDECK_TEST_NO_WINDOWS=1 is ignored',
    { skip: needsUsrBinPython3 },
    (t) => {
      const s = serveSandbox(t, false);
      const stub = join(s.root, 'stub', 'python3');
      const called = writeRecordingPython3(stub);

      for (const mark of [undefined, '', '0', 'yes', '1 ']) {
        ranThePythonProgram(s, { SKYDECK_TEST_NO_WINDOWS: mark, SKYDECK_TEST_PYTHON3: stub });
      }

      assert.equal(existsSync(called), false);
    },
  );

  test('inside a test sandbox SKYDECK_TEST_PYTHON3 is the python3 that runs, as `-I -S -c <program>`', (t) => {
    const s = serveSandbox(t, false);
    const stub = join(s.root, 'stub', 'python3');
    const called = writeRecordingPython3(stub);

    const r = launchReported('', ['serve'], s.env({ SKYDECK_TEST_PYTHON3: stub }));

    assert.equal(r.status, 99);
    assert.deepEqual(readFileSync(called, 'utf8').split('\n').slice(0, 3), ['-I', '-S', '-c']);
  });

  test('a python3 that is missing, a directory, not executable or not an absolute path counts as none', (t) => {
    const s = serveSandbox(t, false);
    const notExecutable = join(s.root, 'not-executable-python3');
    writeFileSync(notExecutable, '#!/bin/sh\nexit 99\n');
    chmodSync(notExecutable, 0o644);
    const relativeStub = join(s.root, 'stub', 'python3');
    const called = writeRecordingPython3(relativeStub);

    for (const python3 of [join(s.root, 'missing'), s.root, notExecutable, 'stub/python3', '']) {
      const r = launchReported(
        'ulimit -S -c 0',
        ['serve'],
        s.env({ SKYDECK_TEST_PYTHON3: python3, SKYDECK_CORE_SOFT: '12345' }),
      );

      assert.equal(r.status, 0, `${python3}: ${r.stderr}`);
      assert.equal(r.field('node'), 'reporting', python3);
      assert.equal(r.field('core-soft'), 'unset', python3);
      assert.equal(r.field('limit-soft'), r.field('before-soft'), python3);
    }
    assert.equal(existsSync(called), false);
  });
});

describe('bin/skydeck: the cache marker SKYDECK_LAUNCHER_CACHE (S2 5.2)', () => {
  // The marker says "this NODE_COMPILE_CACHE is the launcher's own": the window's server drops a
  // NODE_COMPILE_CACHE equal to it, so it is set only when the launcher chose the cache itself.
  const commands: ReadonlyArray<readonly [name: string, args: string[], python: boolean]> = [
    ['no command', [], false],
    ['ls', ['ls'], false],
    ['serve with python3', ['serve'], true],
    ['serve without python3', ['serve'], false],
  ];
  for (const [name, args, python] of commands) {
    test(`${name}: the cache the launcher chose has the marker beside it, with the same value`, (t) => {
      const s = serveSandbox(t, python);

      const r = launchReported('', args, s.env({ XDG_CACHE_HOME: '/xdg/cache' }));

      assert.equal(r.field('cache'), '/xdg/cache/skydeck/compile-cache');
      assert.equal(r.field('marker'), '/xdg/cache/skydeck/compile-cache');
    });

    test(`${name}: an empty NODE_COMPILE_CACHE counts as unset, so the marker is set`, (t) => {
      const s = serveSandbox(t, python);

      const r = launchReported('', args, s.env({ NODE_COMPILE_CACHE: '' }));

      assert.equal(r.field('cache'), join(s.home, '.cache/skydeck/compile-cache'));
      assert.equal(r.field('marker'), join(s.home, '.cache/skydeck/compile-cache'));
    });

    test(`${name}: a NODE_COMPILE_CACHE the caller set is passed unchanged, with no marker`, (t) => {
      const s = serveSandbox(t, python);

      const r = launchReported('', args, s.env({ NODE_COMPILE_CACHE: '/my/cache' }));

      assert.equal(r.field('cache'), '/my/cache');
      assert.equal(r.field('marker'), 'unset');
    });

    test(`${name}: with a NODE_COMPILE_CACHE the caller set, the caller's marker is left as found`, (t) => {
      const s = serveSandbox(t, python);

      const r = launchReported(
        '',
        args,
        s.env({ NODE_COMPILE_CACHE: '/my/cache', SKYDECK_LAUNCHER_CACHE: '/their/marker' }),
      );

      assert.equal(r.field('cache'), '/my/cache');
      assert.equal(r.field('marker'), '/their/marker');
    });
  }

  test('a SKYDECK_LAUNCHER_CACHE the caller had is replaced when the launcher chooses the cache', (t) => {
    const s = serveSandbox(t, false);

    const r = launchReported('', ['ls'], s.env({ SKYDECK_LAUNCHER_CACHE: '/stale' }));

    assert.equal(r.field('marker'), join(s.home, '.cache/skydeck/compile-cache'));
  });

  describe('through two launchers, as skydeck window starts bin/skydeck serve with its own environment', () => {
    /** A fake node for the first launcher that starts the launcher again, as `serve`. */
    function chain(t: TestContext, extra: Record<string, string>): Reported {
      const s = serveSandbox(t, true);
      const relay = join(s.root, 'relay-node');
      writeFileSync(
        relay,
        `#!/bin/sh\nSKYDECK_NODE='${join(s.bin, 'node')}' exec '${launcher}' serve\n`,
      );
      chmodSync(relay, 0o755);

      return launchReported('', ['window'], s.env({ SKYDECK_NODE: relay, ...extra }));
    }

    test("the first launcher's cache and marker reach the server unchanged", (t) => {
      const r = chain(t, { XDG_CACHE_HOME: '/xdg/cache' });

      assert.equal(r.field('node'), 'reporting');
      assert.equal(r.field('cache'), '/xdg/cache/skydeck/compile-cache');
      assert.equal(r.field('marker'), '/xdg/cache/skydeck/compile-cache');
    });

    test('a cache the user set reaches the server with no marker, so the server keeps it', (t) => {
      const r = chain(t, { NODE_COMPILE_CACHE: '/my/cache' });

      assert.equal(r.field('node'), 'reporting');
      assert.equal(r.field('cache'), '/my/cache');
      assert.equal(r.field('marker'), 'unset');
    });
  });
});

describe('bin/skydeck with the real node', () => {
  function run(t: TestContext, args: string[]) {
    const s = launcherSandbox(t);
    return spawnSync(launcher, args, {
      encoding: 'utf8',
      env: s.env({ SKYDECK_NODE: process.execPath }),
    });
  }

  test('--version prints the version line and nothing on stderr', (t) => {
    const r = run(t, ['--version']);

    assert.equal(r.status, 0);
    // No git on the sandbox's PATH: this checkout's own history is never asked (the commit is
    // test/cli/version.test.ts's, on throwaway checkouts).
    assert.equal(r.stdout, `${pkg.version} (commit unknown)\n`);
    assert.equal(r.stderr, '');
  });

  test('an unknown command prints the usage on stderr and exits 2', (t) => {
    const r = run(t, ['frobnicate']);

    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage:/m);
  });
});

describe('bin/skydeck when its standard output or error is closed before it writes', () => {
  /**
   * Runs `skydeck <args>` with standard output (`which` 'stdout') or standard error ('stderr') a
   * pipe nobody reads any more, as in `skydeck ls | true` or `skydeck show x 2>&1 | true`. The reader is a `true` on a fifo that has exited before the launcher starts, so there is
   * no timing in it: a write cannot succeed. Returns what the launcher printed on stderr, the status
   * it exited with (as the shell saw it) and the files it left in the data directory.
   */
  function withClosedPipe(
    t: TestContext,
    args: string[],
    which: 'stdout' | 'stderr' = 'stdout',
    input = '',
  ): { stderr: string; status: string; left: string[] } {
    const s = launcherSandbox(t);
    const fifo = join(s.root, 'out.fifo');
    const statusFile = join(s.root, 'status');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const script = [
      'fifo=$1 statusfile=$2; shift 2',
      'true <"$fifo" &', // the reader: opens the fifo, exits
      'reader=$!',
      'exec 3>"$fifo"', // waits for the reader to open it
      'wait "$reader"', // gone; this end stays open, so a write fails with EPIPE
      which === 'stdout' ? '"$@" >&3' : '"$@" 2>&3',
      'echo $? >"$statusfile"',
    ].join('\n');
    const r = spawnSync('/bin/sh', ['-c', script, 'sh', fifo, statusFile, launcher, ...args], {
      encoding: 'utf8',
      input,
      env: s.env({ SKYDECK_NODE: process.execPath }),
    });
    assert.equal(r.status, 0, r.stderr);
    const data = join(s.skydeckHome, 'data');
    return {
      // Node 24.12 warns once that node:sqlite is experimental, on every run; that is not ours.
      stderr: r.stderr
        .split('\n')
        .filter((line) => line !== '' && !/ExperimentalWarning|--trace-warnings/.test(line))
        .join('\n'),
      status: readFileSync(statusFile, 'utf8').trim(),
      left: existsSync(data) ? readdirSync(data) : [],
    };
  }

  test('ls: no stack trace and nothing on stderr; exit 141 as a process killed by SIGPIPE shows; the database is closed', (t) => {
    const r = withClosedPipe(t, ['ls']);

    assert.equal(r.stderr, '');
    assert.equal(r.status, '141');
    // An open database leaves its -wal and -shm files behind.
    assert.deepEqual(
      r.left.filter((name) => name.startsWith('skydeck.db')),
      ['skydeck.db'],
    );
  });

  test('doctor: the same, and its own failing status is kept', (t) => {
    const r = withClosedPipe(t, ['doctor']);

    assert.equal(r.stderr, '');
    assert.equal(r.status, '1'); // nothing is installed in the sandbox: doctor reports problems
  });

  test('standard error closed: the exit code of the command is the one it would have had', (t) => {
    const r = withClosedPipe(t, ['show', 'nosuch'], 'stderr');

    assert.equal(r.stderr, '');
    assert.equal(r.status, '3'); // a reference that matches nothing; not 1 from a crash, not 141
  });

  test('standard error closed: a command that succeeds still exits 0', (t) => {
    // `install` asks its question on stderr (the header, the entries, the prompt), then goes ahead.
    const r = withClosedPipe(t, ['install'], 'stderr', 'y\n');

    assert.equal(r.stderr, '');
    assert.equal(r.status, '0'); // not 141: only a closed stdout changes the status of a success
  });
});
