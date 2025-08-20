#!/bin/bash

# ARCANOS Repository Reset Script - PR #565
# This script resets the repository to the exact state from PR #565
# 
# PR #565: "feat: add storyline reflection to BackstageBooker"
# Merge commit: bc217251f36dbfb03d5e0b5c8590ca5cbed2c95e
# 
# WARNING: This is a destructive operation that will:
# 1. Hard reset your repository to PR #565 state
# 2. Remove all untracked files from later PRs (566-576)
# 3. Force push to remote (overwriting remote history)
# 4. Roll back package.json and lockfiles to PR #565 state
#
# Usage: ./reset-to-pr565.sh [--dry-run] [--force]
#   --dry-run: Show what would be done without actually doing it
#   --force:   Skip confirmation prompts (use with caution)

set -euo pipefail

# Configuration
PR565_MERGE_COMMIT="bc217251f36dbfb03d5e0b5c8590ca5cbed2c95e"
TARGET_BRANCH="main"
REMOTE="origin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse command line arguments
DRY_RUN=false
FORCE=false

for arg in "$@"; do
    case $arg in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--dry-run] [--force]"
            echo "  --dry-run: Show what would be done without executing"
            echo "  --force:   Skip confirmation prompts"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Logging functions
log() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Function to run command with dry-run support
run_cmd() {
    local cmd="$*"
    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY-RUN]${NC} Would run: $cmd"
        return 0
    else
        log "Executing: $cmd"
        eval "$cmd"
    fi
}

# Function to check if we're in a git repository
check_git_repo() {
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        log_error "Not in a git repository. Please run this script from the repository root."
        exit 1
    fi
}

# Function to check if commit exists locally
check_commit_exists() {
    local commit="$1"
    if git cat-file -e "$commit" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Function to fetch commit from remote if needed
fetch_commit_if_needed() {
    local commit="$1"
    
    if check_commit_exists "$commit"; then
        log_success "Commit $commit already exists locally"
        return 0
    fi
    
    log_warning "Commit $commit not found locally. Attempting to fetch from remote..."
    
    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY-RUN]${NC} Would fetch commit from remote"
        return 0
    fi
    
    # Try fetching all refs first
    if git fetch "$REMOTE" 2>/dev/null; then
        if check_commit_exists "$commit"; then
            log_success "Successfully fetched commit $commit"
            return 0
        fi
    fi
    
    # If still not found, try fetching specific commit (GitHub specific)
    if git fetch "$REMOTE" "$commit" 2>/dev/null; then
        log_success "Successfully fetched specific commit $commit"
        return 0
    fi
    
    log_error "Failed to fetch commit $commit from remote"
    log_error "Please ensure you have access to the repository and the commit exists"
    return 1
}

# Function to backup current state
backup_current_state() {
    local backup_branch="backup-before-pr565-reset-$(date +%Y%m%d-%H%M%S)"
    
    log "Creating backup branch: $backup_branch"
    run_cmd "git branch '$backup_branch'"
    
    if [[ "$DRY_RUN" == "false" ]]; then
        log_success "Backup created at branch: $backup_branch"
        log "You can restore with: git checkout $backup_branch"
    fi
}

# Function to clean untracked files
clean_untracked_files() {
    log "Cleaning untracked files and directories..."
    
    # Show what will be removed
    if git clean -n -d -f | grep -q .; then
        log_warning "The following untracked files/directories will be removed:"
        git clean -n -d -f | sed 's/^/  /'
        
        if [[ "$FORCE" == "false" && "$DRY_RUN" == "false" ]]; then
            echo -n "Continue with cleaning? [y/N]: "
            read -r response
            if [[ ! "$response" =~ ^[Yy]$ ]]; then
                log "Skipping cleanup. You can manually clean later with: git clean -f -d"
                return 0
            fi
        fi
        
        run_cmd "git clean -f -d"
        
        if [[ "$DRY_RUN" == "false" ]]; then
            log_success "Untracked files cleaned"
        fi
    else
        log "No untracked files to clean"
    fi
}

# Function to verify package.json and lockfiles state
verify_package_state() {
    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY-RUN]${NC} Would verify package.json and lockfiles state"
        return 0
    fi
    
    log "Verifying package.json and lockfiles are at PR #565 state..."
    
    # Check if package.json exists and show version
    if [[ -f "package.json" ]]; then
        local version=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
        log "Current package.json version: $version"
    fi
    
    # List package-related files
    log "Package-related files present:"
    for file in package.json package-lock.json npm-shrinkwrap.json yarn.lock; do
        if [[ -f "$file" ]]; then
            echo "  ✓ $file"
        fi
    done
}

