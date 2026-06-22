#!/usr/bin/env bash
# ask-queue.sh — Maranda activation ask queue wrapper
# Usage: bash bus/ask-queue.sh <can-send|enqueue|mark-replied|check-stale|status> [args...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec node "${FRAMEWORK_ROOT}/scripts/ask-queue.js" "$@"
