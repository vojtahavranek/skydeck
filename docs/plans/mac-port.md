# Porting skydeck to macOS: a plan for an AI coding agent on a Mac

You are an AI coding agent (Claude Code) running on a Mac, in a clone of this repository, and your
human said "read `docs/plans/mac-port.md` and start working on it". This file is your whole brief.
Follow it literally; where it is silent, do the safe thing named in part 10 (stop that task, write it
into the status file, go on with what does not depend on it).

The plan was written against `main` at commit a9d6f06. Every file, function and constant it names
was checked there. Names and lines drift: find each by searching for its name (your search tool,
or `grep -rn "<name>" src bin web test`; `rg` may not be installed on a Mac).
Where the code at your commit says something else, the code wins: write the difference into the
status file and go on.

Two words are used with care. **KNOWN**: read in the code, or a stable, documented property of
macOS. **EXPECTED**: believed, but never seen on a Mac. Step 0 (part 4) or a test on the Mac
confirms or refutes each EXPECTED; one that proves false stops only the tasks that rely on it.

## 1. What this is, and who does what

The goal, in a user's words: skydeck works on a Mac as it does on WSL. First the command line
(sessions show as running, busy, waiting or idle; labels, resume and restore work), then the window
in Chrome, then restore after a restart. On Linux and WSL nothing changes.

- **You** build and test on this Mac, and open pull requests from a fork in your human's GitHub
  account against `main` of the repository this clone came from (its `origin`). One pull request
  per stage (part 7). You never merge, and you never wait for a merge.
- **Your human** answers the questions of part 2 once, at the start, then leaves you to work for
  many hours. At the end they do a hands-on check of about fifteen minutes, with you guiding
  (part 9): only a person can install skydeck for real, open its window and press keys.
- **The maintainer** reviews and merges. GitHub's checks decide: the Linux jobs that exist today,
  and the macOS job you add at the end of M1.

