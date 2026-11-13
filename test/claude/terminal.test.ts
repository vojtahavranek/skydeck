import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLAUDE_CHILD_VARIABLES } from '../../src/claude/terminal.ts';

// S2 7.4: known today, and seen in the environment of a Claude Code session's command.
const KNOWN = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_EFFORT',
];

test('CLAUDE_CHILD_VARIABLES holds every name S2 7.4 lists, and nothing else', () => {
  assert.deepEqual([...CLAUDE_CHILD_VARIABLES].sort(), [...KNOWN].sort());
});

test('CLAUDE_CHILD_VARIABLES are whole variable names, never prefixes', () => {
  for (const name of CLAUDE_CHILD_VARIABLES) {
    assert.match(name, /^[A-Z][A-Z0-9_]*[A-Z0-9]$/, name);
  }
  assert.equal(new Set(CLAUDE_CHILD_VARIABLES).size, CLAUDE_CHILD_VARIABLES.length);
});

test("CLAUDE_CHILD_VARIABLES leaves the user's own Claude Code settings alone", () => {
  assert.equal(CLAUDE_CHILD_VARIABLES.includes('CLAUDE_CODE_USE_BEDROCK'), false);
  assert.equal(CLAUDE_CHILD_VARIABLES.includes('CLAUDE_CONFIG_DIR'), false);
});

test('CLAUDE_CHILD_VARIABLES cannot be changed by a caller', () => {
  assert.equal(Object.isFrozen(CLAUDE_CHILD_VARIABLES), true);
});
