import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLAUDE_CHILD_VARIABLES } from '../../src/claude/terminal.ts';
import { programEnvironment, serverEnvironment } from '../../src/window/env.ts';

const CWD = '/home/me/projects/app';
const LINK = '/run/user/1000/skydeck-0a1b2c3d/interop';

// ---------------------------------------------------------------------------------------------
// serverEnvironment (S2 5.2, A29)

test('serverEnvironment keeps the variables of the command that started the server', () => {
  const result = serverEnvironment({ HOME: '/home/me', PATH: '/usr/bin', AWS_PROFILE: 'dev' });
  assert.deepEqual(result.env, { HOME: '/home/me', PATH: '/usr/bin', AWS_PROFILE: 'dev' });
});

test('serverEnvironment drops entries whose value is undefined', () => {
  assert.deepEqual(serverEnvironment({ HOME: '/home/me', GONE: undefined }).env, {
    HOME: '/home/me',
  });
});

test('serverEnvironment keeps a variable whatever its name, __proto__ included', () => {
  const input: Record<string, string> = Object.fromEntries([
    ['__proto__', 'x'],
    ['A', 'b'],
  ]);
  const { env } = serverEnvironment(input);
  assert.deepEqual(Object.entries(env), [
    ['__proto__', 'x'],
    ['A', 'b'],
  ]);
  assert.deepEqual(Object.entries(programEnvironment(env, { cwd: CWD, interop: null })), [
    ['__proto__', 'x'],
    ['A', 'b'],
    ['TERM', 'xterm-256color'],
    ['COLORTERM', 'truecolor'],
    ['PWD', CWD],
  ]);
});

test('serverEnvironment removes SKYDECK_HANDOFF', () => {
  const result = serverEnvironment({ HOME: '/h', SKYDECK_HANDOFF: '/tmp/skydeck-handoff.x' });
  assert.deepEqual(result.env, { HOME: '/h' });
});

test("serverEnvironment removes the launcher's NODE_COMPILE_CACHE (equal to the marker) and the marker", () => {
  const cache = '/home/me/.cache/skydeck/compile-cache';
  const result = serverEnvironment({
    HOME: '/h',
    NODE_COMPILE_CACHE: cache,
    SKYDECK_LAUNCHER_CACHE: cache,
  });
  assert.deepEqual(result.env, { HOME: '/h' });
});

test('serverEnvironment keeps a NODE_COMPILE_CACHE that differs from the marker, and removes the marker', () => {
  const result = serverEnvironment({
    HOME: '/h',
    NODE_COMPILE_CACHE: '/home/me/my-cache',
    SKYDECK_LAUNCHER_CACHE: '/home/me/.cache/skydeck/compile-cache',
  });
  assert.deepEqual(result.env, { HOME: '/h', NODE_COMPILE_CACHE: '/home/me/my-cache' });
});

test('serverEnvironment keeps a NODE_COMPILE_CACHE when there is no marker', () => {
  const result = serverEnvironment({ HOME: '/h', NODE_COMPILE_CACHE: '/home/me/my-cache' });
  assert.deepEqual(result.env, { HOME: '/h', NODE_COMPILE_CACHE: '/home/me/my-cache' });
});

test('serverEnvironment removes a marker that has no NODE_COMPILE_CACHE beside it', () => {
  const result = serverEnvironment({ HOME: '/h', SKYDECK_LAUNCHER_CACHE: '/c' });
  assert.deepEqual(result.env, { HOME: '/h' });
});

test('serverEnvironment takes SKYDECK_CORE_SOFT out and returns it: unlimited', () => {
  const result = serverEnvironment({ HOME: '/h', SKYDECK_CORE_SOFT: 'unlimited' });
  assert.equal(result.coreSoft, 'unlimited');
  assert.deepEqual(result.env, { HOME: '/h' });
});

test('serverEnvironment takes SKYDECK_CORE_SOFT out and returns it: 0', () => {
  const result = serverEnvironment({ HOME: '/h', SKYDECK_CORE_SOFT: '0' });
  assert.equal(result.coreSoft, '0');
  assert.deepEqual(result.env, { HOME: '/h' });
});

