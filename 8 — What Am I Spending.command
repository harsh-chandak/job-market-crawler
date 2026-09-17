#!/bin/bash
#
# Double-click to see what the pipeline has actually cost.
#
# Every response from the API is written to logs/tokens.jsonl as it happens —
# input, cached input, output, and the dollar figure for that one call. This
# reads that file and nothing else. No database, no network, and it never calls
# the model, so checking the bill cannot add to it.
#
# The number to watch is "Output" under prompt caching. Output tokens cost five
# times input and are never cached, so they dominate the bill long before the
# input side does.
#
cd "$(dirname "$0")" || exit 1

echo
echo "──────────────────────────────────────────────"
echo "  What the job hunt has cost so far"
echo "──────────────────────────────────────────────"

node scripts/tokens.mjs --days 30

echo
read -r -p "  Press return to close."
