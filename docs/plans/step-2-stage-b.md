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
- No test shows a desktop notification or asks for a permission. Every page of the page suite
  gets an inert `Notification` from `test-page/helpers/browser.ts` (B17); the cases about
  notifications install a recording double over it, and a double of `document.hasFocus`, both
  by init scripts (`test-page/helpers/notification.ts`, task 55). No test grants a permission
  through Playwright.
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
| 50 | Migration 2 and the store's attention | 0 | 1 | `src/store/types.ts` (one line); `test/store/store.test.ts` | ~450 |
| 51 | Contracts and the view model of attention | 0 | 1 | `src/window/protocol.ts`, `src/window/view/build.ts`; `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `test/helpers/pages.ts` | ~500 |
| 53 | The turn-end rule and seen | 0 | 1 | — | ~350 |
| 52 | Attention on the server: the look, the writes, the notifier | 50, 51, 53 | 2 | — | ~650 |
| 55 | The page: marks, the title, Ctrl+Shift+J, notifications | 51 | 2 | `web/app.js`, `keys.js`, `help.js`, `list.js`, `list-text.js`, `list.css`, `index.html`; `test/web/keys.test.ts`, `test/web/list.test.ts`, `test-page/shell.test.ts`, `test-page/helpers/browser.ts` | ~750 |
| 54 | The server assembly, and attention end to end | 52, 53, 55 | 3 | `src/window/tick.ts`, `server.ts`, `pages.ts`; `test/window/tick.test.ts`, `test/helpers/pages.ts` | ~650 |
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

- **50 and 53**: no dependency, and no file another stage changes (50's one line in
  `src/store/types.ts`, a `KvKey`, is the kind of line stage C adds too: a rebase keeps both).
- **51** has no dependency but shares `src/window/protocol.ts` and `src/window/view/build.ts`
  with stage D's task 34 (also wave 1): start it when 34 is merged, or beside it and rebase (1c
  says what changes).

### 1b. Migration 2 on a database in real use

The user's store is in daily use (the window runs since 2026-11-15, with real sessions). What
happens at the update, from S2 10.1, 10.2, 16.5 and step 1's `migrate` (`src/store/store.ts`):

- **Who migrates.** The first process of the new checkout that opens the store: any command that
  opens it (`skydeck window`, `ls`, `doctor` …) or the new server, whose connection migrates at
  open like every other. Migration
  2 runs in one transaction with its `kv` update and waits up to 5 s for another writer (the
  migrations keep the 5000 ms busy timeout); a failure leaves schema 1 and every row as they were,
  the command fails with `cannot open the database …`, and the next command tries again.
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
  back a moment later, is a second window (stage A's known limit). `skydeck window` run first
  finds the old server alive, counts its windows and waits for them (S2 5.1). Section 6 and task
  56 say to run it first.

**Turn ends need no new hook entry** (S2 10.3, B19): they come from the live-session files the
server already reads, for every session, in the window or not. The user's `~/.claude/settings.json`
keeps its two entries (`SessionStart`, `SessionEnd`); `skydeck install` is not run again;
`skydeck doctor` reports exactly what it reports today; everything of stage B works from the first
`skydeck window` after `git pull`.

What the tests hold (task 50): a database as step 1 and stage A leave it, with a row in every
table and stage A's `kv` entries, migrates to schema 2 with every row of migration 1 unchanged and
an empty `attention`; opening it again changes nothing; the guard of S2 10.1 refuses a write into
a store one version newer (stage A's tests, kept on `SCHEMA_VERSION + 1`).

### 1c. Every file of every task, and what a rebase brings

Every new module is its own file with its own test file. Each task's own **Files** list says the
same as its row here.

| # | Creates | Changes |
|---|---|---|
| 50 | `test/helpers/schema1.ts`, `test/store/migration-2.test.ts` | `src/store/migrations.ts`, `src/store/store.ts`, `src/store/types.ts`; `test/store/store.test.ts`; `docs/design-step-2.md` (10.2) |
| 51 | `src/window/view/attention.ts`, `test/window/view/attention.test.ts` | `src/window/protocol.ts`, `src/window/view/build.ts`; `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `test/helpers/pages.ts`; `docs/design-step-2.md` (8.2.3, 12.1, 12.4) |
| 53 | `src/window/seen.ts`, `test/window/seen.test.ts` | `src/claude/terminal.ts`; `test/claude/terminal.test.ts`; `docs/design-step-2.md` (10.3, 12.4) |
| 52 | `src/window/attention.ts`, `src/window/notify.ts`, `test/window/attention.test.ts`, `test/window/notify.test.ts` | `docs/design-step-2.md` (10.3, 12.4, 13) |
| 55 | `web/attention-text.js`, `web/notify.js`, `web/attention.css`, `test/web/attention-text.test.ts`, `test-page/attention.test.ts`, `test-page/helpers/notification.ts` | `web/list-text.js`, `web/list.js`, `web/list.css`, `web/app.js`, `web/keys.js`, `web/help.js`, `web/index.html`; `test/web/keys.test.ts`, `test/web/list.test.ts`, `test-page/shell.test.ts`, `test-page/helpers/browser.ts`; `docs/design-step-2.md` (12.2, 12.4, 13, 17.4) |
| 54 | `test/window/attention-server.test.ts`, `test/window/pages-attention.test.ts`, `test-page/attention-server.test.ts` | `src/window/tick.ts`, `src/window/server.ts`, `src/window/pages.ts`; `test/window/tick.test.ts`, `test/helpers/pages.ts`; `docs/design-step-2.md` (8.2.7) |
| 56 | — | `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (19, and any decision of 1d still missing) |

**Shared source files** (changed by another stage too; never two stage B tasks of one wave):
`src/store/types.ts` (50; C may add a `KvKey`), `src/window/protocol.ts` and
`src/window/view/build.ts` (51; D 34, C, E), `web/app.js`, `web/keys.js`, `web/help.js`,
`web/index.html` (55; D 37, C, E), `web/list.js`, `web/list-text.js`, `web/list.css` (55; D 34,
C, E), `src/window/tick.ts` and `src/window/server.ts` (54; D 36, C), `src/window/pages.ts` (54;
no other stage known to this author). `docs/design-step-2.md`: each task records its decisions of
1d in the sections named above; 51 and 53 both add to 12.4 in wave 1, 52 and 55 both to 12.4 and
13 in wave 2, each its own sentences — the second to merge rebases and keeps both. `docs/install.md`,
`docs/manual-checks.md`, `README.md`: 56 only in stage B (D 39 and C edit them too).

**What each task does to a shared test file**, so that stages C and D can be scheduled around it:

| Test file | Task | What it does |
|---|---|---|
| `test/store/store.test.ts` | 50 | the migration count becomes 2; the table list of a new database gains `attention`; the one literal `'2'` that means "newer than this build" becomes `SCHEMA_VERSION + 1`; new cases at the end |
| `test/window/protocol.test.ts` | 51 | the `LIST` fixture gains `needYou: { count: 0, order: [] }`; the case "an object of each ServerMessage type" gains a `NotifyMessage`; nothing else (D 34 changes the same file's `ROW`) |
| `test/window/view/build.test.ts` | 51 | new cases at the end; the case that pins the view's files and imports gains `attention.ts` in its file list and `./attention.ts` among the allowed imports (D 34 adds `chip.ts` and `CHIP_ORDER` there: keep both) |
| `test/helpers/pages.ts` | 51, 54 | 51: `defaultList` gains `needYou: { count: 0, order: [] }` (D 34 adds `openedNs` in the same object); 54: `startPages` takes an optional `seen` and passes it on |
| `test/web/keys.test.ts` | 55 | Ctrl+Shift+J's two rows give `next-attention` instead of `later` B; the "every later key" case leaves Ctrl+Shift+J out (D 37 changes the rows of `l`, `g`, `n`, `p`, `d`, F2) |
| `test/web/list.test.ts` | 55 | new cases at the end (D 34 changes the chip's cases) |
| `test-page/shell.test.ts` | 55 | in the keys case, the two lines of Ctrl+Shift+J's `comes in a later stage` become `no session needs you` (D 37 changes the lines of the six list keys of the same case) |
| `test-page/helpers/browser.ts` | 55 | `newPage` adds one `context.addInitScript` (B17) |
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
| B4 | The look keeps a baseline per pid: the last file read whole, parsed and trusted (`isLiveFileTrusted`). A file not read at a look (rewritten, unreadable, untrusted, or `/proc` cannot be read) keeps its baseline; a baseline is dropped when `/proc` says its pid has no process. The statuses the view reads are the baselines', so a file being rewritten does not make a mark blink. | S2 10.3: "a look that cannot read a file keeps the last status seen"; the baselines must not grow for ever. | 53 (10.3) |
| B5 | A session with several holders (a duplicate) has one status: `waiting` when any holder waits, else `busy` when any is busy, else `idle` when any is idle, else the first one's. | S2 12.4 speaks of "a holder's live-session file". | 51 (12.4) |
| B6 | "Finished" needs a holder whose status is `idle`; a session `running` without a readable file is not finished. Ctrl+Shift+J's order: those that ask by their status time (unknown last), then those that ended by `window_end_seq`, then those that finished by `turn_ended_seq`; ties by session id. | S2 12.4: "the session is running and idle"; the longest-waiting and oldest first. | 51 (12.4) |
| B7 | `list` gains `needYou: { count, order }`: `count` the listed rows that need you, whatever the filter (the title bar's count and `(n) skydeck`); `order` the ids of the rows this page shows that need you, in B6's order. A row that needs you is counted there and in none of `counts`. | The page decides no rule (S2 4.3); the title bar's parts add up, as S2 12.1's example does (3 + 3 + 2). | 51 (8.2.3, 12.1) |
| B8 | `notify` carries `reason` as the kind (`asks`, `ended`, `finished`) and `detail` (the waiting detail, else null); the page writes the words. | As the list's words are the page's (stage A, A18); S2 8.2.3 names no detail. | 51 (8.2.3) |
| B9 | Seen is held per page from the moment that page is focused with that session selected; any change of either starts the 1.5 s again (a window that comes back to the front sees after 1.5 s too). Text typed into a terminal (an `input` that is not `binary`) makes the session that terminal shows seen at once; mouse reports do not. A `seen` is written at once when a hold completes or when it would clear a mark; otherwise at most once per 5 s while the hold lasts; and always in the write of a turn end or window end of that session. | S2 12.4 fixes the 1.5 s and the 5 s but not when the hold starts, nor that the 5 s must not delay the write that clears a mark. Question 4 in section 7. | 53 (12.4) |
| B10 | A window end is judged at each refresh after it was settled, for a terminal in state `ended` or `lost` that started its program: recorded when its session's row is not running and marked `ended-unexpectedly`, not recorded when the row runs again or ended deliberately; judged once. It is the same end when the stored `window_end_ns` equals the exit's time, so a server restart, which finds a lingering keeper again, never marks it twice. | S2 12.4 reason 2 says "at the next refresh"; a restart for an update must not bring back what the user saw. | 52 (12.4) |
| B11 | A write the store refuses (busy, S2 14) is kept and tried again at the next look, merged with what comes meanwhile; the baselines move on, so a turn end is neither lost nor recorded twice. A store migrated under the server stops it (S2 10.1). | A turn end is seen once, at one look. | 52 (10.3) |
| B12 | The server judges "starts to need you" over the rows a page without a filter lists (it builds that list with `buildListMessage`); the first judgement after the server starts records without notifying; a session whose reason changes does not start to need you. `Pages.notify` sends only while no page has focus, to the page that had it last. | S2 13; a restart must not notify everything that already needed you. | 52 (13) |
| B13 | The page's words: a row that needs you has the reason on its second line — `needs you · <detail> · 3m` (`needs you · 3m` without a detail), `finished · not seen · 2m`, `ended unexpectedly · not seen · 2m` — also a row that is not running (an ended one), which then has two lines; the title bar starts with `● 3 need you`; the window title is `(3) skydeck`, and `skydeck` when none; a notification's body is `asks: <detail>` (`asks`), `finished`, `ended unexpectedly`. | S2 12.2's and 13's examples; S2 12.4: "the reason on its second line". Question 2 in section 7. | 55 (12.2, 12.4) |
| B14 | Ctrl+Shift+J selects the next id of `needYou.order` after the selected one, else the first; after the last the first. None: the key bar says `no session needs you`; only the selected one: it stays selected and the key bar says `no other session needs you`. While a dialog of stage D is shown (when D is merged; its D2: `app.js` moves the keyboard nowhere and acts on no list key), Ctrl+Shift+J is a chord like the others there: it says D's `close the edit first (Esc)` and selects nothing. | S2 12.4 "pressed again it goes on"; what the key does with nothing to go to; an edit belongs to the session it was opened for. | 55 (12.4) |
| B15 | The page asks for the permission only from a click on `Turn on notifications`, a button in the title bar shown while `Notification` exists and its permission is `default`. A `notify` is shown only with the permission `granted`, never for the session that is selected while the page has focus, with the session's title (sanitised) as title, B13's body and `tag` the session id; a click calls `window.focus()` and selects the session through `select(id, 'chord')`. While a dialog of stage D is shown (when D is merged), the click only brings the window to the front: nothing is selected, the keyboard and the dialog stay, and the key bar says `close the edit first (Esc)`. | S2 13; a click must not take an edit away from its session. | 55 (13) |
| B16 | A notification stays in Windows' notification centre after its session no longer needs you; the page closes none. | Not in S2 13; a named limit. | 55 (13) |
| B17 | `newPage` gives every page of the page suite an inert `Notification` (permission `denied`, `requestPermission` answers `denied` and asks nothing); the cases about notifications put a recording double over it and a `document.hasFocus` double, each through an init script. | No test may show a notification or ask for a permission, whatever a server sends. | 55 (17.4) |
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
/** A database at `path` exactly as step 1 and stage A leave one: MIGRATIONS[0] alone, kv
 *  schema_version '1', and a row in every table of migration 1 — events of two sessions, a link,
 *  session_meta with a label, a group, a note and a done time, a transcript, a pull request
 *  attached to one session and detached from another — and stage A's kv entries (window_secret,
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
/** S2 12.4: why a row needs you. `detail`: for `asks` the live file's waitingFor, sanitised (null
 *  without one); else null. `sinceNs`: asks — the file's statusUpdatedAt, else updatedAt; ended —
 *  window_end_ns; finished — turn_ended_ns; null when not known. Display only (S2 10.2). */
export interface AttentionPayload { reason: AttentionReason; detail: string | null; sinceNs: NsText | null }
// RowPayload.attention: AttentionPayload | null    (stage A: null)
// ListMessage gains   needYou: { count: number; order: string[] }   (B7)
/** S2 13, B8: sent to one page; `title` is the row's title (sanitised). */
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
 *  asks — the row is running and its LiveStatus is `waiting`;
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
/** One look (S2 10.3, B4). `files`: those read at this look; `gone`: pids /proc says have no
 *  process. A pid with no file keeps its baseline unless it is gone; a file is the new baseline of
 *  its pid; `first` (the server's first look) sets baselines only. `ends`: the turn ends of this
 *  look, with the file's `sinceNs` (null: the caller uses its clock, "the time it saw the change"). */
export function lookAt(baselines: ReadonlyMap<number, LookedFile>, files: readonly LookedFile[], gone: ReadonlySet<number>, first: boolean): { baselines: Map<number, LookedFile>; ends: { pid: number; sessionId: string; atNs: Ns | null }[] };
```

