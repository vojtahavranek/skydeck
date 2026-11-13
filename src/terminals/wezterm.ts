import type { Env, RunResult, Runner } from '../platform/types.ts';
import { sanitize } from '../text/sanitize.ts';
import type { LaunchSpec, OpenResult, Terminal } from './types.ts';

const TIMEOUT_MS = 10_000;

function failure(result: RunResult): string {
  if (result.timedOut) {
    // The request may have reached WezTerm before the call was killed, so a tab can exist.
    return 'wezterm timed out; a tab may have opened';
  }
  if (result.notFound) {
    return 'wezterm is not installed';
  }
  // The program's own words are the best explanation, but they are foreign text.
  const firstLine = sanitize(result.stderr.split('\n')[0] ?? '').trim();
  if (firstLine !== '') {
    return firstLine;
  }
  return result.code === null ? 'wezterm exited without a status' : `wezterm exited ${result.code}`;
}

/**
 * open() runs `wezterm cli --no-auto-start spawn [--domain-name <domain>] --cwd <cwd> -- <argv…>`
 * with a 10 s timeout; on notFound with env WSL_DISTRO_NAME set it retries once with
 * `wezterm.exe` (D15). ok when the exit code is 0; otherwise error = first line of stderr, or
 * "wezterm exited <code>", "wezterm timed out; a tab may have opened", "wezterm is not installed",
 * and timedOut = whether the call was killed for taking too long.
 *
 * `--no-auto-start`: without it, `wezterm cli` starts a hidden mux server when no WezTerm window is
 * open, and the session would run in a terminal nobody can see, where skydeck's guard then counts
 * it as running. With it the call fails, and the caller takes its fallback (print the command).
 */
export function weztermTerminal(
  deps: { runner: Runner; env: Env },
  domain: string | null,
): Terminal {
  return {
    name: 'wezterm',
    opensTabs: true,
    async open(spec: LaunchSpec): Promise<OpenResult> {
      const args = [
        'cli',
        '--no-auto-start',
        'spawn',
        ...(domain === null ? [] : ['--domain-name', domain]),
        '--cwd',
        spec.cwd,
        '--',
        ...spec.argv,
      ];
      let result = await deps.runner.run('wezterm', args, { timeoutMs: TIMEOUT_MS });
      const inWsl = (deps.env['WSL_DISTRO_NAME'] ?? '') !== '';
      if (result.notFound && inWsl) {
        result = await deps.runner.run('wezterm.exe', args, { timeoutMs: TIMEOUT_MS });
      }
      return result.code === 0
        ? { ok: true }
        : { ok: false, error: failure(result), timedOut: result.timedOut };
    },
  };
}
