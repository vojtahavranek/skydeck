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
binary inside WSL, a terminal emulator running as a Windows program. Step 1 works on any Linux.
Nothing in the core may depend on one workspace, one directory layout, one ticket system or one
terminal emulator.

## 2. Principles

These hold for every part of skydeck. A change that breaks one of them needs a change to this
section first.

1. **The real Claude Code.** skydeck never re-implements the conversation. A session is always the
   real `claude` program in a terminal, with its status line and subagent display.
2. **Read-only on Claude Code's data.** skydeck never writes to transcripts or to Claude Code's
   live-session files. Its only write into Claude Code's configuration is the hook entries that
   `skydeck install` adds to the user's settings file, and `skydeck uninstall` removes.
3. **A broken skydeck never disturbs a session.** The hook is silent, fast and always exits 0. It
   does not depend on Node.js or on the database.
4. **No conversation content.** skydeck stores no prompt text and no assistant output — not in the
   database, not in the spool, not in logs, not in test fixtures.
5. **Resume by id, with the session's own launch command.** Never by name (names are not unique).
   skydeck never adds a permission flag that the session was not started with.
6. **Nothing is destroyed or moved automatically.** "Done" only hides. Notes never move from one
   session to another. skydeck never stops a process.
7. **Never resume one session twice.** Two processes on one session interleave one transcript.
8. **Local only.** No network service, no account, no telemetry. The only network use is the
   `gh` command line for pull-request status.
9. **Everything that knows a Claude Code format lives in `src/claude/`**, so a Claude Code update
   that changes a format changes one place. Other modules see normalised values only.

## 3. Words used in this document

| Word | Meaning |
|---|---|
| session | One Claude Code conversation: a session id (UUID) and its transcript file. |
| process | One running `claude` program, identified by (boot id, pid, process start). It holds exactly one session at a time; which one can change while it runs. |
| boot | One run of the Linux kernel (one life of the WSL virtual machine), identified by `/proc/sys/kernel/random/boot_id`. |
| launch command | The exact argument list a process was started with. |
| project directory | The directory a session belongs to: the `cwd` of its first transcript record. |
| label | A short name for a session, set by the user. |
| group | An optional ticket key or topic. The list is grouped by it. |
| note | Free text attached to one session. |
| done | A mark that hides a session from the list. |

## 4. Two steps

- **Step 1 — skydeck in the terminal.** Recording, the list, labels/groups/notes/done, pull
  requests, resume and restore. Specified in full in sections 5–12.
- **Step 2 — the window.** A native Windows window with the session list on the left and the real
  terminal on the right, on top of the same data. Outlined in section 13; it gets its own
  detailed design before it is built.

## 5. Recording

### 5.1 The hook

`skydeck install` adds two hook entries to the user-level settings file
(`<claudeHome>/settings.json`): `SessionStart` and `SessionEnd`. No other event is hooked in
step 1: what a running session is doing comes from Claude Code's live-session file (6.2).

The hook is `bin/skydeck-hook`, a POSIX `sh` script. It writes one small file per event into the
spool directory and exits. Rules (principle 3):

- It prints nothing to stdout or stderr. (Claude Code adds the stdout of some hooks to the
  conversation, and exit code 2 blocks.) Its own errors go to `hook.log` in the state directory.
- It always exits 0.
- It uses only `sh`, `date`, `cat`, `base64`, `mkdir` and `mv`.
- It does no interpretation. Everything else happens at ingest (5.3).

The settings entry for each event is exactly:

```json
{ "hooks": [ { "type": "command",
               "command": "'<hookPath>' SessionStart >/dev/null 2>&1 || true",
               "timeout": 5 } ] }
```

with the event name as the argument, where `<hookPath>` is
`<dataDir>/skydeck-hook`, a symlink that `install` points at the checkout's `bin/skydeck-hook`.

### 5.2 The spool file

Path: `<stateDir>/spool/<time_ns>-<claude_pid>-<random>.ev`, written under a temporary name in the
same directory and then renamed. Content: `key=value` lines, a line containing only `--`, then
the hook input from stdin unchanged.

