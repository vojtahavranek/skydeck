#!/bin/sh
# Opens the key-test page in an Edge app window with its own profile folder.
# This starts a Windows program (msedge.exe) through WSL interop: run it yourself.
# usage: edge-app.sh [url]
URL="${1:-http://127.0.0.1:8765/}"
EDGE="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
WINHOME=""
for d in /mnt/c/Users/*/AppData/Local/Microsoft/Edge; do
  [ -d "$d" ] && WINHOME="${d%/AppData/Local/Microsoft/Edge}" && break
done
[ -n "$WINHOME" ] || { echo "cannot find your Windows profile under /mnt/c/Users" >&2; exit 1; }
PROFILE=$(wslpath -w "$WINHOME/AppData/Local/skydeck-check/edge-profile")
echo "profile folder: $PROFILE"
exec "$EDGE" --app="$URL" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check
