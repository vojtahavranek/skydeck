// Claude Code's global config file and its key `leftArrowOpensAgents` (follow-up F11, S2 7.9).
// Every file here is a made-up one in the test's sandbox: nothing reads or writes the real
// ~/.claude.json. Each fixture holds CANARY in the places a real one keeps secrets, and no
// reading, result or error may ever contain it.
import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import {
  LEFT_ARROW_KEY,
  TURN_OFF_ATTEMPTS,
  readLeftArrow,
  turnLeftArrowOff,
} from '../../src/claude/global-config.ts';
import type { TurnOffResult } from '../../src/claude/global-config.ts';
import { SkydeckError } from '../../src/platform/errors.ts';
import type { Files } from '../../src/platform/types.ts';
import { testPlatform } from '../helpers/platform.ts';
import type { TestPlatform } from '../helpers/platform.ts';

const CANARY = 'canary-0e1f2a3b';
/** 2023-11-14T22:13:20Z: a modification time utimes sets exactly, to the nanosecond. */
const WHOLE_SECOND = 1_700_000_000;
const isRoot = process.getuid?.() === 0; // root reads anything, so a mode proves nothing

/** A made-up global config: account details and an MCP server's token, each holding CANARY. */
function sample(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numStartups: 12,
    oauthAccount: { emailAddress: `${CANARY}@example.invalid`, organizationUuid: CANARY },
    mcpServers: { tickets: { command: 'tickets-mcp', env: { TICKETS_TOKEN: CANARY } } },
    projects: { '/home/dev/demo': { hasTrustDialogAccepted: true } },
    ...extra,
  };
}

/** The sandbox's global config file: CLAUDE_CONFIG_DIR is set, so `<claudeHome>/.claude.json`. */
function configFile(d: TestPlatform): string {
  return d.places.claudeGlobalConfig;
}

function put(path: string, text: string, mode = 0o600): void {
  writeFileSync(path, text);
  chmodSync(path, mode);
}

/** A platform and its global config file holding `text` (mode 600). */
function withFile(t: TestContext, text: string): { d: TestPlatform; path: string } {
  const d = testPlatform(t);
  const path = configFile(d);
  put(path, text);
  return { d, path };
}

/** Makes the backup the way install does: beside the file, its text, mode 600. */
function keeper(path: string): { keep: (text: string) => string; made: string[] } {
  const made: string[] = [];
  return {
    made,
    keep: (text) => {
      const backup = `${path}.skydeck-backup-${made.length + 1}`;
      writeFileSync(backup, text, { flag: 'wx', mode: 0o600 });
      made.push(backup);
      return backup;
    },
  };
}

function turnOff(d: TestPlatform, path: string, files: Files = d.platform.files): TurnOffResult {
  return turnLeftArrowOff(files, d.platform.uid, path, keeper(path).keep);
}

/** Every other name beside the file that holds its name: backups, and temporary files too. */
function leftovers(path: string): string[] {
  return readdirSync(dirname(path)).filter(
    (name) => name !== basename(path) && name.includes('claude.json'),
  );
}

function noCanary(...values: unknown[]): void {
  for (const value of values) {
    const text = value instanceof Error ? `${value.name} ${value.message}` : JSON.stringify(value);
    assert.ok(!text.includes(CANARY), `a value of the file leaked: ${text}`);
  }
}

