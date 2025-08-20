# Reset to PR #565 Script Documentation

## Overview

The `reset-to-pr565.sh` script safely resets the ARCANOS repository to the exact state from PR #565 ("feat: add storyline reflection to BackstageBooker"). This script handles the complete workflow requested in the problem statement.

## PR #565 Details

- **Title**: "feat: add storyline reflection to BackstageBooker"
- **Merge Commit**: `bc217251f36dbfb03d5e0b5c8590ca5cbed2c95e`
- **Status**: Merged on 2025-08-19T20:33:58Z
- **Changes**: Added BackstageBooker v2 server with storyline reflection functionality

## What the Script Does

The script performs the following operations in order:

1. **Safety Checks**: Verifies you're in a git repository and shows current state
2. **Commit Fetching**: Ensures the PR #565 merge commit is available locally
3. **Backup Creation**: Creates a backup branch before making changes
4. **Branch Switch**: Checks out the main branch
5. **Hard Reset**: Resets to the PR #565 merge commit (`bc217251f36dbfb03d5e0b5c8590ca5cbed2c95e`)
6. **Cleanup**: Removes all untracked files from later PRs (566-576)
7. **Verification**: Checks that package.json and lockfiles are at PR #565 state
8. **Force Push**: Optionally force-pushes the reset branch to GitHub

## Usage

### Basic Usage
```bash
# Run with dry-run first to see what will happen
./reset-to-pr565.sh --dry-run

# Execute the actual reset
./reset-to-pr565.sh
```

### Command Line Options

- `--dry-run`: Shows what would be done without actually executing any changes
- `--force`: Skips all confirmation prompts (use with extreme caution)
- `--help`: Shows usage information

### Examples

```bash
# Safe way: Test first, then execute
./reset-to-pr565.sh --dry-run
./reset-to-pr565.sh

# Automated way (for scripts)
./reset-to-pr565.sh --force

# Get help
./reset-to-pr565.sh --help
```

## Safety Features

### Automatic Backup
The script automatically creates a backup branch with timestamp:
```
backup-before-pr565-reset-YYYYMMDD-HHMMSS
```

You can restore your previous state with:
```bash
git checkout backup-before-pr565-reset-YYYYMMDD-HHMMSS
```

### Confirmation Prompts
- Confirms before starting the destructive operation
- Confirms before cleaning untracked files
- Confirms before force-pushing to remote

### Force Push Safety
Uses `git push --force-with-lease` which is safer than `--force` as it checks that the remote hasn't changed unexpectedly.

## Prerequisites

1. **Git Repository**: Must be run from within the ARCANOS repository
2. **Git Authentication**: Must have push access to the repository
3. **Network Access**: Needs to fetch from GitHub if commit isn't local
4. **Bash Shell**: Requires Bash 4.0+ (for associative arrays and modern features)

## What Gets Reset

### Repository State
- **HEAD**: Points to PR #565 merge commit
- **Working Tree**: Clean state matching PR #565
- **Untracked Files**: All removed (files added in PRs 566-576)

### Files Specifically Affected
- `package.json`: Rolled back to PR #565 version
- `package-lock.json`: Rolled back to PR #565 state
- `npm-shrinkwrap.json`: Rolled back if it existed in PR #565
- Any other files modified in PRs 566-576

## Recovery Options

### If Something Goes Wrong
1. **Use the Backup Branch**:
   ```bash
   git checkout backup-before-pr565-reset-YYYYMMDD-HHMMSS
   git checkout -b recovery-branch
   ```

2. **Reflog Recovery** (if backup is lost):
   ```bash
   git reflog
   git reset --hard HEAD@{n}  # where n is the desired state
   ```

3. **Force Reset Remote** (last resort):
   ```bash
   git push --force origin main
   ```

## Troubleshooting

### Common Issues

1. **"Commit not found" Error**:
   - Ensure you have network access to fetch from GitHub
   - Verify your GitHub authentication is working
   - Try: `git fetch origin` manually first

2. **"Authentication failed" Error**:
   - Check your GitHub credentials
   - Ensure you have push access to the repository
   - Consider using SSH instead of HTTPS

3. **"Force push failed" Error**:
   - Someone else may have pushed changes
   - Use `git push --force origin main` (more aggressive)
   - Check if you have force-push permissions

### Manual Execution

If the script fails, you can perform the steps manually:

```bash
# 1. Create backup
git branch backup-manual-$(date +%Y%m%d-%H%M%S)

# 2. Fetch the commit
git fetch origin

# 3. Switch to main and reset
git checkout main
git reset --hard bc217251f36dbfb03d5e0b5c8590ca5cbed2c95e

# 4. Clean untracked files
git clean -f -d

# 5. Force push
git push --force-with-lease origin main
```

## Script Output

The script provides colored output:
- **Blue [INFO]**: General information
- **Green [SUCCESS]**: Successful operations
- **Yellow [WARNING]**: Warnings and confirmations
- **Red [ERROR]**: Error conditions

## Security Considerations

- The script never stores or transmits credentials
- All git operations use your existing git configuration
- Backup branches are created locally for safety
- Uses `--force-with-lease` for safer force pushing

## Testing

Always test with `--dry-run` first:
```bash
./reset-to-pr565.sh --dry-run
```

This shows exactly what would happen without making any changes.