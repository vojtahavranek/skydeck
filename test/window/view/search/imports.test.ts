/**
 * Plan 2.1 (stage E): every file of `src/window/view/search/` imports values only from its own
 * files and from `text`'s `sanitize`, types only from `sessions`, `protocol.ts`, `hub.ts` and
 * `sections.ts`; and builds no regular expression: no `RegExp(` (a constructor or a call), and no
 * `.match(`, `.matchAll(` or `.search(` with an argument that is not a literal (ruled on task 90's
 * review 1: those build a pattern from a string, so in this directory a pattern is written as a
 * literal where it is used).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = join(import.meta.dirname, '../../../../src/window/view/search');

/** A file of the directory itself. */
const OWN = /^\.\/[\w-]+\.ts$/;
const SANITIZE = '../../../text/sanitize.ts';
const SESSIONS = /^\.\.\/\.\.\/\.\.\/sessions\/[\w-]+\.ts$/;
const TYPE_SOURCES = new Set(['../../protocol.ts', '../../hub.ts', '../sections.ts']);

/** `import … from '…'` and `export … from '…'`, over several lines too. An `export` counts only
 *  before `*` or `{` (a re-export), so that a `from '…'` in an exported declaration's template (or
 *  any text the clause does not take whole) is no import. The clause takes a block comment, a
 *  line comment with its line end or a string whole, and anything else but `;`, `/` and quotes:
 *  a `;` or a `from '…'` inside a comment or a string of the clause neither ends it nor names its
 *  source, so whatever the clause holds is judged, and each comment has one reading (a statement
 *  that reaches no source is read once, not once per way to split its comments). */
