#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ARCANOS_BASE_URL:-http://localhost:8080}"
TREE_RESPONSE_FILE="$(mktemp)"
FILE_RESPONSE_FILE="$(mktemp)"
TRAVERSAL_RESPONSE_FILE="$(mktemp)"

cleanup() {
  rm -f "$TREE_RESPONSE_FILE" "$FILE_RESPONSE_FILE" "$TRAVERSAL_RESPONSE_FILE"
}

trap cleanup EXIT

# //audit Assumption: CI smoke coverage should validate the live HTTP contract instead of re-importing the full app under Jest; failure risk: unrelated unit-test debt masks route regressions; expected invariant: the running server can list files, read files, and reject path traversal; handling strategy: assert those contracts directly via curl.
curl -fsS "$BASE_URL/api/codebase/tree" -o "$TREE_RESPONSE_FILE"
node -e "const fs=require('fs'); const payload=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (payload?.status !== 'success') process.exit(1); const names=(payload?.data?.entries ?? []).map(entry => entry?.name); if (!names.includes('src') || !names.includes('package.json')) process.exit(1);" "$TREE_RESPONSE_FILE"

curl -fsS "$BASE_URL/api/codebase/file?path=README.md&startLine=1&endLine=5" -o "$FILE_RESPONSE_FILE"
node -e "const fs=require('fs'); const payload=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (payload?.status !== 'success') process.exit(1); if (payload?.data?.path !== 'README.md') process.exit(1); if (payload?.data?.binary !== false) process.exit(1); if (typeof payload?.data?.content !== 'string' || !payload.data.content.includes('# Arcanos Backend')) process.exit(1);" "$FILE_RESPONSE_FILE"

TRAVERSAL_STATUS="$(curl -sS -o "$TRAVERSAL_RESPONSE_FILE" -w "%{http_code}" "$BASE_URL/api/codebase/file?path=../package.json")"
if [ "$TRAVERSAL_STATUS" != "400" ]; then
  echo "Expected path traversal request to fail with 400, got $TRAVERSAL_STATUS"
  exit 1
fi

node -e "const fs=require('fs'); const payload=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (payload?.status !== 'error') process.exit(1); const message=String(payload?.message ?? ''); if (!message.toLowerCase().includes('outside')) process.exit(1);" "$TRAVERSAL_RESPONSE_FILE"
