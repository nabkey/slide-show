#!/bin/bash
# Double-click launcher (macOS). Keep this Terminal window open during the show:
#  - keeps the Mac and its display awake (no sleep, no screen saver) while open
#  - restarts the slideshow server automatically if it ever stops; the open
#    browser page reconnects and carries on by itself
# Close the window (or press Ctrl-C) to stop everything.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

trap 'exit 0' INT TERM HUP

# -d display, -i idle sleep, -m disk, -s system sleep (on AC power); ends with this window
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dims -w $$ &
fi

open_flag=--open
while true; do
  started=$(date +%s)
  bun server.ts $open_flag
  code=$?
  open_flag=
  [ "$code" -eq 0 ] && break   # clean exit, e.g. it was already running in another window
  echo "$(date '+%H:%M:%S')  server stopped (exit $code) - restarting..."
  # back off if it is failing straight away, so a persistent fault doesn't spin
  if [ $(( $(date +%s) - started )) -lt 5 ]; then sleep 3; else sleep 0.5; fi
done
