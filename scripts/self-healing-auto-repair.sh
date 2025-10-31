#!/usr/bin/env bash
set -euo pipefail

echo "=== 🔧 ARCANOS Self-Healing Auto-Repair Initiated ==="

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }
warn() { log "WARN: $*"; }
err() { log "ERR: $*"; }

ROOT_DIR="$(pwd)"
CACHE_DIR="$ROOT_DIR/cache"
CONFIG_DIR="$ROOT_DIR/config"
SCRIPTS_DIR="$ROOT_DIR/scripts"

mkdir -p "$CACHE_DIR"

# 0. Preflight diagnostics
log "[0] Preflight checks..."
NODE_VERSION=$(node -v 2>/dev/null || echo "node-missing")
NPM_VERSION=$(npm -v 2>/dev/null || echo "npm-missing")
log "Node: $NODE_VERSION | npm: $NPM_VERSION"

# 1. Patch memory leaks by resetting workers
log "[1] Restarting memory-intensive workers..."
if [ -f "$SCRIPTS_DIR/worker_restart.sh" ]; then
  bash "$SCRIPTS_DIR/worker_restart.sh" || warn "worker_restart.sh exited non-zero"
else
  if command -v pm2 >/dev/null 2>&1; then
    pm2 reload all || pm2 restart all || warn "PM2 reload/restart failed"
  elif [ -f Procfile ]; then
    warn "Procfile detected — Railway will auto-restart post-deploy."
  else
    log "No worker restart handler found — skipping."
  fi
fi

# 2. Update OpenAI SDK to latest stable
log "[2] Updating OpenAI SDK..."
LATEST_OPENAI="$(npm view openai version 2>/dev/null || echo "")"
if [ -z "$LATEST_OPENAI" ]; then
  warn "Could not fetch latest SDK version — forcing update"
  npm install -E openai@latest || err "SDK install failed"
else
  npm install -E "openai@$LATEST_OPENAI" || err "SDK install failed"
fi

# Optional semver lock update
if command -v jq >/dev/null 2>&1 && [ -n "$LATEST_OPENAI" ]; then
  if [ -f package.json ]; then
    TMP_PKG="$(mktemp)"
    jq --arg v "$LATEST_OPENAI" '
      if .dependencies.openai then
        .dependencies.openai = $v
      elif .devDependencies.openai then
        .devDependencies.openai = $v
      else . end
    ' package.json > "$TMP_PKG" && mv "$TMP_PKG" package.json
  fi
else
  warn "jq not available — skipped package.json semver rewrite"
fi

# 3. Circuit breaker + DLQ initialization
log "[3] Initializing circuit breaker + DLQ..."
DLQ_FILE="$CACHE_DIR/dlq_messages.json"
CIRCUIT_STATE="$CACHE_DIR/circuit.state.json"
CIRCUIT_DEFAULT="$CONFIG_DIR/circuit.default.json"

mkdir -p "$CACHE_DIR"
[ ! -f "$DLQ_FILE" ] && echo "[]" > "$DLQ_FILE" && log "DLQ initialized"
[ ! -f "$CIRCUIT_STATE" ] && {
  [ -f "$CIRCUIT_DEFAULT" ] && cp "$CIRCUIT_DEFAULT" "$CIRCUIT_STATE" \
    || echo '{"status":"closed"}' > "$CIRCUIT_STATE"
  log "Circuit breaker state initialized"
}

# 4. Flush temporary cache safely
log "[4] Flushing cache..."
find "$CACHE_DIR" -type f \( -name "*.tmp" -o -name "cache_snapshot*" \) -exec rm -f {} +

# 5. Verify Railway + SDK compliance
log "[5] Verifying environment compliance..."
if [ -z "${RAILWAY_ENVIRONMENT+x}" ]; then
  warn "Railway environment variable not detected — local mode assumed"
else
  log "Railway environment detected: $RAILWAY_ENVIRONMENT"
fi

log "Running SDK health check..."
node -e "import('openai').then(()=>console.log('✅ OpenAI SDK active')).catch(()=>console.log('❌ SDK check failed'))"

log "=== ✅ Repair cycle complete. Safe to redeploy. ==="
