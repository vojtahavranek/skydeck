// What `skydeck install` prints, as a person reads it in a terminal (design 8): both streams in the
// order they were written. Sections with a heading, a blank line before each but the first and
// their explanation indented; each question on its own `> ` line after a blank line; short results
// lined up under it; the summary of what changed, `skydeck is installed` and Next. Colour only on a
// terminal, around text that is already sanitised.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { Io } from '../../../src/cli/context.ts';
import { main } from '../../../src/cli/main.ts';
import { hookCommand } from '../../../src/claude/settings.ts';
import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { Platform } from '../../../src/platform/types.ts';
import { capture } from '../../helpers/capture.ts';
import type { CaptureOptions } from '../../helpers/capture.ts';
import { backupAtT0, installedTail, settingsFile, transcript } from '../../helpers/install.ts';
import { S1, S2, T0, fakeRunner, runResult, testPlatform } from '../../helpers/platform.ts';
import type { TestPlatform } from '../../helpers/platform.ts';

/** `skydeck install` with both streams recorded together, in the order they were written. */
async function inOrder(
  platform: Platform,
  options: CaptureOptions,
): Promise<{ code: number; text: string; stdout: string; stderr: string }> {
  const captured = capture(options);
  let text = '';
  const io: Io = {
    ...captured.io,
    stdout: (chunk) => {
      text += chunk;
      captured.io.stdout(chunk);
    },
    stderr: (chunk) => {
      text += chunk;
      captured.io.stderr(chunk);
    },
    readLine: (prompt) => {
      text += prompt;
      return captured.io.readLine(prompt);
    },
  };
  const code = await main(['install'], { io, platform });
  return { code, text, stdout: captured.stdout(), stderr: captured.stderr() };
}

