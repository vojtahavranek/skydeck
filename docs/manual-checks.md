# Manual checks

> **This is the maintainer's checklist, run by hand after changes. It is not a guide.** Some of
> its items uninstall skydeck or stop WSL, so nobody, and no AI agent, should follow it to install
> skydeck or to learn it: [quick-start.md](quick-start.md) and [install.md](install.md) are for that.

The short checklist to run by hand after installing skydeck on a machine, and before trusting a new
Claude Code version. It covers what the tests cannot: they never start `claude`, never open a
terminal tab, never restart WSL and never start a Windows program. Each item gives the command and
the expected result. Items 1–9 check the commands of step 1; the checks W1–W26 but W11, W16, W19 and
W21 check the window of step 2 (stage A) and start at "The window (step 2, stage A)" below; W27–W29
check editing in the window (stage D), at "The window (step 2, stage D)"; W11, W19 and W21 check
which sessions need you and the desktop notifications (stage B), at "The window (step 2, stage B)";
W16 checks restore in the window after WSL stopped (stage C), at "The window (step 2, stage C)";
W30, W31 and W3's icon check search, the quick switcher and the page's icon (stage E), at "The
window (step 2, stage E)"; W32 checks `skydeck update` (follow-up F8), at "Updating skydeck"; W33
checks install's offer to turn off Claude Code's ← shortcut (follow-up F11), at "Claude Code's ←
shortcut"; W34 checks the window's theme (follow-up F13; from F39 in Settings), at "The window's
theme"; W35 checks the flags a session was started with in the header (follow-up F16), at "The flags
a session was started with"; W36 checks the new form's favourite flags (follow-up F15) and its group
chip (follow-up F28), at "Favourite flags"; W37 checks a session's ticket (follow-up F18), at "A
session's ticket"; W38 checks a ticket's status (follow-up F19), at "A ticket's status"; W40 checks
a copy that Claude Code's background feature makes (follow-up F33), at "A copy made in agent view";
W41 checks the window's settings screen (follow-up F36), at "The settings screen"; W42 checks moving
a session of Open by hand (follow-up F37; any row of Open, follow-up F42), at "Moving a session in
Open"; W43 checks the window's
notice of a newer skydeck (follow-up F38), at "The update notice"; W44 checks the short settings
screen and its gear (follow-up F39), at "The short settings screen"; W45 checks the tour of the
window (follow-up F41), at "The tour of the window"; W46 checks copy on select in the window's
terminal (issue #184), at "Copy on select"; W47 checks the carry over after `/clear` (follow-up
F40), at "Carry over after /clear"; W48 checks the list's width set by a drag (issue #192), at "The
list's width"; W49 checks resuming a session with other flags (issue #188), at "Resuming with other
flags"; W50 checks parking a session (follow-up F44), at "Parked"; W51 checks how often the window
checks for a newer skydeck by itself (follow-up F38's choice), at "How often updates are checked".

Setup:

- skydeck is installed ([install.md](install.md)); item 1 is the install itself.
- Make a throwaway project folder: `mkdir -p ~/skydeck-try`.
- Items 1 and 8 run `bin/skydeck` from the checkout, and W24 runs `skydeck` with a throwaway
  `SKYDECK_HOME`: there is no `<dataDir>/node` link then (item 1: not installed yet; item 8: just
  removed; W24: a home of its own), so with a default `node` older than 24.12 put `SKYDECK_NODE=...`
  in front, as in [install.md](install.md), step 2. The `skydeck` command of the other items uses
  the link.
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

- No `ExperimentalWarning` line anywhere. A section `Hooks`: before the question, the two hook
  entries (`SessionStart` and `SessionEnd`), one line each with the whole command and `timeout 5
  s`: exactly what is going to be added, no JSON. When the file is not in skydeck's formatting
  (four-space indentation, no newline at the end), one more line follows: `the rest of the file
  will be rewritten in skydeck's formatting; the file as it is now is kept in <backup path>`. The
  question is on a line of its own, `> Add them? [y/N]`, after a blank line.
- Under it three `linked ... -> ...` lines (fewer when links already exist), then
  `added   the hook entries to ...` and `backup  ...settings.json.skydeck-backup-<UTC time>`,
  then the section `Old sessions` if its question is asked, the section `Claude Code's ← shortcut`,
  `Changed` with every file this install changed and its backup, `skydeck is installed`, and
  `Next` with what to do next, its last line naming the README of your checkout. Each section has
  a blank line before it; on a terminal the headings and questions are bold.
- The backup exists, is readable by you only (`ls -l` shows `-rw-------`) and is the file you copied:
  `cmp /tmp/settings.before.json ~/.claude/settings.json.skydeck-backup-*` prints nothing (with
  more than one backup, name the one that was printed).
- `~/.claude/settings.json` still has everything it had, plus the two entries. Its layout may
  change: it is written with two-space indentation and a newline at the end.
- `skydeck doctor` prints its lines under the headings Versions, Recording, Claude Code, GitHub and
  Window, no line that starts with `problem`, and `no problems` last; `echo $?` right after it
  prints `0`. (It needs `gh` logged in.) In a terminal the headings are bold and each `ok` green;
  `skydeck doctor | cat` and `NO_COLOR=1 skydeck doctor` show the same lines without colour.
- `bin/skydeck install` a second time prints `hook entries already present in ...` and
  `nothing was changed`, and makes no new backup.

With no settings file (only the folder `~/.claude`): skip the `cp` and every `cmp` and `ls -l` of the
backup. The entries are shown (after `(a new file):`) and the question asked as above, and the
line is `added   the hook entries to <settings file> (a new file)`. No backup is made.

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
`link:      clear <old short id> -> <new short id> at <time>`. The commands copy nothing from the
old session to the new one; the window offers it on the new session (W47).

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
- With `"terminal": "window"`, `restore` hands the chosen sessions to the skydeck window's server,
  and they start in the window ([install.md](install.md), "Starting sessions in the window from a
  terminal (stage C)"). No check here sets that key; W16 (stage C, at the end) checks the window's
  own restore, from its banner.
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

## The window (step 2, stage A)

The checks of the design's section 18 (design-step-2.md) that stage A needs: W1–W10, W12–W15,
W17, W18, W20 and W22–W26, and one more that came with the page's ping rule ("Minimised for half
an hour", after W15). W11, W19 and W21 are stage B's, W16 is stage C's, and W30 and W31 are stage
E's, each in its stage's part at the end. Each check says what to set up, what to type, what to
look at and what to write down.

Setup:

- skydeck is installed and up to date (`git pull`), and the window's needs are met
  ([install.md](install.md), "The window (step 2)": python3 3.9 or newer, Edge, the C: drive at
  `/mnt/c`). `skydeck doctor` shows the window's lines.
- **The first time, in this order**: W1, W20 and W4, with a throwaway session; then W14, before
  you resume real sessions into the window. The rest in any order. Until W14 has passed, keep one
  WSL terminal of your own open while the window runs (or set `instanceIdleTimeout=-1`,
  install.md, "Keeping WSL running").
- Terminals: **W** is a WSL terminal of your own, where you type the `skydeck` commands (never a
  `!` command inside Claude Code). **P** is Windows PowerShell, not as administrator, for the few
  commands on the Windows side.
- **A throwaway session in the window**: in the window press Ctrl+Shift+N, put the full path of the
  throwaway folder (`/home/<you>/skydeck-try`; `mkdir -p ~/skydeck-try` first) in the directory
  field, and press Enter. Send it one prompt. The items marked **real claude** use such a session,
  never one of your real work.
- Write down, besides each result: the date, the skydeck commit (`git -C ~/skydeck log -1
  --format=%h`), the Claude Code version (`claude --version`), the Edge version
  (`edge://settings/help` in your own Edge), the Windows version and your keyboard layout.
- When a check fails, run `skydeck doctor` first, then read `<stateDir>/server.log` and
  `<stateDir>/keepers.log` (by default under `~/.local/state/skydeck/`). They never hold
  conversation content, so they can be shared.
- **The check kit** is in `docs/check-kit/` of the checkout: a key-test page (`keytest.html`,
  `keytest.js`), its server (`serve.py`), a script that opens it in an Edge app window
  (`edge-app.sh`) and an optional PowerShell script (`lifetime/lifetime.ps1`). `STEPS.txt` there
  is its short guide. **The PowerShell script is optional: on a managed company PC it needs the
  agreement of the PC's owner, and no check requires it.** Nothing here asks you to bypass or
  change PowerShell's execution policy; when PowerShell refuses to run a script, leave that part
  out.
- **The key log.** The test page's server (`serve.py`) writes every key you press ON THE TEST PAGE
  into `docs/check-kit/keylog.jsonl`, also what you type into its text box. Never type a password
  or anything private there. The file is not committed (git ignores it) and skydeck never reads it.
  Delete it when the check is done: `rm docs/check-kit/keylog.jsonl`.

## W1. The window opens

Setup: no skydeck window open. In W, start the server first, so that the time below is Edge's
alone (the address it prints is not needed):

```sh
skydeck window --print-url
time skydeck window
```

Expected: an Edge window without an address bar opens, titled `skydeck`, with the session list on
the left; `skydeck window` prints `skydeck window: http://127.0.0.1:47613/ (server pid <n>)` and
exits 0. `skydeck window` once more prints `skydeck window: a window is already open` and opens
nothing. `skydeck doctor` now names the profile folder (`the window's Edge profile folder: …`),
and that folder exists on Windows.

Then close the window, wait 10 seconds, and `time skydeck window` again.

Write down: the `real` time of each run, minus 2 seconds (after the page used its address the
command watches it 2 seconds more), the first after a Windows restart or sign-in ("cold"), the
second ("warm"). The command waits at most 30 seconds for the page; when it says
`Edge was started, but no window connected within 30 seconds; …` instead, write down how long Edge
took until the page showed, and anything Windows showed meanwhile (W20).

## W2. The keys reach the page

**In the window.** The page owns every key of the design's table from stage A on, also those whose
action came with a later stage. Setup: the window open with the throwaway session in slot 1 (its number shows
at the left of its row in Open). Press every key the key help lists (Ctrl+Shift+H): the page must do
what the help says, and Edge nothing of its own (no new window or tab, find bar, print dialog,
devtools pane, history, reload). What the ones with something to see do:

| Key | Expected |
|---|---|
| Ctrl+Shift+L | the key bar's `Focus: list` and `Focus: terminal` change places |
| Ctrl+Shift+1 | the session in slot 1; Ctrl+Shift+9 with no session there: `no session in slot 9` |
| Ctrl+Tab, Ctrl+Shift+O | the previously selected session (`no previous session` when there is none) |
| Ctrl+Shift+N | the new form; Esc closes it |
| Ctrl+Shift+F | the find bar over the terminal; Esc closes it |
| Ctrl+Shift+C | with text selected in the terminal: copies it (paste it into Notepad) |
| Ctrl+Shift+V | Claude Code's image paste (W6) |
| Ctrl+Shift+H | the key help; again: it goes |
| Ctrl+Shift+P | the quick switcher opens over the window, the caret in its field; press Esc and nothing else: it closes (Enter there would switch to the highlighted session, or resume it). W30 checks it |
| Ctrl+Shift+J | look at the title bar first: while it shows a count (`1 needs you`, …), leave this key out here (W21 checks it), since it would select a session that needs you, maybe a real one, and 1.5 seconds later clear that session's mark. With no count: the key bar says `no session needs you` |
| in the list (Ctrl+Shift+L first), with the throwaway session selected (its short id in the header): `l`, F2, `g`, `n`, `p` | its dialog opens over the page (`Label — <title>`, …); Esc closes it and saves nothing. Do not press `d` here: it marks the session done, and W29 checks it |
| in the list: F5, Ctrl+R, Ctrl+F5, Shift+F5, Ctrl+Shift+R | the page reloads itself (the terminals come back) after it has checked the server |
| in the terminal: F5, Ctrl+R | they reach Claude Code; Ctrl+Shift+R reloads the page |
| Alt+F4 | the window closes (`skydeck window` opens it again) |

**The browser's own reload keys.** The design does not know two things. On an ordinary web page in
a normal Edge tab (not skydeck's, not the key-test page: those cancel the keys), press Shift+F5:
does Edge reload? If your keyboard has a Refresh key (BrowserRefresh), press it alone, with Shift
and with Ctrl: does Edge reload? Then, on the key-test page in an app window (below), press the
Refresh key: when "window loads this session" goes up, a Refresh key the page cancelled still
reloaded.

**In a normal browser tab.** In W, start the key-test page's server (read "The key log" in the setup
first) and leave it running:

```sh
cd ~/skydeck
python3 docs/check-kit/serve.py
```

Ctrl+Shift+W and Alt+F4 close a whole Edge window with all its tabs. So open a new Edge window for
this check (Ctrl+N in your Edge), with `http://127.0.0.1:8765/` as its only tab, and press the chords
on the page: each one it received turns green; some close the tab or open a window (that is what is
looked at). What the page received, in another W (`sudo apt install jq` when `jq` is missing; `jq`
prints the names quoted, so that no byte of the log reaches the terminal raw; with `-a` a letter
beyond ASCII shows as its code, `é` as `\u00e9`):

```sh
jq -a 'select(.kind=="keydown").chord' ~/skydeck/docs/check-kit/keylog.jsonl | sort -u
```

To compare with an app window, `sh docs/check-kit/edge-app.sh` opens the same page in one (it
starts `msedge.exe` with a profile folder of its own, `%LOCALAPPDATA%\skydeck-check\edge-profile`;
delete that folder afterwards; when several Windows users have an Edge folder it asks for your
Windows user name as its second argument: `sh docs/check-kit/edge-app.sh http://127.0.0.1:8765/
<you>`). Ctrl+C stops the server; then `rm docs/check-kit/keylog.jsonl`.

And skydeck's page in a tab: `skydeck window --print-url`, paste the address into a normal tab.
The key bar shows `Ctrl+Shift+O previous` and a `+ New` button; Ctrl+Shift+O and `+ New` work.

Write down: every key the window did not act on as the table says, or on which Edge acted too; the
answers on Shift+F5 and the Refresh key; the chords the normal tab kept for the browser (Chromium's
source says Ctrl+W, Ctrl+F4, Ctrl+Shift+W, Alt+F4, Ctrl+N, Ctrl+Shift+N, Ctrl+T, Ctrl+Shift+T,
Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PgDn and Ctrl+PgUp).

## W3. One window, its own taskbar button

With the window open: it has a taskbar button of its own, apart from your own Edge's (its icon is
"W3, the icon", in the part of stage E at the end; the title is `skydeck` while no session needs
you, below). `skydeck window` again opens no second window (`a window is already open`).
`skydeck window --restart`: the same window stays, with the same button, and says `skydeck's
server restarted; your sessions kept running`.
When a check makes WSL restart (W14's third part), look at the button again after `skydeck window`.

The button's title is the window's: while a session needs you it is `(1) skydeck` (`(3) skydeck`
for three), and `skydeck` again once none does. Look at it, with the pointer over the button,
while a session needs you (the title bar's count shows it; W21's step 1 makes one), and again once
none does (after W21's step 2).

Write down: whether the window and your Edge share a button, whether the button changed, and
whether its title showed the count.

## W4. Claude Code in a window terminal (real claude)

In the throwaway session: send a prompt that makes Claude Code work for a while and use a subagent
(`use a subagent to list the files here and describe each`). Watch the status line, the subagent's
display and the spinner. Drag the window's edge to make it narrower and wider: the screen is drawn
again at each width. Then take a screenshot of the window (Win+Shift+S) and, in W:

```sh
skydeck window --restart
```

Expected: the window says `skydeck's server restarted; your sessions kept running`, and the
terminal shows exactly what it showed before: compare with the screenshot. Type into it: it still
answers.

Write down: what was drawn wrong, before or after the restart.

## W5. The screen side answering alone (real claude)

Three questions about how Claude Code talks to the terminal skydeck gives it.

- **Does Claude Code use synchronized output?** The window's server logs nothing of what a program
  writes, so this is recorded in W with `script`, under the environment the window gives its
  programs (design-step-2.md 7.4, `src/window/env.ts`): the variables that name a terminal taken
  out, `TERM=xterm-256color` and `COLORTERM=truecolor` set. In W:

  ```sh
  cd ~/skydeck-try
  (for v in $(env | cut -d= -f1 | grep -E '^(TERM_PROGRAM|TERM_PROGRAM_VERSION|WT_SESSION|WT_PROFILE_ID|TMUX|TMUX_PANE|STY|VTE_VERSION|KITTY_WINDOW_ID|ITERM_SESSION_ID|CLAUDE_CODE_SSE_PORT|ENABLE_IDE_INTEGRATION|GPG_TTY|SSH_TTY|WEZTERM_.*|KONSOLE_.*|VSCODE_.*)$'); do unset "$v"; done
   TERM=xterm-256color COLORTERM=truecolor exec script -q -c claude claude-output.txt)
  ```

  Send one prompt, `/exit`, then `grep -c $'\e\\[?2026h' claude-output.txt`: a number above 0 means
  it does. The file holds what the screen showed: `rm claude-output.txt`. One thing still differs
  from the window: here W's terminal answers Claude Code's questions (which terminal it is, whether
  it supports synchronized output), in the window skydeck's screen side does (xterm.js, which
  supports it). If Claude Code asks before it uses it, a 0 in a terminal that does not support it
  says nothing about the window. Write down which terminal W is, with its version.
- **Does the colour answer make its automatic theme right?** When your Claude Code has a theme
  that follows the terminal (look in `/config` or `/theme`), choose it. While the theme's Mode shows
  `Auto` (follow-up F13: the gear at the right end of the title bar opens Settings, whose first
  group, Appearance, has Mode; pick `Auto` when it shows another, and pick that one again at the
  end), the window is dark while Windows is in dark mode and light in light mode (Settings >
  Personalization > Colors); W34 tries `Light` and `Dark`. Start a new throwaway session in the
  window in each mode, after a click into the window: Claude Code should pick the matching theme.
- **An XTVERSION answer** (`xterm.js(6.0.0)`) would make Claude Code treat the terminal as xterm.js
  (design-step-2.md, 9.3). That is a change of skydeck's code, for a branch, not for this check:
  write down only whether wheel scrolling and link clicks in the window behave as you expect.

Write down the three answers.

## W6. Typing, pasting and copying (real claude)

In the throwaway session:

- Shift+Enter in Claude Code's prompt inserts a new line (it does not send).
- Copy some text in Notepad, Ctrl+V in the prompt: the text arrives as one paste.
- Take a screenshot (Win+Shift+S), then Ctrl+Shift+V in the prompt: Claude Code shows that it has
  an image (`[Image #1]` or similar). It reads the Windows clipboard itself.
- Select text in the terminal with the mouse, Ctrl+Shift+C, Ctrl+V into Notepad: the text arrives.
  (Plain Ctrl+C with a selection interrupts the program: a known limit.)
- A program's clipboard write (OSC 52): when your Claude Code has `/copy` (its documentation says
  it writes the clipboard through the terminal), run it and paste into Notepad. On WSL Claude Code
  may use a Windows program for it instead, so a paste that works says that the copy arrived, not
  which way. The window writes the clipboard only for the terminal it shows, while it has the focus.
- When the window ever says, after a paste, `this terminal is not taking input at the moment: not
  all of what you typed or pasted reached the program` (install.md, "Known limits": a paste larger
  than the program takes), check in that
  session what is not known yet: do the next letters and Enter you type arrive as pasted text, and
  does pasting a short text (Ctrl+V) end that, so that Enter sends again? Claude Code reads its
  input all the time, so a throwaway session may never show it.

Write down each that does not work, and what happened instead.

## W7. Image paste after the first terminal is closed (real claude)

After W6: close the WSL terminal you ran `skydeck window` from (the one that started the server;
keep another WSL terminal open, so that WSL does not stop). In the throwaway session, and in a new
throwaway session, Ctrl+Shift+V a screenshot again. Then in W, `skydeck doctor`: its interop line
reads `<runtimeDir>/interop -> … answers`.

Write down: whether the paste worked in both sessions; the interop line.

## W8. A Czech keyboard

Add the Czech keyboard in Windows (Settings > Time & language > Language & region) and switch to it
(Win+Space) while the window has the focus. In the throwaway session's prompt: the AltGr characters
`\ [ ] { } @ # ~ |` and the dead keys (háček: `ě š č ř ž`; čárka: `á é í ó ú ý`) arrive as typed.
Ctrl+Shift with a digit (the number row, which types the digits with Shift on this layout) selects
that slot; Ctrl+Shift+H shows the key help; Ctrl+Shift+- reaches Claude Code (its undo of the last
edit in the prompt).

Write down every key that arrived wrong or did something else.

## W9. Claude Code's symbols and emoji are drawn (real claude)

In the throwaway session, send a prompt that makes Claude Code use a tool (`list the files here`).
Its tool lines start with `⏺`, their results with `⎿`; Shift+Tab shows `⏵⏵` in the mode line.
Expected: drawn as symbols, not as empty boxes, and in the colours Claude Code gives them: a
finished tool's `⏺` is green (red after a failed one), never a colour emoji (a blue button).

Then send `print 🔴 🟠 🟡 ⚪ 🤷‍♂️ 👨‍👩‍👧 on one line, with a space between them`. Expected: the four
circles red, orange, yellow and white, told apart at a glance (not four grey discs); the shrug and
the family each one picture, two cells wide, not their parts squashed together (#154).

Write down which symbols show as boxes or as colour emoji, and which emoji show in one colour or
in parts.

## W10. Emoji line up (real claude)

In the throwaway session: `print a table with two columns, a symbol and its name, with the rows
🙂, ❤️, 👍🏽, 👨‍👩‍👧 and 🇺🇳`. Expected: the right edges of the table's lines are in one column.
Compare with the same prompt in a session in your usual terminal (Windows Terminal, WezTerm).
The design's question here is whether the width rules of `@xterm/addon-unicode-graphemes`, which
the window uses, match Claude Code's own layout better than `addon-unicode11`, the fallback
(design-step-2.md, 9.4): a change of skydeck's code, not of this check.

Write down which rows are off, and by how many columns, in the window and in your usual terminal;
that is what decides whether the fallback is tried.

## W12. Links open in your default browser (real claude)

A link the window opens (a Ctrl+click on an address in a terminal, a pull request in the list or
the header, the ticket chip) opens in your Windows default browser: skydeck hands it to
`rundll32.exe url.dll,FileProtocolHandler`. With `window.links` `"edge"` it opens in your own Edge
instead (install.md, "The `window` keys"). With `"default"` each link is one start of
`rundll32.exe url.dll,FileProtocolHandler`, which a managed PC's security monitoring may record;
with `"edge"` skydeck starts Edge itself and does not use that program. Part 1 needs no
change of your configuration; part 2 is for trying `"edge"`, and only if you want to. Every step
types only into the throwaway session, never into one of your real work.

**First, what your configuration says.** The paths below are the default ones: with
`XDG_CONFIG_HOME` set, the file is under that folder (install.md, "Places"); with `SKYDECK_HOME`
set, it is `$SKYDECK_HOME/config/config.json`. In W (it only reads the file):

```sh
grep -n '"links"' ~/.config/skydeck/config.json
```

When it prints a line with `"edge"`, your links already open in your own Edge: in part 1 expect your
own Edge wherever it says your default browser, and skip part 2 (it is what you have). When it prints
nothing, a line with `"default"`, or `No such file or directory`, go on as written.

**Part 1, the default.** In the window, select the throwaway session (look at the short id); its
terminal has the keyboard (the key bar says `Focus: terminal`; else Ctrl+Shift+L; an ended terminal
is resumed first). Type `print the address https://github.com/ and nothing else; reply in this
chat, with no tool and no file` (or any page where you are logged in) and press Enter. When Claude
Code asks for anything all the same (to run a command, to write a file), answer **No**. Ctrl+click
the address in the terminal. Expected: it opens in your default browser (the one Windows opens
links in), where you are logged in, not in skydeck's window and not in a new Edge window unless
Edge is your default browser. A link whose text is not its address shows the address at the first
Ctrl+click and opens at the second.

When it opens nowhere: the key bar says `the link could not be opened: the default browser could not
be started (window.links "edge" opens links in Edge)` only when `rundll32.exe` could not be started
from WSL at all (the file is missing, interop is off). When a click opens nothing and the key bar
says nothing, Windows stopped it (the PC's privilege management, W20). Write down which, and any
prompt of the privilege management; then set `window.links` to `"edge"` in your configuration
(install.md, "The `window` keys"; part 2 says where the key goes in the file), so that links open.

Then, the same way (the throwaway session selected, `Focus: terminal`), type `print the address
https://example.com/?q=%OS%&r=1%2C2#a,b and nothing else; reply in this chat, with no tool and no
file` and press Enter; answer **No** to anything Claude Code asks for. Look that the terminal shows
the address as typed; if not, stop and write down what it shows. Ctrl+click it. Expected: one tab in
your default browser whose address (click into the address bar to see it whole) reads
`example.com/?q=%OS%&r=1%2C2#a,b`: `%OS%` as typed, not `Windows_NT`; `%2C` not turned into a
comma; the parts after `&` and `#` there; no second window, no dialog, no other program. If it does
not (`%OS%` became `Windows_NT`, or `%2C` a comma), something on the Windows side changed the
address: write down what the address bar showed, and set `window.links` to `"edge"` in your
configuration as above (`example.com` is IANA's page; it would only have received the word
`Windows_NT`).

**Part 2, `"edge"` (only if you want to try it).** The paths are those of "First" above. In W:

```sh
ls -l ~/.config/skydeck/config.json ~/.config/skydeck/config.json.before-w12
```

- **`config.json.before-w12` is listed**: an earlier W12 did not finish. Do step 2 first (it
  compares the two files before anything is moved back), then start again.
- **Only `config.json` is listed**: you have a configuration, whatever it holds. Copy it aside, as
  it is (`-n`: an existing copy is never written over):

  ```sh
  cp -p -n ~/.config/skydeck/config.json ~/.config/skydeck/config.json.before-w12
  ```

  Then change one thing in `config.json`. When it has a `"window"` object, add `"links": "edge",`
  on a line of its own right after that object's `{`, as its first key (without the trailing comma
  when the object holds no key yet); when that object already has a `"links"` key, change only its
  value to `"edge"`. When it says `"links": "edge"` already (yours, or left by an earlier W12 that
  did not finish), change nothing: the check uses it, and the file is the same at the end; if you
  do not want it, change it by hand afterwards. When it has no `"window"` key, add
  `"window": { "links": "edge" },` on a line of its own right after the file's opening `{`, as its
  first key (without the trailing comma when the file holds no key yet). Never add a second
  `"window"` key: the later one would replace your other `window` keys.
- **Both are missing** (`No such file or directory` twice): you have none. Create the file with
  only this key (the command writes nothing when the file exists):

  ```sh
  mkdir -p ~/.config/skydeck
  test -e ~/.config/skydeck/config.json || printf '%s\n' '{ "window": { "links": "edge" } }' > ~/.config/skydeck/config.json
  ```

To see that the file is valid: `skydeck ls > /dev/null` prints nothing; a line that names
`config.json` says what is wrong (correct the line, or go on with step 2). Then, in W (the server
reads the file when it starts; the window stays and connects again, and the sessions keep
running):

```sh
skydeck window --restart
```

1. As in part 1 (the throwaway session selected, `Focus: terminal`), Ctrl+click the address again.
   Expected: it opens in your own Edge window, not in skydeck's window, where you are logged in to
   Edge.
2. **Give your configuration back**, by the branch you took above. Nothing here removes a file.
   - **You made the copy** (`config.json.before-w12`). Compare first; move nothing yet:

     ```sh
     diff ~/.config/skydeck/config.json.before-w12 ~/.config/skydeck/config.json
     ```

     It must show only this check's change: the line you added after `> ` (with a line such as
     `1a2` above it), or the `"links"` line before (`< `) and after (`> `) when you changed its
     value; for a file on one line, that line before and after, differing only by your change; or
     nothing when you changed nothing. Only then move the copy back over the file (this gives
     back your file as it was, and leaves no copy):

     ```sh
     mv ~/.config/skydeck/config.json.before-w12 ~/.config/skydeck/config.json
     ```

     **When `diff` says `config.json: No such file or directory`**, the file was removed since (after
     an unfinished run), and your keys are only in the copy: move it back with the same `mv` line.
     **When `diff` shows anything else**, the file was changed since the copy was made (by you or by
     a program): move nothing back. Take out of `config.json` by hand only the change this check
     made, keep everything else, and keep the copy until you are sure (remove it yourself then).
   - **You had no file before**: `cat ~/.config/skydeck/config.json` must print exactly the one line
     this check wrote. Then move it aside, so that it is no longer read (it is not removed; remove
     it yourself whenever you like):

     ```sh
     mv -n ~/.config/skydeck/config.json ~/.config/skydeck/config.json.made-by-w12
     ls -l ~/.config/skydeck/config.json
     ```

     `ls` must say `No such file or directory`. When the file is still there, a
     `config.json.made-by-w12` of an earlier W12 was in the way (`-n` never writes over it): look
     at that old one, remove it yourself, and run the two lines again. When `cat` shows more than
     the check's line, something was added since: move nothing, and take out only the `"links"` key
     by hand.

   Then `skydeck window --restart`, and Ctrl+click the address once more. Expected: it opens in your
   default browser again, as in part 1.

Write down where the link opened in part 1 (which browser, logged in or not), the address the
browser showed for the second link, and, if you did part 2, where it opened in part 2.

## W13. What an Edge policy does to the window

In your own Edge, open `edge://policy` and look for entries named `URLBlocklist`, `BrowserSignin`,
`SyncDisabled`, or starting with `WebApp` or `Extension`. Then open a normal Edge window on the
window's own profile folder (the one `skydeck doctor` names), in P:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir="C:\Users\<you>\AppData\Local\skydeck\edge-profile"
```

In that window's address bar: `edge://extensions` (which extensions run there, put in by an
Edge policy) and `edge://settings/profiles` (whether the profile is signed in and syncs its
history). Close that window afterwards; the skydeck window stays.

