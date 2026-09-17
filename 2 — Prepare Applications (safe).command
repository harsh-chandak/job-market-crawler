#!/bin/bash
#
# Double-click to process everything you approved on Telegram.
#
# This is a DRY RUN and cannot submit anything. It tailors a resume, renders the
# PDF, opens each application form, fills every field it can, answers the
# work-authorisation questions, screenshots the result, and stops immediately
# before the submit button.

cd "$(dirname "$0")" || exit 1

clear
echo "──────────────────────────────────────────────"
echo "  PREPARE APPLICATIONS — dry run, nothing is sent"
echo "──────────────────────────────────────────────"
echo

# Fail fast with a readable message rather than a driver stack trace.
# Telegram is irrelevant here: approvals come from the database, whether they
# were made in Telegram or on the local review page.
if ! node scripts/preflight.mjs --skip-telegram; then
  read -r -p "  Press return to close."
  exit 1
fi
echo

node scripts/submit-queue.mjs --limit 10

echo
echo "  Review the screenshots and PDFs in the out/ folder."
echo "  Anything with 'unanswered required' needs you to write those"
echo "  answers yourself — they are essay questions, not form fields."
echo
read -r -p "  Press return to close (this will open out/)."
open out/
