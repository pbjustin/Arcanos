#!/bin/bash

# Test script for reset-to-pr565.sh
# This validates the script logic and error handling

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET_SCRIPT="$SCRIPT_DIR/reset-to-pr565.sh"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

test_count=0
pass_count=0

run_test() {
    local test_name="$1"
    local expected_exit_code="${2:-0}"
    shift 2
    local cmd="$*"
    
    test_count=$((test_count + 1))
    echo -n "Test $test_count: $test_name... "
    
    local actual_exit_code=0
    eval "$cmd" >/dev/null 2>&1 || actual_exit_code=$?
    
    if [[ $actual_exit_code -eq $expected_exit_code ]]; then
        echo -e "${GREEN}PASS${NC}"
        pass_count=$((pass_count + 1))
    else
        echo -e "${RED}FAIL${NC} (expected exit code $expected_exit_code, got $actual_exit_code)"
    fi
}

echo "Testing reset-to-pr565.sh script..."
echo "================================="

# Test 1: Help functionality
run_test "Help option works" 0 "$RESET_SCRIPT --help"

# Test 2: Invalid option handling
run_test "Invalid option handling" 1 "$RESET_SCRIPT --invalid-option"

# Test 3: Dry run functionality
run_test "Dry run executes without errors" 0 "$RESET_SCRIPT --dry-run"

# Test 4: Script is executable
run_test "Script is executable" 0 "test -x '$RESET_SCRIPT'"

# Test 5: Script has proper shebang
run_test "Script has bash shebang" 0 "head -1 '$RESET_SCRIPT' | grep -q '#!/bin/bash'"

# Test 6: Script contains required functions
run_test "Contains check_git_repo function" 0 "grep -q 'check_git_repo()' '$RESET_SCRIPT'"
run_test "Contains backup_current_state function" 0 "grep -q 'backup_current_state()' '$RESET_SCRIPT'"
run_test "Contains clean_untracked_files function" 0 "grep -q 'clean_untracked_files()' '$RESET_SCRIPT'"

# Test 7: Script has proper PR #565 commit hash
run_test "Contains correct PR #565 commit hash" 0 "grep -q 'bc217251f36dbfb03d5e0b5c8590ca5cbed2c95e' '$RESET_SCRIPT'"

# Test 8: Script handles both --dry-run and --force together
run_test "Handles --dry-run --force combination" 0 "$RESET_SCRIPT --dry-run --force"

echo
echo "Test Summary:"
echo "============="
echo -e "Tests run: $test_count"
echo -e "Passed: ${GREEN}$pass_count${NC}"
echo -e "Failed: ${RED}$((test_count - pass_count))${NC}"

if [[ $pass_count -eq $test_count ]]; then
    echo -e "\n${GREEN}All tests passed! ✓${NC}"
    exit 0
else
    echo -e "\n${RED}Some tests failed! ✗${NC}"
    exit 1
fi