Write down: the policy entries found (their names and values), the extensions listed, signed in
and syncing or not.

## W14. WSL keeps running when every WSL terminal is closed

**The first form, the one that matters; it needs no script.** It needs a `.wslconfig` without
`instanceIdleTimeout=-1` (with that setting WSL never stops by itself, and the check shows nothing).
Do it while only throwaway sessions run: if the keep-alive does not hold, WSL stops and every
session in it ends (they can be resumed afterwards, as after any WSL restart).

1. In W, `skydeck doctor`: the keep-alive line reads `keep-alive wsl.exe running (pid <n>, since
   <time>)`. Write the pid down.
2. A throwaway session in the window, with one prompt sent.
3. Close every WSL terminal: every terminal window or tab that runs WSL (Windows Terminal, WezTerm,
   VS Code's WSL terminals and its WSL window too, which is a client of WSL as well). Keep the
   skydeck window open. Look at the window's title bar meanwhile: closing the terminal that started
   the server must not make it say `WSL is not kept running`.
4. Wait two minutes (WSL stops 15 seconds after its last client).
5. In the window: no `skydeck's server is not answering` bar. Type a prompt into the throwaway
   session: it answers.
6. In P: `wsl -l -v` shows your distribution `Running`. Then open a WSL terminal again.

**The second part: a keep-alive whose Windows side ends.** With one WSL terminal open (so that WSL
cannot stop meanwhile), open the Task Manager, Details, show the column "Command line", and end the
`wsl.exe` whose command line names `skydeck-keepalive`. Then in W, within about 10 seconds:
`skydeck doctor` shows a keep-alive with another pid, and `ps -p <the pid of step 1>` shows no such
process any more (the script ended with its `wsl.exe`, or the server ended it). Then:

```sh
dmesg | tail -n 40
```

(when it says `Operation not permitted`: `sudo dmesg | tail -n 40`). skydeck asks the sockets of
WSL's interop now and then whether they answer, connecting and sending nothing; look for lines of
WSL about connections to an interop socket.

**The third part, optional: without the keep-alive WSL stops.** This ends EVERY session and terminal
in WSL: do it only when nothing is running that you want to keep. Set `"keepAlive": "off"` in the
`window` of `config.json`, run `skydeck window --restart`, end the keep-alive's `wsl.exe` in the
Task Manager as above, close every WSL terminal, wait one minute. Expected: `wsl -l -v` in P shows
the distribution `Stopped`, and the window shows the bar. Then take `"keepAlive"` out of
`config.json` again, open a WSL terminal and run `skydeck window`: the window says `WSL has
restarted since <time>: the sessions that were running have ended.` (Since stage C the command
first says `skydeck: waiting up to 7 s for the open window to come back; …` and opens no second
window; when one opens, write it down and close one. The banner at the top of the list offers what
was running when WSL stopped: click `Not now`; restoring is W16's.)

Write down: for the first form, passed or WSL stopped (then the window showed the bar); the
keep-alive's pids; whether the old script was gone; the `dmesg` lines about interop; for the third
part, whether WSL stopped.

**The second form, optional: measure WSL's idle rule** with `docs/check-kit/lifetime/lifetime.ps1`
against a throwaway distribution, which it imports and removes again. **On a managed company PC
only with the agreement of the PC's owner; no check requires it. Do not bypass or change
PowerShell's execution policy for it.** It needs Alpine's mini root filesystem, which is not in
the repository: `https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.4-x86_64.tar.gz`,
sha256 `cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012` (Alpine publishes the
same in the `.sha256` file beside it). It is fetched in WSL with curl and its sha256 compared
before it is used. When Windows or PowerShell warns about, asks about or refuses the script or the
tarball, do not unblock it and change no setting: leave this form out. In W (put your Windows user
name for `<you>`):

```sh
W=/mnt/c/Users/<you>/AppData/Local/skydeck-check/wsl
mkdir -p "$W"
cp ~/skydeck/docs/check-kit/lifetime/lifetime.ps1 "$W/"
curl -fL -o "$W/alpine-minirootfs-3.24.4-x86_64.tar.gz" https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.4-x86_64.tar.gz
echo "cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012  $W/alpine-minirootfs-3.24.4-x86_64.tar.gz" | sha256sum -c
```

The last line must end with `OK`; with `FAILED`, delete the file and stop. In P:

```powershell
cd $env:LOCALAPPDATA\skydeck-check\wsl
if ((Get-FileHash .\alpine-minirootfs-3.24.4-x86_64.tar.gz -Algorithm SHA256).Hash -eq 'cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012') { 'same' } else { 'different' }
powershell.exe -NoProfile -File .\lifetime.ps1
```

The second line must print `same`; with `different`, stop. When the script says that the tarball
is not there or that `wsl.exe --import` failed, it stops before it measures anything: the check
has not been run. When PowerShell answers that running
scripts is disabled on this system, this form is not for this PC: stop here. Otherwise it prints
timestamped lines for about 4 minutes. Expected: A, the distribution leaves the running list
within 90 seconds (its source says about 15); B, still running after 60 seconds with a hidden
`wsl.exe` child; C, that child ends within seconds of `wsl --terminate`; D, the distribution leaves
the list about 15 seconds after the child was killed. It removes the throwaway distribution at the
end. If it stops halfway, in P: `wsl --unregister skydeck-test`, exactly this name
(`--unregister` deletes a distribution and everything in it: never give it your own one's name).
Afterwards delete `%LOCALAPPDATA%\skydeck-check`.

Write down: the lines it printed.

## W15. Sleep

With the window open and the throwaway session in it: lock the PC, or let it sleep, for a few
minutes. Come back. Expected: the window recovers by itself (when it showed the bar `skydeck's
server is not answering`, the bar goes once it is connected again), keys work, the terminal is
drawn again, the session still runs (send it a prompt).

The key-test page can do the same: `docs/check-kit/STEPS.txt`, step 3.

Write down: what the window showed after the wake, and how long it took to work again.

## Minimised for half an hour

The page judges that the server is silent only against a ping it really sent, so a window whose
timers Chromium holds back (hidden, minimised, covered) must keep its connection. Minimise the
window (or cover it with another window) for half an hour. Meanwhile, in W, `skydeck doctor`
says `1 page` in its server line, and `skydeck window` says `a window is already open` and opens
no second one. Then bring the window back. Expected: no `skydeck's server is not answering` bar
and no `restarted` notice; the terminal answers at once.

Write down: anything the window showed when it came back; whether a second window opened.

## W17. The full-screen mode comes back after a restart (real claude)

In the throwaway session, `/tui fullscreen` (or whatever your Claude Code calls its full-screen
mode). Scroll with the mouse wheel, take a screenshot, then in W: `skydeck window --restart`.
Expected: the full-screen screen is back as it was, and the mouse wheel acts as before.

Write down: what differed.

## W18. A terminal query answered late (real claude)

Claude Code asks its terminal a few questions when it starts. Make the server be away while it
does. Have `skydeck window --stop` typed in W (not sent yet). In the window, select the throwaway
session (its row in Open) and press Ctrl+Shift+N: the directory field must say
`/home/<you>/skydeck-try`, the folder of the setup (type it in when it says anything else) — a real
`claude` starts in that folder. Press Enter in the form, and Enter in W right after. Wait 5 seconds,
then `skydeck window` (or `skydeck window --restart`), and look at the new session's prompt.

Expected: no characters you did not type in the prompt (such as `[?62;c`, `0;276;0c`, `[1;1R` or
`rgb:`), and the first keys you type arrive.

Write down: any stray characters; whether a key was swallowed.

## W20. Privilege management lets Edge, wsl.exe and rundll32.exe start

Where a PC runs privilege-management software, it must neither block nor ask for
`msedge.exe` started by `skydeck window` (W1), for the keep-alive's `wsl.exe`, which the server
starts when it starts (`skydeck doctor`: `keep-alive wsl.exe running …`), or for `rundll32.exe`,
which the server starts for every link the window opens with `window.links` `"default"` (W12).
Watch for a dialog during W1, right after a `skydeck window --restart`, and at W12's first link. A
silent block of `rundll32.exe` shows as a link that opens nowhere with an empty key bar.

Write down: any dialog's exact text, and what you chose.

## W22. A session from another terminal (real claude)

In W: `cd ~/skydeck-try && claude`, send one prompt. In the window its row shows `running in another
terminal`; select it: a card with its pid, its terminal device and its directory, and no way to
show or resume it in the window (Enter shows the card). In a second W, `skydeck resume <ref>` is
refused with the guard's message (`skydeck: <short id> is running (pid <n>)`, exit 4). Then `/exit`
the session in the first W. Within a few seconds its row in the window is not running and shows the
resume card; Enter resumes it into the window, with its conversation.

Write down: what the card showed; whether the resume into the window worked.

## W23. What Claude Code sets for the programs it runs (real claude)

In the throwaway session, the names only (never the values):

```
! env | cut -d= -f1 | grep '^CLAUDE' | sort
```

and in W the same without the `!`. Write down the names that only the session has, and compare
them with the list in design-step-2.md, section 7.4 (the names skydeck takes out of a window
program's environment). Then, in the session, `! skydeck window`: it refuses with
`skydeck: the window's server is not started from inside a Claude Code session: …` (exit 1).

Write down: the names; whether `skydeck window` refused.

## W24. No crash dumps

A crashing process's dump on WSL goes to a Windows folder, `%Temp%\wsl-crashes` (or the folder
`crashDumpFolder` in `.wslconfig` names). skydeck's keepers and server must leave none: a dump
would hold the screens. Before you start, in W, look at the folder (put your Windows user name for
`<you>`) and write down what is there:

```sh
ls -l /mnt/c/Users/<you>/AppData/Local/Temp/wsl-crashes
```

**A keeper.** This ends that session, and a wrong pid would end a real one: when in doubt, do it
while only throwaway sessions are open in the window. Find the pid in skydeck's own record:

1. In the window, select the throwaway session. Its header shows its short id (8 characters) and
   the directory `/home/<you>/skydeck-try`.
2. In W, `skydeck doctor | grep 'keeper .*session '`. Take the one line whose `session <id>` starts
   with that short id (`keeper <t>: running (pid <n>, …); the server shows it in slot <s>, …,
   session <id>`); `<s>` is the number at the left of the session's row. No such line, or more than
   one: stop.
3. The record behind that line is `<runtime directory>/terms/<t>.pid`, the runtime directory named
   in doctor's `runtime directory …` line: `cut -d' ' -f1 <runtime directory>/terms/<t>.pid` prints
   the same `<n>`. Only then: `kill -SEGV <n>`.

Expected: the window shows that terminal's bar `the terminal's keeper ended unexpectedly; claude
ended with it`.

**The server's Node.js.** A throwaway server in a trial installation, so that the window's own
server is not touched. In W:

```sh
T=$(mktemp -d); echo "$T"
mkdir -p "$T/config"
printf '{ "window": { "port": 47699, "keepAlive": "off" } }\n' > "$T/config/config.json"
SKYDECK_HOME="$T" skydeck serve --foreground
```

(The trial home has no `node` link: with a default `node` older than 24.12, put
`SKYDECK_NODE=<the node install linked>` in front, for instance
`SKYDECK_NODE="$(readlink ~/.local/share/skydeck/node)"`.)

In a second W (put the directory the first one printed for `$T`):

```sh
T=/tmp/tmp.XXXXXXXXXX
grep 'Max core file size' /proc/$(cut -d' ' -f1 "$T/run/server.pid")/limits
kill -SEGV "$(cut -d' ' -f1 "$T/run/server.pid")"
rm -r "$T"
```

Expected: the soft limit is `1` (bytes), and the server in the first W ends.

Then look at the folder again: no new file. Write down: the folder before and after; the limit.

## W25. A Windows program on skydeck's port

This puts a program of yours on skydeck's port on the Windows side for a few minutes. **On a
managed company PC only with the agreement of the PC's owner.** It is a PowerShell line typed at
the prompt: no script file, no change to the execution policy. In W first:
`skydeck window --stop` (the sessions keep running).

In P, with your `window.port` if you changed it, and leave it running:

```powershell
$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 47613); $l.Start(); 'listening on 127.0.0.1:47613; Ctrl+C stops'; try { while ($true) { Start-Sleep -Seconds 1 } } finally { $l.Stop() }
```

In W: `skydeck window`. The server starts (WSL does not see the Windows program), Edge opens, but
the page does not load: the program takes the connection and answers nothing, so the command ends
with `Edge was started, but no window connected within 30 seconds; …`. (With
`networkingMode=mirrored` in `.wslconfig`, WSL shares Windows' ports, and the server may not get
the port the Windows program holds: then `skydeck window` fails with `port 47613 on 127.0.0.1 is
used by another program; …`. Write that line down; it answers the question too.) In a second P:

```powershell
curl.exe -s -m 5 -o NUL -w "%{http_code}`n" http://127.0.0.1:47613/
curl.exe -s -m 5 -o NUL -w "%{http_code}`n" "http://[::1]:47613/"
```

The first prints `000` (the program answers nothing). The second: a number such as `421` means that
skydeck's server in WSL answers on Windows' IPv6 loopback — the case in which a program could sit
between window and server (design-step-2.md, 15.3); `000` means it does not.

Then Ctrl+C in the first P (the program stops), close the window that did not load, and in W
`skydeck window --restart`. The program served no page, so nothing of skydeck's key reached it.

The design's second question, whether Edge drops a service worker that a program like this left in
the window's profile once skydeck's server answers its script with 404: the page tests answer it
for Chromium — it is NOT dropped, it keeps answering the window's loads — and for Edge it stays
open: the kit plants no worker in your profile. The known limit and the way out are those of
install.md ("Known limits"): close every skydeck window, delete the window's profile folder, and
run `skydeck window --new-secret`.

Write down: the two answers of `curl.exe`; what the window showed.

## W26. A restart while the alternate screen shows (real claude)

In the throwaway session, `/tui fullscreen` (as in W17). Take a screenshot, run `skydeck window
--restart` in W, and compare. Then leave the full-screen mode and compare the normal screen with
how it looked before. What a rebuilt screen does not restore (the scroll region, the saved cursor,
the character sets) would show as a cursor in the wrong place, or lines scrolled or drawn wrong.

Write down: what differed, in the full-screen mode and after it.

## The window (step 2, stage D)

The checks of the design's section 18 (design-step-2.md) that stage D needs: W27–W29, editing in
the window ([install.md](install.md), "Editing a session (stage D)" and "The ticket link"). Each
check says what to set up, what to type, what to look at and what to write down.

Setup:

- The setup of "The window (step 2, stage A)" above, with its **throwaway session in the
  window**. Every step here uses that session, never one of your real work: `l` and Enter on a
  real row replace its label for good.
- **Before every key and every click**, look at the header's short id (on its second line, after
  the directory, the times and where the title comes from): it must be the throwaway session's
  (`skydeck ls` in W prints the short ids as the last column). In a dialog, the heading names the
  session (`Label — <title>`): it must be the throwaway session's title.
- **Type text only into an open dialog.** After `l`, F2, `g`, `n`, `p` or a click that opens one,
  look that the dialog is there before you type: its heading names the session, and its field has
  the keyboard (the cursor blinks in it). When the key bar says `the … is not here yet; press …
  again` instead (for up to a second right after a save), no dialog opened: type nothing, and
  press that key again. Text typed while the list has the keyboard is list keys: `k` moves to the
  row above, which may be a real session, `d` marks the selected row done (on a session running in
  the window it opens the dialog `Mark done`, where a following Enter or Space marks it done and
  keeps it running; nothing is ended), Enter resumes or shows it.
- No step marks a real session done, edits a real note or closes a window. After `d` the selection
  moves to the next row, which may be a real session: click `Undo` in the toast before the next
  key.
- Each check starts from a throwaway session with no label, group, note or pull request of yours
  (the header shows `+ group`, `no pull request` and `no note`), sets what it needs, and clears it
  again at its end, so that the checks can run in any order.

## W27. The group chip opens your ticket

Setup: one of your ticket keys (`ABC-123` below: with the default `groupPattern` capital letters
and digits, a hyphen and a number) and your ticket system's address for a ticket, with `{key}`
where the key goes. The throwaway session has no group of its own: its header shows `+ group`.

**Your configuration comes first.** The paths below are the default ones: with `XDG_CONFIG_HOME`
set, the file is under that folder (install.md, "Places"); with `SKYDECK_HOME` set, it is
`$SKYDECK_HOME/config/config.json` (install.md, "Environment variables"). In W:

```sh
ls -l ~/.config/skydeck/config.json ~/.config/skydeck/config.json.before-w27
```

- **`config.json.before-w27` is listed**: an earlier W27 did not finish. Do its step 4 first (it
  compares the two files before anything is copied), then start again.
- **Only `config.json` is listed**: you have a configuration, whatever it holds. Copy it aside, as
  it is (`-n`: an existing copy is never written over):

  ```sh
  cp -p -n ~/.config/skydeck/config.json ~/.config/skydeck/config.json.before-w27
  ```

  Then add one line, on a line of its own right after the opening `{`, as its first key:
  `"ticketUrl": "https://<your site>.atlassian.net/browse/{key}",` (for Jira; else your ticket
  system's address, with `{key}` where the key goes). In a file written on one line
  (`{ "terminal": "wezterm" }`), put the key right after `{` on that line instead. In a file
  that holds no key yet (`{}`, `{ }`, or `{` and `}` on two lines), add it without the trailing
  comma. When the file already holds a `"ticketUrl"` line (yours, or one left by an earlier W27
  that did not finish), add nothing: the check uses it, and the file is the same at the end. If
  you do not want that link, remove the line by hand afterwards.
- **Both are missing** (`No such file or directory` twice): you have none. Create the file with
  only this key (put your site's address; the command writes nothing when the file exists):

  ```sh
  mkdir -p ~/.config/skydeck
  test -e ~/.config/skydeck/config.json || printf '%s\n' '{ "ticketUrl": "https://<your site>.atlassian.net/browse/{key}" }' > ~/.config/skydeck/config.json
  ```

A mistake in the file makes every skydeck command print one line that names the file and the key
and exit 1, and do nothing else (`skydeck doctor` shows it as a problem line); correct the line, or
go on with step 4. To see that the file is valid: `skydeck ls > /dev/null` prints nothing; a line
that names `config.json` says what is wrong. Then, in W (the server reads the file when it starts;
the window stays and connects again):

```sh
skydeck window --restart
```

1. In the window, select the throwaway session. In the list (Ctrl+Shift+L until the key bar says
   `Focus: list`) press `l`, and wait for the dialog: its heading is `Label — <the throwaway
   session's title>` and the cursor is in its field (setup: type only into an open dialog). Type
   `ABC-123 skydeck check` and press Enter. Expected: the dialog closes, the header's title is
   `ABC-123 skydeck check`, and the group chip shows `ABC-123 ↗`, underlined, with your ticket's
   address as its tooltip.
2. In W: `skydeck show <short id>`. Expected: the line `group:     ABC-123`, and after it
   `ticket:    ` with your ticket's address.
3. Click the group chip once. Expected: the ticket opens where links open (W12: your default
   browser, or your own Edge with `window.links` `"edge"`), not in skydeck's window, where you are
   logged in. A drag over the chip selects its text and opens nothing.
4. **Give your configuration back**, by the branch you took above:
   - **You made the copy.** Compare first; copy nothing yet:

     ```sh
     diff ~/.config/skydeck/config.json.before-w27 ~/.config/skydeck/config.json
     ```

     It must show only your own change: the `ticketUrl` line you added, after `> ` (with a line
     such as `1a2` above it); for a file on one line, that line before (`< `) and after (`> `),
     differing only by your key (with `1c1` above them); or nothing when you added none. Only
     then put the copy back, and remove it once the two are the same:

     ```sh
     cp -p ~/.config/skydeck/config.json.before-w27 ~/.config/skydeck/config.json
     cmp ~/.config/skydeck/config.json.before-w27 ~/.config/skydeck/config.json && rm ~/.config/skydeck/config.json.before-w27
     ```

     **When `diff` says `config.json: No such file or directory`**, the file was removed since
     (after an unfinished run), and your keys are only in the copy: put the copy back with the
     same `cp -p` line as above, then `cmp` and `rm` as above. Change nothing in it: the copy was
     taken before this check added its line, so a `ticketUrl` in it is your own.

     **When `diff` shows anything else**, the file was changed since the copy was made (by you or
     by a program): copy nothing back. Look at both files, take out of `config.json` by hand the
     `ticketUrl` line this check added, keep everything else, and only then remove the copy
     (`rm ~/.config/skydeck/config.json.before-w27`).
   - **You had no file before**: `cat ~/.config/skydeck/config.json` must print exactly the one
     line this check wrote; then remove the file this run created,
     `rm ~/.config/skydeck/config.json`. When it holds more, something was added since: take out
     only the `ticketUrl` key, by hand.

   Then `skydeck window --restart`. Expected: the chip shows `ABC-123` without `↗`, not
   underlined, with the tooltip `group (from the title)`; a click on it opens nothing; `skydeck
   show <short id>` prints no `ticket:` line. (When your own configuration has a `ticketUrl` of
   its own, the chip keeps its `↗`: write that down instead. To keep the link for good, set it
   afterwards as install.md, "The ticket link", shows.)
5. Clear the label: select the throwaway session (look at the short id), Ctrl+Shift+L until the
   key bar says `Focus: list` (a click on a running row gives the keyboard to its terminal, and
   these keys would reach Claude Code), then `l`; once the dialog is open (the cursor in its
   field), Backspace (the field holds the label, selected) and Enter. Expected: the title is the
   one it had before step 1, the header shows `+ group`, and `skydeck show <short id>` prints
   `label:     -`.

Write down: where the ticket opened, and whether you were logged in there; whether the chip was a
link only with `ticketUrl`; the `ticket:` line.

## W28. A pull request of your own

Setup: an open pull request of yours on GitHub that your `gh` can read (`gh auth status` says you
are logged in), and its address, `https://github.com/<owner>/<repo>/pull/<n>`. In the window,
select the throwaway session: the header's third line says `no pull request` and `+ PR`.

1. Click `+ PR`. The dialog's heading is `Pull requests — <the throwaway session's title>`, it
   says `no pull request attached`, and the cursor is in its field. Paste the address into the
   field (Ctrl+V) and press Enter. Expected: the field empties, the dialog stays open, and a line
   for the pull request appears: `<owner>/<repo> #<n> · not fetched` when skydeck has never read
   it, else its last state (it may already be attached to the session you made it in). Within
   seconds the line shows its state read now, through your `gh` (`… · checks pending · checked
   2s ago`, `… · approved, green · checked 2s ago`, …). Its tooltip is the pull request's title.
2. Esc. Expected: the header's third line shows the chip (`PR · pending`, …), the item
   `<owner>/<repo> #<n> · pending` (the same state) and `Pull requests`; the session's row in the
   list has the same chip.
3. In W: `skydeck show <short id>`. Expected: a `pr:` line with the same state, in the command
   line's words (`checks-pending`, `approved-green`, …).
4. Click the item on the header's third line. Expected: the pull request opens where links open
   (W12: your default browser, or your own Edge with `window.links` `"edge"`).
5. `Pull requests`, then `↻`. Expected: within seconds the line's `checked … ago` starts again
   from a few seconds.
6. Open the pull request's page on GitHub and read what it says above the merge button (checks
   failing, changes requested, approvals still required, checks pending, conversations to resolve,
   merging blocked). Expected (no test can show GitHub's real answer): the line says the first
   that applies of `checks failing`, `changes requested`, `checks pending` (checks running),
   `review required`, `unresolved comments`, `draft`, `checks pending` (a required check that has
   not reported), `blocked`; with none of them `approved, green` only when the page shows the
   approvals it asks for, `checks passing` or `open` only where it asks for no review. Not shown
   by skydeck: conflicts, and a branch behind its base (the page may say so while the line says
   `approved, green`). `blocked` shows only once GitHub has worked out the merge state: right
   after the base branch moved, press `↻` once more and compare again.
7. `×` on the line. Expected: the line goes, and the toast says `Detached <owner>/<repo> #<n>`
   with `Undo` (leave it). Esc. The header's third line says `no pull request` and `+ PR` again,
   and `skydeck show <short id>` has no `pr:` line.

Write down: how long the state took to show; whether the dialog's line, the header, the list's
chip and `skydeck show` agreed; what GitHub's page said in step 6 and the line's words; any
`can't read`, with its error.

## W29. The edit keys on your layouts (real claude)

Run it once on the US layout and once on the Czech one (Win+Space switches, W8). Setup: the
throwaway session running in the window (Enter on its row resumes it) and selected, and the list
has the keyboard (Ctrl+Shift+L until the key bar says `Focus: list`). Look at the header's short
id before every key, and type text only into an open dialog (the setup above): right after a
save, the next of these keys can say `the … is not here yet; press … again` for up to a second
instead of opening its dialog; type nothing then, and press the key again.

1. `l`: the label's dialog (`Label — <title>`, the cursor in its field). Type `W29 label` (on
   the Czech layout also `ěščř`) and press Enter. Expected: the dialog closes; the header's title
   and the row show the new label. F2: the same dialog; Esc closes it and changes nothing.
2. `g`: the group's dialog, once it is open. Type `w29-group` and press Enter. Expected: the
   group chip shows `w29-group`, with ✎ beside it.
3. `n`: the note's dialog, with a text box, once it is open. Type two lines (Enter between them
   is a line break), then press Ctrl+Enter. Expected: the dialog closes; the header's fourth line
   shows the first line followed by ` …`.
4. `n` again; once the dialog is open, change the text and press Esc. Expected: the dialog stays
   and says `Esc again discards your text`. With the text still changed, press F5, Shift+F5,
   Ctrl+F5, Ctrl+R and Ctrl+Shift+R, then the keyboard's refresh key if it has one (alone, with
   Shift, with Ctrl).
   Expected for each: the key bar says `save or cancel the edit first`, and the window neither
   reloads nor asks. **If Edge asks whether to reload or leave the page, that key got through the
   page's guard: choose Cancel (your text stays in the box), write down which key, and report
   it.** If the window reloads without asking, the text is lost: write that down too. Then Esc
   again: the dialog closes, and the note is the one saved in step 3.
5. `p`: the pull-request dialog. Esc closes it.
6. In W: `skydeck show <short id>`. Expected: its `label:`, `group:` and `note:` lines are what you
   typed in steps 1 to 3.
7. Back in the window, Ctrl+Shift+L until the key bar says `Focus: list`, then `d`. Expected:
   the dialog `Mark done: ` with the session's title, the keyboard on `Mark done, keep it
   running`. Click `Mark done, keep it running` (never `End session and mark done`). Expected:
   the toast `Marked done. Stays under Open while it runs; hidden once it stops.` with `Undo`;
   the row stays under Open with a `done` mark, and stays selected. Click `Undo` within 5
   seconds: the mark goes.
8. End the throwaway session: Ctrl+Shift+L to its terminal, look at the short id (`/exit` ends
   the session it is typed into), `/exit`, then `Close` on its ended bar. Its row moves to
   Recent. Click it (it no longer runs, so the list gets the keyboard: the key bar says `Focus:
   list`; look at the short id) and press `d`. Expected: the row disappears, the toast says
   `Marked done: hidden from the list. It comes back on new activity.`, and the row after it in
   Recent is selected (the one before it when it was the last; none when it was alone) —
   another session: **click `Undo` now, before any key**. Expected: the throwaway session is back
   in Recent and selected again. (When the toast went before you clicked: `a` shows the done
   sessions; click the throwaway session's row, look at its short id, press `d`, then `a` again.)
9. Clear what this check set, with the throwaway session selected (look at the short id) and the
   key bar saying `Focus: list` (Ctrl+Shift+L until it does), each key only once its dialog is
   open: `l`, Backspace (the field holds the label, selected), Enter; `g`, Backspace, Enter; `n`,
   Ctrl+A, Backspace, Ctrl+Enter. Expected:
   the header shows the title it had before step 1, `+ group` and `no note`; `skydeck show <short
   id>` in W prints `label:     -` and `group:     -`, and no `note:`.

Write down, per layout: every key that did something else than described here, or nothing; in
step 4, whether a reload key reloaded the window with changed text, and which.

## The window (step 2, stage B)

The checks of the design's section 18 (design-step-2.md) that stage B needs: W11, W19 and W21,
which sessions need you and the desktop notifications ([install.md](install.md), "Which sessions
need you (stage B)"), and W3's title (above). Each check says what to set up, what to type, what to
look at and what to write down.

Setup:

- The setup of "The window (step 2, stage A)" above, with its **throwaway session in the window**.
  Every prompt here goes to that session or to the other throwaway session below, never to one of
  your real work. **Before every key you type into the window**, look at the header's short id
  (on its second line, after the directory, the times and where the title comes from): it must be
  that of one of the two throwaway sessions, the one the step names. No step presses Enter on a
  row whose short id you have not looked at.
- **A prompt is typed only into a terminal that has the keyboard**: the key bar says `Focus:
  terminal` (else Ctrl+Shift+L until it does), and the header's short id is the throwaway session's.
  When that session's terminal has ended (its last screen is dimmed under a bar with Resume and
  Close), click `Resume` on the bar first and wait until it runs; when it has no terminal in the
  window at all (after a restart of the PC or of WSL), its resume card shows instead: click `Resume
  here` on the card and wait until it runs. Type nothing otherwise: text typed while the list has
  the keyboard is list keys — `k` moves to the row above, which may be a real session, `n` opens its
  note, `l` its label, `d` marks it done (on a session running in the window it opens the dialog `Mark done`, where a following Enter or Space marks it done and keeps it running; nothing is ended).
- **The other throwaway session**, in a terminal of your own: open one more WSL terminal, **T**, and
  in it `cd ~/skydeck-try && claude`; send it one prompt (`say hello in one word`). In the window
  its row is under Open and says `running in another terminal`; once its answer is written, its
  second line is `finished · not seen · <age>` instead: click the row, and the mark goes after 1.5
  seconds or a little more (its card shows). A turn this short can also be over between two of the
  server's looks and leave no mark: then there is nothing to clear. When a step says "click the
  other session's row", click that row: the window shows its card, and nothing you type in the
  window reaches it. **When you are done with the checks of this part**, end it: `/exit` in T.
- **The story prompt** is `write a story of about 300 words about a lighthouse; reply in this
  chat, with no tool and no file`: Claude Code writes for a while. When it asks for anything all
  the same (to run a command, to write a file), answer **No** and send the prompt again.
- A permission prompt is made with a command that asks and does no harm if it were allowed
  (`touch skydeck-check.txt` in the throwaway folder), answered **No**; a question by asking
  Claude Code for one, answered.
- No step changes Edge's or Windows' settings. Allowing notifications (W11, step 1) is the one
  permission asked, and `Block` is as good an answer to write down as `Allow`. Windows' Do not
  disturb holds notifications back: before W11, look whether it is on (the bell at the right end
  of the taskbar, or Win+N) and write it down; change nothing.
- **Your real sessions keep running** and can need you meanwhile: a notification can be one of
  theirs. Click only a notification titled with a throwaway session's title: a click selects its
  session, and 1.5 seconds later that session's mark is cleared. Likewise Ctrl+Shift+J is pressed
  only where a step says so, once it has said how to see that the session it goes to is the
  throwaway one.
- The checks run in any order; each clears the marks it made. W3's title is looked at while a
  session needs you, which W21's step 1 makes.
- What to look at: a row's left bar and second line, the title bar's count at its left
  (`1 needs you`; higher when other sessions need you too), the key bar, and the notifications.

## W11. Desktop notifications (real claude)

Setup: look at the right of the title bar.

- `Turn on notifications` is there: Edge has not been asked yet. Start at step 1.
- It is not there: Edge has an answer from before. When you allowed notifications then, start at
  step 2 and leave out steps 1 and 5. When you blocked them, when Edge or a policy
  refused, or when you do not know, do step 5 first: it shows Edge's answer. With the answer
  `Allow` there, go on with steps 2 to 4 and 6; otherwise W11 ends after step 5.

1. **The prompt.** Click `Turn on notifications`. Expected: Edge's own prompt, asking whether the
   page at `127.0.0.1:47613` (or your `window.port`) may show notifications. Choose `Allow` or
   `Block`; both are valid answers. Expected either way: the button goes. When no prompt comes and
   the button goes at once, Edge or a policy refused: write that down. When you close
   the prompt without choosing, the button stays: click it again. When no prompt comes and the
   button stays (Edge may ask quietly, with a small icon where an address bar would be, and the
   window has none): write that down, change nothing, and leave W11 there. After `Block` or a
   refusal, do only step 5 of W11: steps 2 to 4 and 6 need notifications, and the title bar's count
   and the window's title (W21, W3) are what shows you that a session needs you.
2. **A notification, and a click on it.** Select the throwaway session; its terminal has the
   keyboard (the key bar says `Focus: terminal`). Type the story prompt and press Enter. At once
   click the other session's row (its card shows), then click into W, so that no skydeck window has
   the focus; leave the skydeck window where you can see it. Expected: while the story is written,
   the throwaway session's second line starts with `working`; once it is done, the line is `finished
   · not seen · <age>`, and a desktop notification comes, titled with the throwaway session's title,
   its text `finished`. Click the notification. Expected: the skydeck window comes to the front with
   the throwaway session selected (its terminal shows; the header's short id is its), and its mark
   goes after 1.5 seconds or a little more.
3. **A notification the page closes.** Do step 2 again up to the notification, but do not click
   it: let it go from the screen (Windows keeps it in its notification centre: Win+N shows it).
   Click the throwaway session's row in the skydeck window and wait until its mark goes. Then open
   the notification centre (Win+N). Expected, from skydeck's side: the page has closed that
   notification. Whether Windows still lists it is what this step finds out.
4. **The PC locked while the window is in front.** The commonest way of being away: the session you
   work in is selected, its window in front, and you lock the PC. Select the throwaway session (the
   key bar says `Focus: terminal`), type the story prompt and press Enter, and keep the skydeck
   window in front with that session selected (click nothing else). Lock the PC at once (Win+L) and
   wait two minutes; when Windows shows a notification on the lock screen, write it down. Unlock,
   and the moment the desktop is back, before you click anything, look at the throwaway session's
   row, the title bar's count and the taskbar button's title; then open the notification centre
   (Win+N). Expected, one of two:
   - Edge still said that the window had the focus while the PC was locked: the session was seen
     at its turn end, so no `finished · not seen`, no count and no notification. Then a turn that
     ends in the session you work in while you are away gives no mark and no notification.
   - Locking took the focus from the window: a notification `finished` came (on the lock screen,
     or in the notification centre), and the row says `finished · not seen` — but only for a
     moment: once the window has the focus again, its selected session is seen after 1.5 seconds
     or a little more, the mark goes, and the page closes the notification. Looked at too late,
     this case looks like the first one.

   Write down exactly what you saw, and when. When the mark is still there, click the throwaway
   session's row and wait until it goes.
5. **Where Edge keeps the answer.** Ctrl+Shift+L until the key bar says `Focus: list`, then F5:
   the page reloads, and `Turn on notifications` does not come back. Edge keeps your answer in the
   window's own profile, among its site permissions for notifications. To look at it (only to look:
   change nothing there), open a normal Edge window on the window's profile folder (the one
   `skydeck doctor` names), as in W13, in P:

   ```powershell
   & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir="C:\Users\<you>\AppData\Local\skydeck\edge-profile"
   ```

   and in that window's address bar `edge://settings/content/notifications` (when Edge shows
   another page, type `notifications` into the search field of its settings). Expected:
   `http://127.0.0.1:47613` (with your `window.port` if you changed it) under the allowed or the
   blocked sites, as you answered. Close that Edge window; the skydeck window stays.
