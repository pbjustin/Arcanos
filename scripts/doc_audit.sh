#!/bin/bash

# ARCANOS Documentation Audit Script
# Version: 1.0.0
# Last Updated: 2024-09-27
# Purpose: Validates documentation integrity, consistency, and completeness

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Audit results tracking
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNINGS=0

# Get project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo -e "${BLUE}🔍 ARCANOS Documentation Audit Starting...${NC}\n"
echo "Project Root: $PROJECT_ROOT"
echo "Timestamp: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "=============================================="

# Helper functions
check() {
    local description="$1"
    local condition="$2"
    local details="${3:-}"
    
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
    
    if eval "$condition"; then
        echo -e "✅ ${GREEN}PASS${NC}: $description"
        if [[ -n "$details" ]]; then
            echo "   $details"
        fi
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
        return 0
    else
        echo -e "❌ ${RED}FAIL${NC}: $description"
        if [[ -n "$details" ]]; then
            echo "   $details"
        fi
        FAILED_CHECKS=$((FAILED_CHECKS + 1))
        return 1
    fi
}

warn() {
    local message="$1"
    echo -e "⚠️  ${YELLOW}WARN${NC}: $message"
    WARNINGS=$((WARNINGS + 1))
}

info() {
    local message="$1"
    echo -e "ℹ️  ${BLUE}INFO${NC}: $message"
}

# 1. Required Files Existence Check
echo -e "\n📁 Required Documentation Files:"
echo "================================="

check "README.md exists" "[[ -f README.md ]]" "Primary project documentation"
check "CONTRIBUTING.md exists" "[[ -f CONTRIBUTING.md ]]" "Contributor guidelines"
check "CODE_OF_CONDUCT.md exists" "[[ -f CODE_OF_CONDUCT.md ]]" "Community standards"
check "CHANGELOG.md exists" "[[ -f CHANGELOG.md || -f docs/CHANGELOG.md ]]" "Version history tracking"

# 2. GitHub Templates Check
echo -e "\n📋 GitHub Template Structure:"
echo "============================="

check "Issue templates directory exists" "[[ -d .github/ISSUE_TEMPLATE ]]" "GitHub issue templates"
check "Bug report template exists" "[[ -f .github/ISSUE_TEMPLATE/bug_report.yml ]]" "Bug reporting workflow"
check "Feature request template exists" "[[ -f .github/ISSUE_TEMPLATE/feature_request.yml ]]" "Feature proposal workflow"
check "Documentation issue template exists" "[[ -f .github/ISSUE_TEMPLATE/documentation.yml ]]" "Documentation feedback"
check "Code of conduct template exists" "[[ -f .github/ISSUE_TEMPLATE/code_of_conduct.yml ]]" "Community violation reporting"
check "PR templates exist" "[[ -f .github/PULL_REQUEST_TEMPLATE.md ]]" "Pull request guidelines"
check "Hotfix PR template exists" "[[ -f .github/PULL_REQUEST_TEMPLATE/hotfix.md ]]" "Emergency fix workflow"

# 3. Documentation Content Validation
echo -e "\n📝 Content Standards Validation:"
echo "================================"

# Check for required sections in README.md
if [[ -f README.md ]]; then
    check "README has last-updated tag" "grep -q 'Last Updated:' README.md" "Version tracking requirement"
    check "README has version information" "grep -q 'Version:' README.md" "Release tracking"
    check "README has OpenAI SDK version" "grep -q 'OpenAI SDK.*v5\.16\.0' README.md" "Dependency version consistency"
    check "README has self-check section" "grep -q 'Self-Check' README.md" "Audit procedure embedded"
    check "README has architecture section" "grep -q -i 'architecture' README.md" "Technical overview present"
    check "README has fallback behaviors" "grep -q -i 'fallback' README.md" "Error handling documented"
else
    warn "README.md not found - skipping content validation"
fi

# Check for required sections in CONTRIBUTING.md
if [[ -f CONTRIBUTING.md ]]; then
    check "CONTRIBUTING has last-updated tag" "grep -q 'Last Updated:' CONTRIBUTING.md" "Version tracking requirement"
    check "CONTRIBUTING has self-check section" "grep -q 'Self-Check' CONTRIBUTING.md" "Contributor audit procedures"
    check "CONTRIBUTING has enforceability guidelines" "grep -q -i 'enforc' CONTRIBUTING.md" "CI-enforceable standards"
    check "CONTRIBUTING has documentation standards" "grep -q -i 'documentation.*standard' CONTRIBUTING.md" "Doc quality requirements"
