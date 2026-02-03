#!/usr/bin/env bash
# Helper: set ARC ANOS_AUTOMATION_SECRET via Railway CLI
# Usage: export ARC_SECRET=<secret-value> && ./scripts/railway-set-secret.sh

if [ -z "$ARC_SECRET" ]; then
  echo "Please set ARC_SECRET environment variable (export ARC_SECRET=...)"
  exit 1
fi

# Ensure railway CLI available
if ! command -v railway >/dev/null 2>&1; then
  echo "railway CLI not found. Install from https://railway.app/docs/cli"
  exit 1
fi

# Set the variable in the current Railway project
railway variables set ARC ANOS_AUTOMATION_SECRET "$ARC_SECRET"

echo "Variable set in Railway project. Redeploy or run 'railway up' to apply."