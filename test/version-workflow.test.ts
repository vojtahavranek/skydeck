// The workflow Version (.github/workflows/version.yml; design-step-2.md 17.5) writes tags to the
// public repository, so the file is held here exactly: read by a strict reader of the plain YAML it
// is written in (block mappings, block sequences of mappings, `|` blocks, flow lists of plain words,
// quoted strings; anything else — an anchor, a tag, a flow mapping, a key twice, a tab — is refused,
// so the file cannot mean to GitHub what it does not mean here; no YAML library: the repository has
// no runtime dependency), and compared as a whole with what it must be: every key of the workflow,
// the job, each step, each `with:` and each `env:`, every value, and every `${{ }}` with where it
// stands. A change to the file is a change to this test. Beside that: the actions pinned as ci.yml
// pins them, and the push step's check of the tag's shape, run in bash.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { sandbox } from './helpers/sandbox.ts';

const VERSION = readFileSync(new URL('../.github/workflows/version.yml', import.meta.url), 'utf8');
const CI = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** A value of the file: a string, a list, or a mapping (in the file's order). */
type Value = string | Value[] | { [key: string]: Value };

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** `line` without a comment after its value: a ` #` outside quotes starts one. */
function uncommented(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (i === 0 || line[i - 1] === ' ')) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/** A scalar as written after `key: `: a flow list of plain words, a quoted string, or a plain one. */
function scalar(text: string, where: string): Value {
  if (text.startsWith('[')) {
    assert.ok(text.endsWith(']'), `${where}: a flow list ends with ]`);
    const inner = text.slice(1, -1);
    assert.ok(!/[[\]{}'"]/.test(inner), `${where}: a flow list of plain words only`);
    return inner.split(',').map((word) => word.trim());
  }
  if (text.startsWith("'")) {
    assert.ok(text.endsWith("'") && text.length >= 2, `${where}: a quoted string ends`);
    const inner = text.slice(1, -1);
    assert.ok(!/'(?!')/.test(inner.replace(/''/g, '')), `${where}: one string`);
    return inner.replace(/''/g, "'");
  }
  if (text.startsWith('"')) {
    assert.ok(text.endsWith('"') && !text.slice(1, -1).includes('"'), `${where}: one string`);
    assert.ok(!text.includes('\\'), `${where}: no escape in a double-quoted string`);
    return text.slice(1, -1);
  }
  assert.ok(!/^[&*!{|>@`%?]/.test(text), `${where}: no anchor, alias, tag or other form`);
  assert.ok(!text.includes(': ') && !text.includes(' #'), `${where}: a plain scalar`);
  return text;
}

/**
 * Every character is printable ASCII (0x20 to 0x7e) or a line feed: YAML takes other line breaks
 * (a carriage return, U+0085, U+2028, U+2029) and other spaces, which could hide a line from a
 * reader that splits at line feeds only, or make a comment of a key. The first other one fails,
 * named by its line and its code point.
 */
function asciiOnly(text: string): void {
  let line = 1;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      line += 1;
      continue;
    }
    assert.ok(
      code >= 0x20 && code <= 0x7e,
      `line ${line}: U+${code.toString(16).toUpperCase().padStart(4, '0')} is not printable ASCII`,
    );
  }
}

/** The file as a Value; an assertion fails on anything this reader does not take. */
function readWorkflow(text: string): Value {
  asciiOnly(text);
  const raw = text.split('\n');
  for (const line of raw) {
    assert.ok(!/^\s*\t/.test(line), 'no tab in an indentation');
    assert.ok(!/^(---|\.\.\.|%)/.test(line), 'one document, no directive');
  }
  // [indent, text] of each line that holds something; a `|` block's lines are taken as they are.
  const lines: { indent: number; text: string; raw: number }[] = [];
  raw.forEach((line, i) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    lines.push({ indent: indentOf(line), text: uncommented(line).trimStart(), raw: i });
  });
  let at = 0;

  const block = (indent: number, where: string): Value => {
    const first = lines[at];
    assert.ok(first !== undefined && first.indent === indent, `${where}: a block`);
    return first.text.startsWith('- ') ? sequence(indent, where) : mapping(indent, where);
  };

  const sequence = (indent: number, where: string): Value[] => {
    const items: Value[] = [];
    while (lines[at]?.indent === indent && lines[at]?.text.startsWith('- ')) {
      const line = lines[at];
      assert.ok(line !== undefined);
      // The item is a mapping whose first key stands after the dash.
      line.indent = indent + 2;
      line.text = line.text.slice(2);
      items.push(mapping(indent + 2, `${where}[${items.length}]`));
    }
    return items;
  };

  const mapping = (indent: number, where: string): { [key: string]: Value } => {
    const map: { [key: string]: Value } = {};
    while (lines[at]?.indent === indent && !(lines[at]?.text.startsWith('- ') ?? false)) {
      const line = lines[at];
      assert.ok(line !== undefined);
      const found = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line.text);
      assert.ok(found !== null, `${where}: a key on line ${line.raw + 1}: ${line.text}`);
      const key = found[1] ?? '';
      const rest = (found[2] ?? '').trim();
      const path = where === '' ? key : `${where}.${key}`;
      assert.ok(!Object.hasOwn(map, key), `${path}: a key once`);
      at += 1;
      if (rest === '|') {
        // The block's lines: those of the file below the key, more indented than it.
        const body: string[] = [];
        let next = line.raw + 1;
        while (
          next < raw.length &&
          (raw[next]?.trim() === '' || indentOf(raw[next] ?? '') > indent)
        ) {
          body.push(raw[next] ?? '');
          next += 1;
        }
        while (body.at(-1)?.trim() === '') body.pop();
        const cut = Math.min(...body.filter((b) => b.trim() !== '').map(indentOf));
        map[key] = `${body.map((b) => b.slice(cut)).join('\n')}\n`;
        while (at < lines.length && (lines[at]?.raw ?? 0) < next) at += 1;
      } else if (rest === '') {
        const child = lines[at];
        assert.ok(child !== undefined && child.indent > indent, `${path}: a value under it`);
        map[key] = block(child.indent, path);
      } else {
        map[key] = scalar(rest, path);
      }
    }
    return map;
  };

  const value = block(0, '');
  assert.equal(at, lines.length, 'every line read');
  return value;
}

/** Every string of `value` that holds `${{`, with its path. */
function expressions(value: Value, path = ''): [string, string][] {
  if (typeof value === 'string') return value.includes('${{') ? [[path, value]] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => expressions(v, `${path}[${i}]`));
  return Object.entries(value).flatMap(([k, v]) =>
    expressions(v, path === '' ? k : `${path}.${k}`),
  );
}

/** The pinned action ci.yml uses for `name` (`actions/checkout`): `<name>@<commit id>`. */
function ciPin(name: string): string {
  const found = new RegExp(`uses: (${name}@[0-9a-f]{40}) # v[0-9.]+`).exec(CI);
  assert.ok(found !== null, `ci.yml pins ${name}`);
  return found[1] ?? '';
}

const SHAPE_CHECK =
  '[[ "$TAG" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]] || { echo "not a version tag: $TAG"; exit 1; }';

/** What the file must be, whole. */
const EXPECTED: Value = {
  name: 'Version',
  on: {
    push: { branches: ['main'] },
    workflow_dispatch: {
      inputs: {
        bump: {
          description: 'The version to make on the head of main',
          type: 'choice',
          options: ['minor', 'major'],
          required: 'true',
        },
      },
    },
  },
  permissions: { contents: 'write' },
  concurrency: { group: 'version', 'cancel-in-progress': 'false' },
  jobs: {
    tag: {
      name: 'tag',
      if: "github.repository == 'vojtahavranek/skydeck' && github.ref == 'refs/heads/main'",
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': '5',
      steps: [
        {
          uses: ciPin('actions/checkout'),
          with: { 'fetch-depth': '0', 'fetch-tags': 'true' },
        },
        {
          uses: ciPin('actions/setup-node'),
          with: { 'node-version': '24', 'package-manager-cache': 'false' },
        },
        {
          name: 'Name the tag',
          id: 'next',
          env: { BUMP: '${{ inputs.bump }}' },
          run: 'tag="$(node scripts/next-version-tag.ts)"\necho "tag=$tag" >> "$GITHUB_OUTPUT"\n',
        },
        {
          name: 'Make the tag and push it',
          if: "steps.next.outputs.tag != ''",
          env: { TAG: '${{ steps.next.outputs.tag }}' },
          run: `${SHAPE_CHECK}\ngit tag "$TAG" HEAD\ngit push origin "refs/tags/$TAG"\n`,
        },
      ],
    },
  },
};

describe("the workflow Version, held exactly (D4')", () => {
  test('the file is exactly what it must be: every key of the workflow, the job, each step, each with: and each env:, and every value', () => {
    assert.deepEqual(readWorkflow(VERSION), EXPECTED);
  });

  test('every `${{ }}`, and where it stands: the input and the tag, each only in an env:', () => {
    assert.deepEqual(expressions(readWorkflow(VERSION)), [
      ['jobs.tag.steps[2].env.BUMP', '${{ inputs.bump }}'],
      ['jobs.tag.steps[3].env.TAG', '${{ steps.next.outputs.tag }}'],
    ]);
  });

  test('the actions are the ones ci.yml pins, by full commit id', () => {
    assert.match(ciPin('actions/checkout'), /^actions\/checkout@[0-9a-f]{40}$/);
    assert.match(ciPin('actions/setup-node'), /^actions\/setup-node@[0-9a-f]{40}$/);
    assert.match(VERSION, new RegExp(`uses: ${ciPin('actions/checkout')} # v`));
  });

  test("the push step's check lets only `v<n>.<n>.<n>` through, as bash runs it", (t) => {
    const s = sandbox(t);
    s.link('bash');
    const shaped = (tag: string): number | null =>
      spawnSync('bash', ['-c', SHAPE_CHECK], { env: s.env({ TAG: tag }), encoding: 'utf8' }).status;
    for (const good of ['v0.9.0', 'v1.0.0', 'v0.10.17']) assert.equal(shaped(good), 0, good);
    for (const bad of [
      '',
      'v1.2',
      'v01.2.3',
      'v1.2.3-rc1',
      'v1.2.3\nv9.9.9',
      'v1.2.3 v9.9.9',
      'refs/tags/v1.2.3',
      '-f',
      'v1.2.3;id',
    ]) {
      assert.equal(shaped(bad), 1, JSON.stringify(bad));
    }
  });
});

describe('the strict reader refuses what it does not take', () => {
  const refuses = (text: string): void => {
    assert.throws(() => readWorkflow(text), assert.AssertionError, text);
  };

  test('any character but printable ASCII and LF, before anything is read: a CR, U+2028, U+0085, a no-break space, a tab', () => {
    for (const [text, named] of [
      ['a: 1\r\nb: 2\n', 'line 1: U+000D'],
      ['on:\n  push: {} # x\rpull_request_target:\n', 'line 2: U+000D'],
      ['a: 1 # x\u2028b: 2\n', 'line 1: U+2028'],
      ['a: 1 # x\u0085b: 2\n', 'line 1: U+0085'],
      ['a: 1\u00a0# b: 2\n', 'line 1: U+00A0'],
      ['a:\n\tb: 1\n', 'line 2: U+0009'],
      ['# a dash \u2014 in a comment\n', 'line 1: U+2014'],
    ] as const) {
      assert.throws(
        () => readWorkflow(text),
        (error: unknown) => {
          assert.ok(error instanceof assert.AssertionError);
          assert.match(
            error.message,
            new RegExp(`^${named.replace('+', '\\+')} is not printable ASCII`),
          );
          return true;
        },
      );
    }
  });

  test('a key twice, an anchor, a tag, a flow mapping, a tab, a second document, a dangling key', () => {
    refuses('a: 1\na: 2\n');
    refuses('a: &x 1\n');
    refuses('a: !!str 1\n');
    refuses('a: {b: 1}\n');
    refuses('a:\n\tb: 1\n');
    refuses('a: 1\n---\nb: 2\n');
    refuses('a:\n');
    refuses('a: b: c\n');
  });

  test('what it reads: nested mappings, a sequence of mappings, a | block with a # in it, a flow list, comments', () => {
    assert.deepEqual(
      readWorkflow(
        '# top\na:\n  b: [x, y] # c\n  s:\n    - k: v\n      r: |\n        one # kept\n        two\n',
      ),
      { a: { b: ['x', 'y'], s: [{ k: 'v', r: 'one # kept\ntwo\n' }] } },
    );
  });
});
