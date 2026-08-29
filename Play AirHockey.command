#!/bin/bash
# Double-click me in Finder to play. Closing this window stops both servers.
#
# Starts the two things the game wants running locally and opens the browser at
# the first one:
#
#   vite    http://localhost:5173   the game, with hot reload
#   helper  http://127.0.0.1:5178   what the Edit button talks to
#
# The helper writes its content folder into whatever directory it starts in, so
# this pins the working directory to the project. Started from the home folder
# instead, a designer's saves land in ~/airhockey-content and the game appears
# not to have loaded them.
cd "$(dirname "$0")" || exit 1

# Vite needs node on PATH; Finder-launched scripts don't get a login shell's PATH.
for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node/$(cat "$HOME/.nvm/alias/default" 2>/dev/null)/bin"; do
  [ -x "$candidate/node" ] && PATH="$candidate:$PATH"
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Couldn't find node. Install it from https://nodejs.org and try again."
  read -r -p "Press return to close."
  exit 1
fi

[ -d node_modules ] || npm install || { read -r -p "npm install failed. Press return to close."; exit 1; }

# True when something is already listening, so a second copy is not started on
# top of it — the helper exits with an unhandled EADDRINUSE if it is, and the
# stack trace buries everything else in the window.
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# The two servers are started directly rather than through `npm run dev` and
# `npm run editor`, so that the pids below are the servers themselves. Started
# through npm they would be npm's, and stopping this script would leave the
# node processes it wrapped still holding both ports.

pids=""
cleanup() { [ -n "$pids" ] && kill $pids 2>/dev/null; }
trap cleanup EXIT INT TERM

if listening 5178; then
  echo "An editor helper is already running on 5178 — leaving it alone."
  echo "  (If the Edit button saves somewhere unexpected, that one was started"
  echo "   from a different folder. Quit it and run this again.)"
else
  node tools/editor-server.mjs &          # npm run editor
  pids="$pids $!"
fi

if listening 5173; then
  echo "Something is already serving 5173 — opening that rather than a second copy."
else
  ./node_modules/.bin/vite &             # npm run dev
  pids="$pids $!"
fi

echo
if [ -z "$pids" ]; then
  # Nothing of ours to hold on to, so do not claim the window: it opens the
  # browser and gets out of the way.
  echo "Both were already up — just opening the game."
else
  echo "Starting AirHockey — the browser will open in a moment."
  echo "Leave this window open while you play; close it or press Ctrl-C to stop."
fi
echo

# Wait for the page to actually answer before opening it: a browser pointed at a
# port Vite has not bound yet shows a connection error and does not retry.
for _ in $(seq 1 80); do
  curl -fs -o /dev/null http://localhost:5173/ 2>/dev/null && break
  sleep 0.25
done
open "http://localhost:5173/"

# Hold the window open for as long as either server is up. A no-op when both
# were already running and this started neither.
wait
