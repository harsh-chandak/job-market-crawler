#!/bin/bash
#
# Double-click to actually send applications.
#
# Two switches guard this: the --live flag and SUBMIT_LIVE_CONFIRM. A third
# guard is added here — you must type the word by hand — because a double-click
# is a much easier accident than a typed command, and an application cannot be
# recalled.

cd "$(dirname "$0")" || exit 1

clear
echo "──────────────────────────────────────────────"
echo "  ⚠  SUBMIT FOR REAL"
echo "──────────────────────────────────────────────"
echo
echo "  This SENDS applications. They cannot be recalled, and a bad one"
echo "  burns that employer."
echo
echo "  Only continue if you have reviewed out/*.png from step 2."
echo

read -r -p "  How many to submit? [default 3] " LIMIT
LIMIT=${LIMIT:-3}

echo
read -r -p "  Type  send  to confirm: " CONFIRM
if [ "$CONFIRM" != "send" ]; then
  echo
  echo "  Cancelled. Nothing was sent."
  read -r -p "  Press return to close."
  exit 0
fi

echo
# Fail fast with a readable message rather than a driver stack trace.
# Telegram is irrelevant here: approvals come from the database, whether they
# were made in Telegram or on the local review page.
if ! node scripts/preflight.mjs --skip-telegram; then
  read -r -p "  Press return to close."
  exit 1
fi
echo

SUBMIT_LIVE_CONFIRM=i-understand node scripts/submit-queue.mjs --live --limit "$LIMIT"

echo
read -r -p "  Press return to close."
