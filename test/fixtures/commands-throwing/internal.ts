import type { Command } from '../../../src/cli/command.ts';

export const command: Command = {
  name: 'internal',
  summary: 'Throw an Error that is not a SkydeckError',
  async run() {
    throw new Error('boom');
  },
};
