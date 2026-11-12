# skydeck — design

Status: agreed design for step 1, outline for step 2. This document is the source of truth for
implementation; when the code and this document disagree, one of them has a bug.

## 1. Purpose

skydeck is one developer's tool for working with many Claude Code sessions at once. It fixes two
problems:

1. **Losing track.** With five to ten sessions open, it is unclear which session is about what,
   which ticket it belongs to and whether a pull request is already open.
2. **Losing everything.** A PC restart or a WSL shutdown ends every open session. Finding them
   again and resuming each one with the right flags takes long.

The goal is one place that lists the sessions that matter, says what each one is doing, carries a
label, a group, a note and its pull requests, and brings a session back with one action.

Environment it is built for first: Windows 11 with WSL2 (Ubuntu), Claude Code as the native Linux
binary inside WSL, a terminal emulator running as a Windows program (WezTerm). Nothing in the core
may depend on one workspace, one directory layout or one ticket system.

## 2. Principles

These hold for every part of skydeck. A change that breaks one of them needs a change to this
section first.

1. **The real Claude Code.** skydeck never re-implements the conversation. A session is always the
   real `claude` program in a terminal, with its status line and subagent display.
2. **Read-only on Claude Code's data.** skydeck never writes to transcripts or to Claude Code's
   live-session files. Its only write into Claude Code's configuration is the hook entries that
   `skydeck install` adds to the user's settings file, and `skydeck uninstall` removes.
3. **A broken skydeck never disturbs a session.** The hook is silent, fast and always exits 0.
4. **Resume by id, with the session's own launch command.** Never by name (names are not unique).
   skydeck never adds a permission flag that the session was not started with.
5. **Nothing is destroyed or moved automatically.** "Done" only hides. Notes never move from one
   session to another by themselves. skydeck never stops a process unless the user asks.
6. **Never resume one session twice.** Two processes on one session interleave one transcript.
7. **Local only.** No network service, no account, no telemetry. The only network use is the
   `gh` command line for pull-request status.
8. **Everything that knows a Claude Code format lives in one module**, so a Claude Code update
   that changes a format changes one place.

## 3. Words used in this document

| Word | Meaning |
|---|---|
| session | One Claude Code conversation: a session id (UUID) and its transcript file. |
| process | One running `claude` program. It holds exactly one session at a time; which one can change while it runs (`/clear`, `/resume` typed inside it). |
| launch command | The exact command line a process was started with. |
| label | A short name for a session, set by the user. Shown as the row title. |
| group | An optional ticket key or topic. The list is grouped by it. |
| note | Free text attached to one session. |
| done | A mark that hides a session from the list. |
| open set | The sessions that were held by a running process at a given moment. |
| boot | One run of the Linux kernel (one life of the WSL virtual machine). |

## 4. Two steps

- **Step 1 — skydeck in the terminal.** Recording, the list, labels/groups/notes/done, pull
  requests, resume and restore. It works with the terminal the developer already uses. Specified
  in full below (sections 5–11).
- **Step 2 — the window.** A native Windows window with the session list on the left and the
  real terminal on the right, on top of the same data. Outlined in section 12; it gets its own
  detailed design before it is built.

## 5. Step 1: recording

### 5.1 Hooks

`skydeck install` adds hook entries for these Claude Code events to the user-level settings file
(`~/.claude/settings.json`): `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`,
`Notification`. Each entry runs the skydeck hook command, which stores one event row and exits.

What the hook stores per event:

