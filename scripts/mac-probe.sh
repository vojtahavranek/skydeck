#!/bin/sh
# skydeck's Mac probe: prints the facts about this Mac that a Mac version of skydeck needs
# (docs/plans/mac-port.md, step 0). Run it from a clone of skydeck:
#
#     sh scripts/mac-probe.sh
#
# It changes nothing: it writes no file, installs nothing, starts no Claude Code session and reads
# no settings file and no transcript. It reads the answers of system commands (uname, sw_vers,
# sysctl, ps, date, the --version of a few programs) and Claude Code's small live-session files
# (<Claude Code's folder>/sessions/<pid>.json), of which it prints only the field names and the
# form of the values. Run inside Claude Code, it reads the live-session file of the Claude Code it
# runs under; run in a plain terminal, the newest three.
#
# It never runs /usr/bin/python3 or /usr/bin/git when they are only Apple's stubs, which open the
# "install the developer tools" window. Every program it starts is ended after five seconds at the
# latest (where perl exists; macOS has shipped it so far).
#
# Its output is meant to be pasted into a public pull request. It shows no value as it is but
# version numbers, counts, lengths, yes or no, and words from fixed lists; everything else is
# masked: letters become a or A, digits 9, and any other character but plain punctuation ?.
# Read the output before you send it anyway.

PROBE_VERSION=1