| Key | Value |
|---|---|
| `v` | `1` |
| `event` | The argument: `SessionStart` or `SessionEnd`. |
| `time_ns` | `date +%s%N` at hook start. |
| `claude_pid` | `$CLAUDE_PID` (the hook's own parent is a shell, not `claude`). |
| `session_env` | `$CLAUDE_CODE_SESSION_ID`. |
| `entrypoint_env` | `$CLAUDE_CODE_ENTRYPOINT`, may be empty. |
| `boot_id` | Content of `/proc/sys/kernel/random/boot_id`. |
| `stat` | The line of `/proc/<claude_pid>/stat`, may be empty. |
| `pwd` | `$PWD`. |
| `argv_b64` | Base64 of `/proc/<claude_pid>/cmdline`. `SessionStart` only. |

The inputs of these two events contain no conversation content.

### 5.3 Ingest

Every skydeck command except `hook` starts with the same three steps, in this order:

1. **Ingest the spool.** Files are read in name order. Each becomes at most one row in `events`,
   keyed by the spool file name so that reading a file twice changes nothing; the file is deleted
   after its row is committed. A file that cannot be parsed is moved to `spool/bad/`.
2. **Reconcile with live processes** (5.4).
3. **Scan transcripts** (5.6).

Parsing (in `src/claude/hookinput.ts`) normalises each event:

- `session_id` comes from the hook input; `session_env` is the fallback.
- Process start is field 22 of `stat`, taken after the **last** `)` in the line.
- The launch command is the base64-decoded `cmdline` split on NUL, last empty element dropped.
- `SessionStart.source` → kind `start` with detail `startup`, `resume`, `clear`, `compact`,
  `fork`, or `unknown` for anything else.
- `SessionEnd.reason` → kind `end` with detail `clear` (reason `clear`), `switch` (reason
  `resume`), `exit` (reasons `prompt_input_exit`, `logout`), or `other` for anything else.
  The original string is stored as well.
- Relative values of the path flags `--mcp-config`, `--settings`, `--add-dir`, `--plugin-dir`
  in the launch command are made absolute against the event's `cwd` when that path exists.

**Scripted runs are dropped at ingest.** An event is discarded (and counted in `kv`) when its
launch command contains the argument `-p` or `--print`, or when `entrypoint_env` is set and is
not `cli`. User-level hooks also fire for `claude -p` and SDK runs; those are not sessions a
person works in.

**Links.** When a `start` event with detail `clear`, `resume` or `fork` is ingested for a process
whose previously held session (6.1) is a different session, a row old → new is written to
`links` with kind `clear`, `switch` or `fork`. Nothing is inherited or copied.

**Order.** "Earlier" and "latest" for events always mean ordering by (`time_ns`, `id`).

### 5.4 Reconcile with live processes

Reconcile covers sessions that no hook has reported: started before `skydeck install`, or whose
hook file was lost.

- It reads the files matching `^[0-9]+\.json$` in `<claudeHome>/sessions/`. No other file in that
  directory is ever opened.
- It keeps the files that pass the liveness rule (5.5), whose `entrypoint` is `cli` (or absent),
  and that were last modified more than 2 seconds ago.
- For each such process whose latest event does not name the file's `sessionId`, or that has no
  event with a launch command, it inserts an `observed` event with the process facts from `/proc`
  (launch command from `/proc/<pid>/cmdline`, `cwd` from the file).

An `observed` event never creates a link.

### 5.5 Liveness rule

A process recorded as (boot id, pid, process start) is alive if and only if:

1. the recorded boot id equals the current boot id, and
2. `/proc/<pid>/stat` exists, and
3. its start time (field 22, after the last `)`) equals the recorded process start.

A live-session file is trusted only when its `pid` and `procStart` satisfy 2 and 3.

### 5.6 Transcripts

Transcripts are `<claudeHome>/projects/<folder>/<uuid>.jsonl`. Only files whose name is exactly a
UUID plus `.jsonl` count; nested folders (subagent transcripts) and set-aside copies are ignored.
The folder name is a lossy encoding and is never parsed.

The scan reads each file incrementally from the stored byte offset; only files whose size or
modification time changed are opened. A last line without a newline is left for the next scan. A
file that shrank is read again from the start. From the records it keeps, per file: the session
id, the first `cwd` (the project directory), the `entrypoint`, the latest `ai-title` and
`custom-title`, the times of the first record, the last record and the last `user` record, and
the pull requests named in `pr-link` records. It keeps no text of any message.

A transcript whose `entrypoint` is not `cli` is recorded but its session is never listed.
A known transcript whose file has disappeared is marked missing with the time it was noticed.

The first scan on a machine reads everything once (hundreds of megabytes take some seconds); on a
terminal it shows a one-line progress indicator on stderr.

## 6. Derived state

All of this section is computed from `events`, the live-session files and `transcripts` each time
a command runs. None of it is stored.

### 6.1 Which process holds which session

For a process, the **held session** is the session id of its latest event that is not an `end`.
A process **stopped holding** a session when an `end` event for it arrives. An `end` with detail
`exit` is a **deliberate exit**; every other `end` detail, and no `end` at all, is not.

A session is **running** when a live process holds it. If two live processes hold the same
session (which principle 7 exists to prevent), the session is running, `show` lists both, and the
list marks it `duplicate`.

### 6.2 States

There are three states, plus one fallback.

| State | Rule |
|---|---|
| `working` | Running, and the holder's live-session file has `status` `busy`. |
| `waiting` | Running, and that `status` is `idle` or `waiting`. Shown as "waiting for you". `waitingFor`, when present, is shown as detail. |
| `running` | Running, but no live-session file can be read for the holder, or its `status` is another value. |
| `not-running` | Not running. |

The time a session has been in its state ("since") is: for `working` and `waiting`, the file's
`statusUpdatedAt` (falling back to `updatedAt`); for `running`, the time of the holder's latest
event; for `not-running`, the latest of its last transcript record and its last event.

### 6.3 Marks

Marks are shown next to the state.

| Mark | Rule |
|---|---|
| `ended-unexpectedly` | Not running, and its latest holding did not end with a deliberate exit: the last process that held it is dead and either still held it at its last event, or stopped holding it with an `end` of detail `other`. A session that a process left through `/clear`, `/resume` or a fork is **not** marked. |
| `was-working` | `ended-unexpectedly`, and a leftover live-session file of that dead process (same pid and process start) says `status` `busy`. |
| `continued` | The session is the target of a `clear` or `fork` link. `show` names the session it continues. |
| `expired` | Its transcript is missing. It cannot be resumed. |
| `expiring` | Its transcript was last modified more than (retention − 5) days ago, where retention is `cleanupPeriodDays` from the settings file, default 30. |
| `duplicate` | Two live processes hold it. |

## 7. What the user sees and does

### 7.1 Labels, groups, notes, done

- **Label.** One line, trimmed, not empty, not starting with `-`. The **title** of a row is the
  first that exists of: the skydeck label; the name set in Claude Code (`custom-title`); Claude
  Code's generated title (`ai-title`); otherwise the start time and the project directory name.
  When skydeck starts or resumes a session that has a label, it passes the label to Claude Code
  as the session name, so the terminal tab shows it. Claude Code itself keeps a session name
  across `/clear`.
- **Group.** One line, optional. When no group is set and the title starts with a ticket key
  (configuration `groupPattern`, default `^[A-Z][A-Z0-9]+-[0-9]+`), that key is the group.
- **Note.** Free text of any length, edited in `$EDITOR`.
- **Done.** Hides the session. It never stops a process. A done session is shown again when it
  has activity after the done time: a `user` record in its transcript, or a `start` event with
  detail `startup` or `resume`. Ending a session, an `observed` event or a re-read of the
  transcript is not activity.
- **First run.** `skydeck install` offers to mark as done every listed session whose last
  activity is older than `firstRunDoneAfterDays` (default 7) and that is not running. It shows
  the count and does nothing unless confirmed.

### 7.2 Which sessions are listed

Every session known from events or transcripts, except: sessions whose transcript has an
`entrypoint` other than `cli`; sessions hidden by done (shown with `--all`); and sessions that
are `expired` and have no label, group, note or pull request.

### 7.3 Pull requests

- **Key.** A pull request is identified by the lowercased URL
  `https://github.com/<owner>/<repo>/pull/<number>`. Anything after the number is stripped.
  Owner, repository and number are validated before use.
- **Automatic.** Pull requests named in a session's `pr-link` records are attached with origin
  `auto`. Such a record means the session acted on the pull request, not that it created it.
- **Manual.** `pr add` attaches with origin `manual` and clears an earlier detach. `pr rm`
  detaches; a detached pull request is not attached again by a later `pr-link` record.
- **Status** is fetched with `gh api graphql`, using query variables, in batches of at most 50
  pull requests per query, with a 10 second timeout. Per pull request it stores state (`open`,
  `draft`, `merged`, `closed`), review decision, the combined checks result, the time of the last
  successful fetch and the time and error of the last attempt.
- Merged and closed pull requests are never fetched again. Open ones are refreshed when their
  last successful fetch is older than `prRefreshMinutes` (default 5).
- `skydeck ls` and `show` print the cached status and never wait for the network. The
  interactive list paints from the cache, refreshes in the background and repaints.
  `skydeck pr refresh` fetches now.
- A pull request that cannot be read is shown as "can't read" with the time of its last
  successful fetch — never as closed.
- **Chip.** A row shows one chip for all attached pull requests: the worst state among them in
  this order — can't read, checks failing, changes requested, checks pending, review required,
  draft, approved and green, merged, closed — and the count.

### 7.4 The list

`skydeck` with no arguments opens the interactive list when stdin and stdout are terminals;
otherwise it behaves like `skydeck ls`.

- Groups are ordered by the most recent activity of a listed member; "no group" is last; ties by
  name. Inside a group: `waiting`, `working`, `running`, then `not-running` with
  `ended-unexpectedly` first; inside each of those by most recent activity.
- The order is computed when the list opens or is refreshed, and does not change under the cursor.
- A row shows: state, title, time in state, marks, the pull-request chip, a note mark, and the
  short id (first 8 characters of the session id).
- Every string that comes from a transcript, a live-session file or GitHub passes through the
  sanitiser, which removes control characters and escape sequences, when the list model is built.

Keys: arrows or `j`/`k` move; `Enter` detail; `l` label; `g` group; `n` note; `d` done or undo;
`p` pull requests; `R` resume; `/` filter; `a` show all; `r` refresh; `q` quit. The filter
matches title, group, note, pull-request repository and number, and project directory.

The interactive list is built as two pure functions — `reduce(model, key)` and
`render(model, size)` — with a thin terminal wrapper, so it is tested without a terminal.

### 7.5 Commands

| Command | Effect |
|---|---|
| `skydeck` | Interactive list. |
| `skydeck ls [--all] [--json]` | Print the list. |
| `skydeck show <ref> [--json]` | One session: state, marks, project directory, launch command, links, note, pull requests, holders. |
| `skydeck label <ref> [<text>]` / `group <ref> [<text>]` | Set; without text, clear. |
| `skydeck note <ref> [--set <text>]` | Edit in `$EDITOR`, or set directly. |
| `skydeck done <ref>` / `undone <ref>` | Hide / show. |
| `skydeck pr add <ref> <url>` / `pr rm <ref> <url>` / `pr refresh` | Attach, detach, fetch status. |
| `skydeck new [--label <text>] [--group <text>] [-- <claude flags>]` | Start a new session in the current directory (7.7). |
| `skydeck resume <ref> [--here \| --tab]` | Resume one session (7.6). |
| `skydeck restore [--all] [--dry-run] [--yes]` | Bring back what was open (7.8). |
| `skydeck install` / `uninstall [--purge]` / `doctor` | Section 8. |

**`<ref>`** is resolved in this order: a full session id; a unique id prefix of at least 4
characters, searched among all known sessions; a label equal to the text, searched among listed
sessions. No match or more than one match is an error that lists the candidates.

**Exit codes:** 0 success; 1 failure, or `doctor` found a problem; 2 usage error; 3 reference not
found or ambiguous; 4 resume refused; 5 restore stopped before finishing.

**`--json`** output of `ls` is stable and versioned:

```json
{ "version": 1, "generatedAt": "<ISO>",
  "sessions": [ { "id": "<uuid>", "shortId": "<8 chars>", "title": "", "titleSource": "label|name|generated|fallback",
                  "label": null, "group": null, "state": "working|waiting|running|not-running",
                  "stateDetail": null, "since": "<ISO>", "lastActivity": "<ISO>", "dir": "",
                  "marks": [], "hasNote": false, "continuedFrom": null, "done": false,
                  "prs": [ { "url": "", "repo": "<owner>/<repo>", "number": 0, "state": "",
                             "review": null, "checks": null, "okAt": null, "error": null } ] } ] }
```

Times are UTC ISO 8601 with milliseconds. Sessions are in list order. `show --json` prints one
session object with `note`, `launch` (argument list or null), `links` and `holders` added.

### 7.6 Resume

**The command.** skydeck takes the launch command of the session's latest `start` or `observed`
event that has one, and rewrites it. The program is the configured `claudeCommand` (default
`claude`), never the recorded first element. The recorded flags are parsed with a table of
Claude Code flags and their shapes (no value, one value, optional value, several values;
`--flag=value` is understood). A flag that is not in the table is kept, together with a following
argument that does not start with `-`.

- Removed: `--resume`/`-r` and its value, `--continue`/`-c`, `--session-id` and its value,
  `--fork-session`, `--name`/`-n` and its value, `--worktree`/`-w` and its value, `--bg`,
  `--from-pr` and its value, and positional arguments (an initial prompt).
- Added, directly after the program: `--resume <session id>`, then `-n <label>` when the session
  has a label.
- Kept, in order: everything else — including `--mcp-config`, `--settings`, `--add-dir`,
  `--model`, and a permission flag if it was there.
- Never added: a permission flag.

For a session without a recorded launch command the result is `claude --resume <id>`, and
skydeck says that the original flags are unknown. Environment variables that an alias or wrapper
set are not part of a launch command and are not restored.

**The directory** is the session's project directory. If it no longer exists, resume is refused.
A session without a transcript cannot be resumed.

**The guard (principle 7).** Resume runs ingest and reconcile and refuses (exit 4) when the
session is running, naming the holder. It then creates a lock file for the session exclusively;
if the lock exists and is younger than 60 seconds, resume is refused and says how long to wait.
The lock is removed when a `start` event for the session appears or after 60 seconds.

**Where.** `--here` replaces skydeck with `claude` in the current terminal: the command line tool
hands the directory and the argument list back to the `bin/skydeck` launcher through a handoff
file, and the launcher `exec`s it, so no wrapper process stays behind. `--tab` opens a new tab
through the terminal adapter named in the configuration (first adapter: WezTerm). The default is
the configured `terminal`. If opening a tab fails, skydeck prints the command instead, quoted for
a POSIX shell. Commands are always run as argument lists, never through a shell string.

### 7.7 New

`skydeck new` generates a session id, stores the label and group for it, and starts
`claude --session-id <uuid> [-n <label>] <flags after -->` in the current directory, with the
same `--here` / `--tab` choice as resume.

### 7.8 Restore

**The set.** By default: the sessions marked `ended-unexpectedly`, not done and not expired,
whose last holder belongs to the **latest earlier boot** in which any session was held. `--all`
adds every other session marked `ended-unexpectedly`, from any boot including the current one.

**The selection.** Each entry shows how it ended (no exit recorded, or ended at a time) and
`was-working`. Preselected are the entries with no exit recorded and those that ended within two
minutes of that boot's last event; entries that ended earlier are listed unselected. The user
confirms or changes the selection. `--yes` accepts the preselection and is required when stdin is
not a terminal. `--dry-run` prints the set and the commands and exits 0.

**Running it.** Sessions are resumed in tabs, `restoreBatch` at a time (default 3). After
starting a batch, restore waits until each of its sessions has a `start` event, checking once a
second, for at most `restoreStartTimeoutSeconds` (default 120). Before each batch it reads
`MemAvailable` from `/proc/meminfo` and stops (exit 5) when it is below `restoreMinFreeMb`
(default 4096), listing what was not started. A session that does not start in time is reported
and skipped.

Without a tab adapter, restore resumes the first selected session `--here` and prints the
commands for the others.

## 8. Install, uninstall, doctor

- **`skydeck install`**: (1) creates the data, state and configuration directories and the
  database; (2) creates the links `<dataDir>/skydeck-hook` and `~/.local/bin/skydeck`, and
  `<dataDir>/node` pointing at the Node.js binary it runs under; (3) shows the exact change to
  `<claudeHome>/settings.json`, asks, writes a backup beside it, adds the two hook entries and
  records a hash of the resulting file; (4) runs ingest, reconcile and the first transcript scan;
  (5) makes the first-run offer (7.1). Running it again changes nothing. Hook entries that belong
  to something else are never touched.
- **`skydeck uninstall`**: restores the backup when the settings file still has the recorded
  hash; otherwise removes exactly the entries whose command names `<hookPath>`. Removes the
  links. The database stays unless `--purge` is given.
- **`skydeck doctor`** reports and exits 1 on any problem: hook entries present and `<hookPath>`
  resolvable; Node.js version; database writable; spool size and files in `spool/bad/`; age of
  the last event; the last lines of `hook.log`; scripted runs dropped; `gh` present and logged
  in; the terminal adapter.

`docs/install.md` is the guide for setting skydeck up on another machine.

## 9. Data

### 9.1 Places

| Name | Default | Holds |
|---|---|---|
| `dataDir` | `${XDG_DATA_HOME:-~/.local/share}/skydeck` | `skydeck.db`, the `node` and `skydeck-hook` links. |
| `stateDir` | `${XDG_STATE_HOME:-~/.local/state}/skydeck` | `spool/`, `locks/`, `hook.log`. |
| `configDir` | `${XDG_CONFIG_HOME:-~/.config}/skydeck` | `config.json`. |
| `claudeHome` | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | Claude Code's own files. |

`SKYDECK_HOME`, when set, replaces the first three with `$SKYDECK_HOME/data`, `/state`,
`/config`; tests use it. The hook resolves `stateDir` by the same rule.

Configuration keys, all optional: `terminal` (`here` or `wezterm`), `wezterm.domain`,
`groupPattern`, `firstRunDoneAfterDays`, `prRefreshMinutes`, `restoreBatch`, `restoreMinFreeMb`,
`restoreStartTimeoutSeconds`, `claudeHome`, `claudeCommand`. Unknown keys are an error.

### 9.2 Database

SQLite through `node:sqlite`, used only inside `src/store/`. Every connection sets
`journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000` and `foreign_keys=ON`. The file has
mode 600. Write transactions are short. Schema changes are numbered migrations, each run in one
transaction; the version is in `kv`.

Migration 1:

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  spool_name  TEXT UNIQUE,              -- NULL for observed events
  time_ns     INTEGER NOT NULL,
  kind        TEXT NOT NULL,            -- start | end | observed
  detail      TEXT NOT NULL,            -- see 5.3; '' for observed
  raw_detail  TEXT,                     -- source / reason as received
  session_id  TEXT NOT NULL,
  boot_id     TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  proc_start  INTEGER,                  -- NULL when /proc could not be read
  cwd         TEXT,
  argv        TEXT,                     -- JSON array; start and observed only
  name        TEXT,
  payload     TEXT                      -- hook input as received (start/end only)
);
CREATE INDEX events_by_process ON events (boot_id, pid, time_ns, id);
CREATE INDEX events_by_session ON events (session_id, time_ns, id);