| Field | Source |
|---|---|
| time | Clock at hook start (UTC, ISO 8601 with milliseconds). |
| event | `hook_event_name` from the hook input. |
| session id | `session_id` from the hook input. |
| cwd | `cwd` from the hook input. |
| source / reason | `source` on `SessionStart` (`startup`, `resume`, `clear`); `reason` on `SessionEnd` (`clear`, `resume`, `prompt_input_exit`, `other`, …). |
| process id | Environment variable `CLAUDE_PID` (the hook's own parent is a shell, not `claude`). |
| process start | Field 22 (`starttime`) of `/proc/<pid>/stat`. |
| boot id | Content of `/proc/sys/kernel/random/boot_id`. |
| launch command | `/proc/<pid>/cmdline`, split on NUL, stored as a JSON array. On `SessionStart` only. |
| model | `model` from the hook input, when present. |
| permission mode | `permission_mode` from the hook input, when present. |
| notification type | For `Notification`: the type/matcher field of the hook input. |
| name | `session_title` from the hook input, when present. |
| background work | For `Stop`: the number of entries in `background_tasks` and in `session_crons`. |

What the hook must **not** store: the prompt text (`UserPromptSubmit`), the assistant's message
(`Stop`), or any other conversation content.

Hook rules (principle 3):

- It prints nothing to stdout or stderr. (Claude Code adds the stdout of some hooks to the
  conversation.) Errors go to a log file in skydeck's state directory.
- It always exits 0, including when the database is locked, missing or corrupt, and when the
  runtime it needs is gone.
- The settings entry is written so that a missing skydeck is a silent no-op, and it carries a
  short timeout.
- It does one insert and no other work. All interpretation happens later, in the command.

### 5.2 Catch-up without hooks

Sessions can exist that no hook has seen: sessions started before `skydeck install`, or while
hooks were disabled. Every skydeck command therefore starts with a cheap reconcile step:

- It reads Claude Code's live-session files (`~/.claude/sessions/<pid>.json`) and keeps only the
  ones that pass the liveness rule (5.3).
- For each live process that has no event in the current boot, or whose file names a different
  session than the last event for that process, it stores an `Observed` event with the same
  fields as above (launch command from `/proc/<pid>/cmdline`).

Files ending in `.key` in that directory are credentials and are never opened.

### 5.3 Liveness rule

A process recorded as (boot id, pid, process start) is alive if and only if all of these hold:

1. the recorded boot id equals the current boot id;
2. `/proc/<pid>/stat` exists;
3. its `starttime` equals the recorded process start.

A live-session file is trusted only when its `pid` and `procStart` pass rule 2 and 3. Its `status`
field is ignored for dead processes. (Most files in that directory are leftovers of dead
processes, some with a process id that has since been reused.)

### 5.4 What a session is doing

State is derived from the events, in order, plus the liveness rule. Nothing else is stored.

For a process, the **held session** is the session id of its latest `SessionStart` or `Observed`
event. A process has **exited** when a `SessionEnd` arrives whose reason is neither `clear` nor
`resume` (those two mean "this process continues with another session").

| State of a session | Rule |
|---|---|
| working | Held by a live process; the latest turn event of that process for this session is `UserPromptSubmit`. |
| needs input | Held by a live process; the latest event is a `Notification` that asks for permission or input. |
| waiting for you | Held by a live process; the latest turn event is `Stop`. Shown with the time since that `Stop`. |
| idle | Held by a live process; no turn event yet since it was started or resumed. |
| not running | Not held by any live process. |
| ended unexpectedly | Not running, and the last process that held it is dead without an exit event (crash, kill, WSL shutdown). Shown as "was working" when its latest turn event was `UserPromptSubmit`. |

A session that no hook has seen and no live process holds is "not running"; its last activity
comes from its transcript.

### 5.5 When a process changes its session

Observed behaviour of Claude Code (section 13 lists how each was verified):

- `/clear` ends the current session and starts a new one in the same process: `SessionEnd`
  (reason `clear`, old id) is followed within a fraction of a second by `SessionStart` (source
  `clear`, new id). The session name set in Claude Code survives.
- `/resume` typed inside a session switches the process to an existing session: `SessionEnd`
  (reason `resume`, old id), then `SessionStart` (source `resume`, picked id).
- `claude --resume <id>` in a new process keeps the same session id and transcript file.

Rules:

- skydeck records a **link** old → new with its time and kind (`clear`, `switch`) whenever an end
  and a start of these kinds follow each other in one process.
- After `/clear`, the new session **inherits label and group** from the old one if it has none of
  its own. The list marks it as "continued". The **note stays** with the old session.
- After a switch nothing is inherited: the picked session keeps what it had.
- Neither session is ever marked done by these rules.

## 6. Step 1: what the user sees and does

### 6.1 Labels, groups, notes, done

- **Label.** One line. Displayed title of a row is the first that exists of: skydeck label; the
  name the user set in Claude Code (`/rename`, `-n`); Claude Code's generated title; the start
  time and directory. When skydeck starts or resumes a session that has a label, it passes the
  label to Claude Code as the session name, so the terminal tab shows it too.
- **Group.** One line, optional. If the user sets no group and the label starts with something
  that looks like a ticket key (configurable pattern, default `[A-Z][A-Z0-9]+-[0-9]+`), that key
  is the group. Sessions without a group are listed last under "no group".
- **Note.** Free text, any length, edited in `$EDITOR`.
- **Done.** Hides the session from the list. It never stops a process. A done session returns to
  the list by itself when it shows new activity after it was marked (a new event or a transcript
  change). `--all` shows done sessions too.
- **First run.** `skydeck install` offers to mark every session as done that has been inactive
  for more than a number of days (default 7) and is not held by a live process. The offer shows
  the count and is skipped unless confirmed.
- **Expired sessions.** Claude Code deletes transcripts after a retention period (30 days by
  default). skydeck keeps label, group, note and pull requests of such a session and shows it as
  "expired — cannot be resumed" until it is marked done.

### 6.2 Which sessions are listed

Every session that is known from events or from transcripts and is not hidden by "done", except:

- transcripts whose entry point is not the interactive command line (scripted and SDK runs);
- subagent transcripts (they live in nested folders);
- set-aside copies (`*.orphaned-*`, `*.superseded-*`): only files named `<uuid>.jsonl` count.

A session's project directory is the `cwd` of its first transcript record (the folder name under
`~/.claude/projects/` is a lossy encoding and is not parsed back).

