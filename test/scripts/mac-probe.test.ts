// Runs scripts/mac-probe.sh in the suite's sandbox, with a made-up home, made-up live-session files
// and stand-in programs that answer as a Mac would (the probe is meant for a Mac, and nothing of it
// may run against this machine's own home). Its output is meant for a public pull request, so a case
// fails when it prints any of the made-up personal values, when anything in the sandbox changes
// (the probe writes no file), when it runs a stand-in of Apple's stubs or `claude` with anything but
// --version, and when it exits other than 0 or prints on stderr.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';

const probe = fileURLToPath(new URL('../../scripts/mac-probe.sh', import.meta.url));

// The made-up personal values. None of them, nor a piece of one, may appear in the output.
const USER = 'jqdoe-private';
const SESSION = '5f0c2b1e-8d4a-4c3b-9a7e-1f2d3c4b5a69';
const OTHER_SESSION = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const BOOT = 'A1B2C3D4-E5F6-4789-ABCD-0123456789EF';
const OWN_PID = 97531;
const OTHER_PID = 86420;
const OWN_START = 'Thu Nov  5 09:12:33 2026';
const SECRETS = [
  USER,
  'jqdoe',
  'Jane',
  'Přemysl',
  'emysl',
  'acme',
  'payroll',
  'merger',
  'terse',
  'secret',
  'TOPSECRET',
  'tok-',
  SESSION,
  SESSION.slice(0, 8),
  OTHER_SESSION.slice(0, 8),
  BOOT,
  BOOT.toLowerCase(),
  BOOT.slice(0, 8),
  '0123456789',
  'Nov  5',
  '09:12:33',
  '08:01:02',
  '09:01:02',
  '123456',
  '10:00:01',
  '1763632801',
  '1762333953',
  '7654321',
  String(OTHER_PID),
  String(OWN_PID),
];

