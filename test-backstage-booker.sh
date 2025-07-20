#!/bin/bash

# 🎭 Backstage Booker Test Script
# Tests all the core functionality documented in BACKSTAGE_BOOKER_SETUP.md

echo "🎭 BACKSTAGE BOOKER FUNCTIONALITY TEST"
echo "======================================"
echo

# Configuration
BASE_URL="http://localhost:8080"
API_BASE="$BASE_URL/api"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Function to test an endpoint
test_endpoint() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    local description="$4"
    local expected_status="${5:-200}"
    
    echo -n "Testing: $description... "
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "%{http_code}" -o /tmp/response.json "$endpoint")
    elif [ "$method" = "POST" ]; then
        response=$(curl -s -w "%{http_code}" -o /tmp/response.json -X POST \
            -H "Content-Type: application/json" \
            -d "$data" "$endpoint")
    fi
    
    http_code="${response: -3}"
    
    if [ "$http_code" = "$expected_status" ]; then
        echo -e "${GREEN}✓ PASS${NC} (HTTP $http_code)"
        ((TESTS_PASSED++))
        
        # Show response for successful tests (first 100 chars)
        if [ -f /tmp/response.json ]; then
            content=$(head -c 100 /tmp/response.json)
            echo "   Response: $content..."
        fi
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
        ((TESTS_FAILED++))
        
        # Show error response
        if [ -f /tmp/response.json ]; then
            echo "   Error: $(cat /tmp/response.json)"
        fi
    fi
    echo
}

# Start testing
echo "🔍 Starting Backstage Booker functionality tests..."
echo

# 1. Basic Health Checks
echo "📋 BASIC HEALTH CHECKS"
echo "----------------------"
test_endpoint "GET" "$BASE_URL/health" "" "Health check endpoint"
test_endpoint "GET" "$API_BASE" "" "API welcome endpoint"
test_endpoint "POST" "$API_BASE/echo" '{"message":"Backstage Booker test"}' "Echo endpoint"

# 2. Canon Management Tests
echo "📚 CANON MANAGEMENT TESTS"
echo "-------------------------"
test_endpoint "GET" "$API_BASE/canon/files" "" "List canon files"

# Create a test canon file
test_endpoint "POST" "$API_BASE/canon/files/test_wrestler.json" \
    '{"content":"{\"name\":\"Test Wrestler\",\"brand\":\"RAW\",\"status\":\"active\"}"}' "Create test canon file"

test_endpoint "GET" "$API_BASE/canon/files/test_wrestler.json" "" "Read test canon file"

# 3. Memory Storage Tests
echo "🧠 MEMORY STORAGE TESTS"
echo "-----------------------"
test_memory_data='{"value":"Test booking decision: Main event for next week planned"}'
test_endpoint "POST" "$API_BASE/memory" "$test_memory_data" "Store booking memory"
test_endpoint "GET" "$API_BASE/memory" "" "Retrieve stored memories"

# 4. Booker-Specific Endpoints
echo "🎭 BOOKER-SPECIFIC ENDPOINTS"
echo "----------------------------"
test_endpoint "GET" "$API_BASE/booker/workers/status" "" "Worker status endpoint"

# 5. ARCANOS Core Functionality (if OpenAI key is configured)
echo "🤖 ARCANOS CORE FUNCTIONALITY"
echo "-----------------------------"
echo "Note: These tests require OPENAI_API_KEY to be configured"

# Check if OpenAI key is available
if [ -n "$OPENAI_API_KEY" ] || grep -q "OPENAI_API_KEY=" .env 2>/dev/null; then
    test_booking_request='{
        "message": "Test booking request: Plan a simple storyline",
        "domain": "booking",
        "useRAG": false,
        "useHRC": false
    }'
    test_endpoint "POST" "$API_BASE/ask" "$test_booking_request" "Basic ARCANOS booking request"
else
    echo -e "${YELLOW}⚠ SKIPPED${NC} - OPENAI_API_KEY not configured"
    echo "   To test AI functionality, set OPENAI_API_KEY in your .env file"
    echo
fi

# 6. Advanced Features Test
echo "🔧 ADVANCED FEATURES"
echo "--------------------"

# Test storyline template creation
test_endpoint "POST" "$API_BASE/canon/files/test_storyline.json" \
    '{"content":"{\"title\":\"Test Championship Feud\",\"status\":\"planned\"}"}' "Create storyline template"

# Summary
echo "📊 TEST SUMMARY"
echo "==============="
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo -e "Total Tests: $(($TESTS_PASSED + $TESTS_FAILED))"
echo

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 ALL TESTS PASSED!${NC}"
    echo "Your Backstage Booker setup is working correctly!"
    echo
    echo "🚀 NEXT STEPS:"
    echo "1. Configure your Custom GPT using the instructions in BACKSTAGE_BOOKER_SETUP.md"
    echo "2. Add your OpenAI API key to test AI functionality"
    echo "3. Create your wrestling canon files"
    echo "4. Start booking storylines!"
else
    echo -e "${RED}❌ SOME TESTS FAILED${NC}"
    echo "Please check the errors above and refer to the troubleshooting section"
    echo "in BACKSTAGE_BOOKER_SETUP.md for solutions."
fi

echo
echo "📖 For complete setup instructions, see:"
echo "   BACKSTAGE_BOOKER_SETUP.md"
echo

# Cleanup
rm -f /tmp/response.json