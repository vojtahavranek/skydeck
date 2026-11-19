// What Claude Code says its version is (follow-up F20), for `skydeck doctor`: the first line that
// `<claudeCommand> --version` prints, kept short and printable, and compared with nothing. Claude
// Code prints `<version> (Claude Code)`; that last part is dropped, since the line doctor shows
// already says whose version it is (ruled by the plan owner). Here because it is what skydeck knows
// of a Claude Code command line (design principle 9).
import type { Runner, RunResult } from '../platform/types.ts';
import { sanitize } from '../text/sanitize.ts';

/** How long the program may take to answer. */
export const CLAUDE_VERSION_MS = 5_000;
/** Of its output only this much is read; the rest is dropped. */
const KEPT_BYTES = 4096;
/** Of its first line only this many characters are kept. */
const KEPT_CHARACTERS = 60;
/** How Claude Code's own line ends: dropped when the first line ends with exactly this. */
const OWN_NAME = ' (Claude Code)';

/** The version it printed, or why there is none. */
export type ClaudeVersion = { version: string } | { why: string };

/**
 * Runs `<command> --version` (never through a shell, stdin /dev/null) with `env` as its whole
 * environment. A program that cannot be started for another reason than its absence (EACCES …)
 * rejects, as Runner.run does.
 */
export async function readClaudeVersion(
  runner: Runner,
  command: string,
  env: Readonly<Record<string, string>>,
): Promise<ClaudeVersion> {
  const result = await runner.run(command, ['--version'], {
    env,
    timeoutMs: CLAUDE_VERSION_MS,
    maxOutputBytes: KEPT_BYTES,
  });
  const why = failure(result);
  if (why !== null) return { why };
  // Escape sequences and control characters dropped (a tab or a carriage return becomes a space),
  // then the spaces around it, then Claude Code's own name at its end, then what is beyond the limit.
  const cleaned = sanitize(result.stdout.split('\n')[0] ?? '').trim();
  const first = cleaned.endsWith(OWN_NAME) ? cleaned.slice(0, -OWN_NAME.length) : cleaned;
  const version = Array.from(first).slice(0, KEPT_CHARACTERS).join('').trimEnd();
  return version === '' ? { why: 'printed no version' } : { version };
}

/** Why it gave no version, in a few words; null when it ended well. */
function failure(result: RunResult): string | null {
  if (result.notFound) return 'not installed';
  if (result.timedOut) return `timed out after ${CLAUDE_VERSION_MS / 1000} s`;
  if (result.code === null) return 'ended by a signal';
  if (result.code !== 0) return `exited ${result.code}`;
  return null;
}
