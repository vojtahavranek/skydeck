/**
 * A runner that answers `gh` as `gh api graphql` would (plan D, task 36): with an answer of the
 * test's choice for every pull request a run asks about, at once, held until the test lets it go, or
 * held until the run's own abort signal fires (then it rejects as an aborted run does). It counts
 * the runs and passes every other command to the runner it wraps. It never starts a real `gh`: the
 * sandbox's PATH holds none, and no test may reach GitHub.
 */
import type { RunOptions, RunResult, Runner } from '../../src/platform/types.ts';

/** One pull request as GitHub's answer holds it (what src/github.ts asks for). */
export interface GhPullRequest {
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  /** The last commit's check rollup; null for none. */
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
}

/** Open, approved, checks passing: step 1's level `approved-green`. */
export const APPROVED_GREEN: GhPullRequest = {
  title: 'Fix the retry',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'APPROVED',
  checks: 'SUCCESS',
};

export interface GhOptions {
  /**
   * What every run answers: each pull request it asks about gets this one (default
   * APPROVED_GREEN), or a RunResult is the run's whole result (a `gh` that failed).
   */
  answer?: GhPullRequest | RunResult;
  /**
   * When a run answers: `now` (the default); `held` until release() (an abort of the run's signal
   * still rejects it, as it would kill a real gh); `signal` only when the run's own signal fires —
   * it then rejects as an aborted run does, and a run without a signal is a mistake of the test.
   */
  hold?: 'now' | 'held' | 'signal';
}

export interface GhRun {
  /** The pull requests it asked about, in order: `owner/repo#number`. */
  prs: string[];
  args: readonly string[];
}

export interface GhRunner extends Runner {
  /** Every `gh` run so far, in the order they started. */
  runs: GhRun[];
  /** Answers every run that is held (hold `held`) now. */
  release(): void;
  /** Resolves once `count` gh runs have started. */
  started(count: number, timeoutMs?: number): Promise<void>;
}

/** What the runners reject with when the signal fires: an Error named AbortError. */
function abortError(): Error {
  return new DOMException('the run was aborted', 'AbortError');
}

/** The pull requests of `gh api graphql`'s arguments (src/github.ts's batchArgs): `-f o<i>=`, `-f r<i>=`, `-F n<i>=`. */
function asked(args: readonly string[]): { owner: string; repo: string; number: string }[] {
  const values = new Map<string, string>();
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] !== '-f' && args[i] !== '-F') continue;
    const match = /^([orn][0-9]+)=(.*)$/s.exec(args[i + 1] ?? '');
    if (match !== null) values.set(match[1] ?? '', match[2] ?? '');
  }
  const prs: { owner: string; repo: string; number: string }[] = [];
  for (let i = 0; values.has(`n${i}`); i++) {
    prs.push({
      owner: values.get(`o${i}`) ?? '',
      repo: values.get(`r${i}`) ?? '',
      number: values.get(`n${i}`) ?? '',
    });
  }
  return prs;
}

function isRunResult(answer: GhPullRequest | RunResult): answer is RunResult {
  return 'code' in answer;
}

/** The run's result: the stdout `gh api graphql` prints for `pullRequest` at every alias, or `answer` itself. */
function resultOf(answer: GhPullRequest | RunResult, count: number): RunResult {
  if (isRunResult(answer)) return answer;
  const { checks, ...fields } = answer;
  const pullRequest = {
    ...fields,
    commits: {
      nodes: checks === null ? [] : [{ commit: { statusCheckRollup: { state: checks } } }],
    },
  };
  const data = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`p${i}`, { pullRequest }]),
  );
  return {
    code: 0,
    stdout: JSON.stringify({ data }),
    stderr: '',
    timedOut: false,
    notFound: false,
  };
}

/** `inner` with `gh` answered as GhOptions says; every other command goes to `inner`. */
export function ghRunner(inner: Runner, options: GhOptions = {}): GhRunner {
  const runs: GhRun[] = [];
  const held = new Set<() => void>();
  const answer = options.answer ?? APPROVED_GREEN;
  const hold = options.hold ?? 'now';
  return {
    runs,
    release() {
      for (const go of [...held]) go();
    },
    async started(count, timeoutMs = 5000) {
      const deadline = performance.now() + timeoutMs;
      while (runs.length < count) {
        if (performance.now() > deadline) {
          throw new Error(`${count} gh runs: only ${runs.length} within ${timeoutMs} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    run(command: string, args: readonly string[], runOptions?: RunOptions): Promise<RunResult> {
      if (command !== 'gh') return inner.run(command, args, runOptions);
      const signal = runOptions?.signal;
      if (signal?.aborted === true) return Promise.reject(abortError()); // nothing is started
      const prs = asked(args);
      runs.push({ prs: prs.map((pr) => `${pr.owner}/${pr.repo}#${pr.number}`), args });
      const result = resultOf(answer, prs.length);
      if (hold === 'now') return Promise.resolve(result);
      if (hold === 'signal' && signal === undefined) {
        return Promise.reject(new Error("ghRunner: hold 'signal' needs a run with a signal"));
      }
      return new Promise<RunResult>((resolve, reject) => {
        const abort = (): void => {
          held.delete(go);
          reject(abortError());
        };
        const go = (): void => {
          held.delete(go);
          signal?.removeEventListener('abort', abort);
          resolve(result);
        };
        if (hold === 'held') held.add(go);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    runInteractive: (command, args, runOptions) => inner.runInteractive(command, args, runOptions),
  };
}
