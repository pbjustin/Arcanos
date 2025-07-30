#!/bin/bash

# Quick API test for research endpoint
# This script tests the research API endpoint with a sample request

echo "🧪 Testing Research API Endpoint"
echo "================================="

# Set test environment
export OPENAI_API_KEY="test_key_for_demo"
export DATABASE_URL=""

# Start server in background
echo "🚀 Starting ARCANOS server..."
npx ts-node src/index.ts &
SERVER_PID=$!

# Wait for server to start
echo "⏳ Waiting for server to initialize..."
sleep 5

# Test the API endpoint
echo "📡 Testing POST /commands/research endpoint..."

curl -X POST http://localhost:8400/commands/research \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "quantum computing basics",
    "urls": [
      "https://en.wikipedia.org/wiki/Quantum_computing",
      "https://www.ibm.com/quantum-computing/"
    ]
  }' \
  -w "\nHTTP Status: %{http_code}\n" \
  2>/dev/null || echo "❌ API request failed"

echo ""
echo "✅ API test completed!"

# Clean up
echo "🧹 Stopping server..."
kill $SERVER_PID 2>/dev/null

echo "🏁 Test finished!"