### 6.3 Pull requests

- **Attached automatically:** pull requests in the session's `pr-link` transcript records. These
  mean "this session acted on that pull request" (created, pushed, commented, checked out), not
  "created it".
- **Suggested:** GitHub pull-request URLs that appear elsewhere in the session are offered for
  attaching with one action. They are not shown as attached.
- **Manual:** the user attaches a URL or detaches any pull request. A detached pull request stays
  detached even if a later record mentions it again.
- **Status** comes from `gh`: state (open, draft, merged, closed), review decision, and the
  combined result of the checks. All pull requests that need a refresh are fetched in **one**
  batched query. Merged and closed pull requests are never fetched again. Open ones are refreshed
  when the list is opened and their cached status is older than a few minutes (default 5).
- A pull request that cannot be read (no access, single sign-on required, deleted) is shown as
  "can't read" with the time of the last successful fetch — never as closed.
- A session often touches several pull requests in several repositories. A row shows one combined
  chip (worst state wins: failing checks, then changes requested, then pending, then all green);
  the detail view lists each pull request with its repository.

### 6.4 The list

`skydeck` with no arguments opens an interactive list when run in a terminal.

- Grouped by group; inside a group ordered by state (needs input, waiting for you, working,
  idle, ended unexpectedly, not running), then by last activity.
- The order is computed when the list opens or is refreshed. It does not change under the cursor.
- A row shows: state mark, title, how long it has been in that state, the pull-request chip, a
  mark when a note exists, a "continued" mark, and the short session id.
- All text that comes from transcripts or from GitHub is stripped of control characters and
  escape sequences before it is printed.

Keys: move (arrows, `j`/`k`), `Enter` open detail, `l` label, `g` group, `n` note, `d` done or
undo, `p` pull requests (attach suggested, attach URL, detach), `R` resume, `/` filter, `a` show
all, `r` refresh, `q` quit. The filter matches title, group, note, pull-request repository and
number, and directory.

When output is not a terminal, `skydeck` behaves like `skydeck ls`.

### 6.5 Commands

Every action in the list also exists as a command, for scripts and for the window in step 2.

