#!/bin/bash
#
# Double-click to review and approve jobs in a browser.
#
# Default is this Mac only — nothing leaves the machine, so it works on campus
# wifi, a hotspot, or with no internet at all. That matters because ASU's network
# blocks Telegram, and the one manual step in the pipeline should not be hostage
# to a firewall rule nobody here controls.
#
# Choosing phone access binds to the wifi instead, guarded by a token. Approvals
# made here are indistinguishable from Telegram approvals; step 3 picks them up
# either way.
#
# Opens the keyboard lane, not the card page. The measured bottleneck is review
# rate — 263 jobs cleared the bar and are undecided — and the card page shows one
# job per screen-height, which is the right shape for deciding one job carefully
# and the wrong one for deciding two hundred. The cards are one click away in the
# page's own nav for anything that needs a closer look.

cd "$(dirname "$0")" || exit 1

clear
echo "──────────────────────────────────────────────"
echo "  REVIEW & APPROVE"
echo "──────────────────────────────────────────────"
echo

if [ ! -f .env ]; then
  echo "  ✗ .env is missing."
  read -r -p "  Press return to close."
  exit 1
fi

PORT="${REVIEW_PORT:-7777}"

echo "  Keys:  j k  move      a  apply      s  skip"
echo "         w    why it scored that      r  the resume this job would get"
echo "         o    open the posting        u  undo"
echo
echo "  Filter buttons at the top narrow by H-1B history, role and score."
echo "  Nothing on the page calls a model, so a long session costs nothing."
echo
echo "  1) This Mac only          (default, nothing leaves the machine)"
echo "  2) This Mac + my phone    (same wifi, token-protected)"
echo
read -r -p "  Choose [1]: " MODE
MODE=${MODE:-1}
echo

if [ "$MODE" = "2" ]; then
  # Put the phone URL on the clipboard. With Universal Clipboard it lands on the
  # iPhone immediately, which beats typing a 24-character token by hand.
  #
  # The phone gets the card page rather than the triage lane: triage is driven
  # entirely by a physical keyboard, and on a phone it degrades to a list with no
  # way to act on it.
  ( sleep 3
    IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
    if [ -n "$IP" ] && [ -f .review-token ]; then
      printf 'http://%s:%s/?k=%s' "$IP" "$PORT" "$(cat .review-token)" | pbcopy
      echo "  (phone link copied to your clipboard)"
    fi
    open "http://localhost:${PORT}/triage" ) &
  node scripts/review-server.mjs --lan
else
  ( sleep 2; open "http://localhost:${PORT}/triage" ) &
  node scripts/review-server.mjs
fi

echo
read -r -p "  Press return to close."
