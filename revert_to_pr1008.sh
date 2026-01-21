#!/bin/bash

# ================================================================================
# REVERT REPOSITORY TO PR #1008 STATE
# ================================================================================
# This script reverts the entire Arcanos repository to the exact state it was in
# when Pull Request #1008 was merged.
#
# PR #1008: "Standardize Railway deployment and compatibility documentation"
# Merge Commit: 53b4755a01eb1dca29837481c47221f5f075445b
# Merged On: 2026-01-20 23:18:22 UTC
#
# WARNING: This is a DESTRUCTIVE operation!
# - All commits after PR #1008 will be removed from the main branch
# - This requires a force push to the remote repository
# - All contributors should be notified before executing
# - Any work done after PR #1008 will need to be reapplied manually
# ================================================================================

set -e  # Exit on error

# ANSI color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Target commit for PR #1008
PR_1008_COMMIT="53b4755a01eb1dca29837481c47221f5f075445b"
TARGET_BRANCH="main"
BACKUP_BRANCH=""  # Will be set during backup creation

echo -e "${BLUE}=================================================================================${NC}"
echo -e "${BLUE}ARCANOS Repository Revert Script${NC}"
echo -e "${BLUE}Target: PR #1008 (commit ${PR_1008_COMMIT})${NC}"
echo -e "${BLUE}=================================================================================${NC}"
echo ""

# Function to show current state
show_current_state() {
    echo -e "${YELLOW}Current repository state:${NC}"
    echo -e "${YELLOW}Current branch:${NC} $(git branch --show-current)"
    echo -e "${YELLOW}Current commit:${NC} $(git rev-parse HEAD)"
    echo -e "${YELLOW}Latest commit message:${NC}"
    git log -1 --oneline
    echo ""
}

# Function to verify commit exists
verify_commit_exists() {
    echo -e "${BLUE}Step 1: Verifying target commit exists...${NC}"
    if git cat-file -e ${PR_1008_COMMIT} 2>/dev/null; then
        echo -e "${GREEN}✓ Target commit ${PR_1008_COMMIT} found${NC}"
        echo -e "${YELLOW}Target commit details:${NC}"
        git show ${PR_1008_COMMIT} --stat --oneline | head -20
        echo ""
        return 0
    else
        echo -e "${RED}✗ Target commit ${PR_1008_COMMIT} not found${NC}"
        echo -e "${RED}Attempting to fetch from remote...${NC}"
        git fetch origin
        if git cat-file -e ${PR_1008_COMMIT} 2>/dev/null; then
            echo -e "${GREEN}✓ Successfully fetched target commit${NC}"
            return 0
        else
            echo -e "${RED}✗ Failed to fetch target commit. Aborting.${NC}"
            exit 1
        fi
    fi
}

# Function to show what will be reverted
show_revert_diff() {
    echo -e "${BLUE}Step 2: Analyzing changes to be reverted...${NC}"
    echo -e "${YELLOW}Commits that will be removed:${NC}"
    git log --oneline ${PR_1008_COMMIT}..HEAD | nl
    echo ""
    
    COMMIT_COUNT=$(git rev-list --count ${PR_1008_COMMIT}..HEAD)
    echo -e "${YELLOW}Total commits to remove: ${COMMIT_COUNT}${NC}"
    echo ""
    
    echo -e "${YELLOW}Files that will be modified:${NC}"
    git diff --stat ${PR_1008_COMMIT}..HEAD | head -50
    echo ""
}

# Function to create backup branch
create_backup() {
    echo -e "${BLUE}Step 3: Creating backup branch...${NC}"
    # Set global BACKUP_BRANCH variable
    BACKUP_BRANCH="backup-before-revert-to-pr1008-$(date +%Y%m%d-%H%M%S)"
    git branch ${BACKUP_BRANCH}
    echo -e "${GREEN}✓ Created backup branch: ${BACKUP_BRANCH}${NC}"
    echo -e "${YELLOW}To restore from backup: git reset --hard ${BACKUP_BRANCH}${NC}"
    echo ""
}

# Function to perform the reset
perform_reset() {
    echo -e "${BLUE}Step 4: Resetting ${TARGET_BRANCH} to PR #1008 state...${NC}"
    
    # Ensure we're on main branch
    CURRENT_BRANCH=$(git branch --show-current)
    if [ "${CURRENT_BRANCH}" != "${TARGET_BRANCH}" ]; then
        echo -e "${YELLOW}Switching to ${TARGET_BRANCH} branch...${NC}"
        git checkout ${TARGET_BRANCH}
    fi
    
    # Perform hard reset to target commit
    git reset --hard ${PR_1008_COMMIT}
    
    echo -e "${GREEN}✓ Local ${TARGET_BRANCH} branch reset to ${PR_1008_COMMIT}${NC}"
    echo ""
}

# Function to verify the reset
verify_reset() {
    echo -e "${BLUE}Step 5: Verifying reset...${NC}"
    CURRENT_HEAD=$(git rev-parse HEAD)
    
    if [ "${CURRENT_HEAD}" = "${PR_1008_COMMIT}" ]; then
        echo -e "${GREEN}✓ HEAD is now at correct commit: ${PR_1008_COMMIT}${NC}"
        echo ""
        echo -e "${YELLOW}Current state:${NC}"
        git log -1 --stat
        echo ""
        return 0
    else
        echo -e "${RED}✗ Reset verification failed!${NC}"
        echo -e "${RED}Expected: ${PR_1008_COMMIT}${NC}"
        echo -e "${RED}Got: ${CURRENT_HEAD}${NC}"
        exit 1
    fi
}

