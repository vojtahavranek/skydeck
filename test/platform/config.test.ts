import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { DEFAULT_CONFIG, loadConfig, parseConfig } from '../../src/platform/config.ts';
import { ConfigError } from '../../src/platform/errors.ts';
import { testPlatform } from '../helpers/platform.ts';

/** Writes `text` as a config file in a fresh sandbox and loads it. */
function load(t: TestContext, text: string | null): { path: string; run: () => unknown } {
  const { platform, sandbox } = testPlatform(t);
  const path = join(sandbox.root, 'config.json');
  if (text !== null) {
    platform.files.writeText(path, text);
  }
  return { path, run: () => loadConfig(platform.files, path) };
}

describe('loadConfig', () => {
  test('a missing file gives the defaults', (t) => {
    assert.deepEqual(load(t, null).run(), DEFAULT_CONFIG);
  });

  test('an empty object gives the defaults', (t) => {
    assert.deepEqual(load(t, '{}').run(), DEFAULT_CONFIG);
  });

  test('values in the file replace the defaults, the rest stays', (t) => {
    const text = '{"terminal":"wezterm","wezterm":{"domain":"WSL:Ubuntu"},"restoreBatch":2}';

    assert.deepEqual(load(t, text).run(), {
      ...DEFAULT_CONFIG,
      terminal: 'wezterm',
      wezterm: { domain: 'WSL:Ubuntu' },
      restoreBatch: 2,
    });
  });

  test('an empty object gives the window defaults of plan 2.2', (t) => {
    assert.deepEqual((load(t, '{}').run() as { window: unknown }).window, {
      port: 47613,
      edge: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      profileDir: null,
      keepAlive: 'wsl',
    });
  });

  test('a window key replaces its default, the other window keys stay', (t) => {
    assert.deepEqual(load(t, '{"window":{"port":47000}}').run(), {
      ...DEFAULT_CONFIG,
      window: { ...DEFAULT_CONFIG.window, port: 47000 },
    });
  });

  test('every window key can be set (S2 16.4)', (t) => {
    const text = JSON.stringify({
      window: { port: 1, edge: '/opt/edge', profileDir: 'D:\\skydeck\\edge', keepAlive: 'off' },
    });

    assert.deepEqual((load(t, text).run() as { window: unknown }).window, {
      port: 1,
      edge: '/opt/edge',
      profileDir: 'D:\\skydeck\\edge',
      keepAlive: 'off',
    });
    assert.equal(parseConfig('{"window":{"port":65535}}', 'x').window.port, 65535);
    assert.equal(parseConfig('{"window":{"profileDir":"c:\\\\"}}', 'x').window.profileDir, 'c:\\');
    assert.equal(parseConfig('{"window":{"profileDir":null}}', 'x').window.profileDir, null);
  });

  test('an empty wezterm object leaves the domain null', (t) => {
    assert.equal(
      (load(t, '{"wezterm":{}}').run() as { wezterm: { domain: unknown } }).wezterm.domain,
      null,
    );
  });

  const invalid: [text: string, key: string | null][] = [
    ['not json', null],
    ['[]', null],
    ['null', null],
    ['3', null],
    ['{"colour":1}', 'colour'],
    ['{"wezterm":{"domian":"x"}}', 'domian'],
    ['{"terminal":"kitty"}', 'terminal'],
    ['{"terminal":3}', 'terminal'],
    ['{"restoreBatch":0}', 'restoreBatch'],
    ['{"restoreBatch":1.5}', 'restoreBatch'],
    ['{"restoreBatch":"3"}', 'restoreBatch'],
    ['{"restoreBatch":-1}', 'restoreBatch'],
    ['{"firstRunDoneAfterDays":0}', 'firstRunDoneAfterDays'],
    ['{"prRefreshMinutes":0}', 'prRefreshMinutes'],
    ['{"restoreMinFreeMb":0}', 'restoreMinFreeMb'],
    ['{"restoreStartTimeoutSeconds":0}', 'restoreStartTimeoutSeconds'],
    ['{"groupPattern":"("}', 'groupPattern'],
    ['{"groupPattern":3}', 'groupPattern'],
    ['{"claudeHome":"rel/dir"}', 'claudeHome'],
    ['{"claudeHome":3}', 'claudeHome'],
    ['{"claudeCommand":""}', 'claudeCommand'],
    ['{"claudeCommand":3}', 'claudeCommand'],
    ['{"wezterm":{"domain":5}}', 'domain'],
    ['{"wezterm":{"domain":""}}', 'domain'],
    ['{"wezterm":[]}', 'wezterm'],
    ['{"wezterm":"x"}', 'wezterm'],
    ['{"window":[]}', 'window'],
    ['{"window":null}', 'window'],
    ['{"window":{"colour":1}}', 'window.colour'],
    ['{"window":{"port":0}}', 'window.port'],
    ['{"window":{"port":65536}}', 'window.port'],
    ['{"window":{"port":1.5}}', 'window.port'],
    ['{"window":{"port":"1"}}', 'window.port'],
    ['{"window":{"port":-1}}', 'window.port'],
    ['{"window":{"edge":"msedge.exe"}}', 'window.edge'],
    ['{"window":{"edge":""}}', 'window.edge'],
    ['{"window":{"edge":null}}', 'window.edge'],
    ['{"window":{"profileDir":"relative\\\\x"}}', 'window.profileDir'],
    ['{"window":{"profileDir":"/mnt/c/x"}}', 'window.profileDir'],
    ['{"window":{"profileDir":"C:"}}', 'window.profileDir'],
    ['{"window":{"profileDir":"C:/x"}}', 'window.profileDir'],
    ['{"window":{"profileDir":3}}', 'window.profileDir'],
    ['{"window":{"keepAlive":"on"}}', 'window.keepAlive'],
    ['{"window":{"keepAlive":false}}', 'window.keepAlive'],
  ];
  for (const [text, key] of invalid) {
    test(`${text} is a ConfigError naming the file${key === null ? '' : ` and ${key}`}`, (t) => {
      const { path, run } = load(t, text);

      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof ConfigError, String(error));
        assert.ok(error.message.includes(path), `message names the path: ${error.message}`);
        if (key !== null) {
          assert.ok(error.message.includes(key), `message names ${key}: ${error.message}`);
        }
        return true;
      });
    });
  }
});

