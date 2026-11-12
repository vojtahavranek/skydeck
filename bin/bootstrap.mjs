// Entry point run by bin/skydeck. Plain JavaScript that starts on any Node version: it refuses an
// old Node with one clear line, and only then loads the TypeScript CLI (which an old Node cannot).
import { checkNodeVersion } from './node-version.mjs';

const problem = checkNodeVersion(process.versions.node);
if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

// No top-level await: it would be a syntax error on a Node older than 14.8, before the message above.
import('../src/cli/main.ts').then(({ main, processIo }) => {
  process.exitCode = main(process.argv.slice(2), processIo());
});