describe('the global config file: readLeftArrow (L1)', () => {
  test('no file: unknown, with its path, and the file is not created', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it does not exist' });
    assert.throws(() => lstatSync(path), { code: 'ENOENT' });
  });

  test('the key absent or true: on; exactly false: off', (t) => {
    const cases: [Record<string, unknown>, string][] = [
      [sample(), 'on'],
      [sample({ [LEFT_ARROW_KEY]: true }), 'on'],
      [sample({ [LEFT_ARROW_KEY]: false }), 'off'],
    ];
    for (const [content, state] of cases) {
      const { d, path } = withFile(t, JSON.stringify(content, null, 2));

      const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

      assert.deepEqual(reading, { state, path, reason: null }, JSON.stringify(content));
    }
  });

  test('a key of that name inside another object is not the key: the top level decides', (t) => {
    const nested = { projects: { '/home/dev/demo': { [LEFT_ARROW_KEY]: false } } };
    const cases: [Record<string, unknown>, string][] = [
      [sample(nested), 'on'],
      [sample({ ...nested, [LEFT_ARROW_KEY]: true }), 'on'],
      [
        { [LEFT_ARROW_KEY]: false, ...sample({ projects: { p: { [LEFT_ARROW_KEY]: true } } }) },
        'off',
      ],
    ];
    for (const [content, state] of cases) {
      const { d, path } = withFile(t, JSON.stringify(content, null, 2));

      const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

      assert.deepEqual(reading, { state, path, reason: null }, JSON.stringify(content));
    }
  });

  test('a file that is not UTF-8 text: unknown (its bytes could not be kept as they are)', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    // A Latin-1 byte (0xE9) in a project's path: decoding would replace it.
    const bytes = Buffer.concat([
      Buffer.from('{\n  "projects": {"/home/x/caf'),
      Buffer.from([0xe9]),
      Buffer.from('": {"ok": true}},\n  "n": 1\n}\n'),
    ]);
    writeFileSync(path, bytes, { mode: 0o600 });

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it is not UTF-8 text' });
  });

  test('the key holding anything else (a string, 0, null, an object): unknown', (t) => {
    for (const value of ['false', 0, null, {}, []]) {
      const { d, path } = withFile(t, JSON.stringify(sample({ [LEFT_ARROW_KEY]: value })));

      const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

      assert.deepEqual(
        reading,
        { state: 'unknown', path, reason: 'leftArrowOpensAgents is neither true nor false' },
        JSON.stringify(value),
      );
    }
  });

  test('a file that is not JSON: unknown, and the reason holds nothing of the file', (t) => {
    // JSON.parse's own message quotes the text it failed on: it must not reach the reason.
    const { d, path } = withFile(t, `{"oauthAccount": {"token": "${CANARY}"`);

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it is not JSON' });
    noCanary(reading);
  });

  test('JSON that is not an object (an array, null, a string, a number): unknown', (t) => {
    for (const text of [`["${CANARY}"]`, 'null', `"${CANARY}"`, '7']) {
      const { d, path } = withFile(t, text);

      const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

      assert.deepEqual(
        reading,
        { state: 'unknown', path, reason: 'it is not a JSON object' },
        text,
      );
    }
  });

  test('a file that cannot be read: unknown, with the error code only', { skip: isRoot }, (t) => {
    const { d, path } = withFile(t, JSON.stringify(sample()));
    chmodSync(path, 0o000);

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it cannot be read: EACCES' });
  });

  test('a symbolic link is not followed: unknown', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    const target = join(d.sandbox.root, 'dotfiles.json');
    put(target, JSON.stringify(sample({ [LEFT_ARROW_KEY]: false })));
    symlinkSync(target, path);

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it is a symbolic link' });
  });

  test('a read-only file whose key is false is off: nothing would be written to it (review 2)', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    put(path, JSON.stringify(sample({ [LEFT_ARROW_KEY]: false })), 0o400);

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'off', path, reason: null });
  });

  test("a file without the owner's write bit whose shortcut is on: unknown (it is read-only for you)", (t) => {
    for (const mode of [0o400, 0o444, 0o500]) {
      const d = testPlatform(t);
      const path = configFile(d);
      put(path, JSON.stringify(sample()), mode);

      const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

      assert.deepEqual(
        reading,
        { state: 'unknown', path, reason: 'it is read-only' },
        mode.toString(8),
      );
    }
  });

  test('a directory at the path: unknown', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    mkdirSync(path);

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it is not a regular file' });
  });

  test("a file of another user: unknown (its owner is the file's, not this user's)", (t) => {
    const { d, path } = withFile(t, JSON.stringify(sample()));

    const reading = readLeftArrow(d.platform.files, d.platform.uid + 1, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it belongs to another user' });
  });

  test('a file that goes away between the look and the read: it does not exist (review 2)', (t) => {
    const { d, path } = withFile(t, JSON.stringify(sample()));
    const vanishing: Files = {
      ...d.platform.files,
      readBytes: () => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        });
      },
    };

    const reading = readLeftArrow(vanishing, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it does not exist' });
  });

  test('a file that starts with a byte-order mark: unknown (not JSON), never written, its first bytes kept (review 2, N2)', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a": 1}\n')]);
    writeFileSync(path, bytes, { mode: 0o600 });

    const reading = readLeftArrow(d.platform.files, d.platform.uid, path);
    const result = turnOff(d, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it is not JSON' });
    assert.deepEqual(result, { kind: 'unknown', reason: 'it is not JSON' });
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(leftovers(path), []);
  });

  test('a file that is there but cannot be looked at: unknown with the code, never a throw', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    const failing: Files = {
      ...d.platform.files,
      lstat: () => {
        throw Object.assign(new Error(`EIO: i/o error, lstat '${path}'`), { code: 'EIO' });
      },
    };

    const reading = readLeftArrow(failing, d.platform.uid, path);

    assert.deepEqual(reading, { state: 'unknown', path, reason: 'it cannot be read: EIO' });
  });
});

