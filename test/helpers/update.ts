/**
 * The tests of `skydeck update` (F8): a scripted git for the fake runner, and the one way every
 * test runs the command — on a root inside its sandbox, never on this repository (hazard 1).
 */
import { main } from '../../src/cli/main.ts';
import type { Platform, RunResult } from '../../src/platform/types.ts';
import type { Captured } from './capture.ts';
import { insideSandbox } from './git-checkout.ts';
import { run } from './install.ts';
import type { Run } from './install.ts';
import { fakeRunner, runResult } from './platform.ts';
import type { FakeRunner, RunCall } from './platform.ts';
import type { Sandbox } from './sandbox.ts';

/** HEAD before the update, and the upstream's commit after the fetch (full ids). */
export const OLD = '0123456789abcdef0123456789abcdef01234567';
export const NEW = 'fedcba9876543210fedcba9876543210fedcba98';

/** The id of the i-th new commit (1 = the oldest); its short id is its first seven characters. */
export function commitId(i: number): string {
  return `${i.toString(16).padStart(7, '0')}${'e'.repeat(33)}`;
}

/** The ls-tree line of src/store/migrations.ts with blob `blob`, as `ls-tree -z` prints it. */
export function migrationsEntry(blob: string): string {
  return `100644 blob ${blob}\tsrc/store/migrations.ts\0`;
}

/** What the scripted git answers; every field has a default (scriptedRepo). */
export interface ScriptedRepo {
  root: string;
  /** `rev-parse --show-toplevel`'s directory; null: it fails (not a work tree). */
  toplevel: string | null;
  /** The branch HEAD is on; null: detached. */
  branch: string | null;
  /** The branch's upstream as for-each-ref prints it: the full ref, its remote, its short name. */
  upstream: { ref: string; remote: string; short: string };
  /** `status --porcelain -z --untracked-files=no`'s output. */
  status: string;
  head: string;
  /** The upstream's commit after the fetch. */
  fetched: string;
  /** The fetch's exit code; null: ended by a signal. */
  fetch: number | null;
  /** Whether HEAD is an ancestor of the fetched commit. */
  ancestor: boolean;
  /** `rev-list --count <head>..<fetched>` and `<fetched>..<head>`. */
  behind: number;
  ahead: number;
  /** The new commits, newest first: what `log` lists (at most its --max-count). */
  commits: { id: string; subject: string }[];
  /** `ls-tree` of src/store/migrations.ts per commit id: its output (default the same blob). */
  migrations: Record<string, string>;
  /** What `merge --ff-only` answers. */
  merge: Partial<RunResult>;
  /** What HEAD and `status` say after a merge that failed. */
  afterFailedMerge: { head: string; status: string };
  /** What HEAD says after a merge that ended with 0 (default: the fetched commit). */
  headAfterMerge: string | null;
  /** `rev-parse --git-path index.lock`'s answer. */
  indexLock: string;
  /** `ls-files -z --others --exclude-standard` before the merge, and after one that failed (null: the same). */
  untracked: string;
  untrackedAfterFailedMerge: string | null;
  /** What the branch, HEAD and the status are once the fetch has run (each default: as before). */
  afterFetch: { branch?: string | null; head?: string; status?: string };
  /** The launcher's exit code (null: not started, or ended by a signal). */
  launcher: number | null;
  /** Answers that replace the script's, keyed by the arguments after `-C <root>` joined by spaces. */
  answers: Record<string, Partial<RunResult>>;
  /** Called at every call, before it is answered (a test records what the world was like then). */
  onCall: (call: RunCall, interactive: boolean) => void;
}

/** A repository one commit behind its upstream, clean, on `main` following `origin/main`. */
export function scriptedRepo(root: string, over: Partial<ScriptedRepo> = {}): ScriptedRepo {
  return {
    root,
    toplevel: root,
    branch: 'main',
    upstream: { ref: 'refs/remotes/origin/main', remote: 'origin', short: 'origin/main' },
    status: '',
    head: OLD,
    fetched: NEW,
    fetch: 0,
    ancestor: true,
    behind: 1,
    ahead: 0,
    commits: [{ id: NEW, subject: 'the new commit' }],
    migrations: {},
    merge: {},
    afterFailedMerge: { head: OLD, status: '' },
    headAfterMerge: null,
    indexLock: '.git/index.lock',
    untracked: '',
    untrackedAfterFailedMerge: null,
    afterFetch: {},
    launcher: 0,
    answers: {},
    onCall: () => {},
    ...over,
  };
}

/** The arguments of a git call after `-C <root>`; an Error for a call that is not of that form. */
export function gitArgs(call: RunCall, root: string): readonly string[] {
  if (call.command !== 'git' || call.args[0] !== '-C' || call.args[1] !== root) {
    throw new Error(`not a git -C ${root} call: ${call.command} ${call.args.join(' ')}`);
  }
  return call.args.slice(2);
}

/** The sub-command of a git call: its first argument after `-C <root>` that is not an option. */
export function subCommand(call: RunCall, root: string): string {
  return gitArgs(call, root).find((arg) => !arg.startsWith('-')) ?? '';
}

