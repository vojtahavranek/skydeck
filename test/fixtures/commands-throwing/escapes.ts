import type { Command } from '../../../src/cli/command.ts';
import { RefError } from '../../../src/platform/errors.ts';
import { S1 } from '../../helpers/platform.ts';

// Text that came off the disk or off GitHub may carry escape sequences into a message.
export const command: Command = {
  name: 'escapes',
  summary: 'Throw a RefError whose texts contain escape sequences',
  async run() {
    throw new RefError('a\x1b]0;title\x07b\nsec\rond\x1b[2J line', [
      { id: S1, title: 'c\x1b[31md\ne' },
    ]);
  },
};