describe('the global config file: turnLeftArrowOff (L3), the text it writes', () => {
  test('two spaces and a final newline: the key is added after the last one, every other byte stays', (t) => {
    const before = `{\n  "numStartups": 12,\n  "oauthAccount": {\n    "token": "${CANARY}"\n  }\n}\n`;
    const { d, path } = withFile(t, before);

    const result = turnOff(d, path);

    assert.equal(result.kind, 'written');
    assert.equal(
      readFileSync(path, 'utf8'),
      `{\n  "numStartups": 12,\n  "oauthAccount": {\n    "token": "${CANARY}"\n  },\n  "leftArrowOpensAgents": false\n}\n`,
    );
    noCanary(result);
  });

  test('a tab and no final newline', (t) => {
    const before = `{\n\t"numStartups": 12,\n\t"mcpServers": {\n\t\t"x": "${CANARY}"\n\t}\n}`;
    const { d, path } = withFile(t, before);

    turnOff(d, path);

    assert.equal(
      readFileSync(path, 'utf8'),
      `{\n\t"numStartups": 12,\n\t"mcpServers": {\n\t\t"x": "${CANARY}"\n\t},\n\t"leftArrowOpensAgents": false\n}`,
    );
  });

  test('a single line, with and without spaces', (t) => {
    const cases = [
      [`{"a":1,"b":["${CANARY}"]}`, `{"a":1,"b":["${CANARY}"],"leftArrowOpensAgents":false}`],
      [`{"a": 1, "b": 2}\n`, `{"a": 1, "b": 2, "leftArrowOpensAgents": false}\n`],
      [`{ "a": 1 }`, `{ "a": 1, "leftArrowOpensAgents": false }`],
    ] as const;
    for (const [before, after] of cases) {
      const { d, path } = withFile(t, before);

      turnOff(d, path);

      assert.equal(readFileSync(path, 'utf8'), after, before);
    }
  });

  test('CRLF line ends stay', (t) => {
    const { d, path } = withFile(t, '{\r\n  "a": 1\r\n}\r\n');

    turnOff(d, path);

    assert.equal(
      readFileSync(path, 'utf8'),
      '{\r\n  "a": 1,\r\n  "leftArrowOpensAgents": false\r\n}\r\n',
    );
  });

  test('the key true: replaced where it is, not at the first true of the text; the keys after it stay after it', (t) => {
    // A real file holds many a `true` before the key, and a project may hold a key of that name.
    const head =
      '{\n  "hasTrustDialogAccepted": true,\n' +
      '  "projects": {"/home/dev/demo": {"leftArrowOpensAgents": true, "allowed": true}},\n';
    const before = `${head}  "leftArrowOpensAgents": true,\n  "z": "${CANARY}"\n}\n`;
    const { d, path } = withFile(t, before);

    const result = turnOff(d, path);

    assert.equal(result.kind, 'written');
    assert.equal(
      readFileSync(path, 'utf8'),
      `${head}  "leftArrowOpensAgents": false,\n  "z": "${CANARY}"\n}\n`,
    );
  });

  test('a nested key of that name holding false: only the top-level key is written', (t) => {
    const before =
      '{\n  "projects": {"p": {"leftArrowOpensAgents": false}},\n  "leftArrowOpensAgents": true\n}\n';
    const { d, path } = withFile(t, before);

    turnOff(d, path);

    assert.equal(
      readFileSync(path, 'utf8'),
      '{\n  "projects": {"p": {"leftArrowOpensAgents": false}},\n  "leftArrowOpensAgents": false\n}\n',
    );
  });

  test('an empty object gets the key on a line of its own', (t) => {
    const { d, path } = withFile(t, '{}\n');

    turnOff(d, path);

    assert.equal(readFileSync(path, 'utf8'), '{\n  "leftArrowOpensAgents": false\n}\n');
  });

  test('what a parse and a rewrite would change stays as written: big numbers, escapes, 1.50, numeric keys, a nested key named like ours', (t) => {
    // JSON.parse and JSON.stringify would lose digits, unescape é, write 1.5, put the key "1"
    // before "2" and could match the nested key: none of that may happen.
    const before =
      '{\n' +
      '  "big": 12345678901234567890,\n' +
      '  "name": "caf\\u00e9 \\/ x",\n' +
      '  "price": 1.50,\n' +
      '  "byNumber": {"2": "b", "1": "a"},\n' +
      '  "nested": {"leftArrowOpensAgents": true},\n' +
      '  "text": "a } ] , \\" { [ inside"\n' +
      '}\n';
    const { d, path } = withFile(t, before);

    turnOff(d, path);

    assert.equal(
      readFileSync(path, 'utf8'),
      before.replace(/\n\}\n$/, ',\n  "leftArrowOpensAgents": false\n}\n'),
    );
  });
});

