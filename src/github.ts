/**
 * Pull requests (design 7.3): the key, the batched status fetch through `gh api graphql`, and the
 * chip a list row shows. Only `Runner`, `Clock` and `Store` reach the outside world, so a test
 * answers `gh` with a fake runner and never touches the network.
 */

import { nsFromMs } from './platform/time.ts';
import type { Clock, Ns, RunResult, Runner } from './platform/types.ts';
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
    (pr) =>
      pr.state !== 'merged' &&
      pr.state !== 'closed' &&
      (force || pr.okAtNs === null || pr.okAtNs < staleBefore),
  );
}

// What one pull request is asked for. The same selection serves every alias of a batch.
const PULL_REQUEST_FIELDS =
  'title state isDraft reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';

/**
 * The `gh` arguments for one batch (1 to BATCH_SIZE keys): `api graphql`, the query, then one
 * owner, repository and number variable per key. Values never appear inside the query text, so
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
  const args = ['api', 'graphql', '-f', `query=query(${declarations}) { ${selections} }`];
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

/** The message of the first `errors[]` entry whose path starts with `alias`; null when none has one. */
function errorFor(errors: unknown, alias: string): string | null {
  if (!Array.isArray(errors)) {
    return null;
  }
  for (const entry of errors as unknown[]) {
    if (
      isRecord(entry) &&
      Array.isArray(entry['path']) &&
      entry['path'][0] === alias &&
      typeof entry['message'] === 'string'
    ) {
      return entry['message'];
    }
  }
  return null;
}

/**
 * Maps one `gh` result to a fetch result per key url.
 * - timedOut → every key: "gh timed out after 10 s"; notFound → "gh is not installed".
 * - stdout not JSON with a `data` object → every key: the first line of stderr, else
 *   "gh exited <code>" ("gh was killed by a signal" when there is no code).
 * - otherwise per alias p<i>: a `pullRequest` object → ok (see `readPullRequest`); null or
 *   missing → failed with the message of the `errors[]` entry whose path[0] is p<i>, else
 *   "not found".
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
}

/** One `gh` call for one batch. A runner that rejects (gh not executable, say) fails the batch. */
async function fetchBatch(deps: Deps, keys: readonly PrKey[]): Promise<Map<string, PrFetchResult>> {
  const args = batchArgs(keys);
  let result: RunResult;
  try {
    result = await deps.runner.run('gh', args, { timeoutMs: GH_TIMEOUT_MS });
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
 */
export async function fetchPrs(
  deps: Deps,
  urls: readonly string[],
): Promise<{ fetched: number; failed: number }> {
  const rows = new Map(deps.store.prs().map((row) => [row.url, row]));
  const keys: PrKey[] = [];
  for (const url of new Set(urls)) {
    const row = rows.get(url);
    if (row !== undefined) {
      keys.push({ url: row.url, owner: row.owner, repo: row.repo, number: row.number });
    }
  }
  let fetched = 0;
  let failed = 0;
  for (let start = 0; start < keys.length; start += BATCH_SIZE) {
    const results = await fetchBatch(deps, keys.slice(start, start + BATCH_SIZE));
    // The transaction is synchronous: it holds no lock while `gh` is running.
    deps.store.transaction(() => {
      for (const [url, result] of results) {
        deps.store.savePrResult(url, result);
      }
    });
    for (const result of results.values()) {
      if (result.ok) {
        fetched++;
      } else {
        failed++;
      }
    }
  }
  return { fetched, failed };
}

/** fetchPrs of the urls of prsDue(store.prs(), now, refreshMinutes, force). */
export function refreshPrs(
  deps: Deps,
  options: { force: boolean; refreshMinutes: number },
): Promise<{ fetched: number; failed: number }> {
  const due = prsDue(deps.store.prs(), deps.clock.nowNs(), options.refreshMinutes, options.force);
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
