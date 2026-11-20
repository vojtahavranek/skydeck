# skydeck — design

Status: agreed design for step 1; step 2 is designed in [design-step-2.md](design-step-2.md).
This document is the source of truth for implementation; when the code and this document disagree,
one of them has a bug.

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
   live-session files. Its only write into Claude Code's configuration on its own account is the
   hook entries that `skydeck install` adds to the user's settings file, and `skydeck uninstall`
   removes. The one other write is the user's own choice, made through install after a yes to its
   question: the global key `leftArrowOpensAgents` set to `false` in Claude Code's global config
   file, nothing else of that file changed (8; follow-up F11, design-step-2.md 7.9). Uninstall
   leaves it: it is the user's setting in Claude Code, and skydeck cannot tell who set it.
3. **A broken skydeck never disturbs a session.** The hook is silent, fast and always exits 0. It
   does not depend on Node.js or on the database.
4. **No conversation content.** skydeck stores no prompt text and no assistant output — not in the
   database, not in logs, not in test fixtures. The one exception is the spool: a prompt passed on
   the command line is part of the recorded launch command and can sit in a private spool file
   until ingest drops it before storing anything. A spool file that cannot be parsed is kept in
   `spool/bad/` for diagnosis and removed after seven days; a leftover temporary file is removed
   after one hour. An argument that follows a flag skydeck does not know is dropped; the flag's
   name is kept so that a resume can say it was not passed on.
5. **Resume by id, with the session's own launch command.** Never by name (names are not unique).
   skydeck never adds a permission flag that the session was not started with.
6. **Nothing is destroyed or moved automatically.** "Done" only hides. Notes never move from one
   session to another. skydeck never stops a process by itself; the window ends a session's
   program only when the user asks for it there, in its dialog, each time (design-step-2.md 2,
   12.5). This is about the user's data (sessions, labels, groups, notes), not skydeck's own
   transient files (5.3). The one exception is the label and group skydeck itself has just stored
   for a `new` session that never started (7.7).
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
- **Step 2 — the window.** A window on the Windows desktop with the session list on the left and
  the real terminal on the right, on top of the same data. Summarised in section 13 and specified
  in [design-step-2.md](design-step-2.md).

## 5. Recording

### 5.1 The hook

`skydeck install` adds two hook entries to the user-level settings file
(`<claudeHome>/settings.json`): `SessionStart` and `SessionEnd`. No other event is hooked in
step 1: what a running session is doing comes from Claude Code's live-session file (6.2).

The hook is `bin/skydeck-hook`, a POSIX `sh` script. It writes one small file per event into the
spool directory and exits. Rules (principle 3):

- It prints nothing to stdout or stderr. (Claude Code adds the stdout of some hooks to the
  conversation, and exit code 2 blocks.) Its own errors go to `hook.log` in the state directory,
  one line each: a newline inside an error message becomes a space, so every line starts with its
  time.
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

`<random>` is the hook shell's own process id (`$$`): the programs 5.1 allows include no source of
randomness, and two hooks alive at the same time never share a process id. The temporary name is
`.<final name>.tmp`, and ingest reads only names ending in `.ev`, so a half-written file is never
read. A missing `CLAUDE_PID` gives an empty `claude_pid` value and `0` in the name; so does one
that is not a number (it is never put into a path). The spool directory is created with mode 700 and
the files readable by the user only, because `pwd` and the launch command are private. A value taken
from the environment or the argument that contains a newline or a carriage return is written empty,
so no value can add a line to the file.

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

Every skydeck command that works on sessions (`ls`, `show`, `label`, `group`, `note`, `done`,
`undone`, `pr`, `new`, `resume`, `restore` and the interactive list) starts with the same three
steps, in this order. `install` runs them after it has made its links and changed the settings
(8); `doctor` and `uninstall` do not run them (8); the hook is a script, not a command, and
does none of this:

1. **Ingest the spool.** Files are read in name order. Each becomes at most one row in `events`,
   keyed by the spool file name so that reading a file twice changes nothing; the file is deleted
   after its row is committed. A file that cannot be read or parsed is moved to `spool/bad/`.
   Files in `spool/bad/` older than seven days are removed, and so are leftover `.<name>.tmp`
   files in `spool/` older than one hour (a younger one may belong to a running hook).
2. **Reconcile with live processes** (5.4).
3. **Scan transcripts** (5.6).

A refresh that failed would make every command fail, so no single spool file, live process,
folder or transcript can stop it: item-caused errors are recorded and skipped, whether they come
from reading the item or from saving it. That one is skipped (a spool file whose event cannot be
saved stays in the spool for the next refresh), and a line naming it and why (never its content)
is kept in the database for `skydeck doctor` (8) until the next refresh. Database-wide errors
(locked, read-only, I/O, corrupt, full) stop the refresh at once and end the command.

Parsing (in `src/claude/hookinput.ts`) normalises each event:

- `session_id` comes from the hook input; `session_env` is the fallback.
- Process start is field 22 of `stat`, taken after the **last** `)` in the line.
- An event without `claude_pid` (the value is empty) is stored with `pid` 0 and `proc_start` NULL; it
  belongs to no live process.
- The launch command is the base64-decoded `cmdline` split on NUL, last empty element dropped,
  and then reduced to what a resume keeps of it (7.6): positional arguments and the flags that
  carry prompt text or choose the session are dropped, because an initial prompt on the command
  line is conversation text (principle 4); only the other flags and their values are stored, so a
  resume from the stored command is the same as from the recorded one. A flag that skydeck does
  not know is stored as its bare name: what follows it cannot be classified, and may be a prompt.
  Reconcile (5.4) applies the same rule to the command line it reads itself.
- A file in which a key appears twice before the `--` line cannot be parsed; it goes to `spool/bad/`.
  An empty `pwd`, `session_env` or `entrypoint_env` means "unknown".
- `SessionStart.source` → kind `start` with detail `startup`, `resume`, `clear`, `compact`,
  `fork`, or `unknown` for anything else.
- `SessionEnd.reason` → kind `end` with detail `clear` (reason `clear`), `switch` (reason
  `resume`), `exit` (reasons `prompt_input_exit`, `logout`), or `other` for anything else.
  The original string is stored as well.
- Relative values of the path flags `--mcp-config`, `--settings`, `--add-dir`, `--plugin-dir`
  in the launch command are made absolute against the event's `cwd` when that path exists.
  A later `start` of a process (same boot, pid and process start) that already has a `start` with a
  stored launch command is stored with the command of the first such start instead: the command line of a process never
  changes, but after `/clear`, an in-session `/resume` or a change of directory the hook input's
  `cwd` need not be the directory the process was launched in.

**Scripted runs.** An event is **scripted** when its launch command, as recorded, has the print
flag — `-p` or `--print`, alone or inside a cluster of short flags such as `-cp` — or when
`entrypoint_env` is set and is not `cli`. An end event has no launch command, so there only the
entry point decides. User-level hooks also fire for `claude -p` and SDK runs; those are not
sessions a person works in, and nearly all of them start a session of their own, so scripted
events are **dropped** at ingest (and counted in `kv`) — with the two exceptions below. A scripted `start` of
a process (it has a pid and a process start time) on a session skydeck already knows — an event names it, or it has a
transcript that would be listed (entry point `cli`, or none; 7.2) — is kept as an event of kind
`scripted`: `claude -p --resume <id>` or `claude -p -c` appends to that session's transcript, and
must count as holding it, or a resume would start it a second time (principle 7). Such an event
says only that its process holds the session while the process is alive (6.1); it has no detail,
launch command or name, makes no link, and is never the session's launch command, directory,
activity after done, last holding (6.3), or the start that releases a resume lock or that restore
waits for (7.6, 7.8). The liveness rule (5.5) ends the holding when the process exits; a
`claude -p` run holds one session for its whole life. An SDK host or an editor extension can clear
or switch inside one process, so the scripted `end` of the session that a kept scripted start
holds is kept too, as an event of kind `scripted-end`: the process no longer holds that session.
It is never a session's last holding and never gives a mark. Every other scripted end is dropped.
A scripted start that is ingested before the session was ever recorded or scanned (the
first refresh after `skydeck install`) is dropped too: skydeck does not know the session yet.

**Links.** When a `start` event with detail `clear`, `resume` or `fork` is ingested for a process
whose previously held session (6.1) is a different session, a row old → new is written to
`links` with kind `clear`, `switch` or `fork`. Nothing is inherited or copied.

**Copies** (follow-up F33). A process started with `--fork-session` together with `--resume` (or
`-r`) whose value is a session id, or a path whose last part is `<session id>.jsonl`, holds as its
first session a NEW session that is a copy of that id: Claude Code's background feature (agent
view, `/bg`) starts `claude --fork-session --resume <the original's transcript>`, and a user can
type it. Only that id is kept, never the value (principle 4: a value can be a search term), as a
row original → copy of kind `copy` in `links`, on the process's first event (its `start` or
`observed` one, or its `end` when the spool file of its first start was lost: its session is the
earliest the process is known to have held; never a scripted run's), written once per session:
at ingest, when a non-scripted `start` is recorded with
such a command (whatever its detail: which `source` Claude Code sends for a copy is not known,
14), and at reconcile (5.4) from the command line of a process that still runs. A copy of an id
skydeck does not know is recorded all the same; a process whose first event names the id itself
makes no copy; `--resume` alone, `--fork-session` alone, or a value that is neither (a name Claude
Code searches for) make no copy. Sessions recorded before follow-up F33 get the link only if their
process still runs at a later reconcile: nothing else is rewritten. A known limit: when the first
event skydeck has of a copy's process is already that of a session the process `/clear`ed into —
the spool files of both the copy's start and its end were lost, or no hook spoke at all and
reconcile is the first to see a process that had cleared already (it started before `skydeck
install`, or its hook did not run) —, that cleared session is linked in the copy's place. It heals
itself at that session's first prompt (7.2).

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
  (launch command from `/proc/<pid>/cmdline`, `cwd` from the file). The event's time is the clock
  at reconcile, and its launch command is reduced and its path flags made absolute exactly as for a
  spooled one (5.3).
