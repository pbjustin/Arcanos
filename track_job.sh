#!/bin/bash

# track_job.sh
# Monitor and log OpenAI fine-tuning job progress
# Usage: ./track_job.sh [job-id] [--follow]

set -euo pipefail

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Configuration
LOGS_DIR="./logs"
LOG_FILE="$LOGS_DIR/tracking_$(date +%Y%m%d_%H%M%S).log"

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

# Function to get latest job ID
get_latest_job_id() {
    local latest_job_id_path="$LOGS_DIR/latest_job_id.txt"
    
    if [ -f "$latest_job_id_path" ]; then
        cat "$latest_job_id_path"
    else
        log "ERROR: No latest job ID found"
        log "Please run continue_finetune.sh first or provide job ID manually"
        return 1
    fi
}

# Function to get job status
get_job_status() {
    local job_id="$1"
    local response_file="$LOGS_DIR/status_${job_id}_$(date +%Y%m%d_%H%M%S).json"
    
    log "Fetching status for job: $job_id"
    
    if python3 -m openai api fine_tuning.jobs.retrieve -i "$job_id" > "$response_file" 2>&1; then
        
        if command -v jq > /dev/null 2>&1; then
            # Parse JSON response with jq
            local status=$(jq -r '.status' "$response_file" 2>/dev/null || echo "unknown")
            local created_at=$(jq -r '.created_at' "$response_file" 2>/dev/null || echo "")
            local finished_at=$(jq -r '.finished_at' "$response_file" 2>/dev/null || echo "null")
            local fine_tuned_model=$(jq -r '.fine_tuned_model' "$response_file" 2>/dev/null || echo "null")
            local training_file=$(jq -r '.training_file' "$response_file" 2>/dev/null || echo "")
            local model=$(jq -r '.model' "$response_file" 2>/dev/null || echo "")
            
            log "Job Status: $status"
            log "Base Model: $model"
            log "Training File: $training_file"
            
            if [ -n "$created_at" ] && [ "$created_at" != "null" ]; then
                local created_date=$(date -d "@$created_at" 2>/dev/null || echo "Unknown")
                log "Created: $created_date"
            fi
            
            if [ "$finished_at" != "null" ] && [ -n "$finished_at" ]; then
                local finished_date=$(date -d "@$finished_at" 2>/dev/null || echo "Unknown")
                log "Finished: $finished_date"
            fi
            
            if [ "$fine_tuned_model" != "null" ] && [ -n "$fine_tuned_model" ]; then
                log "Fine-tuned Model: $fine_tuned_model"
                
                # Save the completed model ID
                echo "$fine_tuned_model" > "$LOGS_DIR/latest_completed_model.txt"
                echo "$(date '+%Y-%m-%d %H:%M:%S'):$job_id:$fine_tuned_model" >> "$LOGS_DIR/completed_models.txt"
                log "Model ID saved to: $LOGS_DIR/latest_completed_model.txt"
            fi
            
            # Log additional details for certain statuses
            case "$status" in
                "running")
                    log "Training is in progress..."
                    ;;
                "succeeded")
                    log "✅ Training completed successfully!"
                    if [ "$fine_tuned_model" != "null" ]; then
                        log "🎉 New model ready: $fine_tuned_model"
                        log "💡 Update your .env file with: FINE_TUNED_MODEL=$fine_tuned_model"
                    fi
                    ;;
                "failed")
                    log "❌ Training failed"
                    local error=$(jq -r '.error.message // "Unknown error"' "$response_file" 2>/dev/null || echo "Unknown error")
                    log "Error: $error"
                    ;;
                "cancelled")
                    log "⚠️ Training was cancelled"
                    ;;
                *)
                    log "Status: $status"
                    ;;
            esac
            
            # Save status to history
            echo "$(date '+%Y-%m-%d %H:%M:%S'):$job_id:$status" >> "$LOGS_DIR/status_history.txt"
            
            echo "$status"  # Return status for caller
            
        else
            log "WARNING: jq not available, showing raw response"
            cat "$response_file" | tee -a "$LOG_FILE"
            echo "unknown"
        fi
        
        # Keep response file for debugging
        log "Response saved to: $response_file"
        return 0
        
    else
        log "ERROR: Failed to fetch job status"
        log "Response saved to: $response_file"
        cat "$response_file" | tee -a "$LOG_FILE"
        return 1
    fi
}