say() { printf '%s: %s\n' "$1" "$2"; }
section() { printf '\n--- %s ---\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Letters to a or A, digits to 9, anything that is not printable ASCII to ?.
mask() {
  LC_ALL=C sed -e 's/[^ -~]/?/g' -e 's/[a-z]/a/g' -e 's/[A-Z]/A/g' -e 's/[0-9]/9/g'
}

# The first version number (digits and dots, as in 24.12.0) in a text; nothing when it has none.
version_number() {
  printf '%s\n' "$1" | LC_ALL=C sed -n 's/^[^0-9]*\([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p' |
    head -n 1
}

# The first argument when it is one of the others, else "other".
one_of() {
  value=$1
  shift
  for word in "$@"; do
    if [ "$value" = "$word" ]; then
      printf '%s' "$value"
      return
    fi
  done
  printf 'other'
}

# Folder names a program's path may show as they are.
known_folders='~ bin sbin usr local opt homebrew Cellar libexec lib share .local .nvm .volta .bun'
known_folders="$known_folders .npm-global .asdf .cargo installs shims versions node nodejs python3"
known_folders="$known_folders python git gh zsh perl claude Library Frameworks Python.framework"
known_folders="$known_folders Versions Current Applications Xcode.app Contents Developer"
known_folders="$known_folders CommandLineTools"

# A program's path: the home folder as ~, and every folder name masked but the known ones and
# version numbers.
tidy_path() {
  path=$1
  case $HOME in
    /?*)
      case $path in
        "$HOME"/*) path="~${path#"$HOME"}" ;;
      esac
      ;;
  esac
  printf '%s\n' "$path" | LC_ALL=C awk -F/ -v OFS=/ -v known="$known_folders" '
    BEGIN { n = split(known, words, " "); for (i = 1; i <= n; i++) plain[words[i]] = 1 }
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "" || ($i in plain) || $i ~ /^(v[0-9]+(\.[0-9]+)*|[0-9]+(\.[0-9]+)+)$/) continue
        gsub(/[^ -~]/, "?", $i); gsub(/[a-z]/, "a", $i); gsub(/[A-Z]/, "A", $i); gsub(/[0-9]/, "9", $i)
      }
      print
    }'
}

# Runs a command so that it ends after 5 seconds at the latest (where perl exists).
limited() {
  if have perl; then perl -e 'alarm 5; exec @ARGV or exit 127' "$@"; else "$@"; fi
}

# label, then a command: its answer masked, or that it failed.
masked() {
  label=$1
  shift
  if out=$(limited "$@" 2>/dev/null </dev/null); then
    say "$label" "[$(printf '%s' "$out" | mask)]"
  else
    say "$label" "failed (exit $?)"
  fi
}

# label, then a command: the first version number in its answer, or that it failed.
number() {
  label=$1
  shift
  if out=$(limited "$@" 2>/dev/null </dev/null); then
    v=$(version_number "$out")
    say "$label" "${v:-no number in its answer}"
  else
    say "$label" "failed (exit $?)"
  fi
}

# Apple's stubs of python3 and git live in /usr/bin. (The suite's test points this at a folder of
# its own; nothing else may.)
stub_dir=/usr/bin
if [ "${SKYDECK_TEST_NO_WINDOWS-}" = 1 ] && [ -n "${SKYDECK_TEST_STUB_DIR-}" ]; then
  stub_dir=$SKYDECK_TEST_STUB_DIR
fi

is_mac=no
if [ "$(limited uname -s 2>/dev/null </dev/null)" = Darwin ]; then is_mac=yes; fi

# xcode-select -p only prints the developer folder (or fails); it installs nothing.
devdir=
if have xcode-select; then devdir=$(limited xcode-select -p 2>/dev/null </dev/null); fi

python3_run=
version_of() {
  prog=$(command -v "$1" 2>/dev/null) || {
    say "$1" "not found"
    return
  }
  run=$prog
  if [ "$is_mac" = yes ] && [ "$prog" = "$stub_dir/$1" ]; then
    case $1 in
      python3 | git)
        if [ -n "$devdir" ] && [ -x "$devdir/usr/bin/$1" ]; then
          run=$devdir/usr/bin/$1
        else
          say "$1" "only Apple's stub (no developer tools found); not run"
          return
        fi
        ;;
    esac
  fi
  if [ "$1" = python3 ]; then python3_run=$run; fi
  out=$(limited "$run" --version 2>/dev/null </dev/null)
  v=$(version_number "$out")
  say "$1" "${v:-no version number in its answer}  ($(tidy_path "$prog"))"
}

printf '=== skydeck mac probe %s ===\n' "$PROBE_VERSION"

section "system"
say "this is a Mac" "$is_mac"
say "kernel" "$(one_of "$(limited uname -s 2>/dev/null </dev/null)" Darwin Linux) $(version_number "$(limited uname -r 2>/dev/null </dev/null)")"
say "machine" "$(one_of "$(limited uname -m 2>/dev/null </dev/null)" arm64 x86_64 aarch64)"
if have sw_vers; then number "macOS" sw_vers -productVersion; else say "macOS" "no sw_vers here"; fi
if [ -n "$devdir" ] && [ -d "$devdir" ]; then
  say "developer tools" "found ($(tidy_path "$devdir"))"
else
  say "developer tools" "not found"
fi
say "login shell" "$(one_of "$(basename "${SHELL:-unknown}")" zsh bash sh fish dash ksh tcsh)"
say "terminal program" "$(one_of "${TERM_PROGRAM:-not set}" "not set" Apple_Terminal iTerm.app vscode WezTerm ghostty tmux WarpTerminal Hyper Tabby kitty Alacritty)"
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then say "XDG_RUNTIME_DIR" "set"; else say "XDG_RUNTIME_DIR" "not set"; fi
if [ -n "${TMPDIR:-}" ]; then
  real_tmp=$(cd "$TMPDIR" 2>/dev/null && pwd -P)
  say "TMPDIR" "set, ${#TMPDIR} bytes, ${#real_tmp} bytes without links"
else
  say "TMPDIR" "not set"
fi
case $HOME in
  /?*)
    # A window terminal's socket: <home>/.local/state/skydeck/run-<8>/terms/<12>.sock
    say "a terminal socket's path under this home" "$((${#HOME} + 58)) bytes (a Mac allows 103)"
    ;;
  *) say "HOME" "not an absolute path" ;;
esac
case ":$PATH:" in
  *":$HOME/.local/bin:"*) say "PATH holds ~/.local/bin" "yes" ;;
  *) say "PATH holds ~/.local/bin" "no" ;;
esac

section "programs"
version_of node
if have node; then
  if out=$(limited node -e "try{require('node:sqlite');console.log('yes')}catch(e){console.log('no')}" 2>/dev/null </dev/null); then
    say "node:sqlite" "$(one_of "$out" yes no)"
  else
    say "node:sqlite" "failed"
  fi
fi
version_of python3
if [ -n "$python3_run" ]; then
  # Yes or no for each fact the window's terminals need of python3 on a Mac.
  facts=$(limited "$python3_run" -I -c '
import ctypes, resource, socket
libc = ctypes.CDLL(None)
print("SO_PEERCRED", "yes" if hasattr(socket, "SO_PEERCRED") else "no")
print("LOCAL_PEERCRED", "yes" if hasattr(socket, "LOCAL_PEERCRED") else "no")
print("getpeereid in libc", "yes" if hasattr(libc, "getpeereid") else "no")
print("prctl in libc", "yes" if hasattr(libc, "prctl") else "no")
print("sysctlbyname in libc", "yes" if hasattr(libc, "sysctlbyname") else "no")
print("RLIMIT_CORE", "yes" if hasattr(resource, "RLIMIT_CORE") else "no")
' 2>/dev/null </dev/null)
  for fact in SO_PEERCRED LOCAL_PEERCRED "getpeereid in libc" "prctl in libc" "sysctlbyname in libc" RLIMIT_CORE; do
    answer=$(printf '%s\n' "$facts" | sed -n "s/^$fact //p" | head -n 1)
    say "python3: $fact" "$(one_of "${answer:-unknown}" yes no unknown)"
  done
fi
version_of git
version_of zsh
version_of gh
if have perl; then number "perl" perl -e 'print $]'; else say "perl" "not found"; fi
for tool in sysctl ps vm_stat lsof open; do
  if path=$(command -v "$tool" 2>/dev/null); then
    say "$tool" "found ($(tidy_path "$path"))"
  else
    say "$tool" "not found"
  fi
done
if have vm_stat; then
  # Its lines with every digit as 9: the names of its counts are the system's own words. A line
  # with any other character than letters, digits, spaces and . : ( ) " - is masked whole.
  limited vm_stat 2>/dev/null </dev/null | head -n 30 |
    LC_ALL=C sed -e 's/[^ -~]/?/g' -e 's/[0-9]/9/g' -e '/[^A-Za-z9 .:()"-]/s/[A-Za-z]/a/g' -e 's/^/vm_stat: /'
fi

section "time"
masked "date +%s%N" date +%s%N
masked "date -u" date -u +%Y-%m-%dT%H:%M:%SZ
if have zsh; then
  # $EPOCHREALTIME is zsh's, not this shell's.
  # shellcheck disable=SC2016
  masked "zsh EPOCHREALTIME" zsh -fc 'zmodload zsh/datetime && print -r -- $EPOCHREALTIME'
else
  say "zsh EPOCHREALTIME" "no zsh"
fi
if have perl; then masked "perl Time::HiRes" perl -MTime::HiRes=time -e 'printf "%.6f", time'; fi

section "boot identity (masked)"
if have sysctl; then
  masked "kern.bootsessionuuid" sysctl -n kern.bootsessionuuid
  masked "kern.boottime" sysctl -n kern.boottime
else
  say "sysctl" "not found"
fi

section "process facts of this script's own shell (masked)"
masked "ps lstart" env LC_ALL=C TZ=UTC ps -o lstart= -p $$
masked "ps ppid,lstart" env LC_ALL=C TZ=UTC ps -o ppid=,lstart= -p $$
first=$(limited env LC_ALL=C TZ=UTC ps -o lstart= -p $$ 2>/dev/null </dev/null)
second=$(limited env LC_ALL=C TZ=UTC ps -o lstart= -p $$ 2>/dev/null </dev/null)
if [ -n "$first" ] && [ "$first" = "$second" ]; then
  say "ps lstart the same in two calls" "yes"
else
  say "ps lstart the same in two calls" "no"
fi
masked "ps tty" ps -o tty= -p $$
masked "ps command" ps -ww -o command= -p $$
if have perl; then
  printf 'ps cost: '
  # The program is perl's: its $ are perl's, not this shell's.
  # shellcheck disable=SC2016
  limited perl -MTime::HiRes=time -e '
    my $pid = shift;
    my $t = time;
    for (1 .. 20) { my $o = `LC_ALL=C TZ=UTC ps -o lstart= -p $pid 2>/dev/null`; }
    printf "%.1f ms per call (20 calls)\n", (time - $t) * 1000 / 20;
  ' $$ 2>/dev/null || echo "failed"
  printf 'ps snapshot cost: '
  # The program is perl's: its $ are perl's, not this shell's.
  # shellcheck disable=SC2016
  limited perl -MTime::HiRes=time -e '
    my $t = time;
    my @l = `LC_ALL=C TZ=UTC ps -A -o pid=,ppid=,lstart= 2>/dev/null`;
    printf "%.1f ms for %d processes\n", (time - $t) * 1000, scalar @l;
  ' 2>/dev/null || echo "failed"
fi

section "Claude Code"
if claude_path=$(command -v claude 2>/dev/null); then
  # --version starts no session; it ends after 5 seconds at the latest.
  out=$(limited claude --version 2>/dev/null </dev/null)
  v=$(version_number "$out")
  say "claude" "${v:-no version number in its answer}  ($(tidy_path "$claude_path"))"
else
  say "claude" "not found on PATH"
fi
# Whether each variable Claude Code is known to set is here, and how many other CLAUDE* ones are:
# a variable's name too can tell about this Mac's setup.
LC_ALL=C awk 'BEGIN {
  n = split("CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CONFIG_DIR CLAUDE_PROJECT_DIR CLAUDE_ENV_FILE", known, " ")
  for (i = 1; i <= n; i++) { seen[known[i]] = 1; print known[i] " here: " ((known[i] in ENVIRON) ? "yes" : "no") }
  other = 0
  for (k in ENVIRON) if (k ~ /^CLAUDE/ && !(k in seen)) other++
  print "other CLAUDE* variables here: " other
}'
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  say "CLAUDE_CONFIG_DIR" "set"
  claude_home=$CLAUDE_CONFIG_DIR
else
  say "CLAUDE_CONFIG_DIR" "not set"
  claude_home="$HOME/.claude"
fi

section "Claude Code's live-session files (field names; values masked)"
sessions="$claude_home/sessions"
# The live-session files of the Claude Code processes this script runs under: the folders of
# processes up the chain of parents (at most 30 steps).
own=
pid=$$
steps=0
while [ "$steps" -lt 30 ]; do
  steps=$((steps + 1))
  parent=$(limited ps -o ppid= -p "$pid" 2>/dev/null </dev/null | tr -d ' ')
  case $parent in
    '' | *[!0-9]*) break ;;
  esac
  if [ "$parent" -le 1 ]; then break; fi
  if [ -f "$sessions/$parent.json" ]; then own="$own $parent"; fi
  pid=$parent
done
if [ ! -d "$claude_home" ]; then
  say "Claude Code's folder" "not there"
elif [ ! -d "$sessions" ]; then
  say "its sessions folder" "not there"
elif ! have perl; then
  say "its sessions folder" "there, but perl was not found: files not read"
else
  count=0
  for entry in "$sessions"/*.json; do
    case ${entry##*/} in
      .json | *[!0-9]*.json) ;;
      *) if [ -f "$entry" ]; then count=$((count + 1)); fi ;;
    esac
  done
  say "its sessions folder" "there, $count live-session files"
  if [ -n "$own" ]; then
    say "read" "the live-session file of the Claude Code this script runs under"
  else
    say "read" "no Claude Code among this script's parents: the newest three live-session files"
  fi
  # The program holds no single quote, so that it can be given to perl as one argument. $own is
  # a list of process numbers, split into words on purpose.
  # shellcheck disable=SC2016,SC2086
  limited perl -e '
