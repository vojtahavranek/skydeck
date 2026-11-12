import type { Command } from '../../../src/cli/command.ts';

export const command: Command = {
  name: 'beta-two',
  summary: 'Always fail',
  async run(_args, ctx) {
    ctx.io.stderr('beta-two failed\n');
    return 3;
  },
};
