import { isAbsolute } from 'node:path';

import { ConfigError } from './errors.ts';
import type { Files } from './types.ts';

/** The keys of `window` (S2 16.4). */
export interface WindowConfig {
  port: number; // 1..65535 (A6)
  edge: string; // absolute path
  profileDir: string | null; // an absolute Windows path, `<letter>:\…`
  keepAlive: 'wsl' | 'off';
}

export interface Config {
  terminal: 'here' | 'wezterm';
  wezterm: { domain: string | null };
  groupPattern: string; // a RegExp source
  firstRunDoneAfterDays: number;
  prRefreshMinutes: number;
  restoreBatch: number;
  restoreMinFreeMb: number;
  restoreStartTimeoutSeconds: number;
  claudeHome: string | null;
  claudeCommand: string;
  window: WindowConfig;
}

export const DEFAULT_CONFIG: Config = {
  terminal: 'here',
  wezterm: { domain: null },
  groupPattern: '^[A-Z][A-Z0-9]+-[0-9]+',
  firstRunDoneAfterDays: 7,
  prRefreshMinutes: 5,
  restoreBatch: 3,
  restoreMinFreeMb: 4096,
  restoreStartTimeoutSeconds: 120,
  claudeHome: null,
  claudeCommand: 'claude',
  window: {
    port: 47613,
    edge: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    profileDir: null,
    keepAlive: 'wsl',
  },
};

/** A copy of the defaults that the caller may change. */
function defaults(): Config {
  return {
    ...DEFAULT_CONFIG,
    wezterm: { ...DEFAULT_CONFIG.wezterm },
    window: { ...DEFAULT_CONFIG.window },
  };
}

/** An absolute Windows path: a drive letter, a colon and a backslash (`C:\…`). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses config.json text and merges it over DEFAULT_CONFIG. Throws ConfigError naming `source`
 * and the key on: invalid JSON; a top level that is not an object; an unknown key (also inside
 * `wezterm`); a wrong type; `terminal` not here|wezterm; a number that is not a positive integer;
 * `groupPattern` that `new RegExp` rejects; `claudeHome` not absolute; `claudeCommand` empty; in
 * `window` (S2 16.4): an unknown key, `port` outside 1–65535, `edge` not absolute, `profileDir`
 * neither null nor an absolute Windows path, `keepAlive` neither "wsl" nor "off".
 *
 * `claudeHome` and `wezterm.domain` may also be `null`, which is their default; an empty
 * `wezterm.domain` is an error like an empty `claudeCommand`.
 */
export function parseConfig(text: string, source: string): Config {
  function fail(problem: string): never {
    throw new ConfigError(`${source}: ${problem}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isObject(parsed)) {
    fail('the top level must be an object');
  }

  const config = defaults();
  for (const [key, value] of Object.entries(parsed)) {
    switch (key) {
      case 'terminal':
        if (value !== 'here' && value !== 'wezterm') {
          fail('"terminal" must be "here" or "wezterm"');
        }
        config.terminal = value;
        break;
      case 'wezterm':
        if (!isObject(value)) {
          fail('"wezterm" must be an object');
        }
        for (const [name, domain] of Object.entries(value)) {
          if (name !== 'domain') {
            fail(`unknown key "wezterm.${name}"`);
          }
          if (domain !== null && (typeof domain !== 'string' || domain === '')) {
            fail('"wezterm.domain" must be a non-empty string or null');
          }
          config.wezterm.domain = domain;
        }
        break;
      case 'groupPattern':
        if (typeof value !== 'string') {
          fail('"groupPattern" must be a string');
        }
        try {
          new RegExp(value);
        } catch (error) {
          fail(
            `"groupPattern" is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        config.groupPattern = value;
        break;
      case 'firstRunDoneAfterDays':
      case 'prRefreshMinutes':
      case 'restoreBatch':
      case 'restoreMinFreeMb':
      case 'restoreStartTimeoutSeconds':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          fail(`"${key}" must be a positive integer`);
        }
        config[key] = value;
        break;
      case 'claudeHome':
        if (value !== null && (typeof value !== 'string' || !isAbsolute(value))) {
          fail('"claudeHome" must be an absolute path');
        }
        config.claudeHome = value;
        break;
      case 'claudeCommand':
        if (typeof value !== 'string' || value === '') {
          fail('"claudeCommand" must be a non-empty string');
        }
        config.claudeCommand = value;
        break;
      case 'window':
        if (!isObject(value)) {
          fail('"window" must be an object');
        }
        for (const [name, item] of Object.entries(value)) {
          switch (name) {
            case 'port':
              // 0 is not a setting: tests pass port 0 to the server directly (A6).
              if (
                typeof item !== 'number' ||
                !Number.isSafeInteger(item) ||
                item < 1 ||
                item > 65535
              ) {
                fail('"window.port" must be a whole number from 1 to 65535');
              }
              config.window.port = item;
              break;
            case 'edge':
              if (typeof item !== 'string' || !isAbsolute(item)) {
                fail('"window.edge" must be an absolute path');
              }
              config.window.edge = item;
              break;
            case 'profileDir':
              if (item !== null && (typeof item !== 'string' || !WINDOWS_ABSOLUTE.test(item))) {
                fail('"window.profileDir" must be an absolute Windows path (C:\\…) or null');
              }
              config.window.profileDir = item;
              break;
            case 'keepAlive':
              if (item !== 'wsl' && item !== 'off') {
                fail('"window.keepAlive" must be "wsl" or "off"');
              }
              config.window.keepAlive = item;
              break;
            default:
              fail(`unknown key "window.${name}"`);
          }
        }
        break;
      default:
        fail(`unknown key "${key}"`);
    }
  }
  return config;
}

/** DEFAULT_CONFIG when the file does not exist, else parseConfig(content, path). */
export function loadConfig(files: Files, configPath: string): Config {
  const text = files.readText(configPath);
  return text === null ? defaults() : parseConfig(text, configPath);
}