| Command | Effect |
|---|---|
| `skydeck` | Interactive list. |
| `skydeck ls [--all] [--json]` | Print the list. `--json` is the stable machine format. |
| `skydeck show <ref>` | Everything about one session: state, directory, launch command, links, note, pull requests. |
| `skydeck label <ref> <text>` / `group <ref> <text>` | Set; an empty text clears. |
| `skydeck note <ref>` | Edit the note in `$EDITOR`. `--set <text>` sets it without an editor. |
| `skydeck done <ref>` / `undone <ref>` | Hide / show. |
| `skydeck pr add <ref> <url>` / `pr rm <ref> <url>` / `pr refresh` | Attach, detach, refresh status. |
| `skydeck new [--label <text>] [--group <text>] [-- <claude flags>]` | Start a new session in the current directory. |
| `skydeck resume <ref> [--here \| --tab] [--force]` | Resume one session (6.6). |
| `skydeck restore [--all] [--dry-run]` | Bring back what was open (6.7). |
| `skydeck install` / `uninstall` / `doctor` | Hooks and health (section 8). |
| `skydeck hook` | Internal: called by Claude Code. |

A `<ref>` is a session id, a unique prefix of one (at least 4 characters), or a label that
matches exactly one listed session. An ambiguous ref is an error that lists the candidates.

### 6.6 Resume

**The command.** skydeck takes the launch command recorded with the session's latest start event
and edits it:

- removed: `--resume`/`-r` and its value, `--continue`/`-c`, `--session-id` and its value,
  `--fork-session`, `--name`/`-n` and its value, and a prompt given as a positional argument;
- added: `--resume <session id>`, and `--name <label>` when the session has a label;
- kept: everything else, in order — including `--mcp-config`, `--settings`, `--add-dir`,
  `--model`, and a permission flag **if it was there**;
- never added: any permission flag.

The directory is the `cwd` recorded with that start event. For a session without a recorded
launch command (never seen by a hook), the command is plain `claude --resume <id>` in the
session's project directory, and skydeck says that the original flags are unknown.

**The guard (principle 6).** Before starting, skydeck runs the reconcile step and refuses when a
live process holds the session, naming the process. It then takes a per-session lock (an
exclusively created file that goes stale after one minute) so that two resumes started at the
same moment cannot both pass. `--force` skips the refusal, not the lock.

**Where.** `--here` (default) replaces the skydeck command with `claude` in the current terminal,
leaving no wrapper process behind. `--tab` opens a new tab in the terminal emulator named in the
configuration (first adapter: WezTerm through its command-line interface). If opening a tab
fails, skydeck prints the exact command instead.

### 6.7 Restore

`skydeck restore` lists the sessions that ended unexpectedly and are not done: after a reboot or
WSL shutdown, that is exactly the open set of the previous boot. Sessions that were working when
they died are marked. The user confirms the selection (all by default).

skydeck then resumes them in tabs, a few at a time (default 3): it starts a batch, waits until
each session has reported a start event, and continues. Before each batch it checks free memory
and stops with a message when less than a configured amount is available (default 4 GB), because
a session with its MCP servers can take one to three gigabytes.

With `--here`-only terminals (no tab adapter), restore resumes the first session in the current
terminal and prints the commands for the rest.

## 7. Data

One SQLite file, `~/.local/share/skydeck/skydeck.db`, opened in WAL mode with a busy timeout, so
that several hooks and a command can write at the same moment and a hard stop of the machine
loses at most the last transaction. File mode 600. Logs go to `~/.local/state/skydeck/`.
Configuration is `~/.config/skydeck/config.json`. The XDG environment variables are honoured, and
`SKYDECK_HOME` overrides all three locations (used by tests).

| Table | Content |
|---|---|
| `events` | Append-only hook and `Observed` events (5.1). Never updated. |
| `session_meta` | Per session: label, group, note, done time. |
| `links` | Old session → new session, kind, time (5.5). |
| `transcripts` | Per transcript file: session id, bytes already read, first `cwd`, entry point, titles, last record time, pull-request records seen, expired mark. |
| `prs` | Per pull-request URL: repository, number, title, state, review decision, checks, fetch time, last error. |
| `session_prs` | Session ↔ pull request, with origin (`auto`, `suggested`, `manual`) and a detached time. |
| `kv` | Schema version, last processed event id, timestamps. |

