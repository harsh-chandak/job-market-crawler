#!/bin/bash
#
# Double-click to read employer replies and record what happened to each
# application — rejected, interview, assessment, offer, or just acknowledged.
#
# HOW TO GET THE MAIL HERE (no password goes anywhere, ever):
#
#   Easiest, a few at a time —
#     In Apple Mail, select the messages and drag them onto the "inbox" folder
#     inside job-hunt. macOS writes one .eml file per message.
#
#   Gmail in a browser, one message —
#     Open it, ⋮ menu → "Download message". Move the .eml into inbox/.
#
#   Everything at once —
#     Label the replies in Gmail (say "applications"), then Google Takeout →
#     Mail → select that label → export. Put the .mbox file in inbox/.
#     This reads .mbox directly; no need to split it.
#
# It reads inbox/ and nothing else. It never connects to a mail server, so
# there is no password to give it and nothing to revoke.
#
# The first run only reports. Nothing is written until you say so.
#
cd "$(dirname "$0")" || exit 1
mkdir -p inbox

echo
echo "──────────────────────────────────────────────"
echo "  Application outcomes from your mail"
echo "──────────────────────────────────────────────"

node scripts/import-status-emails.mjs

COUNT=$(ls -1 inbox 2>/dev/null | grep -ciE '\.(eml|mbox|txt)$' || echo 0)
if [ "$COUNT" -gt 0 ]; then
  echo
  read -r -p "  Record these outcomes? [y/N] " a
  case "$a" in
    [yY]*) echo; node scripts/import-status-emails.mjs --apply ;;
    *) echo "  Left unchanged." ;;
  esac
fi

echo
echo "  Anything under \"needs your eyes\" was NOT recorded — usually a company"
echo "  with several open applications where the mail names no role. Those are"
echo "  left for you rather than guessed at."
echo
read -r -p "  Press return to close."
