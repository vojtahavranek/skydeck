/**
 * Pull requests (design 7.3): the key, the batched status fetch through `gh api graphql`, and the
 * chip a list row shows. Only `Runner`, `Clock` and `Store` reach the outside world, so a test
 * answers `gh` with a fake runner and never touches the network.
 */

import { nsFromMs } from './platform/time.ts';
import type { Clock, Env, Ns, RunResult, Runner } from './platform/types.ts';
import type { Store } from './store/store.ts';
import type { PrChecks, PrFetchResult, PrReview, PrRow, PrState } from './store/types.ts';

export interface PrKey {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

const MAX_PR_NUMBER = 2147483647;

// Scheme and host are case-insensitive; everything after the host is matched case-sensitively.
const PREFIX = /^https?:\/\/(?:www\.)?github\.com\//i;
// <owner>/<repo>/pull/<number>, then the end or a '/', '?' or '#' (anything after is stripped).
// The number has no sign and no leading zero, so '0', '01' and '12abc' do not match.
const REST = /^([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)(?:[/?#]|$)/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * 7.3 key. Accepts http(s)://github.com/<owner>/<repo>/pull/<number> (host case-insensitive,
 * optional "www."), anything after the number stripped (/files, ?x, #y). Validates owner, repo
 * (not '.' or '..') and number (1..2147483647, no leading zeros). Returns the lowercased url
 * `https://github.com/<owner>/<repo>/pull/<number>` and lowercased owner/repo; null when invalid.
 */
export function prKey(text: string): PrKey | null {
  const prefix = PREFIX.exec(text);
  if (prefix === null) return null;
  const match = REST.exec(text.slice(prefix[0].length));
  if (match === null) return null;
  const [, owner, repo, digits] = match;
  if (owner === undefined || repo === undefined || digits === undefined) return null;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  const number = Number(digits);
  if (number > MAX_PR_NUMBER) return null;
  const lowerOwner = owner.toLowerCase();
  const lowerRepo = repo.toLowerCase();
  return {
    url: `https://github.com/${lowerOwner}/${lowerRepo}/pull/${number}`,
    owner: lowerOwner,
    repo: lowerRepo,
    number,
  };
}

export const BATCH_SIZE = 50;
export const GH_TIMEOUT_MS = 10_000;

const MS_PER_MINUTE = 60_000;

/** Merged and closed pull requests are never fetched again (design 7.3). */
function isFinal(pr: PrRow): boolean {
  return pr.state === 'merged' || pr.state === 'closed';
}

/**
 * Non-final (state not merged/closed) rows whose okAtNs is null or older than refreshMinutes; all
 * non-final rows when force. A merged or closed pull request is never fetched again, even when
 * forced (design 7.3).
 */
export function prsDue(
  prs: readonly PrRow[],
  nowNs: Ns,
  refreshMinutes: number,
  force: boolean,
): PrRow[] {
  const staleBefore = nowNs - nsFromMs(Math.round(refreshMinutes * MS_PER_MINUTE));
  return prs.filter(
    (pr) => !isFinal(pr) && (force || pr.okAtNs === null || pr.okAtNs < staleBefore),
  );
}

// What one pull request is asked for. The same selection serves every alias of a batch.
const PULL_REQUEST_FIELDS =
  'title state isDraft reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';

/**
 * The `gh` arguments for one batch (1 to BATCH_SIZE keys): `api graphql --hostname github.com`
 * (so `GH_HOST` or a configured enterprise host cannot send the question elsewhere), the query,
 * then one owner, repository and number variable per key. Values never appear inside the query text, so
 * nothing a key holds can change what is asked. Throws RangeError for an empty or oversized batch
 * (a bug of the caller: the query for no pull request is not valid GraphQL).
 */
export function batchArgs(keys: readonly PrKey[]): string[] {
  if (keys.length < 1 || keys.length > BATCH_SIZE) {
    throw new RangeError(`a batch holds 1 to ${BATCH_SIZE} pull requests, not ${keys.length}`);
  }
  const declarations = keys
    .map((_, i) => `$o${i}: String!, $r${i}: String!, $n${i}: Int!`)
    .join(', ');
  const selections = keys
    .map(
      (_, i) =>
        `p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ${PULL_REQUEST_FIELDS} } }`,
    )
    .join(' ');
  const args = [
    'api',
    'graphql',
    '--hostname',
    'github.com',
    '-f',
    `query=query(${declarations}) { ${selections} }`,
  ];
  keys.forEach((key, i) => {
    args.push('-f', `o${i}=${key.owner}`, '-f', `r${i}=${key.repo}`, '-F', `n${i}=${key.number}`);
  });
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first line of `text` that has anything on it, trimmed; null when there is none. */
function firstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      return trimmed;
    }
  }
  return null;
}

function failAll(keys: readonly PrKey[], atNs: Ns, error: string): Map<string, PrFetchResult> {
  return new Map(keys.map((key) => [key.url, { ok: false, atNs, error }]));
}

function reviewOf(decision: unknown): PrReview | null {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'REVIEW_REQUIRED':
      return 'review-required';
    default:
      return null;
  }
}

function checksOf(rollup: unknown): PrChecks | null {
  switch (rollup) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return null;
  }
}

