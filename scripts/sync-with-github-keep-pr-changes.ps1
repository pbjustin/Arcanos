# Match local repo to GitHub and keep your PR changes (PR #1068)
# Run from repo root: .\scripts\sync-with-github-keep-pr-changes.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$prBranch = "codex/refactor-cli.py-for-better-modularity"

Write-Host "1. Stashing your PR changes..." -ForegroundColor Cyan
git stash push -u -m "PR #1068 CLI refactor (sync-with-github-keep-pr-changes)"

Write-Host "2. Fetching latest from GitHub..." -ForegroundColor Cyan
git fetch origin

Write-Host "3. Updating local main to match origin/main..." -ForegroundColor Cyan
git checkout main
git pull origin main

Write-Host "4. Switching to PR branch and merging latest main..." -ForegroundColor Cyan
git checkout $prBranch
$mergeResult = git merge origin/main 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "Merge had conflicts. Resolve them, then run: git stash pop" -ForegroundColor Yellow
  exit 1
}

Write-Host "5. Restoring your PR changes..." -ForegroundColor Cyan
git stash pop

Write-Host "Done. Local main and $prBranch are in sync with GitHub; your PR changes are intact." -ForegroundColor Green
Write-Host "Push when ready: git push origin $prBranch" -ForegroundColor Gray
