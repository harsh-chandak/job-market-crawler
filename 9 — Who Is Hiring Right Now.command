#!/bin/bash
#
# Double-click to see which job boards are actively dropping roles.
#
# The loop moves a board to a 3-minute polling cadence when it detects a burst
# of new postings, and logs "⚡ 2 board(s) burst-posting" when it happens. That
# line names no board and scrolls away, so a board that flipped an hour ago is
# invisible even though it is still on the fast cadence.
#
# This reads the burst state directly: which boards, what they have posted in
# the last 24 hours, the best score among those, and how long each stays fast.
# One database query — no model, no network, no cost.
#
cd "$(dirname "$0")" || exit 1

echo
echo "──────────────────────────────────────────────"
echo "  Boards posting right now"
echo "──────────────────────────────────────────────"

node scripts/bursts.mjs

echo "  A board here is worth checking on the review page — these are the"
echo "  postings you can reach before anyone else."
echo
read -r -p "  Press return to close."
