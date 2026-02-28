#!/usr/bin/env bash
set -euo pipefail

# Run the focused API endpoint tests in single-threaded mode for stability
PORT_FOR_TESTS="${PORT:-8080}"
TEST_SERVER_BASE_URL="http://127.0.0.1:${PORT_FOR_TESTS}" npm test -- --runInBand --testPathPattern=codebase-api.test.ts
