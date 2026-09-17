#!/usr/bin/env bash
#
# Install the polling loop as a macOS LaunchAgent.
#
#   ./ops/install.sh          install and start
#   ./ops/install.sh remove   stop and uninstall
#
# Idempotent: re-running reinstalls cleanly over an existing job.

set -euo pipefail

LABEL="com.harsh.jobhunt"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "remove" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST_DST}"
  echo "removed ${LABEL}"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

if [[ ! -f "${PROJECT}/.env" ]]; then
  echo "${PROJECT}/.env is missing — the loop cannot start without it" >&2
  exit 1
fi

mkdir -p "${PROJECT}/logs" "${HOME}/Library/LaunchAgents"

sed -e "s|__HOME__|${HOME}|g" -e "s|__NODE__|${NODE_BIN}|g" \
  "${PLIST_SRC}" > "${PLIST_DST}"

# bootout first so a re-run replaces rather than conflicts
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${PLIST_DST}"
launchctl enable "${DOMAIN}/${LABEL}"

echo "installed ${LABEL}"
echo "  node    ${NODE_BIN}"
echo "  project ${PROJECT}"
echo "  logs    ${PROJECT}/logs/jobhunt.log"
echo
echo "tail -f ${PROJECT}/logs/jobhunt.log"
