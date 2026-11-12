// Entry point run by bin/skydeck. Plain JavaScript that starts on any Node version: it refuses an
// old Node with one clear line, and only then loads the TypeScript CLI (which an old Node cannot).
import { checkNodeVersion } from './node-version.mjs';

const problem = checkNodeVersion(process.versions.node);
if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

const { main, processIo } = await import('../src/cli/main.ts');
process.exitCode = main(process.argv.slice(2), processIo());
