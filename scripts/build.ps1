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
    # //audit assumption: venv exists; risk: missing dependencies; invariant: venv present; strategy: exit with message.
    Write-Host "ERROR: Virtual environment not found!" -ForegroundColor Red
    Write-Host "   Run: python -m venv venv" -ForegroundColor Yellow
    exit 1
}

# Activate virtual environment
Write-Host "Activating virtual environment..." -ForegroundColor Green
& .\venv\Scripts\Activate.ps1

# Install/update dependencies
Write-Host "Installing dependencies..." -ForegroundColor Green
python -m pip install -r requirements.txt
python -m pip install pyinstaller

# Clean previous build
if (Test-Path "dist") {
    # //audit assumption: cleaning dist is safe; risk: accidental deletion; invariant: dist directory; strategy: remove only dist.
    Write-Host "Cleaning previous build..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force dist
}

if (Test-Path "build") {
    # //audit assumption: cleaning build is safe; risk: accidental deletion; invariant: build directory; strategy: remove only build.
    Remove-Item -Recurse -Force build
}

# Build executable
Write-Host "Building executable..." -ForegroundColor Green
pyinstaller arcanos.spec

if ($LASTEXITCODE -ne 0) {
    # //audit assumption: build success is required; risk: invalid executable; invariant: exit on failure; strategy: stop build.
    Write-Host "ERROR: Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Build complete!" -ForegroundColor Green

# Sign executable if requested
if ($Sign) {
    # //audit assumption: signing requires cert; risk: missing cert; invariant: cert exists; strategy: validate before signing.
    if ($CertPath -eq "" -or !(Test-Path $CertPath)) {
        Write-Host "ERROR: Certificate not found: $CertPath" -ForegroundColor Red
        exit 1
    }

    Write-Host "Signing executable..." -ForegroundColor Green

    # Find signtool
    $signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"

    if (!(Test-Path $signtool)) {
        # //audit assumption: signtool required; risk: unsigned exe; invariant: tool exists; strategy: exit with guidance.
        Write-Host "ERROR: signtool.exe not found!" -ForegroundColor Red
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
        # //audit assumption: signing succeeded; risk: none; invariant: signed exe; strategy: log success.
        Write-Host "Executable signed!" -ForegroundColor Green
    } else {
        # //audit assumption: signing can fail; risk: unsigned exe; invariant: error surfaced; strategy: exit.
        Write-Host "ERROR: Signing failed!" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "Build complete!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Executable: daemon-python\\dist\\ARCANOS.exe" -ForegroundColor Yellow
Write-Host ""

# Test executable
$test = Read-Host "Test executable? (y/n)"
if ($test -eq "y") {
    # //audit assumption: user requested test run; risk: runtime errors; invariant: run exe; strategy: execute.
    Write-Host "Running ARCANOS..." -ForegroundColor Green
    & .\dist\ARCANOS.exe
}
