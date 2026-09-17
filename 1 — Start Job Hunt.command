#!/bin/bash
#
# Double-click to start the polling loop.
#
# Finder runs .command files in Terminal but starts them in your home directory
# rather than the project, so the cd below is load-bearing.
#
# If Telegram is unreachable — ASU campus wifi blocks it — this also stands up
# the local review page and prints a URL for your phone, because a blocked
# notification channel should not leave the one manual step in the pipeline with
# nowhere to happen.

cd "$(dirname "$0")" || exit 1

REVIEW_PID=""
cleanup() {
  [ -n "$REVIEW_PID" ] && kill "$REVIEW_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

clear
echo "──────────────────────────────────────────────"
echo "  JOB HUNT — polling loop"
echo "──────────────────────────────────────────────"
echo

if [ ! -f .env ]; then
  echo "  ✗ .env is missing. The loop cannot start without it."
  echo
  read -r -p "  Press return to close."
  exit 1
fi

# Fail fast with a readable message rather than a driver stack trace.
# Exit 2 means: usable, but Telegram is blocked on this network.
node scripts/preflight.mjs
PRE=$?
if [ "$PRE" -eq 1 ]; then
  read -r -p "  Press return to close."
  exit 1
fi

# The review page starts EVERY time, not only when Telegram is blocked.
#
# It used to be a fallback: exit 2 meant the network blocked api.telegram.org, so
# the page went up to keep the one manual step reachable. That framing was wrong.
# Telegram is a notification channel; the page is where triage actually happens —
# 120 jobs on one screen with j/k/a/s beats tapping through cards one at a time,
# and it works with no internet at all. Wanting it only when the other thing is
# broken is not the same as wanting it.
#
# LAN mode is unconditional too. It was tied to Telegram on the reasoning that a
# working Telegram already covers the phone — but Telegram sends one card at a time,
# and the phone is exactly where triaging a backlog in a spare ten minutes happens.
# Covering a use case badly is not covering it.
#
# The trade is real and worth stating: --lan binds 0.0.0.0, so every device on the
# wifi can reach the page. The token is what stops a stranger on campus wifi
# approving or binning applications, and loopback is exempt so this Mac never needs
# it. On home wifi that is a handful of trusted devices; on campus it is thousands
# of strangers holding a URL they do not have.
PORT="${REVIEW_PORT:-7777}"
mkdir -p logs

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  ──────────────────────────────────────────"
  echo "  A review server is already running."
  echo "    http://localhost:${PORT}/triage"
  echo "  ──────────────────────────────────────────"
  echo
else
  node scripts/review-server.mjs --lan > logs/review.log 2>&1 &
  REVIEW_PID=$!

  # Wait for the socket AND the token file. Printing a phone link before the token
  # exists gives out a URL that 403s, which reads as the page being broken.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && [ -s .review-token ] && break
    sleep 0.4
  done

  echo "  ──────────────────────────────────────────"
  if [ "$PRE" -eq 2 ]; then
    echo "  Telegram is blocked on this network — use the page instead."
  else
    echo "  Telegram is working. The review page is up as well."
  fi
  echo
  echo "    Triage (fast):  http://localhost:${PORT}/triage"
  echo "    Cards:          http://localhost:${PORT}"
  echo "    Applications:   http://localhost:${PORT}/applications"

  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  if [ -n "$IP" ] && [ -s .review-token ]; then
    URL="http://${IP}:${PORT}/triage?k=$(cat .review-token)"
    echo
    echo "    On your phone:  ${URL}"
    printf '%s' "$URL" | pbcopy 2>/dev/null && echo "                    (copied to clipboard)"
    echo
    echo "  Open it once and the link is remembered. Same wifi required — campus"
    echo "  networks often isolate clients, so if it times out use your hotspot."
  else
    echo
    echo "    (no wifi address found — the localhost links still work)"
  fi
  echo "  ──────────────────────────────────────────"
  echo
fi

# Keep the Mac awake while this runs. -i blocks idle sleep, -s blocks system
# sleep on AC power. Neither defeats the lid switch: a closed MacBook does not
# poll. Leave the lid open with the display brightness down.
caffeinate -is node scripts/run.mjs

echo
echo "  Loop stopped."
read -r -p "  Press return to close."