function stateOf(state: unknown, isDraft: unknown): PrState | null {
  switch (state) {
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    case 'OPEN':
      return isDraft === true ? 'draft' : 'open';
    default:
      return null;
  }
}

/** The state of the last commit's check rollup; null for no commit, no rollup or a malformed one. */
function rollupState(pullRequest: Record<string, unknown>): unknown {
  const commits = pullRequest['commits'];
  const nodes = isRecord(commits) ? commits['nodes'] : undefined;
  const node: unknown = Array.isArray(nodes) ? nodes[0] : undefined;
  const commit = isRecord(node) ? node['commit'] : undefined;
  const rollup = isRecord(commit) ? commit['statusCheckRollup'] : undefined;
  return isRecord(rollup) ? rollup['state'] : undefined;
}

/**
 * One `pullRequest` object of the answer. A state this code does not know (GitHub added one) is a
 * failure, not a guess: a pull request that cannot be understood is never shown as closed.
 */
function readPullRequest(pullRequest: Record<string, unknown>, atNs: Ns): PrFetchResult {
  const title = pullRequest['title'];
  if (typeof title !== 'string') {
    return { ok: false, atNs, error: 'GitHub answered without a title' };
  }
  const state = stateOf(pullRequest['state'], pullRequest['isDraft']);
  if (state === null) {
    return { ok: false, atNs, error: 'GitHub answered with a pull request state not known here' };
  }
  return {
    ok: true,
    atNs,
    title,
    state,
    review: reviewOf(pullRequest['reviewDecision']),
    checks: checksOf(rollupState(pullRequest)),
  };
}

/**
 * The message of the first `errors[]` entry whose path starts with `alias`; failing that, of the
 * first entry that names no path (GitHub's own "something went wrong ... a timeout" error has
 * none: it concerns the whole query); null when there is neither. An entry about another alias is
 * never borrowed.
 */
function errorFor(errors: unknown, alias: string): string | null {
  if (!Array.isArray(errors)) {
    return null;
  }
  let general: string | null = null;
  for (const entry of errors as unknown[]) {
    if (!isRecord(entry) || typeof entry['message'] !== 'string') {
      continue;
    }
    const message = entry['message'];
    const path = entry['path'];
    if (Array.isArray(path) && path.length > 0) {
      if (path[0] === alias) {
        return message;
      }
    } else if (general === null) {
      general = message;
    }
  }
  return general;
}

/**
 * Maps one `gh` result to a fetch result per key url.
 * - timedOut → every key: "gh timed out after 10 s"; notFound → "gh is not installed".
 * - stdout not JSON with a `data` object → every key: with exit code 0 "gh returned output skydeck
 *   could not read" (stderr is not used: gh succeeded, and a line on it may concern one pull
 *   request only); otherwise the first line of stderr, else "gh exited <code>" ("gh was killed by a
 *   signal" when there is no code).
 * - otherwise per alias p<i>: a `pullRequest` object → ok (see `readPullRequest`); null or
 *   missing → failed with the message of the `errors[]` entry whose path[0] is p<i>, else of the
 *   first entry with no path, else "not found".
 * `gh` exits non-zero when some aliases fail; the per-alias data is still used.
 */
