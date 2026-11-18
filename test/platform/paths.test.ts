import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  resolveConfigDir,
  resolvePlaces,
  runtimeDirByRule,
  runtimeDirCandidates,
  storeId,
} from '../../src/platform/paths.ts';

describe('resolvePlaces (home /h)', () => {
  test('with an empty environment everything is under the home directory', () => {
    const places = resolvePlaces({}, '/h', null);

    assert.deepEqual(places, {
      dataDir: '/h/.local/share/skydeck',
      stateDir: '/h/.local/state/skydeck',
      configDir: '/h/.config/skydeck',
      claudeHome: '/h/.claude',
      claudeGlobalConfig: '/h/.claude.json',
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

  test("Claude Code's global config file: beside the default home, inside a home that is named (F11)", () => {
    // Claude Code keeps it at ~/.claude.json, and inside $CLAUDE_CONFIG_DIR when that is set; a
    // claudeHome in config.json stands for the CLAUDE_CONFIG_DIR its sessions run with.
    assert.equal(resolvePlaces({}, '/h', null).claudeGlobalConfig, '/h/.claude.json');
    assert.equal(
      resolvePlaces({ CLAUDE_CONFIG_DIR: '/c' }, '/h', null).claudeGlobalConfig,
      '/c/.claude.json',
    );
    assert.equal(
      resolvePlaces({ CLAUDE_CONFIG_DIR: '/c' }, '/h', '/k').claudeGlobalConfig,
      '/k/.claude.json',
    );
    assert.equal(resolvePlaces({}, '/h', '/k').claudeGlobalConfig, '/k/.claude.json');
    for (const ignored of ['rel', '']) {
      assert.equal(
        resolvePlaces({ CLAUDE_CONFIG_DIR: ignored }, '/h', null).claudeGlobalConfig,
        '/h/.claude.json',
        JSON.stringify(ignored),
      );
    }
    assert.equal(
      resolvePlaces({ CLAUDE_CONFIG_DIR: '/c/' }, '/h', null).claudeGlobalConfig,
      '/c/.claude.json',
    );
  });

  test('a configured claudeHome that is the default ~/.claude written out: ~/.claude.json, whatever CLAUDE_CONFIG_DIR says (F11)', () => {
    // Its sessions run as Claude Code's default home has them, so without CLAUDE_CONFIG_DIR.
    for (const configured of ['/h/.claude', '/h/.claude/', '/h//.claude']) {
      assert.equal(
        resolvePlaces({}, '/h', configured).claudeGlobalConfig,
        '/h/.claude.json',
        configured,
      );
      assert.equal(
        resolvePlaces({ CLAUDE_CONFIG_DIR: '/c' }, '/h', configured).claudeGlobalConfig,
        '/h/.claude.json',
        configured,
      );
    }
    // CLAUDE_CONFIG_DIR itself is Claude Code's own rule: the file is inside it, even for ~/.claude.
    assert.equal(
      resolvePlaces({ CLAUDE_CONFIG_DIR: '/h/.claude' }, '/h', null).claudeGlobalConfig,
      '/h/.claude/.claude.json',
    );
  });

  test('the default written out in config.json and CLAUDE_CONFIG_DIR naming that same directory: the file inside it, as Claude Code keeps it (review 2, N1)', () => {
    for (const variable of ['/h/.claude', '/h/.claude/', '/h//.claude']) {
      for (const configured of ['/h/.claude', '/h/.claude/']) {
        assert.equal(
          resolvePlaces({ CLAUDE_CONFIG_DIR: variable }, '/h', configured).claudeGlobalConfig,
          '/h/.claude/.claude.json',
          `${variable} ${configured}`,
        );
      }
    }
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

describe('storeId (S2 4.2)', () => {
  test('is the first 8 hex digits of the sha256 of the path', () => {
    const path = '/h/.local/share/skydeck/skydeck.db';
    const expected = createHash('sha256').update(path).digest('hex').slice(0, 8);

    assert.equal(storeId(path), expected);
    assert.match(storeId(path), /^[0-9a-f]{8}$/);
  });

  test('two stores have two ids', () => {
    assert.notEqual(storeId('/a/skydeck.db'), storeId('/b/skydeck.db'));
  });
});

describe('runtimeDirByRule (S2 4.2)', () => {
  const ID = 'ab12cd34';
  const usable = (): boolean => true;

  test('SKYDECK_HOME wins whatever XDG_RUNTIME_DIR says', () => {
    const asked: string[] = [];

    const result = runtimeDirByRule({
      env: { SKYDECK_HOME: '/s', XDG_RUNTIME_DIR: '/run/user/1' },
      stateDir: '/s/state',
      storeId: ID,
      xdgUsable: (dir) => {
        asked.push(dir);
        return true;
      },
    });

    assert.deepEqual(result, { dir: '/s/run', rule: 'skydeck-home' });
    assert.deepEqual(asked, [], 'XDG_RUNTIME_DIR is not even looked at');
  });

  test('without SKYDECK_HOME a usable XDG_RUNTIME_DIR gives skydeck-<id> in it', () => {
    const asked: string[] = [];

    const result = runtimeDirByRule({
      env: { XDG_RUNTIME_DIR: '/run/user/1' },
      stateDir: '/h/.local/state/skydeck',
      storeId: ID,
      xdgUsable: (dir) => {
        asked.push(dir);
        return true;
      },
    });

    assert.deepEqual(result, { dir: `/run/user/1/skydeck-${ID}`, rule: 'xdg-runtime' });
    assert.deepEqual(asked, ['/run/user/1']);
  });

  test('an XDG_RUNTIME_DIR that is relative, empty, unset or not usable gives run-<id> in the state directory', () => {
    const stateDir = '/h/.local/state/skydeck';
    const cases: [env: Record<string, string>, xdgUsable: () => boolean][] = [
      [{ XDG_RUNTIME_DIR: 'run/user/1' }, usable],
      [{ XDG_RUNTIME_DIR: '' }, usable],
      [{}, usable],
      [{ XDG_RUNTIME_DIR: '/run/user/1' }, () => false],
    ];
    for (const [env, xdgUsable] of cases) {
      assert.deepEqual(
        runtimeDirByRule({ env, stateDir, storeId: ID, xdgUsable }),
        { dir: `${stateDir}/run-${ID}`, rule: 'state-dir' },
        JSON.stringify(env),
      );
    }
  });

  test('a relative or empty SKYDECK_HOME does not count (D26)', () => {
    for (const value of ['rel', '']) {
      assert.equal(
        runtimeDirByRule({
          env: { SKYDECK_HOME: value, XDG_RUNTIME_DIR: '/run/user/1' },
          stateDir: '/st',
          storeId: ID,
          xdgUsable: usable,
        }).rule,
        'xdg-runtime',
        JSON.stringify(value),
      );
    }
  });

  test('a trailing slash in a variable does not leak into the path', () => {
    assert.equal(
      runtimeDirByRule({
        env: { SKYDECK_HOME: '/s/' },
        stateDir: '/st',
        storeId: ID,
        xdgUsable: usable,
      }).dir,
      '/s/run',
    );
    assert.equal(
      runtimeDirByRule({
        env: { XDG_RUNTIME_DIR: '/run/user/1/' },
        stateDir: '/st',
        storeId: ID,
        xdgUsable: usable,
      }).dir,
      `/run/user/1/skydeck-${ID}`,
    );
  });
});

describe('runtimeDirCandidates (S2 16.2)', () => {
  const ID = 'ab12cd34';

  test('lists the three directories of the rule in its order', () => {
    assert.deepEqual(
      runtimeDirCandidates({ SKYDECK_HOME: '/s', XDG_RUNTIME_DIR: '/run/user/1' }, '/s/state', ID),
      ['/s/run', `/run/user/1/skydeck-${ID}`, `/s/state/run-${ID}`],
    );
  });

  test('leaves out the ones whose variable does not count', () => {
    assert.deepEqual(runtimeDirCandidates({}, '/st', ID), [`/st/run-${ID}`]);
    assert.deepEqual(
      runtimeDirCandidates({ SKYDECK_HOME: 'rel', XDG_RUNTIME_DIR: '/run/user/1' }, '/st', ID),
      [`/run/user/1/skydeck-${ID}`, `/st/run-${ID}`],
    );
    assert.deepEqual(runtimeDirCandidates({ SKYDECK_HOME: '/s', XDG_RUNTIME_DIR: '' }, '/st', ID), [
      '/s/run',
      `/st/run-${ID}`,
    ]);
  });
});
