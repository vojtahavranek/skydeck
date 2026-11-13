import type { Command } from '../../../src/cli/command.ts';
import { UsageError } from '../../../src/platform/errors.ts';

export const command: Command = {
  name: 'usage',
  summary: 'Throw a UsageError',
  async run() {
    throw new UsageError('bad');
  },
};