# Function to confirm force push
confirm_force_push() {
    echo -e "${RED}=================================================================================${NC}"
    echo -e "${RED}WARNING: FORCE PUSH REQUIRED${NC}"
    echo -e "${RED}=================================================================================${NC}"
    echo -e "${YELLOW}The next step will force push to origin/${TARGET_BRANCH}${NC}"
    echo -e "${YELLOW}This will:${NC}"
    echo -e "${YELLOW}  - Overwrite the remote ${TARGET_BRANCH} branch${NC}"
    echo -e "${YELLOW}  - Remove all commits after PR #1008 from remote history${NC}"
    echo -e "${YELLOW}  - Affect all collaborators who have cloned the repository${NC}"
    echo ""
    echo -e "${YELLOW}Before proceeding, ensure:${NC}"
    echo -e "${YELLOW}  1. All team members have been notified${NC}"
    echo -e "${YELLOW}  2. Important work has been backed up${NC}"
    echo -e "${YELLOW}  3. You have permission to force push to ${TARGET_BRANCH}${NC}"
    echo ""
    
    read -p "Type 'FORCE PUSH' (all caps) to proceed with force push: " CONFIRMATION
    
    if [ "${CONFIRMATION}" = "FORCE PUSH" ]; then
        return 0
    else
        echo -e "${RED}Force push cancelled. Confirmation not provided.${NC}"
        echo -e "${YELLOW}Local repository has been reset but remote remains unchanged.${NC}"
        echo -e "${YELLOW}To push later, run: git push --force origin ${TARGET_BRANCH}${NC}"
        exit 1
    fi
}

# Function to perform force push
perform_force_push() {
    echo -e "${BLUE}Step 6: Force pushing to origin/${TARGET_BRANCH}...${NC}"
    
    # Perform the force push
    git push --force origin ${TARGET_BRANCH}
    
    echo -e "${GREEN}✓ Successfully force pushed to origin/${TARGET_BRANCH}${NC}"
    echo ""
}

# Function to show final verification
final_verification() {
    echo -e "${BLUE}Step 7: Final verification...${NC}"
    
    # Fetch latest from remote
    git fetch origin ${TARGET_BRANCH}
    
    # Compare local and remote
    LOCAL_COMMIT=$(git rev-parse HEAD)
    REMOTE_COMMIT=$(git rev-parse origin/${TARGET_BRANCH})
    
    if [ "${LOCAL_COMMIT}" = "${REMOTE_COMMIT}" ] && [ "${LOCAL_COMMIT}" = "${PR_1008_COMMIT}" ]; then
        echo -e "${GREEN}✓ Verification successful!${NC}"
        echo -e "${GREEN}✓ Local and remote ${TARGET_BRANCH} both at: ${PR_1008_COMMIT}${NC}"
        echo ""
        echo -e "${YELLOW}Files in PR #1008 state:${NC}"
        git show ${PR_1008_COMMIT} --stat | tail -10
        echo ""
        return 0
    else
        echo -e "${RED}✗ Verification failed!${NC}"
        echo -e "${YELLOW}Local HEAD: ${LOCAL_COMMIT}${NC}"
        echo -e "${YELLOW}Remote HEAD: ${REMOTE_COMMIT}${NC}"
        echo -e "${YELLOW}Target: ${PR_1008_COMMIT}${NC}"
        exit 1
    fi
}

# Function to show completion summary
show_summary() {
    echo -e "${GREEN}=================================================================================${NC}"
    echo -e "${GREEN}REVERT COMPLETED SUCCESSFULLY${NC}"
    echo -e "${GREEN}=================================================================================${NC}"
    echo ""
    echo -e "${YELLOW}Repository state:${NC}"
    echo -e "  - Branch: ${TARGET_BRANCH}"
    echo -e "  - Commit: ${PR_1008_COMMIT}"
    echo -e "  - PR #1008: Standardize Railway deployment and compatibility documentation"
    echo ""
    echo -e "${YELLOW}Next steps for team members:${NC}"
    echo -e "  1. Notify all collaborators of the revert"
    echo -e "  2. Team members should run: git fetch origin && git reset --hard origin/${TARGET_BRANCH}"
    echo -e "  3. Review and reapply any needed changes from reverted commits"
    echo ""
    echo -e "${YELLOW}Backup information:${NC}"
    echo -e "  - Backup branch created: ${BACKUP_BRANCH}"
    echo -e "  - To view reverted commits: git log ${PR_1008_COMMIT}..${BACKUP_BRANCH}"
    echo ""
    echo -e "${GREEN}Repository successfully reverted to PR #1008 state!${NC}"
    echo -e "${GREEN}=================================================================================${NC}"
}

# Main execution flow
main() {
    # Show current state
    show_current_state
    
    # Verify target commit exists
    verify_commit_exists
    
    # Show what will be reverted
    show_revert_diff
    
    # Ask for initial confirmation
    echo -e "${RED}=================================================================================${NC}"
    echo -e "${RED}DESTRUCTIVE OPERATION WARNING${NC}"
    echo -e "${RED}=================================================================================${NC}"
    echo -e "${YELLOW}This will revert the repository to PR #1008 state.${NC}"
    echo -e "${YELLOW}All commits shown above will be removed.${NC}"
    echo ""
    read -p "Do you want to continue? (yes/no): " CONTINUE
    
    if [ "${CONTINUE}" != "yes" ]; then
        echo -e "${YELLOW}Operation cancelled by user.${NC}"
        exit 0
    fi
    
    echo ""
    
    # Create backup
    create_backup
    
    # Perform reset
    perform_reset
    
    # Verify reset
    verify_reset
    
    # Confirm and perform force push
    confirm_force_push
    perform_force_push
    
    # Final verification
    final_verification
    
    # Show summary
    show_summary
}

# Run main function
main
