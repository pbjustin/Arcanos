#!/bin/bash

# Test script for Arcanos API endpoints
# This script validates the examples in the prompt guide

echo "=================================================="
echo "         Arcanos API Test Script"
echo "=================================================="
echo ""


BASE_URL="http://localhost:8080"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Start server in background if not already running
echo "🚀 Starting server for tests..."
npm run build >/dev/null 2>&1
npm start >/tmp/server.log 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
echo "⏳ Waiting for server to respond on $BASE_URL..."
attempts=0
max_attempts=20
until curl -s "$BASE_URL/health" >/dev/null 2>&1; do
  if [ $attempts -ge $max_attempts ]; then
    echo -e "${RED}⚠️  Server did not respond after $max_attempts seconds. Tests may fail.${NC}"
    break
  fi
  attempts=$((attempts+1))
  sleep 1
done
if [ $attempts -lt $max_attempts ]; then
  echo -e "${GREEN}Server is up!${NC}"
fi

# Function to test endpoint
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    
    echo -e "${YELLOW}Testing: $name${NC}"
    echo "Endpoint: $method $endpoint"
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" "$BASE_URL$endpoint")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data")
    fi
    
    # Extract HTTP status code (last line)
    http_code=$(echo "$response" | tail -n1)
    # Extract response body (all but last line)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" -eq 200 ] || [ "$http_code" -eq 201 ]; then
        echo -e "${GREEN}✅ Success (HTTP $http_code)${NC}"
        echo "Response: $body" | head -c 200
        if [ ${#body} -gt 200 ]; then
            echo "..."
        fi
    else
        echo -e "${RED}❌ Failed (HTTP $http_code)${NC}"
        echo "Response: $body"
    fi
    echo ""
    echo "=================================================="
    echo ""
}

# Test 1: Health Check
test_endpoint "Health Check" "GET" "/health" ""

# Test 2: API Welcome
test_endpoint "API Welcome" "GET" "/api" ""

# Test 3: Echo Test
test_endpoint "Echo Test" "POST" "/api/echo" '{"message": "Hello Arcanos!", "test": true}'

# Test 4: Model Status
test_endpoint "Model Status" "GET" "/api/model-status" ""

# Test 5: Memory Store
test_endpoint "Memory Store" "POST" "/api/memory" '{"value": "Test memory for API validation"}'

# Test 6: Memory Retrieve
test_endpoint "Memory Retrieve" "GET" "/api/memory" ""

# Test 7: HRC Validation
test_endpoint "HRC Validation" "POST" "/api/ask-hrc" '{"message": "Test message for HRC validation"}'

# Test 8: V1 Safe Interface (should work without API key for error handling)
test_endpoint "V1 Safe Interface" "POST" "/api/ask-v1-safe" '{"message": "Test safe interface", "domain": "general", "useRAG": false, "useHRC": false}'

# Test 9: ARCANOS Router
test_endpoint "ARCANOS Router" "POST" "/api/arcanos" '{"message": "Create a simple hello world function", "domain": "programming"}'

# Test 10: Ask Endpoint (will fail without API key - testing error handling)
test_endpoint "Ask Endpoint (Error Test)" "POST" "/api/ask" '{"message": "Test message"}'

# Test 11: Ask with Fallback (will fail without API key - testing error handling)
test_endpoint "Ask with Fallback (Error Test)" "POST" "/api/ask-with-fallback" '{"message": "Test message"}'

# Test 12: Sleep Configuration
test_endpoint "Sleep Configuration" "GET" "/api/config/sleep" ""

echo "=================================================="
echo "                 Test Summary"
echo "=================================================="
echo ""
echo "✅ Green tests: Passed successfully"
echo "❌ Red tests: Failed (may be expected without API key)"
echo ""
echo "Note: Some endpoints require OPENAI_API_KEY and"
echo "FINE_TUNED_MODEL to be configured in .env"
echo ""
echo "To set up API key:"
echo "1. Copy .env.example to .env"
echo "2. Add your OpenAI API key"
echo "3. Add your fine-tuned model ID"
echo "4. Restart the server"
echo ""
echo "=================================================="

# Stop the background server
if kill -0 $SERVER_PID 2>/dev/null; then
  echo "🛑 Stopping test server..."
  kill $SERVER_PID
  wait $SERVER_PID 2>/dev/null
fi
