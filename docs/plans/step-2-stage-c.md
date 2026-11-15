# skydeck step 2, stage C — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stage C of step 2 as specified in [`docs/design-step-2.md`](../design-step-2.md)
(section 19): the restore banner (S2 12.7), restore run by the window's server, `skydeck resume`
and `new` with `--window`, the configuration `"terminal": "window"` (and through it `restore` and
the interactive list's `R`), the server's `POST /resume`, `/new` and `/restore` (S2 8.3, 11.4),
`show`'s `(in the skydeck window)`, and manual check W16. It works without stages B, D and E.

**Architecture:** Every start of a session in the window — from a page, from a command over
`server.sock`, from a restore — goes through one module of the server, `src/window/launches.ts`,
which holds what stage A's actions did for resume and new (the window's "already open" rule, the
ended terminals closed first, a failing terminal taken as a timeout) on top of step 1's guard,
lock and command builders. A restore is step 1's `runRestore` with the window terminal and three
optional hooks, run by one coordinator in the server (`src/window/restorer.ts`), one at a time;
the banner is a pure function of the view model. The commands never start a server and prepare
nothing themselves when they send to it.

**Tech Stack:** as stage A — TypeScript on Node.js ≥ 24.12 through type stripping, `node:test`;
the page in plain JavaScript modules with JSDoc types and no build step; Playwright 1.60.0's
Chromium for the page suite; the stand-in program of stage A's contract 2.4 for every program a
test starts.

---

## 0. How to use this plan

Stage A's plan (`docs/plans/step-2-stage-a.md`) section 0 holds for every task here: the execution
model (one pull request per task, tasks of one wave in parallel in their own worktrees, two reviews
before the lead merges), the sources of truth (the design wins over this plan; "design 7.8" is
design.md, "S2 12.7" is design-step-2.md), what is fixed here and what is the implementer's, the
per-task workflow and the test rules (A31–A36: no real `claude`, no Windows program, the sandbox,
the two test platforms, the `SKYDECK_TEST_*` seams only in a marked sandbox). Its contracts
(section 2) stay in force where this plan does not change them; this plan's section 2 gives only
the changes.

**Task numbers** are 70–79 (stage D has 34–39, stage B numbers from 50), so that branch names,
pull-request titles and the lead's notes stay unique.

**CI stays as it is**: two Node legs, one job each. No task changes `.github/workflows/`,
`package.json` or a dependency.

**Added to the test rules.**
- A WSL restart is never caused: a test shows the server "an earlier boot" by sessions whose
  events carry a boot id that is not the machine's (stage A's `test/helpers/restore.ts` does it
  for the fake platform; task 74 adds the same for a server sandbox), or with
  `realTestPlatform({ bootId })` (A36). No test runs `wsl.exe`, and no test sleeps through a real
  `restoreStartTimeoutSeconds` of 120: the sandbox's `config.json` sets it to a few seconds.
- A restore in a test starts at most the sessions the test made, in the sandbox, with the
  stand-in as `claudeCommand`. A session that must fail gets a `claudeCommand` script of the
  sandbox that exits at once in a directory the test names; one that must wait gets a script that
  sleeps before it `exec`s the stand-in (link `sleep` into the sandbox's `bin` as stage A links
  `sh`).
- The commands of tasks 76 and 77 are run in the test process against a server of the sandbox:
  the fake serve of `test/fixtures/fake-serve` (task 76 teaches it the stage C routes) or a real
  test server (`startTestServer`). Edge is always the recording stub (A32).

**Known flakes** (not stage C's to fix): `LEFT-TO-YOU.md` section 4, "Tests" (the input-full page
case under load, `test/platform/real.test.ts:1005` and its streamed-answer case, the stand-in's
record order, `test/window/mapping.test.ts:623`). A run that fails only with one of them is run
once more, and the pull request names both runs.

## 1. Tasks and waves

Task 0 is `main` at 9c5cbfb (stage A complete) with this plan merged.

| # | Task | Depends on | Wave | Size (code + tests) | Shared files |
|---|---|---|---|---|---|
| 70 | Contracts; the control socket's stage C routes | 0 | 1 | ~600 | `src/window/protocol.ts`, `src/window/actions.ts` (two lines), `src/store/types.ts` (one line), their tests |
| 71 | Step 1 change: restore planning shared, `runRestore`'s hooks | 0 | 1 | ~450 | — |
| 78 | `show`: `(in the skydeck window)` | 0 | 1 | ~300 | `src/cli/commands/show.ts`, `src/cli/output.ts`, their tests |
| 72 | Launches: one way to start a session in the window | 70 | 2 | ~450 | `src/window/actions.ts`, its test |
| 73 | The restorer and the banner's view model | 70, 71 | 2 | ~600 | — (a new file in `src/window/view/`) |
| 75 | The banner on the page | 70 | 2 | ~600 | `web/app.js`, `web/index.html`, `test-page/helpers/shell.ts` (a new function) |
| 76 | The command line's side: the client, `--window` for `resume` and `new` | 70 | 2 | ~700 | — |
| 74 | The server: launches, restore and the routes wired | 72, 73 | 3 | ~650 | `src/window/server.ts` |
| 77 | `"terminal": "window"`: the configuration, `restore`, `R`, `doctor` | 74, 76 | 4 | ~600 | `src/platform/config.ts`, its test |
| 79 | Documentation of stage C | all | 5 | docs only | `docs/*`, `README.md` |

```
wave 1:  70  71  78
wave 2:  72  73  75  76
wave 3:  74
wave 4:  77
wave 5:  79
```