/** Writes an executable stand-in that runs `body` under /bin/sh. */
function standIn(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

interface Mac {
  s: Sandbox;
  home: string;
  /** Where the stand-ins of Apple's stubs write when they are run, and `claude` when it is run with more than --version. */
  marks: string;
  path: string;
  env: (extra?: Record<string, string | undefined>) => Record<string, string>;
}

/**
 * A made-up Mac in the sandbox. `parentOf` is the parent the stand-in `ps` gives every process but
 * the made-up Claude Code ones: OWN_PID makes the probe run "under" that Claude Code, 1 under none.
 */
function mac(
  t: TestContext,
  options: { parentOf: number; developerTools: boolean; claudeVersion?: string },
): Mac {
  const s = sandbox(t);
  s.link('sh', 'sed', 'awk', 'head', 'sort', 'tr', 'basename', 'env', 'perl', 'sleep');
  const home = join(s.root, 'Users', USER);
  const marks = join(s.root, 'marks');
  mkdirSync(marks);
  const stubs = join(s.root, 'usr-bin');
  const developer = join(s.root, 'Library', 'Developer', 'CommandLineTools');
  const nvm = join(home, '.nvm', 'versions', 'node', 'v24.12.0', 'bin');
  const localBin = join(home, '.local', 'bin');
  const tools = join(s.root, 'opt', '7654321', `${USER} tools`, 'bin');
  const accented = join(s.root, 'opt', 'Přemysl', 'bin');
  mkdirSync(join(home, 'skydeck'), { recursive: true });
  mkdirSync(join(home, 'Applications', 'Google Chrome.app'), { recursive: true });
  mkdirSync(join(s.root, 'var', 'folders', 'jq', `${USER}-T`), { recursive: true });

  standIn(
    s.bin,
    'uname',
    'case $1 in -s) echo Darwin ;; -r) echo 24.1.0 ;; -m) echo arm64 ;; esac',
  );
  standIn(s.bin, 'sw_vers', `echo "15.1 (built for ${USER})"`);
  standIn(
    s.bin,
    'xcode-select',
    options.developerTools
      ? `echo '${developer}'`
      : 'echo "error: no developer tools for Jane" >&2; exit 2',
  );
  standIn(
    s.bin,
    'sysctl',
    [
      'case $2 in',
      `  kern.bootsessionuuid) echo ${BOOT} ;;`,
      '  kern.boottime) echo "{ sec = 1762333953, usec = 5 } Thu Nov  5 09:12:33 2026" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  standIn(
    s.bin,
    'ps',
    [
      'what= pid= all=',
      'while [ $# -gt 0 ]; do',
      '  case $1 in -o) what=$2; shift ;; -p) pid=$2; shift ;; -A) all=1 ;; esac',
      '  shift',
      'done',
      `if [ -n "$all" ]; then echo "    1     0 ${OWN_START}"; echo " ${OWN_PID}     1 ${OWN_START}"; exit 0; fi`,
      'case $pid in',
      `  ${OWN_PID}) ppid=1 start='${OWN_START}' tty=ttys003 comm=${localBin}/claude`,
      `    command="claude --append-system-prompt be terse for ACME --model opus the secret merger plan" ;;`,
      // In UTC (TZ=UTC, as skydeck asks) and in the made-up Mac's own time, an hour later.
      `  ${OTHER_PID}) ppid=1 start='Wed Nov  4 08:01:02 2026' tty=ttys009 comm=node`,
      `    if [ "\${TZ-}" != UTC ]; then start='Wed Nov  4 09:01:02 2026'; fi`,
      // In the made-up Mac's own language (no LC_ALL=C), the day's name is German.
      `    if [ "\${LC_ALL-}" != C ]; then start='Mi Nov  4 09:01:02 2026'; fi`,
      `    command="node ${localBin}/claude --resume ${OTHER_SESSION}" ;;`,
      `  *) ppid=${options.parentOf} start='Fri Nov 20 10:00:01 2026' tty=ttys004 comm=sh`,
      `    command="sh /Users/${USER}/skydeck/scripts/mac-probe.sh" ;;`,
      'esac',
      'case $what in',
      '  ppid=) echo "    $ppid" ;;',
      '  lstart=) echo "$start" ;;',
      '  ppid=,lstart=) echo "    $ppid $start" ;;',
      '  tty=) echo "$tty" ;;',
      '  comm=) echo "$comm" ;;',
      '  command=) echo "$command" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  standIn(
    s.bin,
    'date',
    'case $1 in +%s%N) echo 1763632801N ;; -u) echo 2026-11-20T10:00:01Z ;; *) exit 1 ;; esac',
  );
  standIn(
    s.bin,
    'vm_stat',
    // A line with an unexpected character (here a quote) is masked whole.
    `echo "Mach Virtual Memory Statistics: (page size of 16384 bytes)"; echo "Pages free:      123456."; echo "Pages active:    7890."; echo "Pages of ${USER}'s cache:  4242."`,
  );
  // The probe only looks for these two; run, they leave a mark the test looks for.
  for (const name of ['lsof', 'open']) {
    standIn(s.bin, name, `echo ran > '${join(marks, name)}'; exit 0`);
  }
  standIn(nvm, 'node', 'case $1 in --version) echo v24.12.0 ;; -e) echo yes ;; esac');
  standIn(
    s.bin,
    'python3-real',
    [
      'case $1 in',
      '  --version) echo "Python 3.9.6" ;;',
      '  -I) printf "SO_PEERCRED no\\nLOCAL_PEERCRED yes\\ngetpeereid in libc yes\\nprctl in libc no\\nsysctlbyname in libc yes\\nRLIMIT_CORE yes\\n" ;;',
      'esac',
    ].join('\n'),
  );
  standIn(join(developer, 'usr', 'bin'), 'python3', `exec '${join(s.bin, 'python3-real')}' "$@"`);
  standIn(
    join(developer, 'usr', 'bin'),
    'git',
    `echo "git version 2.39.5 (Apple Git-154, ${USER})"`,
  );
  // Apple's stubs: they would open a window. Run, they leave a mark the test looks for.
  for (const name of ['python3', 'git']) {
    standIn(stubs, name, `echo ran > '${join(marks, name)}'; echo "Jane"; exit 1`);
  }
  standIn(
    accented,
    'zsh',
    'case $1 in --version) echo "zsh 5.9 (arm64-apple-darwin24.0)" ;; -fc) echo 1763632801.123456 ;; esac',
  );
  standIn(
    tools,
    'gh',
    'echo "gh version 2.62.0 (2024-11-14)"; echo "https://github.com/cli/cli/releases/tag/v2.62.0"',
  );
  standIn(
    localBin,
    'claude',
    [
      'if [ "$*" = --version ]; then',
      `  ${options.claudeVersion ?? 'echo "2.1.329 (Claude Code)"'}`,
      'else',
      `  echo "$*" > '${join(marks, 'claude')}'; exit 1`,
      'fi',
    ].join('\n'),
  );

  const path = [stubs, s.bin, nvm, localBin, tools, accented].join(':');
  return {
    s,
    home,
    marks,
    path,
    env: (extra = {}) =>
      s.env({
        HOME: home,
        PATH: path,
        CLAUDE_CONFIG_DIR: undefined,
        TMPDIR: join(s.root, 'var', 'folders', 'jq', `${USER}-T`),
        SHELL: '/bin/zsh',
        TERM_PROGRAM: 'Apple_Terminal',
        CLAUDECODE: '1',
        CLAUDE_PID: String(OWN_PID),
        CLAUDE_CODE_SESSION_ID: SESSION,
        CLAUDE_CODE_OAUTH_TOKEN: `tok-${USER}-7781`,
        // A variable's name can tell about the setup too: only known names are named.
        CLAUDE_ACME_PAYROLL_URL: 'https://example.com',
        SKYDECK_TEST_STUB_DIR: stubs,
        ...extra,
      }),
  };
}

/** Writes made-up live-session files into `<claude folder>/sessions`, the own one newest. */
function liveFiles(claudeFolder: string): void {
  const sessions = join(claudeFolder, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const own = join(sessions, `${OWN_PID}.json`);
  const other = join(sessions, `${OTHER_PID}.json`);
  writeFileSync(
    own,
    JSON.stringify({
      pid: OWN_PID,
      sessionId: SESSION,
      cwd: `/Users/${USER}/acme-payroll`,
      startedAt: 1762333953000,
      procStart: OWN_START,
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'Payroll fix for ACME',
      nameSource: 'user',
      status: 'busy',
      updatedAt: 1763632801000,
      waitingFor: 'approve the secret merger plan',
    }),
  );
  writeFileSync(
    other,
    JSON.stringify({
      pid: OTHER_PID,
      sessionId: OTHER_SESSION,
      cwd: `/Users/${USER}/Přemysl merger`,
      procStart: 'Wed Nov  4 09:01:02 2026',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'Merger memo, Jane',
      // Words that are no status and no name source of Claude Code's: shown as (other).
      status: 'payroll',
      nameSource: 'jane',
    }),
  );
  // The folder holds other files too; the probe never reads one that is not <pid>.json.
  writeFileSync(join(sessions, 'credentials.json'), '{"token":"sk-TOPSECRET-jqdoe"}');
  writeFileSync(join(sessions, `${OTHER_PID}.json.tmp`), '{"name":"payroll"}');
  utimesSync(other, new Date('2026-11-19T10:00:00Z'), new Date('2026-11-19T10:00:00Z'));
  utimesSync(own, new Date('2026-11-20T10:00:00Z'), new Date('2026-11-20T10:00:00Z'));
}

/** Every path under `root` with its kind, size and modification time. */
function tree(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = lstatSync(path);
      found.set(
        path,
        `${stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : 'f'} ${stats.size} ${stats.mtimeMs}`,
      );
      if (stats.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
  return found;
}

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runProbe(m: Mac, shell: string[], env: Record<string, string>): Ran {
  const before = tree(m.s.root);
  const started = Date.now();
  const result = spawnSync(shell[0] as string, [...shell.slice(1), probe], {
    env,
    cwd: join(m.home, 'skydeck'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  const ms = Date.now() - started;
  assert.equal(result.error, undefined);
  assert.deepEqual(
    readdirSync(m.marks),
    [],
    'a stand-in of a stub, open, lsof, or claude beyond --version, was run',
  );
  assert.deepEqual(tree(m.s.root), before, 'the probe changed something in the sandbox');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms };
}

function assertNothingPersonal(stdout: string): void {
  for (const secret of SECRETS) {
    assert.equal(
      stdout.toLowerCase().includes(secret.toLowerCase()),
      false,
      `the output shows "${secret}":\n${stdout}`,
    );
  }
}

function line(stdout: string, label: string): string {
  const found = stdout.split('\n').find((l) => l.startsWith(`${label}: `));
  assert.ok(found !== undefined, `no line "${label}: …" in:\n${stdout}`);
  return found.slice(label.length + 2);
}

const shells: [string, string[]][] = [['sh', ['/bin/sh']]];
if (existsSync('/bin/bash')) {
  shells.push(['bash in POSIX mode', ['/bin/bash', '--posix']]);
}

describe('scripts/mac-probe.sh', () => {
  for (const [name, shell] of shells) {
    test(`under ${name}, inside a Claude Code: reads only its own live-session file, shows forms and yes or no, nothing personal, writes nothing`, (t) => {
      const m = mac(t, { parentOf: OWN_PID, developerTools: true });
      liveFiles(join(m.home, '.claude'));
      const ran = runProbe(m, shell, m.env());

      assert.equal(ran.stderr, '');
      assert.equal(ran.status, 0, ran.stdout);
      assertNothingPersonal(ran.stdout);
      assert.equal(line(ran.stdout, 'this is a Mac'), 'yes');
      assert.equal(line(ran.stdout, 'kernel'), 'Darwin 24.1.0');
      assert.equal(line(ran.stdout, 'machine'), 'arm64');
      assert.equal(line(ran.stdout, 'macOS'), '15.1');
      assert.match(
        line(ran.stdout, 'developer tools'),
        /^found \(\/.*\/Library\/Developer\/CommandLineTools\)$/,
      );
      assert.equal(line(ran.stdout, 'login shell'), 'zsh');
      assert.equal(line(ran.stdout, 'terminal program'), 'Apple_Terminal');
      assert.match(line(ran.stdout, 'TMPDIR'), /^set, \d+ bytes, \d+ bytes without links$/);
      assert.match(
        line(ran.stdout, "a terminal socket's path under this home"),
        /^\d+ bytes \(a Mac allows 103\)$/,
      );
      assert.equal(line(ran.stdout, 'node'), '24.12.0  (~/.nvm/versions/node/v24.12.0/bin/node)');
      assert.equal(line(ran.stdout, 'node:sqlite'), 'yes');
      assert.match(line(ran.stdout, 'python3'), /^3\.9\.6 {2}\(\/.*\/aaa-aaa\/python3\)$/);
      assert.equal(line(ran.stdout, 'python3: SO_PEERCRED'), 'no');
      assert.equal(line(ran.stdout, 'python3: getpeereid in libc'), 'yes');
      assert.match(line(ran.stdout, 'git'), /^2\.39\.5 {2}\(/);
      assert.match(line(ran.stdout, 'zsh'), /^5\.9 {2}\(\/.*\/opt\/A\?+a+\/bin\/zsh\)$/);
      assert.match(line(ran.stdout, 'gh'), /^2\.62\.0 {2}\(\/.*\/opt\/9+\/[a -]+\/bin\/gh\)$/);
      assert.equal(line(ran.stdout, 'date +%s%N'), '[9999999999A]');
      assert.equal(
        line(ran.stdout, 'kern.bootsessionuuid'),
        '[A9A9A9A9-A9A9-9999-AAAA-9999999999AA]',
      );
      assert.equal(line(ran.stdout, 'ps lstart'), '[Aaa Aaa 99 99:99:99 9999]');
      assert.equal(line(ran.stdout, 'ps lstart the same in two calls'), 'yes');
      assert.equal(line(ran.stdout, 'claude'), '2.1.329  (~/.local/bin/claude)');
      assert.equal(line(ran.stdout, 'CLAUDECODE here'), 'yes');
      assert.equal(line(ran.stdout, 'CLAUDE_PID here'), 'yes');
      assert.equal(line(ran.stdout, 'CLAUDE_CODE_SESSION_ID here'), 'yes');
      assert.equal(line(ran.stdout, 'CLAUDE_CODE_ENTRYPOINT here'), 'no');
      assert.equal(line(ran.stdout, 'other CLAUDE* variables here'), '2');
      assert.equal(line(ran.stdout, 'its sessions folder'), 'there, 2 live-session files');
      assert.equal(
        line(ran.stdout, 'read'),
        'the live-session file of the Claude Code this script runs under',
      );
      assert.equal(ran.stdout.match(/^file \d+, /gm)?.length, 1, 'more than its own file was read');
      assert.match(ran.stdout, /^ {2}procStart \(text\): \[Aaa Aaa {2}9 99:99:99 9999\]$/m);
      assert.match(ran.stdout, /^ {2}startedAt \(not text\): \[9999999999999\]$/m);
      assert.match(ran.stdout, /^ {2}status \(text\): \[busy\]$/m);
      assert.match(ran.stdout, /^ {2}procStart equals ps lstart: YES$/m);
      assert.match(ran.stdout, /^ {2}procStart equals ps lstart in local time: YES$/m);
      assert.match(
        ran.stdout,
        /^ {2}procStart equals ps lstart in the language and zone of this Mac: YES$/m,
      );
      assert.match(
        ran.stdout,
        /^vm_stat: Mach Virtual Memory Statistics: \(page size of 99999 bytes\)$/m,
      );
      assert.match(ran.stdout, /^vm_stat: Pages free: +999999\.$/m);
      assert.match(ran.stdout, /^vm_stat: aaaaa aa aaaaa-aaaaaaa'a aaaaa: +9999\.$/m);
      assert.match(ran.stdout, /^ {2}CLAUDE_PID is its process number: YES$/m);
      assert.match(
        ran.stdout,
        /^ {2}its command name \[claude\], first word of its arguments \[claude\], the same: YES$/m,
      );
      assert.match(
        ran.stdout,
        /^ {2}its arguments as ps shows them: 12 words; options: \[--append-system-prompt --model\]; other words: 9$/m,
      );
      // On a real Mac with Chrome in /Applications the probe finds that one first.
      assert.match(line(ran.stdout, 'Google Chrome'), /^in (\/Applications|~\/Applications)$/);
      assert.match(ran.stdout, /=== end\. Nothing was changed\./);
    });
  }

  test('in a plain terminal, with a Claude folder of its own and no developer tools: the newest live-session files, never a stub', (t) => {
    const m = mac(t, { parentOf: 1, developerTools: false });
    const folder = join(m.s.root, 'Users', USER, `Jane's Claude Přemysl`);
    liveFiles(folder);
    const ran = runProbe(
      m,
      ['/bin/sh'],
      m.env({ CLAUDE_CONFIG_DIR: folder, CLAUDECODE: undefined, CLAUDE_PID: undefined }),
    );

    assert.equal(ran.stderr, '');
    assert.equal(ran.status, 0, ran.stdout);
    assertNothingPersonal(ran.stdout);
    assert.equal(line(ran.stdout, 'developer tools'), 'not found');
    assert.equal(
      line(ran.stdout, 'python3'),
      "only Apple's stub (no developer tools found); not run",
    );
    assert.equal(line(ran.stdout, 'git'), "only Apple's stub (no developer tools found); not run");
    assert.equal(ran.stdout.includes('python3: SO_PEERCRED'), false);
    assert.equal(line(ran.stdout, 'CLAUDE_CONFIG_DIR'), 'set');
    assert.equal(
      line(ran.stdout, 'read'),
      "no Claude Code among this script's parents: the newest three live-session files",
    );
    assert.equal(ran.stdout.match(/^file \d+, /gm)?.length, 2);
    // The other session's file holds its start in local time: told apart from UTC.
    assert.match(
      ran.stdout,
      /^ {2}procStart equals ps lstart: NO\n {2}procStart equals ps lstart in local time: YES\n {2}procStart equals ps lstart in the language and zone of this Mac: NO$/m,
    );
    assert.match(ran.stdout, /^ {2}status \(text\): \[\(other\)\]$/m);
    assert.match(ran.stdout, /^ {2}nameSource \(text\): \[\(other\)\]$/m);
  });

  test('a program that does not answer is ended after five seconds', (t) => {
    const m = mac(t, { parentOf: OWN_PID, developerTools: true, claudeVersion: 'exec sleep 30' });
    liveFiles(join(m.home, '.claude'));
    const ran = runProbe(m, ['/bin/sh'], m.env());

    assert.equal(ran.stderr, '');
    assert.equal(ran.status, 0, ran.stdout);
    assertNothingPersonal(ran.stdout);
    assert.equal(
      line(ran.stdout, 'claude'),
      'no version number in its answer  (~/.local/bin/claude)',
    );
    assert.ok(ran.ms < 20_000, `the probe took ${ran.ms} ms`);
  });
});
