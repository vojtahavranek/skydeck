// AGENTS.md is followed literally by AI agents on other people's machines, so what it says must
// stay true: every `skydeck …` it gives names a command and options the command line knows,
// CLAUDE.md only imports it, and its preview — `bin/skydeck install </dev/null` — shows the hook
// entries, changes nothing and exits 1, as the file says, through the real launcher in a sandbox.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { main } from '../src/cli/main.ts';
import { NS_PER_DAY } from '../src/platform/time.ts';
import { testContext } from './helpers/context.ts';
import { run, transcript } from './helpers/install.ts';
import { S1, S2, S3, T0, testPlatform } from './helpers/platform.ts';
import { sandbox } from './helpers/sandbox.ts';

const ROOT = join(import.meta.dirname, '..');
const AGENTS = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const launcher = join(ROOT, 'bin', 'skydeck');

/** Every line of the file's `sh` blocks, and every inline code span outside the blocks. */
function commandTexts(text: string): string[] {
  const texts: string[] = [];
  for (const [, body] of text.matchAll(/^```sh\n([^]*?)^```$/gm)) {
    for (const line of (body ?? '').split('\n')) {
      const command = line.replace(/(^|\s)#.*$/, '').trim();
      if (command !== '') texts.push(command);
    }
  }
  // A span may go on over a line break of its paragraph.
  const outside = text.replaceAll(/^```[^]*?^```$/gm, '').replaceAll('\n', ' ');
  for (const [, span] of outside.matchAll(/`([^`]+)`/g)) {
    texts.push(span ?? '');
  }
  return texts;
}

/**
 * The words after each `skydeck` that runs the command line, up to a shell operator or a
 * redirection: one that starts a command (`skydeck`, `bin/skydeck`, `~/.local/bin/skydeck`, after
 * `&&` or a variable's assignment …), and the bare word anywhere else (`sudo skydeck …`); not
 * `~/skydeck`, `skydeck-hook`, `skydeck.db` or a path given to another program.
 */
function invocations(text: string): { text: string; words: string[] }[] {
  const found: { text: string; words: string[] }[] = [];
  for (const span of commandTexts(text)) {
    for (const [, rest] of span.matchAll(
      /(?:(?:^|[;&|(]\s*)(?:[A-Z_]+=\S*\s+)*(?:\S*bin\/)?|(?<=\s))skydeck(?=\s|$)((?:\s+[^\s|;&<>()]+)*)/g,
    )) {
      found.push({ text: span, words: (rest ?? '').trim().split(/\s+/).filter(Boolean) });
    }
  }
  return found;
}

/** What `skydeck <argv>` prints on stdout, with its exit code. */
async function printed(argv: string[]): Promise<{ code: number; stdout: string }> {
  const c = testContext();
  const code = await main(argv, c.ctx);
  return { code, stdout: c.stdout() };
}

/** The options `text` names. */
function optionsIn(text: string): Set<string> {
  return new Set(text.match(/(?<![\w-])--?[a-zA-Z][\w-]*/g) ?? []);
}

/** The options a command's usage names in its synopsis, its lines up to the first empty one. */
function optionsOf(usage: string): Set<string> {
  return optionsIn(usage.split('\n\n')[0] ?? '');
}

describe('AGENTS.md names only what the command line knows', () => {
  test('every skydeck command it gives exists, with the options it gives', async () => {
    const found = invocations(AGENTS);
    assert.ok(found.length >= 10, `${found.length} skydeck commands found in AGENTS.md`);
    // skydeck --help: the commands and their summaries, then the options of skydeck itself.
    const global = optionsIn((await printed(['--help'])).stdout.split('\nOptions:\n')[1] ?? '');
    for (const option of ['--help', '-h', '--version', '-V']) {
      assert.ok(global.has(option), `skydeck --help names ${option}`);
    }
    for (const { text, words } of found) {
      const [first, ...rest] = words;
      if (first === undefined) continue; // the bare `skydeck`
      if (first.startsWith('-')) {
        assert.ok(global.has(first) && rest.length === 0, `${text}: not an option of skydeck`);
        continue;
      }
      assert.match(first, /^[a-z][a-z-]*$/, `${text}: "${first}" is not a command name`);
      const help = await printed([first, '--help']);
      assert.equal(help.code, 0, `${text}: skydeck has no command "${first}"`);
      const known = optionsOf(help.stdout);
      for (const word of rest.filter((w) => w.startsWith('-'))) {
        const option = word.replace(/=.*$/, '');
        assert.ok(
          known.has(option) || option === '--help' || option === '-h',
          `${text}: skydeck ${first} has no option ${option}`,
        );
      }
    }
  });

  test('an option it names on its own is an option of some command', async () => {
    const all = new Set<string>(['--help', '-h', '--version', '-V']);
    const listing = (await printed(['--help'])).stdout;
    for (const [, name] of listing.matchAll(/^ {2}([a-z][a-z-]*) {2}/gm)) {
      for (const option of optionsOf((await printed([name ?? '', '--help'])).stdout)) {
        all.add(option);
      }
    }
    const alone = commandTexts(AGENTS).filter((span) => /^--?[a-zA-Z][\w-]*$/.test(span));
    for (const option of alone) {
      assert.ok(all.has(option), `AGENTS.md names ${option}, which no command has`);
    }
  });

  test('CLAUDE.md is exactly the import of AGENTS.md', () => {
    assert.equal(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  });
});

describe("AGENTS.md's questions are install's own", () => {
  test('the three it quotes, in its order, are the prompts install asks', async (t) => {
    const d = testPlatform(t);
    // Three old sessions (the second question) and a global config without the key (the third).
    for (const id of [S1, S2, S3]) transcript(d.places, id, T0 - 10n * NS_PER_DAY);
    writeFileSync(d.places.claudeGlobalConfig, '{}\n');
    chmodSync(d.places.claudeGlobalConfig, 0o600);

    const r = await run(d.platform, ['install'], { lines: ['y', 'n', 'n'] });

    assert.equal(r.code, 0, r.stderr);
    const quoted = [...AGENTS.matchAll(/`([^`]*\? \[y\/N\])`/g)].map((m) => m[1]);
    assert.deepEqual(
      r.prompts.map((prompt) => prompt.trimEnd()),
      quoted,
    );
  });
});