else
    warn "CONTRIBUTING.md not found - skipping content validation"
fi

# Check for required sections in CODE_OF_CONDUCT.md
if [[ -f CODE_OF_CONDUCT.md ]]; then
    check "CODE_OF_CONDUCT has last-updated tag" "grep -q 'Last Updated:' CODE_OF_CONDUCT.md" "Version tracking requirement"
    check "CODE_OF_CONDUCT has self-check section" "grep -q 'Self-Check' CODE_OF_CONDUCT.md" "Community audit procedures"
    check "CODE_OF_CONDUCT has AI-specific guidelines" "grep -q -i 'AI' CODE_OF_CONDUCT.md" "AI development ethics"
else
    warn "CODE_OF_CONDUCT.md not found - skipping content validation"
fi

# 4. Terminology Consistency Check
echo -e "\n🔤 Terminology Standardization:"
echo "=============================="

# Check for consistent terminology across files
MISSPELLED_FILES=$(find . -name '*.md' -exec grep -l -i 'arkanos\|arcanous' {} \; 2>/dev/null | wc -l)
check "Consistent 'Arcanos' spelling" "[[ $MISSPELLED_FILES -eq 0 ]]" "Project name consistency"
check "Consistent 'AI-controlled' terminology" "grep -r -l 'AI-controlled' README.md CONTRIBUTING.md >/dev/null 2>&1" "Architecture terminology"

# Check OpenAI SDK version consistency
OUTDATED_SDK_FILES=$(find . -name '*.md' -exec grep -l 'OpenAI.*v[45]\.[0-9]' {} \; 2>/dev/null | grep -v 'v5\.16\.0' | wc -l)
check "OpenAI SDK version consistency" "[[ $OUTDATED_SDK_FILES -eq 0 ]]" "Dependency version alignment"

# 5. Link Validation
echo -e "\n🔗 Internal Link Validation:"
echo "==========================="

# Check for broken internal links in main documentation files
if command -v grep >/dev/null 2>&1; then
    # Find markdown files referenced in documentation
    if [[ -f README.md ]]; then
        while IFS= read -r link; do
            if [[ -n "$link" && "$link" != *"http"* ]]; then
                if [[ -f "$link" || -d "$link" ]]; then
                    echo -e "✅ ${GREEN}PASS${NC}: Link exists: $link"
                    PASSED_CHECKS=$((PASSED_CHECKS + 1))
                else
                    echo -e "❌ ${RED}FAIL${NC}: Broken link: $link"
                    FAILED_CHECKS=$((FAILED_CHECKS + 1))
                fi
                TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
            fi
        done < <(grep -oP '\[.*?\]\(\K[^)]*(?=\))' README.md 2>/dev/null | head -10)
    fi
else
    warn "grep not available - skipping link validation"
fi

# 6. Version Consistency Check
echo -e "\n🔢 Version Consistency:"
echo "======================"

# Extract version information and check consistency
if command -v jq >/dev/null 2>&1 && [[ -f package.json ]]; then
    PKG_VERSION=$(jq -r '.version' package.json 2>/dev/null || echo "unknown")
    check "Package.json version is valid" "[[ '$PKG_VERSION' != 'unknown' && '$PKG_VERSION' != 'null' ]]" "Version: $PKG_VERSION"
    
    # Check if README version matches package.json
    if grep -q "Version.*$PKG_VERSION" README.md 2>/dev/null; then
        echo -e "✅ ${GREEN}PASS${NC}: README version matches package.json"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "⚠️  ${YELLOW}WARN${NC}: README version may not match package.json ($PKG_VERSION)"
        WARNINGS=$((WARNINGS + 1))
    fi
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
else
    warn "jq not available or package.json missing - skipping version consistency check"
fi

# 7. Last-Updated Date Validation
echo -e "\n📅 Last-Updated Date Validation:"
echo "==============================="

