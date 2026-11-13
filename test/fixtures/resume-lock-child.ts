// One skydeck process for test/sessions/resume-lock-concurrency.test.ts. It opens the deck of its
// environment (the test's sandbox) with the real platform and answers each stdin line
// "<session id> <sweep: 0 or 1>" with one line: it sweeps the locks first when asked (as the
// refresh of any command does), then tries to take the session's resume lock, and writes "ok",
// "refused" or "error <message>".
import { createInterface } from 'node:readline';

import { ResumeRefusedError } from '../../src/platform/errors.ts';
import { realPlatform } from '../../src/platform/real.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import { acquireLock, sweepLocks } from '../../src/sessions/resume.ts';

const deck = openDeck(realPlatform());
const input = createInterface({ input: process.stdin });
process.stdout.write('ready\n');
for await (const line of input) {
  const [sessionId = '', sweep] = line.split(' ');
  let answer: string;
  try {
    if (sweep === '1') {
      sweepLocks(deck);
    }
    acquireLock(deck, sessionId);
    answer = 'ok';
  } catch (error) {
    answer =
      error instanceof ResumeRefusedError
        ? 'refused'
        : `error ${error instanceof Error ? error.message : String(error)}`;
  }
  process.stdout.write(`${answer}\n`);
}
deck.store.close();
