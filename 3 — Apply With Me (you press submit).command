#!/bin/bash
#
# Double-click to work through the approved queue together.
#
# For each job: tailors the resume, renders the PDF, opens the real application
# form in a VISIBLE browser, fills every field it can, and then hands you the
# keyboard. You write the free-text answers and press submit yourself.
#
# The machine never submits in this mode, so it needs none of the live guards.

cd "$(dirname "$0")" || exit 1

clear
echo "──────────────────────────────────────────────"
echo "  APPLY WITH ME"
echo "──────────────────────────────────────────────"
echo
echo "  A browser opens for each approved job with the form already"
echo "  filled and your tailored resume attached."
echo
echo "  You write the essay answers and press submit."
echo "  Then come back here and press return for the next one."
echo

read -r -p "  How many? [default 5] " LIMIT
LIMIT=${LIMIT:-5}
echo

# Fail fast with a readable message rather than a driver stack trace.
# Telegram is irrelevant here: approvals come from the database, whether they
# were made in Telegram or on the local review page.
if ! node scripts/preflight.mjs --skip-telegram; then
  read -r -p "  Press return to close."
  exit 1
fi
echo

node scripts/submit-queue.mjs --handoff --limit "$LIMIT"

echo
read -r -p "  Press return to close."
