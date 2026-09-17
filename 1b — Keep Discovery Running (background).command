#!/bin/bash
#
# Double-click to keep the discovery loop running after you close this window.
#
# Step 1 runs discovery in the foreground: useful when you want to watch it, but
# it dies the moment the Terminal window closes. This starts the same loop
# detached, so polling continues while you triage, sleep, or close everything.
#
# The Mac is kept awake with caffeinate for as long as the loop runs, because a
# sleeping laptop polls no boards.
#
# Running this twice is safe — it checks the lockfile and refuses to start a
# second copy rather than fighting the first one.
#
cd "$(dirname "$0")" || exit 1

echo
echo "──────────────────────────────────────────────"
echo "  Discovery loop — background"
echo "──────────────────────────────────────────────"
echo

RUNNING=$(pgrep -f "node scripts/run.mjs" | head -1)

if [ -n "$RUNNING" ]; then
  echo "  Already running (pid $RUNNING)."
  echo
  echo "  Polling boards every 3 minutes. Nothing to do."
  echo
  echo "  To stop it:"
  echo "      pkill -f \"node scripts/run.mjs\""
  echo
  read -r -p "  Press return to close."
  exit 0
fi

# A lockfile with no live process behind it is a crash, not a running loop.
if [ -f .jobhunt.lock ]; then
  STALE=$(cat .jobhunt.lock 2>/dev/null)
  if ! ps -p "$STALE" >/dev/null 2>&1; then
    echo "  Clearing a stale lockfile from pid $STALE (that process is gone)."
    rm -f .jobhunt.lock
  fi
fi

mkdir -p logs
nohup caffeinate -is node scripts/run.mjs >> logs/run.log 2>&1 &
NEW=$!
sleep 4

if ps -p "$NEW" >/dev/null 2>&1; then
  echo "  Started (pid $NEW). It will keep polling after you close this window."
  # Say plainly whether this costs money, because that depends on one setting.
  if grep -qE "^SCORE_PER_CYCLE=0" .env 2>/dev/null; then
    echo
    echo "  Scoring is OFF (SCORE_PER_CYCLE=0), so this uses no API credit."
    echo "  New jobs appear under \"Newest found\" on the review page but will"
    echo "  not have a match score until you turn scoring back on."
  else
    echo
    echo "  Scoring is ON — this spends API credit as new jobs arrive."
  fi
else
  echo "  Failed to start. Last lines of logs/run.log:"
  tail -5 logs/run.log
fi

echo
echo "  Watch it:  tail -f logs/run.log"
echo "  Stop it:   pkill -f \"node scripts/run.mjs\""
echo
read -r -p "  Press return to close."
