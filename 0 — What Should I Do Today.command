#!/bin/bash
#
# Double-click this first. It tells you which of the other files to open.
#
# There are seven launchers and the right one changes hourly. This reads the
# database and says what is actually waiting: applications ready to send, matches
# needing a decision, employers needing a one-time sign-in, whether the loop is
# even running.
#
# Costs nothing. Every number is already in the database; no model is called.

cd "$(dirname "$0")" || exit 1

clear
if [ ! -f .env ]; then
  echo "  ✗ .env is missing."
  read -r -p "  Press return to close."
  exit 1
fi

node scripts/today.mjs

echo "  ──────────────────────────────────────────────"
echo "   0  what should I do today   (this file)"
echo "   1  start the polling loop"
echo "   2  prepare applications     (dry run, nothing sent)"
echo "   3  apply with me            (you press submit)"
echo "   5  review & approve"
echo "   6  see my applications"
echo "   7  apply by hand            (account-gated employers)"
echo "  ──────────────────────────────────────────────"
echo
read -r -p "  Press return to close."
