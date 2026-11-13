import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveConfigDir, resolvePlaces } from '../../src/platform/paths.ts';

describe('resolvePlaces (home /h)', () => {
  test('with an empty environment everything is under the home directory', () => {
    const places = resolvePlaces({}, '/h', null);

    assert.deepEqual(places, {
      dataDir: '/h/.local/share/skydeck',
      stateDir: '/h/.local/state/skydeck',
      configDir: '/h/.config/skydeck',
      claudeHome: '/h/.claude',
      dbPath: '/h/.local/share/skydeck/skydeck.db',
      hookPath: '/h/.local/share/skydeck/skydeck-hook',
      nodeLink: '/h/.local/share/skydeck/node',
      spoolDir: '/h/.local/state/skydeck/spool',
      badDir: '/h/.local/state/skydeck/spool/bad',
      locksDir: '/h/.local/state/skydeck/locks',
      hookLog: '/h/.local/state/skydeck/hook.log',
      configPath: '/h/.config/skydeck/config.json',
      binLink: '/h/.local/bin/skydeck',
    });
  });

  test('the XDG variables move the three directories', () => {
    const places = resolvePlaces(
      { XDG_DATA_HOME: '/x/d', XDG_STATE_HOME: '/x/s', XDG_CONFIG_HOME: '/x/c' },
      '/h',
      null,
    );

    assert.equal(places.dataDir, '/x/d/skydeck');
    assert.equal(places.stateDir, '/x/s/skydeck');
    assert.equal(places.configDir, '/x/c/skydeck');
    assert.equal(places.dbPath, '/x/d/skydeck/skydeck.db');
    assert.equal(places.spoolDir, '/x/s/skydeck/spool');
    assert.equal(places.configPath, '/x/c/skydeck/config.json');
  });

  test('an XDG value that is relative or empty counts as unset (D26)', () => {
    const places = resolvePlaces({ XDG_DATA_HOME: 'rel/d', XDG_STATE_HOME: '' }, '/h', null);

    assert.equal(places.dataDir, '/h/.local/share/skydeck');
    assert.equal(places.stateDir, '/h/.local/state/skydeck');
  });

  test('SKYDECK_HOME replaces the three directories and beats XDG', () => {
    const places = resolvePlaces({ SKYDECK_HOME: '/s', XDG_DATA_HOME: '/x/d' }, '/h', null);

    assert.equal(places.dataDir, '/s/data');
    assert.equal(places.stateDir, '/s/state');
    assert.equal(places.configDir, '/s/config');
  });

  test('a relative or empty SKYDECK_HOME is ignored (D26)', () => {
    for (const value of ['rel', '']) {
      const places = resolvePlaces({ SKYDECK_HOME: value }, '/h', null);

      assert.equal(
        places.dataDir,
        '/h/.local/share/skydeck',
        `SKYDECK_HOME=${JSON.stringify(value)}`,
      );
    }
  });

  test('a trailing slash in an environment value does not leak into the paths', () => {
    const places = resolvePlaces({ SKYDECK_HOME: '/s/', XDG_CONFIG_HOME: '/x/c/' }, '/h', null);
    const xdg = resolvePlaces({ XDG_CONFIG_HOME: '/x/c/' }, '/h', null);

    assert.equal(places.dataDir, '/s/data');
    assert.equal(xdg.configDir, '/x/c/skydeck');
  });

  test('a relative CLAUDE_CONFIG_DIR is ignored (D26)', () => {
    assert.equal(resolvePlaces({ CLAUDE_CONFIG_DIR: 'rel' }, '/h', null).claudeHome, '/h/.claude');
    assert.equal(resolvePlaces({ CLAUDE_CONFIG_DIR: '' }, '/h', null).claudeHome, '/h/.claude');
  });

  test('claudeHome is the configured path, else CLAUDE_CONFIG_DIR, else ~/.claude (D3)', () => {
    const env = { CLAUDE_CONFIG_DIR: '/c' };

    assert.equal(resolvePlaces(env, '/h', null).claudeHome, '/c');
    assert.equal(resolvePlaces(env, '/h', '/k').claudeHome, '/k');
    assert.equal(resolvePlaces({}, '/h', '/k').claudeHome, '/k');
  });

  test('a configured claudeHome is used as it is given: validating it is the job of parseConfig', () => {
    assert.equal(resolvePlaces({ CLAUDE_CONFIG_DIR: '/c' }, '/h', 'rel/k').claudeHome, 'rel/k');
  });

  test('binLink is always under the home directory', () => {
    const places = resolvePlaces({ SKYDECK_HOME: '/s', XDG_DATA_HOME: '/x/d' }, '/h', null);

    assert.equal(places.binLink, '/h/.local/bin/skydeck');
  });
});

describe('resolveConfigDir', () => {
  test('SKYDECK_HOME gives <it>/config', () => {
    assert.equal(resolveConfigDir({ SKYDECK_HOME: '/s' }, '/h'), '/s/config');
  });

  test('without any variable it is ~/.config/skydeck', () => {
    assert.equal(resolveConfigDir({}, '/h'), '/h/.config/skydeck');
  });

  test('it agrees with resolvePlaces', () => {
    for (const env of [
      {},
      { SKYDECK_HOME: '/s' },
      { XDG_CONFIG_HOME: '/x/c' },
      { XDG_CONFIG_HOME: 'rel' },
    ]) {
      assert.equal(resolveConfigDir(env, '/h'), resolvePlaces(env, '/h', null).configDir);
    }
  });
});