# Function to follow job progress
follow_job() {
    local job_id="$1"
    local check_interval=30  # seconds
    
    log "Following job progress: $job_id"
    log "Checking every $check_interval seconds (Ctrl+C to stop)"
    log "========================================="
    
    while true; do
        local status=$(get_job_status "$job_id")
        
        case "$status" in
            "succeeded"|"failed"|"cancelled")
                log "Job reached terminal state: $status"
                break
                ;;
            "running"|"validating_files"|"queued")
                log "Job still active: $status"
                log "Next check in $check_interval seconds..."
                sleep $check_interval
                ;;
            *)
                log "Unknown status: $status, continuing to monitor..."
                sleep $check_interval
                ;;
        esac
        
        log "----------------------------------------"
    done
    
    log "Monitoring completed for job: $job_id"
}

# Function to show job history
show_job_history() {
    log "Recent fine-tuning jobs:"
    if [ -f "$LOGS_DIR/job_history.txt" ]; then
        tail -n 10 "$LOGS_DIR/job_history.txt" | while read -r line; do
            log "  $line"
        done
    else
        log "  No job history found"
    fi
}

# Function to show completed models
show_completed_models() {
    log "Completed models:"
    if [ -f "$LOGS_DIR/completed_models.txt" ]; then
        tail -n 5 "$LOGS_DIR/completed_models.txt" | while read -r line; do
            log "  $line"
        done
    else
        log "  No completed models found"
    fi
}

# Function to list all jobs
list_all_jobs() {
    log "Fetching all fine-tuning jobs..."
    local response_file="$LOGS_DIR/all_jobs_$(date +%Y%m%d_%H%M%S).json"
    
    if python3 -m openai api fine_tuning.jobs.list > "$response_file" 2>&1; then
        if command -v jq > /dev/null 2>&1; then
            log "Recent fine-tuning jobs:"
            jq -r '.data[] | "\(.id) | \(.status) | \(.model) | \(.created_at)"' "$response_file" 2>/dev/null | \
            head -n 10 | while read -r line; do
                log "  $line"
            done
        else
            log "Raw response (install jq for better formatting):"
            cat "$response_file" | tee -a "$LOG_FILE"
        fi
    else
        log "ERROR: Failed to list jobs"
        cat "$response_file" | tee -a "$LOG_FILE"
    fi
}

# Main function
main() {
    log "=== OpenAI Job Tracking Script Started ==="
    log "Log file: $LOG_FILE"
    
    check_requirements
    
    local job_id=""
    local follow_mode=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --follow|-f)
                follow_mode=true
                shift
                ;;
            --list|-l)
                list_all_jobs
                exit 0
                ;;
            --history|-h)
                show_job_history
                show_completed_models
                exit 0
                ;;
            --help)
                echo "Usage: $0 [job-id] [options]"
                echo ""
                echo "Options:"
                echo "  --follow, -f    Follow job progress continuously"
                echo "  --list, -l      List all recent jobs"
                echo "  --history, -h   Show job history and completed models"
                echo "  --help          Show this help message"
                echo ""
                echo "Examples:"
                echo "  $0                          # Check latest job status"
                echo "  $0 ftjob-abc123             # Check specific job status"
                echo "  $0 ftjob-abc123 --follow    # Follow specific job progress"
                echo "  $0 --follow                 # Follow latest job progress"
                echo "  $0 --list                   # List all jobs"
                echo ""
                exit 0
                ;;
            *)
                if [ -z "$job_id" ]; then
                    job_id="$1"
                else
                    log "ERROR: Unknown argument: $1"
                    exit 1
                fi
                shift
                ;;
        esac
    done
    
    # Get job ID if not provided
    if [ -z "$job_id" ]; then
        log "No job ID provided, using latest job"
        job_id=$(get_latest_job_id)
    fi
    
    # Validate job ID format
    if [[ ! "$job_id" =~ ^ftjob- ]]; then
        log "ERROR: Invalid job ID format: $job_id"
        log "Job IDs should start with 'ftjob-'"
        show_job_history
        exit 1
    fi
    
    log "Tracking job: $job_id"
    
    # Show context
    show_job_history
    
    # Either follow or check once
    if [ "$follow_mode" = true ]; then
        follow_job "$job_id"
    else
        get_job_status "$job_id"
        log "Use '--follow' option to monitor continuously"
    fi
    
    log "=== Tracking Script Completed ==="
}

# Run main function with all arguments
main "$@"