6. **Minimised for half an hour.** The other session in T is idle, and its row has no mark.
   Minimise the skydeck window, and touch neither it nor T for 30 minutes (the stage A check
   "Minimised for half an hour" can be run at the same time). Then, in T, send the story prompt to
   that session. Expected: once the story is written, a notification titled with that session's
   title, its text `finished`, without your touching the window. Click it. Expected: the window
   comes back with that session selected (the card of a session that runs in another terminal),
   and after 1.5 seconds or a little more its mark goes. When the window stays minimised, write
   that down, bring it back yourself, and click that session's row until its mark goes.

Write down: whether Do not disturb was on; the prompt's text and your answer; for each
notification, whether it came, how long after the turn's end, and what it showed (its title, its
text, and the name Windows put on it); whether a click selected the session; whether Windows still
listed the notification the page closed (step 3); what you saw after the lock (step 4); what
Edge's settings list for skydeck's address (step 5); whether the notification came after half an
hour, and whether its click brought the minimised window back (step 6).

## W19. What a session that asks shows (real claude)

In the window, select the throwaway session (look at the short id); its terminal has the
keyboard (the key bar says `Focus: terminal`; else Ctrl+Shift+L).

1. Type `please run: touch skydeck-check.txt` and press Enter. Expected: Claude Code shows its
   permission prompt for the command; meanwhile the throwaway session's row has a bar at its left
   in the waiting colour, and its second line is `needs you · <detail> · <age>` (`needs you ·
   <age>` without a detail), also while it is the selected one; the title bar's count went up by
   one. Write the line down as far as it shows (a long one ends with `…` where the row ends).
   Answer **No** (the prompt's `No`, or Esc). Expected: the line goes once the prompt is closed.
   When nothing asks, your permission mode allows the command: Claude Code makes the empty file
   `skydeck-check.txt` in the throwaway folder, which does no harm. Write down that it did not
   ask, remove the file in W (`rm ~/skydeck-try/skydeck-check.txt`), and in step 3 use the
   question of step 2.
2. Type `ask me with your question tool whether I prefer tea or coffee, then stop` and press
   Enter. Expected: Claude Code asks its question, and the row's second line is
   `needs you · <detail> · <age>` as in step 1. Write the line down; answer the question.
3. What a notification shows (only with notifications allowed, W11): do step 1 again, and right
   after Enter click into W, so that no skydeck window has the focus. Expected: a notification
   titled with the throwaway session's title, its text `asks: <detail>` (`asks` without a
   detail). Click it, and in the session answer the permission prompt **No** (or the question).

Write down: the two lines and the notification's text, exactly; whether the detail tells a
permission prompt from a question; whether a detail held a command (`touch skydeck-check.txt`) or a
path — what a notification shows to anyone who can see your screen.

## W21. A finished turn, and seen (real claude)

1. **Finished, not seen.** Select the throwaway session (the key bar says `Focus: terminal`), type
   the story prompt, press Enter, and at once click the other session's row. Stay in the skydeck
   window. Expected: once the story is written, the throwaway session's row has a green bar at its
   left and a bold title, and its second line is `finished · not seen · <age>`, in green; the title
   bar's count went up by one (`1 needs you`, after a dot, when no other session needs you); no
   notification comes, since the window has the focus. Look at the taskbar button's title now (W3).
