# skydeck step 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build step 1 of skydeck as specified in [`docs/design.md`](../design.md): recording through
a `sh` hook, the session list, labels/groups/notes/done, pull requests, resume, restore, install.

**Architecture:** A POSIX `sh` hook spools one file per `SessionStart`/`SessionEnd`; every other
command ingests the spool, reconciles with live processes and scans transcripts into SQLite, then
derives state on the fly. Modules follow design section 11; everything that knows a Claude Code
format sits in `src/claude/`, everything that touches the clock, the environment, `/proc` or runs a
program sits in `src/platform/`.

**Tech Stack:** TypeScript on Node.js ≥ 24.12 through type stripping, `node:sqlite`, `node:test`,
`node:assert/strict`, `node:util` `parseArgs`; POSIX `sh`; no runtime dependencies.

---

## 0. How to use this plan

**Execution model.** Every task below is one pull request, implemented by a fresh agent that has
only `docs/design.md`, this plan and the repository. Each task leaves `main` working with CI green
(`npm run check` on Node 24.12 and 24, and `shellcheck bin/skydeck*`). Tasks in the same wave touch
disjoint files and are built in parallel in separate git worktrees.

**What is fixed here, and what is yours.** Section 2 (**Contracts**) fixes every type shared
between modules and the complete exported API of every module. You must export exactly those names
with exactly those signatures, because another agent is writing the code on the other side of the
interface at the same time. You write the function bodies, test-first. Where a body *is* the
contract (migration 1, the hook's output, the flag table, the JSON shapes, quoting rules, file
formats), the plan gives it in full; copy it.

You may add **private** helpers (not exported, or exported only from a file under `test/`). If you
believe a contract is wrong, do not change it silently: implement it as written, and say so in the
pull-request description.

**Per-task workflow** (every task, in this order):

- [ ] Branch from the latest `origin/main`: `git switch -c task-<N>-<slug> origin/main`.
- [ ] Read the design sections the task names, and Contracts section 2.1 (conventions).
- [ ] Write the test file(s) with every listed test case. Run `npm test` — the new tests fail
      (missing module or wrong result), the old ones pass.
- [ ] Implement. Run `npm run format`, then `npm run check` (format check, type check, tests)
      until it passes. Run `shellcheck bin/skydeck*` when the task touches `bin/` (CI runs it too).
- [ ] When the task carries a decision of section 1a with a design update, edit `docs/design.md`
      in the same pull request (design 15).
- [ ] Check the task's **Done when** list.
- [ ] Commit (one or a few commits), push, open a pull request titled `Task <N>: <name>`, whose
      description lists the design sections implemented and any contract you think is wrong.
- [ ] Design 15: two independent reviews per pull request; check each suggestion against the code,
      this plan and the design before applying it, and answer rejected ones with the reason.

**Test rules (design 12, brief 18).** `node:test` + `node:assert/strict`. Tests never start the
real `claude`, never read or write the real `~/.claude` or the real `~/.local/...`, never use the
network. Test files mirror the source tree (`test/store/…`, `test/claude/…`,
`test/cli/commands/<name>.test.ts`). Shared helpers are in `test/helpers/`: the scaffold's
`sandbox(t)` (temporary `HOME`, `SKYDECK_HOME`, Claude home, and the only environment a child
process gets) and `capture()`; `testContext(t)`, which task 1 extends once with the fake platform
(fake clock, fake `/proc`, fake runner); `testDeck(t)` from task 8 (an opened deck on top of it).

## 1. Tasks and waves

Task 0 is the merged scaffold (pull request #2): `package.json` (scripts `format`,
`format:check`, `typecheck`, `test`, `check`), `tsconfig.json`, Prettier, CI (Node 24.12 and 24,
`shellcheck bin/skydeck*`), `bin/skydeck`, `bin/bootstrap.mjs`, `bin/node-version.mjs`,
`src/cli/main.ts` (`main`, `dispatch`), `src/cli/context.ts` (`Context`, `Io`,
`processContext`), `src/cli/command.ts` (`Command`), `src/cli/exit.ts` (`EXIT`),
`test/helpers/{sandbox,capture,context}.ts`, `test/bin/*.test.ts`, `test/cli/main.test.ts`.

| # | Task | Depends on | Wave | Size (code + tests) |
|---|---|---|---|---|
| 1 | Platform: interfaces, places, configuration, errors, `Context` and test helpers | 0 | 1 | ~650 |
| 2 | Pure helpers: `/proc` parsing, launch flags, pull-request keys | 0 | 1 | ~550 |
| 3 | The hook: `bin/skydeck-hook` and its settings entries | 1 | 2 | ~550 |
| 4 | Store | 1 | 2 | ~550 |
| 5 | Hook-input parser and its fixtures | 2 | 2 | ~450 |
| 6 | Live-session files and transcripts | 1, 2 | 2 | ~600 |
| 7 | Text and terminals: sanitiser, shell quoting, ages, launcher handoff | 1 | 2 | ~550 |
| 8 | The deck: ingest, reconcile, transcript scan | 2, 4, 5, 6 | 3 | ~600 |
| 9 | Pull requests (rest of `src/github.ts`) | 1, 2, 4 | 3 | ~500 |
| 10 | Derived state and marks | 4, 6 | 3 | ~600 |
| 11 | List model, references, label rules | 3, 7, 8, 9, 10 | 4 | ~550 |
| 12 | CLI core: error mapping, `withDeck`, argument parsing | 1, 8 | 4 | ~300 |
| 13 | Interactive list: `reduce` and `render` | 7, 9, 11 | 5 | ~550 |
| 15 | `label`, `group`, `note`, `done`, `undone`, `pr` | 9, 11, 12 | 5 | ~500 |
| 16 | `resume`, `new`, the guard and the lock | 2, 7, 11, 12 | 5 | ~550 |
| 17 | `install`, `uninstall`, `doctor` | 3, 11, 12 | 5 | ~600 |
| 14 | `ls` and `show`: text, JSON, a recorded day end to end | 12, 13 | 6 | ~550 |
| 18 | `restore` | 16 | 6 | ~550 |
| 19 | Interactive list: terminal wrapper, actions, bare `skydeck` | 13, 14, 15, 16 | 7 | ~450 |
| 20 | Documentation: `docs/install.md`, README, `docs/manual-checks.md` | all | 8 | docs only |

Twenty tasks rather than the 12–18 first estimated: the 600-line cap wins. Splitting the CLI core
(12) from the commands, and the pure interactive list (13) from its terminal wrapper (19), is what
lets wave 5 run four tasks at once.

```
wave 1:  1  2
wave 2:  3  4  5  6  7
wave 3:  8  9  10
wave 4:  11  12
wave 5:  13  15  16  17
wave 6:  14  18
wave 7:  19
wave 8:  20
```

**Disjoint files in a wave.** Every command is its own file (`src/cli/commands/<name>.ts`) with
its own test file, so command tasks never touch a shared CLI file. Shared files are edited only
in these places, never by two tasks of one wave: `src/cli/context.ts` and `test/helpers/context.ts`,
`test/helpers/capture.ts` (task 1); `src/github.ts` (created by 2 with `prKey`, completed by 9);
`src/cli/main.ts` (`dispatch`: error mapping in 12, bare `skydeck` in 19) and
`test/cli/main.test.ts` (task 19, the bare-`skydeck` test); `src/sessions/refresh.ts` (created by
8, one line added by 16); `bin/skydeck` and `test/bin/launcher.test.ts` (task 7 only). The one
exception is `docs/design.md`: several tasks of a wave record their decisions there (last column
of 1a), each editing only the sections named for it, which are disjoint within every wave; a
pull request that meets a conflict there rebases and keeps both edits.

## 1a. Decisions this plan makes where the design is silent

Each is binding for the implementer. The last column names the task that records it in
`docs/design.md` in its own pull request (design 15); `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| D1 | Nanosecond times are `bigint` in TypeScript (type `Ns`); the store reads with `readBigInts: true` and converts every non-time integer column to `number`. | `node:sqlite` on Node 24.19 throws `ERR_OUT_OF_RANGE` when it reads an integer above 2^53 as a number; `time_ns` values are ~1.8·10^18. Verified while writing this plan. | 4 (9.2: integers are read as BigInt; times are `bigint`) |
| D2 | Live-session file shapes as observed on Claude Code 2.1.323: `procStart` is a **decimal string**; `startedAt`, `updatedAt`, `statusUpdatedAt` are epoch **milliseconds** (numbers); `status` also takes the value `shell` (falls to state `running` by the 6.2 rule). | Read from 177 local files (keys and types only). | 6 (14) |
| D3 | `claudeHome` precedence: configuration key `claudeHome`, then `$CLAUDE_CONFIG_DIR`, then `<home>/.claude`. Configured paths must be absolute. | 9.1 lists both, no order. | 1 (9.1) |
| D4 | Configuration `terminal` defaults to `here`. | 7.6 names no default. | 1 (9.1) |
| D5 | The `--here` handoff file is a POSIX `sh` fragment in which every word is quoted by `shellQuote`; the launcher evaluates it after Node exits. Its path is in `$SKYDECK_HANDOFF`, created by the launcher. | The launcher must `exec` an argument list it receives from Node; `sh` cannot read NUL-separated lists. Quoting is exact, so no word is reinterpreted. | 7 (7.6: "commands are run as argument lists; the one exception is the `--here` handoff, a generated `sh` fragment in which every word is quoted by the same function as the printed fallback") |
| D6 | Spool `<random>` is the hook shell's `$$`; the temporary name is `.<final name>.tmp`; ingest reads only names ending in `.ev`. A missing `CLAUDE_PID` gives `claude_pid` empty and the name part `0`. | 5.2 lists only `sh`, `date`, `cat`, `base64`, `mkdir`, `mv`. | 3 (5.2) |
| D7 | An event without `claude_pid` is stored with `pid` 0 and `proc_start` NULL; it belongs to no live process. | `pid` is `NOT NULL`. | 5 (5.3) |
| D8 | A transcript's session id is its file name (the UUID). | 5.6 "per file: the session id". | — |
| D9 | Shared error classes (with their exit codes) live in `src/platform/errors.ts`. | `platform` is the one module everybody may import. | — |
| D10 | Field-22 parsing and `cmdline` decoding live in `src/claude/procstat.ts`; the path-flag rewrite lives in `src/claude/launch.ts`. Files inside `src/claude/` may import each other. | 5.3 and 5.5 both need field 22; 5.3 needs the flag shapes. | — |
| D11 | A pull request never fetched, with no failed attempt, is its own level `unfetched`, shown as "not fetched", ranked directly after `cant-read`. `skydeck pr add` fetches the pull request it attaches at once (same timeout; a failure leaves it `cant-read`). `skydeck ls` and `show` take `--refresh`, which makes an explicit refresh before printing (see 2.6: every pull request that the sessions the command is about have attached and that is not merged or closed, whatever its age and its last result: `ls` those it prints, so with `--all` all of them, `show` that session's; `pr refresh` all attached ones); without it they never touch the network. An automatic refresh fetches a pull request only when it was never tried or its last attempt (not its last success) is older than `prRefreshMinutes`. | 7.3 has no level for it; a fresh attachment should not look broken. | 9 (7.3: the level), 15 (7.3: `pr add`), 14 (7.3, 7.5: `--refresh`) |
| D12 | The fallback title is `YYYY-MM-DD HH:MM <basename of dir>` in UTC (`?` when there is no dir). | Deterministic tests. | 11 (7.1) |
| D13 | `Context` gains `platform`; `Io` gains `isTTY`, `size`, `readLine`, `keys` (task 1, once). Commands open the database through `withDeck` (task 12). | Brief 18: the platform task extends `Context` once. | — |
| D14 | `$VISUAL`, else `$EDITOR`, else `vi`; the value is split on spaces; the note file path is appended. | 7.1 only says `$EDITOR`. | 15 (7.1) |
| D15 | The WezTerm adapter runs `wezterm cli --no-auto-start spawn`; when `wezterm` is not found and `$WSL_DISTRO_NAME` is set, it retries with `wezterm.exe`. | 13 "Open": tabs from WSL. | 7 (7.6) |
| D16 | A resume lock is the `kv` entry `resume_lock:<session id>`, its value the creation time in ns (decimal). `acquireLock` reads it and, unless it holds, writes it inside one `store.transaction()` (BEGIN IMMEDIATE: one skydeck at a time); `sweepLocks` deletes the stale ones in one transaction at the end of every refresh (only when a first look without a transaction found some). Stale: 60 s old or older, dated 60 s or more in the future, a value that is not a time, or a `start` event of the session at or after it that names a real process (pid not 0, with a process start time: `hasProcessStartSince`). `locksDir` stays in `Places` but holds no lock. `prepareResume` hands `acquireLock` the id of the latest event of the session that its row was derived from (`DerivedSession.lastEventId`, null for none); inside the transaction, before it writes, `acquireLock` reads that id again and refuses (exit 4) when it differs. `prepareResume` refuses first when the row's own boot id (`DerivedSession.bootId`, the one the rows were derived with) is null. `prepareResumeById` refreshes and loads the rows itself right before it calls `prepareResume`, and is the entry point of every caller. | The database already serialises skydecks across processes; a lock file taken over without an atomic step would let two resumes both succeed (principle 7). Without the re-check, a skydeck that looked at the session (not running), then lost a few seconds, could take a lock that a sweep had just removed for another skydeck's resume (its start event had been ingested) and resume the session a second time. Without the boot id every recorded process looks dead and a running session cannot be seen; the row's value is used so that a failed read and a later successful one are never mixed. A start event without a process (pid 0, or no start time) cannot be the claude that a resume started, so it must not release a lock. A start event still in the spool is invisible to a row loaded before it and to the store check of the lock, so the guard refreshes and loads by itself. Fake clock in tests. | 16 (7.6) |
| D17 | `--all` restore entries are preselected relative to the last event of *their own* boot. | 7.8 defines it for the default set only. | 18 (7.8) |
| D18 | Arguments are read as Claude Code's own parser reads them: a several-value flag takes the next argument whatever it is and then the following ones up to the next flag-like one (starts with `-`, more than one character, so a lone `-` is a value); `--flag=value` consumes nothing more; a short flag takes the rest of its token as its value (`-rabc`), and a token of no-value short flags (`-cp`) is one flag; `--` ends the flags and everything after it is positional. A flag that is in no table is stored as its bare name and not passed on at resume: what follows it cannot be classified. | 7.6 "several values"; principle 4. | 2 (7.6, 5.3, principle 4) |
| D19 | Restore's selection prompt: a numbered list, the user types numbers to toggle, an empty line confirms, `q` cancels (exit 5). | 7.8 says only "confirms or changes". | 18 (7.8) |
| D20 | Install offers the first-run "mark as done" only once (kv `first_run_offered`). | 8 "Running it again changes nothing". | 17 (8) |
| D21 | An `observed` event's time is the clock at reconcile; its launch command gets the same path-flag rewrite as a spooled one. | 5.4 is silent. | 8 (5.4) |
| D22 | `<ref>` by label searches the sessions `ls --all` would show (done ones included), not only the default list. | Otherwise `skydeck undone <label>` could never work. | 11 (7.5) |
| D23 | Exit codes of `restore`: 0 when every selected session started (or was handed off), 1 when any was refused, failed to open or timed out, 5 when stopped by the memory check or cancelled at the prompt. | 7.5 names 5 only. | 18 (7.8) |
| D24 | `resume --tab` (or a `tab` default) without a tab adapter configured prints the command and exits 1; `label`/`group` take the remaining positionals joined by one space. | 7.5/7.6 are silent. | 15 (7.5: joined text), 16 (7.6: no tab adapter) |
| D25 | `src/sessions/` may import `src/github.ts` (`prKey`, `prLevel`, `chipFor` — pure functions): the scan attaches pull requests by key, the list model computes the chip. | Design 11 leaves `github` out of the sessions row. | 8 (11) |
| D26 | `SKYDECK_HOME`, `XDG_*_HOME` and `CLAUDE_CONFIG_DIR` count only when non-empty and absolute — in `resolvePlaces`, in the hook and in the launcher alike. | 9.1 "the hook resolves stateDir by the same rule". | 1 (9.1) |
| D27 | A session that is not running and has no transcript is not listed (nothing to resume; a session that never received a prompt has no transcript, design 14). | 7.2 would list it forever. | 11 (7.2) |
| D28 | Resume removes the flags that choose which session is opened or where it runs — besides 7.6's list, `--tmux` (it needs `-w`), `--teleport`, `--cloud`/`--remote`, `--desktop`, `--environment`/`--pool` with their values; flags that configure how it runs (including `--remote-control`) are kept. The deep-link flags (`--deep-link-origin`, `--deep-link-repo`, `--deep-link-last-fetch`, `--deep-link-cwd-b64`) and `--prefill`/`--prefill-b64` are removed too: they carry prompt text. `--rewind-files`, `--resume-session-at`, `--resume-drops-turn`, `--reply-on-resume`, `--attach-serve`, `--session-began-as-copy`, `--init-only` and `--handle-uri` are removed too (they choose a session or act once), and so are `--init` and `--maintenance` (one-time actions) and `--ref`, `--on-branch`, `--correlation-id` and `--forward-home-settings` (they only work with the cloud flags that are removed). `storableArgv` stores a launch command without the removed flags and positional arguments. | 7.6 predates these flags; principle 4. | 2 (7.6, and 5.3: what is stored) |

## 2. Contracts

Every exported name below must exist with exactly this signature. JSDoc comments state the
behaviour the other side relies on. Bodies are only given where the body is the contract.

### 2.1 Conventions

- Imports name the `.ts` file; types are imported with `import type`. No enums, namespaces,
  parameter properties or `declare` fields with initialisers (`erasableSyntaxOnly`).
- **Import rules (design 11).** `src/platform/` imports nothing from `src/`. `src/text/` imports
  nothing from `src/`. `src/store/` imports `platform`. `src/claude/*` imports `platform` and other
  `src/claude/*` files only (`hookinput.ts` and `launch.ts` and `procstat.ts` import nothing outside
  `src/claude/`). `src/github.ts` imports `platform`, `store`. `src/terminals/` imports
  `platform`, `text`. `src/sessions/` imports `platform`, `text`, `store`, `claude`, `github` (D25),
  and `terminals` *types* only. `src/cli/` imports anything. A type-only import of
  `src/platform/types.ts` (for `Ns`, `Files`, …) is allowed everywhere.
- Only `src/platform/real.ts` calls `Date.now`, `process.hrtime`, reads `process.env`, reads
  `/proc`, or uses `node:child_process`. Only `src/store/` imports `node:sqlite` (and it may
  `chmodSync` its own database file). Every other module reaches the file system through the
  `Files` interface only (the scaffold's command loader in `src/cli/main.ts` excepted), and may use
  `node:path`, `node:crypto` (hashes, not randomness) and `node:util`.
- Times: `type Ns = bigint` (nanoseconds since the Unix epoch). Durations in configuration are
  plain numbers in their unit (`minutes`, `days`, `seconds`). Conversion helpers are in
  `src/platform/time.ts`.
- Session ids are lowercase UUID strings `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
  `shortId` is the first 8 characters.
- Errors that end a command are `SkydeckError` subclasses (2.2.6); `dispatch` maps them to exit
  codes (2.9.2, task 12). Commands return `EXIT.*` values, never bare numbers.
  Anything else is a bug and exits 1 with `skydeck: internal error: <message>`. A failure of the
  database as a whole is not a bug: `withDeck` (2.9.3) turns it into a `SkydeckError`.

### 2.2 `src/platform/`

#### 2.2.1 `src/platform/types.ts`

```ts
export type Ns = bigint;

/** Wall clock. `sleep` resolves after `ms` milliseconds; the fake one advances its time instead. */
export interface Clock {
  nowNs(): Ns;
  sleep(ms: number): Promise<void>;
}

export interface FileInfo {
  size: number;
  mtimeNs: Ns;
  kind: 'file' | 'dir' | 'symlink' | 'other';
}

/** The file system. Every path is absolute. Errors other than "does not exist" are thrown. */
export interface Files {
  /** Follows symlinks. null when the path does not exist. */
  stat(path: string): FileInfo | null;
  /** Does not follow symlinks. null when the path does not exist. */
  lstat(path: string): FileInfo | null;
  /** UTF-8 content, null when the file does not exist. */
  readText(path: string): string | null;
  /** Bytes [start, end) of a file. Throws when it does not exist. */
  readBytes(path: string, start: number, end: number): Uint8Array;
  /** Entry names (not paths) sorted by UTF-16 code unit; [] when the directory does not exist. */
  list(dir: string): string[];
  /** Replaces the file atomically: writes `.<name>.<random>.tmp` beside it, then renames. */
  writeText(path: string, text: string, mode?: number): void;
  /** Creates the file only if it does not exist (O_EXCL). false when it already exists. */
  createExclusive(path: string, text: string): boolean;
  /** mkdir -p; `mode` applies to directories it creates. */
  mkdirp(path: string, mode?: number): void;
  rename(from: string, to: string): void;
  /** Removes a file or symlink; no error when absent. */
  remove(path: string): void;
  /** rm -rf; no error when absent. */
  removeTree(path: string): void;
  /** Creates `path` as a symlink to `target`, replacing an existing symlink or file at `path`. */
  symlink(target: string, path: string): void;
  /** The link's target, null when `path` is not a symlink. */
  readlink(path: string): string | null;
  /** The canonical path, null when it does not resolve. */
  realpath(path: string): string | null;
  /** chmod. */
  chmod(path: string, mode: number): void;
}

/** Linux /proc. Every method returns null when the file cannot be read. */
export interface Proc {
  /** /proc/sys/kernel/random/boot_id without the trailing newline. */
  bootId(): string | null;
  /** The single line of /proc/<pid>/stat without the trailing newline. */
  stat(pid: number): string | null;
  /** Raw bytes of /proc/<pid>/cmdline. */
  cmdline(pid: number): Uint8Array | null;
  /** MemAvailable from /proc/meminfo in MiB (kB / 1024, rounded down). */
  memAvailableMb(): number | null;
}

export interface RunOptions {
  cwd?: string;
  /** Written to the child's stdin, which is then closed. Without it stdin is /dev/null. */
  input?: string;
  /** Kills the child with SIGKILL after this many ms and sets `timedOut`. */
  timeoutMs?: number;
  /** The child's complete environment; omitted → the environment of this process. Tests always pass sandbox.env(). */
  env?: Readonly<Record<string, string>>;
}

export interface RunResult {
  /** Exit code; null when killed by a signal, timed out or not started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The program does not exist (ENOENT). */
  notFound: boolean;
}

/** Starts programs as argument lists, never through a shell. */
export interface Runner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Inherits stdin/stdout/stderr (for $EDITOR). Resolves with the exit code, null on signal or ENOENT. */
  runInteractive(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<number | null>;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Everything the outside world provides. Tests build one with test/helpers/platform.ts. */
export interface Platform {
  clock: Clock;
  files: Files;
  proc: Proc;
  runner: Runner;
  env: Env;
  homeDir: string;
  cwd: string;
  /** A new random lowercase UUID (crypto.randomUUID in the real platform). */
  uuid(): string;
  /** Absolute path of the running Node.js binary (process.execPath). */
  nodePath: string;
  /** process.versions.node, e.g. "24.19.0". */
  nodeVersion: string;
  /** Absolute path of the skydeck checkout (the directory holding bin/ and src/). */
  appRoot: string;
}
```

#### 2.2.2 `src/platform/real.ts`

```ts
/** The real platform: Date/hrtime clock, node:fs, /proc, node:child_process, process.env. */
export function realPlatform(): Platform;
```

`nowNs()` is `BigInt(Date.now()) * 1_000_000n + (sub-millisecond part from process.hrtime.bigint())`
or simply `BigInt(Date.now()) * 1_000_000n`; either is fine, but it must never go backwards within
one process. `appRoot` is `fileURLToPath(new URL('../../', import.meta.url))` without the trailing
slash.

#### 2.2.3 `src/platform/time.ts`

```ts
export const NS_PER_MS = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;
export const NS_PER_MINUTE = 60n * NS_PER_SECOND;
export const NS_PER_DAY = 86_400n * NS_PER_SECOND;

/** "2026-11-12T14:03:05.123Z" (UTC, milliseconds, truncated). */
export function isoFromNs(ns: Ns): string;
/** Epoch milliseconds (integer number) to Ns. */
export function nsFromMs(ms: number): Ns;
/** Parses an ISO 8601 timestamp (as in transcripts); null when Date.parse fails. */
export function nsFromIso(iso: string): Ns | null;
```

#### 2.2.4 `src/platform/paths.ts`

```ts
export interface Places {
  dataDir: string;      // skydeck.db, the node and skydeck-hook links
  stateDir: string;     // spool/, locks/, hook.log
  configDir: string;    // config.json
  claudeHome: string;
  dbPath: string;       // <dataDir>/skydeck.db
  hookPath: string;     // <dataDir>/skydeck-hook
  nodeLink: string;     // <dataDir>/node
  spoolDir: string;     // <stateDir>/spool
  badDir: string;       // <stateDir>/spool/bad
  locksDir: string;     // <stateDir>/locks (created; unused since task 16: resume locks are kv entries, D16)
  hookLog: string;      // <stateDir>/hook.log
  configPath: string;   // <configDir>/config.json
  binLink: string;      // <homeDir>/.local/bin/skydeck
}

/**
 * Design 9.1. An env value that is empty or not absolute counts as unset.
 * SKYDECK_HOME → <it>/data, <it>/state, <it>/config. Else XDG_DATA_HOME / XDG_STATE_HOME /
 * XDG_CONFIG_HOME + "/skydeck", defaulting to <homeDir>/.local/share, /.local/state, /.config.
 * claudeHome: `configuredClaudeHome` (from config.json), else CLAUDE_CONFIG_DIR, else <homeDir>/.claude.
 */
export function resolvePlaces(env: Env, homeDir: string, configuredClaudeHome: string | null): Places;

/** Only the config directory, needed before config.json can be read. */
export function resolveConfigDir(env: Env, homeDir: string): string;
```

#### 2.2.5 `src/platform/config.ts`

```ts
export interface Config {
  terminal: 'here' | 'wezterm';
  wezterm: { domain: string | null };
  groupPattern: string;               // a RegExp source
  firstRunDoneAfterDays: number;
  prRefreshMinutes: number;
  restoreBatch: number;
  restoreMinFreeMb: number;
  restoreStartTimeoutSeconds: number;
  claudeHome: string | null;
  claudeCommand: string;
}

export const DEFAULT_CONFIG: Config = {
  terminal: 'here',
  wezterm: { domain: null },
  groupPattern: '^[A-Z][A-Z0-9]+-[0-9]+',
  firstRunDoneAfterDays: 7,
  prRefreshMinutes: 5,
  restoreBatch: 3,
  restoreMinFreeMb: 4096,
  restoreStartTimeoutSeconds: 120,
  claudeHome: null,
  claudeCommand: 'claude',
};

/**
 * Parses config.json text and merges it over DEFAULT_CONFIG. Throws ConfigError naming `source`
 * and the key on: invalid JSON; a top level that is not an object; an unknown key (also inside
 * `wezterm`); a wrong type; `terminal` not here|wezterm; a number that is not a positive integer;
 * `groupPattern` that `new RegExp` rejects; `claudeHome` not absolute; `claudeCommand` empty.
 */
export function parseConfig(text: string, source: string): Config;

/** DEFAULT_CONFIG when the file does not exist, else parseConfig(content, path). */
export function loadConfig(files: Files, configPath: string): Config;
```

#### 2.2.6 `src/platform/errors.ts` (body is the contract)

```ts
export type ExitCode = 1 | 2 | 3 | 4 | 5;

export class SkydeckError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = 1) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}
export class ConfigError extends SkydeckError {
  constructor(message: string) { super(message, 1); }
}
export class UsageError extends SkydeckError {
  constructor(message: string) { super(message, 2); }
}
export class RefError extends SkydeckError {
  readonly candidates: readonly { id: string; title: string }[];
  constructor(message: string, candidates: readonly { id: string; title: string }[]) {
    super(message, 3);
    this.candidates = candidates;
  }
}
export class ResumeRefusedError extends SkydeckError {
  constructor(message: string) { super(message, 4); }
}
export class RestoreStoppedError extends SkydeckError {
  constructor(message: string) { super(message, 5); }
}
```

#### 2.2.7 Test helpers (task 1)

```ts
// test/helpers/platform.ts (new)
/** The constants of section 3, shared by every test. */
export const T0: Ns, SEC: Ns, S1: string, S2: string, S3: string, BOOT_A: string, BOOT_B: string;
export interface FakeClock extends Clock {
  setNs(ns: Ns): void;
  advanceMs(ms: number): void;      // sleep(ms) calls this and resolves on the next microtask
}
export function fakeClock(startNs: Ns): FakeClock;

/** cmdline is encoded as each argument followed by NUL; [] encodes to zero bytes. */
export interface FakeProcess { stat: string; cmdline: readonly string[] }
export interface FakeProc extends Proc {
  setBootId(id: string | null): void;
  setProcess(pid: number, p: FakeProcess | null): void;
  setMemAvailableMb(mb: number | null): void;
}
export function fakeProc(init?: { bootId?: string | null; processes?: Record<number, FakeProcess>; memAvailableMb?: number | null }): FakeProc;

/** A realistic /proc/<pid>/stat line whose field 22 is `procStart`. `comm` may contain spaces and ')'. */
export function statLine(pid: number, procStart: number, comm?: string): string;

export interface RunCall { command: string; args: readonly string[]; options: RunOptions | undefined }
export interface FakeRunner extends Runner {
  calls: RunCall[];
  interactiveCalls: RunCall[];
}
/** `handler` answers run(); runInteractive() answers with `interactive` (default 0). */
export function fakeRunner(
  handler?: (call: RunCall) => RunResult | Promise<RunResult>,
  interactive?: (call: RunCall) => number | null,
): FakeRunner;
export function runResult(partial: Partial<RunResult>): RunResult;   // defaults: code 0, '', '', false, false

export interface TestPlatformOptions {
  /** Passed to sandbox.env(); a function gets the sandbox first (for paths inside it). */
  env?: Record<string, string | undefined> | ((s: Sandbox) => Record<string, string | undefined>);
  startNs?: Ns;                               // fake clock start, default T0
  bootId?: string;                            // fake /proc boot id, default BOOT_A
  memAvailableMb?: number;                    // default 8000
}
export interface TestPlatform {
  /** Real Files; fake clock, proc and runner; env = sandbox.env(options.env); homeDir and cwd =
   *  sandbox.home; uuid() returns 00000000-0000-4000-8000-00000000000<n> (n = 1, 2, …);
   *  nodePath process.execPath; nodeVersion '24.19.0'; appRoot = the repository root. */
  platform: Platform;
  sandbox: Sandbox;                 // the scaffold's sandbox(t)
  clock: FakeClock;
  proc: FakeProc;
  runner: FakeRunner;
  places: Places;                   // resolvePlaces(platform.env, sandbox.home, null)
}
export function testPlatform(t: TestContext, options?: TestPlatformOptions): TestPlatform;

// test/helpers/capture.ts (extended)
export interface CaptureOptions {
  stdinTTY?: boolean; stdoutTTY?: boolean; stderrTTY?: boolean;   // default false
  lines?: readonly string[];          // answers for readLine, in order; null once exhausted
  /** Chunks yielded by keys(), then the iterator ends. A function is called when the iterator reaches it
   *  (so a test can change the world between keys) and its result is yielded. */
  keys?: readonly (string | (() => string))[];
  size?: { columns: number; rows: number };   // default 80×24
}
export interface Captured { io: Io; stdout: () => string; stderr: () => string; prompts: string[] }
export function capture(options?: CaptureOptions): Captured;

// test/helpers/context.ts (extended)
export interface TestCtx { ctx: Context; stdout: () => string; stderr: () => string; prompts: string[] }
/** Without `t` (as the scaffold's tests call it): ctx.platform is a stub whose every member throws
 *  "pass t to testContext" — enough for --help and --version. With `t`: testPlatform(t, options). */
export function testContext(): TestCtx;
export function testContext(t: TestContext, options?: TestPlatformOptions & CaptureOptions): TestCtx & TestPlatform;
```

### 2.3 `src/text/` (task 7)

#### 2.3.1 `src/text/sanitize.ts`

```ts
/**
 * Makes a foreign string safe to print on one terminal line. In this order:
 * 1. removes escape sequences: CSI (ESC '[' or U+009B, then bytes 0x30–0x3F, 0x20–0x2F, one final
 *    0x40–0x7E); OSC/DCS/SOS/PM/APC (ESC ']' 'P' 'X' '^' '_', or U+009D U+0090 U+0098 U+009E U+009F)
 *    up to and including BEL or ESC '\' or U+009C, or to the end of the string; any other ESC plus
 *    the one character after it;
 * 2. replaces each TAB, LF and CR with one space;
 * 3. removes the remaining U+0000–U+001F, U+007F–U+009F;
 * 4. removes the bidirectional controls U+202A–U+202E and U+2066–U+2069.
 * It does not trim and does not collapse spaces.
 */
export function sanitize(text: string): string;
```

#### 2.3.2 `src/text/shell.ts` (rules are the contract)

```ts
/**
 * POSIX sh quoting. A non-empty word made only of [A-Za-z0-9_@%+=:,./-] is returned unchanged,
 * except that a word starting with '=' is quoted (zsh would expand it if the printed command were
 * pasted there).
 * Anything else is wrapped in single quotes, each ' inside becoming '\'' . The empty word is ''.
 */
export function shellQuote(word: string): string;
/** The words quoted with shellQuote, joined by one space. */
export function shellJoin(argv: readonly string[]): string;
```

#### 2.3.3 `src/text/age.ts`

```ts
/**
 * Compact age of a duration in ns (negative counts as 0): < 60 s → "<n>s"; < 60 min → "<n>m";
 * < 48 h → "<n>h"; otherwise "<n>d". Always rounded down.
 */
export function formatAge(durationNs: bigint): string;
```

### 2.4 `src/store/`

#### 2.4.1 `src/store/types.ts`

```ts
import type { Ns } from '../platform/types.ts';

export type EventKind = 'start' | 'end' | 'observed';
export type StartDetail = 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown';
export type EndDetail = 'clear' | 'switch' | 'exit' | 'other';

export interface EventRow {
  id: number;
  spoolName: string | null;       // null for observed events
  timeNs: Ns;
  kind: EventKind;
  detail: StartDetail | EndDetail | '';   // '' for observed
  rawDetail: string | null;       // source / reason as received
  sessionId: string;
  bootId: string;
  pid: number;                    // 0 when the hook had no CLAUDE_PID (D7)
  procStart: number | null;
  cwd: string | null;
  argv: string[] | null;          // start and observed only; stored as a JSON array
  name: string | null;
  payload: string | null;         // hook input as received (start/end only)
}
export type NewEvent = Omit<EventRow, 'id'>;

export type LinkKind = 'clear' | 'switch' | 'fork';
export interface LinkRow {
  eventId: number;
  fromSession: string;
  toSession: string;
  kind: LinkKind;
  timeNs: Ns;
}

export interface SessionMeta {
  sessionId: string;
  label: string | null;
  group: string | null;           // column group_name
  note: string | null;
  doneAtNs: Ns | null;
  createdNs: Ns;
  updatedNs: Ns;
}
/** A field that is present is set (null clears it); a field that is absent is left unchanged. */
export interface MetaPatch {
  label?: string | null;
  group?: string | null;
  note?: string | null;
  doneAtNs?: Ns | null;
}

export interface TranscriptRow {
  path: string;
  sessionId: string;
  sizeRead: number;
  fileSize: number;
  mtimeNs: Ns;
  firstCwd: string | null;
  entrypoint: string | null;
  aiTitle: string | null;
  customTitle: string | null;
  firstRecordNs: Ns | null;
  lastRecordNs: Ns | null;
  lastUserNs: Ns | null;
  lastTurnRole: 'user' | 'assistant' | null;   // column last_turn_role
  missingSinceNs: Ns | null;
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type PrReview = 'approved' | 'changes-requested' | 'review-required';
export type PrChecks = 'passing' | 'failing' | 'pending';

export interface PrRow {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  state: PrState | null;          // null until the first successful fetch
  review: PrReview | null;
  checks: PrChecks | null;
  okAtNs: Ns | null;
  triedAtNs: Ns | null;
  error: string | null;           // error of the last attempt; null after a success
}

/** Result of one fetch attempt for one pull request. */
export type PrFetchResult =
  | { ok: true; atNs: Ns; title: string; state: PrState; review: PrReview | null; checks: PrChecks | null }
  | { ok: false; atNs: Ns; error: string };

export type PrOrigin = 'auto' | 'manual';
export interface SessionPrRow {
  sessionId: string;
  url: string;
  origin: PrOrigin;
  firstSeenNs: Ns;
  detachedAtNs: Ns | null;
}

/** Every key the kv table holds. */
export type KvKey =
  | 'schema_version'      // "1"
  | 'dropped_scripted'    // decimal count of scripted-run events dropped at ingest
  | 'settings_hash'       // sha256 hex of settings.json as install left it
  | 'settings_backup'     // absolute path of the backup, or "none" when there was no settings file
  | 'first_scan_done'     // "1" after the first complete transcript scan
  | 'first_run_offered'   // "1" after install made the first-run offer (D20)
  | 'doctor_probe'        // written by doctor to prove the database is writable
  // What the last ingest / reconcile / scan skipped and why (task 8, for doctor): a JSON array of
  // one-line strings naming files, folders or processes (never their content); absent when none.
  | 'ingest_problems'
  | 'reconcile_problems'
  | 'scan_problems'
  // (Task 16, D16.) A resume lock: the decimal time in ns it was taken; one per session id.
  | `resume_lock:${string}`;
```

#### 2.4.2 `src/store/migrations.ts`

```ts
/** MIGRATIONS[i] is migration i + 1. Each runs in one transaction with the kv update. */
export const MIGRATIONS: readonly string[];
export const SCHEMA_VERSION: number;   // MIGRATIONS.length, i.e. 1
```

`MIGRATIONS[0]` is exactly the SQL of design 9.2 ("Migration 1"), character for character
(comments may be kept).

#### 2.4.3 `src/store/store.ts`

```ts
export interface Store {
  readonly path: string;
  /** Closes the connection; a second call does nothing. */
  close(): void;
  /** The connection's PRAGMA values (they are per connection, so tests and doctor read them here). */
  connectionSettings(): { journalMode: string; synchronous: number; busyTimeout: number; foreignKeys: number };
  /** Runs fn inside BEGIN IMMEDIATE … COMMIT; rolls back and rethrows on error. Not re-entrant. */
  transaction<T>(fn: () => T): T;

  // events (5.3, 5.4)
  /** INSERT OR IGNORE keyed by spool_name. Returns the new id, or null when that spool name exists. */
  insertEvent(event: NewEvent): number | null;
  insertLink(link: LinkRow): void;
  /** All events ordered by (time_ns, id). */
  events(): EventRow[];
  /**
   * The latest event (by time_ns, id) of the process (bootId, pid, procStart) with
   * time_ns <= beforeNs. procStart null matches proc_start IS NULL.
   */
  latestEventOfProcess(bootId: string, pid: number, procStart: number | null, beforeNs: Ns): EventRow | null;
  /** Whether any event of that process has a non-null argv. */
  processHasLaunch(bootId: string, pid: number, procStart: number | null): boolean;
  /** Whether a 'start' event for the session exists with time_ns >= sinceNs. */
  hasStartSince(sessionId: string, sinceNs: Ns): boolean;
  /** As hasStartSince, but only a start of a real process counts: pid not 0 and a process start time (proc_start not NULL). A start the hook wrote without them names no process that could hold the session. */
  hasProcessStartSince(sessionId: string, sinceNs: Ns): boolean;
  /** The highest id among the events that name the session (whatever their time or kind); null when there is none. */
  latestEventIdOfSession(sessionId: string): number | null;
  /** All links ordered by time_ns. */
  links(): LinkRow[];

  // session_meta (7.1)
  meta(sessionId: string): SessionMeta | null;
  allMeta(): SessionMeta[];
  /** Creates the row (created_ns = updated_ns = nowNs) when absent; applies the patch; returns the row. */
  updateMeta(sessionId: string, patch: MetaPatch, nowNs: Ns): SessionMeta;

  // transcripts (5.6)
  transcripts(): TranscriptRow[];
  /** INSERT OR REPLACE by path. */
  saveTranscript(row: TranscriptRow): void;

  // pull requests (7.3)
  /** INSERT OR IGNORE a prs row with only the key columns. */
  ensurePr(key: { url: string; owner: string; repo: string; number: number }): void;
  prs(): PrRow[];
  /** ok: sets title, state, review, checks, ok_at_ns = tried_at_ns = atNs, error = NULL.
   *  failure: sets tried_at_ns = atNs and error; leaves every other column unchanged. */
  savePrResult(url: string, result: PrFetchResult): void;
  /**
   * origin 'auto': INSERT OR IGNORE — never re-attaches a detached row, never downgrades 'manual'.
   * origin 'manual': upsert — origin = 'manual', detached_at_ns = NULL, first_seen_ns kept if present.
   * The prs row must exist (ensurePr first).
   */
  attachPr(sessionId: string, url: string, origin: PrOrigin, nowNs: Ns): void;
  /** Sets detached_at_ns; false when there is no such attached row. */
  detachPr(sessionId: string, url: string, nowNs: Ns): boolean;
  /** All session_prs rows, detached ones included. */
  sessionPrs(): SessionPrRow[];

  // kv
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
  deleteKv(key: KvKey): void;
  /** Treats a missing value as 0. */
  addToKv(key: KvKey, delta: number): void;
  /** (Task 16.) Every entry whose key starts with `prefix` (compared literally, case included: no LIKE), ordered by key. */
  kvEntries(prefix: string): { key: KvKey; value: string }[];
}

/**
 * Opens (creating when absent) the database at `path`; the directory must exist. Sets
 * journal_mode=WAL, synchronous=FULL, busy_timeout=5000, foreign_keys=ON, chmods the file 0600,
 * runs the missing migrations. Throws SkydeckError (exit 1) when kv schema_version is newer than
 * SCHEMA_VERSION ("the database was written by a newer skydeck").
 */
export function openStore(path: string): Store;
/**
 * (Task 8.) Whether an error a Store method threw is a failure of the database as a whole —
 * node:sqlite's `ERR_SQLITE_ERROR` with a primary result code (`errcode & 0xff`) of BUSY, LOCKED,
 * READONLY, IOERR, CORRUPT, FULL, CANTOPEN or NOTADB — rather than of the one row being written.
 * Code that records and skips the errors of one item rethrows these at once.
 */
export function isDatabaseFailure(error: unknown): boolean;
```

### 2.5 `src/claude/`

#### 2.5.1 `src/claude/procstat.ts`

```ts
/** Field 22 (starttime) of a /proc/<pid>/stat line, counted after the LAST ')'. null when absent, not digits, or not a safe integer. */
export function procStartFromStat(line: string): number | null;
/** /proc/<pid>/cmdline bytes → arguments: UTF-8 decode, split on NUL, drop the last element when empty. [] for empty input. */
export function argvFromCmdline(bytes: Uint8Array): string[];
```

#### 2.5.2 `src/claude/launch.ts` (the flag table is the contract)

```ts
export type FlagShape = 'none' | 'one' | 'optional' | 'many';
export interface FlagSpec {
  names: readonly string[];       // every spelling, long and short
  shape: FlagShape;
  remove: boolean;                // removed when building a resume command (7.6)
  /**
   * The flag picks an existing session or replays one (`--resume`, `--continue`, `--fork-session`,
   * the deep-link flags, …), so `skydeck new` refuses it (7.7). Always a removed flag. A removed
   * flag that only says where or how a NEW session starts (`--worktree`, `--tmux`, the cloud flags)
   * is `false`: a resume drops it, but `new` may pass it.
   */
  picksSession: boolean;
  path: boolean;                  // values are paths made absolute at ingest (5.3)
}

/**
 * Claude Code 2.1.323 flags: every root flag the program declares, those hidden from
 * `claude --help` included. `test/fixtures/claude/flags-2.1.323.json` is Claude Code's own table;
 * a test compares the two.
 */
export const FLAGS: readonly FlagSpec[] = [
  // removed at resume (7.6)
  { names: ['-r', '--resume'], shape: 'optional', remove: true, picksSession: true, path: false },
  { names: ['-c', '--continue'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['--session-id'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--fork-session'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['-n', '--name'], shape: 'one', remove: true, picksSession: false, path: false },
  { names: ['-w', '--worktree'], shape: 'optional', remove: true, picksSession: false, path: false },
  { names: ['--bg', '--background'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--from-pr'], shape: 'optional', remove: true, picksSession: true, path: false },
  // they choose which session is opened or where it runs (D28); --tmux needs -w, which is removed
  { names: ['--tmux'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--teleport'], shape: 'optional', remove: true, picksSession: true, path: false },
  { names: ['--cloud', '--remote'], shape: 'optional', remove: true, picksSession: false, path: false },
  { names: ['--desktop'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--environment', '--pool'], shape: 'one', remove: true, picksSession: false, path: false },
  // they choose a session or act once (D28)
  { names: ['--rewind-files'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--resume-session-at'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--resume-drops-turn'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--reply-on-resume'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['--attach-serve'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--session-began-as-copy'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--init-only'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--handle-uri'], shape: 'one', remove: true, picksSession: true, path: false },
  // they only work with the cloud flags above, which are removed
  { names: ['--ref'], shape: 'one', remove: true, picksSession: false, path: false },
  { names: ['--on-branch'], shape: 'one', remove: true, picksSession: false, path: false },
  { names: ['--correlation-id'], shape: 'one', remove: true, picksSession: false, path: false },
  { names: ['--forward-home-settings'], shape: 'one', remove: true, picksSession: false, path: false },
  // one-time actions
  { names: ['--init'], shape: 'none', remove: true, picksSession: false, path: false },
  { names: ['--maintenance'], shape: 'none', remove: true, picksSession: false, path: false },
  // deep-link launches carry prompt text, which skydeck never stores (principle 4)
  { names: ['--deep-link-origin'], shape: 'none', remove: true, picksSession: true, path: false },
  { names: ['--deep-link-repo'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--deep-link-last-fetch'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--deep-link-cwd-b64'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--prefill'], shape: 'one', remove: true, picksSession: true, path: false },
  { names: ['--prefill-b64'], shape: 'one', remove: true, picksSession: true, path: false },
  // path flags (5.3), kept
  { names: ['--mcp-config'], shape: 'many', remove: false, picksSession: false, path: true },
  { names: ['--add-dir'], shape: 'many', remove: false, picksSession: false, path: true },
  { names: ['--settings'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--plugin-dir'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--plugin-dir-no-mcp'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--system-prompt-file'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--append-system-prompt-file'], shape: 'one', remove: false, picksSession: false, path: true },
  { names: ['--append-subagent-system-prompt-file'], shape: 'one', remove: false, picksSession: false, path: true },
  // kept, several values
  { names: ['--allowedTools', '--allowed-tools'], shape: 'many', remove: false, picksSession: false, path: false },
  { names: ['--disallowedTools', '--disallowed-tools'], shape: 'many', remove: false, picksSession: false, path: false },
  ...['--tools', '--betas', '--file', '--channels', '--dangerously-load-development-channels'].map(
    (name) => ({ names: [name], shape: 'many' as const, remove: false, picksSession: false, path: false }),
  ),
  // kept, one value
  ...[
    '--managed-settings',
    '--setting-sources',
    '--client-data-url',
    '--watch-artifact',
    '--watch-artifact-no-autoreact',
    '--team-name',
    '--agent-id',
    '--agent-name',
    '--agent-color',
    '--parent-session-id',
    '--lead-verify-key',
    '--agent-type',
    '--model',
    '--agent',
    '--routine',
    '--effort',
    '--fast-mode',
    '--permission-mode',
    '--inherit-permission-mode',
    '--proactivity',
    '--debug-file',
    '--system-prompt',
    '--append-system-prompt',
    '--system-prompt-snapshot',
    '--append-subagent-system-prompt',
    '--plan-mode-instructions',
    '--permission-prompt-tool',
    '--permission-prompts',
    '--json-schema',
    '--fallback-model',
    '--advisor',
    '--agents',
    '--plugin-url',
    '--remote-control-session-name-prefix',
    '--exec',
    '-m',
    '--sdk-url',
    '--thinking',
    '--thinking-display',
    '--max-thinking-tokens',
    '--max-turns',
    '--max-budget-usd',
    '--task-budget',
    '--autocompact',
    '--workload',
    '--output-format',
    '--input-format',
    '--teammate-mode',
    '--messaging-socket-path',
    '--project-config-root',
    '--runner-declares',
  ].map((name) => ({ names: [name], shape: 'one' as const, remove: false, picksSession: false, path: false })),
  // kept, optional value
  { names: ['-d', '--debug'], shape: 'optional', remove: false, picksSession: false, path: false },
  { names: ['--remote-control', '--rc'], shape: 'optional', remove: false, picksSession: false, path: false },
  ...['--project', '--prompt-suggestions'].map((name) => ({
    names: [name],
    shape: 'optional' as const,
    remove: false,
    picksSession: false,
    path: false,
  })),
  // kept, no value
  { names: ['-p', '--print'], shape: 'none', remove: false, picksSession: false, path: false },
  { names: ['-h', '--help'], shape: 'none', remove: false, picksSession: false, path: false },
  { names: ['-v', '--version', '-V'], shape: 'none', remove: false, picksSession: false, path: false },
  { names: ['-d2e', '--debug-to-stderr'], shape: 'none', remove: false, picksSession: false, path: false },
  ...[
    '--verbose',
    '--bare',
    '--safe-mode',
    '--include-hook-events',
    '--include-partial-messages',
    '--forward-subagent-text',
    '--session-mirror',
    '--await-claim',
    '--await-initialize',
    '--managed-settings-in-initialize',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--replay-user-messages',
    '--host-auth-is-org-sign-in',
    '--enable-auth-status',
    '--restricted',
    '--allow-other-models',
    '--exclude-dynamic-system-prompt-sections',
    '--include-unsupported-models',
    '--no-session-persistence',
    '--ide',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--chrome',
    '--no-chrome',
    '--enable-auto-mode',
    '--agents-view-if-allowed',
    '--brief',
    '--ax-screen-reader',
    '--plan-mode-required',
    '--hard-fail',
  ].map((name) => ({ names: [name], shape: 'none' as const, remove: false, picksSession: false, path: false })),
];

export type ParsedArg =
  | { kind: 'flag'; spec: FlagSpec | null; name: string; tokens: string[]; values: string[] }
  | { kind: 'positional'; tokens: [string] };

/**
 * Parses arguments (WITHOUT the program name) with FLAGS (D18), the way Claude Code's parser does:
 * - `--name=value` (long flags): one token, `values` [value], consumes nothing more; `name` is the
 *   flag as written before the `=`;
 * - a token that is a flag's own name is that flag, whatever its length (`-d2e`, `-V`); otherwise
 *   a short flag is read letter by letter: a no-value flag lets the token go on (a cluster, `-cp`);
 *   a value-taking flag ends it and takes the rest of the token, `=` included, as its value when
 *   there is a rest (`-rabc` is `--resume abc`, one token, nothing more consumed), otherwise its
 *   value follows by its shape; after a no-value flag, a '-' starts a new token, the rest of the
 *   token with one more '-' in front (`-c-model opus` is `-c --model opus`; `-c-` is `-c --`, which
 *   ends the flags: every later token is positional); a letter that is not in the table makes the
 *   whole token an unknown flag, whose `name` is that letter alone (`-Zabc` is `-Z`, `-cZfix` is
 *   `-Z`), or the long flag's name (`-c-frob` is `--frob`). `name` of a known flag is the token
 *   without the glued value; `spec` is that of the first flag in the token with `remove: true`,
 *   else of the last;
 * - shape none: no value; one: the next token whatever it is; optional: the next token if it
 *   exists and is not flag-like; many: the next token whatever it is, then every following token up
 *   to the next flag-like one (as Claude Code's parser does). A token is flag-like when it starts
 *   with '-' and has more than one character: a lone '-' is a value;
 * - an unknown flag-like token is a flag with spec null; it takes the next token as its value when
 *   that exists and is not flag-like;
 * - '--' and every token after it are positionals;
 * - any other token is a positional.
 * Concatenating every `tokens` array gives back the input exactly.
 */
export function parseLaunchArgs(args: readonly string[]): ParsedArg[];

/**
 * 5.3: in a full launch command (program first), each value of a flag with `path: true` that is
 * relative is replaced by resolve(cwd, value) when `exists(resolved)` is true. For the `=` form the
 * token becomes `--flag=<absolute>`. Other tokens are returned unchanged. cwd null → unchanged;
 * so is a cwd that is not absolute, and an empty value (resolving against either would give the
 * directory of the running process). An `exists` that throws counts as false, so the value stays
 * as written: a path-flag value can be inline JSON, longer than a file name may be, or hold a NUL,
 * and a stat then fails with something other than "not found".
 */
export function absolutizePathFlags(argv: readonly string[], cwd: string | null, exists: (path: string) => boolean): string[];

/**
 * What skydeck stores of a recorded launch command (5.3, principle 4): the program (first element)
 * and the flags, with their values, that a resume keeps, in order. Positional arguments (an initial
 * prompt), '--' and everything after it, and every flag with `remove: true` (with its values) are
 * dropped, so a prompt reaches the database neither as a positional argument nor inside a removed
 * flag such as `--prefill-b64`. A flag that is in no table is stored as its bare name (`--flag=value`
 * as `--flag`; a short token with an unknown letter as that letter alone, `-cZfix` as `-Z`): what follows it cannot be classified, and
 * skydeck never stores text it cannot classify; the name lets a resume say it was not passed on.
 * [] for an empty command. buildResumeCommand gives the same result for a command and for
 * storableArgv of it, and storableArgv(storableArgv(x)) equals storableArgv(x).
 */
export function storableArgv(argv: readonly string[]): string[];

/**
 * The names of the flags in a recorded or stored command (program first) that are in no table, in
 * order, each once (`--flag=value` is `--flag`, `-cZfix` is `-Z`). A resume does not pass them on; `resume` and `show`
 * say so. unknownFlags(storableArgv(x)) equals unknownFlags(x).
 */
export function unknownFlags(argv: readonly string[]): string[];

/**
 * Whether a recorded launch command (program first) has the print flag, alone or inside a cluster of
 * short flags (`-cp`). A `-p` that is another flag's value, or after '--', is not the flag. Ask it of
 * the RECORDED command: storableArgv drops a cluster that holds a removed flag (`-cp`) as a whole.
 */
export function isPrintRun(argv: readonly string[]): boolean;

/** A flag found in an argument list: as written (a cluster of short flags: the whole token), and its table entry. */
export interface FoundFlag { written: string; spec: FlagSpec }
/**
 * The flags in `args` (WITHOUT the program name) with `picksSession: true`, in order: alone, as
 * `--flag=value`, or inside a cluster of short flags (`-cp`: each flag of the cluster is looked at,
 * and `written` is the whole token `-cp`). The flags read before the first unknown letter of a
 * cluster count too (`-cZ`, `-cZfix`, `-pcZ`, `-c-frob`, `-c-frob=x`: the token is an unknown flag
 * for the parser, but it does start with `-c`; `written` is the whole token). A flag that is
 * another flag's value, or comes after `--`, is not one. `skydeck new` refuses these (7.7); `--worktree` and the other removed flags that only
 * say where or how a new session starts are not found.
 */
export function sessionPickingFlags(args: readonly string[]): FoundFlag[];
/** The `--name` / `-n` flags in `args`, found the same way (`skydeck new` refuses them too, 7.7). */
export function nameFlags(args: readonly string[]): FoundFlag[];

export interface ResumeCommand { argv: string[]; flagsKnown: boolean }
/**
 * 7.6. `launch` is a recorded launch command (program first) or null.
 * Result: [claudeCommand, '--resume', sessionId, ...(label ? ['-n', label] : []),
 *          ...every kept token of launch.slice(1) in order].
 * Removed: flags with remove: true (with their values), positionals, and flags that are in no table
 * (with what follows them; unknownFlags names them). flagsKnown is false when launch is null. No
 * permission flag is ever added. Throws RangeError when sessionId is not a lowercase UUID: it goes
 * onto a command line, where `--dangerously-skip-permissions` would be read as a flag.
 */
export function buildResumeCommand(input: {
  claudeCommand: string; launch: readonly string[] | null; sessionId: string; label: string | null;
}): ResumeCommand;

/**
 * 7.7: [claudeCommand, '--session-id', sessionId, ...(label ? ['-n', label] : []), ...extra].
 * Throws RangeError when sessionId is not a lowercase UUID (as buildResumeCommand).
 */
export function buildNewCommand(input: {
  claudeCommand: string; sessionId: string; label: string | null; extra: readonly string[];
}): string[];
```

#### 2.5.3 `src/claude/hookinput.ts`

```ts
import type { Ns } from '../platform/types.ts';      // type-only; platform imports nothing back

export interface SpoolEvent {
  spoolName: string;
  timeNs: Ns;
  kind: 'start' | 'end';
  detail: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown'
        | 'switch' | 'exit' | 'other';
  rawDetail: string | null;       // source / reason as received
  sessionId: string;
  bootId: string;
  pid: number;                    // 0 when claude_pid is empty (D7)
  procStart: number | null;
  cwd: string | null;             // hook input cwd, else the pwd key (empty → null)
  argv: string[] | null;          // SessionStart with a non-empty argv_b64 only: storableArgv of the
                                  // recorded command with its path flags absolute — no positional
                                  // arguments, no removed flags, unknown flags as bare names
                                  // (prompt text; principle 4)
  name: string | null;            // SessionStart session_title
  payload: string;                // the hook input exactly as received
  entrypointEnv: string | null;   // empty → null
  scripted: boolean;              // 5.3 "scripted runs": isPrintRun(recorded argv) — the command as
                                  // recorded, before storableArgv drops `-cp` whole — or entrypointEnv
                                  // non-null and not 'cli' (design 14: `claude -p` hooks see 'sdk-cli').
                                  // An end event has no command: only entrypointEnv decides.
}

/** SessionStart.source → detail. Anything else → 'unknown'. */
export const START_DETAILS: Readonly<Record<string, SpoolEvent['detail']>> = {
  startup: 'startup', resume: 'resume', clear: 'clear', compact: 'compact', fork: 'fork',
};
/**
 * SessionEnd.reason → detail. Anything else → 'other' — including the reason 'other' that closing
 * the terminal (SIGHUP) reports (design 14).
 */
export const END_DETAILS: Readonly<Record<string, SpoolEvent['detail']>> = {
  clear: 'clear', resume: 'switch', prompt_input_exit: 'exit', logout: 'exit',
};

export class SpoolParseError extends Error {}

/**
 * Parses one spool file (format: section 2.10.1). Throws SpoolParseError when: the name does not
 * match ^[0-9]+-[0-9]+-[0-9]+\.ev$; there is no line '--'; a line before it has no '='; a key
 * appears twice before it; v is not 1; event is not SessionStart or SessionEnd; time_ns is not
 * digits, or is larger than a signed 64-bit integer (the database column); boot_id is missing or
 * empty; claude_pid is neither empty nor digits, or is digits that are not a safe integer; the
 * argv_b64 of a SessionStart is not base64; the hook input is not a JSON object; no session id
 * (input session_id, else session_env) is a UUID. The session id of the event is always a lowercase
 * UUID (a UUID in either case is written in lower case; a value of any other shape is no session
 * id), because it ends up after `--resume` on a command line. The hook writes a value that
 * contained a newline or a carriage return as empty, and a claude_pid that is not all digits as empty (name part 0), so pwd,
 * session_env and entrypoint_env may be empty: empty means "unknown", never a valid value. The
 * launch command is normalised: `argv` is storableArgv(absolutizePathFlags(recorded, cwd, exists)),
 * so no positional argument, no removed flag (with its values) and no value of an unknown flag is
 * stored (design principle 4).
 * Lines are split on '\n' only; a '\r' belongs to the value. `scripted` is set as SpoolEvent says,
 * from the command as recorded. `exists` is used only by absolutizePathFlags.
 */
export function parseSpoolFile(name: string, content: string, exists: (path: string) => boolean): SpoolEvent;
```

#### 2.5.4 `src/claude/live.ts`

```ts
export interface ProcessKey { bootId: string; pid: number; procStart: number | null }

/** A live-session file <claudeHome>/sessions/<pid>.json, normalised (D2). */
export interface LiveFile {
  pid: number;
  sessionId: string;
  cwd: string | null;
  procStart: number | null;       // the file's procStart string parsed as an integer
  entrypoint: string | null;
  name: string | null;
  status: string | null;          // 'idle' | 'busy' | 'waiting' | anything else, as found
  waitingFor: string | null;
  updatedAtNs: Ns | null;         // from epoch ms
  statusUpdatedAtNs: Ns | null;   // from epoch ms
  mtimeNs: Ns;                    // of the file
}

/**
 * Reads <claudeHome>/sessions/ — only names matching ^[0-9]+\.json$ are opened (the directory also
 * holds credential files). Files that do not parse, or lack a numeric pid or a string sessionId,
 * are skipped. Sorted by pid.
 *
 * Ruled at review: the pid must be a positive safe integer and equal to the number in the file's
 * name (`4242.json` holds pid 4242; `04242.json` is skipped), and the sessionId must satisfy
 * `isSessionId` (anything else identifies nothing, and an id is put after `--resume`). A file that
 * cannot be read (permissions, or a directory with such a name), and a sessions directory that
 * cannot be listed, are skipped, not thrown: 6.2 treats "no live-session file can be read" as state
 * `running`. Epoch-millisecond times are numbers from 0 to 8.64e15 (a fraction is truncated);
 * anything else gives null, so no later conversion to an ISO string can throw.
 */
export function readLiveFiles(files: Files, claudeHome: string): LiveFile[];

/**
 * Ruled at review: true for a lowercase UUID (8-4-4-4-12 hex digits) and nothing else. Every session
 * id taken from a Claude Code file passes this check (live files here, transcript file names in
 * transcripts.ts); a value such as `--dangerously-skip-permissions` must never reach a command line.
 */
export function isSessionId(text: string): boolean;

/** 5.5: bootId equals currentBootId, /proc/<pid>/stat exists, and its field 22 equals procStart (non-null). */
export function isAlive(p: ProcessKey, proc: Proc, currentBootId: string | null): boolean;

/** 5.5: a live file is trusted when /proc/<pid>/stat exists and its field 22 equals the file's procStart. */
export function isLiveFileTrusted(f: LiveFile, proc: Proc): boolean;
```

#### 2.5.5 `src/claude/transcripts.ts`

```ts
export interface TranscriptFile { path: string; sessionId: string; size: number; mtimeNs: Ns }

/**
 * <claudeHome>/projects/<folder>/<uuid>.jsonl, exactly two levels deep, name exactly a lowercase
 * UUID + '.jsonl', regular files only. Sorted by path. Folder names are never parsed.
 *
 * Ruled at review: "regular" is read with lstat, so a symbolic link to a file is not listed; a
 * symbolic link to a project folder is followed (a relocated folder still counts). `files` is sorted
 * by the whole path in UTF-16 code units, not by folder and then name. The name's id must satisfy
 * `isSessionId` (2.5.4).
 *
 * Ruled at review: it never throws for one bad entry. A folder or file that cannot be looked at or
 * listed (a symbolic link loop, permissions), or an unreadable `projects` directory, goes into
 * `unreadable` (sorted by path, with the error code) and the rest is listed. A listing with
 * anything in `unreadable` is partial, and what is missing from it must not be taken for deleted:
 * task 8 marks no transcript missing at or under an unreadable path, and `doctor` (task 17) reports
 * the entries. A path that is simply not there (ENOENT) is not unreadable.
 */
export function listTranscriptFiles(files: Files, claudeHome: string): { files: TranscriptFile[]; unreadable: UnreadableEntry[] };

/** A folder or file that could not be looked at or listed, and why: the error code ('ELOOP', 'EACCES'), else 'unknown error'. */
export interface UnreadableEntry { path: string; reason: string }

export interface TranscriptFacts {
  firstCwd: string | null;        // first record carrying a non-empty string cwd (ruled at review: an empty one is no value)
  entrypoint: string | null;      // first record carrying a non-empty string entrypoint (same)
  aiTitle: string | null;         // latest 'ai-title' record's aiTitle
  customTitle: string | null;     // latest 'custom-title' record's customTitle
  firstRecordNs: Ns | null;       // smallest parseable timestamp
  lastRecordNs: Ns | null;        // largest parseable timestamp
  lastUserNs: Ns | null;          // largest timestamp of a 'user' record that is the user's own input (ruled at review, below)
  lastTurnRole: 'user' | 'assistant' | null;   // type of the last (in file order) 'assistant' record or 'user' record that is a turn
}
export const EMPTY_FACTS: TranscriptFacts;   // all null

/**
 * Folds complete JSONL lines into facts. Lines that are not JSON objects are skipped. Returns the
 * prUrl of every 'pr-link' record with a string prUrl, in order. Keeps no message text.
 *
 * Ruled at review: not every 'user' record is a turn, and not every turn is the user's input.
 * A 'user' record is a TURN (`lastTurnRole` becomes 'user') when it carries a string `turnOrigin`
 * of any value (check this first: Claude Code writes one for every record it sends to the model,
 * and `isMeta` alone would hide messages of other agents and scheduled wakeups); a record without
 * one is a turn unless `isMeta`, `isCompactSummary` or `isSidechain` is true, or its text (the
 * message content when a string, else the first text block) starts with `<command-name>`,
 * `<command-message>`, `<local-command-stdout>`, `<local-command-stderr>`, `<local-command-caveat>`,
 * `<bash-input>`, `<bash-stdout>`, `<bash-stderr>` or `[Request interrupted`. A 'user' record is
 * INPUT (`lastUserNs`, which decides whether a done session comes back) when its `turnOrigin` is
 * `human`; with any other `turnOrigin` (peer, scheduled, task_notification, sdk, ...) it is not;
 * without one it is input when it is a turn, not a tool result (`toolUseResult` present, or a
 * `tool_result` content block) and its `promptSource` is not `system` (older versions wrote the
 * notice of a finished background task so). The text is compared and dropped. A shape that is not
 * recognised is a turn. A user record always counts for the cwd, the entrypoint and the record times.
 */
export function foldLines(facts: TranscriptFacts, lines: readonly string[]): { facts: TranscriptFacts; prUrls: string[] };

export interface TranscriptRead { facts: TranscriptFacts; sizeRead: number; prUrls: string[] }
/**
 * Reads bytes [previous.sizeRead, file.size) — or from 0 with EMPTY_FACTS when previous is null or
 * file.size < previous.sizeRead (shrunk) — splits on byte 0x0A, folds the complete lines, and
 * leaves a last line without a newline for the next read (sizeRead stops after the last 0x0A).
 *
 * Ruled at review: the file is read in pieces of 4 MiB and each line is decoded on its own (one
 * decoded string of a transcript of hundreds of megabytes would exceed V8's string limit); sizeRead
 * counts the bytes actually returned. It throws what Files.readBytes throws, for example when the
 * file has vanished since it was listed. Before reading from `previous.sizeRead` it checks that the
 * byte just before it is a newline (it always is in the file the offset came from); when it is not,
 * the file was replaced and is read from the start.
 */
export function readTranscript(files: Files, file: TranscriptFile, previous: { facts: TranscriptFacts; sizeRead: number } | null): TranscriptRead;
```

#### 2.5.6 `src/claude/settings.ts`

```ts
export const HOOK_EVENTS: readonly ['SessionStart', 'SessionEnd'];
export type HookEvent = 'SessionStart' | 'SessionEnd';

/** <claudeHome>/settings.json */
export function settingsPath(claudeHome: string): string;

/** Exactly `'<hookPath>' <event> >/dev/null 2>&1 || true`. Throws SkydeckError when hookPath contains a quote. */
export function hookCommand(hookPath: string, event: HookEvent): string;

/** The matcher group of design 5.1: { hooks: [ { type: 'command', command, timeout: 5 } ] }. */
export function hookEntry(hookPath: string, event: HookEvent): { hooks: [{ type: 'command'; command: string; timeout: 5 }] };

export interface SettingsEdit {
  text: string;                   // the new file content; equal to the input when !changed
  changed: boolean;
  events: HookEvent[];            // events whose entries were added (add) or removed (remove)
}

/**
 * Appends hookEntry to hooks.<event> for each event that has no hook whose command equals
 * hookCommand(hookPath, event). settingsText null = no file (start from {}). Output is
 * JSON.stringify(settings, null, 2) + '\n'; key order of the input is kept. Throws SkydeckError when
 * the text is not a JSON object, or `hooks` / `hooks.<event>` has the wrong type.
 */
export function addHookEntries(settingsText: string | null, hookPath: string): SettingsEdit;

/**
 * Removes every hook object whose `command` contains hookPath; then drops matcher groups left with
 * no hooks, event arrays left empty, and `hooks` when left empty. Nothing else changes.
 */
export function removeHookEntries(settingsText: string, hookPath: string): SettingsEdit;

/** For each event: does an entry whose command equals hookCommand(hookPath, event) exist? */
export function hookStatus(settingsText: string | null, hookPath: string): Record<HookEvent, boolean>;

/** cleanupPeriodDays when it is a positive number, else 30. Unparsable or null text → 30. */
export function cleanupPeriodDays(settingsText: string | null): number;
```

### 2.6 `src/github.ts` (`PrKey`, `prKey`: task 2; the rest: task 9)

```ts
export interface PrKey { url: string; owner: string; repo: string; number: number }

/**
 * 7.3 key. Accepts http(s)://github.com/<owner>/<repo>/pull/<number> (host case-insensitive,
 * optional "www."), anything after the number stripped (/files, ?x, #y). Validates owner
 * ^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$, repo ^[A-Za-z0-9._-]{1,100}$ and not '.' or '..', number
 * 1..2147483647 without leading zeros. Returns the lowercased url
 * `https://github.com/<owner>/<repo>/pull/<number>` and lowercased owner/repo; null when invalid.
 */
export function prKey(text: string): PrKey | null;

export const BATCH_SIZE = 50;
export const GH_TIMEOUT_MS = 10_000;

/**
 * AUTOMATIC (`force` false): non-final (state not merged/closed) rows that were never tried (triedAtNs null) or whose
 * last ATTEMPT is older than refreshMinutes — the last attempt, not the last success, so a row that keeps failing is
 * asked about at that pace. EXPLICIT (`force`): every non-final row, whatever its age and its last result.
 */
export function prsDue(prs: readonly PrRow[], nowNs: Ns, refreshMinutes: number, force: boolean): PrRow[];

/**
 * The `gh` arguments for one batch (1 to BATCH_SIZE keys; RangeError for 0 or more):
 * ['api', 'graphql', '--hostname', 'github.com', '-f', 'query=<q>',
 * then for i = 0..n-1: '-f', 'o<i>=<owner>', '-f', 'r<i>=<repo>', '-F', 'n<i>=<number>'].
 * `--hostname github.com` makes `GH_HOST` or a configured enterprise host unable to send the
 * question elsewhere.
 * Query: query($o0: String!, $r0: String!, $n0: Int!, …) { p0: repository(owner: $o0, name: $r0)
 * { pullRequest(number: $n0) { title state isDraft reviewDecision commits(last: 1) { nodes {
 * commit { statusCheckRollup { state } } } } } } … }. Values never appear inside the query text.
 */
export function batchArgs(keys: readonly PrKey[]): string[];

/**
 * Maps one `gh` result to a fetch result per key url.
 * - timedOut → every key: error "gh timed out after 10 s"; notFound → "gh is not installed".
 * - stdout not JSON with a `data` object → every key: with exit code 0 "gh returned output skydeck
 *   could not read" (stderr is not used: gh succeeded, and a line on it may concern one pull
 *   request only); otherwise the first line of stderr that has text on it (trimmed), else
 *   "gh exited <code>" ("gh was killed by a signal" when there is no code).
 * - otherwise per alias p<i>: pullRequest object → ok (state MERGED→merged, CLOSED→closed,
 *   OPEN+isDraft→draft, OPEN→open; reviewDecision APPROVED→approved, CHANGES_REQUESTED→
 *   changes-requested, REVIEW_REQUIRED→review-required, else null; rollup SUCCESS→passing,
 *   FAILURE|ERROR→failing, PENDING|EXPECTED→pending, else null); a pullRequest object without a
 *   string title, or whose state is none of those, → error "GitHub answered without a title" /
 *   "GitHub answered with a pull request state not known here" (never a guess, never closed);
 *   null or missing → error: the message of the `errors[]` entry whose path[0] is p<i>, else the
 *   message of the first entry that has no path (GitHub's own timeout error), else "not found".
 * gh exits non-zero when some aliases fail; the per-alias data is still used.
 */
export function parseBatch(keys: readonly PrKey[], result: RunResult, atNs: Ns): Map<string, PrFetchResult>;

/**
 * Fetches exactly the given pull requests (urls of existing prs rows; others are ignored, a
 * repeated url counts once) in batches through `gh api graphql` (runner, GH_TIMEOUT_MS), one batch
 * after the other, saves every result with store.savePrResult. Never throws for gh failures (a
 * runner that rejects fails its batch: "gh could not be run: <first line of the message>"); no
 * call at all for an empty list.
 * A merged or closed row is never fetched (7.3): it is left out of the batches, and a result is
 * dropped when its row has become merged or closed meanwhile (another refresh was faster); dropped
 * results count neither as fetched nor as failed.
 * `deps.env` (required) is the environment of the calling process (`platform.env`; this file may
 * not read `process.env`, and the runner's `env` option is the child's complete environment): `gh`
 * always runs with { timeoutMs: GH_TIMEOUT_MS, env } where env is that environment without GH_HOST,
 * GH_FORCE_TTY and CLICOLOR_FORCE (the last beats NO_COLOR in `gh`) and with GH_PROMPT_DISABLED=1
 * and NO_COLOR=1 (the rest is passed, so `gh` finds
 * its login). Callers pass `env: ctx.platform.env`.
 */
export function fetchPrs(
  deps: { runner: Runner; clock: Clock; store: Store; env: Env },
  urls: readonly string[],
): Promise<{ fetched: number; failed: number }>;

/**
 * fetchPrs of the urls of prsDue(rows, now, refreshMinutes, force), where `rows` are the store's
 * pull requests that at least one session still has attached (a row whose every attachment is
 * detached, or that was never attached, is shown nowhere and is not asked about; ruled by the plan owner).
 * `force: true` is the user's explicit refresh (`pr refresh`, `ls --refresh`, `show --refresh`, the list's refresh key),
 * `force: false` the automatic one (the list when it opens and in the background). With `sessionIds`, only the
 * pull requests that one of those sessions has attached count: the sessions the command is about.
 */
export function refreshPrs(
  deps: { runner: Runner; clock: Clock; store: Store; env: Env },
  options: { force: boolean; refreshMinutes: number; sessionIds?: readonly string[] },
): Promise<{ fetched: number; failed: number }>;

/** 7.3 chip, worst first. */
export const CHIP_ORDER = ['cant-read', 'unfetched', 'checks-failing', 'changes-requested', 'checks-pending',
  'review-required', 'draft', 'approved-green', 'merged', 'closed'] as const;
export type ChipLevel = (typeof CHIP_ORDER)[number];

/**
 * Level of one pull request: error non-null → cant-read; state null (never fetched, D11) → unfetched; merged → merged;
 * closed → closed; otherwise (open or draft) the first that applies of: checks failing →
 * checks-failing; review changes-requested → changes-requested; checks pending → checks-pending;
 * review review-required → review-required; draft → draft; else approved-green.
 */
export function prLevel(pr: PrRow): ChipLevel;

/** The worst level among `prs` and their count; null for an empty list. */
export function chipFor(prs: readonly PrRow[]): { level: ChipLevel; count: number } | null;
```

### 2.7 `src/terminals/`

#### 2.7.1 `src/terminals/types.ts`

```ts
export interface LaunchSpec { cwd: string; argv: readonly string[] }
/** (Task 16.) timedOut: the adapter's call was killed for taking too long, so the program may have started anyway. */
export type OpenResult = { ok: true } | { ok: false; error: string; timedOut: boolean };
export interface Terminal {
  readonly name: 'here' | 'wezterm';
  /** true when open() starts the program in a new tab and returns; false for 'here'. */
  readonly opensTabs: boolean;
  open(spec: LaunchSpec): Promise<OpenResult>;
}
```

#### 2.7.2 `src/terminals/here.ts`

```ts
export const HANDOFF_ENV = 'SKYDECK_HANDOFF';

/** The handoff file content (2.10.3): "cd -- <q cwd> || exit 1\nexec <q argv…>\n". */
export function handoffScript(spec: LaunchSpec): string;

/**
 * open() writes handoffScript to the file named by env SKYDECK_HANDOFF (Files.writeText).
 * Without that variable: { ok: false, error: 'not started through bin/skydeck', timedOut: false }.
 * open() is async: a file that cannot be written, or an empty argv (a caller bug: `exec` with
 * nothing after it does nothing), is a rejected promise, not a returned error.
 * The caller must exit right after a successful open(); the launcher then execs the command.
 */
export function hereTerminal(deps: { files: Files; env: Env }): Terminal;
```

#### 2.7.3 `src/terminals/wezterm.ts`

```ts
/**
 * open() runs `wezterm cli --no-auto-start spawn [--domain-name <domain>] --cwd <cwd> -- <argv…>`
 * with a 10 s timeout (`--no-auto-start`: with no WezTerm window open the call fails instead of
 * starting a hidden mux server that would hold the session where nobody can see it); on notFound
 * with env WSL_DISTRO_NAME set it retries once with `wezterm.exe` (D15).
 * ok when the exit code is 0; otherwise error = first line of stderr, or "wezterm exited <code>",
 * "wezterm timed out; a tab may have opened" (the request can reach WezTerm before the call is
 * killed, so a caller must not print a paste-able fallback after it), "wezterm is not installed";
 * timedOut = the call was killed for taking too long (callers decide on it, not on the message).
 */
export function weztermTerminal(deps: { runner: Runner; env: Env }, domain: string | null): Terminal;
```

#### 2.7.4 `src/terminals/index.ts`

```ts
export type { LaunchSpec, OpenResult, Terminal } from './types.ts';
/** 'here' → hereTerminal; 'wezterm' → weztermTerminal(config.wezterm.domain). */
export function terminalFor(name: 'here' | 'wezterm', platform: Platform, config: Config): Terminal;
```

### 2.8 `src/sessions/`

#### 2.8.1 `src/sessions/deck.ts` (task 8) and `src/sessions/types.ts` (task 10)

```ts
// deck.ts
/** The opened skydeck: what every function of src/sessions/ works on. */
export interface Deck { platform: Platform; places: Places; config: Config; store: Store }
/**
 * resolveConfigDir → loadConfig → resolvePlaces(env, homeDir, config.claudeHome) → mkdirp (0o700)
 * dataDir, stateDir, configDir, spoolDir, locksDir → openStore(dbPath). Throws ConfigError (also
 * for a config.json that exists but cannot be read); a directory that cannot be created is a
 * SkydeckError (exit 1) naming it.
 */
export function openDeck(platform: Platform): Deck;
/** The first two steps of openDeck only (no directory, no database): for commands that must not create anything. */
export function resolveDeckPlaces(platform: Platform): { places: Places; config: Config };

// types.ts
export type State = 'working' | 'waiting' | 'running' | 'not-running';
export type Mark = 'ended-unexpectedly' | 'was-working' | 'continued' | 'expired' | 'expiring' | 'duplicate';
/** Display and JSON order of marks (design 6.3 table order). */
export const MARK_ORDER: readonly Mark[] = ['ended-unexpectedly', 'was-working', 'continued', 'expired', 'expiring', 'duplicate'];

export interface Holder {
  process: ProcessKey;
  sinceNs: Ns;                    // time of the process's latest event
  live: LiveFile | null;          // its trusted live file naming this session, if any
}

export interface LastHolding {
  process: ProcessKey;
  alive: boolean;
  /** time of the end event that closed the holding; null when the process held it at its last event */
  endedAtNs: Ns | null;
  /** detail of that end; 'moved-on' when the process's later events name another session without an end; null when still held */
  endDetail: EndDetail | 'moved-on' | null;
}

export interface DerivedSession {
  id: string;
  state: State;
  stateDetail: string | null;     // waitingFor when waiting, raw (the list model sanitises)
  sinceNs: Ns;
  lastActivityNs: Ns;
  firstSeenNs: Ns;
  holders: Holder[];              // live holders, latest event first
  marks: Mark[];                  // in MARK_ORDER
  continuedFrom: string | null;
  dir: string | null;
  launch: string[] | null;
  transcript: TranscriptRow | null;
  lastHolding: LastHolding | null;
  lastEventId: number | null;     // the highest id among the events naming the session; null: known from a transcript only (a resume decides on it, 7.6)
  bootId: string | null;          // the boot id the holders were judged against (= DeriveInput.bootId); null: it could not be read, and no process looked alive (a resume refuses, 7.6)
  doneAtNs: Ns | null;
  hidden: boolean;                // done, and no activity after doneAtNs (7.1)
}
```

#### 2.8.2 Ingest, reconcile, scan, refresh (task 8)

```ts
// src/sessions/ingest.ts
export interface IngestResult { ingested: number; duplicates: number; bad: number; scripted: number }
/**
 * 5.3 step 1. Reads <spoolDir>/*.ev in name order (dot files and bad/ ignored). Afterwards removes
 * the files in <badDir> older than seven days and the leftover `.<name>.tmp` files in <spoolDir>
 * older than one hour (age = modification time against the platform clock; a younger temporary
 * file may belong to a running hook). The removals are not counted in the result.
 * Never throws for one file: one that cannot be read or parsed for any reason goes to bad/; one
 * whose row cannot be saved (any error the row causes, the store's included) stays in the spool;
 * every problem is recorded in kv `ingest_problems`. A failure of the database as a whole
 * (`isDatabaseFailure`) is thrown at once.
 */
export function ingestSpool(deck: Deck): IngestResult;

// src/sessions/reconcile.ts
/**
 * 5.4. Inserts observed events (launch command = storableArgv of the recorded one); returns how many.
 * An error with one live process (looking at it or saving its event) skips it and is recorded in
 * kv `reconcile_problems`; so is a boot id that cannot be read.
 */
export function reconcile(deck: Deck): { observed: number };

// src/sessions/scan.ts
export interface ScanResult { read: number; skipped: number; missing: number; prsAttached: number }
/**
 * 5.6. progress(done, total) is called after each file that is processed (total: the changed
 * files; one that could not be read, was gone or could not be recorded counts too). Sets kv
 * first_scan_done.
 * What cannot be read (listing or file) or saved is recorded in kv `scan_problems`; what cannot be
 * read is not marked missing.
 */
export function scanTranscripts(deck: Deck, progress?: (done: number, total: number) => void): ScanResult;

// src/sessions/refresh.ts
export interface RefreshResult { ingest: IngestResult; observed: number; scan: ScanResult }
/**
 * ingestSpool, reconcile, scanTranscripts — in this order (5.3) — and then sweepLocks (task 16, D16).
 * Never throws for one spool file, process or transcript, whatever fails (reading, deriving or
 * saving it); a failure of the database itself (`isDatabaseFailure`) ends the command.
 */
export function refresh(deck: Deck, progress?: (done: number, total: number) => void): RefreshResult;
```

#### 2.8.3 Derived state (task 10): `src/sessions/derive.ts`

```ts
export interface DeriveInput {
  events: readonly EventRow[];          // ordered by (timeNs, id)
  links: readonly LinkRow[];
  transcripts: readonly TranscriptRow[];
  metas: readonly SessionMeta[];
  liveFiles: readonly LiveFile[];       // every file read, trusted or not
  bootId: string | null;                // the boot id `isAlive` judges against, read once; null: it could not be read
  isAlive: (p: ProcessKey) => boolean;
  isTrusted: (f: LiveFile) => boolean;
  nowNs: Ns;
  retentionDays: number;
}
/** Design 6 for every session id found in events or transcripts. Pure. Sorted by id. */
export function deriveSessions(input: DeriveInput): DerivedSession[];
```

#### 2.8.4 List model and references (task 11)

```ts
// src/sessions/list.ts
export type TitleSource = 'label' | 'name' | 'generated' | 'fallback';
export interface PrView {
  url: string;
  repo: string;                   // "<owner>/<repo>"
  number: number;
  title: string | null;           // sanitised
  state: PrState | null;
  review: PrReview | null;
  checks: PrChecks | null;
  okAtNs: Ns | null;
  error: string | null;           // sanitised
  level: ChipLevel;
}
export interface ListRow {
  id: string;
  shortId: string;
  title: string;                  // sanitised
  titleSource: TitleSource;
  label: string | null;           // sanitised
  group: string | null;           // sanitised; meta group, else groupPattern match on the title
  groupSource: 'meta' | 'title' | null;   // where `group` comes from; null exactly when `group` is
  state: State;
  stateDetail: string | null;     // sanitised
  sinceNs: Ns;
  lastActivityNs: Ns;
  dir: string | null;             // sanitised, so for display only: the path to use is session.dir
  marks: Mark[];
  hasNote: boolean;
  note: string | null;            // as typed (free multi-line text); sanitised by whoever prints it
  continuedFrom: string | null;
  done: boolean;                  // = session.hidden
  prs: PrView[];                  // attached and not detached, sorted by url
  chip: { level: ChipLevel; count: number } | null;
  session: DerivedSession;
}
export interface ListGroup { name: string | null; rows: ListRow[] }
export interface ListModel { generatedAtNs: Ns; groups: ListGroup[] }

/**
 * One row per derived session (none dropped, in the order given), every foreign string sanitised
 * (7.4). A `customTitle` or `aiTitle` that is empty or only whitespace once sanitised is not a
 * title: the next source is used (the transcript reader keeps an empty `customTitle`, a cleared
 * name); titles are shown trimmed. The label and the group are sanitised too (defence in depth:
 * cleanLabel and cleanGroup refuse such text); one that is blank once sanitised is not set. A
 * `groupPattern` that matches the empty string gives no group. The fallback title is built
 * from the sanitised directory.
 */
export function buildRows(input: {
  sessions: readonly DerivedSession[]; metas: readonly SessionMeta[];
  prs: readonly PrRow[]; sessionPrs: readonly SessionPrRow[]; groupPattern: string;
}): ListRow[];
/** 7.2: entrypoint other than cli → false; not running and no transcript → false (D27, also with showAll); done (unless showAll) → false; expired with nothing the user attached (no label, no group set by the user (`groupSource` 'meta'), no note, no PR) → false. A group `groupPattern` took from the title does not count. */
export function isListed(row: ListRow, showAll: boolean): boolean;
/** Case-insensitive substring match on title, group, note, dir, and per PR "<repo>", "<number>", "<repo>#<number>". Empty filter matches all. */
export function matchesFilter(row: ListRow, filter: string): boolean;
/** Listed rows that match `filter`, grouped and ordered as in 7.4 (see task 11). */
export function buildList(rows: readonly ListRow[], options: { showAll: boolean; filter: string; nowNs: Ns }): ListModel;
/** The rows of a model in display order. */
export function flatRows(model: ListModel): ListRow[];

// src/sessions/load.ts
/**
 * Builds DeriveInput from the store (events, links, transcripts, allMeta), readLiveFiles,
 * isAlive/isLiveFileTrusted with proc and proc.bootId() (read ONCE per load; the value is also
 * DeriveInput.bootId, so the rows carry the boot id they were judged with), clock now, and
 * cleanupPeriodDays(content of settingsPath(claudeHome)); returns deriveSessions(input).
 * A settings file that cannot be read counts as "no cleanupPeriodDays" (30 days): the list does
 * not stop for Claude Code's own file. Reads only; it does not refresh.
 */
export function loadSessions(deck: Deck): DerivedSession[];
/** loadSessions + store allMeta/prs/sessionPrs + buildRows with config.groupPattern. */
export function loadRows(deck: Deck): ListRow[];

// src/sessions/refs.ts
/**
 * 7.5 <ref>: (1) a row whose id equals ref (lowercased); (2) if ref has ≥ 4 characters, rows whose
 * id starts with it, among all rows; (3) rows whose label equals ref, among rows listed with
 * showAll (D22). The first step with ≥ 1 match decides: exactly one → it; several → RefError
 * "'<ref>' matches <n> sessions" with candidates (in the order of `rows`); none at all → RefError
 * "no session matches '<ref>'". Ids are compared in lower case, labels exactly as typed; `<ref>` is
 * sanitised where a message repeats it. Only the stored id is ever returned, never the typed text.
 */
export function resolveRef(ref: string, rows: readonly ListRow[]): ListRow;

// src/sessions/labels.ts (7.1)
/**
 * Trimmed label (trimmed first, so a trailing newline goes). UsageError when what is left contains a
 * line break (LF, CR, VT, FF, NEL, U+2028, U+2029) or anything else `sanitize()` would change (a tab,
 * an escape sequence, a control or bidirectional character), is empty, or starts with '-'. The
 * message does not repeat the text.
 */
export function cleanLabel(text: string): string;
/** Trimmed group. UsageError when what is left contains a line break or anything `sanitize()` would change (as for a label), or is empty. */
export function cleanGroup(text: string): string;
```

#### 2.8.5 Labels, groups, notes, done, manual pull requests (task 15): `src/sessions/meta.ts`

```ts
export function setLabel(deck: Deck, sessionId: string, label: string | null): void;   // label already clean
export function setGroup(deck: Deck, sessionId: string, group: string | null): void;
/** A note that is empty or only whitespace is stored as null. */
export function setNote(deck: Deck, sessionId: string, note: string | null): void;
export function markDone(deck: Deck, sessionId: string): void;     // doneAtNs = clock now
export function markUndone(deck: Deck, sessionId: string): void;   // doneAtNs = null
/** prKey (checked by `requirePrKey(url): PrKey`, also exported, for a command that checks its arguments before opening the database), then ensurePr and attachPr manual in one transaction. UsageError "not a GitHub pull-request URL: <text>" when prKey is null (<text> is sanitised: it is shown on a terminal). */
export function attachManualPr(deck: Deck, sessionId: string, url: string): PrKey;
/** prKey, detachPr. UsageError when invalid; SkydeckError (1) "<url> is not attached to <short>" when nothing was detached. */
export function detachSessionPr(deck: Deck, sessionId: string, url: string): PrKey;
```

#### 2.8.6 Resume, new, guard, lock (task 16): `src/sessions/resume.ts`

```ts
export const LOCK_TTL_NS: Ns;   // 60 s
/** The kv key of the session's resume lock, `resume_lock:<sessionId>` (D16). RangeError when sessionId is not a lowercase UUID. */
export function lockKey(sessionId: string): `resume_lock:${string}`;
/**
 * 7.6 refusals (ResumeRefusedError), in this order: running → "<short> is running (pid <p>[, pid <p>…])"
 * (holders latest first); no transcript → "<short> has no transcript"; expired → "<short> has expired:
 * its transcript is gone"; project directory null → "<short>: its project directory is not known";
 * not absolute → "<short>: directory <dir> is not an absolute path"; the existence check throws →
 * "<short>: directory <dir> cannot be checked (<reason>)"; missing or not a directory →
 * "<short>: directory <dir> no longer exists". The directory checked is row.session.dir; <dir> in
 * messages is the display text row.dir.
 */
export function checkResumable(row: ListRow, files: Files): void;
/**
 * D16. In one store.transaction(): reads the lock; when it holds — younger than LOCK_TTL_NS (a time
 * less than LOCK_TTL_NS in the future counts as now) and no start event for the session at or after
 * it that names a real process (hasProcessStartSince: a pid that is not 0 and a process start time;
 * a start the hook wrote without them releases nobody's lock) — ResumeRefusedError "<short> is being resumed (<n> s ago); try again in <m> s"
 * (n rounded down, m rounded up). A value that is not a time is stale. `saw` is what the decision to
 * resume was made on (the highest id among the session's events, null for none); it is required, so
 * that no caller can skip the check: still inside the transaction, and before the lock is written,
 * the session's latest event id is read again
 * (store.latestEventIdOfSession), and when it is not `saw.latestEventId` the call throws
 * ResumeRefusedError "the session's state changed while preparing; run the command again" and writes
 * nothing. Otherwise it writes the lock with the clock's time.
 */
export interface SawEvents { latestEventId: number | null }
export function acquireLock(deck: Deck, sessionId: string, saw: SawEvents): void;
/** Deletes the locks that are stale by the same rules; returns how many. Looks first without a transaction (no stale lock: no write transaction, so a refresh with nothing to sweep takes no write lock), then reads again and deletes inside one store.transaction(). */
export function sweepLocks(deck: Deck): number;

export interface PreparedLaunch { sessionId: string; cwd: string; argv: string[]; flagsKnown: boolean; unknownFlags: string[]; kind: 'resume' | 'new' }   // kind: ruled in review
/**
 * First, ResumeRefusedError "cannot tell which sessions are running: the boot id could not be read"
 * when `row.session.bootId` is null: the boot id the row was derived with, never a second read of
 * `proc.bootId()` (a failed read and a later successful one must not be mixed; without the boot id
 * every recorded process looks dead, so the row cannot show a running session); then checkResumable, acquireLock(deck, row.id, { latestEventId:
 * row.session.lastEventId }) — the lock transaction compares it with the store, so a session that
 * another skydeck acted on since the row was read is refused — and buildResumeCommand(config.claudeCommand,
 * row.session.launch, id, row.label); `unknownFlags` is unknownFlags(row.session.launch) ([] without a launch command).
 * `prepareNew` does not read the boot id: it resumes nothing. The row must come from rows loaded
 * right after a refresh: a start event that is still a file in the spool is not in it, and the
 * lock's check of the latest event only sees ingested events. Callers use `prepareResumeById`.
 */
export function prepareResume(deck: Deck, row: ListRow): PreparedLaunch;
// src/sessions/resume-by-id.ts (it imports refresh.ts, which imports resume.ts: a separate file avoids the cycle)
/**
 * The one entry point for starting a resume (the `resume` command, the interactive list, restore): the
 * guard owns its freshness. `refresh(deck)`, `loadRows(deck)`, the row whose id is `sessionId`
 * (RefError "no session matches '<id>'" when there is none; a prefix, a label or an upper-case id names
 * nothing), then `prepareResume(deck, row)` — in this order. Callers resolve what the user pointed at
 * to a whole session id first, and pass the id, never a row they loaded earlier.
 */
export function prepareResumeById(deck: Deck, sessionId: string): PreparedLaunch;
/** 7.7: platform.uuid(), stores label/group (cleaned) as meta (no meta row when both are null), buildNewCommand, cwd = platform.cwd; `flagsKnown` true, `unknownFlags` [], `kind` 'new' (prepareResume: 'resume'). UsageError, and nothing stored, for a label or group cleanLabel/cleanGroup refuse, for an `extra` flag that picks an existing session (`sessionPickingFlags`, also inside a short-flag cluster such as `-cp`): "cannot pass <flag>[ (<long name>)] to claude: it picks an existing session; use skydeck resume", and for `--name` / `-n` (`nameFlags`): "cannot pass <flag>[ (<long name>)] to claude: the label is given with --label, and skydeck passes it as the name". The other removed flags (`--worktree`/`-w`, `--tmux`, `--bg`, `--init`, `--init-only`, `--maintenance`, `--desktop`, the cloud flags) only say where or how a new session starts, so they pass, as does a prompt (a positional argument). */
export function prepareNew(deck: Deck, options: { label: string | null; group: string | null; extra: readonly string[] }): PreparedLaunch;
```

#### 2.8.7 Restore (task 18): `src/sessions/restore.ts`

```ts
export interface RestoreEntry {
  row: ListRow;
  bootId: string;
  endedAtNs: Ns | null;           // null: no exit recorded
  wasWorking: boolean;
  preselected: boolean;
}
/** 7.8 set and preselection, in the order of `rows` (pass list order). */
export function planRestore(rows: readonly ListRow[], events: readonly EventRow[], currentBootId: string | null, all: boolean): RestoreEntry[];

export interface RestoreOutcome {
  started: string[];              // session ids with a start event in time
  timedOut: string[];
  failed: { id: string; reason: string }[];   // refused by the guard or the terminal failed
  notStarted: string[];           // left out by the memory stop
  handedOff: string | null;       // resumed --here (no tab adapter)
  printed: string[];              // command lines printed instead (no tab adapter)
  stoppedForMemory: boolean;
}
export function runRestore(
  deps: { deck: Deck; terminal: Terminal; report: (line: string) => void },
  entries: readonly RestoreEntry[],
): Promise<RestoreOutcome>;
```

### 2.9 `src/cli/`

The merged scaffold (task 0) fixes the shape of the CLI: `main(argv, ctx)` and
`dispatch(argv, ctx, commandsDir)` in `src/cli/main.ts`; `Context` and `Io` in
`src/cli/context.ts`; `Command` in `src/cli/command.ts`; `EXIT` in `src/cli/exit.ts`; one file
per command, `src/cli/commands/<name>.ts`, exporting `command` whose `name` equals the file name,
loaded by name. There is no registry: a command task creates its own file and its own test file
`test/cli/commands/<name>.test.ts` and edits no shared CLI file. Test helpers live in
`test/helpers/` (`sandbox()`, `capture()`, `testContext()`).

#### 2.9.1 `src/cli/context.ts` — extended once, by task 1

```ts
export type Io = {
  stdout(text: string): void;
  stderr(text: string): void;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
  /** Terminal size; 80×24 when stdout is not a terminal. */
  size(): { columns: number; rows: number };
  /** Writes `prompt` to stderr, reads one line of stdin without its newline; null at end of input. */
  readLine(prompt: string): Promise<string | null>;
  /** Raw-mode input, one string per chunk read (task 19 splits chunks into keys). return() restores the terminal. */
  keys(): AsyncIterableIterator<string>;
};

/** Everything a command may reach for. */
export type Context = { io: Io; platform: Platform };

/** The real standard streams and realPlatform(). */
export function processContext(): Context;
```

#### 2.9.2 Scaffold API the plan builds on (unchanged unless stated)

```ts
// src/cli/command.ts
export type Command = { name: string; summary: string; run(args: string[], ctx: Context): Promise<number> };
// src/cli/exit.ts
export const EXIT = { ok: 0, failure: 1, usage: 2, ref: 3, refused: 4, stopped: 5 } as const;
// src/cli/main.ts
export async function main(argv: string[], ctx: Context): Promise<number>;
export async function dispatch(argv: string[], ctx: Context, commandsDir: URL): Promise<number>;
```

`dispatch` changes exactly twice. **Task 12** wraps `command.run`: a thrown `SkydeckError` →
`skydeck: <message>\n` on stderr (a `RefError` adds one line `  <shortId>  <title>` per candidate)
and its `exitCode`; any other error → `skydeck: internal error: <message>\n` and `EXIT.failure` (a thrown value that has no
text, such as `Object.create(null)`, reads `unprintable value`). The text goes through the sanitiser (design 7.4) line by line, because a message can carry foreign
text (a path, a label, text from `gh`): the line breaks of a `SkydeckError` message are kept, in an
internal error's message they become spaces. One trailing newline of a `SkydeckError` message is
dropped before the final `\n` is added, so a message that ends with a usage text (2.9.3) is not
followed by a blank line.
**Task 19** routes bare `skydeck`: the interactive list when stdin and stdout are terminals, else
the `ls` command with no arguments. The `SkydeckError` exit codes equal the `EXIT` values:
`SkydeckError`/`ConfigError` → `failure`, `UsageError` → `usage`, `RefError` → `ref`,
`ResumeRefusedError` → `refused`, `RestoreStoppedError` → `stopped` (a test in task 12 checks it).

#### 2.9.3 `src/cli/deck.ts` and `src/cli/args.ts` (task 12)

```ts
// deck.ts
/**
 * openDeck(ctx.platform); refreshWithProgress when options.refresh; await fn(deck); deck.store.close() in a finally
 * (an error from close() is ignored: it must not hide the error that ended the command). A failure of the
 * database as a whole (`isDatabaseFailure`) out of the refresh or of `fn` is rethrown as a SkydeckError
 * "the database <path> failed: <reason>" (exit 1, `cause` kept); every other error passes through unchanged.
 */
export function withDeck<T>(ctx: Context, options: { refresh: boolean }, fn: (deck: Deck) => Promise<T>): Promise<T>;
/**
 * refresh(deck). When io.isTTY.stderr and kv first_scan_done is absent, shows
 * "\rskydeck: reading transcripts <done>/<total>" on stderr while scanning and clears it with
 * "\r\x1b[K" at the end (design 5.6), also when the scan fails; nothing is written when no file is read.
 */
export function refreshWithProgress(ctx: Context, deck: Deck): RefreshResult;

// args.ts
export interface ArgSpec {
  usage: string;                  // printed for --help; appended to usage errors
  flags: Record<string, { type: 'boolean' | 'string'; short?: string }>;
  min: number;                    // positionals
  max: number;
  allowRest?: boolean;            // keep everything after '--' in `rest` (for `new`)
}
export interface ParsedArgs {
  help: boolean;
  flags: Record<string, string | boolean | undefined>;
  positionals: string[];
  rest: string[];
}
/**
 * node:util parseArgs (strict). '--help' or '-h' before any '--' → { help: true } and nothing else
 * is checked. A parse error, or a positional count outside [min, max], throws UsageError whose
 * message is the reason, a newline, and spec.usage. With `allowRest` only the first '--' ends the
 * arguments of the command; without it '--' makes what follows positional.
 */
export function parseCommandArgs(args: readonly string[], spec: ArgSpec): ParsedArgs;
```

Every command begins with
`const parsed = parseCommandArgs(args, SPEC); if (parsed.help) { ctx.io.stdout(SPEC.usage); return EXIT.ok; }`
and does its work inside `withDeck(ctx, { refresh: true }, …)` unless its task says otherwise.

#### 2.9.4 Command files and shared CLI modules

| File | `name` | `summary` | `usage` (first line) | Task |
|---|---|---|---|---|
| `ls.ts` | `ls` | `Print the session list` | `skydeck ls [--all] [--json] [--refresh]` | 14 |
| `show.ts` | `show` | `Show one session` | `skydeck show <ref> [--json] [--refresh]` | 14 |
| `label.ts` | `label` | `Set or clear a session's label` | `skydeck label <ref> [<text>]` | 15 |
| `group.ts` | `group` | `Set or clear a session's group` | `skydeck group <ref> [<text>]` | 15 |
| `note.ts` | `note` | `Edit a session's note` | `skydeck note <ref> [--set <text>]` | 15 |
| `done.ts` | `done` | `Hide a session` | `skydeck done <ref>` | 15 |
| `undone.ts` | `undone` | `Show a hidden session again` | `skydeck undone <ref>` | 15 |
| `pr.ts` | `pr` | `Attach, detach or refresh pull requests` | `skydeck pr add <ref> <url> \| pr rm <ref> <url> \| pr refresh` | 15 |
| `resume.ts` | `resume` | `Resume a session` | `skydeck resume <ref> [--here \| --tab]` | 16 |
| `new.ts` | `new` | `Start a new session here` | `skydeck new [--label <text>] [--group <text>] [--here \| --tab] [-- <claude flags>]` | 16 |
| `install.ts` | `install` | `Install the hooks and links` | `skydeck install` | 17 |
| `uninstall.ts` | `uninstall` | `Remove the hooks and links` | `skydeck uninstall [--purge]` | 17 |
| `doctor.ts` | `doctor` | `Check the installation` | `skydeck doctor` | 17 |
| `restore.ts` | `restore` | `Bring back what was open` | `skydeck restore [--all] [--dry-run] [--yes]` | 18 |

Each file is `export const command: Command = { name, summary, run }`. Every command test covers
`--help` (exit 0, `usage` on stdout) and one usage error (exit 2).

```ts
// src/cli/clip.ts (task 13)
/** The start of `text` at most `width` UTF-16 units long, never ending inside a surrogate pair (not a count of terminal cells). */
export function clip(text: string, width: number): string;

// src/cli/row.ts (task 13)
/** One list row on one line (format: task 13). */
export function formatRow(row: ListRow, nowNs: Ns, width: number): string;
/** "<count>pr:<level>", e.g. "2pr:checks-failing". */
export function formatChip(chip: { level: ChipLevel; count: number }): string;
/**
 * The status of one pull request as a line prints it after the url (design 7.3: never "closed" when unreadable):
 * level cant-read → "can't read, last read <isoFromNs(okAtNs) or 'never'>" plus " (<error>)"
 * when error is set; level unfetched → "not fetched" (D11); otherwise the level. (Task 14 split it out of formatPrLine.)
 */
export function formatPrStatus(pr: PrView): string;
/** One pull request on one line: "<url>  <formatPrStatus(pr)>". */
export function formatPrLine(pr: PrView): string;

// src/cli/output.ts (task 14)
export function sessionJson(row: ListRow): SessionJson;
export function listJson(model: ListModel): ListJson;
export function showJson(row: ListRow, links: readonly LinkRow[]): ShowJson;
export function formatList(model: ListModel, nowNs: Ns, width: number): string;
export function formatShow(row: ListRow, links: readonly LinkRow[], nowNs: Ns): string;

// src/cli/notes.ts (task 15)
/**
 * Writes the note to <stateDir>/note-<sessionId>.md, runs the editor (D14) through
 * platform.runner.runInteractive, stores what comes back, removes the file (also when the editor
 * fails). The file is created with mode 0o600. UsageError when stdin is not a terminal;
 * SkydeckError "editor exited <code>" (note unchanged) on a non-zero exit; SkydeckError "editor did
 * not finish: <program> could not be run or was killed" when runInteractive returns null; SkydeckError
 * when the editor removed the file (note unchanged: a missing file is not an empty note); SkydeckError
 * "editor could not be run: <program> (<reason>)" when runInteractive rejects (a file that is not
 * executable). When the editor ended well but storing the text fails, the file is KEPT and the
 * SkydeckError "the note was not saved (<reason>); your text is in <path>" names it. A file that is already
 * there when an edit starts is not overwritten: the editor opens it, after one stderr line "skydeck: an
 * earlier edit of this note was not saved; continuing with its text in <path>". `note --set` removes
 * such a kept file after it stored the text (also exported: `discardKeptNote(deck, sessionId): void`).
 */
export function editNote(ctx: Context, deck: Deck, sessionId: string): Promise<void>;

// src/cli/launching.ts (task 16)
export interface LaunchOutcome { code: number; lines: string[] }   // lines as printed, without newlines, foreign text sanitised
/**
 * Opens a prepared command. where 'here' → hereTerminal; 'tab' → the configured adapter if it
 * opens tabs; null → config.terminal. It prints nothing: it returns the exit code and the lines for
 * the caller to show (the commands print them on stderr, the interactive list in its message line),
 * in order: "skydeck: original flags unknown; resuming with defaults" when !prepared.flagsKnown;
 * "skydeck: started with flags skydeck does not know, not passed on resume: <names>" (sanitised,
 * joined by one space) when prepared.unknownFlags is not empty; then, when the launch failed,
 * "skydeck: <reason>" and what to do instead. Success → EXIT.ok (for 'here', the caller must return
 * at once so the launcher can exec). Failure, or 'tab' without a tab adapter (D24) → EXIT.failure,
 * the lines ending with "skydeck: to start it yourself, run:" and the command ("cd -- <q dir> &&
 * <shellJoin argv>") — except after an open() whose result has timedOut (the program may have
 * started): "skydeck: run skydeck again to see whether session <id> is running" (kind 'new', a session
 * that did not start has nothing to resume: "skydeck: the new session's id is <id>; running skydeck
 * shows whether it started"); and when the
 * directory or a word of argv holds anything sanitize() would change: "skydeck: the command contains
 * control characters and cannot be printed safely". An open() that rejects is a failed open.
 */
export function launchPrepared(deck: Deck, prepared: PreparedLaunch, where: 'here' | 'tab' | null): Promise<LaunchOutcome>;
```

#### 2.9.5 The interactive list (task 13: pure; task 19: the terminal wrapper)

```ts
// src/cli/tui/model.ts
export type TuiMode = 'list' | 'detail' | 'filter' | 'input';
export interface TuiInput { purpose: 'label' | 'group' | 'pr'; text: string }
export interface TuiModel {
  rows: ReadonlyMap<string, ListRow>;                 // every row by id
  order: { name: string | null; ids: string[] }[];    // every listable row, done ones too; fixed at open, on 'r' and on 'a'
  showAll: boolean;
  filter: string;
  mode: TuiMode;
  input: TuiInput | null;
  selected: string | null;                            // id under the cursor
  scroll: number;                                     // first body line shown
  message: string | null;                             // cleared by the next key
  nowNs: Ns;
}
export type TuiEffect =
  | { kind: 'none' } | { kind: 'quit' } | { kind: 'refresh' }
  | { kind: 'label'; id: string; text: string }       // text '' clears
  | { kind: 'group'; id: string; text: string }
  | { kind: 'note'; id: string }
  | { kind: 'done'; id: string; done: boolean }        // done false = undo
  | { kind: 'pr-add'; id: string; url: string }
  | { kind: 'pr-rm'; id: string; url: string }
  | { kind: 'resume'; id: string };
/** Key names: 'up' 'down' 'enter' 'escape' 'backspace' 'ctrl-c', or one printable character. */
export function initModel(rows: readonly ListRow[], nowNs: Ns): TuiModel;
/**
 * reorder true: recompute `order` with buildList. false: keep `order`, drop rows that are gone or no longer listed at all,
 * append new rows, and rows whose group changed, to the end of their group (a new named group goes before "no group", which
 * is last), drop emptied groups. `order` always holds the done rows too, with the groups ranked by the members listed under
 * the current `showAll` (design 7.4), as `skydeck ls` ranks them; a group with nothing listed comes after the others.
 * When the selected row is no longer visible the selection moves to the first visible row and an open detail or input is
 * closed (`mode` is 'list' afterwards).
 */
export function withRows(model: TuiModel, rows: readonly ListRow[], nowNs: Ns, reorder: boolean): TuiModel;
export function withMessage(model: TuiModel, message: string | null): TuiModel;
/** Rows of `order` that are listed (showAll) and match the filter, in order. */
export function visibleRows(model: TuiModel): ListRow[];
export function reduce(model: TuiModel, key: string): { model: TuiModel; effect: TuiEffect };

// src/cli/tui/render.ts
/** Exactly size.rows lines, none longer than size.columns (layout: task 13). */
export function render(model: TuiModel, size: { columns: number; rows: number }): string[];
/**
 * The model with `scroll` moved by the least that keeps the selected row, and its group header when it is the first row of
 * its group, in view (one line per row the cursor moves, two onto a group's first row from below); a scroll out of range is
 * made valid. The wrapper calls it after every key, every `withRows` (a refresh can move the selection) and every resize. `render` uses the same rule, so it shows the selected row
 * even when the wrapper has not called it. The detail does not scroll (the model is returned as it is).
 */
export function scrolled(model: TuiModel, size: { columns: number; rows: number }): TuiModel;

// src/cli/tui/keys.ts (task 19)
/** Splits raw terminal input into key names: ESC[A up, ESC[B down, ESC OA/OB too, \r and \n enter, \x7f and \b backspace, \x03 ctrl-c, a lone ESC escape; other escape sequences are dropped. */
export function decodeKeys(chunk: string): string[];

// src/cli/tui/run.ts (task 19)
/** Opens the deck (withDeck, refresh: true) and runs the list until quit or a --here resume; returns the exit code. */
export function runInteractiveList(ctx: Context): Promise<number>;
```

### 2.10 Formats

#### 2.10.1 Spool file (written by `bin/skydeck-hook`, read by `parseSpoolFile`)

Name `<time_ns>-<claude_pid or 0>-<$$>.ev` in `<stateDir>/spool/`, written as
`.<name>.tmp` in the same directory and renamed. Content: these lines in this order, each
`key=value` with the value copied verbatim, then a line `--`, then stdin unchanged:

```
v=1
event=SessionStart
time_ns=1762988000123456789
claude_pid=4242
session_env=0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d
entrypoint_env=cli
boot_id=6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f
stat=4242 (claude) S 4100 4242 4100 34816 4242 4194304 1 0 0 0 1 0 0 0 20 0 11 0 51234567 1048576 4096 …
pwd=/home/dev/projects/demo
argv_b64=Y2xhdWRlAC0tbW9kZWwAb3B1cwA=
--
{"session_id":"0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d","transcript_path":"/home/dev/.claude/projects/-home-dev-projects-demo/0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d.jsonl","cwd":"/home/dev/projects/demo","hook_event_name":"SessionStart","source":"startup"}
```

Lines end with `\n` only; a `\r` is part of the value, so the parser splits on `\n` and nothing else.

`argv_b64` is present for `SessionStart` only, and empty when `/proc/<pid>/cmdline` cannot be
read. `stat` is empty when `/proc/<pid>/stat` cannot be read. Missing variables give empty values,
and so does a value that contains a newline or a carriage return (`event`, `session_env`,
`entrypoint_env`, `pwd`) or a `claude_pid` that is not all digits (its name part is then `0`). The parser
ignores keys it does not know (so later versions can add keys); a line before `--` without `=` is a parse error, and so
is a key that appears twice.

State directory of the hook (D26): `$SKYDECK_HOME/state` when `SKYDECK_HOME` is non-empty and absolute; else
`$XDG_STATE_HOME/skydeck` when it is non-empty and absolute; else `$HOME/.local/state/skydeck`.

#### 2.10.2 Settings entry

As design 5.1, built by `hookEntry`: `{ "hooks": [ { "type": "command", "command":
"'<hookPath>' SessionStart >/dev/null 2>&1 || true", "timeout": 5 } ] }`, appended to
`hooks.SessionStart` (and likewise `SessionEnd`).

#### 2.10.3 Handoff file and the launcher (D5)

`hereTerminal` writes, to the path in `$SKYDECK_HANDOFF`:

```
cd -- /home/dev/projects/demo || exit 1
exec claude --resume 0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d -n 'my label' --model opus
```

(the directory and every word through `shellQuote`). `bin/skydeck` (task 7) behaves exactly like this reference:

```sh
skydeck_tmp=/tmp
case ${TMPDIR:-} in
  /*) if [ -d "$TMPDIR" ]; then skydeck_tmp=$TMPDIR; fi ;;
esac
skydeck_handoff=$(mktemp "$skydeck_tmp/skydeck-handoff.XXXXXX" 2>/dev/null ||
  mktemp /tmp/skydeck-handoff.XXXXXX) || exit 1
trap 'rm -f -- "$skydeck_handoff"' EXIT
trap 'exit 130' HUP INT TERM
trap 'exit 131' QUIT
SKYDECK_HANDOFF=$skydeck_handoff
export SKYDECK_HANDOFF
skydeck_status=0
NODE_COMPILE_CACHE=$skydeck_cache "$skydeck_node" "$skydeck_root/bin/bootstrap.mjs" "$@" ||
  skydeck_status=$?
if [ -s "$skydeck_handoff" ]; then
  skydeck_script=$(cat -- "$skydeck_handoff")
  rm -f -- "$skydeck_handoff"
  trap - EXIT
  unset SKYDECK_HANDOFF
  eval "$skydeck_script"
fi
exit "$skydeck_status"
```

`$TMPDIR` counts only when it is an absolute path to a directory; if the file cannot be created
there (or `$TMPDIR` is unusable) it goes to `/tmp`, and only a failure there ends the launcher with
status 1. `$skydeck_cache` is the compile-cache path computed above the block (`$NODE_COMPILE_CACHE`
when non-empty, else `$XDG_CACHE_HOME/skydeck/compile-cache` when `XDG_CACHE_HOME` is absolute, else
`$HOME/.cache/skydeck/compile-cache`); it is given to node alone and is not exported, so the program
the handoff starts does not inherit it. The launcher's own shell variables carry the `skydeck_`
prefix (`skydeck_self`, `skydeck_root`, `skydeck_node`, …): the program the handoff starts gets the
caller's environment except `SKYDECK_HANDOFF`, and an assignment to a plain name the caller had
exported (`status`, `cache`) would change what it inherits. `CDPATH` is unset only inside the
command substitutions that `cd`, never for the program.

#### 2.10.4 Resume lock

The `kv` entry `resume_lock:<sessionId>`, its value the time it was taken in ns as decimal digits
(D16). No lock file: `<stateDir>/locks/` is created but holds nothing.

#### 2.10.5 JSON output (`src/cli/output.ts`; key order as written)

```ts
export interface PrJson {
  url: string; repo: string; number: number;
  state: PrState | null; review: PrReview | null; checks: PrChecks | null;
  okAt: string | null; error: string | null;
}
export interface SessionJson {
  id: string; shortId: string; title: string; titleSource: TitleSource;
  label: string | null; group: string | null; state: State; stateDetail: string | null;
  since: string; lastActivity: string; dir: string; marks: Mark[]; hasNote: boolean;
  continuedFrom: string | null; done: boolean; prs: PrJson[];
}
export interface ListJson { version: 1; generatedAt: string; sessions: SessionJson[] }
export interface LinkJson { kind: LinkKind; from: string; to: string; at: string }
export interface HolderJson { pid: number; bootId: string; procStart: number | null; since: string }
export interface ShowJson extends SessionJson {
  doneAt: string | null; note: string | null; launch: string[] | null; unknownFlags: string[]; links: LinkJson[]; holders: HolderJson[];
}
```

Times are `isoFromNs`. `dir` is `""` when unknown. `sessions` is in list order (groups in order,
rows in order). Output is `JSON.stringify(value, null, 2) + "\n"`, written by `jsonText`
(`src/cli/json.ts`), which also writes DEL, the C1 controls and the bidirectional controls as
`\uXXXX` escapes (the same value for `JSON.parse`, safe on a terminal). `show --json` adds, after
`prs`: `doneAt` (`isoFromNs(session.doneAtNs)` while the session is done, else `null`), `note`, `launch` (`session.launch`), `unknownFlags` (`unknownFlags(session.launch)`, `[]` when
there is no launch command), `links` (every link from or to the session, by
time), `holders` (live holders). Version 1 is stable: later changes only add keys.

## 3. Tasks

Constants used in test cases below (exported by `test/helpers/platform.ts`, task 1):

```ts
const T0 = 1_794_474_000_000_000_000n;          // 2026-11-12T09:00:00.000Z
const S1 = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';
const S2 = '1c6a4d2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e';
const S3 = '2d7b5e3a-0f4c-4b8d-9e5f-4a3b2c1d0e9f';
const BOOT_A = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const BOOT_B = '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';
const SEC = 1_000_000_000n;
```

---

### Task 1: Platform — interfaces, places, configuration, errors, `Context` and test helpers

**Depends on:** task 0 · **Wave:** 1 · **Design:** 9.1, 11, 12 · **Contracts:** 2.1, 2.2, 2.9.1 · **Decisions:** D3, D4, D26 (update design 9.1)

**Files**
- Create: `src/platform/types.ts`, `src/platform/real.ts`, `src/platform/time.ts`,
  `src/platform/paths.ts`, `src/platform/config.ts`, `src/platform/errors.ts`
- Modify: `src/cli/context.ts` (`Io` and `Context` of 2.9.1, `processContext()` with the real
  streams — `readLine` through `node:readline`, `keys` through raw mode on `process.stdin` — and
  `realPlatform()`)
- Create: `test/helpers/platform.ts`; modify `test/helpers/capture.ts`, `test/helpers/context.ts` (2.2.7)
- Modify: `docs/design.md` 9.1 (D3, D4, D26)
- Test: `test/platform/time.test.ts`, `test/platform/paths.test.ts`,
  `test/platform/config.test.ts`, `test/platform/errors.test.ts`, `test/platform/real.test.ts`,
  `test/platform/helpers.test.ts`

**Exported API** (behaviour comments in 2.2)

```ts
// types.ts
export type Ns = bigint;
export interface Clock { nowNs(): Ns; sleep(ms: number): Promise<void> }
export interface FileInfo { size: number; mtimeNs: Ns; kind: 'file' | 'dir' | 'symlink' | 'other' }
export interface Files {
  stat(path: string): FileInfo | null;
  lstat(path: string): FileInfo | null;
  readText(path: string): string | null;
  readBytes(path: string, start: number, end: number): Uint8Array;
  list(dir: string): string[];
  writeText(path: string, text: string, mode?: number): void;
  createExclusive(path: string, text: string): boolean;
  mkdirp(path: string, mode?: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  removeTree(path: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string | null;
  realpath(path: string): string | null;
  chmod(path: string, mode: number): void;
}
export interface Proc {
  bootId(): string | null;
  stat(pid: number): string | null;
  cmdline(pid: number): Uint8Array | null;
  memAvailableMb(): number | null;
}
export interface RunOptions { cwd?: string; input?: string; timeoutMs?: number; env?: Readonly<Record<string, string>> }
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; notFound: boolean }
export interface Runner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  runInteractive(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<number | null>;
}
export type Env = Readonly<Record<string, string | undefined>>;
export interface Platform {
  clock: Clock; files: Files; proc: Proc; runner: Runner; env: Env;
  homeDir: string; cwd: string; uuid(): string; nodePath: string; nodeVersion: string; appRoot: string;
}
// real.ts
export function realPlatform(): Platform;
// time.ts
export const NS_PER_MS = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;
export const NS_PER_MINUTE = 60n * NS_PER_SECOND;
export const NS_PER_DAY = 86_400n * NS_PER_SECOND;
export function isoFromNs(ns: Ns): string;
export function nsFromMs(ms: number): Ns;
export function nsFromIso(iso: string): Ns | null;
// paths.ts
export interface Places {
  dataDir: string; stateDir: string; configDir: string; claudeHome: string; dbPath: string;
  hookPath: string; nodeLink: string; spoolDir: string; badDir: string; locksDir: string;
  hookLog: string; configPath: string; binLink: string;
}
export function resolvePlaces(env: Env, homeDir: string, configuredClaudeHome: string | null): Places;
export function resolveConfigDir(env: Env, homeDir: string): string;
// config.ts
export interface Config {
  terminal: 'here' | 'wezterm'; wezterm: { domain: string | null }; groupPattern: string;
  firstRunDoneAfterDays: number; prRefreshMinutes: number; restoreBatch: number;
  restoreMinFreeMb: number; restoreStartTimeoutSeconds: number; claudeHome: string | null; claudeCommand: string;
}
export const DEFAULT_CONFIG: Config;                                      // values in 2.2.5
export function parseConfig(text: string, source: string): Config;        // throws ConfigError
export function loadConfig(files: Files, configPath: string): Config;     // throws ConfigError
// errors.ts — the classes of 2.2.6, bodies as given there
export type ExitCode = 1 | 2 | 3 | 4 | 5;
export class SkydeckError extends Error { readonly exitCode: ExitCode }
export class ConfigError extends SkydeckError {}
export class UsageError extends SkydeckError {}
export class RefError extends SkydeckError { readonly candidates: readonly { id: string; title: string }[] }
export class ResumeRefusedError extends SkydeckError {}
export class RestoreStoppedError extends SkydeckError {}
// test/helpers/platform.ts
export interface FakeClock extends Clock { setNs(ns: Ns): void; advanceMs(ms: number): void }
export function fakeClock(startNs: Ns): FakeClock;
export interface FakeProcess { stat: string; cmdline: readonly string[] }
export interface FakeProc extends Proc { setBootId(id: string | null): void; setProcess(pid: number, p: FakeProcess | null): void; setMemAvailableMb(mb: number | null): void }
export function fakeProc(init?: { bootId?: string | null; processes?: Record<number, FakeProcess>; memAvailableMb?: number | null }): FakeProc;
export function statLine(pid: number, procStart: number, comm?: string): string;
export interface RunCall { command: string; args: readonly string[]; options: RunOptions | undefined }
export interface FakeRunner extends Runner { calls: RunCall[]; interactiveCalls: RunCall[] }
export function fakeRunner(handler?: (call: RunCall) => RunResult | Promise<RunResult>, interactive?: (call: RunCall) => number | null): FakeRunner;
export function runResult(partial: Partial<RunResult>): RunResult;
export interface TestPlatformOptions { env?: Record<string, string | undefined> | ((s: Sandbox) => Record<string, string | undefined>); startNs?: Ns; bootId?: string; memAvailableMb?: number }
export interface TestPlatform { platform: Platform; sandbox: Sandbox; clock: FakeClock; proc: FakeProc; runner: FakeRunner; places: Places }
export function testPlatform(t: TestContext, options?: TestPlatformOptions): TestPlatform;
// test/helpers/capture.ts
export interface CaptureOptions { stdinTTY?: boolean; stdoutTTY?: boolean; stderrTTY?: boolean; lines?: readonly string[]; keys?: readonly (string | (() => string))[]; size?: { columns: number; rows: number } }
export interface Captured { io: Io; stdout: () => string; stderr: () => string; prompts: string[] }
export function capture(options?: CaptureOptions): Captured;
// test/helpers/context.ts
export interface TestCtx { ctx: Context; stdout: () => string; stderr: () => string; prompts: string[] }
export function testContext(): TestCtx;
export function testContext(t: TestContext, options?: TestPlatformOptions & CaptureOptions): TestCtx & TestPlatform;
// src/cli/context.ts
export type Io = { stdout(text: string): void; stderr(text: string): void; isTTY: { stdin: boolean; stdout: boolean; stderr: boolean }; size(): { columns: number; rows: number }; readLine(prompt: string): Promise<string | null>; keys(): AsyncIterableIterator<string> };
export type Context = { io: Io; platform: Platform };
export function processContext(): Context;
```

**Test cases**

`time.test.ts`
- `isoFromNs(1_762_988_000_123_456_789n)` → `'2025-11-12T22:53:20.123Z'`; `isoFromNs(T0)` → `'2026-11-12T09:00:00.000Z'`.
- `nsFromMs(1_762_988_000_123)` → `1_762_988_000_123_000_000n`.
- `nsFromIso('2026-11-12T09:00:00.000Z')` → `T0`; `nsFromIso('2026-11-12T10:00:00.000+01:00')` → `T0`; `nsFromIso('yesterday')` → `null`.

`paths.test.ts` (home `/h`)
- env `{}` → `dataDir '/h/.local/share/skydeck'`, `stateDir '/h/.local/state/skydeck'`,
  `configDir '/h/.config/skydeck'`, `claudeHome '/h/.claude'`, `dbPath '/h/.local/share/skydeck/skydeck.db'`,
  `hookPath '/h/.local/share/skydeck/skydeck-hook'`, `nodeLink '/h/.local/share/skydeck/node'`,
  `spoolDir '/h/.local/state/skydeck/spool'`, `badDir '/h/.local/state/skydeck/spool/bad'`,
  `locksDir '/h/.local/state/skydeck/locks'`, `hookLog '/h/.local/state/skydeck/hook.log'`,
  `configPath '/h/.config/skydeck/config.json'`, `binLink '/h/.local/bin/skydeck'`.
- `{ XDG_DATA_HOME: '/x/d', XDG_STATE_HOME: '/x/s', XDG_CONFIG_HOME: '/x/c' }` → `/x/d/skydeck`, `/x/s/skydeck`, `/x/c/skydeck`.
- `{ XDG_DATA_HOME: 'rel/d', XDG_STATE_HOME: '' }` → both ignored (defaults under `/h`).
- `{ SKYDECK_HOME: '/s', XDG_DATA_HOME: '/x/d' }` → `/s/data`, `/s/state`, `/s/config`; `{ SKYDECK_HOME: 'rel' }` → ignored (D26).
- `{ CLAUDE_CONFIG_DIR: 'rel' }` → `claudeHome '/h/.claude'` (D26).
- `{ CLAUDE_CONFIG_DIR: '/c' }` → `claudeHome '/c'`; same env with `configuredClaudeHome '/k'` → `'/k'` (D3).
- `resolveConfigDir({ SKYDECK_HOME: '/s' }, '/h')` → `'/s/config'`; `resolveConfigDir({}, '/h')` → `'/h/.config/skydeck'`.

`config.test.ts` (write files in a temp dir; `source` is the path)
- missing file → deep-equals `DEFAULT_CONFIG`; `'{}'` → `DEFAULT_CONFIG`.
- `'{"terminal":"wezterm","wezterm":{"domain":"WSL:Ubuntu"},"restoreBatch":2}'` → defaults with those three values.
- `'{"wezterm":{}}'` → `wezterm.domain` `null`.
- Each of these throws `ConfigError` whose message contains the path and the named key:
  `'not json'` (no key), `'[]'`, `'{"colour":1}'` (`colour`), `'{"wezterm":{"domian":"x"}}'` (`domian`),
  `'{"terminal":"kitty"}'` (`terminal`), `'{"restoreBatch":0}'`, `'{"restoreBatch":1.5}'`,
  `'{"restoreBatch":"3"}'` (`restoreBatch`), `'{"groupPattern":"("}'` (`groupPattern`),
  `'{"claudeHome":"rel/dir"}'` (`claudeHome`), `'{"claudeCommand":""}'` (`claudeCommand`),
  `'{"wezterm":{"domain":5}}'` (`domain`).

`errors.test.ts`
- `new SkydeckError('x').exitCode` → 1; `ConfigError` 1; `UsageError` 2; `RefError` 3 with
  `candidates` kept; `ResumeRefusedError` 4; `RestoreStoppedError` 5; each `instanceof SkydeckError`
  and `instanceof Error`; `new UsageError('x').name` → `'UsageError'`.

`real.test.ts` (real platform; temp directory from `fs.mkdtempSync`, removed in `t.after`)
- `clock.nowNs()` is within 5 s of `BigInt(Date.now()) * 1_000_000n`; 1000 successive calls never decrease.
- files: `writeText(p,'a')` then `readText(p)` → `'a'`, and the directory then holds only `p`'s name;
  `writeText(p,'b',0o600)` → mode `0o600` (checked with `fs.statSync`); `createExclusive(q,'x')` → `true`, again → `false`;
  `readText(missing)` → `null`; `stat(missing)` → `null`; `list(missing)` → `[]`;
  `list(dir with c, a, b)` → `['a','b','c']`; `readBytes(file 'abcdefg', 2, 5)` → bytes of `'cde'`;
  `symlink(t1, l)` then `symlink(t2, l)` → `readlink(l)` → `t2`; `lstat(l).kind` → `'symlink'`,
  `stat(l).kind` → `'file'`; `readlink(regular file)` → `null`; `mkdirp(a/b/c, 0o700)` → mode `0o700`;
  `remove(missing)` does not throw; `removeTree(dir)` → `stat(dir)` `null`; `realpath(l)` → `t2`.
- proc: `bootId()` matches `/^[0-9a-f-]{36}$/`; `stat(process.pid)` starts with `` `${process.pid} (` ``;
  `cmdline(process.pid)` contains the bytes of `process.execPath`; `stat(999_999_999)` → `null`;
  `memAvailableMb()` > 0.
- runner (every call passes `{ env: s.env() }` from `s = sandbox(t)` with `s.link('sh', 'cat', 'sleep')`; `env` is shown only where it matters):
  `run('sh', ['-c', 'printf out; printf err >&2; exit 3'])` → `{ code: 3, stdout: 'out', stderr: 'err', timedOut: false, notFound: false }`;
  `run('sh', ['-c', 'cat'], { input: 'x' })` → stdout `'x'`;
  `run('sh', ['-c', 'sleep 5'], { timeoutMs: 100 })` → `timedOut: true`, `code: null`, resolves in < 2 s;
  `run('skydeck-no-such-program', [])` → `notFound: true`, `code: null`;
  `run('sh', ['-c', 'printf %s "$HOME"'], { env: s.env() })` → stdout `s.home` (the child sees only the given environment);
  `runInteractive('sh', ['-c', 'exit 4'])` → `4`.
- `uuid()` matches the lowercase UUID pattern of 2.1 and two calls differ; `homeDir` → `os.homedir()`;
  `files.stat(appRoot + '/bin/skydeck')` is not `null`; `nodePath` → `process.execPath`.

`helpers.test.ts` (`test/platform/helpers.test.ts`; files in `test/helpers/` are never named `*.test.ts`)
- `fakeClock(T0)`: `nowNs()` → `T0`; `advanceMs(1500)` → `T0 + 1_500_000_000n`; `await sleep(1000)` → `+ SEC` more.
- `statLine(4242, 51234567, 'we) ird')`: the 20th space-separated field after the last `')'` + 1 char is `'51234567'`
  (`line.slice(line.lastIndexOf(')') + 2).split(' ')[19]`), and the line starts with `'4242 (we) ird) '`.
- `fakeProc({ bootId: BOOT_A, processes: { 4242: { stat: statLine(4242, 99), cmdline: ['claude', '--model', 'opus'] } }, memAvailableMb: 8000 })`:
  `bootId()` → `BOOT_A`; `stat(4242)` → that line; `cmdline(4242)` → bytes `'claude\0--model\0opus\0'`;
  `stat(1)` → `null`; after `setProcess(4242, null)` → `null`; `memAvailableMb()` → 8000.
- `fakeProc` with `cmdline: []` → `cmdline(pid)` is zero bytes.
- `fakeRunner()` → `run` resolves `runResult({})` and records `{ command, args, options }` in `calls`.
- `testPlatform(t)`: `platform.env.SKYDECK_HOME` → `sandbox.skydeckHome`; `places.dataDir` → `<sandbox.skydeckHome>/data`;
  `places.claudeHome` → `sandbox.claudeHome`; `platform.env.HOME` → `sandbox.home`; `platform.uuid()` twice →
  `'00000000-0000-4000-8000-000000000001'`, `…002`; `clock.nowNs()` → `T0`; `proc.bootId()` → `BOOT_A`.
- `capture({ lines: ['y'], stdinTTY: true })`: `io.isTTY.stdin` true, `stdout` false; `await io.readLine('Q? ')` → `'y'`,
  then `null`; `prompts` → `['Q? ', 'Q? ']`; the prompt is written to stderr. `capture({ keys: ['j', 'q'] })`: `io.keys()` yields
  `'j'`, `'q'`, then ends; `capture({ keys: [() => { calls++; return 'x'; }] })` calls the function only when the iterator reaches it. `io.size()` → `{ columns: 80, rows: 24 }` by default.
- `testContext()` (no `t`): `--version` through `main` still works; touching `ctx.platform.clock.nowNs()` throws
  `/pass t to testContext/`. `testContext(t)`: `ctx.platform === result.platform`, `ctx.io === ` the captured io.
- The scaffold's `test/cli/main.test.ts` passes unchanged.

**Steps**
- [ ] Write the six test files above. Run `npm test` → the new files fail with "Cannot find module".
- [ ] Implement `src/platform/*`, the `Context` extension and the helpers; update design 9.1 (D3, D4, D26).
- [ ] Run `npm run check` → all tests pass, type check clean.
- [ ] Run `rg -n "process\.env|Date\.now|hrtime|node:child_process|'/proc" src --glob '!src/platform/real.ts'`
      → no output.
- [ ] Commit `Add the platform layer: clock, files, /proc, runner, places, configuration`; open the PR.

**Done when:** every listed case passes; `realPlatform()` is the only place touching the real
clock, environment, `/proc` and child processes; `testContext(t)` gives later tasks a context
whose home, `SKYDECK_HOME` and Claude home are inside the sandbox.

---

### Task 2: Pure helpers — `/proc` parsing, launch flags, pull-request keys

**Depends on:** task 0 · **Wave:** 1 · **Design:** 5.3 (field 22, cmdline, path flags), 5.5, 7.3 (key), 7.6, 7.7 · **Contracts:** 2.5.1, 2.5.2, 2.6 (`PrKey`, `prKey`) · **Decisions:** D18, D28 (update design 7.6; 5.3 and principle 4 for what is stored)

**Files**
- Create: `src/claude/procstat.ts`, `src/claude/launch.ts`
- Create: `src/github.ts` holding only `PrKey` and `prKey` (task 9 adds the rest of 2.6 to this file)
- Create: `test/fixtures/claude/flags-2.1.323.json` (Claude Code's own option table: every spelling of every root flag with its shape, nothing else)
- Modify: `docs/design.md` 7.6 (D18; D28: the removed-flags rule and the flags added to it; unknown flags), the sentence of 5.3 that says what is stored of the launch command, and the last sentence of principle 4
- Test: `test/claude/procstat.test.ts`, `test/claude/launch.test.ts`, `test/github-key.test.ts`

**Exported API**

```ts
// src/github.ts (this task's part)
export interface PrKey { url: string; owner: string; repo: string; number: number }
export function prKey(text: string): PrKey | null;
// src/claude/procstat.ts
export function procStartFromStat(line: string): number | null;
export function argvFromCmdline(bytes: Uint8Array): string[];
// src/claude/launch.ts — FLAGS exactly as in 2.5.2
export type FlagShape = 'none' | 'one' | 'optional' | 'many';
export interface FlagSpec { names: readonly string[]; shape: FlagShape; remove: boolean; picksSession: boolean; path: boolean }
export const FLAGS: readonly FlagSpec[];
export type ParsedArg =
  | { kind: 'flag'; spec: FlagSpec | null; name: string; tokens: string[]; values: string[] }
  | { kind: 'positional'; tokens: [string] };
export function parseLaunchArgs(args: readonly string[]): ParsedArg[];
export function absolutizePathFlags(argv: readonly string[], cwd: string | null, exists: (path: string) => boolean): string[];
export function storableArgv(argv: readonly string[]): string[];
export function unknownFlags(argv: readonly string[]): string[];
export function isPrintRun(argv: readonly string[]): boolean;
export interface FoundFlag { written: string; spec: FlagSpec }
export function sessionPickingFlags(args: readonly string[]): FoundFlag[];   // picksSession flags, clusters included (2.5.2)
export function nameFlags(args: readonly string[]): FoundFlag[];             // --name / -n
export interface ResumeCommand { argv: string[]; flagsKnown: boolean }
export function buildResumeCommand(input: { claudeCommand: string; launch: readonly string[] | null; sessionId: string; label: string | null }): ResumeCommand;
export function buildNewCommand(input: { claudeCommand: string; sessionId: string; label: string | null; extra: readonly string[] }): string[];
```

**Test cases**

`procStartFromStat`:

```
'4242 (claude) S 4100 4242 4100 34816 4242 4194304 1 0 0 0 1 0 0 0 20 0 11 0 51234567 1048576 4096' → 51234567
'4242 (a) b) S 4100 4242 4100 34816 4242 4194304 1 0 0 0 1 0 0 0 20 0 11 0 51234567 1048576 4096'   → 51234567
'4242 (my prog) S 4100 4242 4100 34816 4242 4194304 1 0 0 0 1 0 0 0 20 0 11 0 7 0 0'                → 7
''  → null        'garbage' → null        '4242 (claude) S 1 2 3' → null
'4242 (claude) S 4100 4242 4100 34816 4242 4194304 1 0 0 0 1 0 0 0 20 0 11 0 x 0 0'                → null
the same with field 22 = 9007199254740991 → 9007199254740991; = 9007199254740992 or 100000000000000000000 → null (not a safe integer)
```

`argvFromCmdline` (bytes given as strings): `'claude\0--model\0opus\0'` → `['claude','--model','opus']`;
`'claude\0x'` → `['claude','x']`; `'claude\0\0x\0'` → `['claude','','x']`; `''` → `[]`;
`'claude\0-n\0čeština\0'` → `['claude','-n','čeština']`; `'claude\0--system-prompt\0\0'` → `['claude','--system-prompt','']`.

`prKey` (test file `test/github-key.test.ts`)

```
'https://github.com/Owner/Repo/pull/12'          → { url: 'https://github.com/owner/repo/pull/12', owner: 'owner', repo: 'repo', number: 12 }
'https://github.com/o/r/pull/12/files#diff-1'    → url 'https://github.com/o/r/pull/12'
'https://github.com/o/r/pull/12?w=1'             → url 'https://github.com/o/r/pull/12'
'http://www.GitHub.com/o/r.js/pull/3'            → url 'https://github.com/o/r.js/pull/3'
null for: 'https://gitlab.com/o/r/pull/1', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/0',
          'https://github.com/o/r/pull/01', 'https://github.com/-o/r/pull/1', 'https://github.com/o/../pull/1',
          'https://github.com/o/r/pull/2147483648', 'github.com/o/r/pull/1', 'https://github.com/o/r/pull/12abc'
```

`FLAGS`: every name starts with `-` and appears once; the names with `path: true` are exactly
`--mcp-config --add-dir --settings --plugin-dir --plugin-dir-no-mcp --system-prompt-file --append-system-prompt-file --append-subagent-system-prompt-file`;
the names with `remove: true` are exactly
`-r --resume -c --continue --session-id --fork-session -n --name -w --worktree --tmux --bg --background --from-pr --teleport --cloud --remote --desktop --environment --pool --rewind-files --resume-session-at --resume-drops-turn --reply-on-resume --attach-serve --session-began-as-copy --init-only --handle-uri --ref --on-branch --correlation-id --forward-home-settings --init --maintenance --deep-link-origin --deep-link-repo --deep-link-last-fetch --deep-link-cwd-b64 --prefill --prefill-b64`;
the names with `picksSession: true` are exactly
`-r --resume -c --continue --session-id --fork-session --from-pr --teleport --rewind-files --resume-session-at --resume-drops-turn --reply-on-resume --attach-serve --session-began-as-copy --handle-uri --deep-link-origin --deep-link-repo --deep-link-last-fetch --deep-link-cwd-b64 --prefill --prefill-b64`
(each of them has `remove: true`; the other removed flags, `-n`/`--name` included, have `picksSession: false`);
`--remote` shares its spec with `--cloud`, and `--pool` with `--environment`. The fixture
`test/fixtures/claude/flags-2.1.323.json` is Claude Code 2.1.323's own table (every spelling of
every root flag, hidden ones included, with its shape): FLAGS has every name of it with the same
shape, and no name that is not in it. Hidden flags are looked at by shape: `--enable-auto-mode`
takes no value, `--channels` and `--dangerously-load-development-channels` take several, `-d2e` is a
flag of its own and not `-d` with a value, `--max-turns` takes one.

`parseLaunchArgs` (input → tokens of each item; `F` flag with spec, `U` unknown flag, `P` positional). For every case, the concatenated tokens equal the input:

```
['--model','opus']                 → F['--model','opus'] values ['opus']
['--model=opus']                   → F['--model=opus']   values ['opus']
['-c']                             → F['-c']             values []
['--add-dir','a','b','--verbose']  → F['--add-dir','a','b'], F['--verbose']
['--add-dir','a','hello']          → F['--add-dir','a','hello']                       (D18)
['--add-dir','-x','b','--verbose'] → F['--add-dir','-x','b'], F['--verbose']          (the first value is taken whatever it is)
['--add-dir','--model','opus']     → F['--add-dir','--model','opus']                  (values ['--model','opus'])
['--add-dir','a','-x','b']         → F['--add-dir','a'], U['-x','b']                  (from the second value on, a flag stops it)
['--add-dir']                      → F['--add-dir']      values []
['-r']                             → F['-r']             values []
['-r','abc']                       → F['-r','abc']       values ['abc']
['-r','--model','x']               → F['-r'], F['--model','x']
['--frob','x','y']                 → U['--frob','x'], P['y']
['--frob','--model','x']           → U['--frob'], F['--model','x']
['--','-p','x']                    → P['--'], P['-p'], P['x']
['hello world']                    → P['hello world']
['--model']                        → F['--model']        values []
['-rabc']                          → F['-rabc']          values ['abc']     (glued value; name '-r')
['-wfeat','fix the bug']           → F['-wfeat'], P['fix the bug']          (nothing more consumed)
['-n=x','y']                       → F['-n=x']           values ['=x'], P['y']
['-cp','x']                        → F['-cp'], P['x']                       (cluster of no-value flags)
['-cn','foo']                      → F['-cn','foo']      values ['foo']     (cluster ending in a value flag)
['-c-model','opus']                → F['-c-model','opus'] values ['opus']          (`-c` then `--model opus`)
['-c-model=opus','x']              → F['-c-model=opus']  values ['opus'], P['x']
['-c-','--model','opus']           → F['-c-'], P['--model'], P['opus']              (`-c` then `--`: the flags end)
['-p-','x']                        → F['-p-'], P['x']
['-c-frob','x']                    → U['-c-frob','x']    values ['x']               (name '--frob')
['-n-foo','x']                     → F['-n-foo'], P['x']                            (the value of `-n` is '-foo')
['-cnfoo','x']                     → F['-cnfoo'], P['x']                    (values ['foo'])
['-cZ','x']                        → U['-cZ','x']                           (an unknown letter: unknown as a whole; its `name` is '-Z', and '-Zabc' is '-Z' too)
['-d2e']                           → F['-d2e']           values []          (a flag's own name wins over the letters)
['-']                              → P['-']
['--add-dir','a','-','--verbose']  → F['--add-dir','a','-'], F['--verbose'] (a lone '-' is a value)
```

The `spec` of a cluster is that of its first flag with `remove: true`, else of its last flag:
`-pc`, `-rabc` and `-c-model` have `remove: true`, `-pv`, `-dv`, `-p-` and `-p-model` do not.

`sessionPickingFlags` and `nameFlags` (`written`, first spelling of the flag found):

```
sessionPickingFlags, for every flag with picksSession (each spelling; V = [] for shape none, else ['v']):
  [name, ...V]            → [[name, flag]]
  [`${name}=v`]           (long flags with a value) → [[name, flag]]
  [`-p${x}`], [`-${x}p`]  (no-value short flags, x = the letter) → [[`-p${x}`, flag]], [[`-${x}p`, flag]]
  [`-${x}abc`]            (short flags with a value) → [[`-${x}`, flag]]
['-pr','abc'] → [['-pr','-r']]      ['-c-model','opus'] → [['-c-model','-c']]      ['-cw'] → [['-cw','-c']]
['-w','feat','--model','x','fix the bug'], ['--worktree'], ['-pw'], ['-wfeat'], and every other removed flag
  that is not picksSession (with a value where it takes one)                                        → []
['--model','-c'], ['-wc'], ['-nc'], ['--model','x','--','-r','abc']                                → []   (a value, or after `--`)
['--worktree','-c']                                                                                  → [['-c','-c']]
['-c','--model','x','--resume','a','--fork-session'] → [['-c','-c'],['--resume','-r'],['--fork-session','--fork-session']]
['-cZ'], ['-cZfix'], ['-pcZ','x'], ['-c-frob','x'], ['-c-frob=x'], ['-pc-frob']  → [[<the token>,'-c']]   (the flags read before the unknown part)
['-Zc'], ['-pZ'], ['-p-frob'], ['--frob','x']                                       → []   (nothing that picks a session was read before it)
nameFlags: ['-n','x'], ['--name=x'], ['-nx'] → [['-n','-n']], [['--name','-n']], [['-n','-n']];  ['-pn','x'] → [['-pn','-n']];
  ['-w','n','--model','-n','-r','abc'] and ['--model','x','--','-n','x'] → []
```

`absolutizePathFlags` (`exists` = membership in a given set):

```
argv ['claude','--mcp-config','mcp.json'], cwd '/p', exists {'/p/mcp.json'} → ['claude','--mcp-config','/p/mcp.json']
same, exists {}                                                             → unchanged
['claude','--mcp-config','/abs.json'], exists {'/abs.json'}                 → unchanged
['claude','--settings=s.json'], cwd '/p', exists {'/p/s.json'}              → ['claude','--settings=/p/s.json']
['claude','--add-dir','../lib','x'], cwd '/p/q', exists {'/p/lib'}          → ['claude','--add-dir','/p/lib','x']
['claude','--plugin-dir','./plug'], cwd '/p', exists {'/p/plug'}            → ['claude','--plugin-dir','/p/plug']
['claude','--model','opus'], cwd '/p', exists {'/p/opus'}                   → unchanged
['claude','--mcp-config','m.json'], cwd null                                → unchanged
['claude','--system-prompt-file','s.md','--append-system-prompt-file=a.md','--plugin-dir-no-mcp','p','--append-subagent-system-prompt-file','x.md'], cwd '/p', exists always → every value absolute under /p
['claude','--add-dir','a'], cwd 'p' (not absolute), exists always           → unchanged
['claude','--add-dir',''], cwd '/p', exists always                          → unchanged   (an empty value; also '--add-dir=')
['claude','--add-dir','bad','ok'], cwd '/p', exists throws for '/p/bad', true for '/p/ok' → ['claude','--add-dir','bad','/p/ok']
```

`buildResumeCommand` (`claudeCommand 'claude'`, `sessionId S1`; `R = ['claude','--resume',S1]`;
design 14: `-n` with `--resume` names the resumed session, so a label is always passed):

```
launch ['/usr/local/bin/claude','--model','opus'], label null      → [...R,'--model','opus'], flagsKnown true
same, label 'fix retry'                                            → [...R,'-n','fix retry','--model','opus']
['claude','--resume','old','--model','opus']                       → [...R,'--model','opus']
['claude','-r']                                                    → R
['claude','-c','--verbose']                                        → [...R,'--verbose']
['claude','--session-id','x','--fork-session']                     → R
['claude','-n','old name','--name=other']                          → R
['claude','-w','feature','--bg','--from-pr','123']                 → R
['claude','--teleport','abc','--cloud','--desktop','--remote-control','rc'] → [...R,'--remote-control','rc']   (D28)
['claude','-w','--model','opus']                                   → [...R,'--model','opus']
['claude','--dangerously-skip-permissions','--permission-mode','plan'] → [...R,'--dangerously-skip-permissions','--permission-mode','plan']
['claude','--mcp-config','/a.json','/b.json','--add-dir','/x','--settings','/s.json'] → [...R, …the same seven tokens]
['claude','fix the bug']                                           → R
['claude','--add-dir','/x','--model','opus','fix it']              → [...R,'--add-dir','/x','--model','opus']
['claude','--add-dir','/x','fix it']                               → [...R,'--add-dir','/x','fix it']   (D18)
['claude','--frobnicate','v','prompt']                             → R   (a flag in no table is not passed on, nor what follows it)
['claude','--model','opus','--frobnicate','--verbose']             → [...R,'--model','opus','--verbose']
['claude','--model=opus','--resume=abc']                           → [...R,'--model=opus']
['claude','--','-p']                                               → R
['claude','--continue','--worktree','w','--background','--resume=x','--name','n'] → R   (long forms)
['claude','-rabc','--fork-session']                                → R   (glued short flags)
['claude','-c-model','opus','--verbose']                           → [...R,'--verbose']   (`-c` is removed, so the token goes whole)
['claude','-c-','--model','opus']                                  → R   (`-c --`: the rest is positional)
['claude','-p-model','opus']                                       → [...R,'-p-model','opus']
['claude','-p-','prompt']                                           → [...R,'-p-']
['claude','-nfoo','--model','opus']                                → [...R,'--model','opus']
['claude','-wfeat','fix the bug']                                  → R
['claude','-cp','fix it']                                          → R   (a cluster with a removed flag is removed whole)
['claude','-pv']                                                   → [...R,'-pv']
['claude','-cZ','x']                                               → R   (unknown as a whole: not passed on)
['claude','--rewind-files','m','--resume-session-at','m','--resume-drops-turn','x','--reply-on-resume','--attach-serve','a','--session-began-as-copy','b','--init-only','--handle-uri','u','--model','opus'] → [...R,'--model','opus']
['claude','--enable-auto-mode','--channels','plugin:a@x','plugin:b@y','--max-turns','5','--thinking','enabled','-d2e','fix it'] → [...R, …the same flags and values]
['claude','--cloud','--ref','main','--on-branch','b','--correlation-id','c','--forward-home-settings','h','--init','--maintenance','--model','opus'] → [...R,'--model','opus']
['claude','--add-dir','-scratch','b','--model','opus']             → [...R,'--add-dir','-scratch','b','--model','opus']   (the first value is taken whatever it is)
['claude','-']                                                     → R   (a lone '-' is a positional)
['claude','--prefill-b64=Zml4','--deep-link-origin','--deep-link-repo=o/r','--deep-link-last-fetch','1','--deep-link-cwd-b64','L3A','--prefill','fix','--model','opus'] → [...R,'--model','opus']
['claude','--remote','d','--environment','e','--pool','p','--tmux','-w','--model','opus'] → [...R,'--model','opus']
['claude','--remote-control','rc']                                 → [...R,'--remote-control','rc']   (a different flag, kept)
launch null, label null                                            → R, flagsKnown false
launch null, label 'x'                                             → [...R,'-n','x'], flagsKnown false
claudeCommand '/opt/claude', launch ['claude']                     → ['/opt/claude','--resume',S1]
launch ['claude'] (no permission flag recorded)                    → R  (no permission flag is ever added)
```

Every flag of the table (a loop over `FLAGS`, each spelling): for a spec with `remove: true`, the
launch `['claude', name, ...V]` gives `R`; with `remove: false` it gives `[...R, name, ...V]`, where
`V` is `[]` for shape `none`, `['v']` for `one`, `optional` and `many`, and `['v1','v2']` as well for `many`.

`storableArgv` (program first; the program is always kept, `[]` gives `[]`):

```
['claude','fix the bug']                                           → ['claude']
['claude','--model','opus','-d','api','--add-dir','/x','/y','--verbose'] → unchanged   (one-, optional- and several-value flags keep their values)
['claude','--model=opus','-dapi','prompt']                         → ['claude','--model=opus','-dapi']
['claude','--add-dir','/x','fix it']                               → unchanged   (D18: the prompt is the flag's value)
['claude','--frobnicate','v','prompt']                             → ['claude','--frobnicate']   (an unknown flag: its bare name only)
['claude','--frobnicate=fix it','--model=opus']                    → ['claude','--frobnicate','--model=opus']
['claude','-c-model','opus','--verbose']                           → ['claude','--verbose']
['claude','-p-model','opus','prompt']                              → ['claude','-p-model','opus']
['claude','-p-','--model','opus']                                  → ['claude','-p-']   (`-p --`: the rest is positional)
['claude','-c-frob','x','--model','opus']                          → ['claude','--frob','--model','opus']
['claude','-cZ','x','-Zabc','y']                                   → ['claude','-Z','-Z']   (an unknown letter: that letter alone)
['claude','-cZfix the login bug','--model','opus','-Zsecret']      → ['claude','-Z','--model','opus','-Z']
['claude','--model','opus','--','-p','text']                       → ['claude','--model','opus']
['claude','--resume','abc','-n','my name','--prefill-b64=Zml4','--prefill','fix','--deep-link-repo','o/r','-wfeat','--model','opus','--cloud'] → ['claude','--model','opus']
```

Every flag of the table (a loop over `FLAGS`, each spelling, `V` as above): `['claude', name, ...V]`
gives `['claude']` for `remove: true`, and itself for `remove: false`. The input is not modified.
Over a list of launch commands (the cases above, with clusters, a lone `-`, `--`, deep-link flags):
`buildResumeCommand` gives the same result for the command and for `storableArgv` of it, with and
without a label; `storableArgv(storableArgv(x))` equals `storableArgv(x)`; the flags of
`storableArgv(x)` that are in a table, minus the removed ones, are exactly `buildResumeCommand(x).argv.slice(3)`
(no label); and `unknownFlags(storableArgv(x))` equals `unknownFlags(x)`.

`unknownFlags` (program first): `['claude','--frob','x','--model','opus','--other=1','--frob','-Z','y']` →
`['--frob','--other','-Z']`; `['claude','-cZ','x']` → `['-Z']`; only known flags, `['claude']` and `[]` → `[]`;
the program and what follows `--` are never named.

`isPrintRun` (program first): `['claude','-p','hi']`, `['claude','--print']`, `['claude','-cp','hi']`,
`['claude','-pc']`, `['claude','-hp']` → true; `['claude']`, `[]`, `['claude','--model','opus','-c']`,
`['claude','--system-prompt','-p']`, `['claude','--','-p']`, `['-p']` (the program), `['claude','-np']`
(`-n` takes the rest of its token), `['claude','-pZ']` (an unknown letter) → false; and
`isPrintRun(['claude','-cp','hi'])` is true while `isPrintRun(storableArgv(['claude','-cp','hi']))` is false;
`['claude','-p-']`, `['claude','-p-model','opus']` and `['claude','-cp-']` → true; `['claude','-c-','-p']`, `['claude','-c-p']`
and `['claude','-c-model','opus']` → false.

A property test with a fixed seed (a small generator in the test file) builds 3000 random commands
from the table's names, `--`, `-`, `''`, clusters (`-cp`, `-c-`, `-p-`, `-c-model`, …), glued short flags, unknown flags and plain words, and
checks: the tokens of `parseLaunchArgs` give back the input; `storableArgv` twice equals once; the
`resume` equivalence above; `unknownFlags` of stored equals of recorded; and that no positional, no
removed flag and no value of an unknown flag survives in the stored command.

`buildNewCommand`: `{ claudeCommand: 'claude', sessionId: S1, label: null, extra: [] }` →
`['claude','--session-id',S1]`; `label 'x y', extra ['--model','opus']` →
`['claude','--session-id',S1,'-n','x y','--model','opus']`.

Both builders throw `RangeError` for a `sessionId` that is not a lowercase UUID (`''`,
`'--dangerously-skip-permissions'`, an upper-case UUID, a UUID with anything around it).

**Steps**
- [ ] Write the three test files and the fixture. `npm test` → new tests fail ("Cannot find module").
- [ ] Implement the three source files; none of them imports anything from `src/` (`launch.ts` uses `node:path` only).
- [ ] `npm run check` → pass.
- [ ] Commit `Add /proc parsing, the launch-flag table and pull-request keys`; open the PR.

**Done when:** all cases pass; every flag of the table is exercised; no permission flag is ever added.

---

### Task 3: The hook — `bin/skydeck-hook` and its settings entries

**Depends on:** 1 · **Wave:** 2 · **Design:** 5.1, 5.2, 8 (entries), 12 (hook, settings) · **Contracts:** 2.5.6, 2.10.1, 2.10.2 · **Decisions:** D6 (update design 5.2), D26

**Files**
- Create: `bin/skydeck-hook` (mode 755, `#!/bin/sh`; CI's `shellcheck bin/skydeck*` covers it), `src/claude/settings.ts`
- Modify: `docs/design.md` 5.2 (D6)
- Test: `test/bin/hook.test.ts`, `test/claude/settings.test.ts`

**Exported API**

```ts
// src/claude/settings.ts
export const HOOK_EVENTS: readonly ['SessionStart', 'SessionEnd'];
export type HookEvent = 'SessionStart' | 'SessionEnd';
export function settingsPath(claudeHome: string): string;
export function hookCommand(hookPath: string, event: HookEvent): string;          // throws SkydeckError on a quote in hookPath
export function hookEntry(hookPath: string, event: HookEvent): { hooks: [{ type: 'command'; command: string; timeout: 5 }] };
export interface SettingsEdit { text: string; changed: boolean; events: HookEvent[] }
export function addHookEntries(settingsText: string | null, hookPath: string): SettingsEdit;   // throws SkydeckError on malformed settings
export function removeHookEntries(settingsText: string, hookPath: string): SettingsEdit;       // throws SkydeckError on malformed settings
export function hookStatus(settingsText: string | null, hookPath: string): Record<HookEvent, boolean>;
export function cleanupPeriodDays(settingsText: string | null): number;
```

`bin/skydeck-hook <event>` writes the spool file of 2.10.1 and nothing else. Rules (design 5.1):
it prints nothing on stdout or stderr in any case; it always exits 0; it uses only `sh` builtins,
`date`, `cat`, `base64`, `mkdir` and `mv`; its own errors are appended to `<stateDir>/hook.log`
(when even that fails, they are discarded). `time_ns` is `date +%s%N` taken first. The cmdline is
encoded with `base64 -w 0`. `<random>` is `$$` (D6). `entrypoint_env=${CLAUDE_CODE_ENTRYPOINT-}`
(design 14: `cli` for interactive sessions, `sdk-cli` for `claude -p`). The state directory follows
2.10.1, where `SKYDECK_HOME` and `XDG_STATE_HOME` count only when absolute (D26).

**Test cases**

`test/bin/hook.test.ts` — spawns `bin/skydeck-hook` with `child_process` (`spawnSync` / `spawn`), stdin
`INPUT = '{"session_id":"' + S1 + '","hook_event_name":"SessionStart","source":"startup","cwd":"/w"}\n'`,
`s = sandbox(t)`, `s.link('sh', 'date', 'cat', 'base64', 'mkdir', 'mv')` — so the hook runs with
only the six allowed programs on `PATH` — env
`s.env({ CLAUDE_CODE_SESSION_ID: S1, CLAUDE_CODE_ENTRYPOINT: 'cli', … })` per case, cwd `s.root`;
`<sd>` = `s.skydeckHome`. "The process" is a `sleep 30` the test spawns (killed in `t.after`), so
its cmdline is `'sleep\0' + '30\0'`.

1. `SessionStart` with `CLAUDE_PID=<sleep pid>` → exit 0, stdout `''`, stderr `''`; exactly one
   entry in `<sd>/state/spool/`, named `^[0-9]{19}-<pid>-[0-9]+\.ev$`; no `.tmp` left. Content:
   lines `v=1`, `event=SessionStart`, `time_ns=<digits within ±5 s of the test's clock>`,
   `claude_pid=<pid>`, `session_env=<S1>`, `entrypoint_env=cli`,
   `boot_id=<content of /proc/sys/kernel/random/boot_id, trimmed>`,
   `stat=<the line of /proc/<pid>/stat>`, `pwd=<s.root>`, `argv_b64=<base64 that decodes to 'sleep\0' + '30\0'>`,
   `--`, then `INPUT` byte for byte (the file name's first part equals `time_ns`).
2. `SessionEnd` → same keys except no `argv_b64` line; `event=SessionEnd`.
3. No `CLAUDE_PID` → name `^[0-9]{19}-0-[0-9]+\.ev$`; `claude_pid=`, `stat=`, `argv_b64=` empty; exit 0, silent.
4. `CLAUDE_PID=999999999` → `stat=` and `argv_b64=` empty; exit 0, silent.
5. `SKYDECK_HOME` is a directory with mode `0500` → exit 0, silent, nothing created inside
   (skip with `t.skip` when `process.getuid() === 0`).
6. `SKYDECK_HOME` is a regular file → exit 0, silent.
7. `<sd>/state/spool` is a regular file → exit 0, silent, and `<sd>/state/hook.log` is non-empty.
8. `SKYDECK_HOME: undefined`, `XDG_STATE_HOME=<s.root>/xs` → the file is in `<s.root>/xs/skydeck/spool/`;
   both unset → in `<s.home>/.local/state/skydeck/spool/`; `SKYDECK_HOME=rel` (relative) → treated as unset (D26).
9. Ten hooks at once (`spawn` ×10, same `CLAUDE_PID`, awaited together) → ten `.ev` files with
   distinct names, each containing a `--` line followed by `INPUT`.
10. Every case above runs with only the six linked programs on `PATH`; the script text contains no
    other external command (a test greps it for a fixed deny list: `printf` is a builtin, but `sed`,
    `awk`, `tr`, `head`, `od`, `node` must not appear).

`settings.test.ts` (`H = '/home/dev/.local/share/skydeck/skydeck-hook'`, `E(ev)` = `hookEntry(H, ev)`)
- `hookCommand(H, 'SessionStart')` → `"'/home/dev/.local/share/skydeck/skydeck-hook' SessionStart >/dev/null 2>&1 || true"`.
- `hookCommand("/a'b", 'SessionEnd')` throws `SkydeckError`.
- `hookEntry(H, 'SessionEnd')` deep-equals `{ hooks: [{ type: 'command', command: hookCommand(H, 'SessionEnd'), timeout: 5 }] }`.
- `addHookEntries(null, H)` → `changed true`, `events ['SessionStart','SessionEnd']`,
  `JSON.parse(text)` deep-equals `{ hooks: { SessionStart: [E('SessionStart')], SessionEnd: [E('SessionEnd')] } }`,
  `text === JSON.stringify(JSON.parse(text), null, 2) + '\n'`.
- Foreign entries survive: input
  `{"model":"opus","hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"other"}]}]}}` →
  `Object.keys(parsed)` is `['model','hooks']`; `hooks.SessionStart` is `[<the foreign group>, E('SessionStart')]`; `hooks.SessionEnd` is `[E('SessionEnd')]`.
- Install twice changes once: `addHookEntries(first.text, H)` → `changed false`, `text === first.text`, `events []`.
- Half installed (only `SessionStart` ours) → `events ['SessionEnd']`.
- Throw `SkydeckError`: `'not json'`, `'[]'`, `'{"hooks":[]}'`, `'{"hooks":{"SessionStart":{}}}'`.
- `removeHookEntries(addHookEntries(null, H).text, H)` → `changed true`, `text '{}\n'`, `events` both.
- Remove keeps foreign: from the foreign-entries result above → exactly the original foreign input structure.
- A group holding a foreign hook and ours → only ours removed, the group stays with the foreign hook.
- Nothing ours → `changed false`, `text` identical to the input.
- An entry whose command merely contains `H` (`"\"/home/dev/.local/share/skydeck/skydeck-hook\" SessionStart"`) → removed.
- `hookStatus(null, H)` → both false; after add → both true; foreign only → both false.
- `cleanupPeriodDays(null)` → 30; `'{"cleanupPeriodDays":14}'` → 14; `'{"cleanupPeriodDays":0}'` → 30;
  `'{"cleanupPeriodDays":"9"}'` → 30; `'bad'` → 30.
- `settingsPath('/c')` → `'/c/settings.json'`.

**Steps**
- [ ] Write both test files. `npm test` → they fail (no script, no module).
- [ ] Write `bin/skydeck-hook`; `chmod 755`; make sure git records the mode (`git update-index --chmod=+x bin/skydeck-hook`).
- [ ] Write `src/claude/settings.ts`.
- [ ] `npm run check` → pass; `shellcheck bin/skydeck bin/skydeck-hook` → no findings (CI runs it; locally if installed).
- [ ] Update design 5.2 (D6). Commit `Add the sh hook and the settings entries that install it`; open the PR.

**Done when:** all cases pass; CI shellchecks the hook; the script contains no program other than
the six allowed.

---

### Task 4: Store

**Depends on:** 1 · **Wave:** 2 · **Design:** 9.2, 5.3 (idempotent rows), 5.6 (`last_turn_role`), 7.3 (attach/detach SQL) · **Contracts:** 2.4 · **Decisions:** D1 (update design 9.2)

**Files**
- Create: `src/store/types.ts`, `src/store/migrations.ts`, `src/store/store.ts`
- Modify: `docs/design.md` 9.2 (D1: integers are read as BigInt and times are `bigint`)
- Test: `test/store/store.test.ts`

**Exported API**

```ts
// types.ts (field comments in 2.4.1)
export type EventKind = 'start' | 'end' | 'observed';
export type StartDetail = 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown';
export type EndDetail = 'clear' | 'switch' | 'exit' | 'other';
export interface EventRow {
  id: number; spoolName: string | null; timeNs: Ns; kind: EventKind; detail: StartDetail | EndDetail | '';
  rawDetail: string | null; sessionId: string; bootId: string; pid: number; procStart: number | null;
  cwd: string | null; argv: string[] | null; name: string | null; payload: string | null;
}
export type NewEvent = Omit<EventRow, 'id'>;
export type LinkKind = 'clear' | 'switch' | 'fork';
export interface LinkRow { eventId: number; fromSession: string; toSession: string; kind: LinkKind; timeNs: Ns }
export interface SessionMeta { sessionId: string; label: string | null; group: string | null; note: string | null; doneAtNs: Ns | null; createdNs: Ns; updatedNs: Ns }
export interface MetaPatch { label?: string | null; group?: string | null; note?: string | null; doneAtNs?: Ns | null }
export interface TranscriptRow {
  path: string; sessionId: string; sizeRead: number; fileSize: number; mtimeNs: Ns;
  firstCwd: string | null; entrypoint: string | null; aiTitle: string | null; customTitle: string | null;
  firstRecordNs: Ns | null; lastRecordNs: Ns | null; lastUserNs: Ns | null;
  lastTurnRole: 'user' | 'assistant' | null; missingSinceNs: Ns | null;
}
export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type PrReview = 'approved' | 'changes-requested' | 'review-required';
export type PrChecks = 'passing' | 'failing' | 'pending';
export interface PrRow {
  url: string; owner: string; repo: string; number: number; title: string | null; state: PrState | null;
  review: PrReview | null; checks: PrChecks | null; okAtNs: Ns | null; triedAtNs: Ns | null; error: string | null;
}
export type PrFetchResult =
  | { ok: true; atNs: Ns; title: string; state: PrState; review: PrReview | null; checks: PrChecks | null }
  | { ok: false; atNs: Ns; error: string };
export type PrOrigin = 'auto' | 'manual';
export interface SessionPrRow { sessionId: string; url: string; origin: PrOrigin; firstSeenNs: Ns; detachedAtNs: Ns | null }
export type KvKey = 'schema_version' | 'dropped_scripted' | 'settings_hash' | 'settings_backup'
  | 'first_scan_done' | 'first_run_offered' | 'doctor_probe'
  | 'ingest_problems' | 'reconcile_problems' | 'scan_problems';   // the last three: task 8
// migrations.ts
export const MIGRATIONS: readonly string[];
export const SCHEMA_VERSION: number;
// store.ts (behaviour comments in 2.4.3)
export interface Store {
  readonly path: string;
  close(): void;
  connectionSettings(): { journalMode: string; synchronous: number; busyTimeout: number; foreignKeys: number };
  transaction<T>(fn: () => T): T;
  insertEvent(event: NewEvent): number | null;
  insertLink(link: LinkRow): void;
  events(): EventRow[];
  latestEventOfProcess(bootId: string, pid: number, procStart: number | null, beforeNs: Ns): EventRow | null;
  processHasLaunch(bootId: string, pid: number, procStart: number | null): boolean;
  hasStartSince(sessionId: string, sinceNs: Ns): boolean;
  hasProcessStartSince(sessionId: string, sinceNs: Ns): boolean;
  latestEventIdOfSession(sessionId: string): number | null;
  links(): LinkRow[];
  meta(sessionId: string): SessionMeta | null;
  allMeta(): SessionMeta[];
  updateMeta(sessionId: string, patch: MetaPatch, nowNs: Ns): SessionMeta;
  transcripts(): TranscriptRow[];
  saveTranscript(row: TranscriptRow): void;
  ensurePr(key: { url: string; owner: string; repo: string; number: number }): void;
  prs(): PrRow[];
  savePrResult(url: string, result: PrFetchResult): void;
  attachPr(sessionId: string, url: string, origin: PrOrigin, nowNs: Ns): void;    // throws when the prs row is missing
  detachPr(sessionId: string, url: string, nowNs: Ns): boolean;
  sessionPrs(): SessionPrRow[];
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
  deleteKv(key: KvKey): void;
  addToKv(key: KvKey, delta: number): void;
}
export function openStore(path: string): Store;   // throws SkydeckError (exit 1) for a newer schema
export function isDatabaseFailure(error: unknown): boolean;   // added by task 8
```

Implementation notes that are part of the contract: open with `new DatabaseSync(path, { readBigInts: true })`
(D1) and convert `id`, `pid`, `proc_start`, `size_read`, `file_size`, `number` to `number`;
`argv` is stored as `JSON.stringify(string[])`; `group` maps to the column `group_name`; booleans
do not exist in the schema. Events are bound with `bigint` for every `*_ns` column.

**Test cases** (each on a fresh database in a temp directory; `ev(over)` builds a `NewEvent` with
`spoolName 'a.ev'`, `timeNs T0`, `kind 'start'`, `detail 'startup'`, `rawDetail 'startup'`,
`sessionId S1`, `bootId BOOT_A`, `pid 4242`, `procStart 51234567`, `cwd '/w'`,
`argv ['claude']`, `name null`, `payload '{}'` and the overrides)

- `openStore` on a new path → `connectionSettings()` deep-equals
  `{ journalMode: 'wal', synchronous: 2, busyTimeout: 5000, foreignKeys: 1 }` (2 is FULL), file mode
  `0o600`, `getKv('schema_version')` → `'1'`, tables `events session_meta links transcripts prs session_prs kv` exist.
- Open twice → second open runs no migration and the data is kept. `close()` twice does not throw.
- `setKv('schema_version', '2')`, close, open → throws `SkydeckError` with exit code 1 mentioning "newer".
- `insertEvent(ev())` → `1`; again with the same spool name → `null`; `events()` has one row
  equal to `{ id: 1, ...ev() }` (deep equal: `timeNs` is `T0` as bigint, `argv` an array).
- A `timeNs` of `1_762_988_000_123_456_789n` round-trips exactly.
- Observed events (`spoolName null`) can be inserted twice (two rows).
- `events()` order is by (timeNs, id): insert times `T0+2s`, `T0`, `T0` → ids `[2, 3, 1]`.
- `latestEventOfProcess(BOOT_A, 4242, 51234567, T0 + SEC)` with events at `T0`, `T0+2s` → the `T0` one;
  with `procStart null` it matches only rows whose `proc_start` is NULL; another boot → `null`.
- `processHasLaunch`: a process whose only event has `argv null` → `false`; add one with argv → `true`.
- With a start event at `T0`: `hasStartSince(S1, T0)` → `true`; `hasStartSince(S1, T0 + 1n)` → `false`; an `end` row does not count.
- `hasProcessStartSince`: as `hasStartSince` (the same three cases), and a start with `pid 0`, one with `procStart null` and one with both → `false`
  until a start with a pid and a `procStart` exists → `true` (`hasStartSince` counts all of them).
- `latestEventIdOfSession`: `null` for a session without events (another session's events do not count); otherwise the highest id of
  its events whatever their times and kinds (an `end` or an `observed` event counts, a later id with an earlier time wins).
- `insertLink({ eventId: 1, fromSession: S1, toSession: S2, kind: 'clear', timeNs: T0 })` → `links()` returns it;
  a link whose `eventId` has no event → throws (foreign key).
- `updateMeta(S1, { label: 'x' }, T0)` creates `{ label 'x', group null, note null, doneAtNs null, createdNs T0, updatedNs T0 }`;
  then `updateMeta(S1, { group: 'G' }, T0 + SEC)` keeps the label, sets group, `updatedNs T0+SEC`, `createdNs T0`;
  `updateMeta(S1, { label: null }, …)` clears only the label; `meta(S2)` → `null`; `allMeta()` lists one.
- `saveTranscript(row)` with `lastTurnRole 'user'` then `transcripts()` → deep equal (the column `last_turn_role` holds `'user'`);
  saving the same path again replaces it; `lastTurnRole null` round-trips as `null`.
- `ensurePr({ url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 })` twice → one row with
  every other column null.
- `savePrResult(url, { ok: true, atNs: T0, title: 't', state: 'open', review: null, checks: 'pending' })` →
  `okAtNs T0, triedAtNs T0, error null`; then `{ ok: false, atNs: T0 + SEC, error: 'boom' }` →
  `state 'open'`, `okAtNs T0`, `triedAtNs T0+SEC`, `error 'boom'`; then ok again → `error null`.
- `attachPr(S1, url, 'auto', T0)` → row `origin auto, firstSeenNs T0, detachedAtNs null`; again with
  `'auto'` at `T0+1s` → unchanged; `detachPr(S1, url, T0+2s)` → `true`, `detachedAtNs T0+2s`;
  `attachPr(S1, url, 'auto', T0+3s)` → still detached; `attachPr(S1, url, 'manual', T0+4s)` →
  `origin manual`, `detachedAtNs null`, `firstSeenNs T0`; `attachPr(S1, url, 'auto', …)` → still `manual`.
- `detachPr(S2, url, …)` (never attached) → `false`. `attachPr` for a url without a `prs` row → throws.
- kv: `getKv('doctor_probe')` → `null`; `addToKv('dropped_scripted', 2)` twice → `'4'`; `deleteKv` → `null`.
- `transaction(() => { insertEvent(ev({ spoolName: 'x.ev' })); throw new Error('no'); })` → rethrows and
  `events()` is empty; a successful transaction returns the function's value.

**Steps**
- [ ] Write `test/store/store.test.ts`. `npm test` → fails.
- [ ] Implement the three files; `MIGRATIONS[0]` is the design 9.2 SQL verbatim.
- [ ] `npm run check` → pass. `rg -n "node:sqlite" src` → only `src/store/store.ts`.
- [ ] Commit `Add the SQLite store: migration 1 and typed access`; open the PR.

**Done when:** all cases pass and the store is the only module with SQL.

---

### Task 5: Hook-input parser and its fixtures

**Depends on:** 2 · **Wave:** 2 · **Design:** 5.2, 5.3 (parsing, scripted runs), 12 (fixtures), 14 · **Contracts:** 2.5.3, 2.10.1 · **Decisions:** D7 (update design 5.3)

**Files**
- Create: `src/claude/hookinput.ts`
- Create fixtures (principle 4: real field names and shapes, ids/paths/names replaced, no
  conversation text): `test/fixtures/claude/hook-input/` with one JSON file per event and detail —
  `start-startup.json`, `start-resume.json`, `start-clear.json`, `start-compact.json`,
  `start-fork.json`, `start-named.json` (with `session_title`), `end-clear.json`, `end-resume.json`,
  `end-prompt_input_exit.json`, `end-logout.json`, `end-other.json`; and
  `test/fixtures/claude/spool/` with one spool file per event — `1794474000000000000-4242-1.ev`
  (start, startup, argv `claude --model opus`) and `1794474060000000000-4242-2.ev` (end, clear).
  Each hook-input fixture has `session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus
  `source` or `reason`; session ids are `S1`; `cwd` is `/home/dev/projects/demo`.
- Create: `test/helpers/spool.ts`
- Modify: `docs/design.md` 5.3 (D7)
- Test: `test/claude/hookinput.test.ts`

**Exported API**

```ts
// src/claude/hookinput.ts (imports only src/claude/procstat.ts, src/claude/launch.ts, and type Ns)
export interface SpoolEvent {
  spoolName: string; timeNs: Ns; kind: 'start' | 'end';
  detail: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown' | 'switch' | 'exit' | 'other';
  rawDetail: string | null; sessionId: string; bootId: string; pid: number; procStart: number | null;
  cwd: string | null; argv: string[] | null; name: string | null; payload: string; entrypointEnv: string | null;
  scripted: boolean;
}
export const START_DETAILS: Readonly<Record<string, SpoolEvent['detail']>>;
export const END_DETAILS: Readonly<Record<string, SpoolEvent['detail']>>;
export class SpoolParseError extends Error {}
export function parseSpoolFile(name: string, content: string, exists: (path: string) => boolean): SpoolEvent;  // throws SpoolParseError

// test/helpers/spool.ts — used by tasks 8, 14, 18
export interface SpoolFields {
  event: 'SessionStart' | 'SessionEnd';
  timeNs: bigint;
  pid: number | null;                 // null → claude_pid empty
  input: Record<string, unknown> | string;   // object → JSON.stringify + '\n'
  sessionEnv?: string;                // default: input.session_id when it is a string, else ''
  entrypointEnv?: string;             // default 'cli'
  bootId?: string;                    // default BOOT_A
  procStart?: number | null;          // default 51234567; null → stat empty
  pwd?: string;                       // default '/home/dev/projects/demo'
  argv?: readonly string[] | null;    // SessionStart only; default ['claude']; null → argv_b64 empty
}
export function spoolName(fields: SpoolFields, seq: number): string;   // `${timeNs}-${pid ?? 0}-${seq}.ev`
export function spoolText(fields: SpoolFields): string;                 // 2.10.1, stat built with statLine
/** A hook input as the fixtures have it: session_id, transcript_path, cwd, hook_event_name, plus extra. */
export function hookInput(event: 'SessionStart' | 'SessionEnd', sessionId: string, extra: Record<string, unknown>): Record<string, unknown>;
```

**Test cases** (`parse(fields)` = `parseSpoolFile(spoolName(fields, 1), spoolText(fields), () => false)`)

- The fixture `1794474000000000000-4242-1.ev` → deep-equals
  `{ spoolName: '1794474000000000000-4242-1.ev', timeNs: T0, kind: 'start', detail: 'startup', rawDetail: 'startup', sessionId: S1, bootId: BOOT_A, pid: 4242, procStart: 51234567, cwd: '/home/dev/projects/demo', argv: ['claude','--model','opus'], name: null, payload: <the text after the '--' line, exactly>, entrypointEnv: 'cli', scripted: false }`.
- `source` `resume` / `clear` / `compact` / `fork` → that detail; `'weird'` → `'unknown'` with `rawDetail 'weird'`; no `source` → `'unknown'`, `rawDetail null`.
- `reason` `clear` → `'clear'`; `resume` → `'switch'`; `prompt_input_exit` → `'exit'`; `logout` → `'exit'`; `other` → `'other'`; `'terminal_closed'` → `'other'` with `rawDetail 'terminal_closed'`.
- `SessionEnd` with an `argv_b64` line present anyway → `argv null`.
- `session_title: 'my name'` → `name 'my name'`; absent → `null`.
- Input `session_id` S1 and `sessionEnv` S2 → S1; input without `session_id`, `sessionEnv` S2 → S2;
  input `session_id 'nope'`, `sessionEnv` S2 → S2; uppercase S1 → lowercase S1; neither valid → `SpoolParseError`.
- Input without `cwd`, `pwd '/p'` → `cwd '/p'`; both empty → `null`.
- `pid null` → `pid 0`, `procStart null`; `procStart null` with a pid → `procStart null`.
- A stat line whose comm is `'a) b'` → `procStart` still parsed from field 22.
- `argv null` → `argv null`.
- argv `['claude','--model','opus','fix the bug']` → `['claude','--model','opus']`; `['claude','--','fix the bug']` → `['claude']`;
  `['claude','--prefill-b64=Zml4','--resume','abc','--model','opus']` → `['claude','--model','opus']` (the removed flags go too: `storableArgv`);
  `['claude','--new-flag','fix the bug']` (a flag the table does not know) → `['claude','--new-flag']`: the following argument cannot be classified, so it is not stored (principle 4).
- argv `['claude','--mcp-config','mcp.json']`, input cwd `/w`, `exists` true only for `/w/mcp.json` → `['claude','--mcp-config','/w/mcp.json']`.
- `entrypointEnv ''` → `entrypointEnv null`. An extra line `future_key=1` before `--` is ignored.
- Lines are split on `\n` only: `pwd '/p\rentrypoint_env=sdk-cli'` with no input `cwd` → `cwd '/p\rentrypoint_env=sdk-cli'` and `entrypointEnv` still `'cli'`.
- `payload` is exactly the bytes after the `--\n` line, trailing newline included.
- `SpoolParseError` for: name `'x.ev'`; no `--` line; `v=2`; `event=Stop`; `time_ns=abc`; empty `boot_id`;
  `claude_pid=abc`; input `'not json'`; input `'[1]'`; a line `garbage` before `--`; a missing `v`, `event`, `time_ns` or `boot_id` line;
  a key twice before `--` (`pwd=/a` and `pwd=/b`, and likewise `future_key=1` twice).
- Every hook-input fixture file parses inside a spool built with `spoolText({ …, input: <fixture text> })`
  and gives the detail its file name says.
- `scripted` (the `SessionStart` is built with `argv` and `entrypointEnv`; `parse(fields).scripted`):
  `['claude','-p','hi']` with no entry point set (`entrypointEnv ''`) → true; `['claude','--print']` and `'cli'` → true;
  `['claude','-c','-p']` and `['claude','-cp','hi']` with `'cli'` → true, while the stored `argv` is `['claude','-p']` for the first
  (`-p` is a kept flag) and `['claude']` for the second (`-cp` is dropped whole): the answer comes from the command as recorded; `['claude','--','-p']` and `'cli'` → false;
  `['claude']` with `'sdk-cli'` → true; with `'sdk-ts'` → true; `argv null` with `'sdk-py'` → true; `['claude']` with `'cli'` → false;
  `['claude']` with `''` → false; `argv null` with `''` → false. A `SessionEnd` has no command: with `'sdk-cli'` → true, with `'cli'` → false,
  and an `argv_b64` line carrying `-p` on a `SessionEnd` with `'cli'` → false.

**Steps**
- [ ] Write fixtures, `test/helpers/spool.ts`, and the test file. `npm test` → fails.
- [ ] Implement `src/claude/hookinput.ts`.
- [ ] `npm run check` → pass. `rg -n "import" src/claude/hookinput.ts` shows only `./procstat.ts`, `./launch.ts` and a type import of `../platform/types.ts`.
- [ ] Commit `Parse spool files into normalised events`; open the PR.

**Done when:** all cases pass; a `claude -p` run (argv with `-p`, entry point `sdk-cli`) is
recognised as scripted by either rule alone, `claude -c -p` included.

---

### Task 6: Live-session files and transcripts

**Depends on:** 1, 2 · **Wave:** 2 · **Design:** 5.5, 5.6 (incl. the last turn role), 6.2 (fields), 12 (fixtures, transcripts) · **Contracts:** 2.5.4, 2.5.5 · **Decisions:** D2 (update design 14)

**Files**
- Create: `src/claude/live.ts`, `src/claude/transcripts.ts`
- Create fixtures: `test/fixtures/claude/sessions/busy.json`, `idle.json`, `waiting.json`
  (`waitingFor: "permission prompt"`), `shell.json`, `stale.json` (a `procStart` no process has),
  each with the D2 shape:
  `{"pid":4242,"sessionId":"<S1>","cwd":"/home/dev/projects/demo","startedAt":1794474000000,"procStart":"51234567","version":"2.1.323","peerProtocol":1,"kind":"interactive","entrypoint":"cli","status":"busy","updatedAt":1794474030000,"statusUpdatedAt":1794474030000,"name":"demo name","nameSource":"derived"}`;
  `test/fixtures/claude/transcripts/records.jsonl` with one line per record type used — `user`,
  `assistant`, `ai-title`, `custom-title`, `pr-link`, `system` — real key sets (D2 survey:
  `user` has `type, uuid, parentUuid, isSidechain, timestamp, cwd, entrypoint, sessionId, version, gitBranch, message`;
  `ai-title` has `type, aiTitle, sessionId`; `custom-title` has `type, customTitle, sessionId`;
  `pr-link` has `type, sessionId, prNumber, prUrl, prRepository, timestamp`), every message
  content replaced by the string `"<redacted>"`.
- Modify: `docs/design.md` 14 (D2: the live-file field types)
- Test: `test/claude/live.test.ts`, `test/claude/transcripts.test.ts`

**Exported API**

```ts
// src/claude/live.ts
export interface ProcessKey { bootId: string; pid: number; procStart: number | null }
export interface LiveFile {
  pid: number; sessionId: string; cwd: string | null; procStart: number | null; entrypoint: string | null;
  name: string | null; status: string | null; waitingFor: string | null;
  updatedAtNs: Ns | null; statusUpdatedAtNs: Ns | null; mtimeNs: Ns;
}
export function readLiveFiles(files: Files, claudeHome: string): LiveFile[];
export function isSessionId(text: string): boolean;   // lowercase UUID, ruled at review (2.5.4)
export function isAlive(p: ProcessKey, proc: Proc, currentBootId: string | null): boolean;
export function isLiveFileTrusted(f: LiveFile, proc: Proc): boolean;
// src/claude/transcripts.ts
export interface TranscriptFile { path: string; sessionId: string; size: number; mtimeNs: Ns }
export interface UnreadableEntry { path: string; reason: string }
export function listTranscriptFiles(files: Files, claudeHome: string): { files: TranscriptFile[]; unreadable: UnreadableEntry[] };
export interface TranscriptFacts {
  firstCwd: string | null; entrypoint: string | null; aiTitle: string | null; customTitle: string | null;
  firstRecordNs: Ns | null; lastRecordNs: Ns | null; lastUserNs: Ns | null;
  lastTurnRole: 'user' | 'assistant' | null;
}
export const EMPTY_FACTS: TranscriptFacts;
export function foldLines(facts: TranscriptFacts, lines: readonly string[]): { facts: TranscriptFacts; prUrls: string[] };
export interface TranscriptRead { facts: TranscriptFacts; sizeRead: number; prUrls: string[] }
export function readTranscript(files: Files, file: TranscriptFile, previous: { facts: TranscriptFacts; sizeRead: number } | null): TranscriptRead;
```

**Test cases** — use `testPlatform(t)`; `C` = `places.claudeHome`; files are written with `node:fs`.

`live.test.ts`
- `busy.json` copied to `C/sessions/4242.json` → one `LiveFile`
  `{ pid: 4242, sessionId: S1, cwd: '/home/dev/projects/demo', procStart: 51234567, entrypoint: 'cli', name: 'demo name', status: 'busy', waitingFor: null, updatedAtNs: T0 + 30n*SEC, statusUpdatedAtNs: T0 + 30n*SEC, mtimeNs: <the file's mtime> }`.
- `procStart` given as the number `77` → `77`; `statusUpdatedAt` absent → `null`; `waiting.json` → `waitingFor 'permission prompt'`; `shell.json` → `status 'shell'`.
- Skipped: `4244.json` with `{`; `4245.json` without `sessionId`; `4246.json.tmp`. `abc.json` with mode `0o000`
  is not opened (the call does not throw; skip when root). `C/sessions` missing → `[]`. Results sorted by pid.
- `isAlive` with `fakeProc({ bootId: BOOT_A, processes: { 4242: { stat: statLine(4242, 51234567), cmdline: ['claude'] } } })`:
  `({BOOT_A,4242,51234567}, proc, BOOT_A)` → true; current boot `BOOT_B` → false (reboot);
  `procStart 999` → false (reused pid); pid 4243 → false; `procStart null` → false; `currentBootId null` → false.
- `isLiveFileTrusted`: pid 4242 / procStart 51234567 → true; procStart `null` → false; `stale.json` → false; pid absent from proc → false.

`transcripts.test.ts`
- Layout: `C/projects/-home-dev-projects-demo/<S1>.jsonl`, `C/projects/other/<S2>.jsonl`,
  `C/projects/-home-dev-projects-demo/<S1>/subagents/agent-1.jsonl`, `…/<S1>.jsonl.bak`,
  `…/<S1> (copy).jsonl`, `…/<S1 uppercased>.jsonl`, `…/notes.txt`, a directory `…/<S3>.jsonl/` →
  `listTranscriptFiles(...).files` is exactly the first two, sorted by path, with `sessionId`, `size`, `mtimeNs`;
  `unreadable` is `[]`. `C/projects` missing → `{ files: [], unreadable: [] }`.
- A symbolic link loop in `C/projects`, a folder of mode `000` (skipped when root) and a failing `stat`, `list` or `lstat` →
  the rest is listed and the entry is in `unreadable` with its path and error code (`ELOOP`, `EACCES`); `projects` itself unreadable →
  `{ files: [], unreadable: [{ path: <projects>, reason }] }`; an entry that is gone (`stat` null) is not reported.
- `foldLines(EMPTY_FACTS, [user line cwd '/w', entrypoint 'cli', timestamp '2026-11-12T09:00:00.000Z'])` →
  `firstCwd '/w'`, `entrypoint 'cli'`, `firstRecordNs = lastRecordNs = lastUserNs = T0`,
  `lastTurnRole 'user'`.
- Then an `assistant` line at `T0+5s` with `cwd '/other'` → `firstCwd '/w'`, `lastRecordNs T0+5s`, `lastUserNs T0`, `lastTurnRole 'assistant'`.
- Then a `user` line (a tool result) → `lastTurnRole 'user'`; then `system`, `ai-title` and `pr-link` lines → still `'user'`.
- `lastTurnRole` follows file order, not timestamps: a `user` line with timestamp `T0+20s` followed by an `assistant` line with `T0+10s` → `'assistant'`.
- `ai-title 'First'` then `ai-title 'Second'` → `aiTitle 'Second'`; same for `custom-title`.
- A `pr-link` (`prUrl 'https://github.com/o/r/pull/7'`, timestamp `T0+9s`) → `prUrls ['https://github.com/o/r/pull/7']`, `lastRecordNs T0+9s`.
- Three `pr-link` lines (two distinct, one repeated) → all three urls in order.
- `'not json'`, `'[1,2]'`, a record with `timestamp 'bad'` → no change.
- A later line with an earlier timestamp → `firstRecordNs` is the minimum.
- First entrypoint `'sdk-ts'` → `entrypoint 'sdk-ts'`.
- `JSON.stringify(facts)` after folding `records.jsonl` does not contain `'<redacted>'`.
- A hostile `aiTitle '\x1b]0;pwn\x07Title'` is kept raw (sanitising is the list model's job).
- `readTranscript(previous null)` on a 3-line file → `sizeRead` = file size, facts of the 3 lines.
- Half-written last line: content `L1\nL2\n{"type":"user","timest` → `sizeRead` = bytes of `L1\nL2\n`; the
  partial line is not folded; after appending its rest and `\n`, reading with that `previous` folds it and `sizeRead` = size.
- Shrunk: `previous { facts: <aiTitle 'Old'>, sizeRead: 10_000 }` on a 300-byte file → read from 0, `aiTitle` from the file only.
- A title with multi-byte characters (`'Opravit čeština ✳'`) decodes exactly.
- `prUrls` contain only the urls of newly read lines.

**Steps**
- [ ] Write fixtures and both test files. `npm test` → fails.
- [ ] Implement `live.ts` and `transcripts.ts` (`procStartFromStat` from `./procstat.ts`).
- [ ] `npm run check` → pass. Commit `Read live-session files and transcripts`; open the PR.

**Done when:** all cases pass; no file in `C/sessions/` other than `^[0-9]+\.json$` is ever opened;
no message text is kept.

---

### Task 7: Text and terminals — sanitiser, shell quoting, ages, the launcher handoff

**Depends on:** 1 · **Wave:** 2 · **Design:** 7.4 (sanitiser), 7.6 ("Where", quoting), 7.7, 9.1, 13 (open point on tabs) · **Contracts:** 2.3, 2.7, 2.10.3 · **Decisions:** D5, D15 (update design 7.6), D26

**Files**
- Create: `src/text/sanitize.ts`, `src/text/shell.ts`, `src/text/age.ts`
- Create: `src/terminals/types.ts`, `src/terminals/here.ts`, `src/terminals/wezterm.ts`, `src/terminals/index.ts`
- Modify: `bin/skydeck` — replace the final `exec "$node" …` with the handoff block of 2.10.3
  (the Node selection lines above it stay; the compile-cache lines set `$cache` instead of exporting
  `NODE_COMPILE_CACHE`, and ignore a relative `XDG_CACHE_HOME`), and use `$SKYDECK_HOME/data/node`
  only when `SKYDECK_HOME` is absolute, and `$XDG_DATA_HOME/skydeck/node` only when
  `XDG_DATA_HOME` is absolute (D26: `case $X in /*) … esac`)
- Modify: `test/bin/launcher.test.ts` — `launcherSandbox` also links `mktemp`, `cat` and `rm`, the
  programs the handoff block uses; add cases: a relative `SKYDECK_HOME` does not select
  `<SKYDECK_HOME>/data/node`, and a relative `XDG_DATA_HOME` does not select `<XDG_DATA_HOME>/skydeck/node`
  (both fall back to `$HOME/.local/share/skydeck/node`); a relative `XDG_CACHE_HOME` is ignored for the
  compile cache, and an empty `NODE_COMPILE_CACHE` counts as unset; `launcherSandbox` puts `TMPDIR` inside the
  sandbox
- Modify: `docs/design.md` 7.6 (D5: the sentence "Commands are always run as argument lists, never through a shell string" becomes "commands are run as argument lists; the one exception is the `--here` handoff, a generated `sh` fragment in which every word is quoted by the same function as the printed fallback"; D15)
- Test: `test/text/text.test.ts`, `test/terminals/terminals.test.ts`, `test/bin/launcher-handoff.test.ts`

**Exported API**

```ts
// src/text/sanitize.ts
export function sanitize(text: string): string;
// src/text/shell.ts
export function shellQuote(word: string): string;
export function shellJoin(argv: readonly string[]): string;
// src/text/age.ts
export function formatAge(durationNs: bigint): string;
// src/terminals/types.ts
export interface LaunchSpec { cwd: string; argv: readonly string[] }
export type OpenResult = { ok: true } | { ok: false; error: string; timedOut: boolean };   // timedOut: task 16
export interface Terminal { readonly name: 'here' | 'wezterm'; readonly opensTabs: boolean; open(spec: LaunchSpec): Promise<OpenResult> }
// here.ts
export const HANDOFF_ENV = 'SKYDECK_HANDOFF';
export function handoffScript(spec: LaunchSpec): string;
export function hereTerminal(deps: { files: Files; env: Env }): Terminal;
// wezterm.ts
export function weztermTerminal(deps: { runner: Runner; env: Env }, domain: string | null): Terminal;
// index.ts
export type { LaunchSpec, OpenResult, Terminal } from './types.ts';
export function terminalFor(name: 'here' | 'wezterm', platform: Platform, config: Config): Terminal;
```

**Test cases**

`text.test.ts`

`sanitize` (input → output; `\x1b` is ESC):

```
'plain title'                                   → 'plain title'
'a\x1b[31mred\x1b[0m b'                         → 'ared b'
'x\x1b]0;evil title\x07y'                       → 'xy'
'x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\y'    → 'xlinky'
'\x1bPdcs data\x1b\\after'                      → 'after'
'\u009b31mC1'                                   → 'C1'
'\x1b(Bx'                                       → 'Bx'
'unterminated \x1b]0;rest'                      → 'unterminated '
'esc at end \x1b'                               → 'esc at end '
'tab\there\nnew\rline'                          → 'tab here new line'
'bell\x07 nul\x00 del\x7f'                      → 'bell nul del'
'abc\u202Eevil\u2066x'                         → 'abcevilx'
'ünïcödé ✳ 日本'                                → unchanged
```

`shellQuote` / `shellJoin`:

```
'claude' → claude         '--model' → --model       '/home/u/p-1/x.json' → unchanged
'a=b,c:d@e%f+g' → unchanged                          '-n' → -n
'' → ''                   'my label' → 'my label'   "it's" → 'it'\''s'
'$HOME' → '$HOME'         'a*b' → 'a*b'             'ü' → 'ü'          '~' → '~'
'=ls' → '=ls'             '=' → '='                 'a=b' → a=b        '--x=y' → --x=y
shellJoin(['claude', '--resume', S1, '-n', 'my label']) → "claude --resume 0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d -n 'my label'"
```

Round trip (spawns `/bin/sh` with `env: sandbox(t).env()`, so nothing of the developer's environment is inherited): for words `['', 'a b', "it's", '$(touch x)', '`x`',
'"q"', '\\', 'new\nline', '*', '~user', '-n']`, running
`sh -c "printf '[%s]\n' " + shellJoin(words)` prints each word in brackets, unchanged.

`formatAge`: `0n` → `'0s'`; `59n*SEC + 999_999_999n` → `'59s'`; `60n*SEC` → `'1m'`; `3599n*SEC` → `'59m'`;
`3600n*SEC` → `'1h'`; `(48n*3600n - 1n)*SEC` → `'47h'`; `48n*3600n*SEC` → `'2d'`; `10n*86400n*SEC` → `'10d'`; `-5n*SEC` → `'0s'`.

`terminals.test.ts`
- `handoffScript({ cwd: '/home/dev/projects/demo', argv: ['claude','--resume',S1,'-n','my label','--model','opus'] })` →
  `"cd -- /home/dev/projects/demo || exit 1\nexec claude --resume " + S1 + " -n 'my label' --model opus\n"`.
- `handoffScript({ cwd: "/tmp/it's", argv: ['claude'] })` → `"cd -- '/tmp/it'\\''s' || exit 1\nexec claude\n"`.
- `hereTerminal` with env `{}` → `open` → `{ ok: false, error: 'not started through bin/skydeck' }`; with
  `{ SKYDECK_HANDOFF: <dir>/h }` → `{ ok: true }` and the file holds `handoffScript(spec)`; `name 'here'`, `opensTabs false`;
  a handoff file in a missing directory, or `argv: []`, makes `open` reject (nothing written for `[]`).
- `weztermTerminal` with `fakeRunner` returning code 0, domain `null` → one call
  `('wezterm', ['cli','--no-auto-start','spawn','--cwd','/w','--','claude','--resume',S1], { timeoutMs: 10000 })`, result `{ ok: true }`.
- domain `'WSL:Ubuntu'` → args `['cli','--no-auto-start','spawn','--domain-name','WSL:Ubuntu','--cwd','/w','--',…]`.
- code 1, stderr `'no running wezterm\nmore'` → `{ ok: false, error: 'no running wezterm' }`; code 1, stderr `''` → `'wezterm exited 1'`;
  `timedOut` → `'wezterm timed out; a tab may have opened'`; `notFound` without `WSL_DISTRO_NAME` → `'wezterm is not installed'`, one call;
  `notFound` with `WSL_DISTRO_NAME 'Ubuntu'` → a second call to `'wezterm.exe'` with the same args, whose result counts.
- `name 'wezterm'`, `opensTabs true`; `terminalFor('here', …).name` → `'here'`; `terminalFor('wezterm', …).name` → `'wezterm'`.

`launcher-handoff.test.ts` — `s = sandbox(t)`, `s.link('dirname', 'readlink', 'mktemp', 'cat', 'rm')`;
runs `bin/skydeck` with `s.env({ SKYDECK_NODE: <stub>, TMPDIR: <s.root>/tmp, … })`, where the stub
is a script the test writes: `#!/bin/sh` + `echo "$SKYDECK_HANDOFF" > "$STUB_SEEN"; [ -n "$STUB_SOURCE" ] && cat "$STUB_SOURCE" > "$SKYDECK_HANDOFF"; exit "${STUB_STATUS:-0}"`;
`STUB_SOURCE` is a file the test fills with `handoffScript(…)`.
1. `handoffScript({ cwd: <s.root>/dir, argv: ['/bin/sh','-c','pwd; for a; do printf "[%s]\\n" "$a"; done','sh','a b',"it's",''] })` →
   exit 0, stdout `<s.root>/dir\n[a b]\n[it's]\n[]\n`; no `skydeck-handoff.*` left in `TMPDIR`.
2. No `STUB_SOURCE`, `STUB_STATUS=7` → exit 7, empty stdout, nothing left in `TMPDIR`.
3. A handoff whose `cwd` does not exist → exit 1, nothing left in `TMPDIR`.
4. The path in `STUB_SEEN` starts with `<TMPDIR>/skydeck-handoff.`; with `TMPDIR` unset, empty, relative, naming
   a directory that does not exist, naming a file, or naming a directory that cannot be written (skipped as root), it starts with `/tmp/skydeck-handoff.` and the file is gone afterwards.
5. The program the handoff starts replaces the launcher (`echo $$` prints the launcher's pid), does not see
   `SKYDECK_HANDOFF`, and does not see `NODE_COMPILE_CACHE` unless the caller set it (the caller's value, even an empty one, is left as it was).
   A TERM, INT or HUP sent to the launcher while node runs ends it with status 130, a QUIT with 131, and leaves no handoff file.
   The program sees the caller's `CDPATH`, and variables the caller exported under the launcher's former plain names
   (`status`, `cache`, `handoff`, …) unchanged.
6. The scaffold's `test/bin/launcher.test.ts` (with the three extra links) and `test/bin/bootstrap.test.ts` still pass.

**Steps**
- [ ] Write the three test files. `npm test` → fails.
- [ ] Implement `src/text/*` (importing nothing from `src/`) and `src/terminals/*`; change `bin/skydeck` as in 2.10.3.
- [ ] `npm run check` → pass; `shellcheck bin/skydeck*` → clean. Update design 7.6 (D5, D15).
- [ ] Commit `Add the sanitiser, shell quoting, the terminals and the launcher handoff`; open the PR.

**Done when:** all cases pass; `--here` can replace skydeck with any argument list exactly, and no
handoff file outlives the launcher.

---

### Task 8: The deck — ingest, reconcile, transcript scan

**Depends on:** 2, 4, 5, 6 · **Wave:** 3 · **Design:** 5.3, 5.4, 5.6, 7.3 (automatic attach), 9.1, 12 (ingest, transcripts) · **Contracts:** 2.8.1 (`Deck`, `openDeck`), 2.8.2 · **Decisions:** D21 (update design 5.4), D25 (update design 11)

**Files**
- Create: `src/sessions/deck.ts`, `src/sessions/ingest.ts`, `src/sessions/reconcile.ts`,
  `src/sessions/scan.ts`, `src/sessions/refresh.ts`, `src/sessions/problems.ts` (private: the kv
  problem lines)
- Create: `test/helpers/deck.ts`
- Modify: `src/store/types.ts` (`KvKey`: the three problem keys), `src/store/store.ts`
  (`isDatabaseFailure`, ruled at review), `test/store/store.test.ts` (its tests)
- Modify: `docs/design.md` 5.4 (D21) and the `src/sessions/` row of 11 (D25)
- Test: `test/sessions/deck.test.ts`, `test/sessions/ingest.test.ts`, `test/sessions/reconcile.test.ts`, `test/sessions/scan.test.ts`, `test/sessions/refresh.test.ts`

**Exported API**

```ts
// deck.ts
export interface Deck { platform: Platform; places: Places; config: Config; store: Store }
export function openDeck(platform: Platform): Deck;   // throws ConfigError
export function resolveDeckPlaces(platform: Platform): { places: Places; config: Config };   // throws ConfigError; creates nothing
// ingest.ts
export interface IngestResult { ingested: number; duplicates: number; bad: number; scripted: number }
export function ingestSpool(deck: Deck): IngestResult;
// reconcile.ts
export function reconcile(deck: Deck): { observed: number };
// scan.ts
export interface ScanResult { read: number; skipped: number; missing: number; prsAttached: number }
export function scanTranscripts(deck: Deck, progress?: (done: number, total: number) => void): ScanResult;
// refresh.ts
export interface RefreshResult { ingest: IngestResult; observed: number; scan: ScanResult }
export function refresh(deck: Deck, progress?: (done: number, total: number) => void): RefreshResult;

// test/helpers/deck.ts — used by every later task
export type TestDeck = TestCtx & TestPlatform & { deck: Deck };
/** testContext(t, options); writes `config` (if given) to config.json; mkdirp
 *  <claudeHome>/projects and <claudeHome>/sessions; deck = openDeck(platform), closed in t.after. */
export function testDeck(t: TestContext, options?: TestPlatformOptions & CaptureOptions & { config?: Record<string, unknown> }): TestDeck;
```

Rules that are part of this task (design 5.3–5.6, 9.1):
- **openDeck.** `resolveConfigDir` → `loadConfig` → `resolvePlaces(env, homeDir, config.claudeHome)`
  → mkdirp (mode `0o700`) dataDir, stateDir, configDir, spoolDir, locksDir → `openStore(dbPath)`.
  A `config.json` that exists but cannot be read is a `ConfigError` naming it; a directory that
  cannot be created is a `SkydeckError` (exit 1) naming it.
- **Ingest.** Names ending in `.ev` and not starting with `.`, in name order. Not a regular file,
  unreadable, `SpoolParseError` or any other error while reading or parsing → moved to `badDir`
  (created when needed); a file that is gone when it is read is skipped. `event.scripted` → file deleted,
  `addToKv('dropped_scripted', 1)`. Otherwise, inside one `store.transaction`: compute the link,
  `insertEvent`, `insertLink`; after the commit, delete the file. A `null` from `insertEvent`
  counts as a duplicate (the file is deleted too). **Link:** for a `start` with detail `clear`,
  `resume` or `fork`, `prev = store.latestEventOfProcess(boot, pid, procStart, event.timeNs)`
  (before inserting); when `prev` exists and `prev.sessionId !== event.sessionId`, link
  `{ fromSession: prev.sessionId, toSession: event.sessionId, kind: clear→'clear', resume→'switch', fork→'fork', timeNs: event.timeNs, eventId: <new id> }`.
  Events with `pid` 0 never get links. The stored `argv` is the one `parseSpoolFile` returns,
  `storableArgv(recorded)`: no positional arguments, no removed flags, unknown flags as bare names (principle 4).
- **Retention (design 5.3).** After the files are processed: every file in `badDir` whose
  `mtimeNs < now − 7 days` is removed, and so is every entry of `spoolDir` whose name starts with
  `.` and ends with `.tmp` and whose `mtimeNs < now − 1 hour` (`now` = `platform.clock.nowNs()`).
  Nothing else is removed (directories never).
- **One item never stops a refresh: item-caused errors are recorded and skipped; database-wide
  errors stop the refresh.** A refresh that throws makes every command fail, so nothing
  that comes from one spool file, one live process, one folder or one transcript escapes as an
  exception. The whole handling of one item — reading, deriving AND saving it — is guarded, so an
  error the store throws for one item counts as that item's error — except a failure of the
  database as a whole (`isDatabaseFailure` from `src/store/store.ts`: locked, read-only, I/O,
  corrupt, full, cannot open, not a database), which is rethrown at once: caught per item, every
  item would wait out the 5 s busy timeout and fail the same way. The item is skipped (a spool
  file that cannot be read or parsed is moved to `badDir`; one whose row cannot be saved, moved or
  removed stays in the spool; a transcript keeps its row as it was) and one line naming it and the
  reason (an errno code such as `EACCES`, else the error's name and message; never content) is
  recorded. Each step replaces its own kv key at its end:
  `ingest_problems`, `reconcile_problems`, `scan_problems` (a JSON array of at most 20 strings —
  past 20, the first 19 and `… and <n> more`; a reason is cut at 200 characters; deleted when there
  is none; written only when it changes). `doctor` (task 17) shows them. What each step does
  around the items (listing the rows at its start, its kv writes at its end) is not guarded. A
  `null` boot id is recorded as `cannot read the boot id: reconcile skipped`. A bad file moved in
  this run is kept until the next run whatever its age; a scripted run is counted once its file is
  removed.
- **Reconcile.** `bootId = proc.bootId()`; when it is null, do nothing. For each `readLiveFiles`
  file that `isLiveFileTrusted`, whose `entrypoint` is `'cli'` or null, and whose
  `mtimeNs < now − 2 s`: key `(bootId, pid, procStart)`; `latest = latestEventOfProcess(key, now)`;
  `argv = argvFromCmdline(proc.cmdline(pid))`, null when unreadable or empty, then
  `absolutizePathFlags(argv, file.cwd, exists)`, then `storableArgv` of that, exactly as
  `parseSpoolFile` does it, so neither an initial prompt, nor a removed flag such as `--prefill-b64`,
  nor the argument of an unknown flag is ever stored (principle 4). Insert an `observed` event when
  `latest` is null or names another session, or when `!processHasLaunch(key)` and `argv` is
  non-null. Observed rows: `spoolName null, timeNs now, detail '', rawDetail null, cwd file.cwd, name file.name, payload null`.
  The check and the insert run again inside one transaction, with the clock read again there
  (it is the bound of `latestEventOfProcess` and the row's `timeNs`), so two refreshes at once
  record a process once.
- **Scan.** The rows are read before the listing (a row another refresh saves in between is not
  taken for deleted). For each `listTranscriptFiles` file: when a row with this path exists with equal
  `fileSize` and `mtimeNs` and `missingSinceNs` null → skipped. Else `readTranscript` (previous =
  the row's facts and `sizeRead`, or null) → `saveTranscript` with `missingSinceNs null`, then
  for each `prKey(url)` that is non-null: `ensurePr`, `attachPr(sessionId, url, 'auto', now)`
  (counting distinct new attachments). Rows whose path was not listed and `missingSinceNs` null
  get `missingSinceNs = now` — except a row whose path equals an `unreadable` path reported by
  `listTranscriptFiles` or lies under `<unreadable path>/` (an unreadable `projects` covers every
  row): what is missing from a partial listing must not be taken for deleted. Other rows are marked
  as usual, and the scan still reads what it can. A listed file that `readTranscript` cannot read
  keeps its row as it was; one that is gone by then is marked missing. A file whose facts hold a
  time outside the database's 64-bit range (a timestamp, or the file's modification time, before
  1677 or after 2262) is not saved.
  The row of a file and its pull-request attachments are saved in one transaction. The rows marked
  missing are saved in one transaction with no per-row catch (a row from the database with a time
  from the clock can only fail with the database). At the end
  `setKv('first_scan_done', '1')`.

**Test cases** (`testDeck(t)`; `put(fields, seq)` writes `spoolText(fields)` as `spoolName(fields, seq)` into `spoolDir`; `P` = pid 4242 / procStart 51234567 / `BOOT_A`)

`deck.test.ts`
1. `openDeck(platform)` → dataDir, stateDir, configDir, spoolDir, locksDir exist with mode `0o700`; `dbPath` mode `0o600`;
   `deck.config` deep-equals `DEFAULT_CONFIG`; `deck.places.claudeHome` = `sandbox.claudeHome`.
2. `config.json` `{"claudeHome":"<root>/other"}` → `deck.places.claudeHome` = `<root>/other`.
3. `config.json` `{"colour":1}` → `ConfigError` naming the path and `colour`.
4. `resolveDeckPlaces(platform)` returns the same places as `openDeck` and creates no directory and no file.

`ingest.test.ts`
1. Empty spool → `{ ingested: 0, duplicates: 0, bad: 0, scripted: 0 }`.
2. One `SessionStart` startup for S1 → one event row with the parsed values, spool empty, `ingested 1`.
3. Files `…-2.ev` at `T0+1s` and `…-1.ev` at `T0` → ids follow name order (`T0` file is id 1).
4. Same name ingested twice (write, ingest, write again, ingest) → second run `duplicates 1`, one row, file gone.
5. A valid name with content `garbage` → moved to `spoolDir/bad/<name>`, `bad 1`; a file named `x.ev` → moved to bad too.
6. Retention (mtimes set with `fs.utimesSync` relative to the fake clock `T0`): `bad/old.ev` at
   `T0 − 8 days` → removed; `bad/new.ev` at `T0 − 6 days` → kept; `.1794474000000000000-4242-1.ev.tmp`
   at `T0 − 2 h` → removed; `.1794474000000000000-4242-2.ev.tmp` at `T0 − 10 min` → kept (it may
   belong to a running hook); `README` at `T0 − 30 days` → untouched. None of them is counted in
   the result.
7. argv `['claude','-p','hi']` → no row, file deleted, `getKv('dropped_scripted')` `'1'`; `entrypointEnv 'sdk-ts'` → dropped, `'2'`;
   argv `['claude','-c','-p','hi']` and `['claude','-cp']` with `'cli'` → dropped, `'4'`.
8. Links (all for process `P`):
   - start startup S1 `T0`; end clear S1 `T0+60s`; start clear S2 `T0+60.2s` → `links()` = `[{ eventId: 3, fromSession: S1, toSession: S2, kind: 'clear', timeNs: T0+60.2s }]`.
   - start startup S1; end resume S1; start resume S2 → one link, kind `'switch'`.
   - start startup S1; start fork S3 → one link `S1 → S3`, kind `'fork'`.
   - a new process (pid 5555) whose first event is start resume S1 → no link.
   - start startup S1; start clear S1 (same session) → no link; start compact S1 → no link.
   - the three files of the first bullet ingested one per run → the same single link.
9. argv `['claude','--mcp-config','mcp.json']`, input `cwd` = a temp dir containing `mcp.json` → stored argv has its absolute path.
10. argv `['claude','--model','opus','fix the bug']` → the stored argv is `['claude','--model','opus']`;
    argv `['claude','--prefill-b64=Zml4','--model','opus']` → `['claude','--model','opus']`.
11. One file's `readText` throws a `TypeError` (a wrapped `Files`) → that file is in `bad/`, the
    next file is ingested, `ingest_problems` names the file and the error; a directory named
    `*.ev` → `bad/`; a spool that cannot be listed, a file that cannot be moved or removed → no
    exception, a problem line each; a clean run deletes `ingest_problems`. `insertEvent` (or
    `insertLink`) throws for one file → that file stays in the spool with no row, the next one is
    ingested; a scripted file that cannot be removed is not counted until it is; a bad file older
    than 7 days moved in this run is still in `bad/` after it.

`reconcile.test.ts` (fake proc current boot `BOOT_A`, process 4242 `statLine(4242, 51234567)` with cmdline `['claude','--model','opus']`; live file `C/sessions/4242.json` from `busy.json` with mtime set by `fs.utimesSync` to `T0 − 10 s`; clock `T0`)
1. No events → one observed row `{ spoolName: null, timeNs: T0, kind: 'observed', detail: '', rawDetail: null, sessionId: S1, bootId: BOOT_A, pid: 4242, procStart: 51234567, cwd: '/home/dev/projects/demo', argv: ['claude','--model','opus'], name: 'demo name', payload: null }`; returns `{ observed: 1 }`.
2. Reconcile again → `{ observed: 0 }`.
3. A hook start event for S1 with argv exists for `P` → `0`.
4. That hook event names S1 but the live file says S2 → one observed event for S2.
5. File mtime `T0 − 1 s` → `0`.
6. Live file `procStart` 999 (pid reused) → `0`; pid absent from proc → `0`; `entrypoint 'sdk-ts'` → `0`; no `entrypoint` key → `1`.
7. cmdline `[]` → observed with `argv null`; reconcile again → `0`; cmdline becomes `['claude']` → `1` more (argv `['claude']`).
8. cmdline `['claude','--settings','s.json']` with `s.json` existing under the live file's `cwd` (a temp dir) → stored absolute.
9. `proc.bootId()` null → `0`.
10. cmdline `['claude','--model','opus','fix the bug']` → the observed row's argv is `['claude','--model','opus']`;
    cmdline `['claude','--prefill-b64=Zml4','--model','opus']` → `['claude','--model','opus']`.
11. `proc.cmdline` throws for 4242 while 4343 (S2) is fine → `{ observed: 1 }` for 4343,
    `reconcile_problems` `['process 4242: TypeError: …']`; the next clean run deletes it. The same
    when `insertEvent` throws for 4242; one that throws "database is locked" (`errcode` 5) ends
    `reconcile`, `ingestSpool` (the file stays) and `scanTranscripts` at the first item. Another refresh commits the observed event (1 ms later by
    the clock) just before the transaction → no second row. A `null` boot id is recorded. A file
    modified exactly 2 s ago is not taken.

`scan.test.ts` (transcripts under `C/projects/demo/`)
1. Two transcripts → `read 2`; rows hold their facts; `getKv('first_scan_done')` `'1'`; `progress` called with `(1,2)` and `(2,2)`.
2. Scan again unchanged → `skipped 2`, `read 0`, no progress calls.
3. Append one complete line to S1's file → `read 1`; `sizeRead` advanced; facts updated.
4. Append a line without its newline → `sizeRead` unchanged until the newline arrives.
5. Rewrite S1's file shorter → re-read from the start; facts come only from the new content.
6. Delete S2's file → its row `missingSinceNs` = clock now, `missing 1`; scan again at a later clock → `missingSinceNs` unchanged;
   file restored → `missingSinceNs null`.
6a. A project folder that cannot be read (a failing `list` through a wrapped `Files`) holding S2's transcript → S2's row is NOT marked
   missing; the other transcripts are still read, and a transcript deleted from another folder IS marked missing. With `projects`
   itself unreadable nothing is marked missing.
7. `pr-link` urls `https://github.com/O/R/pull/7/files`, `https://github.com/o/r/pull/8`, `https://github.com/o/r/pull/7`, `https://example.com/x` →
   `prs()` urls `['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/8']`; both attached to S1 with origin `auto`; `prsAttached 2`.
8. `detachPr(S1, …/pull/7)`, then rewrite the file shorter with the same `pr-link` (full re-read) → still detached.
9. A transcript whose first entrypoint is `sdk-ts` → saved with `entrypoint 'sdk-ts'`.
10. A changed file deleted between listing and reading → marked missing; one whose `readBytes`
    fails with `EACCES` → row unchanged, not missing, `scan_problems` names it; a timestamp
    `9999-12-31T23:59:59Z` → not saved, a problem line, the other transcripts read; an unreadable
    folder `demo` does not protect `demo-b`. An `lstat` mtime of 2^64 ns → not saved, a problem
    line; `saveTranscript` or `attachPr` throws for one file → neither its row nor its attachments
    are saved, the others are; a
    row another refresh saves while this scan lists is not marked missing.

`refresh.test.ts`
1. A start spool file for S1 (process `P`), a live file for another process 4343 (S2, trusted, old mtime), a transcript for S3 →
   `refresh` returns `ingest.ingested 1`, `observed 1`, `scan.read 1`.
2. A start spool file and a live file for the same process and session → `observed 0` (ingest ran before reconcile).
3. A bad spool file, a process whose `cmdline` throws and a transcript whose `readBytes` throws →
   `refresh` returns normally; the three problem keys are set. The same with the store failing to
   save one spool event, one observed event and one transcript: the others are saved.
   A store that throws "database is locked" for the first item → `refresh` throws once, after one
   attempt, and no problem key is written.

**Steps**
- [ ] Write `test/helpers/deck.ts` and the four test files. `npm test` → fails.
- [ ] Implement the five source files.
- [ ] `npm run check` → pass. Commit `Ingest the spool, reconcile with live processes, scan transcripts`; open the PR.

**Done when:** all cases pass; reading a spool file twice changes nothing; the file is deleted
only after its row is committed.

---

### Task 9: Pull requests — `src/github.ts`

**Depends on:** 1, 2, 4 · **Wave:** 3 · **Design:** 7.3, 12 (pull requests) · **Contracts:** 2.6 · **Decisions:** D11 (update design 7.3)

**Files**
- Modify: `src/github.ts` (task 2 created it with `PrKey` and `prKey`; keep those unchanged)
- Modify: `docs/design.md` 7.3 (D11)
- Test: `test/github.test.ts`

**Exported API** (this task adds everything below `prKey`)

```ts
export interface PrKey { url: string; owner: string; repo: string; number: number }   // task 2
export function prKey(text: string): PrKey | null;                                     // task 2
export const BATCH_SIZE = 50;
export const GH_TIMEOUT_MS = 10_000;
export function prsDue(prs: readonly PrRow[], nowNs: Ns, refreshMinutes: number, force: boolean): PrRow[];
export function batchArgs(keys: readonly PrKey[]): string[];
export function parseBatch(keys: readonly PrKey[], result: RunResult, atNs: Ns): Map<string, PrFetchResult>;
export function fetchPrs(deps: { runner: Runner; clock: Clock; store: Store; env: Env }, urls: readonly string[]): Promise<{ fetched: number; failed: number }>;
export function refreshPrs(deps: { runner: Runner; clock: Clock; store: Store; env: Env }, options: { force: boolean; refreshMinutes: number }): Promise<{ fetched: number; failed: number }>;
export const CHIP_ORDER: readonly ['cant-read', 'unfetched', 'checks-failing', 'changes-requested', 'checks-pending', 'review-required', 'draft', 'approved-green', 'merged', 'closed'];
export type ChipLevel = (typeof CHIP_ORDER)[number];
export function prLevel(pr: PrRow): ChipLevel;
export function chipFor(prs: readonly PrRow[]): { level: ChipLevel; count: number } | null;
```

**Test cases** (`pr(over)` builds a `PrRow` for `https://github.com/o/r/pull/1`, everything else null)

`prsDue` (now `T0`, 5 minutes; the last attempt `triedAtNs` counts, not `okAtNs`): `merged` and `closed` rows → never,
`force` or not; `open` tried `T0−10m` → due; `open` tried `T0−1m` → not due; `triedAtNs null` (`open`, `draft`, `state null`) → due;
`state null, error 'x'`, `okAtNs null`, tried `T0−1m` → not due, tried `T0−6m` → due (a row that keeps failing is asked about at the pace of the
refresh age); `okAtNs T0−20m`, tried `T0−1m`, error → not due (the last attempt counts); `okAtNs T0−2m`, error, tried `T0−1m` → not due, tried
`T0−6m` → due; `force` → every non-final row, whatever its age and its last result.

`batchArgs([o/r#1, a/b#22])` → starts with `['api','graphql','--hostname','github.com','-f']`, then `'query=' + q`, then exactly
`['-f','o0=o','-f','r0=r','-F','n0=1','-f','o1=a','-f','r1=b','-F','n1=22']`; `q` contains
`$o0: String!, $r0: String!, $n0: Int!, $o1: String!, $r1: String!, $n1: Int!`,
`p0: repository(owner: $o0, name: $r0)`, `pullRequest(number: $n1)`, `statusCheckRollup`, and neither `o/r` nor `a/b`.

`parseBatch` (keys `[o/r#1, o/r#2]`, `atNs T0`; `prJson(state, isDraft, review, rollup)` builds the `pullRequest` object with `title 'T'`)
- `p0` `prJson('OPEN', false, 'APPROVED', 'SUCCESS')` → `{ ok: true, atNs: T0, title: 'T', state: 'open', review: 'approved', checks: 'passing' }`.
- `('OPEN', true, 'REVIEW_REQUIRED', 'PENDING')` → `draft`, `review-required`, `pending`; `('MERGED', …)` → `merged`;
  `('CLOSED', …)` → `closed`; rollup `null` → `checks null`; `commits.nodes []` → `null`; `FAILURE` and `ERROR` → `failing`;
  `EXPECTED` → `pending`; review `null` → `null`; `CHANGES_REQUESTED` → `changes-requested`.
- `p0` ok, `p1: null`, `errors: [{ path: ['p1','pullRequest'], message: 'Could not resolve to a PullRequest with the number of 2.' }]`, code 1 →
  `p0` ok, `p1` `{ ok: false, atNs: T0, error: 'Could not resolve to a PullRequest with the number of 2.' }`.
- `p1` missing, no `errors` → `p1` error `'not found'`.
- `errors: [{ message: 'Something went wrong …' }]` (no path), `p1: null` → `p1` error with that message, `p0` ok; an error with a path of its own wins over one without.
- A `pullRequest` without a string `title`, or with state `'SUSPENDED'` → `ok: false` (never `closed`).
- `timedOut` → both `'gh timed out after 10 s'`; `notFound` → both `'gh is not installed'`; code `null` (killed) → `'gh was killed by a signal'`; code `0` with stdout that is no answer (colour escape sequences, `''`, `null`) and any stderr → both `'gh returned output skydeck could not read'` (stderr not used); code `1` with the same stdout → the first stderr line;
  stdout `''`, stderr `'HTTP 401: Bad credentials\nmore'`, code 1 → both `'HTTP 401: Bad credentials'`; stdout `''`, stderr `''`, code 4 → `'gh exited 4'`.

`refreshPrs` (store in a temp dir, `fakeRunner`, `fakeClock(T0)`, `refreshMinutes 5`)
- 120 due rows → 3 `gh` calls with 50, 50 and 20 aliases, each with `{ timeoutMs: 10000, env }` (`env`: see the environment case below); returns `{ fetched: 120, failed: 0 }`; rows have `okAtNs T0`.
- A batch answered `timedOut` → its rows keep their previous `state`, get `error 'gh timed out after 10 s'`, `triedAtNs T0`; `failed` counts them; no throw.
- `merged` rows are never sent; a non-due `open` row is not sent unless `force`. A row whose fetch keeps timing out is asked about
  again only after the refresh age (fake clock: +4 min no call, +6 min a call); `force` asks about a row that failed a minute ago and one
  read a minute ago. With `sessionIds` only the pull requests attached to those sessions are asked about (a detached attachment does not count; `[]` → no call).
- No due rows → no `gh` call.
- `fetchPrs(deps, [url1])` with a non-due open row → one `gh` call with one alias, the row updated; `fetchPrs(deps, [])` → no call.
- `fetchPrs(deps, [mergedUrl])` → no call, the row unchanged (`pr add` of a merged pull request while `gh` fails). Two overlapping refreshes of one open row, the slow one failing or answering `OPEN` after the fast one saved `MERGED` → the row stays `merged`, no error; `{ fetched: 0, failed: 0 }` for the slow one.
- `deps.env` `{ PATH, HOME, GH_TOKEN, GH_HOST, GH_FORCE_TTY, CLICOLOR_FORCE, GH_PROMPT_DISABLED: '0', NO_COLOR: undefined }` → every `gh` call has options `{ timeoutMs: 10000, env: { PATH, HOME, GH_TOKEN, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }` (so the first `refreshPrs` case above reads `{ timeoutMs: 10000, env }` with that `env`); `deps.env` `{}` → env `{ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }`; deps without `env` do not compile (`@ts-expect-error`). A runner that rejects → the rows get `'gh could not be run: <first line>'`, no throw; a repeated url is asked once; a url that is no row is not asked.

`prLevel` / `chipFor`

```
pr({ state: 'open', error: 'x' })                                  → cant-read
pr({ state: null })                                                → unfetched      (D11)
pr({ state: null, error: 'x' })                                    → cant-read
pr({ state: 'merged' }) / pr({ state: 'closed' })                  → merged / closed
open, checks failing, review changes-requested                     → checks-failing
open, checks pending, review changes-requested                     → changes-requested
open, checks pending, review review-required                       → checks-pending
open, checks passing, review review-required                       → review-required
draft, checks null, review null                                    → draft
draft, checks failing                                              → checks-failing
open, checks passing, review approved                              → approved-green
open, checks null, review null                                     → approved-green
chipFor([])                                                        → null
chipFor([approved-green row, checks-failing row, merged row])      → { level: 'checks-failing', count: 3 }
chipFor([merged row, closed row])                                  → { level: 'merged', count: 2 }
chipFor([unfetched row, checks-failing row])                       → { level: 'unfetched', count: 2 }
chipFor([cant-read row, unfetched row])                            → { level: 'cant-read', count: 2 }
```

**Steps**
- [ ] Write `test/github.test.ts`. `npm test` → fails.
- [ ] Implement `src/github.ts` (imports `platform` types, `store` types only).
- [ ] `npm run check` → pass. Commit `Pull-request keys, batched gh status and the chip`; open the PR.

**Done when:** all cases pass; no test runs the real `gh`; a pull request that cannot be read is
never shown as closed.

---

### Task 10: Derived state and marks

**Depends on:** 4, 6 · **Wave:** 3 · **Design:** 6.1, 6.2, 6.3, 7.1 (done visibility), 12 (derived state) · **Contracts:** 2.8.1 (`types.ts`), 2.8.3

**Files**
- Create: `src/sessions/types.ts`, `src/sessions/derive.ts`
- Test: `test/sessions/derive.test.ts`

**Exported API**

```ts
// types.ts
export type State = 'working' | 'waiting' | 'running' | 'not-running';
export type Mark = 'ended-unexpectedly' | 'was-working' | 'continued' | 'expired' | 'expiring' | 'duplicate';
export const MARK_ORDER: readonly Mark[];
export interface Holder { process: ProcessKey; sinceNs: Ns; live: LiveFile | null }
export interface LastHolding { process: ProcessKey; alive: boolean; endedAtNs: Ns | null; endDetail: EndDetail | 'moved-on' | null }
export interface DerivedSession {
  id: string; state: State; stateDetail: string | null; sinceNs: Ns; lastActivityNs: Ns; firstSeenNs: Ns;
  holders: Holder[]; marks: Mark[]; continuedFrom: string | null; dir: string | null; launch: string[] | null;
  transcript: TranscriptRow | null; lastHolding: LastHolding | null; lastEventId: number | null; bootId: string | null; doneAtNs: Ns | null; hidden: boolean;
}
// derive.ts
export interface DeriveInput {
  events: readonly EventRow[]; links: readonly LinkRow[]; transcripts: readonly TranscriptRow[];
  metas: readonly SessionMeta[]; liveFiles: readonly LiveFile[];
  bootId: string | null; isAlive: (p: ProcessKey) => boolean; isTrusted: (f: LiveFile) => boolean;
  nowNs: Ns; retentionDays: number;
}
export function deriveSessions(input: DeriveInput): DerivedSession[];
```

**The rules, fixed here** (design 6, made exact):

- Sessions: every `sessionId` in `events` plus every `sessionId` in `transcripts`. Per session the
  transcript is the one with `missingSinceNs` null, else the one with the largest `mtimeNs`.
- A **process** is `(bootId, pid, procStart)`; events with `pid` 0 belong to no process. A process
  **holds** the session of its latest event when that event is not an `end`.
- **holders**: processes that hold the session and `isAlive`, latest event first. `sinceNs` = time
  of that latest event; `live` = a live file with the same pid, procStart and sessionId that `isTrusted`.
- **state**: no holders → `not-running`. Otherwise from `holders[0].live`: status `busy` →
  `working`; `idle` or `waiting` → `waiting` (`stateDetail` = `waitingFor`); no live file or any
  other status → `running`.
- **sinceNs**: `working`/`waiting` → the later of `statusUpdatedAtNs ?? updatedAtNs ??
  holders[0].sinceNs` and the time of the holder's latest `start` event that names the session and
  is not a compaction (`observed` events never count; with no such event, the file's status time
  stands alone). The live file keeps its status time when the process changes session with
  `/clear`, so a session the holder began to hold later is not in its state since before it
  existed; a compaction keeps the session, and an `observed` event is only skydeck noticing the
  process. `running` → `holders[0].sinceNs`; `not-running` → `lastActivityNs`.
- **lastActivityNs** = the larger of transcript `lastRecordNs` and the latest event time naming the
  session; falls back to transcript `mtimeNs`. **firstSeenNs** = the smaller of transcript
  `firstRecordNs` and the earliest event time; falls back to `mtimeNs`.
- **lastHolding**: `E` = latest event naming the session with `pid` ≠ 0; none → null. `E` is an
  `end` → `{ process: E's, endedAtNs: E.timeNs, endDetail: E.detail }`. Otherwise `L` = that
  process's latest event: `L` names the session and is not an `end` → `{ endedAtNs: null, endDetail: null }`;
  else → `{ endedAtNs: L.timeNs, endDetail: 'moved-on' }`. `alive` = `isAlive(process)`.
- **Marks** (in `MARK_ORDER`): `ended-unexpectedly` when not running, `lastHolding` non-null, not
  alive, and `endDetail` is null or `'other'`. `was-working` when ended-unexpectedly and either some
  live file with that pid and procStart has status `busy`, or the transcript's `lastTurnRole` is
  `'user'` (closing a terminal removes the live file, design 14). `continued` when a `clear` or `fork` link
  targets the session (`continuedFrom` = `fromSession` of the latest such link). `expired` when the
  transcript has `missingSinceNs`. `expiring` when the transcript is not missing and
  `mtimeNs < nowNs − max(retentionDays − 5, 0) days`. `duplicate` when 2+ holders.
- **dir**: transcript `firstCwd`, else `cwd` of the earliest event having one, else null.
  **launch**: `argv` of the latest `start` or `observed` event having one.
- **bootId**: `input.bootId`, copied to every session (the boot id the holders were judged against).
- **lastEventId**: the highest `id` among the events with `sessionId` = the session (the events
  are in (`timeNs`, `id`) order, so it need not be the last one); null for a session known only
  from a transcript.
- **hidden**: meta `doneAtNs` set and neither transcript `lastUserNs > doneAtNs` nor a `start`
  event with detail `startup` or `resume` and `timeNs > doneAtNs`.

**Test cases** — builders in the test: `P1 = { bootId: BOOT_A, pid: 4242, procStart: 100 }`,
`P2 = { BOOT_A, 4343, 200 }`, `P4 = { BOOT_A, 4242, 300 }` (same pid as P1, reused),
`start(p, s, t, detail, argv?)`, `end(p, s, t, detail)`, `observed(p, s, t, argv?)`,
`live(p, s, status, extra?)`, `tr(s, over)` (a `TranscriptRow`, `lastTurnRole null` unless given), `alive(...ps)` builds `isAlive`,
`isTrusted` returns true unless the test says otherwise, `nowNs T0 + 600n*SEC`, `retentionDays 30`.

| # | Given | Expect for the named session |
|---|---|---|
| 1 | `start(P1,S1,T0,'startup')`, alive P1, `live(P1,S1,'busy',{statusUpdatedAtNs: T0+5s})` | S1 `working`, since `T0+5s`, holders `[P1]`, marks `[]` |
| 2 | same, status `idle` | `waiting`, `stateDetail null` |
| 3 | same, status `waiting`, `waitingFor 'permission prompt'`, `statusUpdatedAtNs null`, `updatedAtNs T0+7s` | `waiting`, `stateDetail 'permission prompt'`, since `T0+7s` |
| 4 | same, no live file | `running`, since `T0` |
| 5 | same, status `shell` / live file naming S2 / `isTrusted` false | `running` |
| 6 | P1: `start S1 T0`, `end S1 T0+60s 'clear'`, `start S2 T0+60.2s 'clear'`; link clear S1→S2; alive P1, no live | S1 `not-running`, marks `[]`, lastHolding `{ endDetail 'clear', endedAtNs T0+60s, alive true }`; S2 `running`, marks `['continued']`, `continuedFrom S1` |
| 7 | as 6 with `end … 'switch'`, `start … 'resume'`, link switch | S1 marks `[]`; S2 marks `[]`, `continuedFrom null` |
| 8 | P1: `start S1`, `start S3 T0+5s 'fork'`; link fork S1→S3 | S3 marks include `continued`, `continuedFrom S1` |
| 9 | P1: `start S1 T0`, `end S1 T0+10s 'exit'`; P1 dead | S1 `not-running`, marks `[]`, lastHolding `{ endDetail 'exit', endedAtNs T0+10s, alive false }` |
| 10 | P1: `start S1`, `end S1 T0+10s 'other'`; P1 dead | marks `['ended-unexpectedly']`, `endDetail 'other'` |
| 11 | P1: `start S1 T0` only; P1 dead (crash, or reboot: the caller's isAlive is false for another boot) | marks `['ended-unexpectedly']`, lastHolding `{ endedAtNs null, endDetail null }` |
| 12 | 11 plus a leftover `live(P1,S1,'busy')` | marks `['ended-unexpectedly','was-working']` |
| 13 | 11 plus leftover `live(P1,S1,'idle')`, or a busy file with procStart 999 (no transcript) | marks `['ended-unexpectedly']` |
| 13a | 11 plus `tr(S1, { lastTurnRole: 'user' })`, no live file | marks `['ended-unexpectedly','was-working']` |
| 13b | 11 plus `tr(S1, { lastTurnRole: 'assistant' })`, no live file | marks `['ended-unexpectedly']` |
| 13c | 10 (terminal closed: `end … 'other'`) plus `tr(S1, { lastTurnRole: 'user' })` | marks `['ended-unexpectedly','was-working']` |
| 13d | 9 (deliberate exit) plus `tr(S1, { lastTurnRole: 'user' })` | marks `[]` |
| 14 | P1: `start S1 T0`; P4: `start S2 T0+60s`; alive P4 only (pid reused) | S1 `ended-unexpectedly`; S2 `running` |
| 15 | P1 and P2 both `start S1`, P2 later; both alive | `running`, holders `[P2, P1]`, marks `['duplicate']` |
| 16 | P1: `start S1 T0`, `observed(P1,S2,T0+5s)`; P1 dead | S1 lastHolding `endDetail 'moved-on'`, marks `[]`; S2 marks `['ended-unexpectedly']` |
| 17 | `tr(S1, { missingSinceNs: T0 })` only | marks `['expired']`, holders `[]`, lastHolding null, state `not-running` |
| 18 | `tr(S1, { mtimeNs: now − 26 days })` / `now − 24 days` / retention 3 with `mtimeNs now − 1s` | `['expiring']` / `[]` / `['expiring']` |
| 19 | meta `doneAtNs T0+100s`; `tr lastUserNs T0+50s` | `hidden true` |
| 20 | 19 with `lastUserNs T0+150s` / a `start … 'startup'` or `'resume'` at `T0+150s` | `hidden false` |
| 21 | 19 plus `start 'clear'`, `start 'compact'`, an `end`, or an `observed` at `T0+150s` | `hidden true` |
| 22 | `tr(S1, { firstCwd: '/t' })` with events whose cwd is `/e` / no transcript / no cwd anywhere | dir `'/t'` / `'/e'` / `null` |
| 23 | `start S1 T0 argv A`, `observed S1 T0+5s argv B`, `end S1 T0+9s` | `launch` = B |
| 24 | `tr lastRecordNs T0+30s, firstRecordNs T0−60s`, events at `T0` and `T0+10s` | `lastActivityNs T0+30s`, `firstSeenNs T0−60s` |
| 25 | events with `pid 0` only (`start S1`) | `not-running`, lastHolding null, marks `[]` |
| 26 | two transcripts for S1: one missing (mtime later), one present | the present one is used; marks without `expired` |
| 27 | sessions from events S2 and transcript S1 | output ids `[S1, S2]` (sorted) |
| 28 | 12 plus a clear link targeting S1 and transcript mtime `now − 26 days` | marks `['ended-unexpectedly','was-working','continued','expiring']` |
| 29 | P1: `start S1 T0`, `end S1 T0+10min−0.2s 'clear'`, `start S2 T0+10min 'clear'`; alive P1; `live(P1,S2,'idle',{statusUpdatedAtNs: T0, updatedAtNs: T0+5s})` | S2 `waiting`, since `T0+10min` (not `T0`) |
| 30 | `start S1 T0`, `start S1 T0+60s 'compact'`; alive P1; `live(P1,S1,'busy',{statusUpdatedAtNs: T0+20s, updatedAtNs: T0+61s})` | `working`, since `T0+20s` (a compaction does not restart it) |
| 31 | `observed(P1,S1,T0+300s)` only; alive P1; `live(P1,S1,'idle',{statusUpdatedAtNs: T0+20s})` | `waiting`, since `T0+20s` (reconcile does not restart it) |
| 32 | P1: `start S1 T0+9s`, `end S1 T0 'exit'` (the later id has the earlier time); P2: `start S2 T0+20s` | S1 `lastEventId` = the id of the `end`; S2 = its own; a session known only from `tr(S1)` → `null` |
| 33 | `start S1 T0`, with `bootId` `BOOT_A`, `BOOT_B` or `null`; also a session known only from `tr(S2)` with `null` | every session's `bootId` is the input's, `null` included |

**Steps**
- [ ] Write `test/sessions/derive.test.ts` with the 35 cases. `npm test` → fails.
- [ ] Implement `types.ts` and `derive.ts` (pure: no I/O, no clock; everything comes in `DeriveInput`).
- [ ] `npm run check` → pass. Commit `Derive state, holders and marks from events, live files and transcripts`; open the PR.

**Done when:** all cases pass; `deriveSessions` is pure.

---

### Task 11: List model, references, label rules

**Depends on:** 3 (`settingsPath`, `cleanupPeriodDays`), 7, 8 (for `test/helpers/deck.ts`), 9, 10 · **Wave:** 4 · **Design:** 6 (wiring), 7.1 (title, group, label rules), 7.2, 7.3 (chip), 7.4 (order, filter, sanitiser), 7.5 (`<ref>`) · **Contracts:** 2.8.4 · **Decisions:** D12 (update design 7.1), D22 (update design 7.5), D27 (update design 7.2)

**Files**
- Create: `src/sessions/list.ts`, `src/sessions/load.ts`, `src/sessions/refs.ts`, `src/sessions/labels.ts`
- Modify: `docs/design.md` 7.1 (D12), 7.2 (D27), 7.5 (D22)
- Test: `test/sessions/list.test.ts`, `test/sessions/refs.test.ts`, `test/sessions/load.test.ts`, `test/sessions/labels.test.ts`
- Create: `test/helpers/derived.ts` (builders `ds`, `transcriptRow`, `meta`, `prRow`, `attached`, `rows`, `rowOf` for the tests of the list model; not the `listRow` helper of task 13)

**Exported API**

```ts
// list.ts
export type TitleSource = 'label' | 'name' | 'generated' | 'fallback';
export interface PrView {
  url: string; repo: string; number: number; title: string | null; state: PrState | null;
  review: PrReview | null; checks: PrChecks | null; okAtNs: Ns | null; error: string | null; level: ChipLevel;
}
export interface ListRow {
  id: string; shortId: string; title: string; titleSource: TitleSource; label: string | null; group: string | null;
  state: State; stateDetail: string | null; sinceNs: Ns; lastActivityNs: Ns; dir: string | null; marks: Mark[];
  hasNote: boolean; note: string | null; continuedFrom: string | null; done: boolean; prs: PrView[];
  chip: { level: ChipLevel; count: number } | null; session: DerivedSession;
}
export interface ListGroup { name: string | null; rows: ListRow[] }
export interface ListModel { generatedAtNs: Ns; groups: ListGroup[] }
export function buildRows(input: { sessions: readonly DerivedSession[]; metas: readonly SessionMeta[]; prs: readonly PrRow[]; sessionPrs: readonly SessionPrRow[]; groupPattern: string }): ListRow[];
export function isListed(row: ListRow, showAll: boolean): boolean;
export function matchesFilter(row: ListRow, filter: string): boolean;
export function buildList(rows: readonly ListRow[], options: { showAll: boolean; filter: string; nowNs: Ns }): ListModel;
export function flatRows(model: ListModel): ListRow[];
// load.ts
export function loadSessions(deck: Deck): DerivedSession[];
export function loadRows(deck: Deck): ListRow[];
// refs.ts
export function resolveRef(ref: string, rows: readonly ListRow[]): ListRow;   // throws RefError (exit 3)
// labels.ts
export function cleanLabel(text: string): string;   // throws UsageError
export function cleanGroup(text: string): string;   // throws UsageError
```

**Rules fixed here.** Title: meta label → `'label'`; transcript `customTitle` → `'name'`;
transcript `aiTitle` → `'generated'`; else `'fallback'` = `YYYY-MM-DD HH:MM <basename(dir) or ?>`
from `firstSeenNs` in UTC (D12). A `customTitle` or `aiTitle` that is empty or only whitespace once sanitised is
skipped (the next source is used); titles are shown trimmed. Group: meta group, else
`new RegExp(groupPattern).exec(title)?.[0]`, else null; `groupSource` says which. Sanitised with
`sanitize`: title (every source, the label included: `cleanLabel` and `cleanGroup` refuse such text, so this
only guards against a database changed by other means; one that is blank once sanitised is not set), `label`,
`group`, `stateDetail`, `dir` (for display only; the path to use is `session.dir`), PR `title` and `error`;
`note` is free multi-line text, left as typed. **Listed (7.2):** an expired session counts as having
something attached only through a label, a group set by the user (`groupSource` 'meta'), a note or a pull
request; a group taken from the title does not. **Order (7.4):** groups by the largest `lastActivityNs` of their rows,
descending; the null group last; ties by name ascending. Rows by rank — `waiting` 0, `working` 1,
`running` 2, `not-running` with `ended-unexpectedly` 3, other `not-running` 4 — then
`lastActivityNs` descending, then id ascending.

**Test cases** (`ds(over)` builds a `DerivedSession`; `rows(...)` runs `buildRows` with `groupPattern` default)

`list.test.ts`
- Titles: label `'L'` → `('L','label')`; no label, customTitle `'C'` and aiTitle `'A'` → `('C','name')`; aiTitle only →
  `('A','generated')`; nothing, `firstSeenNs T0`, dir `/home/dev/projects/demo` → `('2026-11-12 09:00 demo','fallback')`; dir null → `'2026-11-12 09:00 ?'`.
- Sanitised: aiTitle `'x\x1b]0;pwn\x07y'` → `'xy'`; `stateDetail 'a\nb'` → `'a b'`; PR title `'t\x1b[2Jt'` → `'tt'`; label `'L'` unchanged.
- Groups: meta group `'G'` → `'G'`; title `'ABC-123 fix'` → `'ABC-123'`; `'fix ABC-123'` → `null`; label `'ABC-9: x'` → `'ABC-9'`;
  `groupPattern '^\\[\\w+\\]'` with title `'[ops] rotate'` → `'[ops]'`.
- PRs: attached auto `…/pull/2`, manual `…/pull/1`, detached `…/pull/3` → `prs` urls `[…/pull/1, …/pull/2]`,
  `repo 'o/r'`, `level` from `prLevel`, `chip` from `chipFor`; no PRs → `chip null`.
- `shortId` = first 8 characters; `hasNote` true iff note non-null; `done` = `session.hidden`.
- `isListed`: transcript entrypoint `'sdk-ts'` → false even with showAll; no transcript and not running → false, also with
  showAll (D27); no transcript but running → true; done → false, showAll → true;
  expired with nothing attached → false (also with showAll); expired with a note / a label / a group / an attached PR → true;
  expired with only a detached PR → false.
- `buildList` order, `nowNs T0`: group `A` rows — `a1 waiting T0−5m`, `a2 not-running+ended-unexpectedly T0−1m`,
  `a3 not-running T0−30s`, `a4 working T0−10m`, `a5 running T0−20m` → `[a1, a4, a5, a2, a3]`. Groups: `A` (max `T0−30s`)
  before `B` (max `T0−2m`); null group last even with activity `T0`; `C` and `D` with equal maxima → `C, D`;
  equal rank and activity → id ascending.
- `matchesFilter`: `'RETRY'` matches title `'Fix retry'`; `'o/r#7'`, `'o/r'` and `'7'` match a row with PR `o/r#7`;
  group, note text and dir match; `''` matches everything; `'zzz'` matches nothing.
- `buildList` with a filter drops non-matching rows and empty groups; `showAll` includes done rows; `generatedAtNs` = `nowNs`.
- `flatRows` returns rows in group then row order.

`refs.test.ts` (rows: S1 label `'alpha'`; S2 label `'beta'`, done; S3 label `'alpha'` in a second scenario; ids sharing a prefix built for the ambiguity case)
- `resolveRef(S1)` → S1; `resolveRef(S1.toUpperCase())` → S1; `'0b5f'` → S1.
- `'0b5'` (3 characters) → no prefix search → RefError `no session matches '0b5'`, exit code 3, `candidates []`.
- Two ids starting `'aaaa'` → `resolveRef('aaaa')` throws RefError `'aaaa' matches 2 sessions` with both `{ id, title }` candidates.
- `'beta'` → S2 although done (D22); `'alpha'` with two rows → RefError with two candidates.
- A label on a non-cli row → not found. A prefix finds an expired unlabelled (unlisted) row.

`labels.test.ts`
- `cleanLabel('  fix retry ')` → `'fix retry'`; `cleanLabel('a\nb')`, `cleanLabel('   ')`, `cleanLabel('-x')` → `UsageError`.
- `cleanGroup(' ABC-1 ')` → `'ABC-1'`; `cleanGroup('a\rb')`, `cleanGroup('')` → `UsageError`.

`load.test.ts` (`testDeck`)
- One start spool event for S1 already ingested by `refresh`, a trusted live file `busy`, a transcript with aiTitle `'Fix retry'` →
  `loadRows` → one row: `state 'working'`, `title 'Fix retry'`, `titleSource 'generated'`.
- `C/settings.json` `{"cleanupPeriodDays":10}` and a transcript with mtime `now − 6 days` → marks include `expiring`.
- Current boot changed (`proc.setBootId(BOOT_B)`) → the S1 row is `not-running` with `ended-unexpectedly`.

**Steps**
- [ ] Write the three test files. `npm test` → fails.
- [ ] Implement `list.ts`, `load.ts`, `refs.ts`; add D22 behaviour exactly as in 2.8.4.
- [ ] `npm run check` → pass. Commit `Build the list model and resolve session references`; open the PR.

**Done when:** all cases pass; every foreign string in a `ListRow` is sanitised.

---

### Task 12: CLI core — error mapping, `withDeck`, argument parsing

**Depends on:** 1, 8 · **Wave:** 4 · **Design:** 5.3 ("every command starts with"), 5.6 (progress line), 7.5 (exit codes) · **Contracts:** 2.9.2, 2.9.3

**Files**
- Modify: `src/cli/main.ts` — `dispatch` wraps `command.run` with the error mapping of 2.9.2 (the
  only change; loading, usage and `--version` stay as they are)
- Create: `src/cli/deck.ts`, `src/cli/args.ts`
- Create fixtures: `test/fixtures/commands-throwing/` — one command file per error case
  (`usage.ts` throws `UsageError('bad')`, `ref.ts` throws a `RefError` with two candidates,
  `refused.ts`, `stopped.ts`, `failure.ts` (`SkydeckError`), `internal.ts` (`new Error('boom')`),
  `ok.ts` returns `EXIT.ok`; and, for the cases below that the first list does not cover,
  `usage-text.ts`, `internal-text.ts`, `unprintable.ts`, `escapes.ts`, `internal-escapes.ts`) and a `README.md`;
  each exports `command` named like its file
- Test: `test/cli/dispatch-errors.test.ts`, `test/cli/deck.test.ts`, `test/cli/args.test.ts`

**Exported API**

```ts
// src/cli/main.ts — unchanged signatures
export async function main(argv: string[], ctx: Context): Promise<number>;
export async function dispatch(argv: string[], ctx: Context, commandsDir: URL): Promise<number>;
// src/cli/deck.ts
export function withDeck<T>(ctx: Context, options: { refresh: boolean }, fn: (deck: Deck) => Promise<T>): Promise<T>;
export function refreshWithProgress(ctx: Context, deck: Deck): RefreshResult;
// src/cli/args.ts
export interface ArgSpec { usage: string; flags: Record<string, { type: 'boolean' | 'string'; short?: string }>; min: number; max: number; allowRest?: boolean }
export interface ParsedArgs { help: boolean; flags: Record<string, string | boolean | undefined>; positionals: string[]; rest: string[] }
export function parseCommandArgs(args: readonly string[], spec: ArgSpec): ParsedArgs;   // throws UsageError
```

**Test cases**

`dispatch-errors.test.ts` (`dispatch([name], ctx, <commands-throwing dir>)`, `testContext()`)
1. `usage` → `EXIT.usage`, stderr `'skydeck: bad\n'`, stdout empty.
2. `ref` (`RefError("'x' matches 2 sessions", [{ id: S1, title: 'alpha' }, { id: S2, title: 'beta' }])`) → `EXIT.ref`,
   stderr `"skydeck: 'x' matches 2 sessions\n  0b5f3c1e  alpha\n  1c6a4d2f  beta\n"`.
3. `refused` → `EXIT.refused`; `stopped` → `EXIT.stopped`; `failure` → `EXIT.failure`.
4. `internal` → `EXIT.failure`, stderr `'skydeck: internal error: boom\n'`.
5. `ok` → `EXIT.ok`, nothing on stderr.
6. For each error class: `new X(…).exitCode === EXIT.<name>` (`ConfigError`/`SkydeckError` → `failure`,
   `UsageError` → `usage`, `RefError` → `ref`, `ResumeRefusedError` → `refused`, `RestoreStoppedError` → `stopped`).
7. The scaffold's `test/cli/main.test.ts` passes unchanged.
8. `usage-text` (`UsageError("unknown option '--nope'\nskydeck x [--all]\n")`) → stderr
   `"skydeck: unknown option '--nope'\nskydeck x [--all]\n"` (no blank line); `internal-text`
   (throws the string `'plain text'`) → `'skydeck: internal error: plain text\n'`; `unprintable`
   (throws `Object.create(null)`) → `'skydeck: internal error: unprintable value\n'`.
9. `escapes` (a `RefError` whose message and candidate title contain escape sequences, `\r` and `\n`)
   and `internal-escapes` → the text printed has them removed (line breaks of the `SkydeckError`
   message kept, in the internal error replaced by spaces).

`deck.test.ts` (`testContext(t, …)`)
1. `withDeck(ctx, { refresh: false }, fn)` → `fn` receives an open deck; the store is closed after `fn` resolves and after it throws (the error is rethrown).
2. A spool start file for S1 exists: `refresh: true` → inside `fn`, `deck.store.events().length` is 1; `refresh: false` → 0.
3. `config.json` `'{"colour":1}'` → `withDeck` rejects with `ConfigError`.
   An error thrown by `fn` is rethrown as it is (same object); one that `isDatabaseFailure` (a
   `SQLITE_BUSY` error) becomes a `SkydeckError` `the database <dbPath> failed: database is locked`
   with exit code 1 and the original as `cause`; an error of one row (`SQLITE_CONSTRAINT`) is
   rethrown as it is. The store is closed in every case.
4. `refreshWithProgress` with `stderrTTY` and one transcript → stderr contains `'skydeck: reading transcripts 1/1'` and ends with `'\r\x1b[K'`;
   a second call writes nothing more (`first_scan_done` set); with `stderrTTY` false nothing is ever written;
   a first scan with no file to read writes nothing; a scan that throws (a database failure after the
   first of two files) still ends with `'\r\x1b[K'`.

`args.test.ts` (spec `{ usage: 'U\n', flags: { all: {type:'boolean'}, json: {type:'boolean'}, set: {type:'string'} }, min: 0, max: 1 }` unless stated)
- `['--all','--json']` → `{ help: false, flags: { all: true, json: true }, positionals: [], rest: [] }`.
- `['x','--set','text']` → `positionals ['x']`, `flags.set 'text'`.
- `['--help']`, `['x','-h']`, `['--nope','--help']` → `help: true`.
- `['--nope']` → `UsageError` (exit 2) whose message contains `--nope` and ends with `'U\n'`; `['--set']` → `UsageError`.
- `['a','b']` → `UsageError` containing `'too many arguments'`; spec `min 1` with `[]` → `'missing argument'`.
- `allowRest` spec `{ usage: 'U\n', flags: { label: {type:'string'} }, min: 0, max: 0, allowRest: true }`:
  `['--label','x','--','--model','opus']` → `flags.label 'x'`, `rest ['--model','opus']`, `positionals []`;
  `['--','--help']` → `help false`, `rest ['--help']`.
- Without `allowRest`, `['--','x']` → `positionals ['x']`, and `['--','--help']` → `help false`, `positionals ['--help']`.
- With `allowRest`, only the first `--` ends the flags (`['--','a','--','b']` → `rest ['a','--','b']`) and positionals
  before it count against `max`; a flag of the spec after `--` is part of `rest`.
- Messages: an unknown flag's reason has node:util's hint about `--` removed and starts with a lower-case letter;
  `['--set','--all']` and `['--all=1']` → `UsageError`.

**Steps**
- [ ] Write the fixtures and the three test files. `npm test` → fails.
- [ ] Add the error mapping to `dispatch`; implement `deck.ts` and `args.ts`.
- [ ] `npm run format`; `npm run check` → pass.
- [ ] Commit `Map errors to exit codes; open the deck for commands; parse command arguments`; open the PR.

**Done when:** all cases pass; a command can be written as one file using `parseCommandArgs`,
`withDeck` and thrown `SkydeckError`s, without touching `main.ts`.

---

### Task 13: Interactive list — `reduce` and `render`

**Depends on:** 7, 9, 11 · **Wave:** 5 · **Design:** 7.4 (row content, keys, filter, order under the cursor, pure functions), 12 (list) · **Contracts:** 2.9.4 (`row.ts`), 2.9.5 (model, render)

**Files**
- Create: `src/cli/clip.ts` (2.9.4; added by ruling), `src/cli/row.ts`, `src/cli/tui/model.ts`, `src/cli/tui/render.ts`
- Create: `test/helpers/rows.ts` (`listRow(over: Partial<ListRow> & { id: string }): ListRow` with a minimal `DerivedSession` and sensible defaults: state `not-running`, title `'t'`, `sinceNs = lastActivityNs = T0`)
- Test: `test/cli/clip.test.ts`, `test/cli/row.test.ts`, `test/cli/tui/model.test.ts`, `test/cli/tui/render.test.ts`

**Exported API**

```ts
// row.ts
export function formatRow(row: ListRow, nowNs: Ns, width: number): string;
export function formatChip(chip: { level: ChipLevel; count: number }): string;
export function formatPrLine(pr: PrView): string;
// tui/model.ts (field comments in 2.9.5)
export type TuiMode = 'list' | 'detail' | 'filter' | 'input';
export interface TuiInput { purpose: 'label' | 'group' | 'pr'; text: string }
export interface TuiModel {
  rows: ReadonlyMap<string, ListRow>; order: { name: string | null; ids: string[] }[];
  showAll: boolean; filter: string; mode: TuiMode; input: TuiInput | null;
  selected: string | null; scroll: number; message: string | null; nowNs: Ns;
}
export type TuiEffect =
  | { kind: 'none' } | { kind: 'quit' } | { kind: 'refresh' }
  | { kind: 'label'; id: string; text: string } | { kind: 'group'; id: string; text: string }
  | { kind: 'note'; id: string } | { kind: 'done'; id: string; done: boolean }
  | { kind: 'pr-add'; id: string; url: string } | { kind: 'pr-rm'; id: string; url: string }
  | { kind: 'resume'; id: string };
export function initModel(rows: readonly ListRow[], nowNs: Ns): TuiModel;
export function withRows(model: TuiModel, rows: readonly ListRow[], nowNs: Ns, reorder: boolean): TuiModel;
export function withMessage(model: TuiModel, message: string | null): TuiModel;
export function visibleRows(model: TuiModel): ListRow[];
export function reduce(model: TuiModel, key: string): { model: TuiModel; effect: TuiEffect };
// tui/render.ts
export function render(model: TuiModel, size: { columns: number; rows: number }): string[];
```

**Row format (contract).** `formatRow` =
`state.padEnd(11) + ' ' + title + '  ' + formatAge(nowNs − sinceNs).padStart(4)` followed by
`'  ' + part` for each non-empty part of: `marks.join(',')`, `formatChip(chip)`, `'note'` when
`hasNote`, `shortId`. When the result is longer than `width`, columns are dropped, in this
order, until the title has 24 characters (or all of it, when it is shorter): the `note` part, the
time in state, all marks but the first (shown as `<first>+<n>`), the count of the chip (shown as
`pr:<level>`). The state, the title and the short id are never dropped. A title that still does
not fit is cut to fit and ends with `…` (at least one title character is kept; a title the
ellipsis would not make shorter is kept whole). `formatChip` = `` `${count}pr:${level}` ``.

**Screen layout (contract).** `render` returns exactly `size.rows` lines, each at most
`size.columns` long, no escape sequences. Line 0: `skydeck  <visible count> sessions`, plus
`  filter: <filter>` when the filter is not empty, plus `  (all)` when `showAll`. Last line:
input mode → `<purpose>: <text>_`; filter mode → `/<filter>_` (when either does not fit, the start of the text gives way to
a `…` so that its end and the `_` stay in view); else `message` when set; else
`j/k move  enter detail  l label  g group  n note  d done  p PR  R resume  / filter  a all  r refresh  q quit`.
Body (the lines between): list mode — for each group with visible rows a line with the group name
(`no group` for null), then each row as `'> '` (selected) or `'  '` + `formatRow(row, nowNs, columns − 2)`;
`no sessions` when nothing is visible; from the line `model.scroll`, moved as `scrolled` does when the selected row would be
out of view. Detail mode — the
selected row as lines `title: …`, `id: …`, `state: <state>[ (<stateDetail>)]`, `since: <iso>`,
`dir: <dir or ->`, `group: <group or ->`, `marks: <comma list or ->`, one line `pr: ` +
`formatPrLine(pr)` per PR, `note:` followed by the note lines indented by two spaces; when the lines do not all fit, the
last line shown is `…`.

**Key behaviour (contract).** List mode: `j`/`down`, `k`/`up` move (no wrap); `enter` → detail;
`l` → input `label` prefilled with the row's label; `g` → input `group` prefilled with the row's group when the user set it
(`groupSource` `meta`), else empty (so `enter` straight away changes nothing, and clearing takes a deliberate delete); `n` → effect `note`;
`d` → effect `done` with `done: !row.done`; `p` → input `pr` empty; `R` → effect `resume`; `/` →
filter mode; `a` → toggle `showAll` and recompute `order`; `r` → effect `refresh`; `q` → `quit`.
Detail mode: `escape`, `enter` and `q` → list mode; `l g n d p R` act as in list mode. Filter
mode: printable characters append, `backspace` deletes, `enter` → list mode keeping the filter,
`escape` → list mode with the filter cleared. Input mode: printable append, `backspace` deletes,
`escape` cancels, `enter` → effect (`label`/`group` with the text; `pr` text, trimmed, starting
with `-` → `pr-rm` with the rest, else `pr-add`; an empty text or a lone `-` → `none`), back to
list mode. `ctrl-c` → `quit` in every mode. Any key clears `message`. With no visible rows, every
action key gives effect `none`. When the selected row stops being visible (a key, or `withRows`),
the selection moves to the first visible row (or null) and an open detail or input is closed, so
that nothing is applied to a row the user did not choose; a filter being typed stays open.
`withRows` without reorder also drops rows that are no longer listed at all, moves a row whose
group changed to the end of its new group, puts a group that did not exist before "no group", and
drops groups left empty. Groups are ranked by the members listed under the current `showAll`
(design 7.4); `a` and `withRows` with reorder compute `order` that way.

**Test cases** (`R1` group `A`, waiting, id S1, label `'alpha'`, `lastActivityNs T0`; `R2` group `A`, not-running, id S2, title `'beta'`, `T0−1m`; `R3` no group, id S3, `done: true`; `nowNs T0`)

`row.test.ts`
- `{ state: 'waiting', title: 'Fix retry loop', sinceNs: T0−12m, marks: [], chip: { level: 'checks-failing', count: 2 }, hasNote: true, id: S1 }`, width 200 →
  `'waiting     Fix retry loop   12m  2pr:checks-failing  note  0b5f3c1e'`.
- `{ state: 'not-running', title: 'Fix', sinceNs: T0−3h, marks: ['ended-unexpectedly','was-working'], chip: null, hasNote: false }` →
  `'not-running Fix    3h  ended-unexpectedly,was-working  0b5f3c1e'`.
- `{ state: 'working', title: 'A very long title that will not fit at all', sinceNs: T0−5m }`, width 40 →
  `'working     A very long title…  0b5f3c1e'` (length 40: even without the time in state the title has 18 characters).
- `{ state: 'waiting', title: 'abcdefghijklmnopqrstuvwxyz0123456789', sinceNs: T0−12m, marks: ['ended-unexpectedly','was-working'], chip: { level: 'checks-failing', count: 2 }, hasNote: true, id: S1 }`:
  width 122 → everything; 110 → title cut to 24, everything else shown; 109 → no `note`; 103 → also no time in state;
  97 → marks `ended-unexpectedly+1`; 87 → chip `pr:checks-failing`; 60 → `'waiting     a…  ended-unexpectedly+1  pr:checks-failing  0b5f3c1e'`.
- `formatChip({ level: 'merged', count: 1 })` → `'1pr:merged'`.
- `formatPrStatus`: the level, `'not fetched'`, `"can't read, last read <iso or never>[ (<error>)]"`; `formatPrLine` = url, two spaces, `formatPrStatus`.
- `formatPrLine`: level `draft` → `'https://github.com/o/r/pull/1  draft'`; level `cant-read`, `okAtNs T0`, error `'HTTP 401'` →
  `"https://github.com/o/r/pull/1  can't read, last read 2026-11-12T09:00:00.000Z (HTTP 401)"`; `cant-read`, `okAtNs null`, error `'x'` →
  `"https://github.com/o/r/pull/1  can't read, last read never (x)"`; level `unfetched` → `'https://github.com/o/r/pull/1  not fetched'`.

`tui/model.test.ts`
1. `initModel([R1,R2,R3], T0)` → `order` from `buildList(rows, { showAll: true, filter: '', nowNs })`, i.e. `[{ name: 'A', ids: [S1,S2] }, { name: null, ids: [S3] }]`; `visibleRows` `[R1,R2]`; `selected S1`; `mode 'list'`.
2. `j` → S2; `j` again → S2; `k` → S1; `down`/`up` the same.
3. `enter` → `detail`; `escape` → `list`; in detail `q` → `list`, effect `none`; `q` in list → effect `quit`; `ctrl-c` in filter mode → `quit`.
4. `a` → `showAll true`, visible `[R1,R2,R3]`; select R3, `a` → `showAll false`, selected S1.
5. `/`, `b`, `e`, `t`, `backspace`, `enter` → filter `'be'`, mode `list`; `/`, `escape` → filter `''`.
6. `l` → input `{ purpose: 'label', text: 'alpha' }`; `backspace`×5, `x`, `enter` → effect `{ kind: 'label', id: S1, text: 'x' }`; `l`, `escape` → effect `none`, mode `list`.
7. `g` → input `{ purpose: 'group', text: 'A' }`; `backspace`, `G`, `enter` → `{ kind: 'group', id: S1, text: 'G' }`; `g`, `enter` → text `'A'`; `g`, `backspace`, `enter` → text `''`; a row whose group came from its title (`groupSource` `title`) or has none → `g` gives text `''`.
8. `n` → `{ kind: 'note', id: S1 }`; `d` → `{ kind: 'done', id: S1, done: true }`; with `showAll`, R3 selected, `d` → `done: false`.
9. `p`, then the characters of `https://github.com/o/r/pull/1`, `enter` → `pr-add` with that url; with a leading `-` → `pr-rm` without it.
10. `R` → `{ kind: 'resume', id: S1 }`; `r` → `{ kind: 'refresh' }`; `x` → `none`.
11. `initModel([], T0)`: `j`, `enter`, `d`, `R` → effect `none`, no throw, `selected null`.
12. `withMessage(m, 'saved')` then `j` → `message null`.
13. From `m = initModel([R1,R2,R3], T0)`: `withRows(m, [R1, R2 now waiting with lastActivity T0+1m, R3, R4 (group A, id S4)], T0, false)`
    → order A `[S1,S2,S4]`. Separately, `m` with S2 selected, `withRows(m, [R1, R3], T0, false)` → order A `[S1]`, selected S1.
14. Same rows with `reorder true` → order A `[S2,S1,S4]` (as `buildList`).
15. Group order: A has a listed row last active 60m ago; B has a listed row 180m ago and a done row 5m ago → `order` names `['A','B']` (B's ids: the done row first); `a` → `['B','A']`; `a` again → `['A','B']`. A group with only done rows comes after A and before "no group".
16. `withRows` without reorder: a new group `Z` → names `['A','Z',null]`; several new groups keep `buildList` order, all before "no group"; a row whose group changed goes to the end of its new group; a row that is merely hidden (done, `showAll` off) under an open detail or input closes it (mode `list`, selection on the first visible row).

`tui/render.test.ts` (size 80×10 unless stated)
1. 10 lines, none longer than 80, none containing `'\x1b'`.
2. Line 0 `'skydeck  2 sessions'`; with filter `be` and `showAll` → `'skydeck  1 sessions  filter: be  (all)'` (count = visible rows).
3. Line 1 `'A'`, line 2 `'> ' + formatRow(R1, T0, 78)`, line 3 `'  ' + formatRow(R2, T0, 78)`, lines 4–8 `''`.
4. Line 9 = the key help truncated to 80 columns.
5. Input mode → last line `'label: x_'`; filter mode → `'/be_'`; message `'saved'` → `'saved'`.
6. 30 rows in one group, 10 lines (8 body lines), selection on the 20th → that row's line is present with `'> '`.
7. No rows → line 1 `'no sessions'`.
8. Detail of R1 with one PR (`…/pull/1`, level `draft`) and note `'a\nb'` → body contains `'id: ' + S1`, `'state: waiting'`,
   `'pr: https://github.com/o/r/pull/1  draft'`, `'note:'`, `'  a'`, `'  b'`; a `cant-read` PR line is `'pr: ' + formatPrLine(pr)`.
9. `scrolled`: 30 rows in one group, 8 body lines, `j` ×12, the wrapper calling `scrolled` after every key → `scroll` 0 for rows 0–6, then 1…6; going back up from row 20 the window stays until the cursor reaches its top, then moves one line per row; with three groups of ten, the header of a group is on screen whenever its first row is selected, and no step moves the window by more than 2 lines. A detail body longer than the screen ends with a line `'…'`; a long input or filter line shows its end and the `_`.

**Steps**
- [ ] Write the helper and the three test files. `npm test` → fails.
- [ ] Implement `row.ts`, `tui/model.ts`, `tui/render.ts` (pure; no I/O).
- [ ] `npm run check` → pass. Commit `Interactive list as pure reduce and render`; open the PR.

**Done when:** all cases pass; nothing in `src/cli/tui/model.ts` or `render.ts` touches I/O.

---

### Task 14: `ls` and `show` — text, JSON, a recorded day end to end

**Depends on:** 9 (`refreshPrs`, `fetchPrs`), 12, 13 (`formatRow`, `formatPrLine`) · **Wave:** 6 · **Design:** 7.2, 7.3 ("can't read", cached status), 7.4 (row content), 7.5 (`ls`, `show`, `--json`, exit codes), 12 (commands, end to end) · **Contracts:** 2.9.4 (`output.ts`), 2.10.5 · **Decisions:** D11 (`--refresh`; update design 7.3 and the `ls`/`show` rows of 7.5)

**Files**
- Create: `src/cli/output.ts`
- Create: `src/cli/json.ts` (`jsonText(value): string`: `JSON.stringify(value, null, 2)` and a newline, with DEL, the C1 controls and the bidirectional controls written as `\uXXXX` escapes — the one place JSON is turned into text for the terminal; `JSON.parse` of its result is the exact value). Test: `test/cli/json.test.ts`
- Create: `src/cli/commands/ls.ts`, `src/cli/commands/show.ts` (each `export const command: Command`)
- Modify: `src/cli/commands/pr.ts` (its private `statusOf` is gone: it prints `formatPrStatus`, the status part of `formatPrLine`, now exported from `src/cli/row.ts`; its tests are unchanged)
- Modify: `src/cli/row.ts` (`formatPrStatus`), `src/sessions/list.ts` (`SHORT_ID_LENGTH` exported, used by `output.ts`), `src/github.ts` (`prsDue`: the automatic rule keys on the last attempt, 2.6) with `test/github.test.ts` and `test/cli/row.test.ts`
- Create fixtures: `test/fixtures/day/` — `spool/*.ev`, `claude/projects/<folder>/<uuid>.jsonl`,
  `claude/sessions/*.json`, `proc.json` (the fake `/proc`: boot id, processes), `expected-ls.json`
- Modify: `docs/design.md` 7.3 (`ls`/`show` print the cached status unless `--refresh`) and the `ls`/`show` rows of 7.5 (D11)
- Test: `test/cli/output.test.ts`, `test/cli/commands/ls.test.ts`, `test/cli/commands/show.test.ts`, `test/e2e/day.test.ts`

**Exported API**

```ts
// output.ts — JSON types exactly as 2.10.5
export interface PrJson {
  url: string; repo: string; number: number; state: PrState | null; review: PrReview | null;
  checks: PrChecks | null; okAt: string | null; error: string | null;
}
export interface SessionJson {
  id: string; shortId: string; title: string; titleSource: TitleSource; label: string | null; group: string | null;
  state: State; stateDetail: string | null; since: string; lastActivity: string; dir: string; marks: Mark[];
  hasNote: boolean; continuedFrom: string | null; done: boolean; prs: PrJson[];
}
export interface ListJson { version: 1; generatedAt: string; sessions: SessionJson[] }
export interface LinkJson { kind: LinkKind; from: string; to: string; at: string }
export interface HolderJson { pid: number; bootId: string; procStart: number | null; since: string }
export interface ShowJson extends SessionJson { doneAt: string | null; note: string | null; launch: string[] | null; unknownFlags: string[]; links: LinkJson[]; holders: HolderJson[] }
export function sessionJson(row: ListRow): SessionJson;
export function listJson(model: ListModel): ListJson;
export function showJson(row: ListRow, links: readonly LinkRow[]): ShowJson;
export function formatList(model: ListModel, nowNs: Ns, width: number): string;
export function formatShow(row: ListRow, links: readonly LinkRow[], nowNs: Ns): string;
// src/cli/commands/ls.ts — name 'ls', usage 'skydeck ls [--all] [--json] [--refresh]\n'; flags all, json, refresh; no positionals
export const command: Command;
// src/cli/commands/show.ts — name 'show', usage 'skydeck show <ref> [--json] [--refresh]\n'; flags json, refresh; one positional
export const command: Command;
```

**`--refresh` (D11).** Without it `ls` and `show` never touch the network. With it they make an explicit refresh before printing
(every attached pull request that is not merged or closed, whatever its age and its last result):
`ls` runs `refreshPrs({ runner, clock, store, env: ctx.platform.env }, { force: true, refreshMinutes: config.prRefreshMinutes, sessionIds: <the ids of the rows it prints> })` (`env` is required in the deps of every `fetchPrs`/`refreshPrs` call, 2.6) and builds the list again; a done session's pull requests are fetched only with `--all`;
`show` runs the same `refreshPrs` (same deps, with `env`) with `sessionIds: [<its id>]` and reads the row again.

**Formats (contract).** `formatList`: per group a line with its name (`no group` for null), then
each row as `'  ' + formatRow(row, nowNs, width − 2)`; one empty line between groups; `'no sessions\n'`
when there are none; ends with `\n`. `ls` uses `io.size().columns`. `formatShow`: the title, then
one line per field with the label padded to 11 characters: `id:`, `state:` (`<state>[ (<stateDetail>)] since <iso>`),
`done:` (only for a session that is done: `since <iso>` of the time it was marked, `yes` when that is not known; the JSON has `doneAt` for it),
`marks:`, `label:`, `group:`, `dir:` (`-` for null/empty), `launch:` (`shellJoin(launch)` or `unknown`),
`unknown:` (only when `unknownFlags(launch)` is not empty: the names, sanitised, joined by one space — the flags
skydeck does not know, which a resume does not pass on), `continues:` (only when `continuedFrom`: the full id), `link:` per link (`<kind> <fromShort> -> <toShort> at <iso>`),
`holder:` per holder (`pid <pid> since <iso>`), `pr:` per PR (`formatPrLine(pr)`, then
` review <r>` and ` checks <c>` when set and the level is not `cant-read`), then `note:` and the note
lines indented by two spaces when there is a note. Details the lines above leave open: `marks:` joins
the marks with a comma, and `marks:`, `label:` and `group:` show `-` when there is nothing; the words
of `launch:` are sanitised before they are quoted, and an empty launch command (`[]`) reads `unknown`
like none; the note loses its trailing whitespace (so a note saved with a final line break has no empty
line after it), each of its lines is sanitised (line breaks kept) and an empty line inside the note stays empty (lines that are nothing once sanitised are dropped at its start and end, and a note of nothing else gets no `note:` line); the
text always ends with `\n`.
`nowNs` is part of the signature and is not used (`since` is an ISO time, not an age). `show --json`
and `ls --json` are written by `jsonText`; the JSON holds the note and the launch command as stored.

**Test cases**

`output.test.ts` (rows from `test/helpers/rows.ts`)
- `sessionJson` of a row with every field set → the exact object of 2.10.5 with keys in that order
  (`Object.keys` compared), times as `isoFromNs`, `dir ''` when null, PR `repo 'o/r'`, `okAt` ISO or null.
- `listJson` → `{ version: 1, generatedAt: isoFromNs(model.generatedAtNs), sessions: <flatRows order> }`.
- `showJson` → the session object followed by `note`, `launch`, `unknownFlags`, `links` (only links from/to the row, by time,
  `at` ISO), `holders` (`pid`, `bootId`, `procStart`, `since`).
- `formatList` of two groups → `'ABC-123\n  <row>\n\nno group\n  <row>\n'`; empty → `'no sessions\n'`.
- `formatShow` of a row whose `session.launch` is `['claude','--model','opus']` contains `'id:        ' + S1`,
  `'launch:    claude --model opus'` (the recorded command, `shellJoin`), and `'launch:    unknown'` when `launch` is null;
  no `unknown:` line for it; for `['claude','--frob','x','--other=1']` a line `'unknown:   --frob --other'`, and `showJson` has `unknownFlags ['--frob','--other']` (`[]` when `launch` is null);
  a never-fetched PR → `'pr:        https://github.com/o/r/pull/1  not fetched'`; an open PR with review
  `approved` and checks `passing` → `'pr:        https://github.com/o/r/pull/1  approved-green review approved checks passing'`;
  note `'a\nb'` → `'note:\n  a\n  b'`.

`commands/ls.test.ts` and `commands/show.test.ts` (`d = testDeck(t)`; `await main([...], d.ctx)`; output from `d.stdout()`)
- `ls --help` → 0, the usage on stdout; `ls extra` → 2.
- `ls` with no sessions → 0, `'no sessions\n'`; `ls --json` → `sessions []`, `version 1`.
- `ls --all` shows a session marked done in the store that `ls` hides.
- `show --help` → 0; `show` → 2 (missing `<ref>`); `show nope1234` → 3; `show <S1 prefix>` → 0 with `formatShow`;
  `show <S1> --json` → parses, `id` S1.
- S1 with one never-fetched PR and one open PR fetched 1 minute ago; S2 with a never-fetched PR. `ls` and `show 0b5f`
  without `--refresh` → `runner.calls` empty. `ls --refresh` with gh answering the pull requests `open` → one `gh` call with all
  three (the fresh one too); `ls --json` then shows every PR `state 'open'`. `show 0b5f --refresh` → one `gh` call with S1's two
  PRs and not S2's. With S2 marked done, `ls --refresh` asks about S1's PRs only, `ls --all --refresh` about all three. A PR read 2 minutes ago whose later fetch failed 1 minute ago is asked about by `ls --refresh` and by
  `show --refresh` (one call each). Merged and closed PRs are never asked about (no call). gh `timedOut` → exit 0, the PR shows `can't read`.

`day.test.ts` — the recorded day. Copy `test/fixtures/day/` into a `testDeck` (spool into `spoolDir`,
`claude/` into `claudeHome`, every copied file's mtime set to 09:04 with `fs.utimesSync`),
configure the fake proc from `proc.json`, clock `T0 + 5m` (`2026-11-12T09:05:00.000Z`), run `ls --json`, compare to `expected-ls.json` with `generatedAt`
`'2026-11-12T09:05:00.000Z'` — deep equality of the parsed JSON. Write `expected-ls.json` **by
hand from the rules**, never by pasting skydeck's output. The day:

| Time (UTC) | Spool event | Process (boot, pid, start) | Session |
|---|---|---|---|
| 08:00 | start `startup`, argv `claude --model opus`, cwd `/home/dev/projects/api` | A, 4242, 100 | S1 |
| 08:30 | start `startup`, argv `claude`, cwd `/home/dev/projects/web` | A, 4343, 200 | S2 |
| 08:45 | end `clear` | A, 4343, 200 | S2 |
| 08:45:00.2 | start `clear` | A, 4343, 200 | S3 |
| 08:55 | start `startup` | A, 4545, 300 | S4 |
| 08:56 | end `prompt_input_exit` | A, 4545, 300 | S4 |
| 09:00 | start `startup`, argv `claude --add-dir /home/dev/projects/lib`, cwd `/home/dev/projects/api` | B, 5000, 600 | S5 |
| 09:01 | start `startup`, argv `claude -p x` (scripted, dropped) | B, 6000, 700 | S9 |

Current boot B; `/proc` has only pid 5000 (start 600). Live files: `5000.json` (S5, `busy`,
`statusUpdatedAt` 09:01) and a leftover `4242.json` (S1, procStart `"100"`, `busy` — the machine
was shut down, not the terminal closed). Transcripts (`<claudeHome>/projects/<folder>/<id>.jsonl`;
every record carries `cwd` and `entrypoint 'cli'` unless stated; `user`/`assistant` records alternate):

| Session | Records (UTC) | cwd | Last `user`/`assistant` record |
|---|---|---|---|
| S1 | `user` 08:00 … `assistant` 08:40; `ai-title 'Fix retry loop'`; `pr-link https://github.com/acme/api/pull/12` at 08:20 | `/home/dev/projects/api` | `assistant` |
| S2 | `user` 08:30 … `assistant` 08:44; `ai-title 'Clean up logging'` | `/home/dev/projects/web` | `assistant` |
| S3 | `user` 08:46, `assistant` 08:48, `user` 08:50 (a turn in progress); no title | `/home/dev/projects/web` | `user` |
| S4 | `user` 08:55:10, `assistant` 08:55:40; `custom-title 'quick check'` | `/home/dev/projects/api` | `assistant` |
| S5 | `user` 09:00, `assistant` 09:01, `user` 09:02; `ai-title 'ABC-123 add retries'` | `/home/dev/projects/api` | `user` |
| S6 | `user` 08:20 with `entrypoint 'sdk-ts'` | `/home/dev/projects/api` | `user` |

Expected list order and key fields:

| # | id | title / source | group | state, since | marks | other |
|---|---|---|---|---|---|---|
| 1 | S5 | `ABC-123 add retries` / generated | `ABC-123` | working, 09:01 | `[]` | dir `/home/dev/projects/api` |
| 2 | S3 | `2026-11-12 08:45 web` / fallback | null | not-running, 08:50 | `['ended-unexpectedly','was-working','continued']` | `continuedFrom` S2 (was-working from the transcript) |
| 3 | S1 | `Fix retry loop` / generated | null | not-running, 08:40 | `['ended-unexpectedly','was-working']` | one PR `acme/api` #12, state null |
| 4 | S4 | `quick check` / name | null | not-running, 08:56 | `[]` | (deliberate exit) |
| 5 | S2 | `Clean up logging` / generated | null | not-running, 08:45 | `[]` | |

S6 and S9 are absent; `getKv('dropped_scripted')` is `'1'` afterwards; the run exits 0.

**Steps**
- [ ] Write the fixtures, `expected-ls.json` (by hand) and the four test files. `npm test` → fails.
- [ ] Implement `output.ts`, `ls.ts`, `show.ts`; update design 7.3 and 7.5 (D11).
- [ ] `npm run format`; `npm run check` → pass. Commit `Add ls and show with stable JSON, and the recorded-day test`; open the PR.

**Done when:** all cases pass; `ls --json` matches the hand-written expectation for the day.

---

### Task 15: `label`, `group`, `note`, `done`, `undone`, `pr`

**Depends on:** 9, 11, 12 · **Wave:** 5 · **Design:** 7.1, 7.3 (manual attach, detach, refresh), 7.5 · **Contracts:** 2.8.5, 2.9.4 · **Decisions:** D11 (`pr add` fetches; update design 7.3), D14 (update design 7.1), D24 (joined text; update design 7.5)

**Files**
- Create: `src/sessions/meta.ts`, `src/cli/notes.ts`
- Create (test helpers, ruled by the plan owner): `test/helpers/session-files.ts` (transcripts on disk, a running process, `twoSessions`, `withRunner`), `test/helpers/command-cases.ts` (the `--help` / missing-ref / unknown-ref cases of the five `<ref>` commands)
- Create: `src/cli/commands/label.ts`, `group.ts`, `note.ts`, `done.ts`, `undone.ts`, `pr.ts` (each `export const command: Command`)
- Modify: `docs/design.md` 7.1 (D14), 7.3 (D11: `pr add` fetches at once), 7.5 (D24)
- Test: `test/sessions/meta.test.ts`, `test/cli/notes.test.ts`, and `test/cli/commands/<name>.test.ts` for the six commands

**Exported API**

```ts
// src/sessions/meta.ts (labels are cleaned by the caller with cleanLabel/cleanGroup of task 11)
export function setLabel(deck: Deck, sessionId: string, label: string | null): void;
export function setGroup(deck: Deck, sessionId: string, group: string | null): void;
export function setNote(deck: Deck, sessionId: string, note: string | null): void;
export function markDone(deck: Deck, sessionId: string): void;
export function markUndone(deck: Deck, sessionId: string): void;
export function attachManualPr(deck: Deck, sessionId: string, url: string): PrKey;   // throws UsageError
export function detachSessionPr(deck: Deck, sessionId: string, url: string): PrKey;  // throws UsageError, SkydeckError (failure)
// src/cli/notes.ts — also used by the interactive list (task 19)
export function editNote(ctx: Context, deck: Deck, sessionId: string): Promise<void>;   // throws UsageError, SkydeckError
// src/cli/commands/{label,group,note,done,undone,pr}.ts — names, summaries and usage lines of 2.9.4
export const command: Command;
```

Command behaviour: each resolves `<ref>` with `resolveRef(ref, loadRows(deck))` inside
`withDeck(ctx, { refresh: true }, …)`. The text of `label`/`group` is the remaining positionals
joined by one space (D24), cleaned with `cleanLabel`/`cleanGroup`; no text, or a text that is empty or only spaces, clears (ruled by the plan owner: a script may pass an empty variable). `pr add` and `pr rm` check the url (`requirePrKey`) before the deck is opened, so a bad url is exit 2 whatever `<ref>` is. Each command
prints one confirmation line on stdout: `0b5f3c1e label: fix retry`, `0b5f3c1e label cleared`,
`0b5f3c1e group: ABC-9`, `0b5f3c1e group cleared`, `0b5f3c1e note saved`, `0b5f3c1e note cleared` (when the note ends up empty: `--set ''`, or an emptied editor buffer), `0b5f3c1e done`, `0b5f3c1e undone`,
`0b5f3c1e: attached https://github.com/o/r/pull/1 (<status>)` — `<status>` is what `formatPrLine` prints after the url and its two spaces —, `0b5f3c1e: detached https://github.com/o/r/pull/1`.
`pr add` attaches, then fetches that pull request at once with `fetchPrs({ runner, clock, store, env: ctx.platform.env }, [url])` (D11; same
timeout); a failed fetch leaves it `cant-read` and the command still exits `EXIT.ok`.
`note` without `--set` calls `editNote`. `pr refresh` runs
`refreshPrs({ runner, clock, store, env: ctx.platform.env }, { force: true, refreshMinutes: config.prRefreshMinutes })`
(2.6) and prints `fetched <n>, failed <m>`.

**Test cases** (`d = testDeck(t, …)`, clock `T0`; S1 and S2 known from transcripts; commands run as `await main([...], d.ctx)`;
results are checked in the store (`d.deck.store.meta`, `sessionPrs`, `prs`) or with `loadRows(d.deck)`)

`meta.test.ts`
- `setLabel(S1,'x')` → `meta(S1).label 'x'`, `createdNs T0`; `setLabel(S1, null)` → `null`, other fields kept.
- `setNote(S1, '  \n ')` → `note null`; `setNote(S1, 'a\nb')` → `'a\nb'` (not trimmed).
- `markDone` → `doneAtNs T0`; `markUndone` → `null`. A running session can be marked done (nothing is stopped: `runner.calls` empty).
- `attachManualPr(S1, 'https://github.com/O/R/pull/5/files')` → key url `…/o/r/pull/5`, row origin `manual`;
  after a `detachSessionPr` it is detached; `attachManualPr` again → attached, `detachedAtNs null`.
- `attachManualPr(S1, 'https://example.com')` → `UsageError` "not a GitHub pull-request URL: https://example.com".
- `detachSessionPr(S1, <never attached url>)` → `SkydeckError` with exit code `EXIT.failure`.
- Notes never move: `setNote(S1,'n')`, then a clear link S1→S2 is ingested → `meta(S2)` is `null`.

`notes.test.ts`
- stdin not a TTY → `UsageError`.
- `stdinTTY`, env `EDITOR='fake-editor --wait'`, a fake `runInteractive` that writes `'edited\n'` into the file given as its last
  argument and returns 0 → stored `'edited\n'`; the call was `('fake-editor', ['--wait', <stateDir>/note-<S1>.md])`; the file is
  gone afterwards. The editor is given the current note as the file content.
- Returning 3 → `SkydeckError` `'editor exited 3'`, note unchanged, file gone. `VISUAL` set → used before `EDITOR`; neither → `vi`.

`commands/label.test.ts`, `group.test.ts`, `note.test.ts`, `done.test.ts`, `undone.test.ts`
- Each: `--help` → 0 with its usage; a missing `<ref>` → 2; `nope1234` as ref → 3.
- `label 0b5f fix the retry` → 0, stdout `'0b5f3c1e label: fix the retry\n'`, stored `'fix the retry'`; `label 0b5f` → cleared.
- `label 0b5f -- -x` → 2 (cleanLabel).
- `group 0b5f ABC-9` → stored `'ABC-9'`; the `loadRows` row then has `group 'ABC-9'`.
- `note 0b5f --set 'remember'` → stored; `note 0b5f --set ''` → cleared; `note 0b5f` with stdin not a TTY → 2.
- `done 0b5f` → 0; the row is no longer `isListed(row, false)`; `isListed(row, true)` and `done true`; `undone 0b5f` → listed again.
- A done session with a later `user` record in its transcript is listed again without `undone`.

`commands/pr.test.ts` (`fakeRunner` answering `gh`)
- `pr add 0b5f https://github.com/o/r/pull/1` with gh answering it open, no review, checks passing → 0, one `gh` call, stdout
  `'0b5f3c1e: attached https://github.com/o/r/pull/1 (approved-green)\n'`; the S1 row has that PR with `state 'open'`.
- The same with gh `timedOut` → 0, stdout ends `(can't read, last read never (gh timed out after 10 s))`; the PR level is `cant-read`.
- `pr add 0b5f not-a-url` → 2; `pr rm 0b5f https://github.com/o/r/pull/9` → 1; `pr rm 0b5f https://github.com/o/r/pull/1` → 0 and the row has no PR.
- An auto-attached PR removed with `pr rm` stays detached after a rescan sees its `pr-link` again.
- `pr refresh` with gh answering one ok open PR → stdout `'fetched 1, failed 0\n'`; the PR row `state 'open'`.
- `pr refresh` with gh `timedOut` → `'fetched 0, failed 1\n'`, exit 0; the PR row `error 'gh timed out after 10 s'`, state unchanged.
- `pr`, `pr frob` → 2; `pr --help` → 0.

**Steps**
- [ ] Write the test files. `npm test` → fails.
- [ ] Implement `src/sessions/meta.ts`, `src/cli/notes.ts` and the six command files; update design 7.1 and 7.5.
- [ ] `npm run format`; `npm run check` → pass. Commit `Add label, group, note, done and pull-request commands`; open the PR.

**Done when:** all cases pass; no command stops a process or moves a note.

---

### Task 16: `resume`, `new`, the guard and the lock

**Depends on:** 2, 7, 11, 12 · **Wave:** 5 · **Design:** 7.6, 7.7, principles 5 and 7, 12 (resume: guard and lock) · **Contracts:** 2.8.6, 2.9.4 (`launching.ts`), 2.10.3, 2.10.4 · **Decisions:** D16, D24 (tab without adapter) (update design 7.6)

**Files**
- Create: `src/sessions/resume.ts`, `src/sessions/resume-by-id.ts`, `src/cli/launching.ts`
- Modify: `src/sessions/refresh.ts` — call `sweepLocks(deck)` at the end of `refresh` (one line)
- Modify (ruled in review): `src/store/types.ts` and `src/store/store.ts` (`KvKey` `resume_lock:<id>`, `kvEntries`), `src/terminals/{types,here,wezterm}.ts` (`timedOut` in `OpenResult`), with their tests
- Create: `src/cli/commands/resume.ts`, `src/cli/commands/new.ts` (each `export const command: Command`)
- Modify: `docs/design.md` 7.6 (D16; D24: `--tab` without an adapter; the two failures that print no command)
- Test: `test/sessions/resume.test.ts`, `test/sessions/resume-lock-concurrency.test.ts` (with `test/fixtures/resume-lock-child.ts`), `test/cli/launching.test.ts`, `test/cli/commands/resume.test.ts`, `test/cli/commands/new.test.ts`

**Exported API**

```ts
// src/sessions/resume.ts
export const LOCK_TTL_NS: Ns;                                                    // 60n * NS_PER_SECOND
export function lockKey(sessionId: string): `resume_lock:${string}`;            // throws RangeError
export function checkResumable(row: ListRow, files: Files): void;               // throws ResumeRefusedError
export interface SawEvents { latestEventId: number | null }
export function acquireLock(deck: Deck, sessionId: string, saw: SawEvents): void; // throws ResumeRefusedError
export function sweepLocks(deck: Deck): number;
export interface PreparedLaunch { sessionId: string; cwd: string; argv: string[]; flagsKnown: boolean; unknownFlags: string[]; kind: 'resume' | 'new' }
export function prepareResume(deck: Deck, row: ListRow): PreparedLaunch;          // throws ResumeRefusedError; the row must come from rows loaded right after a refresh
export function prepareNew(deck: Deck, options: { label: string | null; group: string | null; extra: readonly string[] }): PreparedLaunch;  // throws UsageError
// src/sessions/resume-by-id.ts
export function prepareResumeById(deck: Deck, sessionId: string): PreparedLaunch;  // throws RefError, ResumeRefusedError; the entry point of the command, the list and restore
// src/cli/launching.ts
export interface LaunchOutcome { code: number; lines: string[] }
export function launchPrepared(deck: Deck, prepared: PreparedLaunch, where: 'here' | 'tab' | null): Promise<LaunchOutcome>;
// src/cli/commands/resume.ts, src/cli/commands/new.ts — names, summaries and usage lines of 2.9.4
export const command: Command;
```

`--here` and `--tab` together → `UsageError`. The order inside `resume` is: `withDeck(ctx, { refresh: true }, …)`
(ingest, reconcile, scan — design 7.6) → `loadRows` → `resolveRef` (to a session id) →
`prepareResumeById(deck, row.id)` (which refreshes and loads again, then `prepareResume`: guard, then
lock, then command) → `launchPrepared`. `prepareNew` cleans the label and group with `cleanLabel`/`cleanGroup` (task 11).

**Test cases** (`testDeck`, clock `T0`; `rowOf(id)` = the `loadRows` row)

`resume.test.ts`
- `checkResumable`: a running row (P1 alive) → `ResumeRefusedError` (exit 4) `'0b5f3c1e is running (pid 4242)'`;
  two holders → `'(pid 4343, pid 4242)'`; no transcript → `'0b5f3c1e has no transcript'`; expired → `'0b5f3c1e has expired: its transcript is gone'`;
  dir `/gone` → `'0b5f3c1e: directory /gone no longer exists'`; a dead session with an existing dir → no throw.
- `acquireLock(S1, saw)` (`saw` = the store's latest event id of S1 at the time of the call, `null` when it has none; the examples that follow leave it out) → kv `resume_lock:<S1>` = `` `${T0}` ``. Second call at `T0+10s` →
  `ResumeRefusedError` `'0b5f3c1e is being resumed (10 s ago); try again in 50 s'`. At `T0+61s` → succeeds, content `T0+61s`.
- Lock at `T0`, a start event for S1 at `T0` or later ingested, call at `T0+5s` → succeeds (replaced).
- `sweepLocks` removes a lock older than 60 s and a lock followed by a start event; keeps a fresh one; returns the count.
  `refresh(deck)` sweeps too.
- `prepareResume` on a dead S1 with launch `['claude','--model','opus']` and label `'fix'` →
  `{ sessionId: S1, cwd: <dir>, argv: buildResumeCommand(...).argv, flagsKnown: true, unknownFlags: [], kind: 'resume' }`, lock created; on a running row → refused, no lock.
- `prepareResume` on a dead S1 with launch `['claude','--frob','x','--model','opus']` → `argv [...R,'--model','opus']`, `unknownFlags ['--frob']`.
- Guard before lock: a running row with a stale lock → refused for running; the lock is unchanged.
- `acquireLock(S1, { latestEventId })`: the id of S1's only event → lock taken; a second event of S1 (a start by another skydeck) → `ResumeRefusedError`
  `"the session's state changed while preparing; run the command again"`, no lock written (a stale lock stays as it was); `null` with an event present → refused;
  events of other sessions do not count; the argument is required (a test with `// @ts-expect-error` makes `npm run typecheck` fail when it becomes optional);
  the latest event is read inside the one transaction, before the write.
- `acquireLock`: a start event with `pid 0` and/or no `procStart` after a fresh lock does not release it (still "is being resumed"); `sweepLocks` keeps such a lock.
- `prepareResume`: with a row whose `session.bootId` is null (also when `proc.bootId()` works now) → `ResumeRefusedError` `'cannot tell which sessions are running: the boot id could not be read'` before every other
  refusal, no lock; a row whose `bootId` is set resumes whatever `proc.bootId()` says now; with a row whose `lastEventId` is behind the store's (a start event inserted after the row was read, also from inside `files.stat`, which
  `checkResumable` calls between the read and the lock) → the "state changed" refusal and no lock — also when A took the lock, its start event was ingested and `sweepLocks`
  removed the lock before B's call; a row that is up to date resumes. `prepareNew` with no boot id works.
- `prepareResumeById(deck, S1)` (`test/sessions/resume-by-id.test.ts`): a dead S1 → the resume command and the lock; after rows were loaded, a start event of another process
  (4343, alive) written to the spool → refused `'0b5f3c1e is running (pid 4343)'`, no lock; refusals of the guard (directory gone, boot id unreadable, a second resume within 60 s) pass through
  with no lock; an unknown id, a prefix, a label and an upper-case id → `RefError`.
- `acquireLock` and `sweepLocks` each read and write inside one transaction; several child processes taking one session's lock at once against one database file: exactly one succeeds, every round, with and without a stale lock and a sweep first.
- `prepareNew({ label: ' x ', group: 'G', extra: ['--model','opus'] })` → `sessionId '00000000-0000-4000-8000-000000000001'`,
  `cwd` = `platform.cwd`, `argv ['claude','--session-id',<id>,'-n','x','--model','opus']`, `flagsKnown true`, `unknownFlags []`, `kind 'new'`, meta label `'x'` and group `'G'` stored;
  label `'-x'` → `UsageError` and no meta stored; extra `-r <id>`, `-c`, `-cp`, `--session-id=<uuid>`, and every other flag with `picksSession` (alone, as `--flag=value`, in a cluster) → `UsageError` naming the flag, no meta stored; `-n x`, `--name=x`, `-nx` → `UsageError` that names `--label`; `--model x 'prompt'`, `--worktree`, `-w feat --model x 'prompt'`, `-pw --tmux` and every other removed flag that is not `picksSession` pass.

`commands/resume.test.ts`, `commands/new.test.ts` (`d = testDeck(t, { env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }) })`; `await main([...], d.ctx)`)
- `resume --help`, `new --help` → 0 with the usage.
- `resume 0b5f` where, between the command's first look and `prepareResumeById`'s own refresh (the second listing of the spool), another process (4343) writes a start event of S1 to the spool → 4, stderr `'skydeck: 0b5f3c1e is running (pid 4343)\n'`, no lock, no handoff file.
- `resume 0b5f` (also `--tab`, `--here`) with `proc.setBootId(null)`, S1 recorded as running → 4, stderr `'skydeck: cannot tell which sessions are running: the boot id could not be read\n'`, no lock, no handoff file, no program run.
- `resume 0b5f` (config default `here`) → 0, `<root>/handoff` = `handoffScript({ cwd: <dir>, argv })`.
- Without `SKYDECK_HANDOFF` (`env: { SKYDECK_HANDOFF: undefined }`) → 1, stderr contains `not started through bin/skydeck` and `cd -- <dir> && claude --resume <S1>`.
- `resume 0b5f --tab` with config `{"terminal":"wezterm"}` and gh-free `fakeRunner` answering code 0 → 0, one `wezterm cli --no-auto-start spawn` call
  with `--cwd <dir> -- claude --resume <S1>`; answering code 1 → 1 and the quoted command on stderr.
- `resume 0b5f --tab` with terminal `here` → 1, stderr names the missing tab adapter and prints the command.
- `resume 0b5f --here --tab` → 2. `resume nope1234` → 3. A running S1 → 4 naming the pid. Twice within 60 s → second 4.
- A session without a recorded launch command → 0 and stderr `'skydeck: original flags unknown; resuming with defaults\n'`.
- A session whose recorded launch command has `--frob x` → 0, stderr `'skydeck: started with flags skydeck does not know, not passed on resume: --frob\n'`
  (before any failure lines), and the handoff argv has neither `--frob` nor `x`; two unknown flags are named in order,
  separated by a space; a name with a control character is printed sanitised; a session whose flags are all known prints no such line.
- Never a permission flag: the handoff of a session launched without one contains no `--dangerously-skip-permissions` and no `--permission-mode`.
- `new --label 'fix it' --group ABC-1 -- --model opus` → 0; handoff
  `cd -- <cwd> || exit 1\nexec claude --session-id <uuid1> -n 'fix it' --model opus\n`; `meta(<uuid1>)` label `'fix it'`, group `'ABC-1'`.
- `new --label -x` → 2. `new -- -r <id>` → 2. `new -- -n x` → 2 and stderr names `--label`. `new -- --worktree` → 0 and the handoff is
  `cd -- <cwd> || exit 1\nexec claude --session-id <uuid1> --worktree\n`; `new -- -w feat --model x 'fix the bug'` → 0, the flags reach the command.
- After a failed open and after a WezTerm timeout the lock still holds (a second resume → 4); after a timeout no command is printed. `new --tab` timing out → `'skydeck: the new session\'s id is <uuid1>; running skydeck shows whether it started'`.

**Steps**
- [ ] Write the three test files. `npm test` → fails.
- [ ] Implement `src/sessions/resume.ts`, `src/cli/launching.ts`, the two commands; add the `sweepLocks` call to `refresh`; update design 7.6.
- [ ] `npm run format`; `npm run check` → pass. Commit `Resume and new with the one-holder guard and the resume lock`; open the PR.

**Done when:** all cases pass; a session is never resumed while running or twice within 60 s; no
permission flag is ever added.

---

### Task 17: `install`, `uninstall`, `doctor`

**Depends on:** 3, 11, 12 · **Wave:** 5 · **Design:** 5.1, 7.1 (first-run offer), 8, 12 (settings) · **Contracts:** 2.5.6, 2.4.1 (`KvKey`) · **Decisions:** D20 (update design 8)

**Files**
- Create: `src/cli/commands/install.ts`, `src/cli/commands/uninstall.ts`, `src/cli/commands/doctor.ts` (each `export const command: Command`)
- Modify: `docs/design.md` 8 (D20)
- Test: `test/cli/commands/install.test.ts`, `test/cli/commands/uninstall.test.ts`, `test/cli/commands/doctor.test.ts`

**Exported API**

```ts
// names, summaries and usage lines of 2.9.4; install and doctor take no arguments, uninstall takes --purge
export const command: Command;   // in each of the three files
```

**Behaviour fixed here** (design 8):
- **install**, inside `withDeck(ctx, { refresh: false }, …)`: (1) `openDeck` creates the directories and the database. (2) Symlinks:
  `hookPath` → `<appRoot>/bin/skydeck-hook`, `binLink` → `<appRoot>/bin/skydeck` (creating
  `~/.local/bin`), `nodeLink` → `platform.nodePath`. (3) `addHookEntries(<settings text or null>, hookPath)`;
  when `changed`: print to stderr `skydeck will add these hook entries to <settingsPath>:` and the
  added groups as JSON, ask `readLine('Add them? [y/N] ')`; anything but `y`/`yes` (or null) →
  print `settings not changed` and return 1. On yes: write the backup
  `<settingsPath>.skydeck-backup` with the old content (kv `settings_backup` = its path, or `none`
  when there was no file; an existing backup is never overwritten), write the new text, set kv
  `settings_hash` = sha256 hex of the written text. When not changed: print
  `hook entries already present`. (4) `refreshWithProgress(ctx, deck)`. (5) Unless kv `first_run_offered`:
  count rows that are listed, not done, not running, with `lastActivityNs` older than
  `firstRunDoneAfterDays`; when > 0 ask `Mark <n> sessions older than <d> days as done? [y/N] `
  and on yes set their `doneAtNs` with `store.updateMeta(id, { doneAtNs: now }, now)`; set `first_run_offered`. Return `EXIT.ok`.
- **uninstall** never creates anything: `resolveDeckPlaces`; when `dbPath` exists, it reads and
  deletes the kv keys through `withDeck(ctx, { refresh: false }, …)`, otherwise kv counts as empty.
  When kv `settings_hash` equals the sha256 of the current settings text → restore:
  backup path → copy it over `settings.json` and remove the backup; `none` → remove `settings.json`.
  Otherwise, when the file exists → `removeHookEntries` and write if changed. Remove the three
  links, each only when it is a symlink pointing where install pointed it. Delete kv
  `settings_hash`, `settings_backup`. `--purge` → after `withDeck` has returned (the store is
  closed), `removeTree` dataDir, stateDir, configDir. Return `EXIT.ok`.
- **doctor** uses `withDeck(ctx, { refresh: false }, …)` and counts the spool as it is (nothing is
  ingested); one line per check, `ok       <text>`, `info     <text>` or `problem  <text>`;
  exit 1 when any line is a problem. Problems: an event without its hook entry
  (`hookStatus`); `hookPath` not resolving to a regular file (`files.stat` kind `file`); `checkNodeVersion(platform.nodeVersion)`
  (from `bin/node-version.mjs`) returns a message; the database not writable (`setKv('doctor_probe', <now>)`
  throws); files in `spool/bad/`; more than 1000 files in the spool; `gh --version` not found;
  `gh auth status` exit code ≠ 0; terminal `wezterm` and `wezterm cli list` fails; an entry of
  `<claudeHome>/projects` that cannot be read (`listTranscriptFiles(platform.files, deck.places.claudeHome).unreadable`, one
  line each: `transcripts: cannot read <path> (<reason>)`, the path through the sanitiser). Info: spool
  count, age of the last event (`last event <formatAge> ago` or `no events yet`), the last 5 lines
  of `hook.log` (or `hook.log is empty`), `scripted runs dropped: <n>`.

**Test cases** (`d = testContext(t, { lines: [...] })`, `await main(['install'], d.ctx)` etc.; `H` = `places.hookPath`; `SP` = `<claudeHome>/settings.json`; each command also: `--help` → 0, an extra argument → 2)

`install.test.ts`
1. No settings file, answer `y` → 0; `readlink(H)` = `<appRoot>/bin/skydeck-hook`; `readlink(binLink)` = `<appRoot>/bin/skydeck`;
   `readlink(nodeLink)` = `process.execPath`; `SP` parses to the two entries; kv `settings_backup 'none'`;
   kv `settings_hash` = sha256 of `SP`'s content; stderr shows the entries before the prompt; `prompts` contains `'Add them? [y/N] '`.
2. Existing `SP` `{"model":"opus"}`, answer `y` → backup file content `{"model":"opus"}`, `SP` has `model` and both entries.
3. Answer `n` → 1, `SP` unchanged, no backup; `readLine` returning null (no terminal) → the same.
4. Install twice → second run asks nothing about hooks (`prompts` has no `'Add them?'`), `SP`, backup and hash unchanged, stdout/stderr say `hook entries already present`, exit 0.
5. Foreign hook entries in `SP` survive install.
6. A spool file present before install → ingested (one event) after install.
7. First-run offer: two transcripts with `lastActivity` 10 days old, one 2 days old, answer `y` → the two are done; `first_run_offered '1'`; a later install asks nothing.
   No old sessions → no question, flag still set.

`uninstall.test.ts`
1. After install from no file, `uninstall` → `SP` removed, backup gone, links removed, kv hash/backup deleted, database still present.
2. After install over `{"model":"opus"}` → `SP` content equals `{"model":"opus"}` again.
3. After install, the user edits `SP` (adds `"theme":"dark"`) → `uninstall` keeps `theme` and `model`, removes only the entries naming `H`.
4. `binLink` replaced by a symlink to `/elsewhere` → left alone.
5. `uninstall --purge` → dataDir, stateDir, configDir gone.
6. `uninstall` with nothing installed → 0; no directory, database or file is created (`sandbox.skydeckHome` stays empty).

`doctor.test.ts` (fake runner answers `gh --version` 0, `gh auth status` 0, `wezterm cli list` 0 unless stated)
1. After a complete install with one event → 0; every line starts with `ok` or `info`; contains `info     last event`.
2. Each problem alone → 1 with a `problem` line: no hook entries; `H` dangling (re-point `H` at a temporary file, then delete that file — never touch the repository's `bin/skydeck-hook`);
   `nodeVersion '24.11.0'`; a file in `spool/bad/`; 1001 files in the spool; `gh` not found; `gh auth status` code 1;
   config terminal `wezterm` with `wezterm cli list` code 1; a symbolic link loop in `<claudeHome>/projects` (`transcripts: cannot read … (ELOOP)`).
3. `hook.log` with 7 lines → output contains its last 5 lines, not the first 2.
4. `dropped_scripted 3` → `info     scripted runs dropped: 3`.

**Steps**
- [ ] Write the three test files. `npm test` → fails.
- [ ] Implement the three commands.
- [ ] Update design 8 (D20; and the list of what `doctor` reports: a project folder or transcript that cannot be read, see 5.6). `npm run format`; `npm run check` → pass. Commit `Add install, uninstall and doctor`; open the PR.

**Done when:** all cases pass; install twice changes once; foreign hook entries always survive;
nothing but the two hook entries is ever written into Claude Code's settings.

---

### Task 18: `restore`

**Depends on:** 16 · **Wave:** 6 · **Design:** 7.6 (guard), 7.8, principle 7, 12 (resume and restore) · **Contracts:** 2.8.7 · **Decisions:** D17, D19, D23 (update design 7.8)

**Files**
- Create: `src/sessions/restore.ts`
- Create: `src/cli/commands/restore.ts` (`export const command: Command`)
- Modify: `docs/design.md` 7.8 (D17, D19, D23)
- Test: `test/sessions/restore.test.ts`, `test/cli/commands/restore.test.ts`

**Exported API**

```ts
// src/sessions/restore.ts
export interface RestoreEntry { row: ListRow; bootId: string; endedAtNs: Ns | null; wasWorking: boolean; preselected: boolean }
export function planRestore(rows: readonly ListRow[], events: readonly EventRow[], currentBootId: string | null, all: boolean): RestoreEntry[];
export interface RestoreOutcome { started: string[]; timedOut: string[]; failed: { id: string; reason: string }[]; notStarted: string[]; handedOff: string | null; printed: string[]; stoppedForMemory: boolean }
export function runRestore(deps: { deck: Deck; terminal: Terminal; report: (line: string) => void }, entries: readonly RestoreEntry[]): Promise<RestoreOutcome>;
// src/cli/commands/restore.ts — name, summary and usage line of 2.9.4
export const command: Command;
```

**Rules fixed here.**
- **Boots.** For every boot id in `events`, its last event time. The **latest earlier boot** is
  the boot ≠ `currentBootId` with the largest last event time among boots that have a `start` or
  `observed` event.
- **Set.** Default: rows with mark `ended-unexpectedly`, not `done`, not `expired`, whose
  `session.lastHolding.process.bootId` is the latest earlier boot. `all`: additionally every other
  row with `ended-unexpectedly`, not done, not expired, from any boot including the current one.
- **Entry.** `bootId` = the last holding's boot; `endedAtNs` = `lastHolding.endedAtNs`;
  `wasWorking` = mark `was-working`; `preselected` = `endedAtNs === null` or
  `endedAtNs >= <last event time of that boot> − 2 min` (D17). Order = order of `rows`.
- **Run with tabs** (`terminal.opensTabs`): batches of `config.restoreBatch`. Before each batch:
  `memAvailableMb() < restoreMinFreeMb` (null counts as enough) → `stoppedForMemory`, the rest go
  to `notStarted`, stop. Then, for each entry of the batch: `prepareResumeById(deck, entry id)`
  (it refreshes and loads the rows by itself, design 7.6; a `RefError` → `failed` "no longer
  known"; a refusal → `failed`), then `terminal.open` (error → `failed`). Then, from the clock time taken before opening the batch,
  loop: `ingestSpool(deck)`; entries with `store.hasStartSince(id, batchStartNs)` → `started`;
  until all started or `restoreStartTimeoutSeconds` elapsed, `clock.sleep(1000)` between checks;
  the rest → `timedOut` (reported, skipped). `report` gets one line per outcome
  (`started <short> <title>`, `timed out <short> <title>`, `failed <short>: <reason>`).
- **Run without tabs:** the first entry → `prepareResumeById` + `terminal.open` (here) → `handedOff`;
  every other entry → `prepareResumeById` is NOT called (no lock); its command
  (`cd -- <shellQuote(dir)> && <shellJoin(buildResumeCommand …)>`) goes to `printed` and to `report`.
- **Command.** Without `--yes`, stdin must be a terminal (else `UsageError`). The list shows per
  entry `<n>. [x| ] <shortId>  <title>  <how it ended>[  was working]` with how it ended =
  `no exit recorded` or `ended <iso>`. Prompt `Toggle numbers, Enter to start, q to cancel: `; a
  line of numbers separated by spaces toggles them and re-prints; an empty line confirms; `q`
  → `RestoreStoppedError` (exit 5). `--yes` takes the preselection. `--dry-run` prints the list and
  each command and returns 0 without opening anything. Empty set → `nothing to restore`, 0.
  Exit code per D23.

**Test cases**

`restore.test.ts` (`testDeck`; events written through the store; every session below has a transcript unless stated; current boot `BOOT_B`; `BOOT_A` earlier with last event `T0`; `BOOT_C` older with last event `T0 − 1 day`)

| Session | History | Default set? | `all`? | preselected |
|---|---|---|---|---|
| S1 | `BOOT_A`: start, no end | yes, `endedAtNs null` | yes | yes |
| S2 | `BOOT_A`: start, end `other` at `T0 − 30s` | yes | yes | yes |
| S3 | `BOOT_A`: start, end `other` at `T0 − 10m` | yes | yes | no |
| S4 | `BOOT_A`: start, end `exit` | no | no | — |
| S5 | `BOOT_C`: start, no end | no | yes | yes (relative to `BOOT_C`) |
| S6 | `BOOT_B` (current), process dead, no end | no | yes | yes |
| S7 | as S1 but done | no | no | — |
| S8 | as S1 but transcript missing | no | no | — |
| S9 | as S1 plus a leftover busy live file | yes, `wasWorking true` | yes | yes |

- No earlier boot (all events in `BOOT_B`) → default set `[]`.
- Entries come out in the order of the given rows.

`runRestore` with a fake `Terminal` (`opensTabs true`; `open` records the spec and, for sessions in a
"starts" set, writes a start spool file for that session at the current clock time), config
`restoreBatch 2`, `restoreStartTimeoutSeconds 3`, `restoreMinFreeMb 4096`, `memAvailableMb 8000`:
1. Five entries that all start → opened in batches of 2, 2, 1; the third `open` happens only after both
   sessions of the first batch have start events; `started` has all five; `clock.sleep` is never called
   (each check after opening already finds the start events).
2. One entry never starts → after 3 `sleep(1000)` calls it is in `timedOut`; the next batch still runs.
3. Memory 3000 before the first batch → `stoppedForMemory`, `notStarted` all five, no `open`.
   Memory drops to 3000 after the first batch → first two `started`, other three `notStarted`.
4. A selected session became running → `failed` with `'… is running (pid …)'`; no `open` for it.
5. `open` returns `{ ok: false, error: 'boom', timedOut: false }` → `failed` with `'boom'`.
6. Without tabs (`hereTerminal` with `SKYDECK_HANDOFF`) and three entries → first `handedOff` (handoff file
   written), two lines in `printed`, each `cd -- <dir> && claude --resume <id> …`; only one resume lock exists.

`commands/restore.test.ts` (`d = testDeck(t, { lines: [...], stdinTTY: … })`; `await main(['restore', …], d.ctx)`)
- `restore --help` → 0; `restore extra` → 2.
- `restore --dry-run` → 0, prints the default entries with `[x]`/`[ ]` and their commands, opens nothing.
- `restore` with stdin not a TTY and no `--yes` → 2.
- `restore --yes` (here terminal) with S1 and S2 preselected → hands off S1, prints S2's command, exit 0.
- Interactive: `lines ['3', '']` → entry 3 toggled on, run starts with it included; `lines ['q']` → 5.
- Empty set → `'nothing to restore\n'`, 0.
- `restore --all --dry-run` lists S5 and S6 as well.
- Exit 1 when one entry timed out; exit 5 on the memory stop (listing what was not started).

**Steps**
- [ ] Write both test files. `npm test` → fails.
- [ ] Implement `src/sessions/restore.ts` and the command; update design 7.8.
- [ ] `npm run format`; `npm run check` → pass. Commit `Restore what was open before the last restart`; open the PR.

**Done when:** all cases pass; restore never resumes a running session and never opens more than
`restoreBatch` tabs before the previous batch has started or timed out.

---

### Task 19: Interactive list — terminal wrapper, actions, bare `skydeck`

**Depends on:** 13, 14 (bare `skydeck` falls back to `ls`), 15, 16 · **Wave:** 7 · **Design:** 7.4 (interactive list, background refresh), 7.3 (paint from cache, refresh in the background), 7.5 (bare `skydeck`) · **Contracts:** 2.9.2 (bare `skydeck`), 2.9.5 (`keys.ts`, `run.ts`)

**Files**
- Create: `src/cli/tui/keys.ts`, `src/cli/tui/run.ts`
- Modify: `src/cli/main.ts` — in `dispatch`, an empty `argv` runs `runInteractiveList(ctx)` when
  `ctx.io.isTTY.stdin && ctx.io.isTTY.stdout`, else the `ls` command with `[]` (loaded like any
  command); both go through the same error mapping as `command.run` (task 12); `--help` keeps
  printing the usage
- Modify: `test/cli/main.test.ts` — delete the test "bare skydeck prints the usage and exits 0
  until the interactive list exists" (it uses `testContext()` without `t`, which cannot open a
  deck); the routing is tested in `test/cli/main-routing.test.ts`
- Test: `test/cli/tui/keys.test.ts`, `test/cli/tui/run.test.ts`, `test/cli/main-routing.test.ts`

**Exported API**

```ts
// tui/keys.ts
export function decodeKeys(chunk: string): string[];
// tui/run.ts
/** Opens the deck (withDeck, refresh: true) and runs the list until quit or a --here resume; returns the exit code. */
export function runInteractiveList(ctx: Context): Promise<number>;
```

**Behaviour fixed here.** On start: `loadRows` → `initModel` → write `\x1b[?1049h\x1b[?25l` and
the first frame (`\x1b[H\x1b[2J` + `render(...).join('\r\n')`), then start a background
`refreshPrs` (`{ force: false, refreshMinutes }`; deps include `env: ctx.platform.env`, 2.6); when it settles, `loadRows` and
`withRows(…, reorder false)` and repaint. For every chunk from `io.keys()`: `decodeKeys`, then
`reduce` per key, run the effect, repaint. Effects: `label`/`group` → `cleanLabel`/`cleanGroup`
(empty text clears) + `setLabel`/`setGroup`, `withMessage('saved')` or the error message;
`note` → leave the alternate screen, `editNote(ctx, deck, id)` (task 15), re-enter;
`done` → `markDone`/`markUndone`; `pr-add`/`pr-rm` → `attachManualPr`/`detachSessionPr`; any of
these then `loadRows` + `withRows(reorder false)`. `resume` → `prepareResumeById(deck, row.id)` (it
refreshes and loads the rows by itself: the guard works on fresh state, design 7.6); with a tab adapter
`launchPrepared(deck, p, 'tab')` and stay, message `opened <short> in a new tab` (or its returned
lines, warnings included, when there are any); without one, leave the screen and
`launchPrepared(deck, p, 'here')`, print its lines on stderr, then return its code. A
`ResumeRefusedError`, or a `RefError` (the session is gone), becomes the message. `refresh` → `refreshWithProgress(ctx, deck)`, then an explicit
`refreshPrs` (`{ force: true, refreshMinutes }`, deps with `env`; design 7.3: the refresh key asks about every pull request that the sessions the list lists have attached
and that is not merged or closed — `sessionIds`: the listed rows; a failure is saved on the pull request) + `loadRows` + `withRows(reorder true)`. `quit` or the end of `io.keys()` → write `\x1b[?25h\x1b[?1049l`,
call `return()` on the key iterator, return 0. Errors from an effect never leave the terminal in
the alternate screen.

**Test cases**

`tui/keys.test.ts`

```
'j'              → ['j']
'jk'             → ['j','k']
'\x1b[A\x1b[B'   → ['up','down']
'\x1bOA'         → ['up']
'\r' / '\n'      → ['enter']
'\x7f' / '\b'    → ['backspace']
'\x03'           → ['ctrl-c']
'\x1b'           → ['escape']
'\x1b[5~x'       → ['x']          (unknown sequence dropped)
'é'              → ['é']
```

`tui/run.test.ts` (`d = testDeck(t, { stdinTTY: true, stdoutTTY: true, keys: [...], env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }) })`; `await main([], d.ctx)`; S1 and S2 known)
0. `main-routing.test.ts` (`testDeck`): `main([], ctx)` with both TTY flags and keys `['q']` → the list (stdout starts with
   `'\x1b[?1049h'`); with `stdoutTTY` false → exactly what `main(['ls'], ctx)` prints, no escape sequences; with both TTY flags and
   `config.json` `{"colour":1}` → `EXIT.failure` and `skydeck: …colour…` on stderr (error mapping, no stack trace).
1. Keys `['q']` → exit 0; stdout starts with `'\x1b[?1049h'`, ends with `'\x1b[?1049l'`; contains a frame with both short ids.
2. `['d','q']` → `meta(<first row>).doneAtNs` set; the next frame no longer shows that row.
3. `['l','a','b','\r','q']` on a row without a label → label `'ab'`; a frame shows `saved`.
4. `['l','\x7f'×n,'-','x','\r','q']` → label unchanged; a frame shows the `UsageError` message.
5. `['p', …'https://github.com/o/r/pull/1', '\r', 'q']` → the PR is attached manually.
6. `['R']` on a dead session, terminal `here` → returns 0, the handoff file holds the resume command, the screen was restored.
7. `['R','q']` on a running session → a frame shows `is running`; exit 0.
8. `['n','q']` with a fake editor writing `'x'` → note `'x'`; stdout shows the alternate screen left and re-entered around the editor.
9. Background refresh: a PR with `okAtNs null` and a fake gh answering it `open` → a later frame shows the chip of the new level,
   and the row order of the first frame is unchanged.
10. `[() => { <write a start spool file for S3>; return 'r'; }, 'q']` → after `r` the file is ingested and S3 appears in a later frame.
    A PR read a minute ago (`okAtNs`, `triedAtNs` T0−1m, 5 minutes) is asked about again by `r` (one more `gh` call), not by the background refresh.

**Steps**
- [ ] Write both test files; replace the bare-`skydeck` test in `test/cli/main.test.ts`. `npm test` → fails.
- [ ] Implement `keys.ts`, `run.ts`, the routing in `dispatch`.
- [ ] `npm run format`; `npm run check` → pass. Run `bin/skydeck` by hand in a terminal against a temporary `SKYDECK_HOME`
      and `CLAUDE_CONFIG_DIR` (never the real ones) to see it paint and quit.
- [ ] Commit `Wire the interactive list to the terminal`; open the PR.

**Done when:** all cases pass; `skydeck` on a terminal opens the list, and the terminal is always
restored.

---

### Task 20: Documentation — `docs/install.md`, README, `docs/manual-checks.md`

**Depends on:** all · **Wave:** 8 · **Design:** 8 (`docs/install.md`), 15 (a change in behaviour updates the design)

**Files**
- Create: `docs/install.md`, `docs/manual-checks.md`
- Modify: `README.md`; `docs/design.md` only if a decision of 1a is still missing from it (each task records its own)

**Content (contract)**

`docs/install.md` — setting skydeck up on another machine: prerequisites (Linux or WSL2, Node.js
≥ 24.12, `git`, `gh` logged in for pull-request status, optionally WezTerm); clone; `npm ci`;
`bin/skydeck install` (what it asks, what it changes: the two hook entries, the links
`~/.local/bin/skydeck`, `<dataDir>/skydeck-hook`, `<dataDir>/node`, the backup beside
`settings.json`); `~/.local/bin` on `PATH`; `config.json` with every key of 9.1, its default and
an example; `SKYDECK_NODE`, `SKYDECK_HOME`, `CLAUDE_CONFIG_DIR`; WezTerm on WSL (`terminal`,
`wezterm.domain`, D15); `skydeck doctor`; updating (`git pull`, `npm ci`, nothing else);
`skydeck uninstall [--purge]`.

`README.md` — what skydeck is (two sentences from design 1), the command table of 7.5, links to
`docs/install.md`, `docs/design.md`, `docs/manual-checks.md`; keep the existing Development section.

`docs/manual-checks.md` — the short checklist run by hand, each item with the command and the
expected result:
1. **Install:** `bin/skydeck install` on a machine with an existing `settings.json` → the diff is
   shown, the backup exists, `skydeck doctor` exits 0.
2. **Session start:** start `claude` in a project → within a second `skydeck ls` shows it `waiting`;
   type a prompt → `working`.
3. **Clear:** `/clear` → the old session `not-running` without marks; the new one `continued`.
4. **Exit:** `/exit` → `not-running`, no `ended-unexpectedly`.
5. **Resume:** `skydeck resume <ref>` → the same transcript continues, the tab title shows the label;
   a second `skydeck resume <ref>` while it runs → exit 4.
6. **Terminal closed mid-turn:** type a prompt, close the tab while it is `working` → `ended-unexpectedly`
   and `was-working` (design 14: `SessionEnd` reason `other`, live file removed, the transcript's last
   turn record is `user`).
7. **Reboot drill:** open three sessions (one busy), run `wsl --shutdown` from Windows, reopen →
   `skydeck restore --dry-run` lists all three, the busy one `was working`; `skydeck restore`
   brings them back in tabs (or the first `--here` and the commands for the others).
8. **Uninstall:** `skydeck uninstall` → `settings.json` equals the backup again.

**Steps**
- [ ] Write the three documents; update the design for the accepted decisions.
- [ ] Run every command in `docs/install.md` on a clean `SKYDECK_HOME` to check it is exact.
- [ ] `npm run check` → pass. Commit `Document installation, the manual checks and the decisions`; open the PR.

**Done when:** a developer can set skydeck up on another machine from `docs/install.md` alone,
and `docs/design.md` no longer disagrees with the code.

---

## 4. Design coverage

| Design | Where |
|---|---|
| 1 Purpose, 2 Principles | 1 → all; 2 → 3, 17 (only the two hook entries); 3 → 3; 4 → 5, 6, 8 (fixtures, nothing kept); 5 → 2, 16; 6 → 15, 16, 18; 7 → 16, 18; 8 → 9; 9 → Contracts 2.1 |
| 5.1 The hook | 3 (script, settings entry), 17 (install writes it) |
| 5.2 Spool file | 3 (writes), 5 (reads), 2.10.1 |
| 5.3 Ingest | 5 (parsing, scripted rule, `storableArgv` applied, repeated key), 2 (field 22, cmdline, path flags), 8 (idempotence, bad files, links, order, retention of `bad/` and `.tmp` files) |
| 5.4 Reconcile | 8 |
| 5.5 Liveness | 6 |
| 5.6 Transcripts | 6 (reading, last turn role), 4 (`last_turn_role`), 8 (incremental scan, missing) |
| 6.1–6.3 Derived state, states, marks | 10 (`was-working` from a leftover busy live file or a last `user` turn record) |
| 7.1 Labels, groups, notes, done, first run | 11 (title, group), 10 (done visibility), 15 (commands), 17 (first-run offer) |
| 7.2 Which sessions are listed | 11 (incl. D27: not running and no transcript → not listed) |
| 7.3 Pull requests | 2 (keys), 9 (status, cache, chip, `unfetched`), 8 (automatic), 15 (manual, fetch on `pr add`, `pr refresh`), 14 (`--refresh`), 19 (background refresh) |
| 7.4 The list | 7 (sanitiser), 11 (order, filter, sanitising the rows), 13 (reduce/render), 19 (terminal) |
| 7.5 Commands, `<ref>`, exit codes, JSON | 0 (`EXIT`, one file per command), 12 (error mapping), 11 (`<ref>`), 14 (`ls`/`show`/JSON), 15–18, 19 (bare `skydeck`) |
| 7.6 Resume | 2 (command, D28 removed flags), 7 (where, the handoff exception), 16 (guard, lock, directory) |
| 7.7 New | 2, 16 |
| 7.8 Restore | 18 |
| 8 Install, uninstall, doctor | 17; `docs/install.md` in 20 |
| 9.1 Places, configuration | 1 |
| 9.2 Database | 4 |
| 10 Technology | 0 (scaffold), 1, 4 (D1) |
| 11 Code layout | Contracts 2.1 (import rules; D25 adds `github` to the sessions row, task 8), every task's file list |
| 12 Testing | each task's test cases; CI (`npm run check`, `shellcheck bin/skydeck*`) from task 0 |
| 13 Step 2 | not in step 1 |
| 14 Claude Code behaviour | `-n` with `--resume`: 2 (always passed); terminal close = `SessionEnd` `other` + live file removed: 5 (`END_DETAILS`), 10 (`was-working` from the transcript); `CLAUDE_CODE_ENTRYPOINT` `cli`/`sdk-cli`: 3, 5; no prompt, no transcript: 10 (sessions known from events only); D2 live-file types: 6 |
| 15 How changes are made | section 0 (one PR per task, CI green, reviews) |
| 16 Left out | nothing here builds it |