describe('the global config file: turnLeftArrowOff (L3), how it writes', () => {
  test('the file is replaced by a rename, mode 600, also with no umask; nothing is left beside it but the backup', (t) => {
    const { d, path } = withFile(t, JSON.stringify(sample(), null, 2));
    const inode = statSync(path).ino;
    const { keep, made } = keeper(path);

    const umask = process.umask(0);
    let result: TurnOffResult;
    try {
      result = turnLeftArrowOff(d.platform.files, d.platform.uid, path, keep);
    } finally {
      process.umask(umask);
    }

    assert.deepEqual(result, { kind: 'written', backup: made[0] });
    assert.notEqual(statSync(path).ino, inode, 'a new file, renamed over the old one');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(path), [basename(made[0] ?? '')], 'no temporary file');
  });

  test('a file of mode 644 comes out 600: it holds secrets', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    put(path, JSON.stringify(sample()), 0o644);

    turnOff(d, path);

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test('the backup is made of the exact text that is replaced, once', (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = withFile(t, before);
    const { keep, made } = keeper(path);

    turnLeftArrowOff(d.platform.files, d.platform.uid, path, keep);

    assert.equal(made.length, 1);
    assert.equal(readFileSync(made[0] ?? '', 'utf8'), before);
  });

  test('changed between the read and the rename twice: read again each time, written the third time, with both changes', (t) => {
    const { d, path } = withFile(t, JSON.stringify(sample(), null, 2));
    const { keep, made } = keeper(path);
    let changes = 0;
    const racing: Files = {
      ...d.platform.files,
      createTempBeside(target, text, mode) {
        const temp = d.platform.files.createTempBeside(target, text, mode);
        if (changes < 2) {
          changes++;
          // Another session saves the file (a new key, so a new size) while skydeck writes.
          const now = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
          put(path, JSON.stringify({ ...now, [`saved${changes}`]: changes }, null, 2));
        }
        return temp;
      },
    };

    const result = turnLeftArrowOff(racing, d.platform.uid, path, keep);

    assert.equal(result.kind, 'written');
    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(after, { ...sample(), saved1: 1, saved2: 2, [LEFT_ARROW_KEY]: false });
    assert.equal(made.length, 3, 'one backup per try');
    assert.deepEqual(
      leftovers(path),
      [basename(made[2] ?? '')],
      'only the last try keeps its backup',
    );
    assert.equal(
      readFileSync(made[2] ?? '', 'utf8'),
      JSON.stringify({ ...sample(), saved1: 1, saved2: 2 }, null, 2),
    );
  });

  test(`changed ${TURN_OFF_ATTEMPTS} times: nothing written, no temporary file and no backup left`, (t) => {
    const { d, path } = withFile(t, JSON.stringify(sample(), null, 2));
    let changes = 0;
    const racing: Files = {
      ...d.platform.files,
      createTempBeside(target, text, mode) {
        const temp = d.platform.files.createTempBeside(target, text, mode);
        changes++;
        // Each save a little longer: a change of size is seen whatever the clock's resolution.
        put(path, JSON.stringify(sample({ saved: 'x'.repeat(changes) }), null, 2));
        return temp;
      },
    };

    const result = turnOff(d, path, racing);

    assert.equal(TURN_OFF_ATTEMPTS, 3);
    assert.deepEqual(result, { kind: 'kept-changing' });
    assert.equal(changes, 3);
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(sample({ saved: 'xxx' }), null, 2));
    assert.deepEqual(leftovers(path), []);
  });

  test('a change that keeps the size and the modification time but replaces the file (a new inode) is seen', (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = withFile(t, before);
    // A whole second, which utimes can set exactly (a Date carries milliseconds only).
    utimesSync(path, WHOLE_SECOND, WHOLE_SECOND);
    let replaced = false;
    const racing: Files = {
      ...d.platform.files,
      createTempBeside(target, text, mode) {
        const temp = d.platform.files.createTempBeside(target, text, mode);
        if (!replaced) {
          replaced = true;
          const other = join(dirname(path), 'other');
          put(other, before.replace('"numStartups": 12', '"numStartups": 13'));
          utimesSync(other, WHOLE_SECOND, WHOLE_SECOND);
          renameSync(other, path);
        }
        return temp;
      },
    };

    turnOff(d, path, racing);

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(after['numStartups'], 13, 'the replacement was read again, not overwritten');
    assert.equal(after[LEFT_ARROW_KEY], false);
  });

  test('a change in place that keeps the modification time is seen by the size', (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = withFile(t, before);
    utimesSync(path, WHOLE_SECOND, WHOLE_SECOND);
    let changed = false;
    const racing: Files = {
      ...d.platform.files,
      createTempBeside(target, text, mode) {
        const temp = d.platform.files.createTempBeside(target, text, mode);
        if (!changed) {
          changed = true;
          writeFileSync(path, before.replace('"numStartups": 12', '"numStartups": 1234'));
          utimesSync(path, WHOLE_SECOND, WHOLE_SECOND);
        }
        return temp;
      },
    };

    turnOff(d, path, racing);

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(after['numStartups'], 1234);
    assert.equal(after[LEFT_ARROW_KEY], false);
  });

  test('a change in place that keeps the size is seen by the modification time', (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = withFile(t, before);
    let changed = false;
    const racing: Files = {
      ...d.platform.files,
      createTempBeside(target, text, mode) {
        const temp = d.platform.files.createTempBeside(target, text, mode);
        if (!changed) {
          changed = true;
          writeFileSync(path, before.replace('"numStartups": 12', '"numStartups": 13'));
          const later = new Date(statSync(path).mtimeMs + 5000);
          utimesSync(path, later, later);
        }
        return temp;
      },
    };

    turnOff(d, path, racing);

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(after['numStartups'], 13);
    assert.equal(after[LEFT_ARROW_KEY], false);
  });

  test('a temporary file that does not read back as the new text is never renamed over the file', (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = withFile(t, before);
    const torn: Files = {
      ...d.platform.files,
      createTempBeside(target, text, mode) {
        // A write that came out short: half of the new text.
        return d.platform.files.createTempBeside(target, text.slice(0, text.length / 2), mode);
      },
    };

    let error: unknown;
    try {
      turnOff(d, path, torn);
    } catch (caught) {
      error = caught;
    }

    assert.ok(error instanceof SkydeckError, String(error));
    assert.equal(
      error.message,
      `what skydeck wrote for ${path} did not read back as written; it was not changed`,
    );
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(leftovers(path), []);
    noCanary(error);
  });

  test('a rename that fails: an error naming the path and the code, the file as it was, nothing left beside it', (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = withFile(t, before);
    const refusing: Files = {
      ...d.platform.files,
      rename: () => {
        throw Object.assign(new Error(`EACCES: permission denied, rename '${CANARY}'`), {
          code: 'EACCES',
        });
      },
    };

    assert.throws(() => turnOff(d, path, refusing), {
      name: 'SkydeckError',
      message: `cannot write ${path} (EACCES); it was not changed`,
    });
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(leftovers(path), []);
  });

  test('a temporary file that cannot be made: the same error, nothing left', (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = withFile(t, before);
    const refusing: Files = {
      ...d.platform.files,
      createTempBeside: () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
    };

    assert.throws(() => turnOff(d, path, refusing), {
      message: `cannot write ${path} (ENOSPC); it was not changed`,
    });
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(leftovers(path), []);
  });
});

