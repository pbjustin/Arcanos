#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Deploy Arcanos backend to Railway.

.DESCRIPTION
  Builds the current repository and runs `railway up` from repo root.
#>

Write-Host "Arcanos backend deployment" -ForegroundColor Cyan

if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
  Write-Host "Railway CLI not found. Install with: npm install -g @railway/cli" -ForegroundColor Red
  exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "Checking Railway auth..." -ForegroundColor Green
railway whoami | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Run 'railway login' first." -ForegroundColor Red
  exit 1
}

Write-Host "Building backend..." -ForegroundColor Green
npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed." -ForegroundColor Red
  exit 1
}

Write-Host "Deploying to Railway..." -ForegroundColor Green
railway up
if ($LASTEXITCODE -ne 0) {
  Write-Host "Deployment failed." -ForegroundColor Red
  exit 1
}

Write-Host "Post-deploy verification: timeout/budget regression check (last 15m)..." -ForegroundColor Green
npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort
if ($LASTEXITCODE -ne 0) {
  Write-Host "Post-deploy regression check failed (timeout/budget signal detected)." -ForegroundColor Red
  exit 1
}

Write-Host "Deployment complete and post-deploy checks passed. Check status with: railway status" -ForegroundColor Green
