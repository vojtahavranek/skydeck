import { isAbsolute, join } from 'node:path';

import type { Env } from './types.ts';

export interface Places {
  dataDir: string; // skydeck.db, the node and skydeck-hook links
  stateDir: string; // spool/, locks/, hook.log
  configDir: string; // config.json
  claudeHome: string;
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
  return {
    dataDir,
    stateDir,
    configDir,
    claudeHome:
      configuredClaudeHome ?? absoluteEnv(env, 'CLAUDE_CONFIG_DIR') ?? join(homeDir, '.claude'),
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
