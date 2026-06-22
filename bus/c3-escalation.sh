#!/usr/bin/env bash
# c3-escalation.sh — Lease decision escalation cron wrapper
# Usage: bash bus/c3-escalation.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec node "${FRAMEWORK_ROOT}/scripts/c3-escalation.js" "$@"