2. **Seen.** Look first: only when the title bar's count says `1 needs you` and the throwaway
   session's row is the one with the green bar, press Ctrl+Shift+J. Expected: the throwaway session
   is selected (look at the header's short id) and its terminal takes the keyboard; after 1.5
   seconds or a little more its mark goes, and the count with it. Look again before the next press:
   with no count left in the title bar, press Ctrl+Shift+J once more, and the key bar says `no
   session needs you`. When the count is higher, or another row has a bar, other sessions need you
   too, and Ctrl+Shift+J would go to them first (those that ask, then those that ended, then the
   older finished ones) and clear a real session's mark: click the throwaway session's row instead,
   and leave out both presses.
3. **A turn that ends in front of you.** With the throwaway session selected, the window in front
   and the key bar saying `Focus: terminal`, type the story prompt, press Enter, and keep it
   selected, the window in front, until the story is written. Expected: no mark, and the count does
   not change.
4. **An ask** is W19's step 1: `needs you · …` while the prompt is open, also on the selected
   session, gone once it is answered.
5. **Several tool calls.** Select the throwaway session (the key bar says `Focus: terminal`), type
   `list the files here, then count them` and press Enter; at once click the other session's row,
   then click into W, so that no skydeck window has the focus. Watch the throwaway session's row
   until the turn is over: its second line starts with `working` while Claude Code works. When
   Claude Code asks to run a command, the row says `needs you · …` (with notifications allowed, a
   notification `asks: …` comes too): click the row and read the command it proposes. Answer the
   plain `Yes` (not the one that stops asking) only when the command only lists or counts the files
   of the throwaway folder (`ls`, `find`, `wc` on `~/skydeck-try` or `.`); otherwise answer **No**,
   write the command down, and type the prompt again. After a `Yes`, click the other session's row
   and W again. Expected: `finished · not seen`, and its notification when they are allowed, only
   once Claude Code has written its answer, not between two of its steps. Then click the throwaway
   session's row and wait until its mark goes (1.5 seconds or a little more): the count goes down
   with it, and the taskbar button's title is `skydeck` again when no other session needs you.

Write down: what each step showed; in step 5, the commands Claude Code proposed, whether
`finished` or a `finished` notification came before the answer was written, and how many
notifications came. Yours to judge: the list and the title bar's counts call an idle session
`waiting` (stage A's word); whether they should say `idle`.

## The window (step 2, stage C)

The check of the design's section 18 (design-step-2.md) that stage C needs: W16, restore in the
window after WSL stopped ([install.md](install.md), "Restore after a restart (stage C)" and
"Starting sessions in the window from a terminal (stage C)"). Its main part ends every process in
WSL: read it to the end before you start, and run it at a moment you choose.

Setup:

- The setup of "The window (step 2, stage A)" above, with its terminals **W** and **P**. W16 makes
  three throwaway sessions of its own; every prompt goes to one of them, never to a session of
  your real work. No step changes `config.json`, Edge's or Windows' settings, and no step uses a
  list key.
- **A prompt is typed only into a terminal that has the keyboard**: the key bar says `Focus:
  terminal` (else Ctrl+Shift+L until it does), and the header names the throwaway session the
  step names — its directory, the folder you gave it, at the start of the header's second line,
  and once you have written it down its short id (on that line, after the directory, the times and
  where the title comes from). Type nothing otherwise: text typed while the list has the keyboard
  is list keys — `k` moves to the row above, which may be a real session, `n` opens its note, `l`
  its label, `d` marks it done (on a session running in the window it opens the dialog `Mark done`, where a following Enter or Space marks it done and keeps it running; nothing is ended).
- **The story prompt** is `write a story of about 1,500 words about a lighthouse; reply in this
  chat, with no tool and no file`: Claude Code writes for a while, and its row says `working`
  meanwhile. When it asks for anything all the same (to run a command, to write a file), answer
  **No** and send the prompt again; while it asks, its row says `waiting`, not `working`.

## W16. WSL stops with the window open

**What `wsl --shutdown` ends.** Every process of every WSL distribution, at once:

- every `claude`: in the window, in every WSL terminal and in VS Code's WSL window. A turn in
  progress is cut off;
- the shells and the editors that run in WSL: text you have not saved is lost;
- builds and tests that run in WSL;
- the containers of Docker Desktop when Docker uses its WSL engine;
- SSH tunnels and port forwards;
- VS Code's WSL window (it connects again by itself) and every WSL terminal.

Windows programs should stay, the skydeck window among them (it is an Edge window): that is what
the design expects (design-step-2.md, section 6), not yet seen on a Windows PC — W16 writes down what
happens. A restart of the PC ends all of this and everything else.

**Prepare**, before anything else. `wsl --shutdown` ends EVERY program in WSL, not only Claude
Code sessions: builds, servers, agents that work for you, `tmux` and `screen` with all they run.
The two looks of "Set up", step 4, are cross-checks, no guarantee that nothing of yours runs. So
run the main part and the second part only at a moment when you would restart WSL anyway;
otherwise leave them out and write down that you left them out (the third part needs no restart).

1. Choose a moment when ten minutes without WSL cost you nothing.
2. Save in every editor that runs in WSL. Stop the builds, the containers and the tunnels you would
   miss.
3. End every real `claude` session yourself, with `/exit` once its turn is over, in the window and
   in every terminal. A session ended so is not offered by the banner below, and you resume it
   afterwards as always.
4. End or let finish the runs of Claude Code that `skydeck ls` does not list: `claude -p` and
   scripts that use the Agent SDK, probably Claude Code in VS Code's panel, and anything that runs
   in a detached `tmux` or `screen`.

**Set up:**

1. In W:

   ```sh
   mkdir -p ~/skydeck-try
   mkdir ~/skydeck-try/w16-a ~/skydeck-try/w16-b ~/skydeck-try/w16-c
   ```

   When `mkdir` says `File exists` for one of them: if you made it in an earlier W16 that you did
   not finish, use it as it is; otherwise it is not W16's — stop here, change nothing in it, and
   remove only the folders this run made (`rmdir`, as in "Clean up", step 3).
2. Three throwaway sessions in the window, one in each folder. For each: press Ctrl+Shift+N (in a
   browser tab, the `+ New` button). The right side shows the form for a new session, its first
   field the directory, with the cursor blinking in it; when the form does not show, or the cursor
   is not in that field, type nothing: press Ctrl+Shift+N again, or click into the field. The
   field holds a directory of yours: press Ctrl+A in it to select all of its text, and type the
   folder's full path over it (`/home/<you>/skydeck-try/w16-a`, then
   `w16-b`, then `w16-c`). Leave the other fields empty. Press Enter only when the field holds
   exactly that path: a session started in one of your projects would be offered by the banner
   below like the three. Wait until Claude Code shows its prompt in the new terminal; then, as the
   setup says, send it `say hello in one word`.
3. Write down the three short ids, each with its folder: a session's header shows its directory
   and its short id (on its second line, the short id after the directory, the times and where the
   title comes from). In W, `skydeck show <short id>` for each says the same: its `dir:` line is
   the folder.
4. In W: `skydeck ls --all` (`--all`: also the sessions marked done). Nothing may be `working`,
   `waiting` or `running` but the three throwaway sessions. `skydeck ls` lists only the sessions you
   work in: not `claude -p` or Agent SDK runs, and probably not Claude Code in VS Code's panel. So
   then `pgrep -af claude` (it only lists processes; it also prints every other program whose
   command line holds the word, such as a path with `claude` in it: pass over those). Every line
   whose program is `claude` must be one of the three: `claude --session-id <id>`, or `claude
   --resume <id>` once they have been restored, with an id that starts with one of the three short
   ids you wrote down. Another `claude` (one with another id, or with `-p`) is a run of yours. If
   anything else runs, end it as in "Prepare", steps 3 and 4, or stop here and do "Clean up" for
   what you made.

**Steps:**

1. In the window, the three are under Open, each with its slot number. Click the row of the
   session of `w16-c` (the header names its folder) and send it the story prompt, as the setup
   says. Its row says `working`.
2. While it does, in P: `wsl --shutdown`. (When its row says `waiting`, or the story is done
   before you are there, send the prompt again first.) Expected: within a few seconds the window
   shows the bar `skydeck's server is not answering (since <time>). …`. Write down how long it
   took.
3. Open a WSL terminal again (W). In it: `skydeck window`. Expected: `skydeck: waiting up to 7 s
   for the open window to come back; --new-window opens one now`, then `skydeck window: a window is
   already open`, and no second window opens. When one opens, write it down and close it: the old
   one is the window that showed the bar.
4. Expected in the window: the bar goes; the line `WSL has restarted since <time>: the sessions
   that were running have ended.`; and at the top of the list the banner `Before the restart (last
   activity today at <time>) 3 sessions were open`, with `Restore 3` and `Not now`. **Before you
   click anything, read the banner's entries**: each starts with a short id (`<short id>  <title> ·
   no exit recorded`, the one of `w16-c` with `· was working` after it). The three short ids you
   wrote down must be there, ticked. An entry whose short id is not one of the three is a session
   of yours: untick it (a click on its checkbox) until only the three are ticked and the button
   says `Restore 3`; when you are not sure, click `Not now`, stop here and do "Clean up"
   (`skydeck restore` still offers your sessions). Write down the banner's words.
5. Click `Restore 3`. Expected: the banner says `A restore is running.`; the three are under Open
   as `starting…`, then running, in slots 1–3; the report under the banner says `started <short
   id> <title>` for each and last `restore finished: 3 started`; then the banner goes (nothing is
   left to offer; with a session of yours unticked it stays, offering that one) and the report has
   a ×. Nothing was selected by the restore. Click each of the three rows and type nothing: its
   terminal shows its conversation.

Write down: how long the bar took to show; whether `skydeck window` printed the waiting line, and
whether a second window opened; the banner's words, its heading and each entry; the time from the
click on `Restore 3` to the last `started` line; whether the skydeck window stayed open through
the shutdown; anything that differed from the expected.

**Second part, optional: a minimised window, and `Not now`.** It is one more `wsl --shutdown`:
prepare as above ("Prepare", and step 4 of "Set up"; the three throwaway sessions run again after
the first part).

1. Minimise the skydeck window and leave it so for more than 5 minutes.
2. Right before it, in W: step 4 of "Set up" again (`skydeck ls --all`, `pgrep -af claude`); a
   session resumed meanwhile is ended first. Then in P: `wsl --shutdown`. Open a WSL terminal again
   (W) and, with the window still minimised, run `skydeck window`. Expected: the waiting line; after
   it a new window may open, because Edge wakes a window minimised that long only once a minute, and
   then the old one comes back later, at its next wake (a known limit of stage C). Write down
   whether a second window opened and how long the old one took to come back; close the new one.
3. In the window, read the banner's entries as in step 4 of the first part, then click `Not now`.
   Expected: the banner goes.
4. In W: `skydeck window --restart`. Expected: the window connects again, and the banner does not
   come back.
5. In W: `skydeck restore --dry-run`. Expected: it lists the three, preselected (`[x]`), and starts
   nothing. Leave them not running.

**Third part, optional, with no restart: a window that a command opens.**

1. When the session of `w16-a` runs (it does after the first part, not after the second): click
   its row and, as the setup says, type `/exit` and press Enter.
2. Close every skydeck window (its ×), also those opened with `--new-window`, and every browser tab
   of a `--print-url` address. The server keeps running: in W, `skydeck doctor` says `the window's
   server runs: …, 0 pages, …`.
3. In W: `skydeck resume <the short id of w16-a> --window`, then `echo $?`. Expected: `0`, and a
   skydeck window opens by itself, with the session under Open (`starting…`, then running); the
   window has no session selected.

**Fourth part, optional, at your next ordinary PC restart** (nothing to prepare beyond your own
habits): leave the skydeck window open when you restart the PC. Afterwards, in W, `skydeck window`.
Does it say `skydeck: waiting up to 7 s for the open window to come back; …` before it opens the
window? Write it down; when it does after every restart, say so: there is a follow-up for it. The
banner then offers what was open before the restart, your own sessions: read its entries first
(`Restore` starts every ticked session in the window, each with the flags it was started with),
and restore them or not, as you like.

**Clean up**, after the parts you ran:

1. End each throwaway session that runs: click its row and, as the setup says, type `/exit` and
   press Enter; then `Close` on its ended bar.
2. In W, with the short ids you wrote down: `skydeck show <short id>` (its `dir:` line must be one
   of the three folders), then `skydeck done <short id>` for each of the three (it prints `<short
   id> done`), so that they leave the list and no later restore offers them. A wrong id is taken
   back with `skydeck undone <short id>`.
3. In W: `rmdir ~/skydeck-try/w16-a ~/skydeck-try/w16-b ~/skydeck-try/w16-c`. `rmdir` removes only
   an empty folder: when it says `Directory not empty` for one, leave that folder as it is and
   write down what is in it (`ls -A <folder>`).
4. Start again what you stopped in "Prepare". Your own sessions are listed by `skydeck` and in the
   window, and resume as always.

## The window (step 2, stage E)

The checks of the design's section 18 (design-step-2.md) that stage E needs: W30 and W31, search,
the chips, blocks and the quick switcher ([install.md](install.md), "Search, the chips and blocks
(stage E)" and "The quick switcher (stage E)"), and the icon's part of W3. Each check says what to
set up, what to type, what to look at and what to write down.

Setup:

- The setup of "The window (step 2, stage A)" above, with its **throwaway session in the
  window**. These checks look at your real sessions and change none of them: only the throwaway
  session is ever resumed, or typed into.
- **Its short id.** Click the throwaway session's row once, then look at the header's second
  line: it must start with the throwaway folder, `/home/<you>/skydeck-try`. When it shows another
  folder, you clicked another session: find the throwaway session's row first (under Open by its
  slot number; or in W, where `skydeck show <short id>` prints the folder on its `dir:` line for
  a short id of `skydeck ls`'s last column), click it once and look again; never click a row
  marked as needing you (a coloured bar at its left) to look. Then write down the
  short id the header shows (on that second line, after the directory, the times and where the
  title comes from). Each check starts with the throwaway session selected, so that a key that
  lands where you did not mean it to reaches only the throwaway session.
- **Where the keyboard is, before you type.** Text belongs in a field only while that field has
  the keyboard: the filter's field when its border has the selection's colour and its caret
  blinks in it (click into it first), the switcher's field while the switcher's panel is shown
  over the window. Type nothing otherwise: text typed while the list has the keyboard is list
  keys — `k` moves to the row above, which may be a real session, `n` opens its note, `l` its
  label, `d` marks it done (on a session running in the window it opens the dialog `Mark done`, where a following Enter or Space marks it done and keeps it running; nothing is ended) —, and text typed while a terminal has it reaches that session's
  program. When the field shows no caret, click into it first. In the filter's field press no
  Enter: Enter gives the keyboard to the list, where the next letter is a list key. No step
  presses Enter in the switcher on a session whose short id you have not looked at.
- **One click on a row, on its title.** A double click on a session that is not running resumes
  it. These checks click only one session of a block none of whose sessions has a coloured bar at
  its left (a session that needs you and stays selected for 1.5 seconds is marked seen), a block's
  caption line, and the throwaway session's row. A session's resume card shows `Resume here`: never
  click it in these checks.
- **Leave the window as you found it.** Write down at the start what the filter holds, which chips
  are on, whether the switch `Show done` is on (a ✓ in its box), which blocks are closed (a card drawn as its caption alone: `▸`,
  the group's name and a number, no session under it), whether Earlier is unfolded, and your
  keyboard layout. Each check starts from an empty filter (Esc in its field), no chip on (a click
  on each chip that is on) and `Show done` off (a click on it when its box has a ✓). At the end put back what you wrote down: the filter's text typed again
  into its field (look for the caret first), each chip that was on clicked on again, `Show done` as
  it was, each block you
  closed opened again (a click on its caption), Earlier folded or unfolded as it was, and your own
  layout (Win+Space). Fold Earlier only while the selected session is not in Earlier (a fold with
  the selection inside it selects the line above it, which may be a real session); when the
  throwaway session's row is in Earlier, leave Earlier unfolded and write that down.

## W30. Search on your own sessions (real claude)

Setup: the throwaway session selected (look at the short id in its header), the filter empty, no
chip on and `Show done` off (a click on it when its box has a ✓). Write down how many sessions the title bar counts.

1. **Two words.** Take one of your ticket keys and a word of that session's title (`ORB-2107` and
   `login` below). Click into the filter's field: its caret blinks. Type `orb-2107 login`, in lower
   case. Expected: the list follows each keystroke; at the end it lists only the sessions that
   have both words (in their title, group, note, directory or a pull request), done ones too with
   their `done` mark; every section is unfolded, no card is drawn (every session is a flat row with its group), and the footer of done
   sessions is gone. The title bar's counts did not change. Then Ctrl+A (in the field: it selects
   the field's text) and type `login orb-2107`: the same sessions. Press Esc: the field is empty,
   the list as before, and the key bar says `Focus: list`.
2. **A short id.** Click into the field again (look for the caret) and type the first 6 characters
   of the throwaway session's short id. Expected: the throwaway session is listed (and any session
   whose title, group, note, directory or pull request holds those characters, which is rare).
   Backspace twice (4 characters left): still listed. Backspace once more (3 characters): the id
   no longer counts, only the fields do; mostly `No session matches the filter.` Press Esc.
3. **The chips.** Look at the key bar's `Focus: …` and keep it in mind. Under the field are four
   chips, `Running`, `Open PR`, `Has note` and `Done`, and at the right end of their row the switch
   `Show done`, a small box with its label. With `Show done` off, click `Running`. Expected: the
   chip is drawn pressed, only the sessions under Open are listed, and `Focus: …` did not change.
   Click it again: it is off, the list as before. The same with `Open PR` (only the sessions with a
   pull request that is not merged or closed) and `Has note` (only those with a note, and no done
   one among them but one that still runs: when done sessions have a note, the footer says `<n>
   done hidden · show`; when every session with a note is done, the list says `Only done sessions
   match the filter.` above it). While a chip is on, Earlier stays folded or unfolded as it was,
   and an open card stays a card while the chip leaves at least two of its sessions (its number
   counts them); one left is a plain row. Then `Running` and `Has note` together: only
   the running sessions that have a note (`No session matches the filter.` when none has one);
   click both off. Then `Done`: only the done sessions, each with its `done` mark, in their sections
   and cards, no footer; `Show done` is drawn dimmed, and hovering it shows `the Done filter lists
   done sessions by itself`. Click `Done` off. Then `Show done`: a ✓ in its box, the done sessions
   show with their `done` mark and the footer says `done sessions shown · hide`; click it again, and
   the footer is `<n> done hidden · show` again (or gone when none is done).
4. **A block's card.** Blocks are open by default and drawn as cards: a box with a thin edge; at its
   top a caption line with the arrow `▾`, the group's name and the number of its sessions; the
   block's sessions inside it as ordinary rows, none indented and none marked `×<n>`. This step
   closes one card and opens it again, with the mouse and with ← and →. It types nothing into any
   session or field, presses no Enter and no letter key, and no ↑ or ↓ (they move the selection to
   the next line, which may be a session that needs you).

   *Choose the card.* Look in Recent, and in Earlier, for an open card. When Earlier is folded (none
   of its rows shows), a click on its header unfolds it; when its rows show, do not click its header
   (that click folds it). Take an open card, in Recent or in Earlier, none of whose sessions has a
   coloured bar at its left (a session that needs you) and none of which is the throwaway session.
   Write down its group's name and the number of its sessions. Skip a closed block (a caption with
   `▸` and no session under it): do not click it, and press no key while its caption is selected.
   When there is no such open card, write that down and go on with step 5.

   *With the mouse, the throwaway session still selected.* Look at the key bar's `Focus: …` and keep
   it in mind. Click the card's caption once, anywhere on its line. Expected: the card closes to its
   caption alone (`▸`, the name, the number, no session under it); the header still shows the
   throwaway session's short id, and `Focus: …` is what you noted. Wait a moment (two quick clicks
   are a double click, which acts once) and click the caption again. Expected: the card opens, its
   sessions inside as before, and again neither the selection nor the keyboard moved. The card is
   open, as you found it. When a line that begins `this block holds` shows instead, write it down
   (the card stays open) and take another card.

   *Select a session of the card.* Click one session of the card once, on its title. Expected: it is
   selected. Look at the key bar: it must say `Focus: list`. When it says `Focus: terminal` (that
   session has a terminal in the window), press Ctrl+Shift+L once and look again; until it says
   `Focus: list` press nothing else, and when it does not, go on with "Put it back" below. That is a
   real session: from here to the end of this step press only ← and →, never Enter (it would resume
   it) and no letter key. Click the card's caption once. Expected: the card stays open, the same
   session stays selected, and the key bar says `this block holds the selected session; it stays
   open` (it shows for about five seconds).

   *← closes the card and selects its caption.* Press ← only while you see all of this: the selected
   line is a session of that card (the card is open, its caption above it, its sessions under it),
   the card is in Recent or in Earlier, and the key bar says `Focus: list`. Never press ← with a
   caption selected: it folds Earlier, and inside Earlier it selects the line above it, which may be
   a real session. When anything differs, press nothing more and write down what you see. When ←
   does nothing and the key bar says why — a line that begins `this block holds` —, write that line
   down: it shows for about five seconds, and pressing ← once more, after the same look, shows it
   again (the card stays open). Then press nothing more in this step (no →: on a session of the open
   card it would unfold Earlier), and take another card from its first click on, or go on with step
   5. Press ← once. Expected: the card closes to its caption alone; its caption is drawn as the
   selected line and no session is selected; the right side shows a small card of the group — its
   name, `<n> sessions` and `→ or Enter opens the group` — and no terminal; the key bar still says
   `Focus: list`.

   *→ opens it again.* Press → only while you see that the selected line is that caption (the
   group's name you wrote down, with `▸`), that the caption shows the number of sessions you wrote
   down and no `· … needs you`, and that the right side shows the group's card. When the number
   differs or `· … needs you` shows (a session of the group joined the block meanwhile, or came to
   need you: → would select it unseen), do not press →: click the throwaway session's row once
   (look at the short id), then the caption once — it opens without selecting a session — and go on
   with "Put it back". → selects a real session, the first session of the card, which is not the
   throwaway session; nothing is typed into it, and no Enter is pressed. Press → once. Expected: the card opens, its sessions
   inside as before, the first of them selected, and the key bar says `Focus: list`. The right side
   shows that session (its resume card when it is not running: never click `Resume here`). Press
   nothing more on it.

   *Put it back.* The card is open, as you found it. When a card is still closed (a step above was
   left out), look first whether its caption is the selected line: then click the throwaway
   session's row once (look at the short id) before anything else, since a click on the selected
   closed caption selects its first session, as → does. Then click the closed caption once: it
   opens. Then click the throwaway session's row once (look at
   the short id): the next steps start from it. When you unfolded Earlier in this step and the
   throwaway session's row is not in Earlier, fold Earlier again now, with a click on its header.
   When its row is in Earlier, leave Earlier unfolded until the end of step 6 (folding Earlier with
   the selection inside it selects the line above it, which may be a real session).
5. **The switcher, without Enter.** Look at the key bar's `Focus: …` and keep it in mind. Press
   Ctrl+Shift+P. Expected: a panel over the window with a field on top whose caret blinks,
   `Switch to a session…  (title, group, note, PR, directory, short id)` while it is empty;
   under it your sessions under the headings `Needs you`, `Open`, `Not running` and `Done` (a
   heading shows only when it has a session), each with its short id at the right; at the bottom
   a footer that starts `↑ ↓ move · Enter`. When no such panel shows, type nothing and write that
   down. Type the ticket key of step 1 (`orb-2107`).
   Expected: the list narrows at each keystroke, and in the titles that hold the key its letters
   are marked (a session that has it only as its group shows no mark).
   Press ↓ a few times, then ↑: the highlight moves, and the footer's `Enter switch` or `Enter
   resume here` follows the highlighted session. **Press no Enter**: it would switch to that
   session, or resume it. Press Esc. Expected: the panel goes, and the key bar shows the `Focus: …`
   it showed before.
6. **The throwaway session, with Enter.** Press Ctrl+Shift+P again (the panel shows, its caret
   blinks; else type nothing) and type the first 6 characters of the throwaway session's short id.
   Wait until the sessions stop changing (a second). Look at the highlighted session: its short id,
   at the right, must be the one you wrote down, whole. When it is another one, press ↓ until the
   highlighted session's short id is the throwaway session's; when no session shows it, press Esc
   and leave this step out. Read the footer: `Enter resume here` (the throwaway session has no
   terminal in the window) or `Enter switch` (its terminal is in the window). Right before Enter,
   after your last ↓, look at the highlighted session's short id once more: a late answer to your
   last keystroke moves the highlight back to the first session. When it is still the throwaway
   session's, press Enter once; when it is not, press Esc and leave this step out. Expected: the
   panel goes and the throwaway session is selected; with `Enter resume here`, it is resumed into
   the window (its row under Open, `starting…`, then its terminal, which takes the keyboard: `Focus:
   terminal`); with `Enter switch`, its terminal shows and has the keyboard — or, when it runs in
   another terminal, its card shows and the list has the keyboard. Type nothing into it: it stays as
   it is, for the other checks. When step 4 left Earlier unfolded: with the throwaway session's row
   now under Open, fold Earlier with a click on its header; with its row still in Earlier, leave
   Earlier unfolded and write that down.
7. **The section headers.** Press no key and click nothing in this step. Expected: each section,
   Open, Recent and Earlier, starts with a band across the whole width of the list, a step darker
   than the list, a thin line above and below it; in it a short bar before the section's name
   (blue for Open, grey for Recent, fainter for Earlier, whose `▸` or `▾` stands before the bar
   with room between them), the name in capitals, the number of its sessions after it, dim, and
   while Earlier is folded its span of days at the right end. Scroll the list with the mouse wheel
   over it (scrolling selects nothing): the band of the section you scroll through stays at the
   top of the list, and no row or card shows through it; when the whole list fits and nothing
   scrolls, write that down. Write down whether the three sections are easy to find and to tell
   apart.

Write down: whether any answer of the list came late enough to notice (the filter as you typed,
the chips, the card, the switcher); whether the switcher's order — those that need you, then
Open, then the ones not running, then the done ones — is the one you want; what Enter did in
step 6; what the right side showed while the caption was selected; every step that showed
something else than described.

## W31. The filter's and the switcher's fields on your layouts

Run it once on the US layout and once on the Czech one (Win+Space switches, W8). Setup: the
throwaway session selected (look at the short id), the filter empty.

1. Click into the filter's field: its caret blinks. Type `\ [ ] { } @ # ~ |`, each with the keys
   your layout has for it (on the Czech layout with AltGr), and on the Czech layout also the dead
   keys: háček, then `e` (`ě`), čárka, then `e` (`é`). Expected: each character shows in the field
   as typed, and nothing else happens: no dialog, no other session selected, the key bar shows
   no new message. Press Esc: the field is empty.
2. Press Ctrl+Shift+P. Expected: the switcher's panel, its caret blinking in its field. When no
   panel shows, type nothing: write that down and leave this step out. Type the same characters
   and, on the Czech layout, the same dead keys; press no Enter. Expected: each character shows in
   the switcher's field as typed, and nothing else happens (most likely the panel says `No session
   matches.`). Press Ctrl+Shift+P: the panel goes. Press Ctrl+Shift+P again: it shows, with an
   empty field; press Esc: it goes.
3. Switch back to the layout you work with (Win+Space).

Write down, per layout and per field: every character that did not show as typed, or that did
something else; whether Ctrl+Shift+P opened and closed the switcher.

## W3, the icon

Setup: the window open after the update to stage E (`git pull` and `skydeck window`, install.md,
"Updating"; the page reloads itself for the new build), the throwaway session selected (look at
the short id).

1. Look at the window's taskbar button and at the left end of the window's own title bar (Edge's,
   above the page): skydeck's icon, not Edge's. Expected at both: a blue-to-violet cloud drawn as
   a line, a terminal box in front of it and a white `>_` in the box, and nothing behind the
   drawing (no square or tile: around it the icon is transparent, so the taskbar's own colour
   shows). The page's `favicon.ico` holds an image drawn for every size the taskbar and the title
   bar show at a scaling of 100 % to 250 % in steps of 25 % (16, 20, 24, 28, 30, 32, 36, 40, 42, 48,
   54, 60 and 64 pixels), the lines bolder at 16 and 20: at those scalings neither place should need
   one resized. At another scaling (above 250 %, or one between those steps) the size is not in the
   file: there a neighbour is resized, and a soft icon is expected; write it down as such. Expected,
   by place:
   - the **taskbar button**, the one that matters most: **the icon is sharp in the taskbar at this
     display's scaling**: the cloud's line, the box and the `>_` have crisp edges, not the soft
     look of an icon stretched from a smaller one, and the drawing is about as large as the icons
     of the buttons beside it. Look up the scaling (Windows' Settings, System, Display, "Scale")
     and write it down with what you see. Which of the page's images Edge hands to the taskbar is
     not known (the taskbar shows 24 pixels times the scaling: 24 at 100 %, 30 at 125 %, 36 at
     150 %, 42 at 175 %, 48 at 200 %): when the icon is soft at your scaling, write down how
     (blurred, or sharp but small, or large and soft);
   - the **title bar**, which matters less: the same drawing, smaller (16 pixels times the scaling:
     16 at 100 %, 20 at 125 %, 24 at 150 %), its lines bolder at the two smallest sizes; the `>_`
     may only just read.

   The taskbar's look was NOT tried in Edge when the files were made, and nobody has looked at
   them on a Windows taskbar or title bar: they were judged from enlarged sheets of them on a dark
   and a light background, and this check is the first time they are seen on the taskbar. The icon
   before 2026-11-23 was another picture on a dark navy rounded square (from F10; before F10 three
   cards on a blue rounded square). When the button or the title bar still shows an earlier icon
   after the page reloaded itself, write it down and treat it as step 3 treats Edge's own icon: look
   again the next time the window is opened anew (do not close it for this check).
2. In W: `skydeck window --restart`. Expected: the same window stays and says `skydeck's server
   restarted; your sessions kept running`. Look at the button again.
3. When the button showed Edge's icon in step 1 or 2, write that down, and look at it again the
   next time the window is opened anew: after you closed it for a reason of your own, or after a
   restart of the PC (do not close it for this check).
4. After a WSL restart: look at the button again only after one that comes anyway — W16's main
   part, W14's third part, or one of your own. Never restart WSL for this check: what a restart
   ends is in W16, "What `wsl --shutdown` ends", and W16's "Prepare" says when one may be done.
   When none came, write down "left out".
5. Edge's menu of the window: when Edge's title bar above the page has a `…` button, click it and
   read the entries without choosing any: does one offer to install the page, or the site, as an
   app? **Do not install it.** Close the menu with Esc. When there is no such button, write that
   down.

Write down: the icon the button and the title bar showed, after the update, after the restart (and
when the window was opened anew, after a WSL restart, or "left out"); what the button showed (the
cloud with the box on the taskbar's own colour, or still an earlier icon on its navy square);
the display's scaling, and whether the icon is sharp in the taskbar at it or soft; whether it is
as large as the buttons beside it; whether Edge's menu offered to install the page as an app, in
its own words.

## Updating skydeck

The check of `skydeck update` (follow-up F8; [install.md](install.md), "Updating"): W32, on your
own installation, with your window open. It types into no session, presses no key in the window
and opens no dialog: everything is typed in a WSL terminal of your own (a Windows Terminal tab with
WSL, say), never as a `!` command inside Claude Code and never in a terminal of the window. Your
sessions are not touched: the update stops only the window's server, and the keepers keep them
running.

## W32. `skydeck update` on your installation

Setup: the window open, as you work with it; do not close it for this check. In the window, write
down how many sessions the title bar counts, and which slots the Open section shows. In your own
WSL terminal: `skydeck doctor`, and write down its `problem` lines (if any: they are not this
check's); then `cd ~/skydeck`, then `git status --short`, and write down what it prints. Lines that
start with `??` are files git does not track: they do not matter. When it prints any other line,
stop here and write that down: the update would refuse (a change of your own to a tracked file),
and this check changes nothing of yours.

1. **Look first.** Type `skydeck update --check`. Expected: one of
   - `skydeck is up to date (main at <id>, as origin/main)` — write it down and leave step 2 out;
   - `<n> new commits on origin/main (<old>..<new>):`, one line per commit (two spaces, a 7-digit
     id, two spaces, its subject; at most 20, then `… and <m> more`), perhaps the line `this update
     changes the database's upgrade steps: …`, and last `run skydeck update to apply it`.

   Then look at the window: nothing changed — no bar saying that the server is not answering, the
   same count of sessions, the same slots under Open. `git status --short` prints what it printed
   in the setup (`--check` changes only `origin/main`, which `git status --short` does not list).
   Any other line (a refusal: `skydeck: …`) — write it down and stop: install.md's table, under
   "Updating", says what it means.
2. **The update**, only when step 1 listed commits. Type `skydeck update`, then press no key in the
   window until it has reloaded. Expected in the terminal, in this order: the list of step 1; the
   line `skydeck: stopped skydeck's window server; <n> terminals in the window keep running`; then
   `skydeck: waiting up to 7 s for the open window to come back; --new-window opens one now` (it
   may be missing when the window was back sooner); `skydeck window: a window is already open`;
   and last `updated to <new>`, the id of step 1's first line. `echo $?` prints `0`. In the window,
   meanwhile: for a few seconds `skydeck's server is not answering (since <time>)…`, then the page
   reloads itself and the list and the terminal come back. (A window whose key could not be stored
   says `this window's page is not the one skydeck's server serves, and its key could not be
   stored, so it cannot reload itself; run skydeck window again` and cannot come back: then the
   terminal shows `skydeck window: http://127.0.0.1:…` in place of `a window is already open`, and
   a new window opens after the 7 seconds. Write that down and close the old window with its ×.)
   Then:
   - every session is there: the title bar counts what you wrote down, and the Open section shows
     the same slots;
   - one window only: no second skydeck window opened (the taskbar shows one skydeck button, as
     before);
   - `skydeck doctor` prints no `problem` line but those you wrote down in the setup.

   Press no Ctrl+C during step 2: once `stopped skydeck's window server` is printed the command
   finishes what it began (install.md, "Updating"), and this check is about an update that runs
   through.

Write down: what step 1 printed (the count, whether the database line came); for step 2, every line
the terminal printed, whether the window said that the server was not answering and how long it
took to come back, the count and the slots after it, whether a second window opened, and
`skydeck doctor`'s `problem` lines that were not there in the setup (none expected). When a second window opened, close it with its
×: closing a window ends no session.

## Claude Code's ← shortcut

The check of install's question about Claude Code's ← shortcut (follow-up F11;
[install.md](install.md), Install, step 3): W33, on your own installation, with your window open.
**It changes one setting of yours on purpose**: `leftArrowOpensAgents` in `~/.claude.json`, which
it turns off; nothing else of yours. Its end says how to put it back.
Steps 1 and 2 are typed in W, a WSL terminal of your own (never a `!` command inside Claude Code:
there install has nobody to ask and takes it as a no); step 3 is in the window, in a new throwaway
session that gets no prompt at all. Never print `~/.claude.json` itself (no `cat`, no editor): it
holds your account details and the MCP servers' settings.

## W33. Turning off Claude Code's ← shortcut (real claude)

Setup: skydeck updated to a commit that has follow-up F11 (`skydeck update`, W32). In W, type
`skydeck doctor` and find its line about the shortcut; write it down.

- `info     Claude Code's ← shortcut is on: …`: go on with step 1.
- `ok       Claude Code's ← shortcut is off (/home/<you>/.claude.json)`: the question will not
  come; leave out steps 1 and 2 and go on at step 3 (it then checks the shortcut as it is).
- `info     Claude Code's ← shortcut: cannot tell from <file> (<reason>); …`: write down the file
  and the reason, and stop: install would leave the file alone (install.md, step 3, says what the
  reason means), and `/config` in Claude Code, the option "← opens agents", turns the shortcut off
  instead.

Then type `ls -la ~ | grep -F claude.json` and write down what it lists: names, modes and sizes
only (it also lists a `..claude.json.<12 hex digits>.tmp`, with two dots, that an interrupted
install would leave).

1. **The question.** In W, type `skydeck install`. Expected, after its usual sections (Hooks with
   `hook entries already present in …`, perhaps Window with the python3 line): the section and
   the question

   ```
   Claude Code's ← shortcut
     It is on: ← on an empty prompt sends the session to the background and opens
     agent view. ← also closes a group in skydeck's list, so a ← meant for the list
     can send a window terminal's session away. Turning it off sets only
     leftArrowOpensAgents in /home/<you>/.claude.json, after a backup;
     agent view itself stays (claude agents, /bg).

   > Turn the shortcut off? [y/N]
   ```

   Read them. When the fourth line names a file other than your `~/.claude.json`, type `n`, write
   the path down and stop. Else type `y` and Enter. Expected:

   ```
     turned off  the ← shortcut in /home/<you>/.claude.json
     backup      /home/<you>/.claude.json.skydeck-backup-<YYYYMMDDTHHMMSSZ>
     note        only for sessions started from now on; a session already running keeps it until it is started again

   Changed
     ← shortcut  /home/<you>/.claude.json
     backup      /home/<you>/.claude.json.skydeck-backup-<YYYYMMDDTHHMMSSZ>

   skydeck is installed
   ```

   then Next with what to do next, and `echo $?` prints `0`. Any other line about the shortcut
   (`… kept changing while skydeck wrote it …`, `could not turn Claude Code's ← shortcut off: …`,
   `… left … alone (…)`): write it down. The file is then as it was; leave out the rest of the check, and turn the shortcut off
   with `/config` in Claude Code ("← opens agents") if you want it off.
2. **What changed.** In W, `ls -la ~ | grep -F claude.json`. Expected: no
   `..claude.json.<12 hex digits>.tmp` that was not there in the setup; `.claude.json` with mode
   `-rw-------`, about 30 bytes larger than in the setup (1 byte when the key was there as `true`;
   a session of yours may also have saved the file in between, so a size that differs more is not
   a failure on its own); and a new `.claude.json.skydeck-backup-<YYYYMMDDTHHMMSSZ>`, mode
   `-rw-------`, with the size the file had in the setup. Then `skydeck doctor`: its line is now
   `ok       Claude Code's ← shortcut is off (/home/<you>/.claude.json)`.
3. **A new session in the window.** A session that already runs keeps the shortcut (Claude Code
   reads the file when a session starts), so this step needs one started after step 1. In the
   window press Ctrl+Shift+N. The right side shows the form for a new session, its first field the
   directory, with the cursor in it; when the form does not show, or the cursor is not in that
   field, type nothing: press Ctrl+Shift+N again, or click into the field. Press Ctrl+A in the
   field, type the throwaway folder's full path over its text (`/home/<you>/skydeck-try`), leave
   the other fields empty, and press Enter only when the field holds exactly that path. **Type no
   prompt into the new session.**
   Look that it is the new one: the header shows its short id and "opened" a moment ago, and its
   terminal shows Claude Code's empty prompt. Look that its terminal has the keyboard: the key bar
   says `Focus: terminal` (else Ctrl+Shift+L until it does). Do not press ← while the key bar says
   `Focus: list`: there ← acts on the list (it closes a group). Then press ← once, and look.
   Expected: the terminal stays as it is, the same empty prompt; no list of sessions (Claude Code's
   agent view, a table of sessions with an input at the bottom) takes it over, and the list on the
   left gets no new row "running in Claude Code's background" (nor one "running in another
   terminal") — also with done sessions shown: a copy Claude Code made that has no message yet is
   listed only then (follow-up F33), so press Ctrl+Shift+L until `Focus: list`, `a`, look, `a`
   again, and Ctrl+Shift+L until `Focus: terminal`. Only when the terminal is unchanged, press
   ← a second time (Claude Code asks for a second press in some cases, `Press ← again to open
   agents`), and look again: the same is expected.

   When agent view does take the terminal over (this branch is written from Claude Code's
   documentation, code.claude.com/docs/en/agent-view, and was not tried): press no more ←, type
   nothing into agent view's input (every prompt entered there starts a new session of its own),
   and press Esc, which goes back to the conversation. That does not end it: "Detaching never stops
   a background session", and the row is made "even when the conversation has no messages yet", so
   until it is ended the window may list a row for `skydeck-try` as `running in Claude Code's
   background`, while it has no message only with done sessions shown (F33). To look, press
   Ctrl+Shift+L until the key bar says `Focus: list` (a key typed while it says `Focus: terminal`
   goes into Claude Code's prompt), then `a`. When that row shows, click it and look at its card:
   the title `Running in Claude Code's background`, `pid <n>` with no `/dev/pts/…` after it, and
   the words `Claude Code runs this session itself, without a terminal. skydeck cannot show it
   here. To see it or end it, run claude agents in a terminal. Once it has ended it can be resumed
   in the window.` When the row says `running in another terminal` instead, write that down: Claude
   Code did not mark it as a background session in the way skydeck reads. Then, the key bar still
   saying `Focus: list`, press `a` again, and click the row of the window's terminal, the one with
   its slot number (1–9) in front, so that the right side shows that terminal again.
   End it now: look that the terminal shows the throwaway session (the header's short id, and
   `skydeck-try` as its folder) and has the keyboard (`Focus: terminal`), then type `/stop` ("To end
   a session from inside it, run /stop"). When Esc did not go back (agent view's table is still in
   the terminal), type nothing there, not `/stop` either (a reply that is exactly `/stop` stops the
   session it goes to), and end it in W with `claude stop <id>`, then `claude rm <id>`, with the id
   of the row for `skydeck-try`; the same when typing `/stop` is not possible for another reason. Then in W type
   `skydeck doctor` and write down its line about the shortcut. `is on` means the key is `true` or
   gone again: a session that was running wrote its older copy of the file back (or the shortcut
   was turned on in `/config`); write down which sessions were running, and turn it off again once
   they have ended (`skydeck install` asks again). `is off` means this session did not follow the
   file: write down the header's "opened" time and the time of step 1.
4. **The end.** End the throwaway session: its terminal has the keyboard (`Focus: terminal`; look
   at the short id, since `/exit` ends the session it is typed into), type `/exit`, then `Close` on
   its ended bar. When step 3's branch was taken, the session is ended already: only `Close`, if
   the ended bar shows; and when the list still shows a row for `skydeck-try` as running in Claude
   Code's background or in another terminal (look with `a` too), write that down. The shortcut
   stays off, on purpose. Sessions you started before step 1 keep it until you start them again
   (`/exit`, then resume them).

To put the shortcut back on (not part of the check): in Claude Code, `/config`, the option "← opens
agents"; or set `leftArrowOpensAgents` to `true` in `~/.claude.json` (or remove the key) and start
your sessions again. Do not copy the backup over `~/.claude.json`: it would also undo whatever
Claude Code saved in the file since step 1. The backup holds your account details as the file does;
remove it (`rm ~/.claude.json.skydeck-backup-<YYYYMMDDTHHMMSSZ>`) once you no longer need it.
`skydeck uninstall` leaves both the key and the backup.

Write down: the doctor line of the setup; every line step 1 printed about the shortcut; the modes
and sizes of step 2 and its doctor line; for step 3, whether agent view took the terminal over at
the first or the second ←, and if it did, doctor's line then, which sessions were running and how
the throwaway session was ended (`/stop`, or `claude stop` and `claude rm`).

Not tried before this check was written: all of it. The tests run install and doctor on made-up
files in a sandbox and never start `claude`; what Claude Code does with ← once the key is `false`,
and whether a session that was running writes its older copy of the file back, are known from its
documentation only (design.md 14), or not at all.

## The window's theme

The check of the window's theme (follow-up F13, chosen in Settings from F39; design-step-2.md 12.1,
12.13, 7.2, 9.3): W34, in your own window. **Mode** is the first choice of Settings: click the gear
at the right end of the title bar, and its first group, Appearance, shows `Mode` with `Auto` (the
window follows Windows' light or dark mode, as before), `Light` or `Dark`. "Pick `Light`" below
means: open Settings with the gear, choose `Light` in Mode (it applies at once), press Esc (Settings
closes). **It changes one setting of the window on purpose**: Mode's choice, which the window keeps
in its own Edge profile (not in any file of yours); the setup writes down what it shows, and the end
puts it back. Steps 5 and 6 are optional: step 5 changes Windows' mode for the whole desktop, and
step 6 may change Claude Code's theme through its own `/theme`; each says how to put it back. No
step reads or writes a file of Claude Code's (`~/.claude.json` holds your account details): its
theme is looked at in `/theme`. Nothing here sends a prompt: the only text typed into a terminal is
`/theme` and `/exit`, and only into a new throwaway session.

## W34. Light, dark or the system's (real claude)

Setup: skydeck updated to a commit that has follow-up F39 (`skydeck update`, W32; before it, the
title bar's switch `◐` stood for Mode); the window open, as you work with it. Write down two things:

- what Mode shows: `Auto`, `Light` or `Dark` (open Settings with the gear, read it, press Esc);
- Windows' mode: Settings > Personalization > Colors, "Choose your mode" (Light, Dark or Custom;
  for Custom, "Choose your default app mode").

Then pick `Auto` (when it shows `Auto` already, nothing).

1. **Auto.** Expected: the window is light while Windows' app mode is Light and dark while it is
   Dark, as before F13: the list, the header, the key bar and the terminal of the selected session.
   Before each pick of this check, look at the key bar (`Focus: list` or `Focus: terminal`), and
   after its Esc look that it says the same: Settings gives the keyboard back where it was.
2. **Auto → Light.** Pick `Light`. Expected: at once, behind Settings, the whole window is light —
   the list, the header, the key bar, the scroll bars, and every terminal: a light background with
   dark text, the sixteen colours a program uses (`ls`'s, say) in their light variants. A program's
   own 24-bit colours stay as they are: a running Claude Code whose theme is not one of its ANSI
   themes keeps its own theme's colours on the light background, so some of its text may be hard to
   read until it is drawn in another theme (expected from what its themes are documented to be, not
   tried; write down what you see). Nothing else moves: the selection is the same row. Select
   another row that has a terminal (one click on its row, no key), and look that its terminal is
   light too; click back on the row you had.
3. **Light → Dark.** Pick `Dark`. Expected: the whole window dark, every terminal too, whatever
   Windows' mode is.
4. **It is kept.** With `Dark` picked, press Ctrl+Shift+R (the page's reload, in either zone).
   Expected: the page loads again dark from its first frame — no frame of the page in light while it
   loads — and Mode shows `Dark`. Then close the window with its × (closing the window ends
   no session) and, in W, `skydeck window`. Before the page's first frame Edge shows its own empty
   window, in Windows' mode: with Windows in Light mode it may be light for a moment, which is
   Edge's and not the page's (the page cannot change it). Expected: the page itself is dark from its
   first frame, Mode `Dark`. Write down, for each load, whether anything flashed light, and which it
   was: Edge's empty window (nothing of the page in it), or a frame of the page (its title bar or
   its list in light).
5. **Optional: Windows' mode.** Only when you may change it for a minute: in Settings >
   Personalization > Colors set the app mode to the other one (Light ↔ Dark). Expected while
   Mode is `Dark`: the window stays dark. Pick `Auto` (**Dark → Auto**): the window follows
   Windows' mode of the moment. Set Windows' mode back to what you wrote down: at `Auto` the window
   follows at once. Then pick `Light` (**Auto → Light**): the window is light whatever Windows
   says.
6. **Optional: Claude Code's theme.** This step needs Claude Code's theme to be "Auto (match
   terminal)"; the setting is looked at in a throwaway session.
   - **A new throwaway session.** Pick `Light` (when Mode shows another). In the window press
     Ctrl+Shift+N. The right side shows the form for a new session, its first field the directory,
     with the cursor in it; when the form does not show, or the cursor is not in that field, type
     nothing: press Ctrl+Shift+N again, or click into the field. Press Ctrl+A in the field, type the
     throwaway folder's full path over its text (`/home/<you>/skydeck-try`), leave the other fields
     empty, and press Enter only when the field holds exactly that path. **Type no prompt into the
     new session.** Look that it is the new one: the header shows its short id and "opened" a moment
     ago, `skydeck-try` as its folder, and its terminal shows Claude Code's empty prompt. Look that
     its terminal has the keyboard: the key bar says `Focus: terminal` (else Ctrl+Shift+L until it
     does).
   - **Its theme.** Only then type `/theme` and Enter. Claude Code shows its themes, the current
     one marked; write down its name. When the list has no "Auto (match terminal)" (an older
     Claude Code), press Esc and leave out the rest of this step but its end. When the current one
     is "Auto (match terminal)", press Esc. When it is another one, either press Esc and leave out
     the rest of this step but its end, or choose "Auto (match terminal)" for this step (it is then
     your Claude Code's theme until you choose yours again, at the end of this step).
   - **What it picked, and a switch while it runs.** Expected: Claude Code draws its light theme
     (dark text on the light terminal). Now pick `Dark` (**Light → Dark**): the terminal turns dark
     at once. What Claude Code does then is not documented: its documentation (read
     2026-11-18) says only "Selecting the auto option detects your terminal's light or dark
     background, so the theme follows OS appearance changes whenever your terminal does", not how
     or when it detects. It may keep its light theme (skydeck tells a running program the new
     colours only when it asks again) or change to its dark one; wait a few seconds, then write
     down which it does. Then end it: the terminal has the keyboard (`Focus: terminal`) and the
     header shows the throwaway session's short id; type `/exit`, then `Close` on its ended bar.
     Start a second throwaway session the same way (the form, the path, no prompt), with Mode
     `Dark`. Expected: Claude Code draws its dark theme from its start (expected, not tried).
   - **The end of this step.** Look that the header shows the throwaway session's short id and the
     key bar says `Focus: terminal` (else Ctrl+Shift+L until it does). When you chose "Auto (match
     terminal)" above, type `/theme` and Enter, choose the theme you wrote down, then `/theme` once
     more: it is marked as the current one; press Esc. Then type `/exit`, and `Close` on its ended
     bar.
7. **The end.** Pick in Mode what you wrote down in the setup, and look that the window is as it
   was. Windows' mode is as the setup wrote it down (step 5 put it back), and
   Claude Code's theme is the one `/theme` showed in step 6 (its end put it back).

Write down: for steps 1 to 3 whether the window and its terminals were wholly light or dark, what
a running Claude Code looked like on the light background, and whether the keyboard stayed where
it was; for step 4, for the reload and the new window, whether anything flashed light and whether
it was Edge's empty window or a frame of the page, and what Mode showed; for step 5, whether
the window followed Windows at `Auto` and not at `Dark` or `Light`; for step 6, Claude Code's theme
in `/theme`, the theme it drew in each new session, and whether the running one changed after the
pick.

Not tried before this check was written: all of it in Edge and with a real Claude Code. The page
suite checks the switch in headless Chromium with the system's scheme emulated (the computed colours
of every variable in each state, the terminals' colours, the reload frame by frame, a second page of
the profile), and the answers to OSC 10 and 11 with the stand-in program's questions; how Edge
draws its window before the page's first frame, how Windows' mode reaches Edge, and what Claude
Code's "Auto (match terminal)" does with the answers (when it asks, and whether again during a
session) are known from nothing but this check.

## The flags a session was started with

The check of the flags in the header (follow-up F16; design-step-2.md 12.5): W35, in your window,
on one new throwaway session in `~/skydeck-try` and nothing else. It changes no file and no setting
of yours, and types and presses keys only in that session's terminal and in the New form. From
step 2 on, before every key and every click, look at the header's short id: it must be the
throwaway session's (step 2 writes it down).

## W35. The flags in the header (real claude)

Setup: skydeck updated to a commit that has follow-up F16 (`skydeck update`, W32); the window open;
the throwaway folder there (`mkdir -p ~/skydeck-try`). Write down the time.

1. **Start it with flags.** In the window press Ctrl+Shift+N. The right side shows the form for a
   new session, its first field the directory, with the cursor in it; when the form does not
   show, or the cursor is not in that field, type nothing: press Ctrl+Shift+N again, or click into
   the field. Press Ctrl+A in the field and type the throwaway folder's full path over its text
   (`/home/<you>/skydeck-try`). Click into the field "Flags for claude" and type
   `--model haiku --permission-mode plan`. Leave the label and the group empty. Press Enter only
   when the directory field holds exactly that path and the flags field exactly those words.
2. **The header.** Look that it is the new one: the header shows a short id you have not seen, its
   folder ends in `skydeck-try`, "opened" a moment ago, and its terminal Claude Code's prompt.
   Write the short id down. Expected within a few seconds (once Claude Code's start was recorded):
   the header's second line ends, after the short id, in `--model haiku --permission-mode plan` —
   in the lighter grey of the short id, in the narrow font of the folder and the short id, with no
   word before it and no box around it, as far from the short id as the short id is from the text
   before it. The header has the same four lines and the same height as before it came: the
   terminal under it did not move down. Hold the mouse still over the flags for a second:
   the tooltip reads `Started with: --model haiku --permission-mode plan`, on one line. (The item
   shows the flags skydeck recorded, the ones a resume passes on again; a prompt and flags such
   as `-n`, `--worktree` or `--tmux`, which skydeck drops when it records a start, are never
   shown.)
3. **Short of room.** Make the window narrower by dragging its right edge, slowly, and watch the
   second line: first the flags get shorter, ending in `…`, until they are gone (they show six
   characters or more, or nothing); only then does "where the title comes from" lose characters,
   and after it the folder and the times together; the short id is never cut, and the header keeps
   its height. Drag the window back to its width.
4. **One prompt**, so that the session has a transcript (a session without one is not listed once
   it has ended). Look at the header's short id: it is the one you wrote down; else type nothing,
   and click the throwaway session's row once: it is under Open and its title ends in
   `skydeck-try` (never a row with a coloured bar at its left: a click on one would clear a real
   session's mark); then look at the short id again. Look that its terminal has the keyboard: the key bar says `Focus: terminal` (else
   Ctrl+Shift+L until it does). Type `Reply with the single word ok, in this chat, with no tool and
   no file.` and Enter. If it asks anything — to run a command, to edit a file, or (the session
   runs in plan mode) whether to go on with a plan — answer No, or press Esc. Wait for its reply.
5. **Ended and closed.** Look at the short id: it is the throwaway session's (`/exit` ends the
   session it is typed into). With `Focus: terminal`, type `/exit` and Enter. Expected: the ended
   bar, and the header's second line still ends in the flags. Click `Close` on the bar. Expected:
   the right side shows the throwaway session's resume card (its title and folder in the header):
   its line "Will run" ends in `--model haiku --permission-mode plan`, and the header's second line
   ends at the short id: the flags are not printed twice.
6. **Resumed.** Click "Resume here" on the card (a click, not Enter). Expected: the session runs
   again in a terminal of the window, the same short id; within a few seconds the header's second
   line ends in the same flags again (a resume passes them on again). Then, with `Focus: terminal`
   and its short id looked at, type `/exit` and Enter, and click `Close` on the ended bar. The
   throwaway session stays in the list, not running, as every throwaway session of these checks
   does.

Write down: the time of the setup; the second line of step 2 as you saw it (each part, in order),
the tooltip's text, whether anything of the line or the terminal moved when the flags came; in
step 3, which part lost characters first; the "Will run" line of step 5 and whether the header
showed the flags beside the card; whether step 6 showed them again. A model changed with `/model`
inside the session is not shown: the header says what the session was started with (12.5).

Not tried before this check was written: all of it with the real Claude Code. The tests start the
stand-in program from the form with the same kind of flags and see them in the header, on the
ended bar and in "Will run", and measure that nothing else of the line moves at any width.

## Favourite flags

The check of the new form's favourite flags (follow-up F15; design-step-2.md 12.6;
[install.md](install.md), "A new session"): W36, in the window, with the throwaway folder
`~/skydeck-try` and one new throwaway session that gets no prompt at all. It saves one favourite of
its own, `--verbose --model sonnet`, and removes it at its end; a favourite you saved yourself stays
as it is: the check never clicks the × of a chip whose text is not the check's own. Its step 7
selects one session of yours, with one click on its row, only to look at the form's group chip:
it starts and changes nothing there, and the step ends on the throwaway session. Steps that type a command are typed in W, a WSL terminal of your own (never a `!` command
inside Claude Code).

