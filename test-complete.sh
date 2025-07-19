#!/bin/bash

# Test script to verify the complete Arcanos implementation
echo "🧪 Testing complete Arcanos AI implementation..."

# Test 1: Without FINE_TUNED_MODEL (should fail with specific error)
echo -e "\n1️⃣ Testing without FINE_TUNED_MODEL..."
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello world", "domain": "general", "useRAG": true, "useHRC": true}' \
  -w "\nStatus: %{http_code}\n"

# Test 2: With FINE_TUNED_MODEL set but invalid key (should fail gracefully)
echo -e "\n2️⃣ Testing with FINE_TUNED_MODEL set but invalid OpenAI key..."
FINE_TUNED_MODEL="ft-test-model" curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello world", "domain": "general", "useRAG": true, "useHRC": true}' \
  -w "\nStatus: %{http_code}\n"

# Test 3: Verify frontend files are accessible
echo -e "\n3️⃣ Testing frontend file accessibility..."
echo "Frontend JS file status:"
curl -I http://localhost:8080/arcanos-frontend.js -w "Status: %{http_code}\n" -o /dev/null -s

echo "Frontend HTML file status:"
curl -I http://localhost:8080/test.html -w "Status: %{http_code}\n" -o /dev/null -s

# Test 4: Verify heartbeat endpoints are removed
echo -e "\n4️⃣ Testing that heartbeat endpoints are removed..."
echo "Testing /heartbeat endpoint (should return 404):"
curl -X GET http://localhost:8080/heartbeat -w "Status: %{http_code}\n" -s || echo "Endpoint not found (expected)"

echo -e "\n✅ All tests completed!"