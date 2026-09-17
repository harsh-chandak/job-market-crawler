#!/bin/bash
#
# Double-click to work through the applications the automation cannot make.
#
# Workday and Amazon require an account with the employer before an application
# form exists at all. Some Greenhouse jobs sit behind branded careers pages the
# filler cannot reach. Those are marked correctly and then sit there, because a
# URL in a database and a hashed filename in out/ is not something you can work
# through.
#
# This opens each one for you: posting in the browser, tailored resume in Preview,
# standard answers on the clipboard. You fill the form; it records the outcome so
# the job leaves the queue either way.

cd "$(dirname "$0")" || exit 1

clear
echo "──────────────────────────────────────────────"
echo "  APPLY BY HAND"
echo "──────────────────────────────────────────────"
echo
echo "  For each job this opens:"
echo "    · the application page in your browser"
echo "    · the tailored resume in Preview (drag it into the form)"
echo "    · your standard answers on the clipboard"
echo
echo "  Press return when you have submitted, or s to skip."
echo

if [ ! -f .env ]; then
  echo "  ✗ .env is missing."
  read -r -p "  Press return to close."
  exit 1
fi

echo "  Checking which employers still need a one-time sign-in..."
echo
node scripts/account-status.mjs
echo
echo "──────────────────────────────────────────────"
echo "  Now walking the applications that are ready."
echo "──────────────────────────────────────────────"
echo
node scripts/apply-by-hand.mjs

echo
read -r -p "  Press return to close."