CREATE TABLE session_meta (
  session_id  TEXT PRIMARY KEY,
  label       TEXT,
  group_name  TEXT,
  note        TEXT,
  done_at_ns  INTEGER,
  created_ns  INTEGER NOT NULL,
  updated_ns  INTEGER NOT NULL
);

CREATE TABLE links (
  event_id      INTEGER PRIMARY KEY REFERENCES events(id),
  from_session  TEXT NOT NULL,
  to_session    TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- clear | switch | fork
  time_ns       INTEGER NOT NULL
);
CREATE INDEX links_to ON links (to_session);

CREATE TABLE transcripts (
  path             TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  size_read        INTEGER NOT NULL,
  file_size        INTEGER NOT NULL,
  mtime_ns         INTEGER NOT NULL,
  first_cwd        TEXT,
  entrypoint       TEXT,
  ai_title         TEXT,
  custom_title     TEXT,
  first_record_ns  INTEGER,
  last_record_ns   INTEGER,
  last_user_ns     INTEGER,
  missing_since_ns INTEGER
);
CREATE INDEX transcripts_by_session ON transcripts (session_id);

CREATE TABLE prs (
  url          TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT,
  state        TEXT,                    -- open | draft | merged | closed
  review       TEXT,
  checks       TEXT,
  ok_at_ns     INTEGER,
  tried_at_ns  INTEGER,
  error        TEXT
);