export function parseBatch(
  keys: readonly PrKey[],
  result: RunResult,
  atNs: Ns,
): Map<string, PrFetchResult> {
  if (result.timedOut) {
    return failAll(keys, atNs, `gh timed out after ${GH_TIMEOUT_MS / 1000} s`);
  }
  if (result.notFound) {
    return failAll(keys, atNs, 'gh is not installed');
  }
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    answer = null;
  }
  const data = isRecord(answer) ? answer['data'] : undefined;
  if (!isRecord(answer) || !isRecord(data)) {
    if (result.code === 0) {
      // gh succeeded, so a line on stderr is no explanation, and may be about one pull request only.
      return failAll(keys, atNs, 'gh returned output skydeck could not read');
    }
    const reason = result.code === null ? 'gh was killed by a signal' : `gh exited ${result.code}`;
    return failAll(keys, atNs, firstLine(result.stderr) ?? reason);
  }
  return new Map(
    keys.map((key, i) => {
      const alias = `p${i}`;
      const repository = data[alias];
      const pullRequest = isRecord(repository) ? repository['pullRequest'] : undefined;
      const outcome: PrFetchResult = isRecord(pullRequest)
        ? readPullRequest(pullRequest, atNs)
        : { ok: false, atNs, error: errorFor(answer['errors'], alias) ?? 'not found' };
      return [key.url, outcome];
    }),
  );
}

interface Deps {
  runner: Runner;
  clock: Clock;
  store: Store;
  /**
   * The environment of the calling process (`platform.env`). `gh` always runs in it with a few
   * variables changed (see `ghEnvironment`). Required, so that a caller cannot skip that by
   * forgetting it: this file may not read `process.env`, and `RunOptions.env` replaces the child's
   * whole environment.
   */
  env: Env;
}

/**
 * What `gh` must not inherit: `GH_HOST` (another host) and the two variables that make it colour
 * its JSON as for a terminal. `CLICOLOR_FORCE` beats `NO_COLOR` in `gh`, so setting `NO_COLOR` is
 * not enough.
 */
const GH_REMOVED_VARIABLES: ReadonlySet<string> = new Set([
  'GH_HOST',
  'GH_FORCE_TTY',
  'CLICOLOR_FORCE',
]);

/**
 * The environment `gh` runs in: the caller's, so that `gh` still finds its login, without
 * `GH_REMOVED_VARIABLES`, and with `GH_PROMPT_DISABLED` and `NO_COLOR` set so that it can neither
 * wait for a person nor colour.
 */
function ghEnvironment(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !GH_REMOVED_VARIABLES.has(name)) {
      result[name] = value;
    }
  }
  result['GH_PROMPT_DISABLED'] = '1';
  result['NO_COLOR'] = '1';
  return result;
}

/** One `gh` call for one batch. A runner that rejects (gh not executable, say) fails the batch. */
async function fetchBatch(deps: Deps, keys: readonly PrKey[]): Promise<Map<string, PrFetchResult>> {
  const args = batchArgs(keys);
  let result: RunResult;
  try {
    result = await deps.runner.run('gh', args, {
      timeoutMs: GH_TIMEOUT_MS,
      env: ghEnvironment(deps.env),
    });
  } catch (error) {
    const reason = firstLine(error instanceof Error ? error.message : String(error));
    return failAll(keys, deps.clock.nowNs(), `gh could not be run: ${reason ?? 'unknown error'}`);
  }
  return parseBatch(keys, result, deps.clock.nowNs());
}

/**
 * Fetches exactly the given pull requests (urls of existing prs rows; others are ignored, and a
 * repeated url is fetched once) in batches of BATCH_SIZE through `gh api graphql`, one batch after
 * the other, and saves every result with store.savePrResult. A failure of `gh` is a failed result
 * saved on the rows, never an exception; there is no call at all for an empty list.
 *
 * A merged or closed pull request is never fetched again (7.3): it is left out when choosing, and
 * a result is dropped when its row has become merged or closed in the meantime (another refresh
 * was faster), so an older or failed answer can never overwrite a final status. Dropped results
 * count neither as fetched nor as failed.
 */