## W36. Favourite flags in the new form (real claude)

Setup: the window is open, and `mkdir -p ~/skydeck-try` in W. In the window press Ctrl+Shift+N
(here and below; in a browser tab: the `+ New` button). The right side shows `New session`, the caret in its first field, Directory; when the form does
not show, press Ctrl+Shift+N again. Under the field "Flags for claude" a row of chips shows the
favourites you have (no row when there is none); write down how many, and their texts. With 12
already the form takes no more: write that down and stop (press Esc while the form shows). When
one of them reads `--verbose --model sonnet` already, use `--verbose --model haiku` everywhere
below instead. **Press Esc only while the right side shows `New session`**: there it closes the
form, while in a session's terminal it reaches Claude Code.

1. **Save.** Click into the field "Flags for claude". Expected: it is empty, and every chip is off
   (none is coloured). Only when the right side shows `New session` and the caret is in "Flags for
   claude", type `--verbose --model sonnet`; type nothing otherwise (click into the field again,
   and look again). Expected: the ★ at the end of the field can be clicked, and its title (point
   at it) is `Save these flags as a favourite`. Click it. Expected: a chip `--verbose --model
   sonnet` comes at the end of the row, on (coloured), and the field still holds the text. The ★
   is now greyed out; its title's second line says `these flags are a favourite already`.
2. **A second look.** Press Esc (the form shows): the form closes. Press Ctrl+Shift+N. Expected:
   the form again, its flags field empty and every chip off, the chip `--verbose --model sonnet`
   in the same place.
