#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend-typescript"
DAEMON_DIR="$ROOT_DIR/daemon-python"

PORT="${PORT:-5000}"
HEALTH_URL="${ARCANOS_BACKEND_HEALTH_URL:-http://localhost:${PORT}/api/health}"
MAX_WAIT_SECONDS="${ARCANOS_BACKEND_WAIT_SECONDS:-30}"

echo "Starting backend (dev mode)..."
(cd "$BACKEND_DIR" && npm run dev) &
BACKEND_PID=$!

echo "Waiting for backend health check at $HEALTH_URL..."
for ((i = 0; i < MAX_WAIT_SECONDS; i++)); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      break
    fi
  else
    python - <<PY >/dev/null 2>&1 && break
import sys
import urllib.request
try:
    with urllib.request.urlopen("$HEALTH_URL", timeout=2):
        sys.exit(0)
except Exception:
    sys.exit(1)
PY
  fi
  sleep 1
done

echo "Starting daemon..."
(cd "$DAEMON_DIR" && python cli.py) &
DAEMON_PID=$!

cleanup() {
  kill "$BACKEND_PID" "$DAEMON_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait "$BACKEND_PID" "$DAEMON_PID"
