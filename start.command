#!/bin/bash
# Double-click this file to start the World Cup Predictor.
# It launches the server and opens the app in your browser.
# Close this Terminal window (or press Ctrl+C) to stop the server.

# Move to the folder this script lives in (so double-click works anywhere).
cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

# Make sure common Node install locations are on PATH (Terminal double-click
# can start with a minimal PATH).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ✗ Node.js was not found."
  echo "    Install it from https://nodejs.org and then double-click this again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

PORT="${PORT:-3000}"

# Open the browser a moment after the server starts (in the background).
( sleep 2; open "http://localhost:${PORT}" ) &

echo ""
echo "  ⚽  Starting World Cup Predictor on http://localhost:${PORT}"
echo "      Keep this window open. Close it (or Ctrl+C) to stop."
echo ""

# Start the server (stays in the foreground so closing the window stops it).
PORT="$PORT" node server.js
