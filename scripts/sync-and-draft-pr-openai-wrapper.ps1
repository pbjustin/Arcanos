# Sync local with GitHub and push draft PR for OpenAI wrapper
# Run from repo root: .\scripts\sync-and-draft-pr-openai-wrapper.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "1. Stashing local changes..." -ForegroundColor Cyan
git stash push -m "WIP before sync and draft PR"

Write-Host "2. Updating main from GitHub..." -ForegroundColor Cyan
git fetch origin
git checkout main
git pull origin main

Write-Host "3. Creating branch for OpenAI wrapper (from main)..." -ForegroundColor Cyan
git checkout -b feat/openai-bulletproof-wrapper

Write-Host "4. Adding wrapper and committing..." -ForegroundColor Cyan
git add scripts/arcanos-openai-wrapper.js
git commit -m "Add bulletproof OpenAI call wrapper (runAsk)"

Write-Host "5. Pushing branch..." -ForegroundColor Cyan
git push -u origin feat/openai-bulletproof-wrapper

Write-Host "6. Creating draft PR..." -ForegroundColor Cyan
gh pr create --draft `
  --title "Add bulletproof OpenAI call wrapper" `
  --body "Standalone ESM wrapper: message sanitization (content:null guard), model fallbacks, gpt-5 param handling. Exports runAsk(prompt)."

Write-Host "7. Restoring your previous branch and stash..." -ForegroundColor Cyan
git checkout codex/refactor-cli.py-for-better-modularity
git stash pop

Write-Host "Done. Draft PR is open; main is in sync with origin/main." -ForegroundColor Green