Rules:

- Schema changes go through numbered migrations that run inside one transaction.
- Transcripts are read incrementally from the stored byte offset. A last line without a newline
  is not consumed. A file that shrank is read again from the start.
- Deriving state (5.4), links and inheritance (5.5) is a pure function of the events and is done
  by the command, never by the hook.

Configuration keys (all optional): `terminal` (`here` or `wezterm`), `wezterm.domain`,
`groupPattern`, `firstRunDoneAfterDays`, `prRefreshMinutes`, `restoreBatch`, `restoreMinFreeMb`,
`claudeHome` (default `~/.claude`), `claudeCommand` (default `claude`).

## 8. Install, uninstall, doctor

- `skydeck install` shows the exact change to the settings file, asks, writes a backup next to
  it, and then adds the hook entries. Running it again changes nothing. Hook entries that belong
  to something else are left untouched. It then creates the database, runs the catch-up step and
  makes the first-run offer (6.1).
- `skydeck uninstall` removes exactly the entries skydeck added. The database stays unless
  `--purge` is given.
- `skydeck doctor` reports: hooks present and pointing at an existing command; the runtime path;
  database writable; time of the last event; `gh` available and logged in; the terminal adapter.

## 9. Technology

- **TypeScript on Node.js 24**, run directly through Node's type stripping. No bundler and no
  compiled output. Step 1 has **no runtime dependencies**: `node:sqlite`, `node:test`,
  `node:util`, `node:child_process`. Development dependencies: `typescript` (type checking only)
  and `@types/node`.
- Type stripping constraints, enforced by `tsconfig.json` (`erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`, `strict`): no enums, no
  namespaces, no parameter properties; imports name the `.ts` file.
- The `skydeck` launcher is a small shell script that calls the Node 24 binary by an absolute
  path chosen at install time, so it does not depend on the shell's default Node version.

## 10. Code layout

Each module has one job and can be tested without the others.

| Module | Job | Depends on |
|---|---|---|
| `src/store/` | Opens the database, migrations, typed read/write functions. The only code that contains SQL. | — |
| `src/hook.ts` | Reads one hook input, collects the process facts, inserts one event. | store |
| `src/claude/transcripts.ts` | Finds transcripts, reads new lines, extracts titles, entry point, first `cwd`, pull-request records and URLs. | store |
| `src/claude/live.ts` | Reads live-session files, the liveness rule, `/proc` access behind an interface. | — |
| `src/claude/launch.ts` | Parses a recorded launch command and builds the resume command (6.6). | — |
| `src/claude/settings.ts` | Adds and removes hook entries in the settings file. | — |
| `src/sessions/` | Reconcile, state derivation, links and inheritance, the restore set, the list model. | store, claude |
| `src/github.ts` | Batched pull-request status through `gh`, cache rules. | store |
| `src/terminals/` | Ways to start a command: `here`, `wezterm`. | — |
| `src/cli/` | Argument parsing, commands, the interactive list, text sanitising. | everything above |

Access to the clock, the file system roots, `/proc` and child processes goes through small
interfaces passed in, so tests use fakes and never touch the real home directory.

## 11. Testing

- Tests are written before the code they test.
- **State derivation:** event sequences with the expected state — start, turn, `/clear`,
  switch, exit, crash while working, reboot (boot id change), process id reuse.
- **Launch commands:** recorded command → resume command; flags with and without values,
  `--flag=value` forms, a positional prompt, permission flags kept but never added.
- **Transcripts:** a half-written last line, a truncated file, non-interactive entry points,
  set-aside copies, several pull-request records, hostile titles with escape sequences.
- **Liveness:** stale live-session files, a reused process id, a different boot.
- **Hook:** silent on success and on every failure; exits 0 with no database, a locked database
  and an unreadable `/proc`; ten hooks writing at once lose nothing.
