#!/bin/bash

# test-finetune-pipeline.sh
# Test the fine-tuning pipeline components

set -euo pipefail

echo "🧪 Testing Fine-Tuning Pipeline Components"
echo "========================================="

# Test 1: Check if scripts are executable
echo "✅ Test 1: Script permissions"
if [ -x "./upload_jsonl.sh" ] && [ -x "./continue_finetune.sh" ] && [ -x "./track_job.sh" ]; then
    echo "   All scripts are executable"
else
    echo "   ❌ FAIL: Some scripts are not executable"
    exit 1
fi

# Test 2: Check if directories exist
echo "✅ Test 2: Directory structure"
if [ -d "./data" ] && [ -d "./logs" ]; then
    echo "   Required directories exist"
else
    echo "   ❌ FAIL: Required directories missing"
    exit 1
fi

# Test 3: Check if sample data exists
echo "✅ Test 3: Sample training data"
if [ -f "./data/sample_training.jsonl" ]; then
    echo "   Sample training data exists"
    # Validate JSONL format
    if head -n 1 "./data/sample_training.jsonl" | jq . > /dev/null 2>&1; then
        echo "   Sample data is valid JSONL"
    else
        echo "   ⚠️  WARNING: Sample data may not be valid JSONL"
    fi
else
    echo "   ❌ FAIL: Sample training data missing"
    exit 1
fi

# Test 4: Check script help functions
echo "✅ Test 4: Script help functions"
if echo "OPENAI_API_KEY=test" > .env.tmp; then
    export $(cat .env.tmp | xargs)
    if ./track_job.sh --help > /dev/null 2>&1; then
        echo "   Track job help works"
    else
        echo "   ❌ FAIL: Track job help failed"
        rm .env.tmp
        exit 1
    fi
    rm .env.tmp
    unset OPENAI_API_KEY
else
    echo "   ⚠️  WARNING: Could not test help functions"
fi

# Test 5: Check if documentation exists
echo "✅ Test 5: Documentation"
if [ -f "./FINETUNE_PIPELINE.md" ]; then
    echo "   Pipeline documentation exists"
    # Check if main README references it
    if grep -q "FINETUNE_PIPELINE.md" README.md; then
        echo "   Documentation is linked in main README"
    else
        echo "   ⚠️  WARNING: Documentation not linked in main README"
    fi
else
    echo "   ❌ FAIL: Pipeline documentation missing"
    exit 1
fi

# Test 6: Check .env.example updates
echo "✅ Test 6: Environment configuration"
if grep -q "MODEL_ID" .env.example; then
    echo "   MODEL_ID configuration added to .env.example"
else
    echo "   ❌ FAIL: MODEL_ID not found in .env.example"
    exit 1
fi

echo ""
echo "🎉 All tests passed! Fine-tuning pipeline is ready to use."
echo ""
echo "Next steps:"
echo "1. Copy .env.example to .env and add your OPENAI_API_KEY"
echo "2. Add training data to the data/ directory"
echo "3. Run ./upload_jsonl.sh your_data.jsonl"
echo "4. Run ./continue_finetune.sh"
echo "5. Monitor with ./track_job.sh --follow"
echo ""
echo "📖 See FINETUNE_PIPELINE.md for detailed usage instructions"