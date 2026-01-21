#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build ARCANOS executable with PyInstaller

.DESCRIPTION
    This script builds the ARCANOS daemon into a standalone Windows executable.
    Optionally signs the executable if a code signing certificate is provided.

.PARAMETER Sign
    Whether to sign the executable (requires certificate)

.PARAMETER CertPath
    Path to code signing certificate (.pfx)

.PARAMETER CertPassword
    Password for certificate

.EXAMPLE
    .\build.ps1

.EXAMPLE
    .\build.ps1 -Sign -CertPath "cert.pfx" -CertPassword "password"
#>

param(
    [switch]$Sign,
    [string]$CertPath = "",
    [string]$CertPassword = ""
)

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  ARCANOS Build Script" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Change to daemon-python directory
Set-Location daemon-python

# Check if venv exists
if (!(Test-Path "venv")) {
    Write-Host "❌ Virtual environment not found!" -ForegroundColor Red
    Write-Host "   Run: python -m venv venv" -ForegroundColor Yellow
    exit 1
}

# Activate virtual environment
Write-Host "🔧 Activating virtual environment..." -ForegroundColor Green
& .\venv\Scripts\Activate.ps1

# Install/update dependencies
Write-Host "📦 Installing dependencies..." -ForegroundColor Green
python -m pip install -r requirements.txt
python -m pip install pyinstaller

# Clean previous build
if (Test-Path "dist") {
    Write-Host "🗑️  Cleaning previous build..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force dist
}

if (Test-Path "build") {
    Remove-Item -Recurse -Force build
}

# Build executable
Write-Host "🔨 Building executable..." -ForegroundColor Green
pyinstaller arcanos.spec

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Build complete!" -ForegroundColor Green

# Sign executable if requested
if ($Sign) {
    if ($CertPath -eq "" -or !(Test-Path $CertPath)) {
        Write-Host "❌ Certificate not found: $CertPath" -ForegroundColor Red
        exit 1
    }

    Write-Host "🔏 Signing executable..." -ForegroundColor Green
    
    # Find signtool
    $signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"
    
    if (!(Test-Path $signtool)) {
        Write-Host "❌ signtool.exe not found!" -ForegroundColor Red
        Write-Host "   Install Windows SDK: https://developer.microsoft.com/windows/downloads/windows-sdk/" -ForegroundColor Yellow
        exit 1
    }

    & $signtool sign `
        /f $CertPath `
        /p $CertPassword `
        /tr http://timestamp.digicert.com `
        /td sha256 `
        /fd sha256 `
        dist\ARCANOS.exe

    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Executable signed!" -ForegroundColor Green
    } else {
        Write-Host "❌ Signing failed!" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "✨ Build Complete!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "📦 Executable: daemon-python\dist\ARCANOS.exe" -ForegroundColor Yellow
Write-Host ""

# Test executable
$test = Read-Host "Test executable? (y/n)"
if ($test -eq "y") {
    Write-Host "🚀 Running ARCANOS..." -ForegroundColor Green
    & .\dist\ARCANOS.exe
}