test('serverEnvironment takes SKYDECK_CORE_SOFT out and returns it: a number of bytes', () => {
  assert.equal(
    serverEnvironment({ SKYDECK_CORE_SOFT: '18446744073709551614' }).coreSoft,
    '18446744073709551614',
  );
});

test('serverEnvironment gives coreSoft null when SKYDECK_CORE_SOFT is absent', () => {
  assert.equal(serverEnvironment({ HOME: '/h' }).coreSoft, null);
});

test('serverEnvironment removes a SKYDECK_CORE_SOFT that is not a limit, and gives null', () => {
  for (const value of ['', 'abc', '-1', '1.5', ' 5', 'UNLIMITED', '5\n']) {
    const result = serverEnvironment({ HOME: '/h', SKYDECK_CORE_SOFT: value });
    assert.equal(result.coreSoft, null, JSON.stringify(value));
    assert.deepEqual(result.env, { HOME: '/h' }, JSON.stringify(value));
  }
});

test('serverEnvironment takes SKYDECK_ENV_ORIGIN out and returns it (A29)', () => {
  const result = serverEnvironment({ HOME: '/h', SKYDECK_ENV_ORIGIN: '/home/me/projects/app' });
  assert.equal(result.origin, '/home/me/projects/app');
  assert.deepEqual(result.env, { HOME: '/h' });
});

test('serverEnvironment gives origin null when SKYDECK_ENV_ORIGIN is absent', () => {
  assert.equal(serverEnvironment({ HOME: '/h' }).origin, null);
});

test('serverEnvironment removes a SKYDECK_ENV_ORIGIN that is not an absolute path, and gives null', () => {
  for (const value of ['', 'relative/dir', '.']) {
    const result = serverEnvironment({ HOME: '/h', SKYDECK_ENV_ORIGIN: value });
    assert.equal(result.origin, null, JSON.stringify(value));
    assert.deepEqual(result.env, { HOME: '/h' }, JSON.stringify(value));
  }
});

test('serverEnvironment leaves CLAUDECODE in place (serve refuses on it; S2 5.2)', () => {
  assert.deepEqual(serverEnvironment({ CLAUDECODE: '1' }).env, { CLAUDECODE: '1' });
});

test('serverEnvironment does not change its argument', () => {
  const input = Object.freeze({
    HOME: '/h',
    SKYDECK_HANDOFF: '/tmp/x',
    SKYDECK_CORE_SOFT: '0',
    SKYDECK_ENV_ORIGIN: '/d',
  });
  serverEnvironment(input);
  assert.deepEqual(input, {
    HOME: '/h',
    SKYDECK_HANDOFF: '/tmp/x',
    SKYDECK_CORE_SOFT: '0',
    SKYDECK_ENV_ORIGIN: '/d',
  });
});

// ---------------------------------------------------------------------------------------------
// programEnvironment (S2 7.4)

const TERMINAL_NAMES = [
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'WT_SESSION',
  'WT_PROFILE_ID',
  'TMUX',
  'TMUX_PANE',
  'STY',
  'VTE_VERSION',
  'KITTY_WINDOW_ID',
  'ITERM_SESSION_ID',
  // The terminal of the shell that ran `skydeck window`, and an editor's Claude Code connection.
  'CLAUDE_CODE_SSE_PORT',
  'ENABLE_IDE_INTEGRATION',
  'GPG_TTY',
  'SSH_TTY',
];
// S2 7.4 names these families by prefix: every WEZTERM_*, KONSOLE_* and VSCODE_*.
const TERMINAL_FAMILIES = [
  'WEZTERM_PANE',
  'WEZTERM_EXECUTABLE',
  'WEZTERM_UNIX_SOCKET',
  'KONSOLE_DBUS_SESSION',
  'KONSOLE_DBUS_SERVICE',
  'KONSOLE_VERSION',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_GIT_IPC_HANDLE',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_INJECTION',
];
const SKYDECK_NAMES = [
  'SKYDECK_HANDOFF',
  'SKYDECK_LAUNCHER_CACHE',
  'SKYDECK_CORE_SOFT',
  'SKYDECK_ENV_ORIGIN',
];