```ts
// src/window/seen.ts — S2 12.4 "seen", the condition that holds; B9
export const SEEN_AFTER_MS = 1500;
export interface Seen {
  /** A page's focus and selection now (its `start`: selected null; its `focus`). A change of
   *  either starts the page's 1.5 s again (Clock.after: a timer, which no wall-clock step moves). */
  focus(page: object, focused: boolean, selected: string | null): void;
  /** Text typed into a terminal that shows `sessionId`: seen at once — held, when it is the page's
   *  selection and the page has focus; else once, in the next take(). */
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
  /** The one-second look (S2 10.3): readLiveFiles, trust, lookAt, the turn ends of this look and
   *  the seen writes of B9 in one recordAttention. The marks are read from the store at the first
   *  look that can (only the server writes them). True when the facts changed. Never throws: a
   *  busy store keeps the writes (B11) and logs its kind once until a write works again. */
  look(): boolean;
  /** After a refresh that worked: B10's window ends, with the seen of a session being seen in the
   *  same write. True when the facts changed. Never throws, as look. */
  refreshed(): boolean;
  /** A session began to be seen (Seen.onChange): only B9's seen writes, now. As look. */
  seenNow(): boolean;
  facts(): AttentionFacts;
}
export function createAttention(deps: AttentionDeps): Attention;

// src/window/notify.ts — S2 13, B12
export interface NotifierDeps {
  /** The sessions that need you now, with their title: those a page without a filter lists. */
  needs: () => ReadonlyMap<string, { title: string; attention: AttentionPayload }>;
  /** Pages.notify; whether a page got it. */
  send: (message: NotifyMessage) => boolean;
}
/** check(): one judgement; its first call sends nothing. Never throws (a failure is logged by kind
 *  by the caller's wrapper). */
export function createNotifier(deps: NotifierDeps): { check(): void };
```

