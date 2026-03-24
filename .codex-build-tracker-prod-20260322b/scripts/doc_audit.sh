#!/usr/bin/env bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNINGS=0

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

check() {
  local description="$1"
  local condition="$2"
  local details="${3:-}"

  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  if eval "$condition"; then
    echo -e "${GREEN}PASS${NC}: ${description}"
    [[ -n "$details" ]] && echo "  $details"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
  else
    echo -e "${RED}FAIL${NC}: ${description}"
    [[ -n "$details" ]] && echo "  $details"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
  fi
}

warn() {
  local message="$1"
  echo -e "${YELLOW}WARN${NC}: ${message}"
  WARNINGS=$((WARNINGS + 1))
}

echo -e "${BLUE}Arcanos documentation audit${NC}"

required_files=(
  "README.md"
  "CONTRIBUTING.md"
  "CODE_OF_CONDUCT.md"
  "SECURITY.md"
  "CHANGELOG.md"
  ".github/PULL_REQUEST_TEMPLATE.md"
  ".github/PULL_REQUEST_TEMPLATE/hotfix.md"
  "docs/README.md"
  "docs/CONFIGURATION.md"
  "docs/API.md"
  "docs/RUN_LOCAL.md"
  "docs/RAILWAY_DEPLOYMENT.md"
  "docs/TROUBLESHOOTING.md"
  "docs/CI_CD.md"
  "docs/REFERENCES.md"
)

echo "Checking required files..."
for file in "${required_files[@]}"; do
  check "${file} exists" "[[ -f '${file}' ]]"
done

echo "Checking standard section structure..."
required_sections=(
  "## Overview"
  "## Prerequisites"
  "## Setup"
  "## Configuration"
  "## Run locally"
  "## Deploy \(Railway\)"
  "## Troubleshooting"
  "## References"
)

for file in "${required_files[@]}"; do
  if [[ -f "$file" ]]; then
    for section in "${required_sections[@]}"; do
      check "${file} has section: ${section}" "grep -Eq '${section}' '${file}'"
    done
  fi
done

echo "Checking stale terminology..."
check "No legacy OpenAI SDK v5.16.0 references" "! rg -n 'v5\\.16\\.0' README.md docs .github/ISSUE_TEMPLATE >/dev/null"
check "No X-Confirmation header wording" "! rg -n 'X-Confirmation' README.md docs .github/ISSUE_TEMPLATE >/dev/null"
check "No stale docs/api path references in issue templates" "! rg -n 'docs/api/' .github/ISSUE_TEMPLATE >/dev/null"
check "No stale docs/deployment path references in issue templates" "! rg -n 'docs/deployment/' .github/ISSUE_TEMPLATE >/dev/null"
check "No stale docs/ai-guides path references in issue templates" "! rg -n 'docs/ai-guides/' .github/ISSUE_TEMPLATE >/dev/null"

if rg -n 'TODO' README.md docs >/dev/null; then
  warn "TODO markers found in docs; ensure they are intentional and tracked"
fi

echo "Checking README link targets..."
if [[ -f README.md ]]; then
  while IFS= read -r link; do
    [[ -z "$link" ]] && continue
    [[ "$link" =~ ^https?:// ]] && continue
    link_no_anchor="${link%%#*}"
    [[ -z "$link_no_anchor" ]] && continue
    check "README link target exists: $link_no_anchor" "[[ -f '$link_no_anchor' || -d '$link_no_anchor' ]]"
  done < <(grep -oE '\[[^]]+\]\(([^)]+)\)' README.md | sed -E 's/.*\(([^)]+)\).*/\1/' | head -50)
fi

echo

echo "Total Checks: ${TOTAL_CHECKS}"
echo "Passed: ${PASSED_CHECKS}"
echo "Failed: ${FAILED_CHECKS}"
echo "Warnings: ${WARNINGS}"

if [[ "${FAILED_CHECKS}" -eq 0 ]]; then
  echo -e "${GREEN}Documentation audit passed${NC}"
  exit 0
fi

echo -e "${RED}Documentation audit failed${NC}"
exit 1