- **Settings:** install twice changes once; uninstall restores the original bytes when nothing
  else changed; foreign hook entries survive.
- **End to end:** replay a recorded day of events into an empty database and compare
  `skydeck ls --json` with the expected output.
- Real hook inputs captured from Claude Code are used as fixtures after removing ids and paths.
- Tests never start the real `claude` and never read or write the real `~/.claude`.
- Continuous integration runs type checking and all tests on every pull request.

## 12. Step 2 outline: the window

Not specified in detail yet. What is already decided or known:

- **Shape.** Session list on the left; the real terminal of the selected session on the right
  (xterm.js); a header with title, group, pull requests, note and done.
- **Window.** A native Windows window, with all logic staying inside WSL. A Linux window shown
  through WSLg is not an option for the product: it disappears together with WSL, it scales
  badly on mixed-DPI screens and has a known input freeze after sleep. Fallback when a native
  window program is not allowed on the PC: an Edge app window, accepting that the browser keeps
  some Ctrl shortcuts.
- **Terminals are held by a small process separate from the app**, so that restarting or
  updating the app never ends a session. It also keeps each session's screen state, so that a
  reconnect shows the exact screen.
- **WSL lifetime.** The window keeps a helper process inside WSL alive. That keeps WSL up while
  the window is hidden and tells the window at once when WSL has stopped, so it can offer
  "restart and restore".
- **Keys follow the developer's terminal:** Ctrl+V pastes text, Ctrl+Shift+V sends the raw key
  (Claude Code's image paste), Shift+Enter inserts a newline, Ctrl+Click opens links; scrollback
  search; scrollback kept when switching sessions; non-US keyboard layouts.
- **Attention.** A "finished, not yet seen" mark, a key to jump to the next session that needs
  the user, and a desktop notification when the window is not focused.
- **Safety.** Titles and other foreign text are rendered as text, never as markup. Programs in a
  terminal can write to the clipboard but not read it. The local server listens on the loopback
  interface only and requires a secret and an exact origin.
- **Open.** Whether the PC allows the window program; whether WSL stays up with only a
  background process; whether opening terminal tabs from WSL works (also relevant to 6.6).

## 13. Claude Code behaviour this design relies on

Verified on Claude Code 2.1.3xx by driving the real program in a throwaway directory, unless
marked otherwise. All of it is isolated in `src/claude/` (principle 8).

| Fact | Status |
|---|---|
| Hooks receive `session_id`, `transcript_path`, `cwd`, `hook_event_name`; `SessionStart` has `source`; `SessionEnd` has `reason`. | observed |
| Inside a hook, `CLAUDE_PID` is the `claude` process and `/proc/<pid>/cmdline` is its exact launch command. | observed |
| `/clear` and in-session `/resume` produce an end/start pair in the same process within about 0.2 s. | observed |
| `claude --resume <id>` keeps the session id and appends to the same transcript. | observed |
| A session name is kept across `/clear`, is shown in the terminal title, and is not unique. | observed |
| Live-session files carry `pid`, `procStart`, `sessionId`, `status`; they are removed on a clean exit and left behind otherwise. | observed |
| `--mcp-config`, `--settings`, `--add-dir` are not restored by `--resume`; a permission flag on the command line overrides the restored mode. | documentation |
| Transcripts carry `ai-title`, `custom-title` and `pr-link` records. | observed (local files) |
| Transcripts are deleted after `cleanupPeriodDays` (default 30). | documentation |
| `--name` together with `--resume` renames the resumed session. | **to verify during implementation**; if not, the label is only passed for new sessions |
| The `Notification` hook input identifies permission and idle prompts. | **to verify during implementation** |

## 14. How changes are made

- One pull request per module or behaviour, from its own branch; nothing is pushed to `main`
  directly.
- Continuous integration must pass.
- Two independent reviews per pull request. Each review suggestion is checked against the code
  and this document before it is applied; rejected suggestions are answered with the reason.
- A change in behaviour updates this document in the same pull request.