### 2.7 The server assembly (task 54)

```ts
// src/window/tick.ts — TickDeps gains (optional: stage A's and D's cases need no change)
  /** Every second, before the keep-alive: look(); every refresh that worked: refreshed(), after
   *  the mapping. When either says true the pages' lists are pushed. */
  attention?: Pick<Attention, 'look' | 'refreshed'>;

// src/window/pages.ts — PagesDeps gains
  /** S2 12.4: told each page's focus and selection, its typing and its end. */
  seen?: Pick<Seen, 'focus' | 'typed' | 'gone'>;
// Pages gains
  /** S2 13: while no page has focus, `message` to the page that had focus last; false when it was
   *  not sent (a page has focus, or none is open). */
  notify(message: NotifyMessage): boolean;
```

`src/window/server.ts` creates `createSeen(clock)` and `createAttention(…)` before the tick, gives
the tick `attention` (each call followed by the notifier's `check()`), the pages `seen`, `listFor`
`attention: attention.facts()`, `seen.onChange` → `seenNow()`, then `pushList()` and `check()`
when it changed; the notifier's `needs` is `buildListMessage` over the tick's rows, the hub's
terminals and `elsewhere`, with the view `{ filter: '', unfolded: ['earlier'], showDone: false,
selected: null }`; the server's stop calls `seen.stop()`.

### 2.8 The page's modules (task 55): additions to stage A's contract 2.9

```js
// web/attention-text.js — pure, no DOM (node:test and the root tsc load it)
/** B13: the second line of a row that needs you, or null when `attention` is null. */
export function attentionLine(attention, nowNs) {}
/** `3 need you`, or null for 0. */
export function needYouText(count) {}
/** `(3) skydeck`, or `skydeck` for 0. */
export function windowTitle(count) {}
/** B13: { title, body } of a NotifyMessage, both sanitised. */
export function notificationText(message) {}
/** B14: { id } of the session to select, or { say } with the key bar's line. */
export function nextNeeding(order, selected) {}

// web/notify.js — the Notification API, through globalThis.Notification read at each use
/** @param {HTMLButtonElement} item  #notify-on (index.html's title bar)
 *  @param {{ select(id: string): void }} deps */
export function createNotifications(item, deps) {}
// → { show(message: NotifyMessage, page: { focused: boolean, selected: string | null }): void,
//     refresh(): void }   // refresh: the item shown exactly while the permission is `default`

// web/keys.js — windowChord: Ctrl+Shift+J gives { kind: 'next-attention' } (stage A: `later` B);
// `later` keeps stage E's (and D's, until stage D's task 37 is merged).
```

`web/app.js` (task 55): `document.title` from `windowTitle(list.needYou.count)` at each list; the
chord `next-attention` through `nextNeeding` and `select(id, 'chord')`; a `notify` message to
`createNotifications(…).show` with `document.hasFocus()` and the selection. `web/list.js` sets
`data-attention="<reason>"` on a row element that needs you (the coloured left bar and the bold
title are `web/list.css`'s) and writes `needYouText` first into `#counts`, `data-state="need-you"`.
`web/list-text.js`'s `rowText` gives `attentionLine` as `stateLine` when the row needs you (and
then two lines). The page reads `needYou` and `attention` as absent when a list lacks them (a
scripted list of stage A's helpers): no count, no mark.

## 3. Tasks

### Task 50: Migration 2 and the store's attention

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 10.2, 4.4 (`src/store/`, B), 16.5; design 9.2 · **Contracts:** 2.2 · **Decisions:** B1, B2, B3 · **Shared files:** `src/store/types.ts` (a `KvKey` line and two types). If stage D is merged first: nothing differs (D adds no migration and no key).

**Goal.** The store at schema 2, its attention rows read and written by the server's rules, and
the proof that a database in use since step 1 migrates without loss (section 1b).

**Files**
- Modify: `src/store/migrations.ts` (migration 2), `src/store/store.ts` (`attention`,
  `recordAttention`), `src/store/types.ts`, `docs/design-step-2.md` 10.2 (B2, in the prose: the
  SQL block stays as it is)
- Create: `test/helpers/schema1.ts`, `test/store/migration-2.test.ts`
- Test: `test/store/store.test.ts` (the migration count, the table list of a new database, the
  attention methods; every place that means "newer than this build" uses `SCHEMA_VERSION + 1`:
  `rg -n "schema_version" test` lists them)

**Behaviour.** Writes go through `#run` / `#runReturning` and reads through `#all` / `#get`, so
that the guard and `prepareRead` hold (stage A's contract 2.6, `openStore`); the counter's value is computed inside the
same transaction (B2). Integer `*_seq` columns are numbers, `*_ns` bigints (design 9.2).

**Tests** (platform: none — the store on a sandbox path)
- `MIGRATIONS` has two entries and `SCHEMA_VERSION` is 2; `MIGRATIONS[1]` equals the SQL block
  under "**Migration 2**" of S2 10.2 character for character (read from the design, as migration 1
  is from design.md 9.2).
- `migration-2.test.ts`: `schema1Database`, then `openStore`: `schema_version` `'2'`; the entries
  of sqlite_master of migration 1 and every row of every table of migration 1 are exactly the
  `dumpDatabase` of before; `attention` exists, empty; no kv entry changed but `schema_version`.
  Opening again: the dump equal to the first one after the migration. A migration while another
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

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 4.3, 8.2.3 (`list`, `notify`), 12.1 (the counts), 12.4 · **Contracts:** 2.3, 2.4 · **Decisions:** B5, B6, B7, B8 (update S2 8.2.3, 12.1, 12.4) · **Shared files:** `src/window/protocol.ts`, `src/window/view/build.ts`, `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `test/helpers/pages.ts`. If stage D's task 34 is merged first: `RowPayload.chip` is D's `ChipPayload`, `PrPayload` has `okAtNs`, `openedNs` is in the message (where D's plan puts it), `SelectedPayload` has the note's fields, `src/window/view/` holds `chip.ts`, and the pinned view case and `defaultList` carry D's additions — B's lines go beside them unchanged.

**Goal.** Fix as code every message and view-model function the other stage B tasks meet at, and
the one rule of S2 4.3 that judges attention.

**Files**
- Create: `src/window/view/attention.ts`, `test/window/view/attention.test.ts`
- Modify: `src/window/protocol.ts` (2.3), `src/window/view/build.ts` (`ViewInput.attention`,
  each row's `attention`, `needYou`, the counts of B7), `test/window/protocol.test.ts` (the `LIST`
  fixture gains `needYou`; `NotifyMessage` in the case "an object of each ServerMessage type"),
  `test/window/view/build.test.ts` (the cases below at the end; the case that pins the view's files
  and imports gains `attention.ts` and the import `./attention.ts`), `test/helpers/pages.ts`
  (`defaultList` gains `needYou: { count: 0, order: [] }`), `docs/design-step-2.md` 8.2.3, 12.1,
  12.4

**Tests** (platform: none — pure, step 1's builders of `test/helpers/derived.ts`)
- `attentionOf`: asks for a running row whose status is `waiting`, with its sanitised detail (an
  escape sequence and `<img src=x onerror=…>` come back as text without the escape) and its time;
  not for a row that is not running; ended when `windowEndSeq` is greater than `seenSeq` or
  `seenSeq` is null, also for a row that is not running, and not once `seenSeq` is greater;
  finished for a running row, `idle`, `turnEndedSeq` greater; not when `busy`, `waiting` (then it
  asks), without a status, not running, or seen later; the order asks > ended > finished when
  several hold; an equal seq is not greater.
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
  10.3, 12.4
- Create: `src/window/seen.ts`, `test/window/seen.test.ts`
- Test: `test/claude/terminal.test.ts`

**Tests** (platform: none for `terminal.ts`; `testPlatform`'s fake clock for `seen.ts`)
- `isTurnEnd`: `busy`→`idle` and `waiting`→`idle` are; `busy`→`waiting`, `idle`→`idle`,
  `idle`→`busy`, `shell`→`idle`, a null status, another session and another process start are not.
- `lookAt`: the first look gives baselines and no end; a second look with `busy` then `idle` gives
  one end with the file's time; a pid missing at a look keeps its baseline, and `idle` at the look
  after is still an end; a pid in `gone` is dropped; a file naming another session, or the same pid
  with another process start, starts over; a pid seen for the first time at a later look gives no
  end.
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
- Modify: `docs/design-step-2.md` 10.3, 12.4, 13

**Behaviour.** `look()`: `readLiveFiles` of `claudeHome`; each file trusted by `isLiveFileTrusted`
becomes a `LookedFile` (one that throws is not read at this look); `gone` from `Proc.stat` for the
baselines' pids without a file (null: gone; a throw: not gone); `lookAt`; the turn ends (their
time, else the clock) and B9's seen for the sessions `seen.take()` gives go into one
`recordAttention`, merged with what a refused write left (B11); the stored rows replace the
facts' marks. `refreshed()`: B10 over `hub.list()` and `rows()`; the session a terminal held is
the one it shows, else the one it was opened for (`sessionId ?? expectedSessionId`). Every log line names a kind or a
count, never a session's text. `createNotifier`: `check()` diffs `needs()` with the last
judgement through `startsToNeed` and sends one `NotifyMessage` per new one.

**Tests** (platform: `testPlatform` through `testDeck`; live files written by the test, trusted
through the fake `/proc`, as `test/helpers/session-files.ts`'s `startRunning`)
- A busy file, a look, the same file idle, a look → one row with `turnEndedSeq` and the file's
  status time; `facts().live` says `idle`; the first look of a new module records nothing for a
  file that was idle already.
- While `seen.take()` gives the session, a turn end and its seen are one write (seen = turn + 1);
  a hold that starts on a finished session writes seen at once; a hold that lasts writes again
  after 5 looks, not before; one that clears a mark is not held back by the 5 s.
- A file that cannot be parsed between the busy and the idle look keeps the baseline: the end is
  recorded; a file removed and its pid gone drops the baseline; `/proc` that throws drops nothing.
- B11: the store locked by another connection at the look of a turn end → nothing written, one
  log line with a kind; the next look after the lock is gone writes it once; a second turn end
  meanwhile is merged (the later one stored); the store migrated by another connection →
  `storeNewer` once, nothing written, later calls do nothing.
- B10: a terminal `ended` with an exit, its row not running with `ended-unexpectedly` →
  `windowEndSeq` and the exit's time; a deliberate end (no mark) → nothing; the row running again
  → nothing; a second `refreshed` → nothing more; a new module over a store that holds that exit's
  time (a server restart) → nothing; a `not-started` terminal → nothing.
- The notifier: the first `check` sends nothing; a session that comes to need you → one message
  with its title, reason and detail; it again at the next check → nothing; asks then finished →
  nothing; gone and back → one.

**Done when:** turn ends, seen and window ends reach the store by S2 10.2, 10.3 and 12.4 with B9–B11,
and the judgement of S2 13 is tested; `npm run check` passes.

**Not in it:** the tick, the pages and the server's wiring (54).

---

### Task 55: The page — marks, the title, Ctrl+Shift+J, notifications

**Depends on:** 51 · **Wave:** 2 · **Design:** S2 12.1 (the title bar, the window title), 12.2 (the second line), 12.4 (the marks, Ctrl+Shift+J), 12.9 (the key help), 13 (the page's side), 17.4 · **Contracts:** 2.8; stage A's 2.9 · **Decisions:** B13, B14, B15, B16, B17 (update S2 12.2, 12.4, 13, 17.4) · **Shared files:** `web/app.js`, `web/keys.js`, `web/help.js`, `web/list.js`, `web/list-text.js`, `web/list.css`, `web/index.html`, `test/web/keys.test.ts`, `test-page/shell.test.ts`, `test-page/helpers/browser.ts`. If stage D is merged first: `list-text.js`'s chip is D's (`chipText` of a `ChipPayload`); `app.js` holds D's dialog, the toast, the new list keys and the header's call with `list.selected` for every pane — while a dialog is shown it moves the keyboard nowhere and acts on no list key, so Ctrl+Shift+J says `close the edit first (Esc)` (B14) and a notification's click only brings the window to the front (B15), and the second of 55 and D's 37 to merge adds a page case for each; `keys.js`'s `later` then has only stages B and E (B removes B); `help.js` lists D's keys; `index.html` has `#editor` and `#toast`; `shell.test.ts`'s case of the six list keys is D's.

**Goal.** The window shows what S2 12.4 and 13 say, from exactly what the server sends: the marks,
the counts and the window title, Ctrl+Shift+J, and desktop notifications with the permission asked
only on a click.

**Files**
- Create: `web/attention-text.js`, `web/notify.js`, `web/attention.css`,
  `test/web/attention-text.test.ts`, `test-page/attention.test.ts`,
  `test-page/helpers/notification.ts` (`notificationDouble(page, permission)` — an init script
  recording each `new Notification` with its strings, `requestPermission` calls with
  `navigator.userActivation.isActive`, and clicks on a recorded one; `pageFocus(page, focused)` —
  `document.hasFocus` answering `focused` and a `focus` or `blur` event dispatched)
- Modify: `web/list-text.js`, `web/list.js`, `web/list.css`, `web/app.js`, `web/keys.js`,
  `web/help.js` (`Ctrl+Shift+J`: `the next session that needs you; again goes on`),
  `web/index.html` (`#notify-on` in the title bar, `attention.css`),
  `test-page/helpers/browser.ts` (B17's inert `Notification`), `test/web/keys.test.ts`,
  `test/web/list.test.ts` (`rowText` of a row that needs you: B13's line as its `stateLine`, two
  lines for an ended one; a row without attention as before),
  `test-page/shell.test.ts` (Ctrl+Shift+J says `no session needs you` there), `docs/design-step-2.md`
  12.2, 12.4, 13, 17.4

**Tests** (platform: `realTestPlatform` for the page; a scripted stand-in server through
`standinServer` and `honest`, sending lists with `attention` and `needYou`, and `notify`)
- `attention-text.test.ts` (node): every line and body of B13, with and without a detail, ages as
  `format.js` gives them; a detail with an escape sequence or markup sanitised and kept as text;
  `needYouText` and `windowTitle` for 0, 1 and 3; `nextNeeding` for B14's cases (none, only the
  selected, the selected first, middle, last, not in the order).
- `keys.test.ts`: Ctrl+Shift+J on a US and a Czech layout, both zones → `next-attention`,
  cancelled; `later` only where it remains.
- `attention.test.ts` (page): a row that needs you has `data-attention`, a bold title and a left
  bar of another colour than a row that does not (computed style), and its second line; an ended
  row that is not running has two lines; `#counts` starts with `3 need you`, the title is
  `(3) skydeck`, and `skydeck` again with a list without; a list without `needYou` (stage A's
  `scriptedList`) shows neither and throws nothing. Ctrl+Shift+J in both zones selects the first
  of `order`, then the next, then the first again, and the page sends `view` and `focus` with it;
  with none the key bar says `no session needs you`. Notifications (the double): permission
  `default` → the button shown, nothing asked at load or by any key; a click → one
  `requestPermission` with user activation; `granted` → the button hidden; a `notify` while the
  page is unfocused → one notification with the title, B13's body and the tag; a hostile title and
  detail arrive as plain strings and add no element; a click on it → `window.focus` called and the
  session selected; focused with that session selected → none; `denied` → none and no button. A
  page from `newPage` without the double sees B17's inert `Notification`.

**Done when:** every page-side rule of S2 12.4 and 13 is shown for its case, the help lists
Ctrl+Shift+J as a key that acts, and no page test can show a notification; `npm run check` passes.

**Not in it:** the server's side (52, 54); the header (B18).

---

### Task 54: The server assembly, and attention end to end

**Depends on:** 52, 53, 55 · **Wave:** 3 · **Design:** S2 8.2.7 (several windows), 10.1, 10.3, 12.4, 13, 14, 17.3, 17.4 · **Contracts:** 2.7 · **Decisions:** B20 (update S2 8.2.7) · **Shared files:** `src/window/tick.ts`, `src/window/server.ts`, `src/window/pages.ts`, `test/window/tick.test.ts`, `test/helpers/pages.ts` (`startPages` passes `seen`). If stage D's task 36 is merged first: `tick.ts` has `reloadNow` and `server.ts` gives the actions `changed`, `fetchPrs` and `refreshPrs` — B's lines are beside them, and an edit's `reloadNow` brings the attention facts along through `listFor`.

**Goal.** Wire 52, 53 and 55 into the running server so that a real turn end, a real selection
and a real typing in a real page do what S2 12.4 and 13 say, in every window.

**Files**
- Modify: `src/window/tick.ts`, `src/window/server.ts`, `src/window/pages.ts` (the `seen` calls:
  `start` → `focus(conn, focused, null)`, `focus`, an `input` that is not `binary` → `typed` with
  the session `hub.list()` says the terminal shows, the end of the connection → `gone`;
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
  (not for binary input), and a closed page; `notify` with no page focused → only the page that
  had focus last; with one focused → none, false; with none open → false.
- `attention-server.test.ts`: a stand-in in a window terminal while a focused page selects another
  session: `/busy`, then `/idle` → within 4 s its row is `finished`, `needYou.count` 1, the store
  holds `turn_ended_seq`; the page selects it, focused → cleared after 1.5 s and within 3 s,
  `seen_seq` greater; unfocused → it stays. Typing into its terminal → cleared at once (no 1.5 s).
  A turn that ends while the page holds it → never `finished` in any list (each list read) and one
  write with seen = turn + 1. `/waiting permission prompt` → `asks` with that detail within 2 s,
  `/busy` → gone. `/fail 3` → `ended` after the next refresh; `/exit` → none; a server restart
  while the ended keeper lingers → still one `window_end_seq`, the mark as before. A session the
  test runs outside the window → its turn ends recorded too. Two pages: the second sees the same
  marks; a seen in the first clears them in both; both unfocused, the second focused last → only
  it gets `notify`; one focused → none; what needed you before a server restart → no `notify`
  after it; a turn that ended while no server ran → no `finished`. The store locked by
  `test/fixtures/hold-write-lock.ts` at a turn end → recorded once when the lock is gone; a store
  migrated by another connection → `bye`, nothing written. A server started on `schema1Database`
  migrates it and lists its sessions. No log line holds a title or a detail (a marker in both).
- `test-page/attention-server.test.ts` (Chromium, `notificationDouble`, `pageFocus`): a session
  that finishes while another is selected → its row's bar and `finished · not seen`, the title
  `(1) skydeck`; Ctrl+Shift+J selects it; 1.5 s later the mark is gone and the title `skydeck`; the
  page unfocused (`pageFocus`) and a turn that ends → one notification `finished` with the
  session's title; its click selects the session.

**Done when:** a page against a real server shows S2 12.4's marks, clears them as S2 12.4 says,
and gets S2 13's notifications, in two windows; `npm run check` passes.

**Not in it:** the documents (56).

---

### Task 56: Documentation of stage B

**Depends on:** all · **Wave:** 4 · **Design:** S2 10.3 (nothing to install), 12.4, 13, 16.5, 18 (W3's title, W11, W19, W21), 19 · **Contracts:** — · **Decisions:** — · **Shared files:** `docs/install.md`, `docs/manual-checks.md`, `README.md` (stage D's task 39 edits them too: keep both parts).

**Goal.** A user can use attention and notifications from the documents alone, updates to stage B
in the safe order, and knows which checks only they can make.

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` only
  where a decision of 1d is still missing from it, and S2 19's stage B line naming W3's title

**Content (contract)**
- `docs/install.md`, "Using the window": the three reasons, how a mark goes (seen: selected 1.5 s
  in the focused window, or typed into; asks: when the dialog closes), the title bar and the window
  title, Ctrl+Shift+J, `Turn on notifications` (once; when Edge or the company's policy refuses,
  the counts and the title still show it). "Known limits of stage B": a turn that ends while no
  server runs is not recorded; a notification stays in Windows' notification centre (B16); a
  notification goes to one window; seen needs the window in front. "Updating while the window
  runs" and "Updating": with the window open, `skydeck window` is the FIRST command after
  `git pull` (section 1b), and a second window that opens anyway is closed; nothing to install
  again (B19); once a stage B command has run, a checkout from before stage B refuses the database
  (1b), so going back is not possible.
- `README.md`: one sentence in the window's paragraph — what needs you, and notifications.
- `docs/manual-checks.md`: a part "The window (step 2, stage B)" with W11, W19 and W21, and W3
  gains the title `(n) skydeck` on its taskbar button. Each says what to set up, what to type, what
  to look at and what to write down, and every step can do no harm to the machine or to the
  user's running sessions (the rules stage A's checks were held to in their review):
  - every **real claude** step uses stage A's throwaway session in `~/skydeck-try` ("A throwaway
    session in the window"), started by the step itself, never a real work session, and names the
    session it acts on — no step presses Enter on whatever is selected;
  - a permission prompt is made by asking for one harmless command (`please run ls in this folder`)
    and is answered **No**; a question by asking Claude Code to ask one (`ask me with your question
    tool whether I prefer tea or coffee, then stop`), answered;
  - no step closes a window with other tabs, ends a real `claude`, reads or edits a file under
    `~/.claude`, prints a file's bytes to the terminal, or changes Edge's or Windows' settings;
    allowing notifications is the one permission asked, and the step says that `Block` is a valid
    answer to write down;
  - W11's half hour: the window minimised, a second throwaway session in a WSL terminal of the
    user's own (`cd ~/skydeck-try && claude`), given one prompt after 30 minutes — its turn end
    reaches the window without touching it; the step ends with `/exit` in that terminal;
  - W21 also asks for a turn with several tool calls (`list the files here, then count them`) and
    whether `finished` or a notification came before its end (question 6 in section 7).

**Steps**
- [ ] Run no `skydeck` command at all: a "clean `SKYDECK_HOME`" is no sandbox (`show` and others
      read the real `~/.claude`, `window` reaches port 47613 and the real Edge). What a command
      prints is held by the sandboxed tests of the task that changes it; stage B changes no
      command's output, so every line the documents quote is checked against the code and the
      tests of tasks 50–55 instead.
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can use stage B from `docs/install.md` alone, and W3's title, W11, W19 and
W21 are in `docs/manual-checks.md`.

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
| 16 (install, doctor: unchanged; updating) | B19, 1b, 56 |
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
a server while an old window is still open. Migration 2 is the first update after which the old server stops by itself when a command
other than `skydeck window` runs first (1b). **Not carried**: the fix (a mark in the store while
pages are connected) changes stage A's start of the window; stage B's documents give the order
that avoids it instead (task 56, section 6). Question 5 in section 7.

## 6. Stage B is ready to try

When task 56 is merged. In a WSL terminal of your own (not a `!` command inside Claude Code),
with the window open as it is now:

```sh
cd ~/projects/mine/skydeck
git pull
skydeck window          # FIRST, before any other skydeck command: it upgrades the database,
                        # restarts the window's server for the new build and waits for your open
                        # window to come back; your sessions keep running
```

No `npm ci`, no `skydeck install`: no hook entry changes (B19), and `skydeck doctor` has nothing
new to say. Should a second window open anyway, close one of them. Then, in the window, click
`Turn on notifications` in the title bar once and allow them (or block them: the title bar's
count and `(n) skydeck` on the taskbar still show what needs you).

**What only you can check** (task 56's sections, with the throwaway session):

- **W21** — a turn that ends in a session that is not selected shows `finished · not seen`;
  selecting it for 1.5 s clears it; a permission prompt shows `needs you`; a turn with several tool
  calls shows nothing before its end.
- **W19** — whether `needs you · <detail>` tells a permission prompt from a question.
- **W11** — the permission prompt, a toast, a click that selects the session, and a toast after
  the window was minimised for half an hour.
- **W3** — the taskbar button shows `(1) skydeck` while a session needs you.

## 7. Questions for the lead

Planned around the reading given; each is the lead's or the user's to change.

1. **Going back after migration 2.** Step 1's rule refuses a store of a newer schema, so once any
   stage B command has run, a checkout from before stage B stops every command with `… was written
   by a newer skydeck …`. Planned: as it is, and said in `docs/install.md`. The alternative is a
   copy of the database made just before migration 2 (`skydeck.db.before-2`), which the user could
   put back by hand; it is a write the design does not have.
2. **An ended row's second line** (B13). S2 12.2 gives a row that is not running one line, and
   S2 12.4 puts "the reason on its second line". Planned: a row that needs you has two lines, also
   an ended one that is not running. The other way: one line, the bar, the bold title and the
   `crashed` mark.
3. **`waiting` or `idle` in the title bar.** S2 12.1's example says `2 idle`; stage A's counts say
   `waiting` (design 6.2's word, also on the rows). Planned: stage A's words, with the counts
   disjoint (B7).
4. **When the 1.5 s starts** (B9). Planned: from the moment the window has focus with that session
   selected, so that a window brought back to the front does not count as seen at once. The literal
   reading ("from 1.5 seconds after it was selected") would clear a mark the moment the window
   comes back.
5. **The second window at the update** (section 5). Planned: not carried; the documents say to run
   `skydeck window` first. If it should be fixed first, it is a stage A follow-up of its own.
6. **Idle in the middle of a turn.** If Claude Code's live file says `idle` between two tool calls
   of one turn, stage B shows `finished` and notifies mid-turn. Planned: no debounce; W21 checks it,
   and a follow-up ("idle at two looks in a row") if it does.
7. **The header's state pill** (B18). Stage D's plan leaves "attention in the state pill" to stage
   B; S2 12.5 does not ask for it. Planned: the header unchanged.
