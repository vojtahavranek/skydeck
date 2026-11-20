# Porting skydeck to macOS: a plan for an AI coding agent on a Mac

You are an AI coding agent (Claude Code) running on a Mac, in a clone of this repository, and your
human said "read `docs/plans/mac-port.md` and start working on it". This file is your whole brief.
Follow it literally; where it is silent, do the safe thing named in part 10 (stop that task, write
it into the status file, go on with what does not depend on it).

**First: a start, or a resume?** Before any other command, run `ls docs/plans/mac-port-status.md
.git/refs/heads` (it runs no `git`). If the status file is there, or a branch named `mac-…` is
listed (a `git branch --list 'mac-*'` says the same once part 2.1 has shown that `git` is real), you
are RESUMING after a stop or a context loss: read parts 3 and 10, then the status file of the newest
stage branch, and go on from where it says. Do not run part 2 again and ask no question again: the
answers are in the status file. A changed tree is then your own unfinished task (look at it, then
finish or undo it), not your human's work. Otherwise this is the first start: part 2.

Every file, function and constant this plan names was checked against the code of `main` at commit
e040723. Names and lines drift: find each by searching for its name (your search tool, or `grep -rn
"<name>" src bin web test`; `rg` may not be installed on a Mac). Where the code at your commit says
something else, the code wins: write the difference into the status file and go on.

Two words are used with care. **KNOWN**: read in the code, or a stable, documented property of
macOS. **EXPECTED**: believed, but never seen on a Mac. Step 0 (part 4) or a test on the Mac
confirms or refutes each EXPECTED; one that proves false stops only the tasks that rely on it.

## 1. What this is, and who does what

The goal, in a user's words: skydeck works on a Mac as it does on WSL. First the command line (each
session shows as `working`, `waiting` or `not-running`; labels, resume and restore work), then the
window in Chrome, then restore after a restart. On Linux and WSL nothing changes.

- **You** build and test on this Mac, and open pull requests from a fork in your human's GitHub
  account against `main` of the repository this clone came from (its `origin`). One pull request per
  stage (part 7). You never merge, and you never wait for a merge.
- **Your human** answers the questions of part 2 once, at the start, then leaves you to work for
  many hours. At the end they do a hands-on check of about fifteen minutes, with you guiding (part
  9): only a person can install skydeck for real, open its window and press keys.
- **The maintainer** reviews and merges. GitHub's checks decide: the Linux jobs that exist today,
  and the macOS job you add at the end of M1.

