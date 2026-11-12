import type { Command } from '../../../src/cli/command.ts';
// @ts-expect-error The module is missing on purpose: loading this file must fail loudly.
import './does-not-exist.ts';

export const command: Command = {
  name: 'broken-import',
  summary: 'Never loads',
  async run() {
    return 0;
  },
};
