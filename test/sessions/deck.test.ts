import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigError, SkydeckError } from '../../src/platform/errors.ts';
import { DEFAULT_CONFIG } from '../../src/platform/config.ts';
import { openDeck, resolveDeckPlaces } from '../../src/sessions/deck.ts';
import { testContext } from '../helpers/context.ts';
import { testDeck } from '../helpers/deck.ts';

const mode = (path: string): number => statSync(path).mode & 0o777;

test('openDeck creates the skydeck directories (700) and the database (600) with the defaults', (t) => {
  const { deck, sandbox } = testDeck(t);
  const { places } = deck;
  for (const dir of [
    places.dataDir,
    places.stateDir,
    places.configDir,
    places.spoolDir,
    places.locksDir,
  ]) {
    assert.equal(mode(dir), 0o700, dir);
  }
  assert.equal(mode(places.dbPath), 0o600);
  assert.equal(deck.store.path, places.dbPath);
  assert.deepEqual(deck.config, DEFAULT_CONFIG);
  assert.equal(deck.places.claudeHome, sandbox.claudeHome);
});

test('openDeck takes claudeHome from config.json', (t) => {
  const { platform, places, sandbox } = testContext(t);
  const other = join(sandbox.root, 'other');
  mkdirSync(places.configDir, { recursive: true });
  writeFileSync(places.configPath, JSON.stringify({ claudeHome: other }));
  const deck = openDeck(platform);
  t.after(() => {
    deck.store.close();
  });
  assert.equal(deck.places.claudeHome, other);
});

test('testDeck writes its config and creates projects and sessions in the Claude home', (t) => {
  const d = testDeck(t, { config: { prRefreshMinutes: 9 } });
  assert.equal(d.deck.config.prRefreshMinutes, 9);
  assert.equal(statSync(join(d.sandbox.claudeHome, 'projects')).isDirectory(), true);
  assert.equal(statSync(join(d.sandbox.claudeHome, 'sessions')).isDirectory(), true);
});

test('openDeck refuses an unknown key in config.json with a ConfigError naming the path and the key', (t) => {
  const { platform, places } = testContext(t);
  mkdirSync(places.configDir, { recursive: true });
  writeFileSync(places.configPath, JSON.stringify({ colour: 1 }));
  assert.throws(
    () => openDeck(platform),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes(places.configPath) &&
      error.message.includes('colour'),
  );
  assert.equal(existsSync(places.dataDir), false, 'nothing is created before the config is read');
});

test('openDeck reports a config.json it cannot read as a ConfigError', (t) => {
  const { platform, places } = testContext(t);
  mkdirSync(places.configPath, { recursive: true }); // a directory where the file should be
  assert.throws(
    () => openDeck(platform),
    (error: unknown) => error instanceof ConfigError && error.message.includes(places.configPath),
  );
});

test('openDeck reports a directory it cannot create as a SkydeckError naming it', (t) => {
  const { platform, places, sandbox } = testContext(t);
  writeFileSync(join(sandbox.skydeckHome, 'state'), 'a file where the state directory goes');
  assert.throws(
    () => openDeck(platform),
    (error: unknown) =>
      error instanceof SkydeckError &&
      error.exitCode === 1 &&
      error.message.includes(places.stateDir),
  );
});

test('resolveDeckPlaces returns the places of openDeck and creates nothing', (t) => {
  const { platform, sandbox } = testContext(t);
  const before = readdirSync(sandbox.skydeckHome);
  const resolved = resolveDeckPlaces(platform);
  assert.deepEqual(readdirSync(sandbox.skydeckHome), before);
  assert.deepEqual(resolved.config, DEFAULT_CONFIG);
  const deck = openDeck(platform);
  t.after(() => {
    deck.store.close();
  });
  assert.deepEqual(resolved.places, deck.places);
});
