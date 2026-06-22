#!/usr/bin/env bash
# chat-listener.sh — Pull Google Chat messages from Pub/Sub and route to reni's inbox
# Usage: bash bus/chat-listener.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec node "${FRAMEWORK_ROOT}/scripts/chat-listener.js" "$@"
