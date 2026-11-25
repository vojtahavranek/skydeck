// The workflow Version's one script (.github/workflows/version.yml): prints the version tag to make
// on HEAD, and a line break, or nothing (scripts/version-tag.ts says which). `BUMP` in the
// environment: empty (a push), `minor` or `major` (run by hand); anything else ends it with exit 2.
// A git call that fails, or a refusal of the rules (main moved under a run by hand, a tag of the
// next version on another commit), ends it with exit 1 and its line on standard error: the run
// fails, no tag is made, and the line says what to do.
//
// Usage: BUMP=<bump> node scripts/next-version-tag.ts   (in the repository, its whole history and tags fetched)
import { realPlatform } from '../src/platform/real.ts';
import { bumpOf, nextVersionTag } from './version-tag.ts';

const platform = realPlatform();
const bump = bumpOf(platform.env.BUMP);
if (bump === null) {
  process.stderr.write('next-version-tag: BUMP must be empty, minor or major\n');
  process.exit(2);
}
try {
  const tag = await nextVersionTag(
    async (args) => {
      const result = await platform.runner.run('git', args, { timeoutMs: 60_000 });
      if (result.code !== 0 || result.timedOut || result.notFound) {
        throw new Error(
          `git ${args[0] ?? ''} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        );
      }
      return result.stdout;
    },
    'HEAD',
    bump,
  );
  if (tag !== null) process.stdout.write(`${tag}\n`);
  else process.stderr.write('next-version-tag: no tag to make\n');
} catch (error) {
  process.stderr.write(
    `next-version-tag: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
