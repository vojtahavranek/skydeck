/**
 * The tests' stand-in for the account's login shell (design-step-2.md 7.10, 17.1): what both test
 * platforms set as `loginShell`, so that no test ever starts a real shell with a real profile.
 * The kernel runs it as `/bin/sh <script>`: not a login shell and not interactive, so `sh` reads
 * no profile, and `HOME` is the sandbox's.
 */
import { chmodSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Sandbox } from './sandbox.ts';

/** What the stand-in prints before it reads each line. */
export const SHELL_PROMPT = 'shell-standin> ';

/** The programs the stand-in and the tests' commands typed into it need on the sandbox's PATH. */
const PROGRAMS = ['sh', 'sleep', 'stty'];

const SCRIPT = `#!/bin/sh
# The tests' stand-in for a login shell: sh runs it as a script, so no profile is read.
printf '${SHELL_PROMPT}'
while IFS= read -r line; do
  eval "$line"
  printf '${SHELL_PROMPT}'
done
`;

/**
 * Writes `<s.bin>/shell-standin` (mode 755), links `sh`, `sleep` and `stty` into the sandbox's
 * bin when they are not there, and returns the script's path. Calling it again rewrites it.
 */
export function shellStandin(s: Sandbox): string {
  const script = join(s.bin, 'shell-standin');
  writeFileSync(script, SCRIPT);
  chmodSync(script, 0o755);
  s.link(...PROGRAMS.filter((program) => !present(join(s.bin, program))));
  return script;
}

/** Whether anything, a dangling link included, is at `path`. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