describe('parseConfig', () => {
  test('the result is a copy: changing it leaves DEFAULT_CONFIG alone', () => {
    const config = parseConfig('{}', 'x');

    config.wezterm.domain = 'changed';
    config.restoreBatch = 99;
    config.window.port = 1;

    assert.equal(DEFAULT_CONFIG.wezterm.domain, null);
    assert.equal(DEFAULT_CONFIG.restoreBatch, 3);
    assert.equal(DEFAULT_CONFIG.window.port, 47613);
  });

  test('an absolute claudeHome and a valid groupPattern are accepted', () => {
    const config = parseConfig('{"claudeHome":"/k","groupPattern":"^[a-z]+"}', 'x');

    assert.equal(config.claudeHome, '/k');
    assert.equal(config.groupPattern, '^[a-z]+');
  });

  test('null is accepted where the default is null', () => {
    const config = parseConfig('{"claudeHome":null,"wezterm":{"domain":null}}', 'x');

    assert.equal(config.claudeHome, null);
    assert.equal(config.wezterm.domain, null);
  });

  test('the defaults are the values of design 9.1 and plan 2.2.5', () => {
    assert.deepEqual(DEFAULT_CONFIG, {
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
    });
  });

  test('the message names the source it was given', () => {
    assert.throws(
      () => parseConfig('{"colour":1}', '/some/where.json'),
      /\/some\/where\.json.*colour/,
    );
  });
});