use strict;
use warnings;
my ($dir, @own) = @ARGV;
if (!eval { require JSON::PP; 1 }) { print "JSON::PP is not available: files not read\n"; exit 0; }
sub mask {
  my $s = shift;
  $s =~ s/[^\x20-\x7e]/?/g; $s =~ s/[a-z]/a/g; $s =~ s/[A-Z]/A/g; $s =~ s/[0-9]/9/g;
  return $s;
}
# The words a field may show; any other value is "(other)".
my %words = (
  kind => { map { $_ => 1 } qw(interactive bg) },
  status => { map { $_ => 1 } qw(idle busy waiting shell) },
  entrypoint => { map { $_ => 1 } qw(cli sdk-cli sdk-ts sdk-py claude-vscode claude-desktop) },
  nameSource => { map { $_ => 1 } qw(user auto) },
);
sub word { my ($k, $s) = @_; return $words{$k}{$s} ? $s : "(other)"; }
# What ps says of a process: read in English and UTC (as skydeck reads it); with "local", in
# English and the local time; with "own", in the language and local time of this Mac.
sub ps {
  my ($what, $pid, $how) = @_;
  my $env = !defined $how ? "LC_ALL=C TZ=UTC " : $how eq "local" ? "LC_ALL=C " : "";
  my $o = `${env}ps -ww -o $what= -p $pid 2>/dev/null`;
  $o = "" if !defined $o;
  $o =~ s/^\s+|\s+$//g;
  return $o;
}
# Only files named after a process number: the folder holds other files (credentials) too.
my @files;
if (@own) {
  @files = map { "$_.json" } @own;
} else {
  opendir(my $d, $dir) or do { print "cannot open the folder\n"; exit 0; };
  @files = grep { /\A[0-9]+\.json\z/ && -f "$dir/$_" } readdir($d);
  closedir($d);
  @files = sort { ((stat("$dir/$b"))[9] || 0) <=> ((stat("$dir/$a"))[9] || 0) } @files;
  splice(@files, 3) if @files > 3;
}
print "no live-session file in the folder (is a Claude Code session open?)\n" if !@files;
# Program names that may be named; any other is "(other)".
my %prog = map { $_ => 1 } qw(claude node bun deno sh bash zsh env);
# Options of claude that may be named; any other word of the arguments is only counted.
my %option = map { $_ => 1 } qw(-p -c -r -n --print --continue --resume --model --verbose --debug
  --session-id --settings --mcp-config --strict-mcp-config --add-dir --permission-mode
  --dangerously-skip-permissions --name --output-format --input-format --system-prompt
  --append-system-prompt --allowedTools --disallowedTools --fork-session --ide --agents);
