import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      links: 'default',
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
      window: {
        port: 1,
        edge: '/opt/edge',
        profileDir: 'D:\\skydeck\\edge',
        keepAlive: 'off',
        links: 'edge',
      },
    });

    assert.deepEqual((load(t, text).run() as { window: unknown }).window, {
      port: 1,
      edge: '/opt/edge',
      profileDir: 'D:\\skydeck\\edge',
      keepAlive: 'off',
      links: 'edge',
    });
    assert.equal(parseConfig('{"window":{"port":65535}}', 'x').window.port, 65535);
    assert.equal(parseConfig('{"window":{"profileDir":"c:\\\\"}}', 'x').window.profileDir, 'c:\\');
    assert.equal(parseConfig('{"window":{"profileDir":null}}', 'x').window.profileDir, null);
  });

  test('window.links is "default" unless set, and takes "default" or "edge" (S2 9.6, 16.4)', () => {
    assert.equal(parseConfig('{}', 'x').window.links, 'default');
    assert.equal(parseConfig('{"window":{"port":47000}}', 'x').window.links, 'default');
    assert.equal(parseConfig('{"window":{"links":"default"}}', 'x').window.links, 'default');
    assert.equal(parseConfig('{"window":{"links":"edge"}}', 'x').window.links, 'edge');
  });

  test('a wrong window.links is refused as a wrong window.keepAlive is, in the same words', () => {
    for (const value of ['"chrome"', '"EDGE"', '1', 'true', 'null', '{}']) {
      assert.throws(
        () => parseConfig(`{"window":{"links":${value}}}`, '/c/config.json'),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError, String(error));
          assert.equal(
            error.message,
            '/c/config.json: "window.links" must be "default" or "edge"',
            value,
          );
          return true;
        },
      );
    }
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
    ['{"window":{"links":"chrome"}}', 'window.links'],
    ['{"window":{"links":"Default"}}', 'window.links'],
    ['{"window":{"links":""}}', 'window.links'],
    ['{"window":{"links":false}}', 'window.links'],
    ['{"window":{"links":null}}', 'window.links'],
    ['{"window":{"links":["edge"]}}', 'window.links'],
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
      ticketUrl: null,
      ticketStatus: [],
      ticketRefreshMinutes: 10,
      window: {
        port: 47613,
        edge: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        profileDir: null,
        keepAlive: 'wsl',
        links: 'default',
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

describe('ticketUrl (S2 16.4): the URL parser decides where {key} stands', () => {
  const MESSAGE =
    '"ticketUrl" must be null or an http or https address with {key} once, after its host';

  /** The config with `ticketUrl` set to `value`, loaded from a file in a fresh sandbox. */
  function withTicketUrl(t: TestContext, value: unknown): { path: string; run: () => unknown } {
    return load(t, JSON.stringify({ ticketUrl: value }));
  }

  for (const value of [
    null,
    'https://example.atlassian.net/browse/{key}',
    'http://host:8080/t?id={key}',
    'https://host/#/{key}',
    'https://Example.net:443/{key}',
    // A host of the pattern's own that holds a sample key's text: it is the same for both sample
    // keys, so the key is not in it (ruled on #77).
    'https://key-1.example.net/{key}',
    // A whole escape right before {key}: the key cannot finish it (ruled on #77).
    'https://host/issues/?jql=key%3D{key}',
    'https://host/b/%25{key}',
    // A `%` and a character that is no hex digit right before {key}: no key can finish that into
    // an escape, so the rule (`%`, or `%` and one hex digit) does not refuse it.
    'https://host/b/%g{key}',
  ]) {
    test(`accepts ${JSON.stringify(value)}, kept as it was written`, (t) => {
      const config = withTicketUrl(t, value).run() as { ticketUrl: unknown };
      assert.equal(config.ticketUrl, value);
    });
  }

  test('accepts one of exactly 2,048 characters', (t) => {
    const base = 'https://example.net/{key}/';
    const value = `${base}${'a'.repeat(2048 - base.length)}`;
    assert.equal(value.length, 2048);

    assert.equal((withTicketUrl(t, value).run() as { ticketUrl: unknown }).ticketUrl, value);
  });

  const refused: [name: string, value: unknown][] = [
    // Review A's five: the parser skips the slashes, or takes the key as the user name.
    ['the key read as the host behind three slashes', 'https:///{key}/x'],
    ['the key read as the host behind four slashes', 'https:////{key}'],
    ['the key read as the host behind one slash', 'https:/{key}/x'],
    ['the key read as the host without slashes', 'https:{key}'],
    ['the key read as the user name behind three slashes', 'https:///{key}@h/x'],
    ['the key in the host', 'https://{key}.example.net/'],
    ['the key as the host, after a user name', 'https://user@{key}/'],
    ['the key at the end of the host', 'https://host{key}/'],
    ['the key as the user name', 'https://{key}@host/x'],
    ['the key as the password', 'https://u:{key}@host/x'],
    ['the key as the port', 'https://host:{key}/'],
    // No user name or password: show would print it, and Edge's command line would carry it.
    ['a user name', 'https://user@host/{key}'],
    ['a user name and a password', 'https://user:secret@host/{key}'],
    ['a password', 'https://:secret@host/{key}'],
    ['a user name that holds a sample key', 'https://Other-2@host/{key}'],
    // An escape left unfinished right before {key}, that a key would finish (ruled on #77).
    ['a % right before {key}', 'https://host/b/%{key}'],
    ['a % and a digit right before {key}', 'https://host/b/%2{key}'],
    ['a % and a lower-case hex letter right before {key}', 'https://host/b/%a{key}'],
    ['a % and an upper-case hex letter right before {key}', 'https://host/b/%A{key}'],
    ['a % and a digit right before {key}, in the query', 'https://host/t?id=%2{key}'],
    ['a % and a digit right before {key}, in the fragment', 'https://host/#%2{key}'],
    ['javascript:', 'javascript:{key}'],
    ['file:', 'file:///{key}'],
    ['ftp:', 'ftp://host/{key}'],
    ['not a URL', 'example.net/{key}'],
    ['no {key}', 'https://host/browse/'],
    ['{key} twice', 'https://host/{key}/{key}'],
    ['a "', 'https://host/{key}?q="a"'],
    ['a backslash', 'https://host/a\\{key}'],
    ['a space', 'https://host/a b/{key}'],
    ['a tab', 'https://host/a\tb/{key}'],
    ['an escape character', 'https://host/\x1b[31m/{key}'],
    ['a DEL', 'https://host/a\x7f/{key}'],
    ['a C1 control', 'https://host/a\u009b/{key}'],
    ['a no-break space', 'https://host/a\u00a0b/{key}'],
    ['2,049 characters', `https://example.net/{key}/${'a'.repeat(2049 - 26)}`],
    ['the empty string', ''],
    ['a number', 3],
    ['true', true],
    ['an object', { url: 'https://host/{key}' }],
  ];
  for (const [name, value] of refused) {
    test(`refuses ${name}: ${JSON.stringify(value)}`, (t) => {
      const { path, run } = withTicketUrl(t, value);

      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof ConfigError, String(error));
        assert.equal(error.message, `${path}: ${MESSAGE}`);
        return true;
      });
    });
  }

  test('the 2,049 characters of that case are 2,049', () => {
    const [, value] = refused.find(([name]) => name === '2,049 characters') ?? [];
    assert.equal((value as string).length, 2049);
  });

  test('src/platform/config.ts imports nothing outside src/platform/ (D18)', () => {
    const source = readFileSync(join(import.meta.dirname, '../../src/platform/config.ts'), 'utf8');
    const from = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
    assert.deepEqual(from, ['node:path', './errors.ts', './types.ts']);
  });
});