/** A machine where all three questions are asked: a settings file, two old sessions, ← on. */
function everyQuestion(t: Parameters<typeof testPlatform>[0], env = {}): TestPlatform {
  const d = testPlatform(t, { env });
  writeFileSync(settingsFile(d.places), `${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
  for (const id of [S1, S2]) transcript(d.places, id, T0 - 10n * NS_PER_DAY);
  writeFileSync(d.places.claudeGlobalConfig, '{}\n');
  chmodSync(d.places.claudeGlobalConfig, 0o600);
  return d;
}

/** python3 3.12 for the window: no Window section. */
const withPython = (d: TestPlatform): Platform => ({
  ...d.platform,
  runner: fakeRunner((call) =>
    runResult(call.command === 'python3' ? { stdout: 'Python 3.12.3\n' } : {}),
  ),
});

describe('install: the whole output, in the order a terminal shows it', () => {
  test('three questions, three yes: sections, questions, results, summary and Next', async (t) => {
    const d = everyQuestion(t);
    const settings = settingsFile(d.places);
    const global = d.places.claudeGlobalConfig;
    const bin = join(d.platform.appRoot, 'bin');
    const start = hookCommand(d.places.hookPath, 'SessionStart');
    const end = hookCommand(d.places.hookPath, 'SessionEnd').padEnd(start.length);

    // Standard input that is not a terminal: no answer is echoed, so each question's line is closed.
    const r = await inOrder(withPython(d), { lines: ['y', 'y', 'y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.text,
      [
        'Hooks',
        `  skydeck adds these hook entries to ${settings}`,
        '  (the file is backed up first):',
        '',
        `    SessionStart  ${start}  timeout 5 s`,
        `    SessionEnd    ${end}  timeout 5 s`,
        '',
        '> Add them? [y/N] ',
        `  linked  ${d.places.hookPath} -> ${join(bin, 'skydeck-hook')}`,
        `  linked  ${d.places.binLink} -> ${join(bin, 'skydeck')}`,
        `  linked  ${d.places.nodeLink} -> ${process.execPath}`,
        `  added   the hook entries to ${settings}`,
        `  backup  ${backupAtT0(d.places)}`,
        '',
        'Old sessions',
        '  "Done" only hides a session from skydeck\'s list: nothing is deleted,',
        '  it can still be resumed, and skydeck ls --all shows it.',
        '',
        '> Mark 2 sessions older than 7 days as done? [y/N] ',
        '  marked  2 sessions as done (skydeck ls --all shows them)',
        '',
        "Claude Code's ← shortcut",
        '  It is on: ← on an empty prompt sends the session to the background and opens',
        "  agent view. ← also closes a group in skydeck's list, so a ← meant for the list",
        "  can send a window terminal's session away. Turning it off sets only",
        `  leftArrowOpensAgents in ${global}, after a backup;`,
        '  agent view itself stays (claude agents, /bg).',
        '',
        '> Turn the shortcut off? [y/N] ',
        `  turned off  the ← shortcut in ${global}`,
        `  backup      ${global}.skydeck-backup-20261112T090000Z`,
        '  note        only for sessions started from now on; a session already running keeps it until it is started again',
        '',
        'Changed',
        `  database      ${d.places.dbPath} (new)`,
        `  link          ${d.places.hookPath}`,
        `  link          ${d.places.binLink}`,
        `  link          ${d.places.nodeLink}`,
        `  hook entries  ${settings}`,
        `  backup        ${backupAtT0(d.places)}`,
        `  ← shortcut    ${global}`,
        `  backup        ${global}.skydeck-backup-20261112T090000Z`,
      ].join('\n') + `\n${installedTail(d.platform)}`,
    );
    assert.doesNotMatch(r.text, /[{\x1b]/, 'no JSON, no escape sequence');
  });

  test('a second run: Hooks says the entries are there, the ← section that it is off, nothing was changed', async (t) => {
    const d = everyQuestion(t);
    assert.equal((await inOrder(withPython(d), { lines: ['y', 'n', 'y'] })).code, 0);

    const r = await inOrder(withPython(d), { lines: [] });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.text,
      [
        'Hooks',
        `  hook entries already present in ${settingsFile(d.places)}`,
        '',
        "Claude Code's ← shortcut",
        '  It is off.',
        '',
        'nothing was changed',
      ].join('\n') + `\n${installedTail(d.platform)}`,
    );
  });

  test('no settings file yet: the explanation says so, and the summary names the new file', async (t) => {
    const d = testPlatform(t);

    const r = await inOrder(withPython(d), { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.text.startsWith(
        `Hooks\n  skydeck adds these hook entries to ${settingsFile(d.places)}\n  (a new file):\n\n`,
      ),
      r.text,
    );
    assert.ok(r.text.includes(`\n> Add them? [y/N] \n  linked  ${d.places.hookPath} -> `), r.text);
    assert.ok(
      r.text.includes(`\n  added   the hook entries to ${settingsFile(d.places)} (a new file)\n`),
      r.text,
    );
    assert.ok(
      r.text.includes(`\n  hook entries  ${settingsFile(d.places)} (a new file)\n`),
      r.text,
    );
    assert.doesNotMatch(r.text, /backup/);
  });

  test('python3 missing: a Window section of its own, where the line was before', async (t) => {
    const d = testPlatform(t);
    const runner = fakeRunner((call) =>
      runResult(call.command === 'python3' ? { code: null, notFound: true } : {}),
    );

    const r = await inOrder({ ...d.platform, runner }, { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.stdout.includes(
        '\n\nWindow\n  the window (skydeck window) needs python3 3.9 or newer; the commands do not\n\n',
      ),
      r.stdout,
    );
  });
});

describe('install: colour (only on a terminal, never in foreign text)', () => {
  /** Every colour install writes: bold, dim and their end. */
  const OURS = /\x1b\[(?:1|2|22)m/g;
  const TTY = { stdinTTY: true, stdoutTTY: true, stderrTTY: true };
  /**
   * What is left of the first scan's progress line on a terminal (design 5.6): it is cleared with
   * `\r` and an erase to the end of the line, colour or none, as for every command that refreshes.
   */
  const PROGRESS = /(?:\rskydeck: reading transcripts \d+\/\d+)+\r\x1b\[K/g;

  test('on a terminal: headings and questions bold, backup and link lines dim; the same text without it', async (t) => {
    const plain = everyQuestion(t, { TERM: 'xterm-256color', NO_COLOR: '1' });
    const coloured = everyQuestion(t, { TERM: 'xterm-256color' });

    const a = await inOrder(withPython(plain), { lines: ['y', 'y', 'y'], ...TTY });
    const b = await inOrder(withPython(coloured), { lines: ['y', 'y', 'y'], ...TTY });

    assert.equal(b.code, 0, b.stderr);
    assert.match(b.stderr, /^\x1b\[1mHooks\x1b\[22m\n/);
    assert.match(b.stderr, /\n\n\x1b\[1m> Add them\? \[y\/N\]\x1b\[22m $/m);
    assert.match(b.stderr, /\n\x1b\[1mOld sessions\x1b\[22m\n/);
    assert.match(b.stdout, /^\x1b\[2m {2}linked {2}\S.* -> \S.*\x1b\[22m$/m);
    assert.match(b.stdout, /^\x1b\[2m {2}backup {2}\S.*\x1b\[22m$/m);
    assert.match(b.stdout, /^\x1b\[1mChanged\x1b\[22m$/m);
    assert.match(b.stdout, /^\x1b\[1mskydeck is installed\x1b\[22m$/m);
    const sandbox = (text: string, d: TestPlatform): string => text.replaceAll(d.sandbox.root, '');
    assert.equal(sandbox(b.text.replaceAll(OURS, ''), coloured), sandbox(a.text, plain));
  });

  test('only stdout a terminal: results, the summary and Next coloured there; stderr has none', async (t) => {
    const d = everyQuestion(t, { TERM: 'xterm' });

    const r = await inOrder(withPython(d), { lines: ['y', 'y', 'y'], stdoutTTY: true });

    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /\x1b/);
    assert.match(r.stderr, /^Hooks\n/);
    assert.match(r.stderr, /\n> Add them\? \[y\/N\] \n/);
    assert.match(r.stdout, /^\x1b\[2m {2}linked {2}\S.*\x1b\[22m$/m);
    assert.match(r.stdout, /^\x1b\[2m {2}backup {6}\S.*\x1b\[22m$/m);
    assert.match(r.stdout, /^ {2}marked {2}2 sessions as done/m);
    assert.match(r.stdout, /^\x1b\[1mChanged\x1b\[22m$/m);
    assert.match(r.stdout, /^\x1b\[1mNext\x1b\[22m$/m);
  });

  test('only stderr a terminal: headings and questions bold there; stdout has none', async (t) => {
    const d = everyQuestion(t, { TERM: 'xterm' });

    const r = await inOrder(withPython(d), { lines: ['y', 'y', 'y'], stderrTTY: true });

    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\x1b/);
    assert.match(r.stdout, /^ {2}linked {2}\S/m);
    assert.match(r.stdout, /^Changed$/m);
    assert.match(r.stderr, /^\x1b\[1mHooks\x1b\[22m\n/);
    assert.match(r.stderr, /^\x1b\[1mOld sessions\x1b\[22m$/m);
    assert.match(r.stderr, /^\x1b\[1m> Add them\? \[y\/N\]\x1b\[22m $/m);
    assert.match(r.stderr, /^\x1b\[1m> Turn the shortcut off\? \[y\/N\]\x1b\[22m $/m);
    // The rest of stderr is plain: the explanation lines and the entries.
    assert.match(r.stderr, /^ {2}skydeck adds these hook entries to \S+$/m);
  });

  for (const [why, env, options] of [
    ['NO_COLOR', { TERM: 'xterm', NO_COLOR: '1' }, TTY],
    ['TERM=dumb', { TERM: 'dumb' }, TTY],
    ['neither stream a terminal', { TERM: 'xterm' }, { stdinTTY: true }],
  ] as const) {
    test(`${why}: no escape sequence at all`, async (t) => {
      const d = everyQuestion(t, env);

      const r = await inOrder(withPython(d), { lines: ['y', 'y', 'y'], ...options });

      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.text.replaceAll(PROGRESS, ''), /\x1b/);
    });
  }

  test('a path with escape sequences: sanitised, and nothing but our own colour reaches the terminal', async (t) => {
    const d = testPlatform(t, {
      env: (s) => ({
        TERM: 'xterm',
        CLAUDE_CONFIG_DIR: join(s.root, 'cc\x1b[31m\x1b]0;x\x07\u009bz'),
      }),
    });
    mkdirSync(d.places.claudeHome);
    writeFileSync(d.places.claudeGlobalConfig, '{}\n');
    chmodSync(d.places.claudeGlobalConfig, 0o600);

    const r = await inOrder(withPython(d), { lines: ['y', 'y'], ...TTY });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.text.includes('.claude.json'), r.text);
    assert.doesNotMatch(r.text.replaceAll(OURS, '').replaceAll(PROGRESS, ''), /[\x1b\x07\u009b]/);
  });
});
