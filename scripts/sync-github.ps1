# This script runs in the background to keep the local repository in sync with the remote GitHub repository.
# Usage: .\sync-github.ps1 [branch-name]
# If no branch is specified, it will sync the current branch.

param(
    [string]$Branch = ""
)

# Check if git is available
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not installed or not in PATH. Please install Git and try again."
    exit 1
}

# Get current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to determine current branch. Please specify a branch name or ensure you're in a git repository."
        exit 1
    }
}

Write-Output "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) Starting sync for branch: $Branch"

while ($true) {
    try {
        # Fetch the latest changes from the remote repository
        git fetch origin $Branch 2>&1 | Out-Null
        
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) Failed to fetch from origin. Retrying in 60 seconds..."
            Start-Sleep -Seconds 60
            continue
        }

        $local = git rev-parse '@' 2>&1
        $remote = git rev-parse '@{u}' 2>&1
        
        # Check if upstream is set
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) Upstream branch not set. Setting upstream to origin/$Branch..."
            git branch --set-upstream-to=origin/$Branch $Branch 2>&1 | Out-Null
            $remote = git rev-parse '@{u}' 2>&1
        }
        
        $base = git merge-base '@' '@{u}' 2>&1

        if ($local -eq $remote) {
            Write-Output "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) Already up-to-date."
        } elseif ($local -eq $base) {
            Write-Output "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) New changes detected. Pulling from remote..."
            $pullResult = git pull origin $Branch 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Output "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) Sync complete."
            } else {
                Write-Warning "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) Pull failed. Check for conflicts or local changes."
                Write-Warning "Git Output: $pullResult"
            }
        } else {
            Write-Warning "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) Local and remote have diverged. Manual intervention required."
        }
    }
    catch {
        Write-Error "($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) An error occurred during sync: $_"
    }

    # Wait for 60 seconds before the next sync
    Start-Sleep -Seconds 60
}
