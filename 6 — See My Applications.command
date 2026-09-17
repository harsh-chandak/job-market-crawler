#!/bin/bash
#
# Double-click to see every application: submitted, waiting, and the ones the
# form-filler could not finish.
#
# Separate from step 5 on purpose. Step 5 asks "should I apply to this"; this asks
# "what happened to the ones I did". After a handoff run the only record was
# terminal output that scrolled away, so four failed applications sat unnoticed
# and their URLs were recoverable only by querying the database by hand.
#
# Reuses a review server if one is already up — step 1 starts one when Telegram is
# blocked, and step 5 starts one too. Binding a second process to the same port
# would fail and look like this script is broken.

cd "$(dirname "$0")" || exit 1

clear
echo "──────────────────────────────────────────────"
echo "  MY APPLICATIONS"
echo "──────────────────────────────────────────────"
echo

if [ ! -f .env ]; then
  echo "  ✗ .env is missing."
  read -r -p "  Press return to close."
  exit 1
fi

PORT="${REVIEW_PORT:-7777}"
URL="http://localhost:${PORT}/applications"

# Is a server already listening? If so just open the page and stay out of the way.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  A review server is already running on port ${PORT}."
  echo "  Opening ${URL}"
  echo
  # A LAN server needs the token; the cookie only exists if this browser has
  # visited before, so include it when we can rather than serving a 403.
  if [ -s .review-token ]; then
    open "${URL}?k=$(cat .review-token)" 2>/dev/null || open "$URL"
  else
    open "$URL"
  fi
  echo "  Leave the other window open — it is hosting this page."
  echo
  read -r -p "  Press return to close."
  exit 0
fi

echo "  Starting a local server. Nothing leaves this Mac."
echo
echo "    ${URL}"
echo
echo "  Groups:"
echo "    Needs you by hand   the filler could not finish these — apply yourself"
echo "    Waiting in queue    step 3 will open these with the form filled"
echo "    Submitted           applications that went out"
echo
echo "  Each row links to the posting and to the exact resume that was attached."
echo
echo "  Close this window when you are done looking."
echo "──────────────────────────────────────────────"
echo

( sleep 2; open "$URL" ) &
node scripts/review-server.mjs

echo
read -r -p "  Press return to close."
