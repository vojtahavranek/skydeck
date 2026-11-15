# skydeck step 2, stage B — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stage B of step 2 as specified in [`docs/design-step-2.md`](../design-step-2.md)
(section 19): migration 2 (S2 10.2), turn ends (S2 10.3), seen, the three reasons and their marks
(S2 12.4), Ctrl+Shift+J, the title bar's `need you` count and `(n) skydeck`, and desktop
notifications (S2 13). It works without stages C, D and E.

**Architecture:** The server looks at the live-session files every second, as S2 10.1 says, and
records each turn end in a new table of the store, ordered by a counter, never by a clock. The
pages tell the server what is selected in which focused window; from that the server records when
a session was seen. Which session needs you, and why, is a pure function of the view model over
those facts (S2 4.3); the list, the title bar and Ctrl+Shift+J show what it says, and the server
sends a `notify` to one page when a session starts to need you while no window has focus.

**Tech Stack:** as stage A — TypeScript on Node.js ≥ 24.12 through type stripping, `node:test`,
`node:sqlite`; the page in plain JavaScript modules with JSDoc types and no build step; Playwright
1.60.0's Chromium for the page suite.

---

## 0. How to use this plan

Stage A's plan (`docs/plans/step-2-stage-a.md`) section 0 holds for every task here: the execution
model (one pull request per task, tasks of one wave in parallel in their own worktrees, two reviews
before the lead merges), the sources of truth (the design wins over this plan; "design 9.2" is
design.md, "S2 12.4" is design-step-2.md), what is fixed here and what is the implementer's, the
per-task workflow and the test rules (A32–A36: no real `claude`, no Windows program, the sandbox,
the two test platforms; page tests in headless Chromium through `test-page/helpers/`). Its
contracts (its section 2) stay in force where this plan does not change them; this plan's section
2 gives only the additions.

**Task numbers** are 50–56 (stage D has 34–39, stage C 70 and up), so that branch names,
pull-request titles and the lead's notes stay unique. The implementer brief names the branch and
the title.

