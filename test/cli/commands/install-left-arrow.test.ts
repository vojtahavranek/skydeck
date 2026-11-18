// `skydeck install`'s last step (follow-up F11, S2 7.9): it offers to turn off Claude Code's ←
// shortcut in Claude Code's global config file. Every file is a made-up one in the sandbox (here
// `<claudeHome>/.claude.json`, since the sandbox sets CLAUDE_CONFIG_DIR): nothing reads or writes
// the real ~/.claude.json. The fixture holds CANARY where a real one keeps secrets; no output of
// install may contain it.
import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { Files, Platform } from '../../../src/platform/types.ts';
import { capture } from '../../helpers/capture.ts';
import { run, settingsFile, transcript } from '../../helpers/install.ts';
import type { Run } from '../../helpers/install.ts';
import { S1, T0, testPlatform } from '../../helpers/platform.ts';
import type { TestPlatform } from '../../helpers/platform.ts';

const CANARY = 'canary-7c4d9e21';
const KEY = 'leftArrowOpensAgents';
const QUESTION = 'Turn the shortcut off? [y/N] ';
const HOW = '/config in Claude Code ("← opens agents")';

/** A made-up global config: account details and an MCP server's token, each holding CANARY. */
function sample(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numStartups: 3,
    oauthAccount: { emailAddress: `${CANARY}@example.invalid`, accountUuid: CANARY },
    mcpServers: { tickets: { command: 'tickets-mcp', env: { TICKETS_TOKEN: CANARY } } },
    ...extra,
  };
}

function put(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}

/** The three lines before the question, for the file at `path`. */
function preamble(path: string): string {
  return (
    "Claude Code's ← shortcut is on: ← on an empty prompt sends the session to the background and opens agent view.\n" +
    "← also closes a group in skydeck's list, so a ← meant for the list can send a window terminal's session away.\n" +
    `Turning it off sets only ${KEY} in ${path}, after a backup; agent view itself stays (claude agents, /bg).\n`
  );
}

const unknownLine = (path: string, reason: string): string =>
  `Claude Code's ← shortcut: left ${path} alone (${reason}); to turn it off: ${HOW}`;
const LATER = `the ← shortcut stays on; to turn it off later: ${HOW}, or skydeck install again`;
const OFF = "Claude Code's ← shortcut is off";
const FROM_NOW_ON =
  'the shortcut is off for sessions started from now on; a session already running keeps it until it is started again';

/** The backup install makes at T0 (the test clock's start). */
const backupOf = (path: string): string => `${path}.skydeck-backup-20261112T090000Z`;

/** Every name beside the file that holds its name: backups and temporary files. */
function leftovers(path: string): string[] {
  return readdirSync(dirname(path)).filter(
    (name) => name !== basename(path) && name.includes(basename(path)),
  );
}

const linesOf = (text: string): string[] => text.split('\n').filter((line) => line !== '');

function noCanary(r: Run): void {
  for (const text of [r.stdout, r.stderr, ...r.prompts]) {
    assert.ok(!text.includes(CANARY), `a value of the file reached the output:\n${text}`);
  }
}

/** A sandboxed platform whose global config file holds `text`, or none when `text` is null. */
function machine(
  t: Parameters<typeof testPlatform>[0],
  text: string | null,
): { d: TestPlatform; path: string } {
  const d = testPlatform(t);
  const path = d.places.claudeGlobalConfig;
  if (text !== null) {
    put(path, text);
  }
  return { d, path };
}

describe('install: the ← shortcut, when it is on (L2)', () => {
  test('the answer y: three lines, the question, the key turned off, the backup named, then "from now on"', async (t) => {
    const before = JSON.stringify(sample(), null, 2) + '\n';
    const { d, path } = machine(t, before);

    const r = await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, ['Add them? [y/N] ', QUESTION]);
    assert.ok(r.stderr.endsWith(`${preamble(path)}${QUESTION}`), r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...sample(), [KEY]: false });
    assert.equal(readFileSync(backupOf(path), 'utf8'), before);
    assert.equal(statSync(backupOf(path)).mode & 0o777, 0o600);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(path), [basename(backupOf(path))]);
    assert.ok(
      r.stdout.endsWith(
        `turned Claude Code's ← shortcut off in ${path}; the file as it was is kept in ${backupOf(path)}\n` +
          `${FROM_NOW_ON}\n` +
          'skydeck is installed\n',
      ),
      r.stdout,
    );
    noCanary(r);
  });

  test('the key true is on as well, and is turned off where it is, not at the first true of the file', async (t) => {
    const head = `{\n  "hasCompletedOnboarding": true,\n  "projects": {"/p": {"${KEY}": true}},\n`;
    const { d, path } = machine(t, `${head}  "${KEY}": true,\n  "z": "${CANARY}"\n}\n`);

    const r = await run(d.platform, ['install'], { lines: ['y', 'yes'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(path, 'utf8'), `${head}  "${KEY}": false,\n  "z": "${CANARY}"\n}\n`);
    noCanary(r);
  });

  for (const [why, lines] of [
    ['the answer n', ['y', 'n']],
    ['an empty answer', ['y', '']],
    ['no answer (no person to ask)', ['y']],
  ] as const) {
    test(`${why}: one line on how to do it later; the file untouched; exit 0`, async (t) => {
      const before = JSON.stringify(sample(), null, 2);
      const { d, path } = machine(t, before);
      const inode = statSync(path).ino;

      const r = await run(d.platform, ['install'], { lines });

      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.prompts, ['Add them? [y/N] ', QUESTION]);
      assert.ok(r.stdout.endsWith(`${LATER}\nskydeck is installed\n`), r.stdout);
      assert.equal(readFileSync(path, 'utf8'), before);
      assert.equal(statSync(path).ino, inode);
      assert.deepEqual(leftovers(path), []);
      noCanary(r);
    });
  }

  test('a second install after the yes: the "off" line and no question', async (t) => {
    const { d, path } = machine(t, JSON.stringify(sample()));
    await run(d.platform, ['install'], { lines: ['y', 'y'] });
    const after = readFileSync(path, 'utf8');

    const r = await run(d.platform, ['install']);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, []);
    assert.ok(r.stdout.endsWith(`${OFF}\nskydeck is installed\n`), r.stdout);
    assert.equal(readFileSync(path, 'utf8'), after);
    assert.deepEqual(leftovers(path), [basename(backupOf(path))], 'no second backup');
  });

  test('the question comes after the first-run offer and before "skydeck is installed"', async (t) => {
    const { d } = machine(t, JSON.stringify(sample()));
    transcript(d.places, S1, T0 - 10n * NS_PER_DAY);

    const r = await run(d.platform, ['install'], { lines: ['y', 'n', 'n'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, [
      'Add them? [y/N] ',
      'Mark 1 session older than 7 days as done? [y/N] ',
      QUESTION,
    ]);
    assert.equal(linesOf(r.stdout).at(-1), 'skydeck is installed');
  });

  test('the file changed while skydeck wrote it, three times: the line naming /config; exit 0; the file as the other writer left it', async (t) => {
    const { d, path } = machine(t, JSON.stringify(sample()));
    const real = d.platform.files;
    let saves = 0;
    const files: Files = {
      ...real,
      createTempBeside(target, text, mode) {
        const temp = real.createTempBeside(target, text, mode);
        saves++;
        put(path, JSON.stringify(sample({ saved: 'x'.repeat(saves) })));
        return temp;
      },
    };

    const r = await run({ ...d.platform, files }, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.stdout.endsWith(
        `${path} kept changing while skydeck wrote it, so skydeck left it as it is; ` +
          `to turn the ← shortcut off: ${HOW}\nskydeck is installed\n`,
      ),
      r.stdout,
    );
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), sample({ saved: 'xxx' }));
    assert.deepEqual(leftovers(path), []);
    noCanary(r);
  });
});

describe('install: the ← shortcut, when it is off or cannot be told (L2)', () => {
  test('off: one short line, no question, the file untouched', async (t) => {
    const before = JSON.stringify(sample({ [KEY]: false }));
    const { d, path } = machine(t, before);
    const inode = statSync(path).ino;

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, ['Add them? [y/N] ']);
    assert.ok(r.stdout.endsWith(`${OFF}\nskydeck is installed\n`), r.stdout);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(statSync(path).ino, inode);
    assert.deepEqual(leftovers(path), []);
  });

  test('no file: one line naming the path, no question, nothing created', async (t) => {
    const { d, path } = machine(t, null);

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, ['Add them? [y/N] ']);
    assert.ok(
      r.stdout.endsWith(`${unknownLine(path, 'it does not exist')}\nskydeck is installed\n`),
      r.stdout,
    );
    assert.throws(() => lstatSync(path), { code: 'ENOENT' });
    assert.deepEqual(leftovers(path), []);
  });

  for (const [why, text, reason] of [
    ['not JSON', `{"oauthAccount": {"token": "${CANARY}"`, 'it is not JSON'],
    ['a JSON array', `["${CANARY}"]`, 'it is not a JSON object'],
    [
      'the key holding a string',
      JSON.stringify(sample({ [KEY]: 'no' })),
      `${KEY} is neither true nor false`,
    ],
  ] as const) {
    test(`${why}: the line naming the path and why, no question, the file untouched, no value shown`, async (t) => {
      const { d, path } = machine(t, text);

      const r = await run(d.platform, ['install'], { lines: ['y'] });

      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.prompts, ['Add them? [y/N] ']);
      assert.ok(
        r.stdout.endsWith(`${unknownLine(path, reason)}\nskydeck is installed\n`),
        r.stdout,
      );
      assert.equal(readFileSync(path, 'utf8'), text);
      assert.deepEqual(leftovers(path), []);
      noCanary(r);
    });
  }

  test('a symbolic link: the line, no question, neither the link nor its target written', async (t) => {
    const { d, path } = machine(t, null);
    const target = join(d.sandbox.root, 'dotfiles-claude.json');
    const text = JSON.stringify(sample());
    put(target, text);
    symlinkSync(target, path);

    const r = await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, ['Add them? [y/N] ']);
    assert.ok(
      r.stdout.endsWith(`${unknownLine(path, 'it is a symbolic link')}\nskydeck is installed\n`),
      r.stdout,
    );
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(readFileSync(target, 'utf8'), text);
  });
});