const STATEMENT =
  /^(?:import|export(?=\s+(?:type\s+)?[*{]))\s+(type\s+)?((?:\/\*(?:(?!\*\/).)*\*\/|\/\/[^\n]*\n|'[^'\n]*'|"[^"\n]*"|[^;\/'"])*?)\s*from\s+'([^']+)'/gms;
/** `import '…';`: a value import, for its effects. */
const BARE_IMPORT = /^import\s+'([^']+)'/gm;
/** `import('…')`: in a type position or at run time; either way it names a module. */
const IMPORT_CALL = /\bimport\s*\(\s*'([^']+)'/g;
/** A regular expression built at run time (a constructor or a call). */
const REGEXP_CALL = /RegExp\s*\(/;
/** String methods that build a regular expression from an argument that is not one. */
const IMPLICIT_REGEXP = /\.(?:match|matchAll|search)\s*\((?!\s*\/(?![/*]))/;

/** The names a clause imports as values: `{ a, type B, c as d }`, `* as x`, a default. */
function valueNames(clause: string): string[] {
  return clause
    .replace(/[{}]/g, ',')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('type '))
    .map((part) => part.split(/\s+as\s+/)[0] ?? part);
}

/** A module a value may come from. */
function valueSource(from: string): boolean {
  return OWN.test(from) || from === SANITIZE;
}

/** A module a type may come from. */
function typeSource(from: string): boolean {
  return valueSource(from) || SESSIONS.test(from) || TYPE_SOURCES.has(from);
}

/** What breaks plan 2.1 in one file's source; [] when nothing. */
function violations(source: string): string[] {
  const found: string[] = [];
  for (const [, isType, clause = '', from = ''] of source.matchAll(STATEMENT)) {
    if (!typeSource(from)) {
      found.push(`import from '${from}'`);
      continue;
    }
    const values = isType === undefined ? valueNames(clause) : [];
    if (values.length === 0 || OWN.test(from)) {
      continue;
    }
    if (from !== SANITIZE || values.some((name) => name !== 'sanitize')) {
      found.push(`value import ${values.join(', ')} from '${from}'`);
    }
  }
  for (const [, from = ''] of source.matchAll(BARE_IMPORT)) {
    if (!valueSource(from)) {
      found.push(`import '${from}'`);
    }
  }
  for (const [, from = ''] of source.matchAll(IMPORT_CALL)) {
    if (!typeSource(from)) {
      found.push(`import('${from}')`);
    }
  }
  if (REGEXP_CALL.test(source)) {
    found.push('RegExp(');
  }
  if (IMPLICIT_REGEXP.test(source)) {
    found.push('a pattern built from a string by match, matchAll or search');
  }
  return found;
}

test('src/window/view/search/: values from its own files and sanitize, types as 2.1 says, no RegExp(', () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.includes('filter.ts'), files.join(', '));
  for (const name of files) {
    assert.deepEqual(violations(readFileSync(join(DIR, name), 'utf8')), [], name);
  }
});

test('the check itself: what it lets through', () => {
  const source = [
    "import { sanitize } from '../../../text/sanitize.ts';",
    "import { MAX_WORDS, type SearchChip } from './filter.ts';",
    "import type { ListRow } from '../../../sessions/list.ts';",
    "import { type TerminalInfo } from '../../hub.ts';",
    "import type {\n  RowPayload,\n  NsText,\n} from '../../protocol.ts';",
    "import type { MAY_START } from '../sections.ts';",
    "export { searchWords } from './filter.ts';",
    "import './stacks.ts';",
    "type Row = import('../../protocol.ts').RowPayload;",
    'const parts = text.split(/\\s+/u);',
    'const m = text.match(/^>/);',
    'const hit = query.match(\n  /^>\\s*(?:r|re|res)$/iu,\n);',
    'const at = title.search( /x/);',
    'const all = [...text.matchAll(/x/g)];',
    // `export` that re-exports nothing: a `from '…'` in its comment or string is no import.
    "export function f(): number {\n  // taken from 'the plan'\n  return 1;\n}",
    'export const s = "x from \'y\'";',
    // A statement whose own source cannot be read is not judged by a `from '…'` inside one of
    // its comments or strings: each is taken whole, however the match goes on.
    'import {\n  a, // from \'node:fs\'\n} from "./filter.ts";',
    'import { a /* from \'node:fs\' */ } from "./filter.ts";',
    'import { "from \'node:fs\'" as a } from "./filter.ts";',
    // An exported declaration is no statement here, whatever its text holds: a template too.
    "export const t = `x from 'y'`;",
  ].join('\n');
  assert.deepEqual(violations(source), []);
});

test('the check itself: a statement that never reaches a source is read once', () => {
  // A local export list with six line comments. A line comment that could end anywhere in its
  // line made the pattern try every way to split each one: 20 s and more for these six.
  const names = Array.from({ length: 6 }, (_, index) => `  name${index}, // the rule of plan 2.1`);
  const start = performance.now();
  assert.deepEqual(violations(`export {\n${names.join('\n')}\n};\n`), []);
  const took = performance.now() - start;
  assert.ok(took < 1000, `${Math.round(took)} ms`);
});

test('the check itself: what it refuses', () => {
  const cases: [string, string][] = [
    ["import { isListed } from '../../../sessions/list.ts';", 'value import isListed'],
    ["import { MAY_START } from '../sections.ts';", 'value import MAY_START'],
    ["import { other } from '../../../text/sanitize.ts';", 'value import other'],
    [
      "import type { Ns } from '../../../platform/types.ts';",
      "import from '../../../platform/types.ts'",
    ],
    ["import { readFileSync } from 'node:fs';", "import from 'node:fs'"],
    ["export * from '../build.ts';", "import from '../build.ts'"],
    ["import 'node:fs';", "import 'node:fs'"],
    ["import '../../hub.ts';", "import '../../hub.ts'"],
    ["const m = await import('node:fs');", "import('node:fs')"],
    ['const pattern = new RegExp(text);', 'RegExp('],
    ['const pattern = RegExp (text, "u");', 'RegExp('],
    ['const hit = title.match(word);', 'a pattern built from a string'],
    ['const hit = title.match(PATTERN);', 'a pattern built from a string'],
    ['const hit = title.match(\n  word,\n);', 'a pattern built from a string'],
    ['const hit = title.match(/* the word */ word);', 'a pattern built from a string'],
    ['const hit = title.match(// the word\n  word);', 'a pattern built from a string'],
    ["import { readFileSync } from 'node:fs' with {};", "import from 'node:fs'"],
    ["const hit = title.match(new String('x'));", 'a pattern built from a string'],
    ['const at = title.search(word);', 'a pattern built from a string'],
    ['const all = title.matchAll(word);', 'a pattern built from a string'],
    // A clause that is not names only is still judged: a comment, a string name, a letter
    // outside ASCII.
    ["import { isListed /* 7.2 */ } from '../../../sessions/list.ts';", 'value import isListed'],
    ["import {\n  isListed, // 7.2\n} from '../../../sessions/list.ts';", 'value import isListed'],
    [
      'import { "isListed" as isListed } from \'../../../sessions/list.ts\';',
      'value import "isListed"',
    ],
    ["import { caf\u00e9 } from '../../../sessions/list.ts';", 'value import caf\u00e9'],
    // A re-export is still an import, with `type` and with `* as`.
    ["export { readFileSync } from 'node:fs';", "import from 'node:fs'"],
    [
      "export type { Ns } from '../../../platform/types.ts';",
      "import from '../../../platform/types.ts'",
    ],
    ["export * as fs from 'node:fs';", "import from 'node:fs'"],
    ["export { isListed } from '../../../sessions/list.ts';", 'value import isListed'],
    // A comment in the clause is taken whole: a `;` in it ends nothing, a `from '…'` in it names
    // no source (review 2 of #97).
    [
      "import {\n  isListed, // 7.2; the listing rule\n} from '../../../sessions/list.ts';",
      'value import isListed',
    ],
    [
      "import { readFileSync /* moved from './filter.ts' */ } from 'node:fs';",
      "import from 'node:fs'",
    ],
    ["import { readFileSync /* sync; blocks */ } from 'node:fs';", "import from 'node:fs'"],
    [
      "import {\n  // was taken from './filter.ts'\n  isListed,\n} from '../../../sessions/list.ts';",
      'value import',
    ],
    ["export { /* all; */ readFileSync } from 'node:fs';", "import from 'node:fs'"],
    // A single-quoted string name is taken whole too.
    ["import { 'isListed' as isListed } from '../../../sessions/list.ts';", 'value import'],
    // A block comment ends at its first `*/`: the next comment does not hide a statement.
    [
      "import { readFileSync /* a */ } from 'node:fs';\n/* b */\nimport { x } from './filter.ts';",
      "import from 'node:fs'",
    ],
  ];
  for (const [source, expected] of cases) {
    const found = violations(source);
    assert.ok(
      found.some((text) => text.startsWith(expected)),
      `${source}: ${found.join('; ')}`,
    );
  }
});
