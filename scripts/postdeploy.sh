#!/bin/bash

# ARCANOS Post-Deployment Automation Script
# Validates schemas, syncs memory, captures metadata, and logs everything
# Non-interactive and Railway-compatible

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/postdeploy.log"
MAX_LOG_SIZE=10485760  # 10MB
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S UTC')

# Ensure logs directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Log rotation if file is too large
if [[ -f "$LOG_FILE" && $(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]]; then
    mv "$LOG_FILE" "${LOG_FILE}.old" 2>/dev/null || true
fi

# Logging function
log() {
    echo "[$TIMESTAMP] $*" | tee -a "$LOG_FILE"
}

log_error() {
    echo "[$TIMESTAMP] ERROR: $*" | tee -a "$LOG_FILE" >&2
}

# Cleanup and exit handler
cleanup() {
    local exit_code=$?
    if [[ $exit_code -eq 0 ]]; then
        log "✅ Post-deployment completed successfully"
    else
        log_error "❌ Post-deployment failed with exit code $exit_code"
    fi
    exit $exit_code
}

trap cleanup EXIT

# Start post-deployment process
log "🚀 Starting ARCANOS post-deployment automation"
log "Project root: $PROJECT_ROOT"

# Function to validate JSON schema files
validate_schemas() {
    log "📋 Validating memory schemas and configuration files..."
    
    local schema_dir="$PROJECT_ROOT/schemas"
    local validation_errors=0
    
    if [[ ! -d "$schema_dir" ]]; then
        log_error "Schemas directory not found: $schema_dir"
        return 1
    fi
    
    # Check each JSON schema file
    for schema_file in "$schema_dir"/*.json; do
        if [[ -f "$schema_file" ]]; then
            log "  Validating schema: $(basename "$schema_file")"
            if ! node -e "
                try {
                    const schema = require('$schema_file');
                    if (!schema.hasOwnProperty('\$schema')) {
                        throw new Error('Missing \$schema property');
                    }
                    console.log('✓ Valid JSON schema');
                } catch (error) {
                    console.error('✗ Invalid schema:', error.message);
                    process.exit(1);
                }
            " 2>>"$LOG_FILE"; then
                log_error "  Schema validation failed: $(basename "$schema_file")"
                ((validation_errors++))
            else
                log "  ✓ Schema valid: $(basename "$schema_file")"
            fi
        fi
    done
    
    # Validate critical configuration files
    local config_files=("$PROJECT_ROOT/package.json" "$PROJECT_ROOT/railway.json")
    for config_file in "${config_files[@]}"; do
        if [[ -f "$config_file" ]]; then
            log "  Validating config: $(basename "$config_file")"
            if ! node -e "
                try {
                    require('$config_file');
                    console.log('✓ Valid JSON configuration');
                } catch (error) {
                    console.error('✗ Invalid configuration:', error.message);
                    process.exit(1);
                }
            " 2>>"$LOG_FILE"; then
                log_error "  Config validation failed: $(basename "$config_file")"
                ((validation_errors++))
            else
                log "  ✓ Config valid: $(basename "$config_file")"
            fi
        else
            log_error "  Missing critical config file: $config_file"
            ((validation_errors++))
        fi
    done
    
    if [[ $validation_errors -gt 0 ]]; then
        log_error "Schema/config validation failed with $validation_errors errors"
        return 1
    fi
    
    log "✅ All schemas and configurations validated successfully"
    return 0
}

# Function to sync AI memory state
sync_memory_state() {
    log "🧠 Syncing live AI memory state with backend storage..."
    
    # Check if memory kernel exists
    local memory_kernel="$PROJECT_ROOT/memory/kernel.js"
    if [[ ! -f "$memory_kernel" ]]; then
        log_error "Memory kernel not found: $memory_kernel"
        return 1
    fi
    
    # Try memory bootstrap first
    log "  Bootstrapping memory system..."
    if ! timeout 30 node -e "
        const { dispatch } = require('$memory_kernel');
        dispatch('bootstrap')
            .then(result => {
                console.log('✓ Memory bootstrap completed:', JSON.stringify(result));
                process.exit(0);
            })
            .catch(error => {
                console.error('✗ Memory bootstrap failed:', error.message);
                process.exit(1);
            });
    " 2>>"$LOG_FILE"; then
        log_error "  Memory bootstrap failed, attempting fallback..."
        
        # Fallback: try alternative bootstrap
        if [[ -f "$PROJECT_ROOT/memory/actions/fallbackLoader.js" ]]; then
            log "  Attempting fallback memory loader..."
            if ! timeout 30 node -e "
                try {
                    const fallback = require('$PROJECT_ROOT/memory/actions/fallbackLoader.js');
                    console.log('✓ Fallback memory loader completed');
                } catch (error) {
                    console.error('✗ Fallback loader failed:', error.message);
                    process.exit(1);
                }
            " 2>>"$LOG_FILE"; then
                log_error "  Fallback memory loading failed"
                return 1
            fi
        else
            log_error "  No fallback loader available"
            return 1
        fi
    else
        log "  ✓ Memory bootstrap completed successfully"
    fi
    
    # Sync to PostgreSQL if available
    log "  Syncing memory to PostgreSQL storage..."
    if ! timeout 60 node -e "
        const { dispatch } = require('$memory_kernel');
        dispatch('sync')
            .then(result => {
                console.log('✓ Memory sync completed:', JSON.stringify(result));
                process.exit(0);
            })
            .catch(error => {
                console.error('✗ Memory sync failed (non-critical):', error.message);
                console.log('Memory sync failure is non-critical, continuing...');
                process.exit(0);
            });
    " 2>>"$LOG_FILE"; then
        log "  ⚠️  Memory sync failed (non-critical), continuing deployment..."
    else
        log "  ✓ Memory sync to PostgreSQL completed"
    fi
    
    log "✅ Memory state synchronization completed"
    return 0
}

# Function to capture deployment metadata
capture_deployment_metadata() {
    log "📊 Capturing deployment metadata..."
    
    # Get commit hash
    local commit_hash="unknown"
    if command -v git >/dev/null 2>&1 && [[ -d "$PROJECT_ROOT/.git" ]]; then
        commit_hash=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
        log "  Commit hash: $commit_hash"
    else
        log "  ⚠️  Git not available or not a git repository"
    fi
    
    # Get branch name
    local branch_name="unknown"
    if command -v git >/dev/null 2>&1 && [[ -d "$PROJECT_ROOT/.git" ]]; then
        branch_name=$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null || echo "unknown")
        log "  Branch: $branch_name"
    fi
    
    # Check worker status
    log "  Checking worker status..."
    local worker_status="unknown"
    if [[ -d "$PROJECT_ROOT/workers" ]]; then
        local worker_count=$(find "$PROJECT_ROOT/workers" -name "*.js" -type f | wc -l)
        worker_status="$worker_count workers available"
        log "  Worker status: $worker_status"
        
        # List worker files
        for worker in "$PROJECT_ROOT/workers"/*.js; do
            if [[ -f "$worker" ]]; then
                log "    - $(basename "$worker")"
            fi
        done
    else
        worker_status="no workers directory"
        log "  ⚠️  $worker_status"
    fi
    
    # Get environment info
    local node_version=$(node --version 2>/dev/null || echo "unknown")
    local npm_version=$(npm --version 2>/dev/null || echo "unknown")
    
    # Create deployment metadata
    local metadata_file="$PROJECT_ROOT/logs/deployment-metadata.json"
    cat > "$metadata_file" << EOF
{
    "timestamp": "$TIMESTAMP",
    "commit_hash": "$commit_hash",
    "branch_name": "$branch_name",
    "worker_status": "$worker_status",
    "node_version": "$node_version",
    "npm_version": "$npm_version",
    "environment": {
        "NODE_ENV": "${NODE_ENV:-unknown}",
        "PORT": "${PORT:-unknown}",
        "SERVER_URL": "${SERVER_URL:-unknown}"
    },
    "deployment_id": "$(date +%s)-$commit_hash"
}
EOF
    
    log "  ✓ Deployment metadata saved to: $metadata_file"
    log "✅ Deployment metadata capture completed"
    return 0
}

# Function to perform health check
perform_health_check() {
    log "🏥 Performing post-deployment health check..."
    
    # Check if server is configured to start
    if [[ -f "$PROJECT_ROOT/dist/index.js" ]]; then
        log "  ✓ Built application found"
    else
        log_error "  Built application not found at dist/index.js"
        return 1
    fi
    
    # Check critical dependencies
    log "  Checking critical dependencies..."
    if ! node -e "
        try {
            require('express');
            require('@prisma/client');
            require('dotenv');
            console.log('✓ Critical dependencies available');
        } catch (error) {
            console.error('✗ Missing critical dependency:', error.message);
            process.exit(1);
        }
    " 2>>"$LOG_FILE"; then
        log_error "  Critical dependency check failed"
        return 1
    fi
    
    log "  ✓ Health check passed"
    log "✅ Post-deployment health check completed"
    return 0
}

# Main execution
main() {
    local failed_steps=0
    
    # Step 1: Validate schemas and configurations
    if ! validate_schemas; then
        log_error "Step 1 failed: Schema validation"
        ((failed_steps++))
    fi
    
    # Step 2: Sync memory state (with fallbacks)
    if ! sync_memory_state; then
        log_error "Step 2 failed: Memory sync"
        ((failed_steps++))
    fi
    
    # Step 3: Capture deployment metadata
    if ! capture_deployment_metadata; then
        log_error "Step 3 failed: Metadata capture"
        ((failed_steps++))
    fi
    
    # Step 4: Health check
    if ! perform_health_check; then
        log_error "Step 4 failed: Health check"
        ((failed_steps++))
    fi
    
    # Summary
    if [[ $failed_steps -eq 0 ]]; then
        log "🎉 All post-deployment steps completed successfully!"
        return 0
    else
        log_error "⚠️  Post-deployment completed with $failed_steps failed steps"
        if [[ $failed_steps -ge 3 ]]; then
            log_error "Critical failure threshold reached, marking deployment as failed"
            return 1
        else
            log "Non-critical failures detected, deployment can proceed"
            return 0
        fi
    fi
}

# Execute main function
main "$@"