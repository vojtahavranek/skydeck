/**
 * Plan 2.1 (stage E): every file of `src/window/view/search/` imports values only from its own
 * files and from `text`'s `sanitize`, types only from `sessions`, `protocol.ts`, `hub.ts` and
 * `sections.ts`, and builds no regular expression (from a search text or from anything else).
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

/** `import … from '…'` and `export … from '…'`, over several lines too. */
const STATEMENT = /^(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+'([^']+)';/gms;
/** `import '…';`: a value import for its effects. */
const BARE_IMPORT = /^import\s+'([^']+)'/gm;
/** A module loaded at run time. */
const DYNAMIC = /\bimport\s*\(|\brequire\s*\(/;
/** A regular expression built at run time (a constructor or a call). */
const REGEXP_CALL = /RegExp\s*\(/;
/** String methods that build a regular expression from a string argument (a literal is fine). */
const IMPLICIT_REGEXP = /\.(?:match|matchAll|search)\s*\(\s*(?!\/)/;

/** The names a clause imports as values: `{ a, type B, c as d }`, `* as x`, a default. */
function valueNames(clause: string): string[] {
  return clause
    .replace(/[{}]/g, ',')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('type '))
    .map((part) => part.split(/\s+as\s+/)[0] ?? part);
}

/** What breaks plan 2.1 in one file's source; [] when nothing. */
function violations(source: string): string[] {
  const found: string[] = [];
  for (const [, isType, clause = '', from = ''] of source.matchAll(STATEMENT)) {
    const allowedType = OWN.test(from) || from === SANITIZE || SESSIONS.test(from);
    if (!allowedType && !TYPE_SOURCES.has(from)) {
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
    found.push(`import '${from}'`);
  }
  if (DYNAMIC.test(source)) {
    found.push('a module loaded at run time');
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
    'const parts = text.split(/\\s+/u);',
    'const m = text.match(/^>/);',
  ].join('\n');
  assert.deepEqual(violations(source), []);
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
    ["const m = await import('node:fs');", 'a module loaded at run time'],
    ['const pattern = new RegExp(text);', 'RegExp('],
    ['const pattern = RegExp (text, "u");', 'RegExp('],
    ['const hit = title.match(word);', 'a pattern built from a string'],
    ['const at = title.search(word);', 'a pattern built from a string'],
    ['const all = title.matchAll(word);', 'a pattern built from a string'],
  ];
  for (const [source, expected] of cases) {
    const found = violations(source);
    assert.ok(
      found.some((text) => text.startsWith(expected)),
      `${source}: ${found.join('; ')}`,
    );
  }
});