describe('terminal "window" (S2 16.4, 11.4; plan C13, task 77)', () => {
  const MESSAGE = '"terminal" must be "here", "wezterm" or "window"';

  test('"window" is accepted', (t) => {
    assert.deepEqual(load(t, '{"terminal":"window"}').run(), {
      ...DEFAULT_CONFIG,
      terminal: 'window',
    });
  });

  test('"here" and "wezterm" are accepted as before', (t) => {
    assert.equal((load(t, '{"terminal":"here"}').run() as { terminal: unknown }).terminal, 'here');
    assert.equal(
      (load(t, '{"terminal":"wezterm"}').run() as { terminal: unknown }).terminal,
      'wezterm',
    );
  });

  for (const value of ['tabs', 'Window', 'window ', '', null, 3, ['window']]) {
    test(`${JSON.stringify(value)} is refused with the message that names the three values`, (t) => {
      const { path, run } = load(t, JSON.stringify({ terminal: value }));

      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof ConfigError, String(error));
        assert.equal(error.message, `${path}: ${MESSAGE}`);
        return true;
      });
    });
  }

  test('the default stays "here"', (t) => {
    assert.equal(DEFAULT_CONFIG.terminal, 'here');
    assert.equal((load(t, '{}').run() as { terminal: unknown }).terminal, 'here');
    assert.equal((load(t, null).run() as { terminal: unknown }).terminal, 'here');
  });
});
