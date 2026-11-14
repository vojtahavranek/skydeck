// The opened skydeck (design 9.1): configuration, places, directories and the database.
import { join } from 'node:path';

import { loadConfig } from '../platform/config.ts';
import type { Config } from '../platform/config.ts';
import { ConfigError, SkydeckError } from '../platform/errors.ts';
import { resolveConfigDir, resolvePlaces } from '../platform/paths.ts';
import type { Places } from '../platform/paths.ts';
import type { Platform } from '../platform/types.ts';
import { openStore } from '../store/store.ts';
import type { Store } from '../store/store.ts';
import { describeError } from './problems.ts';

/** The opened skydeck: what every function of src/sessions/ works on. */
export interface Deck {
  platform: Platform;
  places: Places;
  config: Config;
  store: Store;
}

/**
 * The first two steps of openDeck only (no directory, no database): for commands that must not
 * create anything. Throws ConfigError, also when config.json exists but cannot be read.
 */
export function resolveDeckPlaces(platform: Platform): { places: Places; config: Config } {
  const configPath = join(resolveConfigDir(platform.env, platform.homeDir), 'config.json');
  let config: Config;
  try {
    config = loadConfig(platform.files, configPath);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${configPath}: cannot be read (${describeError(error)})`);
  }
  return { places: resolvePlaces(platform.env, platform.homeDir, config.claudeHome), config };
}

/**
 * resolveConfigDir → loadConfig → resolvePlaces(env, homeDir, config.claudeHome) → mkdirp (0o700)
 * dataDir, stateDir, configDir, spoolDir, locksDir → openStore(dbPath, options). Throws
 * ConfigError; a directory it cannot create, or a database it cannot open, is a SkydeckError (exit
 * 1) naming it. `guardSchema` and `busyTimeoutMs` are for the server's deck only (openStore, S2
 * 10.1, 14).
 */
export function openDeck(
  platform: Platform,
  options: { guardSchema?: boolean; busyTimeoutMs?: number } = {},
): Deck {
  const { places, config } = resolveDeckPlaces(platform);
  for (const dir of [
    places.dataDir,
    places.stateDir,
    places.configDir,
    places.spoolDir,
    places.locksDir,
  ]) {
    try {
      platform.files.mkdirp(dir, 0o700);
    } catch (error) {
      throw new SkydeckError(`cannot create the directory ${dir} (${describeError(error)})`);
    }
  }
  return { platform, places, config, store: openStore(places.dbPath, options) };
}