**CI stays as it is**: two Node legs, one job each (the user's decision of 2026-11-14). No task
changes `.github/workflows/`, `package.json` or a dependency.

**Added to the test rules.**
- No test shows a desktop notification or asks for a permission. Every browser context of the
  page suite is made by `newContext` of `test-page/helpers/browser.ts`, which gives its pages an
  inert `Notification` unless a double is there (B17); the cases about notifications install a
  recording double, and a double of `document.hasFocus`, by init scripts
  (`test-page/helpers/notification.ts`, task 55). No test grants a permission through Playwright.
- No test reads or writes a real settings file: stage B changes no hook entry (B19), so no task
  touches `install`, `uninstall` or the settings code.
- A test of migration 2 starts from a database made as step 1 and stage A leave one, with data
  in it (`test/helpers/schema1.ts`, task 50), never from a database on the machine.

**Known flakes** (not stage B's to fix): `test/platform/real.test.ts`, "a streamed answer that
keeps coming…", and its case at line 1005 (it reads the wall clock, which WSL steps back);
`test/standin/standin.test.ts` (records in the wrong order now and then);
`test/window/mapping.test.ts:623` (ENOTEMPTY at the sandbox's clean-up); `test-page/terminal.test.ts`,
"input-full (the program stalled, a large paste)" (under load the key can be taken). A run that
fails only with one of them is run once more, and the pull request names both runs.

## 1. Tasks and waves

Task 0 is `main` at 9c5cbfb (stage A complete) with this plan merged.

| # | Task | Depends on | Wave | Shared files (section 1c) | Size (code + tests) |
|---|---|---|---|---|---|
| 50 | Migration 2 and the store's attention | 0 | 1 | `src/store/types.ts` (one line); `docs/install.md` ("Updating") | ~450 |
| 51 | Contracts and the view model of attention | 0 (D 34 merged in before its last push) | 1 | `src/window/protocol.ts`, `src/window/view/build.ts`; `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `test/helpers/pages.ts` | ~500 |
| 53 | The turn-end rule and seen | 0 | 1 | — | ~350 |
| 52 | Attention on the server: the look, the writes, the notifier | 50, 51, 53 | 2 | — | ~650 |
| 55 | The page: marks, the title, Ctrl+Shift+J, notifications | 51; D 37 (ruled: 55 is written on top of it) | 2 | `web/app.js`, `keys.js`, `help.js`, `list.js`, `list-text.js`, `list.css`, `index.html`; `test/web/keys.test.ts`, `test/web/list.test.ts`, `test-page/shell.test.ts`, `test-page/terminal.test.ts`, `test-page/helpers/browser.ts` | ~750 |
| 54 | The server assembly, and attention end to end | 52, 53, 55; D 36 (ruled order) | 3 | `src/window/tick.ts`, `server.ts`, `pages.ts`; `test/window/tick.test.ts`, `test/helpers/pages.ts` | ~650 |
| 56 | Documentation of stage B | all | 4 | `docs/*`, `README.md` | docs only |

```
wave 1:  50  51  53
wave 2:  52  55
wave 3:  54
wave 4:  56
```

The critical path is store and contracts → the server's attention → the assembly. Task 55 builds
the page against a scripted stand-in server (as stage A's `actsWorld`), so it does not wait for the
server; task 54 is the first to drive attention end to end, with the real server and the real page.
Task 56 may start its reading while 54 is built and merges last.

### 1a. Which tasks can start at once

Tasks **50, 51 and 53** may all start as soon as this plan is merged (ruled). 50 and 53 change no
line another stage changes before them (50's `KvKey` comes before stage C's task 70's, 1c). 51
shares lines with stage D's task 34 (also wave 1): it is built beside 34 and merges `origin/main`
with 34 in before its last push, resolving the places 1c names. Task 55 waits for stage D's task
37: it may be built against stage D's plan text of D2 while 37 is open, but is pushed only once 37
is merged, and is written on top of it (ruled).

### 1b. Migration 2 on a database in real use

The user's store is in daily use (the window runs since 2026-11-15, with real sessions). What
happens at the update, from S2 10.1, 10.2, 16.5 and step 1's `migrate` (`src/store/store.ts`):

- **Who migrates.** The first process of the new checkout that opens the store: any command that
  opens it (`skydeck window`, `ls`, `doctor` …) or the new server, whose connection migrates at
  open like every other. Migration 2 runs in one transaction with its `kv` update and waits up to
  5 s for another writer (the migrations keep the 5000 ms busy timeout); a failure leaves schema 1
  and every row as they were, the command fails with `cannot open the database …`, and the next
  command tries again.
- **What it changes.** Exactly S2 10.2's `CREATE TABLE attention` (B1): no table, index or row of
  migration 1 changes. So everything that reads schema 1 still reads correctly.
- **The old server while a new command runs.** Stage A's server holds a guarded connection
  (S2 10.1): its reads go on, and its next write — while a session is active, the next transcript
  scan, within about 2 s — is refused (`StoreNewerError`) and the server stops with
  `bye "skydeck was updated; run skydeck window"`; its windows show S2 6.3's bar. Nothing is lost:
  what it did not ingest stays in the spool for the new server, a transcript is scanned again,
  keepers and their sessions keep running (S2 16.5).
- **An old interactive list (`skydeck` with no command) started before the update** keeps its open
  connection, which is not guarded: it goes on reading and writing the tables of migration 1, which
  migration 2 does not touch. It is the old code until it is started again.
- **An older command after the migration** (a second, older checkout; a checkout moved back with
  `git checkout`) is refused by step 1's rule before it reads anything: `the database … was written
  by a newer skydeck (schema version 2, this one knows 1); update skydeck`, exit 1. The way back
  is forward (`git pull`); question 1 in section 7.
- **The order of the commands at the update matters** (on stage B's path, not carried: section 5).
  When a command other than `skydeck window` runs first, the old server stops by itself and the
  next `skydeck window` finds no server: it starts one and Edge, and the old window, which comes
  back a moment later, is a second window (stage A's known limit). Even `skydeck window` run first
  is not certain: it migrates when it opens the store, and the old server's next write can fall
  into the moment before the command asks it for its windows. **The order that is certain**
  (ruled): close the skydeck window, then `git pull`, then `skydeck window` — the sessions live in
  their keepers and keep running. Migration 2 reaches the user at the first `git pull` after task
  50 is merged, long before stage B is done, so **task 50** writes that order into
  `docs/install.md`, "Updating", in its own pull request (ruled); section 6 and task 56 give the
  same order.

**Turn ends need no new hook entry** (S2 10.3, B19): they come from the live-session files the
server already reads, for every session, in the window or not. The user's `~/.claude/settings.json`
keeps its two entries (`SessionStart`, `SessionEnd`); `skydeck install` is not run again;
`skydeck doctor` reports exactly what it reports today; everything of stage B works from the first
`skydeck window` after `git pull`.

What the tests hold (task 50): a database as step 1 and stage A leave it — WAL, mode 600, a row in
every table, the `kv` entries `install` and stage A leave — migrates to schema 2 with every row of
migration 1 unchanged and an empty `attention`, also at the server's own open; opening it again
changes nothing; a connection opened before the migration, as an old interactive list holds one,
still writes and reads after it; the guard of S2 10.1 refuses a write into a store one version
newer (stage A's tests, kept on `SCHEMA_VERSION + 1`).

### 1c. Every file of every task, and what a rebase brings

Every new module is its own file with its own test file. Each task's own **Files** list says the
same as its row here.

| # | Creates | Changes |
|---|---|---|
| 50 | `test/helpers/schema1.ts`, `test/store/migration-2.test.ts` | `src/store/migrations.ts`, `src/store/store.ts`, `src/store/types.ts`; `test/store/store.test.ts`; `docs/design-step-2.md` (10.2), `docs/install.md` ("Updating", and the last paragraph of "Updating while the window runs") |
| 51 | `src/window/view/attention.ts`, `test/window/view/attention.test.ts` | `src/window/protocol.ts`, `src/window/view/build.ts`; `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `test/helpers/pages.ts`; `docs/design-step-2.md` (8.2.3, 12.1, 12.4) |
| 53 | `src/window/seen.ts`, `test/window/seen.test.ts` | `src/claude/terminal.ts`; `test/claude/terminal.test.ts`; `docs/design-step-2.md` (10.3, 12.4) |
| 52 | `src/window/attention.ts`, `src/window/notify.ts`, `test/window/attention.test.ts`, `test/window/notify.test.ts` | `docs/design-step-2.md` (10.3, 12.4, 13) |
| 55 | `web/attention-text.js`, `web/notify.js`, `web/attention.css`, `test/web/attention-text.test.ts`, `test-page/attention.test.ts`, `test-page/helpers/notification.ts` | `web/list-text.js`, `web/list.js`, `web/list.css`, `web/app.js`, `web/keys.js`, `web/help.js`, `web/index.html`; `test/web/keys.test.ts`, `test/web/list.test.ts`, `test-page/shell.test.ts`, `test-page/terminal.test.ts`, `test-page/helpers/browser.ts`; `docs/design-step-2.md` (12.2, 12.4, 13, 17.4) |
| 54 | `test/window/attention-server.test.ts`, `test/window/pages-attention.test.ts`, `test-page/attention-server.test.ts` | `src/window/tick.ts`, `src/window/server.ts`, `src/window/pages.ts`; `test/window/tick.test.ts`, `test/helpers/pages.ts`; `docs/design-step-2.md` (8.2.7) |
| 56 | — | `docs/install.md` (all but task 50's paragraphs), `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (19, and any decision of 1d still missing) |

**Shared source files** (changed by another stage too; never two stage B tasks of one wave):
`src/store/types.ts` (50; C 70), `src/window/protocol.ts` and `src/window/view/build.ts` (51; D
34, C, E), `web/app.js`, `web/keys.js`, `web/help.js`, `web/index.html` (55; D 37, C 75, E),
`web/list.js`, `web/list-text.js`, `web/list.css` (55; D 34, C, E), `src/window/tick.ts` and
`src/window/server.ts` (54; D 36, C 74), `src/window/pages.ts` (54; no other stage known to this
author). `docs/design-step-2.md`: each task writes after the paragraph its task names (B10 of
review B), so that two tasks of one wave never append at the same place. `docs/install.md`: 50
("Updating", in wave 1) and 56; `docs/manual-checks.md`, `README.md`: 56 only.

**The order across stages** (ruled) for the files that tasks of several stages change at the same
lines. A later task is built in parallel and merges `origin/main` once the earlier one landed,
resolving the places named:

| Files | Order | What the later task resolves |
|---|---|---|
| `test/window/view/build.test.ts` (the case that pins the view's files and imports), S2 8.2.3's `list` row | D 34 → B 51 → C 73 | B 51: the file list keeps `chip.ts` and adds `attention.ts`; the allowed imports keep `windowChip` and `CHIP_ORDER` and add `./attention.ts`; the `list` row keeps D's fields and adds `needYou` after `counts`. C 73 adds its `banner.ts` to the same lines |
| `src/store/types.ts`, `KvKey` after `window_launching` | B 50 → C 70 | C 70 inserts after `attention_seq` (S2 10.2's order) |
| `web/app.js` (the import block, `received()`'s `case 'list'`), `web/index.html` (the style-sheet links after `cards.css`), `test/web/keys.test.ts` (the "every later key" case) | D 37 → B 55 → C 75 → E | B 55: its imports after D's, the window title in `case 'list'` beside D's dialog update, `attention.css` after `edit.css`; the "every later key" case keeps only Ctrl+Shift+P |
| `src/window/server.ts` (`listFor`, the orderly stop), `src/window/tick.ts`, `test/window/tick.test.ts` | D 36 → B 54 → C 74 | B 54: `listFor` passes `attention` beside D's lines; `seen.stop()` in the stop block after D's background fetches; `TickDeps.attention` and the look in `run()` beside `reloadNow`; cases at the end after D's |
| `docs/install.md`, `docs/manual-checks.md`, `README.md` | B 50 ("Updating" only) first; then D 39 → B 56 → C 79 → E | B 56: "Using the window", the known limits, "Updating while the window runs", the new part at the end of `manual-checks.md` and the window's paragraph of `README.md`, each after D's |

Where a rebase keeps both without thought (different lines): `web/keys.js` (B: the window chords'
type and `case 'j'`; D: the list keys), `web/help.js` (B: the Ctrl+Shift+J line; D: the list
keys' lines), `test-page/shell.test.ts` (B: Ctrl+Shift+J's lines; D: the six list keys' lines of
the same case), `test/helpers/pages.ts` (B: `needYou` right after `counts`; D: `openedNs` in the
terminals), `src/window/protocol.ts` (B's `AttentionPayload` and `NotifyMessage` beside
`ListMessage` and `ByeMessage`, `needYou` right after `counts`; D's `ChipPayload` beside
`RowPayload`).

**What each task does to a shared test file**, so that stages C and D can be scheduled around it:

| Test file | Task | What it does |
|---|---|---|
| `test/store/store.test.ts` | 50 | the migration count becomes 2; the table list of a new database gains `attention`; the schema version's literals (the title at line 152, `'1'` at 163 and 232, and the one `'2'` that means "newer than this build", which becomes `SCHEMA_VERSION + 1`); new cases at the end |
| `test/window/protocol.test.ts` | 51 | the `LIST` fixture gains `needYou: { count: 0, order: [] }`; the case "an object of each ServerMessage type" gains a `NotifyMessage`; nothing else (D 34 changes the same file's `ROW`) |
| `test/window/view/build.test.ts` | 51 | new cases at the end; the case that pins the view's files and imports gains `attention.ts` in its file list and `./attention.ts` among the allowed imports (D 34 adds `chip.ts` and `CHIP_ORDER` there: keep both) |
| `test/helpers/pages.ts` | 51, 54 | 51: `defaultList` gains `needYou: { count: 0, order: [] }` (D 34 adds `openedNs` in the same object); 54: `startPages` takes an optional `seen` and passes it on |
| `test/web/keys.test.ts` | 55 | Ctrl+Shift+J's two rows give `next-attention` instead of `later` B; the "every later key" case (after D 37 only Ctrl+Shift+P and J) keeps only Ctrl+Shift+P |
| `test/web/list.test.ts` | 55 | new cases at the end (D 34 changes the chip's cases) |
| `test-page/shell.test.ts` | 55 | in the keys case, the two lines of Ctrl+Shift+J's `comes in a later stage` become `no session needs you` (D 37 changes the lines of the six list keys of the same case) |
| `test-page/helpers/browser.ts` | 55 | a context helper `newContext(chromium, options?)` that adds B17's init script; `newPage` makes its context with it |
| `test-page/terminal.test.ts` | 55 | its two contexts of its own (lines 1243 and 1415) are made with `newContext` |
| `test/window/tick.test.ts` | 54 | new cases at the end (D 36 adds `reloadNow`'s) |

**Not changed by stage B** although the type changes reach them: `test-page/helpers/shell.ts`
(`scriptedList` and the worlds build plain records, and the page reads a missing `needYou` as
none), `test-page/cards.test.ts`, `test-page/real-modules.test.ts`, `test/web/pane.test.ts`,
`test/window/view/sections.test.ts` (their rows' `attention: null` still type-checks), and
`test-page/fixtures/minimal-help.js` (the shell's pinned stage A help; no case compares it with
`keys.js`). No existing case on `main` makes a stand-in end a turn or wait under a running server
(`rg -l '/idle|/waiting' test test-page` gives only the registry's and the stand-in's own tests,
which run no attention); should `npm run check` name one in task 54, it pins stage B's text.

Stage B never edits `src/window/view/sections.ts`, `src/window/actions.ts`, `src/window/selected.ts`
or `web/cards.js` (stage D's): attention is added in `build.ts` over `rowPayload`'s result, and the
header is left as it is (B18).

### 1d. Decisions this plan makes where the design is silent

Binding for the implementer, as stage A's A1–A38. The last column names the task that records the
decision in the design in its own pull request; `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| B1 | Migration 2 is S2 10.2's SQL character for character, pinned by a test as migration 1 is pinned to design 9.2. It only adds a table. | Readers of schema 1 (stage A's server until its next write, an old interactive list) keep reading correctly (1b). | — |
| B2 | The counter: each value is one more than the larger of `kv` `attention_seq` (a value that is not a canonical decimal whole number counts as 0) and every `*_seq` of `attention`; `attention_seq` is left at the last value given. | A damaged or deleted counter must never make a later observation look earlier than a `seen`. | 50 (10.2) |
| B3 | One write (`recordAttention`) is one transaction; inside it each session's observations take their values in the order turn end, window end, seen. | S2 10.3: a turn that ends in front of the user is never "finished" — its seen must be later. | — |
| B4 | The look keeps a baseline per pid: the last file read whole, parsed and trusted (`isLiveFileTrusted`). A file not read at a look (rewritten, unreadable, untrusted, or `/proc` cannot be read) keeps its baseline; a baseline is dropped when its pid is gone: `/proc` says it has no process, or a process with another start (a pid taken by another program, whose baseline would otherwise keep a dead holder's `waiting`). The statuses the view reads are the baselines', so a file being rewritten does not make a mark blink. | S2 10.3: "a look that cannot read a file keeps the last status seen"; the baselines must not grow for ever. | 53 (10.3) |
| B5 | A session with several holders (a duplicate) has one status: `waiting` when any holder waits, else `busy` when any is busy, else `idle` when any is idle, else the first one's. | S2 12.4 speaks of "a holder's live-session file". | 51 (12.4) |
| B6 | "Finished" needs a holder whose status is `idle`; a session `running` without a readable file is not finished. Ctrl+Shift+J's order: those that ask by their status time (unknown last), then those that ended by `window_end_seq`, then those that finished by `turn_ended_seq`; ties by session id. | S2 12.4: "the session is running and idle"; the longest-waiting and oldest first. | 51 (12.4) |
| B7 | `list` gains `needYou: { count, order }`: `count` the listed rows that need you, whatever the filter (the title bar's count and `(n) skydeck`); `order` the ids of the rows this page shows that need you, in B6's order. A row that needs you is counted there and in none of `counts`. | The page decides no rule (S2 4.3); the title bar's parts add up, as S2 12.1's example does (3 + 3 + 2). | 51 (8.2.3, 12.1) |
| B8 | `notify` carries `reason` as the kind (`asks`, `ended`, `finished`) and `detail` (the waiting detail, else null); the page writes the words. | As the list's words are the page's (stage A, A18); S2 8.2.3 names no detail. | 51 (8.2.3) |
| B9 | Seen is held per page from the moment that page is focused with that session selected; any change of either starts the 1.5 s again (a window that comes back to the front sees after 1.5 s too). Typing into a terminal makes the session that terminal shows seen at once; typing is an `input` that is not `binary` and holds more than focus reports (`ESC [ I`, `ESC [ O`) and SGR mouse reports (`ESC [ < … M` or `m`): `isTyping` (2.5) — a program that asks for focus reports (Claude Code does, S2 9.2) gets one at every click, chord and return to the window, and none of them is typing. A `seen` is written only when a hold completes or a typing comes and it clears a mark, and always in the write of a turn end or window end of that session while the hold lasts; there is no periodic `seen` write (ruled). It is written only for a session among the rows (`rows()`), so that a selection naming no session leaves no row. | S2 12.4 fixes the 1.5 s but not when the hold starts; a `seen` matters only when it clears a mark or goes with an end. Question 4 in section 7. | 53 (12.4) |
| B10 | A window end is judged at each refresh after it was settled, for a terminal in state `ended` or `lost` (a keeper that died: its exit time is the server's clock) that started its program: recorded when its session's row is not running and marked `ended-unexpectedly`, not recorded when the row runs again or ended deliberately; judged once. It is the same end when the stored `window_end_ns` equals the exit's time, so a server restart, which finds a lingering keeper again, never marks it twice. At the first start of a stage B server the table is empty, so each lingering keeper of an ended-unexpectedly session gets `ended` once (no notification, B12; one sentence in `docs/install.md`, task 56). | S2 12.4 reason 2 says "at the next refresh"; S2 14: a keeper that dies makes its session need you; a restart for an update must not bring back what the user saw. | 52 (12.4) |
| B11 | A write the store refuses (busy, S2 14) is kept; the next look tries the kept writes again first, in their order, each as an entry of its own (`recordAttention` takes the writes in order), then its own; nothing is folded but two turn ends of one session (the later is kept). The baselines move on, so a turn end is neither lost nor recorded twice. A store migrated under the server stops it (S2 10.1). | A turn end is seen once, at one look; folding a kept `seen` into a later turn end of the same session would make that turn seen (B3's order) although the user had left. | 52 (10.3) |
| B12 | The server judges "starts to need you" over the rows a page without a filter lists (it builds that list with `buildListMessage`). The first judgement, which records without notifying, is the first check made once a refresh has worked and the marks have been read (`Attention.ready()`, `NotifierDeps.ready`), not simply the first call: a start whose first refresh fails must not notify everything that already needed you at the next one. A session whose reason changes does not start to need you. `Pages.notify` sends only while no page has focus, to the page that had it last. | S2 13; a restart must not notify everything that already needed you. | 52 (13) |
| B13 | The page's words: a row that needs you has the reason on its second line — `needs you · <detail> · 3m` (`needs you · 3m` without a detail), `finished · not seen · 2m`, `ended unexpectedly · not seen · 2m` — also a row that is not running (an ended one), which then has two lines; the title bar starts with the count, whose text is `3 need you` (the dot before it is drawn by the style sheet on the count's element, in the rows' attention colour, not a character; ruled); the window title is `(3) skydeck`, and `skydeck` when none; a notification's body is `asks: <detail>` (`asks`), `finished`, `ended unexpectedly`. The detail is the live file's `waitingFor`, sanitised and cut to 120 UTF-16 units with `…` (never inside a surrogate pair) by the view model (ruled). | S2 12.2's and 13's examples; S2 12.4: "the reason on its second line"; a `waitingFor` has no length limit. Question 2 in section 7. | 51 (the cut, 12.4), 55 (the words, 12.2, 12.4) |
| B14 | Ctrl+Shift+J selects the next id of `needYou.order` after the selected one, else the first; after the last the first. None: the key bar says `no session needs you`; only the selected one: it stays selected and the key bar says `no other session needs you`. When `needYou.count` is greater than the length of `order`, the key bar also says how many are hidden: `<n> more that need you are hidden by the filter or the fold` (with none shown, `<n> that need you are hidden by the filter or the fold`). While a dialog of stage D is shown (stage D's D2: `app.js` moves the keyboard nowhere and acts on no list key), Ctrl+Shift+J is a window chord like the others: it says `close the edit first (Esc)` and selects nothing. | S2 12.4 "pressed again it goes on"; the title bar's count includes rows the filter or the fold hides; an edit belongs to the session it was opened for. | 55 (12.4) |
| B15 | The page asks for the permission only from a click on `Turn on notifications`, a button in the title bar shown while `Notification` exists and its permission is `default`. A `notify` is shown only with the permission `granted`, never for the session that is selected while the page has focus, with the session's title (sanitised) as title, B13's body and `tag` the session id. A click goes through the gate of a window chord (the one function of `app.js` through which stage D's task 37 passes every chord, D2): it calls `window.focus()` and selects the session through `select(id, 'chord')`; while a dialog is shown it only brings the window to the front, selects nothing, and the key bar says `close the edit first (Esc)` (ruled). | S2 13; a click must not move the keyboard out of a dialog half typed (stage D's review A, its finding 2). | 55 (13) |
| B16 | The page closes a session's notification when that session no longer needs you (the next `list` without its attention; best effort: W11 writes down what Windows does with it); what a notification shows — the session's title and `asks: <detail>` — is the user's to judge for a shared screen (ruled; told to the user). | Not in S2 13; a toast left in Windows' notification centre would hold a title and a detail that are no longer true. | 55 (13) |
| B17 | Every context of the page suite is made by `newContext` of `test-page/helpers/browser.ts` (and `newPage` with it), which installs an inert `Notification` (permission `denied`, `requestPermission` answers `denied` and asks nothing) unless a double is there already: a recording double sets a marker and is installed by the case's own init script, and Playwright does not order a context's and a page's init scripts, so either order ends with the double (ruled on review B). | No test may show a notification or ask for a permission, whatever a server sends. | 55 (17.4) |
| B18 | Stage B leaves the header as it is: attention shows on the row, in the title bar, the window title and the notification. Nothing of stage B changes the header's height or resizes a terminal (the list's rows are not under a terminal). | S2 12.5 names no attention; the header keeps one fixed height for every session (S2 12.5, kept by the lead's ruling on stage D's plan). | — |
| B19 | No hook entry and no settings change: `install`, `uninstall` and `doctor`'s hook check stay as they are, and nobody needs to run `install` again. | S2 10.3 decided against turn hooks. | — |
| B20 | Several windows (S2 8.2.7): the marks, the counts and the window title are the same in every window (the facts are the server's); `needYou.order` follows each window's own filter; a session seen in any focused window is seen for all; a notification goes to one window (B12). | S2 12.4 and 13 say it for one window and for the notification only. | 54 (8.2.7) |

## 2. Contracts

Every name below must exist with exactly this signature; stage A's contracts hold where these do
not change them. Comments state what the other side relies on.

### 2.1 Conventions

- Stage A's 2.1 holds: the import rules, only `src/platform/real.ts` reads `/proc` or the clock,
  foreign input is parsed by validators that never throw, times in messages are nanoseconds as
  decimal strings.
- `src/window/view/attention.ts` imports what the rest of `src/window/view/` may: types of
  `sessions`, `text`'s `sanitize`, the window's message types. It does not import the store's
  types: its `AttentionMarks` has the same fields as the store's `AttentionRow`, and the server
  passes those rows as they are.
- Every text a user or a program wrote — a title, a label, a `waitingFor`, what a notification
  shows — reaches the DOM through `textContent` or the Notification API's strings, never as markup.
  Logs carry kinds and counts only: never a title, a detail, a session's text.

### 2.2 The store (task 50)

```ts
// src/store/types.ts
/** S2 10.2: one row of `attention`. */
export interface AttentionRow {
  sessionId: string;
  turnEndedSeq: number | null;
  turnEndedNs: Ns | null;
  seenSeq: number | null;
  windowEndSeq: number | null;
  windowEndNs: Ns | null;
}
/** One session's part of a write (B3): at least one of the three. */
export interface AttentionWrite {
  sessionId: string;
  /** A turn end: turn_ended_seq = the next value, turn_ended_ns = this. */
  turnEndedNs?: Ns;
  /** A window end judged ended-unexpectedly (B10): window_end_seq = the next value, window_end_ns = this. */
  windowEndNs?: Ns;
  /** seen_seq = the next value, after this write's other values for the session. */
  seen?: true;
}
// KvKey gains: | 'attention_seq' // S2 10.2's counter, decimal

// src/store/store.ts — Store gains
/** Every attention row, ordered by session id. */
attention(): AttentionRow[];
/** S2 10.2 in ONE transaction (the guarded connection refuses it whole: StoreNewerError): for each
 *  write in order, each observation takes the next value (B2) in B3's order; a row is created when
 *  absent and never removed. Returns the rows it wrote, as stored. An empty list writes nothing; a
 *  write with no observation is a RangeError and nothing is written. */
recordAttention(writes: readonly AttentionWrite[]): AttentionRow[];
```

```ts
// test/helpers/schema1.ts (task 50)
/** A database at `path` exactly as step 1 and stage A leave one: journal mode WAL, file mode 600,
 *  MIGRATIONS[0] alone, kv schema_version '1', a row in every table of migration 1 — events of two
 *  sessions, a link, session_meta with a label, a group, a note and a done time, a transcript, a
 *  pull request attached to one session and detached from another — the kv entries `install`
 *  leaves (settings_hash, settings_backup, first_run_offered) and stage A's (window_secret,
 *  window_server, window_runtime_dir, window_alarm, window_launching, a resume lock,
 *  first_scan_done). Written with node:sqlite directly: openStore would migrate it. */
export function schema1Database(path: string): void;
/** sqlite_master's entries (type, name, sql) and every table's rows in a fixed order. */
export function dumpDatabase(path: string): { schema: { type: string; name: string; sql: string | null }[]; tables: Record<string, Record<string, unknown>[]> };
```

### 2.3 Messages: `src/window/protocol.ts` (task 51)

```ts
// Stage B's additions; stage A's types stay as they are but where shown.
export type AttentionReason = 'asks' | 'ended' | 'finished';
// Placement (so that rebases onto stage D stay clean): the two types beside ListMessage and
// ByeMessage, not in front of RowPayload (where stage D's ChipPayload goes); `needYou` right after
// `counts` in ListMessage, in build.ts's return, in defaultList and in protocol.test.ts's LIST.
/** S2 12.4: why a row needs you. `detail`: for `asks` the live file's waitingFor, sanitised and cut
 *  to 120 UTF-16 units with `…` (B13; null without one); else null. `sinceNs`: asks — the file's
 *  statusUpdatedAt, else updatedAt; ended — window_end_ns; finished — turn_ended_ns; null when not
 *  known. Display only (S2 10.2). */
export interface AttentionPayload { reason: AttentionReason; detail: string | null; sinceNs: NsText | null }
// RowPayload.attention: AttentionPayload | null    (stage A: null)
// ListMessage gains   needYou: { count: number; order: string[] }   (B7), right after `counts`
/** S2 13, B8: sent to one page; `title` is the row's title (sanitised); `detail` as the row's. */
export interface NotifyMessage { t: 'notify'; sessionId: string; title: string; reason: AttentionReason; detail: string | null }
// ServerMessage gains NotifyMessage.
```

### 2.4 The view model: `src/window/view/attention.ts` (task 51)

```ts
/** What the store holds of a session (S2 10.2): the fields of the store's AttentionRow. */
export interface AttentionMarks { turnEndedSeq: number | null; turnEndedNs: Ns | null; seenSeq: number | null; windowEndSeq: number | null; windowEndNs: Ns | null }
/** A session's status at the server's last look (B4, B5). */
export interface LiveStatus { status: string | null; waitingFor: string | null; sinceNs: Ns | null }
export interface AttentionFacts { marks: ReadonlyMap<string, AttentionMarks>; live: ReadonlyMap<string, LiveStatus> }
export const NO_ATTENTION: AttentionFacts;
/** B5: one status per session from its holders' baselines. */
export function liveStatuses(files: Iterable<{ sessionId: string; status: string | null; waitingFor: string | null; sinceNs: Ns | null }>): Map<string, LiveStatus>;
/** S2 12.4's reasons in their order, null when the row needs nothing ("running": the row's state
 *  is not `not-running`; the LiveStatus is the session's in `facts.live`):
 *  asks — the row is running and its LiveStatus is `waiting` (detail: its waitingFor, cut, B13);
 *  ended — windowEndSeq is not null and greater than seenSeq (or seenSeq is null), running or not;
 *  finished — turnEndedSeq is greater than seenSeq (or seenSeq is null), the row is running and its
 *  LiveStatus is `idle` (B6). */
export function attentionOf(row: ListRow, facts: AttentionFacts): AttentionPayload | null;
/** B6's order of rows that need you, by id. */
export function attentionOrder(entries: readonly { id: string; attention: AttentionPayload }[], facts: AttentionFacts): string[];
/** S2 13, B12: the ids of `after` that are not in `before`, in `after`'s order. */
export function startsToNeed(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): string[];

// src/window/view/build.ts — ViewInput gains
//   attention?: AttentionFacts    (absent: NO_ATTENTION, so stage A's and D's cases stay as they are)
// buildListMessage: a row's `attention` is attentionOf(row, facts) (rowPayload keeps its null);
// `needYou` as B7.
```

### 2.5 The turn-end rule and seen (task 53)

```ts
// src/claude/terminal.ts — added (S2 4.3: "the meaning of a live-file status change for a turn end")
/** A live-session file as a look takes it: read whole, parsed and trusted (S2 10.3). `sinceNs`:
 *  its statusUpdatedAt, else updatedAt. */
export interface LookedFile { pid: number; procStart: number; sessionId: string; status: string | null; waitingFor: string | null; sinceNs: Ns | null }
/** S2 10.3: the same pid, process start and session, and the status went from `busy` or
 *  `waiting` to `idle`. `busy` → `waiting` is not; another session (/clear) or another process
 *  start is not (it starts over). */
export function isTurnEnd(before: LookedFile, after: LookedFile): boolean;
/** One look (S2 10.3, B4). `files`: those read at this look; `gone`: the baselines' pids that /proc
 *  says have no process, or a process with another start than the baseline's (the caller judges).
 *  A pid with no file keeps its baseline unless it is gone; a file is the new baseline of
 *  its pid; `first` (the server's first look) sets baselines only. `ends`: the turn ends of this
 *  look, with the file's `sinceNs` (null: the caller uses its clock, "the time it saw the change"). */
export function lookAt(baselines: ReadonlyMap<number, LookedFile>, files: readonly LookedFile[], gone: ReadonlySet<number>, first: boolean): { baselines: Map<number, LookedFile>; ends: { pid: number; sessionId: string; atNs: Ns | null }[] };
```

```ts
// src/window/seen.ts — S2 12.4 "seen", the condition that holds; B9
export const SEEN_AFTER_MS = 1500;
/** B9: whether an `input` message is typing: not `binary`, and something is left once every focus
 *  report (`ESC [ I`, `ESC [ O`) and every SGR mouse report (`ESC [ <` digits and `;` then `M` or
 *  `m`) is taken out. Pure. */
export function isTyping(data: string, binary: boolean): boolean;
export interface Seen {
  /** A page's focus and selection now (its `start`: selected null; its `focus`). A change of
   *  either starts the page's 1.5 s again (Clock.after: a timer, which no wall-clock step moves). */
  focus(page: object, focused: boolean, selected: string | null): void;
  /** Typing (isTyping; pages.ts calls it for no other input) into a terminal that shows
   *  `sessionId`: seen at once — held, when it is the page's selection and the page has focus;
   *  else once, in the next take(). */
  typed(page: object, sessionId: string): void;
  gone(page: object): void;
  /** The sessions being seen now: held by a focused page for 1.5 s or since a typing, and those
   *  typed into since the last call (given once). */
  take(): Set<string>;
  /** A session began to be seen (a hold completed, a typing). Listeners must not throw. */
  onChange(listener: () => void): () => void;
  /** Every timer stopped (the server's stop). */
  stop(): void;
}
export function createSeen(clock: Clock): Seen;
```

### 2.6 Attention on the server (task 52)

```ts
// src/window/attention.ts
export interface AttentionDeps {
  /** The server's guarded connection; files, proc, clock and places.claudeHome. */
  deck: Deck;
  hub: Pick<TerminalHub, 'list'>;
  seen: Pick<Seen, 'take'>;
  /** The rows of the last reload (the tick's). */
  rows: () => readonly ListRow[];
  log: (line: string) => void;
  /** S2 10.1: the store was migrated under the server; told once, after which the module does
   *  nothing more. */
  storeNewer: (reason: string) => void;
}
export interface Attention {
  /** The one-second look (S2 10.3): readLiveFiles, trust, lookAt, then one recordAttention with the
   *  writes kept from a refused one first, in their order (B11), and this look's turn ends and B9's
   *  seen writes (only for ids among rows(); none periodic). The marks are read from the store at
   *  the first look that can (only the server writes them). True when the facts changed. Never
   *  throws: a busy store keeps the writes (B11) and logs its kind once until a write works again. */
  look(): boolean;
  /** After a refresh that worked: B10's window ends, with the seen of a session being seen in the
   *  same write. True when the facts changed. Never throws, as look. */
  refreshed(): boolean;
  /** A session began to be seen (Seen.onChange): only B9's seen writes, now. As look. */
  seenNow(): boolean;
  /** B12: true once the marks have been read and a refresh has worked (refreshed() was called). */
  ready(): boolean;
  facts(): AttentionFacts;
}
export function createAttention(deps: AttentionDeps): Attention;

// src/window/notify.ts — S2 13, B12
export interface NotifierDeps {
  /** The sessions that need you now, with their title: those a page without a filter lists. */
  needs: () => ReadonlyMap<string, { title: string; attention: AttentionPayload }>;
  /** Attention.ready: until it is true, check() judges nothing. */
  ready: () => boolean;
  /** Pages.notify; whether a page got it. */
  send: (message: NotifyMessage) => boolean;
}
/** check(): one judgement. The first check made while ready() is true records and sends nothing
 *  (B12); a check before it does nothing at all. Never throws (a failure is logged by kind by the
 *  caller's wrapper). */
export function createNotifier(deps: NotifierDeps): { check(): void };
```

### 2.7 The server assembly (task 54)

```ts
// src/window/tick.ts — TickDeps gains (optional: stage A's and D's cases need no change)
  /** Every second, before the keep-alive: look(); every refresh that worked: refreshed(), after
   *  the mapping. When either says true the pages' lists are pushed. */
  attention?: Pick<Attention, 'look' | 'refreshed'>;

// src/window/pages.ts — PagesDeps gains
  /** S2 12.4: told each page's focus and selection, its typing (an `input` for which isTyping is
   *  true: never a focus or mouse report) and its end. */
  seen?: Pick<Seen, 'focus' | 'typed' | 'gone'>;
// Pages gains
  /** S2 13: while no page has focus, `message` to the page that had focus last; false when it was
   *  not sent (a page has focus, or none is open). */
  notify(message: NotifyMessage): boolean;
```

`src/window/server.ts` creates `createSeen(clock)` and `createAttention(…)` before the tick, gives
the tick `attention` (each call followed by the notifier's `check()`), the notifier `ready:
() => attention.ready()`, the pages `seen`, `listFor`
`attention: attention.facts()`, `seen.onChange` → `seenNow()`, then `pushList()` and `check()`
when it changed; the notifier's `needs` is `buildListMessage` over the tick's rows, the hub's
terminals and `elsewhere`, with the view `{ filter: '', unfolded: ['earlier'], showDone: false,
selected: null }`; the server's stop calls `seen.stop()`.

### 2.8 The page's modules (task 55): additions to stage A's contract 2.9

```js
// web/attention-text.js — pure, no DOM (node:test and the root tsc load it)
/** B13: the second line of a row that needs you, or null when `attention` is null. */
export function attentionLine(attention, nowNs) {}
/** `3 need you`, or null for 0 (B13: the text only; the dot is the style sheet's). */
export function needYouText(count) {}
/** `(3) skydeck`, or `skydeck` for 0. */
export function windowTitle(count) {}
/** B13: { title, body } of a NotifyMessage, both sanitised. */
export function notificationText(message) {}
/** B14: { id, say } — the session to select (or null) and the key bar's line (or null); `count`
 *  is `needYou.count`, for the rows the filter or the fold hides. */
export function nextNeeding(order, selected, count) {}

// web/notify.js — the Notification API, through globalThis.Notification read at each use
/** @param {HTMLButtonElement} item  #notify-on (index.html's title bar)
 *  @param {{ select(id: string): void }} deps */
export function createNotifications(item, deps) {}
// deps.select is app.js's gate of a window chord (B15), not `select` itself.
// → { show(message: NotifyMessage, page: { focused: boolean, selected: string | null }): void,
//     update(list: ListMessage): void,  // B16: closes the notification of each session shown that
//                                       // no longer needs you; and the item, as refresh
//     refresh(): void }   // refresh: the item shown exactly while the permission is `default`

// web/keys.js — windowChord: Ctrl+Shift+J gives { kind: 'next-attention' }. WindowChord's `later`
// is 'B' | 'E' on main and becomes 'E' only; ListAction's `later` ('D') is stage D's (task 37).
```

`web/app.js` (task 55, on top of stage D's task 37): `document.title` from
`windowTitle(list.needYou.count)` and `notifications.update(list)` at each list; the chord
`next-attention` through `nextNeeding` and `select(id, 'chord')`; a `notify` message to
`createNotifications(…).show` with `document.hasFocus()` and the selection; the notification's
click through the same gate as a window chord (D2's: while a dialog is shown, `close the edit
first (Esc)` and nothing else; B15). `web/list.js` sets `data-attention="<reason>"` on a row
element that needs you (the coloured left bar and the bold title are `web/list.css`'s) and writes
`needYouText` first into `#counts`, on an element with `data-state="need-you"` whose dot
`web/list.css` draws.
`web/list-text.js`'s `rowText` gives `attentionLine` as `stateLine` when the row needs you (and
then two lines). The page reads `needYou` and `attention` as absent when a list lacks them (a
scripted list of stage A's helpers): no count, no mark.

## 3. Tasks

### Task 50: Migration 2 and the store's attention

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 10.2, 4.4 (`src/store/`, B), 16.5; design 9.2 · **Contracts:** 2.2 · **Decisions:** B1, B2, B3 · **Shared files:** `src/store/types.ts` (a `KvKey` line and two types), `docs/install.md` ("Updating"). Order (1c): B 50 before C 70 (its `KvKey` goes after `attention_seq`) and before D 39 and B 56 (`docs/install.md`): this task resolves nothing; stage D adds no migration and no key.

**Goal.** The store at schema 2, its attention rows read and written by the server's rules, and
the proof that a database in use since step 1 migrates without loss (section 1b).

**Files**
- Modify: `src/store/migrations.ts` (migration 2), `src/store/store.ts` (`attention`,
  `recordAttention`), `src/store/types.ts`, `docs/design-step-2.md` 10.2 (B2, after the paragraph
  "**Order is a counter, not a clock.**"; the SQL block stays as it is), `docs/install.md`
  ("Updating", and the last paragraph of "Updating while the window runs"; F5 of review A)
- Create: `test/helpers/schema1.ts`, `test/store/migration-2.test.ts`
- Test: `test/store/store.test.ts` (the migration count, the table list of a new database, the
  schema version's literals at lines 152, 163 and 232, the attention methods; every place that
  means "newer than this build" uses `SCHEMA_VERSION + 1`: `rg -n "schema_version" test` lists
  them)

**Behaviour.** Writes go through `#run` / `#runReturning` and reads through `#all` / `#get`, so
that the guard and `prepareRead` hold (stage A's contract 2.6, `openStore`); the counter's value is computed inside the
same transaction (B2). Integer `*_seq` columns are numbers, `*_ns` bigints (design 9.2).

**`docs/install.md` (ruled: migration 2 reaches the user at the first `git pull` after this task
is merged).** "Updating": with the window in use, the order that is certain — close the skydeck
window, then `git pull`, then `skydeck window` (the sessions live in their keepers and keep
running; `skydeck doctor` after it if wanted) — and that from this update on a checkout from
before it refuses the database (`the database … was written by a newer skydeck …`), so the way
back is forward. "Updating while the window runs", its last paragraph (a command of the new code
upgrades the database under the old server): for an update that upgrades the database, the order
of "Updating". The task runs no `skydeck` command: the refusal's line is held by
`test/store/store.test.ts` ("a database written by a newer skydeck is refused"), `skydeck window`'s
behaviour by stage A's `test/cli/commands/window.test.ts`.

**Tests** (platform: none — the store on a sandbox path)
- `MIGRATIONS` has two entries and `SCHEMA_VERSION` is 2; `MIGRATIONS[1]` equals the SQL block
  under "**Migration 2**" of S2 10.2 character for character (read from the design, as migration 1
  is from design.md 9.2).
- `migration-2.test.ts`: `schema1Database`, then `openStore`: `schema_version` `'2'`; the entries
  of sqlite_master of migration 1 and every row of every table of migration 1 are exactly the
  `dumpDatabase` of before; `attention` exists, empty; no kv entry changed but `schema_version`.
  Opening again: the dump equal to the first one after the migration. The same at the server's
  own open (`openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 })` on a deck whose
  database is `schema1Database`'s; review B, B3). A raw `node:sqlite` connection opened on the
  fixture before the migration (as an old interactive list holds one) inserts an event and reads
  the sessions' events after it, and the store then sees that event. A migration while another
  connection holds the write lock waits for it (`test/fixtures/migrate-while-locked.ts`), and one
  that takes longer than the busy timeout fails with nothing changed, the next open migrating.
- `recordAttention`: a turn end, then a seen in a later write → turn < seen; a turn end and a seen
  of one session in one write → seen = turn + 1; a window end and a seen → seen later; values grow
  across writes and sessions; rows are created on the first write and kept; times stored; B2 with
  `attention_seq` deleted, set to `abc` and set lower than a stored seq → the next value is still
  greater than every stored one; an empty list writes nothing (no counter); a write with no
  observation → RangeError, nothing written; on a guarded connection with the store one version
  newer → `StoreNewerError`, nothing written; with another connection holding the lock (a 250 ms
  busy timeout) → a failure for which `isDatabaseFailure` is true, nothing written.

**Done when:** a step 1 / stage A database migrates with nothing lost and nothing changed but the
new table; `attention` and `recordAttention` keep B2 and B3; `npm run check` passes.

**Not in it:** who writes what when (52).

---

### Task 51: Contracts and the view model of attention

**Depends on:** 0 (stage D's task 34 merged in before the last push) · **Wave:** 1 · **Design:** S2 4.3, 8.2.3 (`list`, `notify`), 12.1 (the counts), 12.4 · **Contracts:** 2.3, 2.4 · **Decisions:** B5, B6, B7, B8, B13's cut (update S2 8.2.3, 12.1, 12.4) · **Shared files:** `src/window/protocol.ts`, `src/window/view/build.ts`, `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `test/helpers/pages.ts`. Order (1c): D 34 → B 51 → C 73. Built beside D 34; once 34 is on `main` this task merges `origin/main` and resolves: the pinned view case of `build.test.ts` (keep `chip.ts`, `windowChip`, `CHIP_ORDER`; add `attention.ts`, `./attention.ts`), S2 8.2.3's `list` row (keep D's fields, add `needYou` after `counts`), and where `RowPayload.chip` is D's `ChipPayload`, `PrPayload` has `okAtNs`, the terminals carry `openedNs`, `SelectedPayload` the note's fields, `defaultList` D's additions — B's lines go beside them, placed as 2.3 says.

**Goal.** Fix as code every message and view-model function the other stage B tasks meet at, and
the one rule of S2 4.3 that judges attention.

**Files**
- Create: `src/window/view/attention.ts`, `test/window/view/attention.test.ts`
- Modify: `src/window/protocol.ts` (2.3), `src/window/view/build.ts` (`ViewInput.attention`,
  each row's `attention`, `needYou`, the counts of B7), `test/window/protocol.test.ts` (the `LIST`
  fixture gains `needYou`; `NotifyMessage` in the case "an object of each ServerMessage type"),
  `test/window/view/build.test.ts` (the cases below at the end; the case that pins the view's files
  and imports gains `attention.ts` and the import `./attention.ts`), `test/helpers/pages.ts`
  (`defaultList` gains `needYou: { count: 0, order: [] }` right after `counts`),
  `docs/design-step-2.md`: 8.2.3 (the `list` row gains `needYou`; the `notify` row gains `detail`
  and the kind of `reason`), 12.1 (after the paragraph "The title bar shows the counts…"), 12.4
  (after the numbered list of the three reasons: B5, B6, B13's cut)

**Tests** (platform: none — pure, step 1's builders of `test/helpers/derived.ts`)
- `attentionOf`: asks for a running row whose status is `waiting`, with its sanitised detail (an
  escape sequence and `<img src=x onerror=…>` come back as text without the escape) and its time;
  not for a row that is not running; ended when `windowEndSeq` is greater than `seenSeq` or
  `seenSeq` is null, also for a row that is not running, and not once `seenSeq` is greater;
  finished for a running row, `idle`, `turnEndedSeq` greater; not when `busy`, `waiting` (then it
  asks), without a status, not running, or seen later; the order asks > ended > finished when
  several hold; an equal seq is not greater; a `waitingFor` of 300 characters comes back as 119
  and `…`, one with a surrogate pair across the cut is cut before the pair.
- `liveStatuses`: B5 for two holders (waiting and idle → waiting; busy and idle → busy).
- `attentionOrder`: B6 on a mixed set; an unknown time last; ties by id.
- `startsToNeed`: new ids only, in order; a changed reason is not new; removed ones are not.
- `buildListMessage`: without `attention` every stage A case is unchanged; with it, the rows'
  `attention`, `needYou.count` over every listed row whatever the filter, `needYou.order` only the
  rows shown (a filter or a folded Earlier leaves one out), and a row that needs you counted in
  `needYou.count` and in no field of `counts`.

**Done when:** every rule of S2 12.4 that a page shows is a tested pure function, and the message
types compile for the server and for `tsc -p web`.

**Not in it:** where the facts come from (52, 53); the page (55).

---

### Task 53: The turn-end rule and seen

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 4.3 (`src/claude/terminal.ts`), 10.3, 12.4 (seen) · **Contracts:** 2.5 · **Decisions:** B4, B9 (update S2 10.3, 12.4) · **Shared files:** none.

**Goal.** The two pure-or-timed pieces the server's attention stands on: what a change of a live
file means, and when a session is being seen.

**Files**
- Modify: `src/claude/terminal.ts` (`LookedFile`, `isTurnEnd`, `lookAt`), `docs/design-step-2.md`
  10.3 (B4, after the paragraph "`busy` to `waiting` is not a turn end…"), 12.4 (B9, after the
  paragraph "Seen is a **condition that holds**…")
- Create: `src/window/seen.ts` (`isTyping`, `createSeen`), `test/window/seen.test.ts`
- Test: `test/claude/terminal.test.ts`

**Tests** (platform: none for `terminal.ts`; `testPlatform`'s fake clock for `seen.ts`)
- `isTurnEnd`: `busy`→`idle` and `waiting`→`idle` are; `busy`→`waiting`, `idle`→`idle`,
  `idle`→`busy`, `shell`→`idle`, a null status, another session and another process start are not.
- `lookAt`: the first look gives baselines and no end; a second look with `busy` then `idle` gives
  one end with the file's time; a pid missing at a look keeps its baseline, and `idle` at the look
  after is still an end; a pid in `gone` is dropped; a file naming another session, or the same pid
  with another process start, starts over; a pid seen for the first time at a later look gives no
  end.
- `isTyping` (F1 of review A): `a`, `\r`, a bracketed paste, text after a focus report → true; `ESC [ I`,
  `ESC [ O`, `ESC [ < 0 ; 10 ; 5 M`, `ESC [ < 0 ; 10 ; 5 m`, several of them in one message, the
  empty string, and anything `binary` → false.
- `seen.ts`: focused with S selected → S in `take()` from 1,500 ms on, not at 1,499; unfocused
  first, or the selection changed at 1,000 ms → the 1.5 s starts again; focus lost → S out at once;
  `typed` for the selected session of a focused page → in `take()` at once and held; `typed` for
  another session → in the next `take()` only; two pages → the union; `gone` and `stop` → nothing
  more, no timer left; `onChange` once per completed hold and per typing.

**Done when:** S2 10.3's rule and S2 12.4's condition are code with their edge cases tested;
`npm run check` passes.

**Not in it:** reading files, the store, the pages (52, 54).

---

### Task 52: Attention on the server — the look, the writes, the notifier

**Depends on:** 50, 51, 53 · **Wave:** 2 · **Design:** S2 10.1 (the one-second look), 10.2, 10.3, 12.4 (reason 2, seen's writes), 13 (when), 14 (a busy store), 17.3 ("turn ends and attention with a fake clock and live files the test writes") · **Contracts:** 2.6 · **Decisions:** B10, B11, B12 (update S2 12.4, 10.3, 13) · **Shared files:** none.

**Goal.** Everything the server decides about attention, as two modules with fake-clock tests:
turn ends recorded once, seen written by B9, window ends by B10, the facts for the view, and the
judgement of S2 13.

**Files**
- Create: `src/window/attention.ts`, `src/window/notify.ts`, `test/window/attention.test.ts`,
  `test/window/notify.test.ts`
- Modify: `docs/design-step-2.md` 10.3 (B11, after the paragraph task 53 adds), 12.4 (B10, after
  the paragraph task 51 adds after the three reasons), 13 (B12, after its first bullet)

**Behaviour.** `look()`: `readLiveFiles` of `claudeHome`; each file trusted by `isLiveFileTrusted`
becomes a `LookedFile` (one that throws is not read at this look); `gone`, for the baselines' pids
without a file: `Proc.stat` null, or a process start other than the baseline's (a throw: not
gone); `lookAt`; one `recordAttention` with the kept writes first, in their order, each as its own
entry, then this look's turn ends (their time, else the clock) and B9's seen writes for the ids of
`seen.take()` that are among `rows()` (B11, B9); the stored rows replace the facts' marks. `refreshed()`: B10 over `hub.list()` and `rows()`; the session a terminal held is
the one it shows, else the one it was opened for (`sessionId ?? expectedSessionId`). Every log line names a kind or a
count, never a session's text. `createNotifier`: `check()` diffs `needs()` with the last
judgement through `startsToNeed` and sends one `NotifyMessage` per new one.

**Tests** (platform: `testPlatform` through `testDeck`; live files written by the test, trusted
through the fake `/proc`, as `test/helpers/session-files.ts`'s `startRunning`)
- A busy file, a look, the same file idle, a look → one row with `turnEndedSeq` and the file's
  status time; `facts().live` says `idle`; the first look of a new module records nothing for a
  file that was idle already.
- While `seen.take()` gives the session, a turn end and its seen are one write (seen = turn + 1);
  a hold that starts on a finished session writes seen at once; a hold over a session without a
  mark writes nothing, at that look and at every later one (no periodic write, ruled); a seen for
  an id that is no row's writes nothing and creates no row (F6).
- A file that cannot be parsed between the busy and the idle look keeps the baseline: the end is
  recorded; a file removed and its pid gone drops the baseline, and so does its pid taken by a
  process with another start (a dead holder's `waiting` does not stay); `/proc` that throws drops
  nothing.
- B11 (with the server's kind of connection: `openDeck(d.platform, { guardSchema: true,
  busyTimeoutMs: 250 })`, as `test/window/tick.test.ts`'s case of a migrated store does): the
  store locked by another connection at the look of a turn end → nothing written, one log line
  with a kind; the next look after the lock is gone writes it once; a second turn end of that
  session meanwhile is folded (the later one stored); a kept `seen` (a hold completed while the
  store was locked), then the user gone and a turn end of that session, then the lock gone →
  `turn_ended_seq` greater than `seen_seq`, so the session is `finished` (F4); the store migrated by
  another connection → `storeNewer` once, nothing written, later calls do nothing.
- B10: a terminal `ended` with an exit, its row not running with `ended-unexpectedly` →
  `windowEndSeq` and the exit's time; a `lost` one (its exit's time is the server's clock) → the
  same; a deliberate end (no mark) → nothing; the row running again → nothing; a second
  `refreshed` → nothing more; a new module over a store that holds that exit's time (a server
  restart) → nothing; a `not-started` terminal → nothing.
- `ready()`: false until the marks are read and `refreshed()` was called; true after.
- The notifier: while `ready()` is false nothing is judged; the first check once it is true sends
  nothing — also when `needs()` was empty before and is full then (review B, B1); a session that
  comes to need you after that → one message with its title, reason and detail; it again at the
  next check → nothing; asks then finished → nothing; gone and back → one.

**Done when:** turn ends, seen and window ends reach the store by S2 10.2, 10.3 and 12.4 with B9–B11,
and the judgement of S2 13 is tested; `npm run check` passes.

**Not in it:** the tick, the pages and the server's wiring (54).

---

### Task 55: The page — marks, the title, Ctrl+Shift+J, notifications

**Depends on:** 51; stage D's task 37 (ruled: 37 merges first, and 55 is written on top of it; while 37 is open, 55 may be built against stage D's plan text of D2, but is not pushed) · **Wave:** 2 · **Design:** S2 12.1 (the title bar, the window title), 12.2 (the second line), 12.4 (the marks, Ctrl+Shift+J), 12.9 (the key help), 13 (the page's side), 17.4 · **Contracts:** 2.8; stage A's 2.9 · **Decisions:** B13, B14, B15, B16, B17 (update S2 12.2, 12.4, 13, 17.4) · **Shared files:** `web/app.js`, `web/keys.js`, `web/help.js`, `web/list.js`, `web/list-text.js`, `web/list.css`, `web/index.html`, `test/web/keys.test.ts`, `test/web/list.test.ts`, `test-page/shell.test.ts`, `test-page/terminal.test.ts`, `test-page/helpers/browser.ts`. Order (1c): D 34 and D 37 → B 55 → C 75. On top of them: `list-text.js`'s chip is D's (`chipText` of a `ChipPayload`); `app.js` holds D's dialog, the toast, the new list keys and the header's call with `list.selected` for every pane — while a dialog is shown it moves the keyboard nowhere and acts on no list key, and its gate of a window chord is what Ctrl+Shift+J (B14) and a notification's click (B15) pass through; `keys.js`'s WindowChord `later` is `'B' | 'E'` and becomes `'E'`; `help.js` lists D's keys; `index.html` has `#editor`, `#toast` and `edit.css` (B's `attention.css` after it); `shell.test.ts`'s case of the six list keys is D's. This task owns the page case of a notification's click while a dialog is shown (F3).

**Goal.** The window shows what S2 12.4 and 13 say, from exactly what the server sends: the marks,
the counts and the window title, Ctrl+Shift+J, and desktop notifications with the permission asked
only on a click.

**Files**
- Create: `web/attention-text.js`, `web/notify.js`, `web/attention.css`,
  `test/web/attention-text.test.ts`, `test-page/attention.test.ts`,
  `test-page/helpers/notification.ts` (`notificationDouble(page, permission)` — an init script
  that sets B17's marker and records each `new Notification` with its strings, each `close()`,
  `requestPermission` calls with `navigator.userActivation.isActive`, and clicks on a recorded
  one; `pageFocus(page, focused)` — `document.hasFocus` answering `focused` and a `focus` or
  `blur` event dispatched)
- Modify: `web/list-text.js`, `web/list.js`, `web/list.css`, `web/app.js`, `web/keys.js`,
  `web/help.js` (`Ctrl+Shift+J`: `the next session that needs you; again goes on`),
  `web/index.html` (`#notify-on` in the title bar, `attention.css` after `edit.css`),
  `test-page/helpers/browser.ts` (`newContext` with B17's inert `Notification`; `newPage` uses
  it), `test-page/terminal.test.ts` (its two contexts of its own, lines 1243 and 1415, through
  `newContext`), `test/web/keys.test.ts`,
  `test/web/list.test.ts` (`rowText` of a row that needs you: B13's line as its `stateLine`, two
  lines for an ended one; a row without attention as before),
  `test-page/shell.test.ts` (Ctrl+Shift+J says `no session needs you` there), `docs/design-step-2.md`:
  12.2 (B13's words, after its first bullet), 12.4 (B14 after the paragraph "Ctrl+Shift+J selects
  the next session…"; B13 after the last paragraph, "A row that needs you…"), 13 (B15 and B16,
  after the bullet "That page shows a desktop notification…"), 17.4 (B17, after the list "In the
  browser suite, besides those")

**Tests** (platform: `realTestPlatform` for the page; a scripted stand-in server through
`standinServer` and `honest`, sending lists with `attention` and `needYou`, and `notify`)
- `attention-text.test.ts` (node): every line and body of B13, with and without a detail, ages as
  `format.js` gives them; a detail with an escape sequence or markup sanitised and kept as text;
  `needYouText` and `windowTitle` for 0, 1 and 3; `nextNeeding` for B14's cases (none, only the
  selected, the selected first, middle, last, not in the order; a count greater than the order,
  with none shown and with some).
- `keys.test.ts`: Ctrl+Shift+J on a US and a Czech layout, both zones → `next-attention`,
  cancelled; WindowChord's `later` only for Ctrl+Shift+P.
- `attention.test.ts` (page): a row that needs you has `data-attention`, a bold title and a left
  bar of another colour than a row that does not (computed style), and its second line; an ended
  row that is not running has two lines; `#counts` starts with `3 need you`, the title is
  `(3) skydeck`, and `skydeck` again with a list without; the count's element has its dot from the
  style sheet (computed `::before`), and its text is `3 need you`; a list without `needYou` (stage
  A's `scriptedList`) shows neither and throws nothing. Ctrl+Shift+J in both zones selects the
  first of `order`, then the next, then the first again, and the page sends `view` and `focus`
  with it; with none the key bar says `no session needs you`; with a count above the order, B14's
  hidden line. Notifications (the double): permission `default` → the button shown, nothing asked
  at load or by any key; a click → one `requestPermission` with user activation; `granted` → the
  button hidden; a `notify` while the page is unfocused → one notification with the title, B13's
  body and the tag; a hostile title and detail arrive as plain strings and add no element; a click
  on it → `window.focus` called and the session selected; a `list` in which that session no longer
  needs you → its notification closed (B16); focused with that session selected → none; `denied` →
  none and no button. With stage D's dialog shown (opened by `l`): Ctrl+Shift+J and a click on a
  notification each say `close the edit first (Esc)`, select nothing and leave the keyboard in the
  dialog's field, the click bringing the window to the front (F3; this task's case). The double
  and the inert `Notification` in either order of their init scripts end with the double (B17); a
  page from `newPage` without the double sees the inert one.

**Done when:** every page-side rule of S2 12.4 and 13 is shown for its case, the help lists
Ctrl+Shift+J as a key that acts, and no page test can show a notification; `npm run check` passes.

**Not in it:** the server's side (52, 54); the header (B18).

---

### Task 54: The server assembly, and attention end to end

**Depends on:** 52, 53, 55; stage D's task 36 (ruled order) · **Wave:** 3 · **Design:** S2 8.2.7 (several windows), 10.1, 10.3, 12.4, 13, 14, 17.3, 17.4 · **Contracts:** 2.7 · **Decisions:** B20 (update S2 8.2.7, after its paragraph) · **Shared files:** `src/window/tick.ts`, `src/window/server.ts`, `src/window/pages.ts`, `test/window/tick.test.ts`, `test/helpers/pages.ts` (`startPages` passes `seen`). Order (1c): D 36 → B 54 → C 74. On top of D 36: `tick.ts` has `reloadNow` and `server.ts` gives the actions `changed`, `fetchPrs` and `refreshPrs`, and its stop waits for their background fetches — B's lines go beside them (`listFor`'s `attention`, `seen.stop()` after D's in the stop), and an edit's `reloadNow` brings the attention facts along through `listFor`.

**Goal.** Wire 52, 53 and 55 into the running server so that a real turn end, a real selection
and a real typing in a real page do what S2 12.4 and 13 say, in every window.

**Files**
- Modify: `src/window/tick.ts`, `src/window/server.ts`, `src/window/pages.ts` (the `seen` calls:
  `start` → `focus(conn, focused, null)`, `focus`, an `input` for which `isTyping` is true →
  `typed` with the session `hub.list()` says the terminal shows, the end of the connection →
  `gone`;
  `notify`), `test/helpers/pages.ts`, `docs/design-step-2.md` 8.2.7
- Create: `test/window/attention-server.test.ts`, `test/window/pages-attention.test.ts`,
  `test-page/attention-server.test.ts`
- Test: `test/window/tick.test.ts` (new cases at the end). No existing case on `main` makes a
  stand-in end a turn or wait under a running server (1c); should `npm run check` name one, it is
  changed to pin stage B's text (B7, B13), never to avoid it, and joins this list in the pull
  request

**Tests** (platform: `realTestPlatform`, through `startTestServer` and `TestPage`, unless marked)
- `tick.test.ts`: `look` every second before the keep-alive, `refreshed` after each refresh that
  worked, the lists pushed when either says true; without `attention` stage A's cases unchanged.
- `pages-attention.test.ts` (`startPages`): the `seen` calls for `start`, `focus`, text input
  — none for binary input, a focus report (`ESC [ I`, `ESC [ O`) or an SGR mouse report (F1) —
  and a closed page; `notify` with no page focused → only the page that
  had focus last; with one focused → none, false; with none open → false.
- `attention-server.test.ts`: a stand-in in a window terminal while a focused page selects another
  session: `/busy`, then `/idle` → within 4 s its row is `finished`, `needYou.count` 1, the store
  holds `turn_ended_seq`; the page selects it, focused → cleared after 1.5 s and within 3 s,
  `seen_seq` greater; unfocused → it stays. Typing into its terminal → cleared at once (no 1.5 s).
  A turn that ends while the page holds it → never `finished` in any list (each list read) and one
  write with seen = turn + 1. `/waiting permission prompt` → `asks` with that detail within 2 s,
  `/busy` → gone. `/fail 3` → `ended` after the next refresh; `/exit` → none; with one terminal
  open, its keeper killed by `killKeepersIn` (A34) → the terminal `lost` and `ended` (F7); a server
  restart while the ended keeper lingers → still one `window_end_seq`, the mark as before. A session the
  test runs outside the window → its turn ends recorded too. Two pages: the second sees the same
  marks; a seen in the first clears them in both; both unfocused, the second focused last → only
  it gets `notify`; one focused → none; what needed you before a server restart → no `notify`
  after it; attention rows the test wrote before the start (a session finished, not seen) and the
  store held by `test/fixtures/hold-write-lock.ts` from the start's delay (`startDelayMs`, A31)
  until after the first tick → once it is released the list shows `finished` and no page gets
  `notify` (review B, B1); a turn that ended while no server ran → no `finished`. The store locked
  at a turn end → recorded once when the lock is gone; a store migrated by another connection →
  `bye`, nothing written. No log line holds a title or a detail (a marker in both).
- `test-page/attention-server.test.ts` (Chromium, `notificationDouble`, `pageFocus`; the page
  built as `launched` builds it, from the parts `test-page/helpers/shell.ts` exports —
  `RECORDER`, `problemsOf`, `startTestServer`, `controlClient` — so that the doubles are in before
  it loads, and `shell.ts` stays out of stage B; review B, B4): a session that finishes while
  another is selected → its row's bar and `finished · not seen`, the title `(1) skydeck`;
  Ctrl+Shift+J selects it; 1.5 s later the mark is gone and the title `skydeck`. The same with a
  stand-in that turned focus reporting on (`/red` with `ESC [ ? 1004 h`, as
  `test-page/terminal.test.ts`'s focus case does): selected by Ctrl+Shift+J, its mark is still
  there after 1 s (the focus report the selection sends is not typing; F1). The page unfocused
  (`pageFocus`) and a turn that ends → one notification `finished` with the session's title; its
  click selects the session.

**Done when:** a page against a real server shows S2 12.4's marks, clears them as S2 12.4 says,
and gets S2 13's notifications, in two windows; `npm run check` passes.

**Not in it:** the documents (56).

---

### Task 56: Documentation of stage B

**Depends on:** all · **Wave:** 4 · **Design:** S2 10.3 (nothing to install), 12.4, 13, 16.5, 18 (W3's title, W11, W19, W21), 19 · **Contracts:** — · **Decisions:** — · **Shared files:** `docs/install.md`, `docs/manual-checks.md`, `README.md`. Order (1c): B 50's "Updating" first; then D 39 → B 56 → C 79. On top of D 39: "Using the window", the known limits, "Updating while the window runs", the end of `manual-checks.md` and the window's paragraph of `README.md` hold D's text — B's goes after it.

**Goal.** A user can use attention and notifications from the documents alone, updates in the
order that is certain, and knows which checks only they can make.

**Files**
- Modify: `docs/install.md` (all but task 50's paragraphs, which it keeps), `docs/manual-checks.md`,
  `README.md`; `docs/design-step-2.md` only where a decision of 1d is still missing from it, and
  S2 19's stage B line naming W3's title

**Content (contract)**
- `docs/install.md`, "Using the window": the three reasons, how a mark goes (seen: selected 1.5 s
  in the focused window, or typed into; asks: when the dialog closes), the title bar and the window
  title, Ctrl+Shift+J (and what the key bar says when the filter or the fold hides one),
  `Turn on notifications` (once; when Edge or the company's policy refuses, the counts and the
  title still show it). "Known limits of stage B": a turn that ends while no server runs is not
  recorded; a notification goes to one window; seen needs the window in front; at the first start
  of a stage B server each terminal that still shows an unexpected end gets `ended` once (B10).
  "Updating while the window runs": task 50's order stays (close the window, `git pull`,
  `skydeck window`); nothing to install again (B19).
- `README.md`: one sentence in the window's paragraph — what needs you, and notifications.
- `docs/manual-checks.md`: a part "The window (step 2, stage B)" with W11, W19 and W21, and W3
  gains the title `(n) skydeck` on its taskbar button. Each says what to set up, what to type, what
  to look at and what to write down, and every step can do no harm to the machine or to the
  user's running sessions (the rules stage A's checks were held to in their review):
  - every **real claude** step uses stage A's throwaway session in `~/skydeck-try` ("A throwaway
    session in the window"), started by the step itself, never a real work session, and names the
    session it acts on — no step presses Enter on whatever is selected;
  - a permission prompt is made by asking for a command that asks and does no harm if allowed
    (`please run: touch skydeck-check.txt` in `~/skydeck-try`), answered **No**; the step says what
    to write down when nothing asks (the user's permission mode allows it); a question by asking
    Claude Code to ask one (`ask me with your question tool whether I prefer tea or coffee, then
    stop`), answered;
  - no step closes a window with other tabs, ends a real `claude`, reads or edits a file under
    `~/.claude`, prints a file's bytes to the terminal, or changes Edge's or Windows' settings;
    allowing notifications is the one permission asked, and the step says that `Block` is a valid
    answer to write down;
  - W11: the permission prompt, a toast, a click that selects the session; what Windows does with a
    toast whose session no longer needs you (the page closes it, B16); with the PC locked while the
    window is in front, whether a turn end gives `finished` and a toast (if Edge still reports
    focus, neither comes in the commonest case of being away); after `Block` the button never comes
    back, and the step names where Edge keeps that choice (the window profile's site permissions
    for notifications), to look at, not to change; the half hour: the window minimised, a second
    throwaway session in a WSL terminal of the user's own (`cd ~/skydeck-try && claude`), given one
    prompt after 30 minutes — its turn end reaches the window without touching it; the step ends
    with `/exit` in that terminal;
  - W19: whether `needs you · <detail>` tells a permission prompt from a question, and whether the
    detail ever holds a command or a path (what a toast would show on a shared screen, B16);
  - W21 also asks for a turn with several tool calls (`list the files here, then count them`) and
    whether `finished` or a notification came before its end (question 6 in section 7).

Every command the new text names is held by a sandboxed test, never run here: `skydeck window`
by stage A's `test/cli/commands/window.test.ts`; the refusal of an older checkout by
`test/store/store.test.ts` ("a database written by a newer skydeck is refused"); `skydeck doctor`
unchanged by `test/cli/commands/doctor.test.ts` and `doctor-window.test.ts`; the window's words
by tasks 54 and 55's tests (`test/web/attention-text.test.ts`, `test-page/attention.test.ts`).

**Steps**
- [ ] Check every line the documents quote against the code and the tests named above.
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can use stage B from `docs/install.md` alone, and W3's title, W11, W19 and
W21 are in `docs/manual-checks.md`.

**Not in it:** code, tests, and running any `skydeck` command (a "clean `SKYDECK_HOME`" is no
sandbox: `show` and others read the real `~/.claude`, an agent's shell has `CLAUDECODE` set, and
`window` would reach port 47613 and the real Edge).

## 4. Design coverage

| Design (S2) | Where |
|---|---|
| 2 (principle 4: no content in logs) | 52, 54 (the marker case) |
| 4.3 (`src/claude/terminal.ts`, `src/window/view/`) | 53, 51 |
| 4.4 (`src/store/`, B) | 50 |
| 8.2.3 (`list`'s attention, `notify`) | 51, 54, 55 |
| 8.2.7 (several windows) | 54 |
| 10.1 (the one-second look; the guard) | 52, 54; 50 (tests) |
| 10.2 (migration 2, the counter) | 50 |
| 10.3 (turn ends; no hook) | 53, 52, 54; B19 |
| 12.1 (the counts, `(n) skydeck`) | 51, 55 |
| 12.2 (the second line) | 55 |
| 12.4 (reasons, seen, marks, Ctrl+Shift+J) | 51, 52, 53, 55, 54 |
| 12.9 (Ctrl+Shift+J, the help) | 55 |
| 13 (notifications) | 52, 54, 55 |
| 14 (a busy store) | 50, 52, 54 |
| 16 (install, doctor: unchanged), 16.5 (updating) | B19; 1b, 50 (`install.md`, "Updating"), 56 |
| 17.3, 17.4 | 52, 53, 54, 55 |
| 18 (W3's title, W11, W19, W21) | 56 |
| 19 (stage B) | this plan |

## 5. What stage B leaves for stages C, D and E

Stage B works without C, D and E and touches their files only where its own lines are. In
`src/window/protocol.ts` it adds `AttentionPayload`, `NotifyMessage` and `ListMessage.needYou` and
leaves `banner`, `stack`, `chips`, the chip and every `act` kind as they are; in `build.ts` it adds
the attention lines beside the rows' payloads, where D changes the chip and C the banner; in
`web/keys.js` it turns only Ctrl+Shift+J from `later` into its action, so Ctrl+Shift+P (E) still
says it comes later; in `web/app.js` it adds the title, the chord and the notifications, which
respect a shown dialog of D (B14, B15); in `tick.ts` it adds the look beside D's `reloadNow`. It
does not touch the header, its height or any terminal's size (B18). Stage E's switcher ranks
"needs you" first through `attentionOf` and `attentionOrder` of `src/window/view/attention.ts`.

**One follow-up lies exactly on stage B's path** (stage A's known limit "A second window",
`docs/install.md`, "Known limits of stage A"): a second window opens when `skydeck window` starts
a server while an old window is still open. Migration 2 is the first update after which the old
server stops by itself when a command other than `skydeck window` runs first, and even
`skydeck window` first is not certain (1b). **Not carried** (ruled): the fix (a mark in the store
while pages are connected) changes stage A's start of the window; the order that is certain —
close the window, `git pull`, `skydeck window` — is in `docs/install.md` from task 50 on, and in
task 56 and section 6. Question 5 in section 7.

## 6. Stage B is ready to try

When task 56 is merged. (The database is upgraded already at the first `git pull` after task 50:
`docs/install.md`, "Updating", says the same order from then on, and the lead tells the user when
50 is merged.)

First close the skydeck window (its ×, or Alt+F4 while it is in front): your sessions keep
running in their keepers. Then, in a WSL terminal of your own (not a `!` command inside Claude
Code):

```sh
cd ~/projects/mine/skydeck
git pull
skydeck window          # upgrades the database if it is not yet, restarts the window's server
                        # for the new build and opens the window again; every session is there
```

No `npm ci`, no `skydeck install`: no hook entry changes (B19), and `skydeck doctor` has nothing
new to say. Then, in the window, click `Turn on notifications` in the title bar once and allow
them (or block them: the title bar's count and `(n) skydeck` on the taskbar still show what needs
you). At this first start, a session whose window terminal ended unexpectedly while it still
lingers shows `ended` once (B10).

**What only you can check** (task 56's sections, with the throwaway session):

- **W21** — a turn that ends in a session that is not selected shows `finished · not seen`;
  selecting it for 1.5 s clears it; a permission prompt shows `needs you`; a turn with several tool
  calls shows nothing before its end.
- **W19** — whether `needs you · <detail>` tells a permission prompt from a question, and whether
  the detail ever holds a command or a path.
- **W11** — the permission prompt, a toast, a click that selects the session, what Windows does
  when the page closes a toast, whether a locked PC still gets one, and a toast after the window
  was minimised for half an hour.
- **Yours to judge**: what a toast shows on a shared screen (the session's title and
  `asks: <detail>`), and whether the list should say `idle` rather than `waiting` (a follow-up
  after stage D, with the header's pill).
- **W3** — the taskbar button shows `(1) skydeck` while a session needs you.

## 7. Questions for the lead, and the rulings

Asked with the first version of this plan; the lead ruled on 2026-11-15, with the two reviews, and
the plan above follows the rulings.

1. **Going back after migration 2.** Ruled: as planned — no copy of the database before migration
   2 (putting one back would drop everything written since, and a file copy of a WAL database the
   old server holds open may not be whole); said in `docs/install.md` by task 50, since migration
   2 reaches the user at the first `git pull` after it.
2. **An ended row's second line** (B13). Ruled: as planned — a row that needs you has two lines,
   an ended one too.
3. **`waiting` or `idle`.** Ruled: stage A's words (`waiting`) in stage B; "idle or waiting, in
   the rows, the counts and the header's pill" is a follow-up after stage D, the user's to choose.
4. **When the 1.5 s starts** (B9). Ruled: as planned — from the moment the window has focus with
   that session selected; it holds because typing no longer includes focus and mouse reports (F1).
5. **The second window at the update.** Ruled: not carried by stage B; the order that is certain
   (close the window, `git pull`, `skydeck window`) goes into task 50's `install.md` text, task 56
   and section 6.
6. **Idle in the middle of a turn.** Ruled: no debounce; W21 checks it.
7. **The header's state pill** (B18). Ruled: unchanged.

Also ruled (review A): a notification is closed by the page when its session no longer needs you,
and the detail is cut (B13, B16); there is no periodic `seen` write (B9). What a notification
shows on a shared screen is told to the user as theirs to judge.
