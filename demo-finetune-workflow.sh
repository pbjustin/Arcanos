#!/bin/bash

# demo-finetune-workflow.sh
# Demonstrates the complete fine-tuning workflow (requires valid OPENAI_API_KEY)

set -euo pipefail

echo "🚀 OpenAI Fine-Tuning Pipeline Demo"
echo "=================================="
echo ""

# Check prerequisites
if [ ! -f ".env" ]; then
    echo "❌ ERROR: .env file not found"
    echo "Please copy .env.example to .env and add your OPENAI_API_KEY"
    echo "Example:"
    echo "  cp .env.example .env"
    echo "  # Edit .env with your actual API key"
    exit 1
fi

# Load environment
source .env

if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "❌ ERROR: OPENAI_API_KEY not set in .env file"
    exit 1
fi

echo "✅ Environment configured"
echo ""

# Check if sample data exists
if [ ! -f "data/sample_training.jsonl" ]; then
    echo "❌ ERROR: Sample training data not found at data/sample_training.jsonl"
    exit 1
fi

echo "📁 Found sample training data: data/sample_training.jsonl"
echo "   Lines: $(wc -l < data/sample_training.jsonl)"
echo ""

# Step 1: Upload training data
echo "🔄 Step 1: Uploading training data..."
echo "------------------------------------"
if ./upload_jsonl.sh sample_training.jsonl; then
    echo "✅ Upload completed successfully"
else
    echo "❌ Upload failed"
    exit 1
fi
echo ""

# Check if file ID was saved
if [ -f "logs/latest_file_id.txt" ]; then
    file_id=$(cat logs/latest_file_id.txt)
    echo "💾 File ID saved: $file_id"
else
    echo "⚠️  WARNING: File ID not extracted, continuing anyway..."
fi
echo ""

# Step 2: Start fine-tuning
echo "🔄 Step 2: Starting fine-tuning job..."
echo "--------------------------------------"
if ./continue_finetune.sh; then
    echo "✅ Fine-tuning job started successfully"
else
    echo "❌ Fine-tuning job failed to start"
    exit 1
fi
echo ""

# Check if job ID was saved
if [ -f "logs/latest_job_id.txt" ]; then
    job_id=$(cat logs/latest_job_id.txt)
    echo "💾 Job ID saved: $job_id"
else
    echo "⚠️  WARNING: Job ID not extracted"
    exit 1
fi
echo ""

# Step 3: Check initial status
echo "🔄 Step 3: Checking job status..."
echo "---------------------------------"
if ./track_job.sh; then
    echo "✅ Status check completed"
else
    echo "❌ Status check failed"
    exit 1
fi
echo ""

# Final instructions
echo "🎉 Demo completed successfully!"
echo ""
echo "Your fine-tuning job is now running. You can:"
echo ""
echo "📊 Monitor progress continuously:"
echo "   ./track_job.sh --follow"
echo ""
echo "📋 Check job history:"
echo "   ./track_job.sh --history"
echo ""
echo "📂 View logs:"
echo "   ls -la logs/"
echo ""
echo "⏳ Fine-tuning typically takes 10-30 minutes depending on data size."
echo "   You'll be notified when the new model is ready!"
echo ""
echo "📖 For more information, see FINETUNE_PIPELINE.md"