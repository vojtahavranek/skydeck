# Manual checks

The short checklist to run by hand after installing skydeck on a machine, and before trusting a new
Claude Code version. It covers what the tests cannot: they never start `claude`, never open a
terminal tab, never restart WSL and never start a Windows program. Each item gives the command and
the expected result. Items 1–9 check the commands of step 1; the checks W1–W26 but W11, W16,
W19 and W21 check the window of step 2 (stage A) and start at "The window (step 2, stage A)"
below; W27–W29 check editing in the window (stage D), at "The window (step 2, stage D)"; W11, W19
and W21 check which sessions need you and the desktop notifications (stage B), at "The window
(step 2, stage B)"; W16 checks restore in the window after WSL stopped (stage C), at
"The window (step 2, stage C)"; W30, W31 and W3's icon check search, the quick switcher and the
page's icon (stage E), at "The window (step 2, stage E)"; W32 checks `skydeck update` (follow-up
F8), at "Updating skydeck"; W33 checks install's offer to turn off Claude Code's ← shortcut
(follow-up F11), at "Claude Code's ← shortcut"; W34 checks the title bar's theme switch (follow-up
F13), at "The window's theme"; W35 checks the flags a session was started with in the header
(follow-up F16), at "The flags a session was started with"; W36 checks the new form's favourite
flags (follow-up F15), at "Favourite flags".

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
  that follows the terminal (look in `/config` or `/theme`), choose it. While the title bar's theme
  switch shows `◐ Auto` (follow-up F13; click it until it does, and click it back to what it showed
  at the end), the window is dark while Windows is in dark mode and light in light mode (Settings >
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

## W9. Claude Code's symbols are drawn (real claude)

In the throwaway session, send a prompt that makes Claude Code use a tool (`list the files here`).
Its tool lines start with `⏺`, their results with `⎿`; Shift+Tab shows `⏵⏵` in the mode line.
Expected: drawn as symbols, not as empty boxes.

Write down which symbols show as boxes.

## W10. Emoji line up (real claude)

In the throwaway session: `print a table with two columns, a symbol and its name, with the rows
🙂, ❤️, 👍🏽, 👨‍👩‍👧 and 🇨🇿`. Expected: the right edges of the table's lines are in one column.
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
instead (install.md, "The `window` keys"). On a managed PC, security monitoring may record or flag
each start of `rundll32.exe url.dll,FileProtocolHandler`; `"edge"` avoids it. Part 1 needs no
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

## W13. What the company's Edge policy does to the window

In your own Edge, open `edge://policy` and look for entries named `URLBlocklist`, `BrowserSignin`,
`SyncDisabled`, or starting with `WebApp` or `Extension`. Then open a normal Edge window on the
window's own profile folder (the one `skydeck doctor` names), in P:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir="C:\Users\<you>\AppData\Local\skydeck\edge-profile"
```

In that window's address bar: `edge://extensions` (which extensions run there, put in by the
company's policy) and `edge://settings/profiles` (whether the profile is signed in and syncs its
history). Close that window afterwards; the skydeck window stays.

Write down: the policy entries found (their names and values), the extensions listed, signed in
and syncing or not.

## W14. WSL keeps running when every WSL terminal is closed

**The first form, the one that matters; it needs no script.** It needs a `.wslconfig` without
`instanceIdleTimeout=-1` (with that setting WSL never stops by itself, and the check shows nothing).
Do it while only throwaway sessions run: if the keep-alive does not hold, WSL stops and every
session in it ends (they can be resumed afterwards, as after any WSL restart).

1. In W, `skydeck doctor`: the keep-alive line reads `keep-alive wsl.exe running (pid <n>, since
   <time>); …`. Write the pid down.
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

The PC's privilege management (BeyondTrust on the development PC) must neither block nor ask for
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
  row above, which may be a real session, `d` marks the selected row done, Enter resumes or shows
  it.
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
6. `×` on the line. Expected: the line goes, and the toast says `Detached <owner>/<repo> #<n>`
   with `Undo` (leave it). Esc. The header's third line says `no pull request` and `+ PR` again,
   and `skydeck show <short id>` has no `pr:` line.

