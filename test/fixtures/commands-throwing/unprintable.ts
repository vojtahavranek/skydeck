import type { Command } from '../../../src/cli/command.ts';

export const command: Command = {
  name: 'unprintable',
  summary: 'Throw an object that cannot be turned into text',
  async run() {
    throw Object.create(null);
  },
};