**Can start at once:** 71 (no dependency, no shared file). 70 and 78 depend on nothing but edit
files that stages B and D edit too: they start as soon as the lead has no other task on those
files in flight (70: stage D's 34 and B's contract task; 78: stage D's 35).

The critical path is 70 → 72 → 74 → 77 → 79. Task 76 builds against the fake serve, so it does not
wait for the server's routes (74); task 77 is the first to drive the commands end to end through
the real server, the real window terminal and the stand-in. Task 75 builds against a scripted
stand-in server, as stage A's page tasks did, so it does not wait for 73 and 74. Task 79 may start
its reading while 77 is built and merges last.

**Disjoint files in a wave.** Every new module is its own file with its own test file. The files
more than one task of this stage edits, and who edits them:

| File | Tasks (wave) |
|---|---|
| `src/window/protocol.ts`, `test/window/protocol.test.ts` | 70 (1) only |
| `src/window/actions.ts`, `test/window/actions.test.ts` | 70 (1: the interim case), 72 (2) |
| `src/window/control.ts`, `test/window/control.test.ts` | 70 (1) only |
| `src/window/client.ts` | 76 (2) only |
| `src/cli/commands/resume.ts`, `src/cli/commands/new.ts` and their tests | 76 (2: `--window`), 77 (4: the configuration) |
| `src/cli/window-requests.ts` | 76 (2) creates it; 77 (4) only calls it |
| `test/fixtures/fake-serve/fake-serve.ts` | 76 (2) only |
| `docs/design-step-2.md`, `docs/design.md` | each task records its decisions of 1a in the sections named there, disjoint within a wave; a conflict is rebased keeping both edits |
| `docs/install.md`, `docs/manual-checks.md`, `README.md` | 79 (5) only |

**Against stages B and D.** Each task that edits a shared file says, in its **If D was merged
first** line, what a rebase brings. Stage B's plan was not written when this one was; its tasks
are expected in `protocol.ts` (attention, `notify`), `src/store/` (migration 2, `attention_seq`),
`tick.ts`, `src/window/view/`, `web/app.js` and `web/list.js`. Stage C changes nothing in
`tick.ts`, `src/window/view/build.ts`, `sections.ts`, `web/list.js`, `web/keys.js`, `web/help.js`
or `web/cards.js`.

## 1a. Decisions this plan makes where the design is silent

Binding for the implementer, as stage A's A1–A38. The last column names the task that records the
decision in the design in its own pull request; `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| C1 | One module starts sessions in the window: `src/window/launches.ts` (2.3). Stage A's resume and new of `actions.ts` move into it unchanged — the window's refusal "this session is already open in the window" before the guard, `prepareResumeById`, the session's ended terminals closed before the new one opens, a throw of `open()` answered as a timeout, the lock given back after a throw before `open()` — and `act resume`, `act new`, `POST /resume`, `POST /new` and the restorer all use it. | The brief's rule, and S2 11.1: one implementation. Restore must not open a second terminal for a session the window is starting (the hole 11.1's rule closes). | — |
| C2 | `POST /resume` and `POST /new` answer `{ code, lines, sessionId }` (`LaunchAnswer`, 2.2): `lines` exactly as `skydeck resume` / `new` would print them on stderr — `launchPrepared`'s lines as they are, a refusal's message line by line with `skydeck: ` in front (as `failureText`) — and `code` the exit code the command would end with: 0, 1 (a failed launch, a busy store, an unexpected failure), 2 (`prepareNew`'s refusals), 3 (`RefError`), 4 (the guard, the lock, and the window's own "already open"). An unexpected failure is answered code 1 with `skydeck: the window's server could not start it (<kind>)` and logged by kind; a busy store with `skydeck: skydeck's database is busy; try again`. | S2 8.3 names `{ code, lines }`; the command prints them and exits with the code. A command must print something, so these are not 500. | 70 (8.3) |
| C3 | The bodies: `POST /resume` `{ sessionId }`; `POST /new` `{ dir, label, group, flags }` with `label` and `group` null when the option was not given and passed to `prepareNew` exactly as the command passes them (a blank `--label ' '` is refused, unlike the window's form, S2 12.6), `flags` the words after `--` as an array (no splitting); `POST /restore` `{ sessionIds, all }` with 1–1,000 distinct session ids. Strings well formed; no NUL in `dir` or a flag; `dir` 4,096 bytes, `label` and `group` 1,024, at most 1,000 flags; the body's 64 KiB bounds the rest. An unknown or missing field is 400. | S2 8.3: fixed fields, no program, no argument list; a prompt after `--` is the user's and is passed on (design 7.7). | 70 (8.3) |
| C4 | While the server starts (its upgrade answers 503) the three routes answer 503 `{ error: 'starting' }`, and the client asks again every 500 ms within its answer time; once its stop has begun, 503 `{ error: 'stopping' }`, which the command reports (`the window's server is stopping; run skydeck window, or use --here`, exit 1). | Before its keepers are found the server does not know its terminals (S2 8.2.1's reason for 503): the "already open" rule could not see one. | 70 (8.3) |
| C5 | `POST /restore` answers 200 with JSON lines (2.2 `RestoreStreamLine`): `{ "line": … }` per report line, `{ "line": "waiting for <n> sessions" }` after 10 s without one (`1 session`), and last `{ "outcome": { code, started, timedOut, failed, notStarted } }`. A request that cannot run (a restore is already running, the boot id unreadable, the store busy) is the same stream: its line, then an outcome with code 1. `code`: 5 when the memory check or the server's stop ended the run, else 1 when any selected session failed, was not offered any more or timed out, else 0 (design 7.8's codes). | S2 8.3 and 11.4: a stream of lines, the outcome last, a line at least every 10 s. One reading path for the client. | 70 (8.3) |
| C6 | One restore runs at a time in the server, whoever asked (a page or a command). Another request meanwhile is refused with `a restore is already running; wait until it has finished`: `act restore` answers it as its result, `POST /restore` as its one line. `act restore` answers at once (`ok`, no lines) once the run has begun; every report line of every run, whoever asked, goes to every page as `notice restore-progress` (its text sanitised), and the run's last line is `restore finished: <n> started, <n> timed out, <n> failed, <n> not started` with the parts that are 0 left out. Heartbeats go to the command line only. | S2 11.3 ("one restore runs at a time"), 12.7 ("the banner reports each line of the run"), 8.2.3's `restore-progress`. A result that waited for the whole run (minutes) would be lost by a page that reconnects meanwhile. | 73 (11.3, 12.7) |
| C7 | The restore's set is taken on freshly refreshed rows at the moment it starts (`refresh`, then `restorePlan`, 2.3), design 7.8's default set for the banner and `all` as asked over `server.sock`; the selected ids are kept in the set's order, and an id not in the set is reported `failed <short>: no longer offered for restore` before the run. Each terminal's first size is the area the page that had focus last reported, else 120 × 40, read when that terminal is opened (S2 8.2.6). The server's configuration (`restoreBatch`, `restoreMinFreeMb`, `restoreStartTimeoutSeconds`, `claudeCommand`) is the one it read at its start. | S2 11.4 and 8.2.6 say it; the configuration is the server's like every launch it makes (S2 5.2). | 73 (11.4) |
| C8 | `runRestore` gains three optional hooks and the outcome of each report line (2.3, `RestoreHooks`): `refuse` before the guard (the window's "already open"), `gone` at every look of the wait — a session whose window terminals have all ended, were lost, were not started or were closed before restore saw its start is reported `failed <short>: <reason>` at once and restore's own lock (its last renewed value) is given back —, and `signal`, with which the server's stop ends the run at its next step (`stopped: the window's server is stopping`, the rest `not started`). The command passes none and nothing changes for it. | S2 11.1's rule must hold for restore; a window terminal that ended is known to the server, where a tab is not, so waiting the full `restoreStartTimeoutSeconds` and keeping a renewed lock nobody gives back (S2 7.8's known limit) would only make the user wait; the server's stop must not leave a restore writing into a closed store. Question 1. | 71 (4.4, 7.8, 11.1, 11.3) |
| C9 | The banner is the view model's (`bannerPayload`, 2.3): null when design 7.8's default set is empty and no restore runs; otherwise its payload with `shown` false once the user said "Not now" for its earlier boot (the page then shows nothing; stage E's switcher still finds the offer) and `running` while any restore runs. `dismiss-restore` names the earlier boot whose sessions the banner offers (`banner.bootId`) and stores it in `kv` `window_restore_dismissed` only when it is the banner's current one (else `this offer to restore is no longer shown`, nothing stored). The server computes it from the tick's rows, again only when the rows array, the dismissal or `running` changed (one read of the events each time). | S2 12.7 and 10.2: "the user has not dismissed it for that boot", and the switcher's offer after "Not now". The page decides no rule (S2 4.3). | 70 (8.2.3), 73 (12.7, 10.2) |
| C10 | The page keeps the report lines it receives (`restore-progress`) under the banner, as text, at most the last 200; a line that comes after a run's last line (`restore finished: …` or `stopped: …`) starts a new report. After the last line the report has a × that removes it; the banner itself goes when the view model says so. A page that connects during a run sees `running` and the lines from then on (a named limit). The banner's controls take no keyboard on a mouse click (stage A's rule for the page's chrome); nothing in stage C adds a key. | S2 12.7 shows the lines; nothing in 12.9 is a key for restore (the switcher is stage E). | 75 (12.7) |
| C11 | `--window` and `"terminal": "window"` find the server as `skydeck window` does (`findServer`) and never start, restart or signal one. A server of this checkout is used whatever its build (the window's own Resume runs on that build too); none, one that does not answer, one that is starting past the ping wait, and one of another checkout are refused with the lines of 2.5, exit 1; one that answers the route with 404 (`route` kind: a build before stage C) with `the window's server is older than this command and cannot start sessions for it; run skydeck window to restart it, or use --here`. No answer within 30 s (`answerMs`): 11.4's line, exit 1, no command printed. None of these is refused under `CLAUDECODE` (no server is started). | S2 11.4 leaves the other states open; the server's environment becomes every session's, so only `skydeck window` may start or restart one (S2 5.2). Question 3. | 76 (11.4) |
| C12 | After an answer from the server — whatever its code — `resume` and `new` start a window when no page is connected, with stage A's code of `skydeck window` (the launching lock, a token, Edge, the wait, the token given up), moved unchanged into `src/cli/window-open.ts`. A window that cannot be opened is one line on stderr, `skydeck: the window could not be opened: <reason>; run skydeck window`, and the exit code stays the answer's. `restore` and the interactive list start no window. | S2 11.4 says it for `resume` and `new` only, and "nothing else in the list changes" (4.4). The session did start; the line says how to see it. Question 2. | 76 (11.4) |
| C13 | Which way a command goes (`whereFor`, 2.4): with `"terminal": "window"`, no option, `--tab` and `--window` go to the window and `--here` stays here; with `here` or `wezterm`, only `--window` goes to the window. `--here`, `--tab` and `--window` exclude each other (usage error, exit 2). The interactive list's `R` with `"terminal": "window"` sends `POST /resume` and shows its outcome as a tab launch's today (`opened <short> in the window`; a failure's lines printed when the list ends). | S2 11.4, 4.4; a user who never sets the key sees only the new option. | 77 (11.4, 16.4) |
| C14 | `restore` with `"terminal": "window"` (and without `--dry-run`): `windowServer` first, so that "the window is not running" comes before the list and the prompt; then its own refresh, plan and prompt (design 7.8, unchanged), then `POST /restore` with the chosen ids and `--all`; each line printed on stdout as it arrives, heartbeats too; 30 s without a line: `the window's server stopped answering; run skydeck to see what started`, exit 1; the exit code is the outcome's; with code 5, `skydeck: restore stopped before it finished; see above` on stderr. | S2 11.4. | 77 (11.4) |
| C15 | `show` adds ` (in the skydeck window)` to a holder line when the holder is a keeper's program or descends from it — up to 8 parents below the program, so 9 below the keeper — and that keeper's `.pid` line is alive by design 5.5's rule; the walk is mapping's (exported, 2.3). No runtime directory, no keeper line, no boot id: no mark; `show` creates nothing and connects to nothing. `show --json` is unchanged. | S2 11.4 ("a holder that descends from a keeper (7.5's rule)"); `show` must not depend on a running server. Question 5. | 78 (11.4) |
| C16 | `src/cli/` may import `src/window/` also for `resume`, `new`, `restore`, `show` and the interactive list (stage A's 2.1 named `window`, `serve`, `doctor`, `uninstall`). | They talk to the server or read its files. | — |
| C17 | `SKYDECK_TEST_WINDOW_TIMES` (A31) gains `answerMs` (30 s: the wait for an answer to `POST /resume` and `/new`, and the silence that ends a `POST /restore`), honoured only with `SKYDECK_TEST_NO_WINDOWS=1`. The restorer's heartbeat interval is an option of `createRestorer` (10 s by default), set only by tests. | A31's rule: no test waits 30 s. | — |
| C18 | The times the banner shows are the page's (`web/banner-text.js`): `today at 18:02`, `yesterday at 18:02`, `on 12 Nov at 18:02`, `on 12 Nov 2025 at 18:02` (a year other than this one), in the page's time zone, 24-hour. | S2 12.7's "yesterday at 18:02"; the server sends nanoseconds (S2 8.2.3). | — |

## 2. Contracts

Every name below must exist with exactly this signature; stage A's contracts (its section 2) hold
where these do not change them. `Size` is `{ cols: number; rows: number }`.

### 2.1 Conventions

- Stage A's 2.1 holds: the import rules (C16 widens what `src/cli/` may import), only
  `src/platform/real.ts` opens a socket or starts a program, foreign input is parsed by validators
  that never throw, times in messages are nanoseconds as decimal strings.
- Step 1's functions are called, never copied: `prepareResumeById`, `prepareNew`,
  `launchPrepared`, `launchSpec`, `openSafely`, `runRestore`, `planRestore`, `releaseLock`,
  `refresh`, `loadRows`, and stage A's `findServer`, `controlClient`, `listKeeperLines`,
  `windowTerminal`.
- Every text a user or a program wrote — a title, a label, a directory, a flag, a report line, a
  refusal that quotes one — reaches the DOM through `textContent` (never `innerHTML`, never an
  element built from it), reaches a terminal only after the sanitiser (the command line sanitises
  every line it prints from the server again: the server may be of another build), and never
  reaches a log: logs carry kinds and ids only (S2 2, 5.2).

### 2.2 Messages: `src/window/protocol.ts` (task 70)

```ts
// Stage C's additions. Stage A's types stay as they are but where shown.
export type ActMessage =
  | /* stage A's: resume, new, close-terminal, open-link (and stage D's kinds) */
  | { t: 'act'; id: number; kind: 'restore'; sessionIds: string[] }
  | { t: 'act'; id: number; kind: 'dismiss-restore'; bootId: string };

/** One session the banner offers (design 7.8's entry). */
export interface BannerEntryPayload {
  sessionId: string;
  shortId: string;
  title: string;
  /** null: no exit recorded. */
  endedAtNs: NsText | null;
  wasWorking: boolean;
  preselected: boolean;
}
/** S2 12.7, made by bannerPayload (2.3). */
export interface BannerPayload {
  /** The latest earlier boot (design 7.8) whose sessions are offered: what `dismiss-restore`
   *  names. null only while a restore runs and nothing is offered. */
  bootId: string | null;
  /** That boot's last event: "last activity" (S2 11.1). null with `bootId`. */
  lastActivityNs: NsText | null;
  /** The default set, in list order; [] while a restore runs and nothing is left to offer. */
  entries: BannerEntryPayload[];
  /** The view model's decision (C9): false after "Not now" for this boot; the page shows nothing. */
  shown: boolean;
  /** A restore runs in the server, from any page or command: nothing more can be started. */
  running: boolean;
}
// ListMessage.banner: BannerPayload | null            (stage A: null)
// NoticeMessage.kind gains 'restore-progress'          (term null; text one report line, sanitised)

// server.sock (S2 8.3), stage C
export interface NewRequest { dir: string; label: string | null; group: string | null; flags: string[] }
export interface RestoreRequest { sessionIds: string[]; all: boolean }
export type ControlRequest =
  | /* stage A's routes */
  | ({ route: 'resume'; sessionId: string })
  | ({ route: 'new' } & NewRequest)
  | ({ route: 'restore' } & RestoreRequest);
/** POST /resume and POST /new (C2): the exit code and the lines the command prints on stderr,
 *  each as printed (`skydeck: …`); `sessionId`: the session it started, null when none. */
export interface LaunchAnswer { code: number; lines: string[]; sessionId: string | null }
export interface RestoreOutcomeLine { code: 0 | 1 | 5; started: number; timedOut: number; failed: number; notStarted: number }
/** POST /restore (C5): one JSON object per line, the outcome last. */
export type RestoreStreamLine = { line: string } | { outcome: RestoreOutcomeLine };
```

Limits `parsePageMessage` applies (stage A's rules for the rest): `restore.sessionIds` an array of
1–1,000 distinct ids each passing `isSessionId`; `dismiss-restore.bootId` a lowercase UUID
(`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`, the form of
`/proc/sys/kernel/random/boot_id`). `parseControlRequest` takes `POST /resume`, `POST /new` and
`POST /restore` with C3's bodies and limits; a kind starting with `route` stays "no such route"
and one starting with `body` a bad body.

### 2.3 Server interfaces

```ts
// src/sessions/restore.ts — task 71
export interface EarlierBoot { bootId: string; lastEventNs: Ns }
/** Design 7.8's latest earlier boot: of the boots other than `currentBootId` with a `start` or
 *  `observed` event, the one whose last event is the latest; `scripted` and `scripted-end` count
 *  for neither. null when there is none. planRestore uses it. */
export function latestEarlierBoot(events: readonly EventRow[], currentBootId: string | null): EarlierBoot | null;
export interface RestorePlan { entries: RestoreEntry[]; earlier: EarlierBoot | null }
/** The command's private plan() moved here (S2 11.1): `rows` (default loadRows(deck)) in list
 *  order (`ls --all`: buildList with showAll, flatRows), the boot id the rows were derived with —
 *  a SkydeckError with the command's message when it is null —, planRestore and the earlier boot.
 *  Refreshes nothing; callers refresh first. No rows: no entries, `earlier` null. */
export function restorePlan(deck: Deck, all: boolean, rows?: readonly ListRow[]): RestorePlan;
export interface RestoreHooks {
  /** Before prepareResumeById: a reason this session must not be resumed at all; reported
   *  `failed <short>: <reason>`, nothing taken, nothing opened. */
  refuse?(sessionId: string): string | null;
  /** At every look of the wait, after the start check: a reason the session can no longer start
   *  from this restore; reported `failed <short>: <reason>` at once, its lock released with the
   *  value restore wrote last, and no longer waited for. */
  gone?(sessionId: string): string | null;
  /** Once aborted: no further entry is prepared or opened, the wait ends at its next look, and the
   *  sessions not opened yet are reported `not started <short> <title>` after one line
   *  `stopped: <String(signal.reason)>`; outcome.stopped is true. */
  signal?: AbortSignal;
}
export type ReportOutcome = { sessionId: string; kind: 'started' | 'timed-out' | 'failed' | 'not-started' | 'handed-off' | 'printed' };
// runRestore's deps become: { deck; terminal; report: (line: string, outcome?: ReportOutcome) => void } & RestoreHooks
// (every line that ends a session's part carries its outcome; header and warning lines none).
// RestoreOutcome gains   stopped: boolean
```

```ts
// src/window/launches.ts — task 72
export interface LaunchesDeps {
  deck: Deck;
  hub: TerminalHub;
  /** As stage A's ActionDeps.terminalFor: it only builds the object, nothing is spawned before open(). */
  terminalFor(size: Size): Terminal;
  log: (line: string) => void;
}
export interface Launched {
  /** C2's codes: 0 started; a SkydeckError's exitCode; 4 for "already open"; launchPrepared's code. */
  code: number;
  /** launchPrepared's lines (each `skydeck: …`) after a launch; a refusal's message lines, no
   *  prefix. Sanitised. */
  lines: string[];
  /** Nothing was prepared or started: the window's refusal, the guard, the lock, RefError, a
   *  usage error. */
  refused: boolean;
  /** The session started; null unless code is 0. */
  sessionId: string | null;
}
export interface Launches {
  resume(sessionId: string, size: Size): Promise<Launched>;
  newSession(request: NewRequest, size: Size): Promise<Launched>;
  /** S2 11.1: "this session is already open in the window" while the hub lists a terminal of the
   *  session (`sessionId ?? expectedSessionId`) whose state is in MAY_START; else null. */
  refusal(sessionId: string): string | null;
  /** C8: null while a terminal of the session may still run; else why it cannot start any more —
   *  `not started: <reason>` (an exit with notStarted), `its terminal's keeper ended` (lost),
   *  `claude ended before the session started (status <n>)` / `(signal <n>)`, `its terminal was
   *  closed` (none listed). */
  gone(sessionId: string): string | null;
  /** The terminal restore opens with (size read once, when built): its open(spec) closes the
   *  spec's session's terminals that are over, then opens; a throw is a timeout, as for resume. */
  restoreTerminal(size: Size): Terminal;
}
/** Throws only what is not a refusal: a busy store (isBusy) and unexpected errors; callers map them. */
export function createLaunches(deps: LaunchesDeps): Launches;

// src/window/actions.ts — task 72: ActionDeps gains (optional: absent, the kind answers
// "skydeck cannot do that action")
  restore?(sessionIds: readonly string[]): { ok: true } | { ok: false; error: string };
  dismissRestore?(bootId: string): { ok: true } | { ok: false; error: string };
```

```ts
// src/window/view/banner.ts — task 73; pure
/** C9 over the plan of the tick's rows (null when it could not be made), the stored dismissal and
 *  whether a restore runs. */
export function bannerPayload(input: { plan: RestorePlan | null; dismissedBootId: string | null; running: boolean }): BannerPayload | null;

// src/window/restorer.ts — task 73
export interface RestorerDeps {
  deck: Deck;
  /** Launches.restoreTerminal, .refusal, .gone (task 72; task 74 passes them). */
  terminalFor(size: Size): Terminal;
  refuse(sessionId: string): string | null;
  gone(sessionId: string): string | null;
  /** C7: the first size of a terminal it opens, read when it opens it. */
  size(): Size;
  /** One report line to every page (notice restore-progress). */
  progress(text: string): void;
  /** The banner may have changed (a run began or ended, a dismissal): the lists again. */
  changed(): void;
  log: (line: string) => void;
  /** C17: default 10_000. */
  heartbeatMs?: number;
}
export interface Restorer {
  /** C6, C7: refuses while one runs (or after stop()); otherwise refresh, restorePlan(all), the ids
   *  filtered, runRestore with the hooks and its signal — and returns at once. `write` gets every
   *  line, the heartbeats, and the outcome last; `done` resolves when the run is over. */
  start(request: RestoreRequest, write?: (line: RestoreStreamLine) => void):
    { ok: true; done: Promise<void> } | { ok: false; error: string };
  /** C9. */
  dismiss(bootId: string): { ok: true } | { ok: false; error: string };
  /** The view model's banner for the tick's rows (cached, C9). A store that fails while it is made
   *  keeps the previous one (one log line by kind). */
  banner(rows: readonly ListRow[]): BannerPayload | null;
  /** Aborts a running restore with the reason `the window's server is stopping`, resolves once it
   *  is over; nothing starts afterwards. */
  stop(): Promise<void>;
}
export function createRestorer(deps: RestorerDeps): Restorer;
```

```ts
// src/window/control.ts — task 70
export interface ControlLaunch {
  resume(sessionId: string): Promise<LaunchAnswer>;
  newSession(request: NewRequest): Promise<LaunchAnswer>;
  /** Calls `write` for each line, the outcome last; the answer ends when it resolves. */
  restore(request: RestoreRequest, write: (line: RestoreStreamLine) => void): Promise<void>;
}
// ControlDeps gains
  /** Absent: the stage C routes answer 404 { error: 'route: unknown' } — a server before stage C,
   *  as the command line sees it (the fake serve's default). */
  launch?: ControlLaunch;
  /** C4: 'starting' or 'stopping' while the routes answer 503 { error }; null when they act. */
  launchState?: () => 'starting' | 'stopping' | null;

// src/window/mapping.ts — task 78: the walk stage A keeps private, exported
/** S2 7.5's walk (stage A's placeOf, renamed), with the number of parents it may climb. */
export function holderPlace(holder: Holder, programs: ReadonlyMap<number, { procStart: number; termId: string }>, proc: Proc, maxSteps?: number): { termId: string; steps: number } | 'outside' | 'gone' | 'unknown';
// src/window/in-window.ts — task 78
/** C15: the pids of `holders` that descend from a keeper alive by its .pid line in the runtime
 *  directory the store records (resolveRuntimeDir 'follow'). Creates nothing; [] on any doubt. */
export function holdersInWindow(deck: Deck, holders: readonly Holder[]): ReadonlySet<number>;
```

### 2.4 The command line (tasks 76, 77)

```ts
// src/window/client.ts — task 76: ControlClient gains
  /** POST /resume, waiting `answerMs` (30 s); 503 'starting' asked again every 500 ms within it.
   *  'unknown-route' for a 404 whose kind starts with `route`. Rejects with a SkydeckError: no
   *  answer in time (C11's line), 503 'stopping', an answer that cannot be read. */
  resume(sessionId: string, answerMs?: number): Promise<LaunchAnswer | 'unknown-route'>;
  newSession(request: NewRequest, answerMs?: number): Promise<LaunchAnswer | 'unknown-route'>;
  /** POST /restore: each `line` to onLine as it arrives; resolves with the outcome. Rejects with
   *  11.4's "stopped answering" line when `answerMs` pass without a line or the answer ends
   *  without an outcome. */
  restore(request: RestoreRequest, onLine: (line: string) => void, answerMs?: number): Promise<RestoreOutcomeLine | 'unknown-route'>;

// src/cli/window-open.ts — task 76: moved out of src/cli/commands/window.ts, behaviour unchanged
export interface WindowTimes extends Required<LifecycleTimes> { pageMs: number; reuseMs: number; launchingMs: number; reconnectMs: number; answerMs: number }
/** A31's SKYDECK_TEST_WINDOW_TIMES (only with SKYDECK_TEST_NO_WINDOWS=1) over the defaults; C17 adds answerMs. */
export function windowTimes(env: Env): WindowTimes;
/** S2 5.1 step 2: the window_launching lock, a token, Edge, the wait for its use, the token given
 *  up; throws a SkydeckError with 5.1's lines (stage A's `launch`). */
export function launchWindow(deck: Deck, client: ControlClient, ping: PingAnswer, newWindow: boolean, times: WindowTimes): Promise<void>;

// src/cli/window-requests.ts — task 76
export interface WindowServer { client: ControlClient; ping: PingAnswer }
/** C11: findServer; this checkout's server (any build) or a SkydeckError with 2.5's line. `here`
 *  false (restore, the interactive list) leaves ", or use --here" out of the lines. */
export function windowServer(deck: Deck, times: WindowTimes, here: boolean): Promise<WindowServer>;
/** The answer, or a SkydeckError (C11's older-server line for 'unknown-route'). Prints nothing. */
export function requestResume(server: WindowServer, sessionId: string, times: WindowTimes): Promise<LaunchAnswer>;
export function requestNew(server: WindowServer, request: NewRequest, times: WindowTimes): Promise<LaunchAnswer>;
/** resume / new for a command: windowServer, the request, every line on stderr (sanitised), C12's
 *  window; returns the answer's code (a code that is not 0–5 is 1). */
export function resumeInWindow(ctx: Context, deck: Deck, sessionId: string): Promise<number>;
export function newInWindow(ctx: Context, deck: Deck, request: NewRequest): Promise<number>;
/** C14's request: every line on stdout as it arrives; the outcome's code. */
export function restoreInWindow(ctx: Context, server: WindowServer, request: RestoreRequest, times: WindowTimes): Promise<number>;

// src/cli/launching.ts — task 77
/** C13. `flag` is the option given; the answer is where the command goes. */
export function whereFor(config: Config, flag: 'here' | 'tab' | 'window' | null): 'here' | 'tab' | 'window';
// launchWhere keeps its signature; with config.terminal 'window' it takes 'here' only (a RangeError
// otherwise: the window's launches go through the server). terminalFor keeps 'here' | 'wezterm'.
// src/platform/config.ts — task 77: Config.terminal: 'here' | 'wezterm' | 'window'
```

### 2.5 What the command line says, and the tests that hold the rules

Lines of the commands (each printed with `skydeck: `, exit 1 unless said):

| Case | Line |
|---|---|
| No server (none in `server.json`, no live holder of the lock) | `the window is not running; run skydeck window first, or use --here` |
| Alive, no answer within the ping wait | `the window's server (pid <n>) does not answer; skydeck window --restart stops it` (S2 5.1) |
| Starting, not done within the ping wait | S2 5.1's `the window's server (pid <n>) is starting and did not finish within 5 s; …` |
| Another checkout | `the window's server runs from <checkout>, not from this checkout; skydeck window --restart here replaces it, or use --here` |
| 404 with a `route` kind | C11's older-server line |
| 503 'stopping' | `the window's server is stopping; run skydeck window, or use --here` |
| No answer to `/resume` or `/new` in `answerMs` | `the window's server did not answer within 30 s; it may have started the session: run skydeck to see whether it runs` |
| `/restore` silent for `answerMs`, or ended without an outcome | `the window's server stopped answering; run skydeck to see what started` (S2 11.4) |
| Edge after the answer (C12) | `the window could not be opened: <reason>; run skydeck window` — the exit code stays the answer's |

For `restore` and the interactive list the lines end before `, or use --here`. No line prints a
command to run by hand: the command prepared nothing (S2 11.4).

The rules of the requests that start programs, and the test that holds each:

| Rule (S2 8.3, 11.1, 15.1, 15.5) | Test |
|---|---|
| Only the user's own processes reach the routes | stage A's `test/window/control.test.ts` "server.sock has mode 0o600, in the runtime directory of mode 0o700" (unchanged) |
| No request carries a program, an argument list or a path the server runs | 70: `protocol.test.ts` "the stage C routes refuse every field they do not define (argv, program, cwd, command, env)"; 74: `server-launch.test.ts` "a body with argv, program, cwd, command or env is 400 and no keeper is spawned" |
| The program is `claudeCommand`, the arguments `buildResumeCommand`'s or `buildNewCommand`'s | 74: "POST /resume runs buildResumeCommand's argv with claudeCommand in the session's directory"; "POST /new runs buildNewCommand's" |
| `new`'s directory and flags checked as `skydeck new` checks them | 74: "POST /new refuses what skydeck new refuses, with the same lines and code" |
| The guard on freshly refreshed rows, the boot-id refusal, the lock | 72: `launches.test.ts` "resume goes through prepareResumeById"; 74: "two POST /resume of one session at once start one keeper" |
| The window's own rule (already open) | 72: "resume and refusal(): already open while a terminal may still run"; 74 `server-restore.test.ts` "restore does not open a second terminal for a session the window is starting" |
| Every restored session through the guard and its lock on fresh rows; batches; memory | 71: `restore.test.ts` (step 1's cases, unchanged, and the hooks); 74: "act restore starts the banner's sessions, restoreBatch at a time" |
| Nothing a request carries reaches a log | 74: "server.log holds kinds only after hostile /new and /restore bodies" |
| Text shown as text | 75: `test-page/banner.test.ts` "a hostile title and report line are text"; 76: "the answer's lines are printed sanitised" |

## 3. Tasks

### Task 70: Contracts; the control socket's stage C routes

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 8.2.3 (`restore`, `dismiss-restore`, `banner`, `restore-progress`), 8.3 (`POST /resume`, `/new`, `/restore`), 10.2 (`window_restore_dismissed`) · **Contracts:** 2.2, 2.3 (`ControlLaunch`) · **Decisions:** C2, C3, C4, C5, C9 (the payload) · **Shared files:** `src/window/protocol.ts`, `src/window/actions.ts`, `src/store/types.ts`

**Goal.** Fix as code every message the other stage C tasks meet at, and the socket's side of the
three routes, so that the server (74) only supplies `ControlLaunch` and the command line (76)
talks to the real `controlHandler` from the start (the fake serve uses it).

**Files**
- Modify: `src/window/protocol.ts` (2.2: the types, the two `act` kinds in `ACTS`, the three
  routes in `ROUTES`); `src/window/control.ts` (`ControlDeps.launch`, `.launchState`; the routes:
  `resume` and `new` answer the `LaunchAnswer` as JSON, `restore` answers 200 with
  `Transfer-Encoding: chunked` and one JSON line per `write`, ended when the promise settles);
  `src/window/actions.ts` (the interim case: `restore` and `dismiss-restore` answer `skydeck cannot
  do that action`, nothing done, until task 72); `src/store/types.ts` (`KvKey` gains
  `'window_restore_dismissed'`)
- Test: `test/window/protocol.test.ts`, `test/window/control.test.ts`,
  `test/window/actions.test.ts` (one case)

**Behaviour.** The parser takes the two kinds and the three bodies with 2.2's and C3's limits.
`controlHandler`: without `launch` the three routes are 404 `{ error: 'route: unknown' }` as
today; with it, while `launchState()` is not null they are 503 `{ error }`; otherwise `resume` and
`new` answer what `launch` resolves with (200), and a rejection is 500 `{ error: 'failed' }` with
one log line by kind (`failureKind`); `restore` streams every `write` as a line, and a rejection
after the first line ends the answer without an outcome (the client says the server stopped
answering), one log line by kind. A refused body is logged by its kind, never by its text, as
stage A's routes.

**Tests** (platform: `testPlatform` for the parser; the real sockets of stage A's control tests)
- Protocol: each new kind and route accepted at its limits and refused one over (1,001 ids, a
  repeated id, a boot id in upper case, a `dir` of 4,097 bytes, a label of 1,025, 1,001 flags), with
  a NUL in `dir` or a flag, a lone surrogate, a wrong type, a missing field; "the stage C routes
  refuse every field they do not define (argv, program, cwd, command, env)"; `label` and `group`
  null accepted, absent refused.
- Control: stage A's "POST /resume, /new and /restore (stage C) are 404, and nothing is started"
  stays true for a handler without `launch` (renamed so); with a fake `launch`: each route calls it
  once with the parsed body and answers its value; 503 with `starting` and `stopping`, `launch`
  never called; `restore`'s answer read line by line arrives in order while the promise is still
  pending (the second line written 200 ms after the first is read before the first resolves); a
  `resume` that rejects is 500 and logged by kind; a hostile label in a refused body is not in the
  log.
- Actions: `act restore` and `act dismiss-restore` answer `ok: false` `skydeck cannot do that
  action`.

**Done when:** every stage C message parses as 2.2 says; `controlHandler` serves the three routes
for any `launch` it is given; `npm run check` passes.

**If D was merged first:** `ActMessage` and `ACTS` hold D's kinds (task 34) and `actions.ts` its
interim case for them; C's kinds and case go beside them. `RowPayload.chip`, `PrPayload` and
`SelectedPayload` are D's shapes; C touches none of them.

**Not in it:** acting on any of it (72–74), the client (76).

---

### Task 71: Step 1 change — restore planning shared, `runRestore`'s hooks

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 11.1 (restore planning), 11.3, 4.4, design 7.8 · **Contracts:** 2.3 (`latestEarlierBoot`, `restorePlan`, `RestoreHooks`, `ReportOutcome`) · **Decisions:** C8 · **Shared files:** —

**Goal.** S2 11.1's fourth change: one restore planning for the command and the server, which
also gives the earlier boot and its last event; and what the window needs of `runRestore`, with no
change for the command.

**Files**
- Modify: `src/sessions/restore.ts`; `src/cli/commands/restore.ts` (its private `plan()` replaced
  by `restorePlan(deck, all).entries`; nothing else changes)
- Test: `test/sessions/restore.test.ts`, `test/cli/commands/restore.test.ts`; `docs/design-step-2.md`
  (C8: 4.4's row for `src/sessions/restore.ts`, 7.8's known limit narrowed to an exit after the
  restore stopped waiting, 11.1, 11.3)

**Behaviour.** `latestEarlierBoot` is the part of `planRestore` that chooses the boot, taken out;
`planRestore` calls it and gives the same entries as before. `restorePlan` is the command's
`plan()` with the rows as a parameter. The hooks as 2.3 says: `refuse` is asked in `prepare()`
before `prepareResumeById` (so also for `runHere`, which the window never reaches); `gone` in
`awaitStarts` for each session still waited for, after `resumeStarted` was checked for it;
`signal` is looked at before each batch, before each entry is prepared, and after each look of the
wait. `report`'s second argument for every line that ends a session's part: `started`, `timed out`,
`failed`, `not started`, `resuming … in this terminal` (`handed-off`) and each printed command
(`printed`).

**Tests** (platform: `testPlatform` through `restoreDeck` and `fakeTabs` of `test/helpers/restore.ts`)
- `latestEarlierBoot`: BOOT_A's last event T0 with sessions in BOOT_A and BOOT_C; a scripted run
  later in BOOT_C does not make it the latest; only the current boot → null; no events → null.
- `restorePlan`: the same entries as `planRestore` over `listOrder`; `earlier` is BOOT_A and T0;
  rows without a boot id → the command's message; no rows → no entries.
- Every existing case of both files passes unchanged: the command's output is byte for byte the
  same.
- `refuse` returning a reason for the second of three sessions → `failed <short>: <reason>`, no
  lock for it, its tab never opened, the others started; returning null → nothing changes.
- `gone` for a session after its tab opened → at the next look `failed <short>: <reason>`, its lock
  (renewed meanwhile) gone from the store, the batch's other sessions still waited for and started;
  `gone` is not asked for a session whose start was seen at the same look.
- `signal` aborted before the run → nothing opened, every entry `not started`, the `stopped:` line,
  `stopped` true; aborted while the second batch waits → that wait ends at its next look, the
  third batch is not started; the sessions waited for keep their last lock (they may still start).
- `report`'s outcome: each kind once for a run that has all of them; header and warning lines
  carry none.

**Done when:** the command and the server can plan a restore with one function, `runRestore` takes
the three hooks, and the command behaves as before; `npm run check` passes.

**Not in it:** the server's use of them (73, 74).

---

### Task 78: `show`: `(in the skydeck window)`

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 11.4 (`show`), 7.5 (the descendant rule), 4.2 (the runtime directory, `.pid` lines) · **Contracts:** 2.3 (`holderPlace`, `holdersInWindow`) · **Decisions:** C15, C16 · **Shared files:** `src/cli/commands/show.ts`, `src/cli/output.ts`

**Goal.** A user who looks at a session with `show` sees whether its process runs in the window.

**Files**
- Create: `src/window/in-window.ts`
- Modify: `src/window/mapping.ts` (`placeOf` exported as `holderPlace` with `maxSteps`, default
  stage A's 8; `mapTerminals` unchanged); `src/cli/output.ts` (`formatShow` gains a last
  parameter `inWindow: ReadonlySet<number> = new Set()`); `src/cli/commands/show.ts`
- Test: `test/window/in-window.test.ts`, `test/cli/output.test.ts`, `test/cli/commands/show.test.ts`;
  `docs/design-step-2.md` (11.4: "9 below the keeper", `--json` unchanged)

**Behaviour.** `holdersInWindow`: the runtime directory by `resolveRuntimeDir(deck, 'follow')`,
the keepers by `listKeeperLines` (state `alive` only), then for each holder `holderPlace(holder,
keepers, proc, 9)` with the keepers' pids and process starts as the programs; a place with `steps`
of at least 1 is in the window. A read that throws, a line that is `unknown`, a holder of another
boot: not in the window. `formatShow` writes `holder: pid <n> since <time>[ (scripted run)][ (in
the skydeck window)]`.

**Tests** (platform: `realTestPlatform` for `in-window.test.ts`: a keeper of the keeper sandbox,
`test/helpers/keeper.ts`, started by the test with the stand-in; `testPlatform` for `output.test.ts`)
- The stand-in started by a keeper → its pid in the set; with `standinCommand(s, { wrapper: true })`
  (the stand-in a child of a `sh`) → in it; a stand-in the test started itself, outside any keeper
  → not; the keeper's `.pid` line replaced by one of a dead process start → not; no runtime
  directory → empty and nothing created (the sandbox's `run` still absent); no boot id → empty.
- `formatShow` with a holder in the set → the mark after `(scripted run)` when both; without the
  set → stage A's text exactly.
- `show`: a session held from a keeper prints the mark; `show --json` is the same as before for it.
- Every existing case of `mapping.test.ts` passes unchanged.

**Done when:** `show` marks a holder in the window and nothing else of `show` changes; `npm run
check` passes.

**If D was merged first:** `formatShow` has D's parameter `ticket` (task 35) and prints `ticket:`
after `group:`; `inWindow` goes after `ticket`. `show.ts` passes D's ticket address first.

**Not in it:** the mark in `ls` or the interactive list (S2 11.4 names `show` only).

---

### Task 72: Launches — one way to start a session in the window

**Depends on:** 70 · **Wave:** 2 · **Design:** S2 11.1, 11.2, 11.3 (resume, new, a terminal that fails unexpectedly), 7.8 (an ended terminal dropped when its session runs again) · **Contracts:** 2.3 (`createLaunches`, `ActionDeps.restore`, `.dismissRestore`) · **Decisions:** C1, C2 · **Shared files:** `src/window/actions.ts`

**Goal.** Take stage A's resume and new out of `actions.ts` into `src/window/launches.ts`
unchanged, add what restore and the routes need of it (`refusal`, `gone`, `restoreTerminal`, the
exit codes), and give `act restore` and `act dismiss-restore` their final cases.

**Files**
- Create: `src/window/launches.ts`, `test/window/launches.test.ts`
- Modify: `src/window/actions.ts` (the `resume` and `new` cases call `createLaunches` built from
  its own deps and map `Launched` to a result exactly as `launched()` and `refusedBy()` do today;
  `guarded`, `terminalsOf`, `giveBackLock` and `closeEnded` move to `launches.ts`; `restore` →
  `deps.restore(sessionIds)`, `dismiss-restore` → `deps.dismissRestore(bootId)`, each answering
  `ok` with no lines or `ok: false` with its error; absent → `skydeck cannot do that action`)
- Test: `test/window/actions.test.ts`

**Behaviour.** `resume`: the window's refusal (`refused`, code 4), then `prepareResumeById` (a
SkydeckError → `refused`, its `exitCode`, its message lines), `closeEnded`, `launchPrepared` with
the guarded terminal (`refused` false, its code and lines, `sessionId` when 0); a throw after the
lock and before `open()` gives the lock back and is thrown on. `newSession`: `prepareNew` with the
request as it is (no `orNone`: that stays in `actions.ts` for the form, which passes `null` for a
blank field), then `launchPrepared`. A busy store and unexpected errors are thrown to the caller,
which answers them (actions: stage A's texts; the server: C2's). `gone` reads the hub's terminals
of the session as `refusal` does.

**Tests** (platform: `testPlatform` through `testDeck`; a fake terminal and a fake hub as stage A's
actions tests)
- Every case of `test/window/actions.test.ts` passes unchanged (the refactor's check).
- `launches.test.ts`: "resume goes through prepareResumeById" — a running session → code 4 with the
  guard's line; a held lock → code 4 `is being resumed`; no boot id → code 4; an unknown id → code
  3; started → 0, `sessionId`, the spec's argv `buildResumeCommand`'s; the terminal failing → 1
  with `launchPrepared`'s lines. "resume and refusal(): already open while a terminal may still
  run" for each state of `MAY_START`, and not for ended, lost, not started. `newSession` with a
  relative directory → 2, a flag `-r x` → 2 with `skydeck new`'s text, `label: ' '` → 2 (the
  command's refusal), started → 0 and the new id. `gone` gives each reason of 2.3 and null while
  starting or running. `restoreTerminal`: an ended terminal of the spec's session closed before
  `open`, a running one of another session kept; `open` throwing → `{ ok: false, timedOut: true }`
  and one log line by kind.
- Actions: `restore` and `dismiss-restore` call their deps with the fields and answer what they
  return; without the deps → `skydeck cannot do that action`.

**Done when:** the window starts sessions through `launches.ts` only, stage A's behaviour is
unchanged, and the two new kinds reach their deps; `npm run check` passes.

**If D was merged first:** `actions.ts` has D's cases (task 36) and `ActionDeps.changed`,
`.fetchPrs`, `.refreshPrs`; this task changes only the `resume` and `new` cases, the helpers above
`run()` and its own two cases, and adds two optional deps beside D's.

**Not in it:** the restorer (73), wiring anything into the server (74).

---

### Task 73: The restorer and the banner's view model

**Depends on:** 70, 71 · **Wave:** 2 · **Design:** S2 11.3 (restore), 11.4 (`POST /restore`), 12.7, 10.1 ("a running restore"), 10.2 (`window_restore_dismissed`), design 7.8 · **Contracts:** 2.3 (`bannerPayload`, `createRestorer`) · **Decisions:** C5, C6, C7, C9, C17 · **Shared files:** — (`src/window/view/banner.ts` is a new file)

**Goal.** The one coordinator of restores in the server, and the rule that decides the banner,
both tested without a server: the window terminal, the refusal and `gone` are injected.

**Files**
- Create: `src/window/restorer.ts`, `src/window/view/banner.ts`, `test/window/restorer.test.ts`,
  `test/window/view/banner.test.ts`
- Modify: `docs/design-step-2.md` (C6: 11.3 and 12.7; C9: 12.7 and 10.2)

**Behaviour.** `start`: refused while a run is going or after `stop()`; otherwise, synchronously,
`refresh(deck)` and `restorePlan(deck, request.all)` (a SkydeckError or a busy store → `ok: false`
with its text, or for `write` that line and an outcome with code 1), the ids filtered (C7), then
the run begins: `deps.changed()`, `runRestore` with `terminal: deps.terminalFor(deps.size())`
built for each opening (wrap it: `open(spec)` builds the terminal of the size of that moment and
opens), `refuse`, `gone`, the signal, and `report` sending each line to `deps.progress` and
`write`. A heartbeat timer (`deck.platform.clock.after`) writes `waiting for <n> sessions` to
`write` only, `n` the sessions without an outcome yet, re-armed by every line. The run's end: the
`restore finished: …` line (or after the signal the `stopped:` lines of 71), the outcome to `write`
(C5's code), `deps.changed()`. A rejection of `runRestore` (a busy store in a refresh, anything
unexpected) is the line `restore stopped unexpectedly (<kind>); the sessions it opened go on
starting: run skydeck to see which`, an outcome with code 1, and one log line by kind. `banner`:
`restorePlan(deck, false, rows)` and `kv window_restore_dismissed` read when the rows array, the
stored dismissal or `running` changed since the last call, else the last payload; a failure keeps
the last payload. `dismiss`: C9; a stored dismissal calls `deps.changed()`.

**Tests** (platform: `testPlatform` through `restoreDeck` of `test/helpers/restore.ts`; a fake
terminal that opens what the test says, a `gone` the test scripts)
- `bannerPayload`: no plan, or no entries and not running → null; entries → the payload in list
  order with `shortId`, title, `endedAtNs` null for no exit, `wasWorking`, preselection, `bootId`
  and `lastActivityNs` from `earlier`; `dismissedBootId` equal → `shown` false; another boot →
  shown; running with no entries → `{ bootId: null, entries: [], running: true, shown: true }`.
- A run of three over a batch of two: `progress` gets `started …` three times and `restore
  finished: 3 started`; `write` the same lines and `{ outcome: { code: 0, started: 3, … } }`; each
  terminal opened with the size `deps.size()` gave at that moment (it changes between the two
  batches); `changed()` at the start and at the end.
- An id not in the set → `failed <short>: no longer offered for restore` first, code 1; a session
  `refuse` names → its line, never opened; `gone` → `failed`, the run goes on, code 1.
- A second `start` while running → `a restore is already running; wait until it has finished`,
  nothing planned; after `done` → accepted.
- Heartbeat: 10 s (the fake clock) without a line → `waiting for 2 sessions` to `write`, not to
  `progress`; with `heartbeatMs` 1000 every second.
- `stop()` while it waits → the `stopped: the window's server is stopping` line, `not started`
  lines, code 5, `stop()` resolves after `done`; `start` afterwards refused.
- `restoreMinFreeMb` above the fake `/proc`'s memory → step 1's `stopped: only …` line, code 5.
- `dismiss(bootId)` of the banner's boot → stored, the next `banner(rows)` has `shown` false;
  another id → `this offer to restore is no longer shown`, nothing stored. `banner` called twice
  with the same rows reads the events once (a counting store wrapper).
- A title holding an escape sequence → no control character in any `progress` or `write` line.

**Done when:** a restore can be run, refused, watched, stopped and its banner decided by the
restorer alone; `npm run check` passes.

**Not in it:** the server (74), the page (75).

---

### Task 75: The banner on the page

**Depends on:** 70 · **Wave:** 2 · **Design:** S2 12.7, 12.9 (focus), 15.4 (text, not markup), 6.3 (the WSL-restarted notice it appears under) · **Contracts:** 2.2 (`BannerPayload`, `restore-progress`) · **Decisions:** C10, C18 · **Shared files:** `web/app.js`, `web/index.html`, `test-page/helpers/shell.ts`

**Goal.** At the top of the list, the banner the view model sends: the sessions with their
checkboxes, "Restore <n>", "Not now", the report of the run.

**Files**
- Create: `web/banner.js` (`createBanner(root, deps)` → `{ render(banner), progress(text) }`;
  `deps`: `act`, `say`), `web/banner-text.js` (no DOM: `bannerHeading(banner, nowMs)`,
  `activityTime(ns, nowMs)`, `entryText(entry)`, `restoreLabel(count)`), `web/banner.css`,
  `test/web/banner.test.ts`, `test-page/banner.test.ts`
- Modify: `web/index.html` (`<div class="banner" id="banner" hidden></div>` inside `#list-zone`
  before `#list`; the stylesheet), `web/app.js` (create it, `render()` calls `banner.render(
  state.list?.banner ?? null)`, a `notice` of kind `restore-progress` goes to `banner.progress`,
  `overLimit` knows the two kinds), `test-page/helpers/shell.ts` (a new function `bannerWorld`: a
  scripted stand-in server, as `actsWorld`, that sends the lists and notices the test gives and
  answers each `act` as told)
- Modify: `docs/design-step-2.md` (C10: 12.7)

**Behaviour.** Shown when the payload is not null and `shown` is true. The heading
`Before the restart (last activity <activityTime>) <n> sessions were open` (`1 session was open`);
one checkbox per entry, labelled `entryText` (`<short>  <title> · no exit recorded` or `· ended
<HH:MM>`, `· was working`), first ticked by `preselected`; the ticks stay across lists of the same
`bootId` (an entry that left is dropped, a new one takes its `preselected`) and start again for
another boot. "Restore <k>" (k the ticked count) sends `act restore` with the ticked ids in the
banner's order, disabled at 0 and while `running`; "Not now" sends `act dismiss-restore` with
`bootId`. While `running`: `A restore is running.` in place of the buttons, the checkboxes
disabled. A refused result is shown in the banner as its line. The report (C10) under it. The
banner's controls prevent their mousedown's default, so the keyboard stays with the list or the
terminal; Tab and Space work on them as the browser's own.

**Tests** (platform: `realTestPlatform` for the page through `bannerWorld`; `test/web` in node)
- `banner-text`: `activityTime` today, yesterday, earlier this year, another year, at 00:05 and
  23:59 (the page tests run in UTC); headings for 1 and 3; `entryText` for both ends and `was
  working`.
- `banner.test.ts` (page): a banner of three, two preselected → two ticked, `Restore 2`; a click
  unticks → `Restore 1`, the list keeps the keyboard; Restore → the world got `act restore` with
  the one id; Not now → `act dismiss-restore` with the boot id; a new list of the same boot keeps
  the ticks, of another boot resets them; `shown: false` or null → nothing shown; `running` →
  buttons gone, checkboxes disabled; progress notices shown in order, `restore finished: 3
  started` gives the ×, the × removes the report; a refusal `a restore is already running; …`
  shown; "a hostile title and report line are text": a title `<img src=x onerror=…>` and a line
  holding markup create no element (`querySelector('img')` null).
- Every existing page case passes (the banner hidden in their lists).

**Done when:** the page shows and acts on the banner the server sends, and shows the run's lines;
`npm run check` and `npm run test:page` pass.

**If D was merged first:** `index.html` has D's `#editor`, `#toast` and `edit.css` (task 37) and
`app.js` D's dialog with its modal rule; the banner's clicks are covered by D's scrim while a
dialog is shown, which needs nothing here. `scriptedList`'s rows have D's chip shape (task 34):
`bannerWorld` builds its lists with that helper.

**Not in it:** the server's side (73, 74); a key for restore (stage E's switcher).

---

### Task 76: The command line's side — the client, `--window` for `resume` and `new`

**Depends on:** 70 · **Wave:** 2 · **Design:** S2 11.4, 8.3, 5.1 (finding the server; step 2's window), design 7.5 (the commands' options) · **Contracts:** 2.4 (client, `window-open.ts`, `window-requests.ts`), 2.5 · **Decisions:** C11, C12, C16, C17 · **Shared files:** —

**Goal.** Everything the commands need to send to the server, built and tested against the fake
serve, and `--window` on `resume` and `new`.

**Files**
- Create: `src/cli/window-open.ts`, `src/cli/window-requests.ts`, `test/window/client-launch.test.ts`,
  `test/cli/window-requests.test.ts`
- Modify: `src/window/client.ts` (the three methods and their readers: an answer of another shape
  cannot be read); `src/cli/commands/window.ts` (imports `windowTimes` and `launchWindow` instead
  of its private `timesOf` and `launch`; nothing else changes); `src/cli/commands/resume.ts`,
  `src/cli/commands/new.ts` (`--window`; `whereFrom` refuses two of `--here`, `--tab`,
  `--window`; with `--window`, `resume` resolves `<ref>` as today and calls `resumeInWindow` with
  the id — no `prepareResumeById` here —, `new` calls `newInWindow` with `platform.cwd`, the label,
  the group and `parsed.rest`); `test/fixtures/fake-serve/fake-serve.ts` (C3's routes: without
  `FAKE_SERVE_LAUNCH` no `launch`, as today; `FAKE_SERVE_LAUNCH=answer:<LaunchAnswer JSON>`
  answers it to `/resume` and `/new`; `silent` never answers them; `FAKE_SERVE_RESTORE=<JSON
  array of RestoreStreamLine>` writes them 100 ms apart, `silent-after:<n>` writes `n` lines and
  then nothing; `FAKE_SERVE_REQUESTS=<path>` appends each launch request's JSON; `FAKE_SERVE_STATE`
  `starting` or `stopping` for `launchState`)
- Test: `test/cli/commands/resume.test.ts`, `test/cli/commands/new.test.ts`,
  `test/cli/commands/window.test.ts` (unchanged: the move's check); `docs/design-step-2.md` (C11,
  C12: 11.4), `docs/design.md` (7.5: the options)

**Behaviour.** As 2.4 and 2.5. `windowServer`: `findServer(deck, appRoot, computeBuild(...))` —
`ours` and `other-build` are used, the rest refused. `resumeInWindow` / `newInWindow`: the
request; every answer line on stderr through the sanitiser; then `client.status()`, and with 0
pages `launchWindow(deck, client, ping, false, times)` — a SkydeckError there is C12's line. The
usage texts name `--window` (`Without --here, --tab or --window, the configured "terminal"
decides.`).

**Tests** (platform: `realTestPlatform`; `windowMachine` and `startFakeServe` of
`test/helpers/window-machine.ts`)
- Client: each method's request as 2.2 says (the fake's request file); `503 starting` twice, then
  an answer → the answer; `stopping` → its line; `silent` with `answerMs` 300 → the no-answer
  line; a 404 route → `unknown-route`; an answer of another shape → cannot be read; `restore`'s
  lines to `onLine` in order and the outcome; `silent-after:1` → the stopped-answering line after
  `answerMs`; a stream ended without an outcome → the same line.
- `resume --window` against the fake answering `{ code: 0, lines: ['skydeck: original flags
  unknown; resuming with defaults'], sessionId }` → that line on stderr, exit 0, the request's
  `sessionId` the resolved id, no handoff file, no lock in the store (the command took none); with
  pages 0 → the Edge stub ran once with a token, the token given up; with pages 1 → not run;
  Edge missing → C12's line, exit 0; an answer `{ code: 4, lines: [...] }` → exit 4.
- Each row of 2.5's table: no server, one that does not answer (`FAKE_SERVE_MODE=silent`), another
  checkout, an older server (no `FAKE_SERVE_LAUNCH`), `stopping` → its line, exit 1, no request
  sent, no Edge.
- "the answer's lines are printed sanitised": a line with an escape sequence and a CR → printed
  without them.
- `new --window --label x --group y -- --model opus` → the request `{ dir: <cwd>, label: 'x',
  group: 'y', flags: ['--model', 'opus'] }`; without `--label` → `label: null`.
- `--here --window`, `--tab --window` → usage error, exit 2, nothing sent. Under `CLAUDECODE=1` →
  sent as usual.
- `skydeck window`'s every existing case passes unchanged.

**Done when:** `resume --window` and `new --window` send to the server and say what C11 and C12
say in every case of 2.5, and `skydeck window` behaves as before; `npm run check` passes.

**Not in it:** `"terminal": "window"`, `restore` and `R` (77); the end-to-end cases through the
real server (77).

---

### Task 74: The server — launches, restore and the routes wired

**Depends on:** 72, 73 · **Wave:** 3 · **Design:** S2 8.3, 11.3, 11.4, 12.7, 8.2.6 (first size), 5.5 (the stop), 14 · **Contracts:** 2.3, 2.5 · **Decisions:** C2, C4, C6, C7, C9 · **Shared files:** `src/window/server.ts`

**Goal.** The running server does stage C: the banner in every list, restore from a page or a
command, `POST /resume` and `/new`; and its stop ends a restore before it closes anything.

**Files**
- Modify: `src/window/server.ts`: `createLaunches` over the registry and `terminalFor`;
  `createRestorer` with `launches.restoreTerminal`, `.refusal`, `.gone`, `size: () =>
  pages.lastFocused()?.area ?? { cols: 120, rows: 40 }`, `progress: (text) =>
  pages.notice('restore-progress', text)`, `changed: () => { tick?.reload(); pages.pushList(); }`;
  `ActionDeps.restore` and `.dismissRestore` → the restorer (`all` false); `listFor` sets
  `banner: restorer.banner(tick?.rows() ?? [])`; `controlHandler` gets `launch` (`resume` and
  `newSession` through `launches` with the same size, mapped to C2's `LaunchAnswer`, a busy store
  and an unexpected error as C2 says; `restore` → `restorer.start(request, write)` and its `done`,
  a refusal as one line and an outcome with code 1) and `launchState` (`starting` until `ready`,
  `stopping` from the first line of the orderly stop); the orderly stop's first step is
  `await restorer.stop()`, before the tick's stop and `control.close()`
- Create: `test/helpers/window-restore.ts` (sessions of an earlier boot in a server sandbox: for
  each, a resumable transcript (`resumable`), and through `test/helpers/spool.ts` a `start` event
  in an invented boot id with a pid and process start that are not alive and no end, so that the
  session is `ended-unexpectedly` and design 7.8's default set holds it; options for `was-working`
  and an end time), `test/window/server-launch.test.ts`, `test/window/server-restore.test.ts`

**Behaviour.** As the contracts say; the server adds no rule of its own. The refusal lines of the
two launch routes get `skydeck: ` in front, the launch lines are passed as they are.

**Tests** (platform: `realTestPlatform` through `startTestServer`; the stand-in as
`claudeCommand`; the sandbox's `config.json` with `restoreStartTimeoutSeconds` 5 and
`restoreBatch` 2 unless a case says otherwise)
- `server-launch.test.ts`: "POST /resume runs buildResumeCommand's argv with claudeCommand in the
  session's directory" (the stand-in's record: argv, cwd; the answer `{ code: 0, lines: [],
  sessionId }`; the terminal listed under Open); a session the stand-in holds → code 4 and
  `skydeck: <short> is running (pid <n>)`; an unknown id → code 3; one the window is starting →
  code 4 `skydeck: this session is already open in the window`; "POST /new runs buildNewCommand's"
  (dir, label, group, flags; the meta stored; `sessionId` the new one); "POST /new refuses what
  skydeck new refuses, with the same lines and code" (`-r x`, `--name y`, a relative and a missing
  directory, `--label ' '`: the test runs `skydeck new` on the same deck for the expected text);
  "two POST /resume of one session at once start one keeper" (one code 0, the other code 4); "a
  body with argv, program, cwd, command or env is 400 and no keeper is spawned"; with a page
  focused at 132 × 41 the new terminal's first size is 132 × 41,
  with no page 120 × 40; "server.log holds kinds only after hostile /new and /restore bodies" (a
  label and a flag holding an escape sequence and a line that looks like a log line).
- `server-restore.test.ts`: three sessions of an earlier boot → the first list's banner names them
  in list order, two preselected (one ended long before its boot's last event), `lastActivityNs`
  that boot's last event; "act restore starts the banner's sessions, restoreBatch at a time" (at
  most two stand-ins started before the first two reported their start; both pages get the
  progress notices in order ending `restore finished: 3 started`; the terminals take slots 1–3;
  afterwards the banner is null); while it runs page B's banner has `running`, page B's `act
  restore` is refused with C6's line, a `POST /restore` gets that line and code 1; "restore does
  not open a second terminal for a session the window is starting" (a `claudeCommand` that sleeps
  before the stand-in, the session resumed from a page, then restored: `failed <short>: this
  session is already open in the window`, one terminal); a session whose program exits at once →
  `failed <short>: claude ended before the session started (status 3)` within 3 s, its lock gone;
  `POST /restore` with `all: true` and an id not offered → `failed <short>: no longer offered for
  restore`, the outcome's code 1; `restoreMinFreeMb` 999999999 → `stopped: only …`, nothing
  started, code 5; `dismiss-restore` → both pages' banners `shown: false`, the kv entry; after
  `stop()` and a new server on the same sandbox still `shown: false`; the server stopped while a
  restore waits → a `POST /resume` sent once the stop has begun answers 503 `stopping` and starts
  nothing, `stop()` resolves within 10 s, the `POST /restore` stream got `stopped: the window's
  server is stopping` and code 5 before it closed, the started stand-ins still run. (The 503
  `starting` of C4 is held by task 70's control test; the server's `ready` flag is stage A's.)

**Done when:** a page and a command can restore through the server, the banner follows the store
and the run, and `POST /resume` and `/new` start sessions with the rules of 2.5; `npm run check`
passes.

**If D was merged first:** `server.ts` passes D's `changed`, `fetchPrs` and `refreshPrs` to
`createActions` (task 36) and the tick has `reloadNow`; the restorer's `changed` then calls
`tick.reloadNow()` instead of `tick?.reload(); pages.pushList()`, and C's two deps go beside D's.

**Not in it:** the commands (76, 77), the page (75).

---

### Task 77: `"terminal": "window"` — the configuration, `restore`, `R`, `doctor`

**Depends on:** 74, 76 · **Wave:** 4 · **Design:** S2 11.4, 16.4 (`terminal`), 4.4 (the interactive list's `R`), 16.3, design 7.5, 7.6 "Where", 7.8 · **Contracts:** 2.4 (`whereFor`, `restoreInWindow`), 2.5 · **Decisions:** C13, C14 · **Shared files:** `src/platform/config.ts`

**Goal.** The configured way to the window: every command and the interactive list go where C13
says, `restore` runs through the server, `doctor` names the setting — and everything is driven
end to end through the real server, the window terminal and the stand-in.

**Files**
- Modify: `src/platform/config.ts` (`terminal` takes `"window"`; the message `"terminal" must be
  "here", "wezterm" or "window"`); `src/cli/launching.ts` (`whereFor`; `chooseTerminal` with
  `"window"` takes `here` only); `src/cli/commands/resume.ts`, `src/cli/commands/new.ts` (`whereFor`
  decides; `window` → task 76's functions); `src/cli/commands/restore.ts` (C14; its usage text
  says that with `"terminal": "window"` the sessions start in the window); `src/cli/tui/run.ts`
  (`R` with `"terminal": "window"`: `windowServer(…, false)` and `requestResume`, no local
  `prepareResumeById`; `opened <short> in the window`, or `starting <short> in the window failed;
  the details are printed when the list ends` with the lines kept for the end, as for a tab; a
  SkydeckError of 2.5 is the message line); `src/cli/commands/doctor.ts` (`ok terminal: window
  (sessions start in the skydeck window; resume, new and restore need skydeck window to run)`)
- Create: `test/cli/window-e2e.test.ts`, `test/cli/commands/restore-window.test.ts`
- Test: `test/platform/config.test.ts`, `test/cli/commands/doctor.test.ts`,
  `test/cli/tui/run.test.ts`, `test/cli/commands/resume.test.ts`, `test/cli/commands/new.test.ts`;
  `docs/design-step-2.md` (C13, C14: 11.4, 16.4)

**Behaviour.** As C13 and C14. With `"here"` or `"wezterm"` nothing changes but `--window`. A
user who never sets the key sees only the new option in `--help`.

**Tests** (platform: `realTestPlatform`; the fake serve for the refusals, `startTestServer` for
`window-e2e.test.ts`; the interactive list's own test harness for `R`)
- Configuration: `"window"` accepted; `"tabs"` refused with the new message; the default stays
  `here`.
- `whereFor`: every pair of configured value and option of C13.
- `window-e2e.test.ts`, against a real test server and the stand-in: `resume <ref>` with
  `"terminal": "window"` → the session runs in a window terminal (its record), exit 0; `--tab` →
  the same; `--here` → the handoff file as in step 1, no request; `new --window -- --model opus` in
  a sandbox directory → a terminal of the new session with `buildNewCommand`'s argv;
  `restore --yes` with three sessions of an earlier boot (task 74's helper) → the server's lines on
  stdout as they come (`started …`, `restore finished: 3 started`), exit 0; with one failing →
  exit 1; `R` in the list → `opened <short> in the window` and the terminal.
- `restore-window.test.ts`, against the fake serve: no server → the not-running line and no
  prompt (stdin a terminal: the prompt never shown); `--dry-run` → no request (the fake's request
  file empty), the list printed; the chosen ids and `--all` in the request; `silent-after:1` →
  11.4's line, exit 1; an outcome with code 5 → the line of C14, exit 5; an older server → C11's
  line.
- `doctor` with `"terminal": "window"` → its `ok` line; the `wezterm` and `here` lines unchanged.
- Every existing case of the commands, the list and `doctor` passes unchanged.

**Done when:** `"terminal": "window"` sends `resume`, `new`, `restore` and `R` to the window as
S2 11.4 says, end to end; `npm run check` passes.

**If D was merged first:** `config.ts` has D's `ticketUrl` key and its check (task 35); C changes
only the `terminal` type, its value check and its message.

**Not in it:** the documentation (79).

---

### Task 79: Documentation of stage C

**Depends on:** all · **Wave:** 5 · **Design:** S2 11.4, 12.7, 16.4, 18 (W16), 19 · **Contracts:** — · **Decisions:** —

**Goal.** A user can use restore in the window, `--window` and `"terminal": "window"` from the
documents alone, and can run W16 without risk to their work.

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` only
  where a decision of 1a is still missing from it

**Content (contract)**
- `docs/install.md`, in "Using the window": after a WSL restart (or a PC restart) the banner, its
  checkboxes, Restore and Not now (it does not come back for that restart; `skydeck restore` still
  works); the report lines; one restore at a time. `skydeck resume <ref> --window`, `skydeck new
  --window` (it never starts the window's server; it opens a window when none is open), and the
  configuration table's `terminal` row with `"window"` (what `--tab` and `--here` mean then;
  `restore` and `R` too); 2.5's lines in a short table "When the window cannot take it"; `show`'s
  `(in the skydeck window)`; the restore settings and `claudeCommand` are the server's, read when it
  starts (`skydeck window --restart` after a change). "Known limits of stage C": a window that
  connects during a restore sees its lines from then on; a session whose program ends after the
  restore stopped waiting for it keeps the renewed lock for up to a minute (its Resume says how long
  to wait); a restored terminal found by a restarted server before its program started is refused
  (S2 7.3); after a WSL restart `skydeck window` may open a second window beside the old one, which
  reconnects (close one); `restore` and `R` open no window.
- `README.md`: `--window` in the command table for `resume` and `new`; one sentence on restore in
  the window.
- `docs/manual-checks.md`: in the window's part, W16 as below; the part's opening list moves W16
  from "come with later stages" to its checks.
- **W16. WSL stops with the window open** (S2 18). It opens with what the user loses and how to
  prepare, before any step:
  - What `wsl --shutdown` ends: every process of every WSL distribution at once — every `claude`
    in the window and in every WSL terminal (a turn in progress is cut off), shells and editors
    running in WSL (unsaved text), builds and tests, containers of Docker Desktop's WSL engine,
    SSH tunnels and port forwards, VS Code's WSL window (it reconnects). Windows programs, the Edge
    window among them, stay. A PC restart ends the same and everything else. `wsl --terminate
    <distribution>` is not a replacement: the kernel keeps running, the boot id stays, and the
    banner offers nothing (inferred: the boot id is the kernel's).
  - Prepare: a moment when ten minutes without WSL cost nothing; save in every WSL editor; stop
    builds, containers and tunnels you would miss; end every real `claude` session yourself with
    `/exit` once its turn is over — a session ended that way is not offered by the banner and
    resumes as always. In W, `skydeck ls`: nothing may be `running`, `working` or `waiting` but the
    three throwaway sessions below; if anything else is, stop here.
  - Set-up: `mkdir -p ~/skydeck-try/a ~/skydeck-try/b ~/skydeck-try/c`; three throwaway sessions in
    the window, one in each folder (the part's "A throwaway session in the window"), one prompt in
    each; give the one in `c` a task that keeps it `working` for a minute. Write down their short
    ids (the header shows them).
  - Steps: in P, `wsl --shutdown`; the window shows `skydeck's server is not answering (since …)`
    within a few seconds (write down how long). Open W again; `skydeck window`. The window says
    `WSL has restarted since <time>: …`; at the top of the list the banner `Before the restart
    (last activity today at <time>) 3 sessions were open`, the three ticked, `c`'s with `was
    working`, `Restore 3` and `Not now`. If a session you did not make is offered, untick it.
    Restore 3: the three under Open as `starting…`, then running, in slots 1–3; the report says
    `started <short> <title>` for each and `restore finished: 3 started`; each terminal shows its
    conversation. Write down: whether a second window opened beside the old one (a known limit),
    the banner's words, the time from Restore to the last `started`.
  - An optional second part (one more `wsl --shutdown`, prepared the same way): Not now → the
    banner goes; `skydeck window --restart` → it does not come back; `skydeck restore --dry-run`
    in W still lists the three.
  - An optional third part, with no restart: close every skydeck window, keep the server running
    (`skydeck doctor`: `server` running, 0 pages); after `/exit` in the throwaway session of `a`,
    `skydeck resume <its short id> --window` in W → the window opens by itself and shows the
    session.
  - Clean up: `/exit` in each throwaway session; your own sessions are listed by `skydeck` and
    resume as always.

| # | Check | Stage | Decides |
|---|---|---|---|
| W16 | WSL stop drill: `wsl --shutdown` with the window open and three throwaway sessions in it (and no real session running). The bar of 6.3 appears; after `skydeck window` the window says WSL restarted and the banner offers the three; "Restore 3" brings them back into the window. Optional: Not now survives a server restart; `resume --window` opens the window by itself. | C | 6.3, 12.7, 11.4 |

**Steps**
- [ ] Run every command of the new install text on a clean `SKYDECK_HOME` with the fake Edge stub
      of the test helpers — never `skydeck window` or `--window` against the installed skydeck —
      to check its words.
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can use stage C from `docs/install.md` alone, and W16 is in
`docs/manual-checks.md` with its preparation first.

**If D was merged first:** `install.md`, `manual-checks.md` and `README.md` have D's parts (task
39: editing, W27–W29); C's parts go beside them, and W16 keeps its place among the stage A checks'
numbers.

## 4. Design coverage

| Design | Where |
|---|---|
| S2 4.4, the stage C rows | `src/sessions/restore.ts` 71; `config.ts` 77; `resume`, `new` 76, 77; `restore` 77; `show` 78; the interactive list's `R` 77 |
| S2 8.2.3, `restore`, `dismiss-restore`, `banner`, `restore-progress` | 70 (types), 72 (acting), 73 (banner, progress), 74 (wiring), 75 (page) |
| S2 8.2.6, the first size of a terminal a command or a restore opens | 73 (read per opening), 74 (the last focused page's area) |
| S2 8.3, `POST /resume`, `/new`, `/restore` | 70 (parsing, the socket's side), 74 (acting), 76 (client) |
| S2 10.1, a running restore; 10.2, `window_restore_dismissed` | 73 |
| S2 11.1, one implementation; restore planning moved | 72 (launches), 71 (`restorePlan`, `latestEarlierBoot`) |
| S2 11.3, restore in the window | 71 (hooks), 73, 74 |
| S2 11.4, the commands while the window runs | 76 (`--window`, the client, the window opened after), 77 (`"terminal": "window"`, `restore`, `R`), 78 (`show`) |
| S2 12.7, the banner | 73 (the rule), 75 (the page), 74 (both windows) |
| S2 14, failures of a restore and of the requests | 73, 74, 76 (2.5) |
| S2 15.1, 15.5, what may call and what runs | 2.5's table: 70, 72, 74 |
| S2 16.3, `doctor`'s `terminal` line; 16.4, `terminal` gains `"window"` | 77 |
| S2 18, W16 | 79 |
| Design 7.5, the options of `resume` and `new` | 76 |
| Design 7.8, restore's set, preselection, batches, memory, codes | 71 (unchanged, shared), 73 (codes over the socket) |

## 5. What stage C leaves for stages B, D and E

Stage C works without B, D and E and touches their files only where its own lines are. In
`src/window/protocol.ts` it adds the two `act` kinds, the banner's payload, the `restore-progress`
notice and the three routes, and leaves `attention`, `notify`, `stack`, `view.chips` and D's kinds
as they are; in `src/window/actions.ts` it moves stage A's resume and new into `launches.ts` and
adds its two cases beside D's; in `src/window/server.ts` it adds the launches, the restorer, the
banner in `listFor` and the restorer's stop as the stop's first step; in `web/app.js` it adds the
banner and one notice kind, and no key; in `web/index.html` one element and one stylesheet. It
changes nothing in `tick.ts`, `src/window/view/build.ts`, `sections.ts`, `web/list.js`,
`web/keys.js`, `web/help.js` or `web/cards.js`. One store key, no migration.

For stage E: the switcher's "Restore 3 sessions from <time>" (S2 12.7) can be drawn from
`list.banner` — its entries and `lastActivityNs` stay in the payload after "Not now" (`shown`
false) until the next WSL restart — and sent as `act restore` with the preselected ids.

**Follow-ups on stage C's path** (`LEFT-TO-YOU.md` section 4 and the design's known limits):
- *A second window after `skydeck window` started a server while an old window is open* — **left**.
  It is on W16's path (after `wsl --shutdown` the old window reconnects a few seconds after the new
  one opened); task 79 names it in W16 and in the known limits. Its fix (a mark in the store while
  pages are connected) is not stage C's.
- *A restore's renewed lock and the found keeper* (S2 7.3, 7.8) — **narrowed, not closed**: C8
  gives the lock back for every session whose window terminal ends while the restore waits; a
  program that ends after the restore stopped waiting keeps the renewed lock until it expires, and
  a restored keeper found by a restarted server before its program started is refused. Closing both
  needs lock values with a mark that a renewal keeps and a take-over changes (S2 7.8): a change of
  step 1's lock format, not made here (question 4).
- *The ended bar of a session the filter hides* — untouched; restore adds no new case of it.

## 6. Stage C is ready to try

When task 79 is merged. In a WSL terminal of your own (not a `!` command inside Claude Code):

```sh
cd ~/projects/mine/skydeck
git pull
skydeck window          # restarts the window's server for the new build; your sessions keep
                        # running, the window reloads itself
skydeck doctor          # as before; its terminal line names "window" once you set it below
```

No `npm ci`, no `install` again, nothing new in `~/.claude/settings.json`. Then, with a throwaway
session (`docs/manual-checks.md`, "A throwaway session in the window"), after its `/exit`:

```sh
skydeck resume <its short id> --window   # starts it in the window; prints what resume prints
```

If you want every command to use the window: put `"terminal": "window"` into
`~/.config/skydeck/config.json` (create the file as `{ "terminal": "window" }` if it does not
exist). Then `skydeck resume`, `skydeck new`, `skydeck restore` and `R` in `skydeck` start in the
window; `--here` still starts here. Leave the key out and nothing changes but the new option. The
banner shows only after WSL or the PC restarted.

**What only you can check:**
- W16 — the drill, prepared as `docs/manual-checks.md` says first (it ends every WSL process):
  the banner after `wsl --shutdown`, Restore 3, and whether a second window opened.
- That `skydeck resume --window` opens the window by itself when none is open (W16's third part).
- Your judgement on questions 1–3 of section 7: the restore that stops waiting for a terminal that
  ended, the window opened after a command's answer, and a server of another build.

## 7. Questions for the lead

Planned around the reading given; each is the lead's or the user's to change.

1. **A restore that knows a terminal ended** (C8). S2 11.3 says the window's restore runs "exactly
   as from the command line", where a tab that fails is waited for until
   `restoreStartTimeoutSeconds` (120 s) and its renewed lock then holds a minute more. Planned: in
   the window a session whose terminal ended before it started is reported `failed` at once and its
   lock given back (`gone`), and the server's stop ends a restore (`signal`). The other way keeps
   exact parity and the wait.
2. **The window a command opens** (C12). S2 11.4 says `resume` and `new` start a window when no page
   is connected; planned literally — after any answer, also a refusal (it shows why), with the exit
   code the answer's even when Edge fails — and not for `restore` or `R`, which 11.4 and 4.4 do not
   name. Say whether `restore` with `"terminal": "window"` should open one too.
3. **A server of another build** (C11). Planned: used, as the window's own Resume uses it; only
   another checkout, a server that does not answer and one older than stage C (404) are refused.
   The other way refuses another build and asks for `skydeck window`, which restarts it with the
   environment of the shell it runs in (S2 5.2).
4. **The lock's mark** (section 5). S2 7.8 names "a mark that a renewal keeps and a take-over
   changes" as what closes the two remaining cases of the restore's renewed lock. Not planned: it
   changes step 1's lock value, which every command reads. A follow-up if the remaining cases
   matter.
5. **`show --json`** (C15): planned unchanged, as stage D's D16 did for the ticket; the holder
   object could carry `inWindow`.
6. **What "Not now" stores** (C9): planned as the earlier boot whose sessions the banner offers
   (`dismiss-restore`'s `bootId` of S2 8.2.3). Storing the current boot instead would hide the
   banner of the next restart, whose earlier boot is the one the dismissal was made in.
