#!/bin/bash

# upload_jsonl.sh
# Upload .jsonl training files to OpenAI for fine-tuning
# Usage: ./upload_jsonl.sh [filename.jsonl]

set -euo pipefail

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Configuration
DATA_DIR="./data"
LOGS_DIR="./logs"
LOG_FILE="$LOGS_DIR/upload_$(date +%Y%m%d_%H%M%S).log"

# Ensure required directories exist
mkdir -p "$DATA_DIR" "$LOGS_DIR"

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

# Function to upload a single file
upload_file() {
    local file_path="$1"
    local filename=$(basename "$file_path")
    
    log "Starting upload for: $filename"
    log "File path: $file_path"
    
    # Check if file exists and has content
    if [ ! -f "$file_path" ]; then
        log "ERROR: File not found: $file_path"
        return 1
    fi
    
    if [ ! -s "$file_path" ]; then
        log "ERROR: File is empty: $file_path"
        return 1
    fi
    
    # Validate JSONL format (basic check)
    if ! head -n 1 "$file_path" | jq . > /dev/null 2>&1; then
        log "WARNING: File may not be valid JSONL format: $filename"
    fi
    
    log "Uploading $filename to OpenAI..."
    
    # Create upload response file
    local response_file="$LOGS_DIR/upload_response_${filename}_$(date +%Y%m%d_%H%M%S).json"
    
    # Upload file using OpenAI CLI
    if python3 -m openai api files.create -f "$file_path" -p "fine-tune" > "$response_file" 2>&1; then
        log "Upload successful for: $filename"
        log "Response saved to: $response_file"
        
        # Extract and log file ID
        if command -v jq > /dev/null 2>&1; then
            file_id=$(jq -r '.id' "$response_file" 2>/dev/null || echo "")
            if [ -n "$file_id" ] && [ "$file_id" != "null" ]; then
                log "File ID: $file_id"
                
                # Save file ID to a dedicated file for other scripts
                echo "$file_id" > "$LOGS_DIR/latest_file_id.txt"
                echo "$filename:$file_id" >> "$LOGS_DIR/file_ids.txt"
                
                log "File ID saved to: $LOGS_DIR/latest_file_id.txt"
                log "File mapping appended to: $LOGS_DIR/file_ids.txt"
            else
                log "WARNING: Could not extract file ID from response"
            fi
        else
            log "WARNING: jq not available, cannot extract file ID"
            log "Install jq to enable file ID extraction: sudo apt-get install jq"
        fi
        
        return 0
    else
        log "ERROR: Upload failed for: $filename"
        log "Response saved to: $response_file"
        cat "$response_file" | tee -a "$LOG_FILE"
        return 1
    fi
}

# Function to list available files
list_files() {
    log "Available .jsonl files in $DATA_DIR:"
    find "$DATA_DIR" -name "*.jsonl" -type f | while read -r file; do
        size=$(wc -l < "$file" 2>/dev/null || echo "0")
        log "  $(basename "$file") ($size lines)"
    done
}

# Main function
main() {
    log "=== OpenAI File Upload Script Started ==="
    log "Log file: $LOG_FILE"
    
    check_requirements
    
    # If specific file provided, upload it
    if [ $# -eq 1 ]; then
        file_arg="$1"
        
        # Handle both absolute and relative paths
        if [[ "$file_arg" == /* ]]; then
            file_path="$file_arg"
        elif [[ "$file_arg" == */* ]]; then
            file_path="$file_arg"
        else
            file_path="$DATA_DIR/$file_arg"
        fi
        
        upload_file "$file_path"
        
    # If no file specified, show available files and prompt
    elif [ $# -eq 0 ]; then
        list_files
        
        # Check if any .jsonl files exist
        if [ -z "$(find "$DATA_DIR" -name "*.jsonl" -type f 2>/dev/null)" ]; then
            log "No .jsonl files found in $DATA_DIR"
            log "Please add training data files to the data directory"
            exit 1
        fi
        
        echo ""
        echo "Usage: $0 <filename.jsonl>"
        echo "Example: $0 training_data.jsonl"
        echo "         $0 /path/to/file.jsonl"
        echo ""
        exit 0
    else
        log "ERROR: Too many arguments"
        echo "Usage: $0 [filename.jsonl]"
        exit 1
    fi
    
    log "=== Upload Script Completed ==="
}

# Run main function with all arguments
main "$@"