Write down: how long the state took to show; whether the dialog's line, the header, the list's
chip and `skydeck show` agreed; any `can't read`, with its error.

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
  note, `l` its label, `d` marks it done.
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
  step 2 and leave out steps 1 and 5. When you blocked them, when Edge or the company's policy
  refused, or when you do not know, do step 5 first: it shows Edge's answer. With the answer
  `Allow` there, go on with steps 2 to 4 and 6; otherwise W11 ends after step 5.

1. **The prompt.** Click `Turn on notifications`. Expected: Edge's own prompt, asking whether the
   page at `127.0.0.1:47613` (or your `window.port`) may show notifications. Choose `Allow` or
   `Block`; both are valid answers. Expected either way: the button goes. When no prompt comes and
   the button goes at once, Edge or the company's policy refused: write that down. When you close
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
  its label, `d` marks it done.
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
the design expects (design-step-2.md, section 6), not yet seen on this PC — W16 writes down what
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
  label, `d` marks it done —, and text typed while a terminal has it reaches that session's
  program. When the field shows no caret, click into it first. In the filter's field press no
  Enter: Enter gives the keyboard to the list, where the next letter is a list key. No step
  presses Enter in the switcher on a session whose short id you have not looked at.
- **One click on a row, on its title.** A double click on a session that is not running resumes
  it. These checks click only one session of a block none of whose sessions has a coloured bar at
  its left (a session that needs you and stays selected for 1.5 seconds is marked seen), a block's
  caption line, and the throwaway session's row. A session's resume card shows `Resume here`: never
  click it in these checks.
- **Leave the window as you found it.** Write down at the start what the filter holds, which chips
  are on (`Show done` among them), which blocks are closed (a card drawn as its caption alone: `▸`,
  the group's name and a number, no session under it), whether Earlier is unfolded, and your
  keyboard layout. Each check starts from an empty filter (Esc in its field) and no chip on (a click
  on each chip that is on). At the end put back what you wrote down: the filter's text typed again
  into its field (look for the caret first), each chip that was on clicked on again, each block you
  closed opened again (a click on its caption), Earlier folded or unfolded as it was, and your own
  layout (Win+Space). Fold Earlier only while the selected session is not in Earlier (a fold with
  the selection inside it selects the line above it, which may be a real session); when the
  throwaway session's row is in Earlier, leave Earlier unfolded and write that down.

## W30. Search on your own sessions (real claude)

Setup: the throwaway session selected (look at the short id in its header), the filter empty, no
chip on. Write down how many sessions the title bar counts.

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
3. **The chips.** Look at the key bar's `Focus: …` and keep it in mind. Click `Running`. Expected:
   the chip is drawn pressed, only the sessions under Open are listed, and `Focus: …` did not
   change. Click it again: it is off, the list as before. The same with `Open PR` (only the
   sessions with a pull request that is not merged or closed) and `Has note` (only those with a
   note). Then `Running` and `Has note` together: only the running sessions that have a note
   (`No session matches the filter.` when none has one); click both off. Then `Show done`: the
   done sessions show with their `done` mark and the footer says `done sessions shown · hide`;
   click it again, and the footer is `<n> done hidden · show` again (or gone when none is done).
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
   above the page): skydeck's icon, not Edge's. Since follow-up F14 the 16, 32 and 48 pixel files
   show the same picture. Expected, by place:
   - the **title bar** (the 16 pixel file at a display scale of 100 %; at 125 or 150 % Edge may
     draw it from the 32 pixel file: the same picture, sharper): a small dark navy rounded square
     filled by a blue-to-violet cloud outline with a terminal window in front of it and a light
     `>_` in the window; not crisp;
   - the **taskbar button**: which of the page's small icons Windows takes for it is not known
     (Edge may hand it the 16 or the 32 pixel one, and Windows stretches it to 24 to 36 pixels).
     Most likely the 16 pixel file stretched to about 24 pixels (F12's review 2 reading a
     screenshot of the taskbar taken before F12 (2026-11-17); not tried in Edge): the same
     picture, the cloud with the window, filling the square nearly to its edges, so that it is as
     large as the other buttons' icons, and soft at a display scale of 100 % (a stretched bitmap is
     never crisp): the cloud and the window read as shapes, the `>_` hardly. It is softer than the
     window alone that the button showed between F12 and F14: that `>_` had 22 white pixels at 16
     pixels, this one has 10. After F12 the icon seen was reported as a different icon from the
     picture; the only small file F12 made different in kind was the 16 pixel one, which is
     consistent with the button showing the 16 pixel file (not a confirmation: the report did not
     say where it was seen). If Windows takes the 32 pixel file: the same picture, sharper.
     Since follow-up F12 the drawing fills the tile; before it the same drawing sat inside a margin
     of the same navy, which on a dark taskbar is nearly invisible, so the icon looked small. Write
     down whether you see the cloud with the window, whether the picture is sharp or soft, and
     whether it is as large as the buttons beside it.

   The taskbar's look was NOT tried in Edge when F12 and F14 were made: the files were judged from
   sheets drawn with the same browser engine (Chromium), and this check is the first time they are
   seen on the taskbar. The icon before F10 was three cards, the front one white with a prompt, on
   a blue rounded square; between F10 and F12 it was the picture inside its tile; between F12 and
   F14 the 16 pixel file was the terminal window alone, with no cloud. When the button or the
   title bar still shows an earlier icon after the page reloaded itself, write it down and treat
   it as step 3 treats Edge's own icon: look again the next time the window is opened anew (do not
   close it for this check).
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
cloud with the window, or still the window alone, the icon before F14), sharp or soft, and as
large as the buttons beside it or not; whether Edge's menu offered to install the page as an app,
in its own words.

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
you asked to have turned off (2026-11-17); nothing else of yours. Its end says how to put it back.
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

