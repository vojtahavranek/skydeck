import type { Command } from '../../../src/cli/command.ts';
import { EXIT } from '../../../src/cli/exit.ts';

export const command: Command = {
  name: 'ok',
  summary: 'Return EXIT.ok',
  async run() {
    return EXIT.ok;
  },
};
