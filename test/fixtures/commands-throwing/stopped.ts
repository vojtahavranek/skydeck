import type { Command } from '../../../src/cli/command.ts';
import { RestoreStoppedError } from '../../../src/platform/errors.ts';

export const command: Command = {
  name: 'stopped',
  summary: 'Throw a RestoreStoppedError',
  async run() {
    throw new RestoreStoppedError('stopped');
  },
};