1. **The question.** In W, type `skydeck install`. Expected, among its usual lines (`hook entries
   already present`, perhaps the python3 line): the three lines and the question

   ```
   Claude Code's ← shortcut is on: ← on an empty prompt sends the session to the background and opens agent view.
   ← also closes a group in skydeck's list, so a ← meant for the list can send a window terminal's session away.
   Turning it off sets only leftArrowOpensAgents in /home/<you>/.claude.json, after a backup; agent view itself stays (claude agents, /bg).
   Turn the shortcut off? [y/N]
   ```

   Read them. When the third line names a file other than your `~/.claude.json`, type `n`, write
   the path down and stop. Else type `y` and Enter. Expected:

   ```
   turned Claude Code's ← shortcut off in /home/<you>/.claude.json; the file as it was is kept in /home/<you>/.claude.json.skydeck-backup-<YYYYMMDDTHHMMSSZ>
   the shortcut is off for sessions started from now on; a session already running keeps it until it is started again
   skydeck is installed
   ```

   and `echo $?` prints `0`. Any other line about the shortcut (`… kept changing while skydeck
   wrote it …`, `could not turn Claude Code's ← shortcut off: …`, `… left … alone (…)`): write it
   down. The file is then as it was; leave out the rest of the check, and turn the shortcut off
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
   left gets no new row "running in another terminal". Only when the terminal is unchanged, press
   ← a second time (Claude Code asks for a second press in some cases, `Press ← again to open
   agents`), and look again: the same is expected.

   When agent view does take the terminal over (this branch is written from Claude Code's
   documentation, code.claude.com/docs/en/agent-view, and was not tried): press no more ←, type
   nothing into agent view's input (every prompt entered there starts a new session of its own),
   and press Esc, which goes back to the conversation. That does not end it: "Detaching never stops
   a background session", and the row is made "even when the conversation has no messages yet", so
   until it is ended the window may list a row for `skydeck-try` as running in another terminal.
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
   the ended bar shows; and when the list still shows a row for `skydeck-try` as running in another
   terminal, write that down. The shortcut stays off: that is what you asked for. Sessions you
   started before step 1 keep it until you start them again (`/exit`, then resume them).

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