CREATE TABLE session_prs (
  session_id     TEXT NOT NULL,
  url            TEXT NOT NULL REFERENCES prs(url),
  origin         TEXT NOT NULL,         -- auto | manual
  first_seen_ns  INTEGER NOT NULL,
  detached_at_ns INTEGER,
  PRIMARY KEY (session_id, url)
);

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

## 10. Technology

- **TypeScript on Node.js 24.12 or later**, run directly through Node's type stripping, with the
  compile cache on. No bundler, no compiled output. Step 1 has **no runtime dependencies**
  (`node:sqlite`, `node:test`, `node:util`, `node:child_process`). Development dependencies:
  `typescript` (type checking only) and `@types/node`.
- `tsconfig.json` enforces what type stripping needs: `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`, `strict`. No enums, namespaces
  or parameter properties; imports name the `.ts` file; type-only imports use `import type`.
- `bin/skydeck` is a `sh` launcher. It picks the Node.js binary — `$SKYDECK_NODE`, else
  `<dataDir>/node`, else `node` on `PATH` — and a small plain-JavaScript bootstrap refuses
  versions older than 24.12 with a clear message.
- `bin/skydeck-hook` is `sh` only (5.1). Measured on the target machine: about 8 ms per event,
  against about 110 ms for a Node.js hook that opens the database.
