# Manual checks

The short checklist to run by hand after installing skydeck on a machine, and before trusting a new
Claude Code version. It covers what the tests cannot: they never start `claude`, never open a
terminal tab and never restart WSL. Each item gives the command and the expected result.

Setup:

- skydeck is installed ([install.md](install.md)); item 1 is the install itself.
- Make a throwaway project folder: `mkdir -p ~/skydeck-try`.
- Items 1 and 8 run `bin/skydeck` from the checkout: while skydeck is not installed there is no
  `<dataDir>/node` link, so with a default `node` older than 24.12 put `SKYDECK_NODE=...` in front,
  as in [install.md](install.md), step 2. The `skydeck` command of the other items uses the link.
- Use several terminals: **A** (and **B**) run `claude`; **S** (and **C**) run `skydeck`. `<ref>` is the
  first 4 or more characters of a session id; `skydeck ls` prints the first 8, as the last column.
- **Send one prompt in every session you want to see again after it ends.** A session that never
  received a prompt has no transcript, and one that is not running and has no transcript is not
  listed (design 7.2, 14).
- Write down the date, the skydeck commit (`git -C ~/skydeck log -1 --format=%h`), the Claude Code
  version (`claude --version`) and the result of each item.

When an item fails, run `skydeck doctor` first, then read `<stateDir>/hook.log` (by default
`~/.local/state/skydeck/hook.log`).

Run item 8 last: it removes the hook. Item 9 needs the hook, so run it before item 8 (or after you
install again).

## 1. Install

On a machine with an existing `~/.claude/settings.json`, where skydeck is not installed yet (or
after item 8). (With no settings file yet, see the end of this item.)

```sh
cp ~/.claude/settings.json /tmp/settings.before.json
cd ~/skydeck
bin/skydeck install
```

Answer `y`. If install then asks `Mark <n> sessions older than 7 days as done? [y/N]` (it asks once,
and only when sessions that old exist), answer `n` for this checklist: `y` hides those sessions
from `skydeck ls` (`skydeck ls --all` shows them), `n` changes nothing, and either answer ends the
question for good.

Expected:

- Before the question, the two hook entries (`SessionStart` and `SessionEnd`) are printed: exactly what
  is going to be added. When the file is not in skydeck's formatting (four-space indentation, no
  newline at the end), one more line follows: `the rest of the file will be rewritten in skydeck's
  formatting; the file as it is now is kept in <backup path>`.
- Three `linked ...` lines (fewer when links already exist), then
  `added the hook entries to ...; the file as it was is kept in ...settings.json.skydeck-backup-<UTC time>`,
  then the question about old sessions if it is asked, then `skydeck is installed`.
- The backup exists, is readable by you only (`ls -l` shows `-rw-------`) and is the file you copied:
  `cmp /tmp/settings.before.json ~/.claude/settings.json.skydeck-backup-*` prints nothing (with
  more than one backup, name the one that was printed).
- `~/.claude/settings.json` still has everything it had, plus the two entries. Its layout may
  change: it is written with two-space indentation and a newline at the end.
- `skydeck doctor` prints no line that starts with `problem`, and `echo $?` right after it prints
  `0`. (It needs `gh` logged in.)
- `bin/skydeck install` a second time prints `hook entries already present` and makes no new backup.

With no settings file (only the folder `~/.claude`): skip the `cp` and every `cmp` and `ls -l` of the
backup. The entries are shown and the question asked as above, and the line is
`added the hook entries to <settings file> (a new file)`. No backup is made.

## 2. Session start

Terminal A:

```sh
cd ~/skydeck-try
claude
```

Terminal S, within a second of `claude` showing its prompt:

```sh
skydeck ls
```

Expected: a row for the session in the state `waiting`. Its title is the start time and the folder
name (`2026-11-13 10:02 skydeck-try`, the time in UTC) until Claude Code gives the session a name.

In A, type a prompt that takes some seconds to answer (ask it to list the files of the folder and
explain each). While it answers, `skydeck ls` in S shows `working`. When the answer is done, it shows
`waiting` again.

## 3. Clear

In A, in the session of item 2 (it has had a prompt), type `/clear`. Then in S:

```sh
skydeck ls
```

Expected: two rows. The old session is `not-running` and has no marks. The new one is `waiting` and has
the mark `continued`. `skydeck show <new ref>` prints `continues: <old id>` and a line
`link:      clear <old short id> -> <new short id> at <time>`.

## 4. Exit

In A, in the new session, send one prompt and then type `/exit`. In S:

```sh
skydeck ls
```

Expected: that session is `not-running`, and its marks do not include `ended-unexpectedly`.

## 5. Resume

In S, give the session of item 4 a label and resume it:

```sh
skydeck label <ref> "manual check"
skydeck resume <ref>
```

Expected, in S (now `claude`): Claude Code starts in the session's folder with the earlier
conversation, and the terminal's title shows `manual check`.

In another terminal C, while it runs:

```sh
skydeck ls
skydeck resume <ref>
echo $?
```

Expected: `skydeck ls` lists the same short id as before, now `waiting` (the transcript was continued,
not a new session). The second `resume` prints `skydeck: <short id> is running (pid <n>)` and `echo $?`
prints `4`.

Then exit that session and try the tab variants.

- With the default `"terminal": "here"`: `skydeck resume <ref> --tab` opens nothing. It prints
  `skydeck: no terminal adapter that opens tabs is configured (set "terminal" in <config.json path>)`,
  then `skydeck: to start it yourself, run:` and a line `cd -- <folder> && claude --resume <id> -n 'manual check'`.
  Exit code 1. (For the next minute a resume of that session is refused with
  `is being resumed ... try again in <n> s`: the printed command may be run by you.)