describe("AGENTS.md's preview: bin/skydeck install </dev/null", () => {
  test('shows the two hook entries, ends as the file says, exits 1 and changes nothing but the compile cache', (t) => {
    const s = sandbox(t);
    // The programs the launcher itself uses, and its handoff file inside the sandbox.
    s.link('dirname', 'readlink', 'mktemp', 'cat', 'rm');
    const tmp = join(s.root, 'tmp');
    mkdirSync(tmp);
    const settings = join(s.claudeHome, 'settings.json');
    const before = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
    writeFileSync(settings, before);

    // stdin 'ignore' is /dev/null, as `</dev/null` gives it.
    const r = spawnSync(launcher, ['install'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: s.env({ TMPDIR: tmp, SKYDECK_NODE: process.execPath }),
    });

    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '');
    // Some Node.js 24 versions (24.12) warn that node:sqlite is experimental, in two lines that come
    // wherever the warning's turn falls (here, after the prompt); AGENTS.md says they are harmless.
    const lines = r.stderr
      .replaceAll(
        /\(node:\d+\) ExperimentalWarning: [^\n]*\n|\(Use `node --trace-warnings[^\n]*\n/g,
        '',
      )
      .split('\n');
    const header = `skydeck will add these hook entries to ${settings}:`;
    assert.equal(lines[0], header, r.stderr);
    assert.equal(lines.at(-2), 'Add them? [y/N] settings not changed', r.stderr);
    assert.equal(lines.at(-1), '');
    const shown = JSON.parse(lines.slice(1, -2).join('\n')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(shown), ['SessionStart', 'SessionEnd']);
    assert.match(JSON.stringify(shown), /skydeck-hook/);

    // Nothing changed: the settings file, Claude Code's folder, skydeck's folders, ~/.local.
    assert.equal(readFileSync(settings, 'utf8'), before);
    assert.deepEqual(readdirSync(s.claudeHome), ['settings.json']);
    assert.deepEqual(readdirSync(s.skydeckHome), []);
    assert.equal(existsSync(join(s.home, '.local')), false);
    assert.deepEqual(readdirSync(s.home), ['.cache']);
    assert.deepEqual(readdirSync(join(s.home, '.cache')), ['skydeck']);

    // The output AGENTS.md shows for the preview: the same first and last line.
    const block = /bin\/skydeck install <\/dev\/null\n```\n[^]*?```text\n([^]*?)\n```/.exec(AGENTS);
    assert.ok(block, 'AGENTS.md shows the preview and its output in a text block');
    const quoted = (block[1] ?? '').split('\n');
    assert.equal(
      quoted[0],
      'skydeck will add these hook entries to /home/you/.claude/settings.json:',
    );
    assert.equal(quoted.at(-1), 'Add them? [y/N] settings not changed');
  });
});
