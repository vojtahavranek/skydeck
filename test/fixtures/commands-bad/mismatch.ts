import type { Command } from '../../../src/cli/command.ts';

// The file is called mismatch.ts but the command names itself differently.
export const command: Command = {
  name: 'other',
  summary: 'Wrong name',
  async run() {
    return 0;
  },
};