describe('the global config file: turnLeftArrowOff (L3), what it never writes', () => {
  test('a symbolic link: neither the link nor the file it points to is written', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    const target = join(d.sandbox.root, 'dotfiles.json');
    const text = JSON.stringify(sample());
    put(target, text);
    symlinkSync(target, path);

    const result = turnOff(d, path);

    assert.deepEqual(result, { kind: 'unknown', reason: 'it is a symbolic link' });
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(readFileSync(target, 'utf8'), text);
    assert.deepEqual(leftovers(path), []);
  });

  test('a read-only file (mode 400) is never written and keeps its mode', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    const text = JSON.stringify(sample());
    put(path, text, 0o400);

    const result = turnOff(d, path);

    assert.deepEqual(result, { kind: 'unknown', reason: 'it is read-only' });
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.equal(statSync(path).mode & 0o777, 0o400);
    assert.deepEqual(leftovers(path), []);
  });

  test('a file of another user', (t) => {
    const text = JSON.stringify(sample());
    const { d, path } = withFile(t, text);

    const result = turnLeftArrowOff(d.platform.files, d.platform.uid + 1, path, keeper(path).keep);

    assert.deepEqual(result, { kind: 'unknown', reason: 'it belongs to another user' });
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.deepEqual(leftovers(path), []);
  });

  test('JSON that is not an object, a file that is not JSON, a key holding anything else', (t) => {
    const cases = [
      [`["${CANARY}"]`, 'it is not a JSON object'],
      [`{"a": "${CANARY}"`, 'it is not JSON'],
      [
        JSON.stringify(sample({ [LEFT_ARROW_KEY]: 'false' })),
        'leftArrowOpensAgents is neither true nor false',
      ],
    ] as const;
    for (const [text, reason] of cases) {
      const { d, path } = withFile(t, text);

      const result = turnOff(d, path);

      assert.deepEqual(result, { kind: 'unknown', reason }, text);
      assert.equal(readFileSync(path, 'utf8'), text);
      assert.deepEqual(leftovers(path), []);
      noCanary(result);
    }
  });

  test('a file that is not UTF-8 text is never written: its bytes stay, nothing is left beside it', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);
    const bytes = Buffer.concat([
      Buffer.from('{\n  "projects": {"/home/x/caf'),
      Buffer.from([0xe9]),
      Buffer.from('": {"ok": true}},\n  "n": 1\n}\n'),
    ]);
    writeFileSync(path, bytes, { mode: 0o600 });

    const result = turnOff(d, path);

    assert.deepEqual(result, { kind: 'unknown', reason: 'it is not UTF-8 text' });
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(leftovers(path), []);
  });

  test('the key twice at the top: never written (which one Claude Code reads is not ours to guess)', (t) => {
    const text = '{"leftArrowOpensAgents": true, "a": 1, "leftArrowOpensAgents": true}';
    const { d, path } = withFile(t, text);

    const result = turnOff(d, path);

    assert.deepEqual(result, {
      kind: 'unknown',
      reason: 'leftArrowOpensAgents is in it more than once',
    });
    assert.equal(readFileSync(path, 'utf8'), text);
  });

  test('already off: nothing written, no backup', (t) => {
    const text = JSON.stringify(sample({ [LEFT_ARROW_KEY]: false }));
    const { d, path } = withFile(t, text);
    const inode = statSync(path).ino;

    const result = turnOff(d, path);

    assert.deepEqual(result, { kind: 'off' });
    assert.equal(statSync(path).ino, inode);
    assert.deepEqual(leftovers(path), []);
  });

  test('no file: nothing is created', (t) => {
    const d = testPlatform(t);
    const path = configFile(d);

    const result = turnOff(d, path);

    assert.deepEqual(result, { kind: 'unknown', reason: 'it does not exist' });
    assert.deepEqual(leftovers(path), []);
  });

  test('a file that became a symbolic link between two tries is not written', (t) => {
    const { d, path } = withFile(t, JSON.stringify(sample()));
    const target = join(d.sandbox.root, 'dotfiles.json');
    let swapped = false;
    const racing: Files = {
      ...d.platform.files,
      createTempBeside(file, text, mode) {
        const temp = d.platform.files.createTempBeside(file, text, mode);
        if (!swapped) {
          swapped = true;
          renameSync(path, target);
          symlinkSync(target, path);
        }
        return temp;
      },
    };

    const result = turnOff(d, path, racing);

    assert.deepEqual(result, { kind: 'unknown', reason: 'it is a symbolic link' });
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), sample());
    assert.deepEqual(leftovers(path), []);
  });
});