# Function to show repository status summary
show_status_summary() {
    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY-RUN]${NC} Would show final repository status"
        return 0
    fi
    
    log "Repository status after reset:"
    echo "  Current branch: $(git branch --show-current)"
    echo "  Current commit: $(git rev-parse HEAD)"
    echo "  Current commit message: $(git log -1 --pretty=format:'%s')"
    
    # Show if there are any uncommitted changes
    if git diff --quiet && git diff --cached --quiet; then
        echo "  Working tree: clean"
    else
        echo "  Working tree: has uncommitted changes"
    fi
}

# Main execution function
main() {
    cd "$REPO_ROOT"
    
    log "ARCANOS Repository Reset to PR #565"
    log "=================================="
    log "Target commit: $PR565_MERGE_COMMIT"
    log "Target branch: $TARGET_BRANCH"
    log "Remote: $REMOTE"
    echo
    
    # Safety checks
    check_git_repo
    
    # Show current state
    log "Current repository state:"
    echo "  Branch: $(git branch --show-current)"
    echo "  Commit: $(git rev-parse HEAD)"
    echo "  Remote URL: $(git remote get-url $REMOTE 2>/dev/null || echo 'Not set')"
    echo
    
    # Final confirmation
    if [[ "$FORCE" == "false" && "$DRY_RUN" == "false" ]]; then
        log_warning "This will permanently reset your repository to PR #565 state!"
        log_warning "All commits after PR #565 will be lost from the current branch!"
        echo -n "Are you absolutely sure you want to proceed? [type 'yes' to continue]: "
        read -r response
        if [[ "$response" != "yes" ]]; then
            log "Operation cancelled."
            exit 0
        fi
    fi
    
    # Step 1: Fetch the commit if needed
    log "Step 1: Ensuring commit $PR565_MERGE_COMMIT is available..."
    fetch_commit_if_needed "$PR565_MERGE_COMMIT"
    
    # Step 2: Create backup
    log "Step 2: Creating backup of current state..."
    backup_current_state
    
    # Step 3: Checkout target branch
    log "Step 3: Switching to target branch ($TARGET_BRANCH)..."
    run_cmd "git checkout '$TARGET_BRANCH'"
    
    # Step 4: Hard reset to PR #565 commit
    log "Step 4: Hard resetting to PR #565 commit..."
    run_cmd "git reset --hard '$PR565_MERGE_COMMIT'"
    
    # Step 5: Clean untracked files
    log "Step 5: Cleaning untracked files from later PRs..."
    clean_untracked_files
    
    # Step 6: Verify package state
    log "Step 6: Verifying package.json and lockfiles..."
    verify_package_state
    
    # Step 7: Force push to remote
    if [[ "$DRY_RUN" == "false" ]]; then
        log_warning "Step 7: Force pushing to remote..."
        log_warning "This will overwrite the remote branch history!"
        
        if [[ "$FORCE" == "false" ]]; then
            echo -n "Proceed with force push? [y/N]: "
            read -r response
            if [[ ! "$response" =~ ^[Yy]$ ]]; then
                log "Skipping force push. You can manually push later with:"
                log "  git push --force-with-lease $REMOTE $TARGET_BRANCH"
                show_status_summary
                exit 0
            fi
        fi
        
        # Use --force-with-lease for slightly safer force push
        if git push --force-with-lease "$REMOTE" "$TARGET_BRANCH"; then
            log_success "Successfully force-pushed to remote"
        else
            log_error "Force push failed. You may need to run:"
            log "  git push --force $REMOTE $TARGET_BRANCH"
            log "  (Use with extreme caution!)"
        fi
    else
        echo -e "${YELLOW}[DRY-RUN]${NC} Would force push to remote: git push --force-with-lease $REMOTE $TARGET_BRANCH"
    fi
    
    # Step 8: Show final status
    log "Step 8: Final repository status..."
    show_status_summary
    
    echo
    log_success "Repository reset to PR #565 completed successfully!"
    
    if [[ "$DRY_RUN" == "false" ]]; then
        echo
        log "Summary of changes:"
        echo "  ✓ Repository reset to PR #565 merge commit"
        echo "  ✓ Untracked files from later PRs cleaned"
        echo "  ✓ Package.json and lockfiles rolled back"
        echo "  ✓ Changes force-pushed to remote (if selected)"
        echo
        log "If you need to undo this operation, use the backup branch created."
    else
        echo
        log "This was a dry run. No changes were made."
        log "Run without --dry-run to execute the reset."
    fi
}

# Script entry point
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi