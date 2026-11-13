import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { command } from '../../../src/cli/commands/install.ts';
import { main } from '../../../src/cli/main.ts';
import { hookEntry } from '../../../src/claude/settings.ts';
import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { Files } from '../../../src/platform/types.ts';
import { capture } from '../../helpers/capture.ts';
import {
  backupAtT0,
  backups,
  run,
  settingsFile,
  transcript,
  withStore,
} from '../../helpers/install.ts';
import { S1, S2, S3, SEC, T0, statLine, testPlatform } from '../../helpers/platform.ts';
import type { TestPlatform } from '../../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../../helpers/spool.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The two entries install adds, as `hooks` holds them in a file that had none. */
function ourHooks(d: TestPlatform): Record<string, unknown> {
  return {
    SessionStart: [hookEntry(d.places.hookPath, 'SessionStart')],
    SessionEnd: [hookEntry(d.places.hookPath, 'SessionEnd')],
  };
}

const kv = (d: TestPlatform, key: 'settings_hash' | 'settings_backup' | 'first_run_offered') =>
  withStore(d.places, (store) => store.getKv(key));

const backupOf = (d: TestPlatform): string => backupAtT0(d.places);

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** A refusal left nothing behind: no skydeck directory, database or link of its own. */
function nothingCreated(d: TestPlatform): void {
  assert.deepEqual(readdirSync(d.sandbox.skydeckHome), []);
  assert.equal(exists(d.places.hookPath), false);
  assert.equal(exists(d.places.nodeLink), false);
}

describe('install: links and hook entries', () => {
  test('with no settings file and the answer y: the three links, the two entries, backup "none" and the hash', async (t) => {
    const d = testPlatform(t);

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readlinkSync(d.places.hookPath), join(d.platform.appRoot, 'bin', 'skydeck-hook'));
    assert.equal(readlinkSync(d.places.binLink), join(d.platform.appRoot, 'bin', 'skydeck'));
    assert.equal(readlinkSync(d.places.nodeLink), process.execPath);
    const text = readFileSync(settingsFile(d.places), 'utf8');
    assert.deepEqual(JSON.parse(text), { hooks: ourHooks(d) });
    assert.equal(kv(d, 'settings_backup'), 'none');
    assert.equal(kv(d, 'settings_hash'), sha256(text));
    assert.deepEqual(backups(d.places), []);
    assert.ok(r.prompts.includes('Add them? [y/N] '));
    const header = `skydeck will add these hook entries to ${settingsFile(d.places)}:\n`;
    const announced = r.stderr.indexOf(header);
    const prompt = r.stderr.indexOf('Add them? [y/N] ');
    assert.ok(announced >= 0 && announced < prompt, r.stderr);
    // Between the two: exactly the added groups, by event, as JSON.
    const shown = r.stderr.slice(announced + header.length, prompt);
    assert.deepEqual(JSON.parse(shown), ourHooks(d));
  });

  test('a hook path with a character a terminal acts on is shown escaped, not changed', async (t) => {
    const d = testPlatform(t, { env: (s) => ({ SKYDECK_HOME: join(s.root, 'deck\u009b') }) });

    const r = await run(d.platform, ['install'], { lines: ['n'] });

    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('deck\\u009b'), r.stderr);
    assert.ok(!r.stderr.includes('\u009b'), 'no raw C1 control reaches the terminal');
  });

  test('over an existing file: a backup of it, the old keys kept and both entries added', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
    const text = readFileSync(settingsFile(d.places), 'utf8');
    assert.deepEqual(JSON.parse(text), { model: 'opus', hooks: ourHooks(d) });
    assert.equal(kv(d, 'settings_backup'), backupOf(d));
    assert.equal(kv(d, 'settings_hash'), sha256(text));
  });

  test('the backup is readable by the user only, whatever the mode of the settings file', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"env":{"TOKEN":"x"}}');
    chmodSync(settingsFile(d.places), 0o644); // the usual mode, whatever the umask
    // With no umask, a backup made without its own mode would come out 0666 on any machine.
    const umask = process.umask(0);
    try {
      await run(d.platform, ['install'], { lines: ['y'] });
    } finally {
      process.umask(umask);
    }

    assert.equal(statSync(backupOf(d)).mode & 0o777, 0o600);
  });

  for (const [why, lines] of [
    ['the answer n', ['n']],
    ['no answer (no terminal)', []],
  ] as const) {
    test(`${why}: exit 1, settings not changed, nothing created`, async (t) => {
      const d = testPlatform(t);
      writeFileSync(settingsFile(d.places), '{"model":"opus"}');

      const r = await run(d.platform, ['install'], { lines });

      assert.equal(r.code, 1);
      assert.ok(r.stderr.endsWith('Add them? [y/N] settings not changed\n'), r.stderr);
      assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":"opus"}');
      assert.deepEqual(backups(d.places), []);
      nothingCreated(d);
      assert.equal(exists(d.places.binLink), false);
    });
  }

  test('"yes" and " Y " count as yes', async (t) => {
    for (const answer of ['yes', ' Y ']) {
      const d = testPlatform(t);
      const r = await run(d.platform, ['install'], { lines: [answer] });
      assert.equal(r.code, 0, `${answer}: ${r.stderr}`);
      assert.ok(existsSync(settingsFile(d.places)));
    }
  });

  test('installing twice changes nothing the second time and asks nothing about hooks', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');
    await run(d.platform, ['install'], { lines: ['y'] });
    const settingsBefore = statSync(settingsFile(d.places));
    const textBefore = readFileSync(settingsFile(d.places), 'utf8');
    const hashBefore = kv(d, 'settings_hash');
    const links = [d.places.hookPath, d.places.binLink, d.places.nodeLink];
    const linksBefore = links.map((link) => lstatSync(link).ino);

    const r = await run(d.platform, ['install']);

    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.prompts.some((prompt) => prompt.startsWith('Add them?')));
    assert.match(r.stdout + r.stderr, /hook entries already present/);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), textBefore);
    assert.equal(statSync(settingsFile(d.places)).ino, settingsBefore.ino);
    assert.equal(statSync(settingsFile(d.places)).mtimeMs, settingsBefore.mtimeMs);
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
    assert.deepEqual(backups(d.places), [backupOf(d)], 'no second backup');
    assert.equal(kv(d, 'settings_hash'), hashBefore);
    assert.equal(kv(d, 'settings_backup'), backupOf(d));
    assert.deepEqual(
      links.map((link) => lstatSync(link).ino),
      linksBefore,
    );
  });

  test('hook entries that belong to something else survive install', async (t) => {
    const d = testPlatform(t);
    const foreignStart = { hooks: [{ type: 'command', command: '/opt/other/hook start' }] };
    const foreignTool = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo checked', timeout: 3 }],
    };
    writeFileSync(
      settingsFile(d.places),
      JSON.stringify({ hooks: { SessionStart: [foreignStart], PreToolUse: [foreignTool] } }),
    );

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    const settings = JSON.parse(readFileSync(settingsFile(d.places), 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    assert.deepEqual(settings.hooks, {
      SessionStart: [foreignStart, hookEntry(d.places.hookPath, 'SessionStart')],
      PreToolUse: [foreignTool],
      SessionEnd: [hookEntry(d.places.hookPath, 'SessionEnd')],
    });
  });

  test('a settings file that is a symbolic link stays one; the file it points to gets the entries', async (t) => {
    const d = testPlatform(t);
    const dotfiles = join(d.sandbox.root, 'dotfiles');
    mkdirSync(dotfiles);
    const real = join(dotfiles, 'claude-settings.json');
    writeFileSync(real, '{"model":"opus"}');
    symlinkSync(real, settingsFile(d.places));

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readlinkSync(settingsFile(d.places)), real);
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), {
      model: 'opus',
      hooks: ourHooks(d),
    });
  });

  test('a settings file that is not JSON: exit 1, nothing written to it, nothing created', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"model":');

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /settings\.json is not valid JSON/);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":');
    assert.deepEqual(backups(d.places), []);
    nothingCreated(d);
  });

  test('a Claude Code directory that does not exist is not created: exit 1 naming it, nothing created', async (t) => {
    const d = testPlatform(t, { env: (s) => ({ CLAUDE_CONFIG_DIR: join(s.root, 'no-claude') }) });

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /no-claude/);
    assert.equal(existsSync(join(d.sandbox.root, 'no-claude')), false);
    nothingCreated(d);
    assert.equal(exists(d.places.binLink), false);
  });

  test('a file that is not a symbolic link where a link goes is left alone: exit 1, nothing created', async (t) => {
    const d = testPlatform(t);
    mkdirSync(join(d.sandbox.home, '.local', 'bin'), { recursive: true });
    writeFileSync(d.places.binLink, '#!/bin/sh\necho mine\n');

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a symbolic link/);
    assert.equal(readFileSync(d.places.binLink, 'utf8'), '#!/bin/sh\necho mine\n');
    assert.equal(existsSync(settingsFile(d.places)), false);
    nothingCreated(d);
  });

  test('a settings path that is a symbolic link to nothing is refused, naming the link and its target', async (t) => {
    const d = testPlatform(t);
    const target = join(d.sandbox.root, 'dotfiles', 'claude-settings.json');
    symlinkSync(target, settingsFile(d.places));

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(settingsFile(d.places)), r.stderr);
    assert.ok(r.stderr.includes(target), r.stderr);
    assert.equal(readlinkSync(settingsFile(d.places)), target);
    assert.deepEqual(r.prompts, []);
    nothingCreated(d);
  });

  test('a settings file changed while the question was open: exit 1, the change kept, nothing written or created', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');
    const captured = capture({ lines: ['y'] });
    const io = {
      ...captured.io,
      readLine: (prompt: string) => {
        // The user saves the file (or another session's /model does) before answering.
        writeFileSync(settingsFile(d.places), '{"model":"sonnet","theme":"dark"}');
        return captured.io.readLine(prompt);
      },
    };

    const code = await main(['install'], { io, platform: d.platform });

    assert.equal(code, 1);
    assert.match(captured.stderr(), /settings\.json changed while the question was open/);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":"sonnet","theme":"dark"}');
    assert.deepEqual(backups(d.places), []);
    nothingCreated(d);
  });

  test('a settings file changed after the answer, before the write: still never written over', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');
    const real = d.platform.files;
    const files: Files = {
      ...real,
      symlink(target: string, path: string): void {
        // Saved by someone else while install makes its links, after the user said yes.
        writeFileSync(settingsFile(d.places), '{"model":"sonnet"}');
        real.symlink(target, path);
      },
    };

    const r = await run({ ...d.platform, files }, ['install'], { lines: ['y'] });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /changed while the question was open/);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":"sonnet"}');
    assert.deepEqual(backups(d.places), []);
  });

  test('a file that appears at a link path while the question is open is not replaced', async (t) => {
    const d = testPlatform(t);
    const captured = capture({ lines: ['y'] });
    const io = {
      ...captured.io,
      readLine: (prompt: string) => {
        mkdirSync(join(d.sandbox.home, '.local', 'bin'), { recursive: true });
        writeFileSync(d.places.binLink, 'mine');
        return captured.io.readLine(prompt);
      },
    };

    const code = await main(['install'], { io, platform: d.platform });

    assert.equal(code, 1);
    assert.match(captured.stderr(), /not a symbolic link/);
    assert.equal(readFileSync(d.places.binLink, 'utf8'), 'mine');
    assert.equal(existsSync(settingsFile(d.places)), false);
  });

  test('a settings file that cannot be written: a plain error naming it, and no backup left behind', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');
    const real = d.platform.files;
    const files: Files = {
      ...real,
      writeText(path: string, text: string, mode?: number): void {
        if (path === settingsFile(d.places)) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        real.writeText(path, text, mode);
      },
    };

    for (const attempt of [1, 2]) {
      const r = await run({ ...d.platform, files }, ['install'], { lines: ['y'] });
      assert.equal(r.code, 1, `attempt ${attempt}`);
      assert.match(r.stderr, /cannot write .*settings\.json \(EACCES\); it was not changed/);
      assert.doesNotMatch(r.stderr, /internal error/);
    }
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":"opus"}');
    assert.deepEqual(backups(d.places), []);
    withStore(d.places, (store) => assert.equal(store.getKv('settings_hash'), null));
  });

  test('a link that cannot be made: a plain error naming it', async (t) => {
    const d = testPlatform(t);
    const real = d.platform.files;
    const files: Files = {
      ...real,
      symlink(target: string, path: string): void {
        if (path === d.places.binLink) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        real.symlink(target, path);
      },
    };

    const r = await run({ ...d.platform, files }, ['install'], { lines: ['y'] });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot create the link .*\.local\/bin\/skydeck \(EACCES\)/);
    assert.doesNotMatch(r.stderr, /internal error/);
    assert.equal(existsSync(settingsFile(d.places)), false);
  });

  test('a symbolic link from an earlier checkout is pointed at this one', async (t) => {
    const d = testPlatform(t);
    mkdirSync(join(d.sandbox.home, '.local', 'bin'), { recursive: true });
    symlinkSync('/old/checkout/bin/skydeck', d.places.binLink);

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readlinkSync(d.places.binLink), join(d.platform.appRoot, 'bin', 'skydeck'));
  });

  test('older backups are left byte-identical; a new one, named for now, holds the current file', async (t) => {
    const d = testPlatform(t);
    const older = `${settingsFile(d.places)}.skydeck-backup-20250101T000000Z`;
    writeFileSync(older, '{"model":"haiku"}');
    writeFileSync(settingsFile(d.places), '{"model":"opus","theme":"dark"}');

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(older, 'utf8'), '{"model":"haiku"}');
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus","theme":"dark"}');
    assert.deepEqual(backups(d.places), [older, backupOf(d)]);
    assert.equal(kv(d, 'settings_backup'), backupOf(d));
    assert.equal(kv(d, 'settings_hash'), sha256(readFileSync(settingsFile(d.places), 'utf8')));
  });

  test('a backup name that is taken gets -2, then -3; the files there are not touched', async (t) => {
    const d = testPlatform(t);
    writeFileSync(backupOf(d), 'first');
    writeFileSync(`${backupOf(d)}-2`, 'second');
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(backupOf(d), 'utf8'), 'first');
    assert.equal(readFileSync(`${backupOf(d)}-2`, 'utf8'), 'second');
    assert.equal(readFileSync(`${backupOf(d)}-3`, 'utf8'), '{"model":"opus"}');
    assert.equal(kv(d, 'settings_backup'), `${backupOf(d)}-3`);
  });

  test('an install that changes the file again writes another backup and records it', async (t) => {
    const d = testPlatform(t);
    writeFileSync(settingsFile(d.places), '{"model":"opus"}');
    await run(d.platform, ['install'], { lines: ['y'] });
    // The user takes skydeck's entries out by hand and changes a setting; an hour later, install.
    writeFileSync(settingsFile(d.places), '{"model":"sonnet"}');
    d.clock.setNs(T0 + 3600n * SEC);

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    const later = `${settingsFile(d.places)}.skydeck-backup-20261112T100000Z`;
    assert.deepEqual(backups(d.places), [backupOf(d), later]);
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
    assert.equal(readFileSync(later, 'utf8'), '{"model":"sonnet"}');
    assert.equal(kv(d, 'settings_backup'), later);
    assert.equal(kv(d, 'settings_hash'), sha256(readFileSync(settingsFile(d.places), 'utf8')));
  });

  test('a spool file written before install is ingested by it', async (t) => {
    const d = testPlatform(t);
    mkdirSync(d.places.spoolDir, { recursive: true });
    const fields = {
      event: 'SessionStart' as const,
      timeNs: T0 - 20n * SEC,
      pid: 4242,
      input: hookInput('SessionStart', S1, { source: 'startup' }),
    };
    writeFileSync(join(d.places.spoolDir, spoolName(fields, 1)), spoolText(fields));

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      withStore(d.places, (store) => store.events().map((event) => event.sessionId)),
      [S1],
    );
  });
});

