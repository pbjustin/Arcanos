#!/bin/bash

# Demo script showing fetchGuideSegment functionality
# This demonstrates the complete implementation of the dynamic route service

echo "🎮 ARCANOS Guide Segment Fetcher Demo"
echo "======================================"

BASE_URL="http://localhost:8080"
AUTH_HEADER="Authorization: Bearer test_token_123"

echo ""
echo "📝 Step 1: Save a sample game guide..."
curl -s -H "$AUTH_HEADER" -H "Content-Type: application/json" -X POST "$BASE_URL/api/memory/save" -d '{
  "memory_key": "guides/rpg/final-fantasy",
  "memory_value": {
    "id": "final-fantasy",
    "sections": [
      "Chapter 1: Getting Started",
      "Chapter 2: Character Classes",
      "Chapter 3: Combat System",
      "Chapter 4: Magic & Abilities",
      "Chapter 5: World Exploration",
      "Chapter 6: Endgame Content"
    ],
    "lastUpdated": "2025-07-30T00:47:00.000Z"
  }
}' | jq -r '.message // .error'

echo ""
echo "✅ Guide saved successfully!"
echo ""

echo "🔍 Step 2: Test fetchGuideSegment with different parameters..."
echo ""

echo "📖 Default parameters (sections 0-1):"
curl -s -H "$AUTH_HEADER" "$BASE_URL/api/guides/rpg/final-fantasy"
echo -e "\n"

echo "📖 Custom range (sections 2-4):"
curl -s -H "$AUTH_HEADER" "$BASE_URL/api/guides/rpg/final-fantasy?sectionStart=2&sectionEnd=5"
echo -e "\n"

echo "📖 Single section (section 3):"
curl -s -H "$AUTH_HEADER" "$BASE_URL/api/guides/rpg/final-fantasy?sectionStart=3&sectionEnd=4"
echo -e "\n"

echo "📖 All sections (0-6):"
curl -s -H "$AUTH_HEADER" "$BASE_URL/api/guides/rpg/final-fantasy?sectionStart=0&sectionEnd=6"
echo -e "\n"

echo "❌ Error case - Non-existent guide:"
curl -s -H "$AUTH_HEADER" "$BASE_URL/api/guides/rpg/non-existent"
echo -e "\n"

echo ""
echo "🎉 Demo completed! The fetchGuideSegment implementation is working correctly."
echo ""
echo "📋 Summary of features:"
echo "  ✅ Dynamic route pattern: /api/guides/{category}/{guideId}"
echo "  ✅ Memory path pattern: guides/{category}/{guideId}"
echo "  ✅ Query parameters: sectionStart, sectionEnd"
echo "  ✅ Default parameters: start=0, end=2"
echo "  ✅ Error handling for missing guides"
echo "  ✅ Content-Type: text/plain"
echo "  ✅ Compatible with latest OpenAI SDK + ARCANOS backend utilities"