const DEFAULT_MIGRATIONS = migrationsEntry('5'.repeat(40));

/**
 * A fake runner that plays git for `repo`: it answers the calls `skydeck update` makes, and fails
 * the test (an Error) for any other. The fetch and the launcher go through runInteractive.
 */
export function scriptedGit(repo: ScriptedRepo): FakeRunner {
  /** null until the merge; then whether it ended with 0. */
  let merged: boolean | null = null;
  let fetched = false;
  const branch = (): string | null =>
    fetched && repo.afterFetch.branch !== undefined ? repo.afterFetch.branch : repo.branch;
  const answer = (call: RunCall): RunResult => {
    repo.onCall(call, false);
    const args = gitArgs(call, repo.root);
    const given = repo.answers[args.join(' ')];
    if (given !== undefined) return runResult(given);
    const [first, ...rest] = args;
    const line = (text: string): RunResult => runResult({ stdout: `${text}\n` });
    switch (`${first} ${rest[0] ?? ''}`) {
      case 'rev-parse --show-toplevel':
        return repo.toplevel === null
          ? runResult({
              code: 128,
              stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
            })
          : line(repo.toplevel);
      case 'symbolic-ref --quiet': {
        const name = branch();
        return name === null ? runResult({ code: 1 }) : line(`refs/heads/${name}`);
      }
      case 'ls-files -z':
        return runResult({
          stdout:
            merged === false ? (repo.untrackedAfterFailedMerge ?? repo.untracked) : repo.untracked,
        });
      case 'for-each-ref --format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:short)%00': {
        const { ref, remote, short } = repo.upstream;
        return line(`${rest[1] ?? ''}\0${ref}\0${remote}\0${short}\0`);
      }
      case '--no-optional-locks status':
        return runResult({
          stdout:
            merged === false
              ? repo.afterFailedMerge.status
              : fetched
                ? (repo.afterFetch.status ?? repo.status)
                : repo.status,
        });
      case 'rev-parse --git-path':
        if (rest[1] === 'index.lock') return line(repo.indexLock);
        break;
      case 'rev-parse --verify': {
        const rev = rest[1] ?? '';
        if (rev === 'HEAD^{commit}') {
          if (merged === null)
            return line(fetched ? (repo.afterFetch.head ?? repo.head) : repo.head);
          return line(merged ? (repo.headAfterMerge ?? repo.fetched) : repo.afterFailedMerge.head);
        }
        if (rev === `${repo.upstream.ref}^{commit}`) return line(repo.fetched);
        break;
      }
      case 'merge-base --is-ancestor':
        return runResult({ code: repo.ancestor ? 0 : 1 });
      case 'rev-list --count': {
        const range = rest[1] ?? '';
        if (range === `${repo.head}..${repo.fetched}`) return line(String(repo.behind));
        if (range === `${repo.fetched}..${repo.head}`) return line(String(repo.ahead));
        break;
      }
      case 'log --no-show-signature': {
        const max = Number(
          /^--max-count=([0-9]+)$/.exec(
            rest.find((a) => a.startsWith('--max-count=')) ?? '',
          )?.[1] ?? 'NaN',
        );
        return runResult({
          stdout: repo.commits
            .slice(0, max)
            .map((c) => `${c.id}\0${c.subject}\0`)
            .join(''),
        });
      }
      case 'ls-tree --full-tree': {
        const id = rest[2] ?? '';
        return runResult({ stdout: repo.migrations[id] ?? DEFAULT_MIGRATIONS });
      }
      case `merge --ff-only`: {
        const result = runResult(repo.merge);
        merged = result.code === 0 && !result.timedOut;
        return result;
      }
    }
    throw new Error(`the scripted git has no answer for: git ${call.args.join(' ')}`);
  };
  const interactive = (call: RunCall): number | null => {
    repo.onCall(call, true);
    if (call.command === 'git') {
      const args = gitArgs(call, repo.root);
      if (args[0] === 'fetch') {
        fetched = true;
        return repo.fetch;
      }
      throw new Error(`the scripted git has no interactive answer for: git ${call.args.join(' ')}`);
    }
    return repo.launcher;
  };
  return fakeRunner(answer, interactive);
}

/**
 * `skydeck update <args>` on `platform` — only once its app root is checked to lie inside the
 * sandbox (hazard 1: the test platforms' default app root is this repository).
 */
export async function runUpdate(platform: Platform, s: Sandbox, args: string[] = []): Promise<Run> {
  insideSandbox(s, platform.appRoot);
  return run(platform, ['update', ...args]);
}

/**
 * runUpdate on an io the test made itself (capture()), so that it can deliver signals during the
 * run (`captured.signal`); the same check of the app root first.
 */
export async function runUpdateOn(
  platform: Platform,
  s: Sandbox,
  captured: Captured,
  args: string[] = [],
): Promise<Run> {
  insideSandbox(s, platform.appRoot);
  const code = await main(['update', ...args], { io: captured.io, platform });
  return { code, stdout: captured.stdout(), stderr: captured.stderr(), prompts: captured.prompts };
}
