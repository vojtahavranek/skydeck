#!/bin/sh
# Opens the key-test page in an Edge app window with its own profile folder.
# This starts a Windows program (msedge.exe) through WSL interop: run it yourself.
# usage: edge-app.sh [url] [windows-user]
# The profile folder is under the Windows user's folder; when several Windows users have an Edge
# folder, name yours as the second argument (as skydeck itself refuses to guess, S2 5.4).
URL="${1:-http://127.0.0.1:8765/}"
EDGE="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
if [ -n "${2:-}" ]; then
  WINHOME="/mnt/c/Users/$2"
  [ -d "$WINHOME/AppData/Local/Microsoft/Edge" ] || {
    echo "no Edge folder at $WINHOME/AppData/Local/Microsoft/Edge" >&2
    exit 1
  }
else
  WINHOME=""
  USERS=""
  for d in /mnt/c/Users/*/AppData/Local/Microsoft/Edge; do
    [ -d "$d" ] || continue
    h="${d%/AppData/Local/Microsoft/Edge}"
    if [ -n "$WINHOME" ]; then
      USERS="$USERS ${h##*/}"
      WINHOME="several"
    else
      WINHOME="$h"
      USERS="${h##*/}"
    fi
  done
  [ -n "$WINHOME" ] || { echo "cannot find your Windows profile under /mnt/c/Users" >&2; exit 1; }
  [ "$WINHOME" != "several" ] || {
    echo "several Windows users have an Edge folder ($USERS); name yours: sh edge-app.sh $URL <windows-user>" >&2
    exit 1
  }
fi
PROFILE=$(wslpath -w "$WINHOME/AppData/Local/skydeck-check/edge-profile")
echo "profile folder: $PROFILE"
exec "$EDGE" --app="$URL" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check