3. **Start a session with it.** Before any key: only when the right side shows `New session` and
   the caret is in Directory (its first field), press Ctrl+A and type the throwaway folder's full
   path over its text (`/home/<you>/skydeck-try`); type nothing otherwise (press Ctrl+Shift+N
   again, or click into Directory, and look again). Leave the label and the group empty (a chip
   after the Group field, step 7's, is not clicked here). Click the chip `--verbose --model
   sonnet`. Expected: the flags field holds exactly `--verbose --model
   sonnet`, and the chip is on; the caret is still in Directory (a click on a chip leaves it where
   it was). Press Enter only when Directory holds exactly that path and the flags field exactly
   that text. **Type no prompt into the new session.** Look that it is the new one: the header
   shows a short id and "opened" a moment ago, and the folder `skydeck-try`; write the short id
   down.
4. **The flags it runs with.** In the window, the header's second line ends with `--verbose
   --model sonnet` (the flags it was started with, follow-up F16; W35). In W, `skydeck show <short
   id>`: its `launch:` line ends with `--verbose --model sonnet` too.
5. **Remove, and Undo.** In the window press Ctrl+Shift+N, and look that the right side shows `New
   session`. Point the mouse at the chip `--verbose --model sonnet` (read its text: it must be the
   check's own): a × shows at its right end. Click the ×. Expected: the chip is gone, the line
   next to Start reads `Removed --verbose --model sonnet · Undo` (a text longer than 28
   characters is cut as the chip's, the whole in its hover title), and the flags field is
   unchanged (empty). Click `Undo`. Expected: the chip is back in its place, and the line reads
   `starts in this window · Esc closes` again. Press Esc (the form shows).
6. **After a restart.** In W, `skydeck window --restart`. The window says for a few seconds that
   the server is not answering, then shows every session again. Press Ctrl+Shift+N. Expected: the
   same chips in the same order as in step 2, every one off. Press Esc (the form shows).
7. **The group chip** (follow-up F28). In the list, find a session of yours that is in a group
   and whose row shows now: in an open card (its sessions drawn under the caption) or with the
   group's name on its row. Never take one with a coloured bar at its left (a session that needs
   you and stays selected for 1.5 seconds is marked seen), and leave a closed card closed (`▸`,
   the group's name and a number, no session under it: a selected caption gives no chip). Click
   that row once, on its title (a double click on a session that is not running resumes it),
   then press Ctrl+Shift+N, and look that the right side shows `New session`. Expected: right
   after the Group field a chip with that group's name (a name longer than 28 characters ends in
   `…`), and the Group field itself empty. Point at the chip: its title reads `Use the group
   <name>`, with the whole name. Click it. Expected: the Group field holds exactly the name, and
   the caret is still in Directory. Press Esc (the form shows): the form closes, and nothing was
   started. Then click the throwaway session's row once and look at the header's short id: it is
   the one of step 3. Press Ctrl+Shift+N, and look that the right side shows `New session`.
   Expected: no chip after the Group field (the throwaway session is in no group). Press Esc (the
   form shows). With no session of yours in a group, or none whose row shows without a coloured
   bar, leave out the first half and write that down.
8. **The end.** End the throwaway session: click its row in the list (the folder `skydeck-try`,
   the short id of step 3) and look at the header's short id; look that its terminal has the
   keyboard (the key bar says `Focus: terminal`; else Ctrl+Shift+L until it does); type `/exit`
   and Enter, then `Close` on its ended bar. Then remove the check's favourite: Ctrl+Shift+N, look
   that the right side shows `New session`, point at the chip `--verbose --model sonnet` (its
   text, never one of yours), click its ×, and press Esc (the form shows) without clicking `Undo`.
   The chips are then those of the setup.

Write down: the favourites of the setup (how many, their texts); for each step whether it went as
expected; the `launch:` line of step 4; the chip's text and title of step 7; anything that
differs, and where.

Not tried before this check was written: all of it, in Edge. The tests run the form in headless
Chromium against a stand-in server, and the server on test databases; they never start `claude`.

## A session's ticket

The check of a session's ticket (follow-up F18; design-step-2.md 12.5; [install.md](install.md),
"The ticket link", its paragraph "The ticket of a session"): W37, in your window, on the throwaway
session of "The window (step 2, stage A)" and nothing else. It opens only `https://example.com/browse/TRY-1`, a page of
`example.com` (a domain kept for examples: nothing of yours is on it), sets a ticket only on the
throwaway session and removes it at its end. It changes no file and no setting of yours. Commands
are typed in W, a WSL terminal of your own (never a `!` command inside Claude Code).

## W37. A ticket on the throwaway session

Setup: skydeck updated to a commit that has follow-up F18 (`skydeck update`, W32; it upgrades the
database once, [install.md](install.md), "An older checkout does not open an upgraded database"); the window
open, with the throwaway session in it. Click the throwaway session's row in the list, then look at
the header's short id: it must be the throwaway session's (`skydeck ls` in W prints the short ids
as the last column); write it down. **Before every key and every click below, look at it again.**
The header's third line starts with `no pull request` (or the pull requests' chip) and ends in
`+ ticket` and `+ PR` (`Pull requests` when the session has one); when it starts with a ticket's chip instead (an earlier run left one), go on:
step 6 removes it. **Type text only into an open dialog**: after `t` or a click on `+ ticket` /
`Ticket`, look that a dialog is there whose heading reads `Ticket — <the throwaway session's
title>` and whose field has the keyboard (the cursor blinks in it); when the key bar says `the
ticket is not here yet; press t again` instead, or nothing shows, no dialog opened: type nothing,
and click the header's `Ticket` (or `+ ticket`) again — or press `t` again only once the key bar
says `Focus: list` (else first click the throwaway session's row). Typed into the list, `k` would
move to a real session and `d` mark it done (on a session running in the window it opens the dialog
`Mark done`, where a following Enter or Space marks it done and keeps it running; nothing is
ended); typed while the terminal has the keyboard, it goes
to the throwaway session's prompt.

1. **Set by a link.** Look that the key bar says `Focus: list` (else press Ctrl+Shift+L until it
   does). Press `t`. Expected: the dialog `Ticket — <title>`, its field empty, its hint `a link`,
   or `a link, or a key like ABC-123` when your `config.json` sets `ticketUrl`: write down which.
   Only while that dialog shows, type `https://example.com/browse/TRY-1` and press Enter.
   Expected: the dialog closes; the header's third line starts with `TRY-1 ↗` (underlined, in the
   links' colour), the rest of the line as before, and the button before `+ PR` (`Pull requests`)
   reads `Ticket`.
   Point at `TRY-1 ↗`: its tooltip is `https://example.com/browse/TRY-1`.
2. **Open it.** Click `TRY-1 ↗`. Expected: your default browser (or Edge, with `window.links`
   `"edge"`) opens `https://example.com/browse/TRY-1`: a page of `example.com`, or one that says
   it was not found. Write down which browser opened it. Close that page and come back to the
   window. The group chip, when the session has a group, is as it was.
3. **`skydeck show`.** In W, `skydeck show <short id>`. Expected: right after the `group:` line, a
   line that starts with `ticket:` and ends with `https://example.com/browse/TRY-1`.
4. **Set by a key**, only when the hint of step 1 read `a link, or a key like ABC-123`; otherwise
   skip this step. Look at the header's short id, then click `Ticket`. Expected: the dialog, its
   field holding `https://example.com/browse/TRY-1`. Only while it shows, press Ctrl+A, type
   `TRY-2` and press Enter. Expected: the chip reads `TRY-2 ↗`, and its tooltip is your
   `ticketUrl` with `TRY-2` in place of `{key}`. **Do not click it** (it would open your ticket
   system). Then, only after looking that the dialog shows again (click `Ticket`), press Ctrl+A,
   type `https://example.com/browse/TRY-1` and press Enter: the chip reads `TRY-1 ↗` again.
5. **A refusal.** Click `Ticket` and look that the dialog shows. Press Ctrl+A, type
   `javascript:alert(1)` and press Enter. Expected: the dialog stays, its field still holds
   `javascript:alert(1)`, and under it the line `a ticket link must start with http:// or
   https://`. Press Esc while the dialog shows. Expected: it closes; the chip still reads
   `TRY-1 ↗`.
6. **Remove it.** Click `Ticket` and look that the dialog shows. Press
   Ctrl+A, then Delete, then Enter. Expected: the dialog closes, the chip is gone, the button
   reads `+ ticket`, and the third line shows what it showed in the setup. In W, `skydeck show
   <short id>` prints no `ticket:` line (but, when the session's group holds a ticket key and
   `ticketUrl` is set, the group's link, as before this check).

Write down: the hint of step 1; for each step whether it went as expected; the browser of step 2;
anything that differs, and where. At the end the throwaway session has no ticket.

Not tried before this check was written: all of it, in Edge. The tests run the header and the
dialog in headless Chromium against a stand-in server and a test server whose links go to a stub;
they never open a browser and never start `claude`.

## A ticket's status

The check of a ticket's status (follow-up F19; design-step-2.md 12.5, 12.2, 12.3;
[install.md](install.md), "A ticket's status"): W38, in your window, on the throwaway session of
"The window (step 2, stage A)" and nothing else. It asks no real tracker and not GitHub: the status
comes from a stand-in program that you write into a throwaway folder, `~/skydeck-try/status`,
whose three lines the check gives, and the rule for it takes only `https://example.com/try/`,
addresses of `example.com` (a domain kept for examples: nothing of yours is on it, and nothing
opens it). It changes one file of yours, `config.json`, which it copies aside first and gives back
at its end after comparing the two; it sets a ticket only on the throwaway session and removes it
at its end, and it removes only the folder it made. It types no prompt into any terminal.
Commands are typed in W, a WSL terminal of your own (never a `!` command inside Claude Code).

## W38. A ticket's status on the throwaway session

Setup: skydeck updated to a commit that has follow-up F19 (`skydeck update`, W32; it upgrades the
database once, [install.md](install.md), "An older checkout does not open an upgraded database"); the window
open, with the throwaway session in it. Click the throwaway session's row in the list, then look
at the header's short id: it must be the throwaway session's (`skydeck ls` in W prints the short
ids as the last column); write it down. **Before every key and every click below, look at it
again.** The header's third line starts with `no pull request` (or the pull requests' chip); when
it starts with a ticket's chip instead (an earlier run left one), go on: step 6 removes it. **Type
text only into an open dialog**: after `t` or a click on `+ ticket` / `Ticket`, look that a dialog
is there whose heading reads `Ticket — <the throwaway session's title>` and whose field has the
keyboard (the cursor blinks in it); when the key bar says `the ticket is not here yet; press t
again` instead, no dialog opened: type nothing, and press `t` again. Typed into the list, `k`
would move to a real session and `d` mark it done (on a session running in the window it opens the
dialog `Mark done`, where a following Enter or Space marks it done and keeps it running; nothing is
ended). **The list takes a key only while the key bar
says `Focus: list`**; press Ctrl+Shift+L until it does (a click on a running row gives the keyboard
to its terminal, and what you type would reach Claude Code).

**The stand-in program.** In W (`mkdir` fails when an earlier W38 left the folder: do its step 6
first):

```sh
mkdir ~/skydeck-try/status
printf '%s\n' '#!/bin/sh' 'cat "$HOME/skydeck-try/status/answer"' 'exit 0' > ~/skydeck-try/status/status
chmod +x ~/skydeck-try/status/status
printf '%s\n' 'In Progress' 'doing' > ~/skydeck-try/status/answer
~/skydeck-try/status/status
```

The last command prints `In Progress` and, under it, `doing`: the two lines a status program
prints (install.md). The program's three lines are `#!/bin/sh`, `cat` of the file `answer`, and
`exit 0`; the file `answer` is what you change between the steps.

**Your configuration comes first.** The paths below are the default ones: with `XDG_CONFIG_HOME`
set, the file is under that folder (install.md, "Places"); with `SKYDECK_HOME` set, it is
`$SKYDECK_HOME/config/config.json` (install.md, "Environment variables"). In W:

```sh
ls -l ~/.config/skydeck/config.json ~/.config/skydeck/config.json.before-w38
```

- **`config.json.before-w38` is listed**: an earlier W38 did not finish. Do its step 6 first (it
  compares the two files before anything is copied), then start again.
- **Only `config.json` is listed**: you have a configuration, whatever it holds. Copy it aside, as
  it is (`-n`: an existing copy is never written over):

  ```sh
  cp -p -n ~/.config/skydeck/config.json ~/.config/skydeck/config.json.before-w38
  ```

  Then add one line, on a line of its own right after the opening `{`, as its first key (with your
  own home folder, `echo $HOME`, in place of `/home/you`):

  ```
  "ticketStatus": [ { "match": "https://example.com/try/", "command": ["/home/you/skydeck-try/status/status"] } ],
  ```

  In a file written on one line (`{ "terminal": "wezterm" }`), put the key right after `{` on
  that line instead. In a file that holds no key yet (`{}`, `{ }`, or `{` and `}` on two lines),
  add it without the trailing comma. When the file already holds a `"ticketStatus"` list (yours),
  add no second key: put only the object `{ "match": "https://example.com/try/", "command":
  [ … ] },` first in that list, and take it out again at the end.
- **Both are missing** (`No such file or directory` twice): you have none. Create the file with
  only this key (the command writes nothing when the file exists):

  ```sh
  mkdir -p ~/.config/skydeck
  test -e ~/.config/skydeck/config.json || printf '{ "ticketStatus": [ { "match": "https://example.com/try/", "command": ["%s/skydeck-try/status/status"] } ] }\n' "$HOME" > ~/.config/skydeck/config.json
  ```

A mistake in the file makes every skydeck command print one line that names the file and the key
and exit 1 (`skydeck doctor` shows it as a problem line); correct the line, or go on with step 6.
To see that the file is valid: `skydeck ls > /dev/null` prints nothing. Then, in W (the server
reads the file when it starts; the window stays and connects again):

```sh
skydeck window --restart
```

1. **Set the ticket.** Select the throwaway session and look at the header's short id. Look that
   the key bar says `Focus: list`. Press `t`. Expected: the dialog `Ticket — <title>`, its field
   empty, and no line about a status above it (no provider reads a session without a ticket).
   Only while that dialog shows, type `https://example.com/try/TRY-1` and press Enter. Expected:
   the dialog closes; within a second or two the header's third line starts with `TRY-1 · In
   Progress ↗`, in blue (the pull requests' blue for `review required`), the name underlined; the
   throwaway session's row in the list has a small chip `In Progress`, in blue, where the
   pull-request chip stands or would stand. Point at `TRY-1 · In Progress ↗`: its tooltip is two
   lines, `https://example.com/try/TRY-1` and `In Progress, checked <age> ago` (an age such as
   `12s`). Press `t` again (look at the dialog's heading): above its field the line `In Progress
   · checked <age> ago` and a `↻` at the line's right end, whose tooltip is `read its status now`;
   press Esc. **Do not click the chip** (it would open `example.com`).
2. **Each category, with ↻.** For each row of the table, in this order: in W, write the answer
   (the command below the table: its first word is the status, its second the category); in the
   window look at the header's
   short id, look that the list has the keyboard and press `t`, look at the dialog's heading, then
   click `↻` (the keyboard stays in the field). Expected: within a second or two the dialog's
   line reads `<the status> · checked <age> ago`. Press Esc, and look at the chip in the header
   and the small chip in the throwaway session's row:

   | The answer's lines | Colour of the two chips |
   |---|---|
   | `Blocked by legal`, `blocked` | red |
   | `In Review`, `review` | amber |
   | `In Progress`, `doing` | blue |
   | `Done`, `done` | green |
   | `Backlog`, `todo` | grey, as a draft pull request's chip |
   | `Rejected`, `closed` | grey |

   The six commands, one for each row (each is one line; type or paste one, then do the window's
   part of the step):

   ```sh
   printf '%s\n' 'Blocked by legal' 'blocked' > ~/skydeck-try/status/answer
   printf '%s\n' 'In Review' 'review' > ~/skydeck-try/status/answer
   printf '%s\n' 'In Progress' 'doing' > ~/skydeck-try/status/answer
   printf '%s\n' 'Done' 'done' > ~/skydeck-try/status/answer
   printf '%s\n' 'Backlog' 'todo' > ~/skydeck-try/status/answer
   printf '%s\n' 'Rejected' 'closed' > ~/skydeck-try/status/answer
   ```

   Write down each colour, and
   whether the colours are the ones the pull requests' chips have in your list for `failing`,
   `pending`, `review required`, `approved` and a draft (a pull request of yours may show them).
3. **The cut, and a word that is no category.** In W: `printf '%s\n' 'A very long status text
   that is cut' 'urgent' > ~/skydeck-try/status/answer`; then ↻ as in step 2. Expected: the
   header's chip reads `TRY-1 · A very long status text that is cut ↗` (the whole status, grey:
   `urgent` is no category; in a narrow window the end of the status is cut with `…` first); the
   row's small chip `A very long s…` (13 characters and `…`), with the tooltip `TRY-1 · A very
   long status text that is cut`. Then put `In Progress` and `doing` back, in W: `printf '%s\n'
   'In Progress' 'doing' > ~/skydeck-try/status/answer`, and read it: ↻ as in step 2. Expected:
   the dialog's line reads `In Progress · checked <age> ago`, and the header's chip `TRY-1 · In
   Progress ↗`, in blue (a failure keeps the status last READ: step 4 needs this read).
4. **A failure keeps the status.** In W: `chmod -x ~/skydeck-try/status/status`. In the window
   (short id, `Focus: list`, `t`, heading) click `↻`. Expected: the dialog's line starts with
   `status not read: the status command could not be run: spawn` (one line, cut with `…` where the
   dialog ends); point at it: its tooltip has it whole, `status not read: the status command could
   not be run: spawn /home/you/skydeck-try/status/status EACCES · last In Progress, checked <age>
   ago` (with your home folder in place of `/home/you`);
   after Esc the chip still reads `TRY-1 · In Progress ↗`, in blue, and its tooltip has three
   lines: the address, `status not read: the status command could not be run: spawn
   /home/you/skydeck-try/status/status EACCES`, and `In Progress, checked <age> ago` (the age of
   the last success, which grows). Then
   `chmod +x ~/skydeck-try/status/status`, click `↻` again (dialog first, as above): the line is
   `In Progress · checked <age> ago` again, and the tooltip has two lines.
5. **`skydeck show`.** In W: `skydeck show <short id>`. Expected: right after the `group:` line, a
   line that starts with `ticket:` and ends with `https://example.com/try/TRY-1 · In Progress`.
   Then `skydeck ticket refresh <short id>`: it prints `<short id> ticket:
   https://example.com/try/TRY-1 · In Progress`. With `chmod -x` as in step 4, the same command
   prints that line with ` (status not read: the status command could not be run: spawn
   /home/you/skydeck-try/status/status EACCES)` after it, and `skydeck show <short id>` adds that
   `status not read: …` line under `ticket:`; put `chmod +x`
   back, and look that the next `skydeck ticket refresh <short id>` has no failure.
6. **Put everything back.**
   - **The ticket.** Look at the header's short id, click `Ticket` and look that the dialog shows.
     Press Ctrl+A, then Delete, then Enter. Expected: the dialog closes, the chip is gone, the row's
     small chip is gone, the button reads `+ ticket`; `skydeck show <short id>` prints no
     `ticket:` line.
   - **Your configuration**, by the branch you took above:
     - **You made the copy.** Compare first; copy nothing yet:

       ```sh
       diff ~/.config/skydeck/config.json.before-w38 ~/.config/skydeck/config.json
       ```

       It must show only your own change: the `ticketStatus` line (or object) you added, after `> `
       (with a line such as `1a2` above it); for a file on one line, that line before (`< `) and
       after (`> `), differing only by your rule (with `1c1` above them). Only then put the copy
       back, and remove it once the two are the same:

       ```sh
       cp -p ~/.config/skydeck/config.json.before-w38 ~/.config/skydeck/config.json
       cmp ~/.config/skydeck/config.json.before-w38 ~/.config/skydeck/config.json && rm ~/.config/skydeck/config.json.before-w38
       ```

       **When `diff` says `config.json: No such file or directory`**, the file was removed since
       (after an unfinished run), and your keys are only in the copy: put the copy back with the
       same `cp -p` line, then `cmp` and `rm` as above. **When `diff` shows anything else**, the
       file was changed since the copy was made (by you or by a program): copy nothing back. Look
       at both files, take out of `config.json` by hand the rule this check added, keep everything
       else, and only then remove the copy (`rm ~/.config/skydeck/config.json.before-w38`).
     - **You had no file before**: `cat ~/.config/skydeck/config.json` must print exactly the one
       line this check wrote; then remove the file this run created,
       `rm ~/.config/skydeck/config.json`. When it holds more, something was added since: take out
       only the `ticketStatus` key, by hand.

     Then `skydeck window --restart`.
   - **The stand-in.** `rm -r ~/skydeck-try/status` (the folder this check made; `ls
     ~/skydeck-try` no longer lists `status`).

Write down: for each step whether it went as expected; the colour of each chip in step 2, and
whether it matched the pull requests' colours; the words of the failure in step 4; whether the
tooltip's age grew; anything that differs, and where. At the end the throwaway session has no
ticket, `config.json` is as it was before this check, and `~/skydeck-try/status` is gone. One
thing stays: skydeck's cache keeps a row for `https://example.com/try/TRY-1` (a few bytes; it
removes none), which nothing shows once no session has that ticket.

Not tried before this check was written: all of it, in Edge. The tests run the header, the row and
the dialog in headless Chromium against a stand-in server, and the server and the commands with
stand-in programs on test databases; they never ask a real tracker, never call the real `gh` and
never start `claude`.

## Ending a session from the window

The check of the dialog "Mark done" (follow-up F30; design-step-2.md 12.10; [install.md](install.md),
"Done."): W39, in your window, on one new throwaway session in `~/skydeck-try` and nothing else. No
test may start the real `claude`, so only this shows that a real Claude Code ends on the dialog's
hang-up, how its end is recorded, and that it resumes with its conversation. It ends that throwaway
session twice and nothing else: before every `d`, every Enter and every click, look at the header's
short id: it must be the throwaway session's (step 1 writes it down). A session that was already
running before skydeck was updated runs on an older keeper: `d` on it asks nothing (its toast says
`skydeck cannot end this one`), which is right and not part of this check.

## W39. Ending a session from the window (real claude)

Setup: skydeck updated to a commit that has follow-up F30 (`skydeck update`, W32), then the window
open (`skydeck window`); the throwaway folder there (`mkdir -p ~/skydeck-try`). Write down the time.

1. **A throwaway session.** Press Ctrl+Shift+N, type the throwaway folder's full path into the
   directory field (`/home/<you>/skydeck-try`), leave the other fields empty and press Enter. Look
   that it is the new one (a short id you have not seen, its folder ends in `skydeck-try`) and write
   the short id down. With `Focus: terminal`, type `Reply with the single word ok, in this chat, with
   no tool and no file.` and Enter, and wait for its reply: the row no longer says working.
2. **The dialog, and Esc.** Press Ctrl+Shift+L (`Focus: list`; the selected row is the throwaway
   session's) and `d`. Expected: a dialog over the window, `Mark done: ` and the session's title,
   `This session is still running.`, no warning, the buttons `End session and mark done`, `Mark
   done, keep it running`, `Cancel`, the second one outlined. Tab and → move the outline to the next
   and back to the first after the third; Shift+Tab and ← the other way; a click on the list or the
   terminal does nothing; Ctrl+Shift+H says `close the dialog first (Esc)`. Press Esc. Expected: the
   dialog is gone, the row still under Open, not marked done.
3. **End it.** Look at the short id again, then `d`, ← (`End session and mark done` is outlined
   now), and Enter. Expected: the toast `Ending the session…`, within a few seconds `Ended and marked
   done: hidden from the list.` with `Undo`; the row is gone from Open, its slot free, and the right
   side no longer shows its terminal.
4. **An ordinary end.** Press `a` (show done). Expected: the throwaway session is listed, marked
   done, not in the crash colour and with no `ended unexpectedly` (its row, its card's "how it
   ended"). In a WSL terminal of your own, `skydeck show <short id>`: no `ended-unexpectedly` mark
   (the mark restore offers a session by).
5. **Back.** In the window, click the throwaway session's row (it is listed, marked done) and look
   at the header's short id: it is the one you wrote down. Press Ctrl+Shift+L (`Focus: list`) and `d`
   (it marks it undone), then `a` again: it is listed under Recent. Click `Resume here` on its card
   (a click, not Enter). Expected: it runs again in a terminal of the window, the same short id, and
   scrolling up in its terminal shows the prompt of step 1 and its `ok`.
6. **While it works.** With `Focus: terminal` and its short id looked at, type `Count slowly from 1 to
   80, one number per line, with no tool and no file.` and Enter. While it is still counting (the row
   says working), press Ctrl+Shift+L and `d`. Expected: the dialog also says `It is working: ending it
   now stops the current turn.`, and `Mark done, keep it running` is outlined. When the count ended
   before your `d` (no warning), press Esc and ask for a longer count. Press Enter. Expected: the
   toast `Marked done. Stays under Open while it runs; hidden once it stops.`; it goes on counting.
7. **The end of the check.** When it has finished, with `Focus: terminal` and its short id looked at,
   type `/exit` and Enter, and click `Close` on the ended bar. Expected: the row is hidden (it is
   done). Then press `a` (it is listed, marked done), click its row, look at the short id, and with
   `Focus: list` press `d`: it is marked undone; press `a` again to hide the done sessions.

Write down: the time of the setup; for each step whether it went as expected; how long step 3's
`Ending the session…` stayed; whether step 4 showed anything of an unexpected end, and what `skydeck
show` printed under the mark; whether step 5's terminal showed the earlier conversation; in step 6,
which button was outlined. If step 3 says `Marked done. It has not ended yet: end it inside claude
if it stays open.`, the Claude Code version (`claude --version`), and whether the session ended
later by itself (its row then leaves Open).

Not tried before this check was written: all of it with the real Claude Code. The tests end the
suite's stand-in program by the same hang-up (it runs its SessionEnd hook with reason `other`, as
Claude Code does for a closed terminal), and check the dialog's keys and words in headless
Chromium; they never start `claude`.

## A copy made in agent view

The check of a copy that Claude Code's background feature makes of a session (follow-up F33; design
5.3 "Copies", 7.2; design-step-2.md 12.1, 12.2; [install.md](install.md), "A copy made by Claude
Code's background feature"): W40, on one new throwaway session in `~/skydeck-try` and nothing else.
No test may start the real `claude`, so only this shows what Claude Code really starts when a session
goes to its background — whether it is the copy skydeck looks for (`--fork-session --resume`), and
when its history reaches the copy's transcript. The tests feed the hook's recorded command and a
process's command line to skydeck by hand.

## W40. A copy made in agent view (real claude)

Setup: skydeck updated to a commit that has follow-ups F33 and F34 (`skydeck update`, W32), then
the window open (`skydeck window`); the throwaway folder there (`mkdir -p ~/skydeck-try`). Write
down the time and the Claude Code version (`claude --version`).

1. **A throwaway session.** In a WSL terminal of your own (not the window): `cd ~/skydeck-try &&
   claude`, then `Reply with the single word ok, in this chat, with no tool and no file.` and Enter;
   wait for the reply. In the window it is one row under Open, `running in another terminal`. Write
   down its short id and its title once it has one.
2. **To the background.** In that session, on an empty prompt, type `/bg` and Enter (agent view
   opens; if it does not, `claude agents`). Wait 10 seconds. Expected: the window still shows ONE
   row with that title — no second one under Open or Recent, without a reload. In another terminal,
   `skydeck ls --all`: when Claude Code made a copy, a second row with that title and the marks
   `continued,empty-copy`; write down its short id. `skydeck ls` does not list it. Then, for the
   copy (or, when there is none, for a second row with that title that has no such mark),
   `skydeck show <its short id>`: write down its `state:` line, what its `holder:` line says after
   the time (`(scripted run)`, `(in Claude Code's background)` or nothing), and
   with that line's pid `tr '\0' ' ' </proc/<pid>/cmdline; echo`: write down the flags it prints,
   leaving out the value after `--resume` (a path). No copy and no second row: write that down,
   and the check ends here.
3. **Shown with `a`.** In the window, press Ctrl+Shift+L until the key bar says `Focus: list`, then
   `a`. Expected: the copy is listed, marked `empty copy`; hovering the mark shows `an empty copy of
   "<the title>" made by Claude Code; it shows by itself once it has a first message`. Write down
   whether its row shows a pull-request chip (Claude Code may copy the original's pull request with
   its title). Press `a` again: it is hidden again.
4. **Its first prompt.** In agent view, open the background session and give it `Reply with the
   single word ok, in this chat, with no tool and no file.` Expected: within a few seconds, without a
   reload, the copy appears in the window by itself, marked `continued`; hovering the mark shows `it
   began as a copy of "<the title>"`. `skydeck show <its short id>` prints `continues:` with the
   throwaway session's id, and a `link:` line `copy <that short id> -> <its short id> at …`.
5. **Its words** (follow-up F34). Click the copy's row, which runs in Claude Code's background, and
   look that the header's short id is the copy's, the one you wrote down in step 2 (the copy and
   the throwaway session have the same title). Write down what each of these says: the row's
   second line (expected `running in Claude Code's background`); the card on the right (expected
   the title `Running in Claude Code's background`, `pid <n>` with no `/dev/pts/…` after it, and
   `Claude Code runs this session itself, without a terminal. skydeck cannot show it here. To see it
   or end it, run claude agents in a terminal. Once it has ended it can be resumed in the window.`);
   the title bar's counts (expected: the count `in the background` takes in the copy, one more than
   before the check; `1 in the background` when no other session runs there); and the `holder:`
   line of `skydeck show <its short id>` (expected to end with `(in Claude Code's background)`).
   `running in another terminal` in their place means Claude Code did not mark the copy as a
   background session in the way skydeck reads: write that down. Then press Ctrl+Shift+L until the
   key bar says `Focus: list`, and `d`. The toast shows for 5 seconds; compare it with `Marked done.
   It runs in Claude Code's background: end it in claude agents. Hidden once it stops.` and write
   down any word that differs. Press nothing on the toast: the copy stays marked done, and step 6
   does not mark it again.
