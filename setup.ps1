#!/usr/bin/env pwsh
<#
.SYNOPSIS
    ARCANOS Setup Script - Quick installation and configuration

.DESCRIPTION
    This script sets up ARCANOS for first-time use:
    - Creates virtual environment
    - Installs Python dependencies
    - Sets up configuration
    - Optionally installs Windows integration

.EXAMPLE
    .\setup.ps1
#>

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  🌌 ARCANOS Setup Wizard" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check Python version
Write-Host "🐍 Checking Python installation..." -ForegroundColor Green
$pythonVersion = python --version 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Python not found!" -ForegroundColor Red
    Write-Host "   Install Python 3.11+ from: https://www.python.org/downloads/" -ForegroundColor Yellow
    exit 1
}

Write-Host "   ✅ $pythonVersion" -ForegroundColor Green

# Change to daemon-python directory
Set-Location daemon-python

# Create virtual environment
if (!(Test-Path "venv")) {
    Write-Host ""
    Write-Host "📦 Creating virtual environment..." -ForegroundColor Green
    python -m venv venv

    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to create virtual environment!" -ForegroundColor Red
        exit 1
    }
    Write-Host "   ✅ Virtual environment created" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "⏭️  Virtual environment already exists" -ForegroundColor Yellow
}

# Activate virtual environment
Write-Host ""
Write-Host "🔧 Activating virtual environment..." -ForegroundColor Green
& .\venv\Scripts\Activate.ps1

# Upgrade pip
Write-Host ""
Write-Host "📦 Upgrading pip..." -ForegroundColor Green
python -m pip install --upgrade pip --quiet

# Install dependencies
Write-Host ""
Write-Host "📦 Installing dependencies (this may take a few minutes)..." -ForegroundColor Green
python -m pip install -r requirements.txt

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install dependencies!" -ForegroundColor Red
    exit 1
}
Write-Host "   ✅ Dependencies installed" -ForegroundColor Green

# Install ARCANOS package to expose `arcanos` command
Write-Host ""
Write-Host "📦 Installing ARCANOS CLI package..." -ForegroundColor Green
python -m pip install -e .

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install ARCANOS package!" -ForegroundColor Red
    exit 1
}
Write-Host "   ✅ ARCANOS package installed" -ForegroundColor Green

# Create .env file
Write-Host ""
if (!(Test-Path ".env")) {
    Write-Host "⚙️  Creating configuration file..." -ForegroundColor Green
    Copy-Item ".env.example" ".env"
    Write-Host "   ✅ Configuration file created (.env)" -ForegroundColor Green

    Write-Host ""
    Write-Host "🔑 OpenAI API Key Required" -ForegroundColor Yellow
    Write-Host "   Get your API key from: https://platform.openai.com/api-keys" -ForegroundColor Cyan
    Write-Host ""

    $apiKey = Read-Host "Enter your OpenAI API key (or press Enter to skip)"

    if ($apiKey -ne "") {
        # Update .env file
        (Get-Content ".env") -replace '^OPENAI_API_KEY=.*$', "OPENAI_API_KEY=$apiKey" | Set-Content ".env"
        Write-Host "   ✅ API key saved" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️  API key not set. You'll need to add it to .env manually." -ForegroundColor Yellow
    }
} else {
    Write-Host "⏭️  Configuration file already exists (.env)" -ForegroundColor Yellow
}

# Create directories
Write-Host ""
Write-Host "📁 Creating data directories..." -ForegroundColor Green
$dirs = @("logs", "screenshots", "crash_reports", "telemetry")
foreach ($dir in $dirs) {
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}
Write-Host "   ✅ Directories created" -ForegroundColor Green

# Optional: Add venv Scripts to user PATH so `arcanos` works anywhere
Write-Host ""
$pathUpdateRequested = Read-Host "Add ARCANOS to your user PATH so you can run 'arcanos' from any folder? (y/n)"
$pathUpdateApplied = $false
if ($pathUpdateRequested -eq "y") {
    # //audit assumption: user opts in to PATH update; risk: PATH pollution; invariant: user consent; strategy: update user PATH only.
    try {
        $venvScriptsPath = Join-Path (Get-Location) "venv\Scripts"
        $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $pathSeparator = [System.IO.Path]::PathSeparator

        if ([string]::IsNullOrWhiteSpace($currentUserPath)) {
            # //audit assumption: empty PATH is valid; risk: losing existing entries; invariant: new PATH starts with venv; strategy: set new value.
            [Environment]::SetEnvironmentVariable("Path", $venvScriptsPath, "User")
            $pathUpdateApplied = $true
        } elseif ($currentUserPath -notlike "*$venvScriptsPath*") {
            # //audit assumption: venv path not present; risk: duplicates; invariant: path appended once; strategy: append with separator.
            $updatedUserPath = "$currentUserPath$pathSeparator$venvScriptsPath"
            [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
            $pathUpdateApplied = $true
        } else {
            # //audit assumption: path already present; risk: redundant updates; invariant: no change; strategy: mark as applied.
            $pathUpdateApplied = $true
        }
    } catch {
        # //audit assumption: PATH update can fail; risk: arcanos not globally available; invariant: setup continues; strategy: warn user.
        Write-Host "⚠️  Failed to update user PATH. You can run 'arcanos' after activating the venv." -ForegroundColor Yellow
    }
}

# Complete
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "🚀 To start ARCANOS, run:" -ForegroundColor Yellow
Write-Host "   arcanos" -ForegroundColor Cyan
Write-Host ""
Write-Host "   If you're in a new terminal, first activate the venv:" -ForegroundColor Yellow
Write-Host "   .\\venv\\Scripts\\Activate.ps1" -ForegroundColor Cyan
if ($pathUpdateApplied) {
    # //audit assumption: PATH update applied; risk: stale terminal state; invariant: user informed; strategy: prompt to open new terminal.
    Write-Host ""
    Write-Host "✅ PATH updated. Open a new terminal and run 'arcanos' from anywhere." -ForegroundColor Green
}
Write-Host ""
Write-Host "📖 For help, visit:" -ForegroundColor Yellow
Write-Host "   https://github.com/pbjustin/Arcanos" -ForegroundColor Cyan
Write-Host ""

# Ask if user wants to start now
$startNow = Read-Host "Start ARCANOS now? (y/n)"
if ($startNow -eq "y") {
    # //audit assumption: user opts to start immediately; risk: missing config; invariant: start only on consent; strategy: run CLI.
    Write-Host ""
    Write-Host "🚀 Starting ARCANOS..." -ForegroundColor Green
    arcanos
}