function program(
  serverEnv: Record<string, string>,
  interop: string | null = null,
): Record<string, string> {
  return programEnvironment(serverEnv, { cwd: CWD, interop });
}

test('programEnvironment removes every terminal and multiplexer variable of S2 7.4', () => {
  for (const name of [...TERMINAL_NAMES, ...TERMINAL_FAMILIES]) {
    const result = program({ HOME: '/h', [name]: 'x' });
    assert.equal(name in result, false, name);
  }
});

test("programEnvironment removes skydeck's own variables", () => {
  for (const name of SKYDECK_NAMES) {
    const result = program({ HOME: '/h', [name]: '/x' });
    assert.equal(name in result, false, name);
  }
});

test("programEnvironment passes the SKYDECK_* variables the hook needs: only skydeck's own internal ones go", () => {
  const { env } = serverEnvironment({
    SKYDECK_HOME: '/home/me/trial',
    SKYDECK_NODE: '/opt/node/bin/node',
    SKYDECK_HANDOFF: '/tmp/h',
    SKYDECK_CORE_SOFT: '0',
  });
  assert.deepEqual(program(env), {
    SKYDECK_HOME: '/home/me/trial',
    SKYDECK_NODE: '/opt/node/bin/node',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PWD: CWD,
  });
});

test("programEnvironment removes the launcher's NODE_COMPILE_CACHE when the marker is still there", () => {
  const result = program({ HOME: '/h', NODE_COMPILE_CACHE: '/c', SKYDECK_LAUNCHER_CACHE: '/c' });
  assert.equal('NODE_COMPILE_CACHE' in result, false);
  assert.equal('SKYDECK_LAUNCHER_CACHE' in result, false);
});

test("programEnvironment removes the editor's GIT_ASKPASS (VSCODE_GIT_ASKPASS_MAIN beside it)", () => {
  const result = program({
    GIT_ASKPASS: '/home/me/.vscode-server/bin/x/extensions/git/dist/askpass.sh',
    VSCODE_GIT_ASKPASS_MAIN: '/home/me/.vscode-server/bin/x/extensions/git/dist/askpass-main.js',
    VSCODE_GIT_ASKPASS_NODE: '/home/me/.vscode-server/bin/x/node',
  });
  assert.equal('GIT_ASKPASS' in result, false);
  assert.equal('VSCODE_GIT_ASKPASS_MAIN' in result, false);
});

test('programEnvironment keeps a GIT_ASKPASS the user set (no VSCODE_GIT_ASKPASS_MAIN)', () => {
  assert.equal(
    program({ GIT_ASKPASS: '/usr/bin/ksshaskpass' }).GIT_ASKPASS,
    '/usr/bin/ksshaskpass',
  );
});

test('programEnvironment keeps a NODE_COMPILE_CACHE the user set', () => {
  assert.equal(program({ NODE_COMPILE_CACHE: '/mine' }).NODE_COMPILE_CACHE, '/mine');
  assert.equal(
    program({ NODE_COMPILE_CACHE: '/mine', SKYDECK_LAUNCHER_CACHE: '/launcher' })
      .NODE_COMPILE_CACHE,
    '/mine',
  );
});

test('programEnvironment removes every variable Claude Code sets for its children', () => {
  for (const name of CLAUDE_CHILD_VARIABLES) {
    const result = program({ HOME: '/h', [name]: '1' });
    assert.equal(name in result, false, name);
  }
});

test("programEnvironment passes the user's own CLAUDE_* settings (names, never prefixes)", () => {
  const own = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
    CLAUDE_CODE_SESSION_ID_X: 'kept',
    CLAUDECODE_EXTRA: 'kept',
    CLAUDE_PIDFILE: 'kept',
  };
  const result = program(own);
  for (const [name, value] of Object.entries(own)) {
    assert.equal(result[name], value, name);
  }
});

