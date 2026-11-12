import type { Command } from '../../../src/cli/command.ts';

export const command: Command = {
  name: 'alpha',
  summary: 'Say alpha with the arguments',
  async run(args, ctx) {
    ctx.io.stdout(`alpha ${args.join(',')}\n`);
    return 0;
  },
};