describe('install: the ← step never changes what install did (L2)', () => {
  test('a no to the hook entries: install stops as before, and the ← step does not run', async (t) => {
    const before = JSON.stringify(sample());
    const { d, path } = machine(t, before);

    const r = await run(d.platform, ['install'], { lines: ['n', 'y'] });

    assert.equal(r.code, 1);
    assert.deepEqual(r.prompts, ['Add them? [y/N] ']);
    assert.ok(!r.stdout.includes('←') && !r.stderr.includes('←'), r.stdout + r.stderr);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('an install that refuses (a file where a link goes): the ← step does not run', async (t) => {
    const before = JSON.stringify(sample());
    const { d, path } = machine(t, before);
    mkdirSync(dirname(d.places.binLink), { recursive: true });
    writeFileSync(d.places.binLink, 'not a link');

    const r = await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 1);
    assert.ok(!r.stdout.includes('←') && !r.stderr.includes('←'), r.stdout + r.stderr);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('a write of the file that fails: one line on stderr, the file as it was, install still succeeds', async (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = machine(t, before);
    const real = d.platform.files;
    const files: Files = {
      ...real,
      rename(from, to) {
        if (to === path) {
          throw Object.assign(new Error(`EACCES: permission denied, rename '${from}'`), {
            code: 'EACCES',
          });
        }
        real.rename(from, to);
      },
    };
    const platform: Platform = { ...d.platform, files };

    const r = await run(platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.stderr.endsWith(
        `${QUESTION}could not turn Claude Code's ← shortcut off: cannot write ${path} (EACCES); ` +
          `it was not changed; to turn it off: ${HOW}\n`,
      ),
      r.stderr,
    );
    assert.ok(r.stdout.endsWith('skydeck is installed\n'), r.stdout);
    assert.ok(lstatSync(settingsFile(d.places)).isFile(), 'the hook entries were written');
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(leftovers(path), []);
    noCanary(r);
  });

  test('a step that throws anything at all: one line, install still succeeds', async (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = machine(t, before);
    const real = d.platform.files;
    const files: Files = {
      ...real,
      createTempBeside() {
        throw new TypeError(`something unforeseen with ${CANARY}`);
      },
    };

    const r = await run({ ...d.platform, files }, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.stderr.endsWith(
        `${QUESTION}could not turn Claude Code's ← shortcut off: cannot write ${path} (TypeError); ` +
          `it was not changed; to turn it off: ${HOW}\n`,
      ),
      r.stderr,
    );
    assert.ok(r.stdout.endsWith('skydeck is installed\n'), r.stdout);
    assert.equal(readFileSync(path, 'utf8'), before);
    noCanary(r);
  });
});

describe("install: the ← step's lines are sanitized (the path comes from CLAUDE_CONFIG_DIR or claudeHome)", () => {
  const RAW = /[\u001b\u009b]/;
  for (const [why, text, lines] of [
    ['on, then n', JSON.stringify(sample()), ['y', 'n']],
    ['on, then y', JSON.stringify(sample()), ['y', 'y']],
    ['unknown (no file)', null, ['y']],
    ['on, then y, and the write fails (the line on stderr)', JSON.stringify(sample()), ['y', 'y']],
  ] as const) {
    test(`${why}: no raw ESC or C1 control reaches the terminal`, async (t) => {
      const d = testPlatform(t, {
        env: (s) => ({ CLAUDE_CONFIG_DIR: join(s.root, 'cc\u001b[2J\u009bx') }),
      });
      mkdirSync(d.places.claudeHome);
      if (text !== null) {
        put(d.places.claudeGlobalConfig, text);
      }
      const real = d.platform.files;
      const files: Files = why.includes('fails')
        ? {
            ...real,
            rename(from, to) {
              if (to === d.places.claudeGlobalConfig) {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
              }
              real.rename(from, to);
            },
          }
        : real;

      const r = await run({ ...d.platform, files }, ['install'], { lines });
      if (why.includes('fails')) {
        assert.match(r.stderr, /could not turn Claude Code's ← shortcut off: cannot write /);
      }

      assert.equal(r.code, 0, r.stderr);
      assert.ok((r.stdout + r.stderr).includes('.claude.json'), 'the step named the file');
      for (const out of [r.stdout, r.stderr]) {
        assert.ok(!RAW.test(out), JSON.stringify(out));
      }
    });
  }
});

describe('install: an error of the ← step that is no write (review 2, C6)', () => {
  test('the question cannot be read: one line that claims no write, install still succeeds, the file as it was', async (t) => {
    const before = JSON.stringify(sample(), null, 2);
    const { d, path } = machine(t, before);
    const captured = capture({ lines: ['y'] });
    const io = {
      ...captured.io,
      readLine: (prompt: string) =>
        prompt === QUESTION
          ? Promise.reject(new TypeError(`stdin went away near ${CANARY}`))
          : captured.io.readLine(prompt),
    };

    const code = await main(['install'], { io, platform: d.platform });

    assert.equal(code, 0, captured.stderr());
    assert.ok(
      captured
        .stderr()
        .endsWith(
          "could not turn Claude Code's ← shortcut off: an unexpected error (TypeError); " +
            `skydeck doctor says whether it is off; to turn it off: ${HOW}\n`,
        ),
      captured.stderr(),
    );
    assert.ok(captured.stdout().endsWith('skydeck is installed\n'), captured.stdout());
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.ok(!(captured.stdout() + captured.stderr()).includes(CANARY));
  });
});

describe('install: where the global config file is (L1)', () => {
  test('without CLAUDE_CONFIG_DIR: ~/.claude.json, beside ~/.claude', async (t) => {
    const d = testPlatform(t, { env: { CLAUDE_CONFIG_DIR: undefined } });
    mkdirSync(join(d.sandbox.home, '.claude'));
    const path = join(d.sandbox.home, '.claude.json');
    assert.equal(d.places.claudeGlobalConfig, path);
    put(path, JSON.stringify(sample()));

    const r = await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.includes(preamble(path)), r.stderr);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)[KEY], false);
    assert.deepEqual(
      readdirSync(d.sandbox.claudeHome),
      [],
      'nothing in the sandbox CLAUDE_CONFIG_DIR',
    );
  });

  test('with CLAUDE_CONFIG_DIR: the .claude.json inside it; ~/.claude.json is not looked at', async (t) => {
    const { d, path } = machine(t, JSON.stringify(sample()));
    assert.equal(path, join(d.sandbox.claudeHome, '.claude.json'));
    const home = join(d.sandbox.home, '.claude.json');
    put(home, JSON.stringify(sample()));

    await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)[KEY], false);
    assert.deepEqual(JSON.parse(readFileSync(home, 'utf8')), sample());
  });
});
