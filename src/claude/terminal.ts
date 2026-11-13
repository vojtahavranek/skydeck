/**
 * What Claude Code puts into the environment of the programs it starts (S2 7.4, principle 9).
 * The window removes these from the environment of every terminal's program, so that no program
 * in the window looks like another session's child or carries its messaging token.
 */

/**
 * S2 7.4's list, names only (never a prefix): `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CONFIG_DIR`
 * are the user's own settings and must pass. To be confirmed by check W23.
 */
export const CLAUDE_CHILD_VARIABLES: readonly string[] = Object.freeze([
  // Known: in a hook's environment (design 14).
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  // Known: in the environment of a Claude Code session's command (seen 2026-11-13).
  'CLAUDECODE',
  // Seen in the environment of a Claude Code session's command; origin not yet known.
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_EFFORT',
]);
