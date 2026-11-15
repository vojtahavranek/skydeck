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
lock and command builders. A restore is step 1's `runRestore` with the window terminal and optional
hooks, run by one coordinator in the server (`src/window/restorer.ts`), one at a time;
the banner is a pure function of the view model. The commands never start a server and prepare
nothing themselves when they send to it. Two of stage A's named limits on this path are settled
here: a renewal of a resume lock keeps a mark of its take, so restore can renew the lock of a
window terminal (task 80), and the server keeps a mark in the store while windows are connected,
so that `skydeck window` after a WSL restart waits for the old window instead of opening a second
one (task 81).

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

**Task numbers** are 70–81 (stage D has 34–39, stage B 50–56), so that branch names, pull-request
titles and the lead's notes stay unique. Tasks 80 and 81 were added after the first version of
this plan (the lead's guidance); their numbers do not follow their waves.

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

**Known flakes** (not stage C's to fix): `test-page/terminal.test.ts`, "input-full (the program
stalled, a large paste)" (under load a key pressed during the stall can be taken);
`test/platform/real.test.ts:1005` (it uses the wall clock, which WSL steps back) and its case "a
streamed answer that keeps coming…"; `test/standin/standin.test.ts` (records in the wrong order
now and then); `test/window/mapping.test.ts:623` (ENOTEMPTY at the sandbox's clean-up); and, seen
once while five other suites ran, `test/cli/commands/window.test.ts:1772` ("--new-secret while a
server starts…"). A run that fails only with one of them is run once more, and the pull request
names both runs.

## 1. Tasks and waves

Task 0 is `main` with this plan merged (stage A complete at 9c5cbfb; the plans of stages D and B
merged at cadb490 and 4437256).

| # | Task | Depends on | Merges after | Wave | Size (code + tests) | Shared with another stage |
|---|---|---|---|---|---|---|
| 70 | Contracts; the control socket's stage C routes | 0 | D 34, B 50, B 51 | 1 | ~600 | `protocol.ts`, `actions.ts` (the interim kinds), `store/types.ts` (two lines), `web/app.js` (one line), their tests |
| 71 | Step 1 change: restore planning shared, `runRestore`'s hooks | 0 | — | 1 | ~500 | — |
| 78 | `show`: `(in the skydeck window)` | 0 | D 35 | 1 | ~300 | `show.ts`, `output.ts`, their tests |
| 80 | Step 1 change: the resume lock's take mark | 0 | — | 1 | ~300 | — |
| 72 | Launches: one way to start a session in the window | 70 | D 36 | 2 | ~450 | `actions.ts`, its test |
| 73 | The restorer and the banner's view model | 70, 71 | D 34, B 50, B 51 | 2 | ~650 | `test/window/view/build.test.ts` (the pinned file list); S2 10.2 |
| 75 | The banner on the page | 70 | D 37, B 55 | 2 | ~650 | `web/app.js`, `web/index.html`, `test-page/helpers/shell.ts` (a function) |
| 81 | The second window after a cold start: the pages mark | 70 | — | 2 | ~350 | — |
| 74 | The server: launches, restore, the routes and the pages mark wired | 72, 73, 81 | D 36, B 54 | 3 | ~700 | `server.ts` |
| 76 | The command line's side: the client, `--window` for `resume` and `new` | 70, 81 | — | 3 | ~750 | — |
| 77 | `"terminal": "window"`: the configuration, `restore`, `R`, `doctor` | 74, 76 | D 35 | 4 | ~650 | `config.ts`, its test |
| 79 | Documentation of stage C | all | B 50, D 39, B 56 | 5 | docs only | `docs/*`, `README.md` |

```
wave 1:  70  71  78  80
wave 2:  72  73  75  81
wave 3:  74  76
wave 4:  77
wave 5:  79
```

**Can start at once** (no dependency, no file another stage changes): **71 and 80**. Every other
task may be built while the tasks it merges after are open, and merges `origin/main` once they
landed, resolving the places its **At the merge** line names (ruled: a later task is built in
parallel and merges after the earlier one). So 70 is built beside D 34, B 50 and B 51 and merges
after them; 78 after D 35; 72 after D 36; 73 after D 34, B 50 and B 51; 75 after D 37 and B 55; 74
after D 36 and B 54; 77 after D 35; 79 after B 50, D 39 and B 56. 81 and 76 touch no file of
another stage.

The critical path is 70 → 72 → 74 → 77 → 79. Task 76 builds against the fake serve, so it does not
wait for the server's routes (74); task 77 is the first to drive the commands end to end through
the real server, the real window terminal and the stand-in. Task 75 builds against a scripted
stand-in server, as stage A's page tasks did, so it does not wait for 73 and 74. Task 79 may start
its reading while 77 is built and merges last.

### 1b. Every file of every task

Every new module is its own file with its own test file. Each task's own **Files** list says the
same as its row here.

| # | Creates | Changes |
|---|---|---|
| 70 | — | `src/window/protocol.ts`, `src/window/control.ts`, `src/window/actions.ts`, `src/store/types.ts`, `web/app.js` (one line); `test/window/protocol.test.ts`, `test/window/control.test.ts`, `test/window/actions.test.ts`; `docs/design-step-2.md` (8.2.3, 8.3) |
| 71 | — | `src/sessions/restore.ts`, `src/cli/commands/restore.ts`; `test/sessions/restore.test.ts`, `test/cli/commands/restore.test.ts`; `docs/design-step-2.md` (4.4, 11.1, 11.3) |
| 78 | `src/window/in-window.ts`, `test/window/in-window.test.ts` | `src/window/mapping.ts`, `src/cli/output.ts`, `src/cli/commands/show.ts`; `test/cli/output.test.ts`, `test/cli/commands/show.test.ts`; `docs/design-step-2.md` (11.4) |
| 80 | — | `src/sessions/resume.ts`, `src/window/starts.ts`; `test/sessions/resume.test.ts`, `test/window/starts.test.ts`, `test/window/server.test.ts` (one line); `docs/design.md` (7.6), `docs/design-step-2.md` (4.4, 7.3, 7.8) |
| 72 | `src/window/launches.ts`, `test/window/launches.test.ts` | `src/window/actions.ts`; `test/window/actions.test.ts` |
| 73 | `src/window/restorer.ts`, `src/window/view/banner.ts`, `test/window/restorer.test.ts`, `test/window/view/banner.test.ts` | `test/window/view/build.test.ts`; `docs/design-step-2.md` (10.2, 11.3, 11.4, 12.7) |
| 75 | `web/banner.js`, `web/banner-text.js`, `web/banner.css`, `test/web/banner.test.ts`, `test-page/banner.test.ts` | `web/app.js`, `web/index.html`; `test-page/helpers/shell.ts` |
| 81 | `src/window/page-mark.ts`, `test/window/page-mark.test.ts` | `src/window/client.ts`, `src/cli/commands/window.ts`, `test/fixtures/fake-serve/fake-serve.ts`; `test/cli/commands/window.test.ts`; `docs/design-step-2.md` (5.1, 8.3, 10.2) |
| 74 | `test/helpers/window-restore.ts`, `test/window/server-launch.test.ts`, `test/window/server-restore.test.ts` | `src/window/server.ts` |
| 76 | `src/cli/window-open.ts`, `src/cli/window-requests.ts`, `test/window/client-launch.test.ts`, `test/cli/window-requests.test.ts` | `src/window/client.ts`, `src/cli/commands/window.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/new.ts`, `test/fixtures/fake-serve/fake-serve.ts`; `test/cli/commands/resume.test.ts`, `test/cli/commands/new.test.ts`; `docs/design-step-2.md` (11.4), `docs/design.md` (7.5) |
| 77 | `test/cli/window-e2e.test.ts`, `test/cli/commands/restore-window.test.ts` | `src/platform/config.ts`, `src/cli/launching.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/new.ts`, `src/cli/commands/restore.ts`, `src/cli/commands/doctor.ts`, `src/cli/tui/run.ts`; `test/platform/config.test.ts`, `test/cli/commands/doctor.test.ts`, `test/cli/tui/run.test.ts`, `test/cli/commands/resume.test.ts`, `test/cli/commands/new.test.ts`, `test/cli/commands/restore.test.ts`; `docs/design-step-2.md` (11.4, 16.4) |
| 79 | — | `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (18, 19, and any decision of 1a still missing) |

Files more than one stage C task changes, never two of one wave: `src/window/actions.ts` and its
test (70, 72); `src/window/client.ts`, `src/cli/commands/window.ts` and
`test/fixtures/fake-serve/fake-serve.ts` (81, 76); `src/cli/commands/resume.ts`, `new.ts` and their
tests (76, 77); `src/cli/commands/restore.ts` and its test (71, 77); `web/app.js` (70's one line,
75). `docs/design-step-2.md`: each task writes only the sections its row names; in wave 1, 70 (8.2.3,
8.3), 71 (4.4, 11.1, 11.3), 78 (11.4) and 80 (4.4, 7.3, 7.8) — 71 and 80 both write 4.4, two
different rows of its table, and the second to merge keeps both; in wave 2, 73 alone writes 12.7
(C9, C10 and C21; 75 writes no design text) and 81 writes 5.1, 8.3 and 10.2's `kv` table, where 73
writes its own row (the second to merge keeps both). `src/window/client.ts`, `window.ts`,
`src/sessions/resume.ts`, `starts.ts` and the fake serve are stage C's alone (no other plan names
them).

**The order across stages** (ruled, notes of 2026-11-15, "rulings on review B"; "proposed" where no
ruling names the file). A later task is built in parallel and merges `origin/main` once the earlier
one landed, resolving the places named:

| Files | Order | What the stage C task resolves |
|---|---|---|
| `src/window/protocol.ts`, `test/window/protocol.test.ts`, S2 8.2.3's `list` row | D 34 → B 51 → C 70 | 70: its kinds beside D's in `ActMessage` and `ACTS`; `restore-progress` in `NoticeMessage.kind`; `ListMessage.banner` keeps its line (B puts `needYou` after `counts`); `StatusAnswer.windowExpectedMs` last; its cases at the end; C 70 writes the `list` row's `banner` |
| `src/window/actions.ts`, `test/window/actions.test.ts` | D 34 → C 70; D 36 → C 72 | 70: its two kinds join D 34's `NOT_YET` case; 72: only the `resume` and `new` cases, the helpers above `run()` (what D 36's cases call stays callable there) and its two cases, beside D 36's cases and deps |
| `src/store/types.ts`, `KvKey`; S2 10.2's `kv` rows | B 50 → C 70; B 50 → C 73 | 70 inserts its two keys after `attention_seq`; 73 its row after B's (and 81 its own) |
| `test/window/view/build.test.ts` (the case that pins the view's files and imports, about line 1111) | D 34 → B 51 → C 73 | 73 adds `banner.ts` to the file list (`chip.ts` and `attention.ts` kept); the allowed imports stay |
| `src/cli/output.ts`, `src/cli/commands/show.ts` and their tests | D 35 → C 78 | 78: `inWindow` after D's `ticket` parameter; the mark on the holder line; cases at the end |
| `web/app.js` (the import block; `received()`'s `case 'list'` and `case 'notice'`), `web/index.html` (the style-sheet links after `cards.css`; the list zone), `test-page/helpers/shell.ts` | C 70's one line (wave 1) first; then D 37 → B 55 → C 75 | 75: its import after B's; `banner.render` in `case 'list'` beside D's dialog update and B's title; the `restore-progress` branch in `case 'notice'` that 70 left out; `banner.css` after `attention.css`; `#banner` before `#list`; `bannerWorld` after `actsWorld` |
| `src/window/server.ts` (`createActions`' deps, `listFor`, `afterRefresh`, `GET /status`, the orderly stop) | D 36 → B 54 → C 74 | 74: its two deps beside D's; the banner set on `buildListMessage`'s result after B's attention; `pageMark.update` beside `decidePostponed`; `windowExpectedMs` in the status; `restorer.stop()` as the stop's FIRST step, before D's fetch wait and B's `seen.stop()`. C changes nothing in `tick.ts` |
| `src/platform/config.ts`, `test/platform/config.test.ts` | D 35 → C 77 (proposed: different places) | 77: only the `terminal` type, its check and message; cases at the end |
| `docs/install.md`, `docs/manual-checks.md`, `README.md` | B 50 ("Updating" only); then D 39 → B 56 → C 79 → E 99 | 79: its parts after D's and B's; the README's command table last (the formatter re-pads it whole when a row widens) |

**What each stage C task does to a test file another stage changes too**, so that B, D and E can be
scheduled around it:

| Test file | Task | What it does |
|---|---|---|
| `test/window/protocol.test.ts` | 70 | new cases at the end; no fixture changes (`banner: null` still type-checks) |
| `test/window/actions.test.ts` | 70, 72 | 70: one case at the end; 72: new cases at the end, every existing case unchanged |
| `test/window/view/build.test.ts` | 73 | `banner.ts` in the pinned file list; nothing else |
| `test/window/server.test.ts` | 80 | one line (about 549): the refusal's new words `its resume lock was taken over` |
| `test-page/helpers/shell.ts` | 75 | a new function `bannerWorld` after `actsWorld`; `scriptedList`, the worlds and `MINIMAL_MODULES` unchanged |
| `test/platform/config.test.ts` | 77 | new cases at the end |
| `test/cli/output.test.ts`, `test/cli/commands/show.test.ts` | 78 | new cases at the end |

**Not changed by stage C** although its type changes reach them: `test/helpers/pages.ts`
(`defaultList`'s `banner: null` is still a `BannerPayload | null`), `test/window/pages-stream.test.ts`
(its `ListMessage` literal's `banner: null` likewise), `test-page/cards.test.ts`,
`test-page/real-modules.test.ts` (it loads the real `banner.js` through `app.js`; with a null banner
and no report it draws nothing, and its cases' "no problem" still holds), `test/web/pane.test.ts`,
`test-page/list.test.ts` and the shell's pinned modules (the shell tests load the real `banner.js`,
which draws nothing for their lists). Stage C changes nothing in `src/window/tick.ts`,
`src/window/view/build.ts`, `sections.ts`, `src/window/selected.ts`, `web/list.js`, `web/keys.js`,
`web/help.js` or `web/cards.js`, and adds no key (`test/web/keys.test.ts` is untouched).

## 1a. Decisions this plan makes where the design is silent

Binding for the implementer, as stage A's A1–A38. The last column names the task that records the
decision in the design in its own pull request; `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| C1 | One module starts sessions in the window: `src/window/launches.ts` (2.3). Stage A's resume and new of `actions.ts` move into it unchanged — the window's refusal "this session is already open in the window" before the guard, `prepareResumeById`, the session's ended terminals closed before the new one opens, a throw of `open()` answered as a timeout, the lock given back after a throw before `open()` — and `act resume`, `act new`, `POST /resume`, `POST /new` and the restorer all use it. | S2 11.1: one implementation. Restore must not open a second terminal for a session the window is starting (the hole 11.1's rule closes). | — |
| C2 | `POST /resume` and `POST /new` answer `{ code, lines, sessionId }` (`LaunchAnswer`, 2.2): `lines` exactly as `skydeck resume` / `new` would print them on stderr — `launchPrepared`'s lines as they are, a refusal's message line by line with `skydeck: ` in front (as `failureText`) — and `code` the exit code the command would end with: 0, 1 (a failed launch, a busy store, an unexpected failure), 2 (`prepareNew`'s refusals), 3 (`RefError`), 4 (the guard, the lock, and the window's own "already open"). An unexpected failure is answered code 1 with `skydeck: the window's server could not start it (<kind>)` and logged by kind; a busy store with `skydeck: skydeck's database is busy; try again`. | S2 8.3 names `{ code, lines }`; the command prints them and exits with the code. A command must print something, so these are not 500. | 70 (8.3) |
| C3 | The bodies: `POST /resume` `{ sessionId }`; `POST /new` `{ dir, label, group, flags }` with `label` and `group` null when the option was not given and passed to `prepareNew` exactly as the command passes them (a blank `--label ' '` is refused, unlike the window's form, S2 12.6), `flags` the words after `--` as an array (no splitting); `POST /restore` `{ sessionIds, all }` with 1–1,000 distinct session ids. Every session id passes `isSessionId`, as `act resume`'s does. Strings well formed; no NUL in `dir` or a flag; `dir` 4,096 bytes, `label` and `group` 1,024, at most 1,000 flags; the body's 64 KiB bounds the rest. An unknown or missing field is 400. | S2 8.3: fixed fields, no program, no argument list; a prompt after `--` is the user's and is passed on (design 7.7). | 70 (8.3) |
| C4 | While the server starts (its upgrade answers 503) the three routes answer 503 `{ error: 'starting' }`, and the client asks again every 500 ms within its answer time; once its stop has begun, 503 `{ error: 'stopping' }`, which the command reports (`the window's server is stopping; run skydeck window, or use --here`, exit 1). | Before its keepers are found the server does not know its terminals (S2 8.2.1's reason for 503): the "already open" rule could not see one. | 70 (8.3) |
| C5 | `POST /restore` answers 200 with JSON lines (2.2 `RestoreStreamLine`): `{ "line": … }` per report line, `{ "line": "waiting for <n> sessions" }` after 10 s without one (`1 session`), and last `{ "outcome": { code, started, timedOut, failed, notStarted } }`. A request that cannot run (a restore is already running, the boot id unreadable, the store busy) is the same stream: its line, then an outcome with code 1. `code`: 5 when a stop ended the run — the memory check, the server's stop, the asker's close (C22), or C23's empty batch with entries left (ruled on review A's re-check) —, else 1 when any selected session failed, was not offered any more or timed out, else 0 (design 7.8's codes). | S2 8.3 and 11.4: a stream of lines, the outcome last, a line at least every 10 s. One reading path for the client. | 70 (8.3) |
| C6 | One restore runs at a time in the server, whoever asked (a page or a command). Another request meanwhile is refused with `a restore is already running; wait until it has finished`: `act restore` answers it as its result, `POST /restore` as its one line. `act restore` answers at once (`ok`, no lines) once the run has begun; every report line of every run, whoever asked, goes to every page as `notice restore-progress` (its text sanitised). **Every run ends with exactly one line `restore finished: <n> started, <n> timed out, <n> failed, <n> not started`** (the parts that are 0 left out; `restore finished: nothing was started` when all are 0), also after a stop of either kind — the memory stop and the signal: their `timed out …` lines for the sessions still waited for, then `stopped: …`, then `not started …`, come before it — and after a run that cannot begin (its refusal line first). Heartbeats go to the command line only. | S2 11.3 ("one restore runs at a time"), 12.7 ("the banner reports each line of the run"), 8.2.3's `restore-progress`. One end mark is the page's only boundary between two reports (C10; ruled on review B). A result that waited for the whole run (minutes) would be lost by a page that reconnects meanwhile. | 73 (11.3, 12.7) |
| C7 | The restore's set is taken on freshly refreshed rows at the moment it starts (`refresh`, then `restorePlan`, 2.3), design 7.8's default set for the banner and `all` as asked over `server.sock`; the selected ids are kept in the set's order, and an id not in the set is reported `failed <short>: no longer offered for restore` before the run. Each terminal's first size is the area the page that had focus last reported, else 120 × 40, read when that terminal is opened (S2 8.2.6). The server's configuration (`restoreBatch`, `restoreMinFreeMb`, `restoreStartTimeoutSeconds`, `claudeCommand`) is the one it read at its start. | S2 11.4 and 8.2.6 say it; the configuration is the server's like every launch it makes (S2 5.2). | 73 (11.4) |
| C8 | `runRestore` gains optional hooks (C23 adds `stopAfterEmptyBatch` to these three) and the outcome of each report line (2.3, `RestoreHooks`): `refuse` before the guard (the window's "already open"), `gone` at every look of the wait — a session whose window terminals have all ended, were lost, were not started or were closed before restore saw its start is reported `failed <short>: <reason>` at once and restore's own lock (its last renewed value) is given back —, and `signal`, with which the server's stop ends the run at its next step (`stopped: the window's server is stopping`, the rest `not started`). The command passes none and nothing changes for it. | S2 11.1's rule must hold for restore; a window terminal that ended is known to the server, where a tab is not, so waiting the full `restoreStartTimeoutSeconds` would only make the user wait; the server's stop must not leave a restore writing into a closed store. Question 1. | 71 (4.4, 11.1, 11.3) |
| C9 | The banner is the view model's (`bannerPayload`, 2.3): null when design 7.8's default set is empty and no restore runs; otherwise its payload with `shown` false once the user said "Not now" for its earlier boot (the page then shows nothing; stage E's switcher still finds the offer) and `running` while any restore runs. `dismiss-restore` names the earlier boot whose sessions the banner offers (`banner.bootId`) and stores it in `kv` `window_restore_dismissed` only when it is the banner's current one (else `this offer to restore is no longer shown`, nothing stored). The server computes it from the tick's rows, again only when the rows array, the dismissal or `running` changed (one read of the events each time). | S2 12.7 and 10.2: "the user has not dismissed it for that boot", and the switcher's offer after "Not now". The page decides no rule (S2 4.3). | 70 (8.2.3), 73 (12.7, 10.2) |
| C10 | The page keeps the report lines it receives (`restore-progress`) in a report under the banner's place, as text, at most the last 200. A line that comes after a `restore finished: …` line starts a new report; no other line is a boundary. **The report is drawn while it holds lines, whatever the banner's payload says** (null, or `shown` false: a run asked for by a command, or stage E's restore from the switcher after "Not now", shows its report too). After its `restore finished:` line the report has a × that removes it. A page that connects during a run sees `running` and the lines from then on (a named limit). The banner and the report together take at most 40 % of the list zone's height and scroll inside it, so that the filter and the list keep their room. Their controls take no keyboard on a mouse click (stage A's rule for the page's chrome); "Restore" and "Not now" act once — not while their own `act` waits, not on a key's auto-repeat (stage D's F7). Nothing in stage C adds a key. | S2 12.7 shows the lines; S2 4.3: the page decides no rule but where a report ends, which C6 makes one fixed line. Ruled on reviews A and B. | 73 (12.7) |
| C11 | `--window` and `"terminal": "window"` find the server as `skydeck window` does (`findServer`) and never start, restart or signal one. A server of this checkout is used whatever its build (the window's own Resume runs on that build too); none, one that does not answer, one that is starting past the ping wait, and one of another checkout are refused with the lines of 2.5, exit 1; one that answers the route with 404 (`route` kind: a build before stage C) with `the window's server is older than this command and cannot start sessions for it; run skydeck window to restart it, or use --here`. No answer within 30 s (`answerMs`): 11.4's line, exit 1, no command printed. None of these is refused under `CLAUDECODE` (no server is started). | S2 11.4 leaves the other states open; the server's environment becomes every session's, so only `skydeck window` may start or restart one (S2 5.2). Question 3. | 76 (11.4) |
| C12 | **A window opened by a command** (ruled on review A). `resume` and `new` start a window after the server's answer when no page is connected — not after a refusal with code 2 or 3 (nothing started); `restore` with the window as its terminal starts one BEFORE its request when no page is connected (the terminals then start at the window's size, and a start dialog can be answered); the interactive list's `R` starts none, and its message adds `no window is open; run skydeck window`. The code is stage A's of `skydeck window` (the launching lock, the server's expected window of C20, a token, Edge, the wait, the token given up), moved unchanged into `src/cli/window-open.ts`. A window that cannot be opened is one line on stderr, `skydeck: the window could not be opened: <reason>; run skydeck window`, and the exit code stays the answer's (restore goes on with its request). **Under `CLAUDECODE` a command never opens a window** (S2 5.1 refuses `skydeck window` there; this must not be a second door): it may still ask a running server to start the session, and with no page connected it says `no window is open; run skydeck window in a terminal of your own`. | S2 11.4 says it for `resume` and `new`; a refusal of usage or reference shows nothing in a window. Ruled by the lead: an agent's shell opens no Windows program. Told to the user: an agent's `skydeck new --window` can start a session in their window. | 76 (11.4) |
| C13 | Which way a command goes (`whereFor`, 2.4): with `"terminal": "window"`, no option, `--tab` and `--window` go to the window and `--here` stays here; with `here` or `wezterm`, only `--window` goes to the window. `--here`, `--tab` and `--window` exclude each other (usage error, exit 2). The interactive list's `R` with `"terminal": "window"` sends `POST /resume` and shows its outcome as a tab launch's today: `opened <short> in the window` (with `; no window is open; run skydeck window` when no page is connected, C12); a refusal (codes 2–4) is the message line as today; a failed launch's lines are printed when the list ends. | S2 11.4, 4.4; a user who never sets the key sees only the new option. | 77 (11.4, 16.4) |
| C14 | `restore` with `"terminal": "window"` (and without `--dry-run`): `windowServer` first, so that "the window is not running" comes before the list and the prompt; then its own refresh, plan and prompt (design 7.8, unchanged), then C12's window when no page is connected, then `POST /restore` with the chosen ids and `--all`; each line printed on stdout as it arrives, heartbeats too; 30 s without a line: `the window's server stopped answering; run skydeck to see what started`, exit 1; the exit code is the outcome's; with code 5, `skydeck: restore stopped before it finished; see above` on stderr. | S2 11.4. | 77 (11.4) |
| C15 | `show` adds ` (in the skydeck window)` to a holder line when the holder is a keeper's program or descends from it — up to 8 parents below the program, so 9 below the keeper — and that keeper's `.pid` line is alive by design 5.5's rule; the walk is mapping's (exported, 2.3). No runtime directory, no keeper line, no boot id: no mark; `show` creates nothing and connects to nothing. `show --json` is unchanged. | S2 11.4 ("a holder that descends from a keeper (7.5's rule)"); `show` must not depend on a running server. Question 5. | 78 (11.4) |
| C16 | `src/cli/` may import `src/window/` also for `resume`, `new`, `restore`, `show` and the interactive list (stage A's 2.1 named `window`, `serve`, `doctor`, `uninstall`). | They talk to the server or read its files. | — |
| C17 | `SKYDECK_TEST_WINDOW_TIMES` (A31) gains `answerMs` (30 s: the wait for an answer to `POST /resume` and `/new`, and the silence that ends a `POST /restore`), honoured only with `SKYDECK_TEST_NO_WINDOWS=1`. The restorer's heartbeat interval is an option of `createRestorer` (10 s by default), set only by tests. | A31's rule: no test waits 30 s. | — |
| C18 | The times the banner shows are the page's (`web/banner-text.js`): `today at 18:02`, `yesterday at 18:02`, `on 12 Nov at 18:02`, `on 12 Nov 2025 at 18:02` (a year other than this one), in the page's time zone, 24-hour. | S2 12.7's "yesterday at 18:02"; the server sends nanoseconds (S2 8.2.3). | — |
| C19 | **The resume lock's take mark** (S2 7.3's and 7.8's named limit, closed; ruled on review A). A renewal writes the lock's time with a mark in its last six digits, the sub-millisecond part that skydeck's clock (milliseconds, `Date.now()` × 10⁶) leaves 0: the mark of a value whose last six digits are 0 — every lock `acquireLock` writes, as today — is `1 + (its milliseconds mod 999,999)`; any other value's mark is those six digits; `renewLock` writes the time of now, to the millisecond, plus the mark of the value it renews. **Those six digits of a renewed lock are a mark, not time** (design 7.6 says so). Two values are **of one take** when both record an event id, the same one, and the same mark (`sameTake`), and they are not two different values whose last six digits are both 0 (ruled, task 80: only `acquireLock` writes such a time, `renewLock` never does, so they are always two takes); a value without an event id (an older skydeck's) is of one take only with itself. **A lock's time is read to the millisecond** (ruled, task 80): `lockTakenNs` and `freshAge` drop its last six digits before they compute an age, a wait or a deadline, so a renewal's mark moves none of them. The window's found-keeper decision accepts a lock of the hello's take (a renewal), and the settlement of an ended terminal gives back a lock of its take (`releaseLockOfTake`); a take-over (a new `acquireLock`, a new millisecond) is another take. `acquireLock`, `releaseLock` and every value stage A writes or compares are unchanged. | A renewal and a take-over of a stale lock with no new event looked alike, so a keeper of a restore whose hello comes after the 5 s of `open()` was refused (restore renews in the same turn), an exit after restore stopped waiting kept the lock a minute, and a keeper found by a restarted server was refused. Old code reads a renewed value as a time less than 1 ms later, so a server of an older build that runs between `git pull` and `skydeck window` neither sweeps it nor takes it over (a third field would be "not a lock skydeck writes": swept as stale within 2 s). A take-over whose millisecond is congruent to the first take's modulo 999,999 (about one in a million) has the take's mark, but it is a value `acquireLock` wrote and so another take (ruled, task 80: otherwise a settlement would give the taker's lock back before its program reported a start, and a third resume could start the session twice). What stays, the named limit: a restore's renewal of such a take-over reads as of the first take; a found keeper of the first take is past its 55 s deadline and starts nothing, and a settlement while that restore waits gives its lock back, so the restore's next `renewLock` returns null. | 80 (design 7.6; S2 4.4, 7.3, 7.8) |
| C20 | **The second window after a cold start** (stage A's follow-up "a second window opens when `skydeck window` starts a server while an old window is still open", carried; ruled on review A). The server keeps `kv` `window_pages_open` while pages are connected: each refresh that works makes the store agree with its page count (`createPageMark(…).update`: the key while pages > 0, none at 0 — its FIRST call writes or removes whatever the store holds, so a mark a dead server left is removed by the next server's first refresh without a page); it leaves the key as it is when it stops or dies. **The wait is the server's fact**: a server that finds the key at its start expects a window back from the end of its start until a page connects or 7 s have passed, and says so in `GET /status` (`windowExpectedMs`, the ms left; 2.2). Every command that would open a window — `skydeck window`, a second `skydeck window` meanwhile, C12's window — waits for that same deadline when no page is connected, with one line on stderr: `waiting up to 7 s for the open window to come back; --new-window opens one now`; a page that comes back is "a window is already open". `--new-window`, `--print-url` and `--new-secret` do not wait. | It is W16's case: after `wsl --shutdown` the old window reconnects a few seconds after `skydeck window` started a server (the page tries every 5 s at most, S2 6.3). The cost: after a PC restart or shutdown with the window left open the mark may still be there (WSL can end before the server's next refresh sees the page go), and the first `skydeck window` then waits 7 s for a window that cannot come; W16 and "what only you can check" ask whether it does. The remedy if it does every day — the mark holds the boot id, and in another boot the wait asks whether Edge still runs on the profile — is a follow-up. The first update from a stage A server, which writes no mark, may still open a second window once (stage B's "Updating" order avoids it). | 81 (5.1, 8.3, 10.2) |
| C21 | The banner lies in the list zone, above `#list`, in the list's width; it takes height from the list (the list scrolls under it), never width, so the right side, the header's one height (stage D) and every terminal's area stay as they are: its coming and going sends no `resize`. A restore selects nothing and moves no keyboard, in any page, also while a dialog of stage D is shown: its result carries no `sessionId` (stage A's `act` selects only a resume's or a new session's). | S2 12.7: "at the top of the list"; the size a restored terminal starts with is the last focused page's area (S2 8.2.6), which the banner must not change. | 73 (12.7) |
| C22 | **A restore asked for by a command stops when its asker goes** (ruled on review A). The asker's connection closing before the outcome was written ends the run through C8's `signal`, with the reason `the command that asked for it stopped`: the server lives, the sessions already opened go on starting, the rest are `not started`, then `restore finished: …` (to the pages). So Ctrl+C in `skydeck restore` stops it, as in step 1. A restore started from the banner has no stop in stage C; `skydeck window --stop` ends it (the opened sessions go on), and `docs/install.md` says so. A Stop control in the banner is a follow-up candidate. | Otherwise Ctrl+C would end the command and the server would go on opening every batch. | 73 (11.4) |
| C23 | **A batch in which no session started stops the run** in the server: once a batch that opened at least one terminal ends with none of its sessions started **while entries are left**, the restore reports `stopped: no session of this batch started` and the rest `not started`, then `restore finished: …` — a hook of `runRestore` (`stopAfterEmptyBatch`), which the command does not pass, so step 1's restore is unchanged. A restore whose last (or only) batch starts nothing ends as any finished run with failures does: no `stopped:` line, code 1 (C5), not 5 (ruled on review A's re-check). A run that a busy store ended says `stopped: skydeck's database is busy; press Restore again (or run skydeck restore) for the rest`. | A `claudeCommand` that cannot start (the server's `PATH` after a boot) would otherwise open every keeper and fill the slots with ended terminals. The server's connection waits 250 ms for the store, not the commands' 5 s. | 71 (11.3), 73 (11.3) |

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
// src/store/types.ts: KvKey gains 'window_restore_dismissed' (C9) and 'window_pages_open' (C20)
// StatusAnswer gains   windowExpectedMs?: number | null   (C20: the ms left while the server expects a
//   window back; absent — a server of an older build — and null mean it expects none)

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
  /** Once aborted: no further entry is prepared or opened, the wait ends at its next look; the
   *  sessions still waited for are reported `timed out <short> <title>` (their locks stay, renewed
   *  last), then one line `stopped: <String(signal.reason)>`, then `not started <short> <title>`
   *  for the sessions not opened; outcome.stopped is true. But the signal stops the run only
   *  when it is seen while the stop changes something — a session the wait would still wait
   *  for, or an entry not opened; otherwise (every session started, or the wait's time ran out
   *  at that look, with no entry left) the run ends as it would have (ruled on task 71's
   *  reviews). */
  signal?: AbortSignal;
  /** C23: after a batch that opened at least one terminal and saw none of its sessions start, when
   *  entries are left, the run stops as for the signal, with the reason `no session of this batch
   *  started`. A last (or only) batch that starts nothing ends the run as any run with failures. */
  stopAfterEmptyBatch?: boolean;
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
  /** launchPrepared's lines as it gives them (each `skydeck: …` but the printable command line,
   *  which has none) after a launch; a refusal's message lines, no prefix. Sanitised. */
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
   *  filtered, runRestore with the hooks (stopAfterEmptyBatch on) and its signal — and returns at
   *  once. `write` gets every line, the heartbeats, and the outcome last; `done` resolves when the
   *  run is over. `asker` (C22, a command's connection): when it fires before the outcome, the run
   *  stops with the reason `the command that asked for it stopped`. Every run, also a refused or
   *  stopped one, ends with exactly one `restore finished: …` line to `progress` (C6). */
  start(request: RestoreRequest, write?: (line: RestoreStreamLine) => void, asker?: AbortSignal):
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
  /** Calls `write` for each line, the outcome last; the answer ends when it resolves. `closed`
   *  fires when the asker's connection closes before the answer ended (C22). */
  restore(request: RestoreRequest, write: (line: RestoreStreamLine) => void, closed: AbortSignal): Promise<void>;
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

```ts
// src/sessions/resume.ts — task 80 (C19)
/** The take a lock value belongs to: its last six digits when they are not 0, else 1 + (its
 *  milliseconds mod 999,999); null for a value that is not a lock skydeck writes. */
export function lockMark(value: string): number | null;
/** Both values record the same event id and the same mark, and they are not two different
 *  values whose last six digits are both 0 (two takes: only acquireLock writes those; ruled, task
 *  80); a value without an event id is of one take only with itself (exact equality); a value that
 *  is not a lock skydeck writes is of none. */
export function sameTake(a: string, b: string): boolean;
/** In one store transaction: removes the session's lock when it is of the take of `taken`
 *  (sameTake); whether it did. For a holder of an older value of that take (a keeper's spec). */
export function releaseLockOfTake(deck: Deck, sessionId: string, taken: string): boolean;
// renewLock(deck, sessionId, ours): unchanged signature; the value it writes keeps ours' mark.
// lockTakenNs(value) and freshAge: the lock's time to the millisecond (its last six digits dropped).
// src/window/starts.ts — task 80: decideFoundKeeper compares the stored lock with the hello's by
// sameTake ("its resume lock was taken over" otherwise); settleEndedTerminal releases with
// releaseLockOfTake.

// src/window/page-mark.ts — task 81 (C20)
export interface PageMark {
  /** Whether kv window_pages_open was there when the mark was created (the server's start). */
  readonly foundAtStart: boolean;
  /** Makes the store agree with `pages`: the key ('1') when > 0, none at 0. The first call writes
   *  or removes whatever the store holds; later calls write only on a change. A write that fails
   *  is logged by kind and tried again at the next call. */
  update(pages: number): void;
  /** C20: from `startDoneNs` (the end of the server's start) the server expects a window back
   *  while foundAtStart, no page has connected since (`pages` > 0 seen by update or by this call)
   *  and 7 s have not passed: the ms left, else null. */
  expectedMs(nowNs: Ns, startDoneNs: Ns, pages: number): number | null;
}
export function createPageMark(deps: { store: Store; log: (line: string) => void }): PageMark;
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
export interface WindowTimes extends LifecycleTimes { pageMs: number; reuseMs: number; launchingMs: number; reconnectMs: number; answerMs: number }
// (stage A's lifecycle times stay optional: lifecycle.ts keeps its own defaults)
/** A31's SKYDECK_TEST_WINDOW_TIMES (only with SKYDECK_TEST_NO_WINDOWS=1) over the defaults; C17 adds answerMs. */
export function windowTimes(env: Env): WindowTimes;
/** S2 5.1 step 2 (stage A's `launch`, with task 81's wait): unless `newWindow`, while the server's
 *  status says `windowExpectedMs` and no page is connected, `say`s C20's line once and waits for a
 *  page or the deadline ('came back': no window opened); then the window_launching lock, a token,
 *  Edge, the wait for its use, the token given up. Throws a SkydeckError with 5.1's lines. */
export function launchWindow(deck: Deck, client: ControlClient, ping: PingAnswer, newWindow: boolean, times: WindowTimes, say: (line: string) => void): Promise<'opened' | 'came-back'>;

// src/cli/window-requests.ts — task 76
export interface WindowServer { client: ControlClient; ping: PingAnswer }
/** C11: findServer; this checkout's server (any build) or a SkydeckError with 2.5's line. `here`
 *  false (restore, the interactive list) leaves ", or use --here" out of the lines. */
export function windowServer(deck: Deck, times: WindowTimes, here: boolean): Promise<WindowServer>;
/** The answer, or a SkydeckError (C11's older-server line for 'unknown-route'). Prints nothing. */
export function requestResume(server: WindowServer, sessionId: string, times: WindowTimes): Promise<LaunchAnswer>;
export function requestNew(server: WindowServer, request: NewRequest, times: WindowTimes): Promise<LaunchAnswer>;
/** resume / new for a command: windowServer, the request, every line on stderr (sanitised), C12's
 *  window (none after code 2 or 3, none under CLAUDECODE: then C12's line when no page is
 *  connected); returns the answer's code (a code that is not 0–5 is 1). */
export function resumeInWindow(ctx: Context, deck: Deck, sessionId: string): Promise<number>;
export function newInWindow(ctx: Context, deck: Deck, request: NewRequest): Promise<number>;
/** C14's request, after C12's window (before the request, when no page is connected; none under
 *  CLAUDECODE): every line on stdout as it arrives; the outcome's code. */
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
| No page connected under `CLAUDECODE` (C12) | `no window is open; run skydeck window in a terminal of your own` — the exit code stays the answer's |
| 400 or 413 for the body (a label over 1,024 bytes, a prompt after `--` over 64 KiB) | `the window's server refused the request (<kind>); use --here` |

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
| A command's restore stops when its asker goes; a banner's has no stop (C22) | 73: "every run ends with exactly one `restore finished:` line" (the `asker` case); 74: "a restore asked for by a command stops when its asker goes" |
| An agent's shell opens no Windows program (C12, S2 5.1) | 76: "under CLAUDECODE a command opens no window" |
| A restored lock is still its take; a take-over is not (C19) | 80: `sameTake`, `decideFoundKeeper` and `settleEndedTerminal` cases; 74: the late hello and the exit after the wait |

## 3. Tasks

### Task 70: Contracts; the control socket's stage C routes

**Depends on:** 0 · **Merges after:** D 34, B 50, B 51 · **Wave:** 1 · **Design:** S2 8.2.3 (`restore`, `dismiss-restore`, `banner`, `restore-progress`, the `list` row), 8.3 (`POST /resume`, `/new`, `/restore`, `GET /status`'s `windowExpectedMs`) · **Contracts:** 2.2, 2.3 (`ControlLaunch`) · **Decisions:** C2, C3, C4, C5, C9 (the payload), C22 (the asker's signal) · **Shared files:** `src/window/protocol.ts`, `src/window/actions.ts`, `src/store/types.ts`, `web/app.js` (one line), their tests

**Goal.** Fix as code every message the other stage C tasks meet at, and the socket's side of the
three routes, so that the server (74) only supplies `ControlLaunch` and the command line (76)
talks to the real `controlHandler` from the start (the fake serve uses it).

**Files**
- Modify: `src/window/protocol.ts` (2.2: the types, the two `act` kinds in `ACTS`, the three
  routes in `ROUTES`, `StatusAnswer.windowExpectedMs`); `src/window/control.ts`
  (`ControlDeps.launch`, `.launchState`; the routes: `resume` and `new` answer the `LaunchAnswer`
  as JSON, `restore` answers 200 with `Transfer-Encoding: chunked` and one JSON line per `write`,
  ended when the promise settles, and fires `closed` when the request's connection closes before
  that); `src/window/actions.ts` (the interim: `restore` and `dismiss-restore` join stage D's
  `NOT_YET` case, `skydeck cannot do that action yet`, nothing done, until task 72);
  `src/store/types.ts` (`KvKey` gains `'window_restore_dismissed'` and `'window_pages_open'`);
  `web/app.js` (ONE line: the last branch of `received()`'s `case 'notice'` leaves the kind
  `restore-progress` out, so that `tsc -p web` passes — `terminalView.notice` takes only the three
  terminal kinds; task 75 fills the branch); `docs/design-step-2.md` (8.2.3's `act` rows and `list`
  row, 8.3's table: C2–C5)
- Test: `test/window/protocol.test.ts`, `test/window/control.test.ts`,
  `test/window/actions.test.ts` (one case at the end)

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
  repeated id, a session id that fails `isSessionId` in `act restore`, `POST /resume` and
  `POST /restore`, a boot id in upper case, a `dir` of 4,097 bytes, a label of 1,025, 1,001 flags),
  with a NUL in `dir` or a flag, a lone surrogate, a wrong type, a missing field; "the stage C
  routes refuse every field they do not define (argv, program, cwd, command, env)"; `label` and
  `group` null accepted, absent refused; a `StatusAnswer` with and without `windowExpectedMs`.
- Control: stage A's "POST /resume, /new and /restore (stage C) are 404, and nothing is started"
  stays true for a handler without `launch` (renamed so); with a fake `launch`: each route calls it
  once with the parsed body and answers its value; 503 with `starting` and `stopping`, `launch`
  never called; `restore`'s answer read line by line arrives in order while the promise is still
  pending (the second line written 200 ms after the first is read before the first resolves); the
  asker closing its connection after the first line fires `closed` within a second; a `resume`
  that rejects is 500 and logged by kind; a hostile label in a refused body is not in the log.
- Actions: `act restore` and `act dismiss-restore` answer `ok: false` with D's `NOT_YET` text.
- `tsc -p web` passes (it is in `npm run check`).

**Done when:** every stage C message parses as 2.2 says; `controlHandler` serves the three routes
for any `launch` it is given; `npm run check` passes.

**At the merge** (after D 34, B 50 and B 51; built beside them):
- If D was merged first: `ActMessage` and `ACTS` hold D's kinds, `actions.ts` its `NOT_YET` case
  (C's two kinds join it), `RowPayload.chip`, `PrPayload`, `SelectedPayload` and
  `TerminalPayload.openedNs` are D's shapes — C touches none of them.
- If B was merged first: `KvKey` has `attention_seq` (C's two keys go after it, S2 10.2's order);
  `ListMessage` has `needYou` right after `counts`, and `AttentionPayload` and `NotifyMessage` (in
  `ServerMessage`) are B's — C's `banner` keeps its line, its types go beside `ListMessage`; the
  `LIST` fixture of `protocol.test.ts` has B's `needYou` — C changes no fixture.
- `web/app.js`: C 70's one line lands in wave 1, before D 37 and B 55 change `received()`; they keep
  it.

**Not in it:** acting on any of it (72–74), the client (76).

---

### Task 71: Step 1 change — restore planning shared, `runRestore`'s hooks

**Depends on:** 0 · **Wave:** 1 (starts at once) · **Design:** S2 11.1 (restore planning), 11.3, 4.4, design 7.8 · **Contracts:** 2.3 (`latestEarlierBoot`, `restorePlan`, `RestoreHooks`, `ReportOutcome`) · **Decisions:** C8, C23 · **Shared files:** —

**Goal.** S2 11.1's fourth change: one restore planning for the command and the server, which
also gives the earlier boot and its last event; and what the window needs of `runRestore`, with no
change for the command.

**Files**
- Modify: `src/sessions/restore.ts`; `src/cli/commands/restore.ts` (its private `plan()` replaced
  by `restorePlan(deck, all).entries`; nothing else changes)
- Test: `test/sessions/restore.test.ts`, `test/cli/commands/restore.test.ts`; `docs/design-step-2.md`
  (C8, C23: 4.4's row for `src/sessions/restore.ts`, 11.1, 11.3)

**Behaviour.** `latestEarlierBoot` is the part of `planRestore` that chooses the boot, taken out;
`planRestore` calls it and gives the same entries as before. `restorePlan` is the command's
`plan()` with the rows as a parameter. The hooks as 2.3 says: `refuse` is asked in `prepare()`
before `prepareResumeById` (so also for `runHere`, which the window never reaches); `gone` in
`awaitStarts` for each session still waited for, after `resumeStarted` was checked for it;
`signal` is looked at before each batch, before each entry is prepared, and after each look of the
wait; at an abort the sessions still waited for are reported `timed out …` first (as at the wait's
end), then the `stopped:` line, then the `not started …` lines. `runHere` looks at it before its
memory check and before each entry: the hooks are `runRestore`'s as a whole. The signal stops the
run only when it is seen while the stop changes something — a session the wait would still wait
for, or an entry not opened; otherwise (every session started, or the wait's time ran out at that
look, with no entry left) the run ends as it would have: no `stopped:` line, `outcome.stopped`
false (ruled on task 71's reviews 1 and 2). `stopAfterEmptyBatch`: a batch that
opened at least one terminal and saw none of its sessions start stops the run the same way, with
the reason `no session of this batch started`, when entries are left; a last (or only) batch that
starts nothing ends the run as any run with failures, with no `stopped:` line (C23). `report`'s second argument for every line that ends a session's part: `started`, `timed out`,
`failed`, `not started`, `resuming … in this terminal` (`handed-off`) and each printed command
(`printed`).

**Tests** (platform: `testPlatform` through `restoreDeck` and `fakeTabs` of `test/helpers/restore.ts`)
- `latestEarlierBoot`: BOOT_A's last event T0 with sessions in BOOT_A and BOOT_C; a scripted run
  later in BOOT_C does not make it the latest; only the current boot → null; no events → null.
- `restorePlan`: the same entries as `planRestore` over `listOrder`; `earlier` is BOOT_A and T0;
  rows without a boot id → the command's message; no rows → no entries.
- Every existing case of both files passes unchanged — the command's output is byte for byte the
  same — except that the `NOTHING` fixture (`test/sessions/restore.test.ts` about line 391) and
  the literal outcomes compared with `deepEqual` (about lines 512–555) gain `stopped: false`, and
  nothing else of them changes.
- `refuse` returning a reason for the second of three sessions → `failed <short>: <reason>`, no
  lock for it, its tab never opened, the others started; returning null → nothing changes.
- `gone` for a session after its tab opened → at the next look `failed <short>: <reason>`, its lock
  (renewed meanwhile) gone from the store, the batch's other sessions still waited for and started;
  `gone` is not asked for a session whose start was seen at the same look.
- `signal` aborted before the run → nothing opened, the `stopped:` line, every entry `not
  started`, `stopped` true; aborted while the second batch waits → that wait ends at its next look,
  its sessions `timed out …`, then `stopped:`, then the third batch `not started`; the sessions
  waited for keep their last lock (they may still start).
- `stopAfterEmptyBatch` with a first batch whose tabs open and never start → after its wait
  `timed out` ×2, `stopped: no session of this batch started`, the second batch `not started`;
  a first batch refused whole by the guard (nothing opened) does not stop the run; a last (or
  only) batch that starts nothing → its `timed out` lines, no `stopped:` line, `stopped` false;
  without the hook the second batch runs as today.
- `report`'s outcome: each kind once for a run that has all of them; header and warning lines
  carry none.

**Done when:** the command and the server can plan a restore with one function, `runRestore` takes
its hooks, and the command behaves as before; `npm run check` passes.

**At the merge:** nothing to resolve: no file another stage changes.

**Not in it:** the server's use of them (73, 74).

---

### Task 78: `show`: `(in the skydeck window)`

**Depends on:** 0 · **Merges after:** D 35 · **Wave:** 1 · **Design:** S2 11.4 (`show`), 7.5 (the descendant rule), 4.2 (the runtime directory, `.pid` lines) · **Contracts:** 2.3 (`holderPlace`, `holdersInWindow`) · **Decisions:** C15, C16 · **Shared files:** `src/cli/commands/show.ts`, `src/cli/output.ts`

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

**At the merge** (after D 35): `formatShow` has D's parameter `ticket` and prints `ticket:` after
`group:`; `inWindow` goes after `ticket`, and `show.ts` passes D's ticket address first.

**Not in it:** the mark in `ls` or the interactive list (S2 11.4 names `show` only).

---

### Task 80: Step 1 change — the resume lock's take mark

**Depends on:** 0 · **Wave:** 1 (starts at once) · **Design:** design 7.6 (the lock), S2 7.3 (a found keeper), 7.8 (an exit before the start), 11.3 · **Contracts:** 2.3 (`lockMark`, `sameTake`, `releaseLockOfTake`) · **Decisions:** C19 · **Shared files:** —

**Goal.** Settle S2 7.3's and 7.8's named limit for restore in the window before anything renews a
window terminal's lock: a renewed lock is still the take a keeper's spec holds, a taken-over one is
not. With it, a keeper of a restore whose hello comes late (or after a reconnect) is started, and
an exit before the start gives its lock back, whatever restore renewed meanwhile.

**Files**
- Modify: `src/sessions/resume.ts` (`lockMark`, `sameTake`, `releaseLockOfTake`; `renewLock` writes
  the mark; `lockTakenNs` and `freshAge` read a lock's time to the millisecond (ruled); `parseLock`'s
  pattern, `acquireLock`, `releaseLock` and `sweepLocks` unchanged); `src/window/starts.ts` (`resumeRefusal` by `sameTake`, its words `its resume lock
  was taken over`; `settleEndedTerminal` by `releaseLockOfTake`; the comment "Restore, the one
  renewer, does not reach a window terminal in stage A" goes)
- Test: `test/sessions/resume.test.ts`, `test/window/starts.test.ts`, `test/window/server.test.ts`
  (one line: about line 549 asserts `/renewed or taken over/`, the refusal's old words);
  `docs/design.md` (7.6: the mark — that the last six digits of a renewed lock's time are a mark,
  not time — and what an older skydeck does with it), `docs/design-step-2.md` (4.4's row for
  `src/sessions/`; 7.3's and 7.8's known limits replaced by the rule)

**Behaviour.** As C19. The value's form stays `<time>:<event id>`, the one stage A's pattern
reads; only a renewal's time gets non-zero last six digits. Ruled by the plan owner (review B of
the plan, re-check): **a lock's time is read to the millisecond** — `lockTakenNs` and `freshAge`
drop a value's last six digits before they compute an age, a wait or a deadline (the start check
of `freshAge` included), so `startDeadline`, the age and the wait in a refusal and every sweep stay
as before: an age from the whole value would be up to 1 ms short, and a floored "N s ago" one
second less (`test/sessions/restore.test.ts:752`, task 71's file, keeps `(10 s ago)` unchanged).
No test outside this task's files changes. Ruled by the plan owner (task 80): `sameTake` is also
false for two different values whose last six digits are both 0 (C19).

**Tests** (platform: `testPlatform` through `testDeck`)
- `lockMark`: a value `acquireLock` wrote at T0 → `1 + (T0 in ms mod 999,999)`; its renewal at T0 +
  50 s → the same mark, the time T0 + 50 s plus the mark; a renewal of that renewal → the same;
  a value that is not a lock → null.
- Named (ruled): "a lock's time is read to the millisecond": `lockTakenNs` of a renewal at T0 + 50 s
  is T0 + 50 s; 10 s later the refusal reads `(10 s ago); try again in 50 s`; exactly 60 s after
  the renewal the lock is stale. A renewed lock without an event id is released by a start dated
  at the renewal's millisecond. `renewLock` on a clock finer than milliseconds writes the
  millisecond plus the mark.
- `sameTake`: a value and its renewals → true; a take-over at T0 + 61 s with no new event (the
  case of stage A's "acquireLock replaces a lock older than 60 s") → false; two values of
  different event ids → false; an older skydeck's value without an event id → true with itself
  only; over every take-over millisecond from T0 + 60 s to T0 + 61 s → false; a renewal an older
  skydeck wrote (now, no mark) → false. Ruled: a take-over at T0 + 999,999 ms (the take's mark, the
  same event id) → false; its renewal by a restore → true (the named limit, pinned).
- An older skydeck reads it: stage A's pattern (copied into the test) parses a renewed value, and
  its time is within 1 ms of the renewal's clock; `isLockHeld` and `sweepLocks` treat it as fresh
  until 60 s after the renewal.
- `releaseLockOfTake`: removes the lock of its take after two renewals, leaves one taken over and
  one of another event id, in one transaction.
- `renewLock`'s two cases that pin the renewed value (lines 805–823) now expect the mark; every
  other case of the file passes unchanged.
- `decideFoundKeeper`: a resume whose stored lock is a renewal of the hello's → started (also after
  a chain of renewals) — the case `test/window/starts.test.ts:179` ("a renewed lock is not the
  hello's either", stage A's rule) is the one this task turns around; taken over → refused with
  `its resume lock was taken over` (also after renewals; also a take-over its taker renewed, which
  only the mark tells apart; also an older skydeck's renewal; also the congruent take-over); the
  congruent take-over's renewal → `the start deadline passed`. `settleEndedTerminal`: an exit
  before the start releases a renewed lock of its take, not a taken-over one, nor one its taker
  renewed; a start counts from the hello's take, not from a later renewal; a congruent take-over
  stays, before and after its program's start; its
  renewal by a restore is given back (the named limit). Every other case of `starts.test.ts`
  passes unchanged but for the refusal's words (the case "the lock replaced by another value").

**Done when:** a renewal keeps the take and a take-over changes it, for the window's found keepers
and settlements, and every value stage A writes reads as before; `npm run check` passes.

**At the merge:** nothing to resolve: no file another stage changes.

**Not in it:** restore through the window (71, 73, 74), which is the first renewer of a window
terminal's lock.

---

### Task 72: Launches — one way to start a session in the window

**Depends on:** 70 · **Merges after:** D 36 · **Wave:** 2 · **Design:** S2 11.1, 11.2, 11.3 (resume, new, a terminal that fails unexpectedly), 7.8 (an ended terminal dropped when its session runs again) · **Contracts:** 2.3 (`createLaunches`, `ActionDeps.restore`, `.dismissRestore`) · **Decisions:** C1, C2 · **Shared files:** `src/window/actions.ts`, its test

**Goal.** Take stage A's resume and new out of `actions.ts` into `src/window/launches.ts`
unchanged, add what restore and the routes need of it (`refusal`, `gone`, `restoreTerminal`, the
exit codes), and give `act restore` and `act dismiss-restore` their final cases.

**Files**
- Create: `src/window/launches.ts`, `test/window/launches.test.ts`
- Modify: `src/window/actions.ts` (the `resume` and `new` cases call `createLaunches` built from
  its own deps and map `Launched` to a result exactly as `launched()` and `refusedBy()` do today;
  `guarded`, `terminalsOf`, `giveBackLock` and `closeEnded` move to `launches.ts` — whatever stage
  D's cases call of them (D 36's not-started refusal looks the hub up by session) stays callable
  from `actions.ts`, kept there or re-exported from `launches.ts`; `restore` →
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

**At the merge** (after D 36; built beside it): `actions.ts` has D's cases and its required deps
`changed(): void` and `prs: Pick<PrFetches, 'fetch' | 'refresh'>`, and D 34's `NOT_YET` case,
which C 70's two kinds joined; this task changes only the `resume` and `new` cases, the helpers
above `run()` (keeping what D's cases call) and its own two cases (out of `NOT_YET`), and adds its
two optional deps beside D's. `createActions`' doc comment keeps D's sentences and gains C's.

**Not in it:** the restorer (73), wiring anything into the server (74).

---

### Task 73: The restorer and the banner's view model

**Depends on:** 70, 71 · **Merges after:** D 34, B 50, B 51 · **Wave:** 2 · **Design:** S2 11.3 (restore), 11.4 (`POST /restore`), 12.7, 10.1 ("a running restore"), 10.2 (`window_restore_dismissed`), design 7.8 · **Contracts:** 2.3 (`bannerPayload`, `createRestorer`) · **Decisions:** C5, C6, C7, C9, C10, C17, C21, C22, C23 · **Shared files:** `test/window/view/build.test.ts` (one line), `docs/design-step-2.md` 10.2

**Goal.** The one coordinator of restores in the server, and the rule that decides the banner,
both tested without a server: the window terminal, the refusal and `gone` are injected.

**Files**
- Create: `src/window/restorer.ts`, `src/window/view/banner.ts`, `test/window/restorer.test.ts`,
  `test/window/view/banner.test.ts`
- Modify: `test/window/view/build.test.ts` (the case that pins the view's files, about line 1111:
  `banner.ts` in its list; `banner.ts` imports types and at most `sanitize`, which the case allows
  already, so the allowed imports stay); `docs/design-step-2.md` (C6, C22, C23: 11.3 and 11.4; C9,
  C10, C21: 12.7 — the only stage C task that writes 12.7 —; C9: 10.2's `kv` table)

**Behaviour.** `start`: refused while a run is going or after `stop()` (for `write`: the refusal's
line, `restore finished: nothing was started`, an outcome with code 1); otherwise, synchronously,
`refresh(deck)` and `restorePlan(deck, request.all)` (a SkydeckError or a busy store → `ok: false`
with its text, or for `write` that line, the finished line and an outcome with code 1), the ids
filtered (C7), then the run begins: `deps.changed()`, `runRestore` with `terminal:
deps.terminalFor(deps.size())` built for each opening (wrap it: `open(spec)` builds the terminal of
the size of that moment and opens), `refuse`, `gone`, `stopAfterEmptyBatch`, the signal (aborted
by `stop()` or by `asker`), and `report` sending each line to `deps.progress` and `write`. A
heartbeat timer (`deck.platform.clock.after`) writes `waiting for <n> sessions` to `write` only,
`n` the sessions without an outcome yet, re-armed by every line. The run's end, whatever ended it:
exactly one `restore finished: …` line (C6) to `progress` and `write`, then the outcome to `write`
(C5's code), then `deps.changed()`. A rejection of `runRestore` is the line `stopped: skydeck's
database is busy; press Restore again (or run skydeck restore) for the rest` for a busy store, else
`stopped unexpectedly (<kind>); the sessions it opened go on starting: run skydeck to see which`,
then the finished line, an outcome with code 1, and one log line by kind. `banner`:
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
- "Every run ends with exactly one `restore finished:` line": for a run that started all, one with
  a failure, the memory stop (`restoreMinFreeMb` above the fake `/proc`'s memory: step 1's
  `stopped: only …`, the `not started` lines, then the finished line, code 5), `stop()` while it
  waits (`timed out …` for those waited for, `stopped: the window's server is stopping`, `not
  started …`, the finished line, code 5; `stop()` resolves after `done`; `start` afterwards
  refused), an `asker` that fires (`stopped: the command that asked for it stopped`, code 5), an
  empty batch (`stopped: no session of this batch started`, code 5), a refused start (`a restore
  is already running…`), a busy store in the run (the busy line, code 1): each `progress` sequence
  holds the finished line once, as its last.
- An id not in the set → `failed <short>: no longer offered for restore` first, code 1; a session
  `refuse` names → its line, never opened; `gone` → `failed`, the run goes on, code 1.
- A second `start` while running → `a restore is already running; wait until it has finished`,
  nothing planned; after `done` → accepted.
- Heartbeat: 10 s (the fake clock) without a line → `waiting for 2 sessions` to `write`, not to
  `progress`; with `heartbeatMs` 1000 every second.
- `dismiss(bootId)` of the banner's boot → stored, the next `banner(rows)` has `shown` false;
  another id → `this offer to restore is no longer shown`, nothing stored. `banner` called twice
  with the same rows reads the events once (a counting store wrapper).
- A title holding an escape sequence → no control character in any `progress` or `write` line.

**Done when:** a restore can be run, refused, watched, stopped and its banner decided by the
restorer alone; `npm run check` passes.

**At the merge** (after D 34, B 50 and B 51; built beside them): the pinned file list of
`build.test.ts` has D's `chip.ts` and B's `attention.ts` — `banner.ts` goes beside them, and the
allowed imports keep D's `windowChip` and `CHIP_ORDER` and B's `./attention.ts`; S2 10.2's `kv`
table has B's `attention_seq` row — C's `window_restore_dismissed` row stays after it.

**Not in it:** the server (74), the page (75).

---

### Task 75: The banner on the page

**Depends on:** 70 · **Merges after:** D 37, B 55 · **Wave:** 2 · **Design:** S2 12.7, 12.9 (focus), 15.4 (text, not markup), 6.3 (the WSL-restarted notice it appears under) · **Contracts:** 2.2 (`BannerPayload`, `restore-progress`) · **Decisions:** C10, C18, C21 · **Shared files:** `web/app.js`, `web/index.html`, `test-page/helpers/shell.ts` (a function)

**Goal.** At the top of the list, the banner the view model sends: the sessions with their
checkboxes, "Restore <n>", "Not now", and the report of every run.

**Files**
- Create: `web/banner.js` (`createBanner(root, deps)` → `{ render(banner), progress(text) }`;
  `deps`: `act`, `say`, `timeZone()`), `web/banner-text.js` (no DOM, pure:
  `bannerHeading(banner, nowMs, timeZone)`, `activityTime(ns, nowMs, timeZone)` — `timeZone` an
  IANA name or `UTC`, used through `Intl.DateTimeFormat`; the page passes its own,
  `Intl.DateTimeFormat().resolvedOptions().timeZone` —, `entryText(entry, timeZone)`,
  `restoreLabel(count)`), `web/banner.css`, `test/web/banner.test.ts`, `test-page/banner.test.ts`
- Modify: `web/index.html` (`<div class="banner" id="banner" hidden></div>` inside `#list-zone`
  before `#list`; the stylesheet); `web/app.js` (create it; `received()`'s `case 'list'` calls
  `banner.render(message.banner)`; the branch of `case 'notice'` that task 70 left out gives
  `restore-progress` to `banner.progress`; `overLimit` knows the two kinds);
  `test-page/helpers/shell.ts` (a new function `bannerWorld`, after `actsWorld`: a scripted
  stand-in server, as `actsWorld`, that sends the lists and notices the test gives and answers
  each `act` as told)

**Behaviour.** The offer is shown when the payload is not null and `shown` is true. The heading
`Before the restart (last activity <activityTime>) <n> sessions were open` (`1 session was open`);
one checkbox per entry, labelled `entryText` (`<short>  <title> · no exit recorded` or `· ended
<HH:MM>`, `· was working`), first ticked by `preselected`; the ticks stay across lists of the same
`bootId` (an entry that left is dropped, a new one takes its `preselected`) and start again for
another boot. "Restore <k>" (k the ticked count) sends `act restore` with the ticked ids in the
banner's order, disabled at 0 and while `running`; "Not now" sends `act dismiss-restore` with
`bootId`; each acts once (C10). While `running`: `A restore is running.` in place of the buttons,
the checkboxes disabled. A refused result is shown in the banner as its line. The report (C10) is
drawn while it holds lines, under the offer's place, also when the payload is null or `shown`
false; `restore finished: …` is its only boundary. Banner and report take at most 40 % of the list
zone's height and scroll inside it. Their controls prevent their mousedown's default, so the
keyboard stays with the list or the terminal; Tab and Space work on them as the browser's own.

**Tests** (platform: `realTestPlatform` for the page through `bannerWorld`; `test/web` in node)
- `banner-text`: `activityTime` today, yesterday, earlier this year, another year, at 00:05 and
  23:59, each for `UTC` and for `Europe/Prague` passed as the parameter (no case depends on the
  machine's time zone: CI is UTC, the user's WSL is not); headings for 1 and 3; `entryText` for
  both ends and `was working`.
- `banner.test.ts` (page): a banner of three, two preselected → two ticked, `Restore 2`; a click
  unticks → `Restore 1`, the list keeps the keyboard; Restore → the world got `act restore` with
  the one id; a second click while it waits, and a held Enter on the focused button, send nothing
  more; Not now → `act dismiss-restore` with the boot id; a new list of the same boot keeps the
  ticks, of another boot resets them; `shown: false` or null → no offer shown; `running` → buttons
  gone, checkboxes disabled; progress notices shown in order, the `not started` lines after a
  `stopped:` line stay in the same report, `restore finished: 3 started` gives the ×, the × removes
  the report; a report whose run came while the payload is null (a command's restore) and one
  while `shown` is false are drawn; a refusal `a restore is already running; …` shown; "a hostile
  title and report line are text": a title `<img src=x onerror=…>` and a line holding markup
  create no element (`querySelector('img')` null).
- C10, C21: 30 entries and 200 report lines → the filter's field and at least one row of the list
  stay visible, the banner scrolls inside; with a terminal shown, a banner that comes and goes
  (lists with and without it) sends no `resize` and leaves the terminal's box and the header's
  height as they were; a title of 1,024 bytes wraps inside the list zone and does not widen it; a
  `restore-progress` notice and the `act restore` result move neither the selection nor the
  keyboard; with D's dialog shown (this task merges after D 37), the banner takes no click and a
  restore's lines move no keyboard.
- Every existing page case passes (the banner draws nothing in their lists).

**Done when:** the page shows and acts on the banner the server sends, and shows every run's
report; `npm run check` passes.

**At the merge** (after D 37 and B 55; built beside them):
- If D was merged first: `index.html` has `#editor`, `#toast` and `edit.css`; `app.js` has D's
  dialog with its modal rule (while it is shown `app.js` moves the keyboard nowhere and acts on no
  list key; its scrim takes the banner's clicks too, which needs nothing here), `overLimit`'s
  entries for D's kinds, and `list.selected` passed for every pane; `scriptedList`'s rows have D's
  chip shape (task 34) and `editWorld` is at the end of `shell.ts` — `bannerWorld` goes after
  `actsWorld`.
- If B was merged first: `app.js` has B's window title in `case 'list'`, its chord gate, `notify`
  in `received()` and the `#notify-on` button; `index.html` has `attention.css` — C's import goes
  after B's, `banner.render` beside B's title in `case 'list'`, `banner.css` after `attention.css`,
  `#banner` before `#list`.

**Not in it:** the server's side (73, 74); a key for restore (stage E's switcher); the design text
(C10 and C21 are recorded by task 73).

---

### Task 81: The second window after a cold start — the pages mark

**Depends on:** 70 · **Wave:** 2 · **Design:** S2 5.1 (step 2 of `skydeck window`, the wait after a restart), 6.3 (the page's retries), 8.3 (`GET /status`), 10.2 · **Contracts:** 2.2 (`StatusAnswer.windowExpectedMs`), 2.3 (`createPageMark`) · **Decisions:** C20 · **Shared files:** —

**Goal.** After a WSL restart, a server's crash or `--stop`, while an old window is still open, a
command that would open a window waits for that window to come back instead of opening a second
one — W16's case. The wait is the server's fact (C20); this task builds the mark and the commands'
side, and task 74 wires the mark into the server.

**Files**
- Create: `src/window/page-mark.ts`, `test/window/page-mark.test.ts`
- Modify: `src/window/client.ts` (`readStatus` takes the optional `windowExpectedMs`: a whole
  number of ms or null; another type is an answer that cannot be read); `src/cli/commands/window.ts`
  (stage A's `launch`: unless `--new-window`, it first reads `GET /status`; while the server is
  starting with `windowExpectedMs` set, or `windowExpectedMs` is above 0, and no page is connected,
  it prints C20's line on stderr once and looks again every 100 ms, at most for the start wait and
  the 7 s; a page → `skydeck window: a window is already open`, no token, no Edge; the deadline → it
  goes on as today; `--print-url` and `--new-secret` keep their ways); `test/fixtures/fake-serve/fake-serve.ts`
  (`FAKE_SERVE_WINDOW_EXPECTED_MS=<ms>`: `/status` reports that many ms counting down from when it
  was ready; `FAKE_SERVE_PAGES_AFTER=<ms>:<n>`: `/status` reports `n` pages once `ms` have passed);
  `test/cli/commands/window.test.ts` (cases at the end); `docs/design-step-2.md` (5.1's paragraph on
  the wait after a restart, 8.3's `GET /status` row, 10.2's `kv` table: C20)

**Behaviour.** As C20 and 2.3. `skydeck window`'s restart wait of stage A (the old server's
`pages`) stays as it is; C20's wait comes after it, inside `launch`, so that task 76's move of
`launch` into `window-open.ts` gives C12's window the same wait.

**Tests** (platform: `testPlatform` for `page-mark.test.ts`; `realTestPlatform` with
`windowMachine` and the fake serve for the command, as stage A's restart-wait cases)
- `createPageMark`: `foundAtStart` true with the key in the store, false without; "a mark left by a
  dead server is removed by the next server's first refresh without a page": the first `update(0)`
  removes it; then `update(1)` writes it, `update(2)` writes nothing, `update(0)` removes it; a
  store that is busy at a write → one log line by kind, written at the next call; `expectedMs`:
  7,000 while the start is not done, counting down from `startDoneNs`, null after 7 s, null once
  a page was seen, null when nothing was found.
- `skydeck window` against a fake serve that expects a window (`FAKE_SERVE_WINDOW_EXPECTED_MS=3000`)
  and gets a page after 1 s → C20's line on stderr once, `skydeck window: a window is already
  open`, the Edge stub never run, no token minted; no page → Edge once, after the deadline; with
  `--new-window` → no wait; without the expectation → Edge at once, no line.
- "The wait is the server's fact": two `skydeck window` started one after the other while the fake
  expects a window both wait for the same deadline (the second does not open a window at once).
- Every existing case of `window.test.ts` passes unchanged.

**Done when:** a command that would open a window waits while the server expects one back; `npm
run check` passes.

**At the merge:** nothing to resolve with another stage (`window.ts`, `client.ts` and the fake
serve are stage C's alone); task 76 moves `launch` with this wait.

**Not in it:** the mark in the server, the status field and the first refresh's removal (74); a
mark left after a PC restart costs one wait of 7 s (C20), which W16 and section 6 ask the user
about.

---

### Task 74: The server — launches, restore and the routes wired

**Depends on:** 72, 73, 81 · **Merges after:** D 36, B 54 · **Wave:** 3 · **Design:** S2 8.3, 11.3, 11.4, 12.7, 8.2.6 (first size), 5.5 (the stop), 7.3, 7.8, 14 · **Contracts:** 2.3, 2.5 · **Decisions:** C2, C4, C6, C7, C9, C19, C20, C22 · **Shared files:** `src/window/server.ts`

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
  with the handler's `closed` signal as the `asker` (C22), a refusal as its line, the finished line
  and an outcome with code 1) and `launchState` (`starting` until `ready`, `stopping` from the
  first line of the orderly stop); `createPageMark` over the server's store, made at the start
  before the first tick (so that `foundAtStart` reads the mark a dead server left), its
  `update(pages.count())` called in `afterRefresh` beside `decidePostponed`, and `GET /status`'s
  `windowExpectedMs` from its `expectedMs` with the end of the start (C20); the orderly stop's first
  step is `await restorer.stop()`, before the tick's stop and `control.close()`
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
- The take mark end to end (C19, task 80): a restored session whose program ends AFTER the
  restore stopped waiting for it (`restoreStartTimeoutSeconds` 2, a `claudeCommand` that sleeps
  3 s and then exits 3) → at the next refresh its lock, which the restore renewed, is gone, and
  its ended bar's Resume is not refused; a restore whose keeper says hello after the 5 s of
  `open()` (stage A's `slowPython` seam, as in `test/window/window-terminal.test.ts` about line
  539) → the session is started, not `failed … taken over`.
- "A restore asked for by a command stops when its asker goes" (C22): a `POST /restore` whose
  connection the test closes after the first `started` line → the server lives, the sessions
  already opened go on (their stand-ins run), the rest are `not started` in the pages' notices,
  then `restore finished: …`, and a later `act restore` is accepted.
- Every run's notices to the pages end with exactly one `restore finished: …` line (a run asked for
  by a page, by a command, one stopped by the server's stop).
- The pages mark (C20): `window_pages_open` is in the store within 2 s of a page's `start`,
  removed within 2 s of the last page closing, and still there after `stop()` with a page
  connected; a server started with the mark in the store (a dead server's) and no page removes it
  at its first refresh, and its `GET /status` says `windowExpectedMs` while it starts and counts it
  down to null within 7 s of the end of its start; a page that connects meanwhile ends it at once.

**Done when:** a page and a command can restore through the server, the banner follows the store
and the run, and `POST /resume` and `/new` start sessions with the rules of 2.5; `npm run check`
passes.

**At the merge** (after D 36 and B 54; built beside them):
- If D was merged first: `server.ts` passes D's required `changed` and `prs` to `createActions`
  and the tick has `reloadNow` — the restorer's `changed` then calls `tick.reloadNow()` instead of
  `tick?.reload(); pages.pushList()`, and C's two deps go beside D's; the orderly stop waits for
  D's background fetches.
- If B was merged first: the server makes B's `createSeen` and `createAttention`, the tick takes
  `attention`, `listFor` passes the attention facts to `buildListMessage` — C sets `banner` on its
  result —, and the orderly stop calls `seen.stop()`; `restorer.stop()` stays the stop's FIRST
  step, before D's and B's. C changes nothing in `tick.ts`.

**Not in it:** the commands (76, 77), the page (75).

---

### Task 76: The command line's side — the client, `--window` for `resume` and `new`

**Depends on:** 70, 81 · **Wave:** 3 · **Design:** S2 11.4, 8.3, 5.1 (finding the server; step 2's window), design 7.5 (the commands' options) · **Contracts:** 2.4 (client, `window-open.ts`, `window-requests.ts`), 2.5 · **Decisions:** C11, C12, C14 (its function), C16, C17 · **Shared files:** —

**Goal.** Everything the commands need to send to the server, built and tested against the fake
serve, and `--window` on `resume` and `new`. One pull request; the move of `launch` and `timesOf`
out of `window.ts` is a commit of its own in it ("moved unchanged"), so that a review can skip it.

**Files**
- Create: `src/cli/window-open.ts`, `src/cli/window-requests.ts`, `test/window/client-launch.test.ts`,
  `test/cli/window-requests.test.ts`
- Modify: `src/window/client.ts` (the three methods and their readers: an answer of another shape
  cannot be read; 400 and 413 give 2.5's refused-request line); `src/cli/commands/window.ts`
  (imports `windowTimes` and `launchWindow` instead of its private `timesOf` and `launch`, which
  move unchanged, task 81's wait with them; `launchWindow` gets the `say` of 2.4);
  `src/cli/commands/resume.ts`, `src/cli/commands/new.ts` (`--window`; `whereFrom` refuses two of
  `--here`, `--tab`, `--window`; with `--window`, `resume` resolves `<ref>` as today and calls
  `resumeInWindow` with the id — no `prepareResumeById` here —, `new` calls `newInWindow` with
  `platform.cwd`, the label, the group and `parsed.rest`); `test/fixtures/fake-serve/fake-serve.ts`
  (C3's routes: without `FAKE_SERVE_LAUNCH` no `launch`, as today; `FAKE_SERVE_LAUNCH=answer:
  <LaunchAnswer JSON>` answers it to `/resume` and `/new`; `silent` never answers them; `status:
  <code>` answers that HTTP status with `{ error: 'body: too long' }`; `FAKE_SERVE_RESTORE=<JSON
  array of RestoreStreamLine>` writes them 100 ms apart, `silent-after:<n>` writes `n` lines and
  then nothing; `FAKE_SERVE_REQUESTS=<path>` appends each launch request's JSON;
  `FAKE_SERVE_STATE` `starting` or `stopping` for `launchState`; task 81's knobs stay)
- Test: `test/cli/commands/resume.test.ts`, `test/cli/commands/new.test.ts`,
  `test/cli/commands/window.test.ts` (unchanged: the move's check); `docs/design-step-2.md` (C11,
  C12: 11.4), `docs/design.md` (7.5: the options)

**Behaviour.** As 2.4 and 2.5. `windowServer`: `findServer(deck, appRoot, computeBuild(...))` —
`ours` and `other-build` are used, the rest refused. `resumeInWindow` / `newInWindow`: the
request; every answer line on stderr through the sanitiser; then, unless the code is 2 or 3,
`client.status()`, and with 0 pages `launchWindow(deck, client, ping, false, times, say)` — a
SkydeckError there is C12's line —, or under `CLAUDECODE` no window and C12's `no window is open;
run skydeck window in a terminal of your own`. `restoreInWindow`: with 0 pages the same window
first (not under `CLAUDECODE`), then the request, every line on stdout. The usage texts name
`--window` (`Without --here, --tab or --window, the configured "terminal" decides.`).

**Tests** (platform: `realTestPlatform`; `windowMachine` and `startFakeServe` of
`test/helpers/window-machine.ts`. The fake serve listens on no port and the fake Edge refuses
47613, so a window `launchWindow` opens is never used: every case with 0 pages sets `pageMs` small
and expects C12's line `the window could not be opened: Edge was started, but no window connected
within …; open the window in any browser with skydeck window --print-url; run skydeck window`)
- Client: each method's request as 2.2 says (the fake's request file); `503 starting` twice, then
  an answer → the answer; `stopping` → its line; `silent` with `answerMs` 300 → the no-answer
  line; a 404 route → `unknown-route`; 400 and 413 → the refused-request line; an answer of another
  shape → cannot be read; `restore`'s lines to `onLine` in order and the outcome; `silent-after:1`
  → the stopped-answering line after `answerMs`; a stream ended without an outcome → the same line.
- `resume --window` against the fake answering `{ code: 0, lines: ['skydeck: original flags
  unknown; resuming with defaults'], sessionId }` → that line on stderr, exit 0, the request's
  `sessionId` the resolved id, no handoff file, no lock in the store (the command took none); with
  pages 0 → the Edge stub ran once with a token, the token given up, C12's line, exit 0; with pages
  1 → not run; Edge missing → C12's line, exit 0; an answer with code 4 → exit 4 and a window; with
  code 2 or 3 → that exit and no window.
- "Under CLAUDECODE a command opens no window": `CLAUDECODE=1`, pages 0 → the request sent, the
  Edge stub never run, `no window is open; run skydeck window in a terminal of your own`, the
  answer's code.
- Each row of 2.5's table: no server, one that does not answer (`FAKE_SERVE_MODE=silent`), another
  checkout, an older server (no `FAKE_SERVE_LAUNCH`), `stopping`, a refused body (a label of 1,025
  bytes against the real parser of the fake: 400; `FAKE_SERVE_LAUNCH=status:413`) → its line, exit
  1, no Edge.
- "the answer's lines are printed sanitised": a line with an escape sequence and a CR → printed
  without them.
- `new --window --label x --group y -- --model opus` → the request `{ dir: <cwd>, label: 'x',
  group: 'y', flags: ['--model', 'opus'] }`; without `--label` → `label: null`.
- `restoreInWindow` with pages 0 → the window is tried before the request (the request file is
  written after the Edge stub's run); under `CLAUDECODE` → no window, the request sent.
- `--here --window`, `--tab --window` → usage error, exit 2, nothing sent.
- `skydeck window`'s every existing case passes unchanged, task 81's included.

**Done when:** `resume --window` and `new --window` send to the server and say what C11 and C12
say in every case of 2.5, and `skydeck window` behaves as before; `npm run check` passes.

**At the merge:** nothing to resolve with another stage (`client.ts`, `window.ts`, `resume.ts`,
`new.ts` and the fake serve are stage C's alone); they come after task 81's changes.

**Not in it:** `"terminal": "window"`, `restore` and `R` (77); the end-to-end cases through the
real server (77).

---

### Task 77: `"terminal": "window"` — the configuration, `restore`, `R`, `doctor`

**Depends on:** 74, 76 · **Merges after:** D 35 · **Wave:** 4 · **Design:** S2 11.4, 16.4 (`terminal`), 4.4 (the interactive list's `R`), 16.3, design 7.5, 7.6 "Where", 7.8 · **Contracts:** 2.4 (`whereFor`, `restoreInWindow`), 2.5 · **Decisions:** C12, C13, C14 · **Shared files:** `src/platform/config.ts`, its test

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
  `prepareResumeById`; `opened <short> in the window` — with `; no window is open; run skydeck
  window` when no page is connected — or, for a failed launch, `starting <short> in the window
  failed; the details are printed when the list ends` with the lines kept for the end, as for a
  tab; a refusal (codes 2–4) and a SkydeckError of 2.5 are the message line, as today's refusals;
  no window is opened); `src/cli/commands/doctor.ts` (`ok terminal: window
  (sessions start in the skydeck window; resume, new and restore need skydeck window to run)`)
- Create: `test/cli/window-e2e.test.ts`, `test/cli/commands/restore-window.test.ts`
- Test: `test/platform/config.test.ts`, `test/cli/commands/doctor.test.ts`,
  `test/cli/tui/run.test.ts`, `test/cli/commands/resume.test.ts`, `test/cli/commands/new.test.ts`,
  `test/cli/commands/restore.test.ts` (its usage text); `docs/design-step-2.md` (C13, C14: 11.4,
  16.4)

**Behaviour.** As C13 and C14. With `"here"` or `"wezterm"` nothing changes but `--window`. A
user who never sets the key sees only the new option in `--help`.

**Tests** (platform: `realTestPlatform`; the fake serve for the refusals, `startTestServer` for
`window-e2e.test.ts`; the interactive list's own test harness for `R`)
- Configuration: `"window"` accepted; `"tabs"` refused with the new message; the default stays
  `here`.
- `whereFor`: every pair of configured value and option of C13.
- `window-e2e.test.ts`, against a real test server and the stand-in. Every case connects a test
  page first (`connectTestPage`), so no window is opened, except the one case "no page" (below):
  `resume <ref>` with
  `"terminal": "window"` → the session runs in a window terminal (its record), exit 0; `--tab` →
  the same; `--here` → the handoff file as in step 1, no request; `new --window -- --model opus` in
  a sandbox directory → a terminal of the new session with `buildNewCommand`'s argv;
  `restore --yes` with three sessions of an earlier boot (task 74's helper) → the server's lines on
  stdout as they come (`started …`, `restore finished: 3 started`), exit 0; with one failing →
  exit 1; `R` in the list → `opened <short> in the window` and the terminal; no page → `R`'s
  message ends `no window is open; run skydeck window` and the Edge stub never runs; `restore
  --yes` with no page → the Edge stub ran before the first `started` line (`pageMs` small: C12's
  line, then the restore).
- `restore-window.test.ts`, against the fake serve: no server → the not-running line and no
  prompt (stdin a terminal: the prompt never shown); `--dry-run` → no request (the fake's request
  file empty), the list printed; the chosen ids and `--all` in the request; `silent-after:1` →
  11.4's line, exit 1; an outcome with code 5 → the line of C14, exit 5; an older server → C11's
  line.
- `doctor` with `"terminal": "window"` → its `ok` line; the `wezterm` and `here` lines unchanged.
- Every existing case of the commands, the list and `doctor` passes unchanged.

**Done when:** `"terminal": "window"` sends `resume`, `new`, `restore` and `R` to the window as
S2 11.4 says, end to end; `npm run check` passes.

**At the merge** (after D 35; built beside it): `config.ts` has D's `ticketUrl` key and its check,
and `config.test.ts` D's cases at the end; C changes only the `terminal` type, its value check and
its message, and adds its cases after D's.

**Not in it:** the documentation (79).

---

### Task 79: Documentation of stage C

**Depends on:** all · **Merges after:** B 50 ("Updating"), D 39, B 56 · **Wave:** 5 · **Design:** S2 11.4, 12.7, 16.4, 18 (W16), 19 · **Contracts:** — · **Decisions:** — · **Shared files:** `docs/install.md`, `docs/manual-checks.md`, `README.md`, `docs/design-step-2.md`

**Goal.** A user can use restore in the window, `--window` and `"terminal": "window"` from the
documents alone, and can run W16 without risk to their work.

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (S2 18's
  W16 row as below, S2 19's stage C line, and any decision of 1a still missing from it)

**Content (contract)**
- `docs/install.md`:
  - The two sentences stage C makes false are corrected: the paragraph "This is stage A of step 2 …"
    (`resume`, `new` and `restore` start `claude` in the terminal you type them in — now: unless
    `--window` or `"terminal": "window"`; restoring into the window is no longer "later"), and
    "`terminal` stays `"here"` or `"wezterm"` in this stage" in the configuration's part.
  - In "Using the window": after a WSL restart (or a PC restart) the banner, its checkboxes,
    Restore and Not now (it does not come back for that restart; `skydeck restore` still works);
    the report; one restore at a time; a restore started from the banner has no stop —
    `skydeck window --stop` ends it, and the sessions it opened go on —, while Ctrl+C stops one that
    `skydeck restore` asked for (C22). `skydeck resume <ref> --window`, `skydeck new --window`: they
    never start the window's server; a session they start gets the **server's environment, not the
    shell's** (S2 5.2: the one of the shell that ran `skydeck window`); it is listed under Open and
    nothing selects it; a window is opened when none is open (not after a usage or reference error,
    never from inside a Claude Code session, C12). The configuration table's `terminal` row with
    `"window"` (what `--tab` and `--here` mean then; `restore` and `R` too). 2.5's lines in a short
    table "When the window cannot take it". `show`'s `(in the skydeck window)`. The restore settings
    and `claudeCommand` are the server's, read when it starts (`skydeck window --restart` after a
    change). C20's wait: after a WSL restart, a crash or `--stop`, `skydeck window` (and a command
    that opens a window) waits up to 7 s for the open window to come back, and says so; after a PC
    restart with the window left open it may wait 7 s for a window that cannot come.
  - "Known limits of stage C": a window that connects during a restore sees its lines from then
    on; a restore started from the banner cannot be stopped from the window; `R` opens no window;
    the first update from stage A may still open a second window once (the old server wrote no
    mark: close the window first, as "Updating" says).
- `README.md`: `--window` in the command table's `resume` and `new` rows (the formatter re-pads the
  whole table when a row widens, which is why this task merges after D 39 and B 56); one sentence
  on restore in the window.
- `docs/manual-checks.md`: a part of its own, "The window (step 2, stage C)", after B's and D's,
  with W16; the sentence of the stage A part that says W16 comes with a later stage (about lines
  265–267, which B 56 edits too) names stage C's part instead.
- **W16. WSL stops with the window open.** It opens with what the user loses and how to prepare,
  before any step:
  - What `wsl --shutdown` ends: every process of every WSL distribution at once — every `claude`
    in the window and in every WSL terminal (a turn in progress is cut off), shells and editors
    running in WSL (unsaved text), builds and tests, containers of Docker Desktop's WSL engine,
    SSH tunnels and port forwards, VS Code's WSL window (it reconnects). Windows programs, the Edge
    window among them, stay. A PC restart ends the same and everything else.
  - Prepare: a moment when ten minutes without WSL cost nothing; save in every WSL editor; stop
    builds, containers and tunnels you would miss; end every real `claude` session yourself with
    `/exit` once its turn is over — a session ended that way is not offered by the banner and
    resumes as always. In W, `skydeck ls`: nothing may be `running`, `working` or `waiting` but the
    three throwaway sessions below; if anything else is, stop here.
  - Set-up: `mkdir -p ~/skydeck-try/a ~/skydeck-try/b ~/skydeck-try/c`; three throwaway sessions in
    the window, one in each folder (stage A's part, "A throwaway session in the window"), one
    prompt in each; give the one in `c` a task that keeps it `working` for a minute. Write down
    their short ids (the header shows them).
  - Steps: in P, `wsl --shutdown`; the window shows `skydeck's server is not answering (since …)`
    within a few seconds (write down how long). Open W again; `skydeck window`: it says `waiting up
    to 7 s for the open window to come back; …`, then `skydeck window: a window is already open`,
    and no second window opens (if one does, write it down and close it — the old one is the window
    that showed the bar). The window says `WSL has restarted since <time>: …`; at the top of the
    list the banner `Before the restart (last activity today at <time>) 3 sessions were open`, the
    three ticked, `c`'s with `was working`, `Restore 3` and `Not now`. If a session you did not
    make is offered, untick it. Restore 3: the three under Open as `starting…`, then running, in
    slots 1–3; the report says `started <short> <title>` for each and `restore finished: 3
    started`; each terminal shows its conversation. Write down the banner's words and the time
    from Restore to the last `started`.
  - An optional second part (one more `wsl --shutdown`, prepared the same way): Not now → the
    banner goes; `skydeck window --restart` → it does not come back; `skydeck restore --dry-run`
    in W still lists the three.
  - An optional third part, with no restart: `/exit` in the throwaway session of `a` first, then
    close every skydeck window and keep the server running (`skydeck doctor`: `server` running, 0
    pages); `skydeck resume <its short id> --window` in W → the window opens by itself and the
    session is listed under Open (nothing selects it).
  - An optional fourth part, for the next ordinary PC restart (nothing to prepare beyond your own
    habits): leave the window open when you restart the PC; afterwards does `skydeck window` say
    `waiting up to 7 s …` before it opens the window? Write it down (C20's cost).
  - Clean up: `/exit` in each throwaway session; your own sessions are listed by `skydeck` and
    resume as always.
- S2 18's W16 row (in `docs/design-step-2.md`) becomes:

| # | Check | Stage | Decides |
|---|---|---|---|
| W16 | WSL stop drill: `wsl --shutdown` with the window open and three throwaway sessions in it (and no real session running). The bar of 6.3 appears; after `skydeck window` the old window comes back (no second one) and says WSL restarted, and the banner offers the three; "Restore 3" brings them back into the window. Optional: Not now survives a server restart; `resume --window` opens the window by itself; after a PC restart with the window left open, whether `skydeck window` waits. | C | 5.1, 6.3, 12.7, 11.4 |

**Steps**
- [ ] Check every line the new text quotes against the code and the test that holds it — none of
      them is checked by running `skydeck` (a "clean `SKYDECK_HOME`" is no sandbox: `show` would
      read the real `~/.claude`, `window` reach port 47613 and the real Edge). The lines of 2.5 are
      held by 76's and 77's tests; the banner's words by 75's; the report lines by 73's and 74's;
      `show`'s mark by 78's; the configuration's message and `doctor`'s line by 77's; C20's line
      and wait by 81's. A line no test holds is not written.
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can use stage C from `docs/install.md` alone, and W16 is in
`docs/manual-checks.md`, in stage C's part, with its preparation first.

**Not in it:** code, tests, running any `skydeck` command.

**At the merge** (after B 50, D 39 and B 56; built beside them): `install.md` has B's "Updating"
order (close the window first), D's editing and B's attention parts; `manual-checks.md` has D's
part (W27–W29) and B's (W11, W19, W21), and B's edit of the stage A part's sentence about later
stages; the README's command table is as D and B leave it. C's parts go after them; C's edit of the README
table comes last, so the formatter's re-padding is done once.

## 4. Design coverage

| Design | Where |
|---|---|
| S2 4.4, the stage C rows | `src/sessions/restore.ts` 71; `config.ts` 77; `resume`, `new` 76, 77; `restore` 77; `show` 78; the interactive list's `R` 77 |
| S2 8.2.3, `restore`, `dismiss-restore`, `banner`, `restore-progress` | 70 (types), 72 (acting), 73 (banner, progress), 74 (wiring), 75 (page) |
| S2 8.2.6, the first size of a terminal a command or a restore opens | 73 (read per opening), 74 (the last focused page's area) |
| S2 8.3, `POST /resume`, `/new`, `/restore` | 70 (parsing, the socket's side), 74 (acting), 76 (client) |
| S2 5.1, the wait for a window that comes back, also after a cold start | 81 (the command), 74 (the mark written) |
| S2 7.3, 7.8, design 7.6: the lock a restore renews | 80 (the take mark), 74 (end to end) |
| S2 10.1, a running restore; 10.2, `window_restore_dismissed`, `window_pages_open` | 73, 81 |
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
banner in `listFor`, the pages mark after each refresh and the restorer's stop as the stop's first
step; in `web/app.js` it adds the banner and one notice kind, and no key; in `web/index.html` one
element and one stylesheet. It changes nothing in `tick.ts`, `src/window/view/build.ts`,
`sections.ts`, `web/list.js`, `web/keys.js`, `web/help.js` or `web/cards.js`. Two store keys, no
migration. The banner changes neither the header's one height (stage D) nor a terminal's area
(C21).

For stage E: the switcher's "Restore 3 sessions from <time>" (S2 12.7) can be drawn from
`list.banner` — its entries and `lastActivityNs` stay in the payload after "Not now" (`shown`
false) until the next WSL restart — and sent as `act restore` with the preselected ids.

**Follow-ups of stage A on stage C's path:**
- *A restore's renewed lock* (S2 7.3's and 7.8's named limit) — **closed** by task 80 (C19): a
  renewal keeps the take; a found or late keeper of a restore is started and an exit before the
  start gives its lock back, while an older build still reads every value as a lock.
- *A second window after `skydeck window` started a server while an old window is open* —
  **settled** by task 81 (C20) for a WSL restart, a crash and `--stop`: the server expects the old
  window back, and every command that would open a window waits for it. Its cost — after a PC
  restart with the window left open, one wait of 7 s for a window that cannot come — is asked of
  the user (W16's fourth part); the remedy if it happens every day (the boot id in the mark, and a
  look whether Edge still runs on the profile) is a follow-up. The first update from a stage A
  server, which wrote no mark, may still open a second window once.
- *The ended bar of a session the filter hides* — untouched; restore adds no new case of it.

**Follow-up candidates stage C leaves:** a Stop control in the banner (a restore started from the
banner can be ended only by `skydeck window --stop`, C22); the boot id in the pages mark (above).

## 6. Stage C is ready to try

When task 79 is merged. In a WSL terminal of your own (not a `!` command inside Claude Code), in
the order of stage B's "Updating" (`docs/install.md`): this update comes from a server that writes
no pages mark yet, so close the window first, or a second window opens once.

```sh
# close every skydeck window first (your sessions keep running in their keepers)
cd ~/projects/mine/skydeck
git pull
skydeck window          # restarts the window's server for the new build and opens the window;
                        # your sessions are there again
skydeck doctor          # as before; its terminal line names "window" once you set it below
```

No `npm ci`, no `install` again, nothing new in `~/.claude/settings.json`. Then, with a throwaway
session (`docs/manual-checks.md`, "A throwaway session in the window"), after its `/exit`:

```sh
skydeck resume <its short id> --window   # starts it in the window; prints what resume prints
```

A session started this way gets the window's server's environment (the one of the shell that ran
`skydeck window`), not the one of the shell you typed the command in. If you want every command to
use the window: put `"terminal": "window"` into `~/.config/skydeck/config.json` (create the file as
`{ "terminal": "window" }` if it does not exist). Then `skydeck resume`, `skydeck new`, `skydeck
restore` and `R` in `skydeck` start in the window; `--here` still starts here. Leave the key out and
nothing changes but the new option. The banner shows only after WSL or the PC restarted.

**What only you can check:**
- W16 — the drill, prepared as `docs/manual-checks.md` says first (it ends every WSL process): no
  second window after `wsl --shutdown`, the banner, Restore 3.
- That `skydeck resume --window` opens the window by itself when none is open (W16's third part).
- After an ordinary PC restart with the window left open: does `skydeck window` say `waiting up to
  7 s …` before it opens the window (W16's fourth part)? If it does every day, say so: there is a
  follow-up for it.
- One thing to know: an agent's shell (a `!` command, or Claude Code's own tools) can run `skydeck
  new --window` and start a session in your window while the server runs; it never opens a window
  itself.

## 7. Questions for the lead, and the rulings

Asked with the first version of this plan; the lead ruled on 2026-11-15 with the two reviews, and
the plan above follows the rulings.

1. **A restore that knows a terminal ended** (C8). Ruled: as planned — a session whose window
   terminal ended before it started is reported `failed` at once and its lock given back; the
   signal also stops a restore whose asker went (C22).
2. **The window a command opens** (C12). Ruled, changed: `resume` and `new` open one when no page
   is connected, but not after a refusal with code 2 or 3; `restore` with the window as its
   terminal opens one before its request; `R` opens none and says so; under `CLAUDECODE` a command
   never opens a window.
3. **A server of another build** (C11). Ruled: as planned (used, as the window's own Resume uses
   it).
4. **Where the lock's mark lives** (C19). Ruled: in the last six digits of the lock's time; design
   7.6 says that those digits of a renewed lock are a mark, not time.
5. **`show --json`** (C15). Ruled: unchanged.
6. **What "Not now" stores** (C9). Ruled: the earlier boot whose sessions the banner offers.

Also ruled with the reviews: every run ends with exactly one `restore finished:` line, the page's
only boundary between reports, and the report is drawn while it holds lines (C6, C10); a restore
asked for by a command stops when its asker goes (C22); a batch in which no session started stops
the run (C23); the second window is carried with its line, its named cost and the server's
expectation (C20).
