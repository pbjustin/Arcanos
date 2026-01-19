#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deploy ARCANOS backend to Railway

.DESCRIPTION
    This script deploys the TypeScript backend to Railway.app

.EXAMPLE
    .\deploy-backend.ps1
#>

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  ARCANOS Backend Deployment" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check if Railway CLI is installed
if (!(Get-Command railway -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Railway CLI not found!" -ForegroundColor Red
    Write-Host "   Install: npm install -g @railway/cli" -ForegroundColor Yellow
    exit 1
}

# Change to backend directory
Set-Location backend-typescript

# Check if logged in to Railway
Write-Host "🔐 Checking Railway authentication..." -ForegroundColor Green
railway whoami

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Not logged in to Railway!" -ForegroundColor Red
    Write-Host "   Run: railway login" -ForegroundColor Yellow
    exit 1
}

# Build TypeScript
Write-Host "🔨 Building TypeScript..." -ForegroundColor Green
npm run build

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed!" -ForegroundColor Red
    exit 1
}

# Deploy to Railway
Write-Host "🚀 Deploying to Railway..." -ForegroundColor Green
railway up

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host "✅ Deployment Complete!" -ForegroundColor Green
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Get your URL with: railway status" -ForegroundColor Yellow
} else {
    Write-Host "❌ Deployment failed!" -ForegroundColor Red
    exit 1
}
