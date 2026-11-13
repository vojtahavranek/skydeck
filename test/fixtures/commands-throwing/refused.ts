import type { Command } from '../../../src/cli/command.ts';
import { ResumeRefusedError } from '../../../src/platform/errors.ts';

export const command: Command = {
  name: 'refused',
  summary: 'Throw a ResumeRefusedError',
  async run() {
    throw new ResumeRefusedError('no');
  },
};
