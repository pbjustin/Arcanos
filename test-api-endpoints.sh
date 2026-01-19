#!/usr/bin/env bash
set -euo pipefail

# Run the focused API endpoint tests in single-threaded mode for stability
npm test -- --runInBand --testPathPattern=codebase-api.test.ts
