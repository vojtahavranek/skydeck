import type { Command } from '../../../src/cli/command.ts';

export const command: Command = {
  name: 'internal-escapes',
  summary: 'Throw an Error whose message contains escape sequences',
  async run() {
    throw new Error('open /tmp/\x1b[2Jx failed\nsecond line');
  },
};
