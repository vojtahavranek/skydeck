# skydeck step 2, stage A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stage A of step 2 as specified in [`docs/design-step-2.md`](../design-step-2.md)
(section 19): the window — the session list on the left, the real terminal of the selected
session on the right, switching between terminals, resume into the window and new — usable on its
own, without any later stage.

**Architecture:** One Node.js server (`skydeck serve`, `src/window/`) serves a page (`web/`,
plain JavaScript modules, no build step) to an Edge app window over HTTP and one authenticated
WebSocket, and keeps the screen side of every terminal in a headless xterm.js. Each terminal's
pty and program are owned by a python3 keeper (`bin/skydeck-keeper`) that outlives the server.
Everything that orders, groups or filters the list is a pure view model (`src/window/view/`);
sessions are started through step 1's guard and lock, unchanged.

**Tech Stack:** TypeScript on Node.js ≥ 24.12 through type stripping, `node:test`,
`node:http`, `node:net`, `node:crypto`; python3 ≥ 3.9 standard library (the keeper); POSIX `sh`
(the launcher, the keep-alive); vendored xterm.js 6.0.0 and addons; `ws`, `playwright` and the
`@xterm/*` packages as development dependencies only.

---

## 0. How to use this plan

**Execution model.** As in step 1 (`docs/plans/step-1.md` section 0): every task below is one pull
request, implemented by a fresh agent that has the two design documents, this plan and the
repository. Each task leaves `main` working with CI green. Tasks of one wave touch disjoint files
and are built in parallel in separate git worktrees; each pull request gets the two reviews of
design 15 before the lead merges it. The implementer brief (kept outside the repository) tells
every implementer the workflow, the review loop and the push rules; this plan does not repeat them.

**Sources of truth.** `docs/design-step-2.md` defines the behaviour; a task names the sections it
implements and this plan does not restate them. "Design 7.6" is design.md, "S2 7.1" is
design-step-2.md section 7.1. This plan adds only what the design leaves open: the decisions of
section 1a, the contracts of section 2 and each task's file list, tests and limits. When the plan
and the design disagree, the design wins and the task says so in its pull request.

**What is fixed here, and what is yours.** Section 2 fixes every interface that two tasks of
different waves meet at: export exactly those names with exactly those signatures. Where the
body is the contract (the frame layout, the message fields, the stand-in's commands, the vendored
file list), copy it. Private helpers are yours. A contract that looks wrong is implemented as
written and named in the pull request; the lead rules.

Tasks 31 and 32 were split out of tasks 26 and 23 in review, and task 33 was added by a ruling on
task 12; their numbers do not follow their waves (step 1's plan did the same with task 14).

**Per-task workflow** (every task, in this order):

- [ ] Worktree and branch `s2a-task-<N>-<slug>` from the latest `origin/main`.
- [ ] Read the design sections the task names, this section's test rules, section 2.1
      (conventions) and the contracts the task names.
- [ ] Write the tests the task lists. `npm test` (and `npm run test:page` once task 20 merged):
      the new tests fail, the old ones pass.
- [ ] Implement. `npm run format`, then `npm run check` until it passes.
- [ ] When the task carries a decision of section 1a with a design update, edit those sections of
      `docs/design-step-2.md` in the same pull request (design 15).
- [ ] Check the task's **Done when** list. Open the pull request titled `Stage A task <N>: <name>`.

**Test rules (design 12, S2 17).** `node:test` and `node:assert/strict`. Never start the real
`claude` (the stand-in of task 3 is `claudeCommand` in every test that starts a program), never
read or write the real `~/.claude` or `~/.local/...`, never use the network, never start a Windows
program. The last is enforced, not only asked for (A32): the sandbox's environment carries
`SKYDECK_TEST_NO_WINDOWS=1`, under which the real platform refuses to start any program under
`/mnt/` or whose name ends in `.exe`; a platform that can start a real process (`realTestPlatform`,
`testPlatform` given real processes) refuses them always; the pure fake starts nothing: it records
the call and returns what its handler scripts, also for a Windows command (ruling); every server a
test starts gets a sandbox `config.json` whose `window.edge` is a recording stub and whose `keepAlive`
is `off`, unless the test is about them; and no test links the real `/run/WSL/1_interop`. Every
test runs under the sandbox of `test/helpers/sandbox.ts`. A server under test listens on a port
the system picks (A6). **Two test platforms** (task 5, 2.2): `testPlatform` (fake clock, fake
`/proc`, fake processes) for logic, and `realTestPlatform` (real clock, real `/proc` and boot id,
`process.pid`, real processes that always refuse Windows programs, the programs a keeper and the stand-in
need linked into the sandbox's `bin`) for every test that starts a keeper, the stand-in or a
server, or judges a real process alive: the tests of tasks 9, 15 (the lock with live processes),
16, 21, 22, 23, 24 (keepers), 25 and 26–29. With the fake clock a keeper's `startBy` lies in its
real past and its pid lines count as dead. A test that starts keepers kills them in `t.after` through
`killKeepersIn` (task 5), which first asserts that the directory lies under the sandbox's root
(skydeck itself never stops a keeper; the test owns its own). **Page tests** (task 20's
`test-page/helpers/browser.ts`, ruled on #51): Chromium runs with a sandbox's environment (another
home, no display) and keeps its and Playwright's temporary files in the sandbox; its pages run in
the UTC time zone with the language `en-US`; a page reaches nothing but `127.0.0.1` — no host name
resolves, not even `localhost`, and neither `fetch`, a WebSocket nor WebRTC reaches another
loopback address (the smoke test proves it against listeners on `127.0.0.2`).

**Local prerequisites.** Node 24 first on `PATH`; python3 ≥ 3.9 (3.12 on a WSL machine);
after task 20, a Chromium for Playwright in `~/.cache/ms-playwright`: Playwright 1.60.0 uses
Chromium build 1223; where it is not installed yet, run `npx playwright
install chromium` (no `--with-deps`, no `sudo`; ruling 6).

## 1. Tasks and waves

Task 0 is `main` at 394d3e6: step 1 complete, the design of step 2 merged.

| # | Task | Depends on | Wave | Size (code + tests) |
|---|---|---|---|---|
| 1 | Contracts: page–server messages, keeper frames, the server's internal interfaces | 0 | 1 | ~550 |
| 2 | Vendored xterm.js and the development dependencies | 0 | 1 | ~350 + vendored files |
| 3 | The stand-in program | 0 | 1 | ~450 |
| 4 | Step 1 changes: launching, `LaunchSpec`, `prepareNew`, the store's write guard, `kv` keys | 0 | 1 | ~450 |
| 5 | Step 1 changes: platform — processes, sockets, timers, randomness, runtime-directory rule, `window` configuration; the test platforms and safety helpers | 0 | 1 | ~850 (two jobs; see the task) |
| 6 | Step 1 changes: the launcher — core limit for `serve`, the cache marker | 0 | 1 | ~250 |
| 7 | The keep-alive script | 0 | 1 | ~250 |
| 8 | Pure helpers: program environment, pid lines, Edge arguments, profile folder, links, flags | 0 | 1 | ~550 |
| 31 | The page's key table and age format (`web/keys.js`, `web/format.js`) | 0 | 1 | ~450 |
| 9 | The keeper | 1, 3, 5, 7 | 2 | ~800 (one file of python and its tests) |
| 10 | WebSocket | 2, 5 | 2 | ~450 |
| 11 | Authentication: secret, launch tokens, proofs | 1, 4, 5 | 2 | ~500 |
| 12 | Screen side | 1, 2 | 2 | ~550 |
| 13 | View model | 1 | 2 | ~550 |
| 14 | Static files, HTTP answers and the build | 2, 5 | 2 | ~450 |
| 15 | Runtime directory, server files, the lock, the logs | 4, 5, 8 | 2 | ~550 |
| 16 | Terminal core: keeper connections and the registry | 9, 12, 15 | 3 | ~650 |
| 17 | Pages: handshake, streams, sizes, backpressure | 10, 11, 14 | 3 | ~650 |
| 18 | Control socket and its client | 11, 15 | 3 | ~450 |
| 19 | Edge, the keep-alive and the interop link | 5, 7, 8, 15 | 3 | ~500 |
| 20 | CI and the page-test leg | 2, 9, 14 | 3 | ~300 |
| 33 | The snapshot seam: the unfinished escape sequence | 12 | 3 | ~400 |
| 21 | The window terminal; sessions in terminals | 4, 16 | 4 | ~600 |
| 22 | Server lifecycle for commands: start, find, stop | 15, 18 | 4 | ~500 |
| 32 | Actions: resume, new, close, open link; the resume card's payload | 1, 4, 8 | 4 | ~450 |
| 23 | The server: assembly, tick, `skydeck serve` | 4, 5, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 32 | 5 | ~550 |
| 24 | `doctor`, `install`, `uninstall` | 2, 5, 15, 18, 19, 22 | 5 | ~600 |
| 25 | `skydeck window` | 22, 23 | 6 | ~550 |
| 26 | The page shell: connection, key, app state | 20, 23, 31 | 6 | ~550 |
| 27 | The list | 26 | 7 | ~550 |
| 28 | The terminal view | 26 | 7 | ~650 |
| 29 | The right side: header, cards, the new form, the key help | 26 | 7 | ~600 |
| 30 | Documentation of stage A | all | 8 | docs only |

```
wave 1:  1  2  3  4  5  6  7  8  31
wave 2:  9  10  11  12  13  14  15
wave 3:  16  17  18  19  20  33
wave 4:  21  22  32
wave 5:  23  24
wave 6:  25  26
wave 7:  27  28  29
wave 8:  30
```

The critical path is stand-in → keeper → terminal core → window terminal → server → page shell →
terminal view. Waves 4 and 5 are narrow because the server's assembly needs every server part;
the page is split so that wave 7 runs three tasks at once (A16). The actions (32) and the pure
key table (31) were taken out of the server's assembly and the page shell so that both stay one
review long.

**Disjoint files in a wave.** Every new module is its own file with its own test file. The files
more than one task edits, and who edits them, never two tasks of one wave:

| File | Tasks (wave) |
|---|---|
| `package.json`, `package-lock.json` | 2 (1), 20 (3), 26 (6) |
| `tsconfig.json` | 2 (1: adds `scripts`), 20 (3: adds `test-page/**/*.ts`) |
| `.github/workflows/ci.yml` | 9 (2: shellcheck by name, `py_compile`, A14), 20 (3: the page leg) |
| `.prettierignore` | 2 (1) |
| `.gitignore` | 9 (2) |
| `test/helpers/platform.ts`, `test/helpers/sandbox.ts` (A32), `test/helpers/deck.ts` | 5 (1) |
| `src/claude/procstat.ts` | 8 (1) |
| `src/sessions/resume.ts`, `src/sessions/restore.ts`, `src/cli/launching.ts` | 4 (1) |
| `src/window/terminals.ts`, `test/window/terminals.test.ts` | 16 (3) creates them; 21 (4) adds the `KeeperStartError` kind `'stopping'` and its test case (ruled, task 21's review 2) and otherwise only uses the `Registry` API task 16 exports |
| `src/window/screen.ts`, `test/window/screen.test.ts` | 12 (2) creates them; 33 (3) edits them; 16 (3) only calls `createScreen` |
| `test/keeper/limits.test.ts` | 9 (2) creates it; 20 (3) edits it (ruled on #51) |
| `web/index.html`, `web/app.js`, `web/style.css` | 26 (6) only; tasks 27–29 own `web/list.*`, `web/terminal-view.*`, `web/cards.*`/`web/help.js` |
| `docs/design-step-2.md` | several tasks record a decision of 1a in the sections named for them, disjoint within every wave; a conflict is rebased keeping both edits |
| `docs/manual-checks.md`, `docs/install.md`, `README.md` | 30 (8) only |

## 1a. Decisions this plan makes where the design is silent

Each is binding for the implementer. The last column names the task that records it in
`docs/design-step-2.md` in its own pull request; `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| A1 | The server's parts meet at interfaces fixed in section 2.5 (`TerminalHub`, `ActionHandler`, `StreamSink`) and defined as code by task 1: pages (17) code against `TerminalHub` and `ActionHandler`, the registry (16) and the actions (23) implement them. | Pages and terminals are built in the same wave; neither may wait for the other. | — |
| A2 | The keeper frame codec is TypeScript, `src/window/frames.ts` (task 1, 2.3). The python keeper implements the same byte layout; task 9's tests drive the keeper through this codec, so both sides are tested against each other. | One definition of S2 8.1 that the server and the keeper's tests share. | — |
| A3 | Vendored layout: `vendor/xterm/<directory name of the package>/<path inside the package>` (`vendor/xterm/xterm/lib/xterm.mjs`, `vendor/xterm/headless/lib-headless/xterm-headless.mjs`). Only what is used is vendored: each package's `.mjs` bundle, its `typings/*.d.ts`, `@xterm/xterm`'s `css/xterm.css`, and its `LICENSE`. No `.js` (UMD), no `.map`, no `src/`. `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0 ship **no LICENSE file** (checked with `npm pack --dry-run` while writing this plan): for them `npm run vendor` writes `@xterm/xterm`'s `LICENSE`, only after checking that the package's `package.json` declares `"license": "MIT"` and the same repository as `@xterm/xterm` (`github.com/xtermjs/xterm.js`, ignoring a `#branch` suffix and a path inside the repository: the installed addons' `package.json` say `https://github.com/xtermjs/xterm.js/tree/master/addons/<addon>`, `npm view` shows the registry's `git+https://github.com/xtermjs/xterm.js.git#master`; both hold at these versions), and fails otherwise; the manifest records `"licenseFrom": "@xterm/xterm"` and `"licenseReason": "no LICENSE in the package; its package.json declares MIT and the repository of @xterm/xterm"` (ruling 1). Beside each vendored `.mjs` the script writes a declaration file `<name>.d.mts` that re-exports the package's typings, recorded in the manifest with package `skydeck`, so that `tsc` for `web/` never reads a bundle. The script also writes `vendor/xterm/THIRD-PARTY-NOTICES` (package `skydeck`, version `-`; ruling on #38): `@xterm/addon-unicode-graphemes` 0.4.0's bundle contains adapted copies of tiny-inflate and unicode-trie (both MIT, Devon Govett) with no notice, so the file names that bundle and holds each package's licence exactly as its `LICENSE` is published on npm (tiny-inflate 1.0.3, unicode-trie 2.0.0); the script refuses another version of that addon until its bundle has been checked again. | S2 16.6 asks for each package's licence file; two packages have none. Type-checking a 400 KB bundle with `checkJs` would be slow and fail. | 2 (16.6) |
| A4 | The server loads `@xterm/headless` and its addons from `vendor/xterm/` with a dynamic `import()` of a `file:` URL computed from `appRoot` (`src/window/xterm.ts`), typed with `import type` from the development dependencies. Nothing under `src/` imports a vendored file statically, and nothing imports from `node_modules` at run time. | Users never run `npm ci` (docs/install.md): only `vendor/` exists on their machine. | — |
| A5 | Exact development dependencies: `@xterm/xterm` 6.0.0, `@xterm/headless` 6.0.0, `@xterm/addon-serialize` 0.14.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-search` 0.16.0, `@xterm/addon-unicode-graphemes` 0.4.0, `ws` 8.23.0, `@types/ws` 8.18.2 (task 2); `playwright` 1.60.0 (task 20; released 2026-05-11, the one version whose Chromium is build 1223, which is already installed on one machine — 1.59.0 uses 1217, 1.61.x 1228, 1.64.1 1248; checked in each version's `browsers.json`; ruling 6). All verified to exist in the npm registry while writing this plan. | S2 16.6 and 17.4: exact versions. | 2 (16.6), 20 (17.4, 17.5) |
| A6 | `window.port` in `config.json` accepts 1–65535 only. Tests pass `port: 0` to `runServer` (2.5.4) directly, never through the configuration. | S2 17: "`window.port` 0 in tests only" without making 0 a valid user setting. | 5 (16.4) |
| A7 | `notice` gains the kind `tick-failed` ("skydeck could not refresh the list: <reason>; it tries again"), sent once when a tick fails and not again until a tick has succeeded. | S2 10.1 says a failed tick is "shown once to the pages" but 8.2.3 has no kind for it. | 1 (8.2.3) |
| A8 | `src/window/view/` may import the pure functions `isListed` and `matchesFilter` of `src/sessions/list.ts`, besides its types. | Stage A's filter is design 7.4's (S2 19); one implementation. | 13 (4.3) |
| A9 | The "long-lived child with pipes" of S2 4.3 is not built in stage A: no stage A part needs it (the keeper, `serve`, Edge and `wsl.exe` are all detached). | YAGNI; the stage that needs it adds it. | 5 (4.3) |
| A10 | Platform additions (2.2): `Clock.after`, `Platform.randomBytes`, `Platform.pid`, `Platform.uid`, `Platform.userName`, `Platform.processes` (`startDetached`, `signal`), `Platform.net` (`listenHttp`, `connectUnix`, `requestUnix`); `FileInfo` gains `mode` and `uid`; `Proc` gains `fdTarget` and `tcpListening`. A parent pid is parsed from `Proc.stat` by a pure helper in `src/claude/procstat.ts` (task 8). | S2 4.3: nothing outside `src/platform/` opens a socket, starts a program, reads `/proc` or draws randomness. | 5 (4.3) |
| A11 | From stage A on, the page owns every key of S2 12.9's table and list keys, also those whose action comes in a later stage — Ctrl+Shift+P (E), Ctrl+Shift+J (B), and in the list zone `l`, `g`, `n`, `p`, `d`, F2 (D): it cancels them and shows `<key>: comes in a later stage` in the key bar, and the key help lists them as coming later. | A key must not mean Edge's action in one stage and the window's in the next (ruling 2). | 31 (19, stage A) |
| A12 | The build hash (S2 16.5) skips `__pycache__` directories and names starting with `.`; `.gitignore` gains `__pycache__/`. | `python3 -m py_compile` writes `bin/__pycache__/`, which would change the build and restart the server for nothing. | 14 (16.5) |
| A13 | The vendored-files check of S2 17.5 is a test in `npm test` (`test/vendor/vendor.test.ts`), so both CI legs run it with no step of its own. | It needs the installed packages, which `npm ci` gives CI. | 2 (17.5) |
| A14 | The keeper task (9) makes the two CI changes its own pull request needs to pass: `shellcheck bin/skydeck*` would read the python keeper and fail, so it becomes `shellcheck bin/skydeck bin/skydeck-hook bin/skydeck-keepalive`, and `python3 -m py_compile bin/skydeck-keeper` is added. Task 20 does the rest of S2 17.5 (page leg, cache, time limit). | A pull request that adds the keeper cannot pass CI otherwise, and the CI task cannot compile a keeper that does not exist yet. | — |
| A15 | The page suite uses the `playwright` library from `node:test` files under `test-page/` (`chromium.launch()`), not `@playwright/test`. | One test runner in the repository. | — |
| A16 | The page is built as a walking skeleton: task 26 creates every module of `web/` the shell imports, with `list.js`, `terminal-view.js`, `cards.js` and `help.js` as the smallest working versions; tasks 27, 28 and 29 replace them, each owning its module and its stylesheet (`web/list.css`, `web/terminal-view.css`, `web/cards.css`). The interfaces between `app.js` and those modules are fixed in 2.9. | Three page tasks in parallel instead of three waves in a row. | — |
| A17 | The stand-in's commands, record file and environment are fixed in 2.4. | Tasks of four waves drive it. | — |
| A18 | The page formats ages itself with `web/format.js` (task 31), a copy of `formatAge`'s rule (design 7.4); a test runs both over the same table of durations. | The server sends times (S2 8.2.3: "times are nanoseconds"); ages change every second, `list` is sent only on change. | — |
| A19 | Server tests run the server in the test process through `runServer` (2.5.4) with the real platform's sockets and real keepers; only `serve`'s exit codes, its core limit and its `CLAUDECODE` refusal are tested through `bin/skydeck serve` as a child process. | Speed and direct access to the server's state; the launcher is tested where it matters. | — |
| A20 | The start deadline (S2 7.1 `startBy`) is computed by `startDeadline` in `src/sessions/launch.ts` (2.7): for a resume, the time in the lock's value plus `LOCK_TTL_NS − LOCK_START_TOLERANCE_NS`; for `new`, the clock at `prepareNew` plus the same. `PreparedLaunch` gains `preparedAtNs`. | S2 7.1 defines the value; one function computes it for `launchPrepared` and `runRestore`. | 4 (11.1) |
| A21 | Terminal ids are 12 lowercase hex characters from `platform.randomBytes(6)`; server ids and window ids 16 hex characters from 8 bytes. | S2 3 fixes the terminal id only. | — |
| A22 | Validators of foreign input (`parsePageMessage`, `parseControlRequest`, the keeper's `hello`) return `{ ok: false, kind }` with a fixed kind string instead of throwing, so that a caller can log the kind and never a message (S2 2, 5.2). | Node's `JSON.parse` error quotes its input. | — |
| A23 | `skydeck serve` and `skydeck window` share `src/window/lifecycle.ts` (task 22) for finding, starting and stopping a server; `uninstall` uses the same stop. | S2 16.2: "stops it as `skydeck window --stop` does". | — |
| A24 | The server's tick reuses step 1's refresh rule of the interactive list (fix 4): the rows are reloaded when the refresh saved something, a live file or its trust changed, `Store.dataVersion()` moved, a tick failed, or a minute passed; and (ruled by the plan owner, task 23's review 1) when the server wrote on its own connection, which `dataVersion()` does not show: `tick.reload()` after every action, every found-keeper decision and every pull-request fetch that saved something, and after a settled exit (`settleEndedTerminal` ingests and may write; review 2). | S2 10.1 names that rule. | — |
| A25 | `result` carries `sessionId`: the session a successful `resume` or `new` started, else null. | The page must select the new terminal's row (S2 11.3), and only the server knows a new session's id. | 1 (8.2.3) |
| A26 | `GET /ping` answers `checkout` too. | S2 5.1 compares "this checkout"; the table of 8.3 omits the field. | 1 (8.3) |
| A27 | `list` carries two more fields: `selected` — for the session the page's `view` names, what the resume card shows (the exact command, the flags not passed on, how it ended, expiring/expired; 2.7) — and `dirs`, the known project directories, most recent first, for the new form. | S2 12.6 needs both on the page, and the page decides no rule (S2 4.3); the command is built only by `buildResumeCommand` on the server. | 1 (8.2.3) |
| A28 | A terminal opened for `new` shows as a row of its own whose `id` is the new session's id (known from `prepareNew`), `starting: true`, titled with the label or `new session in <dir>`; when the session reports a start it becomes that session's ordinary row. Keeper `meta` carries `label` and `dir` so that this survives a server restart. | S2 7.5 says such a row exists; an id is needed for selection. | 13 (7.5) |
| A29 | `skydeck window` passes its working directory to `serve` in `SKYDECK_ENV_ORIGIN`; `serve` takes it out of its environment (task 8's `serverEnvironment`) and records it with its start time as "where the environment came from" (S2 5.2); a `serve` started by hand records its own working directory. | `serve` runs in `/` (S2 5.2), so it cannot see where its environment came from. | 23 (5.2) |
| A30 | `doctor`'s port check reads `/proc/net/tcp` and `/proc/net/tcp6` (`Proc.tcpListening`, task 5) for a listener on `<window.port>`; when one exists and no server of this installation is alive, something else holds the port (`problem`). While this installation's server is alive but does not answer, or cannot be judged, a held port is most likely its own: `info`, and the server's own line is the problem (ruled by the plan owner, task 24). | No side effect: binding the port, even for an instant, could make a server that starts at that moment exit 10; no request is sent to a foreign program. | 24 (16.3) |
| A31 | Timeouts that the tests must not wait out are parameters with the design's values as defaults (the 30-second page wait and the 10-second stop wait of `skydeck window`, the keeper's linger and caps), set in tests only through an options argument or an environment variable whose name starts with `SKYDECK_TEST_` (the keeper's and the keep-alive's included). The launcher honours `SKYDECK_TEST_PYTHON3` (an absolute path) in place of `/usr/bin/python3` for `serve`'s core-limit program only when `SKYDECK_TEST_NO_WINDOWS=1` is set too, the mark of a test sandbox; without that mark it is ignored (task 6; ruled, pull request #36). `serve` also honours `SKYDECK_TEST_PORT` (any port, 0 included) over `window.port`, so that tests running `bin/skydeck serve` as a child never pick the same port; they read the port from `server.json`. `doctor` and `uninstall` honour `SKYDECK_TEST_MNT_C` (an absolute directory standing for `/mnt/c`) only with `SKYDECK_TEST_NO_WINDOWS=1` too; with that mark and without it they read nothing under `/mnt/` and the C: drive counts as not mounted, and `doctor`'s `/usr/bin/python3` line honours `SKYDECK_TEST_PYTHON3` as the launcher does (task 24; ruled by the plan owner). In a marked sandbox (`SKYDECK_TEST_NO_WINDOWS=1`) `serve` stops itself in the orderly way after `SKYDECK_TEST_SERVE_MAX_SECONDS` seconds (600 by default, also for a value that is not whole seconds) and within a second once its `SKYDECK_HOME` is gone, so that a killed test run leaves no server running; outside a marked sandbox neither exists (task 25; ruled by the plan owner). In a marked sandbox `serve` also honours `SKYDECK_TEST_SERVE_START_DELAY_MS` (a whole number of ms, at most 60000, so that a mistyped value cannot hold the lock and the port for long while a SIGTERM is only kept): its start waits that long between binding the port and writing `server.json`, the step in which only the `window_server` lock names it, so that tests can meet a server that is starting; a value that is not such a number is no delay and one log line; outside a marked sandbox it is ignored (follow-up "server-findable"; ruled by the plan owner). `skydeck window` takes its waits from `SKYDECK_TEST_WINDOW_TIMES` (`name=ms` pairs separated by commas: `pingMs`, `startMs`, `stopMs`, `killMs` for lifecycle.ts, and its own `pageMs` 30 s, `reuseMs` 2 s, `launchingMs` 45 s, `reconnectMs` 7 s), honoured only with `SKYDECK_TEST_NO_WINDOWS=1`; there a value that cannot be parsed is an error, never the defaults (task 25; ruled by the plan owner). | A test suite that waits 30 s per case is not run; two test files must not race for one port. | — |
| A32 | No test can start a Windows program (review A, must-fix): `test/helpers/sandbox.ts`'s environment gains `SKYDECK_TEST_NO_WINDOWS=1`; with it set, `realPlatform`'s `processes.startDetached` and `runner.run` refuse (an Error with `code` `'EWINDOWS'`, nothing started) a command under `/mnt/` or ending in `.exe` (any case); a platform that can start a real process — `realTestPlatform`, and `testPlatform` given real processes (`realProcesses: true`) — refuses them always, whatever any environment says (the guard is part of the processes object they build, `realPlatform({ refuseWindows: true })`, never read from `process.env`: in the test process the variable is in the platform's environment, not in the runner's own; `refuseWindows` can only turn the refusal on); the pure fake starts nothing: it records the call and returns what its handler scripts, also for a Windows command, so that a test can assert the command line (ruling of 2026-11-13, task 5). The guard also covers `runner.runInteractive`; it judges every file the command can lead execvp to (every directory of `PATH`, or execvp's default without one; a path as the kernel follows it, symbolic links before `..`) by name and by content (a file that starts with `MZ`, what WSL interop runs), and is also active when the variable is in the environment given to the child. Only the program itself is judged: `sh -c '/mnt/…'` runs. `test/helpers/window-config.ts` (task 5) writes the sandbox `config.json` every server test uses: `window.edge` = a recording stub in the sandbox, `keepAlive` `off`, unless the test passes its own. `runServer` takes the first interop candidate as an option (`interopFirst`, default `/run/WSL/1_interop`; `SKYDECK_TEST_INTEROP_FIRST` for child processes), and tests always point it into the sandbox. | A WSL machine has a real `msedge.exe`, `wsl.exe` and `/run/WSL/1_interop` (checked by the reviewer); a link Ctrl+clicked in a page test would open a tab on the user's desktop at every local run, and CI would never show it. | 5 (17) |
| A33 | The stand-in refuses to run outside a sandbox (review A, must-fix): it exits 2 before doing anything — no hook, no live file, no record — unless `STANDIN_RECORD`, `SKYDECK_HOME` and `CLAUDE_CONFIG_DIR` are all set to absolute paths; there are no defaults. It ends itself, exit 0, when the directory of its record file is gone (checked every second) — then without running the hook or writing anything, since the hook would create `$SKYDECK_HOME/state/spool` again and leave a directory behind after every crashed test — or 10 minutes after it started, with `SessionEnd` reason `other` as on `/exit`. | Implementers run tests inside Claude Code sessions on a machine with the hook installed: a stand-in with an inherited environment would write into the user's real spool and `~/.claude/sessions`, and a crashed test would leave keepers and stand-ins running. | — |
| A34 | Test helpers signal only through `killKeepersIn(s, runtimeDir)` (task 5, `test/helpers/kill.ts`), which asserts that the real path of `runtimeDir` lies under `s.root` before it reads a single `.pid` line, and signals only pids whose lines are alive by design 5.5's rule; a test signals other processes only through the child handles it started itself. | If a runtime directory were ever resolved wrongly, a cleanup would kill the user's real keepers and their sessions. | — |
| A35 | Every module the server uses is loaded before it listens, the vendored xterm modules (`loadXterm`) included; no `import()` runs after start. | S2 16.5: the server must never read new code from a checkout that `git pull` changed under it. | — |
| A36 | Two test platforms (task 5, 2.2): `testPlatform` — fake clock, fake `/proc`, fake processes — for logic; `realTestPlatform` — real clock, real `/proc`, `process.pid`, real processes that refuse Windows programs always, the needed programs linked into the sandbox — for every test that starts a keeper, the stand-in or a server, or judges a real process alive. `realTestPlatform({ bootId })` overrides only the boot id `proc.bootId()` reports, so that a test can show a server what WSL restarting looks like (S2 6.3) while every other `/proc` read stays real. Each task's **Tests** heading names the platform its tests use. | With the fake clock a keeper's `startBy` lies in its real past and its pid lines count as dead (review B). | 5 (17) |
| A37 | The terminal core (task 16, ruled by the plan owner at review 1): right after a fresh keeper's first `hello` the server parks the empty screen at record 0 (`P` with record 0), so that every later claim learns the terminal's first size from its `S` (a hello carries only the current size); the forced redraw of a gap pauses 100 ms between its two resizes (two quick SIGWINCH collapse: 0 of 20 redraws back to back, 20 of 20 from 5 ms, task 3's review); a requested size is clamped to 1,000 columns and 500 rows before it reaches the keeper and the screen side; the keeper's hello names its tail's first record, `tailFrom` (2.3). | Without the first size a rebuild that had no other park starts at the wrong width; without `tailFrom` a server cannot number the tail after a gap; 65,535 columns would allocate gigabytes of scrollback. | 16 (7.3, 8.1, 8.2.6) |
| A38 | `uninstall --purge` leaves alone, and names, a directory that can be the runtime directory when it is not a plain path (a `.` or `..`; the record is first normalised: no repeated or trailing `/`, so that `<link>/` is seen as a link), is a symbolic link (never followed), another user's, or holds an entry a runtime directory does not hold or not of its kind (S2 4.2: the files `server.json`, `server.pid`, `keepalive.pid`, `keepalive.interop`, `keeper-<build>.py`, the socket `server.sock`, the link `interop`, the directory `terms/` with the socket `<terminal id>.sock` and the file `<terminal id>.pid`, and their writers' temporaries `.<name>.<12 hex or pid>.tmp`); the rest of the purge goes on (review 2 of task 24 made the shapes exact). The list is `RUNTIME_DIR` in `src/cli/purge.ts`, beside step 1's directories' lists (purge-care). A look that fails, a subdirectory of another user, a removal that fails and an entry that came while it was purged leave that directory too; every directory left alone, for whatever reason, is named with why — the entry in the way when there is one — in the command's last line, `skydeck is uninstalled, but --purge did not remove <dir>: it …`, and the exit code is 1, never an internal error (ruled, review 2 of task 24 and purge-care). Every check that can refuse the uninstall runs before anything is undone or stopped; the one look that can come only after the server's stop refuses only the purge of the directories, and says so (ruled by the plan owner, task 24). | The store's record is only a path: a damaged or hand-edited one must not lead to removing what is the user's (principle 6). A refusal that came after the settings were undone must not pretend nothing was done. | 24 (16.2) |

## 2. Contracts

Every exported name below must exist with exactly this signature. Comments state what the other
side relies on; the design sections named give the rest. Bodies are given only where the body is
the contract.

### 2.1 Conventions

- Step 1's conventions hold (`docs/plans/step-1.md` 2.1): imports name the `.ts` file, `import
  type` for types, no enums, namespaces or parameter properties, `Ns = bigint` inside the server.
- **Import rules (S2 4.3).** `src/window/` imports `platform`, `text`, `store`, `claude`,
  `sessions`, `terminals`, `github`. `src/window/view/` imports types of `sessions` and `text`,
  and the two functions of A8. `src/window/protocol.ts`, `src/window/frames.ts` and
  `src/window/hub.ts` import nothing from `src/` but `platform/types.ts` (types) and step 1's one
  session-id rule, `isSessionId`, from `src/claude/session-id.ts` — a file that imports nothing, so
  that the page's type check (which reads `protocol.ts`) needs no Node.js types; `launch.ts`
  re-exports it (ruled by the plan owner, task 1). `src/cli/`
  imports `src/window/` (the commands `window`, `serve`, `doctor`, `uninstall`). Nothing outside
  `src/window/` imports `src/window/`'s server parts; `src/sessions/` never imports `src/window/`.
- **Only `src/platform/real.ts`** opens a socket, starts a program, sends a signal, reads `/proc`,
  reads `process.env`, draws randomness or calls `Date.now`. `node:crypto` hashes, HMAC, HKDF and
  AES-GCM with keys and IVs that came from `platform.randomBytes` are allowed everywhere in
  `src/window/`. Type imports (`import type`, and `import('node:http').IncomingMessage` in a type
  position) are allowed everywhere. Check with these two commands, which print nothing on `main`
  at 394d3e6 and must print nothing after every task:
  ```sh
  # value imports of the network, child processes or randomness
  rg -nUP "^import (?!type )[^;]*'node:(net|http|https|child_process|dgram|tls)'|^import (?!type )[^;]*\brandom(Bytes|UUID)\b[^;]*'node:crypto'" src --glob '!src/platform/real.ts'
  # the process's globals, randomness, the clock and /proc, outside comments
  rg -nP "^(?!\s*(\*|//|/\*)).*((?<![\w.])process\.(env|pid|kill)\b|(?<![\w.])random(Bytes|UUID)\(|\bcrypto\.(random\w*|getRandomValues)\(|Date\.now\(|'/proc)" src --glob '!src/platform/real.ts' --glob '!src/cli/context.ts' --glob '!src/sessions/derive.ts'
  ```
  Lines that start a comment (`*`, `//`, `/*`) are skipped, so a one-line `/** … */` that names
  `process.env` is no hit; `crypto.randomBytes(` through a default import of `node:crypto` is
  one. Named exemptions: `src/cli/context.ts` (step 1's terminal handling re-raises a signal with
  `process.kill(process.pid, …)`), `src/sessions/derive.ts` (its `process` is a local
  `ProcessKey`, not the global).
- **The server loads everything at start** (A35): no `import()` after it listens.
- **In messages** (2.8) times are nanoseconds as decimal strings, never `bigint`; ids are strings.
  Inside the server they are `Ns`.
- **Foreign input** (a page's message, a control request's body, a keeper's `hello`) is parsed
  by the validators of 2.3 and 2.8, which return `{ ok: false, kind }` and never throw (A22). Logs
  carry the kind, never the text (S2 2, 5.2).
- **`web/`** is plain JavaScript (ES modules) with JSDoc types, checked by `tsc -p web` (task 26).
  It imports types from `src/window/protocol.ts` with JSDoc `@import`; it never imports code from
  `src/`. Every server string reaches the DOM through `textContent`, never `innerHTML` (S2 15.4).

### 2.2 `src/platform/` additions (task 5)

```ts
// src/platform/types.ts — added members (existing ones unchanged)
export interface Clock {
  /** Calls `callback` once after `ms` milliseconds unless the returned function was called first.
   *  The real one does not keep the process alive by itself; the fake one fires from advanceMs.
   *  RangeError for `ms` not a whole number from 0 to MAX_TIMER_MS (2^31 − 1, src/platform/time.ts). */
  after(ms: number, callback: () => void): () => void;
}
export interface FileInfo {
  mode: number; // permission bits (stat.mode & 0o7777)
  uid: number;
}
export interface Files {
  // remove() (step 1's) changes (ruled, task 19): it unlinks, so it NEVER FOLLOWS a symbolic link —
  // a dangling one is removed too (Node.js 24.12's rmSync followed it and left it in place) — and
  // refuses a directory; a missing path is no error.
  remove(path: string): void;
  // rmdir() is new (ruled, purge-care): rmdir(2) — removes an empty directory; a symbolic link is
  // refused (ENOTDIR) and never followed; one that is not empty is refused (ENOTEMPTY); no error
  // when absent. `uninstall --purge` removes directories only with it.
  rmdir(path: string): void;
}
export interface Proc {
  // bootId() and stat() (step 1's) change (ruling, for task 8's three-valued pidLineState): null
  // only when the file is not there (ENOENT, ENOTDIR, ESRCH); any other failure (EACCES, EMFILE …)
  // is thrown as a SkydeckError carrying its `code`, so that nothing is removed or ended on a
  // process that could not be read. Step 1's callers: reconcile records and skips that process;
  // an unreadable boot id, and loading the sessions, stop the command with the error (design 5.5).
  /** The target of the symbolic link /proc/<pid>/fd/<fd>; null when it cannot be read. */
  fdTarget(pid: number, fd: number): string | null;
  /** Whether /proc/net/tcp or /proc/net/tcp6 lists a socket in state LISTEN (0A) on `port`; null
   *  when neither can be read (A30); false for a number that is not a port (1–65535). */
  tcpListening(port: number): boolean | null;
}
export interface DetachedOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Written to the child's stdin, which is then closed; without it stdin is /dev/null. */
  input?: string;
  /** Files stdout and stderr are appended to (created with mode 0o600); without, /dev/null. */
  stdoutTo?: string;
  stderrTo?: string;
}
export interface Detached {
  pid: number;
  /** Settles when the child exits while this process lives. The child never keeps this process
   *  alive and gets no SIGHUP from this process's terminal (setsid, a session of its own). */
  exited: Promise<{ code: number | null; signal: string | null }>;
}
/** With SKYDECK_TEST_NO_WINDOWS=1 in skydeck's environment or the child's, and always for
 *  realPlatform({ refuseWindows: true }), startDetached, Runner.run and Runner.runInteractive refuse
 *  a command under /mnt/, ending in .exe (any case) or a file starting with "MZ" (also reached
 *  through PATH or a symbolic link) with an Error whose `code` is 'EWINDOWS', and start nothing (A32). */
export interface Processes {
  /** Starts a program detached in a new session. Rejects with an Error whose `code` is 'ENOENT'
   *  when the program, `cwd`, or the directory of `stdoutTo` / `stderrTo` does not exist. */
  startDetached(command: string, args: readonly string[], options: DetachedOptions): Promise<Detached>;
  /** process.kill; false when no such process exists (ESRCH, or a pid above 2^31 − 1). Callers check
   *  the identity first. RangeError for a pid that is not a positive whole number (0 and -1 signal
   *  groups), and nothing is sent; `assertProcessId` (real.ts) is that check, shared with the fake. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
}
export interface HttpHandlers {
  request(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void;
  upgrade?(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void;
}
export interface HttpListener {
  /** The bound TCP port; 0 for a unix socket. */
  port: number;
  /** Stops listening and destroys every open connection (upgraded ones too) instead of waiting. */
  close(): Promise<void>;
}
export interface Net {
  /** An HTTP server on 127.0.0.1:<port> (0: the system picks) or on a unix socket path (created
   *  with mode 0o600). Rejects with an Error whose `code` is 'EADDRINUSE' when it is taken. The real
   *  one listens on 127.0.0.1 whatever `host` says at run time. */
  listenHttp(where: { host: '127.0.0.1'; port: number } | { path: string }, handlers: HttpHandlers): Promise<HttpListener>;
  /** Connects to a unix socket; rejects with `code` 'ECONNREFUSED' or 'ENOENT'. */
  connectUnix(path: string): Promise<import('node:net').Socket>;
  /** One HTTP/1.1 request over a unix socket with a JSON body; rejects on timeout (`code` 'ETIMEDOUT'),
   *  refusal or a missing socket. `onLine` receives a streamed body line by line when given; `body`
   *  is then null, and the timeout starts again with every chunk. Without `onLine`, `body` is the
   *  answer parsed as JSON, its text when it is not JSON, null when empty. A `timeoutMs` that is not
   *  a whole number from 0 to MAX_TIMER_MS rejects with a RangeError. `signal` (ruled, task 22): when it
   *  fires the request is destroyed, its timer cleared, and it rejects with an AbortError (as Runner.run);
   *  already aborted, nothing is sent; one that fires after the answer changes nothing. */
  requestUnix(path: string, request: { method: 'GET' | 'POST'; path: string; body?: unknown; timeoutMs: number; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<{ status: number; body: unknown }>;
}
export interface Platform {
  processes: Processes;
  net: Net;
  /** `count` random bytes (crypto.randomBytes); the fake one returns 0, 1, 2, … in order. A
   *  property, so that the import check of 2.1 does not read the declaration as a call (ruling). */
  randomBytes: (count: number) => Uint8Array;
  pid: number;
  uid: number;
  /** os.userInfo().username, for /var/lib/systemd/linger/<user>. */
  userName: string;
}
```

```ts
// src/platform/real.ts — added (ruling): the guard the test platforms build their processes with.
export interface RealPlatformOptions { refuseWindows?: boolean } // can only turn the refusal on
export function realPlatform(options?: RealPlatformOptions): Platform;
// src/platform/time.ts — added (ruling): the longest delay of Clock.after.
export const MAX_TIMER_MS = 2_147_483_647;

// src/platform/paths.ts — added
/** The first 8 hex digits of the sha256 of the store's path (S2 4.2). */
export function storeId(dbPath: string): string;
export type RuntimeRule = 'skydeck-home' | 'xdg-runtime' | 'state-dir';
/**
 * S2 4.2's rule, without the store's record: $SKYDECK_HOME/run when SKYDECK_HOME counts (D26);
 * else $XDG_RUNTIME_DIR/skydeck-<id> when XDG_RUNTIME_DIR counts and `xdgUsable(dir)` says it is
 * a directory of the user's, not readable by others, and the user lingers; else <stateDir>/run-<id>.
 */
export function runtimeDirByRule(input: { env: Env; stateDir: string; storeId: string; xdgUsable: (xdgDir: string) => boolean }): { dir: string; rule: RuntimeRule };
/** Every directory the rule can give, for `uninstall --purge` (S2 16.2), in the rule's order. */
export function runtimeDirCandidates(env: Env, stateDir: string, storeId: string): string[];

// src/platform/config.ts — added
export interface WindowConfig {
  port: number; // 1..65535 (A6)
  edge: string; // absolute path
  profileDir: string | null; // an absolute Windows path, `<letter>:\…`
  keepAlive: 'wsl' | 'off';
}
// Config gains `window: WindowConfig`; DEFAULT_CONFIG.window = { port: 47613,
// edge: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', profileDir: null, keepAlive: 'wsl' }.
```

Test helpers (`test/helpers/platform.ts`, extended): `FakeClock` gains `after` (fires from
`advanceMs`, in time order with `every`); `fakeProc` gains `setFdTarget(pid, fd, target)`;
`fakeProcesses(handler?, live?)` records every `startDetached` call (`calls`: `{ command, args,
options }`), Windows commands included, and answers with the handler (default: pids from 5001, an
`exited` that never settles), `signal` calls (`signals`) with the set `live`; `testPlatform` gives
a deterministic `randomBytes`, `pid` 4000, `uid` the real uid, `userName` `'tester'`, the real
`net` (tests use real loopback and unix sockets) and the fake processes (`processes` beside
`clock`, `proc` and `runner`), unless options ask for real ones
(`TestPlatformOptions.realProcesses: true`), which refuse a command under `/mnt/` or ending in
`.exe` always (A32) and whose `signal` reaches only a process they started that still runs (beside
the fake `/proc`, a fixture's pid may be a real process of the developer's; any other pid throws).
The fake `signal` throws the real one's RangeError. `fakeProc` also has `setTcpListening(ports | null)`.

`realTestPlatform(t, options?: { bootId?: string; env?: TestPlatformOptions['env'] })` (same file,
A36) returns a `RealTestPlatform` (`TestPlatform<Clock, Proc, Runner, Processes>`: `TestPlatform`
is generic, its defaults the fakes) whose `platform` has the real
clock, the real `/proc` (so the real boot id), the real runner (a run without `env` or `cwd` gets the
sandbox's environment and home, never the developer's), `pid` = `process.pid`, the real `uid` and
`userName`, real processes that refuse a command under `/mnt/` or ending in `.exe` always (A32: the
guard is built into the processes object, not read from an environment), the real `net`, real `randomBytes`,
`homeDir` and `cwd` = the sandbox's home, `appRoot` = the repository, and the sandbox's
environment; it links `python3`, `sh`, `sleep`, `date`, `cat`, `base64`, `mkdir`, `mv`, `rm`,
`dirname` and `readlink` into the sandbox's `bin` (the keeper, the stand-in, the hook and the
launcher need them). Its `clock`, `proc` and `runner` members are the real ones (no `setNs`).
`test/helpers/deck.ts`'s `testDeck(t, options)` gains `real: true` (with `bootId`, `env`), which
builds the deck on `realTestPlatform`; `test/helpers/context.ts` gains `testContextOn(tp,
options)`, the context on a test platform the caller built. Which tests use it: section 0.

Also task 5's, for every later test: `test/helpers/sandbox.ts`'s `env()` gains
`SKYDECK_TEST_NO_WINDOWS: '1'` (A32), and `link` skips a program already linked;
`test/helpers/window-config.ts` exports
`writeWindowConfig(s: Sandbox, window?: Partial<WindowConfig> & Record<string, unknown>): { edgeStub: string; edgeCalls(): string[][] }`,
which writes `<s.skydeckHome>/config/config.json` with `window.edge` = a stub script in the
sandbox that appends its arguments to a file, and `keepAlive: 'off'`, merged with what the test
passes (an existing `config.json` keeps its other keys); `test/helpers/kill.ts` exports
`killKeepersIn(s: Sandbox, runtimeDir: string): void` (A34). `src/platform/real.ts`'s
`realPlatform(options?: { refuseWindows?: boolean })`: `refuseWindows` can only turn the refusal
on, never off.

### 2.3 Keeper frames: `src/window/frames.ts` (task 1)

The byte layout of S2 8.1. The python keeper (task 9) implements the same.

```ts
export type FrameType = 'C' | 'H' | 'G' | 'T' | 'N' | 'S' | 'D' | 'R' | 'X' | 'I' | 'Z' | 'P' | 'A';
export const MAX_PAYLOAD = 16 * 1024 * 1024;
export interface Frame { type: FrameType; payload: Uint8Array }
/** type byte, 4-byte big-endian length, payload. RangeError above MAX_PAYLOAD. */
export function encodeFrame(type: FrameType, payload?: Uint8Array): Uint8Array;
/** Incremental reader; `push` returns the complete frames so far. A type it does not know or a
 *  length above MAX_PAYLOAD makes `push` return { error: 'unknown-type' | 'too-long' } and the
 *  reader is unusable afterwards (the caller closes the connection). */
export function frameReader(): { push(chunk: Uint8Array): Frame[] | { error: 'unknown-type' | 'too-long' } };
/** S and P: 8-byte record number (big-endian), 2-byte cols, 2-byte rows, the snapshot (UTF-8). */
export function encodeSnapshot(seq: number, cols: number, rows: number, data: string): Uint8Array;
export function decodeSnapshot(payload: Uint8Array): { seq: number; cols: number; rows: number; data: string } | null;

export interface KeeperMeta {
  sessionId: string; kind: 'resume' | 'new'; slot: number | null; openedNs: string; build: string;
  label: string | null; dir: string; // for a new session's own row after a server restart (S2 7.5)
}
export interface KeeperSpec { // written to the keeper's stdin (S2 7.1)
  protocol: 1; id: string; socket: string; cols: number; rows: number; cwd: string;
  argv: string[]; env: Record<string, string>; startBy: string; lock: string | null;
  coreSoft: string | null; meta: KeeperMeta;
}
export interface KeeperExit { code: number | null; signal: number | null; atNs: string; notStarted: string | null }
export interface KeeperHello {
  protocol: number; keeper: string; id: string; started: boolean; startBy: string; lock: string | null;
  pid: number | null; procStart: number | null; cols: number; rows: number; seq: number; snapSeq: number;
  tailFrom: number; // the first record the tail holds (ruled by the plan owner, task 16)
  gap: boolean; meta: KeeperMeta; exited: KeeperExit | null;
}
export interface KeeperStarted { pid: number; procStart: number; atNs: string }
export function parseHello(payload: Uint8Array): { ok: true; value: KeeperHello } | { ok: false; kind: string };
export function parseStarted(payload: Uint8Array): { ok: true; value: KeeperStarted } | { ok: false; kind: string };
export function parseExit(payload: Uint8Array): { ok: true; value: KeeperExit } | { ok: false; kind: string };
export function parseResize(payload: Uint8Array): { ok: true; value: { cols: number; rows: number } } | { ok: false; kind: string };
/** Z: "<cols> <rows>" in ASCII. */
export function encodeResize(cols: number, rows: number): Uint8Array;
export const KEEPER_PROTOCOL = 1;
```

**What the codec refuses** (ruled by the plan owner, task 1). The keeper (task 9) must write
nothing these refuse; the parsers return `{ ok: false, kind }` (A22), the encoders throw a
`RangeError`.

- **Frames.** A type byte outside the thirteen above is `unknown-type` as soon as it arrives; a
  length above `MAX_PAYLOAD` is `too-long` as soon as the 5-byte header is complete. A push that
  hits either returns the error even when it completed earlier frames, and every later push
  returns it too. `encodeFrame` throws for an unknown type or a payload above `MAX_PAYLOAD`.
- **Sizes** (`cols`, `rows` in `H`, `R`, `S`, `P`, `Z`): whole numbers 1–65535, the range of the
  2-byte fields. **Record numbers** (`seq`, `snapSeq`, the 8-byte field of `S` and `P`): whole
  numbers from 0 up to `Number.MAX_SAFE_INTEGER`. `encodeSnapshot` and `encodeResize` throw
  outside these; `decodeSnapshot` is null for a payload shorter than 12 bytes, a record number
  beyond a safe integer, a size of 0 or a snapshot that is not UTF-8.
- **JSON payloads** (`H`, `T`, `X`, `R`): UTF-8 (strict) holding a JSON object; a field the parser
  does not know is ignored (a newer keeper's `hello` must still say that it is newer, S2 7.7),
  every field listed is required with exactly its type, `null` only where the type allows it.
- **Times** (`startBy`, `atNs`, `meta.openedNs`): a decimal string without sign or leading zero,
  at most `2^63 − 1`.
- **`hello`**: `protocol` a whole number from 0 (any value: the caller decides, S2 7.7); `id` 12
  lower-case hex characters (A21); `pid` a whole number from 1 or null, `procStart` from 0 or
  null, both null exactly when `started` is false (S2 8.1: null before the start); `snapSeq` ≤
  `seq`; `tailFrom` (ruled by the plan owner, task 16) from `snapSeq + 1` to `seq + 1`, above
  `snapSeq + 1` exactly when `gap` — the keeper sends the number of its tail's first record
  (`seq + 1` for an empty tail), so that after a gap the server still knows where the tail ends and
  which record a park names; `meta.sessionId` passes `isSessionId`; `meta.kind` `resume` or `new`; `meta.slot` 1–9 or
  null (S2 7.6); `exited`, when not null, as `X` below, with `notStarted` set exactly when
  `started` is false. The keeper refuses a spec that would make it write a `hello` these rules
  refuse (ruled by the plan owner, task 9): `id`, `startBy`, `lock` and every `meta` field are
  checked by them when the spec arrives (times at most 19 digits, `coreSoft` at most 20), the
  `hello` echoes only the seven `meta` fields of 2.3, and the socket must be an absolute path
  without NUL; a
  refused spec is one line `keeper <id>: bad-spec` (`-` without a valid id), exit 2, nothing
  created or started.
- **`T` started**: `pid` from 1, `procStart` from 0.
- **`X` exit — how an exit is represented.** `code` is the exit status (0–255) of a program that
  exited, else null; `signal` is the number (1–255) of the signal that killed it, else null —
  never negative: python's `os.waitstatus_to_exitcode` returns `−N` for a death by signal `N`,
  which the keeper sends as `code: null, signal: N`. A program that ran has exactly one of the
  two; one that never started has neither, and `notStarted` holds the reason, never empty (a failed
  `exec` is a program that ran: `code` 127).
- **`D` records end at UTF-8 character boundaries** (ruled by the plan owner, task 9): a snapshot is
  text, so a record boundary inside a character could not be reproduced by one. When a read ends
  with the first bytes (at most three) of a multi-byte character, the keeper holds them back and
  puts them in front of the next read; an `R` record that comes meanwhile waits too, so no resize
  stands between the two halves of a character. Bytes that cannot begin a valid character are never
  held; held bytes are sent as they are when the next read shows they do not go on as one, or when
  the program has ended (before `X`). Nothing is dropped or reordered. Escape sequences split
  across records are not the keeper's (task 33).
- **`N`'s reason** (ruled by the plan owner, task 9): UTF-8, at most 1,024 bytes (`MAX_REASON`). A
  longer one closes the connection as soon as its header shows it (`bad-refusal`), as any frame the
  keeper cannot parse; the server (task 16) keeps its reasons within that. An empty reason becomes
  "the server refused the start".
- **The input queue** (ruled by the plan owner, task 9; S2 7.1 step 5): it holds at most 4 MiB, and
  no input byte is ever dropped while the program runs. An `I` frame that would take it above
  4 MiB is not appended: it stays unread in the connection, and the keeper reads nothing more from
  that connection — parks and resizes wait as well — until the program has read enough to make
  room. The server then cannot write to the keeper and refuses further input with `notice
  input-full` (task 16). A single `I` frame larger than 4 MiB could never fit: it closes the
  connection (`input-too-long`) as soon as its header shows the length. The server sends at most
  64 KiB per frame.
- **The pid line's temporary file** (task 15's rule): the keeper writes `terms/.<id>.<pid>.tmp` and
  renames it to `terms/<id>.pid`, so the temporary never has the `<12 hex>.pid` shape that
  `listKeeperLines` reads.

### 2.4 The stand-in: `test/fixtures/standin/` (task 3)

A Node.js program that behaves like the parts of Claude Code skydeck depends on (S2 17.1), and
nothing else. It is the contract between task 3 and the tests of tasks 9, 16, 21, 23, 26–29.

- **Starting it.** `test/helpers/standin.ts` exports `standinCommand(s: Sandbox, options?: {
  wrapper?: boolean }): string`: it writes `<s.root>/bin/claude-standin`, a `sh` script that runs
  `<process.execPath> <repo>/test/fixtures/standin/standin.ts "$@"` (with `exec`; with
  `wrapper: true` without `exec`, so the stand-in is a child of the script, as a wrapper
  `claudeCommand` would be), links `sh`, `date`, `cat`, `base64`, `mkdir`, `mv` into the sandbox
  and returns the script's path, which the test puts into `claudeCommand`. It also exports
  `readRecords(path): StandinRecord[]` and `waitForRecord(path, predicate, timeoutMs)`.
- **Its environment.** `STANDIN_RECORD`: the JSON-lines file it appends to (each record
  `{ pid, ms, ev, … }`). `CLAUDE_CONFIG_DIR`: where it writes its live-session file.
  `SKYDECK_HOME`: where the hook it runs writes. **All three must be absolute paths, or it exits 2
  before doing anything** (A33); there are no defaults. `STANDIN_MAX_SECONDS` (optional): a
  number of seconds from 1 to 600 that shortens its life; any other value, the empty string
  included, is refused the same way (exit 2 before doing anything). It always runs the hook at
  `<repo>/bin/skydeck-hook`; no variable changes which program that is.
- **Arguments.** `--session-id <id>`, `--resume <id>` or `-r <id>`, `-n <name>`; everything else is
  recorded and ignored. With neither `--session-id` nor `--resume` it makes up a session id.
- **At start** it records `{ ev: 'start', argv, cwd, envNames, env: { TERM, COLORTERM, PWD,
  WSL_INTEROP }, coreSoft, cols, rows }` (`argv`: its arguments without the program; `envNames`:
  the sorted names of its environment — `sh` adds `PWD` even when the caller did not give it;
  `env` values are null when unset; `coreSoft`: the soft "Max core file size" of
  `/proc/self/limits` as written there; `cols`, `rows`: the terminal's size, null when its output
  is not a terminal), sets raw mode, sends DA1 (`ESC [ c`) and waits up to 2 s for the answer
  (recorded as `{ ev: 'da1', answer }`; without one it writes `no answer to DA1` on the screen and
  records `answer: null`), then CPR (`ESC [ 6 n`, `{ ev: 'cpr', answer }`; when DA1 had no answer,
  CPR is sent but not waited for and recorded with `answer: null`), runs the hook with
  `SessionStart` (source `startup` or `resume`, `session_title` when `-n` is given) and
  `CLAUDE_PID` = its pid, `CLAUDE_CODE_SESSION_ID` = the session id and `CLAUDE_CODE_ENTRYPOINT`
  = `cli`, writes `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (status `idle`, `procStart` as a
  decimal string from its own `/proc/self/stat`, `name` when `-n` is given, `version` `standin`,
  the shapes of `test/fixtures/claude/sessions/idle.json` without `nameSource`; written whole,
  through a rename), turns bracketed paste (mode 2004) on, as Claude Code does, and draws
  `standin <short id>> ` (the first 8 characters of the session id).
- **Input.** Every chunk it reads is recorded as `{ ev: 'input', hex }`, with one exception: while
  one of its own queries is open (DA1 and CPR at start, `/query`), what arrives goes to the query;
  the answers are recorded as `da1`, `cpr` or `answer` and never as input, and the bytes that
  answer nothing are recorded as ONE `input` record when the query closes (all answered, or 2 s).
  Printable text is echoed. `\r` ends a line: a line that starts with `/` is a command. `\n`
  (Ctrl+J) is echoed as `⏎`; every other control character in caret notation (`\x16` as `^V`,
  ESC as `^[`, so a bracketed paste shows `^[[200~…^[[201~`). Lines end in `\n`: Node's raw mode
  keeps the terminal's ONLCR, as it does for Claude Code, so the terminal receives `\r\n`.
- **Commands.** `/exit` — the alternate screen left when it is on, bracketed paste off,
  `SessionEnd` reason `prompt_input_exit`, live file removed, exit 0. `/fail <n>` — exit `n` mod
  256 (the status the process really has, recorded as such) without an end event; the live file
  stays, as after a crash. `/clear` — `SessionEnd` `clear`, a new session id, `SessionStart` `clear`, the live file
  names the new id (and no `-n` name any more). `/busy`, `/idle`, `/waiting <what>` — the live
  file's status (and `waitingFor`, removed by `/busy` and `/idle`). `/alt`, `/main` — enter and
  leave the alternate screen, drawing a box around the whole screen on it. `/mouse` — modes 1000
  and 1006 on. `/hide-cursor` — mode 25 off. `/cursor <n>` — DECSCUSR `n`. `/red <text>` — the
  text in SGR 31. `/lines <n>` — `n` numbered lines (`line 1` …). `/flood <bytes>` — that many
  bytes of numbered lines as fast as it can (bytes the program writes; the terminal sees one more
  CR per line). `/stall <s>` — reads no input for `s` seconds (`stalling <s> s` on the screen;
  what arrives meanwhile is read afterwards). `/osc52 <text>` — an OSC 52 clipboard write of
  `text`. `/link <url> <text>` — an OSC 8 link. `/query` — DA1, DA2, CPR, DECRQM 2026, DECRQSS
  `m`, XTVERSION, OSC 10 `?` and OSC 11 `?` again in one write; each answer recorded as
  `{ ev: 'answer', query, answer }` with `query` one of `DA1`, `DA2`, `CPR`, `DECRQM 2026`,
  `DECRQSS m`, `XTVERSION`, `OSC 10`, `OSC 11`; answers may come in any order; the stand-in waits
  until every query has one or 2 s passed. `/title <text>` — OSC 2. `/wide` — a row with 🙂, a ZWJ
  sequence and a skin-tone emoji. Any other `/word` — `unknown command: /word`.
- **Signals.** `SIGWINCH` with a changed size — records `{ ev: 'resize', cols, rows }` and redraws
  (`size <cols>x<rows>` and the prompt on the main screen, the box on the alternate one). A
  SIGWINCH that leaves the size as it was records nothing and draws nothing: a server that needs a
  redraw at the same size must change the size and change it back (S2 7.3: one column narrower and
  back). `SIGHUP` — records `{ ev: 'hup' }`, `SessionEnd` reason `other`, live file removed, exit
  129; a SIGHUP while it still waits for DA1 or CPR sends that `SessionEnd` with no `SessionStart`
  before it (the start hook has not run yet), a case ingest must survive. It records
  `{ ev: 'exit', code }` last.
- **It ends itself** (A33), exit 0: when the directory of `STANDIN_RECORD` is gone (checked every
  second, and before every hook run, record and live-file write) at once, running no hook and
  writing nothing (no record, no live file, no spool directory created again); 10 minutes after
  it started (`STANDIN_MAX_SECONDS` shortens it, for its own test) with `SessionEnd` reason
  `other` and its live file removed. Both are timers: while a write to
  its terminal blocks (`/flood` into a pty that nobody reads, e.g. a keeper under SIGSTOP), they
  wait, and it ends once the terminal is read again or its holder is gone (then the write fails
  or it gets SIGHUP).
- **Reading the records.** `readRecords` leaves out a last line that is not complete yet; record
  times (`ms`) are wall-clock milliseconds, which can step back on WSL — measure durations in the
  test with `performance.now()`.

### 2.5 The server's internal interfaces: `src/window/hub.ts` (task 1)

```ts
import type { KeeperExit } from './frames.ts';
import type { ActMessage, ResultMessage, ThemePayload } from './protocol.ts';

export type TerminalState = 'starting' | 'running' | 'ended' | 'lost' | 'not-started' | 'reconnecting' | 'newer-keeper';
export interface TerminalInfo {
  id: string;
  slot: number | null;
  state: TerminalState;
  /** The session it was opened for (S2 7.5); the session it shows is decided by the mapping. */
  expectedSessionId: string;
  /** The session it shows now; null while starting. */
  sessionId: string | null;
  kind: 'resume' | 'new';
  label: string | null;
  dir: string;
  program: { pid: number; procStart: number } | null;
  openedNs: bigint;
  cols: number;
  rows: number;
  exit: KeeperExit | null;
  /** S2 7.5: no holder after restoreStartTimeoutSeconds. */
  notReported: boolean;
}
export interface StreamSink {
  /** Always the first call on a sink: the screen at the point of the terminal's chain where
   *  `attach` was called. Never called when the terminal is forgotten before it was made. */
  snapshot(cols: number, rows: number, data: string): void;
  /** One record of output, after the screen side applied it. */
  output(bytes: Uint8Array): void;
  /** A resize record, in stream order. */
  size(cols: number, rows: number): void;
  exit(exit: KeeperExit, lost: boolean): void;
  notice(kind: 'gap' | 'newer-keeper' | 'input-full', text: string): void;
}
export interface TerminalHub {
  list(): readonly TerminalInfo[];
  /** Registers `sink` at the current point of the terminal's chain. The sink gets `snapshot`
   *  for that point first, then every later record in stream order (S2 8.2.4), until `detach`.
   *  Nothing is called on the sink before `snapshot` or after `detach`. null for an unknown
   *  terminal. (Ruled by the plan owner, task 16: the screen side snapshots asynchronously, so
   *  the snapshot is the sink's first call. The state the terminal is in at the attach point
   *  follows it: an ended, lost or not-started terminal gives `snapshot`, then `exit`; one with a
   *  gap or a newer keeper gives `snapshot`, then that `notice`.) */
  attach(termId: string, sink: StreamSink): { detach(): void } | null;
  /** 'full': not taken now — more than 4 MiB unwritten, no connection to the keeper at the
   *  moment, or a newer keeper (ruled by the plan owner, task 16). */
  input(termId: string, data: Uint8Array): 'ok' | 'full' | 'ended' | 'unknown';
  /** Sends Z to the keeper; the size reaches every sink when the R record comes back (S2 8.2.6). */
  resize(termId: string, cols: number, rows: number): void;
  /** S2 8.2.3 `close-terminal`: forgets an ended, lost or not-started terminal. */
  close(termId: string): 'ok' | 'running' | 'unknown';
  /** The colours the last focused page reported, for OSC 10 and 11 (S2 7.2). Pages calls it when
   *  a page starts focused and when a page reports focus (with the theme of its start; ruled). */
  setTheme(theme: ThemePayload): void;
  /** Called after any change of `list()`; returns the function that unsubscribes. */
  onChange(listener: () => void): () => void;
}
export interface PageInfo { windowId: string; focused: boolean; area: { cols: number; rows: number } | null }
export interface ActionHandler {
  /** Never rejects: a failure is `{ ok: false, error }`. */
  act(page: PageInfo, action: ActMessage): Promise<ResultMessage>;
}
```

`runServer` (task 23, `src/window/server.ts`):

```ts
export interface ServerOptions {
  platform: Platform;
  /** Overrides window.port; tests pass 0 (A6). */
  port?: number;
  /** --foreground: log lines go to stderr instead of server.log. */
  foreground: boolean;
  /** The first interop candidate of S2 6.4 (A32); default '/run/WSL/1_interop', or
   *  SKYDECK_TEST_INTEROP_FIRST when set. Tests always point it into the sandbox. */
  interopFirst?: string;
  /** A31 (ruled by the plan owner, follow-up "server-findable"): ms the start waits between
   *  binding the port and writing server.json, while only the window_server lock names it;
   *  default 0. `serve` sets it from SKYDECK_TEST_SERVE_START_DELAY_MS in a marked sandbox only. */
  startDelayMs?: number;
}
export interface RunningServer {
  port: number;
  runtimeDir: string;
  serverId: string;
  build: string;
  hub: TerminalHub;
  /** S2 5.5; resolves when everything is closed. A second call (a SIGTERM on top of a stop) is
   *  the same stop. */
  stop(reason: string): Promise<void>;
  /** Ruled by the plan owner (task 23, review 1): 0 once the stop has closed everything, 1 when
   *  the stop itself failed. The codes of S2 5.2 come from three places: 0 (another server of this
   *  checkout), 10, 11, 12 and 13 from runServer's start (ServeExit); 0 or 1 from `done`; 1 after
   *  an uncaught error from the `serve` command's process handler, which ends the process at once
   *  (runServer runs in test processes too, A19, and installs no process-wide handler). */
  done: Promise<number>;
}
/** Resolves once the start is done (the keepers found, the first tick run); rejects with a
 *  ServeExit(code) for 10, 11, 12, 13 and for 0 (another server of this checkout holds the lock).
 *  server.json and server.pid are written right after the port is bound and server.sock is probed
 *  (a server.sock a process answers on fails the start before they are written), BEFORE server.sock
 *  listens, so that every server that answers can be found by them; until then the lock names it;
 *  a start that fails after that removes them (ruled by the plan owner, follow-up
 *  "server-findable"). */
export function runServer(options: ServerOptions): Promise<RunningServer>;
export class ServeExit extends Error { readonly code: 0 | 10 | 11 | 12 | 13 }
/** Exported for its test (ruled, task 23): the notices a keep-alive state gives the pages —
 *  `keepalive-lost` when it fails with a reason not told since it last ran, `keepalive-back`
 *  when it runs again after one was told, else null. */
export function keepAliveNotices(): (state: KeepAlivePayload) => { kind: 'keepalive-lost' | 'keepalive-back'; text: string } | null;

// src/cli/commands/serve.ts, exported for its test (ruled, task 23): an uncaught error for the
// log — its name and code (failureKind) and its stack frames, never its message (ruled at review
// 2, replacing task 15's rule): the stack's header (`<name>: <message>` however many lines the
// message has; Node.js's `<name> [<code>]: <message>`; the name alone for an empty message) is
// removed exactly and the lines after it matching /^\s+at / are kept; a stack that does not begin
// with that header gives no frames.
export function uncaughtLine(error: unknown): string;
// Exported for its test (ruled by the plan owner, follow-up "server-findable"; A31): in a marked
// sandbox SKYDECK_TEST_SERVE_START_DELAY_MS, a whole number of ms up to 60000, is
// ServerOptions.startDelayMs; 0 outside one and when unset; another value is 0 and `invalid`
// (serve logs one line).
export function startDelayOf(env: Env): { ms: number; invalid: boolean };
```

`test/helpers/window.ts` (task 23; its shape ruled by the plan owner at task 23's review 1). A
REAL server in the test process (A19) on `realTestPlatform` (A36): there is no fake clock, no fake
`/proc` and no `places`, and `d` is not a TestDeck — it has no `sandbox`, `clock`, `proc`,
`runner` or `places` member.

- `serverSandbox(t, options?)` → `ServerSandbox`, none started yet; call it first in a test (its
  cleanup must run before the keeper sandbox's). `options`: `env` (over the sandbox's
  environment of the servers), `bootId` (what their `/proc` reports, A36), `config` (more keys of
  `config.json`; `claudeCommand` is the stand-in), `window` (`window` keys over
  `writeWindowConfig`'s Edge stub and keep-alive `off`, A32). Its members: `box` — the keeper
  sandbox (`test/helpers/keeper.ts`: `tp`, `runtimeDir`, `keepersLog`, `spec()`, `start()` for a
  keeper the test starts itself); `s` — the sandbox; `platform` — the platform every server gets
  (the sandbox's, with `STANDIN_RECORD` set); `deck` — the test's own connection to the store, as
  a command has one; `files` — `runtimeFiles(<SKYDECK_HOME>/run)`; `record` — the record file of
  every stand-in the servers' keepers start; `standin` — `claudeCommand`; `edgeCalls()` — the Edge
  stub's runs; `interopFirst` — the first interop candidate, inside the sandbox; `cDrive` — the
  servers' `SKYDECK_TEST_MNT_C` (task 24's stand-in for `/mnt/c`, where `startWindowsProgram`
  starts a Windows program: no test runs one in `/mnt/c`); `resumable(id,
  dir?)` — a transcript that makes a session resumable; `serverLog()` — `server.log`'s lines;
  `start(options?)` → `TestServer`, a server on this sandbox (port 0, `foreground` false,
  `interopFirst` in the sandbox; `options.platform` changes the platform, e.g. to record or fake
  processes).
- `TestServer`: `server` (the `RunningServer`), `logs()` (the lines it logged), `drop()` — the
  server as a crash leaves it: every timer stopped, every listener and socket closed (pages and
  keeper connections cut, nothing parked), `server.json` and `server.pid` left, and its
  `window_server` lock rewritten to name a dead process start, which is how a dead server is
  played inside one process (the pid itself lives on; ruled). Its store connection is NOT closed:
  `runServer`'s contract gives no handle to it and a seam for tests alone would change that
  contract; with every timer and connection gone nothing calls it any more, and an idle WAL
  connection holds no lock, so the next server sees what it would see after a crash.
- `startTestServer(t, options?)` → `{ server, test, d, page(options?) }`: `serverSandbox` and one
  server started on it (`options.server` are its start options).
- `connectTestPage(t, d, server, options?)` / `page()` → `TestPage`, a `ws` client of
  `server.port` (in this process or a child) that has done the handshake in mode `key` with the
  stored secret and sent `start` (focused unless told; a `view` unless `view: null`). It offers
  `send`, `sendRaw`, `next(t)` (the next message of that type; others stay for their own `next`),
  `nextBinary()`, `list(test, what)`, `view(view?)`, `act(action)` (a fresh id; its `result`),
  `output(channel)`, `all`, `closed`, `close()`.
- At `t.after` every server still running is stopped, `killKeepersIn` runs for the sandbox's
  runtime directory (A34) and every program the servers' keepers started is waited for, before
  the sandbox is removed.

### 2.6 Step 1 changes: `src/terminals/`, `src/sessions/`, `src/store/` (task 4)

```ts
// src/terminals/types.ts
export interface LaunchSpec {
  cwd: string;
  argv: readonly string[];
  sessionId: string;
  kind: 'resume' | 'new';
  /** The resume lock's value this launch took; null for `new`. */
  lock: string | null;
  /** S2 7.1 `startBy` (A20). */
  startByNs: Ns;
  label: string | null;
}
export interface Terminal { readonly name: 'here' | 'wezterm' | 'window'; readonly opensTabs: boolean; open(spec: LaunchSpec): Promise<OpenResult> }
// `terminalFor` keeps taking 'here' | 'wezterm' (the window terminal exists only inside the server).
// src/terminals/here.ts (ruled in #39): handoffScript(spec: Pick<LaunchSpec, 'cwd' | 'argv'>) — the
// handoff uses only those two, so callers and tests need not invent the other fields.

// src/sessions/resume.ts — PreparedLaunch gains:
//   preparedAtNs: Ns   (the clock when prepareResume / prepareNew ran)
//   label: string | null
// prepareNew's options gain `dir: string` (absolute, an existing directory: UsageError
// "the directory <dir> does not exist" (nothing there, or not a directory) / "… is not absolute" /
// "… cannot be checked (<reason>)" when looking at it fails (ruled in #39), <dir> sanitised;
// nothing stored); the command passes platform.cwd.
/** The time a lock value records (when it was taken or last renewed); null for a value that is not
 *  a lock skydeck writes. Beside lockEventId; startDeadline and task 21 read a lock's time with it
 *  (ruled in #39). */
export function lockTakenNs(value: string): Ns | null;

// src/sessions/launch.ts (new; launchPrepared moves here from src/cli/launching.ts)
export interface LaunchOutcome { code: number; lines: string[] }
/** A20: lock time + LOCK_TTL_NS − LOCK_START_TOLERANCE_NS for a resume (the time read from `lock`
 *  with lockTakenNs); preparedAtNs + the same for `new`, and for a resume whose `lock` is null or
 *  not a lock skydeck writes (ruled in #39: it has no time to read). Such a resume is protected by
 *  no lock of its own, so the window terminal (task 21) does not start a resume whose spec's lock
 *  is null or `lockTakenNs(lock) === null`: it answers `{ ok: false, timedOut: false }` without
 *  spawning a keeper. `launchPrepared` keeps step 1's behaviour for `here` and `wezterm`, which
 *  ignore the deadline and the lock. */
export function startDeadline(prepared: PreparedLaunch, lock: string | null): Ns;
export function launchSpec(prepared: PreparedLaunch, lock: string | null): LaunchSpec;
/** launchPrepared of step 1 with the terminal as a parameter; `terminal` null means "no terminal
 *  that opens tabs" and `noTerminal` is the error line then. Lines and lock handling unchanged. */
export function launchPrepared(deck: Deck, prepared: PreparedLaunch, terminal: Terminal | null, noTerminal?: string): Promise<LaunchOutcome>;

// src/cli/launching.ts keeps only the choice of the terminal:
export function launchWhere(deck: Deck, prepared: PreparedLaunch, where: 'here' | 'tab' | null): Promise<LaunchOutcome>;

// src/store/store.ts
/** The store throws it with "skydeck was updated; run skydeck window". isDatabaseFailure counts it
 *  (ruled in #39): a refresh's per-item catches rethrow it instead of recording it against one spool
 *  file, process or transcript and going on. */
export class StoreNewerError extends SkydeckError {}
/** guardSchema (the server's connection only, S2 10.1): before every write transaction and every
 *  single-statement write outside a transaction it reads kv schema_version and throws
 *  StoreNewerError, writing nothing, when it is newer than SCHEMA_VERSION.
 *  (ruled in #39) The store's read helpers prepare through prepareRead, which refuses anything but
 *  a SELECT (not WITH, which can stand before a write, nor PRAGMA, which can assign); a test over
 *  store.ts checks that only the write helpers prepare SQL themselves. That guards against the
 *  usual mistake, a write sent through a read helper; a function handed the database object
 *  directly is not covered. */
/** busyTimeoutMs (ruled by the plan owner, task 23, review 2; the server's connection: 250): the
 *  connection's busy timeout once it is open — default 5000, the commands' value; the migrations at
 *  open keep 5000. RangeError for a value that is not a whole number 0–2^31−1. */
export function openStore(path: string, options?: { guardSchema?: boolean; busyTimeoutMs?: number }): Store;
/** Prepares a SELECT; throws Error "not a read statement: …" for anything else. Exported for its test. */
export function prepareRead(db: DatabaseSync, sql: string): StatementSync;
// src/sessions/deck.ts
export function openDeck(platform: Platform, options?: { guardSchema?: boolean; busyTimeoutMs?: number }): Deck; // passed to openStore
// src/store/types.ts — KvKey gains:
//   'window_secret' | 'window_server' | 'window_runtime_dir' | 'window_alarm' | 'window_launching'
```

### 2.7 Messages: `src/window/protocol.ts` (task 1)

The fields of S2 8.2.2, 8.2.3 and 8.3 for stage A, as TypeScript types with JSDoc; the page reads
them through JSDoc `@import`. Later stages add their messages and `act` kinds here.

```ts
export type NsText = string; // nanoseconds, decimal
export interface ThemePayload { fg: string; bg: string }
export interface KeepAlivePayload { mode: 'wsl' | 'off'; state: 'running' | 'starting' | 'failed' | 'off'; since: NsText | null; error: string | null }

// page → server
export interface HelloMessage { t: 'hello'; protocol: number; mode: 'key' | 'launch'; nonce: string; proof: string }
export interface StartMessage { t: 'start'; assetVersion: string; windowId: string; focused: boolean; theme: ThemePayload }
export interface PingMessage { t: 'ping'; n: number }
/** Stage A: no `chips` (stage E adds them). `unfolded`: section names ('earlier'). */
export interface ViewMessage { t: 'view'; filter: string; unfolded: string[]; showDone: boolean; selected: string | null }
export interface FocusMessage { t: 'focus'; focused: boolean; selected: string | null; area: { cols: number; rows: number } }
export interface AttachMessage { t: 'attach'; term: string; cols: number; rows: number }
export interface DetachMessage { t: 'detach'; term: string }
export interface InputMessage { t: 'input'; term: string; data: string; binary?: true }
export interface ResizeMessage { t: 'resize'; term: string; cols: number; rows: number }
export type ActMessage =
  | { t: 'act'; id: number; kind: 'resume'; sessionId: string; cols: number; rows: number }
  | { t: 'act'; id: number; kind: 'new'; dir: string; label: string; group: string; flags: string; cols: number; rows: number }
  | { t: 'act'; id: number; kind: 'close-terminal'; term: string }
  | { t: 'act'; id: number; kind: 'open-link'; url: string };
export type PageMessage = HelloMessage | StartMessage | PingMessage | ViewMessage | FocusMessage
  | AttachMessage | DetachMessage | InputMessage | ResizeMessage | ActMessage;

// server → page
export interface ChallengeMessage { t: 'challenge'; protocol: 1; nonce: string }
export interface WelcomeMessage { t: 'welcome'; proof: string; key?: string; protocol: 1; assetVersion: string; serverId: string; bootId: string; version: string; keepAlive: KeepAlivePayload; nowNs: NsText }
export interface PongMessage { t: 'pong'; n: number; bootId: string; serverId: string }
export interface PrPayload { url: string; repo: string; number: number; title: string | null; level: string; error: string | null }
export interface ElsewherePayload { pid: number; tty: string | null; dir: string | null }
export interface RowPayload {
  id: string; shortId: string; title: string; titleSource: string; group: string | null; groupSource: string | null;
  state: 'working' | 'waiting' | 'running' | 'not-running'; stateDetail: string | null;
  sinceNs: NsText; lastActivityNs: NsText; dir: string | null; marks: string[];
  hasNote: boolean; noteHead: string[]; done: boolean; prs: PrPayload[];
  chip: { level: string; count: number } | null;
  terminal: string | null; slot: number | null; elsewhere: ElsewherePayload | null;
  /** S2 7.5: a terminal of the window whose program holds no session yet. */
  starting: boolean;
  attention: null; // stage B
  stack: null; // stage E
}
export interface SectionPayload { name: 'open' | 'week' | 'earlier'; folded: boolean; firstNs: NsText | null; lastNs: NsText | null; count: number; rows: RowPayload[] }
/** `state`: a TerminalState of 2.5 (`reconnecting` shows S2 7.8's bar); `notReported`: S2 7.5's "started, not reported". */
export interface TerminalPayload { id: string; slot: number | null; sessionId: string | null; state: string; notReported: boolean; cols: number; rows: number; ownsSize: boolean }
/** For the selected session only: what the resume card shows (S2 12.6). */
export interface SelectedPayload {
  sessionId: string;
  command: string | null; // printableCommand of the command a resume would run, null when it cannot be printed
  flagsKnown: boolean;
  unknownFlags: string[];
  ended: 'exited' | 'unexpectedly' | 'mid-turn' | null;
  expiring: boolean;
  expired: boolean;
}
export interface ListMessage {
  t: 'list'; nowNs: NsText;
  counts: { working: number; waiting: number; running: number; starting: number; elsewhere: number; notRunning: number };
  sections: SectionPayload[]; doneHidden: number; banner: null; terminals: TerminalPayload[];
  selected: SelectedPayload | null;
  /** Known project directories, most recent first (S2 12.6, the new form). */
  dirs: string[];
}
export interface SnapMessage { t: 'snap'; term: string; ch: number; cols: number; rows: number; data: string }
export interface SizeMessage { t: 'size'; term: string; cols: number; rows: number; owner: boolean }
export interface ExitMessage { t: 'exit'; term: string; code: number | null; signal: number | null; atNs: NsText; lost: boolean; notStarted: string | null }
/** `sessionId`: the session a successful resume or new started (A25 below), else null. */
export interface ResultMessage { t: 'result'; id: number; ok: boolean; lines: string[]; error: string | null; sessionId: string | null }
/** `term`: the terminal a `gap`, `newer-keeper` or `input-full` notice concerns; null for the keep-alive and tick notices. */
export interface NoticeMessage { t: 'notice'; kind: 'keepalive-lost' | 'keepalive-back' | 'gap' | 'newer-keeper' | 'input-full' | 'tick-failed'; term: string | null; text: string }
export interface ByeMessage { t: 'bye'; reason: string }
export type ServerMessage = ChallengeMessage | WelcomeMessage | PongMessage | ListMessage | SnapMessage
  | SizeMessage | ExitMessage | ResultMessage | NoticeMessage | ByeMessage;

/** Output frames (S2 8.2.3): byte 1, the channel as 4-byte big-endian, the record's bytes. */
export function encodeOutputFrame(channel: number, bytes: Uint8Array): Uint8Array;

/** Strict: a type, kind or field it does not know, a wrong type, a string over its limit (paths
 *  4096, text fields 1024, `input.data` 64 KiB) is { ok: false, kind }. Never throws. */
export function parsePageMessage(text: string): { ok: true; value: PageMessage } | { ok: false; kind: string };

// server.sock (S2 8.3), stage A
export interface PingAnswer { serverId: string; bootId: string; build: string; protocol: 1; pid: number; port: number; checkout: string }
export interface StatusAnswer {
  /** Ruled by the plan owner (follow-up "server-findable", 10:16Z): true while the start is not
   *  done — the same flag that answers a page's upgrade with 503; optional for the reader
   *  (client.ts): absent — a server of an older build — means false; another type is an answer
   *  that cannot be read. */
  starting?: boolean;
  pages: number; terminals: { id: string; slot: number | null; state: string; sessionId: string | null; pid: number | null }[];
  keepAlive: KeepAlivePayload; python: { found: boolean; version: string | null };
  build: string; checkout: string; startedAtNs: NsText; envOrigin: { dir: string; atNs: NsText };
}
export interface TokenAnswer { id: string; token: string; expiresAtNs: NsText }
export type TokenState = 'waiting' | 'used' | 'reused' | 'expired' | 'dropped';
export type ControlRequest =
  | { route: 'ping' } | { route: 'status' } | { route: 'shutdown' }
  | { route: 'token'; seconds: 30 | 600 } | { route: 'token-state'; id: string } | { route: 'token-drop'; id: string };
/** Method, path and JSON body to a request; an unknown field or route is { ok: false, kind }. */
export function parseControlRequest(method: string, path: string, body: string): { ok: true; value: ControlRequest } | { ok: false; kind: string };
```

**Limits `parsePageMessage` applies** (ruled by the plan owner, task 1; also in S2 8.2.3), so
that the page (tasks 26–29) never sends what the server refuses: strings are measured in UTF-8
bytes — paths (`new.dir`) and URLs (`open-link.url`; the action then opens one only up to 2,048
characters, S2 9.6) at most 4,096, `input.data` at most 64 KiB (65,536 bytes; with `binary`, at most
65,536 characters, each U+0000–U+00FF), every other string at most 1,024 — and every string must
be well formed (no lone surrogate). `encodeOutputFrame` throws a `RangeError` for a channel that is
not a whole number 0–2³²−1. `cols` and `rows` (also `focus.area`'s) are whole numbers
1–65,535; `ping.n` and `act.id` whole numbers from 0; `term` 12 lower-case hex characters,
`windowId` 16 (A21); `selected` and `sessionId` pass `isSessionId`; `unfolded` holds section names,
each once; `binary` is `true` or absent; `hello.protocol` any whole number from 0 (the server
answers 4426) and `hello.nonce`/`proof` only length-checked (their form is `isNonce`, 2.8).
`parseControlRequest`'s kind starts with `route` when no route matches the method and path (stage
C's `/resume`, `/new`, `/restore` included; task 18 answers 404) and with `body` for a bad body
(400); a `GET` has the empty body, `POST /shutdown` the empty body or `{}`; token ids are 32
lower-case hex characters.

Two additions to S2 8.2.3 and 8.3 that task 1 records in the design: `result` carries
`sessionId`, so a page can select the session a `new` started (A25); `GET /ping` carries
`checkout`, which S2 5.1 compares but 8.3's table does not list (A26).

### 2.8 Server modules other tasks call

```ts
// src/window/auth.ts (task 11). Thrown errors below were ruled by the plan owner (task 11); their
// messages name sizes, never values. Callers (tasks 17 and 18) run isNonce on every nonce a peer
// sent before they call pageProof, serverProof or wrapSecret, so a page's bad nonce closes the
// connection (4001) and never reaches a throw.
/** One transaction. A stored value that is not 32 bytes in isNonce's form is replaced as if absent
 *  (ruled): it could prove nothing, and a page holding a key from it gets 4003 and asks for a new launch.
 *  Both: RangeError, and nothing stored, when the random source gives another number of bytes. */
export function ensureSecret(store: Store, random: (n: number) => Uint8Array): Uint8Array;
export function replaceSecret(store: Store, random: (n: number) => Uint8Array, guard?: () => void): void;         // --new-secret; clears window_alarm; one transaction
/** `guard` (ruled by the plan owner, follow-up "server-findable"; optional, none by default) runs
 *  first inside that transaction; when it throws, nothing changes — neither the secret nor the
 *  alarm — and its error is thrown. `--new-secret` passes one that refuses while the window_server
 *  lock names a holder alive or unknown by design 5.5's rule. */
/** RangeError for a key that is not 32 bytes, a mode other than 'key' | 'launch', or an sN or cN that is not isNonce. */
export function pageProof(key: Uint8Array, mode: 'key' | 'launch', sN: string, cN: string, origin: string): string;
export function serverProof(key: Uint8Array, mode: 'key' | 'launch', sN: string, cN: string, origin: string): string; // as pageProof
/** RangeError for a secret or token that is not 32 bytes, an IV that is not 12, or an sN or cN that is not isNonce. */
export function wrapSecret(secret: Uint8Array, token: Uint8Array, sN: string, cN: string, iv: Uint8Array): string;
/** 43 characters of base64url, 32 bytes, in the canonical form (ruled): the two bits the last
 *  character has to spare are zero, as an encoder writes them, so one value has one text. */
export function isNonce(text: string): boolean;
/** Mode `key` (ruled, review 2 of task 11): whether `proof` is the page's proof made with the
 *  secret, by check's rules — timingSafeEqual on two 43-byte buffers; false without comparing for a
 *  proof that is not a string of 43 bytes, an sN or cN that is not isNonce, an origin that is not a
 *  string or a secret that is not 32 bytes. Never throws. Task 17 uses it for mode `key` and never
 *  compares proofs itself. */
export function keyProofMatches(secret: Uint8Array, proof: string, sN: string, cN: string, origin: string): boolean;
export interface Tokens {
  /** `id`: 32 lower-case hex characters (16 random bytes, the control parser's form). RangeError for
   *  seconds other than 30 and 600, or a random source that gives another number of bytes; Error
   *  when it repeats an id. How a token ends (ruled): it expires when its `clock.after` timer of
   *  `seconds` runs out (a timer counts on a clock that does not jump, so WSL's wall clock stepping
   *  back cannot stretch it) or when it is looked at (`state`, `check`) with the wall clock at or past
   *  `expiresAtNs` (a PC that slept), whichever comes first. It holds its timer only while it waits:
   *  a use, a drop and forgetAll stop it. */
  mint(seconds: 30 | 600): { id: string; token: Uint8Array; expiresAtNs: Ns };
  /** null for an id never minted (or forgotten). A used token stays 'used' (or 'reused') whatever
   *  comes later; an unused one is 'dropped' once given up, else 'expired', else 'waiting'. */
  state(id: string): TokenState | null;
  drop(id: string): boolean; // false for an unknown id
  /** Constant-time check of `proof` against every token a proof can still reach — waiting, used or
   *  reused; one dropped or expired before its use can only give 'none' and is skipped: timingSafeEqual
   *  on equal-length buffers, not stopping at a match. A proof that is not a string of 43 bytes, an
   *  sN or cN that is not isNonce, or an origin that is not a string is 'none' without comparing.
   *  A match marks the token used. The alarm (ruled, review 2 of task 11): a proof with a used token
   *  marks it reused FIRST, then calls onAlarm on that token's first reuse only (again on a later
   *  reuse only while every earlier call failed), so a used token presented in a loop costs no store
   *  write. check NEVER throws, whatever onAlarm does: the verdict stays 'reused', and a failing
   *  onAlarm (a refused store write, a locked database) comes back as `alarmFailure` — the error's
   *  name and string code, never its message — for the caller to log; else null. */
  check(proof: string, sN: string, cN: string, origin: string): { kind: 'match'; token: Uint8Array } | { kind: 'reused'; alarmFailure: string | null } | { kind: 'none' };
  forgetAll(): void; // empties everything, stops every timer
}
export function createTokens(clock: Clock, random: (n: number) => Uint8Array, onAlarm: () => void): Tokens;
/** An error's name and, when it has one, its code (`Name (CODE)`), for a log line; never its
 *  message (S2 5.2). Never throws. Exported for task 18's control socket (ruled by the plan owner). */
export function failureKind(error: unknown): string;
/** kv window_alarm, in one transaction: the time of the FIRST second use is kept (ruled, review 2
 *  of task 11) — a recorded time is never overwritten; a value that is not a decimal time is. */
export function raiseAlarm(store: Store, nowNs: Ns): void;

// src/window/runtime.ts (task 15)
/** S2 5.2: `serve` exits 12. message `the runtime directory <dir> cannot be used: <reason>`. */
export class RuntimeDirError extends SkydeckError { readonly dir: string; readonly reason: string }
export interface RuntimeFiles { dir: string; serverJson: string; serverSock: string; serverPid: string; keepalivePid: string; keepaliveInterop: string; interop: string; termsDir: string; keeperFile(build: string): string; termSock(id: string): string; termPid(id: string): string }
/** keeperFile throws for a build that is not [A-Za-z0-9_-]+, termSock and termPid for an id that
 *  is not a terminal id (12 lowercase hex, 2.3): no name leads outside the directory. */
export function runtimeFiles(dir: string): RuntimeFiles;
/** S2 4.2. 'follow' (commands): the store's record whenever there is one, whatever it holds;
 *  runtimeDirByRule only without a record. 'take' (a starting server): the record only when its
 *  directory exists and holds a keeper alive by its .pid line, else runtimeDirByRule; then writes
 *  kv window_runtime_dir. In both modes a record that is empty or not an absolute path counts as
 *  no record (skydeck never writes one; ruled, task 15). 'take' gives a record up only when every
 *  keeper line in it is 'dead' (an 'unknown' one keeps it). The rule's XDG_RUNTIME_DIR check: a
 *  directory owned by `platform.uid`, mode without group or other bits, and
 *  /var/lib/systemd/linger/<userName> exists; a check that throws passes it over. */
export function resolveRuntimeDir(deck: Deck, mode: 'follow' | 'take'): { dir: string; rule: RuntimeRule | 'record' };
/** Creates the directory (0o700) and terms/ (0o700); refuses (RuntimeDirError, reason) when it is
 *  not the user's, not 0o700, or a socket path would be 108 bytes or more. The socket path
 *  checked is the longest one, a keeper's terms/<id>.sock (the directory + 24 bytes), before
 *  anything is created: `serve` refuses to start (12) rather than run without terminals (ruled,
 *  task 15; S2 4.2). A directory it creates gets exactly 0o700 whatever the umask; an existing one
 *  that is a symbolic link, not a directory, another uid's or of another mode is refused, never
 *  changed. */
export function prepareRuntimeDir(platform: Platform, files: RuntimeFiles): void;
/** S2 16.5: writes <dir>/keeper-<build>.py (0o600, through a temporary name) and removes the
 *  keeper files of other builds and the temporaries a cut-short write of one left behind (ruled,
 *  task 15): only regular files directly in <dir> named `keeper-<build>.py` or
 *  `.keeper-<build>.py.<12 lowercase hex>.tmp` (Files.writeText's temporary), the forms this
 *  function creates; anything else stays. */
export function writeKeeperFile(files: Files, runtime: RuntimeFiles, build: string, code: string): void;
/** S2 7.8: removes terms/<id>.sock and .pid of keepers whose line is 'dead' (pidLineState, 2.8) or
 *  whose socket refuses connections (a socket without a .pid line, or beside one that is not a pid
 *  line, too); a line that is 'unknown' never removes anything by itself. Only ECONNREFUSED is a
 *  refusal: a full accept queue (EAGAIN) or any other error belongs to a keeper that may live
 *  (ruled, task 15). Nothing is removed for a keeper whose .pid file cannot be read (`line` null
 *  in listKeeperLines), whatever its socket says; a directory with such a name is neither tried
 *  nor removed. Resolves to the terminal ids whose files it removed, in order. */
export function removeDeadKeeperFiles(platform: Platform, runtime: RuntimeFiles): Promise<string[]>;
export interface ServerJson { pid: number; procStart: number; bootId: string; port: number; serverId: string; build: string; checkout: string; startedAt: NsText; envOrigin: { dir: string; atNs: NsText } }
/** null when the file is missing or does not hold a valid value; a field a newer skydeck adds is
 *  ignored; a read error other than "missing" is thrown. Valid (ruled, task 15; tasks 18, 22, 23 and
 *  24 write their fixtures through writeServerJson with such values): pid a safe integer ≥ 1;
 *  procStart a safe integer ≥ 0; bootId, serverId and build non-empty strings without whitespace;
 *  port a whole number 1–65535 (the bound port, never 0: A6); checkout and envOrigin.dir absolute
 *  paths without NUL; startedAt and envOrigin.atNs canonical decimal ns text (no sign, no leading
 *  zero, ≤ 2^63 − 1). */
export function readServerJson(files: Files, path: string): ServerJson | null;
/** 0o600, atomic. Throws for a value readServerJson would read as null. */
export function writeServerJson(files: Files, path: string, value: ServerJson): void;
/** S2 5.2: kv window_server `<pid>:<process start>:<boot id>:<checkout>` in one transaction, taken
 *  when free or when the server it names is 'dead' by design 5.5's rule (pidLineState), never on
 *  'unknown'; a stored value that does not parse names no server and is taken. Throws (ruled, task
 *  15) for a `value` that is not a lock: pid not a safe integer ≥ 1, procStart not one ≥ 0, a boot
 *  id that is empty or holds ':' or whitespace, a checkout that is not an absolute path or holds NUL. */
export function takeServerLock(deck: Deck, value: { pid: number; procStart: number; bootId: string; checkout: string }): { taken: true } | { taken: false; holder: { pid: number; checkout: string } };
/** Removes the lock only when it names this process's pid (`platform.pid`). */
export function releaseServerLock(deck: Deck): void;
/** The holder the lock names, not judged: its pid line and checkout; null when the lock is free or
 *  holds a value that does not parse (ruled by the plan owner, follow-up "server-findable": how a
 *  command finds a server that is starting, findServer and stopServer below). */
export function readServerLock(store: Store): { line: PidLine; checkout: string } | null;
/** Keepers by their .pid lines (S2 4.2), whatever their state (pidLineState, 2.8), for doctor,
 *  uninstall and the server's rediscovery. doctor counts state 'alive'; removeDeadKeeperFiles, the
 *  server's rediscovery and `uninstall --purge` act only on 'dead' (purge refuses while any line
 *  is 'alive' or 'unknown'). Reads only regular files terms/<terminal id>.pid (a keeper's
 *  temporary must not have that name); one that holds no pid line, or was removed meanwhile, is
 *  skipped. A file that cannot be read (EACCES, EIO …) gives `line: null` with state 'unknown'
 *  (ruled, task 15: never removed, counted as alive wherever something would be given up — the
 *  runtime directory's record, the keep-alive, `uninstall --purge`, which refuses on it) and the
 *  others are still read; tasks 16 and 24 handle a null `line`, and doctor reports such an entry
 *  on its own, as a keeper file that cannot be read (task 24 decides the text). The boot id is read once, and
 *  every line is 'unknown' when it cannot be read. */
export function listKeeperLines(platform: Platform, files: RuntimeFiles): { id: string; line: PidLine | null; state: PidLineState }[];

// src/window/log.ts (task 15)
/** One line per call with an ISO time; to stderr when `foreground`; at 1 MiB the file becomes .1
 *  (rotateLog, before the line is appended). The line is passed through `sanitize` (one line:
 *  breaks become spaces, escapes removed). The file is only appended to (other writers' lines, the
 *  launcher's and Node.js's, stay). The function never throws and never ends the process (ruled,
 *  task 15): a rotation that fails does not stop the line, a time that cannot be shown is `-`, a
 *  line it cannot append goes to fd 2 by a synchronous write, and one that cannot be written there
 *  either is lost. */
export function serverLog(platform: Platform, path: string, foreground: boolean): (line: string) => void;
/** When `path` is 1 MiB or more: copies it to `<path>.1` (through `.<name>.1.tmp`, renamed over an
 *  older .1; mode 0o600) and truncates `path` in place (ruled, task 15): a writer holding the file
 *  open in append mode (the server's own stdout and stderr in server.log, each keeper's stderr in
 *  keepers.log) goes on writing into it; a line appended between the copy and the truncate can be
 *  lost. A failure is thrown and leaves `path` as it was. */
export function rotateLog(files: Files, path: string): void;

// src/window/pidline.ts (task 8). The line, exactly, with one '\n' at the end:
//   server.pid, keepalive.pid:  "4242 51234567 6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
//   terms/<id>.pid (a keeper): "4242 51234567 6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f 1 0"
//   — pid, process start (field 22), boot id, and for a keeper its KEEPER_VERSION and started 0|1,
//   separated by one space. Tasks 7 (sh), 8 (TypeScript) and 9 (python) write and read this form.
//   The boot id and the version are any token without whitespace (tests invent boot ids); pid
//   (1 or more) and process start (0 or more) decimal integers (safe integers). The final '\n' may
//   be missing when read.
export interface PidLine { pid: number; procStart: number; bootId: string; keeper?: { version: string; started: boolean } }
/** Throws for a pid that is not a positive whole number, a process start that is not a
 *  non-negative whole number, and an empty boot id or version or one holding whitespace. */
export function formatPidLine(line: PidLine): string;
export function parsePidLine(text: string): PidLine | null; // null for pid 0, too
/** Design 5.5, three-valued. 'unknown' = it could not tell: no current boot id (`bootId` null),
 *  a /proc read that failed (the platform threw), a stat line whose process start cannot be read.
 *  'dead' = another boot, no process with the pid, or another process start.
 *  NOTHING IS EVER REMOVED, ENDED OR GIVEN UP ON 'unknown': only 'dead' allows removing a socket or
 *  a pid file. Who uses which:
 *  - pidLineState, acting only on 'dead': removing a keeper's socket and pid file
 *    (removeDeadKeeperFiles, the server's rediscovery, tasks 15 and 16); giving up a recorded
 *    runtime directory (resolveRuntimeDir 'take': only when every keeper line in it is 'dead');
 *    taking the server lock from the server it names (takeServerLock); `uninstall --purge`
 *    (refuses unless every keeper is 'dead'); the keep-alive (task 7, sh) ends only when the
 *    server's and every keeper's line is dead, never when it cannot read the boot id.
 *  - isPidLineAlive ("known alive"): showing and counting (doctor counts state 'alive'), and
 *    before signalling a process (stopServer, the tests' killKeepersIn): only a process known alive
 *    is signalled. */
export type PidLineState = 'alive' | 'dead' | 'unknown';
export function pidLineState(line: PidLine, proc: Proc, bootId: string | null): PidLineState;
/** pidLineState(...) === 'alive'. */
export function isPidLineAlive(line: PidLine, proc: Proc, bootId: string | null): boolean;

// src/window/client.ts (task 18): the command line's side of server.sock
// Ruled by the plan owner (task 18): ping is 'refused' for ECONNREFUSED and ENOENT (a missing
// socket) and 'timeout' for ETIMEDOUT and EAGAIN (a full accept queue: the server lives but does
// not answer now); any other system error (EPIPE or ECONNRESET from a server that is closing:
// task 22 catches them), another status or an answer that cannot be read (one that is not HTTP
// included) is a SkydeckError, and a RangeError from requestUnix passes unchanged. The other methods wait 5 s and
// reject with a SkydeckError that says what went wrong (never a token). tokenState rejects for a
// token the server does not know (404); dropToken resolves for one (`{ ok: false }`: nothing to
// give up). Every answer is checked against its type; a field a newer server adds is left out.
export interface ControlClient {
  ping(timeoutMs?: number, signal?: AbortSignal): Promise<PingAnswer | 'refused' | 'timeout'>; // 5 s default; `signal` is passed to requestUnix and an abort is 'timeout' (ruled, task 22)
  status(): Promise<StatusAnswer>;
  token(seconds: 30 | 600): Promise<TokenAnswer>;
  tokenState(id: string): Promise<TokenState>;
  dropToken(id: string): Promise<void>;
  shutdown(): Promise<void>;
}
export function controlClient(net: Net, sockPath: string): ControlClient;

// src/window/lifecycle.ts (task 22)
export type FoundServer =
  | { kind: 'none' }
  | { kind: 'ours'; ping: PingAnswer }
  | { kind: 'other-build'; ping: PingAnswer }
  | { kind: 'other-checkout'; ping: PingAnswer }
  | { kind: 'hung'; pid: number; starting?: true }; // starting: see findServer (ruled, follow-up "server-findable")
/** Timeouts in ms, the design's values by default (A31): ping 5000, start 10000, stop 10000, kill 5000.
 *  A time left out or given as undefined is the default; one that is not a whole number from 0 to
 *  2^31 − 1 makes each function below reject with a RangeError before it does anything (ruled, task 22). */
export interface LifecycleTimes { pingMs?: number; startMs?: number; stopMs?: number; killMs?: number }
/** Ruled (task 22): a server.json line that cannot be judged ('unknown', design 5.5) rejects with a
 *  SkydeckError — the command says it cannot tell whether the server runs; nothing is given up on
 *  it. After a ping without an answer the line is judged again: dead meanwhile → none, else hung. A
 *  refused or failed ping (a server in its orderly stop no longer accepts) is tried again every 100 ms
 *  until pingMs is over — an answer is classified, a process still alive then is hung; a ping that
 *  timed out is not tried again (ruled, task 22, review 2). The ping open at the end is aborted.
 *  All three functions reject with a SkydeckError, never another error, for a server.json, a
 *  terms/ directory or a signal the system refuses (task 22, review 2). */
/** A server that is starting (ruled by the plan owner, follow-up "server-findable"): while
 *  server.json is missing or names a dead process, the window_server lock (readServerLock) is
 *  read. A holder dead, absent or a value that does not parse: none, as before. A holder that
 *  cannot be judged: the SkydeckError of an unknown server.json line ("cannot tell whether the
 *  window's server (pid N) still runs…"). A holder alive: a server that is starting — server.json
 *  is looked at again every 100 ms within pingMs and, once it names a live process, judged and
 *  pinged as above in what is left of pingMs; still not recorded when pingMs is over →
 *  { kind: 'hung', pid: <the lock's>, starting: true }; recorded during the wait but no answer in
 *  what is left → { kind: 'hung', pid, starting: true } too (review 2: it is still starting). A caller that ignores `starting` treats it
 *  as any hung server: it is never "not running". */
export function findServer(deck: Deck, checkout: string, build: string, times?: LifecycleTimes): Promise<FoundServer>;
/** Starts `<appRoot>/bin/skydeck serve` detached (S2 5.2) and waits at most 10 s for a ping of this
 *  checkout (ruled, task 22), the current build and boot id, which counts only once server.json
 *  names that server — pid, server id, boot id, its process alive (ruled by the plan owner, task 25;
 *  else its own line). A server of this build writes server.json before server.sock answers, so for
 *  it the check passes at its first answer — it stays for any server that answers before it
 *  records itself (ruled by the plan owner, follow-up "server-findable"). One fixed line per exit
 *  code; for exit 11 the running server of another checkout is named from server.json or, while
 *  that server is starting and has written none yet, from the window_server lock (sanitised;
 *  ruled, follow-up "server-findable"). Settled at the follow-up's review 2: exit 0 while neither
 *  server.json nor the lock names a process that is alive or cannot be judged — the server this
 *  command started was stopped by another command during its start, or ended — gives at once
 *  "the window's server stopped before this command could use it; run skydeck window again (its
 *  log: <stateDir>/server.log)" (the path sanitised), not the no-answer line after the wait; and
 *  "answers, but did not record itself" is given only of a server that still answers (it is
 *  pinged once more) — of one that is gone (its identity dead by design 5.5's rule where
 *  server.json or the lock names it, else no /proc entry for its pid) that same stopped line, of
 *  one that lives but answers no more "the window's server (pid N) does not answer; skydeck window
 *  --restart stops it". Each
 *  ping of that wait waits at most 1 s (then the runtime directory is looked up again), and the one
 *  open when the wait ends is aborted: nothing outlives the call (ruled, task 22, review 2). A boot
 *  id that cannot be read rejects with a SkydeckError before anything is started. */
export function startServe(deck: Deck, times?: LifecycleTimes): Promise<{ ok: true; ping: PingAnswer } | { ok: false; line: string }>;
/** A server that answers ping: POST /shutdown, wait 10 s; then SIGTERM and after 5 s SIGKILL. A server that gives no
 *  ping answer within the ping wait (a refused or failed ping is tried again every 100 ms, as
 *  findServer does; one that times out is not — ruled by the plan owner, follow-up
 *  "server-findable", third ruling; a server gone meanwhile is stopped) gets no POST /shutdown
 *  and SIGTERM at once, without the 10 s (ruled, task 22). Each
 *  signal only after server.json's pid, process start and boot id are confirmed alive at that moment
 *  (S2 5.1 --restart). Never signals a keeper (an identity a keeper's .pid line holds), this process
 *  or pid 1: rejects with a SkydeckError instead, as for an 'unknown' line and for a server that
 *  outlives SIGKILL by 5 s (ruled, task 22). `stopped` false: no live server was found.
 *  `keepers` (ruled, task 22, review 2): the keepers whose .pid line in the runtime directory is
 *  'alive' or 'unknown' (listKeeperLines), counted before the stop whether or not a server runs or
 *  answers — never the server's GET /status, which a hung server does not answer and which lists
 *  ended terminals. Task 24's "<n> terminals in the window keep running" (S2 16.2) shows it. */
/** `options.hungPid` (ruled by the plan owner, task 25): the pid of the server the caller has just
 *  found not answering (findServer's 'hung'); when server.json still names it, no ping is sent and
 *  SIGTERM comes at once. Left out, or another pid: as above.
 *  A server that is starting (ruled by the plan owner, follow-up "server-findable"): found as
 *  findServer finds it. One that records itself within pingMs is pinged in what is left of pingMs
 *  and stopped as above; one still not recorded then, or whose pid is `hungPid`, gets SIGTERM at once
 *  and SIGKILL after killMs to the identity the lock names, each after it was confirmed alive and
 *  never to a keeper, this process or pid 1 (the refusal names "skydeck's window_server lock"). */
export function stopServer(deck: Deck, times?: LifecycleTimes, options?: { hungPid?: number }): Promise<{ stopped: boolean; keepers: number }>;

// src/window/build.ts (task 14)
/** sha256 over the sorted paths and contents of every file under bin/, src/, web/, vendor/ (A12), first 16 hex. */
export function computeBuild(files: Files, appRoot: string): string;
/** Every file of the build read once (path relative to the app root → bytes, in sorted order) and
 *  the build over exactly those bytes; computeBuild is its `build`. loadAssets serves these bytes,
 *  and a command that compares builds can use it too (ruled by the plan owner, task 14). */
export function readBuild(files: Files, appRoot: string): { build: string; files: Map<string, Uint8Array> };
```

### 2.9 The page's modules (tasks 26 and 31)

`web/app.js` owns the connection, the state (the last `list`, the selection, the focus zone, the
most-recently-used order of sessions for Ctrl+Tab, which terminals are attached) and the key
dispatch. It calls the other modules only through these functions:

```js
// web/keys.js — task 31; pure, no DOM; tested with node:test (test/web/keys.test.ts)
/** @typedef {{ key: string, code: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean }} KeyLike */
/** @typedef {'list' | 'terminal'} Zone */
/** The window's own chord (S2 12.9, stage A): { kind: 'slot', slot } | { kind: 'previous' } |
 *  { kind: 'toggle-zone' } | { kind: 'new' } | { kind: 'find' } | { kind: 'copy' } |
 *  { kind: 'paste-raw' } | { kind: 'help' } | { kind: 'reload' } |
 *  { kind: 'later', stage: 'B' | 'E' } (A11: Ctrl+Shift+J, Ctrl+Shift+P) | null */
export function windowChord(e, zone) {}
/** The terminal's mapping (S2 9.1): { send: string } (cancel the key) | 'browser' (neither send
 *  nor cancel) | null (xterm.js handles it). */
export function terminalKey(e) {}
/** List-zone keys (S2 12.9): { kind: 'move', by: 1 | -1 | 'home' | 'end' | 'page-up' | 'page-down' } |
 *  { kind: 'fold' } | { kind: 'unfold' } | { kind: 'enter' } | { kind: 'filter' } |
 *  { kind: 'show-done' } | { kind: 'escape' } | { kind: 'reload' } |
 *  { kind: 'later', stage: 'D' } (A11: `l`, `g`, `n`, `p`, `d`, F2) | null
 *  `reload`: F5, Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R, BrowserRefresh alone / with Shift / with
 *  Ctrl (ruled for task 31); windowChord gives `reload` for Ctrl+Shift+R and BrowserRefresh. */
export function listKey(e) {}
/** Whether the page cancels the key (preventDefault): exactly the keys it handles (Alt+F4 never).
 *  `handled` (boolean) means "the page acted on this key" (ruled for task 31). False for Alt+F4,
 *  and for Ctrl+V in the terminal zone, whatever `handled` says; true, whatever `handled` says,
 *  for every windowChord (`later` ones included), the list zone's reload keys, and the terminal
 *  keys the page sends itself (terminalKey `{ send }`: Shift+Enter, Ctrl+Shift+V); for every
 *  other key it returns `handled`. While a text field of the page has the keyboard (the filter,
 *  the new form), app.js passes `handled = false` for the keys it leaves to the field, so that
 *  `j` or `/` type there. In the terminal zone F5, Shift+F5, Ctrl+F5 and Ctrl+R go to the program
 *  only while xterm.js has the keyboard; while something of the page has it (the find bar, the
 *  New form, a card, the ended bar) app.js treats them as the page's reload (`listKey` gives
 *  `reload` in any zone) and passes `handled = true` (ruled for task 31). */
export function cancels(e, zone, handled) {}
// Tasks 26 and 28: a key that two functions classify (Ctrl+Shift+V: windowChord `paste-raw` and
// terminalKey `{ send: '\x16' }`; Ctrl+Shift+R and BrowserRefresh: windowChord and listKey
// `reload`) is acted on once.

// web/list.js — replaced by task 27. Task 27's list also writes the title bar's counts into
// `#counts` of index.html (S2 12.1; the minimal list leaves it empty). app.js hands it `escape` (with `key`) while a filter is set, so that the
// list clears its field with the filter; with no filter app.js goes back to the terminal itself.
// app.js applies list keys only while the keyboard is on the list itself, not on a control of it
// (a button, a link, a field: Enter presses a button; review 2 of task 26), or while nothing has
// the keyboard. Accepted for task 26: switching to the terminal zone never focuses a card's
// button (an Enter would press it: nothing resumes but on purpose) — it gives the keyboard to the
// shown terminal, else to a card's first text field, else to the zone itself, and so does app.js
// when what had the keyboard goes away (a dismissed notice, a closed form, a replaced card); a
// refused `open-link` says its error in the key bar; Esc in the new form closes it — app.js takes
// that Esc in the capture phase, so a list of the form's own cannot keep it (task 29).
// A render never loses a click on a row (task 27): app.js renders when a list arrives and when
// only the zone changed — at the focus a mousedown on a row moves, before its mouseup —, so the
// list keeps a row's element across renders (the placeholder does) or selects on pointerdown.
// At every render, and after each call it makes into a module, app.js gives the keyboard to the
// zone when its holder is gone or no longer visible (its container hidden); so does a click that
// selected nothing, once it is done (a notice's text, the key help, the header above a terminal).
// But app.js never moves the keyboard BY ITSELF while text of the page that the user can see is
// selected (a selection left in a card that is hidden now does not count): giving a text control
// — xterm.js's helper textarea — the keyboard would take the selection away, and the Ctrl+C meant
// to copy it would reach the program. While text is selected the keyboard may be on nothing
// although the key bar names a zone; the next plain click, a zone chord, or the next render once
// nothing is selected gives it back (no rule acts on the end of a selection: a mousedown's caret
// would set it off before a drag selects). The user's own actions move it whatever is selected:
// a zone chord, Esc closing the new form, and a terminal that the page's own resume or new
// brings (S2 11.3 comes first) — until that terminal is shown, another session is selected or the
// connection is lost; a terminal that only a list brought does not.
// A key pressed while the keyboard was not on the program's own holder (the element inside
// `.xterm`: for the real view xterm.js's textarea; not the find bar's field or buttons, nor any
// other element of the view) reaches the program only when it is pressed again: once the holder
// has the keyboard, every further event of it (auto-repeat keydowns, keypress, keyup) is
// swallowed at the window's capture phase, before the view sees it, until it is released. A key
// the page acted on that moved the keyboard there is such a key; so are a card's button or the
// form's Enter that starts a terminal (task 29) and the find bar's Esc, Enter or button (task
// 28). A window chord acts at its first keydown only, not at its auto-repeats.
// Ctrl+Shift+V reaches `pasteRaw()` only while the keyboard is in `#terminal` and not on a text
// field — the view's own find field included, whose key events reach `chord(e)` (Z1).
// `area()` takes off the height of `#cards .card-header` — a hook: cards.js keeps that class on
// its header (task 29) — as it is while shown, else as last shown: for an act's first size and
// for every pane but a shown terminal; for `focus` while a terminal is shown, all the cards show
// above it. Before any header was shown it is 0, and that first terminal is resized once (a
// known limit, Z1). The columns and rows for that box come from the view's `fits` (its optional
// member, below). A module that hides or removes its own keyboard holder in its OWN handler (the
// find bar's Esc, a card's own button) is followed by no call of app.js: it moves the keyboard
// itself to another element of its own — there is no hook for it. The page's chrome (the
// title bar, the key bar, a notice's ×) takes no keyboard on a mouse click, so a click there
// leaves it where the user was (ruled, review 2 of task 26, rounds three to six).
/** @param {HTMLElement} root
 *  @param {{ select(id: string, how: 'click' | 'key'): void, activate(id: string): void,
 *           view(change: { filter?: string, unfolded?: string[], showDone?: boolean }): void }} hooks */
export function createList(root, hooks) {} // → { render(list, selected, zone), key(action), editFilter() }

// web/terminal-view.js — replaced by task 28
/** @param {HTMLElement} root
 *  @param {{ send(message: object): void, chord(e: KeyboardEvent): boolean, openLink(url: string): void }} deps */
export function createTerminalView(root, deps) {}
// → { show(term: TerminalPayload | null), snap(msg), output(channel, bytes), size(msg), exit(msg),
//     notice(term: string, kind: 'gap' | 'input-full' | 'newer-keeper', text: string),
//     find(), copy(), pasteRaw(), focus(), setHidden(hidden), attached(): string[],
//     fits?(width, height) }
// The terminal view also shows, from `show(term)`: the `reconnecting` bar (S2 7.8) and "sized by
// another window" (S2 8.2.6).
// Optional member (ruled, task 28's review 2, for app.js's `area()`): `fits(width, height)` →
// `{ cols, rows } | null` — the columns and rows a terminal of the view shows in a terminal area
// (`#terminal`'s box) of width × height CSS pixels, by the same rule as every proposal of the view
// (S2 8.2.6: the most that fits, the margin around the text and the scroll bar counted out),
// clamped to S2 8.2.6's limits; null while no cell can be measured or for an area that is not a
// positive size.
// Its numbers are always whole and at least 1, whatever it is given (app.js sends them to the
// server, whose validator takes 1–65,535 only; ruled, #70's review). app.js's `area()` uses it
// when the view offers it, so that the first size of a terminal is the one its view proposes: it
// asks for `#terminal`'s box as it is or will be (the right zone's box as laid out, not rounded
// to whole pixels — F2's review 2 —, without its border, less the header or the cards), at least
// 1 × 1, holds the answer to whole numbers
// 1…1000 × 1…500 all the same (a second line of defence), and for null, an answer that is no
// number, or a view without the member counts at the terminal's font itself (Z1).
// After a reconnect (S2 8.2.5) app.js itself sends `attach` for each id of `attached()`, the shown
// terminal first and the next once the previous one's `snap` arrived, proposing the terminal's
// size of the new `list`; an id the new `list` lacks is skipped, and a `list` without the terminal
// the queue waits for moves it on; an id the view detached meanwhile (`attached()` lacks it, or
// the view sent its `detach`) is skipped or moves the queue on in the same way. So the view drops
// an id from `attached()` no later than it sends that id's `detach`, and sends all the detaches
// of one occasion (the window hidden, a ninth terminal) in the same tick (task 28). The view then gets a second `snap` for a terminal it shows: it
// resets that terminal, applies the snap, and sends its own `resize` when its fitted size differs;
// `attached()` keeps its ids across the reconnect (ruled, task 26).
// `deps.chord(e)` may be given keydown, keypress and keyup (xterm.js's custom key handler gets
// all three): app.js acts on a window chord at its keydown only and answers true for each of its
// events, so the view drops them all and nothing is done twice (review 2 of task 26).

// web/cards.js — replaced by task 29
/** @param {HTMLElement} root @param {{ act(action: object): Promise<ResultMessage>, select(id: string): void }} deps */
export function createCards(root, deps) {}
// → { header(row | null), resumeCard(row, selected, lines), elsewhere(row), endedBar(row, exit),
//     newForm(defaults: { dir: string, dirs: string[] }), hide() }

// web/help.js — replaced by task 29
export function createHelp(root) {} // → { toggle(), hide(), shown(): boolean }
```

`web/app.js` (task 26) also shows, in the title bar: the keep-alive's state from
`welcome.keepAlive` and the `keepalive-lost` / `keepalive-back` notices ("WSL is not kept
running", S2 6.2), and a `tick-failed` notice until the next `list` arrives (A7). The list (task
27) shows "started, not reported" from `TerminalPayload.notReported`.

`web/pane.js` (task 26, final) chooses what the right side shows for the selection: the terminal
view for a row with a terminal (with the ended bar when it ended), the elsewhere card, the resume
card, or the new form.

## 3. Tasks

Constants of step 1's `test/helpers/platform.ts` (`T0`, `SEC`, `S1`–`S3`, `BOOT_A`, `BOOT_B`) are
used below as there.

---

### Task 1: Contracts — page–server messages, keeper frames, the server's internal interfaces

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 8.1, 8.2.2, 8.2.3, 8.3 · **Contracts:** 2.3, 2.5 (`hub.ts`), 2.7 · **Decisions:** A1, A2, A7, A22, A25, A26, A27 (update S2 8.2.3, 8.3)

**Goal.** Turn the protocol tables of the design into code every later task codes against: the
TypeScript types of every message (with JSDoc the page will read), strict validators for what
arrives from a page or a command, the keeper frame codec and payload parsers, and the interfaces
between the server's parts. No behaviour beyond encoding, decoding and validation.

**Files**
- Create: `src/window/protocol.ts`, `src/window/frames.ts`, `src/window/hub.ts`,
  `src/claude/session-id.ts` (`isSessionId` moved there; ruled by the plan owner, see 2.1)
- Modify: `src/claude/launch.ts` (re-exports `isSessionId`); `docs/design-step-2.md` 4.3
  (`protocol.ts` may import `session-id.ts`), 8.2.3 (`tick-failed`, `result.sessionId`,
  `list.selected`, `list.dirs`, `terminals[].notReported`, `notice.term`, stage A's `view` without
  `chips`, the page messages' limits), 8.3 (`checkout` in `/ping`; `/status`'s `build`,
  `checkout`, `startedAtNs`, `envOrigin`)
- Test: `test/window/protocol.test.ts`, `test/window/frames.test.ts`

**Tests** (platform: none — pure)
- `parsePageMessage`: one valid example of every page message and every stage A `act` kind →
  `ok` and deep-equal; for each: an unknown field, a missing field, a wrong type, an unknown `t`,
  an unknown `act` kind (`label`, `restore`), a string over its limit, invalid JSON, a JSON array,
  `input.data` of 64 KiB + 1 byte → `{ ok: false }` with a `kind`, and the input text appears in no
  `kind` (a marker string in the input is not a substring of the result).
- `parseControlRequest`: each route of 2.7 with its method; `POST /token` with `seconds` 30 and
  600 (others refused); `GET /token/<id>` with a 32-hex id (others refused); an unknown field;
  `POST /resume` (stage C) → refused.
- `encodeOutputFrame(7, bytes)` → `[1, 0, 0, 0, 7, ...bytes]`.
- Frames: `encodeFrame('D', bytes)` → type byte, big-endian length, payload; `frameReader` given
  the bytes of three frames in chunks of 1, 3 and 1000 bytes returns the same three frames; a
  frame split across pushes; an empty payload (`C`); a type byte `Q` → `{ error: 'unknown-type' }`;
  a length of 16 MiB + 1 → `{ error: 'too-long' }` before the payload arrives.
- `encodeSnapshot(2**40, 120, 40, 'é')` round-trips through `decodeSnapshot`; a payload shorter
  than 12 bytes → null.
- `parseHello` with the fields of 2.3 → ok; with `protocol` 2 → ok (the caller decides, S2 7.7);
  with `pid` a string, a missing `meta`, invalid UTF-8 or invalid JSON → `{ ok: false }`.
  `parseStarted`, `parseExit`, `parseResize`: valid and invalid examples.
- A type-level test (`satisfies`): an object of each `ServerMessage` type compiles; a misspelt
  field fails `npm run typecheck` (`// @ts-expect-error`).

**Done when:** every message of S2 8.2.3 and 8.3 that stage A uses has its type and validator;
the frames of S2 8.1 encode and decode; `hub.ts` exports exactly 2.5; nothing else is built.

**Not in it:** any socket, any server behaviour; messages of stages B–E (`notify`, the editing
and restore `act` kinds, `chips`).

---

### Task 2: Vendored xterm.js and the development dependencies

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 2 ("no runtime dependencies" amended), 16.6, 17.5 · **Contracts:** — · **Decisions:** A3, A5, A13 (update S2 16.6, 17.5)

**Goal.** Put xterm.js 6.0.0 and its addons into the repository as committed files with their
licences and a manifest of hashes, produced by a script from the exact development dependencies,
and a test that fails when `vendor/` and the installed packages drift apart. Add the other
development dependencies the server's tests need (`ws`).

**How the files are fetched and checked.** The packages are development dependencies at exact
versions (A5); `npm ci` fetches them from the registry and checks each tarball against the
`integrity` (sha512) in `package-lock.json`. `npm run vendor` (`node scripts/vendor.ts`) copies the
files of A3 from `node_modules/@xterm/*` into `vendor/xterm/`, writes the `.d.mts` shims and
`vendor/MANIFEST.json` (`{ files: [{ path, package, version, sha256, licenseFrom?, licenseReason?, upstreamSha256?, patch? }] }`, sorted by
path). One file is patched (ruled on #48, built by task 12): `@xterm/addon-serialize` 0.14.0's
bundle, whose `_diffStyle` loses bold or dim when either goes off (SGR 22 turns off both). The
script checks the installed bundle's version and sha256, replaces the two clauses (each exactly
once), records `upstreamSha256` and `patch` beside the patched file's `sha256`, and the notices
file says the bundle is modified and how (S2 16.6). The committed `vendor/` is what users run; **nothing is fetched at install time**: users do
not run `npm ci` (docs/install.md), and `install` runs no package manager. `doctor` (task 24) and
the server (task 14) check the files against the manifest.

**Files**
- Modify: `package.json` (devDependencies of A5 except `playwright`; script `"vendor": "node scripts/vendor.ts"`), `package-lock.json`, `.prettierignore` (`vendor/`), `tsconfig.json` (`include` gains `scripts`)
- Create: `scripts/vendor.ts`, `vendor/xterm/**` (with `vendor/xterm/THIRD-PARTY-NOTICES`), `vendor/MANIFEST.json`, `src/window/vendor.ts`
- Modify: `docs/design-step-2.md` 16.6 (A3: the layout, the missing licences, the shims), 17.5 (A13)
- Test: `test/vendor/vendor.test.ts`, `test/window/vendor.test.ts`

**The vendored files** (paths inside each package; each package also gets its `LICENSE`):
`@xterm/xterm`: `lib/xterm.mjs`, `css/xterm.css`, `typings/xterm.d.ts`; `@xterm/headless`:
`lib-headless/xterm-headless.mjs`, `typings/xterm-headless.d.ts`; each addon (`addon-serialize`,
`addon-fit`, `addon-search`, `addon-unicode-graphemes`): `lib/<name>.mjs`, `typings/<name>.d.ts`.
The implementer checks the bundles for third-party notices (`addon-unicode-graphemes` bundles
`tiny-inflate` and `unicode-trie`) and says in the pull request what licence text covers them.
Ruled on #38: none did, so `vendor/xterm/THIRD-PARTY-NOTICES` carries them (A3), checked like
every other vendored file; a test pins each licence text to the sha256 of the published `LICENSE`.

```ts
// src/window/vendor.ts
/** `path` is relative to the checkout (`vendor/xterm/xterm/lib/xterm.mjs`). */
export interface ManifestEntry { path: string; package: string; version: string; sha256: string; licenseFrom?: string; licenseReason?: string; upstreamSha256?: string; patch?: string }
/** null when the manifest is missing, unreadable or not a manifest — also when any entry's path
 *  lies outside `vendor/xterm/`, has a segment that is empty, `.` or `..` or holds anything but
 *  ASCII letters, digits, `.`, `_` and `-` (no backslash, space or control character), or is
 *  listed twice (task 14 serves the listed paths), or when an entry has `upstreamSha256` without
 *  `patch` or `patch` without `upstreamSha256`, an `upstreamSha256` that is not 64 lowercase hex,
 *  or a `patch` that is not a string. Never throws. */
export function readManifest(files: Files, appRoot: string): ManifestEntry[] | null;
/** One line per problem: a listed file missing, or its sha256 different; [] when all match.
 *  Also one line for a listed path that is not a file or cannot be read, and one line for a
 *  manifest that is missing, unreadable, not valid or lists no files. Never throws. */
export function verifyVendored(files: Files, appRoot: string): string[];

// scripts/vendor.ts — for tests: the seam the fixture `node_modules` test needs
export interface VendorOptions { from: string /* holds node_modules/@xterm */; to: string /* receives vendor/ */ }
/** Checks everything, then replaces `<to>/vendor/xterm/` and `<to>/vendor/MANIFEST.json`;
 *  throws before writing anything. Returns the manifest's entries. */
export function vendor(options: VendorOptions): ManifestEntry[];
/** `text` with each replacement made; throws unless each old text occurs exactly once. Exported so
 *  that its refusals (an old text missing, an old text twice) are tested directly: through
 *  `vendor` the upstream sha256 check refuses any other bundle first (ruled on #48). */
export function applyPatch(text: string, replacements: ReadonlyArray<readonly [string, string]>): string;
// `node scripts/vendor.ts [<directory>]`: from the checkout into <directory> (the checkout by default).
```

**Tests** (platform: none — the files of the checkout and a temporary directory)
- `vendor.test.ts`: running the copy of `scripts/vendor.ts` into a temporary directory from the
  installed `node_modules` gives exactly the committed `vendor/` (same file list, same bytes);
  every manifest entry's version but the `.d.mts` shims' (package `skydeck`, version `-`) equals the installed package's version and `package.json`'s exact
  version (no `^` or `~`); every package directory has a `LICENSE`; `headless` and
  `addon-serialize` record `licenseFrom: "@xterm/xterm"` and the `licenseReason` of A3; the script
  refuses to copy a licence into a package whose `package.json` declares another licence or another
  repository (a fixture `node_modules` with an altered `package.json`).
- every vendored `.mjs` imports nothing by a bare name (no `import … from 'x'` or `import('x')`
  whose specifier does not start with `./`, `../` or `/`): the browser could not resolve it.
- `test/window/vendor.test.ts`: `verifyVendored` on the checkout → `[]`; on a copy with one file
  changed → one line naming it; one file removed → one line; no manifest → one line.

**Done when:** `vendor/` holds exactly the files of A3 with licences and manifest; `npm run vendor`
reproduces it byte for byte; Prettier leaves `vendor/` alone; `ws` and `@types/ws` are installed.

**Not in it:** Playwright (task 20); loading the files (tasks 12, 14, 26); `addon-webgl`,
`addon-unicode11` (fallback only if W10 says so).

---

### Task 3: The stand-in program

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 17.1 · **Contracts:** 2.4 · **Decisions:** A17

**Goal.** The program every later test runs instead of `claude`: a terminal program that sends
the queries Claude Code sends, draws, reacts to resizes and input, and a session that writes a
live-session file and runs the real hook, all under the control of typed commands. Adapt the
research's `step2-research/terminals/standin.mjs` (read it; do not copy it unread: its probing and
logging differ from 2.4).

**Files**
- Create: `test/fixtures/standin/standin.ts`, `test/helpers/standin.ts`
- Test: `test/standin/standin.test.ts`

**Behaviour.** Exactly 2.4. It reads `/proc/self/stat` for its own process start and
`/proc/self/limits` for `coreSoft` (a test fixture may read `/proc`). It writes nothing outside
`STANDIN_RECORD`, `CLAUDE_CONFIG_DIR/sessions/` and what the hook writes under `SKYDECK_HOME`.

**Tests** (platform: none; each starts the stand-in in a pty made by a small python3 `pty.spawn` helper in the
test, never the keeper, which is task 9)
- start: a `start` record with `argv`, `cwd`, `envNames`; DA1 sent; an answer typed back (`ESC [ ? 1 ; 2 c`)
  → `da1` record with it; no answer → `no answer to DA1` on the screen after 2 s.
- the hook ran: one spool file with `SessionStart`, `CLAUDE_PID` = the stand-in's pid; the live
  file names the session id given with `--session-id` and has status `idle`.
- `/busy`, `/waiting permission`, `/idle` → the live file's `status` (and `waitingFor`).
- `/clear` → a `SessionEnd` with reason `clear` and a `SessionStart` with source `clear` in the
  spool, the live file names a new id.
- `/exit` → exit 0, `SessionEnd` `prompt_input_exit`, live file removed; `/fail 3` → exit 3.
- input: `a\r`, `\n`, a bracketed paste and `\x16` each recorded as hex, in order.
- `SIGWINCH` after a size change → `resize` record with the new size; `SIGHUP` → `hup`, `SessionEnd`
  `other`, exit 129.
- `/query` → one `answer` record per query when the test answers, none when it does not.
- `standinCommand(s, { wrapper: true })`: the stand-in's parent is the wrapper script.
- Refusal (A33): with `STANDIN_RECORD`, `SKYDECK_HOME` or `CLAUDE_CONFIG_DIR` unset, empty or
  relative (each alone) → exit 2, no spool file anywhere in the sandbox, no live file, no record.
- Ending itself: the record file's directory removed (the test also removes `SKYDECK_HOME`) → exit
  0 within 2 s, the hook not run: `SKYDECK_HOME` does not exist again afterwards;
  `STANDIN_MAX_SECONDS=2` → exit 0 after about 2 s with `SessionEnd` `other` in the spool.

**Done when:** every command and record of 2.4 works and is covered; the stand-in never needs the
network or anything outside the sandbox.

**Not in it:** the keeper; any skydeck code.

---

### Task 4: Step 1 changes — launching, `LaunchSpec`, `prepareNew`, the store's write guard, `kv` keys

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 4.4 (rows of stage A for `src/store/`, `src/terminals/types.ts`, `src/sessions/`), 10.1 (the guard), 11.1 · **Contracts:** 2.6 · **Decisions:** A20 (update S2 11.1)

**Goal.** The changes to step 1's code that let the server start sessions through exactly the
functions the commands use, with no change of behaviour for any command: `launchPrepared` moves
to `src/sessions/launch.ts` and takes the terminal; `LaunchSpec` carries the session, the kind,
the lock and the start deadline; `prepareNew` takes the directory; the store gets the server's
write guard; `kv` gets the window's keys.

**Files**
- Create: `src/sessions/launch.ts`
- Modify: `src/terminals/types.ts`, `src/terminals/here.ts`, `src/terminals/wezterm.ts` (names
  only; they ignore the new fields; `handoffScript` takes `Pick<LaunchSpec, 'cwd' | 'argv'>`,
  ruled in #39), `src/sessions/resume.ts` (`PreparedLaunch` fields,
  `prepareNew` with `dir`), `src/sessions/restore.ts` (fills the new `LaunchSpec` fields through
  `launchSpec`), `src/cli/launching.ts` (only `launchWhere`), `src/cli/commands/resume.ts`,
  `src/cli/commands/new.ts`, `src/cli/tui/run.ts` (call `launchWhere`; `new` passes
  `platform.cwd`), `src/store/store.ts`, `src/store/types.ts`, `src/sessions/deck.ts`
- Modify: `docs/design-step-2.md` 11.1 (A20), and the 4.4 row of `src/terminals/types.ts` (the
  label; ruled in #39)
- Test: `test/sessions/launch.test.ts` (moved from `test/cli/launching.test.ts` and extended),
  `test/store/store.test.ts`, `test/sessions/resume.test.ts`, `test/sessions/restore.test.ts`,
  `test/sessions/deck.test.ts` (`openDeck`'s option), `test/fixtures/migrate-while-locked.ts` (a
  worker thread that commits a migration while a guarded write waits for the lock); call sites
  only in `test/terminals/terminals.test.ts` and `test/bin/launcher-handoff.test.ts` (ruled in #39)

**Tests** (platform: `testPlatform` (through `testDeck`))
- Every existing test of `resume`, `new`, `restore`, the interactive list and `launching` passes
  unchanged in what it asserts (only imports and call sites move).
- `startDeadline`: a resume whose lock value is `` `${T0}:12` `` → `T0 + 55 s`; a bare-time lock
  `` `${T0}` `` → `T0 + 55 s`; `new` prepared at `T0 + 3 s` → `T0 + 58 s`.
- `launchSpec` fills `sessionId`, `kind`, `lock`, `startByNs`, `label`; a fake terminal records
  the spec it got from `launchPrepared` and from `runRestore`, with the lock value the launch took.
- `launchPrepared(deck, prepared, null, '<reason>')` → the step 1 lines for "no tab adapter" with
  `<reason>`; with a terminal, exactly step 1's outcomes (ok, refused, timed out, control
  characters) and lock handling.
- `prepareNew` with `dir` relative, missing, or a file → `UsageError`, no meta row; with an
  existing absolute directory → `cwd` is it.
- Store guard: `openStore(p, { guardSchema: true })`; another connection sets `schema_version` to
  `SCHEMA_VERSION + 1`; then `setKv`, `updateMeta`, `insertEvent` and `transaction(fn)` each throw
  `StoreNewerError` and write nothing (`fn` is not called); reads still work. Without the option
  the same writes succeed (a command migrates, it does not refuse). The `kv` keys of 2.6 type-check.
- Store guard under the lock: a migration that commits while a guarded write waits for the write
  lock is seen, and the write is refused (the version is read after BEGIN IMMEDIATE).
- The read helpers take only a SELECT (ruled in #39): `prepareRead` accepts SELECT (any case,
  after whitespace) and refuses WITH (also before a SELECT), PRAGMA (also a read), INSERT, UPDATE,
  DELETE, REPLACE, CREATE, a word that only begins like SELECT, and empty text, running nothing
  (a WITH…INSERT, a WITH…DELETE, `PRAGMA user_version = 7` and `PRAGMA journal_mode = DELETE`
  change nothing); a test over the store's source finds `this.#db.prepare(` only in the two write
  helpers, inside `#write`, and no `this.#db.exec(`.
- `isDatabaseFailure(new StoreNewerError('<message>'))` is true (ruled in #39): otherwise ingest, reconcile and
  scan, which rethrow only failures of the database as a whole, would record the refusal item by
  item and go on, and the server's tick would not stop at the first refused write.

**Done when:** all step 1 tests pass; no command's output changes; the server can call
`launchPrepared` with its own terminal and get the spec it needs.

**Not in it:** the window terminal (task 21); restore planning's move (stage C); `"terminal": "window"` (stage C).

---

### Task 5: Step 1 changes — platform: processes, sockets, timers, randomness, the runtime-directory rule, `window` configuration; the test platforms and safety helpers

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 4.2 (the rule), 4.3 (platform), 4.4 (`src/platform/`), 16.4, 17 (test rules) · **Contracts:** 2.2 · **Decisions:** A6, A9, A10, A30 (`tcpListening`), A32, A34, A36 (update S2 4.3, 16.4, 17)

**Goal.** Two jobs that cannot be cut apart within wave 1. First, give the server what it needs
from the outside world behind `Platform`, so that nothing else opens a socket, starts a program
or draws randomness, and tests can pass fakes; the pure part of the runtime-directory rule; the
`window` configuration keys. Second, the test platforms and safety helpers every later test
uses: the guard against Windows programs, `realTestPlatform` (A36), `writeWindowConfig` and
`killKeepersIn`. The second job builds on the first (`realTestPlatform` wraps the new
`processes` and `net` of `real.ts`, where the guard also lives), so it cannot be a task of its
own in wave 1; moving it to wave 2 would delay tasks 9 and 15, which need it, by a wave. It is
the largest task of wave 1; a reviewer reads the platform first, then the helpers.

**Files**
- Modify: `src/platform/types.ts`, `src/platform/real.ts` (also `Proc.stat` / `bootId` throw
  unless the file is not there, ruling), `docs/design.md` 5.5 (unknown liveness, ruling),
  `src/platform/paths.ts`,
  `src/platform/config.ts`, `src/platform/time.ts` (`MAX_TIMER_MS`, ruling),
  `test/helpers/platform.ts`, `test/helpers/context.ts` (`testContextOn`, ruling),
  `test/helpers/sandbox.ts` (`SKYDECK_TEST_NO_WINDOWS`, A32)
- Create: `test/helpers/window-config.ts`, `test/helpers/kill.ts` (A32, A34)
- Modify: `test/helpers/deck.ts` (`testDeck(t, { real: true })`)
- Modify: `docs/design-step-2.md` 4.3 (A9, A10), 4.4's `src/platform/` row (A9, ruling), 16.4
  (A6), 17 (A32, A36)
- Test: `test/platform/real.test.ts`, `test/platform/paths.test.ts`, `test/platform/config.test.ts`,
  `test/platform/helpers.test.ts` (extended)

**Tests** (platform: both — each case says which)
- `startDetached('sh', ['-c', 'echo $$ > f; read x; echo "$x" >> f; exit 3'], { input: 'spec', … })`:
  the child gets the input, `exited` resolves `{ code: 3 }`; its session id (`/proc/<pid>/stat`
  field 6) is its own pid (a new session); `stderrTo` appends and the file is mode 0o600; a missing
  program rejects with `code` `'ENOENT'`; the child does not keep the test process alive (a child
  started with `sleep 30` in a separate Node process: that process exits at once).
- `signal(pid, 'SIGTERM')` ends a `sleep`; a dead pid → false.
- `listenHttp({ host: '127.0.0.1', port: 0 })` answers a request; `port` is the bound port; a
  second listen on that port rejects `EADDRINUSE`; `{ path }` creates a socket of mode 0o600 that
  `requestUnix` reaches; `requestUnix` to a missing path rejects `ENOENT`, to a stale socket file
  `ECONNREFUSED`, to a server that never answers `ETIMEDOUT` within the timeout; `onLine` gets each
  line of a streamed body.
- `Clock.after` (real: fires once, cancel prevents it; fake: fires from `advanceMs` in time order
  with `every`). `randomBytes(4)` real: 4 bytes, two calls differ; fake: `0,1,2,3` then `4,5,6,7`.
- `FileInfo.mode` and `uid` of a file made with mode 0o640; `fdTarget(process.pid, 0)` is a string;
  `tcpListening(port)` is true for a port the test listens on and false after it closed.
- A32: with `SKYDECK_TEST_NO_WINDOWS=1`, `startDetached` and `runner.run` of
  `/mnt/c/Windows/System32/wsl.exe`, `/mnt/c/x/msedge.exe`, `cmd.exe`, `X.EXE` and a path under
  `/mnt/` reject with `code` `'EWINDOWS'` and start nothing (a `PATH` stub named `cmd.exe` that
  would write a file writes none); without the variable the real platform starts a sandbox
  script named `stub.exe` (the rule is the variable's, not a ban in production); the real
  processes of the test platforms refuse them always, the fake ones record them like any other
  call (ruling). `sandbox(t).env()` contains the variable.
- `writeWindowConfig`: the file it writes parses with `parseConfig`; running its Edge stub
  records the arguments; `keepAlive` is `off` unless given.
- `realTestPlatform`: `clock.nowNs()` within 5 s of `Date.now()`; `proc.bootId()` equals
  `/proc/sys/kernel/random/boot_id`; `pid` is `process.pid` and `isAlive` judges it alive;
  `python3` and `sh` resolve on the sandbox's `PATH`; a keeper-like `python3 -c` started through
  `processes.startDetached` with the sandbox environment runs; `testDeck(t, { real: true })`
  opens a deck on it.
- `killKeepersIn`: a directory outside the sandbox root (also through a symlink inside it that
  points out) → the assertion fails and nothing is signalled; inside, a live `sleep` named by a
  `.pid` line is killed, a dead line and a line of another process start are skipped.
- `paths.test.ts`: `storeId('/h/.local/share/skydeck/skydeck.db')` is the first 8 hex of its sha256;
  `runtimeDirByRule`: `SKYDECK_HOME=/s` with `XDG_RUNTIME_DIR=/run/user/1` → `/s/run`,
  `skydeck-home`; no `SKYDECK_HOME`, usable XDG → `/run/user/1/skydeck-<id>`; XDG relative, empty,
  or `xdgUsable` false → `<stateDir>/run-<id>`, `state-dir`; `runtimeDirCandidates` lists the three
  in order, without the ones whose variable does not count.
- `config.test.ts`: `{}` → `window` defaults of 2.2; `{"window":{"port":47000}}`; each of
  `port` 0, 65536, 1.5, `"1"`; `edge` relative; `profileDir` `relative\\x`, `/mnt/c/x`; `keepAlive`
  `"on"`; `{"window":{"colour":1}}` → `ConfigError` naming the key.

**Done when:** every new platform member exists in the real and the fake platform; the import
check of 2.1 passes; step 1's tests pass.

**Not in it:** the record-following part of the runtime directory (task 15); `"terminal": "window"`
(stage C); the "long-lived child with pipes" (A9).

---

### Task 6: Step 1 changes — the launcher: core limit for `serve`, the cache marker

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 2 (crash dumps), 4.4 (`bin/skydeck`), 5.2 (environment), 7.4 · **Contracts:** — · **Decisions:** —

**Goal.** `bin/skydeck` starts Node.js for `serve` through a short program passed with
`/usr/bin/python3 -I -S -c` that sets the soft core limit to 1 byte and records the old one in
`SKYDECK_CORE_SOFT`, and, for every command, passes `SKYDECK_LAUNCHER_CACHE` beside a
`NODE_COMPILE_CACHE` the launcher chose itself (ruled by the plan owner, pull request #36).

**Files**
- Modify: `bin/skydeck`, `test/bin/launcher.test.ts`, `test/bin/launcher-handoff.test.ts` (the
  handoff cases, beside the existing ones; ruled, pull request #36)

**Behaviour.** S2 2 exactly: for the first argument `serve` only; the python program sets
`RLIMIT_CORE` soft to 1 keeping the hard limit, puts the soft limit it found into
`SKYDECK_CORE_SOFT` (decimal bytes or `unlimited`), and execs Node.js with the same arguments;
when the hard limit is 0 or `setrlimit` fails it execs Node.js without `SKYDECK_CORE_SOFT` and
appends one line to `<stateDir>/server.log` (resolved as the launcher resolves `<dataDir>`, D26);
the python3 is `/usr/bin/python3` and nothing else — never one found on `PATH`, whose
version-manager shim would change the environment node gets — run as `-I -S` (no site
directories); when that file is missing or not executable the launcher behaves as without
python3: Node.js is started directly, without an inherited `SKYDECK_CORE_SOFT`, after one line
`<time> launcher: /usr/bin/python3 cannot be run; core dumps of the server are not prevented` in
`server.log` (stderr when that cannot be written; each write in a throwaway subshell that
ignores SIGPIPE and SIGXFSZ) (ruled, pull request #36; tests replace the path with
`SKYDECK_TEST_PYTHON3`, A31). A program between the launcher and Node.js hands on the environment and the
signal dispositions as it found them, so the python program also (ruled, pull request #36):
gives back the caller's `LC_CTYPE`, set, empty or unset (python3 sets it to `C.UTF-8` in its own
environment under a C or POSIX locale, PEP 538); sets SIGPIPE and SIGXFSZ, which python3 ignores
by itself, back to the caller's disposition (ignored when the launcher's `SigIgn` in
`/proc/self/status` has them, else the default); writes the server.log line to stderr when that
file cannot be written; and, when Node.js cannot be executed, prints `skydeck: cannot run
'<node>': <reason>` and exits 127, as the launcher does, instead of a traceback. Nothing in the
program may keep Node.js from starting: every step but the exec is guarded, every write
tolerates a closed stderr, and SIGPIPE and SIGXFSZ are handed back only right before the exec
(ignored again if it fails), so a write to a pipe nobody reads or past the file size limit stays
an error python catches (ruled, pull request #36). The `--here` handoff unsets
`SKYDECK_LAUNCHER_CACHE` together with `SKYDECK_HANDOFF`: no program the launcher hands over to
gets the marker, also not one the caller had. The launcher stays
POSIX `sh` (shellcheck clean); the python is a short program held in a shell variable and passed
as the single `-c` argument, no file. The marker (S2 5.2): set to the cache's value only when the
launcher chose the cache itself (the caller's `NODE_COMPILE_CACHE` unset or empty); a
`NODE_COMPILE_CACHE` the caller set is passed unchanged and the caller's marker, set or not, is
left as found — so the `window` command's cache and marker reach the `serve` it starts together.

**Tests** (platform: none — the launcher as a child process; fake `node` executables that print what they got, as the existing tests do; the
machine's python3 named by `SKYDECK_TEST_PYTHON3` with `SKYDECK_TEST_NO_WINDOWS=1` where needed)
- `serve` with python3: the fake node sees `SKYDECK_CORE_SOFT` equal to the test's soft limit and
  `/proc/self/limits` of the fake node shows a soft core limit of 1 byte and the original hard limit.
- `serve` with hard limit 0 (`ulimit -H -c 0` in the test's shell): node runs without
  `SKYDECK_CORE_SOFT` and `server.log` gains one line; without a state directory the line is on
  stderr.
- `serve` with python3: node's environment is that of any other command, plus
  `SKYDECK_CORE_SOFT`; node sees `LC_CTYPE` as the caller had it, also unset and empty; node's
  ignored-signal set (`SigIgn` of `/proc/self/status`) equals that of a `serve` started without
  python3, also when the caller ignores SIGPIPE, SIGXFSZ or another signal; a Node.js that cannot
  be executed gives the one line and exit 127; with stderr closed or a pipe nobody reads, a hard
  limit of 0 and no state directory node still runs, and a Node.js that cannot be executed still
  gives exit 127. Cases that need the limit to be settable skip where the machine's hard limit is
  0. No case provokes a signal whose default action dumps core (a `server.log` over `ulimit -f`
  would, through SIGXFSZ, if the order of the program regressed), and the handoff's QUIT case is
  skipped where `/proc/sys/kernel/core_pattern` starts with `|` (notes-for-tasks: no core dumps
  leave the sandbox).
- `serve` without python3 (`SKYDECK_TEST_PYTHON3` missing, a directory, not executable, not
  absolute): node runs, no `SKYDECK_CORE_SOFT`; `server.log` gains the one line, or stderr has it
  without a state directory; with stderr a pipe nobody reads node still runs.
- which python3: `/usr/bin/python3` runs while `PATH` holds a fake `python3` that must not be run;
  `SKYDECK_TEST_PYTHON3` without `SKYDECK_TEST_NO_WINDOWS=1` is ignored; with it, it is the
  python3 that runs, as `-I -S -c`.
- `ls` (any other command): no python3 started (a python3 stub that records its calls is never
  called), limits unchanged.
- every command: when the launcher chose the cache, `SKYDECK_LAUNCHER_CACHE` equals
  `NODE_COMPILE_CACHE` as node sees them; a `NODE_COMPILE_CACHE` the caller set is passed
  unchanged with no marker, and a marker the caller has beside it is left as found; through two
  launchers (a fake node that starts `bin/skydeck serve`, as `skydeck window` does) the first
  one's cache and marker reach the second one's node unchanged.
- the `--here` handoff still does not pass the launcher's cache variable to the handed-off program,
  nor any marker, also not one the caller had (a `NODE_COMPILE_CACHE` the caller set stays).

**Done when:** the cases pass and `shellcheck bin/skydeck` is clean.

**Not in it:** `serve` itself (task 23); removing the variables from programs' environments (task 8).

---

### Task 7: The keep-alive script

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 4.1, 4.2 (pid lines), 6.1 · **Contracts:** 2.8 (`PidLine` format) · **Decisions:** —

**Goal.** `bin/skydeck-keepalive <runtimeDir>`: the inner script `wsl.exe` runs. It writes its own
pid line and `$WSL_INTEROP`, then stays while the server or any keeper is alive, judged by design
5.5's rule with `sh` builtins only (plus `sleep`, `mv` and `rm`, see below).

**Files**
- Create: `bin/skydeck-keepalive`
- Test: `test/bin/keepalive.test.ts`

**Behaviour.** S2 6.1: `sh` builtins, `sleep`, `mv` and `rm` only; `rm` removes nothing but
`keepalive.pid` at exit (below) and the script's own temporary file after a failed write (ruled by
the plan owner in pull request #34: no builtin deletes a file). It writes `keepalive.pid` (`<pid>
<process start> <boot id>`, the format of 2.8, process start from field 22 of `/proc/$$/stat`
after the last `)`) and `keepalive.interop` (`$WSL_INTEROP`, empty when unset), each through a
temporary name and `mv`. Every 10 seconds (`SKYDECK_TEST_KEEPALIVE_SECONDS` overrides, for tests only)
it reads `server.pid` and `terms/*.pid` and exits 0 when none names a process alive on the current
boot with the same process start. It removes `keepalive.pid` when it exits, only while that file
still holds its own line.

Also ruled by the plan owner in pull request #34: `keepalive.interop` holds the value exactly, with
no newline added, and is empty (zero bytes) when it is unset and also when the value contains a
newline or a carriage return; the reader (task 19) still checks that what it reads is an absolute
path. Liveness has three answers, as for task 8's `pidLineState`: alive, dead (another boot id; no
`/proc/<pid>/stat`; another process start) and unknown (the boot id cannot be read; the stat
cannot be read or holds no process start). The script exits 0 only when every line is dead; an
unknown line keeps it like a live one; a garbled line names no process and keeps nothing. The
script creates its files under `umask 077`. It refuses wrong arguments (none, more than one, a
relative path, not a directory) with a usage line on stderr and exit 2, writing nothing; it exits 1
when at start it cannot read the boot id or its own process start (it cannot write its own line and
has judged nothing yet), when it cannot write its files, or when `sleep` fails.
`SKYDECK_TEST_KEEPALIVE_SECONDS` counts only as a whole number of at least 1 without leading zeros;
anything else gives the 10 seconds. `SKYDECK_TEST_PROC` (tests only, an absolute path) stands in for
`/proc` where the boot id and the watched processes are read, so that a test can make an entry
unreadable; the script's own process start always comes from the real `/proc`. On SIGHUP, SIGINT
or SIGTERM it exits at once with 129, 130 or 143 and the same cleanup: its `sleep` runs in the
background and is killed, so that a signal does not wait for the interval and "removes
`keepalive.pid` when it exits" also holds for a terminated script.

**Tests** (platform: none; real `sh`, real processes, the interval set to 1 s)
- with a `server.pid` naming a live `sleep` → still running after 3 s; after the `sleep` is killed
  → it exits within 2 intervals and `keepalive.pid` is gone.
- a `terms/<id>.pid` of a live process keeps it; one with another boot id, or the right pid with
  another process start (a reused pid), or a garbled line, does not.
- `keepalive.pid` holds its own pid, its process start and the boot id; `keepalive.interop` holds
  `WSL_INTEROP`; neither is ever seen half written (a reader in a loop never reads an empty file).
- a `)` and spaces in its own `comm` (started through a symlink named `a) b`) still give the right
  process start.

**Done when:** the cases pass and `shellcheck bin/skydeck-keepalive` is clean (CI runs it once
task 9 names it).

**Not in it:** starting it through `wsl.exe`, the retry schedule (task 19).

---

### Task 8: Pure helpers — program environment, pid lines, Edge arguments, profile folder, links, flags

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 4.2 (pid lines), 5.3, 5.4, 7.4, 9.6, 12.6 (flags), design principle 9 · **Contracts:** 2.8 (`pidline.ts`) · **Decisions:** —

**Goal.** The small rules several server tasks need, as pure functions with exhaustive tests.

**Files**
- Create: `src/claude/terminal.ts`, `src/window/env.ts`, `src/window/pidline.ts`,
  `src/window/windows.ts`, `src/window/flags.ts`
- Modify: `src/claude/procstat.ts` (`parentPidFromStat`)
- Test: one test file per source file under `test/claude/` and `test/window/`

```ts
// src/claude/terminal.ts — principle 9: Claude Code's facts live in src/claude/
/** S2 7.4's list, names only (never a prefix). To be confirmed by W23. */
export const CLAUDE_CHILD_VARIABLES: readonly string[];
// src/window/env.ts
/** S2 5.2: the server's own environment without SKYDECK_HANDOFF, without NODE_COMPILE_CACHE when it
 *  equals SKYDECK_LAUNCHER_CACHE, without the marker; SKYDECK_CORE_SOFT and SKYDECK_ENV_ORIGIN
 *  (A29) always taken out and returned — null when absent or unusable (a core limit that is not
 *  decimal bytes or `unlimited`, an origin that is not an absolute path). */
export function serverEnvironment(env: Env): { env: Record<string, string>; coreSoft: string | null; origin: string | null };
/** S2 7.4: the program's environment from the server's (as serverEnvironment returned it). Removes
 *  SKYDECK_ENV_ORIGIN too (S2 7.4's list); SKYDECK_HOME and SKYDECK_NODE pass (the hook needs them).
 *  Prefix rules: WEZTERM_, KONSOLE_, VSCODE_ (S2 7.4 says why); every other name is exact.
 *  GIT_ASKPASS goes only when VSCODE_GIT_ASKPASS_MAIN is set beside it (the editor's). */
export function programEnvironment(serverEnv: Readonly<Record<string, string>>, options: { cwd: string; interop: string | null }): Record<string, string>;
// src/window/windows.ts
/** '/mnt/c/Users/me/x' → 'C:\\Users\\me\\x'; null for a path not under /mnt/<letter>/, and for one
 *  with a segment Windows cannot have: '.' or '..', a control character, " * : < > ? | or a
 *  backslash, a trailing space or dot. */
export function windowsPath(linuxPath: string): string | null;
/** S2 5.4: the derived profile folder, or an error naming window.profileDir (none or several users),
 *  found under `usersRoot`, standing for /mnt/c/Users: `<driveC(env)>/Users` (drive.ts), a sandbox
 *  folder in tests. (`deriveProfileDir(files)`, the same under the real /mnt/c/Users, was removed by
 *  the follow-up "server-findable": since task 25 nothing called it — startEdge, doctor and
 *  uninstall all derive under driveC.) */
export function deriveProfileDirUnder(files: Files, usersRoot: string): { ok: true; dir: string } | { ok: false; error: string };
/** S2 5.3: the arguments for msedge.exe. */
export function edgeArgs(port: number, token: string, profileDir: string): string[];
/** S2 9.6: the URL to open (re-serialised), or null when it must not be opened; the re-serialised
 *  URL must also be at most 2,048 characters and hold no '"' and no backslash. */
export function linkToOpen(url: string): string | null;
// src/window/flags.ts
/** S2 12.6: words separated by any whitespace (JavaScript's \s: a no-break space too), '…' and
 *  "…" group words, no escapes; an unclosed quote or a NUL is an error. */
export function splitFlags(text: string): { ok: true; flags: string[] } | { ok: false; error: string };
// src/claude/procstat.ts
export function parentPidFromStat(line: string): number | null; // field 4, after the last ')'
```

**Tests** (platform: `testPlatform` (fake `/proc`))
- `programEnvironment`: every variable of S2 7.4's removed lists is removed (each name; `WEZTERM_PANE`
  and `KONSOLE_DBUS_SESSION` by their prefixes, which S2 7.4 names for those two families only);
  `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CONFIG_DIR` pass; `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `PWD` = cwd are set; `WSL_INTEROP` is the link when given, unchanged
  otherwise; `TERM_PROGRAM` is never set.
- `serverEnvironment`: the cache rule with equal and different values; `SKYDECK_CORE_SOFT`
  `unlimited`, `0`, absent.
- pid lines: round trip with and without the keeper fields; garbled lines → null; `isPidLineAlive`
  with the fake proc: alive, other boot, reused pid, no boot id.
- `windowsPath`, `deriveProfileDirUnder` with sandbox folders standing for `/mnt/c/Users/*/AppData/Local/Microsoft/Edge`
  (the function takes the `/mnt/c/Users` root as a parameter, so the test can point it into the
  sandbox): one user → the folder; none, two, an unreadable one.
- `edgeArgs(47613, 'abc', 'C:\\x')` → exactly the four arguments of S2 5.3.
- `linkToOpen`: `https://github.com/a/b/pull/1` → itself; `http://x` → `http://x/`; `file:///etc`,
  `javascript:…`, a 2,049-character URL, `-https://x`, `not a url` → null.
- `splitFlags`: `--model opus` → 2 words; `--append-system-prompt 'a b'` → 2; `"a 'b' c"` → 1
  word; `'unclosed` → error; empty → `[]`; several spaces collapse.
- `parentPidFromStat(statLine(4242, 99, 'we) ird'))` → the parent field.

**Done when:** every helper and case above exists; nothing here reads the environment or `/proc`
except through its parameters.

**Not in it:** starting Edge or opening a link (task 19); refusals of `new`'s flags (design 7.7's,
already in `prepareNew`).

---

### Task 31: The page's key table and age format

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 9.1, 12.9 (the key table, the list keys, what the page cancels, matching by character and by physical key), design 7.4 (ages) · **Contracts:** 2.9 (`keys.js`) · **Decisions:** A11, A18 (update S2 19, stage A, for A11)

**Goal.** The two pure modules of the page, split out of the page shell so that the key table —
the part of the page most likely to be wrong on the user's Czech layout — is reviewed in the first
wave: `web/keys.js` (S2 12.9's table and list keys, S2 9.1's terminal mapping, what the page
cancels) and `web/format.js` (the age format of design 7.4). No DOM, no state: functions of a
`KeyboardEvent`-like object and of times.

**Files**
- Create: `web/keys.js`, `web/format.js` (plain JavaScript with JSDoc, no DOM: the root `tsc`
  checks them through the tests that import them)
- Modify: `docs/design-step-2.md` 19, stage A (A11: the keys of later stages are the window's from
  stage A on)
- Test: `test/web/keys.test.ts`, `test/web/format.test.ts`

```js
// web/format.js
/** design 7.4's compact age: < 60 s "<n>s", < 60 min "<n>m", < 48 h "<n>h", else "<n>d"; negative counts as 0. */
export function formatAge(durationNs) {} // bigint → string
/** The age between two decimal-string nanosecond times of the protocol. Never throws: when either
 *  is not an integer in decimal digits (empty, null, malformed) it returns '' (ruled for task 31:
 *  one bad value must not break the list). */
export function ageBetween(nowNs, thenNs) {} // (string, string) → string
```

**Tests** (platform: none — pure)
- `keys.test.ts` (`KeyboardEvent`-like objects): every chord of S2 12.9 on a US layout and on a
  Czech one (Shift on the number row types the digits; `Digit1` … `Digit9` as the fallback when the
  character is not a digit; letters, Ctrl+Shift+H included, by the character typed), in both zones;
  Ctrl+Shift+- is not the window's; `terminalKey`: Shift+Enter → `\n`, Ctrl+V → `'browser'`,
  Ctrl+Shift+V → `\x16`, Alt+F4 → `'browser'`, a plain letter → null; `listKey`: ↑ ↓ `j` `k` Home
  End PgUp PgDn ← → Enter `/` `a` Esc, F5, Ctrl+R, Ctrl+Shift+R, Ctrl+F5, Shift+F5 and BrowserRefresh
  (alone, with Shift, with Ctrl; ruled for task 31); A11: Ctrl+Shift+P and
  Ctrl+Shift+J → `later` (E, B) in both zones, `l` `g` `n` `p` `d` F2 → `later` (D) in the list zone
  and null in the terminal zone; `cancels`: Alt+F4 never, a key neither zone uses never, F5 and
  Ctrl+R in the list zone yes and in the terminal zone no, Ctrl+Shift+R in both, every `later` key
  yes.
- `format.test.ts`: `formatAge` equals `src/text/age.ts`'s for 0, 59 s, 60 s, 59 min, 47 h, 48 h,
  400 days and a negative duration (A18); `ageBetween` on decimal strings above 2^53, and `''`
  for an empty, null or malformed time.

**Done when:** the whole key policy of S2 12.9 and 9.1 is a tested pure function, on both layouts.

**Not in it:** applying the actions (task 26), the terminal's own key handler (task 28).

---

### Task 9: The keeper

**Depends on:** 1, 3, 5, 7 · **Wave:** 2 · **Design:** S2 2 (principle 3, crash dumps), 4.2 (pid lines, sockets), 7.1, 7.7, 7.8, 8.1, 17.2 · **Contracts:** 2.3, 2.4 · **Decisions:** A2, A12, A14

**Goal.** `bin/skydeck-keeper`: one python3 file, standard library only, about 810 lines (about 700
without comments and blank lines; ruled by the plan owner on #47: the first estimate counted the
prototype's loop, and S2 7.1's rules and the checks of every input the keeper reads add the rest),
that owns one terminal's pty and program, as S2 7.1 specifies step by step, speaking S2 8.1.
Start from the research prototype `step2-research/terminals/keeper-helper.py` (read it: it
starts the program on the first connection, has no claim, no `G`/`N`, no `startBy`, no pid line, no
input queue, no caps — all of which S2 7.1 requires).

**Files**
- Create: `bin/skydeck-keeper` (mode 755, `#!/usr/bin/env python3`, first lines name its keeper
  version `KEEPER_VERSION = "1"` and `PROTOCOL = 1`; task 16 made it "2" when the hello gained
  `tailFrom`, the protocol staying 1)
- Create: `test/helpers/keeper.ts` (spawn a keeper with a spec in the sandbox's runtime directory;
  a frame client over `node:net` using task 1's codec; helpers to wait for frames; cleanup through
  `killKeepersIn`, A34)
- Modify: `docs/design-step-2.md` 17.2: a non-dumpable process has no `Dumpable` line in
  `/proc/<pid>/status` (verified on this kernel by both plan reviews); the check is that its
  `status` is owned by uid 0 and its `environ` cannot be opened by the same user
- Modify: `.github/workflows/ci.yml` (A14: `shellcheck bin/skydeck bin/skydeck-hook bin/skydeck-keepalive`;
  a step `python3 -m py_compile bin/skydeck-keeper`), `.gitignore` (`__pycache__/`)
- Test: `test/keeper/start.test.ts`, `test/keeper/stream.test.ts`, `test/keeper/limits.test.ts`,
  `test/keeper/exit.test.ts`

**Behaviour.** S2 7.1 steps 1–8, 7.8 and 8.1, exactly. The keeper installs `sys.excepthook`
before anything else: an uncaught exception is written to stderr (`keepers.log`) as one line
`keeper <id>: <exception class name>` and nothing else — no message, no traceback, which could
quote a frame's data (S2 2). Additions the design leaves to the code:
the 10-minute linger after exit is `SKYDECK_TEST_KEEPER_LINGER_SECONDS` when set (tests only); the
keeper writes its errors to stderr as one line each (`keeper <id>: <kind>`), never output or
input; the tail and send caps are `SKYDECK_TEST_KEEPER_TAIL_BYTES` / `SKYDECK_TEST_KEEPER_SEND_BYTES` when
set (tests only, so the cap tests need not move 8 MiB). Ruled by the plan owner on #47: the input
queue holds at most 4 MiB — an `I` frame that does not fit waits unread in the connection, one
larger than 4 MiB closes it (`input-too-long`); at most 8 connections wait for their claim, a ninth
closes the oldest; a `P` numbered below the current snapshot or beyond the last record closes the
connection (`bad-park`); `D` records end at UTF-8 character boundaries (2.3); the spec is checked
by the `hello` rules (2.3).

**Tests** (platform: `realTestPlatform`; real python3, the stand-in of 2.4 as the program; the client claims with `C`)
- `start.test.ts`: a connection alone, and a `C` alone, start nothing (no `start` record, `hello`
  `started` false, pid line `started` 0); `G` before `startBy` → `T` with the stand-in's pid and
  process start, before any `D`; pid line rewritten with `started` 1; a second `G` does nothing; `G`
  after `startBy`, a deadline with no `G`, and `N reason` each → `X` with `notStarted` and the
  stand-in never started (its record file stays empty); `hello` says `started` truly before and
  after; the keeper is not dumpable — its `/proc/<pid>/status` is owned by uid 0 and the test
  cannot open its `/proc/<pid>/environ` (`EACCES`), while the stand-in's are the user's (there is
  no `Dumpable` line in `status`; checked on this kernel) — and the stand-in's
  `coreSoft` record equals the spec's `coreSoft`; the stand-in's `cwd` and environment are the
  spec's (`PWD` included); `exec` of a missing program → `T`, then `X` with code 127 and a line
  naming the reason on the pty; the pid line is written through `.<id>.<pid>.tmp`, never a name of
  the `<12 hex>.pid` shape that task 15's `listKeeperLines` reads (seen with `fs.watch`). The
  dumpable checks always run; only the `coreSoft` check is skipped where the hard core limit is 0
  (ruled). From review 2: the socket and the pid line are mode 600; input before `G` is dropped,
  never given to the program later; `N` after the start does nothing; the program does not inherit
  python3's ignored SIGPIPE and SIGXFSZ.
- `stream.test.ts`: output, input and resizes arrive as records in order with numbers from 1;
  `Z 100 30` → the pty size changes (the stand-in records it) and an `R` record comes back;
  `P` with record number n → the keeper keeps the snapshot and drops records ≤ n; a new
  connection then gets `H` (`snapSeq` n, `seq`), `S`, exactly the records after n, and live ones; a
  second claim replaces the first connection (the first is closed); a ninth unclaimed connection
  closes the oldest; a park numbered below the current snapshot closes the connection; an `I` frame
  of more than 4 MiB closes it, one of exactly 4 MiB is taken whole; a character split across two
  reads at each of its bytes is one record, bytes that cannot begin a character are not held, held
  bytes that do not go on as one and those left when the program ends are sent as they are, and a
  resize while a character is half read comes after it, or comes out at the end (ruled, 2.3); an
  `N` reason above 1,024 bytes closes the connection, one of exactly 1,024 is taken; an `I` frame
  announced above 4 MiB closes it at its header (review 2); a first frame other than `C`
  closes that connection, and the keeper still serves the next; an unparseable frame (type `Q`)
  closes the connection and the keeper lives on; the keeper only accepts its own uid (a test that
  can connect as another uid is skipped with a reason when it cannot).
- `limits.test.ts`: a paste of 8 MiB while the stand-in runs `/stall 3` → the keeper keeps
  sending output meanwhile and every input byte reaches the stand-in in order; the input queue
  over its cap → the keeper stops reading the connection (the test's writes block) and resumes
  when the program reads; the tail cap → oldest records dropped and `hello.gap` true on the next
  claim; the send-queue cap with a client that does not read → the connection is closed, the
  keeper keeps reading the pty, and a new claim gets snapshot and tail. From review 2: a claim's
  snapshot and tail are not held to the send cap, its live records are; the tail cap counts 64 bytes
  per record, so many small records cannot outgrow it.
- `exit.test.ts`: `/exit` → `X` `{ code: 0 }` after the last `D`; `/fail 3` → 3; a program that
  kills itself with `SIGKILL` (`sh -c 'kill -KILL $$'`, so that the test signals nothing itself,
  A34; ruled) → `signal` 9; a spec and a frame carrying a marker string that make the keeper fail
  (a spec with a wrong type, a `P` payload that cannot be decoded) leave the marker in no line of
  its stderr, which holds only `keeper <id>: <kind>`; `A` → the keeper ends and removes its socket
  and pid line; no `A` and no
  connection → it ends after the linger, also when it was never started and never connected to
  (ruled); a `meta` the `hello` rules refuse → `bad-spec`; the exception hook, reached through a
  module put before the standard library's, logs only the class name of an error that quotes the
  spec or a frame (ruled); a `startBy` or `coreSoft` with too many digits → `bad-spec`, exit 2; a
  `meta` field the spec adds is not echoed; what the pty still holds when the program is reaped
  comes before `X`, whatever the tail cap (review 2); killing the keeper (`SIGKILL`) → the stand-in records
  `hup` and its `SessionEnd` with reason `other` is in the spool; `I` after the exit is dropped.

**Done when:** every case passes on python3 3.12 in CI and locally; the file uses only the
modules S2 7.1 lists and nothing newer than python3 3.9 (`os.waitstatus_to_exitcode` is the
newest); `python3 -m py_compile` and the new shellcheck line run in CI.

**Not in it:** the server side of the connection (task 16); deciding whether to send `G` (task 21).

---

### Task 10: WebSocket

**Depends on:** 2, 5 · **Wave:** 2 · **Design:** S2 8.2.1 (the WebSocket paragraph), 15.1 · **Contracts:** — · **Decisions:** —

**Goal.** `src/window/websocket.ts`: the server's own RFC 6455 on an upgrade request of
`node:http`, with no extension and no subprotocol. Adapt `step2-research/terminals/ws-min.mjs`
(read it; it has no backpressure accounting and a 4 MiB limit, where S2 wants 1 MiB).

```ts
export interface WebSocketConnection {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Bytes written to the socket and not yet flushed (for S2 8.2.8). */
  readonly buffered: number;
  /** Sends a close frame and ends the socket; the socket is destroyed if the peer has not closed
   *  its side CLOSE_WAIT_MS later (ruled, #44). RangeError for a code a server may not send
   *  (outside 1000–1014 and 3000–4999, or 1004, 1005, 1006) or a reason above 123 UTF-8 bytes;
   *  nothing is sent then (ruled, #44). */
  close(code: number, reason?: string): void;
  /** Destroys the socket at once, with no close frame; onClose gets 1006 unless it had a code
   *  (ruled, #44). */
  destroy(): void;
  // Each onX adds a listener; earlier ones stay. When a listener that a read calls throws (onText,
  // onBinary, or onClose for a close the read caused), the socket is destroyed (onClose gets 1006
  // unless it had a code) and the error is thrown on. onDrain, and onClose called from close(),
  // destroy() or the socket's end or close, are outside this rule (ruled, #44).
  onText(listener: (text: string) => void): void;
  onBinary(listener: (bytes: Uint8Array) => void): void;
  onDrain(listener: () => void): void;
  onClose(listener: (code: number) => void): void;
}
/** Answers 101 and returns the connection, or answers 400 and returns null for a request that is
 *  not a valid version-13 upgrade. The caller has checked Host and Origin before (task 17).
 *  `clock` (the platform's) times CLOSE_WAIT_MS (ruled, #44). */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, clock: Clock): WebSocketConnection | null;
export const MAX_MESSAGE = 1024 * 1024;
/** How long a closing connection waits for the peer to close its side (ruled, #44). */
export const CLOSE_WAIT_MS = 5_000;
```

Once a connection closes, whichever side began it (the server's `close`, a breach of the
protocol, the answer to the peer's close, the peer's end of its side), the socket is destroyed if
the peer has not closed its side `CLOSE_WAIT_MS` later, so that a peer which neither reads nor
closes cannot hold a connection for ever; the wait stops when the socket closes (ruled, #44).

A ping is answered with a pong carrying the same payload; while the socket is backed up (a write
was refused by its queue), only the latest ping's pong is kept and sent at the drain, as RFC 6455
5.5.3 allows, so that a peer that pings and never reads cannot grow the queue (ruled, #44). The
101 and the 400 are answers of the WebSocket endpoint, not pages: they carry
`Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'` (no port is needed) with the other headers of S2 8.2.1 (ruled, #44).

**Files**
- Create: `src/window/websocket.ts`
- Test: `test/window/websocket.test.ts` (a `node:http` server from `platform.net.listenHttp` on
  port 0; the `ws` package as the client)

**Tests** (platform: `testPlatform` (its `net` is real, its clock fake))
- text and binary messages of 0 bytes, 125, 126, 65,535, 65,536 and 1 MiB both ways; a message
  fragmented into three frames with a ping between them; ping → pong with the same payload; close
  with a code → the same code echoed; invalid UTF-8 in a text message → close 1007; an unmasked
  client frame (written with a raw socket) → close 1002; a message over 1 MiB (also as fragments
  that add up to more) → close 1009; a missing `Sec-WebSocket-Key` → 400.
- The 101 and the 400 carry the headers above and no CORS header; `close()`'s RangeErrors; many
  pings while the socket is backed up → one pong, for the latest (ruled, #44).
- With the fake clock: after `close()`, a breach, the peer's close and the peer's end, a peer that
  keeps its side open has the socket destroyed `CLOSE_WAIT_MS` later and not before; a close the
  peer finishes leaves no timer; `destroy()` → onClose 1006 at once, the client sees the
  connection go, no timer left; `destroy()` after `close()` keeps the code (ruled, #44).
- Reads of any size (ruled, #44): a sequence of every frame kind fed in one read, split at every
  byte and one byte per read does the same; a frame sent one byte per read is read in linear time
  (its last byte at once); a long run of empty continuation frames keeps no memory (a heap
  bound); a control frame whose length takes the 16- or 64-bit form → close 1002; every breach
  also fed one byte per read; a peer that resets the connection after the 101 or right after a
  refused request leaves nothing uncaught.
- `buffered` grows while the client does not read (a paused socket) and `onDrain` fires once it
  reads again.

**Done when:** the frame tests of S2 17.3's first bullet pass.

**Not in it:** `Origin`, `Host`, the handshake of S2 8.2.2 (tasks 14, 17).

---

### Task 11: Authentication — secret, launch tokens, proofs

**Depends on:** 1, 4, 5 · **Wave:** 2 · **Design:** S2 8.2.2 (all of it), 10.2 (`window_secret`, `window_alarm`), 15.2 · **Contracts:** 2.8 (`auth.ts`) · **Decisions:** —

**Goal.** `src/window/auth.ts`: the secret in `kv`, launch tokens in memory, the HMAC proofs,
the HKDF and AES-GCM wrapping of the secret for a launch, the alarm. Pure over `Store`, `Clock`
and a random source; no socket.

**Files**
- Create: `src/window/auth.ts`
- Test: `test/window/auth.test.ts`

**Tests** (platform: `testPlatform` (fake clock))
- The vector of S2 8.2.2: `pageProof` and `serverProof` in both modes and `wrapSecret` with the
  given IV equal the table's values exactly.
- `wrapSecret`'s output opens with Node's AES-256-GCM under the HKDF key of the token and both
  nonces, and not with another token or with the nonces swapped.
- `ensureSecret` creates 32 bytes once (two calls return the same; a second connection's call in
  between returns the first's), stored base64url without padding; a stored value that is not a
  secret in that form is replaced (ruled); `replaceSecret` changes it and clears `window_alarm`.
- Tokens (fake clock): `mint(30)` → `state` `waiting`; a proof made with it → `match` and
  `used`; the same proof again → `reused`, `onAlarm` called once; after 30 s an unused token →
  `none` and `state` `expired`; `drop` → `dropped`, and a later proof with it → `none` (`reused`
  when it had been used); `mint(600)` lives 10 minutes; a used token stays known after `forgetAll`
  is not called (the server's life); `forgetAll` empties everything. A token lives no longer than
  its seconds when the wall clock steps back, expires at once when it jumps past `expiresAtNs`,
  and holds a timer only while it waits (ruled).
- `check` compares in constant time (`crypto.timingSafeEqual` on equal-length buffers; a proof
  of another length is `none` without comparing); a proof made with the server's label never
  matches a page proof.
- `isNonce`: 43 base64url characters of 32 bytes → true; 42, 44, `+`, `/`, `=`, a last character
  whose two spare bits are not zero → false.
- The thrown cases of 2.8 (ruled): a key, nonce, mode or IV of the wrong kind, seconds other than
  30 and 600, a random source that gives the wrong number of bytes or repeats an id.
- The alarm (ruled, review 2): a used token presented again and again is `reused` each time and
  calls `onAlarm` on its first reuse only; each token raises it on its own first reuse; the
  callback sees the token already `reused` (the order is pinned); a throwing callback leaves the
  verdict `reused` with `alarmFailure` naming the error's name and code (never its message), and
  the next reuse calls it again.
- `keyProofMatches` (ruled, review 2): the vector's mode `key` proof → true; the server's label,
  mode `launch`, another origin, other nonces or key, one character changed anywhere → false; one
  `timingSafeEqual` on two 43-byte buffers; no comparison and no throw for a proof that is not a
  string of 43 bytes, a nonce that is not one, an origin that is not a string, a secret of another
  size.
- `raiseAlarm` writes the time and keeps the first one (one transaction; ruled); the secret's bytes never appear in any string the module returns
  except `wrapSecret`'s ciphertext (checked by searching every returned string, and every error
  of each thrown case provoked with the secret or a token as an argument, for the secret's and the
  token's base64url, base64, hex and decimal forms; ruled, review 2).

**Done when:** the vector is pinned and every token state of S2 8.3's `GET /token/<id>` is reachable.

**Not in it:** the WebSocket handshake messages (task 17); `server.sock` (task 18); the page's
side (task 26).

---

### Task 12: Screen side

**Depends on:** 1, 2 · **Wave:** 2 · **Design:** S2 7.2, 7.3 (attach, park, gap), 9.3, 9.4 · **Contracts:** — · **Decisions:** A4

**Goal.** `src/window/screen.ts`: one terminal's screen side — a headless xterm.js fed every record
in stream order through one chain, the only responder to terminal queries, silent while it
replays, producing snapshots that rebuild the screen exactly. Adapt
`step2-research/terminals/screen-side.mjs` and `lib.mjs` (read them: they use `addon-unicode11`
and CommonJS, and have no mode tracking).

```ts
// src/window/xterm.ts — A4: loads the vendored modules once
export interface XtermModules {
  Terminal: typeof import('@xterm/headless').Terminal;
  SerializeAddon: typeof import('@xterm/addon-serialize').SerializeAddon;
  UnicodeGraphemesAddon: typeof import('@xterm/addon-unicode-graphemes').UnicodeGraphemesAddon;
}
export function loadXterm(appRoot: string): Promise<XtermModules>;

// src/window/screen.ts
export interface ScreenSide {
  /** Applies a record in order; resolves when applied. While replaying, query answers are dropped. Rejects with the error when `answer` throws for this record's answers; the record is applied all the same. */
  output(bytes: Uint8Array): Promise<void>;
  /** Applies a resize in order. A size outside 1–65,535 gives a promise rejected with a RangeError. */
  resize(cols: number, rows: number): Promise<void>;
  /** Ends the replay: from now on answers go to `answer`. */
  goLive(): void;
  /** The snapshot at the current point of the chain (after every queued record), S2 7.2's additions appended. */
  snapshot(): Promise<{ cols: number; rows: number; data: string }>;
  setTheme(theme: { fg: string; bg: string } | null): void;
  readonly cols: number; readonly rows: number;
  dispose(): void;
}
/** `answer` receives what the program must get as input (query answers). Scrollback 5,000. Throws a RangeError for a size outside 1–65,535. */
export function createScreen(modules: XtermModules, init: { cols: number; rows: number; snapshot: string | null }, answer: (bytes: Uint8Array) => void): ScreenSide;
```

**Files**
- Create: `src/window/xterm.ts`, `src/window/screen.ts`
- Test: `test/window/screen.test.ts`

**Tests** (platform: none — the vendored modules)
- Rebuild: feed a recorded byte stream (colours, wide characters, 300 lines, two resizes, the
  alternate screen, modes 2004, 1004, 1000+1006, 25 off, DECSCUSR 4) to screen A; snapshot; a new
  screen B built from the snapshot equals A cell for cell (characters, widths, colours, attributes,
  wrap flags, every scrollback line), and in cursor position, cursor visibility, mouse encoding,
  cursor style and the modes the serialise addon restores.
- The cursor fix: a last row written full width → B's cursor equals A's.
- Snapshot plus the records after it, applied to a third screen, equals A after those records
  (the chain point is exact: a snapshot requested while records are queued covers all of them).
- Queries: DA1, DA2, CPR, DSR, DECRQM 2026, DECRQSS each answered exactly once through `answer`
  when live; none while replaying (before `goLive`); XTVERSION not answered; OSC 10 and 11 answered
  from a theme `#112233`/`#ddeeff` in xterm's `rgb:` form; a theme colour that is not exactly
  `#rrggbb` → the default theme's colours.
- Widths: 🙂 (with VS16), a ZWJ family and a skin-tone emoji take two columns.

**Done when:** a snapshot rebuilds the screen exactly as S2 7.3 claims, verified by the tests.

**Not in it:** the keeper connection and park policy (task 16); the unfinished escape sequence at
the snapshot's seam (task 33: task 12 leaves the seam, appending an empty string after S2 7.2's
additions).

---

### Task 13: View model

**Depends on:** 1 · **Wave:** 2 · **Design:** S2 4.3 (`src/window/view/`), 7.5 (starting rows), 7.9 (elsewhere), 12.1, 12.2 (stage A: no stacks), 19 (stage A: states only; design 7.3's chip; design 7.4's filter) · **Contracts:** 2.7 (`ListMessage`, `RowPayload`, `SelectedPayload`) · **Decisions:** A8, A27, A28 (update S2 4.3, 7.5)

**Goal.** Pure functions that turn the rows step 1 loads, the window's terminals and one page's
view state into that page's `list` message.

```ts
// src/window/view/build.ts
export interface ViewInput {
  rows: readonly ListRow[];
  terminals: readonly TerminalInfo[];
  /** Holders that belong to no terminal of the window, by session id (from the mapping, task 21). */
  elsewhere: ReadonlyMap<string, { pid: number; tty: string | null }>;
  view: { filter: string; unfolded: readonly string[]; showDone: boolean; selected: string | null };
  /** The resume card of the selected row (task 32's selectedPayload). */
  selected: SelectedPayload | null;
  nowNs: Ns;
}
/** Ruled by the plan owner (task 13, #45): listed are design 7.2's rows (`isListed` with
 *  `showDone`), every open row (running, or starting in the window) whatever its done mark
 *  (S2 12.10), and a `new` terminal's own session's row while the terminal is there — also one
 *  step 1 does not list (ended before its first prompt), unless it is done and stopped. The
 *  filter picks the sections' rows and the done rows `doneHidden` counts (only those that match
 *  it); `counts` ignore it. While a filter is set every section is unfolded (S2 12.8); otherwise
 *  Earlier is folded unless `view.unfolded` names it, and a folded section carries `count`,
 *  `firstNs` and `lastNs` with `rows: []`. `elsewhere` is taken only for a row that is running; a
 *  row held both in the window and elsewhere (a duplicate) counts as `elsewhere`. `selected` is
 *  passed on only when its `sessionId` equals `view.selected`, else null.
 *  Terminals on rows: a terminal that may still run (not `ended`, `lost`, `not-started`) claims a
 *  session's row before one that may not, one showing the session before one waiting for it, then
 *  by slot and opening time; a terminal that may not run is put only on a row that is not running.
 *  The view model may assume that an ended terminal never belongs to a running session for longer
 *  than one tick: it is dropped, its slot freed, when its session runs again (by the resume action
 *  in the window, task 32; by the server's tick when the session runs anywhere else, task 23). */
export function buildListMessage(input: ViewInput): Omit<ListMessage, 'terminals'> & { terminals: Omit<TerminalPayload, 'ownsSize'>[] };
// src/window/view/sections.ts — the parts, exported for tests
/** Shared inside the view model (ruled, #45): the terminal states whose program may still come to
 *  hold a session (S2 7.5) — `starting`, `running`, `reconnecting`, `newer-keeper`. `rowPayload`'s
 *  `starting` and `buildListMessage`'s choice of a row's terminal read this one set. */
export const MAY_START: ReadonlySet<TerminalState>;
export function sectionOf(row: ListRow, nowNs: Ns, isOpen: boolean): 'open' | 'week' | 'earlier';
/** Ruled (#45): `starting` when the terminal's program holds no session (`sessionId` null), the
 *  terminal may still start one (not `ended`, `lost` or `not-started`) and the row is not
 *  running. `noteHead`: the note's first three lines as step 1 shows a note (`formatNoteLines`'s
 *  rule: split at every line break, each line sanitised, empty lines at the start and end
 *  dropped), each cut to 1,024 UTF-16 units with the cut marked by `…` (never inside a surrogate
 *  pair). `elsewhere.tty` is sanitised like every other foreign text. */
export function rowPayload(row: ListRow, extra: { terminal: TerminalInfo | null; elsewhere: { pid: number; tty: string | null } | null }): RowPayload;
/** Most recent first, unique, of the rows step 1 lists (`isListed(row, true)`); left out: a
 *  directory the sanitiser changes, and one that is not absolute (ruled, #45). */
export function projectDirs(rows: readonly ListRow[]): string[];
```

**Files**
- Create: `src/window/view/build.ts`, `src/window/view/sections.ts`
- Modify: `docs/design-step-2.md` 4.3 (A8), 7.5 (A28)
- Test: `test/window/view/build.test.ts`, `test/window/view/sections.test.ts` (with step 1's
  `test/helpers/derived.ts` builders)

**Tests** (platform: none — pure, step 1's builders)
- Sections: running or starting rows (in the window or elsewhere) → open; not running with last
  activity within 7 days → week (most recent first); older → earlier, folded unless `unfolded`
  names it, with `count`, `firstNs` and `lastNs`.
- Open's order: slots 1, 2, 3 by slot whatever their activity; a terminal without a slot after
  them by opening time; elsewhere sessions last by start time; the order does not change when
  activity changes.
- Done: hidden with `doneHidden` counted; `showDone` lists them; a running done session stays
  under open with its `done` mark (S2 12.10).
- Filter (design 7.4): matches title, group, note, directory, pull requests; a filter does not
  show done sessions in stage A (that is stage E); while a filter is set every section is
  unfolded (S2 12.8, ruled in #45).
- Rows: `noteHead` is at most the note's first three lines as step 1 shows a note; `chip` is
  design 7.3's; `slot` and `terminal` from the terminal; `elsewhere` with pid and tty;
  `attention` and `stack` null.
- Starting: a resume terminal whose program holds no session yet marks the expected session's
  row `starting`; a `new` terminal without a session row gives a row with the new id, `starting`,
  titled with the label or `new session in <dir>` (A28); once the session has a row, that row; a
  `new` program that ends before its session started leaves its row, no longer starting, until
  the terminal is closed (ruled in #45).
- Counts: per state of the listed rows, `starting` and `elsewhere` separately.
- Terminals carry `state` and `notReported` from `TerminalInfo` (`reconnecting` included).
- `projectDirs`: unique, most recent activity first, sanitised paths excluded when they differ
  from the raw one (a directory with a control character is not offered).

**Done when:** every rule of S2 12.1 and 12.2 that stage A has is a tested pure function, and
`buildListMessage` needs nothing but its input.

**Not in it:** attention (B), stacks, chips and the multi-word filter (E), the window's own chip
of S2 12.3 (D).

---

### Task 14: Static files, HTTP answers and the build

**Depends on:** 2, 5 · **Wave:** 2 · **Design:** S2 8.2.1 (except the WebSocket paragraph), 15.1 (the HTTP threats), 16.5 · **Contracts:** 2.8 (`build.ts`) · **Decisions:** A12 (update S2 16.5)

**Goal.** Everything the server answers over plain HTTP, and the build: read every file to serve
into memory at start, compute the build over what was read, put the asset version into
`index.html`, and answer requests with the headers and refusals of S2 8.2.1.

```ts
// src/window/assets.ts
export interface Assets {
  build: string;
  /** The keeper's code as read at start (S2 16.5). */
  keeperCode: string;
  /** By the path of a request without its query: '/' (index.html with the build put in) or
   *  '/assets/<build>/<path in the checkout>'. null when the path is not on the list. */
  get(path: string): { body: Uint8Array; type: string } | null;
}
/** Reads web/** (but web/tsconfig.json; web/index.html is served as '/' only), the vendored files
 *  of the manifest that the page loads (`vendor/xterm/**` .mjs and .css) and bin/skydeck-keeper,
 *  each once through readBuild (2.8),
 *  so that the build is the hash of exactly the bytes served. Refuses (Error) when verifyVendored
 *  reports a problem, when a served vendored file's bytes as read do not have the manifest's hash
 *  (it changed between the two reads), when bin/skydeck-keeper is missing, and when it is not
 *  UTF-8 (ruled by the plan owner, task 14). A missing or empty web/ is no error (task 23's tests
 *  run before task 26 creates it): then `GET /` is 404. */
export function loadAssets(files: Files, appRoot: string): Assets;
/** The HTTP request handler of S2 8.2.1 for `port`: Host check, the fixed routes, headers. In
 *  this order: a wrong Host → 421; OPTIONS → 403; any other method but GET → 405 with
 *  `Allow: GET`; GET of a path on the list → the file, a query ignored and never used; any other
 *  GET → 404. `Cache-Control`: `max-age=31536000, immutable` under `/assets/`, `no-store` for
 *  every other path (`/` included) and every refusal (ruled by the plan owner, task 14). */
/** `port()` is the bound port, read at each request: with port 0 it is known only after
 *  listenHttp has resolved (tasks 20, 23 pass a function that returns it then). */
export function httpHandler(assets: Assets, port: () => number): (req: IncomingMessage, res: ServerResponse) => void;
/** S2 8.2.1 and 15.1: the Host header is exactly `127.0.0.1:<port>`; also used for the upgrade (task 17).
 *  For port 80 also `127.0.0.1` (a browser leaves out its default port), never `localhost`; task
 *  17's Origin check needs the same rule for 80 (`http://127.0.0.1`) (ruled by the plan owner,
 *  task 14). */
export function hostOk(host: string | undefined, port: number): boolean;
/** The headers every answer carries (the policy with the port, nosniff, DENY, no-referrer). */
export function securityHeaders(port: number): Record<string, string>;
// src/window/build.ts — computeBuild and readBuild of 2.8
```

**Files**
- Create: `src/window/assets.ts`, `src/window/build.ts`
- Modify: `docs/design-step-2.md` 16.5 (A12)
- Test: `test/window/assets.test.ts`, `test/window/build.test.ts` (a fixture `appRoot` in the
  sandbox with a few files under `bin/`, `src/`, `web/`, `vendor/`)

**Tests** (platform: `testPlatform` (real files))
- `GET /` → `index.html` with every `/assets/__VERSION__/` replaced by `/assets/<build>/`
  (the placeholder `__VERSION__` is the contract with task 26); `GET /assets/<build>/web/app.js`
  and `/assets/<build>/vendor/xterm/xterm/lib/xterm.mjs` → the bytes read at start with the right
  `Content-Type` and `Cache-Control: max-age=31536000, immutable`; every path outside `/assets/`
  (`/` included) and every refusal `no-store`; a query string ignored, also by the cache rule;
  another version in the path, `../`, an encoded `%2e%2e`, `/assets/<build>/web/index.html`, a
  file added to `web/` after start → 404; the file changed on disk after start → the old bytes
  (S2 17.3 "updating").
- Every answer (also 404, 421, 403, 405) carries the CSP of S2 8.2.1 with the port,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and no `Access-Control-*` header.
- `Host: localhost:<port>`, `Host: 127.0.0.1` (no port), another port, no `Host` (HTTP/1.0) →
  421; at port 80 `127.0.0.1` and `127.0.0.1:80` are accepted, `localhost` and `localhost:80`
  not; `OPTIONS` → 403;
  `HEAD`, `POST` and any other method → 405 with `Allow: GET` (a wrong Host is 421 first);
  `GET /manifest.webmanifest` and `/favicon.ico` → 404 in stage A (the icon is stage E).
- `computeBuild`: changes when a file under `bin/`, `src/`, `web/` or `vendor/` changes (one
  byte, its length kept), is added or removed; does not change for `docs/`, `test/`,
  `__pycache__/` or a dot-file; the same tree gives the same build; a file removed between its
  `stat` and its read, a dangling link and a link to itself are no files of the build.
- `loadAssets` refuses a checkout whose vendored file was altered, one whose served vendored file
  changed between the build's read and the manifest check, and one whose `bin/skydeck-keeper` is
  missing or not UTF-8.

**Done when:** the server's static side is complete and the build is the one `skydeck window`
will compute for the checkout.

**Not in it:** the upgrade to the WebSocket (task 17 checks `Origin`, task 10 does the protocol);
the icon (stage E).

---

### Task 15: Runtime directory, server files, the lock, the logs

**Depends on:** 4, 5, 8 · **Wave:** 2 · **Design:** S2 4.2, 5.2 (one server per installation; the log), 7.8 (removing dead keepers' files), 16.5 (keeper files) · **Contracts:** 2.8 (`runtime.ts`) · **Decisions:** —

**Goal.** `src/window/runtime.ts` and `src/window/log.ts`: where the server and the keepers keep
their files, how the server and the commands find that place (the store's record first), the
`window_server` lock, `server.json`, the keeper code file, and the server's and keepers' logs.

**Files**
- Create: `src/window/runtime.ts`, `src/window/log.ts`
- Create: `test/fixtures/server-lock-child.ts` (one would-be server for the lock race test, as
  step 1's `resume-lock-child.ts`; ruled, task 15)
- Modify: `docs/design-step-2.md` 4.2 (a socket path that does not fit: `serve` refuses to start;
  ruled, task 15)
- Test: `test/window/runtime.test.ts`, `test/window/log.test.ts`

**Behaviour** (besides 2.8): `runtime.ts` exports the runtime directory, its files, the keeper
file (`writeKeeperFile`: mode 0o600, through a temporary name, other builds' files removed), the
removal of dead keepers' files (`removeDeadKeeperFiles`, S2 7.8), `server.json` and the lock;
`log.ts` exports `serverLog` and `rotateLog`. `xdgUsable` for the rule checks owner, mode (no group
or other bits) and `/var/lib/systemd/linger/<userName>`. `serverLog` writes one line per call with
an ISO time and, at 1 MiB, copies the file to `.1` and empties it in place (one older file kept;
ruled: not a rename, so that writers holding the file open stay in it); `rotateLog` does the same
for `keepers.log`, which the keepers append to.

**Tests** (platform: `testDeck(t, { real: true })` where a live process holds the lock or a keeper line; `testPlatform` for the rule)
- `resolveRuntimeDir(deck, 'take')`: with `SKYDECK_HOME` → `$SKYDECK_HOME/run` and the record
  written; a record naming a directory with a live keeper `.pid` line (a `sleep` started by the
  test, its line written by the test) wins over the rule even with another `XDG_RUNTIME_DIR`; a
  record whose directory is missing, or holds only dead lines, is replaced. `'follow'` uses the
  record whenever there is one — also when its directory holds no live keeper (a server without
  terminals yet), and also without `XDG_RUNTIME_DIR` in the environment — writing nothing, and the
  rule only without a record.
- With `SKYDECK_HOME` set, nothing is created outside it (the test lists the sandbox's root
  before and after, and `XDG_RUNTIME_DIR` points at another temporary directory that stays empty).
- `prepareRuntimeDir`: mode 0o700 for the directory and `terms/`; an existing directory of mode
  0o755 → `RuntimeDirError` naming the mode; a socket path of 108 bytes (a long `SKYDECK_HOME`)
  → refused naming the length. `removeDeadKeeperFiles`: dead keepers' files (and those whose
  socket refuses) removed, live ones kept. `writeKeeperFile`: the file with mode 0o600, another
  build's file removed, the current one kept.
- The lock: taken when free; refused with the holder when a live process holds it (another
  connection, the test's `sleep`); taken over when the holder is dead or of another boot; inside
  one transaction (two connections racing: exactly one wins, as step 1's lock test does with
  child processes).
- `server.json` round trip, mode 0o600; `readServerJson` of garbage → null.
- `listKeeperLines` reads every `terms/*.pid`, ignores other files and temporaries.
- Logs: lines appended; at 1 MiB the file is copied to `.1` and emptied in place, and a writer
  holding it open goes on writing into it; an older `.1` is replaced; a full disk on the file and
  on stderr does not end the process (a child process whose stderr is `/dev/full`).

**Done when:** every place of S2 4.2 has one function that names or prepares it, and the commands
and the server find the same directory whatever their environment.

**Not in it:** `server.sock`'s handler (task 18); stopping a server (task 22); `doctor`'s lines
(task 24).

---

### Task 16: Terminal core — keeper connections and the registry

**Depends on:** 9, 12, 15 · **Wave:** 3 · **Design:** S2 7.1 (what the server sends and how it spawns), 7.2, 7.3, 7.6, 7.7, 7.8 (the server's side), 8.1, 8.2.4, 10.1 (per terminal), 14 (server killed, keeper killed) · **Contracts:** 2.3, 2.5 (`TerminalHub`) · **Decisions:** A1

**Goal.** `src/window/terminals.ts` (and `src/window/keeper-link.ts` for one connection): the
server's side of every keeper. It spawns keepers, claims them, rebuilds each screen from snapshot
and tail, keeps each screen side live, forwards records to attached sinks in stream order, parks,
handles gap, exit, loss and reconnection, and implements `TerminalHub`. It does **not** decide
whether a program may start (it exposes `start` and `refuse` for task 21) and knows nothing of
sessions beyond the keeper's `meta`.

**Exported API**

```ts
export interface RegistryEvents {
  /** A hello arrived. `origin`: 'spawned' — the hello that resolved spawn() within its 5 s (the
   *  caller of spawn decides about G); 'late' — after spawn() rejected with 'no-hello'; 'found' —
   *  after rediscover() or a reconnect. Only 'late' and 'found' hellos with started false go
   *  through decideFoundKeeper (task 23). */
  hello(term: TerminalInfo, hello: KeeperHello, origin: 'spawned' | 'late' | 'found'): void;
  started(term: TerminalInfo, started: KeeperStarted): void;
  /** A lost keeper sent no X: its exit is made up (ruled by the plan owner) — a started program
   *  `{ code: null, signal: 1 }` (SIGHUP, S2 7.8), one never started `{ code: null, signal: null,
   *  notStarted: 'the keeper ended before the program started' }`. */
  exited(term: TerminalInfo, exit: KeeperExit, lost: boolean): void;
}
export interface RegistryDeps {
  platform: Platform;
  files: RuntimeFiles;
  xterm: XtermModules;
  /** S2 16.5: <runtimeDir>/keeper-<build>.py. */
  keeperFile: string;
  keepersLog: string;
  log: (line: string) => void;
  events: RegistryEvents;
}
export interface Registry extends TerminalHub {
  /** S2 7.1: `python3 -I <keeperFile>`, detached, cwd /, stdout /dev/null, stderr appended to
   *  keepers.log, the spec on stdin; then claim and attach. Resolves after `hello`; rejects with
   *  KeeperStartError: kind 'python-missing' (S2 14's message), 'path-too-long', 'spawn-failed' —
   *  nothing was started, or the keeper ended; the terminal is forgotten — 'stopping' (ruled by
   *  the plan owner, task 21's review 2): the registry was stopped after it started the keeper and
   *  before its hello; the terminal is forgotten, but the keeper may live and a later server finds
   *  it (a stop before anything is spawned stays 'spawn-failed') — or 'no-hello' (none within
   *  5 s): the keeper may still be starting, so the registry KEEPS the terminal, goes on claiming
   *  its socket, and reports its hello through `events.hello` when it comes. Sends no G. */
  spawn(spec: KeeperSpec): Promise<TerminalInfo>;
  /** S2 7.3: connects to every keeper of terms/ whose .pid line is alive or unknown (ruled by the
   *  plan owner: nothing is removed on unknown); removes dead ones' files. Resolves once each
   *  found screen is rebuilt. */
  rediscover(): Promise<TerminalInfo[]>;
  start(termId: string): void; // G
  refuse(termId: string, reason: string): void; // N
  /** The lowest free slot 1–9, or null (S2 7.6). A slot is held until `close` forgets its
   *  terminal (ruled by the plan owner), also while the terminal is ended. */
  nextSlot(): number | null;
  /** From the mapping (task 21): the session the terminal shows, and "started, not reported". */
  setSession(termId: string, sessionId: string | null, notReported: boolean): void;
  /** S2 5.5: park every terminal, close every connection; keepers keep running. */
  stopAll(): Promise<void>;
}
export class KeeperStartError extends Error {
  readonly kind: 'python-missing' | 'path-too-long' | 'spawn-failed' | 'stopping' | 'no-hello';
}
export function createRegistry(deps: RegistryDeps): Registry;
```

**Files**
- Create: `src/window/keeper-link.ts`, `src/window/terminals.ts`, `test/helpers/registry.ts`
  (registries over a keeper sandbox, a mirror sink, the checked keeper signal; ruled by the plan
  owner)
- Modify (ruled by the plan owner): `src/window/hub.ts` (`StreamSink.snapshot`, `attach`),
  `src/window/frames.ts` and `bin/skydeck-keeper` (`tailFrom`, keeper version "2"), their tests,
  `src/window/env.ts` (`SKYDECK_CORE_SOFT` at most 20 digits)
- Test: `test/window/terminals.test.ts`, `test/window/terminals-recovery.test.ts`

**Behaviour** (the design sections above; the plan's additions): park when the tail has grown
past 1 MiB since the last park, or 30 s after output since the last park (the fake or real
clock's `every`), never while the keeper connection has more than 1 MiB unwritten; a keeper
with a newer protocol → state `newer-keeper` and `notice newer-keeper` with S2 7.7's text, never
attached; a gap → `notice gap` with S2 7.3's text to every sink and the width changed by one
column and back; a connection that ends without `X` → `lost` only when the `.pid` line is dead or
the socket refuses, else `reconnecting` and a new claim every second; `input` returns `'full'`
while more than 4 MiB is unwritten to the keeper (S2 7.1 step 5), and also while there is no
connection or the keeper is newer (ruled); after `X` the registry sends `A`
and keeps the last screen until `close`; `close` of a lost terminal also removes its keeper's
socket and `.pid` when the line is `dead`, never on `unknown` or `alive` (ruled; otherwise the next
`rediscover` does). A37: the park of record 0, the redraw's pause, the size clamp, `tailFrom`. Test
settings (A31, ruled): `SKYDECK_TEST_PARK_BYTES` and `SKYDECK_TEST_PARK_MS` in the platform's
environment shorten the park rules; the 1 MiB rule is tested with the design's values.
Ruled at review 2: the registry reads a keeper no faster than its screen side applies — above 4 MiB
of records waiting for the screen side it pauses that socket, below 1 MiB it reads again (S2 7.3,
"Reading"; `SKYDECK_TEST_BACKLOG_BYTES` sets the high mark in tests, the low one is a quarter of
it); reconnect attempts to one keeper are at most one a second, the claim that just ended
counting as one; a claim whose tail stops coming (no frame for 10 s while the server reads) is
given up as a lost connection, so `rediscover` always settles; one exit per terminal (a second
`X` only gets its `A`, at once, while the first `X`'s `A` follows the applied exit); a claim's
wait for its hello, like the stall, counts only time while the server reads, and `stopAll`
reads again before it closes; a sink attached inside the change that announces an exit or a
newer keeper gets that exit or notice once. Ruled (K1): a claim that fell behind (the server
had stopped reading it) is claimed again at once (exempt from the one-a-second rule) unless the
server ended it itself (a frame it refuses, no hello, a stalled tail), and a gap found after
it carries the text "part of this terminal's output was skipped: it came faster than skydeck could
show it"; the input lost in the moment before the close is noticed is a named limit (S2 7.3). An attach while a claim rebuilds the screen
waits for that screen, and a terminal that is over without one gives the empty screen at the
known size, then its `exit`. Also ruled (review 1's check of the review-2 commit): a keeper's
`hello`, `S` or `R` with a size above 1000 × 500 is refused and the claim closed (S2 8.1); the gap
redraw's way back waits for the next settled claim when the connection broke, and a page's
`resize` that is sent replaces it (one that sends nothing does not; S2 7.3); a hello that does not
continue the screen drops the old screen at once, attaches waiting for the new one (S2 7.3).

**Tests** (platform: `realTestPlatform`; real keepers running the stand-in through `standinCommand`; `G` sent by the test)
- spawn, `G`, type `/red hi\r`: an attached sink gets the output records after the snapshot, in
  order; a second sink attached later gets a snapshot that, applied with its later records,
  equals the first sink's screen.
- the stand-in's DA1 and CPR are answered once (its records show one answer each), with no answer
  while replaying after a reconnect.
- recovery: records produced, the registry dropped without parking (`stopAll` not called, the
  connection destroyed), a new registry `rediscover`s → the screen equals the old one cell by
  cell (with two resizes and the alternate screen in between); after `stopAll` and a rediscover →
  equal too, from the parked snapshot.
- `/lines 30000` → at least one park (the keeper's next hello has `snapSeq` > 0), by the 30 s rule
  shortened through `SKYDECK_TEST_PARK_MS`; `/flood` of more than 1 MiB → a park by the 1 MiB rule
  with the design's values (ruled by the plan owner: 30,000 lines are about 350 KB).
- the keeper killed → `exited(lost: true)` and the stand-in ended; the keeper stopped with
  `SIGSTOP` for 3 s while its connection ends (the test closes it: a stopped keeper keeps its
  connection open, and the registry reconnects only when it ends, S2 7.8; ruled by the plan owner)
  → `reconnecting`, then running again, never `lost`, the reconnect's hello of origin `found`.
  A test signals only a keeper it started, checked by pid and process start first.
- `/exit` → `exited` with code 0, `A` sent, the keeper's socket and pid line gone; `close` then
  forgets it; `close` of a running terminal → `'running'`.
- A keeper whose hello comes late (python3 replaced by a sandbox script that sleeps 7 s and then
  runs the real one) → `KeeperStartError` `no-hello` after 5 s, the terminal kept, and its hello
  reported through `events.hello` with origin `late` when it comes; no `G` is sent by the
  registry. A rediscovered keeper's hello has origin `found`, the hello that resolves `spawn`
  origin `spawned`.
- python3 missing (a `PATH` without it) → `KeeperStartError` `python-missing` with S2 14's message; a runtime
  directory whose socket path would be 108 bytes → refused before spawning.
- `nextSlot`: 1, 2, 3 in order; after the second ends and is closed, 2 again; ten terminals → the
  tenth gets null.
- `input` while the stand-in runs `/stall 5` with 6 MiB written → `'full'`, and `'ok'` again after.

**Done when:** a server restart rebuilds every screen exactly (S2 7.3's claim, tested), and the
registry implements `TerminalHub` with no knowledge of sessions.

**Not in it:** the decision to send `G` or `N`, the window terminal, the mapping to sessions, the
lock release on exit (task 21); size ownership (task 17).

---

### Task 17: Pages — handshake, streams, sizes, backpressure

**Depends on:** 10, 11, 14 · **Wave:** 3 · **Design:** S2 8.2.2, 8.2.3 (the page's messages), 8.2.4–8.2.8, 15.1 · **Contracts:** 2.5, 2.7, 2.8 (`auth.ts`) · **Decisions:** A1, A22

**Goal.** `src/window/pages.ts` and `src/window/size.ts`: every page's connection from the upgrade
to `bye`, against `TerminalHub` and `ActionHandler` (fakes in the tests).

The handshake checks a proof only through 2.8 (ruled, task 11): mode `key` with `keyProofMatches`,
mode `launch` with `tokens.check`, never by a comparison of its own; `reused` closes with 4004
whatever `alarmFailure` says, and a non-null `alarmFailure` is logged by that kind.

Node.js's own answers stay Node.js's (ruled by the plan owner, task 17): no `clientError` hook and
no platform change. What it answers before any handler — 400 for an HTTP/1.1 request without
`Host` (its parser), 400 or 431 through its default `clientError` handling (an unknown method, a
request line it cannot parse, `Content-Length` with `Transfer-Encoding`, an HTTP/2 preface, headers
above 16 KiB), `CONNECT` closed without an answer — is recorded in S2 8.2.1 and pinned by tests.
Every request Node.js hands the upgrade listener (any with `Connection: Upgrade` and an `Upgrade`
header) has its `Host` (421), method (OPTIONS 403, any other but GET 405 with `Allow: GET`) and
path (`/ws`, query ignored, else 404) checked there, then its `Origin` (403); the refusals carry
`securityHeaders` and `no-store`. `bye` keeps a `'close'` listener on the raw upgrade socket, as a
listener only, to resolve once the socket has really closed (ruled); every write and close goes
through the WebSocket connection. After `bye` an upgrade with the right `Host` is answered 503
(ruled, S2 8.2.1, 5.5); a wrong `Host` still gets 421.

Backpressure (ruled by the plan owner at review 2, S2 8.2.8): a page is behind once a record
(output, size, exit) or its `list` finds min(`buffered`, the bytes sent since the end of the last
`snap`) above 1 MiB — a snap's own bytes do not count, so a large screen never loops; while
behind its records are dropped (the streams that lose one are marked) and its `list` is held; at
Node.js's `drain` (nothing queued, so below 64 KiB) the current `list` goes out at once and only
the marked streams are attached again (their fresh `snap` on a new channel follows when the hub
gives it, then what the hub tells after it).
Above 64 MiB queued, whatever it is but what is still queued of the latest `snap` (one screen of
image-like output reaches 40–60 MiB), the connection is destroyed with one fixed log line; the
snaps of terminals attached at the same moment count, all but the latest (a named limit, S2
8.2.8: the page attaches its visible terminal first, the others one at a time). With 64
connections in the hello phase, an upgrade that passes the checks above drops the one that has
waited longest and is accepted; a proven connection is never dropped for it (no 503 for this; the
`bye` 503 stays). The hello reads the
secret from the store every time (S2 8.2.2: `--new-secret` takes effect at once; ruled at task
23's review 2: the server's connection waits at most 250 ms for a held write lock, and a hello
that cannot read the secret then is closed with 1013). When a page goes, every
stream is detached before the sizes are handed over; during `bye` no size is handed over.

Pages calls `hub.setTheme` with a page's theme (from its `start`) when that page starts focused
and whenever it reports `focus` with `focused` true: `FocusMessage` carries no theme, so the one
of `start` is sent again (ruled; S2 7.2's "the last focused page").

**Exported API**

```ts
// src/window/size.ts — pure, S2 8.2.6
export interface SizeState { owner: string | null; proposals: ReadonlyMap<string, { cols: number; rows: number; attachedAt: number; inputAt: number | null }> }
/** RangeError for an attach or resize without cols and rows (the caller's mistake; ruled). */
export function sizeAfter(state: SizeState, event: { kind: 'attach' | 'resize' | 'input' | 'detach'; page: string; cols?: number; rows?: number; at: number }): { state: SizeState; apply: { cols: number; rows: number } | null };
// src/window/pages.ts
export interface PageState { windowId: string; focused: boolean; focusedAt: number; area: { cols: number; rows: number } | null; view: ViewMessage; attached: ReadonlySet<string> }
export interface PagesDeps {
  /** The bound port, read when an upgrade comes (known only after listenHttp resolves). */
  platform: Platform; port: () => number; store: Store; tokens: Tokens; hub: TerminalHub; actions: ActionHandler;
  welcome(): Omit<WelcomeMessage, 't' | 'proof' | 'key'>;
  /** The page's list, built when its view changes and when pushList runs; pages then sets each
   *  terminal's `ownsSize` from its own size state, whatever `listFor` put there. */
  listFor(page: PageState): ListMessage;
  log: (line: string) => void;
  /** Ruled by the plan owner (task 23, review 2): while it returns true the server is still
   *  starting (its keepers not found, its first tick not run): an upgrade with the right Host is
   *  answered 503, as after `bye`; a wrong Host still 421. Default: not starting. */
  starting?: () => boolean;
}
export interface Pages {
  /** Host and Origin checks (403), then the WebSocket and the handshake. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  count(): number;
  /** The page that had focus last (S2 8.2.6 first size, S2 13 later). */
  lastFocused(): PageState | null;
  /** Sends `list` to every page whose list differs from the last one it got, at most once a second each. */
  pushList(): void;
  notice(kind: NoticeMessage['kind'], text: string): void;
  /** `bye` to every page that got `welcome`, then every connection closed with 1001; resolves once
   *  every socket has closed (a 'close' listener on the raw socket, ruled; at most CLOSE_WAIT_MS).
   *  From then on an upgrade with the right Host is answered 503 (ruled). */
  bye(reason: string): Promise<void>;
}
export function createPages(deps: PagesDeps): Pages;
```

**Files**
- Create: `src/window/pages.ts`, `src/window/size.ts`
- Test: `test/window/pages-handshake.test.ts`, `test/window/pages-stream.test.ts`,
  `test/window/size.test.ts` (`ws` as the client; a fake hub over in-memory terminals; a fake
  action handler), with `test/helpers/pages.ts` for both pages files
- Modify: `test/keeper/limits.test.ts` (ruled on #53: a flaky assertion; only what the keeper
  logs after the final claim counts), `src/window/hub.ts` (the attach ruling, as task 16)

**Tests** (platform: `testPlatform` (fake clock, real sockets))
- Handshake: `challenge` first with a 43-character nonce; a correct `hello` in mode `key` →
  `welcome` with the server proof of 2.8 and no `key`; mode `launch` with a minted token → `key`
  that opens with the token and both nonces, the token now `used`; the same token presented by a
  second page → close 4004 and `window_alarm` set; an unknown token, a dropped one, an expired one
  → 4003; no `hello` within 5 s → 4001; a nonce of 42 characters → 4001; `protocol` 2 → 4426; a
  proof made with the server's label → 4003; a page proof replayed on a new connection (new server
  nonce) → 4003; any message before `hello`, or another before `start`, closes; `Origin`
  `http://localhost:<port>` or missing → 403 at the upgrade; `Host` wrong → 421 (task 14's
  `hostOk`, applied here to the upgrade).
- The upgrade listener's own checks (ruled): any request with `Connection: Upgrade` reaches it, so
  a wrong `Host` → 421, OPTIONS → 403, another method than GET → 405 with `Allow: GET`, a path
  other than `/ws` → 404, each with the security headers and `no-store`; for port 80 `Host`
  `127.0.0.1` and `Origin` `http://127.0.0.1` are accepted, `localhost` never. Node.js's own
  answers (above) through the real listener: each a 4xx with an empty body (CONNECT: none), the
  socket closed, no handler of ours called.
- No log line and no frame the tests capture contains the secret's base64url, and a malformed
  `hello`, `start` and `input` carrying a marker string leave the marker in no log line.
- Streams: `attach` → `snap` with a fresh channel, then binary frames `1, ch, bytes` in order, and
  `size` in stream order; two pages attached share one order; `detach` stops it; `input` with
  `binary: true` passes bytes as given (a byte string), without it UTF-8; `'full'` → `notice
  input-full` with that terminal's `term`; a sink's `gap` and `newer-keeper` reach each attached
  page with the terminal's `term`; `pages.notice` (keep-alive, tick) carries `term` null; `exit`
  reaches every attached page.
- Size (`size.test.ts`, pure): the first page to attach owns; a later page's `resize` is only
  remembered; its `input` makes it the owner and applies its proposal; the owner detaches →
  the page that sent input last, else the one that attached last, and its proposal applies; nobody
  attached → nothing applies. In `pages-stream.test.ts`: the hub receives `resize` exactly when
  `sizeAfter` says so, and each page's `size.owner` and `list.terminals[].ownsSize` are true for
  the owner only.
- Backpressure: a page whose socket is not read gets no output while more than 1 MiB is queued;
  once drained below 64 KiB it gets a fresh `snap` per attached terminal that lost something (new
  channels; one that lost nothing keeps its stream) and output again; the hub (and so the keeper)
  was never paused. A second page that reads gets every record meanwhile. Ruled at review 2: an
  idle terminal with a 6 MiB snap gets one snap; four and five terminals attached at once with
  1.4 MiB snaps, idle or busy, get one snap each and every record; a busy terminal with a snap
  above 4 MiB gets its records; a held `list` goes out once, the current one, at the drain;
  snap after snap piling up above 64 MiB drops the connection and detaches its streams, while a
  single snap above 64 MiB reaches a page that reads; a terminal attached while the page is
  behind gets its snap at the drain; a `view` that arrives while behind is answered at the drain
  even when its list is unchanged; with 64 connections waiting for their hello a 65th is
  accepted and the oldest dropped, never a proven one, and an upgrade that is no WebSocket
  (answered 400) drops nobody.
- `ping` → `pong` with `n`, `bootId`, `serverId`; `view` → a `list` at once; `pushList` sends
  only changed lists and at most once a second per page (fake clock); `act` → the handler's
  `result` with the same `id`; `bye` reaches every page before the sockets close.

**Done when:** every case of S2 17.3 about authentication, several pages and backpressure passes
against the fakes.

**Not in it:** what `list` contains (task 13), the actions (task 23), the page (task 26).

---

### Task 18: Control socket and its client

**Depends on:** 11, 15 · **Wave:** 3 · **Design:** S2 8.3 (stage A's routes), 15.1 (the unix socket) · **Contracts:** 2.7 (`ControlRequest`, answers), 2.8 (`client.ts`) · **Decisions:** A26

**Goal.** `src/window/control.ts` answers `server.sock`; `src/window/client.ts` is how the commands
talk to it.

```ts
// src/window/control.ts
export interface ControlDeps { ping(): PingAnswer; status(): StatusAnswer; tokens: Tokens; shutdown(): void; log: (line: string) => void }
export function controlHandler(deps: ControlDeps): (req: IncomingMessage, res: ServerResponse) => void;
```

Ruled by the plan owner (task 18): a route whose dependency (`ping`, `status`, `tokens`) throws
answers 500 `{ error: 'failed' }`, logs the error's name and, when it has one, its code
(`failureKind`, 2.8) — never its message — and the server goes on; a throw from `shutdown` is
not caught and becomes the server's uncaught error (S2 5.2).
A refusal answers `{ error: <kind> }` and is logged by its kind. Every `POST /shutdown` answers
`{ ok: true }`; `deps.shutdown` is called once, when the first of those answers has been handed to
the socket (or its asker went away), so one asker that does not read its answers keeps no other
waiting; every other request for it calls nothing.

**Files**
- Create: `src/window/control.ts`, `src/window/client.ts`
- Test: `test/window/control.test.ts` (a real unix socket from `platform.net.listenHttp({ path })`)

**Tests** (platform: `testPlatform` (a real unix socket))
- Each route through `controlClient`: `ping`, `status`, `token(30)` (a 32-byte token in base64url,
  an id of 32 hex), `tokenState` through `waiting`, `used`, `dropped`, `dropToken`, `shutdown`
  (calls `deps.shutdown` once, answers `{ ok: true }` before).
- `POST /token` with an unknown field, `seconds` 60, a body over 64 KiB, invalid JSON → 400 (413
  for the size) and nothing minted; `GET /token/<unknown id>` → 404; an unknown route → 404;
  `POST /resume` (stage C) → 404 and nothing started.
- Tokens are never written to a file or the store (the sandbox's files and the store's `kv` are
  compared before and after minting).
- `ping` against a socket file nobody listens on → `'refused'`; against a server that never answers
  → `'timeout'` after the given time; a missing socket → `'refused'`.
- The socket has mode 0o600 (from task 5's `listenHttp`), in the runtime directory of mode 0o700.

**Done when:** the commands of stage A can do everything S2 5.1 asks of `server.sock` through the client.

**Not in it:** `POST /resume`, `/new`, `/restore` (stage C).

---

### Task 19: Edge, the keep-alive and the interop link

**Depends on:** 5, 7, 8, 15 · **Wave:** 3 · **Design:** S2 2 (Windows programs), 5.3, 5.4, 6.1, 6.2, 6.4, 9.6 (opening a link) · **Contracts:** 2.7 (`KeepAlivePayload`) · **Decisions:** —

**Goal.** The three things the server does on the Windows side, each through `platform.processes`
with an argument list, never a shell: start Edge (and open a link in the user's own Edge), keep
WSL alive with `wsl.exe` running `bin/skydeck-keepalive`, and keep `<runtimeDir>/interop` pointing
at a live interop socket.

```ts
// src/window/edge.ts
/** THE one way stage A starts a Windows program (S2 2; ruled, task 19): `args` as an argument
 *  list, detached, stdio /dev/null, cwd the C: drive — `driveC(platform.env)` of task 24's
 *  `drive.ts`: /mnt/c, or in a test sandbox the `SKYDECK_TEST_MNT_C` stand-in (ruled, task 23,
 *  review 2: no test runs a process in /mnt/c); when that is null (a sandbox without the
 *  stand-in) it rejects with an Error of `code` 'ENOENT' ("the C: drive is not mounted"),
 *  starting nothing — the platform's environment with WSL_INTEROP = `interop` when given (else
 *  unchanged). Rejects, starting nothing, when an argument is empty, holds a '"' or a control
 *  character (S2 2: U+0000–U+001F, U+007F, U+0080–U+009F), or ends with a backslash; otherwise
 *  as startDetached. */
export function startWindowsProgram(platform: Platform, command: string, args: readonly string[], interop: string | null): Promise<Detached>;
/** RangeError (ruled, task 19) for a port outside 1–65535 or a token that is not base64url: the
 *  caller's mistake, nothing started. { ok: false, line } for a missing program (S2 5.3's line),
 *  a profile folder that cannot be derived or cannot be passed to Edge (S2 5.3, 5.4), any other
 *  start failure. */
export function startEdge(platform: Platform, window: WindowConfig, configPath: string, port: number, token: string, interop: string | null): Promise<{ ok: true } | { ok: false; line: string }>;
export function openLink(platform: Platform, window: WindowConfig, url: string, interop: string | null): Promise<boolean>;
// src/window/interop.ts
/** refresh(): the link points at the SOCKET a candidate leads to (its realpath; ruled, task 19),
 *  never at another link or at itself; with no candidate accepting, the link is removed and null. */
export interface Interop { refresh(): Promise<string | null>; current(): string | null }
export function createInterop(platform: Platform, files: RuntimeFiles): Interop;
/** createInterop with the first candidate given (ruled, task 19): task 23 passes `interopFirst`
 *  (A32), tests a path in their sandbox; createInterop is this with '/run/WSL/1_interop'. */
export function createInteropFrom(platform: Platform, files: RuntimeFiles, first: string): Interop;
/** One unix connection, closed at once (ruled, task 19's review 2): 'refused' for ECONNREFUSED or
 *  ENOENT; 'unknown' for another error, no answer within 2 s, or a path that is not an absolute
 *  one-line path. The interop link and the keep-alive both judge a socket by it. */
export function probeSocket(platform: Platform, path: string | null): Promise<'accepts' | 'refused' | 'unknown'>;
// src/window/keepalive.ts — S2 6.1 (ruled, review 2): a keep-alive this server did not start is also
// judged by keepalive.interop (probeSocket 'refused': its wsl.exe is gone; an accepting socket is
// asked again after 3 s — 3 s + up to 1 s to a tick + the 5 s retry + up to 1 s to a tick: under
// 10 s, inside WSL's 15 s (S2 6) — any other
// answer at the next tick); a script whose wsl.exe is gone is an
// orphan — its line no longer counts, and ONE SIGTERM when its line is 'alive' (never on
// 'unknown'), its cmdline has an argument named skydeck-keepalive and one that is files.dir, and
// the end is known (its line was seen while its wsl.exe ran, or the socket says refused — a line
// only inferred at the end tick is not signalled on the inference); then the schedule starts a
// new keep-alive.
export interface KeepAlive { state(): KeepAlivePayload; tick(): Promise<void>; onChange(listener: (state: KeepAlivePayload) => void): void }
export function createKeepAlive(deps: { platform: Platform; window: WindowConfig; files: RuntimeFiles; appRoot: string; interop: Interop }): KeepAlive;
```

**Files**
- Create: `src/window/edge.ts`, `src/window/interop.ts`, `src/window/keepalive.ts`
- Modify (ruled, task 19): `src/platform/real.ts` (`Files.remove` unlinks: Node.js 24.12's
  `rmSync` left a dangling symbolic link in place), `src/platform/types.ts` (its JSDoc),
  `test/platform/real.test.ts`; `docs/design-step-2.md`
  2, 5.3, 6.1, 6.4 (the rulings below)
- Test: `test/window/edge.test.ts`, `test/window/interop.test.ts`, `test/window/keepalive.test.ts`
  (fake processes; never a Windows program)

**Tests** (platform: `testPlatform` (fake processes))
- Edge: `startDetached` called with `window.edge`, exactly `edgeArgs(...)`, cwd `/mnt/c`, stdio
  ignored, `WSL_INTEROP` = the link when there is one; a missing program → S2 5.3's line naming
  `window.edge`, `<configPath>` and `--print-url`; the profile folder from `window.profileDir`
  or derived (task 8); derivation failing → the error naming `window.profileDir`; a profile
  folder that would change how Edge splits its command line → S2 5.3's line naming
  `window.profileDir`, nothing started; a bad port or token → `RangeError`, nothing started.
- `startWindowsProgram`: each refused argument (empty, `"`, a control character — C0, DEL and
  C1 —, a trailing backslash) → rejected, nothing started.
- `openLink`: an allowed URL → `window.edge` with that URL as the only argument; a refused one
  (task 8's `linkToOpen`) → nothing started, false.
- Keep-alive: mode `wsl` and no live `keepalive.pid` → `wsl.exe -d <WSL_DISTRO_NAME> -u
  <userName> --exec /bin/sh <appRoot>/bin/skydeck-keepalive <runtimeDir>` in `/mnt/c`; a live
  `keepalive.pid` (a process the test started) → nothing started, state `running`; the started
  process gone at a tick → `notice` through `onChange` and restarts after 5 s, 30 s, then every 5
  minutes (fake clock), state `failed` with the error while it is down; after 5 minutes running
  the schedule starts over at 5 s; the line of a `wsl.exe` seen to end does not count as running,
  also when it is first seen at the tick that sees the end (written, and `wsl.exe` ended, between
  two ticks) and when it could not be read while `wsl.exe` ran;
  mode `off` → never started, state `off`; no `WSL_DISTRO_NAME` → `failed` with a reason.
- Keep-alive, its Windows side (ruled, review 2; fakes only): a keep-alive found running is taken
  when its `keepalive.interop` socket accepts; an orphan when it is refused or gone; not judged
  (running) for no file, an empty or relative or several-line one, an unreadable one, another
  error, no answer in time; exactly one SIGTERM to an orphan whose line is alive, none for an
  `unknown` line, none for a line of another boot; a found keep-alive whose socket later goes →
  `failed`, one SIGTERM, restarted after 5 s; an accepting socket asked again after 3 s, after any
  other answer at the next tick; a found keep-alive's `wsl.exe` gone right after an accepted probe
  replaced within 9 s on the fake clock (under 10 s with real timers, inside WSL's 15 s); a line only inferred at the end tick signalled only when its
  socket is refused; a SIGTERM only for a command line naming `skydeck-keepalive` and this runtime
  directory (none for another program, a keeper, another runtime directory, a script named like
  it, an empty or unreadable command line); a SIGTERM that throws does not stop the start.
- Interop: candidates in S2 6.4's order — `/run/WSL/1_interop` (the first candidate is
  `createInteropFrom`'s parameter, so the test points it into the sandbox), `keepalive.interop`'s
  content, the server's own `WSL_INTEROP` — the link points at the first that accepts a unix
  connection (test sockets); none → no link, `null`; a later refresh moves the link when the
  first one dies; a candidate leading through the link never makes it point at itself.
- `Files.remove` (`test/platform/real.test.ts`): a dangling symbolic link is removed and a link's
  target is not; a directory is refused.

**Done when:** every Windows-side start of stage A goes through these functions, and the tests
start no Windows program.

**Not in it:** the tick that calls them (task 23); `doctor`'s lines (task 24); `.wslconfig` (task 24 reads it).

---

### Task 20: CI and the page-test leg

**Depends on:** 2, 9, 14 · **Wave:** 3 · **Design:** S2 8.2.1 (the policy), 17.4 (the headless browser), 17.5 · **Contracts:** — · **Decisions:** A5, A13, A15 (update S2 17.5)

**Goal.** The tooling the page tasks need, and the CI of S2 17.5: Playwright as a pinned
development dependency, `npm run test:page`, `check` running it, and a CI leg that installs
Chromium with a cache and runs the page suite on Node 24 only, within 45 minutes.

**Files**
- Modify: `package.json` (devDependency `playwright` 1.60.0 (A5); scripts `"test:page": "node --test \"test-page/**/*.test.ts\""`,
  `"check": "npm run format:check && npm run typecheck && npm test && npm run test:page"`),
  `package-lock.json`, `tsconfig.json` (`include` gains `test-page/**/*.ts`: the TypeScript of the
  suite; the fixtures' plain JavaScript runs in the browser and would fail the root project's
  `checkJs` without the DOM library — ruled on #51), `.github/workflows/ci.yml`
- Create: `test-page/helpers/browser.ts`, `test-page/smoke.test.ts`, `test-page/fixtures/xterm-smoke/`
  (an `index.html` and a `main.js` that open an xterm.js terminal from the vendored modules and
  write `ESC[31mred`), `test-page/fixtures/launch.ts` (one test that asks for the browser, run as a
  child `node --test` by the smoke test; ruled on #51), `test-page/fixtures/close-fails.ts` (a
  browser whose close fails, run the same way; ruled on #51)
- Modify: `test/keeper/limits.test.ts` (ruled on #51, a CI-reliability fix: task 9's send-queue-cap
  test failed on loaded runners because its second claim gets the rest of the flood live under the
  test's 256 KiB send cap and is closed itself when the test process reads too slowly; it claims
  again until a claim sees the whole flood, and the waits on the flood's pace have a 90 s ceiling)
- Modify: `docs/design-step-2.md` 17.4 (A5: Playwright 1.60.0), 17.5 (A13, A15: how the leg is split)

**Workflow.** `timeout-minutes: 45`. Both legs: `npm ci`, `npm run format:check`,
`npm run typecheck`, `npm test`, `python3 -m py_compile bin/skydeck-keeper`, `shellcheck` by name
(both from task 9). The Node 24 leg only: read the installed Playwright version
(`node -p "require('playwright/package.json').version"`) and the system's (`ID-VERSION_ID` of
`/etc/os-release`), restore `~/.cache/ms-playwright` with `actions/cache` keyed
`playwright-${{ runner.os }}-<system>-<version>` (pinned by full commit SHA with the version in a
comment, as the existing actions are), `npx playwright install --with-deps chromium`,
`npm run test:page`. Ruled on #51: the Node 24 leg runs on `ubuntu-24.04` and the Node 24.12 leg
stays on `ubuntu-latest` (Ubuntu 26.04), because Playwright 1.60.0 has no Chromium for Ubuntu
26.04; the pin of the runner is dropped when Playwright is upgraded.

**`test-page/helpers/browser.ts`.** `browser(t)` launches headless Chromium once per test file and
closes it in `t.after`; when Chromium is not installed it fails with exactly `Chromium for
Playwright is not installed; run: npx playwright install chromium`. Ruled on #51, for tasks
26–29: the file also exports that message as `NOT_INSTALLED` and `newPage(t, chromium)` (a page
in a fresh browser context with `timezoneId: 'UTC'` and `locale: 'en-US'`, closed in `t.after`);
Chromium runs with a sandbox's environment (with `TZ=Pacific/Kiritimati` and `LANG=cs_CZ.UTF-8`,
so that a page made without `newPage` shows), `TMPDIR` points into the sandbox while Playwright
launches it (so the profile and the artifacts are made there), and a page reaches nothing but
`127.0.0.1` (`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` and
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; section 0). A close that fails is
thrown only after the sandbox is removed (node:test runs no `t.after` hook after one that throws).

```ts
export const NOT_INSTALLED: string;
export function browser(t: TestContext): Promise<Browser>;
export function newPage(t: TestContext, chromium: Browser): Promise<Page>;
```

**Tests** (platform: `testPlatform`, for the files and the static server's listener, which are
real — ruled on #51; Playwright)
- `smoke.test.ts`: a page from a `data:` URL evaluates `1 + 1` → 2.
- `smoke.test.ts`: a temporary `appRoot` with the fixture as its `web/`, the repository's
  `vendor/` and `bin/skydeck-keeper`, served by task 14's `loadAssets` and `httpHandler` on port 0:
  the page loads under S2 8.2.1's policy with no console error, the vendored `xterm.mjs`, fit,
  search, unicode-graphemes and serialize modules import, and the cell written red has the computed
  colour red — so that page, policy and vendored modules meet in wave 3, not wave 7.
- A local run without Chromium (`PLAYWRIGHT_BROWSERS_PATH` pointing at an empty directory) fails
  with the message above (checked by hand once; say so in the pull request), and `smoke.test.ts`
  pins it: `test-page/fixtures/launch.ts` run as a child `node --test` with the TAP reporter and
  that variable fails, its one `error:` line is exactly the message (ruled on #51).
- Ruled on #51 (review 2): the browser process (its pid from CDP `SystemInfo.getProcessInfo`)
  has a sandbox's home and `TMPDIR` and no `DISPLAY` or `WAYLAND_DISPLAY` in its environment
  (`/proc/<pid>/environ`), and its `--user-data-dir=` (`/proc/<pid>/cmdline`) lies in the
  sandbox's temporary directory; a child run's `TMPDIR`, inside the test's sandbox, stays empty,
  also when the launch fails; a page's time zone is UTC and its language `en-US` while Chromium
  itself runs with `TZ=Pacific/Kiritimati` and `LANG=cs_CZ.UTF-8`; a page served from
  `127.0.0.1` cannot reach `localhost` by name nor listeners on `127.0.0.2` by `fetch`, a
  WebSocket or a STUN server of an `RTCPeerConnection` (nothing reaches the listeners);
  `test-page/fixtures/close-fails.ts`, a browser whose close fails, run as a child: its sandbox
  is removed and the test fails with the close's error. No test reads the real temporary
  directory: a listing there failed whenever another program ran Playwright meanwhile (ruled).

**Done when:** CI is green on both legs with the page leg on Node 24 only, and `npm run check`
runs the page suite locally.

**Not in it:** any page test of the window (tasks 26–29); `web/tsconfig.json` (task 26).

---

### Task 33: The snapshot seam: the unfinished escape sequence

**Depends on:** 12 · **Wave:** 3 · **Design:** S2 7.2 (the snapshot's seam), 7.3 · **Contracts:** — · **Decisions:** —

Added by the plan owner's ruling on task 12 (section 6), and built by task 12's implementer once
task 12 has merged.

**Goal.** A snapshot taken where a record ends inside an escape sequence rebuilds the screen
exactly. Records are pty reads, so a large redraw is cut at arbitrary bytes, and a park or an
attach lands on such a cut at random: without this, the next record's continuation reaches a
screen rebuilt from the snapshot as text (`ab ESC[3` | `1mX` rebuilds as `ab1mX`; checked with the
vendored xterm.js while building task 12). A pure scanner follows the bytes the screen side
applies far enough to know whether the stream stands inside an escape sequence, and keeps that
sequence's bytes; the screen side appends them to every snapshot at task 12's seam, after S2 7.2's
additions, so that the next record completes the sequence on the rebuilt screen as it does on the
original. The other half — a record that ends inside a UTF-8 character — is the keeper's: task 9's
keeper never ends a record there, so the scanner never sees a cut character.

```ts
// src/window/escape-tail.ts — pure; imports nothing. Not a contract: only screen.ts uses it.
export interface EscapeTail {
  /** Follows the stream: every byte the screen side applies, in order, in any chunks. */
  push(bytes: Uint8Array): void;
  /** The escape sequence the stream stands inside; '' in the ground state. */
  unfinished(): string;
}
export function escapeTail(): EscapeTail;
```

**Behaviour**
- The scanner follows xterm.js 6.0.0's parser (its `EscapeSequenceParser`, the VT500 state
  machine) on decoded code points: ESC and its intermediates (`ESC ( 0`, `ESC # 8`), CSI (`ESC [`
  or U+009B) with its prefix, parameters, sub-parameters and intermediates, OSC (`ESC ]` or
  U+009D), DCS (`ESC P` or U+0090), and SOS, PM and APC (`ESC X`, `ESC ^`, `ESC _`, or U+0098,
  U+009E, U+009F). CAN and SUB abort a sequence, an ESC inside one starts a new one, BEL ends an
  OSC, ST (`ESC \` or U+009C) ends a string, and an ESC at the end of a string is kept (half an
  ST; xterm.js ends the string at that ESC, so the tail is the ESC alone). Where xterm.js
  disagrees with the VT500 diagram, xterm.js wins: the rebuilt screen is xterm.js too (S2 21).
- It keeps exactly the bytes that put a fresh parser into the state of the original: a C0 control
  that xterm.js executes inside a CSI is not kept (its effect is already in the snapshot); the
  bytes of a string that its handler will receive are. Nor is any byte that changes nothing a
  later byte can see (a digit that leaves a parameter as it is, an intermediate xterm.js has
  shifted out, what follows a parameter list it stopped reading, the inside of a sequence it
  ignores), so an ESC, CSI or DCS head stays under 1 KiB however long the program makes it.
- The kept bytes are decoded as UTF-8: ESC and CSI sequences are ASCII, and a string sequence
  carries whole characters only (task 9), so the snapshot stays valid UTF-8 and no message
  changes.
- A string sequence whose kept bytes would pass 64 KiB (an OSC 52 or a DCS payload can be large)
  is kept as its introducer followed by what makes xterm.js 6.0.0 ignore the sequence (`!` for an
  OSC, a number that is no number; `!0` for a DCS, its ignore state), so that the rebuilt screen
  swallows the rest and no handler acts on a cut payload; the original acts on it (xterm.js's own
  limit is 10 MB). The tail of a snapshot is therefore at most about 64 KiB.
- `src/window/screen.ts` keeps one scanner per screen, feeds it each record in the chain as the
  record is applied, and feeds it the snapshot a screen starts from (which can itself end inside a
  sequence); the seam's `unfinished()` returns the scanner's tail, appended last, after the cursor
  position, so that nothing the snapshot adds is swallowed into the sequence.
- Option, not built: the scanner sees every complete CSI, so it could also carry the last scroll
  region (DECSTBM, `CSI t ; b r`) cheaply, closing one of S2 7.2's known limits. The region is per
  buffer (normal and alternate), resize, RIS, DECSTR and entering the alternate screen reset it,
  and DECSTBM homes the cursor, so the snapshot would set it before the CUP. Build it only if
  W26 shows the region matters.

**Files**
- Create: `src/window/escape-tail.ts`
- Modify: `src/window/screen.ts` (the seam; the pen's real underline and xterm.js's log level
  off, ruled), `test/window/screen.test.ts`, `docs/design-step-2.md` 5.2, 7.2 and 21 (ruled)
- Test: `test/window/escape-tail.test.ts`

**Tests** (platform: none — the vendored modules)
- The scanner, a table of streams and the tail after each: ground state `''`; `ESC`; `ESC [ 3 8 ;
  5`; `ESC [ ?`; sub-parameters `ESC [ 3 8 : 2 : : 1`; `ESC (`; `ESC #`; `ESC ] 0 ; tit`; an OSC
  ending in ESC; an OSC with UTF-8 characters; `ESC P $ q`; SOS, PM, APC; the introducers U+009B,
  U+009D, U+0090 as UTF-8; after BEL, ST, CAN and SUB `''`; an ESC inside a CSI keeps only the new
  sequence; a C0 control inside a CSI is not kept. Every stream pushed one byte at a time gives
  the same tail as pushed whole.
- The seam, exactly: short sample streams (a few kilobytes each: the cost is one snapshot per
  byte) — part of task 12's recorded stream, and one dense with sequences (SGR with
  sub-parameters, DECSET and DECRST, DECSCUSR, OSC 0 titles, OSC 8 links, an OSC 52, DECRQSS, the
  alternate screen) that avoids what S2 7.2 names as not restored — split at every byte that is
  not inside a UTF-8 character nor inside a grapheme cluster (`Intl.Segmenter`), leaving out the
  cuts while an OSC 8 link is open (ruled: both are named limits): screen A gets the first part,
  screen B is built from A's snapshot and gets the rest, and B equals a screen that got the stream
  whole, by task 12's comparison.
- The named limits, pinned so that a change in xterm.js is noticed: a record that ends inside a
  grapheme cluster leaves the rest of it a cell of its own; the rest of a link still open at a
  snapshot comes out as plain text. The pen (ruled): after a snapshot inside an open link, what
  the program prints after closing the link is not underlined; a real SGR 4 still underlines it.
- A query cut across two records (`ESC [` | `c`): A, live, answers it once when the second
  record is applied; B, built from A's snapshot between the two and live after its replay,
  answers it once too.
- An OSC 52 cut after more than 64 KiB: the snapshot's tail is the bounded introducer; the
  rebuilt screen prints none of the rest and equals the original cell for cell.
- Task 12's tests still pass; the seam's tail is the last thing in every snapshot.

**Done when:** a snapshot taken at any record boundary outside a UTF-8 character and outside a
grapheme cluster rebuilds the screen exactly, tested at every such boundary of the sample streams
(ruled by the plan owner; cuts while an OSC 8 link is open are a named limit too).

**Not in it:** UTF-8 boundaries (task 9's keeper); grapheme clusters cut across records and the
rest of a link open at a snapshot (named limits, S2 7.2); the scroll region, the saved cursor and
the character sets (S2 7.2's known limits; the scroll region is the option above). Design update
(ruled): S2 7.2 names the two new limits, the pen's real underline, and the underline style,
underline colour and a link's dashed underline as not kept; S2 21 gets the xterm.js facts.

---

### Task 21: The window terminal; sessions in terminals

**Depends on:** 4, 16 · **Wave:** 4 · **Design:** S2 7.1 (the spec), 7.3 (a keeper that has not started its program), 7.4, 7.5, 7.8 (the server, on exit), 7.9 (what "elsewhere" means), 11.1, 11.2 · **Contracts:** 2.3 (`KeeperSpec`), 2.6 · **Decisions:** A20, A21, A28

**Goal.** Tie terminals to sessions: the `window` adapter of `Terminal` that the server passes to
`launchPrepared`; the guard run again before starting a keeper found unstarted; what an exit means
for the lock and for a new session's label and group; and which session each terminal shows.

**Exported API**

```ts
// src/window/window-terminal.ts — S2 11.2
export interface WindowTerminalDeps {
  registry: Registry; files: RuntimeFiles; platform: Platform;
  /** serverEnvironment(...).env and .coreSoft (task 8). */
  serverEnv: Readonly<Record<string, string>>; coreSoft: string | null;
  interop(): string | null;
  build: string;
}
/** One adapter per launch: `size` is the first size of S2 8.2.6. open() spawns a keeper with
 *  programEnvironment(...), the next slot and meta (A28), sends G on a hello that arrives within
 *  its 5-second wait, and resolves { ok: true } on T; { ok: false, timedOut: false, error } on
 *  KeeperStartError 'python-missing', 'path-too-long' or 'spawn-failed' (no keeper process was
 *  started, or it is known dead with no terminal left); and — ruled by the plan owner (task 21,
 *  review 2; S2 11.2) — { ok: false, timedOut: true, error } on KeeperStartError 'no-hello' or 'stopping' (the keeper may
 *  run), on X with notStarted or a keeper that ends before T ("not started: <reason>": the terminal
 *  offers Resume, its exit gives the lock back), and on no T within 5 s after G. After open() has
 *  answered, it sends nothing: a hello that comes later is a
 *  found keeper, and goes through decideFoundKeeper before any G (task 23 wires events.hello). */
export function windowTerminal(deps: WindowTerminalDeps, size: { cols: number; rows: number }): Terminal;

// src/window/starts.ts
/** S2 7.3: for a keeper found with started false — refresh, then the guard (checkResumable on the
 *  refreshed row; for `new`, no live process holds the id) and the lock (still exactly the hello's
 *  `lock`, compared exactly; a renewal is refused like a take-over, "its resume lock was renewed or
 *  taken over": S2 7.3's limit for restore in the window), and the deadline. Ruled by the plan
 *  owner (task 21, reviews 1 and 2): it never throws (a failure
 *  while checking is a refusal naming it); a hello whose `started` is true or whose `exited` is set
 *  is never started; a `new` is refused when the boot id cannot be read (checkResumable's words). */
/** Ruled by the plan owner (task 23, review 2): a busy or locked database (SQLITE_BUSY, LOCKED)
 *  is `{ start: 'later' }` — the keeper is not refused; the server decides again after each
 *  refresh that worked while the clock is before the hello's `startBy`, and drops the hello when
 *  its terminal ends, starts or is forgotten (after the deadline the keeper refuses by itself). */
export function decideFoundKeeper(deck: Deck, hello: KeeperHello): { start: true } | { start: false; reason: string } | { start: 'later' };
/** S2 7.8: after an exit, when the session never reported a start for this launch (ingestSpool
 *  first, then resumeStarted with the lock's time and event id; for `new`, no event of the id):
 *  release the lock when it is still the hello's, and for `new` delete the meta row prepareNew wrote.
 *  Ruled by the plan owner (task 21, review 2): task 23 calls it for EVERY exit of a terminal,
 *  started or not — the exit and the store decide, not `hello.started`; the lock is compared
 *  exactly (a renewed one is left to expire: S2 7.8's limit for restore in the window); the meta
 *  row only while it is unchanged since prepareNew wrote it (updated = created). */
export function settleEndedTerminal(deck: Deck, hello: KeeperHello): void;

// src/window/mapping.ts — S2 7.5, 7.9; pure over its input
export interface Mapping {
  /** termId → the session it shows, null while starting. */
  shown: ReadonlyMap<string, string | null>;
  /** Terminals past restoreStartTimeoutSeconds without a holder. */
  notReported: ReadonlySet<string>;
  /** Running sessions none of whose holders belongs to a terminal, with the first holder's pid and tty. */
  elsewhere: ReadonlyMap<string, { pid: number; tty: string | null }>;
  /** Ruled by the plan owner (task 21, review 1): the sessions with a holder whose chain could not
   *  be read (design 5.5's "unknown": a /proc read that failed, a stat line without a readable
   *  start or parent, no boot id). Such a session is not put into `elsewhere` by this pass and is
   *  not given to a terminal by that holder; in a pass where this set is not empty (or without a
   *  boot id) no terminal is newly put into `notReported`. A consumer keeps the previous pass's
   *  answer for a session in `unknown` and takes no action that rests on it (task 23's tick: no
   *  terminal is closed because "its session runs elsewhere", nothing is marked not reported). */
  unknown: ReadonlySet<string>;
}
export function mapTerminals(input: { terminals: readonly TerminalInfo[]; sessions: readonly DerivedSession[]; proc: Proc; bootId: string | null; nowNs: Ns; startTimeoutNs: Ns }): Mapping;
```

`open()` follows its own terminal through `registry.onChange` and `registry.list()` (whose
`program` and `exit` carry `T` and `X`); the registry's single `events` object belongs to task 23,
which keeps each terminal's latest `hello` so that `settleEndedTerminal` gets its `lock` and
`meta`, and sends a hello of origin `late` or `found` whose `started` is false through
`decideFoundKeeper`.

**Files**
- Create: `src/window/window-terminal.ts`, `src/window/starts.ts`, `src/window/mapping.ts`
- Test: `test/window/window-terminal.test.ts`, `test/window/starts.test.ts`, `test/window/mapping.test.ts`
- Test helper (ruled by the plan owner, task 21): `test/helpers/window-deck.ts` — a deck and registries in one sandbox
- Modify (ruled by the plan owner, review 2): `src/window/terminals.ts` and `test/window/terminals.test.ts` — the `KeeperStartError` kind `'stopping'`

**Tests** (platform: `testDeck(t, { real: true })`; the stand-in as `claudeCommand`, real keepers through a registry; the pure cases of `mapTerminals` and of `decideFoundKeeper` / `settleEndedTerminal` on `testDeck(t)` with a fake `/proc`, ruled by the plan owner, task 21)
- `launchPrepared(deck, prepareResumeById(deck, S1), windowTerminal(deps, { cols: 100, rows: 30 }))`
  → `{ code: 0 }`; the stand-in's `argv` is `buildResumeCommand`'s, its `cwd` the session's
  directory, its size 100 × 30; `prepareNew` with a directory and a label → `buildNewCommand`'s
  arguments; the keeper's `meta` has the slot, kind, label and directory.
- The program's environment (stand-in `start` record): none of S2 7.4's removed names (the test
  sets each in the server environment first), `PWD`, `TERM`, `COLORTERM`, `WSL_INTEROP` = the link;
  `coreSoft` equals `SKYDECK_CORE_SOFT`.
- `claudeCommand` that does not exist → `open` resolves ok on `T`, then `X` 127;
  `settleEndedTerminal` releases the lock, so a second resume of the session is accepted at once
  (not "being resumed"); a new session's label and group are removed. A program that exits after
  its `SessionStart` was ingested keeps the lock rule of design 7.6 (nothing released).
- python3 missing → `{ ok: false, timedOut: false }` with S2 14's message, and `launchPrepared`'s
  lines end with the command to run by hand (step 1's rule).
- A keeper that does not answer within 5 s (python3 replaced by a script that sleeps 7 s, then
  runs the real one) → `timedOut: true`, no command printed, the lock kept; when its hello comes,
  `decideFoundKeeper` decides: with guard and lock still holding the program starts; with the lock
  taken over meanwhile (the test replaces it), or the session started elsewhere, `N` and nothing
  runs.
- `decideFoundKeeper` (a keeper spawned without `G`, the registry dropped, a new one
  rediscovering): all well → start, the stand-in runs; the session meanwhile running elsewhere (a
  holder started by the test) → `N` with the guard's message, nothing started; the lock replaced
  by another value → `N`; `startBy` passed → the keeper itself ends not started.
- `mapTerminals`: a holder whose pid is the program → shown; a wrapper (`standinCommand(s, {
  wrapper: true })`, so the holder is the program's child) → shown; `/clear` → the new session is
  shown and the old one is no longer held by the terminal; no holder → null, and past the timeout
  → `notReported`; a holder of another terminal (a stand-in the test started in a pty of its own) →
  `elsewhere` with its pid and the target of its fd 0; a parent chain longer than 8 → not the
  terminal's.

**Done when:** sessions start in the window through exactly step 1's guard, lock and command
builders, and the cases of S2 17.3 about rediscovery, the mapping and failed launches pass.

**Not in it:** the actions that call this (task 23); stage C's commands.

---

### Task 22: Server lifecycle for commands — start, find, stop

**Depends on:** 15, 18 · **Wave:** 4 · **Design:** S2 5.1 (step 1, `--restart`, `--stop`), 5.2 (how `skydeck window` learns what happened; the exit-code table), 5.5, 16.2 (uninstall stops the server) · **Contracts:** 2.8 (`lifecycle.ts`) · **Decisions:** A23, A29, A31

**Goal.** `src/window/lifecycle.ts`: what a command does to find the server, start one, and stop
one safely. Shared by `skydeck window` (task 25), `doctor` and `uninstall` (task 24).

**Files**
- Create: `src/window/lifecycle.ts`
- Modify (ruled, review 2): `src/platform/types.ts` and `src/platform/real.ts` (`requestUnix`'s
  `signal`, 2.2), `src/window/client.ts` (`ping`'s `signal`, 2.8) — that addition only, with its
  tests in `test/platform/real.test.ts` and `test/window/control.test.ts`
- Test: `test/window/lifecycle.test.ts`, with `test/fixtures/fake-serve/` (a `bin/skydeck` stub in
  a fixture `appRoot` that exits with the code the test asks for, or listens on `server.sock` and
  answers `/ping`, `/status` and `/shutdown` like a server — with the server's own
  `controlHandler` and `createTokens`, so that the lifecycle tests run against what the real server
  answers, while `control.test.ts` pins the handler's protocol with raw sockets (ruled, task 22);
  task 24 uses it too)

**Behaviour.** `findServer`: `server.json` read; the process dead by design 5.5's rule → `none`;
alive → `ping` within 5 s: no answer → `hung` (unless a second look finds the process dead
meanwhile → `none`; a refused or failed ping is tried again every 100 ms within the 5 s; ruled);
another `checkout` → `other-checkout`; another
`build` or boot → `other-build`; else `ours`. `startServe`: `<appRoot>/bin/skydeck serve` through
`processes.startDetached`, cwd `/`, stdin `/dev/null`, stdout and stderr appended to
`<stateDir>/server.log`, the environment of the command with `SKYDECK_ENV_ORIGIN` = its working
directory (A29); waits at most 10 s for `ping` of this checkout (ruled: S2 5.1 step 1 compares
it) with the current boot id and build — resolving
the runtime directory again (`follow`) before each attempt, because a starting server that found
a stale record chooses and records another directory — or for the exit, and maps the exit code to S2 5.2's lines (0: wait for the other server within the same
10 s). `stopServer`: as 2.8 says (a server that gives no ping answer gets SIGTERM at once, ruled);
it returns how many keepers keep running — their `.pid` lines alive or unknown, counted before
the stop, never from `status` (ruled) — for `uninstall`'s line.

**Tests** (platform: `realTestPlatform`, except the retry after a refused ping, which runs on `testPlatform`'s fake clock and `/proc`; fake serve; timeouts shortened through `LifecycleTimes`, A31)
- `findServer` for each kind; a `server.json` whose pid is alive but whose process start differs
  (a reused pid: the test writes a line naming the test's own pid with another start) → `none`,
  and that process is never signalled.
- `startServe` while the store records a stale runtime directory and the fake server records
  and listens in another one → found there, `ok`.
- `startServe` with the stub exiting 10, 11, 12, 13, 7, and never answering → each fixed line of
  S2 5.2 (with the port, the checkout from `server.json`, the directory); exiting 0 while a fake
  server of this checkout answers → `ok`; the stub records its environment: `SKYDECK_ENV_ORIGIN` is
  the command's directory.
- `stopServer`: a fake server that ends on `/shutdown` → stopped, no signal sent; one that answers
  but does not end → SIGTERM after the wait, SIGKILL 5 s later (fake processes record the signals,
  in order, each after an identity check); one that does not answer at all → SIGTERM at once,
  then SIGKILL 5 s later; a
  `server.json` naming a dead process → nothing signalled; a keeper's pid is never signalled (the
  test gives the fake processes a keeper pid line and checks the recorded signals).

**Done when:** every command finds, starts and stops the server the same way, and nothing but a
confirmed server process is ever signalled.

**Not in it:** tokens and Edge (task 25); `doctor`'s lines (task 24).

---

### Task 32: Actions — resume, new, close, open link; the resume card's payload

**Depends on:** 1, 4, 8 · **Wave:** 4 · **Design:** S2 8.2.3 (`act`), 9.6 (which links), 11.1, 11.3 (resume and new), 12.6 (the resume card, the new form's fields) · **Contracts:** 2.5 (`ActionHandler`), 2.7 (`ActMessage`, `ResultMessage`, `SelectedPayload`) · **Decisions:** A22, A25, A27

**Goal.** Split out of the server's assembly: what each stage A `act` does, as an `ActionHandler`
over step 1's functions, and what the resume card shows for the selected session — tested with a
fake terminal and a fake hub, as task 17 tests the pages. The window terminal itself is injected,
so this task does not wait for task 21.

**Exported API**

```ts
// src/window/actions.ts
export interface ActionDeps {
  deck: Deck;
  hub: TerminalHub;
  /** The terminal to open a launch of this size with (task 23 passes task 21's windowTerminal).
   *  It only BUILDS the object: nothing is spawned and no slot is taken before its open() (ruled
   *  by the plan owner, review 1 of task 32; tasks 21 and 23 keep it so). */
  terminalFor(size: { cols: number; rows: number }): Terminal;
  /** Task 19's openLink, bound to the configuration and the interop link. */
  openLink(url: string): Promise<boolean>;
  log: (line: string) => void;
}
/** Never rejects (2.5): an unexpected error is logged by kind and answered { ok: false }. */
export function createActions(deps: ActionDeps): ActionHandler;
// src/window/selected.ts
/** A27: the resume card's facts, built with buildResumeCommand and printableCommand; takes no lock. */
export function selectedPayload(deck: Deck, row: ListRow): SelectedPayload;
```

**Files**
- Create: `src/window/actions.ts`, `src/window/selected.ts`
- Test: `test/window/actions.test.ts`, `test/window/selected.test.ts` (`testDeck`, a fake
  `Terminal` that records its specs and answers as the test says, a fake hub)

**Behaviour.** Every action is checked again where it is acted on, by the same parser
(`parsePageMessage` over the action's JSON, so that its limits have one place: the kind, the types,
sizes 1–65,535, `sessionId`, `term`, the text limits in UTF-8 bytes, well-formed text), and the
checked copy is what is acted on; one that fails is answered `ok: false` "skydeck cannot do that
action" with one log line carrying the parser's kind (ruled by the plan owner, review 1 of task 32:
an action is what a page asks the server to do). `resume` → `terminalFor({ cols, rows })` → `prepareResumeById` → `launchPrepared(deck,
prepared, terminal)` → `{ ok: code === 0, lines, error: null, sessionId }` (`sessionId` null unless
it started, A25); a `SkydeckError` (the guard, the lock, `RefError`) → `{ ok: false, lines:
[message], error: message, sessionId: null }`. Every line and the error of a result pass the
sanitiser step 1 prints with (a SkydeckError's message line by line, as `failureText`), so that no
escape sequence or line break a flag, a directory or a title brings reaches the page (ruled by the
plan owner, review 2 of task 32). Before anything else a resume is refused — `ok: false`, "this
session is already open in the window", nothing built, no lock — while the hub lists a terminal of
the session (`sessionId ?? expectedSessionId`) whose program may still run (`MAY_START`), whatever
the lock says (ruled, review 2 of task 32; S2 11.1); `new` is never refused by it. A throw after the
lock was taken and before the terminal's `open()` was called gives that lock back, no other
(nothing can have started; ruled, review 2 of task 32); after `open()` it stays. The terminal is built first (ruled, review 1 of task
32), so that a factory that throws leaves no lock and, for `new`, no label behind; a refused
action builds it and never opens it. Once
`prepareResumeById` has let it through, and before `launchPrepared`, the resume closes the
session's terminals whose program is over (ended, lost, not started; `hub.close`) — ruled by the
plan owner (review of task 13, S2 7.8): an ended terminal is dropped when its session runs again;
a refused resume leaves it. `new` →
`splitFlags` (an error → `ok: false`) → `terminalFor` → `prepareNew` with the form's directory,
label and group (empty, or only white space, means none: ruled, review 1 of task 32 — a form field,
which step 1's `cleanLabel` would refuse) → `launchPrepared`. `close-terminal` → `hub.close`;
`'running'` → `ok: false` with "the program still runs; end it inside claude" (principle 6);
`'unknown'` → `ok: false` with "this terminal is no longer there" (ruled, review 1 of task 32).
`open-link` → `linkToOpen`, then `openLink` with the re-serialised URL; a refused link → `ok:
false`. An unexpected error is answered `ok: false` and logged by kind (`failureKind`). The
terminal is wrapped so that a rejection (or a throw) of its `open()` is logged once by kind — `act
resume: the terminal failed (<kind>)`, likewise for `new` — and becomes the open result `{ ok:
false, error: 'the terminal failed unexpectedly (<kind>)', timedOut: true }` (ruled by the plan
owner, review 1 of task 32): the window terminal may already have a keeper then, so
`launchPrepared` prints no command to run by hand (a hand-run `claude` could resume the session
twice) and the lock and the label stay, as after a timeout. `selectedPayload`: `ended` is `mid-turn` with the
mark `was-working`, `unexpectedly` with `ended-unexpectedly`, `exited` after an end event of kind
exit, else null; `expiring` and `expired` from the marks.

**Tests** (platform: `testPlatform` (through `testDeck`, fakes))
- `resume` of a session that is not running → the fake terminal got the spec of
  `buildResumeCommand` with the size given, the lock taken, `ok` with the session id; the
  terminal failing → `launchPrepared`'s lines (the command to run by hand); a running session →
  the guard's message, the terminal built but never opened, no lock; an unknown id → the
  `RefError` message;
  the session's ended, lost and not-started terminals closed before the new one opens, its other
  terminals and other sessions' kept, nothing closed on a refusal (ruled, S2 7.8); a second
  resume while the first one's terminal is starting (or running, reconnecting, newer keeper) with a
  stale lock → refused, nothing built, one terminal; after that terminal ended → allowed, the ended
  one closed first; a terminal that now shows another session does not refuse it; a `new` is never
  refused by it; a throw after the lock and before `open()` → the lock given back.
- `new` with a directory, label `fix`, group `ABC-1` and flags `--model opus` → `buildNewCommand`'s
  arguments, the meta stored, `sessionId` the new id; flags `-r x`, `--name y`, `'unclosed`, a
  relative or missing directory → `ok: false` with the message, nothing stored, the terminal never
  opened; empty label and group, or only white space → no meta row.
- `close-terminal` of a running terminal → refused; of an ended one → `ok`. `open-link` of
  `https://github.com/a/b/pull/1` → `openLink` with that URL; of `javascript:alert(1)` → not called;
  `close-terminal` of an unknown terminal → `ok: false`.
- An action whose terminal factory throws something unexpected → `ok: false`, one log line with
  the kind and no message text, no lock and no label left; a terminal whose `open()` rejects or
  throws, for `resume` and for `new` → `ok: false`, the timed-out lines, one log line by kind, no
  message text and no command in any line, the lock and the label kept.
- An action that is not well formed (an unknown kind, a size of 0 or 65,536, a session id that is
  not one, a terminal id that is not 12 hex, an unknown field, a label over 1,024 UTF-8 bytes, a
  lone surrogate) → refused, nothing done, one log line with the parser's kind; an action at the
  limits → acted on. A refusal quoting a flag with an escape sequence or a line break → no control
  character in `lines` or `error`.
- `selectedPayload`: the command for a session with recorded flags; a directory with a control
  character → `command` null; unknown flags listed; each `ended` case; `expiring`, `expired`.

**Done when:** every stage A `act` kind has its answer, through step 1's guard, lock and command
builders, and nothing in this task opens a real terminal.

**Not in it:** the window terminal (task 21), wiring it (task 23); the `act` kinds of stages C and
D.

---

### Task 23: The server — assembly, tick, `skydeck serve`

**Depends on:** 4, 5, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 32 · **Wave:** 5 · **Design:** S2 4.1, 5.2, 5.5, 6.2, 6.4 (every 30 s), 10.1, 11.3 (resume and new, end to end), 14 (every failure inside Linux), 16.5 · **Contracts:** 2.5 (`runServer`, the test helper), 2.7 · **Decisions:** A19, A24, A29, A32, A35

**Goal.** `skydeck serve`: put the parts together into the one server of S2 5.2 — lock, runtime
directory, assets and build, port, `server.sock`, rediscovered keepers, pages, the keep-alive and
the interop link — with the tick of S2 10.1, task 32's actions wired to the window terminal, the
status answers and the stop of S2 5.5.

**Files**
- Create: `src/window/server.ts`, `src/window/tick.ts`, `src/cli/commands/serve.ts`,
  `test/helpers/window.ts`
- Create (ruled at review 2): `src/window/busy.ts` (`isBusy`)
- Modify: `docs/design-step-2.md` 5.2 (A29); ruled at review 2, exactly these edits of merged
  files: `src/store/store.ts` (`openStore`'s `busyTimeoutMs`), `src/sessions/deck.ts` (`openDeck`
  passes it), `src/window/starts.ts` (`decideFoundKeeper`'s `{ start: 'later' }`),
  `src/window/actions.ts` (a busy store answers "skydeck's database is busy; try again"),
  `src/window/pages.ts` (`PagesDeps.starting`: 503 while the server starts; 1013 for a hello
  whose secret cannot be read because the store is busy), `src/window/edge.ts` (the Windows
  working directory from `drive.ts`, task 24's seam); design S2 5.5, 8.2.1, 8.2.2, 14
- Test: `test/window/server.test.ts`, `test/window/server-failures.test.ts`,
  `test/window/tick.test.ts`, `test/cli/commands/serve.test.ts`; and for the edits above
  `test/store/store.test.ts`, `test/sessions/deck.test.ts`, `test/window/starts.test.ts`,
  `test/window/actions.test.ts`, `test/window/pages-handshake.test.ts`, `test/helpers/pages.ts`
  (`startPages`' `starting`), `test/window/edge.test.ts`, `test/window/keepalive.test.ts`

**Behaviour.** `runServer` in this order: refuse with `CLAUDECODE` set (13); `serverEnvironment`;
`openDeck(platform, { guardSchema: true })`; take the lock (0 or 11); the runtime directory
(`take`) and `prepareRuntimeDir` (12); `loadAssets` and the keeper file; `ensureSecret`; bind the
port (10, releasing the lock); remove a `server.sock` that refuses (one a process answers on fails
the start before anything is written); write `server.json` and `server.pid` (before `server.sock`
answers, so that a server that answers can always be found by them; a start that fails after this
removes them: ruled by the plan owner, follow-up "server-findable"); listen on `server.sock` (the
HTTP and page handlers read the bound port through a function, A6: with port 0 it is known only
now); the python3 check; `rediscover` and `decideFoundKeeper` for every
keeper not started; the interop link and the keep-alive; start the tick (until it has run,
`/status` says `starting` and a page's upgrade gets 503). The actions are task 32's `createActions`, given
`windowTerminal(deps, size)` as its terminal factory and `openLink` (task 19). The registry's
`events` keep each terminal's latest `hello` and send a hello of origin `late` or `found` whose
`started` is false through `decideFoundKeeper` (task 21); a `spawned` hello is `open()`'s. `tick.ts`: every second the keep-alive; every second tick the refresh,
`refreshPrs` automatic for the sessions the pages list, the rows reloaded by A24, `mapTerminals`
and `setSession`, `settleEndedTerminal` for new exits, and `pages.pushList()`; every 30 s the
interop link; a failed tick logged by kind and sent once as `notice tick-failed` (A7);
`StoreNewerError` → stop with `bye "skydeck was updated; run skydeck window"`. `rotateLog` for
`keepers.log` at start and once a minute on the tick (the keepers only append to it). `listFor` is
`buildListMessage` (task 13) with task 32's `selectedPayload` for the page's selected row. The `serve` command
installs process handlers: an uncaught error is logged by name and stack frames without the
message — the stack's header removed exactly (`<name>: <message>` however many lines the message
has; Node.js's `<name> [<code>]: <message>`; the name alone for an empty message), the
`/^\s+at /` lines after it kept, none when the stack does not begin with that header (ruled at
review 2) — and ends the server with exit 1; SIGTERM and SIGINT stop it (S2 5.5). Ruled at review
2: until `rediscover()` has settled and the first tick has run, an upgrade with the right Host is
answered 503, as after `bye` (`PagesDeps.starting`), so that no page acts on a hub that does not
list the terminals yet (if that tick's refresh failed, the first list comes with the next tick;
the registry is complete by then); a `POST /shutdown` or a signal that comes before the server can
stop is made as soon as it can (one during the first tick starts the orderly stop at once), never
lost. A start that meets a store another process keeps locked for longer than the server's 250 ms
fails at once ("the window's server cannot start: skydeck's database is busy (another skydeck
holds it); try again", exit 1), leaving nothing behind. An exit the registry makes up for a keeper that never sent a hello is
not settled (accepted): there is no hello to take the lock value from, and the lock expires by
itself (LOCK_TTL_NS).

**Tests** (platform: `realTestPlatform`; in process through `startTestServer` and `TestPage` unless marked)
- Start: `server.json` (mode 0o600, every field of 2.8), `server.pid`, `server.sock`, the keeper
  file; `ping` and `status` answer; a second `runServer` of the same checkout → `ServeExit` 0;
  another `appRoot` → 11; the port held by a test listener → 10 and the lock released; a runtime
  directory of mode 0o755 → 12; `CLAUDECODE` set → 13.
- A page connects with the stored secret; `view` → `list` with the sandbox's sessions in sections;
  `act resume` of a session that is not running → `result` ok with its `sessionId`; the next `list`
  has a terminal in slot 1 and the row's `terminal`; `attach` → `snap`; `input "/busy\r"` → within
  8 s the row is `working` (two ticks are 4 s; ruled at review 1: the bound allows a loaded
  machine); `act new` with a directory, label `fix` and flags `--model opus`
  → the stand-in's arguments are `buildNewCommand`'s and the row titled `fix` appears (starting,
  then running); `act new` with flags `-r x`, a relative directory, an unclosed quote → `ok: false`
  with the message, nothing started.
- Two `act resume` of one session sent at the same moment by two pages → one terminal, one
  `result` ok and one refused with the guard's or the lock's message.
- A keeper found unstarted (spawned by the test with `G` held back) → `events.hello` goes through
  `decideFoundKeeper` before any `G`.
- No Windows program is started: the Edge stub of `writeWindowConfig` records an `open-link`
  action's URL, and nothing else is run under `/mnt/` (A32).
- Resume of a session running in a terminal of the test's own → refused with the guard's message
  and the row is `elsewhere`; python3 missing → the result's lines carry S2 14's message.
- `stop` → every page gets `bye`, keepers keep running, `server.json`, `server.pid`,
  `server.sock` and the lock are gone; a new `runServer` rediscovers the terminals, a page
  reconnects and its `snap` equals the screen before. The server dropped without `stop` (the
  test stops its timers, closes its sockets and listeners and makes its lock a dead process's;
  its store connection stays open and idle, ruled — see `test/helpers/window.ts` in 2.5) → the
  same after `runServer`.
- A migration by another connection (`schema_version` raised) → the next write refused, `bye`
  with the update text, `done` resolves 0, nothing written.
- A tick whose refresh throws (the store locked by `test/fixtures/hold-write-lock.ts`) → one
  `notice tick-failed`, not repeated; after the lock is gone the list updates again.
- Places: with `SKYDECK_HOME` set, the server, its keepers and the keep-alive script create and
  open nothing outside the sandbox (S2 17.3); the keep-alive set to `wsl` on fake processes
  (ruled at review 1): `wsl.exe` is never run, the script it would run runs in its place as a
  process the test started, and the server's signals are recorded, never sent.
- Added at review 2 (each wire's removal fails one): while the start is held, an upgrade is
  answered 503, and after it a resume of a session whose terminal runs is refused ("this session
  is already open in the window"); a `POST /shutdown` during the start stops the server once it
  can; an exit is settled (a program that ends before it reports a start gives its lock back
  within two ticks), and one not settled yet when the server stops is settled by the stop; the
  stop parks every keeper (a claim's hello has `snapSeq` = `seq`); a launch token presented twice
  raises the alarm; the pull requests of the sessions a page lists are refreshed; the interop
  link is pointed before the first keep-alive check and again when a terminal opens; the sixth
  reload trigger after an action and after a late keeper's decision; a store locked by another
  connection: the event loop is never blocked for long, a terminal's echo keeps flowing, one
  notice and one log line, an action answers "skydeck's database is busy; try again", a hello is
  closed with 1013, a found keeper's decision is put off (`{ start: 'later' }`) and made once the
  store is free, a start fails at once leaving nothing; in `tick.test.ts` a settled exit reloads
  the rows and a terminal whose own session cannot be judged keeps it.
- `serve.test.ts` (through `bin/skydeck serve --foreground` as a child, with `SKYDECK_TEST_PORT=0`
  and `SKYDECK_TEST_INTEROP_FIRST` in the sandbox, A31, A32): `CLAUDECODE` set →
  exit 13 and the line; the server process's soft core limit is 1 byte with the old hard limit
  (`/proc/<pid>/limits`) and a keeper's program has the soft limit the launcher found; a
  malformed `hello`, `start` and `input` carrying a marker leave the marker in no line of
  `server.log`; SIGTERM → exit 0 after S2 5.5; added at review 2: an uncaught error → one line
  with its name and frames only, exit 1, `server.json` and the lock left as a crash leaves them;
  SIGTERM during the start → exit 0, nothing left; SIGINT as SIGTERM; `uncaughtLine`'s header
  cases (Node.js's JSON.parse message quoting a frame-like line, a stack without the header, a
  `[code]` header). Every wait on a child's exit is bounded, and a held start is finished in a
  `finally` (review 2: no test may hang with a live server).

**Done when:** a server started with `skydeck serve` gives a page everything stage A shows, and
every failure of S2 14 that can happen inside Linux behaves as the table says.

**Not in it:** `skydeck window` (task 25); the page (tasks 26–29); turn ends, attention,
notifications (B); restore and the commands' `--window` (C).

---

### Task 24: `doctor`, `install`, `uninstall`

**Depends on:** 2, 5, 15, 18, 19, 22 · **Wave:** 5 · **Design:** S2 16.1, 16.2, 16.3, 6.1 (`.wslconfig`) · **Contracts:** 2.8 · **Decisions:** A30 (update S2 16.3)

**Goal.** The changes S2 16 makes to step 1's three commands. `doctor` gains the lines of 16.3
and still starts nothing but `gh`, `wezterm` and `python3 --version`, and nothing on Windows;
`install` gains the python3 `info` line; `uninstall` stops the server, names the profile folder,
and `--purge` refuses while keepers live.

**Files**
- Modify: `src/cli/commands/doctor.ts`, `src/cli/commands/install.ts`, `src/cli/commands/uninstall.ts`
- Create: `src/window/wslconfig.ts` (`instanceIdleTimeout(text): number | null`, reading
  `[general]` only); `src/window/drive.ts` (where the Windows side is read, `SKYDECK_TEST_MNT_C`,
  A31); `src/cli/window-checks.ts` (doctor's window lines); `src/cli/python.ts` (`python3
  --version` for install and doctor)
- Modify: `docs/design-step-2.md` 16.2, 16.3 (A30; ruled by the plan owner, task 24)
- Test: `test/cli/commands/doctor-window.test.ts`, `test/cli/commands/install.test.ts`,
  `test/cli/commands/uninstall-window.test.ts`, `test/window/wslconfig.test.ts`,
  `test/window/drive.test.ts`; helper `test/helpers/window-machine.ts`

**Tests** (platform: `testDeck(t, { real: true })`)
- `doctor`, one case per line of S2 16.3 with its `ok`, `info` and `problem` forms: python3 found
  (3.12), missing, 3.8 (a stub printing `Python 3.8.10`), missing while the window was never used
  (`info`); server not running (`info`), running (`info` with pid, checkout, build, uptime, pages,
  terminals and the environment's origin), another build (`problem` naming `--restart`), another
  checkout, alive but not answering; port held by a foreign listener (A30: seen in
  `/proc/net/tcp`, nothing bound by `doctor`) → `problem`; the alarm
  set → `problem` naming `--new-secret`; keep-alive: `.wslconfig` with `instanceIdleTimeout=-1`
  (in a sandbox folder standing for the Windows profile) → `ok` naming it, the keep-alive running
  → the unverified wording of 16.3, neither while a keeper lives → `problem`; interop link
  dangling → `problem`; Edge missing (`info` before first use); profile folder underivable;
  runtime directory of a wrong mode, too long a socket path, `XDG_RUNTIME_DIR` passed over without
  lingering (`info`); a vendored file altered → `problem`; keepers counted from their `.pid` lines
  with versions and `started`, a dead one `info`.
- `doctor`, `uninstall` and `uninstall --purge` never connect to a keeper (keeper sockets that
  record connections, one not started stays not started — S2 17.3); `doctor` starts no Windows
  program (fake processes record nothing).
- The server in these tests is task 22's fake serve (it answers `/ping`, `/status` and
  `/shutdown`), since `startTestServer` arrives in the same wave.
- `install` without python3 → the `info` line; with python3 → none; nothing else changes.
- `uninstall` with a running server (a test server) → stopped, the line with the number of
  terminals, keepers still alive; the profile folder line; `--purge` with a live keeper `.pid`
  line in any candidate directory (recorded, `$SKYDECK_HOME/run`, `<stateDir>/run-<id>`) → exit 1
  naming the terminals, nothing removed; without → the directories removed.

**Done when:** each line of S2 16.1–16.3 is printed in each of its cases, and step 1's tests of the
three commands pass unchanged — but for one expectation (ruled by the plan owner, task 24): the
programs doctor runs gain `python3 --version`, which S2 16.3 adds. While the window has never been
used every new line that would be a problem is `info` (S2 16.3), so step 1's doctor tests see no
new problem; a test shows both sides. One test fails if any code path of `doctor` or `uninstall`
touches `/mnt/` in a test sandbox.

**Not in it:** `skydeck window` itself (task 25).

---

### Task 25: `skydeck window`

**Depends on:** 22, 23 · **Wave:** 6 · **Design:** S2 5.1, 5.3, 8.2.2 (the alarm, the waiting command), 14 (Edge missing, run twice, hung, another checkout) · **Contracts:** 2.8 (`client.ts`, `lifecycle.ts`) · **Decisions:** A31

**Goal.** `src/cli/commands/window.ts`: the one command that starts the server and opens a window,
with `--print-url`, `--new-window`, `--restart`, `--stop` and `--new-secret`.

**Files**
- Create: `src/cli/commands/window.ts` (`export const command: Command`, summary `Open the
  window`)
- Test: `test/cli/commands/window.test.ts`, with `test/fixtures/fake-edge/` (an executable that
  records its arguments and, when the test asks, plays a page: it takes the token from the
  `--app` address and does the handshake in mode `launch` with `ws`, once or twice)

**Behaviour.** S2 5.1 step by step, through `lifecycle.ts` for the server, `client.ts` for the
tokens and the page count, `startEdge` for Edge, and `kv` `window_launching` (one transaction,
stale after 45 s) around starting Edge and waiting. The 30-second wait and the 2-second second-use
wait are parameters (A31). `--new-secret`: `stopServer`, `replaceSecret` (clears the alarm), then
as without options. Exit codes 0, 1, 2. Ruled by the plan owner (task 25): before it stops a
server (`--restart`, another build) the command reads its `status().pages`; when it answered with
pages > 0 and the run is not `--new-secret`, `--new-window` or `--print-url`, it waits up to 7 s (a
parameter, A31) for a page on the new server, which is then "a page is already connected" (no
token, no Edge); `--stop` combines with no other option and `--print-url` not with `--new-window`
(usage); the `CLAUDECODE` refusal holds for every option.

**Tests** (platform: `realTestPlatform`; a real server through `bin/skydeck serve` with `SKYDECK_TEST_PORT=0`
and `SKYDECK_TEST_INTEROP_FIRST` in the sandbox, the port read from `server.json`; the config
written by `writeWindowConfig` with `window.edge` = the fake Edge and `keepAlive` off, A32)
- No server: one is started, the fake Edge gets S2 5.3's four arguments with a token, plays the
  page → `skydeck window: http://127.0.0.1:<port>/ (server pid <n>)`, exit 0; the token is
  `dropped` afterwards; no key or token in any printed line.
- The fake Edge does not connect → exit 1 naming `--print-url`, the token dropped, the server
  still running. The fake Edge presents the token twice → the alarm line naming `--new-secret`,
  exit 1, `window_alarm` set. `window_alarm` already set → the extra line, and it goes on.
- A page already connected → `skydeck window: a window is already open`, Edge not started;
  `--new-window` → Edge started.
- `--print-url` → `http://127.0.0.1:<port>/#t=<token>`, Edge not started, the token still
  `waiting` after the command (valid 10 minutes).
- `--restart` → the restart line, a new server pid, the keepers (a terminal opened before) alive
  and rediscovered; `--stop` → no server, keepers alive; `--new-secret` → a page holding the old
  key is refused (4003) on its next connection, the alarm cleared.
- A server of another `appRoot` → its line, exit 1; a hung server (a fake that never answers) →
  its line naming `--restart`; a server of this checkout with another build (a file added under
  `src/` of a fixture checkout) → restarted with the line.
- Edge missing → S2 5.3's line, exit 1, the server keeps running. `CLAUDECODE` set → the refusal,
  exit 1, nothing started. Two `skydeck window` at once → one server, one Edge start.
- Ruled (task 25): a window open, then `--restart` or another build → its page reconnects within
  the wait → "a window is already open", no token, no Edge; no page comes → Edge after the wait;
  `--new-secret`, `--new-window`, `--print-url` and an old server with 0 pages → no wait.

**Done when:** every path of S2 5.1 has a test and no Windows program is started by the tests.

**Not in it:** a Start-menu shortcut (S2 20).

---

### Task 26: The page shell — connection, key, app state

**Depends on:** 20, 23, 31 · **Wave:** 6 · **Design:** S2 4.3 (`web/`), 6.3, 8.2.2 (the page's side), 8.2.5, 12.1 (layout), 12.9 (zones, dispatch), 15.3 (reload), 15.4, 17.4 · **Contracts:** 2.7, 2.9 · **Decisions:** A11, A16

**Goal.** The page as a walking skeleton (A16): the HTML and base styles, the handshake and the
stored key through Web Crypto, the connection with ping, reconnect and the server-gone bar, the
app state and the key dispatch over task 31's table, and minimal working versions of the modules
tasks 27–29 replace. After this task a window shows the list as plain lines and can resume a
session into a terminal pane that says "terminal view comes with task 28".

**Files**
- Create: `web/index.html` (asset URLs as `/assets/__VERSION__/web/…`, the regions of S2 12.1, the
  server-gone bar, `<link>`s to `web/style.css`, `web/list.css`, `web/terminal-view.css`,
  `web/cards.css`), `web/style.css`, `web/list.css`, `web/terminal-view.css`, `web/cards.css`
  (the three last ones empty but for a comment naming their task), `web/auth.js`,
  `web/connection.js`, `web/app.js`, `web/pane.js`, and the minimal `web/list.js`,
  `web/terminal-view.js`, `web/cards.js`, `web/help.js`
- `web/keys.js`, `web/format.js` (task 31) and task 27's `web/list-text.js` use no DOM, so that
  node:test and the root `tsc` can load them; every module of `web/` is checked by `tsc -p web`.
- Create: `web/tsconfig.json` (DOM library, `allowJs`, `checkJs`, `noEmit`, the vendored `.d.mts`
  shims and `src/window/protocol.ts` in reach; `protocol.ts` needs an ES2024 library or later for
  `String.prototype.isWellFormed` and `allowImportingTsExtensions` for its `.ts` import of
  `src/claude/session-id.ts`)
- Modify: `package.json` (`"typecheck": "tsc --noEmit && tsc --noEmit -p web"`)
- Test: `test-page/shell.test.ts`, `test-page/auth.test.ts`, their helper `test-page/helpers/shell.ts`
  (the recorder, stand-in servers), `test/web/pane.test.ts` (node:test on `web/pane.js`), and one
  case in `test/window/server-failures.test.ts` (a launch hello closed 1013 uses up no token;
  ruled for this task)

**Behaviour.** `auth.js`: S2 8.2.2 steps 3–6 and "where the page keeps its key" — HMAC proofs,
HKDF, `unwrapKey` into a non-extractable HMAC key, IndexedDB, the token used once. The page
encodes its nonce `cN` from its 32 random bytes in canonical base64url without padding, and takes
the server's `sN` only in that form (the rule of 2.8's `isNonce`; ruled, task 11). `connection.js`:
S2 6.3, 8.2.5 and the reload keys of S2 12.9 and 15.3 (a new connection, the server's proof, only
then `location.reload()`); `input` split into messages of at most 64 KiB. `app.js`: `start`,
`view` and `focus` messages; selection, zones (the terminal by default; a coloured top edge and
`Focus: list` / `Focus: terminal` in the key bar), the most-recently-used order for Ctrl+Tab and
Ctrl+Shift+O, slots for Ctrl+Shift+1–9, Ctrl+Shift+L, Ctrl+Shift+N, Ctrl+Shift+H, and the keys of
later stages (A11), which only show `<key>: comes in a later stage`; it cancels a key exactly when
`keys.cancels` says so. In a normal browser tab (`display-mode` not `standalone`)
the key bar names Ctrl+Shift+O and `+ New` (S2 5.1 `--print-url`). `tsc -p web` checks the
JSDoc of every module with `checkJs` (TypeScript 7.0.2 does: review B ran it on a JSDoc project
with `@import` and `@typedef`, ruling 5).

**Tests** (platform: `realTestPlatform`; through `startTestServer`)
- In the page: a key the table of task 31 handles is cancelled (`defaultPrevented`), Alt+F4 and a
  key no zone uses are not; Ctrl+Shift+P and Ctrl+Shift+J show `comes in a later stage`.
- `auth.test.ts` (Chromium, the page loaded from a test server): the vector of S2 8.2.2 through
  Web Crypto — the page's proofs and the unwrapped key's proofs equal the pinned values; after a
  launch the key is in IndexedDB, survives a reload, still signs, and `exportKey` fails; the
  launch token is gone from the address before the first WebSocket is created (an init script
  records `location.href` in the `WebSocket` constructor); a page that failed once with its token
  never presents it again; a page that holds a stored key and is given a token uses mode
  `launch` and ends up with the new key (the old one is gone from IndexedDB); against a stand-in
  server whose proof is wrong the page sends nothing
  after `hello` and shows the warning with the port.
- `shell.test.ts`: the CSP lets the page's files load and an inline script injected into the
  served HTML by a stand-in server does not run; F5, Shift+F5, Ctrl+R, Ctrl+Shift+R and Ctrl+F5
  in the list zone, Ctrl+Shift+R in the terminal zone, BrowserRefresh in both if Playwright can
  send it, and F5 and Ctrl+R in the terminal zone while the page, not xterm.js, has the keyboard
  (the placeholder pane; the find bar from task 28 on), reload only after a server's proof, and not at
  all against a stand-in server without one; a dropped file does not navigate the window; the
  server stopped → the bar of S2 6.3 within 4 s; started again (same boot) → "skydeck's server
  restarted; your sessions kept running" and the list back; a server started with another boot
  id (`startTestServer(t, { bootId })`, A36) → "WSL has restarted since <time>…" (S2 6.3; ruled, the time the page lost the old server); the keep-alive `failed`
  in `welcome` and a `keepalive-lost` notice → "WSL is not kept running" in the title bar until
  `keepalive-back`; a `tick-failed` notice shown until the next `list`; a server with another asset version
  → the page reloads; the service-worker case of S2 17.4 (a stand-in server that registers a
  worker, then the real server answers its script with 404): the result is recorded in the test's
  output and the pull request, whichever it is (it settles W25's second half for Chromium).

**Done when:** the shell connects, authenticates and survives a server restart as S2 6.3 says;
`tsc -p web` passes; the key table is complete for stage A and tested on both layouts.

**Not in it:** the real list, terminal view, cards and help (tasks 27–29 replace the minimal ones).

---

### Task 27: The list

**Depends on:** 26 · **Wave:** 7 · **Design:** S2 12.1, 12.2 (stage A), 12.9 (the list zone), 12.10, 19 (states only; design 7.3's chip; design 7.4's filter) · **Contracts:** 2.9 (`list.js`) · **Decisions:** A18

**Goal.** Replace the minimal `web/list.js` with the list of S2 12.1 and 12.2 for stage A, and the
title bar's counts, rendering exactly what the server's `list` says.

**Files**
- Modify (replace): `web/list.js`, `web/list.css`
- Create: `web/list-text.js` (no DOM: the text of a row, of its state line and of a section
  header, so that the root project and node:test can load it)
- Test: `test/web/list.test.ts` (node:test on `web/list-text.js`), `test-page/list.test.ts`

**Behaviour.** Sections with Open never folded and Earlier folded by default (`count`, span);
rows of two lines (running) and one line (not running) with slot numbers, the ticket key dim and
monospaced, the group dim when the title does not start with it, marks in words, design 7.3's
chip, `✎`, the age; `starting…` and `running in another terminal` second lines; the footer
`<n> done hidden · show` and `a`; the filter `/` (Esc clears it, then goes back to the terminal);
list keys ↑ ↓ `j` `k` Home End PgUp PgDn ← → Enter; "started, not reported" on the row of a
terminal whose `notReported` is set (S2 7.5); a click selects (a running row focuses its
terminal, another the list), a double click activates; the title bar's counts per state.
Everything through `textContent`.

**Tests** (platform: `realTestPlatform`)
- `list.test.ts` (node): the row text for a running, a not-running, a starting and an elsewhere row, with
  marks and a chip; a note's first line with an escape character is shown sanitised.
- `list.test.ts` (page; a test server with sessions made by step 1's helpers and a stand-in in a
  terminal): sections and order as the server sent them; Earlier folded with its count, ← → fold
  and unfold; `a` and the footer show done sessions; `/` filters; ↑ ↓ and `j` `k` move the
  selection and the page sends `view` and `focus`; Enter on a not-running row resumes it (the
  terminal appears in slot 1); a hostile title (`<img src=x onerror=…>`) appears as text.

**Done when:** the list shows every stage A element of S2 12.1 and 12.2 and the list zone's keys
work.

**Not in it:** stacks, chips, the multi-word filter (E); attention marks (B); editing keys (D).

---

### Task 28: The terminal view

**Depends on:** 26 · **Wave:** 7 · **Design:** S2 8.2.4, 8.2.6 (the page's side), 9 (all), 12.6 (attached terminals), 12.9 (terminal chords), 15.4 · **Contracts:** 2.9 (`terminal-view.js`) · **Decisions:** —

**Goal.** Replace the minimal `web/terminal-view.js` with real terminals: one xterm.js per
attached terminal with the vendored addons, the snapshot and stream protocol, sizes from the
server only, the key mapping of S2 9.1, swallowed queries, links, the clipboard and find.

**Files**
- Modify (replace): `web/terminal-view.js`, `web/terminal-view.css`
- Test: `test-page/terminal.test.ts`, `test-page/keys.test.ts`

**Behaviour.** xterm.js 6.0.0 with `addon-unicode-graphemes` and `addon-search` (Ctrl+Shift+F);
the proposal sent in `attach` and `resize` is computed by the view itself, with xterm.js's own
rounding of its screen (S2 8.2.6) — not by `addon-fit`, whose division depends on the
terminal's current size and has no fixed point at some widths (ruled by the plan owner, M4 of
task 28's review; `addon-fit` stays vendored, its removal a follow-up); scrollback 5,000; the
DOM renderer; the font list `"Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Symbol",
monospace` (W9 checks it). The size is set only from `snap` and `size`; a page that is not the
owner shows "sized by another window". Up to 8 terminals stay attached, the least recently shown
detached beyond that, all but the shown one detached while the window is hidden. Parser handlers
swallow the queries of S2 9.3; OSC 52 as S2 9.5; Ctrl+click on an OSC 8 link or a plain
`http(s)://` URL sends `act open-link`, an OSC 8 link whose text differs from its target shows
the target first; OSC 0 and 2 are ignored; the ended terminal is dimmed (the bar is `cards.js`'s).

**Tests** (platform: `realTestPlatform`; a test server with the stand-in)
- A cell written with `/red x` has the computed colour red (the CSP lets xterm.js's `<style>`
  work); `/query` → the stand-in records exactly one answer per query (the screen side's) and the
  page sends nothing for any of them (the server logs no `input` from the page meanwhile).
- Keys reach the program as the stand-in records them: Shift+Enter → `0a`; Ctrl+Shift+V → `16`;
  Ctrl+V with text on the clipboard → a bracketed paste and never `16`; Ctrl+Shift+P → nothing;
  a paste of 2 MiB → whole, in `input` messages of at most 64 KiB; typing makes the page the size
  owner.
- Switching: two terminals; Ctrl+Shift+1 and 2, Ctrl+Tab and Ctrl+Shift+O switch; a terminal
  shown before needs no new `snap`; the ninth one shown detaches the least recently shown.
- OSC 52 from the shown terminal in a focused window writes the clipboard; from a hidden one
  it does not; `/link` with differing text → the first Ctrl+click shows the target, the second
  sends `open-link`.
- Find: Ctrl+Shift+F finds a line printed 3,000 lines up.
- Notices on the terminal they concern: `input-full` (the stand-in in `/stall` with a large paste),
  `gap` and `newer-keeper` (sent by a test server through the hub), and the `reconnecting` bar
  (the keeper stopped with `SIGSTOP` for 3 s and the server's connection to it cut: a stopped
  keeper keeps its connection, ruled for task 16) — each shown, and gone when it no longer holds.
- After a server restart the terminal shows the same screen (a fresh `snap`).

**Done when:** the checks of S2 17.4 about keys, queries and colours pass, and switching between
terminals is instant for attached ones.

**Not in it:** the kitty keyboard protocol, WebGL, an XTVERSION answer (S2 20).

---

### Task 29: The right side — header, cards, the new form, the key help

**Depends on:** 26 · **Wave:** 7 · **Design:** S2 7.8 (the bar), 7.9 (the card), 12.5 (read-only in stage A), 12.6, 12.9 (the help), 19 · **Contracts:** 2.9 (`cards.js`, `help.js`) · **Decisions:** A11, A27

**Goal.** Replace the minimal `web/cards.js` and `web/help.js`: the read-only header, the resume
card, the card of a session running elsewhere, the ended bar, the new form and the key help.

**Files**
- Modify (replace): `web/cards.js`, `web/cards.css`, `web/help.js`
- Test: `test-page/cards.test.ts`

**Behaviour.** Header: title, group, state, directory, short id (a click copies the whole id),
design 7.3's chip. Resume card from `list.selected`: how it ended, last activity, directory, the
exact command, the flags not passed on, the expiring warning, the button disabled when expired;
the result's `lines` shown on it. Elsewhere card: pid, terminal device, directory, and that it
cannot be shown here. Ended bar: `claude exited (status <n>) at <time> · Resume · Close`, the
lost and not-started texts of S2 7.8 and 7.3. New form: the directory (a list of `list.dirs`,
defaulting to the selected session's, or a typed absolute path), label, group, flags as typed;
Enter or the button sends `act new` with the size of the terminal area; errors shown in the form.
Key help (Ctrl+Shift+H): every key of S2 12.9, those of later stages marked `comes in a later
stage` (A11), the browser-tab note, the note on Claude Code bindings the window shadows.

**Tests** (platform: `realTestPlatform`; a test server with sessions and the stand-in)
- The resume card of a not-running session shows the command the server sent; "Resume here"
  starts it and the terminal is shown with focus; a refusal (the session started elsewhere by the
  test) shows the guard's message on the card.
- An elsewhere session shows the card with its pid; `/exit` in a terminal → the bar with status
  0; Resume on the bar starts the session again; Close forgets the terminal (`close-terminal`).
- Ctrl+Shift+N opens the form; a label `fix` and flags `--model opus` → a row `fix` starts; flags
  `-r x` → the server's message in the form, nothing started.
- Ctrl+Shift+H shows and hides the help; every key in the help is one `keys.js` handles, and the
  keys of later stages are marked so.

**Done when:** every right-side view of S2 12.6 that stage A has is shown for its case.

**Not in it:** editing in the header, pull-request lines, Done (D); the restore banner (C).

---

### Task 30: Documentation of stage A

**Depends on:** all · **Wave:** 8 · **Design:** S2 16 (what users need to know), 18 (the checks of stage A), 19 · **Contracts:** — · **Decisions:** —

**Goal.** A user can start and use the window from the documents alone, and knows which checks
only they can make.

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` only
  where a decision of 1a is still missing from it
- Create: `docs/check-kit/` — the research's check kit, brought into the repository so that the
  manual checks can be run from a checkout. The kit lives outside the repository
  (`personal/skydeck-design/step2-research/window/check/`); the lead hands the implementer a copy
  in its worktree or names the path it may read — the implementer does not go looking outside its
  worktree. From it: `keytest.html`, `keytest.js`, `serve.py`,
  `edge-app.sh`, `STEPS.txt` and `lifetime/lifetime.ps1`, each read whole before it is committed.
  Every PowerShell script in the kit is optional and begins with a note, repeated where
  `docs/manual-checks.md` mentions it: on a managed company PC it needs the PC owner's agreement,
  and no check requires it. Nothing in the kit or the documents asks the user to bypass or change
  an execution policy (`-ExecutionPolicy Bypass`, `Set-ExecutionPolicy`, `Unblock-File`); a
  script that does is changed or left out. Left out as well:
  `keylog.jsonl` (a recording of the user's own key presses), the Alpine tarball, and `windows/`
  (the native host is out of step 2). The optional part of the W14 section names the tarball:
  `https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.4-x86_64.tar.gz`,
  sha256 `cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012` (Alpine's published
  `.sha256` and the copy the research used agree, checked while writing this plan), and how to
  compare it (`Get-FileHash` in PowerShell, `sha256sum` in WSL). `docs/` is outside the build and outside Prettier.

**Content (contract)**
- `docs/install.md`: a section "The window (step 2)": python3 ≥ 3.9 (`sudo apt install python3`
  if missing), Edge on the Windows side, `skydeck window` and its options, the profile folder and
  `window.profileDir`, the `window.*` keys of S2 16.4 with defaults and an example, the
  keep-alive and its alternative `instanceIdleTimeout=-1` in `.wslconfig` (S2 6.1; skydeck never
  writes it), what `doctor`'s new lines mean, updating while the window runs (`skydeck window`
  restarts the server; sessions keep running; S2 16.5), what `uninstall` does to the window, and
  that nothing is fetched at install time (the vendored files are in the repository).
- `README.md`: `window` and `serve` in the command table; the window in two sentences; the
  Development section gains `npm run test:page` and `npx playwright install chromium`.
- `docs/manual-checks.md`: one section per check of stage A — W1–W10, W12–W15, W17, W18, W20,
  W22–W26 — each with what to set up, the commands, what to look at and what to write down;
  "real claude" checks in a throwaway folder as the existing sections do. W2 uses the window
  itself (every chord, those of later stages included, is the page's, A11) and, for a normal
  browser tab, `docs/check-kit/keytest.html` through `serve.py` and `edge-app.sh`. W14's first
  and recommended form needs no script: open the window, start a throwaway session in it (a
  throwaway folder), close every WSL terminal, wait two minutes, and look whether the session is
  still alive (it answers in the window; no server-gone bar). Measuring the idle rule with
  `docs/check-kit/lifetime/lifetime.ps1` against a throwaway distribution is an optional second
  form, with the note above. W24's procedure: kill a
  keeper (and a throwaway `node` started through the launcher's `/usr/bin/python3 -I -S -c` program) with SIGSEGV
  and look in `%Temp%\wsl-crashes` (or `crashDumpFolder` in `.wslconfig`); neither may leave a
  dump. W25's "small Windows
  program" is given as a PowerShell `TcpListener` one-liner on `127.0.0.1:<port>`, typed at a
  prompt (no script file, no change to the execution policy), started before `skydeck window` and
  stopped with Ctrl+C; on a managed company PC only with the owner's agreement. W11, W16, W19 and W21 are left for their stages.

**Steps**
- [ ] Run every command of the new install section on a clean `SKYDECK_HOME` (Edge replaced by
      `--print-url`) to check it is exact.
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can set the window up from `docs/install.md` alone, and every stage A
check of S2 18 is in `docs/manual-checks.md`.

---

## 4. Design coverage

| Design (S2) | Where |
|---|---|
| 1, 2 Principles | 3 (principle 3) → 9, 16; 4 (no content in files or logs) → 11, 15, 17, 23 (log tests); crash dumps → 6, 9, 23; 6 (never stop a process) → 22 (identity before signals), 16; 8 → 14, 17 (loopback, Host, Origin); Windows programs → 19, 25; dependencies → 2; 9 → 8 (`src/claude/terminal.ts`) |
| 3 Words | 1 (types) |
| 4.1 Processes | 6 (launcher), 9 (keeper), 7 and 19 (keep-alive), 22–23 (server), 19 (Edge) |
| 4.2 Places | 5 (rule), 15 (record, files, lock), 9 (keeper's files), 7 (keep-alive's files), 24 (purge) |
| 4.3 Code layout | 2.1 conventions; every task's file list; A8, A9, A10 |
| 4.4 Changes to step 1's code (stage A rows) | 4, 5, 6, 20, 2, 24, 23 (`serve`), 25 (`window`) |
| 5.1 `skydeck window` | 25 (22 for the server) |
| 5.2 Starting the server | 22, 23, 15 (lock, log) |
| 5.3, 5.4 Edge, profile folder | 8, 19, 24 (doctor), 25 |
| 5.5 Stopping | 23, 22 |
| 6.1, 6.2 Keep-alive | 7, 19, 23, 24 |
| 6.3 Server gone | 26 |
| 6.4 Interop link | 19, 21 (programs' environment), 23 (every 30 s) |
| 6.5 Sleep | 26 (reconnect), 16 (reconnecting keepers); W15 |
| 7.1 Keeper | 9; 16 (spawn), 21 (spec, `G`) |
| 7.2 Screen side | 12, 16, 33 (the snapshot's seam) |
| 7.3 Attach, park, rebuild | 12, 16, 21 (found keepers) |
| 7.4 Program environment | 8, 21 |
| 7.5 Terminal and session | 21 (mapping), 13 (rows), 23 (tick) |
| 7.6 Slots | 16, 13 |
| 7.7 Keeper versions | 9, 16 |
| 7.8 Program ends | 9, 16, 21, 29 (bar) |
| 7.9 Elsewhere | 21, 13, 29 |
| 8.1 Server and keeper | 1, 9, 16 |
| 8.2.1 HTTP | 14, 10 |
| 8.2.2 Handshake | 11, 17, 26 |
| 8.2.3 Messages | 1, 17, 32 (`act`), 23 |
| 8.2.4–8.2.8 Streams, reconnect, size, several windows, backpressure | 17, 16, 26, 28 |
| 8.3 Command line and server | 1, 18 |
| 9 Typing and reading | 31 (the mapping), 26 (dispatch), 28 |
| 10.1 What the server keeps; the tick | 23, 4 (guard) |
| 10.2 Store | `kv` keys in 4; migration 2 is stage B |
| 10.3 Turn ends | stage B |
| 11.1 One implementation | 4 |
| 11.2 Window terminal | 21 |
| 11.3 In the window | 32 (resume, new), 23 (wiring), 27–29; restore is stage C |
| 11.4 Commands while the window runs | stage C (stage A leaves the commands as in step 1) |
| 12.1, 12.2 Layout, rows | 13, 27 |
| 12.3 The window's chip | stage D (stage A shows design 7.3's) |
| 12.4 Attention | stage B |
| 12.5 Header | 29 (read-only) |
| 12.6 Right side | 26 (pane), 28, 29 |
| 12.7 Restore banner | stage C |
| 12.8 Search | 13, 27 (design 7.4's filter); the rest stage E |
| 12.9 Keys and focus | 31 (the table), 26, 27, 28, 29 |
| 12.10 Done | 13 (a running done row stays); marking done is stage D |
| 12.12 Icon | stage E |
| 13 Notifications | stage B |
| 14 Failures | 16, 21, 23 (inside Linux), 25 (commands), 26 (page); Windows cases are manual checks |
| 15 Security | 11, 14, 17 (threats on the port), 15 and 18 (unix sockets), 28 (output untrusted), 21 (what runs) |
| 16.1–16.4 Install, uninstall, doctor, configuration | 24, 5 |
| 16.5 Updating | 14 (build, assets read once), 23 (migration under the server), 25 (restart on another build) |
| 16.6 Vendored files | 2 |
| 17 Testing | each task's tests; 3 (stand-in), 20 (CI) |
| 18 Manual checks | 30, and section 5 below |
| 19 Stages | this plan is stage A |
| 20 Left out | nothing here builds it |

## 5. Stage A is ready to try

When task 30 is merged. **First, before real work:** the keep-alive is unverified until W14
(S2 6.1); if it does not hold, every session in the window ends about 15 seconds after the last
WSL terminal closes. Until W14 has passed, keep one WSL terminal open (or set
`instanceIdleTimeout=-1` in `.wslconfig`), and run W1, W20 and W4 with a throwaway session in a
throwaway folder before resuming real sessions into the window.

In a WSL terminal of your own (not a `!` command inside a Claude Code session: `skydeck window`
refuses there, S2 5.1):

```sh
cd <your skydeck checkout>
git pull
skydeck doctor          # new lines: python3, server, port, keep-alive, interop, Edge, profile folder,
                        # runtime directory, vendored files, keepers
skydeck window          # starts the server and opens the Edge app window
```

No `npm ci`, no `install` again: the hook entries are unchanged and xterm.js is in the repository.
Without Edge at the default path: `skydeck window --print-url`, and paste the address into any
browser within 10 minutes. Afterwards: `skydeck window` again after every `git pull` (it restarts
the server for the new build; sessions keep running); `skydeck window --stop` stops only the
server; a session ends only when you end it inside `claude`.

**What only you can check** (the manual checks of stage A, in `docs/manual-checks.md` after task
30; most useful first):

- **The window on the PC** — W1 (the window opens; write down how long Edge took, cold and warm),
  W20 (privilege management lets `msedge.exe` and `wsl.exe` start through interop), W3 (its own
  taskbar button, one window), W13 (`edge://policy`, forced extensions, profile sync).
- **The real `claude` in the window** — W4 (status line, spinner, resize; then `skydeck window
  --restart` and the screen is unchanged), W6 (Shift+Enter, Ctrl+V, Ctrl+Shift+V image paste,
  Ctrl+Shift+C, OSC 52), W22 (a session from a WSL terminal shows "running in another terminal" and
  resumes into the window after `/exit`), W23 (which `CLAUDE*` variables Claude Code sets; `skydeck
  window` refused inside a session), W5, W10, W17, W18, W26 (a restart while it uses the alternate
  screen: what a snapshot does not restore).
- **Keys and fonts in Edge** — W2 (in the window: every chord of S2 12.9 reaches the page and Edge
  does nothing, Ctrl+Shift+P and J included, which say they come in a later stage; Alt+F4 still
  closes; for a normal browser tab, `docs/check-kit/keytest.html`), W8 (Czech layout, AltGr, dead keys,
  Ctrl+Shift+-), W9 (Claude Code's symbols), W12 (Ctrl+click opens in your own Edge).
- **WSL** — W14 (a throwaway session in the window is still alive two minutes after every WSL
  terminal was closed; no script needed), W7 (image paste
  after closing the terminal that ran `skydeck window`), W15 (sleep), W24 (no crash dumps), W25
  (a Windows program on the port).

## 6. Questions for the lead, and the rulings

Asked with the first version of this plan; the lead ruled on 2026-11-13, and the plan above
follows the rulings.

1. **Licence files of `@xterm/headless` and `@xterm/addon-serialize`.** Ruled: copy
   `@xterm/xterm`'s `LICENSE`, on the condition that the package's `package.json` declares MIT and
   the same repository, and record why in the manifest (A3, task 2).
2. **Ctrl+Shift+P and Ctrl+Shift+J in stage A.** Ruled: the page cancels every key of the design's
   table from stage A on, also those whose action comes later; they do nothing yet and the help
   says so (A11, tasks 26 and 29).
3. **CI changes in two tasks.** Ruled: the split of A14 stands.
4. **Task 9's size.** Ruled: keep it whole.
5. **TypeScript 7 and JSDoc.** Ruled: keep `checkJs` for `web/`; review B ran the repository's
   TypeScript 7.0.2 on a JSDoc project and it checks it, so no fallback is needed.
6. **Chromium for implementers.** Ruled: implementers may run `npx playwright install chromium`
   (no `sudo`, no `--with-deps`); prefer a Playwright at least two weeks old whose Chromium is the
   build already installed (1223). That is 1.60.0 (A5).
7. **Protocol additions (A25–A27, A29).** Ruled: agreed; tasks 1 and 23 record them in the design.
8. **Stage C rows that already exist.** Noted: `planRestore` and `runRestore` already live in
   `src/sessions/restore.ts`, so stage C moves only the restore command's private planning; S2
   17.3's tests of `resume --window` and `new --window` belong to stage C.

Rulings on the two reviews (2026-11-13): task 26's pure modules become task 31 (wave 1); task 23's
actions become task 32 (wave 4); task 9 stays whole; `checkJs` stays for `web/`.

Rulings on task 12's findings (2026-11-13):

9. **A snapshot where a record ends inside an escape sequence or a UTF-8 character** is not
   exact. Ruled: both halves are closed in stage A — the keeper never ends an output record
   inside a UTF-8 character (task 9), and the new task 33 (wave 3) keeps the unfinished escape
   sequence and appends it to every snapshot; task 12 leaves the seam.
10. **What the serialise addon does not restore beyond S2 7.2's first list.** Ruled: task 12 also
    restores mode 1016 beside 1006 and mode 12, re-prints the last cell when the cursor stands
    past the last column (the pen can then differ in one case, named in S2 7.2 — superseded by
    item 11: the pen is restored), and answers OSC
    10 and 11 with xterm.js's default colours until a page has sent its theme. The scroll region,
    the saved cursor and the character sets stay known limits (S2 7.2, check W26).
11. **From task 12's review 2.** Ruled: `@xterm/addon-serialize` 0.14.0 loses bold or dim when
    either goes off (SGR 22 turns off both); its vendored bundle is patched at vendor time, in
    task 12's pull request (task 2's script and manifest gain the patch, S2 16.6). The snapshot
    ends with the pen read from the headless terminal's own state (the internal the serialise
    addon reads; a test pins it), so S2 7.2 has no pen limit. Modes 2026 and 20 are restored; tab
    stops join the known limits. Review 2's re-check found two more defects of the same addon —
    the alternate screen took the program's pen; cursor moves of 0 columns left a stray `-` above
    a wrapped row after a blank one. Ruled: corrected in `src/window/screen.ts` on the serialised
    text (`correctSerialized`; exact, since no cell holds ESC), not in the vendor patch, which
    stays for what cannot be corrected from outside. Three smaller differences become named
    limits in S2 7.2 (an alternate-screen line marked wrapped, DECAWM off with a wide character at
    the margin, `38;5;n` below 16).

Rulings on task 33's findings (2026-11-14):

12. **A record that ends inside a grapheme cluster** (between an emoji and its skin tone, inside a
    ZWJ sequence, before a combining mark or VS16) is not rebuilt exactly: xterm.js keeps its
    join state across writes and every CSI resets it, so a snapshot always leaves it at its start.
    Ruled: a named limit in S2 7.2 (it heals at the program's next redraw of the row), not
    repaired by the seam; task 33's "Done when" excludes those boundaries, its sweep skips them
    and one test pins the limit. Nothing for the keeper.
13. **A snapshot taken while an OSC 8 link is open** (a defect of task 12's pen): xterm.js reports
    a pen with a link as underlined, so the pen restored it as a real SGR 4, which went on after
    the program closed the link. Ruled: the pen takes only the real underline; the link is not
    reopened — a link is not carried across a snapshot, whether closed or still open, and the rest
    of an open link's text comes out as plain text (a named limit, pinned; the sweep leaves out the
    cuts while a link is open). Also named in S2 7.2: underline style and colour (SGR 4:3, 58) are
    not kept, and a link's cells come back with a plain, not dashed, underline.
14. **From task 33's review 2**, two defects of task 12's code. The headless terminal ran at
    xterm.js's default log level, so a parsing error, which quotes a character and the parameters
    of the program's output, went to stderr and so to `server.log`. Ruled: fixed in this pull
    request, `logLevel: 'off'`, tested (S2 5.2, 21). And two more differences of the serialise
    addon: rows erased with a background colour below the last row with content come back with
    the default background; an erased cell left in inverse video by overwriting half a wide
    character comes back without it. Ruled: named limits in S2 7.2, each pinned by a test, no
    repair; the sweeps' streams avoid both.

Rulings on task 19's review 1 (2026-11-14), each recorded in task 19's contract and in the design:

- `startWindowsProgram` (`src/window/edge.ts`) is the one way stage A starts a Windows program;
  it refuses an empty argument, a `"`, a control character and a trailing backslash (S2 2).
- `createInteropFrom(platform, files, first)` is exported: task 23 calls it with `interopFirst`
  (A32), since `createInterop(platform, files)` cannot take the first candidate.
- `Files.remove` unlinks and never follows a symbolic link (contract 2.2): Node.js 24.12's
  `rmSync` left a dangling one in place, which kept a dead interop link; `src/platform/real.ts`
  joins task 19's files.
- `startEdge` throws a `RangeError` for a bad port or token, and refuses a profile folder that
  would change how Edge splits its command line with a line naming `window.profileDir` (S2 5.3).
- The keep-alive (S2 6.1): the retry schedule starts over once a keep-alive has run for 5
  minutes; the line of a `wsl.exe` this server saw end does not count as running; `wsl.exe`
  starts in `/mnt/c`; a started `wsl.exe` stays `starting`, with no timeout, until its script's
  line appears or it ends; before its first tick a keep-alive in mode `wsl` reports `starting`.
- The interop link points at the socket a candidate leads to (its realpath), never at another
  link or at itself (S2 6.4).

Rulings on task 19's review 2 (2026-11-14): a new server adopted, for good, the live line of a
script whose `wsl.exe` was gone. Ruled (S2 6.1, task 19's contract): a keep-alive this server did
not start is also judged by its `keepalive.interop` socket (`probeSocket`, shared with the interop
link: refused or gone means its `wsl.exe` is gone; anything else is no judgement); a script whose
`wsl.exe` is gone is an orphan, and one whose line is alive (identity known, never `unknown`) gets
one SIGTERM from the server before the schedule starts a new keep-alive. The remaining limit (an
orphan that cannot be judged counts as running) is named in S2 6.1; the premise (the socket of a
`wsl.exe` session goes with it) is for check W14 (task 30). The profile-folder line also escapes
DEL and the C1 controls (S2 5.3).

Rulings on review 2's re-check (2026-11-14): a line only inferred to be a started `wsl.exe`'s
script (first seen at the tick that sees its end) is signalled only when its socket says refused;
before any SIGTERM the process's command line must name `skydeck-keepalive` and this runtime
directory, so the signal never reaches a keeper, `claude` or anything else; an accepting socket of
a found keep-alive is asked again only after 30 s (any other answer at the next tick) — superseded
by N3 below; "a control character" is U+0000–U+001F, U+007F and U+0080–U+009F everywhere (S2 2).
All in S2 6.1 and task 19's contract.

N3 (2026-11-14, from review 2): 30 s was longer than WSL's 15 s idle timeout, so a found
keep-alive's end was noticed after WSL had stopped. Ruled: an accepting socket is asked again
after 3 s (3 s, up to 1 s to the tick that asks, the first 5 s retry, up to 1 s to the tick that
starts: the new `wsl.exe` starts just under 10 s after the old one ended, inside the 15 s with room
for the start); S2 6.1 gives that sum, so that the number is not tuned without it.