- `node:sqlite` is a release candidate in Node.js 24 and renames its classes in Node.js 26;
  keeping it inside `src/store/` limits that change to one module.

## 11. Code layout

| Module | Job | May import |
|---|---|---|
| `bin/skydeck-hook` | The hook (5.1, 5.2). | — |
| `src/platform/` | Interfaces and real implementations for clock, files, `/proc`, running programs; resolving the places in 9.1; reading the configuration. | — |
| `src/text/` | The sanitiser; shell quoting. | — |
| `src/store/` | The database: connection settings, migrations, typed functions. The only SQL. | platform |
| `src/claude/hookinput.ts` | Parses a spool file into a normalised event (5.3). | text |
| `src/claude/live.ts` | Reads live-session files; the liveness rule (5.5). | platform |
| `src/claude/transcripts.ts` | Finds and incrementally reads transcripts (5.6). | platform |
| `src/claude/launch.ts` | The flag table; builds resume and new commands (7.6, 7.7). | — |
| `src/claude/settings.ts` | Adds and removes hook entries; reads `cleanupPeriodDays`. | platform |
| `src/sessions/` | Ingest, reconcile, the transcript scan, derived state and marks (6), the list model, reference resolution, the resume guard and lock, restore planning and running. | platform, text, store, claude, terminals (as an interface) |
| `src/github.ts` | Pull-request keys, batched status, cache rules (7.3). | platform, store |
| `src/terminals/` | The terminal interface and its implementations: `here` (handoff file), `wezterm`. | platform, text |
| `src/cli/` | Arguments, commands, output formats, the interactive list. | everything above |