test('programEnvironment keeps variables that only resemble a terminal family', () => {
  const result = program({
    WEZTERM: 'a',
    KONSOLE: 'b',
    MY_TMUX: 'c',
    TERMINAL: 'd',
    VSCODE: 'e',
    MY_VSCODE_X: 'f',
    SSH_AUTH_SOCK: 'g',
    GPG_AGENT_INFO: 'h',
  });
  assert.equal(result.WEZTERM, 'a');
  assert.equal(result.KONSOLE, 'b');
  assert.equal(result.MY_TMUX, 'c');
  assert.equal(result.TERMINAL, 'd');
  assert.equal(result.VSCODE, 'e');
  assert.equal(result.MY_VSCODE_X, 'f');
  assert.equal(result.SSH_AUTH_SOCK, 'g');
  assert.equal(result.GPG_AGENT_INFO, 'h');
});

test('programEnvironment sets TERM, COLORTERM and PWD, over what the server had', () => {
  const result = program({ TERM: 'screen', COLORTERM: '24bit', PWD: '/' });
  assert.equal(result.TERM, 'xterm-256color');
  assert.equal(result.COLORTERM, 'truecolor');
  assert.equal(result.PWD, CWD);
});

test('programEnvironment sets TERM, COLORTERM and PWD when the server had none', () => {
  const result = program({});
  assert.deepEqual(result, { TERM: 'xterm-256color', COLORTERM: 'truecolor', PWD: CWD });
});

test('programEnvironment points WSL_INTEROP at the link when one is given', () => {
  assert.equal(program({ WSL_INTEROP: '/run/WSL/1_interop' }, LINK).WSL_INTEROP, LINK);
  assert.equal(program({}, LINK).WSL_INTEROP, LINK);
});

test('programEnvironment leaves WSL_INTEROP as it is without a link', () => {
  assert.equal(program({ WSL_INTEROP: '/run/WSL/1_interop' }).WSL_INTEROP, '/run/WSL/1_interop');
  assert.equal('WSL_INTEROP' in program({}), false);
});

test('programEnvironment never sets TERM_PROGRAM', () => {
  assert.equal('TERM_PROGRAM' in program({ TERM_PROGRAM: 'vscode' }, LINK), false);
  assert.equal('TERM_PROGRAM' in program({}), false);
});

test('programEnvironment passes every other variable unchanged', () => {
  const result = program({ HOME: '/h', PATH: '/usr/bin', AWS_PROFILE: 'dev', LANG: 'C.UTF-8' });
  assert.deepEqual(result, {
    HOME: '/h',
    PATH: '/usr/bin',
    AWS_PROFILE: 'dev',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PWD: CWD,
  });
});

test('programEnvironment does not change its argument', () => {
  const input = Object.freeze({ HOME: '/h', TMUX: 't', CLAUDECODE: '1', TERM: 'screen' });
  program(input, LINK);
  assert.deepEqual(input, { HOME: '/h', TMUX: 't', CLAUDECODE: '1', TERM: 'screen' });
});

test("programEnvironment over serverEnvironment gives a program none of the launcher's or Claude Code's variables", () => {
  const { env } = serverEnvironment({
    HOME: '/h',
    PATH: '/usr/bin',
    SKYDECK_HANDOFF: '/tmp/h',
    NODE_COMPILE_CACHE: '/c',
    SKYDECK_LAUNCHER_CACHE: '/c',
    SKYDECK_CORE_SOFT: 'unlimited',
    SKYDECK_ENV_ORIGIN: '/home/me',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    WEZTERM_PANE: '3',
    TERM_PROGRAM: 'WezTerm',
  });
  assert.deepEqual(program(env, LINK), {
    HOME: '/h',
    PATH: '/usr/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PWD: CWD,
    WSL_INTEROP: LINK,
  });
});