export async function fetchPrs(
  deps: Deps,
  urls: readonly string[],
): Promise<{ fetched: number; failed: number }> {
  const rows = new Map(deps.store.prs().map((row) => [row.url, row]));
  const keys: PrKey[] = [];
  for (const url of new Set(urls)) {
    const row = rows.get(url);
    if (row !== undefined && !isFinal(row)) {
      keys.push({ url: row.url, owner: row.owner, repo: row.repo, number: row.number });
    }
  }
  let fetched = 0;
  let failed = 0;
  for (let start = 0; start < keys.length; start += BATCH_SIZE) {
    const results = await fetchBatch(deps, keys.slice(start, start + BATCH_SIZE));
    // The transaction is synchronous: it holds no lock while `gh` is running.
    deps.store.transaction(() => {
      const current = new Map(deps.store.prs().map((row) => [row.url, row]));
      for (const [url, result] of results) {
        const row = current.get(url);
        if (row === undefined || isFinal(row)) {
          continue;
        }
        deps.store.savePrResult(url, result);
        if (result.ok) {
          fetched++;
        } else {
          failed++;
        }
      }
    });
  }
  return { fetched, failed };
}

/**
 * fetchPrs of the urls of prsDue(rows, now, refreshMinutes, force), where `rows` are the store's
 * pull requests that at least one session still has attached: one whose every attachment was
 * detached (`pr rm`), or that was never attached, is shown nowhere and is not asked about.
 */
export function refreshPrs(
  deps: Deps,
  options: { force: boolean; refreshMinutes: number },
): Promise<{ fetched: number; failed: number }> {
  const attached = new Set(
    deps.store
      .sessionPrs()
      .filter((link) => link.detachedAtNs === null)
      .map((link) => link.url),
  );
  const due = prsDue(
    deps.store.prs().filter((pr) => attached.has(pr.url)),
    deps.clock.nowNs(),
    options.refreshMinutes,
    options.force,
  );
  return fetchPrs(
    deps,
    due.map((pr) => pr.url),
  );
}

/** 7.3 chip, worst first. */
export const CHIP_ORDER = [
  'cant-read',
  'unfetched',
  'checks-failing',
  'changes-requested',
  'checks-pending',
  'review-required',
  'draft',
  'approved-green',
  'merged',
  'closed',
] as const;
export type ChipLevel = (typeof CHIP_ORDER)[number];

/**
 * Level of one pull request: error non-null → cant-read; state null (never fetched, D11) →
 * unfetched; merged → merged; closed → closed; otherwise (open or draft) the first that applies
 * of: checks failing → checks-failing; review changes-requested → changes-requested; checks
 * pending → checks-pending; review review-required → review-required; draft → draft; else
 * approved-green.
 */
export function prLevel(pr: PrRow): ChipLevel {
  if (pr.error !== null) {
    return 'cant-read';
  }
  if (pr.state === null) {
    return 'unfetched';
  }
  if (pr.state === 'merged' || pr.state === 'closed') {
    return pr.state;
  }
  if (pr.checks === 'failing') {
    return 'checks-failing';
  }
  if (pr.review === 'changes-requested') {
    return 'changes-requested';
  }
  if (pr.checks === 'pending') {
    return 'checks-pending';
  }
  if (pr.review === 'review-required') {
    return 'review-required';
  }
  return pr.state === 'draft' ? 'draft' : 'approved-green';
}

/** The worst level among `prs` and their count; null for an empty list. */
export function chipFor(prs: readonly PrRow[]): { level: ChipLevel; count: number } | null {
  let worst: ChipLevel | null = null;
  for (const pr of prs) {
    const level = prLevel(pr);
    if (worst === null || CHIP_ORDER.indexOf(level) < CHIP_ORDER.indexOf(worst)) {
      worst = level;
    }
  }
  return worst === null ? null : { level: worst, count: prs.length };
}
