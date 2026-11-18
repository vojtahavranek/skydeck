import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import type { Env } from './types.ts';

export interface Places {
  dataDir: string; // skydeck.db, the node and skydeck-hook links
  stateDir: string; // spool/, locks/, hook.log
  configDir: string; // config.json
  claudeHome: string;
  /**
   * Claude Code's global config file (follow-up F11): `<homeDir>/.claude.json`, beside the default
   * claudeHome; `<claudeHome>/.claude.json` when claudeHome is named (config.json or
   * CLAUDE_CONFIG_DIR), unless config.json names the default `<homeDir>/.claude`.
   */
  claudeGlobalConfig: string;
  dbPath: string; // <dataDir>/skydeck.db
  hookPath: string; // <dataDir>/skydeck-hook
  nodeLink: string; // <dataDir>/node
  spoolDir: string; // <stateDir>/spool
  badDir: string; // <stateDir>/spool/bad
  locksDir: string; // <stateDir>/locks
  hookLog: string; // <stateDir>/hook.log
  configPath: string; // <configDir>/config.json
  binLink: string; // <homeDir>/.local/bin/skydeck
}

/** The value of an environment variable, unless it is unset, empty or not absolute (D26). */
function absoluteEnv(env: Env, name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== '' && isAbsolute(value) ? value : null;
}

/**
 * One of the three skydeck directories: `<SKYDECK_HOME>/<own>`, else `<XDG variable>/skydeck`,
 * else `<homeDir>/<fallback>/skydeck`.
 */
function skydeckDir(env: Env, homeDir: string, own: string, xdg: string, fallback: string): string {
  const skydeckHome = absoluteEnv(env, 'SKYDECK_HOME');
  if (skydeckHome !== null) {
    return join(skydeckHome, own);
  }
  return join(absoluteEnv(env, xdg) ?? join(homeDir, fallback), 'skydeck');
}

/** Only the config directory, needed before config.json can be read. */
export function resolveConfigDir(env: Env, homeDir: string): string {
  return skydeckDir(env, homeDir, 'config', 'XDG_CONFIG_HOME', '.config');
}

/**
 * Design 9.1. An env value that is empty or not absolute counts as unset.
 * SKYDECK_HOME → <it>/data, <it>/state, <it>/config. Else XDG_DATA_HOME / XDG_STATE_HOME /
 * XDG_CONFIG_HOME + "/skydeck", defaulting to <homeDir>/.local/share, /.local/state, /.config.
 * claudeHome: `configuredClaudeHome` (from config.json, already checked to be absolute by
 * parseConfig, so used as given), else CLAUDE_CONFIG_DIR, else <homeDir>/.claude.
 * claudeGlobalConfig by the same rule: Claude Code keeps `.claude.json` in the home directory, and
 * inside CLAUDE_CONFIG_DIR when that is set; a claudeHome in config.json stands for the
 * CLAUDE_CONFIG_DIR that Claude Code runs with (only that variable moves Claude Code's home),
 * except when it is the default <homeDir>/.claude written out: those sessions run without it, so
 * the file is <homeDir>/.claude.json, unless CLAUDE_CONFIG_DIR names that same directory.
 */
export function resolvePlaces(
  env: Env,
  homeDir: string,
  configuredClaudeHome: string | null,
): Places {
  const dataDir = skydeckDir(env, homeDir, 'data', 'XDG_DATA_HOME', join('.local', 'share'));
  const stateDir = skydeckDir(env, homeDir, 'state', 'XDG_STATE_HOME', join('.local', 'state'));
  const configDir = resolveConfigDir(env, homeDir);
  const spoolDir = join(stateDir, 'spool');
  const defaultClaudeHome = join(homeDir, '.claude');
  const envClaudeHome = absoluteEnv(env, 'CLAUDE_CONFIG_DIR');
  let globalConfigDir = envClaudeHome ?? homeDir;
  if (configuredClaudeHome !== null) {
    // The default written out: those sessions run without CLAUDE_CONFIG_DIR, unless the variable
    // names that very directory, when Claude Code keeps the file inside it.
    const isDefault = (dir: string | null): boolean =>
      dir !== null && samePath(dir, defaultClaudeHome);
    if (!isDefault(configuredClaudeHome)) {
      globalConfigDir = configuredClaudeHome;
    } else {
      globalConfigDir = isDefault(envClaudeHome) ? defaultClaudeHome : homeDir;
    }
  }
  return {
    dataDir,
    stateDir,
    configDir,
    claudeHome: configuredClaudeHome ?? envClaudeHome ?? defaultClaudeHome,
    claudeGlobalConfig: join(globalConfigDir, '.claude.json'),
    dbPath: join(dataDir, 'skydeck.db'),
    hookPath: join(dataDir, 'skydeck-hook'),
    nodeLink: join(dataDir, 'node'),
    spoolDir,
    badDir: join(spoolDir, 'bad'),
    locksDir: join(stateDir, 'locks'),
    hookLog: join(stateDir, 'hook.log'),
    configPath: join(configDir, 'config.json'),
    binLink: join(homeDir, '.local', 'bin', 'skydeck'),
  };
}

/** Two paths that name one directory as written: `/h/.claude/` and `/h//.claude` are `/h/.claude`. */
function samePath(a: string, b: string): boolean {
  const normal = (path: string): string => join(path).replace(/(?<=.)\/+$/, '');
  return normal(a) === normal(b);
}

/** The first 8 hex digits of the sha256 of the store's path (S2 4.2). */
export function storeId(dbPath: string): string {
  return createHash('sha256').update(dbPath).digest('hex').slice(0, 8);
}

export type RuntimeRule = 'skydeck-home' | 'xdg-runtime' | 'state-dir';

/**
 * S2 4.2's rule, without the store's record: $SKYDECK_HOME/run when SKYDECK_HOME counts (D26);
 * else $XDG_RUNTIME_DIR/skydeck-<id> when XDG_RUNTIME_DIR counts and `xdgUsable(dir)` says it is
 * a directory of the user's, not readable by others, and the user lingers; else <stateDir>/run-<id>.
 * `xdgUsable` is asked only when XDG_RUNTIME_DIR decides.
 */
export function runtimeDirByRule(input: {
  env: Env;
  stateDir: string;
  storeId: string;
  xdgUsable: (xdgDir: string) => boolean;
}): { dir: string; rule: RuntimeRule } {
  const skydeckHome = absoluteEnv(input.env, 'SKYDECK_HOME');
  if (skydeckHome !== null) {
    return { dir: join(skydeckHome, 'run'), rule: 'skydeck-home' };
  }
  const xdg = absoluteEnv(input.env, 'XDG_RUNTIME_DIR');
  if (xdg !== null && input.xdgUsable(xdg)) {
    return { dir: join(xdg, `skydeck-${input.storeId}`), rule: 'xdg-runtime' };
  }
  return { dir: join(input.stateDir, `run-${input.storeId}`), rule: 'state-dir' };
}

/** Every directory the rule can give, for `uninstall --purge` (S2 16.2), in the rule's order. */
export function runtimeDirCandidates(env: Env, stateDir: string, storeId: string): string[] {
  const skydeckHome = absoluteEnv(env, 'SKYDECK_HOME');
  const xdg = absoluteEnv(env, 'XDG_RUNTIME_DIR');
  return [
    ...(skydeckHome === null ? [] : [join(skydeckHome, 'run')]),
    ...(xdg === null ? [] : [join(xdg, `skydeck-${storeId}`)]),
    join(stateDir, `run-${storeId}`),
  ];
}
