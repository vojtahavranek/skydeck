// Principle 7 with real processes: several skydecks take the same session's resume lock at the same
// moment against one database file, and exactly one of them gets it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NS_PER_MS, NS_PER_SECOND } from '../../src/platform/time.ts';
import { lockKey } from '../../src/sessions/resume.ts';
import { testDeck } from '../helpers/deck.ts';

const CHILD = fileURLToPath(new URL('../fixtures/resume-lock-child.ts', import.meta.url));
const PROCESSES = 6;
const ROUNDS = 40;

interface Child {
  process: ChildProcessWithoutNullStreams;
  next: () => Promise<string>;
}

/** Lines of `child`'s stdout, one per call; "closed" once it has ended. */
function lineReader(child: ChildProcessWithoutNullStreams): () => Promise<string> {
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let closed = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const waiter = waiting.shift();
    if (waiter === undefined) {
      queued.push(line);
    } else {
      waiter(line);
    }
  });
  lines.on('close', () => {
    closed = true;
    for (const waiter of waiting.splice(0)) {
      waiter('closed');
    }
  });
  return () =>
    new Promise((resolve) => {
      const line = queued.shift();
      if (line !== undefined) {
        resolve(line);
      } else if (closed) {
        resolve('closed');
      } else {
        waiting.push(resolve);
      }
    });
}

test('skydecks taking one lock at once: exactly one gets it, every round, stale lock or not', async (t) => {
  const d = testDeck(t);
  const env = d.sandbox.env();
  const children: Child[] = [];
  t.after(() => {
    for (const child of children) {
      child.process.kill();
    }
  });
  for (let i = 0; i < PROCESSES; i++) {
    const child = spawn(process.execPath, [CHILD], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const next = lineReader(child);
    children.push({ process: child, next });
    assert.equal(await next(), 'ready', stderr);
  }

  for (let round = 1; round <= ROUNDS; round++) {
    const sessionId = `00000000-0000-4000-8000-${String(round).padStart(12, '0')}`;
    if (round % 2 === 0) {
      // A lock left over from a resume two minutes ago (by the children's real clock): stale, so
      // every child may take it over, and the sweeping ones may remove it — still only one wins.
      const twoMinutesAgo = BigInt(Date.now()) * NS_PER_MS - 120n * NS_PER_SECOND;
      d.deck.store.setKv(lockKey(sessionId), `${twoMinutesAgo}`);
    }
    children.forEach((child, i) => {
      child.process.stdin.write(`${sessionId} ${i % 2}\n`);
    });
    const answers = await Promise.all(children.map((child) => child.next()));
    assert.deepEqual(
      [...answers].sort(),
      ['ok', ...Array<string>(PROCESSES - 1).fill('refused')],
      `round ${round}: ${answers.join(', ')}`,
    );
  }

  for (const child of children) {
    child.process.stdin.end();
  }
  assert.deepEqual(await Promise.all(children.map((child) => child.next())), [
    ...Array<string>(PROCESSES).fill('closed'),
  ]);
});
