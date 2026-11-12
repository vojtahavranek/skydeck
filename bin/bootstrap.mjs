// Entry point run by bin/skydeck. Plain JavaScript that starts on any Node version: it refuses an
// old Node with one clear line, and only then loads the TypeScript CLI (which an old Node cannot).
import { checkNodeVersion } from './node-version.mjs';

const problem = checkNodeVersion(process.versions.node);
if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

// No top-level await: it would be a syntax error on a Node older than 14.8, before the message above.
// Both outcomes are handled explicitly so a failure to load the CLI exits 1 however Node is
// configured to treat unhandled rejections (--unhandled-rejections=warn and =none exit 0).
Promise.all([import('../src/cli/main.ts'), import('../src/cli/context.ts')])
  .then(([{ main }, { processContext }]) => main(process.argv.slice(2), processContext()))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