describe('install: the first-run offer', () => {
  const OLD = T0 - 10n * NS_PER_DAY;
  const RECENT = T0 - 2n * NS_PER_DAY;

  const doneOf = (d: TestPlatform): Record<string, bigint | null> =>
    withStore(d.places, (store) =>
      Object.fromEntries(store.allMeta().map((meta) => [meta.sessionId, meta.doneAtNs])),
    );

  test('two sessions older than seven days, one younger, answer y: the two are done', async (t) => {
    const d = testPlatform(t);
    transcript(d.places, S1, OLD);
    transcript(d.places, S2, OLD);
    transcript(d.places, S3, RECENT);

    const r = await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, [
      'Add them? [y/N] ',
      'Mark 2 sessions older than 7 days as done? [y/N] ',
    ]);
    assert.deepEqual(doneOf(d), { [S1]: T0, [S2]: T0 });
    assert.equal(kv(d, 'first_run_offered'), '1');

    const again = await run(d.platform, ['install']);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.prompts, []);
  });

  test('answer n: nothing is done, and the offer is not made again', async (t) => {
    const d = testPlatform(t);
    transcript(d.places, S1, OLD);

    const r = await run(d.platform, ['install'], { lines: ['y', 'n'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, [
      'Add them? [y/N] ',
      'Mark 1 session older than 7 days as done? [y/N] ',
    ]);
    assert.deepEqual(doneOf(d), {});
    assert.equal(kv(d, 'first_run_offered'), '1');
    assert.deepEqual((await run(d.platform, ['install'])).prompts, []);
  });

  test('no old sessions: no question, and the flag is still set', async (t) => {
    const d = testPlatform(t);
    transcript(d.places, S1, RECENT);

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.prompts, ['Add them? [y/N] ']);
    assert.equal(kv(d, 'first_run_offered'), '1');
  });

  test('a running session and one that is not listed are not offered', async (t) => {
    const d = testPlatform(t);
    // S1: an old start by a process that is still alive (running), its transcript old too.
    mkdirSync(d.places.spoolDir, { recursive: true });
    const fields = {
      event: 'SessionStart' as const,
      timeNs: OLD,
      pid: 4242,
      input: hookInput('SessionStart', S1, { source: 'startup' }),
    };
    writeFileSync(join(d.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
    d.proc.setProcess(4242, { stat: statLine(4242, 51234567), cmdline: ['claude'] });
    transcript(d.places, S1, OLD);
    // S2: an old transcript of another entry point (never listed).
    transcript(d.places, S2, OLD, 'sdk-cli');
    // S3: the one that counts.
    transcript(d.places, S3, OLD);

    const r = await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.prompts.includes('Mark 1 session older than 7 days as done? [y/N] '));
    assert.deepEqual(doneOf(d), { [S3]: T0 });
  });

  test('the age comes from firstRunDoneAfterDays', async (t) => {
    const d = testPlatform(t);
    mkdirSync(d.places.configDir, { recursive: true });
    writeFileSync(d.places.configPath, '{"firstRunDoneAfterDays":1}');
    transcript(d.places, S1, RECENT);

    const r = await run(d.platform, ['install'], { lines: ['y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.prompts.includes('Mark 1 session older than 1 day as done? [y/N] '));
  });
});

describe('install: arguments', () => {
  test('--help prints the usage and exits 0', async (t) => {
    const d = testPlatform(t);
    const r = await run(d.platform, ['install', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^skydeck install\n/);
    assert.equal(existsSync(d.places.dbPath), false);
  });

  test('an argument is a usage error: exit 2, nothing created', async (t) => {
    const d = testPlatform(t);
    const r = await run(d.platform, ['install', 'now']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /skydeck install/);
    assert.equal(existsSync(d.places.dbPath), false);
  });

  test('name and summary are those of the plan', () => {
    assert.equal(command.name, 'install');
    assert.equal(command.summary, 'Install the hooks and links');
  });
});
