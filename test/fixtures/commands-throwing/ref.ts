import type { Command } from '../../../src/cli/command.ts';
import { RefError } from '../../../src/platform/errors.ts';
import { S1, S2 } from '../../helpers/platform.ts';

export const command: Command = {
  name: 'ref',
  summary: 'Throw a RefError with two candidates',
  async run() {
    throw new RefError("'x' matches 2 sessions", [
      { id: S1, title: 'alpha' },
      { id: S2, title: 'beta' },
    ]);
  },
};