The check of the title bar's theme switch (follow-up F13; design-step-2.md 12.1, 7.2, 9.3): W34,
in your own window. The switch is a small button right before `Switch…`: a half circle and `Auto`
(the window follows Windows' light or dark mode, as before), `Light` or `Dark`; each click goes to
the next, in this order: Auto → Light → Dark → Auto. **It changes one setting of the window on
purpose**: the switch's choice, which the window keeps in its own Edge profile (not in any file of
yours); the setup writes down what it shows, and the end puts it back. Steps 5 and 6 are optional:
step 5 changes Windows' mode for the whole desktop, and step 6 may change Claude Code's theme
through its own `/theme`; each says how to put it back. No step reads or writes a file of Claude
Code's (`~/.claude.json` holds your account details): its theme is looked at in `/theme`. Nothing
here sends a prompt: the only text typed into a terminal is `/theme` and `/exit`, and only into a
new throwaway session.

## W34. Light, dark or the system's (real claude)

Setup: skydeck updated to a commit that has follow-up F13 (`skydeck update`, W32); the window open,
as you work with it. Write down two things:

- what the switch shows: `◐ Auto`, `◐ Light` or `◐ Dark` (hold the mouse over it: the tooltip says
  `Theme: follows the system. Click for light.`, `Theme: light. Click for dark.` or `Theme: dark.
  Click to follow the system.`);
- Windows' mode: Settings > Personalization > Colors, "Choose your mode" (Light, Dark or Custom;
  for Custom, "Choose your default app mode").

Then click the switch until it shows `◐ Auto` (from `Light` two clicks, from `Dark` one).

1. **Auto.** Expected: the window is light while Windows' app mode is Light and dark while it is
   Dark, as before F13: the list, the header, the key bar and the terminal of the selected session.
   Before each click of this check, look at the key bar (`Focus: list` or `Focus: terminal`), and
   after it look that it says the same: a click on the switch moves no keyboard.
2. **Auto → Light.** Click the switch once. Expected: it shows `◐ Light`, and at once the whole
   window is light — the list, the header, the key bar, the scroll bars, and every terminal: a
   light background with dark text, the sixteen colours a program uses (`ls`'s, say) in their light
   variants. A program's own 24-bit colours stay as they are: a running Claude Code whose theme is
   not one of its ANSI themes keeps its own theme's colours on the light background, so some of
   its text may be hard to read until it is drawn in another theme (expected from what its themes
   are documented to be, not tried; write down what you see). Nothing else moves: the title bar's
   `Switch…` stays where it was, the selection is the same row. Select another row that has a
   terminal (one click on its row, no key), and look that its terminal is light too; click back on
   the row you had.
3. **Light → Dark.** Click it once more. Expected: `◐ Dark`, and the whole window dark, every
   terminal too, whatever Windows' mode is.
4. **It is kept.** With `◐ Dark` shown, press Ctrl+Shift+R (the page's reload, in either zone).
   Expected: the page loads again dark from its first frame — no frame of the page in light while it
   loads — and the switch shows `◐ Dark`. Then close the window with its × (closing the window ends
   no session) and, in W, `skydeck window`. Before the page's first frame Edge shows its own empty
   window, in Windows' mode: with Windows in Light mode it may be light for a moment, which is
   Edge's and not the page's (the page cannot change it). Expected: the page itself is dark from its
   first frame, `◐ Dark`. Write down, for each load, whether anything flashed light, and which it
   was: Edge's empty window (nothing of the page in it), or a frame of the page (its title bar or
   its list in light).
5. **Optional: Windows' mode.** Only when you may change it for a minute: in Settings >
   Personalization > Colors set the app mode to the other one (Light ↔ Dark). Expected while the
   switch shows `◐ Dark`: the window stays dark. Click the switch once (**Dark → Auto**): it shows
   `◐ Auto`, and the window follows Windows' mode of the moment. Set Windows' mode back to what you
   wrote down: at `Auto` the window follows at once. Then click once more (**Auto → Light**): the
   window is light whatever Windows says.
6. **Optional: Claude Code's theme.** This step needs Claude Code's theme to be "Auto (match
   terminal)"; the setting is looked at in a throwaway session.
   - **A new throwaway session.** Click the switch until it shows `◐ Light` (from `Dark` two
     clicks, from `Auto` one). In the window press Ctrl+Shift+N. The right side shows the form for
     a new session, its first field the directory, with the cursor in it; when the form does not
     show, or the cursor is not in that field, type nothing: press Ctrl+Shift+N again, or click
     into the field. Press Ctrl+A in the field, type the throwaway folder's full path over its text
     (`/home/<you>/skydeck-try`), leave the other fields empty, and press Enter only when the field
     holds exactly that path. **Type no prompt into the new session.** Look that it is the new one:
     the header shows its short id and "opened" a moment ago, `skydeck-try` as its folder, and its
     terminal shows Claude Code's empty prompt. Look that its terminal has the keyboard: the key bar
     says `Focus: terminal` (else Ctrl+Shift+L until it does).
   - **Its theme.** Only then type `/theme` and Enter. Claude Code shows its themes, the current
     one marked; write down its name. When the list has no "Auto (match terminal)" (an older
     Claude Code), press Esc and leave out the rest of this step but its end. When the current one
     is "Auto (match terminal)", press Esc. When it is another one, either press Esc and leave out
     the rest of this step but its end, or choose "Auto (match terminal)" for this step (it is then
     your Claude Code's theme until you choose yours again, at the end of this step).
   - **What it picked, and a switch while it runs.** Expected: Claude Code draws its light theme
     (dark text on the light terminal). Now click the switch once (**Light → Dark**): the terminal
     turns dark at once. What Claude Code does then is not documented: its documentation (read
     2026-11-18) says only "Selecting the auto option detects your terminal's light or dark
     background, so the theme follows OS appearance changes whenever your terminal does", not how
     or when it detects. It may keep its light theme (skydeck tells a running program the new
     colours only when it asks again) or change to its dark one; wait a few seconds, then write
     down which it does. Then end it: the terminal has the keyboard (`Focus: terminal`) and the
     header shows the throwaway session's short id; type `/exit`, then `Close` on its ended bar.
     Start a second throwaway session the same way (the form, the path, no prompt), with `◐ Dark`
     shown. Expected: Claude Code draws its dark theme from its start (expected, not tried).
   - **The end of this step.** Look that the header shows the throwaway session's short id and the
     key bar says `Focus: terminal` (else Ctrl+Shift+L until it does). When you chose "Auto (match
     terminal)" above, type `/theme` and Enter, choose the theme you wrote down, then `/theme` once
     more: it is marked as the current one; press Esc. Then type `/exit`, and `Close` on its ended
     bar.