- A file that names another session than the process's latest event wins only when it was
  modified after that event (the hook of the change was lost). When the event is newer, the hook
  spoke after the file was last written — an in-session `/resume` or `/clear` records the new
  session while the file can still name the old one — so the file is stale and nothing is
  inserted; a missing launch command is added once the file names that session too. An `observed`
  event is not the hook speaking: it is stamped with the clock at reconcile, after the file it was
  read from, so a file that names another session than it always wins (the file changed since).

An `observed` event never creates a `clear`, `switch` or `fork` link. Follow-up F33: a candidate
process whose command line makes a copy (5.3 "Copies") gets the `copy` link on its first event
when it has none yet — the `observed` event just inserted, or the event a hook or an earlier
reconcile recorded —, so a copy recorded before skydeck knew of copies is linked while its process
still runs.

### 5.5 Liveness rule

A process recorded as (boot id, pid, process start) is alive if and only if:

1. the recorded boot id equals the current boot id, and
2. `/proc/<pid>/stat` exists, and
3. its start time (field 22, after the last `)`) equals the recorded process start.

A live-session file is trusted only when its `pid` and `procStart` satisfy 2 and 3.

"Does not exist" means exactly that: the file is not there. When the boot id or
`/proc/<pid>/stat` cannot be read for another reason (no permission, too many open files), the
process is neither alive nor dead but unknown, and nothing is decided on it: the command stops
with the error, except in the refresh's reconcile, which records an unreadable process and leaves
it for the next run. (With `/proc` mounted `hidepid`, a recorded pid that another user's process
has taken reads that way, and commands that load the sessions fail until that process ends.)

### 5.6 Transcripts

Transcripts are `<claudeHome>/projects/<folder>/<uuid>.jsonl`. Only files whose name is exactly a
UUID plus `.jsonl` count; nested folders (subagent transcripts) and set-aside copies are ignored.
The folder name is a lossy encoding and is never parsed.

The scan reads each file incrementally from the stored byte offset; only files whose size or
modification time changed are opened. A last line without a newline is left for the next scan. A
file that shrank, or was replaced (the byte before the stored offset is not a newline), is read
again from the start. From the records it keeps, per file: the session
id, the first `cwd` (the project directory), the `entrypoint`, the latest `ai-title` and
`custom-title`, the times of the first record, the last record and the last `user` input, the type
of the last record that is an `assistant` record or a `user` turn, and the pull requests named in
`pr-link` records. A `user` record is a **turn** (the model answers it or is working on it: a
prompt, a message from another agent, a scheduled wakeup, a tool result) when it carries a
`turnOrigin`, whatever its value; one without a `turnOrigin` (an older version) is a turn unless it
is marked meta, is a compaction summary or a sidechain record, or is what a command typed at the
prompt leaves (a slash command or a `!` command, its output, an interrupt marker). A `user`
record is **input** (the user did it themselves) when its `turnOrigin` is `human`; one without a
`turnOrigin` is input when it is a turn, not a tool result and not sourced by the system
(`promptSource` `system`, which is how older versions wrote the notice of a finished background
task). The text of a record is compared with those markers and dropped. It keeps no text of any
message.

A transcript whose `entrypoint` is not `cli` is recorded but its session is never listed.
A known transcript whose file has disappeared is marked missing with the time it was noticed.
A folder or file that cannot be read does not stop the scan: the rest is read, and a transcript at
or under what could not be read is not marked missing; `skydeck doctor` names what could not be
read (8).

The first scan on a machine reads everything once (hundreds of megabytes take some seconds); on a
terminal it shows a one-line progress indicator on stderr.

## 6. Derived state

All of this section is computed from `events`, the live-session files and `transcripts` each time
a command runs. None of it is stored.

### 6.1 Which process holds which session

For a process, the **held session** is the session id of its latest event that is not an `end`.
A process **stopped holding** a session when an `end` event for it arrives. An `end` with detail
`exit` is a **deliberate exit**; every other `end` detail, and no `end` at all, is not. A
`scripted` event (5.3) makes its process hold the session like any other: the guard refuses to
resume a session that a live scripted run holds, and `show` names such a holder as a scripted
run. While it runs, the session is `running` (a scripted run has no live-session file, 6.2). A
`scripted-end` stops the holding like an `end`, but is never a deliberate exit or any other end of
a holding: 6.3 looks only at holdings of processes that are not scripted runs. One case escapes
this, and is left as it is: a kept `claude -cp` start whose `entrypoint_env` is empty is scripted
by its launch command, but its end has no launch command and so is not scripted (5.3); it is
stored as a plain `end`, and that process's holding can then be a session's last holding. Claude
Code always sets the entry point today, so this does not happen.

A session is **running** when a live process holds it. If two live processes hold the same
session (which principle 7 exists to prevent), the session is running, `show` lists both, and the
list marks it `duplicate`.

### 6.2 States

There are three states, plus one fallback.

| State | Rule |
|---|---|
| `working` | Running, and the holder's live-session file has `status` `busy`. |
| `waiting` | Running, and that `status` is `idle` or `waiting`. Shown as `waiting`. `waitingFor`, when present, is the state's detail: `show` and the list's detail view print it in parentheses after the state, and `--json` carries it as `stateDetail`. |
| `running` | Running, but no live-session file can be read for the holder, or its `status` is another value. |
| `not-running` | Not running. |

The time a session has been in its state ("since") is: for `working` and `waiting`, the file's
`statusUpdatedAt` (falling back to `updatedAt`), or the time of the holder's latest `start` event
for the session when that is later (the file keeps its status time when the process changes session
with `/clear`; a compaction `start` and an `observed` event do not count); for `running`, the time of the holder's latest event; for `not-running`, the latest of its last transcript record and its last event.

### 6.3 Marks

Marks are shown next to the state.

