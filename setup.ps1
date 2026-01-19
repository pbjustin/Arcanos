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
        (Get-Content ".env") -replace 'OPENAI_API_KEY=sk-your-api-key-here', "OPENAI_API_KEY=$apiKey" | Set-Content ".env"
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
$dirs = @("logs", "screenshots", "crash_reports", "telemetry", "assets")
foreach ($dir in $dirs) {
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}
Write-Host "   ✅ Directories created" -ForegroundColor Green

# Windows integration
Write-Host ""
$installIntegration = Read-Host "Install Windows Terminal integration? (y/n)"

if ($installIntegration -eq "y") {
    Write-Host "✨ Installing Windows integration..." -ForegroundColor Green
    python -c "from windows_integration import WindowsIntegration; WindowsIntegration().install_all()"
}

# Complete
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "🚀 To start ARCANOS, run:" -ForegroundColor Yellow
Write-Host "   python cli.py" -ForegroundColor Cyan
Write-Host ""
Write-Host "📖 For help, visit:" -ForegroundColor Yellow
Write-Host "   https://github.com/yourusername/arcanos-hybrid" -ForegroundColor Cyan
Write-Host ""

# Ask if user wants to start now
$startNow = Read-Host "Start ARCANOS now? (y/n)"
if ($startNow -eq "y") {
    Write-Host ""
    Write-Host "🚀 Starting ARCANOS..." -ForegroundColor Green
    python cli.py
}