# Function to check if date is recent (within 30 days)
check_date_freshness() {
    local file="$1"
    local date_pattern="$2"
    
    if [[ -f "$file" ]]; then
        local found_date
        found_date=$(grep -o "$date_pattern" "$file" 2>/dev/null | head -1 | grep -o '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' || echo "")
        
        if [[ -n "$found_date" ]]; then
            # Check if date is within last 30 days
            if command -v date >/dev/null 2>&1; then
                local file_date_epoch
                local current_epoch
                local days_diff
                
                file_date_epoch=$(date -d "$found_date" +%s 2>/dev/null || echo "0")
                current_epoch=$(date +%s)
                days_diff=$(( (current_epoch - file_date_epoch) / 86400 ))
                
                if [[ "$days_diff" -le 30 ]]; then
                    echo -e "✅ ${GREEN}PASS${NC}: $file date is recent ($found_date, $days_diff days ago)"
                    return 0
                else
                    echo -e "⚠️  ${YELLOW}WARN${NC}: $file date may be outdated ($found_date, $days_diff days ago)"
                    return 1
                fi
            else
                echo -e "ℹ️  ${BLUE}INFO${NC}: $file has date $found_date (date utility not available)"
                return 0
            fi
        else
            echo -e "❌ ${RED}FAIL${NC}: No valid date found in $file"
            return 1
        fi
    else
        echo -e "❌ ${RED}FAIL${NC}: $file does not exist"
        return 1
    fi
}

# Check dates in main files
for file in README.md CONTRIBUTING.md CODE_OF_CONDUCT.md; do
    if check_date_freshness "$file" "Last Updated.*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"; then
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        FAILED_CHECKS=$((FAILED_CHECKS + 1))
    fi
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
done

# 8. TODO and Fallback Logic Check
echo -e "\n📝 TODO and Fallback Documentation:"
echo "=================================="

# Count TODOs and check if they're properly documented
TODO_COUNT=$(find . -name "*.md" -exec grep -l "TODO\|FIXME\|XXX" {} \; 2>/dev/null | wc -l)
if [[ "$TODO_COUNT" -gt 0 ]]; then
    warn "Found $TODO_COUNT documentation files with TODOs - ensure they're tracked"
    find . -name "*.md" -exec grep -Hn "TODO\|FIXME\|XXX" {} \; 2>/dev/null | head -5
else
    info "No TODOs found in documentation files"
fi

# Check for fallback behavior documentation
FALLBACK_COUNT=$(find . -name "*.md" -exec grep -l -i "fallback" {} \; 2>/dev/null | wc -l)
check "Fallback behaviors documented" "[[ $FALLBACK_COUNT -gt 0 ]]" "Found in $FALLBACK_COUNT files"

# 9. CI Integration Validation
echo -e "\n🤖 CI Integration Check:"
echo "======================="

check "GitHub workflows directory exists" "[[ -d .github/workflows ]]" "CI/CD configuration"
check "Documentation audit workflow exists" "[[ -f .github/workflows/*doc* || -f .github/workflows/*audit* ]]" "Automated validation"

if [[ -d .github/workflows ]]; then
    WORKFLOW_COUNT=$(find .github/workflows -name "*.yml" -o -name "*.yaml" | wc -l)
    info "Found $WORKFLOW_COUNT GitHub Action workflows"
fi

# 10. Summary Report
echo -e "\n📊 AUDIT SUMMARY:"
echo "================"
echo "Timestamp: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "Total Checks: $TOTAL_CHECKS"
echo -e "Passed: ${GREEN}$PASSED_CHECKS${NC}"
echo -e "Failed: ${RED}$FAILED_CHECKS${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"

if [[ "$FAILED_CHECKS" -eq 0 ]]; then
    echo -e "\n🎉 ${GREEN}ALL CRITICAL CHECKS PASSED${NC} - Documentation is audit-compliant!"
    SUCCESS_RATE=$(echo "scale=1; $PASSED_CHECKS * 100 / $TOTAL_CHECKS" | bc -l 2>/dev/null || echo "100")
    echo "Success Rate: ${SUCCESS_RATE}%"
    exit 0
else
    echo -e "\n⚠️  ${YELLOW}SOME CHECKS FAILED${NC} - Review audit recommendations above"
    SUCCESS_RATE=$(echo "scale=1; $PASSED_CHECKS * 100 / $TOTAL_CHECKS" | bc -l 2>/dev/null || echo "0")
    echo "Success Rate: ${SUCCESS_RATE}%"
    echo ""
    echo "To fix issues:"
    echo "1. Address failed checks above"
    echo "2. Update last-updated dates in documentation"
    echo "3. Ensure all required sections are present"
    echo "4. Fix any broken internal links"
    echo "5. Re-run this script to verify fixes"
    exit 1
fi