Nothing outside `src/claude/` reads a Claude Code file or names a Claude Code field. Nothing
outside `src/platform/` reads the clock, the environment, `/proc` or starts a program; every
module takes those as parameters, so tests pass fakes.

## 12. Testing

- Tests are written before the code they test, with `node:test`.
- Tests never start the real `claude`, never read or write the real `~/.claude`, and never use
  the network. They run under a temporary `SKYDECK_HOME` and a temporary `claudeHome`.
- **Fixtures** live in `test/fixtures/claude/`: one hook input per event and detail, a spool file
  per event, live-session files (live, stale, reused pid), and one transcript line per record
  type used here. They keep the real field names and shapes; ids, paths and names are replaced,
  and they contain no conversation text (principle 4).
- What must be covered:
  - **Hook:** the spool file it writes; silent and exit 0 with an unwritable state directory, an
    unreadable `/proc`, and no `CLAUDE_PID`; ten hooks at once produce ten files.
  - **Ingest:** each event and detail; a file read twice; a bad file; scripted runs dropped;
    links for clear, switch and fork; path flags made absolute.
  - **Derived state:** start, clear, switch, deliberate exit, exit by signal, crash, reboot (boot
    id change), reused pid, two holders; each state and each mark.
  - **Transcripts:** half-written last line, shrunk file, other entry points, set-aside copies,
    several `pr-link` records, hostile titles.
  - **Launch commands:** every removed and kept flag, `--flag=value`, several-value flags
    followed by a prompt, unknown flags, a label, no recorded command.
  - **List:** order of groups and rows, the chip, filters, reference resolution, `reduce` and
    `render` of the interactive list.
  - **Resume and restore:** the guard and the lock with a fake clock; batches, the start timeout
    and the memory stop with a fake terminal; the default set and `--all`; the preselection.
  - **Pull requests:** key normalisation, attach/detach rules, cache rules, an unreadable pull
    request, a `gh` timeout — with a fake `gh`.
  - **Settings:** install twice changes once; uninstall with and without the recorded hash;
    foreign hook entries survive.
  - **Commands:** exit codes; `ls --json` against a recorded day of events (end to end).