my $n = 0;
for my $f (@files) {
  $n++;
  print "file $n, name [", mask($f), "]\n";
  my $text = do { local $/; open(my $fh, "<", "$dir/$f") or do { print "  cannot read\n"; next; }; <$fh> };
  my $j = eval { JSON::PP->new->decode($text) };
  if (ref($j) ne "HASH") { print "  not a JSON object (", length($text), " bytes)\n"; next; }
  for my $k (sort keys %$j) {
    my $v = $j->{$k};
    my $name = $k =~ /\A[A-Za-z_][A-Za-z0-9_]{0,40}\z/ ? $k : mask($k);
    my $type = $text =~ /"\Q$k\E"\s*:\s*"/ ? "text" : "not text";
    my $value;
    if (!defined $v) { $value = "null"; }
    elsif (ref($v) eq "HASH") { $value = "object with " . scalar(keys %$v) . " fields"; }
    elsif (ref($v) eq "ARRAY") { $value = "list with " . scalar(@$v) . " items"; }
    elsif (JSON::PP::is_bool($v)) { $value = $v ? "true" : "false"; }
    elsif ($words{$k}) { $value = "[" . word($k, "$v") . "]"; }
    else { $value = "[" . mask("$v") . "]"; }
    print "  $name ($type): $value\n";
  }
  my $pid;
  if (defined $j->{pid} && !ref($j->{pid}) && $j->{pid} =~ /\A[0-9]+\z/) { $pid = $j->{pid}; }
  elsif ($f =~ /\A([0-9]+)\.json\z/) { $pid = $1; }
  if (!defined $pid) { print "  no process number in the file or in its name\n"; next; }
  print "  its process number equals its name: ", ($f eq "$pid.json" ? "YES" : "NO"), "\n";
  if (defined $ENV{CLAUDE_PID}) {
    print "  CLAUDE_PID is its process number: ", ($ENV{CLAUDE_PID} eq $pid ? "YES" : "NO"), "\n";
  }
  my $start = ps("lstart", $pid);
  if ($start eq "") { print "  its process: not running now\n"; next; }
  print "  ps lstart of its process: [", mask($start), "]\n";
  if (defined $j->{procStart} && !ref($j->{procStart})) {
    print "  procStart equals ps lstart: ", ($j->{procStart} eq $start ? "YES" : "NO"), "\n";
    print "  procStart equals ps lstart in local time: ", ($j->{procStart} eq ps("lstart", $pid, "local") ? "YES" : "NO"), "\n";
    print "  procStart equals ps lstart in the language and zone of this Mac: ", ($j->{procStart} eq ps("lstart", $pid, "own") ? "YES" : "NO"), "\n";
  }
  my $comm = ps("comm", $pid); $comm =~ s{.*/}{};
  my @words = split(/\s+/, ps("command", $pid));
  my $first = defined $words[0] ? $words[0] : ""; $first =~ s{.*/}{};
  print "  its command name [", ($prog{$comm} ? $comm : "(other)"), "], first word of its arguments [",
    ($prog{$first} ? $first : "(other)"), "], the same: ", ($first eq $comm ? "YES" : "NO"), "\n";
  print "  its tty: [", mask(ps("tty", $pid)), "]\n";
  my @known;
  my $other = 0;
  for my $w (@words[1 .. $#words]) {
    my $o = $w; $o =~ s/=.*//s;
    if ($option{$o}) { push @known, $o; } else { $other++; }
  }
  print "  its arguments as ps shows them: ", scalar(@words), " words; options: [@known]; other words: $other\n";
}
' "$sessions" $own </dev/null 2>/dev/null || echo "reading the files failed or took longer than 5 seconds"
fi

section "browsers"
for app in "Google Chrome" "Microsoft Edge" "Chromium" "Brave Browser" "Arc"; do
  if [ -d "/Applications/$app.app" ]; then
    say "$app" "in /Applications"
  elif [ -d "$HOME/Applications/$app.app" ]; then
    say "$app" "in ~/Applications"
  else
    say "$app" "not found"
  fi
done

printf '\n=== end. Nothing was changed. Read the lines above before you send them. ===\n'