- With `"terminal": "wezterm"` ([install.md](install.md), "WezTerm on WSL"), from a terminal in a
  WezTerm window: `skydeck resume <ref> --tab` opens a new tab that runs `claude` on that session, and
  prints nothing. Exit that session (it is running, so a second resume is refused). Then run the same
  command from a terminal while no WezTerm window is open: it prints a line with the reason and the
  command to run by hand, and exits 1.

## 6. Terminal closed in the middle of a turn

In A, start `claude` in `~/skydeck-try` (or resume a session) and send a prompt that takes a while to
answer. In S, `skydeck ls` shows it `working`. Close A's tab or window with the terminal's close
button. Do not type `/exit` and do not press Ctrl+C. Then in S:

```sh
skydeck ls
skydeck show <ref>
```

Expected: the session is `not-running` with the marks `ended-unexpectedly,was-working`. (Design 14:
closing the terminal fires `SessionEnd` with the reason `other`, removes the live-session file, and
the last turn record of the transcript is the `user`'s.)

## 7. Reboot drill

Open three terminals with `claude` in three folders. Send a prompt in each, and give one a long task,
so that it is still `working`. Then, in Windows (PowerShell):

```
wsl --shutdown
```

Open a new WSL terminal and run:

```sh
skydeck restore --dry-run
echo $?
```

Expected: exit code 0, and nothing is started. A numbered list with the three sessions, each
preselected (`[x]`) and ending with `no exit recorded`; the busy one ends with
`no exit recorded  was working`. A session that ended unexpectedly earlier in the same WSL run (the
one of item 6, say) is listed too, ending with `ended <time>`; it is preselected only when it ended
within two minutes of the last event recorded before the shutdown. Under each entry is its command:
`cd -- <folder> && claude --resume <session id> ...`.

```sh
skydeck restore
```

Expected: the same list without the command lines (only `--dry-run` prints them), then the prompt
`Toggle numbers, Enter to start, q to cancel: `. Press Enter.

- With `"terminal": "wezterm"`, run from a WezTerm window: tabs open (at most `restoreBatch`, default 3,
  at a time), skydeck prints `started <short id> <title>` for each session when it reports its
  start, and the exit code is 0. `skydeck ls` shows the three sessions `waiting` or `working`.
- With `"terminal": "here"`: skydeck prints `resuming <short id> <title> in this terminal`, then
  `to resume these yourself, run:` and, for each other session, a line naming it
  (`<short id> '<title>' in <folder>:`) with `skydeck resume <full session id> --here` under it, and
  `claude` takes over this terminal. Run each printed `skydeck resume ... --here` in its own
  terminal. The exit status you see afterwards is `claude`'s own. If a session could not be resumed,
  `skydeck: <n> of <m> selected sessions could not be resumed; see above` is printed before `claude`
  takes over.
- When less than `restoreMinFreeMb` (default 4096 MiB) of memory is available, `restore` starts
  nothing, prints `stopped: only <n> MiB of memory available, ...` and the sessions `not started`,
  and exits 5. Lower the key in `config.json`, or free memory.
- `q` at the prompt cancels: exit code 5, nothing started.

## 8. Uninstall

```sh
skydeck uninstall
```

Expected: `restored <settings file> from <backup>`, three lines `removed ...` (the hook link,
`~/.local/bin/skydeck`, the Node.js link) and `kept the backup <path>` for each backup. Then
`cmp ~/.claude/settings.json <that backup>` prints nothing: the settings file equals the backup again.
Sessions that are running are not touched.

If there was no settings file before the install, and nobody changed it since, the line is
`removed <settings file>: there was none before skydeck install`, and no backup is named.

If you or Claude Code changed the settings file after the install, the line is
`removed the hook entries from <settings file>` instead, and your later changes stay. That is the
right result too. A hook of yours that only mentions the skydeck hook's path stays as well: only the
two entries that are exactly what install wrote are removed. When that rewrites more of the file than
those entries, uninstall first keeps the file as it is in a new backup and prints
`the rest of the file was rewritten in skydeck's formatting; the file as it was is kept in <backup>`.

`bin/skydeck doctor` now reports `problem  no SessionStart hook entry ...`, or, with a default `node`
older than 24.12 (the link is gone), the line about `SKYDECK_NODE`. Run `bin/skydeck install` (with
`SKYDECK_NODE=...` in front in that case) to put skydeck back.

## 9. The list refreshes by itself

skydeck is installed. In terminal S, open the interactive list (a terminal, not a pipe):

```sh
skydeck
```

Expected: the title line reads
`skydeck  <n> sessions  <a> waiting · <b> working · <c> running · <d> not-running`
(a state with no session is left out; `running` is a session that a process holds while its
live-session file cannot be read or shows a status other than `busy`, `idle` and `waiting`; a
scripted run leaves no such file), and the cursor is on a row. Leave the list open.

In A, start `claude` in `~/skydeck-try`. Expected, within about 5 seconds and without a key press:
the new session appears in the list, the counts in the title line change, and the cursor stays on
the session it was on: the rows do not move. Send a prompt in A: its row goes from `waiting` to
`working` and back by itself.

In another terminal C, mark the session under the cursor as done: `skydeck done <ref>`. Expected,
within about 5 seconds: the cursor moves to the row that takes its place, and the last line says
`session "<label>" left the list` (the short id instead of the label when it has none). Press `a`
to show all rows: the done session is back; select it and press `d` to undo.

Press `r`: the list refreshes at once, puts the rows in order again, and reads the status of the
pull requests again. Press `q` to leave.