Read first, in this order: `AGENTS.md` part 2 (the rules of the code; part 1, with its "Darwin:
STOP", is about installing skydeck and does not apply to this work); `docs/design.md` sections 2
(principles), 5 (recording: the hook, ingest, reconcile, the liveness rule) and 14 (Claude Code
behaviour); the sections of `docs/design-step-2.md` each stage names. Never follow
`docs/manual-checks.md`: it is the maintainer's checklist and can uninstall skydeck.

## 2. Before you start

### 2.1 Checks, all read-only

Run this first, before any command of yours (no `git`, no `python3`, no `npm` before it): if
Apple's developer tools are missing, `/usr/bin/git` and `/usr/bin/python3` are only stubs that
open an "install the developer tools" window, and the probe never runs them.

```sh
sh scripts/mac-probe.sh
```

It changes nothing (part 4.1 says what it reads). Read its output, then check, and STOP where it
says so (tell your human what is missing and the command that fixes it; never run that command
yourself):

- `this is a Mac: yes`. Otherwise STOP: this plan is for a Mac.
- `developer tools: found`, and `python3` and `git` show a version. STOP when they say "only
  Apple's stub": the suite runs `/usr/bin/python3` and `/usr/bin/git`, which would then open the
  install window. Print for your human: `xcode-select --install`.
- `python3` 3.9 or newer, from the developer tools or Homebrew. The window's terminals need it.
- `node` 24.12 or newer. Otherwise STOP and print for your human: install Node.js 24 from
  nodejs.org, or `brew install node@24` if they use Homebrew.
- `claude` shows a version. Otherwise the fact run of part 4.2 is left to the hands-on check;
  go on.
- `gh` shows a version, and `gh auth status` says it is logged in to github.com, with the token
  scopes `repo` and `workflow` (GitHub refuses a push that changes `.github/workflows/` without
  `workflow`, and M1's last task does). Otherwise STOP and print `gh auth login`, or `gh auth
  refresh -s workflow`, for your human.
- A Chromium-family browser is found (`Google Chrome: in /Applications` is the default this port
  uses). Without one, M1 and M2a go on; tell your human that M2b's hands-on check needs Chrome.

Then run `git remote -v` and `git status`: `origin` must be the repository on github.com and the
tree clean (a changed tree is your human's work in progress: STOP and ask), and `git fetch origin`
then `git show origin/main:scripts/mac-probe.sh` must work (this plan is on `main`; without it
your branches would start from a `main` without the plan).

### 2.2 The questions, asked once

Ask your human all of these in ONE message, and wait for the answers. Then work without asking
again until part 9 or part 10 tells you to.

1. **The fork.** "May I fork this repository into your GitHub account `<login>` (`gh repo fork`),
   push branches there and open pull requests from it against the original? Everything I push is
   public text: I will write no name, user name, machine name, path or employer into it." (Take
   `<login>` from `gh api user --jq .login`.)
2. **Many hours.** "May I work unattended for up to 20 hours? Please keep the Mac plugged in with
   the lid open, and run `caffeinate -i` in a terminal tab of your own (Ctrl+C ends it), so that it
   does not sleep. If Claude Code asks you to allow each command, I cannot work unattended:
   please allow, for this session, edits of files in this clone and these commands: `sh`, `npm`,
   `npx` (`npx playwright install chromium` downloads about 150 MB into
   `~/Library/Caches/ms-playwright`), `node`, `git`, `gh`, `python3`, `perl`, `ps`, `sysctl`,
   `sw_vers`, `vm_stat`, `lsof`, `mktemp`, `rm -r` of the folders I make under `/tmp`, and `claude`
   for question 3 only. If Claude Code stops for a usage limit, tell me 'go on' when it is back:
   I resume from my status file."
3. **The facts only your Claude Code can show** (part 4.2). "May I start Claude Code once, scripted
   (`claude -p`, at most twice in all: once now, once near the end), in a throwaway folder, with
   a throwaway hook that records only the NAMES of what a hook receives? Each run costs one tiny
   prompt to the smallest model (a cent or less), takes at most two minutes, reads none of your
   settings files and starts none of your own hooks (hooks an administrator set through managed
   settings, if any, run as on every start). It leaves nothing behind but what Claude Code writes
   on every start, such as its own state file `~/.claude.json`."
4. **The end.** "At the end, will you do a hands-on check of about fifteen minutes with me (install
   skydeck for real, open its window, press some keys, and once restart the Mac)? Without it the
   window's look and keys stay unchecked."

A no to 1 or 2: STOP (you cannot deliver). A no to 3: leave the hook facts to the hands-on check
(part 9). A no to 4: say in the final report what stayed unchecked.

## 3. Hard rules

On your human's machine (it holds their real Claude Code sessions and their work):

- Work only inside this clone (switch branches in it; no second checkout), the suite's
  sandboxes (`test/helpers/`), and folders you make with `mktemp -d` under `/tmp` (the fact run of
  part 4.2, a pull request's body), which you remove when done. Reason: everything else is your
  human's.
- Run code only through the suite: `npm test`, `npm run test:page`, single test files, and the
  commands of part 8. Never run `bin/skydeck` or `node src/...` outside a test, not even with
  `--help`: the launcher writes a cache into `~/.cache/skydeck`, most commands read the real
  `~/.claude`, and `install`, `window`, `update` and `uninstall` change the real installation.
  Reason: a test's sandbox has its own home; your human's does not.
- Never edit Claude Code's settings files (`~/.claude/settings*.json`, `.claude/settings*.json` of
  a project) or `~/.claude.json`, and never read a transcript (`~/.claude/projects/`). Reason: they
  hold your human's settings and conversations.
- Never start, stop or signal a Claude Code session, except the scripted runs of part 4.2 (at
  most two). Never `kill`, `pkill` or `killall` by name or pattern; signal only process ids you
  started yourself. Reason: your human's sessions run under the same user.
- Never start a program with a window: not Chrome, not `open`, not `skydeck window`. The page
  tests use Playwright's headless Chromium, which is fine. Reason: an unattended window or browser
  tab on your human's screen is a surprise, and can act on their real profile.
- No `sudo`, no global install (`npm install -g`, `brew install`, `pip install`), no remote script
  piped into a shell: print such a command for your human. Reason: those change the machine.
- Never push to `main`, never force-push, never merge, never delete a branch you did not create.
  Push only to your fork. Reason: the maintainer owns `main`, and pull requests are squashed there.
- Everything you push is public: code, commit messages, pull requests, comments. No person's name,
  user name, employer, machine name, home folder, e-mail address or path of this Mac in any of it;
  example values use `example.com`, `/Users/you`, `ABC-123`. Before every push, search the diff
  for your human's user name, home folder and machine name (`whoami`, `$HOME`, `hostname`):
  `git diff origin/main...HEAD | grep -i "<each>"` must print nothing.
- From the hands-on install on (part 9), never switch branches or change files in this clone until
  your human has run `skydeck uninstall`. Reason: the installed hook and command run this clone's
  code, in every session your human starts.

On the code:

- Everything specific to an operating system lives in `src/platform/` or behind it (the hook and
  the keeper are sh and python files: their system checks stay in them, at one place each).
- Checks are by capability (a file that exists, a program that answers), not by a platform name.
  `src/platform/real.ts` decides once whether this is a Mac (no readable `/proc/self/stat`, and
  `sysctl -n kern.bootsessionuuid` answers) and offers that as a fact of `Platform`, with what
  follows from it (e.g. the socket path limit); code outside `src/platform/` asks those facts (or
  is given them by its caller), never `process.platform`. The hook and the keeper decide the same
  way, by what they can read.
- Any new member of `Platform` or `Proc` is optional, its absence meaning "as on Linux", so that
  no fake in the existing tests must change.
- **LINUX AND WSL BEHAVE EXACTLY AS BEFORE.** Every branch you add is taken only where the Linux
  capability is missing. The existing tests stay green and untouched, with two exceptions: a test
  may be skipped on a Mac with its reason named (with the smallest edit that lets the skip work,
  part 5, M1 task 1), and a test whose expected text says that macOS is not supported changes with
  that text.
- No runtime dependency (Node.js's own modules only); Node.js 24.12 or newer; python3 3.9 or
  newer (the developer tools' python3 is 3.9). No new dependency of any kind.
- The words a user reads are plain, and true on the system they read them on.
- A change in behaviour updates the design (`docs/design.md`, `docs/design-step-2.md`) and the
  guide (`docs/install.md`) in the same pull request (`AGENTS.md` part 2).

## 4. Step 0: the facts only a Mac can tell

### 4.1 The probe

`sh scripts/mac-probe.sh` (you ran it in 2.1). It prints, masked so that the output can go into a
public pull request: macOS and program versions (never running Apple's stubs), which python3
facts the keeper needs (`SO_PEERCRED`, `getpeereid`, `sysctlbyname`), BSD `date`'s answer to
`+%s%N`, the form of `kern.bootsessionuuid`, `ps -o lstart=` and whether it is stable, the cost of
one `ps` call and of a snapshot of all processes, the names of the `CLAUDE*` variables in your own
environment, and the field names and value forms of your own Claude Code's live-session file
(`<Claude Code's folder>/sessions/<pid>.json`), with the one answer M1 hangs on: `procStart equals
ps lstart: YES` or `NO` (read in UTC, as skydeck will), and the same in local time. It finds your
own file by walking up the parents of its shell; when it says "no Claude Code among this script's
parents", it reads the newest three files instead (still masked): note that in the facts.

### 4.2 What a hook receives: one bounded run of Claude Code

Only with a yes to question 3 of 2.2. The probe cannot see a hook's environment; one scripted run of
Claude Code shows it. The run is bounded so that it cannot touch your human's settings or sessions:

- `--restricted` (Claude Code 2.1.248 or newer; documented in Claude Code's CLI reference):
  Claude Code reads only managed settings and the `--settings` file, so neither your human's
  settings files nor their own hooks are used, and the tools that run commands are removed;
  `--tools ""` removes the others. `--strict-mcp-config` with
  an empty `--mcp-config` starts no MCP server.
- `--settings <file>`: a throwaway settings file whose only content is a `SessionStart` and a
  `SessionEnd` hook, a script that writes the NAMES of what it receives into the run's folder.
- `--no-session-persistence`: no transcript is saved. `--max-turns 1`, `--max-budget-usd 0.05`,
  `--model haiku`: one short answer from the smallest model, a cent or less.
- `env -i` with only `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `TMPDIR`, `LANG` (and
  `CLAUDE_CONFIG_DIR` when it is set): the run does not inherit your own session's `CLAUDE*`
  variables, which a hook would otherwise see too (a hook inherits Claude Code's environment).
- At most two minutes (`perl -e 'alarm 120; exec @ARGV'`), in a folder of its own under `/tmp`.

First check that `claude --help` lists `--restricted`, `--settings`, `--strict-mcp-config`,
`--tools`, `--max-turns`, `--max-budget-usd` and `--no-session-persistence`. If one is missing, do not run
anything: leave the hook facts to the hands-on check (part 9) and write why into the status file.

Make the folder, the hook, the settings file and the run script (one block, as it is):

```sh
facts=$(mktemp -d /tmp/skydeck-facts.XXXXXX)
cat >"$facts/hook.sh" <<'EOF'
#!/bin/sh
# Records what a hook receives: names, forms and yes/no only, never a value.
{
  echo "event: $1"
  echo "CLAUDE* variable names:"
  awk 'BEGIN { for (k in ENVIRON) if (k ~ /^CLAUDE/) print "  " k }' | sort
  perl -MJSON::PP -e '
    local $/; my $j = decode_json(<STDIN>);
    print "input field names:\n"; print "  $_\n" for sort keys %$j;
    my $s = $ENV{CLAUDE_CODE_SESSION_ID};
    print "CLAUDE_CODE_SESSION_ID equals session_id: ", (defined $s && $s eq ($j->{session_id} // "") ? "yes" : "no"), "\n";
    my $e = $ENV{CLAUDE_CODE_ENTRYPOINT} // "(not set)";
    print "CLAUDE_CODE_ENTRYPOINT: ", ($e =~ /\A[a-z-]{1,20}\z/ ? $e : "(other)"), "\n";'
  pid=${CLAUDE_PID-}
  case $pid in
    '' | *[!0-9]*) echo "CLAUDE_PID is a number: no"; pid=0 ;;
    *) echo "CLAUDE_PID is a number: yes" ;;
  esac
  name=$(ps -o comm= -p "$pid" | sed 's#.*/##')
  case $name in claude | node) ;; *) name="(other)" ;; esac
  echo "command name of CLAUDE_PID: $name"
  parent=$(ps -o comm= -p "$PPID" | sed 's#.*/##; s/^-//')
  case $parent in sh | bash | zsh | dash) ;; *) parent="(other)" ;; esac
  echo "the hook's parent: $parent"
  echo "ps lstart of CLAUDE_PID, masked: [$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" | sed 's/[A-Za-z]/a/g; s/[0-9]/9/g')]"
} >"$(dirname "$0")/$1.txt" 2>&1
exit 0
EOF
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"sh %s/hook.sh SessionStart","timeout":5}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"sh %s/hook.sh SessionEnd","timeout":5}]}]}}\n' \
  "$facts" "$facts" >"$facts/settings.json"
cat >"$facts/run.sh" <<'EOF'
#!/bin/sh
cd "$1" || exit 1
set --
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then set -- CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"; fi
env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" PATH="$PATH" TMPDIR="$TMPDIR" \
  LANG="${LANG:-en_US.UTF-8}" "$@" perl -e 'alarm 120; exec @ARGV' \
  claude -p "Reply with the single word ok." --restricted --settings "$PWD/settings.json" \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" --max-turns 1 \
  --max-budget-usd 0.05 --no-session-persistence --model haiku </dev/null >answer.txt 2>&1
echo "claude ended with $?"
EOF
sh "$facts/run.sh" "$facts"
```

Then read `$facts/SessionStart.txt` and `$facts/SessionEnd.txt` (not `answer.txt`: it is Claude
Code's answer or its error, which may name the account; read only whether it is the word `ok`).
Copy the facts into the status file (your notes), then `rm -r "$facts"`; their forms go into
"Facts found on a Mac" below in the first pull request.

- What it starts: one `claude -p` that answers once and exits, and the two hook runs. No MCP
  server, no tool, nothing of your human's settings.
- What it leaves: nothing of its own once `$facts` is removed. Claude Code may update its own
  state in `~/.claude.json` and `~/.claude/` as it does on every run (EXPECTED); you never edit
  them.
- If Claude Code cannot log in this way (some logins live in the user settings that
  `--restricted` leaves out), the run fails after the `SessionStart` hook has run (EXPECTED):
  `SessionStart.txt` alone settles most facts. Do not retry with the user settings.
- If `SessionStart.txt` is missing, the hooks did not run in this mode: write that down and leave
  the hook facts to the hands-on check.

What it settles: whether `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_ENTRYPOINT` are
set in a hook on a Mac (the hook relies on all three: `bin/skydeck-hook`), whether `CLAUDE_PID` is
the `claude` process, the input's field names, and that the hook's parent is a shell. In M3 you run
it once more, with one line added to the hook (M3, task 2).

### 4.3 How each open question is settled

| Open question | Settled by |
|---|---|
| The form of `procStart` in Claude Code's live-session file on a Mac (EXPECTED: the text of `ps -o lstart=` under `LC_ALL=C TZ=UTC`, like `Thu Nov  5 09:12:33 2026`, two spaces before a one-digit day) | the probe: `procStart (text): [...]` and `procStart equals ps lstart` |
| `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` in a hook on a Mac | the fact run (4.2); else the hands-on check |
| `kern.bootsessionuuid`: present, a UUID, its case (EXPECTED: upper case) | the probe |
| BSD `date +%s%N` (EXPECTED: no nanoseconds; prints a literal `N`) | the probe: `date +%s%N: [9999999999A]` means no |
| The cost of `ps` | the probe: `ps cost`, `ps snapshot cost` |
| python3's `SO_PEERCRED` (EXPECTED: missing), `getpeereid`, `sysctlbyname` | the probe |
| How many tests fail on a Mac, and why | M1 task 1 |
| Exact arguments of a running process (EXPECTED: through `sysctl` `KERN_PROCARGS2`) | M3 task 2, with the fact run |
| Chrome's Ctrl+click, Ctrl+Tab, Cmd shortcuts in an app window; Option on your human's layout; notifications; the Dock icon and title | the hands-on check (part 9); misses go into the report |
| Whether `kern.bootsessionuuid` changes with a restart (EXPECTED: yes) and not with a logout | the hands-on check (restart); logout is a known limit (6.7) |
| Whether macOS asks for permissions when a session in the window works in `~/Documents` or `~/Desktop` | the hands-on check; report what appeared |

### Facts found on a Mac

(Empty until the first pull request. Write here, as forms and yes/no only: macOS and program
versions; the probe's answers for `date`, `kern.bootsessionuuid`, `ps lstart`, the python3 facts,
`vm_stat`, the `ps` costs; the field names and forms of the live-session file and both `procStart
equals ps lstart` answers; from the fact run, whether `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_ENTRYPOINT` and `CLAUDECODE` are set (not the whole list of names, which can tell
about your human's setup), the input's field names and the yes/no answers. Nothing personal: no
path, no name, no value.)

## 5. The stages

In order: M1, M2a, M2b, M3. The window needs the command line's process facts (the server refuses
to start without its own process start and a boot id: `ownLine` in `src/window/server.ts`; a
keeper exits before it binds its socket without them: `main` in `bin/skydeck-keeper`).

Every task below is test first: write the tests it names, run them and see them fail on the Mac,
then write the code. A test of Mac behaviour that can also run on Linux runs there with stand-ins
(sh scripts written into the sandbox's `bin`, as `test/bin/hook.test.ts` writes a stand-in `date`);
a test that needs the real Mac (real `ps`, `sysctl`, a real keeper) is skipped elsewhere with the
reason "needs a Mac".

### M1: the command line on a Mac

Goal: after `skydeck install` on a Mac, `skydeck ls` shows each session as running, busy, waiting or
idle, `show`, labels, groups, notes, `resume` and `restore` work, and `doctor` tells the truth.

**Task 1: the suite tells the truth on a Mac.** Run the whole suite on the unchanged code (part 8's
commands). On a Mac, run the tests with `TMPDIR=/tmp` in front: the sandbox's root is made under
the system's temporary folder (`sandbox` in `test/helpers/sandbox.ts`), and the default one on a
Mac (`/var/folders/…`) makes a terminal's socket path in it longer than a Mac allows (103 bytes;
KNOWN). Then sort every failing test into one of three kinds:

- (a) The test itself assumes Linux, for a reason that is not the product's: it reads `/proc`
  itself (e.g. `bootId()` in `test/bin/hook.test.ts`, the top of `test/bin/keepalive.test.ts`),
  needs GNU options, or tests WSL's keep-alive script. Skip it on a Mac, with the reason.
- (b) The product does not work on a Mac yet (e.g. the server refuses to start without a boot id).
  Skip it on a Mac with the reason "port: until M1" (or M2a, M2b, M3: the stage that makes it
  pass).
- (c) Anything else: find out why. A real bug is fixed (with its own test) or written into the
  status file for the maintainer; never skipped silently.

Rules for skips, so that they hide nothing:

- One helper decides them: add `test/helpers/mac.ts` with `onMac(reason: string): string | false`
  (the reason on a Mac, `false` elsewhere), used as `test('…', { skip: onMac('…') }, …)`, the idiom
  `test/bin/launcher.test.ts` already uses for its own skips, and `needsMac(): string | false` for
  your new tests that need a real Mac ("needs a Mac" elsewhere, `false` on a Mac). It is the only
  place a test names the platform. On Linux every `onMac` skip is `false`: the Linux counts stay
  those of `main` plus your new tests (part 8).
- Skip single cases, not files, unless a file cannot even load on a Mac (then the whole file, with
  the reason). A file that reads `/proc` when it loads (the top of `test/bin/keepalive.test.ts`
  reads the boot id) needs the smallest edit that lets a skip work: move that read into a function
  its cases call. Nothing else of an existing test changes.
- Every skip is listed in the status file: file, case, kind, reason, the stage that takes it out.
  `grep -rn "onMac(" test test-page` and the list must agree.
- At the end of every stage, take out each "port: until <this stage>" skip; the case must pass.

Done when the suite on the Mac is green with every failure skipped and listed, and the facts of
part 4 are in "Facts found on a Mac".

**Task 2: one parser of a Mac process start.** In `src/claude/procstat.ts` (pure, beside
`procStartFromStat`), add `procStartFromLstart(text: string): number | null`: the text of `ps -o
lstart=` under `LC_ALL=C TZ=UTC` (`Www Mmm dd hh:mm:ss yyyy`, a one-digit day after two spaces,
trimmed at both ends) to whole seconds since 1970, read as UTC; null for anything else, including a
weekday that does not match the date. It is the ONLY place that reads this text (decision 6.1).
Tests first (they run on Linux too): a one-digit and a two-digit day, the end of a year, 29
February, every month name, a wrong weekday, extra words, an empty text, a time out of range.

**Task 3: a live-session file's `procStart` on a Mac.** In `src/claude/live.ts`, `procStartOf`
accepts that text too, through `procStartFromLstart`; the digits of Linux stay as they are. Tests
first in `test/claude/live.test.ts`: a made-up Mac live-session file (the form from the facts, made
up values) gives the seconds; every existing case is unchanged.

**Task 4: the process facts on a Mac.** `Proc` (`src/platform/types.ts`) is synchronous and its
Linux implementation `realProc` (`src/platform/real.ts`) reads `/proc`. Add a second
implementation beside it, built on a function that runs a program synchronously (`spawnSync`, a
time limit of two seconds, absolute paths `/bin/ps` and `/usr/sbin/sysctl` (where a Mac keeps them;
the probe's `ps` and `sysctl` lines show it), `LC_ALL=C TZ=UTC`), and choose it in `realPlatform`
by capability: `realProc` when `/proc/self/stat` can be read (Linux,
unchanged), the new one when it cannot and `sysctl` answers `kern.bootsessionuuid`, `realProc` as
today otherwise. Shape its answers like Linux's (decision 6.1):

- `bootId()`: `sysctl -n kern.bootsessionuuid`, trimmed, in lower case, read once per process.
- `stat(pid)`: `ps -o ppid=,lstart= -p <pid>`; no such process gives null; otherwise a line shaped
  like `/proc/<pid>/stat` whose field 4 is the parent and field 22 is `procStartFromLstart` of the
  start (`procStartFromStat` and `parentPidFromStat` read only those two fields: check with `grep
  -rnE "procStartFromStat|parentPidFromStat|proc\.stat\(" src` before you rely on it). `ps -p
  <pid>` for a process that does not exist exits 1 and prints nothing (EXPECTED; a test on the Mac
  shows it): that alone is "no such process". No `ps`, a time-out or any other answer throws.
- `cmdline`: null in M1 (decision 6.3). `memAvailableMb`, `fdTarget`, `tcpListening`: null until
  M3; each already degrades: restore counts unknown memory as enough, the window shows no tty, and
  doctor says what holds the port is not known.
- `kernelRelease()`: `sysctl -n kern.osrelease`.
- Keep `Proc`'s contract (its comment in `types.ts`): `bootId` and `stat` return null only when the
  fact does not exist (no such process), and throw any other failure.

Measure the cost: the window's tick asks `stat` for every session every second (`src/window/tick.ts`;
`holderPlace` in `src/window/mapping.ts` walks up to eight parents, two `stat` calls each), and a
synchronous call holds the server's event loop while it runs. Use one `ps` per call first. If the
probe's cost times the calls of one tick with twenty sessions is more than about 200 ms, answer
from one snapshot of all processes (`ps -A -o pid=,ppid=,lstart=`) taken at most once a second,
inside the new `Proc` only; a pid the snapshot does not hold is asked by itself (`ps -p`) before it
counts as gone, so that a process started after the snapshot is never taken for dead.

Tests first: with a made-up runner on Linux (every answer shape: a process, none, a `ps` that
fails, a `sysctl` that is missing); and on the Mac with the real programs, for the test's own
process (its parent is `process.ppid`; its start is within the last day; two calls agree) and a pid
that does not exist.

**Task 5: the hook on a Mac.** `bin/skydeck-hook` reads `/proc` and `date +%s%N`. Give it a second
path, taken only when `/proc/sys/kernel/random/boot_id` cannot be read (Linux runs exactly today's
lines):

- the time: `date +%s%N` when it prints only digits; otherwise the source the facts showed works,
  in nanoseconds without a floating-point step: `perl -MTime::HiRes=gettimeofday -e '($s, $u) =
  gettimeofday; printf "%d%06d000", $s, $u'`, or zsh's `EPOCHREALTIME` with its dot removed and
  `000` appended;
- the process start: a new spool key `lstart=` with the text of `LC_ALL=C TZ=UTC ps -o lstart= -p
  "$CLAUDE_PID"`, as it is (the hook interprets nothing: design 5.1);
- the boot id: `sysctl -n kern.bootsessionuuid`, as it is;
- no `argv_b64` (decision 6.3).

On this path the hook calls `ps`, `sysctl` and `perl` by name, with `/bin:/usr/sbin:/usr/bin`
appended to its `PATH` (so that they are found even where a user's `PATH` lacks `/usr/sbin`,
and so that a test's stand-ins, first on the sandbox's `PATH`, are the ones it runs).

In `src/claude/hookinput.ts` (`parseSpoolFile`), read `lstart` through `procStartFromLstart` when
`stat` is empty (the hook always writes the `stat=` line), and take the boot id in lower case (on
Linux it already is). Old readers ignore the new key (unknown keys are ignored). For tests on
Linux, let the hook take its `/proc` folder from `SKYDECK_TEST_PROC` when it is an absolute path,
as `bin/skydeck-keepalive` does; a test points it at an empty folder and writes stand-ins of `ps`,
`sysctl`, `date` and `perl` into the sandbox's `bin` (`sandbox.link` finds programs only in
`/usr/bin` and `/bin`, and `sysctl` is in `/usr/sbin`). Update the hook's header and
`docs/design.md` 5.1 ("only sh builtins plus …": on a Mac also `ps`, `sysctl` and the time
source). Tests first in `test/bin/hook.test.ts` (Mac path, on Linux with stand-ins and on the
Mac for real) and `test/claude/hookinput.test.ts`. Measure the hook on the Mac: `SessionEnd` hooks
share about 1.5 s (design section 14).

**Task 6: liveness end to end.** With tasks 2 to 5, a session's start from the hook, from its
live-session file and from `Proc.stat` must be the same number, or every session shows as not
running (`isAlive`, `isLiveFileTrusted` in `src/claude/live.ts`). Test it on the Mac end to end: the
real hook (Mac path) with `CLAUDE_PID` set to a process the test started, ingest, then `isAlive`
true; and a made-up live-session file with that process's real `ps` text, then `isLiveFileTrusted`
true. Also: a reboot is seen (a second boot id), `checkResumable` (`src/sessions/resume.ts`)
refuses a session that runs. Done when `skydeck ls --json` in a test sandbox shows the right states
for stand-in sessions.

**Task 7: install and doctor on a Mac.** `skydeck install` refuses where there is no boot id
(`hasBootId`, `NO_BOOT_ID` in `src/cli/commands/install.ts`): with task 4 it stops refusing on a Mac
by itself. Change its text so that it no longer says macOS is unsupported, and its test
(`test/cli/commands/install-unsupported.test.ts`) with it. In `doctor`, `systemLine`
(`src/cli/commands/doctor.ts`) prints `system: <name of /etc/os-release>, Linux <release>`: on a Mac
it must say macOS and its version and the kernel's release, and on Linux stay byte for byte the
same. Take the version from `/System/Library/CoreServices/SystemVersion.plist` (its
`ProductVersion`; the file `sw_vers` reads, EXPECTED to be XML: check it on the Mac) through
`platform.files`, the way `/etc/os-release` is read: no new `Proc` member. Then search the texts a
user reads for Linux words (`grep -rnE "/proc|apt install|WSL" src`): each one a Mac user can see
must be true on a Mac, and stay as it is on Linux. The command line's are this task's (e.g. the
error of `hasBootId`, "cannot read the boot id (/proc/…)" in `restorePlan`); the window's are M2a's
and M2b's (e.g. `PYTHON_MISSING` in `src/window/terminals.ts`, "its /proc entry" in
`src/cli/window-checks.ts` and `src/window/lifecycle.ts`). Tests first: the refusal's new text where
there is no boot id; a Mac's `system:` line with a made-up `SystemVersion.plist`; the Linux line
unchanged (its existing tests in `test/cli/commands/doctor-versions.test.ts` stay as they are).

**Task 8: the documents.** `README.md` ("What you need": the command line works on a Mac; the window
follows), `docs/install.md` ("Prerequisites", and that zsh users put `~/.local/bin` on PATH in
`~/.zshrc`), `docs/design.md` (3: the words "boot" and "process"; 5.1; 5.5: a start on a Mac is
whole seconds from `ps`; 8: install no longer refuses on a Mac; 14: the Mac's `procStart`; 16:
macOS is no longer left out of the command line), `AGENTS.md` part 1, step 1 (its `Darwin` line;
keep the file's length: change words, add no lines; `test/agents-md.test.ts` checks every command
it names). Done when each says what is true at the end of M1 (the window not yet on
a Mac) and the suite is still green.

**Task 9 (last): a macOS job in the checks.** In `.github/workflows/ci.yml`, add a job `unit
(macos)` on `macos-latest`: `npm ci`, then `npm test` with `TMPDIR: /tmp`. Either unsharded (no
`shard` list, no `NODE_OPTIONS` line) or with its own `shard: ['1/n', …]` list and one
`NODE_OPTIONS: --test-shard=${{ matrix.shard }}` line: the lint job's step "Check the shard lists"
fails on anything else, and on any `include:` or `exclude:`. Give the test step a `timeout-minutes`
of its own (a step that reaches it fails the job). The page suite on macOS is M2a's.

M1 is done when the suite is green on the Mac with no "until M1" skip left, and the tests of tasks
2 to 7 pass on the Mac and (with stand-ins) on Linux.

### M2a: the window's server and terminals, opened by a printed address

Goal: `skydeck window --print-url` on a Mac starts the server and prints an address; opened in
Chrome, it shows the sessions and their terminals, and sessions can be started, resumed and typed
into there. Read `docs/design-step-2.md` 4 (processes), 7.1 (the keeper), 7.4 (a terminal's
environment), 8.1 (server and keeper).

**Task 1: the keeper on a Mac** (`bin/skydeck-keeper`, python3 3.9). Each change is taken only
where the Linux way is missing:

- `proc_start(pid)` reads `/proc/<pid>/stat`: on a Mac, the same number as task 4 of M1 gives
  (decision 6.1): through `sysctl` (`CTL_KERN`, `KERN_PROC`, `KERN_PROC_PID`) with `ctypes`, the
  seconds of `p_starttime` (EXPECTED: the first field of `struct kinfo_proc`, and what `ps lstart`
  prints). For a pid that does not exist, `sysctl` answers with no data (EXPECTED), which must
  raise as the Linux read does ("no such process"). A test on the Mac compares the number with
  `procStartFromLstart` of `ps` for the same process; until it passes, no keeper uses it (a wrong
  number makes every keeper look dead to the server, which then removes its files).
- `boot_id()`: `sysctlbyname("kern.bootsessionuuid")` through `ctypes`, in lower case.
- `Keeper.accept` checks the peer with `socket.SO_PEERCRED`, which python on a Mac does not have
  (EXPECTED; the probe says): the `AttributeError` is not caught today and ends the keeper. On a
  Mac use `getpeereid` from libc through `ctypes`.
- `main` calls `prctl(PR_SET_DUMPABLE, 0)`, which a Mac does not have (today it only logs
  "dumpable"): on a Mac set the keeper's own core limit to 0 (`resource.setrlimit`) instead.

Tests: the keeper tests (`test/keeper/`) run on the Mac for real; on Linux they keep testing the
Linux path. Keep `python3 -m py_compile bin/skydeck-keeper` clean (CI's lint runs it).

**Task 2: the socket path limit.** `SOCKET_PATH_LIMIT` is 108 in two places
(`src/window/runtime.ts`, `src/window/terminals.ts`), and doctor's `checkRuntimeDir` judges by it. A
Mac allows 103 bytes (its `sun_path` is 104 with the final zero; KNOWN). Make it one fact of the
platform, following from the Mac fact (part 3): 104 on a Mac and 108 elsewhere, in the same
"refused when at least the limit" sense.

**Task 3: the launcher's `serve` on a Mac.** `bin/skydeck` starts `serve` through
`/usr/bin/python3` to set a one-byte core limit (the reason is WSL's crash collector, in its
comment). On a Mac no core file is written by default (the soft limit is 0; EXPECTED), so where
`/proc/self/status` cannot be read start node directly, unset `SKYDECK_CORE_SOFT`, and write no log
line about python. doctor's `checkCoreLimit` (`src/cli/window-checks.ts`) says on a Mac that none is
needed. The launcher's tests of the python path (`needsUsrBinPython3` in
`test/bin/launcher.test.ts`) test the Linux path: from this task on, skip them on a Mac with that
reason, and test the Mac path beside them.

**Task 4: no keep-alive, no interop on a Mac** (decision 6.6). `createKeepAlive`
(`src/window/keepalive.ts`) gives state `failed` ("WSL_DISTRO_NAME is not set…") without WSL, and
the page then shows "WSL is not kept running" in its title bar for good. On a Mac (no `/proc`)
make it `off` with nothing shown. The interop link (`src/window/interop.ts`) finds nothing on a
Mac and removes its link: harmless; leave it.

**Task 5: a terminal's environment.** `programEnvironment` (`src/window/env.ts`) drops the
variables of the terminal that started the server (`TERMINAL_VARIABLES`, `TERMINAL_PREFIXES`). Mac
terminals also set `TERM_SESSION_ID`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`, `ITERM_PROFILE`,
`__CFBundleIdentifier` and `GHOSTTY_*`: drop them on a Mac only (on Linux a Ghostty user has
`GHOSTTY_*` too: whether Linux should drop them is a question for the report, not this port).
`programEnvironment` is pure: its caller gives it the Mac fact.

**Task 6 (last): the page suite on macOS in CI.** A job `page (macos)`: `npx playwright install
chromium` (no `--with-deps` on a Mac), `npm run test:page` with `TMPDIR: /tmp`. The page job's step
that reads `/etc/os-release` for its cache key does not work on a Mac, and Playwright keeps its
browsers in `~/Library/Caches/ms-playwright` there, not `~/.cache/ms-playwright`: use `sw_vers
-productVersion` and that folder, or no cache.

M2a is done when the window and keeper tests and the page suite pass on the Mac with no "until
M2a" skip left. (You never open the real window: part 9 does.)

### M2b: `skydeck window` starts the browser; links; doctor's window checks

Goal: `skydeck window` on a Mac opens skydeck in an app window of Chrome, links in it open in the
default browser, and `doctor` describes the window's state in a Mac's words. Read
`docs/design-step-2.md` 5.1, 5.3, 5.4, 9.6, 16.3, 16.4.

**Task 1 (first): the suite can never start a real browser or `open`.** The platform refuses
Windows programs while `SKYDECK_TEST_NO_WINDOWS=1` (the "Windows guard" in `src/platform/real.ts`;
every sandbox sets it). Make it refuse `/usr/bin/open` and any program under `/Applications/` or
`~/Applications/` too, judged after the `PATH` lookup as the Windows guard judges programs under
`/mnt/`, with a test. Every test of this stage uses stand-ins (as `test/fixtures/fake-edge/`
stands in for Edge).

**Task 2: `window.browser`** (decision 6.4). In `src/platform/config.ts` (`WindowConfig`,
`DEFAULT_CONFIG`, the `window` case of `parseConfig`): a new key, an absolute path to a
Chromium-family browser, valid on every system. Both `window.browser` and `window.edge` in one
file is an error that names both (`window.edge` has a default, so `parseConfig` must tell a key
the file sets from a default). On WSL, `window.edge` and every Edge rule work exactly as today.
On a Mac the browser is `window.browser`, else Google Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; a `window.edge` in a Mac's file is
an error that names `window.browser`. `window.profileDir` keeps its rule on WSL; on a Mac it may be
null (skydeck's own folder, `<state folder>/browser-profile`) or an absolute path.

**Task 3: starting the browser on a Mac.** `launchWindow` (`src/cli/window-open.ts`) calls
`startEdge` (`src/window/edge.ts`), which starts the program through `startWindowsProgram` with
the C: drive as its folder and builds its arguments with `edgeArgs` (`src/window/windows.ts`).
Beside them, a Mac launcher: the browser path itself (not `open -a`, so that a failure is seen),
the same four arguments (`--app=…`, `--user-data-dir=<profile folder>`, `--no-first-run`,
`--no-default-browser-check`), the home folder as its folder. The words a Mac user reads name the
browser, not Edge: the launch errors in `edge.ts`, "Edge was started, but no window connected…"
in `window-open.ts`, `skydeck window --help` (`src/cli/commands/window.ts`), and uninstall's line
naming the profile folder (`showProfileFolder` in `src/cli/commands/uninstall.ts`, which reads only
`C:\…` paths today). On WSL every text stays as it is.

**Task 4: links** (decision 6.6). `openLink` (`src/window/edge.ts`) uses `rundll32.exe` or Edge. On
a Mac: `/usr/bin/open <link>` (the link is already limited to http and https by `linkToOpen` in
`src/text/link.ts`, so it never starts with `-`). `window.links: "edge"` on a Mac is an error that
names `"default"`.

**Task 5: doctor's window checks on a Mac.** `WINDOW_CHECKS` (`src/cli/window-checks.ts`):
`checkDrive`, `checkEdge`, `checkProfileFolder`, `checkKeepAlive`, `checkInterop` and
`checkCoreLimit` are about WSL and Windows, and on a Mac report problems that are not true.
On a Mac: no C: drive or interop line; the browser check names the browser and its config key;
the profile check names the Mac folder; the keep-alive says none is needed on a Mac; the port
check stays `info` until M3. On Linux and WSL every line stays byte for byte the same.

**Task 6: the documents.** `docs/install.md` (the window on a Mac, `window.browser`, the config
table), `docs/design-step-2.md` (5.3, 5.4, 16.3, 16.4), `README.md`.

M2b is done when every test of the stage passes on the Mac and on Linux, no "until M2b" skip is
left, and the hands-on items for the window are written down for part 9.

### M3: restore after a restart, and the remaining facts

Goal: after the Mac restarts, skydeck offers to bring back the sessions that were open, each with
its flags where they could be read; memory, tty and port are known on a Mac as they are on Linux.

**Task 1: restore after a restart.** A restart gives a new boot id (EXPECTED), so the restore offer
(`restorePlan` in `src/sessions/restore.ts`, `bannerPayload` in `src/window/view/banner.ts`) works
once M1 does. Prove it with tests (two boot ids through the Mac `Proc`, a lower-case boot id the
banner and the page accept: `BOOT_ID` in `src/window/protocol.ts`, `banner.ts`, `web/app.js`).
After a logout without a restart the boot id stays, so no offer comes: write that into
`docs/install.md` as a known limit (decision 6.7); do not build anything for it.

**Task 2: exact arguments** (decision 6.3). Read a process's arguments through `sysctl`
`KERN_PROCARGS2` (python3 and `ctypes`; Node has no `sysctl`; the python3 found on `PATH`, as the
keepers use it, which the probe showed is a real one). Prove that it is exact before you store
anything: a test starts a stand-in with hard arguments (spaces, an empty one, a newline,
non-ASCII, `=`) and compares; and once with the real `claude`, by the fact run (4.2) with one line
added to the hook that compares the arguments it reads with the ones the run gave (when `claude`
runs as `node <script>`, those after the script) and prints only `exact arguments: yes` or `no`.
Only if both are exact: `Proc.cmdline` on a Mac returns them as `/proc/<pid>/cmdline` would (each
argument followed by a zero byte), and `reconcile` (`src/sessions/reconcile.ts`) stores the launch
command as on Linux. Otherwise `cmdline` stays null, and the report says so.

**Task 3: memory, tty, port.** In the Mac `Proc`: `memAvailableMb` from `vm_stat` (free, inactive,
speculative and purgeable pages times the page size its first line names; the probe showed the
form); `fdTarget(pid, 0)` as `/dev/<tty>` from `ps
-o tty=`; `tcpListening(port)` from `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Each null when its program
fails. Tests first with recorded answers (Linux) and real ones (Mac).

**Task 4: fixtures and the guide.** A Mac live-session file and a Mac spool file in
`test/fixtures/claude/` (made-up values in the forms of "Facts found on a Mac"); `docs/install.md`
gets a part for the Mac (install, PATH, the window in Chrome, restore after a restart, the logout
limit, no keep-alive needed); the hands-on list of part 9 goes into `docs/manual-checks.md` as Mac
items.

M3 is done when no "port: until" skip is left anywhere and the tests of its tasks pass on the Mac;
what only a person can see (the restore offer after a real restart) is part 9's.

## 6. Decisions already made

The maintainer made these, so that you do not stop for them. If a fact found on the Mac contradicts
one: stop THAT task, write it into the status file, go on with what does not depend on it.

- **6.1 Process identity.** A process's start on a Mac is whole seconds, parsed from the text of
  `ps -o lstart=` under `LC_ALL=C TZ=UTC`, in ONE function in TypeScript that is tested on Linux;
  the hook gives that text, the keeper the same number. First the Mac's facts are shaped like the
  Linux ones the code already reads (no wide refactor); a cleaner interface is a later, separate
  change. Reason: Claude Code itself writes this text (EXPECTED), so it is what all sides can agree
  on; seconds fit the existing integer column, and the code only compares starts for equality and
  order.
- **6.2 Boot identity** is `kern.bootsessionuuid`, in lower case. Reason: every boot-id check in the
  code and the page expects a lower-case UUID.
- **6.3 Launch flags.** None read from a running process on a Mac in M1: `skydeck show` prints
  `launch: unknown` and resume starts `claude --resume <id>` without flags, as on Linux when the
  arguments could not be read. In M3 the exact arguments through python3 and `sysctl`, if that
  proves exact; else they stay unknown. Never a lossy guess stored as if exact (`ps -o args=` joins
  arguments with spaces). Reason: resume and restore replay what is stored.
- **6.4 The browser** is Google Chrome at its default place; a new key `window.browser` (an absolute
  path to a Chromium-family browser) is valid everywhere; `window.edge` keeps working on WSL exactly
  as today; both set is an error that names both. The profile folder on a Mac is skydeck's own,
  under its state folder. Reason: one key for every system, and the user's own Chrome profile is
  never touched.
- **6.5 Keys.** The window keeps its Ctrl+Shift keys on a Mac; copy and paste follow the browser
  (Cmd+C, Cmd+V); Option stays a typing key. No remapping in this port: what a Mac user misses
  (e.g. Ctrl+V, Ctrl+click on a link) goes into the report. Reason: key choices need a Mac user's
  hands.
- **6.6 No keep-alive on a Mac** (`doctor` says none is needed). Links open with `/usr/bin/open`.
  Reason: nothing stops a Mac's processes by itself, as WSL does.
- **6.7 Restore** after a restart of the Mac is in; restore after a logout without a restart is a
  known limit, written into the guide, not built. Reason: the boot id changes with a restart only.
- **6.8 Folders** stay the XDG ones (`~/.local/share`, `~/.local/state`, `~/.config`, `~/.cache`).
  Reason: one rule on every system.

## 7. How to work for many hours

- **Branches.** One per stage in your fork, each from the one before: `mac-m1` from `origin/main`,
  `mac-m2a` from `mac-m1`, `mac-m2b` from `mac-m2a`, `mac-m3` from `mac-m2b`. Fork once:
  `gh repo fork --remote --remote-name fork` (adds the remote `fork`, keeps `origin`). Push with
  `git push -u fork <branch>`. Work in this clone and switch branches (`git switch`).
- **Pull requests.** One per stage against `main`, opened when the stage is done, with its body
  in a file under `/tmp`:

  ```sh
  upstream=$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
  login=$(gh api user --jq .login)
  gh pr create --repo "$upstream" --base main --head "$login:<branch>" --title "macOS: <stage goal>" --body-file "$body"
  ```

  Keep "allow edits by maintainers" on (the default). A stacked one says in its first line which
  pull request it sits on, and that its diff holds that one's commits until that one is merged.
  The body says: what the stage does, in a user's words; the tests added; the skips added and
  removed; the suite's commands and counts on the Mac (part 8); what the review found and what you
  changed; what is left.
- **Never wait for the maintainer.** When a stage's pull request is open, go on with the next stage
  on top. When you push a fix to an earlier stage's branch, merge that branch into every later
  stage branch at once (`git merge`, never a rebase), so that they stay identical where they
  overlap. When a pull request has been merged (squashed) into `main`, `git fetch origin` and
  merge `origin/main` into the next stage's branch; take `main`'s side wherever the content is the
  same.
- **Small commits**, each with a message that says what changed and why, in plain words.
- **The status file**, `docs/plans/mac-port-status.md`, committed in the stage branch you work on:
  the stage and task you are on; what is done; the skips table (M1 task 1); facts and decisions
  put in doubt; the pull requests and branches; the last full run on the Mac (commands, counts,
  time); the hands-on results. Update and commit it after every task, on the newest stage branch
  only; when you merge an earlier branch into a later one, keep the later one's status file. After
  a context loss or in a new session: read this plan's parts 3 and 10, then the status file of the
  newest stage branch (`git branch --list 'mac-*'`), and go on from there.
- **A second, fresh agent reviews each stage** before its pull request (a sub-agent with a clean
  context). Give it: this plan's parts 3, 5 (the stage) and 6, the diff (`git diff
  <base branch>...HEAD`), and the suite's counts; tell it to change nothing, run no full suite and
  report back. It must check: every task's "done" of the stage, test first; that Linux and WSL run
  exactly the code they ran before (each new branch is taken only where the Linux capability is
  missing, and no existing test was changed beyond the two exceptions of part 3); every skip and
  its reason; the hard rules; public words. Fix every real finding, then run part 8 again.

## 8. Before every pull request and every push to it

Run the whole suite on the Mac, from the clone, on the branch you are about to push:

```sh
npm ci
npm run format:check
npm run typecheck
TMPDIR=/tmp npm test
npx playwright install chromium
TMPDIR=/tmp npm run test:page
```

Everything must be green or skipped with a named reason; fix what fails first (a case that fails
once under load is run alone again, and counts as passing only if it passes then; name it in the
pull request). If `shellcheck` is on PATH, run it on every shell file you changed; else CI's lint
job does. The pull request says the commands and the counts (tests, passed, skipped). Then read
GitHub's checks (`gh pr checks <n> --repo <owner>/<name> --watch`, bounded); a pull request from a
fork may wait for the maintainer's approval before its first run: go on meanwhile. On Linux the
number of tests run and skipped must be that of `main` plus your new tests (yours skipped there
only with "needs a Mac"); fix whatever the checks show.

## 9. The hands-on check, at the end (about fifteen minutes)

When every stage you could do is done, tell your human that the hands-on check is ready. They do
it in a terminal of their own (not inside Claude Code); you say each step, they tell you what they
see, and you write each result into the status file at once. First switch the clone to the newest
stage branch (`git switch mac-m3`, or the last one done): install links to this clone, so it must
stay on that branch while skydeck is installed.

1. `bin/skydeck install` (they answer its questions; tell them first what each does, as `AGENTS.md`
   part 1 step 4 says). In a new terminal, `skydeck` must be found; if not, they add `export
   PATH="$HOME/.local/bin:$PATH"` to their `~/.zshrc` themselves. Then `skydeck doctor`: every line
   true on a Mac, no `problem` but those it explains.
2. In a scratch folder, `claude`: `skydeck ls` shows it running; a prompt makes it busy (working);
   a permission question makes it waiting; after the answer it is idle.
3. `skydeck window`: a Chrome app window opens; its title is `skydeck`, its Dock icon; the
   session's terminal works; `skydeck window --print-url` opened in Chrome works too.
4. Keys: Ctrl+Shift with a letter (the window's keys), Ctrl+Tab, Cmd+C and Cmd+V in the terminal,
   Ctrl+Shift+V (Claude Code's image paste), an Option character of their layout, Ctrl+click and
   Cmd+click on a link in the terminal. Write down what does not work: that is the report's.
5. A notification: with the window in the background, a session finishes its turn. (macOS may ask
   to allow notifications for Chrome.)
6. Last, because it ends this session too: with two sessions open in the window, restart the Mac.
   Before they do, write "hands-on: step 6 next" into the status file and commit it. After the
   restart they start Claude Code in the clone again and say "read `docs/plans/mac-port.md` and go
   on"; you read the status file and ask them to run `skydeck window`: the restore offer appears,
   and restoring brings the sessions back.
7. Then `skydeck uninstall`, or keep skydeck: their choice. Only after an uninstall may you switch
   branches or change files in this clone again (part 3).

If there was no fact run (part 4.2): in step 2, `skydeck show <the new session's label or id
prefix>` must print a line `holder: pid <n> since …`; without one, the hook got no `CLAUDE_PID` on
this Mac: report it.

## 10. When to stop, and the final report

Stop and tell your human at once (then go on with what does not depend on it, if anything):

- anything you are about to do would break a rule of part 3;
- a fact found on the Mac makes a stage impossible, or contradicts a decision of part 6. The one
  to watch: `procStart equals ps lstart: NO`. If it says YES in local time only, Claude Code writes
  local time, against 6.1: stop M1's tasks 2 to 6, write it down, and go on with what does not
  depend on them (task 1, the parts of tasks 7 to 9 that do not need a process start); the
  maintainer decides. If both say NO, the identity cannot be read this way: M1 cannot work, and
  nothing after it;
- the suite is red on Linux (GitHub's checks) through the port's fault and you cannot fix it;
- a command asks for a password, a login or a `sudo`.

The final report (in this conversation, and as a comment on the last pull request, in public
words): the pull requests and what each does; what works on the Mac, and what does not; the skips
left, with their reasons; the hands-on results (or what stayed unchecked); what a Mac user misses
(keys, words, behaviour); the decisions of part 6 that the facts put in doubt; anything the
maintainer must decide.