6. **The end of the check.** Stop the background session in agent view as Claude Code's own help
   there says, and `/exit` the throwaway session if it still runs. In the window, click the
   throwaway session's row and look at the header's short id (the one you wrote down in step 1),
   press Ctrl+Shift+L until the key bar says `Focus: list`, and `d`. Not the copy: step 5 marked it
   done, and `d` on it would mark it undone (once it has stopped it is hidden anyway).

Write down: the time of the setup and the Claude Code version; for each step whether it went as
expected; in step 2, whether a second row ever showed without `a` and for how long, and what `skydeck
show --json <the copy's short id>` printed under `links`; in step 4, how long it took to appear; in
step 5, each of the words;
whether the copy came back as a second row at any later time (after a restart of Claude Code's
background, say).

Not tried before this check was written: all of it with the real Claude Code. Which command the
background feature runs is known from one tester's report: `claude --fork-session --resume <the
original's transcript> --permission-mode auto`. What Claude Code does with such a copy later — the
`source` of its start, when its history is written under its new id, whether its supervisor starts
it again — is not known, and nothing in skydeck depends on it.

## The settings screen

The check of the window's settings screen (follow-up F36; design-step-2.md 12.13;
[install.md](install.md), "config.json", its paragraph "In the window: Settings"): W41, in your
window, on your own `config.json`. It changes one harmless setting, `prRefreshMinutes` (how often
the window reads a pull request's status), and puts it back; the file, and the window's copy of
it, are copied aside first when there are any. Afterwards both are as they were: the window makes
or replaces `config.json.skydeck-backup` the first time it writes over the file since its server
started — at step 3 when there was a `config.json`, at step 5 when step 3 created it —, and step 6
puts back what step 1 found (or removes what the check made). Commands are typed in W, a WSL terminal of
your own (never a `!` command inside Claude Code). The tests run the screen in headless Chromium
against a test server with a sandbox's file; only here does the screen meet Edge and your own file.

## W41. A harmless setting changed in the window, and put back

Setup: skydeck updated to a commit that has follow-up F39 (`skydeck update`, W32; before it the
screen had no Advanced, and step 2's click on it is left out); the window open.

1. **Copy the files aside.** In W: `ls -l ~/.config/skydeck/`. Write down whether `config.json` and
   `config.json.skydeck-backup` are listed. Only when `config.json` is: `cp -p
   ~/.config/skydeck/config.json ~/config.json.before-w41`, then `grep -n prRefreshMinutes
   ~/.config/skydeck/config.json` and write down the value (no line: it is not set). Only when
   `config.json.skydeck-backup` is: `cp -p ~/.config/skydeck/config.json.skydeck-backup
   ~/config.json.skydeck-backup.before-w41`.
2. **Open it.** Click the gear at the right end of the title bar. Expected: a dialog over the page,
   `Settings`, its short screen (Appearance, Links, The window; W44 checks it) and at its end
   `Advanced (14 more settings)`; the keyboard is on `Mode`. Click `Advanced (14 more settings)`.
   Expected: under it `The file: <your config.json>` and where its copy is kept (and, when step 1
   found no `config.json`, `The file does not exist yet: a change creates it.`); under `Pull
   requests` the line `prRefreshMinutes`, its field holding your value (or `5`), `default 5 · set
   in the file` (or `· not in the file: the default is used`) and `applies at once`; under `Claude
   Code`, `claudeCommand` shown as text with `names a program: it is changed in the file only` and
   no button.
3. **Change it.** Click into the `prRefreshMinutes` field, press Ctrl+A, type `6` (when your value
   is 6 already, type `7`, and read 7 for 6 below) and press Enter. Expected: under the field
   `Saved: it applies at once.`, and the keyboard still in the field. In
   W: `grep -n prRefreshMinutes ~/.config/skydeck/config.json` prints `6`; `skydeck doctor` prints
   no `configuration:` line. When step 1 found a `config.json`, `ls -l ~/.config/skydeck/` lists
   `config.json.skydeck-backup`, and when the window had written over the file not once since its
   server started,
   `cmp ~/config.json.before-w41 ~/.config/skydeck/config.json.skydeck-backup` prints nothing.
4. **A refusal.** In the same field press Ctrl+A, type `0` and press Enter. Expected: under it, in
   the refusal's colour, `"prRefreshMinutes" must be a positive integer`; the grep of step 3 still
   prints `6`.
5. **Put it back.** When step 1 wrote down a value: Ctrl+A in the field, type it, Enter (`Saved: it
   applies at once.`). When it was not set: click `Default` (`Put back to its default: it applies
   at once.`, the field shows `5`). In W, the grep prints the value of step 1, or nothing. Press Esc:
   the dialog closes and the keyboard is back where it was. When step 1 found no `config.json`:
   `cat ~/.config/skydeck/config.json` prints `{}` (the file the check made, with no key left), and
   `cat ~/.config/skydeck/config.json.skydeck-backup` prints only `prRefreshMinutes` and `6` (the
   window's copy of that file, made by this step's write over it); then, and only then, `rm
   ~/.config/skydeck/config.json`.
6. **The end.** The window's copy: when step 1 made `~/config.json.skydeck-backup.before-w41`, `cp
   -p ~/config.json.skydeck-backup.before-w41 ~/.config/skydeck/config.json.skydeck-backup` and `rm
   ~/config.json.skydeck-backup.before-w41`; when step 1 listed no copy, `rm
   ~/.config/skydeck/config.json.skydeck-backup` (the check's). The file: only when step 1 made
   `~/config.json.before-w41`, and only once the grep of step 5 shows the value of step 1 (or
   nothing): `rm ~/config.json.before-w41`. If anything went wrong and you changed nothing else in
   the file since step 1: `cp -p ~/config.json.before-w41 ~/.config/skydeck/config.json` (a later
   change of yours would be lost by that copy, so then mend the one line by hand instead), then
   `skydeck window --restart`.

Write down: what step 1 found; for each step whether it went as expected, and the words where they
differ; whether the dialog, its fields and its buttons read well in your theme.

Not tried before this check was written: all of it, in Edge.

## Moving a session in Open

The check of moving a session of Open by key (follow-up F37; any row of Open since follow-up F42;
design-step-2.md 12.9, 12.1, 7.6; [install.md](install.md), "Using the window"): W42, in your
window, on three throwaway sessions and a fourth in a WSL terminal of your own, only. The tests move
rows in headless Chromium against a test server with the stand-in; only here do the keys meet Edge,
your layouts and the real Claude Code. The restore order after a reboot (design 7.8) is looked at
only where W16's drill runs anyway.

## W42. Three throwaway sessions moved up and down (real claude)

Setup: skydeck updated to a commit that has follow-up F42 (F43 for step 8, issue #189 for step 9;
`skydeck update`, W32), then the window open (`skydeck window`); the throwaway folder there
(`mkdir -p ~/skydeck-try`). Close every other terminal of the window first, or read the slots below
as the ones after them.

1. **Three throwaway sessions.** Three times: Ctrl+Shift+N, the throwaway folder's full path in the
   directory field (`/home/<you>/skydeck-try`), a label `move-1`, `move-2`, `move-3` in turn, Enter.
   Expected: under Open `move-1`, `move-2`, `move-3` in this order with the numbers 1, 2, 3 (or the
   three slots that were free, ascending).
2. **Up with Shift+↑, on a US layout.** Click `move-3`, press Ctrl+Shift+L (`Focus: list`), then
   Shift+↑. Expected: `move-3` is the second row and has the number 2, `move-2` the third with 3; the
   selection and `Focus: list` stay on `move-3`. Ctrl+Shift+2 shows `move-3`'s terminal,
   Ctrl+Shift+3 `move-2`'s, Ctrl+Shift+1 `move-1`'s.
3. **The letters.** Click `move-3` (the second row), then Ctrl+Shift+L (`Focus: list`): Shift+K
   moves it to the top (number 1), Shift+J back down one place, Shift+↓ down again. Then turn Caps
   Lock on and press `k` and `K` without Shift: nothing moves, neither the selection nor a row;
   Shift+K under Caps Lock moves `move-3` up. Turn Caps Lock off.
4. **The Czech layout.** Switch Windows to the Czech layout (W8) and do step 3 again. Expected: the
   same. Switch back.
5. **What does not move.** On the top row Shift+↑: the key bar says `already at the top of Open`,
   nothing moves. On the last of the three Shift+↓: `already at the bottom of Open`. Press `/`, type
   `move`, Enter (the filter), then Shift+↑ on a row: `clear the filter first: sessions move only
   while no filter or chip is set`, nothing moves; Esc clears the filter.
6. **A session of another terminal (follow-up F42).** In W, a WSL terminal of your own:
   `cd ~/skydeck-try && claude`, and send it one prompt (`say hi`). Expected: it shows under Open
   below the three, with no number. Click it, Ctrl+Shift+L (`Focus: list`), Shift+↑ twice: it is
   now above the third and second rows; the numbers of the three are unchanged and Ctrl+Shift+1…3
   still show their terminals; it has no number. Then type `/clear` in that `claude`, and send one
   prompt again. Expected: the new session's row stands at the place the old one had (above the
   same rows), no number.
7. **A restart.** Write down the order and the numbers. In W: `skydeck window --restart`. Expected:
   once the window is back, the same order (the session of W included) and the same numbers, and
   each Ctrl+Shift+1…3 shows the terminal of the row that has that number.
8. **An ended session gives its number up (follow-up F43).** First look under Open: if a row of a
   terminal of the window has no number, skip this step, because the freed number would go to that
   row at once (issue #189; step 9 shows it). Type `/exit` in the terminal of the row numbered 1.
   Expected: its row goes to Recent with no number, its last screen stays on the
   right under `claude exited (status 0)` with Resume and Close; the other rows keep their numbers;
   Ctrl+Shift+1 says `no session in slot 1`. Then Ctrl+Shift+N, the throwaway folder, label
   `move-4`, Enter: `move-4` takes the number 1 and Ctrl+Shift+1 shows its terminal. Then select
   `move-4`, press `d`, choose `Mark done, keep it running`, and type `/exit` in its terminal: the
   number 1 is free again without `Show done`, Close or a restart; the next Ctrl+Shift+N session
   takes it.
9. **A freed number reaches a session that waits for one (issue #189).** Only on a commit that has
   it, and only when nine terminals of the window hold the numbers 1–9 anyway (or open throwaway
   sessions in the throwaway folder until they do) and every row of a terminal of the window under
   Open has a number (else the first row without one takes the number below, not `move-10`: read
   the step with that row). Ctrl+Shift+N one more time, label `move-10`, Enter. Expected:
   `move-10` shows under Open below the window's terminals, with no number. Type
   `/exit` in the terminal of a throwaway row whose number is lower than 9 (read 4 below as that
   number). Expected: at once, with no message, `move-10` shows the number 4 and stands where 4
   stood (after the row numbered 3, before the one numbered 5), Ctrl+Shift+4 shows its terminal,
   and every other row keeps its number and its place. Then `skydeck window --restart`: the same
   order and numbers.
10. **The end.** For each throwaway session: type `/exit` in its terminal (in W too), then `d` in
    the list to mark it done.

Write down: for each step whether it went as expected, and the words where they differ; your Edge
version and your two layouts.

Not tried before this check was written: all of it, in Edge.

## The update notice

The check of the window's notice of a newer skydeck (follow-up F38; design-step-2.md 16.5, 12.1,
12.13; [install.md](install.md), "Updating", its part "The window says when there is one"): W43,
in your window, on your own checkout. Its first half (steps 1–6) applies nothing: it presses
`Check now`, reads the settings screen's group `Updates`, the title bar and `skydeck doctor`,
turns its choice `Check for updates` (`window.updateCheck`) off and back, and, only where you have such a remote, looks at
what a check does with a remote that needs a passphrase or a login. Its second half (steps 7–9)
applies the update with `Update now`, on your own installation, and only when the dialog lists
commits. The tests run all of it against a test server, a throwaway checkout and a remote that is
a folder (the second half with a real server of a throwaway copy of skydeck); only here does a
check meet your own remote, your network, ssh and the Windows credential manager, and an update
meet Edge, your sessions and your own checkout. Commands are typed in
W, a WSL terminal of your own (never a `!` command inside Claude Code).

## W43. The update notice, and Update now

Setup: skydeck updated to a commit that has follow-up F38 (`skydeck update`, W32); the window open.
In W: `cd ~/skydeck`, `git status --short` (write down what it prints), `git remote get-url origin`
(write it down: steps 5 and 6 put it back), `grep -n updateCheck ~/.config/skydeck/config.json`
(write down the line, or that there is none).

1. **Check now.** Click the gear. Expected: the short screen's fourth group, `Updates`, after
   `The window`: the choice `Check for updates`, then one line — `Last check: <age> ago —
   skydeck is up to date (main at <id>, as origin/main)`, or `… — <n> new commits on origin/main` —
   and `Check now`. Click `Check now`. Expected: `Checking…` for a moment, then `Last check: 0s ago
   — …` (or `1s`). When it says that new commits are there, the title bar shows `Update available`
   right before `Switch…` and the gear; when it says up to date, it shows none. Press Esc: the screen closes, the keyboard is back where it was.
2. **The dialog**, only when the title bar shows `Update available`. Click it. Expected: a dialog
   with the lines `skydeck update --check` prints (in W, `skydeck update --check` prints the same
   lines, then `run skydeck update to apply it`), then `To apply it, in a WSL terminal of your own:
   skydeck update`, and two buttons, `Update now` and `Close`; `Close` has the keyboard, and Tab
   goes to `Update now` and back. Ctrl+Shift+N says `close the dialog first (Esc)`. Press Esc
   (do not press `Update now` here): it closes. Nothing was applied: `git log -1 --format=%h` prints
   the id the block's line had before (`skydeck doctor`'s first line names it too).
3. **doctor.** In W: `skydeck doctor`. Expected: an `info` line `update: …` — `update: <n> new
   commits on origin/main (fetched <age> ago); skydeck update applies them`, or `update: skydeck is
   up to date (…) (fetched <age> ago)` — and no `problem` line that step 1's setup did not have.
   doctor used no network for it (it reads what the window's server stored).
4. **The choice.** In Settings (the gear), choose `Off` in `Check for updates`: `Saved.` beside
   it, no button pressed; in W, `grep -n updateCheck ~/.config/skydeck/config.json` prints
   `"off"`. `Check now` still checks (`Last check: 0s ago — …`). Then choose the one the setup's
   line names again (`Every hour` when it found none, `Every day` for `"daily"`): `Saved.`, and the
   grep prints that value (`"hourly"` when the setup found no line: the key now stays in the file
   with its default value, which is the same).
5. **A remote that needs a passphrase**, only when you have an ssh key with a passphrase that this
   checkout's remote host takes (else write down "left out: no such remote"). In W: `git remote
   set-url origin <the ssh address of the same repository>`. In Settings' group `Updates`, `Check
   now`. Expected:
   nothing asks for the passphrase — no prompt in any terminal, no window; the block says either
   `Last check: 0s ago — …` (the key was in an agent) or `The last check failed 0s ago: git fetch
   from origin failed: …` with what was known before. Then `git remote set-url origin <the address
   of the setup>` and `git remote get-url origin` prints it.
6. **A private https remote**, only when you have a private repository that needs a login and the
   Windows credential manager as git's helper (else write down "left out: no such remote"). In W:
   `git remote set-url origin <its https address>`. In Settings' group `Updates`, `Check now`.
   Expected: no Windows
   dialog opens; the block says `The last check failed 0s ago: git fetch from origin failed: …`
   (no login stored), or, with a stored login, `Last check: 0s ago — …` and, as the branch does not
   follow that repository's history, whatever the look says. Then `git remote set-url origin <the
   address of the setup>`, `git remote get-url origin` prints it, and `Check now` once more gives
   the line of step 1 (`git fetch` may have fetched that repository's objects; they are unused and
   `git gc` removes them in time).

The second half, only when step 2's dialog listed commits and you want them now (else write down
"left out: up to date"). It types into no session. Before step 7, in the window, write down how
many sessions the title bar counts and which slots the Open section shows; in W, `skydeck doctor`
(write down its `problem` lines, if any) and `git log -1 --format=%h`.

7. **Update now.** Click `Update available`, then `Update now`. Expected: the dialog shows
   `skydeck is being updated to <id>. The window comes back by itself.` with no button, and
   Ctrl+Shift+N says `skydeck is being updated`. Within a few seconds the bar `skydeck is being
   updated (since <time>): … the update's log says why: <path of update.log> — read it first; then,
   in a WSL terminal: skydeck window` may show for a moment; then the window reloads itself and a
   bar says `updated to <id>`, the id the dialog listed. No second window opens. Click the bar's ×:
   it goes.
8. **Everything still there.** Expected: the title bar counts the same sessions, Open shows the
   same slots, and each terminal shows its session (its screen rebuilt). In W, `git log -1
   --format=%h` prints the id of step 7, `skydeck doctor` prints no `problem` line that the setup
   of this half did not have, and its `update:` line says up to date. `tail -5
   ~/.local/state/skydeck/update.log` ends with `updated to <id>`.
9. **The dialog again.** Expected: no `Update available` in the title bar. In Settings' group
   `Updates`, `Check now`
   says `Last check: 0s ago — skydeck is up to date (main at <id>, as origin/main)`.

Leaves behind: the remote's address as it was, `window.updateCheck` as it was, the remote-tracking
refs as a `git fetch` leaves them, and `kv window_update_check` with the last check. `git status
--short` prints what it printed in the setup. After the second half: the checkout at the new
commit, the window's server of the new code, and `update.log` with the update's lines.

Write down: for each step whether it went as expected, and the words where they differ; which of
steps 5 and 6, or the second half, were left out; whether the control, the dialog, the running
form and the bars read well in your theme.

Not tried before this check was written: all of it, in Edge; that `GCM_INTERACTIVE` reaches the
Windows credential manager through `WSLENV` (step 6); an update from the window on a real
installation (steps 7–9).

## The short settings screen

The check of the short settings screen and the title bar's gear (follow-up F39; design-step-2.md
12.1, 12.13; [install.md](install.md), "config.json", its paragraph "In the window: Settings", and
"Colours"): W44, in your window, on your own `config.json`. It changes one harmless setting, `Open
links in` (`window.links`: where the links the window opens go), and puts it back, and picks the
theme's Mode and puts it back; a ticket address is only tried with a value the file's rules
refuse, so it changes nothing. `Keep WSL running` is not touched: a change of it counts at the
window's next restart. The file, and the window's copy of it, are copied aside first when there
are any, as in W41. Commands are typed in W, a WSL terminal of your own (never a `!` command inside
Claude Code). The tests run the screen in headless Chromium; only here does it meet Edge, Windows'
fonts and your own file.

## W44. The gear, the short screen and Advanced

Setup: skydeck updated to a commit that has follow-up F39 (`skydeck update`, W32); the window open,
with the terminal of a session shown (any running one; no prompt is typed into it).

1. **Copy the files aside.** As W41's step 1, with `w44` for `w41` in the names; write down the
   value of `grep -n links ~/.config/skydeck/config.json` (no line: not set, which is `default`).
2. **The title bar.** Expected: at its right end `Switch… Ctrl+Shift+P` (with `Update available`
   before it while a newer skydeck is known, W43), then a gear, and no `◐`
   or `✦` button and no word `Settings`. The gear is a drawing in the title bar's text colour (not a
   coloured emoji, not a box or a question mark); holding the mouse over it shows `Settings`.
3. **Open it from the terminal.** Press Ctrl+Shift+L until the key bar says `Focus: terminal`.
   Press the mouse button on the gear and hold it: the key bar still says `Focus: terminal`. Let go.
   Expected: a dialog over the page, `Settings`, then `Appearance` (`Mode`, `Colour theme` and
   under it `Light and dark each keep their own.`), `Links` (`Open links in`, `Ticket address` and
   its hint about `{key}`), `The window` (`Keep WSL running`, a switch with `after a restart`
   beside it; `Typed commands start sessions in` and its hint; from issue #184 `Copy on select`,
   a switch, and its hint `In a session’s terminal; Ctrl+Shift+C copies either way.`),
   `Updates` (follow-up F38: the choice `Check for updates`, the line of the last check
   and `Check now`; W43 tries them), and at the end `Advanced (14 more settings)` and `Close`. No `Save`, no `Default`, no file name. The keyboard
   is on `Mode`. Write down what Mode and Colour theme show.
4. **The theme.** Choose the other of `Light` and `Dark` in Mode (from `Auto`, `Dark`). Expected:
   the whole window behind the dialog changes at once, the terminal too. Choose another `Colour
   theme`: the colours change at once. Press Ctrl+Shift+R (the page reloads; the dialog is gone):
   the window comes back in that mode and theme from its first frame. Open Settings with the gear
   again, choose the Mode and then the Colour theme written down in step 3. Expected: the window
   as before step 4.
5. **A choice saved at once.** In `Open links in` choose the other one (`Edge` or `The default
   browser`). Expected: `Saved.` beside it at once, no button pressed; in W the grep of step 1
   prints the new value (`"edge"` or `"default"`). Choose the one you wrote down again: `Saved.`,
   and the grep prints what step 1 printed (`"default"` when it printed nothing: the key stays in
   the file with its default value, which is the same).
6. **A refused address.** Write down what `Ticket address` holds. Click into it, press Ctrl+A,
   type `nope` and press Enter. Expected: beside it, in the refusal's colour, `"ticketUrl" must be
   null or an http or https address with {key} once, after its host`; the field still holds `nope`;
   in W, `grep -n ticketUrl ~/.config/skydeck/config.json` prints what it printed before (or
   nothing). Press Ctrl+A, type back what you wrote down and click on `Mode`: `Saved.` or nothing
   beside the field (when the text is what the file holds, nothing is sent).
7. **Advanced, by keyboard.** Press Tab until `Advanced (14 more settings)` has the keyboard (a
   ring around it), then Enter: it opens, `The file: <your config.json>` at its top, then the
   settings of W41. Space closes it again. Press Esc: the dialog closes and the key bar says
   `Focus: terminal`. Open Settings with the gear once more: Advanced is closed. Press Esc.
8. **The end.** The window's copy: as W41's step 6, with `w44` for `w41`. The file: when step 1
   found no `config.json`, `rm ~/.config/skydeck/config.json` (step 5 made it, holding only
   `window.links`); else, when you changed nothing else in it since step 1, `cp -p
   ~/config.json.before-w44 ~/.config/skydeck/config.json` (it was only `window.links`, and the
   value written back is the one the window uses: nothing needs a restart), then
   `rm ~/config.json.before-w44`.

Write down: for each step whether it went as expected, and the words where they differ; whether
the gear looked right, and the screen read well in your theme.

Not tried before this check was written: all of it, in Edge.

## The tour of the window

The check of the tour (follow-up F41; design-step-2.md 12.9, 12.14; [install.md](install.md),
"Using the window", its point "The tour"): W45, in your window. It changes nothing but the mark
each browser keeps that it has seen the tour. Commands are typed in W, a WSL terminal of your own
(never a `!` command inside Claude Code). The tests run the tour in headless Chromium; only here
does it meet Edge, Windows' fonts and your own list.

## W45. The tour, once per browser

Setup: skydeck updated to a commit that has follow-up F41's second version (`skydeck update`,
W32), the window closed; at least one session in the list. If this window saw the first version
of the tour, it shows it again at step 1 (the version rule); a profile that never saw it shows it
too.

1. **It starts by itself.** In W, `skydeck window`. Expected: once the list is drawn, the list
   stands out in a coloured ring, the rest of the window is dimmed, and a small panel beside it
   says `The list`, three short lines (Open, Recent and Earlier, the number 1–9), `Step 1 of 7`,
   `Skip the tour`, `Back` (greyed) and `Next`. Write down whether the ring and the panel read well
   in your theme.
2. **Walk it.** Press Enter, then →, then ←. Expected: steps 2, 3, 2: the right side, then the key
   bar (`Focus: list` or `Focus: terminal`, Ctrl+Shift+L), then the right side again, each standing
   out with its panel beside it where the window has room (in a narrow window the panel may lie over
   the region). Press Space, then Ctrl+Space, then Shift+Enter: nothing happens, the step stays
   (Space does nothing with any modifier). Press Ctrl+Shift+L: the key bar says `close the tour
   first (Esc)` and the step stays. Click a row of the list: nothing is selected. Press → until
   step 4: the list again, now with Shift+↑ Shift+↓ (move a session up or down in Open) on its
   second line. Step 5: `Switch…` stands out and the panel names Ctrl+Shift+P, Ctrl+Shift+1…9,
   Ctrl+Tab, Ctrl+Shift+J and Ctrl+Shift+N. Step 6, `After a restart`: the list, `skydeck window`
   and `> restore` (read the three sentences against install.md's "Restore after a restart"; this
   check does not restart WSL). Step 7: the gear, Ctrl+Shift+H, `Take the tour` and `> tour`, and
   `Done` in place of `Next`.
3. **Done.** Write down what the key bar says (`Focus: …`), then press Enter. Expected: the panel
   and the dimming are gone, the key bar says what it said before, a typed key goes where it went
   before (a letter into the terminal with `Focus: terminal`). Press Ctrl+Shift+R: the page
   reloads, and no tour starts. Close the window and run `skydeck window` again: still no tour
   (it kept the second version's mark).
4. **Again from the help and the switcher.** Press Ctrl+Shift+H, click `Take the tour` under the
   help's title. Expected: the help is gone and the tour shows `Step 1 of 7`. Press Esc: it ends,
   and the keyboard is back where it was. Press Ctrl+Shift+P and type `>t`: the line `Tour: a
   minute’s walk round the window, step by step`, the footer `Enter start the tour`. Press Enter:
   the switcher closes and the tour shows `Step 1 of 7`. Press Esc.
5. **A browser tab.** In W, `skydeck window --print-url`; open an InPrivate window of Edge
   (Ctrl+Shift+N in Edge itself) and paste the address into it. Expected: the tour starts by
   itself there too; at step 5 it names Ctrl+Shift+O (not Ctrl+Tab) and `+ New in the key bar`
   (not Ctrl+Shift+N). Click `Skip the tour`, then close the InPrivate window (it forgets the
   mark with everything else).

Write down: for each step whether it went as expected, and the words where they differ; your Edge
version; whether a step's words could be shorter or clearer.

Not tried before this check was written: all of it, in Edge.

## Copy on select

The check of copy on select (issue #184; design-step-2.md 9.1, 9.5, 12.13; [install.md](install.md),
"Using the window", its point "Keys", and "The `window` keys"): W46, in your window, with a real
session. It switches `Copy on select` (`window.copyOnSelect`) off and on in Settings, which writes
`config.json` (and the window's copy of it, `config.json.skydeck-backup`): both are copied aside
first and given back at the end, as in W41. Commands are typed in W, a WSL terminal of your own
(never a `!` command inside Claude Code). The tests select in headless Chromium and read its own
clipboard; only here does a selection reach the Windows clipboard through Edge, from a terminal
with Claude Code in it, for another program to paste.

## W46. A selection copied as the mouse lets go (real claude)

Setup: skydeck updated to a commit that has issue #184 (`skydeck update`, W32); the window open,
with the terminal of a session shown that has some text on its screen (any running one; no prompt
is typed into it); Notepad open beside the window.

1. **Copy the files aside.** As W41's step 1, with `w46` for `w41` in the names; write down the
   value of `grep -n copyOnSelect ~/.config/skydeck/config.json` (no line: not set, which is
   `true`). Open Settings (the gear): `Copy on select` is a switch in The window. When it is off,
   click it on (`Saved.` beside it). Close Settings with Esc.
2. **A drag.** In the terminal, drag over two or three words and let go. Nothing says that it
   copied. In Notepad, Ctrl+V. Expected: exactly those words. Double click one word in the
   terminal, Ctrl+V in Notepad: that word.
3. **A click.** Copy a word in Notepad (select it, Ctrl+C). Click once into the terminal (no drag)
   and Ctrl+V in Notepad. Expected: the Notepad word, not the terminal's: a click copies nothing.
4. **Off.** Open Settings, turn `Copy on select` off (`Saved.` beside it), close it with Esc. Copy
   a word in Notepad, then drag over other words in the terminal and let go, and Ctrl+V in Notepad.
   Expected: the Notepad word: the clipboard kept the old text. Drag over those words in the
   terminal again and, at once, without a click, press Ctrl+Shift+C; Ctrl+V in Notepad: the
   terminal's words (Ctrl+Shift+C still copies).
5. **On again.** Open Settings, turn `Copy on select` on again (`Saved.`), close it. Drag over a
   word in the terminal, Ctrl+V in Notepad. Expected: that word, with no reload of the window in
   between.
6. **The end.** When step 1 found `Copy on select` off, turn it off again in Settings (`Saved.`),
   so that the window uses the value the file gets back. The window's copy: as W41's step 6, with
   `w46` for `w41`. The file: when step 1 found no `config.json`, `rm
   ~/.config/skydeck/config.json` (the switch made it, holding only `window.copyOnSelect`); else,
   when you changed nothing else in it since step 1, `cp -p ~/config.json.before-w46
   ~/.config/skydeck/config.json`, then `rm ~/config.json.before-w46`. Nothing needs a restart.

Write down: for each step whether it went as expected, and the words where they differ; your Edge
version.

Not tried before this check was written: all of it, in Edge.

## Carry over after /clear

The check of the carry over after `/clear` (follow-up F40; design.md 7.1; design-step-2.md 12.6,
12.9; [install.md](install.md), "After `/clear`: carry over"): W47, in your window, with real
Claude Code, on throwaway sessions in a scratch folder. It writes labels, groups, tickets and done
marks of those sessions only. Commands are typed in W, a WSL terminal of your own (never a `!`
command inside Claude Code). The tests run the bar in headless Chromium against the stand-in
program; only here does it meet real Claude Code and Edge.

## W47. The bar after /clear

Setup: skydeck updated to a commit that has follow-up F40 (`skydeck update`, W32), and the window
opened at least once since (the bar shows only for a `/clear` made after that); a throwaway session
started from the New form in a scratch folder, running in a terminal of the window, with a label
(`l`), a group (`g`) and a ticket (`t`, a link such as `https://example.com/browse/TRY-1`).

1. **The bar without a click.** In its terminal type `/clear` and Enter. Expected: the terminal
   stays shown, the selected row is the new session's, and under the header a bar reads `Cleared
   from "<the label>" · TRY-1`, `label`, `group <group>`, `ticket TRY-1` ticked, `mark the old one
   done` ticked, `Carry over` and `×`. Claude Code keeps the session's name in its terminal tab.
2. **A click keeps the prompt.** Click on the `group` checkbox (it unticks), then type a letter:
   it lands in Claude Code's prompt, and the key bar says `Focus: terminal`. Delete the letter.
3. **Carry over.** Click on the group checkbox again and on `Carry over`. Expected: the bar goes,
   the header shows the label, the group and the ticket; the old session is gone from the list and
   shows again with `a` (Show done), marked done. Press `a` again.
4. **×.** Type `/clear` again, then click `×`. Expected: the bar goes; after Ctrl+Shift+R the new
   session shows no bar; `skydeck show <its short id>` in W prints no label.
5. **Two clears.** Type `/clear` twice without answering the first bar. Expected: the newest
   session's bar names the session of step 4 (it has the fields from step 3, by the label). Leave
   it unanswered.
6. **By keyboard while the list changes.** Have another session work (a prompt that takes some
   seconds) so that the list changes under you. Press Ctrl+Shift+L (`Focus: list`), `c`: the first
   checkbox has the keyboard, the key bar says `Focus: list`. Press Tab until `Carry over` has it,
   wait for the other session's state to change in the list, then Enter. Expected: the bar goes,
   and nothing was typed into Claude Code's prompt (look at its prompt line).
7. **Outside the window.** In W, in the scratch folder, run `claude`, give it a label from the
   window (`l` on its row), and type `/clear` in that terminal. Expected: in the window the new
   session's card shows the bar; `×` closes it. Exit that `claude`.
8. **An old clear.** Select one of your own sessions that was cleared out of a labelled one before
   this skydeck was installed (only look at it; press nothing on it). Expected: no bar.
9. **The end.** Exit the throwaway sessions (`/exit`) and mark them done.

Write down: for each step whether it went as expected, and the words where they differ; whether
the bar read well in your theme and changed the terminal's size only when it came and went.

Not tried before this check was written: all of it, in Edge and with real Claude Code.

## The list's width

The check of the list's width (issue #192; design-step-2.md 12.1, 12.9; [install.md](install.md),
"Using the window", its point "The list's width"): W48, in your window. It changes nothing but the
width each browser keeps for the list, and puts the default back at the end. Commands are typed in
W, a WSL terminal of your own (never a `!` command inside Claude Code). The tests drag the handle
in headless Chromium; only here does it meet Edge, Windows' pointer and your own list.

## W48. The list's width, dragged

Setup: skydeck updated to a commit that has issue #192 (`skydeck update`, W32); the window open
and maximised; a throwaway session started from the New form in a scratch folder, running in a
terminal of the window and selected.

1. **The handle.** Move the pointer slowly over the border between the list and the right side.
   Expected: on it the pointer becomes the column-resize arrow and a line in the accent colour
   marks the border; held still, the tooltip `Drag to change the width of the list. Double-click:
   back to 400 px.`
2. **A drag.** Press on the border and drag to the right, then to the left, and let go. Expected:
   the list follows the pointer as you move; it stops growing at 800 px (about twice its old width)
   and stops shrinking at 240 px; the rows' texts end in `…` where they do not fit, and no part of a
   row lies over another. Let go at a width you like. Within a moment the terminal's lines fill its
   new width (a resize of Claude Code's screen, as at a window resize).
3. **It stays.** Press Ctrl+Shift+R: the page reloads with the list at that width from the first
   moment (no jump from the old width). Close the window and run `skydeck window` in W: the same.
4. **A narrower window.** Make the list wide (near 800 px), then make the window narrower by
   dragging its edge. Expected: from the point where the right side has about 320 px left the list
   gets narrower with the window, never under 240 px; maximise the window again: the list is as
   wide as before.
5. **The keyboard stays.** Click into the throwaway session's prompt (`Focus: terminal`). Drag the
   border again, passing over the terminal and over the rows, and double-click it. Expected: the key
   bar still says `Focus: terminal`, no row was selected, nothing was typed into the prompt and no
   text is selected; a letter typed now lands in the prompt (delete it). Press Ctrl+Shift+L
   (`Focus: list`) and do the same: the key bar still says `Focus: list`, and ↓ moves the
   selection in the list (↑ back).
6. **The list's scroll bar.** With enough sessions that the list scrolls (`a` shows the done ones
   too), drag the list's scroll bar at its right edge, right beside the border. Expected: the list
   scrolls and its width does not change; the pointer shows the column-resize arrow only on the
   border itself and just right of it. Press `a` again.
7. **A dialog.** Open the settings (the gear) and try to drag the border under it: nothing moves.
   Press Esc.
8. **A browser tab.** In W, `skydeck window --print-url`, open the address in a tab of your usual
   Edge. Expected: the tab's list keeps a width of its own (400 px the first time: another browser
   profile than the window's), and a drag there leaves the window's width as it is. Close the tab.
9. **The end.** Double-click the border, letting the pointer slip a px or two between the clicks if
   your hand does. Expected: the list is 400 px wide again (as before the update); after
   Ctrl+Shift+R too. A single click on the border that slips a little changes nothing.

Write down: for each step whether it went as expected, and the words where they differ; your Edge
version; whether the handle is easy enough to find and to grab.

Not tried before this check was written: all of it, in Edge.

## Resuming with other flags

The check of resuming a session with other flags (issue #188, part 1; design.md 7.6 "Other flags";
design-step-2.md 12.6, 12.9; [install.md](install.md), "Using the window", its point "A session
that is not running"): W49, in your window, with real Claude Code, on one throwaway session in a
scratch folder. Commands are typed in W, a WSL terminal of your own (never a `!` command inside
Claude Code). The tests run it against the stand-in program, which takes any flag and shows no
model; only here does Claude Code take the flags, record its start with them and run with them.

## W49. A throwaway session resumed with another model

Setup: skydeck updated to a commit that has issue #188's part 1 (`skydeck update`, W32); the window
open. Start a throwaway session from the New form (`+ New`, or Ctrl+Shift+N) in a scratch folder:
the field `Flags for claude` empty, the field `Label` holding `flags check`, then `Start`. Once its
terminal shows Claude Code's prompt and the key bar says `Focus: terminal` (else press
Ctrl+Shift+L until it does), type `Reply with the single word ok, in this chat, with no tool and no
file.` and Enter, and wait for the answer. Throughout: type a word only where the step says the
keyboard is (the key bar names the zone; a field shows its caret). In the list a letter is a key:
`d` marks the session done, `l`, `n` and `t` open a dialog on it.

1. **The card.** Type `/exit` and Enter in its terminal, then press `Close` on the bar under it.
   Expected: its resume card, with `Resume here` and `Other flags…` side by side; "Will run" ends
   in `--resume <its id> -n 'flags check'`, no other flag; the header shows no flags.
2. **Other flags….** Click `Other flags…`. Expected: in place of the two buttons the field `Flags
   for claude`, empty (the session was started with none) and with its caret blinking in it, your
   favourite chips under it, `Start` and `resumes in this window with these flags · Esc goes back`;
   "Will run" is not shown while it is open. Press Esc: the two buttons and "Will run" are back,
   nothing started. Press Ctrl+Shift+L until the key bar says `Focus: list`, then `f`: the field
   again, its caret in it.
3. **Another model.** Only while the caret is in the field: type `--model` and a model you can use
   other than the one the session ran with (`sonnet`, say), and Enter. Expected: the session runs in
   a terminal of the window, the key bar says `Focus: terminal`; once Claude Code has started, the
   header's second line ends in `--model sonnet`. Type `/model` and Enter: Claude Code's model
   picker marks that model. Read it and leave with Esc (choosing one there changes the model, and
   it may be kept). In W, `skydeck show <its short id>` prints a launch command with `--model
   sonnet`.
4. **A plain resume keeps it.** Type `/exit` and Enter in its terminal. Expected: the bar reads
   `Resume`, `Other flags…`, `Close`. Press its `Other flags…`. Expected: the terminal goes and the
   card shows with the field open, holding `--model sonnet`, its caret in it; press Esc: the plain
   card, whose "Will run" ends in `-n 'flags check' --model sonnet`. Press `Resume here`. Expected:
   it runs again; `/model` and Enter mark the same model (leave with Esc); the header still ends in
   `--model sonnet`.
5. **The end.** Type `/exit` and Enter in its terminal, press `Close`, then `Done` in the header.

Write down: for each step whether it went as expected, and the words where they differ; the model
the picker marked in steps 3 and 4.

Not tried before this check was written: all of it, in Edge and with real Claude Code.

## Parked

The check of parking a session (follow-up F44; design.md 7.1; design-step-2.md 7.6, 12.1, 12.4,
12.9, 12.15; [install.md](install.md), "Using the window", its paragraph "Parked"): W50, in your
window, with real Claude Code, on throwaway sessions in the throwaway folder. Commands are typed in
W, a WSL terminal of your own (never a `!` command inside Claude Code). The tests park sessions of
the stand-in program in headless Chromium against a test server; only here do the keys meet Edge
and your layouts, the prompts come from the real Claude Code, and Windows shows (or does not show)
a desktop notification.

## W50. Parking throwaway sessions (real claude)

Setup: skydeck updated to a commit that has follow-up F44 (`skydeck update`, W32), then the window
open (`skydeck window`); the throwaway folder there (`mkdir -p ~/skydeck-try`). Close every other
terminal of the window first, or read the numbers below as the free ones, ascending. If a row of a
terminal of the window under Open has no number, skip W50 for now: from issue #189 that row takes a
parked session's number at once, and steps 2 to 6 and 8 would read otherwise. Throughout:
type a word only where the step says the keyboard is (the key bar names the zone, `Focus: list` or
`Focus: terminal`; Ctrl+Shift+L switches it). In the list a letter is a key: `w` parks, `d` marks
done, `l`, `n` and `t` open a dialog.

1. **Three throwaway sessions.** Three times: Ctrl+Shift+N, the throwaway folder's full path in the
   directory field (`/home/<you>/skydeck-try`), a label `park-1`, `park-2`, `park-3` in turn, Enter.
   In each, once Claude Code's prompt shows, type `Reply with the single word ok.` and Enter.
   Expected: under Open `park-1`, `park-2`, `park-3` with the numbers 1, 2, 3.
2. **`w` and the toast.** Click `park-2`, then Ctrl+Shift+L until the key bar says `Focus: list`,
   then `w`. Expected: `park-2` is under a new section **Parked**, after Open, with the mark
   `parked 0s` (later `parked 1m`) and no number; it still runs. The toast says `Parked: listed
   under Parked, and it keeps running. It comes back when you send it a prompt.` with `Undo`. The
   selection is on `park-3` (the row after it), the key bar still says `Focus: list`, the list did
   not scroll, and `park-3`'s prompt is empty (nothing was typed into it). Ctrl+Shift+2 says `no
   session in slot 2`.
3. **Undo.** Click `park-2` under Parked, Ctrl+Shift+L until `Focus: list`, then `w`: it is back
   under Open with the number 2, still selected, and no toast shows. Press `w` again and, while its
   toast shows (5 seconds), click `Undo`. Expected: `park-2` is back under Open with the number 2,
   at its place by the number, and selected again.
4. **The number taken.** With `park-2` selected, Ctrl+Shift+L until `Focus: list`, then `w` again. Then Ctrl+Shift+N,
   the throwaway folder, label `park-4`, Enter. Expected: `park-4` takes the number 2, and
   Ctrl+Shift+2 shows its terminal.
5. **A key typed is not a prompt; a prompt is.** Click `park-2` under Parked, Enter (its terminal
   shows, `Focus: terminal`), type `hello` and do not press Enter; wait 10 seconds. Expected: it
   stays under Parked, no number. Delete the word (Backspace), then type `Reply with the single
   word ok.` and Enter. Expected: within a few seconds after Claude Code takes the prompt,
   `park-2` is back under Open with the number 4 (the lowest free one), and stays selected.
6. **The command line.** In W: `skydeck park <park-3's short id>` (the id `skydeck ls` shows).
   Expected: it prints `<the id> parked`; within seconds the window lists `park-3` under Parked, no
   number; `skydeck ls` shows `parked 0s` (or more) on its row, and `skydeck show <the id>` a line
   `parked:    since <the time>`. Then `skydeck unpark <the id>`: `<the id> unparked`, and within
   seconds `park-3` is under Open with the number 3.
7. **A parked session that asks.** Click `park-1`, Enter (`Focus: terminal`), type `Use the Bash
   tool to run the command date.` and Enter, and wait until Claude Code asks for the permission
   (keep the window in front). Then Ctrl+Shift+L (`Focus: list`) and `w`. Expected: `park-1` is
   under Parked with its `asks` mark beside `parked 0s`; the title bar's `need you` count leaves
   it out; Ctrl+Shift+J says `no session needs you` (or goes to another session that needs you,
   never to `park-1`). Click another Windows program and wait 20 seconds: no desktop notification
   for `park-1`. Back in the window: select `park-1`, Enter, and refuse the permission (Esc).
   Expected: it stays under Parked (an answer to a question is not a prompt).
8. **A restart.** In W: `skydeck window --restart`. Expected: once the window is back, `park-1` is
   still under Parked with no number, the other rows keep their numbers, and Ctrl+Shift+1 says `no
   session in slot 1`.
9. **Three `w` in a row.** Click the top row of Open, Ctrl+Shift+L (`Focus: list`), then press `w`
   three times, each once the selection has moved. Expected: three sessions parked, one per `w`;
   each time the selection is on the next row of Open (on the last, the one before it; when Open
   is empty, none), the list did not jump, the key bar said `Focus: list` throughout, and no
   session's prompt holds a `w` or anything else you did not type.
10. **`w` on a row under Parked.** Make the window low (drag its bottom edge up) until the list
    scrolls, and scroll the list down so that its top (where Open is) is out of view. Click the
    middle row of Parked, then `w`. Expected: that session is back under Open with the lowest free
    number, still selected, its row scrolled into view; `Focus: list`; no toast; the other rows of
    Parked are as they were. Give the window its size back.
11. **`/clear` in a parked session.** Click a parked session that runs, Enter (`Focus: terminal`),
    type `/clear` and Enter. Expected: within a few seconds the old session is still under Parked
    (not running), and the session Claude Code goes on with is under Open with the lowest free
    number, not parked.
12. **The Czech layout.** Switch Windows to the Czech layout (W8): `w` on a row of Open parks it,
    and `w` on it under Parked un-parks it, as in steps 2 and 10. Switch back.
13. **The end.** For each throwaway session: type `/exit` and Enter in its terminal, then `d` in
    the list (`Focus: list`) to mark it done (done ends a parking too).

Write down: for each step whether it went as expected, and the words where they differ; your Edge
version and your two layouts; whether Windows showed any notification in step 7.

Not tried before this check was written: all of it, in Edge and with real Claude Code.

## How often updates are checked

The check of how often the window's server looks for a newer skydeck by itself (follow-up F38's
choice; design-step-2.md 10.1, 12.13, 16.5; [install.md](install.md), "Updating", its part "The
window says when there is one"): W51, in your window, on your own checkout and `config.json`. It
applies nothing: it picks each value of `Check for updates` in Settings' group `Updates`, waits
for one check that the clock makes, and puts the setting back. The tests run the waits with a fake
clock against a test server; only here does the check meet the real clock, your remote and your
network for a quarter of an hour. Commands are typed in W, a WSL terminal of your own (never a `!`
command inside Claude Code).

## W51. Every 15 minutes, every hour, every day

Setup: skydeck updated to a commit that has this choice (`skydeck update`, W32), then the window
open; in W, `grep -n updateCheck ~/.config/skydeck/config.json` (write down the line, or that there
is none). Throughout, the age of the last check is read in Settings' group `Updates` (the gear),
in its line `Last check: <age> ago — …`; close Settings (Esc) and open it again to read it anew.

1. **The choice.** Open Settings. Expected: the group `Updates`, after `The window`, shows `Check
   for updates` with `Every hour` when the setup found no line or `"hourly"` (`Every day` for
   `"daily"`, `Off` for `"off"`); its list holds `Off`, `Every 15 minutes`, `Every hour`, `Every
   day`, in that order. With a setup that found no line or a value other than `"off"`, the line's
   age is about the time since the window's server started (the update restarted it, and every
   start checks).
2. **Every 15 minutes.** Choose `Every 15 minutes`. Expected: `Saved.` beside it, no button
   pressed; the grep prints `"15min"`. When the line's age was 15 minutes or more, it says `Last
   check: 0s ago` (or `1s`, `2s`) within two seconds, without a click; else leave the window
   alone until 16 minutes after the age it showed, open Settings again: the age is under a minute
   or two, and `skydeck doctor`'s `update:` line says `fetched <age> ago` with the same age.
3. **Every day.** Choose `Every day`: `Saved.`, the grep prints `"daily"`. Write down the line's
   age. Twenty minutes later, open Settings again: the age has grown by twenty minutes (no check
   was made by the clock).
4. **Off.** Choose `Off`: `Saved.`, the grep prints `"off"`; `Check now` still checks (`Last check:
   0s ago — …`).
5. **Back.** Choose the value of the setup again (`Every hour` when it found no line): `Saved.`,
   and the grep prints it (`"hourly"` when the setup found no line: the key now stays in the file
   with its default value, which is the same). With `Every hour`, the line's age is under an hour
   whenever you open Settings from now on.

Leaves behind: `window.updateCheck` as it was (or in the file with its default value), the
remote-tracking refs as the checks' `git fetch` leaves them, and `kv window_update_check` with the
last check.

Write down: for each step whether it went as expected, and the words where they differ; how long
after the 15 minutes step 2's check came.

Not tried before this check was written: all of it, in Edge, with the real clock and your remote.