7. **The end.** Click the switch until it shows what you wrote down in the setup, and look that the
   window is as it was. Windows' mode is as the setup wrote it down (step 5 put it back), and
   Claude Code's theme is the one `/theme` showed in step 6 (its end put it back).

Write down: for steps 1 to 3 whether the window and its terminals were wholly light or dark, what
a running Claude Code looked like on the light background, and whether the keyboard stayed where
it was; for step 4, for the reload and the new window, whether anything flashed light and whether
it was Edge's empty window or a frame of the page, and what the switch showed; for step 5, whether
the window followed Windows at `Auto` and not at `Dark` or `Light`; for step 6, Claude Code's theme
in `/theme`, the theme it drew in each new session, and whether the running one changed after the
switch.

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
as it is: the check never clicks the × of a chip whose text is not the check's own. Steps that
type a command are typed in W, a WSL terminal of your own (never a `!` command inside Claude
Code).

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
   again, or click into Directory, and look again). Leave the label and the group empty. Click
   the chip `--verbose --model sonnet`. Expected: the flags field holds exactly `--verbose --model
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
7. **The end.** End the throwaway session: click its row in the list (the folder `skydeck-try`,
   the short id of step 3) and look at the header's short id; look that its terminal has the
   keyboard (the key bar says `Focus: terminal`; else Ctrl+Shift+L until it does); type `/exit`
   and Enter, then `Close` on its ended bar. Then remove the check's favourite: Ctrl+Shift+N, look
   that the right side shows `New session`, point at the chip `--verbose --model sonnet` (its
   text, never one of yours), click its ×, and press Esc (the form shows) without clicking `Undo`.
   The chips are then those of the setup.

Write down: the favourites of the setup (how many, their texts); for each step whether it went as
expected; the `launch:` line of step 4; anything that differs, and where.

Not tried before this check was written: all of it, in Edge. The tests run the form in headless
Chromium against a stand-in server, and the server on test databases; they never start `claude`.
