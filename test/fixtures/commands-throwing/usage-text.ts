import type { Command } from '../../../src/cli/command.ts';
import { UsageError } from '../../../src/platform/errors.ts';

// What parseCommandArgs throws: the reason, a newline, and the usage text (which ends in one).
export const command: Command = {
  name: 'usage-text',
  summary: 'Throw a UsageError whose message ends with a newline',
  async run() {
    throw new UsageError("unknown option '--nope'\nskydeck x [--all]\n");
  },
};
