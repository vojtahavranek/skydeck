// One would-be server for test/window/runtime.test.ts. It opens the deck of its environment (the
// test's sandbox) with the real platform and answers each stdin line "<checkout>" with one line:
// it tries to take the window_server lock for itself (its pid, process start and the boot id) and
// writes "taken", "refused <holder pid> <holder checkout>" or "error <message>".
import { createInterface } from 'node:readline';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import { realPlatform } from '../../src/platform/real.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import { takeServerLock } from '../../src/window/runtime.ts';

// Run by hand outside a test it would open the installed store: it runs only in a test sandbox.
const home = process.env.SKYDECK_HOME;
if (process.env.SKYDECK_TEST_NO_WINDOWS !== '1' || home === undefined || !home.startsWith('/')) {
  process.stderr.write('server-lock-child: runs only inside a test sandbox\n');
  process.exit(2);
}

const platform = realPlatform();
const deck = openDeck(platform);
const procStart = procStartFromStat(platform.proc.stat(platform.pid) ?? '');
const bootId = platform.proc.bootId();
const input = createInterface({ input: process.stdin });
process.stdout.write('ready\n');
for await (const checkout of input) {
  let answer: string;
  try {
    if (procStart === null || bootId === null) {
      throw new Error('cannot read this process start or the boot id');
    }
    const got = takeServerLock(deck, { pid: platform.pid, procStart, bootId, checkout });
    answer = got.taken ? 'taken' : `refused ${got.holder.pid} ${got.holder.checkout}`;
  } catch (error) {
    answer = `error ${error instanceof Error ? error.message : String(error)}`;
  }
  process.stdout.write(`${answer}\n`);
}
deck.store.close();
