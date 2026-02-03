#!/usr/bin/env bash
# Helper: set ARCANOS_AUTOMATION_SECRET via Railway CLI
# Usage: export ARC_SECRET=<secret-value> && ./scripts/railway-set-secret.sh [--project <projectId>] [--service <serviceId>]

if [ -z "$ARC_SECRET" ]; then
  echo "Please set ARC_SECRET environment variable (export ARC_SECRET=...)"
  exit 1
fi

# Ensure railway CLI available
if ! command -v railway >/dev/null 2>&1; then
  echo "railway CLI not found. Install from https://railway.app/docs/cli"
  exit 1
fi

# Build command arguments (optional project/service)
CMD_ARGS=(variables set ARCANOS_AUTOMATION_SECRET "$ARC_SECRET")

if [ "$1" = "--project" ] && [ -n "$2" ]; then
  CMD_ARGS+=(--project "$2")
  shift 2
fi

if [ "$1" = "--service" ] && [ -n "$2" ]; then
  CMD_ARGS+=(--service "$2")
  shift 2
fi

# Execute and check
if railway "${CMD_ARGS[@]}"; then
  echo "ARCANOS_AUTOMATION_SECRET set in Railway project. Redeploy or run 'railway up' to apply."
  exit 0
else
  echo "Failed to set variable via Railway CLI. Ensure you're logged in and have project context." >&2
  exit 2
fi