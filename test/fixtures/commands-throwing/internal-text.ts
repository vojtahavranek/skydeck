import type { Command } from '../../../src/cli/command.ts';

export const command: Command = {
  name: 'internal-text',
  summary: 'Throw something that is not an Error at all',
  async run() {
    throw 'plain text';
  },
};
