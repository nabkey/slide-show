#!/bin/bash
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$PATH"

# Keep the Mac awake for as long as the show runs. The in-page wake lock only
# covers the display while the tab is visible; this also holds off system and
# idle sleep, which is what actually ends a six-hour party slideshow. `exec`
# below keeps this shell's PID, so -w ties caffeinate to the server's lifetime.
caffeinate -dimsu -w $$ &

exec bun server.ts --open