| Mark | Rule |
|---|---|
| `ended-unexpectedly` | Not running, and its latest holding did not end with a deliberate exit: the last process that held it is dead and either still held it at its last event, or stopped holding it with an `end` of detail `other`. A session that a process left through `/clear`, `/resume` or a fork is **not** marked. The latest holding is decided per process, not by the latest event: of the holdings of the processes that held the session, the one that ended last. A holding ends at the process's `end` for the session, or at the process's first event naming another session (it moved on; when that event is an `observed` one, reconcile noticed the move only then, so the holding counts as ended at the process's last event for the session); a process that is gone without either ended when it was last seen — its last event, or the last write of the live-session file it left naming the session, whichever is later. So after two holders, one that exited deliberately does not hide one killed after it — when anything shows the killed one alive after that exit. A live-session file is not rewritten while its session is idle, so a holder killed while idle since before the other holder's exit cannot be told from one that died first: its holding counts as ended when it was last seen, before the exit, and the session gets no mark (a known limit). A scripted run's holding (5.3) is never the latest holding: when it ends or is killed it leaves no mark, and the session keeps what its last interactive holding says, so restore never offers a session because of a scripted run. A holding the user ended in the window (design-step-2.md 12.5) is a deliberate exit: once its program has exited, the window's server stores an `end` of detail `exit` for each of its holders, with no spool file and the raw detail `skydeck-window`, and a process that has one for the session ended its holding by that exit, whatever other `end` Claude Code's own hook sends for it before or after (its hang-up reports `other`, 14). |
| `was-working` | `ended-unexpectedly`, and a turn was in progress: either a leftover live-session file of that dead process (same pid and process start) says `status` `busy`, or the last `assistant` record or `user` turn (5.6) of its transcript is a `user` record. (Closing a terminal removes the live-session file, so the transcript is what covers that case.) |
| `continued` | The session is the target of a `clear`, `fork` or `copy` link (5.3). `show` names the session it continues. |
| `empty-copy` | Follow-up F33: the session is the target of a `copy` link, has had no turn and no input — no transcript, or one with no `user` turn, no `assistant` record and no `user` input (5.6): a copy that holds only the title it copied —, and no live process of it works or waits for an answer to a question (its holder's live-session file says neither `busy` nor `waiting`, 6.2: idle at its first prompt, or not running), whatever its transcript says yet. It is listed as a done one unless the user kept it (7.2) and never offered by restore (7.8). Its first turn or input, or its process starting to work or to ask, ends the mark by itself; `continued` stays. |
| `expired` | Its transcript is missing. It cannot be resumed. |
| `expiring` | Its transcript was last modified more than (retention − 5) days ago, where retention is `cleanupPeriodDays` from the settings file, default 30. |
| `duplicate` | Two live processes hold it. |

## 7. What the user sees and does

### 7.1 Labels, groups, notes, done

- **Label.** One line, trimmed, not empty, not starting with `-`, and without control characters
  (anything the sanitiser of 7.4 would change). The **title** of a row is the
  first that exists of: the skydeck label; the name set in Claude Code (`custom-title`); Claude
  Code's generated title (`ai-title`); otherwise the start time and the project directory name,
  as `YYYY-MM-DD HH:MM <directory name>` in UTC (`?` when the directory is not known). A name or
  title that is empty or only whitespace once control characters are removed (Claude Code writes
  an empty name when one is cleared) counts as not set.
  When skydeck starts or resumes a session that has a label, it passes the label to Claude Code
  as the session name, so the terminal tab shows it. Claude Code itself keeps a session name
  across `/clear`.
- **Group.** One line without control characters, optional. When no group is set and the title starts with a ticket key
  (configuration `groupPattern`, default `^[A-Z][A-Z0-9]+-[0-9]+`), that key is the group.
- **Note.** Free text of any length, stored as typed. It is edited in `$VISUAL`, else `$EDITOR`,
  else `vi`: the value is split on spaces and the path of a temporary file holding the note
  (`<stateDir>/note-<session id>.md`, removed afterwards) is appended; stdin must be a terminal.
  When the text cannot be stored the file is kept, and the next edit of that note continues with it.
  A file kept like that is never removed by an editor that fails. When the editor fails on a file
  that this edit made, the file is removed only while it still holds what the edit put there: text
  the editor changed but never stored stays, and the error that says the editor failed names the
  file (`editor exited 1; your text is in <path>`).
  `skydeck note <ref> --set <text>` sets it without an editor (and removes such a kept file), and an
  empty note is no note.
- **Ticket** (follow-up F18). At most one per session, optional: an `http` or `https` address,
  stored. It is set from one text: a whole link is taken as the window opens it (the host in lower
  case, a default port dropped), when the window may open it (design-step-2.md 9.6), it is at most 2,048 characters and holds no control character and no user
  name or password; a bare key (letters, digits, `.`, `_`, `-`, starting with a letter or a digit)
  is `ticketUrl` with the key filled in (design-step-2.md 16.4), and that address is what is stored,
  so a later change of `ticketUrl` does not move it — without a `ticketUrl` a key is refused with
  what to do; an empty text removes it. Setting one replaces the one before. Its short name (the
  key when the address fits `ticketUrl`, `KEY` for a path `/browse/KEY`, `repo #n` for a GitHub
  issue or pull request, else the last part of the path, else the host) is worked out from the
  address, never stored. `skydeck ticket set|clear`, `t` in the interactive list, and the window.
  A ticket can have a **status** (follow-up F19): a GitHub issue's, or the one a configured program
  prints; it is shown beside the ticket, never in its place, and cached by its address (7.3;
  design-step-2.md 10.2, 12.5).
- **Done.** Hides the session. It never stops a process (the one exception: the window's dialog
  "Mark done" for a session running in its terminal, whose `End session and mark done` ends it on
  the user's word, design-step-2.md 12.5). A done session is shown again when it
  has activity after the done time: `user` input (5.6) in its transcript, or a `start` event with
  detail `startup` or `resume`. Ending a session, an `observed` event or a re-read of the
  transcript is not activity.
- **First run.** `skydeck install` offers to mark as done every listed session whose last
  activity is older than `firstRunDoneAfterDays` (default 7) and that is not running. It shows
  the count and does nothing unless confirmed.

### 7.2 Which sessions are listed

Every session known from events or transcripts, except: sessions whose transcript has an
`entrypoint` other than `cli`; sessions hidden by done (shown with `--all`); and sessions that are
`expired` and have nothing the user attached: no label, no group set by the user, no note, no
attached pull request and no ticket (a group that `groupPattern` takes from the title does not
count, or an expired session with a ticket key in its title would stay in the list for ever). A
session that is not running and has no transcript is never listed, not even with `--all`: there is
nothing to resume, and one that never received a prompt has no transcript (14). Follow-up F33: a
session marked `empty-copy` (6.3) — a copy Claude Code made that has had no message yet and neither
works nor asks — that the user did not keep (by setting what only the user can set: a label, a
group, a note, a ticket, or a pull request attached by hand; one skydeck attached by itself from a
`pr-link` record does not count, since Claude Code may have copied that record with the title) is
listed only where done ones are (`--all`, the interactive list's `a`), running or not, and so is in
no count of the list; the window lists it too while a terminal of the window shows it
(design-step-2.md 12.1). A copy started by hand with `--fork-session` is the same: skydeck cannot
tell the two apart, and what it would have to remember does not outlive the process. Its first turn
or input lists it by the rules above, with no reload. Hiding is a matter of the list only: the guard
(7.6), the double-resume check and the holders see it as any session. Both are needed — the `copy`
link and the empty transcript —: a session with no link whose transcript holds only a title is
listed as before.

### 7.3 Pull requests

- **Key.** A pull request is identified by the lowercased URL
  `https://github.com/<owner>/<repo>/pull/<number>`. Anything after the number is stripped.
  Owner, repository and number are validated before use.
- **Automatic.** Pull requests named in a session's `pr-link` records are attached with origin
  `auto`. Such a record means the session acted on the pull request, not that it created it.
- **Manual.** `pr add` attaches with origin `manual` and clears an earlier detach, then fetches
  that pull request at once (same 10 second timeout, so a fresh attachment shows its status); a
  failed fetch leaves it "can't read" and `pr add` still succeeds. `pr rm` detaches; a detached
  pull request is not attached again by a later `pr-link` record.
- **Status** is fetched with `gh api graphql`, using query variables, in batches of at most 10
  pull requests per query (50 before follow-up F32: GitHub takes much longer for what it is asked
  since, and a batch that runs out of time leaves all of its pull requests "can't read"), with a
  10 second timeout. Per pull request it stores state (`open`, `draft`, `merged`, `closed`), its
  review, the combined checks result, the time of the last successful fetch and the time and error
  of the last attempt.
- **What GitHub needs before it merges** (follow-up F32). GitHub's own review decision is null
  when no classic branch protection asks for reviews, also when a ruleset does, and the checks'
  rollup holds only the checks that have reported. So the same query also asks, under a second
  alias of each pull request, for GitHub's merge state, the latest reviews of those who can write to
  the repository ("writers"), the review threads, the rules of the base branch (its rulesets; never
  the classic branch protection, which can need more than read access and shows in the decision)
  and the names of the checks the last commit has reported: at most 50 reviews and 50 rules, 100
  threads and 100 checks. Only the rules of rulesets that are enforced count: a rule whose ruleset
  is in evaluate mode or disabled is passed by; one whose ruleset's enforcement cannot be read
  counts (GitHub documents the list as the active rules). From them:
  - the checks are pending when the rollup says so (they run); when the rollup says neither
    failing nor pending and a check the rules require is not among the reported ones (only when
    every reported one was seen), they are stored as `not-reported` (ruled: a check that has not
    started can stay so for days, so it ranks after the review, below);
  - the review is the first that applies of: changes requested (the decision, or a writer's latest
    review while the decision is not approved); review required (the decision, or, when there is
    none, the rules need more approvals than the writers gave: the largest count among the rules, 0
    for none; ruled: a decision GitHub gives is its own count and takes rulesets into account, ours
    of the writers' latest reviews is an approximation, so only a null decision is decided by the
    rules and the count); unresolved comments (the rules ask for resolved conversations and a thread
    is not resolved); blocked (GitHub's merge state is `BLOCKED` while the checks pass or there are
    none and it is no draft: GitHub will not let it be merged now for a reason skydeck does not
    read, such as code owners, a rule on who may merge, or a deployment; ruled: a merge state of
    `UNKNOWN`, which GitHub answers while it has not worked the state out, keeps what was stored
    about blocked, and every other state decides anew); approved (the decision, or, with no
    decision, the rules need N of at least 1 and N writers approved); not required (no decision, and
    no rule needs an approval); else the decision.
  - Each part is optional. One that is missing, malformed, cut short (more than were asked for) or
    that an error of the answer lies under is not used, and the pull request is read from the
    rest, exactly as before F32 where nothing better is known: none of them makes it "can't read".
    No column was added: the review is stored with three more values; a row read before F32 shows
    as before until it is read again.
  - When GitHub rejects the query as a whole (it checks a query before it runs it: a field or a
    type its schema no longer has, or a scope the token lacks) or the batch runs out of time
    (skydeck's timeout, GitHub's HTTP 502 or 504), the batch is asked once more with the query of
    before F32 and read as before: for that refresh its pull requests show the states of before
    (ruled). That is the one second request, never more than once a batch, only after those
    failures; a rate limit or any other failure is not asked again.
- Merged and closed pull requests are never fetched again. A pull request that no session has
  attached any more (every attachment detached) is not refreshed either, an explicit refresh
  included. The others are refreshed by two rules. An **automatic** refresh (the interactive list
  when it opens, and in the background) fetches one that was never tried, or whose last
  *attempt* is older than `prRefreshMinutes` (default 5) — the last attempt, not the last
  success, so a pull request that keeps failing is asked about at that pace and not at every
  refresh. An **explicit** refresh — `skydeck pr refresh`, `ls --refresh`, `show --refresh` and the
  list's refresh key — fetches every such pull request of the sessions it is about, whatever its
  age and its last result: `ls` and the list those they show (so with `--all` or `a`, the done
  ones too), `show` that session, `pr refresh` all attached ones.
- `skydeck ls` and `show` print the cached status and never touch the network, unless they are
  given `--refresh`: then they first make an explicit refresh (`ls`: of the sessions it prints,
  `show`: of that session), with the timeout above, and a fetch that fails leaves the pull
  request "can't read" and the command still succeeds. The interactive list paints from the
  cache, refreshes in the background (every 5 seconds, 7.4) and repaints. `skydeck pr refresh`
  fetches now.
- A pull request that cannot be read is shown as "can't read" with the time of its last
  successful fetch — never as closed.
- A pull request that has never been fetched and has no failed attempt is shown as "not
  fetched": it is neither read nor unreadable, so a fresh attachment does not look broken.
- **A pull request's state** (open or draft) is the first that applies of: checks failing,
  changes requested, checks pending (the rollup's: they run), review required, unresolved
  comments, draft, a required check not reported (a level of its own, ruled, with the words and
  the colour of checks pending), blocked; then
  checks passing (no review asked for, the checks pass), open (no review asked for, no checks at
  all), else approved and green (approved, with checks that pass or none; or nothing known of the
  review, as for a row read before F32, or rules that need approvals that cannot be counted: the
  reviews not read, or more than 50). So "approved and green" needs a real approval wherever
  GitHub's answer tells what is needed, but does not promise that nothing else is in the way: not
  shown are conflicts and a branch behind its base (GitHub's merge state `DIRTY` and `BEHIND`,
  the latter hiding `BLOCKED`), and a merge state GitHub has not worked out yet (`UNKNOWN`, as
  right after the base branch moved: the next read can show `blocked`).
- **Chip.** A row shows one chip for all attached pull requests: the worst state among them in
  this order, the order of one pull request's state above (ruled) — can't read, not fetched,
  checks failing, changes requested, checks pending, review required, unresolved comments, draft,
  a required check not reported, blocked, open, checks passing, approved and green, merged, closed
  — and the count.
- **A ticket's status** (follow-up F19). The ticket of a session — the one set on it (7.1), else the
  address its group gives through `ticketUrl` (design-step-2.md 12.5) — has a status when a
  *provider* takes its address: first the configuration's `ticketStatus`, a list of at most 8
  rules, the first whose `match` starts the address, each naming a program that prints the status
  (run as a list of words, never through a shell: install.md, "A ticket's status"); else, for the
  address of a GitHub issue (`https://github.com/<owner>/<repo>/issues/<number>`, keyed as a pull
  request is, with `issues` for `pull`), `gh api graphql` in batches of its own — the pull
  requests' query is not touched — with 50 to a batch (the pull requests' batch before F32), 10
  seconds, and the pull requests' environment and failure words. A pull request's address gets no status, whatever a rule's
  `match` says. A status is a text of at most 40 characters and, optionally, one of six categories
  (`todo`, `doing`, `review`, `blocked`, `done`, `closed`) that only colours it; a GitHub issue is
  `open` (`doing`), `closed` (`done`), `not planned` or `duplicate` (`closed`). It is cached by
  address, one fetch and one row for the sessions that share one (design-step-2.md 10.2), and a
  fetch that fails keeps the status it had and its age and saves the failure's words, as a pull
  request's does. It is read only by the window's server and by `skydeck ticket refresh` — `ls`,
  `show`, `ticket set` (ruled: F18's behaviour) and the interactive list print the cache or write
  the ticket and run nothing —: at once when a ticket is set or changed in the window; for the
  sessions the window's pages list, when the address was never
  tried or its last *attempt* is older than `ticketRefreshMinutes` (default 10) — for a status
  whose category is `done` or `closed`, older than 12 hours —; and whatever its age by the ↻ of the
  ticket's dialog and `skydeck ticket refresh`. The server runs one read at a time, so one status
  program at a time, and starts at most 5 programs in a round of its tick (design-step-2.md 10.1).

### 7.4 The list

`skydeck` with no arguments opens the interactive list when stdin and stdout are terminals;
otherwise it behaves like `skydeck ls`.

- Groups are ordered by the most recent activity of a listed member; "no group" is last; ties by
  name. Inside a group: `waiting`, `working`, `running`, then `not-running` with
  `ended-unexpectedly` first; inside each of those by most recent activity.
- The order is computed when the list opens or is refreshed with `r`, and does not change under
  the cursor. While the list is on screen it also refreshes by itself every 5 seconds (5.3, then
  the automatic pull-request refresh of 7.3) and repaints when what it shows changed; that refresh
  keeps the order and the selected session (a new session goes to the end of its group) and waits
  while an input is being typed. When the selected session leaves the list, the cursor goes to the
  row that takes its place, not to the top, and the message line says which session left.
- The title line counts the sessions shown and how many of them are in each state, so that a
  session that starts waiting out of view is still seen.
- A row shows: state, title, time in state, marks, the pull-request chip, a note mark, and the
  short id (first 8 characters of the session id).
- Every string that comes from a transcript, a live-session file or GitHub passes through the
  sanitiser, which removes control characters and escape sequences, when the list model is built.
  So do the label and the group, although setting them refuses such characters (7.1): the
  database can be changed by other means. A note is free multi-line text: a row only shows that there is one, and whoever prints a note sanitises it. `show` and the detail view of the list print it the same way, by one function: split at every line break (a lone carriage return too), each line sanitised on its own and indented by two spaces, empty lines at the start and end dropped. They also print a state detail the same way: in brackets after the state, and no brackets when it is empty once sanitised.

Keys: arrows or `j`/`k` move; `Enter` detail; `l` label; `g` group; `n` note; `t` ticket (F18); `d`
done or undo; `p` pull requests; `R` resume; `/` filter; `a` show all; `r` refresh; `q` quit. The
filter matches title, group, note, pull-request repository and number, project directory, the
ticket's short name and address, and the text of its status (F19).

The interactive list is built as two pure functions — `reduce(model, key)` and
`render(model, size)` — with a thin terminal wrapper, so it is tested without a terminal.

### 7.5 Commands

| Command | Effect |
|---|---|
| `skydeck` | Interactive list. |
| `skydeck ls [--all] [--json] [--refresh]` | Print the list. `--refresh` first fetches the pull requests of the sessions it prints that are not merged or closed (7.3). |
| `skydeck show <ref> [--json] [--refresh]` | One session: state, marks, project directory, its `ticket:` — the ticket set on it (7.1), else the address `ticketUrl` gives its group (design-step-2.md 12.5; that one not in `--json`), with ` · <status>` when its status is known (7.3) and, after a failed read, a line under it with the failure's words —, launch command (and the flags in it that skydeck does not know, which a resume does not pass on), links, note, whether it is done and since when, pull requests, holders. `--refresh` as for `ls`, for this session's pull requests. |
| `skydeck label <ref> [<text>]` / `group <ref> [<text>]` | Set; without text (or with an empty text), clear. The text is all the arguments after `<ref>`, joined by one space. |
| `skydeck note <ref> [--set <text>]` | Edit in `$VISUAL` / `$EDITOR` (7.1), or set directly. |
| `skydeck ticket set <ref> <link-or-key>` / `ticket clear <ref>` / `ticket refresh [<ref>]` | Set the session's ticket from a link or a key, replacing the one before; remove it (7.1; F18). An empty text removes it too. `set` reads no status (ruled, as F18 left it): the window's server reads it for a session it lists, or `refresh` reads it; `refresh` reads the status of the session's ticket, or without `<ref>` of every session's, done ones included, as `pr refresh` reads every session's pull requests, now, whatever its age (7.3; F19). |
| `skydeck done <ref>` / `undone <ref>` | Hide / show. |
| `skydeck pr add <ref> <url>` / `pr rm <ref> <url>` / `pr refresh` | Attach, detach, fetch status. |
| `skydeck new [--label <text>] [--group <text>] [--here \| --tab \| --window] [-- <claude flags>]` | Start a new session in the current directory (7.7); `--window` in the skydeck window (design-step-2.md 11.4). |
| `skydeck resume <ref> [--here \| --tab \| --window]` | Resume one session (7.6); `--window` in the skydeck window (design-step-2.md 11.4). |
| `skydeck restore [--all] [--dry-run] [--yes]` | Bring back what was open (7.8). |
| `skydeck install` / `uninstall [--purge]` / `doctor` | Section 8. |

**`<ref>`** is resolved in this order: a full session id; a unique id prefix of at least 4
characters, searched among all known sessions; a label equal to the text, searched among the
sessions `ls --all` would show (done ones included, so that `undone <label>` can work). Ids are
compared in lower case, labels exactly as typed. The first step that finds anything decides. No
match or more than one match is an error that lists the candidates.

**Exit codes:** 0 success; 1 failure, or `doctor` found a problem; 2 usage error; 3 reference not
found or ambiguous; 4 resume refused; 5 restore stopped before finishing. After a hand-off (`resume
--here`, `new --here`, `R` in the interactive list when it resumes here, or `restore` without a tab
adapter) the exit status is `claude`'s own: the launcher has become `claude` (7.6 "Where"), so
skydeck's status never reaches the caller.
A reader that closes standard output early (`skydeck ls | head -1`) is not an error: nothing more is written and nothing is said on stderr, the command runs to its end (a state change finishes, the database is closed), and the process exits 141, the status a shell shows for a program killed by SIGPIPE, when the command itself returned 0; a command that failed keeps its own code. A closed standard error is as quiet and changes no exit code.

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

Times are UTC ISO 8601 with milliseconds. `dir` is the project directory as stored (the text views
show it sanitised, 7.4), so that it can be used as a path; the characters a terminal would act on
are written as `\uXXXX` escapes like in any other string of the JSON. Sessions are in list order. A pull request's `state`,
`review`, `checks` and `okAt` are null until it has been fetched. `review` is `approved`,
`changes-requested`, `review-required` or, since follow-up F32 and still in version 1,
`unresolved-comments`, `blocked` or `not-required` (7.3); `checks` is `passing`, `failing`,
`pending` or, since F32, `not-reported` (a check the rules require has not reported). A reader of
version 1 that knows only the earlier values meets a word it does not know, and gets
`not-required` where it got null for a pull request that no rule asks to review. Follow-up F33,
still version 1, an addition only: `marks` can hold `empty-copy` (6.3) — the session is a copy
that has had no message yet and neither works nor asks, listed only with `--all` unless the user
kept it (7.2) —, and then, as for every copy, `marks`
holds `continued` and `continuedFrom` is the id of the session it is a copy of; `show --json`'s
`links` can hold a link of kind `copy` (5.3), from that id to the session. Since F32
`review` is no longer GitHub's decision alone: an approved pull request that has open
conversations or that GitHub will not merge exports `unresolved-comments` or `blocked`, so a
reader that looks for `approved` no longer finds it there. `show --json` prints one
session object with `doneAt` (the time it was marked done while it is done, else null), `note`,
`ticket` (`{ "url", "text", "status", "category", "okAt", "triedAt", "error" }`: the ticket set on
it, its short name (7.1) and, from follow-up F19, its status, its category, the times of the last
success and of the last attempt (ISO) and the last failure's words (7.3), each of those null when
not known, also when no provider reads the ticket; else null),
`launch` (argument list or null), `unknownFlags` (the names of the flags in `launch` that skydeck
does not know; `[]` without a launch command), `links` and `holders` added; each holder is
`{ "pid", "bootId", "procStart", "since", "scripted" }`, where `scripted` (`true` or `false`) says
whether the holder is a scripted run (5.3). The text of `show` ends a holder's line with `(in Claude
Code's background)` when its trusted live-session file says Claude Code runs the session there
(follow-up F34, 14); the JSON is unchanged. The text of `show` prints a note sanitised line by line (7.4); the
JSON of `show` holds the note as stored, with the characters a terminal would act on written as `\uXXXX`
escapes, so that it is safe to print and still parses back to the exact text.

### 7.6 Resume

**The command.** skydeck takes the launch command of the session's latest `start` or `observed`
event that has one, and rewrites it. The program is the configured `claudeCommand` (default
`claude`), never the recorded first element. The recorded flags are parsed with a table of
Claude Code flags and their shapes (no value, one value, optional value, several values;
`--flag=value` is understood), which lists every flag the program declares, those hidden from its
help included. A flag that is not in the table is not passed on, nor is a following argument that
does not start with `-`: it cannot be classified, and may be a prompt (principle 4). The
recorded command keeps the flag's name, and `resume` and `show` say that the session was started
with flags skydeck does not know, naming them.

Arguments are read as Claude Code's own parser reads them: a flag that takes several values
takes the next argument whatever it is, and then the arguments after it up to the next flag (a
token that starts with `-` and has more than one character), so a prompt written directly after
such a flag is taken as one of its values and stays with the stored launch command (principle 4);
`--flag=value` consumes nothing more; a short flag takes the rest of its token as its value
(`-rabc` is `--resume abc`), and a token of several short flags (`-cp`) is one flag, removed as a
whole when any flag in it is removed. After a short flag without a value, a `-` starts a new
token in the same way: `-c-model` is `-c --model`, and `-c-` is `-c --`. A lone `-` is a value;
`--` ends the flags, and it and everything after it are positional arguments.

- Removed: `--resume`/`-r` and its value, `--continue`/`-c`, `--session-id` and its value,
  `--fork-session`, `--name`/`-n` and its value, `--worktree`/`-w` and its value, `--bg`,
  `--from-pr` and its value, and positional arguments (an initial prompt). Also removed are the
  flags that choose which session is opened or where it runs: `--teleport`, `--cloud` (`--remote`)
  and `--environment` (`--pool`) with their values, `--desktop`, and `--tmux`, which needs
  `--worktree`. The flags that choose a session or act once are removed too:
  `--rewind-files`, `--resume-session-at`, `--resume-drops-turn`, `--reply-on-resume`,
  `--attach-serve`, `--session-began-as-copy`, `--init-only` and `--handle-uri`; so are the
  one-time actions `--init` and `--maintenance`, and `--ref`, `--on-branch`, `--correlation-id` and
  `--forward-home-settings`, which only work together with the cloud flags above. Flags that carry
  prompt text are removed as well: `--prefill`, `--prefill-b64` and the deep-link flags
  (`--deep-link-origin`, `--deep-link-repo`, `--deep-link-last-fetch`, `--deep-link-cwd-b64`).
  Flags that only configure how the session runs, including `--remote-control`, are kept.
- Added, directly after the program: `--resume <session id>`, then `-n <label>` when the session
  has a label.
- Kept, in order: every other flag of the table, with its values — including `--mcp-config`,
  `--settings`, `--add-dir`, `--model`, and a permission flag if it was there.
- Never added: a permission flag.

For a session without a recorded launch command the result is `claude --resume <id>`, and
skydeck says that the original flags are unknown. Environment variables that an alias or wrapper
set are not part of a launch command and are not restored.

**The directory** is the session's project directory. If it no longer exists, resume is refused.
A session without a transcript cannot be resumed.

**The guard (principle 7).** The guard owns its freshness: every resume (the command, the
interactive list, restore) goes through one entry point that runs ingest, reconcile and the scan,
loads the rows and finds the session in them, and only then decides. A start event that another
skydeck's `claude` has written is a file in the spool until a refresh ingests it, so a row loaded
earlier does not show it. The guard refuses (exit 4) when the rows were derived without a boot id,
because every recorded process then looks dead and a running session cannot be seen ("cannot tell
which sessions are running: the boot id could not be read"). The boot id is read once for a load
and the rows carry it, so a failed read and a later successful one are never mixed; `new` resumes
nothing and does not need it. It refuses when the session is running, naming the holder. It then takes a lock for the session; if the lock exists and is younger than 60 seconds,
resume is refused and says how long to wait.
The lock is removed when a `start` event of a real process for the session appears that was
recorded after the lock was taken and is dated at or after it (a start without a pid or a process
start time names no `claude` and releases nobody; nor does a `scripted` or `scripted-end` event
(5.3), which is no `start` but counts as the session's latest event for the lock's own check; a
start recorded before the lock but dated after
it — the clock was ahead when it was written, then stepped back — is not the resume's own, and
would otherwise make every lock of the session stale at once) or after 60 seconds — or at once when starting the session definitely failed and skydeck
printed no command for it (the command holds a control character, or restore only reports the
failure): nothing was started and nothing is left to run by hand, so the lock would only make the
user wait. When the lock holds an event id, a start dated up to 5 seconds before the lock counts too:
the wall clock can step back between the lock and the start (measured on one WSL machine: about
1.7 to 1.9 seconds every 32 seconds), and the resume's own start would then be stamped before the
lock; a lock an earlier version wrote (the time alone) keeps the exact time. The id shows when a
start was recorded, not when its process began, so a start stamped up to 5 seconds before the lock
and recorded only after it releases the lock even when it is not the resume's own — another
process on the session that began within those 5 seconds, is recorded late and is already gone,
followed by a second resume before the first one's `claude` reports. That is accepted: the guard
still refuses while any holder lives. Where skydeck prints the command for the user to run, and after a timeout (the program
may have started), the lock stays for its 60 seconds. Whoever took a lock may renew it while it
waits longer than that for the session to start (restore, 7.8), and renews or releases only the
lock it wrote: one another skydeck took over is left alone. The lock
is an entry `resume_lock:<session id>` in the database's `kv` table, holding the time it was
taken in nanoseconds (so its age does not depend on any file's modification time) and the id of
the session's latest event at that moment (0 when it has none), which tells a start recorded after
the lock from one recorded before it (event ids grow in the order events are recorded, whatever
their times). Reading the
lock and writing it happen in one database transaction, which no two skydecks hold at once, so
of several resumes started together exactly one gets the lock. Inside that transaction the
session's latest event is read again, and resume is refused ("the session's state changed while
preparing; run the command again") when it is not the one its decision was made on: in between,
another skydeck may have resumed the session, and a sweep may have removed its lock because its
start event had been ingested. A lock dated 60 seconds or more in the future, or holding a
value that is not a lock skydeck writes, counts as stale too; stale locks are deleted, again in
one transaction, at the end of every refresh.

**A renewal keeps the mark of its take.** skydeck's clock counts milliseconds, so the last six
digits of a lock's time in nanoseconds are 0 when a lock is taken. A renewal writes the time of
now, to the millisecond, and puts the take's mark in those six digits: 1 + (the take's
milliseconds mod 999,999), never 0; a renewal of a renewal keeps it. **Those six digits of a
renewed lock are a mark, not time**: every age, wait and deadline counts from the lock's
millisecond. Two values are of one take when both record an event id, the same one, and the same
mark — except two different values whose six digits are both 0, which are always two takes (only a
take writes such a value); a value without an event id is of one take only with itself. A
take-over is therefore always another take, and a renewal is the take it renews: the window's
server lets a terminal it finds start on a renewal of the lock that terminal took, and gives such
a lock back when the terminal ended before its session started (design-step-2.md 7.3, 7.8). An
older skydeck reads a renewed value as a lock renewed less than 1 ms later, so a server of an
older build that still runs after an update neither sweeps it nor takes it over early; a renewal
that an older skydeck writes carries no mark and is another take to this one, the cautious side
(the window refuses such a terminal and leaves the lock to expire, as before). Known limit: a
take-over at a millisecond congruent to the take's (mod 999,999: about one in a million, and at
least 16 min 40 s later) that a restore then renews reads as a renewal of the first take. A
terminal of that first take is then past its start deadline and starts nothing, but if it ends
while that restore still waits for the session, the restore's lock is given back: the restore's
next renewal finds it gone, and until the session's start event is seen no lock keeps another
resume out.

**Where.** `--here` replaces skydeck with `claude` in the current terminal: the command line tool
hands the directory and the argument list back to the `bin/skydeck` launcher through a handoff
file, and the launcher `exec`s it, so no wrapper process stays behind. `--tab` opens a new tab
through the terminal adapter named in the configuration (first adapter: WezTerm, which runs
`wezterm cli --no-auto-start spawn`: with no WezTerm window open it fails instead of starting a
hidden server that would hold the session where nobody can see it; when `wezterm` is not found
and `$WSL_DISTRO_NAME` is set it retries with `wezterm.exe`, so tabs can be opened from WSL). The
default is the configured `terminal`. `--tab` when the configured `terminal` opens no tabs
(`here`) prints the command and exits 1. If opening a tab fails, skydeck prints the command
instead, quoted for a POSIX shell, and exits 1 — with two exceptions, in which it prints no
command: when the WezTerm call timed out (the tab may have opened, and pasting the command could
resume the session a second time; skydeck says so, names the session, and says that running
`skydeck` again shows whether it is running), and when the directory or a word of the command holds a control
character (the printed line could act on the terminal or break when pasted). Commands are run as
argument lists; the one exception is the `--here` handoff, a generated `sh` fragment in which
every word is quoted by the same function as the printed fallback.

### 7.7 New

`skydeck new` generates a session id, stores the label and group for it, and starts
`claude --session-id <uuid> [-n <label>] <flags after -->` in the current directory, with the
same `--here` / `--tab` choice as resume. It refuses a flag after `--` that picks an existing
session (also inside a cluster of short flags such as `-cp`, and before an unknown letter or an
unknown long flag, as in `-cZ` or `-c-frob`): `-r <id>` or `-c` would resume an
existing session past the guard and the lock (principle 7). These are `--resume`/`-r`,
`--continue`/`-c`, `--session-id`, `--fork-session`, `--from-pr`, `--teleport`, `--rewind-files`,
`--resume-session-at`, `--resume-drops-turn`, `--reply-on-resume`, `--attach-serve`,
`--session-began-as-copy`, `--handle-uri`, and the deep-link and prefill flags. It refuses
`--name`/`-n` too: the label is given with `--label`, and skydeck passes it as the name itself.
The other flags that resume removes (7.6) only say where or how a new session starts and are
passed on: `--worktree`/`-w`, `--tmux`, `--bg`, `--init`, `--init-only`, `--maintenance`,
`--desktop`, and the cloud flags (`--cloud`/`--remote`, `--environment`/`--pool`, `--ref`,
`--on-branch`, `--correlation-id`, `--forward-home-settings`); a resume drops them because a
session that already exists must not start in a new worktree or in the cloud a second time. A
prompt after `--` is passed on; it is the user's own and is never stored.
When opening its tab times out, `new` prints no command but the new session's id, and says that
running `skydeck` shows whether it started: a session that never started has nothing to resume.
When starting it definitely failed and no command was printed (the case in which a resume releases
its lock, 7.6), `new` removes the label and group it stored for the id: that session will never
exist, and the row is skydeck's own, just written. After a timeout, or where a command is printed,
they stay.

### 7.8 Restore

**The set.** By default: the sessions marked `ended-unexpectedly`, not done, not expired and not
`empty-copy` (follow-up F33: it has nothing to restore; also not with `--all`),
whose last holder belongs to the **latest earlier boot** in which any session was held: of the
boots other than the current one that have a `start` or `observed` event, the one whose last
event is the latest. A `scripted` event (5.3) counts for neither: a scripted run is not what the
user had open, so it does not make a boot the latest earlier one or move the last event of its
boot (which the preselection below measures against). `--all` adds every other session marked `ended-unexpectedly`, from any boot
including the current one. The set is in list order (as `ls --all` shows it). When the current
boot id cannot be read, restore refuses (exit 1): every process would look dead, so the sessions
running now would be offered, and the guard could not see that they run (principle 7). As for the
guard, the boot id is the one read when the sessions were loaded, never a second read.

**The selection.** Each entry shows how it ended (no exit recorded, or ended at a time) and
`was-working`. Preselected are the entries with no exit recorded and those that ended within two
minutes of the last event of their own boot (for the default set that is the latest earlier boot;
with `--all` each entry is measured against its own); entries that ended earlier are listed
unselected. The user confirms or changes the selection: the entries are a numbered list, a line
of numbers separated by spaces toggles them (a line with anything else is refused whole and asked
again), an empty line confirms (with nothing selected, nothing starts), and `q` or the end of
input cancels (exit 5) before anything starts. `--yes` accepts the preselection and is required
when stdin is not a terminal. `--dry-run` prints the set and the commands and exits 0; it starts
nothing, so it needs neither `--yes` nor a terminal.

**Running it.** Sessions are resumed in tabs, `restoreBatch` at a time (default 3). Each one goes
through the guard of 7.6 and takes its lock, on state refreshed just before it: opening a tab
takes time, and another skydeck may have resumed the session meanwhile. After starting a batch,
restore waits until each of its sessions has a `start` event of a real process that counts by the
lock's rule (7.6: recorded after restore took the lock, and dated at or after the batch started,
or up to 5 seconds before it),
checking once a second, for at most
`restoreStartTimeoutSeconds` (default 120) counted from the start of the batch. Before each batch
it reads `MemAvailable` from `/proc/meminfo` and stops (exit 5) when it is below
`restoreMinFreeMb` (default 4096; a value that cannot be read counts as enough), listing what was
not started. From the moment a session's tab is opened until restore stops waiting for it,
restore renews the session's lock — before it opens each further tab of the batch, and at every
check (opening a batch and the wait both can last longer than a lock holds), the last time when
it gives up: a session that does not start
in time is reported and skipped, and for a minute after that no resume starts it a second time
while its tab may still open. When it sees a session's start event it removes that session's
lock itself (it may have renewed the lock after the start). A lock another skydeck has taken over
meanwhile is left alone. A tab whose opening timed
out may have opened all the same, so its session is waited for like the others. A session the
guard refuses, or whose tab cannot be opened, is reported and skipped; restore prints no command
for it. When the tab definitely did not open (the terminal refused, or is not installed), nothing was
started and restore prints no command for it, so its lock is released at once.

Without a tab adapter, restore resumes the first selected session the guard accepts `--here` and,
for each of the others the guard lets through now (restore takes no lock for them, but one another
skydeck holds refuses the session), prints `skydeck resume <session id> --here` for the user to run
in other terminals — not the session's own `claude` command. The user may paste the line minutes
later, and the session may have been resumed elsewhere meanwhile: `skydeck resume` runs the guard
and takes the lock at the moment it is run, where a raw command would start a second process on one
transcript (principle 7). The line is always printable: a session id holds no control character.
Before each printed command restore prints one line that names its session — short id, title and
directory, sanitised as in the list and quoted for a shell — because with `--yes` no list was
shown. The line sits right under the command it names, so a user may paste the two together:
quoted, it is a command that does not exist and does nothing else, where a title such as
`notes -> README.md` would empty a file. The command keeps a line of its own so that it can be
pasted alone (not a trailing `#` comment: zsh takes none in an interactive shell).
If the handoff itself fails, that session's own command is printed too and, as with `resume`, its
lock stays for its 60 seconds, so that no other skydeck starts the session while the user runs the
command; when that command cannot be printed, the lock is released. `--dry-run` shows each
session's own command line: it is information, not something to paste.

**Exit codes.** 0 when every selected session started, was handed off or had its `skydeck
resume` line printed; 1 when any was refused, failed to open or did not start in time; 5 when
restore was stopped by the memory check or cancelled at the prompt. After a hand-off the exit status is
`claude`'s own (7.5): when any selected session was refused, failed or did not start in time,
restore says so in one line on stderr just before the hand-off (`skydeck: 1 of 3 selected sessions
could not be resumed; see above`).

## 8. Install, uninstall, doctor

- **`skydeck install`**: (1) creates the data, state and configuration directories and the
  database; (2) creates the links `<dataDir>/skydeck-hook` and `~/.local/bin/skydeck`, and
  `<dataDir>/node` pointing at the Node.js binary it runs under; (3) shows the exact change to
  `<claudeHome>/settings.json`, asks, writes a backup beside it, adds the two hook entries and
  records the backup's path and a hash of the resulting file. The file is parsed and written back
  in skydeck's formatting (JSON, 2-space indentation, a newline at the end), as Claude Code itself
  writes it; when writing it back unchanged would not give the same bytes, the question has one
  more line that says the rest of the file will be rewritten in skydeck's formatting and names the
  backup (its name is fixed when the question is asked), and when a number would lose digits (any
  number that does not come back as written once it is a double, such as `12345678901234567890`,
  `0.1000000000000000055511151231257827` or `1e999`; `1.50` becoming `1.5` is formatting, not loss;
  the one case where content and not formatting changes) it names the place, as a path such as
  `env.TOKEN_ID` or `a.b[1]`. Neither refuses; (4) runs ingest, reconcile and the
  first transcript scan; (5) makes the first-run offer (7.1), once: a later install does not offer
  it again, whatever the answer was; (6) last, after every step before it has succeeded, offers
  to turn off Claude Code's ← shortcut (follow-up F11, design-step-2.md 7.9), described below.
  Running it again changes nothing. Hook entries that belong to
  something else are never touched. Every install that changes the settings file writes a new
  backup of it, `<settings file>.skydeck-backup-<YYYYMMDDTHHMMSSZ>` (UTC; `-2`, `-3`, … when that
  name is taken), readable by the user only; an older backup is never touched or reused, because
  restoring it could undo what the user changed since. An install that changes nothing writes no
  backup. Every check that can stop install runs before it creates anything, and the question is
  asked before anything is created too, so a refusal or a no leaves no directory, database or link
  behind (apart from the compile cache under `~/.cache/skydeck` that every run of the launcher
  creates, 10). First of all, before config.json is read, a system without a boot id (5.5; macOS,
  for now) stops it with one line, exit 1: skydeck works on Linux and on Windows with WSL2 only,
  and nothing was changed; a boot id that cannot be read for another reason stops it naming the
  cause (follow-up F23; decided by the boot id, not by the system's name). Then: a link is created
  or re-pointed only where there is nothing or a symbolic link;
  a settings file that cannot be read or is not JSON stops it; so does a settings path that is a symbolic link
  to nothing (install names the link and its target and never replaces it with a file), and a
  missing Claude Code directory (never created for it). After the yes, install reads the settings
  file again, also right before writing it: if it is no longer what was shown (the user or another
  session saved it while the question was open), install stops and writes nothing. A write that
  fails is an error naming the file, and leaves no backup of its own behind.

  Step (6) reads `leftArrowOpensAgents` from Claude Code's global config file (9.1,
  `claudeGlobalConfig`): `off` when it is exactly `false`; `on` when it is absent or `true`;
  `unknown` when there is no file, it cannot be read, it is not UTF-8 (the file is read as bytes
  and decoded strictly: a byte that is not UTF-8 would be replaced in both the new file and the
  backup), it is not a JSON object, the key holds anything else, or the path is a symbolic link,
  not a regular file, or another user's (such a file is never written, so its state is not asked
  for); and a file without its owner's write bit whose shortcut is on (one that is off reads `off`:
  nothing would be written to it). The reader never creates the file and never follows a link. On `on` install prints three lines (what the shortcut does, that ← also
  closes a group in the window's list, that agent view itself stays) and asks `Turn the shortcut
  off? [y/N]`; a no, or no answer, is one line on how to do it later (`/config` in Claude Code,
  "← opens agents", or install again). On `off` it prints one line, on `unknown` one line naming
  the file, left alone; neither asks. After the yes it sets the key, and only it: the text is
  edited, not parsed and written back (that would reorder numeric keys, lose digits and change
  escapes), the key's `true` replaced where it is or the key added after the last member with
  that member's own white space and colon, so indentation, line ends and the final newline stay;
  the result is checked by parsing it (the same keys in the same order, every other value equal,
  the key `false`). Each try reads the file fresh, writes the new text to a temporary file beside
  it (O_EXCL, mode 600, fsync), reads that back and checks it again, makes a backup of the text it
  replaces as for the settings file (`<file>.skydeck-backup-<YYYYMMDDTHHMMSSZ>`, mode 600, never
  removed), and renames the temporary file over the file only while the file is still the one it
  read (inode, size, modification time); otherwise it removes the temporary file and that backup
  and tries again, three tries in all, then gives up with a line naming `/config`. The rename is
  the only moment the file changes: a run killed before it leaves the file whole, and perhaps the
  temporary file (`..<name>.<12 hex>.tmp`) and the backup beside it; a second hard link of the file
  keeps the old text. No message names anything of the file but its path and this
  key. Whatever goes wrong in this step is one line on stderr: install's exit code never depends
  on it. Claude Code reads the file at session start; sessions started later have the shortcut off,
  a running one keeps it, and may write its older copy back (not documented either way).
- **`skydeck uninstall`**: restores the recorded backup only when the settings file still has the
  recorded hash and that backup still exists (when there was no file before install, it removes
  the file); in every other case it removes exactly the entries install wrote, that is the hook
  objects whose whole command is what install writes for the event they sit under (a hook that
  merely names `<hookPath>`, or an entry of an install with another hook path, is not skydeck's and
  stays; install, doctor and uninstall use this one test). That path rewrites the file in
  skydeck's formatting too: when this changes more than the removed entries, it first keeps the
  file as it is in a new backup (named and protected like install's), says where, and names the
  numbers that lost digits as install's question does. It leaves `leftArrowOpensAgents` and the
  backup install made of the global config file alone. Removes the
  links that still point where install pointed them. It never removes a backup, not even with
  `--purge`, and names each one. It creates nothing but that backup (and the copy of an older
  database its open migrates, 9.2): no directory, database or file, also none the user removed
  after install. The database and its copies stay unless `--purge` is given,
  which also removes the data, state and configuration folders — carefully, since they can be the
  user's own (`SKYDECK_HOME=$HOME` makes them `~/data`, `~/state`, `~/config`; principle 6): from
  each it removes only what skydeck itself writes there, each entry of its kind (the database and
  the files SQLite keeps beside it, its copies and their temporaries (9.2), the two links, the
  spool with `bad/`, `locks/`, `hook.log`, notes being edited, the window's logs, a runtime directory of this store, `config.json`, and the
  temporaries of their writers; one list in `src/cli/purge.ts`, which a new file skydeck writes
  there must join), then the folder. A folder that is a symbolic link, is another user's, cannot be
  looked at, or holds anything else — `notes.txt`, an editor's backup, a directory where skydeck
  keeps a file — is left alone, whole; the others are still purged, and the command ends with
  `skydeck is uninstalled, but --purge did not remove <folder>: it <why>` (the entry in the way
  when there is one) and exit 1. The window's runtime folders are purged the same way (S2 16.2). Before
  anything is undone, `--purge` refuses (exit 1, nothing changed) while `SKYDECK_HOME`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME` or `XDG_RUNTIME_DIR` is set but ignored by
  9.1's rule, or `HOME` is set but empty or relative (the home directory is `HOME` as it is, so
  every place would then be relative to the working directory): it names the variable and does not
  purge the installation it would find. A relative directory is never purged. A plain `uninstall`
  is not affected.
- **`skydeck doctor`** reports and exits 1 on any problem: hook entries present and `<hookPath>`
  resolvable; Node.js version; database writable; spool size, and the files in `spool/bad/` with
  their ages (they are removed after seven days); age of the last event; the last lines of
  `hook.log`; scripted runs dropped; what the last refresh skipped (a spool file, a process, a
  transcript folder or file that could not be read); whether `<claudeHome>/sessions` and every
  folder and file under `<claudeHome>/projects` can be read (5.6; a folder that is a file or a
  symbolic link to nothing is a problem); Claude Code's ← shortcut, read as install reads it
  (`ok` when off, `info` when on or unknown, never a problem: it is the user's choice); `gh`
  present and logged in; the terminal adapter. It does not refresh and creates nothing (but the
  copy of an older database its open migrates, 9.2, whose line it says on stderr). A check that fails unexpectedly is one problem line, not the end
  of the report; so is a configuration file that cannot be read or a database that is missing or
  cannot be opened, and the checks that do not need it still run.

  Before every other line, three `info` lines say what runs (follow-up F20); none is ever a
  problem, none changes the exit code, and none names a path. (1) `skydeck <version line>`, the
  line `skydeck --version` prints: `<package version> (<short commit>, <commit date>)` of the
  checkout the running code is in, wherever it is run from, with `, modified` after the date when
  tracked files differ from that commit, and `<package version> (commit unknown)` when git is
  missing, the app root is not a git checkout (git's search stops there), or an answer is not a
  commit or does not come within 2 seconds. Two git calls side by side, `log -1` and `status
  --porcelain --untracked-files=no`, never through a shell, without the variables that point git at
  another repository (`GIT_DIR` and its kin, as for `skydeck update`) and with no optional lock, so
  that nothing is written in the checkout; `--version` never fails and prints nothing on stderr.
  (2) `Claude Code <version>`: the first line `<claudeCommand> --version` prints (no shell, stdin
  closed, doctor's environment without the launcher's own variables as in design-step-2.md 5.2,
  5 seconds, at most 4 KiB read, control characters dropped, at most 60 characters kept),
  compared with nothing; a ` (Claude Code)` at its very end, as Claude Code prints it, is dropped
  (ruled by the plan owner), any other line is shown as it is; or `Claude Code: version not read (<why>)` (`not installed`, `timed out
  after 5 s`, `exited <n>`, `ended by a signal`, `printed no version`, `could not be started:
  <code>`, or `the configuration cannot be read`, when nothing is started: the configuration's
  problem line follows the three). (3) `system: <PRETTY_NAME of /etc/os-release>, Linux <kernel
  release>` (`Proc.kernelRelease`, `/proc/sys/kernel/osrelease`), each part `unknown` when it
  cannot be read. The time limits end the program skydeck started, not what that program started
  (the inner program of a wrapper script runs on).

`docs/install.md` is the guide for setting skydeck up on another machine.

## 9. Data

### 9.1 Places

| Name | Default | Holds |
|---|---|---|
| `dataDir` | `${XDG_DATA_HOME:-~/.local/share}/skydeck` | `skydeck.db` and the copies kept before its migrations (9.2), the `node` and `skydeck-hook` links. |
| `stateDir` | `${XDG_STATE_HOME:-~/.local/state}/skydeck` | `spool/`, `hook.log`; `locks/` is created but unused (resume locks are in the database, 7.6). |
| `configDir` | `${XDG_CONFIG_HOME:-~/.config}/skydeck` | `config.json`. |
| `claudeHome` | the configuration key `claudeHome`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude` | Claude Code's own files. |
| `claudeGlobalConfig` | `<claudeHome>/.claude.json` when the configuration key or `$CLAUDE_CONFIG_DIR` names `claudeHome`, else `~/.claude.json`; also `~/.claude.json` when the configuration key is the default `~/.claude` written out (those sessions run without `CLAUDE_CONFIG_DIR`), unless `$CLAUDE_CONFIG_DIR` names that same directory, when it is `~/.claude/.claude.json` | Claude Code's global config file (follow-up F11). Claude Code keeps it in the home directory, and inside `CLAUDE_CONFIG_DIR` when that is set; a configured `claudeHome` stands for the `CLAUDE_CONFIG_DIR` Claude Code runs with, since only that variable moves Claude Code's home. |

`SKYDECK_HOME`, when set, replaces the first three with `$SKYDECK_HOME/data`, `/state`,
`/config`; tests use it. The hook resolves `stateDir` by the same rule. The launcher keeps the
cache of compiled modules (10) elsewhere: in `$NODE_COMPILE_CACHE`, else
`$XDG_CACHE_HOME/skydeck/compile-cache`, else `~/.cache/skydeck/compile-cache`; it is not one of
the places above, and `uninstall --purge` leaves it.

An environment variable (`SKYDECK_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`,
`CLAUDE_CONFIG_DIR`) counts only when it is non-empty and an absolute path; otherwise it is treated
as unset. The program, the hook and the launcher all apply this rule. A path in `config.json`
(`claudeHome`) must be absolute. Because of it, `SKYDECK_HOME=sandbox` reaches the real
installation; so `uninstall --purge`, the one command that removes folders, refuses while
`SKYDECK_HOME` or an `XDG_*` variable it reads is set but ignored, or `HOME` is set but empty or
relative (8).

Configuration keys, all optional: `terminal` (`here` or `wezterm`, and since step 2 `window`,
design-step-2.md 16.4; default `here`), `wezterm.domain`, `groupPattern`, `firstRunDoneAfterDays`,
`prRefreshMinutes`, `restoreBatch`, `restoreMinFreeMb`, `restoreStartTimeoutSeconds`,
`claudeHome`, `claudeCommand`, `ticketUrl` (design-step-2.md 16.4), `ticketStatus` and
`ticketRefreshMinutes` (follow-up F19, 7.3; design-step-2.md 16.4).
Unknown keys are an error.

### 9.2 Database

SQLite through `node:sqlite`, used only inside `src/store/`. Every connection sets
`journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000` and `foreign_keys=ON`. The file has
mode 600. Write transactions are short. Schema changes are numbered migrations, each run in one
transaction; the version is in `kv`.

Integers are read as `BigInt`: a time in nanoseconds is about 1.8·10^18, above 2^53, and
`node:sqlite` throws when asked to read such a value as a number. Times (every `*_ns` column) are
therefore `bigint` in TypeScript, bound as `bigint` too; the store converts every other integer
column (`id`, `pid`, `proc_start`, sizes, pull-request numbers) to `number`.

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
  last_turn_role   TEXT,                -- user | assistant: type of the last such record
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

`kind` in `events` can also be `scripted` or `scripted-end` (5.3); such a row has `detail` `''`
and no `argv` or `name`. The column is free text, so this needs no migration. Nor does the `kind`
`copy` in `links` (follow-up F33, 5.3 "Copies"): the column is free text too; a skydeck from
before F33 derives no mark from such a row (`show` prints its kind as it is).

Step 2 adds migration 2 (the table `attention`), migration 3 (follow-up F18: the nullable column
`ticket_url` of `session_meta`, the ticket of 7.1, by the first `ALTER TABLE`) and migration 4
(follow-up F19: the table `ticket_status`, a cached ticket status by address, 7.3); their SQL is in
design-step-2.md 10.2. A migration is never undone: a database migrated by a newer skydeck is refused
by an older one at its open ("written by a newer skydeck").

The way back is a copy (follow-up F21). Before the first migration an open runs on a database that
already holds a schema — never a new one, and never one at the code's version, whose open costs no
more than reading the version — the store writes a copy of the database as it is beside it,
`<name>.schema<V>-<yyyymmddThhmmssZ>`: `V` the version the copy holds, the time in UTC. SQLite
writes it (`VACUUM INTO`, on a read-only connection of its own) inside that migration's write
lock, before anything is written: no commit can come between, so the copy holds exactly the
version its name states, also when several processes open the database at once, and whoever
migrates has copied first. It is written into a temporary `.<copy's name>.tmp` (the lock keeps a
second writer away), created with mode 600 before anything is in it (the copy holds the window's
secret), synced, and renamed to its name once complete; a name that is taken is never written over.
A copy that cannot be written stops the migration: the open fails with `the database <path> was not
upgraded: its copy <copy> could not be written (<reason>)` and the database is as it was (a command
ends with exit 1, the window's server does not start). A migration that fails after its copy
removes the copy again (the database is what the copy holds). Once a migration is committed, the
copies beyond the newest three by the time in their names — the one just written always among them;
only regular files whose whole name is a copy's, never a link, a folder or a name that merely
starts alike — are removed, best effort. The command whose open migrated says `skydeck: the
database was brought to schema version <n>; a copy of it as it was is at <path>` on stderr (never
on stdout); the server writes the line to its log. install.md ("Going back") gives the steps to put
a copy back. No migration, setting or command comes with it.

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
- `bin/skydeck-hook` is `sh` only (5.1). Measured on one machine: about 8 ms per event,
  against about 110 ms for a Node.js hook that opens the database.
- `node:sqlite` is a release candidate in Node.js 24 and renames its classes in Node.js 26;
  keeping it inside `src/store/` limits that change to one module.

## 11. Code layout

| Module | Job | May import |
|---|---|---|
| `bin/skydeck-hook` | The hook (5.1, 5.2). | — |
| `src/platform/` | Interfaces and real implementations for clock, files, `/proc`, running programs; resolving the places in 9.1; reading the configuration. | — |
| `src/text/` | The sanitiser; shell quoting. | — |
| `src/store/` | The database: connection settings, migrations and the copy kept before them (9.2), typed functions. The only SQL. | platform |
| `src/claude/hookinput.ts` | Parses a spool file into a normalised event (5.3). | text |
| `src/claude/live.ts` | Reads live-session files; the liveness rule (5.5). | platform |
| `src/claude/transcripts.ts` | Finds and incrementally reads transcripts (5.6). | platform |
| `src/claude/launch.ts` | The flag table; builds resume and new commands (7.6, 7.7). | — |
| `src/claude/settings.ts` | Adds and removes hook entries; reads `cleanupPeriodDays`. | platform |
| `src/claude/global-config.ts` | Reads `leftArrowOpensAgents` in the global config file and sets it to `false`, nothing else (8). | platform |
| `src/sessions/` | Ingest, reconcile, the transcript scan, derived state and marks (6), the list model, reference resolution, the resume guard and lock, restore planning and running. | platform, text, store, claude, github (its pure functions: the scan attaches pull requests by key, the list computes the chip), terminals (as an interface) |
| `src/github.ts` | Pull-request keys, batched status, cache rules (7.3); from F19 also GitHub issues' keys and batched status, and which provider takes a ticket's address (`statusProvider`: a configured rule, else a GitHub issue). | platform, store |
| `src/ticket-status.ts` | A ticket's status (F19, 7.3): the configured program and its answer, when a status is due, the fetch that saves it. | github, platform, sessions (the ticket's name), store, text |
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
    links for clear, switch and fork, and the copy link of `--fork-session --resume` (F33); path
    flags made absolute.
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

## 13. Step 2: the window

Specified in [design-step-2.md](design-step-2.md), which also says how step 2 amends section 2
(principles) and section 10 (dependencies). In short:

- **Shape.** Session list on the left; the real terminal of the selected session on the right
  (xterm.js); a header with title, group, pull requests, note and done.
- **Window.** An Edge app window (`msedge.exe --app=<url>` with a profile folder of its own)
  showing a page that skydeck serves from inside WSL; all logic stays inside WSL. Step 2 builds no
  native Windows program (one stays a later option). A Linux window shown through WSLg is not an
  option: it disappears together with WSL, scales badly on mixed-DPI screens and has a known input
  freeze after sleep. An app window reserves no keys for the browser, so the page gets every
  chord it uses; in a normal browser tab the browser keeps some Ctrl shortcuts (Ctrl+W, Ctrl+T,
  Ctrl+N, Ctrl+Tab and their Shift forms).
- **Terminals are held by a small process separate from the app**: one python3 keeper per
  terminal owns the pty, and one Node.js server keeps each terminal's screen state, so that
  restarting or updating the server never ends a session and a reconnect shows the exact screen.
- **WSL lifetime.** While the window has terminals, skydeck tries to keep WSL from stopping by
  itself by holding a `wsl.exe`, or the user's `.wslconfig`
  keeps it; `doctor` says which protection is in effect, and the page notices when WSL has stopped
  anyway and offers restore.
- **Keys follow the developer's terminal:** Ctrl+V pastes text, Ctrl+Shift+V sends the raw key
  (Claude Code's image paste), Shift+Enter inserts a newline, Ctrl+Click opens links; scrollback
  search; scrollback kept when switching sessions; non-US keyboard layouts.
- **Attention.** A "finished, not yet seen" mark, a key to jump to the next session that needs
  the user, and a desktop notification when the window is not focused. The end of a turn comes
  from the live-session file, not from a new hook.
- **Safety.** Foreign text is rendered as text, never as markup. Programs in a terminal can
  write to the clipboard but not read it. The local server listens on the loopback interface
  only, requires an exact origin and host, and proves a secret in both directions without
  sending it; the command line talks to it over a unix socket.
- **Open.** What only the real Claude Code or the Windows desktop can settle is listed as manual
  checks in design-step-2.md section 18.

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
| Live-session file `<claudeHome>/sessions/<pid>.json`: `pid` (a number), `sessionId`, `cwd`, `startedAt` (epoch milliseconds, a number), `procStart` (a decimal string, equal to `/proc/<pid>/stat` field 22), `kind`, `entrypoint`, `name`, `nameSource`, `status` (`idle`, `busy`, `waiting`, and `shell`, which falls to state `running` by 6.2), `updatedAt` and `statusUpdatedAt` (epoch milliseconds, numbers; `statusUpdatedAt` is absent in some files), `waitingFor`. Other fields exist and are ignored. Rewritten in place when the process changes session; removed on a clean exit; left behind otherwise. The directory also holds credential files with other names. | observed (Claude Code 2.1.323) |
| `status` is `busy` from prompt submit until the turn ends, `idle` afterwards, `waiting` while a dialog is open. | observed |
| Transcript records: `ai-title` (`aiTitle`), `custom-title` (`customTitle`), `agent-name` (`agentName`), `pr-link` (`prUrl`, `prRepository`, `prNumber`); records carry `sessionId`, `cwd`, `entrypoint` (`cli` for interactive) and `timestamp`. | observed (local files) |
| `--mcp-config`, `--settings`, `--add-dir`, `--plugin-dir` are not restored by `--resume`; a permission flag on the command line overrides the restored mode. | documentation |
| Transcripts are deleted after `cleanupPeriodDays` (default 30). | documentation |
| `--session-id <uuid>` starts a session with a chosen id. | documentation |
| `-n <name>` together with `--resume <id>` keeps the session id and gives the session that name; a later `-n` wins over a stored name, and a resume without `-n` keeps the stored name. | observed |
| Closing the terminal (SIGHUP, or the terminal side of the pty closing) fires `SessionEnd` with reason `other` and removes the live-session file, also in the middle of a turn. SIGKILL fires nothing and leaves the file with its last `status`. | observed |
| `claude -p` and SDK runs write no live-session file that is left behind: all the files in `<claudeHome>/sessions/` on one machine where `claude -p` runs too (left-over ones of killed processes included) had `entrypoint` `cli` and `kind` `interactive`. So the hook, not a live-session file, is what shows that a scripted run holds a session (5.3). A `claude -p` prompt is written to the transcript with `turnOrigin` `sdk`, so it is not user input (5.6). | observed (local files) |
| In a hook's environment `$CLAUDE_CODE_ENTRYPOINT` is `cli` for an interactive session and `sdk-cli` for `claude -p`. Hooks fire for `-p` runs, and their command line contains `-p`. After `/clear`, the environment and the hook input both carry the new session id. | observed |
| A session that never received a prompt has no transcript. | observed |
| `←` on the empty prompt of a session started in a terminal moves its conversation into a background session with a new id and opens agent view in that terminal; what is typed there then goes to the background session. Its program runs under a `claude bg-pty-host` process whose parent is init, outside the terminal's process tree. The live-session file of the background session has `kind` `bg` and a `jobId` (in the one case seen, the first eight hex digits of the new session's id); the live-session file of the terminal's own program gets `parkedJobId` with the same value. skydeck reads only `kind`, and only to choose its words (follow-up F34, design-step-2.md 7.9): a holder whose trusted live-session file has `kind` `bg` runs the session in Claude Code's background; any other value, none, or a file that is not trusted reads as a session in another terminal. It reads neither `jobId` nor `parkedJobId`, and stores nothing of the three. Whether `claude --bg`, `/bg` and a copy made by `/fork` write the same `kind` was not observed. | observed (Claude Code 2.1.311, 2026-11-16, follow-up F11); `kind` `bg`, `jobId`, `parkedJobId` not documented |
| Claude Code's background feature (agent view, `/bg`) can start `claude --fork-session --resume <path of the original's transcript> --permission-mode auto` under its own supervisor: a copy with a new session id, its transcript only the title copied from the original and no message, its process running in the background. skydeck records it as a copy of the original (5.3 "Copies") and lists it only once it has a message (7.2). What `source` its `SessionStart` reports, when its history is written under the new id, and whether the supervisor starts it again later are not known; nothing in skydeck depends on them. `--fork-session` with `--resume` is Claude Code's documented way to start such a copy, so a user can start one too. | reported from a tester's machine (2026-11-20, follow-up F33), not observed here; the flag: documentation |
| `leftArrowOpensAgents`: a boolean, default `true`, a global config key kept in `~/.claude.json` ("Claude Code ignores this key in settings.json"; with `CLAUDE_CONFIG_DIR` set the file lives under that directory). `false`: "Claude Code turns the shortcut off; in a session you attached to from agent view, `←` on an empty prompt still detaches." Its `/config` label is "← opens agents"; `/config` writes these keys "and you can also edit them by hand". The file is "Read at session start", and Claude Code "writes back to it when you change a global config option in /config or trust a project folder". Whether a running session re-reads a hand edit, and whether its own write merges or overwrites one, is not documented; nor is any command that sets a global key without a session. The file holds the user's account details and the MCP servers' settings, mode 600. | documentation (read 2026-11-17) |

## 15. How changes are made

- One pull request per module or behaviour, from its own branch; nothing is pushed to `main`
  directly.
- Continuous integration must pass.
- Two independent reviews per pull request. Each review suggestion is checked against the code
  and this document before it is applied; rejected suggestions are answered with the reason.
- A change in behaviour updates this document in the same pull request.

## 16. Left out of step 1 on purpose

- Hooks for turn events (`Stop`, `UserPromptSubmit`, `Notification`). Planned here for step 2,
  then decided against there: the live-session file already says when a turn ends, and the input
  of `Stop` carries the assistant's text (design-step-2.md 10.3). Notifications are in step 2.
- Suggesting pull requests from URLs mentioned in a session.
- Inheriting labels or groups across `/clear` (Claude Code keeps the session name itself).
- Jumping to a terminal tab that is already open (step 2 leaves it out too).
- macOS (no `/proc`); the process facts sit behind `src/platform/` for that reason.
