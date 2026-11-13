import type { Command } from '../../../src/cli/command.ts';
import { SkydeckError } from '../../../src/platform/errors.ts';

export const command: Command = {
  name: 'failure',
  summary: 'Throw a SkydeckError',
  async run() {
    throw new SkydeckError('failed');
  },
};
