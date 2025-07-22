#!/bin/bash

# continue_finetune.sh
# Start a fine-tuning job on an existing OpenAI model
# Usage: ./continue_finetune.sh [file-id] [base-model]

set -euo pipefail

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Configuration
LOGS_DIR="./logs"
LOG_FILE="$LOGS_DIR/finetune_$(date +%Y%m%d_%H%M%S).log"

# Ensure required directories exist
mkdir -p "$LOGS_DIR"

# Function to log messages
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Function to check requirements
check_requirements() {
    log "Checking requirements..."
    
    if [ -z "${OPENAI_API_KEY:-}" ]; then
        log "ERROR: OPENAI_API_KEY not found in environment"
        log "Please set OPENAI_API_KEY in .env file"
        exit 1
    fi
    
    if ! python3 -m openai --help > /dev/null 2>&1; then
        log "ERROR: OpenAI CLI not available"
        log "Please install with: pip3 install --user openai"
        exit 1
    fi
    
    log "Requirements check passed"
}

# Function to get the latest file ID
get_latest_file_id() {
    local latest_file_id_path="$LOGS_DIR/latest_file_id.txt"
    
    if [ -f "$latest_file_id_path" ]; then
        cat "$latest_file_id_path"
    else
        log "ERROR: No latest file ID found"
        log "Please run upload_jsonl.sh first or provide file ID manually"
        return 1
    fi
}

# Function to determine base model
get_base_model() {
    # Priority: 1. Command line arg, 2. MODEL_ID env var, 3. FINE_TUNED_MODEL env var, 4. Default
    if [ $# -ge 2 ] && [ -n "$2" ]; then
        echo "$2"
    elif [ -n "${MODEL_ID:-}" ]; then
        echo "$MODEL_ID"
    elif [ -n "${FINE_TUNED_MODEL:-}" ]; then
        echo "$FINE_TUNED_MODEL"
    else
        echo "gpt-3.5-turbo"
    fi
}

# Function to start fine-tuning
start_finetune() {
    local file_id="$1"
    local base_model="$2"
    
    log "Starting fine-tuning job..."
    log "File ID: $file_id"
    log "Base model: $base_model"
    
    # Create response file for the fine-tuning job
    local response_file="$LOGS_DIR/finetune_response_$(date +%Y%m%d_%H%M%S).json"
    
    # Start fine-tuning using OpenAI CLI
    log "Initiating fine-tuning request..."
    
    if python3 -m openai api fine_tuning.jobs.create -t "$file_id" -m "$base_model" > "$response_file" 2>&1; then
        log "Fine-tuning job created successfully"
        log "Response saved to: $response_file"
        
        # Extract and save job ID
        if command -v jq > /dev/null 2>&1; then
            job_id=$(jq -r '.id' "$response_file" 2>/dev/null || echo "")
            if [ -n "$job_id" ] && [ "$job_id" != "null" ]; then
                log "Job ID: $job_id"
                
                # Save job ID for tracking script
                echo "$job_id" > "$LOGS_DIR/latest_job_id.txt"
                echo "$(date '+%Y-%m-%d %H:%M:%S'):$job_id:$base_model:$file_id" >> "$LOGS_DIR/job_history.txt"
                
                log "Job ID saved to: $LOGS_DIR/latest_job_id.txt"
                log "Job history updated: $LOGS_DIR/job_history.txt"
                
                # Show initial job status
                status=$(jq -r '.status' "$response_file" 2>/dev/null || echo "unknown")
                log "Initial status: $status"
                
                log "Use './track_job.sh' to monitor the training progress"
                
                return 0
            else
                log "WARNING: Could not extract job ID from response"
            fi
        else
            log "WARNING: jq not available, cannot extract job ID"
            log "Install jq to enable job ID extraction: sudo apt-get install jq"
        fi
        
        # Show raw response if jq unavailable
        log "Raw response:"
        cat "$response_file" | tee -a "$LOG_FILE"
        return 0
        
    else
        log "ERROR: Fine-tuning job creation failed"
        log "Response saved to: $response_file"
        cat "$response_file" | tee -a "$LOG_FILE"
        return 1
    fi
}

# Function to show recent file uploads
show_recent_uploads() {
    log "Recent file uploads:"
    if [ -f "$LOGS_DIR/file_ids.txt" ]; then
        tail -n 5 "$LOGS_DIR/file_ids.txt" | while read -r line; do
            log "  $line"
        done
    else
        log "  No recent uploads found"
    fi
}

# Function to show job history
show_job_history() {
    log "Recent fine-tuning jobs:"
    if [ -f "$LOGS_DIR/job_history.txt" ]; then
        tail -n 5 "$LOGS_DIR/job_history.txt" | while read -r line; do
            log "  $line"
        done
    else
        log "  No previous jobs found"
    fi
}

# Main function
main() {
    log "=== OpenAI Fine-Tuning Script Started ==="
    log "Log file: $LOG_FILE"
    
    check_requirements
    
    local file_id=""
    local base_model=""
    
    # Parse arguments
    if [ $# -eq 0 ]; then
        # No arguments - use latest file ID and default model
        log "No arguments provided, using latest uploaded file and default model"
        file_id=$(get_latest_file_id)
        base_model=$(get_base_model)
        
    elif [ $# -eq 1 ]; then
        # One argument - could be file ID or model name
        if [[ "$1" =~ ^file- ]]; then
            # Looks like a file ID
            file_id="$1"
            base_model=$(get_base_model)
            log "Using provided file ID: $file_id"
        else
            # Assume it's a model name, use latest file ID
            file_id=$(get_latest_file_id)
            base_model="$1"
            log "Using latest file ID with specified model: $base_model"
        fi
        
    elif [ $# -eq 2 ]; then
        # Two arguments - file ID and model
        file_id="$1"
        base_model="$2"
        log "Using provided file ID and model"
        
    else
        log "ERROR: Too many arguments"
        echo ""
        echo "Usage: $0 [file-id] [base-model]"
        echo ""
        echo "Examples:"
        echo "  $0                              # Use latest file and default model"
        echo "  $0 file-abc123                  # Use specific file with default model"
        echo "  $0 gpt-3.5-turbo                # Use latest file with specific model"
        echo "  $0 file-abc123 gpt-3.5-turbo    # Use specific file and model"
        echo ""
        exit 1
    fi
    
    # Validate file ID format
    if [[ ! "$file_id" =~ ^file- ]]; then
        log "ERROR: Invalid file ID format: $file_id"
        log "File IDs should start with 'file-'"
        show_recent_uploads
        exit 1
    fi
    
    log "Configuration:"
    log "  File ID: $file_id"
    log "  Base Model: $base_model"
    
    # Show context
    show_recent_uploads
    show_job_history
    
    # Start fine-tuning
    if start_finetune "$file_id" "$base_model"; then
        log "Fine-tuning initiated successfully"
        log "Monitor progress with: ./track_job.sh"
    else
        log "Fine-tuning failed to start"
        exit 1
    fi
    
    log "=== Fine-Tuning Script Completed ==="
}

# Run main function with all arguments
main "$@"