Read first, in this order: `AGENTS.md` part 2 (the rules of the code; part 1, with its "Darwin:
STOP", is about installing skydeck and does not apply to this work); `docs/design.md` sections 2
(principles), 5 (recording: the hook, ingest, reconcile, the liveness rule) and 14 (Claude Code
behaviour); the sections of `docs/design-step-2.md` each stage names. Never follow
`docs/manual-checks.md`: it is the maintainer's checklist and can uninstall skydeck.

## 2. Before you start

### 2.1 Checks, all read-only

Run this first, before any command of yours (no `git`, no `python3`, no `npm` before it): if Apple's
developer tools are missing, `/usr/bin/git` and `/usr/bin/python3` are only stubs that open an
"install the developer tools" window, and the probe never runs them.

```sh
sh scripts/mac-probe.sh
```

It changes nothing (part 4.1 says what it reads). Read its output, then check, and STOP where it
says so (tell your human what is missing and the command that fixes it; never run that command
yourself):

- `this is a Mac: yes`. Otherwise STOP: this plan is for a Mac.
- `macOS:` a version. Node.js 24 needs macOS 13.5 or newer (EXPECTED, from Node.js's list of
  supported systems): older, STOP. The `node` line below shows whether it runs at all.
- `developer tools: found`. Otherwise STOP, whatever `python3` and `git` show (a Homebrew python3 or
  git first on `PATH` shows a version even without them): the suite and the launcher run
  `/usr/bin/python3` and `/usr/bin/git` themselves, which without the developer tools are only
  Apple's stubs and open the install window. Print for your human: `xcode-select --install`.
- `python3` 3.9 or newer, from the developer tools or Homebrew. Older or missing: STOP (the window's
  terminals and the suite's keeper tests need it).
- `node` 24.12 or newer. Otherwise STOP and print for your human: install Node.js 24 from
  nodejs.org, or `brew install node@24` if they use Homebrew.
- `claude` shows a version. Otherwise the fact run of part 4.2 is left to the hands-on check; go on.
- `gh` shows a version, and `gh auth status` says it is logged in to github.com, with the token
  scopes `repo` and `workflow` (GitHub refuses a push that changes `.github/workflows/` without
  `workflow`, and M1's last task does). Otherwise STOP and print `gh auth login`, or `gh auth
  refresh -s workflow`, for your human.
- The repository and the fork. `<owner>/<name>` is `origin`'s (`git remote get-url origin`; `git` is
  safe to run once the probe has shown it is real). `gh api repos/<owner>/<name> --jq .fork` must
  print `false`: if it prints `true`, this clone came from a fork, and pull requests against it
  would never reach the maintainer: STOP and ask. `gh api repos/<owner>/<name> --jq .allow_forking`
  must print `true`, and `gh api user --jq .login` prints the login. Whether that account already
  has a fork: `gh api repos/<login>/<name> --jq '.fork, .parent.full_name'` prints `true` and
  `<owner>/<name>` for one (an error means no repository of that name; a repository of that name
  that prints anything else is in the way: STOP and ask); if it has one, its branches: `gh api
  --paginate repos/<login>/<name>/branches --jq '.[].name'`; a `mac-…` branch there is from an
  earlier try, which a push would collide with and force is forbidden: STOP and ask. Some company
  accounts may not fork outside their company: if `gh repo fork` refuses later, STOP and tell your
  human.
- A Chromium-family browser is found (`Google Chrome: in /Applications` is the default this port
  uses). Without one, M1 and M2a go on; tell your human that M2b's hands-on check needs Chrome.

Then run `git remote -v` and `git status`: `origin` must be the repository on github.com and the
tree clean (at a first start a changed tree is your human's work in progress: STOP and ask), and
`git fetch origin` then `git show origin/main:scripts/mac-probe.sh` must work (this plan is on
`main`; without it your branches would start from a `main` without the plan: STOP and ask). Your
human is still there for these first commands, and for the questions that follow.

### 2.2 The questions, asked once

Ask your human all of these in ONE message, and wait for the answers. Then work without asking again
until part 9 or part 10 tells you to.

1. **The fork.** "May I fork this repository into your GitHub account `<login>` (`gh repo fork`), or
   use the fork you already have there, push branches to it and open pull requests from it against
   the original? Everything I push is public text: I will write no name, user name, machine name,
   path or employer into it. My commits carry an author name and e-mail, which become public too:
   may I set them for this clone only to your login and your GitHub no-reply address (`git config
   user.name "<login>"`, `git config user.email "<id>+<login>@users.noreply.github.com"`), or do you
   want your own?" (Take `<login>` and `<id>` from `gh api user --jq '.login, .id'`. Set them before
   the first commit; never commit without both set, or git makes up an address from the user and
   machine names.)
2. **Checks on the fork.** "Right after your answers I make the fork; then please switch GitHub
   Actions on for it (on the fork's page: Actions, then the button that enables its workflows),
   while you are still here. I start the checks there myself, on each branch, and read them before I
   open a pull request against the original."
3. **Many hours, and permissions.** "May I work unattended for up to 20 hours? Please keep the Mac
   plugged in with the lid open, and run `caffeinate -i` in a terminal tab of your own (Ctrl+C ends
   it), so that it does not sleep. I edit files only inside this clone. The commands the work needs
   are these families: `sh` (the probe, the fact run's script); `git` (status, diff, log, show,
   grep, rev-parse, branch, remote, `config user.*`, fetch, add, commit, switch, merge, push to your
   fork, and one `git clone` for the check at the end); `gh` (auth status, api, repo fork, repo
   view, pr create, pr view, pr checks, pr comment, workflow run, run list, run view, run watch);
   `npm` (ci, test, run), `npx playwright install chromium` (it downloads about 150 MB into
   `~/Library/Caches/ms-playwright`), `node`; `python3`; `perl` (to bound a command's time); `ps`,
   `sysctl`, `sw_vers`, `vm_stat`, `lsof`, `uname`, `xcode-select -p`; `mkdir`, `cp`, and `rm` only
   inside this clone and the suite's sandboxes; `kill` only for process ids the suite left behind;
   `grep`, `sed`, `awk`, `sort`, `head`, `tail`, `wc`, `find`, `tr`, `cat`, `dirname`, `ls`,
   `sleep`, `date`, `env`, `whoami`, `hostname`, `scutil --get ComputerName`; `shellcheck` if you
   have it; `claude --help`, and the one `claude -p` of question 4. Many come in these forms: with
   `TMPDIR=/tmp` or `NODE_OPTIONS=…` in front, behind `perl -e 'alarm …; exec @ARGV or exit 127'`,
   or as a block that starts with `facts="$(git …)"` (part 4.2): a permission rule for a family may
   not cover such a form. How you let them run without a question each time is your choice; I never
   change my own permissions or settings. If the session stops for any reason (a usage limit, a
   closed lid, a restart), start Claude Code again in this clone and say 'read
   docs/plans/mac-port.md and go on': I resume from my status file."
4. **The facts only your Claude Code can show** (part 4.2). Show them the `claude -p …` line of part
   4.2 as it is, and say: "May I run this once? It starts Claude Code scripted, in a throwaway
   folder inside this clone, with a throwaway hook that writes a file holding only these kinds of
   lines: NAMES (of environment variables and of the input's fields), YES/NO answers, WORDS FROM
   FIXED LISTS (anything else is written as "(other)") and one fully masked start time; never a
   value of yours, never free text. It costs a few cents at most (it stops at five) and takes at
   most two minutes. It runs with your own login and settings, so your own hooks, and any an
   administrator set, run as in any session of yours, and your own `CLAUDE.md` and this clone's are
   read as in any session started here. In your own folders it may leave what Claude Code leaves
   after any session: its own entry for this clone's folder in `~/.claude.json` (I never open that
   file), a transcript if one appears in spite of the flag that asks for none, and, if the time
   limit ends it, a stale live-session file in `~/.claude/sessions`. I look whether the last two are
   there, report them to you, and never read or delete them. If Claude Code refuses to run inside my
   session, that is the answer: I do not try another way. I run it once, never again if it fails."
5. **The end.** "At the end, will you do a hands-on check of about fifteen minutes with me: install
   skydeck for real from a second clone I prepare at `~/skydeck-mac-check` (not from this one, where
   I work), open its window, press some keys, and once restart the Mac? Without it the window's look
   and keys stay unchecked."

A no to 1 or 3: STOP (you cannot deliver). A no to 2: open the pull requests without the fork's run
and say so in each. A no to 4: leave the hook facts to the hands-on check (part 9). A no to 5: say
in the final report what stayed unchecked. Then, while your human is still there: fork (`gh repo
fork --remote --remote-name fork`, part 7), make the branch `mac-m1`, write the answers into its
status file, commit it, and push the branch to the fork (a push that asks for a login fails now, not
hours later when nobody is there); ask your human to switch Actions on for the fork, and start one
run on the fork's `main` (part 7): its counts are the base of part 8. Only then the fact run of part
4.2.

## 3. Hard rules

On your human's machine (it holds their real Claude Code sessions and their work):

- Work only inside this clone (switch branches in it; no worktree) and the suite's sandboxes
  (`test/helpers/`). Every scratch file of yours that is not to be committed (the fact run's folder
  of part 4.2, a pull request's body, notes) goes into ONE folder at the clone's root,
  `.mac-port-scratch/`, which the repository's `.gitignore` names; you remove what you no longer
  need. Nothing goes under `.git/` (Claude Code treats it as a protected path: a write there asks
  for a yes, or is refused, whatever your human allowed, so it would stop you while you are alone),
  nor under the home folder or `/tmp`. The one exception is the check clone of part 9,
  `~/skydeck-mac-check`, made once at the end. The status file is not scratch: it is a tracked file
  of the branch (part 7). (The caches `npm` and Playwright keep, and `gh`'s own settings, are theirs
  to write.) Reason: everything else is your human's.
- Run code only through the suite (`npm test`, `npm run test:page`, single test files, the commands
  of part 8), the probe and the fact run of part 4. Never run `bin/skydeck` or `node src/...`
  outside a test, not even with `--help`: the launcher writes a cache into `~/.cache/skydeck`, most
  commands read the real `~/.claude`, and `install`, `window`, `update` and `uninstall` change the
  real installation. Reason: a test's sandbox has its own home; your human's does not.
- Never edit Claude Code's settings files (`~/.claude/settings*.json`, `.claude/settings*.json` of a
  project) or `~/.claude.json`, and never read a transcript (`~/.claude/projects/`). Never change
  your own permissions or settings. Reason: they hold your human's settings and conversations, and
  their choices.
- Never start, stop or signal a Claude Code session, except the one scripted run of part 4.2. Never
  `kill`, `pkill` or `killall` by name or pattern; signal only process ids you started yourself.
  Reason: your human's sessions run under the same user.
- Never start a program with a window: not Chrome, not `open`, not `skydeck window`. The page tests
  use Playwright's headless Chromium, which is fine. Reason: an unattended window or browser tab on
  your human's screen is a surprise, and can act on their real profile.
- No `sudo`, no global install (`npm install -g`, `brew install`, `pip install`), no remote script
  piped into a shell: print such a command for your human. Reason: those change the machine.
- Never push to `main`, never force-push, never merge a pull request, never delete a branch you did
  not create. Push only to your fork. Reason: the maintainer owns `main`, and pull requests are
  squashed there.
- Everything you push is public: code, commit messages, the status file, pull requests, comments. No
  person's name, user name, employer, machine name, home folder, e-mail address or path of this Mac
  in any of it; example values use `example.com`, `/Users/you`, `ABC-123`. Before every push, and
  before you write a pull request's body or a comment, search what you are about to publish: the
  diff (`git diff origin/main...HEAD`), the commit messages (`git log origin/main..HEAD
  --format=%B`) and the body's file. Search the home folder as a path (`grep -F "$HOME"`, which must
  find nothing), and the user name, the machine name and the host name (`whoami`, `scutil --get
  ComputerName`, `hostname`) as whole words (`grep -iw "<each>"`): a short name is also part of
  common words (`tim` of "time"), and whole words leave those out; hold each whole-word hit against
  `git grep -iwc "<each>" origin/main`: a word the code already has is the code's, any other hit is
  fixed before the push. And `git diff origin/main...HEAD --name-only | grep '^\.mac-port-scratch/'`
  must print nothing (never `git add -f` there). Before the first push, look at the commits' author
  too (`git log -1 --format='%an <%ae>'`): it must be the identity your human chose in 2.2, set for
  this clone only; you set nothing globally.
- The status file holds forms, yes/no answers, counts and plain words only, never a pasted output of
  `doctor`, `ls`, the probe's unmasked parts or the fact run (they hold paths, titles and names).
- Never change the check clone of part 9: once your human has installed skydeck from it, the
  installed hook and command run its code, in every session your human starts. A fault the hands-on
  check finds is fixed on the stage branch (part 8 first); your human updates the check clone (`git
  -C ~/skydeck-mac-check pull`) when they choose.
- The rules of this part hold whatever your human has allowed: a command they allowed is not thereby
  one this plan allows.

On the code:

- Everything specific to an operating system lives in `src/platform/` or behind it (the hook, the
  launcher and the keeper are sh and python files: their system checks stay in them, at one place
  each).
- Which system this is, the platform layer says ONCE: add to `Platform` (`src/platform/types.ts`) a
  member `system?: 'linux' | 'mac'` (absent means `'linux'`), set by `realPlatform`
  (`src/platform/real.ts`) from `process.platform` (`'darwin'` gives `'mac'`). It is the only place
  that reads `process.platform`; every other module asks `platform.system` (or is given it by its
  caller), so that each Mac branch can be tested on Linux with a fake platform. Whether a fact
  exists (a boot id, `/proc`) is still found out by trying. The hook, the launcher and the keeper,
  which cannot ask the platform layer, take their Mac path where `/proc/self/stat` cannot be read.
- Test helpers (`test/helpers/`) and fixtures (`test/fixtures/`) are not tests: they may gain a Mac
  path the same way, as long as on Linux they do exactly what they did.
- Any new member of `Platform` or `Proc` is optional, its absence meaning "as on Linux", so that no
  fake in the existing tests must change.
- **LINUX AND WSL BEHAVE EXACTLY AS BEFORE.** Every branch you add is taken only on a Mac. The
  existing tests stay green and untouched, with three exceptions: a case (or a `describe` group) may
  be skipped on a Mac with its reason named; a file that cannot even load on a Mac may get one guard
  at its top that skips the whole file on a Mac with its reason (part 5, M1 task 1); and a test
  whose expected text says that macOS is not supported changes with that text.
- No runtime dependency (Node.js's own modules only); Node.js 24.12 or newer; python3 3.9 or newer
  (the developer tools' python3 is 3.9). No new dependency of any kind.
- The words a user reads are plain, and true on the system they read them on.
- Every shell file you change or add passes `shellcheck`: the lint job of `.github/workflows/ci.yml`
  runs it on the files its `shellcheck` line names (add a new shell file there), and where
  `shellcheck` is on PATH you run it yourself before each push.
- A change in behaviour updates the design (`docs/design.md`, `docs/design-step-2.md`: `AGENTS.md`
  part 2) and the guide (`docs/install.md`: this plan's rule) in the same pull request.

## 4. Step 0: the facts only a Mac can tell

### 4.1 The probe

`sh scripts/mac-probe.sh` (you ran it in 2.1). It prints, masked so that the output can go into a
public pull request: macOS and program versions (never running Apple's stubs), which python3 facts
the keeper needs (`SO_PEERCRED`, `getpeereid`, `sysctlbyname`), BSD `date`'s answer to `+%s%N`, the
form of `kern.bootsessionuuid`, `ps -o lstart=` and whether it is stable, the cost of one `ps` call
and of a snapshot of all processes, whether the `CLAUDE*` variables Claude Code is known to set are
in your own environment (and how many others), and the field names and value forms of your own
Claude Code's live-session file (`<Claude Code's folder>/sessions/<pid>.json`), with the one answer
M1 hangs on: `procStart equals ps lstart` read in English and UTC (as skydeck will), in English and
local time, and in the language and zone of this Mac, each YES or NO. It finds your own file by
walking up the parents of its shell; when it says "no Claude Code among this script's parents", it
reads the newest three files instead (still masked): note that in the facts.

### 4.2 What a hook receives: one bounded run of Claude Code

Only with a yes to question 4 of 2.2, and ONCE in the whole plan (never in a loop, never in the test
suite, never again if it fails). The suite runs the block below only with a stand-in `claude`
(`test/mac-port-plan.test.ts`): it checks the flags, which markers reach `claude`, and that every
line the hook writes has one of the forms below; keep it passing if you change the block. The probe
cannot see a hook's environment; one scripted run of Claude Code shows it. It runs with your human's
own login and settings, as any session of theirs does:

- `--settings <file>`: a throwaway settings file whose only content is a `SessionStart` and a
  `SessionEnd` hook, a script that writes into the run's folder only NAMES (of the environment
  variables and of the input's fields), YES/NO answers, WORDS FROM FIXED LISTS and one fully masked
  start time: never a value of your human's, never free text; whatever does not fit a fixed list is
  written as `(other)`. Hooks of all levels merge (EXPECTED: not documented), so your human's own
  hooks, and any set by an administrator, run too, as in any session of theirs.
- `--tools ""` and `--disallowedTools "mcp__*"`: no built-in tool and no MCP tool;
  `--strict-mcp-config` with an empty `--mcp-config`: no MCP server is started.
- `--no-session-persistence`: the session is not saved to disk (documented); whether a `-p` run
  writes anything else is not documented (EXPECTED: no more than the after-check below looks at).
  `--max-budget-usd 0.05`, `--model haiku`: one short answer from the cheapest model; a few cents at
  most, and it stops at five. Your human's own `CLAUDE.md` and the clone's are read as in any
  session started there. `--max-turns 1` is given where `claude --help` lists it, and left out where
  it does not (with no tools one answer is one turn).
- `env -u` of three of your own session's variables (`CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_ENTRYPOINT`): a hook inherits Claude Code's environment, so without this the hook
  could show your session's values instead of what the scripted run sets. Nothing of the login, the
  provider or the settings is removed, and `CLAUDECODE` stays as it is.
- Claude Code has a guard against a session started inside a session; it looks at `CLAUDECODE`,
  which the run leaves as it is, so the guard sees the nesting. Whether it lets a `claude -p`
  through is not documented (EXPECTED: yes, it lets non-interactive commands through). If Claude
  Code refuses the run because it runs inside your session, that is the answer: no other form is
  tried, and the facts move to the hands-on check.
- At most two minutes (`perl -e 'alarm 120; exec @ARGV or exit 127'`; 127 means `claude` could not
  be started), in a folder of its own, `.mac-port-scratch/facts` at the clone's root (part 3).

Never use `--restricted`, `--bare`, `env -i` or another `CLAUDE_CONFIG_DIR` for it: your human's
login or provider settings would be lost. First check that `claude --help` lists each flag that
bounds the run: `-p`, `--settings`, `--tools`, `--disallowedTools`, `--strict-mcp-config`,
`--mcp-config`, `--no-session-persistence`, `--max-budget-usd` and `--model`. If one is missing,
STOP the fact run (not the port): the facts move to the hands-on check (part 9). (`--max-turns`
alone the block looks for itself.)

First write "fact run: started" into the status file and commit it; if the status file already says
so, never run it again (this is how ONCE survives a context loss). Then make the folder, the hook,
the settings file and the run script, and run it (one block, as it is):

```sh
facts="$(git rev-parse --show-toplevel)/.mac-port-scratch/facts"
mkdir -p "$(dirname "$facts")" || exit 1
mkdir "$facts" || { echo "$facts is there already: stop"; exit 1; }
cat >"$facts/hook.sh" <<'EOF'
#!/bin/sh
# Records what a hook receives: names, yes/no answers, words from fixed lists and one fully
# masked start time; never a value, never free text.
{
  echo "event: $1"
  echo "CLAUDE* variable names:"
  awk 'BEGIN { for (k in ENVIRON) if (k ~ /^CLAUDE/) print "  " k }' | sort
  perl -MJSON::PP -e '
    local $/; my $j = decode_json(<STDIN>);
    print "input field names:\n"; print "  $_\n" for sort keys %$j;
    my $s = $ENV{CLAUDE_CODE_SESSION_ID};
    print "CLAUDE_CODE_SESSION_ID equals session_id: ", (defined $s && $s eq ($j->{session_id} // "") ? "yes" : "no"), "\n";
    my %word = map { $_ => 1 } qw(cli sdk-cli sdk-ts sdk-py claude-vscode claude-desktop);
    my $e = $ENV{CLAUDE_CODE_ENTRYPOINT};
    print "CLAUDE_CODE_ENTRYPOINT: ", (!defined $e ? "(not set)" : $word{$e} ? $e : "(other)"), "\n";'
  case ":$PATH:" in *:/usr/sbin:*) echo "PATH holds /usr/sbin: yes" ;; *) echo "PATH holds /usr/sbin: no" ;; esac
  case ":$PATH:" in *:/bin:*) echo "PATH holds /bin: yes" ;; *) echo "PATH holds /bin: no" ;; esac
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
} >"$(dirname "$0")/$1.txt" 2>/dev/null
exit 0
EOF
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"sh %s/hook.sh SessionStart","timeout":5}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"sh %s/hook.sh SessionEnd","timeout":5}]}]}}\n' \
  "$facts" "$facts" >"$facts/settings.json"
cat >"$facts/run.sh" <<'EOF'
#!/bin/sh
cd "$1" || exit 1
# --max-turns only where this claude lists it: with no tools one answer is one turn anyway.
set --
if claude --help 2>/dev/null | grep -q -e '--max-turns'; then set -- --max-turns 1; fi
env -u CLAUDE_PID -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT \
  perl -e 'alarm 120; exec @ARGV or exit 127' \
  claude -p "Reply with the single word ok." --settings "$PWD/settings.json" \
  --tools "" --disallowedTools "mcp__*" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  "$@" --max-budget-usd 0.05 --no-session-persistence --model haiku </dev/null >answer.txt 2>&1 &
echo "$!" >pid.txt
wait "$!"
echo "claude ended with $?"
EOF
sh "$facts/run.sh" "$facts"
```

Then read `.mac-port-scratch/facts/SessionStart.txt` and `SessionEnd.txt` (not `answer.txt`: it is
Claude Code's answer or its error, which may name the account; read only whether it is the word
`ok`, and whether it says that Claude Code may not run inside a session). Write the facts, as forms
and yes/no, into "Facts found on a Mac" below (in the M1 branch), and "fact run: done" with its
outcome into the status file. Then check what the run left in your human's own folders, by name
only:

- a transcript in spite of the flag: `ls -d
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*mac-port-scratch*`;
- a stale live-session file, if the time limit ended the run: `ls
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions/$(cat .mac-port-scratch/facts/pid.txt).json"`;
- Claude Code's own entry for the clone's folder in `~/.claude.json` may exist: never open that
  file; just say so.

Whatever is found is REPORTED to your human (in the status file and at the end), never read and
never deleted. Then remove the run's folder (`rm -r .mac-port-scratch/facts`, from the clone's top
folder).

If the run failed (`claude ended with` another number than 0, 127 when `claude` could not be
started), or `SessionStart.txt` is missing (the hooks did not fire), try nothing else: the facts
move to the hands-on check, where your human's real install shows them at its first session. Whether
`SessionEnd` runs at a normal end of a `-p` run is not documented (EXPECTED: yes); a missing
`SessionEnd.txt` alone is a fact to write down, not a failure.

What it settles: whether `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_ENTRYPOINT` are set
in a hook on a Mac (the hook relies on all three: `bin/skydeck-hook`; `CLAUDE_PID` is documented
from Claude Code 2.1.214, `CLAUDE_CODE_ENTRYPOINT` is not documented: EXPECTED), whether
`CLAUDE_PID` is the `claude` process, the input's field names, that the hook's parent is a shell,
and whether a hook's `PATH` holds `/usr/sbin` (where `sysctl` is) and `/bin`.

### 4.3 How each open question is settled

| Open question | Settled by |
|---|---|
| The form of `procStart` in Claude Code's live-session file on a Mac (EXPECTED: the text of `ps -o lstart=` under `LC_ALL=C TZ=UTC`, like `Thu Nov  5 09:12:33 2026`, two spaces before a one-digit day; else the same text in the Mac's local time) | the probe: `procStart (text): [...]` and its three `procStart equals ps lstart` lines (English and UTC; English and local time; the Mac's own language and zone); where the first two both say YES (a zone at UTC now), part 9 step 2 |
| `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` in a hook on a Mac; whether a hook's `PATH` holds `/usr/sbin` | the fact run (4.2); else the hands-on check |
| `kern.bootsessionuuid`: present, a UUID, its case (EXPECTED: upper case) | the probe |
| BSD `date +%s%N` (EXPECTED: no nanoseconds; prints a literal `N`) | the probe: `date +%s%N: [9999999999A]` means no |
| The cost of `ps` | the probe: `ps cost`, `ps snapshot cost` |
| python3's `SO_PEERCRED` (EXPECTED: missing), `getpeereid`, `sysctlbyname` | the probe |
| How many tests fail on a Mac, and why | M1 task 1 |
| Exact arguments of a running process (EXPECTED: through `sysctl` `KERN_PROCARGS2`) | M3 task 2, with a stand-in program (never with Claude Code) |
| Chrome's Ctrl+click, Ctrl+Tab, Cmd shortcuts in an app window; Option on your human's layout; notifications; the Dock icon and title | the hands-on check (part 9); misses go into the report |
| Whether `kern.bootsessionuuid` changes with a restart (EXPECTED: yes) and not with a logout | the hands-on check (restart); logout is a known limit (6.7) |
| Whether macOS asks for permissions when a session in the window works in `~/Documents` or `~/Desktop` | the hands-on check; report what appeared |

### Facts found on a Mac

(Empty until the first pull request. Write here, as forms and yes/no only: macOS and program
versions; the probe's answers for `date`, `kern.bootsessionuuid`, `ps lstart`, the python3 facts,
`vm_stat`, the `ps` costs; the field names and forms of the live-session file and both `procStart
equals ps lstart` answers (all three), and the form taken (`'utc'`, `'local'`, or `'utc'`,
UNSETTLED); from the fact run, whether `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, and
`CLAUDE_CODE_ENTRYPOINT` are set (not the whole list of names, which can tell about your human's
setup), the input's field names and the yes/no answers, and what the run left. Nothing personal: no
path, no name, no value.)

## 5. The stages

In order: M1, M2a, M2b, M3. The window needs the command line's process facts (the server refuses to
start without its own process start and a boot id: `ownLine` in `src/window/server.ts`; a keeper
exits before it binds its socket without them: `main` in `bin/skydeck-keeper`).

Every task below is test first: write the tests it names, run them and see them fail on the Mac,
then write the code. A test of Mac behaviour that can also run on Linux runs there with stand-ins
(sh scripts written into the sandbox's `bin`, as `test/bin/hook.test.ts` writes a stand-in `date`);
a test that needs the real Mac (real `ps`, `sysctl`, a real keeper) is skipped elsewhere with the
reason "needs a Mac".

### M1: the command line on a Mac

Goal: after `skydeck install` on a Mac, `skydeck ls` shows each open session as `working` (a turn
runs) or `waiting` (at its prompt, or asking something), and the others as `not-running` (the states
of `docs/design.md` 6.2; `running` is only the fallback when no live-session file of the session can
be trusted); `show`, labels, groups, notes, `resume` and `restore` work, and `doctor` tells the
truth.

**Task 1: the suite tells the truth on a Mac.** Run the whole suite on the unchanged code (part 8's
commands; for this first run give node a limit per case, `node --test --test-timeout=60000 <files>`,
folder by folder, since many cases wait for a server or a keeper that never starts on a Mac yet). On
a Mac, run the tests with `TMPDIR=/tmp` in front: the sandbox's root is made under the system's
temporary folder (`sandbox` in `test/helpers/sandbox.ts`), and the default one on a Mac
(`/var/folders/…`) makes a terminal's socket path in it longer than a Mac allows (103 bytes; KNOWN).
Then sort every failing test into one of three kinds:

- (a) The test itself assumes Linux, for a reason that is not the product's: it reads `/proc` itself
  (e.g. `bootId()` in `test/bin/hook.test.ts`, the top of `test/bin/keepalive.test.ts`), needs GNU
  options, or tests WSL's keep-alive script. Skip it on a Mac, with the reason.
- (b) The product does not work on a Mac yet (e.g. the server refuses to start without a boot id).
  Skip it on a Mac with the reason "port: until M1" (or M2a, M2b, M3: the stage that makes it pass).
- (c) Anything else: find out why. A real bug is fixed (with its own test) or written into the
  status file for the maintainer; never skipped silently.

Rules for skips, so that they hide nothing:

- One helper decides them: add `test/helpers/mac.ts` with `onMac(reason: string): string | false`
  (the reason on a Mac, `false` elsewhere), used as `test('…', { skip: onMac('…') }, …)`, the idiom
  `test/bin/launcher.test.ts` already uses for its own skips, and `needsMac(): string | false` for
  your new tests that need a real Mac ("needs a Mac" elsewhere, `false` on a Mac). It is the only
  place a test names the platform. On Linux every `onMac` skip is `false`: the Linux counts stay
  those of `main` plus your new tests (part 8).
- Skip single cases, or one `describe` group whose cases all fail for the same reason, not files. A
  file that cannot even load on a Mac (the top of `test/bin/keepalive.test.ts` reads `/proc`'s boot
  id when it loads) may get one guard at its top that skips the whole file on a Mac, with the
  reason. Nothing else of an existing test file changes.
- Every skip is listed in the status file: file, case, kind, reason, the stage that takes it out.
  `grep -rn "onMac(" test test-page` and the list must agree.
- At the end of every stage, take out each "port: until <this stage>" skip; the case must pass.
- After a run, look for processes the suite left: `ps -ax -o pid=,command= | grep
  '[/]skydeck-test-'` lists only those whose command names a sandbox (the suite's, which you
  started). End each by its pid (`kill <pid>`), and write into the status file which test left it:
  on a Mac the suite's clean-up cannot yet tell a live process (`test/helpers/kill.ts` asks
  `/proc`).

Done when the suite on the Mac is green with every failure skipped and listed, and the facts of part
4 are in "Facts found on a Mac".

**Task 2: one parser of a process start's text.** In `src/claude/procstat.ts` (pure, beside
`procStartFromStat`), add `procStartFromLstart(text: string, zone: 'utc' | 'local'): number | null`:
the text of `ps -o lstart=` (`Www Mmm dd hh:mm:ss yyyy` in the C locale's English names, a one-digit
day after two spaces, trimmed at both ends) to whole seconds since 1970, read as UTC or as the
machine's local time; null for anything else, including a weekday that does not match the date. It
is the ONLY place that reads this text (decision 6.1): skydeck's own readings always ask `ps` under
`LC_ALL=C TZ=UTC` and use `'utc'`. Tests first (they run on Linux too): a one-digit and a two-digit
day, the end of a year, 29 February, every month name, a wrong weekday, extra words, an empty text,
a time out of range; and the local form in a child process with a set `TZ` (one with summer time),
including the hour that comes twice when the clocks go back, which reads as the earlier of the two.
Done when they pass on Linux and on the Mac.

**Task 3: a live-session file's `procStart` on a Mac.** In `src/claude/live.ts`, `procStartOf`
accepts that text too, through `procStartFromLstart`, in the form the facts found: `'utc'` where the
probe's UTC line says YES, `'local'` where only its local-time line does. Where both say YES (a Mac
whose zone is at UTC now, as in the UK in winter), take `'utc'`: the expectation that Claude Code
asks `ps` with `LC_ALL=C TZ=UTC` comes from reading Claude Code's own program on Linux (EXPECTED on
a Mac); write the form as UNSETTLED in the status file and the final report, and part 9 step 2
settles it. The digits of Linux stay as they are. If the form is local time, `docs/install.md` gets
the known limit: a session started in the hour that comes twice in autumn may show as `running` (its
live-session file not trusted) instead of `working` or `waiting`. Tests first in
`test/claude/live.test.ts`: a made-up Mac live-session file (the form from the facts, made-up
values) gives the seconds; every existing case is unchanged. Done when the parse of the probe's
masked form, filled with made-up digits, gives the expected number.

**Task 4: the process facts on a Mac.** `Proc` (`src/platform/types.ts`) is synchronous and its
Linux implementation `realProc` (`src/platform/real.ts`) reads `/proc`. Add a second implementation
beside it, built on a function that runs a program synchronously (`spawnSync`, a time limit of two
seconds, absolute paths `/bin/ps` and `/usr/sbin/sysctl` (where a Mac keeps them; the probe's `ps`
and `sysctl` lines show it), `LC_ALL=C TZ=UTC`), and let `realPlatform` use it where `system` is
`'mac'` (part 3). Shape its answers like Linux's (decision 6.1):

- `bootId()`: `sysctl -n kern.bootsessionuuid`, trimmed, in lower case, read once per process.
- `stat(pid)`: a line shaped like `/proc/<pid>/stat` whose field 4 is the parent and field 22 is
  `procStartFromLstart(start, 'utc')` (`procStartFromStat` and `parentPidFromStat` read only those
  two fields: check with `grep -rnE "procStartFromStat|parentPidFromStat|proc\.stat\(" src` before
  you rely on it). The answers come from one snapshot of all processes, `ps -A -o
  pid=,ppid=,lstart=`, taken at most once a second (once per window tick). A pid the snapshot does
  not hold is asked once by itself (`ps -o ppid=,lstart= -p <pid>`; that is as good as a new
  snapshot and cheaper) before the answer is "no such process", so that a process started after the
  snapshot is never taken for dead. `ps -p` for a process that does not exist exits 1 and prints
  nothing (EXPECTED; a test on the Mac shows it): only that is "no such process". No `ps`, a
  time-out or any other failure throws (an error, never "no process").
- The resume guard reads uncached: the Mac `Proc` gets an optional method that drops its snapshot,
  and the code that loads the rows `checkResumable` (`src/sessions/resume.ts`) judges, for `resume`,
  `new`, `restore` and the window's starts, calls it first.
- `cmdline`: null in M1 (decision 6.3). `memAvailableMb`, `fdTarget`, `tcpListening`: null until M3;
  each already degrades: restore counts unknown memory as enough, the window shows no tty, and
  doctor says what holds the port is not known.
- `kernelRelease()`: `sysctl -n kern.osrelease`.
- Keep `Proc`'s contract (its comment in `types.ts`): `bootId` and `stat` return null only when the
  fact does not exist (no such process), and throw any other failure.

Measure and report the cost: the probe's `ps snapshot cost`, and one tick of the window with twenty
sessions (`src/window/tick.ts`; `holderPlace` in `src/window/mapping.ts` walks up to eight parents,
two `stat` calls each); a synchronous call holds the server's event loop while it runs.

Tests first: with a made-up runner on Linux (every answer shape: a process, none, a pid missing from
the snapshot but found when asked alone, a `ps` that fails, a `sysctl` that is missing, the snapshot
dropped); and on the Mac with the real programs, for the test's own process (its parent is
`process.ppid`; its start is within the last day; two calls agree) and a pid that does not exist.
Done when both pass, and Linux still runs `realProc`.

**Task 5: the hook on a Mac.** `bin/skydeck-hook` reads `/proc` and `date +%s%N`. Give it a second
path, taken only when `/proc/self/stat` cannot be read (with `SKYDECK_TEST_PROC`, below, unset,
Linux runs exactly today's commands):

- the time: `date +%s%N` when it prints only digits; otherwise the source the facts showed works, in
  nanoseconds without a floating-point step: `perl -MTime::HiRes=gettimeofday -e '($s, $u) =
  gettimeofday; printf "%d%06d000", $s, $u'`, or zsh's `EPOCHREALTIME` with its dot removed and
  `000` appended;
- the process start: a new spool key `lstart=` with the text of `LC_ALL=C TZ=UTC ps -o lstart= -p
  "$CLAUDE_PID"`, as it is (the hook interprets nothing: design 5.1);
- the boot id: `sysctl -n kern.bootsessionuuid`, as it is;
- no `argv_b64` (decision 6.3).

On this path the hook calls `ps`, `sysctl` and `perl` by name, as it calls `date` and `cat` today
(no absolute path, so that the suite's stand-ins replace them). If the fact run showed that a hook's
`PATH` lacks `/usr/sbin` (where `sysctl` is), the Mac path appends `/usr/sbin` to `PATH` first
(stand-ins on the sandbox's `PATH` still come first); say so in the hook's header and the design.

In `src/claude/hookinput.ts` (`parseSpoolFile`), read `lstart` through `procStartFromLstart(…,
'utc')` when `stat` is empty (the hook always writes the `stat=` line), and take the boot id in
lower case (on Linux it already is). Old readers ignore the new key (unknown keys are ignored). For
tests on Linux, let the hook take its `/proc` folder (for every read of it, the test of the path
too) from `SKYDECK_TEST_PROC` when it is an absolute path, as `bin/skydeck-keepalive` does; a test
points it at an empty folder and writes stand-ins of `ps`, `sysctl`, `date` and `perl` into the
sandbox's `bin` (`sandbox.link` finds programs only in `/usr/bin` and `/bin`, and `sysctl` is in
`/usr/sbin`). Update the hook's header ("only sh builtins plus date, cat, base64, mkdir and mv") and
`docs/design.md` 5.1 ("It uses only `sh`, `date`, …"): on a Mac also `ps`, `sysctl` and the time
source. Tests first in `test/bin/hook.test.ts` (Mac path, on Linux with stand-ins and on the Mac for
real) and `test/claude/hookinput.test.ts`. Measure the hook on the Mac: `SessionEnd` hooks share
about 1.5 s (design section 14). Done when they pass, the hook's Linux tests are unchanged and
green, and the hook's time on the Mac is written into the status file.

**Task 6: liveness end to end.** First the suite's own helpers, which read `/proc` themselves: the
stand-in program (`test/fixtures/standin/standin.ts` reads `/proc/self/stat` and `/proc/self/limits`
when it starts, so every test that starts it fails on a Mac), `test/fixtures/fake-serve/`, and
`procStartOf` in `test/helpers/keeper.ts`. Give each a Mac path (the same process start, through
`ps` and `procStartFromLstart(…, 'utc')`; no limits file on a Mac), Linux unchanged. Then: with
tasks 2 to 5, a session's start from the hook, from its live-session file and from `Proc.stat` must
be the same number, or every session shows as not running (`isAlive`, `isLiveFileTrusted` in
`src/claude/live.ts`). This is M1's gate: skydeck's reading of a running session's start equals the
live file's. Test it on the Mac end to end: the real hook (Mac path) with `CLAUDE_PID` set to a
process the test started, ingest, then `isAlive` true; and a made-up live-session file with that
process's real `ps` text, then `isLiveFileTrusted` true. Also: a reboot is seen (a second boot id),
`checkResumable` (`src/sessions/resume.ts`) refuses a session that runs. Done when `skydeck ls
--json` in a test sandbox shows the right states for stand-in sessions; the gate is seen for real
only in part 9, step 2.

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
unchanged (its existing tests in `test/cli/commands/doctor-versions.test.ts` stay as they are). Done
when they pass, and each text the search found is true on a Mac or listed for M2a or M2b.

**Task 8: the documents.** `README.md` ("What you need": the command line works on a Mac; the window
follows), `docs/install.md` ("Prerequisites", and that zsh users put `~/.local/bin` on PATH in
`~/.zshrc`), `docs/design.md` (3: the words "boot" and "process"; 5.1; 5.5: a start on a Mac is
whole seconds from `ps`; 8: install no longer refuses on a Mac (its sentence on macOS); 14: the
Mac's `procStart`; 16: macOS is no longer left out of the command line), `AGENTS.md` part 1, step 1
(its `Darwin` line; keep the file's length: change words, add no lines; `test/agents-md.test.ts`
checks every command it names). Done when each says what is true at the end of M1 (the window not
yet on a Mac) and the suite is still green.

**Task 9 (last): a macOS job in the checks.** In `.github/workflows/ci.yml`, add a job `unit
(macos)` on `macos-latest`: `npm ci`, then `npm test` with `TMPDIR: /tmp`. Either unsharded (no
`shard` list, no `NODE_OPTIONS` line) or with its own `shard: ['1/n', …]` list and one
`NODE_OPTIONS: --test-shard=${{ matrix.shard }}` line: the lint job's step "Check the shard lists"
fails on anything else, and on any `include:` or `exclude:`. Give the test step a `timeout-minutes`
of its own (a step that reaches it fails the job). The page suite on macOS is M2a's. Done when the
fork's run (part 7) shows the job green beside the Linux jobs.

M1 is done when the suite is green on the Mac with no "until M1" skip left, and the tests of tasks 2
to 7 pass on the Mac and (with stand-ins) on Linux.

### M2a: the window's server and terminals, opened by a printed address

Goal: `skydeck window --print-url` on a Mac starts the server and prints an address; opened in
Chrome, it shows the sessions and their terminals, and sessions can be started, resumed and typed
into there. Read `docs/design-step-2.md` 4 (processes), 7.1 (the keeper), 7.4 (a terminal's
environment), 8.1 (server and keeper).

**Task 1: the keeper on a Mac** (`bin/skydeck-keeper`, python3 3.9). Its Mac path is taken where
`/proc/self/stat` cannot be read; for tests on Linux it takes its `/proc` folder from
`SKYDECK_TEST_PROC`, as the hook does (M1 task 5). It calls `ps` and `sysctl` by name, as the hook
does:

- `proc_start(pid)` reads `/proc/<pid>/stat`: on a Mac it runs `ps -o lstart= -p <pid>` under
  `LC_ALL=C TZ=UTC` (the same text Node and the hook read) and turns it into whole seconds with
  `calendar.timegm(time.strptime(text, "%a %b %d %H:%M:%S %Y"))`, never through `ctypes` and
  structure offsets (a wrong offset would make live keepers look dead). `ps` exiting 1 with no
  output means no such process and raises as the Linux read does; any other failure raises too.
- `boot_id()`: `sysctl -n kern.bootsessionuuid`, in lower case.
- `Keeper.accept` checks the peer with `socket.SO_PEERCRED`, which python on a Mac does not have
  (EXPECTED; the probe says): the `AttributeError` is not caught today and ends the keeper. On a Mac
  use libc's `getpeereid` through `ctypes` (a function with two integer results, no structure to lay
  out); if the probe says it is missing, stop this item and write it down.
- `main` calls `prctl(PR_SET_DUMPABLE, 0)`, which a Mac does not have (today it only logs
  "dumpable"): on a Mac set the keeper's own core limit to 0 (`resource.setrlimit`) instead.
- What the keeper says does not change, so neither does its version (`KEEPER_VERSION`, 3 at 8e0184b;
  `docs/design-step-2.md` 7.7): the Mac path changes how it reads facts, not its messages. Its
  hang-up `E` (SIGHUP, then SIGCONT, to its own program) is plain POSIX and works on a Mac
  (EXPECTED; the keeper tests show it).

The old keeper kept as a fixture (`test/fixtures/keeper-v2/skydeck-keeper`, used by
`test/window/terminals-end.test.ts`) gets no Mac path: its cases are of kind (a) of M1 task 1.

Tests first: on Linux with `SKYDECK_TEST_PROC` and stand-ins of `ps` and `sysctl`, the keeper's pid
line carries the seconds `procStartFromLstart(text, 'utc')` gives for the stand-in's text and the
lower-case boot id; on the Mac the keeper tests (`test/keeper/`) run for real, and one compares the
keeper's number for a process with `procStartFromLstart` of `ps` for the same one. Keep `python3 -m
py_compile bin/skydeck-keeper` clean (CI's lint runs it). Done when the keeper tests pass on the Mac
and nothing changed for them on Linux.

**Task 2: the socket path limit.** `SOCKET_PATH_LIMIT` is 108 in two places
(`src/window/runtime.ts`, `src/window/terminals.ts`), and doctor's `checkRuntimeDir` judges by it. A
Mac allows 103 bytes (its `sun_path` is 104 with the final zero; KNOWN). Make it one value that
follows from `platform.system` (part 3): 104 on a Mac and 108 elsewhere, in the same "refused when
at least the limit" sense. Tests first: with a fake platform whose `system` is `'mac'`, a 104-byte
path is refused by `prepareRuntimeDir`, by the terminals and by doctor, and a 103-byte one is taken;
with none, every existing case is unchanged. Done when they pass on Linux and on the Mac.

**Task 3: the launcher's `serve` on a Mac.** `bin/skydeck` starts `serve` through `/usr/bin/python3`
to set a one-byte core limit (the reason is WSL's crash collector, in its comment). On a Mac no core
file is written by default (the soft limit is 0; EXPECTED), so where `/proc/self/stat` cannot be
read (with the same `SKYDECK_TEST_PROC` for tests) start node directly, unset `SKYDECK_CORE_SOFT`,
and write no log line about python. doctor's `checkCoreLimit` (`src/cli/window-checks.ts`) says on a
Mac that none is needed. The launcher's tests of the python path (`needsUsrBinPython3` in
`test/bin/launcher.test.ts`) test the Linux path: from this task on, skip them on a Mac with that
reason. Tests first, beside them: the Mac path on Linux (`SKYDECK_TEST_PROC` at an empty folder:
node is started directly, no python runs, nothing is logged) and on the Mac for real. Done when both
pass.

**Task 4: no keep-alive, no interop on a Mac** (decision 6.6). `createKeepAlive`
(`src/window/keepalive.ts`) knows two ways today: mode `off`, and WSL; without `WSL_DISTRO_NAME` it
gives state `failed` ("WSL_DISTRO_NAME is not set…"), and the page then shows "WSL is not kept
running" in its title bar for good. Add a third branch: where `platform.system` is `'mac'`, the
state is `off`, nothing is started, and the page shows nothing; doctor's `checkKeepAlive` says that
a Mac needs no keep-alive (that line is M2b task 5's). The interop link (`src/window/interop.ts`)
finds nothing on a Mac and removes its link: harmless; leave it. Tests first: `createKeepAlive` with
a fake Mac platform gives `off` and starts no program, whatever `window.keepAlive` says; every
existing case unchanged. Done when they pass.

**Task 5: a terminal's environment.** `programEnvironment` (`src/window/env.ts`) drops the variables
of the terminal that started the server (`TERMINAL_VARIABLES`, `TERMINAL_PREFIXES`). Mac terminals
also set `TERM_SESSION_ID`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`, `ITERM_PROFILE`,
`__CFBundleIdentifier` and `GHOSTTY_*`: drop them on a Mac only (on Linux a Ghostty user has
`GHOSTTY_*` too: whether Linux should drop them is a question for the report, not this port).
`programEnvironment` is pure: its caller gives it `platform.system`. Tests first: with `'mac'` each
of them is dropped; without it, each is kept as today. Done when they pass.

**Task 6: the window's words.** The texts of the window and its server that name Linux things must
be true on a Mac and stay as they are on Linux: `PYTHON_MISSING` in `src/window/terminals.ts` ("sudo
apt install python3"; on a Mac name the developer tools), "its /proc entry" in
`src/window/lifecycle.ts`, and those you find with `grep -rnE "/proc|apt install|WSL" src/window
web`. Tests first, for each text on a Mac and on Linux. Done when they pass.

**Task 7 (last): the page suite on macOS in CI.** A job `page (macos)`: `npx playwright install
chromium` (no `--with-deps` on a Mac), `npm run test:page` with `TMPDIR: /tmp`. The page job's step
that reads `/etc/os-release` for its cache key does not work on a Mac, and Playwright keeps its
browsers in `~/Library/Caches/ms-playwright` there, not `~/.cache/ms-playwright`: use `sw_vers
-productVersion` and that folder, or no cache. Done when the fork's run shows the job green.

M2a is done when the window and keeper tests and the page suite pass on the Mac with no "until M2a"
skip left. (You never open the real window: part 9 does.)

### M2b: `skydeck window` starts the browser; links; doctor's window checks

Goal: `skydeck window` on a Mac opens skydeck in an app window of Chrome, links in it open in the
default browser, and `doctor` describes the window's state in a Mac's words. Read
`docs/design-step-2.md` 5.1, 5.3, 5.4, 9.6, 16.3, 16.4.

**Task 1 (first): the suite can never start a real browser or `open`.** The platform refuses Windows
programs while `SKYDECK_TEST_NO_WINDOWS=1` (the "Windows guard" in `src/platform/real.ts`; every
sandbox sets it). Make it refuse `/usr/bin/open` and any program whose path holds `/Applications/`
(the system's or a home's) too, judged after the `PATH` lookup as the Windows guard judges programs
under `/mnt/`, with a test. Every test of this stage uses stand-ins (as `test/fixtures/fake-edge/`
stands in for Edge). Done when the test shows both refused while the guard is on, and every existing
case of the guard is unchanged.

**Task 2: `window.browser`** (decision 6.4). In `src/platform/config.ts` (`WindowConfig`,
`DEFAULT_CONFIG`, the `window` case of `parseConfig`, which its caller gives `platform.system`): a
new key, an absolute path to a Chromium-family browser, valid on every system. Both `window.browser`
and `window.edge` in one file is an error that names both (`window.edge` has a default, so
`parseConfig` must tell a key the file sets from a default). On WSL, `window.edge` and every Edge
rule work exactly as today. On a Mac the browser is `window.browser`, else Google Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; a `window.edge` in a Mac's file is
an error that names `window.browser`. `window.profileDir` keeps its rule on WSL; on a Mac it may be
null (skydeck's own folder, `<state folder>/browser-profile`) or an absolute path. Tests first, in
`test/platform/config.test.ts` (its table of bad values): `window.browser` relative or not a string;
both keys; on a Mac `window.edge` set, `window.profileDir` absolute and relative; the defaults on
each system. Done when they pass and every existing case is unchanged.

**Task 3: starting the browser on a Mac.** `launchWindow` (`src/cli/window-open.ts`) calls
`startEdge` (`src/window/edge.ts`), which starts the program through `startWindowsProgram` with the
C: drive as its folder and builds its arguments with `edgeArgs` (`src/window/windows.ts`). Beside
them, a Mac launcher: the browser path itself (not `open -a`, so that a failure is seen), the same
four arguments (`--app=…`, `--user-data-dir=<profile folder>`, `--no-first-run`,
`--no-default-browser-check`), the home folder as its folder. The words a Mac user reads name the
browser, not Edge: the launch errors in `edge.ts`, "Edge was started, but no window connected…" in
`window-open.ts`, `skydeck window --help` (`src/cli/commands/window.ts`), and uninstall's line
naming the profile folder (`showProfileFolder` in `src/cli/commands/uninstall.ts`, which reads only
`C:\…` paths today). On WSL every text stays as it is. Tests first, with a stand-in browser (a
script like `test/fixtures/fake-edge/` that records its arguments and folder): the arguments, the
folder, the profile folder made under the state folder, a missing browser named in the error, and
uninstall naming the Mac folder. Done when they pass, on Linux with a fake Mac platform and on the
Mac.

**Task 4: links** (decision 6.6). `openLink` (`src/window/edge.ts`) uses `rundll32.exe` or Edge. On
a Mac: `/usr/bin/open <link>` (the link is already limited to http and https by `linkToOpen` in
`src/text/link.ts`, so it never starts with `-`). `window.links: "edge"` on a Mac is an error that
names `"default"`. Tests first: with a fake Mac platform, the program and arguments `openLink`
starts (a stand-in, never the real `open`: task 1), and the error. Done when they pass.

**Task 5: doctor's window checks on a Mac.** `WINDOW_CHECKS` (`src/cli/window-checks.ts`):
`checkDrive`, `checkEdge`, `checkProfileFolder`, `checkKeepAlive`, `checkInterop` and
`checkCoreLimit` are about WSL and Windows, and on a Mac report problems that are not true. On a
Mac: no C: drive or interop line; the browser check names the browser and its config key; the
profile check names the Mac folder; the keep-alive says none is needed on a Mac; the port check
stays `info` until M3. On Linux and WSL every line stays byte for byte the same. Tests first, beside
`test/cli/commands/doctor-window.test.ts`: the lines on a fake Mac platform, word for word; its
existing cases unchanged. Done when they pass.

**Task 6: the documents.** `docs/install.md` (the window on a Mac, `window.browser`, the config
table), `docs/design-step-2.md` (5.3, 5.4, 16.3, 16.4), `README.md`. Done when each says what is
true at the end of M2b.

M2b is done when every test of the stage passes on the Mac and on Linux, no "until M2b" skip is
left, and the hands-on items for the window are written down for part 9.

### M3: restore after a restart, and the remaining facts

Goal: after the Mac restarts, skydeck offers to bring back the sessions that were open, each with
its flags where they could be read; memory, tty and port are known on a Mac as they are on Linux.

**Task 1: restore after a restart.** A restart gives a new boot id (EXPECTED), so the restore offer
(`restorePlan` in `src/sessions/restore.ts`, `bannerPayload` in `src/window/view/banner.ts`) works
once M1 does. Prove it with tests (two boot ids through the Mac `Proc`, a lower-case boot id the
banner and the page accept: `BOOT_ID` in `src/window/protocol.ts`, `banner.ts`, `web/app.js`). After
a logout without a restart the boot id stays, so no offer comes: write that into `docs/install.md`
as a known limit (decision 6.7); do not build anything for it. Done when the tests pass on Linux (a
fake Mac platform) and on the Mac.

**Task 2: exact arguments** (decision 6.3). Read a process's arguments through `sysctl`
`KERN_PROCARGS2` (python3 and `ctypes`; Node has no `sysctl`; the python3 found on `PATH`, as the
keepers use it, which the probe showed is a real one). Prove that it is exact before you store
anything, and without Claude Code: a test starts a stand-in program with awkward arguments (spaces,
quotes, an empty one, a newline, non-ASCII, `=`), reads them back this way and compares them byte
for byte; no scripted run of Claude Code is made for it. Only if that is exact: `Proc.cmdline` on a
Mac returns them as `/proc/<pid>/cmdline` would (each argument followed by a zero byte), and
`reconcile` (`src/sessions/reconcile.ts`) stores the launch command as on Linux; a python3 run per
call costs time, so `reconcile` asks once per process (its pid and start). Otherwise `cmdline` stays
null, and the report says so. Whether Claude Code changes what its own process shows (EXPECTED: not)
is seen in part 9, step 2. Done when the test passes on the Mac (it needs a Mac).

**Task 3: memory, tty, port.** In the Mac `Proc`: `memAvailableMb` from `vm_stat` (free, inactive,
speculative and purgeable pages times the page size its first line names; the probe showed the
form); `fdTarget(pid, 0)` as `/dev/<tty>` from `ps -o tty=`; `tcpListening(port)` from `lsof -nP
-iTCP:<port> -sTCP:LISTEN`. Each null when its program fails. Tests first with recorded answers
(Linux) and real ones (Mac). Done when both pass and doctor's port line on a Mac is no longer
`info`.

**Task 4: fixtures and the guide.** A Mac live-session file and a Mac spool file in
`test/fixtures/claude/` (made-up values in the forms of "Facts found on a Mac"); `docs/install.md`
gets a part for the Mac (install, PATH, the window in Chrome, restore after a restart, the logout
limit, no keep-alive needed); the hands-on list of part 9 goes into `docs/manual-checks.md` as Mac
items. Done when existing fixture tests read the new fixtures as the Mac forms, and the guide's Mac
part names nothing this port did not build.

M3 is done when no "port: until" skip is left anywhere and the tests of its tasks pass on the Mac;
what only a person can see (the restore offer after a real restart) is part 9's.

## 6. Decisions already made

The maintainer made these, so that you do not stop for them. If a fact found on the Mac contradicts
one: stop THAT task, write it into the status file, go on with what does not depend on it.

- **6.1 Process identity.** A process's identity on a Mac is its start in whole seconds since 1970.
  skydeck's OWN readings (Node, the hook, the keeper) always take the text of `ps -o lstart=` under
  `LC_ALL=C TZ=UTC`: the hook writes that text, the keeper gives the same number. The text in Claude
  Code's live-session file is parsed in the form step 0 finds: UTC expected; if it is the Mac's
  local time, it is parsed as local time, and the one hour a year that comes twice when the clocks
  go back is written into the guide as a known limit; where both forms match (a zone at UTC now),
  `'utc'` is taken, the expectation that comes from reading Claude Code's program on Linux (EXPECTED
  on a Mac), and the form is UNSETTLED until part 9 step 2. Both forms are read in ONE function in
  TypeScript, tested on Linux. First the Mac's facts are shaped like the Linux ones the code already
  reads (no wide refactor); a cleaner interface is a later, separate change. M1's gate is that
  skydeck's reading of a running session's start equals the live file's, not one line of the probe.
  Reason: Claude Code itself writes this text (EXPECTED), so it is what all sides can agree on;
  seconds fit the existing integer column, and the code only compares starts for equality and order.
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
  (Cmd+C, Cmd+V); Option stays a typing key. No remapping in this port: what a Mac user misses (e.g.
  Ctrl+V, Ctrl+click on a link) goes into the report. Reason: key choices need a Mac user's hands.
- **6.6 No keep-alive on a Mac** (`doctor` says none is needed). Links open with `/usr/bin/open`.
  Reason: nothing stops a Mac's processes by itself, as WSL does.
- **6.7 Restore** after a restart of the Mac is in; restore after a logout without a restart is a
  known limit, written into the guide, not built. Reason: the boot id changes with a restart only.
- **6.8 Folders** stay the XDG ones (`~/.local/share`, `~/.local/state`, `~/.config`, `~/.cache`).
  Reason: one rule on every system.

## 7. How to work for many hours

- **Branches.** One per stage in your fork, each from the one before: `mac-m1` from `origin/main`,
  `mac-m2a` from `mac-m1`, `mac-m2b` from `mac-m2a`, `mac-m3` from `mac-m2b`. Fork once, right after
  the answers of 2.2 while your human is there: `gh repo fork --remote --remote-name fork` (adds the
  remote `fork`, keeps `origin`; with a fork that already exists, it adds the remote). Push with
  `git push -u fork <branch>`. Work in this clone and switch branches (`git switch`).
- **Checks on the fork first.** The workflow (`.github/workflows/ci.yml`) runs on `pull_request`, on
  a push to `main`, and when started by hand (`workflow_dispatch`); a push to a stage branch of the
  fork starts nothing by itself. So, once your human has switched Actions on for the fork (2.2,
  question 2), start it by hand on the branch you pushed, and read it before you open or update the
  pull request:

  ```sh
  upstream=$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
  fork="$(gh api user --jq .login)/${upstream#*/}"
  gh workflow run ci.yml --repo "$fork" --ref <branch>
  gh run list --repo "$fork" --workflow ci.yml --branch <branch> --limit 1 --json databaseId,status,conclusion
  perl -e 'alarm 570; exec @ARGV or exit 127' gh run watch <id> --repo "$fork" --exit-status
  gh run view <id> --repo "$fork" --log-failed
  ```

  The run appears a few seconds after `gh workflow run`: list again until the newest one for the
  branch is the one you started. A run started by hand runs every job, the oldest Node version's too
  (the workflow's comments say why). Watch again while it runs; fix what it shows, push, and start
  it again; open the pull request only when it is green (Linux, and macOS once M1 task 9 is done).
  If the fork's Actions cannot be switched on (a no to question 2, or `gh workflow run` refuses),
  open the pull requests without it and say so in each.
- **Pull requests.** One per stage against `main`, opened when the stage is done, with its body in
  the scratch folder (`body="$(git rev-parse --show-toplevel)/.mac-port-scratch/pr-body.md"`):

  ```sh
  upstream=$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
  login=$(gh api user --jq .login)
  gh pr create --repo "$upstream" --base main --head "$login:<branch>" --title "macOS: <stage goal>" --body-file "$body"
  ```

  To change a pull request's body later, write the file and run `gh api -X PATCH
  repos/<owner>/<name>/pulls/<n> -F body=@"$body"` (`gh pr edit` can fail on this repository). Each
  command of yours starts a fresh shell: set `upstream`, `login` and `body` in the same command that
  uses them. Keep "allow edits by maintainers" on (the default). A stacked one says in its first
  line which pull request it sits on, and that its diff holds that one's commits until that one is
  merged. The body says: what the stage does, in a user's words; the tests added; the skips added
  and removed; the suite's commands and counts on the Mac (part 8); what the review found and what
  you changed; what is left.
- **Never wait for the maintainer.** When a stage's pull request is open, go on with the next stage
  on top. When you push a fix to an earlier stage's branch, merge that branch into every later stage
  branch at once (`git merge`, never a rebase), so that they stay identical where they overlap. When
  a pull request has been merged (squashed) into `main`, `git fetch origin` and merge `origin/main`
  into the next stage's branch; take `main`'s side wherever the content is the same.
- **Small commits**, each with a message that says what changed and why, in plain words.
- **The status file**, `docs/plans/mac-port-status.md`, committed in the stage branch you work on
  (make it as soon as `mac-m1` exists): the answers to the five questions of 2.2; "fact run:
  started", written and committed BEFORE that run (part 4.2), and its outcome after; the stage and
  task you are on; what is done; the skips table (M1 task 1); facts and decisions put in doubt; the
  pull requests and branches; the last full run on the Mac (commands, counts, time); the hands-on
  results. Update and commit it after every task, on the newest stage branch only; when you merge an
  earlier branch into a later one, keep the later one's status file. After a context loss or in a
  new session: read this plan's parts 3 and 10, then the status file of the newest stage branch
  (`git branch --list 'mac-*'`), and go on from there.
- **A second, fresh agent reviews each stage** before its pull request (a sub-agent with a clean
  context). Give it: this plan's parts 3, 5 (the stage) and 6, the diff (`git diff <base
  branch>...HEAD`), and the suite's counts; tell it to change nothing, run no full suite and report
  back. It must check: every task's "done" of the stage, test first; that Linux and WSL run exactly
  the code they ran before (each new branch is taken only on a Mac, and no existing test file was
  changed beyond the three exceptions of part 3); every skip and its reason; the hard rules; public
  words. Fix every real finding, then run part 8 again.

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
job does. The pull request says the commands and the counts (tests, passed, skipped). A full `npm
test` can take longer than one command of yours may run: run it in the background and wait for its
end, or in shards that each end in time (`TMPDIR=/tmp NODE_OPTIONS=--test-shard=1/6 npm test`, then
2/6 to 6/6: together they are the whole suite, as in CI). Then push the branch to the fork and read
the fork's own run there (part 7, "Checks on the fork first") before you open or update the pull
request. On Linux the number of tests run and skipped must be that of `main` plus your new tests
(yours skipped there only with "needs a Mac"): that is the proof that no `onMac` skip is ever taken
on Linux. The base is the run on the fork's `main` you started in 2.2. In each run, add up the `ℹ
tests` and the `ℹ skipped` lines of the unit jobs of one Node version and of the page jobs (`gh run
view <id> --repo "$fork" --log | grep -E 'ℹ (tests|skipped) [0-9]+'`, the job's name at the start of
each line), and hold the branch's sums against the base's. Fix whatever the checks show. After the
pull request is open, read its checks too, bounded (macOS has no `timeout`): `perl -e 'alarm 570;
exec @ARGV or exit 127' gh pr checks <n> --repo "$upstream" --watch` (with `upstream` set as in part
7), again while they run. A pull request from a fork may wait for the maintainer's approval before
its first run there: go on meanwhile.

## 9. The hands-on check, at the end (about fifteen minutes)

When every stage you could do is done, prepare the check clone and tell your human that the hands-on
check is ready. skydeck is never installed from the clone you work in: install links the hook and
the command into the checkout it is run from, so a later `git switch` there would change the code
your human's real sessions run. So:

- Check read-only that skydeck is not installed already (`command -v skydeck`, `ls -l
  ~/.local/bin/skydeck`) and that `~/skydeck-mac-check` does not exist; if either is there, STOP and
  ask.
- Make the check clone, a second clone (not a worktree of this one) at the newest stage branch: `git
  clone https://github.com/<login>/<name>.git ~/skydeck-mac-check`, then `git -C ~/skydeck-mac-check
  switch <newest stage branch>`. After your human has installed from it, never change it (part 3).
- A fault a step finds is fixed on the stage branch, with part 8 first; your human updates the check
  clone when they choose (`git -C ~/skydeck-mac-check pull`), and the step is done again.

Your human does each step in a terminal of their own (not inside Claude Code); you say the step,
they tell you what they see, and you write each result into the status file of the clone you work in
(as plain words and yes/no, part 3).

1. `cd ~/skydeck-mac-check && bin/skydeck install` (they answer its questions; tell them first what
   each does, as `AGENTS.md` part 1 step 4 says). In a new terminal, `skydeck` must be found; if
   not, they add `export PATH="$HOME/.local/bin:$PATH"` to their `~/.zshrc` themselves. Then
   `skydeck doctor`: every line true on a Mac, no `problem` but those it explains.
2. In a scratch folder, `claude --verbose` (one flag, to be seen later): `skydeck ls` shows it
   `waiting`; a prompt makes it `working`; a permission question makes it `waiting` again, with what
   it waits for in `skydeck show`. This is M1's gate, seen for real: if it shows `running` instead,
   its live-session file was not trusted (skydeck's reading of the start differs from the file's):
   report it, as the failure it is. `skydeck show <its label or id prefix>` prints a line `holder:
   pid <n> since …` (without one, the hook got no `CLAUDE_PID` on this Mac: report it), and, if M3
   task 2 stores arguments, `launch:` names `--verbose`. If the form of `procStart` is UNSETTLED (M1
   task 3), one more session settles it: started as `TZ=Asia/Tokyo claude` in a scratch folder, it
   shows `waiting` or `working` when the form taken is right, and `running` when it is wrong: then
   report it and take the other form in the ONE place (`procStartOf`), on the stage branch.
3. `skydeck window`: a Chrome app window opens; its title is `skydeck`, its Dock icon; the session's
   terminal works; `skydeck window --print-url` opened in Chrome works too.
4. Keys: Ctrl+Shift with a letter (the window's keys), Ctrl+Tab, Cmd+C and Cmd+V in the terminal,
   Ctrl+Shift+V (Claude Code's image paste), an Option character of their layout, Ctrl+click and
   Cmd+click on a link in the terminal. Write down what does not work: that is the report's.
5. A notification: with the window in the background, a session finishes its turn. (macOS may ask to
   allow notifications for Chrome.)
6. Last, because it ends this session too: with two sessions open in the window, restart the Mac.
   Before they do, write "hands-on: step 6 next" into the status file and commit it. After the
   restart they start Claude Code in the clone you work in and say "read `docs/plans/mac-port.md`
   and go on"; you read the status file and ask them to run `skydeck window`: the restore offer
   appears, and restoring brings the sessions back.
7. Their choice: keep skydeck installed from the check clone (it stays as it is), or `skydeck
   uninstall` (then the check clone may be deleted). Later, once the port is merged, they clone the
   maintainer's repository (its `main`) and run `bin/skydeck install` there: install points the hook
   and the links at that clone and keeps skydeck's data; then the check clone may be deleted.

## 10. When to stop, and the final report

Stop and tell your human at once (then go on with what does not depend on it, if anything):

- anything you are about to do would break a rule of part 3;
- a fact found on the Mac makes a stage impossible, or contradicts a decision of part 6. The one to
  watch: if neither the UTC nor the local-time `procStart equals ps lstart` line of the probe says
  YES (for instance only the line in the Mac's own language does: Claude Code then writes names the
  one parser does not read), or `procStart` is digits, a number or missing on a Mac, skydeck cannot
  read a running session's start this way: stop M1's tasks 2 to 6 and all that needs them (M2a, M2b,
  M3), write it down, finish what does not (task 1, the texts of tasks 7 and 8, task 9); the
  maintainer decides. A YES in local time only is no stop, and both YES is no stop either: M1 task 3
  and 6.1 say how to read them;
- the suite is red on Linux (GitHub's checks) through the port's fault and you cannot fix it;
- a command asks for a password, a login or a `sudo`.

The final report (in this conversation, and as a comment on the last pull request, in public words):
the pull requests and what each does; what works on the Mac, and what does not; the skips left, with
their reasons; the hands-on results (or what stayed unchecked); what a Mac user misses (keys, words,
behaviour); the decisions of part 6 that the facts put in doubt; anything the maintainer must
decide.