- Continuous integration runs type checking, all tests and `shellcheck` on every pull request.

## 13. Step 2 outline: the window

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
- **Safety.** Foreign text is rendered as text, never as markup. Programs in a terminal can
  write to the clipboard but not read it. The local server listens on the loopback interface
  only and requires a secret and an exact origin.
- **Open.** Whether the PC allows the window program; whether WSL stays up with only a
  background process; whether opening terminal tabs from WSL works (also relevant to 7.6).

## 14. Claude Code behaviour this design relies on

Observed on Claude Code 2.1.3xx by driving the real program in a throwaway directory or by
inspecting local files, unless marked otherwise.

| Fact | Status |
|---|---|
| Hook inputs carry `session_id`, `transcript_path`, `cwd`, `hook_event_name`. `SessionStart` adds `source` (`startup`, `resume`, `clear`; `compact` and `fork` per documentation) and, when a name is set, `session_title`. `SessionEnd` adds `reason` (`clear`, `resume`, `prompt_input_exit`; `other` on SIGTERM; `logout` per documentation). | observed / documentation |
| Inside a hook, `$PPID` is a shell; `$CLAUDE_PID` is the `claude` process; `$CLAUDE_CODE_SESSION_ID` equals the input's `session_id`; `/proc/<pid>/cmdline` is the exact launch command and does not change on an in-session `/resume`. | observed |
| Hook stdout can enter the conversation; exit code 2 blocks; `SessionEnd` hooks share a budget of about 1.5 s. | documentation |
| `/clear` and in-session `/resume` produce an `end`/`start` pair in the same process about 0.2 s apart; compaction keeps the session id. | observed |
| `claude --resume <id>` keeps the session id and appends to the same transcript. | observed |
| A session name survives `/clear`, is shown in the terminal title (`✳ <name>`), and is not unique. | observed |
| Live-session file `<claudeHome>/sessions/<pid>.json`: `pid`, `sessionId`, `cwd`, `startedAt`, `procStart` (equal to `/proc/<pid>/stat` field 22), `kind`, `entrypoint`, `name`, `nameSource`, `status` (`idle`, `busy`, `waiting`), `updatedAt`, `statusUpdatedAt`, `waitingFor`. Rewritten in place when the process changes session; removed on a clean exit; left behind otherwise. The directory also holds credential files with other names. | observed |
| `status` is `busy` from prompt submit until the turn ends, `idle` afterwards, `waiting` while a dialog is open. | observed |
| Transcript records: `ai-title` (`aiTitle`), `custom-title` (`customTitle`), `agent-name` (`agentName`), `pr-link` (`prUrl`, `prRepository`, `prNumber`); records carry `sessionId`, `cwd`, `entrypoint` (`cli` for interactive) and `timestamp`. | observed (local files) |
| `--mcp-config`, `--settings`, `--add-dir`, `--plugin-dir` are not restored by `--resume`; a permission flag on the command line overrides the restored mode. | documentation |
| Transcripts are deleted after `cleanupPeriodDays` (default 30). | documentation |
| `--session-id <uuid>` starts a session with a chosen id. | documentation |
| `-n <name>` together with `--resume` names the resumed session. | **to verify during implementation**; if not, the label is passed for new sessions only |
| Which `SessionEnd` reason, if any, is reported when the terminal is closed (SIGHUP). | **to verify during implementation**; the rules in 6.3 and 7.8 hold either way |
| `$CLAUDE_CODE_ENTRYPOINT` in a hook's environment names the entry point. | **to verify during implementation**; the `-p`/`--print` rule holds either way |

## 15. How changes are made

- One pull request per module or behaviour, from its own branch; nothing is pushed to `main`
  directly.
- Continuous integration must pass.
- Two independent reviews per pull request. Each review suggestion is checked against the code
  and this document before it is applied; rejected suggestions are answered with the reason.
- A change in behaviour updates this document in the same pull request.

## 16. Left out of step 1 on purpose

- Hooks for turn events (`Stop`, `UserPromptSubmit`, `Notification`) and notifications — step 2.
- Suggesting pull requests from URLs mentioned in a session.
- Inheriting labels or groups across `/clear` (Claude Code keeps the session name itself).
- Jumping to a terminal tab that is already open.
- macOS (no `/proc`); the process facts sit behind `src/platform/` for that reason.
